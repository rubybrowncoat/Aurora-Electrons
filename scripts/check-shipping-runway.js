/*
  Checks the treasury runway under civilian shipping scenarios (src/renderer/utilities/shipping-runway.js), its panel on the Finances page (components/finances/ShippingRunway.vue) and the page's optional read of the shipping-line tax rate.

  bun scripts/check-shipping-runway.js [--no-mutations] [--no-saves]

  The checks that need no save run the utility on wealth logs worked by hand: a year of 5-day cycles whose per-cycle amounts make every yearly figure a whole number, so each expected figure is written out below from the amounts, not read from the module. They prove: the no-change scenario is the Finances runway itself (the same object of the ledger, and the same value as the treasury over the loss worked by hand, for every window and for a treasury that lasts, one that is never exhausted, a net of exactly 0 and a treasury that is empty); the exhaustion of piecewise nets (two stretches, the first with a surplus, an exhaustion inside the first stretch, one reached in the second) and the balance at a year; the verdict over a horizon (exhausted within it, past it, never, now, unknown) and the date of an exhaustion; contracts delayed, at the tax rate of now, at a rate of 0 and at a changed rate, for a player and for a computer-run empire (whose receipt is halved); government transports, which are never taken as free (a blank running cost gives no figure, a running cost of 0 is a figure) and whose break-even running cost leaves the net as it is; planned contracts of each category (installation cargo pays the line its receipt after the tax, the others carry the tax only), a blank line ignored, no line entered giving no figure, a start after the delay; every blank or unreadable field giving no figure; an unsupported game version, a tax rate that is not stored, a tax rate of 100 %, a logged tax below what the contracts imply and a civilian use on the wrong side of the wealth use table; the saved tax rate read from the save by a loader that checks the column; actual figures (logged, scaled) kept apart from estimates and assumptions; the spread across the windows; and the panel and the page (the optional read that never holds the page back, the summary, the marks, the table beside the chart, no first or second person, no source name of the game).

  Each planted fault (a change of the utility, of the Finances utility, of the panel or of the page, made in an isolated copy by scripts/lib/mutant-source.js) must fail a group of the checks that needs no save, and each is located by structure (the attribute, key or state it belongs to and its whole value), never by wording or a default. Benign edits (wording, the order and spacing of attributes, the defaults of the entered fields and of the horizon) must leave every save-free check green, one at a time and all together, and every planted fault must still apply exactly once and fail its named checks on the source with every benign edit applied. With saves (the modded AuroraDB.db game 140 race 784 and the stock saves/AuroraDB_271_skoormit_saved.db game 138 race 785; one that is not there is reported as not run) it also reads the page's own reads from the save and compares the no-change runway and the logged contracts with sums taken straight from the log. Prints `N of N checks passed`; exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const nodeVm = require('vm')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'shipping-runway.js'),
  ledger: path.join(root, 'src', 'renderer', 'utilities', 'finances.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'finances', 'ShippingRunway.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'finances.vue'),
}
const U = 'utility'
const L = 'ledger'
const V = 'component'
const P = 'page'
const NAMES = ['shipping-runway', 'finances', 'provenance', 'civilian-tariff']
const SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: ["#a1", "#a2", "#a3", "#a4"], primary: "#p0", ink: "", inkMuted: "" }); export const withAlpha = (color) => color'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }

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
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item === Infinity ? 'Infinity' : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} ≠ ${short(expected)}`
  }
}

const near = (actual, expected, tolerance = 1e-9) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed
  const template = compiler.compileTemplate({ source: descriptor.template.content, id: 'check', filename: 'check.vue' })

  return template.errors.map((error) => (typeof error === 'string' ? error : error.message))
}

// The template of a component as Vue 2 parses it, with the source range of each element, and the text it was parsed from.
const templateOf = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const content = (parsed.descriptor || parsed).template.content
  const compiled = compiler.compileTemplate({ source: content, filename: 'panel.vue', id: 'panel', compilerOptions: { outputSourceRange: true } })

  return { content, ast: compiled.ast || null, compiled }
}

// Visits an element of the template and everything under it: its children, its other v-if branches and its scoped slots.
const walk = (node, visit, parent = null) => {
  if (!node) {
    return
  }

  node.parentNode = parent
  visit(node)

  if (node.type !== 1) {
    return
  }

  node.children.forEach((child) => walk(child, visit, node))
  ;(node.ifConditions || []).slice(1).forEach((condition) => walk(condition.block, visit, parent))
  Object.values(node.scopedSlots || {}).forEach((slot) => walk(slot, visit, node))
}

const nodesOf = (root, test) => {
  const hits = []

  walk(root, (node) => {
    if (test(node)) {
      hits.push(node)
    }
  })

  return hits
}

const elementsOf = (root, test) => nodesOf(root, (node) => node.type === 1 && test(node))
const attrOf = (el, name) => (el.attrsMap || {})[name]
const classesOf = (el) => (attrOf(el, 'class') || '').split(/\s+/).filter(Boolean)
const childElements = (el) => el.children.filter((child) => child.type === 1)
const hasMark = (el) => childElements(el).some((child) => child.tag === 'provenance-mark')

// The edits that locate their text by structure: an attribute by its name and whole value, a key or a state by what it belongs to, never by the words or the default it holds now.
const QUOTED = '"[^"]*"|\'[^\']*\''
const STRING = '\'[^\']*\'|"[^"]*"|`[^`]*`'
const attribute = (name) => new RegExp(`(?<=\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(${QUOTED})`)
const ATTRIBUTES = new RegExp(`([^\\s=]+)(?:\\s*=\\s*(${QUOTED}))?`, 'g')
const reversed = (inside) => [...inside.matchAll(ATTRIBUTES)].reverse().map(([, name, value]) => (value === undefined ? name : `${name}=${value}`)).join(' ')
const attributesOf = (tag) => Object.fromEntries([...tag.replace(/^<[^\s>/]+/, '').replace(/\s*\/?>\s*$/, '').matchAll(ATTRIBUTES)].map(([, name, text]) => [name, text === undefined ? true : text.slice(1, -1)]))
const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dropAttribute = (text, name) => text.replace(new RegExp(`\\s+${escaped(name)}\\s*=\\s*(?:${QUOTED})`), '')
const setAttribute = (text, name, value) => text.replace(new RegExp(`(\\s${escaped(name)}\\s*=\\s*)(?:${QUOTED})`), (_all, head) => `${head}"${value}"`)
const reverseTag = (text) => text.replace(/^(<[^\s>/]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)(\s*\/?>)$/, (_all, open, inside, close) => `${open} ${reversed(inside)}${close}`)

// The start tags of an element found by its name and its attributes, in whatever order they are written: `has` maps an attribute to its whole value, to a function of it (undefined when the tag has none) or to true for a bare one. `span` is 'start' for the start tag alone or 'element' for it up to its closing tag. Gives { text, attributes } of each.
const tagsOf = (text, { name, has = {}, span = 'start' }) => [...text.matchAll(new RegExp(`<${escaped(name)}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>`, 'g'))]
  .map((match) => ({ match, attributes: attributesOf(match[0]) }))
  .filter(({ attributes }) => Object.entries(has).every(([key, expected]) => (typeof expected === 'function' ? expected(attributes[key]) : attributes[key] === expected)))
  .map(({ match, attributes }) => ({ text: text.slice(match.index, span === 'element' && !/\/>$/.test(match[0]) ? text.indexOf(`</${name}>`, match.index) + name.length + 3 : match.index + match[0].length), attributes }))
const isText = (value) => typeof value === 'string'
const hasClass = (name) => (value) => isText(value) && value.split(/\s+/).includes(name)

const PRONOUNS = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i
const SOURCE_NAMES = new RegExp(['\\.' + 'cs\\b', 'Record' + 'WealthIncome', 'Civilian' + 'Constracts', 'Ship' + '\\.cs'].join('|'))

// ---------- the world worked by hand ----------

const DAY = 86400
const GAME_TIME = 1000 * DAY
const SAVED_TAX = { rate: 0.2, missing: '' }

// A year and more of 5-day cycles with the same amount in every cycle, so a window of any multiple of 5 days scales to the same yearly figure: 73 cycles a year. `perCycle` is { [UseID]: amount }; `shape` gives a use another amount for the recent cycles (index below `recent`), { [UseID]: [recent amount, older amount, recent count] }.
const USES = {
  44: ['Civilian Contracts', 0],
  32: ['Tax on Shipping Trade Goods', 1],
  47: ['Tax on Civilian Fuel', 1],
  11: ['Worker Taxes', 1],
  5: ['Shipbuilding', 0],
  29: ['Purchase of Civilian Ships', 0],
  6: ['Terraforming', 0],
}

const wealthOf = (perCycle, shape = {}) => Object.entries(perCycle).flatMap(([id, amount]) => Array.from({ length: 81 }, (_unused, index) => {
  const [recent, older, count] = shape[id] || [amount, amount, 0]

  return { UseID: Number(id), Description: USES[id][0], Income: USES[id][1], DisplayOrder: Number(id), TimeUsed: GAME_TIME - 5 * index * DAY, Amount: index < count ? recent : older }
}))

const treasuryRow = (balance) => ({ WealthPoints: balance, AnnualWealth: 1e9, GameTime: GAME_TIME, StartYear: 2000 })

// The yearly figures: contracts 7300, taxes 1825, worker taxes 2920, shipbuilding 4380; every net of the no-change scenario is -6935.
const PLAYER = { 44: 100, 32: 25, 11: 40, 5: 60 }
// The same contracts of a computer-run empire: its taxes (50 a cycle, 3650 a year) are those of a gross fare of 18250 at 20 %.
const COMPUTER = { 44: 100, 32: 50, 11: 40, 5: 60 }
const NET_PLAYER = 2920 - 4380 + 1825 - 7300
const REST = 2920 - 4380
const BALANCE = 69350

const world = (m, { perCycle = PLAYER, balance = BALANCE, windowDays = 365, shape } = {}) => {
  const wealth = wealthOf(perCycle, shape)
  const treasury = treasuryRow(balance)

  return { wealth, treasury, ledger: m.finances.buildLedger({ treasury, wealth, windowDays }), windowDays }
}

const inputsOf = (over = {}) => ({ horizon: 25, futureTax: null, pauseYears: '2', governmentCost: '', planStart: '0', lines: [], ...over })

const buildOf = (m, w, { version = '2.7.x', npr = false, tax = SAVED_TAX, ...over } = {}) => m.sr.buildScenarios({ ledger: w.ledger, version, npr, tax, inputs: inputsOf(over) })

const scenarioOf = (built, id) => built.scenarios.find((scenario) => scenario.id === id)

const value = (result) => (result && result.value !== undefined ? result.value : null)

// A database that answers the schema question with `columns` and every other query with `rows`, keeping the queries it was asked.
const fakeDatabase = (columns, rows, sqls = []) => ({ query: async (sql) => { sqls.push(sql); return [/pragma_table_info/.test(sql) ? columns.map((name) => ({ name })) : rows] } })

const line = (category, quantity, distance, perYear) => ({ category, quantity: String(quantity), distance: String(distance), perYear: String(perYear) })

const gap = (result) => !result.inputs.missing.length ? 'names nothing missing' : result.value === null && result.status === 'unavailable' ? true : `${short(result.value)} ${result.status}`

const lasts = (years) => ({ state: 'lasts', years })

// The published 2.7 rates, written apart from the module.
const RATE = { cargoPoint: 0.00015, tradeGood: 0.375, colonist: 0.00015, passenger: 0.006 }

const runs = (m) => {
  const { sr, provenance, finances } = m
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const none = (built) => scenarioOf(built, 'none')
  const figure = (number) => provenance.ofRule({ rule: 'shippingRunway.scenarioNet', value: number, inputs: { present: ['x'] } })

  // ----- the world itself -----
  add('world: the hand-worked yearly figures are the ledger\'s', () => {
    const w = world(m)
    const yearly = Object.fromEntries(w.ledger.categories.map((category) => [category.id, category.perYear]))

    return same([yearly[44], yearly[32], yearly[11], yearly[5], w.ledger.net.value], [7300, 1825, 2920, 4380, NET_PLAYER])
  })

  // ----- the no-change scenario is the Finances runway -----
  add('parity: the no-change scenario is the ledger\'s own net and runway, for every window', () => [30, 90, 180, 365].map((days) => {
    const w = world(m, { windowDays: days })
    const built = sr.buildShippingRunway({ windows: sr.windowLedgers({ treasury: w.treasury, wealth: w.wealth, windowDays: days, ledger: w.ledger, options: [30, 90, 180, 365] }), windowDays: days, version: '2.7.x', npr: false, tax: SAVED_TAX, inputs: inputsOf() })
    const first = none(built)

    return first.exhaustion === w.ledger.runway && first.net === w.ledger.net ? true : `window ${days}: not the ledger's own results`
  }).find((result) => result !== true) || true)
  add('parity: the no-change runway equals the treasury over the yearly loss worked by hand, for a treasury that lasts and one that is empty or in debt', () => {
    const expected = [[BALANCE, lasts(BALANCE / -NET_PLAYER)], [0, { state: 'depleted', years: 0 }], [-5, { state: 'depleted', years: 0 }]]

    return [30, 90, 180, 365].map((days) => expected.map(([balance, want]) => {
      const w = world(m, { balance, windowDays: days })

      return same(value(none(buildOf(m, w)).exhaustion), want)
    }).find((result) => result !== true) || true).find((result) => result !== true) || true
  })
  add('parity: a net that is not a loss is never exhausted, and a net of exactly 0 is not a loss', () => {
    const profit = world(m, { perCycle: { 11: 100, 5: 60 } })
    const level = world(m, { perCycle: { 11: 60, 5: 60 }, balance: 1000 })

    return same([value(none(buildOf(m, profit)).exhaustion), value(none(buildOf(m, level)).exhaustion)], [{ state: 'covered', years: null }, { state: 'covered', years: null }])
  })
  add('parity: one stretch with no end is the Finances runway, whatever the balance and the net', () => [[100, -50], [100, 0], [100, 25], [0, -1], [-4, 3], [0, 0]].every(([balance, net]) => same(sr.exhaustionOf(balance, [{ years: Infinity, net }]), finances.runwayOf(balance, net)) === true) || 'differs')
  add('parity: the runway rule is the treasury over the loss', () => same([finances.runwayOf(300, -100), finances.runwayOf(300, 100), finances.runwayOf(0, -1), finances.runwayOf(-9, -1), finances.runwayOf(0, 0)], [lasts(3), { state: 'covered', years: null }, { state: 'depleted', years: 0 }, { state: 'depleted', years: 0 }, { state: 'covered', years: null }]))

  // ----- piecewise exhaustion, balance and verdict -----
  add('exhaust: the nets of two stretches add up: 3000 at -1000 for 2 years leaves 1000 that lasts 2 more years at -500', () => same(sr.exhaustionOf(3000, [{ years: 2, net: -1000 }, { years: Infinity, net: -500 }]), lasts(4)))
  add('exhaust: an exhaustion inside the first stretch is the first stretch\'s own', () => same(sr.exhaustionOf(1500, [{ years: 2, net: -1000 }, { years: Infinity, net: -500 }]), lasts(1.5)))
  add('exhaust: a surplus first stretch builds the balance the second spends: 100 plus 3 years of 50 is 250, lasting 2.5 years at -100', () => same(sr.exhaustionOf(100, [{ years: 3, net: 50 }, { years: Infinity, net: -100 }]), lasts(5.5)))
  add('exhaust: a treasury emptied exactly at the end of a stretch under a loss ends there; one that is empty under a loss now is depleted; a debt under a surplus then a loss is exhausted when the loss begins', () => same([sr.exhaustionOf(1000, [{ years: 1, net: -1000 }, { years: Infinity, net: -1 }]), sr.exhaustionOf(0, [{ years: 1, net: -1 }, { years: Infinity, net: -1 }]), sr.exhaustionOf(5, [{ years: 1, net: 1 }, { years: Infinity, net: 2 }]), sr.exhaustionOf(-5, [{ years: 1, net: 2 }, { years: Infinity, net: -1 }])], [lasts(1), { state: 'depleted', years: 0 }, { state: 'covered', years: null }, lasts(1)]))
  add('exhaust: the balance at a year follows the stretches', () => same([sr.balanceAt(3000, [{ years: 2, net: -1000 }, { years: Infinity, net: -500 }], 1), sr.balanceAt(3000, [{ years: 2, net: -1000 }, { years: Infinity, net: -500 }], 3), sr.balanceAt(3000, [{ years: 2, net: -1000 }, { years: Infinity, net: -500 }], 0)], [2000, 500, 3000]))
  add('exhaust: a stretch of 0 years counts for nothing: a loss that lasts no time before a surplus never exhausts an empty or indebted treasury, before another loss it is that loss\'s runway, and a surplus that lasts no time before a loss leaves the treasury empty now', () => same([sr.exhaustionOf(0, [{ years: 0, net: -100 }, { years: Infinity, net: 100 }]), sr.exhaustionOf(-5, [{ years: 0, net: -100 }, { years: Infinity, net: 0 }]), sr.exhaustionOf(100, [{ years: 0, net: -100 }, { years: Infinity, net: -50 }]), sr.exhaustionOf(0, [{ years: 0, net: 100 }, { years: Infinity, net: -100 }])], [{ state: 'covered', years: null }, { state: 'covered', years: null }, lasts(2), { state: 'depleted', years: 0 }]))
  add('verdict: exhausted within the horizon, at the horizon, beyond it, never, now and unknown are told apart by kind', () => {
    const at = (state, years) => provenance.ofRule({ rule: 'shippingRunway.exhaustion', value: { state, years }, inputs: { present: ['x'] } })
    const unknown = provenance.unavailable({ rule: 'shippingRunway.exhaustion', missing: ['x'] })

    return same([sr.verdictOf(at('lasts', 10), 25), sr.verdictOf(at('lasts', 25), 25), sr.verdictOf(at('lasts', 25.5), 25), sr.verdictOf(at('covered', null), 25), sr.verdictOf(at('depleted', 0), 25), sr.verdictOf(unknown, 25)], [{ kind: 'exhausted', years: 10 }, { kind: 'exhausted', years: 25 }, { kind: 'beyond', years: 25.5 }, { kind: 'none', years: null }, { kind: 'now', years: 0 }, { kind: 'unknown', years: null }])
  })
  add('verdict: the same exhaustion is within a long horizon and beyond a short one', () => {
    const w = world(m)
    const first = none(buildOf(m, w))

    return same([5, 10, 25].map((horizon) => sr.verdictOf(first.exhaustion, horizon).kind), ['beyond', 'exhausted', 'exhausted'])
  })
  add('time: an exhaustion is dated by the years from now, a year being the history year of days', () => same([sr.exhaustionTime(1000, 2), sr.exhaustionTime(1000, 0.5), sr.SECONDS_PER_YEAR], [1000 + 2 * 365 * 86400, 1000 + 0.5 * 365 * 86400, 365 * 86400]))
  add('time: the trajectory steps by the years its horizon allows and starts at the treasury', () => {
    const w = world(m)
    const points = sr.trajectory(none(buildOf(m, w)), w.ledger.treasury, 10)

    return same(points.map((point) => point.year), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) === true && near(points[0].balance, BALANCE) && near(points[5].balance, BALANCE + 5 * NET_PLAYER) ? true : short(points)
  })
  add('time: a scenario with no figure has no trajectory', () => sr.trajectory(scenarioOf(buildOf(m, world(m)), 'government'), world(m).ledger.treasury, 10) === null ? true : 'a trajectory')
  add('time: a stretch that ends between two points of the grid is a point of the trajectory, so a trough there is kept: 100 at -100 for 2 years and then +100 is empty at year 1 and at -100 at year 2, though the grid of a 100-year horizon is every 5 years', () => {
    const treasury = provenance.ofRule({ rule: 'finances.treasury', value: 100, inputs: { present: ['treasury'] } })
    const segments = [{ years: 2, net: figure(-100) }, { years: Infinity, net: figure(100) }]
    const points = sr.trajectory({ segments }, treasury, 100)
    const trough = points.find((point) => point.year === 2)

    return trough && near(trough.balance, -100) && Math.min(...points.map((point) => point.balance)) <= 0 && points.some((point) => point.year === 5) && same(sr.exhaustionOf(100, [{ years: 2, net: -100 }, { years: Infinity, net: 100 }]), lasts(1)) === true ? true : short(points)
  })
  add('time: the years of a trajectory are the grid and every year inside the horizon a scenario\'s net changes at, in order and once, shared by the scenarios', () => {
    const built = buildOf(m, world(m), { pauseYears: '0.5', governmentCost: '0', planStart: '7.25', lines: [line('tradeGood', 100, 4, 10)] })
    const long = sr.trajectoryYears(built.scenarios, 10)
    const short5 = sr.trajectoryYears(built.scenarios, 5)
    const ordered = long.every((year, index) => index === 0 || year > long[index - 1])

    return ordered && [0, 0.5, 7.25, 10].every((year) => long.includes(year)) && short5.includes(0.5) && !short5.includes(7.25) && Math.max(...short5) === 5 ? true : short([long, short5])
  })
  add('time: a scenario whose net is unknown in any stretch has no trajectory, the no-change one included', () => {
    const treasury = provenance.ofRule({ rule: 'finances.treasury', value: 100, inputs: { present: ['treasury'] } })
    const unknown = provenance.unavailable({ rule: 'shippingRunway.scenarioNet', missing: ['x'] })
    const later = sr.trajectory({ segments: [{ years: 1, net: figure(1) }, { years: Infinity, net: unknown }] }, treasury, 5)
    const first = sr.trajectory({ segments: [{ years: 1, net: unknown }, { years: Infinity, net: figure(1) }] }, treasury, 5)

    return later === null && first === null ? true : short([later, first])
  })
  add('time: with no wealth history, or a logged row with no amount, the no-change scenario has no net and neither the trajectory nor the timeline holds a balance for it, though the treasury is known', () => {
    const w = world(m)
    const ledgers = [m.finances.buildLedger({ treasury: w.treasury, wealth: [], windowDays: 365 }), m.finances.buildLedger({ treasury: w.treasury, wealth: w.wealth.map((row, index) => (index === 0 ? { ...row, Amount: null } : row)), windowDays: 365 })]

    return ledgers.map((ledger) => {
      const built = buildOf(m, { ledger })
      const timeline = sr.balanceTimeline({ ledger, gameTime: GAME_TIME, scenarios: built.scenarios, horizon: 10 })

      return value(ledger.net) === null && value(ledger.treasury) !== null && sr.trajectory(none(built), ledger.treasury, 10) === null && timeline.paths.length === 0 && timeline.rows.every((row) => Object.keys(row.balances).length === 0) ? true : short([ledger.net, timeline.paths.length])
    }).find((result) => result !== true) || true
  })
  add('time: the timeline lists the past as the log reconstructs it, a balance for each cycle end from the start of the window up to today, and then every scenario\'s balance at the shared years ahead, from today\'s treasury', () => {
    const w = world(m)
    const built = buildOf(m, w, { governmentCost: '1460' })
    const timeline = sr.balanceTimeline({ ledger: w.ledger, gameTime: GAME_TIME, scenarios: built.scenarios, horizon: 5 })
    const past = timeline.rows.filter((row) => row.history !== null)
    const ahead = timeline.rows.filter((row) => row.history === null)
    const series = value(w.ledger.treasurySeries)

    return past.length === w.ledger.steps.length + 1 && same(past.map((row) => row.history), series) === true && past.every((row) => row.year <= 0) && near(past[past.length - 1].history, BALANCE) && past.every((row) => Object.values(row.balances).every((balance) => balance === null)) && ahead.length > 0 && ahead[0].year === 0 && near(ahead[0].balances.none, BALANCE) && timeline.rows.indexOf(ahead[0]) === past.length && timeline.paths.map((path) => path.id).join() === 'none,delay,government' ? true : short([past.length, ahead.length, timeline.paths.map((path) => path.id)])
  })
  add('delay: with the treasury empty or in debt, a pause of 0 years before deliveries that turn into income, or new contracts that start at once and earn more than the loss, never exhaust it', () => [0, -5].map((balance) => {
    const w = world(m, { balance })
    const delay = scenarioOf(buildOf(m, w, { pauseYears: '0', futureTax: '100' }), 'delay')
    const plan = scenarioOf(buildOf(m, w, { planStart: '0', lines: [line('tradeGood', 100000, 10, 10)] }), 'plan')
    const covered = { state: 'covered', years: null }

    return same([value(delay.exhaustion), value(plan.exhaustion)], [covered, covered])
  }).find((result) => result !== true) || true)

  // ----- contracts delayed -----
  add('delay: at the tax rate of now the pause costs the paired tax and saves the receipt: 7300 less 1825 a year during it, the net as it was after', () => {
    const w = world(m)
    const delay = scenarioOf(buildOf(m, w), 'delay')

    return same([value(delay.net), value(delay.later), value(delay.change), value(delay.shipping)], [REST, NET_PLAYER, REST - NET_PLAYER, 1825 - 7300 + (7300 - 1825)]) === true && same(value(delay.exhaustion), lasts(2 + (BALANCE - 2 * 1460) / 6935)) === true ? true : short([value(delay.net), value(delay.later), value(delay.exhaustion)])
  })
  add('delay: the exhaustion is the pause at the lighter loss and the rest of the treasury at the heavier one', () => {
    const delay = scenarioOf(buildOf(m, world(m)), 'delay')

    return same(value(delay.exhaustion), lasts(2 + (BALANCE - 2 * 1460) / 6935))
  })
  add('delay: a pause of 0 years is no change', () => {
    const w = world(m)
    const delay = scenarioOf(buildOf(m, w, { pauseYears: '0' }), 'delay')

    return same(value(delay.exhaustion), value(w.ledger.runway))
  })
  add('delay: a future tax of 50 % makes a delivery net nothing, so the net stays at the paused level for ever and the treasury lasts 47.5 years', () => {
    const delay = scenarioOf(buildOf(m, world(m), { futureTax: '50' }), 'delay')

    return same([value(delay.later), value(delay.exhaustion)], [NET_PLAYER + 7300 - 1825 - 4562.5 + 4562.5, lasts(47.5)])
  })
  add('delay: a future tax of 100 % turns the deliveries into income and the treasury is never exhausted', () => {
    const delay = scenarioOf(buildOf(m, world(m), { futureTax: '100' }), 'delay')

    return same([value(delay.later), value(delay.exhaustion)], [NET_PLAYER + 7300 - 1825 - 0 + 9125, { state: 'covered', years: null }])
  })
  const closeTo = (actual, expected) => (actual.length === expected.length && actual.every((item, index) => near(item, expected[index])) ? true : short([actual, expected]))
  add('delay: a pause of 0 years is not in force: the net now, the shipping net and the change are those of the stretch after it, and the net now is the balance change of the first year of the trajectory, for a pause of 0 and of 2 years', () => {
    const w = world(m)
    const seen = ['0', '2'].map((pauseYears) => {
      const delay = scenarioOf(buildOf(m, w, { pauseYears }), 'delay')
      const points = sr.trajectory(delay, w.ledger.treasury, 5)

      return [value(delay.net), value(delay.shipping), value(delay.change), points[1].balance - points[0].balance]
    })

    return closeTo(seen[0], [NET_PLAYER, -5475, 0, NET_PLAYER]) === true ? closeTo(seen[1], [-1460, 0, 5475, -1460]) : closeTo(seen[0], [NET_PLAYER, -5475, 0, NET_PLAYER])
  })
  add('delay: a pause left blank leaves the net now unknown and says what is missing', () => {
    const delay = scenarioOf(buildOf(m, world(m), { pauseYears: '' }), 'delay')

    return value(delay.net) === null && value(delay.shipping) === null && value(delay.change) === null ? gap(delay.net) : short([value(delay.net), value(delay.shipping), value(delay.change)])
  })
  add('plan: a plan that starts at once is in force now, so the net now is the planned net and the balance change of the first year; a later start leaves the net now as it is and keeps the shipping net and the change as those of the stretch to come, said by the focus of the scenario', () => {
    const w = world(m)
    const seen = ['0', '2'].map((planStart) => {
      const built = buildOf(m, w, { planStart, lines: [line('tradeGood', 1000, 10, 10)] })
      const plan = scenarioOf(built, 'plan')
      const points = sr.trajectory(plan, w.ledger.treasury, 5)

      return { figures: [value(plan.net), value(plan.later), value(plan.shipping), value(plan.change), points[1].balance - points[0].balance], focus: built.scenarios.map((scenario) => scenario.focus) }
    })
    const focus = same(seen.map((one) => one.focus), [['now', 'now', 'now', 'later'], ['now', 'now', 'now', 'later']])

    return focus === true ? (closeTo(seen[0].figures, [565, 565, 2025, 7500, 565]) === true ? closeTo(seen[1].figures, [NET_PLAYER, 565, 2025, 7500, NET_PLAYER]) : closeTo(seen[0].figures, [565, 565, 2025, 7500, 565])) : focus
  })
  add('delay: a tax rate of 0 set now means the contracts imply no paired tax: the pause saves all 7300, the resumed net is as logged', () => {
    const delay = scenarioOf(buildOf(m, world(m), { tax: { rate: 0, missing: '' } }), 'delay')

    return same([value(delay.net), value(delay.later), value(delay.exhaustion)], [NET_PLAYER + 7300, NET_PLAYER, lasts(2 + (BALANCE + 2 * 365) / 6935)])
  })
  add('delay: a computer-run empire\'s receipt is halved, so the same contracts imply a larger fare and tax; the pause nets 7300 less 3650', () => {
    const w = world(m, { perCycle: COMPUTER, balance: 2000 })
    const delay = scenarioOf(buildOf(m, w, { npr: true }), 'delay')
    const net = 2920 - 4380 + 3650 - 7300

    return same([value(delay.net), value(delay.later), value(delay.exhaustion)], [net + 7300 - 3650, net, lasts(2000 / 1460)])
  })
  add('delay: a computer-run empire\'s resumed fares at a changed rate are halved after the tax is taken', () => {
    const w = world(m, { perCycle: COMPUTER, balance: 5000 })
    const delay = scenarioOf(buildOf(m, w, { npr: true, futureTax: '30' }), 'delay')
    const later = -1460 - 18250 * 0.5 * 0.7 + 18250 * 0.3

    return same([value(delay.later), value(delay.exhaustion)], [later, lasts(2 + (5000 - 2920) / -later)])
  })
  add('delay: the actual contracts logged and the paired tax come from the log, not from a default', () => {
    const light = world(m, { perCycle: { 44: 10, 32: 2.5, 11: 40, 5: 60 } })
    const delay = scenarioOf(buildOf(m, light), 'delay')

    return same([value(delay.net), value(delay.later)], [REST, REST + 182.5 - 730]) === true || short([value(delay.net), value(delay.later)])
  })

  // ----- government transports -----
  add('gov: a blank running cost gives no figure, names the running cost, and is never taken as 0', () => {
    const blank = scenarioOf(buildOf(m, world(m), { governmentCost: '' }), 'government')
    const zero = scenarioOf(buildOf(m, world(m), { governmentCost: '0' }), 'government')

    return gap(blank.exhaustion) === true && value(blank.net) === null && value(zero.net) !== null && value(zero.exhaustion) !== null ? true : short([blank.exhaustion.inputs, value(zero.net)])
  })
  add('gov: a running cost of 0 is a figure: the net is the rest of the budget, 1460 short a year, lasting 47.5 years', () => {
    const zero = scenarioOf(buildOf(m, world(m), { governmentCost: '0' }), 'government')

    return same([value(zero.net), value(zero.exhaustion)], [REST, lasts(47.5)])
  })
  add('gov: the running cost comes off the net a year: 1460 more halves the runway to 23.75 years', () => {
    const cost = scenarioOf(buildOf(m, world(m), { governmentCost: '1460' }), 'government')

    return same([value(cost.net), value(cost.exhaustion)], [REST - 1460, lasts(23.75)])
  })
  add('gov: a running cost equal to the break-even leaves the net, and so the runway, as it was', () => {
    const w = world(m)
    const base = buildOf(m, w)
    const cost = scenarioOf(buildOf(m, w, { governmentCost: String(value(base.breakEven)) }), 'government')

    return near(value(base.breakEven), 7300 - 1825) && near(value(cost.net), NET_PLAYER) && near(value(cost.exhaustion).years, BALANCE / 6935) ? true : short([value(base.breakEven), value(cost.net)])
  })
  add('gov: a running cost below the break-even is better than the contracts, one above it worse', () => {
    const w = world(m)
    const years = (cost) => value(scenarioOf(buildOf(m, w, { governmentCost: cost }), 'government').exhaustion).years

    return years('1000') > years('5475') && years('9000') < years('5475') ? true : 'the order of the running costs'
  })
  add('gov: a negative or unreadable running cost gives no figure', () => ['-5', 'abc', ' '].every((cost) => value(scenarioOf(buildOf(m, world(m), { governmentCost: cost }), 'government').exhaustion) === null) || 'a figure')
  add('gov: the break-even is the contracts less the paired tax, and unavailable where the contracts cannot be split', () => {
    const w = world(m)
    const off = buildOf(m, w, { version: '2.6.0' })
    const thin = buildOf(m, world(m, { perCycle: { 44: 100, 32: 5, 11: 40, 5: 60 } }))

    return near(value(buildOf(m, w).breakEven), 5475) && value(off.breakEven) === null && value(thin.breakEven) === null && gap(off.breakEven) === true ? true : 'the break-even'
  })

  // ----- planned contracts -----
  add('plan: installation cargo costs the line\'s receipt after the tax and earns the tax: 1500 of fares at 20 % nets 300 less 1200', () => {
    const plan = scenarioOf(buildOf(m, world(m), { lines: [line('cargoPoint', 1000, 10, 1000)] }), 'plan')

    return same(value(plan.later), NET_PLAYER + 1500 * 0.2 - 1500 * 0.8)
  })
  add('plan: trade goods, colonists and passengers carry the tax only, at the published rates', () => {
    const w = world(m)
    const only = (input) => value(scenarioOf(buildOf(m, w, { lines: [input] }), 'plan').later) - NET_PLAYER
    const good = only(line('tradeGood', 100, 4, 10))
    const colonist = only(line('colonist', 100000, 10, 10))
    const passenger = only(line('passenger', 1000, 5, 10))

    return near(good, 100 * RATE.tradeGood * 4 * 10 * 0.2) && near(colonist, 100000 * RATE.colonist * 10 * 10 * 0.2) && near(passenger, 1000 * RATE.passenger * 5 * 10 * 0.2) ? true : short([good, colonist, passenger])
  })
  add('plan: several lines add, and the exhaustion follows the start entered: three years at the net as it is, then the lines', () => {
    const lines = [line('cargoPoint', 1000, 10, 1000), line('tradeGood', 100, 4, 10)]
    const plan = scenarioOf(buildOf(m, world(m), { lines, planStart: '3' }), 'plan')
    const later = NET_PLAYER - 900 + 300

    return same([value(plan.later), value(plan.exhaustion)], [later, lasts(3 + (BALANCE - 3 * 6935) / -later)])
  })
  add('plan: a computer-run empire\'s installation receipt is halved: 1500 of fares nets 300 less 600', () => {
    const w = world(m, { perCycle: COMPUTER })
    const plan = scenarioOf(buildOf(m, w, { npr: true, lines: [line('cargoPoint', 1000, 10, 1000)] }), 'plan')

    return same(value(plan.later), 2920 - 4380 + 3650 - 7300 + 300 - 600)
  })
  add('plan: the new contracts are rated at the future tax rate, the old ones too', () => {
    const plan = scenarioOf(buildOf(m, world(m), { futureTax: '50', lines: [line('tradeGood', 100, 4, 10)] }), 'plan')

    return same(value(plan.later), NET_PLAYER + 7300 - 1825 - 4562.5 + 4562.5 + 1500 * 0.5)
  })
  add('plan: a blank line is ignored, and an entered contract count of 0 adds nothing', () => {
    const w = world(m)
    const base = value(scenarioOf(buildOf(m, w, { lines: [line('tradeGood', 100, 4, 10)] }), 'plan').later)
    const blank = value(scenarioOf(buildOf(m, w, { lines: [line('tradeGood', 100, 4, 10), { category: 'cargoPoint', quantity: '', distance: '  ', perYear: '' }] }), 'plan').later)
    const zero = value(scenarioOf(buildOf(m, w, { lines: [line('tradeGood', 100, 4, 0)] }), 'plan').later)

    return near(base, blank) && near(zero, NET_PLAYER) ? true : short([base, blank, zero])
  })
  add('plan: no contract entered gives no figure, naming it, never a plan of nothing', () => {
    const plan = scenarioOf(buildOf(m, world(m), { lines: [{ category: 'tradeGood', quantity: '', distance: '', perYear: '' }] }), 'plan')

    return gap(plan.exhaustion)
  })
  add('plan: a line with a field missing, or unreadable, gives no figure', () => [line('tradeGood', '', 4, 10), line('tradeGood', 100, '', 10), line('tradeGood', 100, 4, ''), line('tradeGood', 'x', 4, 10), line('tradeGood', -1, 4, 10)].every((input) => value(scenarioOf(buildOf(m, world(m), { lines: [input] }), 'plan').exhaustion) === null) || 'a figure')
  add('plan: a category with no published rate gives no figure', () => value(scenarioOf(buildOf(m, world(m), { lines: [line('fuel', 100, 4, 10)] }), 'plan').exhaustion) === null ? true : 'a figure')

  // ----- blank and unreadable fields -----
  add('blank: a blank or unreadable number is unknown, never 0, and 0 is a number', () => same([sr.typedNumber(''), sr.typedNumber('  '), sr.typedNumber(null), sr.typedNumber(undefined), sr.typedNumber('abc'), sr.typedNumber(NaN), sr.typedNumber(Infinity), sr.typedNumber('0'), sr.typedNumber(0), sr.typedNumber('2.5'), sr.typedNumber(-3)], [null, null, null, null, null, null, null, 0, 0, 2.5, -3]))
  add('blank: a blank or negative pause gives no delay figure, naming the pause', () => ['', ' ', '-1', 'x'].every((text) => {
    const delay = scenarioOf(buildOf(m, world(m), { pauseYears: text }), 'delay')

    return value(delay.exhaustion) === null && gap(delay.exhaustion) === true
  }) || 'a figure')
  add('blank: a blank start gives no plan figure', () => value(scenarioOf(buildOf(m, world(m), { planStart: '', lines: [line('tradeGood', 100, 4, 10)] }), 'plan').exhaustion) === null ? true : 'a figure')
  add('blank: a blank, negative or over-100 future tax gives no figure for the scenarios that use it, and an untouched one is the rate now', () => {
    const w = world(m)
    const blank = scenarioOf(buildOf(m, w, { futureTax: '' }), 'delay')
    const over = scenarioOf(buildOf(m, w, { futureTax: '150' }), 'delay')
    const negative = scenarioOf(buildOf(m, w, { futureTax: '-1' }), 'delay')
    const untouched = scenarioOf(buildOf(m, w, { futureTax: null }), 'delay')
    const entered = scenarioOf(buildOf(m, w, { futureTax: '20' }), 'delay')

    return value(blank.exhaustion) === null && value(over.exhaustion) === null && value(negative.exhaustion) === null && same(value(untouched.exhaustion), value(entered.exhaustion)) === true ? true : 'the future tax'
  })
  add('blank: the future tax is a fraction of the percentage entered, assumed, and the rate now while untouched', () => {
    const now = sr.taxRateResult(SAVED_TAX)

    return same([value(sr.futureTaxResult('35', now)), sr.futureTaxResult('35', now).status, value(sr.futureTaxResult(null, now)), value(sr.futureTaxResult('', now)), value(sr.futureTaxResult(null, sr.taxRateResult(null)))], [0.35, 'assumed', 0.2, null, null])
  })

  // ----- inputs the version, the save and the log decide -----
  add('inputs: a game version with no published rules, or none, gives no scenario figure, and the no-change runway stays', () => [null, '2.6.0', '3.0.0'].every((version) => {
    const w = world(m)
    const built = buildOf(m, w, { version, governmentCost: '0', lines: [line('tradeGood', 100, 4, 10)] })

    return ['delay', 'government', 'plan'].every((id) => value(scenarioOf(built, id).exhaustion) === null) && none(built).exhaustion === w.ledger.runway
  }) || 'a figure')
  add('inputs: the unavailable scenarios name what is missing: the version rules', () => gap(scenarioOf(buildOf(m, world(m), { version: '2.6.0' }), 'delay').exhaustion))
  add('inputs: no tax rate stored gives no scenario figure, naming the rate, and the no-change runway stays', () => {
    const w = world(m)
    const built = buildOf(m, w, { tax: { rate: null, missing: 'FCT_Race.ShippingLineTax' }, governmentCost: '0' })

    return ['delay', 'government'].every((id) => value(scenarioOf(built, id).exhaustion) === null) && built.taxRate.inputs.missing.join().includes('FCT_Race.ShippingLineTax') && value(built.taxRate) === null && none(built).exhaustion === w.ledger.runway ? true : 'a figure'
  })
  add('inputs: a tax rate that has not been read (null) is unknown, a rate of 0 is a rate, and a negative rate is no rate', () => same([value(sr.taxRateResult(null)), value(sr.taxRateResult({ rate: 0, missing: '' })), value(sr.taxRateResult({ rate: -0.1, missing: '' })), value(sr.taxRateResult({ rate: 0.25, missing: '' }))], [null, 0, null, 0.25]))
  add('inputs: a tax rate of 100 % leaves no fare to imply from the receipt, so no scenario figure, with contracts logged or none', () => [world(m), world(m, { perCycle: { 11: 40, 5: 60 } })].every((w) => value(scenarioOf(buildOf(m, w, { tax: { rate: 1, missing: '' } }), 'delay').exhaustion) === null) || 'a figure')
  add('inputs: logged taxes below the tax the logged contracts imply give no scenario figure, naming the tax rate that held', () => {
    const delay = scenarioOf(buildOf(m, world(m, { perCycle: { 44: 100, 32: 10, 11: 40, 5: 60 } })), 'delay')

    return value(delay.exhaustion) === null && gap(delay.exhaustion) === true ? true : short(delay.exhaustion.inputs)
  })
  add('inputs: the tax paired with the contracts is held against the logged tax of installation deliveries alone: another logged civilian tax does not make up for it, and covers it only when the installation tax itself does', () => {
    const masked = scenarioOf(buildOf(m, world(m, { perCycle: { 44: 100, 47: 25, 11: 40, 5: 60 } })), 'delay')
    const own = scenarioOf(buildOf(m, world(m, { perCycle: { 44: 100, 32: 25, 47: 25, 11: 40, 5: 60 } })), 'delay')
    const maskedGross = buildOf(m, world(m, { perCycle: { 44: 100, 47: 25, 11: 40, 5: 60 } })).pieces.gross

    return value(masked.exhaustion) === null && gap(masked.exhaustion) === true && value(maskedGross) === null && value(own.exhaustion) !== null ? true : short([masked.exhaustion.inputs, value(own.exhaustion)])
  })
  add('inputs: the race kind must be known: a value that is neither true nor false gives no figure, and a computer-run empire halves the receipt', () => same([value(sr.kindResult(true)), value(sr.kindResult(false)), value(sr.kindResult(null)), value(sr.kindResult(undefined))], [0.5, 1, null, null]))

  // ----- the log's uses -----
  add('flows: the logged contracts, taxes and net of civilian shipping are the yearly sums of the log', () => {
    const w = world(m, { perCycle: { ...PLAYER, 29: 4 } })
    const flows = sr.civilianFlows(w.ledger)

    return same([value(flows.contracts), value(flows.taxes), value(flows.legacy), value(flows.net)], [7300, 1825, 292, 1825 - 7300 - 292])
  })
  add('flows: a civilian use not logged in the window is 0 for the use, not unknown', () => {
    const flows = sr.civilianFlows(world(m, { perCycle: { 11: 40, 5: 60 } }).ledger)

    return same([value(flows.contracts), value(flows.taxes), value(flows.net)], [0, 0, 0])
  })
  add('flows: a civilian use on the other side of the wealth use table gives no flow, naming the use', () => {
    const w = world(m)
    const wrong = w.wealth.map((row) => (row.UseID === 44 ? { ...row, Income: 1 } : row))
    const ledger = m.finances.buildLedger({ treasury: w.treasury, wealth: wrong, windowDays: 365 })
    const flows = sr.civilianFlows(ledger)
    const built = sr.buildScenarios({ ledger, version: '2.7.x', npr: false, tax: SAVED_TAX, inputs: inputsOf() })

    return value(flows.contracts) === null && value(flows.net) === null && flows.net.inputs.missing.join().includes(USES[44][0]) && value(scenarioOf(built, 'delay').exhaustion) === null && scenarioOf(built, 'none').exhaustion === ledger.runway ? true : short(flows.net.inputs)
  })
  add('flows: the civilian net is the taxes less the contracts and the uses nothing books', () => {
    const flows = sr.civilianFlows(world(m).ledger)

    return near(value(flows.net), 1825 - 7300) ? true : short(value(flows.net))
  })
  add('flows: the budget obligations leave out every civilian shipping use and the rest nets what is left of the ledger net', () => {
    const w = world(m, { perCycle: { ...PLAYER, 29: 4 } })
    const rest = sr.obligations(w.ledger, sr.civilianFlows(w.ledger))

    return same([rest.uses.map((use) => use.id).sort((a, b) => a - b), near(value(rest.rest), REST)], [[5, 11], true])
  })
  add('flows: the obligations list spending first, the larger first', () => {
    const w = world(m, { perCycle: { 44: 100, 5: 60, 6: 90, 11: 40 } })
    const rest = sr.obligations(w.ledger, sr.civilianFlows(w.ledger))

    return same(rest.uses.map((use) => [use.id, use.income]), [[6, false], [5, false], [11, true]])
  })
  add('roles: every civilian use of the log has a role, the taxes are income and the contract and the uses nothing books are spending', () => {
    const ids = m.tariff.CIVILIAN_USES.map((use) => use.id).sort((a, b) => a - b)
    const roles = Object.keys(sr.ROLES).map(Number).sort((a, b) => a - b)
    const sides = m.tariff.CIVILIAN_USES.every((use) => (sr.ROLES[use.id] === 'tax') === (use.side === 'income'))

    return same(roles, ids) === true && sides && sr.ROLES[sr.CONTRACT_USE] === 'contract' ? true : short([roles, ids, sides])
  })

  // ----- the saved tax rate -----
  const fake = fakeDatabase
  add('load: a stored rate is read for the game and race, and a stored 0 is a rate of 0', async () => {
    const sqls = []
    const read = await sr.loadShippingTax(fake(['RaceID', 'ShippingLineTax'], [{ ShippingLineTax: 0.2 }], sqls), { GameID: 7, RaceID: 9 })
    const zero = await sr.loadShippingTax(fake(['ShippingLineTax'], [{ ShippingLineTax: 0 }]), { GameID: 7, RaceID: 9 })

    return same([read.rate, zero.rate, /GameID = 7/.test(sqls.join()) && /RaceID = 9/.test(sqls.join())], [0.2, 0, true])
  })
  add('load: a save without the column, a race without a row and a null value give no rate, each naming what is missing, never 0', async () => {
    const noColumn = await sr.loadShippingTax(fake(['RaceID'], [{ ShippingLineTax: 0.5 }]), { GameID: 1, RaceID: 1 })
    const noRow = await sr.loadShippingTax(fake(['ShippingLineTax'], []), { GameID: 1, RaceID: 1 })
    const nulled = await sr.loadShippingTax(fake(['ShippingLineTax'], [{ ShippingLineTax: null }]), { GameID: 1, RaceID: 1 })

    return [noColumn, noRow, nulled].every((read) => read.rate === null && read.missing) && sr.taxRateResult(noRow).value === null ? true : short([noColumn, noRow, nulled])
  })
  add('load: the race kind is the stored NPR, read only where the save has the column: 1 is computer-run, 0 a player\'s, NULL, a value that is no number, no row and no column are unknown, never a player\'s', async () => {
    const withSqls = []
    const withoutSqls = []
    const kinds = []

    for (const stored of [1, 0, null, 'x']) {
      kinds.push((await sr.loadShippingTax(fake(['ShippingLineTax', 'NPR'], [{ ShippingLineTax: 0.2, NPR: stored }], withSqls), { GameID: 1, RaceID: 1 })).npr)
    }

    const without = await sr.loadShippingTax(fake(['ShippingLineTax'], [{ ShippingLineTax: 0.2, NPR: 1 }], withoutSqls), { GameID: 1, RaceID: 1 })
    const noRow = await sr.loadShippingTax(fake(['ShippingLineTax', 'NPR'], []), { GameID: 1, RaceID: 1 })
    const kindOnly = await sr.loadShippingTax(fake(['NPR'], [{ NPR: 1 }]), { GameID: 1, RaceID: 1 })

    return same([kinds, without.npr, noRow.npr, kindOnly.npr, kindOnly.rate, /NPR/.test(withSqls[1]), /NPR/.test(withoutSqls[1])], [[true, false, null, null], null, null, true, null, true, false])
  })
  add('load: the column is looked for in the save\'s schema before it is selected', async () => {
    const sqls = []

    await sr.loadShippingTax(fake([], [], sqls), { GameID: 1, RaceID: 1 })

    return sqls.length === 1 && /pragma_table_info/.test(sqls[0]) ? true : sqls.join(' | ')
  })

  // ----- actual and estimated, assumptions and uncertainty -----
  add('actual: the logged flows are estimates scaled from the log and the scenario figures are no better, the entered fields are assumptions', () => {
    const built = buildOf(m, world(m), { governmentCost: '1460', lines: [line('tradeGood', 100, 4, 10)] })
    const delay = scenarioOf(built, 'delay')

    return [built.flows.contracts.status, built.flows.taxes.status, built.flows.net.status, built.pause.status, built.running.status, built.futureTax.status, built.kind.status].join() === ['estimated', 'estimated', 'estimated', 'assumed', 'assumed', 'assumed', 'estimated'].join() && ['estimated', 'assumed'].includes(delay.net.status) && ['estimated', 'assumed'].includes(delay.exhaustion.status) ? true : [built.flows.contracts.status, built.pause.status, delay.exhaustion.status].join()
  })
  add('actual: no scenario figure claims to be confirmed', () => {
    const built = buildOf(m, world(m), { governmentCost: '1460', lines: [line('tradeGood', 100, 4, 10)] })

    return built.scenarios.flatMap((scenario) => [scenario.net, scenario.later, scenario.shipping, scenario.change, scenario.exhaustion]).every((result) => result.status !== 'confirmed') ? true : 'a confirmed scenario figure'
  })
  add('actual: every scenario but the no-change one lists the assumptions it rests on, and the actual flows list theirs', () => {
    const built = buildOf(m, world(m), { governmentCost: '1460', lines: [line('tradeGood', 100, 4, 10)] })

    return built.scenarios.every((scenario) => scenario.assumptions.length > 0) && built.scenarios.filter((scenario) => scenario.id !== 'none').every((scenario) => scenario.exhaustion.assumptions.length > 0) && built.flows.contracts.assumptions.length > 0 ? true : 'an assumption is missing'
  })
  add('actual: the rules of the figures are registered with a verification no higher than estimated except the saved rate, and the entered inputs are assumed', () => {
    const rules = ['shippingRunway.windowFlow', 'shippingRunway.contractFlow', 'shippingRunway.planLine', 'shippingRunway.scenarioNet', 'shippingRunway.exhaustion', 'shippingRunway.breakEven', 'shippingRunway.windowSpread']

    return rules.every((id) => provenance.getRule(id) && provenance.getRule(id).verification === 'estimated') && provenance.getRule('shippingRunway.assumption').verification === 'assumed' && provenance.getRule('shippingRunway.windowTax').verification === 'assumed' ? true : 'a rule is registered above what it is'
  })
  add('actual: the breaks of the shipping contracts rule cover the versions the payout rates are published for, and no other', () => ['2.7.x'].every((version) => provenance.ruleSupports('shippingRunway.contractFlow', version) === true) && ['2.6.0', null, 'x'].every((version) => provenance.ruleSupports('shippingRunway.contractFlow', version) !== true) ? true : 'the gate')

  // ----- the windows -----
  const spreadWorld = () => {
    const w = world(m, { perCycle: { 11: 40, 5: 20 }, balance: 11680, shape: { 5: [200, 20, 6] }, windowDays: 365 })

    return w
  }
  const spreadOf = (w, id = 'none', options = [30, 90, 180, 365]) => sr.buildShippingRunway({ windows: sr.windowLedgers({ treasury: w.treasury, wealth: w.wealth, windowDays: w.windowDays, ledger: w.ledger, options }), windowDays: w.windowDays, version: '2.7.x', npr: false, tax: SAVED_TAX, inputs: inputsOf({ governmentCost: '0' }) }).spread[id]
  add('window: the spread names the earliest and the latest exhaustion across the windows, with the window each comes from', () => {
    const spread = spreadOf(spreadWorld())

    return same(spread.value, { earliest: { days: 30, order: 1 }, latest: { days: 365, order: Infinity }, known: 4, total: 4 })
  })
  add('window: a window changes the figures, and the selected window is what the scenarios show', () => {
    const w = spreadWorld()
    const small = world(m, { perCycle: { 11: 40, 5: 20 }, balance: 11680, shape: { 5: [200, 20, 6] }, windowDays: 30 })
    const built = sr.buildShippingRunway({ windows: sr.windowLedgers({ treasury: small.treasury, wealth: small.wealth, windowDays: 30, ledger: small.ledger, options: [30, 90, 180, 365] }), windowDays: 30, version: '2.7.x', npr: false, tax: SAVED_TAX, inputs: inputsOf() })

    return same([built.windowDays, value(scenarioOf(built, 'none').exhaustion), value(w.ledger.runway)], [30, lasts(1), { state: 'covered', years: null }])
  })
  add('window: one window that does not give a figure is named and the rest still give a spread; none at all gives no spread', () => {
    const w = world(m, { perCycle: { 11: 40, 5: 60 }, balance: 1000, windowDays: 365 })
    const gapped = m.finances.buildLedger({ treasury: w.treasury, wealth: [], windowDays: 30 })
    const sets = [{ days: 365, built: buildOf(m, w) }, { days: 30, built: buildOf(m, { ledger: gapped }) }]
    const part = sr.windowSpread(sets, 'none')
    const empty = sr.windowSpread([sets[1]], 'none')

    return part.value !== null && part.value.known === 1 && part.value.total === 2 && part.inputs.missing.length === 1 && value(empty) === null && gap(empty) === true ? true : short([part.value, empty.value])
  })
  add('window: a scenario nobody can work out has no spread', () => {
    const w = spreadWorld()
    const built = sr.buildShippingRunway({ windows: sr.windowLedgers({ treasury: w.treasury, wealth: w.wealth, windowDays: w.windowDays, ledger: w.ledger, options: [30, 365] }), windowDays: w.windowDays, version: '2.6.0', npr: false, tax: SAVED_TAX, inputs: inputsOf() })

    return value(built.spread.delay) === null && gap(built.spread.delay) === true && value(built.spread.none) !== null ? true : 'a spread'
  })

  // ----- the panel -----
  add('component: every window the page offers is built, the selected one from the page\'s own ledger', () => {
    const w = world(m)
    const windows = sr.windowLedgers({ treasury: w.treasury, wealth: w.wealth, windowDays: 90, ledger: 'the page ledger', options: [30, 90, 180, 365] })

    return same(windows.map((entry) => entry.days), [30, 90, 180, 365]) === true && windows.find((entry) => entry.days === 90).ledger === 'the page ledger' && windows.find((entry) => entry.days === 365).ledger.net ? true : 'the windows'
  })

  return statements
}

const componentChecks = (ctx) => {
  const { m, componentOptions, componentText, pageText, pageOptions, pageReal } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const w = world(m)
  const fake = fakeDatabase
  const date = (seconds) => String(Math.round(seconds)).replace(/\d/g, (digit) => 'abcdefghij'[digit])
  const props = (over = {}) => ({ ledger: w.ledger, treasury: w.treasury, wealth: w.wealth, windowDays: 365, windowOptions: [30, 90, 180, 365], formulaVersion: '2.7.x', npr: false, tax: SAVED_TAX, taxState: { loading: false, failed: '', error: '' }, date, separator: '', historyRecorded: true, ...over })
  // Every input of the panel at a value of its own, so that no check rests on the default the panel starts with.
  const INPUT_DATA = { horizon: 25, futureTax: null, pauseYears: '2', governmentCost: '', planStart: '0', view: 'chart' }
  const mount = (over = {}, data = {}) => instantiate(componentOptions, { $store: STORE, data: { ...props(over), ...INPUT_DATA, ...data } })
  const panelAst = () => templateOf(componentText).ast
  // The panel rendered by Vue itself in a state of its own: `state(world)` is [props, data]; gives the summary of the card it makes and every warning or error Vue raised.
  const rendered = (state) => {
    const problems = []
    const { compiled } = templateOf(componentText)

    if (compiled.errors.length) {
      throw new Error(compiled.errors.map(String).join(' '))
    }

    const { render, staticRenderFns } = nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)
    const fresh = world(m)
    const [over, data] = state(fresh)

    Vue.config.productionTip = false
    Vue.config.devtools = false
    Vue.config.warnHandler = (message) => problems.push(message)
    Vue.config.errorHandler = (error) => problems.push(String(error))

    const vm = new Vue({ mixins: [componentOptions], propsData: { ...props(), ledger: fresh.ledger, treasury: fresh.treasury, wealth: fresh.wealth, ...over }, data: () => ({ ...INPUT_DATA, ...data }), render, staticRenderFns })
    const card = vm._render()

    return { summary: card && card.data && card.data.attrs ? card.data.attrs['data-summary'] : undefined, problems }
  }
  const exhaustion = (kind, years) => m.provenance.ofRule({ rule: 'shippingRunway.exhaustion', value: kind === 'covered' ? { state: 'covered', years: null } : kind === 'depleted' ? { state: 'depleted', years: 0 } : { state: 'lasts', years }, inputs: { present: ['x'] } })

  add('component: the panel shows the runway of the no-change scenario first, and then each scenario once', () => same(mount().rows.map((row) => row.id), ['none', 'delay', 'government', 'plan']))
  add('component: the exhaustion is said in five ways, each told apart, and a date or the horizon is in the words that need one', () => {
    const vm = mount({}, { horizon: 25 })
    const texts = [vm.exhaustionText({ exhaustion: exhaustion('lasts', 10) }), vm.exhaustionText({ exhaustion: exhaustion('lasts', 40) }), vm.exhaustionText({ exhaustion: exhaustion('covered') }), vm.exhaustionText({ exhaustion: exhaustion('depleted') }), vm.exhaustionText({ exhaustion: m.provenance.unavailable({ rule: 'shippingRunway.exhaustion', missing: ['x'] }) })]
    const dateOf = (years) => date(m.sr.exhaustionTime(w.treasury.GameTime, years))

    return new Set(texts).size === 5 && texts[0].includes(dateOf(10)) && texts[1].includes('25') && texts[1].includes(dateOf(40)) && texts.every((text) => text.length > 0) ? true : short(texts)
  })
  add('component: the no-change row\'s exhaustion text is the Finances runway of the same ledger over the horizon', () => {
    const vm = mount()

    return vm.rows[0].exhaustion === vm.ledger.runway && vm.rows[0].exhaustionText.includes(date(m.sr.exhaustionTime(w.treasury.GameTime, BALANCE / 6935))) ? true : vm.rows[0].exhaustionText
  })
  add('component: a government cost left blank leaves that row without a figure and says what it needs, and 0 gives one', () => {
    const blank = mount()
    const zero = mount({}, { governmentCost: '0' })
    const row = (vm) => vm.rows.find((item) => item.id === 'government')

    return value(row(blank).exhaustion) === null && value(row(zero).exhaustion) !== null && row(blank).exhaustion.inputs.missing.length > 0 && row(blank).exhaustion.inputs.missing.every((item) => blank.limitationText(row(blank).exhaustion).includes(item)) ? true : blank.limitationText(row(blank).exhaustion)
  })
  add('component: the untouched future tax shows the rate set now, and an entry replaces it, a blank one stays blank', () => {
    const vm = mount()
    const shown = vm.futureTaxShown

    vm.setFutureTax('35')

    const entered = vm.futureTaxShown

    vm.setFutureTax('')

    return same([shown, entered, vm.futureTaxShown], ['20', '35', '']) === true && value(vm.model.futureTax) === null ? true : short([shown, entered, vm.futureTaxShown])
  })
  add('component: the horizon is a choice of years the scenarios are read over, the longest covering the longest runway of the no-change row', () => {
    const vm = mount()

    return vm.horizons.includes(vm.horizon) && Math.max(...vm.horizons) >= BALANCE / 6935 ? true : short(vm.horizons)
  })
  add('component: the chart draws the balances the log reconstructs apart from the scenarios: a solid line, dashed lines for the estimates, each labelled otherwise than its scenario, and no line claims to be a recorded balance', () => {
    const vm = mount({}, { governmentCost: '1460' })
    const [past, ...future] = vm.chart.datasets

    return past.borderDash === undefined && !/actual/i.test(past.label) && future.length === vm.legend.length && future.length >= 3 && future.every((dataset, index) => Array.isArray(dataset.borderDash) && dataset.borderDash.length > 0 && dataset.label !== vm.legend[index].label && dataset.label.includes(vm.legend[index].label) && dataset.label !== past.label) ? true : short(vm.chart.datasets.map((dataset) => [dataset.label, dataset.borderDash]))
  })
  add('component: every point of every line of the chart is a row of the table beside it with its date and its balance, the log\'s balances included, and every row of the table is a point of the chart', () => {
    const vm = mount({}, { governmentCost: '1460' })
    const rows = vm.balanceRows
    const lines = [{ points: vm.chart.datasets[0].data, pick: (row) => row.history }, ...vm.legend.map((entry, index) => ({ points: vm.chart.datasets[index + 1].data, pick: (row) => row.balances[entry.id] }))]
    const listed = lines.every((line) => line.points.length === rows.filter((row) => line.pick(row) !== null).length && line.points.every((point) => rows.some((row) => near(row.year, point.x) && line.pick(row) === point.y)))
    const drawn = rows.every((row) => lines.some((line) => line.pick(row) !== null))

    return listed && drawn && lines[0].points.length > 1 && rows.every((row) => typeof row.date === 'string' && row.date.length > 0) ? true : short([lines.map((line) => line.points.length), rows.length])
  })
  add('component: a scenario without a figure is left out of the chart and the table, not drawn as flat', () => same(mount().legend.map((entry) => entry.id), ['none', 'delay']))
  add('component: the horizon sets the span of the table of balances, and a stretch that ends between two years is a row of it', () => {
    const ahead = (vm) => vm.balanceRows.filter((row) => row.history === null)
    const short5 = ahead(mount({}, { horizon: 5 }))
    const long = ahead(mount({}, { horizon: 50 }))
    const fractional = ahead(mount({}, { horizon: 5, pauseYears: '0.5' }))

    return short5.length === 6 && short5[5].year === 5 && long[long.length - 1].year === 50 && fractional.some((row) => row.year === 0.5) ? true : short([short5.length, long.length])
  })
  add('component: the spread across the windows is said for the scenario, naming the windows of the earliest and the latest when they differ', () => {
    const vm = mount()
    const spread = vm.rows[0].spread

    return value(spread) !== null && vm.rows[0].spreadText.length > 0 ? true : 'no spread'
  })
  add('component: the spread is words for every ending: in every window, a range, and not known', () => {
    const vm = mount()
    const at = (earliest, latest, known = 4, total = 4) => m.provenance.ofRule({ rule: 'shippingRunway.windowSpread', value: { earliest, latest, known, total }, inputs: { present: ['x'] } })
    const texts = [vm.spreadText(at({ days: 30, order: 5 }, { days: 365, order: 5 })), vm.spreadText(at({ days: 30, order: 1 }, { days: 365, order: Infinity })), vm.spreadText(m.provenance.unavailable({ rule: 'shippingRunway.windowSpread', missing: ['x'] }))]

    return new Set(texts).size === 3 && texts[1].includes('30') && texts[1].includes('365') ? true : short(texts)
  })
  add('component: the panel\'s money is shown with the unknown as a dash, never 0', () => {
    const vm = mount()

    return same([vm.money(null), vm.money(undefined), vm.signed(NaN), vm.percent(null), vm.money(0)], ['—', '—', '—', '—', '0'])
  })
  add('component: the new contract rows start with one blank row, add and remove, and never leave none', () => {
    const vm = mount()
    const first = vm.lines.length

    vm.addLine()
    vm.removeLine(vm.lines[0])
    vm.removeLine(vm.lines[0])

    return first === 1 && vm.lines.length === 1 && vm.lines[0].quantity === '' ? true : short(vm.lines)
  })
  add('component: the categories offered are the ones a rate is published for', () => same(mount().categoryItems.map((category) => category.id).sort(), [...m.sr.PLAN_CATEGORIES].sort()))
  add('component: a read of the tax rate still in flight or failed is the panel\'s own state, shown in place of the body, with a way to read it again', () => {
    const ast = panelAst()
    const gate = elementsOf(ast, (el) => typeof el.if === 'string' && el.if.includes('taxState.loading') && el.if.includes('taxState.failed'))
    const state = gate.length === 1 ? elementsOf(gate[0], (el) => el.tag === 'load-state' && attrOf(el, ':failed') === 'taxState.failed' && attrOf(el, '@retry') === '$emit(\'retry\')') : []
    const body = gate.length === 1 && gate[0].ifConditions.length === 2 ? gate[0].ifConditions[1].block : null

    return state.length === 1 && body && classesOf(body).includes('panel-body') ? true : 'the load state'
  })
  add('component: the panel is one card of class panel whose summary is a plain attribute of the card, a head first and one foot', () => {
    const ast = panelAst()
    const summary = attrOf(ast, 'data-summary')
    const bound = [':data-summary', 'v-bind:data-summary'].some((name) => attrOf(ast, name) !== undefined)
    const first = childElements(ast)[0]

    return ast.tag === 'v-card' && classesOf(ast).includes('panel') && typeof summary === 'string' && summary.trim() !== '' && !bound && !ast.if && !ast.for && first && classesOf(first).includes('panel-head') && elementsOf(ast, (el) => classesOf(el).includes('panel-foot')).length === 1 ? true : short([ast.tag, classesOf(ast), summary, bound])
  })
  add('component: the summary of the panel is the same in every state, the loading and the failed read, no tax, no history and a table over a long horizon, and Vue renders each without a warning or an error', () => {
    const loading = { loading: true, failed: '', error: '' }
    const failed = { loading: false, failed: 'locked', error: 'busy' }
    const states = [
      () => [{}, {}],
      () => [{ taxState: loading }, {}],
      () => [{ taxState: failed }, {}],
      () => [{ tax: null }, {}],
      (fresh) => [{ ledger: m.finances.buildLedger({ treasury: fresh.treasury, wealth: [], windowDays: 365 }), wealth: [] }, {}],
      () => [{ npr: true, formulaVersion: null }, { horizon: 100, view: 'table', governmentCost: '9', lines: [{ id: 1, ...line('tradeGood', 100, 4, 10) }] }],
    ]
    const seen = states.map((state) => rendered(state))
    const written = attrOf(panelAst(), 'data-summary')

    return seen.every((one) => typeof one.summary === 'string' && one.summary === written && one.summary.trim() !== '') && seen.every((one) => one.problems.length === 0) ? true : short(seen.map((one) => [one.summary === written, one.problems]))
  })
  add('component: the template compiles, and the panel speaks in no first or second person nor names the game\'s sources', () => {
    const errors = templateErrors(componentText)

    return errors.length ? short(errors) : !PRONOUNS.test(componentText.replace(/<style[\s\S]*$/, '').replace(/<script[\s\S]*?<\/script>/, (script) => script.replace(/\/\/[^\n]*/g, ''))) && !SOURCE_NAMES.test(componentText) ? true : 'a pronoun or a source name'
  })
  add('component: every figure shown in the panel carries a provenance mark, its own or its row\'s, the cells of the balance table having theirs on the column heads', () => {
    const ast = panelAst()
    const figures = nodesOf(ast, (node) => node.type === 2 && /\b(money|signed|percent)\(|exhaustionText|spreadText/.test(node.text) && !/\bpoint\./.test(node.text))
    const bare = figures.filter((node) => !(node.parentNode && hasMark(node.parentNode)) && !(node.parentNode && node.parentNode.parentNode && hasMark(node.parentNode.parentNode))).map((node) => node.text.trim())
    const heads = elementsOf(ast, (el) => el.tag === 'th' && (el.for === 'legend' || el.if === 'hasHistory'))

    return bare.length === 0 && figures.length > 4 && heads.length === 2 && heads.every(hasMark) ? true : short([bare, figures.length, heads.length])
  })
  add('component: the chart has a table of the same balances beside it, behind a toggle, with a column for the log\'s balances and one for each scenario', () => {
    const ast = panelAst()
    const toggle = elementsOf(ast, (el) => el.tag === 'v-btn' && attrOf(el, 'value') === 'table')
    const tables = elementsOf(ast, (el) => el.tag === 'v-simple-table' && el.else === true)
    const rows = elementsOf(ast, (el) => el.tag === 'tr' && el.for === 'balanceRows')
    const shown = (needle) => rows.length === 1 && nodesOf(rows[0], (node) => node.type === 2 && node.text.includes(needle)).length > 0

    return elementsOf(ast, (el) => el.tag === 'chart-canvas').length === 1 && toggle.length === 1 && tables.length === 1 && shown('.history') && shown('.balances[') ? true : 'no table alternative'
  })
  add('component: the chart carries a label that says what it plots', () => {
    const charts = elementsOf(panelAst(), (el) => el.tag === 'chart-canvas')
    const label = charts.length === 1 ? attrOf(charts[0], 'label') || attrOf(charts[0], ':label') : ''

    return typeof label === 'string' && label.trim() !== '' ? true : 'no chart label'
  })
  add('component: the panel links to Empire History for the observed rate and builds none of it', () => {
    const links = elementsOf(panelAst(), (el) => el.tag === 'router-link' && attrOf(el, 'to') === '/history')
    const names = [...Object.keys(componentOptions.props || {}), ...Object.keys(componentOptions.computed || {}), ...Object.keys(componentOptions.methods || {}), ...Object.keys(componentOptions.data ? componentOptions.data.call({}) : {})]

    return links.length === 1 && !names.some((name) => /stock|observed/i.test(name)) ? true : short([links.length, names])
  })
  add('component: the figures of the log and the estimates sit under their own marked headings, the log first', () => {
    const ast = panelAst()
    const chips = elementsOf(ast, (el) => el.tag === 'v-chip')
    const scenarios = elementsOf(ast, (el) => el.tag === 'tr' && attrOf(el, ':data-scenario') !== undefined)

    return chips.length >= 2 && new Set(chips.map((chip) => attrOf(chip, 'color'))).size >= 2 && scenarios.length === 1 && chips.every((chip) => chip.start < scenarios[0].start) && chips[0].start < chips[1].start ? true : short([chips.length, scenarios.length])
  })
  add('component: a race kind that is not known is not a player\'s: the prop left out or null gives no figure that depends on it, a computer-run empire gives one', () => {
    const wc = world(m, { perCycle: COMPUTER })
    const panel = (over, omit = []) => {
      const given = { ...props(), ledger: wc.ledger, treasury: wc.treasury, wealth: wc.wealth, ...over }

      omit.forEach((key) => delete given[key])

      return new Vue({ mixins: [componentOptions], propsData: given, data: () => ({ ...INPUT_DATA }) })
    }
    const seen = [panel({}, ['npr']), panel({ npr: null }), panel({ npr: true })].map((vm) => [vm.npr, value(vm.model.scenarios.find((scenario) => scenario.id === 'delay').net) === null])

    return same(seen, [[null, true], [null, true], [true, false]])
  })
  add('component: it keeps its own view choices and registers them like any other', () => {
    const fields = [...componentText.matchAll(/key: '(\w+)'/g)].map((match) => match[1])

    return fields.length === 2 && fields.every((key) => /^finances/.test(key)) ? true : short(fields)
  })

  // ----- the page -----
  const labels = (pageText.match(/const INPUT_LABELS = \{([\s\S]*?)\n\}/) || [])[1] || ''
  const labelKeys = [...labels.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])
  const trackedKeys = [...pageText.matchAll(/tracked\('(\w+)'/g)].map((match) => match[1])
  const mountTag = (pageText.match(/<shipping-runway\b[^>]*>/) || [''])[0]
  const READ = 'shippingTax'
  const mountPage = (data = {}) => instantiate(pageOptions, { $store: STORE, data: { loadErrors: {}, ...data } })
  const mountReal = (data = {}) => instantiate({ mixins: [pageReal], methods: { inputSettled() {} } }, { $store: STORE, data: { loadErrors: {}, treasury: w.treasury, wealth: w.wealth, formulaVersion: '2.7.x', ...data } })
  const coreSettled = () => Object.assign({}, ...labelKeys.filter((key) => key !== READ).map((key) => ({ [key]: null })))

  add('page: the panel is mounted once with the ledger, the treasury row, the wealth rows, the window, the version, the race kind, the tax read and its state, and registered', () => {
    const bound = attributesOf(mountTag)
    const wanted = { ':ledger': 'ledger', ':treasury': 'treasury', ':wealth': 'wealth', ':window-days': 'windowDays', ':window-options': 'windowOptions', ':formula-version': 'formulaVersion', ':tax': 'shippingTax', ':tax-state': 'shippingTaxState', ':date': 'date', ':separator': 'separator', '@retry': 'retryShippingTax' }

    return Object.entries(wanted).every(([name, expression]) => bound[name] === expression) && isText(bound[':npr']) && !/RaceNPR/.test(bound[':npr']) && (pageText.match(/<shipping-runway\b/g) || []).length === 1 && 'ShippingRunway' in pageOptions.components ? true : `${mountTag} ${Object.keys(pageOptions.components)}`
  })
  add('page: the race kind reaches the panel as stored: NULL is unknown whatever the selection\'s flag says, 1 is computer-run and 0 a player\'s, and an unknown kind gives the panel no figure that depends on it', async () => {
    const bound = String(attributesOf(mountTag)[':npr'])
    const names = bound.match(/[A-Za-z_$][\w$]*/g) || []
    const given = async (stored, flag) => {
      const vm = mountPage({ database: fake(['ShippingLineTax', 'NPR'], [{ ShippingLineTax: 0.2, NPR: stored }]), GameID: 7, RaceID: 9, RaceNPR: flag })

      await vm.runAsync(READ)

      return nodeVm.runInNewContext(bound, Object.fromEntries(names.filter((name) => name in vm).map((name) => [name, vm[name]])))
    }
    const seen = [await given(null, false), await given(null, true), await given(1, false), await given(0, true)]
    const wc = world(m, { perCycle: COMPUTER })
    const net = (npr) => value(scenarioOf(buildOf(m, wc, { npr }), 'delay').net)

    return same([seen, net(seen[0]) === null, net(seen[2]) !== null], [[null, null, true, false], true, true])
  })
  add('page: the panel sits after every other panel, outside the gate of the cycles table and inside the gate where the page is ready', () => {
    const ast = templateOf(pageText).ast
    const mounts = elementsOf(ast, (el) => el.tag === 'shipping-runway')
    const panels = elementsOf(ast, (el) => el.tag === 'v-card' && classesOf(el).includes('panel'))
    const gates = []

    for (let node = mounts.length ? mounts[0].parentNode : null; node; node = node.parentNode) {
      if (node.if) {
        gates.push(node.if)
      }
    }

    return mounts.length === 1 && gates.includes('ready') && !gates.some((gate) => gate.includes('steps')) && panels.length > 1 && panels.every((panel) => panel.start < mounts[0].start) ? true : short([mounts.length, gates, panels.length])
  })
  add('page: the read has one name as a tracked key, an asyncComputed and an INPUT_LABELS key, with a default of null', () => {
    const asyncKeys = Object.keys(pageOptions.asyncComputed)

    return labelKeys.includes(READ) && trackedKeys.includes(READ) && asyncKeys.includes(READ) && trackedKeys.every((key) => asyncKeys.includes(key) && labelKeys.includes(key)) && pageOptions.asyncComputed[READ].default === null ? true : short([labelKeys, trackedKeys, asyncKeys])
  })
  add('page: the read is of the race and game selected, waits for a database, a game and a race, and keeps the saved tax rate or its absence', async () => {
    const empty = mountPage({ database: null, GameID: 1, RaceID: 2 })
    const none = await empty.runAsync(READ)
    const noRace = await mountPage({ database: fake([], []), GameID: 1, RaceID: null }).runAsync(READ)
    const noGame = await mountPage({ database: fake([], []), GameID: null, RaceID: 2 }).runAsync(READ)
    const sqls = []
    const database = fake(['ShippingLineTax'], [{ ShippingLineTax: 0.3 }], sqls)
    const full = mountPage({ database, GameID: 7, RaceID: 9 })
    const read = await full.runAsync(READ)

    return none === null && noRace === null && noGame === null && read.rate === 0.3 && full.loadErrors[READ] === null && /GameID = 7/.test(sqls.join()) && /RaceID = 9/.test(sqls.join()) ? true : short([none, noRace, noGame, read])
  })
  add('page: the runway page does not wait for the tax read, and a failure of it is shown on the panel alone', async () => {
    const busy = { query: async () => { throw new Error('SQLITE_BUSY') } }
    const vm = mountReal({ loadErrors: coreSettled(), database: busy, GameID: 1, RaceID: 2 })
    const before = [vm.ready, vm.inputsLoaded, vm.shippingTaxState.loading]

    await vm.runAsync(READ).catch(() => {})

    const failed = [vm.ready, vm.failedInputs.length, vm.failedInputsText, vm.shippingTaxState.failed !== '', vm.shippingTaxState.loading, vm.shippingTaxState.error]

    vm.loadErrors[READ] = null

    return same([before, failed, [vm.ready, vm.shippingTaxState.loading, vm.shippingTaxState.failed]], [[true, true, true], [true, 0, '', true, false, 'SQLITE_BUSY'], [true, false, '']])
  })
  add('page: a core read that fails still holds the page back, and the tax read in flight or failed gives the panel no figures', () => {
    const vm = mountReal({ loadErrors: { ...coreSettled(), treasury: 'locked' } })
    const alone = mountReal({ loadErrors: { ...coreSettled(), [READ]: 'locked' } }).shippingTaxState
    const again = mountReal({ loadErrors: { ...coreSettled(), [READ]: undefined } }).shippingTaxState

    return same([vm.ready, vm.failedInputs, alone.failed !== '', alone.loading, again.failed, again.loading], [false, ['treasury'], true, false, '', true])
  })
  add('page: the page without a treasury row is not ready, even with every read in', () => same(mountReal({ loadErrors: { ...coreSettled(), [READ]: null }, treasury: null }).ready, false))
  add('page: the optional read is named in the words of the load state: its own label, which no other read has', () => {
    const labelOf = (key) => (labels.match(new RegExp(`^ {2}${key}:\\s*'([^']*)'`, 'm')) || [])[1]
    const own = labelOf(READ)
    const failed = mountReal({ loadErrors: { ...coreSettled(), [READ]: 'locked' } }).shippingTaxState.failed

    return typeof own === 'string' && own.trim() !== '' && labelKeys.filter((key) => key !== READ).every((key) => labelOf(key) !== own) && failed.includes(own) ? true : short([own, failed])
  })
  add('page: the template compiles, and the page speaks in no first or second person nor names the game\'s sources', () => {
    const errors = templateErrors(pageText)

    return errors.length ? short(errors) : !SOURCE_NAMES.test(pageText) && !PRONOUNS.test(mountTag) ? true : 'a pronoun or a source name'
  })
  add('wiring: the utility and the check speak in no first or second person in their texts, and name no source of the game', () => {
    const text = fs.readFileSync(FILES.utility, 'utf8')
    const strings = [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((match) => match[1]).filter((item) => item.length > 12)

    return strings.every((item) => !PRONOUNS.test(item)) && !SOURCE_NAMES.test(text) && !SOURCE_NAMES.test(componentText) ? true : short(strings.filter((item) => PRONOUNS.test(item)))
  })

  return statements
}

// ---------- the saves ----------

const rowsFrom = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (problem, rows) => (problem ? reject(problem) : resolve([rows]))))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

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

    resolve({ query: (sql) => rowsFrom(raw, sql), close: () => closeRaw(raw) })
  })
})

const saveStatements = async (ctx, save) => {
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true }
  }

  const { m, pageOptions } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const vm = instantiate(pageOptions, { $store: STORE, database, GameID: save.game, RaceID: save.race, data: { loadErrors: {}, formulaVersion: '2.7.x' } })

  await Promise.all(['treasury', 'wealth', 'shippingTax'].map((key) => vm.runAsync(key)))

  const [tax] = (await database.query(`select ShippingLineTax from FCT_Race where GameID = ${save.game} and RaceID = ${save.race}`))[0]
  const tag = path.basename(save.file)

  add(`save-tax: ${tag}: the page's read of the tax rate is the stored rate`, () => same(vm.shippingTax.rate, tax.ShippingLineTax === null ? null : Number(tax.ShippingLineTax)))
  add(`save-kind: ${tag}: the page's read of the race kind is the stored NPR, unknown for NULL`, async () => {
    const [row] = (await database.query(`select NPR from FCT_Race where GameID = ${save.game} and RaceID = ${save.race}`))[0]

    return same(vm.shippingTax.npr, row.NPR === null ? null : Number(row.NPR) !== 0)
  })
  add(`save-parity: ${tag}: the no-change scenario of every window is the page's ledger runway`, () => [30, 90, 180, 365].map((days) => {
    const ledger = m.finances.buildLedger({ treasury: vm.treasury, wealth: vm.wealth, windowDays: days })
    const built = m.sr.buildScenarios({ ledger, version: '2.7.x', npr: false, tax: vm.shippingTax, inputs: inputsOf() })

    return scenarioOf(built, 'none').exhaustion === ledger.runway && same(value(scenarioOf(built, 'none').exhaustion), value(ledger.runway)) === true ? true : `window ${days}`
  }).find((result) => result !== true) || true)
  add(`save-flows: ${tag}: the logged contracts of the ledger are the log's own sum scaled to a year`, async () => {
    const ledger = m.finances.buildLedger({ treasury: vm.treasury, wealth: vm.wealth, windowDays: 365 })
    const [rows] = await database.query(`select sum(Amount) as total from FCT_WealthData where GameID = ${save.game} and RaceID = ${save.race} and UseID = 44 and TimeUsed > ${vm.treasury.GameTime - 365 * DAY}`)
    const row = rows[0]
    const flows = m.sr.civilianFlows(ledger)
    const direct = (row.total || 0) * 365 / ledger.coverage.value

    return near(value(flows.contracts), direct, 1e-9) ? true : `${value(flows.contracts)} ≠ ${direct}`
  })
  add(`save-delay: ${tag}: with the stored tax rate the pause adds the contracts less the paired tax to the net`, () => {
    const ledger = m.finances.buildLedger({ treasury: vm.treasury, wealth: vm.wealth, windowDays: 365 })
    const built = m.sr.buildScenarios({ ledger, version: '2.7.x', npr: false, tax: vm.shippingTax, inputs: inputsOf() })
    const flows = m.sr.civilianFlows(ledger)
    const delay = scenarioOf(built, 'delay')
    const paired = value(built.pieces.pairedTax)

    return delay.net.value === null ? `no delay figure: ${delay.exhaustion.inputs.missing.join()}` : near(value(delay.net), value(ledger.net) + value(flows.contracts) - paired) && paired >= 0 && paired <= value(flows.taxes) + 1e-6 ? true : short([value(delay.net), value(ledger.net), paired])
  })

  return { statements, close: () => database.close() }
}

// ---------- the faults ----------

/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'the runway of a treasury of exactly 0 under a loss reads as lasting', file: L, find: 'balance > 0 ? { state: \'lasts\'', replace: 'balance >= 0 ? { state: \'lasts\'', fails: ['parity'] },
  { name: 'a net of exactly 0 reads as a loss', file: L, find: 'rate >= 0 ? { state: \'covered\'', replace: 'rate > 0 ? { state: \'covered\'', fails: ['parity'] },
  { name: 'the runway is the loss over the treasury', file: L, find: 'years: balance / -rate', replace: 'years: -rate / balance', fails: ['parity', 'exhaust'] },
  { name: 'an exhaustion in a later stretch is counted from that stretch', file: U, find: 'return { state: \'lasts\', years: elapsed + run.years }', replace: 'return { state: \'lasts\', years: run.years }', fails: ['exhaust', 'delay'] },
  { name: 'the balance is not carried from one stretch to the next', file: U, find: '    left += net * years\n    elapsed += years\n  }\n\n  return { state: \'covered\', years: null }', replace: '    elapsed += years\n  }\n\n  return { state: \'covered\', years: null }', fails: ['exhaust', 'delay'] },
  { name: 'a treasury emptied in the second stretch reports no time at all', file: U, find: 'return elapsed === 0 ? run : { state: \'lasts\', years: elapsed }', replace: 'return run', fails: ['exhaust'] },
  { name: 'the balance at a year is not counted from the start of its stretch', file: U, find: 'return left + net * (year - from)', replace: 'return left + net * year', fails: ['exhaust'] },
  { name: 'an exhaustion at the horizon reads as beyond it', file: U, find: 'value.years <= horizon ? \'exhausted\'', replace: 'value.years < horizon ? \'exhausted\'', fails: ['verdict'] },
  { name: 'a treasury that is never exhausted reads as exhausted', file: U, find: 'if (value.state === \'covered\') {\n    return { kind: \'none\', years: null }', replace: 'if (value.state === \'covered\') {\n    return { kind: \'exhausted\', years: null }', fails: ['verdict'] },
  { name: 'an empty treasury under a loss reads as lasting', file: U, find: 'return { kind: \'now\', years: 0 }', replace: 'return { kind: \'exhausted\', years: 0 }', fails: ['verdict'] },
  { name: 'an exhaustion is dated in seconds from today, not in years', file: U, find: 'gameTime + years * SECONDS_PER_YEAR', replace: 'gameTime + years', fails: ['time'] },
  { name: 'the year is 30 days', file: U, find: 'export const SECONDS_PER_YEAR = HISTORY_DAYS * SECONDS_PER_DAY', replace: 'export const SECONDS_PER_YEAR = 30 * SECONDS_PER_DAY', fails: ['time'] },
  { name: 'the no-change scenario is a copy of the runway, not the ledger\'s own', file: U, at: /exhaustion: ledger\.runway \}/, to: () => 'exhaustion: exhaustion([{ years: Infinity, net: ledger.net }]) }', fails: ['parity'] },
  { name: 'the selected window\'s ledger is built again instead of the page\'s', file: U, find: 'ledger: days === windowDays ? ledger : buildLedger({ treasury, wealth, windowDays: days })', replace: 'ledger: buildLedger({ treasury, wealth, windowDays: days })', fails: ['parity', 'component'] },
  { name: 'the paired tax is never taken off the contracts', file: U, find: '(values) => values.gross * values.windowTax)', replace: '(values) => 0)', fails: ['delay', 'gov'] },
  { name: 'the gross fare is the receipt over one plus the tax', file: U, find: 'values.contracts / (values.kind * (1 - values.windowTax))', replace: 'values.contracts / (values.kind * (1 + values.windowTax))', fails: ['delay'] },
  { name: 'a computer-run empire\'s receipt is not halved in the implied fare', file: U, find: 'values.contracts / (values.kind * (1 - values.windowTax))', replace: 'values.contracts / (1 - values.windowTax)', fails: ['delay'] },
  { name: 'a computer-run empire is paid like a player', file: U, find: 'value: npr ? NPR_PAYOUT_MODIFIER : 1', replace: 'value: 1', fails: ['delay', 'inputs'] },
  { name: 'the resumed fares are not halved for a computer-run empire', file: U, find: 'values.gross * values.kind * (1 - values.futureTax))', replace: 'values.gross * (1 - values.futureTax))', fails: ['delay'] },
  { name: 'the resumed tax is not earned', file: U, find: '(values) => values.gross * values.futureTax)', replace: '(values) => 0)', fails: ['delay', 'plan'] },
  { name: 'the pause saves the receipt but not the tax it loses', file: U, find: '(values) => values.net + values.contracts - values.pairedTax)', replace: '(values) => values.net + values.contracts)', fails: ['delay'] },
  { name: 'the pause does not save the contracts', file: U, find: '(values) => values.net + values.contracts - values.pairedTax)', replace: '(values) => values.net - values.pairedTax)', fails: ['delay'] },
  { name: 'the pause is 0 years whatever is entered', file: U, find: '[{ hold: pause, net: paused }', replace: '[{ years: 0, net: paused }', fails: ['delay'] },
  { name: 'the plan starts at once whatever start is entered', file: U, find: '[{ hold: start, net: resumed }', replace: '[{ years: 0, net: resumed }', fails: ['plan'] },
  { name: 'government transports are free', file: U, find: '(values) => values.net + values.contracts - values.pairedTax - values.running)', replace: '(values) => values.net + values.contracts - values.pairedTax)', fails: ['gov'] },
  { name: 'a blank number is 0', file: U, find: 'if (typeof text !== \'string\' || !text.trim()) {\n    return null\n  }', replace: 'if (typeof text !== \'string\' || !text.trim()) {\n    return 0\n  }', fails: ['blank', 'gov', 'plan'] },
  { name: 'a blank entered field is an assumption of 0', file: U, find: 'return value !== null && value >= 0 ? assumed(value, label) : blank(label)', replace: 'return assumed(value === null || value < 0 ? 0 : value, label)', fails: ['blank', 'gov'] },
  { name: 'a negative field is accepted', file: U, find: 'return value !== null && value >= 0 ? assumed(value, label) : blank(label)', replace: 'return value !== null ? assumed(value, label) : blank(label)', fails: ['blank', 'gov'] },
  { name: 'a future tax over 100 % is accepted', file: U, find: 'percent !== null && percent >= 0 && percent <= 100', replace: 'percent !== null && percent >= 0', fails: ['blank'] },
  { name: 'a blank future tax is the rate now', file: U, at: /blank\(FUTURE_TAX_MISSING\)/, to: () => 'combine({ rule: \'shippingRunway.assumption\', parts: { x: taxRate }, compute: (values) => values.x })', fails: ['blank'] },
  { name: 'every game version has the shipping rules', file: U, find: 'const gated = (version) => ruleSupports(\'shippingRunway.contractFlow\', version) !== true', replace: 'const gated = (version) => false', fails: ['inputs'] },
  { name: 'the shipping rules hold for any 2.x version', file: U, at: /const VERSIONS = \[[^\]]*\]/, to: () => 'const VERSIONS = [\'2.x\']', fails: ['actual', 'inputs'] },
  { name: 'a logged tax below the implied tax is accepted', file: U, at: /raw\.value \* taxBelowOne\.value > flows\.contractTax\.value \* \(1 \+ 1e-9\) \+ 1e-9/, to: () => 'false', fails: ['inputs'] },
  { name: 'the implied tax is held against every logged civilian tax, not the tax on installation deliveries', file: U, at: /flows\.contractTax\.value \* \(1 \+ 1e-9\)/, to: () => 'flows.taxes.value * (1 + 1e-9)', fails: ['inputs'] },
  { name: 'a tax rate of 100 % is divided by', file: U, find: 'windowTax.value >= 1', replace: 'windowTax.value > 1', fails: ['inputs'] },
  { name: 'a negative tax rate is a rate', file: U, find: 'finite(tax.rate) && tax.rate >= 0 ?', replace: 'finite(tax.rate) ?', fails: ['inputs'] },
  { name: 'an unknown race kind is a player\'s', file: U, find: 'typeof npr === \'boolean\' ? ofRule', replace: 'true ? ofRule', fails: ['inputs'] },
  { name: 'an absent saved tax rate is 0', file: U, at: /rate === null \|\| rate === undefined/, to: () => 'false', fails: ['load'] },
  { name: 'a race with no row has a tax rate of 0', file: U, at: /(if \(!rows\.length\) \{\s*return )\{[^}]*\}/, to: (m) => `${m[1]}{ rate: 0, missing: '' }`, fails: ['load'] },
  { name: 'a save without the column has a tax rate of 0', file: U, at: /(if \(!stored\.length\) \{\s*return )\{[^}]*\}/, to: (m) => `${m[1]}{ rate: 0, missing: '' }`, fails: ['load'] },
  { name: 'the columns are selected without looking at the schema', file: U, at: /const stored = RACE_COLUMNS\.filter\([^\n]*\)/, to: () => 'const stored = RACE_COLUMNS', fails: ['load'] },
  { name: 'the race kind is not read', file: U, at: /const RACE_COLUMNS = \[[^\]]*\]/, to: () => 'const RACE_COLUMNS = [\'ShippingLineTax\']', fails: ['load', 'page'] },
  { name: 'a race kind stored as NULL is a player\'s', file: U, at: /(const raceKindOf = [\s\S]*?)return null/, to: (m) => `${m[1]}return false`, fails: ['load', 'page'] },
  { name: 'the tax rate is read for any race', file: U, at: / and RaceID = \$\{Number\(RaceID\)\}/, to: () => '', fails: ['load'] },
  { name: 'installation cargo costs the line nothing', file: U, find: '(installation ? gross * values.kind * (1 - values.futureTax) : 0)', replace: '0', fails: ['plan'] },
  { name: 'trade goods are charged the line\'s receipt', file: U, find: 'const installation = line.category === \'cargoPoint\'', replace: 'const installation = true', fails: ['plan'] },
  { name: 'the tax of a planned contract is paid, not earned', file: U, find: 'return gross * values.futureTax - (', replace: 'return -gross * values.futureTax - (', fails: ['plan'] },
  { name: 'a planned contract is priced at a computer-run empire\'s halved fare', file: U, find: 'billionKm: typedNumber(line.distance), npr: false })', replace: 'billionKm: typedNumber(line.distance), npr: true })', fails: ['plan'] },
  { name: 'a blank line is a line with nothing in it', file: U, find: 'inputs.lines.filter((line) => !isBlankLine(line))', replace: 'inputs.lines', fails: ['plan'] },
  { name: 'no contract entered is a plan of nothing', file: U, at: /: unavailable\(\{ rule: 'shippingRunway\.planLine', missing: \[[^\]]*\] \}\)/, to: () => ': ofRule({ rule: \'shippingRunway.planLine\', value: 0, inputs: { present: [\'none\'] } })', fails: ['plan'] },
  { name: 'the break-even adds the tax', file: U, find: '(values) => values.contracts - values.pairedTax })', replace: '(values) => values.contracts + values.pairedTax })', fails: ['gov'] },
  { name: 'the civilian net adds the contracts', file: U, find: 'values.taxes - values.contracts - values.legacy', replace: 'values.taxes + values.contracts - values.legacy', fails: ['flows'] },
  { name: 'the contract use books like a legacy use', file: U, find: '44: \'contract\'', replace: '44: \'legacy\'', fails: ['flows', 'roles'] },
  { name: 'a use nothing books is a tax', file: U, find: '46: \'legacy\'', replace: '46: \'tax\'', fails: ['roles'] },
  { name: 'a use of the wrong side is flowed anyway', file: U, find: 'return category && category.income !== (use.side === \'income\')', replace: 'return false', fails: ['flows'] },
  { name: 'the obligations list the shipping uses too', file: U, find: '!(category.id in ROLES)', replace: 'true', fails: ['flows'] },
  { name: 'the obligations list the larger spending last', file: U, find: '(valueOrNull(b.yearly) ?? -1) - (valueOrNull(a.yearly) ?? -1)', replace: '(valueOrNull(a.yearly) ?? -1) - (valueOrNull(b.yearly) ?? -1)', fails: ['flows'] },
  { name: 'a use not logged is unknown', file: U, find: 'compute: () => (category ? category.perYear : 0)', replace: 'compute: () => category.perYear', fails: ['flows'] },
  { name: 'the earliest exhaustion is the latest', file: U, find: '.sort((a, b) => a.order - b.order)', replace: '.sort((a, b) => b.order - a.order)', fails: ['window'] },
  { name: 'a window with no figure counts as a figure', file: U, find: '.filter((row) => row.order !== null)', replace: '.map((row) => ({ ...row, order: row.order === null ? 0 : row.order }))', fails: ['window'] },
  { name: 'the scenarios\' results are called confirmed', file: U, find: 'id: \'shippingRunway.exhaustion\',\n  versions: VERSIONS,\n  units: \'years\',\n  verification: \'estimated\'', replace: 'id: \'shippingRunway.exhaustion\',\n  versions: VERSIONS,\n  units: \'years\',\n  verification: \'confirmed\'', fails: ['actual'] },
  { name: 'the entered fields are called confirmed', file: U, find: 'id: \'shippingRunway.assumption\',\n  versions: VERSIONS,\n  units: \'\',\n  verification: \'assumed\'', replace: 'id: \'shippingRunway.assumption\',\n  versions: VERSIONS,\n  units: \'\',\n  verification: \'confirmed\'', fails: ['actual'] },
  { name: 'the logged flows are called confirmed', file: U, find: 'id: \'shippingRunway.windowFlow\',\n  versions: VERSIONS,\n  units: \'wealth/yr\',\n  verification: \'estimated\'', replace: 'id: \'shippingRunway.windowFlow\',\n  versions: VERSIONS,\n  units: \'wealth/yr\',\n  verification: \'confirmed\'', fails: ['actual'] },
  { name: 'the government scenario states no assumption', file: U, at: /(scenario\('government', '[^']*', '[^']*', )\[[^\]]*\]/, to: (m) => `${m[1]}[]`, fails: ['actual'] },
  { name: 'a stretch of 0 years is run like any other', file: U, at: /if \(!\(years > 0\)\) \{\s*continue\s*\}/, to: () => '', fails: ['exhaust', 'delay'] },
  { name: 'the trajectory leaves out the balance of today', file: U, at: /for \(let year = 0; year <= horizon; year \+= step\) \{/, to: () => 'for (let year = step; year <= horizon; year += step) {', fails: ['time'] },
  { name: 'the trajectory leaves out the years a net changes at', file: U, at: /if \(from > 0 && from <= horizon\) \{\s*years\.add\(from\)\s*\}/, to: () => '', fails: ['time'] },
  { name: 'a stretch with no net is a stretch of the trajectory', file: U, at: / \|\| !scenario\.segments\.every\(\(segment\) => isAvailable\(segment\.net\)\)/, to: () => '', fails: ['time'] },
  { name: 'a scenario with no figure has a trajectory', file: U, at: /!scenario\.segments \|\| /, to: () => '', fails: ['time'] },
  { name: 'the timeline leaves out the past', file: U, at: /\.\.\.past, \.\.\.ahead/, to: () => '...ahead', fails: ['time', 'component'] },
  { name: 'the panel loses the summary', file: V, at: attribute('data-summary'), to: () => '', fails: ['component'] },
  { name: 'the summary of the panel follows its state', file: V, at: attribute('data-summary'), to: () => ':data-summary="horizon > 25 ? \'a\' : \'b\'"', fails: ['component'] },
  { name: 'the panel shows the tax read\'s state nowhere', file: V, tag: { name: 'div', has: { 'v-if': (value) => isText(value) && value.includes('taxState.loading') && value.includes('taxState.failed') } }, to: (text) => setAttribute(text, 'v-if', 'false'), fails: ['component'] },
  { name: 'the chart has no table beside it', file: V, tag: { name: 'v-btn', has: { value: 'table' }, span: 'element' }, to: () => '', fails: ['component'] },
  { name: 'the chart has no label', file: V, tag: { name: 'chart-canvas', has: { label: isText } }, to: (text) => dropAttribute(text, 'label'), fails: ['component'] },
  { name: 'the break-even figure loses its mark', file: V, tag: { name: 'provenance-mark', has: { ':result': 'model.breakEven' } }, to: () => '', fails: ['component'] },
  { name: 'the exhaustion cell loses its mark', file: V, tag: { name: 'provenance-mark', has: { ':result': 'row.exhaustion' } }, to: () => '', fails: ['component'] },
  { name: 'the actual flows lose their mark', file: V, tag: { name: 'provenance-mark', has: { ':result': 'model.flows.contracts' } }, to: () => '', fails: ['component'] },
  { name: 'the column of the log\'s balances loses its mark', file: V, tag: { name: 'th', has: { 'v-if': 'hasHistory' }, span: 'element' }, to: (text) => text.replace(/<provenance-mark\b[^>]*\/>/, ''), fails: ['component'] },
  { name: 'the scenarios are drawn in the same solid line as the log', file: V, at: /borderDash: entry\.dash, /, to: () => '', fails: ['component'] },
  { name: 'the estimated lines are not called estimated', file: V, at: new RegExp(`(this\\.legend\\.forEach\\(\\(entry\\) => \\{\\s*datasets\\.push\\(\\{\\s*label\\s*:\\s*)(?:${STRING})`), to: (m) => `${m[1]}entry.label`, fails: ['component'] },
  { name: 'the balances the log reconstructs are called an actual treasury', file: V, at: new RegExp(`(if \\(this\\.hasHistory\\) \\{\\s*datasets\\.push\\(\\{\\s*label\\s*:\\s*)(?:${STRING})`), to: (m) => `${m[1]}'Actual treasury'`, fails: ['component'] },
  { name: 'the table leaves out the log\'s balances', file: V, at: /(balanceRows\(\) \{\s*return this\.timeline\.rows)(\.map)/, to: (m) => `${m[1]}.filter((row) => row.history === null)${m[2]}`, fails: ['component'] },
  { name: 'the panel links nowhere for the observed rate', file: V, tag: { name: 'router-link', has: { to: '/history' }, span: 'element' }, to: (text) => text.replace(/^<router-link\b(?:"[^"]*"|'[^']*'|[^>"'])*>|<\/router-link>$/g, ''), fails: ['component'] },
  { name: 'the panel works out the observed rate itself', file: V, at: /historyRecorded: \{ type: Boolean, default: false \},/, to: (m) => `${m[0]}\n    stockRate: { type: Number, default: 0 },`, fails: ['component'] },
  { name: 'the panel speaks to the reader', file: V, tag: { name: 'v-text-field', has: { ':value': 'futureTaxShown' } }, to: (text) => setAttribute(text, 'hint', 'Untouched: your rate carries on'), fails: ['component'] },
  { name: 'the panel names a source of the game', file: V, tag: { name: 'div', has: { class: hasClass('panel-foot') } }, to: (text) => `${text}${'Ship' + '.cs'} `, fails: ['component'] },
  { name: 'the horizon is left out of the words for an exhaustion past it', file: V, at: /(case 'beyond':\s*return )`[^`]*`/, to: (m) => `${m[1]}'Lasts, to'`, fails: ['component'] },
  { name: 'the exhaustion is not dated', file: V, at: /(case 'exhausted':\s*return )`[^`]*`/, to: (m) => `${m[1]}'Exhausted'`, fails: ['component'] },
  { name: 'the page waits for the tax read', file: P, at: /const OPTIONAL_INPUTS = \[[^\]]*\]/, to: () => 'const OPTIONAL_INPUTS = []', fails: ['page'] },
  { name: 'the page is ready once every read is in, the tax read included', file: P, find: 'return allLoaded(this.loadErrors, CORE_INPUTS)', replace: 'return allLoaded(this.loadErrors, Object.keys(INPUT_LABELS))', fails: ['page'] },
  { name: 'a failed tax read holds the page back', file: P, find: 'return CORE_INPUTS.filter((key) => this.loadErrors[key])', replace: 'return Object.keys(INPUT_LABELS).filter((key) => this.loadErrors[key])', fails: ['page'] },
  { name: 'the tax read is untracked', file: P, find: 'shippingTax: {\n      get: tracked(\'shippingTax\', async function () {', replace: 'shippingTax: {\n      get: tracked(\'shippingRate\', async function () {', fails: ['page'] },
  { name: 'the tax read ignores the race selected', file: P, find: 'loadShippingTax(this.database, { GameID: this.GameID, RaceID: this.RaceID })', replace: 'loadShippingTax(this.database, { GameID: this.GameID, RaceID: 1 })', fails: ['page'] },
  { name: 'the tax read runs with no race selected', file: P, find: 'if (!this.database || !this.GameID || !this.RaceID) {\n          return null\n        }\n\n        return await loadShippingTax', replace: 'if (!this.database) {\n          return null\n        }\n\n        return await loadShippingTax', fails: ['page'] },
  { name: 'the panel is given a fixed race kind', file: P, tag: { name: 'shipping-runway', has: { ':npr': isText } }, to: (text) => setAttribute(text, ':npr', 'false'), fails: ['page'] },
  { name: 'the panel is given the race kind of the selection, which makes an unstored kind a player\'s', file: P, tag: { name: 'shipping-runway', has: { ':npr': isText } }, to: (text) => setAttribute(text, ':npr', '!!RaceNPR'), fails: ['page'] },
  { name: 'the panel is given no tax state', file: P, tag: { name: 'shipping-runway', has: { ':tax-state': isText } }, to: (text) => dropAttribute(text, ':tax-state'), fails: ['page'] },
  { name: 'the panel is mounted inside the gate of the cycles table', file: P, tag: { name: 'shipping-runway' }, to: (text) => `<template v-if="steps.length">${text}</template>`, fails: ['page'] },
  { name: 'the tax read has no label of its own for the failed state', file: P, at: /(shippingTax: )'[^']*'/, to: (m) => `${m[1]}''`, fails: ['page'] },
  { name: 'the panel\'s race kind is a player\'s until it is given', file: V, at: /(npr\s*:\s*\{[^}]*default\s*:\s*)null/, to: (m) => `${m[1]}false`, fails: ['component'] },
  { name: 'a stretch of 0 years is the net now', file: U, at: /\(hold \? hold\.value : years\) > 0 \|\| /, to: () => 'true || ', fails: ['delay', 'plan'] },
  { name: 'the shipping net and the change of a scenario are those of its first stretch, in force or not', file: U, at: /const shown = focus \? segments\[focus\]\.net : now/, to: () => 'const shown = segments[focus].net', fails: ['delay'] },
  { name: 'the stretch the shipping net and the change are read from is not said', file: U, at: /focus: focus \? 'later' : 'now'/, to: () => 'focus: \'now\'', fails: ['plan'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// The same planted faults on the source with every benign edit applied.
const COMPOSED = MUTATIONS.map((mutation, index) => ({ id: `composed:${index}`, ...mutation }))

// Edits that must change nothing the checks look at: wording, the order and spacing of attributes, the defaults of the entered fields and the default horizon. Each is located by its structure (the attribute, key or state it belongs to and its whole value, with any spacing around `=` and either quote), never by what it holds now, so it still applies after a rewording, another default or another edit of the list.
const BENIGN = [
  { name: 'the attributes of the table button reordered', file: V, tag: { name: 'v-btn', has: { value: 'table' } }, to: reverseTag },
  { name: 'the attributes of the break-even mark reordered', file: V, tag: { name: 'provenance-mark', has: { ':result': 'model.breakEven' } }, to: reverseTag },
  { name: 'the attributes of the link to the history reordered', file: V, tag: { name: 'router-link', has: { to: '/history' } }, to: reverseTag },
  { name: 'the attributes of the head of the log\'s balances reordered', file: V, tag: { name: 'th', has: { 'v-if': 'hasHistory' } }, to: reverseTag },
  { name: 'the attributes of the future tax field reordered', file: V, tag: { name: 'v-text-field', has: { ':value': 'futureTaxShown' } }, to: reverseTag },
  { name: 'the attributes of the chart reordered', file: V, tag: { name: 'chart-canvas', has: { label: isText } }, to: reverseTag },
  { name: 'the summary reworded', file: V, at: attribute('data-summary'), to: () => 'data-summary="The date the reserves run out under the civilian shipping scenarios, beside the no-change runway and the other budget obligations, with logged amounts apart from estimates."' },
  { name: 'the attributes of the card reordered', file: V, at: /(<v-card)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)+)(\s*>)/, to: (m) => `${m[1]} ${reversed(m[2])}${m[3]}` },
  { name: 'the label of the chart reworded', file: V, tag: { name: 'chart-canvas', has: { label: isText } }, to: (text) => setAttribute(text, 'label', 'Balance of the treasury, logged and under each scenario') },
  { name: 'the hint of the future tax field reworded', file: V, tag: { name: 'v-text-field', has: { ':value': 'futureTaxShown' } }, to: (text) => setAttribute(text, 'hint', 'Untouched: the rate set now carries on from here') },
  { name: 'the text of the first chip reworded', file: V, first: true, tag: { name: 'v-chip', span: 'element' }, to: (text) => text.replace(/>[^<]*<\/v-chip>$/, '>Logged</v-chip>') },
  { name: 'the words for a net that is not a loss reworded', file: V, at: /(case 'none':\s*return\s+)(?:'[^']*'|"[^"]*"|`[^`]*`)/, to: (m) => `${m[1]}'No exhaustion: the net is no loss'` },
  { name: 'another default pause', file: V, at: /(pauseYears\s*:\s*)'[^']*'/, to: (m) => `${m[1]}'4'` },
  { name: 'another default start of the plan', file: V, at: /(planStart\s*:\s*)'[^']*'/, to: (m) => `${m[1]}'1'` },
  { name: 'another default horizon', file: U, at: /(DEFAULT_HORIZON\s*=\s*)\d+/, to: (m) => `${m[1]}50` },
  { name: 'the label of the no-change scenario reworded', file: U, at: /(id\s*:\s*'none'\s*,\s*label\s*:\s*)'[^']*'/, to: (m) => `${m[1]}'Unchanged'` },
  { name: 'the label of the delay scenario reworded', file: U, at: /(scenario\(\s*'delay'\s*,\s*)'[^']*'/, to: (m) => `${m[1]}'Contracts held back'` },
  { name: 'the estimated suffix of the scenario lines reworded', file: V, at: new RegExp(`(this\\.legend\\.forEach\\(\\(entry\\) => \\{\\s*datasets\\.push\\(\\{\\s*label\\s*:\\s*)(?:${STRING})`), to: (m) => `${m[1]}\`\${entry.label}, projected\`` },
  { name: 'the foot of the panel reworded', file: V, tag: { name: 'div', has: { class: hasClass('panel-foot') }, span: 'element' }, to: (text) => text.replace(/>[^<]*<\/div>$/, '>Every figure of a scenario is an estimate from the logged window.</div>') },
  { name: 'the attributes of the mount reordered', file: P, tag: { name: 'shipping-runway' }, to: reverseTag },
  { name: 'whitespace around the equals sign of the tax on the mount', file: P, at: attribute(':tax'), to: (m) => `:tax  =  ${m[1]}` },
  { name: 'the label of the tax read reworded', file: P, at: /(shippingTax\s*:\s*)'[^']*'/, to: (m) => `${m[1]}'the tax rate of the shipping lines'` },
].map((edit, index) => ({ id: `benign:${index}`, ...edit }))

// The text to find and its replacement for a planted fault or a benign edit: the literal `find` and `replace`, or what the pattern `at` matches (exactly once, or the first match with `first`) and `to` makes of the match.
const resolved = (edit, text) => {
  if (edit.tag) {
    const found = tagsOf(text, edit.tag)

    if (edit.first ? found.length < 1 : found.length !== 1) {
      throw new Error(`The tag of ${edit.name} is found ${found.length} times, not once`)
    }

    return { find: found[0].text, replace: edit.to(found[0].text, found[0].attributes) }
  }

  if (!edit.at) {
    return edit
  }

  const all = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags}g`))]

  if (edit.first ? all.length < 1 : all.length !== 1) {
    throw new Error(`The pattern of ${edit.name} matches ${all.length} times, not once`)
  }

  return { find: all[0][0], replace: edit.to(all[0]) }
}

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

// The sources with one edit (a planted fault or a benign edit) applied.
const applied = (sources, edit) => {
  const change = resolved(edit, sources[edit.file])

  return { ...sources, [edit.file]: patched(path.basename(FILES[edit.file]), sources[edit.file], change.find, change.replace) }
}

// The sources one run reads: the real ones, or the real ones with one edit.
const sourcesOf = (edit) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  return edit ? applied(sources, edit) : sources
}

// The real sources with every benign edit applied in turn.
const stackedSources = () => BENIGN.reduce((sources, edit) => applied(sources, edit), sourcesOf(null))

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const sourcesFor = { ...(changed(U) ? { 'shipping-runway': sources[U] } : {}), ...(changed(L) ? { finances: sources[L] } : {}) }
  const utilitySources = { ...(changed(U) ? { 'utilities/shipping-runway': sources[U] } : {}), ...(changed(L) ? { 'utilities/finances': sources[L] } : {}) }
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: sourcesFor })
  const modules = { 'components/charts/theme': THEME_STUB }
  const componentOptions = await loadPage('components/finances/ShippingRunway', { stubs: STUBS, modules, sources: { 'components/finances/ShippingRunway': sources[V], ...utilitySources } })
  const pageOptions = await loadPage('pages/finances', { stubs: STUBS, modules, sources: { 'pages/finances': sources[P], 'components/finances/ShippingRunway': sources[V], ...utilitySources } })
  const pageReal = await loadPage('pages/finances', { stubs: STUBS, modules: { ...modules, 'mixins/load-state': null }, sources: { 'pages/finances': sources[P], 'components/finances/ShippingRunway': sources[V], ...utilitySources } })

  return { m: { sr: loaded['shipping-runway'], finances: loaded.finances, provenance: loaded.provenance, tariff: loaded['civilian-tariff'] }, componentOptions, pageOptions, pageReal, componentText: sources[V], pageText: sources[P] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
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

let useSaves = true

const statementsOf = async (ctx, withSaves) => {
  const statements = [...runs(ctx.m), ...componentChecks(ctx)]
  const opened = []
  const skipped = []

  if (withSaves && useSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)
        opened.push(read)
      }
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nShipping runway: the treasury runway under civilian shipping scenarios, on wealth logs worked by hand, the panel, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.some((key) => !key.startsWith('save-') && keys.has(key))).map((mutation) => mutation.name)

  check('mutations: every planted fault names a group of checks that needs no save, so a checkout without the saves still catches it', bare.length ? short(bare) : true)

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }

  await Promise.all(opened.map((read) => read.close()))
}

const checkMutant = async (mutant, composed = false) => {
  const began = Date.now()
  const label = `${composed ? 'mutation caught on the stacked benign edits' : 'mutation caught'}: ${mutant.name}`
  let sources

  try {
    sources = composed ? applied(stackedSources(), mutant) : sourcesOf(mutant)
  } catch (error) {
    check(label, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(label, `does not load: ${error.message}`)

    return
  }

  // The checks of the saves are witnesses: each must fail when its save is there, and none is needed when it is not. Every planted fault names a group that needs no save, and that group must fail whatever saves are present.
  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const witnesses = mutant.fails.filter((key) => key.startsWith('save-'))
  const { statements, opened } = await statementsOf(ctx, !composed && witnesses.length > 0)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const named = [...required, ...witnesses.filter(present)]
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, named)
  const missed = named.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  await Promise.all(opened.map((read) => read.close()))
  check(label, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// An edit that changes no behaviour (wording, whitespace, the order of attributes, a default) leaves every check that needs no save green: the checks look at what the sources do, not at how they are written.
const checkBenign = async (edit) => {
  const began = Date.now()
  let results

  try {
    const ctx = await contextOf(sourcesOf(edit))
    const { statements } = await statementsOf(ctx, false)

    results = await runStatements(statements)
  } catch (error) {
    check(`benign edit kept: ${edit.name}`, `does not load: ${error.message}`)

    return
  }

  const failed = results.filter(([, result]) => result !== true)

  check(`benign edit kept: ${edit.name}`, failed.length ? short(failed.map(([name, result]) => [name, result])) : true, `${results.length} checks stay green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// The benign edits are independent of one another: each is located by structure, so it still applies to a source another has already changed, and the source with every one of them applied (in order) is still green.
const checkStacked = async () => {
  const began = Date.now()
  const base = sourcesOf(null)
  const conflicts = []

  for (const first of BENIGN) {
    let after

    try {
      after = applied(base, first)
    } catch (error) {
      conflicts.push(`${first.name}: ${error.message}`)

      continue
    }

    for (const second of BENIGN) {
      try {
        applied(after, second)
      } catch (error) {
        conflicts.push(`${second.name} after ${first.name}: ${error.message}`)
      }
    }
  }

  check('benign edits: each still applies to a source another has changed', conflicts.length ? short(conflicts) : true, `${BENIGN.length * BENIGN.length} pairs`)

  let results

  try {
    const ctx = await contextOf(BENIGN.reduce((sources, edit) => applied(sources, edit), base))
    const { statements } = await statementsOf(ctx, false)

    results = await runStatements(statements)
  } catch (error) {
    check('benign edits: all of them together keep every check green', `does not load: ${error.message}`)

    return
  }

  const failed = results.filter(([, result]) => result !== true)

  check('benign edits: all of them together keep every check green', failed.length ? short(failed.map(([name, result]) => [name, result])) : true, `${results.length} checks stay green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      options.saves = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  useSaves = options.saves

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)
    const edit = BENIGN.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else if (COMPOSED.some(({ id }) => id === options.part)) {
      await checkMutant(COMPOSED.find(({ id }) => id === options.part), true)
    } else if (edit) {
      await checkBenign(edit)
    } else if (options.part === 'stacked') {
      await checkStacked()
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const benign = options.mutations ? BENIGN : []
  const stacked = options.mutations ? ['stacked'] : []
  const composed = options.mutations ? COMPOSED : []
  const extra = options.saves ? [] : ['--no-saves']
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...[...wanted, ...benign].map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 })), ...stacked.map((id) => ({ args: ['--part', id, ...extra], weight: 5 })), ...composed.map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 }))])
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

  if (benign.length) {
    console.log('\nBenign edits: each must leave every save-free check green')
    benign.forEach(printed)
  }

  if (stacked.length) {
    console.log('\nBenign edits stacked: each still applies after any other, and all of them together leave every save-free check green')
    stacked.forEach(printed)
  }

  if (composed.length) {
    console.log('\nPlanted faults on the source with every benign edit applied: each must still apply once and fail the checks it names')
    composed.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
