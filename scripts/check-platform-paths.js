/*
  Checks the comparison of the ways a mining platform class is produced (src/renderer/utilities/platform-paths.js, src/renderer/components/shipyards/PlatformPaths.vue and its mount in src/renderer/pages/shipyards.vue).

  bun scripts/check-platform-paths.js [--no-mutations]

  The utility is run on synthetic classes, yards and colonies worked by hand: the recipe is the class's cost and the sum of its components' minerals times their counts; a class is a station only when it is on the race's own list, not obsolete, without armour and without a prototype component (a known blocker beats an unknown flag, a class from another race is no blocker, and the structural shell every armourless class mounts is no armour); a colony without a spaceport cannot make it; a component the race has not researched must be in the colony's stock, for every platform for a yard and for one hull for the industry; the stored components credit each task in turn and once, so the tasks' build points add up to the build points of the hulls less what the stock covers, and a task left with none, or a zero shipbuilding output, makes no progress; a yard builds one platform per task, a task on each free slipway at a time, so the time is the finish of a list schedule at the colony's rate for the class, with a retool adding its days and a yard with no free slipway having no time; the industry takes the share the colony's projects out of the queue (paused ones too, queued ones not) leave of its construction capacity; a missing rate, capacity, stock, project list, installation or research read leaves the time unavailable and named, never 0; and `quicker` is only ever said of one colony, and only when both times are known and the stock covers the minerals of both routes.

  The panel's script is run as a pseudo instance over scripts/lib/page-loader.js and its template and the Shipyards page's mount are read as text.

  The loader is also run on an in-memory save built in this script, whether or not the saves are there. The saves (saves/AuroraDB.db and saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, read-only) give the real classes, yards, colonies and stored Space station projects: the loader is compared with raw counts, the class cost with the sum of its components', and the stored projects' build points and minerals with the recipe (a stored project made before its class was changed differs; those are reported, not failed). A save that is not there is skipped.

  Each mutation of the utility, the panel or the page must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilityFile = path.join(root, 'src', 'renderer', 'utilities', 'platform-paths.js')
const componentFile = path.join(root, 'src', 'renderer', 'components', 'shipyards', 'PlatformPaths.vue')
const pageFile = path.join(root, 'src', 'renderer', 'pages', 'shipyards.vue')
const NAMES = ['platform-paths', 'refits', 'component-calc', 'workforce-demand', 'production', 'provenance', 'minerals']
const SAVES = [
  { file: 'saves/AuroraDB.db', game: 138, race: 785, stored: 3 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785, stored: 1 },
]

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
}

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const SHORT_LIMIT = Number(process.env.SHORT_LIMIT) || 300

// The values a failure shows: a result's rule and inputs and a row's eligibility are left out, as they only fill the line.
const DROPPED = new Set(['eligibility', 'rule', 'inputs', 'assumptions', 'notes', 'slipways'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

const near = (actual, expected, tolerance = 1e-9) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance

// True, or a text with what differed.
const same = (actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected) ? true : `${short(actual)} != ${short(expected)}`)

const sameNumber = (actual, expected) => (near(actual, expected) ? true : `${short(actual)} != ${short(expected)}`)

const finiteAll = (value) => (typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(finiteAll) : value !== null && typeof value === 'object' ? Object.values(value).every(finiteAll) : true)

// A row without its eligibility record, which holds the class and yard objects.
const withoutEligibility = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'eligibility'))

// What the template compiler of a component's text reports; a template that does not compile is a page that does not draw.
const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' }).errors.map(String)
}

const DAY = 365

// ---------- the fixtures worked by hand ----------

const fixtures = (m) => {
  const MINERAL_NAMES = m.minerals.MINERALS.map(({ name }) => name)
  const mins = (over = {}) => Object.fromEntries(MINERAL_NAMES.map((name) => [name, over[name] || 0]))
  const stock = (over = {}) => Object.fromEntries(MINERAL_NAMES.map((name) => [name, name in over ? over[name] : 100]))
  // Engine, mining module and structural shell: a platform mounts one engine, two modules and one shell, costing 10 + 40 + 2 = 52 BP and 15 Duranium, 2 Boronide, 6 Corbomite.
  const components = {
    1: { id: 1, name: 'Engine', typeId: 5, cost: 10, minerals: mins({ Duranium: 4, Boronide: 2 }) },
    2: { id: 2, name: 'Mining module', typeId: 38, cost: 20, minerals: mins({ Duranium: 5, Corbomite: 3 }) },
    3: { id: 3, name: 'Structural shell', typeId: 11, cost: 2, minerals: mins({ Duranium: 1 }) },
  }
  const cls = (id, over = {}) => ({ id, name: `Class ${id}`, sizeHS: 10, cost: 52, commercial: false, obsolete: false, shippingLine: false, otherRace: false, prototype: false, counts: { 1: 1, 2: 2, 3: 1 }, ...over })
  const PLAT = cls(100, { name: 'Platform' })
  const FAR = cls(101, { name: 'Far', sizeHS: 20, cost: 100, counts: { 1: 2, 2: 4 } })
  const context = { classesById: { 100: PLAT, 101: FAR }, components, version: '2.7.1', cache: new Map() }
  const capacity = (value) => m.provenance.ofRule({ rule: 'platformPaths.industry', value, inputs: { present: ['capacity'] }, units: 'BP/yr' })
  const unknownCapacity = m.provenance.unavailable({ rule: 'platformPaths.industry', missing: ['the colony\'s production modifiers'], units: 'BP/yr' })
  const MODIFIERS = { ShipyardBuildRate: 1000, ShipyardOperations: 1 }
  const colony = (over = {}) => ({ name: 'Alpha', modifiers: MODIFIERS, capacity: capacity(1000), projects: [], stock: {}, minerals: stock(), spaceports: 1, factories: { workers: 0.5 }, ...over })
  const yard = (over = {}) => ({ id: 1, populationId: 7, colony: 'Alpha', name: 'Yard A', type: 1, slipways: 2, capacity: 1000, tasks: 0, tooledId: 100, retoolId: null, shipBased: false, ...over })
  // The rate of a platform at a colony of build rate 1000: 1000 x (1 + (10 / 100 x 10 - 1) / 2)... the factor of a class of 10 size units is 0.55.
  const RATE = 550
  const RESEARCHED = { 1: 1, 2: 1, 3: 1 }
  const run = (over = {}) => m.pp.comparePaths({ shipClass: PLAT, noArmour: true, components, researched: RESEARCHED, quantity: 2, yards: [yard()], colonies: { 7: colony() }, context, version: '2.7.1', ...over })
  const rowOf = (result, path, populationId = 7) => result.rows.find((row) => row.path === path && row.populationId === populationId)

  return { MINERAL_NAMES, mins, stock, components, cls, PLAT, FAR, context, capacity, unknownCapacity, MODIFIERS, colony, yard, RATE, RESEARCHED, run, rowOf }
}

const pure = (ctx) => {
  const { m } = ctx
  const f = fixtures(m)
  const { PLAT, components, cls, colony, yard, run, rowOf, RATE, stock, mins, capacity, unknownCapacity } = f
  const { pp, provenance } = m
  const ruleOf = (result) => (result && result.rule ? result.rule.id : null)
  const stationOf = (shipClass, noArmour) => pp.stationEligibility(shipClass, noArmour)
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('rules: the six rules are registered, 2.7.x, with the kind of check each is', () => {
    const expected = { 'platformPaths.recipe': 'confirmed', 'platformPaths.stationClass': 'estimated', 'platformPaths.spaceport': 'estimated', 'platformPaths.yard': 'estimated', 'platformPaths.industry': 'estimated', 'platformPaths.labour': 'confirmed' }
    const bad = Object.entries(expected).filter(([id, verification]) => { const rule = provenance.getRule(id); return !rule || rule.verification !== verification || !rule.versions.includes('2.7.x') || !rule.units }).map(([id]) => id)

    return bad.length ? `wrong or missing: ${bad.join(', ')}` : true
  })

  // ----- the recipe -----
  const recipe = pp.recipeOf(PLAT, components)

  add('recipe: a platform costs the class\'s build points and the sum of its components\' minerals times their counts', () => same([recipe.bp, recipe.minerals.Duranium, recipe.minerals.Boronide, recipe.minerals.Corbomite, recipe.minerals.Neutronium, recipe.missing], [52, 15, 2, 6, 0, []]))
  add('recipe: the recipe is a confirmed result of its rule', () => (ruleOf(recipe.result) === 'platformPaths.recipe' && recipe.result.status === 'confirmed' && recipe.result.value === 52 ? true : short(recipe.result)))
  add('recipe: a component the save does not hold leaves the minerals unknown and named, never 0, while the stored cost stays', () => {
    const open = pp.recipeOf(cls(5, { counts: { 1: 1, 9: 1 } }), components)

    return open.minerals === null && open.bp === 52 && open.result.status === 'unavailable' && open.missing.some((text) => text.includes('component #9')) ? true : short(open)
  })
  add('recipe: a class without a cost has no build points and says so', () => {
    const open = pp.recipeOf(cls(5, { cost: null }), components)

    return open.bp === null && open.result.status === 'unavailable' && open.minerals !== null ? true : short(open)
  })

  // ----- which classes the industry can make -----
  add('eligible: an armourless own class that is not obsolete and has no prototype component is capable, and the structural shell is no armour', () => same(stationOf(PLAT, true), { state: 'capable', blockers: [], missing: [] }) === true && PLAT.counts[3] === 1 && components[3].typeId === 11 ? true : short(stationOf(PLAT, true)))
  add('eligible: a class with armour is ineligible and says so', () => { const r = stationOf(PLAT, false); return r.state === 'ineligible' && r.blockers.length === 1 && r.blockers[0].includes('armour') ? true : short(r) })
  add('eligible: an obsolete class and a prototype class are each ineligible for their own reason', () => {
    const states = [{ obsolete: true }, { prototype: true }].map((over) => stationOf(cls(5, over), true))

    return states.every((r) => r.state === 'ineligible' && r.blockers.length === 1) && states[0].blockers[0].includes('obsolete') && states[1].blockers[0].includes('prototype') ? true : short(states)
  })
  add('eligible: a class copied or captured from another race is the race\'s own and stays capable, whatever the flag says of its origin', () => {
    const states = [true, false, null, undefined].map((otherRace) => stationOf(cls(5, { otherRace }), true))

    return states.every((r) => r.state === 'capable' && r.blockers.length === 0 && r.missing.length === 0) ? true : short(states)
  })
  add('eligible: a flag the save does not give leaves the class unknown, naming it, never capable', () => {
    const states = [stationOf(PLAT, null), stationOf(cls(5, { obsolete: null }), true), stationOf(cls(5, { prototype: null }), true)]

    return states.every((r) => r.state === 'unknown' && r.blockers.length === 0 && r.missing.length === 1) ? true : short(states)
  })
  add('eligible: a known blocker beats an unknown flag, and several blockers are all listed', () => same([stationOf(cls(5, { obsolete: true }), null).state, stationOf(cls(5, { obsolete: true, prototype: true }), false).blockers.length], ['ineligible', 3]))

  // ----- the spaceport and the colony's industry -----
  const industry = (over = {}, quantity = 2, shipClass = PLAT, noArmour = true) => rowOf(run({ shipClass, noArmour, quantity, colonies: { 7: colony(over) } }), 'industry')

  add('industry: a colony with a spaceport and the whole capacity free builds the platforms at its capacity: build points over the capacity, a first platform at one platform\'s', () => {
    const row = industry()

    return same([row.state, row.share, row.bp, row.minerals.Duranium, row.minerals.Boronide, row.minerals.Corbomite], ['capable', 100, 104, 30, 4, 12]) === true && near(row.days, 104 / 1000 * DAY) && near(row.firstDays, 52 / 1000 * DAY) ? true : short(row)
  })
  add('industry: a colony without a spaceport cannot make it, and one whose spaceports are not read is unknown', () => {
    const none = industry({ spaceports: 0 })
    const unread = industry({ spaceports: null })

    return none.state === 'ineligible' && none.days === null && none.reasons.some((text) => text.includes('spaceport')) && unread.state === 'unknown' && unread.days === null && unread.missing.some((text) => text.includes('spaceport')) ? true : short([none, unread])
  })
  add('spaceport: the spaceport blocker is its own, not the class\'s, and a class blocker and a missing spaceport are both told', () => {
    const both = industry({ spaceports: 0 }, 2, PLAT, false)

    return both.reasons.length === 2 && both.reasons.some((text) => text.includes('armour')) && both.reasons.some((text) => text.includes('spaceport')) ? true : short(both)
  })
  add('industry: a class with armour, an obsolete one and a prototype one are ineligible with the class\'s blocker and no time', () => {
    const armour = industry({}, 2, PLAT, false)
    const old = industry({}, 2, cls(5, { obsolete: true }))
    const proto = industry({}, 2, cls(5, { prototype: true }))

    return [armour, old, proto].every((row) => row.state === 'ineligible' && row.days === null && row.bp === null && row.reasons.length === 1) && armour.reasons[0].includes('armour') && old.reasons[0].includes('obsolete') && proto.reasons[0].includes('prototype') ? true : short([armour, old, proto])
  })
  add('industry: the share is what the colony\'s projects out of the queue leave: a running and a paused project hold theirs, a queued one and an ordnance project do not', () => {
    const projects = [{ ProductionType: 0, Queue: 0, Percentage: 40 }, { ProductionType: 0, Queue: 0, Pause: 1, Percentage: 10 }, { ProductionType: 0, Queue: 1, Percentage: 30 }, { ProductionType: 1, Queue: 0, Percentage: 20 }]
    const row = industry({ projects })

    return row.state === 'capable' && row.share === 50 && near(row.days, 104 / 500 * DAY) && near(row.firstDays, 52 / 500 * DAY) ? true : short(row)
  })
  add('industry: a colony whose projects hold the whole capacity is busy, with no time and a note that it waits, never 0 days', () => {
    const row = industry({ projects: [{ ProductionType: 0, Queue: 0, Percentage: 60 }, { ProductionType: 3, Queue: 0, Percentage: 40 }] })

    return row.state === 'busy' && row.days === null && row.startsLater === true && row.share === 0 && row.timeResult.status === 'unavailable' ? true : short(row)
  })
  add('industry: the capacity and the stored minerals are shown against the platforms: the minerals short are named, and none for a stock that covers', () => {
    const covered = industry()
    const lacking = industry({ minerals: stock({ Corbomite: 1 }) })
    const unread = industry({ minerals: null })

    return same([covered.short, lacking.short, unread.short], [{}, { Corbomite: 11 }, null])
  })
  add('industry: the stored components are not used: the build points are the platforms\' whole cost whatever the colony holds', () => {
    const row = industry({ stock: { 1: 5, 2: 10, 3: 5 } })

    return row.bp === 104 && row.credit === null ? true : short(row)
  })
  add('industry: a colony\'s capacity the save does not give leaves the time unavailable and named, never 0', () => {
    const row = industry({ capacity: unknownCapacity })

    return row.state === 'unknown' && row.days === null && row.timeResult.status === 'unavailable' && row.missing.some((text) => text.includes('capacity')) && row.bp === 104 ? true : short(row)
  })
  add('industry: a capacity of 0 takes no share of nothing: ineligible, no time, never an infinite one', () => {
    const row = industry({ capacity: capacity(0) })

    return row.state === 'ineligible' && row.days === null && finiteAll(row) ? true : short(row)
  })
  add('industry: a quantity scales the build points, the minerals and the time, not the first platform\'s time', () => {
    const one = industry({}, 1)
    const five = industry({}, 5)

    return same([one.bp, five.bp, five.minerals.Duranium], [52, 260, 75]) === true && near(five.days, 5 * one.days) && near(five.firstDays, one.days) ? true : short([one, five])
  })

  // ----- the shipyard path -----
  const yardRow = (over = {}, colonyOver = {}, quantity = 2, yardOver = {}) => rowOf(run({ quantity, yards: [yard(yardOver)], colonies: { 7: colony(colonyOver) }, ...over }), 'yard')

  add('stock: with no stored components each platform is a task of the whole cost, and the minerals are the recipe times the quantity', () => {
    const row = yardRow()

    return same([row.state, row.bp, row.minerals.Duranium, row.minerals.Boronide, row.minerals.Corbomite], ['capable', 104, 30, 4, 12]) === true && row.credit.bp === 0 ? true : short(row)
  })
  add('stock: the stored components credit the tasks once and in turn, so the build points are the hulls\' less what the stock covers (never more than a hull mounts)', () => {
    const row = yardRow({}, { stock: { 1: 1, 2: 3 } })

    return row.bp === 34 && row.credit.bp === 70 && row.bp === 2 * 52 - row.credit.bp ? true : short(row)
  })
  add('stock: the credit takes the minerals off with the build points: the stock\'s minerals are taken from the minerals the yard needs', () => {
    const row = yardRow({}, { stock: { 1: 1, 2: 3 } })

    return same([row.minerals.Duranium, row.minerals.Boronide, row.minerals.Corbomite], [11, 2, 3])
  })
  add('stock: a stock beyond what the platforms mount is not counted, and a stock that covers everything leaves a task of no build points that never completes: stalled, no time, never 0 days', () => {
    const over = yardRow({}, { stock: { 1: 9, 2: 9, 3: 9 } })

    return over.state === 'stalled' && over.bp === 0 && over.credit.bp === 104 && same(over.minerals, mins()) === true && over.days === null && over.firstDays === null && over.timeResult.status === 'unavailable' && over.reasons.some((text) => text.includes('never completes')) ? true : short(over)
  })
  add('stock: a stock that covers only the first task leaves that task with no build points and the yard stalled, whatever the other task needs', () => {
    const part = yardRow({}, { stock: { 1: 1, 2: 2, 3: 1 } })

    return part.state === 'stalled' && part.bp === 52 && part.days === null && part.timeResult.status === 'unavailable' ? true : short(part)
  })
  add('stock: the minerals the colony lacks are named; the stock\'s credit lowers what is short', () => {
    const lacking = yardRow({}, { stock: { 1: 1, 2: 3 }, minerals: stock({ Corbomite: 1 }) })

    return same(lacking.short, { Corbomite: 2 })
  })
  add('schedule: with one free slipway the platforms are built one after the other at the colony\'s rate for the class', () => {
    const row = yardRow({}, {}, 2, { slipways: 1 })

    return sameNumber(row.days, 104 / RATE * DAY) === true && near(row.firstDays, 52 / RATE * DAY) && row.state === 'capable' ? true : short(row)
  })
  add('schedule: with two free slipways two platforms are built side by side, so the time is one platform\'s', () => {
    const row = yardRow()

    return sameNumber(row.days, 52 / RATE * DAY) === true && near(row.firstDays, 52 / RATE * DAY) ? true : short(row)
  })
  add('schedule: three platforms on two slipways are two waves; the task made last takes the slipway that frees first', () => {
    const row = yardRow({}, {}, 3)

    return sameNumber(row.days, 104 / RATE * DAY) === true && near(row.firstDays, 52 / RATE * DAY) ? true : short(row)
  })
  add('schedule: tasks of unequal build points go to the slipway that frees first (a stock credit makes the first task short)', () => {
    const row = yardRow({}, { stock: { 1: 1, 2: 3 } }, 2, { slipways: 1 })

    return near(row.days, (2 + 32) / RATE * DAY) && near(row.firstDays, 2 / RATE * DAY) ? true : short(row)
  })
  add('schedule: a colony\'s slower build rate lengthens the time in proportion, and the rate is the shared shipyard rate', () => {
    const slow = yardRow({}, { modifiers: { ShipyardBuildRate: 500, ShipyardOperations: 1 } })
    const shared = m.refits.refitRate(f.MODIFIERS, PLAT)

    return near(slow.days, 52 / (RATE / 2) * DAY) && shared.value === RATE ? true : short([slow.days, shared])
  })
  add('yardstates: a yard whose slipways all work is busy: no time, it starts later, and the time left on its work is not guessed', () => {
    const row = yardRow({}, {}, 2, { tasks: 2 })

    return row.state === 'busy' && row.days === null && row.startsLater === true && row.slipways.free === 0 && row.timeResult.status === 'unavailable' && row.bp === 104 ? true : short(row)
  })
  add('yardstates: a yard with one slipway free of two builds on that one', () => {
    const row = yardRow({}, {}, 2, { tasks: 1 })

    return row.state === 'capable' && near(row.days, 104 / RATE * DAY) && row.slipways.free === 1 ? true : short(row)
  })
  add('retool: a yard tooled for another class adds its retool days to the time, and the first platform comes after them too', () => {
    const row = yardRow({}, {}, 2, { tooledId: 101 })
    const priced = m.refits.retoolCost({ tooling: f.FAR, target: PLAT, refit: m.refits.yardEligibility(yard({ tooledId: 101 }), PLAT, 'build', f.context).tooling.refit, slipways: 2, operations: 1, version: '2.7.1' })
    const days = priced.kind === 'immediate' ? 0 : m.provenance.valueOrNull(m.refits.retoolTime(f.MODIFIERS, yard({ tooledId: 101 }), priced.cost))

    return row.state === 'retool' && days > 0 && near(row.retoolDays, days) && near(row.days, days + 52 / RATE * DAY) && near(row.firstDays, days + 52 / RATE * DAY) ? true : short([row.state, row.retoolDays, row.days, days])
  })
  add('retool: a yard with no tooled class retools at once and free, so only the build time counts', () => {
    const row = yardRow({}, {}, 2, { tooledId: null })

    return row.state === 'retool' && row.retoolDays === 0 && near(row.days, 52 / RATE * DAY) ? true : short(row)
  })
  add('retool: a yard that belongs to a ship cannot be retooled: a class that needs one is ineligible with no time and wins no comparison; a yard whose origin is not read is unknown; a planetary yard keeps its retool estimate', () => {
    const ship = yardRow({}, {}, 2, { shipBased: true, tooledId: 101 })
    const shipNone = yardRow({}, {}, 2, { shipBased: true, tooledId: null })
    const shipTooled = yardRow({}, {}, 2, { shipBased: true, tooledId: 100 })
    const unread = yardRow({}, {}, 2, { shipBased: null, tooledId: 101 })
    const planetary = yardRow({}, {}, 2, { shipBased: false, tooledId: 101 })
    const line = compared({}, { shipBased: true, tooledId: 101 })[0]

    return [ship, shipNone].every((row) => row.state === 'ineligible' && row.days === null && row.bp === null && row.timeResult.status === 'unavailable' && row.reasons.some((text) => text.includes('cannot be retooled'))) && shipTooled.state === 'capable' && shipTooled.days !== null && unread.state === 'unknown' && unread.days === null && unread.missing.some((text) => text.includes('belongs to a ship')) && planetary.state === 'retool' && planetary.days !== null && line.yard === null && line.quicker === null && line.rateQuicker === null ? true : short([ship, shipNone, shipTooled.state, unread, planetary.state, line.yard])
  })
  add('retool: a yard that needs a retool and has no free slipway is busy: no time, it starts later, and the retool is told', () => {
    const row = yardRow({}, {}, 2, { tooledId: null, tasks: 2 })

    return row.state === 'busy' && row.days === null && row.startsLater === true && row.reasons.some((text) => text.includes('retool')) ? true : short(row)
  })
  add('yardstates: a repair yard cannot build, an unsupported yard type is not covered, and neither has a time or minerals', () => {
    const repair = yardRow({}, {}, 2, { type: 3 })
    const odd = yardRow({}, {}, 2, { type: 4 })

    return repair.state === 'ineligible' && odd.state === 'unsupported' && [repair, odd].every((row) => row.days === null && row.minerals === null && row.bp === null && row.timeResult.status === 'unavailable') ? true : short([repair, odd])
  })
  add('yardstates: a yard of a type the save does not give is unknown, naming it', () => {
    const row = yardRow({}, {}, 2, { type: null })

    return row.state === 'unknown' && row.days === null && row.missing.length > 0 ? true : short(row)
  })
  add('yardstates: a yard path does not depend on the class being armourless: a class with armour is still built by a yard', () => {
    const row = rowOf(run({ noArmour: false }), 'yard')

    return row.state === 'capable' && row.days !== null ? true : short(row)
  })

  // ----- what is not read -----
  add('unread: a colony the read has no modifiers for leaves the yard\'s time unavailable and named, never 0', () => {
    const row = yardRow({}, { modifiers: undefined })

    return row.state === 'capable' && row.days === null && row.timeResult.status === 'unavailable' && row.timeResult.inputs.missing.some((text) => text.includes('rate')) && row.bp === 104 ? true : short(row)
  })
  add('unread: a save with no component stock leaves the credit, the build points and the time of a yard unknown; the industry, which uses none, is not held up', () => {
    const result = run({ colonies: { 7: colony({ stock: null }) } })
    const row = rowOf(result, 'yard')
    const industryRow = rowOf(result, 'industry')

    return row.days === null && row.bp === null && row.minerals === null && row.timeResult.status === 'unavailable' && industryRow.state === 'capable' && industryRow.days !== null ? true : short([row, industryRow.state])
  })
  add('unread: a stored component of an amount the save leaves out makes the credit unknown, not 0 held', () => {
    const row = yardRow({}, { stock: { 1: null } })

    return row.days === null && row.bp === null && row.timeResult.status === 'unavailable' ? true : short(row)
  })
  add('unread: a colony\'s projects the save does not give leave the industry unknown and named, never a free colony', () => {
    const row = industry({ projects: null })

    return row.state === 'unknown' && row.days === null && row.missing.some((text) => text.includes('projects')) ? true : short(row)
  })
  add('unread: a colony absent from the read has every figure unknown, the yard and the industry both', () => {
    const result = run({ colonies: {} })
    const row = rowOf(result, 'yard')
    const industryRow = rowOf(result, 'industry')

    return row.days === null && industryRow.state === 'unknown' && industryRow.days === null && industryRow.labour.millions === null && result.comparison.length === 1 && result.comparison[0].quicker === null ? true : short([row.days, industryRow])
  })
  add('unread: a mineral stock the colony does not give leaves what is short unknown, not none', () => same([yardRow({}, { minerals: null }).short, yardRow({}, { minerals: stock({ Duranium: null }) }).short], [null, null]))

  // ----- the labour -----
  add('labour: a naval yard holds its slipways times its capacity over 4000 workers (millions), a commercial yard a tenth of that, a platform adding none', () => {
    const naval = yardRow({}, {}, 1)
    const naval5 = yardRow({}, {}, 5)
    const commercial = yardRow({}, {}, 2, { type: 2, tooledId: 100, capacity: 2000 })

    return near(naval.labour.millions, 2 * 1000 / 4000) && near(naval5.labour.millions, naval.labour.millions) && near(m.workforce.yardWorkers(2, 2000, 2), 2 * 2000 * 0.1 / 4000) && commercial.labour.millions === m.workforce.yardWorkers(2, 2000, 2) ? true : short([naval.labour, commercial.labour])
  })
  add('labour: the industry holds the workers its construction factories need, and a colony whose installations are not read has none known, never 0', () => {
    const known = industry()
    const unread = industry({ factories: null })

    return near(known.labour.millions, 0.5) && unread.labour.millions === null && unread.labour.result.status === 'unavailable' && known.labour.result.status === 'confirmed' ? true : short([known.labour, unread.labour])
  })
  add('labour: a yard that belongs to a ship holds no colony workers (0, never the formula); a yard known to be planetary holds the formula; a yard whose origin is not read has none known', () => {
    const ship = yardRow({}, {}, 2, { shipBased: true })
    const planetary = yardRow({}, {}, 2, { shipBased: false })
    const unread = yardRow({}, {}, 2, { shipBased: null })
    const absent = yardRow({}, {}, 2, { shipBased: undefined })

    return ship.labour.millions === 0 && ship.labour.result.status === 'confirmed' && near(planetary.labour.millions, 2 * 1000 / 4000) && [unread, absent].every((row) => row.labour.millions === null && row.labour.result.status === 'unavailable' && row.labour.text.includes('belongs to a ship')) ? true : short([ship.labour, planetary.labour, unread.labour, absent.labour])
  })

  // ----- the components the race has not researched -----
  const ALIEN = { 1: 1, 2: 0, 3: 1 }
  const withAlien = (over = {}, quantity = 2) => run({ researched: ALIEN, quantity, colonies: { 7: colony(over) } })

  add('alien: a yard task takes its alien components from the colony\'s own stock, so the stock must hold them for every platform asked, and the colony without them cannot build', () => {
    const none = rowOf(withAlien(), 'yard')
    const short1 = rowOf(withAlien({ stock: { 2: 3 } }), 'yard')
    const enough = rowOf(withAlien({ stock: { 2: 4 } }), 'yard')
    const one = rowOf(withAlien({ stock: { 2: 2 } }, 1), 'yard')

    return [none, short1].every((row) => row.state === 'ineligible' && row.days === null && row.bp === null && row.reasons.some((text) => text.includes('Mining module') && text.includes('not researched'))) && short1.reasons.some((text) => text.includes('holds 3 of the 4')) && enough.state === 'capable' && enough.bp === 24 && enough.days !== null && one.state === 'capable' ? true : short([none, short1, enough, one])
  })
  add('alien: the industry route needs one hull\'s alien components in the colony\'s stock whatever the quantity, and neither uses them up nor credits them', () => {
    const none = rowOf(withAlien(), 'industry')
    const less = rowOf(withAlien({ stock: { 2: 1 } }), 'industry')
    const hull = rowOf(withAlien({ stock: { 2: 2 } }, 5), 'industry')

    return [none, less].every((row) => row.state === 'ineligible' && row.days === null && row.reasons.some((text) => text.includes('Mining module') && text.includes('one hull'))) && hull.state === 'capable' && hull.bp === 260 && hull.credit === null && hull.days !== null ? true : short([none, less, hull])
  })
  add('alien: a component the race has researched needs no stock, whatever the colony holds', () => {
    const result = run({ researched: { 1: 1, 2: 1, 3: 1 }, colonies: { 7: colony({ stock: {} }) } })

    return rowOf(result, 'yard').state === 'capable' && rowOf(result, 'industry').state === 'capable' ? true : short(result.rows)
  })
  add('alien: a research the save cannot say, a stock it does not hold or an amount it leaves out leaves both paths unknown and named, never capable and never closed', () => {
    const results = [run({ researched: null }), run({ researched: { 1: 1, 2: null, 3: 1 } }), run({ researched: { 1: 1, 3: 1 } }), run({ researched: ALIEN, colonies: { 7: colony({ stock: null }) } }), run({ researched: ALIEN, colonies: { 7: colony({ stock: { 2: null } }) } })]

    return results.every((result) => ['yard', 'industry'].every((path) => { const row = rowOf(result, path); return row.state === 'unknown' && row.days === null && row.timeResult.status === 'unavailable' && row.missing.length > 0 })) ? true : short(results.map((result) => result.rows.map((row) => [row.path, row.state])))
  })
  add('alien: a known blocker of the alien stock beats a gap elsewhere', () => {
    const result = run({ researched: { 1: 1, 2: 0, 3: null } })

    return rowOf(result, 'yard').state === 'ineligible' && rowOf(result, 'industry').state === 'ineligible' ? true : short(result.rows.map((row) => [row.path, row.state]))
  })

  // ----- a path that makes no progress -----
  add('stalled: a colony whose shipbuilding output is 0 makes no progress: no time and no infinite one', () => {
    const row = yardRow({}, { modifiers: { ShipyardBuildRate: 0, ShipyardOperations: 1 } })

    return row.state === 'stalled' && row.days === null && row.firstDays === null && row.timeResult.status === 'unavailable' && row.reasons.some((text) => text.includes('output')) && finiteAll(withoutEligibility(row)) ? true : short(row)
  })
  add('stalled: a class whose build points are 0 gives the industry no time, named as the class\'s cost, never 0 days', () => {
    const row = industry({}, 2, cls(5, { cost: 0, counts: { 1: 1 } }))

    return row.days === null && row.state === 'unknown' && row.timeResult.status === 'unavailable' && row.missing.some((text) => text.includes('cost')) ? true : short(row)
  })

  // ----- the comparison -----
  const compared = (colonyOver = {}, yardOver = {}, quantity = 2) => run({ quantity, yards: [yard(yardOver)], colonies: { 7: colony(colonyOver) } }).comparison

  add('compare: at one colony the quicker path is named from its two times: the yard at a small capacity, the industry at a large one, the same at an equal one', () => {
    const slowIndustry = compared()[0]
    const fastIndustry = compared({ capacity: capacity(3000) })[0]
    const equal = compared({ capacity: capacity(1100) })[0]

    return same([slowIndustry.quicker, fastIndustry.quicker, equal.quicker], ['yard', 'industry', 'same']) === true && near(slowIndustry.yard.days, 52 / RATE * DAY) && near(fastIndustry.industry.days, 104 / 3000 * DAY) ? true : short([slowIndustry.quicker, fastIndustry.quicker, equal.quicker])
  })
  add('compare: a time that is not known on either side gives no verdict, never the other path by default', () => {
    const busy = compared({}, { tasks: 2 })[0]
    const noCapacity = compared({ capacity: unknownCapacity })[0]
    const full = compared({ projects: [{ ProductionType: 0, Queue: 0, Percentage: 100 }] })[0]
    const bothUnknown = compared({ capacity: unknownCapacity }, { tasks: 2 })[0]

    return [busy, noCapacity, full, bothUnknown].every((line) => line.quicker === null && line.rateQuicker === null && line.supply === 'unknown') && busy.yard === null && noCapacity.industry.days === null ? true : short([busy.quicker, noCapacity.quicker, full.quicker])
  })
  add('compare: the colony\'s quickest yard stands for its yards, and the yards of another colony are not mixed in', () => {
    const result = run({ yards: [yard({ id: 1, slipways: 1 }), yard({ id: 2, slipways: 2 }), yard({ id: 3, populationId: 8, colony: 'Beta', slipways: 4 })], colonies: { 7: colony(), 8: colony({ name: 'Beta', capacity: capacity(1e9) }) } })
    const alpha = result.comparison.find((line) => line.populationId === 7)
    const beta = result.comparison.find((line) => line.populationId === 8)

    return alpha.yard.yardId === 2 && beta.yard.yardId === 3 && alpha.quicker === 'yard' && beta.quicker === 'industry' && result.comparison.length === 2 ? true : short([alpha.yard.yardId, beta.yard.yardId, alpha.quicker, beta.quicker])
  })
  add('compare: no path is named cheaper or quicker over the whole race: the verdict is a field of one colony\'s line and nothing else carries one', () => {
    const result = run()
    const flat = JSON.stringify(Object.keys(result)) + JSON.stringify(result.rows.map((row) => Object.keys(row))) + JSON.stringify(result.comparison.map((line) => Object.keys(line)))

    return same(Object.keys(result), ['invalid', 'recipe', 'station', 'rows', 'comparison']) === true && !/best|cheap|winner|overall/i.test(flat) && result.comparison.every((line) => ['populationId', 'colony', 'yards', 'yard', 'industry', 'supply', 'quicker', 'rateQuicker'].every((key) => key in line)) ? true : flat
  })
  add('compare: a verdict on a colony\'s stock needs both routes covered: where the minerals lack for the quicker route only, the rate order is told apart and no verdict is named', () => {
    const result = run({ yards: [yard()], colonies: { 7: colony({ capacity: capacity(3000), stock: { 1: 1, 2: 3 }, minerals: stock({ Corbomite: 3 }) }) } })
    const line = result.comparison[0]

    return line.supply === 'short' && line.rateQuicker === 'industry' && line.quicker === null && same(line.yard.short, {}) === true && line.industry.short.Corbomite === 9 ? true : short([line.supply, line.rateQuicker, line.quicker, line.yard.short, line.industry.short])
  })
  add('compare: an unread mineral stock gives no verdict on the stock either, the rate order still told apart; both covered gives the verdict', () => {
    const unread = run({ colonies: { 7: colony({ minerals: null }) } }).comparison[0]
    const covered = run().comparison[0]

    return same([unread.supply, unread.quicker, unread.rateQuicker, covered.supply, covered.quicker, covered.rateQuicker], ['unknown', null, 'yard', 'covered', 'yard', 'yard']) === true ? true : short([unread.supply, unread.quicker, covered.supply, covered.quicker])
  })
  add('compare: a colony\'s lines list every yard of it, beside the quickest one', () => {
    const result = run({ yards: [yard({ id: 1, slipways: 1 }), yard({ id: 2, slipways: 2, tasks: 2 })] })
    const line = result.comparison[0]

    return line.yards.length === 2 && line.yard.yardId === 1 && line.yards.some((row) => row.yardId === 2 && row.state === 'busy') ? true : short(line.yards)
  })
  add('rows: a colony whose installations are not stored in full has an industry row that is unknown, not dropped and not closed', () => {
    const result = run({ yards: [yard()], colonies: { 7: colony(), 11: colony({ name: 'Epsilon', spaceports: null, factories: null, installationUnknown: true }), 12: colony({ name: 'Zeta', spaceports: null, factories: null }) } })
    const row = rowOf(result, 'industry', 11)

    return row && row.state === 'unknown' && row.days === null && !rowOf(result, 'industry', 12) ? true : short(result.rows.map((r) => [r.path, r.populationId, r.state]))
  })
  add('rows: every shipyard and every colony with a spaceport or construction factories has a row, a colony with neither has none', () => {
    const result = run({ yards: [yard()], colonies: { 7: colony(), 8: colony({ name: 'Beta', spaceports: 0, factories: { workers: 0.2 } }), 9: colony({ name: 'Gamma', spaceports: 1, factories: { workers: 0 } }), 10: colony({ name: 'Delta', spaceports: 0, factories: { workers: 0 } }) } })
    const ids = result.rows.filter((row) => row.path === 'industry').map((row) => row.populationId).sort((a, b) => a - b)

    return same([ids, result.rows.filter((row) => row.path === 'yard').length], [[7, 8, 9], 1])
  })
  add('rows: the row keys are unique and the rows of a yard and an industry of one colony are told apart', () => {
    const result = run({ yards: [yard({ id: 1 }), yard({ id: 2 })] })
    const keys = result.rows.map((row) => row.key)

    return new Set(keys).size === keys.length && keys.length === 3 ? true : short(keys)
  })
  add('invalid: a quantity above the most one comparison takes, written with an exponent or not, gives no row and no work, and the most itself is taken', () => {
    const most = pp.MAX_PLATFORMS
    const began = Date.now()
    const over = [most + 1, 1e9, 1e20, Infinity].map((quantity) => run({ quantity }))
    const edge = run({ quantity: most })

    return over.every((result) => result.invalid === 'the number of platforms' && result.rows.length === 0 && result.comparison.length === 0) && edge.invalid === null && edge.rows.length === 2 && Date.now() - began < 5000 ? true : short([over.map((result) => result.invalid), edge.invalid, Date.now() - began])
  })
  add('invalid: a quantity that is not a whole number of 1 or more gives no row and names the field', () => {
    const results = [0, -1, 1.5, null, '2', NaN].map((quantity) => run({ quantity }))

    return results.every((result) => result.invalid === 'the number of platforms' && result.rows.length === 0 && result.comparison.length === 0) && run({ quantity: 1 }).invalid === null ? true : short(results.map((result) => result.invalid))
  })
  add('provenance: every figure is a result of its rule, the time unavailable where it is not known', () => {
    const result = run({ yards: [yard({ id: 1 }), yard({ id: 2, tasks: 2 })] })
    const [first, second] = result.rows.filter((row) => row.path === 'yard')
    const industryRow = rowOf(result, 'industry')

    return same([ruleOf(first.timeResult), first.timeResult.status, ruleOf(second.timeResult), second.timeResult.status, ruleOf(industryRow.timeResult), industryRow.timeResult.status, ruleOf(first.labour.result), ruleOf(result.recipe.result)], ['platformPaths.yard', 'estimated', 'platformPaths.yard', 'unavailable', 'platformPaths.industry', 'estimated', 'platformPaths.labour', 'platformPaths.recipe'])
  })
  add('provenance: no figure of any row is not a finite number or null', () => {
    const result = run({ yards: [yard({ id: 1 }), yard({ id: 2, tasks: 2 }), yard({ id: 3, tooledId: 101 })], colonies: { 7: colony({ stock: { 1: 1, 2: 3 } }) } })

    return finiteAll(result.rows.map(withoutEligibility)) ? true : 'a figure is NaN or infinite'
  })

  return statements
}

// ---------- the saves ----------

const rawQuery = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
  const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
  const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

  raw.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve([rows])))
})

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)
    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)
      return
    }

    resolve({ file: path.basename(resolved), query: rawQuery(raw), close: () => raw.close() })
  })
})

const rowsOf = async (database, sql, replacements = {}) => (await database.query(sql, { replacements }))[0]

const saveStatements = async (ctx, save) => {
  const { m } = ctx
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const scope = { GameID: save.game, RaceID: save.race }
  const label = path.basename(save.file)
  const read = await m.pp.loadPlatformSources(database, scope)
  const { classes, components } = await m.refits.loadRefitClasses(database, scope)
  const yards = await m.refits.loadYards(database, scope)
  const where = 'GameID = :GameID and RaceID = :RaceID'
  const [{ n: classCount }] = await rowsOf(database, `select count(*) as n from FCT_ShipClass where ${where}`, scope)
  const [{ n: miningCount }] = await rowsOf(database, `select count(*) as n from FCT_ShipClass where ${where} and MiningModules > 0`, scope)
  const [{ n: noArmourCount }] = await rowsOf(database, `select count(*) as n from FCT_ShipClass where ${where} and NoArmour = 1`, scope)
  const spaceports = await rowsOf(database, `select PopID, sum(Amount) as n from FCT_PopulationInstallations where PlanetaryInstallationID in (select PlanetaryInstallationID from DIM_PlanetaryInstallation where Name = 'Spaceport') and PopID in (select PopulationID from FCT_Population where ${where}) group by PopID`, scope)
  const factories = await rowsOf(database, `select PopID, sum(Amount * Workers) as w from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where ConstructionValue > 0 and PopID in (select PopulationID from FCT_Population where ${where}) group by PopID`, scope)
  const [{ n: projectCount }] = await rowsOf(database, `select count(*) as n from FCT_IndustrialProjects where ${where}`, scope)
  const [{ n: stationCount }] = await rowsOf(database, `select count(*) as n from FCT_IndustrialProjects where ${where} and ProductionType = 4`, scope)
  const [{ n: stockRows }] = await rowsOf(database, `select count(*) as n from FCT_PopComponent where PopulationID in (select PopulationID from FCT_Population where ${where})`, scope)
  const populations = await rowsOf(database, `select PopulationID, PopName from FCT_Population where ${where}`, scope)
  const stored = await rowsOf(database, `select ProductionID, Amount, ProdPerUnit, ${m.minerals.MINERALS.map(({ name }) => name).join(', ')} from FCT_IndustrialProjects where ${where} and ProductionType = 4`, scope)
  const [{ n: componentCount }] = await rowsOf(database, `select count(distinct ComponentID) as n from FCT_ClassComponent where ClassID in (select ShipClassID from FCT_ShipClass where ${where})`, scope)
  const stations = await rowsOf(database, `select ShipClassID, Cost from FCT_ShipClass where ${where} and NoArmour = 1 and MiningModules > 0 and Obsolete = 0 order by Size desc`, scope)
  const classById = Object.fromEntries(classes.map((shipClass) => [shipClass.id, shipClass]))
  const context = { classesById: classById, components, version: '2.7.1', cache: new Map() }
  const modifiers = { ShipyardBuildRate: 1000, ShipyardOperations: 1 }
  const capacity = m.provenance.ofRule({ rule: 'platformPaths.industry', value: 1000, inputs: { present: ['capacity'] }, units: 'BP/yr' })
  const colonies = Object.fromEntries(Object.entries(read.colonies).map(([id, colony]) => [id, { ...colony, modifiers, capacity }]))
  const statements = []
  const add = (name, test, detail = '') => statements.push([name, test, detail])
  const ids = (list) => list.map((row) => Number(row.PopID)).sort((a, b) => a - b)

  const mismatches = classes.filter((shipClass) => {
    const parts = Object.entries(shipClass.counts)
    const known = parts.every(([id]) => components[id] && typeof components[id].cost === 'number')

    return known && Math.abs(parts.reduce((sum, [id, count]) => sum + count * components[id].cost, 0) - shipClass.cost) > 0.01
  })
  const matched = stored.filter((row) => {
    const shipClass = classById[row.ProductionID]

    if (!shipClass) {
      return false
    }

    const recipe = m.pp.recipeOf(shipClass, components)

    return recipe.minerals !== null && Math.abs(recipe.bp - row.ProdPerUnit) < 1e-6 && m.minerals.MINERALS.every(({ name }) => Math.abs(recipe.minerals[name] - row[name]) < 1e-6)
  })
  const target = stations.length ? classById[stations[0].ShipClassID] : null
  const run = (shipClass, quantity) => m.pp.comparePaths({ shipClass, noArmour: read.extras[shipClass.id].noArmour, components, researched: read.researched, quantity, yards, colonies, context, version: '2.7.1' })

  add(`save-extras: ${label}: every class of the race has its armour setting and mining modules read, as the raw rows count`, () => same([Object.keys(read.extras).length, Object.values(read.extras).filter((extra) => extra.miningModules > 0).length, Object.values(read.extras).filter((extra) => extra.noArmour === true).length], [classCount, miningCount, noArmourCount]))
  add(`save-spaceports: ${label}: the colonies with a spaceport are those the raw installations name, with their count`, () => {
    const loaded = Object.entries(read.colonies).filter(([, colony]) => colony.spaceports > 0).map(([id]) => Number(id)).sort((a, b) => a - b)

    return same([loaded, Object.entries(read.colonies).filter(([, colony]) => colony.spaceports > 0).reduce((sum, [, colony]) => sum + colony.spaceports, 0)], [ids(spaceports.filter((row) => row.n > 0)), spaceports.reduce((sum, row) => sum + row.n, 0)])
  })
  add(`save-factories: ${label}: a colony's construction workers are the raw sum of its factories' workers`, () => {
    const bad = factories.filter((row) => !near(read.colonies[row.PopID] && read.colonies[row.PopID].factories.workers, row.w, 1e-9))

    return bad.length ? short(bad.slice(0, 3)) : true
  })
  add(`save-projects: ${label}: every project of the race is read once, the Space station projects among them`, () => {
    const all = Object.values(read.colonies).flatMap((colony) => colony.projects || [])

    return same([all.length, all.filter((project) => project.ProductionType === 4).length], [projectCount, stationCount])
  })
  add(`save-stock: ${label}: the component stock rows are read and a colony with no row holds none`, () => {
    const rows = Object.values(read.colonies).reduce((sum, colony) => sum + Object.keys(colony.stock).length, 0)

    return same([read.stockRead, rows === stockRows, populations.every((row) => read.colonies[row.PopulationID] && read.colonies[row.PopulationID].name === row.PopName)], [true, true, true])
  })
  add(`save-researched: ${label}: every component of the race's classes is read once as researched, not researched or not known, as the raw rows count`, () => same([Object.keys(read.researched).length, Object.values(read.researched).every((value) => value === 1 || value === 0 || value === null)], [componentCount, true]))
  add(`save-recipe: ${label}: the class's stored cost is the sum of its components' costs times their counts, in every class`, () => (mismatches.length ? `${mismatches.length} of ${classes.length} differ, such as ${short(mismatches.slice(0, 2).map((shipClass) => shipClass.name))}` : true), `${classes.length} classes`)
  add(`save-stored: ${label}: the stored Space station projects of unchanged classes repeat the recipe's build points and minerals exactly`, () => (matched.length >= save.stored ? true : `${matched.length} of ${stored.length} projects match, ${save.stored} expected`), `${matched.length} of ${stored.length} match; the rest were made before their class was changed`)
  add(`save-paths: ${label}: a mining platform class has a yard row for every yard and an industry row for every colony with a spaceport, factories or a yard, each with a real number or no time`, () => {
    if (!target) {
      return true
    }

    const result = run(target, 3)
    const industryIds = new Set(result.rows.filter((row) => row.path === 'industry').map((row) => row.populationId))
    const expected = new Set([...Object.entries(read.colonies).filter(([, colony]) => colony.spaceports > 0 || colony.factories.workers > 0 || colony.installationUnknown).map(([id]) => Number(id)), ...yards.map((yard) => yard.populationId)])

    return same([result.rows.filter((row) => row.path === 'yard').length, [...industryIds].sort((a, b) => a - b)], [yards.length, [...expected].sort((a, b) => a - b)]) === true && finiteAll(result.rows.map(withoutEligibility)) && new Set(result.rows.map((row) => row.key)).size === result.rows.length ? true : 'rows or numbers differ'
  }, target ? `class ${target.name}` : 'no mining class')
  add(`save-paths: ${label}: the same quantity has a time for each eligible path and a blocker for the ones that cannot, and the armoured classes are refused by the industry`, () => {
    if (!target) {
      return true
    }

    const result = run(target, 3)
    const timed = result.rows.filter((row) => ['capable', 'retool'].includes(row.state))
    const armoured = classes.find((shipClass) => read.extras[shipClass.id].noArmour === false)
    const refused = armoured ? run(armoured, 1).rows.filter((row) => row.path === 'industry') : []

    const noTime = timed.filter((row) => !(row.days !== null && row.days >= 0 && row.bp >= 0 && row.minerals !== null && row.labour.millions !== null))
    const timeless = result.rows.filter((row) => !['capable', 'retool', 'busy'].includes(row.state) && row.days !== null)
    const open = refused.filter((row) => !(row.state === 'ineligible' && row.reasons.some((text) => text.includes('armour'))))

    const brief = (rows) => rows.slice(0, 3).map((row) => ({ key: row.key, state: row.state, days: row.days, bp: row.bp, retool: row.retoolDays, why: row.timeResult.inputs.missing }))

    return noTime.length || timeless.length || open.length ? short({ noTime: brief(noTime), timeless: brief(timeless), open: brief(open), armoured: armoured && armoured.name }) : true
  })
  add(`save-paths: ${label}: the quicker path of each colony is the one with the shorter time of its two`, () => {
    if (!target) {
      return true
    }

    const bad = run(target, 3).comparison.filter((line) => line.quicker !== null && ((line.quicker === 'yard') !== (line.yard.days < line.industry.days - 1e-9) && line.quicker !== 'same'))

    return bad.length ? short(bad.map((line) => line.colony)) : true
  })

  return { skipped: false, statements, database, close: () => database.close() }
}

// ---------- the loader, on an in-memory save that is always there ----------

const execOf = (raw, sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

// The tables the loader reads, with the rows worked by hand: classes 10 (armourless, two mining modules), 11 (armoured), 13 (settings not stored) of race 1 and 12 of race 2; colonies 1 to 8 of race 1 whose installations are in full (1), a spaceport amount not stored (2), a stored spaceport beside one not stored (3), a factory amount not stored (4), a factory without a worker figure (5), an installation of no type (6), a zero of an installation of no type (7) and none (8). Component 102 of class 10 has no research row of race 1.
// Colonies 10 to 14 of race 1 hold installations of unknown identity: a definition with no name (10), a definition the table lacks (11), no installation id (12), a stored spaceport beside a definition with no name (13) and a zero of one with no name (14). The installations come whole ('rows'), as a table with no row ('empty'), or the table of the installations ('absent') or the one of their definitions ('nodim') is not in the save.
const loaderSql = (names, tech, installs = 'rows') => `
create table FCT_ShipClass (ShipClassID integer, GameID integer, RaceID integer, NoArmour integer, MiningModules integer);
insert into FCT_ShipClass values (10, 1, 1, 1, 2), (11, 1, 1, 0, 0), (12, 1, 2, 1, 0), (13, 1, 1, null, null);
create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, ${names.map((name) => `${name} real`).join(', ')});
insert into FCT_Population (PopulationID, GameID, RaceID, PopName, Duranium) values (1, 1, 1, 'Pop 1', 5), (2, 1, 1, 'Pop 2', null), (3, 1, 1, 'Pop 3', null), (4, 1, 1, 'Pop 4', null), (5, 1, 1, 'Pop 5', null), (6, 1, 1, 'Pop 6', null), (7, 1, 1, 'Pop 7', null), (8, 1, 1, 'Pop 8', null), (9, 1, 2, 'Pop 9', 1), (10, 1, 1, 'Pop 10', null), (11, 1, 1, 'Pop 11', null), (12, 1, 1, 'Pop 12', null), (13, 1, 1, 'Pop 13', null), (14, 1, 1, 'Pop 14', null);
create table FCT_PopComponent (PopulationID integer, ComponentID integer, Amount integer);
insert into FCT_PopComponent values (1, 100, 3), (1, 101, null), (9, 100, 7);
create table FCT_IndustrialProjects (PopulationID integer, GameID integer, RaceID integer, ProductionType integer, Queue integer, Percentage real);
insert into FCT_IndustrialProjects values (1, 1, 1, 4, 0, 30), (9, 1, 2, 4, 0, 50);
${installs === 'nodim' ? '' : 'create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, Name text, Workers real, ConstructionValue real);'}
${installs === 'nodim' ? '' : 'insert into DIM_PlanetaryInstallation values (1, \'Spaceport\', 0.01, 0), (2, \'Construction Factory\', 0.5, 10), (3, \'Mine\', 0.2, 0), (4, \'Factory B\', null, 10), (5, \'Mystery\', null, null), (6, null, 0.1, 0);'}
${installs === 'absent' ? '' : 'create table FCT_PopulationInstallations (PopID integer, PlanetaryInstallationID integer, Amount integer);'}
${installs === 'rows' || installs === 'nodim' ? 'insert into FCT_PopulationInstallations values (1, 1, 2), (1, 2, 4), (1, 3, 10), (2, 1, null), (3, 1, null), (3, 1, 1), (4, 2, null), (5, 4, 3), (6, 5, 2), (7, 5, 0), (7, 3, 1), (9, 1, 9), (10, 6, 2), (11, 99, 1), (12, null, 1), (13, 1, 1), (13, 6, 1), (14, 6, 0);' : ''}
create table FCT_ClassComponent (ClassID integer, ComponentID integer);
insert into FCT_ClassComponent values (10, 100), (10, 101), (10, 102), (11, 100), (12, 103), (13, 101);
${tech === 'absent' ? '' : 'create table FCT_RaceTech (TechID integer, RaceID integer);'}
${tech === 'rows' ? 'insert into FCT_RaceTech values (100, 1), (101, 1), (103, 2);' : ''}
`

const loaded = async (m, tech, installs) => {
  const raw = new sqlite3.Database(':memory:')

  try {
    await execOf(raw, loaderSql(m.minerals.MINERALS.map(({ name }) => name), tech, installs))

    return await m.pp.loadPlatformSources({ query: rawQuery(raw) }, { GameID: 1, RaceID: 1 })
  } finally {
    raw.close()
  }
}

const loader = (ctx) => {
  const { m } = ctx
  const statements = []
  const reads = {}
  const read = (tech = 'rows', installs = 'rows') => (reads[`${tech}/${installs}`] = reads[`${tech}/${installs}`] || loaded(m, tech, installs))
  const add = (name, test) => statements.push([name, test])

  add('loader: the race\'s classes only, each with its armour setting read the right way, its mining modules, and a setting the save leaves out as not known', async () => same((await read()).extras, { 10: { noArmour: true, miningModules: 2 }, 11: { noArmour: false, miningModules: 0 }, 13: { noArmour: null, miningModules: null } }))
  add('loader: the colonies of the race only, each with its name, its minerals, its projects and its component stock as the rows give them', async () => {
    const { colonies } = await read()

    return same([Object.keys(colonies).length, colonies[1].name, colonies[1].minerals.Duranium, colonies[1].minerals.Neutronium, colonies[1].projects.length, colonies[1].stock, colonies[2].stock], [13, 'Pop 1', 5, null, 1, { 100: 3, 101: null }, {}])
  })
  add('loader: the spaceports are the installations named Spaceport, whatever else the colony holds', async () => {
    const { colonies } = await read()

    return same([colonies[1].spaceports, colonies[7].spaceports, colonies[8].spaceports], [2, 0, 0])
  })
  add('loader: the construction workers are each factory\'s amount times its workers, the other installations leaving them out', async () => {
    const { colonies } = await read()

    return same([colonies[1].factories.workers, colonies[7].factories.workers, colonies[8].factories.workers], [2, 0, 0])
  })
  add('loader: a spaceport amount the save leaves out is not known, never 0, and the colony says its installations are not in full', async () => {
    const { colonies } = await read()

    return same([colonies[2].spaceports, colonies[2].installationUnknown], [null, true])
  })
  add('loader: a spaceport known above 0 stands against one not stored, the colony still marked', async () => {
    const { colonies } = await read()

    return same([colonies[3].spaceports, colonies[3].installationUnknown], [1, true])
  })
  add('loader: a factory without an amount, one without a worker figure and an installation of no type leave the workers not known, never a sum short of them', async () => {
    const { colonies } = await read()

    return same([4, 5, 6].map((id) => [colonies[id].factories.workers, colonies[id].installationUnknown]), [[null, true], [null, true], [null, true]])
  })
  add('loader: colonies whose installations are stored in full, or are none, are not marked, and a zero of an installation of no type is no gap', async () => {
    const { colonies } = await read()

    return same([1, 7, 8].map((id) => colonies[id].installationUnknown), [false, false, false])
  })
  add('loader: a component of the race\'s classes is researched (1), not researched (0), and not known (null) where the race has no research rows or the save has no such table', async () => {
    const some = (await read('rows')).researched
    const empty = (await read('empty')).researched
    const absent = (await read('absent')).researched

    return same([some, empty, absent], [{ 100: 1, 101: 1, 102: 0 }, { 100: null, 101: null, 102: null }, { 100: null, 101: null, 102: null }])
  })
  add('loader: an installation whose identity is not known (a definition with no name, a definition the table lacks, no installation id) could be a spaceport or a factory: the spaceports and workers are not known, never 0, and the colony is marked', async () => {
    const { colonies } = await read()

    return same([10, 11, 12].map((id) => [colonies[id].spaceports, colonies[id].factories.workers, colonies[id].installationUnknown]), [[null, 0, true], [null, null, true], [null, null, true]])
  })
  add('loader: a stored spaceport stands against an installation of unknown identity, and a zero of one is no gap', async () => {
    const { colonies } = await read()

    return same([13, 14].map((id) => [colonies[id].spaceports, colonies[id].installationUnknown]), [[1, true], [0, false]])
  })
  add('loader: installations the save does not hold, whether the table or the definitions are missing, are not known for every colony, and a table with no row is none, which is another thing', async () => {
    const absent = (await read('rows', 'absent')).colonies
    const nodim = (await read('rows', 'nodim')).colonies
    const empty = (await read('rows', 'empty')).colonies
    const unread = (colonies) => Object.values(colonies).every((colony) => colony.spaceports === null && colony.factories === null && colony.installationUnknown === true)

    return unread(absent) && unread(nodim) && Object.keys(absent).length === 13 && Object.values(empty).every((colony) => colony.spaceports === 0 && colony.factories.workers === 0 && colony.installationUnknown === false) ? true : short([absent[1], nodim[1], empty[1]])
  })
  add('loader: through the comparison, the colonies with no yard whose installations are not in the save keep an unknown industry row, and a readable empty table gives none', async () => {
    const f = fixtures(m)
    const through = async (installs) => {
      const { colonies } = await read('rows', installs)
      const merged = Object.fromEntries(Object.entries(colonies).map(([id, colony]) => [id, { ...colony, modifiers: f.MODIFIERS, capacity: f.capacity(1000), stock: {} }]))

      return m.pp.comparePaths({ shipClass: f.PLAT, noArmour: true, components: f.components, researched: f.RESEARCHED, quantity: 1, yards: [], colonies: merged, context: f.context, version: '2.7.1' }).rows
    }
    const absent = await through('absent')
    const empty = await through('empty')

    return absent.length === 13 && absent.every((row) => row.path === 'industry' && row.state === 'unknown' && row.days === null && row.missing.some((text) => text.includes('spaceport'))) && empty.length === 0 ? true : short([absent.length, absent[0], empty.length])
  })

  return statements
}

// ---------- the panel and the page ----------

const BASE = { classes: [], extras: {}, components: {}, yards: [], colonies: {}, context: {}, version: null }

const panel = (ctx) => {
  const { m, componentText } = ctx
  const f = fixtures(m)
  const { PLAT, FAR, components, cls, colony, yard, context, capacity } = f
  const mount = (data = {}) => instantiate(ctx.options, { $store: { getters: {}, state: {} }, data: { ...BASE, ...data } })
  const mining = cls(100, { name: 'Platform' })
  const plain = cls(102, { name: 'Alpha ship' })
  const props = (over = {}) => ({ classes: [plain, mining, FAR], extras: { 100: { noArmour: true, miningModules: 2 }, 101: { noArmour: false, miningModules: 0 }, 102: { noArmour: false, miningModules: null } }, components, yards: [yard()], colonies: { 7: colony() }, context: { ...context, classesById: { 100: PLAT, 101: FAR, 102: plain } }, version: '2.7.1', researched: f.RESEARCHED, classId: 100, quantity: '2', ...over })
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const summary = (text) => (text.match(/<v-card class="panel[^"]*" data-summary="([^"]*)"/) || [])[1] || ''
  const tag = (text, name) => (text.match(new RegExp(`<${name}\\b[^>]*>`)) || [''])[0]

  add('panel: the classes are offered with the mining platforms first, marked, then the others by name', () => {
    const vm = mount(props())

    return same(vm.classItems.map((item) => [item.id, item.mining]), [[100, true], [102, false], [101, false]]) === true && vm.classItems[0].text.includes('mining platform') ? true : short(vm.classItems)
  })
  add('panel: the class and the quantity chosen give the comparison of the utility, the quantity read as a whole number', () => {
    const vm = mount(props())
    const expected = m.pp.comparePaths({ shipClass: PLAT, noArmour: true, components, researched: f.RESEARCHED, quantity: 2, yards: [yard()], colonies: { 7: colony() }, context: vm.context, version: '2.7.1' })

    return same(vm.paths.rows.map((row) => [row.key, row.days, row.bp]), expected.rows.map((row) => [row.key, row.days, row.bp])) === true && vm.platforms === 2 && vm.rows.length === 2 ? true : short([vm.platforms, vm.rows.length])
  })
  add('panel: a quantity written with an exponent or above the most a comparison takes is not a quantity: no row, and the verdict names the range; the input carries the same bound', () => {
    const most = m.pp.MAX_PLATFORMS
    const texts = ['1e9', '1e20', String(most + 1), '1000000', '0x10', '1e3'].map((quantity) => mount(props({ quantity })))

    return texts.every((vm) => vm.platforms === null && vm.rows.length === 0 && vm.verdict.some((line) => line.text.includes(`1 to ${most}`))) && mount(props({ quantity: String(most) })).platforms === most && componentText.includes(':max="maxPlatforms"') ? true : short(texts.map((vm) => vm.platforms))
  })
  add('panel: a quantity that is not a whole number of 1 or more is not 1: no row, an error, and the verdict says what to enter', () => {
    const texts = ['0', '1.5', '', 'abc', '-3'].map((quantity) => mount(props({ quantity })))

    return texts.every((vm) => vm.platforms === null && vm.rows.length === 0 && vm.verdict.some((line) => line.text.includes('whole number'))) && mount(props({ quantity: '7' })).platforms === 7 ? true : short(texts.map((vm) => vm.platforms))
  })
  add('panel: no class picked, or a class the race no longer has, gives no comparison', () => {
    const none = mount(props({ classId: null }))
    const gone = mount(props({ classId: 999 }))

    return none.chosen === null && gone.chosen === null && gone.chosenId === null ? true : short([none.chosen, gone.chosen])
  })
  add('panel: the class\'s armour setting reaches the comparison: armour closes the industry route', () => {
    const armoured = mount(props({ classId: 101 }))
    const open = mount(props())

    return same([open.paths.station.state, armoured.paths.station.state], ['capable', 'ineligible']) === true && armoured.verdict.some((line) => line.text.includes('industry route is closed') && line.text.includes('armour')) && open.verdict.length === 0 ? true : short([open.verdict, armoured.verdict])
  })
  add('panel: a class with no stored armour setting is unknown, not armourless', () => {
    const vm = mount(props({ classId: 102, extras: { 102: { noArmour: null, miningModules: null } } }))

    return vm.paths.station.state === 'unknown' && vm.verdict.some((line) => line.text.includes('Not known')) && vm.tiles[0].value === 'Not known' ? true : short(vm.paths.station)
  })
  add('panel: each row has a status look, its reasons, what is not known, and a sort rank with the unknown ones last', () => {
    const vm = mount(props({ yards: [yard({ id: 1 }), yard({ id: 2, tasks: 2 }), yard({ id: 3, type: 4 }), yard({ id: 4, type: null })], colonies: { 7: colony({ spaceports: 0 }) } }))
    const byKey = Object.fromEntries(vm.rows.map((row) => [row.key, row]))

    return same([byKey['yard-1'].rank, byKey['yard-2'].rank, byKey['yard-3'].rank, byKey['yard-4'].rank, byKey['industry-7'].rank], [0, 1, 5, null, 4]) === true && byKey['yard-4'].gaps.length > 0 && byKey['industry-7'].reasons.some((text) => text.includes('spaceport')) && byKey['yard-1'].pathLabel !== byKey['industry-7'].pathLabel ? true : short(vm.rows.map((row) => [row.key, row.rank]))
  })
  add('panel: a path that makes no progress has its own look, ranked after the paths that wait or retool and before the closed ones, with its reason', () => {
    const vm = mount(props({ colonies: { 7: colony({ stock: { 1: 9, 2: 9, 3: 9 } }) } }))
    const row = vm.rows.find((item) => item.path === 'yard')

    return row.state === 'stalled' && row.rank === 3 && row.view.label === 'Makes no progress' && row.reasons.some((text) => text.includes('never completes')) && row.days === null ? true : short([row.state, row.rank, row.view, row.reasons])
  })
  add('panel: the minerals are totalled with the shortage named, "stock covers it" when none is short, "not known" when the stock is not', () => {
    const covered = mount(props()).rows
    const lacking = mount(props({ colonies: { 7: colony({ minerals: f.stock({ Corbomite: 1 }) }) } })).rows
    const unread = mount(props({ colonies: { 7: colony({ minerals: null }) } })).rows

    return same([covered[0].mineralTotal, covered[0].shortText, lacking[0].shortText.startsWith('Short: Corbomite'), unread[0].shortText], [46, 'Stock covers it', true, 'Stock not known']) === true || short([covered[0].mineralTotal, covered[0].shortText, lacking[0].shortText, unread[0].shortText])
  })
  add('panel: the time\'s note says what the retool added and when the first platform is done; the capacity says the free slipways or the share taken', () => {
    const vm = mount(props({ yards: [yard({ id: 1, tooledId: 101 }), yard({ id: 2, slipways: 1 })], quantity: '3' }))
    const retool = vm.rows.find((row) => row.key === 'yard-1')
    const one = vm.rows.find((row) => row.key === 'yard-2')
    const share = vm.rows.find((row) => row.path === 'industry')

    return retool.timeNote.includes('retool') && one.timeNote.includes('first platform') && retool.occupancy === '2 of 2 slipways free' && one.occupancy === '1 of 1 slipways free' && share.occupancy.includes('100') ? true : short([retool.timeNote, one.timeNote, retool.occupancy, share.occupancy])
  })
  add('panel: a busy colony says it has no free share; an unread one says its share is not known', () => {
    const busy = mount(props({ colonies: { 7: colony({ projects: [{ ProductionType: 0, Queue: 0, Percentage: 100 }] }) } })).rows.find((row) => row.path === 'industry')
    const unread = mount(props({ colonies: { 7: colony({ capacity: f.unknownCapacity }) } })).rows.find((row) => row.path === 'industry')

    return busy.occupancy.includes('No free share') && unread.occupancy === 'Share not known' ? true : short([busy.occupancy, unread.occupancy])
  })
  add('panel: one line for each colony with both paths says which is quicker there and for which time, and a colony without a verdict says why', () => {
    const quick = mount(props({ colonies: { 7: colony({ capacity: capacity(3000) }) } })).comparison[0]
    const slow = mount(props()).comparison[0]
    const none = mount(props({ colonies: { 7: colony({ capacity: f.unknownCapacity }) } })).comparison[0]

    return quick.text.includes('industry') && quick.text.includes('quicker') && slow.text.includes('shipyard') && slow.text.includes('Yard A') && none.text.startsWith('no comparison') && !/cheap/.test(quick.text + slow.text + none.text) ? true : short([quick.text, slow.text, none.text])
  })
  add('panel: a closed industry route says why in the colony\'s line, a side with no time names its state, and a colony short of minerals gets the rate order as a condition and no verdict', () => {
    const closed = mount(props({ extras: { ...props().extras, 100: { noArmour: false, miningModules: 2 } } })).comparison[0]
    const stalled = mount(props({ colonies: { 7: colony({ modifiers: { ShipyardBuildRate: 0, ShipyardOperations: 1 } }) } })).comparison[0]
    const busy = mount(props({ yards: [yard({ tasks: 2 })] })).comparison[0]
    const lacking = mount(props({ colonies: { 7: colony({ capacity: capacity(3000), stock: { 1: 1, 2: 3 }, minerals: f.stock({ Corbomite: 3 }) }) } })).comparison[0]
    const unread = mount(props({ colonies: { 7: colony({ minerals: null }) } })).comparison[0]

    return closed.text.includes('industry route is closed') && closed.text.includes('armour') && !closed.text.includes('the industry has no time') && stalled.text.includes('makes no progress') && busy.text.includes('no free capacity') && lacking.text.includes('no verdict on the colony\'s stock') && lacking.text.includes('on the rates alone the industry') && lacking.text.includes('if the missing minerals are obtained') && lacking.text.includes('Corbomite') && !lacking.text.includes('quicker on the colony') && unread.text.includes('which the stock does not show') ? true : short([closed.text, stalled.text, busy.text, lacking.text, unread.text])
  })
  add('panel: the tiles give the industry route, the build points and minerals of one platform and for the quantity, and how many paths can build it', () => {
    const vm = mount(props())
    const labels = vm.tiles.map((tile) => tile.label)

    return same(labels, ['Industry route', 'Build points each', 'Minerals each', 'Paths that can build it']) === true && vm.tiles[1].value === '52' && vm.tiles[1].note.includes('104') && vm.tiles[2].value.startsWith('23') && vm.tiles[3].value === '2' ? true : short(vm.tiles.map((tile) => [tile.label, tile.value, tile.note]))
  })
  add('panel: the shipyard path is not mounted on a table a persisted view could break: the views and fields have their defaults', () => {
    const vm = mount(props({ classId: null, quantity: '1' }))

    return same([vm.classId, vm.quantity, vm.table], [null, '1', { sortBy: ['rank'], sortDesc: false }])
  })

  // ----- the template, read as text -----
  const text = componentText
  const startTag = tag(text, 'v-card')
  const foot = (text.match(/<div class="panel-foot[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ''

  add('panel-template: the panel is a top-level .panel with a data-summary that has no digit and no first or second person', () => {
    const sentence = summary(text)

    return /class="panel platform-paths"/.test(startTag) && sentence.trim().length > 0 && !/\d/.test(sentence) && !/\b(I|me|my|mine|you|your|we|our)\b/i.test(sentence) ? true : sentence
  })
  add('panel-template: the foot states the two paths, the occupied capacity, the unknown figures, the labour and that no path is named cheaper or quicker in general', () => ['two production paths', 'one task for each', 'component projects', 'occupied capacity', 'never nought', 'labour', 'names no path as cheaper or quicker in general', 'has not researched', 'makes no progress', 'if the missing minerals are obtained'].filter((phrase) => !foot.includes(phrase)).map((phrase) => `the foot lacks "${phrase}"`).join('; ') || true)
  add('panel-template: the foot is in the UI voice: no first or second person', () => (/\b(I|me|my|mine|you|your|we|our)\b/i.test(foot.replace(/<[^>]*>/g, '')) ? 'the foot speaks to a person' : true))
  add('panel-template: the template compiles', () => { const errors = templateErrors(text); return errors.length ? short(errors) : true })
  add('panel-template: a time that is not known is a dash with its mark, never a number, and the table sorts the unknown last', () => (text.includes('<span v-if="item.days !== null"') && text.includes('<span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.timeResult" />') && text.includes(':custom-sort="sortNullLast"') ? true : 'the time cell or the sort changed'))
  add('panel-template: the figures carry their marks: the time, the build points, the minerals, the labour and the rules of the foot', () => ['item.timeResult', 'recipe.result', 'M<provenance-mark :result="item.labour.result" />', 'rule="platformPaths.recipe"', 'rule="platformPaths.stationClass"', 'rule="platformPaths.spaceport"', 'rule="platformPaths.yard"', 'rule="platformPaths.industry"'].filter((mark) => !text.includes(mark)).map((mark) => `no mark ${mark}`).join('; ') || true)
  add('panel-template: the view fields have the keys of the preferences: the class, the quantity and the table', () => {
    const keys = [...text.matchAll(/(?:key: |tableView\()'(shipyardsPlatform\w+)'/g)].map((match) => match[1]).sort()

    return same(keys, ['shipyardsPlatformClass', 'shipyardsPlatformQuantity', 'shipyardsPlatformTable'])
  })
  add('panel-template: the headers are the columns the rows have, and the table keys its rows by a unique key', () => {
    const vm = mount(props())
    const columns = ['where', 'rank', 'days', 'bp', 'mineralTotal', 'labourMillions', 'occupancy']

    return same(vm.headers.map((header) => header.value), columns) === true && vm.rows.every((row) => columns.every((key) => key in row)) && text.includes('item-key="key"') ? true : short(vm.headers)
  })

  return statements
}

const page = (ctx) => {
  const { m, pageText, pageOptions, componentOptions } = ctx
  const f = fixtures(m)
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const mount = (data = {}) => instantiate(pageOptions, { $store: { getters: {}, state: {} }, data })
  const mountTag = (pageText.match(/<platform-paths\b[^>]*>/) || [''])[0]
  const bound = [...mountTag.matchAll(/ :([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])
  const propNames = Object.keys(componentOptions.props)
  const labels = (pageText.match(/const INPUT_LABELS = \{([\s\S]*?)\n\}/) || [])[1] || ''
  const labelKeys = [...labels.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])
  const trackedKeys = [...pageText.matchAll(/tracked\('(\w+)'/g)].map((match) => match[1])
  const camel = (name) => name.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())

  add('page: the panel is mounted once on the Class to yards view, and registered', () => (mountTag.includes('v-if="view === \'classes\'"') && (pageText.match(/<platform-paths\b/g) || []).length === 1 && 'PlatformPaths' in pageOptions.components ? true : `${mountTag} ${Object.keys(pageOptions.components)}`))
  add('page: the template compiles', () => { const errors = templateErrors(pageText); return errors.length ? short(errors) : true })
  add('page: every prop of the panel is bound once and nothing else is', () => {
    const names = bound.map(([name]) => camel(name)).filter((name) => name !== 'vIf')

    return same([...names].sort(), [...propNames].sort())
  })
  add('page: the panel gets the page\'s own classes, components, yards, eligibility context and formula version, and the platform reads', () => same(Object.fromEntries(bound.filter(([name]) => name !== 'v-if')), { classes: 'classes', extras: 'platformSources.extras', components: 'components', yards: 'yards', colonies: 'platformColonies', context: 'eligibilityContext', version: 'formulaVersion', researched: 'platformSources.researched' }))
  add('page: the platform read has one name as a tracked key, an asyncComputed and an INPUT_LABELS key, with its default', () => {
    const asyncKeys = Object.keys(pageOptions.asyncComputed)

    return labelKeys.includes('platformSources') && trackedKeys.includes('platformSources') && asyncKeys.includes('platformSources') && same(pageOptions.asyncComputed.platformSources.default, { extras: {}, colonies: {}, researched: null, stockRead: false }) === true && trackedKeys.every((key) => asyncKeys.includes(key) && labelKeys.includes(key)) ? true : short([labelKeys, trackedKeys, asyncKeys])
  })
  add('page: each colony gets its stock, projects and installations with the page\'s modifiers and its construction capacity as a result', () => {
    const vm = mount({ platformSources: { extras: {}, colonies: { 7: { name: 'Alpha', stock: { 1: 2 }, minerals: null, projects: [], spaceports: 1, factories: { workers: 1 } } }, stockRead: true }, populationProductionModifiers: { 7: f.MODIFIERS } })
    const colonies = vm.platformColonies

    return colonies[7].modifiers === f.MODIFIERS && colonies[7].capacity.kind === 'construction' && colonies[7].capacity.id === '7' && colonies[7].name === 'Alpha' && colonies[7].stock[1] === 2 && colonies[7].spaceports === 1 ? true : short(colonies)
  })
  add('page: a colony the modifiers read does not cover has no modifiers, which leaves its rates unknown rather than made up', () => {
    const vm = mount({ platformSources: { extras: {}, colonies: { 9: { name: 'Beta', stock: {}, minerals: null, projects: [], spaceports: 1, factories: { workers: 1 } } }, stockRead: true }, populationProductionModifiers: {} })

    return vm.platformColonies[9].modifiers === undefined ? true : short(vm.platformColonies[9])
  })

  return statements
}

// ---------- the planted faults ----------

const U = 'platform-paths.js'
const V = 'PlatformPaths.vue'
const P = 'shipyards.vue'

// A planted fault and the checks that must fail for it: each name is the key of a check (the text before its colon), and the fault is caught only when every one of them fails.
const MUTATIONS = [
  { name: 'armour ignored', file: U, find: 'flag(noArmour === true ? false : noArmour === false ? true : null,', replace: 'flag(false,', fails: ['eligible', 'industry'] },
  { name: 'an unread armour setting taken as armourless', file: U, find: 'flag(noArmour === true ? false : noArmour === false ? true : null,', replace: 'flag(noArmour === false,', fails: ['eligible', 'panel'] },
  { name: 'an obsolete class not refused', file: U, find: 'flag(shipClass.obsolete === undefined ? null : shipClass.obsolete,', replace: 'flag(false,', fails: ['eligible', 'industry'] },
  { name: 'a class from another race refused again', file: U, find: 'flag(shipClass.prototype,', replace: 'flag(shipClass.otherRace, \'the class is another race\\\'s\', \'whose class it is\')\n  flag(shipClass.prototype,', fails: ['eligible'] },
  { name: 'a prototype class not refused', file: U, find: 'flag(shipClass.prototype,', replace: 'flag(false,', fails: ['eligible', 'industry'] },
  { name: 'an unknown flag beating a known blocker', file: U, find: 'state: blockers.length ? \'ineligible\' : missing.length ? \'unknown\' : \'capable\'', replace: 'state: missing.length ? \'unknown\' : blockers.length ? \'ineligible\' : \'capable\'', fails: ['eligible'] },
  { name: 'the minerals of a component not times its count', file: U, find: 'total + part.count * part.minerals[name]', replace: 'total + part.minerals[name]', fails: ['recipe', 'industry'] },
  { name: 'a recipe with a gap given minerals', file: U, find: 'gaps.some((text) => !text.startsWith(\'the class\')) ? null :', replace: 'false ? null :', fails: ['recipe'] },
  { name: 'the recipe taken as available whatever is missing', file: U, find: 'result: gaps.length ? unavailable({ rule, missing: gaps, units: \'BP\' }) :', replace: 'result: false ? unavailable({ rule, missing: gaps, units: \'BP\' }) :', fails: ['recipe'] },
  { name: 'the spaceport ignored', file: U, find: 'if (colony.spaceports === 0) {', replace: 'if (false) {', fails: ['industry', 'spaceport'] },
  { name: 'an unread spaceport count taken as present', file: U, find: '} else if (!isNumber(colony.spaceports)) {', replace: '} else if (false) {', fails: ['industry'] },
  { name: 'the stock credit left out', file: U, find: 'requirements({ parts, hulls: quantity, stock })', replace: 'requirements({ parts, hulls: quantity, stock: {} })', fails: ['stock'] },
  { name: 'the stock credit taken for every hull', file: U, find: 'const used = Math.min(left[part.componentId], part.count)', replace: 'const used = part.count', fails: ['stock'] },
  { name: 'the stock used again by the next task', file: U, find: 'left[part.componentId] -= used', replace: 'void used', fails: ['stock', 'schedule'] },
  { name: 'the platforms\' build points not times the quantity', file: U, find: 'bp: isNumber(recipe.bp) ? recipe.bp * quantity : null', replace: 'bp: isNumber(recipe.bp) ? recipe.bp : null', fails: ['industry'] },
  { name: 'the industry\'s minerals not times the quantity', file: U, find: 'recipe.minerals[name] * quantity]))', replace: 'recipe.minerals[name]]))', fails: ['industry'] },
  { name: 'the share not reduced by the projects held', file: U, find: 'const free = WHOLE_CAPACITY - held.held', replace: 'const free = WHOLE_CAPACITY', fails: ['industry', 'compare'] },
  { name: 'a yard needing a retool with no free slipway given a time', file: U, find: 'if (free <= 0) {', replace: 'if (false) {', fails: ['retool'] },
  { name: 'a busy colony given a time', file: U, find: 'if (free <= EPSILON) {', replace: 'if (false) {', fails: ['industry'] },
  { name: 'the retool\'s days dropped', file: U, find: 'const days = retoolDays + finish * DAYS_PER_YEAR', replace: 'const days = finish * DAYS_PER_YEAR', fails: ['retool'] },
  { name: 'the retool\'s days left out of the first platform\'s', file: U, find: 'firstDays: retoolDays + first * DAYS_PER_YEAR', replace: 'firstDays: first * DAYS_PER_YEAR', fails: ['retool'] },
  { name: 'every task put on the first slipway', file: U, find: 'const slot = free.indexOf(Math.min(...free))', replace: 'const slot = 0', fails: ['schedule'] },
  { name: 'one slipway for any number free', file: U, find: 'new Array(Math.max(1, Math.min(slipways, durations.length)))', replace: 'new Array(1)', fails: ['schedule'] },
  { name: 'the first platform taken as the last to finish', file: U, find: 'first = Math.min(first, free[slot])', replace: 'first = Math.max(first === Infinity ? 0 : first, free[slot])', fails: ['schedule'] },
  { name: 'the class\'s size left out of the yard\'s rate', file: U, find: 'const rate = refitRate(colony.modifiers, shipClass)', replace: 'const rate = refitRate(colony.modifiers, { ...shipClass, sizeHS: 20 })', fails: ['schedule', 'retool', 'compare'] },
  { name: 'a yard\'s time taken from the tasks\' sum, not the schedule', file: U, find: 'const { finish, first } = makespan(sums.tasks.map((task) => task.bp / perYear), free)', replace: 'const { finish, first } = makespan(sums.tasks.map((task) => task.bp / perYear), 1)', fails: ['schedule'] },
  { name: 'a verdict given where a time is not known', file: U, find: 'const rateQuicker = yard === null || industry.days === null ? null :', replace: 'const rateQuicker = industry.days === null ? null : yard === null ? \'industry\' :', fails: ['compare'] },
  { name: 'equal times told apart', file: U, find: 'Math.abs(yard.days - industry.days) <= EPSILON ? \'same\' :', replace: 'false ? \'same\' :', fails: ['compare'] },
  { name: 'the slowest yard of a colony stood for it', file: U, find: 'row.days < best.days ? row : best', replace: 'row.days > best.days ? row : best', fails: ['compare'] },
  { name: 'a capacity not read taken as 0', file: U, find: 'const capacity = valueOrNull(colony.capacity)', replace: 'const capacity = valueOrNull(colony.capacity) || 0', fails: ['industry'] },
  { name: 'a capacity of 0 given an infinite time', file: U, find: 'const perYear = capacity * (free / WHOLE_CAPACITY)\n\n  if (!(perYear > 0)) {', replace: 'const perYear = capacity * (free / WHOLE_CAPACITY)\n\n  if (false) {', fails: ['industry'] },
  { name: 'projects not read taken as none held', file: U, find: '{ held: 0, missing: [\'the colony\\\'s industrial projects\'] }', replace: '{ held: 0, missing: [] }', fails: ['unread'] },
  { name: 'a stock amount not read taken as held', file: U, find: 'total.invalid || total.unknown ||', replace: 'total.invalid ||', fails: ['unread'] },
  { name: 'a yard\'s workers counted for one slipway', file: U, find: 'yardWorkers(yard.type, yard.capacity, yard.slipways)', replace: 'yardWorkers(yard.type, yard.capacity, 1)', fails: ['labour'] },
  { name: 'factories not read taken as none', file: U, find: 'isNumber(colony.factories.workers) ? colony.factories.workers : null', replace: 'isNumber(colony.factories.workers) ? colony.factories.workers : 0', fails: ['labour'] },
  { name: 'a quantity with a fraction accepted', file: U, find: 'if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PLATFORMS) {', replace: 'if (quantity < 1 || quantity > MAX_PLATFORMS) {', fails: ['invalid'] },
  { name: 'a colony with factories and no spaceport left out', file: U, find: 'colonies[id].spaceports > 0 || (colonies[id].factories && colonies[id].factories.workers > 0)', replace: 'colonies[id].spaceports > 0', fails: ['rows'] },
  { name: 'the yard\'s time under the industry\'s rule', file: U, find: 'export const yardPath = ({ shipClass, components, researched = null, recipe, quantity, yard, colony, context, version = null }) => {\n  const rule = \'platformPaths.yard\'', replace: 'export const yardPath = ({ shipClass, components, researched = null, recipe, quantity, yard, colony, context, version = null }) => {\n  const rule = \'platformPaths.industry\'', fails: ['provenance'] },
  { name: 'the minerals short not named', file: U, find: 'short[name] = needed[name] - stock[name]', replace: 'short[name] = needed[name]', fails: ['industry', 'stock'] },
  { name: 'the spaceport read under another name', file: U, find: 'sum(case when DIM_PlanetaryInstallation.Name = \\\'Spaceport\\\' then FCT_PopulationInstallations.Amount else 0 end) as Spaceports', replace: 'sum(case when DIM_PlanetaryInstallation.Name = \\\'Spaceports\\\' then FCT_PopulationInstallations.Amount else 0 end) as Spaceports', fails: ['loader'] },
  { name: 'the armour setting read the wrong way', file: U, find: 'row.NoArmour === 1 ? true : row.NoArmour === 0 ? false : null', replace: 'row.NoArmour === 0 ? true : row.NoArmour === 1 ? false : null', fails: ['loader'] },
  { name: 'the factories\' workers read without their amounts', file: U, find: 'then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.Workers else 0', replace: 'then DIM_PlanetaryInstallation.Workers else 0', fails: ['loader'] },
  { name: 'a spaceport amount not stored taken as none', file: U, find: 'colony.spaceports = spaceports > 0 ? spaceports : row.SpaceportUnknown > 0 || !isNumber(row.Spaceports) ? null : spaceports', replace: 'colony.spaceports = spaceports', fails: ['loader'] },
  { name: 'a spaceport not stored beating a stored one', file: U, find: 'colony.spaceports = spaceports > 0 ? spaceports : row.SpaceportUnknown > 0 || !isNumber(row.Spaceports) ? null : spaceports', replace: 'colony.spaceports = row.SpaceportUnknown > 0 || !isNumber(row.Spaceports) ? null : spaceports', fails: ['loader'] },
  { name: 'a factory not stored in full counted as short of workers', file: U, find: 'workers: row.FactoryUnknown > 0 || !isNumber(row.FactoryWorkers) ? null : row.FactoryWorkers', replace: 'workers: isNumber(row.FactoryWorkers) ? row.FactoryWorkers : 0', fails: ['loader'] },
  { name: 'an installation of no type not counted as a gap', file: U, find: '(DIM_PlanetaryInstallation.ConstructionValue is null and FCT_PopulationInstallations.Amount is not 0)', replace: '(0)', fails: ['loader'] },
  { name: 'a colony\'s installations never marked as not in full', file: U, find: 'colony.installationUnknown = row.SpaceportUnknown > 0 || row.FactoryUnknown > 0', replace: 'colony.installationUnknown = false', fails: ['loader'] },
  { name: 'the research read the wrong way', file: U, find: 'max(case when FCT_RaceTech.TechID is null then 0 else 1 end)', replace: 'max(case when FCT_RaceTech.TechID is null then 1 else 0 end)', fails: ['loader'] },
  { name: 'a race with no research rows taken as having researched nothing', file: U, find: '[0][0].TechRows > 0 : false', replace: '[0][0].TechRows >= 0 : false', fails: ['loader'] },
  { name: 'the research of another race\'s classes read', file: U, find: 'where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID group by FCT_ClassComponent.ComponentID', replace: 'where FCT_ShipClass.GameID = :GameID group by FCT_ClassComponent.ComponentID', fails: ['loader'] },
  { name: 'a colony with installations not stored in full left out of the industry rows', file: U, find: ' || colonies[id].installationUnknown === true', replace: '', fails: ['rows'] },
  { name: 'the yard\'s alien components not asked for', file: U, find: 'if (admission.blockers.length) {', replace: 'if (false) {', fails: ['alien'] },
  { name: 'the industry\'s alien components not asked for', file: U, find: 'blockers.push(...admission.blockers)', replace: 'void admission', fails: ['alien'] },
  { name: 'the yard asked for one hull\'s alien components only', file: U, find: 'hulls: quantity, wording', replace: 'hulls: 1, wording', fails: ['alien'] },
  { name: 'a research not known taken as an alien stock check', file: U, find: '    if (state !== 0) {', replace: '    if (state !== 0 && state !== null) {', fails: ['alien'] },
  { name: 'an alien stock not known taken as none held', file: U, find: '} else if (!Number.isFinite(held)) {', replace: '} else if (false) {', fails: ['alien'] },
  { name: 'a task with no build points given a time', file: U, find: 'if (sums.tasks.some((task) => task.bp <= EPSILON)) {', replace: 'if (false) {', fails: ['stock'] },
  { name: 'a zero shipbuilding output given an infinite time', file: U, find: 'const perYear = valueOrNull(rate)\n\n  if (!(perYear > 0)) {', replace: 'const perYear = valueOrNull(rate)\n\n  if (false) {', fails: ['stalled'] },
  { name: 'a class of no build points given a time by the industry', file: U, find: 'isNumber(recipe.bp) && recipe.bp > 0 ? [] :', replace: 'isNumber(recipe.bp) ? [] :', fails: ['stalled'] },
  { name: 'a yard that belongs to a ship given workers', file: U, find: 'yard.shipBased === true ? labourOf(0,', replace: 'false ? labourOf(0,', fails: ['labour'] },
  { name: 'a yard whose origin is not read given workers', file: U, find: 'const planetary = yard.shipBased === false && ', replace: 'const planetary = ', fails: ['labour'] },
  { name: 'a verdict named on the rates where minerals are short', file: U, find: 'quicker: supply === \'covered\' ? rateQuicker : null', replace: 'quicker: rateQuicker', fails: ['compare', 'panel'] },
  { name: 'a stock not known taken as covering', file: U, find: 'yard.short === null || industry.short === null ? \'unknown\' : \'covered\'', replace: '\'covered\'', fails: ['compare'] },
  { name: 'a colony\'s yards left out of its line', file: U, find: 'yards: own, yard, industry', replace: 'yards: [], yard, industry', fails: ['compare'] },
  { name: 'a closed industry route not said in the colony\'s line', file: V, find: '} route is closed', replace: '} route is shut', fails: ['panel'] },
  { name: 'the rate order named as a verdict where minerals are short', file: V, find: 'no verdict on the colony\'s stock; on the rates alone', replace: 'quicker on the colony\'s stock; on the rates alone', fails: ['panel'] },
  { name: 'a path that makes no progress ranked first', file: V, find: 'stalled: { label: \'Makes no progress\', icon: \'mdi-timer-sand-empty\', color: \'warning\', rank: 3 },', replace: 'stalled: { label: \'Makes no progress\', icon: \'mdi-timer-sand-empty\', color: \'warning\', rank: 0 },', fails: ['panel'] },
  { name: 'the research not passed to the panel', file: P, find: ' :researched="platformSources.researched"', replace: '', fails: ['page'] },
  { name: 'a retool of a yard that belongs to a ship priced', file: U, find: 'if (eligibility.state === \'retool\' && yard.shipBased === true) {', replace: 'if (false) {', fails: ['retool'] },
  { name: 'a yard whose origin is not read given a retool', file: U, find: 'if (eligibility.state === \'retool\' && yard.shipBased !== false) {', replace: 'if (false) {', fails: ['retool'] },
  { name: 'a quantity above the most taken', file: U, find: 'quantity < 1 || quantity > MAX_PLATFORMS', replace: 'quantity < 1 || quantity > MAX_PLATFORMS * 10', fails: ['invalid'] },
  { name: 'a quantity with an exponent accepted by the panel', file: V, find: '/^\\s*\\d{1,6}\\s*$/.test(text) ? Number(text) : NaN', replace: 'Number.isFinite(Number(text)) ? Number(text) : NaN', fails: ['panel'] },
  { name: 'the panel\'s quantity not bounded', file: V, find: 'value >= 1 && value <= MAX_PLATFORMS ? value : null', replace: 'value >= 1 ? value : null', fails: ['panel'] },
  { name: 'the input without the bound', file: V, find: ' :max="maxPlatforms"', replace: '', fails: ['panel'] },
  { name: 'an installation with no name taken as no spaceport', file: U, find: '(DIM_PlanetaryInstallation.Name is null and FCT_PopulationInstallations.Amount is not 0)', replace: '(0)', fails: ['loader'] },
  { name: 'an installation whose definition is missing dropped', file: U, find: 'left join DIM_PlanetaryInstallation', replace: 'inner join DIM_PlanetaryInstallation', fails: ['loader'] },
  { name: 'installations the save lacks not marked', file: U, find: 'installationUnknown: installations === null })', replace: 'installationUnknown: false })', fails: ['loader'] },
  { name: 'installations read without their definitions', file: U, find: ' && [\'PlanetaryInstallationID\', \'Name\', \'Workers\', \'ConstructionValue\'].every((column) => definitionColumns.has(column))', replace: '', fails: ['loader'] },
  { name: 'the data-summary with a figure', file: V, find: 'data-summary="The ways a mining platform class', replace: 'data-summary="The 2 ways a mining platform class', fails: ['panel-template'] },
  { name: 'the panel without a data-summary', file: V, find: 'class="panel platform-paths" data-summary="', replace: 'class="panel platform-paths" data-sum="', fails: ['panel-template'] },
  { name: 'an unknown time drawn as a number', file: V, find: '<span v-if="item.days !== null"', replace: '<span v-if="true"', fails: ['panel-template'] },
  { name: 'the unknown times not sorted last', file: V, find: ' :custom-sort="sortNullLast"', replace: '', fails: ['panel-template'] },
  { name: 'the labour without its mark', file: V, find: 'M<provenance-mark :result="item.labour.result" /></span>', replace: 'M</span>', fails: ['panel-template'] },
  { name: 'the panel\'s card left unclosed', file: V, find: '  </v-card>\n</template>', replace: '  </v-cardx>\n</template>', fails: ['panel-template'] },
  { name: 'the foot without its claim about the cheaper path', file: V, find: 'names no path as cheaper or quicker in general', replace: 'is short', fails: ['panel-template'] },
  { name: 'the quantity ignored', file: V, find: 'quantity: this.platforms,', replace: 'quantity: 1,', fails: ['panel'] },
  { name: 'every armour setting taken as armourless', file: V, find: 'typeof extra.noArmour === \'boolean\' ? extra.noArmour : null', replace: 'typeof extra.noArmour === \'boolean\' ? extra.noArmour : true', fails: ['panel'] },
  { name: 'the mining platforms not first', file: V, find: 'Number(b.mining) - Number(a.mining) ||', replace: '', fails: ['panel'] },
  { name: 'an invalid quantity not said', file: V, find: 'if (paths.invalid) {', replace: 'if (false) {', fails: ['panel'] },
  { name: 'the quicker path not told', file: V, find: 'QUICKER_TEXT[quicker](yard, industry, this.duration)', replace: '\'\'', fails: ['panel'] },
  { name: 'every mineral listed as short', file: V, find: 'row.short[name] > 0', replace: 'row.short[name] !== 0', fails: ['panel'] },
  { name: 'the retool\'s days not said', file: V, find: 'if (row.retoolDays) {', replace: 'if (false) {', fails: ['panel'] },
  { name: 'the colony\'s state ranks mixed', file: V, find: 'busy: { label: \'Busy: no free capacity\', icon: \'mdi-progress-clock\', color: \'info\', rank: 1 },', replace: 'busy: { label: \'Busy: no free capacity\', icon: \'mdi-progress-clock\', color: \'info\', rank: 5 },', fails: ['panel'] },
  { name: 'the class view field under another key', file: V, find: 'key: \'shipyardsPlatformClass\'', replace: 'key: \'shipyardsPlatformClasz\'', fails: ['panel-template'] },
  { name: 'the table\'s columns changed', file: V, find: '{ text: \'Labour held\', value: \'labourMillions\', align: \'end\' },', replace: '', fails: ['panel-template'] },
  { name: 'the panel not mounted', file: P, find: '<platform-paths v-if="view === \'classes\'"', replace: '<platform-pathz v-if="view === \'classes\'"', fails: ['page'] },
  { name: 'the panel mounted on the Refits view too', file: P, find: '<platform-paths v-if="view === \'classes\'"', replace: '<platform-paths v-if="true"', fails: ['page'] },
  { name: 'the colonies not passed', file: P, find: ' :colonies="platformColonies"', replace: '', fails: ['page'] },
  { name: 'the eligibility context not passed', file: P, find: ' :context="eligibilityContext"', replace: '', fails: ['page'] },
  { name: 'the panel not registered', file: P, find: 'components: { LoadState, PageLink, PlatformPaths, ProvenanceMark, StatTiles },', replace: 'components: { LoadState, PageLink, ProvenanceMark, StatTiles },', fails: ['page'] },
  { name: 'the page\'s container left unclosed', file: P, find: '    </v-container>\n  </div>\n</template>', replace: '    </v-containe>\n  </div>\n</template>', fails: ['page'] },
  { name: 'the read\'s label under another name', file: P, find: 'platformSources: \'the colonies\\\' component stock', replace: 'platformSource: \'the colonies\\\' component stock', fails: ['page'] },
  { name: 'the read tracked under another name', file: P, find: 'tracked(\'platformSources\'', replace: 'tracked(\'platformSource\'', fails: ['page'] },
  { name: 'the colonies without the page\'s modifiers', file: P, find: 'modifiers: modifiersOf[id], ', replace: '', fails: ['page'] },
  { name: 'the colonies\' capacity of another kind', file: P, find: 'this.populationCapacityResult(id, \'construction\')', replace: 'this.populationCapacityResult(id, \'ordnance\')', fails: ['page'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = { [U]: () => fs.readFileSync(utilityFile, 'utf8'), [V]: () => fs.readFileSync(componentFile, 'utf8'), [P]: () => fs.readFileSync(pageFile, 'utf8') }

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = { [U]: TEXTS[U](), [V]: TEXTS[V](), [P]: TEXTS[P]() }

  if (mutant) {
    sources[mutant.file] = patched(mutant.file, sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

// A stand-in for the production-modifiers mixin, which needs the app: the capacity result names the colony and the kind, and the modifiers are the page's data.
const MIXIN_STUB = 'export default { methods: { populationCapacityResult(id, kind) { return { id, kind } } }, asyncComputed: { populationProductionModifiers: { get() { return {} }, default: {} } } }'

const contextOf = async (sources) => {
  const changed = sources[U] !== TEXTS[U]()
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: changed ? { 'platform-paths': sources[U] } : {} })
  const utilitySource = changed ? { 'utilities/platform-paths': sources[U] } : {}
  const options = await loadPage('components/shipyards/PlatformPaths', { stubs: STUBS, sources: { 'components/shipyards/PlatformPaths': sources[V], ...utilitySource } })
  const pageOptions = await loadPage('pages/shipyards', { stubs: STUBS, modules: { 'mixins/production-modifiers': MIXIN_STUB }, sources: { 'pages/shipyards': sources[P], ...utilitySource } })

  return { m: { pp: loaded['platform-paths'], refits: loaded.refits, calc: loaded['component-calc'], workforce: loaded['workforce-demand'], provenance: loaded.provenance, minerals: loaded.minerals }, options, pageOptions, componentOptions: options, componentText: sources[V], pageText: sources[P] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test, detail] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result, detail])
  }

  return results
}

const statementsOf = async (ctx, withSaves, keys = null) => {
  const statements = [...pure(ctx), ...loader(ctx), ...panel(ctx), ...page(ctx)]
  const opened = []
  const skipped = []

  if (withSaves) {
    for (const save of SAVES) {
      const wanted = keys === null || keys.some((key) => key.startsWith('save-'))
      const read = wanted ? await saveStatements(ctx, save) : { skipped: false, statements: [] }

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)

        if (read.close) {
          opened.push(read)
        }
      }
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nMining platform production paths, on classes, yards and colonies worked by hand, the panel, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  for (const [name, result, detail] of await runStatements(statements)) {
    check(name, result, detail)
  }

  opened.forEach((read) => read.close())
}

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  const { statements, opened } = await statementsOf(ctx, mutant.fails.some((key) => key.startsWith('save-')), mutant.fails)
  const absent = mutant.fails.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, mutant.fails)
  const missed = mutant.fails.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  opened.forEach((read) => read.close())
  check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
