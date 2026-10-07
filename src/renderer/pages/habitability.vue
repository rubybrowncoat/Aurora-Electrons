<template>
  <div>
    <v-container fluid class="planner-page">
      <div class="toolbar">
        <div class="tool tool--species">
          <div class="tool__label caption text--secondary">Species</div>
          <v-select v-model="selectedSpeciesId" :items="speciesItems" item-text="text" item-value="value" aria-label="Species" dense outlined hide-details />
        </div>
        <div class="tool">
          <div class="tool__label caption text--secondary">Goal</div>
          <v-btn-toggle v-model="goal" mandatory dense @change="(value) => config.set('habitabilityGoal', value)">
            <v-tooltip v-for="option in goals" :key="option.id" bottom>
              <template #activator="{ on }">
                <v-btn :value="option.id" small v-on="on"><v-icon small left>{{ option.icon }}</v-icon>{{ option.label }}</v-btn>
              </template>
              <span>{{ option.hint }}</span>
            </v-tooltip>
          </v-btn-toggle>
        </div>
        <div class="tool tool--terraformers">
          <div class="tool__label caption text--secondary">Terraformers</div>
          <v-text-field v-model.number="terraformers" type="number" min="1" aria-label="Terraformers" :rules="[rules.required, rules.positive]" dense outlined hide-details="auto" @change="config.set('habitabilityTerraformers', terraformers)">
            <template #append>
              <v-tooltip bottom max-width="260">
                <template #activator="{ on }">
                  <v-icon small v-on="on">mdi-information-outline</v-icon>
                </template>
                <span>Terraforming: {{ terraformerHint }}</span>
              </v-tooltip>
            </template>
          </v-text-field>
        </div>
        <div class="tool tool--actions">
          <div class="tool__buttons">
            <v-menu offset-y :close-on-content-click="false">
              <template #activator="{ on, attrs }">
                <v-btn outlined v-bind="attrs" v-on="on"><v-icon small left>mdi-filter-variant</v-icon>Filters<span v-if="activeFilterCount">&nbsp;({{ activeFilterCount }})</span></v-btn>
              </template>
              <v-list dense>
                <v-list-item v-for="filter in filterOptions" :key="filter.key">
                  <v-checkbox v-model="filters[filter.key]" :label="filter.label" dense hide-details @change="config.set(filter.config, filters[filter.key])" />
                </v-list-item>
                <v-divider class="my-1" />
                <v-list-item>
                  <v-btn text small @click="resetFilters">Reset Filters</v-btn>
                </v-list-item>
              </v-list>
            </v-menu>
            <v-menu offset-y :close-on-content-click="false" max-width="420">
              <template #activator="{ on, attrs }">
                <v-btn outlined v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Ranking</v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2 mb-1">How targets are ranked</div>
                <div class="caption text--secondary mb-3">A target's worth is its prize (people held, mineral score, or both) divided down by colony cost, years of terraforming and distance. Each divisor halves the worth at the scale you set.</div>
                <v-row dense>
                  <v-col v-for="field in rankingFields" :key="field.key" cols="6">
                    <v-text-field :value="ranking[field.key]" type="number" min="0" :label="field.label" :hint="field.hint" persistent-hint dense outlined @change="(value) => setRanking(field.key, value)" />
                  </v-col>
                </v-row>
                <div class="caption text--secondary mt-2 mb-1">Mineral weights (a point of accessibility is worth this much)</div>
                <v-row dense>
                  <v-col v-for="mineral in minerals" :key="mineral.id" cols="4">
                    <v-text-field :value="ranking.weights[mineral.id]" type="number" min="0" step="0.05" :label="mineral.name" dense outlined hide-details @change="(value) => setWeight(mineral.id, value)" />
                  </v-col>
                </v-row>
                <v-btn text small class="mt-2" @click="resetRanking">Reset ranking</v-btn>
              </v-card>
            </v-menu>
          </div>
        </div>
      </div>

      <v-row dense align="center" class="mt-1">
        <v-col cols="12">
          <div class="tool__label caption text--secondary">Active systems</div>
          <v-autocomplete v-model="systems" :disabled="filterBySelectedBodies" :items="systemNames" aria-label="Active systems" item-text="SystemName" item-value="SystemID" multiple dense outlined hide-details @change="config.set('habitabilitySystems', systems)">
            <template #selection="{ item, index }">
              <v-chip v-if="systems.length === systemNames.length && !index" small label>All {{ systemNames.length }} systems</v-chip>
              <v-chip v-else-if="systems.length !== systemNames.length && index < 8" small label close @click:close="removeSystem(item.SystemID)">{{ item.SystemName }}</v-chip>
              <span v-else-if="systems.length !== systemNames.length && index === 8" class="caption text--secondary ml-1">+{{ systems.length - 8 }} more</span>
            </template>
            <template #prepend-item>
              <v-list-item ripple @click="toggleSystems">
                <v-list-item-action>
                  <v-icon>{{ systems.length > 0 ? (systems.length == systemNames.length ? 'mdi-emoticon-outline' : 'mdi-emoticon-happy-outline') : 'mdi-emoticon-sad-outline' }}</v-icon>
                </v-list-item-action>
                <v-list-item-content>
                  <v-list-item-title>Select All</v-list-item-title>
                </v-list-item-content>
              </v-list-item>
              <v-list-item v-for="preset in systemPresets" :key="preset.key" ripple :input-value="areSetsEqual(new Set(systems), new Set(preset.ids))" @click="selectSystems(preset.ids)">
                <v-list-item-action>
                  <v-icon>{{ preset.icon }}</v-icon>
                </v-list-item-action>
                <v-list-item-content>
                  <v-list-item-title>{{ preset.label }}</v-list-item-title>
                </v-list-item-content>
              </v-list-item>
              <v-divider class="mt-2" />
            </template>
          </v-autocomplete>
        </v-col>
        <v-col cols="12" class="d-flex align-center flex-wrap">
          <span class="tool__label caption text--secondary mr-3">Show</span>
          <v-chip-group v-model="bodyClasses" multiple active-class="class-chip-on" @change="config.set('habitabilityBodyClasses', bodyClasses)">
            <v-chip v-for="option in bodyClassOptions" :key="option.value" :value="option.value" small filter outlined>{{ option.text }}</v-chip>
          </v-chip-group>
          <v-spacer />
          <span class="caption text--secondary summary-line">{{ summaryLine }}</span>
        </v-col>
        <v-col v-if="selectedBodies.length || filterBySelectedBodies" cols="12">
          <v-row dense>
            <v-col cols="auto">
              <v-btn class="d-block mb-1" style="width: 100%" small outlined :color="filterBySelectedBodies ? 'red' : ''" @click="filterBySelectedBodies = !filterBySelectedBodies">Isolate in Planner</v-btn>
              <v-btn :to="{ path: 'minerals', query: { bodies: JSON.stringify(selectedBodies.map(bodyReference)) } }" style="width: 100%" small outlined>Isolate in Minerals</v-btn>
              <v-btn class="d-block mt-4" style="width: 100%" small outlined @click="clearSelection">Clear Selection</v-btn>
            </v-col>
            <v-col>
              <v-chip v-for="body of selectedBodies" :key="body.SystemBodyID" class="mr-2 mb-2" small label outlined close @click:close="() => deselect(body)">{{ body.SystemName }} {{ systemBodyName(body) }}</v-chip>
            </v-col>
          </v-row>
        </v-col>
      </v-row>

      <v-alert v-if="failedInputs.length" type="error" outlined dense class="mt-3">
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate class="mt-3" />
      <v-alert v-else-if="!speciesRows.length" type="info" outlined dense class="mt-3">The race has no colony with a species yet, so there is nothing to compare bodies against.</v-alert>

      <v-card v-if="ready && speciesRows.length" class="mt-3" elevation="2">
        <v-data-table :headers="headers" :items="tableItems" item-key="id" :expanded.sync="expandedRows" show-expand :sort-by.sync="sortBy" :sort-desc.sync="sortDescending" :items-per-page.sync="itemsPerPage" :footer-props="{ itemsPerPageOptions }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
          <template #[`item.data-table-expand`]="{ item, isExpanded, expand }">
            <td class="text-no-wrap">
              <v-btn v-if="isSelected(item.body)" color="red" icon small @click.stop="deselect(item.body)"><v-icon>mdi-playlist-remove</v-icon></v-btn>
              <v-btn v-else icon small @click.stop="select(item.body)"><v-icon>mdi-playlist-plus</v-icon></v-btn>
              <v-btn icon small @click.stop="expand(!isExpanded)"><v-icon>{{ isExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon></v-btn>
            </td>
          </template>

          <template #[`item.sortRank`]="{ item }">
            <div v-if="item.row.rank" class="rank-cell">
              <span class="rank-number">{{ item.row.rank }}</span>
              <span class="score-meter" :title="`Worth ${roundToDecimal(item.row.score, 0)}% of the best target`"><i :style="{ width: `${item.row.score}%` }" /></span>
            </div>
            <span v-else class="caption text--secondary">{{ item.row.settled ? 'Settled' : '' }}</span>
          </template>

          <template #[`item.bodyOrder`]="{ item }">
            <div class="py-1">
              <div class="font-weight-medium text-no-wrap">{{ item.body.SystemName }} {{ systemBodyName(item.body) }}</div>
              <div class="caption text--secondary">
                {{ bodyClassNames[item.body.BodyClass] }}<span v-if="item.body.Banned"> · banned</span>
                <v-chip v-if="item.body.OwnPopulations.length" x-small label color="success" outlined class="ml-1 px-1">Own colony</v-chip>
                <v-chip v-if="item.body.AlienPopulations.length" x-small label color="error" outlined class="ml-1 px-1">Alien colony</v-chip>
              </div>
            </div>
          </template>

          <template #[`item.speciesName`]="{ item }">
            <span v-if="item.best.strategy === 'none'" class="text--secondary">-</span>
            <span v-else>{{ item.best.species.SpeciesName }}</span>
          </template>

          <template #[`item.yearsValue`]="{ item }">
            <v-tooltip v-if="item.best.strategy !== 'none'" top>
              <template #activator="{ on }">
                <v-chip small label :color="item.best.strategy === 'now' ? 'success' : 'warning'" :outlined="item.best.strategy === 'now'" v-on="on">{{ planLabel(item.best) }}</v-chip>
              </template>
              <span>{{ planTooltip(item.best) }}</span>
            </v-tooltip>
            <v-chip v-else small label outlined color="error">{{ item.best.assessment.reason }}</v-chip>
          </template>

          <template #[`item.costValue`]="{ item }">
            <template v-if="item.best.strategy !== 'none'">
              <v-tooltip top>
                <template #activator="{ on }">
                  <span class="text-no-wrap" v-on="on">
                    <template v-if="item.best.strategy === 'terraform'"><span class="text--secondary">{{ costText(item.best.assessment.cost.worst) }}</span> → </template>{{ costText(item.best.cost) }}<span v-if="item.best.lowGravity" class="caption"> LG</span>
                  </span>
                </template>
                <span>{{ costTooltip(item.best) }}</span>
              </v-tooltip>
            </template>
            <span v-else class="text--secondary">N/A</span>
          </template>

          <template #[`item.capacityValue`]="{ item }">
            <span v-if="item.best.strategy !== 'none'" class="text-no-wrap">{{ people(item.best.capacity) }}</span>
            <span v-else class="text--secondary">-</span>
          </template>

          <template #[`item.mineralValue`]="{ item }">
            <div v-if="item.row.minerals.surveyed" class="text-no-wrap">
              <span v-if="item.row.minerals.deposits" class="mineral-score" :class="{ 'mineral-high': item.row.minerals.score >= 5 }">{{ roundToDecimal(item.row.minerals.score, 1) }}</span>
              <span v-else class="text--secondary">None</span>
              <v-tooltip v-if="item.row.minerals.cmc.length" top max-width="340">
                <template #activator="{ on }">
                  <v-chip x-small label outlined class="ml-1 px-1" v-on="on">CMC</v-chip>
                </template>
                <span>Qualifies for a civilian mining complex with {{ item.row.minerals.cmc.join(', ') }}. {{ cmcNote(item.row) }}</span>
              </v-tooltip>
              <span v-if="item.row.minerals.deposits" class="caption text--secondary d-block">{{ compactTons(item.row.minerals.total) }}</span>
            </div>
            <v-tooltip v-else top>
              <template #activator="{ on }">
                <span class="orange--text" v-on="on">Unsurveyed</span>
              </template>
              <span>{{ groundSurveyText(item.body) }}</span>
            </v-tooltip>
          </template>

          <template #[`item.distanceValue`]="{ item }">
            <span v-if="item.row.distance" class="text-no-wrap">{{ roundToDecimal(item.row.distance.au, 1) }} AU<span class="caption text--secondary d-block">{{ item.row.distance.jumps }} {{ item.row.distance.jumps === 1 ? 'jump' : 'jumps' }}</span></span>
            <span v-else class="text--secondary">No route</span>
          </template>

          <template #[`header.sortRank`]="{ header }">
            <v-tooltip top max-width="320">
              <template #activator="{ on }">
                <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
              </template>
              <span>Targets are ranked for the chosen goal. The bar is each target's worth against the best one. Bodies that already have an own colony are not ranked.</span>
            </v-tooltip>
          </template>

          <template #expanded-item="{ item }">
            <td :colspan="headers.length + 1" class="px-4 py-3 planner-detail">
              <body-detail :item="item" :shown="shownEvaluation(item)" :species-options="speciesChoices(item)" :terraform-capacity="terraformCapacityPerYear" :rules="raceRules" :separator="separator" :ranking="ranking" @species="(id) => $set(detailSpecies, item.id, id)" />
            </td>
          </template>
        </v-data-table>
      </v-card>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import BodyDetail from '../components/planner/BodyDetail.vue'
import { areSetsEqual } from '../utilities/generic'
import { systemBodyName } from '../utilities/aurora'
import { people } from '../utilities/colonies'
import { assessBodies, GOALS, normaliseRanking, populationBySystem, rankBodies } from '../utilities/colonization'
import { loadBodies, loadGases, loadRaceRules, loadRoutes, loadSpecies } from '../utilities/colonization-data'
import { buildDistanceMap } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber, thousandsSeparator } from '../utilities/math'
import { CMC_CONFIG_KEY, MINERALS, cmcMineralIds, compact as compactTons } from '../utilities/minerals'
import { terraformCapacity } from '../utilities/terraforming'

const INPUT_LABELS = {
  bodies: 'the bodies of known systems',
  species: 'the species',
  raceRules: 'the race rules',
  gases: 'the gases',
  routes: 'the jump routes',
}
const INPUTS = Object.keys(INPUT_LABELS)

const BODY_CLASS_NAMES = { 1: 'Planet', 2: 'Moon', 3: 'Asteroid', 5: 'Comet' }
const GROUND_SURVEY = { 0: 'Completed', 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }
const NO_RANK = 1e12
const DEFAULT_RULES = () => ({ ColonizationSkill: 1, TerraformingRate: 0, TerraformingSpeed: 100 })

// The filters the page has always kept, by the config key that carries them.
const FILTERS = [
  { key: 'nonTerraformable', config: 'habitabilityFilterNonTerraformable', label: 'Hide Non-Terraformable' },
  { key: 'withoutMinerals', config: 'habitabilityFilterWithoutMinerals', label: 'Hide Without Minerals' },
  { key: 'ownPopulations', config: 'habitabilityFilterOwnPopulations', label: 'Hide Own Populations' },
  { key: 'otherPopulations', config: 'habitabilityFilterOtherPopulations', label: 'Hide Other Populations' },
  { key: 'doneTerraforming', config: 'habitabilityFilterDoneTerraforming', label: 'Hide Terraformed' },
  { key: 'uninhabited', config: 'habitabilityFilterUninhabited', label: 'Hide Uninhabited' },
]

const RANKING_FIELDS = [
  { key: 'minimumDeposit', label: 'Minimum deposit (t)', hint: 'Smaller deposits score nothing' },
  { key: 'cmcBonus', label: 'CMC bonus', hint: 'Mineral score a civilian complex site adds' },
  { key: 'costScale', label: 'Colony cost scale', hint: 'Worth halves at this cost' },
  { key: 'yearsScale', label: 'Terraforming years scale', hint: 'Worth halves after this many years' },
  { key: 'distanceScale', label: 'Distance scale (AU)', hint: 'Worth halves at this distance' },
]

export default {
  components: { BodyDetail },
  asyncData({ route }) {
    if (route.query.bodies) {
      const selectedBodies = JSON.parse(route.query.bodies)

      return { selectedBodies, filterBySelectedBodies: !!selectedBodies.length }
    } else if (route.query.systems) {
      return { systems: route.query.systems.split(',').map((id) => parseInt(id, 10)) }
    }

    return {}
  },
  data() {
    return {
      selectedSpeciesId: null,
      goal: 'both',
      terraformers: 10,
      filters: Object.fromEntries(FILTERS.map((filter) => [filter.key, false])),
      bodyClasses: [1, 2, 3, 5],

      itemsPerPage: 10,
      sortBy: ['sortRank'],
      sortDescending: [false],
      expandedRows: [],
      detailSpecies: {},

      systems: [],
      selectedBodies: [],
      filterBySelectedBodies: false,

      ranking: normaliseRanking(null),
      loadErrors: {},

      rules: {
        required: (value) => !!value || 'Required.',
        positive: (value) => value > 0 || 'Must be positive.',
      },
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    goals: () => GOALS,
    minerals: () => MINERALS,
    filterOptions: () => FILTERS,
    rankingFields: () => RANKING_FIELDS,
    bodyClassNames: () => BODY_CLASS_NAMES,
    bodyClassOptions: () => Object.entries(BODY_CLASS_NAMES).map(([value, text]) => ({ value: Number(value), text: `${text}s` })),
    itemsPerPageOptions: () => [10, 15, 30, 50, 100],
    compactTons: () => compactTons,

    separator() {
      return thousandsSeparator(this.config.get('selectedSeparator', 'Tick'))
    },

    rankingKey() {
      return `game.${this.GameID}.race.${this.RaceID}.targetWeights`
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

    activeFilterCount() {
      return FILTERS.filter((filter) => this.filters[filter.key]).length
    },

    speciesRows() {
      return this.ready ? this.species : []
    },
    speciesItems() {
      return [{ text: 'Best of all species', value: null }, ...this.speciesRows.map((species) => ({ text: `${species.SpeciesName} (${separatedNumber(roundToDecimal(species.TotalPopulation, 2), this.separator)} M)`, value: species.SpeciesID }))]
    },
    // The chosen species, or null (best of all) when it isn't one of the race's any more.
    activeSpeciesId() {
      return this.speciesRows.some((species) => species.SpeciesID === this.selectedSpeciesId) ? this.selectedSpeciesId : null
    },
    terraformCapacityPerYear() {
      return terraformCapacity(this.raceRules, this.terraformers > 0 ? this.terraformers : 0)
    },
    terraformerHint() {
      const { TerraformingRate, TerraformingSpeed } = this.raceRules

      return `${TerraformingRate} atm a year each${TerraformingSpeed === 100 ? '' : `, at ${TerraformingSpeed}% game speed`}`
    },

    cmcIds() {
      return cmcMineralIds(this.config.get(CMC_CONFIG_KEY))
    },
    systemPopulation() {
      return populationBySystem(this.bodies)
    },
    distanceOf() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.capital)
    },

    // The expensive part: every body assessed for every species. It reads neither the goal nor the ranking.
    assessed() {
      return this.ready ? assessBodies(this.bodies, this.species, this.raceRules, (id) => this.gases.find((gas) => gas.GasID === id)) : []
    },
    rows() {
      return rankBodies(this.assessed, { speciesId: this.activeSpeciesId, goal: this.goal, ranking: this.ranking, rules: this.raceRules, terraformers: this.terraformers > 0 ? this.terraformers : 0, distanceOf: this.distanceOf, cmcIds: this.cmcIds, systemPopulation: this.systemPopulation })
    },

    systemNames() {
      const names = new Map()

      this.bodies.forEach((body) => names.set(body.SystemID, body.SystemName))

      return [...names].map(([SystemID, SystemName]) => ({ SystemID, SystemName })).sort((a, b) => (a.SystemName || '').localeCompare(b.SystemName || '', undefined, { numeric: true, sensitivity: 'base' }))
    },
    systemPresets() {
      const systemIds = new Set(this.systemNames.map((system) => system.SystemID))
      const restricted = new Set(this.bodies.filter((body) => body.MilitaryRestrictedSystem).map((body) => body.SystemID))
      const colonised = new Set(this.bodies.filter((body) => body.OwnPopulations.length).map((body) => body.SystemID))
      const inhabited = new Set(this.bodies.filter((body) => body.OwnPopulations.some((population) => population.Population)).map((body) => body.SystemID))
      const presets = [
        { key: 'unrestricted', label: 'Select Unrestricted Systems', icon: 'mdi-billiards-rack', ids: [...systemIds].filter((id) => !restricted.has(id)) },
        { key: 'colonised', label: 'Select Colonized Systems', icon: 'mdi-city-variant-outline', ids: [...colonised] },
        { key: 'inhabited', label: 'Select Inhabited Systems', icon: 'mdi-account-multiple-outline', ids: [...inhabited] },
      ]

      return presets.filter((preset) => preset.ids.length && preset.ids.length !== systemIds.size)
    },

    filteredRows() {
      const { filters } = this
      const scope = this.filterBySelectedBodies ? new Set(this.selectedBodies.map((body) => body.SystemBodyID)) : null
      const systems = new Set(this.systems)
      const classes = new Set(this.bodyClasses)

      return this.rows.filter((row) => {
        const { body, best } = row
        const alienPopulation = body.AlienPopulations.reduce((total, population) => total + population.PopulationAmount, 0)
        const inScope = scope ? scope.has(body.SystemBodyID) : systems.has(body.SystemID) && classes.has(body.BodyClass)

        return (
          inScope &&
          !(filters.nonTerraformable && (best.strategy === 'none' || best.assessment.outcome === 'no')) &&
          !(filters.withoutMinerals && !(row.minerals.total > 0)) &&
          !(filters.ownPopulations && body.OwnPopulations.length) &&
          !(filters.otherPopulations && body.AlienPopulations.length) &&
          !(filters.doneTerraforming && !best.assessment.plan) &&
          !(filters.uninhabited && !(body.OwnPopulations.reduce((total, population) => total + population.Population, 0) + alienPopulation > 0))
        )
      })
    },

    summaryLine() {
      const ranked = this.filteredRows.filter((row) => row.rank).length

      const count = (value, one, many) => `${separatedNumber(value, this.separator)} ${value === 1 ? one : many}`

      return `${count(this.bodies.length, 'body', 'bodies')} in ${count(this.systemNames.length, 'system', 'systems')} · ${separatedNumber(this.filteredRows.length, this.separator)} shown, ${separatedNumber(ranked, this.separator)} ranked`
    },

    // Flat items for the table: the columns sort on plain fields.
    tableItems() {
      return this.filteredRows.map((row) => ({
        id: row.body.SystemBodyID,
        row,
        body: row.body,
        best: row.best,
        sortRank: row.rank || NO_RANK,
        bodyOrder: `${row.body.SystemName} ${row.body.SystemBodyOrder}`,
        speciesName: row.best.strategy === 'none' ? '' : row.best.species.SpeciesName,
        yearsValue: row.best.strategy === 'none' ? NO_RANK : row.best.years,
        costValue: row.best.strategy === 'none' ? NO_RANK : row.best.cost,
        capacityValue: row.best.strategy === 'none' ? 0 : row.best.capacity,
        mineralValue: row.minerals.surveyed ? row.minerals.score : -1,
        distanceValue: row.distance ? row.distance.au : NO_RANK,
      }))
    },

    headers() {
      return [
        { text: '#', value: 'sortRank', divider: true },
        { text: 'Body', value: 'bodyOrder', divider: true, sort: new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare },
        { text: 'Species', value: 'speciesName', divider: true },
        { text: 'Plan', value: 'yearsValue', divider: true },
        { text: 'Colony Cost', value: 'costValue', divider: true },
        { text: 'Holds', value: 'capacityValue', divider: true },
        { text: 'Minerals', value: 'mineralValue', divider: true },
        { text: 'Distance', value: 'distanceValue' },
      ]
    },
  },
  watch: {
    itemsPerPage(value) {
      this.$store.commit('tables/setHabitabilityItemsPerPage', value)
    },
    sortBy: {
      deep: true,
      handler(value) {
        this.$store.commit('tables/setHabitabilitySortBy', value)
      },
    },
    sortDescending: {
      deep: true,
      handler(value) {
        this.$store.commit('tables/setHabitabilitySortDescending', value)
      },
    },
    systemNames: {
      immediate: true,
      handler(names) {
        if (names.length && !this.systems.length) {
          this.systems = names.map((system) => system.SystemID)
        }
      },
    },
    rankingKey: {
      immediate: true,
      handler() {
        this.ranking = normaliseRanking(this.GameID && this.RaceID ? this.config.get(this.rankingKey) : null)
      },
    },
    RaceID(_newRaceID, oldRaceID) {
      if (oldRaceID) {
        this.config.set('habitabilitySystems', [])
        this.systems = []
        this.selectedSpeciesId = null
        this.detailSpecies = {}
      }
    },
  },
  created() {
    this.terraformers = this.config.get('habitabilityTerraformers', 10)
    this.goal = GOALS.some((option) => option.id === this.config.get('habitabilityGoal')) ? this.config.get('habitabilityGoal') : 'both'
    FILTERS.forEach((filter) => (this.filters[filter.key] = !!this.config.get(filter.config, false)))

    const classes = this.config.get('habitabilityBodyClasses')

    if (Array.isArray(classes)) {
      this.bodyClasses = classes.filter((value) => BODY_CLASS_NAMES[value])
    }

    if (!this.systems.length) {
      this.systems = this.config.get('habitabilitySystems', this.systems)
    }

    const { tables } = this.$store.state

    if (tables) {
      this.itemsPerPage = tables.habitabilityItemsPerPage || 10

      if (Array.isArray(tables.habitabilitySortBy) && tables.habitabilitySortBy.length) {
        this.sortBy = [...tables.habitabilitySortBy]
        this.sortDescending = Array.isArray(tables.habitabilitySortDescending) ? [...tables.habitabilitySortDescending] : [false]
      }
    }
  },
  methods: {
    areSetsEqual,
    people,
    roundToDecimal,
    systemBodyName,

    resetFilters() {
      FILTERS.forEach((filter) => {
        this.filters[filter.key] = false
        this.config.set(filter.config, false)
      })
    },

    toggleSystems() {
      this.systems = this.systems.length === this.systemNames.length ? [] : this.systemNames.map((system) => system.SystemID)
      this.config.set('habitabilitySystems', this.systems)
    },
    removeSystem(id) {
      this.systems = this.systems.filter((systemId) => systemId !== id)
      this.config.set('habitabilitySystems', this.systems)
    },
    selectSystems(ids) {
      this.systems = ids
      this.config.set('habitabilitySystems', this.systems)
    },

    setRanking(key, value) {
      this.ranking = normaliseRanking({ ...this.ranking, [key]: value === '' ? null : Number(value) })
      this.config.set(this.rankingKey, this.ranking)
    },
    setWeight(id, value) {
      this.ranking = normaliseRanking({ ...this.ranking, weights: { ...this.ranking.weights, [id]: value === '' ? null : Number(value) } })
      this.config.set(this.rankingKey, this.ranking)
    },
    resetRanking() {
      this.ranking = normaliseRanking(null)
      this.config.set(this.rankingKey, null)
    },

    isSelected(body) {
      return this.selectedBodies.some((selection) => selection.SystemBodyID === body.SystemBodyID)
    },
    select(body) {
      this.selectedBodies.push(this.bodyReference(body))
    },
    deselect(body) {
      this.selectedBodies = this.selectedBodies.filter((selection) => selection.SystemBodyID !== body.SystemBodyID)
    },
    clearSelection() {
      this.selectedBodies = []
      this.filterBySelectedBodies = false
    },
    bodyReference(body) {
      return { SystemBodyID: body.SystemBodyID, SystemBodyName: body.SystemBodyName, SystemName: body.SystemName, BodyClass: body.BodyClass, Component: body.Component, PlanetNumber: body.PlanetNumber, OrbitNumber: body.OrbitNumber }
    },

    // The evaluation the detail panel shows: the species picked there, else the row's best.
    shownEvaluation(item) {
      const picked = this.detailSpecies[item.id]

      return (picked && item.row.evaluations.find((evaluation) => evaluation.species.SpeciesID === picked)) || item.best
    },
    speciesChoices(item) {
      return item.row.evaluations
    },

    years(value) {
      return value === 0 ? 'now' : !Number.isFinite(value) ? 'never' : value < 0.1 ? '< 0.1 y' : `${separatedNumber(roundToDecimal(value, 1), this.separator)} y`
    },
    planLabel(evaluation) {
      return evaluation.strategy === 'now' ? 'Settle now' : `Terraform ${this.years(evaluation.years)}`
    },
    planTooltip(evaluation) {
      if (evaluation.strategy === 'now') {
        return evaluation.assessment.outcome === 'done' ? 'Already liveable for the species.' : 'Worth most settled as it is.'
      }

      return `Terraforming takes ${this.years(evaluation.years)} with ${this.terraformers} terraformers, and leaves a colony cost of ${this.costText(evaluation.cost)} (${this.costText(evaluation.assessment.cost.worst)} now).`
    },
    costText(value) {
      return value === null || value === undefined ? 'N/A' : roundToDecimal(value, 2).toString()
    },
    costTooltip(evaluation) {
      const { cost } = evaluation.assessment

      return `Now ${this.costText(cost.current)}, at periapsis ${this.costText(cost.periapsis)}, at apoapsis ${this.costText(cost.apoapsis)}. The worst of them counts.`
    },
    cmcNote(row) {
      const missing = [!row.cmcSite.populatedSystem && 'an own colony of 10 M in the system', !row.cmcSite.nearStar && 'a body under 80 AU from its star', !row.cmcSite.notBanned && 'a body that is not banned', !row.cmcSite.uncolonised && 'a body with no colony yet'].filter(Boolean)

      return missing.length ? `The game also needs ${missing.join(', ')}.` : 'It meets the game\'s other conditions.'
    },
    groundSurveyText(body) {
      return `No geological survey by this race yet. Ground survey potential: ${GROUND_SURVEY[body.GroundMineralSurvey] || 'unknown'}.`
    },

    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },
  },
  asyncComputed: {
    bodies: {
      get: tracked('bodies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return loadBodies(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    species: {
      get: tracked('species', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return loadSpecies(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    raceRules: {
      get: tracked('raceRules', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return DEFAULT_RULES()
        }

        return loadRaceRules(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: DEFAULT_RULES(),
    },
    gases: {
      get: tracked('gases', async function () {
        return this.database ? loadGases(this.database) : []
      }),
      default: [],
    },
    routes: {
      get: tracked('routes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { jumpPoints: [], capital: null }
        }

        return loadRoutes(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { jumpPoints: [], capital: null },
    },
  },
}
</script>

<style lang="scss">
.planner-page {
  // One density for the controls above the table: every field, toggle and button is 40 px tall, each field has its label above it in the same caption style, and the buttons, which carry their own label, sit on the fields' bottom edge.
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

  .tool--species {
    flex: 1 1 220px;
    max-width: 320px;
  }

  .tool--terraformers {
    flex: 0 0 150px;
  }

  .tool--actions {
    align-self: flex-end;
  }

  .tool__buttons {
    display: flex;
    gap: 8px;
  }

  .toolbar .v-btn-toggle .v-btn,
  .tool__buttons .v-btn {
    height: 40px !important;
  }

  .rank-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rank-number {
    min-width: 28px;
    font-weight: 500;
  }

  .score-meter {
    display: inline-block;
    width: 56px;
    height: 6px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.25);
    overflow: hidden;

    i {
      display: block;
      height: 100%;
      background: var(--sc, #1baf7a);
    }
  }

  .mineral-score {
    font-weight: 500;
  }

  .mineral-high {
    color: var(--sc, #1baf7a);
  }

  .class-chip-on {
    background: var(--sc-soft, rgba(27, 175, 122, 0.15));
  }

  tr.v-data-table__expanded__content {
    box-shadow: none;
  }
}
</style>
