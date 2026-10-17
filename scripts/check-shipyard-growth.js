/*
  Checks the Yards and Growth views of the Shipyards page: the price and the time of growing a shipyard (src/renderer/utilities/shipyard-growth.js), the task rows the yard read carries (src/renderer/utilities/refits.js `loadYards`), the views themselves (src/renderer/pages/shipyards.vue) and the named links to a yard from the Production Recap, the yard warnings and the Tech Tree.

  bun scripts/check-shipyard-growth.js [--no-mutations]

  The utility is run on yards worked by hand: a slipway costs the capacity over 500 tons times 120 times the race's shipyard operations, a capacity step the slipways times 120 times the operations times 1, 2, 4, 10 or 20, a commercial or repair yard paying a tenth; the operations factor is the lowest multiplier among the levels held and a race holding none has no factor (never 1, never 0); a continual upgrade is priced per ton at the steps' rate and timed by the Production Recap's stepping rule, and a target that would take more than the most construction periods is refused at once; a task and an activity are timed as the Recap times them. The page is run as a pseudo instance over scripts/lib/page-loader.js on four yards (a naval yard with two tasks, a commercial one with a task and an upgrade, a repair yard with nothing, a full naval yard being retooled): every yard is one row, the filters and the link keys do what they say, and the tiles are the counts of the same yards. The text of the page, the Production Recap, the yard warnings and the Tech Tree components is read for the named links and the section summaries.

  The loaders run on an in-memory save built in this script, and on the saves (saves/AuroraDB.db and saves/AuroraDB_271_skoormit_saved.db, read-only), whether or not the saves are there: a save that is not there is skipped. On the saves the stored build points of every yard activity of types 1 to 6 (the slipway and the five capacity steps) are compared with the rules' price: 64 of 64 are equal once the race's operations factor applies, 63 of them at a factor of 1; the stored build points of a continual activity are 0, so the continual price has no stored comparison; and no save holds an activity of the 500 or 2,000 ton steps, so those two rest on the pattern of the others.

  Each mutation of the utility, the loader, the page or the other sources must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const FILES = {
  G: path.join(renderer, 'utilities', 'shipyard-growth.js'),
  R: path.join(renderer, 'utilities', 'refits.js'),
  D: path.join(renderer, 'utilities', 'deep-links.js'),
  P: path.join(renderer, 'pages', 'shipyards.vue'),
  PR: path.join(renderer, 'pages', 'production.vue'),
  W: path.join(renderer, 'utilities', 'warnings', 'industry.js'),
  L: path.join(renderer, 'components', 'research', 'LinesView.vue'),
  PV: path.join(renderer, 'components', 'research', 'PathView.vue'),
}
const { G, R, D, P, PR, W, L, PV } = Object.fromEntries(Object.keys(FILES).map((key) => [key, key]))
const NAMES = ['shipyard-growth', 'refits', 'production', 'provenance', 'deep-links']
const SAVES = ['saves/AuroraDB.db', 'saves/AuroraDB_271_skoormit_saved.db']
// The yards of each save that belong to a ship (FCT_Shipyard.ParentShipID above 0), read by hand from the saves: three yards of race 785 in AuroraDB.db (6711 'Fix 001', 6760, 6772), none in the other.
const SHIP_BASED_YARDS = { 'AuroraDB.db': [6711, 6760, 6772], 'AuroraDB_271_skoormit_saved.db': [] }

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
}

// A stand-in for the production-modifiers mixin, which needs the app: the modifiers are the page's data.
const MIXIN_STUB = 'export default { methods: { populationCapacityResult(id, kind) { return { id, kind } } }, asyncComputed: { populationProductionModifiers: { get() { return {} }, default: {} } } }'

// The real persisted-view mixin, for the checks of what the page keeps when it is left and opened again.
const PERSISTED_VIEW_SOURCE = fs.readFileSync(path.join(renderer, 'mixins', 'persisted-view.js'), 'utf8')

// An in-memory stand-in for the settings store: values are kept as text, as the file keeps them, and `reopened` is a restart (another store over what the file holds).
class MemoryConfig {
  constructor(entries = []) {
    this.values = new Map(entries)
  }

  get(key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set(key, value) {
    this.values.set(key, JSON.stringify(value))
  }

  reopened() {
    return new MemoryConfig([...this.values])
  }
}

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

// The asynchronous computed values a page declares, as the data that holds their defaults.
const asyncDefaults = (options) => {
  const flat = (part) => [...(part.mixins || []).flatMap(flat), part]

  return Object.fromEntries(flat(options).flatMap((part) => Object.entries(part.asyncComputed || {})).map(([name, read]) => [name, typeof read.default === 'function' ? read.default.call({}) : read.default]))
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
const DROPPED = new Set(['rule', 'inputs', 'assumptions'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))
const same = (actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected) ? true : `${short(actual)} != ${short(expected)}`)
const sameNumber = (actual, expected) => (near(actual, expected) ? true : `${short(actual)} != ${short(expected)}`)
const sameNumbers = (actual, expected) => (actual.length === expected.length && actual.every((value, index) => near(value, expected[index])) ? true : `${short(actual)} != ${short(expected)}`)
const finiteAll = (value) => (typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(finiteAll) : value !== null && typeof value === 'object' ? Object.values(value).every(finiteAll) : true)

const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'page.vue', id: 'page' }).errors.map(String)
}

const count = (text, find) => text.split(find).length - 1

// ---------- the fixtures worked by hand ----------

const MODIFIERS = { ShipyardBuildRate: 1000, ShipyardOperations: 0.8, MinConstructionPeriod: 864000 }
const HELD = [{ id: 1, name: 'Level 1', multiplier: 1 }, { id: 2, name: 'Level 2', multiplier: 0.8 }]
const version = '2.7.x'

// The yards: A, a naval yard of 4 slipways and 5,000 t with a construction task (class of 2,000 size units, 5,250 BP left) and a refit (10,500 BP left); B, a commercial yard of 2 slipways with a construction task (3,000 BP left) adding 1,000 t (800 BP, 200 done); C, a repair yard with nothing; D, a naval yard of 3 slipways, all working, retooling for class 101 (1,000 BP).
const task = (id, over = {}) => ({ id, taskType: 0, classId: 100, className: 'Alpha class', refitId: null, name: `Unit ${id}`, totalBP: 6000, completedBP: 750, remaining: 5250, paused: false, size: 2000, ...over })
const yardA = { id: 1, populationId: 7, colony: 'Alpha', name: 'Yard A', type: 1, slipways: 4, capacity: 5000, tooledId: 100, retoolId: null, taskType: 0, requiredBP: 0, completedBP: 0, paused: false, capacityTarget: 0, tasks: 2, taskRows: [task(11), task(12, { taskType: 2, refitId: 101, remaining: 10500, totalBP: 10500, completedBP: 0 })], shipBased: false }
const yardB = { id: 2, populationId: 7, colony: 'Alpha', name: 'Yard B', type: 2, slipways: 2, capacity: 5000, tooledId: null, retoolId: null, taskType: 3, requiredBP: 800, completedBP: 200, paused: false, capacityTarget: 0, tasks: 1, taskRows: [task(21, { remaining: 3000, totalBP: 3000, completedBP: 0 })], shipBased: false }
const yardC = { id: 3, populationId: 8, colony: 'Beta', name: 'Yard C', type: 3, slipways: 1, capacity: 1000, tooledId: 100, retoolId: null, taskType: 0, requiredBP: 0, completedBP: 0, paused: false, capacityTarget: 0, tasks: 0, taskRows: [], shipBased: false }
const yardD = { id: 4, populationId: 8, colony: 'Beta', name: 'Yard D', type: 1, slipways: 3, capacity: 5000, tooledId: 100, retoolId: 101, taskType: 7, requiredBP: 1000, completedBP: 0, paused: false, capacityTarget: 0, tasks: 3, taskRows: [task(41), task(42), task(43)], shipBased: false }
const YARDS = [yardA, yardB, yardC, yardD]
const CLASSES = [{ id: 100, name: 'Alpha class', obsolete: true }, { id: 101, name: 'Beta class', obsolete: false }]

const fixtures = (m) => {
  const { provenance: p, g } = m
  const operations = g.shipyardOperations(HELD, version)
  const factorOne = p.ofRule({ rule: 'shipyardGrowth.operations', value: 1, inputs: { present: ['the Shipyard Operations levels the race holds'] }, units: '' })
  const none = g.shipyardOperations([], version)
  const price = (yard, over = {}) => g.slipwayPrice({ yard, operations, version, ...over })
  const step = (yard, tons) => g.capacityStepPrice({ yard, step: g.CAPACITY_STEPS.find((candidate) => candidate.tons === tons), operations, version })

  return { operations, factorOne, none, price, step }
}

const pure = (ctx) => {
  const { m } = ctx
  const { g, provenance: p, production } = m
  const f = fixtures(m)
  const { operations, none } = f
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const ruleOf = (result) => (result && result.rule ? result.rule.id : null)
  const missing = (result) => (result && result.inputs ? result.inputs.missing : null)
  const value = p.valueOrNull

  add('rules: the five rules are registered, 2.7.x, with the kind of check each is', () => {
    const expected = { 'shipyardGrowth.operations': 'confirmed', 'shipyardGrowth.slipwayPrice': 'confirmed', 'shipyardGrowth.capacityStep': 'confirmed', 'shipyardGrowth.capacityStepPattern': 'estimated', 'shipyardGrowth.continualPrice': 'estimated' }
    const bad = Object.entries(expected).filter(([id, verification]) => { const rule = p.getRule(id); return !rule || rule.verification !== verification || !rule.versions.includes('2.7.x') || rule.units !== (id === 'shipyardGrowth.operations' ? '' : 'BP') }).map(([id]) => id)

    return bad.length ? `wrong or missing: ${bad.join(', ')}` : true
  })

  // ----- the operations factor -----
  add('operations: the factor is the lowest multiplier of the levels held, a confirmed result of its rule', () => same([value(operations), operations.status, ruleOf(operations)], [0.8, 'confirmed', 'shipyardGrowth.operations']))
  add('operations: the order the levels are held in does not matter', () => same(value(g.shipyardOperations([...HELD].reverse(), version)), 0.8))
  add('operations: a race holding no level, or whose levels were not read, has no factor: unavailable and named, never 1 or 0', () => {
    const noRead = g.shipyardOperations(null, version)

    return same([none.status, value(none), missing(none).length > 0, noRead.status, value(noRead), missing(noRead).length > 0], ['unavailable', null, true, 'unavailable', null, true])
  })
  add('operations: a held level with no multiplier makes the factor unavailable and names the level', () => {
    const open = g.shipyardOperations([...HELD, { id: 3, name: 'Level 3', multiplier: null }], version)

    return same([open.status, value(open), missing(open)], ['unavailable', null, ['the multiplier of Level 3']])
  })
  add('operations: a save version the rule does not cover makes the factor estimated, not confirmed', () => same(g.shipyardOperations(HELD, '9.9').status, 'estimated'))

  // ----- the prices -----
  const naval = { type: 1, capacity: 5000, slipways: 4 }
  const commercial = { type: 2, capacity: 5000, slipways: 4 }
  const repair = { type: 3, capacity: 5000, slipways: 4 }
  const TONS = [500, 1000, 2000, 5000, 10000]

  add('price: a slipway is the capacity over 500 tons times 120 times the operations: 960 BP at a naval yard, a tenth of it at a commercial or repair yard', () => sameNumbers([naval, commercial, repair].map((yard) => value(f.price(yard))), [960, 96, 96]))
  add('price: a slipway follows the yard\'s capacity (1,000 t costs 19.2 BP at a repair yard, 12,000 t 2,304 BP at a naval yard)', () => sameNumbers([value(f.price({ type: 3, capacity: 1000, slipways: 1 })), value(f.price({ type: 1, capacity: 12000, slipways: 1 }))], [19.2, 2304]))
  add('price: the five capacity steps cost the slipways times 120 times the operations times 1, 2, 4, 10 and 20: 384, 768, 1,536, 3,840 and 7,680 BP at a naval yard of 4 slipways', () => sameNumbers(TONS.map((tons) => value(f.step(naval, tons))), [384, 768, 1536, 3840, 7680]))
  add('price: a commercial or repair yard pays a tenth for each step, and a step follows the slipways, not the capacity', () => sameNumbers([...TONS.map((tons) => value(f.step(commercial, tons))), value(f.step({ type: 1, capacity: 99999, slipways: 4 }, 1000)), value(f.step({ type: 1, capacity: 5000, slipways: 1 }, 1000))], [38.4, 76.8, 153.6, 384, 768, 768, 192]))
  add('price: the 500 and 2,000 ton steps are estimated results of the pattern rule, the others and the slipway confirmed', () => {
    const rows = g.upgradePrices({ yard: naval, operations, version })

    return same(rows.map((row) => [row.taskType, ruleOf(row.price), row.price.status]), [[1, 'shipyardGrowth.slipwayPrice', 'confirmed'], [2, 'shipyardGrowth.capacityStepPattern', 'estimated'], [3, 'shipyardGrowth.capacityStep', 'confirmed'], [4, 'shipyardGrowth.capacityStepPattern', 'estimated'], [5, 'shipyardGrowth.capacityStep', 'confirmed'], [6, 'shipyardGrowth.capacityStep', 'confirmed']])
  })
  add('price: a step is labelled with the upgrade of its type and a slipway with the yard\'s type unpriced where the rules do not cover it', () => {
    const rows = g.upgradePrices({ yard: naval, operations, version })

    return same(rows.map((row) => row.label), [1, 2, 3, 4, 5, 6].map((type) => g.SHIPYARD_UPGRADE_TYPES[type]))
  })
  add('price: a yard type the rules do not cover is unavailable and says so; a yard with no type, capacity or slipways names that input', () => {
    const other = f.price({ type: 4, capacity: 5000, slipways: 4 })
    const typeless = f.price({ type: null, capacity: 5000, slipways: 4 })
    const noCapacity = f.price({ type: 1, capacity: null, slipways: 4 })
    const noSlipways = f.step({ type: 1, capacity: 5000, slipways: null }, 1000)

    return same([other.status, missing(other), typeless.status, missing(typeless), noCapacity.status, missing(noCapacity), noSlipways.status, missing(noSlipways), value(other)], ['unavailable', ['the rules for yard type 4'], 'unavailable', ['the yard\'s type'], 'unavailable', ['the yard\'s capacity'], 'unavailable', ['the yard\'s slipways'], null])
  })
  add('price: a price that needs no slipways is not held up by a yard that has none stored, and a step with no capacity stored still prices', () => same([f.price({ type: 1, capacity: 5000, slipways: null }).status, f.step({ type: 1, capacity: null, slipways: 4 }, 1000).status], ['confirmed', 'confirmed']))
  add('price: a yard that belongs to a ship has no price and no time, naming that it cannot be modified, in the slipway, every step and the continual upgrade; a yard whose ship link is not stored names that; a yard of no ship prices as before', () => {
    const shipBased = { ...naval, shipBased: true }
    const unknown = { ...naval, shipBased: null }
    const rows = g.upgradePrices({ yard: shipBased, operations, version })
    const continual = g.continualPrice({ yard: shipBased, target: 15000, operations, version })
    const times = [...rows.map((row) => g.upgradeTime(MODIFIERS, shipBased, row.taskType, row.price).result), g.continualTime(MODIFIERS, shipBased, 15000, continual).result]
    const gaps = g.upgradePrices({ yard: unknown, operations, version }).map((row) => missing(row.price))

    return same([rows.every((row) => row.price.status === 'unavailable' && value(row.price) === null && missing(row.price).includes(g.SHIP_BASED_GAP)), continual.status, missing(continual).includes(g.SHIP_BASED_GAP), times.every((result) => result.status === 'unavailable' && value(result) === null), gaps.every((list) => list.includes('whether the yard belongs to a ship')), value(f.price({ ...naval, shipBased: false }))], [true, 'unavailable', true, true, true, 960])
  })
  add('price: with no operations factor every price is unavailable and carries what the factor lacks, never a price of 0', () => {
    const rows = g.upgradePrices({ yard: naval, operations: none, version })
    const continual = g.continualPrice({ yard: naval, target: 9000, operations: none, version })

    return same([rows.every((row) => row.price.status === 'unavailable' && value(row.price) === null && missing(row.price).includes('a Shipyard Operations level the race holds')), continual.status, missing(continual).includes('a Shipyard Operations level the race holds')], [true, 'unavailable', true])
  })
  add('price: no price of any yard is NaN, infinite or below 0', () => {
    const rows = [naval, commercial, repair, { type: 1, capacity: 0, slipways: 0 }].flatMap((yard) => g.upgradePrices({ yard, operations, version }).map((row) => value(row.price)).filter((item) => item !== null))

    return rows.length && finiteAll(rows) && rows.every((item) => item >= 0) ? true : short(rows)
  })

  // ----- the continual upgrade -----
  add('continual: the price is the tons added over 500 times the slipways times 120 times the operations: 7,680 BP for 10,000 t at a naval yard of 4 slipways, a tenth at a commercial yard, an estimated result of its rule', () => {
    const naval7680 = g.continualPrice({ yard: naval, target: 15000, operations, version })
    const commercial768 = g.continualPrice({ yard: commercial, target: 15000, operations, version })

    return same([value(naval7680), naval7680.status, ruleOf(naval7680), near(value(commercial768), 768)], [7680, 'estimated', 'shipyardGrowth.continualPrice', true])
  })
  add('continual: the price per ton is the fixed steps\' (10,000 t costs what the 10,000 ton step does)', () => sameNumber(value(g.continualPrice({ yard: naval, target: 15000, operations, version })), value(f.step(naval, 10000))))
  add('continual: no target, or a target at or below the capacity, is unavailable and names the target', () => {
    const none1 = g.continualPrice({ yard: naval, target: null, operations, version })
    const equal = g.continualPrice({ yard: naval, target: 5000, operations, version })
    const below = g.continualPrice({ yard: naval, target: 100, operations, version })

    return same([none1.status, missing(none1), equal.status, missing(equal), below.status, value(below)], ['unavailable', ['a target capacity'], 'unavailable', ['a target capacity above the yard\'s capacity'], 'unavailable', null])
  })
  add('continual: a target one ton above the capacity takes one construction period (10 days), a result of the Recap\'s stepping rule', () => {
    const target = 5001
    const priced = g.continualPrice({ yard: naval, target, operations, version })
    const time = g.continualTime(MODIFIERS, naval, target, priced)

    return same([value(time.result), time.idle, ruleOf(time.result)], [10, false, 'production.shipyardContinual'])
  })
  add('continual: a farther target takes the Recap\'s days exactly, and more days than the nearer one', () => {
    const target = 15000
    const priced = g.continualPrice({ yard: naval, target, operations, version })
    const time = g.continualTime(MODIFIERS, naval, target, priced)
    const recap = production.shipyardContinualDays(MODIFIERS, { SYType: 1, Capacity: 5000, Slipways: 4, CapacityTarget: target })
    const nearer = g.continualTime(MODIFIERS, naval, 6000, g.continualPrice({ yard: naval, target: 6000, operations, version }))

    return value(time.result) > value(nearer.result) && value(nearer.result) > 10 ? sameNumber(value(time.result), value(recap.result)) : `the days do not grow with the target: ${value(nearer.result)}, ${value(time.result)}`
  })
  add('continual: a target that would take more than the most construction periods is refused at once, naming the limit, not stepped', () => {
    const began = Date.now()
    const target = 1e12
    const time = g.continualTime(MODIFIERS, naval, target, g.continualPrice({ yard: naval, target, operations, version }))

    return Date.now() - began < 2000 && time.result.status === 'unavailable' && missing(time.result).some((text) => text.includes('construction periods')) ? true : `${Date.now() - began} ms, ${short(time.result)}`
  })
  add('continual: a target of a few hundred periods is timed, not refused', () => {
    const target = 15000
    const time = g.continualTime(MODIFIERS, naval, target, g.continualPrice({ yard: naval, target, operations, version }))

    return time.result.status !== 'unavailable' && value(time.result) > 100 ? true : short(time.result)
  })
  add('continual: with no price or no modifiers the time is unavailable and names what is missing', () => {
    const priceless = g.continualTime(MODIFIERS, naval, null, g.continualPrice({ yard: naval, target: null, operations, version }))
    const modifierless = g.continualTime(undefined, naval, 9000, g.continualPrice({ yard: naval, target: 9000, operations, version }))

    return same([priceless.result.status, modifierless.result.status, missing(modifierless.result).length > 0], ['unavailable', 'unavailable', true])
  })

  // ----- the times -----
  add('time: a fixed upgrade takes its price over the yard\'s modification rate (960 BP at 1,000 BP a year: 350.4 days), a result of the Recap\'s activity finish', () => {
    const time = g.upgradeTime(MODIFIERS, naval, 1, f.price(naval))

    return same([value(time.result), time.idle, ruleOf(time.result)], [350.4, false, 'production.shipyardUpgradeFinish'])
  })
  add('time: the modification rate rises with the capacity and a commercial yard\'s is lower (1,000 and 550 BP a year at 5,000 t)', () => sameNumbers([value(g.modificationRate(MODIFIERS, naval)), value(g.modificationRate(MODIFIERS, commercial)), value(g.modificationRate(MODIFIERS, { ...naval, capacity: 10000 }))], [1000, 550, 1500]))
  add('time: an upgrade with no price or no colony modifiers is unavailable and names the input, never a time of 0', () => {
    const priceless = g.upgradeTime(MODIFIERS, naval, 1, none)
    const modifierless = g.upgradeTime(undefined, naval, 1, f.price(naval))

    return same([priceless.result.status, value(priceless.result), modifierless.result.status, missing(modifierless.result).length > 0], ['unavailable', null, 'unavailable', true])
  })
  add('time: a yard\'s own activity takes its build points left over its rate (600 BP at 550 a year: 398.18 days); a retool is shared among the slipways; a paused activity has no time and is idle', () => {
    const upgrade = g.activityFinish(MODIFIERS, yardB)
    const retool = g.activityFinish(MODIFIERS, yardD)
    const paused = g.activityFinish(MODIFIERS, { ...yardB, paused: true })

    return sameNumbers([value(upgrade.result), value(retool.result)], [(600 / 550) * 365, (1000 / 1000) * 365 / 3]) === true && paused.idle === true && value(paused.result) === null ? true : short([upgrade, retool, paused])
  })
  add('time: a continual activity is the Recap\'s stepping rule, a result of production.shipyardContinual', () => {
    const yard = { ...yardA, taskType: 8, capacityTarget: 5001, requiredBP: 0 }

    return same([value(g.activityFinish(MODIFIERS, yard).result), ruleOf(g.activityFinish(MODIFIERS, yard).result)], [10, 'production.shipyardContinual'])
  })
  add('time: a task takes its remaining build points over the colony\'s rate for its class: 5,250 BP at 10,500 a year is 182.5 days at a naval yard, 3,000 BP at 3,000 a year 365 days at a commercial one', () => {
    const naval1 = g.taskFinish(MODIFIERS, yardA, yardA.taskRows[0])
    const commercial1 = g.taskFinish(MODIFIERS, yardB, yardB.taskRows[0])

    return sameNumbers([value(naval1.result), value(commercial1.result)], [182.5, 365]) === true && ruleOf(naval1.result) === 'production.shipFinish' ? true : short([naval1, commercial1])
  })
  add('time: a paused task is idle with no time, a task whose pause flag is not stored is unavailable', () => {
    const paused = g.taskFinish(MODIFIERS, yardA, { ...yardA.taskRows[0], paused: true })
    const unknown = g.taskFinish(MODIFIERS, yardA, { ...yardA.taskRows[0], paused: null })

    return same([paused.idle, value(paused.result), unknown.idle, unknown.result.status], [true, null, false, 'unavailable'])
  })
  add('time: a task of a class with no size, or a yard with no type, is unavailable and named', () => {
    const sizeless = g.taskFinish(MODIFIERS, yardA, { ...yardA.taskRows[0], size: null })
    const typeless = g.taskFinish(MODIFIERS, { ...yardA, type: null }, yardA.taskRows[0])

    return same([sizeless.result.status, typeless.result.status, missing(sizeless.result).includes('the class\'s size'), missing(typeless.result).includes('the shipyard\'s type')], ['unavailable', 'unavailable', true, true])
  })

  // ----- the labels -----
  add('labels: the task and upgrade labels the Recap and the yards share', () => same([g.SHIPYARD_TASK_TYPES, g.SHIPYARD_UPGRADE_TYPES], [{ 0: 'Construction', 1: 'Repair', 2: 'Refit', 3: 'Scrap', 4: 'Auto refit' }, { 1: 'Add slipway', 2: 'Add 500 ton capacity', 3: 'Add 1,000 ton capacity', 4: 'Add 2,000 ton capacity', 5: 'Add 5,000 ton capacity', 6: 'Add 10,000 ton capacity', 7: 'Retool', 8: 'Continual capacity upgrade', 9: 'Spacemaster modification' }]))
  add('labels: the Recap imports the labels and defines none of its own', () => {
    const recap = ctx.sourceText.PR

    return /import \{ SHIPYARD_TASK_TYPES, SHIPYARD_UPGRADE_TYPES \} from '\.\.\/utilities\/shipyard-growth'/.test(recap) && !/const SHIPYARD_(TASK|UPGRADE)_TYPES =/.test(recap) ? true : 'the Recap defines the labels or does not import them'
  })

  // ----- the Tech Tree lines -----
  add('techtree: the build rate line (Improved Shipbuilding Rate, 30) opens Yards and the Shipyard Operations line (158) opens Growth', () => same([g.SHIPYARD_TECH_VIEWS[30], g.SHIPYARD_TECH_VIEWS[158], g.OPERATIONS_TECH_TYPE, Object.keys(g.SHIPYARD_TECH_VIEWS)], ['yards', 'growth', 158, ['30', '158']]))

  return statements
}

// ---------- the loaders, on an in-memory save that is always there ----------

const rawQuery = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
  const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
  const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

  raw.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve([rows])))
})

const execOf = (raw, sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

// Race 1 of game 1: yard 1 (naval) with three tasks (a construction of class 10, a refit of class 10 to 11 that is paused and a construction of class 11 whose pause flag is not stored), an activity of 800 BP with 200 done, and yard 2 (repair) with nothing; yard 3 belongs to race 2. The race holds Shipyard Operations levels 1 (1.0) and 2 (0.8) and another tech type; race 2 holds level 3. The task table, the activity columns and the levels come whole or are left out.
const loaderSql = (shape) => `
create table FCT_Population (PopulationID integer, PopName text);
insert into FCT_Population values (7, 'Alpha'), (8, 'Beta');
create table FCT_ShipClass (ShipClassID integer, ClassName text, Size real);
insert into FCT_ShipClass values (10, 'Ten', 2000), (11, 'Eleven', 3000);
create table FCT_Shipyard (ShipyardID integer, GameID integer, RaceID integer, PopulationID integer, ShipyardName text, SYType integer, Slipways integer, Capacity real, BuildClassID integer, TaskType integer${shape === 'plain' ? '' : ', RetoolClassID integer, RequiredBP real, CompletedBP real, PauseActivity integer, CapacityTarget real, ParentShipID integer'});
${shape === 'plain' ? 'insert into FCT_Shipyard values (1, 1, 1, 7, \'Yard 1\', 1, 4, 5000, 10, 3), (2, 1, 1, 8, \'Yard 2\', 3, 1, 1000, 0, 0), (3, 1, 2, 8, \'Yard 3\', 1, 1, 100, 0, 0);' : 'insert into FCT_Shipyard values (1, 1, 1, 7, \'Yard 1\', 1, 4, 5000, 10, 3, 0, 800, 200, 0, 0, 0), (2, 1, 1, 8, \'Yard 2\', 3, 1, 1000, 0, 0, 0, 0, 0, null, 0, 5), (3, 1, 2, 8, \'Yard 3\', 1, 1, 100, 0, 0, 0, 0, 0, 0, 0, 0);'}
${shape === 'notasks' ? '' : 'create table FCT_ShipyardTask (TaskID integer, GameID integer, RaceID integer, ShipyardID integer, TaskTypeID integer, ClassID integer, RefitID integer, UnitName text, TotalBP real, CompletedBP real, Paused integer);'}
${shape === 'notasks' ? '' : 'insert into FCT_ShipyardTask values (101, 1, 1, 1, 0, 10, 0, \'First\', 6000, 750, 0), (102, 1, 1, 1, 2, 10, 11, null, 10500, 500, 1), (103, 1, 2, 3, 0, 11, 0, \'Other race\', 100, 0, 0), (104, 1, 1, 1, 0, 11, 0, \'Third\', 300, 0, null);'}
create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer);
insert into FCT_RaceTech values (1, 1, 1), (1, 1, 2), (1, 1, 3), (1, 1, 4), (1, 2, 5), (2, 1, 6);
create table FCT_TechSystem (TechSystemID integer, Name text, TechTypeID integer, AdditionalInfo real);
insert into FCT_TechSystem values (1, 'Operations A', 158, 1.0), (2, 'Operations B', 158, 0.8), (3, 'Operations C', 158, null), (4, 'Build rate', 30, 2.0), (5, 'Operations D', 158, 0.5), (6, 'Operations E', 158, 0.1);
`

const loadedYards = async (m, shape) => {
  const raw = new sqlite3.Database(':memory:')

  try {
    await execOf(raw, loaderSql(shape))

    return { yards: await m.refits.loadYards({ query: rawQuery(raw) }, { GameID: 1, RaceID: 1 }), levels: await m.g.loadShipyardOperations({ query: rawQuery(raw) }, { GameID: 1, RaceID: 1 }) }
  } finally {
    raw.close()
  }
}

const loader = (ctx) => {
  const { m } = ctx
  const statements = []
  const reads = {}
  const read = (shape = 'full') => (reads[shape] = reads[shape] || loadedYards(m, shape))
  const add = (name, test) => statements.push([name, test])

  add('loader: the levels the race holds are its Shipyard Operations techs only (not another type, race or game), cheapest multiplier first, a multiplier the save leaves out as null', async () => same((await read()).levels, [{ id: 3, name: 'Operations C', multiplier: null }, { id: 2, name: 'Operations B', multiplier: 0.8 }, { id: 1, name: 'Operations A', multiplier: 1 }]))
  add('loader: the yards of the race only, each with its tasks as rows: a yard with three tasks has all, a yard with none a real empty list and a count of 0', async () => {
    const { yards } = await read()

    return same([yards.map((yard) => yard.id), yards.map((yard) => yard.tasks), yards.map((yard) => yard.taskRows.length)], [[1, 2], [3, 0], [3, 0]])
  })
  add('loader: a task row carries its type, class, refit target, name, build points, what is left, its pause flag and the class\'s size', async () => {
    const { yards } = await read()

    return same(yards[0].taskRows.map((row) => [row.id, row.taskType, row.classId, row.className, row.refitId, row.name, row.totalBP, row.completedBP, row.remaining, row.paused, row.size]), [[101, 0, 10, 'Ten', null, 'First', 6000, 750, 5250, false, 2000], [102, 2, 10, 'Ten', 11, null, 10500, 500, 10000, true, 2000], [104, 0, 11, 'Eleven', null, 'Third', 300, 0, 300, null, 3000]])
  })
  add('loader: the activity is read with the yard: its type, the build points and what is done, the pause flag (0 and 1 as false and true) and the capacity target', async () => {
    const { yards } = await read()

    return same([yards[0].taskType, yards[0].requiredBP, yards[0].completedBP, yards[0].paused, yards[0].capacityTarget, yards[1].paused], [3, 800, 200, false, 0, null])
  })
  add('loader: the rows and the task rows are frozen', async () => {
    const { yards } = await read()

    return Object.isFrozen(yards) && Object.isFrozen(yards[0]) && Object.isFrozen(yards[0].taskRows) && Object.isFrozen(yards[0].taskRows[0]) ? true : 'a row or the list can be changed'
  })
  add('loader: a save with no task table gives no task rows (null, not an empty list) and no count', async () => {
    const { yards } = await read('notasks')

    return same([yards.map((yard) => yard.taskRows), yards.map((yard) => yard.tasks)], [[null, null], [null, null]])
  })
  add('loader: a save whose yards lack the activity columns gives null for each, never 0, and still lists the tasks', async () => {
    const { yards } = await read('plain')

    return same([yards[0].requiredBP, yards[0].completedBP, yards[0].paused, yards[0].capacityTarget, yards[0].taskRows.length, yards[0].taskType], [null, null, null, null, 3, 3])
  })

  return statements
}

// ---------- the page ----------

const page = (ctx) => {
  const { m, pageOptions, persistedOptions, pageText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const make = (data = {}) => instantiate(pageOptions, {
    $store: { getters: {} },
    database: null,
    GameID: 1,
    RaceID: 1,
    data: { yards: YARDS, refitData: { classes: CLASSES, components: {} }, formulaVersion: version, shipyardOperationsHeld: HELD, populationProductionModifiers: { 7: MODIFIERS, 8: MODIFIERS }, shipCounts: {}, refitTasks: [], retoolTasks: [], platformSources: { extras: {}, colonies: {}, researched: null }, setUnsaved(name, value) { this[name] = value }, ...data },
  })
  const rowOf = (vm, id) => vm.inventoryRows.find((row) => row.id === id)
  const value = m.provenance.valueOrNull

  add('page-rows: every own yard is one row, in the order read, the zero-task yard among them', () => same(make().inventoryRows.map((row) => row.id), [1, 2, 3, 4]))
  add('page-rows: a yard\'s tasks are lines with their label, subject and time left as the Recap times them (182.5 and 365 days at yard A; the refit names its target class)', () => {
    const lines = rowOf(make(), 1).taskLines

    return same([lines.map((line) => line.label), lines.map((line) => line.subject), lines.map((line) => line.days)], [['Construction', 'Refit'], ['Alpha class', 'Alpha class to Beta class'], [182.5, 365]])
  })
  add('page-rows: a task line carries the Recap\'s task rate in BP a year (10,500 at the naval yard, a quarter weight at the commercial one) with its result, the shared rate of the class and the yard type', () => {
    const rate = (size, modifier) => m.production.shipRate(MODIFIERS, { Size: size, CommercialModifier: modifier })
    const naval = rowOf(make(), 1).taskLines[0]
    const commercial = rowOf(make(), 2).taskLines[0]

    return same([naval.rate, commercial.rate, naval.rateResult.rule.id, naval.rateResult.status], [value(rate(2000, 1)), value(rate(2000, 0.25)), 'production.shipRate', rate(2000, 1).status]) === true && naval.rate === 10500 && commercial.rate === 3000 ? true : short([naval.rate, commercial.rate])
  })
  add('page-rows: a yard that belongs to a ship stays a row, marked, with no add-slipway price and no price or time in its growth rows; a yard of no ship is not marked', () => {
    const vm = make({ yards: [{ ...yardA, shipBased: true }, yardB] })
    const [ship, plain] = vm.inventoryRows
    const growth = vm.growthOf(vm.yards[0], 15000)

    return same([vm.inventoryRows.length, ship.shipBased, plain.shipBased, ship.slipwayBP, ship.slipwayResult.status, growth.rows.length, growth.rows.every((row) => row.price.status === 'unavailable' && row.days === null)], [2, true, false, null, 'unavailable', 7, true])
  })
  add('page-rows: the free slipways are the slipways less the tasks, as the yard eligibility counts them, and a yard with every slipway working shows 0', () => same(make().inventoryRows.map((row) => [row.freeSlipways, row.slipwaysText]), [[2, '2 of 4'], [1, '1 of 2'], [1, '1 of 1'], [0, '0 of 3']]))
  add('page-rows: a yard\'s own activity is its label, what it is for and its time: an upgrade at yard B, a retool for class 101 at yard D, nothing at A and C', () => {
    const rows = make().inventoryRows

    return same([rows.map((row) => (row.activity ? row.activity.label : null)), rows.map((row) => (row.activity ? row.activity.detail : null)), sameNumbers([rows[1].activity.days, rows[3].activity.days], [(600 / 550) * 365, 365 / 3])], [[null, 'Add 1,000 ton capacity', null, 'Retool'], [null, '25% done', null, 'to Beta class · 0% done'], true])
  })
  add('page-rows: the price to add a slipway is on every row, 960 BP at yard A, 96 at the commercial yard B, 19.2 at the repair yard C', () => {
    const rows = make().inventoryRows

    return sameNumbers(rows.slice(0, 3).map((row) => row.slipwayBP), [960, 96, 19.2])
  })
  add('page-rows: the tooled class is named and its obsolete mark shown; a yard with none tooled says none, a yard whose class is not read is not known', () => {
    const rows = make({ yards: [yardA, yardB, { ...yardC, tooledId: undefined }] }).inventoryRows

    return same([rows[0].tooledName, rows[0].tooled.obsolete, rows[1].tooled, rows[2].tooled], ['Alpha class', true, null, undefined])
  })
  add('page-rows: a yard with no task table shows the tasks as not known, with a result naming what is missing, not as none', () => {
    const row = make({ yards: [{ ...yardA, tasks: null, taskRows: null }] }).inventoryRows[0]

    return same([row.taskCount, row.taskLines, row.slipwaysText, row.taskGap.status, row.slipwaysGap.status], [null, null, '', 'unavailable', 'unavailable'])
  })
  add('page-rows: the free-slipway filter leaves out only the yards with every slipway working, not the yards with no task', () => same(make({ idleOnly: true }).inventoryRows.map((row) => row.id), [1, 2, 3]))
  add('page-rows: the colony filter and the search limit the rows (colony 8 gives yards C and D; "beta" the same; "yard b" one)', () => same([make({ colonyId: 8 }).inventoryRows.map((row) => row.id), make({ yardSearch: 'beta' }).inventoryRows.map((row) => row.id), make({ yardSearch: ' yard b ' }).inventoryRows.map((row) => row.id)], [[3, 4], [3, 4], [2]]))
  add('page-rows: with no yard the list is empty with the hint that the race has none; a colony of no yard has its own hint', () => {
    const none = make({ yards: [] })
    const colony = make({ colonyId: 99 })

    return same([none.inventoryRows.length, none.inventoryHint, colony.inventoryRows.length, colony.inventoryHint], [0, 'The race has no shipyard.', 0, 'The colony named by the link has no shipyard of the race.'])
  })
  add('page-rows: no figure of any row is NaN or infinite', () => (finiteAll(make().inventoryRows.map((row) => [row.slipwayBP, row.freeSlipways, row.activitySort, row.taskLines.map((line) => line.days)])) ? true : 'a figure is NaN or infinite'))

  add('growth: the rows are the slipway, the five steps and the continual upgrade, with the prices and times worked by hand at yard A', () => {
    const growth = make().growthOf(yardA, 15000)
    const recap = m.production.shipyardContinualDays(MODIFIERS, { SYType: 1, Capacity: 5000, Slipways: 4, CapacityTarget: 15000 })

    return same(growth.rows.map((row) => row.key), ['slipway', 'step-500', 'step-1000', 'step-2000', 'step-5000', 'step-10000', 'continual']) === true && sameNumbers(growth.rows.map((row) => value(row.price)), [960, 384, 768, 1536, 3840, 7680, 7680]) === true && sameNumbers(growth.rows.map((row) => row.days), [350.4, 140.16, 280.32, 560.64, 1401.6, 2803.2, value(recap.result)]) === true ? true : short(growth.rows.map((row) => [row.key, value(row.price), row.days]))
  })
  add('growth: only the continual row is approximate, and the rate is the yard\'s modification rate', () => {
    const growth = make().growthOf(yardA, 15000)

    return same([growth.rows.map((row) => row.approx), value(growth.rate)], [[false, false, false, false, false, false, true], 1000])
  })
  add('growth: with no target the continual row is left out, and the longest time is the longest of the rows', () => {
    const growth = make().growthOf(yardA)

    return same([growth.rows.length, near(growth.longest, 2803.2)], [6, true])
  })
  add('growth: the target starts at the capacity and 10,000 t, a target typed replaces it, and a blank, 0, a negative or a non-number is none', () => {
    const vm = make()
    const start = vm.growthTargetFor(yardA)

    vm.setTarget('12000')
    const typed = vm.growthTarget

    const rejected = ['', '  ', '0', '-5', 'abc', null].map((text) => { vm.setTarget(text); return vm.growthTarget })

    return same([start, typed, rejected, vm.growthTargetFor(yardA)], [15000, 12000, [null, null, null, null, null, null], 15000])
  })
  add('growth: the Growth view prices the yard picked, the first yard while none is picked, and says so for a yard the race does not have', () => {
    const picked = make({ yardId: 2 })
    const first = make({ yardId: null })
    const stale = make({ yardId: 99 })

    return same([picked.growthYard.id, first.growthYard.id, stale.growthYard, stale.growth, stale.growthHint, make({ yards: [], yardId: null }).growthHint], [2, 1, null, null, 'The yard named by the link is not one of the race\'s yards.', 'The race has no shipyard.'])
  })
  add('growth: with no operations factor the prices are unavailable and the rows say so, with no time of 0', () => {
    const growth = make({ shipyardOperationsHeld: [] }).growthOf(yardA, 15000)

    return growth.rows.every((row) => row.price.status === 'unavailable' && row.days === null) ? true : short(growth.rows.map((row) => [row.key, row.price.status, row.days]))
  })

  add('tiles: the Yards and Growth views\' tiles are the counts of the yards: 4 yards (2 naval, 1 commercial, 1 repair), 4 of 10 slipways free, 6 tasks and 2 activities, operations 0.8', () => {
    const tiles = make().yardTiles

    return same([tiles.map((tile) => tile.label), tiles.map((tile) => tile.value), tiles[0].note, tiles[2].note], [['Shipyards', 'Free slipways', 'Work running', 'Shipyard operations'], ['4', '4 of 10', '6 tasks', '0.8'], '2 naval, 1 commercial, 1 repair', '2 yard activities (upgrades and retools)'])
  })
  add('tiles: the operations tile is a dash with its result unavailable when the race holds no level, and the tiles are the same on the Growth view', () => {
    const tiles = make({ shipyardOperationsHeld: [] }).yardTiles
    const vm = make({ view: 'growth' })

    return same([tiles[3].value, tiles[3].result.status, vm.tiles.map((tile) => tile.label)], ['—', 'unavailable', ['Shipyards', 'Free slipways', 'Work running', 'Shipyard operations']])
  })
  add('tiles: a yard whose slipway or task count is not known is not counted in the free slipways, and the note says how many', () => {
    const tile = make({ yards: [yardA, { ...yardB, tasks: null, taskRows: null }] }).yardTiles[1]

    return same([tile.value, tile.note], ['2 of 4', '1 yard with a slipway or task count not known, not counted'])
  })

  // ----- the link keys -----
  const shape = (vm) => [vm.view, vm.yardId, vm.colonyId, vm.fromId, vm.toId, vm.operation, vm.expanded]
  const apply = (query, data = {}) => { const vm = make(data); vm.applyLink(query); return vm }

  add('links: a yard link opens Yards with the yard picked and opened; a colony alone opens Yards limited to the colony', () => same([shape(apply({ yard: '2' })), shape(apply({ colony: '7' }))], [['yards', 2, null, null, null, 'build', [{ id: 2 }]], ['yards', null, 7, null, null, 'build', []]]))
  add('links: a yard the link names stays in the list under the saved free-slipway filter (a full yard) and the saved search (another yard\'s name), and only that yard; the saved filters are left as they were', () => {
    const full = apply({ yard: '4' }, { idleOnly: true })
    const searched = apply({ yard: '2' }, { yardSearch: 'beta' })
    const other = apply({ yard: '1' }, { idleOnly: true })

    const later = apply({ yard: '4' }, { idleOnly: true })

    later.applyLink({ colony: '8' })

    return same([full.inventoryRows.map((row) => row.id), searched.inventoryRows.map((row) => row.id), other.inventoryRows.map((row) => row.id), [full.idleOnly, searched.yardSearch], make({ idleOnly: true }).inventoryRows.map((row) => row.id), later.inventoryRows.map((row) => row.id)], [[1, 2, 3, 4], [2, 3, 4], [1, 2, 3], [true, 'beta'], [1, 2, 3], [3]])
  })
  add('links: view=growth opens Growth with the yard picked, and keeps the pick when the link names none (a Tech Tree link)', () => same([shape(apply({ view: 'growth', yard: '3' })), shape(apply({ view: 'growth' }, { yardId: 2 }))], [['growth', 3, null, null, null, 'build', [{ id: 3 }]], ['growth', 2, null, null, null, 'build', []]]))
  add('links: a pair opens Refits as it did, and view=classes keeps its operation and class (from only for a refit)', () => same([shape(apply({ from: '100', to: '101' })), shape(apply({ view: 'classes', operation: 'repair', to: '101' })), shape(apply({ view: 'classes', operation: 'bogus', to: '101' }))], [['refits', null, null, 100, 101, 'build', []], ['classes', null, null, null, 101, 'repair', []], ['classes', null, null, null, 101, 'build', []]]))
  add('links: a named view wins over a yard (view=refits with a yard is Refits), a repeated or unknown view is read as the router gives it', () => same([apply({ view: 'refits', yard: '3' }).view, apply({ view: ['growth', 'yards'] }).view, apply({ view: 'nonsense' }).view, apply({ view: 'nonsense', yard: '3' }).view], ['refits', 'growth', 'refits', 'yards']))
  add('links: an id that is not a whole number above 0 is no yard, no colony and no class', () => same(shape(apply({ yard: 'x', colony: '-1', from: '0', to: '1.5' })), ['refits', null, null, null, null, 'build', []]))
  add('links: each view writes its own query and applying it gives the view back with its focus', () => {
    const cases = [{ view: 'yards', yardId: 2, colonyId: 7 }, { view: 'growth', yardId: 3 }, { view: 'refits', fromId: 100, toId: 101 }, { view: 'classes', operation: 'refit', fromId: 100, toId: 101 }]
    const bad = cases.filter((data) => {
      const written = make(data).linkQuery
      const back = apply(m.deepLinks.cleanQuery(written), { yardId: null })
      const again = back.linkQuery

      return m.deepLinks.sameQuery(written, again) !== true || back.view !== data.view
    })

    return bad.length ? `did not round trip: ${short(bad)}` : true
  })
  add('links: the page is labelled by its focus: the yard of the Yards and Growth views', () => same([make({ view: 'growth', yardId: 2 }).linkLabel, make({ view: 'yards', yardId: 3 }).linkLabel, make({ view: 'yards', yardId: null }).linkLabel], ['Growth of Yard B', 'Yard C', null]))
  add('links: linkTo.shipyards writes the view, yard, colony, operation, from and to, class as the Class to yards view, and nothing for what is left out', () => {
    const { linkTo } = m.deepLinks

    return same([linkTo.shipyards({ yard: 5 }), linkTo.shipyards({ colony: 7 }), linkTo.shipyards({ view: 'growth' }), linkTo.shipyards({ from: 1, to: 2 }), linkTo.shipyards({ class: 9 }), linkTo.shipyards({ class: 9, operation: 'repair' }), linkTo.shipyards({ view: 'classes', operation: 'refit', from: 1, to: 2 }), linkTo.shipyards()], [{ path: '/shipyards', query: { yard: '5' } }, { path: '/shipyards', query: { colony: '7' } }, { path: '/shipyards', query: { view: 'growth' } }, { path: '/shipyards', query: { from: '1', to: '2' } }, { path: '/shipyards', query: { view: 'classes', to: '9' } }, { path: '/shipyards', query: { view: 'classes', operation: 'repair', to: '9' } }, { path: '/shipyards', query: { view: 'classes', operation: 'refit', from: '1', to: '2' } }, { path: '/shipyards', query: {} }])
  })

  // ----- the page's text -----
  const cards = pageText.match(/<v-card [^>]*class="panel"[^>]*>/g) || []

  add('page-template: the template compiles', () => { const errors = templateErrors(pageText); return errors.length ? errors.join('; ') : true })
  add('page-template: every section panel carries a data-summary, and the two new panels\' summaries have no figure and no first or second person', () => {
    const bare = cards.filter((card) => !/ :?data-summary="/.test(card))
    const summaries = ['view === \'yards\'', 'view === \'growth\''].map((gate) => (cards.find((card) => card.includes(`v-if="${gate}"`)) || '').match(/ data-summary="([^"]*)"/))
    const bad = summaries.map((match, index) => (!match ? `panel ${index} has none` : /\d/.test(match[1]) ? `panel ${index} has a figure` : /\b(I|me|my|mine|you|your|we|our)\b/i.test(match[1]) ? `panel ${index} is not impersonal` : '')).filter(Boolean)

    return bare.length || bad.length ? `${bare.length} panels without, ${bad.join('; ')}` : cards.length >= 6 ? true : `only ${cards.length} panels found`
  })
  add('page-template: the views are Yards, Growth, Refits and Class to yards, in that order, and Yards is the default', () => (/const VIEW_OPTIONS = \[\{ value: 'yards', label: 'Yards' \}, \{ value: 'growth', label: 'Growth' \}, \{ value: 'refits', label: 'Refits' \}, \{ value: 'classes', label: 'Class to yards' \}\]/.test(pageText) && make().view === 'yards' ? true : 'the views or the default differ'))
  add('page-template: the Yards and Growth panels are only on their views, the eligibility and running panels only on Refits and Class to yards, the platform comparison only on Class to yards', () => {
    const wanted = ['<v-card v-if="view === \'yards\'" class="panel"', '<v-card v-if="view === \'growth\'" class="panel"', '<v-card v-if="view === \'refits\' || view === \'classes\'" class="panel" :data-summary="yardsSummary"', '<v-card v-if="(view === \'refits\' || view === \'classes\') && runningRows.length" class="panel"', '<platform-paths v-if="view === \'classes\'"']

    return wanted.filter((text) => !pageText.includes(text)).length ? `missing: ${wanted.filter((text) => !pageText.includes(text)).join(' | ')}` : true
  })
  add('page-template: the yard list is a table of one row per yard with the columns Yard, Type, Free slipways, Capacity, Tooled for, Tasks, Activity and Add slipway, an expandable row, and the unknown sorted last', () => {
    const headers = (pageText.match(/const INVENTORY_HEADERS = \[([\s\S]*?)\n\]/) || ['', ''])[1].match(/text: '([^']+)'/g) || []

    return same(headers.map((text) => text.slice(7, -1)), ['Yard', 'Type', 'Free slipways', 'Capacity (t)', 'Tooled for', 'Tasks', 'Activity', 'Add slipway']) === true && pageText.includes(':items="inventoryRows"') && pageText.includes('show-expand') && /:items="inventoryRows"[^>]*:custom-sort="sortNullLast"/.test(pageText) ? true : 'the table differs'
  })
  add('page-template: the task table has the Rate (BP/yr) column with the rate\'s mark, the yard rows and the growth panel say a ship-based yard cannot be modified', () => same([pageText.includes('<th class="text-right">Rate (BP/yr)</th>'), pageText.includes('<provenance-mark :result="line.rateResult" />'), count(pageText, 'does not let be modified: no upgrade is priced.'), pageText.includes('v-if="item.shipBased === true" x-small')], [true, true, 2, true]))
  add('page-persist: the view parameters are kept under their keys: the yard, the class picks, the growth target and the yard search per race, the free-slipway filter and the yards table for the app, the earlier keys as they were', () => {
    const keys = [...pageText.matchAll(/(?:key: '|tableView\(')(shipyards\w+)'/g)].map((match) => match[1]).sort()
    const racewide = [...pageText.matchAll(/(\w+): \{ key: '(shipyards\w+)', default: [^}]*scope: 'race'/g)].map((match) => match[2]).sort()

    return same([keys, racewide], [['shipyardsFromClass', 'shipyardsGrowthTarget', 'shipyardsHideObsolete', 'shipyardsIdleOnly', 'shipyardsOperation', 'shipyardsRunningTable', 'shipyardsSearch', 'shipyardsShipsOnly', 'shipyardsSizeWindow', 'shipyardsToClass', 'shipyardsView', 'shipyardsYard', 'shipyardsYardSearch', 'shipyardsYardsList', 'shipyardsYardsTable'], ['shipyardsFromClass', 'shipyardsGrowthTarget', 'shipyardsSearch', 'shipyardsToClass', 'shipyardsYard', 'shipyardsYardSearch']])
  })
  add('page-persist: the yard, the class picks and the growth target are accepted only as a whole id above 0 and a number above 0 (or none)', () => {
    const line = (name) => (pageText.match(new RegExp(`      ${name}: \\{[^\\n]*`)) || [''])[0]
    const id = /valid: \(value\) => value === null \|\| \(Number\.isInteger\(value\) && value > 0\)/

    return id.test(line('yardId')) && id.test(line('fromId')) && id.test(line('toId')) && /valid: \(value\) => value === null \|\| \(isNumber\(value\) && value > 0\)/.test(line('growthTarget')) ? true : 'the validity of the yard, a class or the target differs'
  })

  // ----- the class picks of Refits and Class to yards, over the real persisted-view mixin and an in-memory settings store -----
  const KEY = 'campaign.c1.race.1'
  const OTHER = 'campaign.c1.race.2'
  const THREE = [...CLASSES, { id: 102, name: 'Gamma class', obsolete: false }]
  const mountPersisted = ({ config = new MemoryConfig(), prefix = KEY } = {}) => {
    const store = Vue.observable({ getters: { racePrefix: prefix, config, database: null, GameID: 1, RaceID: 1 }, state: {} })
    const vm = new Vue({
      mixins: [persistedOptions],
      data: () => ({ ...asyncDefaults(persistedOptions), refitData: { classes: [], components: {} } }),
      beforeCreate() {
        this.$store = store
      },
    })

    return { vm, store, config }
  }
  const readClasses = async (mounted, classes = CLASSES) => {
    mounted.vm.refitData = { classes, components: {} }
    await flush()

    return mounted
  }
  // A page left with its picks made: `change` sets them, and the settings are what the store then holds.
  const left = async (change, { prefix = KEY, config = new MemoryConfig() } = {}) => {
    const mounted = mountPersisted({ config, prefix })

    change(mounted.vm)
    await flush()
    mounted.vm.$destroy()

    return config
  }
  const picks = (vm) => [vm.fromId, vm.toId]
  const storedPicks = (config, prefix = KEY) => [config.get(`${prefix}.shipyardsFromClass`, 'none'), config.get(`${prefix}.shipyardsToClass`, 'none')]

  add('page-persist: the Refits picks come back when the page is opened again (through its tab, or after a restart) and are the race\'s classes', async () => {
    const config = await left((vm) => { vm.view = 'refits'; vm.fromId = 100; vm.toId = 101 })
    const reopened = await readClasses(mountPersisted({ config }))
    const restarted = await readClasses(mountPersisted({ config: config.reopened() }))

    return same([[reopened.vm.view, ...picks(reopened.vm)], [restarted.vm.view, ...picks(restarted.vm)], reopened.vm.pair && [reopened.vm.pair.from.name, reopened.vm.pair.to.name]], [['refits', 100, 101], ['refits', 100, 101], ['Alpha class', 'Beta class']])
  })
  add('page-persist: the Class to yards picks come back when the page is opened again (through its tab, or after a restart)', async () => {
    const config = await left((vm) => { vm.view = 'classes'; vm.operation = 'refit'; vm.fromId = 100; vm.toId = 101 })
    const reopened = await readClasses(mountPersisted({ config }))
    const restarted = await readClasses(mountPersisted({ config: config.reopened() }))
    const shown = (mounted) => [mounted.vm.view, mounted.vm.operation, ...picks(mounted.vm), mounted.vm.linkQuery]
    const expected = ['classes', 'refit', 100, 101, { view: 'classes', operation: 'refit', from: 100, to: 101 }]

    return same([shown(reopened), shown(restarted)], [expected, expected])
  })
  add('page-persist: a cleared pick is kept cleared, and a page never picked on opens with none', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })
    const cleared = await left((vm) => { vm.fromId = null }, { config })
    const reopened = await readClasses(mountPersisted({ config: cleared }))
    const fresh = await readClasses(mountPersisted())

    return same([picks(reopened.vm), picks(fresh.vm)], [[null, 101], [null, null]])
  })
  add('page-persist: the picks are the race\'s: another race opens with its own and the first race gets its own back', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })

    await left((vm) => { vm.fromId = 101; vm.toId = 100 }, { prefix: OTHER, config })

    const mounted = await readClasses(mountPersisted({ config }))
    const first = picks(mounted.vm)

    mounted.store.getters.racePrefix = OTHER
    mounted.store.getters.RaceID = 2
    await flush()

    const other = picks(mounted.vm)

    mounted.store.getters.racePrefix = KEY
    mounted.store.getters.RaceID = 1
    await flush()

    return same([first, other, picks(mounted.vm), storedPicks(config), storedPicks(config, OTHER)], [[100, 101], [101, 100], [100, 101], [100, 101], [101, 100]])
  })
  add('page-persist: a pick that is not one of the race\'s classes is dropped once the classes are read (and saved as none), and is kept while no class is read yet', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 999 })
    const mounted = mountPersisted({ config })
    const before = picks(mounted.vm)

    await readClasses(mounted)

    return same([before, picks(mounted.vm), storedPicks(config)], [[100, 999], [100, null], [100, null]])
  })
  add('page-persist: the classes of a link win for the visit, are not saved, and a link\'s class the race does not have stays to be named; a pick made after it is saved', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })
    const mounted = mountPersisted({ config })

    mounted.vm.applyLink({ from: '555', to: '100' })
    await readClasses(mounted, THREE)

    const visit = [mounted.vm.view, ...picks(mounted.vm), mounted.vm.pairHint, ...storedPicks(config)]

    mounted.vm.fromId = 102
    await flush()

    return same([visit, storedPicks(config)], [['refits', 555, 100, 'A class named by the link is not one of the race\'s classes.', 100, 101], [102, 101]])
  })
  add('page-persist: a link to Yards or Growth, or one that names no class, leaves the picks as they were', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })
    const mounted = await readClasses(mountPersisted({ config }))
    const after = (query) => {
      mounted.vm.applyLink(query)

      return [mounted.vm.view, ...picks(mounted.vm)]
    }

    const yards = after({ yard: '2' })
    const growth = after({ view: 'growth', yard: '3' })
    const classes = after({ view: 'classes', operation: 'repair', to: '100' })

    await flush()

    return same([yards, growth, classes, storedPicks(config)], [['yards', 100, 101], ['growth', 100, 101], ['classes', null, 100], [100, 101]])
  })

  return statements
}

// ---------- the named links from the other pages ----------

const links = (ctx) => {
  const { sourceText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('named-links: the Production Recap names the yard of each ship job and each yard job, and an idle-slipway row links to the colony\'s yards', () => {
    const recap = sourceText.PR
    const wanted = [':to="linkTo.shipyards({ yard: item.ShipyardID })"', ':to="linkTo.shipyards({ colony: item.PopulationID })"', 'ShipyardID: ship.ShipyardID,', 'ShipyardID: shipyard.ID,', 'FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.UnitName as Name']

    return wanted.filter((text) => !recap.includes(text)).length ? `missing: ${wanted.filter((text) => !recap.includes(text)).join(' | ')}` : true
  })
  add('named-links: the idle-slipway and obsolete-yard warnings link to the yard, not its colony', () => {
    const text = sourceText.W
    const wanted = ['link: linkTo.shipyards({ yard: shipyard.ShipyardID }),\n          signature: signatureOf(bandOf(isKnownNumber(shipyard.Slipways)', 'caption: shipyard.PopName || undefined,\n          link: linkTo.shipyards({ yard: shipyard.ShipyardID }),']

    return count(text, 'linkTo.shipyards({ yard: shipyard.ShipyardID })') === 2 && wanted.every((find) => text.includes(find)) ? true : 'the warnings do not link to the yard'
  })
  add('named-links: the Tech Tree\'s lines and path views link the build rate and shipyard operations lines to Yards and Growth', () => {
    const wanted = [[sourceText.L, ':to="linkTo.shipyards({ view: techViews[line.typeId] })"'], [sourceText.PV, ':to="linkTo.shipyards({ view: techViews[tech.typeId] })"']]
    const bad = wanted.filter(([text, find]) => !text.includes(find) || !text.includes('SHIPYARD_TECH_VIEWS') || !text.includes('techViews: SHIPYARD_TECH_VIEWS'))

    return bad.length ? `missing in ${bad.length} of the two` : true
  })

  return statements
}

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)
    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve({ file: path.basename(resolved), query: rawQuery(raw), close: () => raw.close() })))
})

const rowsOf = async (database, sql, replacements = {}) => (await database.query(sql, { replacements }))[0]

// Every stored activity of types 1 to 6 of a save with the price the rules give at the race's own operations factor and at a factor of 1.
const activitiesOf = async (ctx, database) => {
  const { g, provenance: p } = ctx.m
  const rows = await rowsOf(database, 'select ShipyardID, GameID, RaceID, SYType, Slipways, Capacity, TaskType, RequiredBP from FCT_Shipyard where TaskType between 1 and 6 order by ShipyardID')
  const factorOne = p.ofRule({ rule: 'shipyardGrowth.operations', value: 1, inputs: { present: ['the levels'] }, units: '' })
  const held = {}
  const priced = []

  for (const row of rows) {
    const key = `${row.GameID}/${row.RaceID}`

    held[key] = held[key] || g.shipyardOperations(await g.loadShipyardOperations(database, { GameID: row.GameID, RaceID: row.RaceID }), '2.7.x')

    const yard = { type: row.SYType, capacity: row.Capacity, slipways: row.Slipways }
    const priceAt = (operations) => (row.TaskType === g.SLIPWAY_ACTIVITY ? g.slipwayPrice({ yard, operations, version: '2.7.x' }) : g.capacityStepPrice({ yard, step: g.CAPACITY_STEPS.find((step) => step.taskType === row.TaskType), operations, version: '2.7.x' }))

    priced.push({ ...row, held: p.valueOrNull(held[key]), expected: p.valueOrNull(priceAt(held[key])), atOne: p.valueOrNull(priceAt(factorOne)) })
  }

  return priced
}

const saveStatements = async (ctx, file) => {
  const database = await openSave(file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const { m } = ctx
  const label = path.basename(file)
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const activities = await activitiesOf(ctx, database)
  const races = await rowsOf(database, 'select distinct GameID, RaceID from FCT_Shipyard')
  const equal = (row, figure) => near(row.RequiredBP, figure)

  add(`save-stored: ${label}: every stored activity of types 1 to 6 has the build points the rules give once the race's operations factor applies`, () => {
    const bad = activities.filter((row) => !equal(row, row.expected))

    return bad.length ? short(bad.map((row) => [row.ShipyardID, row.TaskType, row.RequiredBP, row.expected])) : true
  })
  add(`save-stored: ${label}: the activities that differ at a factor of 1 are those of a race that holds a better level, and only then`, () => {
    const bad = activities.filter((row) => !equal(row, row.atOne) && !(row.held < 1 && equal(row, row.expected)))

    return bad.length ? short(bad.map((row) => [row.ShipyardID, row.TaskType, row.RequiredBP, row.atOne])) : true
  })
  add(`save-operations: ${label}: the race's stored operations column is the lowest multiplier among the levels it holds`, async () => {
    const bad = []

    for (const { GameID, RaceID } of races) {
      const held = m.g.shipyardOperations(await m.g.loadShipyardOperations(database, { GameID, RaceID }), '2.7.x')
      const [race] = await rowsOf(database, 'select ShipyardOperations from FCT_Race where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })

      if (held.status !== 'unavailable' && race && race.ShipyardOperations !== null && !near(race.ShipyardOperations, held.value)) {
        bad.push([GameID, RaceID, race.ShipyardOperations, held.value])
      }
    }

    return bad.length ? short(bad) : true
  })
  add(`save-continual: ${label}: a stored continual activity (type 8) stores no build points, so the continual price has no stored comparison`, async () => {
    const rows = await rowsOf(database, 'select ShipyardID, RequiredBP from FCT_Shipyard where TaskType = 8')
    const bad = rows.filter((row) => row.RequiredBP !== 0 && row.RequiredBP !== null)

    return bad.length ? short(bad) : true
  })
  add(`save-yards: ${label}: every yard of every race is read once with a task count that is the number of its task rows, and the tasks of the race are the stored ones`, async () => {
    const bad = []

    for (const { GameID, RaceID } of races) {
      const yards = await m.refits.loadYards(database, { GameID, RaceID })
      const [{ n: yardCount }] = await rowsOf(database, 'select count(*) as n from FCT_Shipyard where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })
      const [{ n: taskCount }] = await rowsOf(database, 'select count(*) as n from FCT_ShipyardTask where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })

      if (yards.length !== yardCount || yards.some((yard) => yard.tasks !== yard.taskRows.length)) {
        bad.push([GameID, RaceID])
      }

      if (yards.reduce((total, yard) => total + yard.taskRows.length, 0) > taskCount) {
        bad.push([GameID, RaceID, 'more tasks than stored'])
      }
    }

    return bad.length ? short(bad) : true
  })
  add(`save-ship-based: ${label}: the yards that belong to a ship are read as such and every price and time of each is unavailable and names why, while the yard stays a row`, async () => {
    const bad = []
    const found = []

    for (const { GameID, RaceID } of races) {
      const yards = await m.refits.loadYards(database, { GameID, RaceID })
      const operations = m.g.shipyardOperations(await m.g.loadShipyardOperations(database, { GameID, RaceID }), '2.7.x')

      yards.filter((yard) => yard.shipBased === true).forEach((yard) => {
        const target = yard.capacity + 5000
        const rows = m.g.upgradePrices({ yard, operations, version: '2.7.x' })
        const continual = m.g.continualPrice({ yard, target, operations, version: '2.7.x' })
        const prices = [...rows.map((row) => row.price), continual]
        const times = [...rows.map((row) => m.g.upgradeTime(MODIFIERS, yard, row.taskType, row.price).result), m.g.continualTime(MODIFIERS, yard, target, continual).result]

        found.push(yard.id)

        if (![...prices, ...times].every((result) => result.status === 'unavailable' && m.provenance.valueOrNull(result) === null) || !prices.every((price) => price.inputs.missing.includes(m.g.SHIP_BASED_GAP))) {
          bad.push(yard.id)
        }
      })
    }

    return bad.length ? short(bad) : same(found.sort((a, b) => a - b), SHIP_BASED_YARDS[label])
  })
  add(`save-tasks: ${label}: the time left of every stored task is the Production Recap's, the build points left over the colony's rate for the class (the shared rate and finish)`, async () => {
    const { g, production: pr, provenance: p } = m
    const bad = []
    let compared = 0

    for (const { GameID, RaceID } of races) {
      const yards = await m.refits.loadYards(database, { GameID, RaceID })
      const recap = await rowsOf(database, 'select FCT_ShipyardTask.TaskID as ID, FCT_ShipClass.Size, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingProduction, FCT_ShipyardTask.Paused, (case when FCT_Shipyard.SYType = 1 then 1.0 when FCT_Shipyard.SYType is null then null else 0.25 end) as CommercialModifier from FCT_ShipyardTask left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID', { GameID, RaceID })
      const byId = Object.fromEntries(recap.map((row) => [row.ID, row]))

      yards.forEach((yard) => yard.taskRows.forEach((row) => {
        const expected = byId[row.id]
        const rate = pr.shipRate(MODIFIERS, expected)
        const finish = pr.finishDays({ rule: 'production.shipFinish', rate, remaining: expected.RemainingProduction, remainingName: 'the task\'s remaining build points', paused: pr.flagOf(expected.Paused) })
        const actual = g.taskFinish(MODIFIERS, yard, row)

        compared++

        if (p.valueOrNull(actual.result) !== p.valueOrNull(finish.result) || actual.idle !== finish.idle || p.valueOrNull(actual.rate) !== p.valueOrNull(rate)) {
          bad.push([row.id, p.valueOrNull(actual.result), p.valueOrNull(finish.result)])
        }
      }))
    }

    return bad.length ? short(bad) : compared >= 0 ? true : 'none compared'
  })

  return { skipped: false, statements, activities, close: () => database.close() }
}

// The counts over both saves: 64 activities of types 1 to 6 (types 1, 3, 5, 6 in the saves; 2 and 4 in none), all 64 equal once the operations factor applies, 63 at a factor of 1.
const totalStatements = (reads) => {
  const all = reads.flatMap((read) => read.activities || [])
  const byType = (type) => all.filter((row) => row.TaskType === type).length
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('save-stored: both saves: 64 stored activities of types 1 to 6, and all 64 equal the rules\' price once the operations factor applies, 63 of them at a factor of 1 and the one other (yard 6746, 192 stored against 240) at the race\'s 0.8', () => {
    const exact = all.filter((row) => near(row.RequiredBP, row.expected)).length
    const atOne = all.filter((row) => near(row.RequiredBP, row.atOne)).length
    const other = all.filter((row) => !near(row.RequiredBP, row.atOne))

    return same([all.length, exact, atOne, other.map((row) => [row.ShipyardID, row.RequiredBP, row.atOne, row.held])], [64, 64, 63, [[6746, 192, 240, 0.8]]])
  })
  add('save-types: both saves: the activities stored are the slipway (type 1), the 1,000, 5,000 and 10,000 ton steps (3, 5, 6); the 500 and 2,000 ton steps (2, 4) occur in no save, so their prices rest on the pattern', () => same([byType(1), byType(2), byType(3), byType(4), byType(5), byType(6)], [29, 0, 25, 0, 2, 8]))

  return statements
}

// ---------- the mutations ----------

const MUTATIONS = [
  { name: 'a slipway priced on 5,000 tons to the unit', file: G, find: 'export const UPGRADE_UNIT_TONS = 500', replace: 'export const UPGRADE_UNIT_TONS = 5000', fails: ['price', 'continual', 'growth', 'page-rows', 'save-stored'] },
  { name: 'the unit price 120 changed', file: G, find: 'export const UPGRADE_UNIT_COST = 120', replace: 'export const UPGRADE_UNIT_COST = 100', fails: ['price', 'continual', 'save-stored'] },
  { name: 'a commercial yard paying in full', file: G, find: 'export const COMMERCIAL_UPGRADE_FACTOR = 0.1', replace: 'export const COMMERCIAL_UPGRADE_FACTOR = 1', fails: ['price', 'save-stored'] },
  { name: 'a repair yard left outside the rules', file: G, find: 'type === SHIPYARD_TYPE.COMMERCIAL || type === SHIPYARD_TYPE.REPAIR ? COMMERCIAL_UPGRADE_FACTOR', replace: 'type === SHIPYARD_TYPE.COMMERCIAL ? COMMERCIAL_UPGRADE_FACTOR', fails: ['price'] },
  { name: 'the 1,000 ton step at one unit', file: G, find: 'taskType: 3, tons: 1000, units: 2', replace: 'taskType: 3, tons: 1000, units: 1', fails: ['price', 'save-stored'] },
  { name: 'the 5,000 ton step at five units', file: G, find: 'taskType: 5, tons: 5000, units: 10', replace: 'taskType: 5, tons: 5000, units: 5', fails: ['price', 'save-stored'] },
  { name: 'the 10,000 ton step at ten units', file: G, find: 'taskType: 6, tons: 10000, units: 20', replace: 'taskType: 6, tons: 10000, units: 10', fails: ['price', 'save-stored'] },
  { name: 'the 2,000 ton step passed off as confirmed', file: G, find: 'taskType: 4, tons: 2000, units: 4, pattern: true', replace: 'taskType: 4, tons: 2000, units: 4, pattern: false', fails: ['price'] },
  { name: 'the 500 ton step passed off as confirmed', file: G, find: 'taskType: 2, tons: 500, units: 1, pattern: true', replace: 'taskType: 2, tons: 500, units: 1, pattern: false', fails: ['price'] },
  { name: 'the operations factor taken as the highest multiplier', file: G, find: 'value: Math.min(...held.map((level) => level.multiplier))', replace: 'value: Math.max(...held.map((level) => level.multiplier))', fails: ['operations', 'price', 'page-rows', 'save-stored'] },
  { name: 'a race holding no level given a factor of 1', file: G, find: '} else if (!held.length) {', replace: '} else if (!held.length) {\n    return figure({ rule, value: 1, present: [], units: \'\', version })\n  } else if (false) {', fails: ['operations', 'price', 'growth'] },
  { name: 'a level with no multiplier counted as 0', file: G, find: 'const unknown = held.filter((level) => !isNumber(level.multiplier))', replace: 'const unknown = []', fails: ['operations'] },
  { name: 'the type rejection of a price removed', file: G, find: '  if (!isNumber(yard.type)) {\n    missing.push(\'the yard\\\'s type\')\n  } else if (factorOf(yard.type) === null) {\n    missing.push(`the rules for yard type $' + '{yard.type}`)\n  }\n', replace: '', fails: ['price'] },
  { name: 'a linked yard hidden by the free-slipway filter', file: P, find: 'idleOnly && yard.id !== linkedYardId && full(yard)', replace: 'idleOnly && full(yard)', fails: ['links'] },
  { name: 'a linked yard hidden by the saved search', file: P, find: '(yard.id === linkedYardId || !search || ', replace: '(!search || ', fails: ['links'] },
  { name: 'a link that names no yard keeping the last linked yard', file: P, find: '      this.linkedYardId = yardId\n', replace: '', fails: ['links'] },
  { name: 'the continual price from the target, not the tons added', file: G, find: '((isNumber(target) ? target : 0) - yard.capacity) / UPGRADE_UNIT_TONS', replace: '(isNumber(target) ? target : 0) / UPGRADE_UNIT_TONS', fails: ['continual', 'growth'] },
  { name: 'a target at or below the capacity priced', file: G, find: 'isAvailable(price) && !(target > yard.capacity)', replace: 'false', fails: ['continual'] },
  { name: 'the most construction periods cut to 100', file: G, find: 'export const MAX_CONTINUAL_PERIODS = 100000', replace: 'export const MAX_CONTINUAL_PERIODS = 100', fails: ['continual', 'growth'] },
  { name: 'a fixed upgrade timed on no build points', file: G, find: 'remaining: price.value, target: null', replace: 'remaining: 0, target: null', fails: ['time', 'growth'] },
  { name: 'a task at a commercial yard weighted as a naval one', file: G, find: 'yard.type === SHIPYARD_TYPE.NAVAL ? 1 : isNumber(yard.type) ? 0.25 : null', replace: 'isNumber(yard.type) ? 1 : null', fails: ['time', 'save-tasks'] },
  { name: 'an activity timed on all its build points, not what is left', file: G, find: 'isNumber(yard.requiredBP) && isNumber(yard.completedBP) ? yard.requiredBP - yard.completedBP : null', replace: 'isNumber(yard.requiredBP) ? yard.requiredBP : null', fails: ['time', 'page-rows'] },
  { name: 'the levels read for every race', file: G, find: 'where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID and', replace: 'where FCT_RaceTech.GameID = :GameID and', fails: ['loader'] },
  { name: 'the Shipyard Operations tech type read as another', file: G, find: 'export const OPERATIONS_TECH_TYPE = 158', replace: 'export const OPERATIONS_TECH_TYPE = 30', fails: ['loader', 'techtree', 'save-operations', 'save-stored'] },
  { name: 'the tech lines swapped between the views', file: G, find: '{ 30: \'yards\', [OPERATIONS_TECH_TYPE]: \'growth\' }', replace: '{ 30: \'growth\', [OPERATIONS_TECH_TYPE]: \'yards\' }', fails: ['techtree'] },
  { name: 'the refit labelled as a repair', file: G, find: '2: \'Refit\',', replace: '2: \'Repair\',', fails: ['labels'] },
  { name: 'a task\'s balance taken the wrong way round', file: R, find: 'remaining: isNumber(row.TotalBP) && isNumber(row.CompletedBP) ? row.TotalBP - row.CompletedBP : null', replace: 'remaining: isNumber(row.TotalBP) && isNumber(row.CompletedBP) ? row.CompletedBP - row.TotalBP : null', fails: ['loader', 'save-tasks'] },
  { name: 'a task\'s pause flag not stored taken as running', file: R, find: 'paused: flagOf(row.Paused),\n  size: numberOf(row.Size),', replace: 'paused: Boolean(row.Paused),\n  size: numberOf(row.Size),', fails: ['loader'] },
  { name: 'a task\'s size read from its refit target', file: R, find: 'FCT_ShipClass.Size from FCT_ShipyardTask left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID', replace: 'FCT_ShipClass.Size from FCT_ShipyardTask left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.RefitID', fails: ['loader'] },
  { name: 'a save with no task table given an empty list of tasks', file: R, find: 'taskRows: hasTasks ? Object.freeze(taskRows[row.ShipyardID] || []) : null', replace: 'taskRows: Object.freeze(taskRows[row.ShipyardID] || [])', fails: ['loader'] },
  { name: 'a stored pause flag of an activity taken as 0 when it is not there', file: R, find: 'paused: flagOf(row.PauseActivity),', replace: 'paused: Boolean(row.PauseActivity),', fails: ['loader'] },
  { name: 'a class link that opens Refits', file: D, find: 'classId ? { view: \'classes\', operation, from, to: classId }', replace: 'classId ? { view: \'refits\', operation, from, to: classId }', fails: ['links'] },
  { name: 'the yard key left out of the link', file: D, find: '{ view, yard, colony, operation, from, to }', replace: '{ view, colony, operation, from, to }', fails: ['links'] },
  { name: 'a yard link that opens Refits', file: P, find: 'yardId || this.colonyId ? \'yards\' : \'refits\'', replace: '\'refits\'', fails: ['links'] },
  { name: 'the yard of a link not taken', file: P, find: 'this.setUnsaved(\'yardId\', yardId)', replace: 'void yardId', fails: ['links'] },
  { name: 'a colony link that keeps the stored colony', file: P, find: 'this.colonyId = queryId(query.colony)', replace: 'this.colonyId = this.colonyId', fails: ['links'] },
  { name: 'the free-slipway filter leaving out yards with no task', file: P, find: '!(idleOnly && yard.id !== linkedYardId && full(yard))', replace: '!(idleOnly && yard.tasks === 0)', fails: ['page-rows'] },
  { name: 'the yards with no task left out of the list', file: P, find: 'matches(yard) && !(idleOnly && yard.id !== linkedYardId && full(yard))', replace: 'matches(yard) && yard.tasks > 0 && !(idleOnly && yard.id !== linkedYardId && full(yard))', fails: ['page-rows'] },
  { name: 'a retool holding a slipway', file: P, find: 'const free = isNumber(yard.slipways) && isNumber(yard.tasks) ? yard.slipways - yard.tasks : null', replace: 'const free = isNumber(yard.slipways) && isNumber(yard.tasks) ? yard.slipways - yard.tasks - (yard.taskType === RETOOL_ACTIVITY ? 1 : 0) : null', fails: ['page-rows'] },
  { name: 'the default target 1,000 t above the capacity', file: P, find: 'const DEFAULT_GROWTH_TONS = 10000', replace: 'const DEFAULT_GROWTH_TONS = 1000', fails: ['growth'] },
  { name: 'a target of 0 accepted', file: P, find: 'Number.isFinite(number) && number > 0 ? number : null\n    },', replace: 'Number.isFinite(number) && number >= 0 ? number : null\n    },', fails: ['growth'] },
  { name: 'the first yard not shown while none is picked', file: P, find: 'return pickedYard || (yardId === null && yards.length ? yards[0] : null)', replace: 'return pickedYard', fails: ['growth'] },
  { name: 'the continual row not marked approximate', file: P, find: 'idle: time.idle, approx: true })', replace: 'idle: time.idle, approx: false })', fails: ['growth'] },
  { name: 'the continual row priced to the capacity, not the target', file: P, find: 'const price = continualPrice({ yard, target, operations, version: formulaVersion })', replace: 'const price = continualPrice({ yard, target: yard.capacity, operations, version: formulaVersion })', fails: ['growth'] },
  { name: 'the free slipways tile counting every slipway', file: P, find: 'known.reduce((total, yard) => total + yard.slipways - yard.tasks, 0)', replace: 'known.reduce((total, yard) => total + yard.slipways, 0)', fails: ['tiles'] },
  { name: 'the operations tile a figure with no factor', file: P, find: 'value: operationsValue === null ? UNKNOWN_TEXT : this.count(operationsValue, 2)', replace: 'value: this.count(operationsValue || 1, 2)', fails: ['tiles'] },
  { name: 'Refits the default view', file: P, find: 'default: \'yards\', valid: oneOf(VIEW_OPTIONS', replace: 'default: \'refits\', valid: oneOf(VIEW_OPTIONS', fails: ['page-template'] },
  { name: 'the yard pick kept for the app, not the race', file: P, find: 'yardId: { key: \'shipyardsYard\', default: null, scope: \'race\', valid', replace: 'yardId: { key: \'shipyardsYard\', default: null, valid', fails: ['page-persist'] },
  { name: 'the yards table kept under the eligibility table\'s key', file: P, find: 'tableView(\'shipyardsYardsList\'', replace: 'tableView(\'shipyardsYardsTable\'', fails: ['page-persist'] },
  { name: 'the yard pick accepted as any number', file: P, find: 'yardId: { key: \'shipyardsYard\', default: null, scope: \'race\', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },', replace: 'yardId: { key: \'shipyardsYard\', default: null, scope: \'race\', valid: (value) => true },', fails: ['page-persist'] },
  { name: 'the Yards summary with a figure', file: P, find: 'data-summary="Every shipyard of the race once,', replace: 'data-summary="Every 1 shipyard of the race once,', fails: ['page-template'] },
  { name: 'the Growth panel without its summary', file: P, find: '<v-card v-if="view === \'growth\'" class="panel" data-summary="', replace: '<v-card v-if="view === \'growth\'" class="panel" data-sum="', fails: ['page-template'] },
  { name: 'the Growth summary in the second person', file: P, find: 'Use it to compare the upgrades and to size a continual target.', replace: 'Use it to compare your upgrades and to size a continual target.', fails: ['page-template'] },
  { name: 'the eligibility panel on every view', file: P, find: '<v-card v-if="view === \'refits\' || view === \'classes\'" class="panel" :data-summary="yardsSummary"', replace: '<v-card class="panel" :data-summary="yardsSummary"', fails: ['page-template'] },
  { name: 'the yard table\'s unknown not sorted last', file: P, find: ':items="inventoryRows" item-key="id" :custom-sort="sortNullLast"', replace: ':items="inventoryRows" item-key="id"', fails: ['page-template'] },
  { name: 'the page\'s card left unclosed', file: P, find: '        </v-card>\n\n        <v-card v-if="view === \'growth\'"', replace: '        </v-cardx>\n\n        <v-card v-if="view === \'growth\'"', fails: ['page-template'] },
  { name: 'the Recap\'s yard link dropped', file: PR, find: '<page-link v-if="item.ShipyardID" class="ml-1" :to="linkTo.shipyards({ yard: item.ShipyardID })" :name="item.yardName" />', replace: '', fails: ['named-links'] },
  { name: 'the Recap\'s ship jobs read without their yard', file: PR, find: 'FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.UnitName as Name', replace: 'FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name', fails: ['named-links'] },
  { name: 'the Recap\'s slipway link dropped', file: PR, find: '<page-link v-if="column.key === \'slipways\'" class="ml-1" :to="linkTo.shipyards({ colony: item.PopulationID })" :name="item.colonyName" />', replace: '', fails: ['named-links'] },
  { name: 'the Recap defining the labels again', file: PR, find: 'import { SHIPYARD_TASK_TYPES, SHIPYARD_UPGRADE_TYPES } from \'../utilities/shipyard-growth\'', replace: 'const SHIPYARD_TASK_TYPES = {}\nconst SHIPYARD_UPGRADE_TYPES = {}', fails: ['labels'] },
  { name: 'the idle-slipway warning linking the colony', file: W, find: 'link: linkTo.shipyards({ yard: shipyard.ShipyardID }),\n          signature: signatureOf(bandOf(isKnownNumber(shipyard.Slipways)', replace: 'link: linkTo.production(shipyard.PopulationID),\n          signature: signatureOf(bandOf(isKnownNumber(shipyard.Slipways)', fails: ['named-links'] },
  { name: 'the obsolete-yard warning linking the colony', file: W, find: 'caption: shipyard.PopName || undefined,\n          link: linkTo.shipyards({ yard: shipyard.ShipyardID }),', replace: 'caption: shipyard.PopName || undefined,\n          link: shipyard.PopulationID ? linkTo.production(shipyard.PopulationID) : undefined,', fails: ['named-links'] },
  { name: 'the Tech Tree lines view linking Yards for every line', file: L, find: ':to="linkTo.shipyards({ view: techViews[line.typeId] })"', replace: ':to="linkTo.shipyards({ view: \'yards\' })"', fails: ['named-links'] },
  { name: 'the Tech Tree path view linking the wrong line', file: PV, find: ':to="linkTo.shipyards({ view: techViews[tech.typeId] })"', replace: ':to="linkTo.shipyards({ view: \'growth\' })"', fails: ['named-links'] },
  { name: 'a yard that belongs to a ship priced', file: G, find: '  if (yard.shipBased === true) {\n    missing.push(SHIP_BASED_GAP)\n  } else if (yard.shipBased === null) {\n    missing.push(\'whether the yard belongs to a ship\')\n  }\n\n', replace: '', fails: ['price', 'save-ship-based'] },
  { name: 'a yard whose ship link is not stored priced', file: G, find: '  } else if (yard.shipBased === null) {\n    missing.push(\'whether the yard belongs to a ship\')\n  }\n', replace: '  }\n', fails: ['price'] },
  { name: 'the task rate left out of a task line', file: P, find: 'rate: valueOrNull(finish.rate), rateResult: finish.rate, ', replace: 'rate: null, rateResult: finish.rate, ', fails: ['page-rows'] },
  { name: 'the task rate column left out of the task table', file: P, find: '<th class="text-right">Rate (BP/yr)</th>', replace: '', fails: ['page-template'] },
  { name: 'a yard\'s ship link not carried to its row', file: P, find: '          shipBased: yard.shipBased,\n', replace: '', fails: ['page-rows'] },
  { name: 'the class picks kept for the app, not the race', file: P, find: 'fromId: { key: \'shipyardsFromClass\', default: null, scope: \'race\', valid', replace: 'fromId: { key: \'shipyardsFromClass\', default: null, valid', fails: ['page-persist'] },
  { name: 'the stored class pick never restored', file: P, find: 'toId: { key: \'shipyardsToClass\', default: null, scope: \'race\', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },', replace: 'toId: { key: \'shipyardsToClass\', default: null, scope: \'race\', valid: () => false },', fails: ['page-persist'] },
  { name: 'the class pick accepted as any value', file: P, find: 'fromId: { key: \'shipyardsFromClass\', default: null, scope: \'race\', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },', replace: 'fromId: { key: \'shipyardsFromClass\', default: null, scope: \'race\', valid: () => true },', fails: ['page-persist'] },
  { name: 'the classes of a link saved as the picks', file: P, find: 'this.setUnsaved(\'fromId\', fromId)', replace: 'this.fromId = fromId', fails: ['page-persist'] },
  { name: 'a link to Yards clearing the picks of the visit', file: P, find: 'if (this.view === \'refits\' || this.view === \'classes\') {\n        const fromId', replace: 'if (true) {\n        const fromId', fails: ['page-persist'] },
  { name: 'a pick the race no longer has kept', file: P, find: 'if (id && !this.classById[id] && !this.linkedClassIds.includes(id)) {', replace: 'if (false) {', fails: ['page-persist'] },
  { name: 'a class the link names dropped with the stale picks', file: P, find: ' && !this.linkedClassIds.includes(id)', replace: '', fails: ['page-persist'] },
  { name: 'the picks cleared when the race changes', file: P, find: '      this.linkedClassIds = []\n      this.expanded = []', replace: '      this.linkedClassIds = []\n      this.fromId = null\n      this.toId = null\n      this.expanded = []', fails: ['page-persist'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))

  if (mutant) {
    sources[mutant.file] = patched(FILES[mutant.file], sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const real = sourcesOf(null)
  const changed = (key) => sources[key] !== real[key]
  const utilityNames = { G: 'shipyard-growth', R: 'refits', D: 'deep-links' }
  const planted = Object.fromEntries(Object.entries(utilityNames).filter(([key]) => changed(key)).map(([key, name]) => [name, sources[key]]))
  const pagePlanted = Object.fromEntries(Object.entries(planted).map(([name, text]) => [`utilities/${name}`, text]))
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: planted })
  const pageSources = { 'pages/shipyards': sources.P, ...pagePlanted }
  const pageOptions = await loadPage('pages/shipyards', { stubs: STUBS, modules: { 'mixins/production-modifiers': MIXIN_STUB }, sources: pageSources })
  const persistedOptions = await loadPage('pages/shipyards', { stubs: STUBS, modules: { 'mixins/production-modifiers': MIXIN_STUB, 'mixins/persisted-view': PERSISTED_VIEW_SOURCE }, sources: pageSources })

  return { m: { g: loaded['shipyard-growth'], refits: loaded.refits, production: loaded.production, provenance: loaded.provenance, deepLinks: loaded['deep-links'] }, pageOptions, persistedOptions, pageText: sources.P, sourceText: sources }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

const statementsOf = async (ctx, withSaves, keys = null) => {
  const statements = [...pure(ctx), ...loader(ctx), ...page(ctx), ...links(ctx)]
  const opened = []
  const skipped = []

  if (withSaves) {
    const reads = []

    for (const file of SAVES) {
      const wanted = keys === null || keys.some((key) => key.startsWith('save-'))
      const read = wanted ? await saveStatements(ctx, file) : { skipped: false, statements: [] }

      if (read.skipped) {
        skipped.push(file)
      } else {
        statements.push(...read.statements)
        reads.push(read)

        if (read.close) {
          opened.push(read)
        }
      }
    }

    if (reads.length === SAVES.length && reads.every((read) => read.activities)) {
      statements.push(...totalStatements(reads))
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nShipyard growth: the prices and times on yards worked by hand, the loaders, the Yards and Growth views, the named links and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
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
