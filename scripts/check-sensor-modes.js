/*
  Checks the three modes of the Sensor Planner page (pages/sensors.vue), the sizing panel its Active mode shares with the Missile Designer, and the links between the Sensor Planner and Designed Tech. The passive mode's own checks are scripts/check-sensor-planner.js; the sizing rules are scripts/check-sensor-sizing.js; the plan is docs/plans/planners/sensor-fire-control.md.

  node scripts/check-sensor-modes.js [--stock <save.db> <GameID> <RaceID>] [--no-mutations]

  Groups (the pages' scripts on a pseudo instance, scripts/lib/page-loader.js, over a synthetic race written here; their templates read as text):
  - mode: the mode is kept for the race, a link names the mode and the design and the page writes the same query back, a mode that is not one is ignored, the switch drops a design of another mode, a linked design is the saved pair and a picked pair wins until a link names a design;
  - tech: the three modes read one tech contract (the same levels, a hypothetical level marking the figures of every mode that reads it and only those), the menu lists the lines of the open mode;
  - active: a blank target, range or tech is unknown and never 0, the typed problems are reported, a class with a cloak is sized in both scenarios, the saved pair, the range curve (chart and table the same points), the hardening and ECCM rows, the existing designs and the classes against the proposed pair;
  - beam: the two axes sized apart, the single weapon switch read only where the tech offers it, the saved controls held to range and tracking apart, the multiplier table;
  - passive: a proposed sensor of a typed size leads the curves of its kind, a blank size proposes nothing;
  - template: a table beside every chart, a provenance mark on every figure, a data-summary on every panel, the impersonal voice;
  - embed: the Missile Designer's sizing panel is prefilled from its scenario, its baseline and the launcher card, keeps its edits to itself and uses the page's tech;
  - links: a sensor or fire control row of Designed Tech opens the Sensor Planner on its mode and design, and the Sensor Planner's designs open Designed Tech;
  - load: the page's reads of the active sensors and the beam fire controls are tracked under their names;
  - save: the stock save's active sensors and beam fire controls, sized for its own tech.

  Mutants: each deliberate fault in a copy of a page's script must fail the checks it names.

  Prints `N of N checks passed`; any failed check sets exit code 1. A check whose save is not there is reported as skipped, never as passed.
*/
const fs = require('fs')
const path = require('path')
const nodeVm = require('vm')
const Vue = require('vue')
const { compileTemplate } = require('vue/compiler-sfc')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const pagePath = path.join(rendererDirectory, 'pages', 'sensors.vue')
const missilePagePath = path.join(rendererDirectory, 'pages', 'missile-designer.vue')
const componentPath = (name) => path.join(rendererDirectory, 'components', 'sensors', `${name}.vue`)

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

const FIELDS_STUB = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => { globalThis.__modesFields = Object.assign(globalThis.__modesFields || {}, fields); return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'

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

const close = (a, b, tolerance = 1e-9) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))

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

// Strength 16 per HS, EM 8, thermal 8, hardening 50 at a cost factor of 1.25, ECCM 1 at 1.1, a distance rating of 64,000 km, a speed rating of 4,000 km/s and the multi-weapon control; each line but the thermal one also has a level to research.
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

const researchedAlso = (levels, ...ids) => levels.map((item) => (ids.includes(item.id) ? { ...item, researched: true } : item))

// The hypothetical choices of the strength, hardening and distance lines, as the page holds them when the scenario record cannot be written.
const HELD = Object.freeze({ [STRENGTH]: { techId: 2003, name: 'Strength 24' }, [HARDENING]: { techId: 2033, name: 'Hardening 25' }, [DISTANCE]: { techId: 2052, name: 'Distance 128000' } })

const buildTech = (m, levels = LEVELS) => {
  const researched = levels.filter((item) => item.researched)
  const raw = m.rt.buildRaceTech(researched.map((item) => researchedRow(item.id, item.type, item.name, item.cost, item.info, item.info2)))
  const catalogue = levels.map((item) => catalogueRow(item.id, item.type, item.name, item.cost, item.info, { AdditionalInfo2: item.info2, Prerequisite1: item.prerequisite }))

  return m.ts.withCandidates(raw, { catalogue, raceId: RACE, researched: researched.map((item) => item.id), eligible: [], projects: [], queued: [], paused: [] })
}

const ENGINE_TECHS = Object.freeze({ engine: 40, fuel: 65, thermal: 101 })

const engine = (fields) => Object.freeze({ id: 11, name: 'Ion', power: 250, thermalRating: 1, thrust: 1, sizeHS: 10, count: 2, techIds: ENGINE_TECHS, ...fields })

const record = (fields) => Object.freeze({ obsolete: false, commercial: false, engines: [], cloaks: [], activeSensors: [], thermalSensors: [], emSensors: [], ...fields })

// A cloaked class (cross-section 50, 100 with the cloak damaged), a bare one (40) and an obsolete one (20).
const CLOAKER = record({ id: 1, name: 'Cloaker', sizeHS: 100, stored: { crossSection: 50, sensorReduction: 0.5, thermal: 500, enginePower: 500, speed: 5000, shieldStrength: 10 }, engines: [engine()], cloaks: [{ id: 21, name: 'Cloak', maxShipHS: 200, rating: 0.5, count: 1 }] })
const BARE = record({ id: 2, name: 'Bare', sizeHS: 40, stored: { crossSection: 40, sensorReduction: 1, thermal: 0, enginePower: 0, speed: 0, shieldStrength: 0 } })
const OLD_CLASS = record({ id: 3, name: 'Oldie', obsolete: true, sizeHS: 20, stored: { crossSection: 20, sensorReduction: 1, thermal: 0, enginePower: 0, speed: 0, shieldStrength: 0 } })
const CLASSES = Object.freeze([CLOAKER, BARE, OLD_CLASS])

const activeRow = (fields) => Object.freeze({ type: 24, kind: 'search', sizeHS: 4, cost: 40, crew: 10, uridium: 5, corbomite: 0, rangeKm: 2e7, resolution: 20, eccm: 0, ctd: 2, strength: 64, obsolete: false, ...fields })

const SEARCH = activeRow({ id: 501, name: 'Search 20' })
const FIRE_CONTROL = activeRow({ id: 502, name: 'MFC 20', type: 25, kind: 'fireControl', rangeKm: 4e7 })
const OLD_SEARCH = activeRow({ id: 503, name: 'Search old', rangeKm: 1e7, resolution: 10, obsolete: true })
const ACTIVE = Object.freeze([SEARCH, FIRE_CONTROL, OLD_SEARCH])

const MANY = Object.freeze(Array.from({ length: 10 }, (_, index) => activeRow({ id: 700 + index, name: `Search ${index + 1}`, rangeKm: 1e7 * (index + 1) })))

const BEAM = Object.freeze({ id: 601, name: 'Beam FC', type: 19, sizeHS: 3, cost: 30, crew: 5, uridium: 1, corbomite: 0, rangeKm: 128000, trackingKmS: 4000, rangeMultiplier: 2, trackingMultiplier: 1, specialFunction: 0, eccm: 0, ctd: 1, obsolete: false })
const OLD_BEAM = Object.freeze({ ...BEAM, id: 602, name: 'Beam old', rangeKm: 64000, trackingKmS: 2000, obsolete: true })
const BEAMS = Object.freeze([BEAM, OLD_BEAM])

const OWNED = Object.freeze([
  { SDComponentID: 41, Name: 'Thermal 25', ComponentTypeID: 8, ComponentValue: 25 },
  { SDComponentID: 42, Name: 'EM 16', ComponentTypeID: 41, ComponentValue: 16 },
])

const NOTHING = { enemyThermal: '', enemyEm: '', enemyRange: '', enemyResolution: '' }

// ---------- the templates ----------

const templateOf = (source) => {
  const parsed = require(path.join(root, 'node_modules', 'vue', 'compiler-sfc')).parse({ source })

  return (parsed.template || parsed.descriptor.template).content
}

const TEMPLATE = (mutate = (text) => text) => mutate(templateOf(fs.readFileSync(pagePath, 'utf8')))

const panelProblems = (template) => {
  const panels = template.match(/<v-card\b[^>]*class="panel"[^>]*>/g) || []
  const heads = (template.match(/class="panel-head"/g) || []).length
  const bare = panels.filter((tag) => !/data-summary="[^"]{20,}"/.test(tag))

  return [...(panels.length ? [] : ['the template has no panel']), ...(bare.length ? [`${bare.length} of ${panels.length} panels have no data-summary`] : []), ...(heads === panels.length ? [] : [`${panels.length} panels and ${heads} panel heads`])]
}

const PRONOUNS = /\b(?:me|my|myself|we|our|ours|ourselves|you|your|yours|yourself)\b|\bI\b/

const wordsOf = (template) => {
  const summaries = (template.match(/data-summary="[^"]*"/g) || []).join(' ')
  const text = template.replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ')

  return `${text} ${summaries}`
}

const FIGURE = /\{\{ *(shown|count|percent)\(/g

const unmarked = (template) => template.split('\n').filter((line) => (line.match(FIGURE) || []).length > (line.match(/<provenance-mark/g) || []).length)

const cellCount = (template) => template.split('\n').reduce((total, line) => total + (line.match(FIGURE) || []).length, 0)

// The problems of the charts of a template: every chart is drawn only while its view is the chart, has a toggle to a table of the same points, and the table is there.
const chartProblems = (template) => {
  const charts = (template.match(/<chart-canvas\b/g) || []).length
  const views = new Set([...template.matchAll(/(\w+View) === 'chart'/g)].map((match) => match[1]))
  const toggles = (template.match(/<v-btn value="table"/g) || []).length
  const tables = ['speed-table', 'passive-$' + '{set.kind}-table', 'curve-table'].filter((name) => template.includes(name))

  return [...(charts === views.size ? [] : [`${charts} charts and ${views.size} chart views`]), ...(toggles === charts ? [] : [`${charts} charts and ${toggles} table toggles`]), ...(tables.length === charts ? [] : [`${charts} charts and ${tables.length} tables`])]
}

// The typed fields among `names` that no input of the template is bound to.
const unboundTyped = (template, names) => names.filter((name) => !template.includes(`v-model="${name}"`))

// The template compiled to render functions, and the walk of a rendered tree. `mutate` rewrites the template first (a planted fault) and is compiled each time; the stock template is compiled once. The Vuetify elements are not registered, so Vue's warnings about unknown elements are silenced.
let compiledRender = null

Vue.config.silent = true
Vue.config.productionTip = false

const renderFunctions = (mutate = null) => {
  if (mutate || !compiledRender) {
    const compiled = compileTemplate({ source: TEMPLATE(mutate || undefined), filename: 'sensors.vue', id: 'sensors' })

    if (compiled.errors.length) {
      throw new Error(`The template does not compile: ${compiled.errors.join('; ')}`)
    }

    const functions = nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)

    if (mutate) {
      return functions
    }

    compiledRender = functions
  }

  return compiledRender
}

const textOf = (node) => (typeof node.text === 'string' ? node.text : (node.children || []).map(textOf).join(''))

const nodesOf = (node, test, found = []) => {
  if (test(node)) {
    found.push(node)
  }

  ;(node.children || []).forEach((child) => nodesOf(child, test, found))

  return found
}

const attributeOf = (node, name) => (node.data && node.data.attrs ? node.data.attrs[name] : undefined)

// A boolean attribute is on unless it is absent or bound to false, as Vuetify reads it: a static `disabled` or `readonly` compiles to an empty string and is on.
const flagged = (node, name) => ![undefined, null, false].includes(attributeOf(node, name))

// An input that takes what is typed: neither disabled nor read-only, and bound to a value it can write.
const editable = (node) => !flagged(node, 'disabled') && !flagged(node, 'readonly') && Boolean(node.data.model && typeof node.data.model.callback === 'function')

// ---------- the pages ----------

let loadedModules = null

const modules = async () => {
  if (!loadedModules) {
    const loaded = await loadUtilities(['design-rules', 'provenance', 'signatures', 'sensor-planner', 'sensor-view', 'race-tech', 'tech-scenarios', 'design-data'], { stubs: STUBS })

    loadedModules = { dr: loaded['design-rules'], sp: loaded['sensor-planner'], sv: loaded['sensor-view'], rt: loaded['race-tech'], ts: loaded['tech-scenarios'], dd: loaded['design-data'] }
  }

  return loadedModules
}

const asyncNamesOf = (options) => [...new Set([...(options.mixins || []).flatMap(asyncNamesOf), ...Object.keys(options.asyncComputed || {})])].filter((name) => name !== 'records')

// The missile designer's page options, loaded with the fields stub of this script.
const MISSILE_STORE = { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }

const pageStatements = async (mutates, stock) => {
  const { sensors = null, missile = null, designed = null, panel = null, template = null } = mutates || {}

  globalThis.__modesFields = {}

  const options = await loadPage('pages/sensors', { stubs: STUBS, mutate: sensors, modules: { 'mixins/persisted-view': FIELDS_STUB, 'mixins/load-state': null } })
  const fields = globalThis.__modesFields

  globalThis.__modesFields = {}

  const missileOptions = await loadPage('pages/missile-designer', { stubs: STUBS, mutate: missile, modules: { 'mixins/persisted-view': FIELDS_STUB } })
  const missileFields = globalThis.__modesFields

  globalThis.__modesFields = {}

  const designedOptions = await loadPage('pages/designed-tech', { stubs: STUBS, mutate: designed, modules: { 'mixins/persisted-view': FIELDS_STUB } })
  const designedFields = globalThis.__modesFields
  const panelOptions = await loadPage('components/sensors/ActiveSizingPanel', { stubs: STUBS, mutate: panel })
  const realOf = (name, mutate) => loadPage(name, { stubs: STUBS, mutate, modules: { 'mixins/persisted-view': null, 'mixins/load-state': null } })
  const realSensors = await realOf('pages/sensors', sensors)
  const realMissile = await realOf('pages/missile-designer', missile)
  const realDesigned = await realOf('pages/designed-tech', designed)
  const m = await modules()
  const tech = buildTech(m)
  const techWith = (...ids) => buildTech(m, researchedAlso(LEVELS, ...ids))
  const store = { getters: {}, state: {} }
  const page = (data = {}) => instantiate(options, { $store: store, database: {}, GameID: 138, RaceID: RACE, data: { classRead: CLASSES, ownedRows: OWNED, activeRows: ACTIVE, beamRows: BEAMS, tech, reduction: { levels: [], techs: {} }, loadErrors: {}, ready: true, ...NOTHING, ...data } })
  // The page as Vue renders it: the page's script with its template compiled, over the same data as `page`. Elements the page does not register stay plain nodes, so what is read is their attributes, bound values and text.
  const rendered = (data = {}) => {
    const { render, staticRenderFns } = renderFunctions(template)
    const getters = { database: {}, GameID: 138, RaceID: RACE, config: { get: (_name, fallback) => fallback } }
    const Page = Vue.extend({ mixins: [options], data: () => ({ classRead: CLASSES, ownedRows: OWNED, activeRows: ACTIVE, beamRows: BEAMS, tech, reduction: { levels: [], techs: {} }, loadErrors: {}, ready: true, ...NOTHING, ...data }), beforeCreate () { this.$store = { getters, state: {} } }, render, staticRenderFns })
    const vm = new Page()
    const tree = vm._render()

    return { vm, tree, chip: nodesOf(tree, (node) => attributeOf(node, 'data-sensors') === 'jammer-idle')[0], input: nodesOf(tree, (node) => attributeOf(node, 'data-sensors') === 'jammer')[0] }
  }
  const known = (result) => result.status !== 'unavailable'
  const noted = (result, text) => JSON.stringify(result.assumptions || []).includes(text)
  const SIZED = { targetTons: '250', wantedRange: '20000000' }
  const BEAM_WANTED = { beamRange: '128000', beamTracking: '4000' }
  const pronouns = (texts) => texts.filter((text) => PRONOUNS.test(text))

  return [
    // ---------- persisted view, as the app builds it ----------
    ['view: each page restores every field it declares under the real persisted view, from the keys stored for the race and the app', () => {
      const prefix = 'campaign.c1.race.7'
      const stored = { [`${prefix}.sensorsMode`]: 'beam', [`${prefix}.sensorsTech`]: { [STRENGTH]: 2001 }, sensorsCurveView: 'table' }
      const real = { getters: { racePrefix: prefix, config: { get: (key) => stored[key], set: () => {} } }, state: {} }
      const open = (options) => instantiate(options, { $store: real, database: {}, GameID: 138, RaceID: RACE })
      const missing = (vm, declared) => Object.keys(declared).filter((name) => vm[name] === undefined)
      const sensorsVm = open(realSensors)
      const found = { sensors: missing(sensorsVm, fields), missile: missing(open(realMissile), missileFields), designed: missing(open(realDesigned), designedFields) }

      return Object.values(found).every((names) => names.length === 0) && sensorsVm.mode === 'beam' && short(sensorsVm.techChoice) === `{"${STRENGTH}":2001}` && sensorsVm.curveView === 'table' && sensorsVm.hideObsolete === false && Object.keys(fields).length > 20 ? true : short(found)
    }],
    // ---------- mode ----------
    ['mode: the mode is kept for the race, starts in active mode and only the three modes are kept', () => {
      const field = fields.mode

      return field && field.key === 'sensorsMode' && field.scope === 'race' && field.default === 'active' && ['active', 'passive', 'beam'].every((mode) => field.valid(mode)) && !field.valid('all') && !field.valid(null) && !field.valid(1) && page().mode === 'active' ? true : short(field)
    }],
    ['mode: a link names the mode and the design, and the page writes the same query back', () => {
      const vm = page()

      vm.applyLink({ mode: 'beam', sensor: '601' })

      const beam = { mode: vm.mode, focus: vm.focusSensorId, row: vm.focusRow && vm.focusRow.name, query: vm.linkQuery, label: vm.linkLabel }

      vm.applyLink({ mode: 'active', sensor: '502' })
      vm.applyLink({ mode: ['passive', 'beam'], sensor: '41' })

      return beam.mode === 'beam' && beam.focus === 601 && beam.row === 'Beam FC' && short(beam.query) === '{"mode":"beam","sensor":"601"}' && beam.label === 'Beam FC' && vm.mode === 'passive' && vm.focusRow && vm.focusRow.name === 'Thermal 25' && short(vm.linkQuery) === '{"mode":"passive","sensor":"41"}' ? true : short({ beam, passive: vm.linkQuery })
    }],
    ['mode: a link with no mode keeps the restored mode, a mode that is not one is ignored, and a design the open mode does not have leaves the query', () => {
      const vm = page({ mode: 'beam' })

      vm.applyLink({ sensor: '601' })

      const kept = vm.mode

      vm.applyLink({ mode: 'everything' })

      const ignored = vm.mode

      vm.applyLink({ mode: 'active', sensor: '601' })

      return kept === 'beam' && ignored === 'beam' && vm.mode === 'active' && vm.focusRow === null && short(vm.linkQuery) === '{"mode":"active"}' && page({ ready: false }).linkQuery === null ? true : short([kept, ignored, vm.mode, vm.linkQuery])
    }],
    ['mode: the switch keeps a design of the open mode and drops one of another mode', () => {
      const vm = page({ mode: 'beam', focusSensorId: 601 })

      vm.setMode('beam')

      const same = vm.focusSensorId

      vm.setMode('passive')

      const dropped = vm.focusSensorId

      vm.setMode('nothing')

      return same === 601 && dropped === null && vm.mode === 'passive' ? true : short([same, dropped, vm.mode])
    }],
    ['mode: a linked design is the saved pair until another is picked, and a link that names a design clears a pick', () => {
      const vm = page({ pairSearchId: 503 })

      vm.applyLink({ mode: 'active', sensor: '502' })

      const linked = { search: vm.pairSearch && vm.pairSearch.id, fireControl: vm.pairFireControl && vm.pairFireControl.id }

      const picked = page({ pairFcId: 502, pairSearchId: 503, focusSensorId: 501 })
      const wins = { search: picked.pairSearch.id, fireControl: picked.pairFireControl.id }
      const cleared = { search: vm.pairSearchId, fireControl: vm.pairFcId }

      return linked.search === null && linked.fireControl === 502 && wins.search === 503 && wins.fireControl === 502 && cleared.search === null && cleared.fireControl === null ? true : short({ linked, wins, cleared })
    }],

    // ---------- tech ----------
    ['tech: the three modes read one tech contract, a hypothetical level marking the figures of each mode that reads it', () => {
      const vm = page({ heldChoices: HELD, ...SIZED, ...BEAM_WANTED, passiveSize: '10' })
      const base = page({ ...SIZED, ...BEAM_WANTED, passiveSize: '10' })
      const outcome = (target) => ({
        strength: target.techInput.strength.hypothetical,
        distance: target.techInput.distance.hypothetical,
        hardening: target.techInput.hardening.hypothetical,
        active: noted(target.sizing.tiles.sizeNeeded, 'Strength 24'),
        beam: noted(target.beam.tiles.range, 'Distance 128000'),
        passive: noted(target.passiveProposals[0].proposal.design, 'Hardening 25'),
      })
      const held = outcome(vm)
      const none = outcome(base)
      const modes = ['active', 'passive', 'beam'].map((mode) => {
        vm.mode = mode

        return vm.techInput.strength.info
      })

      return held.strength && held.distance && held.hardening && held.active && held.beam && held.passive && Object.values(none).every((value) => value === false) && modes.every((value) => value === 24) ? true : short({ held, none, modes })
    }],
    ['tech: a level set in one mode is the level of the other modes, and the mode that does not read a line does not mark its figures', () => {
      const vm = page({ techChoice: { [STRENGTH]: 2001 }, ...SIZED, ...BEAM_WANTED })
      const active = vm.sizing.tiles.sizeNeeded
      const strength = vm.techInput.strength.info

      vm.mode = 'beam'

      const beamStrength = vm.techInput.strength.info
      const beamRead = vm.beam.tiles.range

      const held = page({ heldChoices: { [STRENGTH]: HELD[STRENGTH] }, ...BEAM_WANTED, mode: 'beam' })

      return strength === 10 && beamStrength === 10 && known(active) && known(beamRead) && held.hypotheticalNotice === '' && !noted(held.beam.tiles.range, 'Strength 24') && page({ heldChoices: { [STRENGTH]: HELD[STRENGTH] }, mode: 'active' }).hypotheticalNotice.includes('Strength 24') ? true : short({ strength, beamStrength, notice: held.hypotheticalNotice })
    }],
    ['tech: the menu lists the lines the open mode reads, and counts the lines changed in that mode', () => {
      const typesOf = (mode) => page({ mode }).modeTechLines.map((line) => line.type).sort((a, b) => a - b).join()
      const lines = { active: typesOf('active'), passive: typesOf('passive'), beam: typesOf('beam') }
      const changed = (mode) => page({ mode, techChoice: { [STRENGTH]: 2001 } }).modeChangedCount
      const read = (mode) => [...m.sp.SENSOR_MODE_LINES[mode]].map((role) => m.sp.SENSOR_TECH_LINES.find((entry) => entry.role === role).typeId).sort((a, b) => a - b).join()

      return lines.active === read('active') && lines.passive === read('passive') && lines.beam === read('beam') && lines.active !== lines.passive && lines.passive !== lines.beam && changed('active') === 1 && changed('passive') === 0 && changed('beam') === 0 ? true : short({ lines, changed: [changed('active'), changed('passive'), changed('beam')] })
    }],

    // ---------- active ----------
    ['active: a blank target, range or tech is unknown and shown as Unknown, never 0', () => {
      const blank = page()
      const noTech = page({ ...SIZED, tech: m.ts.NO_TECH_CHOICES })
      const unknown = (vm) => vm.activeTiles.every((tile) => tile.value === 'Unknown' && !known(tile.result)) && vm.sizing.rows.every((row) => !row.feasible)
      const noRange = page({ targetTons: '250' })
      const noTarget = page({ wantedRange: '20000000' })
      const sized = page({ ...SIZED })

      return unknown(blank) && unknown(noTech) && unknown(noRange) && unknown(noTarget) && known(sized.activeTiles[1].result) && sized.activeTiles[1].value !== 'Unknown' && sized.activeTiles[1].result.value > 0 ? true : short(noTech.activeTiles.map((tile) => tile.value))
    }],
    ['active: what is typed and not a number is reported in the impersonal voice, a blank field is not a problem', () => {
      const blank = page().activeProblems
      const typed = page({ targetTons: 'big', wantedRange: '0', jammer: '-1', curveTonsText: '10, tall' }).activeProblems
      const missile = page({ targetKind: 'missile', targetMsp: 'x', targetTons: 'big' }).activeProblems
      const zero = page({ jammer: '0', ...SIZED }).activeProblems

      return blank.length === 0 && typed.length === 4 && missile.length === 1 && missile[0].startsWith('Missile size') && zero.length === 0 && pronouns([...typed, ...missile]).length === 0 && page({ jammer: '0' }).shownProblems.length === 0 && page({ mode: 'beam', beamRange: 'far' }).shownProblems.length === 1 && page({ mode: 'passive', enemyThermal: '-3' }).shownProblems.length === 1 ? true : short({ typed, missile, zero })
    }],
    ['active: a class with a working cloak is sized in two scenarios, the cloak working and damaged, and the rest in one', () => {
      const cloaked = page({ targetKind: 'class', targetClassId: 1, wantedRange: '20000000' })
      const bare = page({ targetKind: 'class', targetClassId: 2, wantedRange: '20000000' })
      const [working, damaged] = cloaked.sizingScenarios

      return cloaked.sizingScenarios.length === 2 && working.label === 'Cloak working' && damaged.label === 'Cloak damaged' && known(working.sizing.tiles.sizeNeeded) && known(damaged.sizing.tiles.sizeNeeded) && working.sizing.tiles.sizeNeeded.value > damaged.sizing.tiles.sizeNeeded.value && bare.sizingScenarios.length === 1 && page({ targetKind: 'tons' }).sizingScenarios.length === 1 ? true : short(cloaked.sizingScenarios.map((scenario) => [scenario.label, scenario.sizing.tiles.sizeNeeded.value]))
    }],
    ['active: the sizing is the planner\'s for the target, the range and the resolution typed', () => {
      const other = page({ ...SIZED, jammer: '1' }).sizing.rows.find((row) => row.feasible && !row.best)
      const pick = other ? String(other.resolution) : '5'
      const vm = page({ ...SIZED, resolutionPick: pick, jammer: '1' })
      const direct = m.sp.activeSizing({ target: m.sp.targetOf({ kind: 'tons', tons: '250' }), wantedRangeKm: '20000000', resolution: pick, jammer: '1', tech: m.sp.sensorTechOf(tech, m.ts.resolveChoices(tech)) })
      const best = page({ ...SIZED, jammer: '1' }).sizing.selected.resolution

      return other && best !== Number(pick) && vm.sizing.selected.resolution === Number(pick) && vm.sizing.rows.length === direct.rows.length && close(vm.sizing.tiles.sizeNeeded.value, direct.tiles.sizeNeeded.value) && close(vm.sizing.tiles.cost.value, direct.tiles.cost.value) && page({ ...SIZED }).sizing.selected.best === true ? true : short([best, pick, vm.sizing.selected.resolution, vm.sizing.tiles.sizeNeeded.value, direct.tiles.sizeNeeded.value])
    }],
    ['active: the saved pair is checked for each scenario, and with no pick there is none', () => {
      const none = page({ ...SIZED }).pairChecks
      const vm = page({ ...SIZED, pairSearchId: 501, pairFcId: 502 })
      const [entry] = vm.pairChecks
      const reversed = page({ ...SIZED, pairSearchId: 503, pairFcId: 502 }).pairChecks

      return none.length === 0 && vm.pairChecks.length === 1 && entry.check.search.row.id === 501 && entry.check.fireControl.row.id === 502 && entry.members.length === 2 && typeof entry.check.meets === 'boolean' && known(entry.check.reach) && entry.alternative.length === 1 && reversed.length === 1 && reversed[0].check.search.row.id === 503 && reversed[0].check.reach.value !== entry.check.reach.value ? true : short({ none: none.length, checks: vm.pairChecks.length, meets: entry.check.meets, reach: entry.check.reach.status, alt: entry.alternative.length, sel: entry.check.alternative.basis, search: entry.check.search.row.id })
    }],
    ['active: the range curve starts with the proposed pair and the chart and the table carry the same points', () => {
      const vm = page({ ...SIZED })
      const names = vm.curve.series.map((series) => series.name)
      const same = vm.curveChart.data.datasets.every((dataset, index) => {
        const column = vm.curve.rows.map((row) => ({ x: row.tons, result: row.ranges[index].result })).filter(({ x, result }) => known(result) && x > 0 && result.value > 0)

        return dataset.label === vm.curve.series[index].name && dataset.data.length === column.length && dataset.data.every((point, place) => close(point.x, column[place].x) && close(point.y, column[place].result.value / 1e6, 1e-9))
      })

      return names.slice(0, 2).join() === 'Proposed search sensor,Proposed missile fire control' && names.length === 5 && vm.curve.rows.length === 10 && same && vm.curveChart.data.datasets.length === 5 && vm.curveChart.data.datasets[2].data.length > 0 ? true : short({ names, rows: vm.curve.rows.length })
    }],
    ['active: the curve takes the sizes typed, falls back to the defaults for a list that is not read, and has no point for an unknown sensor', () => {
      const typed = page({ ...SIZED, curveTonsText: '500, 100 100' })
      const bad = page({ ...SIZED, curveTonsText: '10, tall' })
      const none = page({ activeRows: [] })
      const noRange = page({ activeRows: [activeRow({ id: 800, name: 'No range', rangeKm: null })], targetTons: '250' })

      return typed.curve.rows.map((row) => row.tons).join() === '100,500' && bad.curve.rows.length === 10 && bad.activeProblems.length === 1 && none.curve.series.length === 0 && noRange.curve.series.length === 1 && noRange.curve.series[0].points.length === 0 && noRange.curveChart.data.datasets[0].data.length === 0 ? true : short([typed.curve.rows.map((row) => row.tons), bad.curve.rows.length, none.curve.series.length])
    }],
    ['active: the chart draws the first eight sensors and the table lists every one', () => {
      const vm = page({ ...SIZED, activeRows: MANY })

      return vm.curve.series.length === 12 && vm.curveChart.data.datasets.length === 8 && vm.curveChart.hidden === 4 && vm.curveChart.series.length === 8 && vm.curve.rows.every((row) => row.ranges.length === 12) ? true : short([vm.curve.series.length, vm.curveChart.data.datasets.length, vm.curveChart.hidden])
    }],
    ['active: the hardening and ECCM rows are one for each level pair and mark the level in use', () => {
      const vm = page({ ...SIZED, jammer: '1' })
      const rows = vm.tradeoff.rows
      const hypothetical = page({ ...SIZED, heldChoices: { [HARDENING]: HELD[HARDENING] } }).tradeoff.rows
      const none = page().tradeoff

      return rows.length === 4 && rows.filter((row) => row.current).length === 1 && rows.every((row) => known(row.cost) && known(row.uridium) && known(row.corbomite) && known(row.reach)) && hypothetical.length === 6 && hypothetical.filter((row) => row.hardening.hypothetical).length === 2 && none.rows.length === 0 ? true : short({ rows: rows.length, hypothetical: hypothetical.length, none: none.rows.length })
    }],
    ['active: the existing designs are the saved sensors with a reach for each scenario, the obsolete ones leave when hidden, and the reach is unknown without a target', () => {
      const vm = page({ ...SIZED })
      const hidden = page({ ...SIZED, hideObsolete: true })
      const search = vm.existingItems.find((item) => item.id === 501)
      const cloaked = page({ targetKind: 'class', targetClassId: 1, wantedRange: '1' })
      const blank = page()

      return vm.existingItems.length === 3 && hidden.existingItems.length === 2 && !hidden.existingItems.some((item) => item.id === 503) && close(search.reacheffective, 2e7 * (5 / 20) ** 2) && search.kind === 'Search sensor' && vm.existingItems.find((item) => item.id === 502).kind === 'Missile fire control' && cloaked.existingHeaders.filter((header) => header.value.startsWith('reach')).length === 2 && blank.existingItems.every((item) => item.reacheffective === null && !known(item.reaches[0].reach)) && search.size.status === 'confirmed' ? true : short([vm.existingItems.length, hidden.existingItems.length, search.reacheffective])
    }],
    ['active: the classes against the proposed pair are a row for each scenario of each class shown, and none without a proposed pair', () => {
      const vm = page({ ...SIZED })
      const hidden = page({ ...SIZED, hideObsolete: true })
      const blank = page()

      return vm.classReachRows.length === 4 && hidden.classReachRows.length === 3 && vm.classReachRows.filter((row) => row.name === 'Cloaker').map((row) => row.label).join() === 'Cloak working,Cloak damaged' && vm.classReachRows.every((row) => known(row.signature) && known(row.search) && known(row.fireControl)) && blank.classReachRows.length === 0 ? true : short([vm.classReachRows.length, hidden.classReachRows.length])
    }],

    // ---------- beam ----------
    ['beam: a blank range or tracking speed is unknown, never 0, and each axis is sized on its own', () => {
      const blank = page({ mode: 'beam' })
      const rangeOnly = page({ mode: 'beam', beamRange: '128000' })
      const both = page({ mode: 'beam', ...BEAM_WANTED })

      return blank.beamTileList.every((tile) => !known(tile.result) || tile.label === 'Size' || tile.label === 'Cost') && blank.beamTileList[0].value === 'Unknown' && blank.beamTileList[1].value === 'Unknown' && blank.beamAxisRows.every((row) => !known(row.wanted) && row.verdict.startsWith('Unknown')) && known(rangeOnly.beamAxisRows[0].reach) && !known(rangeOnly.beamAxisRows[1].reach) && rangeOnly.beamAxisRows[0].axis.multiplier === 2 && both.beamAxisRows[1].axis.multiplier === 1 && both.beamTileList[0].value === "128'000 km" ? true : short({ blank: blank.beamTileList.map((tile) => tile.value), both: both.beamTileList.map((tile) => tile.value) })
    }],
    ['beam: a range above the cap is reported as beyond it and not met', () => {
      const vm = page({ mode: 'beam', beamRange: '2000000', beamTracking: '4000' })
      const [range, tracking] = vm.beamAxisRows

      return range.axis.beyondCap === true && range.verdict.startsWith('Beyond the cap') && !known(range.reach) && vm.beamTileList[0].value === 'Unknown' && known(tracking.reach) && tracking.verdict === 'Reached with a tracking multiplier of 1' ? true : short([range.verdict, tracking.verdict])
    }],
    ['beam: the single weapon switch is read only where the tech offers it, and the restriction is always told', () => {
      const offered = page({ mode: 'beam', ...BEAM_WANTED, beamSingle: true, tech: techWith(2072) })
      const notOffered = page({ mode: 'beam', ...BEAM_WANTED, beamSingle: true })
      const off = page({ mode: 'beam', ...BEAM_WANTED, tech: techWith(2072) })

      return offered.techInput.singleWeapon.offersSingle === true && offered.beam.restriction.state === 'single weapon' && notOffered.techInput.singleWeapon.offersSingle === false && notOffered.beam.restriction.state === 'unrestricted' && off.beam.restriction.state === 'unrestricted' && notOffered.beam.restriction.label !== offered.beam.restriction.label ? true : short([offered.beam.restriction.state, notOffered.beam.restriction.state, off.beam.restriction.state])
    }],
    ['active and beam: a wanted range or tracking speed of zero or below is unknown beside the warning, for the saved pair and the saved beam controls, never met', () => {
      const lines = []

      for (const typed of ['0', '-5']) {
        const pair = page({ targetTons: '250', wantedRange: typed, pairSearchId: 501, pairFcId: 502 })
        const beam = page({ mode: 'beam', beamRange: typed, beamTracking: typed })
        const items = beam.existingBeamItems.filter((item) => item.id === 601)

        lines.push(pair.activeProblems.length === 1 && !known(pair.sizing.tiles.sizeNeeded) && pair.pairChecks[0].check.meets === null && pair.pairChecks[0].check.limiting === null && beam.shownProblems.length === 2 && !known(beam.beam.tiles.range) && items.length === 1 && items.every((item) => item.meets === null && item.limiting === null) && beam.meetsText(items[0].meets) === 'Unknown')
      }

      return lines.every(Boolean) ? true : short(lines)
    }],
    ['beam: the saved controls are held to the range and the tracking speed apart, and the limiting axis is named', () => {
      const limiting = (data) => page({ mode: 'beam', ...data }).existingBeamItems.find((item) => item.id === 601)
      const meets = limiting({ beamRange: '128000', beamTracking: '4000' })
      const range = limiting({ beamRange: '200000', beamTracking: '1000' })
      const tracking = limiting({ beamRange: '100000', beamTracking: '9000' })
      const both = limiting({ beamRange: '200000', beamTracking: '9000' })
      const blank = limiting({})
      const vm = page({ mode: 'beam', beamRange: '200000', beamTracking: '1000' })

      return meets.meets === true && meets.limiting === null && range.meets === false && range.limiting === 'range' && tracking.limiting === 'tracking' && both.limiting === 'both' && blank.meets === null && vm.limitingText(both) === 'Range and tracking speed' && vm.limitingText(meets) === 'None' && vm.limitingText(blank) === 'Unknown' && vm.meetsText(meets.meets) === 'Meets' && vm.meetsText(blank.meets) === 'Unknown' && page({ mode: 'beam', hideObsolete: true }).existingBeamItems.length === 1 ? true : short([meets, range.limiting, tracking.limiting, both.limiting])
    }],
    ['beam: the multiplier table has a row for each pair, the sized pair flagged and a capped range marked wasted', () => {
      const vm = page({ mode: 'beam', ...BEAM_WANTED })
      const sized = vm.beamMultiplierRows.filter((row) => row.proposed)
      const capped = page({ mode: 'beam', beamRange: '100000', beamTracking: '1000', tech: buildTech(m, LEVELS.map((item) => (item.id === 2051 ? { ...item, info: 500000, name: 'Distance 500000' } : item))) })

      return vm.beamMultiplierRows.length === 36 && sized.length === 1 && sized[0].rangeMultiplier === 2 && sized[0].trackingMultiplier === 1 && vm.beamMultiplierRows.every((row) => known(row.range) && known(row.size) && known(row.cost)) && capped.beamMultiplierRows.some((row) => row.capped && row.wasted) ? true : short({ rows: vm.beamMultiplierRows.length, sized: sized.map((row) => [row.rangeMultiplier, row.trackingMultiplier]) })
    }],

    // ---------- passive ----------
    ['passive: a proposed sensor of a typed size leads the curves of its kind, a blank size proposes none and a size not above 0 is reported', () => {
      const vm = page({ mode: 'passive', passiveSize: '10' })
      const blank = page({ mode: 'passive' })
      const bad = page({ mode: 'passive', passiveSize: '-2' })
      const [thermal, em] = vm.passiveProposals

      return blank.passiveProposals.length === 0 && blank.ownThermalSensors.length === 1 && thermal.kind === 'thermal' && em.kind === 'em' && close(thermal.proposal.sensitivity.value, 80) && close(em.proposal.sensitivity.value, 80) && vm.ownThermalSensors[0].key === 'thermal-proposed' && vm.ownThermalSensors[0].name.startsWith('Proposed thermal sensor of 10 HS') && vm.ownThermalSensors.length === 2 && vm.ownEmSensors[0].key === 'em-proposed' && bad.shownProblems.length === 1 && bad.ownThermalSensors.every((sensor) => sensor.key !== 'thermal-proposed') ? true : short([vm.ownThermalSensors.map((sensor) => sensor.key), bad.shownProblems])
    }],

    // ---------- what a typed figure reaches, through the rendered inputs ----------
    ['passive: every typed figure of the page has an input in the template, and a size typed in the proposed sensor field draws both proposed curves, moved by the level in use', () => {
      const typed = Object.entries(fields).filter(([, field]) => field.scope === 'race' && field.default === '' && field.key !== 'sensorsCurveTons').map(([name]) => name)
      const unbound = unboundTyped(TEMPLATE(), typed)
      const vm = page({ mode: 'passive' })

      vm.passiveSize = '10'

      const sets = vm.passiveSets
      const proposed = sets.map((set) => set.curve.series[0].key)
      const emAt = (data) => page({ mode: 'passive', passiveSize: '10', ...data }).passiveProposals.find((entry) => entry.kind === 'em').proposal.sensitivity.value
      const first = sets.map((set) => set.curve.rows[0].ranges[0].result)

      return unbound.length === 0 && typed.includes('passiveSize') && proposed.join() === 'thermal-proposed,em-proposed' && first.every((result) => known(result)) && close(emAt({}), 80) && close(emAt({ heldChoices: { [EM]: { techId: 2012, name: 'EM 12' } } }), 120) && page({ mode: 'passive' }).passiveSets.every((set) => set.curve.series.every((series) => !series.key.endsWith('-proposed'))) ? true : short({ unbound, proposed, em: [emAt({}), emAt({ heldChoices: { [EM]: { techId: 2012, name: 'EM 12' } } })] })
    }],
    ['passive: every range of a proposed sensor built on a hypothetical level keeps it, and no range of a saved sensor or of a researched level gets one', () => {
      const rangesOf = (data) => page({ mode: 'passive', passiveSize: '10', ...data }).passiveSets.flatMap((set) => set.curve.rows.flatMap((row) => row.ranges.map((range) => ({ proposed: range.key.endsWith('-proposed'), result: range.result }))))
      const held = rangesOf({ heldChoices: HELD })
      const plain = rangesOf({})
      const ranges = held.filter((range) => range.proposed)

      return ranges.length === 2 * 4 && ranges.every((range) => known(range.result) && noted(range.result, 'Hardening 25')) && held.filter((range) => !range.proposed).every((range) => !noted(range.result, 'Hardening 25')) && plain.every((range) => !noted(range.result, 'Hardening 25')) ? true : short(ranges.map((range) => range.result.assumptions))
    }],
    ['active: every reach of the proposed pair built on a hypothetical level keeps it, in the curve and in the class table, and no saved sensor gets one', () => {
      const reaches = (data) => {
        const vm = page({ ...SIZED, ...data })

        return { curve: vm.curve.rows.flatMap((row) => row.ranges.map((range, index) => ({ proposed: index < 2, result: range.result }))), classes: vm.classReachRows.flatMap((row) => [row.search, row.fireControl]) }
      }
      const held = reaches({ heldChoices: { [STRENGTH]: HELD[STRENGTH] } })
      const plain = reaches({})
      const proposed = held.curve.filter((range) => range.proposed)

      return proposed.length === 20 && proposed.every((range) => known(range.result) && noted(range.result, 'Strength 24')) && held.classes.length === 8 && held.classes.every((result) => known(result) && noted(result, 'Strength 24')) && held.curve.filter((range) => !range.proposed).every((range) => !noted(range.result, 'Strength 24')) && plain.curve.every((range) => !noted(range.result, 'Strength 24')) && plain.classes.every((result) => !noted(result, 'Strength 24')) ? true : short([proposed.length, held.classes.length, proposed.filter((range) => !noted(range.result, 'Strength 24')).length])
    }],
    ['active: the shared sizing panel takes the data of each caller, the page, the saved pair\'s alternative and the Missile Designer embed, and a sizing with no request', () => {
      const views = (scenarios) => instantiate(panelOptions, { $store: store, data: { scenarios } }).views
      const vm = page({ ...SIZED, pairSearchId: 501, pairFcId: 502 })
      const own = views(vm.sizingScenarios)
      const alternative = views(vm.pairChecks[0].alternative)
      const embedVm = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { tech, techResolution: m.ts.resolveChoices(tech), optimiserBaseline: { figures: { maxRange: { value: 15000000 } } }, targetSignature: '25', launcherJammer: '2', formulaVersion: null } })
      const embed = views(embedVm.embedScenarios)
      const blank = views(page().sizingScenarios)
      const bare = views([{ key: 'bare', label: 'Bare', sizing: { problems: [], rows: [] } }])

      return own.length === 1 && own[0].rows.length > 20 && own[0].empty === '' && vm.pairChecks[0].alternative[0].sizing.request !== undefined && alternative.length === 1 && alternative[0].rows.length === 1 && alternative[0].empty === '' && embed.length === 1 && embed[0].rows.length > 20 && embed[0].empty === '' && blank[0].empty === 'Type the target size and the wanted range to size a pair.' && bare[0].empty === '' && bare[0].rows.length === 0 ? true : short([own[0].empty, alternative.map((view) => [view.rows.length, view.empty]), embed[0].empty, blank[0].empty, bare[0].empty])
    }],
    ['active: the proposed pair is a search sensor and a fire control, so the fire control is read against the missile fire control signature', () => {
      const kinds = page({ ...SIZED }).proposedSensors.map((sensor) => sensor.kind).join()
      const saved = page({ ...SIZED }).existingItems.map((item) => item.kind)

      return kinds === 'search,fireControl' && saved.includes('Search sensor') && saved.includes('Missile fire control') && m.sp.sensorOf(ACTIVE[1]).kind === 'fireControl' && m.sp.sensorOf(ACTIVE[0]).kind === 'search' ? true : short([kinds, saved])
    }],
    ['active: against a missile target the page sizes the pair, checks a saved pair and lists the saved designs with no jammer on either member, as the planner does', () => {
      const mfc = activeRow({ id: 504, name: 'MFC 12M', type: 25, kind: 'fireControl', rangeKm: 12000000, resolution: 1, eccm: 1 })
      const data = { targetKind: 'missile', targetMsp: '20', wantedRange: '10000000', resolutionPick: '1', jammer: '5', activeRows: [SEARCH, mfc], pairSearchId: 501, pairFcId: 504 }
      const vm = page(data)
      const target = m.sp.targetOf({ kind: 'missile', msp: '20' })
      const standalone = (jammer) => m.sp.activeSizing({ target, wantedRangeKm: '10000000', resolution: '1', jammer, tech: vm.techInput })
      const sized = vm.sizingScenarios[0].sizing.selected
      const jammed = standalone('5').selected
      const unjammed = standalone('0').selected
      const pair = vm.pairChecks[0].check
      const bare = page({ ...data, jammer: '' })
      const listed = Object.fromEntries(vm.existingItems.map((item) => [item.id, item.reaches[0].reach.value]))
      const listedBare = Object.fromEntries(bare.existingItems.map((item) => [item.id, item.reaches[0].reach.value]))

      return sized.fireControl.sizeHS === jammed.fireControl.sizeHS && sized.fireControl.sizeHS === unjammed.fireControl.sizeHS && sized.search.sizeHS === jammed.search.sizeHS && sized.search.sizeHS === unjammed.search.sizeHS && pair.fireControl.reach.value === 12000000 && pair.fireControl.reach.value === listed[504] && pair.fireControl.meets === true && pair.limiting !== 'fireControl' && pair.search.reach.value === listed[501] && pair.search.reach.value === bare.pairChecks[0].check.search.reach.value && listed[501] === listedBare[501] && listed[504] === listedBare[504] ? true : short({ page: [sized.fireControl.sizeHS, sized.search.sizeHS], jammed: [jammed.fireControl.sizeHS, jammed.search.sizeHS], unjammed: [unjammed.fireControl.sizeHS, unjammed.search.sizeHS], pair: [pair.fireControl.reach.value, pair.limiting], listed, listedBare })
    }],
    ['active: against a missile target the jammer is marked as not applied, what is typed in it is kept and is no problem, and a ship target is scaled by it', () => {
      const typed = { targetKind: 'missile', targetMsp: '20', wantedRange: '10000000', resolutionPick: '1' }
      const missile = page({ ...typed, jammer: 'abc' })
      const kept = page({ ...typed, jammer: '5' })
      const ship = { targetKind: 'tons', targetTons: '250', wantedRange: '10000000', resolutionPick: '1' }
      const scaled = page({ ...ship, jammer: '5' })
      const unscaled = page({ ...ship, jammer: '' })
      const idle = rendered({ ...typed, jammer: '5' })
      const live = rendered({ ...ship, jammer: '5' })
      const typedOver = rendered({ ...typed, jammer: '5' })

      typedOver.input.data.model.callback('7')

      const afterTyping = rendered({ ...typed, jammer: typedOver.vm.jammer })
      const voice = idle.chip ? `${textOf(idle.chip)} ${idle.input.data.attrs['aria-label'] || ''} ${idle.input.data.attrs.title || ''}` : ''

      return missile.jammerIdle === true && kept.jammerIdle === true && kept.jammer === '5' && missile.activeProblems.length === 0 && page({ ...ship, jammer: 'abc' }).activeProblems.length > 0 && scaled.jammerIdle === false && scaled.sizing.selected.search.sizeHS > unscaled.sizing.selected.search.sizeHS && scaled.sizing.request.searchJammer === 5 && kept.sizing.request.searchJammer === 0 && kept.sizing.request.fireControlJammer === 0 && idle.chip !== undefined && live.chip === undefined && idle.input !== undefined && live.input !== undefined && editable(idle.input) && editable(live.input) && idle.input.data.model.value === '5' && live.input.data.model.value === '5' && typedOver.vm.jammer === '7' && afterTyping.input.data.model.value === '7' && afterTyping.chip !== undefined && !PRONOUNS.test(voice) ? true : short({ idle: [missile.jammerIdle, kept.jammerIdle, kept.jammer], problems: missile.activeProblems, ship: [scaled.jammerIdle, scaled.sizing.selected.search.sizeHS, unscaled.sizing.selected.search.sizeHS], requests: [scaled.sizing.request.searchJammer, kept.sizing.request.searchJammer, kept.sizing.request.fireControlJammer], chips: [idle.chip !== undefined, live.chip !== undefined], inputs: [idle.input !== undefined, live.input !== undefined], typed: [typedOver.vm.jammer, afterTyping.chip !== undefined] })
    }],
    ['active: a blank target or wanted range gives one line naming what to type in place of a table of Unknown rows', () => {
      const empty = (data) => m.sv.sizingEmpty(page(data).sizing.request)
      const component = templateOf(fs.readFileSync(componentPath('ActiveSizingPanel'), 'utf8'))
      const lines = [empty({}), empty({ targetTons: '250' }), empty({ wantedRange: '20000000' }), empty(SIZED)]

      return lines.join('|') === 'Type the target size and the wanted range to size a pair.|Type the wanted range to size a pair.|Type the target size to size a pair.|' && !PRONOUNS.test(lines.join(' ')) && /<div v-if="scenario.empty"[^>]*data-sizing="empty"/.test(component) && /<v-simple-table v-else\b/.test(component) ? true : short(lines)
    }],
    ['beam: a stored range above the cap is kept as stored, marked above the cap and held to the wanted range as stored', () => {
      const modded = { ...BEAM, id: 603, name: 'Modded', rangeKm: 12000000 }
      const vm = page({ mode: 'beam', beamRange: '5000000', beamTracking: '1000', beamRows: [BEAM, modded] })
      const items = Object.fromEntries(vm.existingBeamItems.map((item) => [item.id, item]))
      const short5 = page({ mode: 'beam', beamRange: '20000000', beamTracking: '1000', beamRows: [modded] }).existingBeamItems[0]
      const template = TEMPLATE()

      return items[603].aboveCap === true && items[601].aboveCap === false && items[603].rangeResult.value === 12000000 && noted(items[603].rangeResult, 'is above the 1400000 km') && !noted(items[601].rangeResult, 'is above the') && items[603].meets === true && items[603].limiting === null && items[601].meets === false && items[601].limiting === 'range' && short5.meets === false && short5.limiting === 'range' && template.includes('v-if="item.aboveCap"') && template.includes('marked Above cap and kept as stored') ? true : short([items[603].meets, items[601].meets, short5.meets, items[603].rangeResult.assumptions])
    }],
    // ---------- template ----------
    ['template: every chart has a toggle to a table of the same points', () => {
      const problems = chartProblems(TEMPLATE())

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['template: a chart without its table is found', () => (chartProblems(TEMPLATE((text) => text.replace('data-sensors="curve-table"', ''))).length === 1 && chartProblems(TEMPLATE((text) => text.replace('<v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>', ''))).length >= 1 ? true : 'the missing table was not found')],
    ['template: every top-level panel of the three modes carries a data-summary and a head', () => {
      const template = TEMPLATE()
      const problems = panelProblems(template)
      const needed = ['active-tiles', 'beam-tiles', 'data-planner-link="handoff"', 'data-sensors="curve-table"', 'data-sensors="tradeoff-table"', 'data-sensors="existing"', 'data-sensors="class-reach"', 'data-sensors="beam-axes"', 'data-sensors="beam-multipliers"', 'data-sensors="existing-beam"'].filter((name) => !template.includes(name))

      return problems.length === 0 && needed.length === 0 && (template.match(/<v-card\b[^>]*class="panel"/g) || []).length === 14 ? true : short([...problems, ...needed])
    }],
    ['template: a panel without its data-summary is found in each mode', () => {
      return panelProblems(TEMPLATE((source) => source.replace(/ data-summary="The smallest search sensor[^"]*"/, ''))).length === 1 && panelProblems(TEMPLATE((source) => source.replace(/ data-summary="The range and the tracking speed wanted[^"]*"/, ''))).length === 1 ? true : 'the missing summaries were not found'
    }],
    ['template: every figure of the new panels and the components carries its provenance mark', () => {
      const parts = { page: TEMPLATE(), sizing: templateOf(fs.readFileSync(componentPath('ActiveSizingPanel'), 'utf8')) }
      const found = Object.fromEntries(Object.entries(parts).map(([name, template]) => [name, unmarked(template).length]))

      return found.page === 0 && found.sizing === 0 && cellCount(parts.page) >= 45 && cellCount(parts.sizing) >= 10 ? true : short({ found, cells: [cellCount(parts.page), cellCount(parts.sizing)] })
    }],
    ['template: a figure without its mark is found in the sizing table and in a mode panel', () => {
      const sizing = templateOf(fs.readFileSync(componentPath('ActiveSizingPanel'), 'utf8'))
      const dropped = (template, mark) => unmarked(template.replace(mark, '')).length

      return dropped(sizing, '<provenance-mark :result="row.search.reach" />') === 1 && dropped(TEMPLATE(), '<provenance-mark :result="row.cost" />') >= 1 && dropped(TEMPLATE(), '<provenance-mark :result="row.tracking" />') === 1 ? true : 'a missing mark was not found'
    }],
    ['template: the words of the three modes, the components and the embed keep to the impersonal voice', () => {
      const missile = fs.readFileSync(missilePagePath, 'utf8')
      const embed = templateOf(missile).split('data-designer="sensor-sizing"')[1].split('</v-card>')[0]
      const texts = [TEMPLATE(), templateOf(fs.readFileSync(componentPath('ActiveSizingPanel'), 'utf8')), templateOf(fs.readFileSync(componentPath('SensorTechLevels'), 'utf8')), embed]
      const found = texts.flatMap((template) => wordsOf(template).match(new RegExp(PRONOUNS.source, 'g')) || [])

      return found.length === 0 ? true : `first or second person: ${found.join(', ')}`
    }],
    ['template: the mode switch lists the three modes and each mode has its own panels', () => {
      const template = TEMPLATE()

      return page().modes.map((mode) => mode.value).join() === 'active,passive,beam' && /v-for="entry in modes"[^>]*:data-sensors-mode="entry.value"/.test(template) && template.includes('<template v-if="mode === \'passive\'">') && template.includes('<template v-else-if="mode === \'active\'">') && template.includes('<sensor-tech-levels :lines="modeTechLines"') && template.includes('<active-sizing-panel :scenarios="sizingScenarios" />') ? true : 'a mode is missing from the template'
    }],
    ['view: the new typed figures, picks and the tech choices are kept for the race, the layout choices for the app', () => {
      const race = ['mode', 'targetKind', 'targetTons', 'targetClassId', 'targetMsp', 'wantedRange', 'resolutionPick', 'jammer', 'pairSearchId', 'pairFcId', 'curveTonsText', 'beamRange', 'beamTracking', 'beamSingle', 'passiveSize', 'existingTable', 'beamTable', 'techChoice']
      const app = ['curveView', 'hideObsolete']
      const keys = Object.values(fields).map((field) => field.key)

      return race.every((name) => fields[name] && fields[name].scope === 'race') && app.every((name) => fields[name] && fields[name].scope !== 'race') && new Set(keys).size === keys.length && fields.techChoice.key === 'sensorsTech' && fields.resolutionPick.valid('best') && fields.resolutionPick.valid('20') && !fields.resolutionPick.valid('21') && !fields.resolutionPick.valid(20) ? true : short(Object.entries(fields).map(([name, field]) => [name, field.scope]))
    }],

    // ---------- embed ----------
    ['embed: the sizing panel of the Missile Designer starts from the scenario signature, the baseline range and the launcher jammer', () => {
      const vm = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { tech, techResolution: m.ts.resolveChoices(tech), optimiserBaseline: { figures: { maxRange: { value: 15000000 } } }, targetSignature: '25', launcherJammer: '2', formulaVersion: null } })
      const request = vm.embedSizing.request

      return request.wantedRangeKm === 15000000 && request.jammer === 2 && request.signature.value === 25 && request.signature.status === 'assumed' && request.resolution === 'best' && vm.embedScenarios.length === 1 && known(vm.embedSizing.tiles.sizeNeeded) ? true : short([request.wantedRangeKm, request.jammer, request.signature.value, request.resolution])
    }],
    ['embed: a blank signature, baseline or range leaves the sizing unknown, never 0', () => {
      const data = { tech, techResolution: m.ts.resolveChoices(tech), formulaVersion: null }
      const blank = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { ...data, optimiserBaseline: { figures: { maxRange: { value: 15000000 } } }, targetSignature: '' } })
      const zero = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { ...data, optimiserBaseline: { figures: { maxRange: { value: 15000000 } } }, targetSignature: '0' } })
      const noBaseline = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { ...data, optimiserBaseline: null, targetSignature: '25' } })

      return [blank, zero, noBaseline].every((vm) => !known(vm.embedSizing.tiles.sizeNeeded) && vm.embedSizing.rows.every((row) => !row.feasible)) && !known(blank.embedTarget.signature) && !known(zero.embedTarget.signature) && noBaseline.embedBaselineRange === null ? true : short([blank.embedSizing.tiles.sizeNeeded.status, zero.embedSizing.tiles.sizeNeeded.status, noBaseline.embedSizing.tiles.sizeNeeded.status])
    }],
    ['embed: a range, jammer or resolution typed in the panel stays in the panel and the scenario above is left as it is', () => {
      const data = { tech, techResolution: m.ts.resolveChoices(tech), optimiserBaseline: { figures: { maxRange: { value: 15000000 } } }, targetSignature: '25', launcherJammer: '2', formulaVersion: null }
      const vm = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { ...data, embedRange: '9000000', embedJammer: '1', embedResolution: '20' } })
      const request = vm.embedSizing.request

      return request.wantedRangeKm === 9000000 && request.jammer === 1 && request.resolution === 20 && vm.targetSignature === '25' && vm.launcherJammer === '2' && vm.embedBaselineRange === 15000000 && vm.embedSizing.selected.resolution === 20 ? true : short([request.wantedRangeKm, request.jammer, request.signature.value, request.resolution])
    }],
    ['embed: the panel sizes with the tech levels of the page, a hypothetical one marking the figures', () => {
      const choice = m.ts.resolveChoices(tech, { [STRENGTH]: { techId: 2003, source: 'scenario' } })
      const base = { tech, optimiserBaseline: { figures: { maxRange: { value: 15000000 } } }, targetSignature: '25', formulaVersion: null }
      const held = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { ...base, techResolution: choice } })
      const plain = instantiate(missileOptions, { $store: MISSILE_STORE, database: {}, GameID: 138, RaceID: RACE, data: { ...base, techResolution: m.ts.resolveChoices(tech) } })

      return held.embedTech.strength.hypothetical === true && held.embedTech.strength.info === 24 && noted(held.embedSizing.tiles.sizeNeeded, 'Strength 24') && plain.embedTech.strength.info === 16 && !noted(plain.embedSizing.tiles.sizeNeeded, 'Strength 24') && held.embedTechText.includes('Strength 24') && plain.embedTechText.includes('Strength 16') ? true : short([held.embedTechText, plain.embedTechText])
    }],
    ['embed: the panel carries a data-summary of its own and links to the Sensor Planner', () => {
      const template = templateOf(fs.readFileSync(missilePagePath, 'utf8'))
      const card = /<v-card class="panel" data-summary="([^"]{20,})"[^>]*data-designer="sensor-sizing"/.exec(template)

      return card !== null && card[1].length > 20 && template.includes('<active-sizing-panel :scenarios="embedScenarios" />') && template.includes('linkTo.sensors({ mode: \'active\' })') && (template.match(/<v-card\b[^>]*class="panel"/g) || []).length === (template.match(/class="panel-head"/g) || []).length ? true : 'the embed lacks its summary or its link'
    }],

    // ---------- links ----------
    ['links: a sensor or fire control row of Designed Tech opens the Sensor Planner on its mode and design, and another component has no link', () => {
      const vm = instantiate(designedOptions, { $store: store, database: {}, GameID: 138, RaceID: RACE, data: {} })
      const link = (type, id) => vm.sensorLink({ ComponentTypeID: type, SDComponentID: id })
      const to = (type) => short(link(type, 9))

      return to(24) === '{"path":"/sensors","query":{"mode":"active","sensor":"9"}}' && to(25) === to(24) && to(8) === '{"path":"/sensors","query":{"mode":"passive","sensor":"9"}}' && to(41) === to(8) && to(19) === '{"path":"/sensors","query":{"mode":"beam","sensor":"9"}}' && link(1, 9) === null && vm.sensorLink({ SDComponentID: 9 }) === null ? true : short([to(24), to(8), to(19), link(1, 9)])
    }],
    ['links: Designed Tech takes the design a link names, opens its category with it picked and drops the rest', () => {
      const items = [{ SDComponentID: 9, Name: 'Search 20', CategoryID: 5, Obsolete: true, ComponentTypeID: 24 }, { SDComponentID: 10, Name: 'Other', CategoryID: 6, Obsolete: false, ComponentTypeID: 1 }]
      const vm = instantiate(designedOptions, { $store: store, database: {}, GameID: 138, RaceID: RACE, data: { components: items, missiles: [], species: [], ready: true, compareByCategory: {}, categories: [{ CategoryID: 5, Name: 'Sensors' }, { CategoryID: 6, Name: 'Other' }], hideObsolete: true } })

      vm.applyLink({ design: '9' })

      const query = vm.linkQuery
      const row = vm.focusRow

      vm.applyLink({})

      return row !== null && row.Name === 'Search 20' && short(query) === '{"design":"9"}' && vm.linkLabel === '' && vm.focusRow === null && short(vm.linkQuery) === '{}' && typeof designedOptions.watch.focusRow === 'function' ? true : short({ query, row })
    }],
    ['links: the designs of the Sensor Planner open Designed Tech', () => {
      const template = TEMPLATE()
      const links = template.match(/linkTo\.designedTech\(\{ design: item\.id \}\)/g) || []
      const vm = page()

      return links.length === 2 && short(vm.linkTo.designedTech({ design: 501 })) === '{"path":"/designed-tech","query":{"design":"501"}}' && short(vm.linkTo.sensors({ mode: 'beam', sensor: 601 })) === '{"path":"/sensors","query":{"mode":"beam","sensor":"601"}}' ? true : short(links)
    }],

    // ---------- load ----------
    ['load: the reads of the active sensors and of the beam fire controls are tracked under their own names', async () => {
      const names = asyncNamesOf(options)
      const outcomes = await Promise.all(['activeRows', 'beamRows', 'tech'].map(async (name) => {
        const vm = instantiate(options, { $store: store, database: { query: () => Promise.reject(new Error('the read failed')) }, GameID: 138, RaceID: RACE })

        await vm.runAsync(name).catch(() => null)

        return { name, failed: typeof vm.loadErrors[name] === 'string' && vm.failedInputs.join() === name && !vm.ready, text: vm.failedInputsText }
      }))

      return names.includes('activeRows') && names.includes('beamRows') && names.includes('tech') && outcomes.every((outcome) => outcome.failed) ? true : short(outcomes)
    }],

    // ---------- save ----------
    ['save: the page reads the active sensors and the beam fire controls of the stock save, and sizes a pair from its tech', async () => {
      if (!stock) {
        return skipped('the stock save is not there')
      }

      const vm = instantiate(options, { $store: store, database: stock.database, GameID: stock.GameID, RaceID: stock.RaceID, data: { classRead: [], ownedRows: [] } })

      await vm.runAsync('activeRows')
      await vm.runAsync('beamRows')
      await vm.runAsync('tech')

      vm.targetTons = '250'
      vm.wantedRange = '20000000'

      const kinds = new Set(vm.activeRows.map((row) => row.kind))

      return vm.activeRows.length > 0 && kinds.has('search') && vm.beamRows.length > 0 && vm.beamRows.every((row) => row.type === 19) && known(vm.sizing.tiles.sizeNeeded) && vm.techInput.strength.info > 0 && vm.existingItems.length === vm.activeRows.length ? true : `${vm.activeRows.length} active, ${vm.beamRows.length} beam, size ${short(vm.sizing.tiles.sizeNeeded.value)}`
    }],
  ]
}

// ---------- the mutants ----------

const MUTATIONS = [
  { name: 'the proposed fire control is read as a search sensor', page: 'sensors', find: "'Proposed missile fire control', 'fireControl')", replace: "'Proposed missile fire control', 'search')", fails: ['active: the proposed pair is a search sensor and a fire control'] },
  { name: 'the sizing reads a scenario of a missile without its jammer policy', page: 'sensors', find: 'sizing: activeSizing({ target: entry, wantedRangeKm', replace: 'sizing: activeSizing({ target: { key: entry.key, signature: entry.signature, fireControlSignature: entry.fireControlSignature }, wantedRangeKm', fails: ['active: against a missile target the page sizes'] },
  { name: 'the saved pair reads a scenario of a missile without its jammer policy', page: 'sensors', find: 'fireControl: this.pairFireControl, target: entry,', replace: 'fireControl: this.pairFireControl, target: { key: entry.key, signature: entry.signature, fireControlSignature: entry.fireControlSignature },', fails: ['active: against a missile target the page sizes'] },
  { name: 'the jammer is not marked as not applied against a missile', page: 'sensors', find: "jammerIdle() {\n      return this.targetKind === 'missile'", replace: 'jammerIdle() {\n      return false', fails: ['active: against a missile target the jammer is marked'] },
  { name: 'the jammer is marked as not applied against a ship too', page: 'sensors', find: "jammerIdle() {\n      return this.targetKind === 'missile'", replace: 'jammerIdle() {\n      return true', fails: ['active: against a missile target the jammer is marked'] },
  { name: 'the jammer field is made disabled', page: 'template', find: 'data-sensors="jammer" />', replace: 'data-sensors="jammer" disabled />', fails: ['active: against a missile target the jammer is marked'] },
  { name: 'the jammer field is made read-only', page: 'template', find: 'data-sensors="jammer" />', replace: 'data-sensors="jammer" readonly />', fails: ['active: against a missile target the jammer is marked'] },
  { name: 'the jammer field is disabled against a missile', page: 'template', find: 'data-sensors="jammer" />', replace: ':disabled="jammerIdle" data-sensors="jammer" />', fails: ['active: against a missile target the jammer is marked'] },
  { name: 'a typed jammer that is no number is a problem against a missile', page: 'sensors', find: "this.jammerIdle ? '' : this.figureProblem(this.jammer, 'Jammer', true)", replace: "this.figureProblem(this.jammer, 'Jammer', true)", fails: ['active: against a missile target the jammer is marked'] },
  { name: 'the saved designs are listed under the jammer against a missile', page: 'sensors', find: 'existingDesigns({ sensors: this.visibleActive, target: this.target, jammer: this.jammer })', replace: 'existingDesigns({ sensors: this.visibleActive, target: { ...this.target, results: this.target.results.map((entry) => ({ ...entry, searchJammer: true })) }, jammer: this.jammer })', fails: ['active: against a missile target the page sizes'] },
  { name: 'the saved pair\'s alternative drops its request', page: 'sensors', find: 'request: check.alternative.sizing.request, ', replace: '', fails: ['active: the shared sizing panel'] },
  { name: 'the sizing panel reads the request of a sizing that has none', page: 'panel', find: 'empty: sizingEmpty(sizing.request)', replace: "empty: sizing.request.signature ? '' : ''", fails: ['active: the shared sizing panel'] },
  { name: 'the proposed pair loses the provenance of its design', page: 'sensors', find: 'source: design ? member.design : null', replace: 'source: null', fails: ['active: every reach of the proposed pair'] },
  { name: 'the proposed passive sensor loses the provenance of its sensitivity', page: 'sensors', find: 'sensitivity, source: entry.proposal.sensitivity }]', replace: 'sensitivity }]', fails: ['passive: every range of a proposed sensor'] },
  { name: 'a beam control above the cap is not marked', page: 'sensors', find: 'aboveCap: entry.range.aboveCap,', replace: 'aboveCap: false,', fails: ['beam: a stored range above the cap'] },
  { name: 'a second persisted view takes the tech choice', page: 'sensors', find: "    persistedView({\n      techChoice: techChoiceField('sensorsTech'),", replace: "    persistedView({ techChoice: techChoiceField('sensorsTech') }),\n    persistedView({", fails: ['view: each page restores every field'] },
  { name: 'the tech choice is read and declared nowhere', page: 'sensors', find: "      techChoice: techChoiceField('sensorsTech'),\n", replace: '', fails: ['view: each page restores every field'] },
  { name: 'the tech choice is kept under the key of another page', page: 'sensors', find: "techChoiceField('sensorsTech')", replace: "techChoiceField('propulsionTech')", fails: ['view: each page restores every field', 'view: the new typed figures'] },
  { name: 'the mode is kept for the app', page: 'sensors', find: "mode: { key: 'sensorsMode', default: 'active', scope: 'race', valid", replace: "mode: { key: 'sensorsMode', default: 'active', valid", fails: ['mode: the mode is kept', 'view: the new typed figures'] },
  { name: 'a mode that is not one is accepted', page: 'sensors', find: 'valid: oneOf(MODE_VALUES)', replace: 'valid: () => true', fails: ['mode: the mode is kept'] },
  { name: 'a link names no design', page: 'sensors', find: 'this.focusSensorId = queryId(query.sensor)', replace: 'this.focusSensorId = null', fails: ['mode: a link names the mode'] },
  { name: 'a link takes any mode', page: 'sensors', find: 'if (MODE_VALUES.includes(mode)) {\n        this.mode = mode\n      }\n\n      this.focusSensorId', replace: 'this.mode = mode\n\n      this.focusSensorId', fails: ['mode: a link with no mode keeps'] },
  { name: 'the switch keeps a design of another mode', page: 'sensors', find: 'if (!this.focusRow) {', replace: 'if (false) {', fails: ['mode: the switch keeps'] },
  { name: 'a picked pair loses to the linked design', page: 'sensors', find: 'this.searchSensors.find((row) => row.id === this.pairSearchId) || ', replace: '', fails: ['mode: a linked design is the saved pair'] },
  { name: 'a link that names a design keeps the picked pair', page: 'sensors', find: 'this.pairSearchId = null', replace: 'this.pairSearchId = this.pairSearchId', fails: ['mode: a linked design is the saved pair'] },
  { name: 'the menu lists every line in every mode', page: 'sensors', find: 'SENSOR_TECH_LINES.filter((entry) => entry.modes.includes(this.mode)).map(', replace: 'SENSOR_TECH_LINES.map(', fails: ['tech: the menu lists the lines'] },
  { name: 'the active mode designs with the pick, not the levels chosen', page: 'sensors', find: 'jammer: this.jammer, tech: this.techInput }) }))', replace: 'jammer: this.jammer, tech: sensorTechOf(this.tech) }) }))', fails: ['tech: the three modes read one tech contract'] },
  { name: 'the beam mode designs with the pick, not the levels chosen', page: 'sensors', find: 'tech: this.techInput, singleWeapon:', replace: 'tech: sensorTechOf(this.tech), singleWeapon:', fails: ['tech: the three modes read one tech contract'] },
  { name: 'the passive proposal designs with the pick, not the levels chosen', page: 'sensors', find: 'passiveProposal({ sizeHS: this.passiveSize, kind, tech: this.techInput })', replace: 'passiveProposal({ sizeHS: this.passiveSize, kind, tech: sensorTechOf(this.tech) })', fails: ['tech: the three modes read one tech contract'] },
  { name: 'a hypothetical level is announced in a mode that does not read it', page: 'sensors', find: 'SENSOR_MODE_LINES[this.mode].map(', replace: 'SENSOR_MODE_LINES.active.map(', fails: ['tech: a level set in one mode'] },
  { name: 'the changed lines of every mode are counted', page: 'sensors', find: 'return this.modeTechTypes.filter((type)', replace: 'return SENSOR_TECH_LINES.map((entry) => entry.typeId).filter((type)', fails: ['tech: the menu lists the lines'] },
  { name: 'a blank field is reported as a problem', page: 'sensors', find: "String(typed === null || typed === undefined ? '' : typed).trim() === '' || ", replace: '', fails: ['active: what is typed and not a number'] },
  { name: 'a jammer of 0 is reported', page: 'sensors', find: 'zeroAllowed ? number >= 0 : number > 0', replace: 'number > 0', fails: ['active: what is typed and not a number'] },
  { name: 'a class with a cloak is sized in one scenario', page: 'sensors', find: 'this.target.results.map((entry) => ({ key: entry.key, label: entry.label, sizing: activeSizing(', replace: 'this.target.results.slice(0, 1).map((entry) => ({ key: entry.key, label: entry.label, sizing: activeSizing(', fails: ['active: a class with a working cloak'] },
  { name: 'the chosen resolution is ignored', page: 'sensors', find: 'resolution: this.resolutionPick, jammer: this.jammer', replace: "resolution: 'best', jammer: this.jammer", fails: ['active: the sizing is the planner'] },
  { name: 'the saved pair swaps its members', page: 'sensors', find: 'savedPairCheck({ search: this.pairSearch, fireControl: this.pairFireControl,', replace: 'savedPairCheck({ search: this.pairFireControl, fireControl: this.pairSearch,', fails: ['active: the saved pair'] },
  { name: 'the proposed pair is left off the curve', page: 'sensors', find: '...this.proposedSensors.filter((sensor) => sensor.rangeKm !== null), ', replace: '', fails: ['active: the range curve starts', 'active: the chart draws the first eight'] },
  { name: 'the curve chart plots the range in km on the million-km axis', page: 'sensors', find: 'point.y / MILLION })), borderColor: this.seriesColor(index)', replace: 'point.y })), borderColor: this.seriesColor(index)', fails: ['active: the range curve starts'] },
  { name: 'the curve chart draws every sensor', page: 'sensors', find: 'this.curve.series.slice(0, MAX_SENSOR_SERIES)', replace: 'this.curve.series', fails: ['active: the chart draws the first eight'] },
  { name: 'the curve ignores the typed sizes', page: 'sensors', find: 'this.curveTonsRead.values.length && !this.curveTonsRead.error ? this.curveTonsRead.values : DEFAULT_CURVE_TONS', replace: 'DEFAULT_CURVE_TONS', fails: ['active: the curve takes the sizes typed'] },
  { name: 'the hardening rows are priced for the first scenario of no tech', page: 'sensors', find: 'hardeningEccmTradeoff({ sizing: this.sizing, tech: this.techInput })', replace: 'hardeningEccmTradeoff({ sizing: this.sizing, tech: sensorTechOf(this.tech) })', fails: ['active: the hardening and ECCM rows'] },
  { name: 'obsolete designs stay listed when hidden', page: 'sensors', find: 'this.hideObsolete ? this.activeRows.filter((row) => !row.obsolete) : this.activeRows', replace: 'this.activeRows', fails: ['active: the existing designs'] },
  { name: 'the classes are measured against the first scenario only', page: 'sensors', find: 'classTarget.results.map((entry, index) =>', replace: 'classTarget.results.slice(0, 1).map((entry, index) =>', fails: ['active: the classes against the proposed pair'] },
  { name: 'the beam switch reads a single weapon the tech does not offer', page: 'sensors', find: 'singleWeapon: this.beamSingle && this.techInput.singleWeapon.offersSingle', replace: 'singleWeapon: this.beamSingle', fails: ['beam: the single weapon switch'] },
  { name: 'the saved beam controls swap the range and the tracking speed', page: 'sensors', find: 'rangeKm: this.beamRange, trackingKmS: this.beamTracking }).map', replace: 'rangeKm: this.beamTracking, trackingKmS: this.beamRange }).map', fails: ['beam: the saved controls'] },
  { name: 'the limiting axis is not told', page: 'sensors', find: "item.limiting === 'both' ? 'Range and tracking speed'", replace: "item.limiting === 'both' ? 'Range'", fails: ['beam: the saved controls'] },
  { name: 'the proposed passive sensor follows the researched ones', page: 'sensors', find: "[...this.proposalSensors('thermal'), ...this.sensorsOf(SENSOR_COMPONENT_TYPES.thermal, 'thermal')]", replace: "[...this.sensorsOf(SENSOR_COMPONENT_TYPES.thermal, 'thermal'), ...this.proposalSensors('thermal')]", fails: ['passive: a proposed sensor'] },
  { name: 'a blank size is proposed', page: 'sensors', find: "if (String(this.passiveSize).trim() === '') {", replace: 'if (false) {', fails: ['passive: a proposed sensor'] },
  { name: 'the active read is tracked under another name', page: 'sensors', find: "tracked('activeRows'", replace: "tracked('activeSensors'", fails: ['load: the reads of the active sensors'] },
  { name: 'the beam read is tracked under another name', page: 'sensors', find: "tracked('beamRows'", replace: "tracked('beamControls'", fails: ['load: the reads of the active sensors'] },
  { name: 'the embed takes its range from the baseline only', page: 'missile', find: "String(this.embedRange).trim() === '' ? this.embedBaselineRange : this.embedRange", replace: 'this.embedBaselineRange', fails: ['embed: a range, jammer or resolution typed'] },
  { name: 'the embed takes its jammer from the hit chance', page: 'missile', find: "String(this.embedJammer).trim() === '' ? this.launcherJammer : this.embedJammer", replace: "String(this.embedJammer).trim() === '' ? this.hitJammer : this.embedJammer", fails: ['embed: the sizing panel of the Missile Designer starts'] },
  { name: 'the embed designs with the pick, not the levels chosen', page: 'missile', find: 'sensorTechOf(this.tech, this.techResolution)', replace: 'sensorTechOf(this.tech)', fails: ['embed: the panel sizes with the tech levels'] },
  { name: 'the embed takes a signature of 0', page: 'missile', find: 'typed !== null && typed > 0 ?', replace: 'typed !== null ?', fails: ['embed: a blank signature, baseline or range'] },
  { name: 'the embed writes its range back to the launcher card', page: 'missile', find: 'return activeSizing({ target: this.embedTarget, wantedRangeKm: wanted,', replace: 'this.launcherJammer = jammer\n\n      return activeSizing({ target: this.embedTarget, wantedRangeKm: wanted,', fails: ['embed: a range, jammer or resolution typed'] },
  { name: 'a mountable component is not linked to the Sensor Planner', page: 'designed', find: 'return mode ? linkTo.sensors({ mode, sensor: item.SDComponentID }) : null', replace: 'return null', fails: ['links: a sensor or fire control row'] },
  { name: 'a component of a beam fire control opens the active mode', page: 'designed', find: 'return mode ? linkTo.sensors({ mode, sensor: item.SDComponentID }) : null', replace: "return mode ? linkTo.sensors({ mode: 'active', sensor: item.SDComponentID }) : null", fails: ['links: a sensor or fire control row'] },
  { name: 'Designed Tech ignores the design of a link', page: 'designed', find: 'this.focusDesignId = queryId(query.design)', replace: 'this.focusDesignId = null', fails: ['links: Designed Tech takes the design'] },
]

const MUTATION_PAGES = { sensors: 'sensors', missile: 'missile', designed: 'designed', panel: 'panel', template: 'template' }

const runMutations = async (stock) => {
  for (const { name, page, find, replace, fails } of MUTATIONS) {
    let outcome

    try {
      const statements = await pageStatements({ [MUTATION_PAGES[page]]: replacing(find, replace) }, stock)
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

    check(`page mutation caught: ${name}`, outcome, `${fails.length} statement${fails.length === 1 ? '' : 's'} named`)
  }
}

// The template faults: each must be found by the checks of the templates.
const templateFaults = () => {
  const template = TEMPLATE()
  const withoutMark = (mark) => unmarked(template.replace(mark, '')).length

  check('template mutation caught: a mark left off the multiplier table', withoutMark('<provenance-mark :result="row.crew" />') === 1 ? true : 'the missing mark was not found')
  check('template mutation caught: a mark left off the requirement table', withoutMark('<provenance-mark :result="row.multiplier" />') === 1 ? true : 'the missing mark was not found')
  check('template mutation caught: a mark left off the existing designs', withoutMark('<provenance-mark :result="item.range" />') === 1 ? true : 'the missing mark was not found')
  check('template mutation caught: the voice slips into the first person', PRONOUNS.test(wordsOf(template.replace('A sensor sees a target to its range', 'I see a target to its range'))) ? true : 'the pronoun was not found')
  check('template mutation caught: the tracking table of the curve is dropped', chartProblems(template.replace('data-sensors="curve-table"', '')).length === 1 ? true : 'the missing table was not found')
  check('template mutation caught: the proposed sensor size loses its input', unboundTyped(template.replace('v-model="passiveSize"', ''), ['passiveSize']).length === 1 ? true : 'the missing input was not found')
}

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

const queryOf = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
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

    resolve({ GameID, RaceID, raw, database: { query: queryOf(raw) } })
  })
})

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const stock = await openStock(options.stock)

  console.log(`Save read by the page checks: ${stock ? options.stock[0] : `${options.stock[0]} (not there)`}`)
  console.log('The Sensor Planner modes: mode, tech, active, beam, passive, template, embed, links, load and save')

  for (const [statement, held] of await pageStatements(null, stock)) {
    check(statement, await settle(held))
  }

  if (options.mutations) {
    console.log('\nMutations: each fault in a copy of a page must fail the statements it names')
    await runMutations(stock)
    templateFaults()
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
