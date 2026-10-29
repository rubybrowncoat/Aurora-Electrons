/*
  Checks the retained-population floor for colonist exports on the Colony Outlook: how many people a colony can give up before it cannot staff its installations or falls below a floor the player sets (src/renderer/utilities/colonist-floor.js, src/renderer/components/colonies/ColonistFloor.vue and its mount in src/renderer/pages/colony-outlook.vue).

  bun scripts/check-colonist-floor.js [--no-mutations] [--no-saves]

  The utility is run on colonies worked by hand, whose workers follow the Outlook's own worker split (a colony of 62.5 M people at colony cost 0 has 28.125 M workers: services take half of the people and agriculture 5%). What a batch leaves: the remaining population and its workers, the workers short (never negative, never a figure when the batch is blank, not a number or larger than the colony). What limits a removal: the staffing floor, found by removing people gradually, and a floor the player enters; the smaller binds, and either can bind first. The current view needs no queue: it is the same with the committed workforce absent, unavailable or present, and the committed view changes only its own figures. The emigrant pool limits only shipping-line pickups from a source colony; a pickup yet to happen is never a figure. A blank floor or batch is not known, a stored field that is null is unknown, and an invalid entry is refused. The loader runs on a small in-memory database, with a column or a table the save lacks. The panel is mounted on the same rows and its template compiled and rendered: each figure cell and each table of the detail row carries a mark bound to its own result, and the fields it keeps are those the persisted view is given. The page's tracked reads are found by running them, not by reading its text.

  The saves (saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, and AuroraDB.db, game 140, race 784, read-only; a save that is not there is skipped) give the real loader, compared with raw counts and values of the population table.

  The colonist sources read feeds only the panel, so a failed read holds nothing back: the page, loaded with its real load-state mixin, stays ready, and the panel (its template compiled and rendered) shows the failure or the progress in place of its figures, and its figures once the read is in.

  Each planted fault in the utility, the panel or the page must fail a check that needs no save and that it names. Each benign edit (wording, whitespace, the order of attributes, another default sort) must leave every check that needs no save green. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'colonist-floor.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'colonies', 'ColonistFloor.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'colony-outlook.vue'),
}
const U = 'utility'
const V = 'component'
const P = 'page'
const NAMES = ['colonist-floor', 'colonies', 'workforce-demand', 'provenance']
const SAVES = [
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
  { file: 'AuroraDB.db', game: 140, race: 784 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "", primary: "" }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'
// The persisted view stood in by a module that records the fields a component declares, the table's among them, for a check of how the panel keeps its view.
const RECORDER = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults, table: true }); export default (fields) => { globalThis.__persistedFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }
const PAGE_STORE = { getters: { 'capabilities/blockedBonuses': new Set() }, state: { RaceNPR: false }, dispatch: async () => {} }

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
const DROPPED = new Set(['rule', 'assumptions'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const compiled = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' })
}

const templateErrors = (source) => compiled(source).errors.map(String)

// The root element of a compiled template, and every element in document order (the branches of a v-if chain included).
const templateAst = (source) => compiled(source).ast
const elementsOf = (ast) => {
  const found = []
  const visit = (node) => {
    if (node.type === 1) {
      found.push(node)
      node.children.forEach(visit)
      ;(node.ifConditions || []).slice(1).forEach((branch) => visit(branch.block))
      Object.values(node.scopedSlots || {}).forEach(visit)
    }
  }

  visit(ast)

  return found
}

// The classes an element declares, the text a template writes out itself (the static text nodes, not what an interpolation fills in) and an expression of the template evaluated against an instance.
const classesOf = (element) => (element.staticClass ? JSON.parse(element.staticClass).split(' ').filter(Boolean) : [])
const staticTextOf = (ast) => {
  const texts = []
  const visit = (node) => {
    if (node.type === 3) {
      texts.push(node.text)
    } else if (node.type === 1) {
      node.children.forEach(visit)
      ;(node.ifConditions || []).slice(1).forEach((branch) => visit(branch.block))
      Object.values(node.scopedSlots || {}).forEach(visit)
    }
  }

  visit(ast)

  return texts
}
const evaluate = (expression, instance) => require('vm').runInNewContext(`with (scope) { (${expression}) }`, { scope: instance })

// What an element binds: the props by name (`:name` or `v-bind:name`) and the handlers by event (`@event` or `v-on:event`), as the expressions written.
const bindingsOf = (element) => {
  const props = {}
  const events = {}

  Object.entries(element.attrsMap).forEach(([name, expression]) => {
    const bound = name.match(/^(?::|v-bind:)([\w-]+)$/)
    const handled = name.match(/^(?:@|v-on:)([\w-]+)$/)

    if (bound) {
      props[bound[1]] = expression
    } else if (handled) {
      events[handled[1]] = expression
    }
  })

  return { props, events }
}

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i
const GAME = 1
const RACE = 5

// The colonies worked by hand. Colony cost 0: agriculture takes 5% of the people; services take (population / 1000 M)^0.25, which is half of 62.5 M people. 62.5 M people have 28.125 M workers.
const world = (m) => {
  const { cf, col, provenance } = m
  const colony = (over = {}) => ({ PopulationID: 1, PopName: 'Alpha', Population: 62.5, InstallationWorkers: 20, YardWorkers: 0, ReqInf: 0, PopulationDensityModifier: 1, LowGravity: 0, Infrastructure: 0, LGInfrastructure: 0, ...over })
  // A colony of colony cost `cost`: ReqInf = cost x population x 100 / density.
  const costed = (cost, over = {}) => { const base = colony(over); return { ...base, ReqInf: (cost * base.Population * 100) / base.PopulationDensityModifier } }
  const results = (c) => { const cost = col.colonyCostResult(c); return { cost, workers: col.workerSplitResult(c, cost) } }
  const split = (population, required, cost = 0) => col.workerSplit({}, population, cost, required)
  const source = (over = {}) => ({ PopulationID: 1, ColonistDestination: 1, PoliticalStatus: 1, MilitaryRestrictedColony: 0, AvailableColonists: 4, ColonizationPressure: 2, ...over })
  const sources = (...rows) => ({ rows, problems: [], read: true })
  const queue = (supported, possible) => provenance.ofRule({ rule: 'colonies.committedWorkers', value: { required: { low: [20, supported], high: [20, possible] } }, inputs: { present: ['the queue'] }, units: 'M workers' })
  const assess = (c, over = {}) => { const { cost, workers } = results(c); return cf.assessColony({ populationId: c.PopulationID, workers, cost, sources: sources(source()), floor: '', batch: '', ...over }) }
  const plain = (result) => (result ? { value: result.value, status: result.status, missing: result.inputs.missing } : null)
  const value = (result) => provenance.valueOrNull(result)
  // The Outlook's row as the panel reads it: the colony's fields, the worker split and colony cost results, the infrastructure rate and the cap counting `arriving` (the deliveries on their way).
  const row = (c, over = {}, arriving = null) => {
    const { cost, workers } = results(c)
    const rate = col.infrastructureRateResult(c)
    const cap = col.infrastructureCapResult(col.infrastructureOf(c, arriving), rate)

    return { PopulationID: c.PopulationID, name: c.PopName, place: 'Sol', Population: c.Population, Infrastructure: c.Infrastructure, LGInfrastructure: c.LGInfrastructure, infrastructureCap: provenance.valueOrNull(cap), committedResult: null, r: { workersNow: workers, cost, rate, cap }, ...over }
  }

  return { colony, costed, results, split, source, sources, queue, assess, plain, value, row, A: colony() }
}

// ---------- the utility, on the colonies worked by hand ----------

const pure = (ctx) => {
  const w = world(ctx.m)
  const { cf } = ctx.m
  const { colony, costed, split, source, sources, queue, assess, plain, value, A } = w
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const minimumOf = (c, over) => value(assess(c, over).staffing).minimum
  const edge = minimumOf(A)

  // ----- what a batch leaves -----
  add('outcome: a batch leaves the remaining population, its workers and a quantified shortage', () => {
    const out = value(assess(A, { batch: '30' }).outcome)
    const left = split(32.5, 20)

    return out && near(out.remaining, 32.5) && near(out.workers, left.available) && near(out.required, 20) && near(out.shortage, 20 - left.available) && out.shortage > 1 && out.short === true && near(out.service, left.service) && near(out.agriculture, left.agriculture) ? true : short(out)
  })
  add('outcome: a batch that leaves workers spare has no shortage, never a negative one, and shows the spare', () => {
    const out = value(assess(A, { batch: '10' }).outcome)
    const left = split(52.5, 20)

    return out && out.shortage === 0 && out.short === false && near(out.spare, left.available - 20) && out.spare > 0 && same(out.breaks, []) === true ? true : short(out)
  })
  add('outcome: a batch of exactly 0 is a real batch that changes nothing, and differs from a blank one', () => {
    const none = value(assess(A, { batch: '0' }).outcome)
    const blank = assess(A, { batch: '' }).outcome

    return none && near(none.remaining, 62.5) && none.shortage === 0 && blank.status === 'unavailable' && blank.value === null ? true : short([none, plain(blank)])
  })
  add('outcome: the batch that takes the staffing floor leaves the workers needed, no shortage', () => {
    const out = value(assess(A, { batch: String(62.5 - edge) }).outcome)

    return out && out.shortage < 1e-6 && out.short === false ? true : short(out)
  })
  add('outcome: the shortage of the batch grows with the batch', () => {
    const shortages = ['25', '35', '45', '55'].map((batch) => value(assess(A, { batch }).outcome).shortage)

    return shortages.every((figure, at) => at === 0 || figure > shortages[at - 1]) && shortages[0] > 0 ? true : short(shortages)
  })

  // ----- the floor and the staffing floor -----
  add('staffing: the lowest population that keeps the workers needed is found to the last drop: it is staffed and a thousandth of a million people fewer is not', () => {
    const [needed, population] = [20, 62.5]

    return near(split(edge, needed).free, 0, 1e-6) && split(edge, needed).free >= -1e-9 && split(edge - 1e-3, needed).free < 0 && edge > 0 && edge < population ? true : short([edge, split(edge, needed).free, split(edge - 1e-3, needed).free])
  })
  add('staffing: every population between the staffing floor and today keeps the colony staffed, so no removal passes through a shortage', () => {
    const lows = Array.from({ length: 400 }, (_, at) => edge + ((62.5 - edge) * at) / 399)

    return lows.every((population) => split(population, 20).free >= -1e-9) ? true : 'a population above the floor is short'
  })
  add('staffing: the figures of today are the Outlook\'s own: population, the workers needed and the free workers', () => {
    const s = value(assess(A).staffing)
    const today = split(62.5, 20)

    return s && near(s.population, 62.5) && near(s.required, 20) && near(s.free, today.free) && near(s.workers, today.available) && s.short === false ? true : short(s)
  })
  add('staffing: a colony with no installations needs no workers and can give all its people', () => {
    const c = colony({ InstallationWorkers: 0 })
    const a = assess(c, { batch: '62.5' })

    return value(a.staffing).minimum === 0 && near(value(a.removable).limit, 62.5) && value(a.removable).binding === 'none' && value(a.outcome).shortage === 0 ? true : short([a.staffing.value, a.removable.value])
  })
  add('staffing: where removing people can raise the workers (high colony cost) the minimum is still found, and the removal stays staffed all the way down', () => {
    const c = costed(5, { Population: 100, InstallationWorkers: 10 })
    const needed = 10
    const cost = 5
    const minimum = minimumOf(c)

    return split(150, needed, cost).available < split(100, needed, cost).available && split(minimum, needed, cost).free >= -1e-9 && split(minimum - 1e-3, needed, cost).free < 0 && minimum > 30 && minimum < 60 && Array.from({ length: 200 }, (_, at) => minimum + ((100 - minimum) * at) / 199).every((population) => split(population, needed, cost).free >= -1e-9) ? true : short(minimum)
  })
  add('search: a colony short today can give nothing, even where removing people would raise its workers, and the batch is still worked out', () => {
    const c = costed(5, { Population: 200, InstallationWorkers: 10 })
    const a = assess(c, { batch: '100' })
    const s = value(a.staffing)

    return split(100, 10, 5).available > split(200, 10, 5).available && s.short === true && s.minimum === null && value(a.removable).limit === 0 && value(a.removable).alreadyShort === true && value(a.outcome).shortage === 0 ? true : short([s, a.removable.value])
  })
  add('search: a colony with no people has nothing to give and nothing binds', () => {
    const a = assess(colony({ Population: 0, InstallationWorkers: 0 }), { batch: '0' })

    return value(a.removable) && value(a.removable).limit === 0 && value(a.removable).binding === 'none' && value(a.outcome).remaining === 0 ? true : short([a.removable.value, a.outcome.value])
  })
  add('search: a shortage interval narrower than any grid step, at the services cap, is not stepped over: every population above the staffing floor of the colony is staffed, and a batch of 259.9 passes the limit', () => {
    const needed = 12.011
    const c = costed(4, { Population: 500, InstallationWorkers: needed })
    const a = assess(c, { batch: '259.9' })
    const staffed = (population) => split(population, needed, 4).free >= -1e-9
    const minimum = value(a.staffing).minimum
    const limit = value(a.removable).limit
    const populations = Array.from({ length: 50001 }, (_, at) => minimum + ((500 - minimum) * at) / 50000)

    return !staffed(500 - 259.9) && value(a.outcome).short === true && limit < 259.9 && near(minimum, needed / 0.05, 1e-3) && populations.every(staffed) && !staffed(minimum - 1e-3) ? true : short([minimum, limit, populations.filter((population) => !staffed(population)).slice(0, 3)])
  })
  add('search: against a dense scan of the worker curve, the staffing floor of colonies of every cost, size and need is the first shortage found going down, and every population above it is staffed', () => {
    const steps = 20000
    const faults = []

    for (const cost of [0, 1, 2, 4, 5]) {
      for (const population of [30, 100, 240.1, 241, 500, 2000]) {
        for (const share of [0.02, 0.1, 0.3, 0.5, 0.8, 0.97]) {
          const required = split(population, 0, cost).available * share
          const minimum = cf.staffingMinimum({ population, cost, required })
          let firstShort = null

          for (let step = 1; step <= steps && firstShort === null; step += 1) {
            const level = population * (1 - step / steps)

            firstShort = split(level, required, cost).free < -1e-9 ? level : null
          }

          const above = Array.from({ length: 2001 }, (_, at) => minimum + ((population - minimum) * at) / 2000)
          const found = firstShort === null || (minimum >= firstShort - 1e-9 && minimum <= firstShort + population / steps + 1e-9)

          if (minimum === null || !found || !above.every((level) => split(level, required, cost).free >= -1e-9)) {
            faults.push([cost, population, share, minimum, firstShort])
          }
        }
      }
    }

    return faults.length === 0 ? true : short(faults.slice(0, 4))
  })
  add('floor: a floor the colony is above can bind before staffing', () => {
    const r = value(assess(A, { floor: '50' }).removable)

    return r && r.binding === 'floor' && near(r.limit, 12.5) && near(r.floorLimit, 12.5) && r.staffingLimit > r.floorLimit ? true : short(r)
  })
  add('floor: a floor that binds before staffing, with a batch inside the floor, leaves the workers fine and breaks only the floor', () => {
    const out = value(assess(A, { floor: '55', batch: '10' }).outcome)

    return out && same(out.breaks, ['floor']) === true && out.shortage === 0 && near(out.floorShortfall, 2.5) && near(out.remaining, 52.5) ? true : short(out)
  })
  add('staffing: a floor below the staffing floor leaves staffing to bind', () => {
    const r = value(assess(A, { floor: '10' }).removable)

    return r && r.binding === 'staffing' && near(r.limit, 62.5 - edge) && r.floorLimit > r.staffingLimit ? true : short(r)
  })
  add('floor: a floor at the staffing floor binds both', () => {
    const r = value(assess(A, { floor: String(edge) }).removable)

    return r && r.binding === 'both' && near(r.limit, 62.5 - edge) ? true : short(r)
  })
  add('floor: a floor above the population leaves nothing to give and never a negative figure', () => {
    const r = value(assess(A, { floor: '80' }).removable)

    return r && r.limit === 0 && r.floorLimit === 0 && r.binding === 'floor' ? true : short(r)
  })
  add('floor: a floor of 0 is a real floor that binds nothing, and differs from a blank one by what it says', () => {
    const zero = value(assess(A, { floor: '0' }).removable)
    const blank = value(assess(A, { floor: '' }).removable)

    return zero && blank && near(zero.floorLimit, 62.5) && blank.floorLimit === null && near(zero.limit, blank.limit) && zero.binding === 'staffing' && blank.binding === 'staffing' ? true : short([zero, blank])
  })
  add('floor: a batch past the limit breaks what it passes: both when it leaves the colony below the floor and short', () => {
    const out = value(assess(A, { floor: '50', batch: '30' }).outcome)

    return out && same(out.breaks, ['floor', 'staffing']) === true && near(out.floorShortfall, 17.5) ? true : short(out)
  })

  // ----- the current view and the queue -----
  add('current: with no queue given the committed view is absent, and every current figure is there', () => {
    const a = assess(A, { batch: '10', floor: '5' })

    return a.committed === null && ['staffing', 'removable', 'outcome', 'source', 'pool', 'civilian'].every((key) => a[key].status !== 'unavailable') ? true : short(Object.keys(a).map((key) => [key, a[key] && a[key].status]))
  })
  add('current: the same figures with the queue absent, unavailable or present: the committed view never changes the current one', () => {
    const base = assess(A, { batch: '10', floor: '5' })
    const unavailable = ctx.m.provenance.unavailable({ rule: 'colonies.committedWorkers', missing: ['the queue forecast'] })
    const withQueue = assess(A, { batch: '10', floor: '5', committed: queue(30, 36) })
    const withGap = assess(A, { batch: '10', floor: '5', committed: unavailable })
    const keys = ['staffing', 'removable', 'outcome', 'source', 'pool', 'civilian', 'future']

    return keys.every((key) => same(plain(withQueue[key]), plain(base[key])) === true && same(plain(withGap[key]), plain(base[key])) === true) ? true : keys.filter((key) => same(plain(withQueue[key]), plain(base[key])) !== true || same(plain(withGap[key]), plain(base[key])) !== true).join()
  })
  add('committed: the queue\'s demand moves only its own figures: the supported demand needs more people, every completion more still, and the limit shrinks with it', () => {
    const c = value(assess(A, { batch: '10', committed: queue(25, 27) }).committed)
    const today = value(assess(A).removable)

    return c && near(c.supported.required, 25) && near(c.possible.required, 27) && c.supported.minimum > edge && c.possible.minimum > c.supported.minimum && c.supported.limit < today.limit && c.possible.limit < c.supported.limit && c.supported.limit >= 0 ? true : short(c)
  })
  add('committed: the batch\'s shortage at each demand is the demand less the workers that remain', () => {
    const c = value(assess(A, { batch: '10', committed: queue(25, 27) }).committed)
    const left = split(52.5, 25)

    return c.supported.outcome && c.possible.outcome && near(c.supported.outcome.shortage, Math.max(0, 25 - left.available)) && near(c.possible.outcome.shortage, Math.max(0, 27 - left.available)) && c.possible.outcome.shortage > c.supported.outcome.shortage && c.possible.outcome.shortage > 1 ? true : short(c)
  })
  add('committed: with no batch the committed limits are still given and the outcome of each is absent', () => {
    const c = value(assess(A, { committed: queue(25, 30) }).committed)

    return c && c.supported.outcome === null && c.possible.outcome === null && c.supported.limit > 0 ? true : short(c)
  })
  add('committed: a floor binds the committed view as it does the current one', () => {
    const c = value(assess(A, { floor: '60', committed: queue(25, 27) }).committed)

    return c && c.supported.binding === 'floor' && near(c.supported.limit, 2.5) && c.possible.binding === 'floor' ? true : short(c)
  })
  add('committed: a demand every completion would raise beyond what today\'s people can staff leaves that side short today with no room to give, the supported side untouched', () => {
    const c = value(assess(A, { batch: '10', committed: queue(25, 30) }).committed)

    return c && c.possible.minimum === null && c.possible.alreadyShort === true && c.possible.limit === 0 && c.possible.outcome.shortage > 1 && c.supported.minimum > 0 && c.supported.limit > 0 ? true : short(c)
  })
  add('committed: an unavailable queue leaves the committed view unavailable naming what the queue lacks, and the current view alone', () => {
    const gap = ctx.m.provenance.unavailable({ rule: 'colonies.committedWorkers', missing: ['the queue forecast'] })
    const a = assess(A, { batch: '10', committed: gap })

    return a.committed.status === 'unavailable' && a.committed.value === null && a.committed.inputs.missing.includes('the queue forecast') && a.removable.status !== 'unavailable' ? true : short(plain(a.committed))
  })

  // ----- unknown stays unknown -----
  add('blank: a blank floor is no floor, not 0: it adds no limit and says so', () => {
    const results = ['', '   ', undefined, null].map((floor) => assess(A, { floor }).removable)

    return results.every((result) => result.status !== 'unavailable' && result.value.floorLimit === null && result.assumptions.length > 0 && same(result.assumptions, results[0].assumptions) === true) && same(results[0].assumptions, assess(A, { floor: '5' }).removable.assumptions) !== true ? true : short(results.map(plain))
  })
  add('blank: a floor that is not a number of at least 0 is refused: the limit is unavailable naming the floor, never a figure', () => {
    const results = ['abc', '-1', '1e999', 'NaN'].map((floor) => assess(A, { floor }).removable)

    return results.every((result) => result.status === 'unavailable' && result.value === null && result.inputs.missing.length >= 1 && result.inputs.missing.every((name) => typeof name === 'string' && name !== '')) && same(results[0].inputs.missing, assess(A, { batch: '' }).outcome.inputs.missing) !== true ? true : short(results.map(plain))
  })
  add('blank: a blank or invalid batch has no outcome, and a batch larger than the colony has none either', () => {
    const results = ['', 'x', '-5', '62.6', '1000'].map((batch) => assess(A, { batch }).outcome)

    return results.every((result) => result.status === 'unavailable' && result.value === null && result.inputs.missing.length === 1) ? true : short(results.map(plain))
  })
  add('blank: a batch the size of the colony is allowed', () => {
    const out = assess(A, { batch: '62.5' }).outcome

    return out.status !== 'unavailable' && near(out.value.remaining, 0) && out.value.shortage > 0 ? true : short(plain(out))
  })
  add('blank: a batch typed as a number is read the same as typed text', () => {
    return same(plain(assess(A, { batch: 10, floor: 5 }).outcome), plain(assess(A, { batch: '10', floor: '5' }).outcome)) === true && same(plain(assess(A, { floor: 5 }).removable), plain(assess(A, { floor: '5' }).removable)) === true ? true : 'a number and its text differ'
  })
  add('null: a stored field that is null is unknown: the pool, the role and the pickup are unavailable naming it, never 0 or a refusal', () => {
    const pool = assess(A, { batch: '10', sources: sources(source({ AvailableColonists: null })) })
    const role = assess(A, { batch: '10', sources: sources(source({ ColonistDestination: null })) })
    const status = assess(A, { batch: '10', sources: sources(source({ PoliticalStatus: null })) })
    const restricted = assess(A, { batch: '10', sources: sources(source({ MilitaryRestrictedColony: null })) })

    return pool.pool.status === 'unavailable' && pool.pool.value === null && pool.civilian.status === 'unavailable' && pool.source.status !== 'unavailable' && role.source.status === 'unavailable' && role.civilian.status === 'unavailable' && status.source.status === 'unavailable' && restricted.source.status === 'unavailable' && [role, status, restricted].every((a) => a.source.inputs.missing.length === 1) ? true : short([pool.pool, role.source, status.source, restricted.source].map(plain))
  })
  add('null: a field that is null does not hide a refusal another field already gives', () => {
    const a = assess(A, { batch: '10', sources: sources(source({ ColonistDestination: 2, PoliticalStatus: null })) })

    return a.source.status !== 'unavailable' && a.source.value.eligible === false && a.civilian.status !== 'unavailable' && a.civilian.value.takes === 0 ? true : short(plain(a.source))
  })
  add('null: a colony the read has no row for has no role and no pool, and says which read is missing', () => {
    const none = assess(A, { sources: sources() })
    const unread = assess(A, { sources: { rows: [], problems: ['x'], read: false } })

    return none.source.status === 'unavailable' && none.pool.status === 'unavailable' && none.civilian.status === 'unavailable' && unread.source.inputs.missing.join() !== none.source.inputs.missing.join() && none.removable.status !== 'unavailable' ? true : short([plain(none.source), plain(unread.source)])
  })
  add('null: the current figures do not wait for the colonist source read', () => {
    const a = cf.assessColony({ populationId: 1, workers: w.results(A).workers, cost: w.results(A).cost, floor: '5', batch: '10' })

    return a.staffing.status !== 'unavailable' && a.removable.status !== 'unavailable' && a.outcome.status !== 'unavailable' && a.pool.status === 'unavailable' ? true : short(Object.keys(a).map((key) => [key, a[key] && a[key].status]))
  })
  add('null: a colony whose worker split is unavailable has no staffing, limit or outcome, naming what is missing', () => {
    const c = colony({ InstallationWorkers: null })
    const a = assess(c, { batch: '10', floor: '5' })

    return ['staffing', 'removable', 'outcome'].every((key) => a[key].status === 'unavailable' && a[key].value === null && a[key].inputs.missing.length > 0) && a.source.status !== 'unavailable' ? true : short(['staffing', 'removable', 'outcome'].map((key) => plain(a[key])))
  })

  // ----- the pool and shipping lines -----
  add('source: shipping lines may load only from a source colony that is an imperial population and not restricted to the military', () => {
    const cases = []

    for (const role of [0, 1, 2]) {
      for (const status of [1, 2]) {
        for (const restricted of [0, 1]) {
          const result = assess(A, { sources: sources(source({ ColonistDestination: role, PoliticalStatus: status, MilitaryRestrictedColony: restricted })) }).source

          cases.push([role, status, restricted, result.value && result.value.eligible])
        }
      }
    }

    const wrong = cases.filter(([role, status, restricted, eligible]) => eligible !== (role === 1 && status === 1 && restricted === 0))

    return cases.length === 12 && !wrong.length ? true : short(wrong)
  })
  add('source: the role is read from the stored marker: 0 a destination, 1 a source, 2 stable, and an unknown marker is unknown', () => {
    const roles = [0, 1, 2, 7].map((marker) => assess(A, { sources: sources(source({ ColonistDestination: marker })) }).source)

    return same(roles.slice(0, 3).map((result) => result.value.role), ['destination', 'source', 'stable']) === true && roles[3].status === 'unavailable' ? true : short(roles.map(plain))
  })
  add('source: the reasons a colony is refused are named, one for each', () => {
    const refused = assess(A, { sources: sources(source({ ColonistDestination: 0, PoliticalStatus: 3, MilitaryRestrictedColony: 1 })) }).source

    return refused.value.eligible === false && refused.value.reasons.length === 3 && new Set(refused.value.reasons).size === 3 ? true : short(refused.value)
  })
  add('pool: shipping lines take the batch up to the emigrants the pool holds, and the rest is left for a fleet of the race', () => {
    const take = (batch, stored) => value(assess(A, { batch, sources: sources(source({ AvailableColonists: stored })) }).civilian)

    return same(take('10', 4), { takes: 4, left: 6, eligible: true }) === true && same(take('3', 4), { takes: 3, left: 0, eligible: true }) === true && same(take('0', 4), { takes: 0, left: 0, eligible: true }) === true ? true : short([take('10', 4), take('3', 4)])
  })
  add('pool: a colony shipping lines may not load from gives them none of the batch', () => {
    const civilian = value(assess(A, { batch: '10', sources: sources(source({ ColonistDestination: 2 })) }).civilian)

    return same(civilian, { takes: 0, left: 10, eligible: false }) === true ? true : short(civilian)
  })
  add('pool: a pool at or below 0 gives shipping lines none of the batch, and is shown as stored', () => {
    const a = assess(A, { batch: '10', sources: sources(source({ AvailableColonists: -2 })) })

    return value(a.civilian).takes === 0 && value(a.civilian).left === 10 && value(a.pool).stored === -2 ? true : short([a.civilian.value, a.pool.value])
  })
  add('pool: the ceiling is the pressure as a share of the population, and after the batch of the people left; a pressure the save lacks leaves the ceilings unknown, not 0', () => {
    const known = value(assess(A, { batch: '12.5', sources: sources(source({ ColonizationPressure: 4 })) }).pool)
    const lacking = value(assess(A, { batch: '12.5', sources: sources(source({ ColonizationPressure: null })) }).pool)
    const noBatch = value(assess(A, { sources: sources(source({ ColonizationPressure: 4 })) }).pool)

    return near(known.ceiling, 2.5) && near(known.ceilingAfter, 2) && known.stored === 4 && lacking.ceiling === null && lacking.ceilingAfter === null && lacking.stored === 4 && noBatch.ceilingAfter === null ? true : short([known, lacking, noBatch])
  })
  add('pool: the pool does not limit the removal itself: the limit is the same for a pool of 0 and a pool of 100', () => {
    const limits = [0, 100].map((stored) => value(assess(A, { floor: '5', sources: sources(source({ AvailableColonists: stored })) }).removable).limit)

    return limits[0] === limits[1] ? true : short(limits)
  })
  add('pool: a batch larger than the colony\'s people leaves the pickup unavailable whatever the pool holds, as the outcome is, and a batch of all its people is allowed', () => {
    const small = colony({ Population: 10, InstallationWorkers: 0 })
    const big = assess(small, { batch: '30', sources: sources(source({ AvailableColonists: 20, ColonizationPressure: 200 })) })
    const ordinary = assess(small, { batch: '30', sources: sources(source({ AvailableColonists: 4 })) })
    const whole = assess(small, { batch: '10', sources: sources(source({ AvailableColonists: 20 })) })

    return big.outcome.status === 'unavailable' && big.civilian.status === 'unavailable' && big.civilian.value === null && ordinary.civilian.status === 'unavailable' && same(value(whole.civilian), { takes: 10, left: 0, eligible: true }) === true ? true : short([plain(big.civilian), plain(ordinary.civilian), whole.civilian.value])
  })
  add('pool: the pickup has a figure exactly when the batch has an outcome, and then the pickup and the rest add up to a batch within the colony\'s people', () => {
    const small = colony({ Population: 10, InstallationWorkers: 0 })
    const faults = ['0', '5', '10', '10.5', '11', '30', '1000'].filter((batch) => {
      const a = assess(small, { batch, sources: sources(source({ AvailableColonists: 20 })) })
      const civilian = value(a.civilian)

      return (a.outcome.status === 'unavailable') !== (a.civilian.status === 'unavailable') || (civilian !== null && (civilian.takes + civilian.left !== Number(batch) || Number(batch) > 10 + 1e-9))
    })

    return faults.length === 0 ? true : short(faults)
  })

  // ----- pickups yet to happen -----
  add('future: future shipping-line pickups are unavailable and name what is not known, whatever the pool, the pressure, the role and the queue say', () => {
    const rich = assess(A, { batch: '10', floor: '5', committed: queue(25, 30), sources: sources(source({ AvailableColonists: 50, ColonizationPressure: 900 })) })
    const bare = cf.assessColony({ populationId: 9, workers: w.results(A).workers, cost: w.results(A).cost, floor: '', batch: '' })

    return [rich, bare].every((a) => a.future.status === 'unavailable' && a.future.value === null && a.future.inputs.missing.length >= 2) && rich.civilian.status !== 'unavailable' && cf.futurePickupsResult().value === null ? true : short([rich.future, bare.future].map(plain))
  })
  add('future: no figure of the pool, the pressure or the ceiling is carried into a pickup to come', () => {
    const text = JSON.stringify(assess(A, { batch: '10', sources: sources(source({ AvailableColonists: 50, ColonizationPressure: 900 })) }).future)

    return !/50|900|\bvalue":\d/.test(text) ? true : text
  })

  // ----- the rules -----
  add('rules: every result of the panel names a registered rule of the area, and a figure the player entered makes the limit no stronger than assumed', () => {
    const a = assess(A, { batch: '10', floor: '5', committed: queue(25, 30) })
    const ids = ['staffing', 'removable', 'outcome', 'committed', 'source', 'pool', 'civilian', 'future'].map((key) => a[key].rule.id)
    const wanted = ['colonistFloor.staffing', 'colonistFloor.removable', 'colonistFloor.outcome', 'colonistFloor.committed', 'colonistFloor.source', 'colonistFloor.pool', 'colonistFloor.civilian', 'colonistFloor.futurePickups']

    return same(ids, wanted) === true && a.removable.status !== 'confirmed' && a.removable.assumptions.length > 0 && same(a.removable.assumptions, assess(A, { batch: '10', floor: '', committed: queue(25, 30) }).removable.assumptions) !== true ? true : short(ids)
  })
  add('rules: the rules\' notes and the reasons are in the UI voice: no first or second person', () => {
    const texts = ctx.m.provenance.listRules().filter((rule) => rule.id.startsWith('colonistFloor.')).flatMap((rule) => [rule.note, ...rule.assumptions])
    const a = assess(A, { batch: '10', floor: '5', sources: sources(source({ ColonistDestination: 0, PoliticalStatus: 2, MilitaryRestrictedColony: 1 })) })
    const spoken = [...texts, ...a.source.value.reasons, ...a.future.inputs.missing, ...a.outcome.inputs.missing].filter((text) => PRONOUNS.test(text))

    return texts.length >= 8 && !spoken.length ? true : short(spoken)
  })

  // ----- the loader -----
  add('loader: reads each colony\'s source fields for the race and game selected, a null stays null, and a flag that is not 0 or 1 is unknown', async () => {
    const db = await memorySources()
    const loaded = await cf.loadColonistSources(db, { GameID: GAME, RaceID: RACE })

    await db.close()

    const byId = Object.fromEntries(loaded.rows.map((entry) => [entry.PopulationID, entry]))

    return loaded.read === true && same(loaded.rows.map((entry) => entry.PopulationID), [1, 2, 3]) === true && same(byId[1], { PopulationID: 1, ColonistDestination: 1, PoliticalStatus: 1, MilitaryRestrictedColony: 0, AvailableColonists: 4.5, ColonizationPressure: 2 }) === true && byId[2].AvailableColonists === null && byId[2].ColonizationPressure === null && byId[3].MilitaryRestrictedColony === null && loaded.problems.length === 0 ? true : short(loaded)
  })
  add('loader: a column the save lacks reads as null (not 0) and is told apart from another missing column, the rest is read', async () => {
    const db = await memorySources({ without: 'AvailableColonists' })
    const other = await memorySources({ without: 'ColonizationPressure' })
    const loaded = await cf.loadColonistSources(db, { GameID: GAME, RaceID: RACE })
    const loadedOther = await cf.loadColonistSources(other, { GameID: GAME, RaceID: RACE })

    await db.close()
    await other.close()

    return loaded.rows.length === 3 && loaded.rows.every((entry) => entry.AvailableColonists === null) && loaded.rows[0].ColonizationPressure === 2 && loaded.problems.length === 1 && loadedOther.problems.length === 1 && loaded.problems[0] !== loadedOther.problems[0] && loadedOther.rows.every((entry) => entry.ColonizationPressure === null) && loadedOther.rows[0].AvailableColonists === 4.5 ? true : short([loaded, loadedOther])
  })
  add('loader: a save without the population table\'s keys reads no row and says it could not read, and a missing table never throws', async () => {
    const db = await memorySources({ without: 'GameID' })
    const loaded = await cf.loadColonistSources(db, { GameID: GAME, RaceID: RACE })
    const empty = await cf.loadColonistSources({ query: async () => [[]] }, { GameID: GAME, RaceID: RACE })

    await db.close()

    return loaded.read === false && loaded.rows.length === 0 && loaded.problems.length === 1 && !/\b(?:FCT|DIM|VIR)_|\.\w|[a-z][A-Z]/.test(loaded.problems[0]) && empty.read === false && empty.rows.length === 0 ? true : short([loaded, empty])
  })
  add('loader: the rows read give the colonies\' roles and pools to the assessment, and a colony the read lacks stays unknown', async () => {
    const db = await memorySources()
    const loaded = await cf.loadColonistSources(db, { GameID: GAME, RaceID: RACE })

    await db.close()

    const a = assess(A, { batch: '10', sources: loaded })
    const b = assess(colony({ PopulationID: 99 }), { batch: '10', sources: loaded })

    return a.source.value.eligible === true && a.pool.value.stored === 4.5 && b.source.status === 'unavailable' && b.pool.status === 'unavailable' ? true : short([a.source, b.source].map(plain))
  })

  return statements
}

// ---------- the panel ----------

const panel = (ctx) => {
  const w = world(ctx.m)
  const { row, colony, costed, queue, source, sources, A } = w
  const { options, componentText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const B = colony({ PopulationID: 2, PopName: 'Beta', Population: 100, InstallationWorkers: 5 })
  const C = costed(5, { PopulationID: 3, PopName: 'Gamma', Population: 200, InstallationWorkers: 10 })
  const SOURCES = sources(source(), source({ PopulationID: 2, ColonistDestination: 2, AvailableColonists: 9 }))
  const mount = (data = {}) => instantiate(options, { $store: STORE, data: { colonies: [row(A), row(B), row(C)], sources: SOURCES, committedView: false, ...data } })
  const itemOf = (vm, id) => vm.items.find((item) => item.key === id)

  add('panel: a row for each colony, from the Outlook\'s own rows, with its name and place', () => {
    const vm = mount()

    return same(vm.items.map((item) => [item.key, item.name, item.place]), [[1, 'Alpha', 'Sol'], [2, 'Beta', 'Sol'], [3, 'Gamma', 'Sol']]) === true ? true : short(vm.items.map((item) => item.key))
  })
  add('panel: with no colony there is no row and no throw', () => {
    const vm = mount({ colonies: [] })

    return vm.items.length === 0 && typeof vm.headline === 'string' ? true : short(vm.items)
  })
  add('panel: with no batch and no floor each row shows today\'s figures and the staffing floor, and no outcome', () => {
    const item = itemOf(mount(), 1)

    return near(item.population, 62.5) && item.minimum > 0 && item.remaining === null && item.shortage === null && item.removableData.binding === 'staffing' && item.floorText === '' ? true : short(item)
  })
  add('panel: a batch gives each row the remaining population and the quantified shortage', () => {
    const vm = mount({ batchText: '30' })
    const alpha = itemOf(vm, 1)
    const beta = itemOf(vm, 2)

    return near(alpha.remaining, 32.5) && alpha.shortage > 1 && alpha.shortAfter === true && near(beta.remaining, 70) && beta.shortAfter === false && beta.shortage === 0 ? true : short([alpha, beta].map((item) => [item.remaining, item.shortage]))
  })
  add('panel: a floor typed for one colony binds that colony only, ahead of staffing, and is read as it is typed', () => {
    const vm = mount({ batchText: '10', floors: { 1: '55' } })
    const alpha = itemOf(vm, 1)
    const beta = itemOf(vm, 2)

    return alpha.removableData.binding === 'floor' && near(alpha.removable, 7.5) && alpha.breaksFloor === true && alpha.shortage === 0 && beta.removableData.binding !== 'floor' && beta.floorText === '' ? true : short([alpha.removableData, alpha.removable, beta.removableData])
  })
  add('panel: a floor that is not a number marks the field and gives no limit', () => {
    const item = itemOf(mount({ floors: { 1: 'abc' } }), 1)

    return item.floorInvalid === true && item.removable === null && item.removableData === null ? true : short(item)
  })
  add('panel: typing a floor sets it for the colony and clearing it removes the entry, never keeping a blank', () => {
    const vm = mount()

    vm.setFloor(1, '20')
    vm.setFloor(2, '30')
    const set = { ...vm.floors }

    vm.setFloor(1, '')
    vm.setFloor(2, '   ')

    return same(set, { 1: '20', 2: '30' }) === true && same(vm.floors, {}) === true ? true : short([set, vm.floors])
  })
  add('panel: the role and the emigrants of each row come from the colony\'s source row; a colony with none stays unknown', () => {
    const vm = mount({ batchText: '10' })
    const alpha = itemOf(vm, 1)
    const beta = itemOf(vm, 2)
    const gamma = itemOf(vm, 3)

    return alpha.role === 'source' && alpha.pool === 4 && alpha.civilianTakes === 4 && alpha.civilianLeft === 6 && beta.role === 'stable' && beta.civilianTakes === 0 && gamma.role === null && gamma.pool === null && gamma.civilianTakes === null ? true : short([alpha, beta, gamma].map((item) => [item.role, item.pool, item.civilianTakes]))
  })
  add('panel: a colony short today says so, has no staffing floor and can give nothing', () => {
    const item = itemOf(mount({ batchText: '10' }), 3)

    return item.shortToday === true && item.alreadyShort === true && item.minimum === null && item.removable === 0 && vm0(item) ? true : short(item)
  })
  add('panel: the future pickups of every row are unavailable', () => {
    const vm = mount({ batchText: '10', floors: { 1: '5' } })

    return vm.items.every((item) => item.futureResult.status === 'unavailable' && item.futureResult.value === null) ? true : 'a future pickup has a figure'
  })
  add('panel: the headline counts the colonies over the limit and those not known, and differs between no batch, a refused batch and a counted one', () => {
    const none = mount()
    const some = mount({ batchText: '30' })
    const fewer = mount({ batchText: '10' })
    const bad = mount({ batchText: 'x' })
    const state = some.headlineState

    return none.headlineState.state === 'blank' && bad.headlineState.state === 'invalid' && same({ over: state.over, known: state.known, smaller: state.smaller, unknown: state.unknown }, { over: 2, known: 3, smaller: 0, unknown: 0 }) === true && [none, some, fewer, bad].every((vm) => typeof vm.headline === 'string' && vm.headline !== '') && new Set([none, some, fewer, bad].map((vm) => vm.headline)).size === 4 && fewer.headlineState.over < state.over ? true : short([none.headlineState, some.headlineState, bad.headlineState, some.headline])
  })
  add('panel: a batch larger than a colony leaves that colony without an outcome or a pickup, and the headline counts it apart from the colonies not known', () => {
    const vm = mount({ batchText: '150' })
    const alpha = itemOf(vm, 1)
    const state = vm.headlineState

    return alpha.outcome === null && alpha.remaining === null && alpha.shortage === null && alpha.civilianTakes === null && alpha.civilianLeft === null && alpha.removable !== null && same({ over: state.over, known: state.known, smaller: state.smaller, unknown: state.unknown }, { over: 1, known: 1, smaller: 2, unknown: 0 }) === true && vm.headline !== mount({ batchText: '30' }).headline ? true : short([alpha.remaining, alpha.civilianTakes, vm.headlineState, vm.headline])
  })
  add('panel: the queue is read only when the Outlook counts it: with the view off no committed figure is shown, even from a row that carries one', () => {
    const rows = [row(A, { committedResult: queue(25, 27) })]
    const off = itemOf(mount({ colonies: rows, committedView: false, batchText: '10' }), 1)
    const on = itemOf(mount({ colonies: rows, committedView: true, batchText: '10' }), 1)

    return off.committedSides === null && off.committedResult === null && on.committedSides && near(on.committedSides.supported.required, 25) && on.committedSides.possible.minimum > on.committedSides.supported.minimum ? true : short([off.committedSides, on.committedSides])
  })
  add('panel: counting the queue changes none of the current columns', () => {
    const rows = [row(A, { committedResult: queue(25, 30) }), row(B)]
    const off = mount({ colonies: rows, committedView: false, batchText: '10', floors: { 1: '30' } })
    const on = mount({ colonies: rows, committedView: true, batchText: '10', floors: { 1: '30' } })
    const keys = ['population', 'spare', 'minimum', 'removable', 'bindingText', 'remaining', 'shortage', 'pool', 'roleText']

    return same(off.items.map((item) => keys.map((key) => item[key])), on.items.map((item) => keys.map((key) => item[key]))) === true ? true : 'a current column moved with the queue'
  })
  add('panel: an unavailable queue is shown as unavailable naming what it lacks, with the current columns untouched', () => {
    const gap = ctx.m.provenance.unavailable({ rule: 'colonies.committedWorkers', missing: ['the queue forecast'] })
    const vm = mount({ colonies: [row(A, { committedResult: gap })], committedView: true, batchText: '10' })
    const item = vm.items[0]

    return item.committedSides === null && vm.missingText(item.committedResult).includes('the queue forecast') && item.remaining !== null ? true : short(item.committedResult)
  })
  add('panel: the queue table has a line for each figure and a column for each demand', () => {
    const vm = mount({ colonies: [row(A, { committedResult: queue(25, 30) })], committedView: true, batchText: '10' })
    const lines = vm.queueLines(vm.items[0])

    return lines.length > 1 && lines.every((line) => typeof line.supported === 'string' && typeof line.possible === 'string') ? true : short(lines)
  })
  add('panel: the worker lines give today and after the batch, the shortage in the last', () => {
    const vm = mount({ batchText: '30' })
    const lines = vm.splitLines(itemOf(vm, 1))

    return lines.length > 1 && lines.some((line) => line.error === true && line.today === 0 && line.after > 1) ? true : short(lines)
  })
  add('panel: sorting puts the unknown last whichever way the table sorts, and the table takes the sort it is given whatever the initial one', () => {
    const vm = mount({ batchText: '10' })
    const rows = vm.items
    const sorted = (desc) => vm.sortNullLast([...rows], ['pool'], [desc]).map((item) => item.key)
    const columns = vm.headers.map((header) => header.value)
    const given = mount({ batchText: '10', floorTable: { ...vm.floorTable, sortBy: ['pool'], sortDesc: [true] } })
    const { table } = drawn(given)
    const arranged = table.data.attrs['custom-sort']([...table.data.attrs.items], table.data.attrs['sort-by'], table.data.attrs['sort-desc'])

    return sorted(false)[2] === 3 && sorted(true)[2] === 3 && vm.floorTable.sortBy.every((column) => columns.includes(column)) && table.data.attrs['sort-by'] === given.floorTable.sortBy && same(table.data.attrs['sort-by'], ['pool']) === true && arranged[arranged.length - 1].pool === null ? true : short([sorted(false), sorted(true), vm.floorTable.sortBy])
  })
  add('panel: the infrastructure the colony has built is shown apart from what is on its way: the support now is the built infrastructure, the Outlook\'s cap counts the deliveries, and only a batch that leaves more people than the built support is flagged', () => {
    const c = colony({ Population: 10, ReqInf: 1000, Infrastructure: 100, InstallationWorkers: 0 })
    const incoming = { Infrastructure: 9900 }
    const item = mount({ colonies: [row(c, {}, incoming)], batchText: '0' }).items[0]
    const small = mount({ colonies: [row(c, {}, incoming)], batchText: '9.5' }).items[0]
    const blank = mount({ colonies: [row(c, {}, incoming)] }).items[0]
    const settled = mount({ colonies: [row(c)], batchText: '0' }).items[0]
    const needless = mount({ colonies: [row(A)], batchText: '0' }).items[0]

    return near(item.supportNow, 1) && near(item.infrastructureCap, 100) && item.unsupportedAfter === true && item.supportResult.status !== 'unavailable' && item.capResult.status !== 'unavailable' && small.unsupportedAfter === false && blank.unsupportedAfter === false && near(settled.supportNow, 1) && near(settled.infrastructureCap, 1) && needless.supportNow === null && needless.unsupportedAfter === false ? true : short([item.supportNow, item.infrastructureCap, item.unsupportedAfter, small.unsupportedAfter, settled.supportNow, needless.supportNow])
  })

  // ----- the template, compiled and rendered -----
  const root = templateAst(componentText)
  const summary = root.attrsMap['data-summary'] || ''
  // The result each figure column marks: the one of the rule that works the figure out.
  const FIGURES = { role: 'sourceResult', population: 'staffingResult', spare: 'staffingResult', minimum: 'staffingResult', removable: 'removableResult', bindingText: 'removableResult', remaining: 'outcomeResult', shortage: 'outcomeResult', pool: 'poolResult' }
  const drawn = (vm) => {
    const out = rendered(componentText, vm)
    const table = treeOf(out.tree).find((node) => node.tag === 'v-data-table')

    return { ...out, table, slots: table ? table.data.scopedSlots : {} }
  }

  add('panel-template: the panel is a top-level .panel with a data-summary of its own: text with letters, no digit, no first or second person', () => (classesOf(root).includes('panel') && summary.trim() !== '' && /[a-z]/i.test(summary) && !/\d/.test(summary) && !PRONOUNS.test(summary) ? true : `${root.tag} ${classesOf(root)}`))
  add('panel-template: the template compiles', () => { const errors = templateErrors(componentText); return errors.length ? short(errors) : true })
  add('panel-template: the foot and the labels are in the UI voice: no first or second person', () => {
    const visible = staticTextOf(root).join(' ')
    const texts = [...vm0Texts(mount({ batchText: '30', colonies: [row(A, { committedResult: queue(25, 30) })], committedView: true }))]

    return PRONOUNS.test(visible) ? `the template speaks to a person: ${(visible.match(PRONOUNS) || [])[0]}` : texts.some((text) => PRONOUNS.test(text)) ? `a computed text speaks to a person: ${texts.find((text) => PRONOUNS.test(text))}` : true
  })
  add('panel-template: every cell that shows a figure carries a mark bound to its own result', () => {
    const vm = mount({ batchText: '10', floors: { 1: '5' } })
    const { slots } = drawn(vm)
    const item = vm.items[0]
    const wrong = Object.entries(FIGURES).filter(([column, own]) => !slots[`item.${column}`] || !marksIn(slots[`item.${column}`]({ item })).includes(item[own])).map(([column]) => column)

    return !wrong.length && Object.values(FIGURES).every((own) => item[own] && item[own].rule) ? true : `no mark of its own result in ${wrong.join(', ')}`
  })
  add('panel-template: each table of the detail row marks its results, the future pickups with the result that is unavailable, the queue with its result, and the infrastructure built apart from the support with the deliveries', () => {
    const c = colony({ Population: 10, ReqInf: 1000, Infrastructure: 100, InstallationWorkers: 0 })
    const vm = mount({ colonies: [row(c, { committedResult: queue(25, 30) }, { Infrastructure: 9900 })], committedView: true, batchText: '5' })
    const { slots } = drawn(vm)
    const item = vm.items[0]
    const detail = slots['expanded-item']({ headers: vm.headers, item })
    const tables = treeOf(detail).filter((node) => node.tag === 'v-simple-table')
    const marks = marksIn(detail)
    const sections = treeOf(detail).filter((node) => node.tag === 'v-col')

    return tables.length >= 3 && sections.length >= 3 && sections.every((section) => marksIn(section).length > 0) && marks.includes(item.futureResult) && item.futureResult.status === 'unavailable' && marks.includes(item.committedResult) && item.committedSides !== null && marks.includes(item.supportResult) && marks.includes(item.capResult) && item.supportResult !== item.capResult ? true : `${tables.length} tables, ${sections.length} sections, ${marks.length} marks, ${[item.futureResult, item.committedResult, item.supportResult, item.capResult].map((result) => marks.includes(result))}`
  })
  add('panel-template: the table keys its rows, sorts the unknown last and has a column for each figure the rows hold', () => {
    const { table } = drawn(mount({ batchText: '10' }))
    const { items, headers } = table.data.attrs
    const keyed = items.map((item) => item[table.data.attrs['item-key']])
    const sorted = table.data.attrs['custom-sort']([...items], ['pool'], [false])
    const missing = headers.filter((header) => !(header.value in items[0])).map((header) => header.value)

    return !missing.length && items.length === 3 && keyed.every((key) => key !== undefined) && new Set(keyed).size === items.length && sorted[items.length - 1].pool === null ? true : `columns without a figure: ${missing.join(', ')}; keys ${keyed}`
  })
  add('panel-template: the panel draws no chart, so the table is the figure', () => {
    const vm = mount({ batchText: '10' })
    const { tags, slots } = drawn(vm)

    slots['expanded-item']({ headers: vm.headers, item: vm.items[0] })

    return tags.every((name) => name !== 'canvas' && !name.includes('chart')) && tags.includes('v-data-table') ? true : short(tags)
  })
  add('panel-template: the view fields are kept with the others of the race, the table under its own key', () => {
    const fields = Object.values(ctx.persisted)
    const keys = fields.map((field) => field.key)

    return fields.length === 3 && keys.every((key) => typeof key === 'string' && key !== '') && new Set(keys).size === keys.length && fields.filter((field) => field.table).length === 1 && fields.filter((field) => !field.table).every((field) => field.scope === 'race') ? true : short(fields)
  })

  return statements
}

// The text a mounted panel computes for a few rows: the notes, the lines and the headline.
const vm0Texts = (vm) => {
  const out = [vm.headline]

  vm.items.forEach((item) => {
    out.push(vm.limitNote(item), vm.pickupText(item), vm.spareText(item), vm.missingText(item.futureResult), vm.missingText(item.committedResult))
    vm.queueLines && item.committedSides && vm.queueLines(item).forEach((line) => out.push(line.label, line.supported, line.possible))
    vm.splitLines(item).forEach((line) => out.push(line.label))
  })

  return out
}

const vm0 = (item) => item.removableData && item.removableData.alreadyShort === true

// ---------- the page ----------

// The reads of the page that are tracked (their loadErrors entry is written when each settles), found by running each async read of the page and of its mixins against a database that fails: what the page declares, not what its text says.
const asyncNamesOf = (options) => [...(options.mixins || []).flatMap(asyncNamesOf), ...Object.keys(options.asyncComputed || {})]
const READS = new WeakMap()
const readsOf = async (ctx) => {
  if (!READS.has(ctx)) {
    const failing = { query: async () => { throw new Error('boom') } }
    const vm = instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { loadErrors: {} } })
    const tracked = []

    for (const key of new Set(asyncNamesOf(ctx.livePageOptions))) {
      try {
        await vm.runAsync(key)
      } catch (error) {
        // a failed read is still a tracked one
      }

      if (vm.loadErrors[key] !== undefined) {
        tracked.push(key)
      }
    }

    READS.set(ctx, tracked)
  }

  return READS.get(ctx)
}

const page = (ctx) => {
  const w = world(ctx.m)
  const { cf } = ctx.m
  const { pageText, pageOptions } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const pageAst = templateAst(pageText)
  const mounted = elementsOf(pageAst).filter((element) => element.tag === 'colonist-floor')
  const mount = (data = {}) => instantiate(pageOptions, { $store: PAGE_STORE, data: { loadErrors: {}, ...data } })
  const liveMount = (data = {}) => instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data })

  add('page: the panel is mounted once with the page\'s own rows, colonist sources, queue flag and read state, and its retry reads the colonist source again: each bound value is evaluated against the page', () => {
    const { props, events } = mounted.length ? bindingsOf(mounted[0]) : { props: {}, events: {} }
    const colonies = [{ ...w.colony(), ...pageColony() }]
    const sentinel = { rows: [], problems: [], held: 'the read the page holds' }
    const at = (loadErrors, workerBasis = 'current', more = {}) => liveMount({ colonies, inbound: [], workerBasis, colonistSources: sentinel, loadErrors, ...more })
    const valueOf = (name, vm) => (props[name] === undefined ? undefined : evaluate(props[name], vm))
    const states = [{}, { colonistSources: 'down' }, { colonistSources: null }].map((loadErrors) => at(loadErrors))
    const rowsVm = at({})
    const state = ['loading', 'failed', 'error'].every((name) => states.every((vm) => valueOf(name, vm) === vm.colonistState[name]) && new Set(states.map((vm) => valueOf(name, vm))).size >= 2)
    const updates = []
    const retrying = at({ colonistSources: 'down' }, 'current', { $asyncComputed: { colonistSources: { update: () => updates.push('colonistSources') } } })
    const handler = events.retry === undefined ? null : evaluate(events.retry, retrying)

    if (typeof handler === 'function') {
      handler()
    }

    return mounted.length === 1 && valueOf('sources', rowsVm) === sentinel && rowsVm.rows.length === 1 && same(valueOf('colonies', rowsVm), rowsVm.rows) === true && valueOf('committed-view', at({}, 'current')) === false && valueOf('committed-view', at({}, 'committed')) === true && state && same(updates, ['colonistSources']) === true && 'ColonistFloor' in pageOptions.components ? true : `${short([props, events])} ${Object.keys(pageOptions.components)} ${updates}`
  })
  add('page: the panel sits inside the gate where every other read has loaded, whatever the state of its own read, after the Colonies panel and before the mine bootstrap', async () => {
    const tracked = await readsOf(ctx)
    const core = Object.fromEntries(tracked.filter((key) => key !== 'colonistSources').map((key) => [key, null]))
    const all = elementsOf(pageAst)
    const at = all.indexOf(mounted[0])
    const gates = []

    for (let node = mounted[0]; node; node = node.parent) {
      if (node.if) {
        gates.push(node.if)
      }
    }

    const shown = (loadErrors) => { const vm = liveMount({ loadErrors }); return gates.every((expression) => !!evaluate(expression, vm)) }
    const panels = all.map((element, index) => [element, index]).filter(([element, index]) => classesOf(element).includes('panel') && index < at).map(([, index]) => index)
    const bootstrap = all.findIndex((element) => classesOf(element).includes('mine-bootstrap'))
    const failedCore = Object.keys(core).map((key) => shown({ ...core, [key]: 'down' }))

    return mounted.length === 1 && shown(core) === true && shown({ ...core, colonistSources: 'down' }) === true && failedCore.length > 0 && failedCore.every((value) => value === false) && panels.length > 0 && at < bootstrap ? true : short([at, panels, bootstrap, shown(core), failedCore])
  })
  add('page: the template compiles', () => { const errors = templateErrors(pageText); return errors.length ? short(errors) : true })
  add('page: the colonist read is a tracked read with its default, and every tracked read names itself when it fails', async () => {
    const tracked = await readsOf(ctx)
    const core = tracked.filter((key) => key !== 'colonistSources')
    const read = pageOptions.asyncComputed.colonistSources
    const unnamed = core.filter((key) => liveMount({ loadErrors: { [key]: 'down' } }).failedInputsText === '')
    const optionalFailure = liveMount({ loadErrors: { colonistSources: 'down' } }).colonistState

    return tracked.includes('colonistSources') && core.length > 0 && read && same(read.default, cf.NO_COLONIST_SOURCES) === true && !unnamed.length && optionalFailure.failed !== '' && optionalFailure.error === 'down' ? true : short([tracked, unnamed, optionalFailure])
  })
  add('page: the read is of the race and game selected, and waits for a database, a game and a race', async () => {
    const empty = mount({ database: null, GameID: GAME, RaceID: RACE })
    const none = await empty.runAsync('colonistSources')
    const noGame = await mount({ database: await memorySources(), GameID: null, RaceID: RACE }).runAsync('colonistSources')
    const db = await memorySources()
    const full = mount({ database: db, GameID: GAME, RaceID: RACE })
    const read = await full.runAsync('colonistSources')

    await db.close()

    return none === cf.NO_COLONIST_SOURCES && noGame === cf.NO_COLONIST_SOURCES && read.rows.length === 3 && full.loadErrors.colonistSources === null ? true : short([none === cf.NO_COLONIST_SOURCES, read.rows.length, full.loadErrors])
  })
  add('page: the Outlook\'s rows carry what the panel reads: the worker split and colony cost results, the committed result only when the queue is counted', () => {
    const colonies = [{ ...w.colony(), ...pageColony() }]
    const rowsOf = (workerBasis) => mount({ colonies, inbound: [], workerBasis }).rows
    const current = rowsOf('current')[0]
    const committed = rowsOf('committed')[0]

    return current.r.workersNow && current.r.cost && current.PopulationID === 1 && current.name === 'Alpha' && Number.isFinite(current.Population) && current.committedResult === null && current.r.workersNow.status !== 'unavailable' && committed.committedResult !== null ? true : short([current.r.workersNow, committed.committedResult])
  })

  return statements
}

// ---------- the read that holds nothing back ----------

// The elements a render produced, flattened: arrays are walked, and each record's children after it.
const treeOf = (node) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit)
    } else if (entry && typeof entry === 'object') {
      found.push(entry)
      visit(entry.children)
    }
  }

  visit(node)

  return found
}

// The results the provenance marks of a render are bound to.
const marksIn = (nodes) => treeOf(nodes).filter((node) => node.tag === 'provenance-mark').map((node) => node.data.attrs && node.data.attrs.result).filter((result) => result !== undefined)

// What a compiled template renders for a mounted instance: the render function of the component's own template runs with the instance as its scope. Each element it creates is a record { tag, data, children } and each interpolated text is recorded; the scoped slots are functions of the record of the table, to be called with a row.
const rendered = (componentText, vm) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source: componentText })
  const descriptor = parsed.descriptor || parsed
  const { code } = compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' })
  const render = require('vm').runInNewContext(`${code.replace(/export \{[^}]*\}\s*$/, '')}\nrender`, {})
  const tags = []
  const texts = []
  const make = (tag, data, children) => {
    const hasData = !Array.isArray(data)

    tags.push(tag)

    return { tag, data: (hasData ? data : null) || {}, children: (hasData ? children : data) || [] }
  }
  const helpers = { _self: { _c: make }, _l: (list, each) => (list || []).map(each), _v: (text) => text, _s: (value) => { texts.push(String(value)); return String(value) }, _e: () => null, _u: (slots) => Object.fromEntries(slots.map((slot) => [slot.key, slot.fn])), _m: () => null }
  const tree = render.call(new Proxy(vm, { get: (target, key) => (key in helpers ? helpers[key] : target[key]) }))

  return { tags, texts, tree }
}

const optional = (ctx) => {
  const w = world(ctx.m)
  const { row, source, sources, A } = w
  const { options, componentText, livePageOptions } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const coreOf = async () => (await readsOf(ctx)).filter((key) => key !== 'colonistSources')
  const settledOf = async () => Object.fromEntries((await coreOf()).map((key) => [key, null]))
  const failing = { query: async () => { throw new Error('boom') } }
  const mountPage = async (data = {}, database = failing) => instantiate(livePageOptions, { $store: PAGE_STORE, database, GameID: GAME, RaceID: RACE, data: { loadErrors: await settledOf(), ...data } })
  const mountPanel = (state) => instantiate(options, { $store: STORE, data: { colonies: [row(A)], sources: sources(source()), committedView: false, loading: false, failed: '', error: '', ...state } })
  const stateOf = (vm) => vm.colonistState

  add('optional: the other reads in, the page is ready while the colonist read is in flight, and the panel is loading', async () => {
    const vm = await mountPage()

    return vm.ready === true && same(stateOf(vm), { loading: true, failed: '', error: '' }) === true ? true : short([vm.ready, stateOf(vm)])
  })
  add('optional: a rejected colonist read leaves the page ready with no failed input, and the panel reports the failure', async () => {
    const vm = await mountPage()
    let thrown = null

    try {
      await vm.runAsync('colonistSources')
    } catch (error) {
      thrown = error.message
    }

    const state = stateOf(vm)

    return thrown === 'boom' && vm.ready === true && vm.inputsLoaded === true && vm.failedInputs.length === 0 && vm.failedInputsText === '' && state.loading === false && state.error === 'boom' && state.failed.length > 0 && vm.loadErrors.colonistSources === 'boom' ? true : short([thrown, vm.ready, vm.failedInputs, state])
  })
  add('optional: a failure of another read still holds the page back, and is not the panel\'s', async () => {
    const [first] = await coreOf()
    const vm = await mountPage({ loadErrors: { ...await settledOf(), [first]: 'down' } })

    return vm.ready === false && same(vm.failedInputs, [first]) === true && stateOf(vm).failed === '' ? true : short([vm.ready, vm.failedInputs, stateOf(vm)])
  })
  add('optional: a colonist read that succeeds leaves the panel neither loading nor failed', async () => {
    const db = await memorySources()
    const vm = await mountPage({}, db)

    await vm.runAsync('colonistSources')
    await db.close()

    return vm.ready === true && same(stateOf(vm), { loading: false, failed: '', error: '' }) === true ? true : short([vm.ready, stateOf(vm)])
  })
  add('optional: the retry reads again the colonist read only when it failed', async () => {
    const updates = []
    const [first] = await coreOf()
    const $asyncComputed = Object.fromEntries([...await coreOf(), 'colonistSources'].map((key) => [key, { update: () => updates.push(key) }]))

    ;(await mountPage({ $asyncComputed })).retryColonistSources()
    ;(await mountPage({ $asyncComputed, loadErrors: { ...await settledOf(), colonistSources: 'boom', [first]: 'down' } })).retryColonistSources()

    return same(updates, ['colonistSources']) === true ? true : short(updates)
  })
  add('optional: the panel renders the failure or the progress and no table while the read is out, and the table once it is in', () => {
    const failed = rendered(componentText, mountPanel({ failed: 'the colonist source fields', error: 'boom' })).tags
    const loading = rendered(componentText, mountPanel({ loading: true })).tags
    const loaded = rendered(componentText, mountPanel({})).tags
    const hidden = (tags) => tags.includes('load-state') && !tags.includes('v-data-table') && !tags.includes('v-text-field')

    return hidden(failed) && hidden(loading) && loaded.includes('v-data-table') && !loaded.includes('load-state') ? true : short([failed, loading, loaded])
  })
  add('optional: the panel gives no headline while the read is out, and the headline once it is in', () => {
    const vm = mountPanel({})
    const unread = rendered(componentText, mountPanel({ failed: 'the colonist source fields', error: 'boom' })).texts
    const read = rendered(componentText, vm).texts

    return !unread.includes(vm.headline) && read.includes(vm.headline) ? true : short([unread, read, vm.headline])
  })

  return statements
}

// What the Outlook's rows need beyond the worked colony: the body and the system the page names a colony by.
const pageColony = () => ({ SystemName: 'Sol', Component: 1, SystemBodyID: 1, PlanetNumber: 3, OrbitNumber: 0, BodyClass: 1, SystemBodyName: null, Radius: 6000, HydroExt: 0, TidalLock: 0, RadiationLevel: 0, Gravity: 1, Efficiency: 1, Capital: 0, SpeciesID: 1, SpeciesName: 'Human', PopulationGrowthModifier: 1, PopulationDensityModifier: 1, Infrastructure: 0, LGInfrastructure: 0 })

// ---------- the in-memory population table ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))
const execSql = (raw, sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

// Colonies 1 to 3 of race 5 (colony 2 has null fields, colony 3 a flag of 7), a colony of race 6 and one of another game. `without` drops a column.
const memorySources = async ({ without = null } = {}) => {
  const raw = new sqlite3.Database(':memory:')
  const columns = ['PopulationID int', 'GameID int', 'RaceID int', 'ColonistDestination int', 'PoliticalStatus int', 'MilitaryRestrictedColony int', 'AvailableColonists real', 'ColonizationPressure real'].filter((column) => column.split(' ')[0] !== without)
  const values = [
    [1, GAME, RACE, 1, 1, 0, 4.5, 2],
    [2, GAME, RACE, 0, 2, 1, null, null],
    [3, GAME, RACE, 2, 1, 7, 1, 1],
    [4, GAME, 6, 1, 1, 0, 9, 9],
    [5, 2, RACE, 1, 1, 0, 9, 9],
  ]
  const names = columns.map((column) => column.split(' ')[0])
  const all = ['PopulationID', 'GameID', 'RaceID', 'ColonistDestination', 'PoliticalStatus', 'MilitaryRestrictedColony', 'AvailableColonists', 'ColonizationPressure']
  const inserts = values.map((entry) => `insert into FCT_Population (${names.join(', ')}) values (${names.map((name) => (entry[all.indexOf(name)] === null ? 'null' : entry[all.indexOf(name)])).join(', ')})`)

  await execSql(raw, `create table FCT_Population (${columns.join(', ')});\n${inserts.join(';\n')};`)

  return { query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) }
}

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve({ file: path.basename(resolved), query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) })))
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const saveStatements = async (ctx, save) => {
  const { cf } = ctx.m
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const name = path.basename(save.file)
  const statements = []
  const add = (label, test) => statements.push([`save-loader: ${name}: ${label}`, test])
  const where = `GameID = ${save.game} and RaceID = ${save.race}`

  add('the loader reads one row for each colony of the race, in the save\'s order, with the stored values', async () => {
    const loaded = await cf.loadColonistSources(database, { GameID: save.game, RaceID: save.race })
    const raw = await rowsOf(database, `select PopulationID, ColonistDestination, PoliticalStatus, MilitaryRestrictedColony, AvailableColonists, ColonizationPressure from FCT_Population where ${where} order by PopulationID`)

    return loaded.read === true && loaded.rows.length === raw.length && raw.length > 0 && loaded.rows.every((entry, at) => ['ColonistDestination', 'PoliticalStatus', 'MilitaryRestrictedColony', 'AvailableColonists', 'ColonizationPressure'].every((key) => entry[key] === raw[at][key]) && entry.PopulationID === raw[at].PopulationID) ? true : short([loaded.rows.length, raw.length, loaded.problems])
  })
  add('the colonies marked a source, imperial and unrestricted are the ones shipping lines may load from, counted against the raw rows', async () => {
    const loaded = await cf.loadColonistSources(database, { GameID: save.game, RaceID: save.race })
    const [{ eligible }] = await rowsOf(database, `select count(*) as eligible from FCT_Population where ${where} and ColonistDestination = 1 and PoliticalStatus = 1 and MilitaryRestrictedColony = 0`)
    const counted = loaded.rows.filter((entry) => { const result = cf.sourceResult({ row: entry }); return result.value && result.value.eligible }).length

    return counted === eligible ? true : `${counted} != ${eligible}`
  })
  add('a colony with a null pool is unknown to the assessment, as many as the raw rows count', async () => {
    const loaded = await cf.loadColonistSources(database, { GameID: save.game, RaceID: save.race })
    const [{ nulls }] = await rowsOf(database, `select count(*) as nulls from FCT_Population where ${where} and AvailableColonists is null`)
    const unknown = loaded.rows.filter((entry) => cf.poolResult({ row: entry, population: 10, batch: { value: null, state: 'blank' } }).status === 'unavailable').length

    return unknown === nulls ? true : `${unknown} != ${nulls}`
  })

  return { skipped: false, statements, close: () => database.close() }
}

// ---------- the planted faults ----------

/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'the missing keys named by their columns', file: U, find: "'The save lacks the ID, game and race of the colonies, so no colonist source field could be read'", replace: "'FCT_Population has no PopulationID, GameID or RaceID in this save, so no colonist source field could be read'", fails: ['loader'] },
  { name: 'a blank floor coerced to 0', file: U, find: 'if (trimmed === \'\') {\n    return { value: null, state: \'blank\' }', replace: 'if (trimmed === \'\') {\n    return { value: 0, state: \'ok\' }', fails: ['blank', 'floor'] },
  { name: 'future pickups worked out from the pool', file: U, find: '    future: futurePickupsResult(),', replace: '    future: ofRule({ rule: \'colonistFloor.futurePickups\', value: pool.value ? pool.value.stored : 0, inputs: { present: [\'the pool\'] } }),', fails: ['future'] },
  { name: 'the staffing floor taken at the grid step, without narrowing it', file: U, find: 'for (let round = 0; round < BISECTIONS; round += 1) {', replace: 'for (let round = 0; round < 0; round += 1) {', fails: ['staffing'] },
  { name: 'the shortage not held at 0', file: U, find: 'const shortage = Math.max(0, -after.free)', replace: 'const shortage = -after.free', fails: ['outcome'] },
  { name: 'the floor left out of the limit', file: U, find: 'const limit = floorLimit === null ? staffingLimit : Math.min(floorLimit, staffingLimit)', replace: 'const limit = staffingLimit', fails: ['floor'] },
  { name: 'a floor above the population giving a negative limit', file: U, find: 'const floorLimit = floor === null ? null : Math.max(0, population - floor)', replace: 'const floorLimit = floor === null ? null : population - floor', fails: ['floor'] },
  { name: 'a colony short today given its whole population to give', file: U, find: 'const staffingLimit = minimum === null ? 0 : Math.max(0, population - minimum)', replace: 'const staffingLimit = minimum === null ? population : Math.max(0, population - minimum)', fails: ['search'] },
  { name: 'a null pool read as 0', file: U, find: 'AvailableColonists: numberOrNull(row.AvailableColonists),', replace: 'AvailableColonists: numberOrNull(row.AvailableColonists) || 0,', fails: ['loader'] },
  { name: 'a batch larger than the colony given an outcome', file: U, find: 'if (isAvailable(workers) && batch.value > workers.value.population + EPSILON) {', replace: 'if (false) {', fails: ['blank'] },
  { name: 'the queue\'s demand leaking into the current staffing', file: U, find: '  const staffing = staffingResult({ workers, cost })', replace: '  const staffing = staffingResult({ workers: committed && committed.value ? { ...workers, value: { ...workers.value, required: committed.value.required.high[committed.value.required.high.length - 1] } } : workers, cost })', fails: ['current'] },
  { name: 'the military restriction left out of who shipping lines may load from', file: U, find: 'ok: unrestricted, reason', replace: 'ok: true, reason', fails: ['source'] },
  { name: 'the colonist marker left out of who shipping lines may load from', file: U, find: 'ok: role === null ? null : role === \'source\',', replace: 'ok: role === null ? null : true,', fails: ['source'] },
  { name: 'a pool below 0 giving shipping lines a negative load', file: U, find: 'Math.min(batch.value, Math.max(0, stored.stored))', replace: 'Math.min(batch.value, stored.stored)', fails: ['pool'] },
  { name: 'a pickup refused by one field hidden by another that is null', file: U, find: '  if (!refused.length && unknown.length) {', replace: '  if (unknown.length) {', fails: ['null'] },
  { name: 'a pressure the save lacks read as a ceiling of 0', file: U, find: 'const known = pressure !== null && finite(population)', replace: 'const known = finite(population)', fails: ['pool'] },
  { name: 'the queue taken for the supported demand only', file: U, find: 'return { supported: side(queue.required.low), possible: side(queue.required.high) }', replace: 'return { supported: side(queue.required.low), possible: side(queue.required.low) }', fails: ['committed'] },
  { name: 'the panel without its summary', file: V, at: /data-summary(?=\s*=\s*(?:"[^"]*"|'[^']*'))/, to: () => 'data-sum', fails: ['panel-template'] },
  { name: 'a figure of the panel without its mark', file: V, at: /(<template\s+#\[`item\.remaining`\]\s*=\s*"[^"]*"\s*>[\s\S]*?)<provenance-mark\b[^>]*\/>/, to: (m) => m[1], fails: ['panel-template'] },
  { name: 'the panel ignoring the floors typed', file: V, find: 'floor: this.floors[colony.PopulationID], batch: this.batchText', replace: 'floor: undefined, batch: this.batchText', fails: ['panel'] },
  { name: 'the panel never passing the queue', file: V, find: 'committed: this.committedView ? colony.committedResult : null', replace: 'committed: null', fails: ['panel'] },
  { name: 'the panel reading the queue with the view off', file: V, find: 'committed: this.committedView ? colony.committedResult : null', replace: 'committed: colony.committedResult', fails: ['panel'] },
  { name: 'the panel keeping a blank floor as an entry', file: V, find: 'this.floors = typeof text === \'string\' && text.trim() !== \'\' ? { ...rest, [id]: text } : rest', replace: 'this.floors = { ...rest, [id]: text }', fails: ['panel'] },
  { name: 'the panel reading the batch from a fixed text', file: V, find: 'floor: this.floors[colony.PopulationID], batch: this.batchText', replace: 'floor: this.floors[colony.PopulationID], batch: \'\'', fails: ['panel'] },
  { name: 'the page without a label for the read', file: P, at: /^[ \t]*colonistSources\s*:\s*(?:'[^']*'|"[^"]*"),[ \t]*\n/m, to: () => '', fails: ['page'] },
  { name: 'the page reading the sources with no database', file: P, find: '!this.database || !this.GameID || !this.RaceID) {\n          return NO_COLONIST_SOURCES', replace: 'false) {\n          return NO_COLONIST_SOURCES', fails: ['page'] },
  { name: 'the page waiting on the colonist read as on its own', file: P, find: 'return allLoaded(this.loadErrors, CORE_INPUTS)', replace: 'return allLoaded(this.loadErrors, Object.keys(INPUT_LABELS))', fails: ['optional'] },
  { name: 'the page counting the colonist read among the failed inputs', file: P, find: 'return CORE_INPUTS.filter((key) => this.loadErrors[key])', replace: 'return Object.keys(INPUT_LABELS).filter((key) => this.loadErrors[key])', fails: ['optional'] },
  { name: 'the panel showing its figures while the read is out', file: V, find: 'return this.loading || !!this.failed', replace: 'return false', fails: ['optional'] },
  { name: 'the page passing no failure to the panel', file: P, at: /(<colonist-floor\b[^>]*?)\s:failed\s*=\s*(?:"[^"]*"|'[^']*')/, to: (m) => m[1], fails: ['page'] },
  { name: 'the page mounting the panel without the queue flag', file: P, at: /(<colonist-floor\b[^>]*?)\s:committed-view\s*=\s*(?:"[^"]*"|'[^']*')/, to: (m) => m[1], fails: ['page'] },
  { name: 'the staffing search without the services-cap stretch', file: U, find: '...(SERVICE_CAP_POPULATION < population ? [SERVICE_CAP_POPULATION] : [])', replace: '...[]', fails: ['search'] },
  { name: 'the shipping-line pickup not bounded by the colony\'s people', file: U, find: 'const problem = batchProblem(\'colonistFloor.civilian\', { workers, batch })', replace: 'const problem = batch.state === \'ok\' ? null : batchProblem(\'colonistFloor.civilian\', { workers, batch })', fails: ['pool'] },
  { name: 'the present support counting the deliveries on their way', file: U, find: 'infrastructureCapResult(infrastructureOf(colony, null), rate)', replace: 'colony.r.cap', fails: ['panel'] },
  { name: 'a batch leaving more people than the built infrastructure supports not flagged', file: V, find: 'unsupportedAfter: outcome !== null && supportNow !== null && outcome.remaining > supportNow + 1e-9,', replace: 'unsupportedAfter: false,', fails: ['panel'] },
  { name: 'the colonies over the limit not counted in the headline', file: V, find: 'const over = known.filter((item) => this.batch.value > item.removable + 1e-9).length', replace: 'const over = 0', fails: ['panel'] },
  { name: 'the built support shown without its mark', file: V, at: /(data-colonist-support[^>]*>[^<]*)<provenance-mark\b[^>]*\/>/, to: (m) => m[1], fails: ['panel-template'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// The same planted faults on the source with every benign edit applied.
const COMPOSED = MUTATIONS.map((mutation, index) => ({ id: `composed:${index}`, ...mutation }))

// Edits that must change nothing the checks look at: the headline reworded, whitespace before an equals sign and a reordered list of attributes on the page's mount and on a marked cell, the summary reworded or shortened, another or no default sort column, and the mount's bound values written another way. Each is located by its structure (the attribute, the key or the state it belongs to and its whole value, with any spacing around `=` and either quote), never by what it holds now, so it still applies after a rewording, another default or another edit of the list.
const QUOTED = '"[^"]*"|\'[^\']*\''
const attribute = (name) => new RegExp(`(?<=\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(${QUOTED})`)
const valueOf = (quoted) => quoted.slice(1, -1)
const quote = (text) => (text.includes('"') ? `'${text}'` : `"${text}"`)

// The attributes inside a start tag, as name and whole value, put in the opposite order and written out again.
const ATTRIBUTES = new RegExp(`([^\\s=]+)(?:\\s*=\\s*(${QUOTED}))?`, 'g')
const reversed = (inside) => [...inside.matchAll(ATTRIBUTES)].reverse().map(([, name, value]) => (value === undefined ? name : `${name}=${value}`)).join(' ')
const STRING = '\'[^\']*\'|"[^"]*"|`[^`]*`'
const SLOT_POOL = '<template\\s+#\\[`item\\.pool`\\]\\s*=\\s*"[^"]*"\\s*>'

const BENIGN = [
  { name: 'the headline of a blank batch reworded', file: V, at: new RegExp(`(state\\s*===\\s*'blank'\\s*\\)\\s*\\{\\s*return\\s+)(?:${STRING})`), to: (m) => `${m[1]}'Nothing is entered as a batch'` },
  { name: 'the headline of an invalid batch reworded', file: V, at: new RegExp(`(state\\s*===\\s*'invalid'\\s*\\)\\s*\\{\\s*return\\s+)(?:${STRING})`), to: (m) => `${m[1]}'The batch entered is not a figure'` },
  { name: 'the headline of a counted batch reworded', file: V, at: /(\$\{\s*over\s*\} of \$\{\s*known\s*\})[^$`]*/, to: (m) => `${m[1]} colonies that would lose too many people` },
  { name: 'the summary reworded', file: V, at: attribute('data-summary'), to: () => 'data-summary="Colonist batches weighed against what staffing needs and a retained floor, with the shortage and the emigrants that are left."' },
  { name: 'the summary shortened to one sentence', file: V, at: attribute('data-summary'), to: () => 'data-summary="Compare colonist batches with staffing needs and a retained population floor."' },
  { name: 'whitespace around the equals sign of a bound property on the mount', file: P, at: attribute(':sources'), to: (m) => `:sources  =  ${m[1]}` },
  { name: 'the attributes of the mount reordered', file: P, at: /(<colonist-floor)([^>]*?)(\s*\/>)/, to: (m) => `${m[1]} ${reversed(m[2])}${m[3]}` },
  { name: 'whitespace in the mark of a figure cell', file: V, at: new RegExp(`(${SLOT_POOL}[\\s\\S]*?)<provenance-mark\\s+:result\\s*=\\s*(${QUOTED})\\s*/>`), to: (m) => `${m[1]}<provenance-mark  :result = ${m[2]}  />` },
  { name: 'the attributes of a figure cell reordered', file: V, at: new RegExp(`(${SLOT_POOL}\\s*<span)([^>]*)>`), to: (m) => `${m[1]} ${reversed(m[2])}>` },
  { name: 'the table sorted on another column to start with', file: V, at: /sortBy\s*:\s*\[[^\]]*\]/, to: () => "sortBy: ['population']" },
  { name: 'the table sorted on no column to start with', file: V, at: /sortBy\s*:\s*\[[^\]]*\]/, to: () => 'sortBy: []' },
  { name: 'the colonist sources given to the panel in parentheses', file: P, at: attribute(':sources'), to: (m) => `:sources=${quote(`(${valueOf(m[1])})`)}` },
  { name: 'the queue flag given to the panel as a negated negation', file: P, at: attribute(':committed-view'), to: (m) => `:committed-view=${quote(`!!${valueOf(m[1])}`)}` },
].map((edit, index) => ({ id: `benign:${index}`, ...edit }))

// The text to find and its replacement for a planted fault or a benign edit: the literal `find` and `replace`, or what the pattern `at` matches (exactly once) and `to` makes of the match.
const resolved = (edit, text) => {
  if (!edit.at) {
    return edit
  }

  const all = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags}g`))]

  if (all.length !== 1) {
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

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  return mutant ? applied(sources, mutant) : sources
}

// The real sources with every benign edit applied in turn.
const stackedSources = () => BENIGN.reduce((sources, edit) => applied(sources, edit), sourcesOf(null))

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const sourcesFor = changed(U) ? { 'colonist-floor': sources[U] } : {}
  const utilitySources = changed(U) ? { 'utilities/colonist-floor': sources[U] } : {}
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: sourcesFor })
  const options = await loadPage('components/colonies/ColonistFloor', { stubs: STUBS, modules: { 'mixins/persisted-view': RECORDER }, sources: { 'components/colonies/ColonistFloor': sources[V], ...utilitySources } })
  const persisted = globalThis.__persistedFields
  const pageSources = { 'pages/colony-outlook': sources[P], ...utilitySources }
  const pageOptions = await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB }, sources: pageSources })
  const livePageOptions = await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/load-state': null }, sources: pageSources })

  return { m: { cf: loaded['colonist-floor'], col: loaded.colonies, provenance: loaded.provenance }, options, persisted, pageOptions, livePageOptions, componentText: sources[V], pageText: sources[P] }
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
  const statements = [...pure(ctx), ...panel(ctx), ...page(ctx), ...optional(ctx)]
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

  console.log('\nColonist floor: the people a colony can give up before it cannot staff its installations or falls below a floor, on colonies worked by hand, the panel, the page and the saves')

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

  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const { statements } = await statementsOf(ctx, false)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, required)
  const missed = required.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  check(label, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// An edit that changes no behaviour (wording, whitespace, the order of attributes) leaves every check that needs no save green: the checks look at what the sources do, not at how they are written.
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
  const extra = options.saves ? [] : ['--no-saves']
  const stacked = options.mutations ? ['stacked'] : []
  const composed = options.mutations ? COMPOSED : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...[...wanted, ...benign, ...composed].map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 })), ...stacked.map((id) => ({ args: ['--part', id, ...extra], weight: 5 }))])
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
