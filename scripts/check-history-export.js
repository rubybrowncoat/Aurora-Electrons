/*
  Checks the export of what the history page shows (utilities/history-export.js and the export buttons of src/renderer/pages/history.vue): one CSV and one PNG for each chart, and a CSV for the table, of the series and window on screen and the annotations the charts draw.

  node scripts/check-history-export.js [--no-mutations]

  HISTORY_SAVES=<folder> points the saves check at another folder of saves (HISTORY_SAVES_FALRYX for the second family); a folder that is not there skips it. A check that needs the owner's saves and does not find them is reported as skipped, is not counted, and no mutant is expected to fail it.

  Groups:
  - csv: the documented columns, the exact sample game times with their units, a figure that is not recorded as an empty value with a status (never 0), the gap since the previous sample, annotations in their own columns and never in a sample's, the rule and its status, the baseline of a change, and the facts a reader needs (race, who may see it, window, sampling limits);
  - caption: the lines under the picture: title, race, scope, window, each series with its unit and how many samples are recorded, rules and assumptions, the limits of the sampling, the annotations, the spy mode label;
  - picture: the picture draws the whole caption wrapped to its width and the chart canvas once, on the chart's surface colour, at the chart's density;
  - page: the buttons of the page export what each view draws (its series, the window's snapshots, the annotations drawn), nothing that is hidden, not drawn, out of the window or from another race unless spy mode shows it, in a chart, the Rivals chart and the table, and the PNG goes through the existing save-png channel;
  - saves: the same from the owner's saves (opened read only, skipped when they are not here).

  Everything runs on in-memory stores and the real scenario repository. Each mutation of the utility or of the page must fail the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pageFile = path.join(root, 'src', 'renderer', 'pages', 'history.vue')
const SAVES = process.env.HISTORY_SAVES || path.join(root, 'artifacts', 'boscodiogigia-sequential-saves')
const SAVES_FALRYX = process.env.HISTORY_SAVES_FALRYX || path.join(root, 'artifacts', 'falryx-sequential-and-rollback')
const NAMES = ['history-export', 'history', 'history-milestones', 'scenario-records', 'provenance', 'mineral-compare']
const START_YEAR = 2050
const YEAR = 31536000

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: (...args) => globalThis.__ipc.invoke(...args) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

// What the page imports of the chart theme and the fonts, which need the app around them: the typeface is plain, and the second series of a chart has a dash.
const PAGE_MODULES = {
  'components/charts/theme': 'export const chartTheme = () => ({ categorical: [], ink: \'\', inkMuted: \'\' }); export const withAlpha = (color) => color; export const chartFont = () => ({ family: \'Test\', size: (px) => px, font: (px, weight = 400) => weight + \' \' + px + \'px Test\' }); export const seriesIdentity = (_appearance, color) => (color === \'#111\' ? { dash: [] } : { dash: [4, 2] })',
  'utilities/appearance-font': 'export const whenFontsReady = () => (globalThis.__fonts ? globalThis.__fonts() : Promise.resolve())',
}

const localRequire = createRequire(path.join(root, 'package.json'))

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const unhashed = (text) => text.replace(/#\{/g, '$' + '{')

// ---- Fixtures --------------------------------------------------------------------------------------------------------

const memory = () => {
  const files = new Map()
  const registry = { value: {} }
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      for (;;) {
        const base = JSON.stringify(this.store)
        const next = change(JSON.parse(base))

        if (JSON.stringify(this.store) === base) {
          this.store = next

          return next
        }
      }
    },
  })

  return { files, registry, storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => clone(registry.value), writable: () => Promise.resolve(true) } }
}

const world = (m) => {
  const inst = memory()
  const registry = m.records.createAdapterRegistry()
  let clock = 1000
  let ids = 0

  m.milestones.registerMilestones(registry.register)

  return { repo: m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock }) }
}

const scope = (gameTime, branchId = 'b1', campaignId = 'c1', RaceID = 7) => ({ campaignId, RaceID, branchId, gameTime })

// The CSV text as cells (a cell in quotes keeps its commas, line breaks and doubled quotes).
const cellsOf = (text) => {
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

  return rows
}

const tableOf = (text) => {
  const [header, ...rest] = cellsOf(text)

  return { header, cells: rest, rows: rest.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]]))) }
}

const SAMPLE_TIME = 'Sample game time (s)'
const ANNOTATION_TIME = 'Annotation game time (s)'

const samplesOf = (table, label) => table.rows.filter((row) => row.Record === 'sample' && (label === undefined || row.Series === label))

// A canvas that records what is drawn on it: its context answers `measureText` at 6 pixels a character and keeps every other call, with the properties set when it was made.
const recording = () => {
  const events = []
  const canvases = []
  const make = (width, height) => {
    const state = {}
    const context = new Proxy({ measureText: (text) => ({ width: text.length * 6 }) }, {
      get: (target, key) => (key in target ? target[key] : key in state ? state[key] : (...args) => { events.push({ call: key, args, state: { ...state } }) }),
      set: (_target, key, value) => { state[key] = value; return true },
    })
    const canvas = { width, height, getContext: () => context, toDataURL: () => 'data:image/png;base64,UE5H' }

    canvases.push(canvas)

    return canvas
  }

  return { make, events, canvases, texts: () => events.filter((event) => event.call === 'fillText') }
}

const TYPE = { font: (px, weight = 400) => `${weight} ${px}px Test`, size: (px) => px }

const THEME = { surface: '#fafafa', ink: '#111111', inkMuted: '#555555' }

const norm = (text) => text.replace(/\s+/g, ' ').trim()

// ---- The helper on its own --------------------------------------------------------------------------------------------

const date = (t) => `date(${t})`

const dateTime = (t) => `time(${t})`

const WINDOW = { span: 10, count: 3, retained: 8, from: 100.5, to: 1000 }

const SCOPE = { race: 'Test Race', RaceID: 7, GameID: 1, campaignId: 'c1', branchId: 'b1', spy: false }

const RETENTION = '8 samples; gaps up to 2 y (typical 1 y). Thinning unknown: nothing is known.'

const treasury = { label: 'Treasury', unit: 'wealth', rule: 'history.treasury', samples: [{ t: 100.5, value: 0, missing: [] }, { t: 250.25, value: null, missing: ['treasury'] }, { t: 1000, value: 1234.5, missing: [] }] }

const income = { label: 'Annual income', unit: 'wealth/yr', rule: 'history.income', samples: [{ t: 100.5, value: 5, missing: [] }, { t: 250.25, value: 6.5, missing: [] }, { t: 1000, value: null, missing: ['annual income'] }] }

const duranium = { label: 'Duranium', unit: '%', rule: 'history.mineralChange', baseline: { t: 100.5, stock: 10 }, samples: [{ t: 100.5, value: 0, stock: 10, missing: [] }, { t: 250.25, value: null, stock: null, missing: ['Duranium stockpile'] }, { t: 1000, value: 150, stock: 25, missing: [] }] }

const annotations = [
  { id: uuid(1), t: 250.25, type: 'Battle', text: 'First "contact", at\nthe border', link: 'Fleet: Third Fleet, linked', nearest: { t: 250.25, offset: 0 } },
  { id: uuid(2), t: 600.125, type: 'Discovery', text: 'Between two samples', link: '', nearest: { t: 250.25, offset: 349.875 } },
]

const modelOf = (m, over = {}) => m.exportation.exportModel({ chart: { key: 'wealth', title: 'Wealth', notes: ['Annual income: 1 of 3 snapshots have no figure, so the line breaks there.'] }, series: [treasury, income], annotations, unseen: 2, scope: SCOPE, window: WINDOW, retention: RETENTION, date, dateTime, ...over })

const suite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  const { exportCsv, captionLines, drawExport, CSV_COLUMNS } = m.exportation

  check('csv', 'the columns are the documented ones, in order, and every row has all of them', () => {
    const text = exportCsv(modelOf(m))
    const { header, cells } = tableOf(text)

    assert.deepEqual(header, CSV_COLUMNS)
    assert.deepEqual(header.slice(0, 4), ['Record', 'Chart', 'Series', 'Unit'])
    assert.ok(cells.length > 10)
    cells.forEach((row) => assert.equal(row.length, header.length))
    assert.deepEqual([...new Set(cells.map((row) => row[0]))], ['context', 'sample', 'annotation'])
  })

  check('csv', 'a sample row has the exact game time, the date, the value, its status, the unit and the rule', () => {
    const table = tableOf(exportCsv(modelOf(m, { annotations: [] })))
    const rows = samplesOf(table, 'Treasury')

    assert.deepEqual(rows.map((row) => Number(row[SAMPLE_TIME])), [100.5, 250.25, 1000])
    assert.deepEqual(rows.map((row) => row['Sample date']), ['date(100.5)', 'date(250.25)', 'date(1000)'])
    assert.deepEqual(rows.map((row) => row.Value), ['0', '', '1234.5'])
    assert.deepEqual(rows.map((row) => row['Value status']), ['recorded', 'not recorded', 'recorded'])
    assert.equal(samplesOf(table).length, 6)
    assert.deepEqual(rows.map((row) => row.Chart), ['Wealth', 'Wealth', 'Wealth'])
  })

  check('csv', 'every row of a series names its unit, its rule and the rule\'s status', () => {
    const table = tableOf(exportCsv(modelOf(m)))

    samplesOf(table, 'Treasury').forEach((row) => {
      assert.equal(row.Unit, 'wealth')
      assert.equal(row.Rule, 'history.treasury')
      assert.equal(row['Rule status'], 'confirmed')
    })
    samplesOf(table, 'Annual income').forEach((row) => {
      assert.equal(row.Unit, 'wealth/yr')
      assert.equal(row.Rule, 'history.income')
      assert.equal(row['Rule status'], 'estimated')
    })

    const rule = table.rows.find((row) => row.Record === 'context' && row.Series === 'Annual income')

    assert.equal(rule.Unit, 'wealth/yr')
    assert.equal(rule['Rule status'], 'estimated')
    assert.match(rule.Note, /annual wealth/)
  })

  check('csv', 'a figure not recorded is an empty value with the status not recorded and what is missing, never 0, and a recorded 0 stays 0', () => {
    const table = tableOf(exportCsv(modelOf(m)))
    const [zero, gone] = samplesOf(table, 'Treasury')

    assert.equal(zero.Value, '0')
    assert.equal(zero['Value status'], 'recorded')
    assert.equal(zero['Missing inputs'], '')
    assert.equal(gone.Value, '')
    assert.equal(gone['Value status'], 'not recorded')
    assert.equal(gone['Missing inputs'], 'treasury')
    assert.equal(table.rows.filter((row) => row.Record === 'sample' && row['Value status'] === 'not recorded').every((row) => row.Value === ''), true)
  })

  check('csv', 'the gap since the previous sample is empty for the first sample and exact after', () => {
    const rows = samplesOf(tableOf(exportCsv(modelOf(m))), 'Treasury')

    assert.deepEqual(rows.map((row) => row['Gap since previous sample (s)']), ['', '149.75', '749.75'])
  })

  check('csv', 'an annotation row has its ID, exact time, date, type, text and link, with commas, quotes and line breaks kept', () => {
    const rows = tableOf(exportCsv(modelOf(m))).rows.filter((row) => row.Record === 'annotation')

    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row['Annotation ID']), [uuid(1), uuid(2)])
    assert.deepEqual(rows.map((row) => Number(row[ANNOTATION_TIME])), [250.25, 600.125])
    assert.deepEqual(rows.map((row) => row['Annotation date']), ['time(250.25)', 'time(600.125)'])
    assert.deepEqual(rows.map((row) => row['Annotation type']), ['Battle', 'Discovery'])
    assert.equal(rows[0]['Annotation text'], 'First "contact", at\nthe border')
    assert.equal(rows[0]['Annotation link'], 'Fleet: Third Fleet, linked')
    assert.equal(rows[1]['Annotation link'], '')
    assert.deepEqual(rows.map((row) => row['Nearest sample game time (s)']), ['250.25', '250.25'])
    assert.deepEqual(rows.map((row) => row['Offset to nearest sample (s)']), ['0', '349.875'])
  })

  check('csv', 'an annotation time is in its own column and never in a sample time column, also when it equals a sample time', () => {
    const table = tableOf(exportCsv(modelOf(m)))
    const sampleTimes = table.rows.map((row) => row[SAMPLE_TIME]).filter((value) => value !== '')
    const annotationRows = table.rows.filter((row) => row.Record === 'annotation')

    assert.deepEqual([...new Set(sampleTimes)].sort((a, b) => a - b), ['100.5', '250.25', '1000'])
    assert.equal(sampleTimes.length, 6)
    assert.equal(sampleTimes.includes('600.125'), false)
    annotationRows.forEach((row) => {
      assert.equal(row[SAMPLE_TIME], '')
      assert.equal(row['Sample date'], '')
      assert.equal(row.Value, '')
      assert.equal(row.Series, '')
    })
    table.rows.filter((row) => row.Record === 'sample').forEach((row) => {
      CSV_COLUMNS.filter((name) => name.startsWith('Annotation')).forEach((name) => assert.equal(row[name], ''))
    })
    assert.equal(annotationRows.filter((row) => Number(row[ANNOTATION_TIME]) === 250.25).length, 1, 'an annotation at a sample time is still an annotation row')
  })

  check('csv', 'the context rows state the race and branch, who may see the data, the window, the sampling limits, the annotations and the chart\'s notes', () => {
    const rows = tableOf(exportCsv(modelOf(m))).rows.filter((row) => row.Record === 'context' && row.Series === '')
    const notes = rows.map((row) => row.Note)

    assert.ok(notes.some((note) => /Test Race \(race 7\) in game 1, campaign c1, branch b1/.test(note)))
    assert.ok(notes.some((note) => /selected race only; no other race is included/.test(note)))
    assert.ok(notes.some((note) => note.includes('The last 10 years before the latest snapshot: 3 of 8 retained snapshots, from date(100.5) (100.5 s) to date(1000) (1000 s).')))
    assert.ok(notes.some((note) => note.includes(RETENTION) && /never observed/.test(note) && /not a continuous record/.test(note)))
    assert.ok(notes.some((note) => /2 drawn in this window.*not a sample time.*2 more kept/.test(note)))
    assert.ok(notes.some((note) => /not 0/.test(note)))
    assert.ok(notes.includes('Annual income: 1 of 3 snapshots have no figure, so the line breaks there.'))
    assert.ok(rows.every((row) => row.Chart === 'Wealth'))
  })

  check('csv', 'a percent series carries the stock behind each change and its baseline, and a stock not recorded is empty', () => {
    const rows = samplesOf(tableOf(exportCsv(modelOf(m, { chart: { key: 'minerals', title: 'Mineral stockpiles', notes: [] }, series: [duranium] }))), 'Duranium')

    assert.deepEqual(rows.map((row) => row.Value), ['0', '', '150'])
    assert.deepEqual(rows.map((row) => row['Stock behind the change (t)']), ['10', '', '25'])
    assert.deepEqual(rows.map((row) => row['Baseline stock (t)']), ['10', '10', '10'])
    assert.deepEqual(rows.map((row) => row['Baseline game time (s)']), ['100.5', '100.5', '100.5'])
    assert.deepEqual(rows.map((row) => row.Unit), ['%', '%', '%'])
    assert.equal(rows[0].Rule, 'history.mineralChange')
  })

  check('csv', 'a series that is not a change has no baseline and no stock column filled', () => {
    samplesOf(tableOf(exportCsv(modelOf(m)))).forEach((row) => {
      assert.equal(row['Baseline stock (t)'], '')
      assert.equal(row['Baseline game time (s)'], '')
      assert.equal(row['Stock behind the change (t)'], '')
    })
  })

  check('csv', 'a view that draws no annotations says so and has no annotation row', () => {
    const table = tableOf(exportCsv(modelOf(m, { annotated: false, annotations: [], unseen: 0 })))

    assert.equal(table.rows.filter((row) => row.Record === 'annotation').length, 0)
    assert.ok(table.rows.some((row) => /does not draw them, so none is exported/.test(row.Note)))
  })

  check('csv', 'a text cell that starts like a formula is written with a leading apostrophe, a column of numbers never is: a negative figure stays a number', () => {
    const negative = { ...treasury, label: '=Treasury', samples: [{ t: 100.5, value: -5, missing: [] }, { t: 250.25, value: null, missing: ['-missing'] }, { t: 1000, value: 1234.5, missing: [] }] }
    const texts = ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1', 'Plain text', '\'=quoted already', 'Battle, "two", fleets']
    const list = texts.map((text, index) => ({ id: uuid(index + 1), t: 300 + index, type: 'Battle', text, link: index === 0 ? '=HYPERLINK("x")' : '', nearest: { t: 250.25, offset: -12.5 } }))
    const text = exportCsv(modelOf(m, { chart: { key: 'wealth', title: '=Wealth', notes: ['-1 of 3 snapshots have no figure'] }, series: [negative], annotations: list }))
    const table = tableOf(text)
    const rows = table.rows.filter((row) => row.Record === 'annotation')

    assert.deepEqual(rows.map((row) => row['Annotation text']), ['\'=1+1', '\'+1+1', '\'-1+1', '\'@SUM(A1)', '\'\t=1', 'Plain text', '\'=quoted already', 'Battle, "two", fleets'])
    assert.equal(rows[0]['Annotation link'], '\'=HYPERLINK("x")')
    assert.equal(rows[1]['Annotation link'], '')
    assert.deepEqual(rows.map((row) => row['Offset to nearest sample (s)']), Array(texts.length).fill('-12.5'))
    assert.ok(table.rows.every((row) => row.Chart === '\'=Wealth'))
    assert.deepEqual(samplesOf(table).map((row) => row.Series), Array(3).fill('\'=Treasury'))
    assert.deepEqual(samplesOf(table).map((row) => row.Value), ['-5', '', '1234.5'])
    assert.equal(samplesOf(table)[1]['Missing inputs'], '\'-missing')
    assert.ok(table.rows.some((row) => row.Record === 'context' && row.Note === '\'-1 of 3 snapshots have no figure'))
    assert.ok(table.rows.some((row) => row.Record === 'context' && row.Series === '\'=Treasury'))

    const numberColumns = CSV_COLUMNS.filter((name) => /\((s|t)\)$/.test(name) || name === 'Value')

    table.rows.forEach((row) => numberColumns.forEach((name) => assert.equal(row[name].startsWith('\''), false, name)))

    const { header, cells } = tableOf(text)

    assert.deepEqual(header, CSV_COLUMNS)
    cells.forEach((row) => row.forEach((value, index) => assert.equal(/^[=+\-@\t\r]/.test(value) && !numberColumns.includes(CSV_COLUMNS[index]), false, `${CSV_COLUMNS[index]}: ${value}`)))
  })

  check('csv', 'a spy-mode export says so, and an export of the selected race says it holds no other race', () => {
    const spy = tableOf(exportCsv(modelOf(m, { scope: { ...SCOPE, spy: true } })))
    const own = tableOf(exportCsv(modelOf(m)))

    assert.ok(spy.rows.some((row) => /^Spy mode: .*other races/.test(row.Note)))
    assert.equal(own.rows.some((row) => /Spy mode/.test(row.Note)), false)
  })

  check('csv', 'a view of several races states the window, the counts and the sampling of each race apart, from the samples it draws, and no race takes the bounds of another', () => {
    const selected = { label: 'Test Race (race 7)', window: { count: 3, retained: 6, from: 400, to: 900 }, retention: '6 samples; gaps up to 3 y (typical 2 y). Thinning unknown: nothing is known.' }
    const rival = { label: 'Rival Empire (race 9)', window: { count: 2, retained: 5, from: 50.5, to: 700.25 }, retention: 'Rival: 5 samples; gaps up to 9 y (typical 4 y). Thinning known: the older half was thinned.' }
    const model = modelOf(m, { scope: { ...SCOPE, spy: true }, window: { span: 10 }, races: [selected, rival] })
    const notes = tableOf(exportCsv(model)).rows.filter((row) => row.Record === 'context').map((row) => row.Note)
    const windowNote = notes.find((note) => /race by race: /.test(note) && /^The last 10 years/.test(note))
    const sampling = notes.find((note) => /^Sampling, race by race: /.test(note))

    assert.ok(windowNote.startsWith('The last 10 years before the selected race\'s latest snapshot, race by race: '))
    assert.ok(windowNote.includes('Test Race (race 7): 3 of 6 retained snapshots, from date(400) (400 s) to date(900) (900 s)'))
    assert.ok(windowNote.includes('Rival Empire (race 9): 2 of 5 retained snapshots, from date(50.5) (50.5 s) to date(700.25) (700.25 s)'))
    assert.ok(sampling.includes(`Test Race (race 7): ${selected.retention}`))
    assert.ok(sampling.includes(`Rival Empire (race 9): ${rival.retention}`))
    assert.equal(sampling.includes(RETENTION), false)
    assert.equal(notes.some((note) => /^(Every retained snapshot|The last \d+ years before the latest snapshot): /.test(note)), false)
    assert.ok(notes.some((note) => /the nearest sample, one of the selected race's, is named beside it/.test(note)))

    const lines = captionLines(model).map((line) => line.text)

    assert.ok(lines.includes(windowNote))
    assert.ok(lines.includes(sampling))

    const none = modelOf(m, { scope: { ...SCOPE, spy: true }, window: { span: 0 }, races: [selected, { ...rival, window: { count: 0, retained: 5 } }] })

    assert.ok(none.facts.window.includes('Rival Empire (race 9): no snapshot lies in this window'))
    assert.ok(none.facts.window.startsWith('Every retained snapshot, race by race: '))
  })

  check('csv', 'the values are the ones given: no sample is added, dropped or reordered, in any series', () => {
    const table = tableOf(exportCsv(modelOf(m, { series: [treasury, income, { ...duranium, label: 'Dur' }] })))

    assert.deepEqual(samplesOf(table, 'Annual income').map((row) => row.Value), ['5', '6.5', ''])
    assert.deepEqual(samplesOf(table).map((row) => row.Series), ['Treasury', 'Treasury', 'Treasury', 'Annual income', 'Annual income', 'Annual income', 'Dur', 'Dur', 'Dur'])
  })

  check('csv', 'a rule that is not registered and a column that is not documented are refused', () => {
    assert.throws(() => modelOf(m, { series: [{ ...treasury, rule: 'history.nothing' }] }), /not registered/)
    assert.equal(typeof exportCsv, 'function')
  })

  check('caption', 'the caption has the title, the race, who may see the data, the window and each series with its unit, its recorded samples and its rule status', () => {
    const lines = captionLines(modelOf(m))
    const text = (role) => lines.filter((line) => line.role === role).map((line) => line.text)

    assert.deepEqual(text('title'), ['Wealth'])
    assert.deepEqual(text('subtitle'), ['Race: Test Race (race 7) in game 1, campaign c1, branch b1.', 'Scope: the selected race only; no other race is included.', 'The last 10 years before the latest snapshot: 3 of 8 retained snapshots, from date(100.5) (100.5 s) to date(1000) (1000 s).'])
    assert.deepEqual(text('series'), ['Treasury (wealth): 2 of 3 samples recorded, 1 not recorded (not 0); history.treasury, confirmed.', 'Annual income (wealth/yr): 2 of 3 samples recorded, 1 not recorded (not 0); history.income, estimated.'])
  })

  check('caption', 'the caption states the sampling limits: the retention note, time before the first snapshot never observed, not a continuous record, not 0', () => {
    const text = captionLines(modelOf(m)).map((line) => line.text).join('\n')

    assert.ok(text.includes(RETENTION))
    assert.match(text, /Game time before the first snapshot was never observed and is not inferred/)
    assert.match(text, /aggregate figures only/)
    assert.match(text, /not a continuous record/)
    assert.match(text, /it is not 0/)
    assert.match(text, /2 more kept for this race and branch are not exported/)
  })

  check('caption', 'the rules are listed once each with their status and standing assumptions, and the notes of the chart under their own heading', () => {
    const lines = captionLines(modelOf(m, { series: [{ ...treasury, label: 'A' }, { ...treasury, label: 'B' }, { ...income, rule: 'history.fleetTonnage', label: 'C' }] }))
    const rules = lines.filter((line) => line.role === 'text' && /^history\./.test(line.text)).map((line) => line.text)

    assert.equal(rules.length, 2)
    assert.match(rules[0], /^history\.treasury \(confirmed\): /)
    assert.match(rules[1], /^history\.fleetTonnage \(estimated\): .*50 t per hull space/)
    assert.deepEqual(lines.filter((line) => line.role === 'heading').map((line) => line.text), ['Series', 'Rules and assumptions', 'Notes', 'Coverage and limits', 'Annotations'])
  })

  check('caption', 'the caption lists the annotations with their date, type, text, link and ID, and none when there are none', () => {
    const lines = captionLines(modelOf(m)).filter((line) => line.role === 'annotation').map((line) => line.text)

    assert.equal(lines.length, 2)
    assert.equal(lines[0], `time(250.25): Battle, First "contact", at\nthe border (Fleet: Third Fleet, linked) [${uuid(1)}]`)
    assert.equal(lines[1], `time(600.125): Discovery, Between two samples [${uuid(2)}]`)

    const none = captionLines(modelOf(m, { annotations: [], unseen: 0 }))

    assert.equal(none.filter((line) => line.role === 'annotation').length, 0)
    assert.equal(none.some((line) => line.text === 'Annotations'), false)
    assert.ok(none.some((line) => /0 drawn in this window/.test(line.text)))
  })

  check('caption', 'the baseline of a change is in the caption with its stock, and a stock not recorded is named', () => {
    const text = captionLines(modelOf(m, { series: [duranium, { ...duranium, label: 'Neutronium', baseline: { t: 100.5, stock: null } }] })).filter((line) => line.role === 'series').map((line) => line.text)

    assert.match(text[0], /Change from the baseline of 10 t at game time 100\.5 s\./)
    assert.match(text[1], /Change from the baseline of a stock that was not recorded at game time 100\.5 s\./)
  })

  check('caption', 'the spy label is on a spy-mode caption only', () => {
    const spy = captionLines(modelOf(m, { scope: { ...SCOPE, spy: true } }))
    const own = captionLines(modelOf(m))

    assert.equal(spy[0].text, 'Wealth (spy mode)')
    assert.match(spy[2].text, /^Spy mode: /)
    assert.equal(own[0].text, 'Wealth')
    assert.equal(own.some((line) => /spy/i.test(line.text)), false)
  })

  const pictureOf = (model, { width = 600, height = 240, density = 2 } = {}) => {
    const sheet = recording()
    const source = { canvas: { width: width * density, height: height * density }, width, height }
    const caption = captionLines(model)
    const picture = drawExport({ make: sheet.make, source, caption, legend: model.series.map((_entry, index) => ({ color: `#${index}${index}${index}`, dash: index ? [4, 2] : [] })), theme: THEME, type: TYPE })

    return { sheet, source, caption, picture }
  }

  check('picture', 'the picture draws every line of the caption, wrapped, and no other text', () => {
    const { sheet, caption } = pictureOf(modelOf(m))
    const drawn = norm(sheet.texts().map((event) => event.args[0]).join(' '))

    assert.equal(drawn, norm(caption.map((line) => line.text).join(' ')))
    assert.ok(sheet.texts().length > caption.length, 'long lines are wrapped onto more lines')
  })

  check('picture', 'no line of the caption is wider than the picture, and a word wider than the picture is broken', () => {
    const long = { ...annotations[0], text: 'Q'.repeat(190) }
    const { sheet, picture } = pictureOf(modelOf(m, { annotations: [long] }))

    sheet.texts().forEach((event) => assert.ok(event.args[0].length * 6 <= picture.width - 32, `too wide: ${event.args[0]}`))
    assert.equal(sheet.texts().map((event) => event.args[0]).join('').split('Q').length - 1, 190)
  })

  check('picture', 'the chart canvas is drawn once at its own size between the title and the rest of the caption, on the chart\'s surface colour', () => {
    const { sheet, source } = pictureOf(modelOf(m))
    const calls = sheet.events.map((event) => event.call)
    const image = sheet.events.findIndex((event) => event.call === 'drawImage')

    assert.equal(sheet.events.filter((event) => event.call === 'drawImage').length, 1)
    assert.equal(sheet.events[image].args[0], source.canvas)
    assert.deepEqual(sheet.events[image].args.slice(3), [600, 240])
    assert.equal(calls.indexOf('fillRect') < image, true)
    assert.equal(sheet.events.find((event) => event.call === 'fillRect').state.fillStyle, THEME.surface)
    assert.equal(sheet.events.find((event) => event.call === 'fillRect').args.join(','), `0,0,${pictureOf(modelOf(m)).picture.width},${pictureOf(modelOf(m)).picture.height}`)

    const texts = sheet.events.map((event, index) => [event, index]).filter(([event]) => event.call === 'fillText')

    assert.equal(texts[0][0].args[0], 'Wealth')
    assert.equal(texts[0][1] < image, true)
    assert.equal(norm(texts.filter(([, index]) => index < image).map(([event]) => event.args[0]).join(' ')), norm(captionLines(modelOf(m)).slice(0, 4).map((line) => line.text).join(' ')))
    assert.equal(texts[texts.length - 1][1] > image, true)
    assert.equal(sheet.texts().find((event) => event.args[0] === 'Series').args[2] > sheet.events[image].args[2] + 240 - 1, true, 'the heading of the series is under the chart')
  })

  check('picture', 'the picture has the density of the chart and is wide enough for it and for a caption that can be read', () => {
    const wide = pictureOf(modelOf(m), { width: 1200, height: 300, density: 2 })
    const narrow = pictureOf(modelOf(m), { width: 300, height: 240, density: 1 })

    assert.equal(wide.picture.width, 1232)
    assert.equal(wide.picture.canvas.width, 2464)
    assert.equal(Math.ceil(wide.picture.height * 2), wide.picture.canvas.height)
    assert.equal(narrow.picture.width, 640)
    assert.equal(narrow.picture.canvas.width, 640)
  })

  check('picture', 'each series line has a key in the colour and dash of its series', () => {
    const { sheet } = pictureOf(modelOf(m))
    const keys = sheet.events.filter((event) => event.call === 'stroke').map((event) => event.state.strokeStyle)
    const dashes = sheet.events.filter((event) => event.call === 'setLineDash').map((event) => event.args[0])

    assert.deepEqual(keys, ['#000', '#111'])
    assert.deepEqual(dashes, [[], [4, 2]])
  })

  check('picture', 'the picture draws the whole caption: the rules, the sampling limits and the annotations are under the chart', () => {
    const { sheet } = pictureOf(modelOf(m))
    const drawn = sheet.texts().map((event) => event.args[0]).join(' ')

    assert.match(drawn, /history\.income \(estimated\)/)
    assert.match(drawn, /not a continuous record/)
    assert.match(drawn, new RegExp(uuid(2)))
  })

  return checks
}

// ---- The page ---------------------------------------------------------------------------------------------------------

const pageSource = () => fs.readFileSync(pageFile, 'utf8').replace(/\r\n/g, '\n')

// The times of the fixture's snapshots: 30 years with fractions of a second, so a window of 10 years cuts it and every time is exact only if nothing rounds it.
const TIMES = [0.5, 3 * YEAR + 7.25, 8 * YEAR, 12 * YEAR + 86400, 19 * YEAR, 25 * YEAR + 3600.5, 29 * YEAR, 30 * YEAR + 0.125]

const snapshotAt = (t, extra = {}) => ({ t, population: 100 + t / YEAR, colonies: 3, wealth: 1000 + t / YEAR, income: 50, fuel: 500, msp: 20, minerals: [10, 0, 30, 40, 50, 60, 70, 80, 90, 100, 110 + t / YEAR], militaryShips: 2, militaryTons: 1000, commercialShips: 1, commercialTons: 500, installations: { 1: 5, 2: 3 }, research: 700, systems: 9, commanders: 4, ...extra })

const FIXTURE_SNAPSHOTS = TIMES.map((t, index) => snapshotAt(t, index === 5 ? { population: null, fuel: null, minerals: null, installations: null } : index === 6 ? { wealth: 0 } : {}))

const RIVAL = { raceName: 'Rival Empire', npr: true, snapshots: [0.5, 12 * YEAR, 29 * YEAR].map((t) => snapshotAt(t, { wealth: 987654.5, population: 555.5 })) }

const csvOf = (vm, key) => {
  const saved = { document: globalThis.document, Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  const files = []
  let text = null
  const link = { href: '', download: '', click () { files.push({ name: link.download, text }) } }

  globalThis.document = { createElement: () => link }
  globalThis.Blob = class { constructor (parts) { text = parts.join('') } }
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}

  try {
    vm.downloadChartCsv(key)
  } finally {
    globalThis.document = saved.document
    globalThis.Blob = saved.Blob
    URL.createObjectURL = saved.create
    URL.revokeObjectURL = saved.revoke
  }

  return files.length ? { name: files[0].name, text: files[0].text, ...tableOf(files[0].text) } : null
}

const pageSuite = async (m, { mutate = null, saves = null } = {}) => {
  const options = await loadPage('pages/history', { stubs: STUBS, modules: PAGE_MODULES, mutate })
  const checks = []
  const check = (name, run) => checks.push({ group: 'page', name, run })
  const saveCheck = (name, run) => checks.push({ group: 'saves', name, run })
  const { milestones } = m
  const { captionLines } = m.exportation

  const mounted = ({ campaign = { campaignId: 'c1', branchId: 'b1', generation: 1 }, GameTime = TIMES[TIMES.length - 1], data = {}, snapshots = FIXTURE_SNAPSHOTS, rivals = true, rival = RIVAL, startYear = START_YEAR, GameID = 1, RaceID = 7, raceName = 'Test Race' } = {}) => {
    const w = world(m)
    const races = { [RaceID]: { raceName, npr: false, snapshots }, ...(rivals ? { 9: rival } : {}) }
    const store = { getters: { config: { get: (_key, fallback) => fallback }, database: null, GameID, GameTime, RaceID, StartYear: startYear, historyRecorded: true, 'history/campaign': campaign }, state: { history: { revision: 0 } } }
    const vm = instantiate(options, { $store: store, database: null, GameID, RaceID, data: { gameHistory: { gameName: 'Game', races }, campaignView: null, theme: { categorical: ['#111', '#222', '#333'], ...THEME }, records: { repository: w.repo, error: null }, ...data } })

    return { vm, w, GameTime, RaceID }
  }

  const annotate = async (context, ...list) => {
    for (const { madeAt, ...item } of list) {
      await milestones.saveMilestone(context.w.repo, scope(madeAt === undefined ? context.GameTime : madeAt, 'b1', 'c1', context.RaceID), item)
    }

    context.vm.milestoneRevision += 1
  }

  const KEYS = ['population', 'wealth', 'fleet', 'research', 'minerals', 'installations', 'logistics']

  const numberOr = (value) => (value === null ? '' : String(value))

  check('every chart\'s CSV holds exactly the series the chart draws, with one row for each snapshot of the window', () => {
    const { vm } = mounted()

    assert.deepEqual(vm.charts.map((chart) => chart.key), KEYS)
    KEYS.forEach((key) => {
      const chart = vm.charts.find((entry) => entry.key === key)
      const table = csvOf(vm, key)
      const labels = chart.data.datasets.map((dataset) => dataset.label)

      assert.ok(table, key)
      assert.equal(table.name, `Test_Race-${key}-shown.csv`)
      assert.deepEqual([...new Set(samplesOf(table).map((row) => row.Series))], labels, key)
      chart.data.datasets.forEach((dataset) => {
        const rows = samplesOf(table, dataset.label)

        assert.deepEqual(rows.map((row) => Number(row[SAMPLE_TIME])), vm.snapshots.map((snapshot) => snapshot.t), `${key} ${dataset.label}`)
        assert.deepEqual(rows.map((row) => row.Value), dataset.data.map((point) => numberOr(point.y)), `${key} ${dataset.label}`)
      })
    })
  })

  check('a series the chart does not draw is not exported: a mineral that is not picked, a change that is undefined, a type that is not chosen', () => {
    const { vm } = mounted({ data: { mineralIds: [1, 2], installationIds: [1] } })
    const absolute = csvOf(vm, 'minerals')

    assert.deepEqual([...new Set(samplesOf(absolute).map((row) => row.Series))], ['Duranium', 'Neutronium'])
    assert.deepEqual([...new Set(samplesOf(csvOf(vm, 'installations')).map((row) => row.Series))], vm.charts.find((chart) => chart.key === 'installations').data.datasets.map((dataset) => dataset.label))
    assert.equal(samplesOf(csvOf(vm, 'installations')).length, vm.snapshots.length)

    vm.mineralScale = 'percent'

    const percent = csvOf(vm, 'minerals')

    assert.deepEqual([...new Set(samplesOf(percent).map((row) => row.Series))], ['Duranium'], 'Neutronium has a baseline of 0 t, so its change is undefined and it has no line')
    assert.equal(percent.text.includes('Neutronium'), true, 'the note says why it has no line')
    assert.ok(percent.rows.some((row) => /Neutronium: change undefined/.test(row.Note)))
    assert.equal(samplesOf(percent).every((row) => row.Unit === '%'), true)

    const none = mounted({ data: { mineralIds: [] } }).vm

    assert.equal(csvOf(none, 'minerals'), null, 'nothing is drawn, so nothing is exported')
    assert.equal(none.exportEmpty(none.charts.find((chart) => chart.key === 'minerals')), true)
  })

  check('on the percent scale every sample carries the stock behind it and the baseline of the window', () => {
    const { vm } = mounted({ data: { mineralScale: 'percent', mineralIds: [1, 11] } })
    const table = csvOf(vm, 'minerals')
    const rows = samplesOf(table, 'Duranium')

    assert.deepEqual(rows.map((row) => row['Baseline game time (s)']), rows.map(() => String(vm.snapshots[0].t)))
    assert.deepEqual(rows.map((row) => row['Baseline stock (t)']), rows.map(() => '10'))
    assert.deepEqual(rows.map((row) => row['Stock behind the change (t)']), vm.snapshots.map((snapshot) => numberOr(snapshot.minerals ? snapshot.minerals[0] : null)))
    assert.deepEqual(rows.map((row) => row.Value), vm.snapshots.map((snapshot) => (snapshot.minerals ? '0' : '')))
    assert.ok(table.rows.some((row) => /baseline 10 t, at/.test(row.Note)), 'the note of the chart is in the export')
    assert.ok(table.rows.some((row) => /Change is measured from each mineral's stock in the first snapshot of the span/.test(row.Note)))
  })

  check('the window: a span exports only the samples in it and says how many of the retained snapshots they are', () => {
    const { vm } = mounted({ data: { span: 10 } })
    const inWindow = TIMES.filter((t) => t >= TIMES[TIMES.length - 1] - 10 * YEAR)

    assert.deepEqual(vm.snapshots.map((snapshot) => snapshot.t), inWindow)
    assert.ok(inWindow.length < TIMES.length)
    KEYS.forEach((key) => {
      const table = csvOf(vm, key)

      assert.deepEqual([...new Set(samplesOf(table).map((row) => Number(row[SAMPLE_TIME])))], inWindow, key)
      assert.equal(samplesOf(table).every((row) => inWindow.includes(Number(row[SAMPLE_TIME]))), true, key)
    })

    const table = csvOf(vm, 'population')

    assert.ok(table.rows.some((row) => row.Note.startsWith(`The last 10 years before the latest snapshot: ${inWindow.length} of ${TIMES.length} retained snapshots, from ${vm.date(inWindow[0])} (${inWindow[0]} s) to ${vm.date(inWindow[inWindow.length - 1])} (${inWindow[inWindow.length - 1]} s).`)))

    const all = csvOf(mounted().vm, 'population')

    assert.ok(all.rows.some((row) => row.Note.startsWith(`Every retained snapshot: ${TIMES.length} of ${TIMES.length} retained snapshots`)))
  })

  check('the window: the sampling limits of the record are in every export', () => {
    const { vm } = mounted()

    KEYS.forEach((key) => {
      const note = csvOf(vm, key).rows.find((row) => row.Record === 'context' && /^Sampling: /.test(row.Note)).Note

      assert.ok(note.includes(vm.recording.sampling), key)
      assert.match(note, /never observed/)
    })
  })

  check('a figure not recorded is empty, says not recorded and names what is missing, in every chart', () => {
    const { vm } = mounted()
    const gone = TIMES[5]

    ;[['population', 'Population'], ['logistics', 'Fuel (L)'], ['minerals', 'Duranium'], ['installations', vm.charts.find((chart) => chart.key === 'installations').data.datasets[0].label]].forEach(([key, label]) => {
      const row = samplesOf(csvOf(vm, key), label).find((entry) => Number(entry[SAMPLE_TIME]) === gone)

      assert.equal(row.Value, '', `${key} ${label}`)
      assert.equal(row['Value status'], 'not recorded', `${key} ${label}`)
      assert.notEqual(row['Missing inputs'], '', `${key} ${label}`)
    })

    const recordedZero = samplesOf(csvOf(vm, 'wealth'), 'Treasury').find((entry) => Number(entry[SAMPLE_TIME]) === TIMES[6])

    assert.equal(recordedZero.Value, '0')
    assert.equal(recordedZero['Value status'], 'recorded')
    KEYS.forEach((key) => assert.equal(samplesOf(csvOf(vm, key)).filter((row) => row['Value status'] === 'not recorded').every((row) => row.Value === ''), true, key))
  })

  check('only the annotations the chart draws are exported, at their exact time, with the rest counted and not exported', async () => {
    const context = mounted({ GameTime: 20 * YEAR })
    const { vm } = context
    const between = 8 * YEAR + 1000.75
    const atSample = 3 * YEAR + 7.25

    await annotate(context, { t: between, type: 'battle', text: 'Between, "two", samples' }, { t: atSample, type: 'discovery', text: 'At a sample' }, { t: 25 * YEAR + 5, type: 'loss', text: 'Ahead of the save', madeAt: 25 * YEAR + 5 })

    assert.equal(vm.milestoneEntries.length, 3)
    assert.equal(vm.milestoneEntries.filter((entry) => entry.drawn).length, 2)

    const table = csvOf(vm, 'population')
    const rows = table.rows.filter((row) => row.Record === 'annotation')

    assert.deepEqual(rows.map((row) => row['Annotation text']), ['At a sample', 'Between, "two", samples'])
    assert.deepEqual(rows.map((row) => Number(row[ANNOTATION_TIME])), [atSample, between])
    assert.deepEqual(rows.map((row) => row['Annotation ID']), vm.milestoneEntries.filter((entry) => entry.drawn).sort((a, b) => a.t - b.t).map((entry) => entry.uuid))
    assert.deepEqual(rows.map((row) => row['Annotation type']), ['Discovery', 'Battle'])
    assert.ok(table.rows.some((row) => /2 drawn in this window.*1 more kept for this race and branch are not exported/.test(row.Note)))
    assert.equal(table.text.includes('Ahead of the save'), false)
    assert.equal(samplesOf(table).some((row) => Number(row[SAMPLE_TIME]) === between), false, 'an annotation time is not a sample time')
    KEYS.forEach((key) => assert.equal(csvOf(vm, key).rows.filter((row) => row.Record === 'annotation').length, 2, key))
  })

  check('an annotation outside the window is not exported, and its nearest sample is a sample of the window', async () => {
    const context = mounted({ data: { span: 10 } })
    const { vm } = context
    const early = 8 * YEAR + 1000.75
    const inside = 26 * YEAR + 99.5

    await annotate(context, { t: early, type: 'battle', text: 'Long ago' }, { t: inside, type: 'other', text: 'Inside the window' })

    const table = csvOf(vm, 'wealth')
    const rows = table.rows.filter((row) => row.Record === 'annotation')
    const windowTimes = vm.snapshots.map((snapshot) => snapshot.t)

    assert.deepEqual(rows.map((row) => row['Annotation text']), ['Inside the window'])
    assert.equal(table.text.includes('Long ago'), false)
    assert.ok(table.rows.some((row) => /1 drawn in this window.*1 more kept/.test(row.Note)))
    assert.equal(windowTimes.includes(Number(rows[0]['Nearest sample game time (s)'])), true)
    assert.equal(Number(rows[0]['Nearest sample game time (s)']), TIMES[5], 'the nearest sample of the window')
    assert.equal(Number(rows[0]['Offset to nearest sample (s)']), inside - TIMES[5])
  })

  check('only the annotations the chart draws: the table view draws none, so exports none', async () => {
    const context = mounted({ data: { view: 'table' } })

    await annotate(context, { t: 8 * YEAR + 1, type: 'battle', text: 'On the charts only' })

    const table = csvOf(context.vm, 'table')

    assert.equal(table.rows.filter((row) => row.Record === 'annotation').length, 0)
    assert.equal(table.text.includes('On the charts only'), false)
    assert.ok(table.rows.some((row) => /this view does not draw them, so none is exported/.test(row.Note)))
  })

  check('spy mode off: no export names another race, and the Rivals chart is not on screen to export', async () => {
    const context = mounted({ data: { spyNPR: false } })
    const { vm } = context

    assert.equal(vm.rivals, null)
    assert.equal(vm.exportOf('rivals'), null)
    assert.equal(csvOf(vm, 'rivals'), null)

    await annotate(context, { t: 8 * YEAR + 1, type: 'battle', text: 'Note' })

    ;[...KEYS, 'table'].forEach((key) => {
      const view = key === 'table' ? mounted({ data: { view: 'table' } }).vm : vm
      const exported = view.exportOf(key)
      const text = `${csvOf(view, key).text}\n${captionLines(exported.model).map((line) => line.text).join('\n')}`

      assert.equal(text.includes('Rival'), false, key)
      assert.equal(text.includes('987654.5'), false, key)
      assert.equal(text.includes('555.5'), false, key)
      assert.equal(/Spy mode/.test(text), false, key)
      assert.equal(exported.model.spy, false)
    })
  })

  check('spy mode on: the Rivals export holds every race shown and says spy mode, and the other charts stay with the selected race', () => {
    const { vm } = mounted({ data: { spyNPR: true } })
    const rivals = csvOf(vm, 'rivals')
    const labels = vm.rivals.data.datasets.map((dataset) => dataset.label)

    assert.deepEqual(labels, ['Test Race', 'Rival Empire'])
    assert.equal(rivals.name, 'Test_Race-rivals-shown.csv')
    assert.deepEqual([...new Set(samplesOf(rivals).map((row) => row.Series))], labels)
    assert.deepEqual(samplesOf(rivals, 'Rival Empire').map((row) => Number(row[SAMPLE_TIME])), RIVAL.snapshots.map((snapshot) => snapshot.t))
    assert.deepEqual(samplesOf(rivals, 'Rival Empire').map((row) => row.Value), RIVAL.snapshots.map(() => '555.5'))
    assert.equal(samplesOf(rivals).every((row) => row.Unit === 'M people' && row.Rule === 'history.population'), true)
    assert.ok(rivals.rows.some((row) => /^Spy mode: /.test(row.Note)))
    assert.equal(rivals.rows[0].Chart, 'Rivals: Population')
    assert.equal(vm.exportOf('rivals').model.spy, true)
    assert.equal(captionLines(vm.exportOf('rivals').model)[0].text, 'Rivals: Population (spy mode)')

    KEYS.forEach((key) => {
      const text = csvOf(vm, key).text

      assert.equal(text.includes('Rival Empire'), false, key)
      assert.equal(text.includes('987654.5'), false, key)
      assert.equal(vm.exportOf(key).model.spy, false, key)
    })

    vm.rivalMetric = 'wealth'
    vm.span = 10

    const wealth = csvOf(vm, 'rivals')

    assert.deepEqual(samplesOf(wealth, 'Rival Empire').map((row) => Number(row[SAMPLE_TIME])), RIVAL.snapshots.map((snapshot) => snapshot.t).filter((t) => t >= vm.since))
    assert.equal(samplesOf(wealth, 'Rival Empire').every((row) => row.Unit === 'wealth'), true)
  })

  check('the Rivals export states the window, the counts and the sampling of each race over its own samples, never the selected race\'s for another', () => {
    const early = { raceName: 'Early Rival', npr: true, snapshots: [2 * YEAR + 3, 6 * YEAR, 12 * YEAR, 31 * YEAR + 0.25].map((t) => snapshotAt(t, { population: 555.5 })) }
    const own = FIXTURE_SNAPSHOTS.slice(3)
    const { vm } = mounted({ data: { spyNPR: true }, snapshots: own, rival: early })
    const notesOf = (key) => csvOf(vm, key).rows.filter((row) => row.Record === 'context').map((row) => row.Note)
    const clause = (kept, retained) => `${kept.length} of ${retained.length} retained snapshots, from ${vm.date(kept[0].t)} (${kept[0].t} s) to ${vm.date(kept[kept.length - 1].t)} (${kept[kept.length - 1].t} s)`
    const sampling = (record) => m.history.retentionNote(record, (t) => vm.date(t))
    const selected = vm.gameHistory.races[7]

    assert.equal(vm.snapshots.length, own.length)
    assert.notEqual(own[0].t, early.snapshots[0].t)
    assert.notEqual(own[own.length - 1].t, early.snapshots[early.snapshots.length - 1].t)
    assert.notEqual(sampling(selected), sampling(early))

    const all = notesOf('rivals')
    const window = all.find((note) => /^Every retained snapshot, race by race: /.test(note))
    const coverage = all.find((note) => /^Sampling, race by race: /.test(note))

    assert.ok(window.includes(`Test Race (race 7): ${clause(own, own)}`))
    assert.ok(window.includes(`Early Rival (race 9): ${clause(early.snapshots, early.snapshots)}`))
    assert.ok(coverage.includes(`Test Race (race 7): ${sampling(selected)}`))
    assert.ok(coverage.includes(`Early Rival (race 9): ${sampling(early)}`))
    assert.equal(all.some((note) => /^(Every retained snapshot|The last \d+ years before the latest snapshot): /.test(note)), false)

    const lines = captionLines(vm.exportOf('rivals').model).map((line) => line.text)

    assert.ok(lines.includes(window))
    assert.ok(lines.includes(coverage))

    const rivals = csvOf(vm, 'rivals')

    ;[['Test Race', own], ['Early Rival', early.snapshots]].forEach(([label, list]) => {
      const times = samplesOf(rivals, label).map((row) => Number(row[SAMPLE_TIME]))

      assert.deepEqual(times, list.map((snapshot) => snapshot.t), label)
    })

    vm.span = 10

    const keptOwn = own.filter((snapshot) => snapshot.t >= vm.since)
    const keptEarly = early.snapshots.filter((snapshot) => snapshot.t >= vm.since)
    const windowed = notesOf('rivals').find((note) => /^The last 10 years before the selected race's latest snapshot, race by race: /.test(note))

    assert.equal(keptOwn.length, 3)
    assert.equal(keptEarly.length, 1)
    assert.ok(windowed.includes(`Test Race (race 7): ${clause(keptOwn, own)}`))
    assert.ok(windowed.includes(`Early Rival (race 9): ${clause(keptEarly, early.snapshots)}`))
    assert.deepEqual(samplesOf(csvOf(vm, 'rivals'), 'Early Rival').map((row) => Number(row[SAMPLE_TIME])), keptEarly.map((snapshot) => snapshot.t))
    assert.ok(notesOf('population').some((note) => note.startsWith('The last 10 years before the latest snapshot: ')), 'a chart of the selected race alone keeps its own statement')
  })

  check('a view that is not on screen is not exported: the table in the charts view, a chart in the table view', () => {
    const charts = mounted().vm
    const table = mounted({ data: { view: 'table' } }).vm

    assert.equal(charts.exportOf('table'), null)
    assert.equal(csvOf(charts, 'table'), null)
    KEYS.forEach((key) => {
      assert.equal(table.exportOf(key), null, key)
      assert.equal(csvOf(table, key), null, key)
    })
    assert.equal(charts.exportOf('population').view.key, 'population')
    assert.equal(table.exportOf('table').view.key, 'table')
    assert.equal(charts.exportOf('nothing'), null)
  })

  check('the table export is the table view\'s: every snapshot of the window, oldest first, a series for each figure column, and no other', () => {
    const { vm } = mounted({ data: { view: 'table', span: 10 } })
    const table = csvOf(vm, 'table')
    const labels = vm.tableHeaders.slice(1).map((header) => header.text)

    assert.equal(table.name, 'Test_Race-table-shown.csv')
    assert.deepEqual([...new Set(samplesOf(table).map((row) => row.Series))], labels)
    assert.equal(samplesOf(table).length, labels.length * vm.snapshots.length)
    labels.forEach((label, index) => {
      const rows = samplesOf(table, label)
      const key = vm.tableHeaders[index + 1].value

      assert.deepEqual(rows.map((row) => Number(row[SAMPLE_TIME])), vm.snapshots.map((snapshot) => snapshot.t))
      assert.deepEqual(rows.map((row) => row.Value), vm.snapshots.map((snapshot) => numberOr(snapshot[key] === undefined ? null : snapshot[key])), label)
    })
    assert.equal(samplesOf(table).every((row) => Number(row[SAMPLE_TIME]) >= vm.since), true)
  })

  const ipc = () => {
    const calls = []

    globalThis.__ipc = { calls, result: undefined, invoke: async (...args) => { calls.push(args); return globalThis.__ipc.result } }

    return calls
  }

  const withCanvas = (vm, canvas = { clientWidth: 600, clientHeight: 240, width: 1200, height: 480 }) => {
    const asked = []

    vm.$el = { querySelector: (selector) => { asked.push(selector); return canvas } }
    vm.$nextTick = () => Promise.resolve()
    vm.activateSnackbar = (payload) => { vm.snacks = [...(vm.snacks || []), payload] }
    vm.snacks = []

    return { canvas, asked }
  }

  // The fonts the picture waits for, held until the caller lets go.
  const holdFonts = () => {
    let release = null

    globalThis.__fonts = () => new Promise((resolve) => { release = resolve })

    return () => {
      globalThis.__fonts = undefined
      release()
    }
  }

  const withDocument = (sheet, run) => {
    const saved = globalThis.document

    globalThis.document = { createElement: (tag) => (tag === 'canvas' ? sheet.make(0, 0) : null) }

    return Promise.resolve(run()).finally(() => { globalThis.document = saved })
  }

  check('the picture is saved through the save-png channel, as the map is, with the caption of the export drawn under the chart', async () => {
    const { vm } = mounted()
    const calls = ipc()
    const { canvas, asked } = withCanvas(vm)
    const sheet = recording()

    await withDocument(sheet, () => vm.exportChartPng('population'))

    assert.deepEqual(asked, ['[data-chart="population"] canvas'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'save-png')
    assert.equal(typeof calls[0][1], 'string')
    assert.equal(calls[0][2], 'Test_Race-population-shown.png')
    assert.equal(calls[0][3], 'Save Population as PNG')
    assert.equal(sheet.events.find((event) => event.call === 'drawImage').args[0], canvas)

    const caption = captionLines(vm.exportOf('population').model)

    assert.equal(norm(sheet.texts().map((event) => event.args[0]).join(' ')), norm(caption.map((line) => line.text).join(' ')))
    assert.equal(vm.snacks.length, 1)
    assert.equal(vm.snacks[0].color, 'success')
  })

  check('the picture drawn is the caption of the export: the series, window and annotations of the CSV', async () => {
    const context = mounted({ data: { span: 10 } })
    const { vm } = context

    await annotate(context, { t: 26 * YEAR + 99.5, type: 'battle', text: 'Inside the window' })
    ipc()
    withCanvas(vm)

    const sheet = recording()

    await withDocument(sheet, () => vm.exportChartPng('wealth'))

    const drawn = norm(sheet.texts().map((event) => event.args[0]).join(' '))
    const table = csvOf(vm, 'wealth')
    const windowNote = table.rows.find((row) => /^The last 10 years/.test(row.Note)).Note
    const annotation = table.rows.find((row) => row.Record === 'annotation')

    assert.ok(drawn.includes(norm(windowNote)))
    assert.ok(drawn.includes(annotation['Annotation ID']))
    assert.ok(drawn.includes(annotation['Annotation text']))
    ;[...new Set(samplesOf(table).map((row) => row.Series))].forEach((label) => assert.ok(drawn.includes(`${label} (`), label))
    assert.ok(drawn.includes(norm(table.rows.find((row) => /^Sampling: /.test(row.Note)).Note)))
  })

  check('the picture is not made of a chart that changed while the fonts were awaited: no picture, a note, and nothing drawn', async () => {
    const cases = [
      ['the window', async () => ({ change: (context) => { context.vm.span = 10 } })],
      ['the annotations', async () => ({ change: (context) => annotate(context, { t: 29 * YEAR, type: 'battle', text: 'Made while waiting' }) })],
      ['the series', async () => ({ change: (context) => { context.vm.mineralIds = context.vm.mineralIds.slice(0, 1) }, key: 'minerals' })],
    ]

    for (const [name, make] of cases) {
      const context = mounted()
      const { vm } = context
      const { change, key = 'wealth' } = await make()
      const calls = ipc()

      withCanvas(vm)

      const sheet = recording()
      const release = holdFonts()
      const pending = withDocument(sheet, () => vm.exportChartPng(key))

      await change(context)
      release()
      await pending
      assert.equal(calls.length, 0, name)
      assert.equal(sheet.events.length, 0, name)
      assert.equal(vm.snacks.length, 1, name)
      assert.equal(vm.snacks[0].color, 'warning', name)
      assert.match(vm.snacks[0].text, /changed while its picture was being made/, name)
    }

    const context = mounted()
    const { vm } = context
    const calls = ipc()

    withCanvas(vm)

    const sheet = recording()
    const release = holdFonts()
    const pending = withDocument(sheet, () => vm.exportChartPng('wealth'))

    release()
    await pending
    assert.equal(calls.length, 1, 'a chart that did not change is saved after the wait')
    assert.equal(norm(sheet.texts().map((event) => event.args[0]).join(' ')), norm(captionLines(vm.exportOf('wealth').model).map((line) => line.text).join(' ')))
    assert.equal(vm.snacks[0].color, 'success')
  })

  check('the picture is not made for a view with nothing to show, or that is not on screen, or whose chart is not drawn', async () => {
    const empty = mounted({ data: { mineralIds: [] } }).vm
    const calls = ipc()

    withCanvas(empty)
    await withDocument(recording(), () => empty.exportChartPng('minerals'))
    await withDocument(recording(), () => empty.exportChartPng('rivals'))
    await withDocument(recording(), () => empty.exportChartPng('table'))
    assert.equal(calls.length, 0)
    assert.equal(empty.snacks.length, 0, 'a view with nothing to show is skipped without a word')

    const hidden = mounted().vm

    withCanvas(hidden, { clientWidth: 0, clientHeight: 0, width: 0, height: 0 })
    await withDocument(recording(), () => hidden.exportChartPng('population'))
    assert.equal(calls.length, 0)
    assert.equal(hidden.snacks.length, 0)

    const off = mounted({ data: { spyNPR: false } }).vm

    withCanvas(off)
    await withDocument(recording(), () => off.exportChartPng('rivals'))
    assert.equal(calls.length, 0)
    assert.equal(off.snacks.length, 0)
  })

  check('a cancelled save says nothing, and a save that fails is reported', async () => {
    const { vm } = mounted()
    const calls = ipc()

    withCanvas(vm)
    globalThis.__ipc.result = { canceled: true }
    await withDocument(recording(), () => vm.exportChartPng('wealth'))
    assert.equal(calls.length, 1)
    assert.equal(vm.snacks.length, 0)

    globalThis.__ipc.invoke = async () => { throw new Error('disk full') }
    await withDocument(recording(), () => vm.exportChartPng('wealth'))
    assert.equal(vm.snacks.length, 1)
    assert.equal(vm.snacks[0].color, 'error')
    assert.match(vm.snacks[0].text, /disk full/)
  })

  check('the buttons are in the template of every chart, of the Rivals chart and of the table, and the existing CSV buttons are as they were', () => {
    const text = pageSource()

    assert.match(text, /:data-chart="chart\.key"/)
    assert.match(text, /data-chart="rivals"/)
    assert.equal(text.split('@click="downloadChartCsv(chart.key)"').length, 2)
    assert.equal(text.split('@click="exportChartPng(chart.key)"').length, 2)
    assert.equal(text.split('@click="downloadChartCsv(rivals.key)"').length, 2)
    assert.equal(text.split('@click="exportChartPng(rivals.key)"').length, 2)
    assert.equal(text.split('@click="downloadChartCsv(tableChart.key)"').length, 2)
    assert.equal(text.split('exportChartPng(tableChart').length, 1, 'the table has no picture')
    assert.match(text, /@click="downloadCsv"><v-icon small left>mdi-download<\/v-icon>CSV<\/v-btn>/)
    assert.match(text, /@click="downloadMineralCsv"/)
    assert.equal(text.includes(':disabled="exportEmpty(chart)"'), true)
  })

  check('the save-png handler takes an optional title and keeps the map\'s when there is none', () => {
    const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8')
    const map = fs.readFileSync(path.join(root, 'src', 'renderer', 'pages', 'map.vue'), 'utf8')

    assert.match(main, /ipcMain\.handle\('save-png', \(_event, imageData, filePath, title = 'Save Map as PNG'\) => \{\s+return dialog\.showSaveDialog\(\{\s+title,/)
    assert.match(map, /invoke\('save-png', canvas\.toDataURL\('image\/png'\)\.split\(','\)\[1\], `map-\$\{this\.GameID\}-\$\{this\.RaceID\}-\$\{this\.GameTime\}\.png`\)/)
  })

  if (saves) {
    saves(saveCheck, { mounted, annotate, numberOr, withCanvas, withDocument, ipc })
  }

  return checks
}

// ---- The owner's saves -------------------------------------------------------------------------------------------------

const familyOf = async (m, folder, GameID, RaceID) => {
  if (!fs.existsSync(folder)) {
    return null
  }

  const sqlite3 = localRequire('sqlite3')
  const files = fs.readdirSync(folder).filter((name) => name.endsWith('.db'))
  const opened = []
  const taken = []

  try {
    for (const name of files) {
      const db = new sqlite3.Database(path.join(folder, name), sqlite3.OPEN_READONLY)
      const run = (sql, params = {}) => new Promise((resolve, reject) => db.all(sql, Object.fromEntries(Object.entries(params).map(([key, value]) => [`:${key}`, value])), (error, rows) => (error ? reject(error) : resolve(rows))))
      const database = { query: async (sql, { replacements = {} } = {}) => [await run(sql, replacements)] }

      opened.push(db)

      const [game] = await run('select StartYear from FCT_Game where GameID = :GameID', { GameID })
      const result = game ? await m.history.takeSnapshot(database, { GameID, RaceID }) : null

      if (result) {
        taken.push({ ...result, StartYear: game.StartYear })
      }
    }
  } finally {
    opened.forEach((db) => db.close())
  }

  const snapshots = taken.map((entry) => entry.snapshot).sort((a, b) => a.t - b.t).filter((snapshot, index, list) => index === 0 || snapshot.t !== list[index - 1].t)

  return snapshots.length >= 2 ? { raceName: taken[0].raceName, StartYear: taken[0].StartYear, snapshots, GameID, RaceID } : null
}

const savesChecks = (families) => (check, { mounted, annotate, numberOr, withCanvas, withDocument, ipc }) => {
  const missing = { skipped: 'the owner\'s saves are not here' }
  const KEYS = ['population', 'wealth', 'fleet', 'research', 'minerals', 'installations', 'logistics']

  const realMount = (family, extra = {}) => mounted({ snapshots: family.snapshots, rivals: false, startYear: family.StartYear, GameTime: family.snapshots[family.snapshots.length - 1].t, GameID: family.GameID, RaceID: family.RaceID, raceName: family.raceName, ...extra })

  check('every chart\'s CSV from the real saves has the sample times of the saves, their own figures and empty cells where a save holds none', () => {
    if (!families.length) {
      return missing
    }

    const lines = []

    families.forEach((family) => {
      const { vm } = realMount(family)
      const fields = { population: ['population', 'colonies'], wealth: ['wealth', 'income'], fleet: ['militaryTons', 'commercialTons'], research: ['research', 'systems'], logistics: ['fuel', 'msp'] }

      Object.entries(fields).forEach(([key, names]) => {
        const table = csvOf(vm, key)
        const labels = vm.charts.find((chart) => chart.key === key).data.datasets.map((dataset) => dataset.label)

        names.forEach((name, index) => {
          const rows = samplesOf(table, labels[index])

          assert.deepEqual(rows.map((row) => Number(row[SAMPLE_TIME])), family.snapshots.map((snapshot) => snapshot.t), `${family.raceName} ${key}`)
          assert.deepEqual(rows.map((row) => row.Value), family.snapshots.map((snapshot) => numberOr(snapshot[name] === undefined ? null : snapshot[name])), `${family.raceName} ${name}`)
          assert.deepEqual(rows.map((row) => row['Value status']), family.snapshots.map((snapshot) => (snapshot[name] === null || snapshot[name] === undefined ? 'not recorded' : 'recorded')))
        })
      })

      const minerals = csvOf(vm, 'minerals')

      assert.deepEqual(samplesOf(minerals, 'Duranium').map((row) => row.Value), family.snapshots.map((snapshot) => numberOr(snapshot.minerals ? snapshot.minerals[0] : null)))
      lines.push(`${family.raceName}: ${family.snapshots.length} saves`)
    })

    return lines.join('; ')
  })

  check('a window of the real saves exports only the saves in it, the annotation between two real samples keeps its exact time and its nearest sample is in the window', async () => {
    if (!families.length) {
      return missing
    }

    const [family] = families
    const last = family.snapshots[family.snapshots.length - 1].t
    const span = [10, 20, 50].find((years) => {
      const count = family.snapshots.filter((snapshot) => snapshot.t >= last - years * YEAR).length

      return count >= 2 && count < family.snapshots.length
    })

    if (!span) {
      return { skipped: 'no span of 10, 20 or 50 years cuts these saves' }
    }

    const context = realMount(family, { data: { span } })
    const { vm } = context
    const inWindow = family.snapshots.filter((snapshot) => snapshot.t >= last - span * YEAR)
    const middle = (inWindow[0].t + inWindow[1].t) / 2 + 0.375

    await annotate(context, { t: middle, type: 'research', text: 'Between two saves' }, { t: family.snapshots[0].t, type: 'other', text: 'Before the window' })

    KEYS.forEach((key) => {
      const table = csvOf(vm, key)

      assert.deepEqual([...new Set(samplesOf(table).map((row) => Number(row[SAMPLE_TIME])))], inWindow.map((snapshot) => snapshot.t), key)

      const rows = table.rows.filter((row) => row.Record === 'annotation')

      assert.deepEqual(rows.map((row) => row['Annotation text']), ['Between two saves'], key)
      assert.equal(Number(rows[0][ANNOTATION_TIME]), middle)
      assert.equal(inWindow.map((snapshot) => snapshot.t).includes(Number(rows[0]['Nearest sample game time (s)'])), true)
    })

    return `${inWindow.length} of ${family.snapshots.length} saves in the window`
  })

  check('the picture from the real saves has a caption with the real counts and the sampling limits', async () => {
    if (!families.length) {
      return missing
    }

    const [family] = families
    const { vm } = realMount(family)
    const calls = ipc()
    const sheet = recording()

    withCanvas(vm)
    await withDocument(sheet, () => vm.exportChartPng('research'))

    const drawn = norm(sheet.texts().map((event) => event.args[0]).join(' '))
    const recorded = family.snapshots.filter((snapshot) => snapshot.research !== null && snapshot.research !== undefined).length

    assert.equal(calls.length, 1)
    assert.ok(drawn.includes(`Research (RP) (RP): ${recorded} of ${family.snapshots.length} samples recorded`))
    assert.ok(drawn.includes(`Every retained snapshot: ${family.snapshots.length} of ${family.snapshots.length} retained snapshots`))
    assert.match(drawn, /never observed/)
    assert.match(drawn, /not a continuous record/)
  })
}

// ---- Mutants and the run ------------------------------------------------------------------------------------------------

const UTILITY_MUTATIONS = [
  { name: 'an annotation time is written in the column of the sample time', file: 'history-export.js', find: "'Annotation game time (s)': entry.t, 'Annotation date': entry.date,", replace: "'Sample game time (s)': entry.t, 'Annotation date': entry.date,", fails: ['csv: an annotation time is in its own column', 'csv: an annotation row has its ID'] },
  { name: 'a figure that is not recorded is written as 0', file: 'history-export.js', find: 'value: recorded ? sample.value : null,', replace: 'value: recorded ? sample.value : 0,', fails: ['csv: a figure not recorded is an empty value', 'csv: a sample row has the exact game time'] },
  { name: 'the unit is left out of a sample row', file: 'history-export.js', find: "Series: entry.label, Unit: entry.unit, 'Sample game time (s)': sample.t", replace: "Series: entry.label, 'Sample game time (s)': sample.t", fails: ['csv: every row of a series names its unit'] },
  { name: 'the rule status is left out of a sample row', file: 'history-export.js', find: "'Rule status': entry.ruleStatus, 'Missing inputs'", replace: "'Missing inputs'", fails: ['csv: every row of a series names its unit'] },
  { name: 'the baseline stock of a change is left out', file: 'history-export.js', find: "'Baseline stock (t)': entry.baseline ? entry.baseline.stock : null,", replace: "'Baseline stock (t)': null,", fails: ['csv: a percent series carries the stock'] },
  { name: 'the first sample has a gap of 0', file: 'history-export.js', find: 'gap: index ? sample.t - entry.samples[index - 1].t : null', replace: 'gap: index ? sample.t - entry.samples[index - 1].t : 0', fails: ['csv: the gap since the previous sample'] },
  { name: 'the sampling limits are left out of the caption', file: 'history-export.js', find: "    { role: 'text', text: model.facts.coverage },\n", replace: '', fails: ['caption: the caption states the sampling limits', 'picture: the picture draws the whole caption'] },
  { name: 'the spy label is on every caption', file: 'history-export.js', find: 'model.spy ? `#{model.title} (spy mode)` : model.title', replace: '`#{model.title} (spy mode)`', fails: ['caption: the spy label is on a spy-mode caption only'] },
  { name: 'the picture leaves out the caption under the chart', file: 'history-export.js', find: '  rest.forEach(draw)\n', replace: '', fails: ['picture: the picture draws every line of the caption', 'picture: the picture draws the whole caption'] },
  { name: 'the caption is not wrapped to the picture', file: 'history-export.js', find: 'rows: wrapped(measure, line.text.replace(/\\s+/g, \' \'), limit - (style.indent || 0))', replace: 'rows: [line.text.replace(/\\s+/g, \' \')]', fails: ['picture: no line of the caption is wider than the picture'] },
  { name: 'the picture has no surface colour behind the chart', file: 'history-export.js', find: '  context.fillRect(0, 0, width, height)\n', replace: '', fails: ['picture: the chart canvas is drawn once'] },
  { name: 'the annotations are left out of the caption', file: 'history-export.js', find: '  if (model.annotations.length) {\n    lines.push(', replace: '  if (false) {\n    lines.push(', fails: ['caption: the caption lists the annotations'] },
  { name: 'a text cell that starts like a formula is written as it is', file: 'history-export.js', find: "typeof value === 'string' && !NUMBER_COLUMNS.has(column) && FORMULA_START.test(value) ? ", replace: 'false ? ', fails: ['csv: a text cell that starts like a formula'] },
  { name: 'a number that is negative is guarded like a text cell', file: 'history-export.js', find: "typeof value === 'string' && !NUMBER_COLUMNS.has(column) && FORMULA_START.test(value) ? ", replace: 'FORMULA_START.test(String(value)) ? ', fails: ['csv: a text cell that starts like a formula'] },
  { name: 'the sampling of every race is the first race\'s', file: 'history-export.js', find: "races.map((race) => `#{race.label}: #{race.retention}`).join(' ')", replace: "races.map((race) => `#{race.label}: #{races[0].retention}`).join(' ')", fails: ['csv: a view of several races'] },
  { name: 'the window of every race is the first race\'s', file: 'history-export.js', find: '`#{race.label}: #{spanText(race.window, date)}`', replace: '`#{race.label}: #{spanText(races[0].window, date)}`', fails: ['csv: a view of several races'] },
]

const PAGE_MUTATIONS = [
  { name: 'a series the chart does not draw is exported', mutate: (text) => replacing('      const datasets = view.data.datasets\n', "      const datasets = view.key === 'minerals' ? this.mineralComparison.series.map((entry) => ({ label: entry.name, data: entry.samples.map((sample, position) => ({ y: this.mineralScale === 'percent' ? entry.percent[position] : sample.stock })) })) : view.data.datasets\n")(replacing('series: drawn.map((entry) => ({ unit: percent', 'series: series.map((entry) => ({ unit: percent')(text)), fails: ['page: a series the chart does not draw is not exported'] },
  { name: 'the table export reads the retained snapshots, not the window', mutate: (text) => replacing('times: this.snapshots.map((snapshot) => snapshot.t), results: results(value) }))', 'times: this.allSnapshots.map((snapshot) => snapshot.t), results: results(value) }))')(replacing('const results = (key) => this.snapshots.map((snapshot) => snapshotResult(snapshot, key))\n\n      return {\n        key: \'table\'', 'const results = (key) => this.allSnapshots.map((snapshot) => snapshotResult(snapshot, key))\n\n      return {\n        key: \'table\'')(text)), fails: ['page: the table export is the table view'] },
  { name: 'the time of an annotation is moved to the nearest sample', mutate: replacing('return { id: entry.uuid, t: entry.t, type:', 'return { id: entry.uuid, t: near ? near.sampleT : entry.t, type:'), fails: ['page: only the annotations the chart draws are exported'] },
  { name: 'annotations the chart does not draw are exported', mutate: replacing('annotated ? this.milestoneEntries.filter((entry) => entry.drawn) : []', 'annotated ? this.milestoneEntries : []'), fails: ['page: only the annotations the chart draws are exported', 'page: an annotation outside the window'] },
  { name: 'the table view exports annotations', mutate: replacing('const annotated = view.annotated !== false', 'const annotated = true'), fails: ['page: only the annotations the chart draws: the table view'] },
  { name: 'the Rivals chart is built without spy mode', mutate: replacing('const races = this.spyNPR && this.gameHistory && this.gameHistory.races ?', 'const races = this.gameHistory && this.gameHistory.races ?'), fails: ['page: spy mode off'] },
  { name: 'the Rivals export does not say spy mode', mutate: replacing("spy: key === 'rivals' }", 'spy: false }'), fails: ['page: spy mode on'] },
  { name: 'a figure not recorded is exported as 0', mutate: replacing('value: dataset.data[position].y,', 'value: dataset.data[position].y || 0,'), fails: ['page: a figure not recorded is empty', 'page: every chart'] },
  { name: 'the table is exported from the charts view and a chart from the table view', mutate: replacing("this.view === 'charts' ? [...this.charts, ...(this.rivals ? [this.rivals] : [])] : [this.tableChart]", '[...this.charts, ...(this.rivals ? [this.rivals] : []), this.tableChart]'), fails: ['page: a view that is not on screen is not exported'] },
  { name: 'the window states every retained snapshot as the window', mutate: replacing('retained: this.allSnapshots.length,', 'retained: times.length,'), fails: ['page: the window: a span exports only the samples in it'] },
  { name: 'the picture is drawn from part of the caption', mutate: replacing('caption: captionLines(model), legend', 'caption: captionLines(model).slice(0, 6), legend'), fails: ['page: the picture is saved through the save-png channel', 'page: the picture drawn is the caption of the export'] },
  { name: 'the picture is saved without its title', mutate: replacing(unhashed(', `Save #{model.title} as PNG`)'), ')'), fails: ['page: the picture is saved through the save-png channel'] },
  { name: 'a picture is asked of a view with nothing to show', mutate: replacing('        if (!asked) {\n          return\n        }\n\n        const wanted', '        const wanted'), fails: ['page: the picture is not made for a view with nothing to show'] },
  { name: 'the picture is made of the model taken before the wait for the fonts', mutate: replacing('const exported = this.exportOf(key)\n\n        if (!exported || exportCsv', 'const exported = asked\n\n        if (!exported || exportCsv'), fails: ['page: the picture is not made of a chart that changed while the fonts were awaited'] },
  { name: 'the Rivals export states the window and the sampling of the selected race alone', mutate: replacing('        races,\n        date: (t) => this.date(t),', '        date: (t) => this.date(t),'), fails: ['page: the Rivals export states the window'] },
  { name: 'each race of the Rivals export takes the first and last sample of the selected race', mutate: replacing('from: race.times[0], to: race.times[race.times.length - 1] }', 'from: times[0], to: times[times.length - 1] }'), fails: ['page: the Rivals export states the window'] },
  { name: 'each race of the Rivals export takes the sampling of the selected race', mutate: replacing('retention: retentionNote(race.record, (t) => this.date(t)) }))', 'retention: retentionNote(this.record, (t) => this.date(t)) }))'), fails: ['page: the Rivals export states the window'] },
]

const mutatedCopy = ({ file, find, replace }) => {
  const from = unhashed(find)
  const to = unhashed(replace)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-history-export-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')

  if (source.split(from).length !== 2) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation must apply exactly once to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

const loadModules = async (directory) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory })

  return { exportation: loaded['history-export'], history: loaded.history, milestones: loaded['history-milestones'], records: loaded['scenario-records'] }
}

let failures = 0
let total = 0
let skipped = 0

const show = (name, result, detail = '', skip = false) => {
  if (skip) {
    skipped++
    console.log(`SKIP  ${name}  [${detail}]`)

    return
  }

  const ok = result === true

  total++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const runChecks = async (list, only = null) => {
  const results = []

  for (const { group, name, run } of list) {
    if (only && !only.some((start) => `${group}: ${name}`.startsWith(start))) {
      continue
    }

    try {
      const detail = await run()

      if (detail && typeof detail === 'object' && detail.skipped) {
        results.push([`${group}: ${name}`, true, detail.skipped, true])
      } else {
        results.push([`${group}: ${name}`, true, typeof detail === 'string' ? detail : '', false])
      }
    } catch (error) {
      results.push([`${group}: ${name}`, String((error && error.stack) || error).split('\n').slice(0, 7).join('\n         '), '', false])
    }
  }

  return results
}

const caught = (mutant, results) => {
  const expected = mutant.fails.filter((start) => !results.some(([name, , , skip]) => skip && name.startsWith(start)))
  const survived = expected.filter((start) => !results.some(([name, result]) => name.startsWith(start) && result !== true))
  const missing = expected.filter((start) => !results.some(([name]) => name.startsWith(start)))

  return survived.length === 0 && missing.length === 0 ? true : `${missing.length ? `no check starts with: ${missing.join('; ')}. ` : ''}${survived.length ? `these checks still pass: ${survived.join('; ')}` : ''}`
}

const RESULT = 'RESULT '
const MUTANTS = [...UTILITY_MUTATIONS.map((mutant) => ({ mutant, page: false })), ...PAGE_MUTATIONS.map((mutant) => ({ mutant, page: true }))]

const savesOf = async (real) => savesChecks([await familyOf(real, SAVES, 140, 784), await familyOf(real, SAVES_FALRYX, 141, 791)].filter(Boolean))

// What the baseline, each mutant and the control print, as entries a child hands to the parent: a line of text, or the arguments of `show`.
const baselineEntries = async () => {
  const real = await loadModules(utilitiesDirectory)
  const saves = await savesOf(real)
  const entries = [{ log: 'The export of the history page: CSV and PNG of what is shown' }]

  for (const [name, result, detail, skip] of await runChecks(suite(real))) {
    entries.push({ show: [name, result, detail, skip] })
  }

  entries.push({ log: '\nThe export buttons of the page (its script over scripts/lib/page-loader.js)' })

  for (const [name, result, detail, skip] of await runChecks(await pageSuite(real, { saves }))) {
    entries.push({ show: [name, result, detail, skip] })
  }

  return entries
}

const mutantEntries = async ({ mutant, page }) => {
  let directory = null

  try {
    let results = null

    if (page) {
      results = await runChecks(await pageSuite(await loadModules(utilitiesDirectory), { mutate: mutant.mutate }), mutant.fails)
    } else {
      directory = mutatedCopy(mutant)
      results = await runChecks(suite(await loadModules(directory)), mutant.fails)
    }

    return [{ show: [`mutant caught: ${mutant.name}`, caught(mutant, results)] }]
  } catch (error) {
    return [{ show: [`mutant caught: ${mutant.name}`, error.message] }]
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const controlEntries = async () => {
  const real = await loadModules(utilitiesDirectory)
  const saves = await savesOf(real)
  const control = await runChecks(suite(real), [...new Set(UTILITY_MUTATIONS.flatMap((mutant) => mutant.fails))])
  const controlPage = await runChecks(await pageSuite(real, { saves }), [...new Set(PAGE_MUTATIONS.flatMap((mutant) => mutant.fails))])
  const wrong = [...control, ...controlPage].filter(([, result]) => result !== true).map(([name]) => name)

  return [{ show: ['a control run of the unchanged code passes every check the mutants name', wrong.length === 0 ? true : `fails ${wrong.join('; ')}`] }]
}

// A child runs the baseline (`--baseline`), the control (`--control`) or some mutants in turn (`--mutants=<i>,<i>`) in a process of its own, so no chunk shares the modules, the stores or the stand-ins on globalThis of another, and prints its entries as JSON on its last line: those of the baseline or the control, or the list of the entries of each mutant.
const childMain = async () => {
  const given = process.argv.find((argument) => argument.startsWith('--mutants='))
  let entries = null

  if (given) {
    entries = []

    for (const index of given.slice('--mutants='.length).split(',')) {
      entries.push(await mutantEntries(MUTANTS[Number(index)]))
    }
  } else {
    entries = process.argv.includes('--control') ? await controlEntries() : await baselineEntries()
  }

  process.stdout.write(`${RESULT}${JSON.stringify(entries)}\n`, () => process.exit(0))
}

const main = async () => {
  if (['--baseline', '--control'].some((flag) => process.argv.includes(flag)) || process.argv.some((argument) => argument.startsWith('--mutants='))) {
    return childMain()
  }

  const mutating = !process.argv.includes('--no-mutations')
  const chunks = mutating ? chunksOf(MUTANTS.length) : []
  const items = [['--baseline'], ...(mutating ? [['--control'], ...chunks.map((list) => [`--mutants=${list.join(',')}`])] : [])]
  const outcomes = await inParallel(items, async (args) => lastJson(await runChild(__filename, args), RESULT))
  const replay = (entries) => entries.forEach((entry) => (entry.log !== undefined ? console.log(entry.log) : show(...entry.show)))

  if (outcomes[0] instanceof Error) {
    throw outcomes[0]
  }

  replay(outcomes[0])

  if (mutating) {
    console.log('\nmutants')

    spread(chunks, outcomes.slice(2)).forEach((outcome, index) => (outcome instanceof Error ? show(`mutant caught: ${MUTANTS[index].mutant.name}`, `does not run: ${outcome.message}`) : replay(outcome)))

    if (outcomes[1] instanceof Error) {
      show('a control run of the unchanged code passes every check the mutants name', `does not run: ${outcomes[1].message}`)
    } else {
      replay(outcomes[1])
    }
  }

  console.log(`\n${total - failures} of ${total} checks passed${skipped ? ` (${skipped} skipped: the owner's saves are not here)` : ''}`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
