<template>
  <div>
    <v-container fluid class="transport-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--place">
            <div class="tool__label caption text--secondary">From</div>
            <v-autocomplete :value="origin && origin.key" :items="places" item-text="name" item-value="key" :filter="filterPlace" aria-label="From" dense outlined hide-details auto-select-first @change="setFrom">
              <template #item="{ item }">
                <v-icon small class="mr-3">{{ item.icon }}</v-icon>
                <v-list-item-content>
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.subtitle }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--swap">
            <v-btn icon :disabled="!destination" aria-label="Swap From and To" title="Swap From and To" @click="swap"><v-icon>mdi-swap-horizontal</v-icon></v-btn>
          </div>
          <div class="tool tool--place">
            <div class="tool__label caption text--secondary">To</div>
            <v-autocomplete :value="destination && destination.key" :items="places" item-text="name" item-value="key" :filter="filterPlace" aria-label="To" placeholder="A colony or a system" dense outlined hide-details clearable auto-select-first @change="setTo">
              <template #item="{ item }">
                <v-icon small class="mr-3">{{ item.icon }}</v-icon>
                <v-list-item-content>
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.subtitle }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--fleets">
            <div class="tool__label caption text--secondary">Fleets</div>
            <v-autocomplete :value="chosenFleetIds" :items="fleetOptions" item-text="FleetName" item-value="FleetID" aria-label="Fleets" placeholder="All fleets" multiple dense outlined hide-details clearable @change="setFleets">
              <template #selection="{ item, index }">
                <span v-if="index === 0" class="text-truncate">{{ item.FleetName }}</span>
                <span v-if="index === 1" class="caption text--secondary ml-2 text-no-wrap">+{{ chosenFleetIds.length - 1 }}</span>
              </template>
              <template #item="{ item, attrs, on }">
                <v-list-item v-bind="attrs" v-on="on">
                  <v-icon small class="mr-3">{{ attrs.inputValue ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}</v-icon>
                  <v-list-item-content>
                    <v-list-item-title>{{ item.FleetName }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.summary }}</v-list-item-subtitle>
                  </v-list-item-content>
                </v-list-item>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="420">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Transport options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">How the run is planned</div>
                <v-checkbox v-for="option in optionList" :key="option.key" :input-value="options[option.key]" dense hide-details @change="(value) => setOption(option.key, value)">
                  <template #label>
                    <div>
                      <div class="body-2">{{ option.label }}</div>
                      <div class="caption text--secondary">{{ option.hint }}</div>
                    </div>
                  </template>
                </v-checkbox>
              </v-card>
            </v-menu>
          </div>
          <div class="tool tool--actions">
            <avoid-options :options="avoidOptionList" :settings="avoidSettings" :count="avoidCount" @change="setAvoid" />
          </div>
        </div>

        <div v-if="avoidNote" class="mt-2 caption" :class="avoidNote.tone" data-avoid-note>{{ avoidNote.text }}<v-btn v-if="avoidState.failed" x-small text class="ml-2" @click="retryAvoid">Retry</v-btn></div>

        <stat-tiles :tiles="tiles" class="mt-1" />

        <v-alert v-if="!destination" type="info" dense outlined class="mt-4 mb-0">Pick a destination to see what the fleets could move there.</v-alert>
        <v-alert v-for="problem in problems" :key="problem.text" type="warning" dense outlined class="mt-4 mb-0">{{ problem.text }}</v-alert>

        <v-card class="panel" data-summary="How long each fleet would take to sail the chosen run and how much it could carry. Use it to pick the best ships for a haul between two places." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Fleets on this run<provenance-mark rule="transport.roundTrip" label /></span>
              <v-chip v-if="destination" small class="ml-3">{{ origin.name }} → {{ destination.name }}</v-chip>
              <page-link v-if="destination" class="ml-1" :to="routesLink" :name="`${origin.name} to ${destination.name}`" />
            </span>
          </div>
          <div v-if="handlingSupportNote" class="panel-body py-2 caption" :class="handlingSupportNote.tone" data-handling-note>{{ handlingSupportNote.text }}<v-btn v-if="handlingSupportState.failed" x-small text class="ml-2" @click="retryHandlingSupport">Retry</v-btn></div>
          <v-data-table :headers="classHeaders" :items="rows" item-key="key" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="classesTable.sortBy" :sort-desc.sync="classesTable.sortDesc" :items-per-page.sync="classesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="noRowsText" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.ClassName }}</div>
              </div>
            </template>
            <template #[`item.ships`]="{ item }">{{ count(item.ships) }}</template>
            <template #[`item.cargo`]="{ item }"><span v-if="item.cargo !== null" class="text-no-wrap">{{ count(item.cargo) }} t</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonists`]="{ item }"><span v-if="item.colonists !== null" class="text-no-wrap">{{ count(item.colonists) }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.speed`]="{ item }"><span class="text-no-wrap">{{ count(item.speed) }} km/s</span></template>
            <template #[`item.tripDays`]="{ item }">
              <div v-if="item.status === 'ok' || item.status === 'range'" class="py-2 text-no-wrap" :title="tripTitle(item)">
                <div>{{ duration(item.tripSeconds / SECONDS_PER_DAY) }}<provenance-mark v-if="item.provenance" :result="item.provenance" /></div>
                <div class="caption text--secondary">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }} · {{ distance(item.km) }}<provenance-mark v-if="item.pathResult" :result="item.pathResult" /></div>
                <div v-if="item.detourText" class="caption text--secondary route-detour" data-detour>{{ item.detourText }}</div>
              </div>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark v-if="item.provenance" :result="item.provenance" /></span>
            </template>
            <template #[`item.trips`]="{ item }"><span v-if="item.trips !== null" class="text-no-wrap">{{ count(item.trips, 1) }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.tonsYear`]="{ item }"><span v-if="item.tonsYear !== null" class="text-no-wrap">{{ count(item.tonsYear) }} t</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonistsYear`]="{ item }"><span v-if="item.colonistsYear !== null" class="text-no-wrap">{{ count(item.colonistsYear) }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.fuel`]="{ item }">
              <div v-if="item.fuel !== null" class="py-2 text-no-wrap">
                <div>{{ count(item.fuel) }} L</div>
                <div class="caption text--secondary">{{ count(item.fuelShare * 100) }}% of a tank</div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.statusSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">
                  <v-icon small :color="STATUS[item.status].color" class="mr-1">{{ STATUS[item.status].icon }}</v-icon>
                  <span>{{ STATUS[item.status].label }}</span>
                </div>
                <div v-if="item.note && item.status !== 'noroute'" class="caption text--secondary">{{ item.note }}</div>
              </div>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <handling-breakdown :rows="item.handlingRows" />
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">Each class in a fleet is timed as if it sailed alone: the round trip is twice the route at its top speed, plus loading cargo and colonists at the origin and unloading them at the destination, each stop taking its slowest ship. Loading takes 20 s per ton and 10 s per colonist, divided by each ship's loading strength and by its crew share (a crew short of the class's applies once, more crew is no faster, and no crew aboard stops loading). The strength is that of its undamaged cargo shuttle bays (1 for a craft of 500 t or less, which lands, whatever bays it has) times the race's shuttle technology and the Logistics bonuses of its commander, of the naval administration over the system where it loads, of the colony's governor and a quarter of the sector commander's excess, plus the technology once more if the colony has a spaceport or cargo shuttle station, which no bonus multiplies. A bonus the save cannot settle counts as 1, so the time errs long; a system stands in as a colony site with no governor or sector. A ship over 500 t with no undamaged bays can load or unload only at a colony with a spaceport or cargo shuttle station, a class with such a ship is marked Can't load and names the ship and the stop, and a class whose ability to load is not known has no time, trips or fuel. {{ versionNote }} Ships without a jump drive that covers their size use only jump points stabilised on both sides; the rest use any jump point the race has explored. The route is the fewest jumps, with Lagrange jumps unless turned off, and does not avoid dangerous or alien systems. Jump shock and nebula speed limits are left out. The cargo is assumed ready at the origin and accepted at the destination. The run must fit in one tank: refuelling needs an order and a refuelling station, so no time for it is counted. Shipping line ships, in the Civilian tile, are timed the same way but without that fuel limit. Fuel burns at engine power times fuel consumption per hour at full speed.</div>
          <div v-if="payoutNote" class="panel-foot caption text--secondary"><span class="font-weight-medium">Shipping-line payout</span><provenance-mark :result="payoutNote.result" label /> {{ payoutNote.text }}</div>
        </v-card>

        <v-card class="panel" data-summary="How long each fleet would take to sail the chosen run as one, with every ship at the speed of the slowest, and what it could carry. Use it to see what a mixed fleet really does beside the classes timed alone." data-fleet-panel elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Fleets sailing together<provenance-mark rule="transport.fleetTrip" label /></span>
              <v-chip v-if="destination" small class="ml-3">{{ origin.name }} → {{ destination.name }}</v-chip>
            </span>
          </div>
          <div v-if="fleetShipsState.loading" class="panel-body py-2 caption text--secondary" data-fleet-note>Reading the ships of the fleets.</div>
          <div v-else-if="fleetShipsState.failed" class="panel-body py-2 caption warning--text" data-fleet-note>The ships of the fleets could not be read: {{ fleetShipsState.error }}<v-btn x-small text class="ml-2" @click="retryFleetShips">Retry</v-btn></div>
          <v-data-table v-else :headers="fleetHeaders" :items="fleetRuns" item-key="key" :expanded.sync="fleetsExpanded" show-expand single-expand :sort-by.sync="fleetsTable.sortBy" :sort-desc.sync="fleetsTable.sortDesc" :items-per-page.sync="fleetsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="destination ? 'No fleet carries cargo or colonists' : 'Pick a destination above'" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.independent }} of {{ item.ships }} under their own power<provenance-mark rule="transport.fleetSpeed" /></div>
              </div>
            </template>
            <template #[`item.ships`]="{ item }">{{ count(item.ships) }}<provenance-mark rule="transport.fleetSpeed" /></template>
            <template #[`item.cargo`]="{ item }"><span v-if="item.cargo !== null" class="text-no-wrap">{{ count(item.cargo) }} t<provenance-mark rule="transport.fleetCargo" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonists`]="{ item }"><span v-if="item.colonists !== null" class="text-no-wrap">{{ count(item.colonists) }}<provenance-mark rule="transport.fleetCargo" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.speed`]="{ item }">
              <div v-if="item.speed !== null" class="py-2 text-no-wrap">
                <div>{{ count(item.speed) }} km/s<provenance-mark rule="transport.fleetSpeed" /></div>
                <div v-if="item.savedSpeed !== item.speed || item.effectiveMax !== item.speed" class="caption text--secondary" data-fleet-speeds-apart>saved {{ count(item.savedSpeed) }}<provenance-mark rule="transport.fleetSpeed" /> · maximum {{ count(item.effectiveMax) }}<provenance-mark rule="transport.fleetSpeed" /></div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.tripDays`]="{ item }">
              <div v-if="item.status === 'ok' || item.status === 'range'" class="py-2 text-no-wrap" :title="tripTitle(item)">
                <div>{{ duration(item.tripSeconds / SECONDS_PER_DAY) }}<provenance-mark v-if="item.provenance" :result="item.provenance" /></div>
                <div class="caption text--secondary">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }} · {{ distance(item.km) }}<provenance-mark v-if="item.pathResult" :result="item.pathResult" /></div>
              </div>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark v-if="item.provenance" :result="item.provenance" /></span>
            </template>
            <template #[`item.trips`]="{ item }"><span v-if="item.trips !== null" class="text-no-wrap">{{ count(item.trips, 1) }}<provenance-mark rule="transport.fleetTrip" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.tonsYear`]="{ item }"><span v-if="item.tonsYear !== null" class="text-no-wrap">{{ count(item.tonsYear) }} t<provenance-mark rule="transport.fleetTrip" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonistsYear`]="{ item }"><span v-if="item.colonistsYear !== null" class="text-no-wrap">{{ count(item.colonistsYear) }}<provenance-mark rule="transport.fleetTrip" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.fuel`]="{ item }">
              <div v-if="item.fuel !== null" class="py-2 text-no-wrap">
                <div>{{ count(item.fuel) }} L<provenance-mark rule="transport.fleetBurn" /></div>
                <div class="caption text--secondary">{{ count(item.fuelShare * 100) }}% of the tank of {{ item.fuelLimiting }}<provenance-mark rule="transport.fleetBurn" /></div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.statusSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">
                  <v-icon small :color="STATUS[item.status].color" class="mr-1">{{ STATUS[item.status].icon }}</v-icon>
                  <span>{{ STATUS[item.status].label }}</span>
                </div>
                <div v-if="item.note && item.status !== 'noroute'" class="caption text--secondary">{{ item.note }}</div>
              </div>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <fleet-profile :participants="item.participantRows" :speeds="item.speeds" :reasons="item.reasons" :conditions="item.conditions" :handling-rows="item.handlingRows" />
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">A fleet sails at one speed: that of its slowest ship under its own power, from the engines it has undamaged, its overhaul and the mass of a ship it tows, which can be lower than the speed saved for the fleet and than the class's rating. Every ship shares that one travel time and burns fuel at its own engine power, scaled by the share of its own maximum the fleet sails at. A ship in a hangar or under tow burns none of its own and its holds are not counted, as loading by such a craft is not validated for this game version; a fleet with every hold in tow is not supported. A ship with no working engines that nothing carries or tows keeps the fleet from moving. Loading and unloading are timed as for the classes above, each stop taking its slowest counted ship. The classes above are each timed alone, as if every ship of it had its own engines. {{ versionNote }}</div>
        </v-card>

        <v-card class="panel" data-summary="The installations the colonies offer and ask for, and how much of each is already on its way. Use it to see what civilian shipping lines are carrying." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Civilian work orders<provenance-mark rule="transport.shipments" label /></span>
              <template v-if="CivilianShippingLinesActive">
                <v-chip small class="ml-3">Supply {{ amount(workTotals.supply) }}</v-chip>
                <v-chip small class="ml-2">Demand {{ amount(workTotals.demand) }}</v-chip>
                <v-chip small class="ml-2">En route {{ amount(workTotals.out) }}</v-chip>
              </template>
            </span>
            <v-text-field v-if="CivilianShippingLinesActive" v-model="ordersSearch" label="Search" placeholder="Colony or installation" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <div v-if="!CivilianShippingLinesActive" class="panel-body">Civilian shipping lines are off in this game, so no colony requests installations and no shipping line ships carry them.</div>
          <v-data-table v-else :headers="orderHeaders" :items="workVisible" item-key="key" group-by="InstallationName" :search="ordersSearch" :custom-filter="filterOrder" :sort-by.sync="ordersTable.sortBy" :sort-desc.sync="ordersTable.sortDesc" :items-per-page.sync="ordersTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="workRows.length ? 'No work orders match the filters.' : 'No colony has asked for or offered an installation.'">
            <template #[`group.header`]="{ group, items, headers, isOpen, toggle }">
              <td :colspan="headers.length">
                <v-btn icon small :aria-label="isOpen ? `Collapse ${group}` : `Expand ${group}`" @click="toggle"><v-icon small>{{ isOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon></v-btn>
                <span class="font-weight-medium">{{ group }}</span>
                <span class="caption text--secondary ml-2">{{ groupSummary(items) }}</span>
              </td>
            </template>
            <template #[`item.colonyName`]="{ item }">
              <div class="py-2">
                <div>{{ item.colonyName }}</div>
                <div class="caption text--secondary">{{ item.systemName }}</div>
              </div>
            </template>
            <template #[`item.supply`]="{ item }"><span :class="{ 'text--secondary': !item.supply }">{{ amount(item.supply) }}</span></template>
            <template #[`item.demand`]="{ item }"><span :class="{ 'text--secondary': !item.demand }">{{ amount(item.demand) }}</span></template>
            <template #[`item.out`]="{ item }"><span :class="{ 'text--secondary': !item.out }">{{ amount(item.out) }}</span></template>
            <template #[`item.in`]="{ item }"><span :class="{ 'text--secondary': !item.in }">{{ amount(item.in) }}</span></template>
          </v-data-table>
          <div v-if="CivilianShippingLinesActive" class="panel-foot caption text--secondary">A colony offers an installation as Supply and asks for one as Demand. When a shipping line ship sets off with a load, the game takes it from both the supplier's Supply and the buyer's Demand, so what is En route, out of a colony or toward it, is no longer counted in either. Shipping lines skip colonies marked military restricted. {{ idleNote }}</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import FleetProfile from '../components/page/FleetProfile.vue'
import HandlingBreakdown from '../components/page/HandlingBreakdown.vue'
import AvoidOptions from '../components/page/AvoidOptions.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import capabilityGates from '../mixins/capability-gates'
import avoidRoutes from '../mixins/avoid-routes'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import handlingSupport from '../mixins/handling-support'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import { loadHandlingSupport } from '../utilities/handling-support'
import { linkTo, queryPlaceKeys } from '../utilities/deep-links'
import { loadJumpPoints, searchRoutes } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { colonyPlaces, filterPlace, searchable, systemPlaces } from '../utilities/places'
import { isAvailable } from '../utilities/provenance'
import { loadFormulaVersion } from '../utilities/capabilities'
import { amountText, describeTariffVersion, payoutRows } from '../utilities/civilian-tariff'
import { JUMP_DRIVE_COLUMNS, SHUTTLE_SERVICE_COLUMNS, SHUTTLE_STRENGTH_COLUMNS, colonyEndpoint, describeFormulaVersion, fleetCanTransit, handlingRows, roundTrip, routeBlockers, shuttleServiceJoin, transitRule, tripResult } from '../utilities/transport'
import { avoidFields, cutOffText, detourText, loadPlannedAvoidSystems, pathResult, planRun, unreadResult } from '../utilities/safe-routes'
import { fleetProfile, fleetTrip, fleetTripResult, loadFleetShips, participantRows } from '../utilities/fleet-profile'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  lagrangePoints: 'the Lagrange points',
  colonies: 'the colonies',
  ships: 'the ships',
  requests: 'the installation requests',
  shipments: 'the installations in transit',
  formulaVersion: 'the save\'s schema',
  handlingSupport: 'the officers\' Logistics bonuses',
  avoidSystems: 'the danger and control of the systems',
  fleetShips: 'the ships of the fleets',
}
// The reads that feed one optional feature alone: the page never waits for them, and each has its own note when it is not in (the officers' Logistics bonuses, the danger and control the avoid settings read, the ships of the fleets sailing together).
const OPTIONAL_INPUTS = ['handlingSupport', 'avoidSystems', 'fleetShips']
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key))
const SECONDS_PER_DAY = 86400
const PAGE_SIZES = [15, 30, -1]

const OPTIONS = [
  { key: 'gatesOnly', config: 'transportGatesOnly', default: false, label: 'Stabilised jump points only', hint: 'Ships with a jump drive that covers their size use only jump points stabilised on both sides too, as the others always do.' },
  { key: 'useLagrange', config: 'transportUseLagrange', default: true, label: 'Use Lagrange points', hint: 'Jumps between stable Lagrange points inside a system when that is shorter.' },
  { key: 'showIdle', config: 'transportIdleRequests', default: false, label: 'Idle work orders', hint: 'Lists the requests in the civilian work orders that have nothing to supply, ask for or carry.' },
]
// Each option is kept on its own, for every game.
const OPTION_FIELDS = Object.fromEntries(OPTIONS.map((option) => [option.key, { key: option.config, default: option.default }]))

const STATUS = {
  ok: { label: 'Can run', icon: 'mdi-check-circle-outline', color: 'success' },
  blocked: { label: 'Can\'t load', icon: 'mdi-alert-circle-outline', color: 'warning' },
  range: { label: 'Out of range', icon: 'mdi-alert-circle-outline', color: 'warning' },
  unknown: { label: 'Not known', icon: 'mdi-help-circle-outline', color: 'warning' },
  immobile: { label: 'Can\'t move', icon: 'mdi-alert-circle-outline', color: 'warning' },
  unsupported: { label: 'Not supported', icon: 'mdi-help-circle-outline', color: 'warning' },
  noroute: { label: 'No route', icon: 'mdi-close-circle-outline', color: 'error' },
  none: { label: 'Nothing to move', icon: 'mdi-close-circle-outline', color: 'error' },
}

// Up to three names, then how many more.
const nameList = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : joinLabels(names))

const unique = (values) => [...new Set(values)]

export default {
  name: 'TransportPage',
  components: { AvoidOptions, FleetProfile, HandlingBreakdown, LoadState, PageLink, ProvenanceMark, StatTiles },
  mixins: [
    avoidRoutes,
    capabilityGates,
    countFormat,
    deepLink,
    handlingSupport,
    loadState(INPUT_LABELS),
    persistedView({
      fromKey: { key: 'transportFrom', default: null, scope: 'race' },
      toKey: { key: 'transportTo', default: null, scope: 'race' },
      fleetIds: { key: 'transportFleets', default: [], scope: 'race', valid: (value) => Array.isArray(value) },
      ...OPTION_FIELDS,
      ...avoidFields('transport'),
      ordersSearch: { key: 'transportOrdersSearch', default: '', scope: 'race' },
      classesTable: tableView('transportClassesTable', { sortBy: ['tonsYear'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      fleetsTable: tableView('transportFleetsTable', { sortBy: ['tonsYear'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      ordersTable: tableView('transportOrdersTable', { sortBy: ['demand'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      expanded: [],
      fleetsExpanded: [],
      optionList: OPTIONS,
      pageSizes: PAGE_SIZES,
      STATUS,
      SECONDS_PER_DAY,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'CivilianShippingLinesActive']),
    ...mapState(['RaceNPR']),

    // The reads that hold the page back: every one but the officers' bonuses, which have their own note.
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    options() {
      return Object.fromEntries(OPTIONS.map((option) => [option.key, this[option.key]]))
    },

    activeOptionCount() {
      return OPTIONS.filter((option) => this.options[option.key] !== option.default).length
    },

    systemById() {
      return Object.fromEntries(this.systems.map((system) => [system.SystemID, system]))
    },

    jumpPointById() {
      return Object.fromEntries(this.jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
    },

    restricted() {
      return new Set(this.systems.filter((system) => system.MilitaryRestrictedSystem).map((system) => system.SystemID))
    },

    // Where a run can start or end: colonies at their bodies, systems at their centre.
    places() {
      const { systemById } = this
      const systemName = (systemId) => (systemById[systemId] || {}).Name || ''

      return searchable([...colonyPlaces(this.colonies, systemName), ...systemPlaces(this.systems)], systemName)
    },

    placeByKey() {
      return Object.fromEntries(this.places.map((place) => [place.key, place]))
    },

    // The saved origin, else the capital.
    origin() {
      return this.placeByKey[this.fromKey] || this.places.find((place) => place.Capital) || this.places[0] || null
    },

    destination() {
      const place = this.placeByKey[this.toKey]

      return place && this.origin && place.key !== this.origin.key ? place : null
    },

    // The run as a link names it: the origin, and the destination once there is one. Not known until the places are read.
    linkQuery() {
      return this.ready && this.origin ? linkTo.transport({ from: this.origin.key, to: this.destination && this.destination.key }).query : null
    },

    linkLabel() {
      if (!this.origin) {
        return ''
      }

      return this.destination ? `${this.origin.name} → ${this.destination.name}` : this.origin.name
    },

    routesLink() {
      return linkTo.routes({ from: this.origin.key, to: this.destination.key })
    },

    // Fleets that carry something, with their ships in classes that do, and whether the fleet can cross jump points that are not stabilised on its own.
    groups() {
      const byFleet = new Map()

      this.ships.forEach((ship) => {
        if (!byFleet.has(ship.FleetID)) {
          byFleet.set(ship.FleetID, { FleetID: ship.FleetID, FleetName: ship.FleetName, civilian: Boolean(ship.ShippingLine), ships: [] })
        }

        byFleet.get(ship.FleetID).ships.push(ship)
      })

      return [...byFleet.values()].map((group) => {
        const classes = new Map()

        group.ships.filter((ship) => ship.CargoCapacity > 0 || ship.ColonistCapacity > 0).forEach((ship) => {
          if (!classes.has(ship.ShipClassID)) {
            classes.set(ship.ShipClassID, { ShipClassID: ship.ShipClassID, ClassName: ship.ClassName, ships: [] })
          }

          classes.get(ship.ShipClassID).ships.push(ship)
        })

        return { ...group, canTransit: fleetCanTransit(group.ships), classes: [...classes.values()] }
      }).filter((group) => group.classes.length)
    },

    militaryGroups() {
      return this.groups.filter((group) => !group.civilian)
    },

    fleetOptions() {
      return this.militaryGroups.map((group) => ({
        FleetID: group.FleetID,
        FleetName: group.FleetName,
        summary: group.classes.map((shipClass) => `${shipClass.ships.length} × ${shipClass.ClassName}`).join(', '),
      })).sort((a, b) => a.FleetName.localeCompare(b.FleetName))
    },

    // The picked fleets that still exist; none picked means every fleet.
    chosenFleetIds() {
      const existing = new Set(this.militaryGroups.map((group) => group.FleetID))

      return this.fleetIds.filter((fleetId) => existing.has(fleetId))
    },

    // Where each kind of ship can go from the origin: `reachOf(group)` gives { route, open, profile, blockers, safe, pending }, the route its profile can sail under the avoid settings (every figure of a run comes from it), the route without any rule, what its rules stop on that one, what the avoid settings did to it (safe-routes.js `planRun`: its baseline, detour and cut-off systems) and whether the danger and control they read are still to come (no route is planned then).
    reachOf() {
      const { jumpPoints, jumpPointById, restricted, origin, destination, gatesOnly, systemById, avoid, avoidPending } = this
      const lagrangePoints = this.useLagrange ? this.lagrangePoints : []
      const systemName = (systemId) => (systemById[systemId] || {}).Name || `System #${systemId}`
      const searches = {}
      const reaches = {}
      const find = (profile) => {
        if (!origin || !destination) {
          return null
        }

        const key = `${profile.gates}:${profile.civilian}`

        if (!searches[key]) {
          searches[key] = searchRoutes(jumpPoints, [origin], { order: 'jumps', ...transitRule(profile, jumpPointById, restricted), lagrangePoints })
        }

        return searches[key].toPlace(destination)
      }

      return (group) => {
        const profile = { gates: gatesOnly || !group.canTransit, civilian: group.civilian }
        const key = `${profile.gates}:${profile.civilian}`

        if (!reaches[key]) {
          const safe = origin && destination ? planRun({ jumpPoints, origin, destination, order: 'jumps', lagrangePoints, transit: transitRule(profile, jumpPointById, restricted), avoid }) : null
          const baseline = safe && safe.baseline
          const route = avoidPending || !safe ? null : safe.route
          const open = baseline || find({ gates: false, civilian: false })

          reaches[key] = { route, open, profile, blockers: baseline || !open ? [] : routeBlockers(open, profile, restricted, systemName), safe, pending: avoidPending }
        }

        return reaches[key]
      }
    },

    // The formula version the save's schema stands for, in words for a panel foot.
    versionNote() {
      return describeFormulaVersion(this.formulaVersion)
    },

    // The two ends of the run as places a ship loads or unloads: a colony with the spaceports and cargo shuttle stations it has, and a system as a colony site with none.
    endpoints() {
      const endpointOf = (place) => (place ? colonyEndpoint(place.kind === 'colony' ? place.colony : { ShuttleCapacity: 0, SystemID: place.SystemID }, place.name) : null)

      return { origin: endpointOf(this.origin), destination: endpointOf(this.destination) }
    },

    // One entry per class in each fleet that is picked (every shipping line fleet too, while shipping lines are on), timed on its own.
    runs() {
      const { reachOf, endpoints, destination } = this
      const chosen = new Set(this.chosenFleetIds)
      const runs = []

      if (!destination) {
        return runs
      }

      this.groups.forEach((group) => {
        if (group.civilian ? !this.CivilianShippingLinesActive : chosen.size && !chosen.has(group.FleetID)) {
          return
        }

        const reach = reachOf(group)

        group.classes.forEach((shipClass) => runs.push({ ...this.runOf(group, shipClass, reach, endpoints), ...this.safeFields(reach) }))
      })

      return runs
    },

    rows() {
      return this.runs.filter((run) => !run.civilian)
    },

    civilianRuns() {
      return this.runs.filter((run) => run.civilian)
    },

    // The military fleets that have a hold or colony bays, each with all its ships as one fleet and whether it can cross jump points that are not stabilised on its own.
    fleetGroups() {
      const byFleet = new Map()

      this.fleetShips.forEach((ship) => {
        if (!byFleet.has(ship.FleetID)) {
          byFleet.set(ship.FleetID, { FleetID: ship.FleetID, FleetName: ship.FleetName, ships: [] })
        }

        byFleet.get(ship.FleetID).ships.push(ship)
      })

      return [...byFleet.values()].map((fleet) => ({ ...fleet, canTransit: fleetCanTransit(fleet.ships) }))
    },

    // The fleets read: { loading, failed, error } of the optional ships read.
    fleetShipsState() {
      const state = this.loadErrors.fleetShips

      return { loading: state === undefined, failed: typeof state === 'string', error: typeof state === 'string' ? state : '' }
    },

    // One entry per picked military fleet, sailing as one, on the route: every ship at the fleet's one speed.
    fleetRuns() {
      const { endpoints, destination } = this
      const chosen = new Set(this.chosenFleetIds)

      if (!destination || this.loadErrors.fleetShips !== null) {
        return []
      }

      return this.fleetGroups.filter((fleet) => !chosen.size || chosen.has(fleet.FleetID)).map((fleet) => this.fleetRunOf(fleet, endpoints))
    },

    fleetHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'Ships', value: 'ships', align: 'end' },
        { text: 'Cargo / trip', value: 'cargo', align: 'end' },
        { text: 'Colonists / trip', value: 'colonists', align: 'end' },
        { text: 'Speed', value: 'speed', align: 'end' },
        { text: 'Round trip', value: 'tripDays', align: 'end' },
        { text: 'Trips / yr', value: 'trips', align: 'end' },
        { text: 'Tons / yr', value: 'tonsYear', align: 'end' },
        { text: 'Colonists / yr', value: 'colonistsYear', align: 'end' },
        { text: 'Fuel / trip', value: 'fuel', align: 'end' },
        { text: 'Status', value: 'statusSort' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    // What a shipping line is paid over the run, at the rates of the save's game version: one unit of each category over the measured route in billion km, with the result the figures rest on, or why no figure is given. Null while shipping lines are off or no destination is picked.
    payoutNote() {
      const { destination, formulaVersion: version } = this

      if (!destination || !this.CivilianShippingLinesActive) {
        return null
      }

      const kms = this.civilianRuns.filter((run) => run.status !== 'noroute' && !run.pending).map((run) => run.km)
      const npr = this.RaceNPR
      const unknown = payoutRows({ version, km: null, npr })

      if (!unknown.some((row) => isAvailable(row.rate))) {
        return { text: 'No payout is estimated: the save\'s game version has no published payout rates.', result: unknown[0].payout }
      } else if (!kms.length) {
        return { text: 'No payout is estimated: no shipping line ship has a route to the destination, so no distance is measured.', result: unknown[0].payout }
      }

      const shortest = Math.min(...kms)
      const longest = Math.max(...kms)
      const near = payoutRows({ version, km: shortest, npr })
      const far = payoutRows({ version, km: longest, npr })
      const parts = near.map((row, index) => {
        const { category, rate } = row

        if (!isAvailable(rate) || !isAvailable(row.payout)) {
          return `${category.label}: not estimated, needs ${(isAvailable(rate) ? row.payout : rate).inputs.missing.join(' and ')}`
        }

        const low = this.amountText(row.payout.value)
        const high = this.amountText(far[index].payout.value)

        return `${category.label} ${this.amountText(rate.value)} a unit per billion km, ${low === high ? low : `${low} to ${high}`} a unit over the route`
      })

      return { text: `${describeTariffVersion(version)}${npr ? ', with a computer-run empire paid half' : ''}, over the measured route of ${shortest === longest ? this.distance(shortest) : `${this.distance(shortest)} to ${this.distance(longest)}`} one way: ${parts.join('; ')}. A payout goes to the shipping line, and no stored link ties it to a treasury use, so no cost to the race is claimed.`, result: near[0].payout }
    },

    // What keeps fleets from the destination, said once for the fleets it stops: the military fleets and, while shipping lines are on, the shipping line fleets too.
    problems() {
      const byNote = new Map()

      this.runs.filter((row) => row.status === 'noroute').forEach((row) => {
        byNote.set(row.note, [...(byNote.get(row.note) || []), row.FleetName])
      })

      return [...byNote].map(([note, names]) => ({ text: `${nameList(unique(names))}: ${note}` }))
    },

    noRowsText() {
      if (!this.destination) {
        return 'Pick a destination to time the run.'
      }

      return this.militaryGroups.length ? 'No picked fleet carries cargo or colonists.' : 'None of the fleets has cargo holds or colony bays.'
    },

    tiles() {
      const working = this.rows.filter((row) => row.status === 'ok')
      const unknownRows = this.rows.filter((row) => row.status === 'unknown')
      const idle = this.rows.filter((row) => row.status !== 'ok' && row.status !== 'unknown').reduce((total, row) => total + row.ships, 0)
      const unknown = unknownRows.reduce((total, row) => total + row.ships, 0)
      const sum = (list, field) => list.reduce((total, row) => total + row[field], 0)
      const trips = working.reduce((total, row) => total + row.ships * row.trips, 0)
      const shortest = Math.min(...working.map((row) => row.km))
      const longest = Math.max(...working.map((row) => row.km))
      const first = working[0]
      const idleNote = [idle ? `${this.count(idle)} ${idle === 1 ? 'ship' : 'ships'} can't work the route` : '', unknown ? `${this.count(unknown)} ${unknown === 1 ? 'ship is' : 'ships are'} not known to load there` : ''].filter(Boolean).join('; ')
      const none = !this.destination ? 'Pick a destination above' : this.rows.length ? (unknown ? 'No picked fleet is known to work this route' : 'No picked fleet can work this route') : 'No fleet carries cargo or colonists'
      const civilian = this.civilianRuns.filter((run) => run.status === 'ok')
      const civilianShips = this.civilianRuns.reduce((total, run) => total + run.ships, 0)
      const civilianUnknown = this.civilianRuns.some((run) => run.status === 'unknown')
      const cargo = sum(working, 'cargo')
      const colonists = sum(working, 'colonists')

      return [
        {
          label: 'Freight a year',
          value: working.length ? `${this.count(sum(working, 'tonsYear'))} t` : '—',
          note: working.length ? [cargo ? `${this.count(cargo)} t a trip in ${this.count(sum(working, 'ships'))} ships` : 'No fleet that can run has a cargo hold', idleNote].filter(Boolean).join('; ') : none,
        },
        {
          label: 'Colonists a year',
          value: working.length ? this.count(sum(working, 'colonistsYear')) : '—',
          note: !working.length ? none : colonists ? `${this.count(colonists)} a trip` : 'No fleet that can run has colony bays',
        },
        {
          label: 'Trips a year',
          value: working.length ? this.count(trips, 1) : '—',
          note: !working.length ? none : shortest === longest ? `${first.jumps} ${first.jumps === 1 ? 'jump' : 'jumps'}, ${this.distance(first.km)} one way` : `${this.distance(shortest)} to ${this.distance(longest)} one way`,
        },
        {
          label: 'Civilian freight a year',
          value: !this.CivilianShippingLinesActive ? 'Off in this game' : civilian.length ? `${this.count(sum(civilian, 'tonsYear'))} t` : '—',
          note: !this.CivilianShippingLinesActive ? 'Shipping lines are not run here' : !this.destination ? 'Pick a destination above' : civilian.length ? `${this.count(sum(civilian, 'colonistsYear'))} colonists a year, from ${this.count(sum(civilian, 'ships'))} of ${this.count(civilianShips)} ships` : civilianShips ? (civilianUnknown ? 'None of the shipping line ships is known to work the route' : 'None of the shipping line ships can work the route') : 'The shipping lines have no ships',
        },
      ]
    },

    classHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'Ships', value: 'ships', align: 'end' },
        { text: 'Cargo / trip', value: 'cargo', align: 'end' },
        { text: 'Colonists / trip', value: 'colonists', align: 'end' },
        { text: 'Speed', value: 'speed', align: 'end' },
        { text: 'Round trip', value: 'tripDays', align: 'end' },
        { text: 'Trips / yr', value: 'trips', align: 'end' },
        { text: 'Tons / yr', value: 'tonsYear', align: 'end' },
        { text: 'Colonists / yr', value: 'colonistsYear', align: 'end' },
        { text: 'Fuel / trip', value: 'fuel', align: 'end' },
        { text: 'Status', value: 'statusSort' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    orderHeaders() {
      return [
        { text: 'Colony', value: 'colonyName' },
        { text: 'Supply', value: 'supply', align: 'end' },
        { text: 'Demand', value: 'demand', align: 'end' },
        { text: 'En route out', value: 'out', align: 'end' },
        { text: 'En route in', value: 'in', align: 'end' },
      ]
    },

    colonyById() {
      return Object.fromEntries(this.colonies.map((colony) => [colony.PopulationID, colony]))
    },

    // One row per colony and installation: what it supplies and demands, and what shipping lines carry out of it and toward it.
    workRows() {
      const { colonyById, systemById } = this
      const rows = {}
      const rowFor = (populationId, installationId, installationName) => {
        const key = `${populationId}:${installationId}`

        if (!rows[key]) {
          const colony = colonyById[populationId]

          rows[key] = {
            key,
            InstallationName: installationName,
            colonyName: colony ? colony.PopName : `Colony #${populationId}`,
            systemName: colony ? (systemById[colony.SystemID] || {}).Name || '' : '',
            supply: 0,
            demand: 0,
            out: 0,
            in: 0,
          }
        }

        return rows[key]
      }

      this.requests.forEach((request) => {
        rowFor(request.PopulationID, request.InstallationID, request.InstallationName)[request.Export ? 'supply' : 'demand'] += request.Amount
      })

      this.shipments.forEach((shipment) => {
        rowFor(shipment.OriginPopulationID, shipment.InstallationID, shipment.InstallationName).out += shipment.Amount

        if (shipment.DestinationPopulationID) {
          rowFor(shipment.DestinationPopulationID, shipment.InstallationID, shipment.InstallationName).in += shipment.Amount
        }
      })

      return Object.values(rows)
    },

    workVisible() {
      return this.showIdle ? this.workRows : this.workRows.filter((row) => row.supply || row.demand || row.out || row.in)
    },

    workTotals() {
      return this.workVisible.reduce((totals, row) => ({ supply: totals.supply + row.supply, demand: totals.demand + row.demand, out: totals.out + row.out }), { supply: 0, demand: 0, out: 0 })
    },

    idleNote() {
      const hidden = this.workRows.length - this.workVisible.length

      return hidden ? `${this.count(hidden)} ${hidden === 1 ? 'request' : 'requests'} with nothing to supply, ask for or carry ${hidden === 1 ? 'is' : 'are'} hidden; the Options list them.` : ''
    },
  },
  methods: {
    filterPlace,

    filterOrder(_value, query, item) {
      return `${item.colonyName} ${item.systemName} ${item.InstallationName}`.toLowerCase().includes(query.toLowerCase())
    },

    // The picks the query names; one it leaves out is cleared, so the origin is the capital again and there is no destination. They are plain keys, so a link that arrives before the places are read lands on its pair once they load.
    applyLink(query) {
      const [from] = queryPlaceKeys(query.from)
      const [to] = queryPlaceKeys(query.to)

      this.fromKey = from || null
      this.toKey = to || null
    },

    setFrom(key) {
      if (key) {
        this.fromKey = key
      }
    },

    setTo(key) {
      this.toKey = key || null
    },

    setFleets(ids) {
      this.fleetIds = ids || []
    },

    setOption(key, value) {
      this[key] = Boolean(value)
    },

    swap() {
      const from = this.origin.key

      this.setFrom(this.destination.key)
      this.setTo(from)
    },

    // A class in a fleet on a route: what it carries, how long a round trip takes and whether it can run.
    runOf(group, shipClass, reach, endpoints) {
      const [first] = shipClass.ships
      const count = shipClass.ships.length
      const base = {
        key: `${group.FleetID}:${shipClass.ShipClassID}`,
        FleetID: group.FleetID,
        FleetName: group.FleetName,
        ClassName: shipClass.ClassName,
        civilian: group.civilian,
        ships: count,
        cargo: Number.isFinite(first.CargoCapacity) ? count * first.CargoCapacity : null,
        colonists: Number.isFinite(first.ColonistCapacity) ? count * first.ColonistCapacity : null,
        speed: first.MaxSpeed,
        jumps: 0,
        km: 0,
        tripSeconds: null,
        travelSeconds: null,
        handlingSeconds: null,
        tripDays: null,
        trips: null,
        tonsYear: null,
        colonistsYear: null,
        fuel: null,
        fuelShare: null,
        provenance: null,
        statusSort: 4,
        status: 'noroute',
        note: '',
      }

      if (reach.pending) {
        return { ...base, status: 'unknown', statusSort: 1, pending: true, provenance: unreadResult(), note: this.avoidNote.text }
      } else if (!reach.route) {
        return { ...base, note: this.reachNote(group, reach) }
      }

      const trip = roundTrip(shipClass.ships, reach.route.km, endpoints, first.ShuttleTechnology, { colonists: true, version: this.formulaVersion, support: this.officerSupport })
      // Shipping line ships are timed without the fuel limit.
      const status = group.civilian && trip.status === 'range' ? 'ok' : trip.status
      const works = status === 'ok'
      const run = { ...base, status, jumps: reach.route.jumps, km: reach.route.km, tripSeconds: trip.tripSeconds, travelSeconds: trip.travelSeconds, handlingSeconds: trip.handlingSeconds, limiting: trip.limiting, provenance: tripResult(trip), estimate: trip.estimate, handlingRows: handlingRows(trip.stops.map((stop, index) => ({ key: `${base.key}-${index}`, label: `${stop.where === 'origin' ? 'Loading' : 'Unloading'} ${stop.kind} at ${endpoints[stop.where].place}`, breakdown: stop.breakdown }))), statusSort: works ? 0 : 1 }
      const problems = trip.problems.map((problem) => `${problem.text.charAt(0).toUpperCase()}${problem.text.slice(1)}`).join('; ')

      if (works) {
        return { ...run, tripDays: trip.tripSeconds / SECONDS_PER_DAY, trips: trip.trips, tonsYear: base.cargo === null ? null : base.cargo * trip.trips, colonistsYear: base.colonists === null ? null : base.colonists * trip.trips, fuel: trip.fuelPerShip * count, fuelShare: trip.fuelShare }
      } else if (status === 'range') {
        return { ...run, note: `A round trip needs ${this.count(trip.fuelShare * 100)}% of a tank.` }
      } else if (status === 'unknown') {
        return { ...run, note: `Not known whether the class can load: ${problems}.` }
      } else if (status === 'immobile') {
        return { ...run, note: 'The class has no top speed.' }
      }

      return { ...run, note: problems ? `${problems}.` : '' }
    },

    // What the avoid settings did to a run, for its row: the detour as text and the distance as a result (null while none is on).
    safeFields(reach) {
      const detour = reach.safe && reach.safe.detour

      return { detourText: detour ? detourText(detour, this.distance) : '', pathResult: this.avoid.active && reach.route ? pathResult(reach.route, this.avoid) : null }
    },

    // Why a profile of ships can't sail from the origin to the destination.
    reachNote(group, { open, blockers, profile, safe }) {
      if (!open) {
        return 'No explored jump route connects them.'
      } else if (safe && safe.status === 'blocked') {
        return cutOffText(safe.cutOff)
      }

      const hint = !profile.gates ? '' : group.canTransit ? ' The Stabilised jump points only option is on.' : ` A jump drive that covers the ship would make it ${open.jumps} ${open.jumps === 1 ? 'jump' : 'jumps'}.`

      return `Can't pass ${nameList(blockers)}.${hint}`
    },

    retryFleetShips() {
      this.$asyncComputed.fleetShips.update()
    },

    // A fleet sailing together on a route: the one speed its ships share, what it carries by the holds that count, how long a round trip takes and whether it can run, with each ship as a participant.
    fleetRunOf(fleet, endpoints) {
      const profile = fleetProfile(fleet.ships, fleet, { basis: 'maximum' })
      const reach = this.reachOf({ FleetID: fleet.FleetID, FleetName: fleet.FleetName, canTransit: fleet.canTransit, civilian: false })
      const capital = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
      const ok = profile.status === 'ok'
      const base = {
        key: String(fleet.FleetID),
        FleetID: fleet.FleetID,
        FleetName: fleet.FleetName,
        ships: profile.participants.length,
        independent: profile.participants.filter((participant) => participant.role === 'independent').length,
        cargo: ok ? profile.cargo.counted.cargo : null,
        colonists: ok ? profile.cargo.counted.colonists : null,
        speed: profile.cruise,
        savedSpeed: profile.savedSpeed,
        effectiveMax: profile.effectiveMax,
        jumps: 0,
        km: 0,
        tripSeconds: null,
        travelSeconds: null,
        handlingSeconds: null,
        tripDays: null,
        trips: null,
        tonsYear: null,
        colonistsYear: null,
        fuel: null,
        fuelShare: null,
        fuelLimiting: '',
        provenance: null,
        handlingRows: [],
        participantRows: participantRows(profile),
        speeds: { cruise: profile.cruise, cruiseSource: profile.cruiseSource, saved: profile.savedSpeed, useMaximum: profile.useMaximumSpeed, effectiveMax: profile.effectiveMax, designMax: profile.designMax, limiting: profile.limiting ? profile.limiting.name : '' },
        reasons: profile.reasons.map((reason) => capital(reason.text)),
        conditions: profile.notes.map((note) => capital(note.text)),
        statusSort: 4,
        status: 'noroute',
        note: '',
      }

      if (!ok) {
        return { ...base, status: profile.status, statusSort: 1, provenance: fleetTripResult(fleetTrip(profile, 0, endpoints), profile), note: base.reasons.join('; ') }
      } else if (reach.pending) {
        return { ...base, status: 'unknown', statusSort: 1, pending: true, provenance: unreadResult(), note: this.avoidNote.text }
      } else if (!reach.route) {
        return { ...base, note: this.reachNote(fleet, reach) }
      }

      const trip = fleetTrip(profile, reach.route.km, endpoints, { colonists: true, version: this.formulaVersion, support: this.officerSupport })
      const works = trip.status === 'ok'
      const left = profile.cargo.left.ships.length
      const run = { ...base, ...this.safeFields(reach), pathResult: pathResult(reach.route, this.avoid), status: trip.status, jumps: reach.route.jumps, km: reach.route.km, tripSeconds: trip.tripSeconds, travelSeconds: trip.travelSeconds, handlingSeconds: trip.handlingSeconds, limiting: trip.limiting, provenance: fleetTripResult(trip, profile), estimate: trip.estimate, handlingRows: handlingRows(trip.stops.map((stop, index) => ({ key: `${base.key}-${index}`, label: `${stop.where === 'origin' ? 'Loading' : 'Unloading'} ${stop.kind} at ${endpoints[stop.where].place}`, breakdown: stop.breakdown }))), participantRows: participantRows(profile, trip), statusSort: works ? 0 : 1 }
      const problems = trip.problems.map((problem) => capital(problem.text)).join('; ')

      if (works) {
        return { ...run, tripDays: trip.tripSeconds / SECONDS_PER_DAY, trips: trip.trips, tonsYear: trip.tonsYear, colonistsYear: trip.colonistsYear, fuel: trip.fuelPerTrip, fuelShare: trip.fuelShare, fuelLimiting: trip.fuelLimiting ? trip.fuelLimiting.ShipName : '', note: left ? `The holds of ${left} carried or towed craft are not counted.` : '' }
      } else if (trip.status === 'range') {
        return { ...run, note: `A round trip needs ${this.count(trip.fuelShare * 100)}% of the tank of ${trip.fuelLimiting.ShipName}.` }
      } else if (trip.status === 'unknown') {
        return { ...run, note: `Not known whether the fleet can run: ${problems}.` }
      }

      return { ...run, note: problems ? `${problems}.` : '' }
    },

    tripTitle(run) {
      return `${this.duration(run.travelSeconds / SECONDS_PER_DAY)} flying at ${this.count(run.speed)} km/s, ${this.duration(run.handlingSeconds / SECONDS_PER_DAY)} loading and unloading${run.limiting ? `, the slowest stop set by ${run.limiting.ship.ShipName} at a loading strength of ${this.count(run.limiting.strength, 1)}` : ''}`
    },

    // A count of installations, which shipments can split in parts.
    amount(value) {
      return Number.isFinite(value) ? this.count(value, Number.isInteger(value) ? 0 : 1) : '—'
    },

    groupSummary(items) {
      const total = (field) => items.reduce((sum, item) => sum + item[field], 0)

      return `Supply ${this.amount(total('supply'))} · Demand ${this.amount(total('demand'))} · En route ${this.amount(total('out'))}`
    },

    amountText(value) {
      return amountText(value, this.separator)
    },

    distance(km) {
      if (km >= 1e9) {
        return `${this.count(km / 1e9, 2)} bn km`
      } else if (km >= 1e6) {
        return `${this.count(km / 1e6, 1)} M km`
      }

      return `${this.count(km)} km`
    },
  },
  asyncComputed: {
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.MilitaryRestrictedSystem from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    jumpPoints: {
      get: tracked('jumpPoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadJumpPoints(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // Stable Lagrange points in the known systems. They belong to no race.
    lagrangePoints: {
      get: tracked('lagrangePoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_LagrangePoint.SystemID, FCT_LagrangePoint.Xcor, FCT_LagrangePoint.Ycor from FCT_LagrangePoint inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_LagrangePoint.GameID = ${this.GameID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The race's colonies with the body they are on, and whether a spaceport or cargo shuttle station stands there.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, ${SHUTTLE_SERVICE_COLUMNS} from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID ${shuttleServiceJoin(this.GameID, 'FCT_Population.PopulationID')} where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} order by FCT_Population.Capital desc, FCT_Population.Population desc, FCT_Population.PopName`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The ships of every fleet that has a hold or colony bays, with their class, the strength of their undamaged cargo shuttle bays, the jump drives it carries (`Drive` the best ordinary one, `AnyDrive` the best of any kind, as ship sizes) and the race's shuttle technology.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Ship.ShipClassID, FCT_Ship.CurrentCrew, FCT_Ship.MothershipID, FCT_Fleet.FleetName, FCT_Fleet.ShippingLine, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_ShipClass.ClassName, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.Size, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, FCT_ShipClass.MilitaryEngines, FCT_Race.CargoShuttleLoadModifier as ShuttleTechnology, ${SHUTTLE_STRENGTH_COLUMNS}, ${JUMP_DRIVE_COLUMNS} from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipClass.MaxSpeed > 1 and FCT_Ship.FleetID in (select carrier.FleetID from FCT_Ship as carrier inner join FCT_ShipClass as carrierClass on carrierClass.ShipClassID = carrier.ShipClassID where carrier.GameID = ${this.GameID} and carrier.RaceID = ${this.RaceID} and (carrierClass.CargoCapacity > 0 or carrierClass.ColonistCapacity > 0)) order by FCT_Fleet.FleetName, FCT_ShipClass.ClassName`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The ships of every military fleet that has a hold or colony bays, whole (`loadFleetShips`): what the fleets sailing together are profiled from. Optional, so the page renders without it and the fleets panel says so while it is in flight or failed.
    fleetShips: {
      get: tracked('fleetShips', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadFleetShips(this.database, { GameID: this.GameID, RaceID: this.RaceID, fleetWhere: `FCT_Fleet.ShippingLine = 0 and FCT_Fleet.FleetID in (select carrier.FleetID from FCT_Ship as carrier inner join FCT_ShipClass as carrierClass on carrierClass.ShipClassID = carrier.ShipClassID where carrier.GameID = ${this.GameID} and carrier.RaceID = ${this.RaceID} and (carrierClass.CargoCapacity > 0 or carrierClass.ColonistCapacity > 0 or carrierClass.CargoCapacity is null or carrierClass.ColonistCapacity is null))` })
      }),
      default: [],
    },
    // What colonies supply and demand of each installation, while shipping lines run.
    requests: {
      get: tracked('requests', async function () {
        if (!this.database || !this.GameID || !this.RaceID || !this.CivilianShippingLinesActive) {
          return []
        }

        return await this.database.query(`select FCT_PopInstallationDemand.PopulationID, FCT_PopInstallationDemand.InstallationID, DIM_PlanetaryInstallation.Name as InstallationName, FCT_PopInstallationDemand.Amount, FCT_PopInstallationDemand.Export from FCT_PopInstallationDemand inner join FCT_Population on FCT_Population.PopulationID = FCT_PopInstallationDemand.PopulationID inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopInstallationDemand.InstallationID where FCT_PopInstallationDemand.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Installations in the holds of shipping line ships, by where they were loaded and where their fleet's unload order sends them (none when the order is not there).
    shipments: {
      get: tracked('shipments', async function () {
        if (!this.database || !this.GameID || !this.RaceID || !this.CivilianShippingLinesActive) {
          return []
        }

        return await this.database.query(`select FCT_ShipCargo.CargoID as InstallationID, DIM_PlanetaryInstallation.Name as InstallationName, FCT_ShipCargo.StartingPop as OriginPopulationID, orders.PopulationID as DestinationPopulationID, sum(FCT_ShipCargo.Amount) as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_ShipCargo.CargoID left join (select FleetID, DestinationItemID, min(PopulationID) as PopulationID from FCT_MoveOrders where GameID = ${this.GameID} and MoveActionID = 177 and DestinationItemType = 19 group by FleetID, DestinationItemID) as orders on orders.FleetID = FCT_Ship.FleetID and orders.DestinationItemID = FCT_ShipCargo.CargoID where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 2 and FCT_Ship.ShippingLineID != 0 group by FCT_ShipCargo.CargoID, FCT_ShipCargo.StartingPop, orders.PopulationID`).then(([items]) => Object.freeze(items))
      }),
      default: [],
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
    // The officers' Logistics bonuses that multiply a ship's loading strength (`loadHandlingSupport`): optional, so the page renders without them and counts each as unknown until they are in.
    handlingSupport: {
      get: tracked('handlingSupport', async function () {
        const { database, GameID, RaceID } = this
        const gates = this.capabilityGates('/information')

        if (!database || !GameID || !RaceID) {
          return null
        }

        const { ranks, blocked } = await gates

        return await loadHandlingSupport(database, { GameID, RaceID, ranks, blocked })
      }),
      default: null,
    },
    // The known systems with the danger and control the avoid settings read (`loadPlannedAvoidSystems`): optional, so the page renders at once and plans under a setting only once it is in.
    avoidSystems: {
      get: tracked('avoidSystems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadPlannedAvoidSystems(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.transport-page {
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

  .tool--place {
    flex: 1 1 240px;
    max-width: 420px;
  }

  .tool--fleets {
    flex: 1 1 220px;
    max-width: 360px;
  }

  .tool--swap,
  .tool--actions {
    align-self: flex-end;
  }

  .tool--actions .v-btn {
    height: 40px !important;
  }

  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  th {
    white-space: nowrap;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
