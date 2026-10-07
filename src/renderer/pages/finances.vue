<template>
  <div>
    <v-container fluid class="finances-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Window</span>
          <v-btn-toggle v-model="windowDays" mandatory dense @change="(value) => config.set('financesWindowDays', value)">
            <v-btn v-for="days in windowOptions" :key="days" :value="days" small>{{ days }} d</v-btn>
          </v-btn-toggle>
        </v-col>
      </v-row>

      <v-alert v-if="failedInputs.length" type="error" outlined dense class="mt-3">
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate class="mt-3" />

      <template v-if="ready">
        <v-alert v-if="!steps.length" type="info" outlined dense class="mt-3">
          The save has no wealth history for this race yet. Aurora logs income and spending every production cycle.
        </v-alert>

        <v-row class="mt-2">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value">
                <v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon>{{ tile.value }}
              </div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <template v-if="steps.length">
          <v-card class="panel" elevation="1">
            <div class="panel-head">
              <span>Income and spending, every {{ stepLabel }}</span>
              <v-btn-toggle v-model="flowsView" mandatory dense>
                <v-btn value="chart" small><v-icon small>mdi-chart-bar</v-icon></v-btn>
                <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
              </v-btn-toggle>
            </div>
            <div class="panel-body">
              <template v-if="flowsView === 'chart'">
                <div class="legend">
                  <span v-for="category in categories" :key="category.id" class="legend-item">
                    <span class="swatch" :style="{ background: category.color }" />{{ category.label }}
                  </span>
                  <span class="legend-item"><span class="swatch swatch-line" :style="{ background: theme.ink }" />Net</span>
                </div>
                <chart-canvas type="bar" :data="flowsChart" :options="flowsOptions" :height="320" label="Wealth income and spending per production cycle, by category" />
                <div class="caption text--secondary mt-2">Income above zero, spending below. The line is the net of each cycle.</div>
              </template>
              <v-data-table v-else :headers="stepHeaders" :items="stepRows" item-key="time" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" dense />
            </div>
          </v-card>

          <v-row>
            <v-col cols="12" lg="6">
              <v-card class="panel" elevation="1">
                <div class="panel-head">
                  <span>Where it comes from and goes</span>
                  <v-chip small>Per year, last {{ coverageText }}</v-chip>
                </div>
                <div class="panel-body">
                  <div v-for="group in categoryGroups" :key="group.label" class="category-group">
                    <div class="category-group-head">
                      <span>{{ group.label }}</span>
                      <span class="text-no-wrap">{{ money(group.total) }} / yr</span>
                    </div>
                    <div v-for="category in group.items" :key="category.id" class="category-row">
                      <span class="category-name"><span class="swatch" :style="{ background: category.color }" />{{ category.label }}</span>
                      <span class="category-meter">
                        <span class="category-meter-fill" :style="{ width: `${category.barWidth}%`, background: category.color }" />
                      </span>
                      <span class="category-value text-no-wrap">{{ money(category.perYear) }}</span>
                      <span class="category-share caption text--secondary text-no-wrap">{{ percent(category.share) }}</span>
                    </div>
                    <div v-if="!group.items.length" class="caption text--secondary">None in this window.</div>
                  </div>
                </div>
              </v-card>
            </v-col>
            <v-col cols="12" lg="6">
              <v-card class="panel" elevation="1">
                <div class="panel-head">
                  <span>Treasury</span>
                  <v-chip small>Estimated</v-chip>
                </div>
                <div class="panel-body">
                  <chart-canvas type="line" :data="treasuryChart" :options="treasuryOptions" :height="280" label="Treasury balance over the window, worked back from today" />
                  <div class="caption text--secondary mt-2">Worked back from today's treasury through each cycle's net. Anything the game doesn't log as income or spending (trade deals, events) isn't in it.</div>
                </div>
              </v-card>
            </v-col>
          </v-row>
        </template>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import { gameTime } from '../utilities/aurora'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'

const SECONDS_PER_DAY = 86400
// The save keeps one year of wealth history; the cycle length when it holds a single step.
const HISTORY_DAYS = 365
const DEFAULT_STEP_DAYS = 5

const INPUT_LABELS = {
  treasury: 'the treasury',
  wealth: 'the wealth history',
}
const INPUTS = Object.keys(INPUT_LABELS)

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
  components: { ChartCanvas },
  data() {
    return {
      windowOptions: [30, 90, 180, 365],
      windowDays: 365,
      flowsView: 'chart',
      loadErrors: {},
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS) && !!this.treasury
    },

    // Every logged cycle end, the one just before the year included.
    times() {
      return [...new Set(this.wealth.map((row) => row.TimeUsed))].sort((a, b) => a - b)
    },

    // The cycle lengths, measured from the history (the game's construction cycle can differ from 5 days, and phases can differ in length).
    gapDays() {
      return this.times.slice(1).map((time, index) => (time - this.times[index]) / SECONDS_PER_DAY).filter((gap) => gap > 0)
    },

    stepDays() {
      return this.gapDays.length ? Math.min(...this.gapDays) : DEFAULT_STEP_DAYS
    },

    stepLabel() {
      const longest = this.gapDays.length ? Math.max(...this.gapDays) : this.stepDays

      return longest > this.stepDays ? `${roundToDecimal(this.stepDays, 1)} to ${roundToDecimal(longest, 1)} days` : `${roundToDecimal(this.stepDays, 1)} days`
    },

    windowRows() {
      if (!this.treasury) {
        return []
      }

      const cutoff = this.treasury.GameTime - this.windowDays * SECONDS_PER_DAY

      return this.wealth.filter((row) => row.TimeUsed > cutoff)
    },

    // Each logged time stands for the cycle before it.
    steps() {
      return [...new Set(this.windowRows.map((row) => row.TimeUsed))].sort((a, b) => a - b)
    },

    // Where the first step's cycle began: the logged end before it, else the gap after it (the first cycle of a save), else the default.
    firstStart() {
      if (!this.steps.length) {
        return null
      }

      const before = this.times.filter((time) => time < this.steps[0]).pop()

      if (before !== undefined) {
        return before
      }

      return this.steps[0] - (this.steps.length > 1 ? this.steps[1] - this.steps[0] : DEFAULT_STEP_DAYS * SECONDS_PER_DAY)
    },

    // The time the steps actually span, so cycles of different lengths count for what they are.
    coverageDays() {
      return this.steps.length ? (this.steps[this.steps.length - 1] - this.firstStart) / SECONDS_PER_DAY : 0
    },

    coverageText() {
      return `${roundToDecimal(this.coverageDays, 0)} days`
    },

    perYear() {
      return this.coverageDays ? HISTORY_DAYS / this.coverageDays : 0
    },

    // Every use in the window, income first, in the game's display order, each with its colour.
    categories() {
      const byId = {}

      this.windowRows.forEach((row) => {
        const category = (byId[row.UseID] = byId[row.UseID] || { id: row.UseID, label: row.Description, income: !!row.Income, order: row.DisplayOrder ?? 999, total: 0 })

        category.total += row.Amount
      })

      const palette = this.theme.categorical
      const sorted = Object.values(byId).sort((a, b) => b.income - a.income || a.order - b.order)
      const incomeTotal = sorted.filter((category) => category.income).reduce((sum, category) => sum + category.total, 0)
      const spendingTotal = sorted.filter((category) => !category.income).reduce((sum, category) => sum + category.total, 0)

      return sorted.map((category, index) => ({
        ...category,
        color: index < palette.length ? palette[index] : withAlpha(palette[index % palette.length], 0.55),
        perYear: category.total * this.perYear,
        share: category.total / ((category.income ? incomeTotal : spendingTotal) || 1),
        // Each bar is the category's share of its own side, so small spending still reads.
        barWidth: (category.total / ((category.income ? incomeTotal : spendingTotal) || 1)) * 100,
      }))
    },

    totals() {
      const income = this.categories.filter((category) => category.income).reduce((sum, category) => sum + category.perYear, 0)
      const spending = this.categories.filter((category) => !category.income).reduce((sum, category) => sum + category.perYear, 0)

      return { income, spending, net: income - spending }
    },

    categoryGroups() {
      return [
        { label: 'Income', total: this.totals.income, items: this.categories.filter((category) => category.income).sort((a, b) => b.total - a.total) },
        { label: 'Spending', total: this.totals.spending, items: this.categories.filter((category) => !category.income).sort((a, b) => b.total - a.total) },
      ]
    },

    // { [time]: { [UseID]: amount } }
    amountsByStep() {
      const amounts = {}

      this.windowRows.forEach((row) => {
        const step = (amounts[row.TimeUsed] = amounts[row.TimeUsed] || {})

        step[row.UseID] = (step[row.UseID] || 0) + row.Amount
      })

      return amounts
    },

    netByStep() {
      return this.steps.map((time) => this.categories.reduce((sum, category) => sum + (category.income ? 1 : -1) * ((this.amountsByStep[time] || {})[category.id] || 0), 0))
    },

    stepDates() {
      return this.steps.map((time) => this.date(time))
    },

    tiles() {
      const { income, spending, net } = this.totals
      const treasury = this.treasury ? this.treasury.WealthPoints : 0
      const change = this.netByStep.reduce((sum, value) => sum + value, 0)
      const biggest = this.categoryGroups[1].items[0]
      const runway = net < 0 && treasury > 0 ? treasury / -net : null

      return [
        {
          label: 'Treasury',
          value: this.money(treasury),
          note: this.steps.length ? `${this.signed(change)} over the last ${this.coverageText}` : 'No history logged',
          icon: treasury < 0 ? 'mdi-alert-octagon' : null,
          iconColor: 'error',
        },
        {
          label: 'Net per year',
          value: this.signed(net),
          note: runway !== null ? `The treasury lasts ${this.years(runway)} at this rate` : treasury < 0 ? 'In debt: production slows until it\'s paid off' : 'Income covers spending',
          icon: net < 0 ? 'mdi-trending-down' : 'mdi-trending-up',
          iconColor: net < 0 ? 'error' : 'success',
        },
        {
          label: 'Income per year',
          value: this.money(income),
          note: this.treasury && this.treasury.AnnualWealth ? `Aurora's annual figure at today's rate: ${this.money(this.treasury.AnnualWealth)}` : `Over the last ${this.coverageText}`,
        },
        {
          label: 'Spending per year',
          value: this.money(spending),
          note: biggest ? `Mostly ${biggest.label.toLowerCase()} (${this.percent(biggest.share)})` : 'Nothing spent',
        },
      ]
    },

    flowsChart() {
      const datasets = this.categories.map((category) => ({
        label: category.label,
        data: this.steps.map((time) => (category.income ? 1 : -1) * ((this.amountsByStep[time] || {})[category.id] || 0)),
        backgroundColor: category.color,
        borderColor: this.theme.surface,
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
            },
          },
        },
      }
    },

    treasuryChart() {
      const color = this.theme.primary
      const end = this.treasury ? this.treasury.WealthPoints : 0
      // Balance after each cycle: today's treasury less every later cycle's net.
      let balance = end
      const balances = this.netByStep.slice().reverse().map((net) => {
        const after = balance

        balance -= net

        return after
      }).reverse()
      const start = this.firstStart

      return {
        labels: start === null ? [] : [this.date(start), ...this.stepDates],
        datasets: [{
          label: 'Treasury',
          data: start === null ? [] : [balance, ...balances],
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
            },
          },
        },
      }
    },

    stepHeaders() {
      return [
        { text: 'Cycle ending', value: 'date' },
        ...this.categories.map((category) => ({ text: category.label, value: `use${category.id}`, align: 'end' })),
        { text: 'Net', value: 'net', align: 'end' },
      ]
    },

    stepRows() {
      return this.steps.map((time, index) => ({
        time,
        date: this.stepDates[index],
        ...Object.fromEntries(this.categories.map((category) => [`use${category.id}`, this.money(((this.amountsByStep[time] || {})[category.id] || 0) * (category.income ? 1 : -1))])),
        net: this.signed(this.netByStep[index]),
      })).reverse()
    },
  },
  created() {
    this.windowDays = this.config.get('financesWindowDays', 365)
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    money(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    signed(value) {
      return `${value < 0 ? '−' : '+'}${this.money(Math.abs(value))}`
    },
    percent(fraction) {
      return `${roundToDecimal((fraction || 0) * 100, 1)}%`
    },
    years(value) {
      return value < 1 ? `${Math.max(1, Math.round(value * 12))} months` : `${roundToDecimal(value, 1)} years`
    },
    date(seconds) {
      return this.treasury ? gameTime(this.treasury.StartYear, seconds).format('YYYY-MM-DD') : ''
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
    // The last year of wealth flows, one row per use and cycle, plus the cycle just before it (its end is where the first cycle began; the
    // window filter drops it). `Amount` is always positive; the use's `Income` flag gives the sign.
    // The game's time is a scalar subquery of its own: reading it from the outer `FCT_Game` join made the cycle lookup re-run for every ledger
    // row (over two minutes at 50 000 rows, against 0.1 s now), and the stalled read held the connection for every page.
    wealth: {
      get: tracked('wealth', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_WealthData.UseID, coalesce(DIM_WealthUse.Description, 'Unknown (' || FCT_WealthData.UseID || ')') as Description, coalesce(DIM_WealthUse.Income, 0) as Income, DIM_WealthUse.DisplayOrder, FCT_WealthData.TimeUsed, sum(FCT_WealthData.Amount) as Amount from FCT_WealthData left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID inner join FCT_Game on FCT_Game.GameID = FCT_WealthData.GameID where FCT_WealthData.GameID = ${this.GameID} and FCT_WealthData.RaceID = ${this.RaceID} and FCT_WealthData.TimeUsed >= coalesce((select max(previous.TimeUsed) from FCT_WealthData previous where previous.GameID = ${this.GameID} and previous.RaceID = ${this.RaceID} and previous.TimeUsed <= (select FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${this.GameID}) - ${HISTORY_DAYS * SECONDS_PER_DAY}), 0) group by FCT_WealthData.UseID, FCT_WealthData.TimeUsed order by FCT_WealthData.TimeUsed`).then(([items]) => items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.finances-page {
  .stat-tile {
    padding: 16px;
    height: 100%;
  }

  .stat-value {
    font-size: 24px;
    line-height: 32px;
    font-weight: 400;
    margin: 4px 0;
  }

  .panel {
    margin-top: 20px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 24px;
    font-size: 16px;
    line-height: 28px;
  }

  .panel-body {
    padding: 0 24px 16px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
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
    border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    font-variant-numeric: tabular-nums;
  }

  .category-row {
    display: grid;
    grid-template-columns: minmax(140px, 1.2fr) 2fr auto 52px;
    align-items: center;
    gap: 12px;
    padding: 4px 0;
    font-size: 14px;
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
    background: rgba(0, 0, 0, 0.06);
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

.theme--dark .finances-page {
  .category-group-head {
    border-bottom-color: rgba(255, 255, 255, 0.12);
  }

  .category-meter {
    background: rgba(255, 255, 255, 0.1);
  }
}
</style>
