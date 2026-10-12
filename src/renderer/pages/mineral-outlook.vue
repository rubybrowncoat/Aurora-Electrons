<template>
  <div>
    <v-container fluid class="mineral-outlook">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Ledger window</span>
          <v-btn-toggle v-model="windowDays" mandatory dense>
            <v-btn v-for="days in windowOptions" :key="days" :value="days" small>{{ days }} d</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Horizon</span>
          <v-btn-toggle v-model="horizon" mandatory dense>
            <v-btn v-for="option in horizonOptions" :key="option" :value="option" small>{{ option }} y</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="12" sm="auto" class="mineral-select">
          <v-select v-model="focusMineralId" :items="mineralItems" item-text="name" item-value="id" label="Mineral" prepend-inner-icon="mdi-diamond-stone" dense outlined hide-details />
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!forecastReady" class="mt-3" @retry="retryFailedInputs" />
      <v-alert v-if="forecastReady && !hasLedger" type="info" outlined dense class="mt-3">
        This save has no mineral ledger (Aurora 2.6 adds one). Production comes from the mines, and use is the industry queue only: fuel refining, maintenance and shipbuilding aren't counted.
      </v-alert>

      <!-- Runway, flows and the focused outlook need every read to have succeeded: never a guess (zero stock, no ledger) while one is loading or failed. -->
      <template v-if="forecastReady">
        <stat-tiles :tiles="tiles" compact class="mt-2" />

        <v-card v-if="focusRow" class="panel" data-summary="How long the chosen mineral will last at current rates, with projected stockpile and mining output, to decide when to expand supply or cut use." elevation="1">
          <div class="panel-head">
            <span>{{ focusRow.name }} outlook</span>
            <span class="d-flex align-center flex-wrap">
              <v-chip small class="mr-2">
                <v-icon small left :color="statusColor(projection.status)">{{ statusIcon(projection.status) }}</v-icon>{{ projection.summary }}
              </v-chip>
              <v-chip small class="mr-3">{{ focusDeposits.length }} {{ focusDeposits.length === 1 ? 'deposit' : 'deposits' }} mined</v-chip>
              <v-btn small outlined class="mr-2" :to="linkTo.minerals({ mineral: focusMineralId })"><v-icon small left>mdi-diamond-stone</v-icon>Mineral Breakdown</v-btn>
              <v-btn small outlined @click="flowsOpen = true"><v-icon small left>mdi-chart-bar</v-icon>Sources and uses</v-btn>
            </span>
          </div>
          <div class="panel-body">
            <div class="figures">
              <div v-for="figure in focusFigures" :key="figure.label" class="figure">
                <div class="caption text--secondary">{{ figure.label }}</div>
                <div class="figure-value text-no-wrap">
                  <v-icon v-if="figure.icon" small :color="figure.iconColor">{{ figure.icon }}</v-icon>
                  {{ figure.value }}
                </div>
              </div>
            </div>
            <v-row dense>
              <v-col cols="12" md="6">
                <div class="chart-title">Projected stockpile</div>
                <chart-canvas type="line" :data="stockChart" :options="stockOptions" :height="210" :label="`Projected ${focusRow.name} stockpile over ${horizon} years`" />
              </v-col>
              <v-col cols="12" md="6">
                <div class="chart-title">Projected mining output</div>
                <chart-canvas type="line" :data="outputChart" :options="outputOptions" :height="210" :label="`Projected ${focusRow.name} mining output over ${horizon} years`" />
              </v-col>
            </v-row>
            <div class="caption text--secondary">
              Mining follows each deposit's accessibility as it's worked down; other income and all uses stay at today's rates. In transit counts as stock.
            </div>
          </div>
        </v-card>
        <v-card class="panel" data-summary="For every mineral, its stock, production, use and how long the stock will last, to see which minerals are heading for a shortage." elevation="1">
          <div class="panel-head">
            <span>Mineral runway</span>
            <v-chip small>{{ coverageLabel }}</v-chip>
          </div>
          <v-data-table :headers="runwayHeaders" :items="mineralRows" item-key="id" :sort-by.sync="runwayTable.sortBy" :sort-desc.sync="runwayTable.sortDesc" :item-class="(item) => (item.id === focusMineralId ? 'is-focus-row' : '')" disable-pagination hide-default-footer dense class="runway-table" @click:row="(item) => (focusMineralId = item.id)">
            <template #[`item.name`]="{ item }">
              <span class="font-weight-medium">{{ item.name }}</span>
            </template>
            <template #[`item.stock`]="{ item }">{{ tons(item.stock) }}</template>
            <template #[`item.transit`]="{ item }">
              <span :class="{ 'text--secondary': !item.transit }">{{ tons(item.transit) }}</span>
            </template>
            <template #[`item.produced`]="{ item }">{{ tons(item.produced) }}</template>
            <template #[`item.used`]="{ item }">{{ tons(item.used) }}</template>
            <template #[`item.net`]="{ item }">
              <span class="text-no-wrap">
                <v-icon small :color="item.net < 0 ? 'error' : 'success'">{{ item.net < 0 ? 'mdi-arrow-down' : 'mdi-arrow-up' }}</v-icon>
                {{ signedTons(item.net) }}
              </span>
            </template>
            <template #[`item.runwaySort`]="{ item }">
              <div class="runway-cell">
                <div class="meter" :title="runwayLabel(item)">
                  <div class="meter-fill" :class="statusColor(item.status)" :style="{ width: `${meterWidth(item)}%` }" />
                </div>
                <span class="text-no-wrap">
                  <v-icon small :color="statusColor(item.status)">{{ statusIcon(item.status) }}</v-icon>
                  {{ runwayLabel(item) }}
                </span>
              </div>
            </template>
            <template #[`item.queue`]="{ item }">
              <span :class="{ 'text--secondary': !item.queue }">{{ tons(item.queue) }}</span>
            </template>
            <template #[`item.trend`]="{ item }">
              <v-sparkline v-if="item.trend.length > 1" :value="item.trend" :color="theme.inkMuted" :line-width="2" :padding="3" :smooth="2" height="24" width="120" class="trend" />
              <span v-else class="text--secondary">—</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            {{ hasLedger ? `Produced and used come from the game's mineral ledger over the last ${coverageText}, annualised. Freighter and mass-driver transfers between colonies aren't counted. The game doesn't log mining at colonies that buy their civilian complexes' minerals and send them by mass driver, so their mining is worked out from their mines and complexes. Industry queue: what the queued projects will use in the next 12 months.` : 'Produced comes from the mines; used is the industry queue over the next 12 months.' }} Click a row to see its outlook.
          </div>
        </v-card>

        <v-dialog v-model="flowsOpen" max-width="960" scrollable content-class="mineral-outlook">
          <v-card>
            <div class="panel-head">
              <span>Where minerals come from and go</span>
              <span class="d-flex align-center">
                <v-btn-toggle v-model="flowsView" mandatory dense>
                  <v-btn value="chart" small><v-icon small>mdi-chart-bar</v-icon></v-btn>
                  <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
                </v-btn-toggle>
                <v-btn icon class="ml-2" aria-label="Close" @click="flowsOpen = false"><v-icon>mdi-close</v-icon></v-btn>
              </span>
            </div>
            <v-divider />
            <v-card-text class="pt-4">
              <template v-if="flowsView === 'chart'">
                <div class="legend">
                  <span v-for="group in presentFlowGroups" :key="group.key" class="legend-item">
                    <span class="swatch" :style="{ background: flowColor(group.key) }" />{{ group.label }}
                  </span>
                </div>
                <chart-canvas type="bar" :data="flowsChart" :options="flowsOptions" :height="380" label="Mineral sources and uses per year, by purpose" />
                <div class="caption text--secondary mt-2">Tonnes per year. Sources to the right of zero, uses to the left.</div>
              </template>
              <v-data-table v-else :headers="flowsHeaders" :items="flowRows" item-key="id" :sort-by.sync="flowsTable.sortBy" :sort-desc.sync="flowsTable.sortDesc" :item-class="(item) => (item.id === focusMineralId ? 'is-focus-row' : '')" disable-pagination hide-default-footer dense />
            </v-card-text>
          </v-card>
        </v-dialog>
      </template>

      <v-card v-if="depositsReady" class="panel" data-summary="Each deposit worked by mines and miners, with its yield and when it will run down, to plan new deposits before the old ones empty." elevation="1">
        <div class="panel-head">
          <span>Deposits being mined</span>
          <span class="d-flex align-center">
            <v-switch v-model="allDeposits" label="All minerals" dense hide-details class="mt-0 mr-6" />
            <v-switch v-model="onlyEmptying" :label="`Empty within ${horizon} y`" dense hide-details class="mt-0" />
          </span>
        </div>
        <v-data-table :headers="depositHeaders" :items="visibleDeposits" item-key="key" :expanded.sync="expandedDeposits" show-expand single-expand :sort-by.sync="depositTable.sortBy" :sort-desc.sync="depositTable.sortDesc" :items-per-page.sync="depositTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: depositPageSizes }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
          <template #[`item.place`]="{ item }">
            <div class="py-2">
              <div>{{ item.bodyName }}</div>
              <div v-if="item.sourceNames" class="caption text--secondary">{{ item.sourceNames }}</div>
            </div>
          </template>
          <template #[`item.amount`]="{ item }">{{ tons(item.amount) }}</template>
          <template #[`item.accessibility`]="{ item }">
            {{ fixed(item.accessibility, 2) }}
            <v-tooltip v-if="item.forecast.upgraded" top>
              <template #activator="{ on }">
                <v-icon small class="ml-1" v-on="on">mdi-information-outline</v-icon>
              </template>
              <span>Raised by a ground survey; the forecast uses the game's stored decline values.</span>
            </v-tooltip>
          </template>
          <template #[`item.rate`]="{ item }">
            <span v-if="item.rate > 0">{{ tons(item.rate) }}</span>
            <span v-else class="text--secondary">Idle</span>
          </template>
          <template #[`item.halfSort`]="{ item }">{{ halfLabel(item) }}</template>
          <template #[`item.emptySort`]="{ item }">
            <span class="text-no-wrap">
              <v-icon v-if="emptyingSoon(item)" small color="warning">mdi-alert</v-icon>
              {{ emptyLabel(item) }}
            </span>
          </template>
          <template #[`item.timeline`]="{ item }">
            <div class="timeline" :title="emptyLabel(item)">
              <div class="timeline-full primary" :style="{ width: `${timelineWidth(item, 'half')}%` }" />
              <div class="timeline-decline primary" :style="{ width: `${timelineWidth(item, 'decline')}%` }" />
              <div v-if="emptyingSoon(item)" class="timeline-end error" />
            </div>
          </template>
          <template #expanded-item="{ headers, item }">
            <td :colspan="headers.length" class="py-4">
              <div class="chart-title">Output of {{ item.mineral }} at {{ item.bodyName }}</div>
              <chart-canvas type="line" :data="depositChart(item)" :options="depositOptions(item)" :height="200" :label="`${item.mineral} output at ${item.bodyName} over time`" />
              <div class="caption text--secondary mt-1">
                {{ depositNote(item) }}
              </div>
            </td>
          </template>
        </v-data-table>
        <div class="panel-foot caption text--secondary">
          Rates include governor, sector, commander and naval-admin bonuses. Orbital mining uses the workbook's formula and is an estimate. Timeline: solid until half mined, lighter while accessibility falls, across {{ horizon }} years.
        </div>
      </v-card>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, flowColor, withAlpha } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import StatTiles from '../components/page/StatTiles.vue'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import { activeAppearance } from '../utilities/appearance'
import { separatedNumber, roundToDecimal } from '../utilities/math'
import { systemBodyName, populationName } from '../utilities/aurora'
import { linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { COMPACT_YEARS, FLOW_GROUPS, MINERALS, PRODUCTION_TYPES, SECONDS_PER_DAY, TRANSFER_TYPES, annualQueueDemand, compact, compactYears, depositForecast, depositStateAt, flowGroupOf, ledgerCoverageDays, orbitalMinerRate, stockProjection, surfaceRate, unloggedMining, yearSteps } from '../utilities/minerals'
import { orbitalMiningQuery, surfaceMiningQuery } from '../utilities/mining-data'
import { loadNavalAdmins } from '../utilities/naval-admins'

const BUCKET_DAYS = 5
// The production cycle when the ledger has too few production ticks to measure it (the game's default).
const DEFAULT_CYCLE_DAYS = 5

// Every read behind the runway and the forecasts, named for the error message.
const INPUT_LABELS = {
  game: 'the game clock',
  stockpile: 'the stockpiles',
  cargo: 'cargo in transit',
  packets: 'mass-driver packets',
  ledger: 'the mineral ledger',
  surfaceMining: 'colony mining',
  orbitalMining: 'orbital mining',
  navalAdmins: 'naval admin commands',
  industrialProjects: 'the industry queue',
  populationProductionModifiers: 'production modifiers',
}
const DEPOSIT_INPUTS = ['surfaceMining', 'orbitalMining', 'navalAdmins']

const CRITICAL_YEARS = 5
const WARNING_YEARS = 25

const DEPOSIT_PAGE_SIZES = [15, 30, 60, -1]
const FLOWS_VIEWS = ['chart', 'table']

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'MineralOutlookPage',
  components: { ChartCanvas, LoadState, StatTiles },
  mixins: [
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    persistedView({
      windowDays: { key: 'mineralOutlookWindowDays', default: 365 },
      horizon: { key: 'mineralOutlookHorizon', default: 50 },
      allDeposits: { key: 'mineralOutlookAllDeposits', default: false },
      onlyEmptying: { key: 'mineralOutlookOnlyEmptying', default: false },
      focusMineralId: { key: 'mineralOutlookFocus', default: null, scope: 'race', valid: oneOf(MINERALS.map((mineral) => mineral.id)) },
      flowsView: { key: 'mineralOutlookFlowsView', default: 'chart', valid: oneOf(FLOWS_VIEWS) },
      runwayTable: tableView('mineralOutlookRunwayTable', { sortBy: ['runwaySort'], sortDesc: [false] }),
      flowsTable: tableView('mineralOutlookFlowsTable', {}),
      depositTable: tableView('mineralOutlookDepositsTable', { sortBy: ['emptySort'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: DEPOSIT_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      windowOptions: [30, 90, 180, 365],
      horizonOptions: [25, 50, 100, 250],
      linkTo,
      fallbackFocusId: null,
      flowsOpen: false,
      expandedDeposits: [],
      depositPageSizes: DEPOSIT_PAGE_SIZES,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

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

    mineralItems() {
      return MINERALS
    },

    hasLedger() {
      return !!(this.ledger && this.ledger.length)
    },

    // Every read behind the runway and the forecasts has succeeded (a failed one keeps its last, possibly stale, value, so it doesn't count).
    forecastReady() {
      return this.inputsLoaded && this.game !== null && this.stockpile !== null && this.packets !== null && this.ledger !== null
    },

    depositsReady() {
      return DEPOSIT_INPUTS.every((key) => this.loadErrors[key] === null)
    },

    coverageDays() {
      if (!this.hasLedger || !this.game) {
        return 0
      }

      // The production ticks (distinct times of production-phase rows, counted in SQL) set the cycle; the history starts at the earliest row of any kind.
      const [{ ProductionTicks: ticks, FirstTick: firstTick, LastTick: lastTick }] = this.ledger

      return ledgerCoverageDays({
        gameTime: this.game.GameTime,
        firstTime: Math.min(...this.ledger.map((row) => row.FirstTime)),
        anchorTime: ticks ? lastTick : Math.max(...this.ledger.map((row) => row.LastTime)),
        cycleDays: ticks > 1 ? (lastTick - firstTick) / (ticks - 1) / SECONDS_PER_DAY : DEFAULT_CYCLE_DAYS,
        windowDays: this.windowDays,
      })
    },

    coverageText() {
      return `${roundToDecimal(this.coverageDays, 0)} days`
    },

    coverageLabel() {
      return this.hasLedger ? `Ledger: last ${this.coverageText}` : 'No ledger'
    },

    perYear() {
      return this.coverageDays ? 365 / this.coverageDays : 0
    },

    // Mining the ledger leaves out (colonies shipping their civilian complexes' output by mass driver), t/yr.
    unlogged() {
      return unloggedMining({ surface: this.surfaceMining, orbital: this.orbitalMining, navalAdmins: this.navalAdmins })
    },

    // { [MaterialID]: { [groupKey]: t/yr } }
    flowsByMineral() {
      const flows = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, 0]))]))
      const { perYear } = this

      if (!this.hasLedger) {
        return flows
      }

      this.ledger.forEach((row) => {
        const group = !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)

        if (group && flows[row.MaterialID]) {
          flows[row.MaterialID][group.key] += row.Amount * perYear
        }
      })

      Object.entries(this.unlogged).forEach(([materialId, rate]) => {
        if (flows[materialId]) {
          flows[materialId].mining += rate
        }
      })

      return flows
    },

    // Mined deposits: every colony and orbital miner on the same body and mineral summed.
    deposits() {
      const deposits = {}
      const { navalAdmins } = this
      const add = (row, source) => {
        const key = `${row.SystemBodyID}-${row.MaterialID}`

        if (!deposits[key]) {
          deposits[key] = {
            key,
            SystemBodyID: row.SystemBodyID,
            MaterialID: row.MaterialID,
            mineral: MINERALS.find((mineral) => mineral.id === row.MaterialID).name,
            systemName: row.SystemName,
            bodyName: row.SystemBodyName ? `${row.SystemName} · ${row.SystemBodyName}` : systemBodyName(row, { Name: row.SystemName }),
            Amount: row.Amount,
            Accessibility: row.Accessibility,
            HalfOriginalAmount: row.HalfOriginalAmount,
            OriginalAcc: row.OriginalAcc,
            sources: [],
            rate: 0,
            delivered: 0,
          }
        }

        deposits[key].sources.push(source)
        deposits[key].rate += source.rate
        deposits[key].delivered += source.delivered
      }

      this.surfaceMining.forEach((row) => {
        add(row, { name: stripHtml(populationName(row, '', true)), kind: 'surface', rate: surfaceRate(row, false), delivered: surfaceRate(row, true) })
      })

      this.orbitalMining.forEach((row) => {
        const rate = orbitalMinerRate(row, navalAdmins)

        add(row, { name: row.ShipName, kind: 'orbital', rate, delivered: rate })
      })

      return Object.values(deposits).map((deposit) => {
        const forecast = depositForecast(deposit, deposit.rate)

        return {
          ...deposit,
          amount: deposit.Amount,
          accessibility: deposit.Accessibility,
          forecast,
          sourceNames: deposit.sources.filter((source) => source.name !== deposit.bodyName).map((source) => (source.kind === 'orbital' ? `${source.name} (orbital)` : source.name)).join(', '),
          deliveredShare: deposit.rate > 0 ? deposit.delivered / deposit.rate : 0,
          halfSort: forecast.yearsToHalf ?? Infinity,
          emptySort: forecast.idle ? Infinity : forecast.yearsToDepletion,
        }
      })
    },

    queueDemand() {
      return annualQueueDemand(this.industrialProjects, (populationId, productionType) => {
        if (productionType === 1) {
          return this.populationOrdnanceCapacity(populationId)
        } else if (productionType === 2) {
          return this.populationFighterCapacity(populationId)
        }

        return this.populationConstructionCapacity(populationId)
      })
    },

    mineralRows() {
      const { flowsByMineral, stockpile, cargo, packets, deposits, hasLedger, queueDemand } = this
      return MINERALS.map((mineral) => {
        const flows = flowsByMineral[mineral.id]
        const stock = (stockpile && stockpile[mineral.name]) || 0
        const transit = (cargo[mineral.id] || 0) + ((packets && packets[mineral.name]) || 0)
        const mined = deposits.filter((deposit) => deposit.MaterialID === mineral.id).reduce((sum, deposit) => sum + deposit.delivered, 0)
        const produced = hasLedger ? FLOW_GROUPS.filter((group) => group.income).reduce((sum, group) => sum + flows[group.key], 0) : mined
        const used = hasLedger ? FLOW_GROUPS.filter((group) => !group.income).reduce((sum, group) => sum + flows[group.key], 0) : queueDemand[mineral.name]
        const net = produced - used
        const runway = net < 0 ? (stock + transit) / -net : null

        return {
          id: mineral.id,
          name: mineral.name,
          stock,
          transit,
          produced,
          used,
          net,
          runway,
          status: this.runwayStatus(runway, produced, used),
          runwaySort: runway ?? Infinity,
          queue: queueDemand[mineral.name],
          trend: this.trendFor(mineral.id, stock + transit),
          otherIncome: hasLedger ? produced - flows.mining : 0,
        }
      })
    },

    focusRow() {
      return this.mineralRows.find((row) => row.id === this.focusMineralId)
    },

    // The selected mineral's row of the runway table, as the figures above its charts.
    focusFigures() {
      const row = this.focusRow

      if (!row) {
        return []
      }

      return [
        { label: 'Stockpile (t)', value: this.tons(row.stock) },
        { label: 'In transit (t)', value: this.tons(row.transit) },
        { label: 'Produced / yr', value: this.tons(row.produced) },
        { label: 'Used / yr', value: this.tons(row.used) },
        { label: 'Net / yr', value: this.signedTons(row.net), icon: row.net < 0 ? 'mdi-arrow-down' : 'mdi-arrow-up', iconColor: row.net < 0 ? 'error' : 'success' },
        { label: 'Runway', value: this.runwayLabel(row), icon: this.statusIcon(row.status), iconColor: this.statusColor(row.status) },
        { label: 'Industry queue (12 mo)', value: this.tons(row.queue) },
      ]
    },

    focusDeposits() {
      return this.deposits.filter((deposit) => deposit.MaterialID === this.focusMineralId)
    },

    visibleDeposits() {
      return this.deposits.filter((deposit) => (this.allDeposits || deposit.MaterialID === this.focusMineralId) && (!this.onlyEmptying || (!deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon)))
    },

    linkQuery() {
      return linkTo.mineralOutlook(this.focusMineralId).query
    },

    linkLabel() {
      const mineral = MINERALS.find((item) => item.id === this.focusMineralId)

      return mineral ? mineral.name : ''
    },

    tiles() {
      const declining = this.mineralRows.filter((row) => row.runway !== null)
      const shortest = declining.slice().sort((a, b) => a.runway - b.runway)[0]
      const active = this.deposits.filter((deposit) => !deposit.forecast.idle)
      const emptying = active.filter((deposit) => deposit.forecast.yearsToDepletion <= this.horizon)
      const minedPerYear = this.hasLedger ? this.mineralRows.reduce((sum, row) => sum + this.flowsByMineral[row.id].mining, 0) : this.deposits.reduce((sum, deposit) => sum + deposit.delivered, 0)

      return [
        {
          label: 'Shortest runway',
          value: shortest ? `${shortest.name} · ${this.years(shortest.runway)}` : 'None running down',
          note: shortest ? 'Stock and transit at today\'s net rate' : 'Every mineral breaks even or grows',
          icon: shortest ? this.statusIcon(shortest.status) : 'mdi-check-circle',
          iconColor: shortest ? this.statusColor(shortest.status) : 'success',
        },
        {
          label: 'Minerals running down',
          value: `${declining.length} of ${MINERALS.length}`,
          note: declining.length ? declining.map((row) => row.name).join(', ') : 'None',
        },
        {
          label: `Deposits emptying within ${this.horizon} y`,
          value: `${emptying.length}`,
          note: `Of ${active.length} mined deposits`,
          icon: emptying.length ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Mined per year',
          value: this.tons(minedPerYear),
          note: !this.hasLedger ? 'From mines, all minerals' : Object.keys(this.unlogged).length ? 'Ledger plus unlogged mining, all minerals' : 'From the ledger, all minerals',
        },
      ]
    },

    runwayHeaders() {
      return [
        { text: 'Mineral', value: 'name' },
        { text: 'Stockpile (t)', value: 'stock', align: 'end' },
        { text: 'In transit (t)', value: 'transit', align: 'end' },
        { text: 'Produced / yr', value: 'produced', align: 'end' },
        { text: 'Used / yr', value: 'used', align: 'end' },
        { text: 'Net / yr', value: 'net', align: 'end' },
        { text: 'Runway', value: 'runwaySort' },
        { text: 'Industry queue (12 mo)', value: 'queue', align: 'end' },
        { text: `Stock, last ${this.coverageText}`, value: 'trend', sortable: false },
      ]
    },

    presentFlowGroups() {
      return FLOW_GROUPS.filter((group) => MINERALS.some((mineral) => this.flowsByMineral[mineral.id][group.key] > 0))
    },

    flowRows() {
      return MINERALS.map((mineral) => ({ id: mineral.id, name: mineral.name, ...Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, this.tons(this.flowsByMineral[mineral.id][group.key])])) }))
    },

    flowsHeaders() {
      return [{ text: 'Mineral (t / yr)', value: 'name' }, ...this.presentFlowGroups.map((group) => ({ text: `${group.label}${group.income ? '' : ' (use)'}`, value: group.key, align: 'end' }))]
    },

    flowsChart() {
      return {
        labels: MINERALS.map((mineral) => mineral.name),
        datasets: this.presentFlowGroups.map((group) => ({
          label: group.label,
          data: MINERALS.map((mineral) => (group.income ? 1 : -1) * this.flowsByMineral[mineral.id][group.key]),
          backgroundColor: this.flowColor(group.key),
          borderColor: this.theme.surface,
          borderWidth: { left: 1, right: 1, top: 0, bottom: 0 },
          borderSkipped: false,
          maxBarThickness: 20,
          stack: 'flows',
        })),
      }
    },

    flowsOptions() {
      return {
        indexAxis: 'y',
        scales: {
          x: {
            stacked: true,
            ticks: { callback: (value) => compact(Math.abs(value)) },
            grid: { color: (context) => (context.tick && context.tick.value === 0 ? this.theme.inkMuted : `${this.theme.border}99`) },
          },
          y: { stacked: true, grid: { display: false } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => `${this.tons(Math.abs(item.raw))} t/yr · ${item.dataset.label}${item.raw < 0 ? ' (use)' : ''}`,
            },
          },
        },
      }
    },

    projectionSteps() {
      return yearSteps(this.horizon, 100)
    },

    projection() {
      const row = this.focusRow
      const steps = this.projectionSteps

      if (!row) {
        return { stock: [], output: [], status: 'ok', summary: '' }
      }

      const { stock, output, runOut } = stockProjection({
        start: row.stock + row.transit,
        otherNet: row.otherIncome - row.used,
        deposits: this.focusDeposits.map((deposit) => ({ deposit, rate: deposit.rate, share: deposit.deliveredShare })),
        steps,
      })

      const firstEmpty = this.focusDeposits.filter((deposit) => !deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon).sort((a, b) => a.forecast.yearsToDepletion - b.forecast.yearsToDepletion)[0]

      const summary = runOut !== null ? `Runs out in ${this.years(runOut)}` : stock[stock.length - 1] < stock[0] ? `Falling, ${compact(stock[stock.length - 1])} left in ${this.horizon} y` : `Lasts past ${this.horizon} y`
      const status = runOut !== null ? (runOut < CRITICAL_YEARS ? 'critical' : 'warning') : stock[stock.length - 1] < stock[0] ? 'ok' : 'growing'

      return { stock, output, runOut, firstEmpty, summary, status }
    },

    stockChart() {
      const color = this.theme.primary

      return {
        datasets: [{
          label: 'Stockpile',
          data: this.projectionSteps.map((year, index) => ({ x: year, y: this.projection.stock[index] })),
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

    stockOptions() {
      return this.lineOptions({
        unit: 't',
        markers: this.projection.runOut !== null ? [{ x: this.projection.runOut, label: `Runs out, ${this.years(this.projection.runOut)}` }] : [],
      })
    },

    outputChart() {
      const color = this.theme.primary

      return {
        datasets: [{
          label: 'Mining output',
          data: this.projectionSteps.map((year, index) => ({ x: year, y: this.projection.output[index] })),
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

    outputOptions() {
      const first = this.projection.firstEmpty

      return this.lineOptions({
        unit: 't/yr',
        markers: first ? [{ x: first.forecast.yearsToDepletion, label: `${first.bodyName} empties` }] : [],
      })
    },

    depositHeaders() {
      return [
        { text: 'Deposit', value: 'place', sortable: false },
        { text: 'Mineral', value: 'mineral' },
        { text: 'Remaining (t)', value: 'amount', align: 'end' },
        { text: 'Accessibility', value: 'accessibility', align: 'end' },
        { text: 'Mined / yr', value: 'rate', align: 'end' },
        { text: 'Half mined in', value: 'halfSort', align: 'end' },
        { text: 'Empty in', value: 'emptySort', align: 'end' },
        { text: `Next ${this.horizon} years`, value: 'timeline', sortable: false, width: '18%' },
        { text: '', value: 'data-table-expand' },
      ]
    },
  },
  watch: {
    mineralRows: {
      immediate: true,
      handler() {
        this.pickFocusMineral()
      },
    },
    forecastReady() {
      this.pickFocusMineral()
    },
    depositsReady() {
      this.pickFocusMineral()
    },
    // A mineral the user picks is theirs to keep; only the fallback gets replaced.
    focusMineralId(id) {
      if (id !== this.fallbackFocusId) {
        this.fallbackFocusId = null
      }
    },
    // A mineral restored for another race is the user's pick, not the stand-in of the race before.
    RaceID() {
      this.fallbackFocusId = null
    },
  },
  methods: {
    applyLink(query) {
      const id = queryId(query.mineral)

      this.fallbackFocusId = null
      this.setUnsaved('focusMineralId', MINERALS.some((mineral) => mineral.id === id) ? id : null)
      this.pickFocusMineral()
    },

    // Focus the mineral that runs out first, once the forecast can say which. The deposits panel filters by the focus and doesn't wait for the forecast, so until then the mineral whose deposit empties first stands in (and gives way to the runway pick).
    pickFocusMineral() {
      const rows = this.mineralRows

      if (!rows.length || (this.focusMineralId && this.focusMineralId !== this.fallbackFocusId)) {
        return
      }

      if (this.forecastReady) {
        const declining = rows.filter((row) => row.runway !== null).sort((a, b) => a.runway - b.runway)[0]

        this.fallbackFocusId = null
        this.setUnsaved('focusMineralId', declining ? declining.id : rows[0].id)
      } else if (!this.focusMineralId && this.depositsReady) {
        const emptiest = this.deposits.reduce((first, deposit) => (first && first.emptySort <= deposit.emptySort ? first : deposit), null)
        const id = emptiest ? emptiest.MaterialID : rows[0].id

        this.fallbackFocusId = id
        this.setUnsaved('focusMineralId', id)
      }
    },

    flowColor(key) {
      return flowColor(this.appearance, key)
    },

    tons(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    signedTons(value) {
      return `${value < 0 ? '−' : '+'}${this.tons(Math.abs(value))}`
    },
    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
    years(value) {
      if (value === null || value === undefined) {
        return '—'
      } else if (value < 1) {
        return `${Math.max(1, Math.round(value * 12))} mo`
      } else if (value < 100) {
        return `${roundToDecimal(value, 1)} y`
      } else if (value < COMPACT_YEARS) {
        return `${separatedNumber(Math.round(value), this.separator)} y`
      }

      return `${compactYears(value, this.separator)} y`
    },

    runwayStatus(runway, produced, used) {
      if (runway === null) {
        return produced === 0 && used === 0 ? 'idle' : 'growing'
      } else if (runway < CRITICAL_YEARS) {
        return 'critical'
      } else if (runway < WARNING_YEARS) {
        return 'warning'
      }

      return 'ok'
    },
    runwayLabel(row) {
      if (row.status === 'idle') {
        return 'No activity'
      } else if (row.status === 'growing') {
        return 'Growing'
      }

      return this.years(row.runway)
    },
    statusIcon(status) {
      return { critical: 'mdi-alert-octagon', warning: 'mdi-alert', ok: 'mdi-trending-down', growing: 'mdi-trending-up', idle: 'mdi-minus' }[status]
    },
    statusColor(status) {
      return { critical: 'error', warning: 'warning', ok: '', growing: 'success', idle: '' }[status]
    },
    meterWidth(row) {
      if (row.runway === null) {
        return row.status === 'growing' ? 100 : 0
      }

      return Math.max(2, Math.min(100, (row.runway / this.horizon) * 100))
    },

    // Stock (with transit) at the end of each ledger bucket, oldest first.
    trendFor(materialId, current) {
      if (!this.hasLedger) {
        return []
      }

      const nets = {}

      this.ledger.forEach((row) => {
        if (row.MaterialID !== materialId || TRANSFER_TYPES.has(row.MineralDataType)) {
          return
        }

        const group = flowGroupOf(row.MineralDataType)

        if (group) {
          nets[row.Bucket] = (nets[row.Bucket] || 0) + (group.income ? row.Amount : -row.Amount)
        }
      })

      const buckets = Math.ceil(this.coverageDays / BUCKET_DAYS)
      // The mining the ledger leaves out, at today's rate, as if it had run the whole time.
      const unlogged = ((this.unlogged[materialId] || 0) * BUCKET_DAYS) / 365
      const points = [current]
      let level = current

      for (let bucket = 0; bucket < buckets; bucket++) {
        level -= (nets[bucket] || 0) + unlogged
        points.unshift(level)
      }

      return points
    },

    halfLabel(deposit) {
      const { forecast } = deposit

      if (forecast.idle) {
        return '—'
      } else if (forecast.yearsToHalf === null) {
        return 'No decline'
      } else if (forecast.yearsToHalf === 0) {
        return 'Past half'
      }

      return this.years(forecast.yearsToHalf)
    },
    emptyLabel(deposit) {
      return deposit.forecast.idle ? 'Not being mined' : this.years(deposit.forecast.yearsToDepletion)
    },
    emptyingSoon(deposit) {
      return !deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon
    },
    timelineWidth(deposit, part) {
      const { forecast } = deposit

      if (forecast.idle) {
        return 0
      }

      const half = forecast.yearsToHalf === null ? Math.min(forecast.yearsToDepletion, this.horizon) : Math.min(forecast.yearsToHalf, this.horizon)
      const end = Math.min(forecast.yearsToDepletion, this.horizon)

      return part === 'half' ? (half / this.horizon) * 100 : (Math.max(0, end - half) / this.horizon) * 100
    },

    // A deposit's whole life, however long: its output holds, then falls once accessibility starts to.
    depositSpan(deposit) {
      const { forecast } = deposit

      return forecast.idle ? this.horizon : Math.max(1, forecast.yearsToDepletion * 1.05)
    },
    depositChart(deposit) {
      const color = this.theme.primary
      const steps = yearSteps(this.depositSpan(deposit), 80)

      return {
        datasets: [{
          label: 'Output',
          data: steps.map((year) => {
            const state = depositStateAt(deposit, deposit.rate, year)

            return { x: year, y: state.rate * deposit.deliveredShare, accessibility: state.accessibility, amount: state.amount }
          }),
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
    depositOptions(deposit) {
      const { forecast } = deposit
      const markers = []

      if (forecast.yearsToHalf > 0 && forecast.yearsToHalf < this.depositSpan(deposit)) {
        markers.push({ x: forecast.yearsToHalf, label: 'Half mined' })
      }

      if (!forecast.idle) {
        markers.push({ x: forecast.yearsToDepletion, label: 'Empty' })
      }

      return this.lineOptions({
        unit: 't/yr',
        markers,
        extraLabel: (raw) => [`Accessibility ${this.fixed(raw.accessibility, 2)}`, `${this.tons(raw.amount)} t left`],
        span: this.depositSpan(deposit),
      })
    },
    depositNote(deposit) {
      const { forecast } = deposit

      if (forecast.idle) {
        return 'Nothing is being mined here at the moment (no workers or a colony at zero efficiency).'
      } else if (forecast.yearsToHalf === null) {
        return `Accessibility doesn't decline here; at today's rate it's empty in ${this.years(forecast.yearsToDepletion)}.`
      }

      return `Accessibility holds at ${this.fixed(deposit.OriginalAcc, 2)} until half the deposit is mined, then falls toward 0.10, slowing output until it's empty in ${this.years(forecast.yearsToDepletion)}.`
    },

    lineOptions({ unit, markers = [], extraLabel = null, span = this.horizon }) {
      // A chart spanning COMPACT_YEARS or more counts its years in k, M and bn.
      const year = (value) => (span >= COMPACT_YEARS ? compactYears(value, this.separator) : separatedNumber(roundToDecimal(value, 1), this.separator))

      return {
        scales: {
          x: {
            type: 'linear',
            min: 0,
            title: { display: true, text: 'Years from now' },
            ticks: { callback: year },
          },
          y: {
            beginAtZero: true,
            ticks: { callback: (value) => `${compact(value)}${unit === 't/yr' ? '/yr' : ''}` },
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => `Year ${year(items[0].parsed.x)}`,
              label: (item) => [`${this.tons(item.parsed.y)} ${unit}`, ...(extraLabel ? extraLabel(item.raw) : [])],
            },
          },
          guides: { markers },
        },
      }
    },
  },
  asyncComputed: {
    game: {
      get: tracked('game', async function () {
        if (!this.database || !this.GameID) {
          return null
        }

        return await this.database.query(`select FCT_Game.GameTime, FCT_Game.StartYear from FCT_Game where FCT_Game.GameID = ${this.GameID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    stockpile: {
      get: tracked('stockpile', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await this.database.query(`select sum(FCT_Population.Duranium) as Duranium, sum(FCT_Population.Neutronium) as Neutronium, sum(FCT_Population.Corbomite) as Corbomite, sum(FCT_Population.Tritanium) as Tritanium, sum(FCT_Population.Boronide) as Boronide, sum(FCT_Population.Mercassium) as Mercassium, sum(FCT_Population.Vendarite) as Vendarite, sum(FCT_Population.Sorium) as Sorium, sum(FCT_Population.Uridium) as Uridium, sum(FCT_Population.Corundium) as Corundium, sum(FCT_Population.Gallicite) as Gallicite from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    cargo: {
      get: tracked('cargo', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const rows = await this.database.query(`select FCT_ShipCargo.CargoID as MaterialID, sum(FCT_ShipCargo.Amount) as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 3 group by FCT_ShipCargo.CargoID`).then(([items]) => items)

        return Object.fromEntries(rows.map((row) => [row.MaterialID, row.Amount]))
      }),
      default: {},
    },
    packets: {
      get: tracked('packets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await this.database.query(`select sum(FCT_MassDriverPackets.Duranium) as Duranium, sum(FCT_MassDriverPackets.Neutronium) as Neutronium, sum(FCT_MassDriverPackets.Corbomite) as Corbomite, sum(FCT_MassDriverPackets.Tritanium) as Tritanium, sum(FCT_MassDriverPackets.Boronide) as Boronide, sum(FCT_MassDriverPackets.Mercassium) as Mercassium, sum(FCT_MassDriverPackets.Vendarite) as Vendarite, sum(FCT_MassDriverPackets.Sorium) as Sorium, sum(FCT_MassDriverPackets.Uridium) as Uridium, sum(FCT_MassDriverPackets.Corundium) as Corundium, sum(FCT_MassDriverPackets.Gallicite) as Gallicite from FCT_MassDriverPackets where FCT_MassDriverPackets.GameID = ${this.GameID} and FCT_MassDriverPackets.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    // The game's mineral ledger (Aurora 2.6+), in 5-day buckets counted back from now. Older saves don't have the table: null means "not loaded", [] means "none". Any other failure (the game holding a lock while it saves, say) rejects, and the page says so.
    ledger: {
      get: tracked('ledger', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        // Read before the first await, so a window change re-runs this getter.
        const windowDays = Number(this.windowDays) || 365
        const [[table]] = await this.database.query("select count(*) as Present from sqlite_master where type = 'table' and name = 'FCT_RaceMineralData'")

        return table.Present ? await this.database.query(`select FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, cast((FCT_Game.GameTime - FCT_RaceMineralData.Time) / ${BUCKET_DAYS * SECONDS_PER_DAY} as integer) as Bucket, sum(FCT_RaceMineralData.Amount) as Amount, min(FCT_RaceMineralData.Time) as FirstTime, max(FCT_RaceMineralData.Time) as LastTime, max(VIR_Ticks.ProductionTicks) as ProductionTicks, max(VIR_Ticks.FirstTick) as FirstTick, max(VIR_Ticks.LastTick) as LastTick from FCT_RaceMineralData inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID cross join (select count(distinct VIR_Production.Time) as ProductionTicks, min(VIR_Production.Time) as FirstTick, max(VIR_Production.Time) as LastTick from FCT_RaceMineralData as VIR_Production inner join FCT_Game as VIR_Now on VIR_Now.GameID = VIR_Production.GameID where VIR_Production.GameID = ${this.GameID} and VIR_Production.RaceID = ${this.RaceID} and VIR_Production.Time > VIR_Now.GameTime - ${windowDays * SECONDS_PER_DAY} and VIR_Production.MineralDataType in (${PRODUCTION_TYPES.join(', ')})) as VIR_Ticks where FCT_RaceMineralData.GameID = ${this.GameID} and FCT_RaceMineralData.RaceID = ${this.RaceID} and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${windowDays * SECONDS_PER_DAY} group by FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType, Bucket`).then(([items]) => Object.freeze(items)) : []
      }),
      default: null,
    },
    surfaceMining: {
      get: tracked('surfaceMining', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(surfaceMiningQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    orbitalMining: {
      get: tracked('orbitalMining', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(orbitalMiningQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Naval admin commands with their Mining bonus and the systems in their range.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 6, share: 'Industrial' })
      }),
      default: {},
    },
    industrialProjects: {
      get: tracked('industrialProjects', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Duranium, FCT_IndustrialProjects.Neutronium, FCT_IndustrialProjects.Corbomite, FCT_IndustrialProjects.Tritanium, FCT_IndustrialProjects.Boronide, FCT_IndustrialProjects.Mercassium, FCT_IndustrialProjects.Vendarite, FCT_IndustrialProjects.Sorium, FCT_IndustrialProjects.Uridium, FCT_IndustrialProjects.Corundium, FCT_IndustrialProjects.Gallicite from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID} and FCT_IndustrialProjects.Pause = 0`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.mineral-outlook {
  .mineral-select {
    min-width: 220px;
  }

  .panel {
    margin-top: 16px;
  }

  .figures {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 32px;
    margin-bottom: 12px;
  }

  .figure-value {
    font-size: 18px;
    line-height: 26px;
    font-variant-numeric: tabular-nums;
  }

  .panel-head {
    padding: 8px 24px;
  }

  .panel-body {
    padding: 0 24px 12px;
  }

  .chart-title {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .legend {
    margin-bottom: 8px;
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    margin-right: 6px;
  }

  .runway-table td {
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .runway-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 160px;
  }

  .meter {
    flex: 0 0 64px;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
    background-color: var(--ae-muted);
  }

  .trend {
    display: block;
  }

  .timeline {
    position: relative;
    display: flex;
    align-items: center;
    height: 8px;
    border-radius: 4px;
    background: var(--ae-track-soft);
  }

  .timeline-full {
    height: 100%;
    border-radius: 4px 0 0 4px;
  }

  .timeline-decline {
    height: 100%;
    opacity: 0.35;
  }

  .timeline-end {
    width: 2px;
    height: 14px;
  }

  tr.is-focus-row {
    background-image: repeating-linear-gradient(-45deg, var(--ae-row-stripe) 0, var(--ae-row-stripe) 12px, var(--ae-row-stripe-soft) 12px, var(--ae-row-stripe-soft) 24px);
  }
}
</style>
