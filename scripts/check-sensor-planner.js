/*
  Checks the Sensor Planner page (pages/sensors.vue) over the signature rules (utilities/signatures.js): what the classes of a race show to a passive and an active sensor and how far the typed enemy sensors reach them.

  node scripts/check-sensor-planner.js [--stock <save.db> <GameID> <RaceID>] [--no-mutations]

  Groups (the page's script on a pseudo instance, scripts/lib/page-loader.js, over classes written here; its template read as text):
  - unknown: a blank enemy figure is unknown, shown as Unknown and never 0, a typed one is assumed, a text that is not above 0 is reported and stays unknown, and a class with no active sensor shows 0 EM that an enemy EM sensor reaches 0 km;
  - signatures: the speed shares typed, idle and full always present, one row for each class shown, obsolete classes hidden on request, the cross-section with the cloak working and damaged apart (and the reach of an active sensor against each), and a stored figure the rules do not reproduce flagged;
  - speed: the chart of the speed panel and its table carry the same points, and an unknown reach is left out of the chart and kept in the table;
  - passive: the range curves of every researched sensor and the typed enemy sensor, the chart drawing the strongest eight of a kind and the table all of them, a signature of 0 listed in the table only, a typed list that is not read reported, and four times the sensitivity doubling the range;
  - reduction: the class's engines at each researched level, the cost factor shown as applied only under a multiplier of 1, the current level marked;
  - template: every top-level panel carries a data-summary, the texts keep the impersonal voice, the stored-figure warning and the unavailable text are in the template, and the persisted view keeps each typed figure for the race;
  - save: the page's own reads on the stock save, a row for every class, no cross-section the rules rebuild differently from the one stored, and every thermal and EM sensor the race has researched;

  Mutants: each deliberate fault in a copy of the page's script (or its template text) must fail the checks it names.

  Prints `N of N checks passed`; any failed check sets exit code 1. A check whose save is not there is reported as skipped, never as passed.
*/
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const pagePath = path.join(root, 'src', 'renderer', 'pages', 'sensors.vue')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

const FIELDS_STUB = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => { globalThis.__sensorsFields = Object.assign(globalThis.__sensorsFields || {}, fields); return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'

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

const same = (actual, expected) => (close(actual, expected) ? true : `${short(actual)} is not ${short(expected)}`)

// ---------- the classes ----------

const ENGINE_TECHS = Object.freeze({ engine: 40, fuel: 65, thermal: 101 })

const engine = (fields) => Object.freeze({ id: 11, name: 'Ion', power: 250, thermalRating: 1, thrust: 1, sizeHS: 10, count: 2, techIds: ENGINE_TECHS, ...fields })

const record = (fields) => Object.freeze({ obsolete: false, commercial: false, engines: [], cloaks: [], activeSensors: [], thermalSensors: [], emSensors: [], ...fields })

// A cloaked class with two engines of one design, a shield, two active sensors and the fitted passive sensors: thermal 2 × 250 × 1 = 500, cross-section 100 × 0.5 = 50 (100 with the cloak damaged), shield EM 10 × 30 = 300, active EM 20 × 50 = 1,000 and 5 × 100 = 500.
const CLOAKER = record({
  id: 1,
  name: 'Cloaker',
  sizeHS: 100,
  stored: { crossSection: 50, sensorReduction: 0.5, thermal: 500, enginePower: 500, speed: 5000, shieldStrength: 10 },
  engines: [engine()],
  cloaks: [{ id: 21, name: 'Cloak', maxShipHS: 200, rating: 0.5, count: 1 }],
  activeSensors: [{ id: 31, name: 'Search', strength: 20, resolution: 50, count: 1 }, { id: 32, name: 'Scan', strength: 5.5, resolution: 100.9, count: 1 }],
  thermalSensors: [{ id: 41, name: 'Thermal 25', sensitivity: 25, count: 1 }],
  emSensors: [{ id: 42, name: 'EM 16', sensitivity: 16, count: 1 }],
})

// A class with no engine, no cloak, no shield and no active sensor: idle thermal 40 / 20 = 2, 0 when it moves, EM 0 from every source.
const BARE = record({ id: 2, name: 'Bare', sizeHS: 40, stored: { crossSection: 40, sensorReduction: 1, thermal: 0, enginePower: 0, speed: 0, shieldStrength: 0 } })

// An obsolete class whose stored thermal signature (999) is not the one its engine gives (100) and whose shield strength is not stored.
const MISMATCH = record({
  id: 3,
  name: 'Mismatch',
  obsolete: true,
  sizeHS: 20,
  stored: { crossSection: 20, sensorReduction: 1, thermal: 999, enginePower: 100, speed: 5000, shieldStrength: null },
  engines: [engine({ id: 12, name: 'Odd', power: 100, sizeHS: 4, count: 1 })],
})

const CLASSES = Object.freeze([CLOAKER, BARE, MISMATCH])

// A class whose size the save does not store, with an engine: no size, no tons and no thermal signature are known for it.
const SIZELESS = record({ id: 4, name: 'Sizeless', sizeHS: null, stored: { crossSection: null, sensorReduction: null, thermal: null, enginePower: null, speed: null, shieldStrength: null }, engines: [engine()] })

// A class whose saved cross-section (25) is not the 50 its size (100) and cloak (0.5) give.
const MISSTORED = record({ id: 5, name: 'Misstored', sizeHS: 100, stored: { crossSection: 25, sensorReduction: 0.5, thermal: 0, enginePower: 0, speed: 0, shieldStrength: 0 }, cloaks: [{ id: 21, name: 'Cloak', maxShipHS: 200, rating: 0.5, count: 1 }] })

// The sensors a race has researched, as the rows ownedPassiveSensors reads: a thermal sensor fitted to the cloaker (41), one fitted to no class (43), two EM sensors (42 fitted, 44 not), and an active sensor the loader never returns, which the page would still leave out.
const OWNED = Object.freeze([
  { SDComponentID: 41, Name: 'Thermal 25', ComponentTypeID: 8, ComponentValue: 25 },
  { SDComponentID: 43, Name: 'Thermal 100', ComponentTypeID: 8, ComponentValue: 100 },
  { SDComponentID: 42, Name: 'EM 16', ComponentTypeID: 41, ComponentValue: 16 },
  { SDComponentID: 44, Name: 'EM 4', ComponentTypeID: 41, ComponentValue: 4 },
  { SDComponentID: 31, Name: 'Search', ComponentTypeID: 24, ComponentValue: 20 },
])

// Ten researched thermal sensors of sensitivity 1 to 10, more than the chart has colours left for.
const MANY = Object.freeze(Array.from({ length: 10 }, (_, index) => ({ SDComponentID: 60 + index, Name: `Thermal ${index + 1}`, ComponentTypeID: 8, ComponentValue: index + 1 })))

const LEVELS = Object.freeze([
  Object.freeze({ id: 101, name: 'Reduction 100%', multiplier: 1, costFactor: 1, cost: 100, obsolete: false }),
  Object.freeze({ id: 102, name: 'Reduction 50%', multiplier: 0.5, costFactor: 2, cost: 400, obsolete: false }),
])

const REDUCTION = Object.freeze({
  levels: LEVELS,
  techs: Object.freeze({ 40: Object.freeze({ type: 40, name: 'Engine', info: 25, info2: 0 }), 65: Object.freeze({ type: 65, name: 'Fuel', info: 1, info2: 0 }) }),
})

const NOTHING = { enemyThermal: '', enemyEm: '', enemyRange: '', enemyResolution: '' }

const passiveRange = (sensitivity, signature) => 250000 * Math.sqrt(sensitivity * signature)

// ---------- the template ----------

const templateOf = (source) => {
  const parsed = require(path.join(root, 'node_modules', 'vue', 'compiler-sfc')).parse({ source })

  return (parsed.template || parsed.descriptor.template).content
}

// The problems of a template: a top-level panel with no (or an empty) data-summary, and the panels that carry no head.
const panelProblems = (template) => {
  const panels = template.match(/<v-card\b[^>]*class="panel"[^>]*>/g) || []
  const heads = (template.match(/class="panel-head"/g) || []).length
  const bare = panels.filter((tag) => !/data-summary="[^"]{20,}"/.test(tag))

  return [...(panels.length ? [] : ['the template has no panel']), ...(bare.length ? [`${bare.length} of ${panels.length} panels have no data-summary`] : []), ...(heads === panels.length ? [] : [`${panels.length} panels and ${heads} panel heads`])]
}

const PRONOUNS = /\b(?:me|my|myself|we|our|ours|ourselves|you|your|yours|yourself)\b|\bI\b/

// The words a reader sees: the text between tags and the data-summary of each panel, with the template expressions left out.
const wordsOf = (template) => {
  const summaries = (template.match(/data-summary="[^"]*"/g) || []).join(' ')
  const text = template.replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ')

  return `${text} ${summaries}`
}

const TEMPLATE = (mutate = (text) => text) => mutate(templateOf(fs.readFileSync(pagePath, 'utf8')))

// The problems of a template's warning for a stored figure the rules do not reproduce: one on the cross-section and one on the thermal signature.
const flagProblems = (template) => ['crossSection', 'thermal'].filter((figure) => !new RegExp(`item\\.sig\\.${figure}\\.agrees === false`).test(template)).map((figure) => `no warning on the ${figure}`).concat(/mdi-alert-circle-outline/.test(template) ? [] : ['no warning icon'])

// The text a page's warning icon of the named figure gives for a class's row: the arguments of its `disagreement(...)` call in the template (paths from `item`, then the figure's name), given to the instance's method; null when the template has no such warning.
const warningOf = (template, vm, item, name) => {
  const call = template.match(new RegExp(`disagreement\\(([^)]*'${name}')\\)`))
  const argument = (text) => (text.startsWith('\'') ? text.slice(1, -1) : text.split('.').slice(1).reduce((value, key) => value[key], item))

  return call ? vm.disagreement(...call[1].split(',').map((text) => argument(text.trim()))) : null
}

// The figures of the template (`shown`, `count` and `percent` cells) and the lines that hold more of them than provenance marks.
const FIGURE = /\{\{ *(shown|count|percent)\(/g

const cellCount = (template) => template.split('\n').reduce((total, line) => total + (line.match(FIGURE) || []).length, 0)

const unmarked = (template) => template.split('\n').filter((line) => (line.match(FIGURE) || []).length > (line.match(/<provenance-mark/g) || []).length)

// The names of the page's reads the load state tracks: the async computeds of the page and of its mixins, but the scenario records, which are no input of the page.
const asyncNamesOf = (options) => [...new Set([...(options.mixins || []).flatMap(asyncNamesOf), ...Object.keys(options.asyncComputed || {})])].filter((name) => name !== 'records')

// ---------- the page ----------

const PAGE = 'pages/sensors'

let loadedUtilities = null

const utilities = () => {
  loadedUtilities = loadedUtilities || loadUtilities(['design-rules', 'provenance', 'signatures'], { stubs: STUBS })

  return loadedUtilities
}

const pageStatements = async (mutate, stock) => {
  globalThis.__sensorsFields = {}

  const options = await loadPage(PAGE, { stubs: STUBS, mutate, modules: { 'mixins/persisted-view': FIELDS_STUB, 'mixins/load-state': null } })
  const fields = globalThis.__sensorsFields
  const libraries = await utilities()
  const rules = libraries['design-rules']
  const page = (data = {}) => instantiate(options, { $store: { getters: {}, state: {} }, database: {}, GameID: 138, RaceID: 785, data: { classRead: CLASSES, ownedRows: OWNED, reduction: REDUCTION, loadErrors: {}, ...NOTHING, ...data } })
  const row = (vm, name) => vm.signatureRows.find((entry) => entry.name === name)

  // A read that fails, then Retry with the real load-state mixin (an instance has no $asyncComputed, so its update re-runs the read as the plugin would): which read failed, which `update` ran, and, once `good` (the stock save) answers, whether the failure is gone.
  const retried = async (name, good) => {
    const state = { database: { query: () => Promise.reject(new Error('the read failed')) } }
    const names = asyncNamesOf(options)
    const database = { query: (...args) => state.database.query(...args) }
    const vm = instantiate(options, { $store: { getters: {}, state: {} }, database, GameID: good ? good.GameID : 138, RaceID: good ? good.RaceID : 785 })
    const updated = []

    vm.$asyncComputed = Object.fromEntries(names.map((entry) => [entry, { update: () => { updated.push(entry); return vm.runAsync(entry).catch(() => null) } }]))

    await vm.runAsync(name).catch(() => null)

    const failed = typeof vm.loadErrors[name] === 'string' && vm.failedInputs.join() === name && !vm.ready

    if (good) {
      state.database = good.database
    }

    vm.retryFailedInputs()
    await new Promise((resolve) => setTimeout(resolve, good ? 3000 : 20))

    return { name, failed, updated: updated.join(), errors: vm.loadErrors, cleared: vm.loadErrors[name] === null && vm.failedInputs.length === 0 }
  }
  const known = (result) => result.status !== 'unavailable'
  const typed = (result) => result.status !== 'confirmed' && result.assumptions.some((text) => text.includes('is typed'))
  const cells = (vm) => vm.signatureRows.flatMap((entry) => [...Object.values(entry.reach).flat()])

  return [
    // ---------- unknown ----------
    ['unknown: a blank enemy figure is unavailable and shown as Unknown, never 0', () => {
      const vm = page()
      const reaches = cells(vm)
      const texts = reaches.map((result) => vm.shown(result, 2, 1e6))

      return reaches.length === 3 * 7 && reaches.every((result) => !known(result)) && texts.every((text) => text === 'Unknown') && vm.signatureRows.every((entry) => entry.reachCross === null && entry.reachUncloaked === null && entry.reachShields === null && entry.reachActiveEm === null && entry.reachshare0 === null && entry.reachshare2 === null) ? true : `${reaches.length} reaches, texts ${short(texts)}`
    }],
    ['unknown: a typed enemy thermal sensitivity reaches the thermal signature and is assumed', () => {
      const vm = page({ enemyThermal: '16' })
      const result = row(vm, 'Cloaker').reach.thermal[2]

      return known(result) && typed(result) && close(result.value, passiveRange(16, 500)) && !known(row(vm, 'Cloaker').reach.shields) ? true : short(result)
    }],
    ['unknown: a typed enemy EM sensitivity reaches the shields and the strongest active sensor, each assumed', () => {
      const vm = page({ enemyEm: '4' })
      const { shields, activeEm } = row(vm, 'Cloaker').reach

      return known(shields) && close(shields.value, passiveRange(4, 300)) && typed(shields) && known(activeEm) && close(activeEm.value, passiveRange(4, 1000)) && typed(activeEm) ? true : short({ shields, activeEm })
    }],
    ['unknown: a text that is not above 0 stays unknown and is reported', () => {
      const vm = page({ enemyThermal: '-3', enemyEm: 'abc', enemyRange: '0', enemyResolution: '  ' })

      return !known(row(vm, 'Cloaker').reach.thermal[2]) && !known(row(vm, 'Cloaker').reach.shields) && !known(row(vm, 'Cloaker').reach.cross) && vm.inputProblems.length === 3 && vm.inputProblems.every((text) => !PRONOUNS.test(text)) ? true : short(vm.inputProblems)
    }],
    ['unknown: a class with no active sensor shows 0 EM that an enemy EM sensor reaches 0 km, a class with no shield stored shows it unknown', () => {
      const vm = page({ enemyEm: '4' })
      const bare = row(vm, 'Bare')
      const odd = row(vm, 'Mismatch')

      return known(bare.reach.activeEm) && bare.reach.activeEm.value === 0 && known(bare.reach.shields) && bare.reach.shields.value === 0 && !known(odd.reach.shields) && !known(odd.sig.em.shields) ? true : short({ bare: bare.reach, odd: odd.reach })
    }],

    // ---------- signatures ----------
    ['signatures: idle, 50 % and full speed give the floor, the share of the engines and the engines', () => {
      const vm = page()
      const cloaker = row(vm, 'Cloaker')

      return same(cloaker.share0, 5) === true && same(cloaker.share1, 250) === true && same(cloaker.share2, 500) === true && vm.shareColumns.map((column) => column.label).join() === 'idle,50 %,100 %' && vm.signatureHeaders.filter((header) => header.text.startsWith('Thermal')).length === 3 ? true : short(cloaker)
    }],
    ['signatures: a class with no engine shows the floor at rest and 0 moving', () => {
      const bare = row(page(), 'Bare')

      return bare.share0 === 2 && bare.share1 === 0 && bare.share2 === 0 ? true : short([bare.share0, bare.share1, bare.share2])
    }],
    ['signatures: typed shares are columns beside idle and full, sorted', () => {
      const vm = page({ shares: '75, 25' })
      const cloaker = row(vm, 'Cloaker')

      return vm.shareColumns.map((column) => column.label).join() === 'idle,25 %,75 %,100 %' && close(cloaker.share1, 125) && close(cloaker.share2, 375) && close(cloaker.share3, 500) ? true : short(vm.shareColumns)
    }],
    ['signatures: shares that are not read give the defaults and a problem', () => {
      const vm = page({ shares: '50, many' })

      return vm.shareColumns.length === 3 && vm.inputProblems.length === 1 && /Speed shares/.test(vm.inputProblems[0]) ? true : short(vm.inputProblems)
    }],
    ['signatures: one row for each class, and the obsolete ones leave when hidden', () => {
      const all = page()
      const hidden = page({ hideObsolete: true })

      return all.signatureRows.length === 3 && hidden.signatureRows.length === 2 && !row(hidden, 'Mismatch') && all.classItems.length === 3 ? true : short([all.signatureRows.length, hidden.signatureRows.length])
    }],
    ['signatures: the cross-section with the cloak working and damaged are apart, and so are the reaches of an active sensor against each', () => {
      const vm = page({ enemyRange: '1000000', enemyResolution: '100' })
      const cloaker = row(vm, 'Cloaker')
      const bare = row(vm, 'Bare')
      const distinct = vm.signatureHeaders.filter((header) => header.value === 'cross' || header.value === 'uncloaked')

      return cloaker.cross === 50 && cloaker.uncloaked === 100 && cloaker.sig.crossSection.cloaked === true && close(cloaker.reachCross, 250000) && close(cloaker.reachUncloaked, 1000000) && bare.cross === 40 && bare.uncloaked === 40 && close(bare.reachCross, bare.reachUncloaked) && distinct.length === 2 && distinct[0].text !== distinct[1].text ? true : short({ cross: cloaker.cross, uncloaked: cloaker.uncloaked, reach: [cloaker.reachCross, cloaker.reachUncloaked] })
    }],
    ['signatures: the active sensors of a class are each seen on their own, never summed', () => {
      const cloaker = row(page(), 'Cloaker')
      const values = cloaker.sig.em.activeSensors.map(({ result }) => result.value)

      return values.join() === '1000,500' && cloaker.active === 1000 && page().activeEmText(cloaker).includes('Scan: 500') ? true : short(values)
    }],
    ['signatures: a stored figure the rules do not reproduce is flagged, one they reproduce is not', () => {
      const vm = page()

      return row(vm, 'Mismatch').sig.thermal.agrees === false && row(vm, 'Cloaker').sig.thermal.agrees === true && row(vm, 'Cloaker').sig.crossSection.agrees === true && row(vm, 'Bare').sig.thermal.agrees === true && vm.disagreement(row(vm, 'Mismatch').sig.thermal.stored, row(vm, 'Mismatch').sig.thermal.aggregate, 'thermal signature').includes('999') ? true : short(vm.signatureRows.map((entry) => [entry.name, entry.sig.thermal.agrees]))
    }],
    ['signatures: the chosen class is used, else the first with an engine', () => {
      const none = page()
      const chosen = page({ classId: 2 })
      const stale = page({ classId: 999 })
      const noEngines = page({ classRead: [BARE] })

      return none.selectedClass.id === 1 && chosen.selectedClass.id === 2 && stale.selectedClass.id === 1 && noEngines.selectedClass.id === 2 ? true : short([none.selectedClass.id, chosen.selectedClass.id, stale.selectedClass.id])
    }],

    // ---------- speed ----------
    ['speed: the chart and the table carry the same points, and an unknown reach is in the table as unavailable and not in the chart', () => {
      const vm = page()
      const rows = vm.speedRows
      const [thermal, ...others] = vm.speedChart.data.datasets

      return rows.length === 21 && thermal.data.length === 21 && others.length === 0 && vm.speedChart.hasReach === false && rows.every((entry) => !known(entry.reach) && known(entry.thermal)) && thermal.data.every((point, index) => close(point.x, rows[index].fraction * 100) && close(point.y, rows[index].thermal.value, 1e-3)) ? true : short(thermal.data.slice(0, 3))
    }],
    ['speed: with the enemy thermal sensitivity typed the reach is charted on its own axis at the points of the table', () => {
      const vm = page({ enemyThermal: '16' })
      const rows = vm.speedRows
      const reach = vm.speedChart.data.datasets.find((set) => set.yAxisID === 'y1')

      return vm.speedChart.hasReach === true && reach.data.length === 21 && rows.every((entry) => known(entry.reach) && typed(entry.reach)) && reach.data.every((point, index) => close(point.x, rows[index].fraction * 100) && close(point.y, rows[index].reach.value / 1e6, 1e-3)) ? true : short(reach)
    }],
    ['speed: the curve is the chosen class\'s', () => {
      const vm = page({ classId: 2 })
      const last = vm.speedRows[20]
      const first = vm.speedRows[0]

      return same(first.thermal.value, 2) === true && same(last.thermal.value, 0) === true ? true : short([first.thermal.value, last.thermal.value])
    }],

    // ---------- passive ----------
    ['passive: every researched sensor, fitted or not, and the typed enemy sensor are curves over the typed signatures, the table has a row for every signature', () => {
      const vm = page({ enemyThermal: '100', targetThermal: '10, 1000, 100' })
      const thermal = vm.passiveSets.find((set) => set.kind === 'thermal')

      return thermal.curve.series.map((series) => series.name).join() === 'Thermal 100 (100),Thermal 25 (25),Enemy sensor' && thermal.curve.rows.map((entry) => entry.signature).join() === '10,100,1000' && thermal.sensitivities.length === 3 ? true : short(thermal.curve.series.map((series) => series.name))
    }],
    ['passive: four times the sensitivity doubles the range of a fixed signature', () => {
      const vm = page({ enemyThermal: '100', targetThermal: '400' })
      const { ranges } = vm.passiveSets.find((set) => set.kind === 'thermal').curve.rows[0]
      const own = ranges.find((range) => range.key === 'thermal-41')
      const enemy = ranges.find((range) => range.key === 'thermal-enemy')

      return close(enemy.result.value, 2 * own.result.value) && close(own.result.value, passiveRange(25, 400)) ? true : short([own.result.value, enemy.result.value])
    }],
    ['passive: the chart and the table carry the same points, and a signature of 0 is in the table only', () => {
      const vm = page({ enemyEm: '9', targetEm: '0, 100, 10000', targetThermal: '1, 10' })

      return vm.passiveSets.every((set) => set.chart.data.datasets.every((dataset, index) => {
        const series = set.chartSeries[index]
        const column = set.curve.series.findIndex((entry) => entry.key === series.key)
        const cellsOf = set.curve.rows.map((entry) => ({ x: entry.signature, result: entry.ranges[column].result })).filter(({ x, result }) => known(result) && x > 0 && result.value > 0)

        return dataset.label === series.name && dataset.data.length === cellsOf.length && dataset.data.every((point, place) => close(point.x, cellsOf[place].x) && close(point.y, cellsOf[place].result.value / 1e6, 1e-3)) && series.points.length >= cellsOf.length
      })) && vm.passiveSets[1].skipped === true && vm.passiveSets[1].curve.rows[0].signature === 0 && vm.passiveSets[1].curve.rows[0].ranges.every((range) => known(range.result) && range.result.value === 0) && vm.passiveSets[1].chart.data.datasets.every((dataset) => dataset.data.length === 2) ? true : short(vm.passiveSets[1].chart.data.datasets.map((dataset) => dataset.data.length))
    }],
    ['passive: a list that is not read is reported and draws no curve', () => {
      const vm = page({ targetThermal: '10, tall', targetEm: '5, -1' })

      return vm.targetThermalRead.error.includes('tall') && vm.targetEmRead.error.includes('-1') && vm.passiveSets.every((set) => set.curve.rows.length === 0 && set.chart.data.datasets.every((dataset) => dataset.data.length === 0)) ? true : short([vm.targetThermalRead, vm.targetEmRead])
    }],
    ['passive: a race that has researched no sensor and typed no enemy figure has no curve, never a curve of 0', () => {
      const vm = page({ ownedRows: [] })

      return vm.passiveSets.every((set) => set.sensitivities.length === 0 && set.curve.series.length === 0 && set.chartSeries.length === 0) ? true : short(vm.passiveSets.map((set) => set.sensitivities))
    }],
    ['passive: a researched sensor fitted to no class is listed, and a fitted one the race has not researched is not', () => {
      const unfitted = page({ classRead: [BARE] }).passiveSets.find((set) => set.kind === 'thermal').sensitivities.map((sensor) => sensor.key).join()
      const unresearched = page({ classRead: [CLOAKER], ownedRows: OWNED.filter((entry) => entry.SDComponentID !== 41) }).passiveSets.find((set) => set.kind === 'thermal').sensitivities.map((sensor) => sensor.key).join()

      return unfitted === 'thermal-43,thermal-41' && unresearched === 'thermal-43' ? true : short([unfitted, unresearched])
    }],
    ['passive: every researched sensor is in the table and the chart draws the strongest eight of a kind with the enemy sensor', () => {
      const thermal = page({ ownedRows: MANY, enemyThermal: '3', targetThermal: '100' }).passiveSets.find((set) => set.kind === 'thermal')
      const charted = thermal.chart.data.datasets.map((dataset) => dataset.label)

      return thermal.curve.series.length === 11 && thermal.sensitivities.length === 11 && charted.length === 9 && charted[0].endsWith('(10)') && charted[7].endsWith('(3)') && charted[8] === 'Enemy sensor' && thermal.chartSeries.length === 9 && thermal.hidden === 2 ? true : short([thermal.curve.series.length, charted, thermal.hidden])
    }],

    // ---------- reduction ----------
    ['reduction: the engines at each researched level, the thermal at full power halving with the multiplier and the cost from the level\'s cost factor', () => {
      const vm = page()
      const [full, half] = vm.reductionRows
      const design = (thermalTech, thermalCost) => rules.engineDesign({ sizeHS: 10, thrust: 1, engineTech: 25, fuelTech: 1, thermalTech, thermalCost })

      return vm.reductionRows.length === 2 && full.byFraction[2].result.value === 500 && half.byFraction[2].result.value === 250 && close(full.engineCost.value, design(1, 1).cost) && close(half.engineCost.value, design(0.5, 2).cost) && close(half.classEngineCost.value, 2 * design(0.5, 2).cost) && half.engineCost.value > full.engineCost.value ? true : short(vm.reductionRows.map((entry) => [entry.level.name, entry.aggregate.value, entry.engineCost.value]))
    }],
    ['reduction: the cost factor shows as applied only under a multiplier of 1, and the level the engines are on is marked', () => {
      const [full, half] = page().reductionRows

      return full.costApplied === false && half.costApplied === true && full.level.current === true && half.level.current === false ? true : short([full.costApplied, half.costApplied, full.level.current])
    }],
    ['reduction: a level whose tech row is missing is unavailable, naming it, and a class with no engine has no row', () => {
      const lacking = page({ reduction: { levels: LEVELS, techs: {} } }).reductionRows
      const none = page({ classId: 2 }).reductionRows

      return lacking.length === 2 && lacking.every((entry) => !known(entry.engineCost) && entry.engineCost.inputs.missing.some((text) => text.includes('tech row'))) && none.length === 0 ? true : short(lacking.map((entry) => entry.engineCost))
    }],

    // ---------- template ----------
    ['template: every top-level panel carries a data-summary and a head', () => {
      const problems = panelProblems(TEMPLATE())

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['template: a panel without its data-summary is found', () => {
      const problems = panelProblems(TEMPLATE((text) => text.replace(/(<v-card class="panel") data-summary="[^"]*"/, '$1')))

      return problems.length === 1 && /^1 of \d+ panels have no data-summary$/.test(problems[0]) && Number(problems[0].match(/of (\d+)/)[1]) === (TEMPLATE().match(/<v-card\b[^>]*class="panel"/g) || []).length ? true : short(problems)
    }],
    ['template: the words keep to the impersonal voice', () => {
      const found = wordsOf(TEMPLATE()).match(new RegExp(PRONOUNS.source, 'g'))

      return found === null ? true : `first or second person: ${found.join(', ')}`
    }],
    ['template: the warning for a stored figure the rules do not reproduce and the text of an unknown figure are in the page', () => {
      const template = TEMPLATE()
      const script = fs.readFileSync(pagePath, 'utf8')

      return flagProblems(template).length === 0 && /'Unknown'/.test(script) ? true : `${flagProblems(template).join('; ')} ${/'Unknown'/.test(script) ? '' : 'the text of an unknown figure is missing'}`
    }],
    ['template: a template that never flags a disagreeing figure is found', () => (flagProblems(TEMPLATE((text) => text.replace(/agrees === false/g, 'false'))).length === 2 ? true : 'the missing flags were not found')],
    ['signatures: the warning of a saved cross-section the rules rebuild differently names the saved figure and the rebuilt one', () => {
      const vm = page({ classRead: [MISSTORED] })
      const [entry] = vm.signatureRows

      return entry.sig.crossSection.agrees === false && warningOf(TEMPLATE(), vm, entry, 'cross-section') === 'The save stores 25 for the cross-section of this class and the rule gives 50.' ? true : short([entry.sig.crossSection.agrees, warningOf(TEMPLATE(), vm, entry, 'cross-section')])
    }],
    ['signatures: a warning built from the effective cross-section, which is the saved one, is found', () => {
      const vm = page({ classRead: [MISSTORED] })
      const [entry] = vm.signatureRows
      const text = warningOf(TEMPLATE((source) => source.replace('item.sig.crossSection.stored, item.sig.crossSection.rebuilt', 'item.sig.crossSection.stored, item.sig.crossSection.effective')), vm, entry, 'cross-section')

      return text === 'The save stores 25 for the cross-section of this class and the rule gives 25.' ? true : short(text)
    }],
    ['template: the cross-section with the cloak working and damaged have columns of their own', () => {
      const template = TEMPLATE()

      return template.includes('item.sig.crossSection.effective') && template.includes('item.sig.crossSection.uncloaked') && template.includes('item.reach.cross') && template.includes('item.reach.uncloaked') ? true : 'a column is missing'
    }],
    ['signatures: a class with no stored size shows unknown size and tons, never 0, and its thermal signature stays unknown', () => {
      const [sizeless] = page({ classRead: [SIZELESS] }).signatureRows

      return sizeless.size.status === 'unavailable' && sizeless.size.rule.id === 'design.classSize' && sizeless.tonsResult.status === 'unavailable' && sizeless.tonsResult.rule.id === 'design.classSize' && sizeless.sizeHS === null && sizeless.tons === null && sizeless.sig.thermal.byFraction.every(({ result }) => !known(result)) ? true : short([sizeless.size, sizeless.tons, sizeless.sig.thermal.byFraction.map(({ result }) => result.status)])
    }],
    ['signatures: a class with a stored size shows it and its tons as confirmed figures', () => {
      const cloaker = row(page(), 'Cloaker')

      return cloaker.sizeHS === 100 && close(cloaker.tons, 100 * 50) && cloaker.size.status === 'confirmed' && cloaker.size.rule.id === 'design.classSize' && cloaker.tonsResult.status === 'confirmed' && cloaker.tonsResult.rule.id === 'design.classSize' ? true : short([cloaker.sizeHS, cloaker.tons, cloaker.size.status, cloaker.size.rule.id, cloaker.tonsResult.rule.id])
    }],
    ['passive: every positive range stays positive and equal in the chart, down to one under 500 km', () => {
      const vm = page({ ownedRows: [{ SDComponentID: 70, Name: 'Weak', ComponentTypeID: 8, ComponentValue: 1 }], targetThermal: '0.000001, 100, 10000' })
      const set = vm.passiveSets.find((entry) => entry.kind === 'thermal')
      const [data] = set.chart.data.datasets.map((dataset) => dataset.data)
      const expected = set.curve.rows.map((entry) => ({ x: entry.signature, y: entry.ranges[0].result.value / 1e6 }))
      const relative = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 1e-9 * Math.abs(b)

      return expected[0].y > 0 && expected[0].y < 0.0005 && data.length === expected.length && data.every((point, index) => point.y > 0 && relative(point.y, expected[index].y)) ? true : short([data, expected])
    }],
    ['template: every figure of a table carries its provenance mark, the stored, the typed and the calculated', () => {
      const problems = unmarked(TEMPLATE())

      return problems.length === 0 && cellCount(TEMPLATE()) >= 22 ? true : `${cellCount(TEMPLATE())} figures, ${problems.length} without a mark: ${problems.slice(0, 2).join(' | ').slice(0, 200)}`
    }],
    ['template: a figure without its mark is found, whether it is a count, a share or a shown result', () => {
      const strip = (mark) => unmarked(TEMPLATE((text) => text.replace(mark, ''))).length

      return strip('<provenance-mark :result="typedSignature(row.signature)" />') === 1 && strip('<provenance-mark :result="typedShare(row.fraction)" />') === 1 && strip('<provenance-mark :result="row.multiplierResult" />') === 1 && strip('<provenance-mark :result="item.tonsResult" />') === 1 ? true : 'a missing mark was not found'
    }],
    ['view: each typed figure and the chosen class are kept for the race, the layout choices for the app', () => {
      const race = ['shares', 'enemyThermal', 'enemyEm', 'enemyRange', 'enemyResolution', 'classId', 'targetThermal', 'targetEm', 'signaturesTable', 'reachTable']
      const app = ['hideObsolete', 'speedView', 'passiveView']

      return race.every((name) => fields[name] && fields[name].scope === 'race') && app.every((name) => fields[name] && fields[name].scope !== 'race') ? true : short(Object.entries(fields).map(([name, field]) => [name, field.scope]))
    }],

    // ---------- load ----------
    ['load: a failed read is marked under its own name and Retry runs the async computed of that name, and no other', async () => {
      const names = asyncNamesOf(options)
      const outcomes = await Promise.all(names.map(async (name) => retried(name, null)))

      return names.join() === 'tech,classRead,ownedRows,reduction,activeRows,beamRows' && outcomes.every((outcome) => outcome.failed && outcome.updated === outcome.name) ? true : short(outcomes)
    }],
    ['load: a successful reload after Retry clears the failure of each read, on the stock save', async () => {
      if (!stock) {
        return skipped('the stock save is not there')
      }

      const names = asyncNamesOf(options)
      const outcomes = await Promise.all(names.map(async (name) => retried(name, stock)))

      return outcomes.every((outcome) => outcome.failed && outcome.updated === outcome.name && outcome.cleared) ? true : short(outcomes)
    }],

    // ---------- save ----------
    ['save: the page reads a row for every class of the stock save with the cross-section the save stores', async () => {
      if (!stock) {
        return skipped('the stock save is not there')
      }

      const vm = instantiate(options, { $store: { getters: {}, state: {} }, database: stock.database, GameID: stock.GameID, RaceID: stock.RaceID, data: { loadErrors: {} } })
      const classes = await vm.runAsync('classRead')
      const rows = vm.signatureRows
      const off = rows.filter((entry) => entry.sig.crossSection.agrees !== true)

      return classes.length > 0 && rows.length === classes.length && off.length === 0 ? true : `${classes.length} classes, ${rows.length} rows, ${off.length} cross-sections not as stored: ${off.slice(0, 3).map((entry) => entry.name).join(', ')}`
    }],
    ['save: the page reads the thermal reduction levels of the stock save and rebuilds the current level of an engine', async () => {
      if (!stock) {
        return skipped('the stock save is not there')
      }

      const vm = instantiate(options, { $store: { getters: {}, state: {} }, database: stock.database, GameID: stock.GameID, RaceID: stock.RaceID, data: { loadErrors: {} } })

      await vm.runAsync('classRead')
      await vm.runAsync('reduction')

      const withEngine = vm.classes.filter((cls) => cls.engines.length)
      const current = withEngine.filter((cls) => thermalCurrent(vm, cls))

      return vm.reduction.levels.length > 0 && withEngine.length > 0 && current.length > 0 ? true : `${vm.reduction.levels.length} levels, ${withEngine.length} classes with engines, ${current.length} on a researched level`
    }],
    ['save: the page reads the thermal and EM sensors the race has researched, as many as the save holds', async () => {
      if (!stock) {
        return skipped('the stock save is not there')
      }

      const vm = instantiate(options, { $store: { getters: {}, state: {} }, database: stock.database, GameID: stock.GameID, RaceID: stock.RaceID, data: { loadErrors: {} } })
      const [counted] = await stock.database.query('select c.ComponentTypeID as type, count(*) as n from FCT_ShipDesignComponents c inner join FCT_RaceTech t on t.TechID = c.SDComponentID where c.ComponentTypeID in (8, 41) and c.GameID in (0, :game) and t.GameID = :game and t.RaceID = :race group by c.ComponentTypeID', { replacements: { game: stock.GameID, race: stock.RaceID } })
      const held = (type) => (counted.find((entry) => entry.type === type) || { n: 0 }).n

      await vm.runAsync('ownedRows')

      return held(8) > 0 && vm.ownThermalSensors.length === held(8) && vm.ownEmSensors.length === held(41) ? true : `${vm.ownThermalSensors.length} thermal and ${vm.ownEmSensors.length} EM read, ${held(8)} and ${held(41)} held`
    }],
  ]
}

// Whether the class's engines are on a researched level: one row of its reduction table is the current level.
const thermalCurrent = (vm, cls) => {
  vm.classId = cls.id

  return vm.reductionRows.some((entry) => entry.level.current)
}

// ---------- the mutants ----------

const MUTATIONS = [
  { name: 'an unknown figure is shown as 0', find: ': \'Unknown\'', replace: ': this.count(0, decimals)', fails: ['unknown: a blank enemy figure'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a typed enemy figure carries no assumption', find: 'assumptions: [`${name} is typed, not read from the save`]', replace: 'assumptions: []', fails: ['unknown: a typed enemy thermal', 'unknown: a typed enemy EM', 'speed: with the enemy thermal'] },
  { name: 'the enemy EM sensor reaches the shields for the active sensors too', find: 'activeEm: passiveReach({ sensitivity: this.enemy.em, signature: em.strongestActive })', replace: 'activeEm: passiveReach({ sensitivity: this.enemy.em, signature: em.shields })', fails: ['unknown: a typed enemy EM'] },
  { name: 'the enemy thermal sensor is the EM one', find: 'passiveReach({ sensitivity: this.enemy.thermal, signature: result })', replace: 'passiveReach({ sensitivity: this.enemy.em, signature: result })', fails: ['unknown: a typed enemy thermal'] },
  { name: 'the active reach against the damaged cloak uses the working one', find: 'crossSection: crossSection.uncloaked })', replace: 'crossSection: crossSection.effective })', fails: ['signatures: the cross-section with the cloak working'] },
  { name: 'the damaged cloak column holds the working cross-section', find: 'uncloaked: valueOrNull(crossSection.uncloaked)', replace: 'uncloaked: valueOrNull(crossSection.effective)', fails: ['signatures: the cross-section with the cloak working'] },
  { name: 'the typed shares are not passed to the signatures', find: 'classSignatures(cls, { fractions: this.fractions })', replace: 'classSignatures(cls)', fails: ['signatures: typed shares'] },
  { name: 'obsolete classes are not hidden', find: 'this.hideObsolete ? this.classes.filter((cls) => !cls.obsolete) : this.classes', replace: 'this.classes', fails: ['signatures: one row for each class'] },
  { name: 'the chosen class is ignored', find: 'this.classes.find((cls) => cls.id === this.classId) || ', replace: '', fails: ['signatures: the chosen class'] },
  { name: 'the speed chart plots the share as a fraction', find: 'x: roundToDecimal(point.fraction * 100, 2), y: roundToDecimal(point.thermal, 2)', replace: 'x: point.fraction, y: roundToDecimal(point.thermal, 2)', fails: ['speed: the chart and the table'] },
  { name: 'the speed chart plots the reach in km against the million-km axis', find: 'y: roundToDecimal(point.reach / MILLION, 3)', replace: 'y: roundToDecimal(point.reach, 3)', fails: ['speed: with the enemy thermal'] },
  { name: 'the passive chart keeps a signature of 0', find: 'const shownPoints = (series) => series.points.filter((point) => point.x > 0 && point.y > 0)', replace: 'const shownPoints = (series) => series.points.filter((point) => point.x >= 0)', fails: ['passive: the chart and the table'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the enemy sensor is left out of the curves', find: '...(enemy ? [{ key: `${kind}-enemy`, name: \'Enemy sensor\', sensitivity: enemy }] : [])', replace: '', fails: ['passive: every researched sensor, fitted', 'passive: four times'] },
  { name: 'the cost factor is shown as applied at any multiplier', find: 'costApplied: option.multiplier < 1', replace: 'costApplied: true', fails: ['reduction: the cost factor shows'] },
  { name: 'the thermal reduction ignores the typed shares', find: 'fractions: this.fractions }).map((option)', replace: 'fractions: [0, 1] }).map((option)', fails: ['reduction: the engines at each'] },
  { name: 'the own sensors fall back to those fitted to the classes', find: '.filter((row) => row.ComponentTypeID === typeId)', replace: '.filter((row) => row.ComponentTypeID === typeId && this.classes.some((cls) => [...cls.thermalSensors, ...cls.emSensors].some((sensor) => sensor.id === row.SDComponentID)))', fails: ['passive: every researched sensor', 'passive: a researched sensor fitted to no class'] },
  { name: 'the cap of the chart cuts the table too', find: 'const sensitivities = [...own, ', replace: 'const sensitivities = [...own.slice(0, MAX_SENSOR_SERIES), ', fails: ['passive: every researched sensor is in the table'] },
  { name: 'the weakest sensors are charted before the strongest', find: 'strength(b) - strength(a)', replace: 'strength(a) - strength(b)', fails: ['passive: every researched sensor, fitted', 'passive: every researched sensor is in the table'] },
  { name: 'a class with no size is given tons from 0', find: 'Number.isFinite(cls.sizeHS) ? cls.sizeHS * TONS_PER_HS : null', replace: 'cls.sizeHS * TONS_PER_HS', fails: ['signatures: a class with no stored size'] },
  { name: 'the class size marked under the rule of a component row', find: "const CLASS_SIZE_RULE = 'design.classSize'", replace: "const CLASS_SIZE_RULE = 'component.imported'", fails: ['signatures: a class with a stored size', 'signatures: a class with no stored size'] },
  { name: 'the passive chart rounds a range to 3 decimals of a million km', find: 'shownPoints(series).map((point) => ({ x: point.x, y: point.y / MILLION }))', replace: 'shownPoints(series).map((point) => ({ x: point.x, y: roundToDecimal(point.y / MILLION, 3) }))', fails: ['passive: every positive range'] },
  { name: 'a read tracked under a key its async computed does not have', find: "tracked('ownedRows'", replace: "tracked('ownedSensors'", fails: ['load: a failed read'] },
]

const runMutations = async (stock) => {
  for (const { name, find, replace, fails } of MUTATIONS) {
    let outcome

    try {
      const statements = await pageStatements(replacing(find, replace), stock)
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

// The page's database.query over a read-only sqlite3 handle: the named replacements become the handle's parameters, and the rows come back as [rows].
const queryOf = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
  const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
  const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

  raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
})

// The stock save, opened read-only: { database: { query }, GameID, RaceID }, or null when the file is not there.
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

    resolve({
      GameID,
      RaceID,
      raw,
      database: { query: queryOf(raw) },
    })
  })
})

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const stock = await openStock(options.stock)

  console.log(`Save read by the page checks: ${stock ? options.stock[0] : `${options.stock[0]} (not there)`}`)
  console.log('The Sensor Planner page: unknown figures, signatures, speed, passive range, thermal reduction, template and save')

  for (const [statement, held] of await pageStatements(null, stock)) {
    check(statement, await settle(held))
  }

  if (options.mutations) {
    console.log('\nMutations: each fault in a copy of the page must fail the statements it names')
    await runMutations(stock)
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
