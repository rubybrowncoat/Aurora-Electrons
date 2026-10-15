<template>
  <div>
    <v-container fluid class="production-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--types">
            <div class="tool__label caption text--secondary">Show</div>
            <v-chip-group v-model="shownTypes" multiple column active-class="type-chip--on" class="type-chips">
              <v-chip v-for="type in typeOptions" :key="type.id" :value="type.id" small outlined filter>
                <span class="dot" :style="{ background: type.color }" />{{ type.label }}&nbsp;<span class="text--secondary">{{ type.count }}</span>
              </v-chip>
            </v-chip-group>
          </div>
          <div class="tool tool--rows">
            <div class="tool__label caption text--secondary">Rows</div>
            <v-btn-toggle :value="groupByColony ? 'colony' : 'job'" mandatory dense @change="setGroupBy">
              <v-btn value="job" small>Jobs</v-btn>
              <v-btn value="colony" small>By colony</v-btn>
            </v-btn-toggle>
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="420">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Production options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">Jobs in the table and the chart</div>
                <v-checkbox v-model="showQueued" dense hide-details>
                  <template #label>
                    <div>
                      <div class="body-2">Queued jobs</div>
                      <div class="caption text--secondary">Industrial projects and research waiting for the job ahead of them.</div>
                    </div>
                  </template>
                </v-checkbox>
                <v-checkbox v-model="showPaused" dense hide-details>
                  <template #label>
                    <div>
                      <div class="body-2">Paused jobs</div>
                      <div class="caption text--secondary">They keep their labs, slipway or share of capacity but make no progress.</div>
                    </div>
                  </template>
                </v-checkbox>
              </v-card>
            </v-menu>
          </div>
        </div>

        <stat-tiles class="mt-1" :tiles="tiles" />

        <v-card class="panel" data-summary="Every job the colonies are building, researching, training or terraforming, with its status and finish time, to spot stalled work and shortages." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Work in progress<provenance-mark rule="production.jobCount" /></span>
              <v-chip v-if="focusId" small close class="ml-3" close-label="Show every colony" @click:close="focusId = null">{{ focusName }}</v-chip>
            </span>
            <v-text-field v-model="search" label="Search" placeholder="Job or colony" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <v-data-table :headers="jobHeaders" :items="visibleJobs" item-key="key" :group-by="groupByColony ? 'colonyName' : []" :custom-sort="sortNullLast" :sort-by.sync="jobTable.sortBy" :sort-desc.sync="jobTable.sortDesc" :items-per-page.sync="jobTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: jobPageSizes }" :no-data-text="jobs.length ? 'No jobs match the filters.' : 'Nothing is being built, researched, trained or terraformed.'">
            <template #[`group.header`]="{ group, items, headers, isOpen, toggle }">
              <td :colspan="headers.length">
                <v-btn icon small :aria-label="isOpen ? `Collapse ${group}` : `Expand ${group}`" @click="toggle"><v-icon small>{{ isOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon></v-btn>
                <span class="font-weight-medium">{{ group }}</span>
                <span class="caption text--secondary ml-2">{{ groupSummary(items) }}</span>
              </td>
            </template>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium"><span class="dot" :style="{ background: typeColors[item.type] }" />{{ item.name }}<page-link v-if="item.TechSystemID" class="ml-1" :to="linkTo.techTree({ tech: item.TechSystemID })" :name="item.name" /></div>
                <div class="caption text--secondary">{{ typeLabels[item.type] }}<span v-if="item.detail"> · {{ item.detail }}</span></div>
                <div v-if="item.note" class="caption warning--text">{{ item.note }}</div>
              </div>
            </template>
            <template #[`item.colonyName`]="{ item }">
              <div class="py-2">
                <div>{{ item.colonyName }}<v-btn v-if="!focusId" icon x-small class="ml-1" title="Show only this colony" aria-label="Show only this colony" @click.stop="focusId = item.PopulationID"><v-icon small>mdi-filter-outline</v-icon></v-btn></div>
                <div class="caption text--secondary">{{ item.place }}</div>
              </div>
            </template>
            <template #[`item.statusSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">
                  <v-icon small :color="STATUS[item.status.id].color" class="mr-1">{{ STATUS[item.status.id].icon }}</v-icon>
                  <router-link v-if="item.status.id === 'short' && item.shortage.mineralId" :to="mineralLink(item.shortage)">{{ item.status.label }}</router-link>
                  <span v-else>{{ item.status.label }}</span>
                </div>
                <div v-if="item.status.note" class="caption text--secondary">{{ item.status.note }}<provenance-mark v-if="item.status.id === 'short'" :result="item.covers" /></div>
                <div v-if="item.shortage && item.status.id !== 'short'" class="caption">
                  <router-link v-if="item.shortage.mineralId" :to="mineralLink(item.shortage)">Short of {{ item.shortage.name }}</router-link>
                  <span v-else>Short of {{ item.shortage.name }}</span>
                  <span class="text--secondary">: the stock covers {{ coverText(item.shortage) }} of {{ units(item.amount) }}</span><provenance-mark :result="item.covers" />
                </div>
                <div v-else-if="item.stockUnknown" class="caption text--secondary">Stock not known<provenance-mark :result="item.covers" /></div>
                <div v-for="text in item.cautions" :key="text" class="caption text--secondary">{{ text }}</div>
              </div>
            </template>
            <template #[`item.rate`]="{ item }">
              <div class="py-2 text-no-wrap">
                <v-tooltip v-if="item.breakdown && item.breakdown.length" bottom max-width="420">
                  <template #activator="{ on, attrs }">
                    <div v-bind="attrs" v-on="on">{{ item.rateText }}<provenance-mark :result="item.rateResult" /></div>
                  </template>
                  <div v-for="line in item.breakdown" :key="line.key" class="d-flex justify-space-between"><span class="mr-4">{{ line.label }}</span><span>{{ line.text }}</span></div>
                </v-tooltip>
                <div v-else>{{ item.rateText }}<provenance-mark :result="item.rateResult" /></div>
                <div class="caption text--secondary">{{ item.rateNote }}</div>
              </div>
            </template>
            <template #[`item.finishSort`]="{ item }">
              <div class="py-2 text-no-wrap">
                <span v-if="item.days === null" class="text--secondary">—<provenance-mark :result="item.finishResult" /></span>
                <span v-else-if="item.days === 0">Done<provenance-mark :result="item.finishResult" /></span>
                <template v-else>
                  <div>{{ item.approx ? '~' : '' }}{{ duration(item.days) }}<provenance-mark :result="item.finishResult" /></div>
                  <div v-if="item.range" class="caption text--secondary">{{ rangeText(item.range) }}</div>
                  <div class="caption text--secondary">{{ dateIn(item.days) }}</div>
                </template>
              </div>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            An industrial project builds cycle by cycle at its share of the colony's construction, ordnance or fighter capacity, taking minerals and fuel from one stock shared by every project at that colony, so a project builds only as far as what is left goes. A project the stock cannot finish has no date until arrivals are entered. Where the order the game serves the colony's projects in would change the outcome, the date is the earliest of the orders tried, with the latest beside it. A queued project starts in the cycle after a project of the same kind at that colony finishes, in queue order, if the share left is enough for it. Paused jobs keep their share and build nothing. A colony with an input not known, or a production type the forecast does not cover, keeps the older check of each project against the whole stock. ~ marks estimates. A dash in Finishes means the job has no date, because it is paused, has nothing to work with, never starts or never finishes, or because an input is not known; its mark says which.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Stock assumed to reach a colony on a given day, entered by hand to see which of its projects it releases; none is read from the save and none is shipped automatically." elevation="1">
          <div class="panel-head">
            <span>Assumed arrivals</span>
            <v-btn small text :disabled="!arrivals.length" @click="arrivals = []">Remove all</v-btn>
          </div>
          <div class="arrival-form">
            <v-select v-model="arrivalForm.populationId" :items="arrivalColonies" item-text="colonyName" item-value="PopulationID" label="Colony" dense outlined hide-details style="max-width: 240px" />
            <v-select v-model="arrivalForm.resource" :items="arrivalResources" label="Stock" dense outlined hide-details style="max-width: 160px" />
            <v-text-field v-model="arrivalForm.day" label="Days from now" type="number" min="0" dense outlined hide-details style="max-width: 140px" />
            <v-text-field v-model="arrivalForm.quantity" :label="arrivalForm.resource === 'fuel' ? 'Litres' : 'Tonnes'" type="number" min="0" dense outlined hide-details style="max-width: 140px" />
            <v-text-field v-model="arrivalForm.source" label="Source" placeholder="Freighter or colony" dense outlined hide-details style="max-width: 200px" />
            <v-btn small color="primary" :disabled="!arrivalValid" @click="addArrival">Add arrival</v-btn>
          </div>
          <p v-if="arrivalHint" class="caption error--text mb-2">{{ arrivalHint }}</p>
          <v-data-table v-if="arrivalRows.length" :headers="arrivalHeaders" :items="arrivalRows" item-key="id" dense hide-default-footer :items-per-page="-1">
            <template #[`item.actions`]="{ item }">
              <v-btn icon small aria-label="Remove arrival" @click="removeArrival(item.id)"><v-icon small>mdi-close</v-icon></v-btn>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            An arrival adds its quantity to the colony's stock from the first cycle that ends on or after its day. These are assumptions, never observed stock: removing them restores the colony's own stock, and nothing is kept when the race changes.
          </div>
        </v-card>

        <v-row>
          <v-col cols="12" xl="5">
            <v-card class="panel" data-summary="How many jobs finish in each period ahead, by kind, to plan around coming completions." elevation="1">
              <div class="panel-head">
                <span>Completions<provenance-mark rule="production.timeline" /></span>
                <v-btn-toggle v-model="horizon" mandatory dense>
                  <v-btn v-for="option in horizons" :key="option.years" :value="option.years" small>{{ option.label }}</v-btn>
                </v-btn-toggle>
              </div>
              <div class="panel-body">
                <div v-if="timeline.total" class="legend mb-2">
                  <span v-for="series in timeline.series" :key="series.id" class="legend-item"><series-key :color="series.color" />{{ series.label }}</span>
                </div>
                <chart-canvas v-if="timeline.total" type="bar" :data="timelineChart" :options="timelineOptions" :height="240" :label="`Jobs finishing per ${timeline.option.unit} over the next ${timeline.option.label}, by kind`" />
                <div v-else class="caption text--secondary">None of the jobs shown finishes in the next {{ timeline.option.label }}.</div>
              </div>
              <div class="panel-foot caption text--secondary">
                The jobs in the table, per {{ timeline.option.unit }} they finish in. Paused jobs, jobs that never start and jobs the colony's stock cannot finish are left out<span v-if="timeline.later">, and {{ timeline.later }} {{ timeline.later === 1 ? 'finishes' : 'finish' }} later</span>. Short of minerals counts only jobs at a colony the cycle forecast cannot cover, at the time they would finish if the minerals arrive.<span v-if="timeline.skipped.unknown"> {{ timeline.skipped.unknown }} {{ timeline.skipped.unknown === 1 ? 'job has' : 'jobs have' }} no finish time known and {{ timeline.skipped.unknown === 1 ? 'is' : 'are' }} not counted<provenance-mark :result="timeline.result" />.</span><span v-else><provenance-mark :result="timeline.result" /></span>
              </div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="7">
            <v-card class="panel" data-summary="The construction, ordnance, fighter, training, research and slipway capacity each colony leaves unused, to find where more work can start." elevation="1">
              <div class="panel-head">
                <span class="d-flex align-center">
                  <span>Idle capacity by colony<provenance-mark rule="production.capacityFree" /></span>
                  <v-chip v-if="focusId" small close class="ml-3" close-label="Show every colony" @click:close="focusId = null">{{ focusName }}</v-chip>
                </span>
                <v-chip small>{{ capacityRows.length }} {{ capacityRows.length === 1 ? 'colony' : 'colonies' }}</v-chip>
              </div>
              <v-data-table :headers="capacityHeaders" :items="capacityRows" item-key="PopulationID" :custom-sort="sortNullLast" :sort-by.sync="capacityTable.sortBy" :sort-desc.sync="capacityTable.sortDesc" :items-per-page.sync="capacityTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: capacityPageSizes }" :no-data-text="focusId ? 'This colony has no idle capacity.' : 'Every colony is using all its capacity.'">
                <template #[`item.colonyName`]="{ item }">
                  <div class="py-2">
                    <div class="font-weight-medium">
                      {{ item.colonyName }}<v-btn v-if="!focusId" icon x-small class="ml-1" title="Show only this colony" aria-label="Show only this colony" @click.stop="focusId = item.PopulationID"><v-icon small>mdi-filter-outline</v-icon></v-btn>
                      <span class="text-no-wrap">
                        <page-link :to="linkTo.colonyOutlook(item.PopulationID)" :name="item.colonyName" />
                        <page-link v-if="item.body" :to="linkTo.planner({ bodies: [item.body] })" :name="item.place" />
                        <page-link :to="linkTo.commanders({ colony: item.PopulationID })" :name="item.colonyName" />
                      </span>
                    </div>
                    <div class="caption text--secondary">{{ item.place }}</div>
                  </div>
                </template>
                <template v-for="column in capacityColumns" #[`item.${column.key}Free`]="{ item }">
                  <div :key="column.key" class="py-2 text-no-wrap">
                    <span v-if="item[`${column.key}Free`] === null" class="text--secondary">—<provenance-mark :result="item.results[column.key].free" /></span>
                    <span v-else-if="!item[`${column.key}Total`]" class="text--disabled">none<provenance-mark :result="item.results[column.key].total" /></span>
                    <template v-else>
                      <div :class="{ 'text--secondary': item[`${column.key}Free`] < IDLE_MINIMUM }">{{ column.bp ? bp(item[`${column.key}Free`]) : count(item[`${column.key}Free`]) }}<provenance-mark :result="item.results[column.key].free" /></div>
                      <div class="caption text--secondary">of {{ column.bp ? bp(item[`${column.key}Total`]) : count(item[`${column.key}Total`]) }}</div>
                    </template>
                  </div>
                </template>
              </v-data-table>
              <div class="panel-foot caption text--secondary">
                What each colony leaves idle, of its total: build points a year for construction, ordnance, fighters and ground training (GFCCs), and research facilities and slipways not assigned to a project or task. A paused job's share counts as idle. Colonies using everything they have are left out. None means the colony has none of that capacity; a dash means the figure is not known, and its mark names what is missing.
              </div>
            </v-card>
          </v-col>
        </v-row>

        <component-calculator :sources="componentSources" :colonies="componentColonies" :industry="industry" :arrivals="arrivals" :npr="RaceNPR" />
        <procurement-manifest :sources="componentSources" :procurement="procurementSources" />
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import ComponentCalculator from '../components/production/ComponentCalculator.vue'
import ProcurementManifest from '../components/production/ProcurementManifest.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import queueForecast from '../mixins/queue-forecast'
import { activeAppearance } from '../utilities/appearance'
import { gameTime, populationName } from '../utilities/aurora'
import { sourcesOf } from '../utilities/component-calc'
import { fitsDouble } from '../utilities/decimal'
import { bodyReference, linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { UNKNOWN_TEXT, isKnownNumber } from '../utilities/math'
import { MINERALS } from '../utilities/minerals'
import { loadNavalAdmins } from '../utilities/naval-admins'
import { categoryOf, completionBins, finishDays, flagOf, freeCapacity, idleFacilities, industryFigures, industryUsage, jobStatus, prepareForecast, queuedResearch, researchRate, shipRate, shipyardFinish, shipyardUpgradeRate, shortageOf, sortNullLast, terraformFinish, totalOf, trainingCapacity, trainingRate, trainingUsage, undecidedStarts, unknownKindCapacity } from '../utilities/production'
import { describeResult, describeRule, isAvailable, unavailable, valueOrNull } from '../utilities/provenance'
import { NO_TERRAFORM_SOURCES, hasTerraformers, loadTerraformSources, terraformBreakdown } from '../utilities/terraform-capacity'
import { NO_PROCUREMENT_SOURCES, loadProcurementSources } from '../utilities/procurement-data'

const INPUT_LABELS = {
  populationProductionModifiers: 'the colonies\' production rates',
  colonyFacilities: 'the colonies\' facilities',
  researches: 'the research projects',
  industry: 'the industrial projects',
  ships: 'the shipyard tasks',
  shipyards: 'the shipyard activities',
  trainings: 'the ground unit training',
  terraforms: 'the terraforming',
  terraformSources: 'the terraforming capacity',
  navalAdmins: 'the naval admin commands',
  componentSources: 'the ship classes\' components and the colonies\' component stock',
  procurementSources: 'the shipyard tasks, the queued component projects and the colonies',
}

const SECONDS_PER_DAY = 86400

// The commander bonus ID of the research rate: a figure that rests on it is not given when the save's lookup row for it is not confirmed (`blockedBonuses`). The terraforming bonus is gated inside `loadTerraformSources`.
const RESEARCH_BONUS = 3

// Kinds of work, each with a fixed slot of the chart palette; short of minerals has the last.
const TYPES = [
  { id: 'research', label: 'Research', slot: 0 },
  { id: 'industry', label: 'Industry', slot: 1 },
  { id: 'ship', label: 'Ships', slot: 2 },
  { id: 'shipyard', label: 'Shipyards', slot: 6 },
  { id: 'training', label: 'Ground training', slot: 3 },
  { id: 'terraforming', label: 'Terraforming', slot: 4 },
]
const TYPE_IDS = TYPES.map((type) => type.id)

// A job's status, in the order the Status column sorts by.
const STATUS = {
  running: { order: 0, icon: 'mdi-play-circle-outline', color: 'success' },
  short: { order: 1, icon: 'mdi-alert-circle-outline', color: 'error' },
  queued: { order: 2, icon: 'mdi-timer-sand', color: undefined },
  paused: { order: 3, icon: 'mdi-pause-circle-outline', color: 'warning' },
  stalled: { order: 4, icon: 'mdi-cancel', color: 'error' },
  unknown: { order: 5, icon: 'mdi-help-circle-outline', color: undefined },
  forecasting: { order: 6, icon: 'mdi-progress-clock', color: undefined },
}

// The completions chart's spans: a year by month, five years by quarter, twenty by year.
const HORIZONS = [
  { years: 1, label: '1 y', bins: 12, unit: 'month', format: 'YYYY-MM' },
  { years: 5, label: '5 y', bins: 20, unit: 'quarter', format: 'YYYY-MM' },
  { years: 20, label: '20 y', bins: 20, unit: 'year', format: 'YYYY' },
]

const JOB_PAGE_SIZES = [15, 30, -1]
const CAPACITY_PAGE_SIZES = [10, 25, -1]

const CAPACITY_KINDS = ['construction', 'ordnance', 'fighter']
const ARRIVAL_RESOURCES = [...MINERALS.map((mineral) => mineral.name), 'fuel']

const ARRIVAL_HEADERS = [
  { text: 'Colony', value: 'colonyName' },
  { text: 'Stock', value: 'resourceText' },
  { text: 'Days from now', value: 'day', align: 'end' },
  { text: 'Amount', value: 'quantityText', align: 'end', sortable: false },
  { text: 'Source', value: 'source' },
  { text: '', value: 'actions', align: 'end', sortable: false },
]

const PRODUCTION_TYPES = {
  0: 'Construction',
  1: 'Ordnance',
  2: 'Fighter',
  3: 'Component',
  4: 'Space station',
}

const SHIPYARD_TASK_TYPES = {
  0: 'Construction',
  1: 'Repair',
  2: 'Refit',
  3: 'Scrap',
  4: 'Auto refit',
}

const SHIPYARD_UPGRADE_TYPES = {
  1: 'Add slipway',
  2: 'Add 500 ton capacity',
  3: 'Add 1,000 ton capacity',
  4: 'Add 2,000 ton capacity',
  5: 'Add 5,000 ton capacity',
  6: 'Add 10,000 ton capacity',
  7: 'Retool',
  8: 'Continual capacity upgrade',
  9: 'Spacemaster modification',
}

// Idle capacity columns; `bp` ones are build points a year, the others counts.
const CAPACITY_COLUMNS = [
  { key: 'construction', text: 'Construction', bp: true },
  { key: 'ordnance', text: 'Ordnance', bp: true },
  { key: 'fighter', text: 'Fighters', bp: true },
  { key: 'training', text: 'Ground training', bp: true },
  { key: 'research', text: 'Research labs', bp: false },
  { key: 'slipways', text: 'Slipways', bp: false },
]
// Less than this left over reads as nothing (it rounds to 0).
const IDLE_MINIMUM = 0.5

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'ProductionPage',
  components: { ChartCanvas, ComponentCalculator, LoadState, PageLink, ProcurementManifest, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    queueForecast,
    persistedView({
      shownTypes: { key: 'productionTypes', default: TYPE_IDS, scope: 'race', normalise: (types) => (Array.isArray(types) ? types.filter((type) => TYPE_IDS.includes(type)) : undefined) },
      groupByColony: { key: 'productionGroupByColony', default: false, scope: 'race' },
      showQueued: { key: 'productionShowQueued', default: true, scope: 'race' },
      showPaused: { key: 'productionShowPaused', default: true, scope: 'race' },
      horizon: { key: 'productionHorizon', default: 5, scope: 'race' },
      search: { key: 'productionSearch', default: '', scope: 'race' },
      jobTable: tableView('productionJobsTable', { sortBy: ['finishSort'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: JOB_PAGE_SIZES }),
      capacityTable: tableView('productionCapacityTable', { sortBy: ['constructionFree'], sortDesc: [true], itemsPerPage: 10, itemsPerPageOptions: CAPACITY_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      focusId: null,
      arrivals: [],
      arrivalCount: 0,
      arrivalForm: { populationId: null, resource: 'Duranium', day: null, quantity: null, source: '' },
      arrivalResources: ARRIVAL_RESOURCES,
      arrivalHeaders: ARRIVAL_HEADERS,
      linkTo,
      horizons: HORIZONS,
      jobPageSizes: JOB_PAGE_SIZES,
      capacityPageSizes: CAPACITY_PAGE_SIZES,
      capacityColumns: CAPACITY_COLUMNS,
      STATUS,
      sortNullLast,
      IDLE_MINIMUM,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'StartYear', 'GameTime']),
    ...mapState(['RaceNPR']),

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    typeColors() {
      return Object.fromEntries(TYPES.map((type) => [type.id, this.theme.categorical[type.slot]]))
    },

    typeLabels() {
      return Object.fromEntries(TYPES.map((type) => [type.id, type.label]))
    },

    activeOptionCount() {
      return [!this.showQueued, !this.showPaused].filter(Boolean).length
    },

    // The colonies with an industrial project, the ones an arrival can be entered for.
    arrivalColonies() {
      return [...new Set(this.industry.map((project) => project.PopulationID))].map((id) => ({ PopulationID: id, colonyName: this.colony(id, '').colonyName })).sort((a, b) => a.colonyName.localeCompare(b.colonyName))
    },

    arrivalRows() {
      return this.arrivals.map((arrival) => ({ ...arrival, colonyName: this.colony(arrival.PopulationID, '').colonyName, resourceText: arrival.resource === 'fuel' ? 'Fuel' : arrival.resource, quantityText: `${this.count(arrival.quantity, 0)} ${arrival.resource === 'fuel' ? 'litres' : 't'}` }))
    },

    arrivalValid() {
      const { populationId, resource, day, quantity } = this.arrivalForm

      return populationId !== null && ARRIVAL_RESOURCES.includes(resource) && day !== null && day !== '' && Number.isFinite(Number(day)) && Number(day) >= 0 && Number.isFinite(Number(quantity)) && Number(quantity) > 0 && fitsDouble(Number(quantity))
    },

    // Why a quantity typed cannot be added: more than the game's decimal type holds, which no forecast can carry.
    arrivalHint() {
      const { quantity } = this.arrivalForm

      return quantity !== null && quantity !== '' && Number.isFinite(Number(quantity)) && Number(quantity) > 0 && !fitsDouble(Number(quantity)) ? 'That quantity is more than the game\'s decimal type holds (about 7.9 × 10^28); enter a smaller quantity' : ''
    },

    // Each colony's industrial projects made ready for the cycle forecast: { [PopulationID]: { gaps } or the colony ready to run }. Nothing is run here.
    industryPlans() {
      const colonies = {}

      this.industry.forEach((project) => (colonies[project.PopulationID] = colonies[project.PopulationID] || []).push(project))

      return Object.fromEntries(Object.entries(colonies).map(([populationId, projects]) => {
        const capacities = Object.fromEntries(CAPACITY_KINDS.map((kind) => [kind, this.populationCapacityResult(Number(populationId), kind)]))

        return [populationId, prepareForecast({ projects, capacities, modifiers: this.populationProductionModifiers[populationId], arrivals: this.arrivals.filter((arrival) => arrival.PopulationID === Number(populationId)), npr: this.RaceNPR })]
      }))
    },

    // The colonies that can build components, with the capacity of each: construction capacity that is known and none is left out; one whose capacity is not known stays, to be reported as such.
    componentColonies() {
      return Object.keys(this.populationProductionModifiers).map((key) => {
        const id = Number(key)
        const capacities = Object.fromEntries(CAPACITY_KINDS.map((kind) => [kind, this.populationCapacityResult(id, kind)]))

        return { id, name: this.colony(id, '').colonyName, capacities, modifiers: this.populationProductionModifiers[id] }
      }).filter((colony) => !isAvailable(colony.capacities.construction) || colony.capacities.construction.value > 0).sort((a, b) => a.name.localeCompare(b.name))
    },

    facilitiesByColony() {
      return Object.fromEntries(this.colonyFacilities.map((colony) => [colony.PopulationID, colony]))
    },

    // Each research project, then its queue: a queued tech starts when the one ahead finishes, with the same labs.
    researchJobs() {
      const { projects, queues } = this.researches

      return projects.flatMap((project) => {
        const modifiers = this.populationProductionModifiers[project.PopulationID]
        const paused = flagOf(project.Paused)
        const rate = researchRate(modifiers, project)
        const finish = finishDays({ rule: 'production.researchFinish', rate, remaining: project.RemainingProduction, remainingName: 'the project\'s remaining research points', paused })
        const labs = `${this.count(project.Facilities)} ${project.Facilities === 1 ? 'lab' : 'labs'}`
        let ahead = finish

        const jobs = [this.job({
          key: `research-${project.ID}`,
          type: 'research',
          PopulationID: project.PopulationID,
          TechSystemID: project.TechSystemID,
          name: project.Name,
          note: this.scientistNote(project, project.ProjectField),
          rate,
          finish,
          rateText: this.rateText(rate, this.count, 'RP/yr'),
          rateNote: labs,
          status: jobStatus({ paused, rate, stalled: { label: 'No labs', note: 'No research facilities are assigned' } }),
        })]

        queues.filter((queue) => queue.CurrentProjectID === project.ID).sort((a, b) => a.ResearchOrder - b.ResearchOrder).forEach((queue, index) => {
          const queueRate = researchRate(modifiers, queuedResearch(project, queue))
          const queueFinish = finishDays({ rule: 'production.researchFinish', rate: queueRate, remaining: queue.DevelopCost, remainingName: 'the tech\'s development cost', ahead })
          const start = isAvailable(ahead.result) ? this.duration(ahead.result.value) : null
          const startNote = start !== null ? `Starts in ${start}` : ahead.idle ? (paused ? 'Never starts: the project ahead is paused' : 'Never starts: the project ahead makes no progress') : `Start not known: missing ${ahead.result.inputs.missing.join(', ')}`

          jobs.push(this.job({
            key: `research-${project.ID}-${queue.ResearchOrder}`,
            type: 'research',
            PopulationID: project.PopulationID,
            TechSystemID: queue.TechSystemID,
            name: queue.Name,
            note: this.scientistNote(project, queue.ProjectField),
            rate: queueRate,
            finish: queueFinish,
            rateText: this.rateText(queueRate, this.count, 'RP/yr'),
            rateNote: labs,
            queued: true,
            status: { id: 'queued', label: `Queued #${index + 1}`, note: startNote },
          }))

          ahead = queueFinish
        })

        return jobs
      })
    },

    industryJobs() {
      const groups = {}
      const undecided = undecidedStarts(this.industry)

      this.industry.forEach((project) => {
        const key = `${project.PopulationID}-${categoryOf(project.ProductionType)}`

        ;(groups[key] = groups[key] || []).push(project)
      })

      // A colony the save gives every input of has its cycles run forward on one stock its projects share, in the run the page keeps (`startForecast`); until that run has ended the colony is forecasting. A colony the save lacks an input of, or whose quantity the decimal type cannot hold, or whose run failed, keeps the schedule of each capacity on its own, each project against the whole stock.
      const forecasts = {}
      const gaps = {}
      const pending = new Set()
      const run = this.forecastCurrent

      Object.entries(this.industryPlans).forEach(([populationId, prepared]) => {
        const outcome = prepared.gaps ? prepared : run ? (run.error ? { gaps: [`the forecast of the colony failed (${run.error})`] } : (run.colonies && run.colonies[populationId])) : null

        if (!outcome) {
          pending.add(Number(populationId))
        }

        forecasts[populationId] = outcome && !outcome.gaps ? Object.fromEntries(outcome.figures.map((figure) => [figure.forecast.ID, figure])) : null
        gaps[populationId] = outcome && outcome.gaps ? outcome.gaps : null
      })

      return Object.values(groups).flatMap((group) => {
        const { PopulationID, ProductionType } = group[0]
        const category = categoryOf(ProductionType)
        const capacity = category === 'unknown' ? unknownKindCapacity() : this.populationCapacityResult(PopulationID, category)
        const forecasting = pending.has(PopulationID)
        const figures = forecasts[PopulationID] ? null : industryFigures(group, capacity, undecided[PopulationID])
        const anyBuilding = isAvailable(capacity) && capacity.value > 0 && group.some((project) => !project.Queue && !project.Paused)
        const pausedAhead = group.some((project) => !project.Queue && project.Paused)

        return group.map((project, index) => {
          const planned = forecasts[PopulationID] ? forecasts[PopulationID][project.ID] : null
          const { rate, start } = planned || figures[index]
          // A spied NPR builds from its capital's stock.
          const { shortage, covers, unknown } = planned ? { shortage: planned.shortage, covers: planned.covers, unknown: [] } : (this.RaceNPR || forecasting) ? { shortage: null, covers: null, unknown: [] } : shortageOf(project)
          let { finish } = planned || figures[index]
          const paused = flagOf(project.Paused)
          const queued = Number.isFinite(project.Queue) && project.Queue > 0
          let status

          if (forecasting && (queued || paused !== true)) {
            status = { id: 'forecasting', label: 'Forecasting', note: 'The colony\'s production cycles are being run forward; the date follows' }
            finish = { result: unavailable({ rule: 'production.industryFinish', missing: ['the colony\'s production cycle forecast, which is still running'] }), idle: false }
          } else if (queued) {
            status = {
              id: 'queued',
              label: `Queued #${project.Queue}`,
              note: start !== null ? `Starts in ${this.duration(start)}${planned && planned.startRange ? this.startRangeText(planned.startRange) : ''}${paused ? ', paused' : ''}` : planned && planned.forecast.outcome === 'unresolved' ? 'Start not known: the project ahead of it cannot finish exactly (a part of a unit finer than a build is left), so whether it frees its share is not known' : finish.idle ? `Never starts: ${!anyBuilding ? 'nothing ahead of it is building' : pausedAhead ? 'a paused project keeps the share it needs' : 'not enough share frees up'}` : `Start not known: missing ${finish.result.inputs.missing.join(', ')}`,
            }
          } else if (paused === true) {
            status = { id: 'paused', label: 'Paused' }
          } else if (!Number.isFinite(project.Queue) || paused === null) {
            status = { id: 'unknown', label: 'Not known', note: 'Whether the project is queued or paused is not in the save' }
          } else if (!isAvailable(rate)) {
            status = { id: 'unknown', label: 'Not known', note: `Missing ${rate.inputs.missing.join(', ')}` }
          } else if (!(rate.value > 0)) {
            status = { id: 'stalled', label: 'No capacity', note: `The colony has no ${category} capacity` }
          } else if (shortage) {
            const supplied = planned ? null : valueOrNull(finish.result)

            status = {
              id: 'short',
              label: `Short of ${shortage.name}`,
              note: planned ? this.plannedShortNote(project, planned) : `The stock covers ${this.units(shortage.covered)} of ${this.units(project.Amount)}${Number.isFinite(project.ProdPerUnit) ? `, about ${this.duration((shortage.covered * project.ProdPerUnit / rate.value) * 365)}` : ''}${supplied !== null ? `, and with all the stock it needs it would finish in ${this.duration(supplied)}` : ''}`,
            }

            if (!planned) {
              finish = { result: unavailable({ rule: 'production.industryFinish', missing: [`${shortage.name} in the colony's stock (what it holds cannot finish the project)`], present: rate.inputs.present }), idle: true }
            }
          } else {
            status = { id: 'running', label: 'Running' }
          }

          return this.job({
            key: `industry-${project.ID}`,
            type: 'industry',
            PopulationID,
            name: `${this.units(project.Amount)} × ${project.Name}`,
            detail: PRODUCTION_TYPES[project.ProductionType],
            rate,
            finish,
            rateText: this.rateText(rate, this.bp, 'BP/yr'),
            rateNote: category === 'unknown' ? 'Production type not known' : isKnownNumber(project.Percentage) ? `${this.count(project.Percentage, 1)}% of ${category}` : `Share of ${category} not known`,
            amount: project.Amount,
            queued,
            shortage,
            covers,
            stockUnknown: unknown.length > 0 && !shortage,
            approx: Boolean(planned && (planned.range || planned.startRange)),
            range: planned ? planned.range : null,
            cautions: planned ? this.forecastCautions(project, planned) : forecasting ? [] : this.fallbackCautions(PopulationID, gaps[PopulationID]),
            status,
          })
        })
      })
    },

    shipJobs() {
      return this.ships.map((ship) => {
        const modifiers = this.populationProductionModifiers[ship.PopulationID]
        const paused = flagOf(ship.Paused)
        const rate = shipRate(modifiers, ship)
        const finish = finishDays({ rule: 'production.shipFinish', rate, remaining: ship.RemainingProduction, remainingName: 'the task\'s remaining build points', paused })

        return this.job({
          key: `ship-${ship.ID}`,
          type: 'ship',
          PopulationID: ship.PopulationID,
          name: ship.Name,
          detail: [SHIPYARD_TASK_TYPES[ship.ShipyardTaskType], ship.ClassName].filter(Boolean).join(' · '),
          rate,
          finish,
          rateText: this.rateText(rate, this.bp, 'BP/yr'),
          rateNote: ship.ShipyardName,
          status: jobStatus({ paused, rate, stalled: { label: 'No capacity' } }),
        })
      })
    },

    shipyardJobs() {
      return this.shipyards.map((shipyard) => {
        const modifiers = this.populationProductionModifiers[shipyard.PopulationID]
        const rate = shipyardUpgradeRate(modifiers, shipyard)
        const finish = shipyardFinish(modifiers, shipyard, rate)
        const target = shipyard.UpgradeTaskType === 7 && shipyard.ClassName ? ` to ${shipyard.ClassName}` : shipyard.UpgradeTaskType === 8 ? ` to ${this.count(shipyard.CapacityTarget)} t` : ''

        return this.job({
          key: `shipyard-${shipyard.ID}`,
          type: 'shipyard',
          PopulationID: shipyard.PopulationID,
          name: shipyard.ShipyardName,
          detail: `${SHIPYARD_UPGRADE_TYPES[shipyard.UpgradeTaskType] || 'Activity'}${target}`,
          rate,
          finish,
          rateText: this.rateText(rate, this.bp, 'BP/yr'),
          rateNote: 'Modification rate',
          approx: shipyard.UpgradeTaskType === 8,
          status: jobStatus({ paused: flagOf(shipyard.Paused), stalled: { label: 'No capacity' }, finish }),
        })
      })
    },

    // Each task gets its percentage of the colony's ground formation construction capacity.
    trainingJobs() {
      return this.trainings.map((training) => {
        const gfccs = this.gfccCount(training.PopulationID)
        const capacity = trainingCapacity(this.populationProductionModifiers[training.PopulationID], this.facilitiesByColony[training.PopulationID])
        const rate = trainingRate(capacity, training)
        const finish = finishDays({ rule: 'production.trainingFinish', rate, remaining: training.RemainingProduction, remainingName: 'the task\'s remaining build points' })

        return this.job({
          key: `training-${training.ID}`,
          type: 'training',
          PopulationID: training.PopulationID,
          name: training.Name,
          rate,
          finish,
          rateText: this.rateText(rate, this.bp, 'BP/yr'),
          rateNote: `${this.count(training.TaskPercentage, 1)}% of ${this.count(gfccs)} ${gfccs === 1 ? 'GFCC' : 'GFCCs'}`,
          status: jobStatus({ paused: false, rate, stalled: { label: 'No GFCC', note: 'The colony has no ground force construction complex' } }),
        })
      })
    },

    terraformingJobs() {
      const { raceRate, speed, colonies } = this.terraformSources

      return this.terraforms.filter((terraform) => !(terraform.TerraformStatus && terraform.MaxAtm === 0) && colonies[terraform.PopulationID] && hasTerraformers(colonies[terraform.PopulationID])).map((terraform) => {
        const modifiers = this.populationProductionModifiers[terraform.PopulationID]
        const breakdown = terraformBreakdown({ raceRate, speed, source: colonies[terraform.PopulationID], admins: this.navalAdmins })
        const rate = breakdown.rate
        const finish = terraformFinish(modifiers, terraform, rate)
        const waterOnSurface = terraform.GasName === 'Water Vapour' && terraform.HydroID === 3
        const adding = flagOf(terraform.TerraformStatus)
        const status = jobStatus({ paused: false, rate, stalled: { label: 'No capacity' } })

        return this.job({
          key: `terraforming-${terraform.PopulationID}`,
          type: 'terraforming',
          PopulationID: terraform.PopulationID,
          name: `${terraform.GasName || 'Unknown gas'} to ${isKnownNumber(terraform.MaxAtm) ? terraform.MaxAtm : UNKNOWN_TEXT} atm`,
          detail: waterOnSurface ? `Hydrographic extent ${this.count(terraform.HydroExt, 1)}%` : '',
          rate,
          finish,
          rateText: this.rateText(rate, (value) => this.count(value, 4), 'atm/yr'),
          rateNote: adding === null ? 'Adding or removing not known' : adding ? 'Adding' : 'Removing',
          approx: true,
          breakdown: breakdown.lines,
          status: status.id === 'running' && finish.note ? { ...status, note: finish.note } : status,
        })
      })
    },

    jobs() {
      return [
        ...this.researchJobs,
        ...this.industryJobs,
        ...this.shipJobs,
        ...this.shipyardJobs,
        ...this.trainingJobs,
        ...this.terraformingJobs,
      ]
    },

    // The jobs the Options menu lets through, before the type filter and search.
    optionJobs() {
      return this.jobs.filter((job) => (this.showQueued || !job.queued) && (this.showPaused || job.status.id !== 'paused'))
    },

    typeOptions() {
      return TYPES.map((type) => ({
        ...type,
        color: this.typeColors[type.id],
        count: this.optionJobs.filter((job) => job.type === type.id).length,
      }))
    },

    focusName() {
      return this.colony(this.focusId, '').colonyName
    },

    linkQuery() {
      return linkTo.production(this.focusId).query
    },

    linkLabel() {
      return this.focusId ? this.focusName : ''
    },

    visibleJobs() {
      const search = (this.search || '').trim().toLowerCase()

      return this.optionJobs.filter((job) => (!this.focusId || job.PopulationID === this.focusId) && this.shownTypes.includes(job.type) && (!search || job.searchText.includes(search)))
    },

    jobHeaders() {
      return [
        { text: 'Job', value: 'name' },
        { text: 'Colony', value: 'colonyName' },
        { text: 'Status', value: 'statusSort' },
        { text: 'Rate', value: 'rate', align: 'end', sortable: false },
        { text: 'Finishes', value: 'finishSort', align: 'end' },
      ]
    },

    // Idle capacity per colony with any: the share of each industrial capacity no running project uses, the share of GFCC capacity no training task uses, labs no project uses and slipways without a task (a yard's Slipways less its tasks, as the game's shipyard list counts them). Each figure is a provenance result, kept in `results`; a figure not known is null and the row stays in the table.
    colonyCapacity() {
      const usage = industryUsage(this.industry)
      const trainingShares = trainingUsage(this.trainings)

      return this.colonyFacilities.map((colony) => {
        const id = colony.PopulationID

        const results = {
          construction: freeCapacity(this.populationCapacityResult(id, 'construction'), usage[`${id}-construction`]),
          ordnance: freeCapacity(this.populationCapacityResult(id, 'ordnance'), usage[`${id}-ordnance`]),
          fighter: freeCapacity(this.populationCapacityResult(id, 'fighter'), usage[`${id}-fighter`]),
          training: freeCapacity(trainingCapacity(this.populationProductionModifiers[id], colony), trainingShares[id]),
          research: idleFacilities(colony, 'research'),
          slipways: idleFacilities(colony, 'slipways'),
        }

        const row = { PopulationID: id, Shipyards: colony.Shipyards, results, ...this.colony(id, colony.PopName) }

        Object.entries(results).forEach(([key, { total, free }]) => {
          row[`${key}Total`] = valueOrNull(total)
          row[`${key}Free`] = valueOrNull(free)
        })

        return row
      })
    },

    capacityRows() {
      return this.colonyCapacity.filter((row) => (!this.focusId || row.PopulationID === this.focusId) && CAPACITY_COLUMNS.some((column) => row[`${column.key}Free`] === null || row[`${column.key}Free`] >= IDLE_MINIMUM))
    },

    capacityHeaders() {
      return [
        { text: 'Colony', value: 'colonyName' },
        ...CAPACITY_COLUMNS.map((column) => ({ text: column.bp ? `${column.text} BP/yr` : column.text, value: `${column.key}Free`, align: 'end' })),
      ]
    },

    tiles() {
      const active = this.jobs.filter((job) => !job.queued)
      const paused = active.filter((job) => job.status.id === 'paused').length
      const queued = this.jobs.length - active.length
      const short = this.jobs.filter((job) => job.shortage)
      const notKnown = this.jobs.filter((job) => job.status.id === 'unknown').length
      const forecasting = this.jobs.filter((job) => job.status.id === 'forecasting').length
      const shortLabel = short.some((job) => !job.shortage.mineralId) ? 'short of minerals or fuel' : 'short of minerals'
      const jobNotes = [paused && `${paused} paused`, queued && `${queued} queued`, short.length && `${short.length} ${shortLabel}`, notKnown && `${notKnown} not known`, forecasting && `${forecasting} being forecast`].filter(Boolean)

      const rows = this.colonyCapacity
      const coloniesWith = (key) => rows.filter((row) => row[`${key}Free`] >= IDLE_MINIMUM).length
      const at = (colonies, none) => (colonies ? `At ${colonies} ${colonies === 1 ? 'colony' : 'colonies'}` : none)

      // The idle and the installed figure of one capacity summed over the colonies that have one, with how many do not.
      const sums = (key, freeRule, totalRule) => ({
        free: totalOf(freeRule, rows.map((row) => row.results[key].free), 'colonies'),
        total: totalOf(totalRule, rows.map((row) => row.results[key].total), 'colonies'),
      })

      const note = (key, sum, ifAny, none) => {
        const total = valueOrNull(sum.total.result)
        const lead = total ? at(coloniesWith(key), ifAny) : sum.total.unknown ? 'No capacity known' : none

        return sum.free.unknown ? `${lead} · ${sum.free.unknown} of ${rows.length} colonies not counted` : lead
      }

      const construction = sums('construction', 'production.capacityFree', 'production.populationCapacity')
      const research = sums('research', 'production.researchLabs', 'production.researchLabs')
      const slipways = sums('slipways', 'production.slipways', 'production.slipways')

      return [
        {
          label: 'Jobs',
          value: this.count(active.length),
          note: jobNotes.length ? jobNotes.join(', ') : active.length ? 'All running' : 'Nothing under way',
          title: describeRule('production.jobCount'),
        },
        {
          label: 'Construction free',
          value: isAvailable(construction.free.result) ? `${this.bp(construction.free.result.value)} BP/yr` : UNKNOWN_TEXT,
          note: note('construction', construction, 'Every colony is building', 'No construction capacity'),
          title: describeResult(construction.free.result),
        },
        {
          label: 'Research labs idle',
          value: isAvailable(research.free.result) && isAvailable(research.total.result) ? `${this.count(research.free.result.value)} of ${this.count(research.total.result.value)}` : UNKNOWN_TEXT,
          note: note('research', research, 'All researching', 'No research facilities'),
          title: describeResult(research.free.result),
        },
        {
          label: 'Slipways idle',
          value: isAvailable(slipways.free.result) && isAvailable(slipways.total.result) ? `${this.count(slipways.free.result.value)} of ${this.count(slipways.total.result.value)}` : UNKNOWN_TEXT,
          note: note('slipways', slipways, 'All building', 'No shipyards'),
          title: describeResult(slipways.free.result),
        },
      ]
    },

    timeline() {
      const option = HORIZONS.find((horizon) => horizon.years === this.horizon) || HORIZONS[0]
      const { counts, later, total, binDays, skipped, result } = completionBins(this.visibleJobs, option, TYPE_IDS)

      const series = [
        ...TYPES.map((type) => ({ id: type.id, label: type.label, color: this.typeColors[type.id] })),
        { id: 'short', label: 'Short of minerals', color: this.appearance.status.shortfall },
      ].filter((entry) => counts[entry.id].some((value) => value > 0))

      const labels = Array.from({ length: option.bins }, (_, index) => gameTime(this.StartYear, this.GameTime + index * binDays * SECONDS_PER_DAY).format(option.format))

      return { option, counts, later, total, skipped, result, series, labels }
    },

    timelineChart() {
      return {
        labels: this.timeline.labels,
        datasets: this.timeline.series.map((series) => ({
          label: series.label,
          data: this.timeline.counts[series.id],
          backgroundColor: series.color,
          borderColor: this.theme.surface,
          borderWidth: { left: 0, right: 0, top: 1, bottom: 0 },
          borderSkipped: false,
          stack: 'jobs',
        })),
      }
    },

    timelineOptions() {
      return {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
        },
        plugins: {
          tooltip: {
            filter: (item) => item.raw !== 0,
          },
        },
      }
    },
  },
  watch: {
    // Which colony the tables show is not kept, so another race starts with all of them.
    RaceID() {
      this.focusId = null
      this.arrivals = []
    },
  },
  methods: {
    applyLink(query) {
      this.focusId = queryId(query.colony)
    },

    setGroupBy(value) {
      this.groupByColony = value === 'colony'
    },

    // A table row: the colony's name and place, and the fields the table sorts and searches by.
    job({ rate, finish, ...fields }) {
      const colony = this.colony(fields.PopulationID, '')
      const days = valueOrNull(finish.result)

      return {
        detail: '',
        note: '',
        approx: false,
        queued: false,
        shortage: null,
        covers: null,
        stockUnknown: false,
        cautions: [],
        range: null,
        amount: null,
        ...fields,
        ...colony,
        rateResult: rate,
        finishResult: finish.result,
        finishIdle: finish.idle,
        days,
        statusSort: STATUS[fields.status.id].order,
        finishSort: days,
        searchText: `${fields.name} ${fields.detail || ''} ${colony.colonyName} ${colony.place}`.toLowerCase(),
      }
    },

    colony(populationId, fallbackName) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return { colonyName: fallbackName || `Colony #${populationId}`, place: '', body: null }
      }

      return { colonyName: modifiers.PopName, place: stripHtml(populationName(modifiers)).replace(` — ${modifiers.PopName}`, ''), body: bodyReference(modifiers) }
    },

    groupSummary(items) {
      const next = items.reduce((first, item) => (item.days > 0 && (first === null || item.days < first) ? item.days : first), null)

      return `${items.length} ${items.length === 1 ? 'job' : 'jobs'}${next === null ? '' : `, next done in ${this.duration(next)}`}`
    },

    scientistNote(project, field) {
      if (!project.CommanderField) {
        return 'No scientist'
      }

      return project.CommanderField !== field ? 'Scientist outside the field' : ''
    },

    // What a project the colony's stock cannot finish builds before it stops, and what it would take to finish it.
    plannedShortNote(project, planned) {
      const { shortage, supplied } = planned

      return `The stock covers ${this.coverText(shortage)} of ${this.units(project.Amount)}${supplied !== null ? `, and with all the stock it needs it would finish in ${this.duration(supplied)}` : ''}`
    },

    // The units a stock covers, as a range where the order the game takes the colony's projects in moves them.
    coverText(shortage) {
      return shortage.coveredMost !== undefined && shortage.coveredMost > shortage.covered ? `${this.units(shortage.covered)} to ${this.units(shortage.coveredMost)}` : this.units(shortage.covered)
    },

    // The line under a project of a colony the cycle forecast cannot run: what the save leaves out, and that arrivals entered are not counted.
    fallbackCautions(populationId, gaps) {
      const arrivals = this.arrivals.some((arrival) => arrival.PopulationID === populationId)

      return gaps && gaps.length ? [`Forecast by the older per-project check because ${gaps.join('; ')}${arrivals ? '; arrivals entered by hand are not counted for this colony' : ''}`] : []
    },

    // The caveats of a forecast date, one line each under the status: the order of the colony's projects, a stock that holds a project up, a build too small to date.
    forecastCautions(project, planned) {
      const { maybeShort, held, range, startRange, sampled, fineRemainder, sensitive } = planned
      const cautions = []

      if (maybeShort) {
        cautions.push(`May be short of ${maybeShort.name}: in some orders of the colony's projects the stock covers ${this.coverText(maybeShort)} of ${this.units(project.Amount)}`)
      }

      if (held) {
        cautions.push(`The stock of ${held.name} runs short from ${this.duration(held.day)}; the date counts the arrivals entered`)
      }

      if ((range || startRange) && !sampled) {
        cautions.push('The order the game takes the colony\'s projects in is not saved, so the date is the earliest of the orders tried')
      }

      if (sampled) {
        cautions.push(`Too many projects compete for the stock to try every order (${sampled} tried): the date is the earliest of those, not a bound`)
      }

      if (fineRemainder) {
        cautions.push('A fuel or installation limit left the project a part of a unit finer than a build of 4 decimals, so no build can finish it exactly and whether the game ever does is not known')
      }

      if (sensitive) {
        cautions.push(`Each cycle builds ${sensitive.units.toFixed(5)} of a unit, rounded to 4 decimals (up to ${this.count(sensitive.error * 100, 0)}% of it), so the date is not reliable`)
      }

      return cautions
    },

    // How far another order of the colony's projects moves a date: a range of the orders tried, or a latest of those where they were only sampled.
    rangeText(range) {
      if (range.sampled) {
        return range.latest === null ? 'Not finished in some of the orders tried; others may differ' : `Latest of the orders tried: ${this.duration(range.latest)}; other orders may differ`
      }

      return range.latest === null ? 'Some orders never finish it' : `Up to ${this.duration(range.latest)} in another order`
    },

    // The start of a queued project that another order moves, as a suffix of "Starts in X".
    startRangeText(range) {
      if (range.sampled) {
        return range.latest === null ? ' (not started in some of the orders tried; others may differ)' : ` (latest of the orders tried: ${this.duration(range.latest)}; other orders may differ)`
      }

      return range.latest === null ? ', or never in another order' : `, up to ${this.duration(range.latest)} in another order`
    },

    addArrival() {
      const { populationId, resource, day, quantity, source } = this.arrivalForm

      this.arrivals = [...this.arrivals, { id: this.arrivalCount + 1, PopulationID: populationId, resource, day: Number(day), quantity: Number(quantity), source: (source || '').trim() }]
      this.arrivalCount += 1
      this.arrivalForm = { ...this.arrivalForm, quantity: null, source: '' }
    },

    removeArrival(id) {
      this.arrivals = this.arrivals.filter((arrival) => arrival.id !== id)
    },

    mineralLink(shortage) {
      return linkTo.mineralOutlook(shortage.mineralId)
    },

    dateIn(days) {
      return gameTime(this.StartYear, this.GameTime + days * SECONDS_PER_DAY).format('YYYY-MM-DD')
    },

    // Build points with a decimal while they are small.
    bp(value) {
      return this.count(value, value > 0 && value < 10 ? 1 : 0)
    },

    units(value) {
      return this.count(value, value < 1 ? 2 : 1)
    },

    // The colony's GFCCs, null while the save does not give them.
    gfccCount(populationId) {
      const facilities = this.facilitiesByColony[populationId]

      return facilities && isKnownNumber(facilities.TrainingFacilities) ? facilities.TrainingFacilities : null
    },

    // A job's rate with its unit, a dash while the rate is not known.
    rateText(result, format, unit) {
      return isAvailable(result) ? `${format(result.value)} ${unit}` : UNKNOWN_TEXT
    },
  },
  asyncComputed: {
    // Per colony: research facilities and those projects use, GFCCs, and slipways and those tasks take.
    colonyFacilities: {
      get: tracked('colonyFacilities', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        // A colony's count is not known while any installation row lacks its amount or value, a project's or yard's while any row lacks the figure; a colony with none of them has 0.
        const installed = (value) => `(select case when sum(FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.${value} is null) > 0 then null else coalesce(sum(case when DIM_PlanetaryInstallation.${value} > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.${value} end), 0) end from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID)`

        const [rows] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, ${installed('ResearchValue')} as ResearchFacilities, (select case when count(*) = count(FCT_ResearchProject.Facilities) then coalesce(sum(FCT_ResearchProject.Facilities), 0) end from FCT_ResearchProject where FCT_ResearchProject.PopulationID = FCT_Population.PopulationID and FCT_ResearchProject.RaceID = ${this.RaceID}) as ResearchFacilitiesUsed, ${installed('GroundTrainingValue')} as TrainingFacilities, (select case when count(*) = count(FCT_Shipyard.Slipways) then coalesce(sum(FCT_Shipyard.Slipways), 0) end from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.RaceID = ${this.RaceID}) as Slipways, (select case when count(*) = count(FCT_Shipyard.Slipways) then coalesce(sum(min(FCT_Shipyard.Slipways, (select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID))), 0) end from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.RaceID = ${this.RaceID}) as SlipwaysUsed, (select count(*) from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.RaceID = ${this.RaceID}) as Shipyards from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    researches: {
      get: tracked('researches', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return { projects: [], queues: [] }
        }

        const [queues] = await this.database.query(`select FCT_ResearchQueue.CurrentProjectID, FCT_ResearchQueue.ResearchOrder, FCT_ResearchQueue.TechSystemID, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost, DIM_TechType.FieldID as ProjectField from FCT_ResearchQueue inner join FCT_ResearchProject on FCT_ResearchProject.ProjectID = FCT_ResearchQueue.CurrentProjectID and FCT_ResearchProject.RaceID = ${this.RaceID} left join FCT_TechSystem on FCT_ResearchQueue.TechSystemID = FCT_TechSystem.TechSystemID left join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_ResearchQueue.GameID = ${this.GameID}`)

        const [projects] = await this.database.query(`select FCT_ResearchProject.ProjectID as ID, FCT_Population.PopName, FCT_Population.PopulationID, FCT_ResearchProject.TechID as TechSystemID, FCT_TechSystem.Name, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired as RemainingProduction, FCT_ResearchProject.Pause as Paused, COALESCE(VIR_ResearchBonus.CommanderBonus, 1) as CommanderBonus, VIR_ResearchBonus.CommanderField, VIR_ResearchBonus.CommandID as ScientistCommandID, FCT_ResearchProject.ResSpecID as ProjectField, FCT_AncientConstruct.ResearchField as AnomalyField, FCT_AncientConstruct.ResearchBonus as AnomalyBonus, COALESCE(case when VIR_ResearchBonus.CommanderField = FCT_ResearchProject.ResSpecID then VIR_ResearchBonus.CommanderBonus * 4 - 3 else VIR_ResearchBonus.CommanderBonus end, 1) as ActualCommanderResearchBonus, COALESCE(case when FCT_AncientConstruct.ResearchField = FCT_ResearchProject.ResSpecID then FCT_AncientConstruct.ResearchBonus else 1 end, 1) as ActualAnomalyBonus from FCT_ResearchProject left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as CommanderBonus, FCT_Commander.ResSpecID as CommanderField from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 3 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommanderType in (3,4) and FCT_Commander.CommandType = 7 and FCT_Commander.CommandID <> 0) as VIR_ResearchBonus on VIR_ResearchBonus.CommandID = FCT_ResearchProject.ProjectID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_AncientConstruct on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`)

        // A project with a scientist has the figure of the Research bonus the save's lookup row does not confirm left unknown, never read as no bonus.
        return { projects: blocked.has(RESEARCH_BONUS) ? projects.map((project) => (project.ScientistCommandID === null ? project : { ...project, CommanderBonus: null, ActualCommanderResearchBonus: null })) : projects, queues }
      }),
      default: { projects: [], queues: [] },
    },
    // Each project with its per-unit minerals and fuel, and the colony's stock of each.
    industry: {
      get: tracked('industry', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const needs = MINERALS.map((mineral) => `FCT_IndustrialProjects.${mineral.name}`).join(', ')
        const stocks = MINERALS.map((mineral) => `FCT_Population.${mineral.name} as Stock${mineral.name}`).join(', ')

        const [rows] = await this.database.query(`select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.Description as Name, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.PartialCompletion, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause as Paused, FCT_IndustrialProjects.FuelRequired, ${needs}, ${stocks}, FCT_Population.FuelStockpile as StockFuel, DIM_PlanetaryInstallation.ConversionFrom as ConversionFrom, case when DIM_PlanetaryInstallation.ConversionFrom is null then null else (select case when sum(FCT_PopulationInstallations.Amount is null) > 0 then null else coalesce(sum(FCT_PopulationInstallations.Amount), 0) end from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_IndustrialProjects.PopulationID and FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.ConversionFrom) end as ConversionSource from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_IndustrialProjects.ProductionID and FCT_IndustrialProjects.ProductionType = 0 and DIM_PlanetaryInstallation.ConversionTo > 0 where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_ShipyardTask.TaskID as ID, FCT_ShipyardTask.TaskTypeID as ShipyardTaskType, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name, FCT_Shipyard.ShipyardName, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingProduction, FCT_ShipyardTask.Paused, (case when FCT_Shipyard.SYType = 1 then 1.0 when FCT_Shipyard.SYType is null then null else 0.25 end) as CommercialModifier from FCT_ShipyardTask left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID where FCT_ShipyardTask.GameID = ${this.GameID} and FCT_ShipyardTask.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    shipyards: {
      get: tracked('shipyards', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_Shipyard.ShipyardID as ID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.RetoolClassID, FCT_ShipClass.ClassName, FCT_Shipyard.TaskType as UpgradeTaskType, FCT_Shipyard.RequiredBP - FCT_Shipyard.CompletedBP as RemainingProduction, FCT_Shipyard.PauseActivity as Paused, FCT_Shipyard.CapacityTarget from FCT_Shipyard left join FCT_ShipClass on FCT_Shipyard.RetoolClassID = FCT_ShipClass.ShipClassID where FCT_Shipyard.TaskType <> 0 and FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    trainings: {
      get: tracked('trainings', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_GroundUnitTraining.TaskID as ID, FCT_GroundUnitTraining.PopulationID, FCT_GroundUnitTraining.FormationName as Name, FCT_GroundUnitTraining.TaskPercentage, FCT_GroundUnitTraining.TotalBP - FCT_GroundUnitTraining.CompletedBP as RemainingProduction from FCT_GroundUnitTraining where FCT_GroundUnitTraining.GameID = ${this.GameID} and FCT_GroundUnitTraining.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    // Naval admin commands with their Terraforming bonus, for orbital terraformers.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const { ranks, blocked } = await this.capabilityGates('/production')

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 9, share: 'Industrial', ranks, blocked })
      }),
      default: {},
    },
    // The colonies with a gas to add or remove, with their body and the gas: the terraforming jobs. What a colony's capacity is made of is read apart (`terraformSources`).
    terraforms: {
      get: tracked('terraforms', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [terraforms] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.AtmosPress, FCT_SystemBody.Radius, FCT_Population.TerraformStatus, DIM_Gases.Name as GasName, FCT_Population.MaxAtm, FCT_AtmosphericGas.GasAtm, case when FCT_AtmosphericGas.GasAtm is null and FCT_AtmosphericGas.AtmosGasID is not null then 1 else 0 end as GasAtmUnknown from FCT_Population left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join DIM_Gases on FCT_Population.TerraformingGasID = DIM_Gases.GasID left join FCT_AtmosphericGas on FCT_Population.SystemBodyID = FCT_AtmosphericGas.SystemBodyID and FCT_Population.TerraformingGasID = FCT_AtmosphericGas.AtmosGasID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.TerraformingGasID != 0`)

        return terraforms
      }),
      default: [],
    },
    // What the capacity of the race's colonies is made of: installations, orbital modules with their crews and captains, and the colony's modifiers. A job's rate and its breakdown come from the same figures as the Colonization Planner's.
    terraformSources: {
      get: tracked('terraformSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_TERRAFORM_SOURCES
        }

        return await loadTerraformSources(this.database, { GameID: this.GameID, RaceID: this.RaceID, blocked: this.blockedBonuses })
      }),
      default: NO_TERRAFORM_SOURCES,
    },
    // The race's ship classes with the components each mounts, and the component stock and mineral stock of each colony: what the component calculator works from.
    componentSources: {
      get: tracked('componentSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { classes: [], parts: {}, stock: {}, minerals: {} }
        }

        const scope = `GameID = ${this.GameID} and RaceID = ${this.RaceID}`
        const needs = MINERALS.map((mineral) => `FCT_ShipDesignComponents.${mineral.name}`).join(', ')
        const stocks = MINERALS.map((mineral) => mineral.name).join(', ')

        const [classes] = await this.database.query(`select ShipClassID, ClassName, Obsolete from FCT_ShipClass where ${scope} order by ClassName`)
        const [parts] = await this.database.query(`select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Prototype, FCT_ShipDesignComponents.ShippingLineSystem, ${needs}, FCT_RaceTech.Obsolete as TechObsolete, FCT_RaceTech.TechID as ResearchedTech from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID left join FCT_RaceTech on FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID and FCT_RaceTech.RaceID = ${this.RaceID} and FCT_RaceTech.GameID = ${this.GameID} where FCT_ClassComponent.GameID = ${this.GameID} and FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID}`)
        const [stock] = await this.database.query(`select FCT_PopComponent.PopulationID, FCT_PopComponent.ComponentID, FCT_PopComponent.Amount from FCT_PopComponent inner join FCT_Population on FCT_Population.PopulationID = FCT_PopComponent.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)
        const [populations] = await this.database.query(`select PopulationID, ${stocks} from FCT_Population where ${scope}`)

        return sourcesOf({ classes, parts, stock, populations, npr: this.RaceNPR })
      }),
      default: { classes: [], parts: {}, stock: {}, minerals: {} },
    },
    // The colonies with their shipyards, the shipyard tasks, the queued component projects and the tons each component weighs: what the procurement manifest reads besides the component calculator's sources.
    procurementSources: {
      get: tracked('procurementSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_PROCUREMENT_SOURCES
        }

        return await loadProcurementSources(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: NO_PROCUREMENT_SOURCES,
    },
  },
}
</script>

<style lang="scss">
.production-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }

  .tool {
    min-width: 0;
  }

  .tool__label {
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
  }

  .tool--types {
    flex: 0 1 auto;
  }

  // Rows and Options stay at the right end, so the type chips growing or shrinking as they are toggled doesn't move them.
  .tool--rows {
    margin-left: auto;
  }

  .tool--actions {
    align-self: flex-end;
  }

  .toolbar .v-btn-toggle .v-btn,
  .tool--actions .v-btn {
    height: 40px !important;
  }

  .type-chips {
    padding: 0;

    .v-slide-group__content {
      padding: 4px 0;
    }

    .v-chip {
      margin-top: 2px;
      margin-bottom: 2px;
    }
  }

  .type-chip--on {
    background: rgba(127, 127, 127, 0.14);
  }

  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  .arrival-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
  }

  .panel {
    margin-top: 8px;
  }

  > .panel {
    margin-top: 20px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
