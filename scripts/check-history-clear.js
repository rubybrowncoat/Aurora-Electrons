/*
  Checks the Clear action of Empire History: what it removes of a race's history, in the shown branch only, and what the dialog says before it does (utilities/history.js `clearRaceHistory` and `clearPlan`, the cuts of the records kept with the snapshots in utilities/campaign.js `seriesFrom`, utilities/event-archive.js `eventsFrom` and utilities/observations.js `observationsFrom`, and the Clear dialog of pages/history.vue).

  Run: bun scripts/check-history-clear.js [--no-mutations] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The groups, each check a PASS or FAIL line named by its group:
  - units: on in-memory stores holding two branches of one campaign, each with two races and the colony series, the event archive and the observation record: Everything removes the race whole and leaves the other race, its intel and the other branch as they were; older than 10 and 20 years cut the snapshots before the bound, keep the one exactly at it and the newest, and cut the three records at the same date with their own cut and thinning bookkeeping; a series shorter than the span removes nothing and writes nothing; the dialog's counts; a race with no event archive or observation record; an increment that straddles the date; observations whose captures are all older; a record whose thinning is not intact; a time that is no number;
  - browser: the real app in Chromium over a copy of the modded save, with the history files of the race seeded in the browser's storage: the dialog opens at Everything, states the snapshots each option removes and keeps, cannot confirm an option that removes nothing, forgets a cancelled choice, and a confirmed clear leaves in storage exactly the kept snapshots and the cut records and on the Retention panel the kept count and the thinning reading it had.
  Planted faults in copies of the utilities and of the page must each fail the checks they name by a value (scripts/lib/fault-credit.js `caughtBy`); one rewrite of each family must fail none. Prints `N of N checks passed`; a failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { runSuite, runnerArgs } = require('./lib/suite-runner')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError, installScreen, readFigure } = require('./lib/browser-observe')
const { failure, through, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pagesDirectory = path.join(root, 'src', 'renderer', 'pages')
const HISTORY_FILE = path.join(pagesDirectory, 'history.vue')
const NAMES = ['history', 'campaign', 'event-archive', 'observations', 'colony-series']
const CAMPAIGN = 'c1'
const OWN = 7
const OTHER = 8
const YEAR = 31536000
const DAY = 86400
const HEX = (digit) => digit.repeat(16)

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The stores of the history folder, kept in one map by folder and name (reset by each check): what `clearRaceHistory` and the stores of the records read and write, with a log of the writes.
const STORE_STUB = `const files = () => (globalThis.__historyClearStores = globalThis.__historyClearStores || new Map())
const writes = () => (globalThis.__historyClearWrites = globalThis.__historyClearWrites || [])
export default class Config {
  constructor ({ cwd = '', name = 'config' } = {}) { this.key = cwd + '/' + name }
  get store () {
    if ((globalThis.__historyClearUnreadable || []).some((part) => this.key.endsWith(part))) { throw new Error('the file cannot be read') }
    return JSON.parse(JSON.stringify(files().get(this.key) || {}))
  }
  set store (value) { writes().push(this.key); files().set(this.key, JSON.parse(JSON.stringify(value))) }
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

  return { history: loaded.history, campaign: loaded.campaign, events: loaded['event-archive'], obs: loaded.observations, colony: loaded['colony-series'] }
}

// ---------- the history worked by hand ----------

// The snapshots of the race, in years before the latest one, oldest first: one a tenth of a year older than 10 years, one exactly 10 and one exactly 20 years before the latest.
const AGES = [25, 20, 10.1, 10, 5, 0]

// What a clear of each span leaves of the race, written out by hand from AGES (the index of each snapshot and capture kept, the increments of the event archive kept and the cut it gets, the spans and the conflicts that stay, the observation cut).
const expectedOf = (at, times) => ({
  10: { kept: [3, 4, 5], events: [104, 105], eventCut: at(10), eventSpans: [[at(10), at(0) + DAY]], conflicts: 0, obsCut: times[2] },
  20: { kept: [1, 2, 3, 4, 5], events: [102, 103, 104, 105], eventCut: at(20), eventSpans: [[at(20), at(19)], [at(12), at(0) + DAY]], conflicts: 1, obsCut: times[0] },
})

// What the dialog says for each option, by hand: the snapshots it removes and keeps.
const COUNTS = { 0: { removed: 6, kept: 0 }, 10: { removed: 3, kept: 3 }, 20: { removed: 1, kept: 5 }, 50: { removed: 0, kept: 6 } }

// The files of one branch for a race and another: the branch file with an intel series, and the colony series, the event archive and the observation record each of both races but `other`, who keeps no event archive and no observation record. `latest` is the game time of the race's latest snapshot, `template` the figures every snapshot carries.
const filesOf = (m, latest, own, other, template = {}) => {
  const at = (age) => latest - Math.round(age * YEAR)
  const times = AGES.map(at)
  const otherTimes = [at(30), at(12), at(1)]
  const snapshots = times.map((t, index) => ({ ...template, t, population: 100 + index }))
  const otherSnapshots = otherTimes.map((t, index) => ({ ...template, t, population: 500 + index }))
  const group = (t) => [t, 12, 'An event', 1, 2, 0.5, 0.5, 3, 0, 1]
  const untouched = (rows) => ({ complete: true, passes: 0, dropped: 0, last: null, witness: m.campaign.witnessOf(rows) })
  const colonyRows = (list) => list.map((t) => ({ t, n: 1, d: 'x', colonies: [[1, 1]] }))

  return {
    at,
    times,
    otherTimes,
    history: {
      gameName: 'Fixture',
      races: {
        [own]: { raceName: 'Own', npr: false, snapshots, thinning: { complete: true, passes: 1, dropped: 40, last: { at: 1700000000000, t: times[2], passes: 1, dropped: 40, cap: 500 }, witness: m.campaign.witnessOf(snapshots) } },
        [other]: { raceName: 'Other', npr: false, snapshots: otherSnapshots, thinning: untouched(otherSnapshots) },
      },
      intel: { [own]: { 9: { name: 'Alien', snapshots: [{ t: times[0], contact: 1 }, { t: times[5], contact: 2 }] } } },
    },
    colonies: {
      columns: m.colony.COLONY_COLUMNS,
      races: { [own]: { snapshots: colonyRows(times), thinning: untouched(colonyRows(times)) }, [other]: { snapshots: colonyRows(otherTimes), thinning: untouched(colonyRows(otherTimes)) } },
    },
    events: {
      version: 1,
      races: {
        [own]: {
          increments: [[101, at(25), DAY, [group(at(25))]], [102, at(20), DAY, [group(at(20))]], [103, at(10) - 3600, 3600, [group(at(10) - 3600)]], [104, at(10), DAY, [group(at(10))]], [105, at(0), DAY, [group(at(0))]]],
          spans: [[at(26), at(19)], [at(12), at(0) + DAY]],
          tip: [105, at(0), DAY],
          revision: 3,
          captures: [],
          conflicts: [{ at: 1, t: at(20), increment: [102, at(20), DAY], reason: 'ledger' }],
        },
      },
    },
    observations: {
      version: 1,
      races: {
        [own]: { kinds: { formation: { captures: times.map((t, index) => [t, index + 1]), objects: { 11: [times[0], times[5], HEX('a')], 12: [times[4], times[5], HEX('b')] } } } },
      },
    },
  }
}

const unitFiles = (m) => filesOf(m, 40 * YEAR, OWN, OTHER)

// ---------- the units ----------

const unitChecks = (m) => {
  const kindOfKey = (key) => ['colonies', 'events', 'observations'].find((suffix) => key.endsWith(`-${suffix}`)) || 'history'
  const branchOfKey = (key) => (/-b(\d)/.exec(key) || [])[1]

  // Two branches of one campaign, the stores reset, and what they hold.
  const world = () => {
    const files = unitFiles(m)

    globalThis.__historyClearStores = new Map()
    globalThis.__historyClearWrites = []
    globalThis.__historyClearUnreadable = []
    ;['b1', 'b2'].forEach((branch) => {
      m.history.branchStore(CAMPAIGN, branch).store = clone(files.history)
      m.history.colonyStore(CAMPAIGN, branch).store = clone(files.colonies)
      m.history.eventStore(CAMPAIGN, branch).store = clone(files.events)
      m.history.observationStore(CAMPAIGN, branch).store = clone(files.observations)
    })
    globalThis.__historyClearWrites = []

    return files
  }
  const dump = () => Object.fromEntries(['b1', 'b2'].map((branch) => [branch, { history: m.history.branchStore(CAMPAIGN, branch).store, colonies: m.history.colonyStore(CAMPAIGN, branch).store, events: m.history.eventStore(CAMPAIGN, branch).store, observations: m.history.observationStore(CAMPAIGN, branch).store }]))
  const without = (file, who) => (file && file.races ? { ...file, races: Object.fromEntries(Object.entries(file.races).filter(([id]) => id !== String(who))) } : file)
  // Everything the clear of a race must leave as it was: the other races of the shown branch, its intel and the other branch.
  const rest = (d, who) => ({ b1: [d.b1.history, d.b1.colonies, d.b1.events, d.b1.observations].map((file) => without(file, who)), b2: d.b2 })
  const clear = (before, who = OWN) => m.history.clearRaceHistory({ campaignId: CAMPAIGN, branchId: 'b1', RaceID: who, ...(before === undefined ? {} : { before }) })
  const timesOf = (race) => race.snapshots.map((snapshot) => snapshot.t)
  const written = () => [...new Set(globalThis.__historyClearWrites.map((key) => `${kindOfKey(key)} ${branchOfKey(key)}`))].sort()

  // A clear that fails on one companion store: what it threw and what it left, read with every store readable again. Each file must be as it was and none written, whichever store fails and whichever file was cut before it.
  const failed = async (before, { data = () => {}, unreadable = null }) => {
    const files = world()

    data()

    const was = dump()
    let outcome = 'cleared'

    globalThis.__historyClearUnreadable = unreadable ? [unreadable] : []

    try {
      await clear(before === null ? undefined : files.at(0) - before * YEAR)
    } catch (error) {
      outcome = 'failed'
    }

    const writes = written()

    globalThis.__historyClearUnreadable = []

    return same({ outcome, writes, after: dump() }, { outcome: 'failed', writes: [], after: was })
  }
  const malformedEvents = () => { const store = m.history.eventStore(CAMPAIGN, 'b1'); const file = store.store; file.races[OWN].increments = null; store.store = file; globalThis.__historyClearWrites = [] }

  const olderThan = (years) => [`units: Older than ${years} years removes the snapshots before the bound of the race's latest snapshot, keeps the one exactly at it and the newest, and the other race, its intel and the other branch stay as they were`, async () => {
    const files = world()
    const before = dump()
    const expected = expectedOf(files.at, files.times)[years]
    const cleared = await clear(files.at(0) - years * YEAR)
    const after = dump()

    return same({ cleared, snapshots: timesOf(after.b1.history.races[OWN]), names: [after.b1.history.races[OWN].raceName, after.b1.history.races[OWN].npr], rest: rest(after, OWN) }, { cleared: true, snapshots: expected.kept.map((index) => files.times[index]), names: ['Own', false], rest: rest(before, OWN) })
  }]

  const companions = (years) => [`units: Older than ${years} years cuts the colony series, the event archive and the observation record at the same date, each with its own cut, and the files stay readable`, async () => {
    const files = world()
    const expected = expectedOf(files.at, files.times)[years]

    await clear(files.at(0) - years * YEAR)

    const after = dump()
    const events = after.b1.events.races[OWN]
    const observed = after.b1.observations.races[OWN].kinds.formation

    return same({
      colonies: timesOf(after.b1.colonies.races[OWN]),
      events: { ids: events.increments.map((increment) => increment[0]), cut: events.cut, spans: events.spans, conflicts: events.conflicts.length, tip: events.tip, revision: events.revision },
      observations: { captures: observed.captures.map(([t]) => t), cut: observed.cut, objects: Object.keys(observed.objects), first: observed.objects[11][0] },
      readable: [m.events.eventFileProblem(after.b1.events), m.obs.observationFileProblem(after.b1.observations)],
    }, {
      colonies: expected.kept.map((index) => files.times[index]),
      events: { ids: expected.events, cut: expected.eventCut, spans: expected.eventSpans, conflicts: expected.conflicts, tip: files.events.races[OWN].tip, revision: 3 },
      observations: { captures: expected.kept.map((index) => files.times[index]), cut: expected.obsCut, objects: ['11', '12'], first: files.times[0] },
      readable: [null, null],
    })
  }]

  return [
    ['units: Everything removes the race from the branch file and from its colony series, event archive and observation record, and the other race, its intel and the other branch stay as they were', async () => {
      world()

      const before = dump()
      const cleared = await clear()
      const after = dump()

      return same({ cleared, own: [after.b1.history, after.b1.colonies, after.b1.events, after.b1.observations].map((file) => Boolean(file.races[OWN])), rest: rest(after, OWN) }, { cleared: true, own: [false, false, false, false], rest: rest(before, OWN) })
    }],
    ['units: a clear of everything whose observation record cannot be read writes no file, so no store is cut while another is not', () => failed(null, { unreadable: '-observations' })],
    ['units: a clear older than a span whose observation record cannot be read writes no file', () => failed(10, { unreadable: '-observations' })],
    ['units: a clear older than a span whose event archive cannot be cut writes no file', () => failed(10, { data: malformedEvents })],
    olderThan(10),
    olderThan(20),
    companions(10),
    companions(20),
    ['units: a series shorter than the span removes nothing, writes nothing and returns that nothing was removed', async () => {
      const files = world()
      const before = dump()
      const cleared = await clear(files.at(0) - 50 * YEAR)

      return same({ cleared, after: dump(), writes: written() }, { cleared: false, after: before, writes: [] })
    }],
    ['units: the dialog counts the snapshots it removes and keeps for each option from the race\'s latest snapshot, a snapshot exactly at the bound kept', () => {
      const files = unitFiles(m)
      const snapshots = files.history.races[OWN].snapshots
      const seen = Object.fromEntries([0, 10, 20, 50].map((years) => {
        const plan = m.history.clearPlan(snapshots, years)

        return [years, { removed: plan.removed, kept: plan.kept, before: plan.before }]
      }))

      return same(seen, Object.fromEntries(Object.entries(COUNTS).map(([years, count]) => [years, { ...count, before: Number(years) ? files.at(0) - Number(years) * YEAR : null }])))
    }],
    ['units: a race with no event archive and no observation record is cut in the files it has, and only those are written', async () => {
      const files = world()
      const before = dump()
      const cleared = await clear(files.at(1) - 10 * YEAR, OTHER)
      const after = dump()

      return same({ cleared, snapshots: timesOf(after.b1.history.races[OTHER]), colonies: timesOf(after.b1.colonies.races[OTHER]), writes: written(), rest: rest(after, OTHER), files: [after.b1.events, after.b1.observations] }, { cleared: true, snapshots: [files.otherTimes[2]], colonies: [files.otherTimes[2]], writes: ['colonies 1', 'history 1'], rest: rest(before, OTHER), files: [before.b1.events, before.b1.observations] })
    }],
    ['units: the thinning record of a cut series is believed as before: thinned stays thinned and never partial, an untouched colony series stays untouched, and the passes and the dropped samples are not changed', async () => {
      const files = world()
      const before = dump()

      await clear(files.at(0) - 10 * YEAR)

      const after = dump()
      const read = (d) => ({ empire: m.history.thinningStatus(d.b1.history.races[OWN]), colonies: m.history.thinningStatus(d.b1.colonies.races[OWN]) })

      return same(read(after), read(before))
    }],
    ['units: a series whose thinning record is not intact stays as unknown or partial as it was, with the snapshots cut, and a series nothing older than the date is returned as it is', () => {
      const times = [1, 2, 3, 4].map((n) => n * YEAR)
      const rows = times.map((t) => ({ t }))
      const stale = { snapshots: rows, thinning: { complete: true, passes: 2, dropped: 9, last: { at: 1, t: times[1], passes: 1, dropped: 5, cap: 500 }, witness: 'stale' } }
      const bare = { snapshots: rows }
      const cutStale = m.campaign.seriesFrom(stale, times[2])
      const cutBare = m.campaign.seriesFrom(bare, times[2])
      const intact = { snapshots: rows, thinning: { complete: true, passes: 0, dropped: 0, last: null, witness: m.campaign.witnessOf(rows) } }

      return same({
        stale: [timesOf(cutStale), m.history.thinningStatus(cutStale).status, m.history.thinningStatus(stale).status, cutStale.thinning],
        bare: [timesOf(cutBare), m.history.thinningStatus(cutBare).status, 'thinning' in cutBare],
        nothingOlder: [m.campaign.seriesFrom(stale, times[0]) === stale, m.campaign.seriesFrom(intact, times[0]) === intact],
        allOlder: m.campaign.seriesFrom(intact, 10 * YEAR),
      }, { stale: [[times[2], times[3]], 'partial', 'partial', stale.thinning], bare: [[times[2], times[3]], 'unknown', false], nothingOlder: [true, true], allOlder: null })
    }],
    ['units: an increment of the event archive that straddles the date goes whole and the cut is its end; the cut never falls below the one the cap made, and a record with nothing older is returned as it is', () => {
      const before = 100 * YEAR
      const group = [before, 12, 'An event', 1, 2, 0.5, 0.5, 3, 0, 1]
      const record = { increments: [[201, before - 3600, 7200, [group]], [202, before + 3600, DAY, [group]]], spans: [[before - 7200, before + DAY + 3600]], tip: [202, before + 3600, DAY], revision: 1, captures: [], conflicts: [] }
      const cut = m.events.eventsFrom(record, before)
      const capped = m.events.eventsFrom({ ...record, cut: before + 7200 }, before)
      const nothing = m.events.eventsFrom({ ...record, increments: [record.increments[1]], spans: [[before + 3600, before + DAY]] }, before)

      return same({ ids: cut.increments.map((increment) => increment[0]), cut: cut.cut, spans: cut.spans, capped: [capped.cut, capped.spans], nothing: nothing.cut === undefined && nothing.increments.length === 1 }, { ids: [202], cut: before + 3600, spans: [[before + 3600, before + DAY + 3600]], capped: [before + 7200, [[before + 7200, before + DAY + 3600]]], nothing: true })
    }],
    ['units: an observation record whose captures are all older goes with its objects, one with a failure noted keeps the failure and the cut, and a record with nothing older is returned as it is', () => {
      const race = { kinds: { formation: { captures: [[1, 1], [2, 2]], objects: { 13: [1, 2, HEX('d')] } } } }
      const failed = { kinds: { formation: { ...race.kinds.formation, failures: [{ at: 1, t: 5, reason: 'the read failed' }] } } }
      const cutFailed = m.obs.observationsFrom(failed, 10)

      return same({
        all: m.obs.observationsFrom(race, 10),
        failed: [cutFailed.kinds.formation.captures, cutFailed.kinds.formation.objects, cutFailed.kinds.formation.cut, cutFailed.kinds.formation.failures.length],
        readable: m.obs.observationFileProblem({ version: 1, races: { 7: cutFailed } }),
        nothingOlder: m.obs.observationsFrom(race, 1) === race,
      }, { all: null, failed: [[], {}, 2, 1], readable: null, nothingOlder: true })
    }],
    ['units: a time to clear before that is no number is refused and nothing is removed', async () => {
      world()

      const before = dump()
      let outcome = 'cleared'

      try {
        await clear(Number.NaN)
      } catch (error) {
        outcome = 'refused'
      }

      return same({ outcome, after: dump() }, { outcome: 'refused', after: before })
    }],
    ['units: an observation of a served page that raised an error no check named is refused credit, and a clean one is not', () => same([uncleanObservation({ unexpected: [] }), uncleanObservation({ unexpected: ['console: Vue warn'] })], [null, 'raised 1 unexpected error, the first: console: Vue warn'])],
  ]
}

const GROUPS = (m) => [...unitChecks(m)]

// ---------- the browser ----------

// The real app in Chromium (scripts/lib/page-server.js over a copy of the modded save, scripts/lib/browser-observe.js): the history files of the race are written to the browser's storage as a player's would be (the recorder has made the campaign and the branch; the snapshots, the colony series, the event archive and the observation record are then replaced by the fixture, and an extra branch file and another race stand beside them), and the Clear control of the History page is driven as a player does it. What the dialog and the Retention panel draw is read through the hooks of the page and the text it draws on screen; what the clear leaves is read from the storage.
const BROWSER_SAVE = { file: 'AuroraDB.db', game: 'Aurelian Empire', race: 'Aurelian Empire' }
const TIMEOUT = 120000
const STEP_BOUND = 15000
const BROWSER = { server: null, chrome: null, failure: null }
const GRAIN = 'None'

const sqlOf = (sql) => new Promise((resolve, reject) => {
  const handle = new sqlite3.Database(path.resolve(root, BROWSER_SAVE.file), sqlite3.OPEN_READONLY, (openError) => {
    if (openError) {
      reject(openError)

      return
    }

    handle.all(sql, (error, rows) => handle.close(() => (error ? reject(error) : resolve(rows))))
  })
})

// What the dialog draws, read in the page: whether it is on screen, each option with its state and the words it shows, the figures it states by their roles (the number and the whole line), the statement of what happens to the rest, and the button that confirms.
const readDialog = () => {
  const { visible, visibleText } = window.__screen
  const dialog = document.querySelector('[data-clear-dialog]')

  if (!dialog) {
    return null
  }

  const confirm = dialog.querySelector('[data-clear-confirm]')
  const effect = dialog.querySelector('[data-clear-effect]')
  const radio = (input) => input.closest('.v-radio')

  return {
    on: visible(dialog),
    options: [...dialog.querySelectorAll('input[data-clear-option]')].map((input) => ({ value: Number(input.getAttribute('data-clear-option')), checked: input.checked, label: visibleText(radio(input)).trim(), on: visible(radio(input)) })),
    figures: [...dialog.querySelectorAll('[data-clear-figure]')].map((element) => {
      const value = element.querySelector('[data-clear-value]')

      return { role: element.getAttribute('data-clear-figure'), on: visible(element), number: value ? visibleText(value).trim() : null, text: visibleText(element).trim() }
    }),
    effect: effect ? { on: visible(effect), text: visibleText(effect).trim() } : null,
    confirm: confirm ? { on: visible(confirm), disabled: confirm.disabled } : null,
    text: visibleText(dialog).trim(),
  }
}

// The Retention panel's readings of the race's series: the samples line, and the thinning line with the status the page gives it.
const readRetention = () => {
  const { visible, visibleText } = window.__screen
  const samples = document.querySelector('[data-retention-samples]')
  const counted = document.querySelector('[data-retention-samples] [data-retention-count]')
  const thinning = document.querySelector('[data-retention-thinning]')
  const limits = document.querySelector('[data-retention-limits]')

  return { limits: limits ? { on: visible(limits), text: visibleText(limits).trim() } : null, samples: samples ? { on: visible(samples), text: visibleText(samples).trim(), count: counted ? { on: visible(counted), text: visibleText(counted).trim() } : null } : null, thinning: thinning ? { on: visible(thinning), text: visibleText(thinning).trim(), status: thinning.getAttribute('data-status') } : null }
}

// The files of the history folder in the browser's storage, as the text each holds.
const readStorage = () => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('aurora-electrons:history/campaign-')).sort().map((key) => [key, localStorage.getItem(key)]))

// The branch file the recorder wrote for the race: its key and a snapshot of the race as the template of the seeded ones.
const findBranchFile = (RaceID) => {
  const suffixed = (key) => ['-colonies', '-events', '-observations'].some((suffix) => key.endsWith(suffix))

  for (const key of Object.keys(localStorage).filter((name) => name.startsWith('aurora-electrons:history/campaign-') && !suffixed(name))) {
    const file = JSON.parse(localStorage.getItem(key))

    if (file && file.races && file.races[RaceID] && Array.isArray(file.races[RaceID].snapshots) && file.races[RaceID].snapshots.length) {
      return { key, template: file.races[RaceID].snapshots[file.races[RaceID].snapshots.length - 1] }
    }
  }

  return null
}

const ASKED = '(() => { const { history, freshness } = window.$app.$store.state; return Boolean(history.ended) && history.ended.generation === freshness.generation })()'

// The case as a player meets it, each step read where it ends; resolves to the record of `observe`. A wait that does not end is a step that did not reach its change (kept in `steps`), never a throw, so that the checks name what is missing. `plan.until` is the last stage a variant needs ('seeded', 'dialog', 'cancel' or 'cleared').
const observeCase = (browser, server, plan) => observe(browser, async ({ page, step }) => {
  const pageLoading = require('./page-loading')
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !request.url().endsWith('/stat')
  const seen = { steps: [], dialogs: {} }
  let inFlight = 0

  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      inFlight++
    }
  })
  page.on('requestfinished', (request) => {
    if (isDatabaseCall(request)) {
      inFlight--
    }
  })
  page.on('requestfailed', (request) => {
    if (isDatabaseCall(request)) {
      inFlight--
    }
  })

  // The page is settled when the watchers of the next tick have run and two frames are drawn after them, no call of the database is in flight and no asynchronous read of the page is updating.
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
  // Every step of the registry's lock queue ahead of this one has ended: a clear the click started goes through it.
  const queued = () => page.evaluate(() => navigator.locks.request('aurora-electrons:registry', () => true))
  const reached = async (what, condition, arg = null) => {
    seen.steps.push({ what, reached: await page.waitForFunction(condition, arg, { timeout: STEP_BOUND }).then(() => true, () => false) })
  }
  const stopAt = (stage) => plan.until === stage
  const openDialog = async () => {
    step('pressing Clear')
    await page.locator('[data-clear-open]').first().click({ timeout: TIMEOUT })
    await reached('the dialog open', () => Boolean(document.querySelector('.v-dialog--active [data-clear-dialog]')))
    await animated()
    await settle()

    return page.evaluate(readDialog)
  }
  const choose = async (years) => {
    step(`choosing ${years}`)
    await page.locator(`.v-radio:has(input[data-clear-option="${years}"]) label`).first().click({ timeout: TIMEOUT })
    await animated()
    await settle()

    return page.evaluate(readDialog)
  }
  const closed = () => reached('the dialog closed', () => !document.querySelector('.v-dialog--active'))
  const animated = () => reached('the dialog at rest', () => { const content = document.querySelector('.v-dialog__content--active'); return !content || content.getAnimations({ subtree: true }).length === 0 })

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
  await page.waitForFunction(ASKED, null, { timeout: TIMEOUT })
  step('opening /history')
  await page.evaluate(() => window.$app.$router.push('/history', () => {}, () => {}))
  await page.waitForFunction(pageLoading.arrived, '/history', { timeout: TIMEOUT })
  await page.waitForSelector('[data-retention-samples]', { state: 'attached', timeout: TIMEOUT })
  await settle()

  // The files of the recorder's pass are replaced by the fixture: the race's latest snapshot is three years before the open save's time, so that the years of a clear are told from the latest snapshot and the open save's time apart.
  step('writing the history files of the race')

  const RaceID = await page.evaluate(() => Number(window.$app.$store.getters.RaceID))
  const found = await page.evaluate(findBranchFile, RaceID)

  if (!found) {
    throw new HarnessError('the recorder wrote no branch file for the race')
  }

  const latest = plan.gameTime - 3 * YEAR
  const files = filesOf(plan.modules, latest, RaceID, RaceID + 1, found.template)
  const put = {}

  ;[found.key, `${found.key}x`].forEach((key) => {
    put[key] = files.history
    put[`${key}-colonies`] = files.colonies
    put[`${key}-events`] = files.events
    put[`${key}-observations`] = files.observations
  })
  await page.evaluate((entries) => {
    Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(value)))
    window.$app.$store.commit('history/recorded')
  }, put)
  await settle()
  seen.files = { latest, times: files.times, key: found.key, RaceID }
  seen.storage = await page.evaluate(readStorage)
  seen.retention = await page.evaluate(readRetention)

  if (stopAt('seeded')) {
    return seen
  }

  seen.dialogs.opened = await openDialog()

  for (const years of [10, 20, 50]) {
    seen.dialogs[years] = await choose(years)
  }

  if (stopAt('dialog')) {
    return seen
  }

  // A choice cancelled: nothing is removed, and the dialog opens at Everything again.
  await choose(20)
  step('pressing Cancel')
  await page.locator('[data-clear-cancel]').first().click({ timeout: TIMEOUT })
  await closed()
  await queued()
  await settle()
  seen.cancelled = { storage: await page.evaluate(readStorage), retention: await page.evaluate(readRetention) }
  seen.dialogs.reopened = await openDialog()

  if (stopAt('cancel')) {
    return seen
  }

  await choose(10)
  step('pressing the Clear of the dialog')
  await page.locator('[data-clear-confirm]').first().click({ timeout: TIMEOUT })
  await reached('the clear counted by the page', () => {
    const matched = window.$app.$route.matched
    const view = matched.length ? matched[0].instances.default : null

    return Boolean(view) && view.cleared >= 1 && !view.confirmClear
  })
  await closed()
  await queued()
  await settle()
  seen.cleared = { storage: await page.evaluate(readStorage), retention: await page.evaluate(readRetention) }

  return seen
})

const openBrowser = async () => {
  try {
    BROWSER.server = await startPageServer({ save: BROWSER_SAVE.file })
    BROWSER.chrome = await require('playwright').chromium.launch()

    const warmed = await BROWSER.server.warm(BROWSER.chrome, { routes: ['/history'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  } catch (error) {
    BROWSER.failure = String(error.message).split('\n')[0]
  }
}

const closeBrowser = async () => {
  const { server, chrome } = BROWSER

  BROWSER.server = null
  BROWSER.chrome = null

  if (chrome) {
    await chrome.close()
  }

  if (server) {
    await server.stop()
  }
}

const observeSource = async (modules, replacements = [], until = null) => {
  if (BROWSER.failure || !BROWSER.chrome) {
    return failedObservation(BROWSER.failure || 'the page server was not started for this worker')
  }

  const [{ GameTime }] = await sqlOf('select GameTime from FCT_Game where GameID = 140')

  replacements.forEach(([file, text]) => BROWSER.server.replace(file, text))

  try {
    const seen = await observeCase(BROWSER.chrome, BROWSER.server, { until, gameTime: GameTime, modules })

    report(replacements.length ? 'a variant of the app' : 'the history page', seen)

    return seen
  } catch (error) {
    return failedObservation(String(error.message).split('\n')[0])
  } finally {
    replacements.forEach(([file]) => BROWSER.server.replace(file, null))
  }
}

// The checks of the browser case: `[name, test]`, each given the screens the case read (`value` of the observation) and returning true or what was seen. The hooks find the elements; what is judged is the text they draw on screen and the files the storage holds.
const browserStatements = (m) => {
  const WORDS = m.history.CLEAR_WORDS
  const wordIn = (text, word) => new RegExp('\\b' + word + '\\b').test(text)
  const unreached = (screens) => screens.steps.filter((step) => !step.reached).map((step) => step.what).slice(0, 1)
  const number = (text) => (text === null ? null : readFigure(text, GRAIN))
  const figureKind = (figure) => (wordIn(figure.text, WORDS.removed) && !wordIn(figure.text, WORDS.kept) ? 'removed' : wordIn(figure.text, WORDS.kept) && !wordIn(figure.text, WORDS.removed) ? 'kept' : null)
  const figures = (dialog) => (dialog ? Object.fromEntries(dialog.figures.filter((figure) => figure.on).map((figure) => [figureKind(figure), number(figure.number)])) : null)
  const labelKind = (label) => {
    const tokens = label.toLowerCase().split(/\s+/)
    const has = (phrase) => phrase.toLowerCase().split(' ').every((word) => tokens.includes(word))
    const years = tokens.filter((token) => /^\d+$/.test(token))

    return label === WORDS.all ? 'all' : has(WORDS.older) && has(WORDS.years) && years.length === 1 ? `older:${years[0]}` : null
  }
  const parsed = (screens, storage, suffix = '') => (storage[`${screens.files.key}${suffix}`] === undefined ? null : JSON.parse(storage[`${screens.files.key}${suffix}`]))
  const raceOf = (file, own) => (file && file.races ? file.races[own] || null : null)
  const timesOf = (race) => (race ? race.snapshots.map((snapshot) => snapshot.t) : null)
  const samples = (retention) => (retention && retention.samples && retention.samples.on && retention.samples.count && retention.samples.count.on ? readFigure(retention.samples.count.text, GRAIN) : null)
  const VOICE = /\b(i|me|my|mine|you|your|yours|we|our|ours)\b/i
  const expected = (screens) => {
    const at = (age) => screens.files.latest - Math.round(age * YEAR)

    return { at, table: expectedOf(at, screens.files.times) }
  }
  const optionsOf = (dialog) => dialog.options.map((option) => [option.value, option.on, labelKind(option.label), option.checked])

  return [
    ['browser: the dialog opens at Everything with the options Everything and older than 10, 20 and 50 years, and states that every snapshot of the race is removed and none kept', (screens) => same({ reached: unreached(screens).slice(0, 1), open: screens.dialogs.opened && screens.dialogs.opened.on, options: screens.dialogs.opened && optionsOf(screens.dialogs.opened), figures: figures(screens.dialogs.opened), seeded: samples(screens.retention) }, { reached: [], open: true, options: [[0, true, 'all', true], [10, true, 'older:10', false], [20, true, 'older:20', false], [50, true, 'older:50', false]], figures: { removed: 6, kept: 0 }, seeded: 6 })],
    ['browser: each older-than option states the snapshots it removes and keeps from the race\'s latest snapshot, one exactly at the bound kept, and the option chosen is the one marked', (screens) => same(Object.fromEntries([10, 20, 50].map((years) => [years, { figures: figures(screens.dialogs[years]), chosen: screens.dialogs[years] && screens.dialogs[years].options.filter((option) => option.checked).map((option) => option.value) }])), Object.fromEntries([10, 20, 50].map((years) => [years, { figures: COUNTS[years], chosen: [years] }])))],
    ['browser: an option that would remove nothing cannot be confirmed and the others can', (screens) => same([0, 10, 20, 50].map((years) => (years === 0 ? screens.dialogs.opened : screens.dialogs[years]).confirm).map((confirm) => [confirm.on, confirm.disabled]), [[true, false], [true, false], [true, false], [true, true]])],
    ['browser: the dialog is visible and says in the impersonal voice what happens to the rest: other races and other branches are untouched', (screens) => {
      const dialog = screens.dialogs[10]

      return same({ on: dialog.on && dialog.effect.on, voice: VOICE.test(dialog.text), races: /\bother races\b/i.test(dialog.effect.text), branches: /\bother branches\b/i.test(dialog.effect.text) }, { on: true, voice: false, races: true, branches: true })
    }],
    ['browser: the dialog and the Retention foot say that a Merge restore brings back the snapshots and a record the clear removed whole, and that a record the clear only cut comes back with a Replace restore', (screens) => {
      const says = (entry) => (entry && entry.on ? [/\bMerge\b/.test(entry.text), /\bReplace\b/.test(entry.text), /\bonly cut\b/.test(entry.text)] : null)

      return same({ dialog: says(screens.dialogs[10].effect), foot: says(screens.retention.limits) }, { dialog: [true, true, true], foot: [true, true, true] })
    }],
    ['browser: cancelling removes nothing, and the next opening starts again at Everything whatever was chosen before', (screens) => same({ storage: screens.cancelled.storage, retention: samples(screens.cancelled.retention), reopened: screens.dialogs.reopened.options.filter((option) => option.checked).map((option) => option.value), figures: figures(screens.dialogs.reopened) }, { storage: screens.storage, retention: 6, reopened: [0], figures: { removed: 6, kept: 0 } })],
    ['browser: clearing older than 10 years leaves in the shown branch exactly the race\'s snapshots at or after the bound, and the other race, its intel and the extra branch exactly as they were', (screens) => {
      const { storage } = screens.cleared
      const key = screens.files.key
      const before = Object.fromEntries(Object.entries(screens.storage).map(([name, text]) => [name, JSON.parse(text)]))
      const after = Object.fromEntries(Object.entries(storage).map(([name, text]) => [name, JSON.parse(text)]))
      const own = String(screens.files.RaceID)
      const other = String(screens.files.RaceID + 1)
      const kept = expected(screens).table[10].kept.map((index) => screens.files.times[index])

      return same({ own: timesOf(raceOf(after[key], own)), rest: [after[key] && after[key].races[other], after[key] && after[key].intel, after[`${key}-colonies`] && after[`${key}-colonies`].races[other], after[`${key}-events`] && after[`${key}-events`].races[other], after[`${key}-observations`] && after[`${key}-observations`].races[other]], extra: Object.keys(after).filter((name) => name.startsWith(`${key}x`)).map((name) => storage[name] === screens.storage[name]), files: Object.keys(after).length }, { own: kept, rest: [before[key].races[other], before[key].intel, before[`${key}-colonies`].races[other], undefined, undefined], extra: [true, true, true, true], files: Object.keys(before).length })
    }],
    ['browser: the colony series, the event archive and the observation record are cut at the same date with their own cut, and the Retention panel counts the kept snapshots and reads the series as thinned as before, never partial', (screens) => {
      const { storage, retention } = screens.cleared
      const { table } = expected(screens)
      const own = String(screens.files.RaceID)
      const colonies = raceOf(parsed(screens, storage, '-colonies'), own)
      const events = raceOf(parsed(screens, storage, '-events'), own)
      const observed = raceOf(parsed(screens, storage, '-observations'), own)
      const formation = observed ? observed.kinds.formation : null
      const times = table[10].kept.map((index) => screens.files.times[index])

      return same({
        colonies: timesOf(colonies),
        events: events ? [events.increments.map((increment) => increment[0]), events.cut, events.spans] : null,
        observations: formation ? [formation.captures.map(([t]) => t), formation.cut] : null,
        samples: samples(retention),
        thinning: [retention.thinning && retention.thinning.on, retention.thinning && retention.thinning.status, retention.thinning && retention.thinning.text],
        reached: unreached(screens).slice(0, 1),
      }, {
        colonies: times,
        events: [table[10].events, table[10].eventCut, table[10].eventSpans],
        observations: [times, table[10].obsCut],
        samples: 3,
        thinning: [true, screens.retention.thinning.status, screens.retention.thinning.text],
        reached: [],
      })
    }],
    ['browser: before the clear the Retention panel reads the seeded series as thinned, and no page error was raised', (screens, observation) => same({ status: screens.retention.thinning.status, errors: observation.unexpected }, { status: 'thinned', errors: [] })],
  ]
}

// The browser checks for `runChecks` over { observation }: a page that did not get through fails each of them by naming why.
const browserChecks = (m) => browserStatements(m).map(([name, test]) => ({ id: name, name, run: ({ observation }) => verdictHeld(unobserved(observation) ? `the page did not get through: ${observation.error}` : test(observation.value, observation)) }))

// ---------- the faults ----------

const utilityFile = (name) => path.join(utilitiesDirectory, name)

/* eslint-disable no-template-curly-in-string */
// Faults planted in the utilities, each with the checks it must break by a value (`fails`, the starts of check names).
const MUTATIONS = [
  { name: 'a snapshot exactly at the bound removed by the cut', file: 'campaign.js', find: 'const kept = snapshots.filter((snapshot) => snapshot.t >= before)', replace: 'const kept = snapshots.filter((snapshot) => snapshot.t > before)', fails: ['units: Older than 10 years removes', 'units: Older than 20 years removes'] },
  { name: 'a snapshot exactly at the bound counted as removed by the dialog', file: 'history.js', find: 'const removed = snapshots.filter((snapshot) => snapshot.t < before).length', replace: 'const removed = snapshots.filter((snapshot) => snapshot.t <= before).length', fails: ['units: the dialog counts'] },
  { name: 'the years counted from the earliest snapshot instead of the latest', file: 'history.js', find: 'const before = Math.max(...snapshots.map((snapshot) => snapshot.t)) - years * SECONDS_PER_YEAR', replace: 'const before = Math.min(...snapshots.map((snapshot) => snapshot.t)) - years * SECONDS_PER_YEAR', fails: ['units: the dialog counts'] },
  { name: 'the other race cut as well', file: 'history.js', find: 'stored.races[RaceID] = rest', replace: 'Object.keys(stored.races).forEach((id) => { stored.races[id] = cutRecord(stored.races[id], before) || stored.races[id] })\n      stored.races[RaceID] = rest', fails: ['units: Older than 10 years removes', 'units: Older than 20 years removes'] },
  { name: 'the witness of the thinning record not rewritten', file: 'campaign.js', find: 'thinning: { ...thinning, witness: witnessOf(kept) }', replace: 'thinning', fails: ['units: the thinning record of a cut series'] },
  { name: 'the colony series left as it was', file: 'history.js', find: 'planned(colonyStore(campaignId, branchId), seriesFrom),', replace: 'null,', fails: ['units: Everything removes', 'units: Older than 10 years cuts'] },
  { name: 'the event archive left as it was', file: 'history.js', find: 'planned(eventStore(campaignId, branchId), eventsFrom),', replace: 'null,', fails: ['units: Everything removes', 'units: Older than 10 years cuts'] },
  { name: 'the observation record left as it was', file: 'history.js', find: 'planned(observationStore(campaignId, branchId), observationsFrom),', replace: 'null,', fails: ['units: Everything removes', 'units: Older than 10 years cuts'] },
  { name: 'the cut of the event archive not set', file: 'event-archive.js', find: 'increments: record.increments.filter((increment) => increment[1] >= before), spans, cut, conflicts:', replace: 'increments: record.increments.filter((increment) => increment[1] >= before), spans, conflicts:', fails: ['units: Older than 10 years cuts', 'units: an increment of the event archive'] },
  { name: 'the spans of the event archive not cut', file: 'event-archive.js', find: 'increments: record.increments.filter((increment) => increment[1] >= before), spans, cut, conflicts:', replace: 'increments: record.increments.filter((increment) => increment[1] >= before), spans: record.spans, cut, conflicts:', fails: ['units: Older than 10 years cuts', 'units: Older than 20 years cuts'] },
  { name: 'the cut of the event archive taken at the date and not at the end of the increment dropped', file: 'event-archive.js', find: 'const cut = Math.max(isKnownNumber(record.cut) ? record.cut : -Infinity, before, ...dropped.map(endOf))', replace: 'const cut = Math.max(isKnownNumber(record.cut) ? record.cut : -Infinity, before)', fails: ['units: an increment of the event archive'] },
  { name: 'the spans not clipped to the cut by the helper the cap and the clear share', file: 'event-archive.js', find: 'spans.filter(([, end]) => end > cut).map(([start, end]) => [Math.max(start, cut), end])', replace: 'spans', fails: ['units: Older than 10 years cuts', 'units: Older than 20 years cuts'] },
  { name: 'the cut of the observation record not set', file: 'observations.js', find: 'const kept = { ...record, captures: record.captures.filter(([t]) => t >= before), objects, cut }', replace: 'const kept = { ...record, captures: record.captures.filter(([t]) => t >= before), objects }', fails: ['units: Older than 10 years cuts', 'units: Older than 20 years cuts', 'units: an observation record whose captures'] },
  { name: 'an object whose newest sighting was dropped kept', file: 'observations.js', find: '.filter(([, entry]) => entry[1] >= before))', replace: '.filter(() => true))', fails: ['units: an observation record whose captures'] },
  { name: 'a time that is no number cleared as everything', file: 'history.js', find: 'if (before !== null && !Number.isFinite(before)) {', replace: 'if (false) {', fails: ['units: a time to clear before'] },
  { name: 'a store written as soon as it is cut, before the next is read', file: 'history.js', find: '    return { store, stored }\n  }', replace: '    store.store = stored\n\n    return { store, stored }\n  }', fails: ['units: a clear of everything whose observation record', 'units: a clear older than a span whose'] },
  { name: 'a clear that finds nothing older still rewrites the file', file: 'history.js', find: 'if (rest === record) {\n      return null\n    }', replace: 'if (false) {\n      return null\n    }', fails: ['units: a series shorter than the span'] },
]

const PAGE_REPLACEMENTS = {
  openSaveTime: [HISTORY_FILE, 'const plan = clearPlan(this.allSnapshots, this.clearYears)', 'const plan = clearPlan(this.allSnapshots.concat({ t: this.GameTime }), this.clearYears)'],
}

// Faults planted in what the browser is served: the page or a utility the page uses, with the checks each must fail by a value. A utility the recorder runs is served too, so a fault there shows as the screen a player sees.
const BROWSER_MUTATIONS = [
  { name: 'the years taken from the open save\'s time instead of the latest snapshot', edits: [PAGE_REPLACEMENTS.openSaveTime, [HISTORY_FILE, 'before: clearPlan(this.allSnapshots, this.clearYears).before }', 'before: this.GameTime - this.clearYears * SECONDS_PER_YEAR }']], fails: ['browser: each older-than option', 'browser: clearing older than 10 years'], until: 'cleared' },
  { name: 'the dialog counting no snapshot as kept', edits: [[HISTORY_FILE, '<strong data-clear-value>{{ count(clearView.kept, 0) }}</strong>', '<strong data-clear-value>{{ count(0, 0) }}</strong>']], fails: ['browser: each older-than option'], until: 'dialog' },
  { name: 'the dialog confirming an option that removes nothing', edits: [[HISTORY_FILE, ':disabled="clearView.removed === 0" data-clear-confirm', ':disabled="false" data-clear-confirm']], fails: ['browser: an option that would remove nothing'], until: 'dialog' },
  { name: 'the choice remembered for the next opening', edits: [[HISTORY_FILE, 'openClear() {\n      this.clearYears = 0\n      this.confirmClear = true', 'openClear() {\n      this.confirmClear = true']], fails: ['browser: cancelling removes nothing'], until: 'cancel' },
  { name: 'Cancel clearing the history', edits: [[HISTORY_FILE, '<v-btn text data-clear-cancel @click="confirmClear = false">Cancel</v-btn>', '<v-btn text data-clear-cancel @click="clearHistory">Cancel</v-btn>']], fails: ['browser: cancelling removes nothing'], until: 'cancel' },
  { name: 'the option ignored by the confirmed clear', edits: [[HISTORY_FILE, 'before: clearPlan(this.allSnapshots, this.clearYears).before }', 'before: null }']], fails: ['browser: clearing older than 10 years', 'browser: the colony series'], until: 'cleared' },
  { name: 'the thinning record left stale by the clear, the page served the utility with the witness not rewritten', edits: [[utilityFile('campaign.js'), 'thinning: { ...thinning, witness: witnessOf(kept) }', 'thinning']], fails: ['browser: the colony series'], until: 'cleared' },
  { name: 'the option that removes everything worded as keeping it, its hook left as it is', edits: [[HISTORY_FILE, '[{ value: 0, text: CLEAR_WORDS.all }]', "[{ value: 0, text: 'Keep everything' }]"]], fails: ['browser: the dialog opens at Everything'], until: 'dialog' },
  { name: 'the captions of the two figures swapped, their hooks left as they are', edits: [[HISTORY_FILE, "'snapshots' }} {{ clearWords.removed }}<template", "'snapshots' }} {{ clearWords.kept }}<template"], [HISTORY_FILE, "'snapshots' }} {{ clearWords.kept }}</div>", "'snapshots' }} {{ clearWords.removed }}</div>"]], fails: ['browser: the dialog opens at Everything', 'browser: each older-than option'], until: 'dialog' },
  { name: 'the dialog promising that a Merge restore brings back what the clear removed, with no word of a record only cut', edits: [[HISTORY_FILE, 'still holds what it removes. A Merge restore brings back the removed snapshots and any event archive or observation record the clear removed whole; a record of either that the clear only cut is kept as it is under Merge and comes back with a Replace restore.', 'still holds what it removes. A Merge restore brings back what the clear removed.']], fails: ['browser: the dialog and the Retention foot say'], until: 'dialog' },
  { name: 'the Retention foot promising that a Merge restore brings back what the clear removed, with no word of a record only cut', edits: [[HISTORY_FILE, 'still holds what the clear removed. A Merge restore brings back the removed snapshots and any event archive or observation record the clear removed whole; a record of either that the clear only cut is kept as it is under Merge and comes back with a Replace restore.', 'still holds what the clear removed. A Merge restore brings back what the clear removed.']], fails: ['browser: the dialog and the Retention foot say'], until: 'dialog' },
  { name: 'the figures of the dialog hidden by an ancestor, their hooks left as they are', edits: [[HISTORY_FILE, '<div class="mt-3" data-clear-counts>', '<div class="mt-3" style="display: none" data-clear-counts>']], fails: ['browser: each older-than option'], until: 'dialog' },
]

// One rewrite of each family that draws the same screen and records the same files: each must fail no check.
const BENIGN = [
  { name: 'a parenthesised test of a cut', file: 'campaign.js', find: 'if (!kept.length) {', replace: 'if ((kept.length === 0)) {' },
  { name: 'the test of the date written the other way round', file: 'history.js', find: 'const rest = before === null ? null : cutRecord(record, before)', replace: 'const rest = (before === null) ? null : cutRecord(record, before)' },
  { name: 'the test of an observation written with its qualifier last', file: 'observations.js', find: 'const dropped = record.captures.filter(([t]) => t < before)', replace: 'const dropped = record.captures.filter(([t]) => before > t)' },
]

// One rewrite of each family the lane brief names, made together in the page and served once: the choice bound by an explicit prop and event instead of `v-model`, the listener of the Clear button written `v-on:`, a parenthesised condition, the words of an option with its scope worded in front ("Snapshots older than 10 years"), and two synonyms in the generated prose. The page must draw the same screen and no check fail.
const BROWSER_BENIGN = [
  {
    name: 'the equivalent forms of each family',
    edits: [
      [HISTORY_FILE, '<v-radio-group v-model="clearYears" hide-details dense class="mt-0 pt-0">', '<v-radio-group :value="clearYears" hide-details dense class="mt-0 pt-0" @change="clearYears = $event">'],
      [HISTORY_FILE, 'data-clear-open @click="openClear"', 'data-clear-open v-on:click="openClear"'],
      [HISTORY_FILE, ':disabled="clearView.removed === 0" data-clear-confirm', ':disabled="(clearView.removed === 0)" data-clear-confirm'],
      [HISTORY_FILE, '</span> kept for the race', '</span> retained for the race'],
      [HISTORY_FILE, '`${CLEAR_WORDS.older} ${years} ${CLEAR_WORDS.years}`', '`Snapshots ${CLEAR_WORDS.older.toLowerCase()} ${years} ${CLEAR_WORDS.years}`'],
      [HISTORY_FILE, 'and recording goes on at the next save.', 'and recording resumes at the next save.'],
    ],
  },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the parts ----------

const stemOf = (file) => path.basename(file, '.js')

const MUTANTS = [
  ...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })),
  ...BENIGN.map((rewrite, index) => ({ kind: 'benign', id: `benign:${index}`, ...rewrite })),
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

const checkUtilityMutation = async (mutant) => {
  const { kind, name, file, find, replace, fails } = mutant
  const began = Date.now()
  const benign = kind === 'benign'

  try {
    const target = utilityFile(file)
    const text = patched(target, fs.readFileSync(target, 'utf8'), find, replace)
    const m = await loadAll({ [stemOf(file)]: text })

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

// What a browser variant serves: [file, text] for each file its edits change, the edits made in order (`edits`, [file, find, replace]).
const servedBy = ({ edits }) => {
  const served = new Map()

  edits.forEach(([target, from, to]) => served.set(target, patched(target, served.has(target) ? served.get(target) : fs.readFileSync(target, 'utf8'), from, to)))

  return [...served]
}

// What an observation says against crediting anything of it: a page that raised an error no check named. The named checks of a fault do not include the one that asserts a clean page, so each served variant is held to it here.
const uncleanObservation = (observation) => (observation.unexpected.length ? `raised ${observation.unexpected.length} unexpected error${observation.unexpected.length === 1 ? '' : 's'}, the first: ${observation.unexpected[0]}` : null)

// A fault or a benign rewrite served to the browser (`observeSource`). A fault must fail by a value each check it names (`caughtBy`), a rewrite none; a variant whose page did not get through is judged by nothing and fails as a defect of the harness. A fault stops the case at the stage its named checks read (`until`) and judges those checks alone; a rewrite runs the whole case and every check.
const checkBrowserVariant = async (mutant, real) => {
  const { kind, name, fails = [], throws = false, until = null } = mutant
  const began = Date.now()
  const fault = kind === 'browser'
  const observation = await observeSource(real, servedBy(mutant), fault ? until : null)

  if (unobserved(observation)) {
    throw new HarnessError(`the app with the fault "${name}" did not get through: ${observation.error}`)
  }

  const dirty = uncleanObservation(observation)

  if (dirty) {
    throw new HarnessError(`the app with the ${fault ? 'fault' : 'rewrite'} "${name}" ${dirty}, so no check of it is credited`)
  }

  const results = await runChecks(fault ? browserChecks(real).filter(({ id }) => fails.some((start) => id.startsWith(start))) : browserChecks(real), { observation })
  const failed = judged(results, `the ${fault ? 'fault' : 'rewrite'} "${name}"`)
  const took = `${((Date.now() - began) / 1000).toFixed(1)} s`

  if (fault) {
    const missed = fails.filter((start) => !caughtBy(failed, results.map((result) => result.id).filter((id) => id.startsWith(start)), { name, throws }))

    check(`browser mutation caught: ${name}`, missed.length ? `these checks did not fail by a value: ${missed.join('; ')} (failed: ${creditOf(failed)})` : true, `credited by ${creditOf(failed)}, ${took}`)
  } else {
    check(`browser benign rewrite: ${name}: no check fails`, failed.length === 0 ? true : failed.map((result) => `${result.name}: ${result.detail}`).join('; '), took)
  }
}

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
    const observation = await observeSource(real)

    printResults(await runChecks(browserChecks(real), { observation }))
  } else if (mutant) {
    await checkBrowserVariant(mutant, real)
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

// The deadlines, in seconds: a part in memory runs the units; a part served to the browser starts the app once; the setup starts and warms the page server, the one cold start of the run.
const DEADLINES = { part: 240, mutant: 240, browser: 400, setup: 900 }
const MUTATIONS_HEADING = '\nMutations: each must fail by a value the checks it names, and each benign rewrite none'

const variantsOf = (options) => [
  { key: 'groups', name: 'the clear: units', head: true, heading: 'The clear of a race\'s history: what it removes, what the dialog counts and how the records kept with it are cut', deadline: DEADLINES.part, run: () => runPart('groups') },
  { key: 'browser', name: 'the browser', head: true, heading: '\nThe browser (the app over a copy of AuroraDB.db with the history files of the race seeded, in Chromium)', pool: 'browser', deadline: DEADLINES.browser, run: () => runPart('browser') },
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
    inputs: [path.resolve(root, BROWSER_SAVE.file)].filter((input) => fs.existsSync(input)),
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
    control: options.mutations ? { fault: 'browser:2', head: 'browser', heading: '\nThe control of the warm page server' } : null,
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
