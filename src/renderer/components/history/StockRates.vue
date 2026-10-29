<template>
  <v-card class="panel history-rates" data-summary="How fast a stock of the race or of a followed colony changed over recorded snapshots." elevation="1">
    <div class="panel-head">
      <span>Stock rates<provenance-mark v-for="rule in rules" :key="rule" :rule="rule" /></span>
      <span class="caption text--secondary" data-rates-caption>{{ caption }}</span>
    </div>
    <div class="panel-body">
      <div class="history-rates__controls">
        <v-btn-toggle v-model="rateScope" mandatory dense class="mr-3" data-rates-scope>
          <v-btn v-for="option in scopes" :key="option.value" :value="option.value" small :title="option.title">{{ option.text }}</v-btn>
        </v-btn-toggle>
        <v-select v-if="scope === 'colony' && colonyOptions.length" :value="colonyId" :items="colonyOptions" label="Colony" dense hide-details class="history-rates__select mr-3" data-rates-colony @change="rateColony = $event" />
        <v-select :value="stockKey" :items="stockOptions" label="Stock" dense hide-details class="history-rates__select mr-3" data-rates-stock @change="rateStock = $event" />
        <v-btn-toggle v-model="rateWindow" mandatory dense data-rates-window>
          <v-btn v-for="option in windows" :key="option.value" :value="option.value" small :title="option.title">{{ option.text }}</v-btn>
        </v-btn-toggle>
      </div>

      <div v-if="unavailableText" class="caption text--secondary mt-3" data-rates-unavailable>{{ unavailableText }}</div>
      <template v-else>
        <v-alert :type="verdict.type" outlined dense class="mt-3 mb-2" data-rates-verdict><strong>{{ kindText }}.</strong> {{ analysis.reason }}</v-alert>

        <div class="history-rates__figures">
          <div v-for="figure in figures" :key="figure.key" class="history-rates__figure" :data-rates-figure="figure.key">
            <span class="history-rates__label">{{ figure.label }}<provenance-mark :result="figure.result" /></span>
            <span class="history-rates__value">{{ figure.text }}</span>
          </div>
        </div>

        <div v-if="chart" class="mt-3">
          <div class="legend">
            <span v-for="series in chart.data.datasets" :key="series.label" class="legend-item"><series-key :color="series.borderColor" :dash="series.borderDash" kind="line" />{{ series.label }}</span>
          </div>
          <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="220" :label="chartLabel" data-chart="stock-rates" />
        </div>

        <div v-for="note in analysis.notes" :key="note" class="caption text--secondary mt-1" data-rates-note>{{ note }}</div>

        <details class="mt-3" data-rates-table-details>
          <summary class="caption">Observations as a table</summary>
          <div class="history-rates__list mt-2">
            <table data-rates-table>
              <thead>
                <tr><th>Date</th><th class="text-right">Stock ({{ stock.unit }})</th><th class="text-right">Since previous</th><th class="text-right">Rate ({{ stock.unit }}/yr)</th><th>Note</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in tableRows" :key="row.t">
                  <td>{{ row.date }}</td>
                  <td class="text-right">{{ row.value }}</td>
                  <td class="text-right">{{ row.change }}</td>
                  <td class="text-right">{{ row.rate }}</td>
                  <td>{{ row.note }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>

        <div class="history-rates__export mt-2">
          <v-btn x-small text :disabled="!analysis.rows.length" title="Download the figures, the window, the first and last observation, the sampling gaps, the assumptions and every observation of the window as a CSV, with the rule and status of each figure" data-rates-csv @click="downloadCsv"><v-icon x-small left>mdi-download</v-icon>Shown CSV</v-btn>
          <v-btn x-small text title="Copy the same facts as plain text" data-rates-copy @click="copyText"><v-icon x-small left>mdi-content-copy</v-icon>Copy text</v-btn>
          <span v-if="message" class="caption ml-2" data-rates-message>{{ message }}</span>
        </div>
      </template>

      <div class="caption text--secondary mt-3" data-rates-limits>Rates are per game year over the chosen window of recorded snapshots, with the number of observations each rests on, never from what happened between two saves. Observations at one game time count once, a stock that was not recorded is left out, never read as 0, and a colony that left the save, changed hands or could not be read is not an observation. A step from a transfer or spending, too few observations and a flat or rising stock are told apart. A depletion estimate is shown only for a steady decline over at least {{ minSamples }} observations, with no step and no large opposing changes in the window; its date is the last observation plus the years the estimate gives, and it is an estimate from the window chosen, not a prediction that the stock runs out. Every export names the campaign, the branch, the game, the race and its ID and, for a colony, its PopulationID.</div>
    </div>
  </v-card>
</template>

<script>
import persistedView, { oneOf } from '../../mixins/persisted-view'
import { UNKNOWN_TEXT, countText, isKnownNumber } from '../../utilities/math'
import { retentionNote } from '../../utilities/history'
import { KIND_TEXT, MIN_SAMPLES, SCOPES, STOCKS, WINDOWS, analyseStock, chartPoints, colonyObservations, empireObservations, latestOf, ratesCsv, ratesText, stockOf, stocksOf } from '../../utilities/stock-rates'
import { chartTheme, withAlpha } from '../charts/theme'
import { activeAppearance } from '../../utilities/appearance'
import ChartCanvas from '../charts/ChartCanvas.vue'
import SeriesKey from '../charts/SeriesKey.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'

const COMPACT = (value) => {
  if (!isKnownNumber(value)) {
    return UNKNOWN_TEXT
  }

  const size = Math.abs(value)

  return size >= 1e9 ? `${Math.round(value / 1e7) / 100} bn` : size >= 1e6 ? `${Math.round(value / 1e4) / 100} M` : size >= 1e3 ? `${Math.round(value / 100) / 10} k` : `${Math.round(value * 10) / 10}`
}

const KIND_ALERT = { declining: 'warning', spike: 'info', volatile: 'info', nondeclining: 'success', empty: 'warning' }

// The panel of the History page that gives the observed rate of one stock of the race or of a followed colony over a window of the recorded snapshots, with the observations behind it and a cautious depletion estimate where they support one. `empireRecord` is the race's history record (its snapshots), `colonyRecord` the shown branch's colony file as the page reads it ({ file, error }), `colonies` the colonies the Colony series panel follows (the settings' entries), `chartOptions` the page's chart options and `year` and `date` its time axis and dates. Everything calculated is in utilities/stock-rates.js; this only chooses, draws and saves.
export default {
  name: 'StockRates',
  components: { ChartCanvas, ProvenanceMark, SeriesKey },
  mixins: [
    persistedView({
      rateScope: { key: 'historyRateScope', default: SCOPES.EMPIRE, valid: oneOf(Object.values(SCOPES)) },
      rateStock: { key: 'historyRateStock', default: 'fuel', valid: oneOf(STOCKS.map((stock) => stock.key)) },
      rateWindow: { key: 'historyRateWindow', default: 5, valid: oneOf(WINDOWS) },
      rateColony: { key: 'historyRateColony', default: null, scope: 'race', normalise: (stored) => (Number.isSafeInteger(stored) && stored > 0 ? stored : null) },
    }),
  ],
  props: {
    empireRecord: {
      type: Object,
      default: null,
    },
    colonyRecord: {
      type: Object,
      default: () => ({ file: null, error: '' }),
    },
    colonies: {
      type: Array,
      default: () => [],
    },
    raceId: {
      type: [Number, String],
      default: null,
    },
    campaignId: {
      type: String,
      default: null,
    },
    branchId: {
      type: String,
      default: null,
    },
    gameId: {
      type: [Number, String],
      default: null,
    },
    raceName: {
      type: String,
      default: '',
    },
    chartOptions: {
      type: Function,
      default: () => ({}),
    },
    year: {
      type: Function,
      default: (seconds) => seconds / 31536000,
    },
    date: {
      type: Function,
      default: (seconds) => String(seconds),
    },
    separator: {
      type: String,
      default: '\'',
    },
  },
  data() {
    return {
      message: '',
    }
  },
  computed: {
    rules() {
      return ['stockRates.rate', 'stockRates.depletion']
    },
    minSamples() {
      return MIN_SAMPLES
    },
    scopes() {
      return [
        { value: SCOPES.EMPIRE, text: 'Empire', title: 'The stocks of every colony of the race together, as the history snapshots record them' },
        { value: SCOPES.COLONY, text: 'Colony', title: 'One colony the Colony series panel follows' },
      ]
    },
    windows() {
      return WINDOWS.map((years) => ({ value: years, text: years ? `${years} y` : 'All', title: years ? `The last ${years} game ${years === 1 ? 'year' : 'years'} before the latest snapshot` : 'Every retained snapshot' }))
    },
    scope() {
      return this.rateScope
    },
    stockOptions() {
      return stocksOf(this.scope).map((stock) => ({ value: stock.key, text: `${stock.label} (${stock.unit})` }))
    },
    // The stock chosen, or the first the scope offers when the one stored is not offered (the treasury has no colony figure).
    stockKey() {
      return stocksOf(this.scope).some((stock) => stock.key === this.rateStock) ? this.rateStock : stocksOf(this.scope)[0].key
    },
    stock() {
      return stockOf(this.stockKey)
    },
    // The colonies the settings follow, one entry for each, the latest stamp of an ID giving its name.
    colonyOptions() {
      const latest = new Map()

      this.colonies.forEach((entry) => latest.set(entry.id, entry))

      return [...latest.values()].map((entry) => ({ value: entry.id, text: `${entry.name || `Colony ${entry.id}`}${entry.until === undefined ? '' : ' (stopped)'}` }))
    },
    // The colony chosen, or the first followed when the one stored is not among them.
    colonyId() {
      return this.colonyOptions.some((option) => option.value === this.rateColony) ? this.rateColony : this.colonyOptions.length ? this.colonyOptions[0].value : null
    },
    colonyName() {
      const option = this.colonyOptions.find((candidate) => candidate.value === this.colonyId)

      return option ? option.text : ''
    },
    // The race's colony series in the shown branch's colony file, and its column names.
    colonySeries() {
      const file = this.colonyRecord ? this.colonyRecord.file : null
      const series = file && file.races ? file.races[this.raceId] : null

      return series && Array.isArray(series.snapshots) ? { record: series, columns: Array.isArray(file.columns) ? file.columns : [] } : null
    },
    // The record the window counts back from and its retention note, and the observations of the series chosen.
    source() {
      if (this.scope === SCOPES.EMPIRE) {
        const snapshots = this.empireRecord && Array.isArray(this.empireRecord.snapshots) ? this.empireRecord.snapshots : []

        return { snapshots, observations: empireObservations(snapshots, this.stock), record: this.empireRecord }
      }

      const series = this.colonySeries

      return { snapshots: series ? series.record.snapshots : [], observations: series && this.colonyId !== null ? colonyObservations(series.record, this.colonyId, this.stock, series.columns) : [], record: series ? series.record : null }
    },
    // Why there is nothing to analyse, or '' when there is a series to read.
    unavailableText() {
      if (this.scope === SCOPES.COLONY) {
        if (this.colonyRecord && this.colonyRecord.error) {
          return `The colony series of this branch could not be read (${this.colonyRecord.error}), so no colony rate is shown.`
        }

        if (!this.colonyOptions.length) {
          return 'No colony is followed. Follow one in the Colony series panel; each save read after that adds an observation, and nothing is recorded for a colony before it is followed.'
        }

        if (!this.colonySeries) {
          return 'No colony series is recorded on this branch yet: it records one reading for each save read after a colony is followed.'
        }
      }

      return this.source.snapshots.length ? '' : 'No snapshot is recorded for the race, so there is nothing to read a rate from.'
    },
    analysis() {
      const scope = { kind: this.scope, name: this.scope === SCOPES.COLONY ? this.colonyName : this.raceName, raceName: this.raceName, RaceID: this.raceId, colonyId: this.scope === SCOPES.COLONY ? this.colonyId : null, campaignId: this.campaignId, branchId: this.branchId, GameID: this.gameId }

      return analyseStock({ stock: this.stock, scope, observations: this.source.observations, latest: latestOf(this.source.snapshots), years: this.rateWindow, format: this.format, date: this.date, retention: this.source.record ? retentionNote(this.source.record, this.date) : '' })
    },
    caption() {
      return this.unavailableText ? 'Unavailable' : `${this.analysis.window.years ? `last ${this.analysis.window.years} y` : 'all snapshots'}; ${this.analysis.basis.samples} observations`
    },
    kindText() {
      return KIND_TEXT[this.analysis.kind]
    },
    verdict() {
      return { type: KIND_ALERT[this.analysis.kind] || 'info' }
    },
    figures() {
      const { rate, relative, depletion, earliest, basis, stock } = this.analysis
      const unit = stock.unit

      return [
        { key: 'rate', label: 'Rate', result: rate, text: rate.value === null ? UNKNOWN_TEXT : `${this.signed(rate.value)} ${unit} per game year, from ${this.format(basis.samples)} observations` },
        { key: 'relative', label: 'Relative rate', result: relative, text: relative.value === null ? UNKNOWN_TEXT : `${this.signed(relative.value)} % of the first observation per game year` },
        { key: 'depletion', label: 'Depletion, estimated', result: depletion, text: depletion.value === null ? `none (${KIND_TEXT[this.analysis.kind]})` : `about ${this.format(depletion.value, 1)} game years after the last observation, around ${this.date(this.analysis.depletionAt)}` },
        { key: 'earliest', label: 'Earliest bound', result: earliest, text: earliest.value === null ? 'none' : `about ${this.format(earliest.value, 1)} game years after the last observation, around ${this.date(this.analysis.earliestAt)}` },
      ]
    },
    chartLabel() {
      return `${this.stock.label} (${this.stock.unit}) over ${this.analysis.window.text}`
    },
    chart() {
      if (!this.analysis.rows.length) {
        return null
      }

      const palette = chartTheme(activeAppearance()).categorical
      const points = chartPoints(this.analysis)
      const unit = this.stock.unit
      const line = (label, color, data, extra = {}) => ({ label, data: data.map((point) => ({ x: this.year(point.t), y: point.value })), borderColor: color, backgroundColor: withAlpha(color, 0.1), borderWidth: 2, pointRadius: data.length > 40 ? 0 : 3, pointHoverRadius: 4, tension: 0, spanGaps: false, ...extra })
      const datasets = [line(`${this.stock.label} (${unit}), observed`, palette[0], points.observed), ...(points.average ? [line('Average rate over the window', palette[1], points.average, { borderDash: [6, 3], pointRadius: 0 })] : [])]

      return { data: { datasets }, options: this.chartOptions({ y: (value) => `${COMPACT(value)} ${unit}` }, (value) => (isKnownNumber(value) ? `${this.format(value, Math.abs(value) < 100 ? 1 : 0)} ${unit}` : UNKNOWN_TEXT)) }
    },
    tableRows() {
      return this.analysis.rows.map((row) => ({
        t: row.t,
        date: this.date(row.t),
        value: row.value === null ? UNKNOWN_TEXT : this.format(row.value, Math.abs(row.value) < 100 ? 1 : 0),
        change: row.change === null ? UNKNOWN_TEXT : this.signed(row.change),
        rate: row.rate === null ? UNKNOWN_TEXT : this.signed(row.rate.value),
        note: row.value === null ? `not recorded: ${row.result.inputs.missing.join(', ')}` : row.spike ? 'a step: far larger than the other changes in the window (a transfer or spending, not a steady rate)' : '',
      }))
    },
  },
  methods: {
    format(value, decimals = 0) {
      return countText(value, decimals, this.separator)
    },
    signed(value) {
      const text = this.format(Math.abs(value), Math.abs(value) < 100 ? 1 : 0)

      return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text
    },
    fileName() {
      const part = (value) => String(value === null || value === undefined || value === '' ? 'unsettled' : value).replace(/[^\w-]+/g, '_')

      return `${part(this.raceName || 'race')}-${part(this.campaignId)}-${part(this.branchId)}-${this.scope === SCOPES.COLONY ? `colony-${part(this.colonyId)}` : 'empire'}-${this.stock.key.toLowerCase()}-rate.csv`
    },
    downloadCsv() {
      const csv = ratesCsv(this.analysis, { date: this.date, retention: this.source.record ? retentionNote(this.source.record, this.date) : '' })
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      link.download = this.fileName()
      link.click()
      URL.revokeObjectURL(link.href)
      this.message = 'The CSV was saved.'
    },
    async copyText() {
      try {
        await navigator.clipboard.writeText(ratesText(this.analysis, { date: this.date, format: this.format }))
        this.message = 'The text was copied.'
      } catch (error) {
        this.message = `The text could not be copied (${error && error.message ? error.message : 'the clipboard is not available'}).`
      }
    },
  },
}
</script>

<style scoped lang="scss">
.history-rates__controls {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 0;
}

.history-rates__select {
  max-width: 240px;
  min-width: 160px;
}

.history-rates__figure {
  column-gap: 12px;
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.history-rates__label {
  flex: 0 0 180px;
  opacity: 0.75;
}

.history-rates__value {
  flex: 1 1 260px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.history-rates__list {
  max-height: 320px;
  overflow: auto;
}

.history-rates__list th,
.history-rates__list td {
  padding: 2px 12px 2px 0;
  text-align: left;
  white-space: nowrap;
}

.history-rates__list .text-right {
  text-align: right;
}

.legend {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.legend-item {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
</style>
