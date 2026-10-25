/*
  Checks the retention of Empire History: how many samples a series keeps (utilities/history.js: the bounded profiles, `thinCounted`, the thinning record a series carries, the statistics and size estimates) and the Retention panel of src/renderer/pages/history.vue.

  node scripts/check-history-retention.js [--no-mutations]

  Groups:
  - thinning: the older half is thinned to a stated cap and the first and the latest samples are kept, in order, however irregular a long history is; the passes and the samples they dropped are counted;
  - status: a series the recorder started says nothing was thinned, one from before the record says that is unknown (never none, never complete), a series written by something else since is a lower bound, and a record that is not valid is not believed;
  - figures: sample count, the largest and the typical gap, and sizes: measured bytes are those of the stored series, predicted bytes are those of thinning its rows to a profile, and what is not known is a dash, never 0;
  - recorder: on recorded saves of the passive campaign of artifacts/passive-campaign-20261013 (read only, skipped when it is not here), the profile in the settings is the cap at the next save, a larger cap does not bring discarded samples back, and the saves are not changed;
  - backup: a series' thinning record is carried by a backup and restored exactly, a backup from before it restores with the thinning unknown, an invalid record is refused, and a merge that changes a series' rows no longer claims it is complete;
  - page: the page's own script and its Retention panel (the shipped template is compiled and rendered by Vue without a document) over the real persisted-view mixin and an in-memory settings store: the readouts, the statement that discarded samples cannot be restored shown before a change, the confirmation, the profile kept across a restart, and the sparse-sampling line and CSV.

  Everything runs on in-memory stores. Each mutation of the utilities or of the page must fail the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const nodeVm = require('vm')
const crypto = require('crypto')
const { format } = require('util')
const Vue = require('vue')
const { compileTemplate } = require('vue/compiler-sfc')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, replacing } = require('./lib/page-loader')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')
const { readFigure } = require('./lib/browser-observe')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pageFile = path.join(root, 'src', 'renderer', 'pages', 'history.vue')
const PASSIVE = path.join(root, 'artifacts', 'passive-campaign-20261013')
const NAMES = ['history', 'history-backup', 'campaign', 'campaign-attach', 'recording-owner', 'observations']
const START_YEAR = 2050
const DAY = 86400
const YEAR = 31536000

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { constructor(options = {}) { this.name = options.name } get store() { const held = globalThis.__heldStores; if (globalThis.__storeReads) { globalThis.__storeReads.push(this.name) } return held && held.has(this.name) ? JSON.parse(JSON.stringify(held.get(this.name))) : {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const warnings = []

Vue.config.productionTip = false
Vue.config.devtools = false
Vue.config.warnHandler = (message) => warnings.push(message)

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value))

// ---------- the history worked by hand ----------

// A snapshot of a race with figures the backup knows, and one of what a race knows of another (its `contact` changes with the time, so each is kept).
const row = (t, extra = {}) => ({ t, population: t / 10, wealth: 100 + (t % 1000), ...extra })

const intelRow = (t) => ({ t, contact: t, comm: 2 })

const rowsAt = (times) => times.map((t) => row(t))

const timesOf = (rows) => rows.map((snapshot) => snapshot.t)

// A long history whose gaps are irregular (a seeded generator, so it is the same each run): from one second to a bit over an hour.
const irregular = (count, seed = 7) => {
  let state = seed
  let t = 0

  return Array.from({ length: count }, () => {
    state = (state * 16807) % 2147483647
    t += 1 + (state % 4000)

    return row(t)
  })
}

const strictlyIncreasing = (rows) => rows.every((snapshot, index) => index === 0 || snapshot.t > rows[index - 1].t)

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

const stepped = (from, to) => Array.from({ length: (to - from) / 2 + 1 }, (_, index) => from + 2 * index)

// The game times of the two series the merge checks use: the first holds every second time of 0 to 998 and every time of 1000 to 2000, the second the odd times of 1 to 999, so the union of the two (2001 times) is thinned back to exactly the first's 1501 times, and the second's 500 are lost without the times left showing it.
const FIRST_TIMES = [...stepped(0, 998), ...range(1000, 2000)]
const SECOND_TIMES = stepped(1, 999)

// What thinning the union of two lists of snapshots gives (the first list's snapshot stays at a shared time), as a merge makes it.
const united = (history, first, second) => {
  const known = new Set(first.map((snapshot) => snapshot.t))

  return history.thinCounted([...first, ...second.filter((snapshot) => !known.has(snapshot.t))].sort((a, b) => a.t - b.t))
}

// ---------- the utilities ----------

const suite = (m) => {
  const { history, campaign } = m
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  let clock = 5000000
  const now = () => ++clock

  // A file with each of `times` added to the race 7 series in turn, as the recorder does.
  const recorded = (times, { limit, file = {}, race = 7 } = {}) => times.reduce((result, t) => history.mergeGame(result, { gameName: 'Game', races: [{ RaceID: race, raceName: 'Terran', npr: false, snapshot: row(t) }] }, { limit, now }), file)

  const intelRecorded = (times, { limit, file = {} } = {}) => times.reduce((result, t) => history.mergeGame(result, { gameName: 'Game', races: [], intel: { 7: [{ AlienRaceID: 9, name: 'Alien', snapshot: intelRow(t) }] } }, { limit, now }), file)

  const seriesOf = (file, race = 7) => file.races[race]

  // ---- thinning ----

  check('thinning', 'ten snapshots over a cap of five are thinned in three passes that drop five, keeping the first and the latest', () => {
    const out = history.thinCounted(rowsAt([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 5)

    assert.deepEqual(timesOf(out.snapshots), [0, 6, 7, 8, 9])
    assert.equal(out.passes, 3)
    assert.equal(out.dropped, 5)
    assert.equal(out.cap, 5)
  })

  check('thinning', 'a history within its cap is not thinned and nothing is counted', () => {
    const rows = rowsAt([0, 1, 2, 3, 4])
    const out = history.thinCounted(rows, 5)

    assert.deepEqual(out.snapshots, rows)
    assert.equal(out.passes, 0)
    assert.equal(out.dropped, 0)
  })

  check('thinning', 'every profile bounds a long irregular history: the first and the latest samples stay, in order, and the count is the cap or less', () => {
    const rows = irregular(5000)

    history.RETENTION_PROFILES.forEach((profile) => {
      for (const length of [profile.cap, profile.cap + 1, 2 * profile.cap + 1, 5000]) {
        const input = rows.slice(0, length)
        const out = history.thinCounted(input, profile.cap)

        assert.ok(out.snapshots.length <= profile.cap, `${profile.id} ${length}: ${out.snapshots.length}`)
        assert.equal(out.snapshots[0].t, input[0].t, `${profile.id} ${length}: the first sample`)
        assert.equal(out.snapshots[out.snapshots.length - 1].t, input[input.length - 1].t, `${profile.id} ${length}: the latest sample`)
        assert.ok(strictlyIncreasing(out.snapshots), `${profile.id} ${length}: order`)
        assert.equal(out.dropped, input.length - out.snapshots.length, `${profile.id} ${length}: the count dropped`)
        assert.equal(out.passes > 0, length > profile.cap)
      }
    })
  })

  check('thinning', 'recording one save at a time keeps a series within its cap, its latest sample is always the one just taken, and the record counts exactly what went', () => {
    let file = {}
    const added = 1500
    const first = 100

    for (let index = 0; index < added; index++) {
      file = recorded([first + index * 37], { limit: 500, file })

      const rows = seriesOf(file).snapshots

      assert.ok(rows.length <= 500, `step ${index}: ${rows.length}`)
      assert.equal(rows[rows.length - 1].t, first + index * 37, `step ${index}: the latest sample`)
    }

    const series = seriesOf(file)
    const status = history.thinningStatus(series)

    assert.equal(series.snapshots[0].t, first, 'the first sample is still the first')
    assert.ok(strictlyIncreasing(series.snapshots))
    assert.equal(status.status, 'thinned')
    assert.ok(status.passes >= 1)
    assert.equal(status.dropped, added - series.snapshots.length, 'the samples dropped are the ones missing')
    assert.equal(status.last.cap, 500)
    assert.ok(status.last.t <= series.snapshots[series.snapshots.length - 1].t && status.last.t > first)
  })

  check('thinning', 'a cap too small to thin by halves still ends and keeps the latest samples', () => {
    const rows = rowsAt([0, 1, 2, 3, 4, 5])
    const two = history.thinCounted(rows, 2)
    const one = history.thinCounted(rows, 1)

    assert.deepEqual(timesOf(two.snapshots), [4, 5])
    assert.deepEqual(timesOf(one.snapshots), [5])
    assert.equal(two.dropped, 4)
  })

  check('thinning', 'thinSnapshots gives the snapshots thinCounted keeps', () => {
    const rows = irregular(300)

    assert.deepEqual(history.thinSnapshots(rows, 100), history.thinCounted(rows, 100).snapshots)
    assert.deepEqual(history.thinSnapshots(rows), rows)
    assert.equal(history.thinSnapshots(irregular(2100)).length <= history.MAX_SNAPSHOTS, true)
  })

  check('thinning', 'the profiles are a few, each with a stated cap no larger than a backup accepts, and Standard is the default', () => {
    const profiles = history.RETENTION_PROFILES

    assert.ok(profiles.length >= 2 && profiles.length <= 5)
    assert.deepEqual(profiles.map((profile) => profile.id), ['compact', 'balanced', 'standard'])
    assert.ok(profiles.every((profile) => Number.isInteger(profile.cap) && profile.cap > 0 && profile.cap <= history.MAX_SNAPSHOTS && profile.label))
    assert.ok(profiles.every((profile, index) => index === 0 || profile.cap > profiles[index - 1].cap))
    assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length)
    assert.equal(history.DEFAULT_RETENTION, 'standard')
    assert.equal(history.retentionProfile('standard').cap, history.MAX_SNAPSHOTS)
    assert.equal(history.retentionProfile('compact').cap, 500)
  })

  check('thinning', 'a profile that is not one of the profiles reads as the default, whatever the settings hold', () => {
    assert.equal(history.retentionProfile('huge').id, 'standard')
    assert.equal(history.retentionProfile(undefined).id, 'standard')
    assert.equal(history.retentionOfSettings(null).id, 'standard')
    assert.equal(history.retentionOfSettings({ store: {} }).id, 'standard')
    assert.equal(history.retentionOfSettings({ store: { historyRetention: 'compact' } }).id, 'compact')
    assert.equal(history.retentionOfSettings({ store: { historyRetention: 'huge' } }).id, 'standard')
  })

  // ---- status ----

  check('status', 'a series the recorder starts is untouched, with nothing dropped', () => {
    const series = seriesOf(recorded([100, 200, 300]))
    const status = history.thinningStatus(series)

    assert.deepEqual({ status: status.status, passes: status.passes, dropped: status.dropped, last: status.last }, { status: 'untouched', passes: 0, dropped: 0, last: null })
    assert.equal(series.thinning.complete, true)
  })

  check('status', 'a series from before the record says its thinning is unknown, never none and never complete, and is written back unchanged in shape', () => {
    const legacy = { gameName: 'Game', races: { 7: { raceName: 'Terran', npr: false, snapshots: rowsAt([100, 200, 300]) } } }
    const status = history.thinningStatus(legacy.races[7])

    assert.equal(status.status, 'unknown')
    assert.equal(status.passes, null)
    assert.equal(status.dropped, null)
    assert.equal(status.last, null)
    assert.match(history.thinningText(status, String), /^Thinning unknown/)

    const after = recorded([400], { file: legacy })

    assert.deepEqual(Object.keys(seriesOf(after)), ['raceName', 'npr', 'snapshots'], 'no thinning record is made up')
    assert.equal(history.thinningStatus(seriesOf(after)).status, 'unknown')
    assert.equal(history.thinningStatus(undefined).status, 'unknown')
    assert.equal(history.thinningStatus({ snapshots: [] }).passes, null)
  })

  check('status', 'thinning is counted and dated: the passes and samples add up over saves, and the latest says when, at which game time and under which cap', () => {
    clock = 7000000

    const file = recorded(Array.from({ length: 12 }, (_, index) => 100 + index), { limit: 5 })
    const series = seriesOf(file)
    const status = history.thinningStatus(series)

    assert.equal(status.status, 'thinned')
    assert.ok(status.passes >= 2, `passes ${status.passes}`)
    assert.equal(status.dropped, 12 - series.snapshots.length)
    assert.equal(status.last.cap, 5)
    assert.equal(status.last.t, 111, 'the game time of the latest sample when it was thinned')
    assert.ok(status.last.at > 7000000 && Number.isInteger(status.last.at), 'the wall-clock time comes from the recorder\'s clock')
    assert.ok(status.last.passes >= 1 && status.last.dropped >= status.last.passes)
    assert.ok(status.last.passes <= status.passes && status.last.dropped <= status.dropped)
    assert.match(history.thinningText(status, (t) => `game ${t}`), /^Older half thinned \d+ times, dropping \d+ samples; latest thinning at game 111 \(saved \d{4}-\d\d-\d\d, cap 5\)$/)

    const later = history.thinningStatus(seriesOf(recorded([300], { file, limit: 100 })))

    assert.equal(later.status, 'thinned')
    assert.equal(later.passes, status.passes, 'a save that thins nothing adds nothing')
    assert.deepEqual(later.last, status.last, 'and the latest thinning is still the one that was')
  })

  check('status', 'a series from before the record that is thinned now is a lower bound, "at least", not a count', () => {
    const legacy = { gameName: 'Game', races: { 7: { raceName: 'Terran', npr: false, snapshots: rowsAt([1, 2, 3, 4, 5, 6]) } } }
    const series = seriesOf(recorded([7], { file: legacy, limit: 5 }))
    const status = history.thinningStatus(series)

    assert.equal(status.status, 'partial')
    assert.ok(status.passes >= 1 && status.dropped >= 1)
    assert.equal(series.thinning.complete, false)
    assert.match(history.thinningText(status, String), /^Older half thinned at least \d+ times?, dropping at least \d+ samples?; the series was also written by something other than the recorder/)
  })

  check('status', 'a series something else rewrote since is a lower bound: a thinned one is partial, an untouched one unknown, and the next save does not make either complete', () => {
    const thinned = seriesOf(recorded(Array.from({ length: 12 }, (_, index) => 100 + index), { limit: 5 }))
    const untouched = seriesOf(recorded([100, 200, 300]))
    const plus = (series) => ({ ...series, snapshots: [...series.snapshots, row(9000)] })

    assert.equal(history.thinningStatus(thinned).status, 'thinned')
    assert.equal(history.thinningStatus(untouched).status, 'untouched')

    const rewrittenThinned = history.thinningStatus(plus(thinned))
    const rewrittenUntouched = history.thinningStatus(plus(untouched))

    assert.equal(rewrittenThinned.status, 'partial')
    assert.equal(rewrittenThinned.passes, history.thinningStatus(thinned).passes, 'the counts known stay as the floor')
    assert.equal(rewrittenUntouched.status, 'unknown')
    assert.equal(rewrittenUntouched.passes, null)
    assert.equal(history.thinningStatus({ ...untouched, snapshots: untouched.snapshots.slice(1) }).status, 'unknown', 'a sample that is gone is not an untouched series')

    const next = seriesOf(recorded([9100], { file: { races: { 7: plus(untouched) } } }))

    assert.equal(history.thinningStatus(next).status, 'unknown', 'a save over a rewritten series does not make it complete')

    const nextThinned = seriesOf(recorded([9100], { file: { races: { 7: plus(thinned) } }, limit: 5 }))

    assert.equal(history.thinningStatus(nextThinned).status, 'partial')
    assert.ok(history.thinningStatus(nextThinned).passes >= history.thinningStatus(thinned).passes)
  })

  check('status', 'a thinning record that is not valid is not believed, whatever it claims', () => {
    const good = seriesOf(recorded(Array.from({ length: 12 }, (_, index) => 100 + index), { limit: 5 })).thinning
    const mutate = (change) => {
      const copy = clone(good)

      change(copy)

      return copy
    }
    const invalid = [
      null,
      'thinned',
      [],
      mutate((value) => { value.extra = 1 }),
      mutate((value) => { value.complete = 'yes' }),
      mutate((value) => { value.passes = -1 }),
      mutate((value) => { value.passes = 1.5 }),
      mutate((value) => { value.dropped = value.passes - 1 }),
      mutate((value) => { value.witness = 7 }),
      mutate((value) => { value.witness = '' }),
      mutate((value) => { value.last = null }),
      mutate((value) => { value.last.cap = 0 }),
      mutate((value) => { value.last.at = 'now' }),
      mutate((value) => { value.last.at = 1e20 }),
      mutate((value) => { value.last.at = -1e20 }),
      mutate((value) => { value.last.at = 8640000000000001 }),
      mutate((value) => { value.last.at = Infinity }),
      mutate((value) => { value.last.at = true }),
      mutate((value) => { value.last.at = '2050-01-01' }),
      mutate((value) => { value.last.passes = value.passes + 1 }),
      mutate((value) => { value.last.dropped = value.dropped + 1 }),
      mutate((value) => { value.last.extra = 1 }),
      mutate((value) => { value.passes = 0; value.dropped = 0 }),
    ]

    const atNull = mutate((value) => { value.last.at = null })
    const atEdge = mutate((value) => { value.last.at = 8640000000000000 })

    assert.deepEqual(campaign.readThinning(good), good, 'a record the recorder wrote reads back as it is')
    assert.deepEqual(campaign.readThinning(atNull), atNull, 'a thinning a merge made has no wall-clock time')
    assert.deepEqual(campaign.readThinning(atEdge), atEdge, 'the latest time a calendar date holds')
    invalid.forEach((value, index) => {
      assert.equal(campaign.readThinning(value), null, `case ${index}`)
      assert.equal(history.thinningStatus({ snapshots: [], thinning: value }).status, 'unknown', `case ${index}`)
      assert.doesNotThrow(() => history.retentionNote({ snapshots: rowsAt([1, 2]), thinning: value }, String), `case ${index}: a readout of a stored record that is not valid`)
    })
    assert.doesNotThrow(() => history.thinningText(history.thinningStatus({ snapshots: [], thinning: atEdge }), String))
  })

  check('status', 'what a viewing race knows of another race carries the thinning record as a race does', () => {
    const file = intelRecorded(Array.from({ length: 9 }, (_, index) => 10 + index), { limit: 4 })
    const series = file.intel[7][9]
    const status = history.thinningStatus(series)

    assert.ok(series.snapshots.length <= 4)
    assert.equal(status.status, 'thinned')
    assert.equal(status.dropped, 9 - series.snapshots.length)
    assert.equal(series.snapshots[series.snapshots.length - 1].t, 18)
    assert.equal(history.thinningStatus(intelRecorded([10, 11]).intel[7][9]).status, 'untouched')

    const legacy = { intel: { 7: { 9: { name: 'Alien', snapshots: [intelRow(1), intelRow(2)] } } } }

    assert.equal(history.thinningStatus(intelRecorded([3], { file: legacy }).intel[7][9]).status, 'unknown')
  })

  // ---- figures ----

  check('figures', 'the largest and the typical gap are worked out in game seconds, the typical being the median', () => {
    const even = history.retentionStats(rowsAt([0, 10, 30, 60, 160]))
    const odd = history.retentionStats(rowsAt([0, 10, 30, 60]))

    assert.deepEqual(even, { count: 5, first: 0, last: 160, seconds: 160, gaps: { count: 4, largest: 100, typical: 25 } })
    assert.deepEqual(odd.gaps, { count: 3, largest: 30, typical: 20 })
  })

  check('figures', 'no gap is known from fewer than two samples: null, not 0', () => {
    const none = history.retentionStats([])
    const one = history.retentionStats(rowsAt([50]))

    assert.deepEqual(none, { count: 0, first: null, last: null, seconds: null, gaps: { count: 0, largest: null, typical: null } })
    assert.deepEqual(one, { count: 1, first: 50, last: 50, seconds: null, gaps: { count: 0, largest: null, typical: null } })
  })

  check('figures', 'a span and a size read with their unit, a real 0 as 0 and what is not known as a dash', () => {
    assert.equal(history.durationText(null), '—')
    assert.equal(history.durationText(undefined), '—')
    assert.equal(history.durationText(0), '0 s')
    assert.equal(history.durationText(90), '1.5 min')
    assert.equal(history.durationText(5400), '1.5 h')
    assert.equal(history.durationText(5 * DAY), '5 d')
    assert.equal(history.durationText(2.5 * YEAR), '2.5 y')
    assert.equal(history.bytesText(null), '—')
    assert.equal(history.bytesText(0), '0 B')
    assert.equal(history.bytesText(2048), '2 KiB')
    assert.equal(history.bytesText(1572864), '1.5 MiB')
  })

  check('figures', 'the sampling line states the count and the gaps, and one sample has no gap rather than a gap of 0', () => {
    assert.equal(history.samplingText(history.retentionStats(rowsAt([0, 10, 30, 60, 160]))), '5 samples; gaps up to 1.7 min (typical 25 s)')
    assert.equal(history.samplingText(history.retentionStats(rowsAt([4]))), '1 sample; gaps unknown')
    assert.equal(history.samplingText(history.retentionStats([])), 'No samples')
    assert.equal(history.samplingText(history.retentionStats(rowsAt([0, 3 * YEAR]))), '2 samples; gaps up to 3 y (typical 3 y)')
  })

  check('figures', 'the note an export or a chart advertises gives the sampling and the thinning together', () => {
    const legacy = { raceName: 'Terran', snapshots: rowsAt([0, 10, 30]) }
    const untouched = seriesOf(recorded([0, 10, 30]))
    const thinned = seriesOf(recorded(Array.from({ length: 12 }, (_, index) => index * 10), { limit: 5 }))

    assert.match(history.retentionNote(legacy, String), /^3 samples; gaps up to 20 s \(typical 15 s\)\. Thinning unknown/)
    assert.equal(history.retentionNote(untouched, String), '3 samples; gaps up to 20 s (typical 15 s). Never thinned.')
    assert.match(history.retentionNote(thinned, (t) => `game ${t}`), /^\d+ samples; gaps up to .* \(typical .*\)\. Older half thinned \d+ times, dropping \d+ samples; latest thinning at game 110/)
    assert.equal(history.retentionNote(null, String), 'No samples. Thinning unknown: this history was recorded or merged without its thinning being noted, so its older half may have been thinned and it is not assumed complete.')
  })

  check('figures', 'measured bytes are the bytes of the series as stored (compact JSON, UTF-8), and none is a dash, not 0', () => {
    const series = { raceName: 'Étoile', npr: false, snapshots: rowsAt([1, 2, 3]) }

    assert.equal(history.measuredBytes(series), bytesOf(series))
    assert.ok(history.measuredBytes(series) > JSON.stringify(series).length, 'a letter that takes two bytes is counted as two')
    assert.equal(history.measuredBytes(null), null)
    assert.equal(history.measuredBytes(undefined), null)
  })

  check('figures', 'a prediction for a profile is the thinned rows\' bytes now and an average per sample at its cap, never the measured size, and a profile that thins nothing predicts the measured size', () => {
    const series = { raceName: 'Terran', npr: false, snapshots: irregular(1200) }
    const compact = history.predictRetention(series, history.retentionProfile('compact'))
    const standard = history.predictRetention(series, history.retentionProfile('standard'))
    const kept = history.thinCounted(series.snapshots, 500)

    assert.equal(compact.cap, 500)
    assert.equal(compact.thins, true)
    assert.equal(compact.kept, kept.snapshots.length)
    assert.equal(compact.dropped, 1200 - kept.snapshots.length)
    assert.equal(compact.passes, kept.passes)
    assert.equal(compact.largestGap, history.retentionStats(kept.snapshots).gaps.largest)
    assert.equal(compact.bytes, bytesOf({ ...series, snapshots: kept.snapshots }))
    assert.ok(compact.bytes < history.measuredBytes(series))
    assert.equal(compact.bytesAtCap, Math.round((bytesOf(series.snapshots) / 1200) * 500))
    assert.equal(standard.thins, false)
    assert.equal(standard.kept, 1200)
    assert.equal(standard.dropped, 0)
    assert.equal(standard.bytes, history.measuredBytes(series))
    assert.equal(standard.bytesAtCap, Math.round((bytesOf(series.snapshots) / 1200) * 2000))
  })

  check('figures', 'nothing is predicted for a series with no samples: everything null, not 0', () => {
    const empty = history.predictRetention({ raceName: 'Terran', snapshots: [] }, history.retentionProfile('compact'))
    const absent = history.predictRetention(null, history.retentionProfile('standard'))

    assert.deepEqual(empty, { cap: 500, thins: null, kept: null, dropped: null, passes: null, largestGap: null, bytes: null, bytesAtCap: null })
    assert.deepEqual(absent, { cap: 2000, thins: null, kept: null, dropped: null, passes: null, largestGap: null, bytes: null, bytesAtCap: null })
  })

  check('figures', 'a branch is counted against a cap by its series, races and aliens alike, and by what the next save would do', () => {
    const file = { races: { 1: { snapshots: irregular(700) }, 2: { snapshots: irregular(10) }, 3: {} }, intel: { 1: { 2: { snapshots: irregular(800) } } } }
    const held = history.seriesOverCap(file, 500)

    assert.equal(held.series, 3)
    assert.equal(held.over, 2)
    assert.equal(held.dropped, history.thinCounted(irregular(700), 500).dropped + history.thinCounted(irregular(800), 500).dropped)
    assert.equal(held.next.thins, 2)
    assert.ok(held.next.dropped >= held.dropped)
    assert.deepEqual(history.seriesOverCap(file, 2000), { series: 3, over: 0, dropped: 0, next: { thins: 0, dropped: 1, replaced: 1 } }, 'only the alien series can lose a sample, one that an unchanged observation removes')
    assert.deepEqual(history.seriesOverCap(null, 500), { series: 0, over: 0, dropped: 0, next: { thins: 0, dropped: 0, replaced: 0 } })
  })

  check('figures', 'the next save is counted as the recorder makes it: the new sample goes in before the thinning, so a series at a pass boundary loses more than thinning its stored rows would, and one at the cap is thinned though it is not over it', () => {
    // The stored samples one recorded save discards from a race series of `stored` samples under `cap`, by the recorder itself.
    const discarded = (stored, cap) => {
      const file = { races: { 7: { raceName: 'Terran', npr: false, snapshots: stored } } }
      const out = history.mergeGame(file, { gameName: 'Game', races: [{ RaceID: 7, raceName: 'Terran', npr: false, snapshot: row(stored[stored.length - 1].t + 1) }] }, { limit: cap, now })

      return stored.length + 1 - out.races[7].snapshots.length
    }
    const held = (stored, cap) => history.seriesOverCap({ races: { 7: { snapshots: stored } } }, cap)

    ;[[666, 500], [667, 500], [700, 500], [500, 500], [499, 500], [300, 500], [1500, 500], [1000, 1000]].forEach(([count, cap]) => {
      const rows = irregular(count)

      assert.equal(held(rows, cap).next.dropped, discarded(rows, cap), `${count} under ${cap}`)
      assert.equal(held(rows, cap).next.thins, discarded(rows, cap) > 0 ? 1 : 0, `${count} under ${cap}`)
    })
    assert.equal(discarded(irregular(666), 500), 291, 'worked by hand: 667 samples, two passes, 376 left')
    assert.equal(held(irregular(666), 500).dropped, 166, 'thinning the 666 stored rows alone drops 166')
    assert.equal(held(irregular(666), 500).next.dropped, 291)
    assert.deepEqual([held(irregular(500), 500).over, held(irregular(500), 500).dropped, held(irregular(500), 500).next.thins], [0, 0, 1], 'a series at the cap is not over it, and the next save thins it')
    assert.deepEqual(held(irregular(300), 500).next, { thins: 0, dropped: 0, replaced: 0 })
  })

  check('figures', 'the most a next save discards from an alien series is counted by every way an observation can arrive: one that matches the sample before it removes the sample stored at its time before the thinning runs, which can be one more than any thinning, and a series that holds a sample is not counted as thinned for that alone', () => {
    const alien = (count) => Array.from({ length: count }, (_, index) => intelRow(10 + index))
    // The stored samples the recorder discards from an alien series of `stored` samples under `cap` for one observation; `gain` is 1 when the observation is kept as a new sample.
    const discarded = (stored, cap, snapshot, gain) => {
      const file = { intel: { 7: { 9: { name: 'Alien', snapshots: stored } } } }
      const out = history.mergeGame(file, { gameName: 'Game', races: [], intel: { 7: [{ AlienRaceID: 9, name: 'Alien', snapshot }] } }, { limit: cap, now })

      return stored.length + gain - out.intel[7][9].snapshots.length
    }
    const ways = (stored, cap) => {
      const last = stored[stored.length - 1]
      const middle = Math.floor(stored.length / 2)

      return {
        later: discarded(stored, cap, intelRow(last.t + 1), 1),
        unchanged: discarded(stored, cap, { t: last.t + 1, contact: last.contact, comm: last.comm }, 0),
        replaced: discarded(stored, cap, { ...last, contact: last.contact + 1 }, 0),
        matchesLast: discarded(stored, cap, { t: last.t, contact: stored[stored.length - 2].contact, comm: 2 }, 0),
        matchesMiddle: discarded(stored, cap, { t: stored[middle].t, contact: stored[middle - 1].contact, comm: 2 }, 0),
      }
    }

    ;[[2, 500], [300, 500], [499, 500], [500, 500], [502, 500], [666, 500], [1000, 500], [1500, 1000], [2000, 2000]].forEach(([count, cap]) => {
      const stored = alien(count)
      const got = ways(stored, cap)
      const thinned = Math.max(got.later, got.unchanged, got.replaced)
      const held = history.seriesOverCap({ intel: { 7: { 9: { snapshots: stored } } } }, cap)

      assert.equal(held.next.dropped, Math.max(...Object.values(got)), `${count} under ${cap}: the most any way discards, ${JSON.stringify(got)}`)
      assert.equal(held.next.thins, thinned > 0 ? 1 : 0, `${count} under ${cap}: thinned by thinning only`)
      assert.equal(held.next.replaced, held.next.dropped - thinned, `${count} under ${cap}: what the replacement adds`)
    })

    const boundary = ways(alien(502), 500)

    assert.deepEqual([boundary.later, boundary.unchanged, boundary.matchesLast, boundary.matchesMiddle], [125, 125, 126, 126], '502 stored: 125 thinned, and 126 when the latest sample is removed first')
    assert.deepEqual(history.seriesOverCap({ intel: { 7: { 9: { snapshots: alien(502) } } } }, 500).next, { thins: 1, dropped: 126, replaced: 1 })

    // Two alien series, 502 and 500 samples: a save can remove a matching sample from each, and the figure still bounds every way each series can go (the 500 one discards most by taking a new sample, 125), so the allowance is 1, not the 2 samples a save can remove.
    const pair = { intel: { 7: { 9: { snapshots: alien(502) }, 10: { snapshots: alien(500) } } } }
    const worst = (count) => Math.max(...Object.values(ways(alien(count), 500)))
    const both = history.seriesOverCap(pair, 500)

    assert.deepEqual([worst(502), worst(500)], [126, 125])
    assert.deepEqual(both, { series: 2, over: 1, dropped: 125, next: { thins: 2, dropped: worst(502) + worst(500), replaced: 1 } })
    assert.equal(both.next.dropped, 251)
    assert.equal(discarded(alien(500), 500, { t: 509, contact: 508, comm: 2 }, 0) + discarded(alien(502), 500, { t: 511, contact: 510, comm: 2 }, 0), 127, 'a save removing a matching sample from each of the two discards 1 and 126, two removals in all, within the figure')
  })

  check('figures', 'the CSV columns for sparse sampling give the seconds since the previous row, empty for the first and for an unknown time, and the note once', () => {
    const columns = history.sparseColumns([row(100), row(160), { ...row(1), t: undefined }, row(500)], 'the note')

    assert.deepEqual(columns.header, ['Gap since previous row (s)', 'Retention'])
    assert.deepEqual(columns.rows, [[null, 'the note'], [60, null], [null, null], [null, null]])
    assert.deepEqual(history.sparseColumns([], 'n').rows, [])
  })

  check('thinning', 'an alien series whose intelligence has not changed is still thinned to the cap at a save, and no sample is added for it', () => {
    const base = intelRecorded(Array.from({ length: 900 }, (_, index) => 10 + index))
    const contact = base.intel[7][9].snapshots[899].contact
    let file = base

    for (let index = 0; index < 10; index++) {
      file = history.mergeGame(file, { gameName: 'Game', races: [], intel: { 7: [{ AlienRaceID: 9, name: 'Alien', snapshot: { t: 5000 + index, contact, comm: 2 } }] } }, { limit: 500, now })
    }

    const series = file.intel[7][9]
    const status = history.thinningStatus(series)

    assert.equal(base.intel[7][9].snapshots.length, 900)
    assert.ok(series.snapshots.length <= 500, `${series.snapshots.length} kept under a cap of 500`)
    assert.ok(series.snapshots.every((snapshot) => snapshot.t < 5000), 'no sample was added for unchanged intelligence')
    assert.equal(status.status, 'thinned')
    assert.equal(status.dropped, 900 - series.snapshots.length)
  })

  // ---- merges ----

  check('status', 'a merge that thins the union to exactly the game times one series held still says what it lost: the times left never prove nothing was lost', () => {
    const first = seriesOf(recorded(FIRST_TIMES))
    const second = seriesOf(recorded(SECOND_TIMES))
    const outcome = united(history, first.snapshots, second.snapshots)
    const merged = { snapshots: outcome.snapshots, thinning: history.thinningOfMerge([first, second], outcome) }
    const status = history.thinningStatus(merged)

    assert.deepEqual(timesOf(outcome.snapshots), FIRST_TIMES, 'the union is thinned back to the first series\' times')
    assert.equal(history.thinningStatus(first).status, 'untouched')
    assert.equal(history.thinningStatus({ snapshots: outcome.snapshots, thinning: first.thinning }).status, 'untouched', 'the first series\' own record would read as never thinned over these times')
    assert.deepEqual([status.status, status.passes, status.dropped], ['thinned', 1, 500])
    assert.equal(status.last.t, 2000)
    assert.equal(status.last.at, null, 'a merge is dated by game time, so planning it twice gives the same record')
    assert.match(history.thinningText(status, String), /^Older half thinned 1 time, dropping 500 samples; latest thinning at 2000 \(made by a merge, cap 2000\)$/)
    assert.deepEqual(campaign.readThinning(merged.thinning), merged.thinning, 'the record is one a file may hold')
    assert.deepEqual(history.thinningOfMerge([first, second], outcome), merged.thinning)
  })

  check('status', 'a merge of series: complete series that were never thinned stay complete, a series with no record makes it unknown, thinned ones give a floor, and one that adds nothing leaves the record as it was', () => {
    const first = seriesOf(recorded([1, 2, 3]))
    const second = seriesOf(recorded([4, 5]))
    const thinned = seriesOf(recorded(range(1, 12), { limit: 5 }))
    const merge = (records, a, b) => {
      const outcome = united(history, a, b)

      return { outcome, merged: { snapshots: outcome.snapshots, thinning: history.thinningOfMerge(records, outcome) } }
    }
    const status = (merged) => history.thinningStatus(merged)

    const plain = merge([first, second], first.snapshots, second.snapshots).merged

    assert.deepEqual([status(plain).status, plain.snapshots.length], ['untouched', 5])
    assert.equal(status(merge([first, undefined], first.snapshots, []).merged).status, 'untouched', 'a side with no series says nothing against it')

    const legacy = { raceName: 'Old', snapshots: second.snapshots }
    const withLegacy = merge([first, legacy], first.snapshots, legacy.snapshots).merged

    assert.equal(status(withLegacy).status, 'unknown')
    assert.equal(status(withLegacy).passes, null)
    assert.equal('thinning' in withLegacy && withLegacy.thinning !== undefined, false)

    const floor = merge([thinned, second], thinned.snapshots, second.snapshots).merged

    assert.equal(status(floor).status, 'partial')
    assert.deepEqual([status(floor).passes, status(floor).dropped], [status(thinned).passes, status(thinned).dropped])

    const big = { raceName: 'Big', snapshots: irregular(2100, 3).map((snapshot) => ({ ...snapshot, t: snapshot.t + 1000000 })) }
    const heavy = merge([thinned, big], thinned.snapshots, big.snapshots)

    assert.ok(heavy.outcome.passes >= 1 && heavy.outcome.dropped > 0)
    assert.equal(status(heavy.merged).status, 'partial')
    assert.ok(status(heavy.merged).dropped >= heavy.outcome.dropped && status(heavy.merged).passes >= status(thinned).passes, 'the merge\'s own thinning is counted with the series\'')
    assert.equal(status(heavy.merged).last.at, null)
    assert.match(history.thinningText(status(heavy.merged), String), /made by a merge/)

    const same = merge([thinned, thinned], thinned.snapshots, thinned.snapshots).merged

    assert.deepEqual(status(same), status(thinned), 'a series merged with itself keeps its record')
    assert.deepEqual(same.thinning, thinned.thinning)
  })

  check('status', 'a merge never leaves a series more known than its least known source: a series with no record keeps the result unknown whichever side it is on and however the rows compare, a thinned record stands only where nothing else could have lost samples, and otherwise it is a floor', () => {
    const original = seriesOf(recorded(range(1, 2001)))
    const times = timesOf(original.snapshots)
    const legacy = { raceName: original.raceName, npr: false, snapshots: original.snapshots }
    const fresh = seriesOf(recorded(times))
    const superset = seriesOf(recorded([...times, ...range(3000, 3100)]))
    const merge = (first, second) => {
      const outcome = united(history, first.snapshots, second.snapshots)

      return { snapshots: outcome.snapshots, thinning: history.thinningOfMerge([first, second], outcome) }
    }
    const status = (merged) => history.thinningStatus(merged)

    assert.deepEqual([times.length, status(original).status, status(original).dropped, status(fresh).status], [1501, 'thinned', 500, 'untouched'], 'the original thins 2001 observations to 1501, and a copy of exactly those 1501 observations is recorded never thinned')
    ;[['no record stored, the same rows offered', legacy, fresh], ['the same rows stored, no record offered', fresh, legacy], ['no record stored, a superset offered', legacy, superset], ['a superset stored, no record offered', superset, legacy]].forEach(([name, first, second]) => {
      const merged = merge(first, second)

      assert.equal(status(merged).status, 'unknown', name)
      assert.equal(status(merged).passes, null, name)
      assert.equal(merged.thinning, undefined, name)
    })

    const kept = merge(original, fresh)
    const offered = merge(fresh, original)

    ;[kept, offered].forEach((merged) => assert.deepEqual([status(merged).status, status(merged).passes, status(merged).dropped], ['thinned', 1, 500], 'the thinned record stands when the other side is complete and never thinned'))

    const floor = merge(original, legacy)

    assert.deepEqual([status(floor).status, status(floor).passes, status(floor).dropped], ['partial', 1, 500], 'the thinned record is a floor when the other side may have lost samples this one never had')
    assert.equal(status(merge(original, original)).status, 'thinned', 'the very same record on both sides stands')

    // A record that carries the game times of rows it no longer has (written by something that changed the rows) never vouches for another series, whatever the two records say.
    const earlier = seriesOf(recorded(range(1, 400)))
    const stale = { ...earlier, snapshots: earlier.snapshots.slice(100) }
    const thinnedEarlier = seriesOf(recorded(range(1, 12), { limit: 5 }))
    const thinnedStale = { ...thinnedEarlier, snapshots: thinnedEarlier.snapshots.slice(1) }

    assert.deepEqual([history.thinningStatus(stale).status, stale.snapshots.length, history.thinningStatus(earlier).status], ['unknown', 300, 'untouched'], 'the stale series reads as unknown, the original as never thinned')
    ;[['a stale record stored, its original offered', stale, earlier], ['an original stored, a stale copy of its record offered', earlier, stale]].forEach(([name, first, second]) => {
      const merged = merge(first, second)

      assert.equal(merged.snapshots.length, 400, name)
      assert.equal(status(merged).status, 'unknown', name)
      assert.equal(merged.thinning, undefined, name)
    })
    ;[['a stale record stored, a thinned original offered', thinnedStale, thinnedEarlier], ['a thinned original stored, a stale copy offered', thinnedEarlier, thinnedStale]].forEach(([name, first, second]) => {
      const merged = merge(first, second)

      assert.deepEqual(timesOf(merged.snapshots), timesOf(thinnedEarlier.snapshots), name)
      assert.deepEqual([status(merged).status, status(merged).passes, status(merged).dropped], ['partial', status(thinnedEarlier).passes, status(thinnedEarlier).dropped], name)
    })

    const settled = merge(original, legacy)

    assert.deepEqual(status(merge(settled, settled)), status(settled), 'an intact floor merged with itself keeps its record')
    assert.equal(status(merge(settled, settled)).status, 'partial')
  })

  return checks
}

// ---------- the recorder, over recorded saves ----------

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// An installation: each store a JSON value read and written whole, as electron-store's `.store` is.
const installation = ({ first = 1 } = {}) => {
  const files = new Map()
  const writes = []
  const put = (name, value) => files.set(name, clone(value))
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      put(name, value)
      writes.push(name)
    },
    update (change) {
      this.store = change(this.store)

      return this.store
    },
  })
  let counter = first * 1000
  let clock = 1000000 * first

  return {
    files,
    writes,
    put,
    newId: () => `c${++counter}`,
    now: () => ++clock,
    io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), backup: store('backup'), file: (name) => store(`file:${name}`) },
    registry: () => ({ campaigns: {}, pool: {}, ...(clone(files.get('registry')) || {}) }),
    fileOf: (campaignId, branchId = 'b1') => clone(files.get(`file:campaign-${campaignId}-${branchId}`)) || {},
  }
}

// The first saves of the passive campaign, opened read only: `record(installation, picks)` records them with the recorder, `checksums()` is the sha256 of each file now. Null when the folder is not here.
const realSaves = async (m, count) => {
  if (!fs.existsSync(path.join(PASSIVE, 'snapshots.csv'))) {
    return null
  }

  const sqlite3 = require('sqlite3')
  const rows = fs.readFileSync(path.join(PASSIVE, 'snapshots.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((line) => {
    const [index, , file, hash] = line.split(',')

    return { index: Number(index), file, sha256: hash }
  }).slice(0, count)

  assert.ok(rows.length === count && rows.every((entry) => fs.existsSync(path.join(PASSIVE, 'snapshots', entry.file))), 'a save of the passive campaign is missing')

  const handles = new Map()

  for (const entry of rows) {
    handles.set(entry.file, await new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(path.join(PASSIVE, 'snapshots', entry.file), sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(handle)))
    }))
  }

  const database = (entry) => ({
    transaction: (work) => work({ id: 'transaction' }),
    query: (sql) => new Promise((resolve, reject) => handles.get(entry.file).all(sql, (error, result) => (error ? reject(error) : resolve([result])))),
  })

  return {
    saves: rows,
    expected: Object.fromEntries(rows.map((entry) => [entry.file, entry.sha256])),
    checksums: () => Object.fromEntries(rows.map((entry) => [entry.file, sha256(path.join(PASSIVE, 'snapshots', entry.file))])),
    record: async (inst, entry) => {
      const run = await m.history.recordHistory(database(entry), { storage: inst.io, path: `C:/saves/${entry.file}`, now: inst.now, newId: inst.newId })

      assert.equal(run.failed.length, 0, run.failed.map((failure) => failure.error && failure.error.message).join('; '))
    },
    close: () => handles.forEach((handle) => handle.close()),
  }
}

const recorderSuite = (m) => {
  const { history } = m
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })

  // The recorder over `count` saves: the first is recorded, then every series of its branch file is replaced by `seeded` samples of its own before the later saves (a history from before the thinning record, long enough to be above a cap).
  const withSeeded = async (seeded, work) => {
    const real = await realSaves(m, 4)

    if (!real) {
      console.log('  skip   the passive campaign is not here')

      return
    }

    try {
      const inst = installation()

      await real.record(inst, real.saves[0])

      const [id] = Object.keys(inst.registry().campaigns)
      const name = `file:campaign-${id}-b1`
      const file = inst.fileOf(id)

      Object.values(file.races).forEach((series) => {
        const template = series.snapshots[0]

        series.snapshots = [...Array.from({ length: seeded }, (_, index) => ({ ...template, t: (index + 1) * 100 })), ...series.snapshots]
        delete series.thinning
      })
      inst.put(name, file)

      await work({ inst, real, id, name })
      assert.deepEqual(real.checksums(), real.expected, 'a save was changed')
    } finally {
      real.close()
    }
  }

  check('recorder', 'the profile in the settings is the cap at the next save: a series above it is thinned, the save just taken is its latest sample, the thinning is recorded and the saves are not changed', async () => {
    await withSeeded(700, async ({ inst, real, id }) => {
      inst.put('settings', { ...(inst.files.get('settings') || {}), historyRetention: 'compact' })

      await real.record(inst, real.saves[1])

      const series = Object.values(inst.fileOf(id).races)

      assert.ok(series.length >= 2)
      series.forEach((entry) => {
        const status = history.thinningStatus(entry)

        assert.ok(entry.snapshots.length <= 500, `${entry.raceName}: ${entry.snapshots.length}`)
        assert.equal(entry.snapshots[0].t, 100, 'the first sample stays')
        assert.ok(strictlyIncreasing(entry.snapshots))
        assert.equal(status.status, 'partial', 'the series began before the record, so the count is a lower bound')
        assert.ok(status.passes >= 1)
        assert.equal(status.last.cap, 500)
        assert.ok(status.last.at > 1000000 && status.last.at < 2000000 && Number.isInteger(status.last.at), 'the wall-clock time comes from the installation\'s clock, not the game time')
      })

      const latest = Math.max(...series.map((entry) => entry.snapshots[entry.snapshots.length - 1].t))

      assert.ok(latest > 700 * 100, 'the save recorded last is the latest sample')
      assert.ok(series.every((entry) => entry.snapshots[entry.snapshots.length - 1].t === latest))
    })
  })

  check('recorder', 'with no profile stored the cap is Standard: a series of 700 samples is not thinned and its unknown thinning stays unknown', async () => {
    await withSeeded(700, async ({ inst, real, id }) => {
      await real.record(inst, real.saves[1])

      Object.values(inst.fileOf(id).races).forEach((entry) => {
        assert.equal(entry.snapshots.length, 702)
        assert.equal(history.thinningStatus(entry).status, 'unknown')
        assert.equal('thinning' in entry, false)
      })
    })
  })

  check('recorder', 'a larger profile applies to what is observed and kept from then on and does not bring thinned samples back', async () => {
    await withSeeded(700, async ({ inst, real, id }) => {
      inst.put('settings', { ...(inst.files.get('settings') || {}), historyRetention: 'compact' })
      await real.record(inst, real.saves[1])

      const thinned = inst.fileOf(id)
      const counts = Object.fromEntries(Object.entries(thinned.races).map(([RaceID, entry]) => [RaceID, entry.snapshots.length]))

      inst.put('settings', { ...(inst.files.get('settings') || {}), historyRetention: 'standard' })
      await real.record(inst, real.saves[2])

      Object.entries(inst.fileOf(id).races).forEach(([RaceID, entry]) => {
        assert.equal(entry.snapshots.length, counts[RaceID] + 1, `${RaceID}: one more sample and none that was thinned`)
        assert.equal(history.thinningStatus(entry).passes, history.thinningStatus(thinned.races[RaceID]).passes, 'no further thinning')
      })

      inst.put('settings', { ...(inst.files.get('settings') || {}), historyRetention: 'compact' })
      await real.record(inst, real.saves[3])

      Object.values(inst.fileOf(id).races).forEach((entry) => assert.ok(entry.snapshots.length <= 500))
    })
  })

  return checks
}

// ---------- the backup ----------

const backupSuite = (m) => {
  const { history, backup, campaign, attach } = m
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  let clock = 9000000
  const now = () => ++clock

  const anchorRows = (key, count = 10) => Array.from({ length: count }, (_, index) => [100 + index, index + 1, Number((1 + key / 100 + index / 1000).toFixed(4)), 1, 1, 1, 1])
  const ledger = (n) => Array.from({ length: n }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 5 }))
  const tipOf = (n) => {
    const scan = campaign.scanLedger(ledger(n))

    return { n: scan.count, t: n * 5, digest: scan.digest, checkpoints: scan.checkpoints, early: scan.early }
  }
  const entry = () => ({
    id: 'c1',
    provenance: { via: 'recorded' },
    createdAt: 100,
    seen: 200,
    names: [{ name: 'Campaign', t: 5, seen: 100 }],
    gameIds: [1],
    anchor: anchorRows(1),
    branchSeq: 1,
    branches: { b1: { id: 'b1', parent: null, fork: null, createdAt: 100, seen: 200, tip: tipOf(100) } },
    attachments: [],
    legacy: null,
  })
  const stored = (file) => {
    const inst = installation()

    inst.put('registry', { version: 1, campaigns: { c1: entry() }, pool: {} })
    inst.put('file:campaign-c1-b1', file)

    return inst
  }

  // A file recorded the way the recorder does: race 1 thinned (cap 5), race 2 untouched, race 3 from before the thinning record, and an alien race thinned.
  const recordedFile = () => {
    let file = {}

    for (let t = 100; t < 112; t++) {
      file = history.mergeGame(file, { gameName: 'Game', races: [{ RaceID: 1, raceName: 'Terran', npr: false, snapshot: row(t) }], intel: { 1: [{ AlienRaceID: 2, name: 'Alien', snapshot: intelRow(t) }] } }, { limit: 5, now })
    }

    file = history.mergeGame(file, { gameName: 'Game', races: [{ RaceID: 2, raceName: 'Rival', npr: true, snapshot: row(100) }, { RaceID: 2, raceName: 'Rival', npr: true, snapshot: row(200) }] }, { now })
    file.races[3] = { raceName: 'Old', npr: false, snapshots: rowsAt([100, 200, 300]) }

    return file
  }

  const parsed = (text) => {
    const out = backup.parseBackup(text)

    assert.equal(out.errors, undefined, out.errors && out.errors[0])

    return out.envelope
  }

  const exported = (inst) => JSON.stringify(backup.buildBackup(inst.io, { campaignIds: null, at: 9000, annotations: null }))

  const restore = async (inst, envelope, choices = {}) => {
    const planned = backup.planRestore({ io: inst.io, envelope, choices, annotations: null })

    return backup.applyRestore({ io: inst.io, envelope, choices, expected: planned.digest, confirmed: true, now: inst.now, annotations: null })
  }

  const sealed = (doc) => JSON.stringify({ ...doc, digest: campaign.hashValue(doc.campaigns) })

  const seriesList = (file) => [...Object.values(file.races || {}), ...Object.values(file.intel || {}).flatMap((aliens) => Object.values(aliens))]

  check('backup', 'a backup carries each series\' thinning record and a restore gives the file back exactly, each series with the thinning it had', async () => {
    const original = stored(recordedFile())
    const file = original.fileOf('c1')
    const envelope = parsed(exported(original))
    const copy = installation({ first: 2 })

    assert.ok(file.races[1].thinning && file.races[2].thinning && file.intel[1][2].thinning && !file.races[3].thinning)
    assert.equal(envelope.campaigns[0].branches.b1.races[1].thinning.passes, file.races[1].thinning.passes)

    await restore(copy, envelope)

    const restored = copy.fileOf('c1')

    assert.deepEqual(restored, file)
    assert.deepEqual(['thinned', 'untouched', 'unknown'], [1, 2, 3].map((race) => history.thinningStatus(restored.races[race]).status))
    assert.equal(history.thinningStatus(restored.intel[1][2]).status, 'thinned')
  })

  check('backup', 'a backup from before the thinning record is read as it was and restores with the thinning unknown, never complete', async () => {
    const original = stored(recordedFile())
    const doc = JSON.parse(exported(original))

    doc.campaigns.forEach((entryOf) => Object.values(entryOf.branches).forEach((file) => seriesList(file).forEach((series) => delete series.thinning)))

    const envelope = parsed(sealed(doc))
    const copy = installation({ first: 2 })

    await restore(copy, envelope)

    const restored = copy.fileOf('c1')

    assert.equal(seriesList(restored).length, 4)
    seriesList(restored).forEach((series) => {
      assert.equal('thinning' in series, false)
      assert.equal(history.thinningStatus(series).status, 'unknown')
      assert.equal(history.thinningStatus(series).passes, null)
    })
  })

  check('backup', 'a thinning record that is not valid makes the backup refused, with nothing read', () => {
    const original = stored(recordedFile())
    const doc = JSON.parse(exported(original))

    for (const change of [(thinning) => { thinning.passes = -1 }, (thinning) => { thinning.extra = true }, (thinning) => { thinning.witness = 12 }, (thinning) => { thinning.last = null }, (thinning) => { thinning.last.at = 1e20 }, (thinning) => { thinning.last.at = -1e20 }]) {
      const copy = clone(doc)

      change(copy.campaigns[0].branches.b1.races[1].thinning)

      const out = backup.parseBackup(sealed(copy))

      assert.equal(out.envelope, undefined)
      assert.match(out.errors[0], /its thinning record is not valid/)
    }

    const copy = clone(doc)

    copy.campaigns[0].branches.b1.races[2].thinning = 'none'

    assert.match(backup.parseBackup(sealed(copy)).errors[0], /its thinning record is not valid/)
  })

  check('backup', 'a merge that changes a series\' rows no longer claims the series is complete: a thinned one is a lower bound, an untouched one unknown', async () => {
    const original = stored(recordedFile())
    const before = original.fileOf('c1')
    const doc = JSON.parse(exported(original))
    const branch = doc.campaigns[0].branches.b1

    ;[1, 2].forEach((race) => {
      const series = branch.races[race]

      series.snapshots.push(row(9000))
      series.coverage = { count: series.snapshots.length, first: series.snapshots[0].t, last: 9000 }
    })

    const envelope = parsed(sealed(doc))

    await restore(original, envelope)

    const merged = original.fileOf('c1')

    assert.equal(merged.races[1].snapshots[merged.races[1].snapshots.length - 1].t, 9000)
    assert.equal(history.thinningStatus(merged.races[1]).status, 'partial')
    assert.equal(history.thinningStatus(merged.races[1]).passes, history.thinningStatus(before.races[1]).passes)
    assert.equal(history.thinningStatus(merged.races[2]).status, 'unknown')
    assert.equal(history.thinningStatus(merged.races[2]).passes, null)
    assert.equal(history.thinningStatus(merged.races[3]).status, 'unknown')
  })

  // A file with each of `times` recorded for race `race`, as the recorder does.
  const seriesFile = (times, race = 1) => times.reduce((file, t) => history.mergeGame(file, { gameName: 'Game', races: [{ RaceID: race, raceName: 'Terran', npr: false, snapshot: row(t) }] }, { now }), {})

  check('backup', 'a restore that merges a series and thins the union back to the game times the stored one held reports what it dropped, and planning the same restore twice gives the same plan', async () => {
    const holder = stored(seriesFile(FIRST_TIMES))
    const envelope = parsed(exported(stored(seriesFile(SECOND_TIMES))))
    const plan = () => backup.planRestore({ io: holder.io, envelope, choices: {}, annotations: null })

    assert.equal(history.thinningStatus(holder.fileOf('c1').races[1]).status, 'untouched')
    assert.equal(plan().digest, plan().digest, 'the merge is dated by game time, not by the clock')

    await restore(holder, envelope)

    const merged = holder.fileOf('c1').races[1]
    const status = history.thinningStatus(merged)

    assert.deepEqual(timesOf(merged.snapshots), FIRST_TIMES)
    assert.deepEqual([status.status, status.passes, status.dropped], ['thinned', 1, 500])
    assert.deepEqual(campaign.readThinning(merged.thinning), merged.thinning)
  })

  check('backup', 'an attachment that merges a series reconciles its thinning the same way: matching game times do not make it complete, a series with no record makes it unknown, and untouched series stay untouched', () => {
    const first = seriesFile(FIRST_TIMES).races[1]
    const second = seriesFile(SECOND_TIMES).races[1]
    const merged = attach.mergeHistories({ races: { 1: first } }, { races: { 1: second } }).history.races[1]
    const status = history.thinningStatus(merged)

    assert.deepEqual(timesOf(merged.snapshots), FIRST_TIMES)
    assert.deepEqual([status.status, status.passes, status.dropped], ['thinned', 1, 500])

    const small = attach.mergeHistories({ races: { 1: seriesFile([1, 2, 3]).races[1] } }, { races: { 1: seriesFile([4, 5]).races[1] } }).history.races[1]

    assert.deepEqual([history.thinningStatus(small).status, small.snapshots.length], ['untouched', 5])

    const legacy = attach.mergeHistories({ races: { 1: seriesFile([1, 2, 3]).races[1] } }, { races: { 1: { raceName: 'Old', npr: false, snapshots: rowsAt([4, 5]) } } }).history.races[1]

    assert.equal(history.thinningStatus(legacy).status, 'unknown')
    assert.equal('thinning' in legacy, false)
  })

  check('backup', 'a restore and an attachment never leave a series more known than the least known of its sources: a legacy series with the very rows a recorded, never thinned copy holds stays unknown, in both directions and with a superset offered or stored', async () => {
    const original = seriesFile(range(1, 2001))
    const times = timesOf(original.races[1].snapshots)
    const legacy = { gameName: 'Game', races: { 1: { raceName: 'Terran', npr: false, snapshots: original.races[1].snapshots } } }
    const fresh = seriesFile(times)
    const superset = seriesFile([...times, ...range(3000, 3100)])
    const intactFile = seriesFile(range(1, 400))
    const staleFile = { gameName: 'Game', races: { 1: { ...clone(intactFile.races[1]), snapshots: intactFile.races[1].snapshots.slice(100) } } }

    assert.equal(history.thinningStatus(original.races[1]).dropped, 500)
    assert.equal(history.thinningStatus(fresh.races[1]).status, 'untouched')
    assert.equal(history.thinningStatus(staleFile.races[1]).status, 'unknown', 'a record that carries the game times of 400 rows over 300 of them is stale')

    for (const [name, held, given] of [['the same rows', legacy, fresh], ['the same rows, the other way', fresh, legacy], ['a superset offered', legacy, superset], ['a superset stored', superset, legacy], ['a stale record beside its original', staleFile, intactFile], ['an original beside the stale copy of its record', intactFile, staleFile]]) {
      const holder = stored(clone(held))

      await restore(holder, parsed(exported(stored(clone(given)))))

      const restored = holder.fileOf('c1').races[1]
      const attached = attach.mergeHistories({ races: { 1: clone(held).races[1] } }, { races: { 1: clone(given).races[1] } }).history.races[1]

      assert.equal(history.thinningStatus(restored).status, 'unknown', `restore, ${name}`)
      assert.equal('thinning' in restored, false, `restore, ${name}`)
      assert.equal(history.thinningStatus(attached).status, 'unknown', `attach, ${name}`)
      assert.equal('thinning' in attached, false, `attach, ${name}`)
    }
  })

  return checks
}

// ---------- the page ----------

const PERSISTED_VIEW_SOURCE = fs.readFileSync(path.join(root, 'src', 'renderer', 'mixins', 'persisted-view.js'), 'utf8')

// A copy of the mixin for each load of the page: a data-URL module is shared by its text, so each load declares its views in a registry of its own and a fault loaded in one run never reaches the next.
let loads = 0

const persistedView = () => `${PERSISTED_VIEW_SOURCE}\nglobalThis.__declaredViews = declaredViews\n// load ${++loads}\n`

class MemoryConfig {
  constructor (entries = []) {
    this.values = new Map(entries)
  }

  get (key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set (key, value) {
    this.values.set(key, JSON.stringify(value))
  }

  has (key) {
    return this.values.has(key)
  }

  // A restart: the settings as the file holds them, read by another store.
  reopened () {
    return new MemoryConfig([...this.values])
  }
}

// The settings as the store nests them, for a page that reads `config.store` (the choice of what a race observes).
class ObservingConfig extends MemoryConfig {
  get store () {
    return nested(this)
  }
}

// The settings a page wrote, as the store nests them: a dotted key is a path.
const nested = (config) => {
  const store = {}

  for (const [key, text] of config.values) {
    const parts = key.split('.')
    let node = store

    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] || {}
      node = node[part]
    }

    node[parts[parts.length - 1]] = JSON.parse(text)
  }

  return store
}

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const textOf = (node) => (typeof node.text === 'string' ? node.text : (node.children || []).map(textOf).join(''))

const nodesOf = (node, test, found = []) => {
  if (test(node)) {
    found.push(node)
  }

  ;(node.children || []).forEach((child) => nodesOf(child, test, found))

  return found
}

const withAttr = (name, value) => (node) => Boolean(node.data && node.data.attrs && name in node.data.attrs && (value === undefined || node.data.attrs[name] === value))

// The CSV text as the header and its rows keyed by the header (a cell in quotes keeps its commas and doubled quotes).
const tableOf = (text) => {
  const rows = []
  let line = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index++) {
    const character = text[index]

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"'
        index++
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      line.push(cell)
      cell = ''
    } else if (character === '\n') {
      line.push(cell)
      rows.push(line)
      line = []
      cell = ''
    } else {
      cell += character
    }
  }

  line.push(cell)
  rows.push(line)

  const [header, ...rest] = rows

  return { header, rows: rest.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]]))) }
}

// The Retention panel as the app ships it: the page's script (as loaded by the page loader, with `mutate` applied) and the panel's template, compiled and rendered by Vue without a document, so the Vuetify elements stay plain nodes and what is read is their text and attributes. `change(text)` rewrites the panel's template first (a mutant).
const PANEL_START = '<v-card class="panel history-retention"'
const PANEL_END = '</v-card>\n\n      <v-card class="panel history-backup"'

const loadPanel = async ({ mutate = null, change = null } = {}) => {
  const options = await loadPage('pages/history', { stubs: STUBS, modules: { 'mixins/persisted-view': persistedView() }, mutate })
  const text = fs.readFileSync(pageFile, 'utf8').replace(/\r\n/g, '\n')
  const from = text.indexOf(PANEL_START)
  const to = text.indexOf(PANEL_END)

  if (from < 0 || to < from) {
    throw new Error('The Retention panel is not in the template of the page')
  }

  const fragment = text.slice(from, to + '</v-card>'.length)
  const compiled = compileTemplate({ source: `<div>${change ? change(fragment) : fragment}</div>`, filename: 'history.vue' })

  if (compiled.errors.length) {
    throw new Error(`The template does not compile: ${compiled.errors.join('; ')}`)
  }

  const { render, staticRenderFns } = nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)

  return { options, render, staticRenderFns, declared: globalThis.__declaredViews() }
}

const KEY = 'campaign.c1.race.7'

const pageSuite = async ({ history, observations }, variant = {}) => {
  const loaded = await loadPanel(variant)
  const { options, render, staticRenderFns, declared } = loaded
  const mounted = []
  const checks = []
  const check = (name, run) => checks.push([name, run])
  let clock = 8000000
  const now = () => ++clock

  const recorded = (times, limit) => times.reduce((file, t) => history.mergeGame(file, { gameName: 'Game', races: [{ RaceID: 7, raceName: 'Test Race', npr: false, snapshot: row(t) }] }, { limit, now }), {})

  const mount = ({ file, config = new MemoryConfig() }) => {
    const store = Vue.observable({ getters: { racePrefix: KEY, config, database: null, GameID: 1, RaceID: 7, StartYear: START_YEAR, historyRecorded: true, 'history/campaign': { campaignId: 'c1', branchId: 'b1', generation: 1 } }, state: { history: { revision: 0, failures: [] } } })
    const Component = Vue.extend({
      mixins: [options],
      data: () => ({ installationNames: {}, held: file }),
      computed: {
        gameHistory () {
          return this.held
        },
        theme: () => ({ categorical: [] }),
      },
      beforeCreate () {
        this.$store = store
      },
      render,
      staticRenderFns,
    })
    const vm = new Component()

    mounted.push(vm)

    return { vm, config, tree: () => vm._render() }
  }

  const settled = (statement) => async () => {
    try {
      return await statement()
    } finally {
      mounted.splice(0).forEach((vm) => vm.$destroy())
    }
  }

  const find = (tree, attribute, value) => nodesOf(tree, withAttr(attribute, value))[0]

  const days = (list) => list.map((day) => day * DAY)

  const legacyFile = { gameName: 'Game', races: { 7: { raceName: 'Test Race', npr: false, snapshots: rowsAt(days([0, 10, 30, 60, 160])) } } }

  const longFile = { gameName: 'Game', races: { 7: { raceName: 'Test Race', npr: false, snapshots: irregular(700) } } }

  const twoFile = { gameName: 'Game', races: { ...longFile.races, 8: { raceName: 'Rival', npr: true, snapshots: irregular(300, 11) } } }

  // The CSV the page's download button writes.
  const downloadOf = (vm, method = 'downloadCsv') => {
    const files = []
    const saved = { document: globalThis.document, Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    let text = null
    const link = { href: '', download: '', click () { files.push({ name: link.download, text }) } }

    globalThis.document = { createElement: () => link }
    globalThis.Blob = class { constructor (parts) { text = parts.join('') } }
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}

    try {
      vm[method]()
    } finally {
      globalThis.document = saved.document
      globalThis.Blob = saved.Blob
      URL.createObjectURL = saved.create
      URL.revokeObjectURL = saved.revoke
    }

    return { name: files[0].name, ...tableOf(files[0].text) }
  }

  check('page: the retention profile is a view declared for the app under historyRetention, Standard by default, and only a profile is valid', () => {
    const view = declared.filter((entry) => entry.key === 'historyRetention').pop()

    assert.ok(view, 'declared')
    assert.equal(view.scope, 'app')
    assert.equal(view.default, 'standard')
    assert.deepEqual(history.RETENTION_PROFILES.map((profile) => view.valid(profile.id)), [true, true, true])
    assert.equal(view.valid('huge'), false)
    assert.equal(view.valid(500), false)
  })

  check('page: the readouts give the sample count, the time covered, the largest and typical gap and the thinning, and say a legacy history\'s thinning is unknown', () => {
    const { tree } = mount({ file: legacyFile })
    const root = tree()
    const samples = textOf(find(root, 'data-retention-samples'))
    const gaps = textOf(find(root, 'data-retention-gaps'))
    const thinning = find(root, 'data-retention-thinning')

    assert.match(samples, /^5 kept for this race; the Standard profile keeps at most 2'000 per series$/)
    assert.equal(gaps, 'largest 100 d, typical 25 d')
    assert.equal(thinning.data.attrs['data-status'], 'unknown')
    assert.match(textOf(thinning), /^Thinning unknown/)
    assert.doesNotMatch(textOf(thinning), /\b0 times?\b|Never thinned/)
  })

  check('page: the readouts of a series the recorder thinned give the number of times, the samples dropped and when', () => {
    const { tree } = mount({ file: recorded(Array.from({ length: 12 }, (_, index) => (index + 1) * DAY), 5) })
    const thinning = find(tree(), 'data-retention-thinning')

    assert.equal(thinning.data.attrs['data-status'], 'thinned')
    assert.match(textOf(thinning), /^Older half thinned \d+ times, dropping \d+ samples; latest thinning at 2050-01-1\d \(saved \d{4}-\d\d-\d\d, cap 5\)\.$/)
  })

  check('page: sizes are labelled apart: measured bytes are the stored series\' and the whole file\'s, predicted ones are about a profile', () => {
    const { vm, tree } = mount({ file: twoFile })
    const root = tree()
    const measured = textOf(find(root, 'data-retention-measured'))
    const predicted = textOf(find(root, 'data-retention-predicted'))
    const headers = nodesOf(root, (node) => node.tag === 'th').map(textOf)

    assert.notEqual(history.bytesText(history.measuredBytes(twoFile.races[7])), history.bytesText(history.measuredBytes(twoFile)), 'the series and the file differ in size')
    assert.ok(measured.startsWith(`${history.bytesText(history.measuredBytes(twoFile.races[7]))} for this race's series, ${history.bytesText(history.measuredBytes(twoFile))} for the whole branch file.`), measured)
    assert.match(measured, /Measured as compact JSON; the file on disk is larger by its indentation\.$/)
    assert.doesNotMatch(measured, /redict/)
    assert.match(predicted, /^About .* for this series once it holds 2'000 samples, predicted from the average size of its samples\.$/)
    assert.doesNotMatch(predicted, /easured/)
    assert.ok(predicted.includes(history.bytesText(vm.retentionView.current.bytesAtCap)))
    assert.ok(headers.includes('Size if thinned now (predicted)') && headers.includes('Size at the cap (predicted)'), headers.join(' | '))
    assert.notEqual(history.measuredBytes(longFile.races[7]), vm.retentionView.current.bytesAtCap)
  })

  check('page: each profile\'s row says what it would keep of the series now, the gap that leaves and its predicted sizes', () => {
    const { tree } = mount({ file: longFile })
    const rows = Object.fromEntries(history.RETENTION_PROFILES.map((profile) => [profile.id, textOf(find(tree(), 'data-profile', profile.id))]))
    const kept = history.thinCounted(longFile.races[7].snapshots, 500)
    const predicted = history.predictRetention(longFile.races[7], history.retentionProfile('compact'))

    assert.ok(rows.compact.includes(`${kept.snapshots.length} (${kept.dropped} thinned)`), rows.compact)
    assert.ok(rows.compact.includes(history.durationText(predicted.largestGap)) && rows.compact.includes(history.bytesText(predicted.bytes)) && rows.compact.includes(history.bytesText(predicted.bytesAtCap)), rows.compact)
    assert.ok(rows.standard.startsWith('Standard (in force)'), rows.standard)
    assert.ok(rows.balanced.includes('700') && !rows.balanced.includes('thinned'), rows.balanced)
  })

  check('page: a profile change applies only to samples that are observed or kept, and the page says it cannot restore discarded ones before anything is chosen', () => {
    const { tree } = mount({ file: longFile })
    const root = tree()

    assert.equal(find(root, 'data-retention-confirm'), undefined, 'nothing is waiting')
    assert.match(textOf(find(root, 'data-retention-limits')), /applies only to samples that are observed or still kept\. It cannot restore samples that were thinned, and a larger cap brings none back/)
  })

  check('page: choosing a profile changes nothing until it is confirmed, and the confirmation states how much would be thinned and that thinned samples are gone for good', async () => {
    const config = new MemoryConfig()
    const { vm, tree } = mount({ file: longFile, config })

    find(tree(), 'data-retention', 'compact').data.on.click()
    await flush()

    const confirm = find(tree(), 'data-retention-confirm')
    const text = textOf(confirm)
    const dropped = history.thinCounted(longFile.races[7].snapshots, 500).dropped

    assert.ok(confirm, 'the confirmation is shown')
    assert.equal(vm.retentionProfile, 'standard')
    assert.equal(config.has('historyRetention'), false)
    assert.ok(text.includes('from Standard (2\'000) to Compact (500)'), text)
    assert.ok(text.includes(`The next save thins 1 of the 1 series in this branch to at most 500 samples and discards up to ${dropped} stored samples in all (1 holds more than 500 now, and thinning only the samples stored now would drop ${dropped})`), text)
    assert.match(text, /once the new sample is in/)
    assert.match(text, /Samples that are already thinned are gone for good: a larger cap keeps the samples observed from now on and never brings them back\./)

    vm.retentionPick = null
    await flush()

    assert.equal(find(tree(), 'data-retention-confirm'), undefined, 'a cancel closes it')
    assert.equal(vm.retentionProfile, 'standard')
    assert.equal(config.has('historyRetention'), false, 'and writes nothing')
  })

  check('page: a cap that is not smaller says nothing is thinned now and still that discarded samples do not come back', async () => {
    const config = new MemoryConfig([['historyRetention', '"compact"']])
    const { tree } = mount({ file: longFile, config })

    find(tree(), 'data-retention', 'balanced').data.on.click()
    await flush()

    const text = textOf(find(tree(), 'data-retention-confirm'))

    assert.match(text, /No series in this branch holds as many as 1'000 samples, so the next save thins nothing/)
    assert.match(text, /gone for good/)
  })

  check('page: the confirmation counts what the next save would discard, the new sample going in first, and labels the figure for the stored samples as such', async () => {
    const times = irregular(666)
    const file = { gameName: 'Game', races: { 7: { raceName: 'Test Race', npr: false, snapshots: times } } }
    const { tree } = mount({ file })

    find(tree(), 'data-retention', 'compact').data.on.click()
    await flush()

    const text = textOf(find(tree(), 'data-retention-confirm'))
    const next = history.mergeGame(file, { gameName: 'Game', races: [{ RaceID: 7, raceName: 'Test Race', npr: false, snapshot: row(times[665].t + 1) }] }, { limit: 500, now })
    const discarded = 667 - next.races[7].snapshots.length

    assert.equal(discarded, 291)
    assert.ok(text.includes(`discards up to ${discarded} stored samples in all`), text)
    assert.ok(text.includes('thinning only the samples stored now would drop 166'), text)
    assert.doesNotMatch(text, /166 in all|166 samples in all/)
    assert.doesNotMatch(text, /intelligence sample before it/, 'a branch with no alien series has none to replace')
  })

  check('page: the confirmation counts the sample an unchanged observation removes before the thinning, so its figure holds for every way a save can go', async () => {
    const alien = Array.from({ length: 502 }, (_, index) => intelRow(10 + index))
    const file = { gameName: 'Game', races: { 7: { raceName: 'Test Race', npr: false, snapshots: rowsAt([1, 2, 3]) } }, intel: { 7: { 9: { name: 'Alien', snapshots: alien } } } }
    const { tree } = mount({ file })

    find(tree(), 'data-retention', 'compact').data.on.click()
    await flush()

    const text = textOf(find(tree(), 'data-retention-confirm'))
    const next = history.mergeGame(file, { gameName: 'Game', races: [], intel: { 7: [{ AlienRaceID: 9, name: 'Alien', snapshot: { t: alien[501].t, contact: alien[500].contact, comm: 2 } }] } }, { limit: 500, now })

    assert.equal(502 - next.intel[7][9].snapshots.length, 126)
    assert.ok(text.includes('discards up to 126 stored samples in all'), text)
    assert.match(text, /that adds up to 1 to what thinning alone would discard\./)
    assert.doesNotMatch(text, /can be those/)
    assert.ok(text.includes('thinning only the samples stored now would drop 125'), text)
  })

  check('page: the confirmation words the allowance for matching observations as an allowance, not as a count of the samples a save removes: two alien series each losing one still add up to 1', async () => {
    const alien = (count) => Array.from({ length: count }, (_, index) => intelRow(10 + index))
    const file = { gameName: 'Game', races: { 7: { raceName: 'Test Race', npr: false, snapshots: rowsAt([1, 2, 3]) } }, intel: { 7: { 9: { name: 'Alien', snapshots: alien(502) }, 10: { name: 'Other', snapshots: alien(500) } } } }
    const { tree } = mount({ file })

    find(tree(), 'data-retention', 'compact').data.on.click()
    await flush()

    const text = textOf(find(tree(), 'data-retention-confirm'))

    assert.ok(text.includes('thins 2 of the 3 series'), text)
    assert.ok(text.includes('discards up to 251 stored samples in all'), text)
    assert.match(text, /that adds up to 1 to what thinning alone would discard\./)
    assert.doesNotMatch(text, /samples counted above/)
  })

  check('page: a stored thinning record with a time no calendar date holds reads as unknown and breaks nothing: not the panel, the header, nor either CSV', () => {
    const file = recorded(Array.from({ length: 12 }, (_, index) => (index + 1) * DAY), 5)

    file.races[7].thinning.last.at = 1e20

    const { vm, tree } = mount({ file })

    assert.doesNotThrow(() => tree())
    assert.equal(find(tree(), 'data-retention-thinning').data.attrs['data-status'], 'unknown')
    assert.match(vm.recording.sampling, /Thinning unknown/)
    assert.doesNotThrow(() => downloadOf(vm))
    assert.doesNotThrow(() => downloadOf(vm, 'downloadMineralCsv'))
  })

  check('page: the confirmed profile is kept across a restart and is the key the recorder reads', async () => {
    const config = new MemoryConfig()
    const { vm, tree } = mount({ file: longFile, config })

    find(tree(), 'data-retention', 'compact').data.on.click()
    await flush()
    find(tree(), 'data-retention-apply').data.on.click()
    await flush()

    assert.equal(vm.retentionProfile, 'compact')
    assert.equal(vm.retentionPick, null)
    assert.equal(find(tree(), 'data-retention-confirm'), undefined)
    assert.equal(config.get('historyRetention'), 'compact')
    assert.equal(history.retentionOfSettings({ store: nested(config) }).cap, 500, 'the recorder reads this setting')

    const again = mount({ file: longFile, config: config.reopened() })
    const row500 = textOf(find(again.tree(), 'data-profile', 'compact'))

    assert.equal(again.vm.retentionProfile, 'compact')
    assert.ok(row500.startsWith('Compact (in force)'), row500)
    assert.equal(find(again.tree(), 'data-retention', 'compact').data.attrs.disabled, true)
    assert.equal(find(again.tree(), 'data-retention', 'standard').data.attrs.disabled, false)
  })

  check('page: a stored profile this version does not offer opens as Standard', () => {
    const { vm } = mount({ file: longFile, config: new MemoryConfig([['historyRetention', '"enormous"']]) })

    assert.equal(vm.retentionProfile, 'standard')
  })

  // The observation record of the shown branch is read through the stub store of the page's own module: the files held by name in `__heldStores` (the stub reads it at each access).
  const observed = async (file, config, record, work) => {
    globalThis.__heldStores = new Map(file === undefined ? [] : [['campaign-c1-b1-observations', file]])
    globalThis.__storeReads = []

    try {
      return await work({ ...mount({ file: record, config }), reads: () => globalThis.__storeReads.filter((name) => name.endsWith('-observations')) })
    } finally {
      delete globalThis.__heldStores
      delete globalThis.__storeReads
    }
  }

  const observationHex = (id) => id.toString(16).padStart(16, '0')

  const OBSERVED_LABEL = observations.OBSERVED_KINDS.formation.label.toLowerCase()

  const observationRace = (ids, captures = [[100, 1], [200, 2]]) => ({ kinds: { formation: { captures, objects: Object.fromEntries(ids.map((id) => [id, [100, 200, observationHex(id)]])) } } })

  const observationFile = (races) => ({ version: 1, races })

  const observing = () => new ObservingConfig([['campaign.c1.race.7.observe', '["formation"]']])

  const rowText = (tree) => textOf(find(tree, 'data-retention-observations'))

  const numbersOf = (text) => (text.match(/\d+/g) || []).map(Number)
  const stateOf = (text) => (/\b(On|Off)\b/.exec(text) || [])[1] || null

  // The figures written as a whole token (a sign, digits, a decimal part, nothing else beside them) directly before a unit word, in the order they appear: `3 objects`, `500 captures`. A token that is not a whole figure (a minus before it, a point inside it, a letter beside it) reads as null, so a malformed count is a wrong value and never the number of a part of it. The counts here are below a thousand, so none is grouped. The figure of one unit is told from another by the unit it stands before, not by its place in the sentence.
  const countOf = (text, unit) => [...text.matchAll(new RegExp(`(?:^|\\s)([-+\\u2212]?\\d\\S*)\\s+${unit}\\b`, 'g'))].map((found) => readFigure(found[1], 'None'))

  // The captures a clause states (a clause ends at a semicolon or a full stop), by the clause the role names: the captures held stand in the clause that counts the objects held (a figure before `objects`), the captures a full list holds in the clause that predicts the size. Whatever the order of the clauses and the words around the figure, a held count and a cap that change places read as each other's value.
  const HELD = /\d\s+objects?\b/
  const CAP = /\bpredicted\b/
  const capturesOf = (text, role) => countOf(text.split(/;|\.(?=\s|$)/).find((part) => role.test(part)) || '', 'captures?')

  // Whether a size is stated as the one measured or the one predicted: by the one of the two words the clause of the sentence it stands in holds (a clause ends at a semicolon or a full stop), whatever the wording around them and the side of the figure the word stands on.
  const roleOf = (text, figure) => {
    const clause = text.split(/;|\.(?=\s|$)/).find((part) => part.includes(figure))
    const words = clause ? ['measured', 'predicted'].filter((word) => new RegExp(`\\b${word}\\b`).test(clause)) : []

    return words.length === 1 ? words[0] : null
  }

  check('page: the Retention panel states the observation record of the shown race: on for the race, the objects and captures held, the size measured as compact JSON of its own record and the size predicted for a full capture list, and nothing of another race\'s', () => {
    const mine = observationRace([1, 2, 3])
    const other = observationRace([11, 12, 13, 14, 15], [[100, 1], [200, 2], [300, 3]])
    const full = observationRace([1, 2, 3], Array.from({ length: 500 }, (_, index) => [index + 1, index + 1]))
    const predicted = observations.observationEstimate({ objects: 3, captures: 500 })

    return observed(observationFile({ 6: other, 7: mine, 8: other }), observing(), longFile, ({ vm, tree }) => {
      const text = rowText(tree())
      const budget = vm.observationBudget

      assert.deepEqual({ kinds: budget.kinds, player: budget.player, objects: budget.objects, captures: budget.captures, measured: budget.measured, predicted: budget.predicted, failures: budget.failures, error: budget.error }, { kinds: ['formation'], player: true, objects: 3, captures: 2, measured: bytesOf(mine), predicted: observations.observationEstimate({ objects: 3, captures: 500 }), failures: 0, error: '' })
      assert.equal(stateOf(text), 'On')
      assert.ok(text.includes(OBSERVED_LABEL), 'the kind observed is named')
      assert.deepEqual(countOf(text, 'objects?'), [3], 'the objects held')
      assert.deepEqual({ held: capturesOf(text, HELD), cap: capturesOf(text, CAP) }, { held: [2], cap: [500] }, 'the captures held and the captures a full list holds, each by the clause that says it')
      assert.equal(roleOf(text, history.bytesText(bytesOf(mine))), 'measured', 'the size of the race\'s own record is the measured one')
      assert.equal(roleOf(text, history.bytesText(predicted)), 'predicted', 'the size for a full capture list is the predicted one')
      assert.ok(predicted >= bytesOf(full) && predicted <= 2 * bytesOf(full), 'the prediction is at least what the record takes with 500 captures and at most twice it')
      assert.ok(!numbersOf(text).includes(5) && !numbersOf(text).includes(15), 'no other race is counted')
      assert.doesNotMatch(text, /\b(I|you|your|we|our)\b/i)
      assert.match(text, /Survey Progress/, 'it says where the choice is made')
    })
  })

  check('page: the Retention panel states the observation record of a race that does not observe: off, with what is held kept and counted', () => observed(observationFile({ 7: observationRace([1, 2, 3]) }), new ObservingConfig([['campaign.c1.race.7.observe', '[]']]), longFile, ({ vm, tree }) => {
    const text = rowText(tree())

    assert.deepEqual({ kinds: vm.observationBudget.kinds, objects: vm.observationBudget.objects, captures: vm.observationBudget.captures }, { kinds: [], objects: 3, captures: 2 })
    assert.equal(stateOf(text), 'Off')
    assert.ok(!text.includes(OBSERVED_LABEL), 'no kind is named as observed')
    assert.deepEqual(countOf(text, 'objects?'), [3], 'what is held is still counted')
    assert.deepEqual(capturesOf(text, HELD), [2], 'the captures held are still counted')
  }))

  check('page: the Retention panel states the observation record of a branch that holds none: none kept yet and none recorded, never 0, and no prediction', () => observed(undefined, observing(), longFile, ({ vm, tree }) => {
    const text = rowText(tree())

    assert.deepEqual({ objects: vm.observationBudget.objects, captures: vm.observationBudget.captures, measured: vm.observationBudget.measured, predicted: vm.observationBudget.predicted }, { objects: null, captures: null, measured: null, predicted: null })
    assert.equal(stateOf(text), 'On')
    assert.deepEqual(countOf(text, 'captures?'), [500], 'the captures the record can hold are stated')
    assert.doesNotMatch(text, /\b0 objects|predicted/)
  }))

  check('page: the Retention panel counts one object and one capture in the singular, and says how many captures failed', () => {
    const one = observationRace([1], [[100, 1]])

    one.kinds.formation.objects[1] = [100, 100, observationHex(1)]
    one.kinds.formation.failures = [{ at: 1, t: 150, reason: 'x' }]

    return observed(observationFile({ 7: one }), observing(), longFile, ({ vm, tree }) => {
      const text = rowText(tree())

      assert.deepEqual({ objects: vm.observationBudget.objects, captures: vm.observationBudget.captures, failures: vm.observationBudget.failures }, { objects: 1, captures: 1, failures: 1 })
      assert.doesNotMatch(text, /\b1 (objects|captures)\b/, 'a count of one is not in the plural')
      assert.match(text, /\b1 capture failed\b/)
    })
  })

  check('page: the Retention panel says how many captures failed: several are counted over the kinds and a race with none says nothing of it', async () => {
    const failing = observationRace([1, 2])

    failing.kinds.formation.failures = [{ at: 1, t: 150, reason: 'x' }, { at: 2, t: 160, reason: 'y' }]

    await observed(observationFile({ 7: failing }), observing(), longFile, ({ vm, tree }) => {
      assert.equal(vm.observationBudget.failures, 2)
      assert.match(rowText(tree()), /\b2 captures failed\b/)
    })
    await observed(observationFile({ 7: observationRace([1, 2]) }), observing(), longFile, ({ vm, tree }) => {
      assert.equal(vm.observationBudget.failures, 0)
      assert.doesNotMatch(rowText(tree()), /failed/)
    })
  })

  check('page: the Retention panel names an observation file this version cannot read instead of showing it as empty', async () => {
    for (const file of [{ version: 1, races: 5 }, { version: 2, races: {} }, { version: 1, races: { 7: { kinds: { formation: { captures: 'none', objects: {} } } } } }]) {
      await observed(file, observing(), longFile, ({ vm, tree }) => {
        const text = rowText(tree())

        assert.ok(vm.observationBudget.error.length > 0 && vm.observationBudget.objects === null, JSON.stringify(file))
        assert.ok(text.includes(vm.observationBudget.error), JSON.stringify(file))
        assert.doesNotMatch(text, /\b0 objects|none kept yet/, JSON.stringify(file))
      })
    }
  })

  check('page: the Retention panel says the observation record is for player races only when the shown race is not a player, and reads no file for it', () => observed(observationFile({ 7: observationRace([1, 2, 3]) }), observing(), { gameName: 'Game', races: { 7: { raceName: 'Rival', npr: true, snapshots: irregular(50, 3) } } }, ({ vm, tree, reads }) => {
    const text = rowText(tree())

    assert.equal(vm.observationBudget.player, false)
    assert.equal(stateOf(text), null, 'a race that is not a player is not said to observe or not')
    assert.deepEqual(countOf(text, 'objects?'), [], 'what the file holds is not counted')
    assert.match(text, /Survey Progress/, 'it says where the choice is made')
    assert.deepEqual(reads(), [], 'the file of the branch is not opened')
  }))

  check('page: the Retention panel opens no observation file for a race never chosen, and opens one for a race that chose and turned it off', async () => {
    await observed(observationFile({ 7: observationRace([1, 2, 3]) }), new MemoryConfig(), longFile, ({ vm, tree, reads }) => {
      assert.deepEqual({ kinds: vm.observationBudget.kinds, objects: vm.observationBudget.objects, reads: reads() }, { kinds: [], objects: null, reads: [] })
      assert.equal(stateOf(rowText(tree())), 'Off')
    })
    await observed(observationFile({ 7: observationRace([1, 2, 3]) }), new ObservingConfig([['campaign.c1.race.7.observe', '[]']]), longFile, ({ vm, reads }) => assert.deepEqual({ objects: vm.observationBudget.objects, opened: reads().length > 0 }, { objects: 3, opened: true }))
  })

  check('page: a smaller cap on the event archive waits for confirmation even when the shown branch holds no archive, the confirmation says the cap applies to every campaign, race and branch at their next capture, and a larger cap is kept at once', async () => {
    const config = new MemoryConfig()
    const { vm, tree } = mount({ file: longFile, config })

    assert.equal(vm.eventRecord.file, null, 'the shown branch holds no archive')
    assert.equal(vm.eventCap, 50000)
    find(tree(), 'data-event-cap', 25000).data.on.click()
    await flush()

    const text = textOf(find(tree(), 'data-event-cap-confirm'))

    assert.equal(vm.eventCap, 50000, 'nothing changes until it is confirmed')
    assert.equal(vm.eventCapPick, 25000)
    assert.equal(config.has('historyEventCap'), false)
    assert.match(text, /from 50'000 to 25'000 events\?/)
    assert.match(text, /applies to every campaign, race and branch of this installation, and takes effect at the next capture of each/)
    assert.match(text, /gone for good/)
    assert.match(text, /The shown branch holds no archive/)
    assert.doesNotMatch(text, /\b(I|you|your|we|our)\b/i)

    find(tree(), 'data-event-cap-cancel').data.on.click()
    await flush()

    assert.equal(find(tree(), 'data-event-cap-confirm'), undefined, 'a cancel closes it')
    assert.equal(vm.eventCap, 50000)
    assert.equal(config.has('historyEventCap'), false)

    find(tree(), 'data-event-cap', 25000).data.on.click()
    await flush()
    find(tree(), 'data-event-cap-apply').data.on.click()
    await flush()

    assert.equal(vm.eventCap, 25000)
    assert.equal(config.get('historyEventCap'), 25000)

    find(tree(), 'data-event-cap', 100000).data.on.click()
    await flush()

    assert.equal(find(tree(), 'data-event-cap-confirm'), undefined, 'a larger cap needs none')
    assert.equal(vm.eventCap, 100000)
    assert.equal(config.get('historyEventCap'), 100000)
  })

  check('page: the profile reads as it is chosen: a series above the cap says it is thinned at the next save, and with the cap it is not', () => {
    const above = mount({ file: longFile, config: new MemoryConfig([['historyRetention', '"compact"']]) })
    const within = mount({ file: longFile })

    assert.match(textOf(find(above.tree(), 'data-retention-samples')), /This series is above that, and is thinned when the recorder next saves it$/)
    assert.doesNotMatch(textOf(find(within.tree(), 'data-retention-samples')), /above that/)
  })

  check('page: the header advertises sparse sampling over the rows kept, "N samples; gaps up to X", and what is known of the thinning', () => {
    const { vm } = mount({ file: legacyFile })
    const thinned = mount({ file: recorded(Array.from({ length: 12 }, (_, index) => (index + 1) * DAY), 5) })

    assert.match(vm.recording.sampling, /^5 samples; gaps up to 100 d \(typical 25 d\)\. Thinning unknown/)
    assert.match(thinned.vm.recording.sampling, /^\d+ samples; gaps up to .*\. Older half thinned \d+ times/)
    assert.equal(thinned.vm.allSnapshots.length, thinned.vm.record.snapshots.length, 'the page works on the retained rows')
    assert.ok(thinned.vm.allSnapshots.length < 12)
    assert.match(thinned.vm.recording.note, /a series past the retention cap has its older half thinned/)
  })

  check('page: the CSV reflects the retained rows and adds the gap since the previous row and the retention note', () => {
    const { vm } = mount({ file: legacyFile })
    const csv = downloadOf(vm)
    const note = history.retentionNote(legacyFile.races[7], (t) => vm.date(t))

    assert.equal(csv.name, 'Test_Race-history.csv')
    assert.deepEqual(csv.header.slice(-3), ['Figures not recorded', 'Gap since previous row (s)', 'Retention'])
    assert.equal(csv.rows.length, 5)
    assert.deepEqual(csv.rows.map((line) => line['Gap since previous row (s)']), ['', ...days([10, 20, 30, 100]).map(String)])
    assert.deepEqual(csv.rows.map((line) => line.Retention), [note, '', '', '', ''])
    assert.match(note, /Thinning unknown/)

    const thinned = mount({ file: recorded(Array.from({ length: 12 }, (_, index) => (index + 1) * DAY), 5) })
    const out = downloadOf(thinned.vm)

    assert.equal(out.rows.length, thinned.vm.record.snapshots.length)
    assert.ok(out.rows.length < 12)
    assert.match(out.rows[0].Retention, /Older half thinned \d+ times/)
  })

  check('page: the mineral CSV of a thinned history carries the gap since the previous row and the retention note, as the history CSV does', () => {
    const { vm } = mount({ file: recorded(Array.from({ length: 12 }, (_, index) => (index + 1) * DAY), 5) })
    const out = downloadOf(vm, 'downloadMineralCsv')
    const note = history.retentionNote(vm.record, (t) => vm.date(t))
    const kept = vm.record.snapshots.map((snapshot) => snapshot.t)
    const duranium = out.rows.filter((line) => line['Mineral ID'] === '1')

    assert.equal(out.name, 'Test_Race-minerals-absolute.csv')
    assert.deepEqual(out.header.slice(-2), ['Gap since previous row (s)', 'Retention'])
    assert.equal(out.rows.length, kept.length * 3)
    assert.match(note, /Older half thinned \d+ times/)
    assert.equal(out.rows[0].Retention, note)
    assert.ok(out.rows.slice(1).every((line) => line.Retention === ''))
    assert.deepEqual(duranium.map((line) => line['Gap since previous row (s)']), ['', ...kept.slice(1).map((t, index) => String(t - kept[index]))])
    assert.ok(kept.length < 12)
  })

  check('page: the section\'s summary says what it shows and holds no figure that changes', () => {
    const { tree } = mount({ file: legacyFile })
    const panel = tree().children[0]
    const summary = panel.data.attrs['data-summary']

    assert.ok(typeof summary === 'string' && summary.length > 40)
    assert.doesNotMatch(summary, /\d/)
    assert.match(summary, /never brings back a sample that was thinned/)
  })

  check('page: an empty history shows no sample, a dash for what cannot be told, and no size predicted', () => {
    const { vm, tree } = mount({ file: { gameName: 'Game', races: { 7: { raceName: 'Test Race', npr: false, snapshots: [] } } } })
    const root = tree()

    assert.match(textOf(find(root, 'data-retention-samples')), /^0 kept for this race/)
    assert.equal(textOf(find(root, 'data-retention-gaps')), 'largest —, typical —')
    assert.match(textOf(find(root, 'data-retention-predicted')), /^About — for this series/)
    assert.equal(vm.recording, null)
  })

  check('page: no Vue warning', () => {
    assert.deepEqual(warnings, [])
  })

  return checks.map(([name, run]) => [name, settled(async () => {
    try {
      await run()

      return true
    } catch (error) {
      return String((error && error.stack) || error).split('\n').slice(0, 6).join('\n         ')
    }
  })])
}

// ---------- the mutations ----------

// A deliberate fault in a copy of a utility and the checks (by the start of their names) that must fail for it.
const UTILITY_MUTATIONS = [
  { name: 'thinning drops the latest half instead of the older', file: 'history.js', find: 'const next = [...result.slice(0, half).filter((_, index) => index % 2 === 0), ...result.slice(half)]', replace: 'const next = [...result.slice(0, half), ...result.slice(half).filter((_, index) => index % 2 === 0)]', fails: ['thinning: ten snapshots', 'thinning: every profile'] },
  { name: 'thinning counts a pass as one drop', file: 'history.js', find: 'passes++\n    result = next', replace: 'passes += 2\n    result = next', fails: ['thinning: ten snapshots'] },
  { name: 'the samples dropped are not counted', file: 'history.js', find: 'dropped: snapshots.length - result.length, cap }', replace: 'dropped: passes, cap }', fails: ['thinning: ten snapshots', 'thinning: every profile', 'thinning: recording one save'] },
  { name: 'a series within its cap is thinned anyway', file: 'history.js', find: 'while (result.length > cap) {', replace: 'while (result.length >= cap) {', fails: ['thinning: a history within its cap', 'thinning: every profile'] },
  { name: 'a cap below 3 keeps the oldest samples', file: 'history.js', find: ': result.slice(result.length - cap)', replace: ': result.slice(0, cap)', fails: ['thinning: a cap too small'] },
  { name: 'a profile has a cap above what a backup accepts', file: 'history.js', find: '{ id: \'standard\', label: \'Standard\', cap: MAX_SNAPSHOTS }', replace: '{ id: \'standard\', label: \'Standard\', cap: MAX_SNAPSHOTS * 2 }', fails: ['thinning: the profiles are a few'] },
  { name: 'an unknown profile id reads as the smallest', file: 'history.js', find: '|| RETENTION_PROFILES.find((profile) => profile.id === DEFAULT_RETENTION)', replace: '|| RETENTION_PROFILES[0]', fails: ['thinning: a profile that is not one'] },
  { name: 'the settings key of the profile is another', file: 'history.js', find: 'settings.store.historyRetention : undefined', replace: 'settings.store.retention : undefined', fails: ['thinning: a profile that is not one', 'recorder: the profile in the settings'] },
  { name: 'a series from before the record is read as untouched', file: 'history.js', find: 'if (!thinning) {\n    return { status: \'unknown\', passes: null, dropped: null, last: null }\n  }', replace: 'if (!thinning) {\n    return { status: \'untouched\', passes: 0, dropped: 0, last: null }\n  }', fails: ['status: a series from before the record', 'status: what a viewing race', 'status: a thinning record that is not valid'] },
  { name: 'an unknown thinning counted as none', file: 'history.js', find: ': { status: \'unknown\', passes: null, dropped: null, last: null }\n}', replace: ': { status: \'unknown\', passes: 0, dropped: 0, last: null }\n}', fails: ['status: a series something else rewrote'] },
  { name: 'a series written by something else keeps its witness', file: 'history.js', find: 'if (thinning.complete && thinning.witness === witnessOf(record.snapshots)) {', replace: 'if (thinning.complete) {', fails: ['status: a series something else rewrote'] },
  { name: 'the recorder starts a new series as unknown', file: 'history.js', find: 'const base = !previous ? { complete: true, passes: 0, dropped: 0, last: null }', replace: 'const base = !previous ? { complete: false, passes: 0, dropped: 0, last: null }', fails: ['status: a series the recorder starts', 'status: thinning is counted'] },
  { name: 'a series from before the record is made complete by the next save', file: 'history.js', find: 'complete: Boolean(intact && prior.complete)', replace: 'complete: true', fails: ['status: a series from before the record that is thinned now', 'status: a series something else rewrote'] },
  { name: 'a rewritten series is believed by the recorder', file: 'history.js', find: 'const intact = prior && prior.witness === witnessOf(previous.snapshots)', replace: 'const intact = Boolean(prior)', fails: ['status: a series something else rewrote'] },
  { name: 'the thinning of a series is not carried forward', file: 'history.js', find: 'const passes = base.passes + outcome.passes', replace: 'const passes = outcome.passes', fails: ['thinning: recording one save', 'status: thinning is counted'] },
  { name: 'the time of the latest thinning is not kept', file: 'history.js', find: ': base.last,\n    witness', replace: ': null,\n    witness', fails: ['status: thinning is counted'] },
  { name: 'the thinning is dated by the game time', file: 'history.js', find: 'last: outcome.passes ? { at: now(), t: latest.t,', replace: 'last: outcome.passes ? { at: latest.t, t: latest.t,', fails: ['status: thinning is counted', 'recorder: the profile in the settings'] },
  { name: 'a thinning record is believed whatever it holds', file: 'campaign.js', find: 'if (raw.dropped < raw.passes || (raw.passes === 0) !== (raw.last === null)) {', replace: 'if (false) {', fails: ['status: a thinning record that is not valid'] },
  { name: 'a thinning record with a key of its own is believed', file: 'campaign.js', find: '!hasOnly(raw, THINNING_KEYS) ||', replace: '', fails: ['status: a thinning record that is not valid'] },
  { name: 'a legacy series is given a thinning record at once', file: 'history.js', find: 'if (!base.complete && !passes) {\n    return undefined\n  }', replace: 'if (false) {\n    return undefined\n  }', fails: ['status: a series from before the record says'] },
  { name: 'an alien race\'s series is not given a thinning record', file: 'history.js', find: 'view[AlienRaceID] = withThinning({ name, snapshots: outcome.snapshots }, previous, outcome, now)', replace: 'view[AlienRaceID] = { name, snapshots: outcome.snapshots }', fails: ['status: what a viewing race'] },
  { name: 'the typical gap is the mean', file: 'history.js', find: 'typical: gaps.length ? (gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2) : null', replace: 'typical: gaps.length ? gaps.reduce((total, gap) => total + gap, 0) / gaps.length : null', fails: ['figures: the largest and the typical gap'] },
  { name: 'the largest gap is the first', file: 'history.js', find: 'largest: gaps.length ? gaps[gaps.length - 1] : null', replace: 'largest: gaps.length ? gaps[0] : null', fails: ['figures: the largest and the typical gap', 'figures: the sampling line'] },
  { name: 'a gap of one sample is 0', file: 'history.js', find: 'largest: gaps.length ? gaps[gaps.length - 1] : null', replace: 'largest: gaps.length ? gaps[gaps.length - 1] : 0', fails: ['figures: no gap is known'] },
  { name: 'an unknown span reads as 0 s', file: 'history.js', find: 'if (!isKnownNumber(seconds)) {\n    return UNKNOWN_TEXT\n  }\n\n  const value = Number(seconds)', replace: 'const value = Number(seconds) || 0', fails: ['figures: a span and a size'] },
  { name: 'an unknown size reads as 0 B', file: 'history.js', find: 'if (!isKnownNumber(bytes)) {\n    return UNKNOWN_TEXT\n  }\n\n  const value = Number(bytes)', replace: 'const value = Number(bytes) || 0', fails: ['figures: a span and a size'] },
  { name: 'measured bytes counted in characters', file: 'history.js', find: 'new TextEncoder().encode(JSON.stringify(value)).length', replace: 'JSON.stringify(value).length', fails: ['figures: measured bytes'] },
  { name: 'a prediction at the cap uses the thinned rows', file: 'history.js', find: 'bytesAtCap: Math.round((storedBytes(snapshots) / snapshots.length) * profile.cap)', replace: 'bytesAtCap: Math.round((storedBytes(thinned.snapshots) / thinned.snapshots.length) * profile.cap)', fails: ['figures: a prediction for a profile'] },
  { name: 'a prediction is the measured size', file: 'history.js', find: 'bytes: storedBytes({ ...record, snapshots: thinned.snapshots }),', replace: 'bytes: storedBytes(record),', fails: ['figures: a prediction for a profile'] },
  { name: 'nothing known predicts 0', file: 'history.js', find: 'return { cap: profile.cap, thins: null, kept: null, dropped: null, passes: null, largestGap: null, bytes: null, bytesAtCap: null }', replace: 'return { cap: profile.cap, thins: false, kept: 0, dropped: 0, passes: 0, largestGap: 0, bytes: 0, bytesAtCap: 0 }', fails: ['figures: nothing is predicted'] },
  { name: 'the series over a cap are counted by races only', file: 'history.js', find: 'const series = [...measured(races, false), ...measured(aliens, true)]', replace: 'const series = [...measured(races, false)]', fails: ['figures: a branch is counted'] },
  { name: 'the first CSV row has a gap of 0', file: 'history.js', find: 'rows: snapshots.map((snapshot, index) => [index && Number.isFinite(snapshot.t)', replace: 'rows: snapshots.map((snapshot, index) => [!index ? 0 : Number.isFinite(snapshot.t)', fails: ['figures: the CSV columns'] },
  { name: 'the retention note is on every CSV row', file: 'history.js', find: 'index ? null : note]),', replace: 'note]),', fails: ['figures: the CSV columns'] },
  { name: 'the sampling line hides the thinning', file: 'history.js', find: '`#{samplingText(retentionStats(record && Array.isArray(record.snapshots) ? record.snapshots : []))}. #{thinningText(thinningStatus(record), date)}.`', replace: '`#{samplingText(retentionStats(record && Array.isArray(record.snapshots) ? record.snapshots : []))}.`', fails: ['figures: the note an export'] },
  { name: 'unknown thinning left out of the text', file: 'history.js', find: '\'Thinning unknown: this history was recorded or merged without its thinning being noted, so its older half may have been thinned and it is not assumed complete\'', replace: '\'Never thinned\'', fails: ['status: a series from before the record says', 'figures: the note an export'] },
  { name: 'a partial count stated as a count', file: 'history.js', find: '`#{passes} time#{passes === 1 ? \'\' : \'s\'}, dropping #{status === \'partial\' ? \'at least \' : \'\'}#{dropped}', replace: '`#{passes} time#{passes === 1 ? \'\' : \'s\'}, dropping #{dropped}', fails: ['status: a series from before the record that is thinned now'] },
  { name: 'the recorder ignores the profile', file: 'history.js', find: '{ limit: retentionOfSettings(storage.settings).cap, now }', replace: '{ limit: MAX_SNAPSHOTS, now }', fails: ['recorder: the profile in the settings', 'recorder: a larger profile'] },
  { name: 'the recorder never thins below Standard', file: 'history.js', find: '{ limit: retentionOfSettings(storage.settings).cap, now }', replace: '{ limit: Math.max(retentionOfSettings(storage.settings).cap, MAX_SNAPSHOTS), now }', fails: ['recorder: the profile in the settings'] },
  { name: 'a backup refuses a series with a thinning record', file: 'history-backup.js', find: '\'coverage\', \'snapshots\', \'thinning\'] : [\'name\', \'coverage\', \'snapshots\', \'thinning\']', replace: '\'coverage\', \'snapshots\'] : [\'name\', \'coverage\', \'snapshots\']', fails: ['backup: a backup carries', 'backup: a merge that changes'] },
  { name: 'a backup accepts a thinning record that is not valid', file: 'history-backup.js', find: 'if (series.thinning !== undefined && !readThinning(series.thinning)) {', replace: 'if (false) {', fails: ['backup: a thinning record that is not valid'] },
  { name: 'a merge keeps the record whose game times match even after it thinned', file: 'history.js', find: 'const standing = outcome.dropped ? undefined : sources.find(', replace: 'const standing = sources.find(', fails: ['status: a merge that thins the union', 'backup: a restore that merges', 'backup: an attachment'] },
  { name: 'the thinning a merge made is not counted', file: 'history.js', find: 'return { complete: true, passes: outcome.passes, dropped: outcome.dropped, last: own, witness }', replace: 'return { complete: true, passes: 0, dropped: 0, last: null, witness }', fails: ['status: a merge that thins the union', 'backup: a restore that merges', 'backup: an attachment'] },
  { name: 'a series with no record is taken as complete in a merge', file: 'history.js', find: 'complete: thinning ? thinning.complete && intact : !rows.length', replace: 'complete: thinning ? thinning.complete && intact : true', fails: ['status: a merge of series', 'backup: an attachment'] },
  { name: 'the thinning of a merged series is forgotten', file: 'history.js', find: 'const passes = Math.max(outcome.passes, ...sources.map((source) => source.passes))', replace: 'const passes = outcome.passes', fails: ['status: a merge of series'] },
  { name: 'a merge that adds nothing loses the record of the series', file: 'history.js', find: 'if (standing) {\n    return standing.thinning\n  }', replace: 'if (false) {\n    return standing.thinning\n  }', fails: ['status: a merge of series'] },
  { name: 'the next save left out of what a profile change would drop', file: 'history.js', find: 'const added = snapshots.length ? withSnapshot(snapshots, { t: snapshots[snapshots.length - 1].t + 1 }, cap).dropped : 0', replace: 'const added = stored', fails: ['figures: the next save'] },
  { name: 'unchanged intelligence skips the cap', file: 'history.js', find: ': thinCounted(snapshots.filter((existing) => existing.t !== snapshot.t), limit)', replace: ': { snapshots: snapshots.filter((existing) => existing.t !== snapshot.t), passes: 0, dropped: 0, cap: limit }', fails: ['thinning: an alien series whose intelligence'] },
  { name: 'a time no calendar date holds is believed', file: 'campaign.js', find: 'typeof value === \'number\' && Number.isFinite(new Date(value).getTime())', replace: 'typeof value === \'number\' && Number.isFinite(value)', fails: ['status: a thinning record that is not valid', 'backup: a thinning record that is not valid'] },
  { name: 'a restore keeps the thinning record of the series it merged into', file: 'history-backup.js', find: 'const thinning = thinningOfMerge([kept && kept.record, theirs.record], planned.outcome)', replace: 'const thinning = kept ? readThinning(kept.record.thinning) : undefined', fails: ['backup: a restore that merges'] },
  { name: 'an attachment keeps the thinning record of the series it merged into', file: 'campaign-attach.js', find: 'const thinning = thinningOfMerge([merged[id], record], result.outcome)', replace: 'const thinning = merged[id] ? merged[id].thinning : undefined', fails: ['backup: an attachment'] },
  { name: 'a merge borrows completeness from the side that offers it', file: 'history.js', find: 'witnessOf(source.rows) === witness && sources.every((other) => other === source || silent(other) || (other.intact && JSON.stringify(other.thinning) === JSON.stringify(source.thinning))))', replace: 'witnessOf(source.rows) === witness)', fails: ['status: a merge never leaves a series more known', 'backup: a restore and an attachment never leave'] },
  { name: 'a series with no record is taken as adding nothing to a merge', file: 'history.js', find: 'const silent = (source) => source.complete && !source.passes', replace: 'const silent = (source) => !source.passes', fails: ['status: a merge never leaves a series more known', 'backup: a restore and an attachment never leave'] },
  { name: 'a series that was thinned is taken as adding nothing to a merge', file: 'history.js', find: 'const silent = (source) => source.complete && !source.passes', replace: 'const silent = (source) => source.complete', fails: ['status: a merge never leaves a series more known'] },
  { name: 'the very same record on both sides no longer stands', file: 'history.js', find: ' || (other.intact && JSON.stringify(other.thinning) === JSON.stringify(source.thinning))', replace: '', fails: ['status: a merge never leaves a series more known', 'status: a merge of series'] },
  { name: 'a record whose rows changed vouches for another series', file: 'history.js', find: '(other.intact && JSON.stringify(other.thinning) === JSON.stringify(source.thinning))', replace: '(JSON.stringify(other.thinning) === JSON.stringify(source.thinning))', fails: ['status: a merge never leaves a series more known', 'backup: a restore and an attachment never leave'] },
  { name: 'a record is taken as intact whatever its rows', file: 'history.js', find: 'const intact = !!thinning && thinning.witness === witnessOf(rows)', replace: 'const intact = !!thinning', fails: ['status: a merge never leaves a series more known', 'backup: a restore and an attachment never leave'] },
  { name: 'the sample an unchanged observation removes is left out of the next save', file: 'history.js', find: 'next: Math.max(thinned, removed) }', replace: 'next: thinned }', fails: ['figures: the most a next save discards'] },
  { name: 'a series is counted as thinned for a sample a new observation replaces', file: 'history.js', find: 'thins: series.filter((entry) => entry.thinned > 0).length', replace: 'thins: series.filter((entry) => entry.next > 0).length', fails: ['figures: the most a next save discards'] },
]

// A deliberate fault in the page's script or in the Retention panel's template.
const PAGE_MUTATIONS = [
  { name: 'the profile kept for the race, not the app', mutate: replacing('retentionProfile: { key: \'historyRetention\', default: DEFAULT_RETENTION,', 'retentionProfile: { key: \'historyRetention\', scope: \'race\', default: DEFAULT_RETENTION,'), fails: ['page: the retention profile is a view declared for the app'] },
  { name: 'the profile kept under another key', mutate: replacing('key: \'historyRetention\'', 'key: \'historyRetentionProfile\''), fails: ['page: the retention profile is a view declared for the app', 'page: the confirmed profile is kept'] },
  { name: 'any text is a valid profile', mutate: replacing('valid: oneOf(RETENTION_PROFILES.map((profile) => profile.id)) }', 'valid: () => true }'), fails: ['page: the retention profile is a view declared for the app', 'page: a stored profile this version does not offer'] },
  { name: 'the default profile is the smallest', mutate: replacing('default: DEFAULT_RETENTION,', 'default: \'compact\','), fails: ['page: the retention profile is a view declared for the app', 'page: the readouts give the sample count'] },
  { name: 'a pick is applied at once', mutate: replacing('this.retentionPick = id === this.retentionProfile ? null : id', 'this.retentionProfile = id'), fails: ['page: choosing a profile changes nothing until it is confirmed', 'page: a cap that is not smaller'] },
  { name: 'a confirmation applies nothing', mutate: replacing('this.retentionProfile = this.retentionPick', 'this.retentionProfile = this.retentionProfile'), fails: ['page: the confirmed profile is kept across a restart'] },
  { name: 'a confirmation leaves the pick waiting', mutate: replacing('      this.retentionPick = null\n    },\n    // The adapter', '    },\n    // The adapter'), fails: ['page: the confirmed profile is kept across a restart'] },
  { name: 'the confirmation counts every series as over', mutate: replacing('const held = seriesOverCap(this.gameHistory, picked.cap)', 'const held = seriesOverCap(this.gameHistory, 1)'), fails: ['page: choosing a profile changes nothing until it is confirmed', 'page: a cap that is not smaller'] },
  { name: 'the confirmation leaves out that thinned samples are gone', mutate: replacing(' Samples that are already thinned are gone for good: a larger cap keeps the samples observed from now on and never brings them back.', ''), fails: ['page: choosing a profile changes nothing until it is confirmed', 'page: a cap that is not smaller'] },
  { name: 'the sampling line left out of the header', mutate: replacing('const sampling = retentionNote(this.record, (t) => this.date(t))\n\n      if (coverage.count === 1)', 'const sampling = \'\'\n\n      if (coverage.count === 1)'), fails: ['page: the header advertises sparse sampling'] },
  { name: 'the header\'s note still says the history is complete at 2000', mutate: replacing('a series past the retention cap has its older half thinned', 'past 2000 snapshots the older ones are thinned'), fails: ['page: the header advertises sparse sampling'] },
  { name: 'the thinning text unknown for a thinned series', mutate: replacing('thinning: thinningText(status, (t) => this.date(t)),', 'thinning: thinningText({ status: \'unknown\' }, (t) => this.date(t)),'), fails: ['page: the readouts of a series the recorder thinned'] },
  { name: 'the measured size is the file\'s', mutate: replacing('measured: measuredBytes(record),', 'measured: this.gameHistory ? measuredBytes(this.gameHistory) : null,'), fails: ['page: sizes are labelled apart'] },
  { name: 'the CSV without the gap column', mutate: replacing('\'Figures not recorded\', ...sparse.header]', '\'Figures not recorded\']'), fails: ['page: the CSV reflects the retained rows'] },
  { name: 'the CSV of the rows of the span, not the retained', mutate: replacing('const sparse = sparseColumns(this.allSnapshots,', 'const sparse = sparseColumns(this.snapshots.slice(1),'), fails: ['page: the CSV reflects the retained rows'] },
  { name: 'the CSV without the retention note', mutate: replacing('retentionNote(this.record, (t) => this.date(t)))\n      const header', '\'\')\n      const header'), fails: ['page: the CSV reflects the retained rows'] },
  { name: 'the panel without its summary', change: (text) => text.replace(/ data-summary="[^"]*"/, ''), fails: ['page: the section\'s summary'] },
  { name: 'the summary with a figure', change: (text) => text.replace('How many samples', 'Up to 2000 samples'), fails: ['page: the section\'s summary'] },
  { name: 'the statement that thinned samples cannot be restored hidden until a change', change: (text) => text.replace('<div class="caption text--secondary mt-2" data-retention-limits>', '<div v-if="retentionPick" class="caption text--secondary mt-2" data-retention-limits>'), fails: ['page: a profile change applies only to samples that are observed or kept'] },
  { name: 'the predicted size shown as measured', change: (text) => text.replace('<span class="history-retention__label">Size, predicted</span>', '<span class="history-retention__label">Size, measured</span>').replace('predicted from the average size of its samples', 'measured from the average size of its samples'), fails: ['page: sizes are labelled apart'] },
  { name: 'the predicted columns not labelled', change: (text) => text.replace('<th>Size if thinned now (predicted)</th><th>Size at the cap (predicted)</th>', '<th>Size if thinned now</th><th>Size at the cap</th>'), fails: ['page: sizes are labelled apart'] },
  { name: 'the unit of the measured size left unexplained', change: (text) => text.replace(' Measured as compact JSON; the file on disk is larger by its indentation.', ''), fails: ['page: sizes are labelled apart'] },
  { name: 'the profile in force not marked', change: (text) => text.replace('<template v-if="option.active"> (in force)</template>', ''), fails: ['page: the confirmed profile is kept across a restart', 'page: each profile\'s row says'] },
  { name: 'the profile in force can be chosen again', change: (text) => text.replace(':disabled="option.active" :data-retention', ':data-retention'), fails: ['page: the confirmed profile is kept across a restart'] },
  { name: 'a series above the cap not said to be thinned later', change: (text) => text.replace('<template v-if="retentionView.over">. This series is above that, and is thinned when the recorder next saves it</template>', ''), fails: ['page: the profile reads as it is chosen'] },
  { name: 'the gaps shown as one figure', change: (text) => text.replace('largest {{ duration(retentionView.stats.gaps.largest) }}, typical {{ duration(retentionView.stats.gaps.typical) }}', 'largest {{ duration(retentionView.stats.gaps.largest) }}'), fails: ['page: the readouts give the sample count', 'page: an empty history'] },
  { name: 'an unknown size shown as 0', change: (text) => text.replace('About {{ size(retentionView.current.bytesAtCap) }}', 'About {{ size(retentionView.current.bytesAtCap || 0) }}'), fails: ['page: an empty history'] },
  { name: 'the confirmation counts the stored samples as the next save\'s', mutate: replacing('const held = seriesOverCap(this.gameHistory, picked.cap)', 'const base = seriesOverCap(this.gameHistory, picked.cap)\n      const held = { ...base, next: { thins: base.over, dropped: base.dropped } }'), fails: ['page: the confirmation counts what the next save would discard'] },
  { name: 'the mineral CSV without the retention note', mutate: replacing(', retention: retentionNote(this.record, (t) => this.date(t)) })', ' })'), fails: ['page: the mineral CSV of a thinned history'] },
  { name: 'the confirmation leaves out the samples an observation replaces', mutate: replacing('const replaced = held.next.replaced ? ', 'const replaced = false ? '), fails: ['page: the confirmation counts the sample an unchanged observation removes'] },
  { name: 'the confirmation gives the whole discard as the allowance', mutate: replacing('count(held.next.replaced, 0)} to what thinning', 'count(held.next.dropped, 0)} to what thinning'), fails: ['page: the confirmation counts the sample an unchanged observation removes', 'page: the confirmation words the allowance'] },
  { name: 'the allowance worded as the samples a save removes', mutate: replacing(' to what thinning alone would discard.', ' of the samples counted above can be those.'), fails: ['page: the confirmation counts the sample an unchanged observation removes', 'page: the confirmation words the allowance'] },
  { name: 'a smaller event cap waits only when the shown branch would lose events', mutate: replacing('} else if (cap < this.eventCap) {\n        this.eventCapPick = cap', '} else if (this.eventRecord.file && Object.values(this.eventRecord.file.races).some((record) => capRecord(record, cap).dropped)) {\n        this.eventCapPick = cap'), fails: ['page: a smaller cap on the event archive waits'] },
  { name: 'the event cap confirmation leaves out that the cap applies to every campaign', mutate: replacing('The cap applies to every campaign, race and branch of this installation, and takes effect at the next capture of each.', 'The cap applies to this branch.'), fails: ['page: a smaller cap on the event archive waits'] },
  { name: 'the objects of the shown race are taken from the first race of the file', mutate: replacing('const race = file ? file.races[this.RaceID] || null : null\n        const records = race ? Object.values(race.kinds) : []\n        const objects = race ? raceObservations(race) : null', 'const race = file ? Object.values(file.races)[0] || null : null\n        const records = race ? Object.values(race.kinds) : []\n        const objects = race ? raceObservations(race) : null'), fails: ['page: the Retention panel states the observation record of the shown race'] },
  { name: 'the measured size of the observation record is that of the whole file', mutate: replacing('measured: race ? measuredBytes(race) : null, predicted: race ? observationEstimate', 'measured: race ? measuredBytes(file) : null, predicted: race ? observationEstimate'), fails: ['page: the Retention panel states the observation record of the shown race'] },
  { name: 'the size predicted for the observation record allows for the captures held only', mutate: replacing('captures: CAPTURES_KEPT * records.length }) : null', 'captures: records.length }) : null'), fails: ['page: the Retention panel states the observation record of the shown race'] },
  { name: 'the captures held and the captures a full list holds said each in the other\'s place', mutate: (text) => replacing(unhashed('#{this.count(budget.captures, 0)} #{budget.captures === 1 ? \'capture\' : \'captures\'} kept'), unhashed('#{this.count(CAPTURES_KEPT, 0)} captures kept'))(replacing(unhashed('predicted once #{this.count(CAPTURES_KEPT, 0)} captures are held'), unhashed('predicted once #{this.count(budget.captures, 0)} captures are held'))(text)), fails: ['page: the Retention panel states the observation record of the shown race', 'page: the Retention panel states the observation record of a race that does not observe'] },
  { name: 'a race that is not a player is described as one that observes', mutate: replacing('if (!budget.player) {\n        return \'Not kept: the observation record is for player races only.\'', 'if (false) {\n        return \'Not kept: the observation record is for player races only.\''), fails: ['page: the Retention panel says the observation record is for player races only'] },
  { name: 'a race that does not observe is described as one that does', mutate: replacing('const state = budget.kinds.length ? ', 'const state = true ? '), fails: ['page: the Retention panel states the observation record of a race that does not observe'] },
  { name: 'a file this version cannot read is shown as an empty record', mutate: replacing('return problem ? { file: null, error: `the observation record', 'return false ? { file: null, error: `the observation record'), fails: ['page: the Retention panel names an observation file this version cannot read'] },
  { name: 'one object is counted as objects', mutate: replacing('budget.objects === 1 ? \'object\' : \'objects\'', '\'objects\''), fails: ['page: the Retention panel counts one object and one capture in the singular'] },
  { name: 'a branch with no observation record is shown as holding none counted as 0', mutate: replacing('const kept = budget.objects === null ?', 'const kept = false ?'), fails: ['page: the Retention panel states the observation record of a branch that holds none'] },
  { name: 'a failed capture is not counted in the observation line', mutate: replacing('failures: race ? records.reduce((sum, record) => sum + (record.failures ? record.failures.length : 0), 0) : null', 'failures: null'), fails: ['page: the Retention panel says how many captures failed'] },
  { name: 'the observation file opened for a race that never chose', mutate: replacing(' || !observationEverChosen(campaignStorage(this.config).settings.store, this.resolved.campaignId, this.RaceID)', ''), fails: ['page: the Retention panel opens no observation file'] },
  { name: 'the observation file opened for a race that is not a player', mutate: replacing('if ((this.record && this.record.npr) || ', 'if ('), fails: ['page: the Retention panel says the observation record is for player races only'] },
  { name: 'the object count and the capture count of the observation line taken from each other', mutate: replacing('this.count(budget.objects, 0)', 'this.count(budget.captures, 0)'), fails: ['page: the Retention panel states the observation record of the shown race'] },
  { name: 'the object count of the observation line shown negative', mutate: replacing('this.count(budget.objects, 0)', '-this.count(budget.objects, 0)'), fails: ['page: the Retention panel states the observation record of the shown race'] },
  { name: 'the object count of the observation line shown with a decimal prefix', mutate: replacing('this.count(budget.objects, 0)', '(\'1.\' + this.count(budget.objects, 0))'), fails: ['page: the Retention panel states the observation record of the shown race'] },
]

// A rewrite of the observation line that says the same with other words or in another order: no check of the Retention panel may fail by it. The checks read the figures by the unit they stand before and the size by the word of its clause.
const PAGE_BENIGN = [
  { name: 'the predicted size introduced by other words', from: 'predicted once ', to: 'predicted when ', watch: ['page: the Retention panel'] },
  { name: 'the predicted clause put before the measured one', from: '#{state}; #{kept}; #{measured}#{predicted}. Only', to: '#{state}; #{kept}#{predicted}; #{measured}. Only', watch: ['page: the Retention panel'] },
  { name: 'the objects and captures kept put after the predicted clause', from: '#{state}; #{kept}; #{measured}#{predicted}. Only', to: '#{state}#{predicted}; #{kept}; #{measured}. Only', watch: ['page: the Retention panel'] },
]

// A mutant's text is written with `#{` where the module has a template placeholder, so no quoted string here holds one.
const unhashed = (text) => text.replace(/#\{/g, '$' + '{')

// The text of the module a mutation changes, by the name the loader knows it by, with the change made: the others are read from the folder, so no copy of it is made.
const mutatedSources = (file, change, replacement) => {
  const from = unhashed(change)
  const to = unhashed(replacement)
  const source = fs.readFileSync(path.join(utilitiesDirectory, file), 'utf8').replace(/\r\n/g, '\n')

  if (source.split(from).length !== 2) {
    throw new Error(`The mutation must apply exactly once to ${file}: ${from}`)
  }

  return { [file.replace(/\.js$/, '')]: source.replace(from, () => to) }
}

// The text of each file of the utilities, read once for all the loads of the process: the folder does not change while the checks run, and a mutant's own text is given as `sources`.
const texts = new Map()

const loadModules = async (sources = {}) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory: utilitiesDirectory, sources, texts })

  return { history: loaded.history, backup: loaded['history-backup'], campaign: loaded.campaign, attach: loaded['campaign-attach'], owner: loaded['recording-owner'], observations: loaded.observations }
}

let failures = 0
let total = 0

const show = (name, result, detail = '') => {
  const ok = result === true

  total++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const runChecks = async (list) => {
  const results = []

  for (const { group, name, run } of list) {
    try {
      await run()
      results.push([`${group}: ${name}`, true])
    } catch (error) {
      results.push([`${group}: ${name}`, String((error && error.stack) || error).split('\n').slice(0, 7).join('\n         ')])
    }
  }

  return results
}

const RESULT = 'RESULT '
const MUTANTS = [...UTILITY_MUTATIONS.map((mutation) => ({ ...mutation, page: false })), ...PAGE_MUTATIONS.map((mutation) => ({ ...mutation, page: true })), ...PAGE_BENIGN.map((rewrite) => ({ name: rewrite.name, mutate: replacing(unhashed(rewrite.from), unhashed(rewrite.to)), fails: rewrite.watch, page: true, benign: true }))]

// What the baseline and each mutation print, as entries a child hands to the parent: a line of text (what a check prints as it runs), or the arguments of `show`.
const baselineEntries = async (entries) => {
  const real = await loadModules()

  entries.push({ log: 'The utilities: thinning, status and figures' })

  const utilityChecks = [...suite(real), ...recorderSuite(real), ...backupSuite(real)]

  for (const [name, result] of await runChecks(utilityChecks)) {
    entries.push({ show: [name, result] })
  }

  entries.push({ log: '\nThe Retention panel of the page (its script and template, over scripts/lib/page-loader.js)' })

  for (const [name, held] of await pageSuite(real)) {
    entries.push({ show: [name, await held()] })
  }
}

const utilityEntries = async (entries, { name, file, find, replace, fails }) => {
  const began = Date.now()
  const sources = mutatedSources(file, find, replace)

  try {
    const mutant = await loadModules(sources)
    const named = [...suite(mutant), ...recorderSuite(mutant), ...backupSuite(mutant)].filter(({ group, name: checkName }) => fails.some((start) => `${group}: ${checkName}`.startsWith(start)))
    const absent = fails.filter((start) => !named.some(({ group, name: checkName }) => `${group}: ${checkName}`.startsWith(start)))
    const results = await runChecks(named)
    const missed = fails.filter((start) => !results.some(([checkName, result]) => checkName.startsWith(start) && result !== true))

    entries.push({ show: [`mutation caught: ${name}`, absent.length ? `no check begins ${absent.join('; ')}` : missed.length ? `these checks did not fail: ${missed.join('; ')}` : true, `${((Date.now() - began) / 1000).toFixed(1)} s`] })
  } catch (error) {
    entries.push({ show: [`mutation caught: ${name}`, `does not load: ${error.message}`] })
  }
}

const pageEntries = async (entries, { name, mutate, change, fails, benign = false }) => {
  const began = Date.now()

  try {
    const real = await loadModules()
    const warned = warnings.length
    const statements = await pageSuite(real, { mutate, change })
    const named = statements.filter(([statement]) => fails.some((start) => statement.startsWith(start)))
    const absent = fails.filter((start) => !named.some(([statement]) => statement.startsWith(start)))
    const failed = []

    for (const [statement, held] of named) {
      if ((await held()) !== true) {
        failed.push(statement)
      }
    }

    warnings.length = warned

    const missed = fails.filter((start) => !failed.some((statement) => statement.startsWith(start)))
    const label = benign ? 'page rewrite harmless' : 'page mutation caught'
    const verdict = absent.length ? `no statement begins ${absent.join('; ')}` : benign ? (failed.length ? `these statements failed: ${failed.join('; ')}` : true) : missed.length ? `these statements did not fail: ${missed.join('; ')}` : true

    entries.push({ show: [`${label}: ${name}`, verdict, `${failed.length} fail, ${((Date.now() - began) / 1000).toFixed(1)} s`] })
  } catch (error) {
    entries.push({ show: [`${benign ? 'page rewrite harmless' : 'page mutation caught'}: ${name}`, `does not load: ${error.message}`] })
  }
}

// A child runs the baseline (`--baseline`) or some mutations in turn (`--mutants=<i>,<i>`) in a process of its own, so no chunk shares the modules, the declared views or the Vue warnings of another, and prints its entries as JSON on its last line: those of the baseline, or the list of the entries of each mutation.
const childMain = async () => {
  const given = process.argv.find((argument) => argument.startsWith('--mutants='))
  const entries = []

  if (given) {
    for (const index of given.slice('--mutants='.length).split(',')) {
      const own = []
      const mutation = MUTANTS[Number(index)]

      console.log = (...parts) => own.push({ log: format(...parts) })
      await (mutation.page ? pageEntries : utilityEntries)(own, mutation)
      entries.push(own)
    }
  } else {
    console.log = (...parts) => entries.push({ log: format(...parts) })
    await baselineEntries(entries)
  }

  process.stdout.write(`${RESULT}${JSON.stringify(entries)}\n`, () => process.exit(0))
}

const main = async () => {
  if (process.argv.includes('--baseline') || process.argv.some((argument) => argument.startsWith('--mutants='))) {
    return childMain()
  }

  const mutating = !process.argv.includes('--no-mutations')
  const chunks = mutating ? chunksOf(MUTANTS.length) : []
  const items = [['--baseline'], ...chunks.map((list) => [`--mutants=${list.join(',')}`])]
  const outcomes = await inParallel(items, async (args) => lastJson(await runChild(__filename, args), RESULT))
  const replay = (entries) => entries.forEach((entry) => (entry.log !== undefined ? console.log(entry.log) : show(...entry.show)))

  if (outcomes[0] instanceof Error) {
    throw outcomes[0]
  }

  replay(outcomes[0])

  if (mutating) {
    console.log('\nMutations: each must fail the checks it names')

    spread(chunks, outcomes.slice(1)).forEach((outcome, index) => (outcome instanceof Error ? show(`${MUTANTS[index].page ? 'page mutation' : 'mutation'} caught: ${MUTANTS[index].name}`, `does not run: ${outcome.message}`) : replay(outcome)))
  }

  console.log(`\n${total - failures} of ${total} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
