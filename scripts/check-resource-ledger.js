/*
  Checks the local reserves and the timed resource ledger (src/renderer/utilities/resource-ledger.js, resource-reserves.js and resource-feeds.js, the mixin src/renderer/mixins/resource-reserves.js, the panel src/renderer/components/logistics/ResourceReserves.vue and its mounts in src/renderer/pages/logistics.vue and hauling.vue).

  bun scripts/check-resource-ledger.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=head,mutant:N[,...]]

  Everything runs on in-memory scenario stores, the real scenario repository and a fake save that records the SQL it is sent. Groups:
  - stock: one stock over the days, a withdrawal takes only what the stock holds above the reserve and the shortfall says whether the stock or the reserve is the cause;
  - tick: a delivery counts on the tick that ends on or after its day, the tick of the maintenance supply ledger (proved against its own run), one with no time or after the period is listed apart and never counted;
  - combined: the scenarios of one source spend its stock once, in a stated order, a shortfall that is not there alone is named as a competing one with the scenarios that took the stock or the reserve first, the production of a source (the maintenance facilities on Duranium, Uridium and Gallicite, the refineries on Sorium at 1 t for 2,000 L) draws on the same mineral stocks as the planned withdrawals, after them, so a withdrawal of an input on the tick of a shortfall is no rival of it and one before is, a production whose rate cannot be worked out is listed on the stocks it would draw on as not known, and a destination of a counted haul is a source the table lists;
  - haul: all stocks run in one causal pass, a haul credits its destination with what its source gave at departure and no earlier than the tick after, a chain works through in order, a same-day chain or cycle moves nothing on and conserves stock, a shortfall an upstream scenario caused through a haul is competing and a reserve upstream is a rival only above the reserve the short scenario keeps there, and a haul no freighter carries moves nothing at either end;
  - shortfall: every shortfall names the day, the resource, the source and the withdrawal that caused it, with the amounts;
  - plan: the Hauling plan's own draws count with the records and are left out when the plan is not counted;
  - zero: a reserve of 0 is kept, read and shown as a reserve of nothing, and is told apart from none set;
  - minimums: the game minimum, the class minimum and the player reserve are three figures; a colony has no game minimum of fuel or supplies and nothing is shown for it; a mineral has no class minimum;
  - feeds: the stock, production, packets and hauls each feed carries, from rows worked by hand;
  - history: the backup of the history page registers the reserve adapter, so a restore in a session that never opened the Logistics page keeps the records;
  - record: a record is kept per colony and scenario, survives a reload of the store and a switch of race, is held to its colony only by the player's confirmation, is refused for another colony of the same name or an ID given again, and is edited, shared, moved to the save and deleted over its revision;
  - loaders: every statement is a select and a read that fails fails the whole read;
  - component: the panel's template, the three minimums and the notes of the template that the data decides, a class minimum that some classes do not record shown as at least the figure, production and an export of an input on one stock from either panel and from the Hauling page's rows, which carry no supply column (the panel reads the colonies' supplies and production rates itself for minerals, waits on both and names a failure of either), a production not known listed as not known and never as covered, its form and its writes, and its states while a read is out or failed;
  - page: the Logistics and Hauling pages rendered with state they are given: the panel's mount is there in its own view only, with the props the page hands it evaluated, and the view the Logistics page keeps;
  - voice: nothing the panel and its utilities say to the player is in the first or second person;
  - browser: what the panel draws, read from the real app in Chromium (scripts/lib/reserve-screen.js): the mounts of both pages, the buttons pressed, and fixtures of the panel mounted in the page whose cells (stock, the three minimums, the lowest balance, the status chips, the run, the timeline, the shortfalls, the summary) are read as the text drawn and whether each is on screen, and compared with the numbers the ledger holds: each quantity from the element that draws it, by its role, read as a signed number in the grouping of the page's setting and at the precision the page shows. The state of a minimum cell and the message of a write are read from what they draw too, a word read back through the panel's own words for it (`minimumWords`, `saveWords`), beside the hook that names them. No virtual node is read and no text is taken from a container for its figures. The screen is read by the shared readers of scripts/lib/browser-observe.js (`visible`, `visibleText`, `hooked`, `readFigure`, `rounded`, `rolesRead`, `pairedBy`, `labelKey`), which scripts/check-browser-observe.js checks, the 90 texts of the page's formatter among them.

  Each planted fault must fail, by an assertion on a value and not by a call that threw, a check that it names: a fault whose named checks fail only by a call that threw is a defect of the harness (scripts/lib/fault-credit.js `caughtBy`), which fails that variant by name and ends the run with status 2. A planted fault that is caught by what the browser reads may name the parts of the screen it is read in (`parts`), the parts its checks read; every equivalent rewrite reads the whole screen. The head and the variants run through scripts/lib/suite-runner.js, one after another in a worker that starts one page server and one browser for them all and warms it first, with a deadline for each variant, a record that --resume continues, and the control that runs a planted fault and then the head on the same server (`control:warm-reset`); --detail lists the failed checks of a variant, and --variants=mutant:N runs one (mutant:N,mutant:M runs several, one after another in one worker, as the full run does). Exit code 1 when a check fails, 2 on a defect of the harness.
*/
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')
const sqlite3 = require('sqlite3')
const { assert, failure, through, harnessStore, boundary, subjectModule, runChecks, judged, caughtBy, infrastructureFailure } = require('./lib/fault-credit')
const { validate, failedObservation, failureLine, report, HarnessError, readFigure, rounded, rolesRead, pairedBy, labelKey } = require('./lib/browser-observe')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, loadModule, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { runSuite, runnerArgs } = require('./lib/suite-runner')

const root = path.resolve(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const FILES = {
  ledger: path.join(renderer, 'utilities', 'resource-ledger.js'),
  reserves: path.join(renderer, 'utilities', 'resource-reserves.js'),
  feeds: path.join(renderer, 'utilities', 'resource-feeds.js'),
  mixin: path.join(renderer, 'mixins', 'resource-reserves.js'),
  component: path.join(renderer, 'components', 'logistics', 'ResourceReserves.vue'),
  logistics: path.join(renderer, 'pages', 'logistics.vue'),
  hauling: path.join(renderer, 'pages', 'hauling.vue'),
  history: path.join(renderer, 'pages', 'history.vue'),
}
const UTILITY_NAMES = { ledger: 'resource-ledger', reserves: 'resource-reserves', feeds: 'resource-feeds' }
const NAMES = ['resource-ledger', 'resource-reserves', 'resource-feeds', 'scenario-records', 'provenance', 'msp-supply', 'minerals', 'logistics', 'load-tracking']

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "", primary: "" }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'
// The scenario records of a page as a module of their own, so the adapters one page registers with them are not the registry of another loaded from the same text.
const recordsOf = (tag) => ({ 'utilities/scenario-records': `${fs.readFileSync(path.join(renderer, 'utilities', 'scenario-records.js'), 'utf8')}\n// ${tag}\n` })
// The persisted view stood in by a module that records the fields a page declares, for a check of the view the page keeps.
const RECORDER = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults, table: true }); export default (fields) => { globalThis.__persistedFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'
const LOAD_STATE_STUB = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
// The planner of the hauls stood in by one that times a trip from the three things the Hauling page hands it, so the days it returns say which of them were passed: a trip takes the class's days, the shuttle technology's extra days and the formula version, one hold at a time.
const HAUL_PLAN_STUB = "export const HAUL_REASONS = {}; export const planHauls = () => ({ hauls: [], unmet: [] }); export const haulByClass = (haul, shipClass, shuttleTechnology, version) => ({ status: 'ok', holds: 2, tripDays: shipClass.days + shuttleTechnology.extra + version })"
const CAMPAIGN = { campaignId: 'c1', branchId: 'b1' }
const STORE = { getters: { 'history/campaign': CAMPAIGN, GameTime: 100000 }, state: { history: { revision: 0 } }, dispatch: async () => {} }
// The store the page is given is the harness's: a read of it or a call into it that fails stops the run, where the page's own code runs behind the boundary of scripts/lib/fault-credit.js and what it throws is a failure of the check.
const PAGE_STORE = harnessStore(STORE, { 'history/campaign': ['object'], GameTime: ['number'] })
const GAME = 1
const RACE = 7

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

// What a read the page made rejected with, as the database that failed gave it: the adapter of the page's own code (scripts/lib/fault-credit.js) keeps what the call threw in `original`.
const rejection = (error) => String((error && error.original ? error.original : error).message)

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const descriptorOf = (source) => {
  const parsed = require('vue/compiler-sfc').parse({ source })

  return parsed.descriptor || parsed
}

const compiled = (source) => require('vue/compiler-sfc').compileTemplate({ source: descriptorOf(source).template.content, filename: 'component.vue', id: 'component' })

const templateAst = (source) => compiled(source).ast

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

const scriptOf = (source) => descriptorOf(source).script.content

// The string and template literals of a script, which is what the player can read of it.
const stringsOf = (script) => [...acorn.tokenizer(script, { ecmaVersion: 'latest', sourceType: 'module' })].filter((token) => token.type.label === 'string' || token.type.label === 'template').map((token) => String(token.value))

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i

// ---------- the fixtures ----------

const memory = () => {
  const files = new Map()
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
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

  return { files, storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => ({}), writable: () => Promise.resolve(true) } }
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const world = (m, inst = memory()) => {
  const registry = m.records.createAdapterRegistry()
  let clock = 1000
  let ids = 0

  m.rr.registerResourceReserves(registry.register)

  const make = () => m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock })

  return { inst, registry, make, repo: make() }
}

const scope = (branchId = 'b1', RaceID = RACE, campaignId = 'c1', gameTime = 100000) => ({ campaignId, RaceID, branchId, gameTime })

// The branches of the campaign c1 as the registry holds them.
const TREE = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 } }

const colony = (id, name, systemId, bodyId, speciesId = 7) => ({ id, name, systemId, bodyId, speciesId })

const SAVE = () => ({ systems: [{ id: 1, name: 'Sol' }, { id: 2, name: 'Alpha Centauri' }], colonies: [colony(10, 'Earth Prime', 1, 100), colony(11, 'Proxima Base', 2, 200)], classes: [{ id: 5, name: 'Tanker', fuel: 5000, supplies: 0, ships: 3 }, { id: 6, name: 'Escort', fuel: 100, supplies: null, ships: 1 }] })

const edited = (save, change) => {
  const copy = clone(save)

  change(copy)

  return copy
}

// `failing` names a fragment of SQL that makes the fake throw, as a save that lacks a table does. The fake answers by the table the SQL names and records everything it is sent.
const fakeSave = (save, { failing = [] } = {}) => {
  const sent = []
  const named = (id) => (save.systems.find((row) => row.id === id) || { name: null }).name

  return {
    sent,
    query: async (sql, options = {}) => {
      sent.push({ sql, replacements: options.replacements })

      const failed = failing.find((fragment) => sql.includes(fragment))

      if (failed) {
        throw new Error(`no such table: ${failed}`)
      }

      if (sql.includes('from FCT_ShipClass')) {
        return [save.classes.map((row) => ({ ShipClassID: row.id, ClassName: row.name, MinimumFuel: row.fuel, MinimumSupplies: row.supplies, Ships: row.ships }))]
      }

      if (sql.includes('FCT_Population.MaintenanceStockpile')) {
        return [save.supply || []]
      }

      if (sql.includes('from FCT_Population')) {
        return [save.colonies.map((row) => ({ PopulationID: row.id, PopName: row.name, SpeciesID: row.speciesId, SystemID: row.systemId, SystemBodyID: row.bodyId, SystemName: named(row.systemId) }))]
      }

      throw new Error(`the fake save does not answer ${sql}`)
    },
  }
}

// The colonies of an open save as the panel hands them to the records, with the campaign and branch the save is open on.
const open = async (m, save, where = scope(), { branches = TREE, failing = [] } = {}) => {
  const database = fakeSave(save, { failing })
  const loaded = await m.rr.loadReserveObjects(database, { GameID: GAME, RaceID: where.RaceID })

  return { ...loaded, campaignId: where.campaignId, branchId: where.branchId, branches, database }
}

const colonyOf = (context, id) => ({ type: 'colony', row: context.objects.colony.get(id) })

const plan = (id, label, amount, day, resource = 'Duranium', kind = 'withdraw') => ({ id, label, resource, kind, amount, day })

const keep = (m, w, where, context, { colonyId = 10, scenario = 'Alpha', resources = ['Duranium'], reserves = {}, plans = [], note = '', ...extra } = {}) => m.rr.saveReserve(w.repo, where, { source: colonyOf(context, colonyId), scenario, resources, reserves, plans, note, context, ...extra })

const kept = async (m, w, where, context, options = {}) => {
  const outcome = await keep(m, w, where, context, options)

  assert.equal(outcome.ok, true, outcome.message)

  return outcome.record
}

const readOn = async (m, w, save, where = scope(), options = {}) => {
  const context = await open(m, save, where, options)

  return { context, read: m.rr.readReserves(w.repo, where, context) }
}

// ---------- the ledger's inputs ----------

const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']

const noMinimum = () => ({ game: { applies: true, value: 250, why: '' }, class: { applies: false, value: null, why: 'A ship class has no mineral minimum.' } })

const feed = (extra = {}) => ({ key: '1:Duranium', sourceId: 1, sourceName: 'Earth', place: 'Sol', resource: 'Duranium', stock: 100, production: null, productionLasts: null, arrivals: [], withdrawals: [], minimums: noMinimum(), ...extra })

const entry = (scenario, plans = [], reserves = {}, sourceId = 1) => ({ uuid: `u-${scenario}`, scenario, sourceId, reserves, plans })

const rowsOf = (ledger, key = '1:Duranium') => ledger.rows.find((row) => row.key === key)

const planned = (day, amount, id = 'haul:h1:Duranium') => ({ id, label: 'Haul to Mars', scenario: 'Hauling plan', day, amount })

// A colony row as the pages read it: every mineral stock and reserve, and what the supply ledger needs.
const colonyRow = (id, name, extra = {}) => ({ PopulationID: id, PopName: name, SystemName: 'Sol', ...Object.fromEntries(MINERAL_NAMES.flatMap((mineral) => [[mineral, 0], [`Reserve${mineral}`, 0]])), ...extra })

// ---------- the table the player reads ----------

const stockRows = (extra = {}) => [colonyRow(10, 'Earth Prime', { Duranium: 1000, ReserveDuranium: 250, FuelStockpile: 5000, MaintenanceStockpile: 200, ...extra })]

// The Hauling page's colony rows hold the minerals and reserves, the position and the services and none of the supply columns; the supplies come from the panel's own read of the save.
const haulingRow = () => {
  const row = Object.fromEntries(Object.entries(colonyRow(10, 'Earth Prime', { Duranium: 10, Uridium: 1000, Gallicite: 1000 })).filter(([name]) => name !== 'SystemName'))

  return { ...row, SystemID: 1, MassDriverDest: 0, Xcor: 0, Ycor: 0, ShuttleCapacity: 0, ServiceNames: '', MassDrivers: 0 }
}

const supplyRowOf = (m, extra = {}) => ({ PopulationID: 10, PopName: 'Earth Prime', MaintenanceStockpile: 0, MaintProdStatus: 1, FuelStockpile: 0, FuelProdStatus: 1, Sorium: 0, Duranium: 10, Uridium: 1000, Gallicite: 1000, MSPProduction: 1, FuelProduction: 0, MaintenanceFacilities: 365 / m.lg.mspProduction({ MaintenanceFacilities: 1, MSPProduction: 1 }, 1).value, Refineries: 0, ...extra })

// The panel as a host gives it its props, over a repository and the colonies of a save: loaded the way the reads of the mixin load them. `loaded` is what those reads gave, which a mount in the browser is given as it is.
const mountPanel = async (ctx, { kind = 'supplies', colonies = [], w = world(ctx.m), save = SAVE(), where = scope(), failing = [], supply = [], data = {} } = {}) => {
  const { m, options } = ctx
  const database = fakeSave({ ...save, supply }, { failing })
  const objects = failing.length ? null : await m.rr.loadReserveObjects(database, { GameID: GAME, RaceID: where.RaceID })
  const classes = failing.length ? [] : await m.rf.loadClassMinimums(database, { GameID: GAME, RaceID: where.RaceID })
  const supplies = kind === 'minerals' && !failing.length ? Object.freeze({ colonies: await m.rf.loadSupplyState(database, { GameID: GAME, RaceID: where.RaceID }), database, GameID: GAME, RaceID: where.RaceID }) : null
  const vm = instantiate(options, { boundary, $store: PAGE_STORE, database, GameID: GAME, RaceID: where.RaceID, data: { ...BASE_DATA, kind, colonies, reserveRecords: Object.freeze({ repository: w.repo, error: null }), reserveObjects: objects && Object.freeze({ ...objects, database }), reserveClasses: Object.freeze({ classes, database, GameID: GAME, RaceID: where.RaceID }), reservePackets: Object.freeze({ packets: [], database, GameID: GAME, RaceID: where.RaceID }), reserveSupply: supplies, populationProductionModifiers: {}, loadErrors: { reserveObjects: null, reserveClasses: null, reservePackets: null, reserveSupply: null, populationProductionModifiers: null }, ...data } })

  return { vm, w, database, loaded: { objects, classes, supplies } }
}

const recordOf = (record) => ({ colonyId: 10, scenario: 'Alpha', resources: ['Duranium'], reserves: {}, plans: [], note: '', ...record })

// A haul of Duranium from Earth Prime to Proxima Base that takes `days` (null when no freighter class carries it), with a reserve of 50 kept at the source.
const hauled = (days, tonnes) => {
  const from = colonyRow(10, 'Earth Prime', { Duranium: 100, ReserveDuranium: 0 })
  const to = colonyRow(11, 'Proxima Base', { Duranium: 0 })
  const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes }] }], unmet: [] }

  return { kind: 'minerals', colonies: [from, to], plan: hauls, timed: [{ haul: hauls.hauls[0], days, why: days === null ? 'no freighter class can carry it' : null }], records: [{ colonyId: 10, scenario: 'Alpha', reserves: { Duranium: 50 } }], expand: ['10:Duranium', '11:Duranium'] }
}

// The minerals panel as the Hauling page hands it its colony, over the supplies and the production rates the panel reads itself.
const surfaced = (m, { records = [], modifiers = true, supplyExtra = {}, showAll = false, expand = ['10:Duranium'] } = {}) => ({ kind: 'minerals', colonies: [haulingRow()], supply: [supplyRowOf(m, supplyExtra)], modifiers: modifiers ? { 10: { OverallProductionModifier: 1 } } : {}, showAll, records, expand })

const USE_RECORDS = [{ scenario: 'Beta', resources: ['msp'], plans: [plan('p1', 'Use', 95, 101, 'msp')] }, { scenario: 'Watch', resources: ['Duranium'], reserves: { Duranium: 1 } }]

// The states the table of the panel is read in, one panel each: the data they hold, and the record they keep, and the rows to open. The same fixture is mounted by the node (the data the table shows, which every figure it must show is worked from) and by the page (the table as the player sees it).
// The figures of the rows of two fixtures, worked by hand from what the fixture holds: the stock, the game minimum, the player reserve and the lowest balance of a row that has no flow.
const HAND = { minerals: { '10:Duranium': { stock: 1000, game: 250, player: 0, lowest: 1000 } }, below: { '10:Duranium': { stock: 100, player: 500, lowest: 100 } }, lateHaul: { '10:Duranium': { run: { start: 100, final: 50, days: 365 } } }, sameStock: { '10:Duranium': { events: { p1: { label: 'Consume', scenario: 'Alpha' }, p2: { label: 'Consume', scenario: 'Beta' } } }, shortfalls: { p1: { resource: 'Duranium', colony: 'Earth Prime', label: 'Consume', scenario: 'Alpha' }, p2: { resource: 'Duranium', colony: 'Earth Prime', label: 'Consume', scenario: 'Beta' } } } }

const CELL_FIXTURES = {
  minerals: () => ({ kind: 'minerals', colonies: [colonyRow(10, 'Earth Prime', { Duranium: 1000, ReserveDuranium: 250, ReserveUridium: null })], showAll: true, records: [{ colonyId: 10, reserves: { Duranium: 0 } }], expand: ['10:Duranium'] }),
  supplies: () => ({ kind: 'supplies', colonies: stockRows({ WarningFuel: 4000, WarningMSP: 300, FuelProdStatus: 0, MaintProdStatus: 0 }), showAll: true, records: [], expand: ['10:fuel', '10:msp'] }),
  // Two withdrawals of one stock with one label, each of its own scenario, both of which find the stock short.
  sameStock: () => ({ kind: 'minerals', colonies: [colonyRow(10, 'Earth Prime', { Duranium: 20, ReserveDuranium: 0 })], showAll: true, records: [{ colonyId: 10, scenario: 'Alpha', plans: [plan('p1', 'Consume', 30, 1)] }, { colonyId: 10, scenario: 'Beta', plans: [plan('p2', 'Consume', 50, 2)] }], expand: ['10:Duranium'] }),
  below: () => ({ kind: 'minerals', colonies: [colonyRow(10, 'Earth Prime', { Duranium: 100, Corbomite: null })], showAll: true, records: [{ colonyId: 10, reserves: { Duranium: 500 } }], expand: ['10:Duranium'] }),
  looseHaul: () => hauled(null, 100),
  lateHaul: () => hauled(5, 100),
  spareHaul: () => hauled(5, 40),
  shortInput: (m) => surfaced(m, { records: [{ scenario: 'Late', resources: ['Duranium'], plans: [plan('p1', 'Ship', 10, 101, 'Duranium')] }], supplyExtra: { MaintenanceStockpile: null } }),
  unknownUse: (m) => surfaced(m, { records: USE_RECORDS, modifiers: false, showAll: true }),
  knownUse: (m) => surfaced(m, { records: USE_RECORDS, showAll: true }),
  waitingSupplies: () => ({ kind: 'supplies', colonies: [], waiting: true, records: [], expand: [] }),
  waitingMinerals: () => ({ kind: 'minerals', colonies: [], waiting: true, records: [], expand: [] }),
  embeddedMinerals: () => ({ kind: 'minerals', colonies: stockRows(), embedded: true, showAll: true, records: [], expand: [] }),
}

// The same fixture of minerals under each of the other settings of the thousands separator, as the page's own mount writes it: the quantities are read back in every grouping.
for (const setting of ['Comma', 'Dash', 'Space', 'None']) {
  CELL_FIXTURES[`minerals${setting}`] = (m) => ({ ...CELL_FIXTURES.minerals(m), setting })
  HAND[`minerals${setting}`] = HAND.minerals
}

const FIXTURE_NAMES = Object.keys(CELL_FIXTURES)

// The node's own mount of a fixture, with its records kept, once for each context.
const oracleOf = (ctx, name) => {
  ctx.oracles = ctx.oracles || {}

  if (!ctx.oracles[name]) {
    ctx.oracles[name] = (async () => {
      const fx = CELL_FIXTURES[name](ctx.m)
      const mounted = await mountPanel(ctx, { kind: fx.kind, colonies: fx.colonies, supply: fx.supply || [], data: { ...(fx.plan ? { plan: fx.plan, timed: fx.timed } : {}), ...(fx.modifiers ? { populationProductionModifiers: fx.modifiers } : {}), ...(fx.showAll ? { showAll: true } : {}), ...(fx.embedded ? { embedded: true } : {}), ...(fx.waiting ? { reserveObjects: null, loadErrors: {} } : {}) } })

      for (const record of fx.records) {
        await kept(ctx.m, mounted.w, scope(), mounted.vm.reserveContext, recordOf(record))
      }

      mounted.vm.reservesChanged()

      return { ...mounted, fx }
    })()
  }

  return ctx.oracles[name]
}

// What the page mounts of a fixture: its colonies and plan, the reads the node made for it (as the page is given them) and the records it keeps.
const specOf = async (ctx, name) => {
  const { fx, loaded } = await oracleOf(ctx, name)

  return { name, kind: fx.kind, colonies: fx.colonies, plan: fx.plan || null, timed: fx.timed || null, showAll: Boolean(fx.showAll), embedded: Boolean(fx.embedded), setting: fx.setting || null, waiting: Boolean(fx.waiting), modifiers: fx.modifiers || {}, supply: loaded.supplies ? loaded.supplies.colonies : null, packets: [], classes: loaded.classes, colonyEntries: loaded.objects ? [...loaded.objects.objects.colony.entries()] : [], records: fx.records.map(recordOf), expand: fx.expand }
}

// ---------- the statements ----------

const ledger = (ctx) => {
  const { m } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const run = (options) => m.rl.combinedLedger({ days: 365, ...options })

  // ---- stock ----
  add('stock: a withdrawal takes only what the stock holds above the reserve, and the shortfall names the reserve as the cause', () => {
    const result = m.rl.runStock({ stock: 100, reserve: 30, withdrawals: [{ id: 'w', label: 'Build', scenario: 'A', day: 5, amount: 80 }], days: 365 })
    const short0 = result.shortfalls[0]

    return result.known && result.final === 30 && result.taken === 70 && result.shortfalls.length === 1 && near(short0.short, 10) && short0.reason === 'reserve' && short0.step === 5 && short0.before === 100 && short0.reserve === 30 ? true : short(result)
  })
  add('stock: a withdrawal the stock itself cannot meet names the stock as the cause', () => {
    const result = m.rl.runStock({ stock: 20, reserve: 0, withdrawals: [{ id: 'w', label: 'Build', scenario: 'A', day: 5, amount: 80 }], days: 365 })

    return result.shortfalls.length === 1 && result.shortfalls[0].reason === 'stock' && near(result.shortfalls[0].short, 60) && result.final === 0 ? true : short(result)
  })
  add('stock: a stock that is not in the save has no run and no figure', () => {
    const none = m.rl.runStock({ stock: null, withdrawals: [], days: 365 })
    const negative = m.rl.runStock({ stock: -1, withdrawals: [], days: 365 })

    return none.known === false && negative.known === false && typeof none.reason === 'string' ? true : short([none, negative])
  })
  add('stock: production is credited a day at a time and stops when its input runs out', () => {
    const whole = m.rl.runStock({ stock: 0, production: 365, days: 100 })
    const stopped = m.rl.runStock({ stock: 0, production: 365, productionLasts: 40, days: 100 })

    return near(whole.final, 100) && near(stopped.final, 40) && near(stopped.produced, 40) && whole.residual < 1e-9 ? true : short([whole.final, stopped.final])
  })
  add('stock: the run balances: start and what came in, less what went out, is the end', () => {
    const result = m.rl.runStock({ stock: 100, production: 73, arrivals: [{ id: 'a', day: 10, amount: 40 }], withdrawals: [{ id: 'w', day: 20, amount: 500 }], reserve: 10, days: 100 })

    return result.residual < 1e-9 && result.known ? true : short(result)
  })

  // ---- tick ----
  add('tick: a delivery counts on the tick that ends on or after its day, a day of 0 on the first', () => {
    const at = (day) => m.rl.runStock({ stock: 0, arrivals: [{ id: 'a', label: 'Packet', day, amount: 10 }], days: 365 }).events.map((event) => event.step)[0]

    return same([at(0), at(2.5), at(3), at(3.0000001), at(364.9999999)], [1, 3, 3, 4, 365])
  })
  add('tick: the day counted is the day of the maintenance supply ledger for every day it is asked on', () => {
    const zero = Object.fromEntries(MINERAL_NAMES.map((name) => [name, 0]))
    const days = [0, 0.4, 1, 1.0000000001, 2.2, 30, 90.9999999999, 91, 364.5, 365, 365.5, 400]
    const results = days.map((day) => {
      const simulated = m.ms.simulate({ production: 0, stock: zero, inflows: [{ group: 'g', kind: 'packets', mineral: 'Duranium', tonnes: 1, day }], days: 365 })
      const theirs = simulated.windows.g ? simulated.windows.g.first : null
      const mine = m.rl.tickOf(day) <= 365 ? m.rl.tickOf(day) : null

      return theirs === mine ? true : [day, theirs, mine]
    })

    return results.every((result) => result === true) ? true : short(results.filter((result) => result !== true))
  })
  add('tick: a delivery on the same tick as a withdrawal arrives first', () => {
    const result = m.rl.runStock({ stock: 0, arrivals: [{ id: 'a', day: 3, amount: 50 }], withdrawals: [{ id: 'w', label: 'Build', scenario: 'A', day: 3, amount: 50 }], days: 365 })

    return result.shortfalls.length === 0 && result.final === 0 ? true : short(result)
  })
  add('tick: a delivery with no time, one after the period and an invalid one are listed apart and never counted', () => {
    const result = m.rl.runStock({ stock: 0, arrivals: [{ id: 'u', label: 'No time', day: null, amount: 10 }, { id: 'l', label: 'Late', day: 400, amount: 20 }, { id: 'n', label: 'Negative', day: -3, amount: 5 }, { id: 'z', label: 'Empty', day: 5, amount: 0 }], withdrawals: [{ id: 'b', label: 'After', day: 500, amount: 5 }], days: 365 })

    return result.final === 0 && result.arrived === 0 && result.untimed.length === 1 && result.late.length === 1 && result.skipped.length === 2 && result.beyond.length === 1 ? true : short(result)
  })

  // ---- combined ----
  add('combined: two scenarios withdrawing from one source spend its stock once, and the later one is short', () => {
    const both = run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Build A', 70, 10)]), entry('Beta', [plan('p1', 'Build B', 70, 20)])] })
    const row = rowsOf(both)

    return row.run.final === 0 && row.run.taken === 100 && both.shortfalls.length === 1 && near(both.shortfalls[0].short, 40) && both.shortfalls[0].withdrawal.scenario === 'Beta' ? true : short(both.shortfalls)
  })
  add('combined: each scenario alone is covered, so the shortfall is named as a competing one with the scenario that took the stock first', () => {
    const alpha = entry('Alpha', [plan('p1', 'Build A', 70, 10)])
    const beta = entry('Beta', [plan('p1', 'Build B', 70, 20)])
    const alone = ['Alpha', 'Beta'].map((name) => run({ feeds: [feed()], entries: [alpha, beta], scenarios: [name] }).shortfalls.length)
    const both = run({ feeds: [feed()], entries: [alpha, beta] })

    return same(alone, [0, 0]) === true && both.conflicts.length === 1 && both.shortfalls[0].kind === 'competing' && same(both.shortfalls[0].rivals.drew, ['Alpha']) === true ? true : short([alone, both.conflicts])
  })
  add('combined: a scenario short on its own is named as its own shortfall, with no rival', () => {
    const result = run({ feeds: [feed({ stock: 30 })], entries: [entry('Alpha', [plan('p1', 'Build A', 70, 10)])] })

    return result.shortfalls.length === 1 && result.shortfalls[0].kind === 'own' && result.conflicts.length === 0 && same(result.shortfalls[0].rivals, { drew: [], reserved: [] }) === true ? true : short(result.shortfalls)
  })
  add('combined: a larger reserve of another scenario holds back what a withdrawal wanted, and names that scenario', () => {
    const result = run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Build A', 90, 3)]), entry('Beta', [], { Duranium: 50 })] })

    return result.shortfalls.length === 1 && result.shortfalls[0].reason === 'reserve' && result.shortfalls[0].kind === 'competing' && same(result.shortfalls[0].rivals.reserved, ['Beta']) === true && near(result.shortfalls[0].short, 40) ? true : short(result.shortfalls)
  })
  add('combined: the player reserve of a source is the largest reserve of the scenarios picked', () => {
    const entries = [entry('Alpha', [], { Duranium: 10 }), entry('Beta', [], { Duranium: 40 })]
    const both = rowsOf(run({ feeds: [feed()], entries })).minimums.player
    const alpha = rowsOf(run({ feeds: [feed()], entries, scenarios: ['Alpha'] })).minimums.player

    return both.value === 40 && alpha.value === 10 && both.by.length === 2 ? true : short([both, alpha])
  })
  add('combined: a withdrawal draws in the order of the scenario names, and again in that order whatever the order the records are given in', () => {
    const entries = [entry('Beta', [plan('p1', 'Build B', 70, 20)]), entry('Alpha', [plan('p1', 'Build A', 70, 20)])]
    const forward = run({ feeds: [feed()], entries })
    const backward = run({ feeds: [feed()], entries: [...entries].reverse() })

    return forward.shortfalls[0]?.withdrawal.scenario === 'Beta' && backward.shortfalls[0]?.withdrawal.scenario === 'Beta' ? true : short([forward.shortfalls, backward.shortfalls])
  })
  add('combined: a scenario not picked is left out, and every scenario counts when none is picked', () => {
    const entries = [entry('Alpha', [plan('p1', 'Build A', 70, 10)]), entry('Beta', [plan('p1', 'Build B', 70, 20)])]
    const none = run({ feeds: [feed()], entries, scenarios: [] })
    const beta = run({ feeds: [feed()], entries, scenarios: ['Beta'] })

    return none.shortfalls.length === 1 && beta.shortfalls.length === 0 && same(beta.scenarios, ['Beta']) === true && same(none.scenarios, ['Alpha', 'Beta']) === true ? true : short([none.shortfalls, beta.shortfalls])
  })
  add('combined: a refill is credited on its day and a withdrawal before it does not use it', () => {
    const entries = [entry('Alpha', [plan('p1', 'Build A', 80, 5), plan('p2', 'Top up', 60, 10, 'Duranium', 'refill'), plan('p3', 'Build B', 100, 20)])]
    const result = run({ feeds: [feed()], entries })

    return result.shortfalls.length === 1 && result.shortfalls[0].withdrawal.label === 'Build B' && near(result.shortfalls[0].held, 80) && near(result.shortfalls[0].short, 20) ? true : short(result.shortfalls)
  })
  add('combined: a line of a record for a source the save does not give is listed, not run', () => {
    const result = run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Build A', 10, 3)], {}, 99), entry('Beta', [], { fuel: 9 })], resources: ['Duranium'] })

    return result.unfed.length === 1 && result.unfed[0].sourceId === 99 && result.unfed[0].resource === 'Duranium' && result.shortfalls.length === 0 ? true : short(result.unfed)
  })

  // ---- shortfall ----
  add('shortfall: it names the day, the resource, the source and the withdrawal that caused it, with what was wanted, served and short', () => {
    const result = run({ feeds: [feed({ resource: 'Duranium', sourceName: 'Earth' })], entries: [entry('Alpha', [plan('p1', 'Build the yard', 300, 42)])] })
    const one = result.shortfalls[0]

    return one && one.step === 42 && one.day === 42 && one.resource === 'Duranium' && one.sourceName === 'Earth' && one.sourceId === 1 && one.withdrawal.label === 'Build the yard' && one.withdrawal.scenario === 'Alpha' && one.withdrawal.id === 'u-Alpha:p1' && one.wanted === 300 && one.served === 100 && one.short === 200 && one.held === 100 && typeof one.reason === 'string' ? true : short(one)
  })
  add('shortfall: a withdrawal on day 0 counts on the first day and is named with it', () => {
    const result = run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Now', 300, 0)])] })

    return result.shortfalls.length === 1 && result.shortfalls[0].step === 1 && result.shortfalls[0].day === 0 ? true : short(result.shortfalls)
  })
  add('shortfall: the shortfalls are listed in the order of their days', () => {
    const result = run({ feeds: [feed(), feed({ key: '1:Uridium', resource: 'Uridium' })], entries: [entry('Alpha', [plan('p1', 'Late', 300, 90, 'Duranium'), plan('p2', 'Early', 300, 9, 'Uridium')])] })

    return same(result.shortfalls.map((one) => [one.step, one.resource]), [[9, 'Uridium'], [90, 'Duranium']])
  })

  // ---- plan ----
  add('plan: the Hauling plan\'s own draw counts with the records of a scenario and takes the stock first when its day is first', () => {
    const result = run({ feeds: [feed({ withdrawals: [planned(0, 60)] })], entries: [entry('Alpha', [plan('p1', 'Build A', 70, 10)])] })
    const one = result.shortfalls[0]

    return result.shortfalls.length === 1 && one.withdrawal.scenario === 'Alpha' && near(one.short, 30) && one.reason === 'stock' && one.kind === 'competing' && same(one.rivals.drew, ['Hauling plan']) === true ? true : short(result.shortfalls)
  })
  add('plan: with the plan not counted its draws and its deliveries are left out', () => {
    const feeds = [feed({ withdrawals: [planned(0, 60)], arrivals: [{ id: 'h', label: 'Haul from Mars', scenario: 'Hauling plan', day: 5, amount: 30, source: 'haul' }, { id: 'p', label: 'Mass-driver packet', scenario: null, day: 6, amount: 15, source: 'packet' }] })]
    const counted = rowsOf(run({ feeds, entries: [], countPlan: true })).run
    const left = rowsOf(run({ feeds, entries: [], countPlan: false })).run

    return counted.taken === 60 && counted.arrived === 45 && left.taken === 0 && left.arrived === 15 ? true : short([counted.taken, counted.arrived, left.taken, left.arrived])
  })
  add('plan: no record may take the name of the plan, in any case', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const refused = await Promise.all(['Hauling plan', 'hauling PLAN', 'HAULING PLAN'].map((scenario) => keep(m, w, scope(), context, { scenario, reserves: { Duranium: 5 } })))

    return refused.every((outcome) => outcome.ok === false && outcome.code === 'invalid-reserve') ? true : short(refused)
  })

  // ---- zero ----
  add('zero: a reserve of 0 is recorded as a reserve of nothing, told apart from none set', () => {
    const zero = rowsOf(run({ feeds: [feed()], entries: [entry('Alpha', [], { Duranium: 0 })] })).minimums.player
    const none = rowsOf(run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Build', 10, 3)])] })).minimums.player

    return zero.recorded === true && zero.value === 0 && none.recorded === false && none.value === null ? true : short([zero, none])
  })
  add('zero: with a reserve of 0 the whole stock can be taken, as with none set', () => {
    const zero = run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Build', 100, 3)], { Duranium: 0 })] })

    return zero.shortfalls.length === 0 && rowsOf(zero).run.final === 0 ? true : short(zero.shortfalls)
  })
  add('zero: a record that keeps a reserve of 0 and nothing else is valid, is stored as 0 and reads back as 0', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const outcome = await keep(m, w, scope(), context, { reserves: { Duranium: 0 } })
    const read = m.rr.readReserves(w.repo, scope(), context)

    return outcome.ok === true && read.entries.length === 1 && read.entries[0].reserves.Duranium === 0 && same(m.rr.entriesForLedger(read.entries)[0].reserves, { Duranium: 0 }) === true ? true : short([outcome, read.entries])
  })
  add('zero: a record with a blank line keeps no reserve for it, and a negative or a non-number is refused', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const blank = await keep(m, w, scope(), context, { scenario: 'Blank', resources: ['Duranium', 'Uridium'], reserves: { Duranium: '', Uridium: 7 } })
    const negative = await keep(m, w, scope(), context, { scenario: 'Negative', reserves: { Duranium: -1 } })
    const word = await keep(m, w, scope(), context, { scenario: 'Word', reserves: { Duranium: Number.NaN } })
    const read = m.rr.readReserves(w.repo, scope(), context)
    const stored = read.entries.find((one) => one.scenario === 'Blank')

    return blank.ok === true && same(stored.reserves, { Uridium: 7 }) === true && negative.ok === false && word.ok === false ? true : short([blank, negative, word])
  })

  // ---- minimums ----
  add('minimums: the three are three figures of a row, and the row keeps each as it was given', () => {
    const feeds = [feed({ minimums: { game: { applies: true, value: 250, why: '' }, class: { applies: true, value: 5000, className: 'Tanker' } } })]
    const row = rowsOf(run({ feeds, entries: [entry('Alpha', [], { Duranium: 40 })] }))

    return row.minimums.game.value === 250 && row.minimums.class.value === 5000 && row.minimums.player.value === 40 && row.minimums.class.className === 'Tanker' ? true : short(row.minimums)
  })
  add('minimums: the player reserve is never folded into the game minimum or the other way round', () => {
    const noReserve = rowsOf(run({ feeds: [feed()], entries: [] })).minimums
    const reserved = rowsOf(run({ feeds: [feed()], entries: [entry('Alpha', [], { Duranium: 900 })] })).minimums

    return noReserve.player.recorded === false && noReserve.game.value === 250 && reserved.game.value === 250 && reserved.player.value === 900 ? true : short([noReserve, reserved])
  })
  add('minimums: a colony has no game minimum of fuel or of maintenance supplies, whatever its warning levels say', () => {
    const colonyFuel = { PopulationID: 1, WarningFuel: 4000, WarningMSP: 300, ReserveFuel: 9, MinimumFuel: 8 }
    const fuel = m.rf.gameMinimumOf(colonyFuel, 'fuel')
    const msp = m.rf.gameMinimumOf(colonyFuel, 'msp')

    return fuel.applies === false && fuel.value === null && msp.applies === false && msp.value === null && typeof fuel.why === 'string' && fuel.why !== '' ? true : short([fuel, msp])
  })
  add('minimums: a saved game minimum of a mineral is shown as saved, and a blank one is not recorded, never 0', () => {
    const saved = m.rf.gameMinimumOf(colonyRow(1, 'A', { ReserveDuranium: 250 }), 'Duranium')
    const zero = m.rf.gameMinimumOf(colonyRow(1, 'A', { ReserveDuranium: 0 }), 'Duranium')
    const blank = m.rf.gameMinimumOf(colonyRow(1, 'A', { ReserveDuranium: null }), 'Duranium')

    return saved.applies && saved.value === 250 && zero.applies && zero.value === 0 && blank.applies && blank.value === null && blank.why !== '' ? true : short([saved, zero, blank])
  })
  add('minimums: the class minimum is the largest of the classes with ships and names the class, and a mineral has none', () => {
    const classes = [{ ClassName: 'Tanker', MinimumFuel: 5000, MinimumSupplies: 0 }, { ClassName: 'Escort', MinimumFuel: 100, MinimumSupplies: null }]
    const fuel = m.rf.classMinimumOf(classes, 'fuel')
    const supplies = m.rf.classMinimumOf(classes, 'msp')
    const mineral = m.rf.classMinimumOf(classes, 'Duranium')
    const unread = m.rf.classMinimumOf(null, 'fuel')

    return fuel.value === 5000 && fuel.className === 'Tanker' && supplies.value === 0 && supplies.className === null && supplies.unknown === 1 && mineral.applies === false && mineral.value === null && unread.applies === true && unread.value === null ? true : short([fuel, supplies, mineral, unread])
  })

  // ---- feeds ----
  add('feeds: a fuel feed carries the stock, the refinery output and the days the Sorium lasts, and a feed the save does not give has no production', () => {
    const colonies = [colonyRow(1, 'Earth', { FuelStockpile: 5000, MaintenanceStockpile: 200, FuelProdStatus: 1, Refineries: 2, FuelProduction: 1000, Sorium: 500, MaintProdStatus: 0 }), colonyRow(2, 'Mars', { FuelStockpile: null, MaintenanceStockpile: null })]
    const feeds = m.rf.supplyFeeds({ colonies, modifierOf: (id) => (id === 1 ? 1 : null), place: () => 'Sol', classes: [] })
    const earth = feeds.find((one) => one.key === '1:fuel')
    const mars = feeds.find((one) => one.key === '2:fuel')
    const marsMsp = feeds.find((one) => one.key === '2:msp')

    return feeds.length === 4 && earth.stock === 5000 && earth.production === 2000 && Number.isInteger(earth.productionLasts) && earth.productionLasts > 0 && mars.stock === null && mars.production === null && marsMsp.stock === null && feeds.find((one) => one.key === '1:msp').production === 0 ? true : short(feeds)
  })
  add('feeds: the fuel feed carries the refinery capacity whatever the Sorium held now, with a lifetime of 0 days under 1 t of Sorium for a run with no Sorium feed, and no output where the Sorium stock or the capacity is not in the save', () => {
    const fuelOf = (extra, modifier = 1) => m.rf.supplyFeeds({ colonies: [colonyRow(1, 'Earth', { FuelStockpile: 0, MaintenanceStockpile: 0, FuelProdStatus: 1, Refineries: 1, FuelProduction: 730000, MaintProdStatus: 0, ...extra })], modifierOf: () => modifier, classes: [] }).find((one) => one.key === '1:fuel')
    const empty = fuelOf({ Sorium: 0 })
    const under = fuelOf({ Sorium: 0.5, FuelProduction: 73000 })
    const held = fuelOf({ Sorium: 10 })
    const blank = fuelOf({ Sorium: null })
    const none = fuelOf({ Sorium: null, Refineries: 0 })
    const off = fuelOf({ Sorium: 0, FuelProdStatus: 0 })
    const blind = fuelOf({ Sorium: 0 }, null)

    return empty.production === 730000 && empty.productionLasts === 0 && under.production === 73000 && under.productionLasts === 0 && held.production === 730000 && held.productionLasts >= 9 && held.productionLasts <= 10 && blank.production === null && none.production === 0 && off.production === 0 && blind.production === null ? true : short([empty, under, held, blank, none, off, blind])
  })
  add('feeds: a mineral feed carries the plan\'s draw at the giver and its delivery on the days of the haul at the taker, and untimed when the haul has no days', () => {
    const from = colonyRow(1, 'Earth', { Duranium: 500 })
    const to = colonyRow(2, 'Mars', { Duranium: 0 })
    const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes: 50 }] }], unmet: [] }
    const timed = m.rf.mineralFeeds({ colonies: [from, to], plan: hauls, timed: [{ haul: hauls.hauls[0], days: 12.5, why: null }] })
    const untimed = m.rf.mineralFeeds({ colonies: [from, to], plan: hauls, timed: [{ haul: hauls.hauls[0], days: null, why: 'no freighter class can carry it' }] })
    const giver = timed.find((one) => one.key === '1:Duranium')
    const taker = timed.find((one) => one.key === '2:Duranium')
    const idle = untimed.find((one) => one.key === '2:Duranium')

    return giver.withdrawals.length === 1 && giver.withdrawals[0].day === 0 && giver.withdrawals[0].amount === 50 && giver.withdrawals[0].scenario === 'Hauling plan' && taker.arrivals.length === 1 && taker.arrivals[0].day === 12.5 && taker.arrivals[0].source === 'haul' && idle.arrivals[0].day === null && idle.arrivals[0].why === 'no freighter class can carry it' && timed.length === 22 ? true : short([giver, taker, idle])
  })
  add('feeds: a mass-driver packet lands at the colony it is bound for on the day its distance over its speed gives, and a packet that cannot be timed is untimed', () => {
    const colonies = [colonyRow(2, 'Mars')]
    const good = { PacketID: 9, DestID: 2, Speed: 100, Xcor: 0, Ycor: 0, DestXcor: 8.64e6, DestYcor: 0, Duranium: 30, Uridium: null }
    const stalled = { PacketID: 10, DestID: 2, Speed: 0, Xcor: 0, Ycor: 0, DestXcor: 8.64e6, DestYcor: 0, Duranium: 5 }
    const feeds = m.rf.mineralFeeds({ colonies, packets: [good, stalled] })
    const duranium = feeds.find((one) => one.key === '2:Duranium')
    const days = m.ms.packetArrival(good).days

    return duranium.arrivals.length === 2 && duranium.arrivals[0].source === 'packet' && near(duranium.arrivals[0].day, days) && days > 0 && duranium.arrivals[0].amount === 30 && duranium.arrivals[1].day === null && typeof duranium.arrivals[1].why === 'string' && feeds.find((one) => one.key === '2:Uridium').arrivals.length === 0 ? true : short(duranium.arrivals)
  })
  add('feeds: a packet bound for a colony not in the list is no delivery of any, and a plan that is not given leaves the feeds with no draw', () => {
    const feeds = m.rf.mineralFeeds({ colonies: [colonyRow(2, 'Mars')], packets: [{ PacketID: 9, DestID: 77, Speed: 100, Xcor: 0, Ycor: 0, DestXcor: 100, DestYcor: 0, Duranium: 30 }] })

    return feeds.every((one) => one.arrivals.length === 0 && one.withdrawals.length === 0) ? true : short(feeds.filter((one) => one.arrivals.length))
  })

  // ---- haul ----
  const hauled = (id, extra = {}) => ({ id, label: 'Haul', scenario: 'Hauling plan', source: 'haul', ...extra })
  const giver = (extra = {}) => feed({ stock: 100, withdrawals: [hauled('h1', { label: 'Haul to Mars', day: 0, amount: 100 })], ...extra })
  const taker = (extra = {}) => feed({ key: '2:Duranium', sourceId: 2, sourceName: 'Mars', stock: 0, arrivals: [hauled('h1', { label: 'Haul from Earth', day: 5, amount: 100 })], ...extra })

  add('haul: a local withdrawal that takes the stock first leaves the haul nothing to carry, so its destination is credited nothing and a later withdrawal there is short', () => {
    const result = run({ feeds: [giver(), taker()], entries: [entry('Alpha', [plan('p1', 'Build', 100, 0)], {}, 1), entry('Beta', [plan('p1', 'Use at Mars', 100, 6)], {}, 2)] })
    const earth = rowsOf(result, '1:Duranium')
    const mars = rowsOf(result, '2:Duranium')

    return earth.run.taken === 100 && mars.run.arrived === 0 && mars.cut.length === 1 && mars.cut[0].given === 0 && mars.cut[0].planned === 100 && mars.shortfalls.length === 1 && mars.shortfalls[0].short === 100 ? true : short([earth.run.taken, mars.run.arrived, mars.cut, mars.shortfalls])
  })
  add('haul: a reserve at the source holds back what the haul takes, and the destination is credited the rest, with the cut named', () => {
    const result = run({ feeds: [giver(), taker()], entries: [entry('Alpha', [], { Duranium: 30 }, 1)] })
    const earth = rowsOf(result, '1:Duranium')
    const mars = rowsOf(result, '2:Duranium')

    return near(mars.run.arrived, 70) && mars.cut.length === 1 && near(mars.cut[0].given, 70) && mars.cut[0].planned === 100 && typeof mars.cut[0].why === 'string' && earth.shortfalls.length === 1 && earth.shortfalls[0].reason === 'reserve' ? true : short([mars.run.arrived, mars.cut, earth.shortfalls])
  })
  add('haul: a haul the source fills whole credits the whole of it and cuts nothing', () => {
    const result = run({ feeds: [giver(), taker()], entries: [] })
    const mars = rowsOf(result, '2:Duranium')

    return mars.run.arrived === 100 && mars.cut.length === 0 && rowsOf(result, '1:Duranium').run.final === 0 && result.shortfalls.length === 0 ? true : short([mars.run.arrived, mars.cut, result.shortfalls])
  })
  add('haul: a haul out of a colony that another haul filled earlier takes what that one delivered, whether it leaves after the delivery or on the day of it, and the cut is named', () => {
    const feeds = (leaves) => [feed({ stock: 60, withdrawals: [hauled('h1', { day: 0, amount: 100 })] }), feed({ key: '2:Duranium', sourceId: 2, sourceName: 'Mars', stock: 0, arrivals: [hauled('h1', { day: 2, amount: 100 })], withdrawals: [hauled('h2', { day: leaves, amount: 100 })] }), feed({ key: '3:Duranium', sourceId: 3, sourceName: 'Ceres', stock: 0, arrivals: [hauled('h2', { day: 6, amount: 100 })] })]
    const later = run({ feeds: feeds(3), entries: [] })
    const same = run({ feeds: feeds(2), entries: [] })
    const reversed = run({ feeds: feeds(2).reverse(), entries: [] })
    const ceres = rowsOf(later, '3:Duranium')

    return rowsOf(later, '2:Duranium').run.arrived === 60 && rowsOf(later, '2:Duranium').run.taken === 60 && ceres.run.arrived === 60 && ceres.cut.length === 1 && ceres.cut[0].given === 60 && rowsOf(same, '3:Duranium').run.arrived === 60 && rowsOf(same, '3:Duranium').cut.length === 1 && rowsOf(reversed, '3:Duranium').run.arrived === 60 ? true : short([rowsOf(later, '2:Duranium').run.arrived, ceres.run.arrived, ceres.cut, rowsOf(same, '3:Duranium').run.arrived, rowsOf(reversed, '3:Duranium').run.arrived])
  })
  add('haul: a chain whose second haul leaves on the day the first arrives takes what the first delivered on that day, whatever the order of the feeds', () => {
    const chain = () => [feed({ stock: 60, withdrawals: [hauled('h1', { day: 0, amount: 100 })] }), feed({ key: '2:Duranium', sourceId: 2, sourceName: 'Mars', stock: 0, arrivals: [hauled('h1', { day: 0, amount: 100 })], withdrawals: [hauled('h2', { day: 0, amount: 100 })] }), feed({ key: '3:Duranium', sourceId: 3, sourceName: 'Ceres', stock: 0, arrivals: [hauled('h2', { day: 0, amount: 100 })] })]
    const forward = run({ feeds: chain(), entries: [] })
    const backward = run({ feeds: chain().reverse(), entries: [] })

    return [forward, backward].every((result) => rowsOf(result, '2:Duranium').run.arrived === 60 && rowsOf(result, '2:Duranium').run.taken === 60 && rowsOf(result, '3:Duranium').run.arrived === 60 && rowsOf(result, '3:Duranium').cut.length === 1 && rowsOf(result, '3:Duranium').cut[0].given === 60) ? true : short([forward.rows.map((row) => [row.key, row.run.arrived, row.run.taken]), backward.rows.map((row) => [row.key, row.run.arrived, row.run.taken])])
  })
  add('haul: a funded haul lands on the tick its day gives, as the tick rule of the maintenance supply ledger does, before the withdrawals of that tick and never later', () => {
    const failures = []

    ;[0, 0.5, 1, 2.5].forEach((day) => {
      const result = run({ feeds: [giver(), taker({ arrivals: [hauled('h1', { day, amount: 100 })] })], entries: [entry('Alpha', [plan('p1', 'Use at Mars', 100, Math.max(1, Math.ceil(day)))], {}, 2)] })
      const mars = rowsOf(result, '2:Duranium')
      const arrival = mars.run.events.find((event) => event.kind === 'arrival')

      if (result.shortfalls.length !== 0 || mars.run.arrived !== 100 || !arrival || arrival.step !== m.rl.tickOf(day)) {
        failures.push([day, arrival && arrival.step, result.shortfalls.length])
      }
    })

    const later = run({ feeds: [giver({ withdrawals: [hauled('h1', { day: 2, amount: 100 })] }), taker({ arrivals: [hauled('h1', { day: 1, amount: 100 })] })], entries: [] })
    const early = rowsOf(later, '2:Duranium').run.events.find((event) => event.kind === 'arrival')

    if (!early || early.step !== 2) {
      failures.push(['left after its day', early && early.step])
    }

    return failures.length === 0 ? true : short(failures)
  })
  add('haul: hauls that fund each other in a cycle land on the tick after they leave, whatever the order of the feeds, and keep the stock', () => {
    const pair = () => [feed({ stock: 100, withdrawals: [hauled('h1', { day: 0, amount: 100 })], arrivals: [hauled('h2', { day: 0, amount: 100 })] }), feed({ key: '2:Duranium', sourceId: 2, sourceName: 'Mars', stock: 100, withdrawals: [hauled('h2', { day: 0, amount: 100 })], arrivals: [hauled('h1', { day: 0, amount: 100 })] })]
    const results = [run({ feeds: pair(), entries: [] }), run({ feeds: pair().reverse(), entries: [] })]

    return results.every((result) => result.rows.every((row) => row.run.taken === 100 && row.run.arrived === 100 && row.run.final === 100 && row.run.events.find((event) => event.kind === 'arrival').step === 2 && row.cut.length === 0)) ? true : short(results.map((result) => result.rows.map((row) => [row.run.taken, row.run.arrived, row.run.final])))
  })
  add('haul: a delivery whose haul leaves after the period is not credited, and is listed apart with the reason', () => {
    const result = run({ feeds: [giver({ withdrawals: [hauled('h1', { day: 20, amount: 100 })] }), taker({ arrivals: [hauled('h1', { day: 5, amount: 100 })] })], entries: [], days: 10 })
    const mars = rowsOf(result, '2:Duranium')

    return mars.run.arrived === 0 && mars.run.skipped.length === 1 && mars.run.skipped[0].id === 'h1' && typeof mars.run.skipped[0].why === 'string' && mars.run.skipped[0].why !== '' && rowsOf(result, '1:Duranium').run.beyond.length === 1 ? true : short([mars.run.arrived, mars.run.skipped, rowsOf(result, '1:Duranium').run.beyond])
  })
  add('haul: two stocks of nothing that haul to each other on the same day make no stock, with or without a local withdrawal at one of them', () => {
    const pair = () => [feed({ stock: 0, withdrawals: [hauled('h1', { day: 0, amount: 100 })], arrivals: [hauled('h2', { day: 0, amount: 100 })] }), feed({ key: '2:Duranium', sourceId: 2, sourceName: 'Mars', stock: 0, withdrawals: [hauled('h2', { day: 0, amount: 100 })], arrivals: [hauled('h1', { day: 0, amount: 100 })] })]
    const bare = run({ feeds: pair(), entries: [] })
    const local = run({ feeds: pair(), entries: [entry('Alpha', [plan('p1', 'Use', 10, 0)], {}, 1)] })

    return [bare, local].every((result) => result.rows.every((row) => row.run.arrived === 0 && row.run.taken === 0 && row.run.final === 0)) && local.shortfalls.some((one) => one.withdrawal.scenario === 'Alpha' && one.served === 0 && near(one.short, 10)) ? true : short([bare.rows.map((row) => [row.run.arrived, row.run.taken]), local.rows.map((row) => [row.run.arrived, row.run.taken]), local.shortfalls.map((one) => one.served)])
  })
  add('haul: a shortfall names as rivals only the sources of cut hauls that could have delivered by its day, and the same upstream by the day each haul left', () => {
    const direct = run({ feeds: [giver(), taker({ stock: 100, arrivals: [hauled('h1', { day: 10, amount: 100 })] })], entries: [entry('Alpha', [plan('p1', 'Build', 100, 0)], {}, 1), entry('Gamma', [plan('p1', 'Take', 60, 1)], {}, 2), entry('Beta', [plan('p1', 'Use at Mars', 100, 2)], {}, 2)] })
    const chain = run({ feeds: [giver(), feed({ key: '2:Duranium', sourceId: 2, sourceName: 'Mars', stock: 0, arrivals: [hauled('h1', { day: 8, amount: 100 })], withdrawals: [hauled('h2', { day: 0, amount: 100 })] }), feed({ key: '3:Duranium', sourceId: 3, sourceName: 'Ceres', stock: 100, arrivals: [hauled('h2', { day: 2, amount: 100 })] })], entries: [entry('Alpha', [plan('p1', 'Build', 100, 0)], {}, 1), entry('Gamma', [plan('p1', 'Take', 60, 1)], {}, 3), entry('Beta', [plan('p1', 'Use at Ceres', 100, 3)], {}, 3)] })
    const one = direct.shortfalls.find((item) => item.withdrawal.scenario === 'Beta')
    const far = chain.shortfalls.find((item) => item.withdrawal.scenario === 'Beta')

    return one && one.kind === 'competing' && same(one.rivals.drew, ['Gamma']) === true && far && far.kind === 'competing' && same(far.rivals.drew, ['Gamma']) === true ? true : short([one && one.rivals, far && far.rivals])
  })
  add('haul: what the sources gave on departure is what the destinations were credited, no stock goes below nothing and each stock balances, over chains, cycles and local withdrawals alike', () => {
    let seed = 7
    const next = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648

      return seed % n
    }
    const failures = []

    for (let round = 0; round < 40; round++) {
      const count = 2 + next(3)
      const feeds = Array.from({ length: count }, (_, index) => feed({ key: `${index + 1}:Duranium`, sourceId: index + 1, sourceName: `C${index + 1}`, stock: next(3) * 50, withdrawals: [], arrivals: [] }))
      const hauls = 1 + next(4)

      for (let id = 0; id < hauls; id++) {
        const from = next(count)
        const to = (from + 1 + next(count - 1)) % count
        const amount = 20 + next(5) * 20

        feeds[from].withdrawals.push(hauled(`h${id}`, { day: 0, amount }))
        feeds[to].arrivals.push(hauled(`h${id}`, { day: next(4), amount }))
      }

      const entries = Array.from({ length: next(3) }, (_, index) => entry(`S${index}`, [plan('p1', 'Use', 10 + next(4) * 20, next(3))], next(2) ? { Duranium: next(3) * 10 } : {}, 1 + next(count)))
      const result = run({ feeds, entries, days: 30 })
      const events = result.rows.flatMap((row) => row.run.events)
      const gave = events.filter((event) => event.kind === 'withdrawal' && event.source === 'haul').reduce((sum, event) => sum + event.served, 0)
      const got = events.filter((event) => event.kind === 'arrival' && event.id.startsWith('h')).reduce((sum, event) => sum + event.amount, 0)

      if (!near(got, gave) || events.some((event) => event.level < -1e-9) || result.rows.some((row) => row.run.residual > 1e-6)) {
        failures.push([round, gave, got])
      }
    }

    return failures.length === 0 ? true : short(failures)
  })
  add('haul: a shortfall that an upstream scenario caused through a haul is named competing, with that scenario, and matches a real run of the scenario alone', () => {
    const feeds = () => [giver(), taker()]
    const entries = [entry('Alpha', [plan('p1', 'Build', 100, 0)], {}, 1), entry('Beta', [plan('p1', 'Use at Mars', 100, 6)], {}, 2)]
    const both = run({ feeds: feeds(), entries })
    const beta = run({ feeds: feeds(), entries, scenarios: ['Beta'] })
    const one = both.shortfalls.find((item) => item.withdrawal.scenario === 'Beta')

    return beta.shortfalls.length === 0 && one && one.kind === 'competing' && one.served === 0 && near(one.short, 100) && near(one.worse, 100) && one.alone.served === 100 && one.alone.short === 0 && same(one.rivals.drew, ['Alpha']) === true && both.conflicts.includes(one) ? true : short([beta.shortfalls, one])
  })
  add('haul: a haul no freighter carries draws nothing at its source and delivers nothing, and says why at both ends', () => {
    const from = colonyRow(1, 'Earth', { Duranium: 100 })
    const to = colonyRow(2, 'Mars')
    const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes: 100 }] }], unmet: [] }
    const feeds = m.rf.mineralFeeds({ colonies: [from, to], plan: hauls, timed: [{ haul: hauls.hauls[0], days: null, why: 'every freighter that could carry it is given to another haul' }] })
    const result = run({ feeds, entries: [entry('Alpha', [plan('p1', 'Build', 100, 2)], {}, 1)] })
    const earth = rowsOf(result, '1:Duranium')
    const mars = rowsOf(result, '2:Duranium')

    return feeds.find((one) => one.key === '1:Duranium').withdrawals[0].day === null && earth.run.untimed.length === 1 && mars.run.untimed.length === 1 && earth.run.untimed[0].why === mars.run.untimed[0].why && typeof earth.run.untimed[0].why === 'string' && earth.run.untimed[0].why !== '' && earth.run.taken === 100 && result.shortfalls.length === 0 && mars.run.arrived === 0 ? true : short([earth.run.untimed, mars.run.untimed, earth.run.taken, result.shortfalls])
  })

  // ---- the shortfalls, the lowest level and the production of a source ----
  add('combined: a withdrawal that is short alone and that a rival makes shorter is named competing, with the extra it lost, what it would be short alone and the rival that took the stock', () => {
    const result = run({ feeds: [feed()], entries: [entry('Alpha', [plan('p1', 'Build A', 60, 1)]), entry('Beta', [plan('p1', 'Build B', 120, 2)])] })
    const one = result.shortfalls[0]

    return result.shortfalls.length === 1 && one.kind === 'competing' && near(one.short, 80) && near(one.worse, 60) && near(one.alone.short, 20) && same(one.rivals.drew, ['Alpha']) === true && result.conflicts.length === 1 ? true : short(result.shortfalls)
  })
  add('stock: the lowest level is the one a withdrawal leaves, before the production of its tick refills it', () => {
    const refilled = m.rl.runStock({ stock: 100, production: 36500, withdrawals: [{ id: 'w', day: 1, amount: 100 }], days: 1 })
    const later = m.rl.runStock({ stock: 100, production: 365, withdrawals: [{ id: 'w', day: 3, amount: 100 }], days: 10 })

    return refilled.lowest.level === 0 && refilled.lowest.step === 1 && near(refilled.final, 100) && later.lowest.step === 3 && near(later.lowest.level, 2) ? true : short([refilled.lowest, later.lowest])
  })
  add('stock: a source that can make only so much from its inputs stops there however long the period', () => {
    const limited = m.rl.runStock({ stock: 0, production: 365, productionBudget: 40, days: 100 })
    const wide = m.rl.runStock({ stock: 0, production: 365, productionBudget: 1000, days: 100 })

    return near(limited.produced, 40) && near(limited.final, 40) && near(wide.produced, 100) && limited.residual < 1e-9 ? true : short([limited.produced, wide.produced])
  })
  add('feeds: the supplies feed makes at the facilities\' own rate within the stock of its scarcest input, so a longer period never makes more than the stock allows', () => {
    const unit = m.lg.mspProduction({ MaintenanceFacilities: 1, MSPProduction: 1 }, 1).value
    const colony = colonyRow(1, 'Earth', { FuelStockpile: null, MaintenanceStockpile: 0, MaintProdStatus: 1, MaintenanceFacilities: 400 / unit, MSPProduction: 1, ...Object.fromEntries(m.lg.MSP_MINERALS.map((mineral) => [mineral.name, 100 * mineral.perMsp])) })
    const msp = m.rf.supplyFeeds({ colonies: [colony], modifierOf: () => 1, place: () => 'Sol', classes: [] }).find((one) => one.key === '1:msp')
    const months = run({ feeds: [msp], days: 91 }).rows[0].run
    const years = run({ feeds: [msp], days: 730, entries: [entry('Alpha', [plan('p1', 'Refit', 150, 730, 'msp')], {}, 1)] })

    return near(msp.production, 400) && near(msp.productionBudget, 100) && near(months.produced, 400 * 91 / 365) && near(years.rows[0].run.produced, 100) && years.shortfalls.length === 1 && near(years.shortfalls[0].short, 50) ? true : short([msp.production, msp.productionBudget, months.produced, years.rows[0].run.produced, years.shortfalls])
  })
  add('feeds: a supplies feed with production off makes nothing, one with the switch not in the save has no production, and neither has a budget', () => {
    const feedsOf = (status) => m.rf.supplyFeeds({ colonies: [colonyRow(1, 'Earth', { FuelStockpile: null, MaintenanceStockpile: 5, MaintProdStatus: status, MaintenanceFacilities: 10, MSPProduction: 1 })], modifierOf: () => 1, place: () => 'Sol', classes: [] }).find((one) => one.key === '1:msp')
    const off = feedsOf(0)
    const unknown = feedsOf(null)

    return off.production === 0 && off.productionBudget === null && unknown.production === null && unknown.productionBudget === null ? true : short([off, unknown])
  })

  add('combined: production draws on the same mineral stocks as the planned withdrawals, after them, so an export of an input leaves nothing to make from and the production is short of it, naming the exporter', () => {
    const unit = m.lg.mspProduction({ MaintenanceFacilities: 1, MSPProduction: 1 }, 1).value
    const colonies = [colonyRow(10, 'Earth', { Duranium: 10, Uridium: 1000, Gallicite: 1000, FuelStockpile: 0, MaintenanceStockpile: 0, MaintProdStatus: 1, MaintenanceFacilities: 365 / unit, MSPProduction: 1 })]
    const feeds = (support = false) => [...m.rf.supplyFeeds({ colonies, modifierOf: () => 1 }), ...m.rf.mineralFeeds({ colonies }).map((one) => ({ ...one, support }))]
    const use = entry('Beta', [plan('p1', 'Use', 95, 101, 'msp')], {}, 10)
    const export_ = entry('Alpha', [plan('p1', 'Export', 10, 0, 'Duranium')], {}, 10)
    const both = run({ feeds: feeds(), entries: [export_, use] })
    const hidden = run({ feeds: feeds(true), entries: [export_, use] })
    const alone = run({ feeds: feeds(), entries: [use] })
    const duranium = rowsOf(both, '10:Duranium')
    const lost = both.shortfalls.find((one) => one.key === '10:msp')
    const lostHidden = hidden.shortfalls.find((one) => one.key === '10:msp')
    const made = rowsOf(alone, '10:Duranium')

    return duranium.run.taken === 10 && duranium.run.used === 0 && duranium.run.residual < 1e-6 && lost && lost.served === 0 && near(lost.short, 95) && lost.kind === 'competing' && same(lost.rivals.drew, ['Alpha']) === true && lostHidden && lostHidden.served === 0 && !hidden.rows.some((row) => row.key === '10:Duranium') && alone.shortfalls.length === 0 && near(made.run.used, 10) && near(rowsOf(alone, '10:msp').run.produced, 100) && made.run.residual < 1e-6 ? true : short([duranium.run, lost, lostHidden, alone.shortfalls, made.run.used])
  })
  add('combined: a destination of a counted haul is a source the table lists, with the haul cut short or untimed too, and not when the hauls do not count', () => {
    const from = colonyRow(1, 'Earth', { Duranium: 100 })
    const to = colonyRow(2, 'Mars')
    const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes: 100 }] }], unmet: [] }
    const feedsOf = (days) => m.rf.mineralFeeds({ colonies: [from, to], plan: hauls, timed: [{ haul: hauls.hauls[0], days, why: days === null ? 'no freighter class can carry it' : null }] })
    const timed = run({ feeds: feedsOf(12) })
    const untimed = run({ feeds: feedsOf(null) })
    const off = run({ feeds: feedsOf(12), countPlan: false })
    const cut = run({ feeds: feedsOf(12), entries: [entry('Alpha', [], { Duranium: 30 }, 1)] })

    return rowsOf(timed, '2:Duranium').active === true && rowsOf(untimed, '2:Duranium').active === true && rowsOf(cut, '2:Duranium').active === true && rowsOf(off, '2:Duranium').active === false && rowsOf(timed, '3:Duranium') === undefined ? true : short([timed, untimed, cut, off].map((result) => rowsOf(result, '2:Duranium').active))
  })
  add('haul: a shortfall downstream of a haul names a source reserve as a rival only when it exceeds the reserve the short scenario keeps there', () => {
    const beta = (sourceId, extra = {}) => ({ ...entry('Beta', [], {}, sourceId), uuid: `u-Beta-${sourceId}`, ...extra })
    const feeds = [feed({ stock: 100, withdrawals: [hauled('h1', { label: 'Haul to Mars', day: 0, amount: 50 })] }), taker({ arrivals: [hauled('h1', { label: 'Haul from Earth', day: 5, amount: 50 })] })]
    const entries = [entry('Alpha', [], { Duranium: 20 }, 1), beta(1, { reserves: { Duranium: 50 } }), beta(2, { plans: [plan('p1', 'Use at Mars', 50, 6)] }), entry('Gamma', [plan('p1', 'Take', 20, 0)], {}, 1)]
    const result = run({ feeds, entries })
    const one = result.shortfalls.find((item) => item.withdrawal.scenario === 'Beta')

    return one && one.kind === 'competing' && near(one.served, 30) && near(one.short, 20) && same(one.rivals.drew, ['Gamma']) === true && same(one.rivals.reserved, []) === true ? true : short(one)
  })

  add('combined: fuel refining draws on the colony\'s Sorium at 1 t for 2,000 L, after the planned withdrawals, so an export of the Sorium leaves nothing to refine and the withdrawal of fuel is short of it, naming the exporter', () => {
    const colonies = [colonyRow(10, 'Earth', { Sorium: 10, FuelStockpile: 0, FuelProdStatus: 1, Refineries: 1, FuelProduction: 730000, MaintenanceStockpile: 0, MaintProdStatus: 0 })]
    const feeds = () => [...m.rf.supplyFeeds({ colonies, modifierOf: () => 1 }), ...m.rf.mineralFeeds({ colonies })]
    const fuel = feeds().find((one) => one.key === '10:fuel')
    const tank = entry('Beta', [plan('p1', 'Tank up', 20000, 11, 'fuel')], {}, 10)
    const export_ = entry('Alpha', [plan('p1', 'Export', 10, 0, 'Sorium')], {}, 10)
    const both = run({ feeds: feeds(), entries: [export_, tank] })
    const alone = run({ feeds: feeds(), entries: [tank] })
    const fallback = run({ feeds: [fuel] })
    const delivered = run({ feeds: feeds().map((one) => (one.key === '10:Sorium' ? { ...one, arrivals: [{ id: 'packet:1:Sorium', label: 'Mass-driver packet', scenario: null, day: 5, amount: 10, source: 'packet', why: null }] } : one)) })
    const lost = both.shortfalls.find((one) => one.key === '10:fuel')
    const sorium = rowsOf(both, '10:Sorium')
    const used = rowsOf(alone, '10:Sorium')

    return same(fuel.productionInputs, [{ key: '10:Sorium', perUnit: 1 / 2000 }]) === true && near(fuel.production, 730000) && lost && lost.served === 0 && near(lost.short, 20000) && lost.kind === 'competing' && same(lost.rivals.drew, ['Alpha']) === true && sorium.run.taken === 10 && sorium.run.used === 0 && rowsOf(both, '10:fuel').run.produced === 0 && alone.shortfalls.length === 0 && near(used.run.used, 10) && near(used.run.final, 0) && near(rowsOf(alone, '10:fuel').run.produced, 20000) && near(rowsOf(fallback, '10:fuel').run.produced, 20000) && near(rowsOf(delivered, '10:fuel').run.produced, 40000) ? true : short([lost, sorium && sorium.run, alone.shortfalls, used && used.run, rowsOf(fallback, '10:fuel').run.produced, rowsOf(delivered, '10:fuel').run.produced])
  })
  add('combined: a withdrawal of an input on the tick of the shortfall is no rival of it, since the production runs after the tick\'s withdrawals, and one on an earlier tick is', () => {
    const unit = m.lg.mspProduction({ MaintenanceFacilities: 1, MSPProduction: 1 }, 1).value
    const colonies = [colonyRow(10, 'Earth', { Duranium: 10, Uridium: 1000, Gallicite: 1000, FuelStockpile: 0, MaintenanceStockpile: 0, MaintProdStatus: 1, MaintenanceFacilities: 365 / unit, MSPProduction: 1 })]
    const feeds = () => [...m.rf.supplyFeeds({ colonies, modifierOf: () => 1 }), ...m.rf.mineralFeeds({ colonies })]
    const use = entry('Beta', [plan('p1', 'Use', 100, 101, 'msp')], {}, 10)
    const export_ = entry('Alpha', [plan('p1', 'Export', 10, 0, 'Duranium')], {}, 10)
    const lostWith = (day) => run({ feeds: feeds(), entries: [export_, use, entry('Gamma', [plan('p1', 'Take', 1, day, 'Uridium')], {}, 10)] }).shortfalls.find((one) => one.key === '10:msp')
    const same_ = lostWith(101)
    const earlier = lostWith(100)

    return same_ && same(same_.rivals.drew, ['Alpha']) === true && earlier && same([...earlier.rivals.drew].sort(), ['Alpha', 'Gamma']) === true ? true : short([same_ && same_.rivals, earlier && earlier.rivals])
  })
  add('combined: a source whose production cannot be worked out is listed on each stock it would draw on as not known, and one whose production is known is not', () => {
    const duranium = feed({ key: '1:Duranium', stock: 10 })
    const msp = (production) => feed({ key: '1:msp', resource: 'msp', stock: 0, production, productionInputs: [{ key: '1:Duranium', perUnit: 0.1 }] })
    const unknown = rowsOf(run({ feeds: [duranium, msp(null)] }), '1:Duranium')
    const known = rowsOf(run({ feeds: [duranium, msp(1)] }), '1:Duranium')
    const none = rowsOf(run({ feeds: [duranium] }), '1:Duranium')

    return unknown.unknownUse.length === 1 && unknown.unknownUse[0].key === '1:msp' && unknown.unknownUse[0].resource === 'msp' && known.unknownUse.length === 0 && none.unknownUse.length === 0 ? true : short([unknown.unknownUse, known.unknownUse, none.unknownUse])
  })
  add('combined: a refinery that starts without Sorium makes fuel from the tick the Sorium arrives, against the balance of each tick: a withdrawal after the days of refining is served what they made, an export of the Sorium is served only what is left, and without Sorium nothing is made', () => {
    const world = (sorium, ...arrivals) => {
      const colonies = [colonyRow(10, 'Earth', { Sorium: sorium, FuelStockpile: 0, FuelProdStatus: 1, Refineries: 1, FuelProduction: 730000, MaintenanceStockpile: 0, MaintProdStatus: 0 })]

      return [...m.rf.supplyFeeds({ colonies, modifierOf: () => 1 }), ...m.rf.mineralFeeds({ colonies }).map((one) => (one.key === '10:Sorium' ? { ...one, arrivals } : one))]
    }
    const arrival = (day, amount) => ({ id: `packet:${day}`, label: 'Mass-driver packet', scenario: null, day, amount, source: 'packet', why: null })
    const tank = (amount) => entry('Beta', [plan('p1', 'Tank up', amount, 11, 'fuel')], {}, 10)
    const export_ = entry('Alpha', [plan('p1', 'Export', 10, 11, 'Sorium')], {}, 10)
    const served = run({ feeds: world(0, arrival(5, 10)), entries: [tank(12000)] })
    const over = run({ feeds: world(0, arrival(5, 10)), entries: [tank(12001)] })
    const exported = run({ feeds: world(0, arrival(5, 10)), entries: [export_] })
    const never = run({ feeds: world(0), entries: [tank(12000)] })
    const spent = run({ feeds: world(3), days: 30 })
    const later = run({ feeds: world(2, arrival(10, 5)), days: 30 })
    const fallback = (sorium) => rowsOf(run({ feeds: world(sorium).filter((one) => one.key === '10:fuel'), days: 30 }), '10:fuel').run.produced
    const sale = rowsOf(exported, '10:Sorium').shortfalls[0]
    const lone = over.shortfalls.find((one) => one.key === '10:fuel')

    return served.shortfalls.length === 0 && near(rowsOf(served, '10:Sorium').run.used, 10) && near(rowsOf(served, '10:fuel').run.produced, 20000) && lone && near(lone.served, 12000) && near(lone.short, 1) && sale && near(sale.served, 4) && near(sale.short, 6) && near(rowsOf(exported, '10:Sorium').run.used, 6) && never.shortfalls.length === 1 && near(never.shortfalls[0].short, 12000) && near(rowsOf(spent, '10:fuel').run.produced, 6000) && near(rowsOf(spent, '10:Sorium').run.used, 3) && near(rowsOf(spent, '10:Sorium').run.final, 0) && rowsOf(spent, '10:Sorium').run.residual < 1e-6 && rowsOf(spent, '10:fuel').run.residual < 1e-6 && near(rowsOf(later, '10:fuel').run.produced, 14000) && near(rowsOf(later, '10:Sorium').run.used, 7) && near(rowsOf(later, '10:Sorium').run.final, 0) && fallback(0) === 0 && fallback(0.5) === 0 && near(fallback(10), 20000) ? true : short([served.shortfalls, lone, sale, never.shortfalls, rowsOf(spent, '10:fuel').run.produced, rowsOf(later, '10:fuel').run.produced, fallback(0), fallback(0.5), fallback(10)])
  })
  add('combined: a refinery under 1 t of Sorium in a run with no Sorium feed makes nothing however slow it refines, and one with 1 t or more refines for as long as the Sorium lasts', () => {
    const alone = (sorium) => rowsOf(run({ feeds: m.rf.supplyFeeds({ colonies: [colonyRow(10, 'Earth', { Sorium: sorium, FuelStockpile: 0, FuelProdStatus: 1, Refineries: 1, FuelProduction: 73000, MaintenanceStockpile: 0, MaintProdStatus: 0 })], modifierOf: () => 1 }).filter((one) => one.key === '10:fuel'), days: 30 }), '10:fuel').run.produced

    return alone(0.5) === 0 && near(alone(10), 6000) && near(alone(1), 2000) ? true : short([alone(0.5), alone(10), alone(1)])
  })
  add('combined: production takes its inputs whatever is known of its output (the stock known or not, the rate known, nil or not known) and of its inputs (filled later, spent in the period, one not in the save), for maintenance supplies and for fuel, and a rate that is not known is listed on the input, never read as none', () => {
    const unit = m.lg.mspProduction({ MaintenanceFacilities: 1, MSPProduction: 1 }, 1).value
    const supplies = ({ stock = 5, modifier = 1, status = 1, support = false, duranium = 10, uridium = 1000, arrivals = [] } = {}) => {
      const colonies = [colonyRow(10, 'Earth', { Duranium: duranium, Uridium: uridium, Gallicite: 1000, FuelStockpile: 0, FuelProdStatus: 0, Refineries: 0, MaintenanceStockpile: stock, MaintProdStatus: status, MaintenanceFacilities: 365 / unit, MSPProduction: 1 })]

      return [...m.rf.supplyFeeds({ colonies, modifierOf: () => modifier }).map((one) => ({ ...one, support })), ...m.rf.mineralFeeds({ colonies }).map((one) => (one.key === '10:Duranium' ? { ...one, arrivals } : one))]
    }
    const fuel = ({ stock = 0, modifier = 1, status = 1, sorium = 10 } = {}) => {
      const colonies = [colonyRow(10, 'Earth', { Sorium: sorium, FuelStockpile: stock, FuelProdStatus: status, Refineries: 1, FuelProduction: 730000, MaintenanceStockpile: 0, MaintProdStatus: 0 })]

      return [...m.rf.supplyFeeds({ colonies, modifierOf: () => modifier }), ...m.rf.mineralFeeds({ colonies })]
    }
    const outcome = (feeds, input, output) => {
      const ledgerOf = run({ feeds, days: 200 })
      const taken = rowsOf(ledgerOf, input)
      const made = rowsOf(ledgerOf, output)

      return [taken.run.used, taken.unknownUse.length, made.run.known, made.run.known ? made.run.produced : null]
    }
    const wanted = (used, unknown, known, produced) => [used, unknown, known, produced]
    const cases = [
      ['supplies: stock and rate known', outcome(supplies({ stock: 5 }), '10:Duranium', '10:msp'), wanted(10, 0, true, 100)],
      ['supplies: stock not known, rate known', outcome(supplies({ stock: null }), '10:Duranium', '10:msp'), wanted(10, 0, false, null)],
      ['supplies: stock known, rate not known', outcome(supplies({ stock: 5, modifier: null }), '10:Duranium', '10:msp'), wanted(0, 1, true, 0)],
      ['supplies: stock and rate not known', outcome(supplies({ stock: null, modifier: null }), '10:Duranium', '10:msp'), wanted(0, 1, false, null)],
      ['supplies: stock known, production off', outcome(supplies({ stock: 5, status: 0 }), '10:Duranium', '10:msp'), wanted(0, 0, true, 0)],
      ['supplies: stock not known, production off', outcome(supplies({ stock: null, status: 0 }), '10:Duranium', '10:msp'), wanted(0, 0, false, null)],
      ['supplies: stock known, switch not in the save', outcome(supplies({ stock: 5, status: null }), '10:Duranium', '10:msp'), wanted(0, 1, true, 0)],
      ['supplies: stock not known, switch not in the save', outcome(supplies({ stock: null, status: null }), '10:Duranium', '10:msp'), wanted(0, 1, false, null)],
      ['supplies: stock known, an input stock not in the save', outcome(supplies({ stock: 5, uridium: null }), '10:Duranium', '10:msp'), wanted(0, 1, true, 0)],
      ['supplies: stock not known, an input stock not in the save', outcome(supplies({ stock: null, uridium: null }), '10:Duranium', '10:msp'), wanted(0, 1, false, null)],
      ['supplies: an input spent in the period', outcome(supplies({ stock: 0, duranium: 5 }), '10:Duranium', '10:msp'), wanted(5, 0, true, 50)],
      ['fuel: stock and rate known', outcome(fuel({ stock: 0 }), '10:Sorium', '10:fuel'), wanted(10, 0, true, 20000)],
      ['fuel: stock not known, rate known', outcome(fuel({ stock: null }), '10:Sorium', '10:fuel'), wanted(10, 0, false, null)],
      ['fuel: stock known, rate not known', outcome(fuel({ modifier: null }), '10:Sorium', '10:fuel'), wanted(0, 1, true, 0)],
      ['fuel: stock and rate not known', outcome(fuel({ stock: null, modifier: null }), '10:Sorium', '10:fuel'), wanted(0, 1, false, null)],
      ['fuel: stock known, production off', outcome(fuel({ status: 0 }), '10:Sorium', '10:fuel'), wanted(0, 0, true, 0)],
      ['fuel: stock not known, production off', outcome(fuel({ stock: null, status: 0 }), '10:Sorium', '10:fuel'), wanted(0, 0, false, null)],
      ['fuel: stock known, switch not in the save', outcome(fuel({ status: null }), '10:Sorium', '10:fuel'), wanted(0, 1, true, 0)],
    ]
    const matches = (figure, expected) => (typeof expected === 'number' ? near(figure, expected) : figure === expected)
    const wrong = cases.filter(([, found, expected]) => !found.every((figure, at) => matches(figure, expected[at]))).map(([name, found, expected]) => [name, found, expected])
    const take = entry('Beta', [plan('p1', 'Ship', 10, 101, 'Duranium')], {}, 10)
    const unknownStock = run({ feeds: supplies({ stock: null }), entries: [take] })
    const asSupport = run({ feeds: supplies({ stock: null, support: true }), entries: [take] })
    const unknownRate = run({ feeds: supplies({ stock: null, modifier: null }), entries: [take] })
    const lost = unknownStock.shortfalls.find((one) => one.key === '10:Duranium')
    const lostAsSupport = asSupport.shortfalls.find((one) => one.key === '10:Duranium')
    const arrival = { id: 'packet:1', label: 'Mass-driver packet', scenario: null, day: 50, amount: 10, source: 'packet', why: null }
    const later = rowsOf(run({ feeds: supplies({ stock: 0, duranium: 0, arrivals: [arrival] }), days: 200 }), '10:msp').run
    const alone = (duranium) => rowsOf(run({ feeds: supplies({ stock: 0, duranium }).filter((one) => one.key === '10:msp'), days: 200 }), '10:msp').run.produced

    return wrong.length === 0 && lost && near(lost.served, 0) && near(lost.short, 10) && lost.kind === 'own' && rowsOf(unknownStock, '10:Duranium').unknownUse.length === 0 && lostAsSupport && near(lostAsSupport.short, 10) && rowsOf(asSupport, '10:msp') === undefined && unknownRate.shortfalls.length === 0 && rowsOf(unknownRate, '10:Duranium').unknownUse.length === 1 && near(later.produced, 100) && later.residual < 1e-6 && near(rowsOf(run({ feeds: supplies({ stock: 0, duranium: 0, arrivals: [arrival] }), days: 200 }), '10:Duranium').run.used, 10) && alone(0) === 0 && near(alone(10), 100) ? true : short([wrong, lost, lostAsSupport && lostAsSupport.short, unknownRate.shortfalls, later, alone(0), alone(10)])
  })
  add('combined: a stock with no producer among the feeds loses nothing to production and lists none as not known', () => {
    const row = rowsOf(run({ feeds: m.rf.mineralFeeds({ colonies: [colonyRow(10, 'Earth', { Duranium: 10, Uridium: 1000, Gallicite: 1000, Sorium: 10 })] }), days: 200 }), '10:Duranium')

    return row.run.used === 0 && row.unknownUse.length === 0 && near(row.run.final, 10) ? true : short(row.run)
  })

  return statements
}

const records = (ctx) => {
  const { m } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('record: a record per colony and scenario is kept, and a second of the same colony and scenario is refused whichever the reserve', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 5 } })

    const again = await keep(m, w, scope(), context, { reserves: { Duranium: 6 } })
    const other = await keep(m, w, scope(), context, { scenario: 'Beta', reserves: { Duranium: 6 } })
    const elsewhere = await keep(m, w, scope(), context, { colonyId: 11, reserves: { Duranium: 6 } })

    return again.ok === false && again.code === 'exists' && other.ok === true && elsewhere.ok === true && m.rr.readReserves(w.repo, scope(), context).entries.length === 3 ? true : short([again, other, elsewhere])
  })
  add('record: it survives a reload of the store and a switch of race, and comes back with the race', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 5 }, plans: [plan('p1', 'Build', 50, 10)] })

    const reloaded = world(m, w.inst)
    const again = m.rr.readReserves(reloaded.repo, scope(), context)
    const otherContext = await open(m, SAVE(), scope('b1', RACE + 1))
    const away = m.rr.readReserves(reloaded.repo, scope('b1', RACE + 1), otherContext)
    const back = m.rr.readReserves(reloaded.repo, scope(), context)

    return again.entries.length === 1 && again.entries[0].applied === true && again.entries[0].reserves.Duranium === 5 && again.entries[0].plans.length === 1 && away.entries.length === 0 && back.entries.length === 1 && back.entries[0].uuid === again.entries[0].uuid ? true : short([again.entries.length, away.entries.length, back.entries.length])
  })
  add('record: the race of a record is the race of its scope, another race never lists it and one race\'s reserves never change another\'s run', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 90 } })

    const other = m.rr.readReserves(w.repo, scope('b1', RACE + 1), await open(m, SAVE(), scope('b1', RACE + 1)))

    return other.entries.length === 0 && same(m.rr.entriesForLedger(other.entries), []) === true ? true : short(other.entries)
  })
  add('record: a record kept for the branch lists on no other branch, and one shared with the campaign lists on every branch', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { scenario: 'Mine', reserves: { Duranium: 1 } })
    await kept(m, w, scope(), context, { scenario: 'Shared', reserves: { Duranium: 2 }, policy: 'campaign' })

    const names = (branchId) => m.rr.readReserves(w.repo, scope(branchId), { ...context, branchId }).entries.map((one) => one.scenario).sort()

    return same([names('b1'), names('b2')], [['Mine', 'Shared'], ['Shared']])
  })
  add('record: a colony ID given to another colony reads as under review, applies to nothing, and is never moved to a colony of the same name', async () => {
    const w = world(m)
    const save = SAVE()
    const first = await open(m, save)

    await kept(m, w, scope(), first, { reserves: { Duranium: 40 } })

    const reissued = edited(save, (copy) => {
      copy.colonies = [colony(10, 'Another', 3, 300, 9), colony(12, 'Earth Prime', 1, 100, 7)]
      copy.systems.push({ id: 3, name: 'Barnard' })
    })
    const { read } = await readOn(m, w, reissued)
    const one = read.entries[0]

    return one?.applied === false && one.source.verdict.state === 'review' && one.source.id === 10 && same(m.rr.entriesForLedger(read.entries), []) === true && one.reason !== '' ? true : short(one)
  })
  add('record: confirming the colony that holds the ID applies the record, and only a record under review can be confirmed', async () => {
    const w = world(m)
    const save = SAVE()
    const first = await open(m, save)

    await kept(m, w, scope(), first, { reserves: { Duranium: 40 } })

    const reissued = edited(save, (copy) => {
      copy.colonies = [colony(10, 'Another', 3, 300, 9)]
      copy.systems.push({ id: 3, name: 'Barnard' })
    })
    const { context, read } = await readOn(m, w, reissued)
    const confirmed = await m.rr.confirmSource(w.repo, scope(), { entry: read.entries[0], context })
    const after = m.rr.readReserves(w.repo, scope(), context)
    const held = await m.rr.confirmSource(w.repo, scope(), { entry: after.entries[0], context })

    return confirmed.ok === true && after.entries[0]?.applied === true && after.entries[0].source.name === 'Another' && held.ok === false ? true : short([confirmed, after.entries[0]?.source.verdict, held])
  })
  add('record: a colony that is gone leaves a record that applies to nothing, and a colony whose colonies were not read is not taken for gone', async () => {
    const w = world(m)
    const save = SAVE()
    const first = await open(m, save)

    await kept(m, w, scope(), first, { reserves: { Duranium: 40 } })

    const { read } = await readOn(m, w, edited(save, (copy) => { copy.colonies = [colony(11, 'Proxima Base', 2, 200)] }))
    const unread = m.rr.readReserves(w.repo, scope(), null)

    return read.entries[0]?.applied === false && read.entries[0].source.verdict.state === 'gone' && unread.entries[0]?.applied === false && unread.entries[0].source.verdict.state === 'unread' ? true : short([read.entries[0]?.source.verdict, unread.entries[0]?.source.verdict])
  })
  add('record: a record made after the open save\'s game time is listed apart, applies to nothing, and is moved to the save only by the player', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 40 } })

    const early = scope('b1', RACE, 'c1', 50000)
    const read = m.rr.readReserves(w.repo, early, context)
    const moved = await m.rr.rebaseReserve(w.repo, early, read.entries[0])
    const after = m.rr.readReserves(w.repo, early, context)
    const again = await m.rr.rebaseReserve(w.repo, early, after.entries[0])

    return read.entries[0]?.ahead === true && read.entries[0].applied === false && moved.ok === true && after.entries[0]?.ahead === false && after.entries[0].applied === true && again.ok === false ? true : short([read.entries[0]?.ahead, moved, after.entries[0]?.ahead, again])
  })
  add('record: an edit goes over the revision it was read at, a stale one is refused with the stored record, and writes over it only when told to', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 40 } })

    const stale = m.rr.readReserves(w.repo, scope(), context).entries[0]
    const first = await m.rr.saveReserve(w.repo, scope(), { entry: stale, resources: ['Duranium'], reserves: { Duranium: 41 }, context })
    const second = await m.rr.saveReserve(w.repo, scope(), { entry: stale, resources: ['Duranium'], reserves: { Duranium: 42 }, context })
    const written = await m.rr.saveReserve(w.repo, scope(), { entry: stale, resources: ['Duranium'], reserves: { Duranium: 43 }, context, overwrite: true })

    return first.ok === true && second.ok === false && second.code === 'revision-conflict' && second.stored.reserves.Duranium === 41 && written.ok === true && m.rr.readReserves(w.repo, scope(), context).entries[0].reserves.Duranium === 43 ? true : short([first.ok, second, written.ok])
  })
  add('record: an edit takes neither the colony nor the scenario of the record', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 40 } })

    const stored = m.rr.readReserves(w.repo, scope(), context).entries[0]
    const moved = await m.rr.saveReserve(w.repo, scope(), { entry: stored, source: colonyOf(context, 11), resources: ['Duranium'], reserves: { Duranium: 1 }, context })
    const renamed = await m.rr.saveReserve(w.repo, scope(), { entry: stored, scenario: 'Other', resources: ['Duranium'], reserves: { Duranium: 1 }, context })

    return moved.ok === false && renamed.ok === false ? true : short([moved, renamed])
  })
  add('record: an edit from a panel of one group keeps the lines of the other group, and replaces only its own', () => {
    const base = { source: {}, scenario: 'Alpha', reserves: { fuel: 100, Duranium: 5 }, plans: [plan('p1', 'Tank', 20, 3, 'fuel'), plan('p2', 'Build', 30, 4, 'Duranium')], note: 'kept' }
    const made = m.rr.editedPayload(base, { resources: ['Duranium', 'Uridium'], reserves: { Duranium: 0, Uridium: 9 }, plans: [{ label: 'Moved', resource: 'Uridium', kind: 'withdraw', amount: 4, day: 6 }] })

    return same(made.reserves, { fuel: 100, Duranium: 0, Uridium: 9 }) === true && made.plans.length === 2 && made.plans[0].resource === 'fuel' && made.plans[1].label === 'Moved' && made.plans[1].id === 'p2' && made.note === 'kept' ? true : short(made)
  })
  add('record: a record that keeps no reserve and plans nothing is refused, and what the payload may hold is checked', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const empty = await keep(m, w, scope(), context, {})
    const badDay = await keep(m, w, scope(), context, { scenario: 'Day', plans: [plan('p1', 'Build', 5, 5000)] })
    const badAmount = await keep(m, w, scope(), context, { scenario: 'Amount', plans: [plan('p1', 'Build', 0, 5)] })
    const badKind = await keep(m, w, scope(), context, { scenario: 'Kind', plans: [plan('p1', 'Build', 5, 5, 'Duranium', 'steal')] })
    const long = await keep(m, w, scope(), context, { scenario: 'x'.repeat(61), reserves: { Duranium: 1 } })
    const spaced = await keep(m, w, scope(), context, { scenario: ' Padded ', reserves: { Duranium: 1 } })

    return empty.ok === false && badDay.ok === false && badAmount.ok === false && badKind.ok === false && long.ok === false && spaced.ok === true && m.rr.problemsOf({ nonsense: true }).length > 0 ? true : short([empty, badDay, badAmount, badKind, long.ok, spaced.ok])
  })
  add('record: a colony picked from another save, race or branch is refused', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const foreign = { ...context, RaceID: RACE + 1 }
    const wrongBranch = { ...context, branchId: 'b2' }
    const stranger = await m.rr.saveReserve(w.repo, scope(), { source: { type: 'colony', row: { ...context.objects.colony.get(10), id: 999 } }, scenario: 'Alpha', resources: ['Duranium'], reserves: { Duranium: 1 }, context })
    const race = await m.rr.saveReserve(w.repo, scope(), { source: colonyOf(context, 10), scenario: 'Alpha', resources: ['Duranium'], reserves: { Duranium: 1 }, context: foreign })
    const branch = await m.rr.saveReserve(w.repo, scope(), { source: colonyOf(context, 10), scenario: 'Alpha', resources: ['Duranium'], reserves: { Duranium: 1 }, context: wrongBranch })

    return stranger.ok === false && race.ok === false && branch.ok === false ? true : short([stranger, race, branch])
  })
  add('record: a record is deleted over its revision, and a stale delete deletes nothing', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { reserves: { Duranium: 40 } })

    const stale = m.rr.readReserves(w.repo, scope(), context).entries[0]

    await m.rr.saveReserve(w.repo, scope(), { entry: stale, resources: ['Duranium'], reserves: { Duranium: 41 }, context })

    const refused = await m.rr.deleteReserve(w.repo, scope(), stale)
    const fresh = m.rr.readReserves(w.repo, scope(), context).entries[0]
    const done = await m.rr.deleteReserve(w.repo, scope(), fresh)

    return refused.ok === false && refused.code === 'revision-conflict' && done.ok === true && m.rr.readReserves(w.repo, scope(), context).entries.length === 0 ? true : short([refused, done])
  })
  add('record: a scenario is listed once with the sources it names, and the plan is no scenario', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { scenario: 'Beta', reserves: { Duranium: 1 } })
    await kept(m, w, scope(), context, { scenario: 'Alpha', reserves: { Duranium: 1 } })
    await kept(m, w, scope(), context, { colonyId: 11, scenario: 'Alpha', reserves: { Duranium: 1 } })

    return same(m.rr.scenarioNames(m.rr.readReserves(w.repo, scope(), context).entries), ['Alpha', 'Beta'])
  })
  add('record: the records of two scenarios on a colony feed one run that spends the stock once', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { scenario: 'Alpha', plans: [plan('p1', 'Build A', 70, 10)] })
    await kept(m, w, scope(), context, { scenario: 'Beta', plans: [plan('p1', 'Build B', 70, 20)] })

    const read = m.rr.readReserves(w.repo, scope(), context)
    const result = m.rl.combinedLedger({ feeds: [feed({ sourceId: 10, key: '10:Duranium' })], entries: m.rr.entriesForLedger(read.entries), days: 365 })

    return result.shortfalls.length === 1 && result.shortfalls[0].kind === 'competing' && result.shortfalls[0].sourceId === 10 ? true : short(result.shortfalls)
  })

  add('record: a record shared with the campaign is refused while another branch keeps one for the same colony and scenario, new or widened, and a lone one may be shared', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(m, save)
    const other = await open(m, save, scope('b2'))
    const entryOf = (name) => m.rr.readReserves(w.repo, scope(), context).entries.find((one) => one.scenario === name)

    await kept(m, w, scope('b2'), other, { scenario: 'Alpha', reserves: { Duranium: 7 } })
    await kept(m, w, scope('b2'), other, { scenario: 'Beta', reserves: { Duranium: 2 } })
    await kept(m, w, scope(), context, { scenario: 'Beta', reserves: { Duranium: 1 } })
    await kept(m, w, scope(), context, { scenario: 'Lone', reserves: { Duranium: 4 } })

    const fresh = await keep(m, w, scope(), context, { scenario: 'Alpha', reserves: { Duranium: 3 }, policy: 'campaign' })
    const widened = await m.rr.saveReserve(w.repo, scope(), { entry: entryOf('Beta'), resources: ['Duranium'], reserves: { Duranium: 1 }, context, policy: 'campaign' })
    const allowed = await m.rr.saveReserve(w.repo, scope(), { entry: entryOf('Lone'), resources: ['Duranium'], reserves: { Duranium: 4 }, context, policy: 'campaign' })

    return fresh.ok === false && fresh.code === 'exists' && widened.ok === false && widened.code === 'exists' && allowed.ok === true ? true : short([fresh, widened, allowed])
  })
  add('record: two records of one colony and scenario that meet on a branch (an import into a branch that holds one) are both listed, neither applies, and the one left applies when the other is deleted', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context, { scenario: 'Alpha', reserves: { Duranium: 5 }, plans: [plan('p1', 'Build', 5, 3)] })

    const bundle = w.repo.exportRecords(scope())
    const target = { campaignId: 'c1', RaceID: RACE, branch: 'b1' }

    w.repo.importRecords(bundle, target, { preview: w.repo.previewImport(bundle, target) })

    const read = m.rr.readReserves(w.repo, scope(), context)
    const gone = await m.rr.deleteReserve(w.repo, scope(), read.entries[0])
    const left = m.rr.readReserves(w.repo, scope(), context)

    return read.entries.length === 2 && read.entries.every((one) => one.applied === false && one.overlap === 1 && typeof one.reason === 'string' && one.reason !== '') && m.rr.entriesForLedger(read.entries).length === 0 && gone.ok === true && left.entries.length === 1 && left.entries[0].applied === true && left.entries[0].overlap === 0 ? true : short([read.entries.map((one) => [one.applied, one.overlap]), left.entries.map((one) => [one.applied, one.overlap])])
  })

  return statements
}

const loaders = (ctx) => {
  const { m } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('loaders: every statement of every read is a select, with the game and race as parameters', async () => {
    const database = fakeSave(SAVE())

    await m.rr.loadReserveObjects(database, { GameID: GAME, RaceID: RACE })
    await m.rf.loadClassMinimums(database, { GameID: GAME, RaceID: RACE })
    await m.rf.loadSupplyState(database, { GameID: GAME, RaceID: RACE })

    return database.sent.length === 3 && database.sent.every((one) => /^select /i.test(one.sql) && !/\b(insert|update|delete|drop|alter|create)\b/i.test(one.sql) && one.replacements.GameID === GAME && one.replacements.RaceID === RACE) ? true : short(database.sent)
  })
  add('loaders: the classes are those with ships, a column the save leaves null stays null and is not 0', async () => {
    const classes = await m.rf.loadClassMinimums(fakeSave(SAVE()), { GameID: GAME, RaceID: RACE })

    return classes.length === 2 && classes[0].MinimumFuel === 5000 && classes[1].MinimumSupplies === null && classes[0].MinimumSupplies === 0 ? true : short(classes)
  })
  add('loaders: a read that fails fails the whole read, so a colony or a class that was not read is never taken for one that is gone', async () => {
    const outcomes = await Promise.all([m.rr.loadReserveObjects(fakeSave(SAVE(), { failing: ['FCT_Population'] }), { GameID: GAME, RaceID: RACE }).then(() => 'read', (error) => error.message), m.rf.loadClassMinimums(fakeSave(SAVE(), { failing: ['FCT_ShipClass'] }), { GameID: GAME, RaceID: RACE }).then(() => 'read', (error) => error.message), m.rf.loadSupplyState(fakeSave(SAVE(), { failing: ['FCT_PopulationInstallations'] }), { GameID: GAME, RaceID: RACE }).then(() => 'read', (error) => error.message)])

    return outcomes.every((outcome) => /no such table/.test(outcome)) ? true : short(outcomes)
  })

  return statements
}

// ---------- the panel ----------

const BASE_DATA = { place: null, modifierOf: null, plan: null, timed: null, embedded: false }

const panel = (ctx) => {
  const { m, options, labels, componentText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  // The words naming the reads that failed, as the module's own labels give them: a failed read is named by its declared label, whatever the label says.
  const named = (...keys) => m.lt.joinLabels(keys.map((key) => labels[key]))

  const mount = (args) => mountPanel(ctx, args)
  const stock = stockRows
  const rowOf = (vm, key) => vm.view.ledger.rows.find((row) => row.key === key)
  add('component: the template compiles with no error', () => {
    const errors = compiled(componentText).errors.map(String)

    return errors.length === 0 ? true : short(errors)
  })
  add('component: no summary has a figure or a pronoun, and the two panels do not share one', async () => {
    const summaries = ['supplies', 'minerals'].map((kind) => instantiate(options, { boundary, $store: PAGE_STORE, data: { ...BASE_DATA, kind } }).summary)

    return summaries.every((text) => typeof text === 'string' && text.length > 40 && !/\d/.test(text) && !PRONOUNS.test(text)) && summaries[0] !== summaries[1] ? true : short(summaries)
  })
  add('component: the head has a title, and the reads that are out show the progress or the failure and no figure', async () => {
    const { vm } = await mount({ data: { reserveObjects: null, loadErrors: {} } })
    const failed = await mount({ data: { reserveObjects: null, loadErrors: { reserveObjects: 'boom', reserveClasses: null } } })

    return typeof vm.title === 'string' && vm.title !== '' && vm.state.loading === true && vm.view === null && failed.vm.state.failed === named('reserveObjects') && failed.vm.state.error === 'boom' && failed.vm.view === null && failed.vm.items.length === 0 ? true : short([vm.state, failed.vm.state])
  })
  add('component: with no repository, no scope or a refused read the panel shows no figure and says why', async () => {
    const none = await mount({ data: { reserveRecords: Object.freeze({ repository: null, error: 'no store' }) } })
    const unsettled = await mount({ data: { reserveRecords: Object.freeze({ repository: null, error: null }) } })

    return none.vm.view === null && none.vm.repositoryError === 'no store' && unsettled.vm.view !== null ? true : short([none.vm.view, unsettled.vm.view])
  })
  add('component: the three minimums are three columns, in this order', () => {
    const headers = through('the headers of the panel', () => options.computed.headers.call({}))

    return same(headers.map((header) => header.value).slice(2, 5), ['game', 'class', 'player']) === true && headers.slice(0, 6).every((header) => typeof header.text === 'string' && header.text !== '') ? true : short(headers)
  })
  add('component: the ledger gives three minimums apart: the game minimum of a mineral, the class minimum n/a, the player reserve 0', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock() })
    const context = vm.reserveContext

    await kept(m, w, scope(), context, { reserves: { Duranium: 0 } })

    const row = rowOf(vm, '10:Duranium')

    return row.minimums.game.applies && row.minimums.game.value === 250 && row.minimums.class.applies === false && row.minimums.player.recorded === true && row.minimums.player.value === 0 && vm.items.some((item) => item.key === '10:Duranium') ? true : short(row.minimums)
  })
  add('component: for fuel and supplies the ledger has no game minimum, though the colony has warning levels, and the class minimum is the classes\'', async () => {
    const { vm } = await mount({ kind: 'supplies', colonies: stock({ WarningFuel: 4000, WarningMSP: 300, FuelProdStatus: 0, MaintProdStatus: 0 }), data: { showAll: true } })
    const fuel = rowOf(vm, '10:fuel')
    const msp = rowOf(vm, '10:msp')

    return fuel.minimums.game.applies === false && fuel.minimums.game.value === null && msp.minimums.game.applies === false && fuel.minimums.class.value === 5000 && fuel.minimums.class.className === 'Tanker' && fuel.stock === 5000 && msp.stock === 200 ? true : short([fuel.minimums, msp.minimums])
  })
  add('component: a source without a record or a plan is listed only when asked for, and a record makes it listed', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock() })
    const before = vm.items.length
    const shown = instantiate(options, { boundary, $store: PAGE_STORE, database: vm.database, GameID: GAME, RaceID: RACE, data: { ...BASE_DATA, kind: 'minerals', colonies: stock(), reserveRecords: vm.reserveRecords, reserveObjects: vm.reserveObjects, reserveClasses: vm.reserveClasses, reservePackets: vm.reservePackets, reserveSupply: vm.reserveSupply, populationProductionModifiers: vm.populationProductionModifiers, loadErrors: vm.loadErrors, showAll: true } })

    await kept(m, w, scope(), vm.reserveContext, { reserves: { Duranium: 5 } })

    return before === 0 && shown.items.length === 11 && vm.items.length === 1 ? true : short([before, shown.items.length, vm.items.length])
  })
  add('component: the table lists the sources that run short first, then those a record touches, then the rest', async () => {
    const colonies = [colonyRow(10, 'Earth Prime', { Duranium: 100, ReserveDuranium: 0 }), colonyRow(11, 'Proxima Base', { Duranium: 100, ReserveDuranium: 0 })]
    const { vm, w } = await mount({ kind: 'minerals', colonies, data: { showAll: true } })

    await kept(m, w, scope(), vm.reserveContext, { colonyId: 10, scenario: 'Alpha', reserves: { Duranium: 5 } })
    await kept(m, w, scope(), vm.reserveContext, { colonyId: 11, scenario: 'Beta', plans: [plan('p1', 'Build', 500, 4)] })

    return same(vm.items.slice(0, 2).map((item) => item.key), ['11:Duranium', '10:Duranium']) === true && vm.items.length === 22 ? true : short(vm.items.slice(0, 3).map((item) => item.key))
  })
  add('component: a combined scenario of two records on one colony shows one shortfall that names the day, the resource, the colony and the withdrawal', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock({ Duranium: 100 }) })
    const context = vm.reserveContext

    await kept(m, w, scope(), context, { scenario: 'Alpha', plans: [plan('p1', 'Build A', 70, 10)] })
    await kept(m, w, scope(), context, { scenario: 'Beta', plans: [plan('p1', 'Build B', 70, 20)] })

    const one = vm.view.ledger.shortfalls[0]

    return vm.view.ledger.shortfalls.length === 1 && one.step === 20 && one.resource === 'Duranium' && one.sourceName === 'Earth Prime' && one.withdrawal.label === 'Build B' && one.withdrawal.scenario === 'Beta' && [...one.rivals.drew, ...one.rivals.reserved].includes('Alpha') && near(one.wanted, 70) && near(one.served, 30) && near(one.short, 40) ? true : short([one])
  })
  add('component: a scenario picked leaves the others out of the run, and a name no record has any more is not picked', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock({ Duranium: 100 }) })
    const context = vm.reserveContext

    await kept(m, w, scope(), context, { scenario: 'Alpha', plans: [plan('p1', 'Build A', 70, 10)] })
    await kept(m, w, scope(), context, { scenario: 'Beta', plans: [plan('p1', 'Build B', 70, 20)] })

    vm.ledgerScenarios = ['Alpha', 'Gone']

    return same(vm.chosen, ['Alpha']) === true && vm.view.ledger.shortfalls.length === 0 && same(vm.view.ledger.scenarios, ['Alpha']) === true ? true : short([vm.chosen, vm.view.ledger.shortfalls])
  })
  add('component: the plan is counted only on Hauling and only with a switch, and the days of its hauls reach the ledger', async () => {
    const from = colonyRow(10, 'Earth Prime', { Duranium: 100, ReserveDuranium: 0 })
    const to = colonyRow(11, 'Proxima Base', { Duranium: 0 })
    const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes: 60 }] }], unmet: [] }
    const { vm } = await mount({ kind: 'minerals', colonies: [from, to], data: { plan: hauls, timed: [{ haul: hauls.hauls[0], days: 12, why: null }] } })
    const taker = rowOf(vm, '11:Duranium')
    const giver = rowOf(vm, '10:Duranium')
    const noPlan = await mount({ kind: 'supplies', colonies: stock() })

    vm.countPlan = false

    return vm.hasPlan === true && noPlan.vm.hasPlan === false && giver.run.taken === 60 && taker.run.arrived === 60 && taker.run.events[0].step === 12 && rowOf(vm, '10:Duranium').run.taken === 0 ? true : short([giver.run.taken, taker.run.arrived, taker.run.events])
  })
  add('component: the form keeps a record with a reserve of 0, leaves a blank line unset, and the list shows the colony, the scenario and the lines', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock() })

    vm.startNew()
    vm.draft.colonyPick = vm.colonyChoices.find((choice) => choice.id === 10)
    vm.draft.scenario = 'Reserve'
    vm.draft.reserves.Duranium = '0'
    vm.draft.reserves.Uridium = '   '
    await vm.save(false)

    const read = m.rr.readReserves(w.repo, scope(), vm.reserveContext)
    const stored = read.entries[0]

    return vm.messageType === 'success' && vm.draft.open === false && read.entries.length === 1 && same(stored.reserves, { Duranium: 0 }) === true && vm.linesText(stored).includes('Duranium') && /\b0\b/.test(vm.linesText(stored)) ? true : short([vm.message, stored && stored.reserves])
  })
  add('component: the form refuses a reserve that is not a number and a line with no amount, and says so, writing nothing', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock() })

    vm.startNew()
    vm.draft.colonyPick = vm.colonyChoices.find((choice) => choice.id === 10)
    vm.draft.scenario = 'Words'
    vm.draft.reserves.Duranium = 'lots'
    await vm.save(false)

    const word = vm.message

    vm.draft.reserves.Duranium = ''
    vm.addPlan()
    vm.draft.plans[0].label = 'Build'
    await vm.save(false)

    return word !== '' && vm.message !== '' && vm.messageType === 'warning' && m.rr.readReserves(w.repo, scope(), vm.reserveContext).entries.length === 0 ? true : short([word, vm.message])
  })
  add('component: the form of one group edits only that group\'s lines of a record and leaves the other group\'s as they are', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock() })

    await kept(m, w, scope(), vm.reserveContext, { resources: ['fuel', 'Duranium'], reserves: { fuel: 900, Duranium: 5 }, plans: [plan('p1', 'Tank up', 20, 3, 'fuel')] })

    const stored = vm.entries[0]

    vm.startEdit(stored)
    vm.draft.reserves.Duranium = '9'
    await vm.save(false)

    const after = vm.entries[0]

    return after.reserves.fuel === 900 && after.reserves.Duranium === 9 && after.plans.length === 1 && after.plans[0].resource === 'fuel' && vm.linesText(after).includes('Duranium') && vm.linesText(after).includes('9') ? true : short(after)
  })
  add('component: an edit opened on one record and written after another write is told it conflicts, and keeps what is stored unless told to write over it', async () => {
    const { vm, w } = await mount({ kind: 'minerals', colonies: stock() })

    await kept(m, w, scope(), vm.reserveContext, { reserves: { Duranium: 1 } })
    vm.startEdit(vm.entries[0])
    await m.rr.saveReserve(w.repo, scope(), { entry: vm.entries[0], resources: ['Duranium'], reserves: { Duranium: 2 }, context: vm.reserveContext })
    vm.draft.reserves.Duranium = '3'
    await vm.save(false)

    const conflict = vm.conflict
    const stored = vm.entries[0].reserves.Duranium

    await vm.save(true)

    return conflict !== null && stored === 2 && vm.entries[0].reserves.Duranium === 3 && vm.conflict === null ? true : short([conflict, stored, vm.entries[0].reserves])
  })
  add('component: a draft is emptied when the campaign, race or branch shown changes, and a draft filled in for another is never written', async () => {
    const { vm } = await mount({ kind: 'minerals', colonies: stock() })

    vm.startNew()
    vm.draft.colonyPick = vm.colonyChoices.find((choice) => choice.id === 10)
    vm.draft.scenario = 'Alpha'
    vm.draft.reserves.Duranium = '5'
    vm.draft.scopeKey = 'c9|7|b9'
    await vm.save(false)

    return vm.draft.open === false && vm.message !== '' && vm.messageType === 'warning' && vm.entries.length === 0 ? true : short([vm.draft, vm.message, vm.messageType])
  })
  add('component: the reads are out until the colonies, classes and (for minerals) packets are in for this save and race, and one that was made for another race is not used', async () => {
    const ready = await mount({ kind: 'supplies' })
    const waitingPackets = await mount({ kind: 'minerals', data: { reservePackets: null } })
    const otherRace = await mount({ kind: 'supplies', data: { reserveObjects: Object.freeze({ ...(await m.rr.loadReserveObjects(fakeSave(SAVE()), { GameID: GAME, RaceID: RACE + 1 })), RaceID: RACE + 1, database: null }) } })

    return ready.vm.state.loading === false && waitingPackets.vm.state.loading === true && otherRace.vm.state.loading === true && otherRace.vm.view === null && same(ready.vm.reserveInputs, ['reserveObjects', 'reserveClasses']) === true && waitingPackets.vm.reserveInputs.includes('reservePackets') ? true : short([ready.vm.state, waitingPackets.vm.state, otherRace.vm.state])
  })
  add('component: a read that fails is named with its message, keeps its message while it is read again and is read again by Retry alone', async () => {
    const updated = []
    const { vm } = await mount({ kind: 'minerals', data: { loadErrors: { reserveObjects: null, reserveClasses: 'no table', reservePackets: 'no packets' }, $asyncComputed: { reserveObjects: { update: () => updated.push('reserveObjects') }, reserveClasses: { update: () => updated.push('reserveClasses') }, reservePackets: { update: () => updated.push('reservePackets') }, reserveSupply: { update: () => updated.push('reserveSupply') }, populationProductionModifiers: { update: () => updated.push('populationProductionModifiers') } } } })

    vm.retryReserves()

    return vm.state.failed === named('reserveClasses', 'reservePackets') && ['reserveObjects', 'reserveClasses', 'reservePackets', 'reserveSupply', 'populationProductionModifiers'].every((key) => typeof labels[key] === 'string' && labels[key] !== '') && vm.state.error === 'no table' && same(updated, ['reserveClasses', 'reservePackets']) === true ? true : short([vm.state, updated])
  })
  add('component: a failed read of the colonies rejects, lands in the load errors and leaves no bundle', async () => {
    const failing = { query: async () => { throw new Error('boom') } }
    const vm = instantiate(options, { boundary, $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { ...BASE_DATA, kind: 'minerals', loadErrors: {} } })
    const results = []

    for (const key of ['reserveObjects', 'reserveClasses', 'reservePackets']) {
      results.push(await vm.runAsync(key).then(() => 'read', rejection))
    }

    return results.every((message) => message === 'boom') && vm.loadErrors.reserveObjects === 'boom' && vm.loadErrors.reserveClasses === 'boom' ? true : short([results, vm.loadErrors])
  })
  add('component: no read is made without a save, a game and a race, and the packets are read for minerals alone', async () => {
    const asked = []
    const spy = { query: async (sql) => { asked.push(sql); return [[]] } }
    const lone = instantiate(options, { boundary, $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { ...BASE_DATA, kind: 'minerals', loadErrors: {} } })
    const supplies = instantiate(options, { boundary, $store: PAGE_STORE, database: spy, GameID: GAME, RaceID: RACE, data: { ...BASE_DATA, kind: 'supplies', loadErrors: {} } })
    const none = await Promise.all(['reserveObjects', 'reserveClasses', 'reservePackets'].map((key) => lone.runAsync(key)))
    // A read that is made where none should be is a value to reject (what it asked, and how it ended), not a call that threw.
    const packets = await supplies.runAsync('reservePackets').then((value) => value, (error) => `rejected: ${error.message}`)

    return none.every((value) => value === null) && packets === null && asked.length === 0 ? true : short([none, packets, asked])
  })

  add('component: a haul the source could not fill whole is shown at the destination as delivered less than planned, with what it was given', async () => {
    const from = colonyRow(10, 'Earth Prime', { Duranium: 100, ReserveDuranium: 0 })
    const to = colonyRow(11, 'Proxima Base', { Duranium: 0 })
    const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes: 100 }] }], unmet: [] }
    const { vm, w } = await mount({ kind: 'minerals', colonies: [from, to], data: { plan: hauls, timed: [{ haul: hauls.hauls[0], days: 12, why: null }] } })

    await kept(m, w, scope(), vm.reserveContext, { colonyId: 10, scenario: 'Alpha', reserves: { Duranium: 30 } })

    const taker = vm.notCounted(rowOf(vm, '11:Duranium')).find((note) => note.key === 'cut')
    const giver = vm.notCounted(rowOf(vm, '10:Duranium')).find((note) => note.key === 'cut')
    const listed = vm.items.some((item) => item.key === '11:Duranium')

    const cut = rowOf(vm, '11:Duranium').cut

    return taker && typeof taker.text === 'string' && taker.text !== '' && cut.length === 1 && cut[0].planned === 100 && cut[0].given === 70 && !giver && listed && vm.showAll === false ? true : short([taker, giver, listed, cut])
  })
  // A haul no freighter class carries has no days: both ends are untimed, nothing of it is counted and the rows cannot be called covered, though a timed haul of the same size would cut the reserve.
  add('component: a row with a flow that has no days has its flow untimed and no shortfall, whatever the reserve would have cut had the flow been timed, and a timed flow keeps its shortfall or its cover', async () => {
    const from = colonyRow(10, 'Earth Prime', { Duranium: 100, ReserveDuranium: 0 })
    const to = colonyRow(11, 'Proxima Base', { Duranium: 0 })
    const statusOf = async (days, tonnes, key) => {
      const hauls = { hauls: [{ key: 'h1', from, to, minerals: [{ name: 'Duranium', tonnes }] }], unmet: [] }
      const { vm, w } = await mount({ kind: 'minerals', colonies: [from, to], data: { plan: hauls, timed: [{ haul: hauls.hauls[0], days, why: days === null ? 'no freighter class can carry it' : null }] } })

      await kept(m, w, scope(), vm.reserveContext, { colonyId: 10, scenario: 'Alpha', reserves: { Duranium: 50 } })

      return { item: vm.items.find((one) => one.key === key) }
    }
    const loose = await statusOf(null, 100, '10:Duranium')
    const arrival = await statusOf(null, 100, '11:Duranium')
    const late = await statusOf(5, 100, '10:Duranium')
    const spare = await statusOf(5, 40, '10:Duranium')

    if (![loose, arrival, late, spare].every((one) => one.item)) {
      return short([loose, arrival, late, spare].map((one) => Boolean(one.item)))
    }

    return loose.item.shortfalls.length === 0 && loose.item.run.untimed.length === 1 && arrival.item.run.untimed.length === 1 && late.item.shortfalls.length === 1 && near(late.item.shortfalls[0].short, 50) && spare.item.shortfalls.length === 0 && spare.item.run.untimed.length === 0 ? true : short([loose.item.run.untimed, arrival.item.run.untimed, late.item.shortfalls, spare.item.run.untimed])
  })
  const supplyRow = (extra = {}) => supplyRowOf(m, extra)
  const surface = async (kind, { records = [], modifiers = true, data = {}, supplyExtra = {} } = {}) => {
    const { vm, w } = await mount({ kind, colonies: kind === 'supplies' ? [{ ...haulingRow(), ...supplyRow(supplyExtra) }] : [haulingRow()], supply: [supplyRow(supplyExtra)], data: kind === 'supplies' ? { modifierOf: () => 1, ...data } : { populationProductionModifiers: modifiers ? { 10: { OverallProductionModifier: 1 } } : {}, ...data } })

    for (const record of records) {
      await kept(m, w, scope(), vm.reserveContext, { colonyId: 10, ...record })
    }

    return vm
  }
  const beta = { scenario: 'Beta', resources: ['msp'], plans: [plan('p1', 'Use', 95, 101, 'msp')] }
  const alpha = { scenario: 'Alpha', resources: ['Duranium'], plans: [plan('p1', 'Export', 10, 0, 'Duranium')] }

  add('component: production and a planned export of an input spend one stock, whether the panel shows the supplies or the minerals', async () => {
    const supplies = await surface('supplies', { records: [beta, alpha] })
    const minerals = await surface('minerals', { records: [beta, alpha] })
    const apart = await surface('minerals', { records: [beta] })
    const lost = supplies.view.ledger.shortfalls.find((one) => one.key === '10:msp')
    const duranium = rowOf(minerals, '10:Duranium')
    const used = rowOf(apart, '10:Duranium')

    return lost && lost.served === 0 && same(lost.rivals.drew, ['Alpha']) === true && rowOf(supplies, '10:msp').run.produced === 0 && rowOf(supplies, '10:Duranium') === undefined && duranium.run.taken === 10 && duranium.run.used === 0 && minerals.view.ledger.shortfalls.length === 0 && used.run.used > 9.9 && near(used.run.final, 0) && used.run.residual < 1e-6 && rowOf(minerals, '10:msp') === undefined ? true : short([lost, duranium && duranium.run, used && used.run])
  })
  // The Hauling page's own read of the colonies, run on a save with the tables it names, and the plan and the days it hands the panel: what the page mounts the panel with, apart from `kind` and `embedded`, which are fixed in its template.
  const haulingMount = async () => {
    const raw = new sqlite3.Database(':memory:')
    const exec = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))
    const stocks = MINERAL_NAMES.map((name) => `${name} real default 0, Reserve${name} real default 0`).join(', ')

    await exec(`create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, SystemID integer, SystemBodyID integer, MassDriverDest integer, ${stocks}); create table FCT_SystemBody (SystemBodyID integer, Xcor real, Ycor real); create table FCT_PopulationInstallations (PopID integer, GameID integer, PlanetaryInstallationID integer, Amount integer); create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, Name text, MassDriverValue real, CargoShuttleValue real); insert into FCT_Population (PopulationID, GameID, RaceID, PopName, SystemID, SystemBodyID, MassDriverDest, Duranium, Uridium, Gallicite) values (10, ${GAME}, ${RACE}, 'Earth Prime', 1, 100, 0, 10, 1000, 1000); insert into FCT_SystemBody values (100, 0, 0)`)

    const database = { query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => raw.all(sql.replace(/:([A-Za-z]+)\b/g, (_match, name) => String(replacements[name])), (error, found) => (error ? reject(error) : resolve([found])))) }
    const hauling = await loadPage('pages/hauling', { stubs: STUBS, modules: { 'mixins/load-state': 'export default (labels) => ({ computed: { inputLabels: () => labels } })' } })
    const page = instantiate(hauling, { boundary, $store: PAGE_STORE, database, GameID: GAME, RaceID: RACE, data: { loadErrors: {} } })

    await page.runAsync('colonies')
    raw.close()

    return { colonies: page.colonies, plan: page.plan, timed: page.plannedDays }
  }
  add('component: mounted as Hauling mounts it, on the colonies the page\'s own read returns and with no modifier handed in, the panel reads the supplies and the production rates itself, so the mineral the production took shows as a shortfall of the withdrawal it starved', async () => {
    const records = [{ scenario: 'Both', resources: ['msp', 'Duranium'], plans: [plan('p1', 'Use', 100, 101, 'msp'), plan('p2', 'Ship', 10, 101, 'Duranium')] }]
    const { colonies, plan: hauls, timed } = await haulingMount()
    const { vm, w } = await mount({ kind: 'minerals', colonies, supply: [supplyRow()], data: { plan: hauls, timed, embedded: true, populationProductionModifiers: { 10: { OverallProductionModifier: 1 } } } })

    for (const record of records) {
      await kept(m, w, scope(), vm.reserveContext, { colonyId: 10, ...record })
    }

    const lost = vm.view.ledger.shortfalls.filter((one) => one.key === '10:Duranium')
    const row = rowOf(vm, '10:Duranium')
    const lone = await mount({ kind: 'minerals', colonies, data: { plan: hauls, timed, embedded: true, reserveSupply: null } })
    const bare = !('MaintenanceStockpile' in colonies[0]) && !('MSPProduction' in colonies[0]) && !('MaintenanceFacilities' in colonies[0]) && !('MaintProdStatus' in colonies[0])

    return colonies.length === 1 && bare && vm.modifierOf === null && lost.length === 1 && near(lost[0].served, 0) && near(lost[0].short, 10) && row.run.used > 9.9 && row.shortfalls.length === 1 && rowOf(vm, '10:msp') === undefined && vm.state.loading === false && lone.vm.state.loading === true && lone.vm.view === null ? true : short([colonies, lost, row && row.run, vm.modifierOf])
  })
  add('component: a colony whose maintenance supplies stock is not in the save still has its production take the inputs, so a withdrawal of the whole stock of an input is short and listed as that, never covered', async () => {
    const late = { scenario: 'Late', resources: ['Duranium'], plans: [plan('p1', 'Ship', 10, 101, 'Duranium')] }
    const minerals = await surface('minerals', { records: [late], supplyExtra: { MaintenanceStockpile: null } })
    const row = rowOf(minerals, '10:Duranium')

    return minerals.state.loading === false && row && row.shortfalls.length === 1 && near(row.shortfalls[0].served, 0) && near(row.shortfalls[0].short, 10) && row.run.used > 9.9 && row.unknownUse.length === 0 && rowOf(minerals, '10:msp') === undefined ? true : short([row && row.run, row && row.shortfalls])
  })
  add('component: a production whose rate is not known is not counted, and the input is listed as not known and never as covered', async () => {
    const watch = { scenario: 'Watch', resources: ['Duranium'], reserves: { Duranium: 1 } }
    const unknown = await surface('minerals', { records: [beta, watch], modifiers: false, data: { showAll: true } })
    const known = await surface('minerals', { records: [beta, watch], data: { showAll: true } })
    const row = rowOf(unknown, '10:Duranium')
    const note = unknown.notCounted(row).find((one) => one.key === 'use')

    return unknown.state.loading === false && row.unknownUse.length === 1 && row.unknownUse[0].key === '10:msp' && row.run.used === 0 && note && typeof note.text === 'string' && note.text !== '' && rowOf(known, '10:Duranium').unknownUse.length === 0 && !known.notCounted(rowOf(known, '10:Duranium')).some((one) => one.key === 'use') ? true : short([row && row.unknownUse, note])
  })
  add('component: the colonies\' supplies and production rates are read for minerals alone, the panel waits on both, and a read that fails is named and shows no figure', async () => {
    const asked = []
    const spy = { query: async (sql) => { asked.push(sql); return [[supplyRow()]] } }
    const alone = (kind, database) => instantiate(options, { boundary, $store: PAGE_STORE, database, GameID: GAME, RaceID: RACE, data: { ...BASE_DATA, kind, loadErrors: {} } })
    const read = await alone('minerals', spy).runAsync('reserveSupply')
    const supplies = alone('supplies', spy)
    const skipped = await supplies.runAsync('reserveSupply')
    const nobody = await alone('minerals', null).runAsync('reserveSupply')
    const failing = alone('minerals', { query: async () => { throw new Error('boom') } })
    const failure = await failing.runAsync('reserveSupply').then(() => 'read', rejection)
    const clear = { reserveObjects: null, reserveClasses: null, reservePackets: null, reserveSupply: null, populationProductionModifiers: null }
    const waiting = await mount({ kind: 'minerals', data: { reserveSupply: null } })
    const unsettled = await mount({ kind: 'minerals', data: { loadErrors: { ...clear, populationProductionModifiers: undefined } } })
    const rates = await mount({ kind: 'minerals', data: { loadErrors: { ...clear, populationProductionModifiers: 'no rates' } } })
    const noSupply = await mount({ kind: 'minerals', data: { loadErrors: { ...clear, reserveSupply: 'no table' } } })

    return read.colonies.length === 1 && read.database === spy && read.GameID === GAME && read.RaceID === RACE && asked.length === 1 && skipped === null && nobody === null && failure === 'boom' && failing.loadErrors.reserveSupply === 'boom' && same(supplies.reserveInputs, ['reserveObjects', 'reserveClasses']) === true && waiting.vm.state.loading === true && waiting.vm.view === null && unsettled.vm.state.loading === true && unsettled.vm.view === null && rates.vm.state.failed === named('populationProductionModifiers') && rates.vm.state.error === 'no rates' && rates.vm.view === null && noSupply.vm.state.failed === named('reserveSupply') && noSupply.vm.view === null ? true : short([asked.length, failure, waiting.vm.state, unsettled.vm.state, rates.vm.state, noSupply.vm.state])
  })
  add('component: a class minimum that is not recorded for every class is shown as at least the figure, with the classes that record none', async () => {
    const { vm } = await mount({ kind: 'supplies', colonies: stock(), data: { showAll: true } })
    const partial = vm.items.find((item) => item.key === '10:msp')
    const whole = vm.items.find((item) => item.key === '10:fuel')
    const unqualified = (item) => ({ ...item, minimums: { ...item.minimums, class: { ...item.minimums.class, unknown: 0 } } })
    const figure = vm.figure(partial.minimums.class.value)

    return partial.minimums.class.unknown === 1 && vm.classText(partial) !== vm.classText(unqualified(partial)) && vm.classText(partial).includes(figure) && vm.classText(unqualified(partial)).includes(figure) && vm.classText(whole) === vm.classText(unqualified(whole)) ? true : short([vm.classText(partial), vm.classText(unqualified(partial)), vm.classText(whole)])
  })

  return statements
}

const voice = (ctx) => {
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('voice: nothing the panel, the mixin and the utilities say is in the first or second person', () => {
    const texts = { component: ctx.texts.component, mixin: ctx.texts.mixin, ledger: ctx.texts.ledger, reserves: ctx.texts.reserves, feeds: ctx.texts.feeds }
    const found = Object.entries(texts).flatMap(([name, text]) => {
      const strings = name === 'component' ? [...stringsOf(scriptOf(text)), ...staticTextOf(templateAst(text))] : stringsOf(text)

      return strings.filter((one) => PRONOUNS.test(one)).map((one) => [name, one.slice(0, 80)])
    })

    return found.length === 0 ? true : short(found)
  })

  return statements
}

// ---------- the screen ----------

// What the real app shows and does (scripts/lib/reserve-screen.js: the renderer in Chromium over a copy of a save, with the real Vue and the real Vuetify). Where the panel is mounted, whether it is on screen, which component instance the page resolved and the props it was given, the classes of its root and what a click on each button does are read from the page in the browser. A part of the screen is observed only for a variant whose files can change it, and the statement of a part that was not observed passes, as the files it reads are the ones of the head run.
// ---------- what the table says ----------

const escapedFor = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// What the page shows of a number: a whole number as it is, any other number to one decimal, rounded as the page rounds it (scripts/lib/browser-observe.js `rounded`: -0.15 is -0.1, 0.15 is 0.2). The expected number of a displayed quantity is the ledger's, rounded this way; it is a number, never a string written by this check.
const displayOf = (value) => rounded(value, Number.isInteger(value) ? 0 : 1)

// Whether the text names the unit as a word.
const hasUnit = (text, unit) => new RegExp(`(^|[^A-Za-z])${escapedFor(unit)}([^A-Za-z]|$)`).test(text)

// The quantities a region draws, each by its role (scripts/lib/browser-observe.js `rolesRead`), read as signed figures in the grouping of the page's setting (`readFigure`) against the numbers the ledger gives them at the precision the page shows. A value of null is a quantity that is not known and is not drawn.
const figuresRead = (what, values, expected, setting, problems) => problems.push(...rolesRead(what, values, Object.fromEntries(Object.entries(expected).map(([role, wanted]) => [role, wanted === null ? null : displayOf(wanted)])), (text) => readFigure(text, setting)))

// The state of each minimum column that draws a figure, by the role of the element that draws it: a class minimum some classes record none of draws the count of those classes as well.
const MINIMUM_FIGURES = { game: { saved: 'game' }, class: { partial: 'class-unknown', figure: 'class' }, player: { set: 'player' } }

// The state a minimum cell shows, read from what it draws and never from its hook: the state of a figure where the element of that figure's role draws one on screen (`figures`, { state: role }, the first that does), and otherwise the cell's words read back to their state through the panel's own words for the column (`words`, a column of the component's `minimumWords`, by scripts/lib/browser-observe.js `labelKey`), or a note of the words where no state has them.
const shownState = (cell, words, figures, setting) => {
  const figure = Object.keys(figures).find((state) => cell.values.some((value) => value.role === figures[state] && value.on && readFigure(value.text, setting) !== null))

  if (figure) {
    return figure
  }

  const state = words && typeof words === 'object' ? labelKey(cell.text, words) : null

  return state === null ? `words of no state: ${cell.text}` : state
}

// What a row or a line of the screen is, as the screen says it, each name by its role: the names of the colony and the resource, the label of a withdrawal and the scenario it belongs to, each drawn as the oracle's name word for word (a name of a colony or of a resource is save data, not prose); a scenario that is none is not drawn.
const namesRead = (what, names, expected, problems) => problems.push(...rolesRead(what, names, Object.fromEntries(Object.entries(expected).map(([role, wanted]) => [role, wanted === '' ? null : wanted]))))

// The words the save and the fixtures give to a resource: the minerals are named by their columns, the two supplies by the words of the game's own listing of them (not the panel's table of resources).
const RESOURCE_NAMES = { fuel: 'Fuel', msp: 'Maintenance supplies' }
const resourceName = (key) => RESOURCE_NAMES[key] || key

// The name of a colony in the fixture's own rows, by its id.
const colonyName = (colonies, id) => (colonies.find((colony) => colony.PopulationID === id) || {}).PopName

// The identity of a withdrawal or a delivery, whichever repository wrote it: the id with the uuid of its record taken off (a record has a uuid of its own in each repository) so what is left is the id of the plan, the haul or the packet.
const idOf = (id) => String(id).replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:/i, '')

// The lines of a list of the screen set against the oracle's rows by identity and not by place (scripts/lib/browser-observe.js `pairedBy`), with its problems told. Returns the pairs.
const pairedLines = (problems, ...list) => {
  const { pairs, problems: unpaired } = pairedBy(...list)

  problems.push(...unpaired)

  return pairs
}

// A text without the words (a label, a scenario or a name of a source) the numbers of which are not the panel's figures.
const without = (text, ...words) => words.filter((word) => typeof word === 'string' && word !== '').reduce((rest, word) => rest.split(word).join(' '), text)

// The status chips a row must show, from what it holds and not from the template's own conditions: a shortfall, a stock not known, a stock under the player's reserve, a flow with no days, a production not known, or the cover of an active row.
const statusOf = (item) => {
  const player = item.minimums.player
  const states = []

  if (item.shortfalls.length) {
    states.push('short')
  }

  if (!item.run.known) {
    states.push('unknown')
  } else if (player.recorded && item.stock !== null && item.stock < player.value) {
    states.push('below')
  } else if (!item.shortfalls.length && item.active && item.run.untimed.length) {
    states.push('untimed')
  } else if (!item.shortfalls.length && item.active && item.unknownUse.length) {
    states.push('use')
  } else if (!item.shortfalls.length && item.active) {
    states.push('covered')
  }

  return states
}

const browser = (ctx) => {
  const { screen, persisted, m, options } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  // The value of the observation, or the failure: an observation that failed in itself (the server or the browser did not start, the work threw) fails with an error of its own, which no fault is credited for; a page that raised an error nothing named fails the check on an assertion, as what the renderer does is behaviour.
  const part = (name) => {
    validate(screen, 'the observation of the screen')

    if (infrastructureFailure(screen)) {
      throw new Error(`the browser did not get through the app ${failureLine(screen)}`)
    }

    if (screen.unexpected.length) {
      throw failure(`the page raised an error nothing named ${failureLine(screen)}`)
    }

    return screen.value[name] || null
  }
  const standalone = (panel) => panel && panel.resolved && panel.visible && panel.classes.includes('resource-reserves') && panel.classes.includes('panel') && !panel.classes.includes('resource-reserves--embedded')
  const embedded = (panel) => panel && panel.resolved && panel.visible && panel.classes.includes('resource-reserves') && panel.classes.includes('resource-reserves--embedded') && !panel.classes.includes('panel')

  add('browser: Logistics draws the supplies panel once, in its own view only and on screen, as a component the page resolved, with the colonies, the place and the modifier of the page', () => {
    const seen = part('logistics')

    if (!seen) {
      return true
    }

    const drawn = Object.entries(seen.byView).map(([view, { panels }]) => [view, panels.length]).filter(([, count]) => count > 0)
    const panel = seen.byView.reserves ? seen.byView.reserves.panels[0] : undefined

    return same(drawn, [['reserves', 1]]) === true && panel.resolved && panel.visible && panel.kind === 'supplies' && panel.is.colonies && panel.is.place && panel.is.modifierOf ? true : short([drawn, panel])
  })
  add('browser: Logistics has buttons for the views the page keeps, each of which shows its view, and the views are persisted under the page\'s key', () => {
    const seen = part('logistics')

    if (!seen) {
      return true
    }

    const view = persisted.view

    return same(seen.views, ['fuel', 'maintenance', 'reserves', 'stations']) === true && Object.entries(seen.byView).every(([name, { shown }]) => name === shown) && view.key === 'logisticsView' && view.default === 'fuel' && seen.views.every((name) => view.valid(name)) && !view.valid('other') ? true : short([seen.views, Object.entries(seen.byView).map(([name, { shown }]) => [name, shown])])
  })
  add('browser: Hauling draws the minerals panel once, on screen, embedded in the Hauling plan panel, as a component the page resolved, with the colonies, the plan and the days of its hauls', () => {
    const seen = part('hauling')

    if (!seen) {
      return true
    }

    const [panel] = seen.panels

    return seen.panels.length === 1 && embedded(panel) && panel.kind === 'minerals' && panel.embedded === true && panel.is.colonies && panel.is.plan && panel.is.timed && panel.planCount > 0 && panel.timedCount === panel.planCount && panel.inPlanCard === true && panel.planCardOnScreen === true && typeof panel.cardSummary === 'string' && panel.cardSummary !== '' ? true : short(seen.panels)
  })
  add('browser: the Fill reserves switch of the Hauling plan panel is on screen and a click on it sets the page\'s switch and a second click puts it back', () => {
    const seen = part('hauling')

    if (!seen) {
      return true
    }

    const [before, once, twice] = seen.flips

    return seen.switchCount === 1 && seen.switchVisible === true && typeof before === 'boolean' && once === !before && twice === before ? true : short([seen.switchCount, seen.switchVisible, seen.flips])
  })
  add('browser: the root of the panel is a panel of its own on Logistics and flat inside the Hauling plan panel, and carries its own summary, in the UI voice and not the same for supplies and minerals', () => {
    const supplies = part('logistics') ? part('logistics').byView.reserves.panels[0] : null
    const minerals = part('hauling') ? part('hauling').panels[0] : null
    const summaries = [supplies, minerals].filter(Boolean).map((panel) => panel.summary)
    const carried = [supplies, minerals].filter(Boolean).every((panel) => typeof panel.summary === 'string' && panel.summary !== '' && panel.summary === panel.vmSummary)
    const classed = (!supplies || standalone(supplies)) && (!minerals || embedded(minerals))
    const voiced = summaries.every((text) => typeof text === 'string' && text.length > 40 && !/\d/.test(text) && !PRONOUNS.test(text)) && (summaries.length < 2 || summaries[0] !== summaries[1])

    return carried && classed && voiced ? true : short([carried, supplies && supplies.classes, minerals && minerals.classes, summaries])
  })
  add('browser: each action is a button that is on screen when its state calls for it and does what it says when it is clicked, and a record that is not applied shows its reason', () => {
    const seen = part('actions')

    if (!seen) {
      return true
    }

    const outcomes = Object.fromEntries(['newThere', 'opened', 'quiet', 'asked', 'deleted', 'conflicted', 'overwritten', 'underReview', 'confirmed', 'ahead', 'rebased'].map((name) => [name, seen[name]]))
    // A new record written by the form says it is kept: the words the alert draws read back through the panel's own words for a write (scripts/lib/browser-observe.js `labelKey`).
    const said = seen.kept && seen.kept.text !== null ? labelKey(seen.kept.text, seen.kept.words) : null

    return seen.ready === true && seen.kept && seen.kept.type === 'success' && seen.kept.said === true && seen.kept.shown === true && said === 'kept' && seen.kept.persisted === true && seen.reviewWritten === 'ok' && seen.aheadWritten === 'ok' && Object.values(outcomes).every((outcome) => outcome === true) ? true : short([seen.ready, seen.kept, said, seen.reviewWritten, seen.aheadWritten, outcomes])
  })

  // The table of a fixture as the page drew it, with the data of the same fixture that the node mounted: the quantities the table must show are the numbers of that data (and, for two fixtures, numbers worked by hand), and what is compared is each quantity as the element that draws it shows it, by its role, with whether that element is on screen.
  const tableOf = async (name) => {
    const seen = part('cells')

    if (!seen) {
      return null
    }

    if (!seen[name]) {
      throw failure(`the fixture ${name} was not mounted in the page`)
    }

    const { vm, fx } = await oracleOf(ctx, name)

    return { seen: seen[name], vm, items: vm.items, expand: fx.expand, colonies: fx.colonies, setting: seen[name].separator }
  }
  const tables = async (names = FIXTURE_NAMES) => (part('cells') ? Promise.all(names.map(async (name) => [name, await tableOf(name)])) : null)
  const unitOf = (item) => m.rl.resourceOf(item.resource).unit
  const rowsOf = (table, item) => table.seen.rows.find((row) => row.key === item.key)
  // The one cell of a kind a row draws, when it is on screen.
  const cellOf = (cells, what, problems) => {
    if (cells.length !== 1) {
      problems.push(`${what}: ${cells.length} cells`)

      return null
    }

    if (!cells[0].on) {
      problems.push(`${what} is not on screen`)

      return null
    }

    return cells[0]
  }

  add('browser: each fixture of the panel is mounted by the page, lists the rows its data lists and keeps its records', async () => {
    const all = await tables()

    if (!all) {
      return true
    }

    const problems = all.flatMap(([name, { seen, items }]) => [
      ...(seen.ready ? [] : [`${name} was not mounted`]),
      ...seen.problems.map((problem) => `${name} could not keep a record: ${problem}`),
      ...(items.length === seen.listed && same(seen.rows.map((row) => row.key).sort(), items.map((item) => item.key).sort()) === true ? [] : [`${name} lists ${short(seen.rows.map((row) => row.key))} and its data lists ${short(items.map((item) => item.key))}`]),
    ])

    return problems.length === 0 ? true : short(problems)
  })
  add('browser: the table has the three minimums as three columns in this order, each cell with its own mark, and every header is on screen', async () => {
    const all = await tables(['minerals', 'supplies'])

    if (!all) {
      return true
    }

    const headers = through('the headers of the panel', () => options.computed.headers.call({}))
    const marks = { game: 'reserveLedger.gameMinimum', class: 'reserveLedger.classMinimum', player: 'reserveLedger.player' }
    const states = { game: new Set(), class: new Set(), player: new Set() }
    const drawn = { game: new Set(), class: new Set(), player: new Set() }
    const every = { game: ['none', 'saved', 'unknown'], class: ['figure', 'none', 'partial'], player: ['none', 'set'] }
    // Every state of each column is drawn by some row, as its hook names it and as what the cell draws reads.
    const covers = (sets) => Object.keys(every).every((column) => same([...sets[column]].sort(), every[column]) === true)
    const problems = []

    all.forEach(([name, { seen }]) => {
      const shown = seen.headers.map((header) => header.text)
      const at = shown.indexOf(headers[2].text)

      if (!seen.headers.every((header) => header.on) || at < 0 || same(shown.slice(at, at + 3), headers.slice(2, 5).map((header) => header.text)) !== true) {
        problems.push([name, 'headers', seen.headers])
      }

      seen.rows.forEach((row) => Object.keys(marks).forEach((column) => {
        if (same(row.marks[column].map((mark) => mark.rule), [marks[column]]) !== true || !row.marks[column].every((mark) => mark.on)) {
          problems.push([name, row.key, column, row.marks[column]])
        }

        row[column].forEach((cell) => {
          states[column].add(cell.state)
          drawn[column].add(shownState(cell, (seen.minimumWords || {})[column], MINIMUM_FIGURES[column], seen.separator))
        })
      }))
    })

    return same(headers.map((header) => header.value).slice(2, 5), ['game', 'class', 'player']) === true && problems.length === 0 && covers(states) && covers(drawn) ? true : short([problems, ...[states, drawn].map((sets) => Object.fromEntries(Object.entries(sets).map(([column, set]) => [column, [...set]])))])
  })
  add('browser: every stock, minimum and lowest balance of a row is on screen, each quantity drawn by its own element and equal to the number the ledger holds, in its unit, and a figure that is not there draws none', async () => {
    const all = await tables()

    if (!all) {
      return true
    }

    const problems = []

    all.forEach(([name, table]) => {
      const { setting } = table
      const words = table.seen.minimumWords || {}

      table.items.forEach((item) => {
        const row = rowsOf(table, item)

        if (!row) {
          return
        }

        const unit = unitOf(item)
        const at = (what) => `${name} ${item.key} ${what}`
        // A cell that has a quantity draws it by its role, in the unit; a cell that has none draws no quantity and no digit.
        const says = (what, cell, expected) => {
          const before = problems.length

          figuresRead(at(what), cell.values, expected || {}, setting, problems)

          if (expected === null ? /\d/.test(cell.text) : !hasUnit(cell.text, unit)) {
            problems.push([at(what), cell.text, expected])
          }

          return problems.length === before
        }
        const worked = HAND[name] && HAND[name][item.key]
        const stock = cellOf(row.stock, at('stock'), problems)
        const game = cellOf(row.game, at('game minimum'), problems)
        const klass = cellOf(row.class, at('class minimum'), problems)
        const player = cellOf(row.player, at('player reserve'), problems)
        const lowest = cellOf(row.lowest, at('lowest balance'), problems)
        const { minimums, run } = item

        // The colony and the resource this row is for, as the cell says them: the colony of the fixture's own rows by the id in the key and the resource by its name in the save.
        if (!row.source.on) {
          problems.push([at('name is not on screen'), row.source])
        } else {
          namesRead(at('identity'), row.source.names, { colony: colonyName(table.colonies, Number(item.key.split(':')[0])), resource: resourceName(item.resource) }, problems)
        }

        if (stock) {
          says('stock', stock, item.stock === null ? null : { stock: item.stock })
        }

        if (game) {
          const state = !minimums.game.applies ? 'none' : minimums.game.value === null ? 'unknown' : 'saved'
          const shown = shownState(game, words.game, MINIMUM_FIGURES.game, setting)

          says('game minimum', game, state === 'saved' ? { game: minimums.game.value } : null)

          if (game.state !== state || shown !== state) {
            problems.push([at('game minimum state'), game.state, shown, state])
          }
        }

        if (klass) {
          const state = !minimums.class.applies ? 'none' : minimums.class.value === null ? 'unknown' : minimums.class.unknown > 0 ? 'partial' : 'figure'
          const shown = shownState(klass, words.class, MINIMUM_FIGURES.class, setting)

          says('class minimum', klass, state === 'partial' ? { class: minimums.class.value, 'class-unknown': minimums.class.unknown } : state === 'figure' ? { class: minimums.class.value } : null)

          if (klass.state !== state || shown !== state || (state === 'partial' && !/[A-Za-z]{3,}/.test(without(klass.text, unit, minimums.class.className)))) {
            problems.push([at('class minimum state'), klass.state, shown, state, klass.text])
          }
        }

        if (player) {
          const state = minimums.player.recorded ? 'set' : 'none'
          const shown = shownState(player, words.player, MINIMUM_FIGURES.player, setting)

          says('player reserve', player, minimums.player.recorded ? { player: minimums.player.value } : null)

          if (player.state !== state || shown !== state) {
            problems.push([at('player reserve state'), player.state, shown, state])
          }
        }

        if (lowest) {
          says('lowest balance', lowest, run.known ? { lowest: run.lowest.level, ...(run.lowest.step > 0 ? { 'lowest-day': run.lowest.step } : {}) } : null)

          // The timing is a kind (the stock now, or the stock on a day with its number) in the component's own words for it, whatever they are: the cell carries the word of its kind and not the other, and the day exactly when it is one.
          if (run.known) {
            const words = table.seen.timingWords
            const [kind, other] = run.lowest.step === 0 ? ['now', 'later'] : ['later', 'now']

            if (typeof words.now !== 'string' || typeof words.later !== 'string' || words.now === '' || words.later === '' || words.now === words.later || !lowest.text.includes(words[kind]) || (!words[kind].includes(words[other]) && lowest.text.includes(words[other]))) {
              problems.push([at('lowest balance timing'), lowest.text, words, kind])
            }
          }
        }

        if (worked) {
          // The figures worked by hand for this fixture, whatever the ledger gives: a fault of the ledger that the node's run shares is caught here.
          Object.entries({ stock, game, player, lowest }).forEach(([what, cell]) => {
            const found = cell && cell.values.find((value) => value.role === what)

            if (worked[what] !== undefined && cell && (!found || readFigure(found.text, setting) !== displayOf(worked[what]))) {
              problems.push([at(`${what} worked by hand`), found && found.text, worked[what]])
            }
          })
        }
      })
    })

    return problems.length === 0 ? true : short(problems)
  })
  add('browser: the status chips of a row are the words of the panel for what the row is in, one of each state, and no state is worded as another', async () => {
    const all = await tables()

    if (!all) {
      return true
    }

    const problems = []
    const words = all[0][1].seen.statusWords
    const keys = ['short', 'unknown', 'below', 'untimed', 'use', 'covered']

    if (same(Object.keys(words).sort(), [...keys].sort()) !== true || new Set(Object.values(words)).size !== keys.length || !Object.values(words).every((word) => typeof word === 'string' && word.trim() !== '')) {
      problems.push(['the words of the states', words])
    }

    const seenStates = new Set()

    all.forEach(([name, table]) => {
      table.items.forEach((item) => {
        const row = rowsOf(table, item)

        if (!row) {
          return
        }

        const wanted = statusOf(item)
        // What the chips say, each by its words: the words of the state, and for a shortfall the number of them.
        const said = row.chips.map((chip) => (!chip.on ? 'hidden' : keys.find((key) => key !== 'short' && chip.text === words[key]) || (chip.text.startsWith(words.short) && chip.values.length === 1 && chip.values[0].role === 'short-count' && chip.values[0].on && readFigure(chip.values[0].text, table.setting) === item.shortfalls.length ? 'short' : `other: ${chip.text}`)))

        wanted.forEach((state) => seenStates.add(state))

        if (same([...said].sort(), [...wanted].sort()) !== true) {
          problems.push([`${name} ${item.key}`, said, wanted])
        }
      })
    })

    return problems.length === 0 && same([...seenStates].sort(), [...keys].sort()) === true ? true : short([problems, [...seenStates]])
  })
  add('browser: the run of an opened row, its timeline and the shortfalls of the panel draw each amount the ledger holds in its own element, by its role, in their unit', async () => {
    const all = await tables()

    if (!all) {
      return true
    }

    const problems = []

    all.forEach(([name, table]) => {
      const { setting, seen } = table
      const shortfalls = table.vm.view ? table.vm.view.ledger.shortfalls : []
      const counted = seen.count[0]

      if (table.vm.view && (!counted || !counted.on)) {
        problems.push([`${name} count of shortfalls`, counted])
      } else if (counted) {
        figuresRead(`${name} count of shortfalls`, counted.values, { shortfalls: shortfalls.length }, setting, problems)
      }

      // A line is the shortfall of its withdrawal, matched by the identity of the withdrawal (the page keeps its records under uuids of its own, so the id of the plan, the haul or the packet is what the two share) and never by its place in the list.
      pairedLines(problems, `${name} shortfalls`, seen.shortfalls, shortfalls, (line) => idOf(line.id), (shortfall) => idOf(shortfall.withdrawal.id)).forEach(([shortfall, line]) => {
        const what = `${name} shortfall ${idOf(shortfall.withdrawal.id)}`

        if (!line.on) {
          problems.push([what, 'is not on screen'])

          return
        }

        const expected = { day: shortfall.step, wanted: shortfall.wanted, served: shortfall.served, held: shortfall.held, ...(shortfall.reason === 'reserve' ? { reserve: shortfall.reserve } : {}), ...(shortfall.kind === 'competing' && shortfall.alone.short > 1e-9 ? { alone: shortfall.alone.short } : {}) }

        figuresRead(what, line.values, expected, setting, problems)

        // The resource, the colony, the withdrawal's label and its scenario this line is about, as it says them.
        const handNames = HAND[name] && HAND[name].shortfalls && HAND[name].shortfalls[idOf(shortfall.withdrawal.id)]

        if (handNames) {
          namesRead(`${what} worked by hand`, line.names, handNames, problems)
        }

        namesRead(what, line.names, { resource: resourceName(shortfall.resource), colony: colonyName(table.colonies, shortfall.sourceId), label: shortfall.withdrawal.label, scenario: shortfall.withdrawal.scenario }, problems)

        if (!hasUnit(line.text, m.rl.resourceOf(shortfall.resource).unit)) {
          problems.push([what, 'its unit is not drawn', line.text])
        }
      })

      table.items.filter((item) => item.run.known && table.expand.includes(item.key)).forEach((item) => {
        const detail = seen.details[item.key]
        const at = (what) => `${name} ${item.key} ${what}`
        const unit = unitOf(item)

        if (!detail || !detail.on) {
          problems.push([at('detail is not on screen'), detail])

          return
        }

        const { run } = item
        const lines = [{ start: run.start, final: run.final, days: run.days }, { produced: run.produced, arrived: run.arrived, taken: run.taken, ...(run.used > 0 ? { used: run.used } : {}) }]

        // A line of the run is the one that draws the first quantity of its kind (the stock now, or what the source made), and not the one in a place of the section.
        lines.forEach((expected, index) => {
          const found = detail.run.filter((one) => one.values.some((value) => value.role === Object.keys(expected)[0]))
          const [line] = found

          if (found.length !== 1 || !line.on || !hasUnit(line.text, unit)) {
            problems.push([at(`run line ${index + 1}`), found.length, line && line.text])
          } else {
            figuresRead(at(`run line ${index + 1}`), line.values, expected, setting, problems)
          }
        })

        if (detail.run.length !== lines.length) {
          problems.push([at('run lines'), detail.run.length, lines.length])
        }

        const worked = HAND[name] && HAND[name][item.key] && HAND[name][item.key].run

        if (worked) {
          const found = (role) => detail.run.flatMap((line) => line.values).find((value) => value.role === role)

          Object.entries(worked).forEach(([role, number]) => {
            if (!found(role) || readFigure(found(role).text, setting) !== displayOf(number)) {
              problems.push([at(`${role} worked by hand`), found(role) && found(role).text, number])
            }
          })
        }

        // A line is the event of its delivery or its withdrawal, matched by its kind and the identity of what it is, and never by its place in the list.
        pairedLines(problems, at('events'), detail.events, run.events, (line) => `${line.kind}:${idOf(line.id)}`, (event) => `${event.kind}:${idOf(event.id)}`).forEach(([event, line]) => {
          const what = at(`event ${event.kind}:${idOf(event.id)}`)
          const expected = event.kind === 'arrival' ? { day: event.step, amount: event.amount, level: event.level } : { day: event.step, served: event.served, amount: event.amount, ...(event.short > 0 ? { short: event.short } : {}), level: event.level }

          if (!line.on || !hasUnit(line.text, unit)) {
            problems.push([what, 'is not on screen or draws no unit', line.text])
          } else {
            figuresRead(what, line.values, expected, setting, problems)
            namesRead(what, line.names, { label: event.label, scenario: event.scenario }, problems)

            // The label and the scenario worked by hand for the fixture whose two withdrawals share a label.
            const worked = HAND[name] && HAND[name][item.key] && HAND[name][item.key].events && HAND[name][item.key].events[idOf(event.id)]

            if (worked) {
              namesRead(`${what} worked by hand`, line.names, worked, problems)
            }
          }
        })
      })
    })

    return problems.length === 0 ? true : short(problems)
  })
  add('browser: the root of the panel carries its own summary in every state, loading or drawn, standalone or embedded', async () => {
    const all = await tables()

    if (!all) {
      return true
    }

    const problems = all.filter(([, { seen, vm }]) => !seen.root || !seen.root.on || typeof seen.root.summary !== 'string' || seen.root.summary === '' || seen.root.summary !== vm.summary).map(([name, { seen }]) => [name, seen.root])

    return problems.length === 0 ? true : short(problems)
  })

  return statements
}

const pages = (ctx) => {
  const { m, texts } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('page: Logistics passes the panel no other reads, so the page never waits for the panel', () => {
    const options = ctx.pageOptions.logistics
    const parts = (part) => [...(part.mixins || []).flatMap(parts), part]
    const reads = parts(options).flatMap((part) => [...Object.keys(part.asyncComputed || {}), ...Object.keys(part.computed || {}), ...Object.keys(part.methods || {})]).filter((name) => ['reserveObjects', 'reserveClasses', 'reservePackets'].includes(name))

    return reads.length === 0 ? true : short(reads)
  })
  add('page: Hauling works out the days of the plan\'s hauls from the freighters, the shuttle technology and the formula version the page read', () => {
    const options = ctx.pageOptions.hauling
    const days = (plan, freighters, shuttleTechnology, formulaVersion) => instantiate(options, { boundary, $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { loadErrors: {}, plan, freighters, shuttleTechnology, formulaVersion } }).plannedDays
    const hauls = { hauls: [{ key: 'h1' }, { key: 'h2' }], unmet: [] }
    const timed = days(hauls, [{ Ships: 1, days: 10 }, { Ships: 1, days: 30 }], { extra: 100 }, 1000)

    return timed.length === 2 && timed[0].haul === hauls.hauls[0] && timed[0].days === 2220 && timed[1].days === 2260 && same(days({ hauls: [], unmet: [] }, [{ Ships: 1, days: 10 }], { extra: 100 }, 1000), []) === true ? true : short(timed.map((entry) => entry.days))
  })

  add('history: the backup registers the reserve adapter, so a restore in a session that never opened the Logistics page keeps the records', async () => {
    const warm = world(m)

    await kept(m, warm, scope(), await open(m, SAVE()), { reserves: { Duranium: 0 }, plans: [plan('p1', 'Build', 5, 3)] })

    const bundle = warm.repo.exportRecords(scope())
    const target = { campaignId: 'c2', RaceID: RACE, branch: 'b1' }
    const restored = (registered) => {
      const registry = m.records.createAdapterRegistry()

      if (registered) {
        m.rr.registerResourceReserves(registry.register)
      }

      const repo = m.records.createRepository({ storage: memory().storage, adapters: registry, newId: () => uuid(900), now: () => 5000 })
      const preview = repo.previewImport(bundle, target, { restore: true })

      return { rejected: preview.rejected, imported: preview.importable ? repo.importRecords(bundle, target, { preview, restore: true }).imported.length : 0 }
    }
    // The page's own backupAnnotations is run, and the restore is previewed through the adapter it returns.
    const through = async (options) => {
      const { adapter, error } = await instantiate(options, { boundary, $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: {} }).backupAnnotations()

      if (!adapter) {
        return { error }
      }

      const preview = adapter.preview(bundle, target, { restore: true })

      return { error, rejected: preview.rejected, importable: preview.importable }
    }
    const cold = restored(false)
    const registered = restored(true)
    const page = await through(ctx.pageOptions.history)

    return cold.rejected === 1 && cold.imported === 0 && registered.rejected === 0 && registered.imported === 1 && page.error === null && page.rejected === 0 && page.importable === 1 ? true : short([cold, registered, page])
  })
  add('history: a page whose backup does not register the reserve adapter rejects the records on a restore, so the check above tells the two apart', async () => {
    const warm = world(m)

    await kept(m, warm, scope(), await open(m, SAVE()), { reserves: { Duranium: 0 }, plans: [plan('p1', 'Build', 5, 3)] })

    const bundle = warm.repo.exportRecords(scope())
    const options = await loadPage('pages/history', { stubs: STUBS, dynamicImports: true, sources: { 'pages/history': texts.history.replace(/^ *reserves\.registerResourceReserves\(.*\)\n/m, ''), ...ctx.pageUtilities, ...recordsOf(`without ${ctx.serial}`) } })
    const { adapter, error } = await instantiate(options, { boundary, $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: {} }).backupAnnotations()
    const preview = adapter && adapter.preview(bundle, { campaignId: 'c2', RaceID: RACE, branch: 'b1' }, { restore: true })

    return error === null && preview && preview.rejected === 1 && !preview.importable ? true : short([error, preview && preview.rejected, preview && preview.importable])
  })

  return statements
}

// ---------- the planted faults ----------

// The template of a single-file component (the text before its script) with another spelling of every binding: a bound prop long-hand with its expression in parentheses and a listener long-hand. A `.sync` prop is left alone, as its expression is assigned to.
const longhand = (text) => {
  const end = text.indexOf('\n<script')

  return text.slice(0, end).replace(/(\s):([A-Za-z][\w:-]*)="([^"]*)"/g, '$1v-bind:$2="($3)"').replace(/(\s)@([A-Za-z][\w:.-]*)="/g, '$1v-on:$2="') + text.slice(end)
}

// The template with every static text of an element restated: the words change and nothing else does.
const restated = (text) => {
  const end = text.indexOf('\n<script')

  return text.slice(0, end).replace(/>([A-Z][^<>{}"]*[a-z.])</g, '>$1, restated<') + text.slice(end)
}

// The mixin with each of the words that name a failed read restated from what it declares now.
const relabelled = (text) => text.replace(/export const RESERVE_LABELS = \{[^}]*\}/, (block) => block.replace(/: '((?:[^'\\]|\\.)*)'/g, (_match, inner) => `: '${inner}, as the panel names it'`))

// The template with the `v-model` of each switch and toggle written as the prop and the event the component takes its value through (a switch: `input-value` and `change`; a toggle: `value` and `change`).
const explicitModels = (text) => {
  const end = text.indexOf('\n<script')

  return text.slice(0, end).replace(/<(v-switch) v-model="([^"]+)"/g, '<$1 :input-value="$2" @change="$2 = $event"').replace(/<(v-btn-toggle) v-model="([^"]+)"/g, '<$1 :value="$2" @change="$2 = $event"') + text.slice(end)
}

// The template with every condition in parentheses.
const parenthesised = (text) => {
  const end = text.indexOf('\n<script')

  return text.slice(0, end).replace(/(\sv-(?:if|else-if|show))="([^"]*)"/g, '$1="($2)"') + text.slice(end)
}

// The template with the components it names written in Pascal case, which Vue resolves to the same components.
const pascalTags = (text) => {
  const end = text.indexOf('\n<script')

  return text.slice(0, end).replace(/<(\/?)(resource-reserves|reserves-panel|provenance-mark|v-btn|v-card|v-switch)(?=[\s>/])/g, (_match, slash, tag) => `<${slash}${tag.replace(/(^|-)(\w)/g, (_part, _dash, letter) => letter.toUpperCase())}`) + text.slice(end)
}

// The pages with the panel registered under another name (`ReservesPanel`) and written as that tag, which Vue resolves to the same component.
const aliased = (text) => text.replace('<resource-reserves ', '<reserves-panel ').replace(' ResourceReserves, ', ' ReservesPanel: ResourceReserves, ')

// The generated prose of the panel with synonyms for its verbs and its leads.
const SYNONYMS = [[' wanted ', ' asked for '], [' and got ', ' and was given '], ['Not counted, ', 'Left out, '], [' brings ', ' delivers '], [' takes ', ' draws '], ['the stock held only', 'the stock had only'], ['`reserve ${reserves.join', '`reserves ${reserves.join'], ['Delivered less than planned: ', 'Short of the plan: ']]
const synonyms = (text) => SYNONYMS.reduce((result, [from, to]) => result.split(from).join(to), text)

// One equivalent rewrite of each family, made together so that the screen is read once for all of them. The families the lane brief names: each switch and toggle written as a prop and an event instead of `v-model`, each binding and listener written long-hand, each condition in parentheses, a button listening for the native click, the panel registered under another name on both pages, a qualifier moved after its figure, and the generated prose and the words of the panel and its mixin restated. The controls the reviews of the panel asked for: every static text of the panel and both pages restated, every component they name written in Pascal case, a root class written as an object, a scoped slot written with `v-slot`, a container shown by a `v-show` that is always true, the reason, its container, the actions, the table and the lowest amount at full opacity and the player reserve and the amount made displayed inline, a figure written by the formatter itself, with a trailing point zero or with an explicit plus, the run line worded in another order with each quantity keeping its role, the shortfalls listed in reverse, the zero day worded another way, a word drawn by `v-text` or picked by its key, a condition turned round, every click listener with the stop and prevent modifiers, the scenario of an event through an equivalent expression, the props of both mounts in another order, the embedded flag bound as true, a prop written in camel case, the panel put in the default slot of a sheet by name and the Hauling switch labelled with other words. Where two of them meet on one element both are made on it, and no two change the same text otherwise, so a check that reads what one of them changes fails here as it fails on that one alone.
/* eslint-disable no-template-curly-in-string */
const EQUIVALENT_PATCHES = {
  component: [
    ["`${shipClass.unknown > 0 ? 'at least ' : ''}${this.figure(shipClass.value)} ${this.unitOf(item.resource)}${shipClass.className", "`${this.figure(shipClass.value)}${shipClass.unknown > 0 ? ' or more' : ''} ${this.unitOf(item.resource)}${shipClass.className"],
    ["covered: 'Covered' }", "covered: 'Within the reserves' }"],
    [":class=\"['resource-reserves', embedded ? 'resource-reserves--embedded' : 'panel']\"", ":class=\"{ 'resource-reserves': true, 'resource-reserves--embedded': embedded, panel: !embedded }\""],
    ['<div class="resource-reserves__actions">\n            <v-btn x-small text :disabled="busy" data-reserve-edit', '<div v-show="true" style="opacity: 1" class="resource-reserves__actions">\n            <v-btn x-small text :disabled="busy" data-reserve-edit'],
    ['data-reserve-new @click="startNew">', 'data-reserve-new @click.native="startNew">'],
    ['<div v-if="!entry.applied" class="caption" data-reserve-reason>{{ entry.reason }}</div>', '<div style="opacity: 1"><div v-if="!entry.applied" class="caption" data-reserve-reason style="opacity: 1">{{ entry.reason }}</div></div>'],
    ['data-reserve-value="player">{{ figure(item.minimums.player.value) }}', 'data-reserve-value="player">{{ count(item.minimums.player.value, Number.isInteger(item.minimums.player.value) ? 0 : 1) }}'],
    ['class="resource-reserves__table" data-reserve-table>', 'class="resource-reserves__table" data-reserve-table style="opacity: 1">'],
    ['class="text-no-wrap" data-reserve-player="set">', 'class="text-no-wrap" data-reserve-player="set" style="display: inline">'],
    ["'The record is kept.'", "'The record was kept.'"],
    ['    figure(value) {\n      return this.count(value, Number.isInteger(value) ? 0 : 1)\n    },', '    figure(value) {\n      return Number.isInteger(value) ? `${this.count(value, 0)}.0` : this.count(value, 1)\n    },'],
    ['Stock now <span data-reserve-value="start">{{ figure(item.run.start) }}</span> {{ unitOf(item.resource) }}, <span data-reserve-value="final">{{ figure(item.run.final) }}</span> {{ unitOf(item.resource) }} on day <span data-reserve-value="days">{{ count(item.run.days) }}</span>.', 'On day <span data-reserve-value="days">{{ count(item.run.days) }}</span> the stock ends at <span data-reserve-value="final">{{ figure(item.run.final) }}</span> {{ unitOf(item.resource) }}, from <span data-reserve-value="start">{{ figure(item.run.start) }}</span> {{ unitOf(item.resource) }} now.'],
    ['v-for="shortfall in view.ledger.shortfalls"', 'v-for="shortfall in [...view.ledger.shortfalls].reverse()"'],
    ["const TIMING_WORDS = { now: 'now', later: 'on day' }", "const TIMING_WORDS = { now: 'at present', later: 'on day' }"],
    ['<span data-reserve-value="lowest">{{ figure(item.run.lowest.level) }}</span>', '<span data-reserve-value="lowest"><span style="opacity: 1">{{ item.run.lowest.level > 0 ? \'+\' : \'\' }}{{ figure(item.run.lowest.level) }}</span></span>'],
    ['<span data-reserve-value="produced">', '<span data-reserve-value="produced" style="display: inline">'],
    ['item.active && item.run.untimed.length', 'item.run.untimed.length && item.active'],
    ['<span data-reserve-name="scenario">{{ event.scenario }}</span>', '<span data-reserve-name="scenario">{{ [event.scenario].join(\'\') }}</span>'],
    ['data-reserve-game="none" :title="item.minimums.game.why">{{ minimumWords.game.none }}</span>', 'data-reserve-game="none" :title="item.minimums.game.why" v-text="minimumWords.game.none"></span>'],
    ["this.say(draft.uuid ? SAVE_WORDS.saved : SAVE_WORDS.kept, 'success')", "this.say(SAVE_WORDS[draft.uuid ? 'saved' : 'kept'], 'success')"],
  ],
  logistics: [['<resource-reserves :key="`${GameID}-${RaceID}`" kind="supplies" :colonies="colonies" :place="place" :modifier-of="modifierOf" />', '<v-sheet><resource-reserves slot="default" :key="`${GameID}-${RaceID}`" :modifierOf="modifierOf" :place="place" :colonies="colonies" kind="supplies" /></v-sheet>']],
  hauling: [['label="Fill reserves"', 'label="Fill saved reserves"'], ['embedded kind="minerals" :colonies="colonies" :plan="plan" :timed="plannedDays" />', ':embedded="true" kind="minerals" :timed="plannedDays" :plan="plan" :colonies="colonies" />']],
  mixin: [],
}
/* eslint-enable no-template-curly-in-string */

const equivalents = (text, name) => {
  const own = EQUIVALENT_PATCHES[name].reduce((current, [find, replace]) => patched(path.basename(FILES[name]), current, find, replace), text)

  if (name === 'mixin') {
    return relabelled(own)
  }

  return pascalTags(parenthesised(longhand(explicitModels(restated(name === 'component' ? synonyms(own.replace(/<template #\[/g, '<template v-slot:[').replace(/ @click="/g, ' @click.stop.prevent="')) : aliased(own))))))
}

// An entry with `benign: true` is an equivalent rewrite of the source: the checks it names must all keep passing, so a check that reads the wording or the shape of the source instead of what it does is caught here. An entry with `files` and `rewrite` rewrites each of those sources by a function of its text and its name.
const MUTATIONS = [
  { name: 'a withdrawal that ignores the reserve', file: 'ledger', find: 'const served = Math.min(withdrawal.amount, Math.max(0, before - line.keep))', replace: 'const served = Math.min(withdrawal.amount, Math.max(0, before))', fails: ['stock'] },
  { name: 'a shortfall that always blames the stock', file: 'ledger', find: "reason: before >= withdrawal.amount - EPSILON ? 'reserve' : 'stock'", replace: "reason: 'stock'", fails: ['stock'] },
  { name: 'a delivery counted on the tick before its day', file: 'ledger', find: 'export const tickOf = (day) => Math.max(1, Math.ceil(day - EPSILON))', replace: 'export const tickOf = (day) => Math.max(1, Math.floor(day))', fails: ['tick'] },
  { name: 'a delivery counted one tick late', file: 'ledger', find: ';(line.landing.get(step) || []).forEach((arrival) => {', replace: ';(line.landing.get(step - 1) || []).forEach((arrival) => {', fails: ['tick'] },
  { name: 'a delivery after the period counted on the last tick', file: 'ledger', find: '} else if (tickOf(arrival.day) > days) {', replace: '} else if (false) {', fails: ['tick'] },
  { name: 'a delivery with no time read as invalid, not as untimed', file: 'ledger', find: 'else if (arrival.day === null || arrival.day === undefined) {', replace: 'else if (false) {', fails: ['tick'] },
  { name: 'a combined run that leaves out every scenario but the first', file: 'ledger', find: 'const withdrawals = [...records.flatMap((record) => record.withdrawals), ...planned]', replace: 'const withdrawals = [...records.slice(0, 1).flatMap((record) => record.withdrawals), ...planned]', fails: ['combined'] },
  { name: 'a shortfall that is never named as competing', file: 'ledger', find: "kind: competing ? 'competing' : 'own'", replace: "kind: 'own'", fails: ['combined'] },
  { name: 'a rival that is never named', file: 'ledger', find: 'const near = competing ? rivalsOf(run, event, own, records) : { drew: [], reserved: [] }', replace: 'const near = { drew: [], reserved: [] }', fails: ['combined'] },
  { name: 'a player reserve that is the smallest of the scenarios', file: 'ledger', find: 'const maxOf = (values) => (values.length ? Math.max(...values) : null)', replace: 'const maxOf = (values) => (values.length ? Math.min(...values) : null)', fails: ['combined'] },
  { name: 'a scenario not picked that still counts', file: 'ledger', find: 'const chosen = entries.filter((entry) => !names || names.includes(entry.scenario))', replace: 'const chosen = entries', fails: ['combined'] },
  { name: 'a shortfall that names no day', file: 'ledger', find: 'step: event.step, day: event.day,', replace: 'step: 0, day: null,', fails: ['shortfall'] },
  { name: 'a shortfall that names no withdrawal', file: 'ledger', find: 'withdrawal: { id: event.id, label: event.label, scenario: event.scenario }', replace: 'withdrawal: { id: null, label: null, scenario: null }', fails: ['shortfall'] },
  { name: 'a plan that still counts when it is not counted', file: 'ledger', find: 'const planned = planOn ? (feed.withdrawals || []) : []', replace: 'const planned = feed.withdrawals || []', fails: ['plan'] },
  { name: 'a plan whose deliveries still count when it is not counted', file: 'ledger', find: "const gameArrivals = (feed.arrivals || []).filter((arrival) => planOn || arrival.source !== 'haul')", replace: 'const gameArrivals = feed.arrivals || []', fails: ['plan'] },
  { name: 'a reserve of 0 read as none set', file: 'ledger', find: 'const reserves = records.filter((record) => record.reserve !== null)', replace: 'const reserves = records.filter((record) => record.reserve !== null && record.reserve > 0)', fails: ['zero'] },
  { name: 'a reserve of 0 dropped from the record', file: 'reserves', find: "amount !== null && amount !== undefined && amount !== ''", replace: 'amount', fails: ['zero'] },
  { name: 'a game minimum shown for the fuel of a colony', file: 'feeds', find: "if (resource === 'fuel' || resource === 'msp') {", replace: 'if (false) {', fails: ['minimums'] },
  { name: 'a class minimum shown for a mineral', file: 'feeds', find: 'if (!column) {', replace: 'if (false) {', fails: ['minimums'] },
  { name: 'a class minimum that is the smallest', file: 'feeds', find: '(!best || shipClass[column] > best[column] ? shipClass : best)', replace: '(!best || shipClass[column] < best[column] ? shipClass : best)', fails: ['minimums'] },
  { name: 'the player reserve folded into the game minimum', file: 'ledger', find: 'minimums: { game: feed.minimums ? feed.minimums.game : null,', replace: 'minimums: { game: feed.minimums && player !== null ? { ...feed.minimums.game, value: player } : feed.minimums ? feed.minimums.game : null,', fails: ['minimums'] },
  { name: 'the hauls of the plan that are not timed from the freighters', file: 'feeds', find: 'const days = timed && timed[index] && isNumber(timed[index].days) ? timed[index].days : null', replace: 'const days = 0', fails: ['feeds'] },
  { name: 'a packet that lands at once', file: 'feeds', find: 'day: timing.days,', replace: 'day: 0,', fails: ['feeds'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a draw of the plan taken from the colony that receives', file: 'feeds', find: 'push(withdrawals, `${haul.from.PopulationID}:${mineral.name}`', replace: 'push(withdrawals, `${haul.to.PopulationID}:${mineral.name}`', fails: ['feeds'] },
  { name: 'a second record of a colony and scenario that is let through', file: 'reserves', find: 'if (!entry && listedAt(scope.branchId).length) {', replace: 'if (false) {', fails: ['record'] },
  { name: 'a record under review that applies', file: 'reserves', find: 'const applied = !ahead && state === VERDICTS.HELD', replace: 'const applied = !ahead', fails: ['record'] },
  { name: 'an edit from one panel that drops the lines of another', file: 'reserves', find: 'const kept = payload.plans.filter((plan) => !resources.includes(plan.resource))', replace: 'const kept = []', fails: ['record'] },
  { name: 'a scenario that may take the name of the plan', file: 'reserves', find: 'return scenario.toLowerCase() === PLAN_SCENARIO.toLowerCase() ?', replace: 'return false ?', fails: ['plan'] },
  { name: 'a record read under every race', file: 'reserves', find: 'listed = repository.list(scope, { kind: RESERVE_KIND, context: context || undefined })', replace: 'listed = repository.list({ ...scope, RaceID: scope.RaceID + 1 }, { kind: RESERVE_KIND, context: context || undefined })', fails: ['record'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a select that writes', file: 'reserves', find: 'const [rows] = await database.query(COLONY.sql, { replacements: { GameID, RaceID } })', replace: 'const [rows] = await database.query(`update FCT_Population set PopName = PopName; ${COLONY.sql}`, { replacements: { GameID, RaceID } })', fails: ['loaders'] },
  { name: 'a class read that hides its failure', file: 'feeds', find: 'const [rows] = await database.query(CLASS_SQL, { replacements: { GameID, RaceID } })', replace: 'const [rows] = await database.query(CLASS_SQL, { replacements: { GameID, RaceID } }).catch(() => [[]])', fails: ['loaders'] },
  { name: 'a panel with no summary of its own', file: 'component', find: ':data-summary="summary" data-reserve-panel>', replace: 'data-reserve-panel>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel that shows the three minimums in one column', file: 'component', find: "{ text: 'Class minimum (reference)', value: 'class' },", replace: '', fails: ['component'] },
  { name: 'a panel that waits on no read of the colonies', file: 'mixin', find: "return this.kind === 'minerals' ? ['reserveObjects', 'reserveClasses', 'reservePackets', 'reserveSupply', 'populationProductionModifiers'] : ['reserveObjects', 'reserveClasses']", replace: "return this.kind === 'minerals' ? ['reserveClasses', 'reservePackets', 'reserveSupply', 'populationProductionModifiers'] : ['reserveClasses']", fails: ['component'] },
  { name: 'a read of the packets for supplies', file: 'mixin', find: "if (!database || !GameID || !RaceID || this.kind !== 'minerals') {\n          return null\n        }\n\n        return Object.freeze({ packets:", replace: 'if (!database || !GameID || !RaceID) {\n          return null\n        }\n\n        return Object.freeze({ packets:', fails: ['component'] },
  { name: 'a panel that is ready before the supplies and the production rates are in', file: 'mixin', find: 'this.reservePacketsBundle && this.reserveSupplyBundle && this.loadErrors.populationProductionModifiers === null', replace: 'this.reservePacketsBundle', fails: ['component'] },
  { name: 'a minerals panel that takes the supplies from the colonies the host read', file: 'component', find: "this.kind === 'supplies' ? this.colonies : this.reserveSupplyBundle.colonies", replace: 'this.colonies', fails: ['component'] },
  { name: 'a minerals panel that never uses the production rates it read', file: 'component', find: 'modifierOf: this.modifierOf || this.productionModifierOf', replace: 'modifierOf: this.modifierOf || (() => null)', fails: ['component'] },
  { name: 'a panel that does not say which production is not known', file: 'component', find: "...(item.unknownUse.length ? [{ key: 'use',", replace: "...(false ? [{ key: 'use',", fails: ['component'] },
  { name: 'a mount on the Logistics page of the wrong group', file: 'logistics', find: 'kind="supplies" :colonies="colonies"', replace: 'kind="minerals" :colonies="colonies"', fails: ['browser'] },
  { name: 'a Logistics view that the page does not keep', file: 'logistics', find: "reserves: 'Reserves', stations: 'Fleet stations' }", replace: "stations: 'Fleet stations' }", fails: ['browser'] },
  { name: 'a table that lists the sources in the order of the feeds', file: 'component', find: 'const rank = (row) => (row.shortfalls.length ? 0 : row.active ? 1 : 2)', replace: 'const rank = () => 0', fails: ['component'] },
  { name: 'a shortfall short alone that a rival made worse, named as its own', file: 'ledger', find: 'const competing = worse > EPSILON', replace: 'const competing = aloneServed >= event.amount - EPSILON', fails: ['combined'] },
  { name: 'a destination credited the whole haul whatever the source gave', file: 'ledger', find: 'add(taker.landing, tick, { ...arrival, amount: served })', replace: 'add(taker.landing, tick, arrival)', fails: ['haul'] },
  { name: 'a haul credited whole because it is never tied to its withdrawal', file: 'ledger', find: "const linked = (arrival) => arrival.source === 'haul' && leaving.has(arrival.id)", replace: 'const linked = () => false', fails: ['haul'] },
  { name: 'a haul credited a tick after the tick its day gives', file: 'ledger', find: 'const tick = deferred.has(withdrawal.id) ? step + 1 : Math.max(tickOf(arrival.day), step)', replace: 'const tick = deferred.has(withdrawal.id) ? step + 1 : Math.max(tickOf(arrival.day), step + 1)', fails: ['haul'] },
  { name: 'a haul credited on a tick before it leaves', file: 'ledger', find: 'const tick = deferred.has(withdrawal.id) ? step + 1 : Math.max(tickOf(arrival.day), step)', replace: 'const tick = deferred.has(withdrawal.id) ? step + 1 : tickOf(arrival.day)', fails: ['haul'] },
  { name: 'stocks taken in the order of the feeds, not the order the hauls of a tick need', file: 'ledger', find: '    return order\n', replace: '    return running\n', fails: ['haul'] },
  { name: 'a cycle of hauls whose deliveries land on the tick they leave, which has passed for the stock that ran before', file: 'ledger', find: 'const tick = deferred.has(withdrawal.id) ? step + 1 : Math.max(tickOf(arrival.day), step)', replace: 'const tick = deferred.has(withdrawal.id) ? step : Math.max(tickOf(arrival.day), step)', fails: ['haul'] },
  { name: 'a delivery counted for a haul that never leaves in the period', file: 'ledger', find: 'const leaving = new Set(items.flatMap((item) => (item.withdrawals || []).filter((withdrawal) => withdrawal.source === \'haul\').map((withdrawal) => withdrawal.id)))', replace: 'const leaving = new Set(running.flatMap((line) => [...line.due.values()].flat().filter((withdrawal) => withdrawal.source === \'haul\').map((withdrawal) => withdrawal.id)))', fails: ['haul'] },
  { name: 'a baseline that runs every scenario and not the scenario alone', file: 'ledger', find: 'const use = scenario === PLAN_SCENARIO ? [] : chosen.filter((entry) => entry.scenario === scenario)', replace: 'const use = chosen', fails: ['haul', 'combined'] },
  { name: 'a baseline that never runs without the plan', file: 'ledger', find: 'baselines.set(scenario, [simulate(use, countPlan), ...(hasPlan ? [simulate(use, false)] : [])])', replace: 'baselines.set(scenario, [simulate(use, countPlan)])', fails: ['plan'] },
  { name: 'a rival upstream of a haul that is never named', file: 'ledger', find: 'const far = competing ? upstreamOf(index, event.step, new Map(), event.scenario) : { drew: [], reserved: [] }', replace: 'const far = { drew: [], reserved: [] }', fails: ['haul'] },
  { name: 'a rival upstream through a haul that could not have delivered by the shortfall', file: 'ledger', find: 'base[index].run.cut.filter((cut) => cut.tick <= until).forEach((cut) => {', replace: 'base[index].run.cut.forEach((cut) => {', fails: ['haul'] },
  { name: 'a rival upstream through a delivery to a source after its haul left', file: 'ledger', find: 'upstreamOf(departure.index, departure.event.step, seen, affected)', replace: 'upstreamOf(departure.index, Infinity, seen, affected)', fails: ['haul'] },
  { name: 'a lowest level that never follows a withdrawal', file: 'ledger', find: 'if (line.held < line.lowest.level) {', replace: 'if (false) {', fails: ['stock'] },
  { name: 'production that goes on after its inputs are spent', file: 'ledger', find: 'const made = Math.min(line.daily, room)', replace: 'const made = line.daily', fails: ['stock', 'feeds'] },
  { name: 'production that spends a private budget instead of the stock the withdrawals draw on', file: 'ledger', find: 'line.shared = inputs.length > 0 && inputs.every((input) => input.line && input.line !== line) ? inputs : null', replace: 'line.shared = null', fails: ['combined', 'component'] },
  { name: 'production that makes from the stock but never takes it', file: 'ledger', find: 'input.line.held -= used', replace: 'input.line.held -= 0', fails: ['combined', 'component'] },
  { name: 'a scenario that exports an input never named a rival of the production', file: 'ledger', find: 'rivals: { drew: unique([...near.drew, ...far.drew, ...supply.drew])', replace: 'rivals: { drew: unique([...near.drew, ...far.drew])', fails: ['combined'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'fuel refining that draws on no Sorium', file: 'feeds', find: 'productionInputs: [{ key: `${colony.PopulationID}:Sorium`, perUnit: 1 / LITRES_PER_TON }]', replace: 'productionInputs: []', fails: ['combined'] },
  { name: 'a withdrawal of an input on the tick of the shortfall named a rival of it', file: 'ledger', find: 'event.served > 0 && event.step < until', replace: 'event.served > 0 && event.step <= until', fails: ['combined'] },
  { name: 'production from shared stocks that stops at the lifetime of the opening stock', file: 'ledger', find: 'line.daily > 0 && (line.shared || (line.known &&', replace: 'line.daily > 0 && ((line.known &&', fails: ['combined'] },
  { name: 'a production that cannot be worked out never listed on the stock it would draw on', file: 'ledger', find: ' && !isNumber(other.production)).map((other) => ({ key: other.key', replace: ').map((other) => ({ key: other.key', fails: ['combined', 'component'] },
  { name: 'a destination of a counted haul that is not listed with no record', file: 'ledger', find: ' || (planOn && (feed.arrivals || []).some((arrival) => arrival.source === \'haul\'))', replace: '', fails: ['combined', 'component'] },
  { name: 'a reserve upstream that is a rival whatever the short scenario keeps there', file: 'ledger', find: 'ownReserve(from.records, affected)', replace: '0', fails: ['haul'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a class minimum that is shown whole, with nothing said of the classes that record none', file: 'component', find: '      if (!shipClass.applies) {\n        return shipClass.why\n      }\n', replace: '      if (!shipClass.applies) {\n        return shipClass.why\n      }\n\n      if (shipClass.unknown > 0) {\n        return this.classText({ ...item, minimums: { ...item.minimums, class: { ...shipClass, unknown: 0 } } })\n      }\n', fails: ['component'] },
  { name: 'a supplies feed made without a budget of inputs', file: 'feeds', find: 'productionBudget: makes > 0 && limits.every(isNumber) ? Math.min(...limits) : null', replace: 'productionBudget: null', fails: ['feeds'] },
  { name: 'a record widened to the campaign that skips the check of the other branches', file: 'reserves', find: "if (policy === 'campaign' && (!entry || entry.policy !== 'campaign')) {", replace: "if (policy === 'campaign' && !entry) {", fails: ['record'] },
  { name: 'two records of one colony and scenario that both apply', file: 'reserves', find: 'if (entry.overlap > 0) {', replace: 'if (false) {', fails: ['record'] },
  { name: 'a panel that leaves out what a haul delivered less than planned', file: 'component', find: "...(item.cut.length ? [{ key: 'cut',", replace: "...(false ? [{ key: 'cut',", fails: ['component'] },
  { name: 'a backup that leaves the reserve adapter unregistered', file: 'history', find: '        reserves.registerResourceReserves(records.registerAdapter)\n', replace: '', fails: ['history'] },
  { name: 'a row with an untimed flow that reads as covered', file: 'component', find: 'item.active && item.run.untimed.length', replace: 'false', fails: ['browser'], parts: ['cells'] },
  { name: 'a Hauling page that times the hauls without the shuttle technology', file: 'hauling', find: 'timeHauls({ plan, freighters, shuttleTechnology, formulaVersion })', replace: 'timeHauls({ plan, freighters, shuttleTechnology: { extra: 0 }, formulaVersion })', fails: ['page'] },
  { name: 'a Logistics page that shows the panel in the wrong view', file: 'logistics', find: '<template v-else-if="view === \'reserves\'">', replace: '<template v-else-if="view === \'stations\'">', fails: ['browser'] },
  { name: 'a backup that registers the reserve adapter through a wrapper', file: 'history', find: 'reserves.registerResourceReserves(records.registerAdapter)', replace: 'reserves.registerResourceReserves((adapter) => records.registerAdapter(adapter))', fails: ['history'], benign: true },
  { name: 'a panel that speaks in the second person', file: 'component', find: 'No source has a record or a plan. Keep a record, or show every source.', replace: 'You have no record or plan. Keep a record, or show every source.', fails: ['voice'] },
  { name: 'a fuel output held to the Sorium the colony has now, so a refinery that starts empty never refines', file: 'feeds', find: 'const fuel = isNumber(colony.Sorium) ? capacity : refineryYield(colony, modifier)', replace: 'const fuel = refineryYield(colony, modifier)', fails: ['feeds', 'combined'] },
  { name: 'a refinery with no Sorium feed that goes on refining the Sorium it has not got', file: 'feeds', find: 'isNumber(colony.Sorium) && colony.Sorium < 1 ? 0 : isAvailable(lasts)', replace: 'isAvailable(lasts)', fails: ['feeds', 'combined'] },
  { name: 'production of a source whose own stock is not in the save that takes nothing from its inputs', file: 'ledger', find: 'if (line.daily > 0 && (line.shared || (line.known &&', replace: 'if (line.known && line.daily > 0 && (line.shared || (line.known &&', fails: ['combined', 'component'] },
  { name: 'production that is not limited by the balance its inputs hold on the tick', file: 'ledger', find: 'Math.min(...line.shared.map((input) => Math.max(0, input.line.held) / input.perUnit))', replace: 'line.daily', fails: ['combined'] },
  { name: 'a panel whose Use in this save button confirms the colony instead', file: 'component', find: 'data-reserve-rebase @click="rebase(entry)">', replace: 'data-reserve-rebase @click="confirm(entry)">', fails: ['browser'], parts: ['actions'] },
  { name: 'a panel whose Retry reads every read again', file: 'mixin', find: 'this.reserveFailedKeys.forEach((key) => this.$asyncComputed[key].update())', replace: 'this.reserveInputs.forEach((key) => this.$asyncComputed[key].update())', fails: ['component'] },
  { name: 'a read with no label', file: 'mixin', find: "  reserveClasses: 'the ship classes',\n", replace: '', fails: ['component'] },
  { name: 'a Logistics page whose panel is hidden by a v-show', file: 'logistics', find: '<resource-reserves :key=', replace: '<resource-reserves v-show="false" :key=', fails: ['browser'] },
  { name: 'a Hauling page whose Fill reserves switch takes its value from the plan and writes it nowhere', file: 'hauling', find: '<v-switch v-model="planReserves" label="Fill reserves"', replace: '<v-switch :input-value="planReserves" label="Fill reserves"', fails: ['browser'] },
  { name: 'a panel whose root never has the panel class', file: 'component', find: ":class=\"['resource-reserves', embedded ? 'resource-reserves--embedded' : 'panel']\"", replace: ":class=\"['resource-reserves', embedded ? 'resource-reserves--embedded' : 'card']\"", fails: ['browser'], parts: ['logistics'] },
  { name: 'a Logistics page that names the panel in a casing Vue does not resolve', file: 'logistics', find: '<resource-reserves :key=', replace: '<ResourceRESERVES :key=', fails: ['browser'] },
  { name: 'a Logistics page that registers another component under the name of the panel', file: 'logistics', find: 'PageLink, ProvenanceMark, ResourceReserves, SeriesKey', replace: 'PageLink, ProvenanceMark, ResourceReserves: SeriesKey, SeriesKey', fails: ['browser'] },
  { name: 'a Logistics page whose view of the panel is hidden above it', file: 'logistics', find: "<template v-else-if=\"view === 'reserves'\">", replace: '<template v-else-if="false">', fails: ['browser'] },
  { name: 'a Hauling page that puts the panel in a named slot the card never renders', file: 'hauling', find: '<resource-reserves :key=', replace: '<resource-reserves slot="not-rendered" :key=', fails: ['browser'] },
  { name: 'a panel whose entry actions are hidden by a v-show on their container', file: 'component', find: '<div class="resource-reserves__actions">\n            <v-btn x-small text :disabled="busy" data-reserve-edit', replace: '<div v-show="false" class="resource-reserves__actions">\n            <v-btn x-small text :disabled="busy" data-reserve-edit', fails: ['browser'], parts: ['actions'] },
  { name: 'a panel whose player reserve is shown ten more than the ledger holds', file: 'component', find: 'data-reserve-value="player">{{ figure(item.minimums.player.value) }}', replace: 'data-reserve-value="player">{{ figure(item.minimums.player.value + 10) }}', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose status chip of an untimed flow says Covered', file: 'component', find: 'data-reserve-untimed-chip>{{ statusWords.untimed }}</v-chip>', replace: 'data-reserve-untimed-chip>Covered</v-chip>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose table is drawn with no opacity', file: 'component', find: 'class="resource-reserves__table" data-reserve-table>', replace: 'class="resource-reserves__table" data-reserve-table style="opacity: 0">', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose lowest amount is wrapped in a span drawn with no opacity', file: 'component', find: '<span data-reserve-value="lowest">{{ figure(item.run.lowest.level) }}</span>', replace: '<span data-reserve-value="lowest"><span style="opacity: 0">{{ figure(item.run.lowest.level) }}</span></span>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose lowest balance is shown with the sign turned over', file: 'component', find: '<span data-reserve-value="lowest">{{ figure(item.run.lowest.level) }}</span>', replace: '<span data-reserve-value="lowest">{{ figure(-item.run.lowest.level) }}</span>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel that writes the first hyphen of a figure as the Unicode minus sign, the separator of a Dash-grouped figure included', file: 'component', find: '    figure(value) {\n      return this.count(value, Number.isInteger(value) ? 0 : 1)\n    },', replace: '    figure(value) {\n      return this.count(value, Number.isInteger(value) ? 0 : 1).replace(\'-\', \'\\u2212\')\n    },', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose wanted amount and served amount of a shortfall are exchanged', file: 'component', find: 'wanted <span data-reserve-value="wanted">{{ figure(shortfall.wanted) }}</span> {{ unitOf(shortfall.resource) }} and got <span data-reserve-value="served">{{ figure(shortfall.served) }}</span>', replace: 'wanted <span data-reserve-value="wanted">{{ figure(shortfall.served) }}</span> {{ unitOf(shortfall.resource) }} and got <span data-reserve-value="served">{{ figure(shortfall.wanted) }}</span>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose shortfall exchanges the scenarios Alpha and Beta', file: 'component', find: '<span data-reserve-name="scenario">{{ shortfall.withdrawal.scenario }}</span>', replace: '<span data-reserve-name="scenario">{{ shortfall.withdrawal.scenario === \'Beta\' ? \'Alpha\' : \'Beta\' }}</span>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose save of a record says its success as the default kind of message', file: 'component', find: 'this.say(draft.uuid ? SAVE_WORDS.saved : SAVE_WORDS.kept, \'success\')', replace: 'this.say(draft.uuid ? SAVE_WORDS.saved : SAVE_WORDS.kept)', fails: ['browser'], parts: ['actions'] },
  { name: 'a panel that says a new record is saved, its kind of message intact', file: 'component', find: 'this.say(draft.uuid ? SAVE_WORDS.saved : SAVE_WORDS.kept, \'success\')', replace: 'this.say(SAVE_WORDS.saved, \'success\')', fails: ['browser'], parts: ['actions'] },
  { name: 'a panel whose game minimum that does not apply draws the words of one not recorded, its hook intact', file: 'component', find: 'data-reserve-game="none" :title="item.minimums.game.why">{{ minimumWords.game.none }}</span>', replace: 'data-reserve-game="none" :title="item.minimums.game.why">{{ minimumWords.game.unknown }}</span>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose lowest balance of a day is drawn as the stock now', file: 'component', find: 'v-if="item.run.lowest.step === 0"', replace: 'v-if="item.run.lowest.step >= 0"', fails: ['browser'], parts: ['cells'] },
  { name: 'a read of the colonies\' supplies for supplies', file: 'mixin', find: "if (!database || !GameID || !RaceID || this.kind !== 'minerals') {\n          return null\n        }\n\n        return Object.freeze({ colonies:", replace: 'if (!database || !GameID || !RaceID) {\n          return null\n        }\n\n        return Object.freeze({ colonies:', fails: ['component'] },
  { name: 'a panel that does not wait on, or name the failure of, the read of the supplies', file: 'mixin', find: "['reserveObjects', 'reserveClasses', 'reservePackets', 'reserveSupply', 'populationProductionModifiers'] :", replace: "['reserveObjects', 'reserveClasses', 'reservePackets', 'populationProductionModifiers'] :", fails: ['component'] },
  { name: 'a panel that names a failed read by no words', file: 'mixin', find: 'failed: joinLabels(failed.map((key) => RESERVE_LABELS[key])),', replace: "failed: '',", fails: ['component'] },
  { name: 'a class minimum cell that never says some classes record none', file: 'component', find: ":data-reserve-class=\"item.minimums.class.unknown > 0 ? 'partial' : 'figure'\"", replace: 'data-reserve-class="figure"', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose words for an untimed flow and a covered row are the same', file: 'component', find: 'untimed: \'Not assessed, untimed\'', replace: 'untimed: \'Covered\'', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose table names the system where the colony is', file: 'component', find: '<span data-reserve-name="colony">{{ item.sourceName }}</span>', replace: '<span data-reserve-name="colony">{{ item.place }}</span>', fails: ['browser'], parts: ['cells'] },
  { name: 'a panel whose embedded root keeps the panel class', file: 'component', find: ":class=\"['resource-reserves', embedded ? 'resource-reserves--embedded' : 'panel']\"", replace: ":class=\"['resource-reserves panel', embedded ? 'resource-reserves--embedded' : '']\"", fails: ['browser'], parts: ['hauling'] },
  { name: 'a Hauling page that mounts the panel for supplies', file: 'hauling', find: 'embedded kind="minerals"', replace: 'embedded kind="supplies"', fails: ['browser'] },
  { name: 'a panel whose Confirm button is drawn with no opacity', file: 'component', find: 'data-reserve-confirm @click="confirm(entry)">', replace: 'data-reserve-confirm style="opacity: 0" @click="confirm(entry)">', fails: ['browser'], parts: ['actions'] },
  { name: 'a panel whose player reserve is not displayed', file: 'component', find: 'class="text-no-wrap" data-reserve-player="set">', replace: 'class="text-no-wrap" data-reserve-player="set" style="display: none">', fails: ['browser'], parts: ['cells'] },
  { name: 'one equivalent rewrite of each family on the panel, its mixin and both pages, made together', files: ['component', 'mixin', 'logistics', 'hauling'], rewrite: equivalents, fails: ['component', 'page', 'browser', 'voice'], benign: true },
]

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name]) => [name, null]))

const textOf = (name) => {
  if (TEXTS[name] === null) {
    TEXTS[name] = fs.readFileSync(FILES[name], 'utf8')
  }

  return TEXTS[name]
}

// The source of a rewrite, which must change it: a rewrite that leaves the text as it was proves nothing.
const rewritten = (name, text, rewrite) => {
  const next = rewrite(text, name)

  if (next === text) {
    throw new Error(`The rewrite changes nothing in ${name}`)
  }

  return next
}

// The sources one run reads: the real ones, or the real ones with one planted fault or one rewrite.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, textOf(name)]))

  if (!mutant) {
    return sources
  }

  return mutant.rewrite ? { ...sources, ...Object.fromEntries(mutant.files.map((name) => [name, rewritten(name, sources[name], mutant.rewrite)])) } : { ...sources, [mutant.file]: patched(path.basename(FILES[mutant.file]), sources[mutant.file], mutant.find, mutant.replace) }
}

// The statement groups and the keys of the checks each holds; a planted fault builds only the groups its keys name, and loads the panel and the pages only when those are among them.
const GROUPS = [
  { build: ledger, keys: ['stock', 'tick', 'combined', 'shortfall', 'plan', 'zero', 'minimums', 'feeds', 'haul'] },
  { build: records, keys: ['record'] },
  { build: loaders, keys: ['loaders'] },
  { build: panel, keys: ['component'] },
  { build: voice, keys: ['voice'] },
  { build: pages, keys: ['page', 'history'] },
  { build: browser, keys: ['browser'] },
]
const wanted = (keys, group) => !keys || group.keys.some((key) => keys.includes(key))

// The renderer served to a browser and the browser, started and warmed once for the worker (`openScreen`, run by the runner before the worker's first variant) and stopped after its last; the failure of a start that did not get through; and the parts of the screen that `observeScreen` of scripts/lib/reserve-screen.js reads.
const SCREEN = { server: null, chrome: null, failure: null }
const SCREEN_PARTS = ['logistics', 'hauling', 'actions', 'cells']
// The pages the screen goes to: their modules are compiled while the server warms.
const SCREEN_ROUTES = ['/logistics', '/hauling']

// Starts the page server and Chromium and opens the app once in them (scripts/lib/page-server.js `warm`). A start that does not get through is kept as `failure`, and every observation of the worker is then one that did not happen.
const openScreen = async () => {
  try {
    SCREEN.server = await require('./lib/page-server').startPageServer({ save: 'AuroraDB.db' })
    SCREEN.chrome = await require('playwright').chromium.launch()

    const warmed = await SCREEN.server.warm(SCREEN.chrome, { routes: SCREEN_ROUTES })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  } catch (error) {
    SCREEN.failure = String(error.message).split('\n')[0]
  }
}

const closeScreen = async () => {
  const { server, chrome } = SCREEN

  SCREEN.server = null
  SCREEN.chrome = null

  if (chrome) {
    await chrome.close()
  }

  if (server) {
    await server.stop()
  }
}

// What the browser shows of the app with these sources, as the record of scripts/lib/browser-observe.js: the files a variant changes are served in place of the real ones, and only the parts of the screen the changed files can alter are read, the others being as the head run observed them. A planted fault that names its parts (`parts` of the list of faults) is read in those parts only, the parts that hold the checks it is caught by: a check of a part that is not read reads nothing and holds, so the fault is credited by a check of a part that was read. A server or a browser that did not start is an observation that did not happen.
const screenOf = async (sources, ctx, chosen = null) => {
  if (SCREEN.failure || !SCREEN.server) {
    return failedObservation(SCREEN.failure || 'the page server was not started for this worker')
  }

  const changed = Object.keys(FILES).filter((name) => sources[name] !== textOf(name))
  const only = (name) => changed.length > 0 && changed.every((file) => file === name)
  const parts = Object.fromEntries((only('logistics') ? ['logistics'] : only('hauling') ? ['hauling'] : chosen || SCREEN_PARTS).map((name) => [name, true]))

  if (parts.cells) {
    try {
      parts.cells = await Promise.all(FIXTURE_NAMES.map((name) => specOf(ctx, name)))
    } catch (error) {
      // A variant that breaks the reads a fixture is mounted with has no table to read: the checks that name the table fail on it.
      delete parts.cells
    }
  }

  changed.forEach((name) => SCREEN.server.replace(FILES[name], sources[name]))

  try {
    const seen = await require('./lib/reserve-screen').observeScreen(SCREEN.chrome, SCREEN.server.url, parts)

    // A screen that did not get through is told whole where it is met, in the output of its variant: the step, the message with Playwright's call log, and what the page showed then. Its checks say it in one line.
    report('the screen', seen)

    return seen
  } finally {
    changed.forEach((name) => SCREEN.server.replace(FILES[name], null))
  }
}

// The fields the Logistics page declares to its persisted view, by the script of the page: the page module is its script alone, and a module this process has loaded already is not run again, so a page whose template alone differs does not declare them again.
const PERSISTED = new Map()
let contexts = 0

// The modules and the screen of one variant of the sources. Variants run one after another in a process and share the modules whose text they do not change; what a page registers with its scenario records goes to records of its own context (`serial`), so no variant finds the adapters an earlier one registered.
const contextOf = async (sources, keys = null, chosen = null) => {
  const serial = ++contexts
  const changed = Object.keys(UTILITY_NAMES).filter((name) => sources[name] !== textOf(name))
  const utilitySources = Object.fromEntries(changed.map((name) => [UTILITY_NAMES[name], sources[name]]))
  const pageUtilities = Object.fromEntries(changed.map((name) => [`utilities/${UTILITY_NAMES[name]}`, sources[name]]))
  const mixinSources = sources.mixin !== textOf('mixin') ? { 'mixins/resource-reserves': sources.mixin } : {}
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: utilitySources })
  const options = wanted(keys, GROUPS[3]) || wanted(keys, GROUPS[5]) || wanted(keys, GROUPS[6]) ? await loadPage('components/logistics/ResourceReserves', { stubs: STUBS, namedComponents: true, sources: { 'components/logistics/ResourceReserves': sources.component, ...pageUtilities, ...mixinSources } }) : null
  const labels = options ? (await loadModule('mixins/resource-reserves', { stubs: STUBS, sources: { ...pageUtilities, ...mixinSources } })).RESERVE_LABELS : null

  const pageOptions = {}
  const needs = (key) => !keys || keys.includes(key)

  if (needs('page') || needs('browser')) {
    globalThis.__persistedFields = undefined
    pageOptions.logistics = await loadPage('pages/logistics', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/persisted-view': RECORDER }, sources: { 'pages/logistics': sources.logistics } })

    if (globalThis.__persistedFields !== undefined) {
      PERSISTED.set(scriptOf(sources.logistics), globalThis.__persistedFields)
    }

    pageOptions.hauling = await loadPage('pages/hauling', { stubs: STUBS, modules: { 'mixins/load-state': LOAD_STATE_STUB, 'utilities/haul-plan': HAUL_PLAN_STUB }, sources: { 'pages/hauling': sources.hauling } })
  }

  if (needs('history')) {
    pageOptions.history = await loadPage('pages/history', { stubs: STUBS, dynamicImports: true, sources: { 'pages/history': sources.history, ...pageUtilities, ...recordsOf(`the page ${serial}`) } })
  }

  const ctx = { m: { rl: subjectModule(loaded['resource-ledger'], 'ledger function'), rr: subjectModule(loaded['resource-reserves'], 'record function'), rf: subjectModule(loaded['resource-feeds'], 'feed function'), records: loaded['scenario-records'], ms: loaded['msp-supply'], lg: loaded.logistics, lt: loaded['load-tracking'] }, options, labels, componentText: sources.component, texts: sources, persisted: PERSISTED.get(scriptOf(sources.logistics)), pageOptions, pageUtilities, serial, screen: null }

  ctx.screen = needs('browser') ? await screenOf(sources, ctx, chosen) : null

  return ctx
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const statementsOf = (ctx, keys = null) => GROUPS.filter((group) => wanted(keys, group)).flatMap((group) => group.build(ctx))

// The statements run as checks of scripts/lib/fault-credit.js: a statement that does not return true fails by an assertion of its own, a call of the code under test that throws fails the check with the failure of that call (the adapters of the modules, the pages and the store), and anything else a statement meets is the harness's, which stops the run when a fault or a rewrite is judged.
const runStatements = (statements, ctx, keys = null) => runChecks(statements.filter(([name]) => !keys || keys.includes(keyOf(name))).map(([name, test]) => ({
  id: keyOf(name),
  name,
  run: async () => {
    const result = await test()

    if (result !== true) {
      throw failure(typeof result === 'string' ? result : 'the check does not hold')
    }
  },
})), ctx)

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const statements = statementsOf(ctx)
  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.every((key) => keys.has(key))).map((mutation) => mutation.name)
  const narrowed = MUTATIONS.filter((mutation) => mutation.parts && (mutation.benign || !mutation.fails.includes('browser') || !mutation.parts.length || mutation.parts.some((name) => !SCREEN_PARTS.includes(name)))).map((mutation) => mutation.name)

  console.log('\nResource ledger: local reserves and the timed resource ledger, on fixtures worked by hand, the panel, the pages and the real app in a browser')
  check('mutations: every planted fault names a group of checks that exists', bare.length ? short(bare) : true)
  check('mutations: a planted fault that is read in some parts of the screen only is caught by the browser and names parts the screen has, and no equivalent rewrite is read in fewer than all of them', narrowed.length ? short(narrowed) : true)

  for (const result of await runStatements(statements, ctx)) {
    check(result.name, result.ok ? true : result.kind === 'error' ? `threw: ${result.detail}` : result.detail)
  }
}

// A variant that is not a whole source, does not load or makes a statement throw an exception no adapter named is a defect of the harness (HarnessError), and credits nothing; so is a fault whose named checks fail only by a call of the code under test that threw (scripts/lib/fault-credit.js `caughtBy`), as it crashed the subject and changed no value a check reads.
// `--detail` tells each failed check of a variant, and whether it failed by a call that threw or by a value.
const DETAIL = process.argv.includes('--detail')

const checkMutant = async (mutant) => {
  const began = Date.now()
  const label = `${mutant.benign ? 'equivalent rewrite passes' : 'mutation caught'}: ${mutant.name}`
  let sources
  let ctx

  try {
    sources = sourcesOf(mutant)
    ctx = await contextOf(sources, mutant.fails, mutant.parts)
  } catch (error) {
    throw error instanceof HarnessError ? error : new HarnessError(`the variant '${mutant.name}' did not load: ${error.message}`)
  }

  const statements = statementsOf(ctx, mutant.fails)
  const absent = mutant.fails.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, ctx, mutant.fails)
  const failed = judged(results, `the variant '${mutant.name}'`)
  const seconds = ((Date.now() - began) / 1000).toFixed(1)

  if (mutant.benign) {
    check(label, absent.length ? `no check has the key ${absent.join(', ')}` : failed.length ? `an equivalent rewrite fails: ${short(failed.map(({ name, detail }) => [name, detail]))}` : true, `${results.length} of the checks it names pass, ${seconds} s`)

    return
  }

  const missed = mutant.fails.filter((key) => !caughtBy(failed, [key], { name: mutant.name, throws: mutant.throws }))
  const crashed = failed.filter((result) => result.threw).length

  check(label, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail by an assertion on a value: ${missed.join(', ')}` : true, `${failed.length} of the checks it names fail${crashed ? `, ${crashed} of them by a call that threw` : ''}, ${seconds} s`)

  if (DETAIL) {
    failed.forEach((result) => console.log(`  ${result.threw ? 'threw' : 'value'}  ${result.name}: ${String(result.detail).slice(0, 400)}`))
  }
}

const parseArguments = (argv) => {
  const options = { mutations: true }

  for (const argument of argv) {
    if (argument === '--detail') {
      // Read by DETAIL.
    } else if (argument === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argument}`)
      process.exit(2)
    }
  }

  return options
}

// The deadlines, in seconds: five times the slowest time measured (the head 38 s, a variant that reads the screen 34 s, one in memory 2 s), at least two minutes, and for what reads the screen at least a minute past its longest step (TIMEOUT of scripts/lib/reserve-screen.js, 120 s for a click or a wait of the page), so that a step that does not end fails by its own timeout, named, before the deadline runs out. The head reads the whole screen and every group of checks; a variant that reads the screen reads the parts it names; the others run in memory. The setup starts and warms the page server, the one cold start of the run.
const DEADLINES = { head: 240, screen: 180, memory: 120, setup: 900 }
const MUTATIONS_HEADING = '\nMutations: each planted fault must fail the checks it names, each equivalent rewrite must keep them passing'
// The planted fault the control runs before the head: one the head's reading of the screen catches.
const CONTROL_FAULT = 'a panel whose lowest balance is shown with the sign turned over'

// The head and every planted fault and equivalent rewrite, one pool: a worker runs them one after another, those that read the screen on its one page server and browser and the others on its loaded modules (`contextOf`).
const variantsOf = (options) => [
  { key: 'head', name: 'the head: the checks of the sources as they are', head: true, pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(options.mutations ? MUTATIONS.map((mutation, index) => ({ key: `mutant:${index}`, name: `${mutation.benign ? 'equivalent rewrite' : 'planted fault'}: ${mutation.name}`, heading: MUTATIONS_HEADING, pool: 'suite', deadline: mutation.fails.includes('browser') ? DEADLINES.screen : DEADLINES.memory, run: () => checkMutant(mutation) })) : []),
]

const run = async () => {
  const options = parseArguments(runnerArgs().rest)
  const totals = await runSuite({
    script: __filename,
    variants: variantsOf(options),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.key === 'head' || variant.control || (variant.key.startsWith('mutant:') && MUTATIONS[Number(variant.key.slice(7))].fails.includes('browser')))) {
        await openScreen()
      }
    },
    afterEach: async () => {
      if (SCREEN.server) {
        await SCREEN.server.reset()
      }
    },
    close: closeScreen,
    control: options.mutations ? { fault: `mutant:${MUTATIONS.findIndex((mutation) => mutation.name === CONTROL_FAULT)}`, head: 'head', heading: '\nThe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

run().catch(async (error) => {
  console.error(error)
  await closeScreen().catch(() => {})
  process.exit(2)
})
