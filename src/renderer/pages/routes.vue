<template>
  <div>
    <v-container fluid class="routes-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <v-alert v-if="largeProblem" type="warning" dense text class="mb-2">{{ largeProblem }}</v-alert>

        <div class="toolbar">
          <div class="tool">
            <div class="tool__label caption text--secondary">Route</div>
            <v-btn-toggle v-model="order" mandatory dense>
              <v-tooltip v-for="option in orders" :key="option.value" bottom max-width="320">
                <template #activator="{ on }">
                  <v-btn :value="option.value" small v-on="on">{{ option.label }}</v-btn>
                </template>
                <span>{{ option.hint }}</span>
              </v-tooltip>
            </v-btn-toggle>
          </div>
          <div class="tool tool--speed">
            <div class="tool__label caption text--secondary">Speed</div>
            <v-text-field v-model.number="speed" type="number" min="1" :placeholder="speedPlaceholder" suffix="km/s" aria-label="Speed in km/s" dense outlined hide-details>
              <template #append>
                <v-menu offset-y left max-height="420">
                  <template #activator="{ on, attrs }">
                    <v-icon small title="Use a ship class's speed" v-bind="attrs" v-on="on">mdi-rocket-launch-outline</v-icon>
                  </template>
                  <v-list dense>
                    <v-subheader>Speed of a class in service</v-subheader>
                    <v-list-item v-for="shipClass in classOptions" :key="shipClass.ShipClassID" @click="speed = shipClass.MaxSpeed">
                      <v-list-item-content>
                        <v-list-item-title>{{ shipClass.ClassName }}</v-list-item-title>
                        <v-list-item-subtitle>{{ count(shipClass.MaxSpeed) }} km/s · {{ shipClass.Ships }} {{ shipClass.Ships === 1 ? 'ship' : 'ships' }}{{ shipClass.JumpRating ? '' : ' · no jump drive' }}</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                  </v-list>
                </v-menu>
              </template>
            </v-text-field>
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="420">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Route options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">As a fleet's movement settings</div>
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
            <v-btn icon :disabled="stopKeys.length < 2" aria-label="Reverse the stops" title="Reverse the stops" @click="reverse"><v-icon>mdi-swap-vertical</v-icon></v-btn>
          </div>
        </div>

        <stat-tiles :tiles="tiles" class="mt-1" />

        <v-row>
          <v-col cols="12" lg="5" xl="4">
            <stop-list :rows="stopRows" :cycle="cycle" :groups="pickerGroups" @insert="insertStop" @replace="replaceStop" @remove="removeStop" @move="moveStop" @need="ensureLarge" @update:cycle="(value) => (cycle = value)">
              <template #foot>Each leg is routed on its own over the jump points the race has explored, by the order chosen above. A system is reached at the jump point it is entered through and left from there; a first stop that is a system starts at its centre. Return to start adds the leg back to the first stop. Bodies, fleets, waypoints and the rest are where the save has them now.</template>
            </stop-list>
          </v-col>
          <v-col cols="12" lg="7" xl="8">
            <v-card class="panel" data-summary="The known systems shaded by distance from the first stop, with the planned route drawn across them. Click a system to extend the route." elevation="1">
              <div class="panel-head">
                <span>Route map<provenance-mark rule="route.reachShade" /></span>
                <span class="legend">
                  <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Stops</span>
                  <span class="legend-item"><span class="line" :style="{ background: colors.route }" />Route</span>
                  <span class="legend-item"><span class="dot" :style="{ background: colors.near }" /><span class="dot" :style="{ background: withAlpha(colors.near, 0.35) }" />Near to far</span>
                  <span class="legend-item"><span class="dot" :style="{ background: colors.avoided }" />Avoided</span>
                  <span class="legend-item"><span class="dot" :style="{ background: colors.out }" />Out of reach</span>
                </span>
              </div>
              <div class="panel-body">
                <system-map :systems="mapNodes" :links="links" :route="plan.systems" :route-color="colors.route" :selected="lastStop ? lastStop.SystemID : null" aria-label="Known systems by distance from the first stop, with the route" @select="(systemId) => insertStop(stopKeys.length, { key: `system:${systemId}`, kind: 'system' })" />
              </div>
              <div class="panel-foot caption text--secondary">Positions as on the game's galactic map, shaded by distance from the first stop, and systems the save leaves at the game's centre are drawn beside a linked system. Numbers mark the stops. Click a system to add it as the last stop. A leg with no explored route is bridged by a straight line.</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card v-if="detailRows.length" class="panel" data-summary="The route leg by leg, with the jump points passed and the distance and time along the way. It shows how long the whole journey will take." elevation="1">
          <div class="panel-head">
            <span>Route detail<provenance-mark rule="route.detailTotal" label /></span>
          </div>
          <v-data-table :headers="legHeaders" :items="detailRows" item-key="id" group-by="leg" disable-pagination disable-sort hide-default-footer dense>
            <template #[`group.header`]="{ group, headers, toggle, isOpen }">
              <td :colspan="headers.length" class="leg-group">
                <v-btn icon x-small :aria-label="isOpen ? 'Collapse this leg' : 'Expand this leg'" class="mr-2" @click="toggle"><v-icon small>{{ isOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon></v-btn>
                <span class="font-weight-medium">{{ group + 1 }}. {{ legTitle(group) }}</span>
                <span class="text--secondary ml-3">{{ legFigures(group) }}<provenance-mark v-if="legTimeResult(group)" :result="legTimeResult(group)" /></span>
              </td>
            </template>
            <template #[`item.SystemName`]="{ item }">
              <span class="font-weight-medium">{{ item.SystemName }}</span>
              <page-link v-if="item.SystemID" class="ml-1" :to="linkTo.map(item.SystemID)" :name="item.SystemName" />
            </template>
            <template #[`item.way`]="{ item }">
              <div v-if="item.note" class="py-1 text--secondary">{{ item.note }}</div>
              <div v-else class="py-1">
                <div>{{ item.from }}</div>
                <div class="leg-next">
                  <v-icon x-small>mdi-arrow-right</v-icon>
                  <span v-if="item.gate">{{ lastWord(item.to)[0] }}<span class="text-no-wrap">{{ lastWord(item.to)[1] }} <v-icon x-small :color="colors.route" title="A stabilised jump point: ships without a jump drive can transit">mdi-gate</v-icon></span></span>
                  <span v-else>{{ item.to }}</span>
                </div>
                <div v-if="item.via" class="caption text--secondary">Lagrange jump from {{ item.via[0] }} to {{ item.via[1] }}</div>
              </div>
            </template>
            <template #[`item.km`]="{ item }"><span class="text-no-wrap">{{ distance(item.km) }}</span><provenance-mark v-if="item.kmResult.status !== 'confirmed'" :result="item.kmResult" /></template>
            <template #[`item.total`]="{ item }"><span class="text-no-wrap">{{ distance(item.total) }}</span><provenance-mark v-if="item.totalResult.status !== 'confirmed'" :result="item.totalResult" /></template>
            <template #[`item.time`]="{ item }"><span class="text-no-wrap">{{ timeText(item.total) }}</span><provenance-mark :result="item.timeResult" /></template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">Times are flying {{ speedText }}, counted from the first stop. Jumps take no time here; the jump shock after each and nebula speed limits are left out.<provenance-mark :result="speedResult" /></div>
        </v-card>

        <v-card class="panel" data-summary="How far every known system is from the first stop by explored routes, with jumps and travel time. Click a row to add it as a stop." elevation="1">
          <div class="panel-head">
            <span>Distances from {{ origin ? origin.name : '—' }}<provenance-mark rule="route.reachableCount" label /></span>
            <v-text-field v-model="search" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <v-data-table :headers="distanceHeaders" :items="distanceRows" item-key="SystemID" :search="search" :custom-filter="filterSystem" :custom-sort="sortNullLast" :sort-by.sync="distanceTable.sortBy" :sort-desc.sync="distanceTable.sortDesc" :items-per-page.sync="distanceTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: distancePageSizes }" class="clickable-rows" @click:row="(row) => insertStop(stopKeys.length, { key: `system:${row.SystemID}`, kind: 'system' })">
            <template #[`item.Name`]="{ item }">
              <span class="font-weight-medium">{{ item.Name }}</span>
              <page-link class="ml-1" :to="linkTo.map(item.SystemID)" :name="item.Name" />
            </template>
            <template #[`item.jumpsSort`]="{ item }"><span v-if="item.route">{{ item.route.jumps }}</span><span v-else class="text--secondary">—<provenance-mark :result="item.jumpsResult" /></span></template>
            <template #[`item.kmSort`]="{ item }"><span v-if="item.route" class="text-no-wrap">{{ distance(item.route.km) }}</span><span v-else class="text--secondary">—<provenance-mark :result="item.kmResult" /></span></template>
            <template #[`item.time`]="{ item }"><span class="text-no-wrap">{{ item.route ? timeText(item.route.km) : '—' }}</span><provenance-mark :result="item.timeResult" /></template>
            <template #[`item.status`]="{ item }">
              <span :class="{ 'text--secondary': !item.reason }">{{ item.status }}</span><provenance-mark v-if="item.assumedAvoid" rule="route.avoidance" />
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            To a system, routes end at the jump point they arrive through; from a system, they start at its centre, as the galactic map measures. Only jump points the race has explored are used. Click a row to add that system as the last stop.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import groupBy from 'lodash/groupBy'
import { mapGetters } from 'vuex'

import { chartTheme, withAlpha } from '../components/charts/theme'
import SystemMap from '../components/exploration/SystemMap.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import StopList from '../components/routes/StopList.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { systemBodyName } from '../utilities/aurora'
import { linkTo, queryId, queryPlace, queryPlaceKeys } from '../utilities/deep-links'
import { jumpLinks, KM_PER_AU, loadJumpPoints, routeLegs, routeResults, searchRoutes } from '../utilities/jump-graph'
import { joinLabels, tracked } from '../utilities/load-tracking'
import { countLargePlaces, loadBodyPlaces, loadPlacesByKeys, loadSmallPlaces, loadSurveyPlaces } from '../utilities/place-data'
import { colonyPlaces, fleetPlaces, jumpPointPlaces, lagrangePlaces, PLACE_GROUPS, searchable, systemPlaces } from '../utilities/places'
import { describeResult, describeRule, valueOrNull } from '../utilities/provenance'
import { avoidance, detailTotal, distanceResult, flightSpeed, planResults, planRoute, stepCounts, transitOptions, travelTime } from '../utilities/route-plan'
import { fleetCanTransit, JUMP_DRIVE_COLUMNS } from '../utilities/transport'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  colonies: 'the colonies',
  fleets: 'the fleets',
  classes: 'the ship classes',
  lagrangePoints: 'the Lagrange points',
  smallPlaces: 'the waypoints, wrecks and contacts',
  placeCounts: 'the bodies and survey locations',
}

// A fleet's movement settings, as the game's auto-route applies them. None of them keeps a route from leaving its origin.
const OPTIONS = [
  { key: 'avoidDanger', config: 'routesAvoidDanger', default: true, label: 'Avoid danger', hint: 'Skips systems whose danger rating the race\'s ships there don\'t outweigh in protection value.' },
  { key: 'avoidAlien', config: 'routesAvoidAlien', default: false, label: 'Avoid alien systems', hint: 'Skips systems controlled by an alien race without a trade treaty.' },
  { key: 'skipNoAutoRoute', config: 'routesSkipNoAutoRoute', default: false, label: 'Skip "no auto-route" systems', hint: 'Skips the systems flagged to keep auto-routes out.' },
  { key: 'civilian', config: 'routesCivilian', default: false, label: 'Civilian shipping', hint: 'Keeps out of military restricted systems and jump points, as shipping lines do.' },
  { key: 'gatesOnly', config: 'routesGatesOnly', default: false, label: 'Stabilised jump points only', hint: 'For ships that cannot make their own jump (no jump drive, or one too small for the largest ship): transits only where the jump point is stabilised on the near side.' },
  { key: 'useLagrange', config: 'routesUseLagrange', default: true, label: 'Use Lagrange points', hint: 'Jumps between stable Lagrange points inside a system when that is shorter, as fleets do unless told not to.' },
]

const ORDERS = [
  { value: 'jumps', label: 'Fewest jumps', hint: 'The game\'s auto-route: the fewest transits, then the shorter way.' },
  { value: 'km', label: 'Shortest', hint: 'The fewest kilometres, as the galactic map\'s distances measure.' },
]
const DISTANCE_PAGE_SIZES = [15, 30, -1]
// Each movement setting is kept on its own, for every game.
const OPTION_FIELDS = Object.fromEntries(OPTIONS.map((option) => [option.key, { key: option.config, default: option.default }]))

// The places whose lists are read only when the picker lists them, and the kinds of place key those hold.
const BODY_GROUPS = ['planet', 'moon', 'asteroid', 'comet']
const LAZY_GROUPS = [...BODY_GROUPS, 'survey']
const LAZY_KINDS = ['body', 'survey']
const EMPTY_LIST = Object.freeze([])

const firstOf = (value) => (Array.isArray(value) ? value[0] : value)

// The route as a list of stops, each a place key of utilities/deep-links.js, planned leg by leg (utilities/route-plan.js), with the stops' places drawn on the map and listed with their legs.
export default {
  name: 'RoutesPage',
  components: { LoadState, PageLink, ProvenanceMark, StatTiles, StopList, SystemMap },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      // The stops keep their repeats, and drop what isn't a place key.
      stopKeys: { key: 'routesStops', default: [], scope: 'race', normalise: (stored) => (Array.isArray(stored) ? queryPlaceKeys(stored.join(',')) : undefined) },
      cycle: { key: 'routesCycle', default: false, scope: 'race', valid: (value) => typeof value === 'boolean' },
      // Only a positive speed is one; anything else is the fleet-class median.
      speed: { key: 'routesSpeed', default: null, scope: 'race', valid: (value) => value > 0 },
      order: { key: 'routesOrder', default: 'jumps', valid: oneOf(ORDERS.map((option) => option.value)) },
      ...OPTION_FIELDS,
      search: { key: 'routesSearch', default: '', scope: 'race' },
      distanceTable: tableView('routesDistancesTable', { sortBy: ['jumpsSort'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: DISTANCE_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      // The fleet key a link named, whose speed and movement settings apply once the fleets have loaded.
      pendingFleet: null,
      // The fleet key whose speed and movement settings the route took; it goes into the link while the route still has them (`linkedFleetId`).
      routeFleet: null,
      // Whether the capital is to be put in front of the stops: a route that has none yet, or whose link names no first stop.
      needsOrigin: false,
      // The bodies and survey locations, by picker group, once read; the places of the stops that are kept without reading those lists; and where each of those stops stands in being read.
      largePlaces: {},
      extra: {},
      lazyState: {},
      largeProblem: '',
      optionList: OPTIONS,
      orders: ORDERS,
      distancePageSizes: DISTANCE_PAGE_SIZES,
      linkTo,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    colors() {
      const [blue, , green] = this.theme.categorical

      return { near: blue, route: green, avoided: this.appearance.status.shortfall, out: withAlpha(this.theme.inkMuted, 0.35) }
    },

    options() {
      return Object.fromEntries(OPTIONS.map((option) => [option.key, this[option.key]]))
    },

    links() {
      return jumpLinks(this.jumpPoints)
    },

    systemById() {
      return Object.fromEntries(this.systems.map((system) => [system.SystemID, system]))
    },

    jumpPointById() {
      return Object.fromEntries(this.jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
    },

    // The places read with the page: colonies, systems, jump points, Lagrange points, fleets, and the waypoints, wrecks and the rest. Bodies and survey locations wait until the picker lists them.
    places() {
      const name = (systemId) => this.systemNameOf(systemId)

      return Object.freeze([
        ...searchable([
          ...colonyPlaces(this.colonies, name),
          ...systemPlaces(this.systems),
          ...jumpPointPlaces(this.jumpPoints, name),
          ...lagrangePlaces(this.lagrangePoints, name, (point) => this.lagrangeName(point)),
          ...fleetPlaces(this.fleets, name, this.count),
        ], name),
        ...this.smallPlaces,
      ])
    },

    // A contact is found under each of its rows' keys.
    placeByKey() {
      const found = {}

      this.places.forEach((place) => {
        found[place.key] = place
        ;(place.aliases || EMPTY_LIST).forEach((alias) => {
          found[alias] = place
        })
      })

      return found
    },

    // The picker's types in listing order. A type that is read on demand carries no places until it has been.
    pickerGroups() {
      const eager = {}

      this.places.forEach((place) => {
        ;(eager[place.group] = eager[place.group] || []).push(place)
      })

      return PLACE_GROUPS.map((group) => {
        const lazy = LAZY_GROUPS.includes(group.id)
        const places = lazy ? this.largePlaces[group.id] || null : Object.freeze(eager[group.id] || [])

        return { ...group, count: lazy ? this.placeCounts[group.id] || 0 : places.length, places }
      })
    },

    // Every stop in order, each with where it stands in the stored list; one the page can't tell stands in as unavailable, so the route breaks there instead of joining its neighbours. A body or survey location the page is still reading is marked `reading`.
    plannedStops() {
      return this.stopKeys.map((key, stopIndex) => {
        const found = this.placeByKey[key] || this.extra[key]

        return found ? { ...found, stopIndex } : { key, name: 'Unavailable stop', unavailable: true, reading: LAZY_KINDS.includes(key.split(':')[0]) && this.lazyState[key] !== 'done', stopIndex }
      })
    },

    // The stops that name a place the page can tell.
    routeStops() {
      return this.plannedStops.filter((stop) => !stop.unavailable)
    },

    // Whether a stop is still being read, so a leg it breaks isn't reported as having no route yet.
    readingStops() {
      return this.plannedStops.some((stop) => stop.reading)
    },

    origin() {
      return this.routeStops[0] || null
    },

    lastStop() {
      return this.routeStops[this.routeStops.length - 1] || null
    },

    // The jump points a route may transit under the gate and civilian options, and what the options assume where the save lacks a gate strength or restriction.
    transit() {
      return transitOptions(this.options, this.jumpPoints)
    },

    // A route's search options: its order, which jump points it may transit and which systems it may enter, and whether it uses Lagrange points.
    searchOptions() {
      const { useLagrange } = this.options

      return {
        order: this.order,
        canTransit: this.transit.canTransit,
        canEnter: (systemId) => !this.avoidReasons[systemId],
        lagrangePoints: useLagrange ? this.lagrangePoints : [],
      }
    },

    plan() {
      return planRoute(this.plannedStops, { cycle: this.cycle, jumpPoints: this.jumpPoints, ...this.searchOptions })
    },

    // The plan's jumps and distance as results, null for a plan with no leg. Flags the save lacks that the options read are stated as assumptions on them.
    planFigures() {
      return planResults(this.plan, this.routeAssumptions)
    },

    // The ID of the route's fleet while its speed and movement settings are still the page's. Setting a speed or an option by hand, or taking another fleet's, ends that; editing the stops doesn't.
    linkedFleetId() {
      const place = this.routeFleet && this.placeByKey[this.routeFleet]
      const fleet = place && place.fleet
      const { avoidDanger, avoidAlien, gatesOnly } = this.options

      if (!fleet || (fleet.Speed > 1 && this.speed !== fleet.Speed) || avoidDanger !== Boolean(fleet.AvoidDanger) || avoidAlien !== Boolean(fleet.AvoidAlienSystems) || gatesOnly !== !fleet.CanTransit) {
        return null
      }

      return place.key.split(':')[1]
    },

    // A first stop that is the fleet already names it.
    linkQuery() {
      const fleet = this.routeFleet !== this.stopKeys[0] ? this.linkedFleetId : null

      return this.ready && !this.needsOrigin && !this.pendingFleet ? linkTo.routes({ stops: this.stopKeys, cycle: this.cycle && this.stopKeys.length > 1, fleet }).query : null
    },

    linkLabel() {
      const stops = this.routeStops

      if (stops.length < 2) {
        return stops.length ? stops[0].name : null
      }

      return `${stops[0].name} → ${stops[stops.length - 1].name}${this.cycle ? ' and back' : ''}${stops.length > 2 ? ` (${stops.length} stops)` : ''}`
    },

    // Classes in service that move, fastest first, for the speed menu; their median speed until one is picked.
    classOptions() {
      return this.classes.slice().sort((a, b) => b.MaxSpeed - a.MaxSpeed)
    },

    // The speed the route is flown at, as a result: the speed picked, else the class median, and unavailable with neither (`flightSpeed`).
    speedResult() {
      return flightSpeed(this.speed, this.classOptions.map((shipClass) => shipClass.MaxSpeed))
    },

    effectiveSpeed() {
      return valueOrNull(this.speedResult)
    },

    speedPlaceholder() {
      return this.effectiveSpeed === null ? 'None known' : String(this.effectiveSpeed)
    },

    speedText() {
      return this.effectiveSpeed === null ? 'at no known speed, so no time is given' : `at ${this.count(this.effectiveSpeed)} km/s`
    },

    activeOptionCount() {
      return OPTIONS.filter((option) => this.options[option.key] !== option.default).length
    },

    // Why a route may not enter each system, and whether the reason rests on a flag or rating the save lacks (`avoidance`).
    avoidDetails() {
      const details = {}

      this.systems.forEach((system) => {
        const found = avoidance(system, this.options, this.count)

        if (found) {
          details[system.SystemID] = found
        }
      })

      return details
    },

    // Why a route may not enter each system, or nothing.
    avoidReasons() {
      return Object.fromEntries(Object.entries(this.avoidDetails).map(([systemId, found]) => [systemId, found.reason]))
    },

    // What the options assume where the save lacks a flag, rating or restriction they read.
    routeAssumptions() {
      const assumed = Object.values(this.avoidDetails).filter((found) => found.assumed).length

      return [...this.transit.assumptions, ...(assumed ? [`${assumed} ${assumed === 1 ? 'system is' : 'systems are'} avoided because the save lacks a flag or rating the options read`] : [])]
    },

    // The search from the first stop, for the distance table and the map's shading.
    routes() {
      return this.origin ? searchRoutes(this.jumpPoints, [this.origin], this.searchOptions) : null
    },

    // The same search with every option's limit lifted, to tell the systems the options cut off from the ones no explored route reaches at all.
    openRoutes() {
      return this.origin ? searchRoutes(this.jumpPoints, [this.origin], { order: this.order, lagrangePoints: this.options.useLagrange ? this.lagrangePoints : [] }) : null
    },

    // For each leg without a route, what keeps it out of reach.
    legNotes() {
      const notes = {}

      this.plan.legs.filter((leg) => !leg.route).forEach((leg) => {
        notes[leg.index] = this.legNote(leg)
      })

      return notes
    },

    stopRows() {
      const legOf = {}

      this.plan.legs.forEach((leg) => {
        legOf[leg.index] = leg
      })

      return this.stopKeys.map((key, index) => {
        const place = this.placeByKey[key] || this.extra[key] || null
        const leg = legOf[index]
        const reading = LAZY_KINDS.includes(key.split(':')[0]) && this.lazyState[key] !== 'done'

        return {
          index,
          key,
          status: place ? 'ok' : reading ? 'loading' : 'missing',
          place,
          leg: leg ? { closing: leg.closing, toName: leg.to.name, summary: this.figures(leg), note: this.legNotes[leg.index] || '', result: leg.route ? this.travelResult(leg.route.km) : routeResults(null).km } : null,
        }
      })
    },

    // One row per system a leg crosses: where it comes in, where it leaves, and the distance flown there; the total runs on through the legs.
    detailRows() {
      const rows = []
      const { speedResult } = this
      const none = routeResults(null)
      let total = 0
      let skipped = 0

      this.plan.legs.forEach((leg) => {
        const row = (id, fields) => {
          const found = { id: `${leg.index}:${id}`, leg: leg.index, km: 0, total, kmResult: distanceResult(0), totalResult: detailTotal(total, skipped), ...fields }

          found.timeResult = travelTime(found.totalResult, speedResult)
          rows.push(found)
        }

        if (!leg.route) {
          skipped += 1
          row('none', { SystemID: leg.start ? leg.start.SystemID : null, SystemName: leg.start ? this.systemNameOf(leg.start.SystemID) : leg.from.name, note: `No explored route${this.legNotes[leg.index] ? `: ${this.legNotes[leg.index]}` : ''}`, km: null, total: null, kmResult: none.km, totalResult: none.km })

          return
        }

        if (!leg.steps.length) {
          row('here', { SystemID: leg.start.SystemID, SystemName: this.systemNameOf(leg.start.SystemID), note: 'Already in the system' })
        }

        leg.steps.forEach((step, number) => {
          if (step.kind === 'fly') {
            total += step.km
            row(number, {
              SystemID: step.SystemID,
              SystemName: this.systemNameOf(step.SystemID),
              from: this.pointName(step.from, leg, 'from'),
              to: this.pointName(step.to, leg, 'to'),
              gate: Boolean(step.to.WarpPointID && step.to.JumpGateStrength > 0),
              via: step.via && step.via.map((point) => this.lagrangeName(point)),
              km: step.km,
              kmResult: distanceResult(step.km),
            })
          }
        })

        const last = leg.steps[leg.steps.length - 1]

        if (last && last.kind === 'jump') {
          row('arrived', { SystemID: last.to.SystemID, SystemName: this.systemNameOf(last.to.SystemID), from: this.pointName(last.to, leg, 'from'), to: 'Arrived', gate: false, via: null })
        }
      })

      return rows
    },

    // Computed values are read once, outside the loop: each read inside it would subscribe this property to every dependency of theirs again.
    distanceRows() {
      const { routes, openRoutes, origin, avoidDetails, speedResult } = this

      if (!routes) {
        return []
      }

      return this.systems.map((system) => {
        const route = routes.toSystem(system.SystemID)
        const isOrigin = system.SystemID === origin.SystemID
        const found = isOrigin ? null : avoidDetails[system.SystemID] || null
        const reason = found ? found.reason : null
        const blocked = !route && !reason && Boolean(openRoutes.toSystem(system.SystemID))
        const figures = routeResults(route, reason ? `a route into a system the options avoid (${reason})` : blocked ? 'a route the options allow' : 'an explored route from the first stop')

        return {
          ...system,
          route,
          reason,
          assumedAvoid: Boolean(found && found.assumed),
          blocked,
          jumpsResult: figures.jumps,
          kmResult: figures.km,
          timeResult: travelTime(figures.km, speedResult),
          jumpsSort: route ? route.jumps : null,
          kmSort: route ? route.km : null,
          status: isOrigin ? 'First stop' : route ? 'Reachable' : reason ? `Avoided: ${reason}` : blocked ? 'Cut off by the options' : 'Out of reach',
        }
      })
    },

    mapNodes() {
      const { colors, theme, order } = this
      const onRoute = new Set(this.plan.systems)
      const numbers = {}

      this.routeStops.forEach((stop) => {
        ;(numbers[stop.SystemID] = numbers[stop.SystemID] || []).push(stop.stopIndex + 1)
      })

      const reachable = this.distanceRows.filter((row) => row.route)
      const farthest = Math.max(1, ...reachable.map((row) => (order === 'jumps' ? row.route.jumps : row.route.km)))

      return this.distanceRows.map((row) => {
        const stop = numbers[row.SystemID]
        const reach = row.route ? (order === 'jumps' ? row.route.jumps : row.route.km) / farthest : null

        return {
          SystemID: row.SystemID,
          Name: stop ? `${[...new Set(stop)].join(', ')} · ${row.Name}` : row.Name,
          Xcor: row.Xcor,
          Ycor: row.Ycor,
          rank: stop ? 3 : onRoute.has(row.SystemID) ? 2 : row.route ? 1 : 0,
          size: stop ? 7 : onRoute.has(row.SystemID) ? 5 : 3.5,
          color: row.route ? withAlpha(colors.near, 1 - 0.65 * reach) : row.reason ? colors.avoided : colors.out,
          ring: stop ? theme.ink : null,
          label: Boolean(stop),
          title: `${row.Name}: ${row.route ? `${row.route.jumps} ${row.route.jumps === 1 ? 'jump' : 'jumps'}, ${this.distance(row.route.km)}, ${this.timeText(row.route.km)}` : row.status}`,
        }
      }).sort((a, b) => a.rank - b.rank)
    },

    tiles() {
      const { plan, planFigures } = this
      const reachable = this.distanceRows.filter((row) => row.route).length
      const avoided = this.distanceRows.filter((row) => row.reason).length
      const blocked = this.distanceRows.filter((row) => row.blocked).length
      const out = this.distanceRows.length - reachable - avoided - blocked
      const steps = plan.legs.flatMap((leg) => leg.steps)
      const counts = stepCounts(steps)
      const lagrange = counts.lagrange.value
      const legs = plan.legs.length
      const unrouted = this.readingStops ? 'reading the stops' : plan.missing ? `${plan.missing} of ${legs} legs ${plan.missing === 1 ? 'has' : 'have'} no explored route` : ''
      const warn = plan.missing > 0 && !this.readingStops
      const jumps = planFigures && planFigures.jumps
      const km = planFigures && planFigures.km
      const time = km ? travelTime(km, this.speedResult) : null
      const unrecorded = counts.stabilised.inputs.missing.length ? ` (${counts.stabilised.inputs.missing.join(', ')} not recorded)` : ''
      const stabilised = plan.missing === legs ? '' : `${counts.stabilised.value} through stabilised jump points${unrecorded}${lagrange ? `, Lagrange jumps in ${lagrange} ${lagrange === 1 ? 'system' : 'systems'}` : ''}`

      return [
        {
          label: 'Jumps',
          value: jumps && jumps.value !== null ? this.count(jumps.value) : '—',
          title: jumps ? describeResult(jumps) : describeRule('route.jumps'),
          note: legs ? [stabilised, unrouted].filter(Boolean).join('; ') : 'Add a second stop below, or click a system on the map',
          icon: warn ? 'mdi-alert-outline' : undefined,
          iconColor: warn ? 'warning' : undefined,
        },
        {
          label: 'Distance',
          value: km && km.value !== null ? this.distance(km.value) : '—',
          title: km ? describeResult(km) : describeRule('route.distanceKm'),
          note: km && km.value !== null ? `${this.count(km.value / KM_PER_AU, 1)} AU${warn ? ', without the legs that have no route' : ''}` : '',
        },
        {
          label: 'Travel time',
          value: time && time.value !== null ? this.flyTime(time.value) : '—',
          title: time ? describeResult(time) : describeRule('route.travelTime'),
          note: this.effectiveSpeed === null ? 'No speed known: enter one' : `At ${this.count(this.effectiveSpeed)} km/s`,
        },
        {
          label: 'Reachable systems',
          value: this.origin ? `${this.count(reachable)} of ${this.count(this.distanceRows.length)}` : '—',
          title: describeRule('route.reachableCount'),
          note: this.origin ? `From ${this.origin.name}: ${avoided} avoided, ${blocked ? `${blocked} cut off by the options, ` : ''}${out} out of reach` : 'From the first stop',
        },
      ]
    },

    legHeaders() {
      return [
        { text: 'System', value: 'SystemName' },
        { text: 'Way', value: 'way' },
        { text: 'Distance', value: 'km', align: 'end' },
        { text: 'Total', value: 'total', align: 'end' },
        { text: 'Elapsed', value: 'time', align: 'end' },
      ]
    },

    distanceHeaders() {
      return [
        { text: 'System', value: 'Name' },
        { text: 'Jumps', value: 'jumpsSort', align: 'end' },
        { text: 'Distance', value: 'kmSort', align: 'end' },
        { text: 'Travel time', value: 'time', align: 'end', sortable: false },
        { text: 'Status', value: 'status' },
      ]
    },
  },
  watch: {
    ready(ready) {
      if (ready) {
        this.ensureOrigin()
        this.adoptPendingFleet()
      }
    },

    // Another game or race: its stops are restored by the mixin; a route carried over from the old two-place pair joins them, and a race with none starts from its capital.
    persistedViewPrefix() {
      this.needsOrigin = !this.stopKeys.length
      this.adoptLegacyRoute()
      this.pendingFleet = null
      this.routeFleet = null
    },

    stopKeys: 'readStops',
    database: 'resetPlaces',
    GameID: 'resetPlaces',
    RaceID: 'resetPlaces',
  },
  created() {
    this.largeToken = 0
    this.largeRequests = {}
    this.needsOrigin = !this.stopKeys.length
    this.adoptLegacyRoute()
    this.readStops()
  },
  methods: {
    withAlpha,

    filterSystem(_value, query, item) {
      return item.Name.toLowerCase().includes(query.toLowerCase())
    },

    // A route stored as a From and a To becomes the stops, once, and its keys go.
    adoptLegacyRoute() {
      const prefix = this.persistedViewPrefix

      if (!prefix) {
        return
      }

      const keys = ['routesFrom', 'routesTo'].map((name) => `${prefix}.${name}`)
      const [from, to] = keys.map((key) => this.config.get(key))

      if (from === undefined && to === undefined) {
        return
      }

      if (this.config.get(`${prefix}.routesStops`) === undefined) {
        const stops = queryPlaceKeys([from, to].filter(Boolean).join(','))

        if (stops.length) {
          this.stopKeys = stops
          this.needsOrigin = !queryPlace(from)
        }
      }

      keys.forEach((key) => this.config.delete(key))
    },

    // The stops, cycle and fleet as the link names them; with no first stop the route starts from the capital.
    applyLink(query) {
      const from = queryPlaceKeys(query.from).slice(0, 1)
      const fleet = queryId(firstOf(query.fleet))

      this.stopKeys = [...from, ...queryPlaceKeys(query.via), ...queryPlaceKeys(query.to)]
      this.cycle = firstOf(query.cycle) === '1' && this.stopKeys.length > 1
      this.needsOrigin = !from.length
      this.routeFleet = null
      this.pendingFleet = fleet ? `fleet:${fleet}` : from[0] && from[0].startsWith('fleet:') ? from[0] : null
      this.ensureOrigin()
      this.adoptPendingFleet()
    },

    ensureOrigin() {
      if (!this.needsOrigin || !this.ready) {
        return
      }

      const origin = this.places.find((place) => place.Capital) || this.places[0]

      this.needsOrigin = false

      if (origin) {
        this.stopKeys = [origin.key, ...this.stopKeys]
      }
    },

    adoptPendingFleet() {
      if (!this.pendingFleet || !this.ready) {
        return
      }

      const place = this.placeByKey[this.pendingFleet]

      this.pendingFleet = null
      this.adoptFleet(place)
    },

    // A fleet as the first stop, or the one a link names, brings its speed and movement settings, and is the route's fleet until they change.
    adoptFleet(place) {
      if (place && place.fleet) {
        this.routeFleet = place.key

        if (place.fleet.Speed > 1) {
          this.speed = place.fleet.Speed
        }

        this.setOption('avoidDanger', Boolean(place.fleet.AvoidDanger))
        this.setOption('avoidAlien', Boolean(place.fleet.AvoidAlienSystems))
        this.setOption('gatesOnly', !place.fleet.CanTransit)
      }
    },

    // A picked body or survey location is kept as it is: the lists they come from are only read when asked for.
    keepPlace(place) {
      if (LAZY_KINDS.includes(place.kind) && place.name) {
        this.$set(this.extra, place.key, place)
        this.$set(this.lazyState, place.key, 'done')
      }
    },

    insertStop(index, place) {
      const stops = this.stopKeys.slice()

      this.keepPlace(place)
      stops.splice(index, 0, place.key)
      this.stopKeys = stops

      if (index === 0) {
        this.adoptFleet(place)
      }
    },

    replaceStop(index, place) {
      const stops = this.stopKeys.slice()

      this.keepPlace(place)
      stops[index] = place.key
      this.stopKeys = stops

      if (index === 0) {
        this.adoptFleet(place)
      }
    },

    removeStop(index) {
      this.stopKeys = this.stopKeys.filter((_key, at) => at !== index)
    },

    moveStop(from, to) {
      const stops = this.stopKeys.slice()

      stops.splice(to, 0, stops.splice(from, 1)[0])
      this.stopKeys = stops
    },

    reverse() {
      this.stopKeys = this.stopKeys.slice().reverse()
    },

    setOption(key, value) {
      this[key] = Boolean(value)
    },

    // Everything read for the lists and the stops belongs to one game and race.
    resetPlaces() {
      this.largeToken += 1
      this.largeRequests = {}
      this.largePlaces = {}
      this.extra = {}
      this.lazyState = {}
      this.largeProblem = ''
      this.$nextTick(() => this.readStops())
    },

    // Reads the bodies or the survey locations for the picker, once.
    ensureLarge(groupId) {
      const bodies = BODY_GROUPS.includes(groupId)

      if ((!bodies && groupId !== 'survey') || this.largePlaces[groupId] || this.largeRequests[bodies ? 'bodies' : groupId] || !this.database) {
        return
      }

      const token = this.largeToken
      const request = bodies ? 'bodies' : groupId

      this.largeRequests[request] = true
      ;(bodies ? loadBodyPlaces : loadSurveyPlaces)(this.database, this.context).then((found) => {
        if (token === this.largeToken) {
          this.largeProblem = ''

          if (bodies) {
            BODY_GROUPS.forEach((group) => this.$set(this.largePlaces, group, Object.freeze(found.filter((place) => place.group === group))))
          } else {
            this.$set(this.largePlaces, groupId, found)
          }
        }
      }, (error) => {
        if (token === this.largeToken) {
          this.largeRequests[request] = false
          this.largeProblem = `The ${bodies ? 'bodies' : 'survey locations'} could not be read: ${error.message}`
        }
      })
    },

    // The places of stops that are bodies or survey locations, which the page didn't read with the rest.
    readStops() {
      const wanted = this.stopKeys.filter((key) => LAZY_KINDS.includes(key.split(':')[0]) && !this.extra[key] && !this.lazyState[key])

      if (!wanted.length || !this.database || !this.GameID || !this.RaceID) {
        return
      }

      const token = this.largeToken

      wanted.forEach((key) => this.$set(this.lazyState, key, 'reading'))

      const settle = () => {
        if (token === this.largeToken) {
          wanted.forEach((key) => this.$set(this.lazyState, key, 'done'))
        }
      }

      loadPlacesByKeys(this.database, this.context, wanted).then((found) => {
        if (token === this.largeToken) {
          found.forEach((place) => this.$set(this.extra, place.key, place))
        }

        settle()
      }, (error) => {
        settle()

        if (token === this.largeToken) {
          this.largeProblem = `Some stops could not be read: ${error.message}`
        }
      })
    },

    // The time to fly a route of `km` at the chosen speed, as a result: unavailable with no known speed or no distance.
    travelResult(km) {
      return travelTime(distanceResult(km), this.speedResult)
    },

    // Flying time in the unit that reads best; a real 0 is 0 h and an unknown time a dash.
    flyTime(days) {
      return days === 0 ? '0 h' : this.duration(days)
    },

    timeText(km) {
      const { value } = this.travelResult(km)

      return value === null ? '—' : this.flyTime(value)
    },

    legTimeResult(index) {
      const leg = this.plan.legs[index]

      return leg && leg.route ? this.travelResult(leg.route.km) : null
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

    distance(km) {
      if (!Number.isFinite(km)) {
        return '—'
      } else if (km >= 1e9) {
        return `${this.count(km / 1e9, 2)} bn km`
      } else if (km >= 1e6) {
        return `${this.count(km / 1e6, 1)} M km`
      }

      return `${this.count(km)} km`
    },

    // A leg's jumps, distance and time, or nothing for one with no route.
    figures(leg) {
      if (!leg.route) {
        return ''
      }

      return `${leg.route.jumps} ${leg.route.jumps === 1 ? 'jump' : 'jumps'} · ${this.distance(leg.route.km)} · ${this.timeText(leg.route.km)}`
    },

    legTitle(index) {
      const leg = this.plan.legs[index]

      return leg ? `${leg.from.name} → ${leg.to.name}${leg.closing ? ', back to the start' : ''}` : ''
    },

    legFigures(index) {
      const leg = this.plan.legs[index]

      return leg ? this.figures(leg) || 'No explored route' : ''
    },

    systemNameOf(systemId) {
      return (this.systemById[systemId] || {}).Name || `System #${systemId}`
    },

    // A jump point by the system it leads to, as the game names them; the leg's ends by their names. `end` is which end of a flight inside a system the point is: the route's searches are shared between legs that start in the same place, so a point is told by the end it is, not by being the leg's own start.
    pointName(point, leg, end) {
      if (point.WarpPointID) {
        const partner = this.jumpPointById[point.WPLink]

        return partner ? `Jump point to ${this.systemNameOf(partner.SystemID)}` : 'Jump point'
      }

      if (end === 'from') {
        return leg.from.kind === 'system' ? (leg.start.Xcor === 0 && leg.start.Ycor === 0 ? 'System centre' : 'Where the route arrived') : leg.from.name
      }

      return leg.to.name
    },

    lagrangeName(point) {
      return systemBodyName(point, { Name: point.SystemName })
    },

    // A name split before its last word, so an icon after it wraps with that word.
    lastWord(text) {
      const at = text.lastIndexOf(' ') + 1

      return [text.slice(0, at), text.slice(at)]
    },

    // What keeps a leg from its start to its end out of reach with these options, when a route without them reaches it.
    legNote(leg) {
      if (leg.unavailable) {
        const stops = [leg.from, leg.to].filter((stop) => stop.unavailable)
        const names = joinLabels(stops.map((stop) => `stop ${stop.stopIndex + 1}`))
        const verb = stops.length > 1 ? 'are' : 'is'

        return stops.some((stop) => stop.reading) ? `${names} ${verb} being read` : `${names} ${verb} not available`
      }

      const { to, start } = leg
      const reason = to.SystemID !== start.SystemID && this.avoidReasons[to.SystemID]

      if (reason) {
        return `${this.systemNameOf(to.SystemID)} is avoided: ${reason}`
      }

      const open = searchRoutes(this.jumpPoints, [start], { order: this.order, lagrangePoints: this.options.useLagrange ? this.lagrangePoints : [] })
      const found = to.kind === 'system' ? open.toSystem(to.SystemID) : open.toPlace(to)
      const blockers = found ? this.blockers(found) : []

      return blockers.length ? `kept out of reach by the options: ${blockers.length > 3 ? `${blockers.slice(0, 3).join(', ')} and ${blockers.length - 3} more` : joinLabels(blockers)}` : ''
    },

    // What the options would stop on a route found without them: systems they avoid, and jump points they don't transit, in route order.
    blockers(route) {
      const { gatesOnly, civilian } = this.options
      const found = []

      routeLegs(route).forEach((leg) => {
        if (leg.kind !== 'jump') {
          return
        }

        if (gatesOnly && !(leg.from.JumpGateStrength > 0)) {
          found.push(`the ${Number.isFinite(leg.from.JumpGateStrength) ? 'unstabilised' : 'unrecorded'} jump point in ${this.systemNameOf(leg.from.SystemID)}`)
        } else if (civilian && !this.transit.canTransit(leg.from)) {
          found.push(`the ${leg.from.MilitaryRestricted === null || leg.from.MilitaryRestricted === undefined ? 'unrecorded' : 'military restricted'} jump point in ${this.systemNameOf(leg.from.SystemID)}`)
        }

        const reason = this.avoidReasons[leg.to.SystemID]

        if (reason) {
          found.push(`${this.systemNameOf(leg.to.SystemID)} (${reason})`)
        }
      })

      return [...new Set(found)]
    },
  },
  asyncComputed: {
    // The known systems with what the avoid options look at: the danger rating against the protection value of the race's own ships there (the game counts every fleet present, which fog of war hides), and the controlling race with the race's trade treaty, if any.
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.DangerRating, FCT_RaceSysSurvey.NoAutoRoute, FCT_RaceSysSurvey.MilitaryRestrictedSystem, FCT_RaceSysSurvey.ControlRaceID is not null as ControlKnown, case when FCT_RaceSysSurvey.ControlRaceID is null or FCT_RaceSysSurvey.ControlRaceID in (0, ${this.RaceID}) then null else coalesce((select FCT_AlienRace.AlienRaceName from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}), 'an unknown race') end as Controller, case when exists (select 1 from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}) then (select FCT_AlienRace.TradeTreaty from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}) else 0 end as TradeTreaty, VIR_Protection.Protection, coalesce(VIR_Protection.ProtectionShips, 0) as ProtectionShips, coalesce(VIR_Protection.ProtectionKnown, 0) as ProtectionKnown from FCT_RaceSysSurvey left join (select FCT_Fleet.SystemID, sum(FCT_ShipClass.ProtectionValue) as Protection, count(FCT_Ship.ShipID) as ProtectionShips, count(FCT_ShipClass.ProtectionValue) as ProtectionKnown from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.RaceID = ${this.RaceID} and FCT_Fleet.GameID = ${this.GameID} group by FCT_Fleet.SystemID) as VIR_Protection on VIR_Protection.SystemID = FCT_RaceSysSurvey.SystemID where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
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
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} order by FCT_Population.Capital desc, FCT_Population.Population desc, FCT_Population.PopName`).then(([items]) => items)
      }),
      default: [],
    },
    // The race's own fleets with ships in known systems, with their movement settings and `CanTransit`, whether the fleet's jump drives carry its ships through a jump point that is not stabilised (`fleetCanTransit`, which reads every ship of the fleet).
    fleets: {
      get: tracked('fleets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [[fleets], [ships]] = await Promise.all([
          this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.Speed, FCT_Fleet.AvoidDanger, FCT_Fleet.AvoidAlienSystems, count(FCT_Ship.ShipID) as Ships from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_Fleet.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} group by FCT_Fleet.FleetID order by FCT_Fleet.FleetName`),
          this.database.query(`select FCT_Ship.FleetID, FCT_Ship.MothershipID, FCT_ShipClass.Size, FCT_ShipClass.MilitaryEngines, ${JUMP_DRIVE_COLUMNS} from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}`),
        ])
        const shipsByFleet = groupBy(ships, 'FleetID')

        return Object.freeze(fleets.map((fleet) => ({ ...fleet, CanTransit: fleetCanTransit(shipsByFleet[fleet.FleetID] || []) })))
      }),
      default: [],
    },
    classes: {
      get: tracked('classes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.MaxSpeed, FCT_ShipClass.JumpRating, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID} and FCT_ShipClass.MaxSpeed > 1 group by FCT_ShipClass.ShipClassID`).then(([items]) => items)
      }),
      default: [],
    },
    // Stable Lagrange points in the known systems, with the planet each sits by. They belong to no race.
    lagrangePoints: {
      get: tracked('lagrangePoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_LagrangePoint.LagrangePointID, FCT_LagrangePoint.SystemID, FCT_LagrangePoint.Xcor, FCT_LagrangePoint.Ycor, FCT_LagrangePoint.Distance, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_LagrangePoint inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_LagrangePoint.PlanetID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_LagrangePoint.PlanetID and FCT_SystemBodyName.RaceID = ${this.RaceID} and FCT_SystemBodyName.GameID = ${this.GameID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_LagrangePoint.GameID = ${this.GameID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The waypoints, wrecks, life pods, contacts and aether gates of the known systems.
    smallPlaces: {
      get: tracked('smallPlaces', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadSmallPlaces(this.database, this.context, this.count)
      }),
      default: [],
    },
    // How many bodies of each kind and survey locations the known systems hold.
    placeCounts: {
      get: tracked('placeCounts', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await countLargePlaces(this.database, this.context)
      }),
      default: {},
    },
  },
}
</script>

<style lang="scss">
.routes-page {
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

  .tool--actions {
    align-self: flex-end;
  }

  .tool--speed {
    flex: 0 0 180px;
  }

  .toolbar .v-btn-toggle .v-btn,
  .tool--actions .v-btn {
    height: 40px !important;
  }

  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  .panel {
    margin-top: 8px;
  }

  > .panel {
    margin-top: 20px;
  }

  .line {
    display: inline-block;
    width: 18px;
    height: 4px;
    border-radius: 2px;
    margin-right: 6px;
  }

  // A long jump point name wraps beside its arrow.
  .leg-next {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .leg-next > .v-icon {
    flex: none;
  }

  .clickable-rows tbody tr {
    cursor: pointer;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
