<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <v-container v-else fluid class="survey-page">
      <v-alert v-if="failedInputs.length" type="error" outlined dense>
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate />

      <template v-if="ready">
        <v-row>
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
            <span>Survey map</span>
            <span class="legend">
              <span v-for="item in mapLegend" :key="item.key" class="legend-item"><span class="dot" :style="{ background: item.color }" />{{ item.label }}</span>
              <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Survey ships</span>
            </span>
          </div>
          <div class="panel-body">
            <svg class="survey-map" :viewBox="map.viewBox" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Known systems coloured by the survey work left">
              <g :stroke="theme.border" :stroke-width="map.unit * 0.9">
                <line v-for="link in map.links" :key="link.key" :x1="link.x1" :y1="link.y1" :x2="link.x2" :y2="link.y2" />
              </g>
              <g v-for="node in map.nodes" :key="node.SystemID" class="map-node" @click="selectSystem(node.SystemID)">
                <title>{{ node.title }}</title>
                <circle :cx="node.x" :cy="node.y" :r="node.r" :fill="node.color" :stroke="node.SystemID === selectedSystemId ? theme.primary : theme.surface" :stroke-width="map.unit * (node.SystemID === selectedSystemId ? 3 : 1)" />
                <circle v-if="node.ships" :cx="node.x" :cy="node.y" :r="node.r + map.unit * 4" fill="none" :stroke="theme.ink" :stroke-width="map.unit * 1.5" />
                <text v-if="node.label" :x="node.x" :y="node.y - node.r - map.unit * 5" :font-size="map.unit * 11" text-anchor="middle" :fill="theme.ink">{{ node.Name }}</text>
              </g>
            </svg>
            <div class="caption text--secondary">Positions as on the game's galactic map. Size shows the survey points left; click a system for its details below.</div>
          </div>
        </v-card>

        <v-card ref="systemsPanel" class="panel" elevation="1">
          <div class="panel-head">
            <span>Systems</span>
            <span class="d-flex align-center">
              <v-switch v-model="showSurveyed" label="Show fully surveyed" dense hide-details class="mt-0 mr-4" @change="(value) => config.set('surveyShowSurveyed', !!value)" />
              <v-text-field v-model="search" label="Search systems" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <v-data-table :headers="systemHeaders" :items="visibleSystems" item-key="SystemID" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="sortBy" :sort-desc.sync="sortDesc" :item-class="(item) => (item.SystemID === selectedSystemId ? 'is-selected-row' : '')" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" @click:row="onSystemClick">
            <template #[`item.Name`]="{ item }">
              <span class="font-weight-medium">{{ item.Name }}</span>
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
            Survey points left: each gravitational location takes the system's points per location (more around a heavier primary), and a body's radius / 100 (× 10 for anything but a gas giant) for a geological survey. Time is survey time for the ships already in the system; travel between targets isn't counted.
          </div>
        </v-card>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Survey fleets</span>
            <v-chip small>Rates are estimates</v-chip>
          </div>
          <v-data-table :headers="fleetHeaders" :items="fleetRows" item-key="FleetID" disable-pagination hide-default-footer>
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.shipNames }}</div>
              </div>
            </template>
            <template #[`item.geoRate`]="{ item }">
              <span :class="{ 'text--secondary': !item.geoRate }">{{ item.geoRate ? count(item.geoRate) : '—' }}</span>
            </template>
            <template #[`item.gravRate`]="{ item }">
              <span :class="{ 'text--secondary': !item.gravRate }">{{ item.gravRate ? count(item.gravRate) : '—' }}</span>
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
            Points a day: sensor rating × 24 h × the game's survey speed ({{ surveySpeed }}%) × the better of the science officer's Survey bonus and half the captain's × the naval admin Survey share in range × the share of crew aboard. How the captain's and the science officer's bonuses combine isn't documented.
          </div>
        </v-card>

        <v-card v-if="groundRows.length" class="panel" elevation="1">
          <div class="panel-head">
            <span>Ground surveys</span>
            <v-chip small>{{ groundRows.length }} {{ groundRows.length === 1 ? 'body' : 'bodies' }} with potential</v-chip>
          </div>
          <v-data-table :headers="groundHeaders" :items="groundRows" item-key="SystemBodyID" disable-pagination hide-default-footer>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.name }}</div>
                <div v-if="item.PopName" class="caption text--secondary">{{ item.PopName }}</div>
              </div>
            </template>
            <template #[`item.potential`]="{ item }">{{ potentialLabel(item.Potential) }}</template>
            <template #[`item.progressSort`]="{ item }">
              <div class="progress-cell">
                <div class="meter"><div class="meter-fill" :style="{ width: `${Math.min(1, item.progress) * 100}%`, background: colors.geo }" /></div>
                <span class="caption text-no-wrap">{{ count(item.PointsDone) }} / {{ count(item.PointsRequired) }}</span>
              </div>
            </template>
            <template #[`item.PointsPerDay`]="{ item }">{{ item.PointsPerDay ? fixed(item.PointsPerDay, 2) : '—' }}</template>
            <template #[`item.etaSort`]="{ item }">
              <span v-if="item.eta !== null" class="text-no-wrap">{{ duration(item.eta) }}</span>
              <span v-else class="text--secondary">{{ item.PopulationID ? 'No survey teams' : 'No colony' }}</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A ground survey needs a colony on the body and geosurvey formations there: each unit adds its equipment's points a day, times its commander's Survey bonus. It can raise the body's mineral deposits; the potential is what the geological survey found.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { chartTheme, withAlpha } from '../components/charts/theme'
import { systemBodyName } from '../utilities/aurora'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { navalAdminChainBonus } from '../utilities/minerals'
import { loadNavalAdmins } from '../utilities/naval-admins'

const INPUT_LABELS = {
  systems: 'the known systems',
  bodies: 'the unsurveyed bodies',
  links: 'the jump points',
  ships: 'the survey ships',
  orders: 'fleet orders',
  standingOrders: 'standing orders',
  groundSurveys: 'ground surveys',
  navalAdmins: 'naval admin commands',
}
const INPUTS = Object.keys(INPUT_LABELS)
const HOURS_PER_DAY = 24
// FCT_SystemBody.GroundMineralSurvey, as the Minerals page labels it.
const POTENTIAL = { 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }
const SURVEY_ORDERS = new Set([9, 12])

export default {
  name: 'SurveyProgressPage',
  data() {
    return {
      showSurveyed: false,
      search: '',
      expanded: [],
      selectedSystemId: null,
      sortBy: ['remaining'],
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

    colors() {
      const [blue, orange, , , , , purple] = this.theme.categorical

      return { geo: blue, grav: orange, both: purple, done: withAlpha(this.theme.inkMuted, 0.45) }
    },

    mapLegend() {
      return [
        { key: 'both', label: 'Both surveys left', color: this.colors.both },
        { key: 'grav', label: 'Gravitational left', color: this.colors.grav },
        { key: 'geo', label: 'Geological left', color: this.colors.geo },
        { key: 'done', label: 'Fully surveyed', color: this.colors.done },
      ]
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS) && this.game !== null
    },

    surveySpeed() {
      return this.game ? this.game.SurveySpeed : 100
    },

    // One row per survey ship with its points a day (geological and gravitational).
    shipRates() {
      const speed = this.surveySpeed / 100

      return this.ships.map((ship) => {
        const captain = 1 + (ship.CaptainBonus - 1) / 2
        const officer = Math.max(captain, ship.ScienceBonus || 1)
        const crew = ship.ClassCrew > 0 ? Math.min(1, Math.max(0, ship.CurrentCrew) / ship.ClassCrew) : 1
        const admin = navalAdminChainBonus(this.navalAdmins, ship.SystemID, ship.NavalAdminCommandID)
        const factor = ship.MothershipID ? 0 : HOURS_PER_DAY * speed * officer * crew * admin

        return { ...ship, geoRate: ship.GeoSurvey * factor, gravRate: ship.GravSurvey * factor }
      })
    },

    fleetRows() {
      const fleets = {}

      this.shipRates.forEach((ship) => {
        const fleet = (fleets[ship.FleetID] = fleets[ship.FleetID] || { FleetID: ship.FleetID, FleetName: ship.FleetName, SystemID: ship.SystemID, SystemName: ship.SystemName, Moving: ship.Moving, ships: [], geoRate: 0, gravRate: 0 })

        fleet.ships.push(ship.MothershipID ? `${ship.ShipName} (docked)` : ship.ShipName)
        fleet.geoRate += ship.geoRate
        fleet.gravRate += ship.gravRate
      })

      return Object.values(fleets).map((fleet) => ({
        ...fleet,
        shipNames: fleet.ships.join(', '),
        activity: this.activity(fleet),
      })).sort((a, b) => a.FleetName.localeCompare(b.FleetName))
    },

    bodiesBySystem() {
      const bySystem = {}

      this.bodies.forEach((body) => {
        ;(bySystem[body.SystemID] = bySystem[body.SystemID] || []).push({ ...body, name: systemBodyName(body) })
      })

      return bySystem
    },

    systemRows() {
      return this.systems.map((system) => {
        const fleets = this.fleetRows.filter((fleet) => fleet.SystemID === system.SystemID)
        const gravPoints = Math.max(0, system.Locations - system.LocationsSurveyed) * system.PointsPerLocation
        const geoPoints = system.GeoPoints || 0
        const geoRate = fleets.reduce((sum, fleet) => sum + fleet.geoRate, 0)
        const gravRate = fleets.reduce((sum, fleet) => sum + fleet.gravRate, 0)
        const gravDays = gravPoints ? (gravRate > 0 ? gravPoints / gravRate : null) : 0
        const geoDays = geoPoints ? (geoRate > 0 ? geoPoints / geoRate : null) : 0
        // Both surveys run side by side, so the slower one sets the time; unknown if either has no ships.
        const eta = (gravPoints || geoPoints) && gravDays !== null && geoDays !== null ? Math.max(gravDays, geoDays) : null

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
          etaSort: eta ?? Infinity,
          unsurveyedBodies: this.bodiesBySystem[system.SystemID] || [],
        }
      })
    },

    visibleSystems() {
      const search = (this.search || '').toLowerCase()

      return this.systemRows.filter((system) => (this.showSurveyed || system.remaining > 0 || system.SystemID === this.selectedSystemId) && (!search || system.Name.toLowerCase().includes(search)))
    },

    map() {
      const systems = this.systemRows.filter((system) => system.Xcor !== null && system.Ycor !== null)

      if (!systems.length) {
        return { viewBox: '0 0 100 100', unit: 1, nodes: [], links: [] }
      }

      const xs = systems.map((system) => system.Xcor)
      const ys = systems.map((system) => system.Ycor)
      const width = Math.max(...xs) - Math.min(...xs) || 100
      const height = Math.max(...ys) - Math.min(...ys) || 100
      // About one screen pixel in map units (the map is drawn up to ~1100 x 600 px), so strokes
      // and labels keep their size whatever the galaxy's extent.
      const unit = Math.max(width / 1100, height / 560)
      const pad = unit * 30
      const maxRemaining = Math.max(...systems.map((system) => system.remaining), 1)
      const byId = Object.fromEntries(systems.map((system) => [system.SystemID, system]))
      const nodes = systems.map((system) => {
        const status = system.gravPoints && system.geoPoints ? 'both' : system.gravPoints ? 'grav' : system.geoPoints ? 'geo' : 'done'

        return {
          ...system,
          x: system.Xcor,
          y: system.Ycor,
          r: unit * (system.remaining ? 5 + 9 * Math.sqrt(system.remaining / maxRemaining) : 3.5),
          color: this.colors[status],
          ships: system.shipsHere,
          label: system.remaining > 0 || system.shipsHere > 0,
          title: `${system.Name}: ${system.remaining ? `${this.count(system.remaining)} survey points left` : 'fully surveyed'}${system.shipsHere ? `, ${system.fleetsHere.join(', ')}` : ''}`,
        }
      })
      const seen = new Set()
      const links = []

      this.links.forEach((link) => {
        const key = [link.SystemID, link.DestinationID].sort((a, b) => a - b).join('-')
        const from = byId[link.SystemID]
        const to = byId[link.DestinationID]

        if (from && to && !seen.has(key)) {
          seen.add(key)
          links.push({ key, x1: from.Xcor, y1: from.Ycor, x2: to.Xcor, y2: to.Ycor })
        }
      })

      // Surveyed systems first, so the ones with work left draw on top.
      nodes.sort((a, b) => a.remaining - b.remaining)

      return { viewBox: `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${width + 2 * pad} ${height + 2 * pad}`, unit, nodes, links }
    },

    groundRows() {
      return this.groundSurveys.map((row) => {
        const remaining = Math.max(0, row.PointsRequired - row.PointsDone)
        const eta = row.PointsPerDay > 0 ? remaining / row.PointsPerDay : null

        return {
          ...row,
          name: row.SystemBodyName ? `${row.SystemName} · ${row.SystemBodyName}` : systemBodyName(row, { Name: row.SystemName }),
          progress: row.PointsRequired > 0 ? row.PointsDone / row.PointsRequired : 0,
          progressSort: row.PointsRequired > 0 ? row.PointsDone / row.PointsRequired : 0,
          eta,
          etaSort: eta ?? Infinity,
        }
      })
    },

    tiles() {
      const systems = this.systemRows
      const done = systems.filter((system) => !system.remaining).length
      const grav = systems.filter((system) => system.gravPoints > 0)
      const geo = systems.filter((system) => system.geoPoints > 0)
      const locations = grav.reduce((sum, system) => sum + system.Locations - system.LocationsSurveyed, 0)
      const bodies = geo.reduce((sum, system) => sum + system.unsurveyedBodies.length, 0)
      const geoRate = this.fleetRows.reduce((sum, fleet) => sum + fleet.geoRate, 0)
      const gravRate = this.fleetRows.reduce((sum, fleet) => sum + fleet.gravRate, 0)
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
          note: `${this.count(geoRate)} geological and ${this.count(gravRate)} gravitational points a day${idle ? `; ${idle} idle` : ''}`,
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
        { text: 'Potential', value: 'potential' },
        { text: 'Progress', value: 'progressSort' },
        { text: 'Teams (units)', value: 'Units', align: 'end' },
        { text: 'Points / day', value: 'PointsPerDay', align: 'end' },
        { text: 'Time left', value: 'etaSort', align: 'end' },
      ]
    },
  },
  created() {
    this.showSurveyed = this.config.get('surveyShowSurveyed', false)
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    onSystemClick(item, { expand, isExpanded }) {
      this.selectedSystemId = item.SystemID
      expand(!isExpanded)
    },

    selectSystem(systemId) {
      this.selectedSystemId = systemId

      const row = this.systemRows.find((system) => system.SystemID === systemId)

      if (row) {
        this.search = ''
        this.sortBy = ['remaining']
        this.sortDesc = [true]
        this.expanded = [row]
        this.$nextTick(() => {
          const panel = this.$refs.systemsPanel

          if (panel && panel.$el) {
            panel.$el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        })
      }
    },

    activity(fleet) {
      const orders = this.orders.filter((order) => order.FleetID === fleet.FleetID)
      const survey = orders.find((order) => SURVEY_ORDERS.has(order.MoveActionID))
      const standing = this.standingOrders.filter((order) => order.FleetID === fleet.FleetID).map((order) => order.Description)

      if (survey) {
        return { label: 'Surveying', note: survey.Description, icon: 'mdi-radar', color: 'success' }
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
    count(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
    duration(days) {
      if (days < 1) {
        return `${Math.max(1, Math.round(days * 24))} h`
      } else if (days < 60) {
        return `${roundToDecimal(days, 1)} d`
      } else if (days < 730) {
        return `${roundToDecimal(days / 30.4, 1)} mo`
      }

      return `${roundToDecimal(days / 365, 1)} y`
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
    // Known systems with their gravitational locations (done of all) and geological bodies
    // (planets, moons, asteroids, comets; points left on the ones neither surveyed nor banned).
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_System.JumpPointSurveyPoints as PointsPerLocation, coalesce(VIR_Locations.Locations, 0) as Locations, coalesce(VIR_Surveyed.Locations, 0) as LocationsSurveyed, coalesce(VIR_Bodies.Bodies, 0) as Bodies, coalesce(VIR_Bodies.Surveyed, 0) as BodiesSurveyed, coalesce(VIR_Bodies.Points, 0) as GeoPoints from FCT_RaceSysSurvey inner join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_SurveyLocation.SystemID, count(*) as Locations from FCT_SurveyLocation where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID) as VIR_Locations on VIR_Locations.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_RaceSurveyLocation.SystemID, count(*) as Locations from FCT_RaceSurveyLocation where FCT_RaceSurveyLocation.GameID = ${this.GameID} and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} group by FCT_RaceSurveyLocation.SystemID) as VIR_Surveyed on VIR_Surveyed.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_SystemBody.SystemID, count(*) as Bodies, sum(case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end) as Surveyed, sum(case when FCT_SystemBodySurveys.SystemBodyID is null and FCT_BannedBodies.SystemBodyID is null then FCT_SystemBody.Radius / 100.0 * (case when FCT_SystemBody.BodyTypeID in (4, 5) then 1 else 10 end) else 0 end) as Points from FCT_SystemBody left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${this.RaceID} and FCT_BannedBodies.GameID = ${this.GameID} where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) group by FCT_SystemBody.SystemID) as VIR_Bodies on VIR_Bodies.SystemID = FCT_RaceSysSurvey.SystemID where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    bodies: {
      get: tracked('bodies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.Radius / 100.0 * (case when FCT_SystemBody.BodyTypeID in (4, 5) then 1 else 10 end) as Points from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${this.RaceID} and FCT_BannedBodies.GameID = ${this.GameID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBodySurveys.SystemBodyID is null and FCT_BannedBodies.SystemBodyID is null order by FCT_SystemBody.SystemID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber`).then(([items]) => items)
      }),
      default: [],
    },
    // Jump links the race has charted to a system it knows.
    links: {
      get: tracked('links', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_JumpPoint.SystemID, VIR_Destination.SystemID as DestinationID from FCT_JumpPoint inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1 inner join FCT_JumpPoint as VIR_Destination on VIR_Destination.WarpPointID = FCT_JumpPoint.WPLink inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = VIR_Destination.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_JumpPoint.GameID = ${this.GameID}`).then(([items]) => items)
      }),
      default: [],
    },
    // Ships with geological or gravitational sensors, with their captain's (CommandType 1) and
    // science officer's (CommandType 10) Survey bonus.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.ParentCommandID as NavalAdminCommandID, case when FCT_Fleet.Xcor <> FCT_Fleet.LastXcor or FCT_Fleet.Ycor <> FCT_Fleet.LastYcor then 1 else 0 end as Moving, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.MothershipID, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.GeoSurvey, FCT_ShipClass.GravSurvey, coalesce(VIR_Captain.BonusValue, 1) as CaptainBonus, VIR_Science.BonusValue as ScienceBonus from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and (FCT_ShipClass.GeoSurvey > 0 or FCT_ShipClass.GravSurvey > 0) inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 2 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Captain on VIR_Captain.CommandID = FCT_Ship.ShipID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 2 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 10) as VIR_Science on VIR_Science.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0`).then(([items]) => items)
      }),
      default: [],
    },
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.Description from FCT_MoveOrders where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.FleetID in (select FCT_Ship.FleetID from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and (FCT_ShipClass.GeoSurvey > 0 or FCT_ShipClass.GravSurvey > 0)) order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
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
    // Geologically surveyed bodies with ground-survey potential left, with the race's colony there
    // (progress in GroundGeoSurvey) and its geosurvey formations' points a day.
    groundSurveys: {
      get: tracked('groundSurveys', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.GroundMineralSurvey as Potential, FCT_SystemBody.Radius / 10.0 as PointsRequired, FCT_Population.PopulationID, FCT_Population.PopName, coalesce(FCT_Population.GroundGeoSurvey, 0) as PointsDone, coalesce(VIR_Teams.Units, 0) as Units, coalesce(VIR_Teams.PointsPerDay, 0) as PointsPerDay from FCT_SystemBody inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_Population on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.GameID = ${this.GameID} left join (select FCT_GroundUnitFormation.PopulationID, sum(FCT_GroundUnitFormationElement.Units) as Units, sum(FCT_GroundUnitFormationElement.Units * VIR_Class.Geosurvey * coalesce(VIR_Commander.BonusValue, 1)) as PointsPerDay from FCT_GroundUnitFormation inner join FCT_GroundUnitFormationElement on FCT_GroundUnitFormationElement.FormationID = FCT_GroundUnitFormation.FormationID inner join (select FCT_GroundUnitClass.GroundUnitClassID, coalesce(VIR_A.Geosurvey, 0) + coalesce(VIR_B.Geosurvey, 0) + coalesce(VIR_C.Geosurvey, 0) + coalesce(VIR_D.Geosurvey, 0) as Geosurvey from FCT_GroundUnitClass left join DIM_GroundComponentType as VIR_A on VIR_A.ComponentTypeID = FCT_GroundUnitClass.ComponentA left join DIM_GroundComponentType as VIR_B on VIR_B.ComponentTypeID = FCT_GroundUnitClass.ComponentB left join DIM_GroundComponentType as VIR_C on VIR_C.ComponentTypeID = FCT_GroundUnitClass.ComponentC left join DIM_GroundComponentType as VIR_D on VIR_D.ComponentTypeID = FCT_GroundUnitClass.ComponentD where FCT_GroundUnitClass.GameID = ${this.GameID}) as VIR_Class on VIR_Class.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID and VIR_Class.Geosurvey > 0 left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 2 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 5) as VIR_Commander on VIR_Commander.CommandID = FCT_GroundUnitFormation.FormationID where FCT_GroundUnitFormation.GameID = ${this.GameID} and FCT_GroundUnitFormation.RaceID = ${this.RaceID} group by FCT_GroundUnitFormation.PopulationID) as VIR_Teams on VIR_Teams.PopulationID = FCT_Population.PopulationID where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.GroundMineralSurvey > 0 order by FCT_SystemBody.GroundMineralSurvey desc, FCT_Population.PopulationID desc`).then(([items]) => items)
      }),
      default: [],
    },
    // Naval admin commands with their Survey bonus.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 2, share: 'Survey' })
      }),
      default: {},
    },
  },
}
</script>

<style lang="scss">
.survey-page {
  .search-field {
    min-width: 220px;
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

  .survey-map {
    display: block;
    width: 100%;
    height: 600px;
  }

  .map-node {
    cursor: pointer;
  }

  .map-node text {
    pointer-events: none;
    font-family: Roboto, 'Helvetica Neue', Arial, sans-serif;
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
    background: rgba(0, 0, 0, 0.08);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
  }

  tr.is-selected-row {
    background: rgba(33, 150, 243, 0.08);
  }
}

.theme--dark .survey-page {
  .meter {
    background: rgba(255, 255, 255, 0.12);
  }

  tr.is-selected-row {
    background: rgba(33, 150, 243, 0.16);
  }
}
</style>
