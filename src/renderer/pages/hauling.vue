<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <v-container v-else fluid class="hauling-page">
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
            <span>Repeating routes</span>
            <v-chip small>Estimates</v-chip>
          </div>
          <v-data-table :headers="routeHeaders" :items="routeRows" item-key="FleetID" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="routeSortBy" :sort-desc.sync="routeSortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.Ships }} {{ item.Ships === 1 ? 'ship' : 'ships' }} at {{ count(item.Speed) }} km/s</div>
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
              <span v-if="item.year" class="text-no-wrap" :title="`${fixed(item.year.movingDays, 1)} days moving, ${fixed(item.handlingHours, 1)} hours loading and unloading`">{{ fixed(item.year.cycleDays, 1) }} d</span>
              <span v-else class="text--secondary">—</span>
              <div v-if="item.blocked.length" class="caption warning--text">Can't load at {{ item.blockedText }}. Left out of the totals.</div>
            </template>
            <template #[`item.tripsSort`]="{ item }">
              <span v-if="item.year">{{ fixed(item.year.trips, 1) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.movedSort`]="{ item }">
              <span v-if="item.year && item.movedText" class="text-no-wrap">{{ item.movedText }}</span>
              <span v-else class="text--secondary">{{ item.year ? 'No cargo delivered' : '—' }}</span>
            </template>
            <template #[`item.fuelSort`]="{ item }">
              <span v-if="item.year" class="text-no-wrap">{{ litres(item.year.fuel) }}</span>
              <span v-else class="text--secondary">—</span>
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
                <div v-if="item.year" class="caption text--secondary mt-2">Each cycle: {{ fixed(item.year.movingDays, 2) }} days moving and {{ fixed(item.handlingHours, 1) }} hours loading and unloading.</div>
                <div v-if="item.cargo.holdShare > 0 && item.cargo.holdShare < 1" class="caption text--secondary mt-2">The amounts set on its mineral orders fill {{ count(item.cargo.holdShare * 100) }}% of the hold: {{ tons(item.cargo.perTrip.minerals + item.cargo.perTrip.installations) }} a trip.</div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Fleets Aurora runs on repeat (cycle moves), walked order by order through jump points and Lagrange points, with bodies where they are now. Trips assume full loads (or the set amounts) at the fleet's set speed. Loading and unloading follow the docs' cargo-handling time, without commander, governor or admin Logistics bonuses; refuelling and overhauls aren't counted.
          </div>
        </v-card>

        <v-row>
          <v-col cols="12" lg="6">
            <v-card class="panel" elevation="1">
              <div class="panel-head"><span>Deliveries by destination</span></div>
              <v-data-table :headers="deliveryHeaders" :items="deliveryRows" item-key="key" :items-per-page="10" :footer-props="{ itemsPerPageOptions: [10, 25, -1] }" dense>
                <template #[`item.amount`]="{ item }">{{ item.kind === 'colonists' ? `${count(item.amount)} people` : tons(item.amount) }}</template>
              </v-data-table>
              <div class="panel-foot caption text--secondary">Each unload is credited with the cargo the fleet holds when it gets there, so a route that unloads at several colonies counts every hold it delivers.</div>
            </v-card>
          </v-col>
          <v-col cols="12" lg="6">
            <v-card class="panel" elevation="1">
              <div class="panel-head"><span>Freighter classes</span></div>
              <v-data-table :headers="classHeaders" :items="classRows" item-key="ShipClassID" :items-per-page="10" :footer-props="{ itemsPerPageOptions: [10, 25, -1] }" dense>
                <template #[`item.ClassName`]="{ item }">
                  <span class="font-weight-medium">{{ item.ClassName }}</span>
                  <span class="caption text--secondary"> {{ item.HullAbbr }}</span>
                </template>
                <template #[`item.CargoCapacity`]="{ item }">{{ item.CargoCapacity ? tons(item.CargoCapacity) : '—' }}</template>
                <template #[`item.ColonistCapacity`]="{ item }">{{ item.ColonistCapacity ? count(item.ColonistCapacity) : '—' }}</template>
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

import { classYear, cycleCargo, cycleHandling, routeYear, walkRoute } from '../utilities/hauling'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'

const INPUT_LABELS = {
  classes: 'the freighter classes',
  fleets: 'the repeating fleets',
  fleetShips: 'their ships',
  orders: 'their orders',
}
const INPUTS = Object.keys(INPUT_LABELS)
// DIM_MoveAction: "Move to Location".
const MOVE_TO_LOCATION = 2

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

export default {
  name: 'HaulingPage',
  data() {
    return {
      expanded: [],
      routeSortBy: ['movedSort'],
      routeSortDesc: [true],
      loadErrors: {},
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
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

    shipsByFleet() {
      const byFleet = {}

      this.fleetShips.forEach((ship) => {
        ;(byFleet[ship.FleetID] = byFleet[ship.FleetID] || []).push(ship)
      })

      return byFleet
    },

    ordersByFleet() {
      const byFleet = {}

      this.orders.forEach((order) => {
        const label = placeOf(order)
        const exitLabel = !order.Jumps ? label : order.DestinationType === 1 ? `${order.ArrivalSystemName || 'next system'} (arrival)` : order.Description && order.Description.includes(' Jump to ') ? order.Description.split(' Jump to ').pop() : label

        ;(byFleet[order.FleetID] = byFleet[order.FleetID] || []).push({ ...order, label, exitLabel })
      })

      return byFleet
    },

    routeRows() {
      return this.fleets.map((fleet) => {
        const orders = this.ordersByFleet[fleet.FleetID] || []
        const route = walkRoute(orders)
        const cargo = cycleCargo(orders, fleet)
        const ships = this.shipsByFleet[fleet.FleetID] || []
        const handling = cycleHandling(orders, cargo, fleet, ships)
        const year = routeYear(fleet, route, cargo, handling, orders.reduce((sum, order) => sum + (order.OrderDelay || 0), 0))
        // A stop does something where it goes: transits and plain moves only pass through.
        const stops = orders.filter((order) => !order.Jumps && order.MoveActionID !== MOVE_TO_LOCATION).map((order) => `${placeOf(order)}: ${order.ActionName}`)
        const moved = year ? [year.minerals ? `${this.tons(year.minerals)} minerals` : null, year.installations ? `${this.tons(year.installations)} installations` : null, year.colonists ? `${this.count(year.colonists)} colonists` : null].filter(Boolean).join(', ') : ''

        return {
          ...fleet,
          route,
          cargo,
          year,
          stopsText: stops.join(' → '),
          handlingHours: handling.seconds / 3600,
          blocked: handling.blocked,
          blockedText: handling.blocked.map((stop) => `${stop.place} (${stop.reason === 'crew' ? 'a ship has no crew aboard' : 'no shuttle bays or station, and too big to land'})`).join(', '),
          movedText: moved,
          kmSort: route.km ?? Infinity,
          cycleSort: year ? year.cycleDays : Infinity,
          tripsSort: year ? year.trips : 0,
          movedSort: year ? year.minerals + year.installations + year.colonists / 1000 : -1,
          fuelSort: year ? year.fuel : 0,
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
          const total = (totals[key] = totals[key] || { key, destination: delivery.name, kind: delivery.kind, amount: 0, fleets: new Set() })

          total.amount += row.year.trips * delivery.amount
          total.fleets.add(row.FleetName)
        })
      })

      return Object.values(totals).map((total) => ({ ...total, fleetCount: total.fleets.size, fleetNames: [...total.fleets].join(', ') })).sort((a, b) => b.amount - a.amount)
    },

    classRows() {
      return this.classes.map((shipClass) => ({ ...shipClass, ...classYear(shipClass) }))
    },

    tiles() {
      const counted = this.routeRows.filter((row) => row.year)
      const untraced = this.routeRows.filter((row) => row.route.km === null).length
      const blocked = this.routeRows.filter((row) => row.route.km !== null && row.blocked.length).length
      const sum = (key) => counted.reduce((total, row) => total + row.year[key], 0)
      const cargo = this.classes.reduce((total, shipClass) => total + shipClass.CargoCapacity * shipClass.Ships, 0)
      const colonists = this.classes.reduce((total, shipClass) => total + shipClass.ColonistCapacity * shipClass.Ships, 0)
      const ships = this.classes.reduce((total, shipClass) => total + shipClass.Ships, 0)

      return [
        {
          label: 'Freighters and colony ships',
          value: this.count(ships),
          note: `${this.tons(cargo)} of cargo space, ${this.count(colonists)} colonist berths`,
        },
        {
          label: 'Repeating routes',
          value: `${this.routeRows.length}`,
          note: counted.length === this.routeRows.length ? 'All traced' : `${counted.length} counted: ${[untraced ? `${untraced} can't be traced` : null, blocked ? `${blocked} can't load` : null].filter(Boolean).join(', ')}`,
          icon: counted.length === this.routeRows.length ? null : 'mdi-alert',
          iconColor: 'warning',
        },
        {
          label: 'Moved per year',
          value: this.tons(sum('minerals') + sum('installations')),
          note: `${this.tons(sum('minerals'))} minerals, ${this.tons(sum('installations'))} installations, ${this.count(sum('colonists'))} colonists`,
        },
        {
          label: 'Route fuel per year',
          value: this.litres(sum('fuel')),
          note: 'Engines at the set speed, while moving',
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
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    count(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
    tons(value) {
      return `${compact(value || 0)} t`
    },
    litres(value) {
      return `${compact(value || 0)} L`
    },
    gkm(km) {
      return km >= 1e9 ? `${roundToDecimal(km / 1e9, 2)} bn km` : `${roundToDecimal(km / 1e6, 1)} M km`
    },
  },
  asyncComputed: {
    // Classes with cargo or colonist space that can move, and how many of the race's own ships use them.
    classes: {
      get: tracked('classes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_HullDescription.HullAbbr, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency as FuelPerHour, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.ShippingLineID = 0 left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_ShipClass.HullDescriptionID where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID} and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0) and FCT_ShipClass.MaxSpeed > 1 group by FCT_ShipClass.ShipClassID order by Ships desc`).then(([items]) => items)
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
    // Their ships, with cargo shuttle bays, size in tons and crew (for loading time).
    fleetShips: {
      get: tracked('fleetShips', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Ship.FleetID, FCT_Ship.ShipID, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.Size * 50 as Tons, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, coalesce(VIR_Bays.Bays, 0) as Bays from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID left join (select FCT_ClassComponent.ClassID, sum(FCT_ClassComponent.NumComponent) as Bays from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ShipDesignComponents.Name like 'Cargo Shuttle Bay%' group by FCT_ClassComponent.ClassID) as VIR_Bays on VIR_Bays.ClassID = FCT_ShipClass.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    // Those fleets' orders with where each one goes (X, Y) and where the fleet is after it (ExitX,
    // ExitY): jump points (1), bodies (2, 15) and Lagrange points (12). Only a transit (DIM_MoveAction
    // TransitOrder) or an Intra-system Jump (124) comes out on the far side (`Jumps`); any other order
    // on a jump point or Lagrange point leaves the fleet where it went.
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, DIM_MoveAction.Description as ActionName, FCT_MoveOrders.Description, FCT_MoveOrders.DestinationType, case when (FCT_MoveOrders.DestinationType = 1 and DIM_MoveAction.TransitOrder > 0) or (FCT_MoveOrders.DestinationType = 12 and FCT_MoveOrders.MoveActionID = 124) then 1 else 0 end as Jumps, FCT_MoveOrders.PopulationID, FCT_MoveOrders.MaxItems, FCT_MoveOrders.OrderDelay, FCT_Population.PopName, case FCT_MoveOrders.DestinationType when 1 then VIR_Exit.SystemID when 12 then VIR_LagrangeIn.SystemID when 2 then FCT_SystemBody.SystemID when 15 then FCT_SystemBody.SystemID end as SystemID, case FCT_MoveOrders.DestinationType when 1 then VIR_Exit.Xcor when 12 then VIR_LagrangeIn.Xcor when 2 then FCT_SystemBody.Xcor when 15 then FCT_SystemBody.Xcor end as X, case FCT_MoveOrders.DestinationType when 1 then VIR_Exit.Ycor when 12 then VIR_LagrangeIn.Ycor when 2 then FCT_SystemBody.Ycor when 15 then FCT_SystemBody.Ycor end as Y, case FCT_MoveOrders.DestinationType when 1 then VIR_Arrival.SystemID when 12 then VIR_LagrangeOut.SystemID when 2 then FCT_SystemBody.SystemID when 15 then FCT_SystemBody.SystemID end as ExitSystemID, case FCT_MoveOrders.DestinationType when 1 then VIR_Arrival.Xcor when 12 then VIR_LagrangeOut.Xcor when 2 then FCT_SystemBody.Xcor when 15 then FCT_SystemBody.Xcor end as ExitX, case FCT_MoveOrders.DestinationType when 1 then VIR_Arrival.Ycor when 12 then VIR_LagrangeOut.Ycor when 2 then FCT_SystemBody.Ycor when 15 then FCT_SystemBody.Ycor end as ExitY, VIR_ArrivalSystem.Name as ArrivalSystemName, coalesce(VIR_Station.Station, 0) as Station from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 left join DIM_MoveAction on DIM_MoveAction.MoveActionID = FCT_MoveOrders.MoveActionID left join FCT_JumpPoint as VIR_Exit on FCT_MoveOrders.DestinationType = 1 and VIR_Exit.WarpPointID = FCT_MoveOrders.DestinationID left join FCT_JumpPoint as VIR_Arrival on FCT_MoveOrders.DestinationType = 1 and VIR_Arrival.WarpPointID = case when DIM_MoveAction.TransitOrder > 0 then (case when FCT_MoveOrders.NewWarpPointID > 0 then FCT_MoveOrders.NewWarpPointID else VIR_Exit.WPLink end) else FCT_MoveOrders.DestinationID end left join FCT_RaceSysSurvey as VIR_ArrivalSystem on VIR_ArrivalSystem.SystemID = VIR_Arrival.SystemID and VIR_ArrivalSystem.RaceID = FCT_MoveOrders.RaceID and VIR_ArrivalSystem.GameID = FCT_MoveOrders.GameID left join FCT_SystemBody on FCT_MoveOrders.DestinationType in (2, 15) and FCT_SystemBody.SystemBodyID = FCT_MoveOrders.DestinationID left join FCT_LagrangePoint as VIR_LagrangeIn on FCT_MoveOrders.DestinationType = 12 and VIR_LagrangeIn.LagrangePointID = FCT_MoveOrders.DestinationID left join FCT_LagrangePoint as VIR_LagrangeOut on FCT_MoveOrders.DestinationType = 12 and VIR_LagrangeOut.LagrangePointID = case when FCT_MoveOrders.MoveActionID = 124 then FCT_MoveOrders.DestinationItemID else FCT_MoveOrders.DestinationID end left join FCT_Population on FCT_Population.PopulationID = FCT_MoveOrders.PopulationID and FCT_MoveOrders.PopulationID > 0 left join (select FCT_PopulationInstallations.PopID, max(case when DIM_PlanetaryInstallation.CargoShuttleValue > 0 then 1 else 0 end) as Station from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Station on VIR_Station.PopID = FCT_MoveOrders.PopulationID where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.hauling-page {
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

  .panel-foot {
    padding: 12px 24px 16px;
  }

  td {
    font-variant-numeric: tabular-nums;
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
