/*
  Checks the formation observation record: the opt-in, player-race-only, per-branch ledger of when each ground formation was first and last seen as it is (src/renderer/utilities/observations.js, the signature reads of utilities/ground-formations.js, the recorder in utilities/history.js, the wording of utilities/observation-view.js and the Observed column of pages/survey-progress.vue).

  Run: bun scripts/check-formation-observations.js [--no-mutations] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The groups, each check a PASS or FAIL line named by its group:
  - units: the merge of a capture into a record (first import, an unchanged repeat, a changed or moved object, an object that came back, a failed read, an older save, the same time on another ledger, the cap), the cut a fork takes, the span an object reports, the file a version can read, the choice kept in the settings;
  - view: the words a row gets, which never claim an age before the first capture;
  - modded: the recorder over the modded save AuroraDB.db (game 140, race 784), read only: nothing read and written without a choice, nothing for a race that is not a player race, exactly two statements with one, the record against SQL written here, a later save changed in memory, an older save, a failed read, a clear, a pass superseded at each of its checks, the size against the figure kept;
  - falryx: the recorder over the eight saves of artifacts/falryx-sequential-and-rollback (game 141, race 791, a rollback and three forks): the spans against SQL, a skipped save, a rollback, the seed a fork takes and keeps, a campaign that never observed;
  - passive: the saves of artifacts/passive-campaign-20261013 (game 139): a player race with no formation and an NPR with 114, read only;
  - browser: the real app in Chromium over copies of the modded save: the switch, the Observed column and what it says after a first import and after a formation moved.
  Planted faults in copies of the utilities and of the page must each fail the checks they name by a value (scripts/lib/fault-credit.js `caughtBy`); one rewrite of each family must fail none. Everything the recorder reads comes through SELECTs of saves opened read only. Prints `N of N checks passed`; a failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { runSuite, runnerArgs } = require('./lib/suite-runner')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError, installScreen, readFigure, rounded, settled: pageSettled } = require('./lib/browser-observe')
const { failure, through, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pagesDirectory = path.join(root, 'src', 'renderer', 'pages')
const MODDED = { file: path.join(root, 'AuroraDB.db'), GameID: 140, RaceID: 784, NPR: null }
const FALRYX = path.join(root, 'artifacts', 'falryx-sequential-and-rollback')
const FALRYX_GAME = 141
const FALRYX_RACE = 791
const PASSIVE = path.join(root, 'artifacts', 'passive-campaign-20261013', 'snapshots')
const PASSIVE_GAME = 139
const NAMES = ['history', 'observations', 'observation-view', 'campaign', 'ground-formations', 'recording-owner', 'history-backup']
const CAPPED_CAPTURES = 500

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The stores of the history folder, kept in one map by folder and name: what `clearRaceHistory` and `observationStore` read and write.
const STORE_STUB = `const files = (globalThis.__formationObservationStores = globalThis.__formationObservationStores || new Map())
export default class Config {
  constructor ({ cwd = '', name = 'config' } = {}) { this.key = cwd + '/' + name }
  get store () { return JSON.parse(JSON.stringify(files.get(this.key) || {})) }
  set store (value) { files.set(this.key, JSON.parse(JSON.stringify(value))) }
  get path () { return this.key }
  get (key, fallback) { return key.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), this.store) ?? fallback }
}`

const STUBS = {
  'electron-store': STORE_STUB,
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
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

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 360 ? `${text.slice(0, 360)}…` : text
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value)

const equal = (actual, expected) => JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))

// A verdict: true when the value is what was expected, else what was seen against what was expected.
const same = (actual, expected, what = '') => (equal(actual, expected) ? true : `${what ? `${what}: ` : ''}saw ${short(actual)}, expected ${short(expected)}`)

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const verdictHeld = (verdict) => {
  if (verdict !== true) {
    throw failure(typeof verdict === 'string' ? verdict : short(verdict))
  }
}

// Checks `[name, test]` for `runChecks`: the test is the call of the code under test, so what it throws is a call that threw, which credits no fault, and a verdict other than true is a failure by value.
const asChecks = (list) => list.map(([name, test]) => ({ id: name, name, run: async () => verdictHeld(await through('the code under test', test, { read: false })) }))

const printResults = (results) => results.forEach((result) => check(result.name, result.ok || result.detail))

const creditOf = (failed) => failed.map((result) => `${result.name} (${result.threw ? 'a throw' : 'a value'}: ${result.detail.slice(0, 160)})`).join('; ') || 'nothing'

// The text of each file of the utilities, read once for all the loads of the process.
const texts = new Map()

const loadAll = async (sources = {}) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory: utilitiesDirectory, sources, texts })

  return { history: loaded.history, obs: loaded.observations, view: loaded['observation-view'], campaign: loaded.campaign, ground: loaded['ground-formations'], backup: loaded['history-backup'], reload: () => loadAll(sources), sources }
}

// ---------- the saves, read only ----------

const handles = new Map()

const handleOf = (file) => {
  if (!handles.has(file)) {
    handles.set(file, new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(handle)))
    }))
  }

  return handles.get(file)
}

const rowCache = new Map()

// A save is read only, so the rows a statement gives are the same each time it is run. Each caller gets rows of its own.
const rowsOf = async (file, sql) => {
  const key = `${file}\n${sql}`

  if (!rowCache.has(key)) {
    rowCache.set(key, handleOf(file).then((handle) => new Promise((resolve, reject) => handle.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))))
  }

  return (await rowCache.get(key)).map((row) => ({ ...row }))
}

const gameTimeOf = async (file, GameID) => (await rowsOf(file, `select GameTime from FCT_Game where GameID = ${GameID}`))[0].GameTime

const ledgerOf = async (file, GameID) => (await rowsOf(file, `select count(*) as n from FCT_Increments where GameID = ${GameID}`))[0].n

// The database the recorder reads: one transaction that is the connection, each statement logged. `failFormations` makes any statement that reads a formation fail; `recordedNpr` is the id of an NPR race that the save marks as one of Aurora's special factions, shown to the recorder as an ordinary NPR empire (the save has none, and only an NPR the recorder records can show whether it is read); `later` is a save changed in memory: { time, moved, changed, removed, added } with the ids of the formations moved to another colony (`moved`), given one more unit in an element row (`changed`), gone (`removed`) and one formation more (`added`), and a day of play more in the ledger and the game time.
const databaseOf = (file, { log = null, failFormations = false, recordedNpr = null, asNpr = null, special = false, later = null } = {}) => ({
  transaction: (work) => work({ id: 'transaction' }),
  query: async (sql) => {
    if (log) {
      log.push(sql)
    }

    if (failFormations && /FCT_GroundUnitFormation/.test(sql)) {
      throw new Error('the formation read failed')
    }

    const rows = (await rowsOf(file, sql)).map((row) => (recordedNpr !== null && /from FCT_Race$/.test(sql) && Number(row.RaceID) === Number(recordedNpr) ? { ...row, SpecialNPRID: 0 } : asNpr !== null && /from FCT_Race$/.test(sql) && Number(row.RaceID) === Number(asNpr) ? { ...row, NPR: 1, SpecialNPRID: special ? 1 : 0 } : row))

    if (!later) {
      return [rows]
    }

    if (/from FCT_Game$/.test(sql) || /^select FCT_Game\.GameTime, FCT_Game\.GameName/.test(sql)) {
      return [rows.map((row) => ({ ...row, GameTime: later.time }))]
    }

    if (/from FCT_Increments/.test(sql)) {
      const last = rows[rows.length - 1]

      return [[...rows, { IncrementID: Number(last.IncrementID) + 1, GameTime: last.GameTime + 432000, Length: 432000 }]]
    }

    if (/from FCT_GroundUnitFormation left join FCT_Population/.test(sql)) {
      return [[...rows.filter((row) => !later.removed.includes(row.FormationID)).map((row) => (later.moved.includes(row.FormationID) ? { ...row, PopulationID: 48999 } : row)), ...later.added.map((FormationID) => ({ FormationID, PopulationID: 48980, ShipID: 0, PopulationSystemID: 1, FleetSystemID: null }))]]
    }

    if (/group by FCT_GroundUnitFormationElement/.test(sql)) {
      let bumped = false

      return [rows.map((row) => {
        if (!bumped && later.changed.includes(row.FormationID)) {
          bumped = true

          return { ...row, Units: row.Units + 1 }
        }

        return row
      })]
    }

    return [rows]
  },
})

// The formations of a race as SQL written here reads them, apart from the module's: [{ id, key }], `key` being what the formation is compared by (colony, ship, the system of either, the elements by class).
const oracleOf = async (file, GameID, RaceID) => {
  const rows = await rowsOf(file, `select f.FormationID as id, f.PopulationID as pop, f.ShipID as ship, p.SystemID as psys, coalesce(fl.SystemID, cfl.SystemID) as fsys, (select group_concat(c || ':' || n || ':' || u, ';') from (select e.ClassID as c, count(*) as n, sum(e.Units) as u from FCT_GroundUnitFormationElement e where e.FormationID = f.FormationID group by e.ClassID order by e.ClassID)) as comp from FCT_GroundUnitFormation f left join FCT_Population p on p.PopulationID = f.PopulationID left join FCT_Ship s on s.ShipID = f.ShipID left join FCT_Fleet fl on fl.FleetID = s.FleetID left join FCT_Ship cs on cs.ShipID = s.MothershipID left join FCT_Fleet cfl on cfl.FleetID = cs.FleetID where f.GameID = ${GameID} and f.RaceID = ${RaceID}`)

  return new Map(rows.map((row) => [row.id, JSON.stringify([row.pop, row.ship, row.psys, row.fsys, row.comp])]))
}

// ---------- an installation: each store a JSON value read and written whole ----------

const installation = ({ seed = {}, counter = 1000, clock = 1000000 } = {}) => {
  const files = new Map(Object.entries(seed).map(([name, value]) => [name, clone(value)]))
  const writes = []
  const reads = []
  let cut = () => false
  let ids = counter
  let time = clock

  const store = (name) => ({
    get store () {
      reads.push(name)

      return clone(files.get(name)) || {}
    },
    set store (value) {
      writes.push({ name, cut: cut() })
      files.set(name, clone(value))
    },
    update (change) {
      this.store = change(this.store)

      return this.store
    },
  })

  return {
    files,
    writes,
    put: (name, value) => files.set(name, clone(value)),
    setCut: (test) => { cut = test },
    newId: () => `c${++ids}`,
    now: () => ++time,
    io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), backup: store('backup'), file: (name) => store(`file:${name}`) },
    registry: () => ({ campaigns: {}, pool: {}, ...(clone(files.get('registry')) || {}) }),
    campaignId: (GameID) => Object.entries((clone(files.get('registry')) || { campaigns: {} }).campaigns).filter(([, campaign]) => GameID === undefined || (campaign.gameIds || []).includes(GameID)).map(([id]) => id)[0],
    branch: (campaignId, branchId = 'b1') => clone(files.get(`file:campaign-${campaignId}-${branchId}`)) || {},
    observations: (campaignId, branchId = 'b1') => clone(files.get(`file:campaign-${campaignId}-${branchId}-observations`)),
    copy: () => installation({ seed: Object.fromEntries(files), counter: ids, clock: time }),
    observationWrites: () => writes.filter(({ name }) => name.endsWith('-observations')).length,
    observationReads: () => reads.filter((name) => name.endsWith('-observations')).length,
    observationNames: () => [...files.keys()].filter((name) => name.endsWith('-observations')),
  }
}

const record = (m, inst, file, { isCurrent, ...database } = {}) => m.history.recordHistory(databaseOf(file, database), { storage: inst.io, path: `C:/saves/${path.basename(file)}`, now: inst.now, newId: inst.newId, isCurrent })

const settled = async (m, inst, file) => {
  await record(m, inst, file)

  return inst.campaignId()
}

const observe_ = (m, inst, campaignId, RaceID, on = true) => m.obs.saveObservationChoice(inst.io.settings, campaignId, RaceID, 'formation', on)

const statementsOfFormations = (log) => log.filter((sql) => /FCT_GroundUnitFormation/.test(sql))

// The record of a race's kind in a file of the installation, or null.
const kindOf = (file, RaceID, kind = 'formation') => (file && file.races && file.races[RaceID] && file.races[RaceID].kinds[kind]) || null

const plain = (record) => (record ? { captures: record.captures, objects: record.objects } : null)

const CARRIER_SCRIPT = 'create table FCT_GroundUnitFormation (FormationID integer, GameID integer, RaceID integer, PopulationID integer, ShipID integer); create table FCT_GroundUnitFormationElement (FormationID integer, ClassID integer, Units integer); create table FCT_Population (PopulationID integer, SystemID integer); create table FCT_Ship (ShipID integer, FleetID integer, MothershipID integer); create table FCT_Fleet (FleetID integer, SystemID integer); insert into FCT_GroundUnitFormation values (1, 1, 1, 0, 10), (2, 1, 1, 0, 12), (3, 1, 1, 5, 0); insert into FCT_Population values (5, 9); insert into FCT_Ship values (10, 0, 11), (11, 100, 0), (12, 101, 11); insert into FCT_Fleet values (100, 5), (101, 7);'

// A database held in memory from a script, with `query` as the app's database gives rows: [rows].
const memory = async (script) => {
  const handle = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(opened)))
  })

  await new Promise((resolve, reject) => handle.exec(script, (error) => (error ? reject(error) : resolve())))

  return { handle, query: (sql) => new Promise((resolve, reject) => handle.all(sql, (error, rows) => (error ? reject(error) : resolve([rows])))) }
}

// ---------- the units ----------

const dg = (k) => k.toString(16).padStart(16, '0')

const cap = (t, n, pairs) => ({ t, n, objects: pairs.map(([id, k]) => [id, dg(k)]) })

const merged = (m, stored, capture) => m.obs.mergeCapture(stored, capture)

const unitChecks = (m) => {
  const { obs } = m
  const first = merged(m, null, cap(100, 1, [[1, 1], [2, 2]]))
  const second = merged(m, first.record, cap(200, 2, [[1, 1], [2, 2]]))
  const third = merged(m, second.record, cap(300, 3, [[1, 9], [2, 2], [3, 3]]))
  const fourth = merged(m, third.record, cap(400, 4, [[1, 9], [3, 3]]))
  const fifth = merged(m, fourth.record, cap(500, 5, [[1, 9], [2, 2], [3, 3]]))
  const behind = merged(m, fifth.record, cap(450, 4, [[1, 1], [2, 2], [3, 3]]))
  const ledger = merged(m, fifth.record, cap(500, 77, [[1, 5]]))
  const again = merged(m, fifth.record, cap(500, 5, [[1, 9], [2, 2], [3, 3]]))
  const revised = merged(m, fifth.record, cap(500, 5, [[1, 4], [2, 2], [3, 3]]))
  const settingsOf = () => ({ store: {}, update (change) { this.store = change(this.store) } })
  const failedOnce = obs.mergeObservations({ version: 1, races: { 7: { kinds: { formation: second.record } } } }, { failures: [{ RaceID: 7, kind: 'formation', failure: { at: 5, t: 300, reason: 'disk I/O error' } }] })
  const failedTwice = obs.mergeObservations(failedOnce.file, { failures: [{ RaceID: 7, kind: 'formation', failure: { at: 6, t: 300, reason: 'disk I/O error' } }] })
  const afterFailure = merged(m, failedOnce.file.races[7].kinds.formation, cap(400, 4, [[1, 1], [2, 2]]))

  const long = Array.from({ length: 501 }, (_, index) => index).reduce((state, index) => merged(m, state, cap(1000 + index, index + 1, [[1, 1]])).record, null)
  const file = { version: 1, races: { 7: { kinds: { formation: { captures: [[100, 1], [200, 2], [300, 3]], objects: { 1: [100, 300, dg(1)], 2: [200, 300, dg(2), 1], 3: [300, 300, dg(3)] }, failures: [{ at: 1, t: 150, reason: 'x' }, { at: 2, t: 250, reason: 'y' }] } } } } }
  const cutFile = obs.observationsUpTo(file, 200)
  const forkSeed = { captures: [[100, 1], [200, 2]], objects: { 1: [100, 200, dg(1)], 2: [100, 200, dg(2)], 3: [200, 200, dg(3), 1] }, seed: 200 }
  const forkFirst = merged(m, forkSeed, cap(300, 3, [[1, 1], [2, 9], [3, 3], [4, 4]]))
  const forkSecond = merged(m, forkFirst.record, cap(400, 4, [[1, 1], [2, 9], [3, 3], [4, 4]]))
  const cutLong = [1000, 1200].map((t) => obs.observationsUpTo({ version: 1, races: { 7: { kinds: { formation: { ...long, failures: [{ at: 1, t: 900, reason: 'x' }] } } } } }, t))
  const aheadRecord = merged(m, merged(m, merged(m, null, cap(100, 1, [[1, 1]])).record, cap(200, 2, [[1, 2]])).record, cap(400, 3, [[1, 1]])).record

  return [
    ['units: a first import holds each object seen at that capture, with no mark that it moved', () => same({ outcome: first.outcome, changed: first.changed, record: first.record }, { outcome: 'first', changed: true, record: { captures: [[100, 1]], objects: { 1: [100, 100, dg(1)], 2: [100, 100, dg(2)] } } })],
    ['units: the first import says it began at the import, with no age before it', () => same(['import', 1, null, false].join(), [obs.spanOf(first.record, 1).basis, obs.spanOf(first.record, 1).captures, obs.spanOf(first.record, 1).before, obs.spanOf(first.record, 1).inherited].join())],
    ['units: an object seen the same at a later capture keeps its first time and moves its last, and counts both captures', () => same({ entry: second.record.objects[1], span: (({ first: f, last, captures, longest, basis }) => ({ f, last, captures, longest, basis }))(obs.spanOf(second.record, 1)) }, { entry: [100, 200, dg(1)], span: { f: 100, last: 200, captures: 2, longest: { from: 100, to: 200 }, basis: 'import' } })],
    ['units: an object whose digest changed starts again at that capture and is marked as moved, while one that did not keeps its run', () => same({ moved: third.record.objects[1], kept: third.record.objects[2], basis: obs.spanOf(third.record, 1).basis, before: obs.spanOf(third.record, 1).before }, { moved: [300, 300, dg(9), 1], kept: [100, 300, dg(2)], basis: 'moved', before: 200 })],
    ['units: an object not seen before starts at that capture, unmarked, and says it was not there at the capture before', () => same({ entry: third.record.objects[3], basis: obs.spanOf(third.record, 3).basis, before: obs.spanOf(third.record, 3).before }, { entry: [300, 300, dg(3)], basis: 'appeared', before: 200 })],
    ['units: an object missing from one capture is dropped and starts again when it is back, so a gap is never a run', () => same({ gone: fourth.record.objects[2] || null, back: fifth.record.objects[2], captures: fifth.record.captures.map(([t]) => t), span: obs.spanOf(fifth.record, 2).captures }, { gone: null, back: [500, 500, dg(2)], captures: [100, 200, 300, 400, 500], span: 1 })],
    ['units: a save older than the newest capture changes nothing and extends no run', () => same({ outcome: behind.outcome, changed: behind.changed, record: behind.record, last: fifth.record.objects[1] }, { outcome: 'behind', changed: false, record: fifth.record, last: [300, 500, dg(9), 1] })],
    ['units: the same game time on another ledger is another timeline and changes nothing', () => same({ outcome: ledger.outcome, changed: ledger.changed, record: ledger.record }, { outcome: 'ledger', changed: false, record: fifth.record })],
    ['units: the same save read again, as it was, changes nothing; read again and different it restarts the runs that differ without a new capture', () => same({ again: [again.outcome, again.changed], revised: [revised.outcome, revised.changed, revised.record.captures.length, revised.record.objects[1]] }, { again: ['again', false], revised: ['again', true, 5, [500, 500, dg(4), 1]] })],
    ['units: a failed read is noted and changes no object and no capture, so the interval stays a gap', () => same({ changed: failedOnce.changed, captures: failedOnce.file.races[7].kinds.formation.captures, objects: failedOnce.file.races[7].kinds.formation.objects, failures: failedOnce.file.races[7].kinds.formation.failures }, { changed: true, captures: second.record.captures, objects: second.record.objects, failures: [{ at: 5, t: 300, reason: 'disk I/O error' }] })],
    ['units: the same failure of the same save noted again is not a new one', () => same({ changed: failedTwice.changed, failures: failedTwice.file.races[7].kinds.formation.failures.length }, { changed: false, failures: 1 })],
    ['units: a run across a failed capture counts it, and a later good capture does not hide it', () => same({ failed: obs.spanOf(afterFailure.record, 1).failed, longest: obs.spanOf(afterFailure.record, 1).longest }, { failed: 1, longest: { from: 200, to: 400 } })],
    ['units: 501 captures keep 500, say when the oldest was cut, and keep the run of an object whole', () => same({ captures: long.captures.length, cut: long.cut, first: long.objects[1][0], held: obs.spanOf(long, 1).captures, newest: long.captures[499][0] }, { captures: 500, cut: 1000, first: 1000, held: 500, newest: 1500 })],
    ['units: the cut a fork takes keeps the captures up to it and the objects first seen by then, with the newest sighting of each at or before it, and the time it was cut at', () => same(cutFile, { version: 1, races: { 7: { kinds: { formation: { captures: [[100, 1], [200, 2]], objects: { 1: [100, 200, dg(1)], 2: [200, 200, dg(2), 1] }, failures: [{ at: 1, t: 150, reason: 'x' }], seed: 200 } } } } })],
    ['units: a cut before the first capture holds nothing, and a file that has none gives nothing', () => same([obs.observationsUpTo(file, 50), obs.observationsUpTo({}, 200), obs.observationsUpTo(null, 200)], [{}, {}, {}])],
    ['units: a run is inherited when it began at or before the seed and is not when it began after', () => same([obs.spanOf({ captures: [[100, 1], [300, 2]], objects: { 1: [100, 300, dg(1)], 2: [300, 300, dg(2)] }, seed: 200 }, 1).inherited, obs.spanOf({ captures: [[100, 1], [300, 2]], objects: { 1: [100, 300, dg(1)], 2: [300, 300, dg(2)] }, seed: 200 }, 2).inherited], [true, false])],
    ['units: the first capture of a fork restarts an object the parent saw the same as of this branch, marks one that differs as moved and starts a new one, and the runs go on from there', () => same({ first: forkFirst.record.objects, second: forkSecond.record.objects, bases: [1, 2, 4].map((id) => obs.spanOf(forkFirst.record, id).basis), before: obs.spanOf(forkSeed, 1).inherited, after: obs.spanOf(forkFirst.record, 1).inherited, continued: obs.spanOf(forkSecond.record, 1).basis }, { first: { 1: [300, 300, dg(1), 2], 2: [300, 300, dg(9), 1], 3: [300, 300, dg(3), 2], 4: [300, 300, dg(4)] }, second: { 1: [300, 400, dg(1), 2], 2: [300, 400, dg(9), 1], 3: [300, 400, dg(3), 2], 4: [300, 400, dg(4)] }, bases: ['branch', 'moved', 'appeared'], before: true, after: false, continued: 'branch' })],
    ['units: the same save read again by a fork changes nothing and restarts nothing', () => same(merged(m, forkSeed, cap(200, 2, [[1, 1], [2, 2], [3, 3]])).outcome, 'again')],
    ['units: a cut inside the captures a cap dropped keeps no object nothing witnesses, so the seed is a file this version reads, and a cut after the dropped ones keeps each run to its newest sighting', () => same({ problems: cutLong.map(obs.observationFileProblem), early: cutLong[0], late: cutLong[1].races[7].kinds.formation.objects[1], captures: cutLong[1].races[7].kinds.formation.captures.length, seed: cutLong[1].races[7].kinds.formation.seed }, { problems: [null, null], early: { version: 1, races: { 7: { kinds: { formation: { captures: [], objects: {}, failures: [{ at: 1, t: 900, reason: 'x' }], cut: 1000, seed: 1000 } } } } }, late: [1000, 1200, dg(1)], captures: 200, seed: 1200 })],
    ['units: a record of a later save, or of the same game time on another ledger, is not compared with the open save, and one of an earlier or the same save is', () => same([[150, 1], [400, 3], [400, 9], [500, 4], [300, 1]].map(([t, n]) => obs.observationOf(aheadRecord, 1, dg(1), { t, n }).state).concat(obs.observationOf(aheadRecord, 1, dg(1)).state, obs.observationOf(aheadRecord, 1, dg(2), { t: 150, n: 1 }).state), ['ahead', 'observed', 'ahead', 'observed', 'ahead', 'observed', 'ahead'])],
    ['units: the open save says its game time and its increments, and nothing when it cannot', async () => {
      const database = await memory('create table FCT_Game (GameID integer, GameTime integer); create table FCT_Increments (GameID integer, IncrementID integer); insert into FCT_Game values (7, 5000), (8, 6000); insert into FCT_Increments values (7, 1), (7, 2), (7, 3), (8, 1);')
      const bare = await memory('create table FCT_Other (a integer);')

      try {
        return same(await Promise.all([obs.readOpenSave(database, { GameID: 7 }), obs.readOpenSave(database, { GameID: 9 }), obs.readOpenSave(database, { GameID: 'x' }), obs.readOpenSave(bare, { GameID: 7 })]), [{ t: 5000, n: 3 }, null, null, null])
      } finally {
        database.handle.close()
        bare.handle.close()
      }
    }],
    ['units: a formation on a ship with no fleet of its own is where the ship that carries it is, so moving the carrier moves it, while a ship with a fleet of its own is not moved by its carrier', async () => {
      const database = await memory(CARRIER_SCRIPT)
      const at = async () => Object.fromEntries(await m.ground.readFormationObservations(database, { GameID: 1, RaceID: 1 }))

      try {
        const before = await at()

        await new Promise((resolve, reject) => database.handle.exec('update FCT_Fleet set SystemID = 6 where FleetID = 100', (error) => (error ? reject(error) : resolve())))

        const carrierMoved = await at()

        await new Promise((resolve, reject) => database.handle.exec('update FCT_Fleet set SystemID = 8 where FleetID = 101', (error) => (error ? reject(error) : resolve())))

        const ownMoved = await at()

        return same({ carried: [before[1] !== carrierMoved[1], carrierMoved[1] === ownMoved[1]], own: [before[2] === carrierMoved[2], carrierMoved[2] !== ownMoved[2]], colony: [before[3] === carrierMoved[3], carrierMoved[3] === ownMoved[3]] }, { carried: [true, true], own: [true, true], colony: [true, true] })
      } finally {
        database.handle.close()
      }
    }],
    ['units: a record whose object digest differs from the open save is changed, an object it lacks is new, and no capture is unrecorded', () => same([obs.observationOf(second.record, 1, dg(1)).state, obs.observationOf(second.record, 1, dg(9)).state, obs.observationOf(second.record, 5, dg(5)).state, obs.observationOf({ captures: [], objects: {} }, 1, dg(1)).state, obs.observationOf(second.record, 1, null).state], ['observed', 'changed', 'new', 'unrecorded', 'unrecorded'])],
    ['units: the widest interval between captures anywhere in a record', () => same([obs.widestGap(fifth.record), obs.widestGap({ captures: [[1, 1]], objects: {} }), obs.widestGap({ captures: [[100, 1], [150, 2], [400, 3], [420, 4]], objects: {} })], [{ from: 100, to: 200 }, null, { from: 150, to: 400 }])],
    ['units: a file this version can read has no problem, and each way a file cannot be read is named', () => same([obs.observationFileProblem(null), obs.observationFileProblem({}), obs.observationFileProblem(file), typeof obs.observationFileProblem({ version: 2, races: {} }), typeof obs.observationFileProblem({ version: 1, races: { 7: { kinds: { formation: { captures: [[1, 1]], objects: { 1: [1, 1, 'nothex'] } } } } } }), typeof obs.observationFileProblem({ version: 1, races: { 7: { kinds: { formation: { captures: [[1, 1]], objects: { 1: [5, 1, dg(1)] } } } } } }), typeof obs.observationFileProblem({ version: 1, races: { 7: { kinds: { formation: { captures: [['x', 1]], objects: {} } } } } }), typeof obs.observationFileProblem({ version: 1, races: { 7: { kinds: { nothing: { captures: [], objects: {} } } } } })], [null, null, null, 'string', 'string', 'string', 'string', 'string'])],
    ['units: an object no capture of its record saw is refused, whether its last sighting or its first is no capture, and a first sighting that a cap dropped is read', () => {
      const stored = (objects, extra = {}) => ({ version: 1, races: { 7: { kinds: { formation: { captures: [[100, 1], [200, 2]], objects, ...extra } } } } })
      const verdict = (file) => (obs.observationFileProblem(file) === null ? 'read' : 'refused')

      return same([stored({ 1: [150, 150, dg(1)] }), stored({ 1: [100, 150, dg(1)] }), stored({ 1: [150, 200, dg(1)] }), stored({ 1: [100, 200, dg(1)] }), stored({ 1: [100, 100, dg(1)] }), stored({ 1: [90, 200, dg(1)] }, { cut: 90 }), stored({ 1: [90, 200, dg(1)] }, { cut: 80 }), stored({ 1: [90, 200, dg(1)] })].map(verdict), ['refused', 'refused', 'refused', 'read', 'read', 'read', 'refused', 'refused'])
    }],
    ['units: the size predicted is the objects and the captures at the bytes each costs', () => same(obs.observationEstimate({ objects: 10, captures: 2 }), 10 * obs.OBJECT_BYTES + 2 * obs.CAPTURE_BYTES)],
    ['units: a choice is kept per race and campaign, turning one off keeps the others and is still a choice made, a race never chosen is not, and an unknown kind is refused', () => {
      const settings = settingsOf()
      const ever = () => [obs.observationEverChosen(settings.store, 'c1', 7), obs.observationEverChosen(settings.store, 'c1', 8), obs.observationEverChosen(settings.store, 'c1', 9), obs.observationEverChosen(settings.store, 'c2', 7)]

      obs.saveObservationChoice(settings, 'c1', 7, 'formation', true)
      obs.saveObservationChoice(settings, 'c1', 8, 'formation', true)

      const on = [obs.observedKinds(settings.store, 'c1', 7), obs.observedKinds(settings.store, 'c1', 8), obs.observedKinds(settings.store, 'c2', 7), obs.observationChosen(settings.store), ever()]

      obs.saveObservationChoice(settings, 'c1', 7, 'formation', false)

      const off = [obs.observedKinds(settings.store, 'c1', 7), obs.observedKinds(settings.store, 'c1', 8), obs.observationChosen(settings.store), ever()]

      obs.saveObservationChoice(settings, 'c1', 9, 'formation', false)

      const never = ever()
      let refused = false

      try {
        obs.saveObservationChoice(settings, 'c1', 7, 'hangar', true)
      } catch (error) {
        refused = error instanceof RangeError
      }

      return same([on, off, never, refused], [[['formation'], ['formation'], [], true, [true, true, false, false]], [[], ['formation'], true, [true, true, false, false]], [true, true, false, false], true])
    }],
    ['units: what the recorder reads of the choice is each campaign with a kind observed, and a race is wanted only in the game of that campaign', () => {
      const settings = settingsOf()

      obs.saveObservationChoice(settings, 'c1', 7, 'formation', true)

      const campaigns = { c1: { id: 'c1', gameIds: [140] }, c2: { id: 'c2', gameIds: [141] }, c3: { id: 'c3', gameIds: [140], mergedInto: 'c1' } }
      const wish = obs.observationWish(settings.store, campaigns)

      return same({ wish, wanted: [obs.observationWanted(wish, 140, 7), obs.observationWanted(wish, 140, 8), obs.observationWanted(wish, 141, 7)], kept: [obs.observationKept(wish, 'c1', 7), obs.observationKept(wish, 'c2', 7)] }, { wish: { c1: { gameIds: [140], races: { 7: ['formation'] } } }, wanted: [['formation'], [], []], kept: [['formation'], []] })
    }],
    ['units: clearing a race\'s history removes its observation record from the branch, keeps the other races and the other branches, and says nothing was removed the second time', async () => {
      const { history } = m
      const race = (RaceID) => ({ kinds: { formation: { captures: [[100, 1]], objects: { 1: [100, 100, dg(RaceID)] } } } })

      history.observationStore('cz', 'b1').store = { version: 1, races: { 7: race(7), 8: race(8) } }
      history.observationStore('cz', 'b2').store = { version: 1, races: { 7: race(7) } }

      const first = await history.clearRaceHistory({ campaignId: 'cz', branchId: 'b1', RaceID: 7 })
      const kept = [Object.keys(history.observationStore('cz', 'b1').store.races), Object.keys(history.observationStore('cz', 'b2').store.races)]
      const second = await history.clearRaceHistory({ campaignId: 'cz', branchId: 'b1', RaceID: 7 })

      return same([first, kept, second], [true, [['8'], ['7']], false])
    }],
  ]
}

// ---------- the words ----------

const WORDS = { date: (seconds) => `D${seconds}`, duration: (seconds) => `${seconds} s` }

// The figures of a text read whole, each before the unit it stands by: one token (a sign, digits, any group or decimal marks) set off by white space or a bracket and followed by one space and the unit, so that a sign or a prefix, a comma included, is part of the figure and a wrong one is read as it is (the reader of `browser-observe` rejects it), never as the digits in it.
const figuresBefore = (text, unit) => [...String(text).matchAll(new RegExp(`(?:^|[\\s(])([-+\\u2212]?\\d[^\\s)]*)\\s+${unit}(?![\\w])`, 'g'))].map((found) => readFigure(found[1], 'Tick'))

// The figures before a unit in the clause (it ends at a semicolon or a full stop) that a role names: which figure is which follows from what the clause says, never from its place among the others.
const clauseFigures = (text, role, unit) => figuresBefore(String(text).split(/;|\.(?=\s|$)/).find((part) => role.test(part)) || '', unit)

// What a summary or an account says by role: the captures, the interval and the failed captures, each a list of the figures read before its unit (`interval` is the unit the caller's duration is written in).
const rolesOf = (text, interval) => ({ captures: figuresBefore(text, 'captures?(?!\\s+failed)'), interval: figuresBefore(text, interval), failed: figuresBefore(text, '(?:captures?\\s+)?failed') })

const viewChecks = (m) => {
  const { obs, view } = m
  const imported = obs.observationOf(merged(m, merged(m, null, cap(100, 1, [[1, 1]])).record, cap(200, 2, [[1, 1]])).record, 1, dg(1))
  const base = merged(m, merged(m, null, cap(100, 1, [[1, 1], [2, 2]])).record, cap(200, 2, [[1, 1], [2, 2]])).record
  const moving = merged(m, base, cap(300, 3, [[1, 7], [2, 2]])).record
  const moved = obs.observationOf(moving, 1, dg(7))
  const appeared = obs.observationOf(merged(m, base, cap(300, 3, [[1, 1], [2, 2], [3, 3]])).record, 3, dg(3))
  const changed = obs.observationOf(base, 1, dg(8))
  const failed = obs.observationOf(merged(m, obs.mergeObservations({ version: 1, races: { 7: { kinds: { formation: base } } } }, { failures: [{ RaceID: 7, kind: 'formation', failure: { at: 1, t: 150, reason: 'x' } }] }).file.races[7].kinds.formation, cap(300, 3, [[1, 1], [2, 2]])).record, 1, dg(1))
  const inherited = obs.observationOf({ ...base, seed: 100 }, 1, dg(1))
  const afterFork = merged(m, { captures: [[100, 1], [200, 2]], objects: { 1: [100, 200, dg(1)] }, seed: 200 }, cap(300, 3, [[1, 1]])).record
  const branched = obs.observationOf(afterFork, 1, dg(1))
  const importedOnce = obs.observationOf(merged(m, null, cap(100, 1, [[1, 1]])).record, 1, dg(1))
  const unfailed = obs.observationOf(merged(m, base, cap(300, 3, [[1, 1], [2, 2]])).record, 1, dg(1))
  const words = (state) => view.observationText(state, WORDS)
  const states = [imported, moved, appeared, changed, failed, inherited, branched, importedOnce, { state: 'unrecorded', span: null }, { state: 'unread', span: null }, { state: 'new', span: null }, { state: 'ahead', span: null }]
  const all = states.map(words)
  const text = all.flatMap((entry) => [entry.headline, entry.summary, ...entry.details]).join('\n')
  const dates = (value) => value.match(/D\d+/g) || []
  const roles = (text) => rolesOf(text, 's')
  const whole = (state) => [words(state).headline, words(state).summary, ...words(state).details].join('\n')

  return [
    ['view: a first import says it is the import and gives the date of the capture it began at, with no earlier date', () => same({ headline: dates(words(imported).headline), import: /import/i.test(words(imported).headline), all: [...new Set(dates(whole(imported)))] }, { headline: ['D100'], import: true, all: ['D100'] })],
    ['view: a formation that moved, changed or appeared says it was observed since the capture that saw it so, not since import, and names the capture before', () => same({ moved: [dates(words(moved).headline), /import/i.test(words(moved).headline), [...new Set(dates(whole(moved)))].sort()], appeared: [dates(words(appeared).headline), /import/i.test(words(appeared).headline), [...new Set(dates(whole(appeared)))].sort()] }, { moved: [['D300'], false, ['D200', 'D300']], appeared: [['D300'], false, ['D200', 'D300']] })],
    ['view: a formation the record holds as it was before a change gives no new span, and the date its record began', () => same({ headline: dates(words(changed).headline), import: /import/i.test(words(changed).headline), differs: words(changed).headline !== words(imported).headline, dates: [...new Set(dates(whole(changed)))] }, { headline: [], import: false, differs: true, dates: ['D100'] })],
    ['view: the captures of a span and its longest interval are told, from the captures of the record, each by its unit', () => same({ imported: roles(words(imported).summary), failed: roles(words(failed).summary), once: roles(words(importedOnce).summary) }, { imported: { captures: [2], interval: [100], failed: [] }, failed: { captures: [3], interval: [100], failed: [1] }, once: { captures: [1], interval: [], failed: [] } })],
    ['view: the account of a record counts its captures, its widest interval and its failed captures by unit, wherever the clause stands', () => same({ base: roles(view.recordNote(base, WORDS)), failed: roles(view.recordNote(obs.mergeObservations({ version: 1, races: { 7: { kinds: { formation: base } } } }, { failures: [{ RaceID: 7, kind: 'formation', failure: { at: 1, t: 150, reason: 'x' } }] }).file.races[7].kinds.formation, WORDS)), once: roles(view.recordNote({ captures: [[100, 1]], objects: {} }, WORDS)) }, { base: { captures: [2], interval: [100], failed: [] }, failed: { captures: [2], interval: [100], failed: [1] }, once: { captures: [1], interval: [], failed: [] } })],
    ['view: the account of a record cut by a clear, well below the cap, gives the date it was cut and does not say the cap did it', () => { const cleared = obs.observationsFrom({ kinds: { formation: base } }, 150).kinds.formation; const note = view.recordNote(cleared, WORDS); return same({ held: cleared.captures.length, cutDate: /D100(?!\d)/.test(note), cap: note.includes(String(obs.CAPTURES_KEPT)) || /\bcap\b/i.test(note) }, { held: 1, cutDate: true, cap: false }) }],
    ['view: a failed capture inside a span and a run that includes the parent branch each change what the span says', () => same({ failed: [words(failed).summary !== words(unfailed).summary, words(failed).details.length > words(unfailed).details.length], inherited: [words(inherited).summary !== words(imported).summary, words(inherited).details.length > words(imported).details.length] }, { failed: [true, true], inherited: [true, true] })],
    ['view: the reason a span began is told apart for an import, a move, an appearance and a fork, and a fork\'s span is dated at the first capture of its branch', () => same({ distinct: new Set([importedOnce, moved, appeared, branched].map((state) => JSON.stringify(words(state).details))).size, headline: dates(words(branched).headline), import: /import/i.test(words(branched).headline) }, { distinct: 4, headline: ['D300'], import: false })],
    ['view: a row with no record, no read, no capture of it or a record of a later save says so in its own words, with no span and no date', () => same({ distinct: new Set(all.slice(8).map((entry) => entry.headline)).size, dates: all.slice(8).flatMap((entry) => dates(`${entry.headline}\n${entry.summary}`)).length, apart: all.slice(8).every((entry) => !all.slice(0, 8).some((other) => other.headline === entry.headline)) }, { distinct: 4, dates: 0, apart: true })],
    ['view: nothing says how long a formation was unchanged, deployed or where it stood before the first capture', () => (/unchanged (for|since)|deployed|since the game|for \d+ (years?|days?)|since [A-Z][a-z]+ \d{4}/i.test(text) ? short(text.match(/unchanged (for|since)|deployed|since the game|for \d+ (years?|days?)/i)) : true)],
  ]
}

// ---------- the recorder ----------

const scenarios = new WeakMap()

// A scenario is run once for the modules of a check, whatever number of checks read it.
const once = (m, key, make) => {
  if (!scenarios.has(m)) {
    scenarios.set(m, new Map())
  }

  const known = scenarios.get(m)

  if (!known.has(key)) {
    known.set(key, make())
  }

  return known.get(key)
}

const nprOf = async () => (await rowsOf(MODDED.file, `select r.RaceID, count(f.FormationID) as n from FCT_Race r left join FCT_GroundUnitFormation f on f.RaceID = r.RaceID and f.GameID = r.GameID where r.GameID = ${MODDED.GameID} and r.NPR = 1 group by r.RaceID order by n desc, r.RaceID limit 1`))[0].RaceID

const modded = (m) => once(m, 'modded', async () => {
  const { file, GameID, RaceID } = MODDED
  const t = await gameTimeOf(file, GameID)
  const n = await ledgerOf(file, GameID)
  const result = { t, n, oracle: await oracleOf(file, GameID, RaceID), npr: await nprOf() }

  // Settled with nothing chosen.
  const plainRun = installation()
  const plainLog = []

  await record(m, plainRun, file, { log: plainLog })
  await record(m, plainRun, file)
  result.plain = { names: plainRun.observationNames(), statements: statementsOfFormations(plainLog).length, settings: plainRun.files.get('settings') || null, branch: plainRun.branch(plainRun.campaignId()) }

  // An NPR race chosen: nothing is read for it. The save's NPR races are all special factions, which the recorder never takes, so the one with the most formations is shown as an ordinary NPR empire.
  const nprRun = installation()
  const nprId = await settled(m, nprRun, file)
  const nprLog = []

  observe_(m, nprRun, nprId, result.npr)
  await record(m, nprRun, file, { log: nprLog, recordedNpr: result.npr })
  result.npr = { id: result.npr, recorded: Boolean(nprRun.branch(nprId).races[result.npr]), formations: (await rowsOf(file, `select count(*) as n from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${result.npr}`))[0].n, statements: statementsOfFormations(nprLog), names: nprRun.observationNames(), file: nprRun.observations(nprId) }

  // The player race chosen.
  const inst = installation()
  const campaignId = await settled(m, inst, file)

  observe_(m, inst, campaignId, RaceID)
  inst.start = inst.copy()

  const log = []
  const run = await record(m, inst, file, { log })

  result.campaignId = campaignId
  result.first = { run, statements: statementsOfFormations(log), file: inst.observations(campaignId), names: inst.observationNames(), branch: inst.branch(campaignId) }

  await record(m, inst, file)
  await record(m, inst, file)
  result.repeat = { writes: inst.observationWrites(), file: inst.observations(campaignId) }

  // A later save changed in memory: one formation moved, one changed, one gone, one more.
  const ids = [...result.oracle.keys()]
  const edit = { time: t + 432000, moved: [ids[3]], changed: [ids[0]], removed: [ids[4]], added: [9000001] }

  result.edit = { ...edit, ids }
  await record(m, inst, file, { later: edit })
  result.later = inst.observations(campaignId)
  result.laterBranch = inst.branch(campaignId)

  // The older save again, after the later one.
  await record(m, inst, file)
  result.older = { file: inst.observations(campaignId), writes: inst.observationWrites(), registry: inst.registry().campaigns[campaignId] }

  // A failed read, over an observation and before the first one.
  const failing = installation()
  const failingId = await settled(m, failing, file)

  observe_(m, failing, failingId, RaceID)

  const failedRun = await record(m, failing, file, { failFormations: true })

  result.failed = { run: failedRun, file: failing.observations(failingId), branch: failing.branch(failingId) }
  await record(m, failing, file)
  result.filled = failing.observations(failingId)

  const kept = installation()
  const keptId = await settled(m, kept, file)

  observe_(m, kept, keptId, RaceID)
  await record(m, kept, file)

  const before = kept.observations(keptId)

  await record(m, kept, file, { later: edit, failFormations: true })
  result.erased = { before, after: kept.observations(keptId) }

  // The choice withdrawn: nothing more is read or written, and what was recorded stays.
  const off = inst.copy()
  const offLog = []

  observe_(m, off, campaignId, RaceID, false)

  const offWrites = off.observationWrites()

  await record(m, off, file, { log: offLog, later: { ...edit, time: t + 864000 } })
  result.off = { statements: statementsOfFormations(offLog).length, writes: off.observationWrites() - offWrites, file: off.observations(campaignId), later: result.later }

  // A pass superseded at each of its checks.
  const base = inst.start.copy()
  const whole = base.copy()
  const marks = []
  let guards = 0

  await record(m, whole, file, { isCurrent: () => { guards++; marks.push(whole.writes.length); return true } })

  // A write of the observation file is guarded when a check of the pass came after the write before it and before itself, so that a pass replaced in between writes nothing.
  result.unguarded = whole.writes.map(({ name }, index) => ({ name, index })).filter(({ name, index }) => /-observations$/.test(name) && !marks.includes(index)).map(({ name }) => name)
  result.superseded = []

  for (let allowed = 0; allowed <= guards; allowed++) {
    const attempt = base.copy()
    let calls = 0

    attempt.setCut(() => calls > allowed)

    const outcome = await record(m, attempt, file, { isCurrent: () => ++calls <= allowed })

    result.superseded.push({ allowed, superseded: outcome.superseded, afterCut: attempt.writes.filter(({ cut }) => cut).length, file: attempt.observations(campaignId) })
  }

  result.guards = guards

  return result
})

// The digests the record holds against the keys SQL written here gives: formations with one key hold one digest and formations with another hold another.
const partitionProblems = (objects, oracle) => {
  const byDigest = new Map()
  const byKey = new Map()

  oracle.forEach((key, id) => {
    const digest = objects[id] ? objects[id][2] : null

    byDigest.set(digest, new Set([...(byDigest.get(digest) || []), key]))
    byKey.set(key, new Set([...(byKey.get(key) || []), digest]))
  })

  return [...[...byDigest].filter(([, keys]) => keys.size > 1).map(([digest]) => `digest ${digest} of two compositions`), ...[...byKey].filter(([, digests]) => digests.size > 1).map(([key]) => `one composition ${key} with two digests`)]
}

const moddedChecks = (m) => {
  const run = () => modded(m)
  const entry = (name, test) => [name, async () => test(await run())]
  const ids = (record) => Object.keys(record.objects).map(Number).sort((a, b) => a - b)

  return [
    entry('modded: nothing chosen reads no formation and writes no observation file, and the settings and the empire file are as without the feature', (s) => same({ names: s.plain.names, statements: s.plain.statements, settings: s.plain.settings }, { names: [], statements: 0, settings: null })),
    entry('modded: an NPR race chosen is not read, whatever formations it holds, and nothing is written for it', (s) => same({ recorded: s.npr.recorded, holds: s.npr.formations > 0, statements: s.npr.statements.length, names: s.npr.names }, { recorded: true, holds: true, statements: 0, names: [] })),
    entry('modded: the player race chosen reads exactly two statements for its formations', (s) => same(s.first.statements.length, 2)),
    entry('modded: the first capture holds the game time and the number of increments of the save, and one object for each formation SQL counts', (s) => {
      const kind = kindOf(s.first.file, MODDED.RaceID)

      return same({ captures: kind.captures, count: ids(kind).length, ids: ids(kind) }, { captures: [[s.t, s.n]], count: s.oracle.size, ids: [...s.oracle.keys()].sort((a, b) => a - b) })
    }),
    entry('modded: every object of the first capture began and was last seen at that capture, marked as neither moved nor changed', (s) => {
      const kind = kindOf(s.first.file, MODDED.RaceID)

      return same(Object.values(kind.objects).filter((object) => object.length !== 3 || object[0] !== s.t || object[1] !== s.t).length, 0)
    }),
    entry('modded: the digests tell the formations SQL tells apart by place and elements, and no others', (s) => same(partitionProblems(kindOf(s.first.file, MODDED.RaceID).objects, s.oracle), [])),
    entry('modded: the pass that records formations also writes the empire snapshot, and the file is written once however often the same save is read', (s) => same({ snapshots: s.first.branch.races[MODDED.RaceID].snapshots.length, writes: s.repeat.writes, same: equal(s.repeat.file, s.first.file) }, { snapshots: 1, writes: 1, same: true })),
    entry('modded: a later save holds the formation that moved, the one that changed and the new one as new runs, and drops the one that went', (s) => {
      const kind = kindOf(s.later, MODDED.RaceID)
      const t2 = s.edit.time

      return same({ moved: kind.objects[s.edit.moved[0]].slice(0, 2).concat(kind.objects[s.edit.moved[0]].length), changed: kind.objects[s.edit.changed[0]].slice(0, 2).concat(kind.objects[s.edit.changed[0]].length), added: kind.objects[s.edit.added[0]].slice(0, 2).concat(kind.objects[s.edit.added[0]].length), removed: kind.objects[s.edit.removed[0]] || null, captures: kind.captures.length }, { moved: [t2, t2, 4], changed: [t2, t2, 4], added: [t2, t2, 3], removed: null, captures: 2 })
    }),
    entry('modded: every other formation keeps its first time and moves its last to the later capture', (s) => {
      const kind = kindOf(s.later, MODDED.RaceID)
      const touched = new Set([...s.edit.moved, ...s.edit.changed, ...s.edit.removed, ...s.edit.added])
      const rest = Object.entries(kind.objects).filter(([id]) => !touched.has(Number(id)))

      return same({ count: rest.length, wrong: rest.filter(([, object]) => object[0] !== s.t || object[1] !== s.edit.time || object.length !== 3).length }, { count: s.oracle.size - 3, wrong: 0 })
    }),
    entry('modded: the empire file of the later pass holds both snapshots', (s) => same(s.laterBranch.races[MODDED.RaceID].snapshots.length, 2)),
    entry('modded: the save read again after a later one changes nothing in the record and adds no write', (s) => same({ same: equal(s.older.file, s.later), writes: s.older.writes, branches: Object.keys(s.older.registry.branches) }, { same: true, writes: 2, branches: ['b1'] })),
    entry('modded: a failed read is noted and the empire snapshot is still written, with no capture and no object', (s) => same({ run: [s.failed.run.recorded, s.failed.run.failed.length, s.failed.run.superseded], snapshots: s.failed.branch.races[MODDED.RaceID].snapshots.length, captures: kindOf(s.failed.file, MODDED.RaceID).captures, objects: kindOf(s.failed.file, MODDED.RaceID).objects, failures: (kindOf(s.failed.file, MODDED.RaceID).failures || []).map(({ t, reason }) => [t, reason]) }, { run: [1, 0, false], snapshots: 1, captures: [], objects: {}, failures: [[s.t, 'the formation read failed']] })),
    entry('modded: the capture after a failed one is recorded and the failure stays noted', (s) => same({ captures: kindOf(s.filled, MODDED.RaceID).captures.length, count: ids(kindOf(s.filled, MODDED.RaceID)).length, failures: kindOf(s.filled, MODDED.RaceID).failures.length }, { captures: 1, count: s.oracle.size, failures: 1 })),
    entry('modded: a failed read over a recorded capture changes no object and no capture', (s) => same(plain(kindOf(s.erased.after, MODDED.RaceID)), plain(kindOf(s.erased.before, MODDED.RaceID)))),
    entry('modded: the choice withdrawn reads no more and writes no more, and keeps what was recorded', (s) => same({ statements: s.off.statements, writes: s.off.writes, kept: equal(s.off.file, s.later) }, { statements: 0, writes: 0, kept: true })),
    entry('modded: a pass superseded at each of its checks writes nothing after it was replaced, and a file it wrote is whole', (s) => {
      const problems = s.superseded.filter((attempt) => attempt.afterCut !== 0 || !(attempt.file === undefined || attempt.file === null || equal(attempt.file, s.first.file)))

      return problems.length === 0 && s.unguarded.length === 0 && s.superseded.length === s.guards + 1 && s.superseded[0].superseded === true && s.superseded[s.guards].superseded === false ? true : short({ unguarded: s.unguarded, attempts: s.superseded.map(({ allowed, superseded, afterCut }) => [allowed, superseded, afterCut]) })
    }),
    entry('modded: the size predicted for the record is at least what it takes as compact JSON and at most twice it', (s) => {
      const kind = kindOf(s.first.file, MODDED.RaceID)
      const bytes = JSON.stringify(kind).length
      const predicted = m.obs.observationEstimate({ objects: ids(kind).length, captures: kind.captures.length })

      return predicted >= bytes && predicted <= 2 * bytes ? true : short({ bytes, predicted })
    }),
  ]
}

// ---------- the falryx saves ----------

const falryxFiles = () => {
  if (!fs.existsSync(FALRYX)) {
    return null
  }

  const files = fs.readdirSync(FALRYX).filter((name) => /^AuroraDB-\d+\.db$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((name) => path.join(FALRYX, name))

  return files.length === 8 ? files : null
}

// The falryx scenarios are each worked out when a check needs it, once for the modules of a check, so that a fault that a check of one scenario catches does not pay for the others. The first campaign goes through the stages of `FALRYX_CHAIN` on one installation, each stage building on the one before; the other scenarios each have an installation of their own.
const falryxInputs = (m) => once(m, 'falryx-inputs', async () => {
  const files = falryxFiles()

  if (!files) {
    return null
  }

  const times = []
  const counts = []
  const keys = []

  for (const file of files) {
    times.push(await gameTimeOf(file, FALRYX_GAME))
    counts.push(await ledgerOf(file, FALRYX_GAME))
    keys.push(await oracleOf(file, FALRYX_GAME, FALRYX_RACE))
  }

  return { files, times, counts, keys }
})

const falryxRestarted = (m) => once(m, 'falryx-restarted', () => m.reload())
const FALRYX_CHAIN = ['first', 'second', 'fourth', 'rollback', 'fork', 'chain']

const falryxChain = async (m, inputs, upTo) => {
  const { files, times, counts, keys } = inputs
  const state = await once(m, 'falryx-chain', async () => ({ inst: installation(), result: { times, counts, keys }, reached: 0 }))
  const { inst, result } = state
  const rec = (modules, index, options) => record(modules, inst, files[index], options)
  const stages = {
    first: async () => {
      await rec(m, 0)

      result.campaignId = inst.campaignId(FALRYX_GAME)
      observe_(m, inst, result.campaignId, FALRYX_RACE)
      await rec(m, 0)
      result.optIn = inst.observations(result.campaignId)
      result.writesAfterOptIn = inst.observationWrites()

      await rec(m, 0)
      await rec(m, 0)
      result.writesAfterRepeat = inst.observationWrites()
    },
    second: async () => {
      await rec(await falryxRestarted(m), 1)
      result.second = inst.observations(result.campaignId)
    },
    // The third save is never read: its interval is unobserved.
    fourth: async () => {
      await rec(await falryxRestarted(m), 3)
      result.fourth = inst.observations(result.campaignId)
    },
    // A rollback: an older save is read after a newer one.
    rollback: async () => {
      await rec(await falryxRestarted(m), 2)
      result.rollback = inst.observations(result.campaignId)
    },
    fork: async () => {
      const restarted = await falryxRestarted(m)
      const { campaignId } = result

      // A fork whose parent record this version cannot read is left alone and reported.
      const damaged = inst.copy()

      damaged.put(`file:campaign-${campaignId}-b1-observations`, { version: 99, races: {} })

      const damagedRun = await record(restarted, damaged, files[4])

      result.damaged = { failed: damagedRun.failed.map(({ stage }) => stage), names: damaged.observationNames(), registry: damaged.registry().campaigns[campaignId], latest: ((damaged.branch(campaignId, 'b2').races[FALRYX_RACE] || { snapshots: [{ t: null }] }).snapshots.slice(-1)[0] || { t: null }).t }

      await rec(restarted, 4)
      result.afterFork = { registry: inst.registry().campaigns[campaignId], b1: inst.observations(campaignId, 'b1'), b2: inst.observations(campaignId, 'b2') }

      // The parent's record cleared after the fork: the fork keeps what it was given.
      const cleared = inst.copy()

      cleared.put(`file:campaign-${campaignId}-b1-observations`, { version: 1, races: {} })
      await record(restarted, cleared, files[5])
      result.parentCleared = { b1: cleared.observations(campaignId, 'b1'), b2: cleared.observations(campaignId, 'b2') }
    },
    chain: async () => {
      const restarted = await falryxRestarted(m)
      const { campaignId } = result

      await rec(restarted, 5)
      await rec(restarted, 6)
      await rec(restarted, 7)
      result.chain = { registry: inst.registry().campaigns[campaignId], b1: inst.observations(campaignId, 'b1'), b2: inst.observations(campaignId, 'b2'), b3: inst.observations(campaignId, 'b3'), b4: inst.observations(campaignId, 'b4') }
    },
  }

  while (state.reached <= FALRYX_CHAIN.indexOf(upTo)) {
    await stages[FALRYX_CHAIN[state.reached]]()
    state.reached++
  }

  return result
}

const FALRYX_SCENARIOS = {
  // The campaign never observed, forked at the fifth save.
  never: async (m, { files }) => {
    const never = installation()

    for (const index of [0, 1, 3, 4, 5]) {
      await record(m, never, files[index])
    }

    return { names: never.observationNames(), reads: never.observationReads(), registry: never.registry().campaigns[never.campaignId(FALRYX_GAME)], settings: never.files.get('settings') || null }
  },
  // A fork made while nothing is observed, and the race then chosen on the fork.
  late: async (m, { files, times, counts, keys }) => {
    const restarted = await falryxRestarted(m)
    const late = installation()

    for (const index of [0, 1, 3, 4]) {
      await record(restarted, late, files[index])
    }

    const lateId = late.campaignId(FALRYX_GAME)

    observe_(restarted, late, lateId, FALRYX_RACE)
    late.put(`file:campaign-${lateId}-b1-observations`, { version: 1, races: { [FALRYX_RACE]: { kinds: { formation: m.obs.mergeCapture(null, { t: times[1], n: counts[1], objects: [...keys[1].keys()].slice(0, 20).map((id) => [id, dg(id)]) }).record } } } })
    await record(restarted, late, files[5])

    return { b1: late.observations(lateId, 'b1'), b2: late.observations(lateId, 'b2') }
  },
  // The race chosen, then turned off again: a fork made afterwards is still given the parent's record up to the fork, as the choice is on record.
  off: async (m, { files }) => {
    const restarted = await falryxRestarted(m)
    const off = installation()

    await record(restarted, off, files[0])

    const offId = off.campaignId(FALRYX_GAME)

    observe_(restarted, off, offId, FALRYX_RACE)
    await record(restarted, off, files[1])
    observe_(restarted, off, offId, FALRYX_RACE, false)
    await record(restarted, off, files[3])
    await record(restarted, off, files[4])

    return { b1: off.observations(offId, 'b1'), b2: off.observations(offId, 'b2'), registry: off.registry().campaigns[offId] }
  },
  // A fork made while nothing was observed, the race chosen, then a save from before the fork read (the resolver gives it to the fork) and a save after it: the fork's first record has no parent to seed it, and still no run of it may begin before the fork.
  rewound: async (m, { files }) => {
    const restarted = await falryxRestarted(m)
    const rewound = installation()

    for (const index of [0, 1, 3, 4]) {
      await record(restarted, rewound, files[index])
    }

    const rewoundId = rewound.campaignId(FALRYX_GAME)

    observe_(restarted, rewound, rewoundId, FALRYX_RACE)
    await record(restarted, rewound, files[0])
    await record(restarted, rewound, files[5])

    return { b1: rewound.observations(rewoundId, 'b1'), b2: rewound.observations(rewoundId, 'b2'), registry: rewound.registry().campaigns[rewoundId] }
  },
  // A choice held only for a race the save marks as an NPR, an ordinary NPR empire or a special faction the recorder leaves out: that race is never read, so a fork of the campaign opens no observation file.
  nprOnly: async (m, { files }) => {
    const restarted = await falryxRestarted(m)
    const seen = {}

    for (const special of [false, true]) {
      const nprOnly = installation()

      await record(restarted, nprOnly, files[0], { asNpr: FALRYX_RACE, special })

      const nprOnlyId = nprOnly.campaignId(FALRYX_GAME)

      observe_(restarted, nprOnly, nprOnlyId, FALRYX_RACE)

      for (const index of [1, 3, 4, 5]) {
        await record(restarted, nprOnly, files[index], { asNpr: FALRYX_RACE, special })
      }

      seen[special ? 'special' : 'ordinary'] = { names: nprOnly.observationNames(), reads: nprOnly.observationReads(), marks: Object.values(nprOnly.registry().campaigns[nprOnlyId].branches).map((branch) => branch.observationsSeeded || null), forked: Object.keys(nprOnly.registry().campaigns[nprOnlyId].branches) }
    }

    return seen
  },
  // A fork taken before the captures a cap left in the parent: its seed has to stay a file this version reads, the capture after it has to go in, and a backup has to be made.
  capped: async (m, { files, times }) => {
    const restarted = await falryxRestarted(m)
    const capped = installation()

    for (const index of [0, 1, 3]) {
      await record(restarted, capped, files[index])
    }

    const cappedId = capped.campaignId(FALRYX_GAME)
    const newest = times[5] + 1000 + CAPPED_CAPTURES

    observe_(restarted, capped, cappedId, FALRYX_RACE)
    await record(restarted, capped, files[3])
    capped.put(`file:campaign-${cappedId}-b1-observations`, { version: 1, races: { [FALRYX_RACE]: { kinds: { formation: { captures: Array.from({ length: CAPPED_CAPTURES }, (_, index) => [newest - CAPPED_CAPTURES + 1 + index, index + 1]), objects: { 1: [0, newest, dg(1)], 2: [0, newest, dg(2)] }, cut: times[5] + 999 } } } } })
    await record(restarted, capped, files[4])
    await record(restarted, capped, files[5])

    const cappedProblems = [...capped.files].filter(([name]) => name.endsWith('-observations')).map(([name, file]) => [name, m.obs.observationFileProblem(file)])
    let backupError = null

    try {
      m.backup.buildBackup(capped.io, { at: 1 })
    } catch (error) {
      backupError = error.message
    }

    return { problems: cappedProblems, b2: capped.observations(cappedId, 'b2'), marked: capped.registry().campaigns[cappedId].branches.b2.observationsSeeded, backupError }
  },
}

// What a check of the falryx saves reads: the saves' own times, ledgers and keys, and the scenario `need` (a stage of the first campaign, or a scenario of its own, under the name of the field the check reads); null when the saves are not here.
const falryx = async (m, need) => {
  const inputs = await falryxInputs(m)

  if (!inputs) {
    return null
  }

  if (FALRYX_CHAIN.includes(need)) {
    return falryxChain(m, inputs, need)
  }

  const { times, counts, keys } = inputs

  return { times, counts, keys, [need]: await once(m, `falryx-${need}`, () => FALRYX_SCENARIOS[need](m, inputs)) }
}

const runOf = (record) => Object.fromEntries(Object.entries(record.objects).map(([id, object]) => [id, object.slice(0, 2).concat(object.length === 4 ? object[3] : 0)]))

// What a capture at `t` of the saves with keys `now` holds, from the keys of the capture before (`before`, a Map id -> key) and its entries (`entries`, { id: [first, last, moved] }), by the rule written here: an object whose key is the same goes on, one whose key differs or that is new starts at `t`, one that is gone is dropped.
const expectedAfter = (entries, before, now, t) => Object.fromEntries([...now].map(([id, key]) => [id, before.has(id) && before.get(id) === key && entries[id] ? [entries[id][0], t, entries[id][2]] : [t, t, before.has(id) && entries[id] ? 1 : 0]]))

// The scenario each check of the falryx saves reads (`falryx`), by the start of its name.
const FALRYX_NEEDS = [
  ['falryx: the first capture', 'first'],
  ['falryx: a second save', 'second'],
  ['falryx: a skipped save', 'fourth'],
  ['falryx: the third capture', 'fourth'],
  ['falryx: a rollback', 'rollback'],
  ['falryx: a fork takes', 'fork'],
  ['falryx: a span never crosses', 'fork'],
  ['falryx: the fork\'s own first capture', 'fork'],
  ['falryx: the branch is marked', 'fork'],
  ['falryx: the fork keeps its seed', 'fork'],
  ['falryx: a fork whose parent record', 'fork'],
  ['falryx: every later fork', 'chain'],
  ['falryx: a campaign that never', 'never'],
  ['falryx: a fork made while nothing', 'late'],
  ['falryx: a race turned off', 'off'],
  ['falryx: a fork with no parent record', 'rewound'],
  ['falryx: a choice held only', 'nprOnly'],
  ['falryx: a fork taken before', 'capped'],
]

const falryxChecks = (m) => {
  const entry = (name, test) => [name, async () => {
    const need = FALRYX_NEEDS.find(([start]) => name.startsWith(start))

    if (!need) {
      throw new Error(`no scenario is named for the check ${name}`)
    }

    const s = await falryx(m, need[1])

    return s ? test(s, kindOf) : 'the saves of artifacts/falryx-sequential-and-rollback are not here'
  }]
  const kind = (file) => kindOf(file, FALRYX_RACE)

  return [
    entry('falryx: the first capture holds the formations SQL counts, with the digests SQL tells apart, and a repeat writes nothing', (s) => same({ ids: Object.keys(kind(s.optIn).objects).map(Number).sort((a, b) => a - b), captures: kind(s.optIn).captures, partition: partitionProblems(kind(s.optIn).objects, s.keys[0]), writes: [s.writesAfterOptIn, s.writesAfterRepeat] }, { ids: [...s.keys[0].keys()].sort((a, b) => a - b), captures: [[s.times[0], s.counts[0]]], partition: [], writes: [1, 1] })),
    entry('falryx: a second save extends the formations SQL finds the same, restarts those that differ and starts those that are new, with no one dropped that is still there', (s) => same(runOf(kind(s.second)), expectedAfter(runOf(kind(s.optIn)), s.keys[0], s.keys[1], s.times[1]), 'runs after the second save')),
    entry('falryx: a skipped save leaves a gap: the third save of the record follows the second, and a formation that stood unchanged across all three counts three captures, not the increments between', (s) => {
      const unchanged = [...s.keys[3]].filter(([id, key]) => s.keys[1].get(id) === key && s.keys[0].get(id) === key).map(([id]) => id)
      const spans = unchanged.slice(0, 50).map((id) => m.obs.spanOf(kind(s.fourth), id))
      const widest = Math.max(s.times[1] - s.times[0], s.times[3] - s.times[1])

      return same({ captures: kind(s.fourth).captures.map(([t]) => t), unchanged: unchanged.length > 0, counted: [...new Set(spans.map((span) => span.captures))], longest: [...new Set(spans.map((span) => span.longest.to - span.longest.from))] }, { captures: [s.times[0], s.times[1], s.times[3]], unchanged: true, counted: [3], longest: [widest] })
    }),
    entry('falryx: the third capture follows the rule against SQL as well', (s) => same(runOf(kind(s.fourth)), expectedAfter(runOf(kind(s.second)), s.keys[1], s.keys[3], s.times[3]), 'runs after the fourth save')),
    entry('falryx: a rollback, an older save read after a newer one, leaves the record as it was', (s) => same(s.rollback, s.fourth)),
    entry('falryx: a fork takes the parent record up to the fork, not the captures after it, and says where it was cut', (s) => {
      const fork = s.afterFork.registry.branches.b2.fork.t
      const parent = kind(s.afterFork.b1)
      const seeded = kind(s.afterFork.b2)
      const wanted = parent.captures.filter(([t]) => t <= fork)

      return same({ seed: seeded.seed, captures: seeded.captures.slice(0, wanted.length), own: seeded.captures.slice(wanted.length).map(([t]) => t), later: wanted.length < parent.captures.length }, { seed: fork, captures: wanted, own: [s.times[4]], later: true })
    }),
    entry('falryx: a span never crosses the fork: no run of the fork begins before its own first capture and none is flagged as inherited, though the fork holds the parent\'s captures', (s) => {
      const seeded = kind(s.afterFork.b2)
      const early = Object.values(seeded.objects).filter((object) => object[0] < s.times[4])
      const flagged = Object.keys(seeded.objects).filter((id) => m.obs.spanOf(seeded, id).inherited)

      return same({ early: early.length, flagged: flagged.length, seeded: seeded.captures.length > 1 }, { early: 0, flagged: 0, seeded: true })
    }),
    entry('falryx: the fork\'s own first capture restarts each formation the parent saw the same, marks one that differs as moved, starts the new ones, and drops what the save no longer holds', (s) => {
      const seeded = kind(s.afterFork.b2)
      const parent = kind(s.afterFork.b1)
      const fork = s.afterFork.registry.branches.b2.fork.t
      const before = new Map(Object.entries(parent.objects).filter(([, object]) => object[0] <= fork).map(([id, object]) => [Number(id), object]))
      const wrong = [...s.keys[4]].filter(([id, key]) => {
        const held = seeded.objects[id]
        const mark = !before.has(id) ? 0 : s.keys[3].get(id) === key ? 2 : 1

        return !(held && held[0] === s.times[4] && held[1] === s.times[4] && (held[3] || 0) === mark)
      })
      const gone = Object.keys(seeded.objects).filter((id) => !s.keys[4].has(Number(id)))

      return same({ wrong: wrong.length, gone: gone.length }, { wrong: 0, gone: 0 })
    }),
    entry('falryx: the branch is marked as given its seed, and the parent record is the one the fork was taken from', (s) => same({ marked: s.afterFork.registry.branches.b2.observationsSeeded, parentMarked: s.afterFork.registry.branches.b1.observationsSeeded || null, parentKept: equal(s.afterFork.b1, s.rollback) }, { marked: true, parentMarked: null, parentKept: true })),
    entry('falryx: the fork keeps its seed when the parent record is cleared, and the capture after it goes on from the seed', (s) => {
      const before = kind(s.afterFork.b2)
      const after = kind(s.parentCleared.b2)
      const fork = s.afterFork.registry.branches.b2.fork.t

      return same({ parent: s.parentCleared.b1, seed: after.seed, kept: after.captures.slice(0, before.captures.length), held: before.captures.length > 1, first: Object.keys(before.objects).filter((id) => s.keys[5].get(Number(id)) === s.keys[4].get(Number(id)) && after.objects[id] && after.objects[id][0] !== before.objects[id][0]).length }, { parent: { version: 1, races: {} }, seed: fork, kept: before.captures, held: true, first: 0 })
    }),
    entry('falryx: a fork whose parent record this version cannot read is left unseeded and reported, and the empire snapshot is still written', (s) => same({ failed: [...new Set(s.damaged.failed)], names: s.damaged.names, marked: s.damaged.registry.branches.b2 ? s.damaged.registry.branches.b2.observationsSeeded || null : 'no branch', latest: s.damaged.latest }, { failed: ['observations'], names: [`file:campaign-${s.campaignId}-b1-observations`], marked: null, latest: s.times[4] }, 'damaged parent')),
    entry('falryx: every later fork is cut at its own fork time and begins from its parent\'s record up to it', (s) => {
      const problems = []

      Object.entries(s.chain.registry.branches).filter(([, branch]) => branch.parent).forEach(([id, branch]) => {
        const own = kind(s.chain[id])

        if (!own || own.seed !== branch.fork.t || branch.observationsSeeded !== true) {
          problems.push([id, own ? own.seed : null, branch.fork.t, branch.observationsSeeded])
        }
      })

      return problems.length === 0 && Object.keys(s.chain.registry.branches).length === 4 ? true : short(problems)
    }),
    entry('falryx: a campaign that never observed writes no observation file, opens none, and marks each branch it forks as seeded, with the settings as they were', (s) => same({ names: s.never.names, reads: s.never.reads, marks: Object.values(s.never.registry.branches).map((branch) => branch.observationsSeeded || null), forked: Object.keys(s.never.registry.branches), settings: s.never.settings }, { names: [], reads: 0, marks: [null, true], forked: ['b1', 'b2'], settings: null })),
    entry('falryx: a fork made while nothing was observed starts its record at its first capture: a record the parent gets after the fork, once the race is chosen, is not given to the fork', (s) => same({ b1: kind(s.late.b1).captures.map(([t]) => t), b2: kind(s.late.b2).captures.map(([t]) => t), marks: Object.values(kind(s.late.b2).objects).filter((object) => object.length > 3).length, inherited: Object.keys(kind(s.late.b2).objects).filter((id) => m.obs.spanOf(kind(s.late.b2), id).inherited).length }, { b1: [s.times[1]], b2: [s.times[5]], marks: 0, inherited: 0 })),
    entry('falryx: a race turned off after it was observed still has its record given to a fork made afterwards, cut at the fork', (s) => same({ b1: kind(s.off.b1) ? kind(s.off.b1).captures.map(([t]) => t) : null, b2: kind(s.off.b2) ? { captures: kind(s.off.b2).captures.map(([t]) => t), seed: kind(s.off.b2).seed } : null, forkAt: s.off.registry.branches.b2 ? s.off.registry.branches.b2.fork.t : null }, { b1: [s.times[1]], b2: { captures: [s.times[1]], seed: s.off.registry.branches.b2 ? s.off.registry.branches.b2.fork.t : null }, forkAt: s.off.registry.branches.b2 ? s.off.registry.branches.b2.fork.t : null })),
    entry('falryx: a fork with no parent record to seed it still starts every run at its own first capture after the fork, though a save from before the fork was read into it first', (s) => {
      const own = kind(s.rewound.b2)
      const fork = s.rewound.registry.branches.b2.fork.t
      const wrong = [...s.keys[5]].filter(([id, key]) => {
        const held = own && own.objects[id]
        const mark = !s.keys[0].has(id) ? 0 : s.keys[0].get(id) === key ? 2 : 1

        return !(held && held[0] === s.times[5] && held[1] === s.times[5] && (held[3] || 0) === mark)
      })

      return same({ captures: own ? own.captures.map(([t]) => t) : null, seed: own ? own.seed : null, wrong: wrong.length, extra: own ? Object.keys(own.objects).filter((id) => !s.keys[5].has(Number(id))).length : null, parent: s.rewound.b1 ? 'held' : null }, { captures: [s.times[0], s.times[5]], seed: fork, wrong: 0, extra: 0, parent: null })
    }),
    entry('falryx: a choice held only for a race the save marks as an NPR, an ordinary empire or a special faction, reads no observation file at a fork, writes none, and still marks the fork as seeded', (s) => same(Object.fromEntries(Object.entries(s.nprOnly).map(([class_, seen]) => [class_, { names: seen.names, reads: seen.reads, marks: seen.marks, forked: seen.forked }])), { ordinary: { names: [], reads: 0, marks: [null, true], forked: ['b1', 'b2'] }, special: { names: [], reads: 0, marks: [null, true], forked: ['b1', 'b2'] } })),
    entry('falryx: a fork taken before the captures a cap left in the parent is seeded with a file this version reads, goes on to capture, and the history backs up', (s) => same({ problems: s.capped.problems.filter(([, problem]) => problem !== null), captures: kind(s.capped.b2).captures.map(([t]) => t), marked: s.capped.marked, backupError: s.capped.backupError }, { problems: [], captures: [s.times[4], s.times[5]], marked: true, backupError: null })),
  ]
}

// ---------- the passive campaign ----------

const passiveFiles = () => (fs.existsSync(PASSIVE) ? fs.readdirSync(PASSIVE).filter((name) => /\.db$/.test(name)).sort().slice(0, 4).map((name) => path.join(PASSIVE, name)) : null)

const passive = (m) => once(m, 'passive', async () => {
  const files = passiveFiles()

  if (!files || files.length < 4) {
    return null
  }

  const inst = installation()
  const log = []
  const campaignId = await settled(m, inst, files[0])

  observe_(m, inst, campaignId, 1)
  observe_(m, inst, campaignId, 2)

  for (const file of files) {
    await record(m, inst, file, { log })
  }

  const times = []

  for (const file of files) {
    times.push(await gameTimeOf(file, PASSIVE_GAME))
  }

  return { campaignId, times, statements: statementsOfFormations(log), file: inst.observations(campaignId), npr: (await rowsOf(files[0], 'select count(*) as n from FCT_GroundUnitFormation where RaceID = 2'))[0].n, own: (await rowsOf(files[0], 'select count(*) as n from FCT_GroundUnitFormation where RaceID = 1'))[0].n }
})

const passiveChecks = (m) => {
  const entry = (name, test) => [name, async () => {
    const s = await passive(m)

    return s ? test(s) : 'the saves of artifacts/passive-campaign-20261013 are not here'
  }]

  return [
    entry('passive: a player race with no formation records its captures and no object, and the NPR race that holds formations is not read', (s) => same({ own: s.own, npr: s.npr > 0, captures: kindOf(s.file, 1).captures.map(([t]) => t), objects: kindOf(s.file, 1).objects, races: Object.keys(s.file.races), nprStatements: s.statements.filter((sql) => /RaceID = 2\b/.test(sql)).length }, { own: 0, npr: true, captures: s.times, objects: {}, races: ['1'], nprStatements: 0 })),
  ]
}

// ---------- the browser ----------

// The real app in Chromium (scripts/lib/page-server.js over a copy of the modded save, scripts/lib/browser-observe.js): the switch of the Survey Progress page, the Observed column after the first capture, a later save (the save served is changed and the app opened again) in which one formation moved and one changed its elements, and the Retention panel of the History page. What the page draws is read through the hooks the templates carry; what is judged is the text on screen.
const BROWSER_SAVE = { file: 'AuroraDB.db', game: 'Aurelian Empire', race: 'Aurelian Empire' }
const TIMEOUT = 120000
const SURVEY_FILE = path.join(pagesDirectory, 'survey-progress.vue')
const DAY = 432000

// What the page draws of the observation, read in the page: the switch and the block around it, the header cells, each row's cell and each open row's detail, the note at the foot and the choice kept in the settings.
const readObserved = () => {
  const { visible, visibleText } = window.__screen
  const matched = window.$app.$route.matched
  const page = matched.length ? matched[matched.length - 1].instances.default : null
  const input = document.querySelector('input[data-observe="switch"]')
  const control = document.querySelector('[data-observe="control"]')
  const note = document.querySelector('[data-observe="note"]')
  const own = (element, selector) => {
    const found = element.querySelector(selector)

    return found ? visibleText(found).trim() : null
  }

  return {
    route: window.$app.$route.path,
    control: control ? { on: visible(control), text: visibleText(control).trim() } : null,
    checked: input ? input.checked : null,
    remote: document.querySelector('input[data-formations="remote"]') ? document.querySelector('input[data-formations="remote"]').checked : null,
    headers: [...document.querySelectorAll('.v-data-table thead th')].map((cell) => visibleText(cell).trim()),
    rows: [...document.querySelectorAll('[data-observed]')].map((element) => ({ id: Number(element.getAttribute('data-observed')), state: element.getAttribute('data-observed-state'), headline: own(element, '[data-observed-headline]'), summary: own(element, '[data-observed-summary]'), on: visible(element) })),
    details: [...document.querySelectorAll('[data-observed-detail]')].map((element) => ({ id: Number(element.getAttribute('data-observed-formation')), state: element.getAttribute('data-observed-state'), headline: own(element, '[data-observed-headline]'), lines: [...element.querySelectorAll('[data-observed-line]')].map((line) => visibleText(line).trim()), on: visible(element) })),
    note: note ? visibleText(note).trim() : null,
    record: document.querySelector('[data-observe="record"]') ? visibleText(document.querySelector('[data-observe="record"]')).trim() : null,
    choice: JSON.stringify(window.$app.$store.getters.config.store.campaign || {}),
    captures: page && page.observationFile && page.observationFile.status === 'ok' && page.observationFile.record ? page.observationFile.record.captures.length : null,
    retention: document.querySelector('[data-retention-observations]') ? visibleText(document.querySelector('[data-retention-observations]')).trim() : null,
  }
}

const BROWSER = { server: null, chrome: null, failure: null, copy: null, base: null, facts: null }

// The formations of the race the browser save keeps: remote ones (on a ship) and ones at a colony, each with elements. The page lists every formation again at each step, so the 3,288 formations of the modded save are cut to as many as the checks need: some on screen with the scope on, some only with it off (the size predicted is for every formation, not for those in view), and the three the later save moves and changes.
const KEPT_REMOTE = 40
const KEPT_AT_COLONIES = 20

const openWritable = (file) => new Promise((resolve, reject) => {
  const handle = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => (error ? reject(error) : resolve(handle)))
})

const sqlOn = (database) => ({
  run: (sql) => new Promise((resolve, reject) => database.run(sql, (error) => (error ? reject(error) : resolve()))),
  all: (sql) => new Promise((resolve, reject) => database.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))),
})

// A copy of the modded save with the race's formations cut to the ones the browser case needs, and what the case is told of it (`facts`): the game time, the StartYear, a ship that carries no formation, the formations on a ship that hold elements, and the formations the race has. The facts are read from the copy itself by SQL, not by the app. Resolves to the file.
const trimmedSave = async () => {
  const file = path.join(os.tmpdir(), `ae-observations-base-${process.pid}.db`)
  const own = `GameID = ${MODDED.GameID} and RaceID = ${MODDED.RaceID}`
  const held = 'FormationID in (select FormationID from FCT_GroundUnitFormationElement)'

  fs.copyFileSync(path.resolve(root, BROWSER_SAVE.file), file)
  BROWSER.base = file

  const database = await openWritable(file)
  const { run, all } = sqlOn(database)

  try {
    await run(`create temp table kept as select FormationID from (select FormationID from FCT_GroundUnitFormation where ${own} and ShipID > 0 and coalesce(PopulationID, 0) = 0 and ${held} order by FormationID limit ${KEPT_REMOTE}) union select FormationID from (select FormationID from FCT_GroundUnitFormation where ${own} and PopulationID > 0 and PopulationID in (select PopulationID from FCT_Population where RaceID = ${MODDED.RaceID}) and ${held} order by FormationID limit ${KEPT_AT_COLONIES})`)
    await run(`delete from FCT_GroundUnitFormationElement where FormationID in (select FormationID from FCT_GroundUnitFormation where ${own}) and FormationID not in (select FormationID from kept)`)
    await run(`delete from FCT_GroundUnitFormation where ${own} and FormationID not in (select FormationID from kept)`)

    const [{ GameTime, StartYear }] = await all(`select GameTime, StartYear from FCT_Game where GameID = ${MODDED.GameID}`)
    const [ship] = await all(`select s.ShipID from FCT_Ship s where s.GameID = ${MODDED.GameID} and s.RaceID = ${MODDED.RaceID} and s.ShipID not in (select ShipID from FCT_GroundUnitFormation where ${own} and ShipID > 0) order by s.ShipID limit 1`)
    const onShips = await all(`select distinct FormationID from FCT_GroundUnitFormationElement where FormationID in (select FormationID from FCT_GroundUnitFormation where ${own} and ShipID > 0)`)
    const [{ n }] = await all(`select count(*) as n from FCT_GroundUnitFormation where ${own}`)

    BROWSER.facts = { t: GameTime, startYear: StartYear, ship: ship.ShipID, withElements: new Set(onShips.map((row) => row.FormationID)), count: n }
    await run('drop table kept')
    await run('vacuum')
  } finally {
    await new Promise((resolve) => database.close(resolve))
  }

  return file
}

// A copy of the trimmed save as it is a day later: the ledger and the game time one increment on, the formation `moved` on another ship, the formation `changed` with one more unit in its first element row. Resolves to the file.
const laterCopy = async ({ moved, changed, ship }) => {
  const file = path.join(os.tmpdir(), `ae-observations-${process.pid}.db`)

  fs.copyFileSync(BROWSER.base, file)

  const database = await openWritable(file)
  const { run } = sqlOn(database)

  try {
    await run(`update FCT_GroundUnitFormation set ShipID = ${ship} where FormationID = ${moved} and GameID = ${MODDED.GameID}`)
    await run(`update FCT_GroundUnitFormationElement set Units = Units + 1 where rowid = (select min(rowid) from FCT_GroundUnitFormationElement where FormationID = ${changed})`)
    await run(`insert into FCT_Increments (IncrementID, GameID, GameTime, Length) select max(IncrementID) + 1, ${MODDED.GameID}, max(GameTime) + ${DAY}, ${DAY} from FCT_Increments where GameID = ${MODDED.GameID}`)
    await run(`update FCT_Game set GameTime = GameTime + ${DAY} where GameID = ${MODDED.GameID}`)
  } finally {
    await new Promise((resolve) => database.close(resolve))
  }

  BROWSER.copy = file

  return file
}

// The pass of the recorder that has ended on the copy of the save that is open, once the store has counted `asked` requests for one (the switch asks for one; the pass the app starts for an opened save counts none): an expression for the page, to be joined to the other conditions of a wait. The store says so in `history/ended`, which carries the copy's generation and the requests the pass took.
const PASS_ENDED = (asked) => `((asked) => { const { history, freshness } = window.$app.$store.state; return Boolean(history.ended) && history.ended.generation === freshness.generation && history.ended.to >= asked && history.captures >= asked })(${asked})`

// The state of a row's expander as the table keeps it, whatever the slot of the row draws.
const EXPANDED = (id, shown) => `Boolean(document.querySelector('tr:has([data-observed="${id}"]) .v-data-table__expand-icon--active')) === ${shown}`

const SECOND_IN_RECORD = "(() => { const matched = window.$app.$route.matched; const page = matched.length ? matched[matched.length - 1].instances.default : null; return Boolean(page && page.observationFile && page.observationFile.status === 'ok' && page.observationFile.record && page.observationFile.record.captures.length >= 2) })()"

const STEP_BOUND = 15000

// The longest a pass of the recorder over the 3,288 formations of the modded save is waited for.
const PASS_BOUND = 30000

// The case as a player meets it, each step read where it ends; resolves to the record of `observe`. A wait that does not end is a step that did not reach its change (kept in `steps`), never a throw, so that the checks name what is missing; the picking of the game and the arrival of the route are bounded and fail the observation. Each wait is for the thing it follows: the pass of the recorder the switch asked for (its request counted by the store and ended on this copy of the save), the pass the app started for the opened save, the rows or the record the page then draws, and the page's own reads (`settled` of scripts/lib/browser-observe.js: the page's count of the database calls it has out and none of its asynchronous reads updating); nothing is waited for by time. `plan.until` is the last stage a variant needs ('off', 'first', 'history' or 'detail'; none for the whole case): a fault whose named checks all read an earlier stage stops there, and a stage reads only what the checks it serves read.
const observeCase = (browser, server, plan) => observe(browser, async ({ page, step }) => {
  const pageLoading = require('./page-loading')
  const seen = { steps: [] }
  const settle = () => {
    step('waiting for the page to settle')

    return pageSettled(page, { limit: TIMEOUT, loading: pageLoading })
  }
  const go = async (target, ready) => {
    step(`opening ${target}`)
    await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), target)
    await page.waitForFunction(pageLoading.arrived, target, { timeout: TIMEOUT })
    await page.waitForSelector(ready, { state: 'attached', timeout: TIMEOUT })
    // Every row of the formations table on one page, so that no formation sits where the screen does not read it.
    await page.evaluate(() => {
      const matched = window.$app.$route.matched
      const view = matched.length ? matched[matched.length - 1].instances.default : null

      if (view && view.formationsTable) {
        view.formationsTable = { ...view.formationsTable, itemsPerPage: -1 }
      }
    })
    await settle()
  }
  const read = () => {
    step('reading the screen')

    return page.evaluate(readObserved)
  }
  const openApp = async () => {
    step('opening the app')
    await installScreen(page)
    await page.goto(server.url, { timeout: TIMEOUT })

    const picker = page.locator('.empire-list').first()

    step('picking the game')
    await picker.locator('.empire-list__game').filter({ hasText: `${BROWSER_SAVE.game} ·` }).first().click({ timeout: TIMEOUT })

    if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
      step('picking the race')
      await picker.getByText(BROWSER_SAVE.race, { exact: true }).last().click({ timeout: TIMEOUT })
    }

    step('waiting for the race')
    await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
    await page.waitForFunction(() => Boolean(window.$app.$store.getters['history/campaign']), null, { timeout: TIMEOUT })
    step('waiting for the pass of the opened save')
    await page.waitForFunction(PASS_ENDED(0), null, { timeout: TIMEOUT })
    await settle()
  }
  const expander = (id) => `tr:has([data-observed="${id}"]) .v-data-table__expand-icon`
  const toggle = async (id, shown) => {
    step(`pressing the expander of ${id}`)
    await page.locator(expander(id)).first().click({ timeout: TIMEOUT })
    await page.waitForFunction(EXPANDED(id, shown), null, { timeout: STEP_BOUND }).then(() => true, () => false)
    await settle()
  }
  const remoteSwitch = () => page.locator('.v-input--selection-controls__input:has(input[data-formations="remote"])').first().click({ timeout: TIMEOUT })
  const stopAt = (stage) => plan.until === stage

  await openApp()
  await go('/survey-progress', '[data-observe="control"]')

  // Only the switch's own checks (the case as a whole and a fault stopped at 'off') read the screen before the switch is turned on and with the table's scope turned off and on again: what the switch says it would store does not follow the scope.
  if (plan.until === null || stopAt('off')) {
    seen.off = await read()
    step('turning the scope of the table off')
    await remoteSwitch()
    await settle()
    seen.scope = await read()
    step('turning the scope of the table on again')
    await remoteSwitch()
    await settle()
  }

  if (stopAt('off')) {
    return seen
  }

  step('turning the switch on')
  await page.locator('.v-input--selection-controls__input:has(input[data-observe="switch"])').first().click({ timeout: TIMEOUT })

  // The click has run the switch's handler, so the request for a pass is counted by now: a switch that asks for none has no pass to wait for.
  const asked = await page.evaluate(() => window.$app.$store.state.history.captures)

  seen.steps.push({ what: 'the switch asking the recorder for a pass', reached: asked >= 1 })

  if (asked >= 1) {
    step('waiting for the pass the switch asked for')
    seen.steps.push({ what: 'the pass the switch asked for', reached: await page.waitForFunction(PASS_ENDED(asked), null, { timeout: PASS_BOUND }).then(() => true, () => false) })
  }

  await settle()
  seen.first = await read()

  const ids = seen.first.rows.map((row) => row.id)
  const picked = plan.pick(ids)

  seen.plan = picked
  seen.times = plan.times
  seen.dates = plan.dates

  if (picked && !stopAt('first')) {
    // The History page after the first capture: the captures it holds are the one the driver has made.
    if (stopAt('history')) {
      await go('/history', '[data-retention-observations]')
      seen.history = await read()
      seen.historyCaptures = 1

      return seen
    }

    await toggle(picked.unchanged, true)
    seen.firstDetail = await read()
    await toggle(picked.unchanged, false)

    if (stopAt('detail')) {
      return seen
    }

    const later = await plan.later(picked)

    await server.useSave(later)
    await openApp()
    await go('/survey-progress', '[data-observe="control"]')
    seen.steps.push({ what: 'the second capture in the record', reached: await page.evaluate(SECOND_IN_RECORD) })
    seen.second = await read()
    await toggle(picked.unchanged, true)
    seen.secondStayed = await read()
    await toggle(picked.moved, true)
    seen.secondDetail = await read()
    await go('/history', '[data-retention-observations]')
    seen.history = await read()
    seen.historyCaptures = 2
  }

  return seen
})

const openBrowser = async () => {
  try {
    BROWSER.server = await startPageServer({ save: await trimmedSave() })
    BROWSER.chrome = await require('playwright').chromium.launch()

    const warmed = await BROWSER.server.warm(BROWSER.chrome, { routes: ['/survey-progress'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  } catch (error) {
    BROWSER.failure = String(error.message).split('\n')[0]
  }
}

const closeBrowser = async () => {
  const { server, chrome, copy, base } = BROWSER

  BROWSER.server = null
  BROWSER.chrome = null
  BROWSER.copy = null
  BROWSER.base = null
  BROWSER.facts = null

  if (chrome) {
    await chrome.close()
  }

  if (server) {
    await server.stop()
  }

  for (const file of [copy, base]) {
    if (file) {
      fs.rmSync(file, { force: true })
    }
  }
}

// The date the calendar of a game that starts on the 1st of January of `startYear` gives to a game time in seconds (YYYY-MM-DD), worked out here from the save's StartYear and the game time, not by the page.
const dateOfGameTime = (startYear, seconds) => {
  const start = new Date(Date.UTC(2000, 0, 1))

  start.setUTCFullYear(Number(startYear))

  return new Date(start.getTime() + seconds * 1000).toISOString().slice(0, 10)
}

// What the browser case is told: the two game times of the saves and the dates the save's StartYear gives them, the choice of the formations to change (the first formation on screen with a ship and a first one with an element row, then one that stays) and the second save, and the last stage a variant needs (`until`). All of it comes from the trimmed copy of the save (`trimmedSave`), by SQL.
const planOf = (until = null) => {
  const { t, startYear, ship, withElements } = BROWSER.facts

  return {
    until,
    times: [t, t + DAY],
    dates: [dateOfGameTime(startYear, t), dateOfGameTime(startYear, t + DAY)],
    pick: (ids) => {
      const usable = ids.filter((id) => withElements.has(id))

      return usable.length >= 3 ? { moved: usable[0], changed: usable[1], unchanged: usable[2] } : null
    },
    later: (picked) => laterCopy({ moved: picked.moved, changed: picked.changed, ship }),
  }
}

const observeSource = async (replacements = [], until = null) => {
  if (BROWSER.failure || !BROWSER.chrome) {
    return failedObservation(BROWSER.failure || 'the page server was not started for this worker')
  }

  const plan = planOf(until)

  replacements.forEach(([file, text]) => BROWSER.server.replace(file, text))

  try {
    const seen = await observeCase(BROWSER.chrome, BROWSER.server, plan)

    report(replacements.length ? 'a variant of the app' : 'the survey progress page', seen)

    return seen
  } catch (error) {
    return failedObservation(String(error.message).split('\n')[0])
  } finally {
    replacements.forEach(([file]) => BROWSER.server.replace(file, null))
  }
}

// The checks of the browser case: `[name, test]`, each given the screens the case read (`value` of the observation, with `oracle`, the formations SQL counts) and returning true or what was seen. The hooks find the elements; what is judged is the text they draw on screen.
const browserStatements = (m) => {
  const { view } = m
  const at = (list, id) => list.find((row) => row.id === id) || null
  const datesIn = (text) => String(text || '').match(/\d{4}-\d{2}-\d{2}/g) || []
  const POLICY = /unchanged (for|since)|deployed|since the game|for \d+ (years?|days?)/i
  const missing = 'the page listed fewer than three formations with elements'
  const ONE = { captures: [1], interval: [], failed: [] }

  return [
    ['browser: before the switch is turned on the page offers it, off, with its purpose and the size it would take for every formation of the race whatever the table shows, and shows no Observed column and no observed cell, and the settings hold no choice', (screens) => {
      const kib = rounded((screens.oracle * m.obs.OBJECT_BYTES + m.obs.CAPTURES_KEPT * m.obs.CAPTURE_BYTES) / 1024, 1)
      const sized = (shot) => (shot.control === null ? null : figuresBefore(shot.control.text, 'KiB'))

      return same({ offered: screens.off.control !== null && screens.off.control.on, purpose: screens.off.control !== null && screens.off.control.text.includes(view.OBSERVATION_PURPOSE), checked: screens.off.checked, column: screens.off.headers.includes('Observed'), cells: screens.off.rows.length, choice: screens.off.choice, estimate: [sized(screens.off), sized(screens.scope)], scope: [screens.off.remote, screens.scope.remote] }, { offered: true, purpose: true, checked: false, column: false, cells: 0, choice: '{}', estimate: [[kib], [kib]], scope: [true, false] })
    }],
    ['browser: turning the switch on records the first capture: the Observed column appears, every row on screen is observed since the import, dated at the save, at one capture, and the choice is kept for the race', (screens) => {
      const first = screens.first
      const wrong = first.rows.filter((row) => row.state !== 'observed' || !/import/i.test(row.headline) || datesIn(row.headline).join() !== String(screens.dates[0]) || JSON.stringify(rolesOf(row.summary, 'd')) !== JSON.stringify(ONE) || !row.on)
      const kept = Object.values(JSON.parse(first.choice)).map((own) => own.race && own.race[MODDED.RaceID] && own.race[MODDED.RaceID].observe)

      return same({ reached: screens.steps.filter((step) => !step.reached).map((step) => step.what).slice(0, 1), checked: first.checked, column: first.headers.includes('Observed'), rows: first.rows.length > 0, wrong: wrong.slice(0, 2), kept, captures: first.captures }, { reached: [], checked: true, column: true, rows: true, wrong: [], kept: [['formation']], captures: 1 })
    }],
    ['browser: the foot of the table gives the rule that nothing before the first capture is claimed and the account of the record', (screens) => same({ rule: screens.first.note !== null && screens.first.note.includes(view.OBSERVATION_RULE), record: screens.first.record === null ? null : rolesOf(screens.first.record, 'd') }, { rule: true, record: ONE })],
    ['browser: the opened row of a first capture is dated at the import, claims nothing before it and says it was seen at one capture only', (screens) => {
      if (!screens.plan) {
        return missing
      }

      const detail = at(screens.firstDetail.details, screens.plan.unchanged)
      const lines = detail ? detail.lines.join('\n') : ''

      return same({ headline: detail && [datesIn(detail.headline), /import/i.test(detail.headline)], lineDates: datesIn(lines), lines: detail && detail.lines.length >= 2, forbidden: POLICY.test(`${detail && detail.headline}\n${lines}`), on: detail && detail.on }, { headline: [[screens.dates[0]], true], lineDates: [], lines: true, forbidden: false, on: true })
    }],
    ['browser: a later save: a formation that moved or changed its elements is observed since the later date and not since import, and names only the capture before; one that stayed is observed since the import date, at two captures with the interval between them', (screens) => {
      if (!screens.plan) {
        return missing
      }

      const { second, plan, dates } = screens
      const days = (screens.times[1] - screens.times[0]) / 86400
      const shown = (id) => at(second.rows, id) || { headline: '', summary: '' }
      const moved = at(screens.secondDetail.details, plan.moved)
      const stayed = at(screens.secondStayed.details, plan.unchanged)

      return same({ moved: [datesIn(shown(plan.moved).headline), /import/i.test(shown(plan.moved).headline), rolesOf(shown(plan.moved).summary, 'd'), moved ? [...new Set(datesIn(moved.lines.join('\n')))] : null], changed: [datesIn(shown(plan.changed).headline), /import/i.test(shown(plan.changed).headline), rolesOf(shown(plan.changed).summary, 'd')], stayed: [datesIn(shown(plan.unchanged).headline), /import/i.test(shown(plan.unchanged).headline), rolesOf(shown(plan.unchanged).summary, 'd'), stayed ? datesIn(stayed.headline) : null], captures: second.captures, reached: screens.steps.filter((step) => !step.reached).map((step) => step.what).slice(0, 1) }, { moved: [[dates[1]], false, ONE, [dates[0]]], changed: [[dates[1]], false, ONE], stayed: [[dates[0]], true, { captures: [2], interval: [days], failed: [] }, [dates[0]]], captures: 2, reached: [] })
    }],
    ['browser: the History page states the observation record: on for the race, as many objects as the formations SQL counts, the captures held and the captures a full list holds each in its own clause, and a size measured', (screens) => {
      if (!screens.plan) {
        return missing
      }

      const text = screens.history.retention || ''
      const objects = figuresBefore(text, 'objects?')
      const captures = { held: clauseFigures(text, /\d\s+objects?\b/, 'captures?'), cap: clauseFigures(text, /\bpredicted\b/, 'captures?') }

      return same({ state: (/\b(On|Off)\b/.exec(text) || [])[1] || null, kind: text.includes(m.obs.OBSERVED_KINDS.formation.label.toLowerCase()), objects, captures, measured: /\bmeasured\b/.test(text) }, { state: 'On', kind: true, objects: [screens.oracle], captures: { held: [screens.historyCaptures], cap: [m.obs.CAPTURES_KEPT] }, measured: true })
    }],
    ['browser: no page error was raised', (_screens, observation) => (observation.unexpected.length === 0 ? true : short(observation.unexpected))],
  ]
}

// The browser checks for `runChecks` over { observation }: a page that did not get through fails each of them by naming why.
const browserChecks = (m, oracle) => browserStatements(m).map(([name, test]) => ({ id: name, name, run: ({ observation }) => verdictHeld(unobserved(observation) ? `the page did not get through: ${observation.error}` : test({ ...observation.value, oracle }, observation)) }))

// ---------- the faults ----------

const utilityFile = (name) => path.join(utilitiesDirectory, name)

/* eslint-disable no-template-curly-in-string */
// Faults planted in the utilities, each with the checks it must break by a value (`fails`, the starts of check names).
const MUTATIONS = [
  { name: 'a save older than the newest capture extends a run', file: 'observations.js', find: 'if (tip && capture.t < tip[0]) {', replace: 'if (false) {', fails: ['units: a save older than the newest', 'falryx: a rollback', 'modded: the save read again'] },
  { name: 'the same game time on another ledger taken as the same timeline', file: 'observations.js', find: 'if (tip && capture.t === tip[0] && capture.n !== tip[1]) {', replace: 'if (false) {', fails: ['units: the same game time on another ledger'] },
  { name: 'a changed composition does not restart the span', file: 'observations.js', find: 'if (before && before[2] === digest) {', replace: 'if (before) {', fails: ['units: an object whose digest changed', 'units: the same save read again', 'falryx: a second save'] },
  { name: 'a later capture drops the capture before it', file: 'observations.js', find: 'record.captures.push([capture.t, capture.n])', replace: 'record.captures = [[capture.t, capture.n]]', fails: ['units: an object seen the same', 'units: the same save read again', 'units: a run across a failed capture'] },
  { name: 'an unchanged object restarts at every capture', file: 'observations.js', find: 'objects[id] = [before[0], capture.t, digest, ...(before[3] ? [before[3]] : [])]', replace: 'objects[id] = [capture.t, capture.t, digest]', fails: ['units: an object seen the same', 'modded: every other formation'] },
  { name: 'an object not seen at a capture is kept', file: 'observations.js', find: 'record.objects = objects\n', replace: 'record.objects = { ...record.objects, ...objects }\n', fails: ['units: an object missing from one capture'] },
  { name: 'the account of a cut record saying the cap dropped its captures', file: 'observation-view.js', find: 'are no longer kept`)', replace: 'were dropped past 500`)', fails: ['view: the account of a record cut by a clear'] },
  { name: 'a moved object not marked as moved', file: 'observations.js', find: 'objects[id] = before ? [capture.t, capture.t, digest, MOVED] : [capture.t, capture.t, digest]', replace: 'objects[id] = [capture.t, capture.t, digest]', fails: ['units: an object whose digest changed', 'view: the reason a span began'] },
  { name: 'the same failure noted twice', file: 'observations.js', find: 'if (last && last.t === Number(t) && last.reason === text) {', replace: 'if (false) {', fails: ['units: the same failure of the same save'] },
  { name: 'the cap on the captures not applied', file: 'observations.js', find: 'if (record.captures.length <= CAPTURES_KEPT) {', replace: 'if (record.captures.length <= CAPTURES_KEPT + 1000) {', fails: ['units: 501 captures'] },
  { name: 'the time a fork was cut at not kept', file: 'observations.js', find: '...(dropped !== null ? { cut: dropped } : {}), seed: t }', replace: '...(dropped !== null ? { cut: dropped } : {}) }', fails: ['units: the cut a fork takes'] },
  { name: 'a span that includes the parent branch not flagged', file: 'observations.js', find: 'inherited: seed !== null && first <= seed,', replace: 'inherited: false,', fails: ['units: a run is inherited', 'view: a failed capture inside a span'] },
  { name: 'an object that appeared told as seen since import', file: 'observations.js', find: "basis: mark === MOVED ? 'moved' : mark === RESTARTED ? 'branch' : cut === null && record.captures.length && first === record.captures[0][0] ? 'import' : 'appeared',", replace: "basis: mark === MOVED ? 'moved' : mark === RESTARTED ? 'branch' : 'import',", fails: ['units: an object not seen before', 'view: a formation that moved', 'view: the reason a span began'] },
  { name: 'a digest that differs from the open save still observed', file: 'observations.js', find: "return { state: span.digest === digest ? 'observed' : 'changed', span }", replace: "return { state: 'observed', span }", fails: ['units: a record whose object digest'] },
  { name: 'the widest interval taken as the first', file: 'observations.js', find: 'if (widest === null || t - record.captures[index][0] > widest.to - widest.from) {', replace: 'if (widest === null) {', fails: ['units: the widest interval'] },
  { name: 'a failed read taken as no formation', file: 'observations.js', find: 'return { kind, failed: error }', replace: 'return { kind, objects: [] }', fails: ['modded: a failed read is noted', 'modded: a failed read over'] },
  { name: 'a kind read for every race whether chosen or not', file: 'observations.js', find: 'KIND_NAMES.filter((kind) => Object.values(wish).some((campaign) => campaign.gameIds.includes(GameID) && (campaign.races[Number(RaceID)] || []).includes(kind)))', replace: 'KIND_NAMES', fails: ['modded: nothing chosen', 'units: what the recorder reads of the choice'] },
  { name: 'a choice that stays on when it is turned off', file: 'observations.js', find: 'if (on) {\n      kinds.push(kind)\n    }', replace: 'kinds.push(kind)', fails: ['units: a choice is kept'] },
  { name: 'the size predicted for an object too small', file: 'observations.js', find: 'objects * OBJECT_BYTES + captures * CAPTURE_BYTES', replace: 'objects * 8 + captures * CAPTURE_BYTES', fails: ['units: the size predicted', 'modded: the size predicted'] },
  { name: 'a capture read again rewritten as a change', file: 'observations.js', find: 'const unchanged = again && Object.keys(objects).length', replace: 'const unchanged = false && Object.keys(objects).length', fails: ['modded: the pass that records', 'falryx: the first capture'] },
  { name: 'an NPR race read', file: 'history.js', find: 'const kinds = npr ? [] : observationWanted(observe, GameID, RaceID)', replace: 'const kinds = observationWanted(observe, GameID, RaceID)', fails: ['modded: an NPR', 'passive: a player race'] },
  { name: 'a fork made while nothing was observed left unmarked', file: 'history.js', find: 'if (!resolution.forked) {', replace: 'if (!resolution.forked || !observationEverChosenIn(storage.settings ? storage.settings.store : null, resolution.campaignId, nprRaces)) {', fails: ['falryx: a campaign that never', 'falryx: a fork made while nothing'] },
  { name: 'the seed of a fork not written', file: 'history.js', find: 'storage.file(observationFileName(resolution.campaignId, resolution.branchId)).store = seed.value', replace: 'void seed.value', fails: ['falryx: a fork takes', 'falryx: the fork keeps its seed'] },
  { name: 'the branch not marked as seeded', file: 'history.js', find: 'branch.observationsSeeded = true', replace: 'branch.observationsSeeded = false', fails: ['falryx: the branch is marked', 'falryx: every later fork'] },
  { name: 'a pass replaced writes the record', file: 'history.js', find: 'if (merged.changed) {\n                guard()\n                storage.file(observationFileName', replace: 'if (merged.changed) {\n                storage.file(observationFileName', fails: ['modded: a pass superseded'] },
  { name: 'the record written for a capture that changed nothing', file: 'history.js', find: 'if (merged.changed) {\n                guard()', replace: 'if (true) {\n                guard()', fails: ['modded: the pass that records', 'falryx: the first capture'] },
  { name: 'the reason of a failed read not kept', file: 'history.js', find: 'reason: failureWords(read.failed)', replace: "reason: 'the read failed'", fails: ['modded: a failed read is noted'] },
  { name: 'clearing a race leaves its observation record', file: 'history.js', find: 'planned(observationStore(campaignId, branchId), observationsFrom),', replace: 'null,', fails: ['units: clearing a race'] },
  { name: 'the elements left out of the signature of a formation', file: 'ground-formations.js', find: "|${(held.get(row.FormationID) || []).join(',')}`", replace: '|`', fails: ['modded: the digests tell', 'modded: a later save holds', 'falryx: the first capture'] },
  { name: 'the ship left out of the signature of a formation', file: 'ground-formations.js', find: '/${orZero(row.ShipID)}/', replace: '/', fails: ['modded: the digests tell'] },
  { name: 'the headline claims a formation unchanged since the first capture', file: 'observation-view.js', find: "const since = span.basis === 'import' ? `Observed since import, ${date(span.first)}` : `Observed since ${date(span.first)}`", replace: 'const since = `Unchanged since ${date(span.first)}`', fails: ['view: a first import says', 'view: nothing says how long'] },
  { name: 'the age before the first capture guessed', file: 'observation-view.js', find: "'Its age before the first capture is not known.'", replace: "'Deployed since the game began.'", fails: ['view: nothing says how long'] },
  { name: 'a span of the parent branch not said', file: 'observation-view.js', find: 'if (span.inherited) {', replace: 'if (false) {', fails: ['view: a failed capture inside a span'] },
  { name: 'a fork\'s first capture extends the run of the parent', file: 'observations.js', find: '} else if (seed !== null && before[1] <= seed) {', replace: '} else if (false) {', fails: ['units: the first capture of a fork', 'falryx: a span never crosses', 'falryx: the fork\'s own first capture'] },
  { name: 'a cut keeps an object nothing witnesses', file: 'observations.js', find: 'if (!seen.length) {\n      return\n    }\n\n    objects[id] = [first, seen[seen.length - 1][0], digest, ...(mark ? [mark] : [])]', replace: 'objects[id] = [first, seen.length ? seen[seen.length - 1][0] : first, digest, ...(mark ? [mark] : [])]', fails: ['units: the cut a fork takes', 'units: a cut inside the captures', 'falryx: a fork taken before the captures'] },
  { name: 'a record of a later save compared with the open save', file: 'observations.js', find: 'if (open && (open.t < tip[0] || (open.t === tip[0] && open.n !== tip[1]))) {', replace: 'if (false) {', fails: ['units: a record of a later save'] },
  { name: 'the fleet of the carrier not used for a carried formation', file: 'ground-formations.js', find: 'coalesce(FCT_Fleet.SystemID, CarrierFleet.SystemID) as FleetSystemID', replace: 'FCT_Fleet.SystemID as FleetSystemID', fails: ['units: a formation on a ship with no fleet'] },
  { name: 'a choice turned off forgotten', file: 'observations.js', find: '} else if (Array.isArray(race.observe)) {\n      race.observe = []\n    } else {', replace: '} else if (false) {\n      race.observe = []\n    } else {', fails: ['units: a choice is kept'] },
  { name: 'a fork of a campaign that never observed reads the observation files', file: 'history.js', find: 'const chosenBefore = observationEverChosenIn(storage.settings ? storage.settings.store : null, resolution.campaignId, nprRaces)', replace: 'const chosenBefore = true', fails: ['falryx: a campaign that never'] },
  { name: 'a fork with no parent record given no seed time', file: 'observations.js', find: 'isKnownNumber(forkAt) && !(before && isKnownNumber(before.seed)) ? { ...(before || emptyRecord()), seed: forkAt } : before', replace: 'before', fails: ['falryx: a fork with no parent record'] },
  { name: 'a choice turned off taken as never made by a fork', file: 'observations.js', find: 'Object.entries(own.race).some(([RaceID, values]) => !skipped.includes(RaceID) && isObject(values) && Array.isArray(values.observe))', replace: 'Object.entries(own.race).some(([RaceID, values]) => !skipped.includes(RaceID) && kindsOf(values).length > 0)', fails: ['falryx: a race turned off'] },
  { name: 'the choice of an NPR race counted at a fork', file: 'observations.js', find: 'const skipped = except.map(String)', replace: 'const skipped = []', fails: ['falryx: a choice held only for a race the save marks as an NPR'] },
  { name: 'a summary that counts one capture as minus one', file: 'observation-view.js', find: "span.captures === 1 ? '1 capture' :", replace: "span.captures === 1 ? '-1 capture' :", fails: ['view: the captures of a span'] },
  { name: 'a summary that counts the captures of a span as negative', file: 'observation-view.js', find: '`${span.captures} captures, longest interval', replace: '`-${span.captures} captures, longest interval', fails: ['view: the captures of a span'] },
  { name: 'the account of a record that counts its captures as negative', file: 'observation-view.js', find: "`${plural(record.captures.length, 'capture', 'captures')} on this branch", replace: "`${plural(-record.captures.length, 'capture', 'captures')} on this branch", fails: ['view: the account of a record'] },
  { name: 'an object no capture saw read from a file', file: 'observations.js', find: '!times.has(last) || !(times.has(first) || first <= cut)', replace: 'false', fails: ['units: an object no capture'] },
  { name: 'a last sighting that is no capture read from a file', file: 'observations.js', find: '!times.has(last) || ', replace: '', fails: ['units: an object no capture'] },
  { name: 'a first sighting that a cap dropped refused', file: 'observations.js', find: '!(times.has(first) || first <= cut)', replace: '!times.has(first)', fails: ['units: an object no capture'] },
  { name: 'a summary that counts one capture as a malformed figure', file: 'observation-view.js', find: "span.captures === 1 ? '1 capture' :", replace: "span.captures === 1 ? '0,1 capture' :", fails: ['view: the captures of a span'] },
  { name: 'a summary that counts the captures of a span as a malformed figure', file: 'observation-view.js', find: '`${span.captures} captures, longest interval', replace: '`0,${span.captures} captures, longest interval', fails: ['view: the captures of a span'] },
  { name: 'a summary that tells its longest interval as a malformed figure', file: 'observation-view.js', find: 'captures, longest interval ${duration(span.longest.to - span.longest.from)}`', replace: 'captures, longest interval 0,${duration(span.longest.to - span.longest.from)}`', fails: ['view: the captures of a span'] },
  { name: 'the account of a record that counts its captures as a malformed figure', file: 'observation-view.js', find: "`${plural(record.captures.length, 'capture', 'captures')} on this branch", replace: "`0,${plural(record.captures.length, 'capture', 'captures')} on this branch", fails: ['view: the account of a record'] },
  { name: 'the account of a record that tells its widest interval as a malformed figure', file: 'observation-view.js', find: 'the widest interval between two is ${duration(widest)}', replace: 'the widest interval between two is 0,${duration(widest)}', fails: ['view: the account of a record'] },
]

// Faults planted in what the browser is served: the page or a utility the page uses (`file` is a path under the renderer), with the checks each must fail by a value. A utility the recorder runs is served too, so a fault there shows as the screen a player sees.
const BROWSER_MUTATIONS = [
  { name: 'the Observed column left out', file: SURVEY_FILE, find: "...(this.observationKey ? [{ text: 'Observed', value: 'observedSort' }] : [])", replace: '...[]', fails: ['browser: turning the switch on'], until: 'first' },
  { name: 'the switch asking for no pass', file: SURVEY_FILE, find: "if (on) {\n        this.$store.commit('history/capture')", replace: "if (false) {\n        this.$store.commit('history/capture')", fails: ['browser: turning the switch on'], until: 'first' },
  { name: 'the History page counting no object', file: path.join(pagesDirectory, 'history.vue'), find: "`${this.count(budget.objects, 0)} ${budget.objects === 1 ? 'object' : 'objects'} and", replace: "`${this.count(0, 0)} ${budget.objects === 1 ? 'object' : 'objects'} and", fails: ['browser: the History page'], until: 'history' },
  { name: 'the block of the switch hidden by an ancestor of the switch', file: SURVEY_FILE, find: '<div v-if="canObserve" class="d-flex align-center flex-wrap mb-2" data-observe="control">', replace: '<div v-if="canObserve" class="d-flex align-center flex-wrap mb-2" style="display: none !important" data-observe="control">', fails: ['browser: before the switch'], until: 'off' },
  { name: 'the headline of a cell hidden by itself', file: SURVEY_FILE, find: '<div class="font-weight-medium" data-observed-headline>{{ item.observed.headline }}</div>\n                  <div class="caption text--secondary" data-observed-summary>', replace: '<div v-show="false" class="font-weight-medium" data-observed-headline>{{ item.observed.headline }}</div>\n                  <div class="caption text--secondary" data-observed-summary>', fails: ['browser: turning the switch on'], until: 'first' },
  { name: 'the cell put in a slot the table does not take', file: SURVEY_FILE, find: '<template #[`item.observedSort`]="{ item }">', replace: '<template #[`item.observedSortx`]="{ item }">', fails: ['browser: turning the switch on'], until: 'first' },
  { name: 'the account of the record hidden by itself', file: SURVEY_FILE, find: '<span data-observe="record">', replace: '<span v-show="false" data-observe="record">', fails: ['browser: the foot of the table'], until: 'first' },
  { name: 'the opened row hidden by an ancestor', file: SURVEY_FILE, find: '<td :colspan="headers.length" class="py-3" data-compare="detail" :data-compare-formation="item.id">', replace: '<td :colspan="headers.length" class="py-3" style="display: none" data-compare="detail" :data-compare-formation="item.id">', fails: ['browser: the opened row'], until: 'detail' },
  { name: 'the opened row put in a slot the table does not take', file: SURVEY_FILE, find: '<template #expanded-item="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail" :data-compare-formation="item.id">', replace: '<template #expanded-itemx="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail" :data-compare-formation="item.id">', fails: ['browser: the opened row'], until: 'detail' },
  { name: 'the dates of the page one day late, its hooks left as they are', file: SURVEY_FILE, find: 'gameDateText(this.StartYear, seconds).slice(0, 10)', replace: 'gameDateText(this.StartYear, seconds + 86400).slice(0, 10)', fails: ['browser: turning the switch on', 'browser: a later save'] },
  { name: 'the size predicted for the formations in view, not for every formation of the race', file: SURVEY_FILE, find: 'observationEstimate({ objects: this.formationAll.length })', replace: 'observationEstimate({ objects: this.formationList.length })', fails: ['browser: before the switch'], until: 'off' },
  { name: 'the captures held and the captures a full list holds said each in the other\'s place', edits: [[path.join(pagesDirectory, 'history.vue'), "and ${this.count(budget.captures, 0)} ${budget.captures === 1 ? 'capture' : 'captures'} kept`", 'and ${this.count(CAPTURES_KEPT, 0)} captures kept`'], [path.join(pagesDirectory, 'history.vue'), 'predicted once ${this.count(CAPTURES_KEPT, 0)} captures are held', 'predicted once ${this.count(budget.captures, 0)} captures are held']], fails: ['browser: the History page'], until: 'history' },
]

// One rewrite of each family of the utilities that draws the same screen and records the same file, made together and loaded once (`stackedSources`): no check may fail.
const BENIGN = [
  { name: 'a parenthesised test of a merge', file: 'observations.js', find: 'const again = Boolean(tip) && capture.t === tip[0]', replace: 'const again = (tip !== null) && (capture.t === tip[0])' },
  { name: 'the choice of an NPR written the other way round', file: 'history.js', find: 'const kinds = npr ? [] : observationWanted(observe, GameID, RaceID)', replace: 'const kinds = !npr ? observationWanted(observe, GameID, RaceID) : []' },
  { name: 'a number of a signature written through Number', file: 'ground-formations.js', find: 'const orZero = (value) => (isNumber(value) ? value : 0)', replace: 'const orZero = (value) => (isNumber(value) ? Number(value) : 0)' },
  { name: 'the two conditions of the rows written the other way round', file: 'observation-view.js', find: '(objects && open ? objects : [])', replace: '(open && objects ? objects : [])' },
  { name: 'the reason of an appearance worded another way', file: 'observation-view.js', find: 'Not there at the capture of ${date(span.before)}.', replace: 'It was not there at the capture of ${date(span.before)}.' },
  { name: 'the age before the first capture worded another way', file: 'observation-view.js', find: "'Its age before the first capture is not known.'", replace: "'The time before the first capture is unknown.'" },
  { name: 'the test of a fork time written with a null check', file: 'observations.js', find: 'isKnownNumber(forkAt) && !(before && isKnownNumber(before.seed))', replace: 'isKnownNumber(forkAt) && !(before !== null && isKnownNumber(before.seed))' },
  { name: 'the account of a record with its qualifier moved to the front', file: 'observation-view.js', find: "`${plural(record.captures.length, 'capture', 'captures')} on this branch, from ${date(first)} to ${date(last)}`", replace: "`On this branch, ${plural(record.captures.length, 'capture', 'captures')}, from ${date(first)} to ${date(last)}`" },
  { name: 'the test of a first sighting written the other way round', file: 'observations.js', find: 'times.has(first) || first <= cut', replace: 'cut >= first || times.has(first)' },
]

// One rewrite of each family the lane brief names, made together in the page and its view and served once: the table scope bound by an explicit prop and event instead of `v-model`, the switch's listener written `v-on:`, the cell and the detail taken by the slot's long form, a parenthesised condition, the classes of a summary in another order, the account with its qualifier moved to the front and a synonym in the generated prose. The page must draw the same screen and no check fail.
const BROWSER_BENIGN = [
  {
    name: 'the equivalent forms of each family',
    edits: [
      [SURVEY_FILE, 'v-model="remoteOnly"', ':input-value="remoteOnly" @change="remoteOnly = $event"'],
      [SURVEY_FILE, '@change="setObserve" />', 'v-on:change="setObserve" />'],
      [SURVEY_FILE, '<template #[`item.observedSort`]="{ item }">', '<template v-slot:[`item.observedSort`]="{ item }">'],
      [SURVEY_FILE, '<template #expanded-item="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail" :data-compare-formation="item.id">', '<template v-slot:expanded-item="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail" :data-compare-formation="item.id">'],
      [SURVEY_FILE, '<div v-if="canObserve" class="d-flex', '<div v-if="(canObserve)" class="d-flex'],
      [SURVEY_FILE, '<div class="caption text--secondary" data-observed-summary>', '<div class="text--secondary caption" data-observed-summary>'],
      [utilityFile('observation-view.js'), "`${plural(record.captures.length, 'capture', 'captures')} on this branch, from ${date(first)} to ${date(last)}`", "`On this branch, ${plural(record.captures.length, 'capture', 'captures')}, from ${date(first)} to ${date(last)}`"],
      [utilityFile('observation-view.js'), "'Its age before the first capture is not known.'", "'The time before the first capture is unknown.'"],
    ],
  },
]
/* eslint-enable no-template-curly-in-string */

const GROUPS = (m) => [...unitChecks(m), ...viewChecks(m), ...moddedChecks(m), ...falryxChecks(m), ...passiveChecks(m)]

// ---------- the parts ----------

const stemOf = (file) => path.basename(file, '.js')

const MUTANTS = [
  ...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })),
  { kind: 'benign', id: 'benign:0', name: 'the equivalent forms of each family in the utilities', rewrites: BENIGN },
  ...BROWSER_MUTATIONS.map((mutation, index) => ({ kind: 'browser', id: `browser:${index}`, ...mutation })),
  ...BROWSER_BENIGN.map((rewrite, index) => ({ kind: 'browser-benign', id: `browser-benign:${index}`, ...rewrite })),
]

// The verdict on a fault over the checks it names (`named`, `[name, test]`): each start of `fails` must begin a check that failed by a value (`caughtBy`). Returns [verdict, detail].
const faultVerdict = async (named, { name, fails, throws = false }, began) => {
  const absent = fails.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))
  const failed = judged(await runChecks(asChecks(named), {}), `the fault "${name}"`)
  const missed = fails.filter((start) => !caughtBy(failed, named.map(([checkName]) => checkName).filter((checkName) => checkName.startsWith(start)), { name, throws }))

  return [absent.length ? `no check begins ${absent.join('; ')}` : missed.length ? `these checks did not fail by a value: ${missed.join('; ')}` : true, `credited by ${creditOf(failed)}, ${((Date.now() - began) / 1000).toFixed(1)} s`]
}

// The sources of the utilities after every edit of `edits` ({ file, find, replace }), made in order and served together: `{ stem: text }` for `loadAll`.
const stackedSources = (edits) => {
  const sources = {}

  for (const { file, find, replace } of edits) {
    const stem = stemOf(file)
    const target = utilityFile(file)

    sources[stem] = patched(target, stem in sources ? sources[stem] : fs.readFileSync(target, 'utf8'), find, replace)
  }

  return sources
}

const checkUtilityMutation = async (mutant) => {
  const { kind, name, file, find, replace, fails, rewrites } = mutant
  const began = Date.now()
  const benign = kind === 'benign'

  try {
    const m = await loadAll(benign ? stackedSources(rewrites) : { [stemOf(file)]: plantedPatch(utilityFile(file), fs.readFileSync(utilityFile(file), 'utf8'), find, replace) })

    if (benign) {
      const results = await runChecks(asChecks(GROUPS(m)), {})
      const failed = judged(results, `the rewrite "${name}"`)

      check(`benign rewrite: ${name}: no check fails`, failed.length === 0 ? true : failed.map((result) => `${result.name}: ${result.detail}`).join('; '), `${((Date.now() - began) / 1000).toFixed(1)} s`)

      return
    }

    const named = GROUPS(m).filter(([checkName]) => fails.some((start) => checkName.startsWith(start)))
    const [verdict, detail] = await faultVerdict(named, mutant, began)

    check(`mutation caught: ${name}`, verdict, detail)
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error
    }

    check(`${benign ? 'benign rewrite' : 'mutation caught'}: ${name}`, `does not load: ${error.message}`)
  }
}

// What a browser variant serves: [file, text] for each file its edits change, the edits made in order (`edits`, [file, find, replace]; a variant with one change gives `file`, `find` and `replace`). A fault is planted through `plantedPatch` (refused in a quick run), a rewrite through `patched`.
const servedBy = ({ edits, file, find, replace }, patch) => {
  const texts = new Map()

  ;(edits || [[file, find, replace]]).forEach(([target, from, to]) => texts.set(target, patch(target, texts.has(target) ? texts.get(target) : fs.readFileSync(target, 'utf8'), from, to)))

  return [...texts]
}

// A fault or a benign rewrite served to the browser (`observeSource`). A fault must fail by a value each check it names (`caughtBy`), a rewrite none; a variant whose page did not get through is judged by nothing and fails as a defect of the harness. A fault stops the case at the stage its named checks read (`until`) and judges those checks alone; a rewrite runs the whole case and every check.
const checkBrowserVariant = async (mutant, real) => {
  const { kind, name, fails = [], throws = false, until = null } = mutant
  const began = Date.now()
  const fault = kind === 'browser'
  const observation = await observeSource(servedBy(mutant, fault ? plantedPatch : patched), fault ? until : null)

  if (unobserved(observation)) {
    throw new HarnessError(`the app with the fault "${name}" did not get through: ${observation.error}`)
  }

  const oracle = formationCount()
  const checks = browserChecks(real, oracle)
  const results = await runChecks(fault ? checks.filter(({ id }) => fails.some((start) => id.startsWith(start))) : checks, { observation })
  const failed = judged(results, `the ${fault ? 'fault' : 'rewrite'} "${name}"`)
  const took = `${((Date.now() - began) / 1000).toFixed(1)} s`

  if (fault) {
    const missed = fails.filter((start) => !caughtBy(failed, results.map((result) => result.id).filter((id) => id.startsWith(start)), { name, throws }))

    check(`browser mutation caught: ${name}`, missed.length ? `these checks did not fail by a value: ${missed.join('; ')} (failed: ${creditOf(failed)})` : true, `credited by ${creditOf(failed)}, ${took}`)
  } else {
    check(`browser benign rewrite: ${name}: no check fails`, failed.length === 0 ? true : failed.map((result) => `${result.name}: ${result.detail}`).join('; '), took)
  }
}

const formationCount = () => (BROWSER.facts ? BROWSER.facts.count : 0)

const runPart = async (part) => {
  const mutant = MUTANTS.find(({ id }) => id === part)

  if (mutant && (mutant.kind === 'utility' || mutant.kind === 'benign')) {
    await checkUtilityMutation(mutant)

    return
  }

  const real = await loadAll()

  if (part === 'groups') {
    printResults(await runChecks(asChecks(GROUPS(real)), {}))
  } else if (part === 'browser') {
    const observation = await observeSource()

    printResults(await runChecks(browserChecks(real, formationCount()), { observation }))
  } else if (mutant) {
    await checkBrowserVariant(mutant, real)
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

// The deadlines, in seconds: a part in memory runs the scenarios over the saves (the modded and the eight of falryx are read through SQL once for the process); a part served to the browser starts the app twice; the setup starts and warms the page server, the one cold start of the run.
const DEADLINES = { part: 240, mutant: 240, browser: 400, setup: 900 }
const MUTATIONS_HEADING = '\nMutations: each must fail by a value the checks it names, and each benign rewrite none'

const variantsOf = (options) => [
  { key: 'groups', name: 'the observation record: units, words, the recorder over the saves', head: true, heading: 'The formation observation record: units, words and the recorder over the modded save, the falryx saves and the passive campaign', deadline: DEADLINES.part, run: () => runPart('groups') },
  { key: 'browser', name: 'the browser', head: true, heading: '\nThe browser (the app over a copy of AuroraDB.db and a later copy of it, in Chromium)', pool: 'browser', deadline: DEADLINES.browser, run: () => runPart('browser') },
  ...(options.mutations ? MUTANTS.map((mutant) => ({ key: mutant.id, name: `${mutant.kind} ${mutant.kind.includes('benign') ? 'rewrite' : 'mutation'}: ${mutant.name}`, heading: MUTATIONS_HEADING, pool: mutant.kind.startsWith('browser') ? 'browser' : null, deadline: mutant.kind.startsWith('browser') ? DEADLINES.browser : DEADLINES.mutant, run: () => runPart(mutant.id) })) : []),
]

const parseArguments = (argv) => {
  const options = { mutations: true }

  for (const argument of argv) {
    if (argument === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argument}`)
      process.exit(2)
    }
  }

  return options
}

const main = async () => {
  const options = parseArguments(runnerArgs().rest)
  const totals = await runSuite({
    script: __filename,
    inputs: [MODDED.file, ...(falryxFiles() || []), ...(passiveFiles() || [])].filter((input) => fs.existsSync(input)),
    variants: variantsOf(options),
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
    control: options.mutations ? { fault: 'browser:3', head: 'browser', heading: '\nThe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}

module.exports = { GROUPS, loadAll }
