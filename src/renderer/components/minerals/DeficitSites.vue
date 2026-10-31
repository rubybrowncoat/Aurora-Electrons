<template>
  <v-card class="panel deficit-sites" data-summary="Compare surveyed deposits of the selected mineral by how soon a first load could reach the chosen colony." elevation="1">
    <div class="panel-head">
      <span>Sites for a deficit mineral<provenance-mark rule="deficitSites.rank" label /></span>
      <span class="d-flex align-center">
        <v-chip v-if="runwayText" small outlined class="mr-2">{{ runwayText }}<provenance-mark v-if="runway && runway.result" :result="runway.result" /></v-chip>
        <v-chip small>{{ mineralName }}</v-chip>
      </span>
    </div>
    <div v-if="!mineral" class="panel-body caption text--secondary">No mineral is selected.</div>
    <div v-else-if="loading || failed" class="px-4 py-2">
      <load-state :failed="failed" :error="error" :loading="loading" @retry="$emit('retry')" />
    </div>
    <template v-else>
      <div class="px-4 pt-2">
        <v-row dense>
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete :value="destination ? destination.PopulationID : null" :items="colonyItems" item-text="text" item-value="id" label="Deliver to colony" hint="Blank: no route and no arrival time" persistent-hint clearable dense outlined @change="setDestination" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete :value="builder ? builder.colony.PopulationID : null" :items="builderItems" item-text="text" item-value="id" label="Build new mines at" hint="Idle construction capacity, BP/yr" persistent-hint dense outlined @change="setBuilder" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete :value="type ? type.PlanetaryInstallationID : null" :items="typeItems" item-text="text" item-value="id" label="Mine type" :hint="typeItems.length ? 'For a site no mine works yet' : 'The save lists no mine the race can build'" persistent-hint :disabled="!typeItems.length" dense outlined @change="setType" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-text-field v-model="mineCount" label="Number of mines" type="number" min="1" hint="Blank: the new mines are not known" persistent-hint dense outlined :error="mines === null" />
          </v-col>
        </v-row>
        <div class="caption font-weight-medium mt-2">Representative carrier<provenance-mark rule="deficitSites.load" /></div>
        <v-row dense class="mt-0">
          <v-col cols="12" sm="6" md="3">
            <v-text-field :value="speed" type="number" min="0" label="Speed (km/s)" hint="Blank: no travel time" persistent-hint dense outlined @change="setSpeed" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete :value="pickedClass" :items="classItems" item-text="text" item-value="id" label="Take from a ship class" :hint="classItems.length ? 'Its top speed, jump drive and cargo' : 'The race has no ship that moves'" persistent-hint :disabled="!classItems.length" dense outlined @change="takeClass" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-text-field :value="cargo" type="number" min="0" label="Cargo hold (t)" :hint="cargoHint" persistent-hint dense outlined @change="setCargo" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-btn-toggle :value="drive" dense @change="setDrive">
              <v-tooltip v-for="option in drives" :key="option.id" bottom max-width="300">
                <template #activator="{ on }">
                  <v-btn :value="option.id" small v-on="on">{{ option.label }}</v-btn>
                </template>
                <span>{{ option.hint }}</span>
              </v-tooltip>
            </v-btn-toggle>
            <v-switch v-model="lagrange" label="Lagrange jumps" dense hide-details class="mt-1" />
            <div v-if="drive === null" class="caption warning--text">Jump drive not known: no route is flown.</div>
          </v-col>
        </v-row>
      </div>
      <div class="px-4 pb-2 caption text--secondary">{{ summaryText }}</div>
      <div v-for="text in problemTexts" :key="text" class="px-4 pb-2 caption warning--text" data-deficit-problem>Not read: {{ text }}.</div>
      <v-data-table :headers="headers" :items="items" item-key="key" :custom-sort="sortNullLast" :sort-by.sync="sitesTable.sortBy" :sort-desc.sync="sitesTable.sortDesc" :items-per-page.sync="sitesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No surveyed deposit of the mineral is left to list.">
        <template #[`item.order`]="{ item }">
          <span class="font-weight-medium text-no-wrap">{{ item.rank === null ? '—' : item.rank }}<provenance-mark :result="item.rankResult" /></span>
        </template>
        <template #[`item.name`]="{ item }">
          <div class="py-1">
            <div class="font-weight-medium">{{ item.name }}</div>
            <div v-if="item.system" class="caption text--secondary">{{ item.system }}</div>
            <v-chip x-small label class="text-no-wrap" :color="item.view.color || undefined"><v-icon x-small left>{{ item.view.icon }}</v-icon>{{ item.view.label }}</v-chip>
            <v-chip v-if="item.exhausts" x-small label color="warning" class="text-no-wrap ml-1">Holds less than one load</v-chip>
            <div v-for="text in item.notes" :key="text" class="caption text--secondary">{{ text }}</div>
            <div v-if="item.gaps.length" class="caption warning--text">Not known: {{ item.gaps.join('; ') }}</div>
          </div>
        </template>
        <template #[`item.km`]="{ item }">
          <span v-if="item.km !== null" class="text-no-wrap">{{ item.distanceText }}<provenance-mark :result="item.distanceResult" /></span>
          <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.distanceResult" /></span>
        </template>
        <template v-for="column in figureColumns" #[`item.${column}`]="{ item }">
          <span v-if="item[column] !== null" :key="column" class="text-no-wrap">{{ figureText(column, item[column]) }}<provenance-mark :result="item[`${column}Result`]" /></span>
          <span v-else :key="column" class="text--secondary text-no-wrap">—<provenance-mark :result="item[`${column}Result`]" /></span>
        </template>
      </v-data-table>
    </template>
    <div class="panel-foot caption text--secondary">
      Use it to pick the deposit to open first for a mineral the colony is short of. Only deposits on surveyed bodies are listed. Empty deposits and deposits under known alien colonies are excluded. A site already worked by mines needs no deployment. A new site waits for mines to be built at the chosen colony using the idle construction capacity shown on the Production page, then transported to the body. The first load uses the extraction the mines give, with accessibility falling once the deposit is mined past half. One representative carrier returns the load through explored jump points, flying out empty and back loaded. Each tonne of mineral uses two tonnes of its hold. A mass-driver route the save names to the chosen colony delivers now only where the save shows it supplying. The carrier is assumed to be free and at the chosen colony. Loading, refuelling and acceleration take no time in this estimate, and a colony on a new body is not founded here. Sites rank by earliest first delivery, then larger yearly delivery. A site is not ranked if its first delivery is unknown or its deposit holds less than one load.
    </div>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import countFormat from '../../mixins/count-format'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { systemBodyName } from '../../utilities/aurora'
import { DEFAULT_BASIS, DRIVES, DRIVE_IDS, TRANSIT_STATE_TEXT, driveOfClass, normaliseSpeed } from '../../utilities/colony-transit'
import { CARGO_PER_MINERAL, candidatesOf, minedBodies, normaliseCount, rankSites } from '../../utilities/deficit-sites'
import { sortNullLast } from '../../utilities/production'
import { isAvailable, valueOrNull } from '../../utilities/provenance'

const HEADERS = [
  { text: 'Rank', value: 'order' },
  { text: 'Site', value: 'name' },
  { text: 'Amount, t', value: 'amount', align: 'end' },
  { text: 'Accessibility', value: 'accessibility', align: 'end' },
  { text: 'Distance', value: 'km', align: 'end' },
  { text: 'Deployment', value: 'deployment', align: 'end' },
  { text: 'Extraction, t/yr', value: 'extraction', align: 'end' },
  { text: 'First load', value: 'firstLoad', align: 'end' },
  { text: 'Round trip', value: 'roundTrip', align: 'end' },
  { text: 'Empty in', value: 'depletion', align: 'end' },
  { text: 'First delivery', value: 'firstDelivery', align: 'end' },
  { text: 'Delivered, t/yr', value: 'delivered', align: 'end' },
]

const TON_COLUMNS = ['amount', 'accessibility', 'extraction', 'delivered']
const DAY_COLUMNS = ['deployment', 'firstLoad', 'roundTrip', 'depletion', 'firstDelivery']
// The figure cells come from one slot loop: Vue 2 keys a table's scoped slots by the text of the slot name, so a second loop with the same `item.${column}` would replace the first and leave its columns unformatted.
const FIGURE_COLUMNS = [...TON_COLUMNS, ...DAY_COLUMNS]

// Rows per page, with no page of every row: a mineral can have hundreds of surveyed deposits, and drawn at once their rows (some 40 elements each) make every later frame of the Mineral Outlook take seconds to composite, so a hover or a repaint holds the window that long.
const PAGE_SIZES = [15, 30, 60]

// What each state of a site reads as.
const STATE_VIEW = {
  delivering: { label: 'Delivers by mass driver now', icon: 'mdi-rocket-launch-outline', color: 'success' },
  worked: { label: 'Mined now, hauled by the carrier', icon: 'mdi-pickaxe', color: '' },
  new: { label: 'New mines', icon: 'mdi-hammer-wrench', color: '' },
}

const numberOf = (result) => (result ? valueOrNull(result) : null)

// The number of a row's figure, null when not known, and the result it came from.
const figure = (row, column) => ({ [column]: numberOf(row[column]), [`${column}Result`]: row[column] || null })

const idOf = (value) => (Number.isInteger(value) ? value : null)

export default {
  name: 'DeficitSites',
  components: { LoadState, ProvenanceMark },
  mixins: [
    countFormat,
    persistedView({
      destinationId: { key: 'deficitSitesDestination', default: null, scope: 'race', valid: Number.isInteger },
      builderId: { key: 'deficitSitesBuilder', default: null, scope: 'race', valid: Number.isInteger },
      typeId: { key: 'deficitSitesType', default: null, scope: 'race', valid: Number.isInteger },
      mineCount: { key: 'deficitSitesMines', default: '10', scope: 'race', valid: (value) => typeof value === 'string' },
      speed: { key: 'deficitSitesSpeed', default: DEFAULT_BASIS.speed, scope: 'race', normalise: normaliseSpeed },
      cargo: { key: 'deficitSitesCargo', default: null, scope: 'race', normalise: normaliseSpeed },
      drive: { key: 'deficitSitesDrive', default: DEFAULT_BASIS.drive, scope: 'race', valid: (value) => value === null || DRIVE_IDS.includes(value) },
      lagrange: { key: 'deficitSitesLagrange', default: DEFAULT_BASIS.lagrange, scope: 'race', normalise: (stored) => (typeof stored === 'boolean' ? stored : undefined) },
      sitesTable: tableView('deficitSitesTable', { sortBy: ['order'], sortDesc: false, itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  props: {
    // True while the reads behind the shortlist (the surveyed deposits, the routes and mine types) are in flight, and the words that name the ones that failed with the first message; the shortlist is then not shown, never a stale one.
    loading: { type: Boolean, default: false },
    failed: { type: String, default: '' },
    error: { type: String, default: '' },
    // The selected mineral, { id, name }, or null.
    mineral: { type: Object, default: null },
    // The result of mineralSupply() for the mineral, or null while there is none.
    supply: { type: Object, default: null },
    // What `loadSiteDeposits` reads: { deposits, problems }.
    deposits: { type: Object, required: true },
    // What `loadDeploymentSources` reads.
    sources: { type: Object, required: true },
    // The race's colonies as builders, [{ colony, rate }], `rate` the idle construction capacity (BP/yr) as a result.
    builders: { type: Array, default: () => [] },
    // The mineral's runway, { years, result }, or null.
    runway: { type: Object, default: null },
  },
  data() {
    return { headers: HEADERS, figureColumns: FIGURE_COLUMNS, drives: DRIVES, pageSizes: PAGE_SIZES }
  },
  computed: {
    mineralName() {
      return this.mineral ? this.mineral.name : ''
    },
    runwayText() {
      return this.runway && Number.isFinite(this.runway.years) ? `Runway ${this.count(this.runway.years, 1)} y` : ''
    },
    colonyItems() {
      return [...this.sources.colonies].sort((a, b) => a.PopName.localeCompare(b.PopName)).map((colony) => ({ id: colony.PopulationID, text: colony.PopName }))
    },
    destination() {
      return this.sources.colonies.find((colony) => colony.PopulationID === idOf(this.destinationId)) || null
    },
    // The colony that builds new mines: the one chosen, else the one with the most idle construction capacity.
    builder() {
      const chosen = this.builders.find((entry) => entry.colony.PopulationID === idOf(this.builderId))

      if (chosen) {
        return chosen
      }

      const idle = (entry) => (entry.rate && isAvailable(entry.rate) ? entry.rate.value : 0)

      return this.builders.filter((entry) => idle(entry) > 0).sort((a, b) => idle(b) - idle(a))[0] || null
    },
    builderItems() {
      return this.builders.map((entry) => ({ id: entry.colony.PopulationID, text: `${entry.colony.PopName}: ${entry.rate && isAvailable(entry.rate) ? this.count(entry.rate.value, 0) : 'not known'}` }))
    },
    typeItems() {
      return this.sources.types.map((item) => ({ id: item.PlanetaryInstallationID, text: item.Name }))
    },
    type() {
      return this.sources.types.find((item) => item.PlanetaryInstallationID === idOf(this.typeId)) || this.sources.types[0] || null
    },
    mines() {
      return normaliseCount(this.mineCount)
    },
    basis() {
      return { speed: this.speed, drive: this.drive, lagrange: this.lagrange, cargo: this.cargo }
    },
    cargoHint() {
      return this.cargo === null ? 'Blank: no first load' : `A trip takes ${this.count(this.cargo / CARGO_PER_MINERAL, 1)} t of mineral: ${CARGO_PER_MINERAL} t of hold each`
    },
    classItems() {
      const drives = { drive: 'its own jump drive carries it', gates: 'no jump drive that carries it' }

      return this.sources.classes.map((shipClass) => ({ id: shipClass.ShipClassID, text: `${shipClass.ClassName}: ${this.count(shipClass.MaxSpeed)} km/s, ${shipClass.CargoCapacity > 0 ? `${this.count(shipClass.CargoCapacity)} t of hold` : 'no cargo figure'}, ${drives[driveOfClass(shipClass)] || 'jump drive not known'}` }))
    },
    // The ship class whose speed, drive and cargo are the ones set, or null when they match none.
    pickedClass() {
      const found = this.sources.classes.find((shipClass) => normaliseSpeed(shipClass.MaxSpeed) === this.speed && normaliseSpeed(shipClass.CargoCapacity) === this.cargo && [null, this.drive].includes(driveOfClass(shipClass)))

      return found ? found.ShipClassID : null
    },
    candidates() {
      return this.mineral ? candidatesOf({ deposits: this.deposits.deposits, materialId: this.mineral.id }) : { sites: [], excluded: { unsurveyed: 0, exhausted: 0, alienHeld: 0 } }
    },
    mined() {
      return this.supply ? minedBodies(this.supply.sites) : new Map()
    },
    // The sites in rank order: `rankSites` over the deposits the race has surveyed, the mines it already works and the choices above.
    ranked() {
      if (!this.mineral) {
        return []
      }

      return rankSites({ candidates: this.candidates.sites, mined: this.mined, destination: this.destination, builder: this.builder, type: this.type, count: this.mines, basis: this.basis, sources: this.sources, nameOf: (site) => site.SystemBodyName || systemBodyName(site) })
    },
    items() {
      return this.ranked.map((row) => ({
        key: row.key,
        order: row.order,
        rank: row.rank,
        rankResult: row.rankResult,
        name: row.name,
        system: row.system,
        view: STATE_VIEW[row.state],
        exhausts: row.exhausts === true,
        notes: row.notes,
        gaps: isAvailable(row.firstDelivery) ? [] : [...new Set(row.firstDelivery.inputs.missing)].slice(0, 3),
        km: row.out.km,
        distanceText: this.distanceText(row.out),
        distanceResult: row.distance,
        ...Object.fromEntries([...TON_COLUMNS, ...DAY_COLUMNS].flatMap((column) => Object.entries(figure(row, column)))),
      }))
    },
    leftOutText() {
      const { exhausted, alienHeld } = this.candidates.excluded
      const parts = [...(exhausted ? [`${this.count(exhausted, 0)} with nothing left`] : []), ...(alienHeld ? [`${this.count(alienHeld, 0)} under a known alien colony`] : [])]

      return parts.length ? `Left out: ${parts.join(', ')}.` : ''
    },
    summaryText() {
      const ranked = this.ranked.filter((row) => row.rank !== null).length
      const total = this.ranked.length

      return [`${this.count(total, 0)} surveyed ${total === 1 ? 'deposit' : 'deposits'} listed, ${this.count(ranked, 0)} ranked.`, this.leftOutText].filter(Boolean).join(' ')
    },
    problemTexts() {
      return [...this.deposits.problems, ...this.sources.problems.map((problem) => problem.text)]
    },
  },
  methods: {
    sortNullLast,
    // A figure cell's text: a span of days for the day columns, tonnes otherwise, accessibility to two places.
    figureText(column, value) {
      return DAY_COLUMNS.includes(column) ? this.duration(value) : this.count(value, column === 'accessibility' ? 2 : 0)
    },
    // The distance of the flight out in words: how far and how many jumps, or why it is not known.
    distanceText(flight) {
      if (flight.state !== 'routed') {
        return flight.state === 'no-endpoint' ? 'No colony chosen' : flight.state === 'no-drive' ? 'Jump drive not known' : TRANSIT_STATE_TEXT[flight.state]
      }

      return `${this.count(flight.au, 1)} AU, ${flight.jumps} ${flight.jumps === 1 ? 'jump' : 'jumps'}`
    },
    setDestination(value) {
      this.destinationId = idOf(value)
    },
    setBuilder(value) {
      this.builderId = idOf(value)
    },
    setType(value) {
      this.typeId = idOf(value)
    },
    setSpeed(value) {
      this.speed = normaliseSpeed(value)
    },
    setCargo(value) {
      this.cargo = normaliseSpeed(value)
    },
    // The toggle gives nothing when the chosen drive is pressed again: the drive is then not known.
    setDrive(value) {
      this.drive = DRIVE_IDS.includes(value) ? value : null
    },
    // Takes the speed, the drive and the cargo hold of a ship class as they are: what the class does not say (no cargo, an unsettled jump drive) is not known, never the previous carrier's.
    takeClass(id) {
      const found = this.sources.classes.find((shipClass) => shipClass.ShipClassID === id)

      if (found) {
        this.speed = normaliseSpeed(found.MaxSpeed)
        this.drive = driveOfClass(found)
        this.cargo = normaliseSpeed(found.CargoCapacity)
      }
    },
  },
}
</script>
