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

      <!-- Runway, flows and the focused outlook need every read to have succeeded: never a guess (zero stock, no ledger) while one is loading or failed. -->
      <template v-if="forecastReady">
        <stat-tiles :tiles="tiles" compact class="mt-2" />

        <v-card v-if="focusRow" class="panel" data-summary="Track the selected mineral's projected stock and mining output to see how long it lasts at current rates." elevation="1">
          <div class="panel-head">
            <span>{{ focusRow.name }} outlook</span>
            <span class="d-flex align-center flex-wrap">
              <v-chip small class="mr-1">
                <v-icon v-if="statusIcon(projection.status)" small left :color="statusColor(projection.status)">{{ statusIcon(projection.status) }}</v-icon>{{ projection.summary }}
              </v-chip>
              <provenance-mark :result="projection.result" class="mr-3" />
              <v-chip small class="mr-3">{{ focusDeposits.length }} {{ focusDeposits.length === 1 ? 'deposit' : 'deposits' }} mined</v-chip>
              <v-btn small outlined class="mr-2" :to="linkTo.minerals({ mineral: focusMineralId })"><v-icon small left>mdi-diamond-stone</v-icon>Mineral Breakdown</v-btn>
              <v-btn v-if="flowsKnown" small outlined @click="flowsOpen = true"><v-icon small left>mdi-chart-bar</v-icon>Sources and uses</v-btn>
            </span>
          </div>
          <div class="panel-body">
            <div class="figures">
              <div v-for="figure in focusFigures" :key="figure.label" class="figure">
                <div class="caption text--secondary">{{ figure.label }}</div>
                <div class="figure-value text-no-wrap">
                  <v-icon v-if="figure.icon" small :color="figure.iconColor">{{ figure.icon }}</v-icon>
                  {{ figure.value }}<provenance-mark :result="figure.result" />
                </div>
              </div>
            </div>
            <v-row v-if="projectionKnown" dense>
              <v-col cols="12" md="6">
                <div class="chart-title">Projected stockpile</div>
                <chart-canvas type="line" :data="stockChart" :options="stockOptions" :height="210" :label="`Projected ${focusRow.name} stockpile over ${horizon} years`" />
              </v-col>
              <v-col cols="12" md="6">
                <div class="chart-title">Projected mining output</div>
                <chart-canvas type="line" :data="outputChart" :options="outputOptions" :height="210" :label="`Projected ${focusRow.name} mining output over ${horizon} years`" />
              </v-col>
            </v-row>
            <v-alert v-else type="info" outlined dense class="mb-2">{{ projectionUnavailableText }}</v-alert>
            <div class="caption text--secondary">
              Mining follows each deposit's accessibility as it's worked down; other income and all uses stay at today's rates. In transit counts as stock.
            </div>
          </div>
        </v-card>
        <v-card class="panel" data-summary="Compare mineral stocks, production and use to see how long each stock lasts." elevation="1">
          <div class="panel-head">
            <span>Mineral runway<provenance-mark rule="mineral.runway" label /></span>
            <v-chip small>{{ coverageLabel }}</v-chip>
          </div>
          <v-data-table :headers="runwayHeaders" :items="mineralRows" item-key="id" :custom-sort="sortNullLast" :sort-by.sync="runwayTable.sortBy" :sort-desc.sync="runwayTable.sortDesc" :item-class="(item) => (item.id === focusMineralId ? 'is-focus-row' : '')" disable-pagination hide-default-footer dense class="runway-table" @click:row="(item) => (focusMineralId = item.id)">
            <template #[`item.name`]="{ item }">
              <span class="font-weight-medium">{{ item.name }}</span>
            </template>
            <template #[`item.stock`]="{ item }"><span class="text-no-wrap">{{ tons(item.stock) }}</span><provenance-mark v-if="item.stock === null" :result="item.results.stock" /></template>
            <template #[`item.transit`]="{ item }">
              <span :class="{ 'text--secondary': !item.transit }">{{ tons(item.transit) }}</span><provenance-mark v-if="item.transit === null" :result="item.results.transit" />
            </template>
            <template #[`item.produced`]="{ item }"><span class="text-no-wrap">{{ tons(item.produced) }}</span><provenance-mark :result="item.results.produced" /></template>
            <template #[`item.used`]="{ item }"><span class="text-no-wrap">{{ tons(item.used) }}</span><provenance-mark :result="item.results.used" /></template>
            <template #[`item.net`]="{ item }">
              <span class="text-no-wrap">
                <v-icon v-if="item.net !== null" small :color="item.net < 0 ? 'error' : 'success'">{{ item.net < 0 ? 'mdi-arrow-down' : 'mdi-arrow-up' }}</v-icon>
                {{ signedTons(item.net) }}<provenance-mark :result="item.results.net" />
              </span>
            </template>
            <template #[`item.runwaySort`]="{ item }">
              <div class="runway-cell">
                <div class="meter" :title="runwayLabel(item)">
                  <div class="meter-fill" :class="statusColor(item.status)" :style="{ width: `${meterWidth(item)}%` }" />
                </div>
                <span class="text-no-wrap">
                  <v-icon v-if="statusIcon(item.status)" small :color="statusColor(item.status)">{{ statusIcon(item.status) }}</v-icon>
                  {{ runwayLabel(item) }}<provenance-mark :result="item.results.runway" />
                </span>
              </div>
            </template>
            <template #[`item.queue`]="{ item }">
              <span :class="{ 'text--secondary': !item.queue }">{{ tons(item.queue) }}</span><provenance-mark :result="item.results.queue" />
            </template>
            <template #[`item.trend`]="{ item }">
              <v-sparkline v-if="item.trend.length > 1" :value="item.trend" :color="theme.inkMuted" :line-width="2" :padding="3" :smooth="2" height="24" width="120" class="trend" />
              <span v-else class="text--secondary">—</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            {{ hasLedger ? `Produced and used come from the game's mineral ledger over the last ${coverageText}, annualised. Freighter and mass-driver transfers between colonies aren't counted. The game doesn't log mining at colonies that buy their civilian complexes' minerals and send them by mass driver, so their mining is worked out from their mines and complexes. Industry queue: what the queued projects will use in the next 12 months.` : 'Produced comes from the mines; used is modelled, not measured, from the industry queue, the refineries, the maintenance facilities and the shipyards over the next 12 months (see Mineral uses).' }} Click a row to see its outlook. Use the table to see which minerals are heading for a shortage.
          </div>
        </v-card>
        <v-card class="panel" data-summary="Review logged or modelled mineral uses and choose which to include in the runway." elevation="1">
          <div class="panel-head">
            <span>Mineral uses<provenance-mark rule="mineral.flowPerYear" label /></span>
            <v-chip small>{{ hasLedger ? 'Observed in the ledger' : 'Modelled, no ledger' }}</v-chip>
          </div>
          <v-data-table :headers="categoryHeaders" :items="categoryTable" item-key="key" disable-sort disable-pagination hide-default-footer dense>
            <template #[`item.label`]="{ item }">
              <span class="font-weight-medium" :class="{ 'text--secondary': !item.enabled }">{{ item.label }}</span>
            </template>
            <template #[`item.coverage`]="{ item }">
              <v-chip small outlined :color="sourceColor(item)">{{ sourceLabel(item) }}</v-chip>
            </template>
            <template #[`item.basis`]="{ item }">
              <span v-if="item.reason" class="text--secondary">{{ item.reason }}</span>
              <span v-else class="text--secondary">{{ item.basis }}</span>
            </template>
            <template #[`item.total`]="{ item }"><span class="text-no-wrap">{{ tons(item.total) }}</span><provenance-mark :result="item.result" /></template>
            <template #[`item.focus`]="{ item }"><span class="text-no-wrap">{{ tons(item.focus) }}</span></template>
            <template #[`item.toggle`]="{ item }">
              <v-switch v-if="item.toggle" :input-value="item.enabled" :aria-label="`Count ${item.label} in the runway`" dense hide-details class="mt-0 pt-0" @change="toggleCategory(item.key, $event)" />
              <span v-else class="text--secondary">—</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            {{ hasLedger ? 'Observed uses are the ledger\'s, annualised; a switched-off use is left out of the Used column and the runway, and nothing is modelled on top of the ledger.' : 'Without a ledger every use is a modelled forecast, not a measurement: the industry queue and the shipyards\' tasks and activities running now over the next 12 months, the refineries and maintenance facilities at their current output. A use whose inputs the save does not hold is missing, with the reason, and leaves the runway unknown until it is switched off. Ground unit training has no rule and is not counted. Maintenance is held to the minerals the colonies hold, with no haul counted; where a stock is short of a year\'s need and a mine works a deposit of that mineral (at the colony, or at another colony sharing an NPR\'s stock), the figure is missing unless another mineral already settles it, as what the mine adds is not quantified. Shipbuilding minerals are assumed to reach the yard as fast as the tasks take them.' }}
          </div>
        </v-card>
        <mineral-supply :mineral="focusMineral" :supply="supply" :colonies="supplyColonies" :scenario="focusScenario" @update:scenario="enterSupplyScenario" />
        <deficit-sites :key="`${GameID}-${RaceID}`" :mineral="focusMineral" :supply="supply" :deposits="siteDeposits" :sources="deploymentSources" :builders="deficitBuilders" :runway="focusRunway" :loading="shortlistState.loading" :failed="shortlistState.failed" :error="shortlistState.error" @retry="retryShortlist" />

        <v-dialog v-model="flowsOpen" max-width="960" scrollable content-class="mineral-outlook">
          <v-card>
            <div class="panel-head">
              <span>Mineral sources and uses<provenance-mark rule="mineral.flowPerYear" label /></span>
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
                    <series-key :color="flowColor(group.key)" />{{ group.label }}
                  </span>
                </div>
                <chart-canvas type="bar" :data="flowsChart" :options="flowsOptions" :height="380" label="Mineral sources and uses per year, by purpose" />
                <div class="caption text--secondary mt-2">Tonnes per year. Sources to the right of zero, uses to the left.</div>
              </template>
              <v-data-table v-else :headers="flowsHeaders" :items="flowRows" item-key="id" :custom-sort="sortNullLast" :sort-by.sync="flowsTable.sortBy" :sort-desc.sync="flowsTable.sortDesc" :item-class="(item) => (item.id === focusMineralId ? 'is-focus-row' : '')" disable-pagination hide-default-footer dense>
                <template v-for="group in presentFlowGroups" #[`item.${group.key}`]="{ item }">
                  <span :key="group.key" class="text-no-wrap">{{ tons(item[group.key]) }}</span>
                </template>
              </v-data-table>
              <div class="caption text--secondary mt-2">The ledger's uses are all shown here. The switches under Mineral uses apply to the runway and the Used column only.</div>
            </v-card-text>
          </v-card>
        </v-dialog>
      </template>

      <v-card v-if="depositsReady" class="panel" data-summary="Compare deposits being mined by their yield and projected depletion." elevation="1">
        <div class="panel-head">
          <span>Deposits being mined<provenance-mark rule="mineral.depositForecast" label /></span>
          <span class="d-flex align-center">
            <v-switch v-model="allDeposits" label="All minerals" dense hide-details class="mt-0 mr-6" />
            <v-switch v-model="onlyEmptying" :label="`Empty within ${horizon} y`" dense hide-details class="mt-0" />
          </span>
        </div>
        <v-data-table :headers="depositHeaders" :items="visibleDeposits" item-key="key" :expanded.sync="expandedDeposits" show-expand single-expand :custom-sort="sortNullLast" :sort-by.sync="depositTable.sortBy" :sort-desc.sync="depositTable.sortDesc" :items-per-page.sync="depositTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: depositPageSizes }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
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
            <span v-if="item.rate === null" class="text--secondary">—</span>
            <span v-else-if="item.rate > 0">{{ tons(item.rate) }}</span>
            <span v-else class="text--secondary">Idle</span><provenance-mark v-if="item.rate !== 0" :result="item.rateResult" />
          </template>
          <template #[`item.halfSort`]="{ item }"><span class="text-no-wrap">{{ halfLabel(item) }}</span><provenance-mark v-if="!item.known" :result="item.forecastResult" /></template>
          <template #[`item.emptySort`]="{ item }">
            <span class="text-no-wrap">
              <v-icon v-if="emptyingSoon(item)" small color="warning">mdi-alert</v-icon>
              {{ emptyLabel(item) }}<provenance-mark :result="item.forecastResult" />
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
              <template v-if="item.known">
                <div class="chart-title">Output of {{ item.mineral }} at {{ item.bodyName }}</div>
                <chart-canvas type="line" :data="depositChart(item)" :options="depositOptions(item)" :height="200" :label="`${item.mineral} output at ${item.bodyName} over time`" />
              </template>
              <div class="caption text--secondary mt-1">
                {{ depositNote(item) }}
              </div>
            </td>
          </template>
        </v-data-table>
        <div class="panel-foot caption text--secondary">
          Use it to plan new deposits before the old ones empty. Rates include governor, sector, commander and naval-admin bonuses. Orbital mining is an estimate that follows the game's formula with the crew share. It may read low once a deposit is mined below half its original amount. A short crew, a damaged module, a miner with no commander and one outside any naval admin command are unobserved. Timeline: solid until half mined, lighter while accessibility falls, across {{ horizon }} years.
        </div>
      </v-card>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme, flowColor, withAlpha } from '../components/charts/theme'
import DeficitSites from '../components/minerals/DeficitSites.vue'
import MineralSupply from '../components/minerals/MineralSupply.vue'
import LoadState from '../components/page/LoadState.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import { activeAppearance } from '../utilities/appearance'
import { loadPacketsInFlight } from '../utilities/colony-minerals'
import { separatedNumber, roundToDecimal } from '../utilities/math'
import { systemBodyName, populationName } from '../utilities/aurora'
import { NO_DEPLOYMENT_SOURCES, NO_SITE_DEPOSITS, loadDeploymentSources, loadSiteDeposits } from '../utilities/deficit-sites'
import { linkTo, queryId } from '../utilities/deep-links'
import { CATEGORY_KEYS, industryBasis, legacyColoniesQuery, legacyModels, shipyardActivitiesQuery, shipyardTasksQuery } from '../utilities/legacy-consumption'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { idleConstruction } from '../utilities/mine-bootstrap'
import { chartGridColor, hierarchyView } from '../utilities/map-hierarchy'
import { COMPACT_YEARS, CRITICAL_RUNWAY_YEARS, FLOW_GROUPS, MINERALS, PRODUCTION_TYPES, SECONDS_PER_DAY, TRANSFER_TYPES, annualQueueDemand, compact, compactYears, depositStateAt, flowGroupOf, ledgerCoverageDays, yearSteps } from '../utilities/minerals'
import { categoryRows, categoryUses, depositForecastResult, flowResults, holdingsResult, miningSum, orbitalRateResult, projectionResult, queueDemandResult, runwayResult, runwayStateResult, surfaceRateResult } from '../utilities/mineral-outlook'
import { gateMiningRows, orbitalMiningQuery, surfaceMiningQuery } from '../utilities/mining-data'
import { loadNavalAdmins } from '../utilities/naval-admins'
import { loadTransfers, loadSiteRoutes, mineralSupply, scenarioEntries, transferFlows } from '../utilities/mineral-supply'
import { industryUsage } from '../utilities/production'
import { describeResult, describeRule, isAvailable, sumResults, unavailable, valueOrNull } from '../utilities/provenance'

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
  legacyColonies: 'the refineries and maintenance facilities',
  shipyardTasks: 'the shipyard tasks',
  shipyardActivities: 'the shipyard activities',
  populationProductionModifiers: 'production modifiers',
  siteRoutes: 'the colonies\' mass drivers and destinations',
  packetsByDestination: 'mass-driver packets by destination',
  transfers: 'the ledger\'s transfers between colonies',
  siteDeposits: 'the surveyed deposits',
  deploymentSources: 'the routes and mine types for new sites',
}
const DEPOSIT_INPUTS = ['surfaceMining', 'orbitalMining', 'navalAdmins']
// The reads of the sites panel alone: the runway, the forecasts and the supply never wait for them, and a failure of one is shown on that panel.
const OPTIONAL_INPUTS = ['siteDeposits', 'deploymentSources']
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key))

// One column per mineral summing the table's rows, but only when every row records the mineral: a sum that leaves a missing amount out would read as complete (null here, so the holdings say which amount is missing).
const completeSums = (table) => MINERALS.map((mineral) => `case when count(${table}.${mineral.name}) = count(*) then sum(${table}.${mineral.name}) end as ${mineral.name}`).join(', ')

const NO_FORECAST = Object.freeze({ yearsToHalf: null, yearsToDepletion: null, idle: false, unknown: true })
const INCOME_GROUPS = FLOW_GROUPS.filter((group) => group.income).map((group) => group.key)
const SPEND_GROUPS = FLOW_GROUPS.filter((group) => !group.income).map((group) => group.key)

const DEPOSIT_PAGE_SIZES = [15, 30, 60, -1]
const FLOWS_VIEWS = ['chart', 'table']

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'MineralOutlookPage',
  components: { ChartCanvas, DeficitSites, LoadState, MineralSupply, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    persistedView({
      windowDays: { key: 'mineralOutlookWindowDays', default: 365 },
      horizon: { key: 'mineralOutlookHorizon', default: 50 },
      allDeposits: { key: 'mineralOutlookAllDeposits', default: false },
      onlyEmptying: { key: 'mineralOutlookOnlyEmptying', default: false },
      disabledCategories: { key: 'mineralOutlookDisabledCategories', default: [], scope: 'race', valid: (value) => Array.isArray(value) && value.every((key) => CATEGORY_KEYS.includes(key)) },
      focusMineralId: { key: 'mineralOutlookFocus', default: null, scope: 'race', valid: oneOf(MINERALS.map((mineral) => mineral.id)) },
      flowsView: { key: 'mineralOutlookFlowsView', default: 'chart', valid: oneOf(FLOWS_VIEWS) },
      runwayTable: tableView('mineralOutlookRunwayTable', { sortBy: ['runwaySort'], sortDesc: [false] }),
      flowsTable: tableView('mineralOutlookFlowsTable', {}),
      depositTable: tableView('mineralOutlookDepositsTable', { sortBy: ['emptySort'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: DEPOSIT_PAGE_SIZES }),
      hierarchy: hierarchyView,
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
      supplyScenario: {},
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

    // The reads behind the runway and the forecasts that failed: the reads of the sites panel are its own (`shortlistState`).
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    // The sites panel's reads: loading until each has settled, else the words naming the failed ones with the first message. The panel shows no shortlist from a read that is in flight or failed.
    shortlistState() {
      const failed = OPTIONAL_INPUTS.filter((key) => this.loadErrors[key])

      return { loading: failed.length === 0 && !allLoaded(this.loadErrors, OPTIONAL_INPUTS), failed: joinLabels(failed.map((key) => INPUT_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
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

    // Whether the ledger covers any days: the flows are annualised from them, so without any they are not known.
    flowsKnown() {
      return this.hasLedger && this.coverageDays > 0
    },

    coverageText() {
      return this.flowsKnown ? `${roundToDecimal(this.coverageDays, 0)} days` : 'unknown number of days'
    },

    coverageLabel() {
      if (!this.hasLedger) {
        return 'No ledger'
      }

      return this.flowsKnown ? `Ledger: last ${this.coverageText}` : 'Ledger covers no days'
    },

    perYear() {
      return this.flowsKnown ? 365 / this.coverageDays : null
    },

    // Mining the ledger leaves out (colonies shipping their civilian complexes' output by mass driver), t/yr, as a mining-rate result by MaterialID.
    unloggedResults() {
      const results = {}
      const add = (row, result) => {
        (results[row.MaterialID] = results[row.MaterialID] || []).push(result)
      }

      this.surfaceMining.filter((row) => row.MassDriverExport).forEach((row) => add(row, surfaceRateResult(row)))
      this.orbitalMining.filter((row) => row.MassDriverExport).forEach((row) => add(row, orbitalRateResult(row, this.navalAdmins)))

      return Object.fromEntries(Object.entries(results).map(([materialId, list]) => [materialId, miningSum(list)]))
    },

    // { [MaterialID]: { [groupKey]: t/yr } } from the ledger alone, annualised: all 0 while the ledger covers no days (`flowsKnown`).
    ledgerFlows() {
      const flows = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, 0]))]))
      const { perYear } = this

      if (!this.flowsKnown) {
        return flows
      }

      this.ledger.forEach((row) => {
        const group = !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)

        if (group && flows[row.MaterialID]) {
          flows[row.MaterialID][group.key] += row.Amount * perYear
        }
      })

      return flows
    },

    // { [MaterialID]: { [groupKey]: t/yr } } as shown: the ledger's flows with the unlogged mining added to mining. A flow that is not known (no ledger days, or a mining rate missing an input) is null.
    flowsByMineral() {
      return Object.fromEntries(MINERALS.map((mineral) => {
        const ledgerFlows = this.ledgerFlows[mineral.id]
        const unlogged = this.unloggedResults[mineral.id]
        const mining = unlogged ? valueOrNull(unlogged) : 0

        return [mineral.id, Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, !this.flowsKnown || (group.key === 'mining' && mining === null) ? null : ledgerFlows[group.key] + (group.key === 'mining' ? mining : 0)]))]
      }))
    },

    // Mined deposits: every colony and orbital miner on the same body and mineral summed. `rate` and `delivered` (t/yr, null when a source's input is missing) come from the mining-rate results `rateResult` and `deliveredResult`; `forecastResult` is the deposit-forecast result and `known` says it, and the delivered rate, are available.
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
          }
        }

        deposits[key].sources.push(source)
      }

      this.surfaceMining.forEach((row) => {
        add(row, { name: stripHtml(populationName(row, '', true)), kind: 'surface', rateResult: surfaceRateResult(row, false), deliveredResult: surfaceRateResult(row, true) })
      })

      this.orbitalMining.forEach((row) => {
        const result = orbitalRateResult(row, navalAdmins)

        add(row, { name: row.ShipName, kind: 'orbital', rateResult: result, deliveredResult: result })
      })

      return Object.values(deposits).map((deposit) => {
        const rateResult = miningSum(deposit.sources.map((source) => source.rateResult))
        const deliveredResult = miningSum(deposit.sources.map((source) => source.deliveredResult))
        const forecastResult = depositForecastResult(deposit, rateResult)
        const rate = valueOrNull(rateResult)
        const delivered = valueOrNull(deliveredResult)
        const known = isAvailable(forecastResult) && delivered !== null
        const forecast = known ? forecastResult.value : NO_FORECAST

        return {
          ...deposit,
          rate,
          delivered,
          rateResult,
          deliveredResult,
          forecastResult,
          known,
          amount: deposit.Amount,
          accessibility: deposit.Accessibility,
          forecast,
          sourceNames: deposit.sources.filter((source) => source.name !== deposit.bodyName).map((source) => (source.kind === 'orbital' ? `${source.name} (orbital)` : source.name)).join(', '),
          deliveredShare: known && rate > 0 ? delivered / rate : 0,
          halfSort: known ? forecast.yearsToHalf ?? Infinity : null,
          emptySort: known && !forecast.idle ? forecast.yearsToDepletion : null,
        }
      })
    },

    // `annualQueueDemand`'s { demand, unknown, incomplete }: a colony whose production capacity is not known leaves the demand of the minerals its queue uses unknown.
    queueDemand() {
      return annualQueueDemand(this.industrialProjects, (populationId, facility) => valueOrNull(this.populationCapacityResult(populationId, facility)))
    },

    // The modelled uses of a save without a ledger (null with one, which observes them): `{ industry, fuel, maintenance, shipbuilding }`, each `{ byMineral, basis }`. A ledger save never gets a model on top of its observed uses.
    legacyUse() {
      if (this.hasLedger) {
        return null
      }

      const { queueDemand, industrialProjects } = this
      const industry = { byMineral: Object.fromEntries(MINERALS.map((mineral) => [mineral.name, queueDemandResult(queueDemand, mineral.name)])), basis: industryBasis({ projects: industrialProjects, npr: this.legacyColonies.some((colony) => colony.NPR) }) }

      return { industry, ...legacyModels({ colonies: this.legacyColonies, tasks: this.shipyardTasks, activities: this.shipyardActivities, modifiers: this.populationProductionModifiers }) }
    },

    focusMineral() {
      return MINERALS.find((mineral) => mineral.id === this.focusMineralId) || null
    },

    // The deliveries entered for the focused mineral: the page keeps them by mineral, so an assumption made for one never reaches another.
    focusScenario() {
      return (this.focusMineral && this.supplyScenario[this.focusMineral.id]) || {}
    },

    // The colonies a hypothetical delivery can go to, by name.
    supplyColonies() {
      return this.siteRoutes.map((colony) => ({ id: colony.PopulationID, name: colony.PopName })).sort((a, b) => a.name.localeCompare(b.name))
    },

    // The focused mineral's extraction, export capacity and delivered supply, kept apart: what each site extracts, what it adds to its own stock, what leaves it by a route the save names, and what is in flight to each destination. Nothing is delivered to a colony that no route or packet names.
    supply() {
      const { focusMineral } = this

      if (!focusMineral || !this.forecastReady) {
        return null
      }

      return mineralSupply({ surface: this.surfaceMining, orbital: this.orbitalMining, navalAdmins: this.navalAdmins, routes: this.siteRoutes, packets: this.packetsByDestination, cargo: this.cargo, RaceID: this.RaceID, materialId: focusMineral.id, flows: transferFlows(this.transfers, this.perYear), entries: scenarioEntries(this.focusScenario) })
    },

    // The colonies that could build new mines, each with the part of its construction capacity no running project holds (BP/yr, a result: unavailable, naming what is missing, when the capacity or a project's share is not known, or when the running projects could not be read: no project read is not the same as none running).
    deficitBuilders() {
      const { colonies, projects } = this.deploymentSources
      const usage = projects ? industryUsage(projects) : null

      return colonies.map((colony) => ({ colony, rate: usage ? idleConstruction(this.populationCapacityResult(colony.PopulationID, 'construction'), usage[`${colony.PopulationID}-construction`]) : unavailable({ rule: 'mineBootstrap.localBuild', missing: ['the running projects (they could not be read)'], units: 'BP/yr' }) }))
    },

    // The focused mineral's runway for the sites panel: the years the stock lasts and the result behind them.
    focusRunway() {
      const row = this.focusRow

      return row ? { years: row.runway, result: row.results.runway } : null
    },

    // One row per use of the runway table above: where its figure comes from (observed, modelled or missing, with the reason), what it stands on, its t/yr over every mineral and over the focused one, and whether it counts.
    categoryTable() {
      return categoryRows({ hasLedger: this.hasLedger, coverageDays: this.flowsKnown ? this.coverageDays : 0, ledgerFlows: this.ledgerFlows, minerals: MINERALS, modelled: this.legacyUse, disabled: this.disabledCategories, focus: this.focusMineral })
    },

    categoryHeaders() {
      return [
        { text: 'Use', value: 'label' },
        { text: 'Figure', value: 'coverage' },
        { text: 'Basis', value: 'basis' },
        { text: 'Used / yr, all minerals', value: 'total', align: 'end' },
        { text: `${this.focusMineral ? this.focusMineral.name : 'Focus mineral'} / yr`, value: 'focus', align: 'end' },
        { text: 'Count in runway', value: 'toggle' },
      ]
    },

    // One row per mineral: plain figures (null when unknown, `runway` the years of a falling stock and null otherwise, `runwaySort` also Infinity for one that holds or grows) beside the provenance results in `results`.
    mineralRows() {
      const { stockpile, cargo, packets, deposits, hasLedger, coverageDays, queueDemand, legacyUse, disabledCategories } = this

      return MINERALS.map((mineral) => {
        const holdings = holdingsResult({ stockpile, cargo, packets, mineral })
        const queue = queueDemandResult(queueDemand, mineral.name)
        const mined = miningSum(deposits.filter((deposit) => deposit.MaterialID === mineral.id).map((deposit) => deposit.deliveredResult))
        const flows = flowResults({ hasLedger, coverageDays, ledger: this.ledgerFlows[mineral.id], incomeGroups: INCOME_GROUPS, spendGroups: SPEND_GROUPS, unlogged: this.unloggedResults[mineral.id] || null, mined, uses: categoryUses({ modelled: legacyUse, disabled: disabledCategories, mineralName: mineral.name }) })
        const runway = runwayResult(holdings.held, flows.net)
        const state = runwayStateResult(runway, flows.produced, flows.used)
        const years = valueOrNull(runway)
        const held = valueOrNull(holdings.held)

        return {
          id: mineral.id,
          name: mineral.name,
          stock: valueOrNull(holdings.stock),
          transit: valueOrNull(holdings.transit),
          produced: valueOrNull(flows.produced),
          used: valueOrNull(flows.used),
          net: valueOrNull(flows.net),
          runway: Number.isFinite(years) ? years : null,
          status: isAvailable(state) ? state.value : 'unknown',
          runwaySort: years,
          queue: valueOrNull(queue),
          trend: this.trendFor(mineral.id, held),
          results: { stock: holdings.stock, transit: holdings.transit, held: holdings.held, produced: flows.produced, used: flows.used, net: flows.net, mining: flows.mining, otherIncome: flows.otherIncome, runway, state, queue },
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
        { label: 'Stockpile (t)', value: this.tons(row.stock), result: row.results.stock },
        { label: 'In transit (t)', value: this.tons(row.transit), result: row.results.transit },
        { label: 'Produced / yr', value: this.tons(row.produced), result: row.results.produced },
        { label: 'Used / yr', value: this.tons(row.used), result: row.results.used },
        { label: 'Net / yr', value: this.signedTons(row.net), icon: row.net === null ? null : row.net < 0 ? 'mdi-arrow-down' : 'mdi-arrow-up', iconColor: row.net < 0 ? 'error' : 'success', result: row.results.net },
        { label: 'Runway', value: this.runwayLabel(row), icon: this.statusIcon(row.status), iconColor: this.statusColor(row.status), result: row.results.runway },
        { label: 'Industry queue (12 mo)', value: this.tons(row.queue), result: row.results.queue },
      ]
    },

    focusDeposits() {
      return this.deposits.filter((deposit) => deposit.MaterialID === this.focusMineralId)
    },

    visibleDeposits() {
      return this.deposits.filter((deposit) => (this.allDeposits || deposit.MaterialID === this.focusMineralId) && (!this.onlyEmptying || this.emptyingSoon(deposit)))
    },

    linkQuery() {
      return linkTo.mineralOutlook(this.focusMineralId).query
    },

    linkLabel() {
      const mineral = MINERALS.find((item) => item.id === this.focusMineralId)

      return mineral ? mineral.name : ''
    },

    // The tiles' counts leave out what is not known and say how much that is; each tile's title carries the status of its figure.
    tiles() {
      const rows = this.mineralRows
      const unknown = rows.filter((row) => row.status === 'unknown')
      const declining = rows.filter((row) => row.runway !== null)
      const shortest = declining.slice().sort((a, b) => a.runway - b.runway)[0]
      const active = this.deposits.filter((deposit) => deposit.known && !deposit.forecast.idle)
      const idle = this.deposits.filter((deposit) => deposit.known && deposit.forecast.idle)
      const noForecast = this.deposits.filter((deposit) => !deposit.known)
      const emptying = active.filter((deposit) => deposit.forecast.yearsToDepletion <= this.horizon)
      const mined = sumResults({ rule: 'mineral.flowPerYear', results: rows.map((row) => row.results.mining) })
      const unknownNote = unknown.length ? `${unknown.length} of ${MINERALS.length} minerals without a figure` : ''
      const depositNote = [`Of ${active.length} mined deposits`, idle.length ? `${idle.length} not being mined` : '', noForecast.length ? `${noForecast.length} without a forecast` : ''].filter(Boolean).join(', ')
      let runwayValue = 'None running down'
      let runwayNote = 'Every mineral breaks even or grows'

      if (shortest) {
        runwayValue = `${shortest.name} · ${this.years(shortest.runway)}`
        runwayNote = ['Stock and transit at today\'s net rate', unknownNote].filter(Boolean).join(' · ')
      } else if (unknown.length) {
        runwayValue = '—'
        runwayNote = unknownNote
      }

      return [
        {
          label: 'Shortest runway',
          title: shortest ? describeResult(shortest.results.runway) : unknown.length ? describeResult(unknown[0].results.runway) : describeRule('mineral.runway'),
          value: runwayValue,
          note: runwayNote,
          icon: shortest ? this.statusIcon(shortest.status) : unknown.length ? null : 'mdi-check-circle',
          iconColor: shortest ? this.statusColor(shortest.status) : 'success',
        },
        {
          label: 'Minerals running down',
          title: describeRule('mineral.runway'),
          value: `${declining.length} of ${rows.length - unknown.length}`,
          note: [declining.length ? declining.map((row) => row.name).join(', ') : 'None', unknownNote].filter(Boolean).join(' · '),
        },
        {
          label: `Deposits emptying within ${this.horizon} y`,
          title: describeRule('mineral.depositForecast'),
          value: !active.length && !idle.length && noForecast.length ? '—' : `${emptying.length}`,
          note: depositNote,
          icon: emptying.length ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Mined per year',
          title: describeResult(mined),
          value: this.tons(valueOrNull(mined)),
          note: !this.hasLedger ? 'From mines, all minerals' : Object.keys(this.unloggedResults).length ? 'Ledger plus unlogged mining, all minerals' : 'From the ledger, all minerals',
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
        { text: this.flowsKnown ? `Stock, last ${this.coverageText}` : 'Stock trend', value: 'trend', sortable: false },
      ]
    },

    presentFlowGroups() {
      return FLOW_GROUPS.filter((group) => MINERALS.some((mineral) => this.flowsByMineral[mineral.id][group.key] > 0))
    },

    flowRows() {
      return MINERALS.map((mineral) => ({ id: mineral.id, name: mineral.name, ...Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, this.flowsByMineral[mineral.id][group.key]])) }))
    },

    flowsHeaders() {
      return [{ text: 'Mineral (t / yr)', value: 'name' }, ...this.presentFlowGroups.map((group) => ({ text: `${group.label}${group.income ? '' : ' (use)'}`, value: group.key, align: 'end' }))]
    },

    flowsChart() {
      return {
        labels: MINERALS.map((mineral) => mineral.name),
        datasets: this.presentFlowGroups.map((group) => ({
          label: group.label,
          data: MINERALS.map((mineral) => (this.flowsByMineral[mineral.id][group.key] === null ? null : (group.income ? 1 : -1) * this.flowsByMineral[mineral.id][group.key])),
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
            grid: { color: (context) => (context.tick && context.tick.value === 0 ? this.theme.inkMuted : chartGridColor(this.hierarchy, this.theme.border)) },
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

    // The focused mineral's stockpile and output over the horizon, as `result` (a 'mineral.stockProjection' result) with its `stock`, `output` and `runOut`; empty and `status` 'unknown' while the result is unavailable.
    projection() {
      const row = this.focusRow
      const steps = this.projectionSteps

      if (!row) {
        return { stock: [], output: [], runOut: null, firstEmpty: null, status: 'ok', summary: '', result: null }
      }

      const result = projectionResult({ held: row.results.held, otherIncome: row.results.otherIncome, used: row.results.used, deposits: this.focusDeposits.map((deposit) => ({ deposit, rate: deposit.rateResult, forecast: deposit.forecastResult, share: deposit.deliveredShare })), steps })

      if (!isAvailable(result)) {
        return { stock: [], output: [], runOut: null, firstEmpty: null, status: 'unknown', summary: 'Projection not available', result }
      }

      const { stock, output, runOut } = result.value
      const firstEmpty = this.focusDeposits.filter((deposit) => this.emptyingSoon(deposit)).sort((a, b) => a.forecast.yearsToDepletion - b.forecast.yearsToDepletion)[0]
      const summary = runOut !== null ? `Runs out in ${this.years(runOut)}` : stock[stock.length - 1] < stock[0] ? `Falling, ${compact(stock[stock.length - 1])} left in ${this.horizon} y` : `Lasts past ${this.horizon} y`
      const status = runOut !== null ? (runOut < CRITICAL_RUNWAY_YEARS ? 'critical' : 'warning') : stock[stock.length - 1] < stock[0] ? 'ok' : 'growing'

      return { stock, output, runOut, firstEmpty, summary, status, result }
    },

    projectionKnown() {
      return isAvailable(this.projection.result)
    },

    projectionUnavailableText() {
      return this.projection.result ? `The projection is not available. ${describeResult(this.projection.result)}.` : ''
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
    // A mineral restored for another race is the user's pick, not the stand-in of the race before; the deliveries entered belong to the race and game they were entered for.
    RaceID() {
      this.fallbackFocusId = null
      this.supplyScenario = {}
    },
    GameID() {
      this.supplyScenario = {}
    },
  },
  methods: {
    // Reads again the reads of the sites panel that failed.
    retryShortlist() {
      OPTIONAL_INPUTS.filter((key) => this.loadErrors[key]).forEach((key) => this.$asyncComputed[key].update())
    },
    // The deliveries entered for the focused mineral replace its own entries; those of the other minerals stay as they were.
    enterSupplyScenario(inputs) {
      this.supplyScenario = { ...this.supplyScenario, [this.focusMineralId]: inputs }
    },
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
        const emptiest = this.deposits.filter((deposit) => deposit.emptySort !== null).reduce((first, deposit) => (first && first.emptySort <= deposit.emptySort ? first : deposit), null)
        const id = emptiest ? emptiest.MaterialID : rows[0].id

        this.fallbackFocusId = id
        this.setUnsaved('focusMineralId', id)
      }
    },

    // A use of the table's Count switch: `on` brings it back into the runway, otherwise it is left out. The list is replaced, never changed in place, so the stored view sees it.
    toggleCategory(key, on) {
      const others = this.disabledCategories.filter((item) => item !== key)

      this.disabledCategories = on ? others : [...others, key]
    },

    sourceLabel(row) {
      return row.coverage === 'observed' ? 'Observed' : row.coverage === 'modelled' ? 'Modelled forecast' : 'Missing'
    },
    sourceColor(row) {
      return row.coverage === 'observed' ? 'success' : row.coverage === 'modelled' ? 'info' : 'warning'
    },

    flowColor(key) {
      return flowColor(this.appearance, key)
    },

    // Tonnes, or a dash for a figure that is not known (a real 0 shows as 0).
    tons(value) {
      return value !== null && value !== undefined && isFinite(value) ? separatedNumber(roundToDecimal(value, 0), this.separator) : '—'
    },
    signedTons(value) {
      return value !== null && value !== undefined && isFinite(value) ? `${value < 0 ? '−' : '+'}${this.tons(Math.abs(value))}` : '—'
    },
    fixed(value, decimals) {
      return value !== null && value !== undefined && isFinite(value) ? roundToDecimal(value, decimals).toFixed(decimals) : '—'
    },
    sortNullLast(items, sortBy, sortDesc) {
      const [key] = sortBy

      if (!key) {
        return items
      }

      const direction = sortDesc[0] ? -1 : 1
      const known = (item) => item[key] !== null && item[key] !== undefined
      const sorted = items.filter(known).sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * direction)

      return sorted.concat(items.filter((item) => !known(item)))
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

    runwayLabel(row) {
      if (row.status === 'unknown') {
        return '—'
      } else if (row.status === 'idle') {
        return 'No activity'
      } else if (row.status === 'growing') {
        return 'Growing'
      }

      return this.years(row.runway)
    },
    statusIcon(status) {
      return { critical: 'mdi-alert-octagon', warning: 'mdi-alert', ok: 'mdi-trending-down', growing: 'mdi-trending-up', idle: 'mdi-minus' }[status] || null
    },
    statusColor(status) {
      return { critical: 'error', warning: 'warning', ok: '', growing: 'success', idle: '' }[status] || ''
    },
    meterWidth(row) {
      if (row.runway === null) {
        return row.status === 'growing' ? 100 : 0
      }

      return Math.max(2, Math.min(100, (row.runway / this.horizon) * 100))
    },

    // Stock (with transit) at the end of each ledger bucket, oldest first.
    trendFor(materialId, current) {
      const unloggedResult = this.unloggedResults[materialId]

      if (!this.hasLedger || !this.flowsKnown || current === null || (unloggedResult && !isAvailable(unloggedResult))) {
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
      const unlogged = ((unloggedResult ? unloggedResult.value : 0) * BUCKET_DAYS) / 365
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

      if (!deposit.known || forecast.idle) {
        return '—'
      } else if (forecast.yearsToHalf === null) {
        return 'No decline'
      } else if (forecast.yearsToHalf === 0) {
        return 'Past half'
      }

      return this.years(forecast.yearsToHalf)
    },
    emptyLabel(deposit) {
      if (!deposit.known) {
        return '—'
      }

      return deposit.forecast.idle ? 'Not being mined' : this.years(deposit.forecast.yearsToDepletion)
    },
    emptyingSoon(deposit) {
      return deposit.known && !deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon
    },
    timelineWidth(deposit, part) {
      const { forecast } = deposit

      if (!deposit.known || forecast.idle) {
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
      if (!deposit.known) {
        return `No forecast. ${describeResult(deposit.forecastResult)}.`
      }

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

        return await this.database.query(`select ${completeSums('FCT_Population')} from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    cargo: {
      get: tracked('cargo', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const rows = await this.database.query(`select FCT_ShipCargo.CargoID as MaterialID, case when count(FCT_ShipCargo.Amount) = count(*) then sum(FCT_ShipCargo.Amount) end as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 3 group by FCT_ShipCargo.CargoID`).then(([items]) => items)

        return Object.fromEntries(rows.map((row) => [row.MaterialID, row.Amount]))
      }),
      default: {},
    },
    packets: {
      get: tracked('packets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await this.database.query(`select ${completeSums('FCT_MassDriverPackets')}, count(*) as Packets from FCT_MassDriverPackets where FCT_MassDriverPackets.GameID = ${this.GameID} and FCT_MassDriverPackets.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    // One row per colony of the race with its drivers, destination and every mineral's stock: what decides whether a site's output can leave it by packet.
    siteRoutes: {
      get: tracked('siteRoutes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadSiteRoutes(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // The mass-driver packets in flight by the colony they are bound for.
    packetsByDestination: {
      get: tracked('packetsByDestination', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadPacketsInFlight(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },
    // The ledger's moves between colonies (mass-driver sends and receipts, freighter loads and unloads) over the window, by colony and mineral.
    transfers: {
      get: tracked('transfers', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        // Read before the first await, so a window change re-runs this getter.
        const windowDays = Number(this.windowDays) || 365

        return await loadTransfers(this.database, { GameID: this.GameID, RaceID: this.RaceID, windowDays })
      }),
      default: [],
    },
    // The deposits of the bodies the race has surveyed, for the sites of a deficit mineral. A body it has not surveyed is never read.
    siteDeposits: {
      get: tracked('siteDeposits', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_SITE_DEPOSITS
        }

        return await loadSiteDeposits(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: NO_SITE_DEPOSITS,
    },
    // The jump points, ship classes, mine types, colonies and projects that time a new site's deployment and a carrier's route.
    deploymentSources: {
      get: tracked('deploymentSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_DEPLOYMENT_SOURCES
        }

        return await loadDeploymentSources(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: NO_DEPLOYMENT_SOURCES,
    },
    // The game's mineral ledger, in 5-day buckets counted back from now: null means "not loaded", [] means "none". Any other failure (the game holding a lock while it saves, say) rejects, and the page says so.
    ledger: {
      get: tracked('ledger', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        // Read before the first await, so a window change re-runs this getter.
        const windowDays = Number(this.windowDays) || 365

        return await this.database.query(`select FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, cast((FCT_Game.GameTime - FCT_RaceMineralData.Time) / ${BUCKET_DAYS * SECONDS_PER_DAY} as integer) as Bucket, sum(FCT_RaceMineralData.Amount) as Amount, min(FCT_RaceMineralData.Time) as FirstTime, max(FCT_RaceMineralData.Time) as LastTime, max(VIR_Ticks.ProductionTicks) as ProductionTicks, max(VIR_Ticks.FirstTick) as FirstTick, max(VIR_Ticks.LastTick) as LastTick from FCT_RaceMineralData inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID cross join (select count(distinct VIR_Production.Time) as ProductionTicks, min(VIR_Production.Time) as FirstTick, max(VIR_Production.Time) as LastTick from FCT_RaceMineralData as VIR_Production inner join FCT_Game as VIR_Now on VIR_Now.GameID = VIR_Production.GameID where VIR_Production.GameID = ${this.GameID} and VIR_Production.RaceID = ${this.RaceID} and VIR_Production.Time > VIR_Now.GameTime - ${windowDays * SECONDS_PER_DAY} and VIR_Production.MineralDataType in (${PRODUCTION_TYPES.join(', ')})) as VIR_Ticks where FCT_RaceMineralData.GameID = ${this.GameID} and FCT_RaceMineralData.RaceID = ${this.RaceID} and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${windowDays * SECONDS_PER_DAY} group by FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType, Bucket`).then(([items]) => Object.freeze(items))
      }),
      default: null,
    },
    surfaceMining: {
      get: tracked('surfaceMining', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(surfaceMiningQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(gateMiningRows(items, blocked)))
      }),
      default: [],
    },
    orbitalMining: {
      get: tracked('orbitalMining', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(orbitalMiningQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(gateMiningRows(items, blocked)))
      }),
      default: [],
    },
    // Naval admin commands with their Mining bonus and the systems in their range.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const { ranks, blocked } = await this.capabilityGates('/mineral-outlook')

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 6, share: 'Industrial', ranks, blocked })
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
    // The refineries and maintenance facilities of each colony, the shipyards' tasks and their activities, for the model of the uses a save without a ledger cannot show. Not read for a save with a ledger, which observes them.
    legacyColonies: {
      get: tracked('legacyColonies', async function () {
        const ledger = this.ledger

        if (!this.database || !this.GameID || !this.RaceID || ledger === null || ledger.length) {
          return []
        }

        return await this.database.query(legacyColoniesQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    shipyardTasks: {
      get: tracked('shipyardTasks', async function () {
        const ledger = this.ledger

        if (!this.database || !this.GameID || !this.RaceID || ledger === null || ledger.length) {
          return []
        }

        return await this.database.query(shipyardTasksQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    shipyardActivities: {
      get: tracked('shipyardActivities', async function () {
        const ledger = this.ledger

        if (!this.database || !this.GameID || !this.RaceID || ledger === null || ledger.length) {
          return []
        }

        return await this.database.query(shipyardActivitiesQuery({ GameID: this.GameID, RaceID: this.RaceID })).then(([items]) => Object.freeze(items))
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
    font-size: calc(18px * var(--ae-font-scale));
    line-height: calc(26px * var(--ae-font-scale));
    font-variant-numeric: tabular-nums;
  }

  .panel-head {
    padding: 8px 24px;
  }

  .panel-body {
    padding: 0 24px 12px;
  }

  .chart-title {
    font-size: calc(14px * var(--ae-font-scale));
    font-weight: 500;
    margin-bottom: 8px;
  }

  .legend {
    margin-bottom: 8px;
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
}
</style>
