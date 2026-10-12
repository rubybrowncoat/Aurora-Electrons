<template>
  <div>
    <v-container fluid class="hauling-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" />

        <v-card class="panel" data-summary="The hauls that would cover what my colonies lack of each mineral, from the nearest colony with stock to spare, and what each of my freighter classes takes to carry them." elevation="1">
          <div class="panel-head">
            <span>Hauling plan</span>
            <span class="d-flex align-center flex-wrap plan-tools">
              <v-chip small>Estimates</v-chip>
              <v-switch v-model="planReserves" label="Fill reserves" dense hide-details class="mt-0" />
            </span>
          </div>
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
              <div class="caption text--secondary text-no-wrap">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }}</div>
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
                <div class="caption text--secondary mb-1">My freighter classes on this haul</div>
                <v-simple-table dense class="legs-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th class="text-right">Holds</th>
                      <th class="text-right">Round trip</th>
                      <th class="text-right">One ship</th>
                      <th class="text-right">All its ships</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="estimate in item.estimates" :key="estimate.shipClass.ShipClassID">
                      <td class="caption">{{ estimate.shipClass.ClassName }}</td>
                      <td class="caption text-right">{{ count(estimate.holds) }}</td>
                      <td class="caption text-right text-no-wrap">{{ estimate.timed ? `${fixed(estimate.tripDays, 1)} d` : '—' }}</td>
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
            <div v-for="row in unmetRows" :key="row.key" class="caption">{{ row.name }}: {{ row.text }}</div>
          </div>
          <div class="panel-foot caption text--secondary">
            A colony is short of a mineral when its build queue (industrial projects and shipyard tasks, paused and queued ones too) needs more than it holds with the mass-driver packets on their way to it, and, with Fill reserves on, when it then holds less than its reserve. A colony gives what it holds above both its reserve and what its own queue needs. Queue shortfalls are planned first, the larger first, each from the colony with stock to spare nearest on my charted routes, then the next nearest. Minerals already in a freighter's hold aren't counted. A class's figures are full holds and round trips at top speed with loading and unloading as Transport times them, fully crewed and without Logistics bonuses; the best class is the one a single ship of which finishes soonest. A jump point not stabilised on both sides needs a jump-capable ship with freighters that have no jump drive.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The fleets of mine that run on repeat, with their stops, round trip, cycle time, yearly moves and fuel. Use it to see what each route carries and costs." elevation="1">
          <div class="panel-head">
            <span>Repeating routes</span>
            <v-chip small>Estimates</v-chip>
          </div>
          <v-data-table :headers="routeHeaders" :items="routeRows" item-key="FleetID" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="routesTable.sortBy" :sort-desc.sync="routesTable.sortDesc" :items-per-page.sync="routesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: routePageSizes }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}<page-link :to="item.routesLink" :name="item.routesName" class="ml-1" /></div>
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
              <div v-else-if="item.route.km !== null && !(item.Speed > 0)" class="caption warning--text">Not moving. Left out of the totals.</div>
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
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="What my repeating routes bring to each colony every year, by cargo. Use it to see which colonies depend most on hauling." elevation="1">
              <div class="panel-head"><span>Deliveries by destination</span></div>
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
            <v-card class="panel" data-summary="My freighter classes with their capacity, speed and yearly distance and fuel. Use it to compare which classes haul most efficiently." elevation="1">
              <div class="panel-head"><span>Freighter classes</span></div>
              <v-data-table :headers="classHeaders" :items="classRows" item-key="ShipClassID" :sort-by.sync="classesTable.sortBy" :sort-desc.sync="classesTable.sortDesc" :items-per-page.sync="classesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: summaryPageSizes }" dense>
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

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import StatTiles from '../components/page/StatTiles.vue'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import { STOCK_COLUMNS, colonyMinerals, loadPacketsInFlight, loadQueueNeeds } from '../utilities/colony-minerals'
import { linkTo, place } from '../utilities/deep-links'
import { HAUL_REASONS, haulByClass, planHauls } from '../utilities/haul-plan'
import { classYear, cycleCargo, cycleHandling, routeYear, walkRoute } from '../utilities/hauling'
import { loadJumpPoints } from '../utilities/jump-graph'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { orderPlaceKey } from '../utilities/places'

const INPUT_LABELS = {
  classes: 'the freighter classes',
  fleets: 'the repeating fleets',
  fleetShips: 'their ships',
  orders: 'their orders',
  colonies: 'my colonies',
  needs: 'what their build queues need',
  packets: 'the mass-driver packets in flight',
  jumpPoints: 'the jump points',
  shuttleTechnology: 'my shuttle technology',
}
// DIM_MoveAction: "Move to Location".
const MOVE_TO_LOCATION = 2
const ROUTE_PAGE_SIZES = [15, 30, -1]
const SUMMARY_PAGE_SIZES = [10, 25, -1]

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
  components: { LoadState, PageLink, StatTiles },
  mixins: [
    loadState(INPUT_LABELS),
    persistedView({
      planReserves: { key: 'haulingPlanReserves', default: false },
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
        const routesLink = this.routesLink(fleet, orders)

        return {
          ...fleet,
          route,
          cargo,
          year,
          stopsText: stops.join(' → '),
          routesLink: routesLink.to,
          routesName: routesLink.name,
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

    plan() {
      return planHauls(this.colonyStocks, { jumpPoints: this.jumpPoints, reserves: this.planReserves })
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
      const { freighters, shuttleTechnology, mineralDeliveries } = this
      const reasons = (item) => Object.keys(HAUL_REASONS).filter((reason) => item[reason] >= 1).map((reason) => `${this.tons(item[reason])} ${HAUL_REASONS[reason].label}`).join(', ')

      return this.plan.hauls.map((haul) => {
        const estimates = freighters.map((shipClass) => {
          const estimate = haulByClass(haul, shipClass, shuttleTechnology)
          const note = estimate.status === 'range' ? 'A round trip needs more fuel than its tanks hold' : estimate.status === 'blocked' ? estimate.problems.map((problem) => problem.text).join('; ') : ''

          return { ...estimate, timed: estimate.status === 'ok' || estimate.status === 'range', note }
        }).sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok') || Number(b.timed) - Number(a.timed) || a.oneShipDays - b.oneShipDays)
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
          mineralDetail: `${haul.minerals.map((mineral) => `${mineral.name}: ${reasons(mineral)}`).join('. ')}.`,
          deliveredText: delivered ? `My routes already bring ${this.tons(delivered)} of minerals here a year` : '',
          transportLink: linkTo.transport(ends),
          routesLink: linkTo.routes(ends),
        }
      })
    },

    // What no colony on a charted route can cover, by colony.
    unmetRows() {
      const byColony = new Map()

      this.plan.unmet.forEach(({ colony, mineral, reason, tonnes }) => {
        if (!byColony.has(colony.PopulationID)) {
          byColony.set(colony.PopulationID, { key: colony.PopulationID, name: colony.PopName, parts: [] })
        }

        byColony.get(colony.PopulationID).parts.push(`${mineral.name} ${this.tons(tonnes)} ${HAUL_REASONS[reason].label}`)
      })

      return [...byColony.values()].map((row) => ({ ...row, text: row.parts.join(', ') }))
    },

    planEmptyText() {
      if (this.plan.unmet.length) {
        return 'No colony of mine on a charted route has stock to spare for what the others lack.'
      }

      return this.planReserves ? 'None of my colonies lacks a mineral for its queue or its reserve.' : 'None of my colonies lacks a mineral for its queue.'
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
          value: this.tons(planned),
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
          note: `${counted.length === this.routeRows.length ? 'All traced' : `${counted.length} counted: ${[untraced ? `${untraced} can't be traced` : null, blocked ? `${blocked} can't load` : null, idle ? `${idle} not moving` : null].filter(Boolean).join(', ')}`}; ${this.litres(sum('fuel'))} of fuel a year at the set speed`,
          icon: counted.length === this.routeRows.length ? null : 'mdi-alert',
          iconColor: 'warning',
        },
        {
          label: 'Moved per year',
          value: this.tons(sum('minerals') + sum('installations')),
          note: `${this.tons(sum('minerals'))} minerals, ${this.tons(sum('installations'))} installations, ${this.count(sum('colonists'))} colonists`,
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
    // Classes with cargo or colonist space that can move, how many of the race's own ships use them, and the figures a round trip is timed with.
    classes: {
      get: tracked('classes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_HullDescription.HullAbbr, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency as FuelPerHour, FCT_ShipClass.Size, FCT_ShipClass.CargoShuttleStrength, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.ShippingLineID = 0 left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_ShipClass.HullDescriptionID where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID} and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0) and FCT_ShipClass.MaxSpeed > 1 group by FCT_ShipClass.ShipClassID order by Ships desc`).then(([items]) => items)
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
    // Those fleets' orders with where each one goes (X, Y) and where the fleet is after it (ExitX, ExitY): jump points (1), bodies (2, 15) and Lagrange points (12). Only a transit (DIM_MoveAction TransitOrder) or an Intra-system Jump (124) comes out on the far side (`Jumps`); any other order on a jump point or Lagrange point leaves the fleet where it went.
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, DIM_MoveAction.Description as ActionName, FCT_MoveOrders.Description, FCT_MoveOrders.DestinationType, FCT_MoveOrders.DestinationID, case when (FCT_MoveOrders.DestinationType = 1 and DIM_MoveAction.TransitOrder > 0) or (FCT_MoveOrders.DestinationType = 12 and FCT_MoveOrders.MoveActionID = 124) then 1 else 0 end as Jumps, FCT_MoveOrders.PopulationID, FCT_MoveOrders.MaxItems, FCT_MoveOrders.OrderDelay, FCT_Population.PopName, FCT_Population.RaceID as PopulationRaceID, case FCT_MoveOrders.DestinationType when 1 then VIR_Exit.SystemID when 12 then VIR_LagrangeIn.SystemID when 2 then FCT_SystemBody.SystemID when 15 then FCT_SystemBody.SystemID end as SystemID, case FCT_MoveOrders.DestinationType when 1 then VIR_Exit.Xcor when 12 then VIR_LagrangeIn.Xcor when 2 then FCT_SystemBody.Xcor when 15 then FCT_SystemBody.Xcor end as X, case FCT_MoveOrders.DestinationType when 1 then VIR_Exit.Ycor when 12 then VIR_LagrangeIn.Ycor when 2 then FCT_SystemBody.Ycor when 15 then FCT_SystemBody.Ycor end as Y, case FCT_MoveOrders.DestinationType when 1 then VIR_Arrival.SystemID when 12 then VIR_LagrangeOut.SystemID when 2 then FCT_SystemBody.SystemID when 15 then FCT_SystemBody.SystemID end as ExitSystemID, case FCT_MoveOrders.DestinationType when 1 then VIR_Arrival.Xcor when 12 then VIR_LagrangeOut.Xcor when 2 then FCT_SystemBody.Xcor when 15 then FCT_SystemBody.Xcor end as ExitX, case FCT_MoveOrders.DestinationType when 1 then VIR_Arrival.Ycor when 12 then VIR_LagrangeOut.Ycor when 2 then FCT_SystemBody.Ycor when 15 then FCT_SystemBody.Ycor end as ExitY, VIR_ArrivalSystem.Name as ArrivalSystemName, VIR_Survey.SurveyLocationID, coalesce(VIR_Station.Station, 0) as Station from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0 left join DIM_MoveAction on DIM_MoveAction.MoveActionID = FCT_MoveOrders.MoveActionID left join FCT_JumpPoint as VIR_Exit on FCT_MoveOrders.DestinationType = 1 and VIR_Exit.WarpPointID = FCT_MoveOrders.DestinationID left join FCT_JumpPoint as VIR_Arrival on FCT_MoveOrders.DestinationType = 1 and VIR_Arrival.WarpPointID = case when DIM_MoveAction.TransitOrder > 0 then (case when FCT_MoveOrders.NewWarpPointID > 0 then FCT_MoveOrders.NewWarpPointID else VIR_Exit.WPLink end) else FCT_MoveOrders.DestinationID end left join FCT_RaceSysSurvey as VIR_ArrivalSystem on VIR_ArrivalSystem.SystemID = VIR_Arrival.SystemID and VIR_ArrivalSystem.RaceID = FCT_MoveOrders.RaceID and VIR_ArrivalSystem.GameID = FCT_MoveOrders.GameID left join FCT_SystemBody on FCT_MoveOrders.DestinationType in (2, 15) and FCT_SystemBody.SystemBodyID = FCT_MoveOrders.DestinationID left join FCT_LagrangePoint as VIR_LagrangeIn on FCT_MoveOrders.DestinationType = 12 and VIR_LagrangeIn.LagrangePointID = FCT_MoveOrders.DestinationID left join FCT_LagrangePoint as VIR_LagrangeOut on FCT_MoveOrders.DestinationType = 12 and VIR_LagrangeOut.LagrangePointID = case when FCT_MoveOrders.MoveActionID = 124 then FCT_MoveOrders.DestinationItemID else FCT_MoveOrders.DestinationID end left join FCT_SurveyLocation as VIR_Survey on FCT_MoveOrders.DestinationType = 4 and VIR_Survey.GameID = FCT_MoveOrders.GameID and VIR_Survey.SystemID = FCT_MoveOrders.StartSystemID and VIR_Survey.LocationNumber = FCT_MoveOrders.DestinationID left join FCT_Population on FCT_Population.PopulationID = FCT_MoveOrders.PopulationID and FCT_MoveOrders.PopulationID > 0 left join (select FCT_PopulationInstallations.PopID, max(case when DIM_PlanetaryInstallation.CargoShuttleValue > 0 then 1 else 0 end) as Station from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Station on VIR_Station.PopID = FCT_MoveOrders.PopulationID where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
      }),
      default: [],
    },
    // The race's colonies: stock and reserve of each mineral, the body's place, whether a spaceport or cargo shuttle station works there, and its mass drivers.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [colonies] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.MassDriverDest, ${STOCK_COLUMNS}, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, coalesce(VIR_Installations.Station, 0) as Station, coalesce(VIR_Installations.MassDrivers, 0) as MassDrivers from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join (select FCT_PopulationInstallations.PopID, max(case when DIM_PlanetaryInstallation.CargoShuttleValue > 0 then 1 else 0 end) as Station, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MassDriverValue) as MassDrivers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)

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
    // The race's cargo shuttle technology, which speeds every load and unload.
    shuttleTechnology: {
      get: tracked('shuttleTechnology', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return 1
        }

        const [[race]] = await this.database.query(`select FCT_Race.CargoShuttleLoadModifier from FCT_Race where FCT_Race.RaceID = ${this.RaceID}`)

        return race ? race.CargoShuttleLoadModifier : 1
      }),
      default: 1,
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
