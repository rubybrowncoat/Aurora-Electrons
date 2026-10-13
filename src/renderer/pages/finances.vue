<template>
  <div>
    <v-container fluid class="finances-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Window</span>
          <v-btn-toggle v-model="windowDays" mandatory dense>
            <v-btn v-for="days in windowOptions" :key="days" :value="days" small>{{ days }} d</v-btn>
          </v-btn-toggle>
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" class="mt-3" @retry="retryFailedInputs" />

      <template v-if="ready">
        <v-alert v-if="!steps.length" type="info" outlined dense class="mt-3">
          {{ noHistoryText }}
        </v-alert>

        <v-row class="mt-2">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" :ripple="false" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value" :title="tile.value"><v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon><span class="stat-value__text">{{ tile.value }}</span><provenance-mark :result="tile.result" /></div>
              <div class="stat-note caption text--secondary">{{ tile.note }}<provenance-mark v-if="tile.noteResult" :result="tile.noteResult" /></div>
            </v-card>
          </v-col>
        </v-row>

        <template v-if="steps.length">
          <v-card class="panel" data-summary="Wealth the empire earned and spent in each production cycle, by category, with the net, to see whether income covers spending." elevation="1">
            <div class="panel-head">
              <span>Income and spending, every {{ stepLabel }}<provenance-mark :result="ledger.cycle" /><provenance-mark :result="ledger.stepLedger" label /></span>
              <v-btn-toggle v-model="flowsView" mandatory dense>
                <v-btn value="chart" small><v-icon small>mdi-chart-bar</v-icon></v-btn>
                <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
              </v-btn-toggle>
            </div>
            <div class="panel-body">
              <template v-if="flowsView === 'chart'">
                <div class="legend">
                  <span v-for="category in categories" :key="category.id" class="legend-item">
                    <series-key :color="category.color" />{{ category.label }}
                  </span>
                  <span class="legend-item"><span class="swatch swatch-line" :style="{ background: theme.ink }" />Net</span>
                </div>
                <chart-canvas type="bar" :data="flowsChart" :options="flowsOptions" :height="320" label="Wealth income and spending per production cycle, by category" />
                <div class="caption text--secondary mt-2">Income above zero, spending below. The line is the net of each cycle.</div>
              </template>
              <v-data-table v-else :headers="stepHeaders" :items="stepRows" item-key="time" :custom-sort="sortSteps" :sort-by.sync="stepsTable.sortBy" :sort-desc.sync="stepsTable.sortDesc" :items-per-page.sync="stepsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: stepPageSizes }" dense>
                <template v-for="header in amountHeaders" #[header.slot]="{ item }">{{ money(item[header.value]) }}</template>
                <template #[`item.net`]="{ item }">{{ signed(item.net) }}</template>
              </v-data-table>
            </div>
          </v-card>

          <v-row>
            <v-col cols="12" lg="6">
              <v-card class="panel" data-summary="Each source of income and each kind of spending as a yearly total and a share, to see what funds the empire and what costs most." elevation="1">
                <div class="panel-head">
                  <span>Where it comes from and goes</span>
                  <span><v-chip small>Per year, last {{ coverageText }}</v-chip><provenance-mark :result="ledger.coverage" /></span>
                </div>
                <div class="panel-body">
                  <div v-for="group in categoryGroups" :key="group.label" class="category-group">
                    <div class="category-group-head">
                      <span>{{ group.label }}</span>
                      <span class="text-no-wrap">{{ money(group.result.value) }} / yr<provenance-mark :result="group.result" /></span>
                    </div>
                    <div v-for="category in group.items" :key="category.id" class="category-row">
                      <span class="category-name"><span class="swatch" :style="{ background: category.color }" />{{ category.label }}</span>
                      <span class="category-meter">
                        <span class="category-meter-fill" :style="{ width: `${category.barWidth}%`, background: category.color }" />
                      </span>
                      <span class="category-value text-no-wrap">{{ money(category.perYear) }}</span>
                      <span class="category-share caption text--secondary text-no-wrap">{{ percent(category.share) }}<provenance-mark v-if="category.share === null" :result="category.shareResult" /></span>
                    </div>
                    <div v-if="!group.items.length" class="caption text--secondary">None in this window.</div>
                  </div>
                </div>
              </v-card>
            </v-col>
            <v-col cols="12" lg="6">
              <v-card class="panel" data-summary="Treasury balance over the window, to see whether wealth is building up or draining away." elevation="1">
                <div class="panel-head">
                  <span>Treasury<provenance-mark :result="ledger.treasurySeries" label /></span>
                </div>
                <div class="panel-body">
                  <div v-if="treasurySeriesMissing" class="caption text--secondary">{{ treasurySeriesMissing }}</div>
                  <chart-canvas v-else type="line" :data="treasuryChart" :options="treasuryOptions" :height="280" label="Treasury balance over the window, worked back from today" />
                  <div class="caption text--secondary mt-2">Worked back from today's treasury through each cycle's net. Anything the game doesn't log as income or spending (trade deals, events) isn't in it.</div>
                </div>
              </v-card>
            </v-col>
          </v-row>
        </template>

        <v-card class="panel" data-summary="What a civilian shipping line is paid per unit carried and per billion km in this save's game version, a worked payout estimate, and the wealth log's civilian uses, kept apart from the race's complete spending." elevation="1">
          <div class="panel-head">
            <span>Civilian shipping-line payouts<provenance-mark rule="civilianTariff.rates" label /></span>
            <v-chip small>{{ tariffVersionText }}</v-chip>
          </div>
          <div class="panel-body">
            <v-row>
              <v-col cols="12" lg="6">
                <div class="subtitle-2 mb-1">Rate by category, per unit carried and per billion km travelled</div>
                <v-simple-table dense class="tariff-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th class="text-right">Wealth</th>
                      <th>Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in tariffRows" :key="row.category.id">
                      <td>{{ row.category.label }}</td>
                      <td class="text-right text-no-wrap">{{ amountText(row.rate.value) }}<provenance-mark :result="row.rate" /></td>
                      <td class="caption text--secondary">{{ row.rate.value === null ? limitationText(row.rate) : `per ${row.category.unit}, per billion km` }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </v-col>
              <v-col cols="12" lg="6">
                <div class="subtitle-2 mb-1">Worked estimate of a payout</div>
                <v-row dense>
                  <v-col cols="12" sm="4">
                    <v-select v-model="tariffCategory" :items="tariffCategories" item-text="label" item-value="id" label="Category" aria-label="Payout category" dense outlined hide-details />
                  </v-col>
                  <v-col cols="6" sm="4">
                    <v-text-field v-model="tariffQuantity" type="number" min="0" label="Units carried" aria-label="Units carried" dense outlined hide-details />
                  </v-col>
                  <v-col cols="6" sm="4">
                    <v-text-field v-model="tariffDistance" type="number" min="0" label="One-way loaded distance, billion km" aria-label="One-way loaded distance in billion km" dense outlined hide-details />
                  </v-col>
                </v-row>
                <div class="mt-3">Payout to the shipping line: <span class="font-weight-medium">{{ amountText(estimate.value) }}</span><provenance-mark :result="estimate" label /></div>
                <div class="caption text--secondary">{{ estimate.value === null ? limitationText(estimate) : estimateBasis }}</div>
              </v-col>
            </v-row>

            <div class="subtitle-2 mt-4 mb-1">What the wealth log holds on civilian shipping<provenance-mark :result="ledger.stepLedger" /></div>
            <v-simple-table v-if="civilianRows.length" dense class="tariff-table">
              <thead>
                <tr>
                  <th>Use</th>
                  <th>Side</th>
                  <th class="text-right">Per year</th>
                  <th class="text-right">Share of its side</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in civilianRows" :key="row.id">
                  <td>{{ row.label }}</td>
                  <td>{{ row.income ? 'Income' : 'Spending' }}</td>
                  <td class="text-right text-no-wrap">{{ money(row.perYear) }}</td>
                  <td class="text-right text-no-wrap">{{ percent(row.share) }}</td>
                </tr>
              </tbody>
            </v-simple-table>
            <div v-else class="caption text--secondary">{{ steps.length ? 'None of the civilian uses logged an amount in this window.' : 'No wealth history in this window, so no civilian use is listed.' }}</div>
            <div class="mt-3">Logged spending of the race, every use: {{ money(spendingPerYear) }} a year, of which the civilian spending uses above are {{ money(civilianSpending) }}<provenance-mark :result="ledger.spending" /></div>
            <div class="mt-1">Net cost of shipping-line payouts to the treasury: <span class="font-weight-medium">{{ netCost.value === null ? '—' : signed(netCost.value) }}</span><provenance-mark :result="netCost" label /></div>
            <div class="caption text--secondary">{{ netCost.value === null ? limitationText(netCost) : 'The window\'s logged payout uses less the logged taxes on them.' }}</div>
          </div>
          <div class="panel-foot caption text--secondary">A shipping-line payout is what a line earns for a trip at the rates above, with the distance in billion km: the one-way route travelled loaded, every unit carried the whole leg. A computer-run empire's lines are paid half of it. The log holds the race's own flows, and its spending is the race's whole logged expenditure. The civilian uses are listed as the game logs them; nothing states which of them, if any, carries a payout or offsets one, so a payout is not added to the spending, no net cost is worked out, and the estimate is shown only for a game version the rates are published for.</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { gameTime } from '../utilities/aurora'
import { loadFormulaVersion } from '../utilities/capabilities'
import { CATEGORIES, amountText, civilianCategories, describeTariffVersion, netCostResult, payoutEstimate, rateOf, treasuryMapping } from '../utilities/civilian-tariff'
import { HISTORY_DAYS, SECONDS_PER_DAY, buildLedger, reasonText, statusText } from '../utilities/finances'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { valueOrNull } from '../utilities/provenance'

const WINDOW_DAYS = [30, 90, 180, 365]
const FLOWS_VIEWS = ['chart', 'table']
const STEP_PAGE_SIZES = [15, 30, -1]

const INPUT_LABELS = {
  treasury: 'the treasury',
  wealth: 'the wealth history',
  formulaVersion: 'the save\'s schema',
}

const TARIFF_MAPPING = treasuryMapping()

// A number typed in a field, null while the field is empty or is not a number.
const typed = (text) => (text === '' || text === null || text === undefined || !Number.isFinite(Number(text)) ? null : Number(text))

const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 2)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 0)}`
}

export default {
  name: 'FinancesPage',
  components: { ChartCanvas, LoadState, ProvenanceMark, SeriesKey },
  mixins: [
    loadState(INPUT_LABELS),
    persistedView({
      windowDays: { key: 'financesWindowDays', default: 365 },
      flowsView: { key: 'financesFlowsView', default: 'chart', valid: oneOf(FLOWS_VIEWS) },
      stepsTable: tableView('financesStepsTable', { itemsPerPage: 15, itemsPerPageOptions: STEP_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      windowOptions: WINDOW_DAYS,
      stepPageSizes: STEP_PAGE_SIZES,
      tariffCategories: CATEGORIES,
      tariffCategory: 'tradeGood',
      tariffQuantity: '100',
      tariffDistance: '5',
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),
    ...mapState(['RaceNPR']),

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

    ready() {
      return this.inputsLoaded && !!this.treasury
    },

    ledger() {
      return buildLedger({ treasury: this.treasury, wealth: this.wealth, windowDays: this.windowDays })
    },

    // Each logged time stands for the cycle before it.
    steps() {
      return this.ledger.steps
    },

    amountsByStep() {
      return this.ledger.amountsByStep
    },

    netByStep() {
      return this.ledger.netByStep
    },

    stepDates() {
      return this.steps.map((time) => this.date(time))
    },

    noHistoryText() {
      const { missing } = this.ledger

      if (missing === 'wealth history') {
        return 'The save has no wealth history for this race yet. Aurora logs income and spending every production cycle.'
      }

      if (missing === 'wealth amounts') {
        return 'A wealth amount is missing from a logged cycle in this window, so no income, spending, net or runway figure is given. A shorter window may avoid it.'
      }

      return missing === 'wealth history in the window' ? `The save has no wealth history in the last ${this.windowDays} days. A longer window may hold some.` : `No figures can be worked out: the save lacks the ${missing}.`
    },

    // The cycle lengths, measured from the history (the game's construction cycle can differ from 5 days, and phases can differ in length).
    stepLabel() {
      const { cycle, longestCycleDays } = this.ledger

      if (cycle.value === null) {
        return 'cycle'
      }

      return longestCycleDays > cycle.value ? `${this.daysText(cycle.value)} to ${this.daysText(longestCycleDays)}` : this.daysText(cycle.value)
    },

    coverageText() {
      const { coverage } = this.ledger

      return coverage.value === null ? 'unknown span' : `${roundToDecimal(coverage.value, 0)} days`
    },

    // Every use in the window, income first, in the game's display order, each with its colour.
    categories() {
      const palette = this.theme.categorical

      return this.ledger.categories.map((category, index) => ({ ...category, color: index < palette.length ? palette[index] : withAlpha(palette[index % palette.length], 0.55) }))
    },

    categoryGroups() {
      const { categories, ledger } = this

      return [
        { label: 'Income', result: ledger.income, items: categories.filter((category) => category.income).sort((a, b) => b.total - a.total) },
        { label: 'Spending', result: ledger.spending, items: categories.filter((category) => !category.income).sort((a, b) => b.total - a.total) },
      ]
    },

    tariffVersionText() {
      return describeTariffVersion(this.formulaVersion)
    },

    // Each category's published rate for the save's game version.
    tariffRows() {
      return CATEGORIES.map((category) => ({ category, rate: rateOf(this.formulaVersion, category.id) }))
    },

    // The payout the worked estimate's fields stand for, for the selected race's kind (a computer-run empire is paid at half).
    estimate() {
      return payoutEstimate({ version: this.formulaVersion, category: this.tariffCategory, quantity: typed(this.tariffQuantity), billionKm: typed(this.tariffDistance), npr: this.RaceNPR })
    },

    // How the estimate is worked out, said beside it.
    estimateBasis() {
      return `Units carried times the rate times the one-way loaded route distance in billion km, with every unit carried the whole leg${this.RaceNPR ? ', times 0.5 for a computer-run empire' : ''}.`
    },

    // The ledger's civilian uses, listed as logged.
    civilianRows() {
      return civilianCategories(this.ledger.categories)
    },

    spendingPerYear() {
      return valueOrNull(this.ledger.spending)
    },

    // The civilian uses on the spending side, a year; unknown when any of them has no yearly figure.
    civilianSpending() {
      const rows = this.civilianRows.filter((row) => !row.income)

      return rows.some((row) => row.perYear === null) || !this.steps.length ? null : rows.reduce((total, row) => total + row.perYear, 0)
    },

    // No source places the civilian uses against a shipping-line payout, so this stays unavailable.
    netCost() {
      return netCostResult({ version: this.formulaVersion, mapping: TARIFF_MAPPING, totals: Object.fromEntries(this.ledger.categories.map((category) => [category.id, category.total])) })
    },

    tiles() {
      const { treasury, income, spending, net, windowChange, runway, biggest } = this.ledger
      const balance = treasury.value
      const annual = this.treasury && Number.isFinite(this.treasury.AnnualWealth) ? this.treasury.AnnualWealth : null

      return [
        {
          label: 'Treasury',
          value: this.money(balance),
          note: windowChange.value === null ? reasonText(windowChange) : `${this.signed(windowChange.value)} over the last ${this.coverageText}`,
          icon: balance !== null && balance < 0 ? 'mdi-alert-octagon' : null,
          iconColor: 'error',
          result: treasury,
          noteResult: windowChange,
        },
        {
          label: 'Net per year',
          value: this.signed(net.value),
          note: this.runwayNote(runway, balance),
          icon: net.value === null ? null : net.value < 0 ? 'mdi-trending-down' : 'mdi-trending-up',
          iconColor: net.value !== null && net.value < 0 ? 'error' : 'success',
          result: net,
          noteResult: runway,
        },
        {
          label: 'Income per year',
          value: this.money(income.value),
          note: income.value === null ? reasonText(income) : annual !== null ? `Aurora's annual figure at today's rate: ${this.money(annual)}` : `Over the last ${this.coverageText}`,
          result: income,
          noteResult: null,
        },
        {
          label: 'Spending per year',
          value: this.money(spending.value),
          note: spending.value === null ? reasonText(spending) : biggest ? `Mostly ${biggest.label.toLowerCase()} (${this.percent(biggest.share)})` : 'Nothing spent',
          result: spending,
          noteResult: biggest ? biggest.shareResult : null,
        },
      ]
    },

    flowsChart() {
      const { categories, steps, amountsByStep, theme } = this
      const datasets = categories.map((category) => ({
        label: category.label,
        data: steps.map((time) => (category.income ? 1 : -1) * ((amountsByStep[time] || {})[category.id] || 0)),
        backgroundColor: category.color,
        borderColor: theme.surface,
        borderWidth: { left: 0, right: 0, top: 1, bottom: 1 },
        borderSkipped: false,
        stack: 'wealth',
        order: 2,
      }))

      datasets.push({
        type: 'line',
        label: 'Net',
        data: this.netByStep,
        borderColor: this.theme.ink,
        backgroundColor: this.theme.ink,
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0,
        order: 1,
      })

      return { labels: this.stepDates, datasets }
    },

    flowsOptions() {
      return {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, autoSkip: true, maxRotation: 0 } },
          y: {
            stacked: true,
            ticks: { callback: (value) => compact(value) },
            grid: { color: (context) => (context.tick && context.tick.value === 0 ? this.theme.inkMuted : `${this.theme.border}99`) },
          },
        },
        plugins: {
          tooltip: {
            filter: (item) => item.raw !== 0,
            callbacks: {
              label: (item) => `${item.dataset.label}: ${this.signed(item.raw)}`,
              footer: () => statusText(this.ledger.stepLedger),
            },
          },
        },
      }
    },

    treasurySeriesMissing() {
      const { treasurySeries } = this.ledger

      return treasurySeries.value === null ? `The treasury balance cannot be worked back: ${reasonText(treasurySeries).toLowerCase()}.` : ''
    },

    treasuryChart() {
      const color = this.theme.primary
      const series = valueOrNull(this.ledger.treasurySeries)
      const start = this.ledger.firstStart

      return {
        labels: series === null || start === null ? [] : [this.date(start), ...this.stepDates],
        datasets: [{
          label: 'Treasury',
          data: series === null || start === null ? [] : series,
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          fill: 'origin',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
        }],
      }
    },

    treasuryOptions() {
      return {
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 } },
          y: { ticks: { callback: (value) => compact(value) } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => `Treasury: ${this.money(item.raw)}`,
              footer: () => statusText(this.ledger.treasurySeries),
            },
          },
        },
      }
    },

    stepHeaders() {
      return [
        { text: 'Cycle ending', value: 'date' },
        ...this.amountHeaders,
        { text: 'Net', value: 'net', align: 'end' },
      ]
    },

    // The headers of the uses, each with the name of the cell slot that formats it.
    amountHeaders() {
      return this.categories.map((category) => ({ text: category.label, value: `use${category.id}`, slot: `item.use${category.id}`, align: 'end' }))
    },

    stepRows() {
      const { steps, stepDates, categories, amountsByStep, netByStep } = this

      return steps.map((time, index) => ({
        time,
        date: stepDates[index],
        ...Object.fromEntries(categories.map((category) => [`use${category.id}`, ((amountsByStep[time] || {})[category.id] || 0) * (category.income ? 1 : -1)])),
        net: netByStep[index],
      })).reverse()
    },
  },
  methods: {
    // A rate or payout in text, a dash for an unknown one.
    amountText(value) {
      return amountText(value, this.separator)
    },
    // Why a result has no figure, said as a limitation: what it needs.
    limitationText(result) {
      const { missing } = result.inputs

      return missing.length ? `Not estimated: needs ${missing.join(' and ')}.` : 'Not estimated.'
    },
    money(value) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, 0), this.separator) : '—'
    },
    signed(value) {
      return Number.isFinite(value) ? `${value < 0 ? '−' : '+'}${this.money(Math.abs(value))}` : '—'
    },
    percent(fraction) {
      return Number.isFinite(fraction) ? `${roundToDecimal(fraction * 100, 1)}%` : '—'
    },
    years(value) {
      return value < 1 ? `${Math.max(1, Math.round(value * 12))} months` : `${roundToDecimal(value, 1)} years`
    },
    date(seconds) {
      return this.treasury ? gameTime(this.treasury.StartYear, seconds).format('YYYY-MM-DD') : ''
    },
    // A length in days, in hours when it is under a day.
    daysText(value) {
      return value < 1 ? `${roundToDecimal(value * 24, 1)} hours` : `${roundToDecimal(value, 1)} days`
    },
    // What the net per year means for the treasury; an unknown net or treasury reads as unknown, never as a covered treasury.
    runwayNote(runway, balance) {
      if (runway.value === null) {
        return `Runway unknown: ${reasonText(runway).toLowerCase()}`
      }

      if (runway.value.state === 'lasts') {
        return `The treasury lasts ${this.years(runway.value.years)} at this rate`
      }

      if (balance < 0) {
        return 'In debt: production slows until it\'s paid off'
      }

      return runway.value.state === 'depleted' ? 'The treasury is empty and spending exceeds income' : 'Income covers spending'
    },
    // Sorts the cycles table by the numbers behind its cells, a cycle by its time and an unknown value last in either direction.
    sortSteps(items, sortBy, sortDesc) {
      const [by] = sortBy

      if (!by) {
        return items
      }

      const key = by === 'date' ? 'time' : by
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
  },
  asyncComputed: {
    treasury: {
      get: tracked('treasury', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await this.database.query(`select FCT_Race.WealthPoints, FCT_Race.AnnualWealth, FCT_Game.GameTime, FCT_Game.StartYear from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    // The formula version the save's schema stands for (`loadFormulaVersion`, utilities/capabilities.js): the stated one for a 2.7-shaped save, null for any other shape. The civilian payout rates hold for that version only.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
    // The last year of wealth flows, one row per use and cycle, plus the cycle just before it (its end is where the first cycle began; the window filter drops it). `Amount` is always positive; the use's `Income` flag gives the sign, and is null for a use that is not in `DIM_WealthUse` (the ledger counts it as spending and says so). A group holding a logged row without an amount reads as a null `Amount`, never as the sum of the rows that have one. The game's time is a scalar subquery of its own: reading it from the outer `FCT_Game` join made the cycle lookup re-run for every ledger row (over two minutes at 50 000 rows, against 0.1 s now), and the stalled read held the connection for every page.
    wealth: {
      get: tracked('wealth', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_WealthData.UseID, coalesce(DIM_WealthUse.Description, 'Unknown (' || FCT_WealthData.UseID || ')') as Description, DIM_WealthUse.Income as Income, DIM_WealthUse.DisplayOrder, FCT_WealthData.TimeUsed, case when count(FCT_WealthData.Amount) = count(*) then sum(FCT_WealthData.Amount) end as Amount from FCT_WealthData left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID inner join FCT_Game on FCT_Game.GameID = FCT_WealthData.GameID where FCT_WealthData.GameID = ${this.GameID} and FCT_WealthData.RaceID = ${this.RaceID} and FCT_WealthData.TimeUsed >= coalesce((select max(previous.TimeUsed) from FCT_WealthData previous where previous.GameID = ${this.GameID} and previous.RaceID = ${this.RaceID} and previous.TimeUsed <= (select FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${this.GameID}) - ${HISTORY_DAYS * SECONDS_PER_DAY}), 0) group by FCT_WealthData.UseID, FCT_WealthData.TimeUsed order by FCT_WealthData.TimeUsed`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.finances-page {
  .legend {
    margin-bottom: 8px;
  }

  .swatch {
    display: inline-block;
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    margin-right: 6px;
  }

  .swatch-line {
    height: 2px;
  }

  .category-group + .category-group {
    margin-top: 16px;
  }

  .category-group-head {
    display: flex;
    justify-content: space-between;
    font-weight: 500;
    padding-bottom: 4px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--ae-rule);
    font-variant-numeric: tabular-nums;
  }

  .category-row {
    display: grid;
    grid-template-columns: minmax(140px, 1.2fr) 2fr auto 52px;
    align-items: center;
    gap: 12px;
    padding: 4px 0;
    font-size: calc(14px * var(--ae-font-scale));
    font-variant-numeric: tabular-nums;
  }

  .category-name {
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }

  .category-meter {
    height: 8px;
    border-radius: 4px;
    background: var(--ae-track-soft);
    overflow: hidden;
  }

  .category-meter-fill {
    display: block;
    height: 100%;
    border-radius: 4px;
  }

  .category-value,
  .category-share {
    text-align: right;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
