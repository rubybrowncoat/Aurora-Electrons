<template>
  <div class="pool-detail" :data-pool="location.key">
    <template v-if="location.pool">
      <div class="caption text--secondary pool-rule" data-pool-section="rule" data-pool-rule="grouping">{{ settled.grouping.text }}</div>

      <div class="pool-block" data-pool-section="capacity">
        <div class="pool-title">Capacity sources<provenance-mark rule="logistics.maintenancePool" label /></div>
        <v-simple-table dense class="pool-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Kind</th>
              <th>What it holds</th>
              <th class="text-end">Capacity (t)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="source in sourceRows" :key="source.key" :data-source="source.key">
              <td><span data-cell="name">{{ source.name }}</span><page-link v-if="source.link" :to="source.link" :name="source.name" class="ml-1" /></td>
              <td data-cell="kind">{{ source.kind }}</td>
              <td data-cell="detail">{{ source.detail }}</td>
              <td class="text-end text-no-wrap" data-cell="tons">{{ tons(source.tons) }}</td>
            </tr>
          </tbody>
        </v-simple-table>
        <div class="pool-lines caption">
          <div data-pool-line="capacity">Capacity: <span class="text-no-wrap" data-pool-value="capacity">{{ tons(location.capacity) }}</span><provenance-mark :result="location.capacityResult" /></div>
          <div data-pool-line="tonnage">Tonnage of the assigned ships: <span class="text-no-wrap" data-pool-value="tonnage">{{ tons(location.tons) }}</span><provenance-mark :result="location.tonsResult" /></div>
          <div data-pool-line="coverage">Coverage: <span class="text-no-wrap" data-pool-value="coverage">{{ percent(location.rate) }}</span> <span class="text--secondary">(economic modifier <span data-pool-value="modifier">{{ count(location.economicModifier, 2) }}</span>)</span></div>
          <div class="text--secondary">{{ coverageFormula }}</div>
        </div>
        <div v-if="platforms.length" class="caption text--secondary" data-pool-line="platforms">Module platforms with no supply designation add capacity and no shared stock; what they hold stays aboard: <span data-pool-platform>{{ platforms.join(', ') }}</span>.</div>
      </div>

      <div class="pool-block" data-pool-section="providers">
        <div class="pool-title">Stock, in the order it is drawn<provenance-mark rule="logistics.poolDraw" label /></div>
        <v-simple-table dense class="pool-table">
          <thead>
            <tr>
              <th class="text-end">#</th>
              <th>Provider</th>
              <th>Kind</th>
              <th>Where</th>
              <th class="text-end">Stock</th>
              <th class="text-end">Class minimum</th>
              <th>Cargo shuttle bay</th>
              <th class="text-end">Drawn in {{ period }}</th>
              <th class="text-end">Left</th>
              <th class="text-end">Runs out</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="provider in providerRows" :key="provider.key" :data-provider="provider.key">
              <td class="text-end" data-cell="order">{{ provider.order }}</td>
              <td><span data-cell="name">{{ provider.name }}</span><page-link v-if="provider.link" :to="provider.link" :name="provider.name" class="ml-1" /></td>
              <td data-cell="kind">{{ provider.kind }}</td>
              <td data-cell="where">{{ provider.where }}</td>
              <td class="text-end text-no-wrap" data-cell="stock">{{ msp(provider.stock) }}</td>
              <td class="text-end text-no-wrap" data-cell="minimum">{{ provider.minimum === null ? '' : msp(provider.minimum) }}</td>
              <td data-cell="bay">{{ provider.bay }}</td>
              <td class="text-end text-no-wrap" data-cell="used">{{ msp(provider.used) }}</td>
              <td class="text-end text-no-wrap" data-cell="left">{{ msp(provider.left) }}</td>
              <td class="text-end text-no-wrap" data-cell="runout">{{ provider.runOut }}</td>
            </tr>
            <tr v-if="!providerRows.length">
              <td colspan="10" class="text--secondary" data-pool-empty="providers">No colony supports the location and no supply ship is in it.</td>
            </tr>
          </tbody>
        </v-simple-table>
        <div class="pool-lines caption">
          <div data-pool-line="pool">Stock in the pool: <span class="text-no-wrap" data-pool-value="pool">{{ msp(totals.pool) }}</span> (colonies <span class="text-no-wrap" data-pool-value="colonies">{{ msp(totals.colonies) }}</span>, supply ships <span class="text-no-wrap" data-pool-value="supply">{{ msp(totals.supply) }}</span>)</div>
          <div data-pool-line="minimums">Class minimums of the supply ships, held back from transfers and not from maintenance: <span class="text-no-wrap" data-pool-value="minimums">{{ msp(totals.minimums) }}</span>; above the minimums <span class="text-no-wrap" data-pool-value="above">{{ msp(totals.above) }}</span></div>
          <div v-if="location.pool.missingColonies.length" class="warning--text" data-pool-line="missing">{{ location.pool.missingColonies.length }} assigned {{ location.pool.missingColonies.length === 1 ? 'colony is' : 'colonies are' }} not among the race's colonies and not counted.</div>
        </div>
      </div>

      <div class="pool-block" data-pool-section="ships">
        <div class="pool-title">Ships maintained here</div>
        <div v-if="!sim.available" class="caption warning--text" data-pool-line="unavailable">Not worked out: the save lacks {{ sim.missing.join('; ') }}.</div>
        <div v-else class="pool-lines caption">
          <div data-pool-line="mix">{{ mix.ordinary.ships }} in {{ words.states.ordinary.toLowerCase() }} ({{ msp(mix.ordinary.annual) }} MSP a year), {{ mix.overhaul.ships }} in {{ words.states.overhaul.toLowerCase() }} ({{ msp(mix.overhaul.annual) }} MSP a year)</div>
          <div data-pool-line="drawn">Drawn in {{ period }}: colonies <span class="text-no-wrap" data-pool-value="drawnColonies">{{ msp(sim.totals.fromColonies) }}</span>, supply ships <span class="text-no-wrap" data-pool-value="drawnSupply">{{ msp(sim.totals.fromSupply) }}</span>, the ships' own stock <span class="text-no-wrap" data-pool-value="drawnOwn">{{ msp(sim.totals.fromOwn) }}</span>; <span class="text-no-wrap" data-pool-value="short">{{ sim.totals.short }}</span> of <span data-pool-value="shipCount">{{ sim.ships.length }}</span> ships fall short of their request</div>
        </div>
        <v-data-table :headers="shipHeaders" :items="shipRows" item-key="key" :items-per-page="10" :footer-props="{ itemsPerPageOptions: [10, 30, -1] }" dense no-data-text="No ship here needs maintenance." class="pool-ships" data-pool-ships>
          <template #item="{ item }">
            <tr :data-ship="item.key">
              <td class="text-end" data-cell="order">{{ item.order }}</td>
              <td><div class="text-no-wrap" data-cell="name">{{ item.name }}</div><div class="caption text--secondary text-no-wrap">{{ item.fleet }}</div></td>
              <td data-cell="class">{{ item.className }}</td>
              <td data-cell="state">{{ item.state }}</td>
              <td class="text-end" data-cell="priority">{{ count(item.priority) }}</td>
              <td class="text-end text-no-wrap" data-cell="tons">{{ tons(item.tons) }}</td>
              <td class="text-end text-no-wrap" data-cell="annual">{{ msp(item.annual) }}</td>
              <td class="text-end text-no-wrap" data-cell="colonies">{{ msp(item.fromColonies) }}</td>
              <td class="text-end text-no-wrap" data-cell="supply">{{ msp(item.fromSupply) }}</td>
              <td class="text-end text-no-wrap" data-cell="own">{{ msp(item.fromOwn) }}</td>
              <td class="text-end text-no-wrap" data-cell="support">{{ percent(item.support) }}</td>
              <td data-cell="status">{{ item.status }}</td>
            </tr>
          </template>
        </v-data-table>
      </div>

      <div class="pool-block caption" data-pool-section="settled">
        <div class="pool-title">Rules used</div>
        <div v-for="point in points" :key="point.key" :data-pool-point="point.key"><span class="font-weight-medium">{{ point.title }}.</span> {{ point.text }}</div>
      </div>
    </template>
    <template v-else>
      <div class="caption" data-pool-section="rule" data-pool-rule="none">{{ placeText }} {{ settled.grouping.text }}</div>
      <div v-if="location.colonies.length" class="caption" data-pool-line="colonies">Colonies: {{ location.colonies.map((colony) => colony.PopName).join(', ') }}. Their stock is not drawn by any ship.</div>
      <div v-if="location.shipRows.length" class="caption" data-pool-line="ships">Ships: {{ location.shipRows.map((ship) => ship.ShipName).join(', ') }}.</div>
    </template>
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { COVERAGE_FORMULA, OVERHAUL_STATE, POOL_WORDS, SETTLED_POINTS, serviceOrder, shipFigures, simulatePool } from '../../utilities/maintenance-pools'
import { linkTo, place as placeKey } from '../../utilities/deep-links'
import { UNKNOWN_TEXT, isKnownNumber, roundToDecimal } from '../../utilities/math'
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The drill-down of one maintenance location: its capacity sources, the stock providers in the order the game draws them, the ships it maintains with what each draws over the chosen period, and how the grouping rules were read. `location` is a row of `maintenanceLocations` (utilities/logistics.js); a place with no pool says so.
export default {
  name: 'MaintenancePool',
  components: { PageLink, ProvenanceMark },
  mixins: [countFormat],
  props: {
    location: { type: Object, required: true },
    // The length of the period in days (the draw is worked out in daily steps) and its words.
    days: { type: Number, required: true },
    period: { type: String, required: true },
  },
  computed: {
    words() {
      return POOL_WORDS
    },

    coverageFormula() {
      return COVERAGE_FORMULA
    },

    // What a place with no pool says, from what it holds: its ships match no location in their system, its colonies support none (no facilities, no module ship assigned to them). A location of another kind may lie at the same coordinates, so nothing is said of what is nearby.
    placeText() {
      const place = POOL_WORDS.place

      return [this.location.shipRows.length ? place.ships : '', this.location.colonies.length ? place.colonies : ''].filter(Boolean).join(' ')
    },

    points() {
      return SETTLED_POINTS
    },

    settled() {
      return Object.fromEntries(SETTLED_POINTS.map((point) => [point.key, point]))
    },

    sim() {
      return this.location.pool ? simulatePool(this.location.pool, { days: this.days, coverage: this.location.rate }) : null
    },

    simShips() {
      return new Map(this.sim && this.sim.available ? this.sim.ships.map((row) => [row.ShipID, row]) : [])
    },

    simProviders() {
      return new Map(this.sim && this.sim.available ? this.sim.providers.map((row) => [`${row.kind}-${row.id}`, row]) : [])
    },

    sourceRows() {
      return this.location.sources.map((source) => source.kind === 'colony' ? this.colonySource(source) : this.moduleSource(source))
    },

    platforms() {
      return this.location.pool.moduleShips.filter((ship) => shipFigures(ship).designated === false).map((ship) => ship.ShipName)
    },

    providerRows() {
      const pool = this.location.pool
      const located = new Set(this.location.located.map((colony) => colony.PopulationID))
      const byStock = (a, b) => (b.stock === null ? -Infinity : b.stock) - (a.stock === null ? -Infinity : a.stock) || a.id - b.id
      const colonies = pool.colonies.map((colony) => ({ key: `colony-${colony.PopulationID}`, id: colony.PopulationID, kind: POOL_WORDS.providers.colony, name: colony.PopName, where: located.has(colony.PopulationID) ? POOL_WORDS.where.located : POOL_WORDS.where.assigned, stock: isNumber(colony.MaintenanceStockpile) ? colony.MaintenanceStockpile : null, minimum: null, bay: '', link: linkTo.colonyOutlook(colony.PopulationID) })).sort(byStock)
      const supply = pool.supplyShips.map((ship) => ({ key: `supply-${ship.ShipID}`, id: ship.ShipID, kind: POOL_WORDS.providers.supply, name: ship.ShipName, where: POOL_WORDS.where.located, stock: isNumber(ship.CurrentMaintSupplies) ? ship.CurrentMaintSupplies : null, minimum: isNumber(ship.MinimumSupplies) ? ship.MinimumSupplies : null, bay: this.bayText(ship), link: linkTo.routes({ from: placeKey.fleet(ship.FleetID) }) })).sort(byStock)
      const rows = [...colonies, ...supply]
      const order = this.sim && this.sim.available ? this.sim.providers.map((provider) => `${provider.kind}-${provider.id}`) : []
      const own = this.simProviders.get('own-null')
      const ownStart = own ? own.start : null

      if (pool.assigned.length) {
        rows.push({ key: 'own-null', id: null, kind: POOL_WORDS.providers.own, name: `${pool.assigned.length} ${pool.assigned.length === 1 ? 'ship' : 'ships'}`, where: '', stock: ownStart, minimum: null, bay: '', link: null })
      }

      return (order.length ? rows.slice().sort((a, b) => order.indexOf(`${a.key.split('-')[0]}-${a.id}`) - order.indexOf(`${b.key.split('-')[0]}-${b.id}`)) : rows).map((row, index) => {
        const run = this.simProviders.get(`${row.key.split('-')[0]}-${row.id}`)

        return { ...row, order: index + 1, used: run ? run.used : null, left: run ? run.left : null, runOut: run && run.depletedDay !== null ? `day ${run.depletedDay}` : '' }
      })
    },

    totals() {
      const pool = this.location.pool
      const sum = (rows, read) => (rows.some((row) => !isNumber(read(row))) ? null : rows.reduce((total, row) => total + read(row), 0))
      const colonies = sum(pool.colonies, (colony) => colony.MaintenanceStockpile)
      const supply = sum(pool.supplyShips, (ship) => ship.CurrentMaintSupplies)
      const minimums = sum(pool.supplyShips, (ship) => (isNumber(ship.CurrentMaintSupplies) && isNumber(ship.MinimumSupplies) ? Math.min(Math.max(0, ship.CurrentMaintSupplies), ship.MinimumSupplies) : null))
      const above = sum(pool.supplyShips, (ship) => (isNumber(ship.CurrentMaintSupplies) && isNumber(ship.MinimumSupplies) ? Math.max(0, ship.CurrentMaintSupplies - ship.MinimumSupplies) : null))

      return { colonies, supply, pool: colonies === null || supply === null ? null : colonies + supply, minimums, above }
    },

    shipRows() {
      return serviceOrder(this.location.pool.assigned).map((ship, index) => {
        const run = this.simShips.get(ship.ShipID)
        const figures = shipFigures(ship)
        const state = ship.MaintenanceState === OVERHAUL_STATE ? 'overhaul' : 'ordinary'

        return {
          key: ship.ShipID,
          order: index + 1,
          name: ship.ShipName,
          fleet: ship.FleetName,
          className: ship.ClassName,
          state: isNumber(ship.MaintenanceState) ? POOL_WORDS.states[state] : UNKNOWN_TEXT,
          priority: isNumber(ship.MaintPriority) ? ship.MaintPriority : null,
          tons: isNumber(ship.Size) ? ship.Size * 50 : null,
          annual: figures.AnnualUnknown ? null : figures.AnnualMSP,
          fromColonies: run ? run.fromColonies : null,
          fromSupply: run ? run.fromSupply : null,
          fromOwn: run ? run.fromOwn : null,
          support: run ? run.support : null,
          status: run ? (run.full ? POOL_WORDS.support.full : POOL_WORDS.support.short) : POOL_WORDS.support.unknown,
        }
      })
    },

    mix() {
      const mix = { ordinary: { ships: 0, annual: 0 }, overhaul: { ships: 0, annual: 0 } }

      this.location.pool.assigned.forEach((ship) => {
        const entry = mix[ship.MaintenanceState === OVERHAUL_STATE ? 'overhaul' : 'ordinary']

        entry.ships++
        entry.annual += shipFigures(ship).AnnualMSP
      })

      return mix
    },

    shipHeaders() {
      return [
        { text: '#', value: 'order', align: 'end' },
        { text: 'Ship', value: 'name' },
        { text: 'Class', value: 'className' },
        { text: 'State', value: 'state' },
        { text: 'Priority', value: 'priority', align: 'end' },
        { text: 'Size (t)', value: 'tons', align: 'end' },
        { text: 'Need / yr', value: 'annual', align: 'end' },
        { text: `From colonies, ${this.period}`, value: 'fromColonies', align: 'end' },
        { text: `From supply ships, ${this.period}`, value: 'fromSupply', align: 'end' },
        { text: `From own stock, ${this.period}`, value: 'fromOwn', align: 'end' },
        { text: 'Support', value: 'support', align: 'end' },
        { text: 'Stock', value: 'status' },
      ]
    },
  },
  methods: {
    tons(value) {
      return isKnownNumber(value) ? `${this.count(value)} t` : UNKNOWN_TEXT
    },
    msp(value) {
      return isKnownNumber(value) ? this.count(value, 1) : UNKNOWN_TEXT
    },
    colonySource(source) {
      return { key: `colony-${source.id}`, name: source.colony.PopName, kind: POOL_WORDS.sources.colony, detail: `${this.count(source.colony.MaintenanceFacilities)} maintenance facilities`, tons: source.tons, link: linkTo.colonyOutlook(source.id) }
    },
    moduleSource(source) {
      return { key: `module-${source.id}`, name: source.ship.ShipName, kind: POOL_WORDS.sources.module, detail: `${source.ship.Modules === null ? UNKNOWN_TEXT : this.count(source.ship.Modules)} undamaged maintenance modules`, tons: source.tons, link: linkTo.routes({ from: placeKey.fleet(source.ship.FleetID) }) }
    },
    percent(fraction) {
      return isKnownNumber(fraction) ? `${roundToDecimal(fraction * 100, 1)}%` : UNKNOWN_TEXT
    },
    bayText(ship) {
      return ship.Bays === null || ship.Bays === undefined ? POOL_WORDS.bay.unknown : Number(ship.Bays) > 0 ? POOL_WORDS.bay.yes : POOL_WORDS.bay.no
    },
  },
}
</script>

<style lang="scss">
.pool-detail {
  padding: 8px 4px;
  font-variant-numeric: tabular-nums;

  .pool-block {
    margin-top: 12px;
  }

  .pool-title {
    font-weight: 500;
    margin-bottom: 4px;
  }

  .pool-lines {
    margin-top: 4px;
  }
}
</style>
