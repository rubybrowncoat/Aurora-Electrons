/*
  Checks the missile designer (utilities/missile-designer.js) and its page (pages/missile-designer.vue): the missiles a race has researched, and the missiles it could design from the tech it holds, a hypothetical next level of it or figures typed by hand, set side by side under one scenario.

  node scripts/check-missile-designer.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>] [--no-mutations]

  Groups:
  - units: a size in MSP is shown in MSP, HS (20 MSP) and tons (50 tons to the HS), and an unknown size has no unit;
  - reconcile: every saved design of every fixture, as a column, is judged figure by figure as the independent reconciliation (scripts/lib/missile-reconcile.js) judges it: agreeing, differing, unknown or unsupported, and unknown and unsupported never agree; the full MSP size sum, the fuel cut to a whole litre, the endurance to one decimal and the precision of each figure are exact for an ordinary and a modified design;
  - designed: a design made from the tech the race holds gives the figures of the rules, a field that is not a figure is reported and never replaced by a number, and an obsolete maneuver rating or agility enters nothing;
  - engine: the missile engine is designed at its own thrust, the overboost is the missile rule against the race's greatest thrust modifier, and a ship's thrust limits never stand in for it;
  - planner: the planner figure (warhead × hit chance × (1 − PD / speed)) is named a planner figure and no game statistic in its header, its hint and the copied summary, is the warhead times the hit chance at a PD of 0, is 0 at a PD equal to the speed, and is unavailable with a reason for a PD that is negative, not a number, not finite or above the speed, and never negative;
  - compare: the baseline is pinned and apart from the three alternatives, a fourth is refused with its reason, the columns carry the same rows with their source visible, and an alternative never changes the baseline;
  - sources: a design is researched, hypothetical (carrying the assumption) or manual (typed figures, blank is unknown), and a saved design shows as saved;
  - gating: every column lists every option the designer does not build, with its state, and an option asked for without its tech is blocked with the reason and not applied, and the column shows no figure as that missile's;
  - owned: only the designs the race owns and has researched are imported, read from the modded and the stock save; a check whose save is not there is reported as skipped, never as passed, and a mutant that names only skipped checks is skipped with them;
  - record: a comparison is a typed record of the race on its branch, written only when the tab holds the file, with its saved designs and the tech levels it was made with as links, an older record migrated, and the tech restored on opening;
  - the page: its reads, its state, its copy and its records on a pseudo instance (scripts/lib/page-loader.js).

  Mutants: each deliberate fault in a copy of the utilities (or of the page's script) is run, in a process of its own (--run-mutant, so no fault shares module state with another or with the checks), with the checks it names and must fail them. Prints `N of N checks passed`; exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')
const { jobs, inParallel, runChild } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const libraryDirectory = path.join(__dirname, 'lib')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

let failures = 0
let checks = 0
let skips = 0

const isSkip = (result) => result !== null && typeof result === 'object' && typeof result.skipped === 'string'

const check = (name, result, detail = '') => {
  if (isSkip(result)) {
    skips++
    console.log(`SKIP  ${name}  [${result.skipped}]`)

    return
  }

  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value)

const equal = (actual, expected) => JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const close = (a, b, tolerance = 1e-9) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))

// A check that throws has not held, and says so.
const settle = async (test) => {
  try {
    return await test()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const loadAll = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(['missile-designer', 'design-rules', 'design-data', 'missile-hit', 'provenance', 'scenario-records', 'tech-scenarios'], { stubs: STUBS, directory })
  const { 'missile-reconcile': reconcile } = await loadUtilities(['missile-reconcile'], { directory: libraryDirectory })
  const dr = loaded['design-rules']
  const dd = loaded['design-data']

  return { md: loaded['missile-designer'], dr, dd, hit: loaded['missile-hit'], pv: loaded.provenance, sr: loaded['scenario-records'], ts: loaded['tech-scenarios'], oracle: reconcile.createMissileReconciler({ rules: dr, data: dd }) }
}

// ---------- fixtures ----------

const FIXTURES = require('./lib/missile-fixtures.json').fixtures

const STOCK = { label: 'stock-271-g138', race: 785 }
const MODDED = { label: 'modded-g140', race: 784 }

// The designs of one race of a fixture, as the designer takes them: only its own, with the levels of every race.
const fixtureOf = ({ label, race }) => {
  const fixture = FIXTURES.find((entry) => entry.label === label)

  return { ...fixture, designs: fixture.designs.filter((design) => design.race === race) }
}

// The tech lines as the page resolves them: the held level of the greatest development cost of each line, or none. `overrides` is { typeId: resolved line } for a hypothetical or a missing level.
const resolutionOf = (m, fixture, race, overrides = {}) => {
  const held = m.dd.heldMissileLevels(fixture, race)
  const lines = {}

  for (const type of m.md.DESIGN_LINE_TYPES) {
    const levels = [...(held[type] || [])].sort((a, b) => b.cost - a.cost || b.id - a.id)
    const level = levels[0] ? { id: levels[0].id, name: `level ${levels[0].id}`, info: levels[0].info, cost: levels[0].cost } : null

    lines[type] = { typeId: type, level, kind: level ? 'default' : 'none', hypothetical: false, candidate: null }
  }

  return { ...lines, ...overrides }
}

const hypothetical = (typeId, info) => ({ typeId, level: { id: 9000000 + typeId, name: `Hypothetical level ${info}`, info, cost: 1 }, kind: 'hypothetical', hypothetical: true, candidate: { status: 'available', cost: 5000 }, requested: 9000000 + typeId, nowResearched: false })

const contextOf = (m, { label, race }, overrides = {}, fixture = null) => {
  const fx = fixture || fixtureOf({ label, race })

  return m.md.designerContext({ fixture: fx, resolution: resolutionOf(m, fx, race, overrides), version: null })
}

const STOCK_CONTEXT = (m, overrides) => contextOf(m, STOCK, overrides)
const MODDED_CONTEXT = (m, overrides) => contextOf(m, MODDED, overrides)

const ORDINARY = 154630
const LASER = 500724

const columnOf = (m, context, id, scenario = {}) => m.md.compareDesigns(context, { baselineId: id, alternatives: [], scenario }).columns[0]

const draftOf = (m, context, id, change = {}) => ({ ...m.md.seedAlternative(context, id).draft, ...change })

const compareOf = (m, context, baselineId, alternatives, scenario = {}) => m.md.compareDesigns(context, { baselineId, alternatives, scenario })

const withKeys = (list) => list.map((entry, index) => ({ ...entry, key: entry.key || `alt-${index + 1}` }))

const known = (cell) => cell.value !== null && cell.value !== undefined

const figureOf = (column, id) => column.figures[id]

const valueOf = (column, id) => column.figures[id].value

// The hit chance the shared module gives for a missile of the figures given, as a percent.
const hitOf = (m, { speed, atg = 1, eccm = 0, warheads = 1 }, scenario = {}) => m.hit.hitScenario({ missile: { key: 'x', name: 'x', kind: 'candidate', speed, atg, eccm, warheads, shipDecoy: false, obsolete: false, secondStageId: 0, secondStages: 0 }, targetSpeed: scenario.targetSpeed || '10000', jammer: scenario.jammer || '0', modifier: scenario.modifier || '1', version: null }).capped.value

// ---------- the records ----------

const memory = () => {
  const files = new Map()
  const log = []
  const owner = { value: true }
  const store = (name) => ({
    get store () {
      return copy(files.get(name)) || {}
    },
    set store (value) {
      log.push('write')
      files.set(name, copy(value))
    },
    update (change) {
      for (;;) {
        const base = JSON.stringify(this.store)
        const next = change(JSON.parse(base))

        if (JSON.stringify(this.store) === base) {
          this.store = next

          return next
        }
      }
    },
  })

  return {
    files,
    log,
    owner,
    storage: {
      open: (campaignId) => store(`campaign-${campaignId}`),
      registry: () => ({}),
      writable: async () => {
        log.push('writable')
        await Promise.resolve()

        return owner.value
      },
    },
    writes: () => log.filter((entry) => entry === 'write').length,
  }
}

const repositoryOf = (m, mem) => {
  const adapters = m.sr.createAdapterRegistry()
  let counter = 0
  let clock = 1000

  m.md.registerDesigner(adapters.register)
  m.ts.registerTechScenarios(adapters.register)

  return m.sr.createRepository({ storage: mem.storage, adapters, newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, now: () => ++clock })
}

const scopeIn = ({ campaignId = 'c1', branchId = 'b1', RaceID = STOCK.race, gameTime = 100 } = {}) => ({ campaignId, RaceID, branchId, gameTime })

const fresh = (m) => {
  const mem = memory()

  return { mem, repository: repositoryOf(m, mem) }
}

const designsOf = (_m, target = STOCK) => ({ fixture: fixtureOf(target), obsolete: {}, excluded: 0 })

const payloadOf = (_m, name = 'Anti-ship', extra = {}) => ({ name, baselineId: ORDINARY, alternatives: [], scenario: { targetSpeed: '10000', jammer: '0', modifier: '1', pd: '0', targetSignature: '' }, tech: { choices: {} }, ...extra })

// A small catalogue of techs for the record checks: a hypothetical warhead level, a researched ECCM level and a tech of a line no design reads (`known` as the tech scenarios read it).
const TECH_KNOWN = () => ({ known: { 900001: { id: 900001, typeId: 12, name: 'Hypothetical warhead', info: 7, info2: 0, cost: 15000 }, 900002: { id: 900002, typeId: 275, name: 'ECCM level 2', info: 2, info2: 0, cost: 8000 }, 900003: { id: 900003, typeId: 99999, name: 'A tech no design reads', info: 1, info2: 0, cost: 100 } } })

// ---------- the groups ----------

const unitChecks = (m) => [
  ['units: a size in MSP is also HS (20 MSP to the HS) and tons (50 tons to the HS)', () => {
    const size = m.md.sizeOf(5)

    return size && size.msp === 5 && close(size.hs, 0.25) && close(size.tons, 12.5) && close(m.md.sizeOf(20).hs, 1) && close(m.md.sizeOf(20).tons, 50) ? true : short(size)
  }],
  ['units: an unknown size has no unit and is never 0', () => (m.md.sizeOf(null) === null && m.md.sizeOf(undefined) === null && m.md.sizeOf(NaN) === null ? true : short([m.md.sizeOf(null), m.md.sizeOf(NaN)]))],
  ['units: the figure rows carry a unit, the digits they are shown to and the precision the game gives them', () => {
    const rows = [...m.md.FIGURE_ROWS, ...m.md.INPUT_ROWS]
    const wrong = rows.filter((row) => typeof row.unit !== 'string' || !Number.isInteger(row.digits) || row.digits < 0 || typeof row.hint !== 'string' || !row.hint)
    const figures = m.md.FIGURE_ROWS.filter((row) => typeof row.precision !== 'string' || !row.precision)
    const size = m.md.FIGURE_ROWS.find((row) => row.id === 'size')
    const endurance = m.md.FIGURE_ROWS.find((row) => row.id === 'endurance')
    const fuel = m.md.FIGURE_ROWS.find((row) => row.id === 'fuelRequired')

    return wrong.length === 0 && figures.length === 0 && size.size === true && size.unit === 'MSP' && endurance.digits === 1 && fuel.digits === 0 ? true : short([wrong.map((row) => row.id), figures.map((row) => row.id)])
  }],
]

// The designer's saved column against the independent reconciliation, per design: the verdict of each figure it compares.
const reconcileVerdicts = (m, fixture, design) => {
  const result = m.oracle.reconcileMissile(fixture, design)
  const verdictOf = (field) => {
    const entry = result.comparisons.find((item) => item.field === field)

    return entry ? m.oracle.judge(entry) : null
  }
  const row = design.row

  return { Size: verdictOf('Size'), Speed: verdictOf('Speed'), MaxRange: verdictOf('MaxRange'), Endurance: verdictOf('Endurance'), FuelRequired: verdictOf('FuelRequired'), Damage: verdictOf(row.LaserWarhead > 0 ? 'LaserWarhead' : 'WarheadStrength'), SensorRange: row.MSPActive >= 0.25 ? verdictOf('SensorRange') : 'none', Cost: verdictOf('Cost') }
}

const reconcileChecks = (m) => {
  const mismatches = []
  const tally = { agree: 0, differ: 0, unknown: 0, unsupported: 0 }
  let designs = 0
  let compared = 0

  for (const fixture of FIXTURES) {
    for (const design of fixture.designs.filter((entry) => !entry.stageOnly)) {
      designs++

      const context = m.md.designerContext({ fixture, resolution: {}, version: null })
      const column = columnOf(m, context, design.id)
      const expected = reconcileVerdicts(m, fixture, design)
      const ids = { Size: 'size', Speed: 'speed', MaxRange: 'maxRange', Endurance: 'endurance', FuelRequired: 'fuelRequired', Damage: 'damage', SensorRange: 'sensorRange', Cost: 'cost' }

      for (const [field, id] of Object.entries(ids)) {
        const verdict = column.figures[id].verdict

        compared++
        tally[verdict] = (tally[verdict] || 0) + 1

        if (verdict !== expected[field]) {
          mismatches.push([fixture.label, design.id, field, verdict, expected[field]])
        }
      }
    }
  }

  return [
    ['reconcile: every saved design of every fixture is judged as the independent reconciliation judges it', () => (compared > 1000 && mismatches.length === 0 ? true : short([compared, mismatches.slice(0, 4)])), `${designs} designs, ${compared} figures, ${tally.agree} agree, ${tally.differ} differ, ${tally.unknown} unknown`],
    ['reconcile: a figure that is unknown or unsupported is never judged as agreeing', () => {
      const judge = m.md.judgeFigure
      const verdicts = [judge({ stored: null, computed: 5 }), judge({ stored: 5, computed: null }), judge({ stored: undefined, computed: undefined }), judge({ stored: 5, computed: 5, unsupported: true }), judge({ stored: NaN, computed: NaN })]

      return equal(verdicts, ['unknown', 'unknown', 'unknown', 'unsupported', 'unknown']) && judge({ stored: 5, computed: 5 }) === 'agree' && judge({ stored: 5, computed: 6 }) === 'differ' && judge({ stored: 0, computed: 0 }) === 'agree' ? true : short(verdicts)
    }],
    ['reconcile: a design whose engine the save lacks is unknown in every figure that needs it, never 0', () => {
      const fixture = fixtureOf(STOCK)
      const column = columnOf(m, STOCK_CONTEXT(m), 154110)
      const lacking = ['speed', 'maxRange', 'endurance', 'cost'].map((id) => column.figures[id])

      return fixture.designs.some((design) => design.id === 154110) && lacking.every((cell) => cell.value === null && cell.verdict === 'unknown' && cell.reason && cell.reason.includes('engine')) && column.figures.size.verdict === 'agree' ? true : short(lacking.map((cell) => [cell.id, cell.value, cell.verdict, cell.reason]))
    }],
    ['reconcile: a ground attack pod is unsupported in its warhead and cost, and counts as agreement in neither', () => {
      const fixture = fixtureOf(STOCK)
      const design = copy(fixture.designs.find((entry) => entry.id === ORDINARY))

      design.row.GroundShots = 1
      fixture.designs = fixture.designs.map((entry) => (entry.id === ORDINARY ? design : entry))

      const column = columnOf(m, contextOf(m, STOCK, {}, fixture), ORDINARY)

      return column.figures.damage.verdict === 'unsupported' && column.figures.cost.verdict === 'unsupported' && column.comparison.counts.unsupported >= 2 && column.comparison.counts.agree === column.comparison.fields.filter((id) => column.figures[id].verdict === 'agree').length ? true : short([column.figures.damage.verdict, column.figures.cost.verdict, column.comparison.counts])
    }],
    ['reconcile: an ordinary missile reconciles its full MSP size sum, fuel, one-decimal endurance and speed', () => {
      const design = fixtureOf(STOCK).designs.find((entry) => entry.id === ORDINARY)
      const row = design.row
      const column = columnOf(m, STOCK_CONTEXT(m), ORDINARY)
      const sizeSum = row.MSPEngine + row.MSPFuel + row.MSPWarhead + row.MSPReactor + row.MSPActive + row.MSPThermal + row.MSPEM + row.MSPGeo + row.MSPDecoys + row.MSPMultipleWarheads + (row.ECCM > 0 ? 0.25 : 0) + (row.ATG > 1 ? 0.25 : 0) + (row.Retargeting > 0 ? 0.5 : 0)
      const fuel = Math.floor(2500 * row.MSPFuel)

      return close(valueOf(column, 'sizeSum'), sizeSum, 1e-6) && valueOf(column, 'size') === row.Size && valueOf(column, 'speed') === row.Speed && valueOf(column, 'endurance') === row.Endurance && Math.abs(row.Endurance * 10 - Math.round(row.Endurance * 10)) < 1e-6 && valueOf(column, 'fuelRequired') === fuel && fuel === row.FuelRequired && column.figures.speed.stored === row.Speed ? true : short([valueOf(column, 'sizeSum'), sizeSum, valueOf(column, 'endurance'), row.Endurance, valueOf(column, 'fuelRequired'), fuel])
    }],
    ['reconcile: a modified missile of the modded save reconciles size, speed, range, endurance, fuel and its laser damage', () => {
      const design = fixtureOf(MODDED).designs.find((entry) => entry.id === LASER)
      const row = design.row
      const column = columnOf(m, MODDED_CONTEXT(m), LASER)

      return valueOf(column, 'size') === row.Size && valueOf(column, 'speed') === row.Speed && close(valueOf(column, 'maxRange'), row.MaxRange, 1e-9) && valueOf(column, 'endurance') === row.Endurance && valueOf(column, 'fuelRequired') === row.FuelRequired && close(valueOf(column, 'damage'), row.LaserWarhead, 1e-9) && ['size', 'speed', 'maxRange', 'endurance', 'fuelRequired', 'damage'].every((id) => column.figures[id].verdict === 'agree') ? true : short(['size', 'speed', 'maxRange', 'endurance', 'fuelRequired', 'damage'].map((id) => [id, valueOf(column, id), column.figures[id].stored, column.figures[id].verdict]))
    }],
    ['reconcile: the stored size is shown beside the size the rules rebuild, with the stored column named', () => {
      const column = columnOf(m, STOCK_CONTEXT(m), ORDINARY)
      const rows = m.md.FIGURE_ROWS.filter((row) => row.saved)

      return rows.length === 8 && rows.every((row) => column.figures[row.id].stored !== undefined) && column.figures.size.stored === 10 && column.figures.cost.stored !== null ? true : short(rows.map((row) => [row.id, row.saved]))
    }],
    ['reconcile: a design capped at its size limit is explained, not a difference', () => {
      const fixture = FIXTURES.find((entry) => entry.label === 'v270-kristover-g139')
      const target = fixture.designs.find((design) => design.id === 153793)
      const column = columnOf(m, m.md.designerContext({ fixture, resolution: {}, version: null }), target.id)

      return column.limited === true && column.inputs.sizeLimit.value === target.row.Size && column.figures.size.verdict !== 'agree' ? true : short([column.limited, column.figures.size.verdict])
    }],
  ]
}

const designedChecks = (m) => {
  const stock = () => STOCK_CONTEXT(m)

  return [
    ['designed: a design seeded from a saved one reproduces its size, speed, range, endurance and fuel from the tech the race holds', () => {
      const context = MODDED_CONTEXT(m)
      const saved = columnOf(m, context, LASER)
      const designed = compareOf(m, context, LASER, [draftOf(m, context, LASER)]).columns[1]

      return designed.valid && ['size', 'speed', 'maxRange', 'endurance', 'fuelRequired', 'damage'].every((id) => close(valueOf(designed, id), valueOf(saved, id))) && designed.source === 'researched' ? true : short(['size', 'speed', 'endurance', 'damage'].map((id) => [id, valueOf(designed, id), valueOf(saved, id)]))
    }],
    ['designed: more engines of the same size make the missile faster and the figures follow the rules', () => {
      const context = stock()
      const base = draftOf(m, context, ORDINARY)
      const more = draftOf(m, context, ORDINARY, { engines: '2', engineMsp: base.engineMsp })
      const columns = compareOf(m, context, ORDINARY, [base, more]).columns

      return columns[1].valid && columns[2].valid && valueOf(columns[2], 'speed') > valueOf(columns[1], 'speed') && valueOf(columns[2], 'sizeSum') > valueOf(columns[1], 'sizeSum') ? true : short([valueOf(columns[1], 'speed'), valueOf(columns[2], 'speed')])
    }],
    ['designed: fuel is cut to a whole litre of 2,500 to the MSP', () => {
      const context = stock()
      const column = compareOf(m, context, ORDINARY, [draftOf(m, context, ORDINARY, { fuelMsp: '0.123456' })]).columns[1]

      return column.valid && valueOf(column, 'fuelRequired') === Math.floor(2500 * 0.123456) && valueOf(column, 'fuelRequired') === 308 ? true : short(valueOf(column, 'fuelRequired'))
    }],
    ['designed: the endurance is cut to one decimal and the speed to one decimal', () => {
      const context = stock()
      const column = compareOf(m, context, ORDINARY, [draftOf(m, context, ORDINARY, { fuelMsp: '0.0371' })]).columns[1]
      const endurance = valueOf(column, 'endurance')
      const speed = valueOf(column, 'speed')

      return column.valid && Math.abs(endurance * 10 - Math.round(endurance * 10)) < 1e-6 && Math.abs(speed * 10 - Math.round(speed * 10)) < 1e-6 && endurance > 0 ? true : short([endurance, speed])
    }],
    ['designed: the full MSP size sum is the parts added up, and the size is the sum raised to the floor of 1 MSP', () => {
      const context = stock()
      const column = compareOf(m, context, ORDINARY, [draftOf(m, context, ORDINARY, { fuelMsp: '0.55', warheadMsp: '0.1', activeMsp: '0', thermalMsp: '0', emMsp: '0', geoMsp: '0', engineMsp: '0.2', engines: '1', decoys: '0', warheads: '1', options: { eccm: false, terminal: false, retarget: false, laser: false } })]).columns[1]
      const sum = valueOf(column, 'sizeSum')

      return column.valid && close(sum, 0.85) && valueOf(column, 'size') === 1 ? true : short([sum, valueOf(column, 'size')])
    }],
    ['designed: text that is not a figure is reported against its field and no number replaces it', () => {
      const context = stock()
      const bad = compareOf(m, context, ORDINARY, [draftOf(m, context, ORDINARY, { warheadMsp: 'many', fuelMsp: '-1', engines: '1.5' })]).columns[1]
      const blank = compareOf(m, context, ORDINARY, [draftOf(m, context, ORDINARY, { engineMsp: '', thrust: '' })]).columns[1]

      return !bad.valid && Object.keys(bad.errors).sort().join() === 'engines,fuelMsp,warheadMsp' && m.md.FIGURE_ROWS.every((row) => bad.figures[row.id].value === null && bad.figures[row.id].reason) && !blank.valid && 'engineMsp' in blank.errors && 'thrust' in blank.errors && valueOf(blank, 'speed') === null ? true : short([bad.errors, blank.errors])
    }],
    ['designed: an obsolete maneuver rating or agility on a saved row enters no figure', () => {
      const plain = fixtureOf(STOCK)
      const marked = fixtureOf(STOCK)
      const row = marked.designs.find((entry) => entry.id === ORDINARY).row

      row.MR = 99
      row.Agility = 99
      row.ManeuverRating = 99

      const a = columnOf(m, contextOf(m, STOCK, {}, plain), ORDINARY)
      const b = columnOf(m, contextOf(m, STOCK, {}, marked), ORDINARY)
      const figures = (column) => Object.fromEntries(Object.entries(column.figures).map(([id, cell]) => [id, cell.value]))

      return equal(figures(a), figures(b)) && !Object.keys(a.inputs).some((id) => /maneuver|agility|^mr$/i.test(id)) && !m.md.INPUT_ROWS.concat(m.md.FIGURE_ROWS).some((entry) => /maneuver|agility/i.test(`${entry.id} ${entry.label}`)) ? true : short([figures(a), figures(b)])
    }],
    ['designed: a size is shown in MSP, HS and tons on every size row, and tons are 2.5 to the MSP', () => {
      const column = columnOf(m, stock(), ORDINARY)
      const rows = [...m.md.INPUT_ROWS, ...m.md.FIGURE_ROWS].filter((row) => row.size)
      const cells = [column.figures.size, column.figures.sizeSum, column.inputs.fuelMsp, column.inputs.warheadMsp]

      return rows.length >= 8 && cells.every((cell) => cell.size && close(cell.size.hs, cell.size.msp / 20) && close(cell.size.tons, cell.size.msp * 2.5)) ? true : short(cells.map((cell) => cell.size))
    }],
  ]
}

const engineChecks = (m) => [
  ['engine: a missile engine above the race\'s greatest thrust modifier is overboosted by the missile rule: 4 times the excess, as a share of the maximum', () => {
    const column = columnOf(m, STOCK_CONTEXT(m), ORDINARY)
    const row = fixtureOf(STOCK).designs.find((entry) => entry.id === ORDINARY).row
    const thrust = 5
    const max = 2.5
    const expected = (thrust - max) / max * 4 + 1

    return row.PowerMod === thrust && column.inputs.maxThrust.value === max && column.inputs.thrust.value === thrust && close(column.inputs.overboost.value, expected) && column.inputs.overboost.over === true && close(column.inputs.overboost.excess, 2.5) ? true : short([column.inputs.thrust.value, column.inputs.maxThrust.value, column.inputs.overboost.value, expected])
  }],
  ['engine: a thrust within the greatest thrust modifier has no overboost', () => {
    const column = columnOf(m, STOCK_CONTEXT(m), 154602)

    return column.inputs.overboost.value === 1 && column.inputs.overboost.over === false && column.inputs.overboost.excess === 0 ? true : short([column.inputs.overboost.value, column.inputs.thrust.value])
  }],
  ['engine: a designed engine takes its greatest thrust modifier from the race\'s tech and the overboost follows it', () => {
    const context = STOCK_CONTEXT(m)
    const base = draftOf(m, context, ORDINARY)
    const raised = STOCK_CONTEXT(m, { 130: hypothetical(130, 6) })
    const columns = [compareOf(m, context, ORDINARY, [base]).columns[1], compareOf(m, raised, ORDINARY, [base]).columns[1]]

    const held = context.levels[130].info

    return columns[0].inputs.maxThrust.value === held && close(columns[0].inputs.overboost.value, (5 - held) / held * 4 + 1) && columns[1].inputs.maxThrust.value === 6 && columns[1].inputs.overboost.value === 1 && valueOf(columns[1], 'endurance') > valueOf(columns[0], 'endurance') && columns[1].source === 'hypothetical' ? true : short(columns.map((column) => [column.inputs.maxThrust.value, column.inputs.overboost.value, column.source]))
  }],
  ['engine: the fuel use of the overboost is the missile rule, so the endurance with no overboost is the overboosted one times the factor', () => {
    const context = STOCK_CONTEXT(m)
    const base = draftOf(m, context, ORDINARY)
    const limited = compareOf(m, context, ORDINARY, [base]).columns[1]
    const free = compareOf(m, STOCK_CONTEXT(m, { 130: hypothetical(130, 50) }), ORDINARY, [base]).columns[1]

    return close(valueOf(free, 'endurance') / valueOf(limited, 'endurance'), limited.inputs.overboost.value, 1e-2) && valueOf(free, 'speed') === valueOf(limited, 'speed') ? true : short([valueOf(free, 'endurance'), valueOf(limited, 'endurance'), limited.inputs.overboost.value])
  }],
  ['engine: a ship\'s thrust limits (least thrust modifier, largest engine) never stand in for the missile overboost', () => {
    const context = STOCK_CONTEXT(m)
    const ship = STOCK_CONTEXT(m, { 198: hypothetical(198, 0.1), 214: hypothetical(214, 1) })
    const base = draftOf(m, context, ORDINARY)
    const a = compareOf(m, context, ORDINARY, [base]).columns
    const b = compareOf(m, ship, ORDINARY, [base]).columns
    const figures = (column) => Object.entries(column.figures).map(([id, cell]) => [id, cell.value])

    return equal(figures(a[0]), figures(b[0])) && equal(figures(a[1]), figures(b[1])) && a[1].inputs.maxThrust.value === b[1].inputs.maxThrust.value && b[1].source === 'researched' ? true : short([a[1].inputs.maxThrust.value, b[1].inputs.maxThrust.value, b[1].source])
  }],
  ['engine: a saved design\'s greatest thrust modifier is the held level that reproduces its stored fuel use, and none that does leaves it unknown', () => {
    const fixture = fixtureOf(STOCK)
    const design = fixture.designs.find((entry) => entry.id === ORDINARY)
    const component = fixture.components[design.row.EngineID]

    fixture.races[STOCK.race].held[130] = []

    const column = columnOf(m, contextOf(m, STOCK, {}, fixture), ORDINARY)

    return component && column.inputs.maxThrust.value === null && column.inputs.overboost.value === null && column.inputs.overboost.note && /greatest thrust|held level/i.test(column.inputs.overboost.note) ? true : short([column.inputs.maxThrust.value, column.inputs.overboost.value, column.inputs.overboost.note])
  }],
  ['engine: an overboost with a tech level that is not known is unknown, never 1', () => {
    const context = m.md.designerContext({ fixture: fixtureOf(STOCK), resolution: resolutionOf(m, fixtureOf(STOCK), STOCK.race, { 130: { typeId: 130, level: null, kind: 'none', hypothetical: false, candidate: null } }), version: null })
    const draft = draftOf(m, context, ORDINARY)
    const column = compareOf(m, context, ORDINARY, [draft]).columns[1]

    return column.inputs.maxThrust.value === null && column.inputs.overboost.value === null && valueOf(column, 'endurance') === null && figureOf(column, 'endurance').reason ? true : short([column.inputs.overboost.value, valueOf(column, 'endurance')])
  }],
]

const plannerChecks = (m) => {
  const row = () => fixtureOf(STOCK).designs.find((entry) => entry.id === ORDINARY).row
  const missileOf = () => ({ speed: row().Speed, atg: row().ATG, eccm: row().ECCM, warheads: row().MultipleWarheads })
  const planned = (pd, scenario = {}) => columnOf(m, STOCK_CONTEXT(m), ORDINARY, { ...scenario, pd })

  return [
    ['planner: the figure is named a planner figure and no game statistic in its header, its hint and the copied summary', () => {
      const definition = m.md.FIGURE_ROWS.find((entry) => entry.id === 'planner')
      const context = STOCK_CONTEXT(m)
      const text = m.md.summaryText(compareOf(m, context, ORDINARY, [], { pd: '100' }), { pd: '100' })

      return /planner figure/i.test(definition.label) && /planner figure/i.test(definition.hint) && /not a game statistic/i.test(definition.hint) && /planner figure/i.test(text) && /not a game statistic/i.test(text) && text.includes('warhead × hit chance × (1 − PD / speed)') && m.md.PLANNER_FIGURE === 'Planner figure' ? true : short([definition.label, text.slice(0, 200)])
    }],
    ['planner: a PD of 0 gives the warhead times the hit chance', () => {
      const column = planned('0')
      const hit = hitOf(m, missileOf(0))
      const expected = row().WarheadStrength * (hit / 100)

      return column.pdError === '' && column.rowErrors.length === 0 && close(valueOf(column, 'planner'), expected) && close(valueOf(column, 'hitChance'), hit) && close(valueOf(column, 'damage'), row().WarheadStrength) ? true : short([valueOf(column, 'planner'), expected, hit])
    }],
    ['planner: the default PD is 0', () => {
      const withoutPd = m.md.compareDesigns(STOCK_CONTEXT(m), { baselineId: ORDINARY, alternatives: [], scenario: {} })

      return equal(m.md.scenarioOf({}).pd, '0') && close(valueOf(withoutPd.columns[0], 'planner'), valueOf(planned('0'), 'planner')) && withoutPd.pdError === '' ? true : short([m.md.scenarioOf({}).pd, withoutPd.pdError])
    }],
    ['planner: a PD equal to the speed gives 0, and half the speed gives half', () => {
      const speed = row().Speed
      const full = planned(String(speed))
      const half = planned(String(speed / 2))
      const zero = valueOf(planned('0'), 'planner')

      return valueOf(full, 'planner') === 0 && isAvailableOf(m, full) && close(valueOf(half, 'planner'), zero / 2) && full.rowErrors.length === 0 ? true : short([valueOf(full, 'planner'), valueOf(half, 'planner'), zero])
    }],
    ['planner: a PD below 0 is unavailable with a field error, never negative or clamped to 0', () => {
      const column = planned('-5')

      return valueOf(column, 'planner') === null && column.pdError && /0 or more/.test(column.pdError) && figureOf(column, 'planner').reason && /0 or more/.test(figureOf(column, 'planner').reason) && column.figures.planner.result.status === 'unavailable' ? true : short([valueOf(column, 'planner'), column.pdError])
    }],
    ['planner: a PD that is not a number or not finite is unavailable with its own reason', () => {
      const cases = ['abc', 'NaN', 'Infinity', '-Infinity', '', '  ', '1e999']
      const columns = cases.map((text) => planned(text))
      const direct = [NaN, Infinity, -Infinity, null, undefined].map((value) => m.md.pdProblem(value))

      return columns.every((column) => valueOf(column, 'planner') === null && column.pdError && figureOf(column, 'planner').reason) && direct.every((reason) => reason) && new Set([m.md.pdProblem('abc'), m.md.pdProblem(''), m.md.pdProblem('-1'), m.md.pdProblem(Infinity)]).size === 4 && m.md.pdProblem('0') === '' && m.md.pdProblem('12.5') === '' ? true : short([columns.map((column) => [valueOf(column, 'planner'), column.pdError]), direct])
    }],
    ['planner: a PD above the speed is unavailable with the row named, never negative', () => {
      const speed = row().Speed
      const column = planned(String(speed + 1))

      return valueOf(column, 'planner') === null && column.pdError === '' && column.rowErrors.length === 1 && /above the missile speed/.test(column.rowErrors[0]) && figureOf(column, 'planner').reason.includes(String(speed)) ? true : short([valueOf(column, 'planner'), column.rowErrors])
    }],
    ['planner: the figure is never negative whatever the PD', () => {
      const values = ['0', '1', '100', '24499', '24500', '24501', '30000', '-1', '-1e9', 'x', '1e308']

      return values.every((pd) => {
        const value = valueOf(planned(pd), 'planner')

        return value === null || value >= 0
      }) ? true : 'a negative figure'
    }],
    ['planner: a missile with no speed has no figure, with the reason, and a speed of 0 is a row error', () => {
      const lacking = columnOf(m, STOCK_CONTEXT(m), 154110, { pd: '0' })
      const buoy = columnOf(m, STOCK_CONTEXT(m), 154192, { pd: '0' })

      return valueOf(lacking, 'planner') === null && figureOf(lacking, 'planner').reason && lacking.rowErrors.length === 0 && valueOf(buoy, 'planner') === null && buoy.rowErrors.length === 1 && /not above 0/.test(buoy.rowErrors[0]) ? true : short([figureOf(lacking, 'planner').reason, buoy.rowErrors])
    }],
    ['planner: the hit chance comes from the shared hit module and follows the target speed, jammer and modifier', () => {
      const scenario = { targetSpeed: '3000', jammer: '2', modifier: '0.5' }
      const column = planned('0', scenario)
      const expected = hitOf(m, missileOf(0), scenario)

      return close(valueOf(column, 'hitChance'), expected) && close(valueOf(column, 'planner'), valueOf(column, 'damage') * expected / 100) && valueOf(column, 'hitChance') !== valueOf(planned('0'), 'hitChance') ? true : short([valueOf(column, 'hitChance'), expected])
    }],
    ['planner: a PD error on one missile does not remove the figure of another, and the comparison lists the rows in error', () => {
      const context = STOCK_CONTEXT(m)
      const slow = draftOf(m, context, ORDINARY, { engines: '1' })
      const result = compareOf(m, context, ORDINARY, [slow], { pd: '24500' })
      const copyText = m.md.summaryText(result, { pd: '24500' })

      return valueOf(result.columns[0], 'planner') === 0 && result.rowErrors.every((entry) => entry.key && entry.message) && /planner figure/i.test(copyText) ? true : short(result.rowErrors)
    }],
  ]
}

const isAvailableOf = (m, column) => m.pv.isAvailable(column.figures.planner.result)

const compareChecks = (m) => {
  const context = () => STOCK_CONTEXT(m)
  const three = (ctx) => [m.md.savedAlternative(154602, 'Buoy B'), draftOf(m, ctx, ORDINARY, { name: 'Faster' }), draftOf(m, ctx, ORDINARY, { name: 'Heavier', warheadMsp: '3' })]

  return [
    ['compare: a baseline and three alternatives (saved, designed, designed) are side by side, the baseline first', () => {
      const ctx = context()
      const result = compareOf(m, ctx, ORDINARY, withKeys(three(ctx)))

      return result.columns.length === 4 && result.columns[0].role === 'baseline' && result.columns.slice(1).every((column) => column.role === 'alternative') && result.refused.length === 0 && result.columns[0].savedId === ORDINARY && result.columns[1].savedId === 154602 && result.columns.slice(2).every((column) => column.kind === 'designed') ? true : short(result.columns.map((column) => [column.role, column.kind, column.name]))
    }],
    ['compare: a fourth alternative is refused with its reason and shown as not compared, never dropped quietly', () => {
      const ctx = context()
      const list = withKeys([...three(ctx), draftOf(m, ctx, ORDINARY, { name: 'Fourth' })])
      const result = compareOf(m, ctx, ORDINARY, list)
      const text = m.md.summaryText(result, {})
      const added = m.md.addAlternative(withKeys(three(ctx)), draftOf(m, ctx, ORDINARY))

      return result.columns.length === 4 && result.refused.length === 1 && result.refused[0].name === 'Fourth' && /at most 3/i.test(result.refused[0].reason) && text.includes('Not compared: Fourth') && added.ok === false && /at most 3/i.test(added.reason) && m.md.MAX_ALTERNATIVES === 3 ? true : short([result.columns.length, result.refused, added])
    }],
    ['compare: an alternative is added under a key not in use and removed by its key', () => {
      const ctx = context()
      const first = m.md.addAlternative([], draftOf(m, ctx, ORDINARY))
      const second = m.md.addAlternative(first.list, draftOf(m, ctx, ORDINARY))
      const removed = m.md.removeAlternative(second.list, 'alt-1')
      const third = m.md.addAlternative(removed, draftOf(m, ctx, ORDINARY))

      return first.ok && second.ok && first.list[0].key === 'alt-1' && second.list.map((entry) => entry.key).join() === 'alt-1,alt-2' && removed.map((entry) => entry.key).join() === 'alt-2' && third.list.map((entry) => entry.key).join() === 'alt-2,alt-1' ? true : short([second.list.map((entry) => entry.key), removed.map((entry) => entry.key), third.list.map((entry) => entry.key)])
    }],
    ['compare: every column carries the same rows, the same inputs and the same provenance fields, with its source visible', () => {
      const ctx = context()
      const result = compareOf(m, ctx, ORDINARY, withKeys(three(ctx)))
      const figureIds = (column) => Object.keys(column.figures).join()
      const inputIds = (column) => Object.keys(column.inputs).join()
      const provenance = (column) => Object.values(column.figures).map((cell) => `${Object.keys(cell).join()}|${cell.result && ['rule', 'status', 'units', 'inputs', 'assumptions'].every((key) => key in cell.result)}`).join()
      const gated = (column) => column.gated.map((entry) => entry.id).join()

      return new Set(result.columns.map(figureIds)).size === 1 && new Set(result.columns.map(inputIds)).size === 1 && new Set(result.columns.map(gated)).size === 1 && new Set(result.columns.map(provenance)).size === 1 && result.columns.every((column) => m.md.SOURCE_LABELS[column.source]) && result.columns.map((column) => column.source).join() === 'saved,saved,researched,researched' && figureIds(result.columns[0]) === m.md.FIGURE_ROWS.map((entry) => entry.id).join() && inputIds(result.columns[0]) === m.md.INPUT_ROWS.map((entry) => entry.id).join() ? true : short(result.columns.map((column) => [figureIds(column).length, inputIds(column).length]))
    }],
    ['compare: the baseline is pinned: alternatives added, edited and removed leave its figures and inputs exactly as they were', () => {
      const ctx = context()
      const alone = compareOf(m, ctx, ORDINARY, []).columns[0]
      const withThree = compareOf(m, ctx, ORDINARY, withKeys(three(ctx))).columns[0]
      const edited = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { warheadMsp: '9', fuelMsp: '2', engines: '3' })])).columns[0]
      const snapshot = (column) => JSON.stringify([Object.entries(column.figures).map(([id, cell]) => [id, cell.value, cell.stored, cell.verdict]), Object.entries(column.inputs).map(([id, cell]) => [id, cell.value]), column.name, column.source, column.savedId])

      return snapshot(alone) === snapshot(withThree) && snapshot(alone) === snapshot(edited) && alone.role === 'baseline' ? true : short([snapshot(alone).slice(0, 120), snapshot(edited).slice(0, 120)])
    }],
    ['compare: seeding an alternative from the baseline copies its inputs and keeps the baseline\'s own stored figures', () => {
      const ctx = context()
      const seeded = m.md.seedAlternative(ctx, ORDINARY)
      const row = fixtureOf(STOCK).designs.find((entry) => entry.id === ORDINARY).row
      const result = compareOf(m, ctx, ORDINARY, withKeys([{ ...seeded.draft, warheadMsp: '5' }]))

      return seeded.ok && seeded.baselineId === ORDINARY && seeded.draft.seededFrom === ORDINARY && seeded.draft.fuelMsp === String(row.MSPFuel) && seeded.draft.warheadMsp === String(row.MSPWarhead) && result.columns[0].figures.damage.stored === row.WarheadStrength && result.columns[0].inputs.warheadMsp.value === row.MSPWarhead && result.columns[1].inputs.warheadMsp.value === 5 && valueOf(result.columns[1], 'damage') > valueOf(result.columns[0], 'damage') ? true : short([seeded.draft.warheadMsp, result.columns[0].inputs.warheadMsp.value])
    }],
    ['compare: a baseline that is not a researched and owned design is a column with the reason, and nothing else is substituted', () => {
      const ctx = context()
      const result = compareOf(m, ctx, 999999999, [])

      return result.columns.length === 1 && result.columns[0].valid === false && /not one the race has researched and owns/.test(result.columns[0].errors.savedId) && m.md.FIGURE_ROWS.every((entry) => result.columns[0].figures[entry.id].value === null) && m.md.seedAlternative(ctx, 999999999).ok === false ? true : short(result.columns[0].errors)
    }],
    ['compare: the saved designs are offered by name with their id, size and speed, a second stage alone not offered', () => {
      const choices = m.md.savedChoices({ fixture: fixtureOf(STOCK), obsolete: { 154602: true }, excluded: 0 })

      return choices.length > 3 && choices.every((choice) => choice.id > 0 && choice.name && typeof choice.size === 'number') && choices.find((choice) => choice.id === 154602).obsolete === true && choices.find((choice) => choice.id === ORDINARY).obsolete === false && m.md.savedChoices(m.md.NO_DESIGNS).length === 0 ? true : short(choices.slice(0, 2))
    }],
  ]
}

const sourceChecks = (m) => [
  ['sources: a design made from levels the race holds is researched, and a saved design is saved', () => {
    const ctx = STOCK_CONTEXT(m)
    const result = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY), m.md.savedAlternative(154602)]))

    return result.columns.map((column) => column.source).join() === 'saved,researched,saved' && result.columns[1].hypothetical.length === 0 && result.columns[1].assumptions.length === 0 ? true : short(result.columns.map((column) => column.source))
  }],
  ['sources: a design that uses a next level the race has not researched is hypothetical, carries the assumption and is no more than assumed', () => {
    const ctx = STOCK_CONTEXT(m, { 12: hypothetical(12, 40) })
    const base = STOCK_CONTEXT(m)
    const result = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY)]))
    const researched = compareOf(m, base, ORDINARY, withKeys([draftOf(m, base, ORDINARY)]))
    const damage = figureOf(result.columns[1], 'damage')

    return result.columns[1].source === 'hypothetical' && result.columns[0].source === 'saved' && valueOf(result.columns[1], 'damage') > valueOf(researched.columns[1], 'damage') && damage.result.assumptions.some((text) => text.startsWith('Hypothetical tech: ')) && damage.result.status !== 'confirmed' && result.columns[1].hypothetical.length === 1 && valueOf(result.columns[0], 'damage') === valueOf(researched.columns[0], 'damage') ? true : short([result.columns[1].source, damage.result.status, damage.result.assumptions])
  }],
  ['sources: a hypothetical level of a line the design does not use does not make it hypothetical', () => {
    const ctx = STOCK_CONTEXT(m, { 275: hypothetical(275, 9) })
    const result = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { options: { eccm: false, terminal: false, retarget: false, laser: false } })]))

    return result.columns[1].source === 'researched' ? true : short(result.columns[1].source)
  }],
  ['sources: typed tech figures make a manual design, blank is unknown and never 0, and the race\'s levels are not read', () => {
    const ctx = STOCK_CONTEXT(m)
    const manual = { ...emptyManualOf(m), engine: '20', fuel: '0.5', maxThrust: '3', warhead: '10' }
    const none = { eccm: false, terminal: false, retarget: false, laser: false }
    const typed = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { techMode: 'manual', manual, options: none })])).columns[1]
    const partial = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { techMode: 'manual', manual: { ...manual, engine: '' }, options: none })])).columns[1]

    return typed.source === 'manual' && typed.valid && known(figureOf(typed, 'speed')) && typed.assumptions.some((text) => /typed here/.test(text)) && figureOf(typed, 'speed').result.assumptions.some((text) => /typed here/.test(text)) && typed.inputs.maxThrust.value === 3 && partial.source === 'manual' && valueOf(partial, 'speed') === null && figureOf(partial, 'speed').reason && valueOf(partial, 'speed') !== 0 ? true : short([typed.source, valueOf(typed, 'speed'), valueOf(partial, 'speed')])
  }],
  ['sources: a manual figure that is not a number is a field error on the manual field', () => {
    const ctx = STOCK_CONTEXT(m)
    const column = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { techMode: 'manual', manual: { ...emptyManualOf(m), engine: 'fast', fuel: '-1' } })])).columns[1]

    return !column.valid && 'manual.engine' in column.errors && 'manual.fuel' in column.errors && valueOf(column, 'speed') === null ? true : short(column.errors)
  }],
  ['sources: the source labels name all four sources', () => (Object.keys(m.md.SOURCE_LABELS).sort().join() === 'hypothetical,manual,researched,saved' && Object.values(m.md.SOURCE_LABELS).every((label) => label.length > 3) ? true : short(m.md.SOURCE_LABELS))],
]

const emptyManualOf = (m) => m.md.emptyManual()

const gatingChecks = (m) => [
  ['gating: every column lists every option the designer does not build, with its state and reason', () => {
    const ctx = STOCK_CONTEXT(m)
    const result = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY), m.md.savedAlternative(154678)]))
    const ids = m.md.GATED_OPTIONS.map((option) => option.id)

    return ids.length === 7 && result.columns.every((column) => equal(column.gated.map((entry) => entry.id), ids) && column.gated.every((entry) => entry.state && entry.reason && entry.label)) && ['secondStage', 'shipDecoy', 'groundPod', 'enhancedRadiation', 'retargetHigh', 'missileEcm', 'laserFocus'].every((id) => ids.includes(id)) ? true : short(result.columns.map((column) => column.gated.map((entry) => entry.id)))
  }],
  ['gating: a saved design with a second stage shows it recorded and a seeded copy carries it, neither dropped nor built', () => {
    const ctx = STOCK_CONTEXT(m)
    const staged = fixtureOf(STOCK).designs.find((design) => design.row.SecondStageID > 0)
    const seeded = draftOf(m, ctx, staged.id)
    const result = compareOf(m, ctx, staged.id, withKeys([seeded]))
    const stateOf = (column, id) => column.gated.find((entry) => entry.id === id).state

    return staged && stateOf(result.columns[0], 'secondStage') === 'recorded' && stateOf(result.columns[1], 'secondStage') === 'carried' && seeded.carried.stageId === staged.row.SecondStageID && stateOf(compareOf(m, ctx, ORDINARY, []).columns[0], 'secondStage') === 'not-offered' ? true : short([staged && staged.id, result.columns.map((column) => stateOf(column, 'secondStage'))])
  }],
  ['gating: an option asked for whose tech line has no level is blocked with the reason and not applied', () => {
    const ctx = STOCK_CONTEXT(m, { 83: { typeId: 83, level: null, kind: 'none', hypothetical: false, candidate: null } })
    const options = { eccm: true, terminal: false, retarget: false, laser: false }
    const column = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { options })])).columns[1]
    const free = compareOf(m, STOCK_CONTEXT(m), ORDINARY, withKeys([draftOf(m, STOCK_CONTEXT(m), ORDINARY, { options })])).columns[1]

    return column.blocked.length === 1 && column.blocked[0].id === 'eccm' && /no level/.test(column.blocked[0].reason) && column.inputs.eccm.value === 0 && free.inputs.eccm.value > 0 ? true : short([column.blocked, column.inputs.eccm.value, free.inputs.eccm.value])
  }],
  ['gating: a column with an option not applied shows no figure as the missile\'s and says why, and the same design without the option has figures', () => {
    const ctx = STOCK_CONTEXT(m, { 83: { typeId: 83, level: null, kind: 'none', hypothetical: false, candidate: null } })
    const off = { eccm: false, terminal: false, retarget: false, laser: false }
    const asked = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { options: { ...off, eccm: true } })]))
    const column = asked.columns[1]
    const plain = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { options: off })])).columns[1]
    const cells = Object.values(column.figures)

    return column.blocked.length === 1 && column.valid && cells.length > 5 && cells.every((cell) => cell.value === null && cell.reason && cell.reason.includes(column.blocked[0].reason)) && column.withheld.includes(column.blocked[0].reason) && plain.blocked.length === 0 && plain.withheld === '' && known(figureOf(plain, 'sizeSum')) && known(figureOf(plain, 'size')) && known(figureOf(asked.columns[0], 'cost')) && /Not applied: .*no level/.test(m.md.summaryText(asked, {})) ? true : short([column.blocked, cells.map((cell) => cell.value), plain.blocked.length, plain.withheld])
  }],
  ['gating: a laser warhead asked for with no laser efficiency typed is blocked and shows no figure, and a typed efficiency gives the laser damage', () => {
    const ctx = STOCK_CONTEXT(m)
    const manual = { ...emptyManualOf(m), engine: '20', fuel: '0.5', maxThrust: '3', warhead: '10', reactor: '1', laserEfficiency: '' }
    const options = { eccm: false, terminal: false, retarget: false, laser: true }
    const without = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { techMode: 'manual', manual, options })])).columns[1]
    const typed = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { techMode: 'manual', manual: { ...manual, laserEfficiency: '0.5' }, options })])).columns[1]

    return without.blocked.length === 1 && without.blocked[0].id === 'laser' && /Laser warhead/.test(without.blocked[0].reason) && valueOf(without, 'damage') === null && valueOf(without, 'cost') === null && typed.blocked.length === 0 && typed.withheld === '' && known(figureOf(typed, 'damage')) ? true : short([without.blocked, valueOf(without, 'damage'), valueOf(without, 'cost'), typed.blocked, valueOf(typed, 'damage')])
  }],
  ['gating: a retargeting level above the one the rules were checked for is blocked', () => {
    const ctx = STOCK_CONTEXT(m, { 276: hypothetical(276, 2) })
    const column = compareOf(m, ctx, ORDINARY, withKeys([draftOf(m, ctx, ORDINARY, { options: { eccm: false, terminal: false, retarget: true, laser: false } })])).columns[1]
    const entry = column.gated.find((item) => item.id === 'retargetHigh')

    return entry.state === 'blocked' && /level 1/.test(entry.label) && entry.reason ? true : short(entry)
  }],
  ['gating: a ground pod or an enhanced radiation warhead on a saved row is recorded, never modelled', () => {
    const fixture = copy(fixtureOf(STOCK))
    const row = fixture.designs.find((entry) => entry.id === ORDINARY).row

    row.GroundShots = 2

    const column = columnOf(m, contextOf(m, STOCK, {}, fixture), ORDINARY)

    return column.gated.find((entry) => entry.id === 'groundPod').state === 'recorded' && column.gated.filter((entry) => entry.state === 'recorded').length >= 1 ? true : short(column.gated.map((entry) => [entry.id, entry.state]))
  }],
  ['gating: the states are described in words', () => (['not-offered', 'carried', 'recorded', 'blocked'].every((state) => m.md.gatedStateText(state) && m.md.gatedStateText(state) !== state) ? true : 'a state with no words')],
]

// The saves the owned checks read, opened by `run`: { modded: { database, ids }, stock: { database, ids } }. A save that is not there leaves its checks skipped, reported as such, and the mutants that name only skipped checks are skipped with them.
const SAVES = {}

const skipped = (reason) => ({ skipped: reason })

const ownedChecks = (m) => {
  const wrap = (database, change) => ({ query: async (sql, options) => change(sql, await database.query(sql, options)) })
  const heldRows = (sql) => /FCT_RaceTech/.test(sql) && !/FCT_TechSystem/.test(sql)
  const on = (key, test) => async () => (SAVES[key] ? test(SAVES[key]) : skipped(`the ${key} save is not there`))
  const idsOf = (designs) => designs.fixture.designs.filter((design) => !design.stageOnly).map((design) => design.id).sort((a, b) => a - b)

  return [
    ['owned: the designs a race owns and has researched are imported, with their obsolete flags', on('modded', async (save) => {
      const designs = await m.md.loadDesigns(save.database, save.ids)

      return idsOf(designs).join() === '500724,500726,500728' && designs.excluded === 0 && designs.obsolete[500726] === true && designs.obsolete[500724] === false ? true : short([designs.fixture.designs.map((design) => design.id), designs.obsolete, designs.excluded])
    })],
    ['owned: a design the race owns and has not researched is not imported and is counted', on('modded', async (save) => {
      const database = wrap(save.database, (sql, result) => (heldRows(sql) ? [result[0].filter((row) => Number(row.TechID) !== 500726)] : result))
      const designs = await m.md.loadDesigns(database, save.ids)

      return idsOf(designs).join() === '500724,500728' && designs.excluded === 1 && !(500726 in designs.obsolete) ? true : short([designs.fixture.designs.map((design) => design.id), designs.excluded])
    })],
    ['owned: a design another race owns is not imported even when this race holds its tech', on('modded', async (save) => {
      const database = wrap(save.database, (sql, result) => (heldRows(sql) ? [[...result[0], { TechID: 154198, Obsolete: 0 }, { TechID: 500363, Obsolete: 0 }]] : result))
      const designs = await m.md.loadDesigns(database, save.ids)
      const ids = idsOf(designs).join()

      return ids === '500724,500726,500728' && designs.excluded === 0 ? true : short([ids, designs.excluded])
    })],
    ['owned: another race of the same save gets its own designs and none of this race\'s', on('modded', async (save) => {
      const other = await m.md.loadDesigns(save.database, { GameID: save.ids.GameID, RaceID: 785 })
      const own = other.fixture.designs.filter((design) => !design.stageOnly)

      return own.length > 0 && own.every((design) => design.race === 785) && !own.some((design) => [500724, 500726, 500728].includes(design.id)) ? true : short(own.map((design) => [design.id, design.race]))
    })],
    ['owned: the designs loaded from the stock save are researched designs of its fixture, with the figures the fixture holds', on('stock', async (save) => {
      const designs = await m.md.loadDesigns(save.database, save.ids)
      const expected = fixtureOf(STOCK).designs.filter((design) => !design.stageOnly)
      const loaded = designs.fixture.designs.filter((design) => !design.stageOnly)
      const same = loaded.every((design) => {
        const fixed = expected.find((entry) => entry.id === design.id)

        return fixed && fixed.race === STOCK.race && fixed.row.Size === design.row.Size && fixed.row.Speed === design.row.Speed && fixed.row.Cost === design.row.Cost
      })

      return loaded.length > 0 && same && loaded.some((design) => design.id === ORDINARY) && Number.isInteger(designs.excluded) && designs.excluded >= 0 ? true : short([idsOf(designs), idsOf({ fixture: { designs: expected } }), designs.excluded])
    })],
  ]
}

const recordChecks = (m) => {
  const { md } = m
  const designs = designsOf(m)
  const seed = async (repository, scope = scopeIn(), payload = payloadOf(m)) => (await md.saveDesign(repository, scope, designs, { payload })).record
  const ctx = STOCK_CONTEXT(m)
  const draft = (change = {}) => ({ ...draftOf(m, ctx, ORDINARY, change), key: 'alt-1' })

  return [
    ['record: a comparison is kept as a typed record of the race on its branch and read back whole', async () => {
      const { repository } = fresh(m)
      const payload = payloadOf(m, 'Anti-ship', { alternatives: [draft({ name: 'Faster', engines: '2' }), { ...md.savedAlternative(154602, 'Buoy B'), key: 'alt-2' }], scenario: { targetSpeed: '5000', jammer: '1', modifier: '0.8', pd: '120', targetSignature: '4' } })
      const saved = await md.saveDesign(repository, scopeIn(), designs, { payload })
      const read = md.readDesigns(repository, scopeIn(), designs)
      const record = repository.list(scopeIn(), { kind: md.DESIGNER_KIND })[0].record

      return saved.ok && read.entries.length === 1 && read.error === null && equal(read.entries[0].payload, payload) && read.entries[0].name === 'Anti-ship' && read.entries[0].status === 'current' && !read.entries[0].ahead && record.kind === 'planner.missileDesign' && record.association.policy === 'branch' && record.RaceID === STOCK.race ? true : short([saved, read.entries.map((entry) => entry.payload), record && record.association])
    }],
    ['record: the saved designs a comparison names are links of the type missile, and a design that changed or is gone is flagged, not rebound', async () => {
      const { repository } = fresh(m)

      await seed(repository, scopeIn(), payloadOf(m, 'Linked', { alternatives: [{ ...md.savedAlternative(154602), key: 'alt-1' }] }))

      const read = (known) => md.readDesigns(repository, scopeIn(), known).entries[0]
      const linked = read(designs)
      const changed = fixtureOf(STOCK)

      changed.designs.find((design) => design.id === ORDINARY).row.Speed = 1
      changed.designs = changed.designs.filter((design) => design.id !== 154602)

      const after = read({ fixture: changed, obsolete: {}, excluded: 0 })

      return linked.links.map((link) => `${link.type}:${link.id}:${link.status}`).sort().join() === `missile:154602:linked,missile:${ORDINARY}:linked` && after.links.map((link) => `${link.id}:${link.status}`).sort().join() === `154602:missing,${ORDINARY}:changed` ? true : short([linked.links, after.links])
    }],
    ['record: a comparison is seen on every race of the save only as its own, and not on another campaign', async () => {
      const { repository } = fresh(m)

      await seed(repository)

      const names = (scope) => md.readDesigns(repository, scope, designs).entries.map((entry) => entry.name)
      const out = { same: names(scopeIn()), otherRace: names(scopeIn({ RaceID: STOCK.race + 1 })), otherCampaign: names(scopeIn({ campaignId: 'c2' })), otherBranch: names(scopeIn({ branchId: 'b2' })) }

      return out.same.join() === 'Anti-ship' && out.otherRace.length === 0 && out.otherCampaign.length === 0 && out.otherBranch.length === 0 ? true : short(out)
    }],
    ['record: a comparison made at a later game time is listed, flagged and not applied, and moving it applies it unchanged', async () => {
      const { repository } = fresh(m)
      const payload = payloadOf(m)
      const later = await md.saveDesign(repository, scopeIn({ gameTime: 500 }), designs, { payload })
      const entry = md.readDesigns(repository, scopeIn({ gameTime: 100 }), designs).entries[0]
      const moved = await md.moveDesign(repository, scopeIn({ gameTime: 100 }), entry)
      const after = md.readDesigns(repository, scopeIn({ gameTime: 100 }), designs).entries[0]

      return later.ok && entry && entry.ahead === true && entry.status === 'ahead' && entry.flags.includes('ahead') && moved.ok && after.ahead === false && after.status === 'current' && equal(after.payload, payload) ? true : short([entry && entry.status, moved, after && after.status])
    }],
    ['record: a tab that does not hold the file writes nothing and says so', async () => {
      const { mem, repository } = fresh(m)

      await seed(repository)

      const entry = md.readDesigns(repository, scopeIn(), designs).entries[0]
      const before = mem.writes()

      mem.owner.value = false

      const created = await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Other') })
      const edited = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Renamed') })
      const moved = await md.moveDesign(repository, scopeIn(), entry)
      const removed = await md.deleteDesign(repository, scopeIn(), entry)

      return [created, edited, moved, removed].every((outcome) => !outcome.ok && outcome.code === 'not-owner' && outcome.message.includes('Another tab')) && mem.writes() === before && md.readDesigns(repository, scopeIn(), designs).entries.length === 1 ? true : short([created, edited, moved, removed, mem.writes() - before])
    }],
    ['record: no repository and no scope write nothing and say why', async () => {
      const { mem, repository } = fresh(m)
      const before = mem.writes()
      const none = await md.saveDesign(null, scopeIn(), designs, { payload: payloadOf(m) })
      const unscoped = await md.saveDesign(repository, null, designs, { payload: payloadOf(m) })
      const read = [md.readDesigns(null, scopeIn(), designs), md.readDesigns(repository, null, designs)]

      return none.code === 'no-repository' && unscoped.code === 'no-scope' && !none.ok && !unscoped.ok && mem.writes() === before && read.every((item) => item.entries.length === 0 && item.error === null) ? true : short([none, unscoped])
    }],
    ['record: a comparison that is not valid is refused and nothing is written', async () => {
      const { mem, repository } = fresh(m)
      const before = mem.writes()
      const three = [1, 2, 3, 4].map((index) => ({ ...md.savedAlternative(154602), key: `alt-${index}` }))
      const attempts = [payloadOf(m, ''), payloadOf(m, 'x'.repeat(81)), payloadOf(m, 'Too many', { alternatives: three }), payloadOf(m, 'Bad design', { alternatives: [{ ...draft(), engines: 2 }] }), payloadOf(m, 'Bad scenario', { scenario: { targetSpeed: 5 } }), payloadOf(m, 'Bad baseline', { baselineId: 'x' })]
      const outcomes = []

      for (const payload of attempts) {
        outcomes.push(await md.saveDesign(repository, scopeIn(), designs, { payload }))
      }

      let direct = null

      try {
        repository.create(scopeIn(), { kind: md.DESIGNER_KIND, policy: 'branch', payload: { name: 'Raw' } })
      } catch (error) {
        direct = error.code
      }

      return outcomes.every((outcome) => !outcome.ok && outcome.code === 'invalid-design') && mem.writes() === before && direct !== null && md.problemsOf(payloadOf(m)).length === 0 && md.problemsOf(null).length === 1 ? true : short([outcomes.map((outcome) => outcome.code), direct, mem.writes() - before])
    }],
    ['record: a comparison naming a design the race has not researched and owns is refused', async () => {
      const { mem, repository } = fresh(m)
      const before = mem.writes()
      const outcome = await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Stranger', { baselineId: 500724 }) })

      return !outcome.ok && outcome.code === 'unknown-design' && /500724/.test(outcome.message) && mem.writes() === before ? true : short(outcome)
    }],
    ['record: a stale save is refused with the stored payload and written over only when asked', async () => {
      const { repository } = fresh(m)

      await seed(repository)

      const entry = md.readDesigns(repository, scopeIn(), designs).entries[0]
      const other = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Changed elsewhere', { scenario: { ...payloadOf(m).scenario, pd: '9' } }) })
      const refused = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Mine') })
      const stored = md.readDesigns(repository, scopeIn(), designs).entries[0]
      const forced = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Mine'), overwrite: true })
      const after = md.readDesigns(repository, scopeIn(), designs).entries

      return other.ok && !refused.ok && refused.code === 'revision-conflict' && refused.stored.name === 'Changed elsewhere' && stored.name === 'Changed elsewhere' && stored.payload.scenario.pd === '9' && forced.ok && after.length === 1 && after[0].name === 'Mine' ? true : short([refused, stored.name, forced, after.map((item) => item.name)])
    }],
    ['record: a comparison is edited in place and deleted, and a stale delete is refused', async () => {
      const { repository } = fresh(m)

      await seed(repository)

      const entry = md.readDesigns(repository, scopeIn(), designs).entries[0]
      const edited = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Anti-ship', { alternatives: [draft()] }) })
      const stale = await md.deleteDesign(repository, scopeIn(), entry)
      const fresher = md.readDesigns(repository, scopeIn(), designs).entries[0]
      const removed = await md.deleteDesign(repository, scopeIn(), fresher)

      return edited.ok && edited.record.uuid === entry.uuid && !stale.ok && stale.code === 'revision-conflict' && removed.ok && md.readDesigns(repository, scopeIn(), designs).entries.length === 0 ? true : short([edited.ok, stale, removed])
    }],
    ['record: the payload keeps the inputs only, as text, and never a figure of the save', async () => {
      const tech = md.techChoicesOf({ [md.DESIGN_LINES.warhead]: { techId: 900001, source: 'scenario' } }, TECH_KNOWN())
      const payload = md.payloadOf({ name: '  Anti-ship  ', baselineId: ORDINARY, alternatives: [draft()], scenario: { pd: 5 }, tech })
      const text = JSON.stringify(payload)

      return payload.name === 'Anti-ship' && payload.scenario.pd === '5' && payload.scenario.targetSpeed === '10000' && md.problemsOf(payload).length === 0 && !/"value"|"result"|"figures"/.test(text) && payload.alternatives[0].engines === draft().engines && equal(payload.tech, tech) && Object.keys(payload.tech.choices).length === 1 && equal(md.payloadOf({ name: 'x', alternatives: [], scenario: {} }).tech, { choices: {} }) ? true : short(payload)
    }],
    ['record: the tech levels chosen are kept with the comparison by ID and name as researched or hypothetical, linked to the tech, and read back as saved', async () => {
      const { repository } = fresh(m)
      const tech = TECH_KNOWN()
      const selection = { [md.DESIGN_LINES.warhead]: { techId: 900001, source: 'scenario', name: 'Hypothetical warhead' }, [md.DESIGN_LINES.eccm]: { techId: 900002, source: 'preference' }, 99999: { techId: 900003, source: 'preference' } }
      const choices = md.techChoicesOf(selection, tech)
      const payload = payloadOf(m, 'Tech', { tech: choices })
      const saved = await md.saveDesign(repository, scopeIn(), designs, { payload, tech })
      const read = md.readDesigns(repository, scopeIn(), designs, tech).entries[0]
      const changed = TECH_KNOWN()

      changed.known[900001].cost = 1
      delete changed.known[900002]

      const after = md.readDesigns(repository, scopeIn(), designs, changed).entries[0]
      const expected = { [md.DESIGN_LINES.warhead]: { techId: 900001, name: 'Hypothetical warhead', kind: 'hypothetical' }, [md.DESIGN_LINES.eccm]: { techId: 900002, name: 'ECCM level 2', kind: 'researched' } }
      const links = (entry) => entry.links.filter((link) => link.type === 'tech').map((link) => `${link.id}:${link.status}`).sort().join()

      return saved.ok && equal(choices.choices, expected) && equal(read.payload.tech, choices) && links(read) === '900001:linked,900002:linked' && links(after) === '900001:changed,900002:missing' && !/"info"|"cost"|"value"/.test(JSON.stringify(read.payload.tech)) ? true : short([saved, choices, read && links(read), after && links(after)])
    }],
    ['record: a save keeps the tech links it was read with, an update, a write over a stale revision and a new copy never accept a changed tech, and a tech chosen now is linked to the open save', async () => {
      const { repository } = fresh(m)
      const tech = TECH_KNOWN()
      const warhead = md.DESIGN_LINES.warhead
      const eccm = md.DESIGN_LINES.eccm
      const selection = { [warhead]: { techId: 900001, source: 'scenario', name: 'Hypothetical warhead' }, [eccm]: { techId: 900002, source: 'preference' } }

      await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Tech', { tech: md.techChoicesOf(selection, tech) }), tech })

      const changed = TECH_KNOWN()

      changed.known[900001].cost = 1
      delete changed.known[900002]

      const entry = md.readDesigns(repository, scopeIn(), designs, changed).entries[0]
      const readSelection = Object.fromEntries(Object.entries(selection).map(([type, choice]) => [type, { ...choice, link: entry.links.find((link) => link.type === 'tech' && link.id === choice.techId) }]))
      const carry = md.techLinksOf(readSelection)
      const payload = payloadOf(m, 'Renamed', { tech: md.techChoicesOf(readSelection, changed) })
      const statuses = () => md.readDesigns(repository, scopeIn(), designs, changed).entries.map((item) => `${item.name}:${item.links.filter((link) => link.type === 'tech').map((link) => `${link.id}:${link.status}`).sort().join()}`).sort().join(' ')
      const updated = await md.saveDesign(repository, scopeIn(), designs, { entry, payload, tech: changed, carry })
      const afterUpdate = statuses()
      const stale = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Written over', { tech: payload.tech }), tech: changed, carry, overwrite: true })
      const afterOverwrite = statuses()
      const copy = await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Copy', { tech: payload.tech }), tech: changed, carry })
      const afterCopy = statuses()
      const chosenNow = await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Chosen now', { tech: payload.tech }), tech: changed })
      const afterChosen = statuses()
      const pairs = '900001:changed,900002:missing'

      return md.techLinksOf(selection).length === 0 && carry.length === 2 && updated.ok && afterUpdate === `Renamed:${pairs}` && stale.ok && afterOverwrite === `Written over:${pairs}` && copy.ok && afterCopy === `Copy:${pairs} Written over:${pairs}` && chosenNow.ok && afterChosen === `Chosen now:900001:linked Copy:${pairs} Written over:${pairs}` ? true : short([carry, afterUpdate, afterOverwrite, afterCopy, afterChosen])
    }],
    ['record: a save keeps the links of the saved designs it was read with, an update, a write over a stale revision and a new copy never accept a changed design, and a design picked now is linked to the open save', async () => {
      const { repository } = fresh(m)
      const kept = [{ ...m.md.savedAlternative(154602), key: 'alt-1' }]
      const repriced = { ...designs, fixture: { ...designs.fixture, designs: designs.fixture.designs.map((design) => (design.id === ORDINARY || design.id === 154602 ? { ...design, row: { ...design.row, Cost: Number(design.row.Cost) + 1 } } : design)) } }

      await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Missiles', { alternatives: kept }) })

      const entry = md.readDesigns(repository, scopeIn(), repriced).entries[0]
      const carry = md.carryOf(entry.links, entry.payload)
      const statuses = () => md.readDesigns(repository, scopeIn(), repriced).entries.map((item) => `${item.name}:${item.links.filter((link) => link.type === 'missile').map((link) => `${link.id}:${link.status}`).sort().join()}`).sort().join(' ')
      const before = md.readDesigns(repository, scopeIn(), designs).entries[0].links.map((link) => link.status).join()
      const changed = `${ORDINARY}:changed,154602:changed`.split(',').sort().join()
      const updated = await md.saveDesign(repository, scopeIn(), repriced, { entry, payload: payloadOf(m, 'Renamed', { alternatives: kept }), carry })
      const afterUpdate = statuses()
      const stale = await md.saveDesign(repository, scopeIn(), repriced, { entry, payload: payloadOf(m, 'Written over', { alternatives: kept }), carry, overwrite: true })
      const afterOverwrite = statuses()
      const copy = await md.saveDesign(repository, scopeIn(), repriced, { payload: payloadOf(m, 'Copy', { alternatives: kept }), carry })
      const afterCopy = statuses()
      const picked = await md.saveDesign(repository, scopeIn(), repriced, { payload: payloadOf(m, 'Picked', { alternatives: kept }), carry: carry.filter((link) => link.id !== ORDINARY) })
      const afterPicked = statuses()

      return before === 'linked,linked' && updated.ok && afterUpdate === `Renamed:${changed}` && stale.ok && afterOverwrite === `Written over:${changed}` && copy.ok && afterCopy === `Copy:${changed} Written over:${changed}` && picked.ok && afterPicked === `Copy:${changed} Picked:154602:changed,${ORDINARY}:linked Written over:${changed}` ? true : short([before, afterUpdate, afterOverwrite, afterCopy, afterPicked])
    }],
    ['record: a tech choice kept with no link stays unlinked through a save, whatever the open save holds under its ID, until it is chosen again', async () => {
      const { repository } = fresh(m)
      const tech = TECH_KNOWN()
      const choices = { choices: { [md.DESIGN_LINES.warhead]: { techId: 900001, name: 'Hypothetical warhead', kind: 'hypothetical' } } }

      await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'No link', { tech: choices }) })

      const entry = md.readDesigns(repository, scopeIn(), designs, tech).entries[0]
      const carry = md.carryOf(entry.links, entry.payload)
      const links = () => md.readDesigns(repository, scopeIn(), designs, tech).entries.map((item) => `${item.name}:${item.links.filter((link) => link.type === 'tech').map((link) => `${link.id}:${link.status}`).join()}`).sort().join(' ')
      const first = links()
      const updated = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Renamed', { tech: choices }), tech, carry })
      const afterUpdate = links()
      const copy = await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Copy', { tech: choices }), tech, carry })
      const afterCopy = links()
      const chosen = await md.saveDesign(repository, scopeIn(), designs, { payload: payloadOf(m, 'Chosen again', { tech: choices }), tech })

      return equal(carry.filter((link) => link.type === 'tech'), [{ type: 'tech', id: 900001, fingerprint: null }]) && carry.some((link) => link.type === 'missile' && link.fingerprint) && first === 'No link:' && updated.ok && afterUpdate === 'Renamed:' && copy.ok && afterCopy === 'Copy: Renamed:' && chosen.ok && links() === 'Chosen again:900001:linked Copy: Renamed:' ? true : short([carry, first, afterUpdate, afterCopy, links()])
    }],
    ['record: a tech choice that is not a level of a line a design reads, or not researched or hypothetical, is refused and nothing is written', async () => {
      const { mem, repository } = fresh(m)
      const before = mem.writes()
      const good = { techId: 900001, name: 'Level', kind: 'hypothetical' }
      const warhead = String(md.DESIGN_LINES.warhead)
      const withTech = (tech) => payloadOf(m, 'Bad tech', { tech })
      const missing = payloadOf(m, 'No tech')

      delete missing.tech

      const attempts = [missing, withTech({}), withTech({ choices: [] }), withTech({ choices: { 99999: good } }), withTech({ choices: { [warhead]: { ...good, techId: 0 } } }), withTech({ choices: { [warhead]: { ...good, kind: 'guessed' } } }), withTech({ choices: { [warhead]: { ...good, name: '' } } }), withTech({ choices: { [warhead]: { ...good, name: 'x'.repeat(201) } } })]
      const outcomes = []

      for (const payload of attempts) {
        outcomes.push(await md.saveDesign(repository, scopeIn(), designs, { payload }))
      }

      return outcomes.every((outcome) => !outcome.ok && outcome.code === 'invalid-design') && mem.writes() === before && md.problemsOf(withTech({ choices: { [warhead]: good, [md.DESIGN_LINES.eccm]: { ...good, kind: 'researched' } } })).length === 0 ? true : short([outcomes.map((outcome) => outcome.code), mem.writes() - before])
    }],
    ['record: a comparison saved before the tech choices were kept opens with none, is not dropped from the list and is migrated when it is edited', async () => {
      const { mem, repository } = fresh(m)

      await seed(repository, scopeIn(), payloadOf(m, 'Old'))

      const name = [...mem.files.keys()][0]
      const file = mem.files.get(name)

      Object.values(file.records).forEach((record) => {
        record.schema = 1
        delete record.payload.tech
      })
      mem.files.set(name, file)

      const read = md.readDesigns(repository, scopeIn(), designs)
      const entry = read.entries[0]
      const edited = await md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Old', { scenario: { ...payloadOf(m).scenario, pd: '3' } }) })
      const stored = repository.list(scopeIn(), { kind: md.DESIGNER_KIND })[0].record

      return md.DESIGNER_SCHEMA === 2 && read.entries.length === 1 && read.notes.length === 0 && entry && equal(entry.payload.tech, { choices: {} }) && edited.ok && stored.schema === md.DESIGNER_SCHEMA && stored.payload.tech && equal(stored.payload.tech, { choices: {} }) ? true : short([read.entries.length, read.notes, edited, stored.schema])
    }],
  ]
}

const GROUPS = (m) => [...unitChecks(m), ...reconcileChecks(m).map(([name, test, detail]) => [name, test, detail]), ...designedChecks(m), ...engineChecks(m), ...plannerChecks(m), ...compareChecks(m), ...sourceChecks(m), ...gatingChecks(m), ...ownedChecks(m), ...recordChecks(m)]

// ---------- the page ----------

const PAGE = 'pages/missile-designer'

const FIELDS_STUB = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => { globalThis.__missileDesignerFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'

const pageStatements = async (mutate, m) => {
  const options = await loadPage(PAGE, { stubs: STUBS, mutate, modules: { 'mixins/persisted-view': FIELDS_STUB } })
  const fields = globalThis.__missileDesignerFields
  const designs = designsOf(m)
  const tech = (overrides) => resolutionOf(m, designs.fixture, STOCK.race, overrides)
  const page = (data = {}) => instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }, database: {}, GameID: 138, RaceID: STOCK.race, data: { designs, techResolution: tech(), formulaVersion: null, ...data } })
  const pageOver = (techOver, data = {}) => instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }, database: {}, GameID: 138, RaceID: STOCK.race, data: { designs, tech: techOver, formulaVersion: null, ...data } })
  const WARHEAD = m.md.DESIGN_LINES.warhead
  const held = m.dd.heldMissileLevels(designs.fixture, STOCK.race)[WARHEAD].sort((a, b) => b.cost - a.cost || b.id - a.id)
  const PICK_WARHEAD = held[0].id
  const RESEARCHED_WARHEAD = held[1].id
  const NEXT_WARHEAD = 900012
  // The tech of the race as the tech scenarios read it (`lines` with the levels held, the game's pick and the candidates; `known` every tech by id), built from the held levels of the fixture and one hypothetical next warhead level. `without` leaves a tech out of the save, `reprice` changes the cost the save gives a tech.
  const techData = ({ without = null, reprice = null } = {}) => {
    const lines = {}
    const known = {}
    const levelsHeld = m.dd.heldMissileLevels(designs.fixture, STOCK.race)

    for (const type of m.md.DESIGN_LINE_TYPES) {
      const levels = [...(levelsHeld[type] || [])].sort((a, b) => b.cost - a.cost || b.id - a.id).filter((level) => level.id !== without).map((level) => ({ id: level.id, typeId: type, name: `level ${level.id}`, info: level.info, info2: 0, cost: level.cost }))

      levels.forEach((level) => {
        known[level.id] = { ...level }
      })
      lines[type] = { levels, pick: levels[0] || null, candidates: [], excluded: [], next: null }
    }

    const next = { id: NEXT_WARHEAD, typeId: WARHEAD, name: 'Hypothetical warhead', info: lines[WARHEAD].pick.info + 1, info2: 0, cost: 30000, status: 'available' }

    if (without !== NEXT_WARHEAD) {
      lines[WARHEAD].candidates = [next]
      lines[WARHEAD].next = next
      known[NEXT_WARHEAD] = { id: next.id, typeId: next.typeId, name: next.name, info: next.info, info2: next.info2, cost: next.cost + (reprice === NEXT_WARHEAD ? 1 : 0) }
    }

    return { lines, known, fixed: {} }
  }
  const withRecords = async (payloads = []) => {
    const { mem, repository } = fresh(m)
    const kept = []

    for (const payload of payloads) {
      kept.push((await m.md.saveDesign(repository, scopeIn(), designs, { payload })).record)
    }

    return { mem, repository, kept, records: { repository, error: null } }
  }
  const clipboard = async (test) => {
    const written = []
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { written.push(text) } } }, configurable: true, writable: true })

    try {
      return await test(written)
    } finally {
      if (before) {
        Object.defineProperty(globalThis, 'navigator', before)
      } else {
        delete globalThis.navigator
      }
    }
  }

  return [
    ['page: the baseline and the alternatives are compared under the scenario of the page', () => {
      const vm = page({ baselineId: ORDINARY, alternatives: [], hitTargetSpeed: '5000', pd: '10' })
      const result = vm.comparison
      const speed = valueOf(result.columns[0], 'speed')

      return result.columns.length === 1 && close(valueOf(result.columns[0], 'hitChance'), hitOf(m, { speed: 24500, atg: 1.2, eccm: 0, warheads: 1 }, { targetSpeed: '5000' })) && close(valueOf(result.columns[0], 'planner'), valueOf(result.columns[0], 'damage') * valueOf(result.columns[0], 'hitChance') / 100 * (1 - 10 / speed)) && vm.scenarioInput.pd === '10' ? true : short([result.columns.length, vm.scenarioInput, result.columns[0].figures.planner.reason, valueOf(result.columns[0], 'hitChance'), valueOf(result.columns[0], 'damage'), speed])
    }],
    ['page: the hit scenario fields are those of the hit chance panel and the designer fields are kept for the race', () => {
      const hit = ['hitTargetSpeed', 'hitJammer', 'hitModifier'].map((name) => [fields[name].key, fields[name].default, fields[name].scope])
      const mine = ['baselineId', 'alternatives', 'techChoice'].map((name) => fields[name].scope)

      return equal(hit, [['missileHitTargetSpeed', '10000', undefined], ['missileHitJammer', '0', undefined], ['missileHitModifier', '1', undefined]]) && mine.every((scope) => scope === 'race') && fields.pd.default === '0' && fields.pd.valid('5') && !fields.pd.valid(5) && fields.baselineId.valid(null) && fields.baselineId.valid(154630) && !fields.baselineId.valid('154630') && fields.alternatives.valid([]) && !fields.alternatives.valid([{}, {}, {}, {}]) && !fields.alternatives.valid('x') ? true : short([hit, mine])
    }],
    ['page: a design seeded from the baseline is an alternative and the baseline is unchanged, and a fourth alternative is refused with the reason', () => {
      const vm = page({ baselineId: ORDINARY, alternatives: [] })
      const before = copy(vm.comparison.columns[0].figures)

      vm.seedFromBaseline()

      const seeded = vm.comparison

      vm.addSaved(154602)
      vm.addSaved(154194)

      const full = vm.alternatives.length

      vm.addSaved(154192)

      return seeded.columns.length === 2 && seeded.columns[1].kind === 'designed' && seeded.columns[1].seededFrom === ORDINARY && equal(seeded.columns[0].figures, before) && full === 3 && vm.alternatives.length === 3 && /At most 3/.test(vm.alternativeMessage) && vm.comparison.columns.length === 4 && vm.comparison.columns[0].role === 'baseline' && vm.comparison.columns[0].savedId === ORDINARY ? true : short([seeded.columns.length, full, vm.alternatives.length, vm.alternativeMessage])
    }],
    ['page: a PD below 0 is a field error and the planner figure is unavailable, never negative', () => {
      const vm = page({ baselineId: ORDINARY, alternatives: [], pd: '-1' })
      const column = vm.comparison.columns[0]

      return vm.pdError && /0 or more/.test(vm.pdError) && vm.comparison.pdError === vm.pdError && column.figures.planner.value === null && column.figures.planner.reason && page({ baselineId: ORDINARY, alternatives: [], pd: '0' }).pdError === '' ? true : short([vm.pdError, column.figures.planner])
    }],
    ['page: the copied summary names the planner figure and is written to the clipboard', () => clipboard(async (written) => {
      const vm = page({ baselineId: ORDINARY, alternatives: [], pd: '100' })

      await vm.copySummary()

      return written.length === 1 && /planner figure/i.test(written[0]) && /not a game statistic/i.test(written[0]) && written[0] === vm.summary && /copied/.test(vm.copyMessage) ? true : short([written, vm.copyMessage])
    })],
    ['page: a clipboard that is not there is said so and nothing is thrown', () => clipboard(async () => {
      delete globalThis.navigator

      const vm = page({ baselineId: ORDINARY, alternatives: [] })

      await vm.copySummary()

      return /could not be copied/.test(vm.copyMessage) ? true : vm.copyMessage
    })],
    ['page: a comparison is kept, opened again with its baseline, alternatives and scenario, and deleted', async () => {
      const { records } = await withRecords()
      const vm = page({ records, baselineId: ORDINARY, alternatives: [{ ...m.md.savedAlternative(154602), key: 'alt-1' }], pd: '120', hitTargetSpeed: '4000', recordName: 'Anti-ship' })

      await vm.saveRecord()

      const stored = vm.recordsRead.entries
      const origin = vm.recordOrigin

      vm.baselineId = null
      vm.alternatives = []
      vm.pd = '0'
      vm.hitTargetSpeed = '10000'
      vm.openRecord(stored[0].uuid)

      const opened = vm.baselineId === ORDINARY && vm.alternatives.length === 1 && vm.alternatives[0].savedId === 154602 && vm.pd === '120' && vm.hitTargetSpeed === '4000' && vm.recordName === 'Anti-ship'

      await vm.deleteRecord(stored[0].uuid)

      return stored.length === 1 && stored[0].name === 'Anti-ship' && origin === stored[0].uuid && opened && vm.recordsRead.entries.length === 0 && vm.recordOrigin === null ? true : short([stored.length, opened, vm.recordsRead.entries.length, vm.recordMessage])
    }],
    ['page: the name of a comparison is asked for only after the field is touched or a save is tried, and opening or starting a comparison clears it', async () => {
      const { records } = await withRecords([payloadOf(m, 'Anti-ship')])
      const vm = page({ records, baselineId: ORDINARY, alternatives: [] })
      const untouched = vm.recordNameError

      vm.recordTouched = true

      const touched = vm.recordNameError

      vm.newRecord()

      const cleared = vm.recordNameError

      await vm.saveRecord()

      const tried = vm.recordNameError

      vm.openRecord(vm.recordsRead.entries.length ? vm.recordsRead.entries[0].uuid : null)

      return untouched === '' && /Name the comparison/.test(touched) && cleared === '' && /Name the comparison/.test(tried) && vm.recordNameError === '' && vm.recordName === 'Anti-ship' ? true : short([untouched, touched, cleared, tried, vm.recordNameError, vm.recordName])
    }],
    ['page: a blank name keeps nothing, and a missing repository says why', async () => {
      const { records } = await withRecords()
      const blank = page({ records, baselineId: ORDINARY, alternatives: [], recordName: '   ' })
      const none = page({ records: { repository: null, error: 'no store' }, baselineId: ORDINARY, alternatives: [], recordName: 'x' })

      await blank.saveRecord()
      await none.saveRecord()

      return !blank.canSaveRecord && blank.recordsRead.entries.length === 0 && !none.canSaveRecord && none.recordNotice.length > 0 && none.recordsRead.entries.length === 0 ? true : short([blank.canSaveRecord, blank.recordMessage, none.recordNotice])
    }],
    ['page: a comparison changed elsewhere is not written over unless asked', async () => {
      const { records, repository, kept } = await withRecords([payloadOf(m, 'Anti-ship')])
      const vm = page({ records, baselineId: ORDINARY, alternatives: [], recordName: 'Mine' })

      vm.openRecord(kept[0].uuid)
      vm.recordName = 'Mine'

      const entry = vm.recordsRead.entries[0]

      await m.md.saveDesign(repository, scopeIn(), designs, { entry, payload: payloadOf(m, 'Elsewhere') })
      await vm.saveRecord()

      const refused = vm.recordConflict
      const kept1 = vm.recordsRead.entries[0].name

      await vm.saveRecord(true)

      return refused && refused.name === 'Elsewhere' && kept1 === 'Elsewhere' && vm.recordConflict === null && vm.recordsRead.entries.length === 1 && vm.recordsRead.entries[0].name === 'Mine' ? true : short([refused, kept1, vm.recordsRead.entries.map((item) => item.name)])
    }],
    ['page: save as new keeps a second comparison and the first stays', async () => {
      const { records, kept } = await withRecords([payloadOf(m, 'Anti-ship')])
      const vm = page({ records, baselineId: ORDINARY, alternatives: [], recordName: 'Second' })

      vm.openRecord(kept[0].uuid)
      vm.recordName = 'Second'

      await vm.saveRecordAsNew()

      return vm.recordsRead.entries.length === 2 && vm.recordsRead.entries.map((item) => item.name).sort().join() === 'Anti-ship,Second' ? true : short(vm.recordsRead.entries.map((item) => item.name))
    }],
    ['page: the baseline is chosen and cleared by the page, with no column while none is chosen, and the saved choices are the designs of the race', () => {
      const vm = page({ baselineId: null, alternatives: [] })
      const none = vm.comparison.columns.length

      vm.setBaseline(154630)

      const set = vm.baselineId
      const column = vm.comparison.columns[0]

      vm.setBaseline(null)

      return none === 0 && set === 154630 && column.savedId === 154630 && column.role === 'baseline' && vm.baselineId === null && vm.canSeed === false && vm.savedItems.length > 0 && vm.savedItems.every((item) => Number.isInteger(item.value)) ? true : short([none, set, vm.savedItems.length])
    }],
    ['page: a comparison is opened again with the tech it was kept with, a hypothetical level is not swapped for a researched one, and a level the save no longer has reads unresolved and named', async () => {
      const { records } = await withRecords()
      const vm = pageOver(techData(), { records, baselineId: ORDINARY, alternatives: [], recordName: 'Tech' })
      const figures = () => ({ damage: valueOf(vm.comparison.columns[1], 'damage'), cost: valueOf(vm.comparison.columns[1], 'cost'), planner: valueOf(vm.comparison.columns[1], 'planner'), source: vm.comparison.columns[1].source })

      vm.seedFromBaseline()
      await vm.chooseNextTech(WARHEAD, NEXT_WARHEAD)

      const hypothetical = figures()

      await vm.saveRecord()

      const uuid = vm.recordOrigin
      const saved = vm.recordsRead.entries[0]

      await vm.setTech(WARHEAD, RESEARCHED_WARHEAD)

      const swapped = figures()

      vm.openRecord(uuid)

      const reopened = figures()
      const resolved = vm.techResolution[WARHEAD]
      const kept = { choice: equal(vm.techChoice, {}), notice: /this page only/.test(vm.scenarioNotice) }

      vm.tech = techData({ without: NEXT_WARHEAD })
      vm.openRecord(uuid)

      const gone = vm.techResolution[WARHEAD]
      const goneFigures = figures()
      const goneText = vm.unresolvedChoices.map((item) => item.text).join(' ')

      vm.tech = techData({ reprice: NEXT_WARHEAD })
      vm.openRecord(uuid)

      const repriced = vm.techResolution[WARHEAD]

      return saved && saved.payload.tech.choices[WARHEAD] && saved.payload.tech.choices[WARHEAD].kind === 'hypothetical' && hypothetical.source === 'hypothetical' && swapped.source === 'researched' && swapped.damage < hypothetical.damage && equal(reopened, hypothetical) && resolved.hypothetical && resolved.unresolved === null && kept.choice && kept.notice && gone.unresolved && gone.unresolved.name === 'Hypothetical warhead' && !gone.hypothetical && gone.level.id === PICK_WARHEAD && goneFigures.source === 'researched' && /Hypothetical warhead/.test(goneText) && repriced.unresolved && repriced.unresolved.name === 'Hypothetical warhead' && !repriced.hypothetical ? true : short([hypothetical, swapped, reopened, kept, gone.unresolved, goneFigures, goneText, repriced.unresolved])
    }],
    ['page: a tech choice reported changed stays unresolved when the comparison is renamed, changed in its PD or saved as a new one, and is linked again only after the tech is chosen again', async () => {
      const { records } = await withRecords()
      const vm = pageOver(techData(), { records, baselineId: ORDINARY, alternatives: [], recordName: 'Tech' })
      const damage = () => valueOf(vm.comparison.columns[1], 'damage')
      const linkOf = (uuid) => (vm.recordsRead.entries.find((entry) => entry.uuid === uuid).links.find((link) => link.type === 'tech' && link.id === NEXT_WARHEAD) || {}).status

      vm.seedFromBaseline()
      await vm.chooseNextTech(WARHEAD, NEXT_WARHEAD)

      const hypothetical = damage()

      await vm.saveRecord()

      const uuid = vm.recordOrigin
      const linkedAtFirst = linkOf(uuid)

      vm.tech = techData({ reprice: NEXT_WARHEAD })
      vm.openRecord(uuid)

      const changedOnOpen = { status: linkOf(uuid), unresolved: Boolean(vm.techResolution[WARHEAD].unresolved), damage: damage() }

      vm.recordName = 'Tech renamed'
      await vm.saveRecord()
      vm.openRecord(uuid)

      const renamed = { status: linkOf(uuid), unresolved: Boolean(vm.techResolution[WARHEAD].unresolved), damage: damage(), choice: Boolean(vm.recordsRead.entries[0].payload.tech.choices[WARHEAD]) }

      vm.pd = '1'
      await vm.saveRecord()
      vm.openRecord(uuid)

      const pdChanged = { status: linkOf(uuid), unresolved: Boolean(vm.techResolution[WARHEAD].unresolved), pd: vm.recordsRead.entries[0].payload.scenario.pd }

      await vm.saveRecordAsNew()

      const copy = vm.recordOrigin
      const asNew = { other: copy !== uuid, status: linkOf(copy) }

      vm.openRecord(copy)

      const copyOpened = Boolean(vm.techResolution[WARHEAD].unresolved)

      vm.openRecord(uuid)
      await vm.chooseNextTech(WARHEAD, NEXT_WARHEAD)
      await vm.saveRecord()
      vm.openRecord(uuid)

      const chosenAgain = { status: linkOf(uuid), unresolved: Boolean(vm.techResolution[WARHEAD].unresolved), damage: damage() }

      return linkedAtFirst === 'linked' && changedOnOpen.status === 'changed' && changedOnOpen.unresolved && changedOnOpen.damage !== hypothetical && renamed.status === 'changed' && renamed.unresolved && renamed.choice && renamed.damage === changedOnOpen.damage && pdChanged.status === 'changed' && pdChanged.unresolved && pdChanged.pd === '1' && asNew.other && asNew.status === 'changed' && copyOpened && chosenAgain.status === 'linked' && !chosenAgain.unresolved && chosenAgain.damage === hypothetical ? true : short([linkedAtFirst, changedOnOpen, renamed, pdChanged, asNew, copyOpened, chosenAgain, hypothetical])
    }],
    ['page: a saved design reported changed stays unresolved when the comparison is renamed or saved as a new one, and is linked again only when it is picked again', async () => {
      const { records } = await withRecords([payloadOf(m, 'Missiles', { alternatives: [{ ...m.md.savedAlternative(154602), key: 'alt-1' }] })])
      const vm = page({ records, baselineId: ORDINARY, alternatives: [], recordName: 'Missiles' })
      const repriced = { ...designs, fixture: { ...designs.fixture, designs: designs.fixture.designs.map((design) => (design.id === ORDINARY || design.id === 154602 ? { ...design, row: { ...design.row, Cost: Number(design.row.Cost) + 1 } } : design)) } }
      const statuses = (uuid) => vm.recordsRead.entries.find((item) => item.uuid === uuid).links.filter((link) => link.type === 'missile').map((link) => `${link.id}:${link.status}`).sort().join()
      const changed = [`${ORDINARY}:changed`, '154602:changed'].sort().join()

      const uuid = vm.recordsRead.entries[0].uuid
      const first = statuses(uuid)

      vm.designs = repriced
      vm.openRecord(uuid)

      const onOpen = statuses(uuid)

      vm.recordName = 'Renamed'
      await vm.saveRecord()
      vm.openRecord(uuid)

      const renamed = statuses(uuid)

      await vm.saveRecordAsNew()

      const copy = vm.recordOrigin
      const asNew = { other: copy !== uuid, status: statuses(copy) }

      vm.openRecord(uuid)
      vm.setBaseline(ORDINARY)
      await vm.saveRecord()

      const picked = statuses(uuid)

      return first === [`${ORDINARY}:linked`, '154602:linked'].sort().join() && onOpen === changed && renamed === changed && asNew.other && asNew.status === changed && picked === [`${ORDINARY}:linked`, '154602:changed'].sort().join() ? true : short([first, onOpen, renamed, asNew, picked])
    }],
    ['page: a tech choice kept with no link reads unresolved, stays unlinked when the comparison is renamed, and is linked only when the tech is chosen again, a researched level or a next tech', async () => {
      const hypothetical = { techId: NEXT_WARHEAD, name: 'Hypothetical warhead', kind: 'hypothetical' }
      const researched = { techId: RESEARCHED_WARHEAD, name: 'Researched warhead', kind: 'researched' }
      const outcomes = []

      for (const [choice, choose] of [[hypothetical, (vm) => vm.chooseNextTech(WARHEAD, NEXT_WARHEAD)], [researched, (vm) => vm.setTech(WARHEAD, RESEARCHED_WARHEAD)]]) {
        const { records } = await withRecords([payloadOf(m, 'No link', { tech: { choices: { [WARHEAD]: choice } } })])
        const vm = pageOver(techData(), { records, baselineId: ORDINARY, alternatives: [], recordName: 'No link' })

        const uuid = vm.recordsRead.entries[0].uuid
        const links = () => vm.recordsRead.entries.find((item) => item.uuid === uuid).links.filter((link) => link.type === 'tech').map((link) => link.status).join()

        vm.openRecord(uuid)

        const opened = vm.techResolution[WARHEAD].unresolved

        vm.recordName = 'Renamed'
        await vm.saveRecord()
        vm.openRecord(uuid)

        const renamed = { links: links(), unresolved: Boolean(vm.techResolution[WARHEAD].unresolved) }

        await choose(vm)
        await vm.saveRecord()
        vm.openRecord(uuid)

        const chosen = { links: links(), unresolved: Boolean(vm.techResolution[WARHEAD].unresolved) }

        outcomes.push({ kind: choice.kind, opened: Boolean(opened) && /could not be checked/.test(opened.reason), renamed, chosen })
      }

      return outcomes.every((item) => item.opened && item.renamed.links === '' && item.renamed.unresolved && item.chosen.links === 'linked' && !item.chosen.unresolved) ? true : short(outcomes)
    }],
    ['page: a researched level kept with a comparison is restored over the page, a hypothetical choice of the branch the comparison did not make is hidden, and opening writes no tech scenario', async () => {
      const { mem, records } = await withRecords()
      const vm = pageOver(techData(), { records, baselineId: ORDINARY, alternatives: [], recordName: 'Researched' })
      const figures = () => ({ damage: valueOf(vm.comparison.columns[1], 'damage'), cost: valueOf(vm.comparison.columns[1], 'cost'), source: vm.comparison.columns[1].source })

      vm.seedFromBaseline()
      await vm.setTech(WARHEAD, RESEARCHED_WARHEAD)

      const researched = figures()

      await vm.saveRecord()

      const uuid = vm.recordOrigin
      const saved = vm.recordsRead.entries[0].payload.tech.choices[WARHEAD]

      await vm.setTech(WARHEAD, PICK_WARHEAD)
      await vm.chooseNextTech(WARHEAD, NEXT_WARHEAD)

      const branch = vm.techScenario.selection[WARHEAD]
      const before = mem.writes()
      const hypothetical = figures()

      vm.openRecord(uuid)

      const restored = figures()

      return saved && saved.kind === 'researched' && saved.techId === RESEARCHED_WARHEAD && branch && hypothetical.source === 'hypothetical' && equal(vm.techChoice, { [WARHEAD]: RESEARCHED_WARHEAD }) && equal(restored, researched) && !vm.techResolution[WARHEAD].hypothetical && vm.techResolution[WARHEAD].level.id === RESEARCHED_WARHEAD && mem.writes() === before && Boolean(vm.techScenario.selection[WARHEAD]) ? true : short([saved, researched, hypothetical, restored, vm.techChoice, mem.writes() - before])
    }],
    ['page: an option asked for without its tech is named beside the option and on the column, the column shows no figure, and typing the figure clears it', () => {
      const vm = page({ baselineId: ORDINARY, alternatives: [] })

      vm.seedFromBaseline()

      const draft = vm.alternatives[0]
      const manual = { ...m.md.emptyManual(), engine: '20', fuel: '0.5', maxThrust: '3', warhead: '10', laserEfficiency: '' }

      vm.updateAlternative(draft.key, { ...draft, techMode: 'manual', manual, options: { eccm: false, terminal: false, retarget: false, laser: true } })

      const blocked = vm.draftBlocked[draft.key]
      const column = vm.comparison.columns[1]
      const summary = vm.summary

      vm.updateAlternative(draft.key, { ...vm.alternatives[0], manual: { ...manual, laserEfficiency: '0.5' } })

      return blocked.length === 1 && blocked[0].id === 'laser' && /Laser warhead/.test(blocked[0].reason) && equal(column.blocked, blocked) && column.withheld.length > 0 && valueOf(column, 'damage') === null && valueOf(column, 'cost') === null && /Not applied: Laser warhead/.test(summary) && vm.draftBlocked[draft.key].length === 0 && known(figureOf(vm.comparison.columns[1], 'damage')) ? true : short([blocked, column.withheld, valueOf(column, 'damage'), vm.draftBlocked[draft.key]])
    }],
  ]
}

const PAGE_MUTATIONS = [
  { name: 'the fourth alternative is accepted', find: 'const outcome = addAlternative(this.alternatives, entry)', replace: 'const outcome = { ok: true, list: [...this.alternatives, { ...entry, key: \'alt-\' + (this.alternatives.length + 1) }] }', fails: ['page: a design seeded from the baseline'] },
  { name: 'the name error is shown before the name is touched', find: 'return this.recordTouched && !this.recordName.trim()', replace: 'return !this.recordName.trim()', fails: ['page: the name of a comparison'] },
  { name: 'the PD field error is dropped', find: 'return pdProblem(this.pd)', replace: 'return \'\'', fails: ['page: a PD below 0'] },
  { name: 'a kept comparison is opened without its PD', find: 'this.pd = payload.scenario.pd', replace: 'this.pd = \'0\'', fails: ['page: a comparison is kept, opened again'] },
  { name: 'a stale save always writes over', find: '{ entry, payload, overwrite, tech: this.tech, carry', replace: '{ entry, payload, overwrite: true, tech: this.tech, carry', fails: ['page: a comparison changed elsewhere'] },
  { name: 'the jammer is kept under a key of the designer', find: 'key: \'missileHitJammer\'', replace: 'key: \'missileDesignerJammer\'', fails: ['page: the hit scenario fields'] },
  { name: 'the scenario of the page leaves out the target speed', find: 'targetSpeed: this.hitTargetSpeed,', replace: 'targetSpeed: \'10000\',', fails: ['page: the baseline and the alternatives are compared'] },
  { name: 'the copied summary is not the comparison shown', find: 'await navigator.clipboard.writeText(this.summary)', replace: 'await navigator.clipboard.writeText(\'\')', fails: ['page: the copied summary'] },
  { name: 'a comparison is opened without the tech it was kept with', find: 'this.restoreTech(entry)', replace: 'void entry', fails: ['page: a comparison is opened again with the tech', 'page: a researched level kept'] },
  { name: 'the tech of the page is not kept with a comparison', find: ', tech: techChoicesOf(this.techSelection, this.tech)', replace: '', fails: ['page: a comparison is opened again with the tech', 'page: a researched level kept'] },
  { name: 'the tech of a comparison is not linked to the save when it is kept', find: ', tech: this.tech, carry: [...techLinksOf(this.techSelection), ...this.linkCarry] }', replace: ' }', fails: ['page: a comparison is opened again with the tech'] },
  { name: 'a save links the choices to the open save and not to the links they were read with', find: 'carry: [...techLinksOf(this.techSelection), ...this.linkCarry] }', replace: 'carry: [] }', fails: ['page: a tech choice reported changed stays unresolved', 'page: a saved design reported changed stays unresolved', 'page: a tech choice kept with no link reads unresolved'] },
  { name: 'the links of the comparison that was opened are not kept for the next save', find: 'this.linkCarry = carryOf(entry.links, payload)', replace: 'void entry', fails: ['page: a saved design reported changed stays unresolved'] },
  { name: 'picking the baseline again does not release its link', find: 'this.releaseLink(\'missile\', this.baselineId)', replace: 'void 0', fails: ['page: a saved design reported changed stays unresolved'] },
  { name: 'choosing a researched level again does not release its link', find: 'this.releaseLink(\'tech\', id)', replace: 'void id', fails: ['page: a tech choice kept with no link reads unresolved'] },
  { name: 'a hypothetical choice of the branch stays when the comparison made none', find: '} else if (this.techScenario.selection[type]) {', replace: '} else if (false) {', fails: ['page: a researched level kept'] },
  { name: 'the options not applied are not given to the editor', find: '[column.key, column.blocked]', replace: '[column.key, []]', fails: ['page: an option asked for without its tech'] },
]

// ---------- the mutants of the utilities ----------

const MUTATIONS = [
  { name: 'a PD above the speed is worked out and goes negative', file: 'missile-designer.js', find: 'if (attenuation > speedValue) {', replace: 'if (false) {', fails: ['planner: a PD above the speed', 'planner: the figure is never negative'] },
  { name: 'a PD below 0 is accepted', file: 'missile-designer.js', find: 'return Number(value) < 0 ? \'The point-defence figure must be 0 or more\' : \'\'', replace: 'return \'\'', fails: ['planner: a PD below 0'] },
  { name: 'a missile that does not move is worked out', file: 'missile-designer.js', find: 'if (!(speedValue > 0)) {', replace: 'if (false) {', fails: ['planner: a missile with no speed'] },
  { name: 'the hit chance is not a fraction in the planner figure', file: 'missile-designer.js', find: 'values[\'hit chance\'] / 100', replace: 'values[\'hit chance\']', fails: ['planner: a PD of 0', 'planner: the hit chance comes from'] },
  { name: 'the overboost is measured against no limit', file: 'missile-designer.js', find: 'const free = missileEngineDesign({ sizeMsp, thrust, engineTech, fuelTech, maxThrust: Infinity })', replace: 'const free = missileEngineDesign({ sizeMsp, thrust, engineTech, fuelTech, maxThrust })', fails: ['engine: a missile engine above', 'engine: the fuel use of the overboost'] },
  { name: 'the greatest thrust modifier is read from a ship thrust limit', file: 'design-data.js', find: 'maxThrust: 130', replace: 'maxThrust: 198', fails: ['engine: a ship', 'engine: a designed engine takes'] },
  { name: 'a fourth alternative is added', file: 'missile-designer.js', find: 'if (list.length >= MAX_ALTERNATIVES) {', replace: 'if (false) {', fails: ['compare: a fourth alternative'] },
  { name: 'a fourth alternative is compared without a word', file: 'missile-designer.js', find: 'spec.alternatives.slice(MAX_ALTERNATIVES).map(', replace: '[].map(', fails: ['compare: a fourth alternative'] },
  { name: 'the baseline follows the first alternative', file: 'missile-designer.js', find: 'savedId: spec.baselineId }, scenario))', replace: 'savedId: (accepted[0] && accepted[0].savedId) || spec.baselineId }, scenario))', fails: ['compare: the baseline is pinned'] },
  { name: 'an option whose tech has no level is dropped without a word', file: 'missile-designer.js', find: 'blocked.push({ id: name, reason })', replace: 'void reason', fails: ['gating: an option asked for'] },
  { name: 'the fuel is not cut to a whole litre', file: 'design-rules.js', find: 'const ownFuel = floorExact(FUEL_LITRES_PER_MSP * fuelMsp)', replace: 'const ownFuel = FUEL_LITRES_PER_MSP * fuelMsp', fails: ['designed: fuel is cut'] },
  { name: 'a laser warhead is compared with the stored strength of the beam', file: 'missile-designer.js', find: 'const stored = definition.id === \'damage\' && row.LaserWarhead > 0 ? row.LaserWarhead : row[definition.saved]', replace: 'const stored = row[definition.saved]', fails: ['reconcile: a modified missile'] },
  { name: 'an unsupported figure counts as agreeing', file: 'missile-designer.js', find: '  if (unsupported) {\n    return \'unsupported\'\n  }', replace: '  if (unsupported) {\n    return \'agree\'\n  }', fails: ['reconcile: a figure that is unknown or unsupported', 'reconcile: a ground attack pod'] },
  { name: 'an unknown figure counts as agreeing', file: 'missile-designer.js', find: '  if (!known(stored) || !known(computed)) {\n    return \'unknown\'\n  }', replace: '  if (!known(stored) || !known(computed)) {\n    return \'agree\'\n  }', fails: ['reconcile: a figure that is unknown or unsupported', 'reconcile: a design whose engine'] },
  { name: 'a design the race owns but has not researched is imported', file: 'missile-designer.js', find: 'const known = owned.filter((row) => researched.has(row.MissileID))', replace: 'const known = owned', fails: ['owned: a design the race owns and has not researched'] },
  { name: 'the saved designs of a comparison are not linked', file: 'missile-designer.js', find: '[...missileLinks, ...techLinks].filter(Boolean)', replace: '[...techLinks].filter(Boolean)', fails: ['record: the saved designs a comparison names are links'] },
  { name: 'a tab that does not hold the file writes', file: 'missile-designer.js', find: 'if (!(await repository.writable(scope.campaignId))) {', replace: 'if (false) {', fails: ['record: a tab that does not hold the file'] },
  { name: 'a comparison is written with no campaign settled', file: 'missile-designer.js', find: '  if (!scope) {\n    return { ok: false, code: \'no-scope\'', replace: '  if (false) {\n    return { ok: false, code: \'no-scope\'', fails: ['record: no repository and no scope'] },
  { name: 'moving a comparison does not rebase it', file: 'missile-designer.js', find: '{ rebase: true }', replace: '{}', fails: ['record: a comparison made at a later game time'] },
  { name: 'a stale save is written over unasked', file: 'missile-designer.js', find: 'if (!overwrite) {', replace: 'if (false) {', fails: ['record: a stale save is refused'] },
  { name: 'the tech levels of the page are not kept in the choices', file: 'missile-designer.js', find: 'DESIGN_LINE_TYPES.filter((type) => selection && selection[type] && savedIdOk(selection[type].techId))', replace: '[].filter((type) => selection && selection[type] && savedIdOk(selection[type].techId))', fails: ['record: the tech levels chosen'] },
  { name: 'a researched level is kept as a hypothetical one', file: 'missile-designer.js', find: 'kind: selection[type].source === \'preference\' ? TECH_KINDS.RESEARCHED : TECH_KINDS.HYPOTHETICAL', replace: 'kind: TECH_KINDS.HYPOTHETICAL', fails: ['record: the tech levels chosen'] },
  { name: 'the payload of a comparison drops the tech chosen', file: 'missile-designer.js', find: 'tech: tech === null ? { choices: {} } : copyOf(tech) })', replace: 'tech: { choices: {} } })', fails: ['record: the payload keeps the inputs only'] },
  { name: 'the tech chosen is not linked to the tech of the save', file: 'missile-designer.js', find: '[...missileLinks, ...techLinks].filter(Boolean)', replace: '[...missileLinks].filter(Boolean)', fails: ['record: the tech levels chosen'] },
  { name: 'a save links every tech choice to the open save instead of keeping the links it was read with', file: 'missile-designer.js', find: 'const techLinks = Object.values(payload.tech.choices).map((choice) => linkOf(TECH_LINK_TYPE, choice.techId, techKnown[choice.techId]))', replace: 'const techLinks = Object.values(payload.tech.choices).map((choice) => (techKnown[choice.techId] ? { type: TECH_LINK_TYPE, id: choice.techId, row: techKnown[choice.techId] } : null))', fails: ['record: a save keeps the tech links it was read with', 'record: a tech choice kept with no link'] },
  { name: 'a save links every saved design to the open save instead of keeping the links it was read with', file: 'missile-designer.js', find: 'const missileLinks = idsOf(payload).map((id) => linkOf(MISSILE_LINK_TYPE, id, known[id]))', replace: 'const missileLinks = idsOf(payload).map((id) => ({ type: MISSILE_LINK_TYPE, id, row: known[id] }))', fails: ['record: a save keeps the links of the saved designs'] },
  { name: 'a choice kept with no link is linked to the open save by a save', file: 'missile-designer.js', find: 'return kept.fingerprint ? { type, id, fingerprint: kept.fingerprint } : null', replace: 'return kept.fingerprint ? { type, id, fingerprint: kept.fingerprint } : (row ? { type, id, row } : null)', fails: ['record: a tech choice kept with no link'] },
  { name: 'a tech choice with no link is not carried as one', file: 'missile-designer.js', find: '.filter((choice) => !stored.some((link) => link.type === TECH_LINK_TYPE && link.id === choice.techId))', replace: '.filter(() => false)', fails: ['record: a tech choice kept with no link'] },
  { name: 'a payload with a tech choice that is not valid is kept', file: 'missile-designer.js', find: 'problems.push(...techProblems(payload.tech))', replace: 'void techProblems', fails: ['record: a tech choice that is not'] },
  { name: 'a comparison of the earlier schema is not migrated', file: 'missile-designer.js', find: 'migrate: (payload, fromSchema) => (fromSchema < 2 ? { ...payload, tech: { choices: {} } } : payload),', replace: 'migrate: (payload) => payload,', fails: ['record: a comparison saved before'] },
  { name: 'a column with an option not applied still shows the figures of the design without it', file: 'missile-designer.js', find: 'withheld ? NO_FIGURE(DESIGNER_RULES.plannerFigure, withheld, definition.unit) : mark(figures[definition.id])', replace: 'mark(figures[definition.id])', fails: ['gating: a column with an option not applied', 'gating: a laser warhead asked for'] },
]

const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-missile-designer-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation does not apply to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

// ---------- the saves ----------

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['../AuroraDB_271_skoormit_saved.db', 138, 785], mutations: true, mutant: null, probe: null }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--run-mutant') {
      options.mutant = String(argv[++index])
    } else if (argv[index] === '--run-probe') {
      options.probe = String(argv[++index])
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({
      query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
        const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
        const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

        raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
      }),
      close: () => raw.close(),
    })
  })
})

// Opens the two saves the ownership checks read into SAVES; a save that is not there is left out.
const openSaves = async (options) => {
  const [moddedFile, moddedGame, moddedRace] = options.modded
  const [stockFile, stockGame, stockRace] = options.stock
  const modded = await openSave(moddedFile)
  const stock = await openSave(stockFile)

  if (modded) {
    SAVES.modded = { database: modded, ids: { GameID: moddedGame, RaceID: moddedRace } }
  }

  if (stock) {
    SAVES.stock = { database: stock, ids: { GameID: stockGame, RaceID: stockRace } }
  }

  return { moddedFile, stockFile, modded, stock }
}

const closeSaves = () => Object.values(SAVES).forEach((save) => save.database.close())

// ---------- the mutants, each in a process of its own ----------

const MUTANTS = [...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })), ...PAGE_MUTATIONS.map((mutation, index) => ({ kind: 'page', id: `page:${index}`, ...mutation }))]

const outcomeOf = (result) => (result === true ? { state: 'pass' } : isSkip(result) ? { state: 'skip', reason: result.skipped } : { state: 'fail', message: typeof result === 'string' ? result : 'false' })

// One planted fault, in this process: the checks it names (or the page statements it names) run against the mutated copy and each outcome is returned as 'pass', 'fail' or 'skip'; `absent` lists the names no check begins with. A fault that does not apply or does not load is `{ error }`.
const runMutant = async (id, real) => {
  const began = Date.now()
  const mutant = MUTANTS.find((entry) => entry.id === id)

  if (!mutant) {
    return { error: `no planted fault ${id}` }
  }

  const { kind, file, find, replace, fails } = mutant
  let directory = null

  try {
    let all

    if (kind === 'page') {
      all = await pageStatements(replacing(find, replace), real)
    } else {
      directory = mutatedCopy(file, find, replace)
      all = GROUPS(await loadAll(directory))
    }

    const named = all.filter(([checkName]) => fails.some((start) => checkName.startsWith(start)))
    const absent = fails.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))
    const outcomes = []

    for (const [checkName, test] of named) {
      outcomes.push([checkName, outcomeOf(await settle(test))])
    }

    return { absent, outcomes, seconds: (Date.now() - began) / 1000 }
  } catch (error) {
    return { error: error.message }
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const PROBE_RULE = 'probe.planted'

// What an isolation probe sees: the rules registered in the copy of the utilities it loads as a mutant does and in the real ones. The `plant` probe registers a rule in the copy first.
const runProbe = async (mode) => {
  const real = await loadAll()
  const directory = mutatedCopy('missile-designer.js', 'export const MAX_ALTERNATIVES = 3', 'export const MAX_ALTERNATIVES = 3')

  try {
    const copied = await loadAll(directory)

    if (mode === 'plant') {
      copied.pv.registerRule({ id: PROBE_RULE, versions: ['1'], note: 'A rule planted by the isolation probe', verification: 'assumed' })
    }

    return { copyRules: copied.pv.listRules().map((rule) => rule.id), realRules: real.pv.listRules().map((rule) => rule.id) }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// A child of this script, its last line of output read as JSON. A child that dies with no result did not run.
const inChild = async (argv) => {
  const { code, stdout, stderr } = await runChild(__filename, argv)

  try {
    return JSON.parse(stdout.trim().split('\n').pop())
  } catch {
    return { error: `the process exited with ${code} and no result: ${(stderr || stdout).trim().slice(0, 400)}` }
  }
}

const forwardedSaves = (options) => ['--modded', ...options.modded.map(String), '--stock', ...options.stock.map(String)]

// Every planted fault in a process of its own, as many at a time as the pool allows, results printed in the order of the list. The loader of the utilities imports modules from data URLs made of their source, so two copies of an unchanged module in one process are one module with one registry of provenance rules: a fault that registered something would reach the checks and the faults that follow it.
const runMutants = async (options) => {
  const results = await inParallel(MUTANTS, (mutant) => inChild(['--run-mutant', mutant.id, ...forwardedSaves(options)]), jobs())

  results.forEach((result, index) => {
    if (result instanceof Error) {
      results[index] = { error: result.message }
    }
  })

  MUTANTS.forEach(({ kind, name, fails }, index) => {
    const { error, absent, outcomes, seconds } = results[index]
    const label = kind === 'page' ? `page mutation caught: ${name}` : `mutation caught: ${name}`
    const noun = kind === 'page' ? 'statements' : 'checks'

    if (error) {
      check(label, `does not load: ${error}`)

      return
    }

    const own = (start) => outcomes.filter(([checkName]) => checkName.startsWith(start))
    const status = (start) => (own(start).every(([, outcome]) => outcome.state === 'skip') ? 'skipped' : own(start).some(([, outcome]) => outcome.state === 'fail') ? 'failed' : 'missed')
    const failed = outcomes.filter(([, outcome]) => outcome.state === 'fail').map(([checkName]) => checkName)
    const missed = fails.filter((start) => !absent.includes(start) && status(start) === 'missed')
    const detail = `${failed.length} of the ${noun} it names fail, ${seconds.toFixed(1)} s`

    if (!absent.length && fails.every((start) => status(start) === 'skipped')) {
      check(label, skipped('the checks it names read a save that is not there'), detail)
    } else {
      check(label, absent.length ? `no ${kind === 'page' ? 'statement' : 'check'} begins ${absent.join('; ')}` : missed.length ? `these ${noun} did not fail: ${missed.join('; ')}` : true, detail)
    }
  })
}

// A rule planted by one process is in no other: the first probe registers a rule in its copy of the utilities, the second (a process of its own, as each mutant is) loads the same and must not have it, and neither the real utilities of either probe nor those of this process have it.
const checkIsolation = async (real, options) => {
  const [planted, later] = await Promise.all([inChild(['--run-probe', 'plant', ...forwardedSaves(options)]), inChild(['--run-probe', 'read', ...forwardedSaves(options)])])

  if (planted.error || later.error) {
    return `a probe did not run: ${planted.error || later.error}`
  }

  const mine = real.pv.listRules().map((rule) => rule.id)

  return planted.copyRules.includes(PROBE_RULE) && !later.copyRules.includes(PROBE_RULE) && !later.realRules.includes(PROBE_RULE) && !mine.includes(PROBE_RULE) && planted.pid !== process.pid && later.pid !== process.pid && planted.pid !== later.pid ? true : short({ planted, later, mine: mine.includes(PROBE_RULE), pid: process.pid })
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.mutant !== null || options.probe !== null) {
    await openSaves(options)

    const result = options.probe !== null ? await runProbe(options.probe) : await runMutant(options.mutant, options.mutant.startsWith('page:') ? await loadAll() : null)

    closeSaves()
    console.log(JSON.stringify({ pid: process.pid, ...result }))
    process.exit(0)
  }

  const real = await loadAll()
  const { moddedFile, stockFile, modded, stock } = await openSaves(options)

  console.log(`Saves read by the ownership checks: modded ${modded ? moddedFile : `${moddedFile} (not there)`}, stock ${stock ? stockFile : `${stockFile} (not there)`}`)

  console.log('The missile designer: units, reconciliation, designs, engine, planner figure, comparison, sources, gating, ownership and the record')

  for (const [name, test, detail] of GROUPS(real)) {
    check(name, await settle(test), detail)
  }

  console.log('\nThe page (its script on a pseudo instance, scripts/lib/page-loader.js)')

  for (const [statement, held] of await pageStatements(null, real)) {
    check(statement, await settle(held))
  }

  if (options.mutations) {
    console.log('\nMutations: each must fail the checks it names, each in a process of its own')

    check('isolation: a rule planted by one mutant process is not in the checks, the real utilities or the next mutant', await checkIsolation(real, options))
    await runMutants(options)
  }

  closeSaves()

  console.log(`\n${checks - failures} of ${checks} checks passed${skips ? `, ${skips} skipped (the save they read is not there)` : ''}`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
