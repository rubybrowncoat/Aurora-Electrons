/* eslint-disable no-template-curly-in-string */
/*
  Checks the observed stock rates and cautious depletion estimates of the Empire History page (src/renderer/utilities/stock-rates.js, src/renderer/components/history/StockRates.vue and its mount in src/renderer/pages/history.vue).

  bun scripts/check-stock-rates.js [--no-mutations]

  The utility is run on synthetic observations worked by hand: the rate is the net change between the first and the last recorded observation of the window over the game time between them (a game year is 365 days), so unevenly spaced observations give the rate of the time that passed and never of the number of observations; observations at one game time count once, so no rate divides by a time of 0; a stock that was not recorded is no observation and never 0; a flat or rising series, a single observation, a baseline of 0, a stock already at 0, too few observations, a step far larger than the other changes and a decline too slow to end within the horizon each have their own kind and none of them has a depletion date; a depletion date is an estimate under a registered rule that names the window and the standing assumptions and never says the stock will run out; the window, the first and last observation, the sampling gaps, the assumptions and the retention note reach the notes, the CSV and the copied text, with the rule, status and versions of every figure and an empty cell for what is not known.

  The panel's script is run as a pseudo instance over scripts/lib/page-loader.js (the window, the stock, the colony and the scope chosen, the colony series of the shown branch, the reasons a colony series is unavailable) and its template and the history page's mount are read as text.

  The recorded passive campaign (artifacts/passive-campaign-20261013, git-ignored, read-only: 150 saves of a stock game 5 days apart) gives real stocks: the snapshots of race 1 (a player race whose Gallicite is 0 t throughout) and race 2 (an NPR whose stocks all move) are taken with the app's own `takeSnapshot`, the stock rates are compared with rates worked from the unrounded sums of the colony stockpiles read straight from each save, and the colony series of race 2's most populous colony is built with the app's own reads and compared with that colony's raw rows. The campaign checks are skipped when the folder is not there.

  Each mutation of the utility, the panel or the page must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const v8 = require('v8')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { jobs } = require('./lib/check-pool')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilityFile = path.join(root, 'src', 'renderer', 'utilities', 'stock-rates.js')
const componentFile = path.join(root, 'src', 'renderer', 'components', 'history', 'StockRates.vue')
const pageFile = path.join(root, 'src', 'renderer', 'pages', 'history.vue')
const PASSIVE = path.join(root, 'artifacts', 'passive-campaign-20261013')
const CAMPAIGN_GAME = 139
const CAMPAIGN_RACES = [1, 2]
const NAMES = ['stock-rates', 'history', 'colony-series', 'provenance', 'minerals']
const YEAR = 31536000
const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const ORACLE_COLUMNS = ['FuelStockpile', 'MaintenanceStockpile', ...MINERAL_NAMES]
const ORACLE_KEYS = ['fuel', 'msp', ...MINERAL_NAMES]

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The packages the utilities import. The stores are never opened here, so electron-store only has to exist; dayjs is the real one.
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
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

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

const near = (actual, expected, tolerance = 1e-9) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance

const nearAll = (actual, expected, tolerance = 1e-9) => actual.length === expected.length && actual.every((value, index) => near(value, expected[index], tolerance)) ? true : `${short(actual)} != ${short(expected)}`

// Whether every number held anywhere in a value is finite.
const finiteAll = (value) => (typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(finiteAll) : value !== null && typeof value === 'object' ? Object.values(value).every(finiteAll) : true)

const at = (years) => Math.round(years * YEAR)

const DATE = (seconds) => `D${seconds}`

const FIXED = (value, decimals = 0) => (value === null || value === undefined ? '—' : value.toFixed(decimals))

// A parser of the CSV text: rows of cells, a cell in quotes keeping its commas, newlines and doubled quotes.
const parseCsv = (text) => {
  const rows = []
  let row = []
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
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }

  row.push(cell)
  rows.push(row)

  return rows
}

const tableOf = (text) => {
  const [header, ...rows] = parseCsv(text)

  return { header, rows: rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]]))) }
}

// ---------- the series worked by hand ----------

// Observations of the empire's fuel at game times given in years: [years, fuel] (null: the snapshot does not hold the stock).
const snapshotsOf = (points) => points.map(([years, fuel]) => ({ t: at(years), fuel }))

const SCOPE = { kind: 'empire', name: 'Test race', raceName: 'Test race', RaceID: 2, colonyId: null, campaignId: 'c1', branchId: 'b1', GameID: 7 }

const analyse = (m, points, over = {}) => {
  const { stock: key = 'fuel', ...rest } = over
  const stock = m.rates.stockOf(key)
  const snapshots = snapshotsOf(points)

  return m.rates.analyseStock({ stock, scope: SCOPE, observations: m.rates.empireObservations(snapshots, stock), latest: m.rates.latestOf(snapshots), years: 0, ...rest })
}

const DECLINING = [[0, 1000], [1, 950], [2, 850], [4, 650], [5, 600]]

const NICE = { date: DATE, format: FIXED }

const parts = (items) => items.map(([name, test]) => [name, test])

const pure = (ctx) => {
  const { m } = ctx
  const R = m.rates
  const run = (points, over) => analyse(m, points, over)

  return parts([
    ['irregular: observations spaced unevenly give the rate of the game time that passed', () => {
      const a = run([[0, 1000], [0.5, 900], [2, 700], [2.25, 650], [5, 400]])
      const intervals = nearAll(a.intervals.map((interval) => interval.rate.value), [-200, -400 / 3, -200, -250 / 2.75], 1e-6)

      return near(a.rate.value, -120) && intervals === true && nearAll(a.rows.slice(1).map((row) => row.rate.value), [-200, -400 / 3, -200, -250 / 2.75], 1e-6) === true && a.kind === 'declining' && a.basis.samples === 5 && finiteAll(a) ? true : short([a.rate.value, intervals, a.kind])
    }],
    ['elapsed: the rate divides by the game time between the first and the last observation, in game years', () => {
      const a = run([[0, 100], [0.2, 90]])
      const b = run([[0, 100], [0.2, 90], [1, 50]])

      return near(a.rate.value, -50) && near(b.rate.value, -50) && a.rows[1].seconds === 6307200 && near(b.intervals[1].rate.value, -40 / 0.8) ? true : short([a.rate.value, b.rate.value, a.rows[1].seconds])
    }],
    ['year: a game year is 365 days of 86,400 s', () => {
      const a = run([[0, 100], [1, 90]])

      return R.YEAR_SECONDS === 365 * 86400 && a.rows[1].seconds === 365 * 86400 && near(a.rate.value, -10) ? true : short([R.YEAR_SECONDS, a.rows[1].seconds, a.rate.value])
    }],
    ['duplicates: observations at one game time count once, so no rate divides by a time of 0', () => {
      const later = run([[0, 1000], [1, 900], [1, 880], [2, 700], [3, 600]])
      const unrecordedLater = run([[0, 1000], [1, 900], [1, null], [2, 800], [3, 700]])
      const unrecordedFirst = run([[0, 1000], [1, null], [1, 900], [2, 800], [3, 700]])
      const same = run([[3, 100], [3, 90], [3, 80]])
      const lead = run([[0, 100], [0, 100], [0, 100], [1, 90], [2, 80]])
      const problems = []

      if (!(later.rows.length === 4 && later.rows[1].value === 880 && later.basis.duplicates === 1 && near(later.rate.value, -400 / 3) && later.notes.some((note) => /1 at a game time already counted left out/.test(note)))) {
        problems.push(`later duplicate ${short([later.rows.map((row) => row.value), later.basis])}`)
      }

      if (!(unrecordedLater.rows[1].value === 900 && unrecordedFirst.rows[1].value === 900 && unrecordedLater.basis.unknown === 0)) {
        problems.push(`unrecorded duplicate ${short([unrecordedLater.rows.map((row) => row.value), unrecordedFirst.rows.map((row) => row.value)])}`)
      }

      if (!(same.kind === 'single' && same.rate.value === null && same.relative.value === null && same.depletion.value === null && same.basis.duplicates === 2 && finiteAll(same) && same.rows.length === 1)) {
        problems.push(`one game time ${short([same.kind, same.rate, same.basis])}`)
      }

      if (!(lead.rows.length === 3 && near(lead.rate.value, -10) && lead.intervals.every((interval) => interval.seconds > 0) && finiteAll(lead))) {
        problems.push(`leading duplicates ${short([lead.rows.length, lead.rate.value])}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['order: observations given out of order are read in game-time order', () => {
      const sorted = run([[0, 1000], [2, 700], [5, 400]])
      const shuffled = run([[5, 400], [0, 1000], [2, 700]])

      return equal(sorted.rows.map((row) => [row.t, row.value]), shuffled.rows.map((row) => [row.t, row.value])) && near(shuffled.rate.value, -120) && shuffled.first.value === 1000 && shuffled.last.value === 400 ? true : short([shuffled.rows.map((row) => row.t), shuffled.rate.value])
    }],
    ['window: the window counts back from the record\'s latest snapshot, its start included, and is every observation at 0', () => {
      const points = [[0, 1000], [1, 900], [2, 800], [3, 700], [4, 600], [5, 500]]
      const two = run(points, { years: 2 })
      const one = run(points, { years: 1 })
      const all = run(points, { years: 0 })
      const anchored = run(points, { years: 2, latest: at(7) })
      const earlier = run(points, { years: 0, latest: at(3) })
      const problems = []

      if (!(equal(two.rows.map((row) => row.t), [at(3), at(4), at(5)]) && two.window.from === at(3) && two.window.latest === at(5) && near(two.rate.value, -100))) {
        problems.push(`2 y ${short([two.rows.map((row) => row.t), two.window])}`)
      }

      if (!equal(one.rows.map((row) => row.t), [at(4), at(5)])) {
        problems.push(`1 y ${short(one.rows.map((row) => row.t))}`)
      }

      if (!(all.rows.length === 6 && all.window.from === null && /every retained snapshot/.test(all.window.text))) {
        problems.push(`all ${short([all.rows.length, all.window])}`)
      }

      if (!(anchored.kind === 'single' && anchored.rows.length === 1 && anchored.rows[0].t === at(5) && anchored.window.from === at(5))) {
        problems.push(`anchored at the record's latest ${short([anchored.kind, anchored.rows.map((row) => row.t)])}`)
      }

      if (!(earlier.rows.length === 4 && earlier.last.t === at(3))) {
        problems.push(`observations after the latest ${short(earlier.rows.map((row) => row.t))}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['flat: a flat or rising series has no finite depletion date', () => {
      const flat = run([[0, 500], [1, 500], [2, 500]])
      const rising = run([[0, 100], [1, 200], [3, 300]])
      const problems = []

      for (const [label, a] of [['flat', flat], ['rising', rising]]) {
        if (!(a.kind === 'nondeclining' && a.depletion.value === null && a.depletion.status === 'unavailable' && a.depletionAt === null && a.earliest.value === null && a.earliestAt === null && /no finite depletion date/.test(a.reason) && finiteAll(a))) {
          problems.push(`${label} ${short([a.kind, a.depletion.value, a.earliest.value, a.reason])}`)
        }
      }

      return problems.length === 0 && flat.rate.value === 0 && rising.rate.value > 0 ? true : problems.join('; ') || short([flat.rate.value, rising.rate.value])
    }],
    ['declining: a steady decline has the estimate and a cautious earlier bound, from the average and the fastest interval', () => {
      const a = run(DECLINING)

      return a.kind === 'declining' && near(a.rate.value, -80) && near(a.relative.value, -8) && near(a.depletion.value, 7.5) && near(a.earliest.value, 6) && a.depletionAt === at(5) + 7.5 * YEAR && a.earliestAt === at(5) + 6 * YEAR && a.earliest.value < a.depletion.value && a.notes.some((note) => /^Cautious bound: /.test(note)) ? true : short([a.kind, a.rate.value, a.relative.value, a.depletion.value, a.earliest.value, a.depletionAt])
    }],
    ['zerobase: a baseline of 0 has no relative rate and no depletion date, and no infinity', () => {
      const a = run([[0, 0], [1, 10], [2, 20]])
      const b = run([[0, 0], [1, 0], [2, 0]])

      return a.kind === 'zero-baseline' && a.relative.value === null && a.relative.status === 'unavailable' && near(a.rate.value, 10) && a.depletion.value === null && b.kind === 'zero-baseline' && b.rate.value === 0 && b.relative.value === null && finiteAll(a) && finiteAll(b) && /0 L at the first observation/.test(a.reason) ? true : short([a.kind, a.relative, b.kind, b.rate.value, a.reason])
    }],
    ['single: one observation has an unknown rate and an unknown depletion', () => {
      const a = run([[0, 100]])
      const unrecordedAfter = run([[0, 100], [1, null], [2, null]])

      return a.kind === 'single' && a.rate.value === null && a.rate.status === 'unavailable' && a.relative.value === null && a.depletion.value === null && a.first.t === a.last.t && /rate needs two observations/.test(a.reason) && unrecordedAfter.kind === 'single' && unrecordedAfter.basis.unknown === 2 && finiteAll(a) ? true : short([a.kind, a.rate, a.reason, unrecordedAfter.kind])
    }],
    ['none: a series with no recorded observation is an explicit unknown', () => {
      const none = run([], { latest: null })
      const unrecorded = run([[0, null], [1, null]])

      return none.kind === 'unknown' && none.rate.value === null && none.first === null && none.last === null && none.window.latest === null && /no snapshot is recorded/.test(none.notes[0]) && unrecorded.kind === 'unknown' && unrecorded.basis.unknown === 2 && unrecorded.rate.value === null && unrecorded.rows.every((row) => row.value === null) && finiteAll(none) && finiteAll(unrecorded) ? true : short([none.kind, none.notes[0], unrecorded.kind])
    }],
    ['empty: a stock already at 0 is observed, not estimated', () => {
      const a = run([[0, 100], [1, 50], [2, 0]])

      return a.kind === 'empty' && near(a.rate.value, -50) && a.depletion.value === null && a.earliest.value === null && /observed, not estimated/.test(a.reason) ? true : short([a.kind, a.rate.value, a.reason])
    }],
    ['insufficient: two observations give a rate and no depletion date', () => {
      const a = run([[0, 100], [1, 50]])
      const three = run([[0, 100], [1, 50], [2, 20]])

      return a.kind === 'insufficient' && near(a.rate.value, -50) && a.depletion.value === null && a.depletionAt === null && three.kind === 'declining' && R.MIN_SAMPLES === 3 ? true : short([a.kind, a.rate.value, three.kind])
    }],
    ['step: a transfer or spending is told from a steady decline, by its size and its rate together', () => {
      const cases = [
        ['spending', [[0, 1000], [1, 990], [2, 980], [3, 970], [4, 300], [5, 290]], (a) => a.kind === 'spike' && a.basis.steps === 1 && a.rows[4].spike === true && a.rows.filter((row) => row.spike).length === 1 && a.depletion.value === null && a.earliest.value === null && a.depletionAt === null && a.rate.value < 0 && /transfer or spending/.test(a.reason)],
        ['transfer in', [[0, 100], [1, 95], [2, 90], [3, 1000], [4, 990], [5, 980]], (a) => a.kind === 'nondeclining' && a.basis.steps === 1 && a.rows[3].spike === true && a.rows.filter((row) => row.spike).length === 1],
        ['gradual', [[0, 100], [1, 60], [2, 30], [3, 10], [4, 5]], (a) => a.kind === 'declining' && a.basis.steps === 0],
        ['quickening', [[0, 1000], [1, 900], [2, 800], [3, 700], [4, 600], [5, 500], [6, 400], [7, 100]], (a) => a.kind === 'declining' && a.basis.steps === 0],
        ['long gap', [[0, 1000], [1, 900], [2, 800], [10, 100]], (a) => a.kind === 'declining' && a.basis.steps === 0 && near(a.rate.value, -90)],
        ['small beside a large stock', [[0, 100000], [1, 99990], [2, 99980], [3, 99900], [4, 99890]], (a) => a.kind === 'distant' && a.basis.steps === 0],
        ['just under half', [[0, 1000], [1, 990], [2, 980], [3, 970], [4, 500], [5, 490]], (a) => a.kind === 'declining' && a.basis.steps === 0],
        ['two steps', [[0, 1000], [1, 990], [2, 980], [3, 300], [4, 290], [5, 100]], (a) => a.kind === 'spike' && a.basis.steps === 2 && a.rows[3].spike === true && a.rows[5].spike === true],
        ['one interval', [[0, 1000], [1, 100]], (a) => a.kind === 'insufficient' && a.basis.steps === 0],
      ]
      const bad = cases.filter(([, points, held]) => !held(run(points))).map(([name, points]) => `${name} ${short(((a) => [a.kind, a.basis.steps, a.rate.value])(run(points)))}`)

      return bad.length === 0 ? true : bad.join('; ')
    }],
    ['distant: a decline too slow to end within the horizon has no date', () => {
      const a = run([[0, 1000000], [1, 999990], [2, 999980]])
      const inside = run([[0, 1000000], [1, 990000], [2, 980000]])

      return a.kind === 'distant' && a.depletion.value === null && a.depletionAt === null && near(a.rate.value, -10) && /more than 1000 game years/.test(a.reason) && inside.kind === 'declining' && inside.depletion.value < 1000 ? true : short([a.kind, a.reason, inside.kind, inside.depletion.value])
    }],
    ['unrecorded: a stock that was not recorded is left out, never 0', () => {
      const a = run([[0, 1000], [1, null], [2, 800], [3, 700]])

      return a.basis.samples === 3 && a.basis.unknown === 1 && a.rows.length === 4 && a.rows[1].value === null && a.rows[1].change === null && a.rows[1].rate === null && near(a.rate.value, -100) && near(a.rows[2].rate.value, -100) && a.rows[2].seconds === 2 * YEAR && a.kind === 'declining' && near(a.depletion.value, 7) && a.rows[1].result.status === 'unavailable' && a.rows[1].result.inputs.missing.length === 1 && a.first.value === 1000 ? true : short([a.basis, a.rows.map((row) => row.value), a.rate.value])
    }],
    ['estimate: a depletion date is an estimate that names its window and assumptions and never says the stock will run out', () => {
      const a = run(DECLINING, { years: 5, ...NICE })
      const all = run(DECLINING, { years: 0, ...NICE })
      const lines = a.depletion.assumptions
      const problems = []

      if (!(a.depletion.status === 'estimated' && a.earliest.status === 'estimated' && a.rate.status === 'confirmed' && a.depletion.rule.id === 'stockRates.depletion')) {
        problems.push(`status ${short([a.depletion.status, a.earliest.status, a.rate.status])}`)
      }

      if (!lines.some((line) => /the last 5 game years before the latest snapshot/.test(line))) {
        problems.push(`window ${short(lines)}`)
      }

      if (!all.depletion.assumptions.some((line) => /every retained snapshot/.test(line))) {
        problems.push(`all-window ${short(all.depletion.assumptions)}`)
      }

      if (!lines.some((line) => /keeps changing at the average rate/.test(line)) || !lines.some((line) => /not a guarantee/.test(line)) || !lines.some((line) => /no delivery, transfer or spending/.test(line))) {
        problems.push(`standing assumptions ${short(lines)}`)
      }

      if (!(near(a.depletion.value, 7.5) && near(a.earliest.value, 6))) {
        problems.push(`values ${short([a.depletion.value, a.earliest.value])}`)
      }

      if (!/estimate/.test(a.reason) || !/not a prediction/.test(a.reason) || /will run out|guaranteed/.test([a.reason, ...a.notes].join(' '))) {
        problems.push(`wording ${a.reason}`)
      }

      if (!a.notes.some((note) => /^Assumes the stock keeps changing at the average rate/.test(note))) {
        problems.push(`notes ${short(a.notes)}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['notes: the window, the first and last observation, the sampling gaps, the assumptions and the retention note are in the notes', () => {
      const a = run(DECLINING, { years: 5, ...NICE, retention: 'RETENTION-TEXT' })
      const single = run([[2, 100]], { years: 5, ...NICE })
      const lastNote = a.notes[a.notes.length - 1]
      const problems = []

      if (!a.notes.some((note) => note.startsWith('Window: the last 5 game years before the latest snapshot (D0 to D' + at(5) + ')'))) {
        problems.push(`window ${short(a.notes[0])}`)
      }

      if (!a.notes.includes(`First observation D0: 1000 L. Last observation D${at(5)}: 600 L.`)) {
        problems.push(`first and last ${short(a.notes.slice(0, 3))}`)
      }

      if (!a.notes.some((note) => /^Sampling: 5 observations over .*; 4 gaps between observations, the largest .*, typical /.test(note))) {
        problems.push(`sampling ${short(a.notes)}`)
      }

      if (!a.notes.some((note) => /^Basis: 5 snapshots at different game times in the window, 5 with the stock recorded, 0 without/.test(note))) {
        problems.push(`basis ${short(a.notes)}`)
      }

      if (!a.notes.some((note) => /^Assumes /.test(note)) || lastNote !== 'RETENTION-TEXT') {
        problems.push(`assumptions or retention ${short(a.notes)}`)
      }

      if (!single.notes.some((note) => /^Sampling: 1 observation, so there is no gap/.test(note))) {
        problems.push(`single ${short(single.notes)}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['csv: the CSV carries the window, the first and last observation, the sampling gaps, the assumptions and the retention note, and every observation at its exact game time', () => {
      const a = run(DECLINING, { years: 5, ...NICE })
      const { header, rows } = tableOf(R.ratesCsv(a, { date: DATE, retention: 'RETENTION-TEXT' }))
      const context = rows.filter((row) => row.Record === 'context')
      const samples = rows.filter((row) => row.Record === 'sample')
      const item = (name) => context.filter((row) => row.Item === name)
      const problems = []

      if (!equal(header, R.CSV_COLUMNS)) {
        problems.push(`header ${short(header)}`)
      }

      const windowRow = item('Window')[0]

      if (!(windowRow && /last 5 game years/.test(windowRow.Note) && windowRow['Game time (s)'] === '0' && windowRow.Date === 'D0')) {
        problems.push(`window ${short(windowRow)}`)
      }

      const first = item('First observation')[0]
      const last = item('Last observation')[0]

      if (!(first && first.Value === '1000' && first['Game time (s)'] === '0' && first.Unit === 'L' && first.Status === 'confirmed' && first.Rule === 'history.stockpile')) {
        problems.push(`first ${short(first)}`)
      }

      if (!(last && last.Value === '600' && last['Game time (s)'] === String(at(5)) && last.Date === DATE(at(5)))) {
        problems.push(`last ${short(last)}`)
      }

      const gaps = item('Sampling gaps')[0]

      if (!(gaps && /^4 between observations, largest .* \(\d+ s\), typical .* \(\d+ s\)$/.test(gaps.Note))) {
        problems.push(`gaps ${short(gaps)}`)
      }

      const rate = item('Rate')[0]
      const depletion = item('Depletion estimate')[0]

      if (!(rate && rate.Value === '-80' && rate.Status === 'confirmed' && rate.Rule === 'stockRates.rate' && rate.Unit === 'L/yr')) {
        problems.push(`rate ${short(rate)}`)
      }

      if (!(depletion && depletion.Value === '7.5' && depletion.Status === 'estimated' && depletion.Rule === 'stockRates.depletion' && /keeps changing at the average rate/.test(depletion.Assumptions) && depletion['Game time (s)'] === String(Math.round(a.depletionAt)) && /not a prediction that the stock runs out/.test(depletion.Note))) {
        problems.push(`depletion ${short(depletion)}`)
      }

      if (!equal(item('Assumption').map((row) => row.Note), a.assumptions)) {
        problems.push(`assumptions ${short(item('Assumption').map((row) => row.Note))}`)
      }

      if (!equal(item('Retention').map((row) => row.Note), ['RETENTION-TEXT'])) {
        problems.push('retention')
      }

      if (!(equal(samples.map((row) => row['Game time (s)']), a.rows.map((row) => String(row.t))) && equal(samples.map((row) => row.Value), ['1000', '950', '850', '650', '600']) && samples[0]['Seconds since previous observation'] === '' && samples[1]['Seconds since previous observation'] === String(YEAR) && samples[1]['Rate per game year'] === '-50')) {
        problems.push(`samples ${short(samples.slice(0, 2))}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['csv-unknown: what is not known is an empty cell with its status, never 0, and says why', () => {
      const flat = run([[0, 500], [1, 500], [2, 500]], NICE)
      const gap = run([[0, 1000], [1, null], [2, 800], [3, 700]], NICE)
      const flatRows = tableOf(R.ratesCsv(flat, { date: DATE })).rows
      const gapRows = tableOf(R.ratesCsv(gap, { date: DATE })).rows
      const depletion = flatRows.find((row) => row.Item === 'Depletion estimate')
      const unrecorded = gapRows.filter((row) => row.Record === 'sample')[1]
      const none = tableOf(R.ratesCsv(run([], { latest: null }), { date: DATE })).rows
      const problems = []

      if (!(depletion.Value === '' && depletion.Status === 'unavailable' && depletion['Missing inputs'] !== '' && /flat or rising/.test(depletion.Note) && depletion['Game time (s)'] === '' && depletion.Date === '')) {
        problems.push(`depletion ${short(depletion)}`)
      }

      if (!(unrecorded.Value === '' && unrecorded.Status === 'unavailable' && /^not recorded: /.test(unrecorded.Note) && unrecorded['Change since previous observation'] === '' && unrecorded['Rate per game year'] === '')) {
        problems.push(`unrecorded ${short(unrecorded)}`)
      }

      if (!(none.find((row) => row.Item === 'First observation').Note === 'none in the window' && none.find((row) => row.Item === 'Rate').Value === '' && none.filter((row) => row.Record === 'sample').length === 0)) {
        problems.push('none')
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['csv-safe: a cell that starts like a formula is guarded, a number is not touched and a cell with a comma or a quote is quoted', () => {
      const hostile = { ...SCOPE, campaignId: '=1+1', raceName: 'a, "b"\nc' }
      const { rows } = tableOf(R.ratesCsv(run(DECLINING, { years: 5, ...NICE, scope: hostile }), { date: (seconds) => `-${seconds}` }))
      const campaign = rows.find((row) => row.Item === 'Campaign')
      const race = rows.find((row) => row.Item === 'Race')
      const sample = rows.find((row) => row.Record === 'sample')
      const rate = rows.find((row) => row.Item === 'Rate')

      return campaign.Note === '\'=1+1' && sample.Date === '\'-0' && rate.Value === '-80' && race.Note === 'a, "b"\nc' && race.Value === '2' ? true : short([campaign.Note, sample.Date, rate.Value, race])
    }],
    ['identity: the CSV and the copied text name the campaign, the branch, the game, the race and its ID and the colony and its PopulationID, so two branches never export the same file', () => {
      const colonyScope = { kind: 'colony', name: 'Alpha', raceName: 'Test race', RaceID: 2, colonyId: 41, campaignId: 'c1', branchId: 'b1', GameID: 7 }
      const problems = []
      const files = (scope) => {
        const a = run(DECLINING, { years: 5, ...NICE, scope })
        const csv = R.ratesCsv(a, { date: DATE })
        const rows = tableOf(csv).rows
        const note = (item) => (rows.find((row) => row.Item === item) || {}).Note
        const value = (item) => (rows.find((row) => row.Item === item) || {}).Value

        return { csv, text: R.ratesText(a, NICE), campaign: note('Campaign'), branch: note('Branch'), game: note('Game'), race: note('Race'), raceId: value('Race'), colony: note('Colony'), colonyId: value('Colony'), colonyUnit: (rows.find((row) => row.Item === 'Colony') || {}).Unit }
      }
      const one = files(SCOPE)
      const two = files({ ...SCOPE, branchId: 'b2' })
      const other = files({ ...SCOPE, campaignId: 'c2' })
      const raceTwo = files({ ...SCOPE, RaceID: 3 })
      const colony = files(colonyScope)
      const anotherColony = files({ ...colonyScope, colonyId: 42 })

      if (!(one.campaign === 'c1' && one.branch === 'b1' && one.game === '7' && one.race === 'Test race' && one.raceId === '2' && one.colony === undefined)) problems.push(`empire csv ${short(one)}`)
      if (!(colony.colony === 'Alpha' && colony.colonyId === '41' && colony.colonyUnit === 'PopulationID' && colony.raceId === '2')) problems.push(`colony csv ${short([colony.colony, colony.colonyId, colony.colonyUnit])}`)
      if (!(one.csv !== two.csv && two.branch === 'b2' && one.csv !== other.csv && other.campaign === 'c2' && one.csv !== raceTwo.csv && raceTwo.raceId === '3' && colony.csv !== anotherColony.csv && anotherColony.colonyId === '42')) problems.push('two sources export the same CSV')
      if (!(one.text.includes('Source: campaign c1, branch b1, game 7, race Test race (RaceID 2).') && two.text.includes('branch b2,') && one.text !== two.text && one.text !== other.text && one.text !== raceTwo.text)) problems.push(`empire text ${short(one.text.split('\n').slice(0, 3))}`)
      if (!(colony.text.includes('colony Alpha (PopulationID 41)') && colony.text !== anotherColony.text && colony.text.split('\n')[0].startsWith('Colony Alpha: '))) problems.push(`colony text ${short(colony.text.split('\n').slice(0, 3))}`)

      const unsettled = files({ ...SCOPE, campaignId: null, branchId: null, GameID: null, RaceID: null })

      if (!(unsettled.campaign === 'not settled' && unsettled.branch === 'not settled' && unsettled.game === 'not settled' && unsettled.raceId === '' && unsettled.text.includes('campaign not settled, branch not settled, game not settled, race Test race (RaceID not settled)'))) problems.push(`unsettled ${short([unsettled.campaign, unsettled.raceId])}`)

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['volatile: large opposing changes leave no steady baseline, so a net decline gets no depletion date, whether the window has three observations or more', () => {
      const cases = [
        ['paired jumps', [[0, 1000], [1, 100], [2, 900]]],
        ['rise then fall', [[0, 100], [1, 1000], [2, 90]]],
        ['alternating', [[0, 1000], [1, 100], [2, 900], [3, 80], [4, 800]]],
        ['alternating, uneven', [[0, 1000], [0.4, 120], [2.5, 950], [3, 90], [7, 700]]],
        ['with quiet intervals between', [[0, 1000], [1, 990], [2, 100], [3, 95], [4, 900], [5, 890]]],
      ]
      const problems = []

      for (const [name, points] of cases) {
        const a = run(points, NICE)

        if (!(a.kind === 'volatile' && a.rate.value < 0 && a.depletion.value === null && a.depletion.status === 'unavailable' && a.depletionAt === null && a.earliest.value === null && a.earliestAt === null && /large rise and a large fall/.test(a.reason) && /no depletion date/.test(a.reason) && finiteAll(a) && !a.notes.some((note) => /^Cautious bound/.test(note)))) {
          problems.push(`${name} ${short([a.kind, a.rate.value, a.depletion.value, a.earliest.value])}`)
        }
      }

      const down = run([[0, 1000], [1, 990], [2, 980], [3, 300], [4, 290]])
      const up = run([[0, 1000], [1, 700], [2, 490], [3, 343], [4, 240], [5, 700], [6, 560], [7, 448]])
      const same = run([[0, 1000], [1, 500], [2, 100]])
      const { rows } = tableOf(R.ratesCsv(run(cases[0][1], NICE), { date: DATE }))
      const kind = rows.find((row) => row.Item === 'Classification')
      const depletion = rows.find((row) => row.Item === 'Depletion estimate')

      if (!(down.kind === 'spike' && up.kind === 'declining' && up.basis.steps === 0 && same.kind === 'declining')) problems.push(`not volatile ${short([down.kind, up.kind, up.basis.steps, same.kind])}`)
      if (!(kind.Note.startsWith('volatile: ') && depletion.Value === '' && depletion.Status === 'unavailable')) problems.push(`csv ${short([kind.Note, depletion.Value])}`)
      if (!(R.KIND_TEXT.volatile && m.provenance.getRule('stockRates.depletion').note.includes('large rise and a large fall'))) problems.push('wording')

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['text: the copied text carries the notes and every observation', () => {
      const a = run([[0, 1000], [1, null], [2, 800], [3, 700]], { years: 5, ...NICE, retention: 'RETENTION-TEXT' })
      const text = R.ratesText(a, NICE)
      const lines = text.split('\n')
      const at0 = lines.indexOf('Observations:')

      const problems = []

      if (!a.notes.every((note) => lines.includes(note))) problems.push('notes missing')
      if (!lines.some((line) => line.startsWith('Window: the last 5 game years')) || !lines.some((line) => line.startsWith('First observation D0: 1000 L. Last observation D'))) problems.push('window or first and last observation missing')
      if (!(at0 > 0 && lines.slice(at0 + 1).length === 4 && lines[at0 + 1].startsWith('D0 (0 s)\t1000 L'))) problems.push(`observations ${short(lines.slice(at0))}`)
      if (!lines[at0 + 2].includes('— L (not recorded: ')) problems.push(`unrecorded ${short(lines[at0 + 2])}`)
      if (!(lines.includes('RETENTION-TEXT') && /^Empire: Fuel \(L\)/.test(lines[0]) && !/NaN|\[object|\bnull\b|Infinity/.test(text))) problems.push(`heading ${short(lines[0])}`)

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['chartpoints: the chart draws the observed stock with a break at what was not recorded and the average rate from the first to the last observation', () => {
      const gap = run([[0, 1000], [1, null], [2, 800], [3, 700]])
      const points = R.chartPoints(gap)
      const single = R.chartPoints(run([[0, 100]]))
      const decline = R.chartPoints(run(DECLINING))

      return equal(points.observed.map((point) => point.value), [1000, null, 800, 700]) && equal(points.observed.map((point) => point.t), [0, at(1), at(2), at(3)]) && equal(points.average, [{ t: 0, value: 1000 }, { t: at(3), value: 700 }]) && single.average === null && equal(decline.average, [{ t: 0, value: 1000 }, { t: at(5), value: 600 }]) ? true : short([points, single.average])
    }],
    ['empire: an empire stock is read from the snapshot field, a mineral by its ID, and a missing field is unavailable', () => {
      const minerals = MINERAL_NAMES.map((_name, index) => 101 + index)
      const snapshots = [{ t: 0, fuel: 1, msp: 2, wealth: 3, minerals }, { t: 1, fuel: null, wealth: 4 }]
      const problems = []

      for (const stock of R.STOCKS) {
        const [one, two] = R.empireObservations(snapshots, stock)
        const expected = stock.key === 'fuel' ? 1 : stock.key === 'msp' ? 2 : stock.key === 'wealth' ? 3 : 100 + stock.mineral

        if (one.result.value !== expected) {
          problems.push(`${stock.key} ${one.result.value} != ${expected}`)
        }

        if (stock.key === 'wealth' ? two.result.value !== 4 : two.result.value !== null || two.result.status !== 'unavailable') {
          problems.push(`${stock.key} missing ${short(two.result)}`)
        }
      }

      return R.STOCKS.length === 14 && equal(R.stocksOf('empire').map((stock) => stock.key), R.STOCKS.map((stock) => stock.key)) && problems.length === 0 ? true : problems.join('; ') || `${R.STOCKS.length} stocks`
    }],
    ['colony: a colony stock is read from its column, a state other than observed or a null is unavailable, a snapshot without the colony is no observation', () => {
      const columns = m.colony.COLONY_COLUMNS
      const values = columns.map((_name, index) => 10 + index)
      const entry = (id, state, over = null) => [id, state, ...(over || values)]
      const record = { snapshots: [{ t: 0, colonies: [entry(7, 0), entry(8, 0)] }, { t: 1, colonies: [entry(8, 0)] }, { t: 2, colonies: [entry(7, 1), entry(8, 0)] }, { t: 3, colonies: [entry(7, 2)] }, { t: 4, colonies: [entry(7, 3)] }, { t: 5, colonies: [entry(7, 4)] }, { t: 6, colonies: [entry(7, 0, values.map((value, index) => (index === 3 ? null : value)))] }, { t: 7 }] }
      const problems = []

      for (const stock of R.stocksOf('colony')) {
        const found = R.colonyObservations(record, 7, stock)

        if (found[0].result.value !== 10 + columns.indexOf(stock.colony)) {
          problems.push(`${stock.key} read ${found[0].result.value}`)
        }
      }

      const fuel = R.colonyObservations(record, 7, R.stockOf('fuel'))
      const duranium = R.colonyObservations(record, 7, R.stockOf('Duranium'))

      if (!equal(fuel.map((observation) => observation.t), [0, 2, 3, 4, 5, 6])) {
        problems.push(`times ${short(fuel.map((observation) => observation.t))}`)
      }

      for (const [index, state] of [[1, 1], [2, 2], [3, 3], [4, 4]]) {
        const result = fuel[index].result

        if (!(result.value === null && result.status === 'unavailable' && result.inputs.missing.some((line) => line.includes(m.colony.COLONY_STATE_TEXT[state])))) {
          problems.push(`state ${state} ${short(result)}`)
        }
      }

      if (!(duranium[5].result.value === null && duranium[5].result.status === 'unavailable' && fuel[5].result.value === 11)) {
        problems.push(`null ${short(duranium[5].result)}`)
      }

      const custom = R.colonyObservations({ snapshots: [{ t: 0, colonies: [[7, 0, 5, 6]] }] }, 7, R.stockOf('fuel'), ['msp', 'fuel'])

      if (custom[0].result.value !== 6) {
        problems.push(`offset ${short(custom)}`)
      }

      if (!(R.colonyObservations(record, 7, R.stockOf('wealth')).length === 0 && !R.stocksOf('colony').some((stock) => stock.key === 'wealth') && R.stocksOf('colony').length === 13 && R.colonyObservations(null, 7, R.stockOf('fuel')).length === 0)) {
        problems.push('treasury')
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['registry: the rules are registered for the 2.7 line with the verification of what they are', () => {
      const { getRule, ruleSupports } = m.provenance
      const expected = { 'stockRates.colonyStock': 'confirmed', 'stockRates.rate': 'confirmed', 'stockRates.relativeRate': 'confirmed', 'stockRates.depletion': 'estimated', 'stockRates.depletionEarliest': 'estimated' }
      const problems = Object.entries(expected).filter(([id, verification]) => {
        const rule = getRule(id)

        return !(rule && rule.verification === verification && equal(rule.versions, ['2.7.x']) && rule.note.length > 40)
      }).map(([id]) => id)
      const a = run(DECLINING)

      return problems.length === 0 && ruleSupports('stockRates.depletion', '2.7.1') === true && ruleSupports('stockRates.depletion', '2.6.4') === false && getRule('stockRates.depletion').assumptions.length === 3 && a.depletion.rule.id === 'stockRates.depletion' && a.depletion.status === 'estimated' ? true : short([problems, ruleSupports('stockRates.depletion', '2.6.4')])
    }],
    ['random: invariants hold over random series with gaps, duplicates and zeros', () => {
      let seed = 12345
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296

        return seed / 4294967296
      }
      const windows = [0, 1, 2, 5]
      const kinds = Object.keys(R.KIND_TEXT)
      const problems = []

      for (let round = 0; round < 400 && problems.length < 3; round++) {
        const mode = round % 5
        const length = mode === 0 ? Math.floor(rand() * 12) : 4 + Math.floor(rand() * 5)
        const start = Math.floor(rand() * [5000, 1e6, 1e12][Math.floor(rand() * 3)]) + 10
        const slope = rand() < 0.5 ? rand() * 10 : (rand() * start) / 6
        const stepAt = 1 + Math.floor(rand() * (length - 1))
        const spacing = 1 + Math.floor(rand() * 3)
        const high = 1000 + rand() * 1000
        const points = mode === 0 ? Array.from({ length }, () => [Math.floor(rand() * 30) / 4, rand() < 0.15 ? null : rand() < 0.1 ? 0 : Math.floor(rand() * 5000)]) : mode === 4 ? Array.from({ length }, (_value, index) => [index * spacing, index % 2 === 0 ? high - index : high * (0.05 + rand() * 0.4)]) : Array.from({ length }, (_value, index) => [index * spacing, mode === 1 ? Math.max(start - slope * index, 0) : mode === 2 ? 100 + start % 1000 : 1000 - (index >= stepAt ? 600 : 0) - rand() * 5 * index])
        const a = run(points, { years: mode === 0 ? windows[Math.floor(rand() * windows.length)] : 0, ...NICE })
        const times = a.rows.map((row) => row.t)
        const why = []

        if (mode === 2 && (a.kind !== 'nondeclining' || a.depletion.value !== null)) why.push('a flat series is not flat or rising')
        if (mode === 3 && !a.rows[stepAt].spike) why.push('a step is not found')
        if (mode === 4 && a.depletion.value !== null) why.push('opposing changes are given a date')
        if (a.first && a.last && a.basis.samples >= 2 && a.first.value === 0 && a.kind !== 'zero-baseline') why.push('a baseline of 0 is not told')

        if (!finiteAll(a)) why.push('not finite')
        if ((a.depletion.value !== null) !== (a.kind === 'declining')) why.push('depletion and kind')
        if (a.depletion.value === null ? a.depletionAt !== null : !(a.depletion.value > 0 && a.depletion.value <= 1000)) why.push('depletion range')
        if (!times.every((t, index) => index === 0 || t > times[index - 1])) why.push('rows not increasing')
        if (a.basis.snapshots !== a.rows.length || a.basis.samples + a.basis.unknown !== a.basis.snapshots) why.push('basis')
        if (!kinds.includes(a.kind)) why.push('kind')
        if (a.kind === 'nondeclining' && !(a.rate.value >= 0)) why.push('nondeclining rate')
        if (a.kind === 'declining' && !(a.rate.value < 0 && a.basis.samples >= R.MIN_SAMPLES)) why.push('declining rate')
        if (a.kind === 'single' && a.basis.samples !== 1) why.push('single')
        if (a.kind === 'unknown' && a.basis.samples !== 0) why.push('unknown')
        if (a.kind === 'zero-baseline' && a.first.value !== 0) why.push('zero baseline')
        if ((a.rate.value === null) !== (a.basis.samples < 2)) why.push('rate presence')
        if (a.earliest.value !== null && !(a.earliest.value >= 0 && a.earliest.value <= a.depletion.value + 1e-9)) why.push('earliest bound')

        const csv = R.ratesCsv(a, { date: DATE })
        const text = R.ratesText(a, NICE)

        if (/NaN|Infinity|\[object|\bnull\b/.test(csv) || /NaN|Infinity|\[object|\bnull\b/.test(text)) why.push('output text')

        if (why.length) {
          problems.push(`${why.join(', ')} for ${short(points)}`)
        }
      }

      return problems.length === 0 ? true : problems.join(' | ')
    }],
  ])
}

// ---------- the panel ----------

const BASE = { empireRecord: null, colonyRecord: { file: null, error: '' }, colonies: [], raceId: 2, raceName: 'Test race', campaignId: 'c1', branchId: 'b1', gameId: 7, chartOptions: (scales, tooltip) => ({ scales, tooltip }), year: (seconds) => seconds / YEAR, date: DATE, separator: '\'', message: '' }

const mountPanel = (ctx, data = {}) => instantiate(ctx.options, { $store: { getters: {}, state: {} }, data: { ...BASE, ...data } })

const PANEL_EMPIRE = { snapshots: [[0, 1000], [1, 950], [2, 850], [3, null], [4, 650], [5, 600], [6, 500]].map(([years, fuel]) => ({ t: at(years), fuel })) }

const colonyEntry = (id, state, fuel) => [id, state, 1, fuel, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

const PANEL_COLONY_FILE = (columns) => ({ columns, races: { 2: { snapshots: [[0, 1000, 50], [1, 900, 50], [2, null, 50], [3, 700, 50], [4, 600, 50]].map(([years, fuel, other]) => ({ t: at(years), colonies: [fuel === null ? colonyEntry(7, 1) : colonyEntry(7, 0, fuel), colonyEntry(9, 0, other)] })) } } })

const PANEL_COLONIES = [{ id: 7, name: 'Alpha', since: 0 }, { id: 9, name: 'Beta', since: 0 }]

const panel = (ctx) => {
  const { m } = ctx

  return parts([
    ['panel-defaults: the panel opens on the empire\'s fuel over 5 years and reads the window from the latest snapshot', () => {
      const vm = mountPanel(ctx, { empireRecord: PANEL_EMPIRE })
      const a = vm.analysis
      const problems = []

      if (!(vm.rateScope === 'empire' && vm.rateStock === 'fuel' && vm.rateWindow === 5 && vm.stockKey === 'fuel' && vm.unavailableText === '')) {
        problems.push(`defaults ${short([vm.rateScope, vm.rateStock, vm.rateWindow])}`)
      }

      if (!(a.window.years === 5 && a.window.from === at(1) && a.rows.length === 6 && a.kind === 'declining' && a.basis.samples === 5 && a.basis.unknown === 1 && near(a.rate.value, -90))) {
        problems.push(`analysis ${short([a.window, a.rows.length, a.kind, a.rate.value])}`)
      }

      if (!(vm.figures[0].text.includes('−90') && vm.figures[0].text.includes('L per game year, from 5 observations') && vm.figures[2].text.startsWith('about 5.6 game years after the last observation') && vm.figures[1].result.value === a.relative.value && vm.figures[1].result.value !== null)) {
        problems.push(`figures ${short(vm.figures.map((figure) => figure.text))}`)
      }

      if (!(a.notes.some((note) => note.startsWith('Window: the last 5 game years')) && a.notes[a.notes.length - 1] === m.history.retentionNote(PANEL_EMPIRE, DATE) && vm.caption.includes('last 5 y') && vm.caption.includes('5 observations'))) {
        problems.push(`notes ${short(a.notes)}`)
      }

      const gap = vm.tableRows[2]

      if (!(vm.tableRows.length === 6 && gap.value === '—' && /^not recorded: /.test(gap.note) && gap.change === '—' && gap.rate === '—')) {
        problems.push(`table ${short(gap)}`)
      }

      const [observed, average] = vm.chart.data.datasets

      if (!(vm.chart.data.datasets.length === 2 && observed.data.length === 6 && observed.data[2].y === null && observed.data[0].x === 1 && average.data.length === 2 && average.data[0].y === 950 && average.data[1].y === 500)) {
        problems.push(`chart ${short(vm.chart.data.datasets.map((dataset) => dataset.data))}`)
      }

      vm.rateWindow = 1

      const one = vm.analysis.rows.length

      vm.rateWindow = 0

      const all = vm.analysis.rows.length

      vm.rateStock = 'Duranium'

      if (!(one === 2 && all === 7 && vm.analysis.kind === 'unknown' && vm.unavailableText === '' && vm.chart !== null)) {
        problems.push(`switching ${short([one, all, vm.analysis.kind])}`)
      }

      vm.rateStock = 'wealth'

      const offered = [vm.stockOptions.length, mountPanel(ctx, { rateScope: 'colony' }).stockOptions.length]
      const empty = mountPanel(ctx)

      if (!(equal(offered, [14, 13]) && /^No snapshot is recorded/.test(empty.unavailableText) && empty.chart === null)) {
        problems.push(`options ${short([offered, empty.unavailableText])}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['panel-colony: a colony is chosen from the colonies followed, the treasury is not offered, and a colony series that cannot be read is said so', () => {
      const file = PANEL_COLONY_FILE(m.colony.COLONY_COLUMNS)
      const base = { rateScope: 'colony', colonyRecord: { file, error: '' }, colonies: PANEL_COLONIES }
      const first = mountPanel(ctx, base)
      const second = mountPanel(ctx, { ...base, rateColony: 9 })
      const absent = mountPanel(ctx, { ...base, rateColony: 55 })
      const treasury = mountPanel(ctx, { ...base, rateStock: 'wealth' })
      const text = mountPanel(ctx, { ...base, raceId: '2' })
      const problems = []

      if (!(first.colonyId === 7 && first.colonyName === 'Alpha' && equal(first.analysis.rows.map((row) => row.value), [1000, 900, null, 700, 600]) && first.analysis.scope.kind === 'colony' && first.analysis.kind === 'declining' && first.analysis.basis.unknown === 1)) {
        problems.push(`first ${short([first.colonyId, first.analysis.rows.map((row) => row.value), first.analysis.kind])}`)
      }

      if (!(second.colonyId === 9 && second.analysis.kind === 'nondeclining' && near(second.analysis.rate.value, 0) && absent.colonyId === 7)) {
        problems.push(`pick ${short([second.colonyId, second.analysis.kind, absent.colonyId])}`)
      }

      if (!(treasury.stockKey === 'fuel' && treasury.stock.key === 'fuel' && treasury.analysis.rows.length === 5 && text.analysis.rows.length === 5)) {
        problems.push(`treasury ${short([treasury.stockKey, treasury.analysis.rows.length, text.analysis.rows.length])}`)
      }

      const broken = mountPanel(ctx, { ...base, colonyRecord: { file: null, error: 'boom' } })
      const none = mountPanel(ctx, { ...base, colonies: [] })
      const missing = mountPanel(ctx, { ...base, raceId: 8 })
      const stopped = mountPanel(ctx, { ...base, colonies: [{ id: 9, name: 'Beta', since: 0, until: 3 }] })

      if (!(/boom/.test(broken.unavailableText) && /could not be read/.test(broken.unavailableText) && /Colony series/.test(none.unavailableText) && /No colony series is recorded/.test(missing.unavailableText) && stopped.colonyOptions[0].text === 'Beta (stopped)')) {
        problems.push(`reasons ${short([broken.unavailableText, none.unavailableText, missing.unavailableText, stopped.colonyOptions])}`)
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['panel-identity: what the panel saves and copies names the campaign, the shown branch, the race and the colony, and changes with the branch', async () => {
      const file = PANEL_COLONY_FILE(m.colony.COLONY_COLUMNS)
      const colonyData = { rateScope: 'colony', colonyRecord: { file, error: '' }, colonies: PANEL_COLONIES }
      const saved = []
      const copied = []
      const link = { click: () => {} }
      const previous = { document: globalThis.document, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') }

      globalThis.document = { createElement: () => link }
      URL.createObjectURL = (blob) => { saved.push({ blob, name: () => link.download }); return 'blob:test' }
      URL.revokeObjectURL = () => {}
      Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { copied.push(text) } } }, configurable: true, writable: true })

      try {
        const take = async (data) => {
          const vm = mountPanel(ctx, data)

          vm.downloadCsv()
          await vm.copyText()

          const last = saved[saved.length - 1]
          const name = link.download
          const csv = await last.blob.text()

          return { csv, name, text: copied[copied.length - 1], rows: tableOf(csv).rows }
        }
        const empire = { empireRecord: PANEL_EMPIRE }
        const b1 = await take({ ...empire, branchId: 'b1' })
        const b2 = await take({ ...empire, branchId: 'b2' })
        const c2 = await take({ ...empire, campaignId: 'c2' })
        const alpha = await take({ ...colonyData, branchId: 'b1' })
        const beta = await take({ ...colonyData, branchId: 'b1', rateColony: 9 })
        const note = (taken, item) => (taken.rows.find((row) => row.Item === item) || {}).Note
        const value = (taken, item) => (taken.rows.find((row) => row.Item === item) || {}).Value
        const problems = []

        if (!(note(b1, 'Campaign') === 'c1' && note(b1, 'Branch') === 'b1' && note(b1, 'Game') === '7' && note(b1, 'Race') === 'Test race' && value(b1, 'Race') === '2')) problems.push(`csv ${short(b1.rows.slice(0, 6).map((row) => [row.Item, row.Note, row.Value]))}`)
        if (!(note(b2, 'Branch') === 'b2' && b1.csv !== b2.csv && b1.name !== b2.name && b1.name.includes('b1') && b2.name.includes('b2') && b1.text !== b2.text && b2.text.includes('branch b2,'))) problems.push(`branch switch ${short([b1.name, b2.name])}`)
        if (!(note(c2, 'Campaign') === 'c2' && c2.name !== b1.name && c2.text.includes('campaign c2,'))) problems.push(`campaign ${short([c2.name, note(c2, 'Campaign')])}`)
        if (!(b1.text.includes('Source: campaign c1, branch b1, game 7, race Test race (RaceID 2).'))) problems.push(`text ${short(b1.text.split('\n').slice(0, 2))}`)
        if (!(note(alpha, 'Colony') === 'Alpha' && value(alpha, 'Colony') === '7' && note(beta, 'Colony') === 'Beta' && value(beta, 'Colony') === '9' && alpha.name !== beta.name && alpha.name.includes('colony-7') && alpha.text.includes('colony Alpha (PopulationID 7)') && beta.text.includes('colony Beta (PopulationID 9)'))) problems.push(`colony ${short([alpha.name, beta.name, note(alpha, 'Colony'), value(alpha, 'Colony')])}`)

        return problems.length === 0 ? true : problems.join('; ')
      } finally {
        if (previous.document === undefined) delete globalThis.document
        else globalThis.document = previous.document
        URL.createObjectURL = previous.createObjectURL
        URL.revokeObjectURL = previous.revokeObjectURL
        if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator)
        else delete globalThis.navigator
      }
    }],
    ['panel-template: the panel has a summary, the notes, the table, the exports and the limits, and the page mounts it with the colony file', () => {
      const text = ctx.componentText
      const page = ctx.pageText
      const descriptor = ((parsed) => parsed.descriptor || parsed)(require('vue/compiler-sfc').parse({ source: text }))
      const compiled = require('vue/compiler-sfc').compileTemplate({ source: descriptor.template.content, filename: 'StockRates.vue', id: 'stock-rates' })
      const summary = /<v-card class="panel history-rates" data-summary="([^"]*)"/.exec(text)
      const problems = []

      if (compiled.errors.length) {
        problems.push(`template ${short(compiled.errors)}`)
      }

      if (!(summary && summary[1].length > 60 && !/\d/.test(summary[1]) && !/\b(you|your|we|our|I|me|my)\b/i.test(summary[1]))) {
        problems.push(`summary ${short(summary && summary[1])}`)
      }

      for (const needle of ['v-for="note in analysis.notes"', 'data-rates-note', '<table data-rates-table>', 'data-rates-csv @click="downloadCsv"', 'data-rates-copy @click="copyText"', 'data-rates-limits>', 'data-chart="stock-rates"', 'data-rates-window', 'data-rates-scope']) {
        if (!text.includes(needle)) {
          problems.push(`missing ${needle}`)
        }
      }

      if (!/ratesCsv\(this\.analysis, \{ date: this\.date, retention: this\.source\.record \? retentionNote\(this\.source\.record, this\.date\) : '' \}\)/.test(text) || !/ratesText\(this\.analysis, \{ date: this\.date, format: this\.format \}\)/.test(text)) {
        problems.push('exports not given the analysis, the dates and the retention note')
      }

      if (!page.includes('<stock-rates :empire-record="record" :colony-record="colonyRecord" :colonies=') || !/components: \{[^}]*\bStockRates\b[^}]*\}/.test(page) || !page.includes('import StockRates from \'../components/history/StockRates.vue\'')) {
        problems.push('the history page does not mount the panel with the colony file')
      }

      const mount = /<stock-rates [^>]*>/.exec(page)

      if (!(mount && mount[0].includes(' :campaign-id="resolved ? resolved.campaignId : null"') && mount[0].includes(' :branch-id="shownBranchId"') && mount[0].includes(' :game-id="GameID"'))) {
        problems.push('the history page does not pass the campaign, the shown branch and the game')
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
  ])
}

// ---------- the recorded campaign ----------

const campaignStatements = (ctx, C) => {
  const { m } = ctx
  const R = m.rates
  const WINDOWS = R.WINDOWS
  const windowOf = (times, years) => {
    const latest = times[times.length - 1]
    const from = years ? latest - years * YEAR : -Infinity
    const indices = times.map((_t, index) => index).filter((index) => times[index] >= from)

    return { latest, first: indices[0], last: indices[indices.length - 1], count: indices.length }
  }
  const empireAnalysis = (race, key, years) => {
    const snapshots = C.races[race].snapshots
    const stock = R.stockOf(key)

    return R.analyseStock({ stock, observations: R.empireObservations(snapshots, stock), latest: R.latestOf(snapshots), years })
  }

  return parts([
    ['c-saves: the saves are one snapshot each, 5 game days apart, for both races', () => {
      const problems = CAMPAIGN_RACES.filter((race) => {
        const times = C.races[race].snapshots.map((snapshot) => snapshot.t)

        return !(times.length === 150 && times.every((t, index) => index === 0 || t - times[index - 1] === 432000) && C.races[race].oracle.length === 150)
      })

      return problems.length === 0 && C.colony.snapshots.length === 150 ? true : `races ${problems.join(', ')}`
    }],
    ['c-rates: the rate of every stock, over every window, matches the rate of the unrounded sums read from the saves', () => {
      const problems = []
      let compared = 0

      for (const race of CAMPAIGN_RACES) {
        const times = C.races[race].snapshots.map((snapshot) => snapshot.t)

        for (const years of WINDOWS) {
          const { first, last } = windowOf(times, years)
          const elapsed = (times[last] - times[first]) / YEAR

          ORACLE_KEYS.forEach((key, index) => {
            const a = empireAnalysis(race, key, years)
            const expected = (C.races[race].oracle[last][index] - C.races[race].oracle[first][index]) / elapsed

            compared++

            if (!(a.rate.value !== null && a.first.t === times[first] && a.last.t === times[last] && Math.abs(a.rate.value - expected) <= 1.0001 / elapsed + 1e-6)) {
              problems.push(`race ${race} ${key} ${years} y: ${a.rate.value} != ${expected}`)
            }
          })
        }
      }

      return problems.length === 0 && compared === 2 * WINDOWS.length * ORACLE_KEYS.length ? true : problems.slice(0, 3).join('; ') || `${compared} compared`
    }],
    ['c-zero: race 1\'s Gallicite, 0 t throughout, has a baseline of 0 in every window', () => {
      const problems = WINDOWS.filter((years) => {
        const a = empireAnalysis(1, 'Gallicite', years)

        return !(a.kind === 'zero-baseline' && a.relative.value === null && a.depletion.value === null && a.rate.value === 0 && finiteAll(a))
      })

      return problems.length === 0 ? true : `windows ${problems.join(', ')}`
    }],
    ['c-window: the windows hold the saves of the years before the latest', () => {
      const times = C.races[2].snapshots.map((snapshot) => snapshot.t)
      const expected = WINDOWS.map((years) => windowOf(times, years).count)
      const counts = WINDOWS.map((years) => empireAnalysis(2, 'fuel', years).basis.snapshots)

      return equal(counts, expected) && equal(expected, [74, 147, 150, 150, 150, 150]) ? true : short([counts, expected])
    }],
    ['c-invariant: every stock of both races in every window is finite, and has a date only as a decline', () => {
      const problems = []

      for (const race of CAMPAIGN_RACES) {
        for (const stock of R.STOCKS) {
          for (const years of WINDOWS) {
            const a = empireAnalysis(race, stock.key, years)
            const why = []

            if (!finiteAll(a)) why.push('not finite')
            if ((a.depletion.value !== null) !== (a.kind === 'declining')) why.push('date and kind')
            if (a.depletion.value !== null && !(a.depletion.value > 0 && a.depletion.value <= 1000 && a.earliest.value <= a.depletion.value + 1e-9)) why.push('date range')
            if (a.kind === 'nondeclining' && !(a.rate.value >= 0)) why.push('nondeclining')
            if (!(a.window.latest === C.races[race].snapshots[149].t)) why.push('latest')
            if (/NaN|Infinity|\[object|\bnull\b/.test(R.ratesCsv(a))) why.push('csv')

            if (why.length) {
              problems.push(`race ${race} ${stock.key} ${years} y: ${why.join(', ')}`)
            }
          }
        }
      }

      return problems.length === 0 ? true : problems.slice(0, 3).join('; ')
    }],
    ['c-colony: the colony series of the most populous colony of race 2 gives the rates of its raw rows', () => {
      const { snapshots, raw, target } = C.colony
      const record = { snapshots }
      const times = snapshots.map((snapshot) => snapshot.t)
      const problems = []
      let compared = 0

      for (const years of [0, 5, 1]) {
        for (const stock of R.stocksOf('colony')) {
          const observations = R.colonyObservations(record, target.id, stock, m.colony.COLONY_COLUMNS)
          const a = R.analyseStock({ stock, scope: { kind: 'colony', name: target.name }, observations, latest: R.latestOf(snapshots), years })
          const index = ORACLE_KEYS.indexOf(stock.key)

          if (observations.length !== snapshots.length) {
            problems.push(`${stock.key}: ${observations.length} observations`)
          }

          observations.forEach((observation, position) => {
            const rawValue = raw[position] ? raw[position][index] : null

            if (!(rawValue === null ? observation.result.value === null : observation.result.value !== null && Math.abs(observation.result.value - rawValue) <= 0.5 + 1e-9)) {
              problems.push(`${stock.key} at ${times[position]}: ${observation.result.value} vs ${rawValue}`)
            }
          })

          if (a.first && a.last && a.first.t !== a.last.t) {
            const expected = (raw[times.indexOf(a.last.t)][index] - raw[times.indexOf(a.first.t)][index]) / ((a.last.t - a.first.t) / YEAR)

            compared++

            if (!(a.rate.value !== null && Math.abs(a.rate.value - expected) <= 1.0001 / ((a.last.t - a.first.t) / YEAR) + 1e-6)) {
              problems.push(`${stock.key} ${years} y: ${a.rate.value} != ${expected}`)
            }
          }
        }
      }

      return problems.length === 0 && compared > 0 ? true : problems.slice(0, 3).join('; ') || `${compared} compared`
    }],
  ])
}

// ---------- the mutations ----------

const U = 'stock-rates.js'
const V = 'StockRates.vue'
const P = 'history.vue'

// A planted fault and the checks that must fail for it: each name is the key of a check (the text before its colon), and the fault is caught only when every one of them fails. `campaign` names the checks of the recorded campaign that must fail too, when it is there.
const MUTATIONS = [
  { name: 'the rate divided by the observations, not the time', file: U, find: '(after - before) / elapsed, units: perYear', replace: '(after - before) / (known.length - 1), units: perYear', fails: ['irregular', 'elapsed'], campaign: ['c-rates'] },
  { name: 'the rate per game day', file: U, find: '(after - before) / elapsed, units: perYear', replace: '(after - before) / (elapsed * 365), units: perYear', fails: ['irregular', 'elapsed'], campaign: ['c-rates'] },
  { name: 'a game year of 360 days', file: U, find: 'export const YEAR_SECONDS = 31536000', replace: 'export const YEAR_SECONDS = 31104000', fails: ['irregular', 'elapsed', 'year'], campaign: ['c-rates'] },
  { name: 'the rate of an interval not divided by its time', file: U, find: '(after - before) / (seconds / YEAR_SECONDS), units: perYear', replace: '(after - before), units: perYear', fails: ['irregular', 'declining'] },
  { name: 'observations at one game time all kept', file: U, find: 'if (!last || last.t !== observation.t) {', replace: 'if (true) {', fails: ['duplicates', 'random'] },
  { name: 'the first of two observations at a game time kept', file: U, find: '} else if (isAvailable(observation.result) || !isAvailable(last.result)) {', replace: '} else if (false) {', fails: ['duplicates'] },
  { name: 'an unrecorded observation replacing a recorded one at its game time', file: U, find: '} else if (isAvailable(observation.result) || !isAvailable(last.result)) {', replace: '} else if (true) {', fails: ['duplicates'] },
  { name: 'observations read in the order given', file: U, find: '.sort((a, b) => a.observation.t - b.observation.t || a.index - b.index)', replace: '.sort((a, b) => a.index - b.index)', fails: ['order'] },
  { name: 'the start of the window left out', file: U, find: '(from === null || observation.t >= from)', replace: '(from === null || observation.t > from)', fails: ['window'] },
  { name: 'the window counted back from the last observation', file: U, find: 'const from = years && latest !== null ? latest - years * YEAR_SECONDS : null', replace: 'const from = years && observations.length ? Math.max(...observations.map((observation) => observation.t)) - years * YEAR_SECONDS : null', fails: ['window'] },
  { name: 'a window of 0 years taken as the latest snapshot only', file: U, find: 'const from = years && latest !== null ? latest - years * YEAR_SECONDS : null', replace: 'const from = latest !== null ? latest - years * YEAR_SECONDS : null', fails: ['window'], campaign: ['c-window', 'c-rates'] },
  { name: 'an unrecorded stock read as 0', file: U, find: 'value: valueOrNull(observation.result), result: observation.result }))', replace: 'value: valueOrNull(observation.result) || 0, result: observation.result }))', fails: ['unrecorded', 'csv-unknown'] },
  { name: 'a flat series given a date', file: U, find: 'rateValue >= 0 ? \'nondeclining\'', replace: 'rateValue > 0 ? \'nondeclining\'', fails: ['flat', 'random'] },
  { name: 'a rising series given a date', file: U, find: 'rateValue >= 0 ? \'nondeclining\'', replace: 'rateValue === 0 ? \'nondeclining\'', fails: ['flat', 'random'] },
  { name: 'a baseline of 0 not told apart', file: U, find: 'first.value === 0 ? \'zero-baseline\'', replace: 'first.value === null ? \'zero-baseline\'', fails: ['zerobase', 'random'], campaign: ['c-zero'] },
  { name: 'a stock at 0 told before a baseline of 0', file: U, find: 'first.value === 0 ? \'zero-baseline\' : last.value <= 0 ? \'empty\' :', replace: 'last.value <= 0 ? \'empty\' : first.value === 0 ? \'zero-baseline\' :', fails: ['zerobase'], campaign: ['c-zero'] },
  { name: 'a relative rate taken from a baseline of 0', file: U, find: 'known.length >= 2 && first.value !== 0 ? combine(', replace: 'known.length >= 2 ? combine(', fails: ['zerobase'] },
  { name: 'a rate given to a single observation', file: U, find: 'known.length >= 2 ? combine({ rule: \'stockRates.rate\'', replace: 'known.length >= 1 ? combine({ rule: \'stockRates.rate\'', fails: ['single', 'duplicates'] },
  { name: 'a single observation called too few', file: U, find: 'known.length === 1 ? \'single\'', replace: 'known.length === 1 ? \'insufficient\'', fails: ['single', 'duplicates'] },
  { name: 'no observation called a single one', file: U, find: '!known.length ? \'unknown\'', replace: '!known.length ? \'single\'', fails: ['none'] },
  { name: 'a stock at 0 not told apart', file: U, find: 'last.value <= 0 ? \'empty\'', replace: 'last.value < 0 ? \'empty\'', fails: ['empty'] },
  { name: 'two observations enough for a date', file: U, find: 'export const MIN_SAMPLES = 3', replace: 'export const MIN_SAMPLES = 2', fails: ['insufficient'] },
  { name: 'steps never detected', file: U, find: 'interval.spike = others.length > 0 &&', replace: 'interval.spike = false &&', fails: ['step', 'random'] },
  { name: 'a step of any size', file: U, find: 'export const SPIKE_SHARE = 0.5', replace: 'export const SPIKE_SHARE = 0.05', fails: ['step'] },
  { name: 'a step judged by its size alone', file: U, find: 'interval.large && Math.abs(interval.rate.value) >= SPIKE_RATIO * median(others)', replace: 'interval.large', fails: ['step'] },
  { name: 'a step judged by its rate alone', file: U, find: 'interval.large && Math.abs(interval.rate.value) >= SPIKE_RATIO * median(others)', replace: 'Math.abs(interval.rate.value) >= SPIKE_RATIO * median(others)', fails: ['step'] },
  { name: 'a step at the rate of the others', file: U, find: 'export const SPIKE_RATIO = 4', replace: 'export const SPIKE_RATIO = 1', fails: ['step'] },
  { name: 'a step judged against the mean of the other changes', file: U, find: 'return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2', replace: 'return sorted.reduce((total, value) => total + value, 0) / sorted.length', fails: ['step'] },
  { name: 'a step judged against the smaller stock', file: U, find: 'const larger = Math.max(Math.abs(known[index].value), Math.abs(known[index + 1].value))', replace: 'const larger = Math.min(Math.abs(known[index].value), Math.abs(known[index + 1].value))', fails: ['step'] },
  { name: 'no horizon on a date', file: U, find: 'horizonYears > HORIZON_YEARS ? \'distant\'', replace: 'false ? \'distant\'', fails: ['distant', 'random'] },
  { name: 'a horizon of a billion years', file: U, find: 'export const HORIZON_YEARS = 1000', replace: 'export const HORIZON_YEARS = 1e9', fails: ['distant', 'random'] },
  { name: 'the depletion taken from the first stock', file: U, find: 'rule: \'stockRates.depletion\', parts: { rate, stock: last.result }', replace: 'rule: \'stockRates.depletion\', parts: { rate, stock: first.result }', fails: ['declining', 'estimate'] },
  { name: 'the date dated from the first observation', file: U, find: 'last.t + depletion.value * YEAR_SECONDS', replace: 'first.t + depletion.value * YEAR_SECONDS', fails: ['declining'] },
  { name: 'the depletion registered as confirmed', file: U, find: 'id: \'stockRates.depletion\',\n  versions: STOCK_VERSIONS,\n  units: \'game years\',\n  verification: \'estimated\',', replace: 'id: \'stockRates.depletion\',\n  versions: STOCK_VERSIONS,\n  units: \'game years\',\n  verification: \'confirmed\',', fails: ['estimate', 'registry', 'csv'] },
  { name: 'the window left out of the words', file: U, find: 'years ? `the last ${years} game ${years === 1 ? \'year\' : \'years\'} before the latest snapshot (${date(Math.max(from, 0))} to ${date(latest)})` : `every retained snapshot, up to the latest (${date(latest)})`', replace: '\'the window\'', fails: ['notes', 'estimate', 'csv', 'panel-defaults'] },
  { name: 'the average-rate assumption left out of the rule', file: U, find: 'assumptions: [\'the stock keeps changing at the average rate observed over the window\', ', replace: 'assumptions: [', fails: ['estimate', 'csv'] },
  { name: 'the no-guarantee assumption left out of the rule', file: U, find: ', \'the estimate comes from observations only and is not a guarantee that the stock runs out\'],\n})\n\nregisterRule({\n  id: \'stockRates.depletionEarliest\'', replace: '],\n})\n\nregisterRule({\n  id: \'stockRates.depletionEarliest\'', fails: ['estimate'] },
  { name: 'a decline that will run out, guaranteed', file: U, find: 'This is an estimate from the observations taken, not a prediction that the stock runs out:', replace: 'The stock will run out, guaranteed:', fails: ['estimate'] },
  { name: 'the cautious bound from the slowest interval', file: U, find: '.sort((a, b) => a.rate.value - b.rate.value)[0]', replace: '.sort((a, b) => b.rate.value - a.rate.value)[0]', fails: ['declining', 'random'] },
  { name: 'the relative rate taken from the last stock', file: U, find: 'parts: { rate, baseline: first.result }', replace: 'parts: { rate, baseline: last.result }', fails: ['declining'] },
  { name: 'the window left out of the notes', file: U, find: '    windowLine,\n    first ?', replace: '    first ?', fails: ['notes', 'text'] },
  { name: 'the first and last observation left out of the notes', file: U, find: '    first ? `First observation', replace: '    false ? `First observation', fails: ['notes', 'text'] },
  { name: 'the sampling gaps left out of the notes', file: U, find: '`Sampling: ${basis.samples} observations over', replace: '`Observed: ${basis.samples} observations over', fails: ['notes'] },
  { name: 'the retention note left out of the notes', file: U, find: '...(retention ? [retention] : []),', replace: '', fails: ['notes', 'text'] },
  { name: 'the assumptions left out of the notes', file: U, find: '...assumptions.slice(1).map((line) => `Assumes ${line.charAt(0).toLowerCase()}${line.slice(1)}`),', replace: '', fails: ['notes', 'estimate'] },
  { name: 'the window left out of the CSV', file: U, find: 'fact(\'Window\', span.text, ', replace: 'fact(\'Window\', \'\', ', fails: ['csv'] },
  { name: 'the first observation left out of the CSV', file: U, find: 'analysis.first ? { ...figure(\'First observation\'', replace: 'false ? { ...figure(\'First observation\'', fails: ['csv'] },
  { name: 'the last observation left out of the CSV', file: U, find: 'analysis.last ? { ...figure(\'Last observation\'', replace: 'false ? { ...figure(\'Last observation\'', fails: ['csv'] },
  { name: 'the sampling gaps left out of the CSV', file: U, find: 'fact(\'Sampling gaps\', analysis.gaps ?', replace: 'fact(\'Sampling\', analysis.gaps ?', fails: ['csv'] },
  { name: 'the assumptions left out of the CSV', file: U, find: '...analysis.assumptions.map((line) => fact(\'Assumption\', line)),', replace: '', fails: ['csv'] },
  { name: 'the retention note left out of the CSV', file: U, find: '...(retention ? [fact(\'Retention\', retention)] : []),', replace: '', fails: ['csv'] },
  { name: 'an unknown figure exported as 0', file: U, find: 'Value: fields.value,', replace: 'Value: fields.value === \'\' ? 0 : fields.value,', fails: ['csv-unknown'] },
  { name: 'the formula guard off', file: U, find: 'csvCell(fields[column])', replace: 'csvCell(fields[column], { guard: false })', fails: ['csv-safe'] },
  { name: 'the status and rule left out of the CSV', file: U, find: 'Status: fields.status, Rule: fields.rule,', replace: 'Status: \'\', Rule: \'\',', fails: ['csv', 'csv-unknown'] },
  { name: 'the game time of the CSV rounded', file: U, find: '\'Game time (s)\': row.t, Date: date(row.t)', replace: '\'Game time (s)\': Math.round(row.t / 1e6) * 1e6, Date: date(row.t)', fails: ['csv'] },
  { name: 'the notes left out of the copied text', file: U, find: '...analysis.notes, \'\', \'Observations:\'', replace: '\'\', \'Observations:\'', fails: ['text'] },
  { name: 'an unrecorded stock drawn as 0', file: U, find: 'observed: analysis.rows.map((row) => ({ t: row.t, value: row.value, step: row.spike })),', replace: 'observed: analysis.rows.map((row) => ({ t: row.t, value: row.value || 0, step: row.spike })),', fails: ['chartpoints'] },
  { name: 'the average line drawn to the wrong stock', file: U, find: '{ t: analysis.last.t, value: analysis.last.value }]', replace: '{ t: analysis.last.t, value: analysis.first.value }]', fails: ['chartpoints'] },
  { name: 'a mineral read one ID off', file: U, find: 'mineralResult(snapshot, stock.mineral, stock.label)', replace: 'mineralResult(snapshot, stock.mineral + 1, stock.label)', fails: ['empire'], campaign: ['c-rates'] },
  { name: 'a colony column read one off', file: U, find: 'entry[2 + columns.indexOf(stock.colony)]', replace: 'entry[1 + columns.indexOf(stock.colony)]', fails: ['colony'], campaign: ['c-colony'] },
  { name: 'a colony taken at any state', file: U, find: 'if (entry[1] !== COLONY_STATES.OBSERVED) {', replace: 'if (false) {', fails: ['colony'] },
  { name: 'a colony with no figure read as 0', file: U, find: 'return isKnownNumber(value) ? ofRule(', replace: 'return true ? ofRule(', fails: ['colony'] },
  { name: 'a snapshot without the colony counted as unrecorded', file: U, find: 'return entry ? [{ t: snapshot.t, result: colonyResult(entry, stock, columns) }] : []', replace: 'return [{ t: snapshot.t, result: entry ? colonyResult(entry, stock, columns) : unavailable({ rule: \'stockRates.colonyStock\', missing: [\'colony\'], units: stock.unit }) }]', fails: ['colony'] },
  { name: 'the treasury offered for a colony', file: U, find: '(scope === SCOPES.COLONY ? stock.colony !== null : true)', replace: '(scope === SCOPES.COLONY ? true : true)', fails: ['colony', 'panel-colony', 'panel-defaults'] },
  { name: 'the rules registered for the 2.6 line', file: U, find: 'const STOCK_VERSIONS = [\'2.7.x\']', replace: 'const STOCK_VERSIONS = [\'2.6.x\']', fails: ['registry'] },
  { name: 'the rate registered as estimated', file: U, find: 'id: \'stockRates.rate\',\n  versions: STOCK_VERSIONS,\n  units: \'per game year\',\n  verification: \'confirmed\',', replace: 'id: \'stockRates.rate\',\n  versions: STOCK_VERSIONS,\n  units: \'per game year\',\n  verification: \'estimated\',', fails: ['registry', 'estimate', 'csv'] },
  { name: 'the panel\'s window ignored', file: V, find: 'years: this.rateWindow', replace: 'years: 0', fails: ['panel-defaults'] },
  { name: 'the colony chosen ignored', file: V, find: 'return this.colonyOptions.some((option) => option.value === this.rateColony) ? this.rateColony :', replace: 'return false ? this.rateColony :', fails: ['panel-colony'] },
  { name: 'the treasury kept on the colony scope', file: V, find: 'return stocksOf(this.scope).some((stock) => stock.key === this.rateStock) ? this.rateStock : stocksOf(this.scope)[0].key', replace: 'return this.rateStock', fails: ['panel-colony'] },
  { name: 'a colony series that cannot be read not said', file: V, find: 'if (this.colonyRecord && this.colonyRecord.error) {', replace: 'if (false) {', fails: ['panel-colony'] },
  { name: 'the retention note left out of the panel\'s notes', file: V, find: 'format: this.format, date: this.date, retention: this.source.record ? retentionNote(this.source.record, this.date) : \'\' })', replace: 'format: this.format, date: this.date, retention: \'\' })', fails: ['panel-defaults'] },
  { name: 'the table showing an unrecorded stock as 0', file: V, find: 'value: row.value === null ? UNKNOWN_TEXT : this.format(', replace: 'value: row.value === null ? \'0\' : this.format(', fails: ['panel-defaults'] },
  { name: 'the depletion shown as 0 years', file: V, find: ': `about ${this.format(depletion.value, 1)} game years', replace: ': `about 0 game years', fails: ['panel-defaults'] },
  { name: 'the observations left out of the rate figure', file: V, find: ', from ${this.format(basis.samples)} observations`', replace: '`', fails: ['panel-defaults'] },
  { name: 'the retention note left out of the panel\'s CSV', file: V, find: 'ratesCsv(this.analysis, { date: this.date, retention: this.source.record ? retentionNote(this.source.record, this.date) : \'\' })', replace: 'ratesCsv(this.analysis, { date: this.date, retention: \'\' })', fails: ['panel-template'] },
  { name: 'the campaign left out of the panel\'s scope', file: V, find: 'campaignId: this.campaignId, branchId: this.branchId,', replace: 'campaignId: null, branchId: this.branchId,', fails: ['panel-identity'] },
  { name: 'the shown branch left out of the panel\'s scope', file: V, find: 'campaignId: this.campaignId, branchId: this.branchId,', replace: 'campaignId: this.campaignId, branchId: null,', fails: ['panel-identity'] },
  { name: 'the race ID left out of the panel\'s scope', file: V, find: 'RaceID: this.raceId, colonyId:', replace: 'RaceID: null, colonyId:', fails: ['panel-identity'] },
  { name: 'the colony ID left out of the panel\'s scope', file: V, find: 'colonyId: this.scope === SCOPES.COLONY ? this.colonyId : null,', replace: 'colonyId: null,', fails: ['panel-identity'] },
  { name: 'the branch left out of the file name', file: V, find: '-${part(this.branchId)}-${this.scope', replace: '-${this.scope', fails: ['panel-identity'] },
  { name: 'the campaign left out of the file name', file: V, find: '-${part(this.campaignId)}-${part(this.branchId)}', replace: '-${part(this.branchId)}', fails: ['panel-identity'] },
  { name: 'the colony left out of the file name', file: V, find: '`colony-${part(this.colonyId)}`', replace: '\'colony\'', fails: ['panel-identity'] },
  { name: 'the page mounting the panel without the shown branch', file: P, find: ' :branch-id="shownBranchId"', replace: '', fails: ['panel-template'] },
  { name: 'the page mounting the panel without the campaign', file: P, find: ' :campaign-id="resolved ? resolved.campaignId : null"', replace: '', fails: ['panel-template'] },
  { name: 'the page mounting the panel without the game', file: P, find: ' :game-id="GameID" :chart-options="options"', replace: ' :chart-options="options"', fails: ['panel-template'] },
  { name: 'the identity left out of the copied text\'s source line', file: U, find: '`Source: ${sourceText(analysis.scope)}.`, ', replace: '', fails: ['identity', 'panel-identity'] },
  { name: 'the branch left out of the source line', file: U, find: 'branch ${unsettled(scope.branchId)}, game', replace: 'game', fails: ['identity', 'panel-identity'] },
  { name: 'the colony ID left out of the source line', file: U, find: ' (PopulationID ${unsettled(scope.colonyId)})', replace: '', fails: ['identity', 'panel-identity'] },
  { name: 'the campaign left out of the CSV', file: U, find: 'fact(\'Campaign\', unsettled(analysis.scope.campaignId)),', replace: '', fails: ['identity', 'panel-identity'] },
  { name: 'the branch left out of the CSV', file: U, find: 'fact(\'Branch\', unsettled(analysis.scope.branchId)),', replace: '', fails: ['identity', 'panel-identity'] },
  { name: 'the game left out of the CSV', file: U, find: 'fact(\'Game\', unsettled(analysis.scope.GameID)),', replace: '', fails: ['identity'] },
  { name: 'the race ID left out of the CSV', file: U, find: 'Value: isKnownNumber(analysis.scope.RaceID) ? Number(analysis.scope.RaceID) : null, Unit: \'RaceID\'', replace: 'Value: null, Unit: \'RaceID\'', fails: ['identity', 'panel-identity'] },
  { name: 'the colony ID left out of the CSV', file: U, find: 'Value: isKnownNumber(analysis.scope.colonyId) ? Number(analysis.scope.colonyId) : null, Unit: \'PopulationID\'', replace: 'Value: null, Unit: \'PopulationID\'', fails: ['identity', 'panel-identity'] },
  { name: 'an unsettled campaign left out of the source line', file: U, find: 'value === null || value === undefined || value === \'\' ? \'not settled\' : String(value)', replace: 'value === null || value === undefined || value === \'\' ? \'\' : String(value)', fails: ['identity'] },
  { name: 'large opposing changes given a date', file: U, find: 'rateValue >= 0 ? \'nondeclining\' : opposing ? \'volatile\' :', replace: 'rateValue >= 0 ? \'nondeclining\' :', fails: ['volatile', 'random'] },
  { name: 'large opposing changes needing no rise', file: U, find: 'intervals.some((interval) => interval.large && interval.change > 0) && intervals.some', replace: 'intervals.some((interval) => interval.large && interval.change > 0) || intervals.some', fails: ['volatile', 'step'] },
  { name: 'a large change taken as any change', file: U, find: 'interval.large = larger > 0 && Math.abs(interval.change) >= SPIKE_SHARE * larger', replace: 'interval.large = larger > 0 && Math.abs(interval.change) >= 0.01 * larger', fails: ['volatile'] },
  { name: 'a large change needing nineteen twentieths of the stock', file: U, find: 'interval.large = larger > 0 && Math.abs(interval.change) >= SPIKE_SHARE * larger', replace: 'interval.large = larger > 0 && Math.abs(interval.change) >= 0.95 * larger', fails: ['volatile'] },
  { name: 'opposing changes classed as a step', file: U, find: 'opposing ? \'volatile\' : intervals.some', replace: 'opposing ? \'spike\' : intervals.some', fails: ['volatile'] },
  { name: 'the summary renamed', file: V, find: 'data-summary="How fast', replace: 'data-note="How fast', fails: ['panel-template'] },
  { name: 'a figure in the summary', file: V, find: 'too few observations and a flat', replace: 'fewer than 3 observations and a flat', fails: ['panel-template'] },
  { name: 'the notes not listed', file: V, find: 'v-for="note in analysis.notes"', replace: 'v-for="note in []"', fails: ['panel-template'] },
  { name: 'the table without its mark', file: V, find: '<table data-rates-table>', replace: '<table>', fails: ['panel-template'] },
  { name: 'the CSV button without its mark', file: V, find: 'data-rates-csv @click="downloadCsv"', replace: '@click="downloadCsv"', fails: ['panel-template'] },
  { name: 'the copy button without its mark', file: V, find: 'data-rates-copy @click="copyText"', replace: '@click="copyText"', fails: ['panel-template'] },
  { name: 'the limits left off the panel', file: V, find: 'data-rates-limits>', replace: '>', fails: ['panel-template'] },
  { name: 'the copied text without the dates', file: V, find: 'ratesText(this.analysis, { date: this.date, format: this.format })', replace: 'ratesText(this.analysis, { format: this.format })', fails: ['panel-template'] },
  { name: 'the panel not mounted', file: P, find: '<stock-rates :empire-record="record"', replace: '<stock-ratez :empire-record="record"', fails: ['panel-template'] },
  { name: 'the panel mounted without the colony file', file: P, find: '<stock-rates :empire-record="record" :colony-record="colonyRecord"', replace: '<stock-rates :empire-record="record"', fails: ['panel-template'] },
  { name: 'the panel not registered', file: P, find: 'components: { ChartCanvas, ColonySeries, ProvenanceMark, SeriesKey, StatTiles, StockRates },', replace: 'components: { ChartCanvas, ColonySeries, ProvenanceMark, SeriesKey, StatTiles },', fails: ['panel-template'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = { [U]: () => fs.readFileSync(utilityFile, 'utf8'), [V]: () => fs.readFileSync(componentFile, 'utf8'), [P]: () => fs.readFileSync(pageFile, 'utf8') }

// The panel's text as the page loader reads a page: it resolves one level of '../' only, so the panel's deeper imports are written from a page's folder.
const loadable = (text) => text.replace(/from '\.\.\/\.\.\//g, 'from \'../').replace(/from '\.\.\/charts\//g, 'from \'../components/charts/')

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = { [U]: TEXTS[U](), [V]: TEXTS[V](), [P]: TEXTS[P]() }

  if (mutant) {
    sources[mutant.file] = patched(mutant.file, sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const changed = sources[U] !== TEXTS[U]()
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: changed ? { 'stock-rates': sources[U] } : {} })
  const options = await loadPage('pages/stock-rates-panel', { stubs: STUBS, sources: { 'pages/stock-rates-panel': loadable(sources[V]), ...(changed ? { 'utilities/stock-rates': sources[U] } : {}) } })

  return { m: { rates: loaded['stock-rates'], history: loaded.history, colony: loaded['colony-series'], provenance: loaded.provenance, minerals: loaded.minerals }, options, componentText: sources[V], pageText: sources[P] }
}

const statementsOf = (ctx, campaign) => [...pure(ctx), ...panel(ctx), ...(campaign ? campaignStatements(ctx, campaign) : [])]

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

const campaignOf = (file) => (file ? v8.deserialize(fs.readFileSync(file)) : null)

const checkHead = async (campaignFile) => {
  const ctx = await contextOf(sourcesOf(null))

  console.log('\nStock rates, on series worked by hand, the panel and the recorded campaign')

  for (const [name, result] of await runStatements(statementsOf(ctx, campaignOf(campaignFile)))) {
    check(name, result)
  }
}

const checkMutant = async (mutant, campaignFile) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  const campaign = campaignOf(campaignFile)
  const keys = campaign ? [...mutant.fails, ...(mutant.campaign || [])] : mutant.fails
  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  const statements = statementsOf(ctx, campaign)
  const absent = keys.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, keys)
  const missed = keys.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// ---------- reading the campaign ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)
      return
    }

    resolve({
      query: (sql) => new Promise((resolve, reject) => raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))),
      close: () => new Promise((resolve) => raw.close(resolve)),
    })
  })
})

// The files of the recorded saves in order, or null when the campaign is not there.
const campaignFiles = () => {
  const list = path.join(PASSIVE, 'snapshots.csv')

  if (!fs.existsSync(list)) {
    return null
  }

  const files = fs.readFileSync(list, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((line) => path.join(PASSIVE, 'snapshots', line.split(',')[2]))

  return files.length < 2 || !files.every((file) => fs.existsSync(file)) ? null : files
}

// The most populous colony of race 2 in the first save: the colony whose series is read.
const colonyTarget = async (file) => {
  const database = await openSave(file)

  try {
    const [[row]] = await database.query(`select PopulationID, PopName, SystemBodyID, RaceID from FCT_Population where GameID = ${CAMPAIGN_GAME} and RaceID = 2 order by Population desc limit 1`)

    return { id: row.PopulationID, name: row.PopName, bodyId: row.SystemBodyID, raceId: row.RaceID }
  } finally {
    await database.close()
  }
}

// The snapshots the app takes of each of the saves in `files`, the unrounded sums of the colony stockpiles of each race, and the colony series of the target colony with its raw row.
const readCampaign = async (m, files, target) => {
  const races = Object.fromEntries(CAMPAIGN_RACES.map((race) => [race, { snapshots: [], oracle: [] }]))
  const colony = { snapshots: [], raw: [], target }

  for (const file of files) {
    const database = await openSave(file)

    try {
      let t = null

      for (const RaceID of CAMPAIGN_RACES) {
        const { snapshot } = await m.history.takeSnapshot(database, { GameID: CAMPAIGN_GAME, RaceID })
        const [[sums]] = await database.query(`select ${ORACLE_COLUMNS.map((name, index) => `sum(FCT_Population.${name}) as m${index}`).join(', ')} from FCT_Population where FCT_Population.GameID = ${CAMPAIGN_GAME} and FCT_Population.RaceID = ${RaceID}`)

        races[RaceID].snapshots.push(snapshot)
        races[RaceID].oracle.push(ORACLE_COLUMNS.map((_name, index) => sums[`m${index}`]))
        t = snapshot.t
      }

      const read = await m.colony.readColonies(database, { GameID: CAMPAIGN_GAME, ids: [target.id] })
      const [rows] = await database.query(`select ${ORACLE_COLUMNS.join(', ')} from FCT_Population where GameID = ${CAMPAIGN_GAME} and PopulationID = ${target.id} and RaceID = ${target.raceId} and SystemBodyID = ${target.bodyId}`)

      colony.snapshots.push(m.colony.colonySnapshot({ t, n: colony.snapshots.length + 1, colonies: m.colony.colonyRows([{ id: target.id, since: 0, name: target.name, bodyId: target.bodyId, raceId: target.raceId }], read) }))
      colony.raw.push(rows.length ? ORACLE_COLUMNS.map((name) => rows[0][name]) : null)
    } finally {
      await database.close()
    }
  }

  return { races, colony }
}

const readSlice = async (slice, of, out, targetText) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS })
  const m = { history: loaded.history, colony: loaded['colony-series'] }
  const files = campaignFiles()
  const share = Math.ceil(files.length / of)

  fs.writeFileSync(out, v8.serialize(await readCampaign(m, files.slice(slice * share, (slice + 1) * share), JSON.parse(targetText))))
}

const parseArguments = (argv) => {
  const options = { part: null, campaign: null, slice: null, mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--campaign') {
      options.campaign = argv[++index]
    } else if (argv[index] === '--slice') {
      options.slice = [Number(argv[index + 1]), Number(argv[index + 2]), argv[index + 3], argv[index + 4]]
      index += 4
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.slice !== null) {
    await readSlice(...options.slice)
    endSection(0, 0)
  }

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead(options.campaign)
    } else if (mutant) {
      await checkMutant(mutant, options.campaign)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-stock-rates-'))

  try {
    const files = campaignFiles()
    let campaignFile = null

    if (files) {
      console.log('The recorded campaign: the snapshots of each save (this takes a while)')

      const target = JSON.stringify(await colonyTarget(files[0]))
      const count = Math.min(jobs(), files.length)
      const outs = Array.from({ length: count }, (_unused, slice) => path.join(directory, `slice-${slice}.bin`))

      await runSections(__filename, outs.map((out, slice) => ({ args: ['--slice', String(slice), String(count), out, target] })))

      const slices = outs.map((out) => v8.deserialize(fs.readFileSync(out)))
      const races = Object.fromEntries(CAMPAIGN_RACES.map((race) => [race, { snapshots: slices.flatMap((slice) => slice.races[race].snapshots), oracle: slices.flatMap((slice) => slice.races[race].oracle) }]))
      const colony = { snapshots: slices.flatMap((slice) => slice.colony.snapshots), raw: slices.flatMap((slice) => slice.colony.raw), target: slices[0].colony.target }

      campaignFile = path.join(directory, 'campaign.bin')
      fs.writeFileSync(campaignFile, v8.serialize({ races, colony }))
      console.log(`  ${races[1].snapshots.length} saves read for ${CAMPAIGN_RACES.length} races, and colony ${colony.target.name} (${colony.target.id})`)
    } else {
      console.log('SKIP  the passive campaign (artifacts/passive-campaign-20261013) is not there')
    }

    const forwarded = campaignFile ? ['--campaign', campaignFile] : []
    const wanted = options.mutations ? MUTANTS : []
    const sections = await runSections(__filename, [{ args: ['--part', 'head', ...forwarded], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id, ...forwarded], weight: 3 }))])
    let at0 = 0

    const printed = () => {
      const counts = printSection(sections[at0++])

      checks += counts.checks
      failures += counts.failures
    }

    printed()

    if (wanted.length) {
      console.log('\nMutations: each must fail the checks it names')
      wanted.forEach(printed)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
