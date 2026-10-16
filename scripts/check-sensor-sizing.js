/*
  Checks the sensor and fire control sizing of the planner (utilities/sensor-planner.js), the tech lines it reads (utilities/race-tech.js) and the loaders of the saved designs (utilities/design-data.js `ownedActiveSensors`, `ownedBeamFireControls`). The rules behind it are in utilities/design-rules.js; docs/plans/planners/sensor-fire-control.md states the planner.

  bun scripts/check-sensor-sizing.js [--no-mutations]

  Groups (each check's name begins with its group):
  - pair: a search sensor and a missile fire control sized at every legal resolution, each member the smallest legal size that reaches the wanted range (the next smaller size falls short) against the target's cross-section, the resolution cut and a jammer; the totals, the reach of the pair as the shorter member, the best row (the fewest BP, then the fewest HS, then the higher resolution, a tie included), the resolution chosen, and an unknown target, range, jammer or tech giving an unavailable figure, never 0;
  - limiting: the member of a saved pair that falls short (and the one that is shorter when both do), a pair that meets and one with no target naming none, the alternative proposed at the saved resolution or the best overall, and the member of a sizing row that is beyond the largest size;
  - minerals: the hardening is the Uridium and the ECCM the Corbomite of each level pair, the Uridium does not move with the ECCM, and the stored Uridium, cost and Corbomite of the saved active sensors rebuilt through the levels of the module;
  - research: the planner's tech lines are registered tech types, a candidate is never researched, a hypothetical level marks the figures built on it and only those, an unresolved choice designs with the pick, a line with no level is unavailable, and the single weapon switch is offered only for a researched or chosen level;
  - beam: the range and the tracking axes sized apart, the range cap, a single weapon control against an unrestricted one, the table of designs, and a saved control's limiting axis;
  - target: a size in tons, a missile and a saved class as the target, the floor of 0.3 HS, the cloak as a second scenario, and a blank or unreadable size unavailable;
  - loaders: the active sensors and the beam fire controls read as stored for the race and the game, a save without an optional column giving null figures, one without a required column refused by name, and the obsolete flag read only when the save has it;
  - saves: the saved sensors and beam fire controls of every save in saves/ rebuilt from the tech levels of the module (read-only), the saved sensors sized at their own size and the beam controls of one modded save pinned; a save that is not there is reported as skipped, never as passed.

  Mutations: each deliberate fault planted in the source of a module (the module is loaded from its text, scripts/lib/utilities.js, with a registry of provenance rules of its own, so no fault reaches another) runs the checks it names and must fail them. Prints `N of N checks passed`; exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const savesDirectory = path.join(root, 'saves')
const MODULES = ['sensor-planner', 'design-rules', 'design-data', 'race-tech', 'tech-scenarios', 'provenance', 'signatures']

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

// ---------- the modules, as they ship or with one fault planted ----------

const texts = new Map()
let planted = 0

// The modules from their source; with a `mutation` { file, find, replace } the fault is planted in that file (`find` must occur once) and the provenance module is loaded from a text of its own, so the fault's copy of every module registers its rules in a registry that no other load shares.
const loadAll = async (mutation = null) => {
  const sources = {}

  if (mutation) {
    sources[mutation.file.replace(/\.js$/, '')] = patched(mutation.file, fs.readFileSync(path.join(utilitiesDirectory, mutation.file), 'utf8'), mutation.find, mutation.replace)
    sources.provenance = `${fs.readFileSync(path.join(utilitiesDirectory, 'provenance.js'), 'utf8')}\n// planted fault ${++planted}\n`
  }

  const loaded = await loadUtilities(MODULES, { sources, texts, stubs: STUBS })

  return { sp: loaded['sensor-planner'], dr: loaded['design-rules'], dd: loaded['design-data'], rt: loaded['race-tech'], ts: loaded['tech-scenarios'], pv: loaded.provenance }
}

// ---------- helpers ----------

const close = (actual, expected, message, tolerance = 1e-9) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} is not ${expected}`)

const unknown = (result, message) => {
  assert.equal(result.status, 'unavailable', message)
  assert.equal(result.value, null, message)
  assert.ok(result.inputs.missing.length > 0, `${message}: the result names no missing input`)
}

const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))

const roundTenth = (value) => Math.round(value * 10) / 10

const checks = []
const check = (name, run) => checks.push({ name, run })

const skipped = (reason) => ({ skipped: reason })

// ---------- the synthetic race ----------

const RACE = 7

const researchedRow = (id, typeId, name, cost, info, info2 = null) => ({ TechSystemID: id, GameID: 0, TechTypeID: typeId, Name: name, ComponentName: name, AdditionalInfo: info, AdditionalInfo2: info2, DevelopCost: cost })

const catalogueRow = (id, typeId, name, cost, info, extra = {}) => ({ TechSystemID: id, GameID: 0, Name: name, ComponentName: name, TechDescription: '', DevelopCost: cost, RaceID: 0, Prerequisite1: 0, Prerequisite2: 0, RuinOnly: 0, AutomaticResearch: 0, StartingSystem: 0, ConventionalSystem: 0, TechTypeID: typeId, AdditionalInfo: info, AdditionalInfo2: null, TypeName: `Type ${typeId}`, FieldID: 1, ...extra })

const level = (id, type, name, cost, info, info2, researched, prerequisite = 0) => ({ id, type, name, cost, info, info2, researched, prerequisite })

const STRENGTH = 20
const EM = 125
const THERMAL = 19
const HARDENING = 139
const ECCM = 83
const DISTANCE = 4
const SPEED = 5
const SINGLE = 268

// The race: strength 16 per HS, EM 8, hardening 50 at a cost factor of 1.25, ECCM 1 at 1.1, a distance rating of 64,000 km and a speed rating of 4,000 km/s, the multi-weapon control; each line also has one level to research.
const LEVELS = [
  level(2001, STRENGTH, 'Strength 10', 100, 10, null, true),
  level(2002, STRENGTH, 'Strength 16', 300, 16, null, true),
  level(2003, STRENGTH, 'Strength 24', 600, 24, null, false, 2002),
  level(2011, EM, 'EM 8', 100, 8, null, true),
  level(2012, EM, 'EM 12', 300, 12, null, false, 2011),
  level(2021, THERMAL, 'Thermal 8', 100, 8, null, true),
  level(2031, HARDENING, 'Hardening 100', 100, 100, 1, true),
  level(2032, HARDENING, 'Hardening 50', 300, 50, 1.25, true),
  level(2033, HARDENING, 'Hardening 25', 600, 25, 1.6, false, 2032),
  level(2041, ECCM, 'ECCM 0', 100, 0, 1, true),
  level(2042, ECCM, 'ECCM 1', 300, 1, 1.1, true),
  level(2043, ECCM, 'ECCM 2', 600, 2, 1.2, false, 2042),
  level(2051, DISTANCE, 'Distance 64000', 100, 64000, null, true),
  level(2052, DISTANCE, 'Distance 128000', 300, 128000, null, false, 2051),
  level(2061, SPEED, 'Speed 4000', 100, 4000, null, true),
  level(2062, SPEED, 'Speed 8000', 300, 8000, null, false, 2061),
  level(2071, SINGLE, 'Multi-Weapon Fire Control', 1, 1, null, true),
  level(2072, SINGLE, 'Single-Weapon Fire Control', 2, 0.5, null, false, 2071),
]

const without = (levels, ...types) => levels.filter((item) => !types.includes(item.type))

const replaced = (levels, type, ...rows) => [...without(levels, type), ...rows]

const researchedAlso = (levels, ...ids) => levels.map((item) => (ids.includes(item.id) ? { ...item, researched: true } : item))

const buildTech = (m, levels = LEVELS) => {
  const researched = levels.filter((item) => item.researched)
  const raw = m.rt.buildRaceTech(researched.map((item) => researchedRow(item.id, item.type, item.name, item.cost, item.info, item.info2)))
  const catalogue = levels.map((item) => catalogueRow(item.id, item.type, item.name, item.cost, item.info, { AdditionalInfo2: item.info2, Prerequisite1: item.prerequisite }))

  return m.ts.withCandidates(raw, { catalogue, raceId: RACE, researched: researched.map((item) => item.id), eligible: [], projects: [], queued: [], paused: [] })
}

// The tech, its resolution of the choices ({ [typeId]: techId } as a record's scenario choices) and the planner's tech.
const planOf = (m, { levels = LEVELS, choices = {} } = {}) => {
  const tech = buildTech(m, levels)
  const resolution = m.ts.resolveChoices(tech, Object.fromEntries(Object.entries(choices).map(([typeId, techId]) => [typeId, { techId, source: 'scenario' }])))

  return { tech, resolution, st: m.sp.sensorTechOf(tech, resolution) }
}

const tonsTarget = (m, tons) => m.sp.targetOf({ kind: 'tons', tons })

// ---------- the rules, written out ----------

const SIZES = (m) => m.dr.SENSOR_SIZES_HS

const signatureHS = (tons) => Math.max(tons / 50, 0.3)

// The range of a sensor at a size: the square root of the strength times the EM sensitivity times the resolution to 2/3 over pi (3.1416), in millions of km, doubled for a fire control.
const maximumRange = (sizeHS, resolution, fireControl, strengthTech = 16, emTech = 8) => Math.sqrt(strengthTech * sizeHS * emTech * resolution ** (2 / 3) / 3.1416) * 1e6 * (fireControl ? 2 : 1)

const effectiveRange = ({ sizeHS, resolution, fireControl, signature, jammer, eccm = 1, strengthTech, emTech }) => maximumRange(sizeHS, resolution, fireControl, strengthTech, emTech) * (signature < resolution ? (signature / resolution) ** 2 : 1) * (jammer > eccm ? 0.75 ** (jammer - eccm) : 1)

const meetsRange = (range, wanted) => range >= wanted * (1 - 1e-9)

const costOf = (sizeHS) => roundTenth(sizeHS * 16 * 1.25) * 1.1

// ---------- pair ----------

const TARGETS_TONS = [50, 250, 2000, 20000]
const WANTED = [1e6, 5e6, 2e7, 1e8]
const JAMMERS = [0, 2, 5]

check('pair: each member is the smallest legal size that reaches the wanted range, the next smaller size falls short', (m) => {
  const { st } = planOf(m)
  const sizes = SIZES(m)
  let feasibleRows = 0
  let shortRows = 0

  for (const tons of TARGETS_TONS) {
    for (const wanted of WANTED) {
      for (const jammer of JAMMERS) {
        const sizing = m.sp.activeSizing({ target: tonsTarget(m, tons), wantedRangeKm: wanted, jammer, tech: st })

        assert.equal(sizing.rows.length, m.dr.SENSOR_RESOLUTIONS_HS.length, 'a row for every legal resolution')

        for (const row of sizing.rows) {
          const failing = []

          for (const [key, member, fireControl] of [['search', row.search, false], ['fireControl', row.fireControl, true]]) {
            const label = `${tons} t, ${wanted} km, jammer ${jammer}, resolution ${row.resolution}, ${key}`
            const reachOf = (sizeHS) => effectiveRange({ sizeHS, resolution: row.resolution, fireControl, signature: signatureHS(tons), jammer })

            if (member.sizeHS === null) {
              failing.push(key)
              assert.ok(!meetsRange(reachOf(sizes[sizes.length - 1]), wanted), `${label}: the largest size reaches the range, yet no size is given`)
              unknown(member.size, `${label}: size`)
              continue
            }

            const index = sizes.indexOf(member.sizeHS)

            assert.ok(index >= 0, `${label}: ${member.sizeHS} HS is not a legal size`)
            assert.ok(meetsRange(reachOf(member.sizeHS), wanted), `${label}: ${member.sizeHS} HS does not reach the range`)
            close(member.reach.value, reachOf(member.sizeHS), `${label}: reach`, 1e-6)
            assert.equal(member.size.value, member.sizeHS, `${label}: the size figure`)

            if (index > 0) {
              assert.ok(!meetsRange(reachOf(sizes[index - 1]), wanted), `${label}: ${sizes[index - 1]} HS also reaches the range`)
            }
          }

          assert.deepEqual(row.failing, failing, `${tons} t, ${wanted} km, jammer ${jammer}, resolution ${row.resolution}: the members beyond the largest size`)
          assert.equal(row.feasible, failing.length === 0)
          feasibleRows += row.feasible ? 1 : 0
          shortRows += row.feasible ? 0 : 1
        }
      }
    }
  }

  assert.ok(feasibleRows > 1000 && shortRows > 100, `the grid holds ${feasibleRows} feasible and ${shortRows} infeasible rows`)

  return { lines: [`${feasibleRows} feasible and ${shortRows} infeasible pairs over ${TARGETS_TONS.length * WANTED.length * JAMMERS.length} requests, each member against the literal range`] }
})

check('pair: the fire control of a pair reaches twice the range of a search sensor of its size, so it is smaller', (m) => {
  const { st } = planOf(m)
  const sizing = m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, resolution: 5, tech: st })
  const row = sizing.selected

  assert.equal(row.resolution, 5)
  assert.ok(row.feasible)
  assert.ok(row.fireControl.sizeHS < row.search.sizeHS, `${row.fireControl.sizeHS} is not under ${row.search.sizeHS}`)
  assert.equal(row.search.mode, 'search')
  assert.equal(row.fireControl.mode, 'missileFireControl')
  close(row.fireControl.design.value.rangeKm, 2 * row.fireControl.design.value.searchRangeKm, 'a fire control design', 1e-12)
  close(row.fireControl.design.value.rangeKm, maximumRange(row.fireControl.sizeHS, 5, true), 'the range of the fire control design', 1e-6)
})

check('pair: a jammer is cut by 0.75 to the jammer less the ECCM, one at or under the ECCM and a blank one count for nothing', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 250)
  const bare = m.sp.activeSizing({ target, wantedRangeKm: 1e7, jammer: 0, tech: st })

  assert.equal(st.eccm.info, 1)

  for (const same of [1, '', null, undefined, '  ', '0', '1']) {
    const sizing = m.sp.activeSizing({ target, wantedRangeKm: 1e7, jammer: same, tech: st })

    assert.deepEqual(sizing.rows.map((row) => [row.search.sizeHS, row.fireControl.sizeHS]), bare.rows.map((row) => [row.search.sizeHS, row.fireControl.sizeHS]), `a jammer of ${JSON.stringify(same)}`)
  }

  const jammed = m.sp.activeSizing({ target, wantedRangeKm: 1e7, jammer: 2, tech: st })
  const text = m.sp.activeSizing({ target, wantedRangeKm: 1e7, jammer: '2', tech: st })
  const resolution = jammed.rows.find((row) => row.resolution === 4)
  const baseRow = bare.rows.find((row) => row.resolution === 4)

  assert.deepEqual(text.rows.map((row) => row.search.sizeHS), jammed.rows.map((row) => row.search.sizeHS))
  assert.ok(resolution.search.sizeHS > baseRow.search.sizeHS, 'the jammer asks for a larger sensor')
  close(resolution.search.sizeHS / baseRow.search.sizeHS, 1 / 0.75 ** 2, 'the size ratio of one point of jammer over the ECCM', 0.06)
  assert.equal(jammed.request.jammer, 2)
  unknown(m.sp.activeSizing({ target, wantedRangeKm: 1e7, jammer: 'abc', tech: st }).tiles.sizeNeeded, 'an unreadable jammer')
  assert.ok(m.dr.SENSOR_JAMMER_BASE === 0.75)
})

check('pair: the totals are the sums of the members and the reach of the pair is the shorter member', (m) => {
  const { st } = planOf(m)
  const sizing = m.sp.activeSizing({ target: tonsTarget(m, 2000), wantedRangeKm: 2e7, resolution: 10, tech: st })
  const row = sizing.selected

  assert.ok(row.feasible)
  close(row.totalHS.value, row.search.sizeHS + row.fireControl.sizeHS, 'the size of the pair')
  close(row.search.cost.value, costOf(row.search.sizeHS), 'the cost of the search sensor')
  close(row.fireControl.cost.value, costOf(row.fireControl.sizeHS), 'the cost of the fire control')
  close(row.totalCost.value, costOf(row.search.sizeHS) + costOf(row.fireControl.sizeHS), 'the cost of the pair')
  close(row.reach.value, Math.min(row.search.reach.value, row.fireControl.reach.value), 'the reach of the pair')
  assert.ok(row.search.reach.value !== row.fireControl.reach.value, 'the members reach alike, so the shorter is not told')
  assert.equal(sizing.tiles.rangeReached.value, row.reach.value)
  assert.equal(sizing.tiles.sizeNeeded.value, row.totalHS.value)
  assert.equal(sizing.tiles.cost.value, row.totalCost.value)
  assert.equal(row.search.design.value.uridium, roundTenth(row.search.sizeHS * 16 * 1.25))
  assert.equal(row.search.design.value.eccm, 1)
  assert.equal(row.search.design.value.ctd, 50)
})

check('pair: the best row is the cheapest pair, then the smaller, then the one of the higher resolution, a tie included', (m) => {
  const { st } = planOf(m)
  let ties = 0

  for (const [tons, wanted, jammer] of [[250, 2e7, 0], [250, 1e6, 0], [20000, 1e8, 2], [50, 5e6, 0], [2000, 1e6, 5]]) {
    const sizing = m.sp.activeSizing({ target: tonsTarget(m, tons), wantedRangeKm: wanted, jammer, tech: st })
    const feasible = sizing.rows.filter((row) => row.feasible).map((row) => ({ row, cost: costOf(row.search.sizeHS) + costOf(row.fireControl.sizeHS), size: row.search.sizeHS + row.fireControl.sizeHS }))
    const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))
    const cheapest = Math.min(...feasible.map((entry) => entry.cost))
    const cheap = feasible.filter((entry) => same(entry.cost, cheapest))
    const smallest = Math.min(...cheap.map((entry) => entry.size))
    const tied = cheap.filter((entry) => same(entry.size, smallest))
    const expected = tied.reduce((best, entry) => (entry.row.resolution > best.row.resolution ? entry : best), tied[0])

    assert.ok(feasible.length > 0, `${tons} t at ${wanted} km: no feasible row`)
    assert.equal(sizing.best.resolution, expected.row.resolution, `${tons} t at ${wanted} km, jammer ${jammer}: the best resolution`)
    assert.equal(sizing.selected.resolution, expected.row.resolution)
    assert.equal(sizing.rows.filter((row) => row.best).length, 1)
    assert.equal(sizing.bestBasis, 'cost')
    assert.equal(sizing.tiles.bestResolution.value, expected.row.resolution)
    close(sizing.best.totalCost.value, expected.cost, `${tons} t at ${wanted} km: the cost of the best row`)
    close(sizing.best.totalHS.value, expected.size, `${tons} t at ${wanted} km: the size of the best row`)
    ties += tied.length > 1 ? 1 : 0
  }

  assert.ok(ties >= 2, 'the scenarios hold no tie between resolutions')
})

check('pair: the resolution chosen selects its row, one off the design window or unreadable is a problem, not a guess', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 250)
  const chosen = m.sp.activeSizing({ target, wantedRangeKm: 2e7, resolution: 20, tech: st })

  assert.equal(chosen.selected.resolution, 20)
  assert.equal(chosen.rows.filter((row) => row.selected).length, 1)
  assert.deepEqual(chosen.problems, [])
  assert.notEqual(chosen.best.resolution, 20, 'the best resolution is the chosen one, so the check chooses nothing')

  for (const [bad, expected] of [[106, '106'], [21, '21'], [0, '0'], ['abc', 'not chosen'], ['', 'not chosen']]) {
    const sizing = m.sp.activeSizing({ target, wantedRangeKm: 2e7, resolution: bad, tech: st })

    assert.equal(sizing.selected, null, `resolution ${JSON.stringify(bad)}`)
    assert.ok(sizing.problems.some((problem) => problem.includes(expected)), `resolution ${JSON.stringify(bad)}: ${sizing.problems.join('; ')}`)
    unknown(sizing.tiles.sizeNeeded, `the tile of resolution ${JSON.stringify(bad)}`)
  }

  assert.equal(m.sp.activeSizing({ target, wantedRangeKm: 2e7, resolution: '20', tech: st }).selected.resolution, 20)
})

check('pair: an unknown target, wanted range, jammer or tech line gives unavailable figures with what is missing, never 0', (m) => {
  const { st } = planOf(m)

  for (const [label, request] of [
    ['a blank target', { target: tonsTarget(m, ''), wantedRangeKm: 1e7, tech: st }],
    ['a target of no size', { target: tonsTarget(m, 0), wantedRangeKm: 1e7, tech: st }],
    ['no target', { wantedRangeKm: 1e7, tech: st }],
    ['a blank wanted range', { target: tonsTarget(m, 250), wantedRangeKm: '', tech: st }],
    ['a wanted range of 0', { target: tonsTarget(m, 250), wantedRangeKm: 0, tech: st }],
    ['an unreadable wanted range', { target: tonsTarget(m, 250), wantedRangeKm: 'far', tech: st }],
    ['no wanted range', { target: tonsTarget(m, 250), tech: st }],
    ['no tech', { target: tonsTarget(m, 250), wantedRangeKm: 1e7 }],
    ['no strength tech', { target: tonsTarget(m, 250), wantedRangeKm: 1e7, tech: planOf(m, { levels: without(LEVELS, STRENGTH) }).st }],
    ['no EM tech', { target: tonsTarget(m, 250), wantedRangeKm: 1e7, tech: planOf(m, { levels: without(LEVELS, EM) }).st }],
  ]) {
    const sizing = m.sp.activeSizing(request)

    assert.equal(sizing.best, null, label)
    assert.equal(sizing.bestBasis, null, label)
    assert.ok(sizing.rows.every((row) => !row.feasible && row.totalHS.status === 'unavailable'), label)

    for (const tile of Object.values(sizing.tiles)) {
      unknown(tile, `${label}: a tile`)
    }
  }

  const noHardening = m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, tech: planOf(m, { levels: without(LEVELS, HARDENING) }).st })

  assert.equal(noHardening.bestBasis, 'size', 'the best of a pair that has no cost is the smallest')
  assert.ok(noHardening.best.feasible)
  assert.ok(noHardening.rows.filter((row) => row.feasible).every((row) => row.totalCost.status === 'unavailable'))
  unknown(noHardening.tiles.cost, 'the cost with no hardening tech')
  assert.ok(noHardening.tiles.sizeNeeded.value > 0)
})

// ---------- limiting ----------

// A saved sensor of the loader's shape, its range, resolution and ECCM as stored.
const saved = (rangeKm, resolution = 10, eccm = 0, extra = {}) => ({ id: 1, name: 'Saved', rangeKm, resolution, eccm, ...extra })

check('limiting: a saved pair names the member that falls short, and the shorter when both do', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 1000)
  const cases = [
    ['the search sensor falls short', saved(1e7), saved(4e7), 'search'],
    ['the fire control falls short', saved(3e7), saved(1e7), 'fireControl'],
    ['both fall short, the search sensor shorter', saved(5e6), saved(8e6), 'search'],
    ['both fall short, the fire control shorter', saved(8e6), saved(5e6), 'fireControl'],
  ]

  for (const [label, search, fireControl, limiting] of cases) {
    const check = m.sp.savedPairCheck({ search, fireControl, target, wantedRangeKm: 2e7, tech: st })

    assert.equal(check.meets, false, label)
    assert.equal(check.limiting, limiting, label)
    close(check.reach.value, Math.min(check.search.reach.value, check.fireControl.reach.value), `${label}: the reach of the pair`)
  }

  const one = m.sp.savedPairCheck({ search: saved(1e7), fireControl: saved(4e7), target, wantedRangeKm: 2e7, tech: st })

  close(one.search.reach.value, 1e7, 'a target at the resolution is no cut')
  assert.equal(one.search.meets, false)
  assert.equal(one.fireControl.meets, true)
})

check('limiting: a pair that meets and one with an unknown target or range name no limiting member', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 1000)
  const meets = m.sp.savedPairCheck({ search: saved(3e7), fireControl: saved(6e7), target, wantedRangeKm: 2e7, tech: st })

  assert.equal(meets.meets, true)
  assert.equal(meets.limiting, null)

  for (const [label, request] of [['a blank target', { target: tonsTarget(m, ''), wantedRangeKm: 2e7 }], ['a blank wanted range', { target, wantedRangeKm: '' }]]) {
    const unknownPair = m.sp.savedPairCheck({ search: saved(1e7), fireControl: saved(4e7), tech: st, ...request })

    assert.equal(unknownPair.meets, null, label)
    assert.equal(unknownPair.limiting, null, label)
  }

  const noFireControl = m.sp.savedPairCheck({ search: saved(3e7), target, wantedRangeKm: 2e7, tech: st })

  assert.equal(noFireControl.fireControl, null)
  unknown(noFireControl.reach, 'the reach of a pair with no fire control')
})

check('limiting: the alternative is proposed at the saved resolution, else the best overall, else none', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 1000)
  const request = (wantedRangeKm, resolution) => m.sp.savedPairCheck({ search: saved(1e7, resolution), fireControl: saved(4e7, resolution), target, wantedRangeKm, tech: st })
  const atSaved = request(2e7, 10)
  const overall = request(1e8, 10)
  const none = request(2e8, 10)

  assert.equal(atSaved.alternative.basis, 'saved resolution')
  assert.equal(atSaved.alternative.row.resolution, 10)
  assert.ok(atSaved.alternative.row.feasible)
  assert.equal(overall.alternative.basis, 'best overall')
  assert.notEqual(overall.alternative.row.resolution, 10)
  assert.equal(overall.alternative.row, overall.alternative.sizing.best)
  assert.equal(none.alternative.basis, null)
  assert.equal(none.alternative.row, null)
})

check('limiting: a row of the sizing names the member beyond the largest size, and the search sensor when both are', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 1000)
  const onlySearch = m.sp.activeSizing({ target, wantedRangeKm: 2e8, resolution: 20, tech: st }).selected
  const both = m.sp.activeSizing({ target, wantedRangeKm: 3e8, resolution: 20, tech: st }).selected
  const feasible = m.sp.activeSizing({ target, wantedRangeKm: 2e7, resolution: 20, tech: st }).selected

  assert.equal(onlySearch.feasible, false)
  assert.deepEqual(onlySearch.failing, ['search'])
  assert.equal(onlySearch.limiting, 'search')
  assert.notEqual(onlySearch.fireControl.sizeHS, null, 'the fire control reaches twice as far')
  assert.ok(effectiveRange({ sizeHS: 50, resolution: 20, fireControl: false, signature: 20, jammer: 0 }) < 2e8)
  assert.ok(effectiveRange({ sizeHS: 50, resolution: 20, fireControl: true, signature: 20, jammer: 0 }) >= 2e8)
  assert.deepEqual(both.failing, ['search', 'fireControl'])
  assert.equal(both.limiting, 'search')
  assert.deepEqual(feasible.failing, [])
  assert.equal(feasible.limiting, null)
  unknown(onlySearch.search.reach, 'the reach of a member beyond the largest size')
  unknown(onlySearch.totalHS, 'the size of a pair with a member beyond the largest size')
})

// A missile target is seen by a search sensor as max(size in MSP / 20, 0.3) HS and by a missile fire control as max(size in MSP, 0.33), and no jammer applies to either (docs/plans/planners/mechanics-sensors.md).
const searchSignatureOfMissile = (msp) => Math.max(msp / 20, 0.3)

const fireControlSignatureOfMissile = (msp) => Math.max(msp, 0.33)

check('pair: against a missile target both members are sized with no jammer, the fire control by the size of the missile in MSP, the search sensor by the size over 20, each the smallest legal size, the same whatever the jammer', (m) => {
  const { st } = planOf(m)
  const sizes = SIZES(m)
  let rows = 0

  for (const msp of [0.1, 6, 20, 40, 200, 2000]) {
    for (const wanted of [1e5, 1e6, 1e7, 1e8]) {
      for (const jammer of [0, 3]) {
        const target = m.sp.targetOf({ kind: 'missile', msp })
        const sizing = m.sp.activeSizing({ target, wantedRangeKm: wanted, jammer, tech: st })
        const bare = m.sp.activeSizing({ target, wantedRangeKm: wanted, jammer: 0, tech: st })

        assert.equal(sizing.request.signature.value, searchSignatureOfMissile(msp))
        assert.equal(sizing.request.fireControlSignature.value, fireControlSignatureOfMissile(msp))
        assert.equal(sizing.request.searchJammer, 0)
        assert.equal(sizing.request.fireControlJammer, 0)
        assert.equal(sizing.request.jammer, jammer, 'the typed jammer is kept in the request, though no member is set against it')

        for (const row of sizing.rows) {
          for (const [key, member, fireControl] of [['search', row.search, false], ['fireControl', row.fireControl, true]]) {
            const label = `${msp} MSP, ${wanted} km, jammer ${jammer}, resolution ${row.resolution}, ${key}`
            const reachOf = (sizeHS) => effectiveRange({ sizeHS, resolution: row.resolution, fireControl, signature: fireControl ? fireControlSignatureOfMissile(msp) : searchSignatureOfMissile(msp), jammer: 0 })

            if (member.sizeHS === null) {
              assert.ok(!meetsRange(reachOf(sizes[sizes.length - 1]), wanted), `${label}: the largest size reaches the range, yet no size is given`)
              continue
            }

            const index = sizes.indexOf(member.sizeHS)

            assert.ok(index >= 0, `${label}: ${member.sizeHS} HS is not a legal size`)
            assert.ok(meetsRange(reachOf(member.sizeHS), wanted), `${label}: ${member.sizeHS} HS does not reach the range`)
            close(member.reach.value, reachOf(member.sizeHS), `${label}: reach`, 1e-6)
            assert.equal(member.sizeHS, bare.rows.find((entry) => entry.resolution === row.resolution)[key].sizeHS, `${label}: the jammer changes the size`)

            if (index > 0) {
              assert.ok(!meetsRange(reachOf(sizes[index - 1]), wanted), `${label}: ${sizes[index - 1]} HS also reaches the range`)
            }

            rows++
          }
        }
      }
    }
  }

  assert.ok(rows > 1000, `the grid holds ${rows} sized members`)

  const small = m.sp.activeSizing({ target: m.sp.targetOf({ kind: 'missile', msp: 20 }), wantedRangeKm: 100000, resolution: 20, tech: st }).selected

  assert.equal(small.fireControl.sizeHS, 0.1, 'the smallest legal fire control already sees a 20 MSP missile at 100,000 km at resolution 20')
  close(small.fireControl.reach.value, maximumRange(0.1, 20, true), 'its reach is the whole range of the sensor, the missile being as large as the resolution', 1e-6)
  assert.ok(small.fireControl.reach.value > 1e7)
  assert.ok(small.search.sizeHS > small.fireControl.sizeHS)

  return { lines: [`${rows} sized members over 6 missile sizes, 4 ranges, 2 jammers and every resolution, against the literal range of each member, none under a jammer`] }
})

check('limiting: a saved fire control of resolution 20 is not limiting against a 20 MSP missile at 100,000 km, and one far under the size of the missile is', (m) => {
  const { st } = planOf(m)
  const target = m.sp.targetOf({ kind: 'missile', msp: 20 })
  const pair = m.sp.savedPairCheck({ search: saved(1e6, 1), fireControl: saved(1e6, 20), target, wantedRangeKm: 100000, tech: st })

  close(pair.fireControl.reach.value, 1e6, 'the fire control sees a missile of 20 points at its resolution of 20 at its whole range')
  close(pair.search.reach.value, 1e6, 'the search sensor sees it at the signature of 1 HS, at its resolution of 1')
  assert.equal(pair.meets, true)
  assert.equal(pair.limiting, null)

  const jammed = m.sp.savedPairCheck({ search: saved(1e6, 1), fireControl: saved(1e6, 20), target, wantedRangeKm: 100000, jammer: 5, tech: st })

  close(jammed.fireControl.reach.value, 1e6, 'no jammer applies to a fire control against a missile')
  close(jammed.search.reach.value, 1e6, 'no jammer applies to the search sensor against a missile either')
  assert.equal(jammed.limiting, null)

  const small = m.sp.targetOf({ kind: 'missile', msp: 6 })
  const short = m.sp.savedPairCheck({ search: saved(1e6, 1), fireControl: saved(1e6, 40), target: small, wantedRangeKm: 50000, tech: st })

  close(short.search.reach.value, 1e6 * 0.3 ** 2, 'a search sensor sees 6 points as 0.3 HS')
  close(short.fireControl.reach.value, 1e6 * (6 / 40) ** 2, 'a fire control of resolution 40 sees 6 points')
  assert.equal(short.search.meets, true)
  assert.equal(short.fireControl.meets, false)
  assert.equal(short.limiting, 'fireControl')

  const ship = m.sp.savedPairCheck({ search: saved(1e6, 20), fireControl: saved(1e6, 20), target: tonsTarget(m, 250), wantedRangeKm: 100000, jammer: 2, tech: st })

  close(ship.fireControl.reach.value, ship.search.reach.value, 'against a ship both members see the one cross-section under the jammer')
  assert.equal(m.sp.savedPairCheck({ search: saved(1e6, 20), fireControl: saved(1e6, 20), target: tonsTarget(m, 250), wantedRangeKm: 100000, tech: st }).fireControl.reach.value, 1e6 * (5 / 20) ** 2)
})

// ---------- minerals ----------

check('minerals: the hardening is the Uridium and the ECCM the Corbomite of each level pair, the Uridium keeps to the hardening', (m) => {
  const { st } = planOf(m, { choices: { [HARDENING]: 2033, [ECCM]: 2043 } })
  const sizing = m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, jammer: 5, tech: st })
  const tradeoff = m.sp.hardeningEccmTradeoff({ sizing, tech: st })
  const members = [sizing.selected.search.sizeHS, sizing.selected.fireControl.sizeHS]

  assert.equal(tradeoff.rows.length, 3 * 3, 'a row for each hardening and each ECCM level, the chosen hypothetical ones included')

  for (const row of tradeoff.rows) {
    const factor = row.hardening.level.info2
    const eccmCost = row.eccm.level.info2
    const label = `${row.hardening.level.name} with ${row.eccm.level.name}`
    const uridium = members.reduce((total, size) => total + roundTenth(size * 16 * factor), 0)

    close(row.uridium.value, uridium, `${label}: Uridium`)
    close(row.cost.value, uridium * eccmCost, `${label}: BP`)
    close(row.corbomite.value, uridium * eccmCost - uridium, `${label}: Corbomite`, 1e-6)
    close(row.cost.value, row.uridium.value + row.corbomite.value, `${label}: BP is Uridium and Corbomite`, 1e-9)
  }

  for (const entry of tradeoff.rows.filter((row) => row.eccm.level.info2 === 1)) {
    close(entry.corbomite.value, 0, `${entry.hardening.level.name}: no Corbomite at an ECCM factor of 1`)
  }

  for (const hardening of [2031, 2032, 2033]) {
    const uridium = tradeoff.rows.filter((row) => row.hardening.level.id === hardening).map((row) => row.uridium.value)

    assert.equal(new Set(uridium).size, 1, `the Uridium of hardening ${hardening} moves with the ECCM`)
  }

  assert.equal(tradeoff.rows.filter((row) => row.current).length, 1)
  assert.equal(tradeoff.rows.find((row) => row.current).hardening.level.id, 2033)
})

check('minerals: the reach against a jammer follows the ECCM of the level, the sizes stay those of the chosen pair', (m) => {
  const { st } = planOf(m, { choices: { [ECCM]: 2043 } })
  const sizing = m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, jammer: 2, tech: st })
  const tradeoff = m.sp.hardeningEccmTradeoff({ sizing, tech: st })
  const sizes = [sizing.selected.search.sizeHS, sizing.selected.fireControl.sizeHS]
  const row = (eccm) => tradeoff.rows.find((entry) => entry.eccm.level.id === eccm && entry.hardening.level.id === 2032)

  assert.equal(row(2043).meets, true, 'the pair is sized at the ECCM 2 chosen, which a jammer of 2 does not cut')
  assert.equal(row(2042).meets, false, 'ECCM 1 against a jammer of 2')
  assert.equal(row(2041).meets, false, 'ECCM 0 against a jammer of 2')
  assert.ok(row(2041).reach.value < row(2042).reach.value && row(2042).reach.value < row(2043).reach.value)
  assert.equal(row(2043).eccm.hypothetical, true)
  assert.equal(row(2042).eccm.researched, true)
  assert.deepEqual([row(2043).search.value.sizeHS, row(2043).fireControl.value.sizeHS], sizes)
  assert.deepEqual(m.sp.hardeningEccmTradeoff({ sizing: m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, resolution: 106, tech: st }), tech: st }), { pair: null, rows: [] })
})

check('minerals: against a missile target the tradeoff reach of both members takes the signature of the missile and no jammer, at every ECCM', (m) => {
  const { st } = planOf(m, { choices: { [ECCM]: 2043 } })
  const range = (sizeHS, resolution, fireControl, msp, eccm) => effectiveRange({ sizeHS, resolution, fireControl, signature: fireControl ? Math.max(msp, 0.33) : Math.max(msp / 20, 0.3), jammer: 0, eccm })
  let limited = 0
  let compared = 0
  const reaches = new Map()

  for (const msp of [0.5, 1, 3, 10]) {
    for (const resolution of [1, 3, 10]) {
      for (const wanted of [1e5, 3e5, 1e6]) {
        for (const jammer of [0, 3]) {
          const sizing = m.sp.activeSizing({ target: m.sp.targetOf({ kind: 'missile', msp }), wantedRangeKm: wanted, resolution, jammer, tech: st })
          const pair = sizing.selected

          if (!pair || !pair.feasible) {
            continue
          }

          const tradeoff = m.sp.hardeningEccmTradeoff({ sizing, tech: st })

          for (const [eccmId, eccm] of [[2043, 2], [2041, 0]]) {
            const row = tradeoff.rows.find((entry) => entry.eccm.level.id === eccmId && entry.hardening.level.id === 2032)
            const searchReach = range(pair.search.sizeHS, resolution, false, msp, eccm)
            const controlReach = range(pair.fireControl.sizeHS, resolution, true, msp, eccm)
            const key = `${msp}|${resolution}|${wanted}|${eccmId}`

            close(row.reach.value, Math.min(searchReach, controlReach), `${msp} MSP, resolution ${resolution}, ${wanted} km, jammer ${jammer}, ECCM ${eccm}`, 1e-6)
            assert.ok(!reaches.has(`${key}|${jammer}`))
            reaches.set(`${key}|${jammer}`, row.reach.value)
            compared++

            if (controlReach < searchReach) {
              limited++
            }
          }
        }
      }
    }
  }

  assert.ok(compared > 20, `${compared} rows compared`)
  assert.ok(limited > 0, 'some pair is limited by its fire control, so the fire control reach is observed')

  for (const [key, value] of reaches) {
    if (key.endsWith('|3')) {
      close(value, reaches.get(`${key.slice(0, -2)}|0`), `${key}: the jammer moves the reach of a missile target`, 1e-12)
    }
  }
})

// ---------- research ----------

check('research: the planner lines are registered tech types of the sensor family, and the loader reads the same types', (m) => {
  const lines = m.rt.SENSOR_PLANNER_LINES

  assert.deepEqual(Object.keys(lines).sort(), ['distance', 'eccm', 'em', 'hardening', 'singleWeapon', 'speed', 'strength', 'thermal'])

  for (const [role, typeId] of Object.entries(lines)) {
    assert.ok(m.rt.RACE_TECH_TYPES.includes(typeId), `${role} (${typeId}) is no registered tech type`)
    assert.ok(m.rt.SENSOR_TECH_TYPES.includes(typeId), `${role} (${typeId}) is not of the sensor family`)
    assert.equal(m.dd.SENSOR_TECH[role], typeId, `${role}: the loaders of design-data.js number it otherwise`)
  }

  assert.equal(m.rt.SINGLE_WEAPON_TECH_TYPE, 268)
  assert.equal(m.rt.TECH_FAMILIES[268].name, 'Single Weapon Fire Control')
  assert.deepEqual(m.sp.SENSOR_TECH_LINES.map((entry) => entry.typeId), m.sp.SENSOR_TECH_LINES.map((entry) => lines[entry.role]))
  assert.deepEqual(m.sp.SENSOR_MODE_LINES.active, ['strength', 'em', 'hardening', 'eccm'])
  assert.deepEqual(m.sp.SENSOR_MODE_LINES.passive, ['em', 'thermal', 'hardening'])
  assert.deepEqual(m.sp.SENSOR_MODE_LINES.beam, ['hardening', 'eccm', 'distance', 'speed', 'singleWeapon'])

  const { tech } = planOf(m)

  for (const typeId of Object.values(lines)) {
    assert.ok(tech.lines[typeId], `the race has no line of tech type ${typeId}`)
  }
})

check('research: a candidate is never researched, a researched level is, and the chosen level is the current one', (m) => {
  const researchedIds = new Set(LEVELS.filter((item) => item.researched).map((item) => item.id))
  const plain = planOf(m)
  const chosen = planOf(m, { choices: { [STRENGTH]: 2003, [DISTANCE]: 2052 } })

  for (const role of Object.keys(m.rt.SENSOR_PLANNER_LINES)) {
    for (const option of m.sp.techLineOptions(plain.tech, plain.resolution, role)) {
      assert.equal(option.researched, researchedIds.has(option.id), `${role}: ${option.name} researched`)
      assert.equal(option.hypothetical, !researchedIds.has(option.id), `${role}: ${option.name} hypothetical`)
    }

    assert.ok(role === 'thermal' || m.sp.techLineOptions(plain.tech, plain.resolution, role).some((option) => !option.researched), `${role}: no candidate is offered`)
    assert.equal(m.sp.techLineOptions(plain.tech, plain.resolution, role).filter((option) => option.current).length, 1, `${role}: one current level`)
  }

  const options = m.sp.techLineOptions(chosen.tech, chosen.resolution, 'strength')

  assert.deepEqual(options.map((option) => [option.id, option.researched, option.current]), [[2001, true, false], [2002, true, false], [2003, false, true]])
  assert.ok(options[2].text.includes('Strength 24'))
  assert.equal(chosen.st.strength.hypothetical, true)
  assert.equal(chosen.st.strength.info, 24)
  assert.equal(plain.st.strength.hypothetical, false)
  assert.equal(plain.st.hypothetical, false)
  assert.deepEqual(plain.st.assumptions, [])
  assert.equal(chosen.st.assumptions.length, 2)
  assert.deepEqual(chosen.st.levels.hardening.map((entry) => [entry.level.id, entry.researched, entry.hypothetical]), [[2031, true, false], [2032, true, false]])

  const hardened = planOf(m, { choices: { [HARDENING]: 2033 } }).st

  assert.deepEqual(hardened.levels.hardening.map((entry) => [entry.level.id, entry.researched, entry.hypothetical, entry.current]), [[2031, true, false, false], [2032, true, false, false], [2033, false, true, true]])
  assert.equal(m.sp.techLineOptions(null, null, 'strength').length, 0)
})

check('research: a hypothetical level marks the figures built on it and only those', (m) => {
  const hypothetical = (result) => m.ts.isHypothetical(result)
  const target = tonsTarget(m, 250)
  const base = planOf(m).st
  const baseSizing = m.sp.activeSizing({ target, wantedRangeKm: 2e7, jammer: 5, tech: base })

  for (const row of [baseSizing.best.search, baseSizing.best.fireControl]) {
    for (const result of [row.sizing, row.size, row.reach, row.design, row.cost]) {
      assert.ok(!hypothetical(result), 'a researched tech marks a figure')
    }
  }

  const sizingOf = (choices, jammer) => m.sp.activeSizing({ target, wantedRangeKm: 2e7, jammer, tech: planOf(m, { choices }).st }).best

  const strength = sizingOf({ [STRENGTH]: 2003 }, 0)

  for (const result of [strength.search.sizing, strength.search.size, strength.search.reach, strength.search.design, strength.search.cost, strength.totalCost, strength.totalHS]) {
    assert.ok(hypothetical(result), 'a figure of a hypothetical strength is not marked')
    assert.ok(['assumed', 'estimated'].includes(result.status), `a figure of a hypothetical level is ${result.status}, and never confirmed`)
  }

  const hardening = sizingOf({ [HARDENING]: 2033 }, 0)

  assert.ok(!hypothetical(hardening.search.sizing) && !hypothetical(hardening.search.size) && !hypothetical(hardening.search.reach), 'the size reads no hardening, it is marked')
  assert.ok(hypothetical(hardening.search.design) && hypothetical(hardening.search.cost) && hypothetical(hardening.totalCost), 'the cost of a hypothetical hardening is not marked')
  assert.ok(!hypothetical(hardening.totalHS))

  assert.ok(!hypothetical(sizingOf({ [ECCM]: 2043 }, 0).search.sizing), 'an ECCM with no jammer to meet marks the size')
  assert.ok(hypothetical(sizingOf({ [ECCM]: 2043 }, 5).search.sizing), 'an ECCM against a jammer does not mark the size')
  assert.ok(hypothetical(sizingOf({ [EM]: 2012 }, 0).search.reach))

  const withHardening = planOf(m, { choices: { [HARDENING]: 2033 } }).st
  const tradeoff = m.sp.hardeningEccmTradeoff({ sizing: m.sp.activeSizing({ target, wantedRangeKm: 2e7, tech: withHardening }), tech: withHardening })

  for (const row of tradeoff.rows) {
    assert.equal(hypothetical(row.cost), row.hardening.hypothetical || row.eccm.hypothetical, `${row.hardening.level.name} with ${row.eccm.level.name}`)
  }

  const beam = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: planOf(m, { choices: { [DISTANCE]: 2052 } }).st })

  assert.ok(hypothetical(beam.range.result), 'the range axis of a hypothetical distance rating is not marked')
  assert.ok(!hypothetical(beam.tracking.result), 'the tracking axis reads no distance rating, it is marked')
  assert.ok(hypothetical(beam.request) && hypothetical(beam.design))
  assert.ok(!hypothetical(m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: base }).design))

  const em = planOf(m, { choices: { [EM]: 2012 } }).st

  assert.ok(hypothetical(m.sp.passiveProposal({ sizeHS: 2, kind: 'em', tech: em }).design))
  assert.ok(!hypothetical(m.sp.passiveProposal({ sizeHS: 2, kind: 'thermal', tech: em }).design))
})

check('research: an unresolved choice designs with the pick, and a line with no level is unavailable, never 0', (m) => {
  const tech = buildTech(m)
  const resolution = m.ts.resolveChoices(tech, { [STRENGTH]: { techId: 99999, source: 'scenario' } })
  const st = m.sp.sensorTechOf(tech, resolution)
  const plain = planOf(m).st

  assert.notEqual(st.strength.unresolved, null)
  assert.equal(st.strength.info, plain.strength.info)
  assert.equal(st.strength.hypothetical, false)
  assert.equal(plain.strength.unresolved, null)
  assert.equal(m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, tech: st }).best.resolution, m.sp.activeSizing({ target: tonsTarget(m, 250), wantedRangeKm: 2e7, tech: plain }).best.resolution)

  const bare = m.sp.NO_SENSOR_TECH

  for (const role of Object.keys(m.rt.SENSOR_PLANNER_LINES)) {
    assert.equal(bare[role].info, null, `${role}: a line with no level has a figure`)
    assert.equal(bare[role].level, null)
  }

  assert.equal(bare.singleWeapon.offersSingle, false)
  assert.equal(bare.hypothetical, false)
  unknown(m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: bare }).request, 'a beam control with no tech')
  unknown(m.sp.passiveProposal({ sizeHS: 2, kind: 'thermal', tech: bare }).design, 'a passive sensor with no tech')
  unknown(m.sp.passiveProposal({ sizeHS: 2, kind: 'thermal', tech: bare }).sensitivity, 'its sensitivity')
  unknown(m.sp.passiveProposal({ sizeHS: 0, kind: 'thermal', tech: plain }).design, 'a passive sensor of no size')
})

check('research: the single weapon switch is offered only for a level the race has researched or chose', (m) => {
  const base = planOf(m).st
  const researched = planOf(m, { levels: researchedAlso(LEVELS, 2072) }).st
  const chosen = planOf(m, { choices: { [SINGLE]: 2072 } }).st
  const none = planOf(m, { levels: without(LEVELS, SINGLE) }).st

  assert.equal(base.singleWeapon.offersSingle, false)
  assert.equal(base.singleWeapon.weapons.single, null)
  assert.equal(base.singleWeapon.weapons.unrestricted.number, 1)
  assert.equal(researched.singleWeapon.offersSingle, true)
  assert.equal(researched.singleWeapon.weapons.single.number, 0.5)
  assert.equal(researched.singleWeapon.weapons.single.hypothetical, false)
  assert.equal(researched.singleWeapon.weapons.unrestricted.number, 1)
  assert.equal(chosen.singleWeapon.offersSingle, true)
  assert.equal(chosen.singleWeapon.weapons.single.hypothetical, true)
  assert.equal(chosen.singleWeapon.weapons.unrestricted.number, 1)
  assert.equal(none.singleWeapon.offersSingle, false)
  assert.equal(none.singleWeapon.weapons.unrestricted, null)
})

// ---------- beam ----------

const beamTech = (m, over = {}) => planOf(m, over).st

check('beam: the range and the tracking axes are sized apart, each to the smallest legal multiplier', (m) => {
  const st = beamTech(m)
  const request = (rangeKm, trackingKmS) => m.sp.beamSizing({ rangeKm, trackingKmS, tech: st })
  const first = request(200000, 10000)

  assert.equal(first.range.multiplier, 3.13)
  assert.equal(first.range.reachKm, 3.13 * 64000)
  assert.ok(first.range.smaller === 3.12 && 3.12 * 64000 < 200000)
  assert.equal(first.tracking.multiplier, 2.5)
  assert.equal(first.tracking.reachKm, 10000)
  assert.equal(first.tracking.smaller, 2.49)
  assert.ok(Math.round(2.49 * 4000) < 10000)
  assert.equal(request(200000, 20000).range.multiplier, 3.13, 'the tracking wanted moves the range multiplier')
  assert.equal(request(100000, 10000).tracking.multiplier, 2.5, 'the range wanted moves the tracking multiplier')
  assert.equal(request(100000, 10000).range.multiplier, 1.57)
  assert.equal(request(200000, 6000).tracking.multiplier, 1.5)
  assert.equal(first.design.value.rangeKm, 3.13 * 64000)
  assert.equal(first.design.value.trackingKmS, 10000)
  close(first.design.value.sizeHS, Math.round(3.13 * 2.5 / 2 * 100) / 100, 'the size of the control')
  assert.equal(first.tiles.range.value, first.range.reachKm)
  assert.equal(first.tiles.tracking.value, first.tracking.reachKm)
  assert.equal(first.tiles.size.value, first.design.value.sizeHS)
  assert.equal(first.tiles.cost.value, first.design.value.cost)
  assert.equal(first.restriction.state, 'unrestricted')
  assert.equal(first.restriction.specialFunction, 0)
  assert.equal(request(200000, 1).tracking.status, 'minimum-bound')
})

check('beam: a range above the cap claims no reach, a multiplier past the cap is wasted, a tracking beyond the techs is unavailable', (m) => {
  const wide = beamTech(m, { levels: replaced(LEVELS, DISTANCE, level(2051, DISTANCE, 'Distance 600000', 100, 600000, null, true)) })
  const beyond = m.sp.beamSizing({ rangeKm: 1500000, trackingKmS: 10000, tech: wide })

  assert.equal(beyond.range.beyondCap, true)
  assert.equal(beyond.range.reachKm, null)
  assert.equal(beyond.range.multiplier, null)
  assert.equal(beyond.range.capKm, 1400000)
  unknown(beyond.tiles.range, 'a range above 1,400,000 km')
  unknown(beyond.design, 'the design for a range above the cap')
  assert.ok(beyond.tiles.range.inputs.missing.some((text) => text.includes('1400000')))

  const capped = m.sp.beamSizing({ rangeKm: 1400000, trackingKmS: 10000, tech: wide })

  assert.equal(capped.range.beyondCap, false)
  assert.equal(capped.range.multiplier, 2.34)
  assert.equal(capped.range.reachKm, 1400000, 'the range is never above the cap')
  assert.equal(capped.design.value.rangeCapped, true)
  assert.equal(capped.design.value.rangeKm, 1400000)

  const fast = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 20000, tech: beamTech(m) })

  assert.equal(fast.tracking.status, 'beyond-largest')
  assert.equal(fast.tracking.greatest, 16000)
  assert.equal(fast.tracking.reachKm, null)
  unknown(fast.tiles.tracking, 'a tracking speed beyond the techs')
  unknown(fast.design, 'the design for a tracking speed beyond the techs')

  for (const [rangeKm, trackingKmS] of [['', 10000], [0, 10000], [200000, ''], [200000, 'fast'], [null, null]]) {
    const blank = m.sp.beamSizing({ rangeKm, trackingKmS, tech: beamTech(m) })

    unknown(blank.design, `the design for ${JSON.stringify([rangeKm, trackingKmS])}`)
    assert.ok([blank.tiles.range, blank.tiles.tracking].some((tile) => tile.status === 'unavailable' && tile.value === null))
  }
})

check('beam: a single weapon control halves the size and the cost and carries special function 6, the two always told apart', (m) => {
  const levels = researchedAlso(LEVELS, 2072)
  const st = beamTech(m, { levels })
  const unrestricted = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: st })
  const single = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: st, singleWeapon: true })

  assert.equal(unrestricted.restriction.state, 'unrestricted')
  assert.equal(single.restriction.state, 'single weapon')
  assert.equal(single.restriction.specialFunction, 6)
  assert.equal(unrestricted.restriction.specialFunction, 0)
  assert.equal(single.restriction.weaponNumber.value, 0.5)
  assert.equal(unrestricted.restriction.weaponNumber.value, 1)
  assert.equal(single.restriction.offered, true)
  assert.equal(single.design.value.specialFunction, 6)
  assert.equal(unrestricted.design.value.specialFunction, 0)
  close(single.design.value.sizeHS, Math.round(3.13 * 2.5 / 2 * 0.5 * 100) / 100, 'the size of a single weapon control')
  close(unrestricted.design.value.sizeHS, Math.round(3.13 * 2.5 / 2 * 100) / 100, 'the size of an unrestricted control')
  close(single.design.value.cost, roundTenth(3.13 * 64000 / 20000 * 10 * 1.25 * 0.5) * 1.1, 'the cost of a single weapon control')
  close(unrestricted.design.value.cost, roundTenth(3.13 * 64000 / 20000 * 10 * 1.25) * 1.1, 'the cost of an unrestricted control')
  assert.equal(single.range.multiplier, unrestricted.range.multiplier)

  const pointDefence = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 16000, tech: st })

  assert.equal(pointDefence.design.value.specialFunction, 1, 'a tracking multiplier of 4 is point defence')
  assert.equal(m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 16000, tech: st, singleWeapon: true }).design.value.specialFunction, 6)

  const noSingle = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: beamTech(m), singleWeapon: true })

  assert.equal(noSingle.restriction.offered, false)
  unknown(noSingle.design, 'a single weapon control the race has not researched')
  assert.ok(noSingle.design.inputs.missing.some((text) => text.includes('single weapon')))
  assert.equal(noSingle.range.multiplier, 3.13, 'the axes need no weapon number')
  assert.equal(m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: beamTech(m) }).design.status !== 'unavailable', true)

  const chosen = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: beamTech(m, { choices: { [SINGLE]: 2072 } }), singleWeapon: true })

  assert.equal(chosen.design.value.specialFunction, 6)
  assert.ok(m.ts.isHypothetical(chosen.design))

  const noMulti = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: beamTech(m, { levels: without(LEVELS, SINGLE) }) })

  assert.equal(noMulti.restriction.weaponNumber.status, 'assumed')
  assert.equal(noMulti.restriction.weaponNumber.value, 1)
})

check('beam: the table holds the design of each pair of multipliers, adds the sized pair and flags it, and marks a multiplier the cap wastes', (m) => {
  const st = beamTech(m)
  const sized = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: st })
  const rows = sized.table.rows
  const rating = { distanceRating: 64000, speedRating: 4000, weaponNumber: 1, hardeningRating: 50, hardeningCost: 1.25, eccmRating: 1, eccmCost: 1.1 }

  assert.equal(rows.length, m.sp.DEFAULT_BEAM_MULTIPLIERS.length ** 2 + 1)
  assert.equal(rows.filter((row) => row.proposed).length, 1)
  assert.deepEqual([rows.find((row) => row.proposed).rangeMultiplier, rows.find((row) => row.proposed).trackingMultiplier], [3.13, 2.5])
  assert.deepEqual(rows.map((row) => [row.rangeMultiplier, row.trackingMultiplier]), [...rows].map((row) => [row.rangeMultiplier, row.trackingMultiplier]).sort((a, b) => a[0] - b[0] || a[1] - b[1]))

  for (const row of rows) {
    assert.deepEqual(row.design.value, m.dr.beamFireControlDesign({ rangeMultiplier: row.rangeMultiplier, trackingMultiplier: row.trackingMultiplier, ...rating }), `${row.rangeMultiplier} x ${row.trackingMultiplier}`)
    assert.equal(row.specialFunction, row.trackingMultiplier === 4 ? 1 : 0)
    assert.equal(row.rangeKm, Math.min(1400000, row.rangeMultiplier * 64000))
  }

  const singleTech = beamTech(m, { levels: researchedAlso(LEVELS, 2072) })
  const singleRows = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: singleTech, singleWeapon: true }).table.rows

  for (const row of singleRows) {
    assert.deepEqual(row.design.value, m.dr.beamFireControlDesign({ rangeMultiplier: row.rangeMultiplier, trackingMultiplier: row.trackingMultiplier, ...rating, weaponNumber: 0.5 }), `single weapon ${row.rangeMultiplier} x ${row.trackingMultiplier}`)
    assert.equal(row.specialFunction, 6)
  }

  const custom = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: st, multipliers: { range: [1, 2, 7, 1.234], tracking: [0.5, 4] } })

  assert.deepEqual([...new Set(custom.table.rows.map((row) => row.rangeMultiplier))], [1, 2, 3.13], 'a multiplier off the legal ladder is dropped')
  assert.equal(custom.table.rows.length, 2 * 2 + 1)

  const wide = beamTech(m, { levels: replaced(LEVELS, DISTANCE, level(2051, DISTANCE, 'Distance 600000', 100, 600000, null, true)) })
  const wasted = m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech: wide, multipliers: { range: [2, 3], tracking: [1] } })

  assert.deepEqual(wasted.table.rows.filter((row) => row.proposed === false).map((row) => [row.rangeMultiplier, row.rangeCapped, row.wastedMultiplier, row.rangeKm]), [[2, false, false, 1200000], [3, true, true, 1400000]])
})

check('beam: a saved control names the axis that limits it, both when both fall short, and nothing when it meets or the answer is unknown', (m) => {
  const controls = [
    { id: 1, rangeKm: 1e6, trackingKmS: 5000 },
    { id: 2, rangeKm: 100000, trackingKmS: 20000 },
    { id: 3, rangeKm: 100000, trackingKmS: 5000 },
    { id: 4, rangeKm: 1e6, trackingKmS: 20000 },
    { id: 5, rangeKm: null, trackingKmS: 20000 },
    { id: 6, rangeKm: 1e6, trackingKmS: 0 },
  ]
  const result = m.sp.existingBeamControls({ controls, rangeKm: 200000, trackingKmS: 10000 })

  assert.deepEqual(result.map((entry) => [entry.row.id, entry.meets, entry.limiting]), [[1, false, 'tracking'], [2, false, 'range'], [3, false, 'both'], [4, true, null], [5, null, null], [6, null, null]])
  unknown(result[4].range.result, 'a control with no stored range')
  unknown(result[5].tracking.result, 'a control with a tracking speed of 0')
  assert.deepEqual(m.sp.existingBeamControls({ controls, rangeKm: '', trackingKmS: 10000 }).map((entry) => [entry.meets, entry.limiting]), [[false, 'tracking'], [null, null], [false, 'tracking'], [null, null], [null, null], [null, null]], 'a blank range wanted leaves the range axis unknown')
})

check('beam: a stored range above the cap of a designed control is kept as stored, marked and held to the wanted range as stored', (m) => {
  const cap = m.dr.BEAM_FIRE_CONTROL_MAX_RANGE_KM
  const [over, within, exact] = m.sp.existingBeamControls({ controls: [{ id: 1, rangeKm: 12e6, trackingKmS: 5000 }, { id: 2, rangeKm: 1e6, trackingKmS: 5000 }, { id: 3, rangeKm: cap, trackingKmS: 5000 }], rangeKm: 5e6, trackingKmS: 1000 })

  assert.deepEqual([over.range.aboveCap, within.range.aboveCap, exact.range.aboveCap], [true, false, false], 'only a range above the cap is marked')
  assert.equal(over.range.result.value, 12e6, 'the stored range is not cut to the cap')
  assert.ok(over.range.result.assumptions.some((assumption) => assumption.includes('above the')), 'the result says so')
  assert.deepEqual([over.meets, within.meets, exact.meets], [true, false, false], 'the verdict holds the stored range to the wanted one')
  assert.ok(!within.range.result.assumptions.some((assumption) => assumption.includes('above the')), 'a range within the cap has no such note')
  assert.equal(over.tracking.aboveCap, false, 'the tracking speed has no cap')
})

// ---------- target ----------

// A class of the shape of the signature checks: 40 HS, its cross-section as stored.
const klass = (over = {}) => ({ id: 1, name: 'Test', sizeHS: 40, obsolete: false, commercial: false, stored: { crossSection: 40, sensorReduction: 1, thermal: 100, enginePower: 200, speed: 5000, shieldStrength: 0 }, engines: [], cloaks: [], activeSensors: [], thermalSensors: [], emSensors: [], ...over })

check('target: a blank, zero or unreadable size is unavailable with what is missing, never 0', (m) => {
  for (const [label, target] of [
    ['a blank size', m.sp.targetOf({ kind: 'tons', tons: '' })],
    ['a size of 0', m.sp.targetOf({ kind: 'tons', tons: 0 })],
    ['a negative size', m.sp.targetOf({ kind: 'tons', tons: -50 })],
    ['an unreadable size', m.sp.targetOf({ kind: 'tons', tons: 'abc' })],
    ['no size', m.sp.targetOf({ kind: 'tons' })],
    ['a blank missile', m.sp.targetOf({ kind: 'missile', msp: '' })],
    ['a missile of 0', m.sp.targetOf({ kind: 'missile', msp: 0 })],
    ['no class', m.sp.targetOf({ kind: 'class' })],
    ['no kind', m.sp.targetOf()],
  ]) {
    unknown(target.signature, label)
    assert.equal(target.results.length, 1, label)
    assert.equal(target.tons, null, label)
    unknown(target.results[0].signature, `${label}: the scenario`)
  }

  assert.equal(m.sp.targetOf({ kind: 'tons', tons: ' 250 ' }).signature.value, 5, 'a numeric text')
})

check('target: a size in tons is a cross-section of the size over 50 t per HS, never under 0.3 HS, entered and so assumed', (m) => {
  for (const [tons, expected] of [[250, 5], [50, 1], [100, 2], [15, 0.3], [14, 0.3], [5, 0.3], [20000, 400]]) {
    const target = m.sp.targetOf({ kind: 'tons', tons })

    assert.equal(target.signature.value, expected, `${tons} t`)
    assert.equal(target.signature.status, 'assumed', `${tons} t`)
    assert.equal(target.tons, tons)
    assert.equal(target.uncloaked, null)
  }

  assert.ok(m.sp.targetOf({ kind: 'tons', tons: 250 }).signature.assumptions.length > 0)
})

check('target: a missile is its size in MSP over 20 per HS, never under 0.3 HS', (m) => {
  for (const [msp, expected] of [[40, 2], [20, 1], [6, 0.3], [1, 0.3], [200, 10]]) {
    const target = m.sp.targetOf({ kind: 'missile', msp })

    assert.equal(target.signature.value, expected, `${msp} MSP`)
    assert.equal(target.signature.status, 'assumed')
    assert.equal(target.tons, null)
  }

  assert.equal(m.dr.missileSignature({ sizeMsp: 40 }), 2)
})

check('target: a saved class gives its cross-section, and with a working cloak the uncloaked size as a second scenario', (m) => {
  const plain = m.sp.targetOf({ kind: 'class', cls: klass() })

  assert.equal(plain.signature.value, 40)
  assert.equal(plain.label, 'Test')
  assert.equal(plain.tons, 2000)
  assert.equal(plain.uncloaked, null)
  assert.deepEqual(plain.results.map((entry) => entry.key), ['effective'])

  const cloaked = m.sp.targetOf({ kind: 'class', cls: klass({ stored: { ...klass().stored, crossSection: 10, sensorReduction: 0.25 }, cloaks: [{ id: 50, name: 'Cloak', maxShipHS: 100, rating: 0.25, count: 1 }] }) })

  assert.equal(cloaked.signature.value, 10)
  assert.deepEqual(cloaked.results.map((entry) => entry.key), ['effective', 'uncloaked'])
  assert.deepEqual(cloaked.results.map((entry) => entry.signature.value), [10, 40], 'the cloak working, the cloak damaged')
  assert.equal(cloaked.uncloaked.value, 40)
  assert.equal(cloaked.results[0].label, 'Cloak working')

  const rows = m.sp.existingDesigns({ sensors: [saved(3e7, 20)], target: cloaked })

  assert.deepEqual(rows[0].scenarios.map((entry) => entry.key), ['effective', 'uncloaked'])
  assert.ok(rows[0].scenarios[0].reach.value < rows[0].scenarios[1].reach.value, 'the cloaked class is seen from nearer')
  assert.equal(rows[0].reach, rows[0].scenarios[0].reach)
})

check('target: the reach of the saved sensors against a target is the stored range cut by the resolution and the jammer, with a curve that holds no point of an unknown sensor', (m) => {
  const sensors = [saved(3e7, 20, 1, { id: 11, name: 'A' }), saved(null, 20, 1, { id: 12, name: 'B' })]
  const target = tonsTarget(m, 250)
  const [first, second] = m.sp.existingDesigns({ sensors, target, jammer: 3 })

  close(first.reach.value, 3e7 * (5 / 20) ** 2 * 0.75 ** 2, 'a sensor against a small target and a jammer of 3 over an ECCM of 1')
  unknown(second.reach, 'a sensor with no stored range')
  unknown(m.sp.existingDesigns({ sensors, target: tonsTarget(m, ''), jammer: 0 })[0].reach, 'a sensor against no target')

  const curve = m.sp.rangeCurve({ sensors, tonsList: [1000, 50, 0, '', 'x', 50, 250], jammer: 0 })

  assert.deepEqual(curve.rows.map((row) => row.tons), [50, 250, 1000], 'the sizes sorted, without duplicates and without what is not above zero')
  assert.deepEqual(curve.series[0].points.map((point) => point.x), [50, 250, 1000])
  assert.deepEqual(curve.series[1].points, [], 'an unknown sensor has no point')
  close(curve.series[0].points[0].y, 3e7 * (1 / 20) ** 2, 'the point of a 50 t target')
  assert.ok(m.sp.DEFAULT_CURVE_TONS.every((tons, index, all) => index === 0 || tons > all[index - 1]))
})

check('target: a reach of a proposed sensor carries the provenance of its design, in the table of saved sensors and in the curve, and a saved sensor gets none', (m) => {
  const design = m.pv.ofRule({ rule: m.dr.SENSOR_RULES.active, value: { rangeKm: 3e7 }, inputs: { present: ['the design'] }, assumptions: ['Hypothetical tech: Active Sensor Strength is Strength 24'] })
  const sensors = [saved(3e7, 20, 1, { id: 11, name: 'Proposed', source: design }), saved(3e7, 20, 1, { id: 12, name: 'Saved' })]
  const target = tonsTarget(m, 250)
  const [proposed, plain] = m.sp.existingDesigns({ sensors, target, jammer: 0 })
  const curve = m.sp.rangeCurve({ sensors, tonsList: [50, 250], jammer: 0 })
  const named = (result) => result.assumptions.some((assumption) => assumption.includes('Strength 24'))

  assert.ok(named(proposed.reach) && proposed.scenarios.every((scenario) => named(scenario.reach)), 'the reach of a proposed sensor names the hypothetical level')
  assert.ok(!named(plain.reach), 'a saved sensor names none')
  assert.ok(curve.rows.every((row) => named(row.ranges[0].result) && !named(row.ranges[1].result)), 'every point of the proposed sensor names it, and none of the saved sensor')
  close(proposed.reach.value, plain.reach.value, 'the provenance changes no value')
  unknown(m.sp.rangeCurve({ sensors: [saved(null, 20, 1, { id: 13, name: 'No range', source: design })], tonsList: [50] }).rows[0].ranges[0].result, 'a sensor with no range stays unknown whatever its design')
})

check('target: a missile gives a fire control signature of its size in MSP, never under 0.33, and no jammer applies to either member; a ship gives both members one cross-section and the jammer', (m) => {
  for (const [msp, search, fireControl] of [[40, 2, 40], [20, 1, 20], [6, 0.3, 6], [1, 0.3, 1], [0.1, 0.3, 0.33], [0.33, 0.3, 0.33]]) {
    const target = m.sp.targetOf({ kind: 'missile', msp })

    assert.equal(target.signature.value, search, `${msp} MSP: search`)
    assert.equal(target.fireControlSignature.value, fireControl, `${msp} MSP: fire control`)
    assert.equal(target.fireControlSignature.status, 'assumed')
    assert.equal(target.searchJammer, false)
    assert.equal(target.fireControlJammer, false)
    assert.equal(target.results[0].fireControlSignature, target.fireControlSignature)
  }

  assert.equal(m.dr.missileFireControlSignature({ sizeMsp: 0.1 }), 0.33)
  assert.equal(m.dr.missileFireControlSignature({ sizeMsp: 50 }), 50)

  for (const target of [tonsTarget(m, 250), m.sp.targetOf({ kind: 'class', cls: klass() })]) {
    assert.equal(target.fireControlSignature, target.signature, 'a ship is one cross-section to both')
    assert.equal(target.searchJammer, true)
    assert.equal(target.fireControlJammer, true)
    assert.ok(target.results.every((entry) => entry.fireControlSignature === entry.signature))
  }

  for (const target of [m.sp.targetOf({ kind: 'missile', msp: '' }), tonsTarget(m, 0), m.sp.targetOf()]) {
    unknown(target.fireControlSignature, 'an unknown target')
  }
})

check('target: each scenario of a target is a target of its own, with the signature and the jammer policy of both members, for sizing, the saved pair and the saved designs', (m) => {
  const { st } = planOf(m)
  const missile = m.sp.targetOf({ kind: 'missile', msp: 20 })
  const ship = tonsTarget(m, 250)
  const cloaked = m.sp.targetOf({ kind: 'class', cls: klass() })

  for (const target of [missile, ship, cloaked]) {
    for (const entry of target.results) {
      assert.equal(entry.searchJammer, target.searchJammer, `${target.label} ${entry.key}: the search jammer policy`)
      assert.equal(entry.fireControlJammer, target.fireControlJammer, `${target.label} ${entry.key}: the jammer policy`)
      assert.ok(entry.fireControlSignature && entry.signature)
    }
  }

  for (const jammer of [0, 5]) {
    const whole = m.sp.activeSizing({ target: missile, wantedRangeKm: 1e7, resolution: 1, jammer, tech: st })
    const entry = m.sp.activeSizing({ target: missile.results[0], wantedRangeKm: 1e7, resolution: 1, jammer, tech: st })

    assert.equal(entry.selected.fireControl.sizeHS, whole.selected.fireControl.sizeHS, `jammer ${jammer}: the fire control sized from the scenario`)
    assert.equal(entry.selected.search.sizeHS, whole.selected.search.sizeHS, `jammer ${jammer}: the search sensor sized from the scenario`)
    assert.equal(entry.request.searchJammer, 0)
    assert.equal(entry.request.fireControlJammer, 0)
    assert.equal(entry.selected.fireControl.sizeHS, m.sp.activeSizing({ target: missile, wantedRangeKm: 1e7, resolution: 1, jammer: 0, tech: st }).selected.fireControl.sizeHS, `jammer ${jammer}: no jammer on the fire control`)
    assert.equal(entry.selected.search.sizeHS, m.sp.activeSizing({ target: missile, wantedRangeKm: 1e7, resolution: 1, jammer: 0, tech: st }).selected.search.sizeHS, `jammer ${jammer}: no jammer on the search sensor`)

    const saved12 = m.sp.savedPairCheck({ search: saved(1e7, 1), fireControl: saved(1.2e7, 1, 1), target: missile.results[0], wantedRangeKm: 1e7, jammer, tech: st })

    close(saved12.fireControl.reach.value, 1.2e7, `jammer ${jammer}: a saved fire control of 12,000,000 km sees 20 MSP at its whole range`)
    assert.equal(saved12.fireControl.meets, true)
  }

  const shipEntry = m.sp.activeSizing({ target: ship.results[0], wantedRangeKm: 1e7, resolution: 1, jammer: 5, tech: st })

  assert.equal(shipEntry.request.searchJammer, 5, 'a ship scenario keeps the jammer on the search sensor')
  assert.equal(shipEntry.request.fireControlJammer, 5, 'a ship scenario keeps the jammer on the fire control')
})

check('target: a saved fire control is measured against a missile by the size of the missile in MSP and a search sensor by the size over 20, the jammer on neither', (m) => {
  const target = m.sp.targetOf({ kind: 'missile', msp: 6 })
  const rows = m.sp.existingDesigns({ sensors: [saved(1e6, 10, 0, { id: 1, kind: 'search' }), saved(1e6, 10, 0, { id: 2, kind: 'fireControl' }), saved(1e6, 10, 0, { id: 3 })], target, jammer: 2 })

  close(rows[0].reach.value, 1e6 * (0.3 / 10) ** 2, 'a search sensor: 0.3 HS, no jammer')
  close(rows[1].reach.value, 1e6 * (6 / 10) ** 2, 'a fire control: 6 points, no jammer')
  close(rows[2].reach.value, rows[0].reach.value, 'a sensor of no kind is read as a search sensor')

  const ship = m.sp.existingDesigns({ sensors: [saved(1e6, 10, 0, { id: 1, kind: 'search' }), saved(1e6, 10, 0, { id: 2, kind: 'fireControl' })], target: tonsTarget(m, 250), jammer: 2 })

  close(ship[1].reach.value, ship[0].reach.value, 'a ship is one cross-section under the jammer to both')
  assert.equal(m.sp.sensorOf({ id: 4, name: 'X', kind: 'fireControl', rangeKm: 1, resolution: 1, eccm: 0 }).kind, 'fireControl')
})

check('jammer: a missile target gives the same search sensor reach whatever the jammer, and a ship target is scaled by it, in the sizing, the saved pair, the saved designs and the hardening and ECCM rows', (m) => {
  const { st } = planOf(m, { choices: { [ECCM]: 2043 } })
  const missile = m.sp.targetOf({ kind: 'missile', msp: 40 })
  const ship = tonsTarget(m, 250)
  const sensors = [saved(1e6, 1, 0, { id: 1, kind: 'search' }), saved(1e6, 1, 0, { id: 2, kind: 'fireControl' })]
  const read = (target, jammer) => {
    const sizing = m.sp.activeSizing({ target, wantedRangeKm: 1e7, resolution: 1, jammer, tech: st })
    const rows = m.sp.hardeningEccmTradeoff({ sizing, tech: st }).rows.filter((row) => row.hardening.level.id === 2032)

    assert.equal(sizing.selected.feasible, true, `${target.label}, jammer ${jammer}: a pair is sized`)

    return { search: sizing.selected.search, pair: m.sp.savedPairCheck({ search: sensors[0], fireControl: sensors[1], target, wantedRangeKm: 1e5, jammer, tech: st }), designs: m.sp.existingDesigns({ sensors, target, jammer }), eccm0: rows.find((row) => row.eccm.level.id === 2041), eccm2: rows.find((row) => row.eccm.level.id === 2043) }
  }

  for (const [kind, target] of [['a missile target', missile], ['the scenario of a missile target', missile.results[0]]]) {
    const bare = read(target, 0)

    close(bare.pair.search.reach.value, 1e6, `${kind}: a saved search sensor sees a missile of 2 HS at its whole range`)

    for (const jammer of [1, 2, 5, 8]) {
      const now = read(target, jammer)
      const label = `${kind}, jammer ${jammer}`

      assert.equal(now.search.sizeHS, bare.search.sizeHS, `${label}: the size of the search sensor`)
      close(now.search.reach.value, bare.search.reach.value, `${label}: the reach of the sized search sensor`)
      close(now.pair.search.reach.value, bare.pair.search.reach.value, `${label}: the saved search sensor`)
      close(now.designs[0].reach.value, bare.designs[0].reach.value, `${label}: the saved design of a search sensor`)
      close(now.eccm0.reach.value, bare.eccm0.reach.value, `${label}: the reach of the pair at an ECCM of 0`)
      close(now.eccm0.reach.value, now.eccm2.reach.value, `${label}: an ECCM moves nothing against a missile`)
    }
  }

  const bareShip = read(ship, 0)
  const jammedShip = read(ship, 5)

  assert.ok(jammedShip.search.sizeHS > bareShip.search.sizeHS, 'a ship under a jammer asks for a larger search sensor')
  close(jammedShip.pair.search.reach.value, 1e6 * 0.75 ** 5, 'a saved search sensor of ECCM 0 under a jammer of 5')
  close(jammedShip.designs[0].reach.value, 1e6 * 0.75 ** 5, 'the saved design of a search sensor under a jammer of 5')
  close(bareShip.pair.search.reach.value, 1e6, 'a saved search sensor with no jammer')
  assert.ok(jammedShip.eccm0.reach.value < jammedShip.eccm2.reach.value, 'a ship under a jammer is seen further with the higher ECCM')
})

check('research: the reach of each hardening and ECCM row carries the provenance of the designs it is built from, under a hypothetical strength, EM sensitivity and an ECCM against a jammer', (m) => {
  const target = tonsTarget(m, 250)
  const hypothetical = (result) => m.ts.isHypothetical(result)
  let marked = 0

  for (const [choices, jammer, expected] of [[{ [STRENGTH]: 2003 }, 0, true], [{ [EM]: 2012 }, 0, true], [{ [ECCM]: 2043 }, 2, true], [{ [ECCM]: 2043 }, 0, false], [{}, 2, false]]) {
    const st = planOf(m, { choices }).st
    const tradeoff = m.sp.hardeningEccmTradeoff({ sizing: m.sp.activeSizing({ target, wantedRangeKm: 2e7, jammer, tech: st }), tech: st })

    assert.ok(tradeoff.rows.length > 0)

    for (const row of tradeoff.rows) {
      const label = `${JSON.stringify(choices)}, jammer ${jammer}, ${row.hardening.level.name}, ${row.eccm.level.name}`

      assert.equal(hypothetical(row.reach), hypothetical(row.search) || hypothetical(row.fireControl), `${label}: the reach follows the designs it is built from`)
      assert.equal(hypothetical(row.reach), expected || row.eccm.hypothetical, label)
      marked += hypothetical(row.reach) ? 1 : 0
    }
  }

  assert.ok(marked > 10, `${marked} marked reaches`)

  const strength = planOf(m, { choices: { [STRENGTH]: 2003 } }).st
  const row = m.sp.hardeningEccmTradeoff({ sizing: m.sp.activeSizing({ target, wantedRangeKm: 2e7, tech: strength }), tech: strength }).rows.find((entry) => entry.current)

  assert.ok(JSON.stringify(row.reach.assumptions).includes('Strength 24'), 'the reach names the hypothetical strength')
})

check('beam: a weapon number row the race holds that stores no number leaves the weapon number and what follows unknown, and a row it does not hold is the neutral 1', (m) => {
  const held = beamTech(m, { levels: replaced(LEVELS, SINGLE, level(2071, SINGLE, 'Multi-Weapon Fire Control', 1, null, null, true)) })
  const absent = beamTech(m, { levels: without(LEVELS, SINGLE) })
  const request = (tech, singleWeapon = false) => m.sp.beamSizing({ rangeKm: 200000, trackingKmS: 10000, tech, singleWeapon })

  for (const singleWeapon of [false, true]) {
    const sized = request(held, singleWeapon)

    assert.equal(sized.restriction.weaponNumber.status, 'unavailable', `single ${singleWeapon}: the weapon number`)
    assert.ok(JSON.stringify(sized.restriction.weaponNumber.inputs.missing).includes('stores no number'))
    assert.ok(!JSON.stringify(sized.restriction.weaponNumber.inputs).includes('holds no multi-weapon'))

    for (const result of [sized.request, sized.design, sized.tiles.size, sized.tiles.cost]) {
      assert.equal(result.status, 'unavailable', `single ${singleWeapon}: what follows the weapon number`)
    }

    assert.equal(sized.range.multiplier, 3.13, 'the range axis needs no weapon number')
    assert.equal(sized.tracking.status, request(absent).tracking.status)
    assert.notEqual(sized.tiles.range.status, 'unavailable')
    assert.notEqual(sized.tiles.tracking.status, 'unavailable')
    assert.ok(sized.table.rows.length > 0 && sized.table.rows.every((row) => row.design.status === 'unavailable' && row.rangeKm !== null))
  }

  const newest = beamTech(m, { levels: replaced(LEVELS, SINGLE, level(2071, SINGLE, 'Multi-Weapon Fire Control', 1, 1, null, true), level(2073, SINGLE, 'Multi-Weapon Fire Control II', 3, null, null, true)) })

  assert.equal(request(newest).restriction.weaponNumber.status, 'unavailable', 'the level in use stores no number, whatever an older level gives')
  assert.equal(request(newest).design.status, 'unavailable')

  const none = request(absent)

  assert.equal(none.restriction.weaponNumber.status, 'assumed')
  assert.equal(none.restriction.weaponNumber.value, 1)
  assert.equal(none.design.status !== 'unavailable', true, 'an absent row designs with the neutral number')
  assert.ok(none.design.value.sizeHS > 0)
})

check('limiting: a wanted range or tracking speed of zero or below is unknown for the saved designs as for the sizing, never met', (m) => {
  const { st } = planOf(m)
  const target = tonsTarget(m, 250)

  for (const wanted of [0, -5, '0', '-1e6']) {
    const pair = m.sp.savedPairCheck({ search: saved(1e7), fireControl: saved(4e7), target, wantedRangeKm: wanted, tech: st })

    assert.equal(pair.meets, null, `wanted range ${wanted}: the pair`)
    assert.equal(pair.limiting, null)
    assert.equal(pair.search.meets, null)
    assert.equal(pair.fireControl.meets, null)
    assert.equal(m.sp.activeSizing({ target, wantedRangeKm: wanted, tech: st }).tiles.sizeNeeded.status, 'unavailable', 'the sizing reads it as unknown too')

    const controls = [{ id: 1, rangeKm: 128000, trackingKmS: 8000 }]

    for (const [rangeKm, trackingKmS] of [[wanted, 1000], [100000, wanted], [wanted, wanted]]) {
      const [entry] = m.sp.existingBeamControls({ controls, rangeKm, trackingKmS })

      assert.equal(entry.meets === true, false, `beam ${rangeKm} / ${trackingKmS}: not met`)
      assert.equal(entry.limiting, null)
    }

    const [both] = m.sp.existingBeamControls({ controls, rangeKm: wanted, trackingKmS: wanted })

    assert.equal(both.meets, null)
    assert.equal(both.range.meets, null)
    assert.equal(both.tracking.meets, null)
  }

  const [one] = m.sp.existingBeamControls({ controls: [{ id: 1, rangeKm: 128000, trackingKmS: 8000 }], rangeKm: 0, trackingKmS: 9000 })

  assert.equal(one.range.meets, null)
  assert.equal(one.tracking.meets, false)
  assert.equal(one.limiting, 'tracking')
  assert.equal(m.sp.savedPairCheck({ search: saved(1e7), fireControl: saved(4e7), target, wantedRangeKm: 1e5, tech: st }).meets, true)
})

// ---------- loaders ----------

const memoryDatabase = (statements) => new Promise((resolve, reject) => {
  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(':memory:', (openError) => {
    if (openError) {
      reject(openError)

      return
    }

    raw.exec(statements.join(';\n'), (execError) => {
      if (execError) {
        reject(execError)

        return
      }

      resolve({ database: appDatabase(raw), close: () => raw.close() })
    })
  })
})

// The app's database object, `query(sql, { replacements })` giving `[rows]`, over a sqlite3 handle.
const appDatabase = (raw) => ({
  query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
    const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
    const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

    raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
  }),
})

const WHOLE_COMPONENTS = 'create table FCT_ShipDesignComponents (SDComponentID integer, GameID integer, Name text, ComponentTypeID integer, Size real, Cost real, Crew real, Uridium real, Corbomite real, ComponentValue real, MaxSensorRange real, Resolution real, ECCM integer, ElectronicCTD integer, TrackingSpeed real, FCRangeModifier real, FCSpeedModifier real, SpecialFunction integer)'

const COMPONENT_ROWS = [
  "insert into FCT_ShipDesignComponents values (100, 1, 'Search', 24, 2, 40, 4, 32, 8, 11, 3000000, 5, 1, 50, null, null, null, null)",
  "insert into FCT_ShipDesignComponents values (101, 0, 'Fire control', 25, 1, 20, 2, 16, 4, 12, 6000000, 5, 1, 50, null, null, null, null)",
  "insert into FCT_ShipDesignComponents values (102, 1, 'Other race', 24, 3, 60, 6, 48, 12, 13, 4000000, 10, 0, 100, null, null, null, null)",
  "insert into FCT_ShipDesignComponents values (103, 5, 'Other game', 24, 3, 60, 6, 48, 12, 13, 4000000, 10, 0, 100, null, null, null, null)",
  "insert into FCT_ShipDesignComponents values (104, 1, 'Beam', 19, 3.9, 37, 16, 30, 7, 640000, null, null, 1, 50, 20000, 10, 5, 6)",
  "insert into FCT_ShipDesignComponents values (105, 1, 'Thermal', 8, 1, 5, 2, 5, 0, 25, null, null, null, null, null, null, null, null)",
]

const RACE_TECH_ROWS_PLAIN = ['insert into FCT_RaceTech values (1, 2, 100), (1, 2, 101), (1, 3, 102), (5, 2, 103), (1, 2, 104), (1, 2, 105)']

const RACE_TECH_ROWS = ['insert into FCT_RaceTech values (1, 2, 100, 0), (1, 2, 101, 1), (1, 3, 102, 0), (5, 2, 103, 0), (1, 2, 104, 0), (1, 2, 105, 0)']

const WHOLE_SCHEMA = [WHOLE_COMPONENTS, 'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer, Obsolete integer)', ...COMPONENT_ROWS, ...RACE_TECH_ROWS]

const BARE_SCHEMA = [
  'create table FCT_ShipDesignComponents (SDComponentID integer, GameID integer, Name text, ComponentTypeID integer, Size real, ComponentValue real, MaxSensorRange real, Resolution real, TrackingSpeed real)',
  'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer)',
  "insert into FCT_ShipDesignComponents values (100, 1, 'Search', 24, 2, 11, 3000000, 5, null), (104, 1, 'Beam', 19, 3.9, 640000, null, null, 20000)",
  'insert into FCT_RaceTech values (1, 2, 100), (1, 2, 104)',
]

const withMemory = async (statements, run) => {
  const memory = await memoryDatabase(statements)

  try {
    return await run(memory.database)
  } finally {
    memory.close()
  }
}

check('loaders: the active sensors are read as stored for the race and the game, a fire control of the game table included', async (m) => {
  await withMemory(WHOLE_SCHEMA, async (database) => {
    const rows = await m.dd.ownedActiveSensors(database, 1, 2)

    assert.deepEqual(rows.map((row) => [row.id, row.name, row.type, row.kind]), [[100, 'Search', 24, 'search'], [101, 'Fire control', 25, 'fireControl']])
    assert.deepEqual(rows.map((row) => [row.sizeHS, row.cost, row.crew, row.uridium, row.corbomite]), [[2, 40, 4, 32, 8], [1, 20, 2, 16, 4]])
    assert.deepEqual(rows.map((row) => [row.rangeKm, row.strength, row.resolution, row.eccm, row.ctd]), [[3000000, 11, 5, 1, 50], [6000000, 12, 5, 1, 50]], 'the range is the maximum sensor range, not the component value')
    assert.deepEqual(rows.map((row) => row.obsolete), [false, true])
    assert.ok(Object.isFrozen(rows[0]))
    assert.deepEqual((await m.dd.ownedActiveSensors(database, 1, 3)).map((row) => row.id), [102], 'another race')
    assert.deepEqual((await m.dd.ownedActiveSensors(database, 5, 2)).map((row) => row.id), [103], 'another game')
    assert.deepEqual(await m.dd.ownedActiveSensors(database, 1, 9), [])
  })
})

check('loaders: the beam fire controls are read as stored, the range as the stored range and the tracking as the stored tracking speed', async (m) => {
  await withMemory(WHOLE_SCHEMA, async (database) => {
    const rows = await m.dd.ownedBeamFireControls(database, 1, 2)

    assert.deepEqual(rows.map((row) => [row.id, row.name, row.type]), [[104, 'Beam', 19]])
    assert.deepEqual([rows[0].sizeHS, rows[0].cost, rows[0].crew, rows[0].uridium, rows[0].corbomite], [3.9, 37, 16, 30, 7])
    assert.deepEqual([rows[0].rangeKm, rows[0].trackingKmS, rows[0].rangeMultiplier, rows[0].trackingMultiplier, rows[0].specialFunction, rows[0].eccm, rows[0].ctd, rows[0].obsolete], [640000, 20000, 10, 5, 6, 1, 50, false])
    assert.deepEqual(await m.dd.ownedBeamFireControls(database, 1, 3), [], 'another race')
    assert.deepEqual(await m.dd.ownedBeamFireControls(database, 5, 2), [], 'another game')
  })
})

check('loaders: a save without the optional columns gives null figures, never 0, and the same rows', async (m) => {
  await withMemory(BARE_SCHEMA, async (database) => {
    const [search] = await m.dd.ownedActiveSensors(database, 1, 2)
    const [beam] = await m.dd.ownedBeamFireControls(database, 1, 2)

    assert.deepEqual([search.id, search.kind, search.sizeHS, search.rangeKm, search.resolution, search.strength], [100, 'search', 2, 3000000, 5, 11])
    assert.deepEqual([search.cost, search.crew, search.uridium, search.corbomite, search.eccm, search.ctd, search.obsolete], [null, null, null, null, null, null, null])
    assert.deepEqual([beam.id, beam.sizeHS, beam.rangeKm, beam.trackingKmS], [104, 3.9, 640000, 20000])
    assert.deepEqual([beam.cost, beam.crew, beam.uridium, beam.corbomite, beam.rangeMultiplier, beam.trackingMultiplier, beam.specialFunction, beam.eccm, beam.ctd, beam.obsolete], [null, null, null, null, null, null, null, null, null, null])
  })
})

check('loaders: a save without a column the read cannot do without is refused by name, and the flag of a level is read only when the save has it', async (m) => {
  const component = WHOLE_COMPONENTS
  const lacking = (column) => [component.replace(new RegExp(`, ${column} \\w+`), ''), 'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer, Obsolete integer)']

  await withMemory(lacking('MaxSensorRange'), async (database) => {
    await assert.rejects(() => m.dd.ownedActiveSensors(database, 1, 2), /The save lacks FCT_ShipDesignComponents\.MaxSensorRange, which the active sensor read needs/)
    assert.deepEqual(await m.dd.ownedBeamFireControls(database, 1, 2), [], 'the beam read does not need the sensor range')
  })

  await withMemory(lacking('Resolution'), async (database) => {
    await assert.rejects(() => m.dd.ownedActiveSensors(database, 1, 2), /FCT_ShipDesignComponents\.Resolution/)
  })

  await withMemory(lacking('TrackingSpeed'), async (database) => {
    await assert.rejects(() => m.dd.ownedBeamFireControls(database, 1, 2), /The save lacks FCT_ShipDesignComponents\.TrackingSpeed, which the beam fire control read needs/)
    assert.deepEqual(await m.dd.ownedActiveSensors(database, 1, 2), [], 'the sensor read does not need the tracking speed')
  })

  await withMemory([component, 'create table FCT_RaceTech (GameID integer, TechID integer)'], async (database) => {
    await assert.rejects(() => m.dd.ownedActiveSensors(database, 1, 2), /FCT_RaceTech\.RaceID/)
    await assert.rejects(() => m.dd.ownedBeamFireControls(database, 1, 2), /FCT_RaceTech\.RaceID/)
  })

  await withMemory([component, 'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer)', ...COMPONENT_ROWS, ...RACE_TECH_ROWS_PLAIN], async (database) => {
    assert.deepEqual((await m.dd.ownedActiveSensors(database, 1, 2)).map((row) => row.obsolete), [null, null], 'a save with no flag')
    assert.deepEqual((await m.dd.ownedBeamFireControls(database, 1, 2)).map((row) => row.obsolete), [null])
  })

  await withMemory(WHOLE_SCHEMA, async (database) => {
    assert.deepEqual((await m.dd.ownedBeamFireControls(database, 1, 2)).map((row) => row.obsolete), [false])
  })
})

// ---------- the saves ----------

// The saves of saves/ the checks read, each { file, database }, opened by `run`.
const SAVES = []

const openSave = (file) => new Promise((resolve, reject) => {
  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(path.join(savesDirectory, file), sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ file, database: appDatabase(raw), close: () => raw.close() })
  })
})

const openSaves = async () => {
  const files = fs.existsSync(savesDirectory) ? fs.readdirSync(savesDirectory).filter((name) => name.endsWith('.db')).sort() : []

  for (const file of files) {
    SAVES.push(await openSave(file))
  }
}

const racesOf = async (save) => {
  const [rows] = await save.database.query('select distinct GameID, RaceID from FCT_RaceTech order by GameID, RaceID')

  return rows
}

// The beam fire controls of one modded save the rules do not reproduce, by the first figure that differs: two whose Uridium and cost are a tenth of the rule's, six whose stored range is above the 1,400,000 km cap (their cost is a tenth of the rule's too) and six whose range or tracking speed no distance or speed level the race holds gives.
const PINNED_BEAMS = Object.freeze({
  file: 'AuroraDB_270_unknown.db',
  game: 140,
  race: 784,
  ids: Object.freeze({ cost: [500213, 500265], range: [500389, 500390, 500391, 500392, 500810, 500811], level: [500238, 500240, 500380, 500598, 500599, 500809] }),
})

const cache = new WeakMap()

const once = (m, key, build) => {
  if (!cache.has(m)) {
    cache.set(m, new Map())
  }

  const store = cache.get(m)

  if (!store.has(key)) {
    store.set(key, build())
  }

  return store.get(key)
}

const levelOf = (entries, rating) => entries.find((entry) => entry.level.info !== null && Math.trunc(entry.level.info) === rating)

// The planner's tech of a saved sensor: the strength tech the stored strength implies, the EM level the race holds that the stored range implies (none gives no tech), the hardening and ECCM levels the race holds that its CTD and ECCM name.
const techOfSavedSensor = (st, tech, row) => {
  const mode = row.kind === 'fireControl' ? 2 : 1
  const strengthTech = row.strength / row.sizeHS
  const impliedEm = (row.rangeKm / mode / 1e6) ** 2 * 3.1416 / (row.strength * row.resolution ** (2 / 3))
  const emLevel = tech.lines[EM].levels.find((item) => Math.abs(item.info - impliedEm) <= 1e-3 * item.info)
  const emTech = emLevel ? emLevel.info : null
  const hardening = levelOf(st.levels.hardening, row.ctd)
  const eccm = levelOf(st.levels.eccm, row.eccm)

  if (!hardening || !eccm || !(strengthTech > 0) || !(emTech > 0)) {
    return null
  }

  return { hardening, eccm, tech: { ...st, strength: { ...st.strength, info: strengthTech }, em: { ...st.em, info: emTech }, hardening: { ...st.hardening, info: hardening.level.info, info2: hardening.level.info2 }, eccm: { ...st.eccm, info: eccm.level.info, info2: eccm.level.info2 }, levels: { hardening: [hardening], eccm: [eccm] } }, mode }
}

// Every saved active sensor of a save rebuilt through the planner: sized at its own resolution to its own range (the smallest legal size is the stored one when the stored size is on the design window's ladder) and its cost, Uridium and Corbomite read from the level pair of its hardening and ECCM.
const rebuildActive = (m, save) => once(m, `active ${save.file}`, async () => {
  const tally = { races: 0, rows: 0, unmatched: 0, offWindow: 0, unsized: 0, rebuilt: 0, onLadder: 0, offLadder: 0, mineralsOk: 0 }
  const mismatches = { size: [], minerals: [] }

  for (const { GameID, RaceID } of await racesOf(save)) {
    const tech = await m.ts.loadTechChoices(save.database, { GameID, RaceID })
    const st = m.sp.sensorTechOf(tech, m.ts.resolveChoices(tech))
    const rows = await m.dd.ownedActiveSensors(save.database, GameID, RaceID)

    tally.races++

    for (const row of rows) {
      tally.rows++

      if (!(row.strength > 0) || !(row.rangeKm > 0) || !(row.resolution > 0) || !(row.sizeHS > 0)) {
        tally.unmatched++
        continue
      }

      const saved = techOfSavedSensor(st, tech, row)

      if (!saved) {
        tally.unmatched++
        continue
      }

      if (!m.dr.SENSOR_RESOLUTIONS_HS.includes(row.resolution)) {
        tally.offWindow++
        continue
      }

      const searchRange = row.rangeKm / (row.kind === 'fireControl' ? 2 : 1)
      const sizing = m.sp.activeSizing({ target: tonsTarget(m, row.resolution * 50), wantedRangeKm: searchRange, resolution: row.resolution, tech: saved.tech })
      const member = sizing.selected && sizing.selected.search
      const label = `${save.file} game ${GameID} race ${RaceID} ${row.id} ${row.name}`

      if (!member || member.sizeHS === null) {
        tally.unsized++
        continue
      }

      const onLadder = m.dr.SENSOR_SIZES_HS.includes(row.sizeHS)

      tally.rebuilt++
      tally.onLadder += onLadder ? 1 : 0
      tally.offLadder += onLadder ? 0 : 1

      if (onLadder ? !near(member.sizeHS, row.sizeHS) : member.sizeHS < row.sizeHS) {
        mismatches.size.push(`${label}: stored ${row.sizeHS} HS, the smallest legal size is ${member.sizeHS} HS`)
      }

      if (onLadder) {
        const tradeoff = m.sp.hardeningEccmTradeoff({ sizing, tech: saved.tech })
        const entry = tradeoff.rows[0]
        const design = entry ? entry.search : null

        if (design && design.status !== 'unavailable' && near(design.value.uridium, row.uridium) && near(design.value.cost, row.cost) && near(design.value.corbomite, row.corbomite)) {
          tally.mineralsOk++
        } else {
          mismatches.minerals.push(`${label}: stored Uridium ${row.uridium}, cost ${row.cost}, Corbomite ${row.corbomite}; rebuilt ${design && design.value ? `${design.value.uridium}, ${design.value.cost}, ${design.value.corbomite}` : 'nothing'}`)
        }
      }
    }
  }

  return { tally, mismatches }
})

check('minerals (save): the Uridium, cost and Corbomite of every saved active sensor are rebuilt from the hardening and ECCM levels', async (m) => {
  if (!SAVES.length) {
    return skipped('no save in saves/')
  }

  const lines = []
  let rebuilt = 0
  let unmatched = 0
  const unexplained = []

  for (const save of SAVES) {
    const { tally, mismatches } = await rebuildActive(m, save)

    rebuilt += tally.mineralsOk
    unmatched += tally.unmatched
    unexplained.push(...mismatches.minerals)
    lines.push(`${save.file}: ${tally.rows} active sensors and fire controls in ${tally.races} races, ${tally.mineralsOk} rebuilt in Uridium, cost and Corbomite, ${tally.unmatched} naming no level of the race, ${tally.offLadder} of a size off the ladder, ${tally.unsized} beyond the largest size`)
  }

  assert.deepEqual(unexplained.slice(0, 10), [], 'the stored minerals the levels do not reproduce')
  assert.equal(unmatched, 0, 'saved sensors that name no EM, hardening or ECCM level the race holds')
  assert.ok(rebuilt > 0, 'no sensor was rebuilt')
  lines.push(`${rebuilt} saved active sensors over ${SAVES.length} saves`)

  return { lines }
})

check('saves: a saved active sensor is the smallest legal size that reaches its own range at its own resolution, or a size off the ladder just above', async (m) => {
  if (!SAVES.length) {
    return skipped('no save in saves/')
  }

  const lines = []
  let rebuilt = 0
  let unmatched = 0
  const unexplained = []

  for (const save of SAVES) {
    const { tally, mismatches } = await rebuildActive(m, save)

    rebuilt += tally.rebuilt
    unmatched += tally.unmatched
    unexplained.push(...mismatches.size)
    lines.push(`${save.file}: ${tally.rebuilt} sensors sized (${tally.onLadder} on the ladder, ${tally.offLadder} off it), ${tally.offWindow} of a resolution off the design window, ${tally.unsized} beyond the largest size`)
  }

  assert.deepEqual(unexplained.slice(0, 10), [], 'sizes the planner does not reproduce')
  assert.equal(unmatched, 0, 'saved sensors that name no EM, hardening or ECCM level the race holds')
  assert.ok(rebuilt > 0, 'no sensor was sized')

  return { lines }
})

// Every beam fire control of a save rebuilt through the planner's table at its own multipliers and the distance and speed levels that give its range and tracking speed: the mismatches by id and the first field that differs.
const rebuildBeams = (m, save) => once(m, `beam ${save.file}`, async () => {
  const tally = { races: 0, rows: 0, rebuilt: 0, planner: 0 }
  const mismatches = []

  for (const { GameID, RaceID } of await racesOf(save)) {
    const tech = await m.ts.loadTechChoices(save.database, { GameID, RaceID })
    const st = m.sp.sensorTechOf(tech, m.ts.resolveChoices(tech))
    const rows = await m.dd.ownedBeamFireControls(save.database, GameID, RaceID)

    tally.races++

    for (const row of rows) {
      tally.rows++

      const hardening = levelOf(st.levels.hardening, row.ctd)
      const eccm = levelOf(st.levels.eccm, row.eccm)
      const distances = (tech.lines[m.rt.SENSOR_PLANNER_LINES.distance] || { levels: [] }).levels
      const speeds = (tech.lines[m.rt.SENSOR_PLANNER_LINES.speed] || { levels: [] }).levels
      const distance = distances.find((item) => near(item.info * row.rangeMultiplier, row.rangeKm) || near(Math.min(1400000, item.info * row.rangeMultiplier), row.rangeKm))
      const speed = speeds.find((item) => near(m.dr.fireControlTracking(row.trackingMultiplier, item.info), row.trackingKmS))
      const record = { file: save.file, game: GameID, race: RaceID, id: row.id, name: row.name }

      if (!hardening || !eccm || !(row.rangeMultiplier > 0) || !(row.trackingMultiplier > 0)) {
        mismatches.push({ ...record, field: 'tech' })
        continue
      }

      if (!distance || !speed) {
        mismatches.push({ ...record, field: 'level' })
        continue
      }

      const singleWeapon = row.specialFunction === m.dr.FIRE_CONTROL_SPECIAL.singleWeapon
      const number = { number: singleWeapon ? 0.5 : 1, level: { name: 'stored' }, hypothetical: false, assumption: null }
      const tech2 = { ...st, distance: { ...st.distance, info: distance.info }, speed: { ...st.speed, info: speed.info }, hardening: { ...st.hardening, info: hardening.level.info, info2: hardening.level.info2 }, eccm: { ...st.eccm, info: eccm.level.info, info2: eccm.level.info2 }, singleWeapon: { ...st.singleWeapon, weapons: { unrestricted: number, single: number } } }
      const legal = m.dr.FIRE_CONTROL_MULTIPLIERS.includes(row.rangeMultiplier) && m.dr.FIRE_CONTROL_MULTIPLIERS.includes(row.trackingMultiplier)
      const entry = legal ? m.sp.beamSizing({ rangeKm: row.rangeKm, trackingKmS: row.trackingKmS, tech: tech2, singleWeapon, multipliers: { range: [row.rangeMultiplier], tracking: [row.trackingMultiplier] } }).table.rows.find((item) => item.rangeMultiplier === row.rangeMultiplier && item.trackingMultiplier === row.trackingMultiplier) : null
      const design = entry ? (entry.design.status !== 'unavailable' ? entry.design.value : null) : m.dr.beamFireControlDesign({ rangeMultiplier: row.rangeMultiplier, trackingMultiplier: row.trackingMultiplier, distanceRating: distance.info, speedRating: speed.info, weaponNumber: number.number, hardeningRating: hardening.level.info, hardeningCost: hardening.level.info2, eccmRating: eccm.level.info, eccmCost: eccm.level.info2, maxRangeKm: row.rangeKm > 1400000 ? Infinity : 1400000 })
      const field = !design ? 'design' : !near(design.rangeKm, row.rangeKm) ? 'range' : !near(design.trackingKmS, row.trackingKmS) ? 'tracking' : !near(design.sizeHS, row.sizeHS) ? 'size' : !near(design.cost, row.cost) ? 'cost' : null

      if (field) {
        mismatches.push({ ...record, field })
      } else {
        tally.rebuilt++
        tally.planner += legal ? 1 : 0
      }
    }
  }

  return { tally, mismatches }
})

check('saves: the beam fire controls of every save are rebuilt from the distance, speed, hardening and ECCM levels, but for the pinned rows', async (m) => {
  if (!SAVES.length) {
    return skipped('no save in saves/')
  }

  const lines = []
  const unexplained = []
  const seen = new Set()
  let rebuilt = 0

  for (const save of SAVES) {
    const { tally, mismatches } = await rebuildBeams(m, save)
    const own = mismatches.filter((mismatch) => {
      const pinned = mismatch.file === PINNED_BEAMS.file && mismatch.game === PINNED_BEAMS.game && mismatch.race === PINNED_BEAMS.race && PINNED_BEAMS.ids[mismatch.field] && PINNED_BEAMS.ids[mismatch.field].includes(mismatch.id)

      if (pinned) {
        seen.add(mismatch.id)
      }

      return pinned
    })

    unexplained.push(...mismatches.filter((mismatch) => !own.includes(mismatch)).map((mismatch) => `${mismatch.file} game ${mismatch.game} race ${mismatch.race} ${mismatch.id} ${mismatch.name}: ${mismatch.field}`))
    rebuilt += tally.rebuilt
    lines.push(`${save.file}: ${tally.rows} beam fire controls in ${tally.races} races, ${tally.rebuilt} rebuilt (${tally.planner} through the planner's table, the rest at a multiplier off the legal ladder), ${mismatches.length} differing, of which ${own.length} pinned`)
  }

  assert.deepEqual(unexplained.slice(0, 40), [], 'beam fire controls no pinned row explains')

  const pinned = Object.values(PINNED_BEAMS.ids).flat()

  if (SAVES.some((save) => save.file === PINNED_BEAMS.file)) {
    assert.deepEqual([...seen].sort(), [...pinned].sort(), 'every pinned control is still a mismatch')
  }

  assert.ok(rebuilt > 0, 'no beam fire control was rebuilt')
  lines.push(`${rebuilt} beam fire controls rebuilt over ${SAVES.length} saves`)

  return { lines }
})

// ---------- the faults ----------

// Each fault is planted in one module: `find` must occur once in `file`, and every check beginning with a name of `fails` must fail on the copy.
const MUTATIONS = [
  { name: 'the fire control sized by the search signature of a missile', file: 'sensor-planner.js', find: 'fireControl: { signature: target && target.fireControlSignature ? target.fireControlSignature : signatureOf(target), jammer', replace: 'fireControl: { signature: signatureOf(target), jammer', fails: ['pair: against a missile target', 'limiting: a saved fire control', 'minerals: against a missile target'] },
  { name: 'the jammer applied to a fire control against a missile', file: 'sensor-planner.js', find: 'jammer: target && target.fireControlJammer === false ? 0 : jammer } })', replace: 'jammer } })', fails: ['pair: against a missile target', 'limiting: a saved fire control', 'minerals: against a missile target'] },
  { name: 'the fire control signature floor of a missile 0.3', file: 'design-rules.js', find: 'export const MISSILE_FIRE_CONTROL_SIGNATURE_MIN = 0.33', replace: 'export const MISSILE_FIRE_CONTROL_SIGNATURE_MIN = 0.3', fails: ['target: a missile gives', 'pair: against a missile target'] },
  { name: 'the fire control signature of a missile over 20 MSP per HS', file: 'design-rules.js', find: 'Math.max(sizeMsp, MISSILE_FIRE_CONTROL_SIGNATURE_MIN)', replace: 'Math.max(sizeMsp / 20, MISSILE_FIRE_CONTROL_SIGNATURE_MIN)', fails: ['target: a missile gives', 'limiting: a saved fire control'] },
  { name: 'a saved fire control measured by the search signature', file: 'sensor-planner.js', find: 'signature: fireControl ? scenario.fireControlSignature : scenario.signature', replace: 'signature: scenario.signature', fails: ['target: a saved fire control'] },
  { name: 'a missile scenario that drops the jammer policy of the fire control', file: 'sensor-planner.js', find: 'fireControlSignature, searchJammer: false, fireControlJammer: false })])', replace: 'fireControlSignature, searchJammer: false })])', fails: ['target: each scenario of a target'] },
  { name: 'a missile scenario that drops the jammer policy of the search sensor', file: 'sensor-planner.js', find: 'fireControlSignature, searchJammer: false, fireControlJammer: false })])', replace: 'fireControlSignature, fireControlJammer: false })])', fails: ['target: each scenario of a target', 'jammer: a missile target'] },
  { name: 'a missile target that takes the jammer on the search sensor', file: 'sensor-planner.js', find: 'return Object.freeze({ kind, label, signature, fireControlSignature, searchJammer: false,', replace: 'return Object.freeze({ kind, label, signature, fireControlSignature, searchJammer: true,', fails: ['target: a missile gives', 'target: each scenario of a target'] },
  { name: 'the reach of a trade-off row without the provenance of its designs', file: 'sensor-planner.js', find: 'jammer: jamming, source: design })', replace: 'jammer: jamming })', fails: ['research: the reach of each hardening'] },
  { name: 'a held weapon number row with no number read as absent', file: 'sensor-planner.js', find: 'if (weapons.currentUnknown || (!weapon && weapons.unknown.length)) {', replace: 'if (false) {', fails: ['beam: a weapon number row'] },
  { name: 'an absent weapon number row read as unknown', file: 'sensor-planner.js', find: '(!weapon && weapons.unknown.length)', replace: '(!weapon && !singleWeapon)', fails: ['beam: a weapon number row'] },
  { name: 'the chosen weapon number level with no number ignored', file: 'sensor-planner.js', find: 'weapons.currentUnknown || (', replace: '(', fails: ['beam: a weapon number row'] },
  { name: 'a zero wanted range of a saved pair taken as asked', file: 'sensor-planner.js', find: 'const wanted = positiveOf(wantedRangeKm)\n  const inputs', replace: 'const wanted = numberOf(wantedRangeKm)\n  const inputs', fails: ['limiting: a wanted range or tracking speed'] },
  { name: 'a zero request of a saved beam control taken as asked', file: 'sensor-planner.js', find: 'const wantedRange = positiveOf(rangeKm)\n  const wantedTracking = positiveOf(trackingKmS)', replace: 'const wantedRange = numberOf(rangeKm)\n  const wantedTracking = numberOf(trackingKmS)', fails: ['limiting: a wanted range or tracking speed'] },
  { name: 'a saved fire control under the jammer of a missile target', file: 'sensor-planner.js', find: '(fireControl ? scenario.fireControlJammer : scenario.searchJammer) === false ? 0 : jam', replace: 'fireControl ? jam : scenario.searchJammer === false ? 0 : jam', fails: ['target: a saved fire control'] },
  { name: 'a saved search sensor under the jammer of a missile target', file: 'sensor-planner.js', find: '(fireControl ? scenario.fireControlJammer : scenario.searchJammer) === false ? 0 : jam', replace: 'fireControl && scenario.fireControlJammer === false ? 0 : jam', fails: ['target: a saved fire control', 'jammer: a missile target'] },
  { name: 'the tradeoff reach of both members against the search signature', file: 'sensor-planner.js', find: '[fireControl, fireControlSignature, fireControlJammer]', replace: '[fireControl, signature, fireControlJammer]', fails: ['minerals: against a missile target'] },
  { name: 'the tradeoff reach of the search sensor under the jammer of a missile target', file: 'sensor-planner.js', find: '[search, signature, searchJammer]', replace: '[search, signature, sizing.request.jammer]', fails: ['minerals: against a missile target', 'jammer: a missile target'] },
  { name: 'the jammer applied to a search sensor against a missile', file: 'sensor-planner.js', find: 'search: { signature: signatureOf(target), jammer: target && target.searchJammer === false ? 0 : jammer }', replace: 'search: { signature: signatureOf(target), jammer }', fails: ['pair: against a missile target', 'limiting: a saved fire control', 'minerals: against a missile target', 'jammer: a missile target'] },
  { name: 'the jammer dropped from the search sensor against a ship', file: 'sensor-planner.js', find: 'jammer: target && target.searchJammer === false ? 0 : jammer }, fireControl', replace: 'jammer: 0 }, fireControl', fails: ['pair: a jammer is cut by 0.75', 'jammer: a missile target'] },
  { name: 'the best pair the dearest', file: 'sensor-planner.js', find: 'a.totalCost.value - b.totalCost.value', replace: 'b.totalCost.value - a.totalCost.value', fails: ['pair: the best row'] },
  { name: 'a tie broken to the lower resolution', file: 'sensor-planner.js', find: 'b.resolution - a.resolution', replace: 'a.resolution - b.resolution', fails: ['pair: the best row'] },
  { name: 'the fire control sized as a search sensor', file: 'sensor-planner.js', find: 'mode: SENSOR_MODES.missileFireControl, name', replace: 'mode: SENSOR_MODES.search, name', fails: ['pair: each member', 'pair: the fire control'] },
  { name: 'the jammer left out of the sizing', file: 'sensor-planner.js', find: 'const inputs = inputsOf(target, jam)\n  const context', replace: 'const inputs = inputsOf(target, 0)\n  const context', fails: ['pair: each member', 'pair: a jammer'] },
  { name: 'the ECCM left out of the sizing', file: 'sensor-planner.js', find: 'emTech: tech.em.info, jammer, eccm: eccmOf(tech) })', replace: 'emTech: tech.em.info, jammer, eccm: 0 })', fails: ['pair: each member', 'pair: a jammer'] },
  { name: 'a blank jammer unknown', file: 'sensor-planner.js', find: "value.trim() === '') ? 0 : numberOf(value))", replace: "value.trim() === '') ? null : numberOf(value))", fails: ['pair: a jammer'] },
  { name: 'the jammer base of 0.8', file: 'design-rules.js', find: 'export const SENSOR_JAMMER_BASE = 0.75', replace: 'export const SENSOR_JAMMER_BASE = 0.8', fails: ['pair: each member', 'pair: a jammer'] },
  { name: 'the cost of a pair that of the search sensor', file: 'sensor-planner.js', find: "compute: (values) => values.search + values['missile fire control'], units: 'BP' })", replace: "compute: (values) => values.search, units: 'BP' })", fails: ['pair: the totals', 'pair: the best row'] },
  { name: 'the reach of a pair the longer member', file: 'sensor-planner.js', find: "Math.min(values.search, values['fire control'])", replace: "Math.max(values.search, values['fire control'])", fails: ['pair: the totals', 'limiting: a saved pair'] },
  { name: 'a pair that has no cost best by its cost anyway', file: 'sensor-planner.js', find: "const bestBasis = priced.length ? 'cost' : feasible.length ? 'size' : null", replace: "const bestBasis = feasible.length ? 'cost' : null", fails: ['pair: an unknown'] },
  { name: 'the chosen resolution off the window taken as the best', file: 'sensor-planner.js', find: "const wantedResolution = resolution === 'best' ? 'best' : numberOf(resolution)", replace: "const wantedResolution = 'best'", fails: ['pair: the resolution chosen'] },
  { name: 'the limiting member always the search sensor', file: 'sensor-planner.js', find: 'limiting: meets === false ? limitingOf(members.search, members.fireControl) : null', replace: "limiting: meets === false ? 'search' : null", fails: ['limiting: a saved pair'] },
  { name: 'the shorter of two members that fall short flipped', file: 'sensor-planner.js', find: "return falling[1][1].reach.value < falling[0][1].reach.value ? 'fireControl' : 'search'", replace: "return falling[1][1].reach.value > falling[0][1].reach.value ? 'fireControl' : 'search'", fails: ['limiting: a saved pair'] },
  { name: 'the alternative never at the saved resolution', file: 'sensor-planner.js', find: 'const atSaved = savedResolution === null ? null :', replace: 'const atSaved = true ? null :', fails: ['limiting: the alternative'] },
  { name: 'the Uridium of the tradeoff the Corbomite', file: 'sensor-planner.js', find: "uridium: total('uridium', 'Uridium')", replace: "uridium: total('corbomite', 'Uridium')", fails: ['minerals: the hardening'] },
  { name: 'the hardening and ECCM cost factors swapped', file: 'sensor-planner.js', find: 'hardeningCost: entryHardening.level.info2, eccmRating: entryEccm.level.info, eccmCost: entryEccm.level.info2, mode: member.mode', replace: 'hardeningCost: entryEccm.level.info2, eccmRating: entryEccm.level.info, eccmCost: entryHardening.level.info2, mode: member.mode', fails: ['minerals: the hardening', 'minerals (save)'] },
  { name: 'the tradeoff reach at the ECCM of the race', file: 'sensor-planner.js', find: 'const eccm = entryEccm.level.info === null ? null : Math.trunc(entryEccm.level.info)', replace: 'const eccm = eccmOf(figures)', fails: ['minerals: the reach'] },
  { name: 'a candidate marked researched', file: 'sensor-planner.js', find: 'researched: false, hypothetical: true, current: Boolean(resolved && resolved.hypothetical', replace: 'researched: true, hypothetical: true, current: Boolean(resolved && resolved.hypothetical', fails: ['research: a candidate'] },
  { name: 'the design of a hypothetical level not marked', file: 'sensor-planner.js', find: 'marked(designOf({ sizeHS, resolution, mode: member.mode, tech, sizing }), marksOf(tech, DESIGN_ROLES))', replace: 'designOf({ sizeHS, resolution, mode: member.mode, tech, sizing })', fails: ['research: a hypothetical'] },
  { name: 'the sizing of a hypothetical level not marked', file: 'sensor-planner.js', find: "marksOf(tech, jammer > 0 ? ['strength', 'em', 'eccm'] : ['strength', 'em'])", replace: '[]', fails: ['research: a hypothetical'] },
  { name: 'the sizing marked by an ECCM no jammer meets', file: 'sensor-planner.js', find: "marksOf(tech, jammer > 0 ? ['strength', 'em', 'eccm'] : ['strength', 'em'])", replace: "marksOf(tech, ['strength', 'em', 'eccm'])", fails: ['research: a hypothetical'] },
  { name: 'an unresolved choice designed with its own level', file: 'sensor-planner.js', find: 'const resolved = resolution ? resolution[typeId] : null\n  const level = resolved ? levelOf(resolved.level) : null', replace: "const resolved = resolution ? resolution[typeId] : null\n  const level = resolved ? levelOf(resolved.level || null) : null\n  if (resolved && resolved.unresolved) { return { role, typeId, label: LINE_LABELS[role], level: null, info: 0, info2: 0, kind: 'none', hypothetical: false, assumption: null, unresolved: resolved.unresolved } }", fails: ['research: an unresolved choice'] },
  { name: 'the single weapon switch always offered', file: 'sensor-planner.js', find: 'offersSingle: weapons.single !== null', replace: 'offersSingle: true', fails: ['research: the single weapon'] },
  { name: 'the single weapon number taken from any level', file: 'sensor-planner.js', find: 'entry.level.info > 0 && entry.level.info < 1', replace: 'entry.level.info > 0', fails: ['research: the single weapon', 'beam: a single weapon'] },
  { name: 'the single weapon tech not of the sensor family', file: 'race-tech.js', find: "'Single Weapon Fire Control', 'sensor', 'none'", replace: "'Single Weapon Fire Control', 'armour', 'none'", fails: ['research: the planner lines'] },
  { name: 'the single weapon line under another type', file: 'race-tech.js', find: 'family(SINGLE_WEAPON_TECH_TYPE, ', replace: 'family(SINGLE_WEAPON_TECH_TYPE + 1000, ', fails: ['research: the planner lines', 'research: the single weapon', 'beam: a single weapon'] },
  { name: 'the distance line read as the speed line', file: 'race-tech.js', find: 'distance: FIRE_CONTROL_RANGE_TECH_TYPE, speed: FIRE_CONTROL_SPEED_TECH_TYPE', replace: 'distance: FIRE_CONTROL_SPEED_TECH_TYPE, speed: FIRE_CONTROL_SPEED_TECH_TYPE', fails: ['research: the planner lines', 'beam: the range and the tracking'] },
  { name: 'the range cap not applied to the reach', file: 'sensor-planner.js', find: 'reachKm: sized ? (isRange ? Math.min(cap, value.multiplier * rating.info)', replace: 'reachKm: sized ? (isRange ? value.multiplier * rating.info', fails: ['beam: a range above the cap'] },
  { name: 'a range above the cap not beyond it', file: 'sensor-planner.js', find: 'const beyondCap = isRange && wanted !== null && wanted > cap', replace: 'const beyondCap = isRange && wanted !== null && wanted > cap * 2', fails: ['beam: a range above the cap'] },
  { name: 'the axes read each other\'s wanted figure', file: 'sensor-planner.js', find: 'rangeKm: isRange ? wanted : 1, trackingKmS: isRange ? 1 : wanted', replace: 'rangeKm: isRange ? 1 : wanted, trackingKmS: isRange ? wanted : 1', fails: ['beam: the range and the tracking', 'beam: a single weapon'] },
  { name: 'a single weapon control with the unrestricted number', file: 'sensor-planner.js', find: 'const weapon = singleWeapon ? weapons.single : weapons.unrestricted', replace: 'const weapon = weapons.unrestricted || weapons.single', fails: ['beam: a single weapon'] },
  { name: 'the table designed with a weapon number of 1', file: 'sensor-planner.js', find: "beamInputsOf(tech, values['weapon number'])", replace: 'beamInputsOf(tech, 1)', fails: ['beam: the table', 'saves: the beam'] },
  { name: 'the sized pair not flagged in the table', file: 'sensor-planner.js', find: 'proposed: Boolean(proposedPair) && proposedPair[0] === rangeMultiplier && proposedPair[1] === trackingMultiplier', replace: 'proposed: false', fails: ['beam: the table'] },
  { name: 'both axes of a saved control reported as the range', file: 'sensor-planner.js', find: "limiting: falling.length === 2 ? 'both' : falling.length ? falling[0] : null", replace: "limiting: falling.length === 2 ? 'range' : falling.length ? falling[0] : null", fails: ['beam: a saved control'] },
  { name: 'a blank size the target of 0', file: 'sensor-planner.js', find: 'const signature = unavailable({ rule: SENSOR_RULES.detection, missing: [missing] })', replace: 'const signature = ofRule({ rule: SENSOR_RULES.detection, value: 0, inputs: { present: [] } })', fails: ['target: a blank'] },
  { name: 'no floor under a target in tons', file: 'sensor-planner.js', find: 'classCrossSection({ sizeHS: size / TONS_PER_HS })', replace: 'size / TONS_PER_HS', fails: ['target: a size in tons'] },
  { name: 'a missile read as a twentieth of its size again', file: 'sensor-planner.js', find: 'missileSignature({ sizeMsp: size })', replace: 'missileSignature({ sizeMsp: size / 20 })', fails: ['target: a missile'] },
  { name: 'the first scenario of a cloaked class the uncloaked size', file: 'sensor-planner.js', find: 'signature: crossSection.effective, fireControlSignature: crossSection.effective, searchJammer: true, fireControlJammer: true })]', replace: 'signature: crossSection.uncloaked, fireControlSignature: crossSection.uncloaked, searchJammer: true, fireControlJammer: true })]', fails: ['target: a saved class'] },
  { name: 'the active sensor range read from the component value', file: 'design-data.js', find: 'rangeKm: row.MaxSensorRange,', replace: 'rangeKm: row.ComponentValue,', fails: ['loaders: the active', 'minerals (save)', 'saves: a saved active sensor'] },
  { name: 'the active sensors of every race read', file: 'design-data.js', find: 'c.GameID in (0, :game) and r.GameID = :game and r.RaceID = :race order by c.SDComponentID`, { replacements: { game, race } })\n\n  return rows.map((row) => Object.freeze({\n    id: row.SDComponentID,\n    name: row.Name,\n    type: row.ComponentTypeID,\n    kind', replace: 'c.GameID in (0, :game) and r.GameID = :game order by c.SDComponentID`, { replacements: { game, race } })\n\n  return rows.map((row) => Object.freeze({\n    id: row.SDComponentID,\n    name: row.Name,\n    type: row.ComponentTypeID,\n    kind', fails: ['loaders: the active'] },
  { name: 'the beam fire controls of every race read', file: 'design-data.js', find: 'c.GameID in (0, :game) and r.GameID = :game and r.RaceID = :race order by c.SDComponentID`, { replacements: { game, race } })\n\n  return rows.map((row) => Object.freeze({\n    id: row.SDComponentID,\n    name: row.Name,\n    type: row.ComponentTypeID,\n    sizeHS', replace: 'c.GameID in (0, :game) and r.GameID = :game order by c.SDComponentID`, { replacements: { game, race } })\n\n  return rows.map((row) => Object.freeze({\n    id: row.SDComponentID,\n    name: row.Name,\n    type: row.ComponentTypeID,\n    sizeHS', fails: ['loaders: the beam'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the optional columns of an active sensor read by their table', file: 'design-data.js', find: "${selectedColumns('c', componentColumns, ACTIVE_SENSOR_OPTIONAL)}", replace: 'c.Cost as Cost, c.Crew as Crew, c.Uridium as Uridium, c.Corbomite as Corbomite, c.ComponentValue as ComponentValue, c.ECCM as ECCM, c.ElectronicCTD as ElectronicCTD', fails: ['loaders: a save without the optional'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the optional columns of a beam fire control read by their table', file: 'design-data.js', find: "${selectedColumns('c', componentColumns, BEAM_FIRE_CONTROL_OPTIONAL)}", replace: 'c.Cost as Cost, c.Crew as Crew, c.Uridium as Uridium, c.Corbomite as Corbomite, c.FCRangeModifier as FCRangeModifier, c.FCSpeedModifier as FCSpeedModifier, c.SpecialFunction as SpecialFunction, c.ECCM as ECCM, c.ElectronicCTD as ElectronicCTD', fails: ['loaders: a save without the optional'] },
  { name: 'a fire control read as a search sensor', file: 'design-data.js', find: "kind: row.ComponentTypeID === SENSOR_COMPONENT_TYPES.missileFireControl ? 'fireControl' : 'search'", replace: "kind: row.ComponentTypeID === SENSOR_COMPONENT_TYPES.missileFireControl ? 'search' : 'fireControl'", fails: ['loaders: the active'] },
  { name: 'the tracking speed read from the speed multiplier', file: 'design-data.js', find: 'trackingKmS: row.TrackingSpeed,', replace: 'trackingKmS: row.FCSpeedModifier,', fails: ['loaders: the beam', 'saves: the beam'] },
  { name: 'the sensor range no required column', file: 'design-data.js', find: "'Size', 'MaxSensorRange', 'Resolution'])", replace: "'Size', 'Resolution'])", fails: ['loaders: a save without a column'] },
  { name: 'the obsolete flag never read', file: 'design-data.js', find: "const SENSOR_RACE_TECH_OPTIONAL = Object.freeze(['Obsolete'])", replace: 'const SENSOR_RACE_TECH_OPTIONAL = Object.freeze([])', fails: ['loaders: the active', 'loaders: the beam'] },
  { name: 'the reach of a saved sensor table drops the design of a proposed one', file: 'sensor-planner.js', find: "...(source ? { 'sensor design': source } : {}) }", replace: '}', fails: ['target: a reach of a proposed sensor'] },
  { name: 'the curve drops the design of a proposed sensor', file: 'sensor-planner.js', find: "parts: { reach, 'sensor design': source }, compute: (values) => values.reach, units: 'km' }) : reach)", replace: "parts: { reach }, compute: (values) => values.reach, units: 'km' }) : reach)", fails: ['target: a reach of a proposed sensor'] },
  { name: 'a stored beam range above the cap is not marked', file: 'sensor-planner.js', find: 'const aboveCap = cap !== null && known !== null && known > cap', replace: 'const aboveCap = false', fails: ['beam: a stored range above the cap'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a stored beam range above the cap is cut to it', file: 'sensor-planner.js', find: 'value: known, inputs: { present: [`stored ${label}`] }, assumptions })', replace: 'value: cap !== null ? Math.min(known, cap) : known, inputs: { present: [`stored ${label}`] }, assumptions })', fails: ['beam: a stored range above the cap'] },
]

const parseArguments = (argv) => {
  const options = { mutations: true }

  for (const argument of argv) {
    if (argument === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argument}`)
      process.exit(2)
    }
  }

  return options
}

const isSkip = (result) => result !== null && typeof result === 'object' && typeof result.skipped === 'string'

// One check on the modules given: 'pass', 'fail' (with the reason) or 'skip' (with the reason), and the lines it reports.
const attempt = async (entry, m) => {
  try {
    const result = await entry.run(m)

    return isSkip(result) ? { state: 'skip', reason: result.skipped } : { state: 'pass', lines: (result && result.lines) || [] }
  } catch (error) {
    return { state: 'fail', reason: String(error.message).split('\n').join(' | ') }
  }
}

let failures = 0
let passed = 0
let skips = 0

const report = (state, name, detail = '') => {
  if (state === 'skip') {
    skips++
    console.log(`SKIP  ${name}  [${detail}]`)

    return
  }

  if (state === 'pass') {
    passed++
  } else {
    failures++
  }

  console.log(`${state === 'pass' ? 'PASS' : 'FAIL'}  ${name}${state === 'pass' ? '' : `  [${detail}]`}`)
}

// A planted fault: the checks it names run on the faulty copy, and each name must have a check that fails (or only skipped ones, which skip the fault as well).
const runMutation = async (mutation) => {
  let m

  try {
    m = await loadAll(mutation)
  } catch (error) {
    return { state: 'fail', reason: `does not load: ${error.message}` }
  }

  const missed = []
  let caught = 0

  for (const start of mutation.fails) {
    const named = checks.filter((entry) => entry.name.startsWith(start))

    if (!named.length) {
      return { state: 'fail', reason: `no check begins "${start}"` }
    }

    const outcomes = []

    for (const entry of named) {
      outcomes.push(await attempt(entry, m))
    }

    if (outcomes.some((outcome) => outcome.state === 'fail')) {
      caught++
    } else if (!outcomes.every((outcome) => outcome.state === 'skip')) {
      missed.push(start)
    }
  }

  if (missed.length) {
    return { state: 'fail', reason: `these checks did not fail: ${missed.join('; ')}` }
  }

  return caught ? { state: 'pass', detail: `${caught} of the ${mutation.fails.length} names it gives fail` } : { state: 'skip', reason: 'the checks it names read a save that is not there' }
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  await openSaves()
  console.log(`Saves read: ${SAVES.length ? SAVES.map((save) => save.file).join(', ') : 'none (saves/ holds no database)'}`)
  console.log('Sensor sizing: pair, limiting, minerals, research, beam, target, loaders and the saves')

  const real = await loadAll()

  for (const entry of checks) {
    const outcome = await attempt(entry, real)

    report(outcome.state, entry.name, outcome.reason)
    ;(outcome.lines || []).forEach((line) => console.log(`        ${line}`))
  }

  if (options.mutations) {
    console.log('\nMutations: each planted fault must fail the checks it names')

    for (const mutation of MUTATIONS) {
      const outcome = await runMutation(mutation)

      if (outcome.state === 'pass') {
        passed++
        console.log(`PASS  mutation caught: ${mutation.name}  [${outcome.detail}]`)
      } else {
        report(outcome.state, `mutation caught: ${mutation.name}`, outcome.reason)
      }
    }
  }

  SAVES.forEach((save) => save.close())
  console.log(`\n${passed} of ${passed + failures} checks passed${skips ? `, ${skips} skipped (the save they read is not there)` : ''}`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
