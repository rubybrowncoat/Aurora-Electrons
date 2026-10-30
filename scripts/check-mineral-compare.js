/*
  Checks the mineral comparison of the Empire History page (src/renderer/utilities/mineral-compare.js and the mineral chart of src/renderer/pages/history.vue).

  node scripts/check-mineral-compare.js [--no-mutations]

  The utility is run on synthetic snapshots worked by hand: a mineral's baseline is the first snapshot of the window, with its stock and game time; the percent change is 100 x (stock - baseline) / baseline; a baseline of 0 t, or one that was not recorded, makes the change undefined (no percentage, no line) and is never read as 0 or as infinity, and an unknown stock is never 0; a mineral's colour is the palette slot fixed for its ID, in every preset, whichever other minerals are picked, and the two minerals that share a slot are told apart by a dash; the CSV names a unit on each value column, the scale, the baseline's stock and game time of each mineral, the palette slot and colour of its ID, and leaves what is not known empty and says why.

  The page's script is run as a real Vue 2 instance (vue is a dependency of the app) over scripts/lib/page-loader.js, with the real persisted-view mixin over an in-memory settings store: the minerals picked are an app-wide setting, as they always were (a value an earlier version stored opens the page, a preferences bundle that holds it among the app-wide views imports, Reset all clears it and one empire's reset leaves it) and survive a scale change, leaving the page and a restart; the percent scale draws no line for a mineral whose change is undefined and shows each baseline with its date; the chosen span sets the baseline; Reset restores the full retained range and keeps the minerals and the scale; the CSV follows the scale and span shown.

  The recorded passive campaign (artifacts/passive-campaign-20261013, git-ignored, read-only: 150 saves of a stock game 5 days apart) gives real stocks: the snapshots of race 1 (a player race whose Gallicite is 0 t throughout) and race 2 (an NPR whose stocks all move) are taken with the app's own `takeSnapshot`, and the percent change is compared with one worked from the unrounded sums of the colony stockpiles read straight from each save. The campaign checks are skipped when the folder is not there.

  Each mutation of the utility or of the page's script must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const v8 = require('v8')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, replacing } = require('./lib/page-loader')
const { strictRecords } = require('./lib/csv-records')
const { jobs } = require('./lib/check-pool')
const { endSection, runSections, printSection } = require('./lib/check-sections')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const PASSIVE = path.join(root, 'artifacts', 'passive-campaign-20261013')
const CAMPAIGN_GAME = 139
const CAMPAIGN_RACES = [1, 2]
const NAMES = ['mineral-compare', 'minerals', 'provenance', 'history']
const YEAR = 31536000
const START_YEAR = 2050

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The packages the utilities import. The stores are never opened here, so electron-store only has to exist; dayjs is the real one, as the page formats dates with it.
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
}

Vue.config.productionTip = false
Vue.config.devtools = false

const warnings = []

Vue.config.warnHandler = (message) => warnings.push(message)

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

  return text === undefined ? 'undefined' : text.length > 260 ? `${text.slice(0, 260)}…` : text
}

const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

const near = (actual, expected, tolerance = 1e-9) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance

const nearAll = (actual, expected, tolerance = 1e-9) => actual.length === expected.length && actual.every((value, index) => (expected[index] === null ? value === null : near(value, expected[index], tolerance))) ? true : `${short(actual)} != ${short(expected)}`

// A statement of the checks, settled when asked: one that throws is a statement that does not hold, not a script that stops.
const attempt = (statement) => async () => {
  try {
    return await statement()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const dateOf = (seconds) => new Date(Date.UTC(START_YEAR, 0, 1) + seconds * 1000).toISOString().slice(0, 10)

const thousands = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "'")

// ---------- the snapshots worked by hand ----------

// Nine snapshots, five years apart. Stocks by mineral ID, 1 to 11: Duranium 100 t and 50 t more at each; Neutronium not recorded in the first, then 400; Corbomite 200 but not recorded in the fifth; Tritanium from 1000 down by 100; IDs 5 to 9 steady at 500; Corundium 0 throughout; Gallicite 0 for three snapshots, then 10 t a snapshot.
const stocksAt = (index) => [100 + 50 * index, index === 0 ? null : 400, index === 4 ? null : 200, 1000 - 100 * index, 500, 500, 500, 500, 500, 0, index < 3 ? 0 : 10 * index]

const SNAPSHOTS = Array.from({ length: 9 }, (_value, index) => ({ t: index * 5 * YEAR, minerals: stocksAt(index) }))

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

// The CSV as the header and its rows keyed by the header.
const tableOf = (text) => {
  const [header, ...rows] = parseCsv(text)

  return { header, rows: rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]]))) }
}

const VALUE_COLUMNS = ['Game time (s)', 'Stock (t)', 'Baseline stock (t)', 'Baseline game time (s)', 'Change from baseline (%)', 'Gap since previous row (s)']

// The palette slot each mineral ID is drawn in: the first nine own one each; Corundium takes Corbomite's and Gallicite Tritanium's.
const SLOT_OF = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 2, 11: 3 }

// ---------- the utility ----------

const pure = (m, themes) => {
  const { compareMinerals, comparisonCsv, mineralStyle, percentChange, MINERAL_SCALES } = m.compare
  const { MINERALS } = m.minerals
  const ids = MINERALS.map((mineral) => mineral.id)
  const seriesOf = (snapshots, list) => compareMinerals(snapshots, list).series
  const one = (snapshots, id) => seriesOf(snapshots, [id])[0]
  const NOTE = '18 samples; gaps up to 5 y (typical 5 y). Older half thinned 2 times, dropping at least 40 samples.'
  const csvOf = (comparison, scale, palette, date = dateOf, retention = NOTE) => tableOf(comparisonCsv({ comparison, scale, palette, date, retention }))
  const everyTheme = (test) => Object.entries(themes).map(([name, palette]) => [name, test(palette)]).filter(([, result]) => result !== true).map(([name, result]) => `${name}: ${result}`).join('; ') || true
  const encodings = m.encodings

  return [
    ['the baseline is the first sample of the window, with its stock and game time', () => {
      const whole = one(SNAPSHOTS, 1)
      const later = one(SNAPSHOTS.slice(6), 1)

      return equal(whole.baseline, { t: 0, stock: 100 }) && equal(later.baseline, { t: 30 * YEAR, stock: 400 }) ? true : short([whole.baseline, later.baseline])
    }],
    ['the percent change is 100 x (stock - baseline) / baseline', () => nearAll(one(SNAPSHOTS, 1).percent, [0, 50, 100, 150, 200, 250, 300, 350, 400]) === true && nearAll(one(SNAPSHOTS, 4).percent, [0, -10, -20, -30, -40, -50, -60, -70, -80]) === true && nearAll(one(SNAPSHOTS.slice(6), 1).percent, [0, 12.5, 25]) === true ? true : short([one(SNAPSHOTS, 1).percent, one(SNAPSHOTS, 4).percent])],
    ['a zero starting stock makes the change undefined, never infinity or 0', () => {
      const series = one(SNAPSHOTS, 11)

      return series.normalisation.defined === false && series.normalisation.code === 'zero' && /0 t/.test(series.normalisation.reason) && series.percent.length === 9 && series.percent.every((value) => value === null) && equal(series.baseline, { t: 0, stock: 0 }) && series.samples[8].stock === 80 ? true : short(series)
    }],
    ['a mineral that is 0 t throughout is undefined in every window', () => [SNAPSHOTS, SNAPSHOTS.slice(3), SNAPSHOTS.slice(8)].every((window) => one(window, 10).normalisation.defined === false && one(window, 10).percent.every((value) => value === null)) ? true : 'a window defined it'],
    ['the same mineral from a later window starts from its first stock in that window', () => {
      const series = one(SNAPSHOTS.slice(6), 11)

      return series.normalisation.defined === true && equal(series.baseline, { t: 30 * YEAR, stock: 60 }) && nearAll(series.percent, [0, 100 / 6, 100 / 3]) === true ? true : short(series)
    }],
    ['an unknown starting stock makes the change undefined, and the baseline is not moved on to a later sample', () => {
      const series = one(SNAPSHOTS, 2)

      return equal(series.baseline, { t: 0, stock: null }) && series.normalisation.defined === false && series.normalisation.code === 'unknown' && series.percent.every((value) => value === null) && series.samples[1].stock === 400 ? true : short(series)
    }],
    ['a stock the snapshot does not hold is unknown, not 0', () => {
      const series = one(SNAPSHOTS, 3)
      const bare = one([{ t: 0 }, { t: YEAR, minerals: [] }], 1)

      return series.samples[4].stock === null && series.percent[4] === null && series.percent[3] === 0 && series.percent[5] === 0 && bare.samples.every((sample) => sample.stock === null) && bare.baseline.stock === null ? true : short([series.samples[4], series.percent[4], bare.samples])
    }],
    ['a window with no snapshot has no baseline and an undefined change', () => {
      const series = one([], 1)

      return series.baseline === null && series.samples.length === 0 && series.normalisation.defined === false && series.normalisation.code === 'empty' ? true : short(series)
    }],
    ['a window of one snapshot is its own baseline, at 0 %', () => {
      const series = one(SNAPSHOTS.slice(8), 1)

      return series.normalisation.defined === true && equal(series.baseline, { t: 40 * YEAR, stock: 500 }) && equal(series.percent, [0]) ? true : short(series)
    }],
    ['no percentage is taken from a baseline that is not above 0, or of a figure that is not known', () => {
      const none = [[5, 0], [5, -3], [5, null], [null, 5], [undefined, 5], [5, undefined], [NaN, 5], [5, NaN], [Infinity, 5], [5, Infinity], ['5', 5], [5, '5']]

      return none.every(([stock, baseline]) => percentChange(stock, baseline) === null) && near(percentChange(150, 100), 50) && near(percentChange(0, 100), -100) && near(percentChange(100, 100), 0) ? true : short(none.map(([stock, baseline]) => percentChange(stock, baseline)))
    }],
    ['the minerals come back in the order asked, each with its name, and none depends on the others', () => {
      const asked = [11, 1, 4]
      const together = seriesOf(SNAPSHOTS, asked)

      return equal(together.map((series) => [series.id, series.name]), [[11, 'Gallicite'], [1, 'Duranium'], [4, 'Tritanium']]) && together.every((series) => equal(series, one(SNAPSHOTS, series.id))) ? true : short(together.map((series) => series.id))
    }],
    ['each mineral\'s colour is the palette slot fixed for its ID, in every theme', () => everyTheme((palette) => equal(ids.map((id) => mineralStyle(palette, id).color), ids.map((id) => palette[SLOT_OF[id]])) && equal(ids.map((id) => mineralStyle(palette, id).slot), ids.map((id) => SLOT_OF[id])) ? true : short(ids.map((id) => mineralStyle(palette, id).slot)))],
    ['an ID that is no mineral\'s has no style', () => [0, 12, -1, null, undefined, '1'].every((id) => mineralStyle(themes.light, id) === null) ? true : 'a style was given'],
    ['the first nine minerals have nine different colours in every theme', () => everyTheme((palette) => new Set(ids.slice(0, 9).map((id) => mineralStyle(palette, id).color)).size === 9 ? true : 'two share a colour')],
    ['the minerals the page starts with have different colours in every theme', () => everyTheme((palette) => new Set([1, 2, 11].map((id) => mineralStyle(palette, id).color)).size === 3 ? true : 'two share a colour')],
    ['a mineral that shares a colour slot is drawn with a dash of its own, which no slot has', () => {
      const shared = ids.filter((id) => mineralStyle(themes.light, id).shared)
      const slotDashes = encodings.map((encoding) => JSON.stringify(encoding.dash))

      return equal(shared, [10, 11]) && shared.every((id) => mineralStyle(themes.light, id).dash.length > 0 && !slotDashes.includes(JSON.stringify(mineralStyle(themes.light, id).dash))) ? true : short(shared.map((id) => mineralStyle(themes.light, id).dash))
    }],
    ['a mineral that owns its slot leaves the slot its own dash, and every mineral is told apart by its slot and dash', () => {
      const owners = ids.filter((id) => !mineralStyle(themes.light, id).shared)
      const identity = (id) => {
        const style = mineralStyle(themes.light, id)

        return `${style.slot}:${JSON.stringify(style.dash.length ? style.dash : encodings[style.slot].dash)}`
      }

      return owners.length === 9 && owners.every((id) => mineralStyle(themes.light, id).dash.length === 0) && new Set(ids.map(identity)).size === 11 ? true : short(ids.map(identity))
    }],
    ['the scales are the stock in tonnes and the change in percent, each with its axis title and unit', () => equal(MINERAL_SCALES.map((scale) => scale.value), ['absolute', 'percent']) && /\(t\)/.test(MINERAL_SCALES[0].axis) && /\(%\)/.test(MINERAL_SCALES[1].axis) ? true : short(MINERAL_SCALES)],
    ['the CSV names a unit on every value column, and its columns are the same on both scales', () => {
      const comparison = { series: seriesOf(SNAPSHOTS, [1, 11]) }
      const first = csvOf(comparison, 'absolute', themes.light).header
      const second = csvOf(comparison, 'percent', themes.light).header
      const plain = ['Mineral ID', 'Mineral', 'Palette slot', 'Colour', 'Scale', 'Date', 'Baseline date', 'Note', 'Retention']
      const value = first.filter((name) => !plain.includes(name))

      return equal(first, second) && equal(value, VALUE_COLUMNS) && value.every((name) => /\((t|s|%)\)$/.test(name)) ? true : short([first, second])
    }],
    ['the CSV gives each mineral\'s baseline stock and game time, with its date, on every row', () => {
      const table = csvOf(compareMinerals(SNAPSHOTS.slice(6), [1, 11]), 'percent', themes.light)

      return table.rows.length === 6 && table.rows.every((row) => (row['Mineral ID'] === '1' ? row['Baseline stock (t)'] === '400' : row['Baseline stock (t)'] === '60') && row['Baseline game time (s)'] === String(30 * YEAR) && row['Baseline date'] === dateOf(30 * YEAR)) ? true : short(table.rows.map((row) => [row['Mineral ID'], row['Baseline stock (t)'], row['Baseline game time (s)'], row['Baseline date']]))
    }],
    ['the CSV gives the seconds since each mineral\'s previous row, empty on its first, and the retention note once, on the first row of the file', () => {
      const table = csvOf(compareMinerals(SNAPSHOTS.slice(6), [1, 11]), 'percent', themes.light)
      const duranium = table.rows.filter((row) => row['Mineral ID'] === '1')
      const gallicite = table.rows.filter((row) => row['Mineral ID'] === '11')
      const retention = table.rows.map((row) => row.Retention)

      return equal(duranium.map((row) => row['Gap since previous row (s)']), ['', String(5 * YEAR), String(5 * YEAR)]) && equal(gallicite.map((row) => row['Gap since previous row (s)']), ['', String(5 * YEAR), String(5 * YEAR)]) && retention[0] === NOTE && retention.slice(1).every((cell) => cell === '') && table.header.slice(-2).join('|') === 'Gap since previous row (s)|Retention' ? true : short([duranium.map((row) => row['Gap since previous row (s)']), retention])
    }],
    ['the CSV of a comparison with no rows has its header and no note', () => {
      const table = csvOf({ series: [] }, 'absolute', themes.light)

      return table.rows.length === 0 && table.header.includes('Retention') ? true : short(table)
    }],
    ['the CSV states the scale on every row', () => {
      const comparison = compareMinerals(SNAPSHOTS, [1, 4])
      const tables = MINERAL_SCALES.map((scale) => csvOf(comparison, scale.value, themes.light).rows.map((row) => row.Scale))

      return tables.every((scales, index) => scales.length === 18 && scales.every((value) => value === MINERAL_SCALES[index].label)) && MINERAL_SCALES[0].label !== MINERAL_SCALES[1].label ? true : short(tables.map((scales) => [...new Set(scales)]))
    }],
    ['the CSV ties each row to the mineral ID, and the palette slot and colour of that ID, in every theme', () => everyTheme((palette) => {
      const table = csvOf(compareMinerals(SNAPSHOTS, [11, 3, 1]), 'absolute', palette)

      return table.rows.every((row) => {
        const style = mineralStyle(palette, Number(row['Mineral ID']))

        return row['Palette slot'] === String(SLOT_OF[Number(row['Mineral ID'])] + 1) && row.Colour === palette[SLOT_OF[Number(row['Mineral ID'])]] && row.Colour === style.color
      }) && equal([...new Set(table.rows.map((row) => `${row['Mineral ID']}:${row.Mineral}`))], ['11:Gallicite', '3:Corbomite', '1:Duranium']) ? true : short(table.rows.slice(0, 2))
    })],
    ['the CSV has a row for each mineral at each snapshot of the window, with its stock and change', () => {
      const comparison = compareMinerals(SNAPSHOTS.slice(6), [1, 4])
      const table = csvOf(comparison, 'percent', themes.light)
      const duranium = table.rows.filter((row) => row['Mineral ID'] === '1')

      return table.rows.length === 6 && equal(duranium.map((row) => Number(row['Stock (t)'])), [400, 450, 500]) && nearAll(duranium.map((row) => Number(row['Change from baseline (%)'])), [0, 12.5, 25]) === true && equal(duranium.map((row) => row['Game time (s)']), [String(30 * YEAR), String(35 * YEAR), String(40 * YEAR)]) ? true : short(duranium)
    }],
    ['the CSV leaves an unknown figure as an empty cell, never 0, and says so', () => {
      const table = csvOf(compareMinerals(SNAPSHOTS, [2, 3]), 'absolute', themes.light)
      const neutronium = table.rows.filter((row) => row['Mineral ID'] === '2')
      const corbomite = table.rows.filter((row) => row['Mineral ID'] === '3')

      return neutronium[0]['Stock (t)'] === '' && /stock not recorded/.test(neutronium[0].Note) && neutronium[0]['Baseline stock (t)'] === '' && corbomite[4]['Stock (t)'] === '' && /stock not recorded/.test(corbomite[4].Note) && corbomite[3]['Stock (t)'] === '200' && corbomite[3].Note === '' ? true : short([neutronium[0], corbomite[4]])
    }],
    ['the CSV says why a change is undefined, and leaves it empty', () => {
      const table = csvOf(compareMinerals(SNAPSHOTS, [1, 11, 2]), 'percent', themes.light)
      const gallicite = table.rows.filter((row) => row['Mineral ID'] === '11')
      const neutronium = table.rows.filter((row) => row['Mineral ID'] === '2')
      const duranium = table.rows.filter((row) => row['Mineral ID'] === '1')

      return gallicite.length === 9 && gallicite.every((row) => row['Change from baseline (%)'] === '' && /change undefined: .*0 t/.test(row.Note)) && gallicite[8]['Stock (t)'] === '80' && neutronium.every((row) => row['Change from baseline (%)'] === '' && /change undefined: .*not recorded/.test(row.Note)) && duranium.every((row) => row['Change from baseline (%)'] !== '' && !/undefined/.test(row.Note)) ? true : short([gallicite[0], neutronium[1]])
    }],
    ['the CSV quotes a cell that holds a comma, a quote or a newline', () => {
      const table = csvOf(compareMinerals(SNAPSHOTS.slice(8), [1]), 'absolute', themes.light, () => 'a,b "c"\nd')

      return table.rows.length === 1 && table.rows[0].Date === 'a,b "c"\nd' && table.rows[0]['Baseline date'] === 'a,b "c"\nd' && table.rows[0]['Stock (t)'] === '500' ? true : short(table.rows)
    }],
    ['the CSV writes a carriage return and a formula start as the shared writer does: in a quoted cell, as text', () => {
      const text = comparisonCsv({ comparison: compareMinerals(SNAPSHOTS.slice(8), [1]), scale: 'absolute', palette: themes.light, date: (seconds) => (seconds === SNAPSHOTS[8].t ? 'a\rb' : '=HYPERLINK("x")'), retention: '-note' })
      const records = strictRecords(text)
      const row = records[1]

      return records.length === 2 && row.includes('a\rb') && row.some((cell) => cell.includes('-note') && !/^[=+\-@\t\r]/.test(cell)) && row.length === records[0].length ? true : short(records)
    }],
    ['the change is registered as a rule of the provenance registry, in percent', () => {
      const rule = m.provenance.getRule('history.mineralChange')

      return rule && rule.units === '%' && rule.verification === 'confirmed' && /not 0|neither 0/.test(rule.note) ? true : short(rule)
    }],
  ]
}

// ---------- the page ----------

class MemoryConfig {
  constructor(entries = []) {
    this.values = new Map(entries)
  }

  get(key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set(key, value) {
    this.values.set(key, JSON.stringify(value))
  }

  has(key) {
    return this.values.has(key)
  }

  // A restart: the settings as the file holds them, read by another store.
  reopened() {
    return new MemoryConfig([...this.values])
  }
}

const PERSISTED_VIEW = `${fs.readFileSync(path.join(root, 'src', 'renderer', 'mixins', 'persisted-view.js'), 'utf8')}\nglobalThis.__declaredViews = declaredViews\n`

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const KEY = 'campaign.c1.race.7'

// The settings a page starts from: the minerals picked and the scale are both the app's.
const stored = (picked, scale) => new MemoryConfig([...(picked ? [['historyMinerals', JSON.stringify(picked)]] : []), ...(scale ? [['historyMineralScale', JSON.stringify(scale)]] : [])])

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

const pageStatements = async (mutate, context) => {
  const { m, themes, campaign } = context
  const { MINERALS } = m.minerals
  const idOfName = (name) => MINERALS.find((mineral) => mineral.name === name).id
  const options = await loadPage('pages/history', { stubs: STUBS, modules: { 'mixins/persisted-view': PERSISTED_VIEW }, mutate })
  const declared = globalThis.__declaredViews()
  const { settings } = context
  const mounted = []

  // A page over the snapshots, the settings and the palette given: the page's own script and the real persisted-view mixin, with the store's getters as the page reads them.
  const mount = ({ palette = themes.light, snapshots = SNAPSHOTS, config = new MemoryConfig(), prefix = KEY, RaceID = 7 } = {}) => {
    const store = Vue.observable({ getters: { racePrefix: prefix, config, database: null, GameID: 1, RaceID, StartYear: START_YEAR, historyRecorded: true, 'history/campaign': { campaignId: 'c1', branchId: 'b1', generation: 1 } }, state: { history: { revision: 0, failures: [] } } })
    const vm = new Vue({
      mixins: [options],
      data: () => ({ installationNames: {} }),
      computed: {
        record: () => ({ raceName: 'Test Race', snapshots }),
        theme: () => ({ categorical: palette }),
      },
      beforeCreate () {
        this.$store = store
      },
    })

    mounted.push(vm)

    return { vm, store, config }
  }

  // Runs a statement and puts every page it mounted away, so a failure leaves nothing running.
  const settled = (statement) => async () => {
    try {
      return await attempt(statement)()
    } finally {
      mounted.splice(0).forEach((vm) => vm.$destroy())
    }
  }

  const chartOf = (vm) => vm.charts.find((chart) => chart.key === 'minerals')
  const drawnOf = (vm) => chartOf(vm).data.datasets
  const colourOf = (vm) => Object.fromEntries(drawnOf(vm).map((dataset) => [idOfName(dataset.label), dataset.borderColor]))
  const expectedColours = (palette, picked) => Object.fromEntries(picked.map((id) => [id, palette[SLOT_OF[id]]]))
  const valuesOf = (vm, name) => drawnOf(vm).find((dataset) => dataset.label === name).data.map((point) => point.y)
  const notesOf = (vm) => chartOf(vm).extraNotes
  const everyTheme = (test) => Promise.all(Object.entries(themes).map(async ([name, palette]) => [name, await test(palette)])).then((results) => results.filter(([, result]) => result !== true).map(([name, result]) => `${name}: ${result}`).join('; ') || true)

  // The CSV the page's download button writes, as the file name and its text.
  const downloadOf = (vm) => {
    const files = []
    const saved = { document: globalThis.document, Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    let text = null
    const link = { href: '', download: '', click() { files.push({ name: link.download, text }) } }

    globalThis.document = { createElement: () => link }
    globalThis.Blob = class { constructor(parts) { text = parts.join('') } }
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}

    try {
      vm.downloadMineralCsv()
    } finally {
      globalThis.document = saved.document
      globalThis.Blob = saved.Blob
      URL.createObjectURL = saved.create
      URL.revokeObjectURL = saved.revoke
    }

    return { name: files[0].name, ...tableOf(files[0].text) }
  }

  const statements = [
    ['page: the minerals picked and the scale are views declared for the app', () => {
      const picked = declared.filter((view) => view.key === 'historyMinerals').pop()
      const scale = declared.filter((view) => view.key === 'historyMineralScale').pop()

      return picked && picked.scope === 'app' && equal(picked.default, [1, 2, 11]) && scale && scale.scope === 'app' && scale.default === 'absolute' ? true : short([picked && picked.scope, scale && scale.scope])
    }],
    ['page: a mineral is drawn in the colour of its ID, in every theme and on both scales', () => everyTheme(async (palette) => {
      for (const picked of [[1], [1, 2, 11], [5, 1], firstIds(11)]) {
        for (const scale of ['absolute', 'percent']) {
          const { vm } = mount({ palette, config: stored(picked, scale) })
          const sorted = picked.slice().sort((a, b) => a - b)
          const drawn = colourOf(vm)
          const expected = expectedColours(palette, sorted.filter((id) => scale === 'absolute' || vm.mineralComparison.series.find((series) => series.id === id).normalisation.defined))

          if (!equal(drawn, expected)) {
            return `${scale} ${short(picked)}: ${short(drawn)} != ${short(expected)}`
          }
        }
      }

      return true
    })],
    ['page: picking or dropping a mineral recolours no other', async () => {
      const colours = []

      for (const picked of [[1, 2, 11], [1, 2, 3, 11], [2, 11], [11], [1, 5, 9, 11]]) {
        const { vm } = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify(picked)]]) })

        colours.push(colourOf(vm))
      }

      const every = new Map()

      for (const found of colours) {
        for (const [id, colour] of Object.entries(found)) {
          if (every.has(id) && every.get(id) !== colour) {
            return `mineral ${id} drawn in ${every.get(id)} and in ${colour}`
          }

          every.set(id, colour)
        }
      }

      return every.size === 6 ? true : `${every.size} minerals seen`
    }],
    ['page: the shared slots are told apart by a dash that reaches the chart', () => {
      const { vm } = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify(firstIds(11))]]) })
      const dashed = drawnOf(vm).filter((dataset) => dataset.borderDash.length > 0).map((dataset) => dataset.label)

      return equal(dashed, ['Corundium', 'Gallicite']) ? true : short(dashed)
    }],
    ['page: the chips of the picker carry the colour and dash of each mineral\'s ID and are the legend of the lines', () => everyTheme((palette) => {
      const { vm } = mount({ palette })
      const options = chartOf(vm).picker.options

      return options.length === 11 && options.every((option) => option.color === palette[SLOT_OF[option.value]] && equal(option.dash, m.compare.mineralStyle(palette, option.value).dash)) && equal(options.map((option) => option.text), MINERALS.map((mineral) => mineral.name)) ? true : short(options.slice(0, 2))
    })],
    ['page: the minerals the page starts with are Duranium, Neutronium and Gallicite on the stock in tonnes', () => {
      const { vm } = mount()

      return equal(vm.mineralIds, [1, 2, 11]) && vm.mineralScale === 'absolute' && equal(drawnOf(vm).map((dataset) => dataset.label), ['Duranium', 'Neutronium', 'Gallicite']) ? true : short([vm.mineralIds, vm.mineralScale])
    }],
    ['page: a scale change keeps the minerals picked', async () => {
      const { vm } = mount()

      vm.setMinerals([4, 3])
      await flush()
      vm.mineralScale = 'percent'
      await flush()

      const onPercent = vm.mineralIds.slice()

      vm.mineralScale = 'absolute'
      await flush()

      return equal(onPercent, [3, 4]) && equal(vm.mineralIds, [3, 4]) ? true : short([onPercent, vm.mineralIds])
    }],
    ['page: the minerals picked and the scale survive leaving the page and a restart', async () => {
      const first = mount()

      first.vm.setMinerals([5, 3, 11])
      first.vm.mineralScale = 'percent'
      await flush()
      first.vm.$destroy()

      const back = mount({ config: first.config })
      const restart = mount({ config: first.config.reopened() })

      return equal(back.vm.mineralIds, [3, 5, 11]) && back.vm.mineralScale === 'percent' && equal(restart.vm.mineralIds, [3, 5, 11]) && restart.vm.mineralScale === 'percent' && first.config.has('historyMinerals') && first.config.has('historyMineralScale') ? true : short([back.vm.mineralIds, restart.vm.mineralIds, restart.vm.mineralScale, [...first.config.values.keys()]])
    }],
    ['page: the minerals picked are the app\'s, the same for every race and campaign', async () => {
      const config = new MemoryConfig()
      const seven = mount({ config })

      seven.vm.setMinerals([3, 4])
      await flush()

      const eight = mount({ config, prefix: 'campaign.c1.race.8', RaceID: 8 })
      const onEight = eight.vm.mineralIds.slice()
      const other = mount({ config, prefix: 'campaign.c2.race.7' })
      const live = mount({ config })

      live.store.getters.racePrefix = 'campaign.c1.race.8'
      await flush()

      const afterSwitch = live.vm.mineralIds.slice()

      eight.vm.setMinerals([9])
      await flush()

      const keys = [...config.values.keys()]

      return equal(onEight, [3, 4]) && equal(other.vm.mineralIds, [3, 4]) && equal(afterSwitch, [3, 4]) && equal(mount({ config }).vm.mineralIds, [9]) && keys.includes('historyMinerals') && keys.every((key) => !key.startsWith('campaign.')) ? true : short([onEight, other.vm.mineralIds, afterSwitch, keys])
    }],
    ['page: a pick stored app-wide before the page was changed is the one it opens with, under any empire', () => {
      const named = (vm) => drawnOf(vm).map((dataset) => dataset.label)
      const config = new MemoryConfig([['historyMinerals', JSON.stringify([3, 8])]])
      const here = mount({ config })
      const there = mount({ config, prefix: 'campaign.c9.race.12', RaceID: 12 })
      const expected = [3, 8].map((id) => m.minerals.MINERALS.find((mineral) => mineral.id === id).name)

      return equal(here.vm.mineralIds, [3, 8]) && equal(there.vm.mineralIds, [3, 8]) && equal(named(here.vm), expected) && equal(named(there.vm), expected) ? true : short([here.vm.mineralIds, there.vm.mineralIds, named(here.vm)])
    }],
    ['page: a preferences bundle that holds the minerals picked among the app-wide views imports, and exports back', () => {
      const { buildSchema, buildExport, parseBundle, FORMAT, VERSION } = settings.preferences
      const schema = buildSchema({ declarations: declared, appearance: { key: 'appearance', ids: ['light', 'dark'] }, policy: { key: 'appearancePolicy', values: ['light', 'dark', 'system'] }, font: { key: 'appearanceFont', read: () => ({ ok: false, reason: 'none' }) }, separators: ['Comma'] })
      const bundle = { format: FORMAT, version: VERSION, categories: { views: { app: { historyMinerals: [3, 8], historyMineralScale: 'percent' } } } }
      const parsed = parseBundle(JSON.stringify(bundle), schema)
      const entries = parsed.entries || []
      const picked = entries.find((entry) => entry.key === 'historyMinerals')
      const exported = buildExport(schema, { historyMinerals: [3, 8], historyMineralScale: 'percent' }, { gameId: 1, raceId: 7, campaignId: 'c1' }, ['views'])
      const opened = mount({ config: new MemoryConfig(entries.map((entry) => [entry.key, JSON.stringify(entry.value)])) }).vm

      return !parsed.errors && picked && picked.scope === 'app' && equal(picked.value, [3, 8]) && equal(exported.bundle.categories.views.app.historyMinerals, [3, 8]) && equal(opened.mineralIds, [3, 8]) && opened.mineralScale === 'percent' ? true : short([parsed.errors, entries, exported.bundle.categories])
    }],
    ['page: Reset all clears the minerals picked and the scale the page wrote, and one empire\'s reset leaves them', async () => {
      const { withoutViews } = settings['remembered-views']
      const { vm, config } = mount()

      vm.setMinerals([3, 8])
      vm.mineralScale = 'percent'
      await flush()

      const store = nested(config)
      const all = withoutViews(store, ['spyNPR'], null)
      const one = withoutViews(store, ['spyNPR'], { campaignId: 'c1', RaceID: 7 })

      return equal(store.historyMinerals, [3, 8]) && all.historyMinerals === undefined && all.historyMineralScale === undefined && equal(one.historyMinerals, [3, 8]) && one.historyMineralScale === 'percent' ? true : short([store, all, one])
    }],
    ['page: the order the minerals are picked in changes nothing', () => {
      const { vm } = mount()

      vm.setMinerals([11, 1, 2])

      return equal(vm.mineralIds, [1, 2, 11]) && equal(drawnOf(vm).map((dataset) => dataset.label), ['Duranium', 'Neutronium', 'Gallicite']) ? true : short(vm.mineralIds)
    }],
    ['page: a stored pick this version does not offer is cleaned, and a stored value that is no pick is the default', () => {
      const cleaned = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify([11, 99, 'x', 3, 3])]]) }).vm.mineralIds
      const text = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify('Duranium')], ['historyMineralScale', JSON.stringify('log')]]) }).vm
      const none = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify([])]]) }).vm

      return equal(cleaned, [3, 11]) && equal(text.mineralIds, [1, 2, 11]) && text.mineralScale === 'absolute' && equal(none.mineralIds, []) && equal(drawnOf(none), []) && notesOf(none).some((note) => /Pick a mineral/.test(note)) && chartOf(none).compare.csvDisabled === true ? true : short([cleaned, text.mineralIds, none.mineralIds])
    }],
    ['page: on the stock scale every mineral is drawn in tonnes, an unknown stock as a gap and a stock of 0 t as 0', () => {
      const { vm } = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify([1, 2, 3, 10, 11])]]) })

      return equal(valuesOf(vm, 'Duranium'), [100, 150, 200, 250, 300, 350, 400, 450, 500]) && equal(valuesOf(vm, 'Neutronium'), [null, 400, 400, 400, 400, 400, 400, 400, 400]) && equal(valuesOf(vm, 'Corbomite'), [200, 200, 200, 200, null, 200, 200, 200, 200]) && equal(valuesOf(vm, 'Corundium'), [0, 0, 0, 0, 0, 0, 0, 0, 0]) && equal(valuesOf(vm, 'Gallicite'), [0, 0, 0, 30, 40, 50, 60, 70, 80]) && !drawnOf(vm).some((dataset) => dataset.data.some((point) => point.stock !== point.y)) ? true : short(drawnOf(vm).map((dataset) => dataset.data.map((point) => point.y)))
    }],
    ['page: on the percent scale the change from the first snapshot is drawn, an unknown stock as a gap', () => {
      const { vm } = mount({ config: stored([1, 3, 4], 'percent') })

      return nearAll(valuesOf(vm, 'Duranium'), [0, 50, 100, 150, 200, 250, 300, 350, 400]) === true && nearAll(valuesOf(vm, 'Tritanium'), [0, -10, -20, -30, -40, -50, -60, -70, -80]) === true && nearAll(valuesOf(vm, 'Corbomite'), [0, 0, 0, 0, null, 0, 0, 0, 0]) === true && drawnOf(vm).every((dataset) => dataset.data.every((point) => point.stock !== undefined)) ? true : short(drawnOf(vm).map((dataset) => dataset.data.map((point) => point.y)))
    }],
    ['page: on the percent scale a mineral whose change is undefined has no line, and says why', () => {
      const { vm } = mount({ config: stored([1, 2, 3, 10, 11], 'percent') })
      const chart = chartOf(vm)
      const flagged = chart.picker.options.filter((option) => option.flag).map((option) => option.value)
      const notes = notesOf(vm)
      const every = chart.data.datasets.flatMap((dataset) => dataset.data.map((point) => point.y))

      return equal(chart.data.datasets.map((dataset) => dataset.label), ['Duranium', 'Corbomite']) && equal(flagged, [2, 10, 11]) && chart.picker.options.filter((option) => option.flag).every((option) => option.flag === 'undefined' && /^Change from the baseline is undefined: /.test(option.title)) && notes.some((note) => /^Gallicite: change undefined, so no line is drawn, because the stock in the first snapshot of the window is 0 t/.test(note)) && notes.some((note) => /^Neutronium: change undefined.*is not recorded/.test(note)) && notes.some((note) => /^Corundium: change undefined.*is 0 t/.test(note)) && every.every((value) => value === null || Number.isFinite(value)) && equal(vm.mineralIds, [1, 2, 3, 10, 11]) ? true : short([chart.data.datasets.map((dataset) => dataset.label), flagged, notes])
    }],
    ['page: on the stock scale a mineral whose change is undefined is drawn and nothing is flagged', () => {
      const { vm } = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify([2, 10, 11])]]) })

      return equal(drawnOf(vm).map((dataset) => dataset.label), ['Neutronium', 'Corundium', 'Gallicite']) && chartOf(vm).picker.options.every((option) => option.flag === '' && option.title === undefined) && notesOf(vm).every((note) => !/baseline/.test(note)) ? true : short([notesOf(vm), chartOf(vm).picker.options.filter((option) => option.flag)])
    }],
    ['page: the baseline and its game time are shown for each mineral on the percent scale', () => {
      const { vm } = mount({ config: stored([1, 4], 'percent') })
      const notes = notesOf(vm)

      return notes.includes(`Duranium: baseline 100 t, at ${dateOf(0)}.`) && notes.includes(`Tritanium: baseline ${thousands(1000)} t, at ${dateOf(0)}.`) ? true : short(notes)
    }],
    ['page: the span chosen sets the baseline: the first snapshot of the span', () => {
      const { vm } = mount({ config: stored([1, 2, 11], 'percent') })

      vm.span = 10

      const notes = notesOf(vm)

      return vm.snapshots.length === 3 && nearAll(valuesOf(vm, 'Duranium'), [0, 12.5, 25]) === true && notes.includes(`Duranium: baseline 400 t, at ${dateOf(30 * YEAR)}.`) && notes.includes(`Gallicite: baseline 60 t, at ${dateOf(30 * YEAR)}.`) && notes.includes(`Neutronium: baseline 400 t, at ${dateOf(30 * YEAR)}.`) && drawnOf(vm).length === 3 && chartOf(vm).picker.options.every((option) => option.flag === '') ? true : short([vm.snapshots.length, notes])
    }],
    ['page: Reset restores the full retained range', async () => {
      const { vm } = mount({ config: stored(null, 'percent') })

      vm.span = 10
      await flush()

      const narrowed = vm.snapshots.length
      const baseline = vm.mineralComparison.series[0].baseline.t

      vm.resetMineralRange()
      await flush()

      const remembered = vm.$store.getters.config.get('historySpan')

      return narrowed === 3 && baseline === 30 * YEAR && vm.span === 0 && vm.snapshots.length === 9 && vm.mineralComparison.series[0].baseline.t === 0 && nearAll(valuesOf(vm, 'Duranium'), [0, 50, 100, 150, 200, 250, 300, 350, 400]) === true && remembered === 0 ? true : short([narrowed, baseline, vm.span, vm.snapshots.length, remembered])
    }],
    ['page: Reset keeps the minerals picked and the scale', async () => {
      const { vm } = mount({ config: stored([2, 5], 'percent') })

      vm.span = 20
      await flush()
      vm.resetMineralRange()
      await flush()

      return equal(vm.mineralIds, [2, 5]) && vm.mineralScale === 'percent' ? true : short([vm.mineralIds, vm.mineralScale])
    }],
    ['page: Reset is offered only while the span is narrowed', () => {
      const { vm } = mount()
      const states = [chartOf(vm).compare.resetDisabled]

      vm.span = 10
      states.push(chartOf(vm).compare.resetDisabled)
      vm.resetMineralRange()
      states.push(chartOf(vm).compare.resetDisabled)

      return equal(states, [true, false, true]) ? true : short(states)
    }],
    ['page: the axis names its unit on each scale', () => {
      const { vm } = mount()
      const stock = chartOf(vm).options.scales.y.title

      vm.mineralScale = 'percent'

      const percent = chartOf(vm).options.scales.y.title

      return stock.display === true && /\(t\)/.test(stock.text) && percent.display === true && /\(%\)/.test(percent.text) && equal(chartOf(vm).options.plugins.guides.levels.map((level) => level.y), [0]) ? true : short([stock, percent])
    }],
    ['page: the tooltip gives the stock in tonnes, and on the percent scale the change with the stock behind it', () => {
      const { vm } = mount()
      const label = (item) => chartOf(vm).options.plugins.tooltip.callbacks.label(item)
      const absolute = label({ dataset: { label: 'Duranium' }, parsed: { y: 150 }, raw: { stock: 150 } })
      const unknown = label({ dataset: { label: 'Duranium' }, parsed: { y: null }, raw: { stock: null } })

      vm.mineralScale = 'percent'

      const percent = label({ dataset: { label: 'Duranium' }, parsed: { y: 50 }, raw: { stock: 150 } })
      const down = label({ dataset: { label: 'Tritanium' }, parsed: { y: -10 }, raw: { stock: 900 } })

      return absolute === 'Duranium: 150 t' && unknown === 'Duranium: —' && percent === 'Duranium: +50 % (150 t)' && down === 'Tritanium: −10 % (900 t)' && label({ dataset: { label: 'Corbomite' }, parsed: { y: 12.5 }, raw: { stock: 225 } }) === 'Corbomite: +12.5 % (225 t)' ? true : short([absolute, unknown, percent, down])
    }],
    ['page: the CSV the page writes follows the scale shown, with the baseline and the colour of each mineral', () => everyTheme((palette) => {
      const { vm } = mount({ palette, config: stored([1, 11, 3], 'percent') })
      const csv = downloadOf(vm)

      return csv.name === 'Test_Race-minerals-percent.csv' && csv.rows.length === 27 && equal(csv.header.filter((name) => /\(/.test(name)), VALUE_COLUMNS) && csv.rows.every((row) => row.Scale === 'percent change from baseline (%)' && row.Colour === palette[SLOT_OF[Number(row['Mineral ID'])]]) && csv.rows.filter((row) => row['Mineral ID'] === '1').every((row) => row['Baseline stock (t)'] === '100' && row['Baseline game time (s)'] === '0') && csv.rows.filter((row) => row['Mineral ID'] === '11').every((row) => row['Change from baseline (%)'] === '' && /change undefined/.test(row.Note)) ? true : short([csv.name, csv.rows.length, csv.rows[0]])
    })],
    ['page: the CSV follows the span chosen and the stock scale', () => {
      const { vm } = mount({ config: new MemoryConfig([['historyMinerals', JSON.stringify([1, 11])]]) })

      vm.span = 10

      const csv = downloadOf(vm)

      return csv.name === 'Test_Race-minerals-absolute.csv' && csv.rows.length === 6 && csv.rows.every((row) => row.Scale === 'stock (t)' && row['Baseline game time (s)'] === String(30 * YEAR)) && equal(csv.rows.filter((row) => row['Mineral ID'] === '11').map((row) => row['Baseline stock (t)']), ['60', '60', '60']) && equal(csv.rows.filter((row) => row['Mineral ID'] === '1').map((row) => row['Stock (t)']), ['400', '450', '500']) ? true : short(csv.rows.map((row) => [row['Mineral ID'], row['Game time (s)'], row['Stock (t)']]))
    }],
    ['page: the CSV is offered only with a mineral picked and a snapshot in the span', () => {
      const { vm } = mount()
      const states = [chartOf(vm).compare.csvDisabled]

      vm.setMinerals([])
      states.push(chartOf(vm).compare.csvDisabled)

      return equal(states, [false, true]) ? true : short(states)
    }],
    ['page: the section\'s summary says what it shows without a figure that changes', () => {
      const { vm } = mount()
      const { summary, rules } = chartOf(vm)

      return typeof summary === 'string' && summary.trim().length > 0 && !/\d/.test(summary) && !/\b(you|your|we|our|I|my)\b/i.test(summary) && equal(rules, ['history.stockpile', 'history.mineralChange']) ? true : short([summary, rules])
    }],
  ]

  if (campaign) {
    statements.push(...campaignPageStatements({ ...context, mount, chartOf, drawnOf, colourOf, notesOf, downloadOf, everyTheme, expectedColours, idOfName }))
  }

  return statements.map(([name, statement]) => [name, settled(statement)])
}

const firstIds = (count) => Array.from({ length: count }, (_value, index) => index + 1)

// ---------- the recorded campaign ----------

const campaignPageStatements = ({ campaign, mount, chartOf, drawnOf, colourOf, notesOf, downloadOf, everyTheme, expectedColours, idOfName }) => {
  const config = stored
  const snapshots = campaign.races[1].snapshots

  return [
    ['campaign page: race 1 on the percent scale draws ten minerals and no line for Gallicite, which is 0 t', () => {
      const { vm } = mount({ snapshots, config: config(firstIds(11), 'percent') })
      const drawn = drawnOf(vm).map((dataset) => dataset.label)

      return drawn.length === 10 && !drawn.includes('Gallicite') && chartOf(vm).picker.options.filter((option) => option.flag).map((option) => option.value).join() === '11' && notesOf(vm).some((note) => /^Gallicite: change undefined, so no line is drawn, because the stock in the first snapshot of the window is 0 t/.test(note)) && drawnOf(vm).every((dataset) => dataset.data.every((point) => Number.isFinite(point.y))) ? true : short([drawn, notesOf(vm).length])
    }],
    ['campaign page: race 1 on the stock scale draws all eleven, Gallicite at 0 t', () => {
      const { vm } = mount({ snapshots, config: config(firstIds(11), 'absolute') })
      const gallicite = drawnOf(vm).find((dataset) => dataset.label === 'Gallicite')

      return drawnOf(vm).length === 11 && gallicite.data.length === 150 && gallicite.data.every((point) => point.y === 0) ? true : short(drawnOf(vm).length)
    }],
    ['campaign page: each mineral keeps its colour on the recorded campaign in every theme', () => everyTheme((palette) => {
      const { vm } = mount({ snapshots, palette, config: config(firstIds(11), 'absolute') })
      const alone = mount({ snapshots, palette, config: config([8], 'absolute') }).vm

      return equal(colourOf(vm), expectedColours(palette, firstIds(11))) && equal(colourOf(alone), expectedColours(palette, [8])) ? true : short(colourOf(vm))
    })],
    ['campaign page: the CSV of race 1 gives the real baselines, and Gallicite as undefined', () => {
      const { vm } = mount({ snapshots, config: config([8, 11], 'percent') })
      const csv = downloadOf(vm)
      const sorium = csv.rows.filter((row) => row['Mineral ID'] === '8')
      const gallicite = csv.rows.filter((row) => row['Mineral ID'] === '11')
      const first = snapshots[0]

      return csv.rows.length === 300 && sorium[0]['Baseline stock (t)'] === String(first.minerals[7]) && sorium[0]['Baseline game time (s)'] === String(first.t) && Number(sorium[149]['Change from baseline (%)']) < 0 && gallicite.every((row) => row['Stock (t)'] === '0' && row['Baseline stock (t)'] === '0' && row['Change from baseline (%)'] === '' && /change undefined/.test(row.Note)) ? true : short([csv.rows.length, sorium[0]])
    }],
    ['campaign page: race 2 on the percent scale draws all eleven, each from 0 % at the first save', () => {
      const { vm } = mount({ snapshots: campaign.races[2].snapshots, config: config(firstIds(11), 'percent') })

      return drawnOf(vm).length === 11 && drawnOf(vm).every((dataset) => dataset.data.length === 150 && dataset.data[0].y === 0) && idOfName('Gallicite') === 11 && drawnOf(vm).find((dataset) => dataset.label === 'Gallicite').data[149].y > 0 ? true : short(drawnOf(vm).map((dataset) => dataset.data[0].y))
    }],
  ]
}

const campaignStatements = (m, campaign) => {
  const { compareMinerals } = m.compare
  const { MINERALS } = m.minerals
  const ids11 = MINERALS.map((mineral) => mineral.id)
  const tolerance = 0.05

  // The percent change of a mineral over a stretch of saves worked from the unrounded sums read from each save.
  const oracleOf = (race, id, from = 0) => race.oracle.slice(from).map((sums) => (100 * (sums[id - 1] - race.oracle[from][id - 1])) / race.oracle[from][id - 1])
  const worst = (actual, expected) => actual.reduce((largest, value, index) => (value === null ? Infinity : Math.max(largest, Math.abs(value - expected[index]))), 0)

  return [
    ['campaign: the recorded saves are 150, five game days apart, and each gives a snapshot of both races', () => {
      const times = campaign.races[1].snapshots.map((snapshot) => snapshot.t)

      return times.length === 150 && times.every((t, index) => index === 0 || t - times[index - 1] === 5 * 86400) && equal(times, campaign.races[2].snapshots.map((snapshot) => snapshot.t)) && campaign.races[1].snapshots.every((snapshot) => snapshot.minerals.length === 11) ? true : short(times.slice(0, 3))
    }],
    ['campaign: race 1 holds no Gallicite in any save, so its change is undefined on the whole campaign', () => {
      const [series] = compareMinerals(campaign.races[1].snapshots, [11]).series

      return campaign.races[1].oracle.every((sums) => sums[10] === 0) && series.normalisation.defined === false && series.normalisation.code === 'zero' && series.percent.every((value) => value === null) && equal(series.baseline, { t: campaign.races[1].snapshots[0].t, stock: 0 }) ? true : short(series.normalisation)
    }],
    ['campaign: race 1\'s other ten minerals have a change that matches the unrounded sums of the saves', () => {
      const race = campaign.races[1]
      const problems = ids11.filter((id) => id !== 11).map((id) => {
        const [series] = compareMinerals(race.snapshots, [id]).series
        const gap = series.normalisation.defined ? worst(series.percent, oracleOf(race, id)) : Infinity

        return gap <= tolerance ? null : `${id}: ${gap}`
      }).filter(Boolean)

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['campaign: race 1\'s Neutronium, which no colony touches, stays at 0 % and its Sorium falls', () => {
      const race = campaign.races[1]
      const [neutronium] = compareMinerals(race.snapshots, [2]).series
      const [sorium] = compareMinerals(race.snapshots, [8]).series

      return neutronium.percent.every((value) => near(value, 0)) && sorium.percent[149] < -5 && sorium.percent.every((value, index) => index === 0 || value <= sorium.percent[index - 1] + 1e-9) ? true : short([neutronium.percent[149], sorium.percent[149]])
    }],
    ['campaign: race 2\'s eleven minerals all have a change that matches the unrounded sums of the saves', () => {
      const race = campaign.races[2]
      const problems = compareMinerals(race.snapshots, ids11).series.map((series) => {
        const gap = series.normalisation.defined ? worst(series.percent, oracleOf(race, series.id)) : Infinity

        return gap <= tolerance ? null : `${series.id}: ${gap}`
      }).filter(Boolean)

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['campaign: the last year of saves has its own baseline, the first of its saves', () => {
      const race = campaign.races[2]
      const window = race.snapshots.slice(77)
      const series = compareMinerals(window, ids11).series
      const problems = series.map((entry) => {
        const gap = entry.normalisation.defined ? worst(entry.percent, oracleOf(race, entry.id, 77)) : Infinity

        return gap <= tolerance && entry.baseline.t === window[0].t && entry.baseline.stock === window[0].minerals[entry.id - 1] && near(entry.percent[0], 0) ? null : `${entry.id}: ${gap}`
      }).filter(Boolean)

      return window.length === 73 && problems.length === 0 ? true : problems.join('; ')
    }],
  ]
}

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

// The snapshots the app takes of each of the recorded saves in `files`, and the unrounded sums of the colony stockpiles read from the save itself.
const readCampaign = async (m, files) => {
  const names = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
  const races = Object.fromEntries(CAMPAIGN_RACES.map((race) => [race, { snapshots: [], oracle: [] }]))

  for (const file of files) {
    const database = await openSave(file)

    try {
      for (const RaceID of CAMPAIGN_RACES) {
        const { snapshot } = await m.history.takeSnapshot(database, { GameID: CAMPAIGN_GAME, RaceID })
        const [[sums]] = await database.query(`select ${names.map((name, index) => `sum(FCT_Population.${name}) as m${index}`).join(', ')} from FCT_Population where FCT_Population.GameID = ${CAMPAIGN_GAME} and FCT_Population.RaceID = ${RaceID}`)

        races[RaceID].snapshots.push(snapshot)
        races[RaceID].oracle.push(names.map((_name, index) => sums[`m${index}`]))
      }
    } finally {
      await database.close()
    }
  }

  return { races }
}

// ---------- mutations ----------

const UTILITY = 'mineral-compare.js'

// A cut of the utility and the checks that must fail for it: each name is the start of the name of a check, and the cut is caught only when a check of every name fails. `campaign` names the checks of the recorded campaign that must fail too, when it is there.
const MUTATIONS = [
  { name: 'the baseline taken from the last sample', find: 'const baseline = samples.length ? samples[0] : null', replace: 'const baseline = samples.length ? samples[samples.length - 1] : null', fails: ['the baseline is the first sample of the window', 'the percent change is 100 x'], campaign: ['campaign: the last year of saves has its own baseline'] },
  { name: 'the baseline moved on to the first stock that is recorded', find: 'const baseline = samples.length ? samples[0] : null', replace: 'const baseline = samples.find((sample) => sample.stock !== null) || null', fails: ['an unknown starting stock makes the change undefined'] },
  { name: 'a zero starting stock taken as a baseline', find: 'first.stock === 0 ? \'zero\'', replace: 'first.stock === 0 ? null', fails: ['a zero starting stock makes the change undefined, never infinity or 0', 'a mineral that is 0 t throughout is undefined in every window'], campaign: ['campaign: race 1 holds no Gallicite'] },
  { name: 'a baseline of 0 t given a percentage', find: 'baseline > 0 ? (100', replace: 'baseline >= 0 ? (100', fails: ['no percentage is taken from a baseline that is not above 0'] },
  { name: 'an unknown starting stock taken as defined', find: 'first.stock === null ? \'unknown\'', replace: 'first.stock === null ? null', fails: ['an unknown starting stock makes the change undefined'] },
  { name: 'an unknown stock read as 0', find: 'stock: valueOrNull(mineralResult(snapshot, id, mineral.name))', replace: 'stock: valueOrNull(mineralResult(snapshot, id, mineral.name)) || 0', fails: ['a stock the snapshot does not hold is unknown, not 0', 'the CSV leaves an unknown figure as an empty cell'] },
  { name: 'a change taken the wrong way round', find: '(100 * (stock - baseline)) / baseline', replace: '(100 * (baseline - stock)) / baseline', fails: ['the percent change is 100 x', 'the CSV has a row for each mineral at each snapshot of the window'], campaign: ['campaign: race 1\'s other ten minerals', 'campaign: race 2\'s eleven minerals'] },
  { name: 'a change taken as a share of the stock', find: '(100 * (stock - baseline)) / baseline', replace: '(100 * (stock - baseline)) / stock', fails: ['the percent change is 100 x'], campaign: ['campaign: race 2\'s eleven minerals'] },
  { name: 'an empty window given a baseline of 0', find: 'const baseline = samples.length ? samples[0] : null', replace: 'const baseline = samples.length ? samples[0] : { t: 0, stock: 0 }', fails: ['a window with no snapshot has no baseline'] },
  { name: 'two minerals of the first nine sharing a slot', find: 'export const MINERAL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 3]', replace: 'export const MINERAL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 3, 2, 3]', fails: ['each mineral\'s colour is the palette slot fixed for its ID', 'the first nine minerals have nine different colours', 'a mineral that owns its slot leaves the slot its own dash'] },
  { name: 'a mineral of the page\'s start sharing a colour with another', find: 'export const MINERAL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 3]', replace: 'export const MINERAL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 1]', fails: ['the minerals the page starts with have different colours', 'each mineral\'s colour is the palette slot fixed for its ID'] },
  { name: 'the colour taken by position among the minerals', find: 'const slot = MINERAL_SLOTS[index]', replace: 'const slot = MINERAL_SLOTS[(index + 1) % MINERAL_SLOTS.length]', fails: ['each mineral\'s colour is the palette slot fixed for its ID'] },
  { name: 'the shared slots drawn without a dash of their own', find: 'dash: shared ? SHARED_DASH : []', replace: 'dash: []', fails: ['a mineral that shares a colour slot is drawn with a dash of its own', 'a mineral that owns its slot leaves the slot its own dash, and every mineral is told apart'] },
  { name: 'the shared slots drawn with the dash of a slot', find: 'const SHARED_DASH = [6, 2, 1, 2]', replace: 'const SHARED_DASH = [9, 4]', fails: ['a mineral that shares a colour slot is drawn with a dash of its own'] },
  { name: 'a mineral that owns its slot given a dash', find: 'dash: shared ? SHARED_DASH : []', replace: 'dash: SHARED_DASH', fails: ['a mineral that owns its slot leaves the slot its own dash'] },
  { name: 'an ID that is no mineral\'s given a style', find: 'if (index < 0) {\n    return null\n  }', replace: 'if (index < 0) {\n    return { slot: 0, color: palette[0], dash: [], shared: false }\n  }', fails: ['an ID that is no mineral\'s has no style'] },
  { name: 'the unit left off the stock column of the CSV', find: '\'Stock (t)\', \'Baseline stock (t)\'', replace: '\'Stock\', \'Baseline stock (t)\'', fails: ['the CSV names a unit on every value column'] },
  { name: 'the unit left off the change column of the CSV', find: '\'Change from baseline (%)\', \'Note\'', replace: '\'Change from baseline\', \'Note\'', fails: ['the CSV names a unit on every value column'] },
  { name: 'the unit left off the game time of the CSV', find: '\'Game time (s)\', \'Date\'', replace: '\'Game time\', \'Date\'', fails: ['the CSV names a unit on every value column'] },
  { name: 'the baseline left out of the rows of the CSV', find: 'baseline.stock, baseline.t, date(baseline.t), series.percent[position]', replace: 'null, null, \'\', series.percent[position]', fails: ['the CSV gives each mineral\'s baseline stock and game time'] },
  { name: 'the baseline date left out of the rows of the CSV', find: 'baseline.t, date(baseline.t), series.percent[position]', replace: 'baseline.t, \'\', series.percent[position]', fails: ['the CSV gives each mineral\'s baseline stock and game time'] },
  { name: 'an unknown figure written as 0 in the CSV', find: 'row.map((value) => csvCell(value))', replace: 'row.map((value) => csvCell(value ?? 0))', fails: ['the CSV leaves an unknown figure as an empty cell', 'the CSV says why a change is undefined, and leaves it empty'] },
  { name: 'the reason a change is undefined left out of the CSV', find: 'series.normalisation.defined ? \'\' :', replace: 'true ? \'\' :', fails: ['the CSV says why a change is undefined'] },
  { name: 'a stock that is not recorded left unexplained in the CSV', find: '\'stock not recorded\'', replace: '\'\'', fails: ['the CSV leaves an unknown figure as an empty cell, never 0, and says so'] },
  { name: 'the scale left out of the CSV', find: 'named.label, sample.t', replace: '\'\', sample.t', fails: ['the CSV states the scale on every row'] },
  { name: 'the scale of the CSV always the first', find: 'const named = MINERAL_SCALES.find((entry) => entry.value === scale) || MINERAL_SCALES[0]', replace: 'const named = MINERAL_SCALES[0]', fails: ['the CSV states the scale on every row'] },
  { name: 'the colour of the CSV taken from the position', find: 'style.slot + 1, style.color', replace: 'series.id, palette[series.id % 9]', fails: ['the CSV ties each row to the mineral ID, and the palette slot and colour of that ID'] },
  { name: 'the cells of the CSV not written by the shared writer', find: 'row.map((value) => csvCell(value))', replace: 'row.map((value) => value)', fails: ['the CSV quotes a cell that holds a comma, a quote or a newline', 'the CSV writes a carriage return'] },
  { name: 'a carriage return does not quote a cell', file: 'csv-cell.js', find: '/[",\\r\\n]/.test(text)', replace: '/[",\\n]/.test(text)', fails: ['the CSV writes a carriage return'] },
  { name: 'a text that starts like a formula is not guarded', file: 'csv-cell.js', find: 'guard && typeof value === \'string\' && FORMULA_START.test(value)', replace: 'false', fails: ['the CSV writes a carriage return'] },
  { name: 'the change not registered in percent', find: 'units: \'%\',', replace: 'units: \'\',', fails: ['the change is registered as a rule'] },
  { name: 'the axis of the percent scale without its unit', find: 'axis: \'Change from baseline (%)\'', replace: 'axis: \'Change from baseline\'', fails: ['the scales are the stock in tonnes and the change in percent, each with its axis title and unit'] },
  { name: 'the gap of the CSV taken from the first row', find: 'position ? sample.t - series.samples[position - 1].t : null', replace: 'position ? sample.t - series.samples[0].t : null', fails: ['the CSV gives the seconds since each mineral'] },
  { name: 'the gap of the CSV left out', find: 'position ? sample.t - series.samples[position - 1].t : null', replace: 'null', fails: ['the CSV gives the seconds since each mineral'] },
  { name: 'the retention note left out of the CSV', find: 'order || position ? null : retention]', replace: 'null]', fails: ['the CSV gives the seconds since each mineral'] },
  { name: 'the retention note on every row of the CSV', find: 'order || position ? null : retention]', replace: 'retention]', fails: ['the CSV gives the seconds since each mineral'] },
  { name: 'the retention note on the first row of each mineral', find: 'order || position ? null : retention]', replace: 'position ? null : retention]', fails: ['the CSV gives the seconds since each mineral'] },
]

const mutatedCopy = (file, from, to) => {
  refusePlanting(`${file}: ${from}`)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mineral-compare-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation does not apply to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

// A cut of the page's script and the statements that must fail for it.
const PAGE_MUTATIONS = [
  { name: 'the minerals picked kept for the race, not the app', find: 'default: [1, 2, 11], normalise', replace: 'default: [1, 2, 11], scope: \'race\', normalise', fails: ['page: the minerals picked and the scale are views declared for the app', 'page: the minerals picked are the app\'s, the same for every race and campaign', 'page: a pick stored app-wide before', 'page: a preferences bundle that holds the minerals picked', 'page: Reset all clears the minerals picked and the scale the page wrote, and one empire\'s reset leaves them'] },
  { name: 'the scale kept for the race', find: 'mineralScale: { key: \'historyMineralScale\', default: \'absolute\',', replace: 'mineralScale: { key: \'historyMineralScale\', default: \'absolute\', scope: \'race\',', fails: ['page: the minerals picked and the scale are views declared for the app', 'page: the minerals picked and the scale survive'] },
  { name: 'a stored pick not read back', find: 'normalise: (stored) => (Array.isArray(stored) ?', replace: 'normalise: (stored) => (false ?', fails: ['page: the minerals picked and the scale survive leaving the page and a restart', 'page: a pick stored app-wide before'] },
  { name: 'a stored pick not cleaned of what is not offered', find: 'MINERALS.map((mineral) => mineral.id).filter((id) => stored.includes(id)) : undefined', replace: 'stored : undefined', fails: ['page: a stored pick this version does not offer is cleaned'] },
  { name: 'the minerals picked reset by a scale change', find: '  watch: {\n    // Another campaign or branch', replace: '  watch: {\n    mineralScale() {\n      this.mineralIds = [1, 2, 11]\n    },\n    // Another campaign or branch', fails: ['page: a scale change keeps the minerals picked', 'page: the minerals picked and the scale survive'] },
  { name: 'the colour taken by position among the minerals drawn', find: 'const style = mineralStyle(palette, entry.id)\n\n            return {', replace: 'const style = mineralStyle(palette, drawn.indexOf(entry) + 1)\n\n            return {', fails: ['page: a mineral is drawn in the colour of its ID', 'page: picking or dropping a mineral recolours no other', 'campaign page: each mineral keeps its colour'] },
  { name: 'the chips and the lines of different colours', find: 'return { value: mineral.id, text: mineral.name, color: style.color, dash: style.dash,', replace: 'return { value: mineral.id, text: mineral.name, color: palette[8 - (mineral.id % 9)], dash: style.dash,', fails: ['page: the chips of the picker'] },
  { name: 'the dash of the shared slots left off the chart', find: 'borderColor: style.color,\n              backgroundColor: withAlpha(style.color, 0.1),\n              borderDash: style.dash,', replace: 'borderColor: style.color,\n              backgroundColor: withAlpha(style.color, 0.1),\n              borderDash: [],', fails: ['page: the shared slots are told apart by a dash that reaches the chart'] },
  { name: 'the order of picking kept', find: 'this.mineralIds = MINERALS.map((mineral) => mineral.id).filter((id) => ids.includes(id))', replace: 'this.mineralIds = ids', fails: ['page: the order the minerals are picked in changes nothing'] },
  { name: 'a mineral with an undefined change drawn on the percent scale', find: 'const drawn = series.filter((entry) => !percent || entry.normalisation.defined)', replace: 'const drawn = series', fails: ['page: on the percent scale a mineral whose change is undefined has no line', 'campaign page: race 1 on the percent scale draws ten minerals', 'page: a mineral is drawn in the colour of its ID'] },
  { name: 'an undefined change not flagged in the legend', find: 'flag: undefinedChange ? \'undefined\' : \'\'', replace: 'flag: \'\'', fails: ['page: on the percent scale a mineral whose change is undefined has no line, and says why', 'campaign page: race 1 on the percent scale draws ten minerals'] },
  { name: 'an undefined change flagged on the stock scale', find: 'const undefinedChange = percent && !!entry && !entry.normalisation.defined', replace: 'const undefinedChange = !!entry && !entry.normalisation.defined', fails: ['page: on the stock scale a mineral whose change is undefined is drawn and nothing is flagged'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the reason an undefined change gives left out of the notes', find: '`${entry.name}: change undefined, so no line is drawn, because ${entry.normalisation.reason} (${this.date(entry.baseline.t)}).`', replace: '`${entry.name}: change undefined, so no line is drawn.`', fails: ['page: on the percent scale a mineral whose change is undefined has no line, and says why', 'campaign page: race 1 on the percent scale draws ten minerals'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the baseline left out of the notes', find: '`${entry.name}: baseline ${this.count(entry.baseline.stock, 0)} t, at ${this.date(entry.baseline.t)}.`', replace: '`${entry.name}: baseline.`', fails: ['page: the baseline and its game time are shown for each mineral on the percent scale', 'page: the span chosen sets the baseline'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the date of the baseline left out of the notes', find: 't, at ${this.date(entry.baseline.t)}.`', replace: 't.`', fails: ['page: the baseline and its game time are shown for each mineral on the percent scale'] },
  { name: 'the baseline taken over every snapshot, not the span', find: 'compareMinerals(this.snapshots, this.mineralIds)', replace: 'compareMinerals(this.allSnapshots, this.mineralIds)', fails: ['page: the span chosen sets the baseline', 'page: the CSV follows the span chosen'] },
  { name: 'an unknown stock drawn as 0', find: 'y: percent ? entry.percent[position] : sample.stock, stock: sample.stock', replace: 'y: (percent ? entry.percent[position] : sample.stock) || 0, stock: sample.stock', fails: ['page: on the stock scale every mineral is drawn in tonnes', 'page: on the percent scale the change from the first snapshot is drawn, an unknown stock as a gap'] },
  { name: 'the percent scale drawing the stock', find: 'y: percent ? entry.percent[position] : sample.stock', replace: 'y: sample.stock', fails: ['page: on the percent scale the change from the first snapshot is drawn'] },
  { name: 'Reset leaving the span at a narrower one', find: 'resetMineralRange() {\n      this.span = 0', replace: 'resetMineralRange() {\n      this.span = 20', fails: ['page: Reset restores the full retained range', 'page: Reset is offered only while the span is narrowed'] },
  { name: 'Reset not touching the span', find: 'resetMineralRange() {\n      this.span = 0', replace: 'resetMineralRange() {\n      this.span = this.span', fails: ['page: Reset restores the full retained range'] },
  { name: 'Reset clearing the minerals picked', find: 'resetMineralRange() {\n      this.span = 0', replace: 'resetMineralRange() {\n      this.mineralIds = []\n      this.span = 0', fails: ['page: Reset keeps the minerals picked and the scale'] },
  { name: 'Reset putting the scale back', find: 'resetMineralRange() {\n      this.span = 0', replace: 'resetMineralRange() {\n      this.mineralScale = \'absolute\'\n      this.span = 0', fails: ['page: Reset keeps the minerals picked and the scale'] },
  { name: 'Reset always offered', find: 'resetDisabled: this.span === 0', replace: 'resetDisabled: false', fails: ['page: Reset is offered only while the span is narrowed'] },
  { name: 'the CSV always offered', find: 'csvDisabled: !this.mineralIds.length || !this.snapshots.length', replace: 'csvDisabled: false', fails: ['page: the CSV is offered only with a mineral picked', 'page: a stored pick this version does not offer is cleaned'] },
  { name: 'the CSV always on the stock scale', find: 'scale: this.mineralScale, palette: this.theme.categorical', replace: 'scale: \'absolute\', palette: this.theme.categorical', fails: ['page: the CSV the page writes follows the scale shown'] },
  { name: 'the CSV of every snapshot, not the span', find: 'comparisonCsv({ comparison: this.mineralComparison,', replace: 'comparisonCsv({ comparison: compareMinerals(this.allSnapshots, this.mineralIds),', fails: ['page: the CSV follows the span chosen'] },
  { name: 'the CSV in the colours of another theme', find: 'palette: this.theme.categorical, date: (seconds) => this.date(seconds), retention', replace: 'palette: MINERALS.map(() => \'#000000\'), date: (seconds) => this.date(seconds), retention', fails: ['page: the CSV the page writes follows the scale shown'] },
  { name: 'the axis left without its title', find: 'options.scales.y.title = { display: true, text: scale.axis }', replace: 'options.scales.y.title = { display: false, text: \'\' }', fails: ['page: the axis names its unit on each scale'] },
  { name: 'the level of the baseline left off the percent chart', find: 'options.plugins.guides.levels = [{ y: 0 }]', replace: 'options.plugins.guides.levels = []', fails: ['page: the axis names its unit on each scale'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the tooltip dropping the stock behind a change', find: '`${name}: ${signed(item.parsed.y)} (${this.count(stock, 0)} t)`', replace: '`${name}: ${signed(item.parsed.y)}`', fails: ['page: the tooltip gives the stock in tonnes'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the tooltip giving an unknown figure as 0', find: 'return `${name}: ${UNKNOWN_TEXT}`', replace: 'return `${name}: 0 t`', fails: ['page: the tooltip gives the stock in tonnes'] },
  { name: 'the summary left unchanged by a count', find: 'Track stockpiles of the selected minerals over time.\',', replace: 'Track stockpiles of the selected minerals over time, 11 in all.\',', fails: ['page: the section\'s summary says what it shows without a figure that changes'] },
  { name: 'the change rule left off the section', find: 'rules: [\'history.stockpile\', \'history.mineralChange\'],', replace: 'rules: [\'history.stockpile\'],', fails: ['page: the section\'s summary says what it shows'] },
  { name: 'the default picks changed', find: 'default: [1, 2, 11], normalise', replace: 'default: [1, 2, 3], normalise', fails: ['page: the minerals picked and the scale are views declared for the app', 'page: the minerals the page starts with are Duranium, Neutronium and Gallicite'] },
]

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own, the campaign read in slices before them ----------

const MUTANTS = [...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })), ...PAGE_MUTATIONS.map((mutation, index) => ({ kind: 'page', id: `page:${index}`, ...mutation }))]

const modulesOf = (loaded, appearance) => ({ compare: loaded['mineral-compare'], minerals: loaded.minerals, provenance: loaded.provenance, history: loaded.history, encodings: appearance.SERIES_ENCODINGS })

const loadAppearance = async () => (await loadUtilities(['appearance'], { stubs: { vue: 'export default { observable: (value) => value }' } })).appearance

const themesOf = (appearance) => Object.fromEntries(Object.keys(appearance.PRESETS).map((id) => [id, appearance.resolveAppearance(id).charts.categorical]))

// The recorded campaign as the parent read it (a structured clone, so nothing a snapshot holds is changed), or null when it is not there.
const campaignOf = (file) => (file ? v8.deserialize(fs.readFileSync(file)) : null)

// The checks of the real sources over a synthetic snapshot set and the recorded campaign; the statements of the page.
const checkHead = async (campaignFile) => {
  const appearance = await loadAppearance()
  const themes = themesOf(appearance)
  const m = modulesOf(await loadUtilities(NAMES, { stubs: STUBS }), appearance)
  const campaign = campaignOf(campaignFile)
  const synthetic = (loaded) => [...pure(loaded, themes), ...(campaign ? campaignStatements(loaded, campaign) : [])]

  console.log('\nThe comparison, on snapshots worked by hand and on the recorded campaign')

  for (const [name, test] of synthetic(m)) {
    let result

    try {
      result = test()
    } catch (error) {
      result = `threw ${error.stack}`
    }

    check(name, result)
  }

  console.log('\nThe Empire History page (its script as a Vue instance, over scripts/lib/page-loader.js)')

  const settings = await loadUtilities(['campaign', 'preferences', 'remembered-views'], { stubs: STUBS })
  const context = { m, themes, campaign, settings }

  for (const [statement, held] of await pageStatements(null, context)) {
    check(statement, await held())
  }

  check('the page raises no Vue warning', warnings.length === 0 ? true : warnings.slice(0, 3).join(' | '))
}

const checkUtilityMutation = async ({ name, find, replace, fails, campaign: campaignFails = [], file = UTILITY }, campaignFile) => {
  const appearance = await loadAppearance()
  const themes = themesOf(appearance)
  const campaign = campaignOf(campaignFile)
  const synthetic = (loaded) => [...pure(loaded, themes), ...(campaign ? campaignStatements(loaded, campaign) : [])]
  const directory = mutatedCopy(file, find, replace)
  const began = Date.now()

  try {
    const names = campaign ? [...fails, ...campaignFails] : fails
    let failed = null
    let absent = []

    try {
      const mutant = modulesOf(await loadUtilities(NAMES, { stubs: STUBS, directory }), appearance)

      // Only the checks the mutation names are run: the others cannot change what it must break.
      const named = synthetic(mutant).filter(([checkName]) => names.some((start) => checkName.startsWith(start)))

      absent = names.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))
      failed = named.filter(([, test]) => {
        try {
          return test() !== true
        } catch (error) {
          return true
        }
      }).map(([checkName]) => checkName)
    } catch (error) {
      check(`mutation caught: ${name}`, `does not load: ${error.message}`)

      return
    }

    const missed = names.filter((start) => !failed.some((checkName) => checkName.startsWith(start)))

    check(`mutation caught: ${name}`, absent.length ? `no check begins ${absent.join('; ')}` : missed.length ? `these checks did not fail: ${missed.join('; ')}` : true, `${failed.length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const checkPageMutation = async ({ name, find, replace, fails }, campaignFile) => {
  refusePlanting(name)

  const appearance = await loadAppearance()
  const m = modulesOf(await loadUtilities(NAMES, { stubs: STUBS }), appearance)
  const settings = await loadUtilities(['campaign', 'preferences', 'remembered-views'], { stubs: STUBS })
  const context = { m, themes: themesOf(appearance), campaign: campaignOf(campaignFile), settings }
  const began = Date.now()
  let failed = null
  let absent = []

  try {
    const statements = await pageStatements(replacing(find, replace), context)
    const named = statements.filter(([statement]) => fails.some((start) => statement.startsWith(start)))

    absent = fails.filter((start) => !named.some(([statement]) => statement.startsWith(start)))
    failed = []

    for (const [statement, held] of named) {
      if ((await held()) !== true) {
        failed.push(statement)
      }
    }
  } catch (error) {
    check(`page mutation caught: ${name}`, `does not load: ${error.message}`)

    return
  }

  const missed = fails.filter((start) => !failed.some((statement) => statement.startsWith(start)))

  check(`page mutation caught: ${name}`, absent.length ? `no statement begins ${absent.join('; ')}` : missed.length ? `these statements did not fail: ${missed.join('; ')}` : true, `${failed.length} statements fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// Reads the share `slice` of `of` of the recorded saves into `out`, as the structured clone `campaignOf` reads.
const readSlice = async (slice, of, out) => {
  const appearance = await loadAppearance()
  const m = modulesOf(await loadUtilities(NAMES, { stubs: STUBS }), appearance)
  const files = campaignFiles()
  const share = Math.ceil(files.length / of)

  fs.writeFileSync(out, v8.serialize(await readCampaign(m, files.slice(slice * share, (slice + 1) * share))))
}

const parseArguments = (argv) => {
  const options = { part: null, campaign: null, slice: null }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      continue
    } else if (argv[index] === '--campaign') {
      options.campaign = argv[++index]
    } else if (argv[index] === '--slice') {
      options.slice = [Number(argv[index + 1]), Number(argv[index + 2]), argv[index + 3]]
      index += 3
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
    } else if (mutant && mutant.kind === 'utility') {
      await checkUtilityMutation(mutant, options.campaign)
    } else if (mutant) {
      await checkPageMutation(mutant, options.campaign)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  console.log('The recorded campaign: the snapshots of each save (this takes a while)')

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mineral-compare-campaign-'))

  try {
    const files = campaignFiles()
    let campaignFile = null

    if (files) {
      const count = Math.min(jobs(), files.length)
      const outs = Array.from({ length: count }, (_unused, slice) => path.join(directory, `slice-${slice}.bin`))

      await runSections(__filename, outs.map((out, slice) => ({ args: ['--slice', String(slice), String(count), out] })))

      const slices = outs.map((out) => v8.deserialize(fs.readFileSync(out)))
      const races = Object.fromEntries(CAMPAIGN_RACES.map((race) => [race, { snapshots: slices.flatMap((slice) => slice.races[race].snapshots), oracle: slices.flatMap((slice) => slice.races[race].oracle) }]))

      campaignFile = path.join(directory, 'campaign.bin')
      fs.writeFileSync(campaignFile, v8.serialize({ races }))
      console.log(`  ${races[1].snapshots.length} saves read for ${CAMPAIGN_RACES.length} races`)
    } else {
      console.log('SKIP  the passive campaign (artifacts/passive-campaign-20261013) is not there')
    }

    const forwarded = campaignFile ? ['--campaign', campaignFile] : []
    const parts = [{ part: 'head', weight: 30 }, ...(mutating() ? MUTANTS : []).map(({ id }) => ({ part: id, weight: 3 }))]
    const sections = await runSections(__filename, parts.map(({ part, weight }) => ({ args: ['--part', part, ...forwarded], weight })))
    let at = 0

    const printed = () => {
      const counts = printSection(sections[at++])

      checks += counts.checks
      failures += counts.failures
    }

    printed()

    if (mutating()) {
      console.log('\nMutations: each must fail the checks it names')
      MUTANTS.forEach(printed)
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
