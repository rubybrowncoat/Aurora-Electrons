/*
  Checks that Route Finder offers the aether gates among its small places (src/renderer/pages/routes.vue `smallPlaces`, src/renderer/utilities/place-data.js `loadSmallPlaces`): every small place group (waypoints, wrecks, life pods, contacts, aether gates) is read at its stored place and compared with an independent SQL read of the save, the gates of systems the race does not know are not offered, and the page offers no place of another group. A save without FCT_AetherGates is unsupported for /routes (check-capabilities.js).

  Run: bun scripts/check-routes-gates.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The saved game is Falryx (artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db, game 141, race 791). The check copies it into a folder of its own and adds one life pod of the race and two of another race, one of a class the race holds an alias for and one of a class it holds none for (the save holds no pod). The page's script runs on the copy with the capability report that the real preflight gives for it (utilities/capabilities.js, run over the copy), and the expected figures come from SQL over the copy. A pod of another race must show the race's alias for its class and its id and never its ship name or crew, which the game shows only the owner of the pod (check `pods`).

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
// The life pods added besides the race's own, each of another race with a ship name and a crew the race must not see: one whose class the race holds an alias for (an `FCT_AlienClass` row of the race, class 62894 'Apollo') and one whose class it holds none for.
const FOREIGN_RACE = 785
const ALIASED_POD = { id: 900000002, name: 'Hidden Zulu Pod', crew: 7771, classId: 62894 }
const UNALIASED_POD = { id: 900000003, name: 'Hidden Alpha Pod', crew: 4242, classId: 1 }
const DETAIL = process.argv.includes('--detail')
const RENDERER = path.join(root, 'src', 'renderer')
const FILES = {
  routes: path.join(RENDERER, 'pages', 'routes.vue'),
  places: path.join(RENDERER, 'utilities', 'place-data.js'),
  capabilities: path.join(RENDERER, 'utilities', 'capabilities.js'),
}
const LOAD_STATE = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
// The groups of small places, with the prefix of the place key each one has (utilities/deep-links.js).
const GROUPS = ['waypoint', 'wreck', 'lifepod', 'contact', 'aether']

const adapter = (db) => ({ query: async (sql) => [db.query(sql).all()] })

// ---------- the copy of the save ----------

let FOLDER = null
let COPIES = null

const copies = () => {
  if (COPIES) {
    return COPIES
  }

  FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-routes-gates-'))

  const intactFile = path.join(FOLDER, 'intact.db')

  fs.copyFileSync(path.join(root, SAVE), intactFile)

  const edit = new Database(intactFile)
  const [system] = edit.query(`select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} order by SystemID limit 1`).all()

  if (!system) {
    throw new HarnessError('the save holds no system the race knows to put a life pod in')
  }

  edit.run(`insert into FCT_Lifepods (LifepodID, GameID, RaceID, SystemID, ShipName, Crew, Xcor, Ycor) values (${ADDED_LIFEPOD}, ${GAME}, ${RACE}, ${system.SystemID}, 'Added pod', 3, 1500, 2500)`)

  ;[ALIASED_POD, UNALIASED_POD].forEach((pod) => edit.run(`insert into FCT_Lifepods (LifepodID, GameID, RaceID, SystemID, ClassID, ShipName, Crew, Xcor, Ycor) values (${pod.id}, ${GAME}, ${FOREIGN_RACE}, ${system.SystemID}, ${pod.classId}, '${pod.name}', ${pod.crew}, 1600, 2600)`))
  edit.close()
  COPIES = { intact: new Database(intactFile, { readonly: true }), system }

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

// ---------- what the page does with a copy ----------

// The capability report of a copy as the real preflight gives it, and the page's small places read over it: { report, rows, lifepodReads, error, loadError }. `lifepodReads` holds the rows the life pod read of the page got back from the copy, as the page's read asked for them (the harness's adapter notes them, as it does not run the page's code). `loadError` is what the page reports for the read (`loadErrors.smallPlaces`, null for a read that succeeded) and `error` the message of the read when the page's own read threw; the page's code runs through the boundary of scripts/lib/fault-credit.js, so a failure of the harness (the store, the adapter) stops the run and only a throw of the page's read is taken as its reported error.
const readOf = async ({ caps, page }, db) => {
  const result = await caps.preflight(adapter(db))
  const store = { getters: { 'capabilities/result': result, 'capabilities/report': harnessOwn((route) => result.reports[route] || null), 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: harnessOwn(async () => {}) }
  const lifepodReads = []
  const recording = { query: async (sql) => { const read = await adapter(db).query(sql); lifepodReads.push(...read[0].filter((row) => 'LifepodID' in row)); return read } }
  const vm = instantiate(page, { $store: store, database: recording, GameID: GAME, RaceID: RACE, data: { loadErrors: {} }, boundary })
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

  return { report: result.reports['/routes'], rows, lifepodReads, error, loadError: vm.loadErrors.smallPlaces }
}

// What the save itself says of the small places the race is offered, from SQL over the copy and never from the page: { [group]: [[place key, SystemID, Xcor, Ycor], ...] sorted by key }. The race's own waypoints (not those marked for deletion), every wreck, life pod and aether gate of the systems it knows, and the contacts other races' sensors give it that were detected at the game's time now (a contact is stored once for each way it was detected, so its tracks collapse into the highest UniqueID, the key a move order names).
const oracleOf = (db) => {
  const known = (table) => `${table}.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE})`
  const places = (prefix, sql) => db.query(sql).all().map((row) => [`${prefix}:${row.Id}`, row.SystemID, row.Xcor, row.Ycor]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const oracle = {
    waypoint: places('waypoint', `select WaypointID as Id, SystemID, Xcor, Ycor from FCT_Waypoint where GameID = ${GAME} and RaceID = ${RACE} and WaypointType != 4 and ${known('FCT_Waypoint')}`),
    wreck: places('wreck', `select WreckID as Id, SystemID, Xcor, Ycor from FCT_Wrecks where GameID = ${GAME} and ${known('FCT_Wrecks')}`),
    lifepod: places('lifepod', `select LifepodID as Id, SystemID, Xcor, Ycor from FCT_Lifepods where GameID = ${GAME} and ${known('FCT_Lifepods')}`),
    contact: places('contact', `select UniqueID as Id, SystemID, Xcor, Ycor from FCT_Contacts where UniqueID in (select max(UniqueID) from FCT_Contacts where GameID = ${GAME} and DetectRaceID = ${RACE} and ContactRaceID != ${RACE} and LastUpdate = (select GameTime from FCT_Game where GameID = ${GAME}) and ${known('FCT_Contacts')} group by ContactType, ContactID)`),
    aether: places('aether', `select AetherGateID as Id, SystemID, Xcor, Ycor from FCT_AetherGates where GameID = ${GAME} and ${known('FCT_AetherGates')}`),
  }

  oracle.gatesInTable = db.query(`select count(*) as Count from FCT_AetherGates where GameID = ${GAME}`).get().Count

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
  name: 'every small place is offered at its stored place, a gate among them and only the gates of the systems the race knows',
  run: async ({ read, db }) => {
    const { report, rows, loadError } = read.intact
    const oracle = oracleOf(db.intact)

    assert.equal(loadError, null, `the read error the page reports for the copy: ${loadError}`)
    assert.notEqual(report.status, 'unsupported', 'the report keeps Route Finder in service')
    assert.ok(GROUPS.every((group) => oracle[group].length > 0), `the save holds a place of each group to check: ${GROUPS.map((group) => `${group} ${oracle[group].length}`).join(', ')}`)
    assert.ok(oracle.gatesInTable > oracle.aether.length, 'the save holds a gate in a system the race does not know, which is not offered')
    assertAgainstSave(rows, oracle, GROUPS, 'the copy')
  },
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whether a text carries a name or a figure whole, whatever its case.
const carries = (text, value) => new RegExp(`(?<![\\w])${escaped(String(value))}(?![\\w])`, 'i').test(text)

// The pods of the systems the race knows, from SQL over the copy: the owner, the ship name and crew the game shows only the owner, and the class name the race's own intelligence holds for the pod's class (null when it holds none).
const podsOf = (db) => db.query(`select FCT_Lifepods.LifepodID, FCT_Lifepods.RaceID, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, (select FCT_AlienClass.ClassName from FCT_AlienClass where FCT_AlienClass.GameID = ${GAME} and FCT_AlienClass.ViewRaceID = ${RACE} and FCT_AlienClass.ActualClassID = FCT_Lifepods.ClassID) as Alias from FCT_Lifepods where FCT_Lifepods.GameID = ${GAME} and FCT_Lifepods.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE}) order by FCT_Lifepods.LifepodID`).all()

const podsChecks = {
  id: 'pods',
  name: 'a life pod of another race is read, shown and searched by the race\'s alias for its class and its id and never by its ship name or crew, and the race\'s own by its ship name and crew',
  run: async ({ read, db }) => {
    const { rows, lifepodReads } = read.intact
    const pods = podsOf(db.intact)
    const aliased = pods.find((pod) => pod.LifepodID === ALIASED_POD.id)
    const unaliased = pods.find((pod) => pod.LifepodID === UNALIASED_POD.id)

    if (!aliased || !aliased.Alias || !unaliased || unaliased.Alias) {
      throw new HarnessError('the copy must hold one foreign pod of a class the race holds an alias for and one of a class it holds none for')
    }

    const shown = (pod) => {
      const row = rows.find((place) => place.key === `lifepod:${pod.LifepodID}`)

      assert.ok(row, `the pod ${pod.LifepodID} is offered`)

      return row
    }

    const readOf = (pod) => {
      const row = lifepodReads.find((item) => item.LifepodID === pod.LifepodID)

      assert.ok(row, `the read of the page brings the pod ${pod.LifepodID}`)

      return Object.values(row)
    }

    const foreign = pods.filter((pod) => pod.RaceID !== RACE)
    const own = pods.filter((pod) => pod.RaceID === RACE)

    assert.ok(foreign.length >= 2 && own.length >= 1, `the copy holds foreign pods and an own one to check: ${foreign.length} foreign, ${own.length} own`)
    foreign.forEach((pod) => {
      const row = shown(pod)
      const fields = [row.name, row.subtitle, row.text]
      const values = readOf(pod)

      assert.ok(carries(row.name, pod.LifepodID), `the pod ${pod.LifepodID} of another race is named by its id: ${row.name}`)
      assert.ok(carries(row.text, pod.LifepodID), `the search text of the pod ${pod.LifepodID} of another race holds its id: ${row.text}`)
      assert.ok(!fields.some((field) => carries(field, pod.ShipName)), `the pod ${pod.LifepodID} of another race shows its ship name: ${fields.join(' | ')}`)
      assert.ok(!fields.some((field) => carries(field, pod.Crew)), `the pod ${pod.LifepodID} of another race shows its crew of ${pod.Crew}: ${fields.join(' | ')}`)

      if (pod.Alias) {
        assert.ok(carries(row.name, pod.Alias), `the pod ${pod.LifepodID} of another race is named by the alias ${pod.Alias} of the race: ${row.name}`)
        assert.ok(carries(row.text, pod.Alias), `the search text of the pod ${pod.LifepodID} holds the alias ${pod.Alias}: ${row.text}`)
      }

      assert.ok(!values.some((value) => String(value).toLowerCase() === pod.ShipName.toLowerCase()), `the read of the page brings the ship name of the pod ${pod.LifepodID} of another race`)
      assert.ok(!values.includes(pod.Crew), `the read of the page brings the crew of ${pod.Crew} of the pod ${pod.LifepodID} of another race`)
      assert.ok(!values.includes(pod.RaceID), `the read of the page brings the owner ${pod.RaceID} of the pod ${pod.LifepodID} of another race`)
    })
    own.forEach((pod) => {
      const row = shown(pod)
      const values = readOf(pod)
      const token = /(\S+)\s+survivors?\b/.exec(row.subtitle)

      assert.ok(values.includes(pod.ShipName) && values.includes(pod.Crew), `the read of the page brings the ship name and the crew of its own pod ${pod.LifepodID}`)
      assert.ok(carries(row.name, pod.ShipName), `the own pod ${pod.LifepodID} is named by its ship name: ${row.name}`)
      assert.ok(carries(row.text, pod.ShipName), `the search text of the own pod ${pod.LifepodID} holds its ship name: ${row.text}`)
      assert.ok(token && /^\d+$/.test(token[1]) && Number(token[1]) === pod.Crew, `the own pod ${pod.LifepodID} shows its crew of ${pod.Crew}: ${row.subtitle}`)
    })

    // A pod of another race has no name to order by, so the foreign pods keep the order of their ids whatever their hidden names are.
    const order = rows.filter((row) => row.group === 'lifepod').map((row) => Number(row.key.split(':')[1])).filter((id) => foreign.some((pod) => pod.LifepodID === id))

    assert.deepEqual(order, foreign.map((pod) => pod.LifepodID), 'the pods of another race are listed by their ids, not by their hidden ship names')
  },
}

const CHECKS = [intactChecks, podsChecks]

// ---------- the faults and the rewrites ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new HarnessError(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

const then = (...changes) => (text) => changes.reduce((given, change) => change(given), text)

/* eslint-disable no-template-curly-in-string */
const NAME_GATE = 'case when FCT_Lifepods.RaceID = ${context.RaceID} then FCT_Lifepods.ShipName end as OwnShipName'
const CREW_GATE = 'case when FCT_Lifepods.RaceID = ${context.RaceID} then FCT_Lifepods.Crew end as OwnCrew'
const NAME_UNGATED = 'FCT_Lifepods.ShipName as OwnShipName'
const CREW_UNGATED = 'FCT_Lifepods.Crew as OwnCrew'
const NAME_CELL = '`Life pods: ${own ? row.OwnShipName : `${row.AlienClassName'
const CREW_CELL = '${own ? (Number.isFinite(row.OwnCrew)'
const textCell = (to) => swap('text: textOf(name, row.SystemName),\n  }\n})\n\nconst loadAetherGates', `${to},\n  }\n})\n\nconst loadAetherGates`)
const CLASS_CELL = "`${row.AlienClassName || 'unknown class'} #${row.LifepodID}`"

const FAULTS = [
  { name: 'the loader leaves the aether gates out', file: 'places', change: swap(', loadContacts(database, context), loadAetherGates(database, context)])', ', loadContacts(database, context)])'), fails: ['intact'] },
  { name: 'the loader leaves the wrecks out', file: 'places', change: swap('loadWrecks(database, context, count), loadLifepods', 'loadLifepods'), fails: ['intact'] },
  { name: 'the gates of a system the race does not know are offered', file: 'places', change: swap("${known('FCT_AetherGates', context)}\nwhere", 'left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_AetherGates.SystemID and FCT_RaceSysSurvey.RaceID = ${context.RaceID} and FCT_RaceSysSurvey.GameID = ${context.GameID}\nwhere'), fails: ['intact'] },
  { name: 'the read brings the ship name of a pod of another race', file: 'places', change: swap(NAME_GATE, NAME_UNGATED), fails: ['pods'] },
  { name: 'the read brings the crew of a pod of another race', file: 'places', change: swap(CREW_GATE, CREW_UNGATED), fails: ['pods'] },
  { name: 'the pods of another race are ordered by their hidden ship names', file: 'places', change: swap('order by OwnShipName, FCT_Lifepods.LifepodID', 'order by FCT_Lifepods.ShipName, FCT_Lifepods.LifepodID'), fails: ['pods'] },
  { name: 'a pod of another race is named by its ship name', file: 'places', change: then(swap(NAME_GATE, NAME_UNGATED), swap(NAME_CELL, '`Life pods: ${true ? row.OwnShipName : `${row.AlienClassName')), fails: ['pods'] },
  { name: 'a pod of another race shows its crew', file: 'places', change: then(swap(CREW_GATE, CREW_UNGATED), swap(CREW_CELL, '${true ? (Number.isFinite(row.OwnCrew)')), fails: ['pods'] },
  { name: 'the search text of a pod of another race holds its ship name', file: 'places', change: then(swap(NAME_GATE, NAME_UNGATED), textCell('text: textOf(name, row.OwnShipName, row.SystemName)')), fails: ['pods'] },
  { name: 'the search text of a pod of another race lacks its id', file: 'places', change: textCell("text: textOf('life pods', own ? row.OwnShipName : row.AlienClassName, row.SystemName)"), fails: ['pods'] },
  { name: 'a pod of another race loses the alias of its class', file: 'places', change: swap(CLASS_CELL, "`${'unknown class'} #${row.LifepodID}`"), fails: ['pods'] },
  { name: 'a pod of another race loses its id', file: 'places', change: swap(CLASS_CELL, "`${row.AlienClassName || 'unknown class'}`"), fails: ['pods'] },
  { name: 'the crew of a pod of the race is shown tenfold', file: 'places', change: swap('`${row.OwnCrew} ${row.OwnCrew === 1', '`${row.OwnCrew}0 ${row.OwnCrew === 1'), fails: ['pods'] },
  { name: 'the owner of a pod is told the wrong way round', file: 'places', change: swap('const own = row.Own === 1', 'const own = row.Own !== 1'), fails: ['pods'] },
  { name: 'the read brings the owner of a pod of another race', file: 'places', change: swap('(FCT_Lifepods.RaceID = ${context.RaceID}) as Own,', '(FCT_Lifepods.RaceID = ${context.RaceID}) as Own, FCT_Lifepods.RaceID as PodRaceID,'), fails: ['pods'] },
  { name: 'the read brings the owner of a pod of another race in place of the ownership flag', file: 'places', change: then(swap('(FCT_Lifepods.RaceID = ${context.RaceID}) as Own,', 'FCT_Lifepods.RaceID as Own,'), swap('const own = row.Own === 1', 'const own = row.Own === context.RaceID')), fails: ['pods'] },
]

// Rewrites that say the same thing: the gate load first, the owner test in parentheses, another word for a class that is not known and the system of a pod put ahead of what is said of it.
const BENIGN = [
  { name: 'the gate load first', file: 'places', change: swap('const lists = await Promise.all([loadWaypoints(database, context), loadWrecks(database, context, count), loadLifepods(database, context), loadContacts(database, context), loadAetherGates(database, context)])', 'const lists = await Promise.all([loadAetherGates(database, context), loadWaypoints(database, context), loadWrecks(database, context, count), loadLifepods(database, context), loadContacts(database, context)])') },
  { name: 'the owner test of a pod in parentheses', file: 'places', change: swap('const own = row.Own === 1', 'const own = (row.Own === 1)') },
  { name: 'the life pod read with its keywords in capitals', file: 'places', change: swap("\nfrom FCT_Lifepods\n${known('FCT_Lifepods', context)}", "\nFROM FCT_Lifepods\n${known('FCT_Lifepods', context)}") },
  { name: 'another word for the class of a pod that is not known', file: 'places', change: swap(CLASS_CELL, "`${row.AlienClassName || 'unidentified class'} #${row.LifepodID}`") },
  { name: 'the system of a pod put ahead of what is said of it', file: 'places', change: then(swap('subtitle: `${own ?', 'subtitle: `in ${row.SystemName}: ${own ?'), swap("'Alien life pods'} in ${row.SystemName}`", "'Alien life pods'}`")) },
]
/* eslint-enable no-template-curly-in-string */

// ---------- a run of the checks over the sources as they are, or with `change` made to one of them ----------

const texts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))

const results = async (variant, ids) => {
  const given = { ...texts }

  if (variant) {
    given[variant.file] = variant.change(texts[variant.file])
  }

  const sources = { 'utilities/capabilities': given.capabilities, 'utilities/place-data': given.places }
  const caps = subjectModule(await loadModule('utilities/capabilities', { sources }), 'utility')
  const page = await loadPage('pages/routes', { sources: { ...sources, 'pages/routes': given.routes }, modules: { 'mixins/load-state': LOAD_STATE } })
  const db = copies()

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

// The deadline of a variant, in seconds: it loads the page and the registry, runs the real preflight over the copy and reads its small places (the copy is made once in a worker).
const DEADLINE = 180

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the small places read of Route Finder over a save with aether gates', head: true, heading: 'The Route Finder small places read (pages/routes.vue, utilities/place-data.js, utilities/capabilities.js)', deadline: DEADLINE, run: checkHead },
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
