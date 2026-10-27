/*
  Checks that the Hauling page loads on a save without the aether gates' table (FCT_AetherGates, which a save from before 2.6 does not have): the capability report of /hauling is degraded by the gates alone, the page's orders read succeeds, and only the place of an order to a gate reads as unknown (src/renderer/pages/hauling.vue `orders`, src/renderer/mixins/capability-gates.js, src/renderer/utilities/capabilities.js `SOFT`).

  Run: bun scripts/check-hauling-gates.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The saved game is Falryx (artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db, game 141, race 791 with 81 repeating fleets). The check copies it twice into a folder of its own: one copy keeps the table and gets one added order of a repeating fleet to the first aether gate (the save holds no order to a gate), the other is that copy with the table dropped, which is the shape of an old save. The page's script runs on each copy with the capability report that the real preflight gives for it (utilities/capabilities.js, run over the copy), and the expected figures come from SQL over the copies: the orders the repeating fleets have, and the gate's stored place.

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

// ---------- the two copies of the save ----------

let FOLDER = null
let COPIES = null

const copies = () => {
  if (COPIES) {
    return COPIES
  }

  FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-hauling-gates-'))

  const intactFile = path.join(FOLDER, 'intact.db')
  const oldFile = path.join(FOLDER, 'old.db')

  fs.copyFileSync(path.join(root, SAVE), intactFile)

  const edit = new Database(intactFile)
  const [gate] = edit.query(`select AetherGateID, SystemID, Xcor, Ycor from FCT_AetherGates where GameID = ${GAME} order by AetherGateID limit 1`).all()
  const [fleet] = edit.query(`select FCT_Fleet.FleetID, max(FCT_MoveOrders.MoveOrder) as Last from FCT_Fleet inner join FCT_MoveOrders on FCT_MoveOrders.FleetID = FCT_Fleet.FleetID where FCT_Fleet.RaceID = ${RACE} and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 group by FCT_Fleet.FleetID order by FCT_Fleet.FleetID limit 1`).all()

  if (!gate || !fleet) {
    throw new HarnessError('the save holds no aether gate or no repeating fleet with orders to build the copies from')
  }

  edit.run(`insert into FCT_MoveOrders (MoveOrderID, GameID, RaceID, FleetID, MoveActionID, MoveOrder, StartSystemID, DestinationType, DestinationID, NewWarpPointID) values (${ADDED_ORDER}, ${GAME}, ${RACE}, ${fleet.FleetID}, 1, ${fleet.Last + 1}, ${gate.SystemID}, 14, ${gate.AetherGateID}, 0)`)
  edit.close()
  fs.copyFileSync(intactFile, oldFile)

  const old = new Database(oldFile)

  old.run('drop table FCT_AetherGates')
  old.close()

  COPIES = { intact: new Database(intactFile, { readonly: true }), old: new Database(oldFile, { readonly: true }), gate, fleet }

  return COPIES
}

const closeCopies = () => {
  if (COPIES) {
    COPIES.intact.close()
    COPIES.old.close()
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

const fieldsOf = (entries) => entries.map((entry) => `${entry.key}(${entry.fields.join(' ')})`).join('; ')

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
  name: 'a save with the aether gates reads every order at its destination\'s stored place, an order to a gate at the gate\'s, and reports the group as present',
  run: async ({ read, db }) => {
    const { intact, gate } = db
    const { report, rows, loadError } = read.intact

    assert.equal(loadError, null, `the read error the page reports for the intact copy: ${loadError}`)
    assert.equal(report.groups.aetherGates, true, 'the report counts the gates as present')
    assert.equal(report.degraded.some((entry) => entry.key === 'aetherGates'), false, 'the report names no missing gate field')
    assertAgainstSave(rows, oracleOf(intact), 'the intact copy')

    const added = rows.filter((row) => row.DestinationType === 14)

    assert.equal(added.length, 1, 'the one order to a gate')
    assert.equal(added[0].DestinationID, gate.AetherGateID, 'the gate the order goes to')
    assert.deepEqual(PLACE.map((name) => added[0][name]), [gate.SystemID, gate.Xcor, gate.Ycor, gate.SystemID, gate.Xcor, gate.Ycor], 'the place of the order and the place the fleet is after it are the gate\'s stored place')
  },
}

const reportChecks = {
  id: 'report',
  name: 'a save without the aether gates is degraded for Hauling by the gates alone, naming the table, and no other part of the report changes',
  run: async ({ read }) => {
    const { intact, old } = read

    assert.equal(old.report.groups.aetherGates, false, 'the report counts the gates as absent')
    assert.equal(old.report.missing.length, 0, `nothing is missing that Hauling cannot do without, not: ${fieldsOf(old.report.missing)}`)
    assert.equal(old.report.status, 'degraded', 'the report is degraded, not unsupported')

    const added = old.report.degraded.filter((entry) => !intact.report.degraded.some((before) => before.key === entry.key))

    assert.equal(added.length, 1, `one part is added to what the report leaves out, not: ${fieldsOf(added)}`)
    assert.equal(added[0].key, 'aetherGates', 'the part is the gates')
    assert.ok(added[0].fields.length > 0 && added[0].fields.every((field) => /^FCT_AetherGates\b/.test(field)), `the fields it names are the table's, not: ${added[0].fields.join(', ')}`)
  },
}

const oldChecks = {
  id: 'old',
  name: 'Hauling loads on a save without the aether gates: the orders read succeeds, every order is there at its stored place, and only the place of an order to a gate reads as unknown',
  run: async ({ read, db }) => {
    const { intact, old } = read
    const { gate } = db

    assert.equal(old.loadError, null, `the read error the page reports for the old copy: ${old.loadError}`)
    assertAgainstSave(old.rows, oracleOf(db.old), 'the old copy')

    const before = new Map(intact.rows.map((row) => [keyOf(row), row]))
    const gated = old.rows.filter((row) => row.DestinationType === 14)

    assert.equal(gated.length, 1, 'the one order to a gate is still read')
    assert.equal(gated[0].DestinationID, gate.AetherGateID, 'the order to the gate still names its gate')
    assert.deepEqual(PLACE.map((name) => gated[0][name]), PLACE.map(() => null), 'the place of the order to a gate reads as unknown, not as a figure')
    old.rows.filter((row) => row.DestinationType !== 14).forEach((row) => assert.deepEqual(row, before.get(keyOf(row)), `the order ${keyOf(row)} reads as it does with the table`))
  },
}

const CHECKS = [intactChecks, reportChecks, oldChecks]

// ---------- the faults and the rewrites ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new HarnessError(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the orders read joins the aether gates whether or not the save has them', file: 'hauling', change: swap('const { aetherGates } = await gates', 'const aetherGates = true'), fails: ['old'] },
  { name: 'the capability gates tell every page the aether gates are there', file: 'gates', change: swap('aetherGates: report ? report.groups.aetherGates !== false : true', 'aetherGates: true'), fails: ['old'] },
  { name: 'the orders read leaves the aether gates out whether or not the save has them', file: 'hauling', change: (text) => swap("const gateJoin = aetherGates ? 'left join", "const gateJoin = false ? 'left join")(swap("...(aetherGates ? ['VIR_AetherGate'] : [])", '...[]')(text)), fails: ['intact'] },
  { name: 'the place of an order does not take the aether gate\'s', file: 'hauling', change: swap("...(aetherGates ? ['VIR_AetherGate'] : [])", '...[]'), fails: ['intact'] },
  { name: 'the report of Hauling does not hold the gates as a part it can lose', file: 'capabilities', change: swap(", aetherGates('the place of an order to an aether gate, which rests on the gates of the save')", ''), fails: ['report', 'old'] },
  { name: 'an order whose place the save does not give reads as the origin', file: 'hauling', change: swap(".join(', ')})`", ".join(', ')}, 0)`"), fails: ['old'] },
  { name: 'the places of every order are left out when the save has no gates', file: 'hauling', change: swap('...crossings, ...DESTINATIONS, ...(aetherGates', '...crossings, ...(aetherGates ? DESTINATIONS : []), ...(aetherGates'), fails: ['old'] },
  { name: 'the part the report holds names one column of the table, not the table', file: 'capabilities', change: swap("fields: Object.freeze(['FCT_AetherGates.*'])", "fields: Object.freeze(['FCT_AetherGates.AetherGateID'])"), fails: ['report', 'old'] },
  { name: 'the place of an order to a body is not read', file: 'hauling', change: swap("const DESTINATIONS = ['FCT_SystemBody', ", 'const DESTINATIONS = ['), fails: ['intact', 'old'] },
]

// Rewrites that say the same thing: the condition of the join parenthesised, the terms of the join turned about, and the gate test spelled out in each of the two places that make it.
const BENIGN = [
  { name: 'the join condition parenthesised', file: 'hauling', change: swap('const gateJoin = aetherGates ?', 'const gateJoin = (aetherGates) ?') },
  { name: 'the terms of the join turned about', file: 'hauling', change: swap('and VIR_AetherGate.GameID = FCT_MoveOrders.GameID and VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationID', 'and VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationID and (VIR_AetherGate.GameID = FCT_MoveOrders.GameID)') },
  { name: 'the gate test of the place spelled out', file: 'hauling', change: swap("...(aetherGates ? ['VIR_AetherGate'] : [])", "...(aetherGates === true ? ['VIR_AetherGate'] : [])") },
  { name: 'the gate test of the capability gates spelled out', file: 'gates', change: swap('aetherGates: report ? report.groups.aetherGates !== false : true', 'aetherGates: !report || report.groups.aetherGates !== false') },
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

  if (!hasGateTable(db.intact) || hasGateTable(db.old)) {
    throw new HarnessError('the copies are not one with and one without the aether gates table')
  }

  const read = { intact: await readOf({ caps, page }, db.intact), old: await readOf({ caps, page }, db.old) }

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

// The deadline of a variant, in seconds: it loads the page and the registry, runs the real preflight over two copies and reads the orders of each (the copies are made once in a worker).
const DEADLINE = 180

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the orders read of Hauling over a save with and without the aether gates', head: true, heading: 'The Hauling orders read (pages/hauling.vue, mixins/capability-gates.js, utilities/capabilities.js)', deadline: DEADLINE, run: checkHead },
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
