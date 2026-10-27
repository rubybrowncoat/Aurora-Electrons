/*
  Checks the event archive and the pins: the opt-in record of a race's game log, kept per branch, and the durable pins on events (src/renderer/utilities/event-archive.js, event-pins.js and their use in utilities/history.js).

  node scripts/check-event-archive.js [--no-mutations]

  Groups, each check numbered and keyed (a mutation names the keys it must break):
  - rows: how an event is normalised and identified (null against 0, text, the exact fingerprint, the multiset of identical rows), what a capture takes of a read;
  - merge: the reconciliation of captures (the same capture again, the open oldest and newest increments, a closed increment that contradicts, a ledger that does not match, the spans and their gaps, the cap), the archive as rows, a file that cannot be read;
  - branch: the archive of a fork (up to the fork, through a parent with none, never merged, a seed that stays empty);
  - pins: a pin once per group, the limit, the pins a fork inherits, what a save says of a pin;
  - falryx: the saves of artifacts/falryx-sequential-and-rollback (game 141, race 791, a rollback and forks), read only: the figures of the reconciliation against SQL written here, a fork merged into one archive, the bytes an event costs, pins across saves whose rowids changed;
  - passive: the 150 snapshots of artifacts/passive-campaign-20261013 (game 139, its player race found by SQL), read only: every snapshot merged in order against the multiset union computed here.
  A save that is not there skips its group and says so; nothing is read from it but SELECTs (the files are opened read only).

  Everything else runs on in-memory stores. Each mutation of the utilities is planted in an isolated copy (scripts/lib/mutant-source.js) and must break the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { plantedCopy } = require('./lib/mutant-source')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const FALRYX = path.join(root, 'artifacts', 'falryx-sequential-and-rollback')
const FALRYX_GAME = 141
const FALRYX_RACE = 791
const PASSIVE = path.join(root, 'artifacts', 'passive-campaign-20261013', 'snapshots')
const PASSIVE_GAME = 139
const NAMES = ['event-archive', 'event-pins', 'history', 'campaign', 'recording-owner']
const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The stores of the history folder, kept in one map by folder and name: what `clearRaceHistory` and `eventStore` read and write.
const STORE_STUB = `const files = (globalThis.__eventArchiveStores = globalThis.__eventArchiveStores || new Map())
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

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const loadModules = async (directory) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory })

  return { a: loaded['event-archive'], p: loaded['event-pins'], history: loaded.history, directory, reload: () => loadModules(directory) }
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

const rowsOf = async (file, sql, params = []) => {
  const handle = await handleOf(file)

  return new Promise((resolve, reject) => handle.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))))
}

// What the utilities read, kept by save and statement: the saves do not change, so a planted copy of a utility reads the rows the real one did and only the utility's own work is repeated. Each statement is logged when a log is given.
const readRows = new Map()

const RACE_LOG_STATEMENT = /^select FCT_GameLog\.IncrementID, .* from FCT_GameLog where FCT_GameLog\.GameID = \d+ and FCT_GameLog\.RaceID = \d+$/

const WINDOW_STATEMENT = /min\(FCT_GameLog\.IncrementID\)/

// The database the recorder reads: one transaction that is the connection, each statement logged, the event statements made to fail on request.
const databaseOf = (file, { log = null, fail = false, failEvents = false } = {}) => ({
  transaction: (work) => work({ id: 'transaction' }),
  query: async (sql) => {
    if (log) {
      log.push(sql)
    }

    if (fail || (failEvents && (RACE_LOG_STATEMENT.test(sql) || WINDOW_STATEMENT.test(sql)))) {
      throw new Error('disk I/O error')
    }

    const key = `${file}|${sql}`

    if (!readRows.has(key)) {
      readRows.set(key, rowsOf(file, sql))
    }

    return [await readRows.get(key)]
  },
})

// ---------- what is computed here, apart from the utilities ----------

const FIELD_SQL = 'Time, EventType, MessageText, SystemID, PopulationID, Xcor, Ycor, IDType, SMOnly'

const independents = new Map()

const once = (key, work) => {
  if (!independents.has(key)) {
    independents.set(key, work())
  }

  return independents.get(key)
}

// A race's log of one save grouped by SQL: { byInc: Map(IncrementID -> Map(group key -> count)), rows } with the group key the JSON of the nine stored values.
const groupsOf = (file, GameID, RaceID) => once(`groups|${file}|${GameID}|${RaceID}`, async () => {
  const grouped = await rowsOf(file, `select IncrementID, ${FIELD_SQL}, count(*) as n from FCT_GameLog where GameID = ${GameID} and RaceID = ${RaceID} group by IncrementID, ${FIELD_SQL}`)
  const byInc = new Map()
  let rows = 0

  grouped.forEach((row) => {
    const groups = byInc.get(row.IncrementID) || new Map()

    groups.set(JSON.stringify([row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType, row.SMOnly]), row.n)
    byInc.set(row.IncrementID, groups)
    rows += row.n
  })

  return { byInc, rows }
})

// The ledger of a save from the log's oldest increment on, by SQL: { first, last, ledger: Map(IncrementID -> [IncrementID, GameTime, Length]) }.
const ledgerOfSave = (file, GameID) => once(`ledger|${file}|${GameID}`, async () => {
  const [{ first }] = await rowsOf(file, `select min(IncrementID) as first from FCT_GameLog where GameID = ${GameID}`)
  const rows = await rowsOf(file, `select IncrementID, GameTime, Length from FCT_Increments where GameID = ${GameID} and IncrementID >= ${first} order by IncrementID`)

  return { first, last: rows[rows.length - 1].IncrementID, ledger: new Map(rows.map((row) => [row.IncrementID, [row.IncrementID, row.GameTime, row.Length]])) }
})

const gameTimeOf = async (file, GameID) => (await rowsOf(file, `select GameTime from FCT_Game where GameID = ${GameID}`))[0].GameTime

const sameIdentity = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

// The reconciliation rule written again from the design (docs/plans/backlog/evidence/AE-161-01.md 8.3), over the SQL figures of a series of saves in order: a group of a stored increment the read holds fewer of (or none) is a conflict, except in the read's oldest increment and the archive's newest, which are open and take the larger count; an increment whose identity the ledger changed is a ledger conflict, kept as it was. Returns { state: Map(IncrementID -> { identity, groups }), conflicts: Set of `id|reason|group` }.
const modelOf = (series) => {
  const state = new Map()
  const conflicts = new Set()

  series.forEach((save) => {
    const newest = state.size ? Math.max(...state.keys()) : null
    const open = (id) => id === save.first || id === newest

    state.forEach((own, id) => {
      const identity = save.ledger.get(id)

      if (!identity) {
        return
      }

      if (!sameIdentity(identity, own.identity)) {
        conflicts.add(`${id}|ledger|`)
        return
      }

      const read = save.byInc.get(id) || new Map()

      own.groups.forEach((count, key) => {
        const readCount = read.get(key) || 0

        if (readCount > count) {
          if (!open(id)) {
            conflicts.add(`${id}|more|${key}`)
          }

          own.groups.set(key, readCount)
        } else if (readCount < count && !open(id)) {
          conflicts.add(`${id}|${readCount ? 'fewer' : 'missing'}|${key}`)
        }
      })

      read.forEach((count, key) => {
        if (!own.groups.has(key)) {
          if (!open(id)) {
            conflicts.add(`${id}|more|${key}`)
          }

          own.groups.set(key, count)
        }
      })
    })

    save.byInc.forEach((groups, id) => {
      if (state.has(id)) {
        if (!sameIdentity(state.get(id).identity, save.ledger.get(id))) {
          conflicts.add(`${id}|ledger|`)
        }
      } else if (save.ledger.has(id)) {
        state.set(id, { identity: save.ledger.get(id), groups: new Map(groups) })
      }
    })
  })

  return { state, conflicts }
}

const eventsOfModel = (state) => [...state.values()].reduce((sum, own) => sum + [...own.groups.values()].reduce((a, b) => a + b, 0), 0)

// What a save says as the model reads it: the SQL figures of its log and its ledger.
const saveOf = async (file, GameID, RaceID) => {
  const { byInc } = await groupsOf(file, GameID, RaceID)
  const { first, last, ledger } = await ledgerOfSave(file, GameID)

  return { byInc, first, last, ledger }
}

// ---------- an installation: each store a JSON value read and written whole ----------

// The stores keep their JSON text, as a file on disk would: a value is serialised on write and parsed on read, so the code under test never shares an object with a store, and each copy costs one pass instead of a clone's two. `files` reads as a Map of values, each read a fresh copy.
const installation = ({ seed = {}, counter: start = 1000, clock = 1000000 } = {}) => {
  const texts = new Map(Object.entries(seed).map(([name, value]) => [name, JSON.stringify(value)]))
  const read = (name) => {
    const text = texts.get(name)

    return text === undefined ? undefined : JSON.parse(text)
  }
  const files = {
    get: read,
    has: (name) => texts.has(name),
    keys: () => texts.keys(),
    * [Symbol.iterator] () {
      for (const name of texts.keys()) {
        yield [name, read(name)]
      }
    },
  }
  const writes = []
  let cut = () => false
  let ids = start
  const broken = new Map()
  let time = clock

  const store = (name) => ({
    get store () {
      if (broken.has(name)) {
        const state = broken.get(name)

        state.reads++

        if (state.reads > state.after) {
          throw new Error('the store cannot be read')
        }
      }

      return read(name) || {}
    },
    set store (value) {
      texts.set(name, JSON.stringify(value))
      writes.push({ name, cut: cut(), text: name.endsWith('-events') ? texts.get(name) : undefined })
    },
    update (change) {
      this.store = change(this.store)

      return this.store
    },
  })

  return {
    files,
    writes,
    put: (name, value) => texts.set(name, JSON.stringify(value)),
    setCut: (test) => { cut = test },
    // The store throws from its read number `after` + 1 on: 0 for always, 1 for a store that reads once and then fails, as one that goes bad between the check of an archive and its use.
    breakStore: (name, after = 0) => broken.set(name, { after, reads: 0 }),
    mendStore: (name) => broken.delete(name),
    newId: () => `c${++ids}`,
    now: () => ++time,
    io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), backup: store('backup'), file: (name) => store(`file:${name}`) },
    registry: () => ({ campaigns: {}, pool: {}, ...(read('registry') || {}) }),
    campaignId: (GameID) => Object.entries((read('registry') || { campaigns: {} }).campaigns).filter(([, campaign]) => GameID === undefined || (campaign.gameIds || []).includes(GameID)).map(([id]) => id)[0],
    branch: (campaignId, branchId = 'b1') => read(`file:campaign-${campaignId}-${branchId}`) || {},
    events: (campaignId, branchId = 'b1') => read(`file:campaign-${campaignId}-${branchId}-events`),
    eventWrites: () => writes.filter(({ name }) => name.endsWith('-events')).length,
    eventValues: (name, from = 0) => writes.slice(from).filter((write) => write.name === name).map((write) => (write.text === undefined ? undefined : JSON.parse(write.text))),
    copy: () => installation({ seed: Object.fromEntries(files), counter: ids, clock: time }),
  }
}

// ---------- synthetic captures ----------

const ID = (id) => [id, id * 100, 100]

const windowOf = (from, to, identityOf = ID) => ({ first: from, ledger: new Map(Array.from({ length: to - from + 1 }, (_value, index) => [from + index, identityOf(from + index)])) })

const ev = (inc, text, extra = {}) => ({ IncrementID: inc, Time: inc * 100 + 1, EventType: 1, MessageText: text, SystemID: 5, PopulationID: null, Xcor: 0, Ycor: null, IDType: 0, SMOnly: 0, ...extra })

const many = (inc, text, count, extra) => Array.from({ length: count }, () => ev(inc, text, extra))

const capture = (m, from, to, rows, { t = to * 100 + 100, identityOf } = {}) => m.a.captureOf(rows, windowOf(from, to, identityOf), t)

const counter = () => {
  let n = 0

  return () => ++n
}

const merged = (m, stored, taken) => m.a.mergeCapture(stored, taken, { now: counter() })

const groupOf = (record, id, text) => {
  const increment = record.increments.find((entry) => entry[0] === id)

  return increment ? increment[3].find((group) => group[2] === text) || null : null
}

const countOf = (record, id, text) => {
  const group = groupOf(record, id, text)

  return group ? group[9] : 0
}

const idsOf = (record) => record.increments.map((increment) => increment[0])

// ---------- the checks ----------

const checks = []
const check = (key, name, needs, run) => checks.push({ key, name, needs, run })

check('fields', 'an event is kept as numbers, text and null: a stored 0 stays 0, a missing value is null, a numeric string is a number, the message is text, and no two different events share a fingerprint', 'unit', ({ m }) => {
  const fields = m.a.eventFields({ Time: 5, EventType: 0, MessageText: 'a', SystemID: null, PopulationID: undefined, Xcor: '3', Ycor: 0.5, IDType: NaN, SMOnly: '' })

  assert.deepEqual(fields, [5, 0, 'a', null, null, 3, 0.5, null, null])
  assert.deepEqual(m.a.EVENT_FIELDS, ['Time', 'EventType', 'MessageText', 'SystemID', 'PopulationID', 'Xcor', 'Ycor', 'IDType', 'SMOnly'])
  assert.equal(m.a.eventFields({ MessageText: null })[2], null)
  assert.equal(m.a.eventFields({ MessageText: undefined })[2], null)
  assert.equal(m.a.eventFields({ MessageText: '' })[2], '')
  assert.equal(m.a.eventFields({ MessageText: 0 })[2], '0')
  assert.deepEqual(m.a.eventFields({}), Array(9).fill(null))

  const base = m.a.eventFields(ev(3, 'x'))

  assert.equal(m.a.fingerprint(3, base), JSON.stringify([3, ...base]))
  assert.equal(m.a.fingerprint('3', base), m.a.fingerprint(3, base))
  assert.equal(m.a.rowFingerprint(ev(3, 'x')), m.a.fingerprint(3, base))
  assert.equal(m.a.rowFingerprint({ ...ev(3, 'x'), rowid: 99, GameID: 1, RaceID: 7 }), m.a.rowFingerprint(ev(3, 'x')), 'what is not an event field never enters the identity')
  assert.notEqual(m.a.fingerprint(4, base), m.a.fingerprint(3, base))

  const seen = new Set([m.a.fingerprint(3, base)])

  base.forEach((_value, index) => {
    const other = [...base]

    other[index] = index === 2 ? 'y' : base[index] === null ? 0 : base[index] + 1
    assert.ok(!seen.has(m.a.fingerprint(3, other)), `field ${index} is part of the identity`)
    seen.add(m.a.fingerprint(3, other))

    const nulled = [...base]

    nulled[index] = null
    assert.ok(!seen.has(m.a.fingerprint(3, nulled)) || base[index] === null, `null is not the value of field ${index}`)
    seen.add(m.a.fingerprint(3, nulled))
  })

  assert.notEqual(m.a.rowFingerprint(ev(3, 'x', { Xcor: 0 })), m.a.rowFingerprint(ev(3, 'x', { Xcor: null })), 'a stored 0 is not a missing value')
  assert.notEqual(m.a.rowFingerprint(ev(3, '0', { Ycor: 0 })), m.a.rowFingerprint(ev(3, 'x', { Ycor: 0 })))
  assert.notEqual(m.a.rowFingerprint(ev(3, 'a|', { SystemID: 5, PopulationID: null })), m.a.rowFingerprint(ev(3, 'a', { SystemID: null, PopulationID: 5 })), 'text and numbers never run together')
  assert.notEqual(m.a.rowFingerprint(ev(3, 'a","b', { SystemID: 5 })), m.a.rowFingerprint(ev(3, 'a', { SystemID: 5 })))
})

check('counts', 'identical rows are counted as a multiset, never as one: the same fields in another increment are another event', 'unit', ({ m }) => {
  const counts = m.a.rowCounts([ev(1, 'a'), ev(1, 'a'), ev(1, 'a'), ev(1, 'b'), ev(2, 'a', { Time: 101 }), { ...ev(1, 'b'), rowid: 8, Xcor: undefined, Ycor: undefined }])

  assert.equal(counts.get(m.a.rowFingerprint(ev(1, 'a'))), 3)
  assert.equal(counts.get(m.a.rowFingerprint(ev(2, 'a', { Time: 101 }))), 1)
  assert.equal(counts.get(m.a.rowFingerprint(ev(1, 'b'))), 1, 'a row with the value missing is not the row with 0')
  assert.equal(counts.get(m.a.rowFingerprint({ ...ev(1, 'b'), Xcor: undefined, Ycor: undefined })), 1)
  assert.equal(counts.size, 4)
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 6)
  assert.equal(m.a.rowCounts([]).size, 0)
})

check('capture', 'a capture is the race\'s rows by increment as counted groups with the ledger\'s identity, a row of an increment the ledger lacks is left out and counted, and an empty log is no capture', 'unit', ({ m }) => {
  const rows = [...many(3, 'b', 2), ev(2, 'a'), ev(3, 'a'), ev(9, 'orphan')]
  const taken = capture(m, 1, 5, rows, { t: 777 })

  assert.equal(taken.t, 777)
  assert.deepEqual(taken.from, ID(1))
  assert.deepEqual(taken.to, ID(5))
  assert.equal(taken.orphans, 1)
  assert.equal(taken.rows, 4)
  assert.deepEqual(taken.increments.map((increment) => increment.slice(0, 3)), [ID(2), ID(3)])
  assert.deepEqual(taken.increments[1][3].map((group) => [group[2], group[9]]), [['a', 1], ['b', 2]])
  assert.equal(taken.increments[0][3][0].length, 10)
  assert.deepEqual(taken.increments[0][3][0].slice(3, 9), [5, null, 0, null, 0, 0], 'a missing value is null and a stored 0 is 0')
  assert.equal(m.a.captureOf([], { first: null, ledger: new Map() }, 1), null)
  assert.equal(m.a.captureOf([ev(1, 'a')], { first: null, ledger: new Map() }, 1), null)
})

check('readfail', 'a failed read is kept as { failed } and never thrown, and a window already read is not read again', 'unit', async ({ m }) => {
  const log = []
  const failing = await m.a.readRaceEvents({ query: async (sql) => { log.push(sql); throw new Error('disk I/O error') } }, { GameID: 1, RaceID: 7, t: 5 })

  assert.ok(failing.failed instanceof Error)
  assert.equal(failing.capture, undefined)

  const window = windowOf(1, 3)
  const statements = []
  const database = { query: async (sql) => { statements.push(sql); return [[ev(2, 'a')]] } }
  const read = await m.a.readRaceEvents(database, { GameID: 1, RaceID: 7, t: 5, window })

  assert.equal(statements.length, 1, 'only the race\'s rows are read when the game\'s window is known')
  assert.match(statements[0], /^select /)
  assert.match(statements[0], /FCT_GameLog\.RaceID = 7/)
  assert.equal(read.window, window)
  assert.equal(read.capture.rows, 1)
})

check('span', 'spans merge where they touch or overlap, stay in order apart, and the list given is not changed', 'unit', ({ m }) => {
  const given = [[1, 3], [7, 9]]

  assert.deepEqual(m.a.withSpan([], 5, 9), [[5, 9]])
  assert.deepEqual(m.a.withSpan(given, 4, 6), [[1, 3], [4, 6], [7, 9]])
  assert.deepEqual(m.a.withSpan(given, 3, 7), [[1, 9]])
  assert.deepEqual(m.a.withSpan(given, 2, 8), [[1, 9]])
  assert.deepEqual(m.a.withSpan([[1, 10]], 3, 4), [[1, 10]])
  assert.deepEqual(m.a.withSpan([[5, 6], [1, 2]], 0, 1), [[0, 2], [5, 6]])
  assert.deepEqual(m.a.withSpan([[1, 3]], 2, 9), [[1, 9]])
  assert.deepEqual(given, [[1, 3], [7, 9]])
})

check('same', 'the same capture merged again changes nothing: no row, no revision, no write, and the stored record is not touched', 'unit', ({ m }) => {
  const taken = capture(m, 1, 5, [...many(1, 'a', 2), ev(3, 'y'), ev(5, 'z')])
  const first = merged(m, null, taken)

  assert.equal(first.added, 4)
  assert.equal(first.amended, 0)
  assert.equal(first.changed, true)
  assert.equal(first.record.revision, 1)
  assert.deepEqual(first.record.spans, [[100, 600]])

  const before = clone(first.record)
  const again = merged(m, first.record, taken)

  assert.equal(again.changed, false)
  assert.equal(again.added + again.amended + again.conflicts, 0)
  assert.deepEqual(again.record, before)
  assert.deepEqual(first.record, before, 'the stored record is copied, not changed in place')

  const file = m.a.mergeEvents({}, { races: [{ RaceID: 7, capture: taken }] }, { now: counter() })

  assert.equal(file.changed, true)
  assert.equal(file.file.version, 1)

  const repeat = m.a.mergeEvents(file.file, { races: [{ RaceID: 7, capture: taken }] }, { now: counter() })

  assert.equal(repeat.changed, false)
  assert.deepEqual(repeat.file, file.file)
  assert.equal(m.a.mergeEvents(file.file, { races: [{ RaceID: 7, capture: null }] }).changed, false, 'a race with nothing to capture keeps its record')

  const two = m.a.mergeEvents(file.file, { races: [{ RaceID: 8, capture: capture(m, 1, 5, [ev(2, 'other')]) }] }, { now: counter() })

  assert.deepEqual(Object.keys(two.file.races), ['7', '8'])
  assert.deepEqual(two.file.races[7], file.file.races[7], 'another race\'s capture leaves a race as it was')
  assert.equal(m.a.recordEvents(two.file.races[8]), 1)
})

check('open', 'the read\'s oldest increment and the archive\'s newest are open: the larger count stands and nothing is a conflict, while the same figures elsewhere are', 'unit', ({ m }) => {
  const first = merged(m, null, capture(m, 1, 5, [...many(1, 'a', 2), ev(3, 'y'), ...many(4, 'w', 2), ev(5, 'z')]))
  const next = merged(m, first.record, capture(m, 3, 8, [...many(4, 'w', 2), ...many(5, 'z', 3), ev(6, 'q'), ev(8, 'r')]))

  assert.equal(next.conflicts, 0)
  assert.equal(next.added, 2)
  assert.equal(next.amended, 2)
  assert.equal(countOf(next.record, 3, 'y'), 1, 'the oldest increment of the read was cut by the load: its row stays')
  assert.equal(countOf(next.record, 5, 'z'), 3, 'the archive\'s newest grew')
  assert.equal(countOf(next.record, 1, 'a'), 2, 'before the read\'s window nothing changes')
  assert.equal(next.record.revision, 2)
  assert.deepEqual(next.record.spans, [[100, 900]])
  assert.deepEqual(next.record.conflicts, [])

  const more = merged(m, first.record, capture(m, 3, 8, [...many(3, 'y', 2), ...many(4, 'w', 2), ev(5, 'z')]))

  assert.equal(more.conflicts, 0)
  assert.equal(countOf(more.record, 3, 'y'), 2, 'the larger count of an open increment')

  const fewerNewest = merged(m, first.record, capture(m, 3, 8, [ev(3, 'y'), ...many(4, 'w', 2)]))

  assert.equal(fewerNewest.conflicts, 0)
  assert.equal(countOf(fewerNewest.record, 5, 'z'), 1, 'the archive\'s newest is kept when the read holds none of it')
  assert.equal(fewerNewest.record.revision, 1, 'nothing was added or amended')
  assert.equal(fewerNewest.record.captures.length, 1)

  const closedOldest = merged(m, first.record, capture(m, 2, 8, [...many(4, 'w', 2), ev(5, 'z')]))

  assert.equal(closedOldest.conflicts, 1, 'the increment is the read\'s oldest only when the window starts there')
  assert.equal(closedOldest.record.conflicts[0].reason, 'missing')
  assert.equal(countOf(closedOldest.record, 3, 'y'), 1)

  const grown = merged(m, next.record, capture(m, 3, 9, [...many(4, 'w', 2), ev(5, 'z'), ev(6, 'q'), ev(8, 'r')]))

  assert.equal(grown.conflicts, 1, 'once a newer increment is stored the old newest is closed')
  assert.equal(grown.record.conflicts[0].reason, 'fewer')
  assert.equal(countOf(grown.record, 5, 'z'), 3)
})

check('closed', 'a closed increment the read holds fewer, none or more of records a conflict and keeps the stored rows, and the same contradiction is recorded once', 'unit', ({ m }) => {
  const first = merged(m, null, capture(m, 1, 5, [...many(2, 'g', 3), ev(5, 'z')]))
  const readOf = (count) => capture(m, 1, 6, [...many(2, 'g', count), ev(5, 'z')])

  const fewer = merged(m, first.record, readOf(2))

  assert.equal(fewer.conflicts, 1)
  assert.equal(fewer.added + fewer.amended, 0)
  assert.equal(countOf(fewer.record, 2, 'g'), 3, 'the stored rows are kept')
  assert.equal(fewer.record.conflicts.length, 1)
  assert.deepEqual(fewer.record.conflicts[0].increment, ID(2))
  assert.equal(fewer.record.conflicts[0].reason, 'fewer')
  assert.equal(fewer.record.conflicts[0].stored, 3)
  assert.equal(fewer.record.conflicts[0].read, 2)
  assert.deepEqual(fewer.record.conflicts[0].group, groupOf(first.record, 2, 'g').slice(0, 9))
  assert.equal(fewer.changed, true)
  assert.equal(fewer.record.revision, 1, 'a conflict adds no revision')

  const again = merged(m, fewer.record, readOf(2))

  assert.equal(again.conflicts, 0)
  assert.equal(again.record.conflicts.length, 1, 'the same contradiction is recorded once')
  assert.equal(again.changed, false)

  const fewerStill = merged(m, fewer.record, readOf(1))

  assert.equal(fewerStill.record.conflicts.length, 1, 'a contradiction is told by where and how it is, not by the figures')

  const missing = merged(m, first.record, readOf(0))

  assert.equal(missing.conflicts, 1)
  assert.equal(missing.record.conflicts[0].reason, 'missing')
  assert.equal(missing.record.conflicts[0].read, 0)
  assert.equal(countOf(missing.record, 2, 'g'), 3)
  assert.equal(groupOf(missing.record, 2, 'g').length, 10)

  const more = merged(m, first.record, readOf(4))

  assert.equal(more.conflicts, 1)
  assert.equal(more.record.conflicts[0].reason, 'more')
  assert.equal(countOf(more.record, 2, 'g'), 4, 'the larger count stands')
  assert.equal(merged(m, more.record, readOf(4)).changed, false)

  const extra = merged(m, first.record, capture(m, 1, 6, [...many(2, 'g', 3), ev(2, 'new'), ev(5, 'z')]))

  assert.equal(extra.conflicts, 1, 'a row the archive never held in a closed increment is a contradiction too')
  assert.equal(countOf(extra.record, 2, 'new'), 1)

  assert.equal(merged(m, first.record, readOf(3)).conflicts, 0)
})

check('ledger', 'an increment the read names differently is another timeline\'s: a conflict, the stored rows kept, no row of the other added', 'unit', ({ m }) => {
  const first = merged(m, null, capture(m, 1, 5, [...many(2, 'g', 2), ev(3, 'h'), ev(5, 'z')]))
  const other = (id) => (id === 2 ? [2, 250, 100] : ID(id))
  const none = merged(m, first.record, capture(m, 1, 6, [ev(3, 'h'), ev(5, 'z')], { identityOf: other }))

  assert.equal(none.conflicts, 1)
  assert.equal(none.record.conflicts[0].reason, 'ledger')
  assert.deepEqual(none.record.conflicts[0].increment, ID(2))
  assert.deepEqual(none.record.increments, first.record.increments, 'nothing is changed')

  const rows = merged(m, first.record, capture(m, 1, 6, [...many(2, 'foreign', 3), ev(3, 'h'), ev(5, 'z'), ev(6, 'q')], { identityOf: other }))

  assert.equal(rows.conflicts, 1)
  assert.equal(countOf(rows.record, 2, 'foreign'), 0, 'rows of another timeline\'s increment are not taken')
  assert.equal(countOf(rows.record, 2, 'g'), 2)
  assert.deepEqual(rows.record.increments.find((increment) => increment[0] === 2).slice(0, 3), ID(2))
  assert.equal(rows.added, 1, 'only the increment the archive lacked is added')
  assert.equal(merged(m, rows.record, capture(m, 1, 6, [...many(2, 'foreign', 3), ev(3, 'h'), ev(5, 'z'), ev(6, 'q')], { identityOf: other })).record.conflicts.length, 1)

  const late = merged(m, first.record, capture(m, 2, 6, [ev(2, 'foreign'), ev(3, 'h'), ev(5, 'z')], { identityOf: (id) => (id === 2 ? [2, 500, 100] : ID(id)) }))

  assert.equal(late.conflicts, 1, 'an increment whose stored time falls before the read\'s window is still another one when the read has rows in it')
  assert.equal(countOf(late.record, 2, 'foreign'), 0)

  const length = merged(m, first.record, capture(m, 1, 6, [...many(2, 'g', 2), ev(3, 'h'), ev(5, 'z')], { identityOf: (id) => (id === 3 ? [3, 300, 50] : ID(id)) }))

  assert.equal(length.conflicts, 1, 'the length is part of the identity')
})

check('append', 'increments the archive lacks are added in order, a stretch two captures do not share stays a gap, an interval inside a span with no row is observed to hold none, and the first gap is open at its start', 'unit', ({ m }) => {
  const late = merged(m, null, capture(m, 3, 5, [ev(3, 'c'), ev(5, 'e')]))
  const early = merged(m, late.record, capture(m, 1, 2, [ev(2, 'b')]))

  assert.deepEqual(idsOf(early.record), [2, 3, 5], 'an older capture is inserted in order')
  assert.deepEqual(early.record.spans, [[100, 600]], 'two captures that touch are one span')

  const first = merged(m, null, capture(m, 1, 5, [ev(1, 'a'), ev(3, 'c'), ev(5, 'e')]))

  assert.deepEqual(idsOf(first.record), [1, 3, 5])
  assert.deepEqual(m.a.archiveRows(first.record).map((row) => row.IncrementID), [5, 3, 1])
  assert.ok(first.record.spans.some(([from, to]) => from <= 400 && to >= 500), 'increment 4 lies inside the span and holds none: it was observed')
  assert.equal(first.record.increments.some((increment) => increment[0] === 4), false)
  assert.deepEqual(m.a.gapsOf(first.record), [{ from: null, to: 100 }])

  const apart = merged(m, first.record, capture(m, 8, 9, [ev(9, 'i'), ev(8, 'h')]))

  assert.deepEqual(apart.record.spans, [[100, 600], [800, 1000]])
  assert.deepEqual(m.a.gapsOf(apart.record), [{ from: null, to: 100 }, { from: 600, to: 800 }])
  assert.deepEqual(idsOf(apart.record), [1, 3, 5, 8, 9])
  assert.equal(apart.record.revision, 2)

  const bridged = merged(m, apart.record, capture(m, 5, 9, [ev(5, 'e'), ev(8, 'h'), ev(9, 'i')]))

  assert.deepEqual(bridged.record.spans, [[100, 1000]])
  assert.deepEqual(m.a.gapsOf(bridged.record), [{ from: null, to: 100 }])
  assert.deepEqual(m.a.gapsOf(null), [])
  assert.deepEqual(m.a.gapsOf({ spans: [] }), [])
  assert.deepEqual(m.a.gapsOf({ spans: [[100, 200], [300, 400], [500, 600]] }), [{ from: null, to: 100 }, { from: 200, to: 300 }, { from: 400, to: 500 }])
})

check('rows', 'the archive as rows is one row for each event, newest first: a group of n identical rows gives n rows that carry the group\'s count and fingerprint', 'unit', ({ m }) => {
  const taken = capture(m, 1, 4, [...many(1, 'a', 3), ev(2, 'b'), ...many(3, 'c', 2)])
  const { record } = merged(m, null, taken)
  const rows = m.a.archiveRows(record)

  assert.equal(rows.length, 6)
  assert.equal(rows.length, m.a.recordEvents(record))
  assert.deepEqual(rows.map((row) => row.IncrementID), [3, 3, 2, 1, 1, 1])
  assert.ok(rows.every((row) => row.copies === { 1: 3, 2: 1, 3: 2 }[row.IncrementID]))
  assert.deepEqual(rows.filter((row) => row.IncrementID === 1).map((row) => row.copy), [0, 1, 2])
  assert.equal(new Set(rows.filter((row) => row.IncrementID === 1).map((row) => row.key)).size, 1)
  assert.equal(rows[0].key, m.a.rowFingerprint(ev(3, 'c')))
  assert.equal(rows[0].MessageText, 'c')
  assert.equal(rows[0].Time, 301)
  assert.deepEqual([rows[0].GameTime, rows[0].Length], [300, 100])
  assert.deepEqual(m.a.archiveRows(null), [])
  assert.equal(m.a.recordEvents({ increments: [] }), 0)
})

check('cap', 'a record over the cap loses whole increments, the oldest first, and says from when it holds everything: the spans are clipped to the cut and the conflicts of the dropped increments go', 'unit', ({ m }) => {
  const first = merged(m, null, capture(m, 1, 4, [...many(1, 'a', 3), ...many(2, 'b', 3), ...many(3, 'c', 3), ...many(4, 'd', 3)]))
  const record = { ...first.record, conflicts: [{ at: 1, t: 1, increment: ID(1), reason: 'missing' }, { at: 1, t: 1, increment: ID(2), reason: 'fewer' }, { at: 1, t: 1, increment: ID(3), reason: 'more' }] }

  assert.equal(m.a.recordEvents(record), 12)

  const under = m.a.capRecord(record, 12)

  assert.equal(under.record, record, 'a record within the cap is returned as it is')
  assert.equal(under.dropped, 0)
  assert.equal(under.record.cut, undefined)

  const exact = m.a.capRecord(record, 6)

  assert.equal(exact.dropped, 6)
  assert.deepEqual(idsOf(exact.record), [3, 4], 'the cap is a bound, not a target to go under')
  assert.equal(exact.record.cut, 300)
  assert.deepEqual(exact.record.spans, [[300, 500]])
  assert.deepEqual(exact.record.conflicts.map((conflict) => conflict.increment[0]), [3])

  const wide = m.a.capRecord(record, 7)

  assert.deepEqual(idsOf(wide.record), [3, 4], 'whole increments only: 7 events are 2 increments of 3')
  assert.equal(m.a.recordEvents(wide.record), 6)
  assert.equal(wide.dropped, 6)

  const tight = m.a.capRecord(record, 2)

  assert.deepEqual(idsOf(tight.record), [], 'an increment is never cut in the middle, so nothing is left under a cap smaller than one')
  assert.equal(tight.record.cut, 500)
  assert.deepEqual(tight.record.spans, [])

  const again = m.a.capRecord({ ...exact.record, cut: 450 }, 3)

  assert.equal(again.record.cut, 450)
  assert.equal(m.a.capRecord({ ...exact.record, cut: 350 }, 3).record.cut, 400)
  assert.equal(m.a.capRecord({ ...exact.record, cut: 900 }, 3).record.cut, 900, 'the cut only moves forward')
  assert.deepEqual(first.record.increments.map((increment) => increment[0]), [1, 2, 3, 4], 'the record given is not changed')
})

check('capmerge', 'the cap applies to the merged record of a pass: a cap lowered cuts a record that gained nothing, and a repeated pass at the cap changes nothing', 'unit', ({ m }) => {
  const taken = capture(m, 1, 4, [...many(1, 'a', 3), ...many(2, 'b', 3), ...many(3, 'c', 3), ...many(4, 'd', 3)])
  const all = m.a.mergeEvents({}, { races: [{ RaceID: 7, capture: taken }] }, { cap: 100, now: counter() })

  assert.equal(m.a.recordEvents(all.file.races[7]), 12)

  const lowered = m.a.mergeEvents(all.file, { races: [{ RaceID: 7, capture: taken }] }, { cap: 6, now: counter() })

  assert.equal(lowered.changed, true, 'a record cut is a change')
  assert.deepEqual(idsOf(lowered.file.races[7]), [3, 4])
  assert.equal(lowered.file.races[7].cut, 300)

  const direct = m.a.mergeEvents({}, { races: [{ RaceID: 7, capture: taken }] }, { cap: 6, now: counter() })

  assert.equal(m.a.recordEvents(direct.file.races[7]), 6)
  assert.equal(direct.file.races[7].cut, 300)

  const repeat = m.a.mergeEvents(direct.file, { races: [{ RaceID: 7, capture: taken }] }, { cap: 6, now: counter() })

  assert.equal(repeat.changed, false, 'a save that still holds what was cut must not rewrite the archive at every pass')
  assert.deepEqual(repeat.file, direct.file)
  assert.equal(m.a.eventFileProblem(direct.file), null)
})

check('upto', 'an archive up to a game time keeps the increments that ended by then, clips the spans, keeps only the captures and conflicts of what stays, and drops a race with nothing left', 'unit', ({ m }) => {
  const taken = merged(m, null, capture(m, 1, 4, [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd')], { t: 250 }))
  const later = merged(m, taken.record, capture(m, 1, 6, [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd'), ev(6, 'f')], { t: 700 }))
  const record = { ...later.record, conflicts: [{ at: 1, t: 1, increment: ID(2), reason: 'fewer' }, { at: 1, t: 1, increment: ID(4), reason: 'fewer' }] }
  const file = { version: 1, races: { 7: record, 8: { ...record, increments: [record.increments[3]], spans: [[400, 500]], captures: [], conflicts: [] } } }
  const snapshot = clone(file)
  const cut = m.a.eventsUpTo(file, 300)

  assert.deepEqual(cut.races[7].increments.map((increment) => increment[0]), [1, 2])
  assert.deepEqual(cut.races[7].spans, [[100, 300]])
  assert.deepEqual(cut.races[7].captures.map((entry) => entry.t), [250])
  assert.deepEqual(cut.races[7].conflicts.map((conflict) => conflict.increment[0]), [2])
  assert.equal(cut.races[8], undefined, 'a race with nothing before the time is not in it')
  assert.equal(cut.version, 1)
  assert.deepEqual(file, snapshot, 'the archive given is not changed')
  assert.deepEqual(m.a.eventsUpTo(file, 200).races[7].increments.map((increment) => increment[0]), [1], 'an increment that ends at the time is in')
  assert.deepEqual(m.a.eventsUpTo(file, 199).races[7].increments, [], 'one that ends later is not')
  assert.deepEqual(m.a.eventsUpTo(file, 199).races[7].spans, [[100, 199]])
  assert.deepEqual(m.a.eventsUpTo(file, 100), {})
  assert.deepEqual(m.a.eventsUpTo(file, 0), {})
  assert.deepEqual(m.a.eventsUpTo(file, null), {})
  assert.deepEqual(m.a.eventsUpTo(file, undefined), {})
  assert.deepEqual(m.a.eventsUpTo({}, 500), {})
  assert.deepEqual(m.a.eventsUpTo(null, 500), {})
  assert.deepEqual(m.a.eventsUpTo({ ...file, races: { 7: { ...record, cut: 400 } } }, 300), {}, 'a record cut after the time holds nothing of it')
  assert.equal(m.a.eventsUpTo({ ...file, races: { 7: { ...record, cut: 200 } } }, 300).races[7].cut, 200)
})

const LINEAGE = (m, files) => ({ file: (name) => ({ store: files[name] || {} }), m })

check('lineage', 'a branch with no archive starts from its parent up to the fork, through a parent that has none, and a branch forked at an unknown or earlier time starts empty', 'unit', ({ m }) => {
  const taken = merged(m, null, capture(m, 1, 6, [1, 2, 3, 4, 5, 6].map((id) => ev(id, `e${id}`))))
  const file = { version: 1, races: { 7: taken.record } }
  const io = LINEAGE(m, { [m.a.eventFileName('c', 'b1')]: file })
  const campaign = { id: 'c', branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { t: 300 } }, b3: { id: 'b3', parent: 'b2', fork: { t: 500 } }, b4: { id: 'b4', parent: 'b1', fork: { t: null } }, b7: { id: 'b7', parent: 'b1', fork: { t: 100 } } } }

  assert.equal(m.a.eventFileName('c', 'b2'), 'campaign-c-b2-events')
  assert.deepEqual(idsOf(m.a.eventBase(io, campaign, 'b2').races[7]), [1, 2])
  assert.deepEqual(idsOf(m.a.eventBase(io, campaign, 'b3').races[7]), [1, 2], 'through a parent with no archive the earlier fork bounds it')
  assert.deepEqual(m.a.eventBase(io, campaign, 'b4'), {})
  assert.deepEqual(m.a.eventBase(io, campaign, 'b7'), {}, 'forked before any increment ended')
  assert.equal(m.a.eventBase(io, campaign, 'b1'), file)
  assert.deepEqual(m.a.eventBase(io, campaign, 'unknown'), {})

  const marked = { ...campaign, branches: { ...campaign.branches, b5: { id: 'b5', parent: 'b1', fork: { t: 300 }, eventsSeeded: true }, b6: { id: 'b6', parent: 'b5', fork: { t: 300 } } } }

  assert.deepEqual(m.a.eventBase(io, marked, 'b5'), {}, 'a branch seeded empty stays empty')
  assert.deepEqual(m.a.eventSeed(io, marked, 'b5', 300), {})
  assert.deepEqual(m.a.eventBase(io, marked, 'b6'), {}, 'nothing passes through a branch seeded empty')
  assert.equal(m.a.eventForkFile(io, marked, 'b5'), null)
  assert.deepEqual(idsOf(m.a.eventForkFile(io, marked, 'b2').races[7]), [1, 2], 'a branch that predates the mark is seeded')
  assert.equal(m.a.eventForkFile(io, campaign, 'b1'), null, 'a branch with its own archive is not given another')
  assert.equal(m.a.eventForkFile(io, campaign, 'b4'), null)
  assert.equal(m.a.eventForkFile(io, campaign, 'b7'), null, 'a parent that holds nothing up to the fork gives nothing')
  assert.deepEqual(idsOf(m.a.eventSeed(io, campaign, 'b1', 400).races[7]), [1, 2, 3])
  assert.deepEqual(file.races[7].increments.map((increment) => increment[0]), [1, 2, 3, 4, 5, 6], 'a seed is a copy')
})

check('cleared', 'a branch whose archive was cleared of every race stays empty: it is not seeded from its parent again, a fork of it is not given the parent\'s rows through it, and a cleared file is never replaced by a fork seed', 'unit', ({ m }) => {
  const taken = merged(m, null, capture(m, 1, 3, [ev(1, 'a'), ev(2, 'b'), ev(3, 'c')]))
  const own = { version: 1, races: { 7: taken.record } }
  const cleared = { version: 1, races: {} }
  const files = { [m.a.eventFileName('c', 'b1')]: own, [m.a.eventFileName('c', 'b2')]: cleared }
  const io = LINEAGE(m, files)
  const campaign = { id: 'c', branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { t: 300 } }, b3: { id: 'b3', parent: 'b2', fork: { t: 300 } } } }

  assert.deepEqual(m.a.eventBase(io, campaign, 'b2'), cleared)
  assert.deepEqual(m.a.eventSeed(io, campaign, 'b2', 300), {})
  assert.deepEqual(m.a.eventBase(io, campaign, 'b3'), {})
  assert.equal(m.a.eventForkFile(io, campaign, 'b2'), null)
  assert.equal(m.a.eventForkFile(io, campaign, 'b3'), null)
  assert.deepEqual(idsOf(m.a.eventForkFile(io, { ...campaign, branches: { ...campaign.branches, b4: { id: 'b4', parent: 'b1', fork: { t: 200 } } } }, 'b4').races[7]), [1])
})

check('problem', 'a stored archive this version cannot read is named, and one it can read, an empty one and a missing one are not', 'unit', ({ m }) => {
  const taken = merged(m, null, capture(m, 1, 5, [...many(2, 'a', 2), ev(3, 'b')]))
  const good = { version: 1, races: { 7: taken.record } }
  const bad = (change) => {
    const file = clone(good)

    change(file.races[7], file)

    return m.a.eventFileProblem(file)
  }

  assert.equal(m.a.eventFileProblem(undefined), null)
  assert.equal(m.a.eventFileProblem(null), null)
  assert.equal(m.a.eventFileProblem({}), null)
  assert.equal(m.a.eventFileProblem(good), null)
  assert.equal(m.a.eventFileProblem({ version: 1, races: {} }), null)
  assert.equal(m.a.eventFileProblem({ version: 1, races: { 7: { ...taken.record, cut: 200 } } }), null)
  ;['text', 5, [], [1]].forEach((value) => assert.equal(typeof m.a.eventFileProblem(value), 'string', JSON.stringify(value)))
  assert.equal(typeof m.a.eventFileProblem({ version: 2, races: {} }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1 }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: [] }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: {}, extra: 1 }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: { 0: taken.record } }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: { x: taken.record } }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: { '07': taken.record } }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: { 7: [] } }), 'string')
  assert.equal(typeof m.a.eventFileProblem({ version: 1, races: { 7: null } }), 'string')
  assert.equal(typeof bad((record) => { record.increments = {} }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0] = record.increments[0].slice(0, 3) }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][0] = 'a' }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][1] = null }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][3] = [] }), 'string', 'an increment with no group is not stored')
  assert.equal(typeof bad((record) => { record.increments[0][3][0].pop() }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][3][0][9] = 0 }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][3][0][9] = 1.5 }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][3][0][9] = -1 }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][3][0][2] = 5 }), 'string', 'the message is text')
  assert.equal(typeof bad((record) => { record.increments[0][3][0][0] = 'x' }), 'string')
  assert.equal(typeof bad((record) => { record.increments[0][3][0][3] = undefined }), 'string')
  assert.equal(typeof bad((record) => { record.increments.reverse() }), 'string', 'increments out of order')
  assert.equal(typeof bad((record) => { record.increments[1][0] = record.increments[0][0] }), 'string', 'an increment twice')
  assert.equal(typeof bad((record) => { record.spans = [[5, 1]] }), 'string')
  assert.equal(typeof bad((record) => { record.spans = [[1, 2, 3]] }), 'string')
  assert.equal(typeof bad((record) => { record.spans = 'x' }), 'string')
  assert.equal(typeof bad((record) => { record.revision = -1 }), 'string')
  assert.equal(typeof bad((record) => { record.revision = 1.5 }), 'string')
  assert.equal(typeof bad((record) => { delete record.revision }), 'string')
  assert.equal(typeof bad((record) => { record.captures = {} }), 'string')
  assert.equal(typeof bad((record) => { record.conflicts = null }), 'string')
  assert.equal(typeof bad((record) => { record.cut = 'x' }), 'string')

  assert.equal(m.a.MAX_EVENTS, 100000)
  assert.equal(m.a.MAX_EVENTS, Math.max(...m.a.EVENT_CAPS), 'the largest cap the budget offers')

  const huge = bad((record) => { record.increments[0][3][0][9] = 1e9 })

  assert.match(huge, /holds more events than any cap allows/, 'one group counted a billion times')
  assert.match(huge, /race 7/)

  const totalled = (first) => bad((record) => { record.increments[0][3][0][9] = first; record.increments[1][3][0][9] = 1 })

  assert.equal(totalled(99999), null, 'exactly the largest cap')
  assert.match(totalled(100000), /holds more events than any cap allows/, 'one more than it')
  assert.equal(m.a.recordEvents(clone(good.races[7])), 3)
})

check('tip', 'the open newest increment is the newest the archive observed, an event of the race or not: an increment observed later with none closes the ones before it, the tip advances with a newer capture and never goes back, and a record from before tips falls back to its newest event', 'unit', ({ m }) => {
  const first = merged(m, null, capture(m, 1, 4, [ev(2, 'a')]))

  assert.deepEqual(first.record.tip, ID(4))
  assert.deepEqual(idsOf(first.record), [2])

  const next = merged(m, first.record, capture(m, 1, 4, []))

  assert.equal(next.conflicts, 1, 'the race\'s event in increment 2 is missing from the same ledger with its tip at 4')
  assert.equal(next.record.conflicts[0].reason, 'missing')
  assert.deepEqual(next.record.conflicts[0].increment, ID(2))
  assert.equal(countOf(next.record, 2, 'a'), 1, 'the stored row is kept')

  const legacy = { ...clone(first.record) }

  delete legacy.tip

  const closedLegacy = merged(m, legacy, capture(m, 1, 4, []))

  assert.equal(closedLegacy.conflicts, 1, 'a record with no tip whose newest event ended before the end of what it observed has that increment closed')
  assert.equal(closedLegacy.record.conflicts[0].reason, 'missing')
  assert.deepEqual(closedLegacy.record.tip, ID(4), 'and is given a tip')

  const atEnd = { ...clone(merged(m, null, capture(m, 1, 4, [ev(4, 'a')])).record) }

  delete atEnd.tip

  const old = merged(m, atEnd, capture(m, 1, 4, []))

  assert.equal(old.conflicts, 0, 'a record with no tip whose newest event ends where its observed spans end leaves it open')
  assert.deepEqual(old.record.tip, ID(4), 'and is given one')
  assert.equal(old.changed, true)
  assert.equal(merged(m, old.record, capture(m, 1, 4, [])).conflicts, 0, 'the tip is open')

  const later = merged(m, old.record, capture(m, 1, 5, []))

  assert.equal(later.conflicts, 0)
  assert.equal(merged(m, later.record, capture(m, 1, 5, [])).conflicts, 1, 'once a newer increment is the tip, the increment is closed')

  const tipped = { ...clone(first.record), spans: [[100, 300]] }

  assert.equal(merged(m, tipped, capture(m, 1, 4, [])).conflicts, 1, 'the tip, not the spans, says which increment is open: the newest event ended at 300, the spans stop there, and the tip is increment 4')

  const unspanned = { ...clone(first.record), spans: [] }

  delete unspanned.tip
  assert.equal(merged(m, unspanned, capture(m, 1, 4, [])).conflicts, 0, 'a record with no tip and no span has nothing to say the increment ended, so its newest event stays open')

  const fresh = merged(m, legacy, capture(m, 1, 4, [ev(2, 'a')]))

  assert.equal(fresh.added + fresh.amended + fresh.conflicts, 0)
  assert.equal(fresh.changed, true, 'the tip given to a record is a change')
  assert.equal(merged(m, fresh.record, capture(m, 1, 4, [ev(2, 'a')])).changed, false, 'and is written once')

  const grown = merged(m, first.record, capture(m, 1, 6, [ev(2, 'a'), ev(6, 'f')]))

  assert.deepEqual(grown.record.tip, ID(6))
  assert.equal(grown.conflicts, 0)

  const open = merged(m, grown.record, capture(m, 1, 7, [ev(2, 'a')]))

  assert.equal(open.conflicts, 0, 'the tip, increment 6, is open though the race\'s newest event is in it and the capture is newer')
  assert.equal(countOf(open.record, 6, 'f'), 1)
  assert.deepEqual(open.record.tip, ID(7))

  const older = merged(m, grown.record, capture(m, 1, 5, [ev(2, 'a')]))

  assert.deepEqual(older.record.tip, ID(6), 'an older save does not move the tip back')
  assert.equal(older.conflicts, 0)
  assert.equal(older.changed, false)

  const closed = merged(m, open.record, capture(m, 1, 7, [ev(2, 'a')]))

  assert.equal(closed.conflicts, 1, 'increment 6 is closed once the tip is 7')
  assert.deepEqual(closed.record.conflicts[0].increment, ID(6))
  assert.equal(m.a.eventFileProblem({ version: 1, races: { 7: closed.record } }), null)
})

check('tipupto', 'an archive up to a game time drops a tip that ends after it and keeps one that ends by it, and keeps the failures noted by then', 'unit', ({ m }) => {
  const first = merged(m, null, capture(m, 1, 4, [ev(2, 'a')]))
  const record = m.a.withFailure(m.a.withFailure(first.record, { at: 1, t: 150, reason: 'early' }), { at: 2, t: 900, reason: 'late' })
  const file = { version: 1, races: { 7: record } }

  assert.deepEqual(m.a.eventsUpTo(file, 500).races[7].tip, ID(4), 'a tip that ends at the time is kept')
  assert.equal(m.a.eventsUpTo(file, 499).races[7].tip, undefined)
  assert.equal(m.a.eventsUpTo(file, 300).races[7].tip, undefined)
  assert.deepEqual(m.a.eventsUpTo(file, 300).races[7].failures.map((failure) => failure.reason), ['early'])
  assert.deepEqual(m.a.eventsUpTo(file, 1000).races[7].failures.map((failure) => failure.reason), ['early', 'late'])
  assert.deepEqual(record.tip, ID(4), 'the archive given is not changed')

  const seeded = m.a.eventsUpTo(file, 300).races[7]
  const next = merged(m, seeded, capture(m, 1, 6, []))

  assert.equal(next.conflicts, 0, 'a seed with no tip leaves its newest event open')
  assert.equal(countOf(next.record, 2, 'a'), 1)

  // a fork after the event's increment: the parent observed up to game time 700, the fork is at 500 and its own save holds no such event
  const parent = merged(m, null, capture(m, 1, 6, [ev(2, 'a', { Time: 300 })]))
  const parentFile = { version: 1, races: { 7: parent.record } }
  const forkSeed = m.a.eventsUpTo(parentFile, 500).races[7]

  assert.equal(forkSeed.tip, undefined)
  assert.deepEqual(forkSeed.spans, [[100, 500]])

  const child = merged(m, forkSeed, capture(m, 1, 4, []))

  assert.equal(child.conflicts, 1, 'the event of increment 2 ended at 300, before the 500 the seed observed: it is closed, so its absence in the fork\'s own timeline is a contradiction')
  assert.equal(child.record.conflicts[0].reason, 'missing')
  assert.deepEqual(child.record.conflicts[0].increment, ID(2))
  assert.equal(countOf(child.record, 2, 'a'), 1, 'and the row is kept')

  // the newest event ending where the seed's spans end is still open
  const edge = merged(m, null, capture(m, 1, 6, [ev(4, 'a')]))
  const edgeSeed = m.a.eventsUpTo({ version: 1, races: { 7: edge.record } }, 500).races[7]

  assert.equal(edgeSeed.tip, undefined)
  assert.deepEqual(edgeSeed.spans, [[100, 500]])

  const edgeChild = merged(m, edgeSeed, capture(m, 1, 4, []))

  assert.equal(edgeChild.conflicts, 0, 'the newest event ends at the end of the span: it may still have been joined by later rows')
  assert.equal(countOf(edgeChild.record, 4, 'a'), 1)
})

check('failonly', 'a record that holds nothing but noted failures is kept in the archive up to a game time while one of them is not later than it, and a branch forked then is given it', 'unit', ({ m }) => {
  const record = m.a.withFailure(m.a.withFailure(null, { at: 1, t: 200, reason: 'early' }), { at: 2, t: 900, reason: 'late' })
  const file = { version: 1, races: { 7: record } }

  assert.deepEqual(m.a.eventsUpTo(file, 200).races[7].failures.map((failure) => failure.reason), ['early'], 'a failure at the time is kept')
  assert.deepEqual(m.a.eventsUpTo(file, 1000).races[7].failures.map((failure) => failure.reason), ['early', 'late'])
  assert.deepEqual(m.a.eventsUpTo(file, 199), {}, 'with no failure by the time and nothing else, the race is dropped')
  assert.deepEqual(m.a.eventsUpTo({ version: 1, races: { 7: m.a.withFailure(null, { at: 1, t: 900, reason: 'late' }) } }, 500), {})
  assert.equal(m.a.eventFileProblem(m.a.eventsUpTo(file, 500)), null)

  const io = LINEAGE(m, { [m.a.eventFileName('c', 'b1')]: file })
  const campaign = { id: 'c', branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { t: 500 } }, b3: { id: 'b3', parent: 'b1', fork: { t: 100 } } } }
  const given = m.a.eventForkFile(io, campaign, 'b2')

  assert.ok(given, 'a fork given a parent that noted a failed read by the fork')
  assert.deepEqual(given.races[7].failures.map((failure) => failure.reason), ['early'])
  assert.deepEqual(given.races[7].increments, [])
  assert.equal(m.a.eventForkFile(io, campaign, 'b3'), null, 'a fork before the failure is given nothing')
  assert.deepEqual(m.a.eventBase(io, campaign, 'b2'), given)

  const capped = { ...m.a.withFailure(merged(m, null, capture(m, 1, 5, [...many(2, 'a', 2), ev(3, 'b')])).record, { at: 3, t: 200, reason: 'early' }), cut: 700 }
  const seed = m.a.eventsUpTo({ version: 1, races: { 7: capped } }, 500).races[7]

  assert.equal(m.a.eventFileProblem({ version: 1, races: { 7: capped } }), null)
  assert.deepEqual(seed.failures.map((failure) => failure.reason), ['early'], 'a cut past the time drops the events, not the failure noted before it')
  assert.deepEqual([seed.increments, seed.spans, seed.captures, seed.conflicts, seed.tip, seed.cut], [[], [], [], [], undefined, undefined], 'and nothing of the parent\'s later timeline')
  assert.equal(m.a.eventFileProblem({ version: 1, races: { 7: seed } }), null)
  assert.deepEqual(m.a.eventForkFile(LINEAGE(m, { [m.a.eventFileName('c', 'b1')]: { version: 1, races: { 7: capped } } }), campaign, 'b2').races[7], seed, 'a fork then is given that record')
})

check('failure', 'a failed read is noted in the race\'s record without a row, a span or a tip, the last 50 are kept, and what it leaves is a record this version reads', 'unit', ({ m }) => {
  const none = m.a.withFailure(null, { at: 5, t: 700, reason: 'disk I/O error' })

  assert.deepEqual(none.failures, [{ at: 5, t: 700, reason: 'disk I/O error' }])
  assert.deepEqual(none.increments, [])
  assert.deepEqual(none.spans, [])
  assert.equal(none.tip, undefined)
  assert.equal(none.revision, 0)
  assert.equal(m.a.eventFileProblem({ version: 1, races: { 7: none } }), null)

  const first = merged(m, null, capture(m, 1, 4, [...many(2, 'a', 2), ev(3, 'b')]))
  const before = clone(first.record)
  const noted = m.a.withFailure(first.record, { at: 6, t: 800, reason: 'x' })

  assert.deepEqual(noted.increments, before.increments)
  assert.deepEqual(noted.spans, before.spans)
  assert.deepEqual(noted.tip, before.tip)
  assert.equal(noted.revision, before.revision)
  assert.deepEqual(noted.captures, before.captures)
  assert.deepEqual(noted.conflicts, before.conflicts)
  assert.equal(noted.failures.length, 1)
  assert.deepEqual(first.record, before, 'the record given is not changed')
  assert.equal(typeof m.a.withFailure(first.record, { at: 6, t: 800 }).failures[0].reason, 'string')

  let record = first.record

  for (let index = 1; index <= 55; index++) {
    record = m.a.withFailure(record, { at: index, t: index, reason: 'r' + index })
  }

  assert.equal(record.failures.length, 50)
  assert.equal(record.failures[0].reason, 'r6', 'the oldest go')
  assert.equal(record.failures[49].reason, 'r55')
  assert.deepEqual(record.increments, before.increments)
  assert.equal(m.a.eventFileProblem({ version: 1, races: { 7: record } }), null)

  const later = merged(m, record, capture(m, 1, 5, [...many(2, 'a', 2), ev(3, 'b')]))

  assert.equal(later.record.failures.length, 50, 'a capture keeps the failures')
})

check('shapes', 'a record whose captures, conflicts, failures or tip are not what this version writes is not read: a null entry, a missing count, an unknown reason, a group without its counts, a tip that is not an identity', 'unit', ({ m }) => {
  const taken = merged(m, null, capture(m, 1, 5, [...many(2, 'g', 3), ev(5, 'z')]))
  const contradicted = merged(m, taken.record, capture(m, 1, 6, [...many(2, 'g', 2), ev(5, 'z')]))
  const gone = merged(m, taken.record, capture(m, 1, 6, [ev(5, 'z')]))
  const full = { ...contradicted.record, conflicts: [...contradicted.record.conflicts, ...gone.record.conflicts], failures: [{ at: 1, t: 2, reason: 'x' }] }
  const good = { version: 1, races: { 7: full } }
  const bad = (change) => {
    const file = clone(good)

    change(file.races[7])

    return m.a.eventFileProblem(file)
  }

  assert.equal(full.captures.length, 1)
  assert.equal(full.conflicts[0].reason, 'fewer')
  assert.equal(full.conflicts[1].reason, 'missing')
  assert.equal(m.a.eventFileProblem(good), null)
  assert.equal(bad((record) => { delete record.tip }), null, 'a record written before tips is read')
  assert.equal(bad((record) => { delete record.failures }), null)
  assert.equal(bad((record) => { record.conflicts = [{ at: 1, t: 2, increment: ID(2), reason: 'ledger' }] }), null, 'a ledger conflict has no group')
  ;[
    ['a null capture', (record) => { record.captures = [null] }],
    ['a capture without its counts', (record) => { delete record.captures[0].added }],
    ['a capture with a negative count', (record) => { record.captures[0].rows = -1 }],
    ['a capture whose window is not an identity', (record) => { record.captures[0].from = [1, 2] }],
    ['a capture with no time', (record) => { delete record.captures[0].t }],
    ['a null conflict', (record) => { record.conflicts = [null] }],
    ['a conflict with an unknown reason', (record) => { record.conflicts[0].reason = 'other' }],
    ['a conflict with no reason', (record) => { delete record.conflicts[0].reason }],
    ['a conflict whose increment is not an identity', (record) => { record.conflicts[0].increment = [2] }],
    ['a conflict with a group and no counts', (record) => { delete record.conflicts[0].stored; delete record.conflicts[0].read }],
    ['a conflict with a negative count', (record) => { record.conflicts[0].read = -1 }],
    ['a conflict with a group that is not a group', (record) => { record.conflicts[0].group = [1, 2] }],
    ['a conflict of rows with no group', (record) => { delete record.conflicts[0].group }],
    ['a conflict with no time', (record) => { delete record.conflicts[0].at }],
    ['a null failure', (record) => { record.failures = [null] }],
    ['a failure with no reason', (record) => { record.failures = [{ at: 1, t: 2 }] }],
    ['a failure with no time', (record) => { record.failures = [{ at: 1, reason: 'x' }] }],
    ['failures that are not a list', (record) => { record.failures = {} }],
    ['a tip that is not an identity', (record) => { record.tip = [4] }],
    ['a tip that is text', (record) => { record.tip = 'x' }],
  ].forEach(([name, change]) => assert.equal(typeof bad(change), 'string', name))
})

check('choice', 'the choice is one read-change-write of the settings under campaign.<id>.race.<RaceID>.logArchive, only a campaign and race that chose it keep an archive, and the cap is one of the three offered', 'unit', ({ m }) => {
  const store = (inst) => inst.files.get('settings')
  const inst = installation({ seed: { settings: { other: 5, campaign: { c1: { race: { 7: { logPins: { keep: true }, historyColonies: [1] } } } } } } })
  const settings = inst.io.settings

  m.a.saveArchiveChoice(settings, 'c1', 7, true)
  assert.equal(inst.writes.filter(({ name }) => name === 'settings').length, 1, 'one read-change-write')
  assert.equal(store(inst).campaign.c1.race[7].logArchive, true)
  assert.equal(store(inst).other, 5)
  assert.deepEqual(store(inst).campaign.c1.race[7].logPins, { keep: true })
  assert.deepEqual(store(inst).campaign.c1.race[7].historyColonies, [1])
  assert.equal(m.a.archiveOn(store(inst), 'c1', 7), true)
  assert.equal(m.a.archiveOn(store(inst), 'c1', 8), false, 'another race')
  assert.equal(m.a.archiveOn(store(inst), 'c2', 7), false, 'another campaign')
  assert.equal(m.a.archiveOn({}, 'c1', 7), false)
  assert.equal(m.a.archiveOn(null, 'c1', 7), false)
  assert.equal(m.a.archiveOn({ campaign: { c1: { race: { 7: { logArchive: 'true' } } } } }, 'c1', 7), false, 'only true turns it on')
  assert.equal(m.a.archiveOn({ campaign: { c1: { race: { 7: { logArchive: 1 } } } } }, 'c1', 7), false)

  m.a.saveArchiveChoice(settings, 'c2', 9, true)
  assert.equal(m.a.archiveChosen(store(inst)), true)
  assert.equal(m.a.archiveChosen({}), false)
  assert.equal(m.a.archiveChosen({ campaign: { c1: { race: { 7: { logArchive: false } } } } }), false)
  assert.equal(m.a.archiveChosen(null), false)

  const campaigns = { c1: { id: 'c1', gameIds: [141] }, c2: { id: 'c2', gameIds: [141, 200], mergedInto: 'c1' }, c3: { id: 'c3', gameIds: [5] } }
  const wish = m.a.archiveWish(store(inst), campaigns)

  assert.deepEqual(wish, { c1: { gameIds: [141], races: [7] } }, 'a merged campaign and one with no archive are not read')
  assert.equal(m.a.archiveWanted(wish, 141, 7), true)
  assert.equal(m.a.archiveWanted(wish, 141, '7'), true)
  assert.equal(m.a.archiveWanted(wish, 141, 8), false)
  assert.equal(m.a.archiveWanted(wish, 5, 7), false, 'the game is not the campaign\'s')
  assert.equal(m.a.archiveKept(wish, 'c1', 7), true)
  assert.equal(m.a.archiveKept(wish, 'c1', 8), false)
  assert.equal(m.a.archiveKept(wish, 'c2', 7), false)
  assert.equal(m.a.archiveKept({}, 'c1', 7), false)

  m.a.saveArchiveChoice(settings, 'c1', 7, false)
  assert.equal(m.a.archiveOn(store(inst), 'c1', 7), false)
  assert.deepEqual(store(inst).campaign.c1.race[7], { logPins: { keep: true }, historyColonies: [1] }, 'turning it off keeps the race\'s other settings')
  assert.equal(m.a.archiveOn(store(inst), 'c2', 9), true)

  assert.deepEqual([...m.a.EVENT_CAPS], [25000, 50000, 100000])
  assert.equal(m.a.EVENT_CAP, 50000)
  assert.equal(m.a.eventCapOfSettings({ store: {} }), 50000)
  assert.equal(m.a.eventCapOfSettings({ store: { historyEventCap: 100000 } }), 100000)
  assert.equal(m.a.eventCapOfSettings({ store: { historyEventCap: 25000 } }), 25000)
  assert.equal(m.a.eventCapOfSettings({ store: { historyEventCap: 12345 } }), 50000)
  assert.equal(m.a.eventCapOfSettings({ store: { historyEventCap: '100000' } }), 50000)
  assert.equal(m.a.eventCapOfSettings(null), 50000)
})

check('estimate', 'the size shown before the archive is turned on is events x 200 bytes', 'unit', ({ m }) => {
  assert.equal(m.a.EVENT_BYTES, 200)
  assert.equal(m.a.eventEstimate(50000), 10000000)
  assert.equal(m.a.eventEstimate(0), 0)
})

// ---------- pins ----------

const pinOf = (m, store, branch, row, count = 1, extra = {}) => m.p.withPin(store, branch, row, { increment: ID(row.IncrementID), count, names: { type: 'Type', system: 'Sys' }, at: 10, id: `p${store.pins.length + 1}`, ...extra })

check('pin', 'a pin is one pin on a group of identical rows, with its count, found by the fingerprint and kept per branch; a note and a removal reach only their own pin; stored pins that cannot be read are not taken', 'unit', ({ m }) => {
  const empty = m.p.emptyPins()
  const row = ev(3, 'x')
  const one = pinOf(m, empty, 'b1', row, 2)

  assert.equal(one.pins.length, 1)
  assert.deepEqual(one.pins[0], { id: 'p1', branch: 'b1', from: 'b1', at: 10, increment: ID(3), fields: m.a.eventFields(row), count: 2, names: { type: 'Type', system: 'Sys', colony: null }, note: '' })
  assert.equal(m.p.pinKey(one.pins[0]), m.a.rowFingerprint(row))
  assert.equal(empty.pins.length, 0, 'the store given is not changed')

  const again = m.p.withPin(one, 'b1', { ...row, rowid: 777 }, { increment: ID(3), count: 2, names: {}, at: 11, id: 'other' })

  assert.equal(again, one, 'a group already pinned is left as it is')
  assert.equal(pinOf(m, one, 'b1', many(3, 'x', 1)[0]).pins.length, 1)
  assert.equal(m.p.pinOfRow(one, 'b1', row).id, 'p1')
  assert.equal(m.p.pinOfRow(one, 'b2', row), null, 'another branch holds no such pin')
  assert.equal(m.p.pinOfRow(one, 'b1', ev(3, 'y')), null)
  assert.equal(m.p.pinOfRow(one, 'b1', ev(4, 'x', { Time: 301 })), null, 'the same event in another increment is another')

  const two = pinOf(m, one, 'b1', ev(3, 'y'))
  const onB2 = m.p.withPin(two, 'b2', row, { increment: ID(3), count: 2, names: {}, at: 12, id: 'p1' })

  assert.equal(two.pins.length, 2)
  assert.equal(onB2.pins.length, 3, 'the same group on another branch is pinned there')
  assert.deepEqual(onB2.pins[2].names, { type: null, system: null, colony: null })

  const newest = m.p.withPin(two, 'b1', ev(9, 'late', { Time: 5000 }), { increment: ID(9), count: 1, names: {}, at: 13, id: 'p9' })

  assert.deepEqual(m.p.pinsOf(newest, 'b1').map((pin) => pin.id), ['p9', 'p1', 'p2'], 'the newest event first')
  assert.equal(m.p.pinsOf(newest, 'b1')[0].id, 'p9')
  assert.equal(m.p.pinsOf(onB2, 'b2').length, 1)

  const noted = m.p.withNote(onB2, 'b1', 'p1', 'watch this')

  assert.equal(noted.pins.find((pin) => pin.branch === 'b1' && pin.id === 'p1').note, 'watch this')
  assert.equal(noted.pins.find((pin) => pin.branch === 'b2' && pin.id === 'p1').note, '', 'the pin of another branch with the same id keeps its note')
  assert.equal(m.p.withNote(noted, 'b1', 'p1', null).pins[0].note, '')

  const removed = m.p.withoutPin(onB2, 'b1', 'p1')

  assert.equal(removed.pins.length, 2)
  assert.ok(removed.pins.some((pin) => pin.branch === 'b2' && pin.id === 'p1'), 'the inherited copy of a pin outlives the removal on its parent')
  assert.equal(m.p.withoutPin(onB2, 'b3', 'p1').pins.length, 3)

  assert.deepEqual(m.p.readPins(undefined), m.p.emptyPins())
  assert.deepEqual(m.p.readPins(null), m.p.emptyPins())
  assert.deepEqual(m.p.readPins(clone(onB2)), clone(onB2))
  assert.equal(m.p.readPins('x'), null)
  assert.equal(m.p.readPins({ version: 2, seeded: {}, pins: [] }), null)
  assert.equal(m.p.readPins({ version: 1, seeded: {} }), null)
  assert.equal(m.p.readPins({ version: 1, seeded: {}, pins: [{ ...clone(one.pins[0]), count: 0 }] }), null)
  assert.equal(m.p.readPins({ version: 1, seeded: {}, pins: [{ ...clone(one.pins[0]), fields: [1] }] }), null)
  assert.equal(m.p.readPins({ version: 1, seeded: {}, pins: [{ ...clone(one.pins[0]), increment: [1, 2] }] }), null)
})

check('limit', 'at most 500 events are pinned on a branch: the next throws PinLimit, another branch and a group already pinned are not held to it, and a removal frees a place', 'unit', ({ m }) => {
  assert.equal(m.p.MAX_PINS, 500)

  let store = m.p.emptyPins()

  for (let index = 0; index < 500; index++) {
    store = m.p.withPin(store, 'b1', ev(index + 1, 'e'), { increment: ID(index + 1), count: 1, names: {}, at: 1, id: `p${index}` })
  }

  assert.equal(store.pins.length, 500)
  assert.throws(() => m.p.withPin(store, 'b1', ev(900, 'e'), { increment: ID(900), count: 1, names: {}, at: 1, id: 'over' }), (error) => error instanceof m.p.PinLimit && error.name === 'PinLimit' && error.limit === 500 && error instanceof Error)
  assert.equal(m.p.withPin(store, 'b1', ev(1, 'e'), { increment: ID(1), count: 1, names: {}, at: 1, id: 'again' }), store, 'a group already pinned is no new pin')
  assert.equal(m.p.withPin(store, 'b2', ev(900, 'e'), { increment: ID(900), count: 1, names: {}, at: 1, id: 'other' }).pins.length, 501)
  assert.equal(m.p.withPin(m.p.withoutPin(store, 'b1', 'p0'), 'b1', ev(900, 'e'), { increment: ID(900), count: 1, names: {}, at: 1, id: 'fits' }).pins.length, 500)
})

check('pinseed', 'a fork inherits the parent\'s pins of events that had ended by the fork, the parent seeded first, once, and nothing is copied without a lineage', 'unit', ({ m }) => {
  let store = m.p.emptyPins()

  ;[[1, 'a'], [3, 'b'], [5, 'c']].forEach(([id, text]) => { store = m.p.withPin(store, 'b1', ev(id, text), { increment: ID(id), count: 1, names: {}, at: 1, id: `p${id}` }) })

  const lineage = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 400 }, b3: { parent: 'b2', t: 600 }, b4: { parent: 'b1', t: null }, b5: { parent: 'b1', t: 399 } }
  const snapshot = clone(store)
  const b2 = m.p.seededPins(store, 'b2', lineage)

  assert.deepEqual(store, snapshot, 'the store given is not changed')
  assert.deepEqual(m.p.pinsOf(b2, 'b2').map((pin) => pin.id).sort(), ['p1', 'p3'], 'the pin on an event that ends at the fork is inherited, a later one is not')
  assert.deepEqual(m.p.pinsOf(b2, 'b2').map((pin) => pin.from), ['b1', 'b1'], 'the copy says where it was made')
  assert.deepEqual(m.p.pinsOf(b2, 'b1').map((pin) => pin.id).sort(), ['p1', 'p3', 'p5'], 'the parent keeps its own')
  assert.deepEqual(b2.seeded, { b1: true, b2: true }, 'the parent is seeded first and both are marked')
  assert.equal(m.p.seededPins(b2, 'b2', lineage), b2, 'a branch is seeded once')

  const own = m.p.withPin(store, 'b2', ev(1, 'a'), { increment: ID(1), count: 1, names: {}, at: 5, id: 'mine' })

  assert.equal(m.p.pinsOf(m.p.seededPins(own, 'b2', lineage), 'b2').filter((pin) => pin.fields[2] === 'a').length, 1, 'a group already pinned on the fork is not pinned twice')

  const b3 = m.p.seededPins(b2, 'b3', lineage)

  assert.deepEqual(m.p.pinsOf(b3, 'b3').map((pin) => pin.id).sort(), ['p1', 'p3'], 'through the fork\'s own pins, not the grandparent\'s later ones')

  const direct = m.p.seededPins(store, 'b3', lineage)

  assert.deepEqual(direct.seeded, { b1: true, b2: true, b3: true }, 'the parent of the parent is seeded first')
  assert.deepEqual(m.p.pinsOf(direct, 'b3').map((pin) => pin.id).sort(), ['p1', 'p3'])
  assert.equal(m.p.pinsOf(m.p.seededPins(store, 'b4', lineage), 'b4').length, 0, 'a fork at an unknown time is given nothing')
  assert.equal(m.p.seededPins(store, 'b4', lineage).seeded.b4, true, 'and is marked')
  assert.deepEqual(m.p.pinsOf(m.p.seededPins(store, 'b5', lineage), 'b5').map((pin) => pin.id), ['p1'], 'one tick before the end of an event the event is not yet in')
  assert.deepEqual(m.p.seededPins(store, 'b1', lineage).seeded, { b1: true })
  assert.equal(m.p.pinsOf(m.p.seededPins(store, 'b1', lineage), 'b1').length, 3, 'a branch with no parent copies nothing')
  assert.equal(m.p.seededPins(store, 'b2', null), store, 'without a lineage nothing is changed, nothing marked')
  assert.equal(m.p.seededPins(store, 'b2', undefined), store)
  assert.equal(m.p.seededPins(store, 'b2', { b1: lineage.b1 }), store, 'a branch the registry does not know is not marked')

  const loop = m.p.seededPins(store, 'b1', { b1: { parent: 'b2', t: 400 }, b2: { parent: 'b1', t: 400 } })

  assert.equal(loop.seeded.b1, true, 'a lineage that loops ends')
})

check('pinstate', 'what a save says of a pin: held, a different count, another timeline\'s increment, gone from the retained log, older or newer than the log, and unread', 'unit', ({ m }) => {
  const pin = pinOf(m, m.p.emptyPins(), 'b1', ev(7, 'x'), 2).pins[0]
  const key = m.p.pinKey(pin)
  const window = windowOf(5, 9)
  const state = (counts, win = window, entry = pin) => m.p.pinState(entry, new Map(counts), win)

  assert.deepEqual(Object.keys(m.p.PIN_STATES), ['held', 'count', 'ledger', 'gone', 'older', 'newer', 'unread'])
  assert.ok(Object.values(m.p.PIN_STATES).every((text) => typeof text === 'string' && text.length > 0))
  const same = (id) => ev(id, 'x', { Time: 701 })
  const counted = (rows) => m.p.pinState(pin, m.a.rowCounts(rows), window)

  assert.equal(counted([same(7), same(7)]), 'held', 'two identical rows are a group of two')
  assert.equal(counted([same(7), same(7), same(5)]), 'held', 'the same fields in another increment are another event')
  assert.equal(counted([same(7)]), 'count')
  assert.equal(counted([same(5), same(5)]), 'gone')
  assert.equal(state([[key, 2]]), 'held')
  assert.equal(state([[key, 1]]), 'count')
  assert.equal(state([[key, 3]]), 'count')
  assert.equal(state([]), 'gone')
  assert.equal(state([[key, 2]], windowOf(5, 9, (id) => (id === 7 ? [7, 705, 100] : ID(id)))), 'ledger', 'the same number is another increment')
  assert.equal(state([[key, 2]], windowOf(5, 9, (id) => (id === 7 ? [7, 700, 50] : ID(id)))), 'ledger', 'the length is part of the identity')
  assert.equal(state([], windowOf(5, 9, (id) => (id === 7 ? [7, 705, 100] : ID(id)))), 'ledger')

  const older = { ...pin, increment: ID(4) }
  const newer = { ...pin, increment: ID(12) }
  const first = { ...pin, increment: ID(5) }

  assert.equal(state([], window, older), 'older')
  assert.equal(state([[m.p.pinKey(older), 2]], window, older), 'older', 'before the log\'s start nothing is held')
  assert.equal(state([], window, first), 'older', 'the oldest increment may have been cut by the load: not gone')
  assert.equal(state([[m.p.pinKey(first), 2]], window, first), 'held')
  assert.equal(state([[m.p.pinKey(first), 1]], window, first), 'count')
  assert.equal(state([], window, newer), 'newer')
  assert.equal(state([[m.p.pinKey(newer), 2]], window, newer), 'newer')
  assert.equal(state([[key, 2]], null), 'unread')
  assert.equal(state([], null), 'unread')
  assert.equal(state([], { first: null, ledger: new Map() }), 'older', 'a log with no row holds nothing, and says nothing of when')
})

// ---------- falryx ----------

const falryxSaves = () => {
  if (!fs.existsSync(FALRYX)) {
    return null
  }

  const all = {}

  fs.readdirSync(FALRYX).filter((name) => /^AuroraDB-\d+\.db$/.test(name)).forEach((name) => { all[name.match(/\d+/)[0].slice(0, 4)] = path.join(FALRYX, name) })

  return ['2713', '2740', '2794', '2810', '2904'].every((key) => all[key]) ? all : null
}

// What the utilities make of one save of the falryx set: the window, the rows the page reads, the capture.
const readOf = async (m, file) => {
  const t = await gameTimeOf(file, FALRYX_GAME)
  const database = databaseOf(file)
  const window = await m.a.readLogWindow(database, FALRYX_GAME)
  const read = await m.a.readRaceEvents(database, { GameID: FALRYX_GAME, RaceID: FALRYX_RACE, t, window })

  assert.equal(read.failed, undefined)

  return { t, window, capture: read.capture, rows: (await database.query(m.a.raceLogSql(FALRYX_GAME, FALRYX_RACE)))[0] }
}

const mergeSaves = (m, reads, { cap = 1e9 } = {}) => {
  let file = {}
  const now = counter()
  const results = reads.map((read) => {
    const result = m.a.mergeEvents(file, { races: [{ RaceID: FALRYX_RACE, capture: read.capture }] }, { cap, now })

    file = result.file

    return result
  })

  return { file, record: file.races[FALRYX_RACE], results }
}

const falryx = async (m) => {
  const saves = falryxSaves()

  if (!saves) {
    return null
  }

  const memo = new Map()
  const read = (key) => {
    if (!memo.has(key)) {
      memo.set(key, readOf(m, saves[key]))
    }

    return memo.get(key)
  }

  return { saves, read, series: (...keys) => Promise.all(keys.map((key) => saveOf(saves[key], FALRYX_GAME, FALRYX_RACE))) }
}

check('window', 'the window of a save the utility reads (the log\'s oldest increment, the ledger from there to the newest) is the one SQL gives', 'falryx', async ({ f, m }) => {
  for (const key of ['2713', '2794', '2904']) {
    const { window } = await f.read(key)
    const own = await ledgerOfSave(f.saves[key], FALRYX_GAME)

    assert.equal(window.first, own.first, key)
    assert.equal(window.ledger.size, own.ledger.size, key)
    assert.deepEqual([...window.ledger.values()], [...own.ledger.values()], key)
  }

  const empty = await m.a.readLogWindow(databaseOf(f.saves['2713']), 999999)

  assert.equal(empty.first, null)
  assert.equal(empty.ledger.size, 0)
})

const reconcile = async (m, f, keys) => {
  const reads = await Promise.all(keys.map((key) => f.read(key)))
  const own = mergeSaves(m, reads)
  const model = modelOf(await f.series(...keys))

  return { reads, ...own, model }
}

const sameAsModel = (record, model) => {
  assert.deepEqual(idsOf(record), [...model.state.keys()].sort((a, b) => a - b), 'the same increments')

  record.increments.forEach((increment) => {
    const own = model.state.get(increment[0])

    assert.deepEqual(increment.slice(0, 3), own.identity)
    assert.equal(increment[3].length, own.groups.size, `groups of ${increment[0]}`)
    assert.equal(increment[3].reduce((sum, group) => sum + group[9], 0), [...own.groups.values()].reduce((a, b) => a + b, 0), `events of ${increment[0]}`)
  })
}

check('recon1', '2713 then 2740 of the first branch reconcile with no conflict, the boundary increments take the larger count, and the events are the multiset union SQL gives', 'falryx', async ({ f, m }) => {
  const r = await reconcile(m, f, ['2713', '2740'])

  assert.equal(r.record.conflicts.length, 0)
  assert.equal(r.model.conflicts.size, 0, 'SQL written here finds no group of a closed increment that changed')
  sameAsModel(r.record, r.model)
  assert.equal(m.a.recordEvents(r.record), eventsOfModel(r.model.state))
  assert.ok(m.a.recordEvents(r.record) >= r.reads[0].capture.rows)
  assert.ok(r.record.spans.length === 1, 'the two windows overlap: one span')
  assert.equal(r.record.revision, 2, 'each save added rows')

  const events = (await groupsOf(f.saves['2713'], FALRYX_GAME, FALRYX_RACE)).rows

  assert.equal(r.reads[0].capture.rows, events)
})

check('recon2', '2794 then 2810 continue exactly: no conflict, and the archive holds the race\'s rows of 2810 and no other', 'falryx', async ({ f, m }) => {
  const r = await reconcile(m, f, ['2794', '2810'])
  const rows = (await groupsOf(f.saves['2810'], FALRYX_GAME, FALRYX_RACE)).rows

  assert.equal(r.record.conflicts.length, 0)
  assert.equal(r.model.conflicts.size, 0)
  assert.equal(m.a.recordEvents(r.record), rows)
  assert.equal(rows, r.reads[1].rows.length, 'the rows the utility read are the rows SQL counts')
  assert.equal(m.a.archiveRows(r.record).length, rows, 'one row for each event, identical ones included')
  sameAsModel(r.record, r.model)
  assert.deepEqual(m.a.rowCounts(r.reads[1].rows), new Map(m.a.archiveRows(r.record).reduce((all, row) => all.set(row.key, row.copies), new Map())), 'every event of 2810 is in the archive with its count')

  const repeat = m.a.mergeEvents(r.file, { races: [{ RaceID: FALRYX_RACE, capture: r.reads[1].capture }] }, { cap: 1e9, now: counter() })

  assert.equal(repeat.changed, false, 'the same save again writes nothing')
  assert.deepEqual(r.record.spans.length, 1)
})

check('forkpair', '2810 then 2904 merged into one archive gives ledger conflicts for the increments the rollback replaced, which is why a fork gets its own archive', 'falryx', async ({ f, m }) => {
  const r = await reconcile(m, f, ['2810', '2904'])
  const [before, after] = await f.series('2810', '2904')
  const windowStart = after.ledger.get(after.first)[1]
  const windowEnd = after.ledger.get(after.last)[1] + after.ledger.get(after.last)[2]
  const replaced = [...before.byInc.keys()].filter((id) => {
    const identity = before.ledger.get(id)
    const now = after.ledger.get(id)

    return now && identity[1] >= windowStart && identity[1] + identity[2] <= windowEnd && !sameIdentity(identity, now)
  })

  assert.ok(replaced.length > 0, 'the data holds increments of 2810 that 2904 names differently')

  const ledger = r.record.conflicts.filter((conflict) => conflict.reason === 'ledger')

  assert.equal(ledger.length, replaced.length)
  assert.deepEqual(ledger.map((conflict) => conflict.increment[0]).sort((a, b) => a - b), replaced.sort((a, b) => a - b))
  assert.ok(ledger.every((conflict) => !sameIdentity(conflict.increment, after.ledger.get(conflict.increment[0]))))
  assert.equal(r.model.conflicts.size >= replaced.length, true)
  assert.deepEqual(new Set([...r.model.conflicts].filter((entry) => entry.includes('|ledger|')).map((entry) => Number(entry.split('|')[0]))), new Set(replaced))
  assert.equal(r.record.conflicts.filter((conflict) => conflict.reason !== 'ledger').length, r.model.conflicts.size - replaced.length)

  ledger.forEach((conflict) => {
    const group = (record, id) => record.increments.find((increment) => increment[0] === id)

    assert.ok(group(r.record, conflict.increment[0]), 'the rows of the replaced increment are kept')
  })
  sameAsModel(r.record, r.model)
})

check('bytes', 'an event costs 148 to 209 bytes of compact JSON in each save, 190.8 in the largest, and the events are the rows SQL counts', 'falryx', async ({ f, m }) => {
  let largest = null

  for (const [key, file] of Object.entries(f.saves)) {
    const { capture } = await f.read(key)
    const { record } = merged(m, null, capture)
    const rows = (await groupsOf(file, FALRYX_GAME, FALRYX_RACE)).rows
    const bytes = JSON.stringify(record.increments).length / rows

    assert.equal(m.a.recordEvents(record), rows, key)
    assert.ok(bytes >= 148 && bytes <= 209, `${key}: ${bytes.toFixed(1)} B an event`)
    assert.ok(Math.abs(bytes * rows - m.a.eventEstimate(rows)) < m.a.eventEstimate(rows) * 0.26, `${key}: the estimate is within a quarter`)

    if (!largest || rows > largest.rows) {
      largest = { rows, bytes }
    }
  }

  assert.equal(largest.rows, 119523)
  assert.ok(Math.abs(largest.bytes - 190.8) < 0.5, `${largest.bytes.toFixed(2)} B an event in the largest`)
})

const matchingRows = (rows) => {
  const byKey = new Map()

  rows.forEach((row) => {
    const key = JSON.stringify([row.IncrementID, row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType, row.SMOnly])

    byKey.set(key, [...(byKey.get(key) || []), row])
  })

  return byKey
}

const ROWID_SQL = (low, high) => `select rowid as rid, IncrementID, ${FIELD_SQL} from FCT_GameLog where GameID = ${FALRYX_GAME} and RaceID = ${FALRYX_RACE} and IncrementID between ${low} and ${high}`

// A pin made on a row of one save and found in another: the state the SQL of the other save gives, written apart from the utility.
const expectedState = async (file, pin) => {
  const [id] = pin.increment
  const { first, ledger } = await ledgerOfSave(file, FALRYX_GAME)

  if (id < first) {
    return 'older'
  }

  const identity = ledger.get(id)

  if (!identity) {
    return 'newer'
  }

  if (identity[1] !== pin.increment[1] || identity[2] !== pin.increment[2]) {
    return 'ledger'
  }

  const where = ['Time', 'EventType', 'MessageText', 'SystemID', 'PopulationID', 'Xcor', 'Ycor', 'IDType', 'SMOnly'].map((field) => `${field} is ?`).join(' and ')
  const [{ n }] = await rowsOf(file, `select count(*) as n from FCT_GameLog where GameID = ${FALRYX_GAME} and RaceID = ${FALRYX_RACE} and IncrementID = ? and ${where}`, [id, ...pin.fields])

  return n === pin.count ? 'held' : n === 0 ? (id === first ? 'older' : 'gone') : 'count'
}

const pinFrom = (m, row, ledger, id = 'pin') => m.p.withPin(m.p.emptyPins(), 'b1', row, { increment: ledger.get(row.IncrementID), count: 1, names: {}, at: 1, id }).pins[0]

const stateIn = async (m, f, key, pin) => {
  const { rows, window } = await f.read(key)

  return m.p.pinState(pin, m.a.rowCounts(rows), window)
}

check('pinsave', 'a pin made on a row of one save is held in the next though its rowid changed, and in the save after a fork it is held before the fork, unresolved (another timeline) after it, and older than the log before it', 'falryx', async ({ f, m }) => {
  // The rowid of a row changes between saves 2713 and 2740: proved by SQL, then a pin made on such a row.
  const early = await rowsOf(f.saves['2713'], ROWID_SQL(358070, 358120))
  const next = matchingRows(await rowsOf(f.saves['2740'], ROWID_SQL(358070, 358120)))
  const moved = early.find((row) => {
    const same = next.get(JSON.stringify([row.IncrementID, row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType, row.SMOnly]))

    return same && same.length === 1 && same[0].rid !== row.rid && matchingRows(early).get(JSON.stringify([row.IncrementID, row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType, row.SMOnly])).length === 1
  })

  assert.ok(moved, 'a row of 2713 that 2740 holds under another rowid')

  const first = await ledgerOfSave(f.saves['2713'], FALRYX_GAME)
  const pinned = pinFrom(m, moved, first.ledger)

  assert.equal(await stateIn(m, f, '2713', pinned), 'held')
  assert.equal(await stateIn(m, f, '2740', pinned), 'held', 'resolved by what the event is, not where it is stored')
  assert.equal(await expectedState(f.saves['2740'], pinned), 'held')

  // 2794 and 2810 keep their rowids; 2904 (after the fork) does not.
  const before = await rowsOf(f.saves['2794'], ROWID_SQL(359300, 359447))
  const afterFork = matchingRows(await rowsOf(f.saves['2904'], ROWID_SQL(359300, 359447)))
  const keyOf = (row) => JSON.stringify([row.IncrementID, row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType, row.SMOnly])
  const own = matchingRows(before)
  const settled = before.find((row) => {
    const there = afterFork.get(keyOf(row))

    return there && there.length === 1 && own.get(keyOf(row)).length === 1 && there[0].rid !== row.rid
  })

  assert.ok(settled, 'a row of 2794 before the fork that 2904 holds under another rowid')

  const middle = (await ledgerOfSave(f.saves['2794'], FALRYX_GAME)).ledger
  const pin = pinFrom(m, settled, middle)

  assert.equal(await stateIn(m, f, '2794', pin), 'held')
  assert.equal(await stateIn(m, f, '2810', pin), 'held')
  assert.equal(await stateIn(m, f, '2904', pin), await expectedState(f.saves['2904'], pin))
  assert.equal(await stateIn(m, f, '2904', pin), 'held', 'before the fork the two timelines are one')

  // A row of 2810 after the fork: the same increment number is another increment in 2904.
  const after = await rowsOf(f.saves['2810'], `${ROWID_SQL(359450, 359460)} limit 1`)
  const old = (await ledgerOfSave(f.saves['2810'], FALRYX_GAME)).ledger
  const replaced = pinFrom(m, after[0], old)

  assert.equal(await stateIn(m, f, '2810', replaced), 'held')
  assert.equal(await expectedState(f.saves['2904'], replaced), 'ledger')
  assert.equal(await stateIn(m, f, '2904', replaced), 'ledger', 'after the fork the pin is unresolved, never shown as the other timeline\'s event')

  // A row of 2794 older than what 2904 retains.
  const [oldest] = await rowsOf(f.saves['2794'], `${ROWID_SQL(358100, 358200)} limit 1`)
  const history = pinFrom(m, oldest, middle)

  assert.equal(await expectedState(f.saves['2904'], history), 'older')
  assert.equal(await stateIn(m, f, '2904', history), 'older')
})

// ---------- passive ----------

const passiveFiles = () => (fs.existsSync(PASSIVE) ? fs.readdirSync(PASSIVE).filter((name) => /^AuroraDB_\d+_day_\d+\.db$/.test(name)).sort().map((name) => path.join(PASSIVE, name)) : null)

const passive = async (m) => {
  const files = passiveFiles()

  if (!files || files.length < 2) {
    return null
  }

  const players = await rowsOf(files[0], `select RaceID from FCT_Race where GameID = ${PASSIVE_GAME} and NPR = 0`)

  assert.equal(players.length, 1, 'one player race')

  const RaceID = players[0].RaceID
  const reads = []
  const saves = []

  for (const file of files) {
    const t = await gameTimeOf(file, PASSIVE_GAME)
    const database = databaseOf(file)
    const window = await m.a.readLogWindow(database, PASSIVE_GAME)
    const read = await m.a.readRaceEvents(database, { GameID: PASSIVE_GAME, RaceID, t, window })

    assert.equal(read.failed, undefined)
    reads.push(read.capture)
    saves.push(await saveOf(file, PASSIVE_GAME, RaceID))
  }

  const now = counter()
  let file = {}
  const results = reads.map((taken) => {
    const result = m.a.mergeEvents(file, { races: [{ RaceID, capture: taken }] }, { now })

    file = result.file

    return result
  })

  return { files, RaceID, reads, saves, file, results, record: file.races[RaceID], model: modelOf(saves) }
}

check('passive', 'the 150 snapshots of the passive campaign merged in order give no conflict, keep the rows the log later dropped, and hold exactly the multiset union SQL gives', 'passive', ({ s, m }) => {
  assert.equal(s.files.length, 150)
  assert.equal(s.record.conflicts.length, 0)
  assert.equal(s.model.conflicts.size, 0, 'SQL written here finds no closed increment that changed in any snapshot')
  sameAsModel(s.record, s.model)
  assert.equal(m.a.recordEvents(s.record), eventsOfModel(s.model.state))

  const lastFirst = s.saves[s.saves.length - 1].first

  assert.ok(Math.min(...idsOf(s.record)) < lastFirst, 'the archive holds increments the last save no longer has')
  assert.ok(m.a.recordEvents(s.record) > s.reads[s.reads.length - 1].rows, 'and so more events than any one save')
  assert.equal(s.record.spans.length, 1, 'the snapshots overlap: no gap')
  assert.equal(m.a.eventFileProblem(s.file), null)

  const repeat = m.a.mergeEvents(s.file, { races: [{ RaceID: s.RaceID, capture: s.reads[s.reads.length - 1] }] }, { now: counter() })

  assert.equal(repeat.changed, false, 'the last snapshot again writes nothing')
})

// ---------- the recorder ----------

const NPR_RACE = 785

// The eight saves in the order of their game time, the order check-colony-series.js drives them in: saves 0, 1 and 3 on the first branch, 4 and 5 on the branch that forks off it, 6 and 7 on two later forks.
const falryxOrder = () => {
  if (!fs.existsSync(FALRYX)) {
    return null
  }

  const files = fs.readdirSync(FALRYX).filter((name) => /^AuroraDB-\d+\.db$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((name) => path.join(FALRYX, name))

  return files.length === 8 ? files : null
}

const recordOf = (m, inst, file, { log, failEvents, isCurrent } = {}) => m.history.recordHistory(databaseOf(file, { log, failEvents }), { storage: inst.io, path: 'C:/saves/' + path.basename(file), now: inst.now, newId: inst.newId, isCurrent })

const turnOn = (m, inst, campaignId, RaceID) => m.a.saveArchiveChoice(inst.io.settings, campaignId, RaceID, true)

const eventStatements = (log) => ({ window: log.filter((sql) => WINDOW_STATEMENT.test(sql)).length, ledger: log.filter((sql) => /^select FCT_Increments\.IncrementID, FCT_Increments\.GameTime, FCT_Increments\.Length from FCT_Increments where .* FCT_Increments\.IncrementID >= /.test(sql)).length, race: log.filter((sql) => RACE_LOG_STATEMENT.test(sql)).length })

// A record against the SQL of a save written apart from the utilities: from increment \`from\` on, the same increments with the ledger's identity and the same groups with the same counts.
const assertSameAsSave = (record, save, from, label) => {
  const mine = record.increments.filter((increment) => increment[0] >= from)
  const theirs = [...save.byInc.keys()].filter((id) => id >= from).sort((a, b) => a - b)

  assert.deepEqual(mine.map((increment) => increment[0]), theirs, label + ': the same increments')
  mine.forEach((increment) => {
    assert.deepEqual(increment.slice(0, 3), save.ledger.get(increment[0]), label + ': the identity of increment ' + increment[0])
    assert.deepEqual([...new Map(increment[3].map((group) => [JSON.stringify(group.slice(0, 9)), group[9]]))].sort(), [...save.byInc.get(increment[0])].sort(), label + ': the groups of increment ' + increment[0])
  })
}

// A record the cap may have cut, against a save: it holds the newest increments of the save from `from` on, exactly, whole increments only; what the cap dropped is the oldest, the cut is the end of the newest dropped increment, and keeping one more would have gone over the cap.
const assertCapped = (m, record, save, cap, label) => {
  const from = record.increments[0][0]
  const ids = [...save.byInc.keys()].sort((a, b) => a - b)
  const dropped = ids.filter((id) => id < from)
  const events = (id) => [...save.byInc.get(id).values()].reduce((a, b) => a + b, 0)

  assertSameAsSave(record, save, from, label)
  assert.ok(m.a.recordEvents(record) <= cap, label + ': ' + m.a.recordEvents(record) + ' events over the cap ' + cap)

  if (!dropped.length) {
    assert.equal(record.cut, undefined, label + ': nothing was cut')

    return
  }

  const last = save.ledger.get(dropped[dropped.length - 1])

  assert.equal(record.cut, last[1] + last[2], label + ': the cut is the end of the newest increment dropped')
  assert.ok(m.a.recordEvents(record) + events(dropped[dropped.length - 1]) > cap, label + ': one more increment would not have fitted')
}

// What a fork is given, written from the rule apart from the utility: the parent's increments that ended by the fork, its spans clipped to it, and nothing at all when the cap had cut the parent after it.
const expectedSeed = (record, t) => {
  if (!record || (typeof record.cut === 'number' && record.cut > t)) {
    return null
  }

  const increments = record.increments.filter((increment) => increment[1] + increment[2] <= t)
  const spans = record.spans.filter(([start]) => start < t).map(([start, end]) => [start, Math.min(end, t)])

  return increments.length || spans.length ? { increments, spans } : null
}

const snapshotCount = (branch) => branch.races[FALRYX_RACE].snapshots.length
const RECORDER_SCHEDULES = ['rthrow', 'rsuperseded']
const recorderSchedules = (only, schedules = RECORDER_SCHEDULES) => schedules.filter((key) => only === null || only.includes(key))

const recorder = async (m, only = null) => {
  const files = falryxOrder()

  if (!files) {
    return null
  }

  const schedules = recorderSchedules(only)

  const result = { files, sql: await Promise.all(files.map((file) => saveOf(file, FALRYX_GAME, FALRYX_RACE))) }
  const inst = installation()

  await recordOf(m, inst, files[0])

  const campaignId = inst.campaignId(FALRYX_GAME)
  const events = (branchId) => inst.events(campaignId, branchId)
  const named = (branchId) => 'file:' + m.a.eventFileName(campaignId, branchId)

  result.campaignId = campaignId
  inst.start = inst.copy()

  // Nothing chosen: the baseline of the statements, the files and the empire file.
  const off = inst.copy()
  const offLog = []

  await recordOf(m, off, files[1], { log: offLog })
  result.off = { log: offLog, names: [...off.files.keys()].filter((name) => name.includes('events')), branch: off.branch(campaignId), writes: off.eventWrites() }

  // The archive turned on: the same save read again, then the next.
  turnOn(m, inst, campaignId, FALRYX_RACE)

  const firstLog = []
  const first = await recordOf(m, inst, files[0], { log: firstLog })

  result.first = { run: first, log: firstLog, events: events('b1'), writes: inst.eventWrites(), order: inst.writes.map(({ name }) => name).filter((name) => name.includes(campaignId + '-b1')) }

  const onLog = []
  const second = await recordOf(m, inst, files[1], { log: onLog })

  result.second = { run: second, log: onLog, events: events('b1'), branch: inst.branch(campaignId), writes: inst.eventWrites() }

  await recordOf(m, inst, files[1])
  await recordOf(m, inst, files[1])
  result.repeat = { writes: inst.eventWrites(), events: events('b1') }

  const restarted = await m.reload()

  await recordOf(restarted, inst, files[1])
  result.restart = { writes: inst.eventWrites(), events: events('b1') }

  await recordOf(m, inst, files[3])
  result.beforeFork = { events: events('b1'), writes: inst.eventWrites() }
  inst.afterB1 = inst.copy()

  // The fork: save 4 is another timeline from the game time its registry entry says.
  const forkWrites = inst.writes.length

  await recordOf(m, inst, files[4])

  const registry = inst.registry().campaigns[campaignId]

  if (process.env.EVENT_DEBUG) {
    const summary = (file) => (file && file.races && file.races[FALRYX_RACE] ? { ids: [file.races[FALRYX_RACE].increments[0] && file.races[FALRYX_RACE].increments[0][0], file.races[FALRYX_RACE].increments.length], spans: file.races[FALRYX_RACE].spans, cut: file.races[FALRYX_RACE].cut, conflicts: file.races[FALRYX_RACE].conflicts.length } : file)

    console.log('DEBUG', JSON.stringify({ fork: Object.fromEntries(Object.entries(registry.branches).map(([k, b]) => [k, [b.parent, b.fork]])), b1: summary(events('b1')), b2: summary(events('b2')), names: [...inst.files.keys()].filter((name) => name.includes('events')) }))
  }

  result.fork = { registry, writes: inst.eventValues(named('b2'), forkWrites), b1: events('b1'), b2: events('b2'), names: [...inst.files.keys()].filter((name) => name.includes('events')) }
  inst.afterFork = inst.copy()

  await recordOf(m, inst, files[5])
  result.continued = { b1: events('b1'), b2: events('b2'), writes: inst.eventWrites() }

  const writes = inst.eventWrites()

  await recordOf(m, inst, files[5])
  result.reconnect = { writes: inst.eventWrites() - writes, b2: events('b2') }

  const chainWrites = inst.writes.length

  await recordOf(m, inst, files[6])
  await recordOf(m, inst, files[7])
  result.chain = { writes: { b3: inst.eventValues(named('b3'), chainWrites), b4: inst.eventValues(named('b4'), chainWrites) }, registry: inst.registry().campaigns[campaignId], b1: events('b1'), b2: events('b2'), b3: events('b3'), b4: events('b4') }

  // The parent's archive cleared after the fork: the fork's own stays.
  const frozen = inst.afterFork.copy()
  const before = frozen.events(campaignId, 'b2')

  frozen.put(named('b1'), { version: 1, races: {} })
  await recordOf(m, frozen, files[4])
  result.frozen = { before, after: frozen.events(campaignId, 'b2') }

  // A fork made while no archive was on: no file, but the branch is marked, and an archive turned on later takes the fork's own rows and not the parent's.
  const late = inst.start.copy()

  await recordOf(m, late, files[1])
  await recordOf(m, late, files[3])
  await recordOf(m, late, files[4])

  const lateRegistry = late.registry().campaigns[campaignId]

  result.late = { registry: lateRegistry, names: [...late.files.keys()].filter((name) => name.includes('events')) }
  turnOn(m, late, campaignId, FALRYX_RACE)
  await recordOf(m, late, files[3])
  await recordOf(m, late, files[4])
  result.late.afterOn = { b1: late.events(campaignId, 'b1'), b2: late.events(campaignId, 'b2'), registry: late.registry().campaigns[campaignId] }

  // A race that is not a player's: chosen, and still not read.
  const npr = inst.start.copy()
  const nprLog = []

  turnOn(m, npr, campaignId, NPR_RACE)
  await recordOf(m, npr, files[1], { log: nprLog })
  result.npr = { statements: eventStatements(nprLog), names: [...npr.files.keys()].filter((name) => name.includes('events')) }

  // A failed read of the log: the empire's file as without an archive, nothing in the archive, nothing failed.
  const failing = inst.start.copy()

  turnOn(m, failing, campaignId, FALRYX_RACE)

  const failedRun = await recordOf(m, failing, files[1], { failEvents: true })

  result.failed = { run: failedRun, names: [...failing.files.keys()].filter((name) => name.includes('events')), branch: failing.branch(campaignId), events: failing.events(campaignId, 'b1'), t: await gameTimeOf(files[1], FALRYX_GAME) }
  await recordOf(m, failing, files[1])
  result.filled = failing.events(campaignId, 'b1')
  await recordOf(m, failing, files[1], { failEvents: true })
  result.erased = failing.events(campaignId, 'b1')

  // An archive this version cannot read: the branch's own file, and the parent's file a fork would be seeded from. Nothing is merged, written or seeded over it, the pass reports stage 'events', and the empire's snapshot is recorded all the same.
  const unreadable = { version: 2, races: { [FALRYX_RACE]: { later: true } } }
  const damaged = inst.afterB1.copy()
  const own = 'file:' + m.a.eventFileName(campaignId, 'b1')

  damaged.put(own, unreadable)

  const damagedRun = await recordOf(m, damaged, files[3])

  result.damaged = { run: damagedRun, file: damaged.files.get(own), writes: damaged.eventWrites(), branch: damaged.branch(campaignId) }

  const orphan = inst.afterB1.copy()

  orphan.put(own, unreadable)

  const orphanWrites = orphan.writes.length
  const orphanRun = await recordOf(m, orphan, files[4])
  const orphanRegistry = orphan.registry().campaigns[campaignId]

  result.orphan = { run: orphanRun, parent: orphan.files.get(own), child: orphan.events(campaignId, 'b2'), eventWrites: orphan.eventWrites(), registry: orphanRegistry, branch: orphan.branch(campaignId, 'b2'), writes: orphan.writes.slice(orphanWrites).map(({ name }) => name) }

  // A store that throws when read (damaged JSON, an I/O error): the same refusal as an archive this version cannot read, and never the pass's outer catch, which would skip the empire's snapshot.
  if (schedules.includes('rthrow')) {
    const record1 = async (inst2, file2, options) => {
      const run = await recordOf(m, inst2, file2, options)

      return { run, branch: inst2.branch(campaignId), eventWrites: inst2.eventWrites() }
    }

    const throwBase = inst.start.copy()

    turnOn(m, throwBase, campaignId, FALRYX_RACE)
    await recordOf(m, throwBase, files[0])

    const throwWhole = throwBase.copy()

    await recordOf(m, throwWhole, files[1])

    const throwOwn = throwBase.copy()

    throwOwn.breakStore(own)

    const ownBefore = throwOwn.eventWrites()
    const ownRun = await record1(throwOwn, files[1])

    result.throwOwn = { run: ownRun.run, snapshots: snapshotCount(ownRun.branch), expected: snapshotCount(throwWhole.branch(campaignId)), events: throwOwn.files.get(own), eventsBefore: throwBase.files.get(own), writes: ownRun.eventWrites - ownBefore }

    const throwTwice = throwBase.copy()

    throwTwice.breakStore(own, 1)

    const twiceRun = await recordOf(m, throwTwice, files[1])

    result.throwTwice = { run: twiceRun, writes: throwTwice.eventWrites(), events: throwTwice.files.get(own), eventsBefore: throwBase.files.get(own) }

    const throwFork = inst.afterB1.copy()

    throwFork.breakStore(own)

    const forkWritesBefore = throwFork.eventWrites()
    const forkRun = await recordOf(m, throwFork, files[4])
    const forkRegistry = throwFork.registry().campaigns[campaignId]

    result.throwFork = { run: forkRun, child: throwFork.events(campaignId, 'b2'), registry: forkRegistry, branch: throwFork.branch(campaignId, 'b2'), writes: throwFork.eventWrites() - forkWritesBefore, colonies: [...throwFork.files.keys()].filter((name) => name.includes('colonies') && name.includes('-b2')) }
    throwFork.mendStore(own)
    await recordOf(m, throwFork, files[4])
    result.throwFork.mended = throwFork.events(campaignId, 'b2')

    const throwOff = inst.start.copy()

    await recordOf(m, throwOff, files[1])
    await recordOf(m, throwOff, files[3])
    throwOff.breakStore(own)

    const offFork = await recordOf(m, throwOff, files[4])

    result.throwOff = { run: offFork, registry: throwOff.registry().campaigns[campaignId], branch: throwOff.branch(campaignId, 'b2'), names: [...throwOff.files.keys()].filter((name) => name.includes('events')) }

    const throwQuiet = inst.start.copy()

    throwQuiet.breakStore(own)
    throwQuiet.breakStore('file:' + m.a.eventFileName(campaignId, 'b2'))
    result.throwQuiet = { run: await recordOf(m, throwQuiet, files[1]), branch: throwQuiet.branch(campaignId) }
  }

  // A failed read on the parent, then a fork: the parent's record holds a noted failure and no rows, and the fork is given it.
  const noted = inst.start.copy()

  turnOn(m, noted, campaignId, FALRYX_RACE)
  await recordOf(m, noted, files[1], { failEvents: true })
  await recordOf(m, noted, files[3], { failEvents: true })

  const notedParent = noted.events(campaignId, 'b1')

  await recordOf(m, noted, files[4])

  const notedRegistry = noted.registry().campaigns[campaignId]

  result.noted = { parent: notedParent, fork: notedRegistry.branches.b2 && notedRegistry.branches.b2.fork, child: noted.events(campaignId, 'b2'), t: await gameTimeOf(files[1], FALRYX_GAME) }

  // A pass replaced at each of its checks. A fault runs this schedule only when it names the supersession check; the unchanged head still runs every schedule.
  if (schedules.includes('rsuperseded')) {
    const base = inst.start.copy()

    turnOn(m, base, campaignId, FALRYX_RACE)
    await recordOf(m, base, files[0])

    const baseEvents = base.events(campaignId, 'b1')
    let guards = 0

    await recordOf(m, base.copy(), files[1], { isCurrent: () => { guards++; return true } })

    let unchangedGuards = 0
    const unchanged = base.copy()

    await recordOf(m, unchanged, files[1])
    await recordOf(m, unchanged, files[1], { isCurrent: () => { unchangedGuards++; return true } })

    const complete = base.copy()

    await recordOf(m, complete, files[1])

    const whole = complete.events(campaignId, 'b1')

    result.superseded = { guards, unchangedGuards, baseEvents, whole, runs: [] }

    for (let allowed = 0; allowed <= guards; allowed++) {
      const run = base.copy()
      let calls = 0

      run.setCut(() => calls > allowed)

      const outcome = await recordOf(m, run, files[1], { isCurrent: () => ++calls <= allowed })

      result.superseded.runs.push({ allowed, superseded: outcome.superseded, afterCut: run.writes.filter(({ cut }) => cut).length, events: run.events(campaignId, 'b1') })
    }
  }

  // The cap in force: 25,000 events held of the two saves of the first branch (20,051 and 17,571 events).
  const capped = inst.start.copy()

  capped.put('settings', { historyEventCap: 25000 })
  turnOn(m, capped, campaignId, FALRYX_RACE)
  await recordOf(m, capped, files[0])
  await recordOf(m, capped, files[1])

  const cappedWrites = capped.eventWrites()
  const cappedEvents = capped.events(campaignId, 'b1')

  await recordOf(m, capped, files[1])
  await recordOf(m, capped, files[0])
  result.capped = { events: cappedEvents, writes: capped.eventWrites() - cappedWrites, after: capped.events(campaignId, 'b1') }

  return result
}

check('rnochoice', 'with no archive on a pass issues no event statement and writes no event file, and the empire file is the one a pass with the archive on writes', 'recorder', ({ r }) => {
  assert.deepEqual(eventStatements(r.off.log), { window: 0, ledger: 0, race: 0 })
  assert.equal(r.off.log.filter((sql) => /FCT_GameLog/.test(sql) && /RaceID = \d+$/.test(sql)).length, 0)
  assert.deepEqual(r.off.names, [])
  assert.equal(r.off.writes, 0)
  assert.equal(JSON.stringify(r.second.branch), JSON.stringify(r.off.branch), 'the archive changes nothing in the empire file')
})

check('rstatements', 'turning a race on adds three statements to a pass (the log\'s first increment, the ledger from there, the race\'s rows), all SELECTs in the one read transaction, and the pass reports no failure', 'recorder', ({ r }) => {
  assert.deepEqual(eventStatements(r.second.log), { window: 1, ledger: 1, race: 1 })
  assert.equal(r.second.log.length - r.off.log.length, 3)
  assert.ok(r.second.log.every((sql) => /^select /i.test(sql)), 'only SELECTs are issued to the save')
  assert.equal(r.second.run.failed.length, 0, String(r.second.run.failed.map((entry) => entry.stage + ': ' + entry.error)))
  assert.equal(r.second.run.superseded, false)
  assert.equal(r.first.run.failed.length, 0)
})

check('rfile', 'the archive is the file of the branch the save settled to, holds the player race and no other, and has what SQL says the save holds: each increment with its identity and counted groups', 'recorder', ({ r, m }) => {
  const record = r.second.events.races[FALRYX_RACE]

  assert.equal(r.first.events.version, 1)
  assert.deepEqual(Object.keys(r.second.events.races), [String(FALRYX_RACE)])
  assert.equal(m.a.eventFileProblem(r.second.events), null)
  assert.equal(m.a.recordEvents(r.first.events.races[FALRYX_RACE]), [...r.sql[0].byInc.values()].reduce((sum, groups) => sum + [...groups.values()].reduce((a, b) => a + b, 0), 0))
  assertSameAsSave(r.first.events.races[FALRYX_RACE], r.sql[0], 0, 'save 0')
  assert.equal(record.conflicts.length, 0)
  assert.deepEqual(record.tip, r.sql[1].ledger.get(r.sql[1].last), 'the tip is the identity of the newest increment of the save')
  assert.equal(record.spans.length, 2, 'the two saves share no increment: two spans')
  assert.deepEqual(m.a.gapsOf(record).length, 2)
  assertSameAsSave({ increments: record.increments.filter((increment) => increment[0] >= r.sql[1].first) }, r.sql[1], r.sql[1].first, 'save 1')
  assert.deepEqual(r.first.order.slice(-2).map((name) => name.replace('file:campaign-' + r.campaignId + '-b1', '')), ['', '-events'], 'the empire file is written first and the archive after it')
})

check('rrepeat', 'reading the same save again, in the same run or after a restart, writes nothing and adds no revision', 'recorder', ({ r }) => {
  assert.equal(r.second.writes, 2)
  assert.equal(r.repeat.writes, 2)
  assert.equal(r.restart.writes, 2)
  assert.deepEqual(r.repeat.events, r.second.events)
  assert.deepEqual(r.restart.events, r.second.events)
})

check('rfork', 'a fork is given its archive in the pass that creates it: the parent\'s increments that ended by the fork and none later, written before the fork\'s own capture, the parent\'s file untouched, the branch marked, and the two never merged', 'recorder', ({ r, m }) => {
  const branch = r.fork.registry.branches.b2
  const child = r.fork.b2.races[FALRYX_RACE]
  const expected = expectedSeed(r.beforeFork.events.races[FALRYX_RACE], branch.fork.t)
  const [seed, merged] = r.fork.writes

  assert.equal(branch.parent, 'b1')
  assert.equal(branch.eventsSeeded, true)
  assert.equal(branch.coloniesSeeded, true)
  assert.equal(r.fork.writes.length, 2, 'the seed, then the first capture')
  assert.deepEqual(r.fork.b1, r.beforeFork.events, 'the parent is as the pass before the fork left it')
  assert.ok(expected && expected.increments.length > 0)
  assert.ok(r.beforeFork.events.races[FALRYX_RACE].increments.some((increment) => increment[1] + increment[2] > branch.fork.t), 'the parent holds increments after the fork')
  assert.deepEqual(seed.races[FALRYX_RACE].increments, expected.increments)
  assert.deepEqual(seed.races[FALRYX_RACE].spans, expected.spans)
  assert.ok(!seed.races[FALRYX_RACE].tip || seed.races[FALRYX_RACE].tip[1] + seed.races[FALRYX_RACE].tip[2] <= branch.fork.t, 'a tip past the fork is the parent\'s')
  assert.equal(Math.max(...seed.races[FALRYX_RACE].increments.map((increment) => increment[1] + increment[2])) <= branch.fork.t, true)
  assert.ok(seed.races[FALRYX_RACE].increments.some((increment) => increment[0] < r.sql[4].first), 'the seed holds what the fork\'s own save no longer has')
  assert.deepEqual(merged, r.fork.b2, 'the last write is the file')
  assertCapped(m, child, r.sql[4], 50000, 'the fork')
  assert.equal(child.conflicts.length, 0)
  assert.ok(r.fork.names.includes('file:campaign-' + r.campaignId + '-b2-events'))
})

check('rcontinue', 'the fork goes on in its own archive: the next save adds to it and matches SQL under the cap, and the first branch keeps what it recorded', 'recorder', ({ r, m }) => {
  const child = r.continued.b2.races[FALRYX_RACE]

  assert.deepEqual(r.continued.b1, r.beforeFork.events)
  assertCapped(m, child, r.sql[5], 50000, 'save 5')
  assert.equal(child.conflicts.length, 0)
  assert.ok(child.cut >= r.fork.b2.races[FALRYX_RACE].cut, 'the cut only moves forward')
  assert.equal(r.reconnect.writes, 0, 'a disconnect and reconnect on an unchanged save writes nothing')
  assert.deepEqual(r.reconnect.b2, r.continued.b2)
})

check('rchain', 'each later fork is given its parent\'s archive up to its own fork (nothing where the parent\'s cap had cut past it), its own capture follows, a branch\'s archive never reaches another\'s, and no archive holds a ledger conflict for the rollback', 'recorder', ({ r, m }) => {
  const { registry } = r.chain
  const record = (name) => (r.chain[name] && r.chain[name].races[FALRYX_RACE]) || { increments: [], conflicts: [] }

  assert.equal(registry.branches.b3.parent, 'b2')
  assert.equal(registry.branches.b4.parent, 'b3')
  assert.deepEqual(r.chain.b1, r.beforeFork.events)
  assert.deepEqual(r.chain.b2, r.continued.b2)
  ;['b3', 'b4'].forEach((branch) => assert.equal(registry.branches[branch].eventsSeeded, true))
  assertCapped(m, record('b3'), r.sql[6], 50000, 'save 6')
  assertCapped(m, record('b4'), r.sql[7], 50000, 'save 7')

  const seed3 = expectedSeed(r.continued.b2.races[FALRYX_RACE], registry.branches.b3.fork.t)
  const seed4 = expectedSeed(r.chain.writes.b3[r.chain.writes.b3.length - 1].races[FALRYX_RACE], registry.branches.b4.fork.t)

  assert.equal(r.chain.writes.b3.length, seed3 ? 2 : 1, 'a seed is written only when the parent holds something up to the fork')
  assert.equal(r.chain.writes.b4.length, seed4 ? 2 : 1)

  if (seed3) {
    assert.deepEqual(r.chain.writes.b3[0].races[FALRYX_RACE].increments, seed3.increments)
  }

  if (seed4) {
    assert.deepEqual(r.chain.writes.b4[0].races[FALRYX_RACE].increments, seed4.increments)
  }

  ;['b1', 'b2', 'b3', 'b4'].forEach((branch) => assert.equal(record(branch).conflicts.length, 0, branch))
})

check('rfrozen', 'a fork\'s archive is frozen when the fork is made: clearing the parent\'s archive afterwards and reading the fork again changes nothing in it', 'recorder', ({ r }) => {
  assert.ok(r.frozen.before.races[FALRYX_RACE].increments.length > 0)
  assert.deepEqual(r.frozen.after, r.frozen.before)
})

check('rlate', 'a fork made while no archive was on gets no archive file but is marked, and an archive turned on afterwards holds only the fork\'s own rows, never the parent\'s past', 'recorder', ({ r, m }) => {
  assert.equal(r.late.registry.branches.b2.parent, 'b1')
  assert.equal(r.late.registry.branches.b2.eventsSeeded, true)
  assert.deepEqual(r.late.names, [])

  const own = r.late.afterOn.b2.races[FALRYX_RACE]

  assert.ok(r.late.afterOn.b1.races[FALRYX_RACE].increments.length > 0, 'the parent holds its own rows by now')
  assert.equal(Math.min(...own.increments.map((increment) => increment[0])) >= r.sql[4].first, true, 'nothing of the parent\'s past in the fork')
  assertCapped(m, own, r.sql[4], 50000, 'the fork alone')
  assert.equal(m.a.eventFileProblem(r.late.afterOn.b2), null)
})

check('rnpr', 'a race that is not a player\'s is not read even when it is chosen, and no file is written for it', 'recorder', ({ r }) => {
  assert.deepEqual(r.npr.statements, { window: 0, ledger: 0, race: 0 })
  assert.deepEqual(r.npr.names, [])
})

check('rfailed', 'a failed read of the log is not a failed pass: the empire\'s file is as without an archive, the race\'s record holds one failure entry (the save\'s game time and the reason) and no row, span or tip, a good read of the same save fills the rows in and keeps the entry, and a later failed read adds an entry and erases nothing', 'recorder', ({ r, m }) => {
  const rows = (record) => ({ increments: record.increments, spans: record.spans, tip: record.tip, revision: record.revision, captures: record.captures, conflicts: record.conflicts, cut: record.cut })
  const failed = r.failed.events.races[FALRYX_RACE]
  const filled = r.filled.races[FALRYX_RACE]
  const erased = r.erased.races[FALRYX_RACE]

  assert.equal(r.failed.run.failed.length, 0)
  assert.ok(r.failed.run.recorded > 0)
  assert.equal(JSON.stringify(r.failed.branch), JSON.stringify(r.off.branch))
  assert.deepEqual(r.failed.names, ['file:campaign-' + r.campaignId + '-b1-events'])
  assert.deepEqual(Object.keys(r.failed.events.races), [String(FALRYX_RACE)])
  assert.equal(failed.failures.length, 1, 'one failure entry')
  assert.equal(failed.failures[0].t, r.failed.t)
  assert.equal(failed.failures[0].reason, 'disk I/O error')
  assert.ok(Number.isFinite(failed.failures[0].at))
  assert.deepEqual(failed.increments, [])
  assert.deepEqual(failed.spans, [])
  assert.equal(failed.tip, undefined)
  assert.equal(failed.revision, 0)
  assert.deepEqual(failed.captures, [])
  assert.equal(m.a.eventFileProblem(r.failed.events), null)
  assertSameAsSave(filled, r.sql[1], 0, 'a good read after a failed one')
  assert.deepEqual(filled.failures, failed.failures, 'the failure stays in the record')
  assert.equal(erased.failures.length, 2)
  assert.deepEqual(erased.failures[0], failed.failures[0])
  assert.equal(erased.failures[1].t, r.failed.t)
  assert.deepEqual(rows(erased), rows(filled), 'a failed read changes no row, span or tip')
  assert.equal(m.a.eventFileProblem(r.erased), null)
})

check('runreadable', 'an archive file this version cannot read is left as it is and reported as a failed pass of stage events: nothing is merged into it, a fork is not seeded from it or marked seeded, and the empire\'s snapshot is recorded', 'recorder', ({ r }) => {
  const stages = (run) => run.failed.map((entry) => entry.stage)
  const unreadable = { version: 2, races: { [FALRYX_RACE]: { later: true } } }

  assert.deepEqual(stages(r.damaged.run), ['events'])
  assert.equal(r.damaged.run.failed[0].GameID, FALRYX_GAME)
  assert.ok(r.damaged.run.failed[0].error instanceof Error)
  assert.ok(r.damaged.run.recorded > 0, 'the empire snapshot is recorded')
  assert.deepEqual(r.damaged.file, unreadable, 'the file is as it was')
  assert.equal(r.damaged.writes, 0)
  assert.equal(r.damaged.branch.races[FALRYX_RACE].snapshots.length, r.second.branch.races[FALRYX_RACE].snapshots.length + 1, 'the empire file holds the new snapshot')

  assert.ok(stages(r.orphan.run).length > 0 && stages(r.orphan.run).every((stage) => stage === 'events'), 'reported as events, at the seed and again at the capture')
  assert.ok(r.orphan.run.recorded > 0)
  assert.deepEqual(r.orphan.parent, unreadable)
  assert.equal(r.orphan.child, undefined, 'no seed and no capture is written for the fork')
  assert.equal(r.orphan.eventWrites, 0)
  assert.equal(r.orphan.registry.branches.b2.parent, 'b1')
  assert.notEqual(r.orphan.registry.branches.b2.eventsSeeded, true, 'the fork is not marked seeded, so it is seeded when the parent is readable')
  assert.equal(r.orphan.registry.branches.b2.coloniesSeeded, true, 'the colonies are seeded all the same')
  assert.ok(r.orphan.branch.races[FALRYX_RACE].snapshots.length > 0, 'the fork\'s empire file is written')
})

check('rthrow', 'an event store that throws when read is an archive this version cannot read: the empire\'s snapshot is still recorded, the pass reports stage events and never write, nothing is written or marked seeded over it, a fork is seeded when the store can be read again, and a pass with the archive off reads no event store unless it forks', 'recorder', ({ r }) => {
  const stages = (run) => run.failed.map((entry) => entry.stage)
  const allEvents = (run) => run.failed.length > 0 && run.failed.every((entry) => entry.stage === 'events')

  assert.deepEqual(stages(r.throwOwn.run), ['events'], 'its own store throws')
  assert.ok(r.throwOwn.run.failed[0].error instanceof Error)
  assert.ok(r.throwOwn.run.recorded > 0, 'the snapshot of the empire is recorded')
  assert.equal(r.throwOwn.snapshots, r.throwOwn.expected, 'and is in the empire file')
  assert.equal(r.throwOwn.writes, 0)
  assert.deepEqual(r.throwOwn.events, r.throwOwn.eventsBefore, 'the archive is as it was')

  assert.ok(allEvents(r.throwTwice.run), 'a store that reads once and then throws is the same refusal, never a failed write: ' + stages(r.throwTwice.run))
  assert.ok(r.throwTwice.run.recorded > 0, 'the snapshot of the empire is recorded')
  assert.equal(r.throwTwice.writes, 0)
  assert.deepEqual(r.throwTwice.events, r.throwTwice.eventsBefore)

  assert.ok(allEvents(r.throwFork.run), 'the parent\'s store throws at a fork: ' + stages(r.throwFork.run))
  assert.ok(r.throwFork.run.recorded > 0, 'the fork\'s empire snapshot is recorded')
  assert.ok(snapshotCount(r.throwFork.branch) > 0, 'in the fork\'s own file')
  assert.equal(r.throwFork.writes, 0, 'no events file is written, seed or capture')
  assert.equal(r.throwFork.child, undefined)
  assert.equal(r.throwFork.registry.branches.b2.coloniesSeeded, true, 'the colonies are seeded all the same')
  assert.notEqual(r.throwFork.registry.branches.b2.eventsSeeded, true, 'the fork is not marked as seeded')

  assert.ok(r.throwFork.mended, 'the next pass with the store readable seeds the fork at its first capture')
  assert.deepEqual(r.throwFork.mended.races[FALRYX_RACE].increments, r.fork.b2.races[FALRYX_RACE].increments, 'with what the fork would have had at once')
  assert.deepEqual(r.throwFork.mended.races[FALRYX_RACE].spans, r.fork.b2.races[FALRYX_RACE].spans)

  assert.ok(allEvents(r.throwOff.run), 'the fork seed is read with the archive off, so the failure is reported there: ' + stages(r.throwOff.run))
  assert.ok(r.throwOff.run.recorded > 0)
  assert.ok(snapshotCount(r.throwOff.branch) > 0)
  assert.notEqual(r.throwOff.registry.branches.b2.eventsSeeded, true)
  assert.equal(r.throwOff.registry.branches.b2.coloniesSeeded, true)
  assert.deepEqual(r.throwOff.names, [])

  assert.deepEqual(r.throwQuiet.run.failed, [], 'a pass with the archive off and no fork never reads an event store')
  assert.ok(r.throwQuiet.run.recorded > 0)
})

check('rnoted', 'a branch forked after a failed read of its parent is given the noted failure: the parent\'s record held no rows, only the failure, and the fork keeps what the parent knew up to the fork', 'recorder', ({ r }) => {
  const parent = r.noted.parent.races[FALRYX_RACE]

  assert.deepEqual(parent.increments, [], 'the parent holds no rows')
  assert.ok(parent.failures.length >= 1)
  assert.ok(r.noted.fork && Number.isFinite(r.noted.fork.t))

  const child = r.noted.child.races[FALRYX_RACE]
  const kept = parent.failures.filter((failure) => failure.t <= r.noted.fork.t)

  assert.ok(kept.length >= 1 && kept.some((failure) => failure.t === r.noted.t), 'the failure at the first save is one the fork inherits')
  assert.deepEqual(child.failures.filter((failure) => failure.t <= r.noted.fork.t), kept, 'the fork holds the parent\'s failures up to the fork')
})

check('rsuperseded', 'a pass replaced at any of its checks writes nothing after that and never half writes the archive: the file is whole as it was or whole as the full pass leaves it, and the archive is written behind one more check than a pass that writes none', 'recorder', ({ r, m }) => {
  const { guards, unchangedGuards, runs, whole, baseEvents } = r.superseded

  assert.ok(guards >= 3, guards + ' checks')
  assert.equal(guards, unchangedGuards + 1, 'the event write is asked about once more than a pass that writes none')
  assert.notDeepEqual(whole, baseEvents)

  runs.forEach((run) => {
    assert.equal(run.afterCut, 0, 'a write after the pass was replaced (allowed ' + run.allowed + ')')
    assert.ok(JSON.stringify(run.events) === JSON.stringify(baseEvents) || JSON.stringify(run.events) === JSON.stringify(whole), 'a whole file (allowed ' + run.allowed + ')')
    assert.equal(m.a.eventFileProblem(run.events), null)
  })

  assert.equal(runs[runs.length - 1].superseded, false)
  assert.ok(runs.slice(0, -1).every((run) => run.superseded === true))
  assert.deepEqual(runs[runs.length - 1].events, whole)
})

check('rcap', 'the cap in the settings cuts the archive of the pass, whole increments from the oldest with the cut recorded, and a save that still holds what was cut, in any order, writes nothing', 'recorder', ({ r, m }) => {
  const record = r.capped.events.races[FALRYX_RACE]

  assert.ok(m.a.recordEvents(record) <= 25000, m.a.recordEvents(record) + ' events')
  assert.ok(m.a.recordEvents(record) > 17000, 'the newest save\'s rows are kept')
  assert.ok(record.cut > 0)
  assert.equal(Math.max(...record.increments.map((increment) => increment[0])), Math.max(...r.sql[1].byInc.keys()))
  assert.equal(m.a.eventFileProblem(r.capped.events), null)
  assert.equal(r.capped.writes, 0)
  assert.deepEqual(r.capped.after, r.capped.events)
})

// ---------- the clear ----------

check('rclear', 'clearing a race\'s history on a branch clears its event archive there, and no other race\'s or branch\'s', 'unit', async ({ m }) => {
  const campaignId = 'clear-events-' + Date.now()
  const record = { increments: [[1, 100, 100, [[1, 1, 'a', null, null, null, null, null, null, 1]]]], spans: [[100, 200]], revision: 1, captures: [], conflicts: [] }

  m.history.eventStore(campaignId, 'b1').store = { version: 1, races: { 7: record, 8: record } }
  m.history.eventStore(campaignId, 'b2').store = { version: 1, races: { 7: record } }

  assert.equal(await m.history.clearRaceHistory({ campaignId, branchId: 'b1', RaceID: 7 }), true)
  assert.deepEqual(Object.keys(m.history.eventStore(campaignId, 'b1').store.races), ['8'])
  assert.deepEqual(Object.keys(m.history.eventStore(campaignId, 'b2').store.races), ['7'])
  assert.equal(await m.history.clearRaceHistory({ campaignId, branchId: 'b1', RaceID: 7 }), false)
  assert.equal(m.a.eventFileProblem(m.history.eventStore(campaignId, 'b1').store), null)
})

check('recorder-schedules', 'the full head keeps both replay schedules and every named recorder check keeps the schedules its assertions read', 'unit', ({ scheduleKeys }) => {
  assert.deepEqual(recorderSchedules(null, scheduleKeys).sort(), ['rsuperseded', 'rthrow'])
  assert.deepEqual(recorderSchedules([], scheduleKeys), [])

  for (const { key } of checks.filter((entry) => entry.needs === 'recorder')) {
    const expected = key === 'rthrow' || key === 'rsuperseded' ? [key] : []

    assert.deepEqual(recorderSchedules([key], scheduleKeys), expected, key)
    assert.deepEqual(recorderSchedules([key], scheduleKeys.slice().reverse()), expected, `${key}, declarations reversed`)
  }

  assert.deepEqual(recorderSchedules(['rthrow', 'rsuperseded'], scheduleKeys).sort(), ['rsuperseded', 'rthrow'])
})

// ---------- the mutations ----------

const MUTATIONS = [
  { name: 'a missing value is kept as 0', file: 'event-archive.js', find: 'const numberOrNull = (value) => (isKnownNumber(value) ? Number(value) : null)', replace: 'const numberOrNull = (value) => (isKnownNumber(value) ? Number(value) : 0)', fails: ['fields', 'counts', 'capture'] },
  { name: 'the fingerprint leaves the increment out', file: 'event-archive.js', find: 'JSON.stringify([Number(IncrementID), ...fields])', replace: 'JSON.stringify([...fields])', fails: ['fields', 'counts', 'pin', 'pinstate'] },
  { name: 'the fingerprint joins the fields as text', file: 'event-archive.js', find: 'JSON.stringify([Number(IncrementID), ...fields])', replace: '[Number(IncrementID), ...fields].join(\'|\')', fails: ['fields'] },
  { name: 'identical rows are counted once', file: 'event-archive.js', find: 'counts.set(key, (counts.get(key) || 0) + 1)', replace: 'counts.set(key, 1)', fails: ['counts', 'recon2', 'pinstate'] },
  { name: 'a capture counts identical rows once', file: 'event-archive.js', find: 'groups.set(key, groups.has(key) ? [groups.get(key)[0], groups.get(key)[1] + 1] : [fields, 1])', replace: 'groups.set(key, [fields, 1])', fails: ['capture', 'rows', 'recon1'] },
  { name: 'a row of an increment the ledger lacks is thrown, not left out', file: 'event-archive.js', find: '      orphans++\n      return', replace: '      orphans++', fails: ['capture'] },
  { name: 'a failed read is thrown', file: 'event-archive.js', find: 'return { failed: error }', replace: 'throw error', fails: ['readfail'] },
  { name: 'the window is read again for each race', file: 'event-archive.js', find: 'const seen = window || (await readLogWindow(database, GameID, options))', replace: 'const seen = await readLogWindow(database, GameID, options)', fails: ['readfail'] },
  { name: 'the window starts after the log\'s oldest increment', file: 'event-archive.js', find: 'FCT_Increments.IncrementID >= $' + '{Number(first)}', replace: 'FCT_Increments.IncrementID > $' + '{Number(first)}', fails: ['window'] },
  { name: 'touching spans are not merged', file: 'event-archive.js', find: 'if (last && start <= last[1]) {', replace: 'if (last && start < last[1]) {', fails: ['span', 'append'] },
  { name: 'a span inside another widens it', file: 'event-archive.js', find: 'last[1] = Math.max(last[1], end)', replace: 'last[1] = end', fails: ['span'] },
  { name: 'a merge always reports a change', file: 'event-archive.js', find: 'changed: Boolean(added || amended || found.length || spansChanged || tipChanged || !stored)', replace: 'changed: true', fails: ['same', 'closed', 'recon2', 'passive', 'rrepeat'] },
  { name: 'the read\'s oldest increment is not open', file: 'event-archive.js', find: 'const openIds = new Set([capture.from[0], newestStored])', replace: 'const openIds = new Set([newestStored])', fails: ['open'] },
  { name: 'the archive\'s newest increment is not open', file: 'event-archive.js', find: 'const openIds = new Set([capture.from[0], newestStored])', replace: 'const openIds = new Set([capture.from[0]])', fails: ['open'] },
  { name: 'every increment is open', file: 'event-archive.js', find: 'const open = openIds.has(id)', replace: 'const open = true', fails: ['open', 'closed'] },
  { name: 'a group the read holds more of keeps the stored count', file: 'event-archive.js', find: 'return [...group.slice(0, EVENT_FIELDS.length), readCount]', replace: 'return group', fails: ['open', 'closed'] },
  { name: 'a group the read holds fewer of is not a conflict', file: 'event-archive.js', find: 'if (readCount < storedCount && !open) {', replace: 'if (false) {', fails: ['closed', 'open'] },
  { name: 'a group the read holds fewer of is lowered to the read', file: 'event-archive.js', find: '      return group\n    })\n\n    // Groups only the read holds', replace: '      return [...group.slice(0, EVENT_FIELDS.length), readCount || storedCount]\n    })\n\n    // Groups only the read holds', fails: ['closed'] },
  { name: 'a row only the read holds in a closed increment is no conflict', file: 'event-archive.js', find: "conflict(increment, 'more', group, 0, group[EVENT_FIELDS.length])", replace: 'void group', fails: ['closed'] },
  { name: 'a changed ledger identity is not a conflict', file: 'event-archive.js', find: 'if (!sameIdentity(capture.ledger.get(id), increment)) {', replace: 'if (false) {', fails: ['ledger', 'forkpair'] },
  { name: 'the rows of another timeline\'s increment are not told', file: 'event-archive.js', find: "if (!sameIdentity(own, increment)) {\n        conflict(own, 'ledger')\n      }", replace: 'void own', fails: ['ledger'] },
  { name: 'a contradiction is recorded at every pass', file: 'event-archive.js', find: 'if (!keys.has(conflictKey(entry))) {', replace: 'if (true) {', fails: ['closed', 'ledger'] },
  { name: 'the spans are the last window only', file: 'event-archive.js', find: 'const spans = windowEnd > windowStart ? withSpan(record.spans, windowStart, windowEnd) : record.spans', replace: 'const spans = [[windowStart, windowEnd]]', fails: ['append', 'open', 'rfile'] },
  { name: 'the rows the cap dropped are added again by a save that still holds them', file: 'event-archive.js', find: '} else if (cut === null || endOf(increment) > cut) {', replace: '} else {', fails: ['capmerge', 'rcap'] },
  { name: 'the window of a capture starts before the cut', file: 'event-archive.js', find: 'const windowStart = cut === null ? capture.from[1] : Math.max(capture.from[1], cut)', replace: 'const windowStart = capture.from[1]', fails: ['capmerge'] },
  { name: 'increments are not kept in order', file: 'event-archive.js', find: 'record.increments.sort((a, b) => a[0] - b[0])', replace: 'void 0', fails: ['append'] },
  { name: 'a revision is not counted', file: 'event-archive.js', find: 'record.revision += 1', replace: 'record.revision += 0', fails: ['same', 'open'] },
  { name: 'the first gap is not told', file: 'event-archive.js', find: 'const gaps = [{ from: null, to: record.spans[0][0] }]', replace: 'const gaps = []', fails: ['append'] },
  { name: 'a gap starts at the wrong end', file: 'event-archive.js', find: 'gaps.push({ from: record.spans[index][1], to: start })', replace: 'gaps.push({ from: record.spans[index][0], to: start })', fails: ['append'] },
  { name: 'a group of n identical rows is one row', file: 'event-archive.js', find: 'for (let copy = 0; copy < copies; copy++) {', replace: 'for (let copy = 0; copy < 1; copy++) {', fails: ['rows', 'recon2'] },
  { name: 'rows are oldest first', file: 'event-archive.js', find: 'rows.sort((a, b) => b.Time - a.Time || b.IncrementID - a.IncrementID)', replace: 'rows.sort((a, b) => a.Time - b.Time || a.IncrementID - b.IncrementID)', fails: ['rows', 'append'] },
  { name: 'events are counted by groups', file: 'event-archive.js', find: 'increment[3].reduce((count, group) => count + group[EVENT_FIELDS.length], 0), 0)', replace: 'increment[3].reduce((count) => count + 1, 0), 0)', fails: ['cap', 'rows', 'bytes', 'recon2'] },
  { name: 'a record at the cap is cut once more', file: 'event-archive.js', find: 'while (total > cap && increments.length) {', replace: 'while (total >= cap && increments.length) {', fails: ['cap'] },
  { name: 'the cap drops the newest increments', file: 'event-archive.js', find: 'const oldest = increments.shift()', replace: 'const oldest = increments.pop()', fails: ['cap', 'capmerge'] },
  { name: 'the cut is the start of the last dropped increment', file: 'event-archive.js', find: 'cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, endOf(oldest))', replace: 'cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, oldest[1])', fails: ['cap', 'capmerge'] },
  { name: 'the cut moves back', file: 'event-archive.js', find: 'cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, endOf(oldest))', replace: 'cut = endOf(oldest)', fails: ['cap'] },
  { name: 'the spans are not clipped to the cut', file: 'event-archive.js', find: 'spans.filter(([, end]) => end > cut).map(([start, end]) => [Math.max(start, cut), end])', replace: 'spans', fails: ['cap'] },
  { name: 'the conflicts of dropped increments stay', file: 'event-archive.js', find: 'conflicts: record.conflicts.filter((conflict) => endOf(conflict.increment) > cut) }, dropped }', replace: 'conflicts: record.conflicts }, dropped }', fails: ['cap'] },
  { name: 'a record cut by a lower cap alone is not written', file: 'event-archive.js', find: 'if (result.changed || dropped) {', replace: 'if (result.changed) {', fails: ['capmerge'] },
  { name: 'the merged record is not cut to the cap', file: 'event-archive.js', find: 'const { record, dropped } = capRecord(result.record, cap)', replace: 'const { record, dropped } = capRecord(result.record, Infinity)', fails: ['capmerge'] },
  { name: 'an archive up to a time takes increments that start by then', file: 'event-archive.js', find: 'const increments = record.increments.filter((increment) => endOf(increment) <= t)', replace: 'const increments = record.increments.filter((increment) => increment[1] <= t)', fails: ['upto', 'lineage', 'cleared', 'rfork'] },
  { name: 'an archive up to a time keeps the spans whole', file: 'event-archive.js', find: 'const spans = record.spans.filter(([start]) => start < t).map(([start, end]) => [start, Math.min(end, t)])', replace: 'const spans = record.spans', fails: ['upto'] },
  { name: 'an archive up to a time keeps every capture', file: 'event-archive.js', find: 'captures: record.captures.filter((capture) => capture.t <= t)', replace: 'captures: record.captures', fails: ['upto'] },
  { name: 'an archive up to a time keeps every conflict', file: 'event-archive.js', find: 'conflicts: record.conflicts.filter((conflict) => endOf(conflict.increment) <= t),', replace: 'conflicts: record.conflicts,', fails: ['upto'] },
  { name: 'a record cut after the time still seeds', file: 'event-archive.js', find: 'if (isKnownNumber(record.cut) && record.cut > t) {', replace: 'if (false) {', fails: ['upto'] },
  { name: 'the open newest increment is the newest event, not the tip', file: 'event-archive.js', find: 'const newestStored = tip ? tip[0] : lastStored', replace: 'const newestStored = false ? 0 : lastStored', fails: ['tip'] },
  { name: 'a record with no tip has no open newest increment', file: 'event-archive.js', find: 'const newestStored = tip ? tip[0] : lastStored && (observedEnd === null || endOf(lastStored) >= observedEnd) ? lastStored[0] : null', replace: 'const newestStored = tip ? tip[0] : null', fails: ['tip', 'tipupto'] },
  { name: 'the tip goes back with an older capture', file: 'event-archive.js', find: 'const nextTip = !tip || capture.to[0] >= tip[0] ? [...capture.to] : tip', replace: 'const nextTip = [...capture.to]', fails: ['tip'] },
  { name: 'the tip never advances', file: 'event-archive.js', find: 'const nextTip = !tip || capture.to[0] >= tip[0] ? [...capture.to] : tip', replace: 'const nextTip = tip || [...capture.to]', fails: ['tip', 'rfile'] },
  { name: 'a tip given to a record is not a change', file: 'event-archive.js', find: 'const tipChanged = !tip || !sameIdentity(nextTip, tip)', replace: 'const tipChanged = false', fails: ['tip'] },
  { name: 'the tip is not stored', file: 'event-archive.js', find: 'record.tip = nextTip', replace: 'void nextTip', fails: ['tip', 'rfile'] },
  { name: 'a tip past the fork is kept in a seed', file: 'event-archive.js', find: 'if (isIdentity(record.tip) && endOf(record.tip) > t) {', replace: 'if (false) {', fails: ['tipupto'] },
  { name: 'a tip that ends at the fork is dropped from a seed', file: 'event-archive.js', find: 'endOf(record.tip) > t) {', replace: 'endOf(record.tip) >= t) {', fails: ['tipupto'] },
  { name: 'an archive up to a time keeps every failure', file: 'event-archive.js', find: 'record.failures.filter((failure) => failure.t <= t)', replace: 'record.failures', fails: ['tipupto'] },
  { name: 'more than 50 failures are kept', file: 'event-archive.js', find: 'const FAILURES_KEPT = 50', replace: 'const FAILURES_KEPT = 51', fails: ['failure'] },
  { name: 'the oldest failures are kept, not the newest', file: 'event-archive.js', find: '.slice(-FAILURES_KEPT)', replace: '.slice(0, FAILURES_KEPT)', fails: ['failure'] },
  { name: 'a failure replaces the failures before it', file: 'event-archive.js', find: 'failures: [...((record && record.failures) || []), {', replace: 'failures: [{', fails: ['failure', 'rfailed'] },
  { name: 'a capture is not a capture the file reads', file: 'event-archive.js', find: '!record.captures.every(isCapture)', replace: 'false', fails: ['shapes'] },
  { name: 'a capture without its counts is read', file: 'event-archive.js', find: '[capture.rows, capture.added, capture.amended, capture.revision].every((count) => Number.isSafeInteger(count) && count >= 0)', replace: 'true', fails: ['shapes'] },
  { name: 'a capture whose window is not an identity is read', file: 'event-archive.js', find: 'isIdentity(capture.from) && isIdentity(capture.to) &&', replace: '', fails: ['shapes'] },
  { name: 'a conflict is not a conflict the file reads', file: 'event-archive.js', find: '!record.conflicts.every(isConflict)', replace: 'false', fails: ['shapes'] },
  { name: 'a conflict with any reason is read', file: 'event-archive.js', find: 'CONFLICT_REASONS.includes(conflict.reason)', replace: 'true', fails: ['shapes'] },
  { name: 'a conflict with a group and no counts is read', file: 'event-archive.js', find: 'Number.isSafeInteger(conflict.stored) && conflict.stored >= 0 && Number.isSafeInteger(conflict.read) && conflict.read >= 0)', replace: 'true)', fails: ['shapes'] },
  { name: 'a conflict of rows with no group is read', file: 'event-archive.js', find: "conflict.group === undefined ? conflict.reason === 'ledger' :", replace: 'conflict.group === undefined ? true :', fails: ['shapes'] },
  { name: 'a failure with no reason is read', file: 'event-archive.js', find: "typeof failure.reason === 'string'", replace: 'true', fails: ['shapes'] },
  { name: 'failures that are not a list are read', file: 'event-archive.js', find: '(record.failures !== undefined && !(Array.isArray(record.failures) && record.failures.every(isFailure)))', replace: 'false', fails: ['shapes'] },
  { name: 'a tip that is not an identity is read', file: 'event-archive.js', find: '(record.tip !== undefined && !isIdentity(record.tip))', replace: 'false', fails: ['shapes'] },
  { name: 'a record with no tip keeps its newest increment open whatever it observed', file: 'event-archive.js', find: '(observedEnd === null || endOf(lastStored) >= observedEnd)', replace: 'true', fails: ['tip', 'tipupto'] },
  { name: 'a record with no tip closes its newest increment unless it ends after what it observed', file: 'event-archive.js', find: 'endOf(lastStored) >= observedEnd)', replace: 'endOf(lastStored) > observedEnd)', fails: ['tip', 'tipupto'] },
  { name: 'a record with no tip and no span closes its newest increment', file: 'event-archive.js', find: '(observedEnd === null || endOf(lastStored) >= observedEnd)', replace: '(observedEnd !== null && endOf(lastStored) >= observedEnd)', fails: ['tip'] },
  { name: 'a record with only noted failures is dropped from an archive up to a time', file: 'event-archive.js', find: '|| (record.failures && record.failures.length)))', replace: '))', fails: ['failonly', 'rnoted'] },
  { name: 'a cut past the fork drops the failures noted before it', file: 'event-archive.js', find: 'return [RaceID, { revision: record.revision, increments: [], spans: [], captures: [], conflicts: [], failures: kept.failures || [] }]', replace: 'return [RaceID, null]', fails: ['failonly'] },
  { name: 'a cut past the fork is carried into the seed', file: 'event-archive.js', find: 'failures: kept.failures || [] }]', replace: 'failures: kept.failures || [], cut: record.cut }]', fails: ['failonly'] },
  { name: 'a record with more events than any cap allows is read', file: 'event-archive.js', find: 'if (recordEvents(record) > MAX_EVENTS) {', replace: 'if (false) {', fails: ['problem'] },
  { name: 'a record with exactly the largest cap is refused', file: 'event-archive.js', find: 'if (recordEvents(record) > MAX_EVENTS) {', replace: 'if (recordEvents(record) >= MAX_EVENTS) {', fails: ['problem'] },
  { name: 'the largest event count is not the largest cap', file: 'event-archive.js', find: 'export const MAX_EVENTS = Math.max(...EVENT_CAPS)', replace: 'export const MAX_EVENTS = Math.min(...EVENT_CAPS)', fails: ['problem'] },
  { name: 'an event store that throws when read escapes the check of the archive', file: 'history.js', find: '  } catch (error) {\n    return `the $' + '{spec.noun} of branch', replace: '  } catch (error) {\n    throw error\n    return `the $' + '{spec.noun} of branch', fails: ['rthrow'] },
  { name: 'an event store that throws when read escapes the read of the archive', file: 'history.js', find: '  } catch (error) {\n    return { problem: ', replace: '  } catch (error) {\n    throw error\n    return { problem: ', fails: ['rthrow'] },
  { name: 'a pass with the archive off checks the event store', file: 'history.js', find: 'if (kept.length) {', replace: 'if (true) {', fails: ['rthrow'] },
  { name: 'a fork is marked as seeded whether or not its parent\'s archive could be read', file: 'history.js', find: 'if (eventsFine) {\n              campaign.branches[resolution.branchId].eventsSeeded = true', replace: 'if (true) {\n              campaign.branches[resolution.branchId].eventsSeeded = true', fails: ['rthrow', 'runreadable'] },
  { name: 'an archive file this version cannot read is merged into', file: 'history.js', find: 'if (base.problem) {\n              failed.push({ GameID, stage: \'events\', error: new Error(base.problem) })\n            } else if', replace: 'if (false) {\n              failed.push({ GameID, stage: \'events\', error: new Error(base.problem) })\n            } else if', fails: ['runreadable'] },
  { name: 'a fork is seeded from an archive this version cannot read', file: 'history.js', find: 'const eventsFine = !seed.problem', replace: 'const eventsFine = true', fails: ['runreadable'] },
  { name: 'a failed read of the log is not noted', file: 'history.js', find: 'file.races[RaceID] = withFailure(', replace: 'void withFailure(', fails: ['rfailed'] },
  { name: 'a failure is stamped with no game time', file: 'history.js', find: '{ at: now(), t: snapshot.t, reason:', replace: '{ at: now(), t: 0, reason:', fails: ['rfailed'] },
  { name: 'a seed through a parent with no archive reaches past the earlier fork', file: 'event-archive.js', find: 'eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t))', replace: 'eventSeed(io, campaign, branch.parent, t)', fails: ['lineage'] },
  { name: 'a seed passes through a parent that has none', file: 'event-archive.js', find: 'eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', replace: '{} : {}', fails: ['lineage'] },
  { name: 'a branch with no file is not seeded', file: 'event-archive.js', find: '? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}', replace: '? {} : {}', fails: ['lineage'] },
  { name: 'a branch seeded empty is seeded from its parent at its first capture', file: 'event-archive.js', find: 'return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}', replace: 'return branch && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}', fails: ['lineage'] },
  { name: 'a branch seeded empty is seeded from its parent through a chain', file: 'event-archive.js', find: 'return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', replace: 'return branch && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', fails: ['lineage'] },
  { name: 'a cleared archive is seeded from its parent again', file: 'event-archive.js', find: 'if (written(stored)) {\n    return stored', replace: 'if (written(stored) && Object.keys(stored.races).length) {\n    return stored', fails: ['cleared'] },
  { name: 'a seed through a cleared branch reaches the parent\'s rows', file: 'event-archive.js', find: 'if (written(file)) {\n    return eventsUpTo(file, t)', replace: 'if (written(file) && Object.keys(file.races).length) {\n    return eventsUpTo(file, t)', fails: ['cleared'] },
  { name: 'a fork is given a file even when its parent holds none', file: 'event-archive.js', find: 'return written(seed) && Object.keys(seed.races).length ? seed : null', replace: 'return seed', fails: ['lineage', 'cleared'] },
  { name: 'a fork is not given the parent\'s archive', file: 'event-archive.js', find: 'return written(seed) && Object.keys(seed.races).length ? seed : null', replace: 'return null', fails: ['lineage', 'rfork'] },
  { name: 'a cleared file is replaced by a fork seed', file: 'event-archive.js', find: 'if (written(io.file(eventFileName(campaign.id, branchId)).store)) {\n    return null\n  }', replace: 'if (false) {\n    return null\n  }', fails: ['lineage'] },
  { name: 'a group of zero rows is a stored group', file: 'event-archive.js', find: 'group[EVENT_FIELDS.length] > 0 && EVENT_FIELDS.every', replace: 'group[EVENT_FIELDS.length] >= 0 && EVENT_FIELDS.every', fails: ['problem'] },
  { name: 'an increment twice is a file this version reads', file: 'event-archive.js', find: 'index && increment[0] <= record.increments[index - 1][0])', replace: 'index && increment[0] < record.increments[index - 1][0])', fails: ['problem'] },
  { name: 'a span that ends before it starts is read', file: 'event-archive.js', find: 'Number.isFinite(span[1]) && span[0] <= span[1])', replace: 'Number.isFinite(span[1]))', fails: ['problem'] },
  { name: 'a file of another version is read', file: 'event-archive.js', find: 'file.version !== EVENT_ARCHIVE_VERSION || ', replace: '', fails: ['problem'] },
  { name: 'a file with other keys is read', file: 'event-archive.js', find: "Object.keys(file).some((key) => !['version', 'races'].includes(key))", replace: 'false', fails: ['problem'] },
  { name: 'a text that is not a message is read', file: 'event-archive.js', find: "field === 'MessageText' ? group[index] === null || typeof group[index] === 'string' : group[index] === null || Number.isFinite(group[index])))\n\nconst isCapture", replace: 'true))\n\nconst isCapture', fails: ['problem'] },
  { name: 'an archive turned on by any value', file: 'event-archive.js', find: 'return Boolean(values && values.logArchive === true)', replace: 'return Boolean(values && values.logArchive)', fails: ['choice'] },
  { name: 'a merged campaign is read', file: 'event-archive.js', find: '.filter((campaign) => !campaign.mergedInto)', replace: '.filter(() => true)', fails: ['choice'] },
  { name: 'a game of another campaign is read', file: 'event-archive.js', find: 'campaign.gameIds.includes(GameID) && campaign.races', replace: 'campaign.races', fails: ['choice'] },
  { name: 'turning it off drops the race\'s other settings', file: 'event-archive.js', find: 'delete race.logArchive', replace: 'delete races[RaceID]', fails: ['choice'] },
  { name: 'the cap is any number the settings hold', file: 'event-archive.js', find: 'return EVENT_CAPS.includes(stored) ? stored : EVENT_CAP', replace: 'return stored || EVENT_CAP', fails: ['choice'] },
  { name: 'events are read whether or not an archive is on', file: 'history.js', find: 'const wanted = races.filter((race) => !toBoolean(race.NPR) && archiveWanted(archive, GameID, race.RaceID))', replace: 'const wanted = races.filter((race) => !toBoolean(race.NPR))', fails: ['rnochoice'] },
  { name: 'a race that is not a player\'s is read when it is chosen', file: 'history.js', find: 'const wanted = races.filter((race) => !toBoolean(race.NPR) && archiveWanted(archive, GameID, race.RaceID))', replace: 'const wanted = races.filter((race) => archiveWanted(archive, GameID, race.RaceID))', fails: ['rnpr'] },
  { name: 'the log window is read again for each race', file: 'history.js', find: 'readRaceEvents(database, { GameID, RaceID: race.RaceID, t, window }, options)', replace: 'readRaceEvents(database, { GameID, RaceID: race.RaceID, t, window: null }, options)', fails: ['rstatements'] },
  { name: 'a failed read of the log window fails the pass', file: 'history.js', find: '    failure = error\n  }', replace: '    throw error\n  }', fails: ['rfailed'] },
  { name: 'the event file is written without asking whether the pass is current', file: 'history.js', find: '                guard()\n                events.store = file', replace: '                events.store = file', fails: ['rsuperseded'] },
  { name: 'a fork is not given its event archive when it is created', file: 'history.js', find: 'if (givenEvents) {', replace: 'if (false) {', fails: ['rfork'] },
  { name: 'a fork is not marked once it was given its event archive', file: 'history.js', find: 'campaign.branches[resolution.branchId].eventsSeeded = true', replace: 'void campaign', fails: ['rfork', 'rlate'] },
  { name: 'a fork is given nothing when it is created', file: 'history.js', find: 'if (resolution.forked) {\n          const registry = readRegistry(storage)', replace: 'if (false) {\n          const registry = readRegistry(storage)', fails: ['rfork', 'rlate'] },
  { name: 'the cap of the settings is not given to the archive', file: 'history.js', find: '{ cap: eventCapOfSettings(storage.settings), now })', replace: '{ now })', fails: ['rcap'] },
  { name: 'a pass merges into an empty archive, not the branch\'s', file: 'history.js', find: 'mergeEvents(base.value, {', replace: 'mergeEvents({}, {', fails: ['rfile', 'rrepeat'] },
  { name: 'clearing a history leaves its event archive', file: 'history.js', find: 'planned(eventStore(campaignId, branchId), eventsFrom),', replace: 'null,', fails: ['rclear'] },
  { name: 'an event is estimated at 256 bytes', file: 'event-archive.js', find: 'export const EVENT_BYTES = 200', replace: 'export const EVENT_BYTES = 256', fails: ['estimate', 'bytes'] },
  { name: 'a group already pinned is pinned again', file: 'event-pins.js', find: 'if (pinOfRow(store, branch, row)) {\n    return store', replace: 'if (false) {\n    return store', fails: ['pin', 'limit'] },
  { name: 'the pin limit is one more', file: 'event-pins.js', find: 'export const MAX_PINS = 500', replace: 'export const MAX_PINS = 501', fails: ['limit'] },
  { name: 'the pin limit is reached one too late', file: 'event-pins.js', find: 'if (pinsOf(store, branch).length >= MAX_PINS) {', replace: 'if (pinsOf(store, branch).length > MAX_PINS) {', fails: ['limit'] },
  { name: 'the limit counts every branch', file: 'event-pins.js', find: 'if (pinsOf(store, branch).length >= MAX_PINS) {', replace: 'if (store.pins.length >= MAX_PINS) {', fails: ['limit'] },
  { name: 'pins are listed oldest first', file: 'event-pins.js', find: 'b.fields[0] - a.fields[0] || b.increment[0] - a.increment[0]', replace: 'a.fields[0] - b.fields[0] || a.increment[0] - b.increment[0]', fails: ['pin'] },
  { name: 'a pin is found on every branch', file: 'event-pins.js', find: 'pin.branch === branch && pinKey(pin) === key', replace: 'pinKey(pin) === key', fails: ['pin'] },
  { name: 'a removal reaches the copy on another branch', file: 'event-pins.js', find: '!(pin.branch === branch && pin.id === id)', replace: 'pin.id !== id', fails: ['pin'] },
  { name: 'a note reaches the copy on another branch', file: 'event-pins.js', find: 'pin.branch === branch && pin.id === id ? { ...pin, note', replace: 'pin.id === id ? { ...pin, note', fails: ['pin'] },
  { name: 'stored pins that cannot be read are taken', file: 'event-pins.js', find: '!value.pins.every(validPin)', replace: 'false', fails: ['pin'] },
  { name: 'a fork inherits the pins of events still running at the fork', file: 'event-pins.js', find: 'pin.increment[1] + pin.increment[2] <= t', replace: 'pin.increment[1] <= t', fails: ['pinseed'] },
  { name: 'a fork inherits every pin of its parent', file: 'event-pins.js', find: 'pin.branch === parent && pin.increment[1] + pin.increment[2] <= t', replace: 'pin.branch === parent', fails: ['pinseed'] },
  { name: 'a pin the fork has is inherited again', file: 'event-pins.js', find: ' && !own.has(pinKey(pin)))', replace: ')', fails: ['pinseed'] },
  { name: 'the parent is not seeded first', file: 'event-pins.js', find: 'next = seededPins(next, parent, lineage, walked)', replace: 'next = next', fails: ['pinseed'] },
  { name: 'a branch is seeded again', file: 'event-pins.js', find: 'if (store.seeded[branch] || !lineage', replace: 'if (!lineage', fails: ['pinseed'] },
  { name: 'a branch the registry does not know is marked', file: 'event-pins.js', find: '|| !lineage[branch] || walked.has(branch)', replace: '|| walked.has(branch)', fails: ['pinseed'] },
  { name: 'a pin is held without asking whether the log was read', file: 'event-pins.js', find: "if (!window) {\n    return 'unread'\n  }", replace: 'if (false) {\n    return null\n  }', fails: ['pinstate'] },
  { name: 'the oldest increment of the log is before it', file: 'event-pins.js', find: 'if (window.first === null || id < window.first) {', replace: 'if (window.first === null || id <= window.first) {', fails: ['pinstate'] },
  { name: 'the length is not part of an increment\'s identity', file: 'event-pins.js', find: 'if (identity[1] !== pin.increment[1] || identity[2] !== pin.increment[2]) {', replace: 'if (identity[1] !== pin.increment[1]) {', fails: ['pinstate'] },
  { name: 'a ledger that differs is not told', file: 'event-pins.js', find: 'if (identity[1] !== pin.increment[1] || identity[2] !== pin.increment[2]) {', replace: 'if (false) {', fails: ['pinstate', 'pinsave'] },
  { name: 'a pin is held at any count above its own', file: 'event-pins.js', find: 'if (held === pin.count) {', replace: 'if (held >= pin.count) {', fails: ['pinstate'] },
  { name: 'an event the save does not hold is gone even in the oldest increment', file: 'event-pins.js', find: "return id === window.first ? 'older' : 'gone'", replace: "return 'gone'", fails: ['pinstate'] },
  { name: 'a different count is told as held', file: 'event-pins.js', find: "  return 'count'\n}", replace: "  return 'held'\n}", fails: ['pinstate'] },
  { name: 'the throwing-store replay is omitted from its named check', schedules: ['rsuperseded'], fails: ['recorder-schedules'] },
  { name: 'the supersession replay is omitted from its named check', schedules: ['rthrow'], fails: ['recorder-schedules'] },
]

// ---------- running ----------

let failures = 0
let total = 0
let number = 0

const show = (label, result, detail = '') => {
  const ok = result === true

  total++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const memo = (work) => {
  let held = null

  return () => {
    held = held || work()

    return held
  }
}

// The context a check runs in for one set of modules; a scenario is run once, on its first use.
const contextOf = (m, only = null, scheduleKeys = RECORDER_SCHEDULES) => {
  const scenarios = { falryx: memo(() => falryx(m)), passive: memo(() => passive(m)), recorder: memo(() => recorder(m, only)) }

  return {
    run: async ({ needs, run }) => {
      const f = needs === 'falryx' ? await scenarios.falryx() : null
      const s = needs === 'passive' ? await scenarios.passive() : null
      const r = needs === 'recorder' ? await scenarios.recorder() : null

      if ((needs === 'falryx' && !f) || (needs === 'passive' && !s) || (needs === 'recorder' && !r)) {
        return 'skip'
      }

      return run({ m, f, s, r, scheduleKeys })
    },
  }
}

const outcomeOf = async (context, entry) => {
  try {
    const outcome = await context.run(entry)

    return outcome === 'skip' ? 'skip' : true
  } catch (error) {
    return String((error && error.stack) || error).split('\n').slice(0, 8).join('\n         ')
  }
}

const planted = (mutation) => plantedCopy(utilitiesDirectory, 'ae-event-archive-mutant-', mutation.file, mutation.find, mutation.replace)

// A mutation judged in this process, as `show` prints it: the result (true, or why it fails) and the detail of a pass.
const judge = async (mutation) => {
  const started = Date.now()
  let directory = null

  try {
    if (!mutation.schedules) {
      directory = planted(mutation)
    }

    const mutant = contextOf(await loadModules(directory || utilitiesDirectory), mutation.fails, mutation.schedules)
    const named = checks.filter((entry) => mutation.fails.includes(entry.key))
    const absent = mutation.fails.filter((key) => !named.some((entry) => entry.key === key))
    const missed = []
    const skipped = []

    for (const entry of named) {
      const outcome = await outcomeOf(mutant, entry)

      if (outcome === 'skip') {
        skipped.push(entry.key)
      } else if (outcome === true) {
        missed.push(entry.key)
      }
    }

    const ran = named.length - skipped.length

    return { result: absent.length ? `no check is keyed ${absent.join(', ')}` : !ran ? `none of the named checks could run (${skipped.join(', ')}), so nothing is shown` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, detail: `${mutation.fails.join(', ')}; ${((Date.now() - started) / 1000).toFixed(1)} s` }
  } catch (error) {
    return { result: `does not load: ${error.message}` }
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

// The mutations run in child processes, several side by side (CHECK_JOBS), each child judging its share one after another the way the whole run once did in one process: every mutation still gets a fresh copy of the modules and fresh scenarios, and a child holds only its own share of module copies in memory. `--mutants=<i>,<i>` is the child's mode; its last line is the list of its verdicts.
const MUTANTS_PREFIX = 'MUTANTS_RESULT '
const CHILD_MUTANTS = process.argv.filter((argument) => argument.startsWith('--mutants=')).map((argument) => argument.slice(10).split(',').map(Number))[0]

const closeHandles = async () => {
  for (const handle of handles.values()) {
    ;(await handle).close()
  }
}

const childMain = async () => {
  const verdicts = []

  for (const index of CHILD_MUTANTS) {
    verdicts.push(await judge(MUTATIONS[index]))
  }

  await closeHandles()
  process.stdout.write(`${MUTANTS_PREFIX}${JSON.stringify(verdicts)}\n`, () => process.exit(0))
}

const main = async () => {
  const began = Date.now()
  const real = await loadModules(utilitiesDirectory)
  const context = contextOf(real)

  if (!falryxSaves()) {
    console.log(`  skip   ${path.relative(root, FALRYX)} is not here, so the falryx group is not run`)
  }

  if (!passiveFiles()) {
    console.log(`  skip   ${path.relative(root, PASSIVE)} is not here, so the passive group is not run`)
  }

  console.log('The event archive')

  for (const entry of checks) {
    number++

    const started = Date.now()
    const outcome = await outcomeOf(context, entry)

    if (outcome === 'skip') {
      console.log(`  skip   ${number}. ${entry.key}: its saves are not here`)
      continue
    }

    show(`${number}. ${entry.key}: ${entry.name}`, outcome, entry.needs === 'unit' ? '' : `${((Date.now() - started) / 1000).toFixed(1)} s`)
  }

  const checksTook = Date.now() - began

  if (!process.argv.includes('--no-mutations')) {
    console.log('\nMutations: each must break the checks it names')

    const chunks = chunksOf(MUTATIONS.length)
    const verdicts = spread(chunks, await inParallel(chunks, async (chunk) => lastJson(await runChild(__filename, [`--mutants=${chunk.join(',')}`]), MUTANTS_PREFIX)))

    MUTATIONS.forEach((mutation, index) => {
      const verdict = verdicts[index]

      if (verdict instanceof Error) {
        show(`mutation caught: ${mutation.name}`, `its process failed: ${verdict.message}`)
      } else {
        show(`mutation caught: ${mutation.name}`, verdict.result, verdict.detail)
      }
    })
  }

  console.log(`\n${total - failures} of ${total} checks passed (${((Date.now() - began) / 1000).toFixed(1)} s, the checks themselves ${(checksTook / 1000).toFixed(1)} s)`)

  await closeHandles()

  process.exit(failures ? 1 : 0)
}

;(CHILD_MUTANTS ? childMain() : main()).catch((error) => {
  console.error(error)
  process.exit(2)
})
