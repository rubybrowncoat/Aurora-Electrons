<template>
  <v-card class="panel shipping-runway" data-summary="Compare when the treasury runs out under civilian shipping scenarios." elevation="1">
    <div class="panel-head">
      <span>Treasury runway under shipping scenarios<provenance-mark rule="shippingRunway.exhaustion" label /></span>
      <v-btn-toggle v-model="horizon" mandatory dense aria-label="Horizon in years">
        <v-btn v-for="span in horizons" :key="span" :value="span" small>{{ span }} y</v-btn>
      </v-btn-toggle>
    </div>
    <div v-if="taxState.loading || taxState.failed" class="px-4 py-2">
      <load-state :failed="taxState.failed" :error="taxState.error" :loading="taxState.loading" @retry="$emit('retry')" />
    </div>
    <div v-else class="panel-body">
      <v-alert v-if="!ledger.steps.length" type="info" outlined dense>No wealth history in the window, so no scenario can be worked out.</v-alert>

      <div class="d-flex flex-wrap align-center mb-2">
        <v-chip small label color="success" outlined class="mr-2">Actual</v-chip>
        <span class="subtitle-2">Logged civilian shipping, last {{ windowDays }} days, as a year</span>
      </div>
      <v-simple-table dense class="shipping-table">
        <thead>
          <tr>
            <th>Flow</th>
            <th class="text-right">Per year</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Civilian Contracts paid to shipping lines</td>
            <td class="text-right text-no-wrap">{{ money(model.flows.contracts.value) }}<provenance-mark :result="model.flows.contracts" /></td>
          </tr>
          <tr>
            <td>Shipping taxes taken</td>
            <td class="text-right text-no-wrap">{{ money(model.flows.taxes.value) }}<provenance-mark :result="model.flows.taxes" /></td>
          </tr>
          <tr v-if="model.flows.legacy.value">
            <td>Other civilian spending uses</td>
            <td class="text-right text-no-wrap">{{ money(model.flows.legacy.value) }}<provenance-mark :result="model.flows.legacy" /></td>
          </tr>
          <tr>
            <td class="font-weight-medium">Net of civilian shipping</td>
            <td class="text-right text-no-wrap font-weight-medium">{{ signed(model.flows.net.value) }}<provenance-mark :result="model.flows.net" /></td>
          </tr>
          <tr>
            <td>Everything else, net</td>
            <td class="text-right text-no-wrap">{{ signed(model.rest.rest.value) }}<provenance-mark :result="model.rest.rest" /></td>
          </tr>
          <tr>
            <td>Tax rate set now</td>
            <td class="text-right text-no-wrap">{{ percent(model.taxRate.value) }}<provenance-mark :result="model.taxRate" /></td>
          </tr>
        </tbody>
      </v-simple-table>
      <div v-if="model.taxRate.value === null" class="caption warning--text">{{ limitationText(model.taxRate) }}</div>

      <div class="d-flex flex-wrap align-center mt-4 mb-2">
        <v-chip small label color="warning" outlined class="mr-2">Estimated</v-chip>
        <span class="subtitle-2">Scenario assumptions</span>
      </div>
      <v-row dense>
        <v-col cols="12" sm="6" md="3">
          <v-text-field :value="futureTaxShown" type="number" min="0" max="100" label="Future shipping tax, %" hint="Untouched: the rate set now carries on" persistent-hint dense outlined aria-label="Future shipping-line tax rate in percent" @input="setFutureTax" />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-text-field v-model="pauseYears" type="number" min="0" label="Contracts paused, years" hint="Blank: the pause is not known" persistent-hint dense outlined aria-label="Years the contracts are paused" />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-text-field v-model="governmentCost" type="number" min="0" label="Government transports, running cost per year" hint="Blank: not known, never taken as free" persistent-hint dense outlined aria-label="Yearly running cost of the government transports" />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-text-field v-model="planStart" type="number" min="0" label="New contracts start after, years" hint="Blank: the start is not known" persistent-hint dense outlined aria-label="Years before the new contracts start" />
        </v-col>
      </v-row>

      <div class="caption font-weight-medium mt-2">New contracts<provenance-mark rule="shippingRunway.planLine" /></div>
      <v-row v-for="line in lines" :key="line.id" dense align="center">
        <v-col cols="12" sm="6" md="3">
          <v-select v-model="line.category" :items="categoryItems" item-text="label" item-value="id" label="Category" aria-label="Category of the new contract" dense outlined hide-details />
        </v-col>
        <v-col cols="4" md="2">
          <v-text-field v-model="line.quantity" type="number" min="0" label="Units carried" aria-label="Units carried" dense outlined hide-details />
        </v-col>
        <v-col cols="4" md="3">
          <v-text-field v-model="line.distance" type="number" min="0" label="One-way loaded, billion km" aria-label="One-way loaded distance in billion km" dense outlined hide-details />
        </v-col>
        <v-col cols="4" md="2">
          <v-text-field v-model="line.perYear" type="number" min="0" label="Contracts a year" aria-label="Contracts a year" dense outlined hide-details />
        </v-col>
        <v-col cols="12" md="2">
          <v-btn small text :disabled="lines.length < 2 && !lineFilled(line)" @click="removeLine(line)">Remove</v-btn>
        </v-col>
      </v-row>
      <v-btn small text class="mt-1" @click="addLine">Add a contract</v-btn>

      <div class="d-flex flex-wrap align-center mt-4 mb-2">
        <v-chip small label color="warning" outlined class="mr-2">Estimated</v-chip>
        <span class="subtitle-2">Reserves under each scenario, {{ horizon }}-year horizon</span>
      </div>
      <v-simple-table dense class="shipping-table">
        <thead>
          <tr>
            <th>Scenario</th>
            <th class="text-right">Shipping net per year</th>
            <th class="text-right">Net now per year</th>
            <th class="text-right">Net later per year</th>
            <th>Reserves exhausted</th>
            <th>Across the windows</th>
            <th class="text-right">Change per year</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" :data-scenario="row.id">
            <td>
              <div class="font-weight-medium">{{ row.label }}</div>
              <div class="caption text--secondary">{{ row.changes }}</div>
            </td>
            <td class="text-right text-no-wrap">{{ signed(row.shipping.value) }}<span v-if="row.focus === 'later'" class="caption text--secondary" data-focus> once running</span><provenance-mark :result="row.shipping" /></td>
            <td class="text-right text-no-wrap">{{ signed(row.net.value) }}<provenance-mark :result="row.net" /></td>
            <td class="text-right text-no-wrap">{{ row.hasLater ? signed(row.later.value) : 'same' }}<provenance-mark v-if="row.hasLater" :result="row.later" /></td>
            <td data-exhaustion>{{ row.exhaustionText }}<provenance-mark :result="row.exhaustion" /></td>
            <td class="caption">{{ row.spreadText }}<provenance-mark :result="row.spread" /></td>
            <td class="text-right text-no-wrap">{{ signed(row.change.value) }}<span v-if="row.focus === 'later'" class="caption text--secondary" data-focus> once running</span><provenance-mark :result="row.change" /></td>
          </tr>
        </tbody>
      </v-simple-table>
      <div v-for="row in rows.filter((item) => item.exhaustion.value === null)" :key="row.id" class="caption warning--text" data-scenario-gap>{{ row.label }}: {{ limitationText(row.exhaustion) }}</div>
      <div class="caption text--secondary mt-1">The no-change row is the runway of the Finances tiles, from the same net and treasury. Net now is the net of the first stretch that lasts, so a pause or a start of 0 years leaves the net after it as the net now; net later is the last stretch. The shipping net and the change of New contracts are those once the contracts run.</div>

      <div class="mt-3">Break-even running cost of government transports: <span class="font-weight-medium">{{ money(model.breakEven.value) }}</span> a year<provenance-mark :result="model.breakEven" label /></div>
      <div class="caption text--secondary">The logged contracts less the tax paired with them. A running cost below it leaves the treasury better off than the contracts do; the running cost itself is never assumed.</div>

      <div class="subtitle-2 mt-4 mb-1">Treasury balance over the horizon<provenance-mark :result="ledger.treasurySeries" /></div>
      <div class="d-flex flex-wrap align-center mb-1">
        <v-btn-toggle v-model="view" mandatory dense class="mr-4">
          <v-btn value="chart" small><v-icon small>mdi-chart-line</v-icon></v-btn>
          <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
        </v-btn-toggle>
        <template v-if="view === 'chart'">
          <span v-if="hasHistory" class="legend-item"><series-key :color="theme.primary" kind="line" />Reconstructed from the log, estimated</span>
          <span v-for="entry in legend" :key="entry.id" class="legend-item"><series-key :color="entry.color" kind="line" :dash="entry.dash" />{{ entry.label }}, estimated</span>
        </template>
      </div>
      <template v-if="view === 'chart'">
        <chart-canvas type="line" :data="chart" :options="chartOptions" :height="300" label="Treasury balance in the past and under each shipping scenario over the horizon" />
        <div class="caption text--secondary mt-1">A balance below zero is past the exhaustion.</div>
      </template>
      <v-simple-table v-else dense class="shipping-table" height="360" fixed-header>
        <thead>
          <tr>
            <th>Date</th>
            <th class="text-right">Years from now</th>
            <th v-if="hasHistory" class="text-right">Reconstructed from the log<provenance-mark :result="ledger.treasurySeries" /></th>
            <th v-for="entry in legend" :key="entry.id" class="text-right">{{ entry.label }}<provenance-mark :result="entry.result" /></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(point, index) in balanceRows" :key="index" :data-kind="point.history === null ? 'ahead' : 'past'">
            <td>{{ point.date }}</td>
            <td class="text-right">{{ point.years }}</td>
            <td v-if="hasHistory" class="text-right text-no-wrap">{{ point.history === null ? '—' : signed(point.history) }}</td>
            <td v-for="entry in legend" :key="entry.id" class="text-right text-no-wrap">{{ point.balances[entry.id] === null ? '—' : signed(point.balances[entry.id]) }}</td>
          </tr>
          <tr v-if="!balanceRows.length">
            <td :colspan="legend.length + 3" class="text--secondary">No balance to list.</td>
          </tr>
        </tbody>
      </v-simple-table>

      <div class="subtitle-2 mt-4 mb-1">Budget obligations that are not shipping<provenance-mark :result="model.rest.rest" /></div>
      <v-simple-table v-if="model.rest.uses.length" dense class="shipping-table">
        <thead>
          <tr>
            <th>Use</th>
            <th>Side</th>
            <th class="text-right">Per year</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="use in model.rest.uses" :key="use.id">
            <td>{{ use.label }}</td>
            <td>{{ use.income ? 'Income' : 'Spending' }}</td>
            <td class="text-right text-no-wrap">{{ money(use.yearly.value) }}<provenance-mark :result="use.yearly" /></td>
          </tr>
        </tbody>
      </v-simple-table>
      <div v-else class="caption text--secondary">No other use is logged in the window.</div>

      <div class="caption text--secondary mt-3">The observed past rate of the treasury is the Stock rates panel of <router-link to="/history">Empire History</router-link>{{ historyRecorded ? '' : ', which is empty while history does not record this race' }}; it is not repeated here.</div>
    </div>
    <div class="panel-foot caption text--secondary">Compare each scenario with the no-change runway and non-shipping budget obligations. Each scenario keeps the window's rates constant from now on, replaces the civilian shipping flows as stated and keeps every other logged flow. Logged amounts remain separate from scenario estimates. The calculation uses the current tax rate because the save keeps no earlier rate. A rate change within the window therefore gives an incorrect split of logged contracts. Unlogged changes and the treasury cap of twice annual wealth are excluded, as shown in Treasury against the log. New contract fares come from the Civilian shipping-line payouts panel. Enter the running cost of government transports. They are not assumed to be free, and a blank cost gives no estimate. The spread shows how far the exhaustion moves with the window the rates are scaled from. It is not a probability.</div>
  </v-card>
</template>

<script>
import ChartCanvas from '../charts/ChartCanvas.vue'
import SeriesKey from '../charts/SeriesKey.vue'
import { chartTheme, withAlpha } from '../charts/theme'
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import persistedView, { oneOf } from '../../mixins/persisted-view'
import { activeAppearance } from '../../utilities/appearance'
import { CATEGORIES } from '../../utilities/civilian-tariff'
import { statusText } from '../../utilities/finances'
import { roundToDecimal, separatedNumber } from '../../utilities/math'
import { isAvailable, valueOrNull } from '../../utilities/provenance'
import { DEFAULT_HORIZON, HORIZONS, PLAN_CATEGORIES, balanceTimeline, buildShippingRunway, exhaustionTime, verdictOf, windowLedgers } from '../../utilities/shipping-runway'

const VIEWS = ['chart', 'table']
const DASHES = [[7, 4], [2, 3], [9, 3, 2, 3], [4, 4]]

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

let lineCount = 0

const blankLine = () => ({ id: ++lineCount, category: PLAN_CATEGORIES[0], quantity: '', distance: '', perYear: '' })

export default {
  name: 'ShippingRunway',
  components: { ChartCanvas, LoadState, ProvenanceMark, SeriesKey },
  mixins: [
    persistedView({
      horizon: { key: 'financesShippingHorizon', default: DEFAULT_HORIZON, valid: oneOf(HORIZONS) },
      view: { key: 'financesShippingView', default: 'chart', valid: oneOf(VIEWS) },
    }),
  ],
  props: {
    // The page's ledger of the selected window (utilities/finances.js buildLedger).
    ledger: { type: Object, required: true },
    // The FCT_Race and FCT_Game row the ledger was built from, and the wealth rows behind it: the other windows' ledgers are built from them.
    treasury: { type: Object, required: true },
    wealth: { type: Array, required: true },
    windowDays: { type: Number, required: true },
    windowOptions: { type: Array, required: true },
    // The formula version of the save (null for a schema the rates are not published for) and whether the race is computer-run (null while the kind is not stored: no figure then, never a player's race).
    formulaVersion: { type: String, default: null },
    npr: { type: Boolean, default: null },
    // What loadShippingTax reads, and the state of that read: the panel shows no figure while it is in flight or failed.
    tax: { type: Object, default: null },
    taxState: { type: Object, default: () => ({ loading: false, failed: '', error: '' }) },
    date: { type: Function, required: true },
    separator: { type: String, default: '' },
    historyRecorded: { type: Boolean, default: false },
  },
  data() {
    return {
      horizons: HORIZONS,
      futureTax: null,
      pauseYears: '2',
      governmentCost: '',
      planStart: '0',
      lines: [blankLine()],
    }
  },
  computed: {
    appearance() {
      return activeAppearance()
    },
    theme() {
      return chartTheme(this.appearance)
    },
    categoryItems() {
      return CATEGORIES.filter((category) => PLAN_CATEGORIES.includes(category.id))
    },
    // Every window's ledger, built once for the rows the page holds, whatever is typed in the fields.
    windows() {
      return windowLedgers({ treasury: this.treasury, wealth: this.wealth, windowDays: this.windowDays, ledger: this.ledger, options: this.windowOptions })
    },
    inputs() {
      return { horizon: this.horizon, futureTax: this.futureTax, pauseYears: this.pauseYears, governmentCost: this.governmentCost, planStart: this.planStart, lines: this.lines }
    },
    model() {
      return buildShippingRunway({ windows: this.windows, windowDays: this.windowDays, version: this.formulaVersion, npr: this.npr, tax: this.tax, inputs: this.inputs })
    },
    // The rate set now as typed text, while the field is untouched.
    futureTaxShown() {
      if (this.futureTax !== null) {
        return this.futureTax
      }

      const rate = valueOrNull(this.model.taxRate)

      return rate === null ? '' : `${roundToDecimal(rate * 100, 4)}`
    },
    rows() {
      return this.model.scenarios.map((scenario) => ({ ...scenario, hasLater: scenario.id === 'delay' || scenario.id === 'plan', exhaustionText: this.exhaustionText(scenario), spread: this.model.spread[scenario.id], spreadText: this.spreadText(this.model.spread[scenario.id]) }))
    },
    // The past as the log reconstructs it and every scenario's balance, on one timeline: what the chart draws and the table lists.
    timeline() {
      return balanceTimeline({ ledger: this.ledger, gameTime: this.treasury.GameTime, scenarios: this.model.scenarios, horizon: this.horizon })
    },
    // One entry per scenario with a balance to draw, with the colour and dash the chart gives it.
    legend() {
      const palette = this.theme.categorical

      return this.timeline.paths.map((path) => {
        const index = this.model.scenarios.findIndex((scenario) => scenario.id === path.id)

        return { id: path.id, label: path.label, result: this.model.scenarios[index].exhaustion, color: palette[index % palette.length], dash: DASHES[index % DASHES.length] }
      })
    },
    hasHistory() {
      return this.timeline.rows.some((row) => row.history !== null)
    },
    balanceRows() {
      return this.timeline.rows.map((row) => ({ ...row, date: this.date(row.time), years: roundToDecimal(row.year, 2) }))
    },
    chart() {
      const rows = this.timeline.rows
      const datasets = []

      if (this.hasHistory) {
        datasets.push({ label: 'Reconstructed from the log', data: rows.filter((row) => row.history !== null).map((row) => ({ x: row.year, y: row.history })), borderColor: this.theme.primary, backgroundColor: withAlpha(this.theme.primary, 0.1), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 })
      }

      this.legend.forEach((entry) => {
        datasets.push({ label: `${entry.label}, estimated`, data: rows.filter((row) => row.balances[entry.id] !== null).map((row) => ({ x: row.year, y: row.balances[entry.id] })), borderColor: entry.color, backgroundColor: entry.color, borderWidth: 2, borderDash: entry.dash, pointRadius: 0, pointHoverRadius: 4, tension: 0 })
      })

      return { datasets }
    },
    chartOptions() {
      return {
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0, callback: (value) => this.date(exhaustionTime(this.treasury.GameTime, value)) } },
          y: { ticks: { callback: (value) => compact(value) } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? this.date(exhaustionTime(this.treasury.GameTime, items[0].parsed.x)) : ''),
              label: (item) => `${item.dataset.label}: ${this.signed(item.parsed.y)}`,
              footer: () => statusText(this.ledger.treasurySeries),
            },
          },
        },
      }
    },
  },
  methods: {
    money(value) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, 0), this.separator) : '—'
    },
    signed(value) {
      return Number.isFinite(value) ? `${value < 0 ? '−' : '+'}${this.money(Math.abs(value))}` : '—'
    },
    percent(fraction) {
      return Number.isFinite(fraction) ? `${roundToDecimal(fraction * 100, 2)}%` : '—'
    },
    years(value) {
      return value < 1 ? `${Math.max(1, Math.round(value * 12))} months` : `${roundToDecimal(value, 1)} years`
    },
    // Why a result has no figure: what it needs.
    limitationText(result) {
      const { missing } = result.inputs

      return missing.length ? `Not estimated: needs ${missing.join(' and ')}.` : 'Not estimated.'
    },
    // When the reserves run out under a scenario, over the horizon, or that they do not: the verdict is one of five, never an empty cell.
    exhaustionText(scenario) {
      const verdict = verdictOf(scenario.exhaustion, this.horizon)
      const when = verdict.years === null ? '' : this.date(exhaustionTime(this.treasury.GameTime, verdict.years))

      switch (verdict.kind) {
        case 'none':
          return 'No exhaustion: the net is not a loss'
        case 'now':
          return 'Exhausted now: the treasury is empty under a loss'
        case 'exhausted':
          return `${when}, in ${this.years(verdict.years)}`
        case 'beyond':
          return `No exhaustion within the ${this.horizon}-year horizon: lasts ${this.years(verdict.years)}, to ${when}`
        default:
          return 'Not known'
      }
    },
    // How soon one window's exhaustion comes, in words.
    orderText(order) {
      return order === Infinity ? 'never' : order === 0 ? 'now' : this.years(order)
    },
    // The earliest and latest exhaustion across the windows.
    spreadText(spread) {
      if (!isAvailable(spread)) {
        return 'Not known'
      }

      const { earliest, latest, known, total } = spread.value
      const coverage = known < total ? `, ${known} of ${total} windows` : ''

      return earliest.order === latest.order ? `${this.orderText(earliest.order)} in every window${coverage}` : `${this.orderText(earliest.order)} (${earliest.days} d) to ${this.orderText(latest.order)} (${latest.days} d)${coverage}`
    },
    setFutureTax(value) {
      this.futureTax = value
    },
    lineFilled(line) {
      return [line.quantity, line.distance, line.perYear].some((text) => String(text).trim() !== '')
    },
    addLine() {
      this.lines.push(blankLine())
    },
    removeLine(line) {
      this.lines = this.lines.length > 1 ? this.lines.filter((item) => item !== line) : [blankLine()]
    },
  },
}
</script>

<style lang="scss">
.shipping-runway {
  .shipping-table td {
    font-variant-numeric: tabular-nums;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    margin-right: 16px;
  }
}
</style>
