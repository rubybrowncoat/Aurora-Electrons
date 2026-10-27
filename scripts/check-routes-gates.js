/*
  Checks that Route Finder loads on a save without the aether gates' table (FCT_AetherGates, which a save from before 2.6 does not have): the capability report of /routes is degraded by the gates alone, the page's small places read succeeds, no aether gate is offered, and every other small place (waypoints, wrecks, life pods, contacts) reads as it does on a save with the table (src/renderer/pages/routes.vue `smallPlaces`, src/renderer/utilities/place-data.js `loadSmallPlaces`, src/renderer/mixins/capability-gates.js, src/renderer/utilities/capabilities.js `SOFT`).

  Run: bun scripts/check-routes-gates.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The saved game is Falryx (artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db, game 141, race 791). The check copies it twice into a folder of its own: one copy keeps the table and gets one added life pod (the save holds none), the other is that copy with the table dropped, which is the shape of an old save. The page's script runs on each copy with the capability report that the real preflight gives for it (utilities/capabilities.js, run over the copy), and the expected places come from SQL over the copies: the race's waypoints, every wreck, life pod and aether gate of the systems it knows, and the contacts it holds now.

  Every planted fault must fail the checks it names by a wrong value or by the read error the page reports (`loadErrors.smallPlaces`), never because a call threw (scripts/lib/fault-credit.js), and each rewrite that says the same thing must leave every check passing.

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
const ADDED_LIFEPOD = 900000001
const DETAIL = process.argv.includes('--detail')
const RENDERER = path.join(root, 'src', 'renderer')
const FILES = {
  routes: path.join(RENDERER, 'pages', 'routes.vue'),
  places: path.join(RENDERER, 'utilities', 'place-data.js'),
  gates: path.join(RENDERER, 'mixins', 'capability-gates.js'),
  capabilities: path.join(RENDERER, 'utilities', 'capabilities.js'),
}
const LOAD_STATE = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
// The groups of small places, with the prefix of the place key each one has (utilities/deep-links.js).
const GROUPS = ['waypoint', 'wreck', 'lifepod', 'contact', 'aether']
const OTHERS = GROUPS.filter((group) => group !== 'aether')

const adapter = (db) => ({ query: async (sql) => [db.query(sql).all()] })

// ---------- the two copies of the save ----------

let FOLDER = null
let COPIES = null

const copies = () => {
  if (COPIES) {
    return COPIES
  }

  FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-routes-gates-'))

  const intactFile = path.join(FOLDER, 'intact.db')
  const oldFile = path.join(FOLDER, 'old.db')

  fs.copyFileSync(path.join(root, SAVE), intactFile)

  const edit = new Database(intactFile)
  const [system] = edit.query(`select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} order by SystemID limit 1`).all()

  if (!system) {
    throw new HarnessError('the save holds no system the race knows to put a life pod in')
  }

  edit.run(`insert into FCT_Lifepods (LifepodID, GameID, RaceID, SystemID, ShipName, Crew, Xcor, Ycor) values (${ADDED_LIFEPOD}, ${GAME}, ${RACE}, ${system.SystemID}, 'Added pod', 3, 1500, 2500)`)
  edit.close()
  fs.copyFileSync(intactFile, oldFile)

  const old = new Database(oldFile)

  old.run('drop table FCT_AetherGates')
  old.close()

  COPIES = { intact: new Database(intactFile, { readonly: true }), old: new Database(oldFile, { readonly: true }), system }

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

// The capability report of a copy as the real preflight gives it, and the page's small places read over it: { report, rows, error, loadError }. `loadError` is what the page reports for the read (`loadErrors.smallPlaces`, null for a read that succeeded) and `error` the message of the read when the page's own read threw; the page's code runs through the boundary of scripts/lib/fault-credit.js, so a failure of the harness (the store, the adapter) stops the run and only a throw of the page's read is taken as its reported error.
const readOf = async ({ caps, page }, db) => {
  const result = await caps.preflight(adapter(db))
  const store = { getters: { 'capabilities/result': result, 'capabilities/report': harnessOwn((route) => result.reports[route] || null), 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: harnessOwn(async () => {}) }
  const vm = instantiate(page, { $store: store, database: adapter(db), GameID: GAME, RaceID: RACE, data: { loadErrors: {} }, boundary })
  let rows = null
  let error = null

  try {
    rows = await vm.runAsync('smallPlaces')
  } catch (thrown) {
    if (!isSubjectThrow(thrown)) {
      throw thrown
    }

    error = thrown.message
  }

  return { report: result.reports['/routes'], rows, error, loadError: vm.loadErrors.smallPlaces }
}

const fieldsOf = (entries) => entries.map((entry) => `${entry.key}(${entry.fields.join(' ')})`).join('; ')

// What the save itself says of the small places the race is offered, from SQL over the copy and never from the page: { [group]: [[place key, SystemID, Xcor, Ycor], ...] sorted by key }. The race's own waypoints (not those marked for deletion), every wreck, life pod and aether gate of the systems it knows, and the contacts other races' sensors give it that were detected at the game's time now (a contact is stored once for each way it was detected, so its tracks collapse into the highest UniqueID, the key a move order names). Aether gates are left out when the copy has no table, as a save from before 2.6 has none.
const oracleOf = (db) => {
  const known = (table) => `${table}.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE})`
  const places = (prefix, sql) => db.query(sql).all().map((row) => [`${prefix}:${row.Id}`, row.SystemID, row.Xcor, row.Ycor]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const oracle = {
    waypoint: places('waypoint', `select WaypointID as Id, SystemID, Xcor, Ycor from FCT_Waypoint where GameID = ${GAME} and RaceID = ${RACE} and WaypointType != 4 and ${known('FCT_Waypoint')}`),
    wreck: places('wreck', `select WreckID as Id, SystemID, Xcor, Ycor from FCT_Wrecks where GameID = ${GAME} and ${known('FCT_Wrecks')}`),
    lifepod: places('lifepod', `select LifepodID as Id, SystemID, Xcor, Ycor from FCT_Lifepods where GameID = ${GAME} and ${known('FCT_Lifepods')}`),
    contact: places('contact', `select UniqueID as Id, SystemID, Xcor, Ycor from FCT_Contacts where UniqueID in (select max(UniqueID) from FCT_Contacts where GameID = ${GAME} and DetectRaceID = ${RACE} and ContactRaceID != ${RACE} and LastUpdate = (select GameTime from FCT_Game where GameID = ${GAME}) and ${known('FCT_Contacts')} group by ContactType, ContactID)`),
    aether: hasGateTable(db) ? places('aether', `select AetherGateID as Id, SystemID, Xcor, Ycor from FCT_AetherGates where GameID = ${GAME} and ${known('FCT_AetherGates')}`) : [],
  }

  oracle.gatesInTable = hasGateTable(db) ? db.query(`select count(*) as Count from FCT_AetherGates where GameID = ${GAME}`).get().Count : 0

  return oracle
}

const placesOf = (rows, group) => rows.filter((row) => row.group === group).map((row) => [row.key, row.SystemID, row.Xcor, row.Ycor]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

// Every group the page offers against the save's: a place of a group by its key, and the page offers nothing in a group the save has none of.
const assertAgainstSave = (rows, oracle, groups, label) => {
  groups.forEach((group) => assert.deepEqual(placesOf(rows, group), oracle[group], `${label}: the ${group} places are the save's`))
  assert.equal(rows.length, groups.reduce((sum, group) => sum + oracle[group].length, 0), `${label}: the page offers no place of another group`)
}

// ---------- the checks ----------

const intactChecks = {
  id: 'intact',
  name: 'a save with the aether gates offers every small place, a gate at its stored place and only the gates of the systems the race knows, and reports the group as present',
  run: async ({ read, db }) => {
    const { report, rows, loadError } = read.intact
    const oracle = oracleOf(db.intact)

    assert.equal(loadError, null, `the read error the page reports for the intact copy: ${loadError}`)
    assert.equal(report.groups.aetherGates, true, 'the report counts the gates as present')
    assert.equal(report.degraded.some((entry) => entry.key === 'aetherGates'), false, 'the report names no missing gate field')
    assert.ok(GROUPS.every((group) => oracle[group].length > 0), `the save holds a place of each group to check: ${GROUPS.map((group) => `${group} ${oracle[group].length}`).join(', ')}`)
    assert.ok(oracle.gatesInTable > oracle.aether.length, 'the save holds a gate in a system the race does not know, which is not offered')
    assertAgainstSave(rows, oracle, GROUPS, 'the intact copy')
  },
}

const reportChecks = {
  id: 'report',
  name: 'a save without the aether gates is degraded for Route Finder by the gates alone, naming the table, and no other part of the report changes',
  run: async ({ read }) => {
    const { intact, old } = read

    assert.equal(old.report.groups.aetherGates, false, 'the report counts the gates as absent')
    assert.equal(old.report.missing.length, 0, `nothing is missing that Route Finder cannot do without, not: ${fieldsOf(old.report.missing)}`)
    assert.equal(old.report.status, 'degraded', 'the report is degraded, not unsupported')

    const added = old.report.degraded.filter((entry) => !intact.report.degraded.some((before) => before.key === entry.key))

    assert.equal(added.length, 1, `one part is added to what the report leaves out, not: ${fieldsOf(added)}`)
    assert.equal(added[0].key, 'aetherGates', 'the part is the gates')
    assert.ok(added[0].fields.length > 0 && added[0].fields.every((field) => /^FCT_AetherGates\b/.test(field)), `the fields it names are the table's, not: ${added[0].fields.join(', ')}`)
  },
}

const oldChecks = {
  id: 'old',
  name: 'Route Finder loads on a save without the aether gates: the small places read succeeds, every other small place is there at its stored place, and no aether gate is offered',
  run: async ({ read, db }) => {
    const { old } = read
    const oracle = oracleOf(db.old)

    assert.equal(old.loadError, null, `the read error the page reports for the old copy: ${old.loadError}`)
    assert.equal(oracle.aether.length, 0, 'the old copy holds no gate')
    assert.ok(OTHERS.every((group) => oracle[group].length > 0), `the old copy holds a place of each other group to check: ${OTHERS.map((group) => `${group} ${oracle[group].length}`).join(', ')}`)
    assertAgainstSave(old.rows, oracle, OTHERS, 'the old copy')
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
  { name: 'the small places read joins the aether gates whether or not the save has them (the loader)', file: 'places', change: swap('...(aetherGates ? [loadAetherGates(database, context)] : [])', 'loadAetherGates(database, context)'), fails: ['old'] },
  { name: 'the page tells the small places read the aether gates are there', file: 'routes', change: swap('this.count, await gates)', 'this.count, { aetherGates: true })'), fails: ['old'] },
  { name: 'the capability gates tell every page the aether gates are there', file: 'gates', change: swap('aetherGates: report ? report.groups.aetherGates !== false : true', 'aetherGates: true'), fails: ['old'] },
  { name: 'the page leaves the aether gates out whether or not the save has them', file: 'routes', change: swap('this.count, await gates)', 'this.count, { aetherGates: false })'), fails: ['intact'] },
  { name: 'the loader leaves the aether gates out whether or not the save has them', file: 'places', change: swap('...(aetherGates ? [loadAetherGates(database, context)] : [])', '...[]'), fails: ['intact'] },
  { name: 'the other small places are left out when the save has no gates', file: 'places', change: swap('const lists = await Promise.all([loadWaypoints(database, context), loadWrecks(database, context, count), loadLifepods(database, context), loadContacts(database, context), ...(aetherGates ? [loadAetherGates(database, context)] : [])])', 'const lists = await Promise.all(aetherGates ? [loadWaypoints(database, context), loadWrecks(database, context, count), loadLifepods(database, context), loadContacts(database, context), loadAetherGates(database, context)] : [])'), fails: ['old'] },
  { name: 'the wrecks are left out when the save has no gates', file: 'places', change: swap('loadWrecks(database, context, count), loadLifepods(database, context), loadContacts(database, context), ...(aetherGates', '...(aetherGates ? [loadWrecks(database, context, count)] : []), loadLifepods(database, context), loadContacts(database, context), ...(aetherGates'), fails: ['old'] },
  { name: 'the report of Route Finder does not hold the gates as a part it can lose', file: 'capabilities', change: swap("  '/routes': Object.freeze([aetherGates('the aether gates among the places to choose, which rest on the gates of the save')]),\n", ''), fails: ['report', 'old'] },
  { name: 'the part the report holds names one column of the table, not the table', file: 'capabilities', change: swap("const aetherGates = (affects) => Object.freeze({ key: 'aetherGates', label: 'Aether gates', affects, fields: Object.freeze(['FCT_AetherGates.*'])", "const aetherGates = (affects) => Object.freeze({ key: 'aetherGates', label: 'Aether gates', affects, fields: Object.freeze(['FCT_AetherGates.AetherGateID'])"), fails: ['report', 'old'] },
]

// Rewrites that say the same thing: the condition of the loader parenthesised, the gate test spelled out where the loader makes it and where the capability gates make it.
const BENIGN = [
  { name: 'the gate condition of the loader parenthesised', file: 'places', change: swap('...(aetherGates ? [loadAetherGates', '...((aetherGates) ? [loadAetherGates') },
  { name: 'the gate test of the loader spelled out', file: 'places', change: swap('...(aetherGates ? [loadAetherGates', '...(aetherGates === true ? [loadAetherGates') },
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

  const sources = { 'utilities/capabilities': given.capabilities, 'utilities/place-data': given.places, 'mixins/capability-gates': given.gates }
  const caps = subjectModule(await loadModule('utilities/capabilities', { sources }), 'utility')
  const page = await loadPage('pages/routes', { sources: { ...sources, 'pages/routes': given.routes }, modules: { 'mixins/load-state': LOAD_STATE } })
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

// The deadline of a variant, in seconds: it loads the page and the registry, runs the real preflight over two copies and reads the small places of each (the copies are made once in a worker).
const DEADLINE = 180

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the small places read of Route Finder over a save with and without the aether gates', head: true, heading: 'The Route Finder small places read (pages/routes.vue, utilities/place-data.js, mixins/capability-gates.js, utilities/capabilities.js)', deadline: DEADLINE, run: checkHead },
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
