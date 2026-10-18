<template>
  <div>
    <v-container fluid class="survey-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" />

        <v-card class="panel" data-summary="A map of the known systems, shaded by how much survey work each has left. Use it to pick where to send the survey ships next." elevation="1">
          <div class="panel-head">
            <span>Survey map</span>
            <span class="legend">
              <span v-for="item in mapLegend" :key="item.key" class="legend-item"><span class="dot" :style="{ background: item.color }" />{{ item.label }}</span>
              <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Survey ships</span>
            </span>
          </div>
          <div class="panel-body">
            <system-map :systems="mapNodes" :links="links" :selected="selectedSystemId" aria-label="Known systems coloured by the survey work left" @select="selectSystem" />
            <div class="caption text--secondary">Positions as on the game's galactic map. Size shows the survey points left; click a system for its details below.</div>
          </div>
        </v-card>

        <v-card ref="systemsPanel" class="panel" data-summary="Each system's gravitational and geological survey progress, the points left and how long the ships there would take. It shows which systems still need surveying." elevation="1">
          <div class="panel-head">
            <span>Systems<provenance-mark rule="survey.bodyPoints" /></span>
            <span class="d-flex align-center">
              <v-switch v-model="showSurveyed" label="Show fully surveyed" dense hide-details class="mt-0 mr-4" />
              <v-text-field v-model="search" label="Search systems" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <v-data-table :headers="systemHeaders" :items="visibleSystems" item-key="SystemID" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="systemsTable.sortBy" :sort-desc.sync="systemsTable.sortDesc" :item-class="(item) => (item.SystemID === selectedSystemId ? 'is-selected-row' : '')" :page.sync="page" :items-per-page.sync="systemsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" @click:row="onSystemClick">
            <template #[`item.Name`]="{ item }">
              <span class="font-weight-medium">{{ item.Name }}</span>
              <page-link class="ml-1" :to="linkTo.map(item.SystemID)" :name="item.Name" />
            </template>
            <template #[`item.gravSort`]="{ item }">
              <div class="progress-cell">
                <div class="meter"><div class="meter-fill" :style="{ width: `${item.gravShare * 100}%`, background: colors.grav }" /></div>
                <span class="caption text-no-wrap">{{ item.LocationsSurveyed }} / {{ item.Locations }}</span>
              </div>
            </template>
            <template #[`item.gravPoints`]="{ item }">
              <span :class="{ 'text--secondary': !item.gravPoints }">{{ item.gravPoints ? count(item.gravPoints) : 'Done' }}</span>
            </template>
            <template #[`item.geoSort`]="{ item }">
              <div class="progress-cell">
                <div class="meter"><div class="meter-fill" :style="{ width: `${item.geoShare * 100}%`, background: colors.geo }" /></div>
                <span class="caption text-no-wrap">{{ item.BodiesSurveyed }} / {{ item.Bodies }}</span>
              </div>
            </template>
            <template #[`item.geoPoints`]="{ item }">
              <span :class="{ 'text--secondary': !item.geoPoints }">{{ item.geoPoints ? count(item.geoPoints) : 'Done' }}</span>
            </template>
            <template #[`item.shipsHere`]="{ item }">
              <span v-if="item.fleetsHere.length" class="caption">{{ item.fleetsHere.join(', ') }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.etaSort`]="{ item }">
              <span v-if="item.eta !== null" class="text-no-wrap">{{ duration(item.eta) }}</span>
              <span v-else-if="item.etaUnknown" class="text--secondary">Rates unknown</span>
              <span v-else-if="item.gravPoints || item.geoPoints" class="text--secondary">No ships here</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div v-if="item.unsurveyedBodies.length">
                  <div class="caption text--secondary mb-2">Bodies left to survey geologically</div>
                  <div class="body-chips">
                    <v-chip v-for="body in item.unsurveyedBodies" :key="body.SystemBodyID" small class="mr-1 mb-1">{{ body.name }} · {{ count(body.Points) }} pts</v-chip>
                  </div>
                </div>
                <div v-else class="caption text--secondary">Every body here has been surveyed geologically.</div>
                <div v-if="item.Locations - item.LocationsSurveyed > 0" class="caption text--secondary mt-2">
                  {{ item.Locations - item.LocationsSurveyed }} survey locations left at {{ count(item.PointsPerLocation) }} points each (the primary's mass sets the points).
                </div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Survey points left: each gravitational location takes the system's points per location (more around a heavier primary), and a body takes its radius / 10 for a geological survey (radius / 100 for a gas giant or superjovian), at least 1. Time is survey time for the ships already in the system; travel between targets isn't counted. Fleets with one sensor type work their own survey in parallel; a fleet with both sensors does one target at a time, so its time is shared between the two surveys, in whichever split finishes the system soonest.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Survey fleets, where they are, what they are doing and how fast they survey. It shows whether the survey ships are used well." elevation="1">
          <div class="panel-head">
            <span>Survey fleets</span>
            <v-chip small>{{ formulaVersion ? 'Rates follow the 2.7 rules' : 'Rates are estimates' }}</v-chip>
          </div>
          <v-data-table :headers="fleetHeaders" :items="fleetRows" item-key="FleetID" :sort-by.sync="fleetsTable.sortBy" :sort-desc.sync="fleetsTable.sortDesc" disable-pagination hide-default-footer>
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}<page-link class="ml-1" :to="linkTo.routes({ from: place.fleet(item.FleetID) })" :name="item.FleetName" /></div>
                <div class="caption text--secondary">{{ item.shipNames }}</div>
              </div>
            </template>
            <template #[`item.SystemName`]="{ item }">
              {{ item.SystemName }}
              <page-link class="ml-1" :to="linkTo.map(item.SystemID)" :name="item.SystemName" />
            </template>
            <template #[`item.geoRate`]="{ item }">
              <span :class="{ 'text--secondary': !item.geoRate }">{{ item.geoRate ? count(item.geoRate) : '—' }}</span><provenance-mark v-if="item.geoRate !== 0" :result="item.geo" />
            </template>
            <template #[`item.gravRate`]="{ item }">
              <span :class="{ 'text--secondary': !item.gravRate }">{{ item.gravRate ? count(item.gravRate) : '—' }}</span><provenance-mark v-if="item.gravRate !== 0" :result="item.grav" />
            </template>
            <template #[`item.activity`]="{ item }">
              <span class="text-no-wrap">
                <v-icon small :color="item.activity.color">{{ item.activity.icon }}</v-icon>
                {{ item.activity.label }}
              </span>
              <div v-if="item.activity.note" class="caption text--secondary">{{ item.activity.note }}</div>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Points a day: the undamaged sensors' rating × 24 h × the officer factor (the science officer's Survey bonus while the ship's Science Department is undamaged, times half the captain's bonus; 1 for a ship without a captain) × the crew morale × the share of crew aboard, added over the fleet's ships (embarked ones too), × the naval admin Survey share in range × the game's survey speed ({{ surveySpeed }}%). The mark beside a rate shows how far it can be trusted: hover for what it rests on. The game keeps a fleet's gravitational rate until the save reloads, so that rate is always an estimate.
          </div>
        </v-card>

        <v-card v-if="groundRows.length" class="panel" data-summary="Bodies with mineral potential that could be surveyed on the ground, with progress and time left. It shows where ground survey teams would pay off." elevation="1">
          <div class="panel-head">
            <span>Ground surveys</span>
            <v-chip small>{{ groundRows.length }} {{ groundRows.length === 1 ? 'body' : 'bodies' }} with potential</v-chip>
          </div>
          <v-data-table :headers="groundHeaders" :items="groundRows" item-key="SystemBodyID" :sort-by.sync="groundTable.sortBy" :sort-desc.sync="groundTable.sortDesc" disable-pagination hide-default-footer>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.name }}</div>
                <div v-if="item.PopName" class="caption text--secondary">{{ item.PopName }}</div>
              </div>
            </template>
            <template #[`item.Potential`]="{ item }">{{ potentialLabel(item.Potential) }}</template>
            <template #[`item.progressSort`]="{ item }">
              <div class="progress-cell">
                <div class="meter"><div class="meter-fill" :style="{ width: `${Math.min(1, item.progress) * 100}%`, background: colors.geo }" /></div>
                <span class="caption text-no-wrap">{{ count(item.PointsDone) }} / {{ count(item.PointsRequired) }}</span>
              </div>
            </template>
            <template #[`item.PointsPerDay`]="{ item }"><span :class="{ 'text--secondary': !item.PointsPerDay }">{{ item.PointsPerDay ? fixed(item.PointsPerDay, 2) : '—' }}</span><provenance-mark v-if="item.PointsPerDay !== 0" :result="item.rate" /></template>
            <template #[`item.etaSort`]="{ item }">
              <span v-if="item.eta !== null" class="text-no-wrap">{{ duration(item.eta) }}</span>
              <span v-else-if="item.rateUnknown" class="text--secondary">Rate unknown</span>
              <span v-else class="text--secondary">{{ item.PopulationID ? 'No survey teams' : 'No colony' }}</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A ground survey needs a colony on the body and geosurvey formations there: each unit adds its equipment's points a day, times its commander's Survey bonus and the game's survey speed. It can raise the body's mineral deposits; the potential is what the geological survey found.
          </div>
        </v-card>

        <v-card v-if="deployment" class="panel" data-deploy="panel" data-summary="The race's geological survey and xenoarchaeology formations, each once, with whether it is idle, busy, embarked, at a place that is not resolved or at work that is not known, the known targets it could serve and the troop lifts it needs. It shows which specialists are free to redeploy and where known work waits; no order is issued." elevation="1">
          <div class="panel-head">
            <span>Specialist deployments</span>
            <v-chip small>{{ count(deployTotals.formations) }} {{ deployTotals.formations === 1 ? 'formation' : 'formations' }}</v-chip>
          </div>
          <div class="panel-body pb-0">
            <v-chip-group v-model="deployRoles" multiple column aria-label="Roles shown" data-deploy="roles">
              <v-chip v-for="choice in roleChoices" :key="choice.value" :value="choice.value" :data-deploy-chip="choice.value" :data-count="deployTotals[choice.value]" filter outlined small>{{ choice.text }} ({{ count(deployTotals[choice.value]) }})</v-chip>
            </v-chip-group>
            <v-chip-group v-model="deployStates" multiple column aria-label="States shown" data-deploy="states">
              <v-chip v-for="choice in stateChoices" :key="choice.value" :value="choice.value" :data-deploy-chip="choice.value" :data-count="deployTotals.states[choice.value]" filter outlined small>{{ choice.text }} ({{ count(deployTotals.states[choice.value]) }})</v-chip>
            </v-chip-group>
          </div>
          <v-data-table :headers="deployHeaders" :items="deployList" item-key="id" show-expand single-expand :expanded.sync="deployExpanded" :sort-by.sync="deployTable.sortBy" :sort-desc.sync="deployTable.sortDesc" :items-per-page.sync="deployTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" no-data-text="No formation matches the roles and states chosen" @click:row="toggleDeployment">
            <template #[`item.name`]="{ item }">
              <div class="py-2" :data-deploy-formation="item.id">
                <div class="font-weight-medium" data-deploy-name>{{ item.name }}</div>
                <div v-if="item.abbreviation" class="caption text--secondary">{{ item.abbreviation }}</div>
              </div>
            </template>
            <template #[`item.stateOrder`]="{ item }">
              <div class="py-2" :data-deploy-state="item.state">
                <span class="text-no-wrap" data-deploy-state-label>
                  <v-icon small :color="stateStyle(item.state).color">{{ stateStyle(item.state).icon }}</v-icon>
                  {{ item.stateLabel }}
                </span>
                <div v-if="item.workLabel" class="caption text--secondary" data-deploy-work>{{ item.workLabel }}</div>
                <div v-for="reason in item.stateReasons" :key="reason.kind" class="caption text--secondary">{{ reason.message }}</div>
              </div>
            </template>
            <template #[`item.systemName`]="{ item }">
              <template v-if="item.system">
                <span class="font-weight-medium">{{ item.system.name }}</span>
                <page-link class="ml-1" :to="linkTo.map(item.system.id)" :name="item.system.name" />
              </template>
              <span v-else class="text--secondary">{{ item.heldBy }}</span>
            </template>
            <template #[`item.geo`]="{ item }"><span :class="{ 'text--secondary': !item.geo }">{{ ratingText(item.geo) }}</span></template>
            <template #[`item.xeno`]="{ item }"><span :class="{ 'text--secondary': !item.xeno }">{{ ratingText(item.xeno) }}</span></template>
            <template #[`item.mass`]="{ item }">{{ item.mass === null ? 'Unknown' : count(item.mass) }}</template>
            <template #[`item.candidateSort`]="{ item }">{{ candidateLabel(item.candidates) }}</template>
            <template #[`item.liftSort`]="{ item }">
              <span :class="{ 'text--secondary': item.lift.kind !== 'one' && item.lift.kind !== 'several' }">{{ liftLabel(item.lift) }}</span>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div v-if="candidateList(item).length">
                  <div class="caption text--secondary mb-2">Known targets for {{ item.name }}, colonies of the race first and the nearest first</div>
                  <div v-for="candidate in candidateList(item)" :key="candidate.target.key" class="caption">
                    <span class="font-weight-medium">{{ candidate.target.name }}</span>
                    · {{ candidate.target.role === 'geo' ? 'Ground survey' : 'Ruins' }}
                    · {{ colonyText(candidate.target.colony) }}
                    · {{ leftText({ role: candidate.target.role, left: candidate.target.left }) }}
                    <span v-if="candidate.sameSystem"> · In its system</span>
                    <span v-if="candidate.staffed"> · {{ count(candidate.staffed) }} {{ candidate.staffed === 1 ? 'formation works' : 'formations work' }} there</span>
                  </div>
                </div>
                <div v-else class="caption text--secondary">No known target is left for the roles of {{ item.name }}.</div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Each geological survey or xenoarchaeology formation is listed once, with the capability its actual elements give; a formation with both ratings is one row. A formation is busy when it is stationed at a colony on a body with work for its role: ground survey potential left, for a geological formation, or a ruin whose builders are not yet identified or an ancient construct that is not active, for a xenoarchaeology one (a construct is work but no listed target). The game puts such a formation to work by itself, with no order, and the save stores no task for a formation, so the state is read from the location; it was read against the game's rules for both surveys. The commander's multiplier is not applied, so a formation the game would give no rating through its commander may show busy without making progress. The game requires a body to be surveyed by the race for a geological survey, so a geological formation at a colony on a body the race has not surveyed shows idle. It does not for a ruin, so a xenoarchaeology formation at a colony on a ruin outside the known targets (a body the race has not surveyed, a system it does not know or a ruin with no installations count stored), or when the ruins or the constructs could not be read, shows an activity that is not known, and so does a formation with a rating the save leaves unknown where a target is; it counts as neither idle nor free to redeploy. A colony needs no minimum population: an outpost with no residents counts. An embarked formation is aboard a ship and does no survey work; a formation whose place is not stored or not found has no state to give. The idle formations are packed together into the troop ships' bays, the largest first, and each formation with an activity that is not known is judged alone; a formation no bay holds is shown as that, never as transportable, and where the troop ships stand is not read. {{ count(deployTotals.others) }} {{ deployTotals.others === 1 ? 'formation of the race is' : 'formations of the race are' }} no geological or xenoarchaeology specialist, or {{ deployTotals.others === 1 ? 'has' : 'have' }} a rating the save leaves unknown. No assignment is issued.
          </div>
        </v-card>

        <v-card v-if="deployment" class="panel" data-targets="panel" data-summary="The known bodies where a geological survey or a xenoarchaeology formation has work, with the colony there, the work left and whether a formation is already at it. It shows where idle specialists would pay off; a body or ruin the race has not surveyed is never listed." elevation="1">
          <div class="panel-head">
            <span>Survey targets</span>
            <span class="d-flex align-center">
              <v-switch v-model="deployUnstaffed" label="Without a formation only" dense hide-details class="mt-0 mr-4" data-deploy="unstaffed" />
              <v-chip small>{{ count(targetList.length) }} {{ targetList.length === 1 ? 'target' : 'targets' }}</v-chip>
            </span>
          </div>
          <v-data-table :headers="targetHeaders" :items="targetList" item-key="key" :sort-by.sync="targetsTable.sortBy" :sort-desc.sync="targetsTable.sortDesc" :items-per-page.sync="targetsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" no-data-text="No known target matches the roles and the scope chosen">
            <template #[`item.name`]="{ item }">
              <span class="font-weight-medium" :data-target-key="item.key">{{ item.name }}</span>
              <page-link v-if="item.systemId" class="ml-1" :to="linkTo.map(item.systemId)" :name="item.systemName || item.name" />
            </template>
            <template #[`item.colonyName`]="{ item }"><span :class="{ 'text--secondary': !item.colony }">{{ colonyText(item.colony) }}</span></template>
            <template #[`item.left`]="{ item }">{{ leftText(item) }}</template>
            <template #[`item.status`]="{ item }"><span :class="{ 'text--secondary': item.status !== 'unstaffed' }">{{ targetStatus(item.status) }}</span></template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Targets are the bodies the race has surveyed in systems it knows: bodies with ground survey potential left, the same as the Ground surveys table, for geological formations, and ruins whose builders the race has not identified, for xenoarchaeology ones. A body or ruin the race has not surveyed is not known and is never listed. A formation can only work at a colony of the race, so a body with no colony needs one first; a colony counts as a candidate whatever its population, an outpost with no residents included. {{ ruinSummary }}
          </div>
        </v-card>

        <v-card v-if="formations" ref="formationsPanel" class="panel" data-summary="The race's ground formations, each once with its system or the reason it has none, by role: geological survey, xenoarchaeology or other. It shows the forces stationed at no colony and where they are, and each row opens its system on the map." elevation="1">
          <div class="panel-head">
            <span>Ground formations</span>
            <span v-if="formationModel" class="d-flex align-center">
              <v-chip v-if="formationSystem" small close class="mr-4" @click:close="formationSystem = null">{{ formationSystemName }}</v-chip>
              <v-switch v-model="remoteOnly" label="Remote only" dense hide-details class="mt-0 mr-4" />
              <v-chip small>{{ count(formationList.length) }} of {{ count(formationTotals.formations) }} {{ formationTotals.formations === 1 ? 'formation' : 'formations' }}</v-chip>
            </span>
          </div>
          <div v-if="!formationModel" class="panel-body text--secondary">The save lacks {{ formations.missing.join(', ') }}, so the race's ground formations cannot be listed.</div>
          <template v-else>
            <div class="panel-body pb-0">
              <v-chip-group v-model="remoteRoles" multiple column aria-label="Roles shown">
                <v-chip v-for="option in roleOptions" :key="option.value" :value="option.value" filter outlined small>{{ option.text }} ({{ count(formationTotals[option.value]) }})</v-chip>
              </v-chip-group>
            </div>
            <v-data-table :headers="formationHeaders" :items="formationList" item-key="id" :sort-by.sync="formationsTable.sortBy" :sort-desc.sync="formationsTable.sortDesc" :items-per-page.sync="formationsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" no-data-text="No formation matches the roles and the scope chosen" @click:row="openFormation">
              <template #[`item.name`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div v-if="item.abbreviation" class="caption text--secondary">{{ item.abbreviation }}</div>
                </div>
              </template>
              <template #[`item.systemName`]="{ item }">
                <template v-if="item.system">
                  <span class="font-weight-medium">{{ item.system.name }}</span>
                  <page-link class="ml-1" :to="linkTo.map(item.system.id)" :name="item.system.name" />
                </template>
                <div v-else class="caption text--secondary">
                  <div v-for="reason in item.reasons" :key="reason.kind">{{ reason.message }}</div>
                </div>
              </template>
              <template #[`item.where`]="{ item }">
                <span :class="{ 'text--secondary': item.remote !== true }">{{ item.where }}</span>
              </template>
              <template #[`item.roleLabel`]="{ item }">
                <span :class="['text-no-wrap', { 'text--secondary': item.roles.undetermined }]">{{ item.roleLabel }}</span>
              </template>
              <template #[`item.geo`]="{ item }"><span :class="{ 'text--secondary': !item.geo }">{{ ratingText(item.geo) }}</span></template>
              <template #[`item.xeno`]="{ item }"><span :class="{ 'text--secondary': !item.xeno }">{{ ratingText(item.xeno) }}</span></template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              {{ remoteDefinition }}
              Of {{ count(formationTotals.formations) }} {{ remoteOnly ? (formationTotals.formations === 1 ? 'formation in scope (remote, or at a colony the save does not hold)' : 'formations in scope (remote, or at a colony the save does not hold)') : (formationTotals.formations === 1 ? 'formation' : 'formations') }}, {{ count(formationTotals.placed) }} {{ formationTotals.placed === 1 ? 'is' : 'are' }} in a system the race has named and {{ count(formationTotals.unplaced) }} {{ formationTotals.unplaced === 1 ? 'has' : 'have' }} none (the row says why; no place is guessed). {{ count(formationTotals.geo) }} geological and {{ count(formationTotals.xeno) }} xenoarchaeology, {{ count(formationTotals.both) }} of them both and listed once, {{ count(formationTotals.other) }} other{{ formationTotals.unknown ? `, ${count(formationTotals.unknown)} with a role not known` : '' }}. In the whole race {{ count(formationTotals.remote) }} {{ formationTotals.remote === 1 ? 'is' : 'are' }} remote, {{ count(formationTotals.atColonies) }} at colonies{{ formationTotals.remoteUnknown ? ` and ${count(formationTotals.remoteUnknown)} at a colony the save does not hold` : '' }}.
            </div>
          </template>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { chartTheme, withAlpha } from '../components/charts/theme'
import { activeAppearance } from '../utilities/appearance'
import SystemMap from '../components/exploration/SystemMap.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import capabilityGates from '../mixins/capability-gates'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import { systemBodyName } from '../utilities/aurora'
import { cleanQuery, linkTo, place, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { navalAdminChain } from '../utilities/minerals'
import { loadNavalAdmins } from '../utilities/naval-admins'
import { sumResults, unavailable, valueOrNull } from '../utilities/provenance'
import { bodyPointsSql, fleetSurveyRate, groundSurveyRate, loadSurveyShips, surveyShipSql } from '../utilities/survey'
import { surveyDays } from '../utilities/survey-eta'
import { formationRows, remoteOnlyView, REMOTE_DEFINITION, ROLE_OPTIONS, rolesView, rowTotals, selectRows } from '../utilities/remote-formations'
import { loadGroundFormations } from '../utilities/ground-formations'
import { loadBootstrapFreight } from '../utilities/mine-bootstrap-data'
import { candidatesOf, candidateText, colonyGeoTeams, constructBodies, deploymentTotals, liftText, loadConstructSites, loadRuinSites, rolesView as deployRolesView, ROLE_CHOICES, ruinTargets, selectDeployments, specialistRows, STATE_CHOICES, statesView as deployStatesView, targetRows, geoTargets } from '../utilities/specialist-deployments'
import { loadFormulaVersion } from '../utilities/capabilities'

const INPUT_LABELS = {
  game: 'the game settings',
  systems: 'the known systems',
  bodies: 'the unsurveyed bodies',
  links: 'the jump points',
  ships: 'the survey ships',
  orders: 'fleet orders',
  standingOrders: 'standing orders',
  groundSurveys: 'ground surveys',
  formations: 'the ground formations',
  groundCommanders: 'the ground survey commanders',
  ruinSites: 'the known ruins',
  constructSites: 'the ancient constructs',
  troopBays: 'the troop ships',
  navalAdmins: 'naval admin commands',
  formulaVersion: 'the save\'s schema',
}
// FCT_SystemBody.GroundMineralSurvey, as the Minerals page labels it.
const POTENTIAL = { 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }
const SURVEY_ORDERS = new Set([9, 12])
const PAGE_SIZES = [15, 30, -1]
// The ground survey of a colony with no formation of the race.
const NO_TEAM = Object.freeze({ units: 0, base: 0, perDay: 0, unknown: Object.freeze([]) })
const STATE_STYLE = { idle: { icon: 'mdi-sleep', color: 'warning' }, busy: { icon: 'mdi-hammer-wrench', color: 'success' }, embarked: { icon: 'mdi-ferry', color: '' }, unresolved: { icon: 'mdi-help-circle-outline', color: '' }, unknown: { icon: 'mdi-help-rhombus-outline', color: '' } }
const TARGET_STATUS = { worked: 'A formation is working here', unstaffed: 'No formation here', 'no-colony': 'No colony yet' }

export default {
  name: 'SurveyProgressPage',
  components: { LoadState, PageLink, ProvenanceMark, StatTiles, SystemMap },
  mixins: [
    capabilityGates,
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      showSurveyed: { key: 'surveyShowSurveyed', default: false },
      search: { key: 'surveySearch', default: '', scope: 'race' },
      systemsTable: tableView('surveySystemsTable', { sortBy: ['remaining'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      fleetsTable: tableView('surveyFleetsTable', {}),
      groundTable: tableView('surveyGroundTable', {}),
      remoteRoles: rolesView,
      remoteOnly: remoteOnlyView,
      formationsTable: tableView('surveyFormationsTable', { sortBy: ['systemName'], sortDesc: false, itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      deployRoles: deployRolesView,
      deployStates: deployStatesView,
      deployUnstaffed: { key: 'deployUnstaffedOnly', scope: 'race', default: false },
      deployTable: { ...tableView('surveyDeployTable', { sortBy: ['stateOrder'], sortDesc: false, itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
      targetsTable: { ...tableView('surveyTargetsTable', { sortBy: ['name'], sortDesc: false, itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
    }),
  ],
  data() {
    return {
      pageSizes: PAGE_SIZES,
      expanded: [],
      page: 1,
      selectedSystemId: null,
      formationSystem: null,
      formationsPending: false,
      deployExpanded: [],
      revealPending: false,
      linkTo,
      place,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    // The survey rates rest on the Survey bonus (2) of the officers and of the naval admin chain; they are not given while the save's lookup row for it is not confirmed.
    surveyBlocked() {
      return this.blockedBonuses.has(2)
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    colors() {
      const { geological, gravitational, both } = this.appearance.survey

      return { geo: geological, grav: gravitational, both, done: withAlpha(this.theme.inkMuted, 0.45) }
    },

    mapLegend() {
      return [
        { key: 'both', label: 'Both surveys left', color: this.colors.both },
        { key: 'grav', label: 'Gravitational left', color: this.colors.grav },
        { key: 'geo', label: 'Geological left', color: this.colors.geo },
        { key: 'done', label: 'Fully surveyed', color: this.colors.done },
      ]
    },

    // The game's survey speed in percent; null while the game settings are not known, which leaves the rates unavailable.
    surveySpeed() {
      return this.game ? this.game.SurveySpeed : null
    },

    // One row per survey fleet with its geological and gravitational points a day: `geo` and `grav` are provenance results (utilities/provenance.js) and `geoRate` and `gravRate` their values, null when unavailable.
    fleetRows() {
      const { surveySpeed: speed, formulaVersion: version, navalAdmins } = this
      const fleets = {}

      this.ships.forEach((ship) => {
        const fleet = (fleets[ship.FleetID] = fleets[ship.FleetID] || { FleetID: ship.FleetID, FleetName: ship.FleetName, SystemID: ship.SystemID, SystemName: ship.SystemName, NavalAdminCommandID: ship.NavalAdminCommandID, Moving: ship.Moving, ships: [] })

        fleet.ships.push(ship)
      })

      return Object.values(fleets).map((fleet) => {
        const ships = fleet.ships.slice().sort((a, b) => a.ShipID - b.ShipID)
        const { bonus: admin, unknown: adminGap } = navalAdminChain(navalAdmins, fleet.SystemID, fleet.NavalAdminCommandID)
        const geo = this.surveyBlocked ? this.withheldRate('survey.geoRate') : fleetSurveyRate(ships, 'geo', { speed, admin, adminGap, version })
        const grav = this.surveyBlocked ? this.withheldRate('survey.gravRate') : fleetSurveyRate(ships, 'grav', { speed, admin, adminGap, version })

        return {
          ...fleet,
          shipNames: ships.map((ship) => (ship.MothershipID ? `${ship.ShipName} (embarked)` : ship.ShipName)).join(', '),
          geo,
          grav,
          geoRate: valueOrNull(geo),
          gravRate: valueOrNull(grav),
          activity: this.activity(fleet),
        }
      }).sort((a, b) => a.FleetName.localeCompare(b.FleetName))
    },

    bodiesBySystem() {
      const bySystem = {}

      this.bodies.forEach((body) => {
        ;(bySystem[body.SystemID] = bySystem[body.SystemID] || []).push({ ...body, name: systemBodyName(body) })
      })

      return bySystem
    },

    // Computed values are read once, outside the loop: each read inside it would subscribe this property to every dependency of theirs again, which is every unsurveyed body.
    systemRows() {
      const { fleetRows, bodiesBySystem } = this

      return this.systems.map((system) => {
        const fleets = fleetRows.filter((fleet) => fleet.SystemID === system.SystemID)
        const gravPoints = Math.max(0, system.Locations - system.LocationsSurveyed) * system.PointsPerLocation
        const geoPoints = system.GeoPoints || 0
        const etaUnknown = Boolean(gravPoints || geoPoints) && fleets.some((fleet) => fleet.geoRate === null || fleet.gravRate === null)
        const eta = gravPoints || geoPoints ? (etaUnknown ? null : surveyDays(gravPoints, geoPoints, fleets)) : null

        return {
          ...system,
          gravPoints,
          geoPoints,
          remaining: gravPoints + geoPoints,
          gravShare: system.Locations ? system.LocationsSurveyed / system.Locations : 1,
          geoShare: system.Bodies ? system.BodiesSurveyed / system.Bodies : 1,
          gravSort: system.Locations ? system.LocationsSurveyed / system.Locations : 1,
          geoSort: system.Bodies ? system.BodiesSurveyed / system.Bodies : 1,
          fleetsHere: fleets.map((fleet) => fleet.FleetName),
          shipsHere: fleets.length,
          eta,
          etaUnknown,
          etaSort: eta ?? Infinity,
          unsurveyedBodies: bodiesBySystem[system.SystemID] || [],
        }
      })
    },

    visibleSystems() {
      const search = (this.search || '').toLowerCase()

      return this.systemRows.filter((system) => (this.showSurveyed || system.remaining > 0 || system.SystemID === this.selectedSystemId) && (!search || system.Name.toLowerCase().includes(search)))
    },

    // Surveyed systems first, so the ones with work left draw on top.
    mapNodes() {
      const maxRemaining = Math.max(...this.systemRows.map((system) => system.remaining), 1)

      return this.systemRows.map((system) => {
        const status = system.gravPoints && system.geoPoints ? 'both' : system.gravPoints ? 'grav' : system.geoPoints ? 'geo' : 'done'

        return {
          ...system,
          size: system.remaining ? 5 + 9 * Math.sqrt(system.remaining / maxRemaining) : 3.5,
          color: this.colors[status],
          ring: system.shipsHere ? this.theme.ink : null,
          label: system.remaining > 0 || system.shipsHere > 0,
          title: `${system.Name}: ${system.remaining ? `${this.count(system.remaining)} survey points left` : 'fully surveyed'}${system.shipsHere ? `, ${system.fleetsHere.join(', ')}` : ''}`,
        }
      }).sort((a, b) => a.remaining - b.remaining)
    },

    // The Survey bonus of each formation's commander as a map from the formation's id; a formation with no commander or no bonus has none, which counts as 1.
    commanderBonuses() {
      return new Map(this.groundCommanders.map((row) => [row.FormationID, row.BonusValue]))
    },

    // The geosurvey units, rating and rate of the formations at each colony, from the model's formations (`colonyGeoTeams`), so a colony's ground survey rate and the specialist list use the same ratings; null while the save lacks what the model reads.
    colonyTeams() {
      return this.formationModel ? colonyGeoTeams(this.formationModel, this.commanderBonuses) : null
    },

    groundRows() {
      const { colonyTeams: teams } = this

      return this.groundSurveys.map((row) => {
        const team = row.PopulationID ? (teams ? teams.get(row.PopulationID) || NO_TEAM : null) : NO_TEAM
        const teamUnknown = team === null || team.unknown.length > 0
        const rate = groundSurveyRate(teamUnknown ? null : team.perDay, this.surveySpeed)
        const perDay = valueOrNull(rate)
        const remaining = Math.max(0, row.PointsRequired - row.PointsDone)
        const eta = perDay > 0 ? remaining / perDay : null

        return {
          ...row,
          Units: team ? team.units : 0,
          rate,
          PointsPerDay: perDay,
          rateUnknown: rate.status === 'unavailable' && ((team !== null && team.units > 0) || teamUnknown),
          name: row.SystemBodyName ? `${row.SystemName} · ${row.SystemBodyName}` : systemBodyName(row, { Name: row.SystemName }),
          progress: row.PointsRequired > 0 ? row.PointsDone / row.PointsRequired : 0,
          progressSort: row.PointsRequired > 0 ? row.PointsDone / row.PointsRequired : 0,
          eta,
          etaSort: eta ?? Infinity,
        }
      })
    },

    // The specialist formations against the known targets (`specialistRows`): the geological targets are the ground survey rows above, the xenoarchaeology ones the known ruins whose builders are not identified; null while the save lacks what the formation model reads. The ruins the race has not surveyed but a colony stands on are carried as the places the game may work (`unseen`), and a ruin read that failed leaves every place open (null).
    deployment() {
      if (!this.formationModel) {
        return null
      }

      const ruins = this.ruinSites && this.ruinSites.supported ? ruinTargets(this.ruinSites.rows) : { targets: [], states: null, unseen: null }
      const constructs = this.constructSites && this.constructSites.supported ? constructBodies(this.constructSites.rows) : null

      return Object.freeze({ ...specialistRows(this.formationModel, { geo: geoTargets(this.groundRows), xeno: ruins.targets, unseen: ruins.unseen, constructs }, this.troopBays.troops), ruinStates: ruins.states })
    },

    deployTotals() {
      return this.deployment ? deploymentTotals(this.deployment.rows, this.deployment.others, this.deployment.index) : null
    },

    // The ruin counts the targets rest on, as a sentence, or that the ruins could not be read.
    ruinSummary() {
      const states = this.deployment ? this.deployment.ruinStates : null

      if (!states) {
        return 'The ruins of the race could not be read from this save, so no xenoarchaeology target is listed and the activity of a xenoarchaeology formation at a colony is not known.'
      }

      return `Of the ruins on the surveyed bodies, ${this.count(states.found)} await identification of their builders, ${this.count(states.identified)} have been identified, ${this.count(states.used)} have no installations left and ${this.count(states.unknown)} give no installations count.`
    },

    deployList() {
      return this.deployment ? selectDeployments(this.deployment.rows, { roles: this.deployRoles, states: this.deployStates }) : []
    },

    // The targets in the roles on, with only those no formation works when asked.
    targetList() {
      if (!this.deployment) {
        return []
      }

      return targetRows(this.deployment.index, this.deployment.rows).filter((row) => this.deployRoles.includes(row.role) && (!this.deployUnstaffed || row.status !== 'worked'))
    },

    roleChoices() {
      return ROLE_CHOICES
    },

    stateChoices() {
      return STATE_CHOICES
    },

    deployHeaders() {
      return [
        { text: 'Formation', value: 'name' },
        { text: 'State', value: 'stateOrder' },
        { text: 'System', value: 'systemName' },
        { text: 'Role', value: 'roleLabel' },
        { text: 'Geological', value: 'geo', align: 'end' },
        { text: 'Xenoarchaeology', value: 'xeno', align: 'end' },
        { text: 'Mass (t)', value: 'mass', align: 'end' },
        { text: 'Candidates', value: 'candidateSort' },
        { text: 'Troop lift', value: 'liftSort' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    targetHeaders() {
      return [
        { text: 'Target', value: 'name' },
        { text: 'Kind', value: 'roleLabel' },
        { text: 'Colony', value: 'colonyName' },
        { text: 'Work left', value: 'left', align: 'end' },
        { text: 'Formations busy', value: 'busy', align: 'end' },
        { text: 'Idle with the role', value: 'idle', align: 'end' },
        { text: 'Status', value: 'status' },
      ]
    },

    // The model of the race's ground formations when the save has what it needs, else null.
    formationModel() {
      return this.formations && this.formations.supported ? this.formations : null
    },

    // Every formation once (`formationRows`), whatever the table shows.
    formationAll() {
      return this.formationModel ? Object.freeze(formationRows(this.formationModel)) : []
    },

    // The rows in the scope chosen: the roles on, the remote ones only if asked, and the system a link named.
    formationList() {
      const rows = selectRows(this.formationAll, { roles: this.remoteRoles, remoteOnly: this.remoteOnly })

      return this.formationSystem === null ? rows : rows.filter((row) => row.system && row.system.id === this.formationSystem)
    },

    formationTotals() {
      return this.formationModel ? rowTotals(this.formationModel, { remoteOnly: this.remoteOnly }) : null
    },

    formationSystemName() {
      const row = this.formationAll.find((item) => item.system && item.system.id === this.formationSystem)

      return `System ${row ? row.system.name : this.formationSystem}`
    },

    // The roles the chips offer: one for formations with no role to count them under only where there are some.
    roleOptions() {
      return ROLE_OPTIONS.filter((option) => option.value !== 'unknown' || this.formationTotals.unknown > 0)
    },

    remoteDefinition() {
      return REMOTE_DEFINITION
    },

    formationHeaders() {
      return [
        { text: 'Formation', value: 'name' },
        { text: 'System', value: 'systemName' },
        { text: 'Held by', value: 'heldBy' },
        { text: 'Where', value: 'where' },
        { text: 'Role', value: 'roleLabel' },
        { text: 'Geological', value: 'geo', align: 'end' },
        { text: 'Xenoarchaeology', value: 'xeno', align: 'end' },
      ]
    },

    tiles() {
      const systems = this.systemRows
      const done = systems.filter((system) => !system.remaining).length
      const grav = systems.filter((system) => system.gravPoints > 0)
      const geo = systems.filter((system) => system.geoPoints > 0)
      const locations = grav.reduce((sum, system) => sum + system.Locations - system.LocationsSurveyed, 0)
      const bodies = geo.reduce((sum, system) => sum + system.unsurveyedBodies.length, 0)
      const geoRate = valueOrNull(sumResults({ rule: 'survey.geoRate', results: this.fleetRows.map((fleet) => fleet.geo) }))
      const gravRate = valueOrNull(sumResults({ rule: 'survey.gravRate', results: this.fleetRows.map((fleet) => fleet.grav) }))
      const idle = this.fleetRows.filter((fleet) => fleet.activity.idle).length

      return [
        {
          label: 'Systems fully surveyed',
          value: `${done} of ${systems.length}`,
          note: systems.length - done ? `${systems.length - done} with work left` : 'Every known system is done',
          icon: systems.length - done ? null : 'mdi-check-circle',
          iconColor: 'success',
        },
        {
          label: 'Gravitational survey left',
          value: locations ? `${this.count(locations)} locations` : 'None',
          note: locations ? `${this.count(grav.reduce((sum, system) => sum + system.gravPoints, 0))} points in ${grav.length} ${grav.length === 1 ? 'system' : 'systems'}` : 'Every jump point can be found',
        },
        {
          label: 'Geological survey left',
          value: bodies ? `${this.count(bodies)} bodies` : 'None',
          note: bodies ? `${this.count(geo.reduce((sum, system) => sum + system.geoPoints, 0))} points in ${geo.length} ${geo.length === 1 ? 'system' : 'systems'}` : 'Every body has been surveyed',
        },
        {
          label: 'Survey capacity',
          value: `${this.fleetRows.length} ${this.fleetRows.length === 1 ? 'fleet' : 'fleets'}`,
          note: `${geoRate === null ? 'Unknown' : this.count(geoRate)} geological and ${gravRate === null ? 'unknown' : this.count(gravRate)} gravitational points a day${idle ? `; ${idle} idle` : ''}`,
          icon: idle ? 'mdi-sleep' : null,
          iconColor: 'warning',
        },
      ]
    },

    systemHeaders() {
      return [
        { text: 'System', value: 'Name' },
        { text: 'Gravitational', value: 'gravSort' },
        { text: 'Points left', value: 'gravPoints', align: 'end' },
        { text: 'Geological', value: 'geoSort' },
        { text: 'Points left', value: 'geoPoints', align: 'end' },
        { text: 'Survey fleets here', value: 'shipsHere' },
        { text: 'Survey time', value: 'etaSort', align: 'end' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    fleetHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'System', value: 'SystemName' },
        { text: 'Geological pts / day', value: 'geoRate', align: 'end' },
        { text: 'Gravitational pts / day', value: 'gravRate', align: 'end' },
        { text: 'Doing', value: 'activity', sortable: false },
      ]
    },

    groundHeaders() {
      return [
        { text: 'Body', value: 'name' },
        { text: 'Potential', value: 'Potential' },
        { text: 'Progress', value: 'progressSort' },
        { text: 'Teams (units)', value: 'Units', align: 'end' },
        { text: 'Points / day', value: 'PointsPerDay', align: 'end' },
        { text: 'Time left', value: 'etaSort', align: 'end' },
      ]
    },

    selectedSystem() {
      return this.systems.find((system) => system.SystemID === this.selectedSystemId) || null
    },

    linkQuery() {
      return cleanQuery({ system: this.selectedSystemId, formations: this.formationSystem })
    },

    linkLabel() {
      return this.selectedSystem && this.selectedSystem.Name
    },
  },
  watch: {
    // A system a link names is shown once the reads have it.
    systemRows() {
      this.revealLinked()
    },
    formationAll() {
      this.revealFormations()
    },
    // The panel is drawn only once every input has arrived: a link that named a system's formations is retried then.
    ready() {
      this.revealFormations()
    },
  },
  methods: {
    withheldRate(rule) {
      return unavailable({ rule, missing: ['commander bonus 2, Survey (the save\'s lookup row is not confirmed)'] })
    },

    applyLink(query) {
      this.selectedSystemId = queryId(query.system)
      this.formationSystem = queryId(query.formations)
      this.formationsPending = this.formationSystem !== null
      this.revealPending = this.selectedSystemId !== null

      if (this.revealPending) {
        this.revealLinked()
      } else {
        this.expanded = []
      }

      this.revealFormations()
    },

    // Brings the formations table into view once it has rows and the page draws it, for a link that named a system's formations, with its title and filters below the fixed app bar. The link stays pending until the panel exists, and then scrolls once.
    revealFormations() {
      if (this.formationsPending && this.formationAll.length && this.ready) {
        this.$nextTick(() => {
          const panel = this.$refs.formationsPanel

          if (this.formationsPending && panel && panel.$el) {
            this.formationsPending = false
            this.$vuetify.goTo(panel.$el)
          }
        })
      }
    },

    // A formation's row opens its system on the map; one with no known system has none to open.
    openFormation(item) {
      if (item.system) {
        this.$router.push(linkTo.map(item.system.id))
      }
    },

    // The icon and colour of a state, the words of a target's status and of a colony, and the work left on a target.
    stateStyle(state) {
      return STATE_STYLE[state]
    },

    targetStatus(status) {
      return TARGET_STATUS[status]
    },

    colonyText(colony) {
      return colony ? `${colony.name || `Colony ${colony.id}`}${colony.population === 0 ? ' (no residents)' : ''}` : 'No colony'
    },

    leftText(target) {
      return target.role === 'geo' ? `${this.count(target.left)} points` : `${this.count(target.left)} installations`
    },

    liftLabel(lift) {
      return liftText(lift, this.count)
    },

    candidateLabel(candidates) {
      return candidateText(candidates, this.count)
    },

    // The targets a formation could serve, nearest first (`candidatesOf`).
    candidateList(item) {
      return candidatesOf(item, this.deployment.index, this.deployment.rows)
    },

    toggleDeployment(_item, { expand, isExpanded }) {
      expand(!isExpanded)
    },

    ratingText(value) {
      return value === null ? 'Unknown' : value > 0 ? this.fixed(value, 2) : '—'
    },

    revealLinked() {
      if (this.revealPending && this.revealSystem(this.selectedSystemId)) {
        this.revealPending = false
      }
    },

    onSystemClick(item, { expand, isExpanded }) {
      this.selectedSystemId = item.SystemID
      this.revealPending = false
      expand(!isExpanded)
    },

    selectSystem(systemId) {
      this.selectedSystemId = systemId
      this.revealPending = false

      if (this.revealSystem(systemId)) {
        this.$nextTick(() => {
          const panel = this.$refs.systemsPanel

          if (panel && panel.$el) {
            panel.$el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        })
      }
    },

    // Expands the system's row, on the page of the table it falls on; false while the system isn't among the rows.
    revealSystem(systemId) {
      const row = this.systemRows.find((system) => system.SystemID === systemId)

      if (!row) {
        return false
      }

      this.setUnsaved('search', '')
      this.setUnsaved('systemsTable', { ...this.systemsTable, sortBy: ['remaining'], sortDesc: [true] })
      this.expanded = [row]

      // The row's page in the order the table will show: unfiltered, most work left first (the table's numeric sort is a stable subtraction too, so ties keep the same order).
      const sorted = this.visibleSystems.slice().sort((a, b) => b.remaining - a.remaining)
      const target = this.systemsTable.itemsPerPage > 0 ? Math.floor(sorted.findIndex((system) => system.SystemID === systemId) / this.systemsTable.itemsPerPage) + 1 : 1

      this.page = target
      // The table clamps the page to the pages it has before the cleared search widens the list.
      this.$nextTick(() => {
        this.page = target
      })

      return true
    },

    activity(fleet) {
      const orders = this.orders.filter((order) => order.FleetID === fleet.FleetID)
      const standing = this.standingOrders.filter((order) => order.FleetID === fleet.FleetID).map((order) => order.Description)

      // The current order (lowest MoveOrder) decides; a survey order further down is still to come.
      if (orders.length && SURVEY_ORDERS.has(orders[0].MoveActionID)) {
        return { label: 'Surveying', note: orders[0].Description, icon: 'mdi-radar', color: 'success' }
      } else if (orders.length) {
        return { label: 'Under way', note: orders[0].Description, icon: 'mdi-arrow-right-bold', color: '' }
      } else if (standing.length) {
        return { label: 'Standing orders', note: standing.join(', '), icon: 'mdi-autorenew', color: '' }
      }

      return { label: 'Idle', note: 'No orders and no survey standing orders', icon: 'mdi-sleep', color: 'warning', idle: true }
    },

    potentialLabel(value) {
      return POTENTIAL[value] || '—'
    },
    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
  },
  asyncComputed: {
    game: {
      get: tracked('game', async function () {
        if (!this.database || !this.GameID) {
          return null
        }

        return await this.database.query(`select FCT_Game.SurveySpeed from FCT_Game where FCT_Game.GameID = ${this.GameID}`).then(([items]) => items[0] || null)
      }),
      default: null,
    },
    // Known systems with their gravitational locations (done of all) and geological bodies (planets, moons, asteroids, comets; points left on the ones neither surveyed nor banned). The large reads are frozen: read-only rows Vue needn't observe.
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_System.JumpPointSurveyPoints as PointsPerLocation, coalesce(VIR_Locations.Locations, 0) as Locations, coalesce(VIR_Surveyed.Locations, 0) as LocationsSurveyed, coalesce(VIR_Bodies.Bodies, 0) as Bodies, coalesce(VIR_Bodies.Surveyed, 0) as BodiesSurveyed, coalesce(VIR_Bodies.Points, 0) as GeoPoints from FCT_RaceSysSurvey inner join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_SurveyLocation.SystemID, count(*) as Locations from FCT_SurveyLocation where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID) as VIR_Locations on VIR_Locations.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_RaceSurveyLocation.SystemID, count(*) as Locations from FCT_RaceSurveyLocation where FCT_RaceSurveyLocation.GameID = ${this.GameID} and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} group by FCT_RaceSurveyLocation.SystemID) as VIR_Surveyed on VIR_Surveyed.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_SystemBody.SystemID, count(*) as Bodies, sum(case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end) as Surveyed, sum(case when FCT_SystemBodySurveys.SystemBodyID is null and FCT_BannedBodies.SystemBodyID is null then ${bodyPointsSql()} else 0 end) as Points from FCT_SystemBody left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${this.RaceID} and FCT_BannedBodies.GameID = ${this.GameID} where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) group by FCT_SystemBody.SystemID) as VIR_Bodies on VIR_Bodies.SystemID = FCT_RaceSysSurvey.SystemID where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    bodies: {
      get: tracked('bodies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, ${bodyPointsSql()} as Points from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${this.RaceID} and FCT_BannedBodies.GameID = ${this.GameID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBodySurveys.SystemBodyID is null and FCT_BannedBodies.SystemBodyID is null order by FCT_SystemBody.SystemID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Jump links the race has charted to a system it knows.
    links: {
      get: tracked('links', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_JumpPoint.SystemID, VIR_Destination.SystemID as DestinationID from FCT_JumpPoint inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1 inner join FCT_JumpPoint as VIR_Destination on VIR_Destination.WarpPointID = FCT_JumpPoint.WPLink inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = VIR_Destination.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_JumpPoint.GameID = ${this.GameID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Ships with geological or gravitational sensors, with their undamaged sensors, crew and officers (`loadSurveyShips`).
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadSurveyShips(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.Description from FCT_MoveOrders where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.FleetID in (select FCT_Ship.FleetID from FCT_Ship where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and ${surveyShipSql()}) order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
      }),
      default: [],
    },
    standingOrders: {
      get: tracked('standingOrders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_FleetStandingOrder.FleetID, DIM_StandingOrders.Description from FCT_FleetStandingOrder inner join DIM_StandingOrders on DIM_StandingOrders.OrderID = FCT_FleetStandingOrder.StandingOrderID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_FleetStandingOrder.FleetID where FCT_Fleet.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} and (DIM_StandingOrders.Description like 'SV:%' or DIM_StandingOrders.Description like '%survey%') order by FCT_FleetStandingOrder.FleetID, FCT_FleetStandingOrder.Priority`).then(([items]) => items)
      }),
      default: [],
    },
    // Geologically surveyed bodies with ground-survey potential left, with the race's colony there (progress in GroundGeoSurvey) and its geosurvey formations' points a day.
    groundSurveys: {
      get: tracked('groundSurveys', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.GroundMineralSurvey as Potential, ${bodyPointsSql()} as PointsRequired, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population as ColonyPopulation, coalesce(FCT_Population.GroundGeoSurvey, 0) as PointsDone from FCT_SystemBody inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_Population on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.GameID = ${this.GameID} where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.GroundMineralSurvey > 0 order by FCT_SystemBody.GroundMineralSurvey desc, FCT_Population.PopulationID desc`).then(([items]) => items)
      }),
      default: [],
    },
    // The Survey bonus of each ground formation's commander (formation id and bonus), which the ground survey rate of a colony multiplies the formations' rating by.
    groundCommanders: {
      get: tracked('groundCommanders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Commander.CommandID as FormationID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 2 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 5`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The ruins on the bodies the race has surveyed (`loadRuinSites`), or { supported: false, missing } for a save without what it reads.
    ruinSites: {
      get: tracked('ruinSites', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return Object.freeze(await loadRuinSites(this.database, { GameID: this.GameID, RaceID: this.RaceID }))
      }),
      default: null,
    },
    // The ancient constructs on the bodies the race has a colony on (`loadConstructSites`), or { supported: false, missing } for a save without what it reads.
    constructSites: {
      get: tracked('constructSites', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return Object.freeze(await loadConstructSites(this.database, { GameID: this.GameID, RaceID: this.RaceID }))
      }),
      default: null,
    },
    // The race's troop ships by class (`loadBootstrapFreight`), whose bays the formations are carried in: { troops: { classes } } or { troops: null } when the save does not give them.
    troopBays: {
      get: tracked('troopBays', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { troops: null }
        }

        const { troops } = await loadBootstrapFreight(this.database, { GameID: this.GameID, RaceID: this.RaceID })

        return Object.freeze({ troops })
      }),
      default: { troops: null },
    },
    // The race's ground formations as one model (`loadGroundFormations`), or { supported: false, missing } for a save without what it reads.
    formations: {
      get: tracked('formations', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return Object.freeze(await loadGroundFormations(this.database, { GameID: this.GameID, RaceID: this.RaceID }))
      }),
      default: null,
    },
    // Naval admin commands with their Survey bonus.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const { ranks, blocked } = await this.capabilityGates('/survey-progress')

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 2, share: 'Survey', ranks, blocked })
      }),
      default: {},
    },
    // The formula version the save's schema stands for (`loadFormulaVersion`, utilities/capabilities.js): the stated one for a 2.7-shaped save, null for any other shape.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.survey-page {
  .search-field {
    min-width: 220px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .progress-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .meter {
    flex: 0 0 72px;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
  }

  tr.is-selected-row {
    background: var(--ae-row-selected);
  }
}
</style>
