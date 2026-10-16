<template>
  <v-card class="panel mineral-supply" data-summary="What each site extracts of the mineral, how much of that goes into the site's own stock and how much leaves it by a mass-driver route the save names, which packets are on their way to each destination and what each destination holds once they land. Use it to tell stock at an extraction site from supply at a colony that uses it, and to try a hypothetical delivery without assuming one." elevation="1">
    <div class="panel-head">
      <span>Extraction, export and delivered supply<provenance-mark rule="mineralSupply.supply" label /></span>
      <v-chip small>{{ mineralName }}</v-chip>
    </div>
    <div v-if="!supply" class="panel-body caption text--secondary">No mineral is selected.</div>
    <template v-else>
      <div class="px-4">
        <stat-tiles :tiles="tiles" compact />
      </div>
      <div v-if="lostText" class="px-4 pb-2 caption warning--text"><v-icon small color="warning" class="mr-1">mdi-alert-circle-outline</v-icon>{{ lostText }}<provenance-mark :result="supply.lost" /></div>
      <div class="px-4 pt-2 caption font-weight-medium">Sites<provenance-mark rule="mineralSupply.localStock" /></div>
      <v-data-table :headers="siteHeaders" :items="siteRows" item-key="key" :custom-sort="sortNullLast" :sort-by.sync="sitesTable.sortBy" :sort-desc.sync="sitesTable.sortDesc" dense disable-pagination hide-default-footer no-data-text="No site mines the mineral.">
        <template #[`item.name`]="{ item }">
          <div class="py-1">
            <div class="font-weight-medium">{{ item.name }}</div>
            <div v-if="item.system" class="caption text--secondary">{{ item.system }}</div>
          </div>
        </template>
        <template #[`item.connectionRank`]="{ item }">
          <div class="py-1">
            <v-chip x-small label :color="item.view.color || undefined" class="text-no-wrap"><v-icon x-small left>{{ item.view.icon }}</v-icon>{{ item.view.label }}<provenance-mark :result="item.route" /></v-chip>
            <div v-if="item.reason" class="caption text--secondary">{{ item.reason }}</div>
            <div v-for="text in item.gaps" :key="text" class="caption warning--text">Not known: {{ text }}</div>
          </div>
        </template>
        <template v-for="column in figureColumns" #[`item.${column}`]="{ item }">
          <span v-if="item[column] !== null" :key="column" class="text-no-wrap">{{ count(item[column], 0) }}<provenance-mark :result="item[`${column}Result`]" /></span>
          <span v-else :key="column" class="text--secondary text-no-wrap">—<provenance-mark :result="item[`${column}Result`]" /></span>
        </template>
        <template #[`item.destinationName`]="{ item }">
          <span v-if="item.destinationName" class="text-no-wrap">{{ item.destinationName }}</span>
          <span v-else class="text--secondary">None</span>
        </template>
        <template #[`item.scenario`]="{ item }">
          <div class="scenario-cell py-1">
            <v-text-field :value="inputOf(item.populationId).tonnes" type="number" min="0" label="Delivery, t/yr" dense outlined hide-details clearable class="scenario-tonnes" @input="change(item.populationId, { tonnes: $event })" />
            <v-autocomplete :value="inputOf(item.populationId).destinationId" :items="colonies" item-text="name" item-value="id" label="To colony" dense outlined hide-details clearable class="scenario-destination" @input="change(item.populationId, { destinationId: $event === undefined ? null : $event })" />
            <div v-if="item.scenarioText" class="caption" :class="item.scenarioTone ? `${item.scenarioTone}--text` : 'text--secondary'">{{ item.scenarioText }}<provenance-mark v-if="item.scenarioResult" :result="item.scenarioResult" /></div>
          </div>
        </template>
      </v-data-table>
      <div class="px-4 pt-3 caption font-weight-medium">Destinations<provenance-mark rule="mineralSupply.afterArrival" /></div>
      <v-data-table :headers="destinationHeaders" :items="destinationRows" item-key="populationId" :custom-sort="sortNullLast" :sort-by.sync="destinationsTable.sortBy" :sort-desc.sync="destinationsTable.sortDesc" dense disable-pagination hide-default-footer no-data-text="No packet is bound for a colony, and no route or delivery names one.">
        <template #[`item.name`]="{ item }">
          <div class="py-1">
            <div class="font-weight-medium">{{ item.name }}</div>
            <div v-if="item.sitesText" class="caption text--secondary">{{ item.sitesText }}</div>
          </div>
        </template>
        <template v-for="column in destinationColumns" #[`item.${column}`]="{ item }">
          <span v-if="item[column] !== null" :key="column" class="text-no-wrap">{{ count(item[column], 0) }}<provenance-mark :result="item[`${column}Result`]" /></span>
          <span v-else :key="column" class="text--secondary text-no-wrap">—<provenance-mark v-if="item[`${column}Result`]" :result="item[`${column}Result`]" /></span>
        </template>
      </v-data-table>
    </template>
    <div class="panel-foot caption text--secondary">
      A mineral a site extracts goes into that colony's own stock. It supplies industry elsewhere only through a mass-driver packet, and the totals count none of those moves as income. A site with no packet route adds to its own stock and supplies no destination, whatever the homeworld is. The race's civilian complexes, where it buys their output for a destination, put it straight into a packet; stock above the reserve ships only by the site's own drivers. A stored destination that still exists keeps the route whoever owns it, wherever it is and whether or not it has a driver, since only the destination picker offers fewer colonies; a packet adds its minerals to that colony's stock on arrival and is lost when the colony no longer exists. A packet carries no origin in the save, so an arrival is never assigned to a site: each packet counts once, for the colony it is bound for, in flight until it lands there and in that colony's stock after. Observed figures are the ledger's sums over its window, annualised, and are unknown without a ledger, never 0. The ledger records a packet when drivers send stock, not when civilian output goes straight into one, so sent and received tonnes need not match. A civilian purchase choice that is not stored leaves the packet output, the stock added and the supply of a site with a destination unknown. A tonne loaded into a freighter is not a tonne delivered: freighter orders are not read. A hypothetical delivery is an input entered here for one site and one colony, never assumed, never stored and never counted anywhere else; a blank delivery is nothing entered.
    </div>
  </v-card>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'
import StatTiles from '../page/StatTiles.vue'
import countFormat from '../../mixins/count-format'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { ROUTE_STATES, noRouteReason } from '../../utilities/mineral-supply'
import { sortNullLast } from '../../utilities/production'
import { isAvailable, valueOrNull } from '../../utilities/provenance'

const SITE_HEADERS = [
  { text: 'Site', value: 'name' },
  { text: 'Packet route', value: 'connectionRank' },
  { text: 'Extracted, t/yr', value: 'extraction', align: 'end' },
  { text: 'By packet, t/yr', value: 'packetOutput', align: 'end' },
  { text: 'Added to own stock, t/yr', value: 'local', align: 'end' },
  { text: 'Supply to destination, t/yr', value: 'supply', align: 'end' },
  { text: 'Driver capacity, t/yr', value: 'capacity', align: 'end' },
  { text: 'Sent, observed, t/yr', value: 'sent', align: 'end' },
  { text: 'Loaded on freighters, observed, t/yr', value: 'loaded', align: 'end' },
  { text: 'Own stock now, t', value: 'stock', align: 'end' },
  { text: 'Destination', value: 'destinationName' },
  { text: 'Hypothetical delivery', value: 'scenario', sortable: false },
]

const DESTINATION_HEADERS = [
  { text: 'Colony', value: 'name' },
  { text: 'Stock, t', value: 'stock', align: 'end' },
  { text: 'In flight to it, t', value: 'inbound', align: 'end' },
  { text: 'After arrival, t', value: 'afterArrival', align: 'end' },
  { text: 'From sites by route, t/yr', value: 'fromSites', align: 'end' },
  { text: 'Received by packet, observed, t/yr', value: 'received', align: 'end' },
  { text: 'Unloaded from freighters, observed, t/yr', value: 'unloaded', align: 'end' },
  { text: 'Hypothetical, t/yr', value: 'scenario', align: 'end' },
  { text: 'With hypothetical, t/yr', value: 'withScenario', align: 'end' },
]

const FIGURE_COLUMNS = ['extraction', 'packetOutput', 'local', 'supply', 'capacity', 'sent', 'loaded', 'stock']
const DESTINATION_COLUMNS = ['stock', 'inbound', 'afterArrival', 'fromSites', 'received', 'unloaded', 'scenario', 'withScenario']

// What each connection of a site reads as: a label, an icon, a colour and a rank for sorting (the sites that supply first, those not known last).
const CONNECTION_VIEW = {
  packets: { label: ROUTE_STATES.packets, icon: 'mdi-package-variant-closed', color: 'success', rank: 0 },
  driver: { label: ROUTE_STATES.driver, icon: 'mdi-rocket-launch-outline', color: 'success', rank: 1 },
  unconnected: { label: ROUTE_STATES.none, icon: 'mdi-close-circle-outline', color: '', rank: 2 },
  unknown: { label: ROUTE_STATES.unknown, icon: 'mdi-help-circle-outline', color: 'warning', rank: null },
}

const numberOf = (result) => (result ? valueOrNull(result) : null)

// The two kinds of figure of a row as the table reads them: the number, null when not known, and the result it came from.
const figure = (row, column) => ({ [column]: numberOf(row[column]), [`${column}Result`]: row[column] || null })

export default {
  name: 'MineralSupply',
  components: { ProvenanceMark, StatTiles },
  mixins: [
    countFormat,
    persistedView({
      sitesTable: tableView('mineralSupplySitesTable', { sortBy: ['extraction'], sortDesc: true }),
      destinationsTable: tableView('mineralSupplyDestinationsTable', { sortBy: ['inbound'], sortDesc: true }),
    }),
  ],
  props: {
    // The selected mineral, { id, name }, or null.
    mineral: { type: Object, default: null },
    // The result of mineralSupply() for the mineral, or null while there is none.
    supply: { type: Object, default: null },
    // The race's colonies a delivery can be entered for, [{ id, name }].
    colonies: { type: Array, default: () => [] },
    // The hypothetical deliveries entered, { [PopulationID of a site]: { tonnes, destinationId } }; change with `update:scenario`.
    scenario: { type: Object, default: () => ({}) },
  },
  data() {
    return { siteHeaders: SITE_HEADERS, destinationHeaders: DESTINATION_HEADERS, figureColumns: FIGURE_COLUMNS, destinationColumns: DESTINATION_COLUMNS }
  },
  computed: {
    mineralName() {
      return this.mineral ? this.mineral.name : ''
    },
    siteRows() {
      return this.supply.sites.map((site) => {
        const view = CONNECTION_VIEW[site.connection]
        const reason = site.connection === 'unconnected' ? noRouteReason(site.routed) : null
        const entry = site.scenario
        const applied = entry && entry.state === 'applied'

        return {
          key: site.populationId,
          populationId: site.populationId,
          name: site.name,
          system: site.row.SystemName || '',
          view,
          connectionRank: view.rank,
          route: site.route,
          reason: reason ? `${reason[0].toUpperCase()}${reason.slice(1)}` : '',
          gaps: isAvailable(site.route) ? [] : site.route.inputs.missing,
          ...Object.fromEntries(FIGURE_COLUMNS.flatMap((column) => Object.entries(figure(site, column)))),
          destinationName: site.destination ? site.destination.name || `Colony ${site.destination.populationId}` : '',
          scenarioText: this.scenarioText(site, entry),
          scenarioTone: entry && (entry.state !== 'applied' || site.exceeds) ? 'warning' : '',
          scenarioResult: applied ? site.keeps : null,
        }
      })
    },
    destinationRows() {
      return this.supply.destinations.map((destination) => ({
        populationId: destination.populationId,
        name: destination.name,
        sitesText: this.sitesText(destination),
        ...Object.fromEntries(DESTINATION_COLUMNS.flatMap((column) => Object.entries(figure(destination, column)))),
      }))
    },
    tiles() {
      const { empire } = this.supply

      return [
        { label: 'Extracted a year', value: this.tons(empire.extraction), note: 'Mines and orbital miners together; not supply', result: empire.extraction },
        { label: 'Straight into packets a year', value: this.tons(empire.packetOutput), note: 'Civilian output the race buys for a destination', result: empire.packetOutput },
        { label: 'Added to own stock a year', value: this.tons(empire.local), note: 'Stays at the site that extracts it', result: empire.local },
        { label: 'In stock', value: this.tons(empire.stock), note: `Across the race's colonies; ${this.count(empire.destinations, 0)} named as a destination`, result: empire.stock },
        { label: 'In flight', value: this.tons(empire.inFlight), note: 'In packets, in no colony\'s stock', result: empire.inFlight },
        { label: 'Aboard ships', value: this.tons(empire.cargo), note: 'In freighter holds; where they unload is not recorded', result: empire.cargo },
        { label: 'Held in all', value: this.tons(empire.held), note: 'Stock, in flight and aboard ships; a transfer between colonies changes none of it', result: empire.held },
      ]
    },
    lostText() {
      const lost = numberOf(this.supply.lost)

      return lost > 0 ? `${this.count(lost, 0)} t in flight is bound for a colony the race does not have or for no stored destination: it counts as in flight and supplies no destination.` : ''
    },
  },
  methods: {
    sortNullLast,
    tons(result) {
      const value = numberOf(result)

      return value === null ? '—' : `${this.count(value, 0)} t`
    },
    inputOf(populationId) {
      return { tonnes: '', destinationId: null, ...(this.scenario[populationId] || {}) }
    },
    change(populationId, patch) {
      this.$emit('update:scenario', { ...this.scenario, [populationId]: { ...this.inputOf(populationId), ...patch } })
    },
    sitesText(destination) {
      return destination.sites.length ? `${this.count(destination.sites.length, 0)} ${destination.sites.length === 1 ? 'site names' : 'sites name'} it by route` : ''
    },
    scenarioText(site, entry) {
      if (!entry) {
        return ''
      }

      if (entry.state === 'invalid') {
        return 'Enter a number of 0 or more, or clear the field.'
      }

      if (entry.state === 'incomplete') {
        return 'Pick the colony the delivery goes to.'
      }

      const keeps = numberOf(site.keeps)

      if (site.exceeds) {
        return `More than the site adds to its own stock: the delivery draws on stock it holds, ${this.count(-keeps, 0)} t/yr`
      }

      return keeps === null ? 'What the site would keep is not known' : `The site would keep ${this.count(keeps, 0)} t/yr in its own stock`
    },
  },
}
</script>

<style lang="scss">
.mineral-supply {
  .scenario-cell {
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .scenario-tonnes,
  .scenario-destination {
    max-width: 240px;
  }
}
</style>
