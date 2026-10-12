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
        </div>

        <stat-tiles :tiles="tiles" class="mt-1" />

        <v-alert v-if="!destination" type="info" dense outlined class="mt-4 mb-0">Pick a destination to see what my fleets could move there.</v-alert>
        <v-alert v-for="problem in problems" :key="problem.text" type="warning" dense outlined class="mt-4 mb-0">{{ problem.text }}</v-alert>

        <v-card class="panel" data-summary="How long each of my fleets would take to sail the chosen run and how much it could carry. Use it to pick the best ships for a haul between two places." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Fleets on this run</span>
              <v-chip v-if="destination" small class="ml-3">{{ origin.name }} → {{ destination.name }}</v-chip>
              <page-link v-if="destination" class="ml-1" :to="routesLink" :name="`${origin.name} to ${destination.name}`" />
            </span>
          </div>
          <v-data-table :headers="classHeaders" :items="rows" item-key="key" :sort-by.sync="classesTable.sortBy" :sort-desc.sync="classesTable.sortDesc" :items-per-page.sync="classesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="noRowsText">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.ClassName }}</div>
              </div>
            </template>
            <template #[`item.ships`]="{ item }">{{ count(item.ships) }}</template>
            <template #[`item.cargo`]="{ item }"><span class="text-no-wrap">{{ item.cargo ? `${count(item.cargo)} t` : '—' }}</span></template>
            <template #[`item.colonists`]="{ item }"><span class="text-no-wrap">{{ item.colonists ? count(item.colonists) : '—' }}</span></template>
            <template #[`item.speed`]="{ item }"><span class="text-no-wrap">{{ count(item.speed) }} km/s</span></template>
            <template #[`item.tripDays`]="{ item }">
              <div v-if="item.status === 'ok' || item.status === 'range'" class="py-2 text-no-wrap" :title="tripTitle(item)">
                <div>{{ duration(item.tripSeconds / SECONDS_PER_DAY) }}</div>
                <div class="caption text--secondary">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }} · {{ distance(item.km) }}</div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.trips`]="{ item }"><span v-if="item.trips" class="text-no-wrap">{{ count(item.trips, 1) }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.tonsYear`]="{ item }"><span v-if="item.tonsYear" class="text-no-wrap">{{ count(item.tonsYear) }} t</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonistsYear`]="{ item }"><span v-if="item.colonistsYear" class="text-no-wrap">{{ count(item.colonistsYear) }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.fuel`]="{ item }">
              <div v-if="item.fuel" class="py-2 text-no-wrap">
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
          </v-data-table>
          <div class="panel-foot caption text--secondary">Each class in a fleet is timed as if it sailed alone: the round trip is twice the route at its top speed, plus loading cargo and colonists at the origin and unloading them at the destination, each stop taking its slowest ship. Loading takes 20 s per ton and 10 s per colonist, divided by the shuttle bays (one for a craft of 500 t or less, which lands) plus one if the colony has a spaceport or cargo shuttle station, times the race's shuttle technology; commander and governor Logistics bonuses are not counted, so times err long. Ships without a jump drive that covers their size use only jump points stabilised on both sides; the rest use any jump point I have explored. The route is the fewest jumps, with Lagrange jumps unless turned off, and does not avoid dangerous or alien systems. Jump shock and nebula speed limits are left out. The cargo is assumed ready at the origin and accepted at the destination. The run must fit in one tank: refuelling needs an order and a refuelling station, so no time for it is counted. Shipping line ships, in the Civilian tile, are timed the same way but without that fuel limit. A system stands in as a colony site at its star, without a station. Fuel burns at engine power times fuel consumption per hour at full speed.</div>
        </v-card>

        <v-card class="panel" data-summary="The installations my colonies offer and ask for, and how much of each is already on its way. Use it to see what civilian shipping lines are carrying." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Civilian work orders</span>
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
import { mapGetters } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import { linkTo, queryPlaceKeys } from '../utilities/deep-links'
import { loadJumpPoints, searchRoutes } from '../utilities/jump-graph'
import { joinLabels, tracked } from '../utilities/load-tracking'
import { colonyPlaces, filterPlace, searchable, systemPlaces } from '../utilities/places'
import { fleetCanTransit, roundTrip, routeBlockers, transitRule } from '../utilities/transport'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  lagrangePoints: 'the Lagrange points',
  colonies: 'my colonies',
  ships: 'my ships',
  requests: 'the installation requests',
  shipments: 'the installations in transit',
}
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
  noroute: { label: 'No route', icon: 'mdi-close-circle-outline', color: 'error' },
  none: { label: 'Nothing to move', icon: 'mdi-close-circle-outline', color: 'error' },
}

// Up to three names, then how many more.
const nameList = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : joinLabels(names))

const unique = (values) => [...new Set(values)]

export default {
  name: 'TransportPage',
  components: { LoadState, PageLink, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      fromKey: { key: 'transportFrom', default: null, scope: 'race' },
      toKey: { key: 'transportTo', default: null, scope: 'race' },
      fleetIds: { key: 'transportFleets', default: [], scope: 'race', valid: (value) => Array.isArray(value) },
      ...OPTION_FIELDS,
      ordersSearch: { key: 'transportOrdersSearch', default: '', scope: 'race' },
      classesTable: tableView('transportClassesTable', { sortBy: ['tonsYear'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      ordersTable: tableView('transportOrdersTable', { sortBy: ['demand'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      optionList: OPTIONS,
      pageSizes: PAGE_SIZES,
      STATUS,
      SECONDS_PER_DAY,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'CivilianShippingLinesActive']),

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

    // Where each kind of ship can go from the origin: `reachOf(group)` gives { route, open, blockers }, the route its profile can sail, the route without any rule, and what its rules stop on that one.
    reachOf() {
      const { jumpPoints, jumpPointById, restricted, origin, destination, gatesOnly, systemById } = this
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
          const route = find(profile)
          const open = route || find({ gates: false, civilian: false })

          reaches[key] = { route, open, profile, blockers: route || !open ? [] : routeBlockers(open, profile, restricted, systemName) }
        }

        return reaches[key]
      }
    },

    stations() {
      const has = (place) => Boolean(place && place.kind === 'colony' && place.colony.ShuttleCapacity >= 1)

      return { origin: has(this.origin), destination: has(this.destination) }
    },

    // One entry per class in each fleet that is picked (every shipping line fleet too, while shipping lines are on), timed on its own.
    runs() {
      const { reachOf, stations, destination } = this
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

        group.classes.forEach((shipClass) => runs.push(this.runOf(group, shipClass, reach, stations)))
      })

      return runs
    },

    rows() {
      return this.runs.filter((run) => !run.civilian)
    },

    civilianRuns() {
      return this.runs.filter((run) => run.civilian)
    },

    // What keeps fleets from the destination, said once for the fleets it stops.
    problems() {
      const byNote = new Map()

      this.rows.filter((row) => row.status === 'noroute').forEach((row) => {
        byNote.set(row.note, [...(byNote.get(row.note) || []), row.FleetName])
      })

      return [...byNote].map(([note, names]) => ({ text: `${nameList(unique(names))}: ${note}` }))
    },

    noRowsText() {
      if (!this.destination) {
        return 'Pick a destination to time the run.'
      }

      return this.militaryGroups.length ? 'No picked fleet carries cargo or colonists.' : 'None of my fleets has cargo holds or colony bays.'
    },

    tiles() {
      const working = this.rows.filter((row) => row.status === 'ok')
      const idle = this.rows.filter((row) => row.status !== 'ok').reduce((total, row) => total + row.ships, 0)
      const sum = (list, field) => list.reduce((total, row) => total + row[field], 0)
      const trips = working.reduce((total, row) => total + row.ships * row.trips, 0)
      const shortest = Math.min(...working.map((row) => row.km))
      const longest = Math.max(...working.map((row) => row.km))
      const first = working[0]
      const idleNote = idle ? `${this.count(idle)} ${idle === 1 ? 'ship' : 'ships'} can't work the route` : ''
      const none = !this.destination ? 'Pick a destination above' : this.rows.length ? 'No picked fleet can work this route' : 'No fleet carries cargo or colonists'
      const civilian = this.civilianRuns.filter((run) => run.status === 'ok')
      const civilianShips = this.civilianRuns.reduce((total, run) => total + run.ships, 0)
      const cargo = sum(working, 'cargo')
      const colonists = sum(working, 'colonists')

      return [
        {
          label: 'Freight a year',
          value: cargo ? `${this.count(sum(working, 'tonsYear'))} t` : '—',
          note: working.length ? [cargo ? `${this.count(cargo)} t a trip in ${this.count(sum(working, 'ships'))} ships` : 'No fleet that can run has a cargo hold', idleNote].filter(Boolean).join('; ') : none,
        },
        {
          label: 'Colonists a year',
          value: colonists ? this.count(sum(working, 'colonistsYear')) : '—',
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
          note: !this.CivilianShippingLinesActive ? 'Shipping lines are not run here' : !this.destination ? 'Pick a destination above' : civilian.length ? `${this.count(sum(civilian, 'colonistsYear'))} colonists a year, from ${this.count(sum(civilian, 'ships'))} of ${this.count(civilianShips)} ships` : civilianShips ? 'None of the shipping line ships can work the route' : 'The shipping lines have no ships',
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

    // The picks the query names; one it leaves out stays as it is. They are plain keys, so a link that arrives before the places are read lands on its pair once they load.
    applyLink(query) {
      const [from] = queryPlaceKeys(query.from)
      const [to] = queryPlaceKeys(query.to)

      if (from) {
        this.fromKey = from
      }

      if (to) {
        this.toKey = to
      }
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
    runOf(group, shipClass, reach, stations) {
      const [first] = shipClass.ships
      const count = shipClass.ships.length
      const base = {
        key: `${group.FleetID}:${shipClass.ShipClassID}`,
        FleetID: group.FleetID,
        FleetName: group.FleetName,
        ClassName: shipClass.ClassName,
        civilian: group.civilian,
        ships: count,
        cargo: count * first.CargoCapacity,
        colonists: count * first.ColonistCapacity,
        speed: first.MaxSpeed,
        jumps: 0,
        km: 0,
        tripSeconds: 0,
        travelSeconds: 0,
        handlingSeconds: 0,
        tripDays: 0,
        trips: 0,
        tonsYear: 0,
        colonistsYear: 0,
        fuel: 0,
        fuelShare: 0,
        statusSort: 4,
        status: 'noroute',
        note: '',
      }

      if (!reach.route) {
        return { ...base, note: this.reachNote(group, reach) }
      }

      const trip = roundTrip(shipClass.ships, reach.route.km, stations, first.ShuttleTechnology)
      // Shipping line ships are timed without the fuel limit.
      const status = group.civilian && trip.status === 'range' ? 'ok' : trip.status
      const works = status === 'ok'
      const run = { ...base, status, jumps: reach.route.jumps, km: reach.route.km, tripSeconds: trip.tripSeconds, travelSeconds: trip.travelSeconds, handlingSeconds: trip.handlingSeconds, statusSort: works ? 0 : 1 }

      if (works) {
        return { ...run, tripDays: trip.tripSeconds / SECONDS_PER_DAY, trips: trip.trips, tonsYear: base.cargo * trip.trips, colonistsYear: base.colonists * trip.trips, fuel: trip.fuelPerShip * count, fuelShare: trip.fuelShare }
      } else if (status === 'range') {
        return { ...run, note: `A round trip needs ${this.count(trip.fuelShare * 100)}% of a tank.` }
      }

      return { ...run, note: trip.problems.length ? `${trip.problems[0].text}.` : '' }
    },

    // Why a profile of ships can't sail from the origin to the destination.
    reachNote(group, { open, blockers, profile }) {
      if (!open) {
        return 'No jump route I have explored connects them.'
      }

      const hint = !profile.gates ? '' : group.canTransit ? ' The Stabilised jump points only option is on.' : ` A jump drive that covers the ship would make it ${open.jumps} ${open.jumps === 1 ? 'jump' : 'jumps'}.`

      return `Can't pass ${nameList(blockers)}.${hint}`
    },

    tripTitle(run) {
      return `${this.duration((2 * run.km) / run.speed / SECONDS_PER_DAY)} flying at ${this.count(run.speed)} km/s, ${this.duration(run.handlingSeconds / SECONDS_PER_DAY)} loading and unloading`
    },

    // A count of installations, which shipments can split in parts.
    amount(value) {
      return value ? this.count(value, Number.isInteger(value) ? 0 : 1) : '—'
    },

    groupSummary(items) {
      const total = (field) => items.reduce((sum, item) => sum + item[field], 0)

      return `Supply ${this.amount(total('supply'))} · Demand ${this.amount(total('demand'))} · En route ${this.amount(total('out'))}`
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

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, coalesce((select sum(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.GameID = ${this.GameID}), 0) as ShuttleCapacity from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} order by FCT_Population.Capital desc, FCT_Population.Population desc, FCT_Population.PopName`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The ships of every fleet that has a hold or colony bays, with their class, the jump drives it carries (`Drive` the best ordinary one, `AnyDrive` the best of any kind, as ship sizes) and the race's shuttle technology.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipClassID, FCT_Ship.CurrentCrew, FCT_Ship.MothershipID, FCT_Fleet.FleetName, FCT_Fleet.ShippingLine, FCT_ShipClass.ClassName, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.CargoShuttleStrength, FCT_ShipClass.Size, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, FCT_ShipClass.MilitaryEngines, FCT_Race.CargoShuttleLoadModifier as ShuttleTechnology, coalesce((select max(FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 16 and FCT_ShipDesignComponents.SpecialFunction = 0), 0) as Drive, coalesce((select max(FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 16), 0) as AnyDrive from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipClass.MaxSpeed > 1 and FCT_Ship.FleetID in (select carrier.FleetID from FCT_Ship as carrier inner join FCT_ShipClass as carrierClass on carrierClass.ShipClassID = carrier.ShipClassID where carrier.GameID = ${this.GameID} and carrier.RaceID = ${this.RaceID} and (carrierClass.CargoCapacity > 0 or carrierClass.ColonistCapacity > 0)) order by FCT_Fleet.FleetName, FCT_ShipClass.ClassName`).then(([items]) => Object.freeze(items))
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
    height: 18px;
    line-height: 18px;
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
