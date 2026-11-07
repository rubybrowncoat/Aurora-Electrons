/*
  Checks the event archive and the pins: the opt-in record of a race's game log, kept per branch, and the durable pins on events (src/renderer/utilities/event-archive.js, event-pins.js and their use in utilities/history.js).

  bun scripts/check-event-archive.js [--no-mutations] [--head-check=<key>[,<key>...]]

  Groups, each check numbered and keyed (a mutation names the keys it must break):
  - rows: how an event is normalised and identified (null against 0, text, the exact fingerprint, the multiset of identical rows), what a capture takes of a read, and the span and count a list of stored rows or a record covers (`logDepth`, `recordDepth`, read from the rows and never an assumed window);
  - merge: the reconciliation of captures (the same capture again, the open oldest and newest increments, a closed increment that contradicts, a ledger that does not match, the spans and their gaps, the cap), the archive as rows, a file that cannot be read;
  - branch: the archive of a fork (up to the fork, through a parent with none, never merged, a seed that stays empty);
  - pins: a pin once per group, the limit, the pins a fork inherits, what a save says of a pin;
  - chain: the real recorder over the played saves (A, B and the two branches from B, C1 and C2 of scripts/lib/fixtures.js, game 161, race 909), read only and skipped where they are not there: the archive each branch settles to against SQL, a repeat that writes nothing, the fork given its archive in the pass that makes it and frozen then, the captures of the two branches merged (a conflict for each increment the rollback replaced), a fork made while no archive was chosen, a failure of the parent's log before the cut, the statements a pass issues, and what each save says of a pin and the pins a fork inherits. The retention cap, an increment that straddles the cut and a pin still running at the fork are not on the chain, so the groups above alone witness them;
  A mutation cannot be credited unless every named check fails by an observed value; no check outside the chain group reads a save.

  Everything runs on in-memory stores (the chain group reads the saves read only). Each mutation of the utilities is planted in an isolated copy (scripts/lib/mutant-source.js) and must break the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const { assert, subjectModule, judged, caughtAll, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { HarnessError } = require('./lib/browser-observe')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating: mayMutate, refusePlanting } = require('./lib/no-mutations')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')
const { GAME, RACE, fileOf, rowsOf, ledgerOf, partingOf, databaseOf, recordSave } = require('./lib/played-chain')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
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

const loadModules = async (directory, sources = {}) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory, sources })

  return { a: subjectModule(loaded['event-archive'], 'event archive'), p: { ...subjectModule(loaded['event-pins'], 'event pins'), PinLimit: loaded['event-pins'].PinLimit }, history: subjectModule(loaded.history, 'history recorder'), raw: loaded, directory, reload: () => loadModules(directory, sources) }
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
  const readError = new Error('disk I/O error')
  const failing = await m.a.readRaceEvents({ query: async (sql) => { log.push(sql); throw readError } }, { GameID: 1, RaceID: 7, t: 5 })

  assert.equal(failing.failed?.message ?? null, 'disk I/O error', 'the archive reports the read failure as a returned value')

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

check('depth', 'a log\'s depth is the earliest and latest stored time and the rows it holds, never an assumed window or load limit: a row with no time still counts, a numeric string is a time, and an empty log has none', 'unit', ({ m }) => {
  assert.equal(m.a.logDepth([]), null)
  assert.equal(m.a.logDepth(null), null)
  assert.deepEqual(m.a.logDepth([ev(1, 'a'), ev(3, 'b'), ev(2, 'c')]), { from: 101, to: 301, count: 3 })
  assert.deepEqual(m.a.logDepth([ev(2, 'a', { Time: '50' }), ev(2, 'b', { Time: null })]), { from: 50, to: 50, count: 2 })
  assert.deepEqual(m.a.logDepth([ev(2, 'a', { Time: null })]), { from: null, to: null, count: 1 })
  assert.deepEqual(m.a.logDepth([{ Time: 0, EventType: 1 }, { Time: -5, EventType: 2 }]), { from: -5, to: 0, count: 2 })
})

check('recorddepth', 'a record\'s depth is the earliest and latest of its stored groups\' times and the events it counts, identical rows one by one, and no record has none', 'unit', ({ m }) => {
  const { record } = merged(m, null, capture(m, 1, 3, [...many(1, 'a', 3), ev(2, 'b'), ev(3, 'c')]))

  assert.deepEqual(m.a.recordDepth(record), { from: 101, to: 301, count: 5 })
  assert.equal(m.a.recordDepth(record).count, m.a.recordEvents(record))
  assert.deepEqual(m.a.recordDepth({ ...record, increments: record.increments.map((increment) => [increment[0], increment[1], increment[2], increment[3].map((group) => [null, ...group.slice(1)])]) }).from, null)
  assert.equal(m.a.recordDepth(null), null)
  assert.equal(m.a.recordDepth({ increments: [] }), null)
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
  const directSeed = m.a.eventBase(io, campaign, 'b2')
  const indirectSeed = m.a.eventBase(io, campaign, 'b3')

  assert.ok(directSeed && directSeed.races && directSeed.races[7], 'a branch with no archive receives its parent race through the fork')
  assert.deepEqual(idsOf(directSeed.races[7]), [1, 2])
  assert.ok(indirectSeed && indirectSeed.races && indirectSeed.races[7], 'a branch receives its ancestor race through a parent with no archive')
  assert.deepEqual(idsOf(indirectSeed.races[7]), [1, 2], 'through a parent with no archive the earlier fork bounds it')
  assert.deepEqual(m.a.eventBase(io, campaign, 'b4'), {})
  assert.deepEqual(m.a.eventBase(io, campaign, 'b7'), {}, 'forked before any increment ended')
  assert.equal(m.a.eventBase(io, campaign, 'b1'), file)
  assert.deepEqual(m.a.eventBase(io, campaign, 'unknown'), {})

  const marked = { ...campaign, branches: { ...campaign.branches, b5: { id: 'b5', parent: 'b1', fork: { t: 300 }, eventsSeeded: true }, b6: { id: 'b6', parent: 'b5', fork: { t: 300 } } } }

  assert.deepEqual(m.a.eventBase(io, marked, 'b5'), {}, 'a branch seeded empty stays empty')
  assert.deepEqual(m.a.eventSeed(io, marked, 'b5', 300), {})
  assert.deepEqual(m.a.eventBase(io, marked, 'b6'), {}, 'nothing passes through a branch seeded empty')
  assert.equal(m.a.eventForkFile(io, marked, 'b5'), null)
  const forkFile = m.a.eventForkFile(io, marked, 'b2')
  assert.ok(forkFile && forkFile.races && forkFile.races[7], 'a branch that predates the mark receives the parent race in its fork archive')
  assert.deepEqual(idsOf(forkFile.races[7]), [1, 2], 'a branch that predates the mark is seeded')
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
  const raceOf = (file, label) => {
    assert.ok(file && file.races && file.races[7], label)

    return file.races[7]
  }

  assert.deepEqual(raceOf(m.a.eventsUpTo(file, 200), 'the archive keeps the race with an eligible noted failure').failures.map((failure) => failure.reason), ['early'], 'a failure at the time is kept')
  assert.deepEqual(raceOf(m.a.eventsUpTo(file, 1000), 'the archive keeps the race with both noted failures').failures.map((failure) => failure.reason), ['early', 'late'])
  assert.deepEqual(m.a.eventsUpTo(file, 199), {}, 'with no failure by the time and nothing else, the race is dropped')
  assert.deepEqual(m.a.eventsUpTo({ version: 1, races: { 7: m.a.withFailure(null, { at: 1, t: 900, reason: 'late' }) } }, 500), {})
  assert.equal(m.a.eventFileProblem(m.a.eventsUpTo(file, 500)), null)

  const io = LINEAGE(m, { [m.a.eventFileName('c', 'b1')]: file })
  const campaign = { id: 'c', branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { t: 500 } }, b3: { id: 'b3', parent: 'b1', fork: { t: 100 } } } }
  const given = m.a.eventForkFile(io, campaign, 'b2')

  assert.ok(given, 'a fork given a parent that noted a failed read by the fork')
  assert.deepEqual(raceOf(given, 'the fork keeps its parent race record').failures.map((failure) => failure.reason), ['early'])
  assert.deepEqual(given.races[7].increments, [])
  assert.equal(m.a.eventForkFile(io, campaign, 'b3'), null, 'a fork before the failure is given nothing')
  assert.deepEqual(m.a.eventBase(io, campaign, 'b2'), given)

  const capped = { ...m.a.withFailure(merged(m, null, capture(m, 1, 5, [...many(2, 'a', 2), ev(3, 'b')])).record, { at: 3, t: 200, reason: 'early' }), cut: 700 }
  const seed = raceOf(m.a.eventsUpTo({ version: 1, races: { 7: capped } }, 500), 'the capped archive keeps the race with an eligible noted failure')

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
  assert.throws(() => m.raw['event-pins'].withPin(store, 'b1', ev(900, 'e'), { increment: ID(900), count: 1, names: {}, at: 1, id: 'over' }), (error) => error instanceof m.p.PinLimit && error.name === 'PinLimit' && error.limit === 500 && error instanceof Error)
  const duplicate = m.p.withPin(store, 'b1', ev(1, 'e'), { increment: ID(1), count: 1, names: {}, at: 1, id: 'again' })

  assert.equal(duplicate.pins.length, 500, 'a duplicate at the cap leaves exactly 500 pins')
  assert.equal(duplicate, store, 'a group already pinned is no new pin')
  assert.equal(m.p.withPin(store, 'b2', ev(900, 'e'), { increment: ID(900), count: 1, names: {}, at: 1, id: 'other' }).pins.length, 501, 'a full first branch leaves the other branch free to add its first pin')
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

// ---------- the played campaign ----------

// The recorder over A, B and the two branches from B, C1 and C2 (scripts/lib/played-chain.js): the archive a branch keeps against what SQL says of each save, the archive a fork is given when C2, which parts from C1 at B, is opened after it (a rollback to B and a play on), and what a pin says on each of the four saves. The figures are worked here from the saves' own tables, never from the utilities.
const LETTERS = ['A', 'B', 'C1', 'C2']
const CHAIN_THERE = LETTERS.every((letter) => fs.existsSync(fileOf(letter)))
const PLAYED_NEEDS = ['chain', 'late', 'noted', 'statements', 'played']

// The columns an event is told by, in the order a group keeps them.
const COLUMNS = ['Time', 'EventType', 'MessageText', 'SystemID', 'PopulationID', 'Xcor', 'Ycor', 'IDType', 'SMOnly']

const textOfRow = (row) => JSON.stringify(COLUMNS.map((column) => (row[column] === null || row[column] === undefined ? null : column === 'MessageText' ? String(row[column]) : Number(row[column]))))

// What SQL says of one save of the chain: the window of its log (the oldest increment any race has a row in, and the ledger from there), the race's rows as counted groups by increment, the span the window observes and its newest increment.
const readingOf = (letter) => {
  const file = fileOf(letter)
  const [{ first }] = rowsOf(file, `select min(IncrementID) as first from FCT_GameLog where GameID = ${GAME}`)
  const ledger = new Map(ledgerOf(letter).filter((row) => row.IncrementID >= first).map((row) => [row.IncrementID, [row.IncrementID, row.GameTime, row.Length]]))
  const byInc = new Map()

  rowsOf(file, `select IncrementID, ${COLUMNS.join(', ')}, count(*) as n from FCT_GameLog where GameID = ${GAME} and RaceID = ${RACE} group by IncrementID, ${COLUMNS.join(', ')}`).filter((row) => ledger.has(row.IncrementID)).forEach((row) => {
    const groups = byInc.get(row.IncrementID) || new Map()

    groups.set(textOfRow(row), row.n)
    byInc.set(row.IncrementID, groups)
  })

  const ids = [...ledger.keys()]
  const newest = ledger.get(ids[ids.length - 1])

  return { letter, first, ledger, byInc, span: [ledger.get(ids[0])[1], newest[1] + newest[2]], newest }
}

const sameLedger = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

// The archive the saves leave when read in this order after `base`: each increment with its ledger identity and, of each group, the larger count (the open increments of a read take the larger count, and a closed one is the same in two saves of one timeline). The rows of an increment the archive already holds under another identity are left out.
const modelOf = (readings, base = new Map()) => {
  const model = new Map([...base].map(([id, own]) => [id, { identity: own.identity, groups: new Map(own.groups) }]))

  readings.forEach((reading) => {
    reading.byInc.forEach((groups, id) => {
      const own = model.get(id) || { identity: reading.ledger.get(id), groups: new Map() }

      if (!sameLedger(own.identity, reading.ledger.get(id))) {
        return
      }

      groups.forEach((count, key) => own.groups.set(key, Math.max(own.groups.get(key) || 0, count)))
      model.set(id, own)
    })
  })

  return model
}

const upTo = (model, t) => new Map([...model].filter(([, { identity }]) => identity[1] + identity[2] <= t))

const totalOf = (model) => [...model.values()].reduce((sum, { groups }) => sum + [...groups.values()].reduce((a, b) => a + b, 0), 0)

// Spans merged where they touch or overlap.
const unionOf = (spans) => spans.map((span) => [...span]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).reduce((merged, span) => {
  const last = merged[merged.length - 1]

  if (last && span[0] <= last[1]) {
    last[1] = Math.max(last[1], span[1])
  } else {
    merged.push(span)
  }

  return merged
}, [])

// What a fork keeps of spans: those that start before the cut, ending no later than it.
const clippedTo = (spans, t) => spans.filter(([start]) => start < t).map(([start, end]) => [start, Math.min(end, t)])

const shapeOf = (record) => record.increments.map(([id, time, length, groups]) => [id, time, length, groups.map((group) => [JSON.stringify(group.slice(0, COLUMNS.length)), group[COLUMNS.length]]).sort()])

const shapeOfModel = (model) => [...model].sort((a, b) => a[0] - b[0]).map(([, { identity, groups }]) => [...identity, [...groups].sort()])

const memo = (work) => {
  let held = null

  return () => {
    held = held || work()

    return held
  }
}

const gameTimeOf = (letter) => rowsOf(fileOf(letter), `select GameTime from FCT_Game where GameID = ${GAME}`)[0].GameTime

// One pass of the recorder over a save, giving what the save settled to.
const settled = async (m, target, letter, options = {}) => {
  let last = null

  await recordSave(m.history, target, letter, { onResolved: (id, resolution) => { last = id === GAME ? resolution : last }, ...options })

  return last
}

const chosen = (m, target, campaignId) => m.a.saveArchiveChoice(target.io.settings, campaignId, RACE, true)

const eventNames = (target) => [...target.files.keys()].filter((name) => name.endsWith('-events'))

// The capture the utilities take of a save of the chain.
const readOf = async (m, letter) => {
  const database = databaseOf(letter)
  const window = await m.a.readLogWindow(database, GAME)
  const read = await m.a.readRaceEvents(database, { GameID: GAME, RaceID: RACE, t: gameTimeOf(letter), window })

  assert.equal(read.failed, undefined)

  return read
}

// The campaign begun by A with no archive chosen.
const begin = async (m) => {
  const inst = installation()

  await settled(m, inst, 'A')

  return { inst, campaignId: inst.campaignId(GAME) }
}

// A is read with the archive on, then B and C1 (the first branch), C1 once more, then C2, which parts from C1 at B: a fork. The archive of each pass is kept, and the saves are opened again as a rollback and a play on would open them.
const chain = async (m, begun) => {
  const { campaignId } = begun
  const inst = begun.inst.copy()
  const file = (branchId) => `file:${m.a.eventFileName(campaignId, branchId)}`
  const result = { campaignId, relations: {} }

  chosen(m, inst, campaignId)

  for (const letter of ['A', 'B', 'C1']) {
    result.relations[letter] = (await settled(m, inst, letter)).relation
    result[`after${letter}`] = inst.events(campaignId, 'b1')
  }

  const again = inst.eventWrites()

  await settled(m, inst, 'C1')
  result.repeat = { writes: inst.eventWrites() - again, b1: inst.events(campaignId, 'b1') }

  const forkAt = inst.writes.length
  const fork = await settled(m, inst, 'C2')

  result.relations.C2 = fork.relation
  result.fork = { branchId: fork.branchId, registry: inst.registry().campaigns[campaignId], writes: inst.eventValues(file(fork.branchId), forkAt), parentWrites: inst.eventValues(file('b1'), forkAt).length, b1: inst.events(campaignId, 'b1'), b2: inst.events(campaignId, 'b2'), names: eventNames(inst) }

  const frozen = inst.copy()

  frozen.put(file('b1'), { version: 1, races: {} })
  await settled(m, frozen, 'C2')
  result.frozen = { before: inst.events(campaignId, 'b2'), after: frozen.events(campaignId, 'b2') }

  const writes = inst.eventWrites()
  const reopened = await settled(m, inst, 'C1')
  const second = await settled(m, inst, 'C2')

  result.reopen = { branchId: reopened.branchId, second: second.branchId, writes: inst.eventWrites() - writes, b1: inst.events(campaignId, 'b1'), b2: inst.events(campaignId, 'b2') }

  return result
}

// The fork made while no archive was chosen, and the archive chosen afterwards.
const late = async (m, begun) => {
  const { campaignId } = begun
  const inst = begun.inst.copy()
  const result = { campaignId }

  await settled(m, inst, 'C1')
  await settled(m, inst, 'C2')
  result.off = { registry: inst.registry().campaigns[campaignId], names: eventNames(inst) }
  chosen(m, inst, campaignId)
  await settled(m, inst, 'C1')
  await settled(m, inst, 'C2')
  result.on = { registry: inst.registry().campaigns[campaignId], b1: inst.events(campaignId, 'b1'), b2: inst.events(campaignId, 'b2') }

  return result
}

// The log of A and of the first branch cannot be read, and C2 can: the archive holds the failures and no row, and C2 parts from the first branch.
const noted = async (m, begun) => {
  const { campaignId } = begun
  const inst = begun.inst.copy()
  const fails = (sql) => /min\(FCT_GameLog\.IncrementID\)/.test(sql)

  chosen(m, inst, campaignId)
  await settled(m, inst, 'A', { fails })
  await settled(m, inst, 'C1', { fails })

  const parent = inst.events(campaignId, 'b1')
  const fork = await settled(m, inst, 'C2')

  return { campaignId, parent, fork: { branchId: fork.branchId, registry: inst.registry().campaigns[campaignId], b1: inst.events(campaignId, 'b1'), b2: inst.events(campaignId, 'b2') } }
}

// B opened with no archive chosen and with it chosen: the statements each pass issues.
const statements = async (m, begun) => {
  const { campaignId } = begun
  const off = begun.inst.copy()
  const on = begun.inst.copy()
  const offLog = []
  const onLog = []

  chosen(m, on, campaignId)
  await settled(m, off, 'B', { log: offLog })
  await settled(m, on, 'B', { log: onLog })

  return { campaignId, off: { log: offLog, names: eventNames(off) }, on: { log: onLog, names: eventNames(on) } }
}

// The record of the race in an archive file, once the file holds one.
const raceOf = (file, what) => {
  assert.ok(file && file.races && file.races[RACE], `${what} holds a record of the race`)

  return file.races[RACE]
}

check('chainfile', 'the archive of the branch the saves settle to holds the player race and no other, and after A, B and the first branch holds what SQL says of the saves read so far: each increment with its ledger identity and counted groups, the span observed and the newest increment, and no conflict', 'chain', ({ m, k }) => {
  const stages = [['A', k.afterA], ['B', k.afterB], ['C1', k.afterC1]]

  assert.deepEqual(k.relations, { A: 'same', B: 'continues', C1: 'continues', C2: 'fork' })

  stages.forEach(([letter, file], index) => {
    const readings = LETTERS.slice(0, index + 1).map(readingOf)
    const model = modelOf(readings)
    const record = raceOf(file, `the archive after ${letter}`)

    assert.equal(file.version, 1)
    assert.deepEqual(Object.keys(file.races), [String(RACE)], `after ${letter}: the player race only`)
    assert.equal(m.a.eventFileProblem(file), null)
    assert.deepEqual(shapeOf(record), shapeOfModel(model), `after ${letter}`)
    assert.equal(m.a.recordEvents(record), totalOf(model))
    assert.deepEqual(record.spans, unionOf(readings.map((reading) => reading.span)), `after ${letter}: the spans`)
    assert.deepEqual(record.tip, readings[index].newest, `after ${letter}: the newest increment observed`)
    assert.deepEqual(record.conflicts, [])
    assert.equal(record.cut, undefined, 'nothing was cut')
    assert.equal(totalOf(modelOf([readingOf(letter)])), rowsOf(fileOf(letter), `select count(*) as n from FCT_GameLog where GameID = ${GAME} and RaceID = ${RACE}`)[0].n, `${letter}: the rows SQL counts`)
  })

  assert.ok(k.afterA.races[RACE].increments.length < k.afterB.races[RACE].increments.length && k.afterB.races[RACE].increments.length < k.afterC1.races[RACE].increments.length, 'each save adds increments')
})

check('chainrepeat', 'reading the same save again writes nothing, and the saves opened again after the fork (the first branch, then the second) settle to their own branches and write nothing and add no conflict', 'chain', ({ k }) => {
  assert.equal(k.repeat.writes, 0)
  assert.deepEqual(k.repeat.b1, k.afterC1)
  assert.equal(k.reopen.branchId, 'b1')
  assert.equal(k.reopen.second, 'b2')
  assert.equal(k.reopen.writes, 0)
  assert.deepEqual(k.reopen.b1, k.fork.b1)
  assert.deepEqual(k.reopen.b2, k.fork.b2)
  assert.deepEqual(raceOf(k.reopen.b1, 'the first branch\'s archive').conflicts, [])
  assert.deepEqual(raceOf(k.reopen.b2, 'the fork\'s archive').conflicts, [])
})

check('chainfork', 'a fork is given its archive in the pass that creates it: the first branch\'s increments that had ended by the cut (B\'s among them, the later ones and the tip not), written before the fork\'s own capture, the first branch\'s file untouched, the branch marked, and the two never merged', 'chain', ({ m, k }) => {
  const parting = partingOf(ledgerOf('C1'), ledgerOf('C2'))
  const branch = k.fork.registry.branches.b2
  const readings = ['A', 'B', 'C1'].map(readingOf)
  const expected = upTo(modelOf(readings), parting.t)
  const spans = clippedTo(unionOf(readings.map((reading) => reading.span)), parting.t)
  const own = readingOf('C2')

  assert.equal(k.fork.branchId, 'b2')
  assert.equal(branch.parent, 'b1')
  assert.equal(branch.fork.t, parting.t)
  assert.equal(branch.eventsSeeded, true)
  assert.equal(k.fork.writes.length, 2, 'the seed, then the first capture')
  assert.equal(k.fork.parentWrites, 0, 'the first branch\'s file is not written by the pass that makes the fork')
  assert.deepEqual(k.fork.b1, k.afterC1, 'the first branch is as the pass before the fork left it')
  assert.ok(k.afterC1.races[RACE].increments.some((increment) => m.a.endOf(increment) > parting.t), 'the first branch holds increments after the cut')
  assert.ok(expected.size > 0 && [...expected.keys()].some((id) => id > readingOf('A').newest[0]), 'the seed holds what B read after A')
  assert.ok([...expected.keys()].some((id) => id < own.first), 'the seed holds what the fork\'s own save no longer has')

  const [seed, merged] = k.fork.writes
  const seeded = raceOf(seed, 'the seed')
  const record = raceOf(merged, 'the fork\'s own capture')

  assert.deepEqual(shapeOf(seeded), shapeOfModel(expected))
  assert.deepEqual(seeded.spans, spans)
  assert.equal(seeded.tip, undefined, 'the tip lies after the cut: the first branch\'s')
  assert.deepEqual(seeded.captures.map((capture) => capture.t), [gameTimeOf('A')], 'the captures of the saves before the cut: A\'s, not B\'s or the first branch\'s')
  assert.deepEqual(shapeOf(record), shapeOfModel(modelOf([own], expected)))
  assert.deepEqual(record.spans, unionOf([...spans, own.span]))
  assert.deepEqual(record.tip, own.newest)
  assert.deepEqual(record.conflicts, [], 'the rollback leaves no conflict in the fork\'s archive')
  assert.deepEqual(merged, k.fork.b2, 'the last write is the file')
  assert.ok(k.fork.names.includes(`file:${m.a.eventFileName(k.campaignId, 'b2')}`))
})

check('chainpair', 'the captures of the first and second branch merged into one archive give a conflict for each increment the rollback replaced (a ledger that differs, the parting increment by its length alone) and keep the first branch\'s rows, which is why a fork gets its own archive', 'played', async ({ m }) => {
  const readings = ['C1', 'C2'].map(readingOf)
  const first = await readOf(m, 'C1')
  const second = await readOf(m, 'C2')
  const taken = (capture, file = {}) => m.a.mergeEvents(file, { races: [{ RaceID: RACE, capture }] }, { cap: 1e9, now: counter() })
  const record = raceOf(taken(second.capture, taken(first.capture).file).file, 'the one archive')
  const other = readings[1].ledger
  const replaced = [...readings[0].byInc.keys()].filter((id) => other.has(id) && !sameLedger(other.get(id), readings[0].ledger.get(id))).sort((a, b) => a - b)
  const parting = partingOf(ledgerOf('C1'), ledgerOf('C2'))
  const partingId = ledgerOf('C1')[parting.common - 1].IncrementID

  assert.ok(replaced.length > 1 && replaced.includes(partingId), `${replaced.length} increments of the first branch the second names otherwise`)
  assert.ok(readings[0].ledger.get(partingId)[1] === readings[1].ledger.get(partingId)[1] && readings[0].ledger.get(partingId)[2] !== readings[1].ledger.get(partingId)[2], 'the parting increment is the same by ID and game time, another by length')
  assert.deepEqual(record.conflicts.map((conflict) => conflict.reason), record.conflicts.map(() => 'ledger'))
  assert.deepEqual(record.conflicts.map((conflict) => conflict.increment[0]).sort((a, b) => a - b), replaced)
  assert.deepEqual(shapeOf(record), shapeOfModel(modelOf([readings[1]], modelOf([readings[0]]))), 'the first branch\'s rows stay, the second\'s of the same IDs are left out')
})

check('chainfrozen', 'a fork\'s archive is frozen when the fork is made: clearing the first branch\'s archive afterwards and reading the fork again changes nothing in it', 'chain', ({ k }) => {
  const own = readingOf('C2')

  assert.ok(raceOf(k.frozen.before, 'the fork\'s archive').increments.some((increment) => increment[0] < own.first), 'the fork holds the first branch\'s past')
  assert.deepEqual(k.frozen.after, k.frozen.before)
})

check('chainlate', 'a fork made while no archive was chosen has no archive file but is marked, and an archive chosen afterwards holds only the fork\'s own rows, never the first branch\'s past', 'late', ({ m, k }) => {
  const own = readingOf('C2')

  assert.equal(k.off.registry.branches.b2.parent, 'b1')
  assert.equal(k.off.registry.branches.b2.eventsSeeded, true)
  assert.deepEqual(k.off.names, [])
  assert.ok(raceOf(k.on.b1, 'the first branch\'s archive').increments.length > 0, 'the first branch holds its own rows by now')

  const record = raceOf(k.on.b2, 'the fork\'s archive')

  assert.deepEqual(shapeOf(record), shapeOfModel(modelOf([own])))
  assert.deepEqual(record.spans, [own.span])
  assert.equal(m.a.eventFileProblem(k.on.b2), null)
})

check('chainnoted', 'a fork made after a read of the first branch\'s log failed is given the failure noted by the cut and none later: the failure of A is the fork\'s past, the one of the first branch\'s own save is not, and the fork then holds its own rows', 'noted', ({ k }) => {
  const times = { A: gameTimeOf('A'), C1: gameTimeOf('C1') }
  const parting = partingOf(ledgerOf('C1'), ledgerOf('C2'))
  const own = readingOf('C2')
  const parent = raceOf(k.parent, 'the first branch\'s archive')

  assert.ok(times.A <= parting.t && times.C1 > parting.t, 'A is before the cut, the first branch\'s save after it')
  assert.deepEqual((parent.failures || []).map((failure) => failure.t), [times.A, times.C1])
  assert.deepEqual(parent.increments, [])
  assert.equal(k.fork.registry.branches.b2.parent, 'b1')
  assert.equal(k.fork.registry.branches.b2.eventsSeeded, true)
  assert.deepEqual(k.fork.b1, k.parent, 'the first branch keeps its failures')

  const record = raceOf(k.fork.b2, 'the fork\'s archive')

  assert.deepEqual((record.failures || []).map((failure) => failure.t), [times.A])
  assert.deepEqual(shapeOf(record), shapeOfModel(modelOf([own])))
})

check('chainstatements', 'a pass over a real save with the archive off issues no statement of the log and writes no archive; with it chosen the pass adds the log\'s first increment, the ledger from there and the race\'s rows, all SELECTs, and the window is read once', 'statements', ({ m, k }) => {
  const logged = (log) => log.filter((sql) => /FCT_GameLog/.test(sql))
  const extra = k.on.log.filter((sql) => !k.off.log.includes(sql))

  assert.deepEqual(logged(k.off.log), [])
  assert.deepEqual(k.off.names, [])
  assert.deepEqual(k.on.names, [`file:${m.a.eventFileName(k.campaignId, 'b1')}`])
  assert.equal(logged(extra).filter((sql) => /min\(/.test(sql)).length, 1, 'the window of the log is read once')
  assert.equal(logged(extra).filter((sql) => !/min\(/.test(sql)).length, 1)
  assert.equal(extra.length, 3)
  assert.ok(extra.every((sql) => /^select /i.test(sql)), 'every statement is a SELECT')
  assert.equal(k.on.log.length - k.off.log.length, 3)
})

// A pin on the largest group of an increment of a save, as the page makes it: the group's fields, its count and the increment's ledger identity.
const pinOnRow = (m, reading, id) => {
  const [text, count] = [...reading.byInc.get(id)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
  const fields = JSON.parse(text)
  const row = { IncrementID: id, ...Object.fromEntries(COLUMNS.map((column, index) => [column, fields[index]])) }

  return m.p.withPin(m.p.emptyPins(), 'b1', row, { increment: reading.ledger.get(id), count, names: {}, at: 1, id: `${reading.letter}-${id}` }).pins[0]
}

check('chainpin', 'what each save of the chain says of a pin made on an event of the first or the second branch: held on the timeline it was made on, another timeline\'s on the other branch from the parting increment on (that increment by its length alone), and older or newer than the log elsewhere', 'played', async ({ m }) => {
  const readings = Object.fromEntries(LETTERS.map((letter) => [letter, readingOf(letter)]))
  const view = {}

  for (const letter of LETTERS) {
    const database = databaseOf(letter)
    const window = await m.a.readLogWindow(database, GAME)

    assert.deepEqual([...window.ledger], [...readings[letter].ledger], `${letter}: the window SQL gives`)
    assert.equal(window.first, readings[letter].first)
    view[letter] = { window, counts: m.a.rowCounts((await database.query(m.a.raceLogSql(GAME, RACE)))[0]) }
  }

  const parting = partingOf(ledgerOf('C1'), ledgerOf('C2'))
  const partingId = ledgerOf('C1')[parting.common - 1].IncrementID
  const before = [...readings.C1.byInc].filter(([id]) => id < partingId && readings.B.byInc.has(id) && readings.C2.byInc.has(id)).sort((a, b) => b[0] - a[0])[0]
  const pinOn = (letter, id) => pinOnRow(m, readings[letter], id)
  const states = (pin) => Object.fromEntries(LETTERS.map((letter) => [letter, m.p.pinState(pin, view[letter].counts, view[letter].window)]))
  const own = (letter, from) => [...readings[letter].byInc.keys()].filter((id) => id >= from).sort((a, b) => a - b)[0]

  assert.ok(before && readings.C2.byInc.get(before[0]), 'an increment before the parting both branches hold')
  assert.deepEqual(states(pinOn('C1', before[0])), { A: 'newer', B: 'held', C1: 'held', C2: 'held' }, 'before the parting the two branches are one timeline')
  assert.ok(readings.C1.byInc.has(partingId) && readings.C2.byInc.has(partingId), 'the parting increment carries events on both branches')
  assert.deepEqual(states(pinOn('C1', partingId)), { A: 'newer', B: 'newer', C1: 'held', C2: 'ledger' }, 'the parting increment is another increment by its length')
  assert.deepEqual(states(pinOn('C2', partingId)), { A: 'newer', B: 'newer', C1: 'ledger', C2: 'held' })
  assert.deepEqual(states(pinOn('C1', own('C1', partingId + 1))), { A: 'newer', B: 'newer', C1: 'held', C2: 'ledger' }, 'after the parting the same ID is another increment')
  assert.deepEqual(states(pinOn('C2', own('C2', partingId + 1))), { A: 'newer', B: 'newer', C1: 'ledger', C2: 'held' })
  assert.deepEqual(states(pinOn('A', own('A', 0))), { A: 'held', B: 'older', C1: 'older', C2: 'older' }, 'what A holds of the oldest log is older than the later saves keep')

  const doubled = [...readings.C2.byInc].find(([, groups]) => [...groups.values()].some((count) => count > 1))

  assert.ok(doubled, 'the second branch holds a group of identical rows')
  assert.deepEqual(states(pinOn('C2', doubled[0])), { A: 'newer', B: 'newer', C1: 'ledger', C2: 'held' }, 'a group of two identical rows is held at two')
})

check('chainpinseed', 'a fork inherits the first branch\'s pins on events that had ended by the cut and none on later ones, the cut and the parent read from the registry the recorder wrote', 'chain', ({ m, k }) => {
  const { branches } = k.fork.registry
  const lineage = Object.fromEntries(Object.entries(branches).map(([id, branch]) => [id, { parent: branch.parent || null, t: branch.fork ? branch.fork.t : null }]))
  const own = readingOf('C1')
  const cut = branches.b2.fork.t
  const ids = [...own.byInc.keys()].sort((a, b) => a - b)
  const ended = ids.filter((id) => own.ledger.get(id)[1] + own.ledger.get(id)[2] <= cut).pop()
  const later = ids.find((id) => own.ledger.get(id)[1] > cut)

  assert.ok(ended && later && later > ended, 'the first branch holds events before the cut and after it')

  const store = { ...m.p.emptyPins(), pins: [pinOnRow(m, own, ended), pinOnRow(m, own, later)] }
  const seeded = m.p.seededPins(store, 'b2', lineage)

  assert.deepEqual(seeded.pins.filter((pin) => pin.branch === 'b1').map((pin) => pin.increment[0]), [ended, later], 'the first branch keeps its own')
  assert.deepEqual(seeded.pins.filter((pin) => pin.branch === 'b2').map((pin) => pin.increment[0]), [ended], 'the fork inherits the one that had ended by the cut')
  assert.deepEqual(seeded.seeded, { b1: true, b2: true })
})

// ---------- the mutations ----------

// Retired fault classes: a replacement does not prove the original operator.
// [6] Old name: "a failed read is thrown"; current name: "a failed read is returned with a null failure".
// Original class: readRaceEvents lets a database-read failure escape as a thrown exception instead of returning { failed }.
// Reason/coverage: the original plant rejects before returning a value, so the no-subject-throw credit rule excludes it; readfail still enforces the return contract, while fault 6 now covers a returned null failure report.
// Original class loses its last fault: yes; no remaining credited fault in this suite covers an exception escaping readRaceEvents.

const MUTATIONS = [
  { name: 'a missing value is kept as 0', file: 'event-archive.js', find: 'const numberOrNull = (value) => (isKnownNumber(value) ? Number(value) : null)', replace: 'const numberOrNull = (value) => (isKnownNumber(value) ? Number(value) : 0)', fails: ['fields', 'counts', 'capture'] },
  { name: 'the fingerprint leaves the increment out', file: 'event-archive.js', find: 'JSON.stringify([Number(IncrementID), ...fields])', replace: 'JSON.stringify([...fields])', fails: ['fields', 'counts', 'pin', 'pinstate'] },
  { name: 'the fingerprint joins the fields as text', file: 'event-archive.js', find: 'JSON.stringify([Number(IncrementID), ...fields])', replace: '[Number(IncrementID), ...fields].join(\'|\')', fails: ['fields'] },
  { name: 'identical rows are counted once', file: 'event-archive.js', find: 'counts.set(key, (counts.get(key) || 0) + 1)', replace: 'counts.set(key, 1)', fails: ['counts', 'pinstate', 'chainpin'] },
  { name: 'a capture counts identical rows once', file: 'event-archive.js', find: 'groups.set(key, groups.has(key) ? [groups.get(key)[0], groups.get(key)[1] + 1] : [fields, 1])', replace: 'groups.set(key, [fields, 1])', fails: ['capture', 'rows', 'chainfork'] },
  { name: 'an orphan row is assigned to the first known increment instead of left out', file: 'event-archive.js', find: '      orphans++\n      return', replace: '      orphans++\n      const orphan = eventFields(row)\n      const groups = byIncrement.get(ids[0]) || new Map()\n      groups.set(JSON.stringify(orphan), [orphan, 1])\n      byIncrement.set(ids[0], groups)\n      return', fails: ['capture'] },
  { name: 'a failed read is returned with a null failure', file: 'event-archive.js', find: 'return { failed: error }', replace: 'return { failed: null }', fails: ['readfail'] },
  { name: 'the window is read again for each race', file: 'event-archive.js', find: 'const seen = window || (await readLogWindow(database, GameID, options))', replace: 'const seen = await readLogWindow(database, GameID, options)', fails: ['readfail'] },
  { name: 'touching spans are not merged', file: 'event-archive.js', find: 'if (last && start <= last[1]) {', replace: 'if (last && start < last[1]) {', fails: ['span', 'append'] },
  { name: 'a span inside another widens it', file: 'event-archive.js', find: 'last[1] = Math.max(last[1], end)', replace: 'last[1] = end', fails: ['span'] },
  { name: 'a merge always reports a change', file: 'event-archive.js', find: 'changed: Boolean(added || amended || found.length || spansChanged || tipChanged || !stored)', replace: 'changed: true', fails: ['same', 'closed', 'chainrepeat'] },
  { name: 'the read\'s oldest increment is not open', file: 'event-archive.js', find: 'const openIds = new Set([capture.from[0], newestStored])', replace: 'const openIds = new Set([newestStored])', fails: ['open'] },
  { name: 'the archive\'s newest increment is not open', file: 'event-archive.js', find: 'const openIds = new Set([capture.from[0], newestStored])', replace: 'const openIds = new Set([capture.from[0]])', fails: ['open'] },
  { name: 'every increment is open', file: 'event-archive.js', find: 'const open = openIds.has(id)', replace: 'const open = true', fails: ['open', 'closed'] },
  { name: 'a group the read holds more of keeps the stored count', file: 'event-archive.js', find: 'return [...group.slice(0, EVENT_FIELDS.length), readCount]', replace: 'return group', fails: ['open', 'closed'] },
  { name: 'a group the read holds fewer of is not a conflict', file: 'event-archive.js', find: 'if (readCount < storedCount && !open) {', replace: 'if (false) {', fails: ['closed', 'open'] },
  { name: 'a group the read holds fewer of is lowered to the read', file: 'event-archive.js', find: '      return group\n    })\n\n    // Groups only the read holds', replace: '      return [...group.slice(0, EVENT_FIELDS.length), readCount || storedCount]\n    })\n\n    // Groups only the read holds', fails: ['closed'] },
  { name: 'a row only the read holds in a closed increment is no conflict', file: 'event-archive.js', find: "conflict(increment, 'more', group, 0, group[EVENT_FIELDS.length])", replace: 'void group', fails: ['closed'] },
  { name: 'a changed ledger identity is not a conflict', file: 'event-archive.js', find: 'if (!sameIdentity(capture.ledger.get(id), increment)) {', replace: 'if (false) {', fails: ['ledger', 'chainpair'] },
  { name: 'the rows of another timeline\'s increment are not told', file: 'event-archive.js', find: "if (!sameIdentity(own, increment)) {\n        conflict(own, 'ledger')\n      }", replace: 'void own', fails: ['ledger'] },
  { name: 'a contradiction is recorded at every pass', file: 'event-archive.js', find: 'if (!keys.has(conflictKey(entry))) {', replace: 'if (true) {', fails: ['closed', 'ledger'] },
  { name: 'the spans are the last window only', file: 'event-archive.js', find: 'const spans = windowEnd > windowStart ? withSpan(record.spans, windowStart, windowEnd) : record.spans', replace: 'const spans = [[windowStart, windowEnd]]', fails: ['append', 'open', 'chainfile'] },
  { name: 'the rows the cap dropped are added again by a save that still holds them', file: 'event-archive.js', find: '} else if (cut === null || endOf(increment) > cut) {', replace: '} else {', fails: ['capmerge'] },
  { name: 'the window of a capture starts before the cut', file: 'event-archive.js', find: 'const windowStart = cut === null ? capture.from[1] : Math.max(capture.from[1], cut)', replace: 'const windowStart = capture.from[1]', fails: ['capmerge'] },
  { name: 'increments are not kept in order', file: 'event-archive.js', find: 'record.increments.sort((a, b) => a[0] - b[0])', replace: 'void 0', fails: ['append'] },
  { name: 'a revision is not counted', file: 'event-archive.js', find: 'record.revision += 1', replace: 'record.revision += 0', fails: ['same', 'open'] },
  { name: 'the first gap is not told', file: 'event-archive.js', find: 'const gaps = [{ from: null, to: record.spans[0][0] }]', replace: 'const gaps = []', fails: ['append'] },
  { name: 'a gap starts at the wrong end', file: 'event-archive.js', find: 'gaps.push({ from: record.spans[index][1], to: start })', replace: 'gaps.push({ from: record.spans[index][0], to: start })', fails: ['append'] },
  { name: 'a group of n identical rows is one row', file: 'event-archive.js', find: 'for (let copy = 0; copy < copies; copy++) {', replace: 'for (let copy = 0; copy < 1; copy++) {', fails: ['rows'] },
  { name: 'rows are oldest first', file: 'event-archive.js', find: 'rows.sort((a, b) => b.Time - a.Time || b.IncrementID - a.IncrementID)', replace: 'rows.sort((a, b) => a.Time - b.Time || a.IncrementID - b.IncrementID)', fails: ['rows', 'append'] },
  { name: 'events are counted by groups', file: 'event-archive.js', find: 'increment[3].reduce((count, group) => count + group[EVENT_FIELDS.length], 0), 0)', replace: 'increment[3].reduce((count) => count + 1, 0), 0)', fails: ['cap', 'rows'] },
  { name: 'a record at the cap is cut once more', file: 'event-archive.js', find: 'while (total > cap && increments.length) {', replace: 'while (total >= cap && increments.length) {', fails: ['cap'] },
  { name: 'the cap drops the newest increments', file: 'event-archive.js', find: 'const oldest = increments.shift()', replace: 'const oldest = increments.pop()', fails: ['cap', 'capmerge'] },
  { name: 'the cut is the start of the last dropped increment', file: 'event-archive.js', find: 'cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, endOf(oldest))', replace: 'cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, oldest[1])', fails: ['cap', 'capmerge'] },
  { name: 'the cut moves back', file: 'event-archive.js', find: 'cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, endOf(oldest))', replace: 'cut = endOf(oldest)', fails: ['cap'] },
  { name: 'the spans are not clipped to the cut', file: 'event-archive.js', find: 'spans.filter(([, end]) => end > cut).map(([start, end]) => [Math.max(start, cut), end])', replace: 'spans', fails: ['cap'] },
  { name: 'the conflicts of dropped increments stay', file: 'event-archive.js', find: 'conflicts: record.conflicts.filter((conflict) => endOf(conflict.increment) > cut) }, dropped }', replace: 'conflicts: record.conflicts }, dropped }', fails: ['cap'] },
  { name: 'a record cut by a lower cap alone is not written', file: 'event-archive.js', find: 'if (result.changed || dropped) {', replace: 'if (result.changed) {', fails: ['capmerge'] },
  { name: 'the merged record is not cut to the cap', file: 'event-archive.js', find: 'const { record, dropped } = capRecord(result.record, cap)', replace: 'const { record, dropped } = capRecord(result.record, Infinity)', fails: ['capmerge'] },
  { name: 'an archive up to a time takes increments that start by then', file: 'event-archive.js', find: 'const increments = record.increments.filter((increment) => endOf(increment) <= t)', replace: 'const increments = record.increments.filter((increment) => increment[1] <= t)', fails: ['upto', 'lineage', 'cleared'] },
  { name: 'an archive up to a time keeps the spans whole', file: 'event-archive.js', find: 'const spans = record.spans.filter(([start]) => start < t).map(([start, end]) => [start, Math.min(end, t)])', replace: 'const spans = record.spans', fails: ['upto', 'chainfork'] },
  { name: 'an archive up to a time keeps every capture', file: 'event-archive.js', find: 'captures: record.captures.filter((capture) => capture.t <= t)', replace: 'captures: record.captures', fails: ['upto', 'chainfork'] },
  { name: 'an archive up to a time keeps every conflict', file: 'event-archive.js', find: 'conflicts: record.conflicts.filter((conflict) => endOf(conflict.increment) <= t),', replace: 'conflicts: record.conflicts,', fails: ['upto'] },
  { name: 'a record cut after the time still seeds', file: 'event-archive.js', find: 'if (isKnownNumber(record.cut) && record.cut > t) {', replace: 'if (false) {', fails: ['upto'] },
  { name: 'the open newest increment is the newest event, not the tip', file: 'event-archive.js', find: 'const newestStored = tip ? tip[0] : lastStored', replace: 'const newestStored = false ? 0 : lastStored', fails: ['tip'] },
  { name: 'a record with no tip has no open newest increment', file: 'event-archive.js', find: 'const newestStored = tip ? tip[0] : lastStored && (observedEnd === null || endOf(lastStored) >= observedEnd) ? lastStored[0] : null', replace: 'const newestStored = tip ? tip[0] : null', fails: ['tip', 'tipupto'] },
  { name: 'the tip goes back with an older capture', file: 'event-archive.js', find: 'const nextTip = !tip || capture.to[0] >= tip[0] ? [...capture.to] : tip', replace: 'const nextTip = [...capture.to]', fails: ['tip'] },
  { name: 'the tip never advances', file: 'event-archive.js', find: 'const nextTip = !tip || capture.to[0] >= tip[0] ? [...capture.to] : tip', replace: 'const nextTip = tip || [...capture.to]', fails: ['tip', 'chainfile'] },
  { name: 'a tip given to a record is not a change', file: 'event-archive.js', find: 'const tipChanged = !tip || !sameIdentity(nextTip, tip)', replace: 'const tipChanged = false', fails: ['tip'] },
  { name: 'the tip is not stored', file: 'event-archive.js', find: 'record.tip = nextTip', replace: 'void nextTip', fails: ['tip', 'chainfile'] },
  { name: 'a tip past the fork is kept in a seed', file: 'event-archive.js', find: 'if (isIdentity(record.tip) && endOf(record.tip) > t) {', replace: 'if (false) {', fails: ['tipupto', 'chainfork'] },
  { name: 'a tip that ends at the fork is dropped from a seed', file: 'event-archive.js', find: 'endOf(record.tip) > t) {', replace: 'endOf(record.tip) >= t) {', fails: ['tipupto'] },
  { name: 'an archive up to a time keeps every failure', file: 'event-archive.js', find: 'record.failures.filter((failure) => failure.t <= t)', replace: 'record.failures', fails: ['tipupto', 'chainnoted'] },
  { name: 'more than 50 failures are kept', file: 'event-archive.js', find: 'const FAILURES_KEPT = 50', replace: 'const FAILURES_KEPT = 51', fails: ['failure'] },
  { name: 'the oldest failures are kept, not the newest', file: 'event-archive.js', find: '.slice(-FAILURES_KEPT)', replace: '.slice(0, FAILURES_KEPT)', fails: ['failure'] },
  { name: 'a failure replaces the failures before it', file: 'event-archive.js', find: 'failures: [...((record && record.failures) || []), {', replace: 'failures: [{', fails: ['failure', 'chainnoted'] },
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
  { name: 'a record with only noted failures is dropped from an archive up to a time', file: 'event-archive.js', find: '|| (record.failures && record.failures.length)))', replace: '))', fails: ['failonly', 'chainnoted'] },
  { name: 'a cut past the fork drops the failures noted before it', file: 'event-archive.js', find: 'return [RaceID, { revision: record.revision, increments: [], spans: [], captures: [], conflicts: [], failures: kept.failures || [] }]', replace: 'return [RaceID, null]', fails: ['failonly'] },
  { name: 'a cut past the fork is carried into the seed', file: 'event-archive.js', find: 'failures: kept.failures || [] }]', replace: 'failures: kept.failures || [], cut: record.cut }]', fails: ['failonly'] },
  { name: 'a record with more events than any cap allows is read', file: 'event-archive.js', find: 'if (recordEvents(record) > MAX_EVENTS) {', replace: 'if (false) {', fails: ['problem'] },
  { name: 'a record with exactly the largest cap is refused', file: 'event-archive.js', find: 'if (recordEvents(record) > MAX_EVENTS) {', replace: 'if (recordEvents(record) >= MAX_EVENTS) {', fails: ['problem'] },
  { name: 'the largest event count is not the largest cap', file: 'event-archive.js', find: 'export const MAX_EVENTS = Math.max(...EVENT_CAPS)', replace: 'export const MAX_EVENTS = Math.min(...EVENT_CAPS)', fails: ['problem'] },
  { name: 'a seed through a parent with no archive reaches past the earlier fork', file: 'event-archive.js', find: 'eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t))', replace: 'eventSeed(io, campaign, branch.parent, t)', fails: ['lineage'] },
  { name: 'a seed passes through a parent that has none', file: 'event-archive.js', find: 'eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', replace: '{} : {}', fails: ['lineage'] },
  { name: 'a branch with no file is not seeded', file: 'event-archive.js', find: '? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}', replace: '? {} : {}', fails: ['lineage'] },
  { name: 'a branch seeded empty is seeded from its parent at its first capture', file: 'event-archive.js', find: 'return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}', replace: 'return branch && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}', fails: ['lineage'] },
  { name: 'a branch seeded empty is seeded from its parent through a chain', file: 'event-archive.js', find: 'return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', replace: 'return branch && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', fails: ['lineage'] },
  { name: 'a cleared archive is seeded from its parent again', file: 'event-archive.js', find: 'if (written(stored)) {\n    return stored', replace: 'if (written(stored) && Object.keys(stored.races).length) {\n    return stored', fails: ['cleared'] },
  { name: 'a seed through a cleared branch reaches the parent\'s rows', file: 'event-archive.js', find: 'if (written(file)) {\n    return eventsUpTo(file, t)', replace: 'if (written(file) && Object.keys(file.races).length) {\n    return eventsUpTo(file, t)', fails: ['cleared'] },
  { name: 'a fork is given a file even when its parent holds none', file: 'event-archive.js', find: 'return written(seed) && Object.keys(seed.races).length ? seed : null', replace: 'return seed', fails: ['lineage', 'cleared'] },
  { name: 'a fork is not given the parent\'s archive', file: 'event-archive.js', find: 'return written(seed) && Object.keys(seed.races).length ? seed : null', replace: 'return null', fails: ['lineage', 'chainfork', 'chainfrozen'] },
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
  { name: 'clearing a history leaves its event archive', file: 'history.js', find: 'planned(eventStore(campaignId, branchId), eventsFrom),', replace: 'null,', fails: ['rclear'] },
  { name: 'an event is estimated at 256 bytes', file: 'event-archive.js', find: 'export const EVENT_BYTES = 200', replace: 'export const EVENT_BYTES = 256', fails: ['estimate'] },
  { name: 'a group already pinned is pinned again', file: 'event-pins.js', find: 'if (pinOfRow(store, branch, row)) {\n    return store', replace: 'if (pinOfRow(store, branch, row)) {\n    return { ...store, pins: [...store.pins, pinOfRow(store, branch, row)] }', fails: ['pin', 'limit'] },
  { name: 'the pin limit is one more', file: 'event-pins.js', find: 'export const MAX_PINS = 500', replace: 'export const MAX_PINS = 501', fails: ['limit'] },
  { name: 'the pin limit is reached one too late', file: 'event-pins.js', find: 'if (pinsOf(store, branch).length >= MAX_PINS) {', replace: 'if (pinsOf(store, branch).length > MAX_PINS) {', fails: ['limit'] },
  { name: 'the limit counts every branch', file: 'event-pins.js', find: 'if (pinsOf(store, branch).length >= MAX_PINS) {', replace: 'if (store.pins.length >= MAX_PINS && pinsOf(store, branch).length < MAX_PINS) {\n    return store\n  }\n\n  if (pinsOf(store, branch).length >= MAX_PINS) {', fails: ['limit'] },
  { name: 'pins are listed oldest first', file: 'event-pins.js', find: 'b.fields[0] - a.fields[0] || b.increment[0] - a.increment[0]', replace: 'a.fields[0] - b.fields[0] || a.increment[0] - b.increment[0]', fails: ['pin'] },
  { name: 'a pin is found on every branch', file: 'event-pins.js', find: 'pin.branch === branch && pinKey(pin) === key', replace: 'pinKey(pin) === key', fails: ['pin'] },
  { name: 'a removal reaches the copy on another branch', file: 'event-pins.js', find: '!(pin.branch === branch && pin.id === id)', replace: 'pin.id !== id', fails: ['pin'] },
  { name: 'a note reaches the copy on another branch', file: 'event-pins.js', find: 'pin.branch === branch && pin.id === id ? { ...pin, note', replace: 'pin.id === id ? { ...pin, note', fails: ['pin'] },
  { name: 'stored pins that cannot be read are taken', file: 'event-pins.js', find: '!value.pins.every(validPin)', replace: 'false', fails: ['pin'] },
  { name: 'a fork inherits the pins of events still running at the fork', file: 'event-pins.js', find: 'pin.increment[1] + pin.increment[2] <= t', replace: 'pin.increment[1] <= t', fails: ['pinseed'] },
  { name: 'a fork inherits every pin of its parent', file: 'event-pins.js', find: 'pin.branch === parent && pin.increment[1] + pin.increment[2] <= t', replace: 'pin.branch === parent', fails: ['pinseed', 'chainpinseed'] },
  { name: 'a pin the fork has is inherited again', file: 'event-pins.js', find: ' && !own.has(pinKey(pin)))', replace: ')', fails: ['pinseed'] },
  { name: 'the parent is not seeded first', file: 'event-pins.js', find: 'next = seededPins(next, parent, lineage, walked)', replace: 'next = next', fails: ['pinseed'] },
  { name: 'a branch is seeded again', file: 'event-pins.js', find: 'if (store.seeded[branch] || !lineage', replace: 'if (!lineage', fails: ['pinseed'] },
  { name: 'a branch the registry does not know is marked', file: 'event-pins.js', find: '  if (store.seeded[branch] || !lineage || !lineage[branch] || walked.has(branch)) {\n    return store\n  }', replace: '  if (lineage && !lineage[branch]) {\n    return { ...store, seeded: { ...store.seeded, [branch]: true } }\n  }\n\n  if (store.seeded[branch] || !lineage || !lineage[branch] || walked.has(branch)) {\n    return store\n  }', fails: ['pinseed'] },
  { name: 'a pin is held without asking whether the log was read', file: 'event-pins.js', find: "if (!window) {\n    return 'unread'\n  }", replace: "if (!window) {\n    return 'held'\n  }", fails: ['pinstate'] },
  { name: 'the oldest increment of the log is before it', file: 'event-pins.js', find: 'if (window.first === null || id < window.first) {', replace: 'if (window.first === null || id <= window.first) {', fails: ['pinstate'] },
  { name: 'the length is not part of an increment\'s identity', file: 'event-pins.js', find: 'if (identity[1] !== pin.increment[1] || identity[2] !== pin.increment[2]) {', replace: 'if (identity[1] !== pin.increment[1]) {', fails: ['pinstate', 'chainpin'] },
  { name: 'a ledger that differs is not told', file: 'event-pins.js', find: 'if (identity[1] !== pin.increment[1] || identity[2] !== pin.increment[2]) {', replace: 'if (false) {', fails: ['pinstate', 'chainpin'] },
  { name: 'a pin is held at any count above its own', file: 'event-pins.js', find: 'if (held === pin.count) {', replace: 'if (held >= pin.count) {', fails: ['pinstate'] },
  { name: 'an event the save does not hold is gone even in the oldest increment', file: 'event-pins.js', find: "return id === window.first ? 'older' : 'gone'", replace: "return 'gone'", fails: ['pinstate'] },
  { name: 'a different count is told as held', file: 'event-pins.js', find: "  return 'count'\n}", replace: "  return 'held'\n}", fails: ['pinstate'] },
  { name: 'a log\'s depth ends at its first row', file: 'event-archive.js', find: 'return { from, to, count: rows.length }', replace: 'return { from, to: from, count: rows.length }', fails: ['depth'] },
  { name: 'a record\'s depth counts identical rows once', file: 'event-archive.js', find: 'count += group[EVENT_FIELDS.length]', replace: 'count += 1', fails: ['recorddepth'] },
  { name: 'a fork is not given its event archive when it is created', file: 'history.js', find: 'if (givenEvents) {', replace: 'if (false) {', fails: ['chainfork', 'chainfrozen'] },
  { name: 'a fork is not marked once it was given its event archive', file: 'history.js', find: 'campaign.branches[resolution.branchId].eventsSeeded = true', replace: 'void campaign', fails: ['chainfork', 'chainlate', 'chainnoted'] },
  { name: 'a fork is given nothing when it is created', file: 'history.js', find: 'if (resolution.forked) {\n          const registry = readRegistry(storage)', replace: 'if (false) {\n          const registry = readRegistry(storage)', fails: ['chainfork', 'chainlate', 'chainnoted'] },
  { name: 'a fork is cut at the game time of the save that made it', file: 'campaign.js', find: 'const forkTime = found.common ? opened.times[found.common / STEP - 1] : null', replace: 'const forkTime = found.common ? opened.t : null', fails: ['chainfork', 'chainpinseed'] },
  { name: 'events are read whether or not an archive is on', file: 'history.js', find: 'const wanted = races.filter((race) => !toBoolean(race.NPR) && archiveWanted(archive, GameID, race.RaceID))', replace: 'const wanted = races.filter((race) => !toBoolean(race.NPR))', fails: ['chainstatements'] },
  { name: 'the log window is read again for each race', file: 'history.js', find: 'readRaceEvents(database, { GameID, RaceID: race.RaceID, t, window }, options)', replace: 'readRaceEvents(database, { GameID, RaceID: race.RaceID, t, window: null }, options)', fails: ['chainstatements'] },
  { name: 'a pass merges into an empty archive, not the branch\'s', file: 'history.js', find: 'mergeEvents(base.value, {', replace: 'mergeEvents({}, {', fails: ['chainfile', 'chainrepeat'] },
  { name: 'a failed read of the log is not noted', file: 'history.js', find: 'file.races[RaceID] = withFailure(', replace: 'void withFailure(', fails: ['chainnoted'] },
  { name: 'a failure is stamped with no game time', file: 'history.js', find: '{ at: now(), t: snapshot.t, reason:', replace: '{ at: now(), t: 0, reason:', fails: ['chainnoted'] },
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

// The context a check runs in for one set of modules; a scenario of the played campaign is run once, on its first use.
const contextOf = (m) => {
  const begun = memo(() => begin(m))
  const scenarios = { chain: memo(async () => chain(m, await begun())), late: memo(async () => late(m, await begun())), noted: memo(async () => noted(m, await begun())), statements: memo(async () => statements(m, await begun())) }

  return { run: async ({ needs, run }) => run({ m, k: scenarios[needs] ? await scenarios[needs]() : null }) }
}

// Whether a check reads a save that is not here: it is skipped and says so.
const unread = (entry) => PLAYED_NEEDS.includes(entry.needs) && !CHAIN_THERE

const outcomeOf = async (context, entry) => {
  try {
    await context.run(entry)

    return { id: entry.key, ok: true, kind: null, threw: false, detail: '' }
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error
    }

    return { id: entry.key, ok: false, kind: kindOf(error), threw: isSubjectThrow(error), detail: String((error && error.stack) || error).split('\n').slice(0, 8).join('\n         ') }
  }
}

// A fault changes one module's source; imports and reloads receive that same override. The unchanged modules and their shared registry are loaded through the same content-addressed utility loader, without copying the entire utilities tree.
const planted = (mutation) => ({ [mutation.file.replace(/\.js$/, '')]: plantedPatch(mutation.file, fs.readFileSync(path.join(utilitiesDirectory, mutation.file), 'utf8'), mutation.find, mutation.replace) })

// A mutation judged in this process, as `show` prints it: the result (true, or why it fails) and the detail of a pass.
const judge = async (mutation, { modulesOf = loadModules, entries = checks, context = contextOf } = {}) => {
  // Injected credit controls load no product source and plant no fault.
  if (modulesOf === loadModules) {
    refusePlanting(mutation.name)
  }

  const started = Date.now()
  const sources = mutation.file ? planted(mutation) : {}
  const mutant = context(await modulesOf(utilitiesDirectory, sources))
  const named = entries.filter((entry) => mutation.fails.includes(entry.key))
  const absent = mutation.fails.filter((key) => !named.some((entry) => entry.key === key))
  const skipped = named.filter(unread)
  const outcomes = []

  for (const entry of named.filter((entry) => !unread(entry))) {
    outcomes.push(await outcomeOf(mutant, entry))
  }

  const failed = judged(outcomes, `the event fault "${mutation.name}"`)
  const caught = caughtAll(outcomes, { name: mutation.name })
  const details = failed.map(({ id, threw, detail }) => `${id}: ${threw ? 'subject throw' : 'value'}: ${detail.split('\n')[0]}`).join('; ')

  return { result: absent.length ? `no check is keyed ${absent.join(', ')}` : !outcomes.length ? `none of the named checks could run (${skipped.map((entry) => entry.key).join(', ')}): a save of the played campaign is not here` : !caught ? 'a named check did not fail by an allowed assertion' : true, detail: `${details}; ${((Date.now() - started) / 1000).toFixed(1)} s` }
}

// Exercise this suite's actual outcome and credit path independently, without planting a source or reading a save.
check('credit-boundaries', 'event fault credit rejects harness exceptions and subject throws, and credits every named wrong value', 'unit', async () => {
  const fault = { name: 'credit probe', fails: ['probe'] }
  const entries = [{ key: 'probe', run: ({ m }) => m.a.probe() }]
  const context = (m) => ({ run: (entry) => entry.run({ m }) })
  const probe = (run, throws = false) => judge({ ...fault, throws }, { entries, context, modulesOf: async () => ({ a: subjectModule({ probe: run }, 'credit probe') }) })

  await assert.rejects(judge(fault, { entries, modulesOf: async () => ({}), context: () => ({ run: () => { throw new Error('fixture broke') } }) }), (error) => error instanceof HarnessError && error.message.includes('fixture broke'))
  await assert.rejects(probe(() => { throw new Error('unexpected subject exception') }), (error) => error instanceof HarnessError && error.message.includes('not by a value'))
  await assert.rejects(probe(() => { throw new assert.AssertionError({ message: 'subject assertion is not a check assertion' }) }), (error) => error instanceof HarnessError && error.message.includes('not by a value'))

  const wrong = await judge(fault, { entries: [{ key: 'probe', run: () => assert.equal(2, 1, 'independent expected value') }], context, modulesOf: async () => ({}) })
  await assert.rejects(probe(() => { throw new Error('declared propagation defect') }, true), (error) => error instanceof HarnessError && error.message.includes('not by a value'))

  assert.equal(wrong.result, true)
  assert.ok(wrong.detail.includes('probe: value:'), wrong.detail)
})

// The mutations run in child processes, several side by side (CHECK_JOBS), each child judging its share one after another the way the whole run once did in one process: every mutation gets its source override and fresh scenarios; module identity remains governed by the utility loader, and a child holds only its own share of module copies in memory. `--mutants=<i>,<i>` is the child's mode; its last line is the list of its verdicts.
const MUTANTS_PREFIX = 'MUTANTS_RESULT '
const CHILD_MUTANTS = process.argv.filter((argument) => argument.startsWith('--mutants=')).map((argument) => argument.slice(10).split(',').map(Number))[0]

const childMain = async () => {
  const verdicts = []

  for (const index of CHILD_MUTANTS) {
    console.log(`MUTANT_START ${JSON.stringify({ index, name: MUTATIONS[index].name })}`)

    let verdict

    try {
      verdict = await judge(MUTATIONS[index])
    } catch (error) {
      throw new HarnessError(`event fault ${index} "${MUTATIONS[index].name}", declared checks [${MUTATIONS[index].fails.join(', ')}], could not be credited: ${error && error.stack ? error.stack : error}`)
    }

    verdicts.push(verdict)
    console.log(`MUTANT_DETAIL ${JSON.stringify({ index, name: MUTATIONS[index].name, ...verdict })}`)
  }

  process.stdout.write(`${MUTANTS_PREFIX}${JSON.stringify(verdicts)}\n`, () => process.exit(0))
}

const mutantChunk = async (chunk) => {
  const result = await runChild(__filename, [`--mutants=${chunk.join(',')}`], { onLine: (line, stream) => { if (stream === 'stderr') { console.error(line) } else if (/^MUTANT_(START|DETAIL) /.test(line)) { console.log(line) } } })

  if (result.code !== 0) {
    console.error(`CHUNK_FAILURE ${chunk.join(',')}\nComplete child stdout:\n${result.stdout}\nComplete child stderr:\n${result.stderr}`)
  }

  return lastJson(result, MUTANTS_PREFIX)
}

const main = async () => {
  const focus = (process.argv.find((argument) => argument.startsWith('--head-check=')) || '').slice('--head-check='.length)

  const requested = focus ? focus.split(',') : []

  if (focus && (mayMutate() || requested.some((key) => !checks.some((entry) => entry.key === key)))) {
    throw new HarnessError('--head-check names an existing check and requires --no-mutations')
  }

  const began = Date.now()
  let real = await loadModules(utilitiesDirectory)
  let context = contextOf(real)

  console.log('The event archive')

  if (!CHAIN_THERE) {
    console.log('  skip   a save of the played campaign is not here, so the chain checks are not run')
  }

  for (const entry of checks.filter((entry) => (!focus || requested.includes(entry.key)) && !unread(entry))) {
    number++

    const started = Date.now()
    const outcome = await outcomeOf(context, entry)

    show(`${number}. ${entry.key}: ${entry.name}`, outcome.ok ? true : outcome.detail, entry.needs === 'unit' ? '' : `${((Date.now() - started) / 1000).toFixed(1)} s`)
  }

  const checksTook = Date.now() - began

  context = null
  real = null

  if (mayMutate()) {
    console.log('\nMutations: each must break the checks it names')

    const chunks = chunksOf(MUTATIONS.length)
    const verdicts = spread(chunks, await inParallel(chunks, mutantChunk, 4))

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

  process.exit(failures ? 1 : 0)
}

;(CHILD_MUTANTS ? childMain() : main()).catch((error) => {
  console.error(error)
  process.exit(2)
})
