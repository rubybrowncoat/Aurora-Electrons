/*
  Checks that the Hauling page reads the place of an order to an aether gate (src/renderer/pages/hauling.vue `orders`, `DESTINATIONS`, its join of FCT_AetherGates): every order of the repeating fleets is read at its destination's stored place, and an order to a gate at the gate's, both as the place of the order and as the place the fleet is after it. A save without FCT_AetherGates is unsupported for /hauling (check-capabilities.js).

  Run: bun scripts/check-hauling-gates.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The saved game is Falryx (artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db, game 141, race 791 with 81 repeating fleets). The check copies it into a folder of its own and adds one order of a repeating fleet to the first aether gate (the save holds no order to a gate). The page's script runs on the copy with the capability report that the real preflight gives for it (utilities/capabilities.js, run over the copy), and the expected figures come from SQL over the copy: the orders the repeating fleets have, and the gate's stored place.

  Every planted fault must fail the checks it names by a wrong value or by the read error the page reports (`loadErrors.orders`), never because a call threw (scripts/lib/fault-credit.js), and each rewrite that says the same thing must leave every check passing.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Database } = require('bun:sqlite')
const { runSuite } = require('./lib/suite-runner')
const { HarnessError } = require('./lib/browser-observe')
const { assert, boundary, harnessOwn, subjectModule, isSubjectThrow, runChecks, judged, caughtAll, notCaught } = require('./lib/fault-credit')
const { loadModule, loadPage, instantiate } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const SAVE = 'artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db'
const GAME = 141
const RACE = 791
const ADDED_ORDER = 900000001
const DETAIL = process.argv.includes('--detail')
const RENDERER = path.join(root, 'src', 'renderer')
const FILES = {
  hauling: path.join(RENDERER, 'pages', 'hauling.vue'),
  gates: path.join(RENDERER, 'mixins', 'capability-gates.js'),
  capabilities: path.join(RENDERER, 'utilities', 'capabilities.js'),
}
const LOAD_STATE = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
// The columns of an order that rest on its destination's stored place.
const PLACE = ['SystemID', 'X', 'Y', 'ExitSystemID', 'ExitX', 'ExitY']

const adapter = (db) => ({ query: async (sql) => [db.query(sql).all()] })

// ---------- the copy of the save ----------

let FOLDER = null
let COPIES = null

const copies = () => {
  if (COPIES) {
    return COPIES
  }

  FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-hauling-gates-'))

  const intactFile = path.join(FOLDER, 'intact.db')

  fs.copyFileSync(path.join(root, SAVE), intactFile)

  const edit = new Database(intactFile)
  const [gate] = edit.query(`select AetherGateID, SystemID, Xcor, Ycor from FCT_AetherGates where GameID = ${GAME} order by AetherGateID limit 1`).all()
  const [fleet] = edit.query(`select FCT_Fleet.FleetID, max(FCT_MoveOrders.MoveOrder) as Last from FCT_Fleet inner join FCT_MoveOrders on FCT_MoveOrders.FleetID = FCT_Fleet.FleetID where FCT_Fleet.RaceID = ${RACE} and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 group by FCT_Fleet.FleetID order by FCT_Fleet.FleetID limit 1`).all()

  if (!gate || !fleet) {
    throw new HarnessError('the save holds no aether gate or no repeating fleet with orders to build the copies from')
  }

  edit.run(`insert into FCT_MoveOrders (MoveOrderID, GameID, RaceID, FleetID, MoveActionID, MoveOrder, StartSystemID, DestinationType, DestinationID, NewWarpPointID) values (${ADDED_ORDER}, ${GAME}, ${RACE}, ${fleet.FleetID}, 1, ${fleet.Last + 1}, ${gate.SystemID}, 14, ${gate.AetherGateID}, 0)`)
  edit.close()
  COPIES = { intact: new Database(intactFile, { readonly: true }), gate, fleet }

  return COPIES
}

const closeCopies = () => {
  if (COPIES) {
    COPIES.intact.close()
    COPIES = null
  }

  if (FOLDER) {
    fs.rmSync(FOLDER, { recursive: true, force: true })
    FOLDER = null
  }
}

const hasGateTable = (db) => db.query("select count(*) as Count from sqlite_master where type = 'table' and name = 'FCT_AetherGates'").get().Count === 1

// ---------- what the page does with a copy ----------

// The capability report of a copy as the real preflight gives it, and the page's orders read over it: { report, rows, error, loadError }. `loadError` is what the page reports for the read (`loadErrors.orders`, null for a read that succeeded) and `error` the message of the read when the page's own read threw; the page's code runs through the boundary of scripts/lib/fault-credit.js, so a failure of the harness (the store, the adapter) stops the run and only a throw of the page's read is taken as its reported error.
const readOf = async ({ caps, page }, db) => {
  const result = await caps.preflight(adapter(db))
  const store = { getters: { 'capabilities/result': result, 'capabilities/report': harnessOwn((route) => result.reports[route] || null), 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: harnessOwn(async () => {}) }
  const vm = instantiate(page, { $store: store, database: adapter(db), GameID: GAME, RaceID: RACE, data: { loadErrors: {} }, boundary })
  let rows = null
  let error = null

  try {
    rows = await vm.runAsync('orders')
  } catch (thrown) {
    if (!isSubjectThrow(thrown)) {
      throw thrown
    }

    error = thrown.message
  }

  return { report: result.reports['/hauling'], rows, error, loadError: vm.loadErrors.orders }
}

const keyOf = (row) => `${row.FleetID}:${row.MoveOrder}`

// The tables an order's destination is stored in, by the order's DestinationType, with the key the order names it by. Every one has SystemID, Xcor and Ycor; a survey location is numbered within the system the order starts in.
const STORES = [
  { types: [1], table: 'FCT_JumpPoint', key: 'WarpPointID' },
  { types: [2, 15], table: 'FCT_SystemBody', key: 'SystemBodyID' },
  { types: [4], table: 'FCT_SurveyLocation', key: 'LocationNumber', byStart: true },
  { types: [5], table: 'FCT_Waypoint', key: 'WaypointID', byGame: true },
  { types: [6], table: 'FCT_Contacts', key: 'UniqueID', byGame: true },
  { types: [7], table: 'FCT_Lifepods', key: 'LifepodID', byGame: true },
  { types: [8], table: 'FCT_Wrecks', key: 'WreckID', byGame: true },
  { types: [10], table: 'FCT_Fleet', key: 'FleetID', byGame: true },
  { types: [12], table: 'FCT_LagrangePoint', key: 'LagrangePointID' },
]

// What the save itself says of the repeating fleets' orders of the race, from SQL over the copy and never from the page: { keys (sorted), places: { [order key]: { type, place: [SystemID, X, Y] or null for an order to a gate, exit: [...] or null where the order's far side is another check's (a jump point) } } }. An order's place is the stored place of its destination; the place after it is the same unless the order is a Lagrange point transit (Intra-system Jump, action 124), which comes out at the point named in DestinationItemID.
const oracleOf = (db) => {
  const orders = db.query(`select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.StartSystemID, FCT_MoveOrders.DestinationType, FCT_MoveOrders.DestinationID, FCT_MoveOrders.DestinationItemID from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 where FCT_MoveOrders.GameID = ${GAME} and FCT_MoveOrders.RaceID = ${RACE}`).all()
  const lookup = (store, order, id) => {
    const where = [`${store.key} = ${id}`, ...(store.byGame ? [`GameID = ${GAME}`] : []), ...(store.byStart ? [`GameID = ${GAME}`, `SystemID = ${order.StartSystemID}`] : [])].join(' and ')
    const found = db.query(`select SystemID, Xcor, Ycor from ${store.table} where ${where}`).all()

    return found.length === 1 ? [found[0].SystemID, found[0].Xcor, found[0].Ycor] : [null, null, null]
  }
  const places = {}

  orders.forEach((order) => {
    const store = STORES.find((candidate) => candidate.types.includes(order.DestinationType))
    const place = store ? lookup(store, order, order.DestinationID) : null
    const exit = !store || order.DestinationType === 1 ? null : order.DestinationType === 12 && order.MoveActionID === 124 ? lookup(store, order, order.DestinationItemID) : place

    places[`${order.FleetID}:${order.MoveOrder}`] = { type: order.DestinationType, place, exit }
  })

  return { keys: Object.keys(places).sort(), places }
}

// The places the page reads for every order that has a stored destination, against the oracle's, and the orders it reads against the oracle's list.
const assertAgainstSave = (rows, oracle, label) => {
  assert.deepEqual(rows.map(keyOf).sort(), oracle.keys, `${label}: the orders read are the repeating fleets' orders of the save`)

  const kinds = new Set()

  rows.forEach((row) => {
    const expected = oracle.places[keyOf(row)]

    if (!expected.place) {
      return
    }

    kinds.add(row.DestinationType)
    assert.deepEqual([row.SystemID, row.X, row.Y], expected.place, `${label}: the place of the order ${keyOf(row)} (destination type ${row.DestinationType})`)

    if (expected.exit) {
      assert.deepEqual([row.ExitSystemID, row.ExitX, row.ExitY], expected.exit, `${label}: the place after the order ${keyOf(row)} (destination type ${row.DestinationType})`)
    }
  })
  assert.ok([1, 2, 10, 12].every((type) => kinds.has(type)), `${label}: the save holds orders to a jump point, a body, a fleet and a Lagrange point to check`)
}

// ---------- the checks ----------

const intactChecks = {
  id: 'intact',
  name: 'every order is read at its destination\'s stored place, an order to a gate at the gate\'s, and Hauling stays in service',
  run: async ({ read, db }) => {
    const { intact, gate } = db
    const { report, rows, loadError } = read.intact

    assert.equal(loadError, null, `the read error the page reports for the intact copy: ${loadError}`)
    assert.notEqual(report.status, 'unsupported', 'the report keeps Hauling in service')
    assertAgainstSave(rows, oracleOf(intact), 'the copy')

    const added = rows.filter((row) => row.DestinationType === 14)

    assert.equal(added.length, 1, 'the one order to a gate')
    assert.equal(added[0].DestinationID, gate.AetherGateID, 'the gate the order goes to')
    assert.deepEqual(PLACE.map((name) => added[0][name]), [gate.SystemID, gate.Xcor, gate.Ycor, gate.SystemID, gate.Xcor, gate.Ycor], 'the place of the order and the place the fleet is after it are the gate\'s stored place')
  },
}

const CHECKS = [intactChecks]

// ---------- the faults and the rewrites ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new HarnessError(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the place of an order does not take the aether gate\'s', file: 'hauling', change: swap(", 'VIR_Destination', 'VIR_AetherGate']", ", 'VIR_Destination']"), fails: ['intact'] },
  { name: 'the place of an order to a body is not read', file: 'hauling', change: swap("const DESTINATIONS = ['FCT_SystemBody', ", 'const DESTINATIONS = ['), fails: ['intact'] },
  { name: 'the gate of an order is joined on the order\'s item, not its destination', file: 'hauling', change: swap('VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationID', 'VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationItemID'), fails: ['intact'] },
]

// Rewrites that say the same thing: the terms of the join turned about and the join condition parenthesised.
const BENIGN = [
  { name: 'the terms of the join turned about', file: 'hauling', change: swap('and VIR_AetherGate.GameID = FCT_MoveOrders.GameID and VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationID', 'and VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationID and (VIR_AetherGate.GameID = FCT_MoveOrders.GameID)') },
  { name: 'the join condition parenthesised', file: 'hauling', change: swap('on FCT_MoveOrders.DestinationType = 14 and VIR_AetherGate.GameID', 'on (FCT_MoveOrders.DestinationType = 14) and VIR_AetherGate.GameID') },
]
/* eslint-enable no-template-curly-in-string */

// ---------- a run of the checks over the sources as they are, or with `change` made to one of them ----------

const texts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))

const results = async (variant, ids) => {
  const given = { ...texts }

  if (variant) {
    given[variant.file] = variant.change(texts[variant.file])
  }

  const sources = { 'utilities/capabilities': given.capabilities, 'mixins/capability-gates': given.gates }
  const caps = subjectModule(await loadModule('utilities/capabilities', { sources }), 'utility')
  const page = await loadPage('pages/hauling', { sources: { ...sources, 'pages/hauling': given.hauling }, modules: { 'mixins/load-state': LOAD_STATE } })
  const db = copies()

  if (!hasGateTable(db.intact)) {
    throw new HarnessError('the copy has no aether gates table')
  }

  const read = { intact: await readOf({ caps, page }, db.intact) }

  return await runChecks(CHECKS.filter(({ id }) => !ids || ids.includes(id)), { read, db })
}

let checks = 0
let failures = 0

const report = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n         ${detail || 'false'}`}`)
}

const checkHead = async () => {
  const found = await results(null)

  judged(found, 'the sources')
  found.forEach((result) => report(result.name, result.ok, result.detail))
}

const checkFault = async (fault) => {
  const found = await results(fault, fault.fails)

  judged(found, fault.name)
  report(`fault caught: ${fault.name}`, caughtAll(found, { name: fault.name }), notCaught(found))

  if (DETAIL) {
    found.forEach((result) => console.log(`         ${result.id}: ${result.ok ? 'holds' : result.detail}`))
  }
}

const checkRewrite = async (rewrite) => {
  const found = await results(rewrite)
  const wrong = judged(found, rewrite.name).map((result) => `${result.id}: ${result.detail}`)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0, wrong.join('; '))
}

// The deadline of a variant, in seconds: it loads the page and the registry, runs the real preflight over the copy and reads its orders (the copy is made once in a worker).
const DEADLINE = 180

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the orders read of Hauling over a save with an order to an aether gate', head: true, heading: 'The Hauling orders read (pages/hauling.vue, mixins/capability-gates.js, utilities/capabilities.js)', deadline: DEADLINE, run: checkHead },
  ...(mutating ? FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults', deadline: DEADLINE, run: () => checkFault(fault) })) : []),
  ...(mutating ? BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites that say the same thing', deadline: DEADLINE, run: () => checkRewrite(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    close: async () => closeCopies(),
    control: null,
    setup: DEADLINE,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  closeCopies()
  process.exit(2)
})
