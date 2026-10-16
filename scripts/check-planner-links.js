/*
  Checks the links between the Missile Designer, the Sensor Planner, Designed Tech and the Tech Tree: the one query contract of the missile target (utilities/deep-links.js), what a column of the Missile Designer hands to the Sensor Planner (utilities/planner-links.js), how the Sensor Planner takes it and what each page says of an identifier its link names that the save does not hold. The plan is docs/plans/backlog/detailed/TASKS.md, PLAN-INT-01.

  node scripts/check-planner-links.js [--stock <save.db> <GameID> <RaceID>] [--no-mutations]

  Groups (the utilities and the pages' scripts on a pseudo instance, scripts/lib/page-loader.js, over the missile fixtures of scripts/lib; the templates read as text):
  - codec: a missile target round-trips through the query for every source, an unreadable one is refused whole with its reasons, an unknown figure is never written as 0, and the links of the other pages keep their shapes;
  - handoff: a saved missile hands over the figures the save stores and its own ID, a reoptimised or nominated candidate its evaluated figures and tech by ID and kind, with where the figures come from, and a missile whose size or range is not known hands over nothing;
  - resolve: a handed-over missile against the save: held, changed, gone, another race's, unowned, not researched, not read yet or unreadable, each tech level researched, hypothetical, researched since or unusable, and the status each gives the target;
  - sizing: the provenance of the missile target reaches the signature of every sizing figure, the range handed over is the wanted range;
  - sensors: the Sensor Planner opens Active mode on the missile with its size, range, resolution and jammer in the persisted inputs, keeps the link while the inputs are the missile's, drops it on an edit, and tells why it does not apply or what a design it cannot show is;
  - designer: the Missile Designer links every column to the Sensor Planner and to Designed Tech, pins the saved missile a link names and tells why it does not;
  - designed: Designed Tech opens on a missile by its own key, links a missile row to the Missile Designer, and tells why a design or a missile of a link is not shown;
  - template: a data-summary on every panel, the impersonal voice, and every link a keyboard reaches;
  - save: the stock save's missile and component identifiers, held, another race's and gone.

  Mutants: each deliberate fault in a copy of a utility, a page or a template must fail the checks it names.

  Prints `N of N checks passed`; any failed check sets exit code 1. A check whose save is not there is reported as skipped, never as passed.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const utilitiesDirectory = path.join(rendererDirectory, 'utilities')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

const FIELDS_STUB = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => { globalThis.__linksFields = Object.assign(globalThis.__linksFields || {}, fields); return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'

let failures = 0
let checks = 0
let skips = 0

const skipped = (reason) => ({ skipped: reason })

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

const settle = async (test) => {
  try {
    return await test()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const same = (actual, expected) => {
  try {
    assert.deepStrictEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} is not ${short(expected)}`
  }
}

const when = (condition, detail) => (condition ? true : typeof detail === 'string' ? detail : short(detail))

// ---------- the fixtures of the Missile Designer ----------

const FIXTURES = require('./lib/missile-fixtures.json').fixtures

const STOCK = { label: 'stock-271-g138', race: 785 }
const ORDINARY = 154630

const fixtureOf = ({ label, race }) => {
  const fixture = FIXTURES.find((entry) => entry.label === label)

  return { ...fixture, designs: fixture.designs.filter((design) => design.race === race) }
}

let loadedModules = null

const modules = async () => {
  if (!loadedModules) {
    const loaded = await loadUtilities(['deep-links', 'planner-links', 'sensor-planner', 'missile-designer', 'design-rules', 'design-data', 'provenance', 'tech-scenarios', 'race-tech', 'navigation'], { stubs: STUBS })

    loadedModules = { dl: loaded['deep-links'], pl: loaded['planner-links'], sp: loaded['sensor-planner'], md: loaded['missile-designer'], dr: loaded['design-rules'], dd: loaded['design-data'], pv: loaded.provenance, ts: loaded['tech-scenarios'], rt: loaded['race-tech'], nav: loaded.navigation }
  }

  return loadedModules
}

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

const contextOf = (m, overrides = {}) => {
  const fixture = fixtureOf(STOCK)

  return m.md.designerContext({ fixture, resolution: resolutionOf(m, fixture, STOCK.race, overrides), version: null })
}

const compareOf = (m, context, baselineId, alternatives = [], scenario = {}) => m.md.compareDesigns(context, { baselineId, alternatives, scenario })

const keyed = (list) => list.map((entry, index) => ({ ...entry, key: entry.key || `alt-${index + 1}` }))

const draftOf = (m, context, id, change = {}) => ({ ...m.md.seedAlternative(context, id).draft, ...change })

// ---------- the synthetic race of the Sensor Planner ----------

const SENSOR_RACE = 7

const researchedRow = (id, typeId, name, cost, info, info2 = null) => ({ TechSystemID: id, GameID: 0, TechTypeID: typeId, Name: name, ComponentName: name, AdditionalInfo: info, AdditionalInfo2: info2, DevelopCost: cost })

const catalogueRow = (id, typeId, name, cost, info, extra = {}) => ({ TechSystemID: id, GameID: 0, Name: name, ComponentName: name, TechDescription: '', DevelopCost: cost, RaceID: 0, Prerequisite1: 0, Prerequisite2: 0, RuinOnly: 0, AutomaticResearch: 0, StartingSystem: 0, ConventionalSystem: 0, TechTypeID: typeId, AdditionalInfo: info, AdditionalInfo2: null, TypeName: `Type ${typeId}`, FieldID: 1, ...extra })

const STRENGTH = 20
const EM = 125

const LEVELS = [
  { id: 2001, type: STRENGTH, name: 'Strength 10', cost: 100, info: 10, info2: null, researched: true, prerequisite: 0 },
  { id: 2002, type: STRENGTH, name: 'Strength 16', cost: 300, info: 16, info2: null, researched: true, prerequisite: 2001 },
  { id: 2003, type: STRENGTH, name: 'Strength 24', cost: 600, info: 24, info2: null, researched: false, prerequisite: 2002 },
  { id: 2011, type: EM, name: 'EM 8', cost: 100, info: 8, info2: null, researched: true, prerequisite: 0 },
  { id: 2012, type: EM, name: 'EM 12', cost: 300, info: 12, info2: null, researched: false, prerequisite: 2011 },
]

const buildTech = (m, levels = LEVELS) => {
  const researched = levels.filter((item) => item.researched)
  const raw = m.rt.buildRaceTech(researched.map((item) => researchedRow(item.id, item.type, item.name, item.cost, item.info, item.info2)))
  const catalogue = levels.map((item) => catalogueRow(item.id, item.type, item.name, item.cost, item.info, { AdditionalInfo2: item.info2, Prerequisite1: item.prerequisite }))

  return m.ts.withCandidates(raw, { catalogue, raceId: SENSOR_RACE, researched: researched.map((item) => item.id), eligible: [], projects: [], queued: [], paused: [] })
}

const activeRow = (fields) => Object.freeze({ type: 24, kind: 'search', sizeHS: 4, cost: 40, crew: 10, uridium: 5, corbomite: 0, rangeKm: 2e7, resolution: 20, eccm: 0, ctd: 2, strength: 64, obsolete: false, ...fields })

const SEARCH = activeRow({ id: 501, name: 'Search 20' })
const FIRE_CONTROL = activeRow({ id: 502, name: 'MFC 20', type: 25, kind: 'fireControl', rangeKm: 4e7 })
const BEAM = Object.freeze({ id: 601, name: 'Beam FC', type: 19, sizeHS: 3, cost: 30, crew: 5, uridium: 1, corbomite: 0, rangeKm: 128000, trackingKmS: 4000, rangeMultiplier: 2, trackingMultiplier: 1, specialFunction: 0, eccm: 0, ctd: 1, obsolete: false })
const OWNED = Object.freeze([{ SDComponentID: 41, Name: 'Thermal 25', ComponentTypeID: 8, ComponentValue: 25 }])
const NOTHING = { enemyThermal: '', enemyEm: '', enemyRange: '', enemyResolution: '' }

// ---------- the templates ----------

const templateOf = (source) => {
  const parsed = require(path.join(root, 'node_modules', 'vue', 'compiler-sfc')).parse({ source })

  return (parsed.template || parsed.descriptor.template).content
}

const vuePath = (...parts) => path.join(rendererDirectory, ...parts)

const TEMPLATES = {
  sensors: () => templateOf(fs.readFileSync(vuePath('pages', 'sensors.vue'), 'utf8')),
  missile: () => templateOf(fs.readFileSync(vuePath('pages', 'missile-designer.vue'), 'utf8')),
  designed: () => templateOf(fs.readFileSync(vuePath('pages', 'designed-tech.vue'), 'utf8')),
  compare: () => templateOf(fs.readFileSync(vuePath('components', 'missiles', 'MissileCompareTable.vue'), 'utf8')),
}

const panelProblems = (template, { heads: needHeads = true } = {}) => {
  const panels = template.match(/<v-card\b[^>]*class="panel"[^>]*>/g) || []
  const heads = (template.match(/class="panel-head"/g) || []).length
  const bare = panels.filter((tag) => !/data-summary="[^"]{20,}"/.test(tag))

  return [...(panels.length ? [] : ['the template has no panel']), ...(bare.length ? [`${bare.length} of ${panels.length} panels have no data-summary`] : []), ...(!needHeads || heads === panels.length ? [] : [`${panels.length} panels and ${heads} panel heads`])]
}

const PRONOUNS = /\b(?:me|my|myself|we|our|ours|ourselves|you|your|yours|yourself)\b|\bI\b/

const wordsOf = (template) => {
  const summaries = (template.match(/data-summary="[^"]*"/g) || []).join(' ')
  const text = template.replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ')

  return `${text} ${summaries}`
}

// The page-link tags of a template, each with the attribute that gives its target.
const pageLinks = (template) => (template.match(/<page-link\b[^>]*\/>/g) || [])

// ---------- the pages ----------

const mutated = (from, to) => (text) => patched('page.js', text, from, to)

const pageStatements = async ({ utilities = {}, sensors = null, missile = null, designed = null, templates = {} } = {}, stock = null) => {
  const loaded = utilities.sources ? await loadUtilities(['deep-links', 'planner-links', 'sensor-planner', 'missile-designer', 'design-rules', 'design-data', 'provenance', 'tech-scenarios', 'race-tech', 'navigation'], { stubs: STUBS, sources: utilities.sources }) : null
  const m = loaded ? { dl: loaded['deep-links'], pl: loaded['planner-links'], sp: loaded['sensor-planner'], md: loaded['missile-designer'], dr: loaded['design-rules'], dd: loaded['design-data'], pv: loaded.provenance, ts: loaded['tech-scenarios'], rt: loaded['race-tech'], nav: loaded.navigation } : await modules()
  const pageSources = utilities.sources ? { sources: Object.fromEntries(Object.entries(utilities.sources).map(([name, source]) => [`utilities/${name}`, source])) } : {}

  globalThis.__linksFields = {}

  const sensorsOptions = await loadPage('pages/sensors', { stubs: STUBS, mutate: sensors, ...pageSources, modules: { 'mixins/persisted-view': FIELDS_STUB, 'mixins/load-state': null } })
  const sensorFields = globalThis.__linksFields

  globalThis.__linksFields = {}

  const missileOptions = await loadPage('pages/missile-designer', { stubs: STUBS, mutate: missile, ...pageSources, modules: { 'mixins/persisted-view': FIELDS_STUB } })

  globalThis.__linksFields = {}

  const designedOptions = await loadPage('pages/designed-tech', { stubs: STUBS, mutate: designed, ...pageSources, modules: { 'mixins/persisted-view': FIELDS_STUB, 'mixins/load-state': null } })
  const template = (name) => (templates[name] ? templates[name](TEMPLATES[name]()) : TEMPLATES[name]())
  const tech = buildTech(m)
  const store = { getters: {}, state: {} }
  const MISSILE_STORE = { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }
  const detection = m.pv.getRule(m.dr.SENSOR_RULES.detection).verification
  const known = (result) => result.status !== 'unavailable'
  const noted = (result, text) => JSON.stringify(result.assumptions || []).includes(text)
  const standing = (id, { size = 12.5, range = 4000000, name = 'Hawk', owner = SENSOR_RACE, held = 1 } = {}) => m.pl.missileStanding({ id, row: { Name: name, Size: size, MaxRange: range, OwnerID: owner, Held: held }, raceId: SENSOR_RACE })
  const sensorsPage = (data = {}, { database = null, getters = store.getters } = {}) => instantiate(sensorsOptions, { $store: { getters, state: store.state }, database, GameID: 138, RaceID: SENSOR_RACE, data: { classRead: [], ownedRows: OWNED, activeRows: [SEARCH, FIRE_CONTROL], beamRows: [BEAM], tech, reduction: { levels: [], techs: {} }, loadErrors: {}, ready: true, ...NOTHING, ...data } })
  const queryOf = (target, extra = {}) => ({ ...m.dl.linkTo.sensors({ target, ...extra }).query })
  const SAVED = { missile: 7, name: 'Hawk', msp: 12.5, range: 4000000, signature: 25, resolution: 20, jammer: 1, source: 'saved', tech: [] }
  const CANDIDATE = { missile: null, name: 'Hawk (reoptimised)', msp: 10.25, range: 5000000, signature: null, resolution: 'best', jammer: 0, source: 'researched', tech: [{ type: STRENGTH, id: 2002, kind: 'researched' }] }
  const HYPOTHETICAL = { missile: null, name: 'Hawk II', msp: 11, range: 4500000, signature: 10, resolution: 40, jammer: null, source: 'hypothetical', tech: [{ type: STRENGTH, id: 2003, kind: 'hypothetical' }] }
  const MANUAL = { missile: null, name: 'Typed', msp: 9, range: 3000000, signature: null, resolution: null, jammer: null, source: 'manual', tech: [] }
  const context = contextOf(m)
  const designerContext = (overrides) => contextOf(m, overrides)
  const designs = { fixture: fixtureOf(STOCK), obsolete: {}, excluded: 0 }
  const designerPage = (data = {}, { database = null, getters = MISSILE_STORE.getters } = {}) => instantiate(missileOptions, { $store: { getters, state: MISSILE_STORE.state }, database, GameID: 138, RaceID: STOCK.race, data: { designs, techResolution: context.resolution, formulaVersion: null, ready: true, loadErrors: {}, ...data } })
  const tableOf = (data = {}, { database = null, getters = store.getters } = {}) => instantiate(designedOptions, { $store: { getters, state: store.state }, database, GameID: 138, RaceID: SENSOR_RACE, data: { components: [{ SDComponentID: 9, Name: 'Search 20', CategoryID: 5, Obsolete: false, ComponentTypeID: 24 }], missiles: [{ SDComponentID: 'missile-7', MissileID: 7, Name: 'Hawk', CategoryID: 4, Obsolete: false }], species: [], ready: true, loadErrors: {}, compareByCategory: {}, categories: [{ CategoryID: 5, Name: 'Sensors' }, { CategoryID: 4, Name: 'Missiles' }], hideObsolete: true, ...data } })
  const savedColumn = compareOf(m, context, ORDINARY).columns[0]
  const reoptimised = compareOf(m, context, ORDINARY, keyed([draftOf(m, context, ORDINARY)])).columns[1]
  const hypotheticalContext = designerContext({ 130: hypothetical(130, 6) })
  const raised = compareOf(m, hypotheticalContext, ORDINARY, keyed([draftOf(m, hypotheticalContext, ORDINARY)])).columns[1]
  const typed = compareOf(m, context, ORDINARY, keyed([{ ...draftOf(m, context, ORDINARY), techMode: 'manual', manual: Object.fromEntries(Object.keys(m.md.emptyManual()).map((name) => [name, '2'])) }])).columns[1]
  const blankDraft = compareOf(m, context, ORDINARY, keyed([m.md.emptyDraft('Blank')])).columns[1]
  const SCENARIO = { signature: 25, resolution: 'best', jammer: 0 }
  const technology = (vm) => vm.handoffResolution.tech.map((level) => [level.id, level.state])
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  // A database whose reads wait until the check ends them, so the order in which two reads end is the check's.
  const heldReads = () => {
    const waiting = []

    return { database: { query: () => new Promise((resolve) => waiting.push(resolve)) }, finish: (index, rows) => waiting[index](rows) }
  }

  const SWITCHES = Object.freeze(['race', 'game', 'database', 'link'])

  // Starts the read of a link's standing, then moves the page to another race, game or database, or applies the link again (the page answers each with a second read), ends the second read first (the save now open has no such design) and the first after it (the save it began against has the design), and gives the page the way it stands.
  const lateRead = async (switched, { page, start, reread, held }) => {
    const getters = {}
    const first = heldReads()
    const second = switched === 'database' ? heldReads() : first
    const vm = page(first.database, getters)

    start(vm)

    if (switched === 'race') {
      getters.RaceID = 99
    } else if (switched === 'game') {
      getters.GameID = 139
    } else if (switched === 'database') {
      getters.database = second.database
    }

    reread(vm)
    second.finish(switched === 'database' ? 0 : 1, [[]])
    await tick()
    first.finish(0, held)
    await tick()

    return vm
  }

  return [
    // ---------- codec ----------
    ['codec: a missile target round-trips through the query for a saved missile and for each candidate source', () => {
      const cases = [SAVED, CANDIDATE, HYPOTHETICAL, MANUAL]
      const decoded = cases.map((target) => m.dl.queryMissileTarget(queryOf(target)))

      return when(decoded.every((entry, index) => entry && entry.problems.length === 0 && same(entry.target, cases[index]) === true), decoded)
    }],
    ['codec: a query with none of the missile target keys has no target, so the links of the other keys are untouched', () => {
      return when(m.dl.queryMissileTarget({ mode: 'beam', sensor: '601' }) === null && m.dl.queryMissileTarget({}) === null && m.dl.queryMissileTarget(null) === null && m.dl.queryMissileTarget({ mode: ['active'] }) === null, 'a query with other keys read as a target')
    }],
    ['codec: an unreadable target is refused whole with each reason and never applied in part', () => {
      const good = queryOf(SAVED)
      const cases = {
        'no size': { ...good, msp: undefined },
        'size 0': { ...good, msp: '0' },
        'size text': { ...good, msp: 'big' },
        'no range': { ...good, range: undefined },
        'no source': { ...good, src: undefined },
        'source not one': { ...good, src: 'guess' },
        'saved without an ID': { ...good, missile: undefined },
        'ID not an ID': { ...good, missile: 'abc' },
        'candidate with an ID': { ...queryOf(CANDIDATE), missile: '7' },
        'hypothetical without a level': { ...queryOf(HYPOTHETICAL), tech: `${STRENGTH}:2003:r` },
        'researched with a hypothetical level': { ...queryOf(CANDIDATE), tech: `${STRENGTH}:2003:h` },
        'tech token': { ...good, tech: 'nonsense' },
        resolution: { ...good, res: 'fine' },
        'resolution the window does not offer': { ...good, res: '21' },
        'resolution under 1': { ...good, res: '0.5' },
        'tech line twice': { ...queryOf(CANDIDATE), tech: `${STRENGTH}:999999999:r,${STRENGTH}:2002:r` },
        'negative jammer': { ...good, jam: '-1' },
      }
      const outcomes = Object.fromEntries(Object.entries(cases).map(([name, query]) => [name, m.dl.queryMissileTarget(query)]))
      const wrong = Object.entries(outcomes).filter(([, entry]) => !entry || entry.target !== null || entry.problems.length === 0 || entry.problems.some((problem) => typeof problem !== 'string' || !problem)).map(([name]) => name)

      return when(wrong.length === 0, wrong)
    }],
    ['codec: a resolution is read only when it is best or one the sensor window offers', () => {
      const read = (res) => m.dl.queryMissileTarget({ ...queryOf(SAVED), res: String(res) })
      const offered = m.dr.SENSOR_RESOLUTIONS_HS.filter((value) => !(read(value).target && read(value).target.resolution === value))
      const refused = ['21', '0.5', '501', '0', '-5', '1e3', '2 0', 'fine'].filter((value) => read(value).target !== null || !/sensor resolutions/.test(read(value).problems.join(' ')))

      return when(offered.length === 0 && refused.length === 0 && read('best').target.resolution === 'best', [offered, refused])
    }],
    ['codec: a tech line named twice is refused whole, so a later level cannot vouch for an earlier one', () => {
      const query = (tech) => m.dl.queryMissileTarget({ ...queryOf(CANDIDATE), tech })
      const twice = query(`${STRENGTH}:999999999:r,${STRENGTH}:2002:r`)
      const same = query(`${STRENGTH}:2002:r,${STRENGTH}:2002:r`)
      const apart = query(`${STRENGTH}:2002:r,${EM}:2011:r`)

      return when(twice.target === null && same.target === null && twice.problems.some((problem) => /named more than once/.test(problem)) && apart.target !== null && apart.target.tech.length === 2, [twice, same, apart])
    }],
    ['codec: an unknown figure is left out of the query and never written as 0', () => {
      const query = queryOf({ ...MANUAL, signature: null, resolution: null, jammer: null })

      return when(!('sig' in query) && !('res' in query) && !('jam' in query) && query.msp === '9' && query.range === '3000000' && queryOf({ ...MANUAL, msp: null }).msp === undefined && queryOf({ ...MANUAL, range: NaN }).range === undefined, query)
    }],
    ['codec: a jammer of 0 is a figure and is kept, a blank one is not', () => {
      return when(queryOf({ ...MANUAL, jammer: 0 }).jam === '0' && m.dl.queryMissileTarget(queryOf({ ...MANUAL, jammer: 0 })).target.jammer === 0 && m.dl.queryMissileTarget(queryOf(MANUAL)).target.jammer === null, 'a jammer of 0 was lost')
    }],
    ['codec: the links of the pages keep their shapes and a target opens Active mode', () => {
      const to = (link) => short(link)

      return when(to(m.dl.linkTo.sensors({ mode: 'beam', sensor: 601 })) === '{"path":"/sensors","query":{"mode":"beam","sensor":"601"}}' && to(m.dl.linkTo.sensors({ mode: 'active' })) === '{"path":"/sensors","query":{"mode":"active"}}' && m.dl.linkTo.sensors({ target: SAVED }).query.mode === 'active' && m.dl.linkTo.sensors({ mode: 'beam', target: SAVED }).query.mode === 'beam' && to(m.dl.linkTo.propulsion({ class: 5 })) === '{"path":"/propulsion","query":{"class":"5"}}' && to(m.dl.linkTo.propulsion({ engine: 9 })) === '{"path":"/propulsion","query":{"engine":"9"}}' && to(m.dl.linkTo.designedTech({ design: 501 })) === '{"path":"/designed-tech","query":{"design":"501"}}' && to(m.dl.linkTo.designedTech({ missile: 7 })) === '{"path":"/designed-tech","query":{"missile":"7"}}' && to(m.dl.linkTo.missileDesigner({ missile: 7, name: 'Hawk' })) === '{"path":"/missile-designer","query":{"missile":"7","name":"Hawk"}}' && to(m.dl.linkTo.missileDesigner()) === '{"path":"/missile-designer","query":{}}' && to(m.dl.linkTo.techTree({ tech: 2002 })) === '{"path":"/technologies","query":{"tech":"2002"}}', 'a link changed its shape')
    }],
    ['codec: a long saved name is kept whole through the query, the standing check and the return link', () => {
      const long = 'Daedalus Kinetics '.repeat(12).trim()
      const target = { ...SAVED, name: long }
      const decoded = m.dl.queryMissileTarget(queryOf(target))
      const resolved = m.pl.resolveMissileTarget({ target: decoded.target, standing: standing(7, { name: long }), tech })
      const vm = sensorsPage()

      vm.applyLink(queryOf(target))

      const back = vm.handoffBackLink.query
      const state = m.pl.missileLinkState({ standing: standing(7, { name: long }), name: back.name })

      return when(long.length > 80 && decoded.target && decoded.target.name === long && resolved.state === 'held' && resolved.origin.status === detection && back.name === long && back.missile === '7' && state.state === 'held', [decoded.target && decoded.target.name.length, resolved.state, back.name && back.name.length, state.state])
    }],
    ['codec: a name that is not the design\'s is still a change, however long', () => {
      const long = 'x'.repeat(200)
      const resolved = m.pl.resolveMissileTarget({ target: m.dl.queryMissileTarget(queryOf({ ...SAVED, name: long })).target, standing: standing(7, { name: `${long}y` }), tech })

      return when(resolved.state === 'changed' && resolved.origin.status === 'assumed', [resolved.state, resolved.origin && resolved.origin.status])
    }],
    ['codec: a link that carries very long values keeps its notices short and its tech list bounded, and the name whole', () => {
      const huge = 'z'.repeat(100000)
      const text = (query) => m.pl.targetProblemText({ problems: m.dl.queryMissileTarget(query).problems })
      const many = Array.from({ length: 50000 }, (_, index) => `${index + 1}:5:r`).join(',')
      const outcomes = [text({ ...queryOf(SAVED), src: huge, res: huge, tech: huge }), text({ ...queryOf(CANDIDATE), tech: many }), text({ ...queryOf(CANDIDATE), tech: Array.from({ length: 50000 }, () => 'q').join(',') })]
      const named = m.dl.queryMissileTarget(queryOf({ ...SAVED, name: huge })).target

      return when(outcomes.every((entry) => entry.length < 1500) && /tech levels are named/.test(outcomes[1]) && m.dl.queryMissileTarget({ ...queryOf(CANDIDATE), tech: many }).target === null && m.dl.queryMissileTarget({ ...queryOf(CANDIDATE), tech: Array.from({ length: 50000 }, () => 'q').join(',') }).problems.length < 50 && named && named.name.length === huge.length, outcomes.map((entry) => entry.length))
    }],
    ['sensors: a name of 100000 characters stays whole for the checks and the back link, and is cut in every label and sentence', () => {
      const huge = 'Mjolnir '.repeat(12500).trim()
      const vm = sensorsPage()

      vm.applyLink(queryOf({ ...SAVED, name: huge }))
      vm.handoffStanding = standing(7, { name: 'Hawk' })
      vm.settleHandoff()

      const resolved = vm.handoffResolution
      const label = vm.linkLabel
      const sentences = [...resolved.notes, vm.handoffResolution.origin.name, vm.handoffLabel]

      return when(vm.handoffName === huge && vm.handoffBackLink.query.name === huge && vm.handoffLabel.length <= 80 && label.length <= 80 && resolved.state === 'changed' && sentences.every((entry) => entry.length < 600) && noted(vm.sizing.request.signature, 'no longer stores') && vm.target.label.length < 200, [vm.handoffName.length, label.length, sentences.map((entry) => entry.length), vm.target.label.length])
    }],

    // ---------- handoff ----------
    ['handoff: a saved missile hands over the stored size and range, its own ID, no tech and the source saved', () => {
      const stored = { ...savedColumn, figures: { ...savedColumn.figures, size: { ...savedColumn.figures.size, stored: 33, value: 31 }, maxRange: { ...savedColumn.figures.maxRange, stored: 6000000, value: 5900000 } } }
      const handoff = m.pl.missileHandoff(stored, SCENARIO)

      return when(handoff.ok && handoff.target.missile === ORDINARY && handoff.target.msp === 33 && handoff.target.range === 6000000 && handoff.target.source === 'saved' && handoff.target.tech.length === 0 && handoff.target.name === savedColumn.name, handoff)
    }],
    ['handoff: a reoptimised candidate hands over its evaluated size and range, no ID and its tech by ID and kind', () => {
      const handoff = m.pl.missileHandoff(reoptimised, SCENARIO)
      const levels = reoptimised.tech.map(({ type, id, kind }) => ({ type, id, kind }))

      return when(handoff.ok && handoff.target.missile === null && handoff.target.msp === reoptimised.figures.size.value && handoff.target.range === reoptimised.figures.maxRange.value && handoff.target.source === 'researched' && levels.length > 0 && same(handoff.target.tech, levels) === true && handoff.target.tech.every((level) => level.kind === 'researched' && Number.isInteger(level.id) && Number.isInteger(level.type)), handoff)
    }],
    ['handoff: a candidate on a hypothetical level carries the level as hypothetical and the source hypothetical', () => {
      const handoff = m.pl.missileHandoff(raised, SCENARIO)

      return when(handoff.ok && handoff.target.source === 'hypothetical' && handoff.target.tech.some((level) => level.kind === 'hypothetical' && level.type === 130 && level.id === 9000130) && m.dl.queryMissileTarget(m.dl.linkTo.sensors({ target: handoff.target }).query).problems.length === 0, handoff)
    }],
    ['handoff: a candidate on typed figures carries no tech and the source manual', () => {
      const handoff = m.pl.missileHandoff(typed, SCENARIO)

      return when(handoff.ok ? handoff.target.source === 'manual' && handoff.target.tech.length === 0 && handoff.target.missile === null : typed.source !== 'manual', handoff)
    }],
    ['handoff: a resolution the window does not offer is not carried, and every one it offers is', () => {
      const carried = (resolution) => m.pl.missileHandoff(reoptimised, { ...SCENARIO, resolution }).target.resolution

      return when(carried(21) === null && carried(0.5) === null && carried(501) === null && carried('best') === 'best' && m.dr.SENSOR_RESOLUTIONS_HS.every((value) => carried(value) === value), [carried(21), carried(0.5), carried(501)])
    }],
    ['handoff: a missile whose size or range is not known hands over nothing, with the reason and never a 0', () => {
      const handoff = m.pl.missileHandoff(blankDraft, SCENARIO)
      const none = m.pl.missileHandoff(null, SCENARIO)
      const noRange = m.pl.missileHandoff({ ...reoptimised, figures: { ...reoptimised.figures, maxRange: { ...reoptimised.figures.maxRange, value: null, reason: 'no engine' } } }, SCENARIO)

      return when(handoff.ok === false && /not known/.test(handoff.reason) && none.ok === false && noRange.ok === false && /range/.test(noRange.reason) && /no engine/.test(noRange.reason), [handoff, none, noRange])
    }],
    ['handoff: the scenario of the designer is carried only where it is a figure', () => {
      const full = m.pl.missileHandoff(reoptimised, { signature: 25, resolution: 20, jammer: 2 }).target
      const blank = m.pl.missileHandoff(reoptimised, { signature: null, resolution: null, jammer: null }).target
      const odd = m.pl.missileHandoff(reoptimised, { signature: 0, resolution: -1, jammer: -3 }).target

      return when(full.signature === 25 && full.resolution === 20 && full.jammer === 2 && blank.signature === null && blank.resolution === null && blank.jammer === null && odd.signature === null && odd.resolution === null && odd.jammer === null, [full, blank, odd])
    }],
    ['handoff: the payload encodes into a query that reads back to the same payload', () => {
      const handoff = m.pl.missileHandoff(reoptimised, SCENARIO).target
      const back = m.dl.queryMissileTarget(m.dl.linkTo.sensors({ target: handoff }).query)

      return when(back && back.problems.length === 0 && same(back.target, { ...handoff, name: handoff.name }) === true, back)
    }],

    // ---------- resolve ----------
    ['resolve: a held saved missile applies at the rule\'s own status and says nothing is changed', () => {
      const resolution = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7), tech })

      return when(resolution.applies && !resolution.pending && resolution.state === 'held' && resolution.notes.length === 0 && resolution.origin.status === detection && resolution.origin.name === 'Hawk', resolution)
    }],
    ['resolve: a saved missile whose size, range or name changed applies as assumed and says what the save holds', () => {
      const size = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7, { size: 14 }), tech })
      const range = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7, { range: 3000000 }), tech })
      const name = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7, { name: 'Falcon' }), tech })

      return when([size, range, name].every((entry) => entry.applies && entry.state === 'changed' && entry.origin.status === 'assumed' && entry.notes.length === 1 && /changed since/.test(entry.notes[0])) && /14 MSP/.test(size.notes[0]) && /3000000 km/.test(range.notes[0]) && /Falcon/.test(name.notes[0]), [size, range, name])
    }],
    ['resolve: a saved missile that is gone, another race\'s, owned by none or not researched is not applied and the reason names its state', () => {
      const missing = m.pl.resolveMissileTarget({ target: SAVED, standing: m.pl.missileStanding({ id: 7, row: null, raceId: SENSOR_RACE }), tech })
      const other = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7, { owner: 3 }), tech })
      const unowned = m.pl.resolveMissileTarget({ target: SAVED, standing: m.pl.missileStanding({ id: 7, row: { Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: null, Held: 0 }, raceId: SENSOR_RACE }), tech })
      const unresearched = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7, { held: 0 }), tech })
      const states = [missing, other, unowned, unresearched].map((entry) => entry.state)

      return when([missing, other, unowned, unresearched].every((entry) => !entry.applies && entry.origin === null && entry.problems.length === 1 && /not applied/.test(entry.problems[0])) && same(states, ['missing', 'other-race', 'unowned', 'not-researched']) === true && /deleted/.test(missing.problems[0]) && /another race/.test(other.problems[0]) && /no race/.test(unowned.problems[0]) && /not researched/.test(unresearched.problems[0]), states)
    }],
    ['resolve: a saved missile not read yet is pending and decides nothing, one that could not be read is not applied', () => {
      const pending = m.pl.resolveMissileTarget({ target: SAVED, standing: undefined, tech })
      const unknown = m.pl.resolveMissileTarget({ target: SAVED, standing: { id: 7, state: 'unknown', name: '', text: 'The missile 7 could not be checked against the save (no table).' }, tech })

      return when(pending.pending && !pending.applies && pending.origin === null && !unknown.pending && !unknown.applies && unknown.state === 'unknown' && /could not be checked/.test(unknown.problems[0]), [pending, unknown])
    }],
    ['resolve: a researched candidate that names no tech level is assumed with a note, never verified by an empty list', () => {
      const bare = m.pl.resolveMissileTarget({ target: { ...CANDIDATE, tech: [] }, standing: undefined, tech })
      const checked = m.pl.resolveMissileTarget({ target: CANDIDATE, standing: undefined, tech })
      const saved = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7), tech })

      return when(bare.applies && bare.origin.status === 'assumed' && bare.notes.some((note) => /names no tech level/.test(note)) && noted(bare.origin, 'no tech level to check') && checked.origin.status === detection && saved.origin.status === detection, [bare.origin, checked.origin.status, saved.origin.status])
    }],
    ['resolve: a candidate on researched tech applies at the rule\'s status, one on hypothetical or typed tech is assumed', () => {
      const researched = m.pl.resolveMissileTarget({ target: CANDIDATE, standing: undefined, tech })
      const hypotheticalLevel = m.pl.resolveMissileTarget({ target: HYPOTHETICAL, standing: undefined, tech })
      const manual = m.pl.resolveMissileTarget({ target: MANUAL, standing: undefined, tech })

      return when(researched.applies && researched.state === 'candidate' && researched.origin.status === detection && hypotheticalLevel.applies && hypotheticalLevel.origin.status === 'assumed' && hypotheticalLevel.origin.assumptions.some((text) => /Hypothetical tech:/.test(text)) && manual.applies && manual.origin.status === 'assumed' && manual.origin.assumptions.some((text) => /typed/.test(text)), [researched.origin, hypotheticalLevel.origin, manual.origin])
    }],
    ['resolve: each tech level is checked against the save: researched, hypothetical, researched since, unusable, with a link only for a level the save knows', () => {
      const of = (...levels) => m.pl.resolveMissileTarget({ target: { ...CANDIDATE, tech: levels }, standing: undefined, tech })
      const researched = of({ type: STRENGTH, id: 2002, kind: 'researched' })
      const hypotheticalLevel = of({ type: STRENGTH, id: 2003, kind: 'hypothetical' })
      const since = of({ type: EM, id: 2011, kind: 'hypothetical' })
      const unusable = of({ type: EM, id: 98765, kind: 'researched' })
      const first = (rows) => rows.tech[0]

      return when(first(researched).state === 'researched' && first(researched).known && first(hypotheticalLevel).state === 'hypothetical' && first(hypotheticalLevel).known && first(since).state === 'now-researched' && first(since).known && first(unusable).state === 'unusable' && !first(unusable).known && hypotheticalLevel.origin.status === 'assumed' && since.origin.status === detection && unusable.origin.status === 'assumed' && unusable.notes.some((note) => /cannot be used/.test(note)) && since.notes.some((note) => /was hypothetical/.test(note)), [researched.tech, hypotheticalLevel.tech, since.tech, unusable.tech])
    }],
    ['resolve: the tech of a link is unchecked while the race\'s tech is not read', () => {
      const rows = m.pl.resolveMissileTarget({ target: HYPOTHETICAL, standing: undefined, tech: null })

      return when(rows.tech.length === 1 && rows.tech[0].state === 'unchecked' && rows.tech[0].known === false, rows.tech)
    }],
    ['resolve: the standing of a missile and of a component design is told for each state', () => {
      const design = (row) => m.pl.componentStanding({ id: 9, row })
      const states = [design(null), design({ Name: 'S', ComponentTypeID: 24, Held: 1 }), design({ Name: 'S', ComponentTypeID: 24, Held: 0, HeldByOthers: 1 }), design({ Name: 'S', ComponentTypeID: 24, Held: 0, HeldByOthers: 0 })]
      const named = m.pl.missileLinkState({ standing: standing(7), name: 'Falcon' })

      return when(same(states.map((entry) => entry.state), ['missing', 'held', 'other-race', 'not-researched']) === true && states.every((entry) => (entry.state === 'held') === (entry.text === '')) && named.state === 'changed' && /not the design the link meant/.test(named.text) && m.pl.missileLinkState({ standing: standing(7), name: 'Hawk' }).state === 'held' && m.pl.missileLinkState({ standing: standing(7), name: '' }).state === 'held', states)
    }],
    ['resolve: a read is current only while it is the owner\'s latest of its name and its save, game and race are the ones it began against', () => {
      const owner = { database: {}, GameID: 138, RaceID: 7 }
      const first = m.pl.beginRead(owner, 'link')
      const named = m.pl.beginRead(owner, 'focus')
      const another = m.pl.beginRead({ database: {}, GameID: 138, RaceID: 7 }, 'link')
      const independent = m.pl.isCurrentRead(owner, first) && m.pl.isCurrentRead(owner, named) && m.pl.isCurrentRead(owner, another) === false
      const second = m.pl.beginRead(owner, 'link')
      const superseded = !m.pl.isCurrentRead(owner, first) && m.pl.isCurrentRead(owner, second)

      owner.RaceID = 8

      const race = m.pl.isCurrentRead(owner, second)

      owner.RaceID = 7
      owner.GameID = 139

      const game = m.pl.isCurrentRead(owner, second)

      owner.GameID = 138
      owner.database = {}

      const database = m.pl.isCurrentRead(owner, second)

      return when(independent && superseded && race === false && game === false && database === false, { independent, superseded, race, game, database })
    }],
    ['resolve: a standing read on a database that fails is unknown and never held', async () => {
      const failing = { query: () => Promise.reject(new Error('no such table')) }
      const missile = await m.pl.loadMissileStanding(failing, { GameID: 138, RaceID: SENSOR_RACE }, 7)
      const design = await m.pl.loadComponentStanding(failing, { GameID: 138, RaceID: SENSOR_RACE }, 9)
      const found = await m.pl.loadMissileStanding({ query: async () => [[{ Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: SENSOR_RACE, Held: 1 }]] }, { GameID: 138, RaceID: SENSOR_RACE }, 7)
      const gone = await m.pl.loadMissileStanding({ query: async () => [[]] }, { GameID: 138, RaceID: SENSOR_RACE }, 7)

      return when(missile.state === 'unknown' && design.state === 'unknown' && /no such table/.test(missile.text) && found.state === 'held' && gone.state === 'missing', [missile, design, found, gone])
    }],
    ['resolve: the words of a design the open mode does not list say which mode, and nothing when it is listed', () => {
      const held = m.pl.componentStanding({ id: 9, row: { Name: 'Search 20', ComponentTypeID: 24, Held: 1 } })
      const text = m.pl.componentPlacementText({ standing: held, mode: 'Beam FC', found: false })

      return when(/Beam FC mode does not list it/.test(text) && m.pl.componentPlacementText({ standing: held, mode: 'Active', found: true }) === '' && m.pl.componentPlacementText({ standing: null, mode: 'Active', found: false }) === '' && /another race/.test(m.pl.componentPlacementText({ standing: m.pl.componentStanding({ id: 9, row: { Name: 'S', Held: 0, HeldByOthers: 1 } }), mode: 'Active', found: false })), text)
    }],

    // ---------- sizing ----------
    ['sizing: a missile target of a saved missile carries the rule\'s status and the handover into the signature of the sizing', () => {
      const resolution = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7), tech })
      const target = m.sp.targetOf({ kind: 'missile', msp: '12.5', origin: resolution.origin })
      const sizing = m.sp.activeSizing({ target: target.results[0], wantedRangeKm: '4000000', resolution: 'best', jammer: 0 })

      return when(target.label === 'Hawk, 12.5 MSP' && target.signature.status === detection && noted(target.signature, 'handed over by the Missile Designer') && sizing.request.signature.status === detection && noted(sizing.request.signature, 'saved design of the race'), [target.label, target.signature.status, sizing.request.signature.status])
    }],
    ['sizing: a candidate on hypothetical tech marks the sizing assumed and carries the hypothetical assumption', () => {
      const resolution = m.pl.resolveMissileTarget({ target: HYPOTHETICAL, standing: undefined, tech })
      const target = m.sp.targetOf({ kind: 'missile', msp: '11', origin: resolution.origin })
      const sizing = m.sp.activeSizing({ target: target.results[0], wantedRangeKm: '4500000', resolution: 'best', jammer: 0 })

      return when(sizing.request.signature.status === 'assumed' && noted(sizing.request.signature, 'Hypothetical tech:') && noted(sizing.request.signature, 'not researched') === false ? true : sizing.request.signature.status === 'assumed' && noted(sizing.request.signature, 'Hypothetical tech:'), sizing.request.signature)
    }],
    ['sizing: a missile typed in without a handover keeps its typed provenance', () => {
      const target = m.sp.targetOf({ kind: 'missile', msp: '12.5' })

      return when(target.label === '12.5 MSP missile' && target.signature.status === 'assumed' && noted(target.signature, 'typed here') && !noted(target.signature, 'handed over'), target.signature)
    }],
    ['sizing: a blank size is unknown with a handover too, never 0', () => {
      const resolution = m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7), tech })
      const target = m.sp.targetOf({ kind: 'missile', msp: '', origin: resolution.origin })

      return when(!known(target.signature), target.signature)
    }],

    // ---------- sensors ----------
    ['sensors: a link with a held saved missile opens Active mode with its size, range, resolution and jammer as the inputs', () => {
      const vm = sensorsPage({ mode: 'beam', targetKind: 'tons', targetTons: '250' })

      vm.applyLink(queryOf(SAVED))

      const pending = vm.handoffResolution.pending

      vm.handoffStanding = standing(7)
      vm.settleHandoff()

      return when(pending && vm.mode === 'active' && vm.targetKind === 'missile' && vm.targetMsp === '12.5' && vm.wantedRange === '4000000' && vm.resolutionPick === '20' && vm.jammer === '1' && vm.handoffApplied === true && vm.handoffHeld && vm.target.label === 'Hawk, 12.5 MSP' && vm.sizing.request.wantedRangeKm === 4000000, [vm.mode, vm.targetKind, vm.targetMsp, vm.wantedRange, vm.resolutionPick, vm.jammer])
    }],
    ['sensors: the range handed over is the wanted range and the missile keeps the provenance of the handover in every sizing figure', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(CANDIDATE))

      const tiles = vm.sizing.tiles

      return when(vm.wantedRange === '5000000' && vm.targetMsp === '10.25' && vm.sizing.request.signature.status === detection && noted(vm.sizing.request.signature, 'candidate made in the Missile Designer') && known(tiles.sizeNeeded) && noted(tiles.sizeNeeded, 'handed over'), [vm.sizing.request.signature.status, tiles.sizeNeeded.assumptions])
    }],
    ['sensors: a candidate on hypothetical tech opens the sizing as assumed and lists each tech level', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(HYPOTHETICAL))

      return when(vm.sizing.request.signature.status === 'assumed' && noted(vm.sizing.request.signature, 'Hypothetical tech:') && vm.resolutionPick === '40' && vm.jammer === '' && same(technology(vm), [[2003, 'hypothetical']]) === true && vm.handoffFigures.length === 5 && vm.handoffFigures.every((row) => row.key === 'resolution' || row.result), vm.handoffFigures.map((row) => row.key))
    }],
    ['sensors: a researched candidate whose link names no tech is sized as assumed, as with the key removed from a link', () => {
      const vm = sensorsPage()
      const query = queryOf(CANDIDATE)

      delete query.tech
      vm.applyLink(query)

      return when(vm.handoffApplied && vm.sizing.request.signature.status === 'assumed' && noted(vm.sizing.request.signature, 'names no tech level') && /names no tech level/.test(vm.handoffResolution.notes.join(' ')), [vm.sizing.request.signature.status, vm.handoffResolution.notes])
    }],
    ['sensors: the figures of the handover each carry a mark and an unknown one says it was not carried', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(MANUAL))

      const rows = Object.fromEntries(vm.handoffFigures.map((row) => [row.key, row]))

      return when(rows.size.result.status === 'assumed' && rows.range.result.status === 'assumed' && !known(rows.signature.result) && rows.signature.text === 'Not carried' && !known(rows.jammer.result) && rows.resolution.text === 'Not carried', rows)
    }],
    ['sensors: the inputs are the persisted ones of the page, kept for the race', () => {
      const names = ['mode', 'targetKind', 'targetMsp', 'wantedRange', 'resolutionPick', 'jammer']
      const missing = names.filter((name) => !sensorFields[name] || sensorFields[name].scope !== 'race')

      return when(missing.length === 0 && sensorFields.resolutionPick.valid('20') && sensorFields.resolutionPick.valid('best') && !sensorFields.resolutionPick.valid('abc'), missing)
    }],
    ['sensors: the link stays in the route while the inputs are the missile\'s and an edit drops it with the provenance', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(SAVED))
      vm.handoffStanding = standing(7)
      vm.settleHandoff()

      const query = vm.linkQuery
      const kept = m.dl.queryMissileTarget(query)

      vm.wantedRange = '5000000'

      const edited = { live: vm.handoffLive, query: vm.linkQuery, status: vm.sizing.request.signature.status, assumed: noted(vm.sizing.request.signature, 'typed here') }

      vm.wantedRange = '4000000'

      const restored = vm.handoffLive && vm.sizing.request.signature.status === detection

      return when(kept && same(kept.target, { ...SAVED }) === true && query.mode === 'active' && edited.live === false && short(edited.query) === '{"mode":"active"}' && edited.status === 'assumed' && edited.assumed && restored, [query, edited, restored])
    }],
    ['sensors: switching the mode or the target kind also ends the handover', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(CANDIDATE))
      vm.setMode('passive')

      const mode = vm.handoffLive
      const modeQuery = vm.linkQuery

      vm.setMode('active')

      const back = vm.handoffLive

      vm.targetKind = 'tons'

      return when(mode === false && short(modeQuery) === '{"mode":"passive"}' && back === true && vm.handoffLive === false && short(vm.linkQuery) === '{"mode":"active"}', [mode, modeQuery, back, vm.linkQuery])
    }],
    ['sensors: a saved missile changed since the link is applied as assumed with a note, and the link keeps naming it', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(SAVED))
      vm.handoffStanding = standing(7, { size: 14 })
      vm.settleHandoff()

      return when(vm.handoffResolution.state === 'changed' && vm.targetMsp === '12.5' && vm.sizing.request.signature.status === 'assumed' && vm.handoffResolution.notes.length === 1 && vm.handoffLive && vm.linkQuery.missile === '7', [vm.handoffResolution.state, vm.linkQuery])
    }],
    ['sensors: a missile gone, of another race, owned by none or not researched leaves the inputs alone and says why', () => {
      const cases = [['missing', m.pl.missileStanding({ id: 7, row: null, raceId: SENSOR_RACE }), /deleted/], ['other-race', standing(7, { owner: 3 }), /another race/], ['unowned', m.pl.missileStanding({ id: 7, row: { Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: null, Held: 0 }, raceId: SENSOR_RACE }), /no race/], ['not-researched', standing(7, { held: 0 }), /not researched/]]
      const outcomes = cases.map(([state, held, text]) => {
        const vm = sensorsPage({ targetKind: 'tons', targetTons: '250', wantedRange: '1000' })

        vm.applyLink(queryOf(SAVED))
        vm.handoffStanding = held
        vm.settleHandoff()

        return { state, applied: vm.handoffApplied, kind: vm.targetKind, wanted: vm.wantedRange, text: vm.handoffNotAppliedText, matches: text.test(vm.handoffNotAppliedText), live: vm.handoffLive, query: short(vm.linkQuery), back: vm.handoffBackLink.query.missile }
      })

      return when(outcomes.every((entry) => !entry.applied && entry.kind === 'tons' && entry.wanted === '1000' && entry.matches && !entry.live && entry.query === '{"mode":"active"}' && entry.back === '7'), outcomes)
    }],
    ['sensors: a saved missile whose standing is not read yet keeps the link and applies once it is read', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(SAVED))

      const waiting = { applied: vm.handoffApplied, live: vm.handoffLive, query: vm.linkQuery.missile, kind: vm.targetKind }

      vm.handoffStanding = standing(7)
      vm.settleHandoff()

      return when(waiting.applied === false && waiting.live === true && waiting.query === '7' && waiting.kind === 'tons' && vm.handoffApplied && vm.targetKind === 'missile', waiting)
    }],
    ['sensors: the standing is read from the save by the page and applied', async () => {
      const database = { query: async () => [[{ Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: SENSOR_RACE, Held: 1 }]] }
      const vm = sensorsPage({}, { database })

      vm.applyLink(queryOf(SAVED))
      await vm.readHandoffStanding()

      return when(vm.handoffStanding && vm.handoffStanding.state === 'held' && vm.handoffApplied && vm.targetMsp === '12.5', [vm.handoffStanding, vm.handoffApplied])
    }],
    ['sensors: a standing read that ends after the race, game or database changed, or the link was applied again, publishes nothing', async () => {
      const held = [[{ Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: SENSOR_RACE, Held: 1 }]]
      const outcomes = []

      for (const switched of SWITCHES) {
        const vm = await lateRead(switched, { page: (database, getters) => sensorsPage({ targetKind: 'tons', targetTons: '250' }, { database, getters }), start: (page) => page.applyLink(queryOf(SAVED)), reread: (page) => page.readStandings(), held })

        outcomes.push([switched, vm.handoffStanding && vm.handoffStanding.state, vm.handoffApplied, vm.targetKind])
      }

      return when(outcomes.every(([, state, applied, kind]) => state === 'missing' && applied === false && kind === 'tons'), outcomes)
    }],
    ['sensors: a handover waits for the page to be ready and is applied once', () => {
      const vm = sensorsPage({ ready: false })

      vm.applyLink(queryOf(CANDIDATE))

      const before = { applied: vm.handoffApplied, kind: vm.targetKind, query: vm.linkQuery }

      const ready = sensorsPage()

      ready.applyLink(queryOf(CANDIDATE))
      ready.targetMsp = '99'
      ready.settleHandoff()

      return when(before.applied === false && before.kind === 'tons' && before.query === null && ready.handoffApplied && ready.targetMsp === '99', [before, ready.targetMsp])
    }],
    ['sensors: an unreadable target applies none of its figures and each reason is in the notice', () => {
      const vm = sensorsPage({ targetKind: 'tons', targetTons: '250' })

      vm.applyLink({ ...queryOf(CANDIDATE), msp: 'big', src: 'guess' })

      return when(vm.handoff === null && vm.handoffResolution === null && vm.handoffApplied === false && vm.targetKind === 'tons' && vm.targetMsp === '' && /not applied/.test(vm.handoffProblemText) && /msp/.test(vm.handoffProblemText) && /src/.test(vm.handoffProblemText) && short(vm.linkQuery) === '{"mode":"active"}', [vm.handoffProblemText, vm.linkQuery])
    }],
    ['sensors: a resolution the window does not offer refuses the handover whole, so the inputs are not changed and the notice says why', () => {
      const vm = sensorsPage({ targetKind: 'tons', targetTons: '250' })

      vm.applyLink({ ...queryOf(MANUAL), res: '21' })

      return when(vm.handoff === null && vm.handoffApplied === false && vm.targetKind === 'tons' && vm.targetMsp === '' && /not applied/.test(vm.handoffProblemText) && /sensor resolutions/.test(vm.handoffProblemText), vm.handoffProblemText)
    }],
    ['sensors: a tech line named twice refuses the handover whole and no level is marked researched', () => {
      const vm = sensorsPage({ targetKind: 'tons', targetTons: '250' })

      vm.applyLink({ ...queryOf(CANDIDATE), tech: `${STRENGTH}:999999999:r,${STRENGTH}:2002:r` })

      return when(vm.handoff === null && vm.handoffResolution === null && vm.handoffApplied === false && vm.targetKind === 'tons' && /named more than once/.test(vm.handoffProblemText), vm.handoffProblemText)
    }],
    ['sensors: a link with no target leaves the handover empty and the links of the designs as they were', () => {
      const vm = sensorsPage()

      vm.applyLink({ mode: 'beam', sensor: '601' })

      return when(vm.handoff === null && vm.handoffResolution === null && vm.handoffProblemText === '' && vm.handoffLive === false && short(vm.linkQuery) === '{"mode":"beam","sensor":"601"}' && vm.focusNotice === '', vm.linkQuery)
    }],
    ['sensors: a later link without a target gives the handover up', () => {
      const vm = sensorsPage()

      vm.applyLink(queryOf(CANDIDATE))
      vm.applyLink({ mode: 'active' })

      return when(vm.handoff === null && vm.handoffApplied === false && vm.handoffProblems.length === 0, vm.handoff)
    }],
    ['sensors: a design a link names that the mode does not list is explained, with what the save says of it', () => {
      const text = (focusStanding, query = { mode: 'beam', sensor: '502' }) => {
        const vm = sensorsPage({ mode: 'beam' })

        vm.applyLink(query)
        vm.focusStanding = focusStanding

        return vm.focusNotice
      }
      const held = m.pl.componentStanding({ id: 502, row: { Name: 'MFC 20', ComponentTypeID: 25, Held: 1 } })
      const missing = m.pl.componentStanding({ id: 502, row: null })
      const other = m.pl.componentStanding({ id: 502, row: { Name: 'MFC 20', ComponentTypeID: 25, Held: 0, HeldByOthers: 1 } })
      const unresearched = m.pl.componentStanding({ id: 502, row: { Name: 'MFC 20', ComponentTypeID: 25, Held: 0, HeldByOthers: 0 } })
      const listed = sensorsPage()

      listed.applyLink({ mode: 'beam', sensor: '601' })

      return when(/being checked/.test(text(null)) && /Beam FC mode does not list it/.test(text(held)) && /deleted/.test(text(missing)) && /another race/.test(text(other)) && /not researched/.test(text(unresearched)) && /not a design ID/.test(text(null, { mode: 'beam', sensor: 'abc' })) && listed.focusNotice === '' && listed.focusRow.name === 'Beam FC', [text(held), text(missing)])
    }],
    ['sensors: a design the save has no row of is read through the page and the notice names it', async () => {
      const vm = sensorsPage({ mode: 'beam' }, { database: { query: async () => [[]] } })

      vm.applyLink({ mode: 'beam', sensor: '9999' })
      await vm.readFocusStanding()

      return when(/no component design with the ID 9999/.test(vm.focusNotice) && /No design is focused/.test(vm.focusNotice), vm.focusNotice)
    }],
    ['sensors: dismissing a notice gives up its subject', () => {
      const vm = sensorsPage()

      vm.applyLink({ mode: 'active', sensor: '9999', ...queryOf({ ...CANDIDATE, msp: 'x' }) })
      vm.dismissFocusNotice()
      vm.dismissHandoffProblems()

      return when(vm.focusSensorId === null && vm.focusInvalid === '' && vm.handoffProblems.length === 0 && vm.focusNotice === '' && vm.handoffProblemText === '', [vm.focusNotice, vm.handoffProblemText])
    }],
    ['sensors: the panel links back to the Missile Designer by ID and name for a saved missile and bare, with no query at all, for a candidate, and to Designed Tech for a saved one', () => {
      const saved = sensorsPage()
      const candidate = sensorsPage()

      saved.applyLink(queryOf(SAVED))
      candidate.applyLink(queryOf(CANDIDATE))

      return when(short(saved.handoffBackLink) === '{"path":"/missile-designer","query":{"missile":"7","name":"Hawk"}}' && short(saved.handoffDesignedTech) === '{"path":"/designed-tech","query":{"missile":"7"}}' && short(candidate.handoffBackLink) === '{"path":"/missile-designer","query":{}}' && m.dl.linkTo.missileDesigner({ name: 'Hawk' }).query.name === undefined && candidate.handoffDesignedTech === null, [saved.handoffBackLink, candidate.handoffBackLink])
    }],

    // ---------- designer ----------
    ['designer: every column links to the Sensor Planner with the payload of its handover and a saved one to Designed Tech', () => {
      const vm = designerPage({ baselineId: ORDINARY, alternatives: keyed([draftOf(m, context, ORDINARY)]), targetSignature: '25', embedResolution: '20', embedJammer: '2' })
      const links = vm.columnLinks
      const [baseline, alternative] = vm.comparison.columns
      const base = m.dl.queryMissileTarget(links[baseline.key].sensors.query)
      const alt = m.dl.queryMissileTarget(links[alternative.key].sensors.query)

      return when(base && alt && base.target.missile === ORDINARY && base.target.source === 'saved' && base.target.signature === 25 && base.target.resolution === 20 && base.target.jammer === 2 && alt.target.missile === null && alt.target.source === 'researched' && alt.target.tech.length > 0 && alt.target.msp === alternative.figures.size.value && alt.target.range === alternative.figures.maxRange.value && short(links[baseline.key].designedTech) === `{"path":"/designed-tech","query":{"missile":"${ORDINARY}"}}` && links[alternative.key].designedTech === null, [links[baseline.key], links[alternative.key]])
    }],
    ['designer: a column whose size or range is unknown has no link and says why', () => {
      const vm = designerPage({ baselineId: null, alternatives: keyed([m.md.emptyDraft('Blank')]) })
      const link = vm.columnLinks[vm.comparison.columns[0].key]

      return when(link.sensors === null && /not known/.test(link.reason) && link.designedTech === null, link)
    }],
    ['designer: a blank scenario is carried as unknown and never as 0', () => {
      const vm = designerPage({ baselineId: ORDINARY, targetSignature: '', embedJammer: '', launcherJammer: '' })
      const base = m.dl.queryMissileTarget(vm.columnLinks[vm.comparison.columns[0].key].sensors.query).target

      return when(base.signature === null && base.jammer === 0 && base.resolution === 'best', base)
    }],
    ['designer: a link pins the saved missile it names as the baseline and writes the same query back', () => {
      const vm = designerPage({ baselineId: null })

      vm.applyLink({ missile: String(ORDINARY) })

      return when(vm.baselineId === ORDINARY && vm.linkedChoice === null && vm.linkedMissileId === null && short(vm.linkQuery) === `{"missile":"${ORDINARY}"}` && vm.linkNotice === '' && vm.baselineLink !== null && vm.linkLabel === vm.baselineName, [vm.baselineId, vm.linkQuery])
    }],
    ['designer: a link that names a missile with a name that is no longer the design\'s does not pin it and says so', () => {
      const vm = designerPage({ baselineId: null })

      vm.applyLink({ missile: String(ORDINARY), name: 'Not the name' })

      return when(vm.baselineId === null && vm.linkedChoice === null && /not the design the link meant/.test(vm.linkNotice) === true, vm.linkNotice)
    }],
    ['designer: a link that names a missile that is gone, another race\'s or not researched says so and keeps the baseline', () => {
      const vm = designerPage({ baselineId: ORDINARY })
      const text = (held) => {
        vm.applyLink({ missile: '999999' })
        vm.linkedStanding = held

        return vm.linkNotice
      }

      const missing = text(m.pl.missileStanding({ id: 999999, row: null, raceId: STOCK.race }))
      const other = text(m.pl.missileStanding({ id: 999999, row: { Name: 'Other', OwnerID: 3, Held: 1 }, raceId: STOCK.race }))
      const unresearched = text(m.pl.missileStanding({ id: 999999, row: { Name: 'Other', OwnerID: STOCK.race, Held: 0 }, raceId: STOCK.race }))
      const checking = text(null)

      return when(vm.baselineId === ORDINARY && /deleted/.test(missing) && /another race/.test(other) && /not researched/.test(unresearched) && /being checked/.test(checking) && [missing, other, unresearched].every((entry) => /baseline is as it was/.test(entry)), [missing, other, unresearched, checking])
    }],
    ['designer: a missile ID that is not an ID is told and changes nothing', () => {
      const vm = designerPage({ baselineId: ORDINARY })

      vm.applyLink({ missile: 'abc' })

      return when(vm.baselineId === ORDINARY && /not a missile ID/.test(vm.linkNotice) && vm.linkedMissileId === null, vm.linkNotice)
    }],
    ['designer: the notice is given up when the baseline is picked on the page', () => {
      const vm = designerPage({ baselineId: ORDINARY })

      vm.applyLink({ missile: '999999' })
      vm.setBaseline(ORDINARY)

      return when(vm.linkNotice === '' && vm.linkedMissileId === null, vm.linkNotice)
    }],
    ['designer: the standing of a missile the page does not list is read from the save', async () => {
      const vm = designerPage({ baselineId: ORDINARY }, { database: { query: async () => [[]] } })

      vm.applyLink({ missile: '999999' })
      await vm.readLinkStanding()

      return when(vm.linkedStanding && vm.linkedStanding.state === 'missing' && /deleted/.test(vm.linkNotice), vm.linkNotice)
    }],
    ['designer: a link is consumed once it has pinned the baseline, so a comparison opened after it names its own baseline', () => {
      const other = designerPage({ baselineId: null }).savedItems.map((item) => item.value).find((id) => id !== ORDINARY)
      const entry = { uuid: 'record-b', revision: 1, links: [], payload: { name: 'B', baselineId: other, alternatives: [], scenario: { targetSpeed: '5000', jammer: '', modifier: '', pd: '', targetSignature: '' }, tech: { choices: {} } } }
      const open = (query) => {
        const vm = designerPage({ baselineId: null, recordsRead: { entries: [entry] } })

        vm.applyLink(query)
        vm.openRecord('record-b')

        return vm
      }

      const pinned = open({ missile: String(ORDINARY) })
      const pending = open({ missile: '999999' })
      const restored = designerPage({ baselineId: null })

      restored.applyLink({ missile: String(ORDINARY) })
      restored.baselineId = other

      return when(other !== undefined && pinned.baselineId === other && short(pinned.linkQuery) === `{"missile":"${other}"}` && pending.linkedMissileId === null && pending.linkNotice === '' && short(pending.linkQuery) === `{"missile":"${other}"}` && short(restored.linkQuery) === `{"missile":"${other}"}`, [pinned.linkQuery, pending.linkQuery, pending.linkNotice, restored.linkQuery])
    }],
    ['designer: a route step to a query with no missile is no baseline and the page writes that back', () => {
      const vm = designerPage({ baselineId: null })

      vm.applyLink({ missile: String(ORDINARY) })

      const linked = vm.baselineId

      vm.applyLink({})

      return when(linked === ORDINARY && vm.baselineId === null && short(vm.linkQuery) === '{}' && vm.linkNotice === '' && vm.baselineLink === null, [linked, vm.baselineId, vm.linkQuery])
    }],
    ['designer: a bare page opened first keeps the baseline it restored, as the mixin applies a query only when it has keys or the route changes', () => {
      const mixin = fs.readFileSync(path.join(utilitiesDirectory, '..', 'mixins', 'deep-link.js'), 'utf8')
      const vm = designerPage({ baselineId: ORDINARY })

      return when(/beforeMount \(\) \{\s*if \(Object\.keys\(this\.\$route\.query\)\.length\) \{\s*this\.applyLink/.test(mixin) && /'\$route\.query' \(query\) \{[^}]*this\.applyLink\(query\)/.test(mixin) && vm.baselineId === ORDINARY && short(vm.linkQuery) === `{"missile":"${ORDINARY}"}`, vm.linkQuery)
    }],
    ['designer: a standing read that ends after the race, game or database changed, or the link was applied again, publishes nothing', async () => {
      const held = [[{ Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: STOCK.race, Held: 1 }]]
      const outcomes = []

      for (const switched of SWITCHES) {
        const vm = await lateRead(switched, { page: (database, getters) => designerPage({ baselineId: ORDINARY }, { database, getters: Object.assign(getters, MISSILE_STORE.getters) }), start: (page) => { page.applyLink({ missile: '999999' }); page.readLinkStanding() }, reread: (page) => page.readLinkStanding(), held })

        outcomes.push([switched, vm.linkedStanding && vm.linkedStanding.state])
      }

      return when(outcomes.every(([, state]) => state === 'missing'), outcomes)
    }],
    ['designer: the page has no link before its reads are in', () => {
      return when(designerPage({ ready: false }).linkQuery === null, 'a link before the page is ready')
    }],

    // ---------- designed ----------
    ['designed: a link names a missile by its own key and the page writes the same query back', () => {
      const vm = tableOf()

      vm.applyLink({ missile: '7' })

      const missile = { row: vm.focusRow && vm.focusRow.Name, query: vm.linkQuery, label: vm.linkLabel, notice: vm.focusNotice }

      vm.applyLink({ design: '9' })

      const component = { row: vm.focusRow && vm.focusRow.Name, query: vm.linkQuery }

      vm.applyLink({})

      return when(missile.row === 'Hawk' && short(missile.query) === '{"missile":"7"}' && missile.label === 'Hawk' && missile.notice === '' && component.row === 'Search 20' && short(component.query) === '{"design":"9"}' && vm.focusRow === null && short(vm.linkQuery) === '{}', [missile, component])
    }],
    ['designed: a missile row links to its page in the Missile Designer and a component row does not', () => {
      const vm = tableOf()
      const link = vm.missileLink(vm.missiles[0])

      return when(short(link) === '{"path":"/missile-designer","query":{"missile":"7","name":"Hawk"}}' && vm.missileLink(vm.components[0]) === null && short(vm.sensorLink(vm.components[0])) === '{"path":"/sensors","query":{"mode":"active","sensor":"9"}}' && vm.sensorLink(vm.missiles[0]) === null, link)
    }],
    ['designed: a design or a missile no row holds is explained, with what the save says of it', () => {
      const text = (query, held) => {
        const vm = tableOf()

        vm.applyLink(query)
        vm.focusStanding = held ? { ...held, kind: query.design ? 'design' : 'missile' } : null

        return vm.focusNotice
      }
      const absent = m.pl.missileStanding({ id: 8, row: null, raceId: SENSOR_RACE })
      const other = standing(8, { owner: 3 })
      const unresearched = standing(8, { held: 0 })
      const heldMissile = standing(8)
      const gone = m.pl.componentStanding({ id: 77, row: null })

      return when(/being checked/.test(text({ missile: '8' }, null)) && /deleted/.test(text({ missile: '8' }, absent)) && /another race/.test(text({ missile: '8' }, other)) && /not researched/.test(text({ missile: '8' }, unresearched)) && /no row of this page holds it/.test(text({ missile: '8' }, heldMissile)) && /no component design with the ID 77/.test(text({ design: '77' }, gone)) && /not an ID/.test(text({ missile: 'abc' }, null)) && /not an ID/.test(text({ design: 'x' }, null)) && text({ missile: '7' }, null) === '', [text({ missile: '8' }, absent)])
    }],
    ['designed: a missile the save has no row of is read through the page and the notice names it', async () => {
      const vm = instantiate(designedOptions, { $store: store, database: { query: async () => [[]] }, GameID: 138, RaceID: SENSOR_RACE, data: { components: [], missiles: [], species: [], ready: true, loadErrors: {}, compareByCategory: {}, categories: [], hideObsolete: true } })

      vm.applyLink({ missile: '8' })
      await vm.readFocusStanding()

      return when(/no missile with the ID 8/.test(vm.focusNotice) && /Nothing is focused/.test(vm.focusNotice), vm.focusNotice)
    }],
    ['designed: a standing read that ends after the race, game or database changed, or the link was applied again, publishes nothing', async () => {
      const held = [[{ Name: 'Hawk', Size: 12.5, MaxRange: 4000000, OwnerID: SENSOR_RACE, Held: 1 }]]
      const outcomes = []

      for (const switched of SWITCHES) {
        const vm = await lateRead(switched, { page: (database, getters) => tableOf({}, { database, getters }), start: (page) => page.applyLink({ missile: '8' }), reread: (page) => page.readFocusStanding(), held })

        outcomes.push([switched, vm.focusStanding && vm.focusStanding.state])
      }

      return when(outcomes.every(([, state]) => state === 'missing'), outcomes)
    }],
    ['designed: dismissing the notice gives up the link\'s subject', () => {
      const vm = tableOf()

      vm.applyLink({ missile: 'abc' })
      vm.dismissFocusNotice()

      return when(vm.focusNotice === '' && vm.focusMissileId === null && vm.focusDesignId === null, vm.focusNotice)
    }],
    ['designed: a design wins over a missile when a link names both', () => {
      const vm = tableOf()

      vm.applyLink({ design: '9', missile: '7' })

      return when(vm.focusRow && vm.focusRow.SDComponentID === 9 && short(vm.linkQuery) === '{"design":"9"}', vm.linkQuery)
    }],

    // ---------- template ----------
    ['template: every top-level panel of the three pages carries a data-summary, and the planners a head', () => {
      const problems = ['sensors', 'missile', 'designed'].flatMap((name) => panelProblems(template(name), { heads: name !== 'designed' }).map((problem) => `${name}: ${problem}`))
      const handoff = /<v-card[^>]*class="panel"[^>]*data-summary="[^"]{40,}"[^>]*data-planner-link="handoff"/.test(template('sensors'))

      return when(problems.length === 0 && handoff, [...problems, handoff ? '' : 'the handover panel has no summary'])
    }],
    ['template: the missile name sits in a two-line clamp in the panel, the links take the cut label, and the styles clamp it', () => {
      const sensors = template('sensors')
      const style = fs.readFileSync(path.join(rendererDirectory, 'pages', 'sensors.vue'), 'utf8').split('<style')[1] || ''
      const clamped = /<span class="[^"]*handoff-name[^"]*" data-planner-link="name">\{\{ handoffName \}\}<\/span>/.test(sensors) && /\.handoff-name \{[^}]*-webkit-line-clamp: 2;[^}]*\}/.test(style) && /\.handoff-name \{[^}]*overflow: hidden;/.test(style)
      const links = /<page-link :to="handoffBackLink" :name="handoffLabel"/.test(sensors) && /<page-link :to="handoffDesignedTech" :name="handoffLabel"/.test(sensors)

      return when(clamped && links, { clamped, links })
    }],
    ['template: the words of the links and the notices keep to the impersonal voice', () => {
      const texts = [wordsOf(template('compare')), wordsOf(template('sensors').split('data-planner-link="handoff"')[1].split('</v-card>')[0]), ...(template('missile').match(/data-link="notice"[^>]*>[^<]*/g) || []), ...(template('designed').match(/data-planner-link="design"[^>]*>[^<]*/g) || [])]
      const vm = sensorsPage()
      const messages = [
        ...['missing', 'other-race', 'unowned', 'not-researched'].map((state) => m.pl.resolveMissileTarget({ target: SAVED, standing: { id: 7, state, name: 'Hawk', text: { missing: m.pl.missileStanding({ id: 7, row: null, raceId: 1 }).text, 'other-race': standing(7, { owner: 3 }).text, unowned: m.pl.missileStanding({ id: 7, row: { Name: 'H', OwnerID: null }, raceId: 1 }).text, 'not-researched': standing(7, { held: 0 }).text }[state] }, tech }).problems[0]),
        ...m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7, { size: 14, range: 5, name: 'X' }), tech }).notes,
        ...m.pl.resolveMissileTarget({ target: { ...HYPOTHETICAL, tech: [{ type: EM, id: 2011, kind: 'hypothetical' }, { type: EM, id: 98765, kind: 'researched' }] }, standing: undefined, tech }).notes,
        ...m.dl.queryMissileTarget({ msp: 'x', src: 'guess', missile: 'a', res: 'q', jam: '-1', tech: 'z' }).problems,
        vm.handoffNotAppliedText,
        m.pl.componentPlacementText({ standing: m.pl.componentStanding({ id: 9, row: { Name: 'S', Held: 1 } }), mode: 'Beam FC', found: false }),
        ...Object.values(m.pl.resolveMissileTarget({ target: SAVED, standing: standing(7), tech }).origin.assumptions),
        m.pl.missileHandoff(null).reason,
        m.pl.missileHandoff(blankDraft, SCENARIO).reason,
        m.pl.missileLinkState({ standing: standing(7), name: 'Falcon' }).text,
      ]
      const found = [...texts.map((text) => (PRONOUNS.test(text) ? text.slice(0, 80) : '')), ...messages.map((text) => (PRONOUNS.test(text) ? text.slice(0, 80) : ''))].filter(Boolean)

      return when(found.length === 0 && messages.length > 14 && texts.every((text) => text.length > 0), found)
    }],
    ['template: every link of the handover is a page link, which a keyboard reaches and activates', () => {
      const sensors = template('sensors')
      const compare = template('compare')
      const designed = template('designed')
      const missile = template('missile')
      const pageLink = fs.readFileSync(vuePath('components', 'page', 'PageLink.vue'), 'utf8')
      const wanted = [
        ['sensors back', /<page-link :to="handoffBackLink"[^>]*data-planner-link="back"/.test(sensors)],
        ['sensors designed tech', /<page-link :to="handoffDesignedTech"[^>]*data-planner-link="designed-tech"/.test(sensors)],
        ['sensors tech tree', /<page-link v-if="level.known" :to="linkTo\.techTree\(\{ tech: level\.id \}\)"/.test(sensors)],
        ['compare sensors', /data-compare="sensors-link"[^>]*>[^<]*<page-link :to="links\[column\.key\]\.sensors"/.test(compare)],
        ['compare designed tech', /data-compare="designed-tech-link"[^>]*>[^<]*<page-link :to="links\[column\.key\]\.designedTech"/.test(compare)],
        ['compare reason', /data-compare="handoff-reason"[^>]*>\{\{ links\[column\.key\]\.reason \}\}/.test(compare)],
        ['missile designed tech', /<page-link v-if="baselineLink" :to="baselineLink"/.test(missile)],
        ['designed missile', /<page-link v-if="missileLink\(item\)" :to="missileLink\(item\)"/.test(designed)],
        ['page link is a button with a target', /<v-btn[^>]*:to="to"[^>]*:aria-label="text"/.test(pageLink)],
        ['the notices are dismissible alerts', /dismissible[^>]*data-planner-link="design"/.test(sensors) && /dismissible[^>]*data-planner-link="design"/.test(designed) && /dismissible[^>]*data-link="notice"/.test(missile)],
      ]
      const lacking = wanted.filter(([, found]) => !found).map(([name]) => name)
      const clickLinks = [sensors, compare, designed].filter((text) => /data-planner-link="[^"]*"[^>]*@click|data-compare="[^"]*link"[^>]*@click/.test(text)).length

      return when(lacking.length === 0 && clickLinks === 0, lacking)
    }],
    ['template: every page link of the three pages and the component opens a page of the registry', () => {
      const routes = new Set(Object.keys(m.nav.pageByRoute))
      const targets = [m.dl.linkTo.sensors({ target: SAVED }), m.dl.linkTo.missileDesigner({ missile: 7 }), m.dl.linkTo.designedTech({ missile: 7 }), m.dl.linkTo.designedTech({ design: 9 }), m.dl.linkTo.techTree({ tech: 2002 }), m.dl.linkTo.sensors({ mode: 'beam', sensor: 601 }), m.dl.linkTo.propulsion({ class: 1 })]
      const missing = targets.filter((target) => !routes.has(target.path)).map((target) => target.path)
      const count = ['sensors', 'missile', 'designed', 'compare'].reduce((total, name) => total + pageLinks(template(name)).length, 0)

      return when(missing.length === 0 && count >= 9, [missing, count])
    }],
    ['template: the route table of the links names the missile keys of the three pages', () => {
      const source = fs.readFileSync(path.join(utilitiesDirectory, 'deep-links.js'), 'utf8')

      return when(/\| `\/missile-designer`/.test(source) && /\| `\/designed-tech`[^\n]*missile=<MissileID>/.test(source) && /\| `\/sensors`[^\n]*missile target keys/.test(source) && /\/propulsion/.test(source), 'the route table lacks a key')
    }],

    // ---------- save ----------
    ['save: the missile and component identifiers of the stock save are held, another race\'s or gone', async () => {
      if (!stock) {
        return skipped('the stock save is not there')
      }

      const [owned] = await stock.database.query('select FCT_TechSystem.TechSystemID as ID from FCT_TechSystem join FCT_RaceTech on FCT_RaceTech.TechID = FCT_TechSystem.TechSystemID and FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID = :race where FCT_TechSystem.TechTypeID = 122 and FCT_TechSystem.RaceID = :race limit 1', { replacements: { game: stock.GameID, race: stock.RaceID } })
      const [others] = await stock.database.query('select FCT_MissileType.MissileID as ID from FCT_MissileType join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_MissileType.MissileID and FCT_TechSystem.TechTypeID = 122 where FCT_MissileType.GameID = :game and FCT_TechSystem.RaceID is not null and FCT_TechSystem.RaceID <> :race limit 1', { replacements: { game: stock.GameID, race: stock.RaceID } })
      const [component] = await stock.database.query('select FCT_RaceTech.TechID as ID from FCT_RaceTech join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID = :race limit 1', { replacements: { game: stock.GameID, race: stock.RaceID } })
      const ids = { GameID: stock.GameID, RaceID: stock.RaceID }
      const held = owned[0] ? await m.pl.loadMissileStanding(stock.database, ids, owned[0].ID) : null
      const other = others[0] ? await m.pl.loadMissileStanding(stock.database, ids, others[0].ID) : null
      const gone = await m.pl.loadMissileStanding(stock.database, ids, 987654321)
      const design = component[0] ? await m.pl.loadComponentStanding(stock.database, ids, component[0].ID) : null
      const missing = await m.pl.loadComponentStanding(stock.database, ids, 987654321)

      return when(held && held.state === 'held' && Number.isFinite(held.size) && (!other || other.state === 'other-race') && gone.state === 'missing' && design && design.state === 'held' && missing.state === 'missing', { held, other, gone, design, missing })
    }],
  ]
}

// The faults, each in a copy of a utility, a page or a template, and the statements that must fail for it.
const textOf = (name) => fs.readFileSync(path.join(utilitiesDirectory, `${name}.js`), 'utf8')

const planted = (name, from, to) => ({ sources: { [name]: patched(`${name}.js`, textOf(name), from, to) } })

const MUTATIONS = [
  { name: 'a target with no size is read', utilities: planted('deep-links', "const msp = figure('msp', 'the missile size (msp)', { required: true })", "const msp = figure('msp', 'the missile size (msp)', { required: false })"), fails: ['codec: an unreadable target is refused whole'] },
  { name: 'an unknown figure is written as 0', utilities: planted('deep-links', 'String(Number(value.toPrecision(12))) : null', "String(Number(value.toPrecision(12))) : '0'"), fails: ['codec: an unknown figure is left out', 'codec: a jammer of 0'] },
  { name: 'a candidate with an ID is read', utilities: planted('deep-links', "} else if (source !== 'saved' && MISSILE_TARGET_SOURCES.includes(source) && given('missile')) {", '} else if (false) {'), fails: ['codec: an unreadable target is refused whole'] },
  { name: 'a hypothetical missile needs no hypothetical level', utilities: planted('deep-links', "if (source === 'hypothetical' && !tech.some((item) => item.kind === 'hypothetical')) {", 'if (false) {'), fails: ['codec: an unreadable target is refused whole'] },
  { name: 'a sensor link opens no mode for a target', utilities: planted('deep-links', "mode: target && !mode ? 'active' : mode", 'mode'), fails: ['codec: the links of the pages keep their shapes'] },
  { name: 'a candidate return link names its missile\'s name only', utilities: planted('deep-links', 'name: missile ? name : undefined', 'name'), fails: ['sensors: the panel links back to the Missile Designer'] },
  { name: 'a name is cut when it is written to the query', utilities: planted('deep-links', 'name: target.name ? String(target.name) : null', 'name: target.name ? String(target.name).slice(0, 80) : null'), fails: ['codec: a long saved name is kept whole'] },
  { name: 'a name is cut when it is read from the query', utilities: planted('deep-links', 'String(single(query.name)) : \'\'', 'String(single(query.name)).slice(0, 80) : \'\''), fails: ['codec: a long saved name is kept whole'] },
  { name: 'a long value is quoted whole in a notice', utilities: planted('deep-links', 'export const CUT_LENGTH = 80', 'export const CUT_LENGTH = 1e9'), fails: ['codec: a link that carries very long values'] },
  { name: 'a link names any number of tech levels', utilities: planted('deep-links', 'parts.slice(0, MAX_TARGET_TECH)', 'parts'), fails: ['codec: a link that carries very long values'] },
  { name: 'the origin of the handover carries the whole name', utilities: planted('planner-links', 'name: cutText(target.name ||', 'name: (target.name ||'), fails: ['sensors: a name of 100000 characters'] },
  { name: 'the changed-name sentence carries the whole name', utilities: planted('planner-links', 'it is named $' + '{cutText(standing.name)}, not $' + '{cutText(target.name)}', 'it is named $' + '{standing.name}, not $' + '{target.name}'), fails: ['sensors: a name of 100000 characters'] },
  { name: 'the history label carries the whole name', sensors: mutated('this.handoffLive && this.handoffResolution.applies ? this.handoffLabel : \'\'', 'this.handoffLive && this.handoffResolution.applies ? this.handoffName : \'\''), fails: ['sensors: a name of 100000 characters'] },
  { name: 'an empty tech list verifies a researched candidate', utilities: planted('planner-links', 'if (target.missile === null && target.source === \'researched\' && !levels.length) {', 'if (false) {'), fails: ['resolve: a researched candidate that names no tech level', 'sensors: a researched candidate whose link names no tech'] },
  { name: 'a saved missile hands over the figures rebuilt, not the stored ones', utilities: planted('planner-links', "column.kind === 'saved' && isNumber(cell.stored) ? cell.stored : cell.value", 'cell.value'), fails: ['handoff: a saved missile hands over the stored size'] },
  { name: 'a candidate hands over no tech', utilities: planted('planner-links', 'tech: saved ? [] : column.tech.map(({ type, id, kind }) => ({ type, id, kind }))', 'tech: []'), fails: ['handoff: a reoptimised candidate', 'handoff: a candidate on a hypothetical level', 'designer: every column links'] },
  { name: 'a candidate hands over an ID', utilities: planted('planner-links', 'missile: saved ? column.savedId : null', 'missile: column.savedId || 1'), fails: ['handoff: a reoptimised candidate', 'designer: every column links'] },
  { name: 'a missile whose range is not known is handed over', utilities: planted('planner-links', 'if (missing.length) {', 'if (false) {'), fails: ['handoff: a missile whose size or range is not known', 'designer: a column whose size or range is unknown'] },
  { name: 'a saved missile that is gone still applies', utilities: planted('planner-links', 'if (target.missile !== null && standing.state !== STANDING.HELD) {', 'if (false) {'), fails: ['resolve: a saved missile that is gone', 'sensors: a missile gone, of another race'] },
  { name: 'a saved missile that changed is taken for unchanged', utilities: planted('planner-links', 'if (changes.length) {', 'if (false) {'), fails: ['resolve: a saved missile whose size', 'sensors: a saved missile changed since the link'] },
  { name: 'a hypothetical level does not weaken the status', utilities: planted('planner-links', 'const status = weakened || levels.some((level) => level.hypothetical) ? STATUS.ASSUMED : getRule(SENSOR_RULES.detection).verification', 'const status = getRule(SENSOR_RULES.detection).verification'), fails: ['resolve: a candidate on researched tech', 'sizing: a candidate on hypothetical tech', 'sensors: a candidate on hypothetical tech'] },
  { name: 'a saved missile not read yet is applied', utilities: planted('planner-links', 'if (target.missile !== null && (standing === undefined || standing === null)) {', 'if (false) {'), fails: ['resolve: a saved missile not read yet is pending'] },
  { name: 'a standing read that fails is held', utilities: planted('planner-links', 'return { id, state: STANDING.UNKNOWN, name: \'\', text: `The missile $' + '{id} could not be checked', 'return { id, state: STANDING.HELD, name: \'\', text: `The missile $' + '{id} could not be checked'), fails: ['resolve: a standing read on a database that fails'] },
  { name: 'a name that is not the design\'s is taken for it', utilities: planted('planner-links', 'if (standing && standing.state === STANDING.HELD && name && standing.name !== name) {', 'if (false) {'), fails: ['resolve: the standing of a missile and of a component design'] },
  { name: 'the provenance of the handover is not carried into the signature', utilities: planted('sensor-planner', 'const seenBy = (value, text) => (origin ?', 'const seenBy = (value, text) => (false ?'), fails: ['sizing: a missile target of a saved missile', 'sensors: the range handed over is the wanted range'] },
  { name: 'a blank size is read from the handover', utilities: planted('sensor-planner', 'const label = origin ?', 'const label = false ?'), fails: ['sizing: a missile target of a saved missile'] },
  { name: 'a resolution the window does not offer is read', utilities: planted('deep-links', 'SENSOR_RESOLUTIONS_HS.includes(resolutionNumber)', 'resolutionNumber > 0'), fails: ['codec: a resolution is read only when', 'codec: an unreadable target is refused whole', 'sensors: a resolution the window does not offer'] },
  { name: 'a tech line named twice is read', utilities: planted('deep-links', 'if (tech.some((item) => item.type === Number(match[1]))) {', 'if (false) {'), fails: ['codec: a tech line named twice', 'codec: an unreadable target is refused whole', 'sensors: a tech line named twice'] },
  { name: 'a resolution the window does not offer is handed over', utilities: planted('planner-links', 'isNumber(resolution) && SENSOR_RESOLUTIONS_HS.includes(resolution)', 'isNumber(resolution) && resolution > 0'), fails: ['handoff: a resolution the window does not offer'] },
  { name: 'every read is current', utilities: planted('planner-links', 'export const isCurrentRead = (owner, stamp) => (reads', 'export const isCurrentRead = (owner, stamp) => true || (reads'), fails: ['resolve: a read is current only', 'sensors: a standing read that ends after', 'designer: a standing read that ends after', 'designed: a standing read that ends after'] },
  { name: 'a read that is not the latest is current', utilities: planted('planner-links', '(reads.get(owner) || {})[stamp.name] === stamp.generation && ', ''), fails: ['resolve: a read is current only', 'sensors: a standing read that ends after', 'designer: a standing read that ends after', 'designed: a standing read that ends after'] },
  { name: 'a read of another save, game or race is current', utilities: planted('planner-links', ' && owner.database === stamp.database && owner.GameID === stamp.game && owner.RaceID === stamp.race', ''), fails: ['resolve: a read is current only'] },
  { name: 'the Sensor Planner publishes a late read', sensors: mutated('if (isCurrentRead(this, stamp) && this.handoff && id === this.handoff.missile) {', 'if (this.handoff && id === this.handoff.missile) {'), fails: ['sensors: a standing read that ends after'] },
  { name: 'the Missile Designer publishes a late read', missile: mutated('if (isCurrentRead(this, stamp) && id === this.linkedMissileId) {', 'if (id === this.linkedMissileId) {'), fails: ['designer: a standing read that ends after'] },
  { name: 'Designed Tech publishes a late read', designed: mutated('if (isCurrentRead(this, stamp) && id === (kind', 'if (id === (kind'), fails: ['designed: a standing read that ends after'] },
  { name: 'a settled link keeps naming its missile', missile: mutated('this.releaseLink(\'missile\', choice.id)\n      }\n\n      this.dismissLink()', 'this.releaseLink(\'missile\', choice.id)\n      }'), fails: ['designer: a link is consumed once', 'designer: a link pins the saved missile'] },
  { name: 'opening a comparison keeps the link', missile: mutated('this.baselineId = payload.baselineId\n      this.dismissLink()', 'this.baselineId = payload.baselineId'), fails: ['designer: a link is consumed once'] },
  { name: 'a route step to no missile keeps the baseline', missile: mutated('if (raw === \'\') {\n        this.baselineId = null\n      }\n\n      ', ''), fails: ['designer: a route step to a query with no missile'] },
  { name: 'the range of the handover is not the wanted range', sensors: mutated('this.wantedRange = String(target.range)', 'this.wantedRange = this.wantedRange'), fails: ['sensors: a link with a held saved missile opens Active mode', 'sensors: the range handed over is the wanted range'] },
  { name: 'the resolution of the handover is dropped', sensors: mutated('this.resolutionPick = String(target.resolution)', 'this.resolutionPick = this.resolutionPick'), fails: ['sensors: a link with a held saved missile opens Active mode'] },
  { name: 'the handover is kept in the link after an edit', sensors: mutated('target: this.handoffLive ? this.handoff : null', 'target: this.handoff'), fails: ['sensors: the link stays in the route while the inputs are the missile\'s'] },
  { name: 'the handover is left out of the link', sensors: mutated('target: this.handoffLive ? this.handoff : null', 'target: null'), fails: ['sensors: the link stays in the route while the inputs are the missile\'s', 'sensors: a saved missile changed since the link', 'sensors: a saved missile whose standing is not read yet'] },
  { name: 'an edited range still counts as the missile\'s', sensors: mutated('entered(this.wantedRange) === target.range && ', ''), fails: ['sensors: the link stays in the route while the inputs are the missile\'s'] },
  { name: 'the provenance of the handover outlives an edit', sensors: mutated('origin: this.handoffLive && this.handoffResolution.applies ? this.handoffResolution.origin : null', 'origin: this.handoffResolution && this.handoffResolution.applies ? this.handoffResolution.origin : null'), fails: ['sensors: the link stays in the route while the inputs are the missile\'s'] },
  { name: 'a handover that does not apply still changes the inputs', sensors: mutated('if (!resolution || !resolution.applies || this.handoffApplied || !this.ready) {', 'if (!resolution || this.handoffApplied || !this.ready) {'), fails: ['sensors: a missile gone, of another race'] },
  { name: 'a handover is applied before the page is ready', sensors: mutated('this.handoffApplied || !this.ready) {', 'this.handoffApplied) {'), fails: ['sensors: a handover waits for the page to be ready'] },
  { name: 'an unreadable target loses its reasons', sensors: mutated('this.handoffProblems = parsed ? parsed.problems : []', 'this.handoffProblems = []'), fails: ['sensors: an unreadable target applies none of its figures'] },
  { name: 'a design the mode does not list is left unexplained', sensors: mutated('else if (!this.focusStanding || this.focusStanding.id !== this.focusSensorId) {', 'else if (false) {'), fails: ['sensors: a design a link names that the mode does not list'] },
  { name: 'a later link keeps the earlier handover', sensors: mutated('this.handoff = parsed ? parsed.target : null', 'this.handoff = parsed ? parsed.target : this.handoff'), fails: ['sensors: a later link without a target gives the handover up'] },
  { name: 'a column links to no Sensor Planner', missile: mutated('sensors: handoff.ok ? linkTo.sensors({ target: handoff.target }) : null', 'sensors: null'), fails: ['designer: every column links'] },
  { name: 'a column links to no Designed Tech row', missile: mutated("designedTech: column.kind === 'saved' && column.savedId ? linkTo.designedTech({ missile: column.savedId }) : null", 'designedTech: null'), fails: ['designer: every column links'] },
  { name: 'a link pins a missile of another name', missile: mutated('choice && (!this.linkedMissileName || choice.name === this.linkedMissileName) ? choice : null', 'choice'), fails: ['designer: a link that names a missile with a name'] },
  { name: 'a link that names no listed missile says nothing', missile: mutated('} else if (this.linkedMissileId === null || this.linkedChoice || !this.ready) {', '} else if (true) {'), fails: ['designer: a link that names a missile that is gone'] },
  { name: 'the baseline picked on the page keeps the notice', missile: mutated('this.releaseLink(\'missile\', this.baselineId)\n      this.dismissLink()', "this.releaseLink('missile', this.baselineId)"), fails: ['designer: the notice is given up'] },
  { name: 'the scenario is carried as 0 where blank', missile: mutated('jammer: String(jammer).trim() === \'\' ? 0 : entered(jammer) }', 'jammer: 0 }'), fails: ['designer: every column links'] },
  { name: 'Designed Tech ignores the missile of a link', designed: mutated('this.focusMissileId = queryId(query.missile)', 'this.focusMissileId = null'), fails: ['designed: a link names a missile by its own key', 'designed: a design or a missile no row holds'] },
  { name: 'a missile row links to nothing', designed: mutated('item.CategoryID === MISSILE_CATEGORY_ID ? linkTo.missileDesigner({ missile: item.MissileID, name: item.Name }) : null', 'null'), fails: ['designed: a missile row links to its page'] },
  { name: 'a missile is written back as a design', designed: mutated('{ missile: this.focusRow.MissileID }', '{ design: this.focusRow.SDComponentID }'), fails: ['designed: a link names a missile by its own key'] },
  { name: 'a design that no row holds is left unexplained', designed: mutated('} else if (!this.focusStanding || this.focusStanding.id !== id || this.focusStanding.kind !== kind) {', '} else if (false) {'), fails: ['designed: a design or a missile no row holds'] },
]

// The faults of the templates: each must be found by the template statements.
const TEMPLATE_FAULTS = [
  { name: 'the handover panel loses its summary', templates: { sensors: (text) => text.replace(/ data-summary="The missile handed over[^"]*"/, '') }, fails: ['template: every top-level panel of the three pages'] },
  { name: 'the voice slips into the first person in the handover panel', templates: { sensors: (text) => text.replace('Editing a sizing input ends the handover.', 'I end the handover when you edit a sizing input.') }, fails: ['template: the words of the links and the notices'] },
  { name: 'the voice slips into the second person in the comparison', templates: { compare: (text) => text.replace('Size sensors for this missile', 'Size your sensors for this missile') }, fails: ['template: the words of the links and the notices'] },
  { name: 'the back link is a clickable div', templates: { sensors: (text) => text.replace('<page-link :to="handoffBackLink"', '<div @click="go" data-planner-link="back"').replace('data-planner-link="back" />', 'data-planner-link="back"></div>') }, fails: ['template: every link of the handover is a page link'] },
  { name: 'the comparison shows no reason for a missile it cannot hand over', templates: { compare: (text) => text.replace('data-compare="handoff-reason"', 'data-compare="reason"') }, fails: ['template: every link of the handover is a page link'] },
  { name: 'the notice of the Designed Tech page cannot be dismissed', templates: { designed: (text) => text.replace('type="warning" outlined dense dismissible class="mt-2" data-planner-link="design"', 'type="warning" outlined dense class="mt-2" data-planner-link="design"') }, fails: ['template: every link of the handover is a page link'] },
  { name: 'the missile name is not clamped', templates: { sensors: (text) => text.replace('class="font-weight-medium handoff-name"', 'class="font-weight-medium"') }, fails: ['template: the missile name sits in a two-line clamp'] },
  { name: 'the page links take the whole name', templates: { sensors: (text) => text.replace('<page-link :to="handoffBackLink" :name="handoffLabel"', '<page-link :to="handoffBackLink" :name="handoffName"') }, fails: ['template: the missile name sits in a two-line clamp'] },
]

const parseArguments = (argv) => {
  const options = { stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock') {
      options.stock = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const bindQuery = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
  const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
  const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

  raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
})

const openStock = ([file, GameID, RaceID]) => new Promise((resolve, reject) => {
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

    resolve({ GameID, RaceID, raw, database: { query: bindQuery(raw) } })
  })
})

const runFaults = async (faults) => {
  for (const { name, fails, ...fault } of faults) {
    let outcome

    try {
      const statements = await pageStatements(fault, null)
      const named = statements.filter(([statement]) => fails.some((start) => statement.startsWith(start)))
      const absent = fails.filter((start) => !named.some(([statement]) => statement.startsWith(start)))

      if (absent.length) {
        outcome = `no statement begins ${absent.join('; ')}`
      } else {
        const results = []

        for (const [statement, test] of named) {
          results.push([statement, await settle(test)])
        }

        const held = results.filter(([, result]) => result === true).map(([statement]) => statement)

        outcome = held.length ? `these statements still pass: ${held.join('; ')}` : true
      }
    } catch (error) {
      outcome = `does not load: ${error.message}`
    }

    check(`mutation caught: ${name}`, outcome, `${fails.length} statement${fails.length === 1 ? '' : 's'} named`)
  }
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  const stock = await openStock(options.stock)

  console.log(`Save read by the checks: ${stock ? options.stock[0] : `${options.stock[0]} (not there)`}`)
  console.log('The planner links: codec, handoff, resolve, sizing, sensors, designer, designed, template and save')

  for (const [statement, held] of await pageStatements({}, stock)) {
    check(statement, await settle(held))
  }

  if (options.mutations) {
    console.log('\nMutations: each fault in a copy of a utility, a page or a template must fail the statements it names')
    await runFaults(MUTATIONS)
    await runFaults(TEMPLATE_FAULTS)
  }

  if (stock) {
    stock.raw.close()
  }

  console.log(`\n${checks - failures} of ${checks} checks passed${skips ? `, ${skips} skipped (the save they read is not there)` : ''}`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
