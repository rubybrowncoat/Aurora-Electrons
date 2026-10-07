<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <v-container v-else fluid class="outlook-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Horizon</span>
          <v-btn-toggle v-model="horizon" mandatory dense @change="(value) => config.set('colonyOutlookHorizon', value)">
            <v-btn v-for="option in horizonOptions" :key="option" :value="option" small>{{ option }} y</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="auto" class="mr-4">
          <v-switch v-model="attentionOnly" label="Only colonies that need attention" dense hide-details class="mt-0" @change="(value) => config.set('colonyOutlookAttentionOnly', !!value)" />
        </v-col>
        <v-col cols="12" sm="auto" class="search-field">
          <v-text-field v-model="search" label="Search colonies" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
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

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Colonies</span>
            <span class="legend">
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.service }" />Services</span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.agriculture }" />Agriculture</span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.employed }" />Working</span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.free }" />Free</span>
              <span class="legend-item"><span class="swatch swatch-short" />Short</span>
            </span>
          </div>
          <v-data-table :headers="headers" :items="visibleRows" item-key="PopulationID" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="sortBy" :sort-desc.sync="sortDesc" :items-per-page="25" :footer-props="{ itemsPerPageOptions: [25, 50, -1] }" class="colony-table" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">
                  <v-icon v-if="item.Capital" small class="mr-1" title="Capital">mdi-star</v-icon>{{ item.name }}
                </div>
                <div class="caption text--secondary">{{ item.place }}<span v-if="multiSpecies"> · {{ item.SpeciesName }}</span></div>
              </div>
            </template>
            <template #[`item.populationSort`]="{ item }">
              <div class="text-no-wrap">{{ people(item.Population) }}</div>
              <div class="caption text--secondary text-no-wrap">{{ people(item.projection.final) }} in {{ horizon }} y</div>
            </template>
            <template #[`item.growthSort`]="{ item }">
              <span class="text-no-wrap" :class="{ 'text--secondary': item.growth <= 0 }">{{ percent(item.growth, 2) }}</span>
            </template>
            <template #[`item.fillSort`]="{ item }">
              <div class="fill-cell" :title="`Body holds ${people(item.capacity)}; growth slows past a third`">
                <div class="meter">
                  <div class="meter-fill" :class="{ warning: item.fill > 1 / 3 }" :style="{ width: `${Math.min(100, item.fill * 100)}%` }" />
                  <div class="meter-tick" />
                </div>
                <span class="caption text-no-wrap">{{ percent(item.fill, 0) }} of {{ people(item.capacity) }}</span>
              </div>
            </template>
            <template #[`item.infrastructureSort`]="{ item }">
              <span class="text-no-wrap" :class="{ 'text--secondary': item.infrastructureStatus.muted }">
                <v-icon v-if="item.infrastructureStatus.icon" small :color="item.infrastructureStatus.color">{{ item.infrastructureStatus.icon }}</v-icon>
                {{ item.infrastructureStatus.label }}
              </span>
              <div v-if="item.infrastructureStatus.note" class="caption text--secondary text-no-wrap">{{ item.infrastructureStatus.note }}</div>
            </template>
            <template #[`item.workersSort`]="{ item }">
              <div class="worker-cell">
                <div class="worker-bar" :title="workerTitle(item.workersNow)">
                  <div v-for="segment in workerSegments(item.workersNow)" :key="segment.key" class="worker-segment" :class="segment.className" :style="{ width: `${segment.width}%`, background: segment.color }" />
                </div>
                <span class="caption text-no-wrap" :class="{ 'error--text': item.workersNow.free < -0.005 }">{{ freeLabel(item.workersNow.free) }}</span>
              </div>
            </template>
            <template #[`item.futureSort`]="{ item }">
              <span class="caption text-no-wrap" :class="{ 'error--text': item.workersLater.free < -0.005 }">{{ freeLabel(item.workersLater.free) }}</span>
            </template>
            <template #[`item.inboundSort`]="{ item }">
              <span v-if="item.inbound" class="caption">{{ inboundLabel(item.inbound) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #expanded-item="{ headers: columns, item }">
              <td :colspan="columns.length" class="py-4">
                <v-row>
                  <v-col cols="12" md="7">
                    <div class="chart-title">Population over {{ horizon }} years</div>
                    <chart-canvas type="line" :data="projectionChart(item)" :options="projectionOptions()" :height="220" :label="`Projected population of ${item.name}`" />
                    <div class="caption text--secondary mt-1">{{ projectionNote(item) }}</div>
                  </v-col>
                  <v-col cols="12" md="5">
                    <div class="chart-title">Workers (millions)</div>
                    <v-simple-table dense class="worker-table">
                      <thead>
                        <tr>
                          <th />
                          <th class="text-right">Now</th>
                          <th class="text-right">In {{ horizon }} y</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="line in workerLines" :key="line.key">
                          <td>{{ line.label }}</td>
                          <td class="text-right" :class="line.key === 'free' && item.workersNow.free < -0.005 ? 'error--text' : ''">{{ millions(item.workersNow[line.key]) }}</td>
                          <td class="text-right" :class="line.key === 'free' && item.workersLater.free < -0.005 ? 'error--text' : ''">{{ millions(item.workersLater[line.key]) }}</td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                    <div class="caption text--secondary mt-2">{{ workerNote(item) }}</div>
                  </v-col>
                </v-row>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Growth is an estimate: 20% a year over the cube root of the population (at most 10%), times the species and governor modifiers, slowing past a third of the body's capacity and stopping at the infrastructure cap. Workers needed are today's installations and shipyards. Population in orbit (Ark modules) isn't counted. Colonies short of workers today are also on the
            <nuxt-link to="/warnings">Warnings</nuxt-link> page.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import productionModifiers from '../mixins/production-modifiers'
import { populationName } from '../utilities/aurora'
import { bodyCapacity, growthRate, infrastructureCapacity, infrastructurePerMillion, people, projectBody, workerSplit } from '../utilities/colonies'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'

const INPUT_LABELS = {
  colonies: 'the colonies',
  inbound: 'cargo on its way',
  populationProductionModifiers: 'production modifiers',
}
const INPUTS = Object.keys(INPUT_LABELS)

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'ColonyOutlookPage',
  components: { ChartCanvas },
  mixins: [productionModifiers],
  data() {
    return {
      horizonOptions: [5, 10, 25, 50],
      horizon: 10,
      attentionOnly: false,
      search: '',
      expanded: [],
      sortBy: ['populationSort'],
      sortDesc: [true],
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

    workerColors() {
      const [blue, , green, , pink] = this.theme.categorical

      return { service: withAlpha(blue, 0.45), agriculture: withAlpha(pink, 0.6), employed: blue, free: green }
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

    multiSpecies() {
      return new Set(this.colonies.map((colony) => colony.SpeciesID)).size > 1
    },

    rows() {
      const inbound = Object.fromEntries(this.inbound.map((row) => [row.PopulationID, row]))

      const members = this.colonies.map((colony) => {
        const arriving = inbound[colony.PopulationID] || null
        const inboundInfrastructure = arriving ? arriving.Infrastructure : 0
        // Pre-2.6 saves: a low-gravity body counts only low-gravity infrastructure.
        const infrastructure = (colony.LegacyLowGravity ? colony.LGInfrastructure : colony.Infrastructure + colony.LGInfrastructure) + inboundInfrastructure

        return { colony, arriving, infrastructure, capacity: bodyCapacity(colony), inboundColonists: arriving ? arriving.Colonists : 0, infrastructureCap: infrastructureCapacity(colony, infrastructure) }
      })
      // Populations of the race on one body grow into the same capacity, so they're projected together.
      const bodies = {}

      members.forEach((member) => (bodies[member.colony.SystemBodyID] = bodies[member.colony.SystemBodyID] || []).push(member))

      return members.map((member) => {
        const { colony, arriving, infrastructure, capacity, infrastructureCap } = member
        const group = bodies[colony.SystemBodyID]
        const otherPopulation = Math.max(0, colony.BodyPopulation - colony.Population)
        const projections = projectBody(group, this.horizon)
        const projection = projections[group.indexOf(member)]
        // The rest of the body's population, month by month, as it grows alongside this colony.
        const otherSeries = projection.series.map((_, month) => projections.reduce((sum, other, index) => sum + (group[index] === member ? 0 : other.series[month]), 0))
        // Unconstrained by infrastructure: what it would take to keep growing.
        const potential = infrastructureCap === Infinity ? projection : projectBody(group.map((other) => (other === member ? { ...other, infrastructureCap: Infinity } : other)), this.horizon)[group.indexOf(member)]
        const perMillion = infrastructurePerMillion(colony)
        const infrastructureNeeded = perMillion ? Math.max(0, Math.ceil(potential.final * perMillion - infrastructure)) : 0
        const workersNow = workerSplit(colony, colony.Population)
        const workersLater = workerSplit(colony, projection.final)
        const growth = growthRate(colony, colony.Population, colony.BodyPopulation, capacity)
        const row = {
          ...colony,
          name: colony.PopName,
          place: stripHtml(populationName(colony)).replace(` — ${colony.PopName}`, ''),
          capacity,
          otherPopulation,
          otherSeries,
          fill: (otherPopulation + colony.Population) / capacity,
          growth,
          projection,
          perMillion,
          infrastructure,
          infrastructureCap,
          infrastructureNeeded,
          infrastructureBP: infrastructureNeeded * (colony.InfrastructureCost || 0),
          constructionBP: this.populationConstructionCapacity(colony.PopulationID),
          workersNow,
          workersLater,
          inbound: arriving && (arriving.Colonists || arriving.Infrastructure || arriving.Installations) ? arriving : null,
        }

        row.infrastructureStatus = this.infrastructureStatus(row)
        row.attention = workersNow.free < -0.005 || workersLater.free < -0.005 || projection.infrastructureAt !== null

        return {
          ...row,
          populationSort: colony.Population,
          growthSort: growth,
          fillSort: row.fill,
          infrastructureSort: projection.infrastructureAt === null ? (perMillion ? 1e6 : 2e6) : projection.infrastructureAt,
          workersSort: workersNow.free,
          futureSort: workersLater.free,
          inboundSort: arriving ? arriving.Colonists * 1e6 + arriving.Infrastructure + arriving.Installations : 0,
        }
      })
    },

    visibleRows() {
      const search = (this.search || '').toLowerCase()

      return this.rows.filter((row) => (!this.attentionOnly || row.attention) && (!search || `${row.name} ${row.place}`.toLowerCase().includes(search)))
    },

    tiles() {
      const rows = this.rows
      const now = rows.reduce((sum, row) => sum + row.Population, 0)
      const later = rows.reduce((sum, row) => sum + row.projection.final, 0)
      const shortNow = rows.filter((row) => row.workersNow.free < -0.005)
      const shortLater = rows.filter((row) => row.workersLater.free < -0.005)
      const free = rows.reduce((sum, row) => sum + Math.max(0, row.workersNow.free), 0)
      const capped = rows.filter((row) => row.projection.infrastructureAt !== null)
      const crowded = rows.filter((row) => row.fill > 1 / 3)
      const infrastructure = rows.reduce((sum, row) => sum + row.infrastructureNeeded, 0)
      const infrastructureBP = rows.reduce((sum, row) => sum + row.infrastructureBP, 0)
      const annual = now > 0 ? (later / now) ** (1 / this.horizon) - 1 : 0

      return [
        {
          label: 'Population',
          value: `${people(now)} → ${people(later)}`,
          note: `In ${this.horizon} years, about ${percent(annual, 2)} a year`,
        },
        {
          label: 'Colonies short of workers',
          value: `${shortNow.length} now, ${shortLater.length} in ${this.horizon} y`,
          note: `${this.millions(free)} M free workers elsewhere`,
          icon: shortNow.length ? 'mdi-account-alert' : 'mdi-check-circle',
          iconColor: shortNow.length ? 'warning' : 'success',
        },
        {
          label: `Growth capped within ${this.horizon} y`,
          value: `${capped.length}`,
          note: `${capped.length ? 'By infrastructure. ' : ''}${crowded.length} past a third of their body's capacity`,
          icon: capped.length ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: `Infrastructure for ${this.horizon} years of growth`,
          value: infrastructure ? `${this.count(infrastructure)}` : 'None needed',
          note: infrastructure ? `${this.count(infrastructureBP)} BP, beyond what's built or on its way` : 'Every colony with a colony cost has enough',
        },
      ]
    },

    headers() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Population', value: 'populationSort', align: 'end' },
        { text: 'Growth / yr', value: 'growthSort', align: 'end' },
        { text: 'Body capacity', value: 'fillSort' },
        { text: 'Infrastructure', value: 'infrastructureSort' },
        { text: 'Workers now', value: 'workersSort' },
        { text: `In ${this.horizon} y`, value: 'futureSort', align: 'end' },
        { text: 'On its way', value: 'inboundSort' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    workerLines() {
      return [
        { key: 'population', label: 'Population' },
        { key: 'service', label: 'Services' },
        { key: 'agriculture', label: 'Agriculture and environment' },
        { key: 'available', label: 'Available to work' },
        { key: 'required', label: 'Needed by installations and yards' },
        { key: 'free', label: 'Free (short when negative)' },
      ]
    },
  },
  created() {
    this.horizon = this.config.get('colonyOutlookHorizon', 10)
    this.attentionOnly = this.config.get('colonyOutlookAttentionOnly', false)
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    count(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    millions(value) {
      return separatedNumber(roundToDecimal(value || 0, Math.abs(value) < 10 ? 2 : 1), this.separator)
    },
    people,
    percent,
    years(months) {
      return months < 12 ? `${Math.max(1, months)} mo` : `${roundToDecimal(months / 12, 1)} y`
    },
    freeLabel(free) {
      if (Math.abs(free) < 0.005) {
        return 'Balanced'
      }

      return free < 0 ? `${people(-free)} short` : `${people(free)} free`
    },
    inboundLabel(inbound) {
      return [inbound.Colonists ? `${people(inbound.Colonists)} colonists` : null, inbound.Infrastructure ? `${this.count(inbound.Infrastructure)} infrastructure` : null, inbound.Installations ? `${this.count(inbound.Installations)} installations` : null].filter(Boolean).join(', ')
    },

    infrastructureStatus(row) {
      if (!row.perMillion) {
        return { label: 'Not needed', note: 'No colony cost', icon: null, muted: true }
      }

      const supports = `Supports ${people(row.infrastructureCap)}`

      if (row.projection.infrastructureAt === 0) {
        return { label: 'At its cap', note: supports, icon: 'mdi-alert-octagon', color: 'error' }
      } else if (row.projection.infrastructureAt !== null) {
        return { label: `Cap in ${this.years(row.projection.infrastructureAt)}`, note: supports, icon: 'mdi-alert', color: 'warning' }
      }

      return { label: supports, note: `${this.count(row.perMillion)} per million`, icon: null }
    },

    workerSegments(workers) {
      const total = Math.max(workers.population, workers.service + workers.agriculture + workers.required)

      if (!(total > 0)) {
        return []
      }

      const employed = Math.min(workers.available, workers.required)
      const segments = [
        { key: 'service', value: workers.service, color: this.workerColors.service },
        { key: 'agriculture', value: workers.agriculture, color: this.workerColors.agriculture },
        { key: 'employed', value: employed, color: this.workerColors.employed },
        { key: 'free', value: Math.max(0, workers.free), color: this.workerColors.free },
        { key: 'short', value: Math.max(0, -workers.free), className: 'segment-short' },
      ]

      return segments.filter((segment) => segment.value > 0).map((segment) => ({ ...segment, width: (segment.value / total) * 100 }))
    },
    workerTitle(workers) {
      return `${this.millions(workers.available)} M can work, ${this.millions(workers.required)} M needed`
    },
    workerNote(row) {
      const later = row.workersLater.free

      if (later < -0.005) {
        return `Short of ${people(-later)} in ${this.horizon} years at today's installations: hold off on new ones, or bring colonists.`
      } else if (row.workersNow.free < -0.005) {
        return `Growth closes the gap within ${this.horizon} years.`
      }

      return `Room for about ${this.count(Math.floor(Math.max(0, later) / 0.05))} more factories, mines or similar (50,000 workers each) by then.`
    },

    projectionChart(row) {
      const color = this.theme.primary
      const points = row.projection.series.map((value, month) => ({ x: month / 12, y: value }))
      const peak = Math.max(...row.projection.series)
      // `values` are monthly, like the projection; a limit at or below zero isn't drawn.
      const ceiling = (label, values, dash) => ({
        label,
        data: values.map((value, month) => ({ x: month / 12, y: value > 0 ? value : null })),
        borderColor: this.theme.inkMuted,
        borderDash: dash,
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
      })
      const datasets = [{ label: 'Population', data: points, borderColor: color, backgroundColor: withAlpha(color, 0.1), fill: 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 }]

      // Only limits near the curve: one far above it would flatten it (the note names it instead).
      // Other populations on the body grow too, so the body's limits for this colony move with them.
      const near = (values) => values.some((value) => value > 0 && value !== Infinity && value <= peak * 2)
      const limits = [
        ['Growth slows', row.otherSeries.map((other) => row.capacity / 3 - other), [2, 3]],
        ['Infrastructure cap', row.otherSeries.map(() => row.infrastructureCap), [6, 4]],
        ['Body capacity', row.otherSeries.map((other) => row.capacity - other), [10, 4]],
      ]

      limits.filter(([, values]) => near(values)).forEach(([label, values, dash]) => datasets.push(ceiling(label, values, dash)))

      return { datasets }
    },
    projectionOptions() {
      return {
        scales: {
          x: { type: 'linear', min: 0, max: this.horizon, title: { display: true, text: 'Years from now' } },
          y: { grace: '5%', ticks: { callback: (value) => people(value) } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => `Year ${roundToDecimal(items[0].parsed.x, 1)}`,
              label: (item) => `${item.dataset.label}: ${people(item.parsed.y)}`,
            },
          },
        },
      }
    },
    projectionNote(row) {
      const notes = []

      if (row.infrastructureCap !== Infinity) {
        notes.push(row.projection.infrastructureAt !== null ? `Infrastructure stops growth at ${people(row.infrastructureCap)}.` : `Infrastructure supports ${people(row.infrastructureCap)}.`)

        if (row.infrastructureNeeded) {
          const share = row.constructionBP > 0 ? ` (${this.years(Math.max(1, Math.ceil((row.infrastructureBP / row.constructionBP) * 12)))} of this colony's construction)` : ''

          notes.push(`${this.count(row.infrastructureNeeded)} more infrastructure, ${this.count(row.infrastructureBP)} BP${share}, keeps it growing for ${this.horizon} years.`)
        }
      }

      notes.push(row.fill > 1 / 3 ? 'Past a third of the body\'s capacity, so growth is slowing.' : `Growth starts slowing at ${people(row.capacity / 3)} on this body.`)

      if (row.inbound && row.inbound.Colonists) {
        notes.push(`Includes ${people(row.inbound.Colonists)} colonists on their way.`)
      }

      return notes.join(' ')
    },
  },
  asyncComputed: {
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Efficiency, FCT_Population.ReqInf, FCT_Population.Capital, FCT_Population.SpeciesID, FCT_Species.SpeciesName, FCT_Species.PopulationGrowthModifier, FCT_Species.PopulationDensityModifier, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Radius, FCT_SystemBody.HydroExt, FCT_SystemBody.TidalLock, FCT_SystemBody.RadiationLevel, case when FCT_SystemBody.Gravity < FCT_Species.Gravity - FCT_Species.GravDev then 1 else 0 end as LowGravity, case when VIR_Legacy.Types > 0 and FCT_SystemBody.Gravity < FCT_Species.Gravity - FCT_Species.GravDev then 1 else 0 end as LegacyLowGravity, coalesce(VIR_Installations.Infrastructure, 0) as Infrastructure, coalesce(VIR_Installations.LGInfrastructure, 0) as LGInfrastructure, coalesce(VIR_Installations.Workers, 0) as InstallationWorkers, coalesce(VIR_Yards.Workers, 0) as YardWorkers, coalesce(VIR_Governor.BonusValue, 1) * (1 + (coalesce(VIR_Sector.BonusValue, 1) - 1) * 0.25) as PopulationGrowthBonus, VIR_Body.Population as BodyPopulation, VIR_Legacy.InfrastructureCost from FCT_Population inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID cross join (select sum(case when DIM_PlanetaryInstallation.LGInfrastructureValue > 0 then 1 else 0 end) as Types, min(case when DIM_PlanetaryInstallation.InfrastructureValue > 0 then DIM_PlanetaryInstallation.Cost end) as InfrastructureCost from DIM_PlanetaryInstallation) as VIR_Legacy left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.InfrastructureValue * FCT_PopulationInstallations.Amount) as Infrastructure, sum(DIM_PlanetaryInstallation.LGInfrastructureValue * FCT_PopulationInstallations.Amount) as LGInfrastructure, sum(DIM_PlanetaryInstallation.Workers * FCT_PopulationInstallations.Amount) as Workers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID left join (select FCT_Shipyard.PopulationID, sum(FCT_Shipyard.Capacity * FCT_Shipyard.Slipways * case FCT_Shipyard.SYType when 1 then 1.0 else 0.1 end) / 4000.0 as Workers from FCT_Shipyard where FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID} group by FCT_Shipyard.PopulationID) as VIR_Yards on VIR_Yards.PopulationID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 8 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 8 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_Sector on VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 left join (select FCT_Population.SystemBodyID, sum(FCT_Population.Population) as Population from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemBodyID) as VIR_Body on VIR_Body.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Population > 0 order by FCT_Population.Population desc`).then(([items]) => items)
      }),
      default: [],
    },
    // Colonists (millions) and installations in cargo, by the colony an unload order sends them to.
    inbound: {
      get: tracked('inbound', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.PopulationID, sum(case when FCT_MoveOrders.MoveActionID = 6 and FCT_ShipCargo.CargoTypeID = 1 then FCT_ShipCargo.Amount else 0 end) / 1000000.0 as Colonists, sum(case when FCT_MoveOrders.MoveActionID in (96, 177) and FCT_ShipCargo.CargoTypeID = 2 then FCT_ShipCargo.Amount * (coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0)) else 0 end) as Infrastructure, sum(case when FCT_MoveOrders.MoveActionID in (96, 177) and FCT_ShipCargo.CargoTypeID = 2 and coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0) = 0 then FCT_ShipCargo.Amount else 0 end) as Installations from FCT_MoveOrders inner join FCT_Ship on FCT_Ship.FleetID = FCT_MoveOrders.FleetID inner join FCT_ShipCargo on FCT_ShipCargo.ShipID = FCT_Ship.ShipID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_ShipCargo.CargoID and FCT_ShipCargo.CargoTypeID = 2 where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.MoveActionID in (6, 96, 177) and FCT_MoveOrders.PopulationID <> 0 group by FCT_MoveOrders.PopulationID`).then(([items]) => items)
      }),
      default: [],
    },
  },
}

function percent(fraction, decimals) {
  return `${roundToDecimal((fraction || 0) * 100, decimals).toFixed(decimals)}%`
}
</script>

<style lang="scss">
.outlook-page {
  .search-field {
    min-width: 240px;
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

  .chart-title {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 8px;
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

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    margin-right: 6px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .meter {
    position: relative;
    flex: 0 0 72px;
    height: 6px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.08);
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
    background-color: #6a6a6a;
  }

  .meter-tick {
    position: absolute;
    top: -2px;
    left: 33.3%;
    width: 1px;
    height: 10px;
    background: currentColor;
    opacity: 0.5;
  }

  .fill-cell,
  .worker-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .worker-bar {
    display: flex;
    flex: 0 0 120px;
    height: 10px;
    border-radius: 2px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.06);
  }

  .worker-segment {
    height: 100%;
  }

  .segment-short,
  .swatch-short {
    background-image: repeating-linear-gradient(-45deg, #e34948 0, #e34948 3px, transparent 3px, transparent 6px) !important;
  }

  .worker-table td,
  .worker-table th {
    font-variant-numeric: tabular-nums;
  }
}

.theme--dark .outlook-page {
  .meter,
  .worker-bar {
    background: rgba(255, 255, 255, 0.12);
  }

  .meter-fill {
    background-color: #b0b0b0;
  }
}
</style>
