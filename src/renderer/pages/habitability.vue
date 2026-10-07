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
        <div class="tool tool--systems">
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
        </div>
        <div class="tool tool--actions">
          <div class="tool__buttons">
            <v-menu offset-y :close-on-content-click="false">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Filters" v-bind="attrs" v-on="on"><v-icon small left>mdi-filter-variant</v-icon><span class="tool__btn-label">Filters</span><span v-if="activeFilterCount">&nbsp;({{ activeFilterCount }})</span></v-btn>
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
            <v-menu offset-y left :close-on-content-click="false" max-width="520">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Ranking" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon><span class="tool__btn-label">Ranking</span></v-btn>
              </template>
              <v-card class="pa-4 planner-menu">
                <div class="subtitle-2 mb-1">How targets are ranked</div>
                <div class="caption text--secondary mb-3">
                  A body's worth is its prize (the people it holds, what its deposits are worth, or both), times three discounts that each halve it at the scale below: colony cost (before your colonisation tech, so the scale means the same for every race), years of terraforming, and AU from your nearest colony. Only a place to settle that holds the smallest colony or has deposits worth mining is ranked, and a target is "best" from {{ bestScore }}% of the top one. The defaults work as they are.
                </div>
                <v-row dense>
                  <v-col v-for="field in rankingFields" :key="field.key" cols="12" sm="6">
                    <v-text-field :value="ranking[field.key]" type="number" min="0" :label="field.label" :hint="field.hint" persistent-hint dense outlined @change="(value) => setRanking(field.key, value)" />
                  </v-col>
                </v-row>
                <div class="caption text--secondary mt-2 mb-1">Mineral weights. Each deposit's value (the game's own: accessibility, raised for a big deposit) is multiplied by its weight and by how short you are of that mineral.</div>
                <v-row dense>
                  <v-col v-for="mineral in minerals" :key="mineral.id" cols="6" sm="4">
                    <v-text-field :value="ranking.weights[mineral.id]" type="number" min="0" step="0.05" :label="mineral.name" :hint="scarcityHint(mineral.id)" persistent-hint dense outlined @change="(value) => setWeight(mineral.id, value)" />
                  </v-col>
                </v-row>
                <v-btn text small class="mt-2" @click="resetRanking">Reset ranking</v-btn>
              </v-card>
            </v-menu>
            <v-menu offset-y left :close-on-content-click="false" max-width="640">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Plan states" v-bind="attrs" v-on="on"><v-icon small left>mdi-help-circle-outline</v-icon><span class="tool__btn-label">Plan states</span></v-btn>
              </template>
              <v-card class="pa-4 planner-menu">
                <div class="subtitle-2 mb-1">What each plan state means</div>
                <div class="caption text--secondary mb-3">
                  The Plan column says what it takes to settle a body. Colony cost bands are read before your colonisation tech{{ raceRules.ColonizationSkill !== 1 ? ` (×${raceRules.ColonizationSkill} here)` : '' }}, as the game's Minerals window colours them; the infrastructure per million people (/M) is what you actually pay. Click a state to show only those bodies.
                </div>
                <div v-for="group in stateGroups" :key="group.group" class="mb-2">
                  <div class="overline">{{ group.group }}</div>
                  <div v-for="state in group.states" :key="state.id" class="legend-row" :class="{ 'legend-row--on': stateFilter.includes(state.id) }" @click="toggleStateFilter(state.id)">
                    <v-chip small label :color="state.color" class="legend-chip" dark><v-icon x-small left>{{ state.icon }}</v-icon>{{ state.label }}</v-chip>
                    <span class="legend-rule">{{ state.rule }}</span>
                    <span class="legend-count">{{ separatedNumber(stateCounts[state.id] || 0, separator) }}</span>
                  </div>
                </div>
                <v-btn v-if="stateFilter.length" text small @click="stateFilter = []">Show all states</v-btn>
              </v-card>
            </v-menu>
          </div>
        </div>
      </div>

      <v-row dense align="center" class="mt-1">
        <v-col cols="12" class="d-flex align-center flex-wrap view-row">
          <v-btn-toggle v-model="view" mandatory dense class="mr-4" @change="(value) => config.set('habitabilityView', value)">
            <v-tooltip v-for="option in viewOptions" :key="option.id" bottom max-width="300">
              <template #activator="{ on }">
                <v-btn :value="option.id" small v-on="on">{{ option.label }}<span class="view-count">{{ separatedNumber(viewCounts[option.id], separator) }}</span></v-btn>
              </template>
              <span>{{ option.hint }}</span>
            </v-tooltip>
          </v-btn-toggle>
          <span class="tool__label caption text--secondary mr-3">Show</span>
          <v-chip-group v-model="bodyClasses" multiple active-class="class-chip-on" @change="config.set('habitabilityBodyClasses', bodyClasses)">
            <v-chip v-for="option in bodyClassOptions" :key="option.value" :value="option.value" small filter outlined>{{ option.text }}</v-chip>
          </v-chip-group>
          <v-chip v-for="id in stateFilter" :key="id" small label close :color="stateById[id].color" dark class="mr-1" @click:close="toggleStateFilter(id)">{{ stateById[id].label }}</v-chip>
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
            <span v-else class="caption text--secondary">{{ item.row.settled ? 'Yours' : '' }}</span>
          </template>

          <template #[`item.bodyOrder`]="{ item }">
            <div class="py-1">
              <div class="font-weight-medium text-no-wrap">{{ item.body.SystemName }} {{ systemBodyName(item.body) }}</div>
              <div class="caption text--secondary">
                {{ bodyClassNames[item.body.BodyClass] }}<span v-if="item.body.Banned"> · banned</span>
              </div>
            </div>
          </template>

          <template #[`item.speciesName`]="{ item }">
            <span v-if="item.best.strategy === 'none'" class="text--secondary">-</span>
            <span v-else>{{ item.best.species.SpeciesName }}</span>
          </template>

          <template #[`item.stateOrder`]="{ item }">
            <v-tooltip top max-width="360">
              <template #activator="{ on }">
                <v-chip small label :color="item.row.state.color" :dark="item.row.state.target" :outlined="!item.row.state.target" class="plan-chip" v-on="on"><v-icon x-small left>{{ item.row.state.icon }}</v-icon>{{ item.row.state.chip(item.row.facts) }}</v-chip>
              </template>
              <span>{{ stateTooltip(item.row) }}</span>
            </v-tooltip>
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
              <v-tooltip v-if="item.row.minerals.deposits" top max-width="360">
                <template #activator="{ on }">
                  <span class="mineral-score" :class="{ 'mineral-high': item.row.minerals.rich }" v-on="on">{{ roundToDecimal(item.row.minerals.value, 1) }}</span>
                </template>
                <span>{{ mineralTooltip(item.row) }}</span>
              </v-tooltip>
              <span v-else class="text--secondary">None</span>
              <v-chip v-if="item.row.minerals.rich" x-small label color="amber darken-3" dark class="ml-1 px-1">Rich</v-chip>
              <v-tooltip v-if="item.row.minerals.cmc.length" top max-width="340">
                <template #activator="{ on }">
                  <v-chip x-small label outlined class="ml-1 px-1" v-on="on">CMC</v-chip>
                </template>
                <span>Qualifies for a civilian mining complex with {{ item.row.minerals.cmc.join(', ') }}. {{ cmcNote(item.row) }}</span>
              </v-tooltip>
              <span v-if="item.row.minerals.deposits" class="caption text--secondary d-block mineral-note">{{ compactTons(item.row.minerals.total) }}<template v-if="scarceNames(item.row)"> · short of {{ scarceNames(item.row) }}</template></span>
            </div>
            <v-tooltip v-else top>
              <template #activator="{ on }">
                <span class="orange--text" v-on="on">Unsurveyed</span>
              </template>
              <span>{{ groundSurveyText(item.body) }}</span>
            </v-tooltip>
          </template>

          <template #[`item.distanceValue`]="{ item }">
            <v-tooltip v-if="item.row.distance" top max-width="320">
              <template #activator="{ on }">
                <span class="text-no-wrap" v-on="on">{{ roundToDecimal(item.row.distance.au, 1) }} AU<span class="caption text--secondary d-block">{{ item.row.distance.jumps }} {{ item.row.distance.jumps === 1 ? 'jump' : 'jumps' }}</span></span>
              </template>
              <span>{{ distanceTooltip(item.row) }}</span>
            </v-tooltip>
            <span v-else class="text--secondary">No route</span>
          </template>

          <template #[`header.sortRank`]="{ header }">
            <v-tooltip top max-width="320">
              <template #activator="{ on }">
                <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
              </template>
              <span>Targets are ranked for the chosen goal. The bar is each target's worth against the best one. Colonies, alien colonies, bodies no species can live on and bodies too small to be worth the trip are not ranked.</span>
            </v-tooltip>
          </template>

          <template #expanded-item="{ item }">
            <td :colspan="headers.length + 1" class="px-4 py-3 planner-detail">
              <body-detail :item="item" :shown="shownEvaluation(item)" :species-options="speciesChoices(item)" :terraform-capacity="terraformCapacityPerYear" :rules="raceRules" :separator="separator" @species="(id) => $set(detailSpecies, item.id, id)" />
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
import { assessBodies, BEST_TARGET_SCORE, GOALS, normaliseRanking, NO_OUTLOOK, populationBySystem, rankBodies } from '../utilities/colonization'
import { loadBodies, loadGases, loadMineralOutlook, loadRaceRules, loadRoutes, loadSpecies } from '../utilities/colonization-data'
import { PLAN_STATES, STATE_BY_ID, STATE_GROUPS } from '../utilities/colonization-states'
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
  outlook: 'the mineral outlook',
}
const INPUTS = Object.keys(INPUT_LABELS)

const BODY_CLASS_NAMES = { 1: 'Planet', 2: 'Moon', 3: 'Asteroid', 5: 'Comet' }
const GROUND_SURVEY = { 0: 'Completed', 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }
const NO_RANK = 1e12
// Rows per page before the user picks one: 10 fit a 1080 px window, 15 a window of 1200 px or more.
const DEFAULT_ROWS = 10
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
  { key: 'minimumPeople', label: 'Smallest colony (M)', hint: 'Under this a body is only a target for its deposits' },
  { key: 'minimumDeposit', label: 'Minimum deposit (t)', hint: 'Smaller deposits are worth nothing' },
  { key: 'cmcBonus', label: 'CMC bonus', hint: 'Deposit value a civilian complex site adds' },
  { key: 'costScale', label: 'Colony cost scale', hint: 'Worth halves at this cost, before your tech' },
  { key: 'yearsScale', label: 'Terraforming years scale', hint: 'Worth halves after this many years' },
  { key: 'distanceScale', label: 'Distance scale (AU)', hint: 'Worth halves at this distance from a colony' },
]

// Which bodies the table lists. A body is in the first view that its rank and plan state fit.
const VIEWS = [
  { id: 'best', label: 'Best targets', hint: `Places to settle next that are worth at least ${BEST_TARGET_SCORE}% of the best one`, has: (row) => !!row.rank && row.score >= BEST_TARGET_SCORE },
  { id: 'ranked', label: 'All ranked', hint: 'Every ranked place to settle, from the best down', has: (row) => !!row.rank },
  { id: 'colonies', label: 'Colonies', hint: 'Bodies where you already have a colony or outpost', has: (row) => row.settled },
  { id: 'other', label: 'Other bodies', hint: 'Everything else: alien colonies, bodies nobody can live on, and bodies too small or poor to be worth the trip', has: (row) => !row.rank && !row.settled },
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
      view: 'best',
      stateFilter: [],
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
    viewOptions: () => VIEWS,
    stateGroups: () => STATE_GROUPS,
    stateById: () => STATE_BY_ID,
    bestScore: () => BEST_TARGET_SCORE,
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
    // Travel is measured from the nearest sizeable colony (the capital among them), and from the capital alone.
    distanceOf() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.colonies)
    },
    capitalDistanceOf() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.capital ? [this.routes.capital] : [])
    },

    // The expensive part: every body assessed for every species. It reads neither the goal nor the ranking.
    assessed() {
      return this.ready ? assessBodies(this.bodies, this.species, this.raceRules, (id) => this.gases.find((gas) => gas.GasID === id)) : []
    },
    rows() {
      return rankBodies(this.assessed, { speciesId: this.activeSpeciesId, goal: this.goal, ranking: this.ranking, rules: this.raceRules, terraformers: this.terraformers > 0 ? this.terraformers : 0, distanceOf: this.distanceOf, capitalDistanceOf: this.capitalDistanceOf, cmcIds: this.cmcIds, systemPopulation: this.systemPopulation, outlook: this.outlook })
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

    // The bodies of the chosen systems and body classes, or just the isolated ones.
    scopedRows() {
      const scope = this.filterBySelectedBodies ? new Set(this.selectedBodies.map((body) => body.SystemBodyID)) : null
      const systems = new Set(this.systems)
      const classes = new Set(this.bodyClasses)

      return this.rows.filter((row) => (scope ? scope.has(row.body.SystemBodyID) : systems.has(row.body.SystemID) && classes.has(row.body.BodyClass)))
    },
    viewCounts() {
      return Object.fromEntries(VIEWS.map((view) => [view.id, this.scopedRows.filter(view.has).length]))
    },
    stateCounts() {
      const counts = {}

      this.scopedRows.forEach((row) => {
        counts[row.state.id] = (counts[row.state.id] || 0) + 1
      })

      return counts
    },

    filteredRows() {
      const { filters } = this
      const view = VIEWS.find((option) => option.id === this.view) || VIEWS[0]
      const states = new Set(this.stateFilter)

      return this.scopedRows.filter((row) => {
        const { body, best } = row
        const alienPopulation = body.AlienPopulations.reduce((total, population) => total + population.PopulationAmount, 0)

        return (
          (this.filterBySelectedBodies || (view.has(row) && (!states.size || states.has(row.state.id)))) &&
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
      const count = (value, one, many) => `${separatedNumber(value, this.separator)} ${value === 1 ? one : many}`

      return `${count(this.bodies.length, 'body', 'bodies')} in ${count(this.systemNames.length, 'system', 'systems')} · ${separatedNumber(this.filteredRows.length, this.separator)} shown`
    },

    // Flat items for the table: the columns sort on plain fields.
    tableItems() {
      return this.filteredRows.map((row) => ({
        id: row.body.SystemBodyID,
        row,
        body: row.body,
        best: row.best,
        sortRank: row.rank || NO_RANK - (row.best.strategy === 'none' ? 0 : row.best.capacity),
        stateOrder: PLAN_STATES.indexOf(row.state),
        bodyOrder: `${row.body.SystemName} ${row.body.SystemBodyOrder}`,
        speciesName: row.best.strategy === 'none' ? '' : row.best.species.SpeciesName,
        costValue: row.best.strategy === 'none' ? NO_RANK : row.best.cost,
        capacityValue: row.best.strategy === 'none' ? 0 : row.best.capacity,
        mineralValue: row.minerals.surveyed ? row.minerals.value : -1,
        distanceValue: row.distance ? row.distance.au : NO_RANK,
      }))
    },

    headers() {
      return [
        { text: '#', value: 'sortRank', divider: true },
        { text: 'Body', value: 'bodyOrder', divider: true, sort: new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare },
        { text: 'Species', value: 'speciesName', divider: true },
        { text: 'Plan', value: 'stateOrder', divider: true },
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
    this.view = VIEWS.some((option) => option.id === this.config.get('habitabilityView')) ? this.config.get('habitabilityView') : 'best'
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
      this.itemsPerPage = tables.habitabilityItemsPerPage > DEFAULT_ROWS ? tables.habitabilityItemsPerPage : this.rowsToFit()

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
    separatedNumber,
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
      return !Number.isFinite(value) ? 'never' : value < 0.1 ? '< 0.1 y' : `${separatedNumber(roundToDecimal(value, 1), this.separator)} y`
    },
    rowsToFit() {
      return typeof window !== 'undefined' && window.innerHeight >= 1200 ? 15 : DEFAULT_ROWS
    },
    toggleStateFilter(id) {
      this.stateFilter = this.stateFilter.includes(id) ? this.stateFilter.filter((one) => one !== id) : [...this.stateFilter, id]
    },
    // What the state says for this body, then how the ranking reads it.
    stateTooltip(row) {
      const { state, best } = row
      const ranked = row.rank ? ` Ranked ${row.rank} of the targets, ${best.strategy === 'terraform' ? `after ${this.years(best.years)} of terraforming` : 'settled as it is'}.` : state.target ? ' Not ranked: too small or poor to be worth the trip (see Ranking).' : ''

      return `${state.text(row.facts)}${ranked}`
    },
    // The scarce minerals the body holds, the first two by name.
    scarceNames(row) {
      const names = row.minerals.lines.filter((line) => line.value > 0 && line.scarcity.factor > 1).map((line) => line.name)

      return `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
    },
    mineralTooltip(row) {
      const lines = row.minerals.lines.filter((line) => line.value > 0).slice(0, 5).map((line) => `${line.name} ${roundToDecimal(line.value, 1)}${line.scarcity.factor > 1 ? ` (x${line.scarcity.factor}, ${line.scarcity.label.toLowerCase()})` : ''}`)

      return `Deposit value ${roundToDecimal(row.minerals.value, 1)}, rich from 6: ${lines.join(', ') || 'no deposit worth counting'}.`
    },
    distanceTooltip(row) {
      const { distance, capitalDistance } = row
      const capital = capitalDistance && distance.from && !distance.from.Capital ? ` The capital is ${roundToDecimal(capitalDistance.au, 1)} AU and ${capitalDistance.jumps} ${capitalDistance.jumps === 1 ? 'jump' : 'jumps'} away.` : ''

      return `${roundToDecimal(distance.au, 1)} AU by the charted route from ${distance.from ? distance.from.PopName.replace(/<[^>]*>/g, '') : 'your nearest colony'}, ${distance.jumps} ${distance.jumps === 1 ? 'jump' : 'jumps'}.${capital}`
    },
    scarcityHint(id) {
      const mineral = this.outlook.minerals[id]

      if (!this.outlook.known) {
        return 'No ledger in this save'
      }

      return mineral && mineral.scarcity.factor > 1 ? `x${mineral.scarcity.factor}: ${mineral.scarcity.label.toLowerCase()}, ${this.years(mineral.runway)}` : 'Not short'
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
          return { jumpPoints: [], capital: null, colonies: [] }
        }

        return loadRoutes(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { jumpPoints: [], capital: null, colonies: [] },
    },
    outlook: {
      get: tracked('outlook', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_OUTLOOK
        }

        return loadMineralOutlook(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: NO_OUTLOOK,
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

  // One row from 1280 px up: the species, goal and terraformers keep their size, the systems field takes what is
  // left (so it grows on a wide window) and the buttons lose their labels below 1500 px. Narrower windows wrap.
  .tool--species {
    flex: 0 1 260px;
    min-width: 180px;
  }

  .tool--terraformers {
    flex: 0 0 130px;
  }

  .tool--systems {
    flex: 1 1 240px;
  }

  @media (max-width: 1499px) {
    .tool__btn-label {
      display: none;
    }

    .tool__buttons .v-btn {
      min-width: 40px !important;
      padding: 0 12px !important;
    }

    .tool__buttons .v-btn .v-icon--left {
      margin-right: 0;
    }
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

  .mineral-note {
    max-width: 220px;
    white-space: normal;
  }

  .mineral-high {
    color: var(--sc, #1baf7a);
  }

  .view-count {
    margin-left: 6px;
    opacity: 0.65;
    font-weight: 400;
  }

  .class-chip-on {
    background: var(--sc-soft, rgba(27, 175, 122, 0.15));
  }

  tr.v-data-table__expanded__content {
    box-shadow: none;
  }
}

.planner-menu {
  max-height: calc(100vh - 96px);
  overflow-y: auto;

  .legend-row {
    display: grid;
    grid-template-columns: 150px 1fr 52px;
    align-items: start;
    gap: 4px 12px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;

    &:hover {
      background: rgba(128, 128, 128, 0.12);
    }
  }

  .legend-row--on {
    background: var(--sc-soft, rgba(27, 175, 122, 0.15));
  }

  .legend-rule {
    font-size: 13px;
    line-height: 20px;
  }

  .legend-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    line-height: 24px;
  }
}
</style>
