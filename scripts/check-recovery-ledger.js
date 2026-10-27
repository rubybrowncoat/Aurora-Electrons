/*
  Checks the recovery ledger: the life pods and the wrecks the race can see in the systems it knows, and the player's own status for each (src/renderer/utilities/recovery-ledger.js, the adapter `recovery.status` of the scenario repository; utilities/observations.js, the kinds `lifepod` and `wreck` of the generic observation; utilities/map-features.js, the split of the wrecks of a system into own and foreign; mixins/recovery-ledger.js and components/map/RecoveryLedger.vue, the ledger of the Galaxy Map in its dialog).

  Run: CHECK_JOBS=1 bun scripts/check-recovery-ledger.js [--no-mutations] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The expected values are written here, in SQL over the saves and in a constructed save, never read from the module under test:
  - saves: Skoormit (saves/AuroraDB_271_skoormit_saved.db, game 138, race 785: 10 own and 2 foreign wrecks in known systems, no pod), Falryx (artifacts/falryx-sequential-and-rollback, game 141: the own pods, own wrecks and foreign wrecks of race 791 and the foreign pod race 785 sees in another save) and the modded save (AuroraDB.db, game 140, race 784: 16 foreign wrecks, 11 of a class the race names). The objects read are the ones the SQL gives, with the labels the game words them with, `Unknown` for a class the race has no alias for, and no field the viewing race may not see in a row, a statement, a record or an observation;
  - a constructed save holds the cases the saves do not: twins that only the observer's projection can tell apart, an object in a system the race does not know, a pod with no creation time, an alias the race has and one it has not, and a hidden field that changes while nothing the race may see does;
  - the kind by state matrix: each of the four kinds of object (own pod, foreign pod, own wreck, foreign wreck) against held, gone, returned, id reused, unverified, unread and kept at a later time, each cell with the state, the list and the words it must have; a vanished object reads `No longer observed` with its status kept, never as an outcome, and the same id with the same details seen again is held again.
  Statuses are kept in an in-memory scenario repository: they are the race's and the branch's own (another race, branch or campaign does not see them), pending is no record, a duplicate id is refused and a stale revision is refused.
  Every planted fault must fail the checks it names by a wrong value, never because a call threw (scripts/lib/fault-credit.js), and each rewrite that says the same thing must leave every check passing.

  The browser part runs the real app over a copy of the Skoormit save, opens the ledger from the Galaxy Map and reads what it draws: the rows, the figures, the statuses kept and read back after the app is opened again, a later copy of the save with objects removed (listed as no longer observed, the status as it was kept), the words, and the page's errors.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. The suite runs through scripts/lib/suite-runner.js.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Database } = require('bun:sqlite')
const { runSuite, runnerArgs } = require('./lib/suite-runner')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError, installScreen, readFigure, pairedBy, labelKey } = require('./lib/browser-observe')
const { assert, subjectModule, runChecks, judged, caughtBy, notCaught, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const inRenderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const UTILITIES = inRenderer('utilities')

const SKOORMIT = { file: 'saves/AuroraDB_271_skoormit_saved.db', GameID: 138, RaceID: 785, game: 'EggSample', race: 'EggSample' }
const FALRYX_NOW = { file: 'artifacts/falryx-sequential-and-rollback/AuroraDB-2904201340.db', GameID: 141, RaceID: 791 }
const FALRYX_POD = { file: 'artifacts/falryx-sequential-and-rollback/AuroraDB-2810693885.db', GameID: 141 }
const MODDED = { file: 'AuroraDB.db', GameID: 140, RaceID: 784 }

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const NAMES = ['recovery-ledger', 'scenario-records', 'observations', 'map-features', 'observation-words']

// ---------- a record of what the checks count ----------

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n         ${detail || 'false'}`}`)
}

// ---------- the saves, read from the file, and a constructed one ----------

const adapter = (db) => ({ query: async (sql) => [db.query(sql).all()] })

const saves = new Map()

const saveOf = (spec) => {
  if (!saves.has(spec.file)) {
    saves.set(spec.file, new Database(path.join(root, spec.file), { readonly: true }))
  }

  return saves.get(spec.file)
}

// A save with two races. Race 1 is the observer and knows the systems 10 and 11, not 12. Race 2 owns the foreign objects and has the observer's alias 7 for its class 31415 (a ship class the observer never sees the real id of); the class 31416 has no alias. The hidden fields hold tokens no screen, record or key may carry: the name and crew of a foreign pod, the ship of a foreign wreck, the real ids of the foreign classes.
const HIDDEN = { podName: 'SECRET-POD-NAME', podCrew: 987654, wreckShip: 777001, classA: 31415, classB: 31416 }

const constructed = () => {
  const db = new Database(':memory:')

  db.run('create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer, Name text)')
  db.run('create table FCT_ShipClass (ShipClassID integer, GameID integer, ClassName text, HullDescriptionID integer)')
  db.run('create table FCT_HullDescription (HullDescriptionID integer, HullAbbr text)')
  db.run('create table FCT_AlienClass (GameID integer, ViewRaceID integer, ActualClassID integer, AlienClassID integer, ClassName text, HullID integer)')
  db.run('create table FCT_AlienRace (GameID integer, ViewRaceID integer, AlienRaceID integer, Abbrev text)')
  db.run('create table FCT_Lifepods (LifepodID integer, GameID integer, RaceID integer, SystemID integer, Xcor real, Ycor real, ShipName text, Crew integer, CreationTime real, ClassID integer, SpeciesID integer, GradePoints real)')
  db.run('create table FCT_Wrecks (WreckID integer, GameID integer, RaceID integer, SystemID integer, OrbitBodyID integer, Xcor real, Ycor real, Size real, ClassID integer, ShipID integer)')
  ;[[1, 1, 10, 'Alpha'], [1, 1, 11, 'Beta'], [1, 2, 12, 'Gamma']].forEach((row) => db.run('insert into FCT_RaceSysSurvey values (?, ?, ?, ?)', row))
  db.run("insert into FCT_HullDescription values (1, 'FF'), (2, 'CL')")
  db.run("insert into FCT_ShipClass values (100, 1, 'Lancer', 1), (101, 1, 'Mule', 2)")
  db.run("insert into FCT_AlienClass values (1, 1, 31415, 7, 'Raider', 1)")
  db.run("insert into FCT_AlienRace values (1, 1, 2, 'FR ')")
  // pods: 1 own, 2 own in an unknown system, 3 own with no creation time, 4 foreign with an alias, 5 foreign with none, 6 foreign in an unknown system
  db.run(`insert into FCT_Lifepods values (1, 1, 1, 10, 100, 200, 'Alpha One', 5, 1000, 100, 1, 1.5), (2, 1, 1, 12, 5, 5, 'Gone Far', 2, 1000, 100, 1, 1.5), (3, 1, 1, 10, 100, 200, 'Undated', 3, null, 101, 1, 1.5), (4, 1, 2, 10, 1000.4, 2000.6, '${HIDDEN.podName}', ${HIDDEN.podCrew}, 5000, ${HIDDEN.classA}, 9, 9.5), (5, 1, 2, 11, 40, 50, '${HIDDEN.podName}', ${HIDDEN.podCrew}, 5000, ${HIDDEN.classB}, 9, 9.5), (6, 1, 2, 12, 40, 50, '${HIDDEN.podName}', ${HIDDEN.podCrew}, 5000, ${HIDDEN.classA}, 9, 9.5)`)
  // wrecks: 1 own, 2 and 3 foreign twins (same orbit, size and alias), 4 foreign with no alias, 5 foreign free in space, 6 foreign in an unknown system
  db.run(`insert into FCT_Wrecks values (1, 1, 1, 10, 0, 7, 8, 2.5, 100, 55), (2, 1, 2, 10, 77, 1, 1, 1.2, ${HIDDEN.classA}, ${HIDDEN.wreckShip}), (3, 1, 2, 10, 77, 9, 9, 1.2, ${HIDDEN.classA}, ${HIDDEN.wreckShip + 1}), (4, 1, 2, 11, 0, 3, 3, 3, ${HIDDEN.classB}, ${HIDDEN.wreckShip + 2}), (5, 1, 2, 11, 0, 30, 40, 0.5, ${HIDDEN.classA}, ${HIDDEN.wreckShip + 3}), (6, 1, 2, 12, 0, 3, 3, 1, ${HIDDEN.classA}, ${HIDDEN.wreckShip + 4})`)

  return db
}

const IDS = { GameID: 1, RaceID: 1 }
const SCOPE = { campaignId: 'c1', RaceID: 1, branchId: 'b1', gameTime: 100000 }
const OTHER = [{ name: 'another race', scope: { ...SCOPE, RaceID: 2 } }, { name: 'another branch', scope: { ...SCOPE, branchId: 'b2' } }, { name: 'another campaign', scope: { ...SCOPE, campaignId: 'c2' } }]

const memory = () => {
  const files = new Map()
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      const next = change(this.store)

      this.store = next

      return next
    },
  })

  return { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => ({}), writable: () => Promise.resolve(true) }
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ---------- the modules, loaded from the sources as they are or with one of them changed ----------

const texts = new Map()

const modulesOf = async (sources = {}) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources, texts })

  return { ledger: subjectModule(loaded['recovery-ledger']), records: subjectModule(loaded['scenario-records']), obs: subjectModule(loaded.observations), features: subjectModule(loaded['map-features']), words: subjectModule(loaded['observation-words']) }
}

// A repository with the adapter of the ledger and nothing else, over a store of its own.
const repositoryOf = (mod) => {
  const registry = mod.records.createAdapterRegistry()
  let ids = 0
  let clock = 1000

  mod.ledger.registerRecoveryLedger(registry.register)

  return mod.records.createRepository({ storage: { open: memory().open, registry: () => ({}), writable: () => Promise.resolve(true) }, adapters: registry, newId: () => uuid(++ids), now: () => ++clock })
}

const loadObjects = (mod, db, ids = IDS, options = undefined) => mod.ledger.loadRecoveryObjects(adapter(db), ids, options)

// What the open save gives, with the identity of the open campaign and branch, as the page hands it over.
const contextOf = (bundle, scope = SCOPE) => ({ objects: bundle.objects, GameID: 1, RaceID: scope.RaceID, campaignId: scope.campaignId, branchId: scope.branchId, branches: null })

const entryFor = (read, type, id) => read.entries.find((entry) => entry.type === type && entry.id === id)

// ---------- the matrix: each kind of object against each state ----------

// The kinds, one object each, and what each state does to the save under it. `unverified` exists for the kind whose identity is a time (the own pod, whose creation time the save may lack); the others are told by what the race knows of them, and have no such state.
const KINDS = {
  ownLifepod: { id: 1, gone: 'delete from FCT_Lifepods where LifepodID = 1', reused: "update FCT_Lifepods set ShipName = 'Another' where LifepodID = 1", table: 'FCT_Lifepods', key: 'LifepodID' },
  lifepod: { id: 4, gone: 'delete from FCT_Lifepods where LifepodID = 4', reused: 'update FCT_Lifepods set Xcor = Xcor + 5000 where LifepodID = 4', table: 'FCT_Lifepods', key: 'LifepodID' },
  ownWreck: { id: 1, gone: 'delete from FCT_Wrecks where WreckID = 1', reused: 'update FCT_Wrecks set Size = 9 where WreckID = 1', table: 'FCT_Wrecks', key: 'WreckID' },
  wreck: { id: 4, gone: 'delete from FCT_Wrecks where WreckID = 4', reused: 'update FCT_Wrecks set Size = 9 where WreckID = 4', table: 'FCT_Wrecks', key: 'WreckID' },
}

const STATES = ['held', 'gone', 'returned', 'reused', 'unverified', 'unread', 'ahead']

// What each state gives, for the kinds it applies to: the entry's state, the list its row is in (`present` is on the object's own row) and whether it counts as ahead.
const EXPECTED = {
  held: { state: 'held', group: 'present' },
  gone: { state: 'gone', group: 'gone' },
  returned: { state: 'held', group: 'present' },
  reused: { state: 'reused', group: 'review' },
  unverified: { state: 'unverified', group: 'review' },
  unread: { state: 'unread', group: 'unread' },
  ahead: { state: 'held', group: 'ahead' },
}

const APPLIES = (kind, state) => state !== 'unverified' || kind === 'ownLifepod'

// A status is kept for the object of a kind, then the save and the read change as the state says, and the entry is read back: { entry, row (of the list), read }.
const cellOf = async (mod, kind, state) => {
  const db = constructed()
  const spec = KINDS[kind]
  const id = state === 'unverified' ? 3 : spec.id
  const repository = repositoryOf(mod)
  const first = await loadObjects(mod, db)
  const object = first.objects[kind].get(id)
  const kept = await mod.ledger.setStatus(repository, state === 'ahead' ? { ...SCOPE, gameTime: 500000 } : SCOPE, { row: object, status: 'personal', context: contextOf(first, state === 'ahead' ? { ...SCOPE, gameTime: 500000 } : SCOPE) })

  if (!kept.ok) {
    throw new HarnessError(`the status of the ${kind} ${id} was not kept for the cell ${state}: ${kept.code} ${kept.message}`)
  }

  if (state === 'gone' || state === 'returned') {
    const saved = db.query(`select * from ${spec.table} where ${spec.key} = ${id}`).get()

    db.run(spec.gone)

    if (state === 'returned') {
      const middle = mod.ledger.readRecovery(repository, SCOPE, contextOf(await loadObjects(mod, db)))

      assert.equal(entryFor(middle, kind, id).state, 'gone', `the ${kind} ${id} is gone while the save lacks it`)
      db.run(`insert into ${spec.table} values (${Object.keys(saved).map(() => '?').join(', ')})`, Object.values(saved))
    }
  } else if (state === 'reused') {
    db.run(spec.reused)
  }

  const bundle = await loadObjects(mod, db)
  const context = state === 'unread' ? contextOf({ objects: { ...bundle.objects, [kind]: null } }) : contextOf(bundle)
  const read = mod.ledger.readRecovery(repository, SCOPE, context)
  const rows = mod.ledger.recoveryRows({ objects: context.objects, entries: read.entries })
  const entry = entryFor(read, kind, id)
  const row = rows.find((one) => one.entry && one.entry.uuid === entry.uuid)

  return { entry, row, rows, read }
}

// ---------- the checks ----------

const unitChecks = {
  id: 'units',
  name: 'a status is the player\'s own, race- and branch-scoped record; pending is no record; a duplicate id and a stale revision are refused; a status of another save, race or branch is not made',
  run: async ({ mod }) => {
    const db = constructed()
    const repository = repositoryOf(mod)
    const bundle = await loadObjects(mod, db)
    const context = contextOf(bundle)
    const wreck = bundle.objects.wreck.get(4)

    // a status of each kind of the player's choosing is kept, pending is none
    const kept = await mod.ledger.setStatus(repository, SCOPE, { row: wreck, status: 'acknowledged', context })

    assert.equal(kept.ok, true, `the status is kept: ${JSON.stringify(kept)}`)

    const read = mod.ledger.readRecovery(repository, SCOPE, context)

    assert.deepEqual(read.entries.map((entry) => [entry.type, entry.id, entry.status]), [['wreck', 4, 'acknowledged']], 'the one status is read back')

    for (const { name, scope } of OTHER) {
      assert.deepEqual(mod.ledger.readRecovery(repository, scope, contextOf(bundle, scope)).entries, [], `${name} does not see the status`)
    }

    // a stale revision is refused, and nothing is overwritten
    const entry = read.entries[0]
    const moved = await mod.ledger.setStatus(repository, SCOPE, { row: wreck, status: 'personal', entry, context })

    assert.equal(moved.ok, true)

    const stale = await mod.ledger.setStatus(repository, SCOPE, { row: wreck, status: 'acknowledged', entry, context })

    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'revision-conflict', 'a status read before another edit is refused')
    assert.equal(mod.ledger.readRecovery(repository, SCOPE, context).entries[0].status, 'personal', 'the stored status is the later edit')

    // a duplicate id is refused where the first is not shown to be this object
    const duplicate = await mod.ledger.setStatus(repository, SCOPE, { row: wreck, status: 'acknowledged', context })

    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'exists', 'one id has one status on a branch')

    // pending removes the status; nothing is left
    const fresh = mod.ledger.readRecovery(repository, SCOPE, context).entries[0]
    const cleared = await mod.ledger.setStatus(repository, SCOPE, { row: wreck, status: 'pending', entry: fresh, context })

    assert.equal(cleared.ok, true)
    assert.deepEqual(mod.ledger.readRecovery(repository, SCOPE, context).entries, [], 'pending is no record')

    // a status is made only for the object as picked, in the race, campaign and branch of the save
    for (const { name, scope } of OTHER) {
      const refused = await mod.ledger.setStatus(repository, scope, { row: wreck, status: 'personal', context })

      assert.equal(refused.ok, false, `a status picked in the save of this race, branch and campaign is not kept for ${name}`)
      assert.equal(refused.code, 'link-out-of-scope', name)
    }

    const picked = bundle.objects.wreck.get(4)
    const stalePick = await mod.ledger.setStatus(repository, SCOPE, { row: { ...picked, size: 9 }, status: 'personal', context })

    assert.equal(stalePick.code, 'link-stale', 'an object that is not in the save as picked is refused')

    const unread = await mod.ledger.setStatus(repository, SCOPE, { row: picked, status: 'personal', context: contextOf({ objects: { ...bundle.objects, wreck: null } }) })

    assert.equal(unread.code, 'link-not-read', 'a kind that was not read is refused')

    const invalid = await mod.ledger.setStatus(repository, SCOPE, { row: picked, status: 'rescued', context })

    assert.equal(invalid.code, 'invalid-status', 'only pending, acknowledged and personal are kept')
    assert.deepEqual(mod.ledger.readRecovery(repository, SCOPE, context).entries, [], 'nothing was written by a refusal')
  },
}

const matrixChecks = {
  id: 'matrix',
  name: 'each kind of object against each state: a vanished object is no longer observed with its status kept and no outcome, the same id with the same details is held again, another object under the id is for review, an own pod with no creation time is not certified, a kind not read is not checked and a status kept later is not applied',
  run: async ({ mod }) => {
    for (const kind of Object.keys(KINDS)) {
      for (const state of STATES.filter((one) => APPLIES(kind, one))) {
        const { entry, row, rows } = await cellOf(mod, kind, state)
        const expected = EXPECTED[state]
        const where = `${kind}, ${state}`

        assert.ok(row, `${where}: the entry is in a list of the ledger`)

        assert.equal(entry.state, expected.state, `${where}: the state of the entry`)
        assert.equal(Boolean(entry.ahead), state === 'ahead', `${where}: kept at a later time`)
        assert.equal(row.group, expected.group, `${where}: the list of the row`)
        assert.equal(entry.status, 'personal', `${where}: the status is kept as it was, whatever became of the object`)

        if (state === 'gone') {
          assert.equal(row.object, null, `${where}: no object is shown for a vanished id`)
          assert.equal(entry.row, null, `${where}: no row is read for a vanished id`)
        }

        if (state === 'reused') {
          assert.ok(row.current && row.current.id === entry.id, `${where}: the object now under the id is told`)
          assert.equal(rows.filter((one) => one.group === 'present' && one.entry).length, 0, `${where}: the status is not applied to the object now under the id`)
        }

        if (state === 'held' || state === 'returned') {
          assert.equal(row.entry.uuid, entry.uuid, `${where}: the status is on the object's own row`)
          assert.equal(rows.filter((one) => one.entry).length, 1, `${where}: shown once`)
        }
      }
    }

    // the cells that do not exist: the kinds identified by what the race knows have no unverified state, whatever their creation time
    for (const kind of ['lifepod', 'ownWreck', 'wreck']) {
      const { entry } = await cellOf(mod, kind, 'held')

      assert.equal(entry.identity, 'content', `${kind}: identified by content`)
    }

    assert.equal((await cellOf(mod, 'ownLifepod', 'held')).entry.identity, 'created', 'the own pod is identified by its creation time')
  },
}

const identityChecks = {
  id: 'identity',
  name: 'a foreign wreck is keyed on the observer\'s projection with a copies count and an ambiguous mark, an own wreck on its full tuple, and a returning object keeps its trail only where the identity holds',
  run: async ({ mod }) => {
    const db = constructed()
    const repository = repositoryOf(mod)
    const bundle = await loadObjects(mod, db)
    const context = contextOf(bundle)

    assert.deepEqual([2, 3, 4, 5].map((id) => bundle.objects.wreck.get(id).copies), [2, 2, 1, 1], 'the twins are counted by the observer\'s projection')
    assert.equal(bundle.objects.ownWreck.get(1).copies, 1)

    for (const id of [2, 4]) {
      assert.equal((await mod.ledger.setStatus(repository, SCOPE, { row: bundle.objects.wreck.get(id), status: 'acknowledged', context })).ok, true)
    }

    const read = mod.ledger.readRecovery(repository, SCOPE, context)

    assert.equal(entryFor(read, 'wreck', 2).ambiguous, true, 'a wreck with a twin is ambiguous')
    assert.equal(entryFor(read, 'wreck', 4).ambiguous, false, 'a wreck with no twin is not')
    assert.equal(entryFor(read, 'wreck', 2).ref.copies, 2, 'the count is kept with the status')

    // the twins differ in what the race cannot see: a change to a hidden field of one is no change to what is kept, and no hidden field is part of a key
    const { wreck: foreign, ownWreck } = mod.ledger.RECOVERY_TARGETS
    const twin = bundle.objects.wreck.get(3)
    const own = bundle.objects.ownWreck.get(1)

    assert.equal(foreign.fingerprint(bundle.objects.wreck.get(2)), foreign.fingerprint(twin), 'the twins have one fingerprint')
    assert.notEqual(foreign.fingerprint(twin), foreign.fingerprint(bundle.objects.wreck.get(4)), 'a wreck of another class is another')
    assert.notEqual(ownWreck.fingerprint(own), ownWreck.fingerprint({ ...own, shipId: 56 }), 'an own wreck is told by its ship')
    assert.notEqual(ownWreck.fingerprint(own), ownWreck.fingerprint({ ...own, classId: 101 }), 'and by its class')

    db.run('update FCT_Wrecks set ShipID = 12345, RaceID = 2 where WreckID = 3')
    db.run('update FCT_AlienClass set AlienClassID = AlienClassID')

    const after = mod.ledger.readRecovery(repository, SCOPE, contextOf(await loadObjects(mod, db)))

    assert.equal(entryFor(after, 'wreck', 2).state, 'held', 'a hidden field changing is no change of what the race knows')

    // the record of a foreign object holds none of the hidden fields
    const stored = JSON.stringify(repository.list(SCOPE, { kind: 'recovery.status', context }))

    for (const token of [HIDDEN.podName, String(HIDDEN.podCrew), String(HIDDEN.wreckShip), String(HIDDEN.classA), String(HIDDEN.classB)]) {
      assert.equal(stored.includes(token), false, `no ${token} in what is stored for a foreign wreck`)
    }

    // a returning object keeps its trail where the identity holds: the same id with the same details, and not when it comes back otherwise
    const gone = await cellOf(mod, 'wreck', 'gone')
    const back = await cellOf(mod, 'wreck', 'returned')
    const other = await cellOf(mod, 'wreck', 'reused')

    assert.deepEqual([gone.entry.state, back.entry.state, other.entry.state], ['gone', 'held', 'reused'])
  },
}

const HIDDEN_COLUMNS = ['ShipName', 'Crew', 'SpeciesID', 'GradePoints', 'CreationTime', 'RaceID', 'ClassID', 'ShipID']

const FOREIGN_KEYS = ['type', 'place', 'id', 'own', 'systemId', 'systemName', 'x', 'y', 'aliasId', 'className', 'hullAbbr', 'orbitBodyId', 'size', 'tons', 'raceTag', 'copies']

const hiddenChecks = {
  id: 'hidden',
  name: 'no field the race may not see of a foreign pod or wreck is selected, held in a row, stored, shown in a label or compared in an observation: the statements project the observer\'s views, a hidden field that changes changes no signature, and a foreign pod\'s name and crew are in no label',
  run: async ({ mod }) => {
    const statements = mod.ledger.recoverySql(IDS)

    for (const type of ['lifepod', 'wreck']) {
      const list = statements[type].slice(statements[type].indexOf('select ') + 7, statements[type].indexOf(' from '))

      for (const column of HIDDEN_COLUMNS) {
        assert.equal(new RegExp(`\\b${column}\\b`).test(list), false, `the ${type} statement projects no ${column}`)
      }
    }

    const db = constructed()
    const bundle = await loadObjects(mod, db)
    const foreign = [...bundle.objects.lifepod.values(), ...bundle.objects.wreck.values()]

    foreign.forEach((row) => assert.deepEqual(Object.keys(row).filter((key) => !FOREIGN_KEYS.includes(key)), [], `a foreign ${row.place} ${row.id} holds only what the race may see`))

    const labels = foreign.map((row) => mod.ledger.labelOf(row))

    for (const token of [HIDDEN.podName, String(HIDDEN.podCrew)]) {
      assert.equal(labels.some((label) => label.includes(token)), false, `${token} is in no label`)
    }

    // the observations of the pods and of the wrecks compare what the race sees only
    const before = { pods: await mod.ledger.readLifepodObservations(adapter(db), IDS), wrecks: await mod.ledger.readWreckObservations(adapter(db), IDS) }

    db.run('update FCT_Lifepods set ShipName = \'Renamed\', Crew = 1, SpeciesID = 3, GradePoints = 9, CreationTime = 1 where RaceID = 2')
    db.run('update FCT_Wrecks set ShipID = 1, ClassID = 31416 where RaceID = 2 and WreckID in (2, 3)')
    db.run('update FCT_AlienClass set ActualClassID = 31416 where ActualClassID = 31415')
    db.run('update FCT_AlienClass set ActualClassID = 31415')

    const after = { pods: await mod.ledger.readLifepodObservations(adapter(db), IDS), wrecks: await mod.ledger.readWreckObservations(adapter(db), IDS) }

    assert.deepEqual(after.pods, before.pods, 'a pod\'s hidden fields are no part of its observation')
    assert.deepEqual(after.wrecks.map(([id]) => id), before.wrecks.map(([id]) => id), 'the wrecks read are the same')
    assert.equal(JSON.stringify(before).includes(String(HIDDEN.podCrew)), false, 'no crew in an observation')
    assert.equal(JSON.stringify(before).includes(HIDDEN.podName), false, 'no name in an observation')
  },
}

const readerChecks = {
  id: 'objects',
  name: 'the objects read are the life pods and wrecks of the systems the race knows, own and foreign apart, each with the count of the objects that match it, and a statement that fails leaves its kind unread, never empty',
  run: async ({ mod }) => {
    const db = constructed()
    const bundle = await loadObjects(mod, db)
    const ids = (type) => [...bundle.objects[type].keys()]

    assert.deepEqual([ids('ownLifepod'), ids('lifepod'), ids('ownWreck'), ids('wreck')], [[1, 3], [4, 5], [1], [2, 3, 4, 5]], 'only the objects of the systems the race knows, own and foreign apart')
    assert.deepEqual(bundle.failed, {})

    // the labels the game words them with
    const label = (type, id) => mod.ledger.labelOf(bundle.objects[type].get(id))

    assert.equal(label('ownLifepod', 1), 'Alpha One life pods: 5 crew')
    assert.equal(label('lifepod', 4), 'FF Raider life pods #4', 'the observer\'s class and its hull, the id, and neither name nor crew')
    assert.equal(label('lifepod', 5), 'Unknown life pods #5', 'a class the race has no alias for is Unknown')
    assert.equal(label('wreck', 2), 'Wreck of Raider class [FR] #2: 60 tons')
    assert.equal(label('wreck', 4), 'Wreck of Unknown class #4: 150 tons', 'no alias, so no class and no tag')
    assert.equal(label('ownWreck', 1), 'Wreck of Lancer class #1: 125 tons')

    // an unknown crew stays unknown, a recorded zero is a zero
    db.run('update FCT_Lifepods set Crew = null where LifepodID = 1')
    db.run('update FCT_Lifepods set Crew = 0 where LifepodID = 3')

    const crewed = await loadObjects(mod, db)

    assert.equal(mod.ledger.labelOf(crewed.objects.ownLifepod.get(1)), 'Alpha One life pods: crew unknown')
    assert.equal(mod.ledger.labelOf(crewed.objects.ownLifepod.get(3)), 'Undated life pods: 0 crew')

    // an own pod has an age, nothing else has one, and none is a countdown
    assert.equal(mod.ledger.ageOf(bundle.objects.ownLifepod.get(1), 1500), 500)
    assert.equal(mod.ledger.ageOf(bundle.objects.ownLifepod.get(1), 500), null, 'before its creation there is no age')
    assert.equal(mod.ledger.ageOf(bundle.objects.ownLifepod.get(3), 1500), null, 'no creation time, no age')
    assert.equal(mod.ledger.ageOf(bundle.objects.lifepod.get(4), 99999), null, 'a foreign pod has no age the race can read')
    assert.equal(mod.ledger.ageOf(bundle.objects.wreck.get(2), 99999), null, 'a wreck has none')

    // a statement that fails is a kind not read
    const broken = await mod.ledger.loadRecoveryObjects({ query: async (sql) => { if (sql.includes('FCT_Wrecks')) { throw new Error('no such column: FCT_Wrecks.Size') } return [db.query(sql).all()] } }, IDS)

    assert.equal(broken.objects.wreck, null)
    assert.equal(broken.objects.ownWreck, null)
    assert.deepEqual(Object.keys(broken.failed).sort(), ['ownWreck', 'wreck'])
    assert.equal(broken.objects.lifepod instanceof Map, true, 'the kinds that were read are kept')
  },
}

const observationChecks = {
  id: 'observations',
  name: 'the observation of the life pods and of the wrecks compares where an object is and what the race knows of it: a wreck tied to a body follows the body\'s clock, so its position is no part of it, and the objects of unknown systems are not read',
  run: async ({ mod }) => {
    const db = constructed()
    const pods = await mod.ledger.readLifepodObservations(adapter(db), IDS)
    const wrecks = await mod.ledger.readWreckObservations(adapter(db), IDS)

    assert.deepEqual(pods.map(([id]) => id), [1, 3, 4, 5], 'the pods of known systems')
    assert.deepEqual(wrecks.map(([id]) => id), [1, 2, 3, 4, 5], 'the wrecks of known systems')

    db.run('update FCT_Wrecks set Xcor = Xcor + 500, Ycor = Ycor + 500 where WreckID in (1, 2, 4)')
    db.run('update FCT_Wrecks set Xcor = Xcor + 500 where WreckID = 5')

    const moved = await mod.ledger.readWreckObservations(adapter(db), IDS)
    const signature = (list, id) => list.find(([one]) => one === id)[1]

    assert.equal(signature(moved, 2), signature(wrecks, 2), 'a wreck tied to a body is the same wherever the body\'s clock puts it')
    assert.notEqual(signature(moved, 1), signature(wrecks, 1), 'a free own wreck that moved is another observation')
    assert.notEqual(signature(moved, 5), signature(wrecks, 5), 'a free wreck that moved is another observation')

    db.run('update FCT_Wrecks set Size = 2 where WreckID = 2')

    assert.notEqual(signature(await mod.ledger.readWreckObservations(adapter(db), IDS), 2), signature(wrecks, 2), 'a wreck of another size is another observation')

    db.run('update FCT_Lifepods set Xcor = Xcor + 1000 where LifepodID = 4')

    assert.notEqual(signature(await mod.ledger.readLifepodObservations(adapter(db), IDS), 4), signature(pods, 4), 'a pod that is elsewhere is another observation')

    // an own object whose id was given again to another object is another observation, whatever stayed the same
    const own = { pods: await mod.ledger.readLifepodObservations(adapter(db), IDS), wrecks: await mod.ledger.readWreckObservations(adapter(db), IDS) }

    db.run('update FCT_Lifepods set CreationTime = 2000 where LifepodID = 1')
    db.run("update FCT_Lifepods set ShipName = 'Replacement' where LifepodID = 3")
    db.run('update FCT_Wrecks set ShipID = 56 where WreckID = 1')

    const replaced = { pods: await mod.ledger.readLifepodObservations(adapter(db), IDS), wrecks: await mod.ledger.readWreckObservations(adapter(db), IDS) }

    assert.notEqual(signature(replaced.pods, 1), signature(own.pods, 1), 'an own pod created at another time is another observation')
    assert.notEqual(signature(replaced.pods, 3), signature(own.pods, 3), 'an own pod of another name is another observation')
    assert.notEqual(signature(replaced.wrecks, 1), signature(own.wrecks, 1), 'an own wreck of another ship is another observation')

    // the kinds are observed by the generic observation, under their own names
    const kinds = Object.keys(mod.obs.OBSERVED_KINDS)

    assert.deepEqual((await mod.obs.OBSERVED_KINDS.lifepod.read(adapter(db), IDS)).map(([id]) => id), [1, 3, 4, 5], 'the life pod kind reads the pods')
    assert.deepEqual((await mod.obs.OBSERVED_KINDS.wreck.read(adapter(db), IDS)).map(([id]) => id), [1, 2, 3, 4, 5], 'the wreck kind reads the wrecks')

    assert.equal(kinds.includes('lifepod') && kinds.includes('wreck') && kinds.includes('formation'), true, 'the generic observation names the life pods and the wrecks beside the formations')

    const settings = { store: {}, update (change) { this.store = change(this.store) } }

    mod.obs.saveObservationChoice(settings, 'c1', 7, 'lifepod', true)
    mod.obs.saveObservationChoice(settings, 'c1', 7, 'wreck', true)
    assert.deepEqual([...mod.obs.observedKinds(settings.store, 'c1', 7)].sort(), ['lifepod', 'wreck'], 'the choice is kept for both')
    assert.deepEqual([...mod.obs.observedKinds(settings.store, 'c1', 8)], [], 'and for the race it was made for only')
  },
}

const viewChecks = {
  id: 'view',
  name: 'the ledger\'s rows and figures: a row for each object with its status (pending where none), a vanished object in its own list, two statuses for one object both for review, and the figures split by list and status',
  run: async ({ mod }) => {
    const db = constructed()
    const repository = repositoryOf(mod)
    const bundle = await loadObjects(mod, db)
    const context = contextOf(bundle)

    for (const [type, id, status] of [['ownLifepod', 1, 'acknowledged'], ['wreck', 2, 'personal'], ['wreck', 4, 'personal']]) {
      assert.equal((await mod.ledger.setStatus(repository, SCOPE, { row: bundle.objects[type].get(id), status, context })).ok, true)
    }

    db.run('delete from FCT_Wrecks where WreckID = 4')

    const now = await loadObjects(mod, db)
    const read = mod.ledger.readRecovery(repository, SCOPE, contextOf(now))
    const rows = mod.ledger.recoveryRows({ objects: now.objects, entries: read.entries })
    const totals = mod.ledger.recoveryTotals(rows)

    assert.equal(rows.filter((row) => row.group === 'present').length, 2 + 2 + 1 + 3, 'a row for each object of the save')
    assert.deepEqual(totals.groups, { present: 8, gone: 1, review: 0, unread: 0, ahead: 0 })
    assert.deepEqual(totals.statuses, { pending: 6, acknowledged: 1, personal: 1 }, 'the statuses of the objects in the save, the vanished one counted in no status')
    assert.equal(rows.find((row) => row.group === 'gone').entry.status, 'personal', 'the vanished object keeps the status it had')
    assert.equal(rows.find((row) => row.type === 'wreck' && row.id === 3).status, 'pending', 'an object nobody annotated is pending')
  },
}

const wordChecks = {
  id: 'words',
  name: 'the words of the ledger give no outcome for a vanished object and expose no yield or deadline: no text of the module says rescued, salvaged, recovered, resolved, expired, lost, a yield or a deadline',
  run: async ({ mod }) => {
    const texts = [mod.ledger.GROUP_TEXT, mod.ledger.STATE_TEXT, mod.ledger.IDENTITY_TEXT, mod.ledger.STATUS_TEXT, mod.ledger.STATUS_HINT].flatMap((table) => Object.values(table))

    texts.push(mod.ledger.OBSERVATION_PURPOSE, mod.ledger.OBSERVATION_RULE)

    const forbidden = /\b(rescued|rescues|salvaged|salvage|recovered|resolved|expired|expires|yield|deadline|countdown|lost)\b/i

    texts.forEach((text) => assert.equal(forbidden.test(text), false, `a word of an outcome in: ${text}`))

    assert.equal(mod.ledger.GROUP_TEXT.gone, 'No longer observed')
    assert.equal(mod.ledger.STATUS_TEXT.personal, 'Personal recovery')
    assert.deepEqual(Object.keys(mod.ledger.STATUS_TEXT), ['pending', 'acknowledged', 'personal'])
  },
}

// Each save with the counts its SQL gives, apart from the module's statements.
const countOf = (db, sql) => db.query(sql).get().n

const known = (game, race) => `SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${game} and RaceID = ${race})`

const savesChecks = {
  id: 'saves',
  name: 'the objects of the real saves are the ones SQL gives, own and foreign apart, with the labels the game words them with and no field the race may not see',
  run: async ({ mod }) => {
    const skoormit = saveOf(SKOORMIT)
    const found = await loadObjects(mod, skoormit, SKOORMIT)

    assert.equal(found.objects.ownWreck.size, countOf(skoormit, `select count(*) as n from FCT_Wrecks where GameID = 138 and RaceID = 785 and ${known(138, 785)}`), 'Skoormit: the own wrecks')
    assert.equal(found.objects.wreck.size, countOf(skoormit, `select count(*) as n from FCT_Wrecks where GameID = 138 and RaceID != 785 and ${known(138, 785)}`), 'Skoormit: the foreign wrecks')
    assert.deepEqual([found.objects.ownWreck.size, found.objects.wreck.size, found.objects.ownLifepod.size, found.objects.lifepod.size], [10, 2, 0, 0], 'Skoormit as race 785: 10 own wrecks, 2 foreign, no pod')

    // Falryx at the later time, as race 791
    const falryx = saveOf(FALRYX_NOW)
    const now = await loadObjects(mod, falryx, FALRYX_NOW)
    const idsOf = (sql) => falryx.query(sql).all().map((row) => row.id)

    assert.deepEqual([...now.objects.ownLifepod.keys()], idsOf(`select LifepodID as id from FCT_Lifepods where GameID = 141 and RaceID = 791 and ${known(141, 791)} order by LifepodID`), 'Falryx: the own pods')
    assert.deepEqual([...now.objects.ownWreck.keys()], idsOf(`select WreckID as id from FCT_Wrecks where GameID = 141 and RaceID = 791 and ${known(141, 791)} order by WreckID`), 'Falryx: the own wrecks')
    assert.deepEqual([...now.objects.wreck.keys()], idsOf(`select WreckID as id from FCT_Wrecks where GameID = 141 and RaceID != 791 and ${known(141, 791)} order by WreckID`), 'Falryx: the foreign wrecks')
    assert.deepEqual([now.objects.ownLifepod.size, now.objects.ownWreck.size, now.objects.wreck.size], [4, 15, 42])

    const crew = falryx.query('select sum(Crew) as n from FCT_Lifepods where GameID = 141 and RaceID = 791').get().n

    assert.equal([...now.objects.ownLifepod.values()].reduce((sum, row) => sum + row.crew, 0), crew, 'Falryx: the crew of the own pods')

    // the label of a foreign wreck is the one the game gives it, read back by its parts
    const aliases = falryx.query('select w.WreckID as id, w.Size as size, ac.ClassName as cls, trim(ar.Abbrev) as tag from FCT_Wrecks w left join FCT_AlienClass ac on ac.GameID = w.GameID and ac.ViewRaceID = 791 and ac.ActualClassID = w.ClassID left join FCT_AlienRace ar on ar.GameID = w.GameID and ar.ViewRaceID = 791 and ar.AlienRaceID = w.RaceID where w.GameID = 141 and w.RaceID != 791 and w.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = 141 and RaceID = 791)').all()

    assert.equal(aliases.length, 42)

    for (const oracle of aliases) {
      const text = mod.ledger.labelOf(now.objects.wreck.get(oracle.id))
      const parts = /^Wreck of (.+?) class( \[(.+?)\])? #(\d+): ([\d.]+) tons$/.exec(text)

      assert.notEqual(parts, null, `the label of wreck ${oracle.id} is the game's wording: ${text}`)
      assert.equal(parts[1], oracle.cls || 'Unknown', `wreck ${oracle.id}: the class as the race names it`)
      assert.equal(parts[3] === undefined ? null : parts[3], oracle.cls && oracle.tag ? oracle.tag : null, `wreck ${oracle.id}: the race's tag appears with a class the race knows`)
      assert.equal(Number(parts[4]), oracle.id)
      assert.ok(Math.abs(Number(parts[5]) - oracle.size * 50) < 0.0001, `wreck ${oracle.id}: the tons are the size times fifty`)
    }

    const unknown = aliases.filter((one) => !one.cls).length

    assert.equal([...now.objects.wreck.values()].filter((row) => mod.ledger.labelOf(row).startsWith('Wreck of Unknown class')).length, unknown, 'Falryx: Unknown for exactly the classes the race has no alias for')

    const pods = falryx.query('select LifepodID as id, ShipName as name, Crew as crew from FCT_Lifepods where GameID = 141 and RaceID = 791 and SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = 141 and RaceID = 791) order by LifepodID').all()

    assert.deepEqual([...now.objects.ownLifepod.values()].map((row) => mod.ledger.labelOf(row)), pods.map((pod) => `${pod.name} life pods: ${pod.crew} crew`), 'Falryx: an own pod by its ship\'s name and crew')

    // the other Falryx save, race 785 sees one foreign pod
    const earlier = saveOf({ file: FALRYX_POD.file })
    const seen = await loadObjects(mod, earlier, { GameID: 141, RaceID: 785 })
    const pod = earlier.query('select p.LifepodID as id, ac.ClassName as cls, hd.HullAbbr as hull from FCT_Lifepods p left join FCT_AlienClass ac on ac.GameID = p.GameID and ac.ViewRaceID = 785 and ac.ActualClassID = p.ClassID left join FCT_HullDescription hd on hd.HullDescriptionID = ac.HullID where p.GameID = 141 and p.RaceID != 785 and p.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = 141 and RaceID = 785)').all()

    assert.deepEqual([...seen.objects.lifepod.values()].map((row) => mod.ledger.labelOf(row)), pod.map((row) => `${row.hull ? `${row.hull} ` : ''}${row.cls || 'Unknown'} life pods #${row.id}`), 'a foreign pod by the class the race knows and its id')
    assert.equal(seen.objects.lifepod.size, 1)

    // the modded save: foreign wrecks only
    const modded = saveOf(MODDED)
    const aurelian = await loadObjects(mod, modded, MODDED)
    const aliased = countOf(modded, 'select count(*) as n from FCT_Wrecks w where w.GameID = 140 and w.RaceID != 784 and w.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = 140 and RaceID = 784) and w.ClassID in (select ActualClassID from FCT_AlienClass where GameID = 140 and ViewRaceID = 784)')

    assert.deepEqual([aurelian.objects.wreck.size, aurelian.objects.ownWreck.size, aurelian.objects.lifepod.size + aurelian.objects.ownLifepod.size], [16, 0, 0])
    assert.equal([...aurelian.objects.wreck.values()].filter((row) => row.className).length, aliased, 'the wrecks of a class the race names')
    assert.equal(aliased, 11)

    // no foreign row of any save holds a field the race may not see
    for (const bundle of [found, now, seen, aurelian]) {
      for (const row of [...bundle.objects.lifepod.values(), ...bundle.objects.wreck.values()]) {
        assert.deepEqual(Object.keys(row).filter((key) => !FOREIGN_KEYS.includes(key)), [], `a foreign ${row.place} ${row.id} holds only what the race may see`)
      }
    }

    // the split of the wrecks of a system on the map is the one SQL gives
    const features = await mod.features.loadMapFeatures(adapter(skoormit), SKOORMIT)
    const split = skoormit.query('select SystemID as id, count(*) as total, sum(RaceID = 785) as own from FCT_Wrecks where GameID = 138 and SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = 138 and RaceID = 785) group by SystemID').all()

    assert.deepEqual(split.map((row) => [features[String(row.id)].wrecks, features[String(row.id)].ownWrecks]), split.map((row) => [row.total, row.own]), 'the wrecks of each system, and the own ones among them')
    assert.deepEqual([split.reduce((sum, row) => sum + row.own, 0), split.reduce((sum, row) => sum + row.total - row.own, 0)], [10, 2], 'Skoormit: 10 own wrecks and 2 foreign')
    assert.equal(Object.values(features).filter((system) => system.wrecks === 0 && system.ownWrecks !== 0).length, 0, 'a system with no wreck has no own one')
  },
}

// The judge of a browser variant, on results made by hand: a fault is credited only when the checks it names fail by a value and the page raised no error of its own, the fault that plants an error is credited only for that error, and a rewrite only when nothing fails. No page is involved; the judge's verdict is the observation.
const judgeChecks = {
  id: 'judge',
  name: 'a browser fault that shows a wrong status and also raises an error no check named is rejected, the fault that plants an error is accepted for its own error alone, and a rewrite that fails any check is rejected',
  run: () => {
    const made = (failedIds) => BROWSER_CHECKS.map(({ id }) => ({ id, name: id, ok: !failedIds.includes(id), kind: failedIds.includes(id) ? 'assertion' : null, threw: false, detail: '' }))
    const clean = { unexpected: [] }
    const stray = { unexpected: ['console error: [Vue warn]: Error in mounted hook: "Error: some other error"'] }
    const raised = 'console error: injected renderer error'
    const lookalikes = [
      'console error: TypeError: unrelated failure while handling injected renderer error',
      'page error: injected renderer error',
      'console error: Error: injected renderer error',
      'console error: injected renderer error ',
      'console error:  injected renderer error',
      'console error: injected renderer error\nTypeError: another error while handling injected renderer error',
      'console error: [Vue warn]: Error in created hook: "Error: injected renderer error"\n\nfound in\n\n---> <RecoveryLedger> at P:/lane/src/renderer/components/map/RecoveryLedger.vue',
      `${raised} ${'x'.repeat(600)}`.slice(0, 15 + 500),
      '',
    ]
    const plants = { name: 'planted error', fails: ['quiet'], raises: [raised] }
    const planted = { unexpected: [raised] }
    const wrongStatus = { name: 'wrong status', fails: ['kept'] }

    assert.equal(judgeVariant(wrongStatus, true, made(['kept']), clean).ok, true, 'a wrong status on a clean page is caught')
    assert.equal(judgeVariant(wrongStatus, true, made(['kept', 'quiet']), stray).ok, false, 'a wrong status and an unnamed error is not credited')
    assert.equal(judgeVariant(wrongStatus, true, made([]), clean).ok, false, 'a fault no check names fails is not caught')
    assert.equal(judgeVariant(plants, true, made(['quiet']), planted).ok, true, 'the planted error is caught by quiet')
    assert.equal(judgeVariant(plants, true, made(['quiet']), { unexpected: [raised, ...stray.unexpected] }).ok, false, 'the planted error and another is not credited')
    lookalikes.forEach((text) => assert.equal(judgeVariant(plants, true, made(['quiet']), { unexpected: [raised, text] }).ok, false, `an error that is not the planted message is not credited beside it: ${text.slice(0, 80)}`))
    lookalikes.forEach((text) => assert.equal(judgeVariant(plants, true, made(['quiet']), { unexpected: [text] }).ok, false, `an error that is not the planted message is not credited alone: ${text.slice(0, 80)}`))
    assert.equal(judgeVariant(plants, true, made(['quiet']), { unexpected: [raised, raised] }).ok, true, 'the planted message twice is still the planted error')
    assert.equal(judgeVariant(plants, true, made(['quiet']), clean).ok, false, 'no error at all is not the planted one')
    assert.equal(judgeVariant(plants, true, made(['quiet']), { unexpected: [raised] }).ok, true, 'the planted error alone is caught by quiet')
    assert.equal(judgeVariant(plants, true, made(['kept']), { unexpected: [raised] }).ok, false, 'the planted error is not credited to a check it does not fail')
    assert.equal(judgeVariant({ name: 'rewrite' }, false, made([]), clean).ok, true, 'a rewrite that fails nothing passes')
    assert.equal(judgeVariant({ name: 'rewrite' }, false, made(['quiet']), stray).ok, false, 'a rewrite on a page with an unnamed error fails')
    assert.equal(judgeVariant({ name: 'rewrite' }, false, made(['rows']), clean).ok, false, 'a rewrite that changes a value fails')
  },
}

const CHECKS = [unitChecks, matrixChecks, identityChecks, hiddenChecks, readerChecks, observationChecks, viewChecks, wordChecks, savesChecks, judgeChecks]

// ---------- the faults and the rewrites of the utilities ----------

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a vanished object reads as held', file: 'recovery-ledger', find: "if (link.status === 'missing') {\n    return STATES.GONE", to: "if (link.status === 'missing') {\n    return STATES.HELD", fails: ['matrix', 'view'] },
  { name: 'another object under the id reads as the one kept', file: 'recovery-ledger', find: "if (link.status === 'changed') {\n    return STATES.REUSED", to: "if (link.status === 'changed') {\n    return STATES.HELD", fails: ['matrix', 'identity'] },
  { name: 'an own pod with no creation time is certified', file: 'recovery-ledger', find: "return link.status === 'unknown' ? STATES.UNVERIFIED : STATES.HELD", to: 'return STATES.HELD', fails: ['matrix'] },
  { name: 'a kind that was not read reads as gone', file: 'recovery-ledger', find: "if (!link || (link.status === 'unknown' && !link.unverified)) {\n    return STATES.UNREAD", to: "if (!link || (link.status === 'unknown' && !link.unverified)) {\n    return STATES.GONE", fails: ['matrix'] },
  { name: 'a status kept at a later time is applied', file: 'recovery-ledger', find: 'const applied = entries.filter((entry) => !entry.ahead)', to: 'const applied = entries', fails: ['matrix'] },
  { name: 'a vanished object is left out of the ledger', file: 'recovery-ledger', find: 'if (entry.state === STATES.GONE) {\n      rest.push(listed(entry, GROUPS.GONE))', to: 'if (entry.state === STATES.GONE) {\n      return', fails: ['matrix', 'view'] },
  { name: 'a status belongs to the campaign, not the branch', file: 'recovery-ledger', find: "policy: 'branch', links", to: "policy: 'campaign', links", fails: ['units'] },
  { name: 'pending keeps the status', file: 'recovery-ledger', find: 'return entry ? await removeStatus(repository, scope, entry) : { ok: true, record: null }', to: 'return { ok: true, record: null }', fails: ['units'] },
  { name: 'a duplicate id is kept twice', file: 'recovery-ledger', find: "throw Object.assign(new Error('This id has a status kept already", to: "return\n          throw Object.assign(new Error('This id has a status kept already", fails: ['units'] },
  { name: 'a status is kept for an object picked in another race, branch or save', file: 'recovery-ledger', find: "const checked = checkLink(context, scope, { type: row.type, row }, RECOVERY_TARGETS, 'status')", to: 'const checked = { ok: true, row }', fails: ['units'] },
  { name: 'the twins of a foreign wreck are counted as one', file: 'recovery-ledger', find: 'return rows.map((row) => ({ ...row, copies: counts.get(RECOVERY_TARGETS[type].fingerprint(row)) }))', to: 'return rows.map((row) => ({ ...row, copies: 1 }))', fails: ['identity', 'objects'] },
  { name: 'the foreign wreck statement selects the ship', file: 'recovery-ledger', find: 'FCT_Wrecks.Size, FCT_AlienClass.AlienClassID, FCT_AlienClass.ClassName as AlienClassName, FCT_HullDescription.HullAbbr, FCT_AlienRace.Abbrev as RaceTag', to: 'FCT_Wrecks.Size, FCT_Wrecks.ShipID, FCT_AlienClass.AlienClassID, FCT_AlienClass.ClassName as AlienClassName, FCT_HullDescription.HullAbbr, FCT_AlienRace.Abbrev as RaceTag', fails: ['hidden'] },
  { name: 'the foreign pod statement selects the name and the crew', file: 'recovery-ledger', find: 'select FCT_Lifepods.LifepodID, FCT_Lifepods.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Lifepods.Xcor, FCT_Lifepods.Ycor, FCT_AlienClass.AlienClassID', to: 'select FCT_Lifepods.LifepodID, FCT_Lifepods.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Lifepods.Xcor, FCT_Lifepods.Ycor, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, FCT_AlienClass.AlienClassID', fails: ['hidden'] },
  { name: 'the objects of a system the race does not know are read', file: 'recovery-ledger', find: 'const KNOWN = (table, { GameID, RaceID }) => `inner join', to: 'const KNOWN = (table, { GameID, RaceID }) => `left join', fails: ['objects', 'observations'] },
  { name: 'the foreign wrecks hold the own ones too', file: 'recovery-ledger', find: 'and FCT_Wrecks.RaceID != ${RaceID} order by FCT_Wrecks.WreckID', to: 'order by FCT_Wrecks.WreckID', fails: ['objects', 'saves'] },
  { name: 'a class the race has no alias for is named by its real name', file: 'recovery-ledger', find: "return `Wreck of ${row.className || 'Unknown'} class", to: "return `Wreck of ${row.className || 'Mystery'} class", fails: ['objects', 'saves'] },
  { name: 'a pod has an age before it was made', file: 'recovery-ledger', find: ' && gameTime >= row.created ? gameTime - row.created : null', to: ' ? gameTime - row.created : null', fails: ['objects'] },
  { name: 'the position of a wreck tied to a body is part of its observation', file: 'recovery-ledger', find: '...(row.orbitBodyId ? [] : [spot(row.x), spot(row.y)])', to: '...[spot(row.x), spot(row.y)]', fails: ['observations'] },
  { name: 'a vanished object is worded as an outcome', file: 'recovery-ledger', find: "gone: 'The open save holds no object under this id, and nothing says why it is gone, so the status stays as it was kept.'", to: "gone: 'The object was rescued.'", fails: ['words'] },
  { name: 'the lists name a yield', file: 'recovery-ledger', find: "GROUP_TEXT = Object.freeze({\n  present: 'In the save',", to: "GROUP_TEXT = Object.freeze({\n  present: 'In the save, with a yield',", fails: ['words'] },
  { name: 'the own wrecks are counted as foreign on the map', file: 'map-features', find: 'sum(FCT_Wrecks.RaceID = ${RaceID}) as Own', to: 'sum(FCT_Wrecks.RaceID != ${RaceID}) as Own', fails: ['saves'] },
  { name: 'the observation of the wrecks reads the pods', file: 'observations', find: 'read: readWreckObservations', to: 'read: readLifepodObservations', fails: ['observations'] },
  { name: 'the observation of an own pod leaves out when it was made and its name', file: 'recovery-ledger', find: '...(row.own ? [present(row.created), present(row.shipName)] : [])', to: '...[]', fails: ['observations'] },
  { name: 'the observation of an own wreck leaves out its ship', file: 'recovery-ledger', find: '...(row.own ? [present(row.shipId)] : [])', to: '...[]', fails: ['observations'] },
  { name: 'an unknown crew is shown as none', file: 'recovery-ledger', find: "row.crew === null ? 'crew unknown' : `${count(row.crew)} crew`", to: '`${count(row.crew === null ? 0 : row.crew)} crew`', fails: ['objects'] },
]

// Rewrites that say the same thing: a condition parenthesised, operands of a test turned about, a key built another way, a clause with a default order and a word of prose changed.
const BENIGN = [
  { name: 'the test of an unread kind parenthesised', file: 'recovery-ledger', find: 'if (!(objects instanceof Map)) {\n      throw new TypeError', to: 'if (!((objects instanceof Map))) {\n      throw new TypeError' },
  { name: 'the operands of the test of an id turned about', file: 'recovery-ledger', find: "typeof id === 'number' && Number.isSafeInteger(id) && id > 0", to: "id > 0 && Number.isSafeInteger(id) && typeof id === 'number'" },
  { name: 'the size key written through a number', file: 'recovery-ledger', find: 'finite(size) ? size.toFixed(6) : \'\'', to: 'finite(size) ? Number(size.toFixed(6)).toFixed(6) : \'\'' },
  { name: 'an order clause spelled out', file: 'recovery-ledger', find: 'and FCT_Wrecks.RaceID = ${RaceID} order by FCT_Wrecks.WreckID`', to: 'and FCT_Wrecks.RaceID = ${RaceID} order by FCT_Wrecks.WreckID asc`' },
  { name: 'the hint of a status in other words', file: 'recovery-ledger', find: "acknowledged: 'Seen and noted, with no recovery planned.'", to: "acknowledged: 'Seen and noted; no recovery is planned.'" },
]
/* eslint-enable no-template-curly-in-string */

const FILES = { 'recovery-ledger': path.join(UTILITIES, 'recovery-ledger.js'), 'map-features': path.join(UTILITIES, 'map-features.js'), observations: path.join(UTILITIES, 'observations.js'), 'observation-words': path.join(UTILITIES, 'observation-words.js') }

const sources = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))

const resultsOf = async (variant, ids) => {
  const changed = variant ? { [variant.file]: patched(`${variant.file}.js`, sources[variant.file], variant.find, variant.to) } : {}
  const mod = await modulesOf(changed)

  return await runChecks(CHECKS.filter(({ id }) => !ids || ids.includes(id)), { mod })
}

const checkHead = async () => {
  const found = await resultsOf(null)

  judged(found, 'the sources')
  found.forEach((result) => check(result.name, result.ok, result.detail))
}

const checkFault = async (fault) => {
  const found = await resultsOf(fault, fault.fails)
  const failed = judged(found, fault.name)

  check(`fault caught: ${fault.name}`, caughtBy(failed, fault.fails, { name: fault.name }), notCaught(found))
}

const checkRewrite = async (rewrite) => {
  const wrong = judged(await resultsOf(rewrite), rewrite.name).map((result) => `${result.id}: ${result.detail}`)

  check(`variant passes: ${rewrite.name}`, wrong.length === 0, wrong.join('; '))
}

// ---------- the browser: the real app over a copy of the Skoormit save ----------

const TIMEOUT = 120000
const BROWSER = { server: null, chrome: null, failure: null, later: null }
const LEDGER_VUE = inRenderer('components', 'map', 'RecoveryLedger.vue')
const OUTCOME_WORDS = /\b(rescued|rescues|salvaged|recovered|resolved|expired|yield|deadline|countdown)\b/i
const RECOVERY_JS = inRenderer('utilities', 'recovery-ledger.js')
const STEP = 432000

// What the dialog draws: the rows with the visible text of each cell, of the active status button and of the observation, the figure, the lists of statuses whose object is not the one under the id, and the text of the whole dialog, each read through the visible text nodes. A hook gives the identity of a row or an entry, never what it says.
const readLedger = () => {
  const { visible, visibleText } = window.__screen
  const own = (element, selector) => {
    const found = element.querySelector(selector)

    return found ? visibleText(found).trim() : null
  }
  const dialog = document.querySelector('.v-dialog--active')
  const headers = [...document.querySelectorAll('[data-recovery-table] thead th')].map((element) => visibleText(element).trim())
  const rowOf = (element) => {
    const line = element.closest('tr')
    const active = line.querySelector('[data-recovery-status] .v-btn--active')
    const observed = line.querySelector('[data-observed]')

    return {
      key: element.getAttribute('data-recovery-row'),
      own: element.getAttribute('data-recovery-own') === 'true',
      label: own(element, '[data-recovery-label]'),
      on: visible(element),
      cells: Object.fromEntries([...line.children].map((cell, index) => [headers[index], visibleText(cell).trim()])),
      status: active ? visibleText(active).trim() : null,
      observed: observed ? { headline: own(observed, '[data-observed-headline]'), summary: own(observed, '[data-observed-summary]'), lines: [...observed.querySelectorAll('[data-observed-line]')].map((element) => visibleText(element).trim()) } : null,
    }
  }

  return {
    route: window.$app.$route.path,
    grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'),
    open: Boolean(dialog) && visible(dialog),
    text: dialog ? visibleText(dialog) : '',
    count: document.querySelector('[data-recovery-count]') ? visibleText(document.querySelector('[data-recovery-count]')).trim() : null,
    rows: [...document.querySelectorAll('[data-recovery-row]')].map(rowOf),
    entries: [...document.querySelectorAll('[data-recovery-entry]')].map((element) => ({ key: element.getAttribute('data-recovery-entry'), headline: own(element, '[data-recovery-headline]'), label: own(element, '[data-recovery-entry-label]'), detail: own(element, '[data-recovery-entry-detail]'), holder: own(element, '[data-recovery-holder]'), on: visible(element) })),
    groups: [...document.querySelectorAll('[data-recovery-group]')].map((element) => element.getAttribute('data-recovery-group')),
  }
}

const observeCase = (browser, server, plan) => observe(browser, async ({ page, step }) => {
  const pageLoading = require('./page-loading')
  const seen = {}
  let inFlight = 0
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !request.url().endsWith('/stat')

  page.on('request', (request) => { if (isDatabaseCall(request)) inFlight++ })
  page.on('requestfinished', (request) => { if (isDatabaseCall(request)) inFlight-- })
  page.on('requestfailed', (request) => { if (isDatabaseCall(request)) inFlight-- })

  const settle = async () => {
    step('waiting for the page to settle')

    const deadline = Date.now() + TIMEOUT

    for (;;) {
      await page.evaluate(() => new Promise((resolve) => window.$app.$nextTick(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))

      if (inFlight === 0 && !(await page.evaluate(pageLoading))) {
        return
      }

      if (Date.now() > deadline) {
        throw new Error('the page did not settle')
      }

      await page.waitForTimeout(50)
    }
  }
  const openApp = async () => {
    step('opening the app')
    await installScreen(page)
    await page.goto(server.url, { timeout: TIMEOUT })

    const picker = page.locator('.empire-list').first()

    step('picking the game')
    await picker.locator('.empire-list__game').filter({ hasText: `${SKOORMIT.game} ·` }).first().click({ timeout: TIMEOUT })

    if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
      await picker.getByText(SKOORMIT.race, { exact: true }).last().click({ timeout: TIMEOUT })
    }

    await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix) && Boolean(window.$app.$store.getters['history/campaign']), null, { timeout: TIMEOUT })
    await settle()
  }
  const openLedger = async () => {
    step('opening the map')
    await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), '/map')
    await page.waitForFunction(pageLoading.arrived, '/map', { timeout: TIMEOUT })
    await page.waitForSelector('[data-recovery-open]:not([disabled])', { state: 'attached', timeout: TIMEOUT })
    await settle()
    step('opening the ledger')
    await page.locator('[data-recovery-open]').click({ timeout: TIMEOUT })
    await page.waitForSelector('[data-recovery-table]', { state: 'attached', timeout: TIMEOUT })
    await settle()
  }
  const read = () => page.evaluate(readLedger)

  await openApp()
  await openLedger()
  seen.first = await read()

  const own = seen.first.rows.find((row) => row.own)

  seen.picked = own ? own.key : null

  if (!own || plan.until === 'first') {
    return seen
  }

  step('switching the observation on')
  await page.locator('[data-observe="control"] .v-input--switch label').click({ timeout: TIMEOUT })
  await page.waitForSelector('[data-observed-state="observed"]', { state: 'attached', timeout: TIMEOUT })
  await settle()
  seen.observing = await read()

  if (plan.until === 'observing') {
    return seen
  }

  step('keeping a personal recovery')
  await page.locator(`[data-recovery-status="${own.key}"] [data-status-option="personal"]`).click({ timeout: TIMEOUT })
  await settle()
  seen.kept = await read()

  if (plan.until === 'kept') {
    return seen
  }

  await server.useSave(await plan.later(own.key))
  await openApp()
  await openLedger()
  step('waiting for the capture of the later save')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-observed-summary]')].some((element) => /^2 captures/.test(element.textContent)), null, { timeout: 30000 }).catch(() => {})
  await settle()
  seen.gone = await read()

  return seen
})

// A copy of the save five days on, with the wreck of the row removed: the ledger then reads the same game a moment later, with that object gone and a second capture to make.
const laterCopy = async (key) => {
  const file = path.join(os.tmpdir(), `ae-recovery-${process.pid}.db`)

  fs.copyFileSync(path.join(root, SKOORMIT.file), file)
  BROWSER.later = file

  const db = new Database(file)

  db.run(`delete from FCT_Wrecks where GameID = ${SKOORMIT.GameID} and WreckID = ${Number(key.split(':')[1])}`)
  db.run(`update FCT_Game set GameTime = GameTime + ${STEP} where GameID = ${SKOORMIT.GameID}`)
  db.run(`insert into FCT_Increments (IncrementID, GameID, GameTime, Length) select max(IncrementID) + 1, ${SKOORMIT.GameID}, ${gameTimeOf() + STEP}, ${STEP} from FCT_Increments`)
  db.close()

  return file
}

const observeSource = async (replacements = [], until = null) => {
  if (BROWSER.failure || !BROWSER.chrome) {
    return failedObservation(BROWSER.failure || 'the page server was not started for this worker')
  }

  replacements.forEach(([file, text]) => BROWSER.server.replace(file, text))

  try {
    const seen = await observeCase(BROWSER.chrome, BROWSER.server, { until, later: laterCopy })

    report(replacements.length ? 'a variant of the app' : 'the recovery ledger', seen)

    return seen
  } catch (error) {
    return failedObservation(String(error.message).split('\n')[0])
  } finally {
    replacements.forEach(([file]) => BROWSER.server.replace(file, null))
  }
}

// The wrecks of the save as SQL gives them, each by its own statements and not the ledger's: id, whether own, tons, the system the race knows it by, the class (the owner's for an own wreck, the viewing race's own for another's), its hull, and the tag of the race when the class is known.
const wreckOracle = () => {
  const { GameID, RaceID } = SKOORMIT
  const classOf = (column) => `(select ${column} from FCT_AlienClass where GameID = w.GameID and ViewRaceID = ${RaceID} and ActualClassID = w.ClassID)`
  const ownClass = (column) => `(select ${column} from FCT_ShipClass where GameID = w.GameID and ShipClassID = w.ClassID)`

  return saveOf(SKOORMIT).query(`select w.WreckID as id, w.RaceID = ${RaceID} as own, w.Size * 50 as tons, (select Name from FCT_RaceSysSurvey where GameID = w.GameID and RaceID = ${RaceID} and SystemID = w.SystemID) as system, case when w.RaceID = ${RaceID} then ${ownClass('ClassName')} else ${classOf('ClassName')} end as cls, case when w.RaceID = ${RaceID} then (select HullAbbr from FCT_HullDescription where HullDescriptionID = ${ownClass('HullDescriptionID')}) else (select HullAbbr from FCT_HullDescription where HullDescriptionID = ${classOf('HullID')}) end as hull, case when w.RaceID != ${RaceID} and ${classOf('AlienClassID')} is not null then (select trim(Abbrev) from FCT_AlienRace where GameID = w.GameID and ViewRaceID = ${RaceID} and AlienRaceID = w.RaceID) end as tag from FCT_Wrecks w where w.GameID = ${GameID} and w.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${GameID} and RaceID = ${RaceID}) order by w.WreckID`).all()
}

// A game time as the date the ledger writes, from the start year of the save and the calendar's own arithmetic (a year starts on the 1st of January).
const dateOf = (seconds) => new Date(Date.UTC(saveOf(SKOORMIT).query(`select StartYear from FCT_Game where GameID = ${SKOORMIT.GameID}`).get().StartYear, 0, 1) + seconds * 1000).toISOString().slice(0, 10)

const gameTimeOf = () => saveOf(SKOORMIT).query(`select GameTime from FCT_Game where GameID = ${SKOORMIT.GameID}`).get().GameTime

// The label of a wreck as the screen shows it, read apart: the class the label names, the tag of the race, the id and the tons.
const wreckShown = (label, grouping) => {
  const parts = /^Wreck of (.+?) class(?: \[(.+?)\])? #(\d+): (\S+) tons$/.exec(label || '')

  return parts ? { cls: parts[1], tag: parts[2] || null, id: Number(parts[3]), tons: readFigure(parts[4], grouping) } : null
}

const classCellOf = (expected) => [expected.hull, expected.cls].filter(Boolean).join(' ') || 'Unknown'

// The count of captures a summary starts with, read as a figure (NaN when it starts with none) and not as a sentence.
const captureCount = (summary) => Number((/^(\d+) captures?\b/.exec(summary) || [])[1])

// The dates the lines of an observation carry as the latest capture, read back through the production wording of the variant's own module.
const latestDates = (mod, lines) => lines.map((line) => mod.words.readLatestCapture('observed', line)).filter((date) => date !== null)

const BROWSER_CHECKS = [
  {
    id: 'rows',
    name: 'browser: the ledger opens from the Galaxy Map with a row for each wreck of the known systems, each shown by the label, the system, the class and the tons that SQL gives for that wreck, with the status pending and no observation while the switch is off, and the figure says how many are in the save',
    run: ({ observation, mod }) => {
      const seen = observation.value.first
      const words = mod.ledger
      const { pairs, problems } = pairedBy('the wrecks listed', seen.rows, wreckOracle(), (row) => (wreckShown(row.label, seen.grouping) || {}).id, (row) => row.id)

      assert.equal(seen.route, '/map')
      assert.equal(seen.open, true, 'the dialog is on screen')
      assert.deepEqual(problems, [], 'the wrecks listed are the ones SQL gives, each once')
      pairs.forEach(([expected, row]) => {
        const label = wreckShown(row.label, seen.grouping)
        const size = /^(\S+) tons$/.exec(row.cells['Count or size'] || '')

        assert.equal(row.on, true, `${row.key} is on screen`)
        assert.equal(row.own, expected.own === 1, `${row.label}: own or foreign`)
        assert.equal(label.cls, expected.cls || 'Unknown', `${row.label}: the class of the label`)
        assert.equal(label.tag, expected.tag || null, `${row.label}: the tag of the race of the label`)
        assert.ok(Math.abs(label.tons - expected.tons) <= 0.5, `${row.label}: the tons, shown to the whole ton`)
        assert.equal(row.cells.System, expected.system, `${row.label}: the system`)
        assert.equal(row.cells.Class, classCellOf(expected), `${row.label}: the class column`)
        assert.ok(size && Math.abs(readFigure(size[1], seen.grouping) - expected.tons) <= 0.5, `${row.label}: the size column ${row.cells['Count or size']}`)
        assert.equal(row.cells.Age, '—', `${row.label}: a wreck has no age`)
        assert.equal(labelKey(row.status, words.STATUS_TEXT), 'pending', `${row.label}: the status the row shows is pending (${row.status})`)
        assert.equal(row.observed, null, `${row.label}: no observation is shown while the switch is off`)
      })
      assert.equal(seen.rows.filter((row) => row.own).length, 10, 'Skoormit: 10 own wrecks')
      assert.equal(seen.rows.filter((row) => !row.own).length, 2, 'Skoormit: 2 foreign wrecks')
      assert.equal(seen.count, '12 in the save, 0 with a status')
      assert.deepEqual(seen.entries, [], 'no status, so no list of vanished objects')
    },
  },
  {
    id: 'observed',
    name: 'browser: with the observation switched on, each wreck says since when it was observed, at how many captures and the date of the latest capture that saw it, as the capture time of the save gives them',
    run: ({ observation, mod }) => {
      const seen = observation.value.observing
      const date = dateOf(gameTimeOf())

      assert.equal(seen.rows.length, 12)
      seen.rows.forEach((row) => {
        assert.ok(row.observed, `${row.label}: an observation is shown`)
        assert.ok(row.observed.headline.includes(date), `${row.label}: since when, ${row.observed.headline}`)
        assert.equal(captureCount(row.observed.summary), 1, `${row.label}: the captures (${row.observed.summary})`)
        assert.deepEqual(latestDates(mod, row.observed.lines), [date], `${row.label}: the latest capture, ${row.observed.lines.join(' | ')}`)
      })
    },
  },
  {
    id: 'kept',
    name: 'browser: a personal recovery kept on a row is shown on that row by the word of its button and counted, and every other row still says pending',
    run: ({ observation, mod }) => {
      const seen = observation.value
      const words = mod.ledger

      assert.equal(seen.kept.rows.length, 12)
      seen.kept.rows.forEach((row) => assert.equal(labelKey(row.status, words.STATUS_TEXT), row.key === seen.picked ? 'personal' : 'pending', `${row.label}: the status the row shows (${row.status})`))
      assert.equal(seen.kept.count, '12 in the save, 1 with a status')
    },
  },
  {
    id: 'gone',
    name: 'browser: an object that vanished from the save is listed as no longer observed under the label, the system and the status it was kept with, no outcome is worded, the date it had been observed up to is the one of the capture it was kept at, and the other rows are as they were',
    run: ({ observation, mod }) => {
      const seen = observation.value
      const words = mod.ledger
      const picked = wreckOracle().find((row) => row.id === Number(seen.picked.split(':')[1]))
      const entry = seen.gone.entries[0]

      assert.deepEqual(seen.gone.groups, ['gone'], 'one list, the vanished objects')
      assert.equal(seen.gone.entries.length, 1)
      assert.equal(entry.headline, 'No longer observed')
      assert.equal(entry.on, true)

      const parts = /^(Wreck of .+? class(?: \[.+?\])? #\d+: \S+ tons) in (.+)\. Status: (.+)\.$/.exec(entry.label || '')

      assert.ok(parts, `the entry reads as an object, a system and a status: ${entry.label}`)

      const label = wreckShown(parts[1], seen.gone.grouping)

      assert.equal(label.id, picked.id, 'the object named is the one that vanished')
      assert.equal(label.cls, picked.cls || 'Unknown', 'its class')
      assert.equal(label.tag, picked.tag || null, 'its tag')
      assert.ok(Math.abs(label.tons - picked.tons) <= 0.5, 'its tons')
      assert.equal(parts[2], picked.system, 'its system')
      assert.equal(labelKey(parts[3], words.STATUS_TEXT), 'personal', `the status it is listed with (${parts[3]})`)
      assert.ok(entry.detail.startsWith(words.STATE_TEXT.gone), 'what the entry says of it')
      assert.ok(entry.detail.includes(dateOf(gameTimeOf())) && !entry.detail.includes(dateOf(gameTimeOf() + STEP)), `the date it had been observed up to is the capture it was kept at: ${entry.detail}`)
      assert.equal(entry.holder, null, 'no other object holds the id')
      assert.equal(seen.gone.rows.length, 11, 'the other eleven are still listed')
      assert.equal(seen.gone.rows.some((row) => row.key === seen.picked), false, 'the vanished object has no row of its own')
      assert.equal(seen.gone.count, '11 in the save, 1 with a status', 'the status kept for the vanished object is still counted as kept')
    },
  },
  {
    id: 'recaptured',
    name: 'browser: a later save of the same game is captured too, so the objects still there say two captures and the date of the later one as the latest, with the first capture as their start',
    run: ({ observation, mod }) => {
      const seen = observation.value.gone
      const first = dateOf(gameTimeOf())
      const latest = dateOf(gameTimeOf() + STEP)

      assert.notEqual(first, latest, 'the two captures fall on different days')
      seen.rows.forEach((row) => {
        assert.ok(row.observed, `${row.label}: an observation is shown`)
        assert.ok(row.observed.headline.includes(first), `${row.label}: since when, ${row.observed.headline}`)
        assert.equal(captureCount(row.observed.summary), 2, `${row.label}: the captures (${row.observed.summary})`)
        assert.deepEqual(latestDates(mod, row.observed.lines), [latest], `${row.label}: the latest capture, ${row.observed.lines.join(' | ')}`)
      })
    },
  },
  {
    id: 'words',
    name: 'browser: no text of the ledger names an outcome, a yield or a deadline',
    run: ({ observation }) => {
      const seen = observation.value

      ;[seen.first, seen.observing, seen.kept, seen.gone].forEach((screen) => assert.equal(OUTCOME_WORDS.test(screen.text), false, `a word of an outcome on screen: ${(OUTCOME_WORDS.exec(screen.text) || [''])[0]}`))
    },
  },
  {
    id: 'quiet',
    name: 'browser: the app raised no page error, console error or Vue error that no check named, and the observation itself did not fail',
    run: ({ observation }) => {
      assert.deepEqual(observation.unexpected, [], 'the page raised errors that no check named')
      assert.equal(observation.error, null, 'the observation failed in itself')
    },
  },
]

// The checks that run for every variant, whatever the fault names: the app raises no error of its own.
const ALWAYS = ['quiet']

const browserResults = async (observation, ids, mod) => {
  if (unobserved(observation)) {
    throw new HarnessError(`the app did not get through: ${observation.error}`)
  }

  return await runChecks(BROWSER_CHECKS.filter(({ id }) => !ids || ids.includes(id) || ALWAYS.includes(id)), { observation, mod })
}

const checkBrowserHead = async () => {
  const found = await browserResults(await observeSource(), null, await modulesOf())

  judged(found, 'the app')
  found.forEach((result) => check(result.name, result.ok, result.detail))
}

const BROWSER_FAULTS = [
  { name: 'the ledger words a vanished object as rescued', file: LEDGER_VUE, find: "group === GROUPS.GONE ? 'No longer observed'", to: "group === GROUPS.GONE ? 'Rescued'", fails: ['gone'], until: null },
  { name: 'a status pressed is kept as acknowledged', file: LEDGER_VUE, find: 'row: item.object, status, entry: item.entry', to: "row: item.object, status: 'acknowledged', entry: item.entry", fails: ['kept'], until: 'kept' },
  { name: 'a row is labelled by its id', file: LEDGER_VUE, find: 'label: labelOf(object, this.count),', to: 'label: String(object.id),', fails: ['rows'], until: 'first' },
  { name: 'every class is shown as a secret one with the hooks intact', file: LEDGER_VUE, find: "classText: classTextOf(object) || 'Unknown',", to: "classText: 'SECRET-FOREIGN-CLASS',", fails: ['rows'], until: 'first' },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a wreck is labelled without the tag of its race', file: RECOVERY_JS, find: " class${row.raceTag ? ` [${row.raceTag}]` : ''} #", to: ' class #', fails: ['rows'], until: 'first' },
  { name: 'the status buttons are all worded as pending while the hooks hold the status', file: LEDGER_VUE, find: 'kept: STATUS_ORDER.map((status) => ({ value: status, text: STATUS_TEXT[status], hint', to: 'kept: STATUS_ORDER.map((status) => ({ value: status, text: STATUS_TEXT.pending, hint', fails: ['kept'], until: 'kept' },
  { name: 'a vanished object is listed with the wrong status', file: LEDGER_VUE, find: 'Status: {{ statusText[item.status] }}.', to: 'Status: {{ statusText.acknowledged }}.', fails: ['gone'], until: null },
  { name: 'a vanished object is listed under another label', file: LEDGER_VUE, find: 'label: entry.ref.label,', to: "label: 'Wreck of Unknown class #1: 1 tons',", fails: ['gone'], until: null },
  { name: 'the latest capture of an observed object is left out', file: LEDGER_VUE, find: 'details: last ? [...text.details, last] : text.details', to: 'details: text.details', fails: ['observed'], until: 'observing' },
  { name: 'the status is kept without what had been observed of the object', file: LEDGER_VUE, find: 'observed: this.stampOf(item), context: this.context', to: 'observed: null, context: this.context', fails: ['gone'], until: null },
  { name: 'the latest capture of an observed object is worded as its first', file: inRenderer('utilities', 'observation-view.js'), find: 'LATEST_CAPTURE_WORDS[state](date(span.last))', to: 'LATEST_CAPTURE_WORDS[state](date(span.first))', fails: ['recaptured'], until: null },
  { name: 'the dialog raises a renderer error that changes nothing it draws', file: LEDGER_VUE, find: "name: 'RecoveryLedger',", to: "name: 'RecoveryLedger',\n  created() { console.error('injected renderer error') },", fails: ['quiet'], raises: ['console error: injected renderer error'], until: 'first' },
]

const BROWSER_BENIGN = [
  { name: 'the status toggle handled through the event\'s argument', file: LEDGER_VUE, find: '@change="(value) => choose(item, value)"', to: '@change="choose(item, $event)"' },
  { name: 'the latest capture line added through a spread', file: LEDGER_VUE, find: 'details: last ? [...text.details, last] : text.details', to: 'details: [...text.details, ...(last ? [last] : [])]' },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the latest capture worded as the most recent', file: inRenderer('utilities', 'observation-words.js'), find: 'The latest capture that saw it is of ${date}.', to: 'The most recent capture that saw it is of ${date}.' },
  { name: 'the status of a vanished object worded through the table of the module', file: LEDGER_VUE, find: 'Status: {{ statusText[item.status] }}.', to: 'Status: {{ statusText[item.status] || \'\' }}.' },
]

// What a served variant is judged by, apart from the credit of a fault: a fault passes only when each check it names fails by a value, no always-run check it does not name fails, and, for the fault that names an always-run check, the page recorded the complete messages of the variant's `raises` and no other (each is a console error with a fixed text well under the 500 characters the observation keeps, so an entry that equals one is that whole message and nothing was cut from it; every other entry, whatever it contains, is not the planted error); a rewrite passes only when no check fails. `found` is the results of the checks run for the variant, `observation` what the page did. Returns { ok, detail }.
const judgeVariant = (variant, fault, found, observation) => {
  const failed = found.filter((result) => !result.ok)

  if (!fault) {
    return { ok: failed.length === 0, detail: failed.map((result) => `${result.id}: ${result.detail}`).join('; ') }
  }

  const stray = failed.filter((result) => ALWAYS.includes(result.id) && !variant.fails.includes(result.id))
  const planted = !variant.raises || (observation.unexpected.length > 0 && observation.unexpected.every((text) => variant.raises.includes(text)))

  if (stray.length) {
    return { ok: false, detail: `the page failed a check the fault does not name: ${stray.map((result) => result.id).join(', ')}` }
  }

  if (!planted) {
    return { ok: false, detail: `the page did not raise the planted error alone (expected only ${JSON.stringify(variant.raises)}): ${observation.unexpected.join(' | ') || 'no error'}` }
  }

  return { ok: caughtBy(failed, variant.fails, { name: variant.name }), detail: notCaught(found) }
}

// The module a variant changes, when a check loads it too: { name: patched text }.
const changedModules = (variant, text) => {
  const key = Object.keys(FILES).find((name) => FILES[name] === variant.file)

  return key ? { [key]: text } : {}
}

const checkBrowserVariant = async (variant, fault) => {
  const text = patched(variant.file, fs.readFileSync(variant.file, 'utf8'), variant.find, variant.to)
  const observation = await observeSource([[variant.file, text]], fault ? variant.until : null)
  const found = await browserResults(observation, fault ? variant.fails : null, await modulesOf(changedModules(variant, text)))
  const verdict = judgeVariant(variant, fault, found, observation)

  judged(found, variant.name)
  check(`${fault ? 'browser fault caught' : 'browser variant passes'}: ${variant.name}`, verdict.ok, verdict.detail)
}

const openBrowser = async () => {
  try {
    BROWSER.server = await startPageServer({ save: SKOORMIT.file })
    BROWSER.chrome = await require('playwright').chromium.launch()

    const warmed = await BROWSER.server.warm(BROWSER.chrome, { routes: ['/map'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s`)
  } catch (error) {
    BROWSER.failure = String(error.message).split('\n')[0]
  }
}

const closeBrowser = async () => {
  const { server, chrome, later } = BROWSER

  BROWSER.server = null
  BROWSER.chrome = null
  BROWSER.later = null

  if (chrome) {
    await chrome.close()
  }

  if (server) {
    await server.stop()
  }

  if (later) {
    fs.rmSync(later, { force: true })
  }

  saves.forEach((db) => db.close())
}

const DEADLINE = 240
const BROWSER_DEADLINE = 500

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the ledger over the saves and a constructed save', head: true, heading: 'The recovery ledger (utilities/recovery-ledger.js, observations.js, map-features.js)', deadline: DEADLINE, run: checkHead },
  { key: 'browser', name: 'the browser', head: true, heading: '\nThe browser (the app over a copy of the Skoormit save, in Chromium)', pool: 'browser', deadline: BROWSER_DEADLINE, run: checkBrowserHead },
  ...(mutating ? FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults', deadline: DEADLINE, run: () => checkFault(fault) })) : []),
  ...(mutating ? BROWSER_FAULTS.map((fault, index) => ({ key: `browser-fault:${index}`, name: `browser fault caught: ${fault.name}`, heading: '\nplanted faults of the page', pool: 'browser', deadline: BROWSER_DEADLINE, run: () => checkBrowserVariant(fault, true) })) : []),
  ...(mutating ? BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites that say the same thing', deadline: DEADLINE, run: () => checkRewrite(rewrite) })) : []),
  ...(mutating ? BROWSER_BENIGN.map((rewrite, index) => ({ key: `browser-benign:${index}`, name: `browser variant passes: ${rewrite.name}`, heading: '\nrewrites of the page that say the same thing', pool: 'browser', deadline: BROWSER_DEADLINE, run: () => checkBrowserVariant(rewrite, false) })) : []),
]

const main = async () => {
  const mutating = !runnerArgs().rest.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SKOORMIT.file, FALRYX_NOW.file, FALRYX_POD.file, MODDED.file],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.pool === 'browser')) {
        await openBrowser()
      }
    },
    afterEach: async () => {
      if (BROWSER.server) {
        await BROWSER.server.reset()
      }
    },
    close: closeBrowser,
    control: null,
    setup: 900,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
