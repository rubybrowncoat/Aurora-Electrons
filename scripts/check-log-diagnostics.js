/*
  Checks the Game Log's short-interval checklist: the fire and boarding events one race's log holds for a recent window of game time, how far the log covers that window, and what the checklist could not read (src/renderer/utilities/log-diagnostics.js, the window states of src/renderer/utilities/event-archive.js, src/renderer/components/log/DiagnosticPanel.vue and its place on src/renderer/pages/log.vue).

  Run: bun scripts/check-log-diagnostics.js [--no-mutations] [--no-browser] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  Two parts. The utilities run in memory over a database that answers the statements the checklist sends from rows written here (a game of eleven increments of five days, a race of fire and boarding events, noise, game-master-only rows, identical rows, another race); the page runs in Chromium (scripts/lib/page-server.js) over a copy of a save whose log is rewritten here and read back by SQL written here.
  - window states: observed, partial for a window that meets a gap, the oldest or newest increment of a span (each of the three bases the record can know them by), a failed read, the cap's cut, or reaches before or after what was read; unavailable for no record, no span that meets the window, or a window that ends at the cut. A count of rows is null, never 0, where nothing covers the window; a tip later than the window closes the increments before it;
  - events: only the watched types, only the window's rows (open at the start, closed at the end), no game-master-only row, identical rows keep their multiplicity, each carries the fingerprint of its row and the state of its own increment, another race's rows never mix in, the archive is never changed by reading it, and an archive at its cap (25,000 events) leaves the same window as no archive, the save's rows before the cap's cut included;
  - verdicts: found, absent and unavailable are told apart; a window nothing covers, an empty log and a failed read are unavailable, never absent; an absent window is still partial where its newest increment may change;
  - inputs: the hidden event types and the event table of the save are read or unavailable (never none), the ship and fleet inputs are always unavailable, each with the status the window's state gives;
  - page: the panel on a save whose log was rewritten shows what SQL says for four windows, the states per window and per event, the hidden flag, the inputs and the pointers to the game's own checks; a race switched while its read is held shows nothing of the race before; a failed read and an empty window are never worded as safe or as nothing having happened; an older archive leaves a gap, an archive ahead of the save leaves the window observed. The page is read through the shared readers of scripts/lib/browser-observe.js (`installScreen`): the states, verdict, counts, copies, statuses, reasons and marks are read from what the panel draws, a word turned back into its value by the label maps of src/renderer/utilities/log-diagnostics.js (`labelKey`) and a numeral read in the grouping of the setting (`readFigure`); the hooks name the elements and must agree with what is drawn, and the rows, types, inputs and reasons are paired by their identity, never by place.
  - fold: the checklist folds under its title through a toggle (`aria-expanded`, a label, the id of the content it controls) that sits in the head's first element, which the section navigation names the section by, and a note of the verdict shows there only while it is folded. It opens folded exactly when the default window (the last day) holds no found event, decided once for each read scope by the window then chosen and never again by a window change; a fold or unfold by hand stands for the rest of the visit. The page is read as the player meets it (the fold of the first read, then the unfolding through the toggle), and one race with events, one without and one whose read fails show the outcomes.
  Every planted fault (in the utilities, in the panel, in the page) and every rewrite that says the same thing is run against the whole suite: a fault is credited only when a check named for it fails by an assertion of its own on a value it read, never because a call of the code under test threw (scripts/lib/fault-credit.js), and a rewrite must pass every check. Each credited fault prints the first line of what each named check said and whether it failed on a value or a throw.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. The heads (`units`, `page`, `recorder`) and every fault and rewrite (`unit-fault:N`, `unit-rewrite:N`, `page-fault:N`, `page-rewrite:N`) run through scripts/lib/suite-runner.js: one after another in a worker that writes the save, starts one page server and one browser and warms them first, each with a deadline, with a record that --resume continues and the control `control:warm-reset`, which runs a page fault and then the page's head on the same server. --only=<text> runs the heads and the faults and rewrites whose names hold the text (a focused run while working; the run that counts has none). The page part needs Playwright's Chromium (`bunx playwright install chromium` once).
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { assert, subjectModule, runChecks, judged, caughtBy } = require('./lib/fault-credit')
const { observe, validate, failedObservation, failureLine, describe, HarnessError, installScreen, readFigure, labelKey, pairedBy } = require('./lib/browser-observe')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const pageLoading = require('./page-loading')
const { runSuite } = require('./lib/suite-runner')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const NAMES = ['event-archive', 'log-diagnostics', 'provenance', 'math', 'glossary', 'history-milestones']
const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STORE_STUB = `const files = (globalThis.__logDiagnosticStores = globalThis.__logDiagnosticStores || new Map())
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

const loadModules = async (sources = {}) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources })

  return { a: subjectModule(loaded['event-archive'], 'the event archive'), d: subjectModule(loaded['log-diagnostics'], 'the checklist'), raw: loaded }
}

const sourceOf = (name) => fs.readFileSync(path.join(utilitiesDirectory, `${name}.js`), 'utf8')

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// ---------- the game written here ----------

const LEN = 432000
const FIRST = 100
const BASE = 1000000000
const RACE = 7
const OTHER = 8
const WATCHED_TYPES = [119, 341, 219, 220, 297, 342]
// The fire types among them: the other four are boarding types.
const FIRE_TYPES = [119, 341]
const T = (id) => BASE + (id - FIRST) * LEN
const ledgerOf = (from, to) => Array.from({ length: to - from + 1 }, (_item, at) => ({ IncrementID: from + at, GameTime: T(from + at), Length: LEN }))
const rowOf = (RaceID, IncrementID, over = {}) => ({ RaceID, IncrementID, Time: T(IncrementID) + 1000, EventType: 60, MessageText: `noise ${IncrementID}`, SystemID: 0, PopulationID: 0, Xcor: 0, Ycor: 0, IDType: 0, SMOnly: 0, ...over })
const noise = (from, to, race = RACE) => Array.from({ length: to - from + 1 }, (_item, at) => rowOf(race, from + at))
const same = (race, increment, count, over) => Array.from({ length: count }, () => rowOf(race, increment, over))

// The database the checklist reads: the statements it sends, answered from the rows and the ledger given. A race's log statement fails on request.
const databaseOf = ({ ledger, rows, hidden = [], listed = WATCHED_TYPES, failLog = false, failHidden = false, failTypes = false }) => ({
  query: async (sql) => {
    if (/min\(FCT_GameLog\.IncrementID\)/.test(sql)) {
      return [[{ first: rows.length ? Math.min(...rows.map((row) => row.IncrementID)) : null }]]
    }

    if (/from FCT_Increments/.test(sql)) {
      const first = Number(/IncrementID >= (\d+)/.exec(sql)[1])

      return [ledger.filter((entry) => entry.IncrementID >= first)]
    }

    if (/^select FCT_GameLog\.IncrementID, /.test(sql)) {
      if (failLog) {
        throw new Error('the log could not be read')
      }

      const race = Number(/RaceID = (\d+)/.exec(sql)[1])

      return [rows.filter((row) => row.RaceID === race)]
    }

    if (/FCT_HideEvents/.test(sql)) {
      if (failHidden) {
        throw new Error('no such table: FCT_HideEvents')
      }

      return [hidden.map((EventID) => ({ EventID }))]
    }

    if (/DIM_EventType/.test(sql)) {
      if (failTypes) {
        throw new Error('no such table: DIM_EventType')
      }

      return [listed.map((EventTypeID) => ({ EventTypeID }))]
    }

    throw new Error(`the harness was asked an unexpected statement: ${sql}`)
  },
})

// The rows of the race the checklist would list for the window, by SQL-free filtering written here: watched types, no game-master-only row, the window open at its start and closed at its end.
const expectedRows = (rows, race, from, to) => rows.filter((row) => row.RaceID === race && WATCHED_TYPES.includes(row.EventType) && !row.SMOnly && row.Time > from && row.Time <= to)

const keyOf = (row) => JSON.stringify([row.IncrementID, row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType, row.SMOnly])

// The listed events of a set of rows: one entry for each group of identical rows, as `key|copies` lines.
const groupsOf = (rows) => {
  const counts = new Map()

  rows.forEach((row) => counts.set(keyOf(row), (counts.get(keyOf(row)) || 0) + 1))

  return [...counts].map(([key, copies]) => `${key}|${copies}`).sort()
}

const observationsOf = (diagnosis) => diagnosis.observations.map((observation) => `${observation.key}|${observation.copies}`).sort()

// The record of the archive a database gives the read of the race, merged in one capture or two.
const archiveOf = async (a, database, t = T(111)) => {
  const window = await a.readLogWindow(database, 1)
  const read = await a.readRaceEvents(database, { GameID: 1, RaceID: RACE, t, window })

  return a.mergeCapture(null, read.capture, { now: () => 1 }).record
}

// The fixture most checks read: eleven increments, a race with fire, boarding, noise, a game-master-only row, identical rows and rows at the edges of a day, and another race.
const BUSY = () => [
  ...noise(100, 110),
  rowOf(OTHER, 109, { EventType: 297, MessageText: 'another race' }),
  rowOf(RACE, 100, { EventType: 342, MessageText: 'damage at the head' }),
  rowOf(RACE, 105, { EventType: 219, MessageText: 'attempt' }),
  rowOf(RACE, 108, { EventType: 220, MessageText: 'combat' }),
  rowOf(RACE, 109, { EventType: 297, MessageText: 'underway' }),
  rowOf(RACE, 109, { EventType: 341, MessageText: 'game master only', SMOnly: 1 }),
  ...same(RACE, 110, 3, { EventType: 119, MessageText: 'fire delay', Time: T(111) - 32000 }),
  rowOf(RACE, 110, { EventType: 119, MessageText: 'fire delay again', Time: T(111) - 32000 }),
  rowOf(RACE, 110, { EventType: 219, MessageText: 'at the start of the day', Time: T(111) - 86400 }),
  rowOf(RACE, 110, { EventType: 219, MessageText: 'just after the start', Time: T(111) - 86399 }),
  rowOf(RACE, 110, { EventType: 219, MessageText: 'at the end', Time: T(111) }),
  rowOf(RACE, 110, { EventType: 219, MessageText: 'at the start of the hour', Time: T(111) - 3600 }),
  rowOf(RACE, 110, { EventType: 341, MessageText: 'game master in the day', SMOnly: 1, Time: T(111) - 100 }),
  rowOf(RACE, 110, { EventType: 60, MessageText: 'noise in the day', Time: T(111) - 50 }),
]

const SAVED = { ledger: ledgerOf(100, 110) }

const readOf = async (d, database, options = {}) => d.readDiagnostic(database, { GameID: 1, RaceID: RACE, GameTime: T(111), ...options })

const diagnosisOf = async (d, database, seconds, options = {}) => d.diagnose(await readOf(d, database, options), seconds)

// ---------- the checks of the utilities ----------

const UNIT = []
const unit = (id, name, run) => UNIT.push({ id, name, run })

unit('window-inside', 'a window inside what a capture covers, clear of its oldest and newest increments, is observed and counts the rows in it', async ({ a }) => {
  const rows = BUSY()
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows }))
  const seen = a.windowState(record, T(103), T(108))

  assert.equal(seen.state, 'observed')
  assert.equal(seen.observedRows, rows.filter((row) => row.RaceID === RACE && row.Time > T(103) && row.Time <= T(108)).length)
  assert.deepEqual(seen.gaps, [])
  assert.deepEqual(seen.openStretches, [])
})

unit('window-tail', 'a window that meets the newest increment of the record is partial', async ({ a }) => {
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows: BUSY() }))
  const seen = a.windowState(record, T(107), T(111))

  assert.equal(seen.state, 'partial')
  assert.ok(seen.openStretches.some((stretch) => stretch.kind === 'tail'))
  assert.equal(a.windowState(record, T(107), T(110)).state, 'observed')
})

unit('window-head', 'a window that meets the oldest increment of the record is partial', async ({ a }) => {
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows: BUSY() }))
  const seen = a.windowState(record, T(100), T(102))

  assert.equal(seen.state, 'partial')
  assert.ok(seen.openStretches.some((stretch) => stretch.kind === 'head'))
  assert.equal(a.windowState(record, T(101), T(104)).state, 'observed')
})

unit('window-before-after', 'a window that reaches before the first span or past the last is partial and counts only what the spans cover; one wholly outside is unavailable', async ({ a }) => {
  const rows = BUSY()
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows }))
  const before = a.windowState(record, T(98), T(103))
  const after = a.windowState(record, T(105), T(113))

  assert.equal(before.state, 'partial')
  assert.equal(before.observedRows, rows.filter((row) => row.RaceID === RACE && row.Time > T(98) && row.Time <= T(103)).length)
  assert.equal(after.state, 'partial')
  assert.equal(after.observedRows, rows.filter((row) => row.RaceID === RACE && row.Time > T(105) && row.Time <= T(113)).length)
  assert.equal(a.windowState(record, T(95), T(98)).state, 'unavailable')
  assert.equal(a.windowState(record, T(115), T(118)).state, 'unavailable')
})

unit('window-gap', 'a window that meets a gap between two observed spans is partial, one inside the gap is unavailable', async ({ a }) => {
  const first = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 103), rows: [...noise(100, 103), rowOf(9, 100)] }), T(104))
  const window = await a.readLogWindow(databaseOf({ ledger: ledgerOf(107, 110), rows: [...noise(107, 110), rowOf(9, 107)] }), 1)
  const read = await a.readRaceEvents(databaseOf({ ledger: ledgerOf(107, 110), rows: [...noise(107, 110), rowOf(9, 107)] }), { GameID: 1, RaceID: RACE, t: T(111), window })
  const record = a.mergeCapture(first, read.capture, { now: () => 2 }).record
  const across = a.windowState(record, T(102), T(109))

  assert.equal(across.state, 'partial')
  assert.equal(across.gaps.length, 1)
  assert.deepEqual(across.gaps[0], { from: T(104), to: T(107) })
  assert.equal(a.windowState(record, T(104), T(107)).state, 'unavailable')
  assert.equal(a.windowState(record, T(104), T(107)).observedRows, null)
  assert.equal(a.windowState(record, T(100), T(103)).state, 'partial')
})

unit('window-failure', 'a window that holds the time of a failed read is partial, one that starts at it is not', async ({ a }) => {
  const record = a.withFailure(await archiveOf(a, databaseOf({ ...SAVED, rows: BUSY() })), { at: 1, t: T(106), reason: 'disk I/O error' })
  const holding = a.windowState(record, T(103), T(108))

  assert.equal(holding.state, 'partial')
  assert.equal(holding.failures.length, 1)
  assert.equal(a.windowState(record, T(106), T(108)).failures.length, 0)
  assert.equal(a.windowState(record, T(107), T(109)).state, 'observed')
})

unit('window-cut', 'a window that ends at or before the cap\'s cut is unavailable, one that starts before it is partial, one after it is not', async ({ a }) => {
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows: noise(100, 110) }))
  const { record: capped } = a.capRecord(record, 5)

  assert.equal(capped.cut, T(106))
  assert.equal(a.windowState(capped, T(103), T(106)).state, 'unavailable')
  assert.equal(a.windowState(capped, T(103), T(106)).observedRows, null)

  const across = a.windowState(capped, T(104), T(109))

  assert.equal(across.state, 'partial')
  assert.equal(across.cut, T(106))

  const after = a.windowState(capped, T(107), T(109))

  assert.equal(after.state, 'observed')
  assert.equal(after.cut, null)
})

unit('window-cut-clear', 'a window that starts before the cut a clear made of a record well below the cap is partial, and the reason it gives does not say the cap did it', async ({ a, d }) => {
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows: noise(100, 110) }))
  const cleared = a.eventsFrom(record, T(106))

  assert.ok(a.recordEvents(cleared) < 20, 'the record is far below the cap')
  assert.equal(cleared.cut, T(106))

  const across = a.windowState(cleared, T(104), T(109))

  assert.equal(across.state, 'partial')
  assert.equal(across.cut, T(106))
  assert.equal(/\bcap\b/i.test(d.REASON_TEXT.cut), false)
})

unit('window-none', 'no record, or a record with no span, has no window to read', async ({ a }) => {
  assert.equal(a.windowState(null, T(100), T(105)).state, 'unavailable')
  assert.equal(a.windowState(null, T(100), T(105)).observedRows, null)
  assert.equal(a.windowState({ increments: [], spans: [], revision: 0, captures: [], conflicts: [] }, T(100), T(105)).state, 'unavailable')
})

unit('bases', 'the newest and oldest increments are open by what the record knows of them: a capture or the tip, the increments it keeps, or nothing but the span', async ({ a }) => {
  const sparse = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 110), rows: [...noise(103, 105), rowOf(9, 100)] }))
  const ends = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 110), rows: [rowOf(RACE, 100), rowOf(RACE, 110)] }))
  const bare = (record) => ({ ...record, captures: [], tip: undefined })

  // Only the span: nothing says how the first and the last increments were read, so everything up to the first event and after the last is open.
  const nothing = bare(sparse)

  assert.equal(a.windowState(nothing, T(100), T(102)).state, 'partial')
  assert.equal(a.windowState(nothing, T(100), T(102)).openStretches[0].basis, 3)
  assert.equal(a.windowState(nothing, T(103), T(106)).state, 'observed')
  assert.equal(a.windowState(nothing, T(106), T(108)).state, 'partial')
  assert.equal(a.windowState(nothing, T(106), T(108)).openStretches.find((stretch) => stretch.kind === 'tail').basis, 3)

  // The increments the record keeps: the first and the last of them are open.
  const kept = bare(ends)

  assert.equal(a.windowState(kept, T(100), T(101)).openStretches[0].basis, 2)
  assert.equal(a.windowState(kept, T(100), T(101)).state, 'partial')
  assert.equal(a.windowState(kept, T(101), T(110)).state, 'observed')
  assert.equal(a.windowState(kept, T(109), T(111)).state, 'partial')
  assert.equal(a.windowState(kept, T(109), T(111)).openStretches.find((stretch) => stretch.kind === 'tail').basis, 2)

  // A capture and a tip: the same stretches by the capture's own first increment and the tip.
  assert.equal(a.windowState(ends, T(100), T(101)).openStretches[0].basis, 1)
  assert.equal(a.windowState(ends, T(101), T(110)).state, 'observed')
  assert.equal(a.windowState(ends, T(109), T(111)).openStretches.find((stretch) => stretch.kind === 'tail').basis, 1)
})

unit('tip-closes', 'a tip later than the last event closes the increments between them, and without a tip they stay open', async ({ a }) => {
  const record = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 110), rows: noise(100, 105) }))

  assert.equal(a.windowState(record, T(106), T(110)).state, 'observed')
  assert.equal(a.windowState({ ...record, captures: [], tip: undefined }, T(106), T(110)).state, 'partial')
})

unit('fork', 'a record cut to a fork keeps its early increments closed and the newest one open', async ({ a }) => {
  const record = await archiveOf(a, databaseOf({ ...SAVED, rows: noise(100, 110) }))
  const file = { version: a.EVENT_ARCHIVE_VERSION, races: { [RACE]: record } }
  const forked = a.eventsUpTo(file, T(106)).races[RACE]

  assert.equal(a.windowState(forked, T(101), T(103)).state, 'observed')
  assert.equal(a.windowState(forked, T(104), T(106)).state, 'partial')
  assert.equal(a.windowState(forked, T(104), T(108)).state, 'partial')
})

unit('events-listed', 'the window lists the watched events of the race in it, the window open at its start and closed at its end, with the fingerprint of each row and the copies of identical rows', async ({ d }) => {
  const rows = BUSY()
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 86400)
  const expected = expectedRows(rows, RACE, T(111) - 86400, T(111))

  assert.deepEqual(diagnosis.window, { from: T(111) - 86400, to: T(111), seconds: 86400 })
  assert.deepEqual(observationsOf(diagnosis), groupsOf(expected))
  assert.equal(diagnosis.observed, expected.length)
  assert.equal(diagnosis.observations.find((observation) => observation.type === 119 && observation.copies === 3).copies, 3)
  assert.ok(!diagnosis.observations.some((observation) => observation.message === 'at the start of the day'))
  assert.ok(diagnosis.observations.some((observation) => observation.message === 'at the end'))
  assert.ok(!diagnosis.observations.some((observation) => observation.message === 'another race'))
})

unit('events-counts', 'each watched type counts the rows observed of it and names its newest, and a type with none counts 0 where the window is read', async ({ d }) => {
  const rows = BUSY()
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 2592000)
  const expected = expectedRows(rows, RACE, T(111) - 2592000, T(111))

  d.WATCHED.forEach((entry) => {
    const own = expected.filter((row) => row.EventType === entry.type)
    const seen = diagnosis.types.find((item) => item.type === entry.type)

    assert.equal(seen.count, own.length, `type ${entry.type}`)
    assert.equal(seen.newest, own.length ? Math.max(...own.map((row) => row.Time)) : null, `type ${entry.type}`)
  })
  assert.equal(diagnosis.types.find((item) => item.type === 341).count, 0)
})

unit('game-master', 'a game-master-only row is never listed or counted', async ({ d }) => {
  const rows = [...noise(100, 110), rowOf(RACE, 109, { EventType: 341, SMOnly: 1, MessageText: 'only the game master' }), rowOf(RACE, 110, { EventType: 341, SMOnly: 1, MessageText: 'again', Time: T(111) - 10 })]
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 2592000)

  assert.equal(diagnosis.observations.length, 0)
  assert.equal(diagnosis.observed, 0)
  assert.equal(diagnosis.verdict, 'absent')
  assert.equal(diagnosis.types.find((item) => item.type === 341).count, 0)
})

unit('identical-rows', 'identical rows keep their multiplicity and rows that differ in one field stay apart', async ({ d }) => {
  const rows = [...noise(100, 110), ...same(RACE, 110, 3, { EventType: 119, MessageText: 'same' }), rowOf(RACE, 110, { EventType: 119, MessageText: 'same', Xcor: 5 }), rowOf(RACE, 109, { EventType: 119, MessageText: 'same' })]
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 2592000)

  assert.deepEqual(diagnosis.observations.map((observation) => observation.copies).sort(), [1, 1, 3])
  assert.equal(diagnosis.observed, 5)
  assert.equal(diagnosis.types.find((item) => item.type === 119).count, 5)
})

unit('event-states', 'each event carries the state of its own increment: the newest and oldest increment of the read are partial, those between observed', async ({ d }) => {
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY() }), 2592000)
  const byIncrement = (increment) => diagnosis.observations.filter((observation) => observation.increment[0] === increment)

  assert.ok(byIncrement(110).length > 0 && byIncrement(108).length > 0 && byIncrement(109).length > 0)
  byIncrement(110).forEach((observation) => assert.equal(observation.state, 'partial'))
  byIncrement(108).forEach((observation) => assert.equal(observation.state, 'observed'))
  byIncrement(109).forEach((observation) => assert.equal(observation.state, 'observed'))
  assert.equal(diagnosis.state, 'partial')
})

unit('window-states', 'the checklist\'s window ends at the newest increment of the read; a read alone leaves it partial for its newest increment, and the reasons say so', async ({ d }) => {
  const short = await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY() }), 86400)
  const long = await diagnosisOf(d, databaseOf({ ledger: ledgerOf(107, 110), rows: [...noise(107, 110), rowOf(9, 107)] }), 2592000)

  assert.equal(short.state, 'partial')
  assert.deepEqual(short.reasons, ['tail'])
  assert.equal(long.state, 'partial')
  assert.ok(long.reasons.includes('before') && long.reasons.includes('head') && long.reasons.includes('tail'))
})

unit('observed-by-archive', 'a window whose newest increment the archive knows closed is observed, with the status of a confirmed result and every event observed', async ({ d, a }) => {
  const rows = BUSY()
  const archive = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 112), rows }), T(113))
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 2592000, { archive })

  assert.equal(diagnosis.state, 'observed')
  assert.deepEqual(diagnosis.reasons, [])
  assert.equal(diagnosis.results.events.status, 'confirmed')
  assert.ok(diagnosis.observations.length > 0)
  diagnosis.observations.forEach((observation) => assert.equal(observation.state, 'observed'))
})

unit('archive-gap', 'a window that reaches into a stretch neither the archive nor the save holds is partial and names the gap', async ({ d, a }) => {
  const archive = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 105), rows: [...noise(100, 105), rowOf(RACE, 105, { EventType: 220, MessageText: 'archived' })] }), T(106))
  const diagnosis = await diagnosisOf(d, databaseOf({ ledger: ledgerOf(107, 110), rows: [...noise(107, 110), rowOf(9, 107)] }), 2592000, { archive })

  assert.equal(diagnosis.state, 'partial')
  assert.ok(diagnosis.reasons.includes('gap'))
  assert.ok(diagnosis.observations.some((observation) => observation.message === 'archived'))
})

unit('verdict-absent', 'a window read with no watched event is absent, still partial where its newest increment may change, and never unavailable or found', async ({ d }) => {
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows: noise(100, 110) }), 86400)

  assert.equal(diagnosis.verdict, 'absent')
  assert.equal(diagnosis.observed, 0)
  assert.equal(diagnosis.state, 'partial')
  assert.equal(diagnosis.results.events.status, 'estimated')
  assert.deepEqual(diagnosis.observations, [])
  diagnosis.types.forEach((entry) => assert.equal(entry.count, 0))
})

unit('verdict-found', 'a window with a watched event is found and its result is estimated while partial', async ({ d }) => {
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY() }), 86400)

  assert.equal(diagnosis.verdict, 'found')
  assert.equal(diagnosis.results.events.status, 'estimated')
  assert.ok(diagnosis.results.events.inputs.missing.length > 0)
})

unit('verdict-unavailable', 'an empty log, and a failed read with no archive, are unavailable, never absent, and the window is placed at the save\'s game time', async ({ d }) => {
  const empty = await diagnosisOf(d, databaseOf({ ...SAVED, rows: [] }), 86400)
  const failed = await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY(), failLog: true }), 86400)

  assert.equal(empty.verdict, 'unavailable')
  assert.equal(empty.state, 'unavailable')
  assert.equal(empty.results.events.status, 'unavailable')
  assert.deepEqual(empty.observations, [])
  assert.equal(empty.window.to, T(111))
  assert.equal(failed.verdict, 'unavailable')
  assert.equal(failed.results.events.status, 'unavailable')
  assert.ok(failed.failed.includes('the log could not be read'))
  assert.deepEqual(failed.observations, [])
})

unit('failed-with-archive', 'a failed read with an archive leaves the archive\'s rows, the window partial and the failure named', async ({ d, a }) => {
  const archive = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 108), rows: [...noise(100, 108), rowOf(RACE, 108, { EventType: 220, MessageText: 'archived combat' })] }), T(109))
  const diagnosis = await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY(), failLog: true }), 2592000, { archive })

  assert.equal(diagnosis.state, 'partial')
  assert.ok(diagnosis.reasons.includes('failure'))
  assert.ok(diagnosis.reasons.includes('after'))
  assert.equal(diagnosis.verdict, 'found')
  assert.ok(diagnosis.observations.some((observation) => observation.message === 'archived combat'))
  assert.ok(diagnosis.failed.includes('the log could not be read'))
})

unit('no-window', 'no game time and no read place no window', async ({ d }) => {
  assert.equal(d.diagnose(await readOf(d, databaseOf({ ...SAVED, rows: [] }), { GameTime: null }), 86400), null)
  assert.equal(d.diagnose(await readOf(d, databaseOf({ ...SAVED, rows: [] }), { GameTime: undefined }), 86400), null)
})

unit('verdict-text', 'each verdict has a sentence of its own, the singular and the plural of the found verdict differ, and no sentence claims that nothing happened or that the race is safe', async ({ d }) => {
  const table = d.VERDICT_TEXT
  const sentences = [table.found.one, table.found.many, table.absent, table.unavailable]

  assert.equal(new Set(sentences).size, 4)
  sentences.forEach((sentence) => assert.ok(sentence.length > 20 && !BANNED.test(sentence), sentence))
  assert.ok(Object.isFrozen(table) && Object.isFrozen(table.found))
})

unit('hidden-types', 'the event types the race hid in the game are marked, and a table that cannot be read is unknown, never none', async ({ d }) => {
  const rows = BUSY()
  const seen = await diagnosisOf(d, databaseOf({ ...SAVED, rows, hidden: [119, 372] }), 86400)
  const unread = await diagnosisOf(d, databaseOf({ ...SAVED, rows, failHidden: true }), 86400)

  assert.equal(seen.types.find((entry) => entry.type === 119).hidden, true)
  assert.equal(seen.types.find((entry) => entry.type === 220).hidden, false)
  assert.equal(seen.results.hidden.status, 'confirmed')
  assert.deepEqual(seen.results.hidden.value, [119, 372])
  unread.types.forEach((entry) => assert.equal(entry.hidden, null))
  assert.equal(unread.results.hidden.status, 'unavailable')
  assert.equal(unread.results.hidden.value, null)
})

unit('listed-types', 'a watched type the event table lacks is marked, and a table that cannot be read is unknown', async ({ d }) => {
  const rows = BUSY()
  const seen = await diagnosisOf(d, databaseOf({ ...SAVED, rows, listed: [119, 220] }), 86400)
  const unread = await diagnosisOf(d, databaseOf({ ...SAVED, rows, failTypes: true }), 86400)

  assert.equal(seen.types.find((entry) => entry.type === 119).listed, true)
  assert.equal(seen.types.find((entry) => entry.type === 297).listed, false)
  unread.types.forEach((entry) => assert.equal(entry.listed, null))
  assert.equal(unread.results.types.status, 'unavailable')
})

unit('fleet-unread', 'ship, fleet and boarding-party state is never read: that input is unavailable whatever the log holds', async ({ d }) => {
  const found = await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY() }), 86400)
  const empty = await diagnosisOf(d, databaseOf({ ...SAVED, rows: [] }), 86400)

  assert.equal(found.results.fleet.status, 'unavailable')
  assert.equal(empty.results.fleet.status, 'unavailable')
  assert.ok(found.results.fleet.inputs.missing.length > 0)
})

unit('scope', 'a race reads only its own rows, and the same read for another race shows that race\'s', async ({ d }) => {
  const rows = BUSY()
  const database = databaseOf({ ...SAVED, rows })
  const mine = await d.diagnose(await d.readDiagnostic(database, { GameID: 1, RaceID: RACE, GameTime: T(111) }), 2592000)
  const other = await d.diagnose(await d.readDiagnostic(database, { GameID: 1, RaceID: OTHER, GameTime: T(111) }), 2592000)

  assert.ok(!mine.observations.some((observation) => observation.message === 'another race'))
  assert.deepEqual(other.observations.map((observation) => observation.message), ['another race'])
  assert.equal(other.types.find((entry) => entry.type === 119).count, 0)
})

unit('archive-unchanged', 'reading the archive and the save never changes the archive, a capped one included', async ({ d, a }) => {
  const archive = await archiveOf(a, databaseOf({ ledger: ledgerOf(100, 108), rows: BUSY().filter((row) => row.IncrementID <= 108) }), T(109))
  const capped = a.capRecord(archive, 3).record
  const before = JSON.stringify(archive)
  const cappedBefore = JSON.stringify(capped)

  assert.ok(Number.isFinite(capped.cut))
  await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY() }), 2592000, { archive })
  await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY(), failLog: true }), 2592000, { archive })
  await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY() }), 2592000, { archive: capped })
  await diagnosisOf(d, databaseOf({ ...SAVED, rows: BUSY(), failLog: true }), 2592000, { archive: capped })
  assert.equal(JSON.stringify(archive), before)
  assert.equal(JSON.stringify(capped), cappedBefore)
})

unit('capped-archive', 'an archive at its cap does not hide what the open save still holds: the same save gives the same window with the archive off and on', async ({ d, a }) => {
  const CAP = 25000
  const bulk = (from, to) => Array.from({ length: to - from + 1 }, (_item, at) => same(RACE, from + at, 5000, { MessageText: `bulk ${from + at}` })).flat()
  const live = rowOf(RACE, 105, { EventType: 119, MessageText: 'live fire evidence' })
  const database = databaseOf({ ...SAVED, rows: [...bulk(100, 110), live] })
  const capped = a.capRecord(await archiveOf(a, database), CAP).record
  const before = JSON.stringify(capped)

  assert.ok(a.EVENT_CAPS.includes(CAP))
  assert.equal(a.recordEvents(capped), CAP)
  assert.equal(capped.cut, T(106))
  assert.ok(!capped.increments.some((increment) => increment[0] === 105))

  const off = await diagnosisOf(d, database, 2592000)
  const on = await diagnosisOf(d, database, 2592000, { archive: capped })

  assert.equal(off.verdict, 'found')
  assert.deepEqual(observationsOf(off), groupsOf([live]))
  assert.deepEqual(observationsOf(on), observationsOf(off))
  assert.equal(on.verdict, off.verdict)
  assert.equal(on.observed, off.observed)
  assert.equal(on.state, off.state)
  assert.deepEqual(on.reasons, off.reasons)
  assert.equal(JSON.stringify(capped), before)
})

unit('window-length', 'a shorter window drops the older events and starts at the end less its length', async ({ d }) => {
  const rows = BUSY()
  const hour = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 3600)
  const day = await diagnosisOf(d, databaseOf({ ...SAVED, rows }), 86400)

  assert.equal(hour.window.from, T(111) - 3600)
  assert.deepEqual(hour.observations.map((observation) => observation.message), ['at the end'])
  assert.ok(day.observed > hour.observed)
})

unit('watched-set', 'the watched types are the six fire and boarding types, all of the Combat category', async ({ d }) => {
  assert.ok(sameSet(d.WATCHED.map((entry) => entry.type), WATCHED_TYPES))
  d.WATCHED.forEach((entry) => {
    assert.equal(entry.category, 'combat')
    assert.ok(typeof entry.icon === 'string' && entry.icon.length > 0)
    assert.ok(['fire', 'boarding'].includes(entry.group))
  })
})

// ---------- planted faults and rewrites of the utilities ----------

const swap = (file, from, to) => ({ [file]: patched(`${file}.js`, sourceOf(file), from, to) })

/* eslint-disable no-template-curly-in-string */
const UNIT_FAULTS = [
  { name: 'a window is observed whatever it reaches', sources: () => swap('event-archive', "const state = unavailable ? 'unavailable' : !inside || gaps.length || openStretches.length || failures.length || (cut !== null && from < cut) ? 'partial' : 'observed'", "const state = unavailable ? 'unavailable' : 'observed'"), fails: ['window-tail', 'window-head', 'window-gap', 'window-failure'] },
  { name: 'a gap between spans is not listed', sources: () => swap('event-archive', '.filter((gap) => meets(gap.from, gap.to, from, to))', '.filter(() => false)'), fails: ['window-gap'] },
  { name: 'the gap between spans is not named as a reason', sources: () => swap('log-diagnostics', 'if (gaps.slice(1).some(meets)) {', 'if (false) {'), fails: ['archive-gap'] },
  { name: 'the reach before the first span is not named as a reason', sources: () => swap('log-diagnostics', 'if (gaps.length && meets(gaps[0])) {', 'if (false) {'), fails: ['window-states'] },
  { name: 'the reach past the newest span is not named as a reason', sources: () => swap('log-diagnostics', 'if (coverage.spans.length && coverage.spans[coverage.spans.length - 1][1] < coverage.to) {', 'if (false) {'), fails: ['failed-with-archive'] },
  { name: 'the oldest and newest increments are never open', sources: () => swap('event-archive', 'const openStretches = stretches.filter((stretch) => meets(stretch.from, stretch.to, from, to))', 'const openStretches = []'), fails: ['window-tail', 'window-head', 'bases'] },
  { name: 'a failed read inside the window is not told', sources: () => swap('event-archive', 'const state = unavailable ? \'unavailable\' : !inside || gaps.length || openStretches.length || failures.length ||', 'const state = unavailable ? \'unavailable\' : !inside || gaps.length || openStretches.length ||'), fails: ['window-failure'] },
  { name: 'the cap\'s cut is not told', sources: () => swap('event-archive', 'cut: cut !== null && from < cut ? cut : null,', 'cut: null,'), fails: ['window-cut'] },
  { name: 'a window no span meets is not unavailable', sources: () => swap('event-archive', 'const unavailable = !record || !meeting.length || (cut !== null && to <= cut)', 'const unavailable = !record'), fails: ['window-before-after', 'window-gap', 'window-none'] },
  { name: 'a count of rows is 0 where nothing covers the window', sources: () => swap('event-archive', "const observedRows = coverage.state === 'unavailable' ? null :", "const observedRows = coverage.state === 'unavailable' ? 0 :"), fails: ['window-gap', 'window-none', 'window-cut'] },
  { name: 'the oldest increment is closed when only the span says where it starts', sources: () => swap('event-archive', 'stretches.push({ kind: \'head\', from: start, to: retained ? Math.min(end, retained[1]) : end, basis: 3 })', 'stretches.push({ kind: \'head\', from: start, to: start, basis: 3 })'), fails: ['bases'] },
  { name: 'the newest increment is closed when only the span says where it ends', sources: () => swap('event-archive', 'stretches.push({ kind: \'tail\', from: Math.max(start, inside.length ? endOf(inside[inside.length - 1]) : start), to: end, basis: 3 })', 'stretches.push({ kind: \'tail\', from: end, to: end, basis: 3 })'), fails: ['bases', 'tip-closes'] },
  { name: 'the state of the window is observed whatever the coverage says', sources: () => swap('log-diagnostics', 'state: coverage.state,', "state: 'observed',"), fails: ['window-states', 'verdict-absent', 'event-states'] },
  { name: 'a game-master-only row is listed', sources: () => swap('log-diagnostics', ' && !group[GAME_MASTER]', ''), fails: ['game-master', 'events-listed'] },
  { name: 'identical rows are listed once', sources: () => swap('log-diagnostics', 'copies: group[EVENT_FIELDS.length], state: stateOf(increment)', 'copies: 1, state: stateOf(increment)'), fails: ['identical-rows', 'events-listed'] },
  { name: 'each event takes the state of the window, not of its increment', sources: () => swap('log-diagnostics', 'state: stateOf(increment) })', 'state: coverage.state })'), fails: ['event-states'] },
  { name: 'a window nothing covers is absent', sources: () => swap('log-diagnostics', "const verdict = coverage.state === 'unavailable' ? 'unavailable' : observed ? 'found' : 'absent'", "const verdict = observed ? 'found' : 'absent'"), fails: ['verdict-unavailable'] },
  { name: 'a failed read with an archive is left out of the window', sources: () => swap('log-diagnostics', 'if (failed && archive) {', 'if (false) {'), fails: ['failed-with-archive'] },
  { name: 'the event types of a hidden table that cannot be read are none', sources: () => swap('log-diagnostics', 'hidden: hidden === null ? null : hidden.has(entry.type)', 'hidden: hidden !== null && hidden.has(entry.type)'), fails: ['hidden-types'] },
  { name: 'the window starts at the start, counting the row at its edge', sources: () => swap('log-diagnostics', 'group[TIME] > from &&', 'group[TIME] >= from &&'), fails: ['events-listed', 'window-length'] },
  { name: 'every type of the log is listed', sources: () => swap('log-diagnostics', 'if (WATCHED_BY_TYPE.has(group[TYPE]) &&', 'if ('), fails: ['events-listed'] },
  { name: 'the archive is changed by the read', sources: () => swap('log-diagnostics', 'return mergeCapture(withoutCut(archive), capture, { now: () => 0 }).record', 'if (archive) {\n      archive.increments = []\n    }\n\n    return mergeCapture(withoutCut(archive), capture, { now: () => 0 }).record'), fails: ['archive-unchanged'] },
  { name: 'the cap\'s cut of the archive is applied to the open save\'s read', sources: () => swap('log-diagnostics', 'return mergeCapture(withoutCut(archive), capture, { now: () => 0 }).record', 'return mergeCapture(archive, capture, { now: () => 0 }).record'), fails: ['capped-archive'] },
  { name: 'the reason of a cut worded as the cap having dropped the events', sources: () => swap('log-diagnostics', "cut: 'the archive no longer holds the oldest events, and the window starts before the cut',", "cut: 'the archive dropped the oldest events at its cap, and the window starts before the cut',"), fails: ['window-cut-clear'] },
  { name: 'the cut is taken off the archive itself', sources: () => swap('log-diagnostics', 'const withoutCut = (archive) => (archive ? { ...archive, cut: undefined } : archive)', 'const withoutCut = (archive) => {\n  if (archive) {\n    archive.cut = undefined\n  }\n\n  return archive\n}'), fails: ['archive-unchanged', 'capped-archive'] },
  { name: 'the ship and fleet input is read as present', sources: () => swap('log-diagnostics', "fleet: unavailable({ rule: 'logDiagnostic.fleet', missing: ['ship, fleet and boarding-party state'] })", "fleet: envelope({ value: [], status: 'confirmed', rule: 'logDiagnostic.fleet', inputs: { present: ['ships'] } })"), fails: ['fleet-unread'] },
  { name: 'the unknown verdict is worded as the absent one', sources: () => swap('log-diagnostics', "unavailable: 'Unknown. No read of the log covers this window, so nothing can be said of it.',", "unavailable: 'None of the watched event types was found in the observed part of this window. The log keeps only what the game wrote, so this says nothing about the game beyond the log.',"), fails: ['verdict-text'] },
  { name: 'the absent verdict is worded as safe', sources: () => swap('log-diagnostics', "absent: 'None of the watched event types was found in the observed part of this window. The log keeps only what the game wrote, so this says nothing about the game beyond the log.',", "absent: 'Nothing happened in this window: the race is safe.',"), fails: ['verdict-text'] },
  { name: 'a page fault leaves out the race transition its check reads', pageFaults: () => PAGE_FAULTS.map((fault, index) => (index === 0 ? { ...fault, screens: ['window:0'] } : fault)), fails: ['fault-screens'] },
  { name: 'a page fault leaves out every window its check reads', pageFaults: () => PAGE_FAULTS.map((fault, index) => (index === 3 ? { ...fault, screens: ['broken'] } : fault)), fails: ['fault-screens'] },
  { name: 'a benign page rewrite leaves out screens of the head', pageRewrites: () => PAGE_REWRITES.map((rewrite, index) => (index === 0 ? { ...rewrite, screens: ['window:0'] } : rewrite)), fails: ['fault-screens'] },
  { name: 'the head leaves a hole in its four saved windows', headWindows: () => { const windows = Array.from({ length: 4 }, () => ({})); delete windows[2]; return windows }, fails: ['fault-screens'] },
]

const UNIT_REWRITES = [
  { name: 'the reasons worded another way', sources: () => swap('log-diagnostics', "gap: 'a stretch of the window lies in a gap between observed spans'", "gap: 'part of the window falls in a gap between observed spans'") },
  { name: 'the verdict decided by parenthesised conditions', sources: () => swap('log-diagnostics', "const verdict = coverage.state === 'unavailable' ? 'unavailable' : observed ? 'found' : 'absent'", "const verdict = (coverage.state === 'unavailable') ? 'unavailable' : (observed > 0) ? 'found' : 'absent'") },
  { name: 'the observations sorted by an equivalent comparison', sources: () => swap('log-diagnostics', 'observations.sort((a, b) => b.time - a.time || b.increment[0] - a.increment[0] || a.type - b.type)', 'observations.sort((a, b) => (a.time !== b.time ? b.time - a.time : a.increment[0] !== b.increment[0] ? b.increment[0] - a.increment[0] : a.type - b.type))') },
  { name: 'the cut taken off a copy of the archive another way', sources: () => swap('log-diagnostics', '{ ...archive, cut: undefined }', 'Object.assign({}, archive, { cut: undefined })') },
  { name: 'the fault screen declarations listed in reverse order', pageFaults: () => PAGE_FAULTS.map((fault) => (fault.screens ? { ...fault, screens: fault.screens.slice().reverse() } : fault)).reverse() },
]

/* eslint-enable no-template-curly-in-string */

// ---------- the save and the page ----------

const SAVE = 'AuroraDB.db'
const GAME = 140
const GAME_NAME = 'Aurelian Empire'
const PLAYER = 784
const QUIET = 795
const BROKEN = 786
const REAL_TIP = 359010
const REAL_TIP_TIME = 9485081425
const REAL_LEN = 432000
const PT = (id) => REAL_TIP_TIME - (REAL_TIP - id) * REAL_LEN
const END = PT(REAL_TIP + 1)
const HEAD = 359007
const TIMEOUT = 120000
const BANNED = /\b(safe|safely|no combat|no fighting|nothing happened|nothing has happened|all clear|no boarding|no fire|did not happen|never happened)\b/i
const VOICE = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i
const FAILED_FETCH = 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)'
const WINDOW_SECONDS = [3600, 86400, 432000, 2592000]
// The window the page opens on, the last day (the suite's own statement of it, never the module's), and the title the section navigation names the checklist by.
const DEFAULT_SECONDS = WINDOW_SECONDS[1]
const CHECKLIST_TITLE = 'Short-interval checklist'
const SQL_WATCHED = WATCHED_TYPES.join(', ')

const openRaw = (file, mode) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(raw)))
})

const all = (raw, sql, params = []) => new Promise((resolve, reject) => raw.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))))

const run = (raw, sql, params = []) => new Promise((resolve, reject) => raw.run(sql, params, (error) => (error ? reject(error) : resolve())))

const FIELDS = ['IncrementID', 'GameID', 'RaceID', 'SMOnly', 'Time', 'EventType', 'MessageText', 'SystemID', 'Xcor', 'Ycor', 'IDType', 'PopulationID']

const SAVE_ROWS = [
  { IncrementID: REAL_TIP, EventType: 119, MessageText: 'Fire Delay: the group waits to fire.', Time: END - 40000, copies: 3 },
  { IncrementID: REAL_TIP, EventType: 220, MessageText: 'Boarding Combat: the parties fight.', Time: END - 300000, copies: 1 },
  { IncrementID: REAL_TIP, EventType: 341, MessageText: 'Attacked By AA Fire: a game-master-only row.', Time: END - 1000, copies: 1, SMOnly: 1 },
  { IncrementID: REAL_TIP, EventType: 12, MessageText: 'Targeting: noise.', Time: END - 2000, copies: 1 },
  { IncrementID: REAL_TIP - 1, EventType: 297, MessageText: 'Boarding Underway: the parties are on board.', Time: PT(REAL_TIP - 1) + 100000, copies: 1 },
  { IncrementID: REAL_TIP - 1, EventType: 60, MessageText: 'Research Completed: noise.', Time: PT(REAL_TIP - 1) + 120000, copies: 2 },
  { IncrementID: REAL_TIP - 2, EventType: 220, MessageText: 'Boarding Combat: a second fight.', Time: PT(REAL_TIP - 2) + 100000, copies: 1 },
  { IncrementID: HEAD, EventType: 342, MessageText: 'Boarding Damage: at the head of the log.', Time: PT(HEAD) + 100000, copies: 1 },
]

// A copy of the save whose log starts at increment HEAD, with the rows above written for the player's race and one type of them hidden in the game's Events window.
const makeSave = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-log-diagnostics-'))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await openRaw(file, sqlite3.OPEN_READWRITE)

  try {
    await run(raw, `delete from FCT_GameLog where GameID = ${GAME} and IncrementID < ${HEAD}`)

    for (const row of SAVE_ROWS) {
      for (let copy = 0; copy < row.copies; copy++) {
        const values = { GameID: GAME, RaceID: PLAYER, SMOnly: 0, SystemID: 0, Xcor: 0, Ycor: 0, IDType: 0, PopulationID: 0, ...row }

        await run(raw, `insert into FCT_GameLog (${FIELDS.join(', ')}) values (${FIELDS.map(() => '?').join(', ')})`, FIELDS.map((field) => values[field]))
      }
    }

    await run(raw, 'insert into FCT_HideEvents (RaceID, EventID, GameID) values (?, ?, ?)', [PLAYER, 119, GAME])
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }

  return { folder, file }
}

// What SQL says of the save: the window's rows of a race, the head and the tip of the log, the hidden types.
const truthOf = async (file) => {
  const raw = await openRaw(file, sqlite3.OPEN_READONLY)

  const [{ head }] = await all(raw, `select min(IncrementID) as head from FCT_GameLog where GameID = ${GAME}`)
  const [{ tip }] = await all(raw, `select max(IncrementID) as tip from FCT_Increments where GameID = ${GAME}`)
  const [end] = await all(raw, `select GameTime + Length as end from FCT_Increments where GameID = ${GAME} and IncrementID = ${tip}`)
  const [{ StartYear }] = await all(raw, `select StartYear from FCT_Game where GameID = ${GAME}`)
  const hidden = (await all(raw, `select EventID from FCT_HideEvents where GameID = ${GAME} and RaceID = ${PLAYER}`)).map((row) => row.EventID).filter((id) => WATCHED_TYPES.includes(id))
  // The groups of identical watched rows in a window, each with the identity the panel's hook names it by (the fingerprint of its increment and every field), read from SQL: [{ key, increment, time, type, message, copies }], newest first by the panel's promise (the game time, then the increment, both falling, then the type).
  const watchedRows = async (race, from, to) => (await all(raw, `select IncrementID, Time, EventType, MessageText, SystemID, PopulationID, Xcor, Ycor, IDType, SMOnly, count(*) as copies from FCT_GameLog where GameID = ${GAME} and RaceID = ${race} and SMOnly = 0 and EventType in (${SQL_WATCHED}) and Time > ${from} and Time <= ${to} group by IncrementID, Time, EventType, MessageText, SystemID, PopulationID, Xcor, Ycor, IDType`)).map((row) => ({ key: keyOf(row), increment: row.IncrementID, time: row.Time, type: row.EventType, message: row.MessageText, copies: row.copies })).sort((a, b) => b.time - a.time || b.increment - a.increment || a.type - b.type)
  const watched = async (race, from, to) => (await watchedRows(race, from, to)).map((row) => `${row.increment}|${row.time}|${row.type}|${row.copies}`).sort()
  const everything = async (race) => await all(raw, `select IncrementID, Time, EventType, MessageText, SystemID, PopulationID, Xcor, Ycor, IDType, SMOnly from FCT_GameLog where GameID = ${GAME} and RaceID = ${race} and IncrementID >= ${HEAD}`)

  return { head, tip, end: end.end, startYear: StartYear, hidden, watched, watchedRows, everything, close: () => new Promise((resolve) => raw.close(resolve)) }
}

const countsOf = (lines) => {
  const counts = new Map()

  lines.forEach((line) => {
    const [, , type, copies] = line.split('|')

    counts.set(Number(type), (counts.get(Number(type)) || 0) + Number(copies))
  })

  return counts
}

// What the panel shows; runs in the page, through the shared readers of scripts/lib/browser-observe.js (`installScreen`: `visible`, `visibleText`, `hooked`). The hooks the template carries name what an element is (`data-type`, `data-key`, `data-input`, `data-reason`); the values (the states, the verdict, the counts, the copies, the statuses, the reasons, the marks, the window the control draws chosen) are the text the element that draws each value draws, never its container's, read by `visibleText` when the element is on screen (`visible`, or drawing text of its own). The page gives back text only: `settled` turns each label back into its kind by the panel's own label maps and reads each numeral (`{ shown }`) as a figure, in Node. The hooks' own values are kept in `hooks` beside them, for the check that they agree.
const readPanel = () => {
  const { visible, visibleText, hooked } = window.__screen
  const seen = (element) => Boolean(element) && visible(element)
  const on = (element) => Boolean(element) && (visible(element) || visibleText(element) !== '')
  const shownText = (element) => (on(element) ? visibleText(element) : null)
  const numeral = (element) => (on(element) ? { shown: visibleText(element) } : null)
  const root = document.querySelector('[data-diagnostic]')

  if (!root) {
    return { present: false }
  }

  const one = (selector) => root.querySelector(selector)
  const field = one('[data-diagnostic-window]') ? one('[data-diagnostic-window]').closest('.v-input') : null
  const selected = field ? [...field.querySelectorAll('.v-select__selection')].filter(on).map(visibleText) : []
  const branches = [...root.querySelectorAll('[data-verdict-shown]')].filter(on).map((element) => element.getAttribute('data-verdict-shown'))
  const copiesOf = (element) => (on(element.querySelector('[data-event-copies]')) ? numeral(element.querySelector('[data-copies-value]')) || 'the chip is drawn with no visible numeral' : 1)
  const reasons = hooked(root, 'data-reason').filter((entry) => entry.on)

  return {
    present: true,
    visible: seen(root),
    summary: root.getAttribute('data-summary') || '',
    pending: seen(one('[data-diagnostic-pending]')),
    none: seen(one('[data-diagnostic-none]')),
    state: shownText(one('[data-window-state]')),
    verdict: [...root.querySelectorAll('[data-verdict-words]')].filter(on).map(visibleText),
    verdictCount: numeral(one('[data-verdict-count]')),
    separatorName: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'),
    control: { visible: seen(field), selected },
    stateShown: seen(one('[data-window-state]')),
    from: shownText(one('[data-window-from]')),
    to: shownText(one('[data-window-to]')),
    reasons: reasons.map((entry) => entry.text),
    failedRead: seen(one('[data-read-failed]')),
    verdictShown: seen(one('[data-verdict-text]')),
    types: [...root.querySelectorAll('li[data-type]:not([data-observation])')].map((element) => ({ type: Number(element.getAttribute('data-type')), name: shownText(element.querySelector('.diagnostic-name')), group: shownText(element.querySelector('.diagnostic-chip:not([data-hidden]):not([data-unlisted])')), count: { value: numeral(element.querySelector('[data-count-value]')), words: shownText(element.querySelector('.diagnostic-count')) }, newest: shownText(element.querySelector('[data-newest-date]')), marks: [...element.querySelectorAll('.diagnostic-chip')].filter(on).map(visibleText), shown: seen(element), hook: { count: element.getAttribute('data-count') === null ? null : Number(element.getAttribute('data-count')) } })),
    observations: [...root.querySelectorAll('li[data-observation]')].map((element) => ({ key: element.getAttribute('data-key'), type: Number(element.getAttribute('data-type')), name: shownText(element.querySelector('.diagnostic-event-head .diagnostic-name')), message: shownText(element.querySelector('.diagnostic-message')), state: shownText(element.querySelector('[data-event-state]')), copies: copiesOf(element), shown: seen(element), dated: seen(element.querySelector('[data-event-date]')), date: shownText(element.querySelector('[data-event-date]')), increment: shownText(element.querySelector('[data-event-increment]')), hook: { state: element.getAttribute('data-state'), copies: Number(element.getAttribute('data-copies')) } })),
    inputs: [...root.querySelectorAll('li[data-input]')].map((element) => ({ id: element.getAttribute('data-input'), status: shownText(element.querySelector('.provenance-mark__label')), shown: seen(element), hook: { status: element.getAttribute('data-status') } })),
    pointers: [...root.querySelectorAll('li[data-pointer]')].map((element) => ({ id: element.getAttribute('data-pointer'), shown: seen(element), name: shownText(element.querySelector('[data-pointer-name]')), definition: shownText(element.querySelector('[data-pointer-definition]')) })),
    hooks: { state: root.getAttribute('data-state'), verdict: root.getAttribute('data-verdict'), branches: branches.join(' and ') || null, reasons: reasons.map((entry) => entry.role) },
    text: visibleText(root),
  }
}

// What the fold of the panel shows; runs in the page, through the shared readers. The toggle as the player meets it (drawn, its `aria-expanded`, its label, the id it controls, whether it sits in the first element of the head and draws no text), the content that id names (drawn or not, holding every part under the head and none of the head), each part drawn or not, the title the section navigation takes from the head (the text of its first element outside the figures: chips, captions and secondary text), and the note drawn in the head.
const readFold = () => {
  const { visible, visibleText } = window.__screen
  const root = document.querySelector('[data-diagnostic]')

  if (!root) {
    return { present: false }
  }

  const seen = (element) => Boolean(element) && visible(element)
  const drawn = (element) => Boolean(element) && (visible(element) || visibleText(element) !== '')
  const toggle = root.querySelector('[data-diagnostic-toggle]')
  const note = root.querySelector('[data-diagnostic-note]')
  const head = root.querySelector('.panel-head')
  const title = head ? head.firstElementChild : null
  const id = toggle ? toggle.getAttribute('aria-controls') : null
  const target = id ? document.getElementById(id) : null
  const parts = [...root.querySelectorAll('[data-diagnostic-pending], [data-diagnostic-none], .diagnostic-body, [data-pointers], .panel-foot')]
  const words = []
  const field = root.querySelector('[data-diagnostic-window]') ? root.querySelector('[data-diagnostic-window]').closest('.v-input') : null

  if (title) {
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const figure = node.parentElement.closest('.v-chip, .caption, .text--secondary')

      if (!(figure && figure !== title && title.contains(figure))) {
        words.push(node.textContent)
      }
    }
  }

  return {
    present: true,
    toggle: { found: Boolean(toggle), shown: seen(toggle), expanded: toggle ? toggle.getAttribute('aria-expanded') : null, label: toggle ? toggle.getAttribute('aria-label') : null, controls: id, inTitle: Boolean(toggle && title && title.contains(toggle)), text: toggle ? visibleText(toggle) : null },
    content: { found: Boolean(target), shown: seen(target), holdsParts: Boolean(target) && parts.length > 0 && parts.every((part) => target.contains(part)), holdsHead: Boolean(target && head && target.contains(head)), parts: parts.map((part) => ({ name: part.getAttribute('data-pointers') !== null ? 'pointers' : part.classList.contains('panel-foot') ? 'foot' : part.classList.contains('diagnostic-body') ? 'body' : 'message', shown: seen(part) })) },
    note: { found: Boolean(note), text: note && drawn(note) ? visibleText(note) : null, inTitle: Boolean(note && title && title.contains(note)) },
    title: words.join(' ').replace(/\s+/g, ' ').trim(),
    control: seen(field),
    verdict: root.getAttribute('data-verdict'),
    separatorName: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'),
  }
}

// A wait of the page for a condition it shows, polled and bounded by the suite's timeout like every wait of this file (a fixed sleep is too short under load and wasted otherwise).
const until = (page, label, done, what, timeout = TIMEOUT) => waitFor({ done, what, label, clock: REAL_CLOCK, sleep: (ms) => page.waitForTimeout(ms), timeout })

// Whether the store holds the race now (the switch the page reacts to), and a tick of the page after it: the settling that follows waits out what the page reads.
const raceOpenIn = (page, RaceID) => page.evaluate(async (race) => {
  await window.$app.$nextTick()

  return window.$app.$store.getters.RaceID === race
}, RaceID)

// A wait for `done()` for no longer than `timeout` on the clock given. A wait that outlasts it fails with a message that names what is outstanding (`what()`, which may be async): the failure is the observation's, nothing was seen, so it is never credited as a product fault. Every wait loop of this file goes through it.
const waitFor = async ({ done, what, label, clock, sleep, timeout = TIMEOUT }) => {
  const started = clock.now()

  while (!(await done())) {
    if (clock.now() - started > timeout) {
      throw new Error(`${label} did not finish within ${timeout} ms: ${await what()}`)
    }

    await sleep(250)
  }
}

const REAL_CLOCK = { now: () => Date.now(), sleep: null }

// The page that `observe` opens, made ready for the Game Log of the player's race: the race picked on the Empires page, the log opened and settled, each step named through `step` and bounded by TIMEOUT. `rules.hold` makes the reads it names wait in `held` until they are let go, `rules.fail` answers the reads it names with an error. `clock` is the clock of the waits (a virtual one in the controls of the waits). The checklist is read as the first read leaves it (`opened`) and, if it is folded, unfolded through its toggle as a player does before reading it, unless `keepFold` leaves it to the observation.
const prepare = async (page, url, step, clock = REAL_CLOCK, keepFold = false) => {
  await installScreen(page)

  const state = { held: [], pending: new Map(), last: clock.now(), hold: null, fail: null }
  const sleep = (ms) => (clock.sleep ? clock.sleep(ms) : page.waitForTimeout(ms))
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !new URL(request.url()).pathname.endsWith('/stat')
  const outstanding = () => `${state.pending.size} database calls in flight${state.pending.size ? ` (${[...state.pending.values()].join('; ')})` : ''}, ${clock.now() - state.last} ms since the last, ${state.held.length} held`

  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      state.pending.set(request, `${request.method()} ${new URL(request.url()).pathname} ${String(request.postData() || '').slice(0, 120)}`.trim())
      state.last = clock.now()
    }
  })
  page.on('requestfinished', (request) => {
    if (isDatabaseCall(request)) {
      state.pending.delete(request)
      state.last = clock.now()
    }
  })
  page.on('requestfailed', (request) => {
    if (isDatabaseCall(request)) {
      state.pending.delete(request)
      state.last = clock.now()
    }
  })
  await page.route('**/__aurora-db/query', async (route) => {
    let sql = ''

    try {
      sql = JSON.parse(route.request().postData() || '{}').sql || ''
    } catch (error) {
      sql = ''
    }

    if (state.fail && state.fail(sql)) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the read was refused' }) })
    } else if (state.hold && state.hold(sql)) {
      state.held.push(route)
    } else {
      await route.continue()
    }
  })

  const settle = () => waitFor({ done: async () => !((state.pending.size > 0 && !state.held.length) || clock.now() - state.last < 1500 || await page.evaluate(pageLoading)), what: outstanding, label: 'the settling of the page', clock, sleep })

  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${GAME_NAME} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(GAME_NAME, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  step('waiting for the reads that the picking of the race starts')
  await waitFor({ done: async () => state.pending.size === 0 && clock.now() - state.last >= 1500, what: outstanding, label: 'the database reads that the picking of the race starts', clock, sleep })
  step('opening /log')
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/log')
  await page.waitForFunction(pageLoading.arrived, '/log', { timeout: TIMEOUT })
  await page.waitForSelector('[data-diagnostic] [data-window-state]', { state: 'attached', timeout: TIMEOUT })
  step('waiting for the page to settle')
  await settle()

  const opened = await unfoldFold(page, step, keepFold)

  return { state, settle, opened }
}

// The waits of `prepare` on a page that is only enough of one, and a clock that is only advanced by the sleeps: a database call that never finishes must end the wait at the suite's timeout with a message that names the call (the observation's failure, never a fault of the product), and a call that finishes before the deadline must let the wait return.
const virtualClock = (onSleep = null) => {
  const clock = { time: 0, sleeps: 0, now: () => clock.time, sleep: async (ms) => { clock.time += ms; clock.sleeps++; if (onSleep) { onSleep(clock) } } }

  return clock
}

const pretendPage = () => {
  const handlers = {}
  const picker = { locator: () => picker, filter: () => picker, first: () => picker, last: () => picker, getByText: () => picker, click: async () => {} }
  const request = { url: () => 'http://localhost/__aurora-db/query', method: () => 'POST', postData: () => JSON.stringify({ sql: 'select GameTime from FCT_Game' }) }
  const page = { handlers, request, on: (name, handler) => { handlers[name] = handler }, route: async () => {}, addInitScript: async () => {}, goto: async () => handlers.request(request), locator: () => picker, evaluate: async (work) => (work === pageLoading ? false : String(work).includes('RaceID')), waitForFunction: async () => {}, waitForSelector: async () => {}, waitForTimeout: async () => {} }

  return page
}

const failureOf = (work) => work.then(() => null, (error) => error)

unit('wait-deadline', 'a database call that never finishes ends the initial wait and the settling at the suite\'s timeout, with a message that names the call', async () => {
  const initial = virtualClock()
  const failed = await failureOf(prepare(pretendPage(), 'http://localhost/', () => {}, initial))

  assert.ok(failed instanceof Error)
  assert.ok(failed.message.includes('the database reads that the picking of the race starts did not finish within 120000 ms'), failed.message)
  assert.ok(failed.message.includes('1 database calls in flight (POST /__aurora-db/query') && failed.message.includes('select GameTime from FCT_Game'), failed.message)
  assert.ok(initial.time > TIMEOUT && initial.time <= TIMEOUT + 250, String(initial.time))

  const page = pretendPage()
  const clock = virtualClock((now) => { if (now.sleeps === 20 && page.handlers.requestfinished) { page.handlers.requestfinished(page.request) } })
  const { settle } = await prepare(page, 'http://localhost/', () => {}, clock)
  const settleStart = clock.time

  page.handlers.request(page.request)

  const settling = await failureOf(settle())

  assert.ok(settling instanceof Error)
  assert.ok(settling.message.includes('the settling of the page did not finish within 120000 ms') && settling.message.includes('select GameTime from FCT_Game'), settling.message)
  assert.ok(clock.time - settleStart > TIMEOUT && clock.time - settleStart <= TIMEOUT + 250, String(clock.time - settleStart))
})

unit('wait-completes', 'a database call that finishes before the deadline lets the initial wait and the settling return', async () => {
  const page = pretendPage()
  const clock = virtualClock((now) => { if (now.sleeps === 20) { page.handlers.requestfinished(page.request) } })
  const outcome = await failureOf(prepare(page, 'http://localhost/', () => {}, clock))

  assert.equal(outcome, null)
  assert.ok(clock.sleeps >= 20 && clock.time < TIMEOUT, String(clock.time))
  assert.ok(clock.time >= 5000 + 1500, String(clock.time))
})

// The panel's label maps, from the utilities the page draws them with: the windows offered (each by its seconds, from `WINDOWS`), the window and event states, the reasons, the verdicts (a found verdict by its count of one or many), the words of a count that is no figure, the marks of a type, the provenance statuses. `FORMAT` holds the glossary the pointers come from and the app's date formatter. Both are set before the page is first read.
let LABELS = null
let BASE_LABELS = null
let FORMAT = null

const labelsOf = (raw) => {
  const own = raw['log-diagnostics']

  return { window: Object.fromEntries(own.WINDOWS.map((entry) => [entry.seconds, entry.text])), state: { ...own.STATE_TEXT }, reason: { ...own.REASON_TEXT }, verdict: { 'found:one': own.VERDICT_TEXT.found.one, 'found:many': own.VERDICT_TEXT.found.many, absent: own.VERDICT_TEXT.absent, unavailable: own.VERDICT_TEXT.unavailable }, count: { ...own.COUNT_TEXT }, mark: { ...own.MARK_TEXT }, status: Object.fromEntries(Object.entries(raw.provenance.STATUS_MARKS).map(([status, mark]) => [status, mark.label])), names: Object.fromEntries(own.WATCHED.map((entry) => [entry.type, entry.name])), groups: { ...own.GROUPS } }
}

// The pointers the owner approved, in the order the page lists them.
const POINTERS = ['cease-fire', 'fleet-cease-fire', 'ship-open-fire', 'game-events-window']

const formatOf = (raw) => ({ terms: raw.glossary.termById, dateText: raw['history-milestones'].gameDateText })

// A drawn label turned back into its kind by a label map of the panel (scripts/lib/browser-observe.js `labelKey`): null where nothing is drawn, and a note of what was drawn where no label of the map is that text, so a label no map holds never reads as nothing drawn.
const kindOf = (labels, text) => {
  if (text === null) {
    return null
  }

  const kind = labelKey(text, labels)

  return kind === null ? `a label no map holds: ${text}` : kind
}

// A drawn numeral read whole and signed in the grouping of the page's setting (scripts/lib/browser-observe.js `readFigure`), or a note of the text where it is no figure. A value that is no `{ shown }` (nothing drawn, a count of none, a note of what was wrong) is left as it is.
const figureOf = (value, grouping) => {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const read = readFigure(value.shown, grouping)

  return read === null ? `not a figure: ${value.shown}` : read
}

// The screen as read in the page, its labels turned back into kinds by the label maps of the variant served (`LABELS`) and its numerals read as figures. A count is its numeral where one is drawn and otherwise the words of the count (not known: null, none observed: 0); the marks of a type are the chips whose words are a mark's. The window control's `selected` is the window each label it draws chosen stands for (its seconds, as a key of the window labels); `menu`, where the screen follows a choice (`chooseWindow`), adds the window asked for (`asked`) and the windows the menu drew (`choices`, null for an entry not on screen).
const settled = (screen, menu = null) => {
  if (!screen.present) {
    return screen
  }

  const labels = LABELS
  const parse = (value) => figureOf(value, screen.separatorName)
  const countOf = ({ value, words }) => {
    if (value !== null) {
      return parse(value)
    }

    const kind = words === null ? null : labelKey(words, labels.count)

    return words === null ? 'no count is drawn' : kind === 'unknown' ? null : kind === 'none' ? 0 : `a count no label holds: ${words}`
  }
  const verdictOf = (text) => kindOf(labels.verdict, text).replace(/^found:.*$/, 'found')

  return {
    ...screen,
    control: { visible: screen.control.visible, selected: screen.control.selected.map((text) => kindOf(labels.window, text)), asked: menu ? String(menu.seconds) : null, choices: menu ? menu.shown.map((text) => kindOf(labels.window, text)) : null },
    state: kindOf(labels.state, screen.state),
    verdict: screen.verdict.length ? screen.verdict.map(verdictOf).join(' and ') : null,
    verdictWords: screen.verdict.length ? screen.verdict.join(' and ') : null,
    verdictCount: parse(screen.verdictCount),
    reasons: screen.reasons.map((text) => kindOf(labels.reason, text)),
    types: screen.types.map(({ count, marks, ...entry }) => {
      const kinds = marks.map((text) => labelKey(text, labels.mark))

      return { ...entry, count: countOf(count), hidden: kinds.includes('hidden'), unlisted: kinds.includes('unlisted') }
    }),
    observations: screen.observations.map((observation) => ({ ...observation, state: kindOf(labels.state, observation.state), copies: parse(observation.copies) })),
    inputs: screen.inputs.map((input) => ({ ...input, status: kindOf(labels.status, input.status) })),
  }
}

const read = async (page, menu = null) => settled(await page.evaluate(readPanel), menu)

// The words of the note a folded panel draws in its head: the verdicts that carry no count, and the count of a found verdict before its word. They are the suite's own, never the panel's.
const NOTE_WORDS = { absent: 'None found', unavailable: 'Not covered by the log' }
const NOTE_FOUND = /^(.+) found$/

// The fold as read in the page, its note turned back into the verdict it stands for (`kind`: 'found' with its `count` read as a figure, 'absent', 'unavailable', null where none is drawn, and a note of the words where no map holds them). A panel that is not drawn is given back as it is.
const settledFold = (raw) => {
  if (!raw || !raw.present) {
    return raw
  }

  const text = raw.note.text
  const word = text === null ? undefined : Object.keys(NOTE_WORDS).find((key) => NOTE_WORDS[key] === text)
  const found = text === null || word ? null : NOTE_FOUND.exec(text)
  const kind = text === null ? null : word || (found ? 'found' : `a note no map holds: ${text}`)

  return { ...raw, note: { ...raw.note, kind, count: found ? figureOf({ shown: found[1] }, raw.separatorName) : null } }
}

const readFolded = async (page) => settledFold(await page.evaluate(readFold))

// The toggle pressed as a player presses it: clicked, and the page given the ticks and the frame that its update takes.
const flipFold = async (page) => {
  await page.locator('[data-diagnostic-toggle]').click({ timeout: 30000 })
  await page.evaluate(async () => {
    await window.$app.$nextTick()
    await window.$app.$nextTick()
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

// The checklist unfolded as a player unfolds it before reading it: the toggle pressed only where it is folded, and not at all with `keep`. The fold as it was read, before the press, is given back.
const unfoldFold = async (page, step, keep = false) => {
  const fold = await readFolded(page)

  if (!keep && fold && fold.present && fold.toggle.expanded === 'false') {
    step('the checklist is unfolded through its toggle')
    await flipFold(page)
  }

  return fold
}

// A race opened as the other switches of an observation open one: the store holds it, and the page has settled.
const openRace = async (page, settle, race, npr, what) => {
  await switchRace(page, race, npr)
  await until(page, what, () => raceOpenIn(page, race), () => 'the store does not hold the race')
  await settle()
}

const pickWindow = async (page, settle, seconds) => {
  await chooseWindow(page, seconds)
  await settle()
}

// The fold as the player meets it, read after each step, with no fold or unfold by hand until the toggle is pressed: the race with events (the first read, `opened`), the race with none, a longer window chosen, the race whose read fails opened under that window and then the day chosen, the race with events again, the race whose read fails opened under the day, the race with events once more, the shortest window and the day chosen again; then the toggle pressed to fold it, the race without events, the race with events again, the toggle pressed to unfold it, the race without events and the race whose read fails; at last the race with events open again, for the reads that follow. The windows are chosen in the menu, the toggle is clicked and each race is opened as the other switches do.
const foldSequence = async ({ page, step, state, settle, opened }) => {
  const fold = { opened }

  step('the race without events is opened')
  await openRace(page, settle, QUIET, true, 'the switch to the race without events')
  fold.quiet = await readFolded(page)
  step('a longer window is chosen')
  await pickWindow(page, settle, WINDOW_SECONDS[3])
  fold.quietWide = await readFolded(page)
  step('the race whose read fails is opened under that window')
  state.fail = isRaceLog(BROKEN)
  await openRace(page, settle, BROKEN, true, 'the switch to the race whose log fails')
  fold.brokenWide = await readFolded(page)
  step('the day is chosen')
  await pickWindow(page, settle, WINDOW_SECONDS[1])
  fold.brokenDay = await readFolded(page)
  state.fail = null
  step('the race with events is opened')
  await openRace(page, settle, PLAYER, false, 'the switch back to the race with events')
  fold.player = await readFolded(page)
  step('the race whose read fails is opened under the default window')
  state.fail = isRaceLog(BROKEN)
  await openRace(page, settle, BROKEN, true, 'the switch to the race whose log fails')
  fold.brokenArrival = await readFolded(page)
  state.fail = null
  step('the race with events is opened once more')
  await openRace(page, settle, PLAYER, false, 'the switch back to the race with events')
  step('the shortest window is chosen')
  await pickWindow(page, settle, WINDOW_SECONDS[0])
  fold.playerHour = await readFolded(page)
  step('the day is chosen again')
  await pickWindow(page, settle, WINDOW_SECONDS[1])
  step('the checklist is folded through its toggle')
  await flipFold(page)
  fold.handFold = await readFolded(page)
  step('the race without events is opened while it is folded by hand')
  await openRace(page, settle, QUIET, true, 'the switch to the race without events')
  fold.handQuiet = await readFolded(page)
  step('the race with events is opened again')
  await openRace(page, settle, PLAYER, false, 'the switch back to the race with events')
  fold.handBack = await readFolded(page)
  step('the checklist is unfolded through its toggle')
  await flipFold(page)
  fold.handOpen = await readFolded(page)
  step('the race without events is opened while it is unfolded by hand')
  await openRace(page, settle, QUIET, true, 'the switch to the race without events')
  fold.handQuiet2 = await readFolded(page)
  step('the race whose read fails is opened while it is unfolded by hand')
  state.fail = isRaceLog(BROKEN)
  await openRace(page, settle, BROKEN, true, 'the switch to the race whose log fails')
  fold.handBroken = await readFolded(page)
  state.fail = null
  step('the race with events is opened for the reads that follow')
  await openRace(page, settle, PLAYER, false, 'the switch back to the race with events')

  return fold
}

// The window of `seconds` chosen as a player chooses it: the menu of the control opened and drawn (on screen, its opening transition run out; the menu sets its own opacity a frame after it opens), the label each entry draws read (`visibleText`, null for an entry not on screen) and turned back into its window by the window labels of the variant served, and the one entry whose label is that window's pressed. Where no entry, or more than one, draws it, nothing is pressed and the menu is closed: the screen read next shows the control as it is, and the checks say what is wrong. A menu that is not drawn within 30 s is read as it is, so its entries read as not on screen. Resolves to { seconds, shown }, the labels the menu drew.
const chooseWindow = async (page, seconds) => {
  const entries = '.menuable__content__active .v-list-item'

  await page.locator('.v-input:has([data-diagnostic-window]) .v-select__slot').click({ timeout: 30000 })
  await page.waitForSelector(entries, { timeout: 30000 })
  await page.waitForFunction(() => { const menu = document.querySelector('.menuable__content__active'); return Boolean(menu) && window.__screen.visible(menu) && menu.getAnimations({ subtree: true }).length === 0 }, null, { timeout: 30000 }).catch((error) => { if (error.name !== 'TimeoutError') { throw error } })

  const shown = await page.evaluate((css) => [...document.querySelectorAll(css)].map((entry) => (window.__screen.visible(entry) || window.__screen.visibleText(entry) !== '' ? window.__screen.visibleText(entry) : null)), entries)
  const drawing = shown.map((text, at) => ({ at, kind: text === null ? null : labelKey(text, LABELS.window) })).filter(({ kind }) => kind === String(seconds))

  if (drawing.length === 1) {
    await page.locator(entries).nth(drawing[0].at).click({ timeout: 30000 })
  } else {
    await page.keyboard.press('Escape')
    await page.waitForSelector('.menuable__content__active', { state: 'detached', timeout: 30000 })
  }

  await page.evaluate(async () => { await window.$app.$nextTick() })

  return { seconds, shown }
}

const switchRace = (page, RaceID, NPR) => page.evaluate((race) => window.$app.$store.commit('setRace', race), { RaceID, NPR, SpecialNPRID: NPR ? 4 : 0 })

const isRaceLog = (race) => (sql) => new RegExp(`^select FCT_GameLog\\.IncrementID, FCT_GameLog\\.Time, .* from FCT_GameLog where FCT_GameLog\\.GameID = ${GAME} and FCT_GameLog\\.RaceID = ${race}$`).test(sql)

// The checklist's fold on its own page, as a player meets it: no read of any race but the player's before it, and the races opened in turn by `foldSequence`. It is a page of its own because a race opened once is kept by the page's reads and never read again, which the held read of `observeSaved` needs it to be.
const observeFolded = (browser, url) => observe(browser, async ({ page, step }) => {
  const { state, settle, opened } = await prepare(page, url, step, REAL_CLOCK, true)

  return { fold: await foldSequence({ page, step, state, settle, opened }) }
}, { expected: [FAILED_FETCH] })

// The head and rewrites drive every window and race transition. A fault may name just the screens its credited checks read; their reader-path requirements are checked before the drive starts. The checklist, if it opens folded, is unfolded through its toggle before the panel is read.
const observeSaved = (browser, url, screens = null) => observe(browser, async ({ page, step }) => {
  const { state, settle } = await prepare(page, url, step)
  const seen = { windows: [] }
  const wanted = (name) => screens === null || screens.includes(name)

  for (let index = 0; index < WINDOW_SECONDS.length; index++) {
    if (!wanted(`window:${index}`)) {
      continue
    }

    step(`window ${WINDOW_SECONDS[index]} is chosen`)
    const menu = await chooseWindow(page, WINDOW_SECONDS[index])

    await settle()
    seen.windows[index] = await read(page, menu)
  }

  if (screens && screens.every((name) => name.startsWith('window:'))) {
    return seen
  }

  step('the day is chosen again')
  const day = await chooseWindow(page, WINDOW_SECONDS[1])

  await settle()
  seen.day = await read(page, day)
  if (wanted('held') || wanted('quiet') || wanted('back')) {
    step('the race is switched while its read is held')
    state.hold = isRaceLog(QUIET)
    state.held.length = 0
    await switchRace(page, QUIET, true)
    // Held, and the page has asked for all else it needs: the reads in flight are the held ones, and none has started for 1.5 s.
    await until(page, 'the page with the read of the new race held', async () => state.held.length > 0 && state.pending.size <= state.held.length && Date.now() - state.last >= 1500, () => `${state.held.length} reads held, ${state.pending.size} in flight, ${Date.now() - state.last} ms since the last`)
    seen.held = { screen: await read(page), calls: state.held.length }
    state.hold = null

    for (const route of state.held.splice(0)) {
      await route.continue()
    }

    step('the held read is answered')
    await settle()
    await unfoldFold(page, step)
    seen.quiet = await read(page)
  }
  if (wanted('broken') || wanted('back')) {
    step('a race whose read fails is opened')
    state.fail = isRaceLog(BROKEN)
    await switchRace(page, BROKEN, true)
    await until(page, 'the switch to the race whose log fails', () => raceOpenIn(page, BROKEN), () => 'the store does not hold the race')
    await settle()
    await unfoldFold(page, step)
    seen.broken = await read(page)
  }
  state.fail = null
  if (wanted('back')) {
    step('the player\'s race is opened again')
    await switchRace(page, PLAYER, false)
    await until(page, 'the switch back to the player\'s race', () => raceOpenIn(page, PLAYER), () => 'the store does not hold the race')
    await settle()
    seen.back = await read(page)
  }

  return seen
}, { expected: [FAILED_FETCH] })

// The archive file stored on the branch, and the recorder's notification committed when `recorded` is set (what the recorder does after it writes the file: `history/recorded`).
const storeArchive = (page, stored, recorded) => page.evaluate(async ({ file, notify }) => {
  // eslint-disable-next-line import/no-absolute-path
  const { eventStore } = await import('/utilities/history.js')
  const campaign = window.$app.$store.getters.campaignId
  const branch = window.$app.$store.getters['history/campaign'].branchId

  eventStore(campaign, branch).store = file

  if (notify) {
    window.$app.$store.commit('history/recorded')
  }
}, { file: stored, notify: recorded })

const REGISTRY_LOCK = 'aurora-electrons:registry'

// What the store and the browser say of the recorder: the requests and the ends of passes watched since `watchRecorder`, the generation of the copy of the save, and the locks held and waited for (the recorder's pass runs as the only step on the registry lock, so a pass that is queued shows there).
const recorderState = (page) => page.evaluate(async () => {
  const locks = await navigator.locks.query()
  const store = window.$app.$store

  return { watched: window.__recorderSeen || null, generation: store.state.freshness.generation, held: locks.held.map((lock) => lock.name), pending: locks.pending.map((lock) => lock.name) }
})

const recorderLine = async (page) => {
  const state = await recorderState(page)
  const watched = state.watched ? `requests ${JSON.stringify(state.watched.requests)}, ends ${JSON.stringify(state.watched.ends)}` : 'nothing watched yet'

  return `generation ${state.generation}; since the switch: ${watched}; locks held: ${state.held.join(', ') || 'none'}; locks waited for: ${state.pending.join(', ') || 'none'}`
}

// The end of the pass that served `request` (one of the requests of `watchRecorder`): the end whose range of requests holds the request's number, on the copy of the save the request was made on. Any other end, an earlier or a later request's, is not it: passes end in any order.
const endServing = (ends, request) => ends.find((end) => end.from <= request.id && request.id <= end.to && end.generation === request.generation)

// The mutations of the store that name a pass of the recorder, collected from here on: `history/capture` (a request for a pass, numbered by the store's count of them, with the copy of the save it was made on) and `history/ended` (the end of a pass, whatever it was: the range of requests it took, the copy it ran for and its outcome). The recorder commits `history/ended` for every pass it starts (passed, failed, refused or superseded), so no end goes unannounced.
const watchRecorder = (page) => page.evaluate(() => {
  const seen = { requests: [], ends: [] }

  window.__recorderSeen = seen
  window.$app.$store.subscribe((mutation, state) => {
    if (mutation.type === 'history/capture') {
      seen.requests.push({ id: state.history.captures, generation: state.freshness.generation })
    } else if (mutation.type === 'history/ended') {
      seen.ends.push({ ...mutation.payload })
    }
  })
})

// An archive in the branch's file before the page keeps one, and the switch of the Options turned on: `file` is the archive file to store. The pass the switch asks for is waited out by its own end, never by a pause: the subscription is made before the switch, the request the switch commits is the one awaited (its number and the copy of the save it was made on), and the wait ends on the end of the pass whose range of requests holds that request, for that copy. The end of any other pass, an earlier request's or a later one's, is not that end: passes end in any order. A pass that ended as anything but passed (a read or write failed, another tab records, a newer copy replaced it) and a replaced copy of the save are the observation's failure, never success; so is a pass that does not end by the deadline, which names the locks it waits for.
const archiveOn = async (page, step, settle, file, timeout = TIMEOUT) => {
  step('the archive is stored')
  await storeArchive(page, file, false)
  await watchRecorder(page)
  step('the archive is switched on')
  await page.getByRole('button', { name: 'Game Log options' }).click({ timeout: 30000 })
  await page.locator('.v-input--switch:has-text("Keep an event archive") .v-input--selection-controls__input').click({ timeout: 30000 })
  await page.keyboard.press('Escape')
  step('the pass of the recorder that the switch asks for')
  await until(page, 'the pass of the recorder that the switch asks for', async () => {
    const state = await recorderState(page)
    const mine = state.watched.requests[0]

    if (!mine) {
      return false
    }

    if (state.generation !== mine.generation) {
      throw new Error(`the save was replaced while the pass of request ${mine.id} on copy ${mine.generation} was awaited: ${await recorderLine(page)}`)
    }

    const end = endServing(state.watched.ends, mine)

    if (!end) {
      return false
    }

    if (end.outcome !== 'passed') {
      throw new Error(`the pass of request ${mine.id} ended as ${end.outcome}: ${await recorderLine(page)}`)
    }

    return true
  }, () => recorderLine(page), timeout)
  await settle()
}

// Controls of that wait on the real recorder and the real registry lock of the page. `normal` lets the pass run. `held` holds the registry lock so that the pass queues behind it: setup must not finish while it waits, and must when the lock is let go. `deadline` holds it and never lets go: the wait ends at its deadline as the observation's failure and names the lock. `overtaken` holds the read of the switch's pass and lets a later request's pass end first: setup must not return on that end, and must report the failure when the held read fails. `earlier` has an earlier request's pass active and a second lock queued before the switch's pass: the earlier pass ends while the switch's is still queued, and setup must not finish until the switch's own pass has. `renewed` renews the copy of the save while the pass is queued: setup fails, as the page has another save. `failed` makes the recorder's read of the save fail: setup fails, with no pass passed.
const observeRecorder = (browser, url, file, mode) => observe(browser, async ({ page, step }) => {
  const { settle, state: routes } = await prepare(page, url, step)
  const seen = {}
  const hold = (name, slot, queuedOnly = false) => page.evaluate(async ({ lock, key, queuedOnly }) => {
    const granted = {}
    const done = new Promise((resolve) => { granted.now = resolve })

    window.__holds = window.__holds || {}
    navigator.locks.request(lock, () => new Promise((resolve) => {
      window.__holds[key] = resolve
      granted.now()
    }))

    if (!queuedOnly) {
      await done
    }
  }, { lock: name, key: slot, queuedOnly })
  const release = (slot) => page.evaluate((key) => window.__holds[key](), slot)
  const waiting = async () => (await recorderState(page)).pending.filter((name) => name === REGISTRY_LOCK).length
  const running = (timeout) => {
    const control = { outcome: 'running' }

    control.done = archiveOn(page, step, settle, file, timeout).then(() => { control.outcome = 'finished' }, (error) => { control.outcome = String(error.message) })

    return control
  }
  const queued = async (count) => until(page, 'the recorder queued behind the registry lock', async () => (await waiting()) >= count, () => recorderLine(page))

  if (mode === 'normal') {
    await archiveOn(page, step, settle, file)
    seen.finished = await recorderState(page)

    return seen
  }

  if (mode === 'failed') {
    routes.fail = (sql) => /FCT_Race/.test(sql)
    await archiveOn(page, step, settle, file, 30000)

    return seen
  }

  if (mode === 'overtaken') {
    let grabbed = false

    // The recorder reports the failure of the refused read with a console error whose text holds the page's address and lines of its scripts, which cannot be named exactly: it is taken here and told in the control.
    await page.evaluate(() => {
      const original = console.error

      window.__recorderErrors = []
      console.error = (...args) => (String(args[0]).startsWith('Empire history: snapshot failed') ? window.__recorderErrors.push(String(args[1] && args[1].message)) : original.apply(console, args))
    })

    routes.hold = (sql) => !grabbed && /FCT_Race/.test(sql) && (grabbed = true)

    const control = running()

    await until(page, 'the read of the pass of the switch held', async () => routes.held.length === 1 && (await recorderState(page)).watched.requests.length === 1, () => recorderLine(page))
    step('a later request for a pass is made and passes while the read of the first is held')
    await page.evaluate(() => window.$app.$store.commit('history/capture'))
    await until(page, 'the end of the later request\'s pass', async () => (await recorderState(page)).watched.ends.length >= 1, () => recorderLine(page))
    // A pause that is the control itself: setup must not have returned on the end of the later request's pass.
    await page.waitForTimeout(4000)
    seen.between = { outcome: control.outcome, state: await recorderState(page) }
    step('the held read of the first pass is refused')
    await routes.held[0].fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the read was refused' }) })
    await control.done
    seen.released = { outcome: control.outcome, state: await recorderState(page), reported: await page.evaluate(() => window.__recorderErrors) }

    return seen
  }

  step('the registry lock is held')
  await hold(REGISTRY_LOCK, 'first')

  if (mode === 'deadline') {
    await archiveOn(page, step, settle, file, 4000)

    return seen
  }

  if (mode === 'renewed') {
    const control = running()

    await queued(1)
    step('the save is renewed while the pass is queued')
    await page.evaluate(() => window.$app.$store.dispatch('renew', { storagePath: window.$app.$store.state.databasePath }))
    await control.done
    seen.renewed = { outcome: control.outcome }
    await release('first')

    return seen
  }

  if (mode === 'earlier') {
    step('an earlier request for a pass is made and queued')
    await page.evaluate(() => window.$app.$store.commit('history/capture'))
    await queued(1)
    step('a second hold of the registry lock is queued after the earlier pass')
    await hold(REGISTRY_LOCK, 'second', true)

    const control = running()

    await queued(3)
    step('the first lock is let go: the earlier pass runs and ends')
    await release('first')
    await until(page, 'the end of the earlier pass', async () => (await recorderState(page)).watched.ends.length >= 1, () => recorderLine(page))
    // A pause that is the control itself: the switch's pass is queued behind the second hold, and the wait must not have returned in these 4 s.
    await page.waitForTimeout(4000)
    seen.between = { outcome: control.outcome, state: await recorderState(page) }
    step('the second lock is let go')
    await release('second')
    await control.done
    seen.released = { outcome: control.outcome, state: await recorderState(page) }

    return seen
  }

  const control = running()

  await queued(1)
  // A pause that is the control itself, not a wait for a condition: the pass is held, and the old wait (1.5 s without a write, then 1.5 s of settling) would have returned inside these 4 s.
  await page.waitForTimeout(4000)
  seen.held = { outcome: control.outcome, state: await recorderState(page) }
  step('the registry lock is let go')
  await release('first')
  await control.done
  seen.released = { outcome: control.outcome, state: await recorderState(page) }

  return seen
}, { expected: mode === 'overtaken' ? [FAILED_FETCH] : [] })

const controlOf = (name, seen, test) => {
  if (seen.error !== null) {
    return report(name, `the page was not observed: ${failureLine(seen)}`)
  }

  try {
    test(seen.value)
    report(name, true)
  } catch (error) {
    report(name, String(error.message).split('\n')[0])
  }
}

// A control whose setup must fail: no value, and an error that says what happened (the observation's failure, never credit to the page).
const failureControl = (name, seen, sentences) => {
  const missing = sentences.filter((sentence) => typeof seen.error !== 'string' || !seen.error.includes(sentence))

  report(name, seen.value === null && !missing.length ? true : `${seen.value === null ? '' : 'the observation has a value; '}${missing.length ? `the error lacks "${missing[0]}": ` : ''}${String(seen.error).split('\n')[0]}`)
}

const recorderControls = async (browser, url, file) => {
  const ended = (state) => state.watched.ends.filter((end) => end.outcome === 'passed')

  controlOf('the wait for the recorder returns when the pass has ended: the pass of the request the switch made ended as passed for the copy of the save open', await observeRecorder(browser, url, file, 'normal'), ({ finished }) => {
    assert.equal(finished.watched.requests.length, 1)
    assert.ok(ended(finished).includes(endServing(finished.watched.ends, finished.watched.requests[0])), JSON.stringify(finished.watched))
  })
  controlOf('the wait for the recorder does not return while the pass is queued behind the registry lock, and returns once the lock is let go with the pass ended', await observeRecorder(browser, url, file, 'held'), ({ held, released }) => {
    assert.equal(held.outcome, 'running')
    assert.ok(held.state.pending.includes(REGISTRY_LOCK), JSON.stringify(held.state.pending))
    assert.deepEqual(held.state.watched.ends, [])
    assert.equal(released.outcome, 'finished')
    assert.ok(ended(released.state).includes(endServing(released.state.watched.ends, released.state.watched.requests[0])), JSON.stringify(released.state.watched))
  })
  controlOf('the wait for the recorder is not released by the end of an earlier pass: the earlier pass ends while the pass the switch asked for is still queued, setup has not returned, and it returns once that pass has ended', await observeRecorder(browser, url, file, 'earlier'), ({ between, released }) => {
    assert.equal(between.outcome, 'running')
    assert.ok(between.state.pending.includes(REGISTRY_LOCK), JSON.stringify(between.state.pending))
    assert.equal(between.state.watched.ends.length, 1)
    assert.ok(between.state.watched.ends[0].to < between.state.watched.requests[0].id, JSON.stringify(between.state.watched))
    assert.equal(released.outcome, 'finished')
    assert.ok(ended(released.state).includes(endServing(released.state.watched.ends, released.state.watched.requests[0])), JSON.stringify(released.state.watched))
  })
  controlOf('the wait for the recorder is not released by the end of a later request\'s pass: the switch\'s pass has its read held, a later request\'s pass passes first, setup has not returned, and when the held read fails setup reports the failure of the pass of its own request', await observeRecorder(browser, url, file, 'overtaken'), ({ between, released }) => {
    assert.equal(between.outcome, 'running')
    assert.equal(between.state.watched.requests.length, 2)
    assert.equal(endServing(between.state.watched.ends, between.state.watched.requests[0]), undefined, JSON.stringify(between.state.watched))
    assert.equal(endServing(between.state.watched.ends, between.state.watched.requests[1]).outcome, 'passed', JSON.stringify(between.state.watched))
    assert.ok(released.outcome.includes('the pass of request 1 ended as failed'), released.outcome)
    assert.deepEqual(released.reported, ['[web] /query: the read was refused'])
    assert.equal(endServing(released.state.watched.ends, released.state.watched.requests[0]).outcome, 'failed', JSON.stringify(released.state.watched))
  })
  failureControl('a pass that does not end by the deadline is the failure of the observation (no value, no credit to the page), and the message names the lock the pass waits for', await observeRecorder(browser, url, file, 'deadline'), ['the pass of the recorder that the switch asks for did not finish within 4000 ms', `${REGISTRY_LOCK}; locks waited for: ${REGISTRY_LOCK}`])
  controlOf('a save renewed while the pass is queued ends the wait as a failure: setup does not succeed on the new copy', await observeRecorder(browser, url, file, 'renewed'), ({ renewed }) => {
    assert.ok(renewed.outcome.includes('the save was replaced while the pass of request'), renewed.outcome)
  })
  failureControl('a recorder whose read of the save fails ends the wait as a failure naming the outcome, never as success', await observeRecorder(browser, url, file, 'failed'), ['the pass of request 1 ended as failed'])
}

const observeArchived = (browser, url, file, windows) => observe(browser, async ({ page, step }) => {
  const { settle } = await prepare(page, url, step)

  await archiveOn(page, step, settle, file)

  const seen = { windows: [] }

  for (const index of windows) {
    step(`window ${WINDOW_SECONDS[index]} is chosen`)
    const menu = await chooseWindow(page, WINDOW_SECONDS[index])

    await settle()
    seen.windows[index] = await read(page, menu)
  }

  return seen
})

// The archive of the branch rewritten while the page shows the day, each rewrite followed by the recorder's notification and nothing else (no reload, no other action): `files` are the archive files to store in turn. The value is { windows: [], before, failure, restored, coverage }, the day as read before each store and after it.
const observeRefreshed = (browser, url, file, files) => observe(browser, async ({ page, step }) => {
  const { settle } = await prepare(page, url, step)

  await archiveOn(page, step, settle, file)
  step('the day is chosen')
  const day = await chooseWindow(page, WINDOW_SECONDS[1])

  await settle()

  const seen = { windows: [], before: await read(page, day) }

  for (const [name, stored] of Object.entries(files)) {
    step(`the archive is rewritten as "${name}" and the recorder reports it`)
    await storeArchive(page, stored, true)
    await settle()
    seen[name] = await read(page)
  }

  return seen
})

// ---------- the checks of the page ----------

const expectedState = (truth, id) => (id === truth.head || id === truth.tip ? 'partial' : 'observed')

const incrementOf = (observation) => JSON.parse(observation.key)[0]

const PAGE_CHECKS = []
const pageCheck = (id, observation, name, test) => PAGE_CHECKS.push({ id, observation, name, run: test })

// The checks of one observation, and those that hold for all of them: 'any' for the pages that show the panel's windows, 'every' for the fold's page as well.
const forKind = (item, kind) => item.observation === kind || item.observation === 'every' || (item.observation === 'any' && kind !== 'fold')

const windowScreens = (o) => o.windows.filter(Boolean)
const windowPositions = (windows) => windows.map((screen, index) => (screen ? index : null))

pageCheck('panel', 'saved', 'the panel is on screen at every window with its summary, a window control whose menu draws the four windows and which draws the window chosen, a window range, a state and a verdict', async ({ o }) => {
  assert.deepEqual(windowPositions(o.windows), [0, 1, 2, 3])
  o.windows.forEach((screen, index) => {
    assert.ok(screen.present && screen.visible, `window ${index}`)
    assert.ok(screen.summary.trim().length > 0)
    assert.equal(screen.control.visible, true)
    assert.deepEqual(screen.control.choices, WINDOW_SECONDS.map(String), `window ${index}: the windows the menu draws, read back through their labels`)
    assert.deepEqual(screen.control.selected, [String(WINDOW_SECONDS[index])], `window ${index}: the window the control draws chosen, read back through its label`)
    assert.ok(screen.from && screen.to && screen.stateShown && screen.verdictShown)
    assert.ok(['observed', 'partial', 'unavailable'].includes(screen.state))
    assert.equal(screen.pending, false)
  })
})

// Every screen read after a window was chosen (`chooseWindow`), on every page: the window asked for was pressed by the label the menu drew for it, so the menu draws the four windows in order, and the control then draws that window chosen. The seconds are the suite's own (`WINDOW_SECONDS`), never the module's.
pageCheck('window-chosen', 'any', 'each window is chosen in the menu by the label drawn for it: the menu draws the four windows in order, and the control then draws the window asked for', async ({ o }) => {
  const chosen = screensOf(o).filter((screen) => screen.control.asked !== null)

  assert.ok(chosen.length > 0, 'no screen follows the choice of a window')
  chosen.forEach((screen, index) => {
    assert.deepEqual(screen.control.choices, WINDOW_SECONDS.map(String), `screen ${index}: the windows the menu draws, read back through their labels`)
    assert.deepEqual(screen.control.selected, [screen.control.asked], `screen ${index}: the window the control draws chosen, read back through its label, against the window asked for`)
  })
})

pageCheck('window-state', 'saved', 'a window ending at the newest increment of the save is partial for that increment, and a window that reaches before the log or meets its oldest increment says so too', async ({ o }) => {
  o.windows.slice(0, 3).forEach((screen, index) => {
    assert.equal(screen.state, 'partial', `window ${index}`)
    reasonsAre(screen, ['tail'], `window ${index}`)
  })
  assert.equal(o.windows[3].state, 'partial')
  reasonsAre(o.windows[3], ['before', 'head', 'tail'], 'window 3')
})

// The rows of a list of the screen paired with the oracle's rows by identity (scripts/lib/browser-observe.js `pairedBy`), never by place: a row missing, listed twice or of an identity the oracle has not, and two rows of the oracle of one identity, fail. The pairs [row, line].
const paired = (what, lines, rows, idOfLine, idOfRow) => {
  const { pairs, problems } = pairedBy(what, lines, rows, idOfLine, idOfRow)

  assert.deepEqual(problems, [], `${what}: the rows drawn are not the oracle's`)

  return pairs
}

// The reasons a screen draws, each the kind its words read as, against the reasons expected: each drawn once, and no other.
const reasonsAre = (screen, expected, label) => paired(`${label}: the reasons`, screen.reasons, expected, (kind) => kind, (kind) => kind)

// The watched types a screen lists, by type: each watched type has one line of its own.
const typesOf = (screen, label) => new Map(paired(`${label}: the watched types`, screen.types, WATCHED_TYPES, (entry) => entry.type, (type) => type))

// The inputs a panel tells, each once.
const INPUTS = ['events', 'hidden', 'types', 'fleet']

// The status each input of a screen is drawn with, by the input's id.
const statusesOf = (screen, label) => Object.fromEntries(paired(`${label}: the inputs`, screen.inputs, INPUTS, (input) => input.id, (id) => id).map(([id, input]) => [id, input.status]))

// The text of a message as the page shows it: the whitespace the browser collapses in the save's text (ASCII spaces, tabs and line breaks) runs together, as in any element, and every other character is kept.
const plainOf = (text) => String(text).replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '')

// The listed rows of a screen against the groups SQL holds, each row by its identity (the key its hook names: the increment, the time, the type and every field of the group): every group of the oracle is listed once and every row is a group's, and then each row's own displayed date, increment, type name, message and copies are compared with its group's, never a list of them with another.
const listedAs = (screen, groups, truth, labels, label) => {
  const dateOf = (seconds) => FORMAT.dateText(truth.startYear, seconds)

  for (const [group, observation] of paired(`${label}: the events listed`, screen.observations, groups, (line) => line.key, (row) => row.key)) {
    assert.match(observation.increment || '', /^\d+$/, `${label}, ${observation.key} increment`)
    assert.equal(observation.increment, String(group.increment), `${label}, ${observation.key} increment`)
    assert.equal(observation.date, dateOf(group.time), `${label}, ${observation.key} date`)
    assert.equal(observation.type, group.type, `${label}, ${observation.key} type`)
    assert.equal(observation.name, labels.names[group.type], `${label}, ${observation.key} type name`)
    assert.equal(observation.message, plainOf(group.message), `${label}, ${observation.key} message`)
    assert.equal(observation.copies, group.copies, `${label}, ${observation.key} copies`)
  }
}

pageCheck('events', 'saved', 'every window lists the events SQL says the race\'s log holds of the watched types in it, one entry for each group of identical rows, with the type counts, the dates of its range and of each event and the sentence of its verdict', async ({ o, truth, labels }) => {
  // The dates are the oracle's game times written by the app's shared date formatter, which this check does not test.
  const dateOf = (seconds) => FORMAT.dateText(truth.startYear, seconds)

  for (const [index, screen] of o.windows.entries()) {
    if (!screen) {
      continue
    }

    const groups = await truth.watchedRows(PLAYER, truth.end - WINDOW_SECONDS[index], truth.end)
    const expected = await truth.watched(PLAYER, truth.end - WINDOW_SECONDS[index], truth.end)

    listedAs(screen, groups, truth, labels, `window ${index}`)
    assert.equal(screen.verdict, expected.length ? 'found' : 'absent', `window ${index}`)

    const counts = countsOf(expected)
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
    const types = typesOf(screen, `window ${index}`)

    WATCHED_TYPES.forEach((type) => assert.equal(types.get(type).count, counts.get(type) || 0, `window ${index}, type ${type}`))
    assert.equal(screen.verdictCount, expected.length ? total : null, `window ${index}`)
    assert.equal(screen.verdictWords, expected.length ? labels.verdict[total === 1 ? 'found:one' : 'found:many'] : labels.verdict.absent, `window ${index}`)
    assert.equal(screen.from, dateOf(truth.end - WINDOW_SECONDS[index]), `window ${index} range start`)
    assert.equal(screen.to, dateOf(truth.end), `window ${index} range end`)
    WATCHED_TYPES.forEach((type) => {
      const times = groups.filter((group) => group.type === type).map((group) => group.time)
      const entry = types.get(type)

      assert.equal(entry.name, labels.names[type], `window ${index}, type ${type} name`)
      assert.equal(entry.group, FIRE_TYPES.includes(type) ? labels.groups.fire : labels.groups.boarding, `window ${index}, type ${type} group`)
      assert.equal(entry.newest, times.length ? dateOf(Math.max(...times)) : null, `window ${index}, type ${type} newest`)
    })
  }
})

pageCheck('event-order', 'saved', 'every window lists its events newest first: the game time falling, then the increment, then the type, each row placed by the group it names', async ({ o, truth }) => {
  for (const [index, screen] of o.windows.entries()) {
    if (!screen) {
      continue
    }

    const groups = await truth.watchedRows(PLAYER, truth.end - WINDOW_SECONDS[index], truth.end)
    const byKey = new Map(groups.map((group) => [group.key, group]))
    const placeOf = (group) => `${group.time}|${group.increment}|${group.type}`

    assert.deepEqual(screen.observations.map((observation) => placeOf(byKey.get(observation.key) || {})), groups.map(placeOf), `window ${index}`)
  }
})

pageCheck('event-copies', 'saved', 'identical rows are one entry that says how many they are', async ({ o }) => {
  const fire = o.windows[1].observations.filter((observation) => observation.type === 119)

  assert.equal(fire.length, 1)
  assert.equal(fire[0].copies, 3)
})

pageCheck('event-states', 'saved', 'each event carries the state of its own increment: the newest and the oldest increment of the read partial, the ones between observed', async ({ o, truth }) => {
  const longest = o.windows[3]

  assert.ok(longest.observations.length >= 5)
  longest.observations.forEach((observation) => assert.equal(observation.state, expectedState(truth, incrementOf(observation)), `increment ${incrementOf(observation)}`))
  assert.ok(longest.observations.some((observation) => observation.state === 'observed'))
  assert.ok(longest.observations.some((observation) => observation.state === 'partial'))
  assert.ok(longest.observations.every((observation) => observation.shown && observation.dated))
})

pageCheck('game-master', 'saved', 'a game-master-only event is neither listed nor counted', async ({ o }) => {
  windowScreens(o).forEach((screen) => {
    assert.ok(!screen.observations.some((observation) => observation.type === 341))
    assert.equal(typesOf(screen, 'a window').get(341).count, 0)
  })
})

pageCheck('hidden-flag', 'saved', 'a watched type the race hid in the game\'s Events window is marked and the others are not', async ({ o, truth }) => {
  assert.deepEqual(truth.hidden, [119])
  for (const [type, entry] of typesOf(o.windows[1], 'the day')) {
    assert.equal(entry.hidden, truth.hidden.includes(type), `type ${type}`)
    assert.equal(entry.unlisted, false, `type ${type}`)
  }
})

pageCheck('inputs', 'saved', 'the inputs are told with their status: the log estimated while partial, the hidden types and the event table confirmed, the ships and fleets unavailable', async ({ o }) => {
  const statuses = statusesOf(o.windows[1], 'the day')

  assert.deepEqual(statuses, { events: 'estimated', hidden: 'confirmed', types: 'confirmed', fleet: 'unavailable' })
  assert.ok(o.windows[1].inputs.every((input) => input.shown))
})

pageCheck('pointers', 'saved', 'the four checks of the game itself are named in the owner-approved order, each with the text of its glossary term', async ({ o, terms }) => {
  o.windows.forEach((screen) => {
    assert.deepEqual(screen.pointers.map((pointer) => pointer.id), POINTERS)
    screen.pointers.forEach((pointer) => {
      const term = terms[pointer.id]

      const words = (text) => text.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '')

      assert.ok(pointer.shown, pointer.id)
      assert.equal(pointer.name, words(term.term), `${pointer.id} name`)
      assert.equal(pointer.definition, words(term.definition), `${pointer.id} definition`)
    })
  })
})

pageCheck('race-switch', 'saved', 'a race switched while its read is held shows nothing of the race before, and the read, when answered, shows the new race\'s rows', async ({ o, truth, labels }) => {
  assert.ok(o.held.calls > 0)
  assert.ok(!o.held.screen.present || (o.held.screen.observations.length === 0 && o.held.screen.verdict === null && o.held.screen.types.every((entry) => entry.count === null)))

  const groups = await truth.watchedRows(QUIET, truth.end - WINDOW_SECONDS[1], truth.end)
  const expected = groups

  listedAs(o.quiet, groups, truth, labels, 'the race switched to')
  assert.equal(o.quiet.verdict, expected.length ? 'found' : 'absent')
  assert.equal(o.quiet.state, 'partial')
})

pageCheck('unavailable-read', 'saved', 'a race whose read of the log failed is unavailable: no verdict of nothing, no count of 0, the failure named', async ({ o }) => {
  assert.equal(o.broken.verdict, 'unavailable')
  assert.equal(o.broken.state, 'unavailable')
  assert.equal(o.broken.failedRead, true)
  assert.equal(o.broken.observations.length, 0)
  o.broken.types.forEach((entry) => assert.equal(entry.count, null, `type ${entry.type}`))
  assert.equal(statusesOf(o.broken, 'the race whose read failed').events, 'unavailable')
})

pageCheck('no-claims', 'saved', 'the empty and the unavailable states never claim that nothing happened, and no text of the panel speaks in the first or second person', async ({ o }) => {
  const states = [o.quiet, o.broken, o.windows[0]]

  assert.equal(o.quiet.verdict, 'absent')
  assert.equal(o.windows[0].verdict, 'absent')
  states.forEach((screen) => assert.ok(!BANNED.test(screen.text), screen.text.match(BANNED) && screen.text.match(BANNED)[0]))
  ;[...o.windows, o.held.screen, o.quiet, o.broken, o.back].filter((screen) => screen.present).forEach((screen) => assert.ok(!VOICE.test(screen.text), screen.text.match(VOICE) && screen.text.match(VOICE)[0]))
})

pageCheck('back', 'saved', 'the player\'s race read again after the others shows what it showed before', async ({ o }) => {
  assert.equal(o.back.state, o.day.state)
  assert.equal(o.back.verdict, o.day.verdict)

  for (const [before, again] of paired('the events of the player\'s race read again', o.back.observations, o.day.observations, (line) => line.key, (row) => row.key)) {
    const drawn = (observation) => ({ type: observation.type, name: observation.name, message: observation.message, date: observation.date, increment: observation.increment, copies: observation.copies, state: observation.state })

    assert.deepEqual(drawn(again), drawn(before), `the event ${before.key} read again`)
  }

  assert.deepEqual(o.back.observations.map((observation) => observation.key), o.day.observations.map((observation) => observation.key), 'the order of the events read again')
})

// The verdict SQL gives a race for the default window and the count of the events it holds.
const defaultOf = async (truth, race) => {
  const lines = await truth.watched(race, truth.end - DEFAULT_SECONDS, truth.end)

  return { verdict: lines.length ? 'found' : 'absent', total: [...countsOf(lines).values()].reduce((sum, count) => sum + count, 0) }
}

// Whether the toggle of a fold read says the checklist is folded, after the panel is found drawn with a toggle that says one or the other.
const foldedOf = (fold, label) => {
  assert.ok(fold && fold.present, `${label}: the panel is drawn`)
  assert.equal(fold.toggle.found, true, `${label}: the toggle`)
  assert.ok(['true', 'false'].includes(fold.toggle.expanded), `${label}: aria-expanded is ${fold.toggle.expanded}`)

  return fold.toggle.expanded === 'false'
}

pageCheck('fold-rule', 'fold', 'the checklist opens folded exactly when the default window (the last day) holds no found event, decided on arrival for each read scope by the window then chosen: unfolded for the race with events, folded for the race with none and for none that can be read in the default window, and unfolded in another window; the fixture holds a race with events and a race without in the default window', async ({ o, truth }) => {
  const player = await defaultOf(truth, PLAYER)
  const quiet = await defaultOf(truth, QUIET)

  assert.equal(player.verdict, 'found', 'the race with events holds one in the default window')
  assert.equal(quiet.verdict, 'absent', 'the race without events holds none in the default window')

  const arrivals = [['opened', 'found', DEFAULT_SECONDS], ['quiet', 'absent', DEFAULT_SECONDS], ['brokenWide', 'unavailable', WINDOW_SECONDS[3]], ['player', 'found', DEFAULT_SECONDS], ['brokenArrival', 'unavailable', DEFAULT_SECONDS]]

  for (const [name, verdict, seconds] of arrivals) {
    assert.equal(o.fold[name].verdict, verdict, `${name}: the verdict of the checklist that arrived`)
    assert.equal(foldedOf(o.fold[name], name), seconds === DEFAULT_SECONDS && verdict !== 'found', `${name}: folded on arrival (${verdict}, window ${seconds})`)
  }
})

pageCheck('fold-stays', 'fold', 'a window chosen after the checklist arrived never folds or unfolds it: a folded checklist stays folded under a longer window, and one opened under a longer window stays open when the default window is chosen, whatever its verdict, and when a window with no event is chosen', async ({ o }) => {
  assert.equal(foldedOf(o.fold.quietWide, 'quietWide'), true, 'the longer window is chosen on a folded checklist')
  assert.equal(foldedOf(o.fold.brokenDay, 'brokenDay'), false, 'the default window is chosen on a checklist opened under a longer window, whose verdict is not found')
  assert.equal(foldedOf(o.fold.playerHour, 'playerHour'), false, 'a window with no event is chosen on an open checklist')
})

pageCheck('fold-hand', 'fold', 'a fold or unfold by hand through the toggle stands for the rest of the visit, over what the rule says for each race that is opened after it', async ({ o }) => {
  assert.equal(foldedOf(o.fold.handFold, 'handFold'), true, 'the toggle folds an open checklist')
  assert.equal(foldedOf(o.fold.handQuiet, 'handQuiet'), true, 'a checklist folded by hand stays folded for the race without events')
  assert.equal(foldedOf(o.fold.handBack, 'handBack'), true, 'a checklist folded by hand stays folded for the race with events, which the rule opens')
  assert.equal(foldedOf(o.fold.handOpen, 'handOpen'), false, 'the toggle unfolds a folded checklist')
  assert.equal(foldedOf(o.fold.handQuiet2, 'handQuiet2'), false, 'a checklist unfolded by hand stays open for the race without events, which the rule folds')
  assert.equal(foldedOf(o.fold.handBroken, 'handBroken'), false, 'a checklist unfolded by hand stays open for the race whose read fails, which the rule folds')
})

pageCheck('fold-toggle', 'fold', 'the toggle is drawn in the first element of the head, draws no text, says what it does (Show or Hide the checklist) and whether the content is shown, and controls the one element that holds every part below the head; that content is drawn exactly when the checklist is not folded; while it is folded a note of the verdict (None found, Not covered by the log, or the count found) is drawn apart from the title, and none while it is not; the window control is drawn either way', async ({ o, truth }) => {
  const player = await defaultOf(truth, PLAYER)

  for (const [name, fold] of Object.entries(o.fold)) {
    const folded = foldedOf(fold, name)

    assert.equal(fold.toggle.shown, true, `${name}: the toggle is drawn`)
    assert.equal(fold.toggle.inTitle, true, `${name}: the toggle sits in the first element of the head`)
    assert.equal(fold.toggle.text, '', `${name}: the toggle draws no text`)
    assert.equal(fold.toggle.label, folded ? 'Show the checklist' : 'Hide the checklist', `${name}: the label of the toggle`)
    assert.equal(fold.content.found, true, `${name}: the element the toggle controls (${fold.toggle.controls})`)
    assert.equal(fold.content.holdsParts, true, `${name}: the content holds every part below the head`)
    assert.equal(fold.content.holdsHead, false, `${name}: the content holds nothing of the head`)
    assert.equal(fold.content.shown, !folded, `${name}: the content is drawn exactly when the checklist is not folded`)
    assert.ok(fold.content.parts.length >= 3, `${name}: the parts`)
    fold.content.parts.forEach((part) => assert.equal(part.shown, !folded, `${name}: the ${part.name} is drawn exactly when the checklist is not folded`))
    assert.equal(fold.control, true, `${name}: the window control is drawn`)
    assert.ok(fold.title.startsWith(CHECKLIST_TITLE), `${name}: the title is ${fold.title}`)
    assert.equal(fold.note.inTitle || !fold.note.found, true, `${name}: the note is drawn in the first element of the head`)

    if (folded) {
      assert.equal(fold.note.kind, fold.verdict, `${name}: the note stands for the verdict`)
      assert.equal(fold.note.count, fold.verdict === 'found' ? player.total : null, `${name}: the count of the note`)
      assert.ok(!fold.title.includes(fold.note.text), `${name}: the note is no part of the title (${fold.title})`)
    } else {
      assert.equal(fold.note.text, null, `${name}: no note is drawn while the checklist is open`)
    }
  }
})

pageCheck('gap', 'older', 'an archive that stops before the save starts leaves a gap in a window that reaches into it, and what only the archive holds is listed with the state of its increment', async ({ o, seeded }) => {
  const thirty = o.windows[3]

  assert.equal(thirty.state, 'partial')
  assert.ok(thirty.reasons.includes('gap'))
  assert.ok(!thirty.reasons.includes('before'))

  const archived = thirty.observations.filter((observation) => observation.type === 219)

  assert.equal(archived.length, 1)
  assert.equal(incrementOf(archived[0]), seeded.older)
  assert.equal(archived[0].state, 'partial')
  assert.ok(!o.windows[1] || !o.windows[1].reasons.includes('gap'))
})

pageCheck('archive-refresh', 'refresh', 'an archive rewritten while the page shows the checklist and then reported by the recorder changes the window at once, with no reload: an in-window failure at the same event revision makes it partial with the failure named and the log input estimated, the archive as it was makes it observed again, and spans and tip that no longer close the newest increment make it partial for that increment', async ({ o }) => {
  const statusOf = (screen, label) => statusesOf(screen, label).events

  assert.equal(o.before.state, 'observed')
  reasonsAre(o.before, [], 'before')
  assert.equal(statusOf(o.before, 'before'), 'confirmed')
  assert.equal(o.failure.state, 'partial')
  reasonsAre(o.failure, ['failure'], 'failure')
  assert.equal(statusOf(o.failure, 'failure'), 'estimated')
  assert.equal(o.restored.state, 'observed')
  reasonsAre(o.restored, [], 'restored')
  assert.equal(statusOf(o.restored, 'restored'), 'confirmed')
  assert.equal(o.coverage.state, 'partial')
  reasonsAre(o.coverage, ['tail'], 'coverage')
  assert.equal(statusOf(o.coverage, 'coverage'), 'estimated')
})

pageCheck('observed-window', 'ahead', 'an archive that is ahead of the save leaves a window it covers observed, with every event observed and the log input confirmed', async ({ o, seeded }) => {
  for (const index of [0, 1, 2, 3]) {
    const screen = o.windows[index]

    assert.equal(screen.state, 'observed', `window ${index}`)
    reasonsAre(screen, [], `window ${index}`)
    assert.equal(statusesOf(screen, `window ${index}`).events, 'confirmed', `window ${index}`)
    screen.observations.forEach((observation) => assert.equal(observation.state, 'observed', `window ${index}, increment ${incrementOf(observation)}`))
  }

  assert.equal(o.windows[0].verdict, 'absent')
  assert.ok(o.windows[3].observations.some((observation) => incrementOf(observation) === seeded.older && observation.type === 219))
  assert.ok(o.windows[3].observations.some((observation) => incrementOf(observation) === HEAD && observation.type === 342))
})

// Every screen of an observation, the panel drawn.
const screensOf = (o) => [...o.windows.filter(Boolean), ...['day', 'quiet', 'broken', 'back', 'before', 'failure', 'restored', 'coverage'].map((key) => o[key]), o.held && o.held.screen].filter((screen) => screen && screen.present)

pageCheck('hooks', 'any', 'the hooks the panel carries for the next item say what it draws: the state, the verdict and the reasons of the window, the count of each type, the state and copies of each event, the status of each input, and what each row draws of its own identity', async ({ o, truth, labels }) => {
  screensOf(o).forEach((screen, index) => {
    screen.observations.forEach((observation) => {
      const [increment, time, type] = JSON.parse(observation.key)

      assert.equal(observation.increment, String(increment), `screen ${index}, ${observation.key} increment`)
      assert.equal(observation.date, FORMAT.dateText(truth.startYear, time), `screen ${index}, ${observation.key} date`)
      assert.equal(observation.type, type, `screen ${index}, ${observation.key} type`)
      assert.equal(observation.name, labels.names[type], `screen ${index}, ${observation.key} type name`)
      assert.equal(observation.message, plainOf(JSON.parse(observation.key)[3]), `screen ${index}, ${observation.key} message`)
    })
    assert.equal(screen.hooks.state, screen.state, `screen ${index}`)
    assert.equal(screen.hooks.verdict, screen.verdict, `screen ${index}`)
    assert.equal(screen.hooks.branches, screen.verdict, `screen ${index}`)
    assert.deepEqual(screen.hooks.reasons, screen.reasons, `screen ${index}`)
    screen.types.forEach((entry) => assert.equal(entry.hook.count, entry.count, `screen ${index}, type ${entry.type}`))
    screen.observations.forEach((observation) => assert.deepEqual(observation.hook, { state: observation.state, copies: observation.copies }, `screen ${index}, ${observation.key}`))
    screen.inputs.forEach((input) => assert.equal(input.hook.status, input.status, `screen ${index}, input ${input.id}`))
  })
})

pageCheck('no-errors', 'every', 'the page raises no error that no check named', async ({ unexpected }) => {
  assert.deepEqual(unexpected, [])
})

// ---------- planted faults and rewrites of the page ----------

const swapText = (from, to) => (text) => patched('the page file', text, from, to)

// Several changes of one file, applied in turn.
const chain = (...changes) => (text) => changes.reduce((current, change) => change(current), text)

const PANEL = 'src/renderer/components/log/DiagnosticPanel.vue'
const PAGE = 'src/renderer/pages/log.vue'
const DIAGNOSTICS = 'src/renderer/utilities/log-diagnostics.js'
const ARCHIVE = 'src/renderer/utilities/event-archive.js'
const WINDOW_SCREENS = WINDOW_SECONDS.map((_seconds, index) => `window:${index}`)
const SAVED_SCREENS = [...WINDOW_SCREENS, 'held', 'quiet', 'broken', 'back']
const SCREEN_READS = {
  panel: WINDOW_SCREENS.map((screen) => [screen]),
  'window-chosen': [WINDOW_SCREENS],
  'window-state': WINDOW_SCREENS.map((screen) => [screen]),
  events: [WINDOW_SCREENS],
  'event-order': [WINDOW_SCREENS],
  'event-copies': [['window:1']],
  'event-states': [['window:3']],
  'game-master': [WINDOW_SCREENS],
  'hidden-flag': [['window:1']],
  inputs: [['window:1']],
  pointers: [WINDOW_SCREENS],
  'race-switch': [['held'], ['quiet']],
  'unavailable-read': [['broken']],
  'no-claims': SAVED_SCREENS.map((screen) => [screen]),
  back: [['held'], ['quiet'], ['broken'], ['back']],
  hooks: [SAVED_SCREENS],
  'no-errors': [],
}

const screenProblems = (faults) => faults.filter((fault) => fault.screens !== undefined && (fault.needs[0] !== 'saved' || !Array.isArray(fault.screens) || !fault.screens.length || fault.screens.some((screen) => !SAVED_SCREENS.includes(screen)) || fault.fails.some((id) => !SCREEN_READS[id] || SCREEN_READS[id].some((choices) => !choices.some((screen) => fault.screens.includes(screen)))))).map((fault) => fault.name)

unit('fault-screens', 'every narrowed page fault drives a screen or state of every reader path its named checks use, and rewrites drive every screen', ({ pageFaults = PAGE_FAULTS, pageRewrites = PAGE_REWRITES, headWindows = Array.from({ length: 4 }, () => ({})) }) => {
  assert.deepEqual(screenProblems(pageFaults), [])
  assert.deepEqual(pageRewrites.filter((rewrite) => rewrite.screens !== undefined).map((rewrite) => rewrite.name), [])
  assert.deepEqual(windowPositions(headWindows), [0, 1, 2, 3])
})

const GLOSSARY = 'src/renderer/utilities/glossary.js'

/* eslint-disable no-template-curly-in-string */
const PAGE_FAULTS = [
  { name: 'the evidence of the earlier race is kept while the new one is read', file: PAGE, change: swapText('this.diagnostic = Object.freeze({ key, database, inputs: null })', 'this.diagnostic = Object.freeze({ key, database, inputs: this.diagnostic.inputs })'), fails: ['race-switch'], needs: ['saved'], screens: ['held', 'quiet'] },
  { name: 'an unavailable window carries counts of 0 in its hooks', file: PANEL, change: swapText(':data-count="diagnosis.verdict === \'unavailable\' ? null : entry.count"', ':data-count="entry.count"'), fails: ['hooks'], needs: ['saved'], screens: ['broken'] },
  { name: 'every event carries the state of the window in its hook', file: PANEL, change: swapText(':data-state="observation.state"', ':data-state="diagnosis.state"'), fails: ['hooks'], needs: ['saved'], screens: ['window:3'] },
  { name: 'a type draws a count other than its own', file: PANEL, change: swapText('<span data-count-value>{{ count(entry.count) }}</span>', '<span data-count-value>{{ count(entry.count + 1) }}</span>'), fails: ['events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'every event draws a constant state', file: PANEL, change: swapText('data-event-state>{{ stateText[observation.state] }}</span>', 'data-event-state>{{ stateText.partial }}</span>'), fails: ['event-states'], needs: ['saved'], screens: ['window:3'] },
  { name: 'the window draws a constant state', file: PANEL, change: swapText('data-window-state>{{ stateText[diagnosis.state] }}</span>', 'data-window-state>{{ stateText.observed }}</span>'), fails: ['window-state'], needs: ['saved'], screens: WINDOW_SCREENS },
  { name: 'identical events draw no copies', file: PANEL, change: swapText('<span v-if="observation.copies > 1" class="diagnostic-chip" data-event-copies>', '<span v-if="false" class="diagnostic-chip" data-event-copies>'), fails: ['event-copies', 'events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'every input draws a constant status', file: PANEL, change: swapText('<provenance-mark :result="input.result" label />', '<provenance-mark status="confirmed" label />'), fails: ['inputs'], needs: ['saved'], screens: ['window:1'] },
  { name: 'every reason draws the same words', file: PANEL, change: swapText(':data-reason="reason">{{ reasonText[reason] }}</li>', ':data-reason="reason">{{ reasonText.tail }}</li>'), fails: ['window-state'], needs: ['saved'], screens: WINDOW_SCREENS },
  { name: 'an absent window draws the unknown verdict', file: PANEL, change: swapText('<span v-else-if="diagnosis.verdict === \'absent\'" data-verdict-shown="absent">', '<span v-else-if="false" data-verdict-shown="absent">'), fails: ['events', 'no-claims'], needs: ['saved'] },
  { name: 'a found window draws the count of groups, not of events', file: PANEL, change: swapText('<span data-verdict-count>{{ count(diagnosis.observed) }}</span>', '<span data-verdict-count>{{ count(diagnosis.observations.length) }}</span>'), fails: ['events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'a type draws its count negative', file: PANEL, change: swapText('<span data-count-value>{{ count(entry.count) }}</span>', '<span data-count-value>{{ count(-entry.count) }}</span>'), fails: ['events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'identical events draw their copies negative', file: PANEL, change: swapText('<span data-copies-value>{{ count(observation.copies) }}</span>', '<span data-copies-value>{{ count(-observation.copies) }}</span>'), fails: ['event-copies', 'events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'a type draws its count with a stray character', file: PANEL, change: swapText('<span data-count-value>{{ count(entry.count) }}</span>', '<span data-count-value>{{ count(entry.count) }} %</span>'), fails: ['events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'a pointer draws the definition of the first pointer under its own name', file: PANEL, change: swapText('<div data-pointer-definition>{{ entry.definition }}</div>', '<div data-pointer-definition>{{ pointers[0].definition }}</div>'), fails: ['pointers'], needs: ['saved'], screens: ['window:0'] },
  { name: 'a pointer draws its definition at opacity 0', file: PANEL, change: swapText('<div data-pointer-definition>', '<div data-pointer-definition style="opacity: 0">'), fails: ['pointers'], needs: ['saved'], screens: ['window:0'] },
  { name: 'the checklist reads the archive before the watcher refreshes it and keys it by the revision only', file: PAGE, change: chain(swapText('      archiveChoice: false,\n', '      archiveChoice: false,\n      archive: null,\n'), swapText('    archive() {\n      return this.archiveKey ? readArchiveFile(this.campaignId, this.branchId, this.RaceID) : null\n    },\n\n', ''), swapText('this.archiveSnapshot,', "this.archiveRecord ? this.archiveRecord.revision : '',"), swapText('    archiveRecord(record) {', '    archiveKey: {\n      immediate: true,\n      handler() {\n        this.archive = this.archiveKey ? readArchiveFile(this.campaignId, this.branchId, this.RaceID) : null\n      },\n    },\n    archiveRecord(record) {')), fails: ['archive-refresh'], needs: ['refresh'] },
  { name: 'the Fleet window controls are left out of the pointers', file: DIAGNOSTICS, change: swapText("['cease-fire', 'fleet-cease-fire', 'ship-open-fire', 'game-events-window']", "['cease-fire', 'game-events-window']"), fails: ['pointers'], needs: ['saved'], screens: ['window:0'] },
  { name: 'an empty window is worded as safe', file: DIAGNOSTICS, change: swapText('None of the watched event types was found in the observed part of this window. The log keeps only what the game wrote, so this says nothing about the game beyond the log.', 'Nothing happened in this window: the race is safe.'), fails: ['no-claims'], needs: ['saved'] },
  { name: 'the absent sentence is drawn for a found diagnosis with its hooks intact', file: PANEL, change: swapText("{{ verdictText.found[diagnosis.observed === 1 ? 'one' : 'many'] }}", '{{ verdictText.absent }}'), fails: ['events', 'hooks'], needs: ['saved'], screens: ['window:1'] },
  { name: 'the absent sentence is drawn for an unavailable diagnosis with its hooks intact', file: PANEL, change: swapText('<span data-verdict-words>{{ verdictText.unavailable }}</span>', '<span data-verdict-words>{{ verdictText.absent }}</span>'), fails: ['unavailable-read', 'hooks'], needs: ['saved'], screens: ['broken'] },
  { name: 'the end of the range is shifted by one increment', file: PANEL, change: swapText('{{ date(diagnosis.window.to) }}', '{{ date(diagnosis.window.to - 432000) }}'), fails: ['events'], needs: ['saved'], screens: ['window:0'] },
  { name: 'the copies numeral is drawn by a child at opacity 0', file: PANEL, change: swapText('<span data-copies-value>{{ count(observation.copies) }}</span>', '<span data-copies-value><span style="opacity: 0">{{ count(observation.copies) }}</span></span>'), fails: ['event-copies', 'events'], needs: ['saved'], screens: ['window:1'] },
  { name: 'the end of the range is drawn by a child at opacity 0', file: PANEL, change: swapText('<span data-window-to>{{ date(diagnosis.window.to) }}</span>', '<span data-window-to><span style="opacity: 0">{{ date(diagnosis.window.to) }}</span></span>'), fails: ['panel', 'events'], needs: ['saved'], screens: WINDOW_SCREENS },
  { name: 'a pointer definition is drawn by a child at opacity 0', file: PANEL, change: swapText('<div data-pointer-definition>{{ entry.definition }}</div>', '<div data-pointer-definition><span style="opacity: 0">{{ entry.definition }}</span></div>'), fails: ['pointers'], needs: ['saved'], screens: ['window:0'] },
  { name: 'two events of one type draw one another\'s date and increment', file: PANEL, change: chain(swapText('<li v-for="observation in shown" :key="observation.key" data-observation', '<li v-for="(observation, at) in shown" :key="observation.key" data-observation'), swapText('data-event-date>{{ date(observation.time) }}</span>', 'data-event-date>{{ date(twin(at).time) }}</span>'), swapText('data-event-increment>{{ observation.increment[0] }}', 'data-event-increment>{{ twin(at).increment[0] }}'), swapText('    nameOf(type) {', '    twin(at) {\n      const same = this.shown.filter((item) => item.type === this.shown[at].type)\n\n      return same[(same.indexOf(this.shown[at]) + 1) % same.length]\n    },\n\n    nameOf(type) {')), fails: ['events'], needs: ['saved'], screens: ['window:3'] },
  { name: 'two events of one type draw one another\'s date', file: PANEL, change: chain(swapText('<li v-for="observation in shown" :key="observation.key" data-observation', '<li v-for="(observation, at) in shown" :key="observation.key" data-observation'), swapText('data-event-date>{{ date(observation.time) }}</span>', 'data-event-date>{{ date(twin(at).time) }}</span>'), swapText('    nameOf(type) {', '    twin(at) {\n      const same = this.shown.filter((item) => item.type === this.shown[at].type)\n\n      return same[(same.indexOf(this.shown[at]) + 1) % same.length]\n    },\n\n    nameOf(type) {')), fails: ['events'], needs: ['saved'], screens: ['window:3'] },
  { name: 'the events are listed in reverse', file: PANEL, change: swapText('this.diagnosis.observations.slice(0, LISTED)', 'this.diagnosis.observations.slice(0, LISTED).reverse()'), fails: ['event-order'], needs: ['saved'], screens: ['window:2'] },
  { name: 'two events of one type draw one another\'s message', file: PANEL, change: chain(swapText('<li v-for="observation in shown" :key="observation.key" data-observation', '<li v-for="(observation, at) in shown" :key="observation.key" data-observation'), swapText('<div class="diagnostic-message">{{ observation.message }}</div>', '<div class="diagnostic-message">{{ twin(at).message }}</div>'), swapText('    nameOf(type) {', '    twin(at) {\n      const same = this.shown.filter((item) => item.type === this.shown[at].type)\n\n      return same[(same.indexOf(this.shown[at]) + 1) % same.length]\n    },\n\n    nameOf(type) {')), fails: ['events', 'hooks'], needs: ['saved'], screens: ['window:3'] },
  { name: 'a type draws the group of the other kind', file: PANEL, change: swapText('<span class="diagnostic-chip">{{ groups[entry.group] }}</span>', '<span class="diagnostic-chip">{{ groups[entry.group === \'fire\' ? \'boarding\' : \'fire\'] }}</span>'), fails: ['events'], needs: ['saved'], screens: ['window:0'] },
  { name: 'a game-master-only event is listed', file: DIAGNOSTICS, change: swapText(' && !group[GAME_MASTER]', ''), fails: ['game-master', 'events'], needs: ['saved'], screens: ['window:0'] },
  { name: 'a gap between the archive and the save is not told', file: DIAGNOSTICS, change: swapText('if (gaps.slice(1).some(meets)) {', 'if (false) {'), fails: ['gap'], needs: ['older'] },
  { name: 'a window an archive covers is partial all the same', file: ARCHIVE, change: swapText("? 'partial' : 'observed'\n\n  return {\n    state,", "? 'partial' : 'partial'\n\n  return {\n    state,"), fails: ['observed-window'], needs: ['ahead'] },
  { name: 'the verdict sits in a hidden ancestor', file: PANEL, change: swapText('<div v-else class="diagnostic-body">', '<div v-else class="diagnostic-body" v-show="false">'), fails: ['panel'], needs: ['saved'], screens: WINDOW_SCREENS },
  { name: 'the verdict sits in an ancestor at opacity 0', file: PANEL, change: swapText('<div v-else class="diagnostic-body">', '<div v-else class="diagnostic-body" style="opacity: 0">'), fails: ['panel'], needs: ['saved'], screens: WINDOW_SCREENS },
  { name: 'an unavailable window draws the words of none observed under its unknown hook', file: PANEL, change: swapText('data-count-unknown>{{ countText.unknown }}</span>', 'data-count-unknown>{{ countText.none }}</span>'), fails: ['unavailable-read'], needs: ['saved'], screens: ['broken'] },
  { name: 'a hidden type draws the words of the unlisted mark under its hidden hook', file: PANEL, change: swapText('data-hidden>{{ markText.hidden }}</span>', 'data-hidden>{{ markText.unlisted }}</span>'), fails: ['hidden-flag'], needs: ['saved'], screens: ['window:1'] },
  { name: 'every window of the menu and the window chosen draw the label of the first window, the values intact', file: PANEL, change: swapText('item-text="text"', ':item-text="() => windows[0].text"'), fails: ['panel', 'window-chosen'], needs: ['saved'], screens: WINDOW_SCREENS },
  { name: 'the checklist always opens unfolded', file: PANEL, change: swapText("this.decision = this.diagnosis !== null && this.seconds === DEFAULT_WINDOW && this.diagnosis.verdict !== 'found'", 'this.decision = false'), fails: ['fold-rule'], needs: ['fold'] },
  { name: 'the checklist always opens folded', file: PANEL, change: swapText("this.decision = this.diagnosis !== null && this.seconds === DEFAULT_WINDOW && this.diagnosis.verdict !== 'found'", 'this.decision = true'), fails: ['fold-rule'], needs: ['fold'] },
  { name: 'the checklist opens folded for a found verdict and unfolded for the others', file: PANEL, change: swapText("this.diagnosis.verdict !== 'found'", "this.diagnosis.verdict === 'found'"), fails: ['fold-rule'], needs: ['fold'] },
  { name: 'the checklist opens folded only for a verdict of none found', file: PANEL, change: swapText("this.diagnosis.verdict !== 'found'", "this.diagnosis.verdict === 'absent'"), fails: ['fold-rule'], needs: ['fold'] },
  { name: 'the checklist opens folded in any window', file: PANEL, change: swapText('this.diagnosis !== null && this.seconds === DEFAULT_WINDOW && this.diagnosis.verdict', 'this.diagnosis !== null && this.diagnosis.verdict'), fails: ['fold-rule'], needs: ['fold'] },
  { name: 'the checklist is folded or unfolded again by a window change', file: PANEL, change: swapText('    diagnosis() {\n      this.decide()\n    },\n', '    diagnosis() {\n      this.decide()\n    },\n\n    seconds() {\n      this.decided = false\n      this.decide()\n    },\n'), fails: ['fold-stays'], needs: ['fold'] },
  { name: 'a choice by hand is dropped when the read scope changes', file: PAGE, change: swapText('      handler() {\n        this.loadDiagnostic()\n      },\n    },\n    database() {', '      handler() {\n        this.diagnosticHand = null\n        this.loadDiagnostic()\n      },\n    },\n    database() {'), fails: ['fold-hand'], needs: ['fold'] },
  { name: 'the toggle leaves the fold as it is', file: PANEL, change: swapText("this.$emit('update:hand', !this.folded)", "this.$emit('update:hand', this.folded)"), fails: ['fold-hand'], needs: ['fold'] },
  { name: 'the folded content is never hidden', file: PANEL, change: swapText('<div v-show="!folded" id="diagnostic-content">', '<div id="diagnostic-content">'), fails: ['fold-toggle'], needs: ['fold'] },
  { name: 'the toggle says the opposite of what is shown', file: PANEL, change: swapText(':aria-expanded="String(!folded)"', ':aria-expanded="String(folded)"'), fails: ['fold-toggle'], needs: ['fold'] },
  { name: 'the toggle keeps one label whatever it does', file: PANEL, change: swapText(":aria-label=\"folded ? 'Show the checklist' : 'Hide the checklist'\"", 'aria-label="Show the checklist"'), fails: ['fold-toggle'], needs: ['fold'] },
  { name: 'the note is drawn as a part of the title', file: PANEL, change: swapText('class="caption text--secondary ml-2" data-diagnostic-note', 'class="ml-2" data-diagnostic-note'), fails: ['fold-toggle'], needs: ['fold'] },
  { name: 'the note is drawn while the checklist is open', file: PANEL, change: swapText('v-if="folded && note"', 'v-if="note"'), fails: ['fold-toggle'], needs: ['fold'] },
  { name: 'the note of a found verdict draws no count', file: PANEL, change: swapText('`${this.count(this.diagnosis.observed)} found`', "'Found'"), fails: ['fold-toggle'], needs: ['fold'] },
]

// One equivalent rewrite of each family, made together so that the page is observed once for all of them: the window control written long-hand and listening to its input event, its labels bound by a function and one of them worded another way (R047-2), the page taking the window by an explicit handler, each condition in parentheses or turned round, the qualifier of the hidden mark moved from prefix to suffix, the verdicts, a pointer and the headings worded another way, the pointer ids registered by a spread and a template literal, the order of the events by parenthesised comparisons, each value drawn by `v-text`, through `Number`, `String` or a template literal, and each element and its ancestors at opacity 1 with its text in a child at opacity 1 (R161-6, R161-9). The page, the panel, the checklist and the glossary each change; where two families meet on one element, both are made on it.
const EQUIVALENT_PANEL = chain(
  swapText('@change="(value) => $emit(\'window\', value)"', 'v-on:input="(value) => $emit(\'window\', value)"'),
  swapText('item-text="text"', ':item-text="(entry) => entry.text"'),
  swapText('Reading the log for this race.', 'The log of this race is being read.'),
  swapText('v-if="diagnosis.verdict === \'found\'"', 'v-if="(diagnosis.verdict === \'found\')"'),
  swapText('Event types watched', 'Watched event types'),
  swapText('<div class="diagnostic-verdict" data-verdict-text>', '<div class="diagnostic-verdict" data-verdict-text style="opacity: 1">'),
  swapText('<div v-else class="diagnostic-body">', '<div v-else class="diagnostic-body" style="opacity: 1">'),
  swapText('<li v-for="entry in pointers" :key="entry.id" :data-pointer="entry.id">', '<li v-for="entry in pointers" :key="entry.id" :data-pointer="entry.id" style="opacity: 1">'),
  swapText('<div class="diagnostic-section diagnostic-pointers" data-pointers>', '<div class="diagnostic-section diagnostic-pointers" data-pointers style="opacity: 1">'),
  swapText('<span data-count-value>{{ count(entry.count) }}</span>', '<span data-count-value style="opacity: 1">{{ count(Number(entry.count)) }}</span>'),
  swapText('<span v-if="diagnosis.verdict === \'unavailable\'" data-count-unknown>', '<span v-if="(diagnosis.verdict === \'unavailable\')" data-count-unknown>'),
  swapText('data-event-state>{{ stateText[observation.state] }}</span>', 'data-event-state v-text="stateText[observation.state]"></span>'),
  swapText('data-window-state>{{ stateText[diagnosis.state] }}</span>', 'data-window-state v-text="stateText[diagnosis.state]"></span>'),
  swapText('<span data-copies-value>{{ count(observation.copies) }}</span>', '<span data-copies-value style="opacity: 1"><span style="opacity: 1">{{ count(Number(observation.copies)) }}</span></span>'),
  swapText('<provenance-mark :result="input.result" label />', '<provenance-mark v-bind:result="input.result" :label="true" />'),
  swapText(':data-reason="reason">{{ reasonText[reason] }}</li>', ':data-reason="reason" v-text="reasonText[reason]"></li>'),
  swapText('<span v-else-if="diagnosis.verdict === \'absent\'" data-verdict-shown="absent">', '<span v-else-if="\'absent\' === diagnosis.verdict" data-verdict-shown="absent">'),
  swapText('<span data-verdict-count>{{ count(diagnosis.observed) }}</span>', '<span data-verdict-count style="opacity: 1">{{ count(Number(diagnosis.observed)) }}</span>'),
  swapText('<div data-pointer-definition>{{ entry.definition }}</div>', '<div data-pointer-definition style="opacity: 1"><span style="opacity: 1">{{ entry.definition }}</span></div>'),
  swapText('<span class="diagnostic-name" data-pointer-name>{{ entry.term }}</span>', '<span class="diagnostic-name" data-pointer-name style="opacity: 1"><span style="opacity: 1">{{ entry.term }}</span></span>'),
  swapText('<span data-verdict-words>{{ verdictText.absent }}</span>', '<span data-verdict-words style="opacity: 1"><span style="opacity: 1">{{ verdictText.absent }}</span></span>'),
  swapText('<span data-window-from>{{ date(diagnosis.window.from) }}</span>', '<span data-window-from v-text="date(diagnosis.window.from)"></span>'),
  swapText('<span data-window-to>{{ date(diagnosis.window.to) }}</span>', '<span data-window-to style="opacity: 1"><span style="opacity: 1">{{ `${date(diagnosis.window.to)}` }}</span></span>'),
  swapText('<span class="diagnostic-date" data-event-date>{{ date(observation.time) }}</span>', '<span class="diagnostic-date" data-event-date><span style="opacity: 1">{{ `${date(Number(observation.time))}` }}</span></span>'),
  swapText('<span data-newest-date>{{ date(entry.newest) }}</span>', '<span data-newest-date v-text="date(entry.newest)"></span>'),
  swapText('<span data-event-increment>{{ observation.increment[0] }}</span>', '<span data-event-increment><span style="opacity: 1">{{ `${Number(observation.increment[0])}` }}</span></span>'),
  swapText('<div class="diagnostic-message">{{ observation.message }}</div>', '<div class="diagnostic-message"><span style="opacity: 1">{{ String(observation.message) }}</span></div>'),
  swapText('<span class="diagnostic-chip">{{ groups[entry.group] }}</span>', '<span class="diagnostic-chip"><span style="opacity: 1">{{ groups[entry.group] }}</span></span>'),
  swapText('data-count-unknown>{{ countText.unknown }}</span>', 'data-count-unknown v-text="countText.unknown"></span>'),
  swapText('data-hidden>{{ markText.hidden }}</span>', 'data-hidden v-text="markText.hidden"></span>')
)
const EQUIVALENT_DIAGNOSTICS = chain(
  swapText("{ seconds: 432000, text: 'Last 5 days' }", "{ seconds: 432000, text: 'The last 5 days' }"),
  swapText("['cease-fire', 'fleet-cease-fire', 'ship-open-fire', 'game-events-window']", "['cease-fire', ...['fleet-cease-fire', 'ship-open-fire'], 'game-events-window']"),
  swapText('None of the watched event types was found in the observed part of this window.', 'No watched event type was found in the observed part of this window.'),
  swapText('fire or boarding events observed in this window.', 'fire or boarding events seen in this window.'),
  swapText("hidden: 'Hidden in the game\\'s Events window'", "hidden: 'In the game\\'s Events window, hidden'"),
  swapText('observations.sort((a, b) => b.time - a.time || b.increment[0] - a.increment[0] || a.type - b.type)', 'observations.sort((a, b) => (b.time - a.time) || (b.increment[0] - a.increment[0]) || (a.type - b.type))')
)
const EQUIVALENT_GLOSSARY = chain(
  swapText('closes the fire controls of every ship of the selected fleet', 'shuts every fire control of every ship of the selected fleet'),
  swapText("term('fleet-cease-fire', ", 'term(`fleet-cease-fire`, ')
)

// One equivalent rewrite of the fold: the toggle's state and the content's visibility written another way, and the folded state read through the hand choice first.
const EQUIVALENT_FOLD = chain(
  swapText(':aria-expanded="String(!folded)"', ':aria-expanded="folded ? \'false\' : \'true\'"'),
  swapText('<div v-show="!folded" id="diagnostic-content">', '<div v-show="folded === false" id="diagnostic-content">'),
  swapText('return this.hand === null ? this.decision : this.hand', 'return this.hand !== null ? this.hand : this.decision')
)

// A rewrite with `parts` changes each file of the list by its own change.
const PAGE_REWRITES = [
  { name: 'one equivalent rewrite of each family on the panel, the page, the checklist and the glossary, made together', parts: [{ file: PANEL, change: EQUIVALENT_PANEL }, { file: PAGE, change: swapText('@window="(value) => diagnosticWindow = value"', 'v-on:window="(value) => { diagnosticWindow = value }"') }, { file: DIAGNOSTICS, change: EQUIVALENT_DIAGNOSTICS }, { file: GLOSSARY, change: EQUIVALENT_GLOSSARY }] },
  { name: 'the fold written another way: the toggle state and the content visibility, the folded state read through the hand choice first, and the hand choice taken by an explicit handler', parts: [{ file: PANEL, change: EQUIVALENT_FOLD }, { file: PAGE, change: swapText(':hand.sync="diagnosticHand"', ':hand="diagnosticHand" @update:hand="(value) => diagnosticHand = value"') }], needs: ['fold'] },
  { name: 'the key of the checklist holds the revision of the record, not its snapshot, and the archive is computed through an early return', file: PAGE, change: chain(swapText('this.archiveSnapshot,', "this.archiveRecord ? this.archiveRecord.revision : '',"), swapText('return this.archiveKey ? readArchiveFile(this.campaignId, this.branchId, this.RaceID) : null', 'if (!this.archiveKey) {\n        return null\n      }\n\n      return readArchiveFile(this.campaignId, this.branchId, this.RaceID)')), needs: ['refresh'] },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the run ----------

let checks = 0
let failures = 0

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

// What each check named for a fault said when it failed, first line, and the kind of the failure: 'value' when the check's own assertion failed on what it read, 'throw' when a call of the code under test threw (`threw` of scripts/lib/fault-credit.js), which credits nothing unless the fault says a throw is how it is caught.
const detailsOf = (failed, ids) => ids.map((id) => {
  const result = failed.find((item) => item.id === id)

  return result ? `${id} (${result.threw ? 'throw' : 'value'}): ${String(result.detail).split('\n')[0].slice(0, 200)}` : `${id}: did not fail`
}).join('; ')

const resultsOfUnits = async (modules, ids = null) => runChecks(UNIT.filter((item) => !ids || ids.includes(item.id)), modules)

// A fault or a rewrite of the utilities, run against the whole suite of units.
const judgeUnits = async (variant) => {
  const modules = await loadModules(variant.sources ? variant.sources() : {})
  modules.pageFaults = variant.pageFaults ? variant.pageFaults() : PAGE_FAULTS
  modules.pageRewrites = variant.pageRewrites ? variant.pageRewrites() : PAGE_REWRITES
  modules.headWindows = variant.headWindows ? variant.headWindows() : undefined

  return judged(await resultsOfUnits(modules), `the ${variant.name}`)
}

const checkUnitsHead = async () => {
  console.log('The checklist and the window states (in memory)')

  const real = await loadModules()
  const results = await resultsOfUnits(real)

  results.forEach(({ name, ok, kind, detail }) => report(name, ok ? true : `${kind === 'assertion' ? '' : 'an error: '}${detail}`))
}

const checkUnitFault = async (fault) => {
  const failed = await judgeUnits(fault)
  const missed = fault.fails.filter((id) => !caughtBy(failed, [id], { name: fault.name, throws: fault.throws }))

  report(`fault caught: ${fault.name}`, missed.length ? `these checks did not fail by an assertion: ${missed.join(', ')}` : true, detailsOf(failed, fault.fails))
}

const checkUnitRewrite = async (rewrite) => {
  const failed = await judgeUnits(rewrite)

  report(`rewrite passes: ${rewrite.name}`, failed.length ? `fails ${failed.map(({ id }) => id).join(', ')}` : true)
}

// The results of the page checks over the record of an observation: the observation must have got through (a record that did not is the failure of the run, never a fault caught), a check that throws something that is no assertion stops the run.
const resultsOfPage = async (seen, context, { ids = null, label, list = PAGE_CHECKS }) => {
  validate(seen, label)

  const chosen = list.filter((item) => !ids || ids.includes(item.id))

  if (seen.value === null || (seen.error !== null && !/^the page raised \d+ unexpected error/.test(seen.error))) {
    return { unobserved: failureLine(seen), results: [] }
  }

  const value = seen.value

  return { unobserved: null, results: await runChecks(chosen.map((item) => ({ id: item.id, name: item.name, run: () => item.run({ o: value, unexpected: seen.unexpected, ...context }) })), null) }
}

const seedOf = async (modules, truth, kind) => {
  const { raw } = modules
  const a = raw['event-archive']
  const older = HEAD - 2
  const ids = (from, to) => Array.from({ length: to - from + 1 }, (_item, at) => from + at)
  const identity = (id) => [id, PT(id), REAL_LEN]
  const rows = (await truth.everything(PLAYER)).map((row) => ({ ...row, IncrementID: row.IncrementID }))
  const archived = [{ IncrementID: older, Time: PT(older) + 100000, EventType: 219, MessageText: 'Boarding Attempt: only the archive holds this.', SystemID: 0, PopulationID: 0, Xcor: 0, Ycor: 0, IDType: 0, SMOnly: 0 }, { IncrementID: older - 2, Time: PT(older - 2) + 100000, EventType: 60, MessageText: 'Research Completed: noise.', SystemID: 0, PopulationID: 0, Xcor: 0, Ycor: 0, IDType: 0, SMOnly: 0 }]
  const capture = (from, to, own) => a.captureOf(own, { first: from, ledger: new Map(ids(from, to).map((id) => [id, identity(id)])) }, PT(to + 1))
  const file = kind === 'older' ? capture(HEAD - 7, older, archived) : capture(HEAD - 7, REAL_TIP + 2, [...archived, ...rows])

  return { older, file: a.mergeEvents({}, { races: [{ RaceID: PLAYER, capture: file }] }, { cap: 50000, now: () => 1 }).file }
}

// The archive files the page is given after the archive of the ahead observation is on: one more failed capture inside the day at the same event revision, the archive as it was, and spans and tip that no longer close the newest increment (coverage only, no failure and no row).
const refreshOf = (modules, ahead) => {
  const a = modules.raw['event-archive']
  const copy = () => JSON.parse(JSON.stringify(ahead.file))
  const failure = copy()
  const coverage = copy()

  failure.races[PLAYER] = a.withFailure(failure.races[PLAYER], { at: 1, t: END - 1000, reason: 'the read failed' })
  coverage.races[PLAYER].spans = coverage.races[PLAYER].spans.map(([from]) => [from, END])
  coverage.races[PLAYER].tip = [REAL_TIP, PT(REAL_TIP), REAL_LEN]

  return { failure, restored: ahead.file, coverage }
}

// The page in a browser, set up once for each worker (`openScreen`, run by the runner before the worker's first variant): the copy of the save with the log written here, what SQL says of it, the page server (warmed) and Chromium, the archive files the page is given, and the baselines: the page as it is, of each kind a rewrite of the worker's queue sets its screen against, read by the setup (`readBaselines`) before the first variant, whichever that is, so that a rewrite reads only its own page. A setup that does not get through is kept as `failure`, and every observation of the worker is then one that did not happen.
const SCREEN = { failure: null, modules: null, truth: null, server: null, chrome: null, seeds: null, refreshes: null, baselines: {}, cleanups: [] }
const KINDS = ['saved', 'older', 'ahead', 'refresh', 'fold']

const openScreen = async () => {
  try {
    const made = await makeSave()

    SCREEN.cleanups.push(async () => fs.rmSync(made.folder, { recursive: true, force: true }))
    SCREEN.modules = await loadModules()
    BASE_LABELS = labelsOf(SCREEN.modules.raw)
    LABELS = BASE_LABELS
    FORMAT = formatOf(SCREEN.modules.raw)
    SCREEN.truth = await truthOf(made.file)
    SCREEN.cleanups.push(() => SCREEN.truth.close())
    assert.equal(SCREEN.truth.head, HEAD)
    assert.equal(SCREEN.truth.tip, REAL_TIP)
    assert.equal(SCREEN.truth.end, END)
    SCREEN.seeds = { older: await seedOf(SCREEN.modules, SCREEN.truth, 'older'), ahead: await seedOf(SCREEN.modules, SCREEN.truth, 'ahead') }
    SCREEN.refreshes = refreshOf(SCREEN.modules, SCREEN.seeds.ahead)
    SCREEN.server = await require('./lib/page-server').startPageServer({ save: made.file })
    SCREEN.cleanups.push(() => SCREEN.server.stop())
    SCREEN.chrome = await require('playwright').chromium.launch()
    SCREEN.cleanups.push(() => SCREEN.chrome.close())

    const warmed = await SCREEN.server.warm(SCREEN.chrome, { routes: ['/log'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  } catch (error) {
    SCREEN.failure = String(error.message).split('\n')[0]
  }
}

const closeScreen = async () => {
  for (const cleanup of SCREEN.cleanups.splice(0).reverse()) {
    await cleanup().catch(() => {})
  }
}

const originals = new Map()
const original = (file) => {
  if (!originals.has(file)) {
    originals.set(file, fs.readFileSync(path.join(root, file), 'utf8'))
  }

  return originals.get(file)
}
// The utilities the page was served: a variant of the glossary or of the checklist's utilities loads its own copy, so a reworded definition or verdict sentence is expected as drawn, while a pointer that shows another term's text, or a sentence that belongs to another verdict, is not.
const SOURCE_NAMES = { [DIAGNOSTICS]: 'log-diagnostics', [GLOSSARY]: 'glossary' }
const partsOf = (variant) => (!variant ? [] : variant.parts || [variant])
const servedBy = new Map()
const servedOf = async (variant) => {
  const sources = Object.fromEntries(partsOf(variant).filter(({ file }) => SOURCE_NAMES[file]).map(({ file, change }) => [SOURCE_NAMES[file], change(original(file))]))

  if (!Object.keys(sources).length) {
    return { labels: BASE_LABELS, terms: FORMAT && FORMAT.terms }
  }

  if (!servedBy.has(variant)) {
    const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources })

    servedBy.set(variant, { labels: labelsOf(loaded), terms: loaded.glossary.termById })
  }

  return servedBy.get(variant)
}
const view = async (kind, variant) => {
  if (SCREEN.failure) {
    return failedObservation(SCREEN.failure)
  }

  const { server, chrome, seeds, refreshes } = SCREEN

  LABELS = (await servedOf(variant)).labels

  for (const { file, change } of partsOf(variant)) {
    server.replace(file, change(original(file)))
  }

  try {
    const seen = kind === 'saved' ? await observeSaved(chrome, server.url, variant && variant.screens) : kind === 'fold' ? await observeFolded(chrome, server.url) : kind === 'refresh' ? await observeRefreshed(chrome, server.url, seeds.ahead.file, refreshes) : await observeArchived(chrome, server.url, seeds[kind].file, kind === 'older' ? [1, 3] : [0, 1, 2, 3])

    // A page that did not get through is told whole where it is met, in the output of its variant: the step, the message with Playwright's call log, and what the page showed then. Its checks say it in one line.
    if (seen.error !== null) {
      console.error(describe(`the ${kind} page${variant ? ` with "${variant.name}"` : ''}`, seen))
    }

    return seen
  } finally {
    for (const { file } of partsOf(variant)) {
      server.replace(file, null)
    }
  }
}
const contextOf = async (kind, variant = null) => ({ truth: SCREEN.truth, seeded: SCREEN.seeds && SCREEN.seeds[kind === 'saved' ? 'older' : kind === 'refresh' ? 'ahead' : kind], ...(await servedOf(variant)) })
// The kind of page a rewrite is read on: the one it needs, or the saved window.
const rewriteKind = (rewrite) => (rewrite.needs ? rewrite.needs[0] : 'saved')
// The page as it is, of each kind a rewrite of `queue` sets its screen against.
const readBaselines = async (queue) => {
  for (const kind of new Set(queue.map((variant) => variant.baseline).filter(Boolean))) {
    SCREEN.baselines[kind] = await view(kind, null)
  }
}

const checkPageHead = async () => {
  console.log('\nThe Game Log page in a browser (scripts/lib/page-server.js over a copy of a save)')

  for (const kind of KINDS) {
    const seen = await view(kind, null)
    const outcome = await resultsOfPage(seen, await contextOf(kind), { ids: PAGE_CHECKS.filter((item) => forKind(item, kind)).map((item) => item.id), label: `the ${kind} page` })

    if (outcome.unobserved) {
      PAGE_CHECKS.filter((item) => forKind(item, kind)).forEach((item) => report(item.name, `the page was not observed: ${outcome.unobserved}`))
    } else {
      outcome.results.forEach(({ name, ok, detail }) => report(name, ok ? true : detail))
    }
  }
}

const checkRecorder = async () => {
  console.log('\nthe wait for the recorder, on the real recorder and the real registry lock')

  if (SCREEN.failure) {
    throw new HarnessError(`the page was not set up: ${SCREEN.failure}`)
  }

  await recorderControls(SCREEN.chrome, SCREEN.server.url, SCREEN.seeds.ahead.file)
}

const checkPageFault = async (fault) => {
  const missing = screenProblems([fault])

  if (missing.length) {
    throw new HarnessError(`the fault omits a screen its named check reads: ${missing.join(', ')}`)
  }

  const seen = await view(fault.needs[0], fault)
  const outcome = await resultsOfPage(seen, await contextOf(fault.needs[0], fault), { ids: fault.screens ? [...fault.fails, 'no-errors'] : null, label: `the page with the fault "${fault.name}"`, list: PAGE_CHECKS.filter((item) => forKind(item, fault.needs[0])) })

  if (outcome.unobserved) {
    throw new HarnessError(`the page with the fault "${fault.name}" did not get through: ${outcome.unobserved}`)
  }

  const failed = judged(outcome.results, `the fault "${fault.name}"`)
  const missed = fault.fails.filter((id) => !caughtBy(failed, [id], { name: fault.name, throws: fault.throws }))

  report(`fault caught: ${fault.name}`, missed.length ? `these checks did not fail by an assertion: ${missed.join(', ')}` : true, detailsOf(failed, fault.fails))
}

const checkPageRewrite = async (rewrite) => {
  const kind = rewriteKind(rewrite)
  const seen = await view(kind, rewrite)
  const outcome = await resultsOfPage(seen, await contextOf(kind, rewrite), { ids: null, label: `the page rewritten as "${rewrite.name}"`, list: PAGE_CHECKS.filter((item) => forKind(item, kind)) })

  if (outcome.unobserved) {
    throw new HarnessError(`the page rewritten as "${rewrite.name}" did not get through: ${outcome.unobserved}`)
  }

  const failed = judged(outcome.results, `the rewrite "${rewrite.name}"`)
  const ignored = (key, value) => (key === 'text' || key === 'verdictWords' || key === 'definition' ? undefined : value)
  const sameScreen = JSON.stringify(seen.value, ignored) === JSON.stringify(SCREEN.baselines[kind].value, ignored)

  report(`rewrite passes: ${rewrite.name}`, failed.length ? `fails ${failed.map(({ id }) => id).join(', ')}` : !sameScreen ? 'the screen it draws is not the page\'s' : true)
}

// The deadlines, in seconds: five times the slowest time measured (the utilities 0.4 s, the page's head 40 s, the recorder's 60 s, a fault or a rewrite of the page 29 s), at least two minutes, and for what reads the page at least a minute past its longest step (TIMEOUT, 120 s for a click or a wait of the page), so that a step that does not end fails by its own timeout, named, before the deadline runs out. The utilities run in memory; the page's head observes it four times and the recorder's controls several more; a fault or a rewrite observes it once. The setup writes the save, starts the page server and warms it, the one cold start of the run (900 s), and reads the page as it is for each kind a rewrite of its queue is set against (a page variant's 180 s for each kind).
const DEADLINES = { memory: 120, head: 240, recorder: 300, page: 180, setup: 900 + KINDS.length * 180 }
// The planted fault the control runs before the page's head: one the head's reading of the saved window catches.
const CONTROL_FAULT = 'a type draws its count negative'

// The utilities' head and variants, then the page's, one pool: a worker runs them one after another, the page's on its one page server and browser.
const variantsOf = ({ mutations, browser }) => [
  { key: 'units', name: 'the head: the checklist and the window states (in memory)', head: true, pool: 'suite', deadline: DEADLINES.memory, run: checkUnitsHead },
  ...(mutations ? UNIT_FAULTS.map((fault, index) => ({ key: `unit-fault:${index}`, name: `unit fault: ${fault.name}`, heading: '\nplanted faults in the utilities', pool: 'suite', deadline: DEADLINES.memory, run: () => checkUnitFault(fault) })) : []),
  ...(mutations ? UNIT_REWRITES.map((rewrite, index) => ({ key: `unit-rewrite:${index}`, name: `unit rewrite: ${rewrite.name}`, heading: '\nrewrites of the utilities that say the same thing', pool: 'suite', deadline: DEADLINES.memory, run: () => checkUnitRewrite(rewrite) })) : []),
  ...(browser ? [
    { key: 'page', name: 'the head: the Game Log page in a browser', head: true, pool: 'suite', deadline: DEADLINES.head, run: checkPageHead },
    { key: 'recorder', name: 'the head: the wait for the recorder', head: true, pool: 'suite', deadline: DEADLINES.recorder, run: checkRecorder },
  ] : []),
  ...(browser && mutations ? PAGE_FAULTS.map((fault, index) => ({ key: `page-fault:${index}`, name: `page fault: ${fault.name}`, heading: '\nplanted faults in the page', pool: 'suite', deadline: DEADLINES.page, browser: true, run: () => checkPageFault(fault) })) : []),
  ...(browser && mutations ? PAGE_REWRITES.map((rewrite, index) => ({ key: `page-rewrite:${index}`, name: `page rewrite: ${rewrite.name}`, heading: '\nrewrites of the page that say the same thing', pool: 'suite', deadline: DEADLINES.page, browser: true, baseline: rewriteKind(rewrite), run: () => checkPageRewrite(rewrite) })) : []),
]

const main = async () => {
  const options = { mutations: !process.argv.includes('--no-mutations'), browser: !process.argv.includes('--no-browser') }
  const totals = await runSuite({
    script: __filename,
    variants: variantsOf(options),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.browser || ['page', 'recorder'].includes(variant.key) || variant.control)) {
        await openScreen()
        await readBaselines(queue)
      }
    },
    afterEach: async () => {
      if (SCREEN.server) {
        await SCREEN.server.reset()
      }
    },
    close: closeScreen,
    control: options.browser && options.mutations ? { fault: `page-fault:${PAGE_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'page', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await closeScreen()
  process.exit(2)
})
