<template>
  <div>
    <v-container v-if="!historyRecorded" fluid class="history-page">
      <v-alert type="info" outlined dense>
        The app doesn't keep Empire History for this race. It's one of Aurora's special factions (such as the Precursors, Invaders or Rakhas), which have no empire to chart. History is kept for player races and NPR empires.
      </v-alert>
    </v-container>

    <v-container v-else fluid class="history-page">
      <v-row dense align="center" class="mb-1">
        <v-col class="caption text--secondary">
          <template v-if="recording">{{ recording.headline }}<provenance-mark rule="history.recordedSpan" /></template>
          The app records one each time Aurora saves while it's open, for every player race and NPR empire in the save.<provenance-mark :result="timeAxis" />
          <div v-if="recording && recording.note" class="history-recording-note">{{ recording.note }}</div>
        </v-col>
        <v-col cols="auto">
          <v-btn-toggle v-model="span" mandatory dense class="mr-2">
            <v-btn v-for="option in spanOptions" :key="option.value" :value="option.value" small :title="option.title">{{ option.text }}</v-btn>
          </v-btn-toggle>
          <v-btn-toggle v-model="view" mandatory dense>
            <v-btn value="charts" small><v-icon small>mdi-chart-line</v-icon></v-btn>
            <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
          </v-btn-toggle>
          <v-btn small text :disabled="!allSnapshots.length" class="ml-2" @click="downloadCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
          <v-btn small text color="error" :disabled="!allSnapshots.length" @click="confirmClear = true">Clear</v-btn>
        </v-col>
      </v-row>

      <v-alert v-if="failure && failure.stage === 'write'" type="warning" outlined dense class="mt-3">
        The latest snapshot couldn't be written to the history file, so this history has stopped growing: the disk or browser storage may be full, or the file locked. The app tries again at the next save. The console has the details.
      </v-alert>
      <v-alert v-else-if="failure" type="warning" outlined dense class="mt-3">
        The latest save couldn't be read for a snapshot (the game may have been writing it), so this history is missing it. The app tries again at the next save. The console has the details.
      </v-alert>

      <v-alert v-if="!allSnapshots.length" type="info" outlined dense class="mt-3">
        No history for this race yet. A snapshot is taken as soon as the app reads the save, and another each time Aurora saves the game. For the past year of income and spending, see <router-link to="/finances">Finances</router-link>.
      </v-alert>

      <template v-else>
        <stat-tiles :tiles="tiles" class="mt-1" />

        <v-alert v-if="allSnapshots.length === 1" type="info" outlined dense class="mt-4">
          History starts here. Charts fill in as Aurora saves: each save while the app is open adds a point.
        </v-alert>

        <v-card v-if="view === 'charts' && rivals" class="panel" data-summary="Every race recorded in this game on one chosen measure over time, to see who is ahead of the race and who is catching up." elevation="1">
          <div class="panel-head">
            <span>Rivals<provenance-mark :rule="rivals.rule" /> <span class="caption text--secondary ml-2">Spy mode: every race recorded in this game</span></span>
            <span class="legend">
              <span v-for="series in rivals.data.datasets" :key="series.label" class="legend-item" :class="{ 'font-weight-bold': series.borderWidth === 3 }"><series-key :color="series.borderColor" :dash="series.borderDash" kind="line" />{{ series.label }}</span>
            </span>
          </div>
          <div class="panel-body">
            <v-btn-toggle v-model="rivalMetric" mandatory dense class="mb-2 flex-wrap">
              <v-btn v-for="metric in rivalMetrics" :key="metric.value" :value="metric.value" small>{{ metric.text }}</v-btn>
            </v-btn-toggle>
            <chart-canvas type="line" :data="rivals.data" :options="rivals.options" :height="280" label="Rivals" />
          </div>
        </v-card>

        <v-row v-if="view === 'charts'">
          <v-col v-for="chart in charts" :key="chart.key" cols="12" lg="6">
            <v-card class="panel" :data-summary="chart.summary" elevation="1">
              <div class="panel-head">
                <span>{{ chart.title }}<provenance-mark v-for="rule in chart.rules" :key="rule" :rule="rule" /></span>
                <span class="legend">
                  <span v-for="series in chart.data.datasets" :key="series.label" class="legend-item"><series-key :color="series.borderColor" kind="line" />{{ series.label }}</span>
                </span>
              </div>
              <div class="panel-body">
                <div v-if="chart.picker" class="mb-2">
                  <v-chip-group :value="chart.picker.model" multiple column @change="chart.picker.change">
                    <v-chip v-for="option in chart.picker.options" :key="option.value" :value="option.value" small filter outlined>{{ option.text }}</v-chip>
                  </v-chip-group>
                </div>
                <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="240" :label="chart.title" />
                <div v-for="note in chart.notes" :key="note" class="caption text--secondary mt-1">{{ note }}</div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-card v-else class="panel" elevation="1">
          <v-data-table :headers="tableHeaders" :items="tableRows" item-key="t" :custom-sort="sortRows" :sort-by.sync="historyTable.sortBy" :sort-desc.sync="historyTable.sortDesc" :items-per-page.sync="historyTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: historyPageSizes }" dense>
            <template v-for="column in tableHeaders" #[`header.${column.value}`]="{ header }">{{ header.text }}<provenance-mark v-if="column.rule" :key="column.value" :rule="column.rule" /></template>
            <template v-for="column in measureColumns" #[`item.${column.value}`]="{ item }">{{ count(item[column.value], column.decimals) }}<provenance-mark v-if="item.results[column.value].status === 'unavailable'" :key="column.value" :result="item.results[column.value]" /></template>
          </v-data-table>
        </v-card>
      </template>

      <v-dialog v-model="confirmClear" max-width="440">
        <v-card>
          <v-card-title>Clear this race's history?</v-card-title>
          <v-card-text>This deletes the {{ allSnapshots.length }} snapshots the app has recorded for this race. The save isn't touched, and recording starts again at the next save.</v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn text @click="confirmClear = false">Cancel</v-btn>
            <v-btn text color="error" @click="clearHistory">Clear</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { gameTime } from '../utilities/aurora'
import { MAX_SNAPSHOTS, changeResult, historyConfig, installationResult, mineralResult, recordedSpan, snapshotResult, totalResult } from '../utilities/history'
import { UNKNOWN_TEXT, countText, isKnownNumber, roundToDecimal } from '../utilities/math'
import { MINERALS } from '../utilities/minerals'
import { describeResult, isAvailable, ofRule, unavailable, valueOrNull } from '../utilities/provenance'

const SECONDS_PER_YEAR = 31536000
// How far back the tiles, charts and table reach, in years before the latest snapshot; 0 is all.
const SPAN_OPTIONS = [10, 20, 50].map((years) => ({ value: years, text: `${years} y`, title: `The last ${years} years` })).concat({ value: 0, text: 'All', title: 'Every snapshot' })
const HISTORY_PAGE_SIZES = [25, 100, -1]
// Installation types charted when the player hasn't picked any: the largest by count.
const DEFAULT_INSTALLATIONS = 5

// An unknown figure reads as a dash, never 0.
const compact = (value) => {
  if (!isKnownNumber(value)) {
    return UNKNOWN_TEXT
  }

  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 2)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 1)}`
}

// Millions of people, in billions from 1,000 M (three decimals, so slow growth still shows).
const people = (millions) => (!isKnownNumber(millions) ? UNKNOWN_TEXT : Math.abs(millions) >= 1000 ? `${roundToDecimal(millions / 1000, 3)} bn` : `${roundToDecimal(millions, 1)} M`)

const whole = (value) => (isKnownNumber(value) ? `${roundToDecimal(value, 0)}` : UNKNOWN_TEXT)

const withUnit = (text, unit) => (text === UNKNOWN_TEXT ? text : `${text} ${unit}`)

const fleetResult = (snapshot) => totalResult('history.fleetTonnage', [snapshotResult(snapshot, 'militaryTons'), snapshotResult(snapshot, 'commercialTons')])

// What the Rivals chart can compare: `result` is a snapshot's figure as a result of `rule`.
const RIVAL_METRICS = [
  { value: 'population', text: 'Population', rule: 'history.population', result: (snapshot) => snapshotResult(snapshot, 'population'), format: people },
  { value: 'colonies', text: 'Colonies', rule: 'history.colonies', result: (snapshot) => snapshotResult(snapshot, 'colonies'), format: whole },
  { value: 'fleet', text: 'Fleet tonnage', rule: 'history.fleetTonnage', result: fleetResult, format: (value) => withUnit(compact(value), 't') },
  { value: 'military', text: 'Military tonnage', rule: 'history.fleetTonnage', result: (snapshot) => snapshotResult(snapshot, 'militaryTons'), format: (value) => withUnit(compact(value), 't') },
  { value: 'research', text: 'Research', rule: 'history.research', result: (snapshot) => snapshotResult(snapshot, 'research'), format: (value) => withUnit(compact(value), 'RP') },
  { value: 'systems', text: 'Known systems', rule: 'history.systems', result: (snapshot) => snapshotResult(snapshot, 'systems'), format: whole },
  { value: 'wealth', text: 'Treasury', rule: 'history.treasury', result: (snapshot) => snapshotResult(snapshot, 'wealth'), format: compact },
]

// The table's figure columns.
const MEASURES = [
  { value: 'population', text: 'Population (M)', decimals: 1, rule: 'history.population' },
  { value: 'colonies', text: 'Colonies', decimals: 0, rule: 'history.colonies' },
  { value: 'wealth', text: 'Treasury', decimals: 0, rule: 'history.treasury' },
  { value: 'militaryTons', text: 'Military (t)', decimals: 0, rule: 'history.fleetTonnage' },
  { value: 'commercialTons', text: 'Commercial (t)', decimals: 0, rule: 'history.fleetTonnage' },
  { value: 'research', text: 'Research (RP)', decimals: 0, rule: 'history.research' },
  { value: 'systems', text: 'Systems', decimals: 0, rule: 'history.systems' },
]

const RIVAL_METRIC_VALUES = RIVAL_METRICS.map((metric) => metric.value)

export default {
  name: 'HistoryPage',
  components: { ChartCanvas, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    persistedView({
      view: { key: 'historyView', default: 'charts', valid: oneOf(['charts', 'table']) },
      historyTable: tableView('historyTable', { itemsPerPage: 25, itemsPerPageOptions: HISTORY_PAGE_SIZES }),
      mineralIds: { key: 'historyMinerals', default: [1, 2, 11] },
      installationIds: { key: 'historyInstallations', default: null, scope: 'race' },
      rivalMetric: { key: 'historyRivalsMetric', default: 'population', valid: oneOf(RIVAL_METRIC_VALUES) },
      span: { key: 'historySpan', default: 0, valid: oneOf(SPAN_OPTIONS.map((option) => option.value)) },
    }),
  ],
  data() {
    return {
      confirmClear: false,
      historyPageSizes: HISTORY_PAGE_SIZES,
      measureColumns: MEASURES,
      rivalMetrics: RIVAL_METRICS,
      spanOptions: SPAN_OPTIONS,
      // Spy mode shows the other races' history (Rivals). Read on creation: it's set on Settings.
      spyNPR: false,
      // Bumped when this page clears the history, so `gameHistory` re-reads it.
      cleared: 0,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'historyRecorded']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    // The game's history file, re-read whenever the recorder writes (store revision) or this page clears it.
    gameHistory() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared

      if (!this.GameID || !this.RaceID || !this.historyRecorded) {
        return null
      }

      return historyConfig(this.GameID).store
    },

    record() {
      return this.gameHistory && this.gameHistory.races ? this.gameHistory.races[this.RaceID] || null : null
    },

    // Why the recorder missed this game's latest snapshots, if it did (see store/history.js).
    failure() {
      return this.$store.state.history.failures.find(({ GameID }) => GameID === null || GameID === Number(this.GameID)) || null
    },

    // Every snapshot recorded for the race; the CSV and Clear work on these.
    allSnapshots() {
      return this.record && Array.isArray(this.record.snapshots) ? this.record.snapshots : []
    },

    // The first game time shown: `span` years before the latest snapshot, or the start.
    since() {
      return this.span && this.allSnapshots.length ? this.allSnapshots[this.allSnapshots.length - 1].t - this.span * SECONDS_PER_YEAR : -Infinity
    },

    // The snapshots in the chosen span, for the tiles, charts and table.
    snapshots() {
      return this.allSnapshots.filter((snapshot) => snapshot.t >= this.since)
    },

    latest() {
      return this.snapshots[this.snapshots.length - 1]
    },

    // What the recording covers, labelled for the header: first and latest game dates, the span between them and how much of the chosen window it fills. Null when nothing is recorded.
    recording() {
      const coverage = recordedSpan(this.allSnapshots, this.span * SECONDS_PER_YEAR)

      if (!coverage.count) {
        return null
      }

      if (coverage.count === 1) {
        return { headline: `1 snapshot, ${this.date(coverage.first)}. No span is recorded yet, and nothing earlier was observed.`, note: '' }
      }

      const years = (seconds) => (seconds / SECONDS_PER_YEAR).toFixed(1)
      const dates = `${this.date(coverage.first)} to ${this.date(coverage.last)}`
      const covered = this.span ? `${years(coverage.covered)} of ${this.span} years recorded${coverage.inWindow < coverage.count ? `, ${coverage.inWindow} of ${coverage.count} snapshots in this window` : ''}` : `${years(coverage.seconds)} years recorded`

      return {
        headline: `${coverage.count} snapshots, ${dates}: ${covered}.`,
        note: `Game time before the first snapshot was never observed by the app and cannot be rebuilt, since snapshots keep only aggregate figures. Gaps between snapshots are expected: one is taken per save while the app is open, and past ${MAX_SNAPSHOTS} snapshots the older ones are thinned to every other one, so older stretches can be coarser than recent ones.`,
      }
    },

    // Whether the game's start year is known, which the calendar year of a snapshot needs.
    yearKnown() {
      return isKnownNumber(this.StartYear)
    },

    timeAxis() {
      return this.yearKnown ? ofRule({ rule: 'history.timeAxis', value: Number(this.StartYear), inputs: { present: ['start year'] } }) : unavailable({ rule: 'history.timeAxis', missing: ['start year'] })
    },

    tiles() {
      const first = this.snapshots[0]
      const last = this.latest
      const since = this.date(first.t)
      // The change from the first snapshot of the window to the latest: its note and its result.
      const change = (key, format) => {
        if (this.snapshots.length < 2) {
          return { note: 'First snapshot', result: null }
        }

        const result = changeResult(snapshotResult(first, key), snapshotResult(last, key))

        return result.value === null ? { note: `Change since ${since} unavailable: no ${result.inputs.missing.join(' or ')}`, result } : { note: `${result.value >= 0 ? '+' : '−'}${format(Math.abs(result.value))} since ${since}`, result }
      }
      const tile = (label, result, text, note, moved = null) => ({ label, value: text, note, title: [describeResult(result), moved ? describeResult(moved) : ''].filter(Boolean).join(' | ') })
      const population = snapshotResult(last, 'population')
      const treasury = snapshotResult(last, 'wealth')
      const research = snapshotResult(last, 'research')
      const fleet = fleetResult(last)
      const populationChange = change('population', people)
      const treasuryChange = change('wealth', compact)
      const researchChange = change('research', (value) => withUnit(compact(value), 'RP'))

      return [
        tile('Population', population, people(population.value), populationChange.note, populationChange.result),
        tile('Treasury', treasury, compact(treasury.value), treasuryChange.note, treasuryChange.result),
        tile('Fleet tonnage', fleet, withUnit(compact(fleet.value), 't'), `${withUnit(compact(valueOrNull(snapshotResult(last, 'militaryTons'))), 't')} military, ${withUnit(compact(valueOrNull(snapshotResult(last, 'commercialTons'))), 't')} commercial`),
        tile('Research', research, withUnit(compact(research.value), 'RP'), researchChange.note, researchChange.result),
      ]
    },

    installationOptions() {
      const ids = new Set()

      this.snapshots.forEach((snapshot) => Object.keys(snapshot.installations || {}).forEach((id) => ids.add(Number(id))))

      return [...ids].map((id) => ({ value: id, text: this.installationNames[id] || `Installation ${id}` })).sort((a, b) => a.text.localeCompare(b.text))
    },

    // The installation types of the latest snapshot ranked by amount; a type with no stored amount is not ranked.
    installationRanking() {
      const entries = Object.entries((this.latest && this.latest.installations) || {})
      const ranked = entries.filter(([, amount]) => isKnownNumber(amount)).sort((a, b) => b[1] - a[1])

      return { ranked, unranked: entries.length - ranked.length }
    },

    chosenInstallations() {
      return this.installationIds ? this.installationIds : this.installationRanking.ranked.slice(0, DEFAULT_INSTALLATIONS).map(([id]) => Number(id))
    },

    // What the default choice of installation types leaves out: types tied with the last one shown, and types with no stored amount.
    installationNotes() {
      const { ranked, unranked } = this.installationRanking
      const notes = []

      if (this.installationIds) {
        return notes
      }

      if (ranked.length > DEFAULT_INSTALLATIONS && ranked[DEFAULT_INSTALLATIONS - 1][1] === ranked[DEFAULT_INSTALLATIONS][1]) {
        notes.push(`Types tied with the ${DEFAULT_INSTALLATIONS}th by amount are not shown by default; pick them above.`)
      }

      if (unranked) {
        notes.push(`${unranked} installation ${unranked === 1 ? 'type has' : 'types have'} no stored amount in the latest snapshot and ${unranked === 1 ? 'is' : 'are'} not ranked.`)
      }

      return notes
    },

    charts() {
      const palette = this.theme.categorical
      const line = (label, values, index, axis = 'y') => ({
        label,
        data: this.snapshots.map((snapshot, position) => ({ x: this.year(snapshot.t), y: values[position] })),
        borderColor: palette[index % palette.length],
        backgroundColor: withAlpha(palette[index % palette.length], 0.1),
        borderWidth: 2,
        pointRadius: this.snapshots.length > 40 ? 0 : 3,
        pointHoverRadius: 4,
        tension: 0,
        yAxisID: axis,
      })
      const pick = (key) => this.snapshots.map((snapshot) => valueOrNull(snapshotResult(snapshot, key)))

      const charts = [
        {
          key: 'population',
          title: 'Population',
          rules: ['history.population', 'history.colonies'],
          summary: 'How the population and number of colonies have grown over the years, to show whether the expansion keeps pace.',
          data: { datasets: [line('Population', pick('population'), 0), line('Colonies', pick('colonies'), 1, 'y1')] },
          options: this.options({ y: people, y1: (value) => `${value}` }),
        },
        {
          key: 'wealth',
          title: 'Wealth',
          rules: ['history.treasury', 'history.income'],
          summary: 'The treasury and annual income over time, to show whether the race is saving, spending or running short.',
          data: { datasets: [line('Treasury', pick('wealth'), 0), line('Annual income', pick('income'), 1, 'y1')] },
          options: this.options({ y: compact, y1: compact }),
        },
        {
          key: 'fleet',
          title: 'Fleet tonnage',
          rules: ['history.fleetTonnage'],
          summary: 'The military and commercial tonnage fielded over time, to show how the fleet has grown or shrunk.',
          data: { datasets: [line('Military', pick('militaryTons'), 0), line('Commercial', pick('commercialTons'), 1)] },
          options: this.options({ y: (value) => `${compact(value)} t` }),
        },
        {
          key: 'research',
          title: 'Research and exploration',
          rules: ['history.research', 'history.systems'],
          summary: 'The research output and the number of systems known over time, to show how fast the race advances and explores.',
          data: { datasets: [line('Research (RP)', pick('research'), 0), line('Known systems', pick('systems'), 1, 'y1')] },
          options: this.options({ y: compact, y1: (value) => `${value}` }),
        },
        {
          key: 'minerals',
          title: 'Mineral stockpiles',
          rules: ['history.stockpile'],
          summary: 'Stockpiles of the selected minerals, over time, to spot shortages or surpluses before they hold up production.',
          picker: { model: this.mineralIds, options: MINERALS.map((mineral) => ({ value: mineral.id, text: mineral.name })), change: this.setMinerals },
          data: { datasets: this.mineralIds.map((id, index) => line(MINERALS.find((mineral) => mineral.id === id).name, this.snapshots.map((snapshot) => valueOrNull(mineralResult(snapshot, id, MINERALS.find((mineral) => mineral.id === id).name))), index)) },
          options: this.options({ y: (value) => `${compact(value)} t` }),
        },
        {
          key: 'installations',
          title: 'Installations',
          rules: ['history.installations'],
          summary: 'How many installations of the selected types have been built over time, to track industrial growth.',
          picker: { model: this.chosenInstallations, options: this.installationOptions, change: this.setInstallations },
          extraNotes: this.installationNotes,
          data: { datasets: this.chosenInstallations.map((id, index) => line(this.installationNames[id] || `Installation ${id}`, this.snapshots.map((snapshot) => valueOrNull(installationResult(snapshot, id, this.installationNames[id] || `installation ${id}`))), index)) },
          options: this.options({ y: compact }),
        },
        {
          key: 'logistics',
          title: 'Fuel and maintenance supplies',
          rules: ['history.stockpile'],
          summary: 'The fuel and maintenance supply stocks over time, to show whether the fleets can keep operating.',
          data: { datasets: [line('Fuel (L)', pick('fuel'), 0), line('MSP', pick('msp'), 1, 'y1')] },
          options: this.options({ y: (value) => `${compact(value)} L`, y1: compact }),
        },
      ]

      // A snapshot with no figure for a series leaves a gap in its line; each series says how many.
      return charts.map((chart) => ({ ...chart, notes: [...chart.data.datasets.map((dataset) => [dataset.label, dataset.data.filter((point) => point.y === null).length]).filter(([, missing]) => missing).map(([label, missing]) => `${label}: ${missing} of ${this.snapshots.length} snapshots have no figure, so the line breaks there.`), ...(chart.extraNotes || [])] }))
    },

    // Every recorded race in the game on one metric, players first; only in spy mode.
    rivals() {
      const races = this.spyNPR && this.gameHistory && this.gameHistory.races ? Object.entries(this.gameHistory.races).filter(([, record]) => record.snapshots && record.snapshots.length).sort(([a, first], [b, second]) => Number(!!first.npr) - Number(!!second.npr) || Number(a) - Number(b)) : []

      if (races.length < 2) {
        return null
      }

      const metric = RIVAL_METRICS.find((option) => option.value === this.rivalMetric) || RIVAL_METRICS[0]
      const palette = this.theme.categorical
      const datasets = races.map(([RaceID, record], index) => {
        const selected = Number(RaceID) === Number(this.RaceID)
        const color = palette[index % palette.length]

        return {
          label: record.raceName || `Race ${RaceID}`,
          data: record.snapshots.filter((snapshot) => snapshot.t >= this.since).map((snapshot) => ({ x: this.year(snapshot.t), y: valueOrNull(metric.result(snapshot)) })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          borderWidth: selected ? 3 : 1.5,
          borderDash: index >= palette.length ? [6, 4] : [],
          pointRadius: record.snapshots.length > 40 ? 0 : 2,
          pointHoverRadius: 4,
          tension: 0,
        }
      })

      return { rule: metric.rule, data: { datasets }, options: this.options({ y: metric.format }, metric.format) }
    },

    tableHeaders() {
      return [{ text: 'Date', value: 'date' }, ...MEASURES.map(({ value, text, rule }) => ({ text, value, rule, align: 'end' }))]
    },

    // Each row keeps the numbers behind its cells (null when unknown) and the result of each figure.
    tableRows() {
      return this.snapshots.slice().reverse().map((snapshot) => {
        const results = Object.fromEntries(MEASURES.map(({ value }) => [value, snapshotResult(snapshot, value)]))

        return { t: snapshot.t, date: this.date(snapshot.t), results, ...Object.fromEntries(MEASURES.map(({ value }) => [value, valueOrNull(results[value])])) }
      })
    },
  },
  created() {
    this.spyNPR = this.config.get('spyNPR', false)
  },
  methods: {
    count(value, decimals = 0) {
      return countText(value, decimals, this.separator)
    },
    // Sorts the table by the numbers behind its cells, a snapshot by its time, and an unknown figure last in either direction.
    sortRows(items, sortBy, sortDesc) {
      const [by] = sortBy

      if (!by) {
        return items
      }

      const key = by === 'date' ? 't' : by
      const direction = sortDesc[0] ? -1 : 1

      return items.slice().sort((a, b) => {
        const x = a[key]
        const y = b[key]

        if (x === y) {
          return 0
        }

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return Number.isFinite(x) ? -1 : 1
        }

        return (x - y) * direction
      })
    },
    // The calendar year of a game time; without a start year, the game years elapsed.
    year(seconds) {
      return (this.yearKnown ? Number(this.StartYear) : 0) + seconds / SECONDS_PER_YEAR
    },
    date(seconds) {
      return this.yearKnown ? gameTime(this.StartYear, seconds).format('YYYY-MM-DD') : `${roundToDecimal(seconds / SECONDS_PER_YEAR, 2)} y elapsed`
    },
    options(axes, labelFormat = null) {
      const scales = {
        x: { type: 'linear', title: { display: true, text: this.yearKnown ? 'Year' : 'Game years elapsed' }, ticks: { callback: (value) => `${roundToDecimal(value, 2)}` } },
        y: { ticks: { callback: axes.y } },
      }

      if (axes.y1) {
        scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: axes.y1 } }
      }

      return {
        scales,
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => this.date((items[0].parsed.x - (this.yearKnown ? Number(this.StartYear) : 0)) * SECONDS_PER_YEAR),
              label: (item) => `${item.dataset.label}: ${labelFormat ? labelFormat(item.parsed.y) : this.count(item.parsed.y, item.parsed.y < 100 ? 1 : 0)}`,
            },
          },
        },
      }
    },
    setMinerals(ids) {
      this.mineralIds = ids
    },
    setInstallations(ids) {
      this.installationIds = ids
    },
    // Remove this race from the game's history file; other races keep theirs.
    clearHistory() {
      const store = historyConfig(this.GameID)
      const history = store.store

      if (history.races && history.races[this.RaceID]) {
        delete history.races[this.RaceID]
        store.store = history
      }

      this.cleared++
      this.confirmClear = false
    },
    downloadCsv() {
      const names = Object.fromEntries(this.installationOptions.map((option) => [option.value, option.text]))
      const installationIds = Object.keys(names).map(Number)
      const header = ['GameTime', 'Date', 'Population (M)', 'Colonies', 'Treasury', 'Annual income', 'Fuel (L)', 'MSP', ...MINERALS.map((mineral) => `${mineral.name} (t)`), 'Military ships', 'Military tons', 'Commercial ships', 'Commercial tons', 'Research (RP)', 'Known systems', 'Commanders', ...installationIds.map((id) => names[id]), 'Figures not recorded']
      const quote = (value) => (typeof value === 'string' && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
      // A figure that was not recorded is an empty cell, never 0; the last column names every one of them, the stockpiles and installations included.
      const rows = this.allSnapshots.map((snapshot) => {
        const results = [...['population', 'colonies', 'wealth', 'income', 'fuel', 'msp'].map((key) => snapshotResult(snapshot, key)), ...MINERALS.map((mineral) => mineralResult(snapshot, mineral.id, mineral.name)), ...['militaryShips', 'militaryTons', 'commercialShips', 'commercialTons', 'research', 'systems', 'commanders'].map((key) => snapshotResult(snapshot, key)), ...installationIds.map((id) => installationResult(snapshot, id, names[id]))]

        return [snapshot.t, this.date(snapshot.t), ...results.map(valueOrNull), results.filter((result) => !isAvailable(result)).flatMap((result) => result.inputs.missing).join('; ')]
      })
      const csv = [header, ...rows].map((row) => row.map(quote).join(',')).join('\n')
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      link.download = `${(this.record.raceName || 'race').replace(/[^\w-]+/g, '_')}-history.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    },
  },
  asyncComputed: {
    installationNames: {
      async get() {
        if (!this.database) {
          return {}
        }

        const rows = await this.database.query('select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name from DIM_PlanetaryInstallation').then(([items]) => items)

        return Object.fromEntries(rows.map((row) => [row.PlanetaryInstallationID, row.Name]))
      },
      default: {},
    },
  },
}
</script>

<style lang="scss">
.history-page {
  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
