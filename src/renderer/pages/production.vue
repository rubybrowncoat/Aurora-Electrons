<template>
  <div>
    <v-container fluid class="production-page">
      <v-alert v-if="failedInputs.length" type="error" outlined dense>
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--types">
            <div class="tool__label caption text--secondary">Show</div>
            <v-chip-group :value="shownTypes" multiple column active-class="type-chip--on" class="type-chips" @change="setShownTypes">
              <v-chip v-for="type in typeOptions" :key="type.id" :value="type.id" small outlined filter>
                <span class="dot" :style="{ background: type.color }" />{{ type.label }}&nbsp;<span class="text--secondary">{{ type.count }}</span>
              </v-chip>
            </v-chip-group>
          </div>
          <div class="tool">
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
                <v-checkbox v-model="showQueued" dense hide-details @change="(value) => saveSetting('productionShowQueued', !!value)">
                  <template #label>
                    <div>
                      <div class="body-2">Queued jobs</div>
                      <div class="caption text--secondary">Industrial projects and research waiting for the job ahead of them.</div>
                    </div>
                  </template>
                </v-checkbox>
                <v-checkbox v-model="showPaused" dense hide-details @change="(value) => saveSetting('productionShowPaused', !!value)">
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

        <v-row class="mt-1">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value">{{ tile.value }}</div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Work in progress</span>
            <v-text-field v-model="search" label="Search" placeholder="Job or colony" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <v-data-table :headers="jobHeaders" :items="visibleJobs" item-key="key" :group-by="groupByColony ? 'colonyName' : []" :sort-by.sync="jobSortBy" :sort-desc.sync="jobSortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" :no-data-text="jobs.length ? 'No jobs match the filters.' : 'Nothing is being built, researched, trained or terraformed.'">
            <template #[`group.header`]="{ group, items, headers, isOpen, toggle }">
              <td :colspan="headers.length">
                <v-btn icon small :aria-label="isOpen ? `Collapse ${group}` : `Expand ${group}`" @click="toggle"><v-icon small>{{ isOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon></v-btn>
                <span class="font-weight-medium">{{ group }}</span>
                <span class="caption text--secondary ml-2">{{ groupSummary(items) }}</span>
              </td>
            </template>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium"><span class="dot" :style="{ background: typeColors[item.type] }" />{{ item.name }}</div>
                <div class="caption text--secondary">{{ typeLabels[item.type] }}<span v-if="item.detail"> · {{ item.detail }}</span></div>
                <div v-if="item.note" class="caption warning--text">{{ item.note }}</div>
              </div>
            </template>
            <template #[`item.colonyName`]="{ item }">
              <div class="py-2">
                <div>{{ item.colonyName }}</div>
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
                <div v-if="item.status.note" class="caption text--secondary">{{ item.status.note }}</div>
                <div v-if="item.shortage && item.status.id !== 'short'" class="caption">
                  <router-link v-if="item.shortage.mineralId" :to="mineralLink(item.shortage)">Short of {{ item.shortage.name }}</router-link>
                  <span v-else>Short of {{ item.shortage.name }}</span>
                  <span class="text--secondary">: the stock covers {{ units(item.shortage.covered) }} of {{ units(item.amount) }}</span>
                </div>
              </div>
            </template>
            <template #[`item.rate`]="{ item }">
              <div class="py-2 text-no-wrap">
                <div>{{ item.rateText }}</div>
                <div class="caption text--secondary">{{ item.rateNote }}</div>
              </div>
            </template>
            <template #[`item.finishSort`]="{ item }">
              <div class="py-2 text-no-wrap">
                <span v-if="item.days === null" class="text--secondary">—</span>
                <span v-else-if="item.days === 0">Done</span>
                <template v-else>
                  <div>{{ item.approx ? '~' : '' }}{{ duration(item.days) }}</div>
                  <div class="caption text--secondary">{{ dateIn(item.days) }}</div>
                </template>
              </div>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            An industrial project builds at its share of the colony's construction, ordnance or fighter capacity, and only as far as the colony's own stock of each mineral goes; each project is checked against the whole stock, so projects at one colony that need the same mineral run short sooner. A queued project starts when a project of the same kind at that colony finishes, in queue order, if the share left is enough for it. Paused jobs keep their share and build nothing. Times assume the minerals arrive; ~ marks estimates.
          </div>
        </v-card>

        <v-row>
          <v-col cols="12" xl="5">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>Completions</span>
                <v-btn-toggle :value="horizon" mandatory dense @change="setHorizon">
                  <v-btn v-for="option in horizons" :key="option.years" :value="option.years" small>{{ option.label }}</v-btn>
                </v-btn-toggle>
              </div>
              <div class="panel-body">
                <div v-if="timeline.total" class="legend mb-2">
                  <span v-for="series in timeline.series" :key="series.id" class="legend-item"><span class="dot" :style="{ background: series.color }" />{{ series.label }}</span>
                </div>
                <chart-canvas v-if="timeline.total" type="bar" :data="timelineChart" :options="timelineOptions" :height="240" :label="`Jobs finishing per ${timeline.option.unit} over the next ${timeline.option.label}, by kind`" />
                <div v-else class="caption text--secondary">None of the jobs shown finishes in the next {{ timeline.option.label }}.</div>
              </div>
              <div class="panel-foot caption text--secondary">
                The jobs in the table, per {{ timeline.option.unit }} they finish in. Paused jobs and jobs that never start are left out<span v-if="timeline.later">, and {{ timeline.later }} {{ timeline.later === 1 ? 'finishes' : 'finish' }} later</span>. Short of minerals counts jobs the colony's stock can't finish, at the time they would finish if the minerals arrive.
              </div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="7">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>Idle capacity by colony</span>
                <v-chip small>{{ capacityRows.length }} {{ capacityRows.length === 1 ? 'colony' : 'colonies' }}</v-chip>
              </div>
              <v-data-table :headers="capacityHeaders" :items="capacityRows" item-key="PopulationID" :sort-by.sync="capacitySortBy" :sort-desc.sync="capacitySortDesc" :items-per-page="10" :footer-props="{ itemsPerPageOptions: [10, 25, -1] }" no-data-text="Every colony is using all its capacity.">
                <template #[`item.colonyName`]="{ item }">
                  <div class="py-2">
                    <div class="font-weight-medium">{{ item.colonyName }}</div>
                    <div class="caption text--secondary">{{ item.place }}</div>
                  </div>
                </template>
                <template v-for="column in capacityColumns" #[`item.${column.key}Free`]="{ item }">
                  <div :key="column.key" class="py-2 text-no-wrap">
                    <span v-if="!item[`${column.key}Total`]" class="text--disabled">—</span>
                    <template v-else>
                      <div :class="{ 'text--secondary': item[`${column.key}Free`] < IDLE_MINIMUM }">{{ column.bp ? bp(item[`${column.key}Free`]) : count(item[`${column.key}Free`]) }}</div>
                      <div class="caption text--secondary">of {{ column.bp ? bp(item[`${column.key}Total`]) : count(item[`${column.key}Total`]) }}</div>
                    </template>
                  </div>
                </template>
              </v-data-table>
              <div class="panel-foot caption text--secondary">
                What each colony leaves idle, of its total: build points a year for construction, ordnance, fighters and ground training (GFCCs), and research facilities and slipways not assigned to a project or task. A paused job's share counts as idle. Colonies using everything they have are left out.
              </div>
            </v-card>
          </v-col>
        </v-row>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme } from '../components/charts/theme'
import countFormat from '../mixins/count-format'
import productionModifiers from '../mixins/production-modifiers'
import { gameTime, populationName } from '../utilities/aurora'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { MINERALS, navalAdminChainBonus } from '../utilities/minerals'
import { loadNavalAdmins } from '../utilities/naval-admins'

const INPUT_LABELS = {
  populationProductionModifiers: 'the colonies\' production rates',
  colonyFacilities: 'the colonies\' facilities',
  researches: 'the research projects',
  industry: 'the industrial projects',
  ships: 'the shipyard tasks',
  shipyards: 'the shipyard activities',
  trainings: 'the ground unit training',
  terraforms: 'the terraforming',
  navalAdmins: 'the naval admin commands',
}
const INPUTS = Object.keys(INPUT_LABELS)

const SECONDS_PER_YEAR = 31536000
const SECONDS_PER_DAY = 86400

const EARTH_SURFACE_AREA = 511187128

// Water vapour (2.7.1 source, Helpers): condensation a year, hydrographic extent per atm, relative humidity factor.
const CONDENSATION_PER_YEAR = 0.1
const CONDENSATION_TO_HYDRO_RATE = 40
const WATER_VAPOUR_IN_ATMOSPHERE = 0.01
// How far ahead the water vapour estimate looks.
const WATER_VAPOUR_HORIZON = 200

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
const SHORT_SLOT = 7

// A job's status, in the order the Status column sorts by.
const STATUS = {
  running: { order: 0, icon: 'mdi-play-circle-outline', color: 'success' },
  short: { order: 1, icon: 'mdi-alert-circle-outline', color: 'error' },
  queued: { order: 2, icon: 'mdi-timer-sand', color: undefined },
  paused: { order: 3, icon: 'mdi-pause-circle-outline', color: 'warning' },
  stalled: { order: 4, icon: 'mdi-cancel', color: 'error' },
}

// The completions chart's spans: a year by month, five years by quarter, twenty by year.
const HORIZONS = [
  { years: 1, label: '1 y', bins: 12, unit: 'month', format: 'YYYY-MM' },
  { years: 5, label: '5 y', bins: 20, unit: 'quarter', format: 'YYYY-MM' },
  { years: 20, label: '20 y', bins: 20, unit: 'year', format: 'YYYY' },
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

// The capacity a project draws on: components and space stations use construction capacity
// (2.7.1 source, Game.LoadIndustrialProjects).
const categoryOf = (productionType) => (productionType === 1 ? 'ordnance' : productionType === 2 ? 'fighter' : 'construction')

// When each industrial project of one colony and category starts and finishes, in days from now, as the game runs
// them (2.7.1 source, Population.ProcessIndustrialProjects). Every project out of the queue builds at its share of the
// capacity; a paused one keeps its share and builds nothing. When a project finishes, the queued ones start in queue
// order, each that fits in the share the running and paused ones leave, skipping any that don't, until none is left.
// Minerals aren't simulated. `capacity`: BP a year at 100%. Returns { [ProjectID]: { start, finish } }, null where
// that never happens.
const industrySchedule = (projects, capacity) => {
  const schedule = {}
  const running = []
  let used = 0

  const begin = (project, start) => {
    const rate = (capacity * project.Percentage) / 100
    const finish = project.Paused || !(rate > 0) ? null : start + ((project.Amount * project.ProdPerUnit) / rate) * 365

    used += project.Percentage
    schedule[project.ID] = { start, finish }

    if (finish !== null) {
      running.push({ project, finish })
    }
  }

  projects.filter((project) => !project.Queue).forEach((project) => begin(project, 0))

  let queue = projects.filter((project) => project.Queue > 0).sort((a, b) => a.Queue - b.Queue)

  while (queue.length && running.length) {
    running.sort((a, b) => a.finish - b.finish)

    const done = running.shift()
    let full = false

    used -= done.project.Percentage
    queue = queue.filter((project) => {
      if (full || 100 - used + 1e-9 < project.Percentage) {
        return true
      }

      begin(project, done.finish)
      full = 100 - used <= 0

      return false
    })
  }

  queue.forEach((project) => {
    schedule[project.ID] = { start: null, finish: null }
  })

  return schedule
}

// How many units the colony's stock covers when that is less than the project still needs, and the material that
// runs out first, as the game cuts each build to it (2.7.1 source, MineralData.LimitIndustrialProjectAmountByMinerals,
// then fuel in Population.ProcessIndustrialProjects). The mineral columns are per unit.
const shortageOf = (project) => {
  let covered = Infinity
  let limit = null

  MINERALS.forEach((mineral) => {
    if (project[mineral.name] > 0) {
      const units = (project[`Stock${mineral.name}`] || 0) / project[mineral.name]

      if (units < covered) {
        covered = units
        limit = { mineralId: mineral.id, name: mineral.name }
      }
    }
  })

  if (project.FuelRequired > 0 && (project.StockFuel || 0) / project.FuelRequired < covered) {
    covered = (project.StockFuel || 0) / project.FuelRequired
    limit = { mineralId: null, name: 'fuel' }
  }

  return limit && covered < project.Amount - 1e-6 ? { ...limit, covered: Math.max(0, covered) } : null
}

// How many construction cycles until adding or removing water vapour on a body with liquid water ends, as the game
// runs them: the terraformers change the gas each cycle and the job ends once it passes the target (2.7.1 source,
// Population.ProcessTerraforming); vapour above the air's humidity then condenses into the oceans, up to 0.1 atm a year,
// and the oceans evaporate up to it (Game.ProcessWaterVapourCondensation, Game.ProcessWaterVapourEvaporation). `step`:
// atm the terraformers move a cycle; `years`: a cycle's length. Null when that takes more than WATER_VAPOUR_HORIZON
// years.
const waterVapourCycles = (terraform, step, years) => {
  let gas = terraform.GasAtm || 0
  let pressure = terraform.AtmosPress
  let hydro = terraform.HydroExt
  const cycles = Math.ceil(WATER_VAPOUR_HORIZON / years)

  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (terraform.TerraformStatus) {
      gas += step
      pressure += step

      if (gas > terraform.MaxAtm) {
        return cycle
      }
    } else {
      const removed = Math.min(step, gas)

      gas -= removed
      pressure -= removed

      if (gas <= 0) {
        if (!(hydro > 0)) {
          return cycle
        }
      } else if (gas <= terraform.MaxAtm && terraform.MaxAtm > 0) {
        return cycle
      }
    }

    const humidity = pressure * (hydro / 100) * WATER_VAPOUR_IN_ATMOSPHERE

    if (gas > humidity) {
      const condensed = Math.min(years * CONDENSATION_PER_YEAR, gas - humidity)

      gas -= condensed
      pressure -= condensed
      hydro += condensed * CONDENSATION_TO_HYDRO_RATE
    }

    const target = pressure * (hydro / 100) * WATER_VAPOUR_IN_ATMOSPHERE

    if (hydro > 0 && target > gas) {
      hydro -= (target - gas) * CONDENSATION_TO_HYDRO_RATE
      pressure += target - gas
      gas = target
    }
  }

  return null
}

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'ProductionPage',
  components: { ChartCanvas },
  mixins: [countFormat, productionModifiers],
  data() {
    return {
      loadErrors: {},
      search: '',
      shownTypes: [...TYPE_IDS],
      groupByColony: false,
      showQueued: true,
      showPaused: true,
      horizon: 5,
      horizons: HORIZONS,
      capacityColumns: CAPACITY_COLUMNS,
      jobSortBy: ['finishSort'],
      jobSortDesc: [false],
      capacitySortBy: ['constructionFree'],
      capacitySortDesc: [true],
      STATUS,
      IDLE_MINIMUM,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'GameTime']),
    ...mapState(['RaceNPR']),

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    typeColors() {
      return Object.fromEntries(TYPES.map((type) => [type.id, this.theme.categorical[type.slot]]))
    },

    typeLabels() {
      return Object.fromEntries(TYPES.map((type) => [type.id, type.label]))
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS)
    },

    settingsPrefix() {
      return `game.${this.GameID}.race.${this.RaceID}`
    },

    activeOptionCount() {
      return [!this.showQueued, !this.showPaused].filter(Boolean).length
    },

    facilitiesByColony() {
      return Object.fromEntries(this.colonyFacilities.map((colony) => [colony.PopulationID, colony]))
    },

    // Each research project, then its queue: a queued tech starts when the one ahead finishes, with the same labs.
    researchJobs() {
      const { projects, queues } = this.researches

      return projects.flatMap((project) => {
        const rate = this.populationResearchCapacity(project.PopulationID, project)
        const ownDays = rate > 0 ? (project.RemainingProduction / rate) * 365 : null
        const status = project.Paused
          ? { id: 'paused', label: 'Paused' }
          : rate > 0
            ? { id: 'running', label: 'Running' }
            : { id: 'stalled', label: 'No labs', note: 'No research facilities are assigned' }
        let start = project.Paused ? null : ownDays

        const jobs = [this.job({
          key: `research-${project.ID}`,
          type: 'research',
          PopulationID: project.PopulationID,
          name: project.Name,
          note: this.scientistNote(project, project.ProjectField),
          rateText: `${this.count(rate)} RP/yr`,
          rateNote: `${this.count(project.Facilities)} ${project.Facilities === 1 ? 'lab' : 'labs'}`,
          days: project.Paused ? null : ownDays,
          status,
        })]

        queues.filter((queue) => queue.CurrentProjectID === project.ID).sort((a, b) => a.ResearchOrder - b.ResearchOrder).forEach((queue, index) => {
          const inField = project.ProjectField === queue.ProjectField
          const queueRate = this.populationResearchCapacity(project.PopulationID, {
            ...project,
            ActualCommanderResearchBonus: inField ? (project.ActualCommanderResearchBonus || 1) : (project.CommanderBonus || 1),
            ActualAnomalyBonus: inField ? project.ActualAnomalyBonus : 1,
          })
          const finish = start === null || !(queueRate > 0) ? null : start + (queue.DevelopCost / queueRate) * 365

          jobs.push(this.job({
            key: `research-${project.ID}-${queue.ResearchOrder}`,
            type: 'research',
            PopulationID: project.PopulationID,
            name: queue.Name,
            note: this.scientistNote(project, queue.ProjectField),
            rateText: `${this.count(queueRate)} RP/yr`,
            rateNote: `${this.count(project.Facilities)} ${project.Facilities === 1 ? 'lab' : 'labs'}`,
            days: finish,
            queued: true,
            status: {
              id: 'queued',
              label: `Queued #${index + 1}`,
              note: start === null ? (project.Paused ? 'Never starts: the project ahead is paused' : 'Never starts: the project ahead makes no progress') : `Starts in ${this.duration(start)}`,
            },
          }))

          start = finish
        })

        return jobs
      })
    },

    industryJobs() {
      const groups = {}

      this.industry.forEach((project) => {
        const key = `${project.PopulationID}-${categoryOf(project.ProductionType)}`

        ;(groups[key] = groups[key] || []).push(project)
      })

      return Object.values(groups).flatMap((group) => {
        const { PopulationID, ProductionType } = group[0]
        const category = categoryOf(ProductionType)
        const capacity = this.categoryCapacity(PopulationID, category)
        const schedule = industrySchedule(group, capacity)
        const anyBuilding = capacity > 0 && group.some((project) => !project.Queue && !project.Paused)
        const pausedAhead = group.some((project) => !project.Queue && project.Paused)

        return group.map((project) => {
          const rate = (capacity * project.Percentage) / 100
          const { start, finish } = schedule[project.ID]
          // A spied NPR builds from its capital's stock (2.7.1 source, Population.ProcessIndustrialProjects).
          const shortage = this.RaceNPR ? null : shortageOf(project)
          let status

          if (project.Queue > 0) {
            status = {
              id: 'queued',
              label: `Queued #${project.Queue}`,
              note: start === null
                ? `Never starts: ${!anyBuilding ? 'nothing ahead of it is building' : pausedAhead ? 'a paused project keeps the share it needs' : 'not enough share frees up'}`
                : `Starts in ${this.duration(start)}${project.Paused ? ', paused' : ''}`,
            }
          } else if (project.Paused) {
            status = { id: 'paused', label: 'Paused' }
          } else if (!(rate > 0)) {
            status = { id: 'stalled', label: 'No capacity', note: `The colony has no ${category} capacity` }
          } else if (shortage) {
            status = {
              id: 'short',
              label: `Short of ${shortage.name}`,
              note: `The stock covers ${this.units(shortage.covered)} of ${this.units(project.Amount)}, about ${this.duration((shortage.covered * project.ProdPerUnit / rate) * 365)}`,
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
            rateText: `${this.bp(rate)} BP/yr`,
            rateNote: `${this.count(project.Percentage, 1)}% of ${category}`,
            days: finish,
            amount: project.Amount,
            queued: project.Queue > 0,
            shortage,
            status,
          })
        })
      })
    },

    shipJobs() {
      return this.ships.map((ship) => {
        const rate = this.populationShipyardCapacity(ship.PopulationID, ship)

        return this.job({
          key: `ship-${ship.ID}`,
          type: 'ship',
          PopulationID: ship.PopulationID,
          name: ship.Name,
          detail: [SHIPYARD_TASK_TYPES[ship.ShipyardTaskType], ship.ClassName].filter(Boolean).join(' · '),
          rateText: `${this.bp(rate)} BP/yr`,
          rateNote: ship.ShipyardName,
          days: ship.Paused || !(rate > 0) ? null : (ship.RemainingProduction / rate) * 365,
          status: ship.Paused ? { id: 'paused', label: 'Paused' } : rate > 0 ? { id: 'running', label: 'Running' } : { id: 'stalled', label: 'No capacity' },
        })
      })
    },

    shipyardJobs() {
      return this.shipyards.map((shipyard) => {
        const rate = this.populationShipyardUpgradeCapacity(shipyard.PopulationID, shipyard)
        const days = shipyard.UpgradeTaskType === 8
          ? this.shipyardContinualRemainingDays(shipyard)
          : rate > 0 ? shipyard.RemainingProduction / rate * SECONDS_PER_YEAR / SECONDS_PER_DAY / (shipyard.UpgradeTaskType === 7 ? shipyard.Slipways : 1) : null
        const target = shipyard.UpgradeTaskType === 7 && shipyard.ClassName
          ? ` to ${shipyard.ClassName}`
          : shipyard.UpgradeTaskType === 8 ? ` to ${this.count(shipyard.CapacityTarget)} t` : ''

        return this.job({
          key: `shipyard-${shipyard.ID}`,
          type: 'shipyard',
          PopulationID: shipyard.PopulationID,
          name: shipyard.ShipyardName,
          detail: `${SHIPYARD_UPGRADE_TYPES[shipyard.UpgradeTaskType] || 'Activity'}${target}`,
          rateText: `${this.bp(rate)} BP/yr`,
          rateNote: 'Modification rate',
          days: shipyard.Paused ? null : days,
          approx: shipyard.UpgradeTaskType === 8,
          status: shipyard.Paused ? { id: 'paused', label: 'Paused' } : days === null ? { id: 'stalled', label: 'No capacity' } : { id: 'running', label: 'Running' },
        })
      })
    },

    // Each task gets its percentage of the colony's ground formation construction capacity (2.7.1 source,
    // Population.RecalculateGroundFormationConstructionCapacity and ProcessGroundUnitTrainingAndReplacements).
    trainingJobs() {
      return this.trainings.map((training) => {
        const gfccs = this.gfccCount(training.PopulationID)
        const rate = (this.trainingCapacity(training.PopulationID) * training.TaskPercentage) / 100

        return this.job({
          key: `training-${training.ID}`,
          type: 'training',
          PopulationID: training.PopulationID,
          name: training.Name,
          rateText: `${this.bp(rate)} BP/yr`,
          rateNote: `${this.count(training.TaskPercentage, 1)}% of ${this.count(gfccs)} ${gfccs === 1 ? 'GFCC' : 'GFCCs'}`,
          days: rate > 0 ? (training.RemainingProduction / rate) * 365 : null,
          status: rate > 0 ? { id: 'running', label: 'Running' } : { id: 'stalled', label: 'No GFCC', note: 'The colony has no ground force construction complex' },
        })
      })
    },

    terraformingJobs() {
      return Object.values(this.terraforms.reduce((map, terraform) => {
        if (terraform.TerraformStatus && !terraform.MaxAtm) {
          return map
        }

        if (!map[terraform.PopulationID]) {
          map[terraform.PopulationID] = {
            ...terraform,

            planetaryCapacity: 0,
            orbitalCapacity: 0,
          }
        }

        // Orbital terraformers get their admin command chain's Terraforming bonus at the Industrial share.
        if (terraform.ParentCommandID) {
          map[terraform.PopulationID].orbitalCapacity += this.terraformingRate(terraform.PopulationID) * navalAdminChainBonus(this.navalAdmins, terraform.SystemID, terraform.ParentCommandID) * terraform.Terraformers
        } else {
          map[terraform.PopulationID].planetaryCapacity += this.populationTerraformingRate(terraform.PopulationID) * terraform.Terraformers
        }

        return map
      }, {})).map((terraform) => {
        const localSurfaceArea = 4 * Math.PI * Math.pow(terraform.Radius, 2)
        const totalCapacity = (terraform.planetaryCapacity + terraform.orbitalCapacity) * this.populationTerraformingSpeed(terraform.PopulationID)
        const localCapacity = totalCapacity * (EARTH_SURFACE_AREA / localSurfaceArea)
        const waterOnSurface = terraform.GasName === 'Water Vapour' && terraform.HydroID === 3
        let days = null
        let note

        if (localCapacity > 0 && waterOnSurface) {
          const period = this.populationMinConstructionPeriod(terraform.PopulationID)
          const cycles = waterVapourCycles(terraform, (localCapacity * period) / SECONDS_PER_YEAR, period / SECONDS_PER_YEAR)

          if (cycles === null) {
            note = `Not within ${WATER_VAPOUR_HORIZON} years: the vapour condenses into the oceans`
          } else {
            days = (cycles * period) / SECONDS_PER_DAY
          }
        } else if (localCapacity > 0) {
          days = Math.max(0, terraform.TerraformStatus ? terraform.MaxAtm - terraform.GasAtm : terraform.GasAtm - terraform.MaxAtm) / (localCapacity / 365)
        }

        return this.job({
          key: `terraforming-${terraform.PopulationID}`,
          type: 'terraforming',
          PopulationID: terraform.PopulationID,
          name: `${terraform.GasName} to ${terraform.MaxAtm} atm`,
          detail: waterOnSurface ? `Hydrographic extent ${this.count(terraform.HydroExt, 1)}%` : '',
          rateText: `${this.count(localCapacity, 4)} atm/yr`,
          rateNote: terraform.TerraformStatus ? 'Adding' : 'Removing',
          days,
          approx: true,
          status: localCapacity > 0 ? { id: 'running', label: 'Running', note } : { id: 'stalled', label: 'No capacity' },
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

    visibleJobs() {
      const search = (this.search || '').trim().toLowerCase()

      return this.optionJobs.filter((job) => this.shownTypes.includes(job.type) && (!search || job.searchText.includes(search)))
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

    // Idle capacity per colony with any: the share of each industrial capacity no running project uses, the share
    // of GFCC capacity no training task uses, labs no project uses and slipways without a task (2.7.1 source,
    // Economics shipyard list: Slipways less the yard's tasks).
    colonyCapacity() {
      const shares = {}
      const trainingShares = {}

      this.industry.forEach((project) => {
        if (!project.Queue && !project.Paused) {
          const key = `${project.PopulationID}-${categoryOf(project.ProductionType)}`

          shares[key] = (shares[key] || 0) + project.Percentage
        }
      })

      this.trainings.forEach((training) => {
        trainingShares[training.PopulationID] = (trainingShares[training.PopulationID] || 0) + training.TaskPercentage
      })

      return this.colonyFacilities.map((colony) => {
        const id = colony.PopulationID
        const freeShare = (used) => Math.max(0, 100 - (used || 0)) / 100
        const row = { PopulationID: id, Shipyards: colony.Shipyards, ...this.colony(id, colony.PopName) }

        ;['construction', 'ordnance', 'fighter'].forEach((category) => {
          row[`${category}Total`] = this.categoryCapacity(id, category)
          row[`${category}Free`] = row[`${category}Total`] * freeShare(shares[`${id}-${category}`])
        })

        row.trainingTotal = this.trainingCapacity(id)
        row.trainingFree = row.trainingTotal * freeShare(trainingShares[id])
        row.researchTotal = colony.ResearchFacilities
        row.researchFree = Math.max(0, colony.ResearchFacilities - colony.ResearchFacilitiesUsed)
        row.slipwaysTotal = colony.Slipways
        row.slipwaysFree = Math.max(0, colony.Slipways - colony.SlipwaysUsed)

        return row
      })
    },

    capacityRows() {
      return this.colonyCapacity.filter((row) => CAPACITY_COLUMNS.some((column) => row[`${column.key}Free`] >= IDLE_MINIMUM))
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
      const shortLabel = short.some((job) => !job.shortage.mineralId) ? 'short of minerals or fuel' : 'short of minerals'
      const jobNotes = [paused && `${paused} paused`, queued && `${queued} queued`, short.length && `${short.length} ${shortLabel}`].filter(Boolean)

      const sum = (key) => this.colonyCapacity.reduce((total, row) => total + row[key], 0)
      const coloniesWith = (key) => this.colonyCapacity.filter((row) => row[key] >= IDLE_MINIMUM).length
      const at = (colonies, none) => (colonies ? `At ${colonies} ${colonies === 1 ? 'colony' : 'colonies'}` : none)

      const constructionTotal = sum('constructionTotal')
      const researchTotal = sum('researchTotal')
      const slipwaysTotal = sum('slipwaysTotal')

      return [
        {
          label: 'Jobs',
          value: this.count(active.length),
          note: jobNotes.length ? jobNotes.join(', ') : active.length ? 'All running' : 'Nothing under way',
        },
        {
          label: 'Construction free',
          value: `${this.bp(sum('constructionFree'))} BP/yr`,
          note: constructionTotal ? at(coloniesWith('constructionFree'), 'Every colony is building') : 'No construction capacity',
        },
        {
          label: 'Research labs idle',
          value: `${this.count(sum('researchFree'))} of ${this.count(researchTotal)}`,
          note: researchTotal ? at(coloniesWith('researchFree'), 'All researching') : 'No research facilities',
        },
        {
          label: 'Slipways idle',
          value: `${this.count(sum('slipwaysFree'))} of ${this.count(slipwaysTotal)}`,
          note: slipwaysTotal ? at(coloniesWith('slipwaysFree'), 'All building') : 'No shipyards',
        },
      ]
    },

    timeline() {
      const option = HORIZONS.find((horizon) => horizon.years === this.horizon) || HORIZONS[0]
      const binDays = (option.years * 365) / option.bins
      const counts = Object.fromEntries([...TYPE_IDS, 'short'].map((id) => [id, new Array(option.bins).fill(0)]))
      let later = 0
      let total = 0

      this.visibleJobs.forEach((job) => {
        if (!(job.days > 0)) {
          return
        }

        const bin = Math.floor(job.days / binDays)

        if (bin >= option.bins) {
          later += 1
        } else {
          counts[job.shortage ? 'short' : job.type][bin] += 1
          total += 1
        }
      })

      const series = [
        ...TYPES.map((type) => ({ id: type.id, label: type.label, color: this.typeColors[type.id] })),
        { id: 'short', label: 'Short of minerals', color: this.theme.categorical[SHORT_SLOT] },
      ].filter((entry) => counts[entry.id].some((value) => value > 0))

      const labels = Array.from({ length: option.bins }, (_, index) => gameTime(this.StartYear, this.GameTime + index * binDays * SECONDS_PER_DAY).format(option.format))

      return { option, counts, later, total, series, labels }
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
    // The filters and the chart's span are kept per game and race.
    RaceID: {
      immediate: true,
      handler() {
        const types = this.config.get(`${this.settingsPrefix}.productionTypes`, TYPE_IDS)

        this.shownTypes = Array.isArray(types) ? types.filter((type) => TYPE_IDS.includes(type)) : [...TYPE_IDS]
        this.groupByColony = this.config.get(`${this.settingsPrefix}.productionGroupByColony`, false)
        this.showQueued = this.config.get(`${this.settingsPrefix}.productionShowQueued`, true)
        this.showPaused = this.config.get(`${this.settingsPrefix}.productionShowPaused`, true)
        this.horizon = this.config.get(`${this.settingsPrefix}.productionHorizon`, 5)
      },
    },
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    saveSetting(key, value) {
      this.config.set(`${this.settingsPrefix}.${key}`, value)
    },

    setShownTypes(types) {
      this.shownTypes = types
      this.saveSetting('productionTypes', types)
    },

    setGroupBy(value) {
      this.groupByColony = value === 'colony'
      this.saveSetting('productionGroupByColony', this.groupByColony)
    },

    setHorizon(years) {
      this.horizon = years
      this.saveSetting('productionHorizon', years)
    },

    // A table row: the colony's name and place, and the fields the table sorts and searches by.
    job(fields) {
      const colony = this.colony(fields.PopulationID, '')

      return {
        detail: '',
        note: '',
        approx: false,
        queued: false,
        shortage: null,
        amount: null,
        ...fields,
        ...colony,
        statusSort: STATUS[fields.status.id].order,
        finishSort: fields.days === null ? Infinity : fields.days,
        searchText: `${fields.name} ${fields.detail || ''} ${colony.colonyName} ${colony.place}`.toLowerCase(),
      }
    },

    colony(populationId, fallbackName) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return { colonyName: fallbackName || `Colony #${populationId}`, place: '' }
      }

      return { colonyName: modifiers.PopName, place: stripHtml(populationName(modifiers)).replace(` — ${modifiers.PopName}`, '') }
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

    mineralLink(shortage) {
      return { path: '/mineral-outlook', query: { mineral: String(shortage.mineralId) } }
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

    categoryCapacity(populationId, category) {
      return category === 'ordnance'
        ? this.populationOrdnanceCapacity(populationId)
        : category === 'fighter'
          ? this.populationFighterCapacity(populationId)
          : this.populationConstructionCapacity(populationId)
    },

    gfccCount(populationId) {
      const facilities = this.facilitiesByColony[populationId]

      return facilities ? facilities.TrainingFacilities : 0
    },

    // BP a year the colony's GFCCs train at 100%: the race's rate per GFCC with its bonuses, times the GFCCs.
    trainingCapacity(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      return modifiers ? modifiers.OverallGroundUnitModifier * this.gfccCount(populationId) : 0
    },

    populationMinConstructionPeriod(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.MinConstructionPeriod
    },
    populationShipyardCapacity(populationId, ship) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.ShipyardBuildRate * (1 + (ship.Size * ship.CommercialModifier / 100 - 1) / 2)
    },
    populationShipyardUpgradeCapacity(populationId, shipyard) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      const commercialModifier = shipyard.SYType === 1 ? 1 : 0.1

      return (1 + (shipyard.Capacity * commercialModifier / 5000 - 1) / 2) * modifiers.ShipyardBuildRate
    },
    populationResearchCapacity(populationId, research) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return research.ActualCommanderResearchBonus * research.ActualAnomalyBonus * modifiers.OverallResearchModifier * research.Facilities
    },

    terraformingRate(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.TerraformingRate
    },
    populationTerraformingRate(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.PopulationTerraformingRate
    },
    populationTerraformingSpeed(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.TerraformingSpeed
    },

    // Null when the yard can't grow (no build rate), which would otherwise never reach the target.
    shipyardContinualRemainingDays(shipyard) {
      const modifiers = this.populationProductionModifiers[shipyard.PopulationID]

      if (!modifiers) {
        return null
      }

      const roi = modifiers.MinConstructionPeriod / SECONDS_PER_YEAR
      const periodDays = modifiers.MinConstructionPeriod / SECONDS_PER_DAY

      let periods = 0
      let lastUpgrade = 0
      let newCapacity = shipyard.Capacity
      do {
        const wat = (120 * shipyard.Slipways) * modifiers.ShipyardOperations
        const stepUpgradeRate = this.populationShipyardUpgradeCapacity(shipyard.PopulationID, {
          SYType: shipyard.SYType,
          Capacity: newCapacity,
        }) * roi

        lastUpgrade = stepUpgradeRate / wat * (shipyard.SYType === 1 ? 500 : 5000)

        if (!(lastUpgrade > 0)) {
          return null
        }

        newCapacity += lastUpgrade
        periods += 1
      } while (newCapacity < shipyard.CapacityTarget)

      return periods * periodDays
    },
  },
  asyncComputed: {
    // Per colony: research facilities and those projects use, GFCCs, and slipways and those tasks take.
    colonyFacilities: {
      get: tracked('colonyFacilities', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const installed = (value) => `coalesce((select sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.${value}) from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and DIM_PlanetaryInstallation.${value} > 0), 0)`

        const [rows] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, ${installed('ResearchValue')} as ResearchFacilities, coalesce((select sum(FCT_ResearchProject.Facilities) from FCT_ResearchProject where FCT_ResearchProject.PopulationID = FCT_Population.PopulationID and FCT_ResearchProject.RaceID = ${this.RaceID}), 0) as ResearchFacilitiesUsed, ${installed('GroundTrainingValue')} as TrainingFacilities, coalesce((select sum(FCT_Shipyard.Slipways) from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.RaceID = ${this.RaceID}), 0) as Slipways, coalesce((select sum(min(FCT_Shipyard.Slipways, (select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID))) from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.RaceID = ${this.RaceID}), 0) as SlipwaysUsed, (select count(*) from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.RaceID = ${this.RaceID}) as Shipyards from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    researches: {
      get: tracked('researches', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { projects: [], queues: [] }
        }

        const [queues] = await this.database.query(`select FCT_ResearchQueue.CurrentProjectID, FCT_ResearchQueue.ResearchOrder, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost, DIM_TechType.FieldID as ProjectField from FCT_ResearchQueue inner join FCT_ResearchProject on FCT_ResearchProject.ProjectID = FCT_ResearchQueue.CurrentProjectID and FCT_ResearchProject.RaceID = ${this.RaceID} left join FCT_TechSystem on FCT_ResearchQueue.TechSystemID = FCT_TechSystem.TechSystemID left join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_ResearchQueue.GameID = ${this.GameID}`)

        const [projects] = await this.database.query(`select FCT_ResearchProject.ProjectID as ID, FCT_Population.PopName, FCT_Population.PopulationID, FCT_TechSystem.Name, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired as RemainingProduction, FCT_ResearchProject.Pause as Paused, COALESCE(VIR_ResearchBonus.CommanderBonus, 1) as CommanderBonus, VIR_ResearchBonus.CommanderField, FCT_ResearchProject.ResSpecID as ProjectField, FCT_AncientConstruct.ResearchField as AnomalyField, FCT_AncientConstruct.ResearchBonus as AnomalyBonus, COALESCE(case when VIR_ResearchBonus.CommanderField = FCT_ResearchProject.ResSpecID then VIR_ResearchBonus.CommanderBonus * 4 - 3 else VIR_ResearchBonus.CommanderBonus end, 1) as ActualCommanderResearchBonus, COALESCE(case when FCT_AncientConstruct.ResearchField = FCT_ResearchProject.ResSpecID then FCT_AncientConstruct.ResearchBonus else 1 end, 1) as ActualAnomalyBonus from FCT_ResearchProject left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as CommanderBonus, FCT_Commander.ResSpecID as CommanderField from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 3 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommanderType in (3,4) and FCT_Commander.CommandType = 7 and FCT_Commander.CommandID <> 0) as VIR_ResearchBonus on VIR_ResearchBonus.CommandID = FCT_ResearchProject.ProjectID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_AncientConstruct on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`)

        return { projects, queues }
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

        const [rows] = await this.database.query(`select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.Description as Name, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause as Paused, FCT_IndustrialProjects.FuelRequired, ${needs}, ${stocks}, FCT_Population.FuelStockpile as StockFuel from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_ShipyardTask.TaskID as ID, FCT_ShipyardTask.TaskTypeID as ShipyardTaskType, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name, FCT_Shipyard.ShipyardName, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingProduction, FCT_ShipyardTask.Paused, (case when FCT_Shipyard.SYType = 1 then 1.0 else 0.25 end) as CommercialModifier from FCT_ShipyardTask left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID where FCT_ShipyardTask.GameID = ${this.GameID} and FCT_ShipyardTask.RaceID = ${this.RaceID}`)

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

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 9, share: 'Industrial' })
      }),
      default: {},
    },
    terraforms: {
      get: tracked('terraforms', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        // A commander without the terraforming bonus counts as 1 (2.7.1 source, Commander.GetBonusValue).
        const [orbitalTerraformers] = await this.database.query(`select sum(FCT_ShipClass.Terraformers * coalesce(FCT_CommanderBonuses.BonusValue, 1)) as Terraformers, FCT_Fleet.ParentCommandID, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.AtmosPress, FCT_SystemBody.Radius, FCT_Population.TerraformStatus, DIM_Gases.Name as GasName, FCT_Population.MaxAtm, FCT_AtmosphericGas.GasAtm from FCT_Ship left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_Population on FCT_Fleet.OrbitBodyID = FCT_Population.SystemBodyID and FCT_Ship.RaceID = FCT_Population.RaceID left join FCT_Commander on FCT_Ship.ShipID = FCT_Commander.CommandID and FCT_Commander.CommandType = 1 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 9 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join FCT_Race on FCT_Population.RaceID = FCT_Race.RaceID left join DIM_Gases on FCT_Population.TerraformingGasID = DIM_Gases.GasID left join FCT_AtmosphericGas on FCT_Population.SystemBodyID = FCT_AtmosphericGas.SystemBodyID and FCT_Population.TerraformingGasID = FCT_AtmosphericGas.AtmosGasID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipClass.Terraformers > 0 and FCT_Population.TerraformingGasID != 0 group by FCT_Population.PopulationID, FCT_Fleet.ParentCommandID`)

        const [planetaryTerraformers] = await this.database.query(`select sum(DIM_PlanetaryInstallation.TerraformValue * FCT_PopulationInstallations.Amount) as Terraformers, NULL as ParentCommandID, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.AtmosPress, FCT_SystemBody.Radius, FCT_Population.TerraformStatus, DIM_Gases.Name as GasName, FCT_Population.MaxAtm, FCT_AtmosphericGas.GasAtm from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_Population on FCT_PopulationInstallations.PopID = FCT_Population.PopulationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join FCT_Race on FCT_Population.RaceID = FCT_Race.RaceID left join DIM_Gases on FCT_Population.TerraformingGasID = DIM_Gases.GasID left join FCT_AtmosphericGas on FCT_Population.SystemBodyID = FCT_AtmosphericGas.SystemBodyID and FCT_Population.TerraformingGasID = FCT_AtmosphericGas.AtmosGasID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.TerraformValue > 0 and FCT_Population.TerraformingGasID != 0 group by FCT_Population.PopulationID`)

        return [
          ...orbitalTerraformers,
          ...planetaryTerraformers,
        ]
      }),
      default: [],
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
    height: 18px;
    line-height: 18px;
  }

  .tool--types {
    flex: 0 1 auto;
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
    margin-top: 8px;
  }

  > .panel {
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

  .panel-foot {
    padding: 12px 24px 16px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
  }

  .dot {
    display: inline-block;
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
