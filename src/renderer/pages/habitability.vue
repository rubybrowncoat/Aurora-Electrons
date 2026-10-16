<template>
  <div>
    <v-container fluid class="planner-page" :style="sectionColors">
      <div class="toolbar">
        <div class="tool tool--species">
          <div class="tool__label caption text--secondary">Species<provenance-mark v-if="speciesPopulationGap" :result="speciesPopulationGap" /></div>
          <v-select v-model="selectedSpeciesId" :items="speciesItems" item-text="text" item-value="value" aria-label="Species" dense outlined hide-details />
        </div>
        <div class="tool">
          <div class="tool__label caption text--secondary">Goal</div>
          <v-btn-toggle v-model="goal" mandatory dense>
            <v-tooltip v-for="option in goals" :key="option.id" bottom>
              <template #activator="{ on }">
                <v-btn :value="option.id" small v-on="on"><v-icon small left>{{ option.icon }}</v-icon>{{ option.label }}</v-btn>
              </template>
              <span>{{ option.hint }}</span>
            </v-tooltip>
          </v-btn-toggle>
        </div>
        <div class="tool tool--terraformers">
          <div class="tool__label caption text--secondary">Terraformers<provenance-mark :result="terraformResult" /></div>
          <v-text-field v-model.number="terraformers" type="number" min="1" aria-label="Terraformers" :rules="[rules.required, rules.positive]" dense outlined hide-details="auto">
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
          <system-select v-model="systems" :disabled="filterBySelectedBodies" :items="systemNames" aria-label="Active systems" item-text="SystemName" item-value="SystemID" multiple dense outlined hide-details>
            <template #selection="{ item, index }">
              <v-chip v-if="systemSelection.all && !index" small label>All {{ systemSelection.total }} systems</v-chip>
              <v-chip v-else-if="!systemSelection.all && index < 8" small label close @click:close="removeSystem(item.SystemID)">{{ item.SystemName }}</v-chip>
              <span v-else-if="!systemSelection.all && index === 8" class="caption text--secondary ml-1">+{{ systemSelection.count - 8 }} more</span>
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
          </system-select>
        </div>
        <div class="tool tool--actions">
          <div class="tool__buttons">
            <v-menu offset-y :close-on-content-click="false">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Filters" v-bind="attrs" v-on="on"><v-icon small left>mdi-filter-variant</v-icon><span class="tool__btn-label">Filters</span><span v-if="activeFilterCount">&nbsp;({{ activeFilterCount }})</span></v-btn>
              </template>
              <v-list dense>
                <v-list-item v-for="filter in filterOptions" :key="filter.key">
                  <v-checkbox :input-value="filters[filter.key]" :label="filter.label" dense hide-details @change="(value) => setFilter(filter, value)" />
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
              <v-card class="pa-4 planner-menu" :style="sectionColors">
                <div class="subtitle-2 mb-1">How targets are ranked</div>
                <div class="caption text--secondary mb-3">
                  A body's worth is its prize (the people it holds, what its deposits are worth, or both), times three discounts that each halve it at the scale below: colony cost (before the race's colonisation tech, so the scale means the same for every race), years of terraforming, and AU from the nearest colony. Only a place to settle that holds the smallest colony or has deposits worth mining is ranked, and a target is "best" from {{ bestScore }}% of the top one. The defaults work as they are.
                </div>
                <v-row dense>
                  <v-col v-for="field in rankingFields" :key="field.key" cols="12" sm="6">
                    <v-text-field :value="ranking[field.key]" type="number" min="0" :label="field.label" :hint="field.hint" persistent-hint dense outlined @change="(value) => setRanking(field.key, value)" />
                  </v-col>
                </v-row>
                <div class="caption text--secondary mt-2 mb-1">Mineral weights. Each deposit's value (the game's own: accessibility, raised for a big deposit) is multiplied by its weight and by how short the race is of that mineral.</div>
                <v-row dense>
                  <v-col v-for="mineral in minerals" :key="mineral.id" cols="6" sm="4">
                    <v-text-field :value="ranking.weights[mineral.id]" type="number" min="0" step="0.05" :label="mineral.name" :hint="scarcityHint(mineral.id)" persistent-hint dense outlined @change="(value) => setWeight(mineral.id, value)" />
                  </v-col>
                </v-row>
                <v-btn text small class="mt-2" @click="resetRanking">Reset ranking</v-btn>
              </v-card>
            </v-menu>
            <v-menu offset-y left :close-on-content-click="false" max-width="520">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Transit" v-bind="attrs" v-on="on"><v-icon small left>mdi-transit-connection-variant</v-icon><span class="tool__btn-label">Transit</span></v-btn>
              </template>
              <v-card class="pa-4 planner-menu" :style="sectionColors">
                <div class="subtitle-2 mb-1">How transit is estimated<provenance-mark rule="habitability.transitSpeed" /></div>
                <div class="caption text--secondary mb-3">
                  The Transit column estimates one representative ship flying one way from the nearest colony with people to a body, by the shortest route over the jump points the race has explored. The speed and the drive are chosen here and never reveal a system or a jump point the race has not found. Planets, moons and the colonies on them keep moving, so every leg inside a system is as saved. Military restriction, danger and alien systems are not applied.
                </div>
                <v-row dense>
                  <v-col cols="12" sm="6">
                    <v-text-field :value="transitSpeed" type="number" min="0" label="Speed (km/s)" hint="Blank: no time, only jumps and distance" persistent-hint :rules="[rules.speed]" dense outlined @change="setTransitSpeed" />
                  </v-col>
                  <v-col cols="12" sm="6">
                    <v-select :value="pickedClass" :items="transitClassItems" item-text="text" item-value="id" label="Take from a ship class" :hint="transitClassItems.length ? 'Its top speed and whether its own jump drive carries it' : 'The race has no ship that moves'" persistent-hint :disabled="!transitClassItems.length" dense outlined @change="takeClass" />
                  </v-col>
                </v-row>
                <div class="tool__label caption text--secondary mt-2">Crossing jump points</div>
                <v-btn-toggle v-model="transitDrive" mandatory dense>
                  <v-tooltip v-for="option in drives" :key="option.id" bottom max-width="300">
                    <template #activator="{ on }">
                      <v-btn :value="option.id" small v-on="on">{{ option.label }}</v-btn>
                    </template>
                    <span>{{ option.hint }}</span>
                  </v-tooltip>
                </v-btn-toggle>
                <v-switch v-model="transitLagrange" label="Jump between Lagrange points when shorter" dense hide-details class="mt-3" />
                <div class="tool__label caption text--secondary mt-2">Sort the Transit column by</div>
                <v-btn-toggle v-model="transitSort" mandatory dense>
                  <v-tooltip v-for="option in transitSorts" :key="option.id" bottom max-width="300">
                    <template #activator="{ on }">
                      <v-btn :value="option.id" small v-on="on">{{ option.label }}</v-btn>
                    </template>
                    <span>{{ option.hint }}</span>
                  </v-tooltip>
                </v-btn-toggle>
              </v-card>
            </v-menu>
            <v-menu offset-y left :close-on-content-click="false" max-width="640">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Plan states" v-bind="attrs" v-on="on"><v-icon small left>mdi-help-circle-outline</v-icon><span class="tool__btn-label">Plan states</span></v-btn>
              </template>
              <v-card class="pa-4 planner-menu" :style="sectionColors">
                <div class="subtitle-2 mb-1">What each plan state means<provenance-mark :result="countsResult" /></div>
                <div class="caption text--secondary mb-3">
                  The Plan column says what it takes to settle a body. Colony cost bands are read before the race's colonisation tech{{ skillNote }}, as the game's Minerals window colours them; the infrastructure per million people (/M) is what the race actually pays. Click a state to show only those bodies.
                </div>
                <div v-for="group in stateGroups" :key="group.group" class="mb-2">
                  <div class="overline">{{ group.group }}</div>
                  <div v-for="state in group.states" :key="state.id" class="legend-row" :class="{ 'legend-row--on': stateFilter.includes(state.id) }" @click="toggleStateFilter(state.id)">
                    <v-chip small label :color="tone(state.color)" class="legend-chip" dark><v-icon x-small left>{{ state.icon }}</v-icon>{{ state.label }}</v-chip>
                    <span class="legend-rule">{{ state.rule }}</span>
                    <span class="legend-count">{{ countOf(stateCounts, state.id) }}</span>
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
          <v-btn-toggle v-model="view" mandatory dense class="mr-4">
            <v-tooltip v-for="option in viewOptions" :key="option.id" bottom max-width="300">
              <template #activator="{ on }">
                <v-btn :value="option.id" small v-on="on">{{ option.label }}<span class="view-count">{{ countOf(viewCounts, option.id) }}</span></v-btn>
              </template>
              <span>{{ option.hint }}</span>
            </v-tooltip>
          </v-btn-toggle>
          <provenance-mark :result="countsResult" class="mr-3" />
          <span class="tool__label caption text--secondary mr-3">Show</span>
          <v-chip-group v-model="bodyClasses" multiple active-class="class-chip-on">
            <v-chip v-for="option in bodyClassOptions" :key="option.value" :value="option.value" small filter outlined>{{ option.text }}</v-chip>
          </v-chip-group>
          <v-chip v-for="id in stateFilter" :key="id" small label close :color="tone(stateById[id].color)" dark class="mr-1" @click:close="toggleStateFilter(id)">{{ stateById[id].label }}</v-chip>
          <v-spacer />
          <span class="caption text--secondary summary-line">{{ summaryLine }}</span>
        </v-col>
        <v-col v-if="selectedBodies.length || filterBySelectedBodies" cols="12">
          <v-row dense>
            <v-col cols="auto">
              <v-btn class="d-block mb-1" style="width: 100%" small outlined :color="filterBySelectedBodies ? tone('selected') : ''" @click="filterBySelectedBodies = !filterBySelectedBodies">Isolate in Planner</v-btn>
              <v-btn :to="linkTo.minerals({ bodies: selectedBodies })" style="width: 100%" small outlined>Isolate in Minerals</v-btn>
              <v-btn class="d-block mt-4" style="width: 100%" small outlined @click="clearSelection">Clear Selection</v-btn>
            </v-col>
            <v-col>
              <v-chip v-for="body of selectedBodies" :key="body.SystemBodyID" class="mr-2 mb-2" small label outlined close @click:close="() => deselect(body)">{{ body.SystemName }} {{ systemBodyName(body) }}</v-chip>
            </v-col>
          </v-row>
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready || !rows" class="mt-3" @retry="retryFailedInputs" />
      <v-alert v-if="ready && rows && !speciesRows.length" type="info" outlined dense class="mt-3">The race has no colony with a species yet, so there is nothing to compare bodies against.</v-alert>

      <colony-worksheet v-if="ready && rows && speciesRows.length && selectedBodies.length" :selection="selectedBodies" :rows="rows" :species="speciesRows" :loading="$asyncComputed.assessed.updating || $asyncComputed.rows.updating" />

      <v-card v-if="ready && rows && speciesRows.length" class="mt-3" elevation="2">
        <v-data-table :loading="$asyncComputed.assessed.updating || $asyncComputed.rows.updating" :headers="headers" :items="tableItems" item-key="id" :expanded.sync="expandedRows" show-expand :custom-sort="sortItems" :sort-by.sync="table.sortBy" :sort-desc.sync="table.sortDesc" :items-per-page.sync="table.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
          <template #[`item.data-table-expand`]="{ item, isExpanded, expand }">
            <td class="text-no-wrap">
              <v-btn v-if="isSelected(item.body)" :color="tone('selected')" icon small @click.stop="deselect(item.body)"><v-icon>mdi-playlist-remove</v-icon></v-btn>
              <v-btn v-else icon small @click.stop="select(item.body)"><v-icon>mdi-playlist-plus</v-icon></v-btn>
              <v-btn icon small @click.stop="expand(!isExpanded)"><v-icon>{{ isExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon></v-btn>
            </td>
          </template>

          <template #[`item.sortRank`]="{ item }">
            <div v-if="item.row.rank" class="rank-cell">
              <span class="rank-number">{{ item.row.rank }}</span>
              <span class="score-meter" :title="`Worth ${roundToDecimal(item.row.score, 0)}% of the best target`"><i :style="{ width: `${item.row.score}%` }" /></span>
              <provenance-mark :result="provenanceOf(item.row).score" />
            </div>
            <span v-else-if="item.row.unknown.length" class="caption text--secondary">—<provenance-mark :result="provenanceOf(item.row).score" /></span>
            <span v-else class="caption text--secondary">{{ item.row.settled ? 'Colony' : '' }}</span>
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
                <v-chip small label :color="tone(item.row.state.color)" :dark="item.row.state.target" :outlined="!item.row.state.target" class="plan-chip" v-on="on"><v-icon x-small left>{{ item.row.state.icon }}</v-icon>{{ item.row.state.chip(item.row.facts) }}</v-chip>
              </template>
              <span>{{ stateTooltip(item.row) }}</span>
            </v-tooltip>
            <provenance-mark v-if="item.row.unknown.length" :result="provenanceOf(item.row).score" />
            <provenance-mark v-else-if="showsInfrastructure(item.row)" :result="provenanceOf(item.row).infrastructure" />
          </template>

          <template #[`item.costValue`]="{ item }">
            <template v-if="item.best.missing.length">
              <span class="text--secondary">—</span><provenance-mark :result="provenanceOf(item.row).cost" />
            </template>
            <template v-else-if="item.best.strategy !== 'none'">
              <v-tooltip top>
                <template #activator="{ on }">
                  <span class="text-no-wrap" v-on="on">
                    <template v-if="item.best.strategy === 'terraform'"><span class="text--secondary">{{ costText(item.best.assessment.cost.worst) }}</span> → </template>{{ costText(item.best.cost) }}<span v-if="item.best.lowGravity" class="caption"> LG</span>
                  </span>
                </template>
                <span>{{ costTooltip(item.best) }}</span>
              </v-tooltip>
              <provenance-mark :result="provenanceOf(item.row).cost" />
            </template>
            <span v-else class="text--secondary" :title="item.best.assessment.cost.reason">N/A</span>
          </template>

          <template #[`item.capacityValue`]="{ item }">
            <template v-if="item.best.missing.length">
              <span class="text--secondary">—</span><provenance-mark :result="provenanceOf(item.row).capacity" />
            </template>
            <template v-else-if="item.best.strategy !== 'none'">
              <span class="text-no-wrap">{{ people(item.best.capacity) }}</span><provenance-mark :result="provenanceOf(item.row).capacity" />
            </template>
            <span v-else class="text--secondary">-</span>
          </template>

          <template #[`item.mineralValue`]="{ item }">
            <div v-if="item.row.minerals.surveyed" class="text-no-wrap">
              <v-tooltip v-if="item.row.minerals.deposits" top max-width="360">
                <template #activator="{ on }">
                  <span class="mineral-score" :class="{ 'mineral-high': item.row.minerals.rich }" v-on="on">{{ item.row.minerals.value === null ? '—' : roundToDecimal(item.row.minerals.value, 1) }}</span>
                </template>
                <span>{{ mineralTooltip(item.row) }}</span>
              </v-tooltip>
              <span v-else class="text--secondary">None</span>
              <provenance-mark v-if="item.row.minerals.deposits" :result="provenanceOf(item.row).minerals" />
              <v-chip v-if="item.row.minerals.rich" x-small label :color="tone('rich')" dark class="ml-1 px-1">Rich</v-chip>
              <v-tooltip v-if="item.row.minerals.cmc.length" top max-width="340">
                <template #activator="{ on }">
                  <v-chip x-small label outlined class="ml-1 px-1" v-on="on">CMC</v-chip>
                </template>
                <span>Qualifies for a civilian mining complex with {{ item.row.minerals.cmc.join(', ') }}. {{ cmcNote(item.row) }}</span>
              </v-tooltip>
              <span v-if="item.row.minerals.deposits" class="caption text--secondary d-block mineral-note">{{ item.row.minerals.total === null ? '—' : compactTons(item.row.minerals.total) }}<template v-if="scarceNames(item.row)"> · short of {{ scarceNames(item.row) }}</template></span>
            </div>
            <v-tooltip v-else top>
              <template #activator="{ on }">
                <span :style="{ color: tone('unsurveyed') }" v-on="on">Unsurveyed</span>
              </template>
              <span>{{ groundSurveyText(item.body) }}</span>
            </v-tooltip>
          </template>

          <template #[`item.distanceValue`]="{ item }">
            <div v-if="item.row.distance" class="d-flex align-start">
              <v-tooltip top max-width="320">
                <template #activator="{ on }">
                  <span class="text-no-wrap" v-on="on">{{ roundToDecimal(item.row.distance.au, 1) }} AU<span class="caption text--secondary d-block">{{ item.row.distance.jumps }} {{ item.row.distance.jumps === 1 ? 'jump' : 'jumps' }}</span></span>
                </template>
                <span>{{ distanceTooltip(item.row) }}</span>
              </v-tooltip>
              <provenance-mark :result="provenanceOf(item.row).distance" />
            </div>
            <template v-else>
              <span class="text--secondary">—</span><provenance-mark :result="provenanceOf(item.row).distance" />
            </template>
          </template>

          <template #[`item.transitValue`]="{ item }">
            <div class="d-flex align-start">
              <v-tooltip top max-width="360">
                <template #activator="{ on }">
                  <span class="text-no-wrap" v-on="on">
                    <template v-if="item.transit.state === 'routed'"><span v-if="item.transit.days === null" class="text--secondary">No speed</span><template v-else>{{ flyTime(item.transit.days) }}</template><span class="caption text--secondary d-block">{{ transitCaption(item.transit) }}<provenance-mark :result="item.transit.results.route" /></span></template>
                    <template v-else>—<span class="caption text--secondary d-block">{{ transitStateText[item.transit.state] }}</span></template>
                  </span>
                </template>
                <span>{{ transitTooltip(item.transit) }}</span>
              </v-tooltip>
              <provenance-mark :result="item.transit.results.time" />
            </div>
          </template>

          <template #[`header.sortRank`]="{ header }">
            <v-tooltip top max-width="320">
              <template #activator="{ on }">
                <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
              </template>
              <span>Targets are ranked for the chosen goal. The bar is each target's worth against the best one. Colonies, alien colonies, bodies no species can live on and bodies too small to be worth the trip are not ranked.</span>
            </v-tooltip>
          </template>

          <template #[`header.transitValue`]="{ header }">
            <v-tooltip top max-width="340">
              <template #activator="{ on }">
                <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
              </template>
              <span>One representative ship flying one way from the nearest colony with people ({{ transitBasisText }}). Sorting this column orders by {{ transitSortLabel }}. A body with no explored route the ship can fly, or with no speed set for the time, is unknown and sorts last. Set the basis under Transit.</span>
            </v-tooltip>
          </template>

          <template #expanded-item="{ item }">
            <td :colspan="headers.length + 1" class="px-4 py-3 planner-detail">
              <v-alert v-if="terraformResult.status === 'unavailable'" type="warning" outlined dense class="mb-3">Terraforming time cannot be worked out: {{ terraformResult.inputs.missing.join(', ') }} missing. The years and installation counts below do not apply.</v-alert>
              <body-detail :item="item" :shown="shownEvaluation(item)" :species-options="speciesChoices(item)" :terraform-capacity="terraformCapacityPerYear" :gases="gases" :terraform-sources="terraformSources" :naval-admins="navalAdmins" :rules="detailRules" :separator="separator" @species="(id) => $set(detailSpecies, item.id, id)" />
            </td>
          </template>
        </v-data-table>
      </v-card>
    </v-container>
  </div>
</template>

<script>
import Vue from 'vue'
import { mapGetters } from 'vuex'

import { sectionStyle } from '../components/navigation/section-style'
import LoadState from '../components/page/LoadState.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import BodyDetail from '../components/planner/BodyDetail.vue'
import ColonyWorksheet from '../components/planner/ColonyWorksheet.vue'
import capabilityGates from '../mixins/capability-gates'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance, toneColor } from '../utilities/appearance'
import { areSetsEqual } from '../utilities/generic'
import { systemBodyName } from '../utilities/aurora'
import { people } from '../utilities/colonies'
import { assessBodies, BEST_TARGET_SCORE, cmcNote, GOALS, NO_CMC_RULES, normaliseRanking, NO_OUTLOOK, rankBodies, rowProvenance, terraformCapacityResult, UNKNOWN_STATE } from '../utilities/colonization'
import { loadBodies, loadCmcRules, loadGases, loadLagrangePoints, loadMineralOutlook, loadRaceRules, loadRoutes, loadSpecies, loadTransitClasses, NO_RACE_RULES, speciesPopulationResult } from '../utilities/colonization-data'
import { bodyReference, linkTo, queryBodies, queryIds } from '../utilities/deep-links'
import { PLAN_STATES, STATE_BY_ID, STATE_GROUPS } from '../utilities/colonization-states'
import { DEFAULT_BASIS, DRIVES, DRIVE_IDS, SORT_IDS, TRANSIT_SORTS, TRANSIT_STATE_TEXT, basisText, driveOfClass, normaliseSpeed, sortTableItems, transitEstimator, transitSortValues, transitText } from '../utilities/colony-transit'
import { evaluationOf } from '../utilities/colony-worksheet'
import { buildDistanceMap } from '../utilities/jump-graph'
import { tracked } from '../utilities/load-tracking'
import { derive } from '../utilities/query-cache'
import { roundToDecimal, separatedNumber, thousandsSeparator } from '../utilities/math'
import { MINERALS, compact as compactTons } from '../utilities/minerals'
import { loadNavalAdmins } from '../utilities/naval-admins'
import { sectionById } from '../utilities/navigation'
import { combine, isAvailable, ofRule, unavailable, valueOrNull } from '../utilities/provenance'
import { NO_TERRAFORM_SOURCES, loadTerraformSources } from '../utilities/terraform-capacity'

const INPUT_LABELS = {
  bodies: 'the bodies of known systems',
  species: 'the species',
  raceRules: 'the race rules',
  cmcRules: 'the civilian mining rules',
  gases: 'the gases',
  routes: 'the jump routes',
  lagrangePoints: 'the Lagrange points',
  transitClasses: 'the ship classes',
  outlook: 'the mineral outlook',
  terraformSources: 'the terraforming capacity',
  navalAdmins: 'the naval admin commands',
}

const BODY_CLASS_NAMES = { 1: 'Planet', 2: 'Moon', 3: 'Asteroid', 5: 'Comet' }
const GROUND_SURVEY = { 0: 'Completed', 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }
const NO_RANK = 1e12
// Rows per page before the user picks one: 10 fit a 1080 px window, 15 a window of 1200 px or more.
const DEFAULT_ROWS = 10
const PAGE_SIZES = [10, 15, 30, 50, 100]
// The plan states the page can show: the table's and the one for a body whose figures are missing. Only the table's are kept between visits.
const STATES_BY_ID = { ...STATE_BY_ID, [UNKNOWN_STATE.id]: UNKNOWN_STATE }
// The states whose chip shows the infrastructure per million people.
const INFRASTRUCTURE_STATES = ['mining', 'cheap', 'moderate', 'costly', 'severe']
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

// The filters the page keeps, by the data field and the config key that carry them.
const FILTERS = [
  { key: 'nonTerraformable', field: 'filterNonTerraformable', config: 'habitabilityFilterNonTerraformable', label: 'Hide Non-Terraformable' },
  { key: 'withoutMinerals', field: 'filterWithoutMinerals', config: 'habitabilityFilterWithoutMinerals', label: 'Hide Without Minerals' },
  { key: 'ownPopulations', field: 'filterOwnPopulations', config: 'habitabilityFilterOwnPopulations', label: 'Hide Own Populations' },
  { key: 'otherPopulations', field: 'filterOtherPopulations', config: 'habitabilityFilterOtherPopulations', label: 'Hide Other Populations' },
  { key: 'doneTerraforming', field: 'filterDoneTerraforming', config: 'habitabilityFilterDoneTerraforming', label: 'Hide Terraformed' },
  { key: 'uninhabited', field: 'filterUninhabited', config: 'habitabilityFilterUninhabited', label: 'Hide Uninhabited' },
]

const RANKING_FIELDS = [
  { key: 'minimumPeople', label: 'Smallest colony (M)', hint: 'Under this a body is only a target for its deposits' },
  { key: 'minimumDeposit', label: 'Minimum deposit (t)', hint: 'Smaller deposits are worth nothing' },
  { key: 'cmcBonus', label: 'CMC bonus', hint: 'Deposit value a civilian complex site adds' },
  { key: 'costScale', label: 'Colony cost scale', hint: 'Worth halves at this cost, before colonisation tech' },
  { key: 'yearsScale', label: 'Terraforming years scale', hint: 'Worth halves after this many years' },
  { key: 'distanceScale', label: 'Distance scale (AU)', hint: 'Worth halves at this distance from a colony' },
]

// Which bodies the table lists. A body is in the first view that its rank and plan state fit.
const VIEWS = [
  { id: 'best', label: 'Best targets', hint: `Places to settle next that are worth at least ${BEST_TARGET_SCORE}% of the best one`, has: (row) => !!row.rank && row.score >= BEST_TARGET_SCORE },
  { id: 'ranked', label: 'All ranked', hint: 'Every ranked place to settle, from the best down', has: (row) => !!row.rank },
  { id: 'colonies', label: 'Colonies', hint: 'Bodies where the race already has a colony or outpost', has: (row) => row.settled },
  { id: 'other', label: 'Other bodies', hint: 'Everything else: alien colonies, bodies nobody can live on, bodies too small or poor to be worth the trip, and bodies whose state is unknown for lack of figures', has: (row) => !row.rank && !row.settled },
]

// System IDs are numbers; Vuetify's general selection search scans every item for every selected system.
const SystemSelect = {
  extends: Vue.component('VAutocomplete'),
  methods: {
    setSelectedItems() {
      const { allItems, internalValue } = this
      const byId = new Map(allItems.map((item) => [item.SystemID, item]))

      this.selectedItems = (Array.isArray(internalValue) ? internalValue : [internalValue]).filter((id) => byId.has(id)).map((id) => byId.get(id))

      if (!this.isFocused) {
        this.setSearch()
      }
    },
  },
}

// The page's reads and what it works out of them stay with the save (query-cache.js `derive`) until the save or an input changes. Each `inputs` entry is what the result depends on; `derive` keeps nothing whose result and inputs together pass its cap, so a huge save's assessment and ranking are worked out but not kept.
const kept = (vm, slot, inputs, compute) => derive(vm.database, `planner.${slot}`, inputs, compute)

export default {
  components: { BodyDetail, ColonyWorksheet, LoadState, ProvenanceMark, SystemSelect },
  mixins: [
    capabilityGates,
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      selectedSpeciesId: { key: 'habitabilitySpecies', default: null, scope: 'race' },
      goal: { key: 'habitabilityGoal', default: 'both', valid: oneOf(GOALS.map((option) => option.id)) },
      view: { key: 'habitabilityView', default: 'best', valid: oneOf(VIEWS.map((option) => option.id)) },
      stateFilter: { key: 'habitabilityStates', default: [], normalise: (stored) => (Array.isArray(stored) ? stored.filter((id) => STATE_BY_ID[id]) : undefined) },
      terraformers: { key: 'habitabilityTerraformers', default: 10 },
      ...Object.fromEntries(FILTERS.map((filter) => [filter.field, { key: filter.config, default: false, normalise: Boolean }])),
      bodyClasses: { key: 'habitabilityBodyClasses', default: [1, 2, 3, 5], normalise: (stored) => (Array.isArray(stored) ? stored.filter((value) => BODY_CLASS_NAMES[value]) : undefined) },
      systems: { key: 'habitabilitySystems', default: [] },
      transitSpeed: { key: 'habitabilityTransitSpeed', default: DEFAULT_BASIS.speed, scope: 'race', normalise: normaliseSpeed },
      transitDrive: { key: 'habitabilityTransitDrive', default: DEFAULT_BASIS.drive, scope: 'race', valid: oneOf(DRIVE_IDS) },
      transitLagrange: { key: 'habitabilityTransitLagrange', default: DEFAULT_BASIS.lagrange, scope: 'race', normalise: (stored) => (typeof stored === 'boolean' ? stored : undefined) },
      transitSort: { key: 'habitabilityTransitSort', default: 'time', scope: 'race', valid: oneOf(SORT_IDS) },
      table: tableView('habitabilityTable', { sortBy: ['sortRank'], sortDesc: [false], itemsPerPage: DEFAULT_ROWS, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      pageSizes: PAGE_SIZES,
      expandedRows: [],
      detailSpecies: {},
      selectedBodies: [],
      filterBySelectedBodies: false,

      ranking: normaliseRanking(null),

      rules: {
        required: (value) => !!value || 'Required.',
        positive: (value) => value > 0 || 'Must be positive.',
        speed: (value) => value === '' || value === null || value === undefined || value > 0 || 'Must be above 0, or blank.',
      },

      linkTo,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'racePrefix']),

    appearance() {
      return activeAppearance()
    },

    sectionColors() {
      return sectionStyle(this.appearance, sectionById.colonies)
    },

    goals: () => GOALS,
    viewOptions: () => VIEWS,
    stateById: () => STATES_BY_ID,
    bestScore: () => BEST_TARGET_SCORE,
    minerals: () => MINERALS,
    filterOptions: () => FILTERS,
    rankingFields: () => RANKING_FIELDS,
    bodyClassNames: () => BODY_CLASS_NAMES,
    bodyClassOptions: () => Object.entries(BODY_CLASS_NAMES).map(([value, text]) => ({ value: Number(value), text: `${text}s` })),
    compactTons: () => compactTons,

    separator() {
      return thousandsSeparator(this.config.get('selectedSeparator', 'Tick'))
    },

    filters() {
      return Object.fromEntries(FILTERS.map((filter) => [filter.key, this[filter.field]]))
    },

    rankingKey() {
      return this.racePrefix ? `${this.racePrefix}.targetWeights` : null
    },

    activeFilterCount() {
      return FILTERS.filter((filter) => this[filter.field]).length
    },

    speciesRows() {
      return this.ready ? this.species : []
    },
    speciesItems() {
      return [{ text: 'Best of all species', value: null }, ...this.speciesRows.map((species) => {
        const population = valueOrNull(speciesPopulationResult(species))

        return { text: `${species.SpeciesName} (${population === null ? '—' : separatedNumber(roundToDecimal(population, 2), this.separator)} M)`, value: species.SpeciesID }
      })]
    },
    // The species whose population the save does not give, as one unavailable result, or null when every species has one.
    speciesPopulationGap() {
      const gaps = this.speciesRows.filter((species) => !isAvailable(speciesPopulationResult(species)))

      return gaps.length ? unavailable({ rule: 'habitability.speciesPopulation', missing: gaps.map((species) => `${species.SpeciesName} population`) }) : null
    },
    // The chosen species, or null (best of all) when it isn't one of the race's any more.
    activeSpeciesId() {
      return this.speciesRows.some((species) => species.SpeciesID === this.selectedSpeciesId) ? this.selectedSpeciesId : null
    },
    // What the terraformers can move in a year, or why that is unknown. The ranking reads the result; the detail panel still takes a number, 0 while this is unavailable (see the alert above it).
    terraformResult() {
      return terraformCapacityResult(this.raceRules, this.terraformers)
    },
    terraformCapacityPerYear() {
      return valueOrNull(this.terraformResult) ?? 0
    },
    terraformerHint() {
      const { TerraformingRate, TerraformingSpeed } = this.raceRules

      if (!Number.isFinite(TerraformingRate) || !Number.isFinite(TerraformingSpeed)) {
        return 'the race rate or the game speed setting is not in the save'
      }

      return `${TerraformingRate} atm a year each${TerraformingSpeed === 100 ? '' : `, at ${TerraformingSpeed}% game speed`}`
    },
    // What the colonisation skill is for the legend: nothing at 1, the figure otherwise, and the assumption when the race row has none.
    skillNote() {
      const skill = this.raceRules.ColonizationSkill

      return !Number.isFinite(skill) ? ' (a skill of 1 is assumed: the race row has none)' : skill !== 1 ? ` (×${skill} here)` : ''
    },
    // The race rules as the detail panel reads them: the skill the ranking used (1 when the race row has none). The rate and the speed stay as they are, null when unknown.
    detailRules() {
      return { ...this.raceRules, ColonizationSkill: Number.isFinite(this.raceRules.ColonizationSkill) ? this.raceRules.ColonizationSkill : 1 }
    },

    // Travel is measured from the nearest sizeable colony (the capital among them), and from the capital alone.
    distanceOf() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.colonies)
    },
    capitalDistanceOf() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.capital ? [this.routes.capital] : [])
    },

    drives: () => DRIVES,
    transitSorts: () => TRANSIT_SORTS,
    transitStateText: () => TRANSIT_STATE_TEXT,

    // The representative ship's basis as the Transit menu sets it.
    transitBasis() {
      return { speed: this.transitSpeed, drive: this.transitDrive, lagrange: this.transitLagrange }
    },
    transitBasisText() {
      return basisText(this.transitBasis, this.count)
    },
    transitSortLabel() {
      return TRANSIT_SORTS.find((option) => option.id === this.transitSort).label.toLowerCase()
    },
    // The estimate of a body's trip: a new one whenever the speed, the drive or Lagrange routing changes. It searches only the jump points the race has charted and explored, whatever the basis.
    transitOf() {
      return transitEstimator(this.routes, this.lagrangePoints, this.transitBasis)
    },
    systemNameById() {
      return new Map(this.systemNames.map((system) => [system.SystemID, system.SystemName]))
    },
    transitClassItems() {
      const drives = { drive: 'its own jump drive carries it', gates: 'no jump drive that carries it' }

      return this.transitClasses.map((shipClass) => ({ id: shipClass.ShipClassID, text: `${shipClass.ClassName}: ${this.count(shipClass.MaxSpeed)} km/s, ${drives[driveOfClass(shipClass)] || 'jump drive not known'}` }))
    },
    // The ship class whose speed and drive are the ones set, or null when they match none (a figure typed in, or an edit after the pick).
    pickedClass() {
      const found = this.transitClasses.find((shipClass) => normaliseSpeed(shipClass.MaxSpeed) === this.transitSpeed && [null, this.transitDrive].includes(driveOfClass(shipClass)))

      return found ? found.ShipClassID : null
    },

    systemNames() {
      const names = new Map()

      this.bodies.forEach((body) => names.set(body.SystemID, body.SystemName))

      return [...names].map(([SystemID, SystemName]) => ({ SystemID, SystemName })).sort((a, b) => (a.SystemName || '').localeCompare(b.SystemName || '', undefined, { numeric: true, sensitivity: 'base' }))
    },
    systemSelection() {
      const count = this.systems.length
      const total = this.systemNames.length

      return { count, total, all: count === total }
    },

    linkQuery() {
      if (this.filterBySelectedBodies && this.selectedBodies.length) {
        return linkTo.planner({ bodies: this.selectedBodies }).query
      } else if (!this.systemNames.length) {
        return null
      }

      return linkTo.planner({ systems: this.systemSelection.all ? null : this.systems }).query
    },
    linkLabel() {
      if (this.filterBySelectedBodies && this.selectedBodies.length) {
        const [body] = this.selectedBodies

        return this.selectedBodies.length === 1 ? `${body.SystemName} ${systemBodyName(body)}` : `${this.selectedBodies.length} bodies`
      } else if (this.systemSelection.all || !this.systems.length) {
        return ''
      }

      const names = this.systems.map((id) => (this.systemNames.find((system) => system.SystemID === id) || {}).SystemName).filter(Boolean)

      return names.length === 1 ? names[0] : `${this.systems.length} systems`
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

      return (this.rows || []).filter((row) => (scope ? scope.has(row.body.SystemBodyID) : systems.has(row.body.SystemID) && classes.has(row.body.BodyClass)))
    },
    // Every figure below that counts rows waits for the rows: while they load, or after a read failed, the count is unknown, not 0.
    loaded() {
      return this.ready && !!this.rows
    },
    viewCounts() {
      return this.loaded ? Object.fromEntries(VIEWS.map((view) => [view.id, this.scopedRows.filter(view.has).length])) : null
    },
    stateCounts() {
      if (!this.loaded) {
        return null
      }

      const counts = {}

      this.scopedRows.forEach((row) => {
        counts[row.state.id] = (counts[row.state.id] || 0) + 1
      })

      return counts
    },
    stateGroups() {
      return this.stateCounts && this.stateCounts[UNKNOWN_STATE.id] ? [...STATE_GROUPS, { group: UNKNOWN_STATE.group, states: [UNKNOWN_STATE] }] : STATE_GROUPS
    },
    // What the counts rest on: counting is exact, but which view or state a body falls in follows its rank and colony cost, so they take those statuses.
    countsResult() {
      if (!this.loaded) {
        return unavailable({ rule: 'habitability.filterCount', missing: this.failedInputs.length ? this.failedInputs.map((key) => INPUT_LABELS[key]) : ['the ranked bodies'] })
      }

      const total = this.scopedRows.length
      const unknown = this.scopedRows.filter((row) => row.state === UNKNOWN_STATE).length

      return combine({ rule: 'habitability.filterCount', parts: { ranking: ofRule({ rule: 'habitability.score', value: total }), colonyCost: ofRule({ rule: 'habitability.colonyCost', value: total }) }, compute: () => total, inputs: { present: ['the loaded bodies'] }, assumptions: unknown ? [`${unknown} bodies are in no ranked view or state because figures are missing`] : [] })
    },

    filteredRows() {
      const { filters, filterBySelectedBodies } = this
      const view = VIEWS.find((option) => option.id === this.view) || VIEWS[0]
      const states = new Set(this.stateFilter)

      return this.scopedRows.filter((row) => {
        const { body, best } = row
        const alienPopulation = body.AlienPopulations.reduce((total, population) => total + population.PopulationAmount, 0)

        return (filterBySelectedBodies || (view.has(row) && (!states.size || states.has(row.state.id)))) && !(filters.nonTerraformable && !best.missing.length && (best.strategy === 'none' || best.assessment.outcome === 'no')) && !(filters.withoutMinerals && !(row.minerals.total > 0 || row.minerals.missing.length)) && !(filters.ownPopulations && body.OwnPopulations.length) && !(filters.otherPopulations && body.AlienPopulations.length) && !(filters.doneTerraforming && !best.missing.length && !best.assessment.plan) && !(filters.uninhabited && !(body.OwnPopulations.reduce((total, population) => total + population.Population, 0) + alienPopulation > 0))
      })
    },

    summaryLine() {
      if (!this.loaded) {
        return '—'
      }

      const count = (value, one, many) => `${separatedNumber(value, this.separator)} ${value === 1 ? one : many}`

      return `${count(this.bodies.length, 'body', 'bodies')} in ${count(this.systemNames.length, 'system', 'systems')} · ${separatedNumber(this.filteredRows.length, this.separator)} shown`
    },

    // Flat items for the table: the columns sort on plain fields. A figure that does not exist (N/A, unknown, unsurveyed, no route) is null and sorts last whichever way the column is sorted (`sortItems`), never as 0.
    tableItems() {
      const { transitOf, transitSort } = this

      return this.filteredRows.map((row) => {
        const transit = transitOf(row.body)
        const { value, tie } = transitSortValues(transit, transitSort)

        return {
          id: row.body.SystemBodyID,
          row,
          body: row.body,
          best: row.best,
          sortRank: row.rank || (row.unknown.length || row.best.missing.length ? null : NO_RANK - (row.best.strategy === 'none' ? 0 : row.best.capacity)),
          stateOrder: row.state === UNKNOWN_STATE ? null : PLAN_STATES.indexOf(row.state),
          bodyOrder: `${row.body.SystemName} ${row.body.SystemBodyOrder}`,
          speciesName: row.best.strategy === 'none' ? null : row.best.species.SpeciesName,
          costValue: row.best.strategy === 'none' ? null : row.best.cost,
          capacityValue: row.best.strategy === 'none' ? null : row.best.capacity,
          mineralValue: row.minerals.surveyed ? row.minerals.value : null,
          distanceValue: row.distance ? row.distance.au : null,
          transit,
          transitValue: value,
          transitTie: tie,
        }
      })
    },

    headers() {
      return [
        { text: '#', value: 'sortRank', divider: true },
        { text: 'Body', value: 'bodyOrder', divider: true },
        { text: 'Species', value: 'speciesName', divider: true },
        { text: 'Plan', value: 'stateOrder', divider: true },
        { text: 'Colony Cost', value: 'costValue', divider: true },
        { text: 'Holds', value: 'capacityValue', divider: true },
        { text: 'Minerals', value: 'mineralValue', divider: true },
        { text: 'Distance', value: 'distanceValue', divider: true },
        { text: 'Transit', value: 'transitValue' },
      ]
    },
  },
  watch: {
    systemNames: {
      immediate: true,
      handler(names) {
        if (names.length && !this.systems.length) {
          this.setUnsaved('systems', names.map((system) => system.SystemID))
        }
      },
    },
    rankingKey: {
      immediate: true,
      handler() {
        // While no campaign is settled the ranking on screen stays as it is; it is stored under a key again once one settles.
        if (!this.rankingKey) {
          return
        }

        this.ranking = normaliseRanking(this.config.get(this.rankingKey))
      },
    },
    RaceID(_newRaceID, oldRaceID) {
      if (oldRaceID) {
        this.systems = []
        this.detailSpecies = {}
      }
    },
  },
  created() {
    this.provenanceCache = new WeakMap()

    if (this.config.get('habitabilityTable') === undefined) {
      this.setUnsaved('table', { ...this.table, itemsPerPage: this.rowsToFit() })
    }
  },
  methods: {
    // The colour of a plan state's or outcome's tone under the appearance in force.
    tone(name) {
      return toneColor(this.appearance, name)
    },

    applyLink(query) {
      const bodies = queryBodies(query.bodies)

      this.filterBySelectedBodies = bodies.length > 0

      if (bodies.length) {
        this.selectedBodies = bodies
      } else {
        const systems = queryIds(query.systems)

        this.setUnsaved('systems', systems.length ? systems : this.systemNames.map((system) => system.SystemID))
      }
    },

    areSetsEqual,
    people,
    roundToDecimal,
    separatedNumber,
    systemBodyName,

    setFilter(filter, value) {
      this[filter.field] = !!value
    },
    resetFilters() {
      FILTERS.forEach((filter) => {
        this[filter.field] = false
      })
    },

    toggleSystems() {
      this.systems = this.systems.length === this.systemNames.length ? [] : this.systemNames.map((system) => system.SystemID)
    },
    removeSystem(id) {
      this.systems = this.systems.filter((systemId) => systemId !== id)
    },
    selectSystems(ids) {
      this.systems = ids
    },

    setRanking(key, value) {
      this.ranking = normaliseRanking({ ...this.ranking, [key]: value === '' ? null : Number(value) })
      this.storeRanking(this.ranking)
    },
    setWeight(id, value) {
      this.ranking = normaliseRanking({ ...this.ranking, weights: { ...this.ranking.weights, [id]: value === '' ? null : Number(value) } })
      this.storeRanking(this.ranking)
    },
    resetRanking() {
      this.ranking = normaliseRanking(null)
      this.storeRanking(null)
    },
    // The ranking is kept with the campaign's settings, so it waits for the recorder to settle which campaign the save belongs to and is only shown, not kept, until it has.
    storeRanking(value) {
      if (this.rankingKey) {
        this.config.set(this.rankingKey, value)
      }
    },

    isSelected(body) {
      return this.selectedBodies.some((selection) => selection.SystemBodyID === body.SystemBodyID)
    },
    select(body) {
      this.selectedBodies.push(bodyReference(body))
    },
    deselect(body) {
      this.selectedBodies = this.selectedBodies.filter((selection) => selection.SystemBodyID !== body.SystemBodyID)
    },
    clearSelection() {
      this.selectedBodies = []
      this.filterBySelectedBodies = false
    },

    // The evaluation the detail panel shows: the species picked there, else the row's best.
    shownEvaluation(item) {
      return evaluationOf(item.row, this.detailSpecies[item.id])
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

      return `Deposit value ${row.minerals.value === null ? 'unknown' : roundToDecimal(row.minerals.value, 1)}, rich from 6: ${lines.join(', ') || 'no deposit worth counting'}.`
    },
    distanceTooltip(row) {
      const { distance, capitalDistance } = row
      const capital = capitalDistance && distance.from && !distance.from.Capital ? ` The capital is ${roundToDecimal(capitalDistance.au, 1)} AU and ${capitalDistance.jumps} ${capitalDistance.jumps === 1 ? 'jump' : 'jumps'} away.` : ''

      return `${roundToDecimal(distance.au, 1)} AU by the charted route from ${distance.from ? distance.from.PopName.replace(/<[^>]*>/g, '') : 'the nearest colony'}, ${distance.jumps} ${distance.jumps === 1 ? 'jump' : 'jumps'}.${capital}`
    },
    setTransitSpeed(value) {
      this.transitSpeed = normaliseSpeed(value)
    },
    // Takes the speed and the drive of a ship class; a class whose drive is not known leaves the drive as set.
    takeClass(id) {
      const found = this.transitClasses.find((shipClass) => shipClass.ShipClassID === id)

      if (found) {
        this.transitSpeed = normaliseSpeed(found.MaxSpeed)
        this.transitDrive = driveOfClass(found) || this.transitDrive
      }
    },
    // The transit time in the unit that reads best; a real 0 is 0 h.
    flyTime(days) {
      return days === 0 ? '0 h' : this.duration(days)
    },
    transitCaption(transit) {
      return `${transit.jumps} ${transit.jumps === 1 ? 'jump' : 'jumps'} · ${this.count(transit.au, 1)} AU`
    },
    transitTooltip(transit) {
      return transitText(transit, { systemName: (systemId) => this.systemNameById.get(systemId) || `System #${systemId}`, count: this.count })
    },
    scarcityHint(id) {
      const mineral = this.outlook.minerals[id]

      if (!this.outlook.known) {
        return 'No ledger in this save'
      }

      if (mineral && !mineral.scarcity) {
        return mineral.stock === null ? 'Unknown: the stock or the cargo in transit is not recorded' : 'Unknown: a ledger amount is not recorded'
      }

      return mineral && mineral.scarcity.factor > 1 ? `x${mineral.scarcity.factor}: ${mineral.scarcity.label.toLowerCase()}, ${this.years(mineral.runway)}` : 'Not short'
    },
    costText(value) {
      return value === null || value === undefined ? 'N/A' : roundToDecimal(value, 2).toString()
    },
    // A count for display: the figure, or a dash while the rows are not loaded.
    countOf(counts, key) {
      return counts ? separatedNumber(counts[key] || 0, this.separator) : '—'
    },
    // The results behind a row's figures, worked out once for a row.
    provenanceOf(row) {
      let results = this.provenanceCache.get(row)

      if (!results) {
        results = rowProvenance(row)
        this.provenanceCache.set(row, results)
      }

      return results
    },
    // Whether the row's state chip shows an infrastructure figure.
    showsInfrastructure(row) {
      return INFRASTRUCTURE_STATES.includes(row.state.id)
    },
    // The column's sort, with a figure that does not exist last whichever way it is sorted.
    sortItems(items, sortBy, sortDesc) {
      return sortTableItems(items, sortBy, sortDesc, COLLATOR.compare)
    },
    costTooltip(evaluation) {
      const { cost } = evaluation.assessment

      return `Now ${this.costText(cost.current)}, at periapsis ${this.costText(cost.periapsis)}, at apoapsis ${this.costText(cost.apoapsis)}. The worst of them counts.`
    },
    cmcNote(row) {
      return cmcNote(row.cmcSite)
    },
    groundSurveyText(body) {
      return `No geological survey by this race yet. Ground survey potential: ${GROUND_SURVEY[body.GroundMineralSurvey] || 'unknown'}.`
    },
  },
  asyncComputed: {
    // The expensive part: every body assessed for every species. It reads neither the goal nor the ranking. Both steps run in slices so a large save keeps the window responsive; null until the first pass is done. Each result is kept with the save (`kept`), so the page opened again, with nothing changed, shows it at once.
    assessed: {
      async get() {
        const inputs = () => [this.bodies, this.species, this.raceRules, this.gases]

        // Read before the first await, so a change to any of them runs this again.
        inputs()

        if (!this.ready) {
          return null
        }

        // `ready` turns true a moment before the last of the reads is assigned to its property. Waiting a tick means the inputs are the loaded ones, not the empty values they start as, so the kept result is the one the next visit asks for.
        await this.$nextTick()

        const [bodies, species, raceRules, gases] = inputs()

        return kept(this, 'assessed', [bodies, species, raceRules, gases], async () => {
          const gasById = new Map(gases.map((gas) => [gas.GasID, gas]))

          return Object.freeze(await assessBodies(bodies, species, raceRules, (id) => gasById.get(id)))
        })
      },
      default: null,
    },
    rows: {
      async get() {
        const { assessed, activeSpeciesId, goal, ranking, raceRules, routes, cmcRules, outlook, terraformers } = this

        if (!assessed) {
          return null
        }

        return kept(this, 'rows', [assessed, activeSpeciesId, goal, JSON.stringify(ranking), raceRules, terraformers, routes, cmcRules, outlook], async () => Object.freeze(await rankBodies(assessed, { speciesId: activeSpeciesId, goal, ranking, rules: raceRules, terraformers, distanceOf: this.distanceOf, capitalDistanceOf: this.capitalDistanceOf, origins: { colonies: routes.colonies.length, capital: !!routes.capital }, cmcRules, outlook })))
      },
      default: null,
    },
    bodies: {
      get: tracked('bodies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return kept(this, 'bodies', [this.GameID, this.RaceID], () => loadBodies(this.database, { GameID: this.GameID, RaceID: this.RaceID }).then(Object.freeze))
      }),
      default: [],
    },
    species: {
      get: tracked('species', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return kept(this, 'species', [this.GameID, this.RaceID], () => loadSpecies(this.database, { GameID: this.GameID, RaceID: this.RaceID }).then(Object.freeze))
      }),
      default: [],
    },
    raceRules: {
      get: tracked('raceRules', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_RACE_RULES
        }

        return kept(this, 'raceRules', [this.GameID, this.RaceID], () => loadRaceRules(this.database, { GameID: this.GameID, RaceID: this.RaceID }))
      }),
      default: NO_RACE_RULES,
    },
    cmcRules: {
      get: tracked('cmcRules', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_CMC_RULES
        }

        return kept(this, 'cmcRules', [this.GameID, this.RaceID], () => loadCmcRules(this.database, { GameID: this.GameID, RaceID: this.RaceID }))
      }),
      default: NO_CMC_RULES,
    },
    gases: {
      get: tracked('gases', async function () {
        return this.database ? kept(this, 'gases', [], () => loadGases(this.database).then(Object.freeze)) : []
      }),
      default: [],
    },
    routes: {
      get: tracked('routes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { jumpPoints: [], capital: null, colonies: [] }
        }

        return kept(this, 'routes', [this.GameID, this.RaceID], () => loadRoutes(this.database, { GameID: this.GameID, RaceID: this.RaceID }).then(Object.freeze))
      }),
      default: { jumpPoints: [], capital: null, colonies: [] },
    },
    lagrangePoints: {
      get: tracked('lagrangePoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return kept(this, 'lagrangePoints', [this.GameID, this.RaceID], () => loadLagrangePoints(this.database, { GameID: this.GameID, RaceID: this.RaceID }).then(Object.freeze))
      }),
      default: [],
    },
    transitClasses: {
      get: tracked('transitClasses', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return kept(this, 'transitClasses', [this.GameID, this.RaceID], () => loadTransitClasses(this.database, { GameID: this.GameID, RaceID: this.RaceID }).then(Object.freeze))
      }),
      default: [],
    },
    outlook: {
      get: tracked('outlook', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_OUTLOOK
        }

        const { ranks, blocked } = await this.capabilityGates('/habitability')

        return kept(this, 'outlook', [this.GameID, this.RaceID, ranks, [...blocked].sort().join()], () => loadMineralOutlook(this.database, { GameID: this.GameID, RaceID: this.RaceID, ranks, blocked }).then(Object.freeze))
      }),
      default: NO_OUTLOOK,
    },
    terraformSources: {
      get: tracked('terraformSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_TERRAFORM_SOURCES
        }

        const { blocked } = await this.capabilityGates('/habitability')

        return kept(this, 'terraformSources', [this.GameID, this.RaceID, [...blocked].sort().join()], () => loadTerraformSources(this.database, { GameID: this.GameID, RaceID: this.RaceID, blocked }))
      }),
      default: NO_TERRAFORM_SOURCES,
    },
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const { ranks, blocked } = await this.capabilityGates('/habitability')

        return kept(this, 'navalAdmins', [this.GameID, this.RaceID, ranks, [...blocked].sort().join()], () => loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 9, share: 'Industrial', ranks, blocked }))
      }),
      default: {},
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
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
  }

  // One row from 1280 px up: the species, goal and terraformers keep their size, the systems field takes what is left (so it grows on a wide window) and the buttons lose their labels below 1500 px. Narrower windows wrap.
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
      background: var(--sc);
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
    color: var(--sc-text);
  }

  .view-count {
    margin-left: 6px;
    opacity: 0.65;
    font-weight: 400;
  }

  .class-chip-on {
    background: var(--sc-soft);
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
    background: var(--sc-soft);
  }

  .legend-rule {
    font-size: calc(13px * var(--ae-font-scale));
    line-height: calc(20px * var(--ae-font-scale));
  }

  .legend-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    line-height: calc(24px * var(--ae-font-scale));
  }
}
</style>
