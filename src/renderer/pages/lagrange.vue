<template>
  <div>
    <v-container fluid class="lagrange-page">
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
              <div class="stat-value">{{ tile.value }}</div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Lagrange map</span>
            <span class="legend">
              <span v-for="item in mapLegend" :key="item.key" class="legend-item"><span class="dot" :style="{ background: item.color }" />{{ item.label }}</span>
              <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Your colonies</span>
            </span>
          </div>
          <div class="panel-body">
            <system-map :systems="mapNodes" :links="links" :selected="selectedSystemId" aria-label="Known systems coloured by their stable Lagrange points" @select="selectSystem" />
            <div class="caption text--secondary">Positions as on the game's galactic map. Click a system to list its planets and moons below.</div>
          </div>
        </v-card>

        <v-card ref="bodiesPanel" class="panel" elevation="1">
          <div class="panel-head">
            <span>Planets and moons</span>
            <span class="d-flex align-center flex-wrap controls">
              <v-chip v-if="selectedSystem" small close @click:close="selectedSystemId = null">{{ selectedSystem.Name }}</v-chip>
              <v-btn-toggle v-model="view" mandatory dense @change="(value) => config.set('lagrangeView', value)">
                <v-btn v-for="option in viewOptions" :key="option.value" :value="option.value" small>{{ option.label }}</v-btn>
              </v-btn-toggle>
              <v-switch v-model="colonySystemsOnly" label="Systems with your colonies" dense hide-details class="mt-0" @change="(value) => config.set('lagrangeColonySystemsOnly', !!value)" />
              <v-text-field v-model="search" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <v-data-table :headers="bodyHeaders" :items="visibleBodies" item-key="SystemBodyID" :sort-by.sync="sortBy" :sort-desc.sync="sortDesc" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" :items-per-page="15">
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.name }}</div>
                <div class="caption text--secondary">{{ item.type }}</div>
              </div>
            </template>
            <template #[`item.Mass`]="{ item }">{{ count(item.Mass, item.Mass < 10 ? 2 : 0) }}</template>
            <template #[`item.systemPoints`]="{ item }">
              <span class="text-no-wrap">
                {{ item.systemPoints }}
                <v-icon v-if="item.systemPoints >= 2" small :color="colors.many" title="Ships can jump between this system's Lagrange points">mdi-swap-horizontal</v-icon>
              </span>
            </template>
            <template #[`item.daysSort`]="{ item }">
              <span v-if="item.status.key === 'stable'" class="text--secondary">—</span>
              <span v-else class="text-no-wrap">{{ duration(item.days) }}</span>
            </template>
            <template #[`item.statusSort`]="{ item }">
              <span class="text-no-wrap">
                <v-icon small :color="item.status.color">{{ item.status.icon }}</v-icon>
                {{ item.status.label }}
              </span>
              <div v-if="item.status.note" class="caption text--secondary">{{ item.status.note }}</div>
            </template>
            <template #[`item.Colonies`]="{ item }">
              <span :class="{ 'text--secondary': !item.Colonies }">{{ item.Colonies || '—' }}</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A ship with a jump point stabilisation module takes 60 / √mass months (of 30 days) at the body, times 2 − its captain's Production bonus, and longer when under-crewed (class crew / crew aboard). In a fleet the quickest ship counts; ships don't add up. Planets and moons of 0.25 Earth masses or more qualify. Times here use {{ bestShip ? `${bestShip.ShipName} (× ${fixed(bestShip.multiplier, 2)})` : 'no bonus, as the race has no stabilisation ship' }} and leave out the trip there. Systems are generated with a stable point at every super-jovian and every gas giant above 200 Earth masses.
          </div>
        </v-card>

        <v-card v-if="shipRows.length" class="panel" elevation="1">
          <div class="panel-head">
            <span>Stabilisation ships</span>
          </div>
          <v-data-table :headers="shipHeaders" :items="shipRows" item-key="ShipID" disable-pagination hide-default-footer>
            <template #[`item.ShipName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.ShipName }}</div>
                <div class="caption text--secondary">{{ item.ClassName }} · {{ item.FleetName }}</div>
              </div>
            </template>
            <template #[`item.ProductionBonus`]="{ item }">
              <span v-if="item.CaptainName">{{ percent(item.ProductionBonus) }}<span class="caption text--secondary d-block">{{ item.CaptainName }}</span></span>
              <span v-else class="text--secondary">No captain</span>
            </template>
            <template #[`item.crew`]="{ item }">{{ count(item.CurrentCrew) }} / {{ count(item.ClassCrew) }}</template>
            <template #[`item.multiplierSort`]="{ item }">
              <span v-if="item.multiplier !== null">× {{ fixed(item.multiplier, 2) }}</span>
              <span v-else class="warning--text">{{ item.Damaged ? 'Module damaged' : 'No crew' }}</span>
            </template>
            <template #[`item.activity`]="{ item }">
              <span v-if="item.activity" class="text-no-wrap">{{ item.activity }}</span>
              <span v-else class="text--secondary">No stabilisation order</span>
            </template>
          </v-data-table>
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
import { jumpLinks, loadJumpPoints } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  colonies: 'your colonies',
  bodies: 'the planets and moons',
  ships: 'the stabilisation ships',
  orders: 'stabilisation orders',
}
const INPUTS = Object.keys(INPUT_LABELS)
// DIM_ComponentType 'Jump Point Stabilisation', DIM_MoveAction 'Stabilise Lagrange Point', the Production bonus.
const STABILISATION_COMPONENT = 29
const STABILISE_ACTION = 217
const PRODUCTION_BONUS = 5
// Fleet.CalculateLagrangePointStabilisationTime: 60 / sqrt(mass) months of Helpers.SecondsPerMonth (30 days).
const BASE_DAYS = 60 * 30
const TYPES = { 2: 'Terrestrial planet', 3: 'Dwarf planet', 4: 'Gas giant', 5: 'Super-jovian' }

export default {
  name: 'LagrangePage',
  components: { SystemMap },
  mixins: [countFormat],
  data() {
    return {
      view: 'candidates',
      colonySystemsOnly: false,
      search: '',
      selectedSystemId: null,
      sortBy: ['daysSort'],
      sortDesc: [false],
      loadErrors: {},
      viewOptions: [
        { value: 'candidates', label: 'To stabilise' },
        { value: 'stable', label: 'Stable' },
        { value: 'all', label: 'All' },
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

      return { none: withAlpha(this.theme.inkMuted, 0.45), one: blue, many: green }
    },

    mapLegend() {
      return [
        { key: 'many', label: 'Two or more: ships jump between them', color: this.colors.many },
        { key: 'one', label: 'One stable point', color: this.colors.one },
        { key: 'none', label: 'None', color: this.colors.none },
      ]
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

    links() {
      return jumpLinks(this.jumpPoints)
    },

    coloniesBySystem() {
      return Object.fromEntries(this.colonies.map((row) => [row.SystemID, row.Colonies]))
    },

    // Undamaged, crewed ships time a stabilisation at 2 − Production bonus, × class crew / crew aboard when short.
    shipRows() {
      return this.ships.map((ship) => {
        const usable = !ship.Damaged && ship.CurrentCrew > 0
        const crew = ship.CurrentCrew < ship.ClassCrew ? ship.ClassCrew / ship.CurrentCrew : 1
        const multiplier = usable ? (2 - ship.ProductionBonus) * crew : null
        const order = this.orders.find((candidate) => candidate.FleetID === ship.FleetID)

        return {
          ...ship,
          crew: ship.ClassCrew ? ship.CurrentCrew / ship.ClassCrew : 1,
          multiplier,
          multiplierSort: multiplier ?? Infinity,
          activity: order ? this.orderText(order) : null,
        }
      })
    },

    bestShip() {
      return this.shipRows.filter((ship) => ship.multiplier !== null).sort((a, b) => a.multiplier - b.multiplier)[0] || null
    },

    pointsBySystem() {
      const counts = {}

      this.bodies.forEach((body) => {
        if (body.LagrangePointID) {
          counts[body.SystemID] = (counts[body.SystemID] || 0) + 1
        }
      })

      return counts
    },

    bodyRows() {
      const multiplier = this.bestShip ? this.bestShip.multiplier : 1

      return this.bodies.map((body) => {
        const order = this.orders.find((candidate) => candidate.SystemBodyID === body.SystemBodyID)
        const days = (BASE_DAYS / Math.sqrt(body.Mass)) * multiplier
        const status = body.LagrangePointID
          ? { key: 'stable', label: 'Stable', icon: 'mdi-check-circle', color: 'success', rank: 2 }
          : order
            ? { key: 'working', label: order.Arrived ? 'Being stabilised' : 'Ship on the way', note: this.orderNote(order), icon: 'mdi-progress-wrench', color: 'primary', rank: 1 }
            : { key: 'candidate', label: 'Can be stabilised', icon: 'mdi-circle-outline', color: '', rank: 0 }

        return {
          ...body,
          name: systemBodyName(body, { Name: body.SystemName }),
          type: TYPES[body.BodyTypeID] || (body.BodyClass === 2 ? 'Moon' : 'Planet'),
          systemPoints: this.pointsBySystem[body.SystemID] || 0,
          Colonies: this.coloniesBySystem[body.SystemID] || 0,
          days,
          daysSort: status.key === 'stable' ? Infinity : days,
          status,
          statusSort: status.rank,
        }
      })
    },

    selectedSystem() {
      return this.systems.find((system) => system.SystemID === this.selectedSystemId) || null
    },

    visibleBodies() {
      const search = (this.search || '').toLowerCase()

      return this.bodyRows.filter((body) => (this.view === 'all' || (this.view === 'stable') === (body.status.key === 'stable')) &&
        (!this.colonySystemsOnly || body.Colonies > 0) &&
        (!this.selectedSystemId || body.SystemID === this.selectedSystemId) &&
        (!search || body.name.toLowerCase().includes(search) || body.SystemName.toLowerCase().includes(search)))
    },

    mapNodes() {
      return this.systems.map((system) => {
        const points = this.pointsBySystem[system.SystemID] || 0
        const colonies = this.coloniesBySystem[system.SystemID] || 0

        return {
          ...system,
          points,
          size: points ? 5 + 2 * Math.min(points, 4) : 3.5,
          color: points >= 2 ? this.colors.many : points ? this.colors.one : this.colors.none,
          ring: colonies ? this.theme.ink : null,
          label: points >= 2,
          title: `${system.Name}: ${points ? `${points} stable Lagrange ${points === 1 ? 'point' : 'points'}` : 'no stable Lagrange point'}${colonies ? `, ${colonies} ${colonies === 1 ? 'colony' : 'colonies'}` : ''}`,
        }
      }).sort((a, b) => a.points - b.points)
    },

    tiles() {
      const stable = this.bodyRows.filter((body) => body.status.key === 'stable')
      const candidates = this.bodyRows.filter((body) => body.status.key !== 'stable')
      const systems = Object.keys(this.pointsBySystem).length
      const jumpSystems = Object.values(this.pointsBySystem).filter((points) => points >= 2).length
      const quickest = candidates.slice().sort((a, b) => a.days - b.days)[0]
      const usable = this.shipRows.filter((ship) => ship.multiplier !== null)

      return [
        {
          label: 'Stable Lagrange points',
          value: this.count(stable.length),
          note: `In ${systems} ${systems === 1 ? 'system' : 'systems'}; ${jumpSystems} with two or more, where ships can jump between them`,
        },
        {
          label: 'Planets and moons to stabilise',
          value: this.count(candidates.length),
          note: `${this.count(candidates.filter((body) => body.Colonies > 0).length)} in systems with your colonies`,
        },
        {
          label: 'Quickest to stabilise',
          value: quickest ? this.duration(quickest.days) : '—',
          note: quickest ? `${quickest.name}, ${this.count(quickest.Mass, 2)} Earth masses` : 'Nothing left to stabilise',
        },
        {
          label: 'Stabilisation ships',
          value: usable.length ? `${usable.length} ${usable.length === 1 ? 'ship' : 'ships'}` : 'None',
          note: this.bestShip ? `Quickest: ${this.bestShip.ShipName}, × ${this.fixed(this.bestShip.multiplier, 2)} time` : 'Needs a ship with a jump point stabilisation module',
        },
      ]
    },

    bodyHeaders() {
      return [
        { text: 'Body', value: 'name' },
        { text: 'System', value: 'SystemName' },
        { text: 'Mass (Earths)', value: 'Mass', align: 'end' },
        { text: 'Stable points in system', value: 'systemPoints', align: 'end' },
        { text: 'Time to stabilise', value: 'daysSort', align: 'end' },
        { text: 'Lagrange point', value: 'statusSort' },
        { text: 'Your colonies in system', value: 'Colonies', align: 'end' },
      ]
    },

    shipHeaders() {
      return [
        { text: 'Ship', value: 'ShipName' },
        { text: 'System', value: 'SystemName' },
        { text: 'Captain\'s Production bonus', value: 'ProductionBonus', align: 'end' },
        { text: 'Crew', value: 'crew', align: 'end' },
        { text: 'Time', value: 'multiplierSort', align: 'end' },
        { text: 'Doing', value: 'activity', sortable: false },
      ]
    },
  },
  watch: {
    // A system picked on the map belongs to the race that was showing.
    RaceID() {
      this.selectedSystemId = null
    },
  },
  created() {
    this.view = this.config.get('lagrangeView', 'candidates')
    this.colonySystemsOnly = this.config.get('lagrangeColonySystemsOnly', false)
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    selectSystem(systemId) {
      this.selectedSystemId = systemId
      this.search = ''
      this.$nextTick(() => {
        const panel = this.$refs.bodiesPanel

        if (panel && panel.$el) {
          panel.$el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    },

    bodyNameOf(systemBodyId) {
      const body = this.bodyRows.find((row) => row.SystemBodyID === systemBodyId)

      return body ? body.name : `body #${systemBodyId}`
    },

    orderNote(order) {
      return order.Arrived ? `${order.FleetName}, ${this.duration(order.TimeRequired / 86400)} left` : order.FleetName
    },

    orderText(order) {
      return order.Arrived ? `Stabilising ${this.bodyNameOf(order.SystemBodyID)}, ${this.duration(order.TimeRequired / 86400)} left` : `On the way to stabilise ${this.bodyNameOf(order.SystemBodyID)}`
    },

    percent(bonus) {
      return bonus === 1 ? 'None' : `${bonus > 1 ? '+' : ''}${roundToDecimal((bonus - 1) * 100, 0)}%`
    },

    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
  },
  asyncComputed: {
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => items)
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

        return await this.database.query(`select FCT_Population.SystemID, count(*) as Colonies from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemID`).then(([items]) => items)
      }),
      default: [],
    },
    // Planets and moons of the known systems that could hold a Lagrange point (0.25 Earth masses and up), and
    // any that has one. Lagrange points belong to no race: every one in a known system shows.
    bodies: {
      get: tracked('bodies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.Mass, (select min(FCT_LagrangePoint.LagrangePointID) from FCT_LagrangePoint where FCT_LagrangePoint.PlanetID = FCT_SystemBody.SystemBodyID and FCT_LagrangePoint.GameID = ${this.GameID}) as LagrangePointID from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} and FCT_SystemBodyName.GameID = ${this.GameID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2) and (FCT_SystemBody.Mass >= 0.25 or FCT_SystemBody.SystemBodyID in (select FCT_LagrangePoint.PlanetID from FCT_LagrangePoint where FCT_LagrangePoint.GameID = ${this.GameID}))`).then(([items]) => items)
      }),
      default: [],
    },
    // Ships with a jump point stabilisation module, their captain's (CommandType 1) Production bonus, and whether
    // a module is damaged.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ClassName, FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_RaceSysSurvey.Name as SystemName, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, VIR_Captain.Name as CaptainName, coalesce(VIR_Captain.BonusValue, 1) as ProductionBonus, exists (select 1 from FCT_DamagedComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_DamagedComponent.ComponentID where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_ShipDesignComponents.ComponentTypeID = ${STABILISATION_COMPONENT}) as Damaged from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join (select FCT_Commander.CommandID, FCT_Commander.Name, FCT_CommanderBonuses.BonusValue from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${PRODUCTION_BONUS} where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Captain on VIR_Captain.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShipClassID in (select FCT_ClassComponent.ClassID from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.GameID = ${this.GameID} and FCT_ShipDesignComponents.ComponentTypeID = ${STABILISATION_COMPONENT}) order by FCT_Ship.ShipName`).then(([items]) => items)
      }),
      default: [],
    },
    // Stabilise orders: the body is DestinationID; once the fleet is there (`Arrived`), TimeRequired is the
    // seconds left.
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_Fleet.FleetName, FCT_MoveOrders.DestinationID as SystemBodyID, FCT_MoveOrders.Arrived, FCT_MoveOrders.TimeRequired from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.MoveActionID = ${STABILISE_ACTION} order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.lagrange-page {
  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  .controls {
    gap: 12px;
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

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
