<template>
  <v-card class="panel colony-worksheet" data-summary="Compare selected bodies side by side by colony cost, population limit and minerals." elevation="1">
    <div class="panel-head">
      <span>Colony comparison<provenance-mark :rule="depositRule" label /></span>
      <span class="d-flex align-center flex-wrap controls">
        <v-autocomplete :value="chosenId" :items="speciesItems" item-text="text" item-value="id" label="Species" placeholder="As the table shows each body" persistent-placeholder dense outlined hide-details clearable class="species-picker" data-control="species" @input="speciesId = $event || null" />
      </span>
    </div>
    <div v-if="loading" class="panel-body caption text--secondary" data-state="loading">The selected bodies are being worked out.</div>
    <div v-else-if="!items.length" class="panel-body caption text--secondary">Select bodies in the table to compare them here.</div>
    <v-simple-table v-else dense class="worksheet-table">
      <thead>
        <tr>
          <th v-for="column in leading" :key="column.key" rowspan="2" class="lead" :class="{ 'name-col': column.key === 'name' }" :aria-sort="ariaSort(column.key)"><button type="button" class="sort" :data-sort="column.key" @click="sortOn(column.key)">{{ column.text }}{{ sortMark(column.key) }}</button></th>
          <th v-for="mineral in minerals" :key="mineral.id" colspan="2" class="mineral" :data-mineral="mineral.id">{{ mineral.name }}</th>
        </tr>
        <tr>
          <template v-for="mineral in minerals">
            <th :key="`amount-${mineral.id}`" :aria-sort="ariaSort(amountKey(mineral.id))"><button type="button" class="sort" :data-sort="amountKey(mineral.id)" @click="sortOn(amountKey(mineral.id))">Amount{{ sortMark(amountKey(mineral.id)) }}</button></th>
            <th :key="`access-${mineral.id}`" :aria-sort="ariaSort(accessKey(mineral.id))"><button type="button" class="sort" :data-sort="accessKey(mineral.id)" @click="sortOn(accessKey(mineral.id))">Access.{{ sortMark(accessKey(mineral.id)) }}</button></th>
          </template>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in sorted" :key="item.id" :data-body="item.id">
          <td class="name-col"><span data-cell="name">{{ item.name }}</span><div v-if="unsurveyed(item)" class="caption text--secondary note" data-note="unsurveyed">Deposits not surveyed</div></td>
          <td><span data-cell="species">{{ item.speciesName || unknown }}</span><div v-if="note(item)" class="caption text--secondary note" :data-note="item.state">{{ note(item) }}</div></td>
          <td class="num"><span data-cell="cost">{{ cost(item.costValue) }}</span><span v-if="item.lowGravity" class="caption"> LG</span><provenance-mark :result="item.results.cost" /></td>
          <td class="num"><span data-cell="capacity">{{ people(item.capacityValue) }}</span><provenance-mark :result="item.results.capacity" /></td>
          <template v-for="cell in item.minerals">
            <td :key="`amount-${cell.id}`" class="num"><span :data-cell="`amount-${cell.id}`">{{ tons(cell.amount) }}</span><provenance-mark :result="cell.amountResult" /></td>
            <td :key="`access-${cell.id}`" class="num"><span :data-cell="`access-${cell.id}`">{{ accessibility(cell.accessibility) }}</span><provenance-mark :result="cell.accessResult" /></td>
          </template>
        </tr>
      </tbody>
    </v-simple-table>
    <div v-if="!loading && items.length" class="panel-foot caption text--secondary">Use it to compare candidate bodies on their raw figures; every column sorts. The cost is the species' colony cost on the body at the worst of its orbit, and the limit is the number of people the body holds before growth stops. Both are the figures of the body detail for the same species. A figure that cannot be worked out shows a dash and names what is missing. Deposits show for bodies the race has surveyed. An unsurveyed body keeps its deposits unknown, and a surveyed body with no deposit of a mineral holds none of it. Amounts and accessibilities are as of the save; later ground surveys and mining change them. The columns are raw figures and are never combined into a score.</div>
  </v-card>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { people } from '../../utilities/colonies'
import { AMOUNT_RULE, SORT_KEYS, accessKey, amountKey, sortWorksheetRows, worksheetRows } from '../../utilities/colony-worksheet'
import { UNKNOWN_TEXT, roundToDecimal } from '../../utilities/math'
import { MINERALS, compact } from '../../utilities/minerals'

const UNKNOWN = UNKNOWN_TEXT

const LEADING = [
  { key: 'name', text: 'Body' },
  { key: 'speciesName', text: 'Species' },
  { key: 'costValue', text: 'Colony cost' },
  { key: 'capacityValue', text: 'Holds' },
]

const positiveInteger = (stored) => (Number.isInteger(stored) && stored > 0 ? stored : undefined)

const SORT_TABLE = tableView('colonyWorksheetTable', { sortBy: ['name'], sortDesc: [false] })

// The stored sort is one column of the worksheet and a direction; anything else is the default.
const sortOf = (stored) => {
  const table = SORT_TABLE.normalise(stored)

  return table && SORT_KEYS.includes([table.sortBy].flat()[0]) ? { sortBy: [[table.sortBy].flat()[0]], sortDesc: [[table.sortDesc].flat()[0] === true] } : undefined
}

export default {
  name: 'ColonyWorksheet',
  components: { ProvenanceMark },
  mixins: [
    persistedView({
      speciesId: { key: 'colonyWorksheetSpecies', default: null, scope: 'race', normalise: positiveInteger },
      table: { ...SORT_TABLE, normalise: sortOf },
    }),
  ],
  props: {
    // The bodies selected in the Planner: references with SystemBodyID, SystemBodyName and SystemName.
    selection: { type: Array, required: true },
    // The Planner's ranked rows before any filter (`rankBodies`): every row holds the evaluation of the body for each species.
    rows: { type: Array, required: true },
    // The race's species, each with SpeciesID and SpeciesName.
    species: { type: Array, required: true },
    // True while the rows are being worked out again; the worksheet shows no figures then, never stale ones.
    loading: { type: Boolean, default: false },
  },
  data() {
    return { leading: LEADING, minerals: MINERALS, depositRule: AMOUNT_RULE, unknown: UNKNOWN }
  },
  computed: {
    speciesItems() {
      return this.species.map((one) => ({ id: one.SpeciesID, text: one.SpeciesName }))
    },
    // The stored species while the race still has it, else none (each body then shows the species the table shows for it).
    chosenId() {
      return this.species.some((one) => one.SpeciesID === this.speciesId) ? this.speciesId : null
    },
    items() {
      return worksheetRows({ rows: this.rows, selection: this.selection, speciesId: this.chosenId })
    },
    sorted() {
      return sortWorksheetRows(this.items, this.table.sortBy, [this.table.sortDesc].flat())
    },
  },
  methods: {
    amountKey,
    accessKey,
    people,
    cost(value) {
      return value === null ? UNKNOWN : roundToDecimal(value, 2).toString()
    },
    tons(value) {
      return value === null ? UNKNOWN : compact(value)
    },
    accessibility(value) {
      return value === null ? UNKNOWN : roundToDecimal(value, 2).toString()
    },
    unsurveyed(item) {
      return item.minerals.every((cell) => cell.status === 'unsurveyed')
    },
    note(item) {
      switch (item.state) {
        case 'unknown':
          return `Not worked out: ${item.missing.join(', ')} missing from the save`
        case 'unfit':
          return `Cannot live there: ${item.reason.toLowerCase()}`
        case 'absent':
          return 'Not among the ranked bodies'
        default:
          return ''
      }
    },
    ariaSort(key) {
      return this.table.sortBy[0] === key ? ([this.table.sortDesc].flat()[0] ? 'descending' : 'ascending') : 'none'
    },
    sortMark(key) {
      return this.table.sortBy[0] === key ? ([this.table.sortDesc].flat()[0] ? ' ▼' : ' ▲') : ''
    },
    sortOn(key) {
      const same = this.table.sortBy[0] === key

      this.table = { sortBy: [key], sortDesc: [same && ![this.table.sortDesc].flat()[0]] }
    },
  },
}
</script>

<style lang="scss" scoped>
.species-picker {
  min-width: 320px;
  max-width: 380px;
}

.worksheet-table {
  th,
  td {
    white-space: nowrap;
    border-right: 1px solid var(--ae-border);
  }

  th {
    padding: 4px 8px;
    text-align: center;
    font-size: calc(12px * var(--ae-font-scale));
  }

  td {
    padding: 4px 8px;
    font-size: calc(13px * var(--ae-font-scale));
  }

  .num {
    text-align: right;
  }

  .lead {
    text-align: left;
  }

  .name-col {
    position: sticky;
    left: 0;
    z-index: 1;
    min-width: 180px;
    background: var(--ae-card);
    text-align: left;
  }

  thead .name-col {
    z-index: 3;
  }

  .sort {
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .note {
    white-space: normal;
    max-width: 240px;
  }
}
</style>
