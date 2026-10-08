<template>
  <div>
    <v-container fluid class="routes-page">
      <v-alert v-if="failedInputs.length" type="error" outlined dense>
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate />

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
            <v-autocomplete :value="destination && destination.key" :items="places" item-text="name" item-value="key" :filter="filterPlace" aria-label="To" placeholder="A system, colony or fleet" dense outlined hide-details clearable auto-select-first @change="setTo">
              <template #item="{ item }">
                <v-icon small class="mr-3">{{ item.icon }}</v-icon>
                <v-list-item-content>
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.subtitle }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool">
            <div class="tool__label caption text--secondary">Route</div>
            <v-btn-toggle v-model="order" mandatory dense @change="(value) => config.set('routesOrder', value)">
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
            <v-text-field v-model.number="speed" type="number" min="1" :placeholder="String(effectiveSpeed)" suffix="km/s" aria-label="Speed in km/s" dense outlined hide-details @change="saveSpeed">
              <template #append>
                <v-menu offset-y left max-height="420">
                  <template #activator="{ on, attrs }">
                    <v-icon small title="Use a ship class's speed" v-bind="attrs" v-on="on">mdi-rocket-launch-outline</v-icon>
                  </template>
                  <v-list dense>
                    <v-subheader>Speed of a class in service</v-subheader>
                    <v-list-item v-for="shipClass in classOptions" :key="shipClass.ShipClassID" @click="useSpeed(shipClass.MaxSpeed)">
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
                <v-checkbox v-for="option in optionList" :key="option.key" v-model="options[option.key]" dense hide-details @change="(value) => config.set(option.config, !!value)">
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

        <v-row class="mt-1">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value">{{ tile.value }}</div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <v-row>
          <v-col cols="12" :xl="legRows.length ? 7 : 12">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>Route map</span>
                <span class="legend">
                  <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />From and To</span>
                  <span class="legend-item"><span class="line" :style="{ background: colors.route }" />Route</span>
                  <span class="legend-item"><span class="dot" :style="{ background: colors.near }" /><span class="dot" :style="{ background: withAlpha(colors.near, 0.35) }" />Near to far</span>
                  <span class="legend-item"><span class="dot" :style="{ background: colors.avoided }" />Avoided</span>
                  <span class="legend-item"><span class="dot" :style="{ background: colors.out }" />Out of reach</span>
                </span>
              </div>
              <div class="panel-body">
                <system-map :systems="mapNodes" :links="links" :route="routeSystems" :route-color="colors.route" :selected="destination ? destination.SystemID : null" aria-label="Known systems by distance from the origin, with the route" @select="(systemId) => setTo(`system:${systemId}`)" />
                <div class="caption text--secondary">Positions as on the game's galactic map. Click a system to route there.</div>
              </div>
            </v-card>
          </v-col>
          <v-col v-if="legRows.length" cols="12" xl="5">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>{{ origin.name }} to {{ destination.name }}</span>
              </div>
              <v-data-table :headers="legHeaders" :items="legRows" item-key="index" disable-pagination disable-sort hide-default-footer dense>
                <template #[`item.SystemName`]="{ item }">
                  <span class="font-weight-medium text-no-wrap">{{ item.SystemName }}</span>
                </template>
                <template #[`item.way`]="{ item }">
                  <div class="py-1">
                    <div>{{ item.from }}</div>
                    <div class="text-no-wrap">
                      <v-icon x-small>mdi-arrow-right</v-icon>
                      {{ item.to }}
                      <v-icon v-if="item.gate" x-small :color="colors.route" title="A jump gate: ships without a jump drive can transit">mdi-gate</v-icon>
                    </div>
                    <div v-if="item.via" class="caption text--secondary">Lagrange jump from {{ item.via[0] }} to {{ item.via[1] }}</div>
                  </div>
                </template>
                <template #[`item.km`]="{ item }"><span class="text-no-wrap">{{ distance(item.km) }}</span></template>
                <template #[`item.total`]="{ item }"><span class="text-no-wrap">{{ distance(item.total) }}</span></template>
                <template #[`item.time`]="{ item }"><span class="text-no-wrap">{{ travelTime(item.total) }}</span></template>
              </v-data-table>
              <div class="panel-foot caption text--secondary">Times are flying at {{ count(effectiveSpeed) }} km/s. Jumps take no time here; the jump shock after each and nebula speed limits are left out. Bodies and fleets are where the save has them now.</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Distances from {{ origin ? origin.name : '—' }}</span>
            <v-text-field v-model="search" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <v-data-table :headers="distanceHeaders" :items="distanceRows" item-key="SystemID" :search="search" :custom-filter="filterSystem" :sort-by.sync="sortBy" :sort-desc.sync="sortDesc" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" :items-per-page="15" class="clickable-rows" @click:row="(row) => setTo(`system:${row.SystemID}`)">
            <template #[`item.Name`]="{ item }">
              <span class="font-weight-medium">{{ item.Name }}</span>
            </template>
            <template #[`item.jumpsSort`]="{ item }">{{ item.route ? item.route.jumps : '—' }}</template>
            <template #[`item.kmSort`]="{ item }">{{ item.route ? distance(item.route.km) : '—' }}</template>
            <template #[`item.time`]="{ item }">{{ item.route ? travelTime(item.route.km) : '—' }}</template>
            <template #[`item.status`]="{ item }">
              <span :class="{ 'text--secondary': !item.reason }">{{ item.status }}</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            To a system, routes end at the jump point they arrive through; from a system, they start at its centre, as the galactic map measures. Only jump points your race has explored are used. Click a row to route there.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { chartTheme, withAlpha } from '../components/charts/theme'
import SystemMap from '../components/exploration/SystemMap.vue'
import countFormat from '../mixins/count-format'
import { systemBodyName } from '../utilities/aurora'
import { jumpLinks, KM_PER_AU, loadJumpPoints, routeLegs, searchRoutes } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  colonies: 'your colonies',
  fleets: 'your fleets',
  classes: 'your ship classes',
  lagrangePoints: 'the Lagrange points',
}
const INPUTS = Object.keys(INPUT_LABELS)
const SECONDS_PER_DAY = 86400

// A fleet's movement settings, as the game's auto-route applies them (Fleet.FindNearestAutoRouteDestination,
// RaceSysSurvey.GetAdjacentExploredSystemsForAutoRoute). None of them keeps a route from leaving its origin.
const OPTIONS = [
  { key: 'avoidDanger', config: 'routesAvoidDanger', default: true, label: 'Avoid danger', hint: 'Skips systems with a danger rating your ships there don\'t outweigh in protection value.' },
  { key: 'avoidAlien', config: 'routesAvoidAlien', default: false, label: 'Avoid alien systems', hint: 'Skips systems controlled by a race you have no trade treaty with.' },
  { key: 'skipNoAutoRoute', config: 'routesSkipNoAutoRoute', default: false, label: 'Skip "no auto-route" systems', hint: 'Skips the systems you flagged to keep auto-routes out.' },
  { key: 'civilian', config: 'routesCivilian', default: false, label: 'Civilian shipping', hint: 'Keeps out of military restricted systems and jump points, as shipping lines do.' },
  { key: 'gatesOnly', config: 'routesGatesOnly', default: false, label: 'Jump gates only', hint: 'For ships without a jump drive: transits only where the jump point has a gate on the near side.' },
  { key: 'useLagrange', config: 'routesUseLagrange', default: true, label: 'Use Lagrange points', hint: 'Jumps between stable Lagrange points inside a system when that is shorter, as fleets do unless told not to.' },
]

export default {
  name: 'RoutesPage',
  components: { SystemMap },
  mixins: [countFormat],
  data() {
    return {
      fromKey: null,
      toKey: null,
      order: 'jumps',
      speed: null,
      options: Object.fromEntries(OPTIONS.map((option) => [option.key, option.default])),
      optionList: OPTIONS,
      search: '',
      sortBy: ['jumpsSort'],
      sortDesc: [false],
      loadErrors: {},
      orders: [
        { value: 'jumps', label: 'Fewest jumps', hint: 'The game\'s auto-route: the fewest transits, then the shorter way.' },
        { value: 'km', label: 'Shortest', hint: 'The fewest kilometres, as the galactic map\'s distances measure.' },
      ],
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    colors() {
      const [blue, , green] = this.theme.categorical

      return { near: blue, route: green, avoided: this.theme.categorical[7], out: withAlpha(this.theme.inkMuted, 0.35) }
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

    links() {
      return jumpLinks(this.jumpPoints)
    },

    systemById() {
      return Object.fromEntries(this.systems.map((system) => [system.SystemID, system]))
    },

    jumpPointById() {
      return Object.fromEntries(this.jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
    },

    // Where a route can start or end: colonies and fleets at their places in the system, systems at their centre.
    places() {
      const systemName = (systemId) => (this.systemById[systemId] || {}).Name || ''

      return [
        ...this.colonies.map((colony) => ({
          key: `colony:${colony.PopulationID}`,
          kind: 'colony',
          name: colony.PopName,
          subtitle: `Colony in ${systemName(colony.SystemID)}${colony.Capital ? ', capital' : ''}`,
          icon: colony.Capital ? 'mdi-star-circle-outline' : 'mdi-earth',
          SystemID: colony.SystemID,
          Xcor: colony.Xcor,
          Ycor: colony.Ycor,
          Capital: colony.Capital,
        })),
        ...this.fleets.map((fleet) => ({
          key: `fleet:${fleet.FleetID}`,
          kind: 'fleet',
          name: fleet.FleetName,
          subtitle: `Fleet in ${systemName(fleet.SystemID)}, ${this.count(fleet.Speed)} km/s, ${fleet.Ships} ${fleet.Ships === 1 ? 'ship' : 'ships'}`,
          icon: 'mdi-rocket-outline',
          SystemID: fleet.SystemID,
          Xcor: fleet.Xcor,
          Ycor: fleet.Ycor,
          fleet,
        })),
        ...this.systems.slice().sort((a, b) => a.Name.localeCompare(b.Name)).map((system) => ({
          key: `system:${system.SystemID}`,
          kind: 'system',
          name: system.Name,
          subtitle: 'System',
          icon: 'mdi-white-balance-sunny',
          SystemID: system.SystemID,
          Xcor: 0,
          Ycor: 0,
        })),
      ].map((place) => ({ ...place, text: `${place.name} ${systemName(place.SystemID)}`.toLowerCase() }))
    },

    placeByKey() {
      return Object.fromEntries(this.places.map((place) => [place.key, place]))
    },

    // The saved origin, else the capital.
    origin() {
      return this.placeByKey[this.fromKey] || this.places.find((place) => place.Capital) || this.places[0] || null
    },

    destination() {
      return this.placeByKey[this.toKey] || null
    },

    // Classes in service that move, fastest first, for the speed menu; their median speed until one is picked.
    classOptions() {
      return this.classes.slice().sort((a, b) => b.MaxSpeed - a.MaxSpeed)
    },

    effectiveSpeed() {
      if (this.speed > 0) {
        return this.speed
      }

      const speeds = this.classOptions.map((shipClass) => shipClass.MaxSpeed)

      return speeds.length ? speeds[Math.floor(speeds.length / 2)] : 1000
    },

    activeOptionCount() {
      return OPTIONS.filter((option) => this.options[option.key] !== option.default).length
    },

    // Why a route may not enter each system, or nothing.
    avoidReasons() {
      const reasons = {}

      this.systems.forEach((system) => {
        if (this.options.skipNoAutoRoute && system.NoAutoRoute) {
          reasons[system.SystemID] = 'No auto-route'
        } else if (this.options.avoidDanger && system.DangerRating > 0 && (system.Protection || 0) <= system.DangerRating) {
          reasons[system.SystemID] = `Danger rating ${this.count(system.DangerRating)}`
        } else if (this.options.avoidAlien && system.Controller && !system.TradeTreaty) {
          reasons[system.SystemID] = `Held by ${system.Controller}`
        } else if (this.options.civilian && system.MilitaryRestrictedSystem) {
          reasons[system.SystemID] = 'Military restricted'
        }
      })

      return reasons
    },

    routes() {
      if (!this.origin) {
        return null
      }

      const { gatesOnly, civilian, useLagrange } = this.options

      return searchRoutes(this.jumpPoints, [this.origin], {
        order: this.order,
        canTransit: (jumpPoint) => (!gatesOnly || jumpPoint.JumpGateStrength > 0) && (!civilian || !jumpPoint.MilitaryRestricted),
        canEnter: (systemId) => !this.avoidReasons[systemId],
        lagrangePoints: useLagrange ? this.lagrangePoints : [],
      })
    },

    route() {
      if (!this.routes || !this.destination) {
        return null
      }

      return this.destination.kind === 'system' ? this.routes.toSystem(this.destination.SystemID) : this.routes.toPlace(this.destination)
    },

    legs() {
      return this.route ? routeLegs(this.route) : []
    },

    // The systems the route passes through, in order, for the map.
    routeSystems() {
      if (!this.route) {
        return []
      }

      return [this.origin.SystemID, ...this.legs.filter((leg) => leg.kind === 'jump').map((leg) => leg.to.SystemID)]
    },

    // One row per system on the route: where it comes in, where it leaves, and the distance flown there.
    legRows() {
      const rows = []
      let total = 0

      this.legs.forEach((leg) => {
        if (leg.kind === 'fly') {
          total += leg.km
          rows.push({
            index: rows.length,
            SystemName: this.systemNameOf(leg.SystemID),
            from: this.pointName(leg.from),
            to: this.pointName(leg.to),
            gate: Boolean(leg.to.WarpPointID && leg.to.JumpGateStrength > 0),
            via: leg.via && leg.via.map((point) => this.lagrangeName(point)),
            km: leg.km,
            total,
          })
        }
      })

      const last = this.legs[this.legs.length - 1]

      if (last && last.kind === 'jump') {
        rows.push({ index: rows.length, SystemName: this.systemNameOf(last.to.SystemID), from: this.pointName(last.to), to: 'Arrived', gate: false, via: null, km: 0, total })
      }

      return rows
    },

    distanceRows() {
      if (!this.routes) {
        return []
      }

      return this.systems.map((system) => {
        const route = this.routes.toSystem(system.SystemID)
        const isOrigin = this.origin && system.SystemID === this.origin.SystemID
        const reason = isOrigin ? null : this.avoidReasons[system.SystemID] || null

        return {
          ...system,
          route,
          reason,
          jumpsSort: route ? route.jumps : Infinity,
          kmSort: route ? route.km : Infinity,
          status: isOrigin ? 'Origin' : route ? 'Reachable' : reason ? `Avoided: ${reason}` : 'Out of reach',
        }
      })
    },

    mapNodes() {
      const onRoute = new Set(this.routeSystems)
      const ends = new Set([this.origin && this.origin.SystemID, this.destination && this.destination.SystemID])
      const reachable = this.distanceRows.filter((row) => row.route)
      const farthest = Math.max(1, ...reachable.map((row) => (this.order === 'jumps' ? row.route.jumps : row.route.km)))

      return this.distanceRows.map((row) => {
        const end = ends.has(row.SystemID)
        const reach = row.route ? (this.order === 'jumps' ? row.route.jumps : row.route.km) / farthest : null

        return {
          SystemID: row.SystemID,
          Name: row.Name,
          Xcor: row.Xcor,
          Ycor: row.Ycor,
          rank: end ? 3 : onRoute.has(row.SystemID) ? 2 : row.route ? 1 : 0,
          size: end ? 7 : onRoute.has(row.SystemID) ? 5 : 3.5,
          color: row.route ? withAlpha(this.colors.near, 1 - 0.65 * reach) : row.reason ? this.colors.avoided : this.colors.out,
          ring: end ? this.theme.ink : null,
          label: end,
          title: `${row.Name}: ${row.route ? `${row.route.jumps} ${row.route.jumps === 1 ? 'jump' : 'jumps'}, ${this.distance(row.route.km)}, ${this.travelTime(row.route.km)}` : row.status}`,
        }
      }).sort((a, b) => a.rank - b.rank)
    },

    tiles() {
      const reachable = this.distanceRows.filter((row) => row.route).length
      const avoided = this.distanceRows.filter((row) => row.reason).length
      const out = this.distanceRows.length - reachable - avoided
      const route = this.route
      const gates = this.legs.filter((leg) => leg.kind === 'jump' && leg.from.JumpGateStrength > 0).length
      const lagrange = this.legs.filter((leg) => leg.via).length
      const noRoute = this.destination ? (this.avoidReasons[this.destination.SystemID] ? `Avoided: ${this.avoidReasons[this.destination.SystemID]}` : 'Nothing reaches it with these options') : 'Pick a destination above, on the map or in the table'

      return [
        {
          label: 'Jumps',
          value: route ? this.count(route.jumps) : this.destination ? 'No route' : '—',
          note: route ? `${gates} through jump gates${lagrange ? `, Lagrange jumps in ${lagrange} ${lagrange === 1 ? 'system' : 'systems'}` : ''}` : noRoute,
        },
        {
          label: 'Distance',
          value: route ? this.distance(route.km) : '—',
          note: route ? `${this.count(route.km / KM_PER_AU, 1)} AU` : '',
        },
        {
          label: 'Travel time',
          value: route ? this.travelTime(route.km) : '—',
          note: `At ${this.count(this.effectiveSpeed)} km/s`,
        },
        {
          label: 'Reachable systems',
          value: `${this.count(reachable)} of ${this.count(this.distanceRows.length)}`,
          note: `${avoided} avoided, ${out} out of reach`,
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
    // From, To and speed are kept per game and race; the options apply to every game.
    RaceID: {
      immediate: true,
      handler() {
        this.fromKey = this.config.get(`${this.settingsPrefix}.routesFrom`, null)
        this.toKey = this.config.get(`${this.settingsPrefix}.routesTo`, null)
        this.speed = this.config.get(`${this.settingsPrefix}.routesSpeed`, null)
      },
    },
  },
  created() {
    this.order = this.config.get('routesOrder', 'jumps')
    OPTIONS.forEach((option) => {
      this.options[option.key] = this.config.get(option.config, option.default)
    })
  },
  methods: {
    withAlpha,

    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    filterPlace(item, query) {
      return item.text.includes(query.toLowerCase())
    },

    filterSystem(_value, query, item) {
      return item.Name.toLowerCase().includes(query.toLowerCase())
    },

    // A fleet as origin brings its speed and movement settings.
    setFrom(key) {
      if (!key) {
        return
      }

      this.fromKey = key
      this.config.set(`${this.settingsPrefix}.routesFrom`, key)

      const place = this.placeByKey[key]

      if (place && place.fleet) {
        this.useSpeed(place.fleet.Speed)
        this.setOption('avoidDanger', Boolean(place.fleet.AvoidDanger))
        this.setOption('avoidAlien', Boolean(place.fleet.AvoidAlienSystems))
        this.setOption('gatesOnly', !place.fleet.JumpRating)
      }
    },

    setTo(key) {
      this.toKey = key || null
      this.config.set(`${this.settingsPrefix}.routesTo`, this.toKey)
    },

    swap() {
      const from = this.origin.key

      this.setFrom(this.destination.key)
      this.setTo(from)
    },

    setOption(key, value) {
      this.options[key] = value
      this.config.set(OPTIONS.find((option) => option.key === key).config, value)
    },

    useSpeed(speed) {
      this.speed = speed
      this.saveSpeed()
    },

    saveSpeed() {
      this.config.set(`${this.settingsPrefix}.routesSpeed`, this.speed > 0 ? this.speed : null)
    },

    // Flying time at the chosen speed, in the unit that reads best; nothing to fly is no time.
    travelTime(km) {
      return km > 0 ? this.duration(km / this.effectiveSpeed / SECONDS_PER_DAY) : '—'
    },

    distance(km) {
      if (km >= 1e9) {
        return `${this.count(km / 1e9, 2)} bn km`
      } else if (km >= 1e6) {
        return `${this.count(km / 1e6, 1)} M km`
      }

      return `${this.count(km)} km`
    },

    systemNameOf(systemId) {
      return (this.systemById[systemId] || {}).Name || `System #${systemId}`
    },

    // A jump point by the system it leads to, as the game names them; the origin or destination by its name.
    pointName(point) {
      if (point.WarpPointID) {
        const partner = this.jumpPointById[point.WPLink]

        return partner ? `Jump point to ${this.systemNameOf(partner.SystemID)}` : 'Jump point'
      }

      return point.kind === 'system' ? 'System centre' : point.name
    },

    lagrangeName(point) {
      return systemBodyName(point, { Name: point.SystemName })
    },
  },
  asyncComputed: {
    // The known systems with what the avoid options look at: the danger rating against the protection value of
    // your own ships there (the game counts every fleet present, which fog of war hides), and the controlling race
    // with your trade treaty, if any.
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.DangerRating, FCT_RaceSysSurvey.NoAutoRoute, FCT_RaceSysSurvey.MilitaryRestrictedSystem, case when FCT_RaceSysSurvey.ControlRaceID in (0, ${this.RaceID}) then null else coalesce((select FCT_AlienRace.AlienRaceName from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}), 'an unknown race') end as Controller, coalesce((select FCT_AlienRace.TradeTreaty from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}), 0) as TradeTreaty, (select sum(FCT_ShipClass.ProtectionValue) from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Fleet.RaceID = ${this.RaceID} and FCT_Fleet.GameID = ${this.GameID}) as Protection from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => items)
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
    // Your own fleets that move, without the shipping lines', with their movement settings and whether any ship
    // carries a jump drive.
    fleets: {
      get: tracked('fleets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.Speed, FCT_Fleet.AvoidDanger, FCT_Fleet.AvoidAlienSystems, max(FCT_ShipClass.JumpRating) as JumpRating, count(FCT_Ship.ShipID) as Ships from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_Fleet.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} and FCT_Fleet.ShippingLine = 0 and FCT_Fleet.Speed > 1 group by FCT_Fleet.FleetID order by FCT_Fleet.FleetName`).then(([items]) => items)
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

        return await this.database.query(`select FCT_LagrangePoint.LagrangePointID, FCT_LagrangePoint.SystemID, FCT_LagrangePoint.Xcor, FCT_LagrangePoint.Ycor, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_LagrangePoint inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_LagrangePoint.PlanetID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_LagrangePoint.PlanetID and FCT_SystemBodyName.RaceID = ${this.RaceID} and FCT_SystemBodyName.GameID = ${this.GameID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_LagrangePoint.GameID = ${this.GameID}`).then(([items]) => items)
      }),
      default: [],
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

  .tool--place {
    flex: 1 1 240px;
    max-width: 420px;
  }

  .tool--swap,
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
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
  }

  .dot-ring {
    background: transparent;
    border: 2px solid;
  }

  .line {
    display: inline-block;
    width: 18px;
    height: 4px;
    border-radius: 2px;
    margin-right: 6px;
  }

  .clickable-rows tbody tr {
    cursor: pointer;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
