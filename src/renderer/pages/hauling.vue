<template>
  <div>
    <v-container fluid class="hauling-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" />

        <v-card class="panel" data-summary="The hauls that would cover what the colonies lack of each mineral, from the nearest colony with stock to spare, and what each freighter class takes to carry them." elevation="1">
          <div class="panel-head">
            <span>Hauling plan<provenance-mark rule="hauling.planTonnes" label /></span>
            <span class="d-flex align-center flex-wrap plan-tools">
              <avoid-options :options="avoidOptionList" :settings="avoidSettings" :count="avoidCount" @change="setAvoid" />
              <v-switch v-model="planReserves" label="Fill reserves" dense hide-details class="mt-0" />
            </span>
          </div>
          <div v-if="avoidNote" class="panel-body py-2 caption" :class="avoidNote.tone" data-avoid-note>{{ avoidNote.text }}<v-btn v-if="avoidState.failed" x-small text class="ml-2" @click="retryAvoid">Retry</v-btn></div>
          <v-data-table :headers="planHeaders" :items="planRows" item-key="key" :expanded.sync="planExpanded" show-expand single-expand :sort-by.sync="planTable.sortBy" :sort-desc.sync="planTable.sortDesc" :items-per-page.sync="planTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: routePageSizes }" :no-data-text="planEmptyText" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.toName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.from.PopName }} → {{ item.to.PopName }}<page-link :to="item.transportLink" :name="item.linkName" class="ml-1" /><page-link :to="item.routesLink" :name="item.linkName" /></div>
                <div class="caption text--secondary">{{ item.reasonText }}</div>
                <div v-if="item.deliveredText" class="caption text--secondary">{{ item.deliveredText }}</div>
              </div>
            </template>
            <template #[`item.mineralsText`]="{ item }">
              <div class="caption route-cell">{{ item.mineralsText }}</div>
            </template>
            <template #[`item.tonnes`]="{ item }">
              <span class="text-no-wrap">{{ tons(item.tonnes) }}</span>
            </template>
            <template #[`item.km`]="{ item }">
              <div class="text-no-wrap">{{ item.km ? gkm(item.km) : 'In system' }}</div>
              <div class="caption text--secondary text-no-wrap">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }}<provenance-mark v-if="item.pathResult" :result="item.pathResult" /></div>
              <div v-if="item.detourText" class="caption route-cell" data-detour>{{ item.detourText }}</div>
              <div v-if="item.ungated" class="caption warning--text text-no-wrap" :title="ungatedTitle">{{ item.ungated }} not stabilised</div>
            </template>
            <template #[`item.bestSort`]="{ item }">
              <template v-if="item.best">
                <div class="text-no-wrap">{{ item.best.shipClass.ClassName }}</div>
                <div class="caption text--secondary text-no-wrap">{{ count(item.best.holds) }} {{ item.best.holds === 1 ? 'hold' : 'holds' }}, {{ fixed(item.best.oneShipDays, 1) }} d for one ship</div>
              </template>
              <span v-else class="text--secondary">{{ freighters.length ? 'No class can' : 'No freighters' }}</span>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div class="caption text--secondary mb-1">Freighter classes on this haul</div>
                <v-simple-table dense class="legs-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th class="text-right" title="A tonne of mineral takes two tonnes of a ship's cargo capacity, so a hold carries half the class's cargo in minerals">Holds</th>
                      <th class="text-right">Round trip<provenance-mark rule="hauling.haulDays" /></th>
                      <th class="text-right">One ship</th>
                      <th class="text-right">All its ships</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="estimate in item.estimates" :key="estimate.shipClass.ShipClassID">
                      <td class="caption">{{ estimate.shipClass.ClassName }}</td>
                      <td class="caption text-right">{{ count(estimate.holds) }}</td>
                      <td class="caption text-right text-no-wrap">{{ estimate.timed ? `${fixed(estimate.tripDays, 1)} d` : '—' }}<provenance-mark v-if="estimate.result" :result="estimate.result" /></td>
                      <td class="caption text-right text-no-wrap">{{ estimate.timed ? `${fixed(estimate.oneShipDays, 1)} d` : '—' }}</td>
                      <td class="caption text-right text-no-wrap">{{ estimate.timed ? `${fixed(estimate.classDays, 1)} d with ${count(estimate.shipClass.Ships)}` : '—' }}</td>
                      <td class="caption warning--text">{{ estimate.note }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div v-if="item.minerals.length > 1" class="caption text--secondary mt-2">{{ item.mineralDetail }}</div>
              </td>
            </template>
          </v-data-table>
          <div v-if="unmetRows.length" class="panel-body pt-0">
            <div class="caption warning--text">No colony on a charted route has stock to spare for:</div>
            <div v-for="row in unmetRows" :key="row.key" class="caption">{{ row.name }}: {{ row.text }}<div v-for="cutText in row.cutTexts" :key="cutText" class="text--secondary" data-cut-off>{{ cutText }}</div></div>
          </div>
          <div class="panel-foot caption text--secondary">
            A colony is short of a mineral when its build queue (industrial projects and shipyard tasks that build, repair or refit, paused and queued ones too; a scrap task needs no minerals) needs more than it holds with the mass-driver packets on their way to it, and, with Fill reserves on, when it then holds less than its reserve. A colony gives what it holds above both its reserve and what its own queue needs. Queue shortfalls are planned first, the larger first, each from the colony with stock to spare nearest on the charted routes, then the next nearest. Minerals already in a freighter's hold aren't counted. A class's figures are full holds and round trips at top speed with loading and unloading as Transport times them, fully crewed and undamaged; a class has no commander, governor or sector, so its Logistics bonuses count as 1 and a real ship may load faster; a tonne of mineral takes two tonnes of cargo space, so a hold carries half the class's cargo capacity in minerals; the best class is the one a single ship of which finishes soonest. A class over 500 t with no cargo shuttle bays can load and unload only at a colony with a spaceport or cargo shuttle station, and a class that can't is named with the reason; one whose ability isn't known has no time. {{ versionNote }} A jump point not stabilised on both sides needs a jump-capable ship with freighters that have no jump drive. With an avoid setting on, a haul keeps out of the systems the race knows to be dangerous or alien-held (as the Route Finder reads them), so its distance, and the times and fuel counted from it, follow the way round; each haul is searched the way it sails, from the colony that gives to the one that is short, so the giving colony's own system is left freely and the short colony's system is kept out of like any other. A colony that the settings cut off is named with the systems that bar the way. The repeating routes below follow their orders and ignore the settings.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The fleets that run on repeat, with their stops, round trip, cycle time, yearly moves and fuel. Use it to see what each route carries and costs." elevation="1">
          <div class="panel-head">
            <span>Repeating routes<provenance-mark rule="hauling.cycleTime" label /></span>
          </div>
          <div v-if="handlingSupportNote" class="panel-body py-2 caption" :class="handlingSupportNote.tone" data-handling-note>{{ handlingSupportNote.text }}<v-btn v-if="handlingSupportState.failed" x-small text class="ml-2" @click="retryHandlingSupport">Retry</v-btn></div>
          <v-data-table :headers="routeHeaders" :items="routeRows" item-key="FleetID" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="routesTable.sortBy" :sort-desc.sync="routesTable.sortDesc" :items-per-page.sync="routesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: routePageSizes }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}<page-link :to="item.routesLink" :name="item.routesName" class="ml-1" /></div>
                <div class="caption text--secondary">{{ item.Ships }} {{ item.Ships === 1 ? 'ship' : 'ships' }}<provenance-mark rule="transport.fleetSpeed" /> at {{ item.speedText }}<provenance-mark v-if="item.profile.status === 'ok'" rule="transport.fleetSpeed" /><template v-if="item.savedText"> {{ item.savedText }}<provenance-mark rule="transport.fleetSpeed" /></template></div>
              </div>
            </template>
            <template #[`item.route`]="{ item }">
              <div class="caption route-cell">{{ item.stopsText || 'No stops, only moves' }}</div>
            </template>
            <template #[`item.kmSort`]="{ item }">
              <span v-if="item.route.km !== null" class="text-no-wrap">{{ gkm(item.route.km) }}</span>
              <v-tooltip v-else top>
                <template #activator="{ on }">
                  <span class="warning--text" v-on="on">Can't trace</span>
                </template>
                <span>{{ item.route.problem }}</span>
              </v-tooltip>
            </template>
            <template #[`item.cycleSort`]="{ item }">
              <template v-if="item.year">
                <span class="text-no-wrap" :title="`${fixed(item.year.movingDays, 1)} days moving, ${fixed(item.handlingHours, 1)} hours loading and unloading`">{{ fixed(item.year.cycleDays, 1) }} d</span><provenance-mark :result="item.results.cycle" />
              </template>
              <template v-else>
                <span class="text--secondary">—</span><provenance-mark v-if="item.results" :result="item.results.cycle" />
              </template>
              <div v-if="item.blocked.length" class="caption warning--text">Can't load: {{ item.blockedText }}. Left out of the totals.</div>
              <div v-if="item.unknown.length" class="caption warning--text">Not known whether the ships can load: {{ item.unknownText }}. Left out of the totals.</div>
              <div v-if="item.profileText && item.route.km !== null" class="caption warning--text" data-fleet-profile-reason>{{ item.profileText }}. Left out of the totals.</div>
            </template>
            <template #[`item.tripsSort`]="{ item }">
              <template v-if="item.year">
                <span>{{ fixed(item.year.trips, 1) }}</span><provenance-mark :result="item.results.cycle" />
              </template>
              <template v-else>
                <span class="text--secondary">—</span><provenance-mark v-if="item.results" :result="item.results.cycle" />
              </template>
            </template>
            <template #[`item.movedSort`]="{ item }">
              <template v-if="item.year">
                <span v-if="item.freightText" class="text-no-wrap">{{ item.freightText }}</span><provenance-mark v-if="item.freightText" :result="item.results.freight" />
                <span v-if="item.freightText && item.colonistsText">, </span>
                <span v-if="item.colonistsText" class="text-no-wrap">{{ item.colonistsText }}</span><provenance-mark v-if="item.colonistsText" :result="item.results.colonists" />
                <span v-if="!item.freightText && !item.colonistsText" class="text--secondary">No cargo delivered</span>
              </template>
              <template v-else>
                <span class="text--secondary">—</span><provenance-mark v-if="item.results" :result="item.results.freight" />
              </template>
            </template>
            <template #[`item.fuelSort`]="{ item }">
              <template v-if="item.year">
                <span class="text-no-wrap">{{ litres(item.year.fuel) }}</span><provenance-mark :result="item.results.fuel" />
              </template>
              <template v-else>
                <span class="text--secondary">—</span><provenance-mark v-if="item.results" :result="item.results.fuel" />
              </template>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div v-if="item.route.legs.length">
                  <div class="caption text--secondary mb-1">One cycle, {{ item.route.legs.length }} legs</div>
                  <v-simple-table dense class="legs-table">
                    <tbody>
                      <tr v-for="(leg, index) in item.route.legs" :key="index">
                        <td class="caption">{{ leg.from }}</td>
                        <td class="caption text--secondary">→</td>
                        <td class="caption">{{ leg.to }}</td>
                        <td class="caption text-right text-no-wrap">{{ gkm(leg.km) }}</td>
                      </tr>
                    </tbody>
                  </v-simple-table>
                </div>
                <div v-else class="caption warning--text">{{ item.route.problem }}</div>
                <div v-if="item.year" class="caption text--secondary mt-2">Each cycle: {{ fixed(item.year.movingDays, 2) }} days moving and {{ fixed(item.handlingHours, 1) }} hours loading and unloading.<span v-if="item.limiting"> The slowest stop is {{ item.limiting.place }}, set by {{ item.limiting.ship.ShipName }} at a loading strength of {{ fixed(item.limiting.strength, 1) }}.</span></div>
                <handling-breakdown :rows="item.handlingRows" class="mt-2" />
                <fleet-profile :participants="item.participantRows" :speeds="item.speeds" :reasons="[]" :conditions="item.profileNotes" class="mt-2" />
                <div v-if="item.cargo.holdShare > 0 && item.cargo.holdShare < 1" class="caption text--secondary mt-2">The amounts set on its mineral orders fill {{ count(item.cargo.holdShare * 100) }}% of the hold (a tonne of mineral takes two tonnes of cargo space): {{ item.tripText }} a trip.</div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Fleets Aurora runs on repeat (cycle moves), walked order by order as the game measures a fleet's orders: straight to each destination where it is now (a body, jump point, Lagrange point, survey location, waypoint, fleet, contact, wreck or life pod), and through the jump points and Lagrange points the orders take. Route Finder plans its own route through the same stops, so its distance can differ from what the orders fly. Trips assume full loads (or the set amounts) at the fleet's set speed. Loading and unloading follow the docs' cargo-handling time as Transport times it: every ship works at once and the slowest sets the stop's time, each at the strength of its undamaged cargo shuttle bays (a craft of 500 t or less counts as one) times the race's cargo handling technology and the Logistics bonuses of its commander, of the naval administration over the system where it loads, of the colony's governor and a quarter of the sector commander's excess, plus the technology once more at a colony with a spaceport or cargo shuttle station, which no bonus multiplies. A ship over 500 t with no undamaged bays can load or unload only at such a colony, and a route where a ship can't is named with the reason and left out of the totals; so is a route where it isn't known whether a ship can. A bonus the save cannot settle counts as 1, so the time errs long; a crew short of the class's is applied once, and no crew aboard stops loading; refuelling and overhauls aren't counted. {{ versionNote }}
          </div>
          <div class="panel-foot caption text--secondary" data-fleet-basis>
            A fleet sails at its set speed, held to the effective maximum of its slowest ship under its own power (from the undamaged engines, the overhaul and the mass of a ship it tows), and at that maximum when the fleet is set to it. Each ship burns fuel at its own engine power scaled by the share of its own maximum the fleet sails at. A ship in a hangar or under tow burns none and its holds are not counted. A fleet that can't be profiled, or whose every hold is in a hangar or under tow, is left out of the totals with the reason.
          </div>
        </v-card>

        <v-row>
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="What the repeating routes bring to each colony every year, by cargo. Use it to see which colonies depend most on hauling." elevation="1">
              <div class="panel-head"><span>Deliveries by destination<provenance-mark rule="hauling.deliveries" label /></span></div>
              <v-data-table :headers="deliveryHeaders" :items="deliveryRows" item-key="key" :sort-by.sync="deliveriesTable.sortBy" :sort-desc.sync="deliveriesTable.sortDesc" :items-per-page.sync="deliveriesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: summaryPageSizes }" dense>
                <template #[`item.destination`]="{ item }">
                  <span>{{ item.destination }}</span><page-link :to="colonyLink(item.PopulationID)" :name="item.destination" class="ml-1" />
                </template>
                <template #[`item.amount`]="{ item }">{{ item.kind === 'colonists' ? `${count(item.amount)} people` : tons(item.amount) }}</template>
              </v-data-table>
              <div class="panel-foot caption text--secondary">Each unload is credited with the cargo the fleet holds when it gets there, so a route that unloads at several colonies counts every hold it delivers.</div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="Freighter classes with their capacity, speed and yearly distance and fuel. Use it to compare which classes haul most efficiently." elevation="1">
              <div class="panel-head"><span>Freighter classes<provenance-mark rule="hauling.classYear" label /></span></div>
              <v-data-table :headers="classHeaders" :items="classRows" item-key="ShipClassID" :sort-by.sync="classesTable.sortBy" :sort-desc.sync="classesTable.sortDesc" :items-per-page.sync="classesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: summaryPageSizes }" dense>
                <template #[`item.ClassName`]="{ item }">
                  <span class="font-weight-medium">{{ item.ClassName }}</span>
                  <span class="caption text--secondary"> {{ item.HullAbbr }}</span>
                </template>
                <template #[`item.CargoCapacity`]="{ item }">{{ tons(item.CargoCapacity) }}</template>
                <template #[`item.ColonistCapacity`]="{ item }">{{ count(item.ColonistCapacity) }}</template>
                <template #[`item.MaxSpeed`]="{ item }">{{ count(item.MaxSpeed) }}</template>
                <template #[`item.gkm`]="{ item }">{{ count(item.gkm) }}</template>
                <template #[`item.fuel`]="{ item }">{{ litres(item.fuel) }}</template>
              </v-data-table>
              <div class="panel-foot caption text--secondary">Per ship: billion km a year at top speed, and litres a year at full power.</div>
            </v-card>
          </v-col>
        </v-row>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import FleetProfile from '../components/page/FleetProfile.vue'
import HandlingBreakdown from '../components/page/HandlingBreakdown.vue'
import AvoidOptions from '../components/page/AvoidOptions.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import avoidRoutes from '../mixins/avoid-routes'
import capabilityGates from '../mixins/capability-gates'
import handlingSupport from '../mixins/handling-support'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import { STOCK_COLUMNS, colonyMinerals, loadPacketsInFlight, loadQueueNeeds } from '../utilities/colony-minerals'
import { linkTo, place } from '../utilities/deep-links'
import { HAUL_REASONS, haulByClass, planHauls } from '../utilities/haul-plan'
import { classYear, cycleCargo, cycleHandling, routeResults, routeYear, walkRoute } from '../utilities/hauling'
import { fleetProfile, hauledFleet, loadFleetShips, participantRows } from '../utilities/fleet-profile'
import { loadJumpPoints } from '../utilities/jump-graph'
import { loadHandlingSupport } from '../utilities/handling-support'
import { avoidFields, cutOffText, detourText, loadPlannedAvoidSystems, pathResult, unreadResult } from '../utilities/safe-routes'
import { allLoaded, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { orderPlaceKey } from '../utilities/places'
import { loadFormulaVersion } from '../utilities/capabilities'
import { CLASS_SHUTTLE_STRENGTH_COLUMNS, SHUTTLE_SERVICE_COLUMNS, bareEndpoint, colonyEndpoint, describeFormulaVersion, handlingRows, shuttleServiceJoin, tripResult } from '../utilities/transport'

const INPUT_LABELS = {
  classes: 'the freighter classes',
  fleets: 'the repeating fleets',
  fleetShips: 'their ships',
  orders: 'their orders',
  colonies: 'the colonies',
  needs: 'what their build queues need',
  packets: 'the mass-driver packets in flight',
  jumpPoints: 'the jump points',
  shuttleTechnology: 'the shuttle technology',
  formulaVersion: 'the save\'s schema',
  handlingSupport: 'the officers\' Logistics bonuses',
  avoidSystems: 'the danger and control of the systems',
}
// The reads that feed one optional feature alone: the page never waits for them, and each has its own note when it is not in (the officers' Logistics bonuses, the danger and control the avoid settings read).
const OPTIONAL_INPUTS = ['handlingSupport', 'avoidSystems']
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key))
// DIM_MoveAction: "Move to Location".
const MOVE_TO_LOCATION = 2
const ROUTE_PAGE_SIZES = [15, 30, -1]
const SUMMARY_PAGE_SIZES = [10, 25, -1]
// The tables an order's destination sits in, each joined only for its own DestinationType (body, survey location, waypoint, contact, life pod, wreck, fleet, aether gate), so at most one of them gives the point. Jump points and Lagrange points come first in `orderPoint`: they are the only ones whose far side can differ from where the fleet went.
const DESTINATIONS = ['FCT_SystemBody', 'VIR_Survey', 'VIR_Waypoint', 'VIR_Contact', 'VIR_Lifepod', 'VIR_Wreck', 'VIR_Destination', 'VIR_AetherGate']
const orderPoint = (crossings, column) => `coalesce(${[...crossings, ...DESTINATIONS].map((table) => `${table}.${column}`).join(', ')})`

// Whether a figure is one the save gave: a number that is not NaN or infinite. Unknown is not zero, so an absent figure reads as a dash and a real 0 as 0.
const known = (value) => typeof value === 'number' && Number.isFinite(value)

const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 2)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 0)}`
}

// The place an order names: its description without the action ("Acrab: Load All Minerals" -> "Acrab").
const placeOf = (order) => {
  const description = order.Description || ''
  const at = order.ActionName ? description.lastIndexOf(`: ${order.ActionName}`) : -1

  return at > 0 ? description.slice(0, at) : description || order.ActionName
}

// The places a cycle visits, in order: where each order goes, leaving out transits (they only cross a jump point or Lagrange point), unnamed places and repeats, and the last when it is the first again.
const cycleStops = (orders, raceId) => {
  const stops = orders.filter((order) => !order.Jumps).map((order) => orderPlaceKey(order, raceId)).filter(Boolean).filter((key, index, keys) => key !== keys[index - 1])

  return stops.length > 1 && stops[stops.length - 1] === stops[0] ? stops.slice(0, -1) : stops
}

export default {
  name: 'HaulingPage',
  components: { AvoidOptions, FleetProfile, HandlingBreakdown, LoadState, PageLink, ProvenanceMark, StatTiles },
  mixins: [
    avoidRoutes,
    capabilityGates,
    handlingSupport,
    loadState(INPUT_LABELS),
    persistedView({
      planReserves: { key: 'haulingPlanReserves', default: false },
      ...avoidFields('hauling'),
      planTable: tableView('haulingPlanTable', { sortBy: ['tonnes'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: ROUTE_PAGE_SIZES }),
      routesTable: tableView('haulingRoutesTable', { sortBy: ['movedSort'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: ROUTE_PAGE_SIZES }),
      deliveriesTable: tableView('haulingDeliveriesTable', { itemsPerPage: 10, itemsPerPageOptions: SUMMARY_PAGE_SIZES }),
      classesTable: tableView('haulingClassesTable', { itemsPerPage: 10, itemsPerPageOptions: SUMMARY_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      expanded: [],
      planExpanded: [],
      ungatedTitle: 'Jump points on the route that are not stabilised on both sides: freighters without a jump drive need a jump-capable ship with them.',
      routePageSizes: ROUTE_PAGE_SIZES,
      summaryPageSizes: SUMMARY_PAGE_SIZES,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    // The reads that hold the page back: every one but the officers' bonuses, which have their own note.
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    shipsByFleet() {
      const byFleet = {}

      this.fleetShips.forEach((ship) => {
        ;(byFleet[ship.FleetID] = byFleet[ship.FleetID] || []).push(ship)
      })

      return byFleet
    },

    // The formula version the save's schema stands for, in words for a panel foot.
    versionNote() {
      return describeFormulaVersion(this.formulaVersion)
    },

    ordersByFleet() {
      const byFleet = {}

      this.orders.forEach((order) => {
        const label = placeOf(order)
        const exitLabel = !order.Jumps ? label : order.DestinationType === 1 ? `${order.ArrivalSystemName || 'next system'} (arrival)` : order.Description && order.Description.includes(' Jump to ') ? order.Description.split(' Jump to ').pop() : label
        const endpoint = order.PopulationID > 0 ? colonyEndpoint(order, label) : bareEndpoint(label)

        ;(byFleet[order.FleetID] = byFleet[order.FleetID] || []).push({ ...order, label, exitLabel, endpoint })
      })

      return byFleet
    },

    routeRows() {
      return this.fleets.map((fleet) => {
        const orders = this.ordersByFleet[fleet.FleetID] || []
        const route = walkRoute(orders)
        const ships = this.shipsByFleet[fleet.FleetID] || []
        const profile = fleetProfile(ships, fleet, { basis: 'saved' })
        const sailing = hauledFleet(fleet, profile)
        const cargo = cycleCargo(orders, sailing)
        const handling = cycleHandling(orders, cargo, sailing, profile.cargo.ships, { version: this.formulaVersion, support: this.officerSupport })
        const year = routeYear(sailing, route, cargo, handling, orders.reduce((sum, order) => sum + (order.OrderDelay || 0), 0))
        const speedText = profile.status === 'ok' ? `${this.count(profile.cruise)} km/s` : 'no speed'
        const savedText = profile.status === 'ok' && Number.isFinite(profile.savedSpeed) && profile.savedSpeed !== profile.cruise ? `(saved ${this.count(profile.savedSpeed)})` : ''
        const capital = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
        const results = routeResults(route, year, handling)
        // A stop does something where it goes: transits and plain moves only pass through.
        const stops = orders.filter((order) => !order.Jumps && order.MoveActionID !== MOVE_TO_LOCATION).map((order) => `${placeOf(order)}: ${order.ActionName}`)
        const freightText = year ? [year.minerals ? `${this.tons(year.minerals)} minerals` : null, year.installations ? `${this.tons(year.installations)} installations` : null].filter(Boolean).join(', ') : ''
        const colonistsText = year && year.colonists ? `${this.count(year.colonists)} colonists` : ''
        const tripText = [cargo.perTrip.minerals ? `${this.tons(cargo.perTrip.minerals)} of minerals` : null, cargo.perTrip.installations ? `${this.tons(cargo.perTrip.installations)} of installations` : null].filter(Boolean).join(' and ')
        const routesLink = this.routesLink(fleet, orders)

        return {
          ...fleet,
          Speed: sailing.Speed,
          profile,
          speedText,
          savedText,
          profileText: profile.reasons.map((reason) => capital(reason.text)).join('; '),
          profileNotes: profile.notes.map((note) => capital(note.text)),
          participantRows: participantRows(profile),
          speeds: { cruise: profile.cruise, cruiseSource: profile.cruiseSource, saved: profile.savedSpeed, useMaximum: profile.useMaximumSpeed, effectiveMax: profile.effectiveMax, designMax: profile.designMax, limiting: profile.limiting ? profile.limiting.name : '' },
          route,
          cargo,
          tripText,
          year,
          stopsText: stops.join(' → '),
          routesLink: routesLink.to,
          routesName: routesLink.name,
          handlingHours: handling.seconds === null ? null : handling.seconds / 3600,
          handlingRows: handlingRows(handling.stops.map((stop, index) => ({ key: `${fleet.FleetID}-${index}`, label: `${stop.order.label}: ${stop.order.ActionName}`, breakdown: stop.breakdown }))),
          estimate: handling.estimate,
          limiting: handling.limiting,
          blocked: handling.blocked,
          blockedText: handling.blocked.map((problem) => problem.text).join('; '),
          unknown: handling.unknown,
          unknownText: handling.unknown.map((problem) => problem.text).join('; '),
          results,
          freightText,
          colonistsText,
          kmSort: route.km ?? Infinity,
          cycleSort: year ? year.cycleDays : Infinity,
          tripsSort: year ? year.trips : -1,
          movedSort: year ? year.minerals + year.installations + year.colonists / 1000 : -1,
          fuelSort: year ? year.fuel : -1,
        }
      })
    },

    deliveryRows() {
      const totals = {}

      this.routeRows.forEach((row) => {
        if (!row.year) {
          return
        }

        row.cargo.deliveries.forEach((delivery) => {
          const key = `${delivery.PopulationID}-${delivery.kind}`
          const total = (totals[key] = totals[key] || { key, PopulationID: delivery.PopulationID, destination: delivery.name, kind: delivery.kind, amount: 0, fleets: new Set() })

          total.amount += row.year.trips * delivery.amount
          total.fleets.add(row.FleetName)
        })
      })

      return Object.values(totals).map((total) => ({ ...total, fleetCount: total.fleets.size, fleetNames: [...total.fleets].join(', ') })).sort((a, b) => b.amount - a.amount)
    },

    classRows() {
      return this.classes.map((shipClass) => ({ ...shipClass, ...classYear(shipClass) }))
    },

    // Each colony's minerals as colony-minerals.js gives them.
    colonyStocks() {
      const { needs, packets } = this

      return this.colonies.map((colony) => ({ colony, minerals: colonyMinerals(colony, needs[colony.PopulationID], packets[colony.PopulationID], colony.MassDrivers > 0 && colony.MassDriverDest > 0) }))
    },

    // The hauls under the avoid settings; none while a setting is on and the systems it reads are not in, since a plan over a guess would be the baseline passing as the safe one.
    plan() {
      return this.avoidPending ? { hauls: [], unmet: [] } : planHauls(this.colonyStocks, { jumpPoints: this.jumpPoints, reserves: this.planReserves, avoid: this.avoid })
    },

    freighters() {
      return this.classes.filter((shipClass) => shipClass.CargoCapacity > 0)
    },

    // Tonnes of minerals the running routes bring each colony a year.
    mineralDeliveries() {
      return Object.fromEntries(this.deliveryRows.filter((row) => row.kind === 'minerals').map((row) => [row.PopulationID, row.amount]))
    },

    // Each haul with every freighter class timed on it, those that can carry it first and the quickest single ship before the others.
    planRows() {
      const { freighters, shuttleTechnology, mineralDeliveries, formulaVersion } = this
      const reasons = (item) => Object.keys(HAUL_REASONS).filter((reason) => item[reason] >= 1).map((reason) => `${this.tons(item[reason])} ${HAUL_REASONS[reason].label}`).join(', ')

      return this.plan.hauls.map((haul) => {
        const estimates = freighters.map((shipClass) => {
          const estimate = haulByClass(haul, shipClass, shuttleTechnology, formulaVersion)
          const problems = estimate.problems.map((problem) => problem.text).join('; ')
          const note = estimate.status === 'range' ? 'A round trip needs more fuel than its tanks hold' : estimate.status === 'blocked' ? `Can't load or unload: ${problems}` : estimate.status === 'unknown' ? `Not known: ${problems}` : estimate.status === 'immobile' ? 'The class has no speed' : ''

          return { ...estimate, timed: estimate.status === 'ok' || estimate.status === 'range', note, result: tripResult(estimate) }
        }).sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok') || Number(b.timed) - Number(a.timed) || (a.oneShipDays ?? 0) - (b.oneShipDays ?? 0))
        const best = estimates.find((estimate) => estimate.status === 'ok') || null
        const delivered = mineralDeliveries[haul.to.PopulationID]
        const ends = { from: place.colony(haul.from.PopulationID), to: place.colony(haul.to.PopulationID) }

        return {
          ...haul,
          toName: haul.to.PopName,
          estimates,
          best,
          bestSort: best ? best.oneShipDays : Infinity,
          linkName: `${haul.from.PopName} to ${haul.to.PopName}`,
          mineralsText: haul.minerals.map((mineral) => `${mineral.name} ${this.tons(mineral.tonnes)}`).join(', '),
          reasonText: reasons({ queue: haul.queue, reserve: haul.tonnes - haul.queue }),
          detourText: haul.detour ? detourText(haul.detour, this.gkm) : '',
          pathResult: this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : null,
          mineralDetail: `${haul.minerals.map((mineral) => `${mineral.name}: ${reasons(mineral)}`).join('. ')}.`,
          deliveredText: delivered ? `The routes already bring ${this.tons(delivered)} of minerals here a year` : '',
          transportLink: linkTo.transport(ends),
          routesLink: linkTo.routes(ends),
        }
      })
    },

    // What no colony on a charted route can cover, by colony.
    unmetRows() {
      const byColony = new Map()

      this.plan.unmet.forEach(({ colony, mineral, reason, tonnes, cut }) => {
        if (!byColony.has(colony.PopulationID)) {
          byColony.set(colony.PopulationID, { key: colony.PopulationID, name: colony.PopName, parts: [], cuts: new Map() })
        }

        const row = byColony.get(colony.PopulationID)

        row.parts.push(`${mineral.name} ${this.tons(tonnes)} ${HAUL_REASONS[reason].label}`)
        const cuts = cut || []

        cuts.forEach((source) => row.cuts.set(source.colony.PopulationID, `${source.colony.PopName}: ${cutOffText(source.cutOff)}`))
      })

      return [...byColony.values()].map(({ cuts, ...row }) => ({ ...row, text: row.parts.join(', '), cutTexts: [...cuts.values()] }))
    },

    planEmptyText() {
      if (this.avoidPending) {
        return this.avoidNote.text
      } else if (this.plan.unmet.length) {
        return 'No colony on a charted route has stock to spare for what the others lack.'
      }

      return this.planReserves ? 'None of the colonies lacks a mineral for its queue or its reserve.' : 'None of the colonies lacks a mineral for its queue.'
    },

    planHeaders() {
      return [
        { text: 'Haul', value: 'toName' },
        { text: 'Minerals', value: 'mineralsText', sortable: false, width: '30%' },
        { text: 'Tonnes', value: 'tonnes', align: 'end' },
        { text: 'Route', value: 'km', align: 'end' },
        { text: 'Best freighter', value: 'bestSort', align: 'end' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    tiles() {
      const counted = this.routeRows.filter((row) => row.year)
      const untraced = this.routeRows.filter((row) => row.route.km === null).length
      const blocked = this.routeRows.filter((row) => row.route.km !== null && row.blocked.length).length
      const idle = this.routeRows.filter((row) => row.route.km !== null && !row.blocked.length && !(row.Speed > 0)).length
      const unknown = this.routeRows.filter((row) => row.route.km !== null && row.unknown.length && !row.blocked.length).length
      const sum = (key) => counted.reduce((total, row) => total + row.year[key], 0)
      const cargo = this.classes.reduce((total, shipClass) => total + shipClass.CargoCapacity * shipClass.Ships, 0)
      const colonists = this.classes.reduce((total, shipClass) => total + shipClass.ColonistCapacity * shipClass.Ships, 0)
      const ships = this.classes.reduce((total, shipClass) => total + shipClass.Ships, 0)
      const planned = this.plan.hauls.reduce((total, haul) => total + haul.tonnes, 0)
      const missing = this.plan.unmet.reduce((total, row) => total + row.tonnes, 0)
      const destinations = new Set(this.plan.hauls.map((haul) => haul.to.PopulationID)).size

      return [
        {
          label: 'To haul',
          value: this.avoidPending ? '—' : this.tons(planned),
          ...(this.avoidPending ? { result: unreadResult() } : {}),
          note: [this.plan.hauls.length ? `${this.count(this.plan.hauls.length)} ${this.plan.hauls.length === 1 ? 'haul' : 'hauls'} to ${this.count(destinations)} ${destinations === 1 ? 'colony' : 'colonies'}` : null, missing >= 1 ? `${this.tons(missing)} with no source` : null].filter(Boolean).join(', ') || this.planEmptyText,
          icon: missing >= 1 ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Freighters and colony ships',
          value: this.count(ships),
          note: `${this.tons(cargo)} of cargo space, ${this.count(colonists)} colonist berths`,
        },
        {
          label: 'Repeating routes',
          value: `${this.routeRows.length}`,
          note: `${counted.length === this.routeRows.length ? 'All traced' : `${counted.length} counted: ${[untraced ? `${untraced} can't be traced` : null, blocked ? `${blocked} can't load` : null, unknown ? `${unknown} not known to load` : null, idle ? `${idle} not moving` : null].filter(Boolean).join(', ')}`}; ${counted.length ? `${this.litres(sum('fuel'))} of fuel a year at the set speed` : 'no fuel figure'}`,
          icon: counted.length === this.routeRows.length ? null : 'mdi-alert',
          iconColor: 'warning',
        },
        {
          label: 'Moved per year',
          value: counted.length || !this.routeRows.length ? this.tons(sum('minerals') + sum('installations')) : '—',
          note: counted.length ? `${this.tons(sum('minerals'))} minerals, ${this.tons(sum('installations'))} installations, ${this.count(sum('colonists'))} colonists` : this.routeRows.length ? 'No route could be timed' : 'No fleet repeats its orders',
        },
      ]
    },

    routeHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'Stops', value: 'route', sortable: false, width: '34%' },
        { text: 'Round trip', value: 'kmSort', align: 'end' },
        { text: 'Cycle', value: 'cycleSort', align: 'end' },
        { text: 'Trips / yr', value: 'tripsSort', align: 'end' },
        { text: 'Moves / yr', value: 'movedSort', align: 'end' },
        { text: 'Fuel / yr', value: 'fuelSort', align: 'end' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    deliveryHeaders() {
      return [
        { text: 'Destination', value: 'destination' },
        { text: 'Cargo', value: 'kind' },
        { text: 'Per year', value: 'amount', align: 'end' },
        { text: 'Routes', value: 'fleetCount', align: 'end' },
      ]
    },

    classHeaders() {
      return [
        { text: 'Class', value: 'ClassName' },
        { text: 'Ships', value: 'Ships', align: 'end' },
        { text: 'Cargo', value: 'CargoCapacity', align: 'end' },
        { text: 'Colonists', value: 'ColonistCapacity', align: 'end' },
        { text: 'km/s', value: 'MaxSpeed', align: 'end' },
        { text: 'Bn km / yr', value: 'gkm', align: 'end' },
        { text: 'Fuel / yr', value: 'fuel', align: 'end' },
      ]
    },
  },
  methods: {
    colonyLink(populationId) {
      return linkTo.colonyOutlook(populationId)
    },
    // Route Finder with the fleet's cycle as its stops and its own speed and movement settings; a fleet with no stop to name opens on the fleet itself.
    routesLink(fleet, orders) {
      const stops = cycleStops(orders, this.RaceID)

      return stops.length ? { to: linkTo.routes({ stops, cycle: true, fleet: fleet.FleetID }), name: `${fleet.FleetName}'s cycle` } : { to: linkTo.routes({ from: place.fleet(fleet.FleetID) }), name: fleet.FleetName }
    },
    count(value) {
      return known(value) ? separatedNumber(roundToDecimal(value, 0), this.separator) : '—'
    },
    fixed(value, decimals) {
      return known(value) ? roundToDecimal(value, decimals).toFixed(decimals) : '—'
    },
    tons(value) {
      return known(value) ? `${compact(value)} t` : '—'
    },
    litres(value) {
      return known(value) ? `${compact(value)} L` : '—'
    },
    gkm(km) {
      return km >= 1e9 ? `${roundToDecimal(km / 1e9, 2)} bn km` : `${roundToDecimal(km / 1e6, 1)} M km`
    },
  },
  asyncComputed: {
    // Classes with cargo or colonist space that can move, how many of the race's own ships use them, and the figures a round trip is timed with.
    classes: {
      get: tracked('classes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_HullDescription.HullAbbr, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency as FuelPerHour, FCT_ShipClass.Size, ${CLASS_SHUTTLE_STRENGTH_COLUMNS}, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.ShippingLineID = 0 left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_ShipClass.HullDescriptionID where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID} and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0) and FCT_ShipClass.MaxSpeed > 1 group by FCT_ShipClass.ShipClassID order by Ships desc`).then(([items]) => items)
      }),
      default: [],
    },
    // Fleets on repeat (FCT_Fleet.CycleMoves) with cargo or colonist space. Speed is the set speed.
    fleets: {
      get: tracked('fleets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.Speed, count(FCT_Ship.ShipID) as Ships, sum(FCT_ShipClass.CargoCapacity) as CargoCapacity, sum(FCT_ShipClass.ColonistCapacity) as ColonistCapacity, sum(FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency) as FuelPerHour, max(FCT_Race.CargoShuttleLoadModifier) as ShuttleTechnology from FCT_Fleet inner join FCT_Race on FCT_Race.RaceID = FCT_Fleet.RaceID inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 group by FCT_Fleet.FleetID having sum(FCT_ShipClass.CargoCapacity) > 0 or sum(FCT_ShipClass.ColonistCapacity) > 0 order by FCT_Fleet.FleetName`).then(([items]) => items)
      }),
      default: [],
    },
    // Their ships whole (`loadFleetShips`): the strength of their undamaged cargo shuttle bays, size and crew (for loading time), and what the fleet's speed, burn and counted cargo come from (engines, overhaul, hangars and tows).
    fleetShips: {
      get: tracked('fleetShips', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadFleetShips(this.database, { GameID: this.GameID, RaceID: this.RaceID, fleetWhere: 'FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0' })
      }),
      default: [],
    },
    // Those fleets' orders with where each one goes (SystemID, X, Y) and where the fleet is after it (ExitSystemID, ExitX, ExitY), as the game measures a fleet's orders: the destination's stored place, whatever kind it is, and for a jump point or Lagrange point the far side when the order goes through it. Only a transit (DIM_MoveAction TransitOrder) or an Intra-system Jump (124) comes out on the far side (`Jumps`); any other order leaves the fleet where it went. A survey location is numbered within the system the order starts in; a contact is the row with the order's UniqueID.
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, DIM_MoveAction.Description as ActionName, FCT_MoveOrders.Description, FCT_MoveOrders.DestinationType, FCT_MoveOrders.DestinationID, case when (FCT_MoveOrders.DestinationType = 1 and DIM_MoveAction.TransitOrder > 0) or (FCT_MoveOrders.DestinationType = 12 and FCT_MoveOrders.MoveActionID = 124) then 1 else 0 end as Jumps, FCT_MoveOrders.PopulationID, FCT_MoveOrders.MaxItems, FCT_MoveOrders.OrderDelay, FCT_Population.PopName, FCT_Population.RaceID as PopulationRaceID, ${orderPoint(['VIR_Exit', 'VIR_LagrangeIn'], 'SystemID')} as SystemID, ${orderPoint(['VIR_Exit', 'VIR_LagrangeIn'], 'Xcor')} as X, ${orderPoint(['VIR_Exit', 'VIR_LagrangeIn'], 'Ycor')} as Y, ${orderPoint(['VIR_Arrival', 'VIR_LagrangeOut'], 'SystemID')} as ExitSystemID, ${orderPoint(['VIR_Arrival', 'VIR_LagrangeOut'], 'Xcor')} as ExitX, ${orderPoint(['VIR_Arrival', 'VIR_LagrangeOut'], 'Ycor')} as ExitY, VIR_ArrivalSystem.Name as ArrivalSystemName, VIR_Survey.SurveyLocationID, case when FCT_Population.PopulationID is null then null else coalesce(VIR_Service.ShuttleCapacity, 0) end as ShuttleCapacity, VIR_Service.ServiceNames from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 left join DIM_MoveAction on DIM_MoveAction.MoveActionID = FCT_MoveOrders.MoveActionID left join FCT_JumpPoint as VIR_Exit on FCT_MoveOrders.DestinationType = 1 and VIR_Exit.WarpPointID = FCT_MoveOrders.DestinationID left join FCT_JumpPoint as VIR_Arrival on FCT_MoveOrders.DestinationType = 1 and VIR_Arrival.WarpPointID = case when DIM_MoveAction.TransitOrder > 0 then (case when FCT_MoveOrders.NewWarpPointID > 0 then FCT_MoveOrders.NewWarpPointID else VIR_Exit.WPLink end) else FCT_MoveOrders.DestinationID end left join FCT_RaceSysSurvey as VIR_ArrivalSystem on VIR_ArrivalSystem.SystemID = VIR_Arrival.SystemID and VIR_ArrivalSystem.RaceID = FCT_MoveOrders.RaceID and VIR_ArrivalSystem.GameID = FCT_MoveOrders.GameID left join FCT_SystemBody on FCT_MoveOrders.DestinationType in (2, 15) and FCT_SystemBody.SystemBodyID = FCT_MoveOrders.DestinationID left join FCT_LagrangePoint as VIR_LagrangeIn on FCT_MoveOrders.DestinationType = 12 and VIR_LagrangeIn.LagrangePointID = FCT_MoveOrders.DestinationID left join FCT_LagrangePoint as VIR_LagrangeOut on FCT_MoveOrders.DestinationType = 12 and VIR_LagrangeOut.LagrangePointID = case when FCT_MoveOrders.MoveActionID = 124 then FCT_MoveOrders.DestinationItemID else FCT_MoveOrders.DestinationID end left join FCT_SurveyLocation as VIR_Survey on FCT_MoveOrders.DestinationType = 4 and VIR_Survey.GameID = FCT_MoveOrders.GameID and VIR_Survey.SystemID = FCT_MoveOrders.StartSystemID and VIR_Survey.LocationNumber = FCT_MoveOrders.DestinationID left join FCT_Waypoint as VIR_Waypoint on FCT_MoveOrders.DestinationType = 5 and VIR_Waypoint.GameID = FCT_MoveOrders.GameID and VIR_Waypoint.WaypointID = FCT_MoveOrders.DestinationID left join FCT_Contacts as VIR_Contact on FCT_MoveOrders.DestinationType = 6 and VIR_Contact.GameID = FCT_MoveOrders.GameID and VIR_Contact.UniqueID = FCT_MoveOrders.DestinationID left join FCT_Lifepods as VIR_Lifepod on FCT_MoveOrders.DestinationType = 7 and VIR_Lifepod.GameID = FCT_MoveOrders.GameID and VIR_Lifepod.LifepodID = FCT_MoveOrders.DestinationID left join FCT_Wrecks as VIR_Wreck on FCT_MoveOrders.DestinationType = 8 and VIR_Wreck.GameID = FCT_MoveOrders.GameID and VIR_Wreck.WreckID = FCT_MoveOrders.DestinationID left join FCT_Fleet as VIR_Destination on FCT_MoveOrders.DestinationType = 10 and VIR_Destination.GameID = FCT_MoveOrders.GameID and VIR_Destination.FleetID = FCT_MoveOrders.DestinationID left join FCT_AetherGates as VIR_AetherGate on FCT_MoveOrders.DestinationType = 14 and VIR_AetherGate.GameID = FCT_MoveOrders.GameID and VIR_AetherGate.AetherGateID = FCT_MoveOrders.DestinationID left join FCT_Population on FCT_Population.PopulationID = FCT_MoveOrders.PopulationID and FCT_MoveOrders.PopulationID > 0 ${shuttleServiceJoin(this.GameID, 'FCT_MoveOrders.PopulationID')} where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
      }),
      default: [],
    },
    // The race's colonies: stock and reserve of each mineral, the body's place, whether a spaceport or cargo shuttle station works there, and its mass drivers.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [colonies] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.MassDriverDest, ${STOCK_COLUMNS}, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, ${SHUTTLE_SERVICE_COLUMNS}, coalesce(VIR_Installations.MassDrivers, 0) as MassDrivers from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join (select FCT_PopulationInstallations.PopID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MassDriverValue) as MassDrivers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID ${shuttleServiceJoin(this.GameID, 'FCT_Population.PopulationID')} where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)

        return Object.freeze(colonies)
      }),
      default: [],
    },
    // What each colony's queue still needs, by colony.
    needs: {
      get: tracked('needs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadQueueNeeds(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },
    // Mass-driver packets in flight, by the colony they are bound for.
    packets: {
      get: tracked('packets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadPacketsInFlight(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },
    // The race's charted jump points, for the routes between colonies.
    jumpPoints: {
      get: tracked('jumpPoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadJumpPoints(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // The race's cargo shuttle technology, which speeds every load and unload. Null when the race row has none: the loading strength is then unknown, not 1.
    shuttleTechnology: {
      get: tracked('shuttleTechnology', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        const [[race]] = await this.database.query(`select FCT_Race.CargoShuttleLoadModifier from FCT_Race where FCT_Race.RaceID = ${this.RaceID}`)

        return race && race.CargoShuttleLoadModifier > 0 ? race.CargoShuttleLoadModifier : null
      }),
      default: null,
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
    // The officers' Logistics bonuses that multiply a ship's loading strength (`loadHandlingSupport`): optional, so the page renders without them and counts each as unknown until they are in. Null when the race row is not selected.
    handlingSupport: {
      get: tracked('handlingSupport', async function () {
        const { database, GameID, RaceID } = this
        const gates = this.capabilityGates('/hauling')

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
.hauling-page {
  td {
    font-variant-numeric: tabular-nums;
  }

  .plan-tools {
    gap: 12px;
  }

  .route-cell {
    max-width: 520px;
    padding: 4px 0;
  }

  .legs-table {
    max-width: 760px;
    background: transparent !important;
  }
}
</style>
