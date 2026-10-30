<template>
  <v-card class="panel msp-supply" data-summary="The maintenance supplies each colony's facilities make once incoming minerals are counted." elevation="1">
    <div class="panel-head">
      <span class="text-no-wrap">Maintenance supplies with incoming minerals<provenance-mark rule="mspSupply.supplied" label /></span>
      <v-btn-toggle :value="years" mandatory dense class="msp-horizon" @change="$emit('years', $event)">
        <v-btn v-for="option in horizons" :key="option.years" :value="option.years" small>{{ option.label }}</v-btn>
      </v-btn-toggle>
    </div>
    <div v-if="unread" class="px-4 py-2" data-msp-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="$emit('retry')" />
    </div>
    <template v-else>
      <div v-if="problems.length" class="px-4 py-1" data-msp-problems>
        <div v-for="problem in problems" :key="problem.text" class="caption warning--text" data-msp-problem>Not read: {{ problem.text }}.</div>
        <v-btn v-if="retryable" small text color="primary" class="mt-1" data-msp-retry @click="$emit('retry')">Retry</v-btn>
      </div>
      <v-data-table :headers="headers" :items="items" item-key="key" :expanded.sync="expanded" show-expand single-expand :custom-sort="sortNullLast" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" dense no-data-text="No colony makes maintenance supplies." class="msp-supply-table" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
        <template #[`item.name`]="{ item }">
          <div class="py-1">
            <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
            <div v-if="item.place" class="caption text--secondary text-no-wrap">{{ item.place }}</div>
          </div>
        </template>
        <template #[`item.productionValue`]="{ item }">
          <span class="text-no-wrap" :class="{ 'text--secondary': item.productionValue === null }">{{ msp(item.productionValue) }}<provenance-mark :result="item.production" /></span>
        </template>
        <template #[`item.stockOnlyValue`]="{ item }">
          <span class="text-no-wrap" :class="{ 'text--secondary': item.stockOnlyValue === null }">{{ msp(item.stockOnlyValue) }}<provenance-mark :result="item.stockOnly.result" /></span>
          <div class="caption text-no-wrap" :class="item.stockOnly.limiting ? 'error--text' : 'text--secondary'" data-msp-limit>{{ limitText(item.stockOnly) }}</div>
        </template>
        <template #[`item.highValue`]="{ item }">
          <span class="text-no-wrap" :class="{ 'text--secondary': item.highValue === null }">{{ msp(item.highValue) }}<provenance-mark :result="item.high.result" /></span>
          <div class="caption text-no-wrap" :class="item.high.limiting ? 'error--text' : 'text--secondary'" data-msp-limit>{{ limitText(item.high) }}</div>
        </template>
        <template #[`item.lowValue`]="{ item }">
          <span class="text-no-wrap" :class="{ 'text--secondary': item.lowValue === null }">{{ msp(item.lowValue) }}<provenance-mark :result="item.low.result" /></span>
          <div class="caption text-no-wrap" :class="item.low.limiting ? 'error--text' : 'text--secondary'" data-msp-limit>{{ limitText(item.low) }}</div>
        </template>
        <template #[`item.deliveryText`]="{ item }">
          <span v-if="item.high.delivery" class="text-no-wrap" data-msp-delivery>{{ deliveryText(item.high.delivery) }}<provenance-mark :result="item.high.delivery.msp" /></span>
          <span v-else class="text--secondary">None counted<provenance-mark :result="item.high.result" /></span>
        </template>
        <template #[`item.notCountedCount`]="{ item }">
          <span class="text-no-wrap" :class="{ 'warning--text': item.notCountedCount > 0 }" :title="item.notCounted.map((entry) => entry.text).join('; ')">{{ count(item.notCountedCount) }}<provenance-mark rule="mspSupply.supplied" /></span>
        </template>
        <template #expanded-item="{ headers: columns, item }">
          <td :colspan="columns.length" class="pa-3">
            <v-simple-table dense class="msp-deliveries" data-msp-deliveries>
              <thead>
                <tr>
                  <th>Input</th>
                  <th class="text-end">Tonnes</th>
                  <th>Arrives</th>
                  <th class="text-end">Adds, queue idle (MSP/yr)</th>
                  <th class="text-end">Adds, queue first (MSP/yr)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="delivery in item.deliveries" :key="delivery.group">
                  <td>{{ delivery.label }}</td>
                  <td class="text-end text-no-wrap">{{ count(delivery.tonnes.value) }}<provenance-mark :result="delivery.tonnes" /></td>
                  <td class="text-no-wrap">{{ arrivalText(delivery) }}<provenance-mark rule="mspSupply.arrival" /></td>
                  <td class="text-end text-no-wrap">{{ msp(delivery.msp.value) }}<provenance-mark :result="delivery.msp" /></td>
                  <td class="text-end text-no-wrap">{{ delivery.mspLow ? msp(delivery.mspLow.value) : '—' }}<provenance-mark v-if="delivery.mspLow" :result="delivery.mspLow" /></td>
                </tr>
                <tr v-if="!item.deliveries.length">
                  <td colspan="5" class="text--secondary">No mining, packet or haul is counted for the colony.<provenance-mark rule="mspSupply.delivery" /></td>
                </tr>
              </tbody>
            </v-simple-table>
            <div v-for="entry in item.notCounted" :key="entry.kind + entry.text" class="caption warning--text" data-msp-uncounted>Not counted ({{ entry.kind }}): {{ entry.text }}</div>
          </td>
        </template>
      </v-data-table>
      <div class="panel-foot caption text--secondary">
        Use it to see which input mineral limits the output and which delivery it waits for. The colony's stock alone makes the stock-only output, the figure of the table above, and the supplied output adds what mining, packets and hauls bring, each on the day it arrives. It takes out the colony's own claims in the game's order: the build queue, then the mass driver export of stock above the reserve, then maintenance, which no reserve protects; the queue is shown idle and served first, since the saved projects show what they still need and not when they draw it. A colony gives to a haul only what its own production leaves, and each freighter serves one haul of the plan, in the planner's order. All the mining on a body draws on its deposit together, taxed output included, and the colony keeps only its own share. A delivery with no timing or no size is listed and left out, never counted as 0. Packets the colonies launch during the period are not counted.
      </div>
    </template>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import countFormat from '../../mixins/count-format'
import { UNKNOWN_TEXT } from '../../utilities/math'
import { sortNullLast } from '../../utilities/production'
import { valueOrNull } from '../../utilities/provenance'

export default {
  name: 'MspSupply',
  components: { LoadState, ProvenanceMark },
  mixins: [countFormat],
  props: {
    // The rows of `mspSupplyRows` (utilities/msp-supply.js), each with the page's `place` and `name`; null while the read is not in.
    rows: {
      type: Array,
      default: null,
    },
    // The read's own state: { loading, failed, error }.
    state: {
      type: Object,
      required: true,
    },
    // The sources the read could not make: [{ source, text }].
    problems: {
      type: Array,
      default: () => [],
    },
    years: {
      type: Number,
      required: true,
    },
    horizons: {
      type: Array,
      required: true,
    },
  },
  data() {
    return {
      expanded: [],
      sortNullLast,
    }
  },
  computed: {
    unread() {
      return Boolean(this.state.loading || this.state.failed || !this.rows)
    },

    retryable() {
      return this.problems.some((problem) => problem.retry)
    },

    headers() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Production / yr', value: 'productionValue', align: 'end' },
        { text: 'Stock only / yr', value: 'stockOnlyValue', align: 'end' },
        { text: 'Supplied, queue idle / yr', value: 'highValue', align: 'end' },
        { text: 'Supplied, queue first / yr', value: 'lowValue', align: 'end' },
        { text: 'Conditional delivery', value: 'deliveryText' },
        { text: 'Not counted', value: 'notCountedCount', align: 'end' },
      ]
    },

    items() {
      return (this.rows || []).map((row) => ({
        ...row,
        key: row.populationId,
        productionValue: valueOrNull(row.production),
        stockOnlyValue: valueOrNull(row.stockOnly.result),
        highValue: valueOrNull(row.high.result),
        lowValue: valueOrNull(row.low.result),
        deliveryText: row.high.delivery ? row.high.delivery.label : '',
        notCountedCount: row.notCounted.length,
      }))
    },
  },
  methods: {
    msp(value) {
      return value === null ? UNKNOWN_TEXT : this.count(value, Math.abs(value) < 100 ? 1 : 0)
    },

    limitText(figure) {
      return valueOrNull(figure.result) === null ? 'Not known' : figure.limiting ? `Limited by ${figure.limiting}` : 'At full production'
    },

    arrivalText(delivery) {
      if (delivery.firstDay === null) {
        return UNKNOWN_TEXT
      }

      return delivery.firstDay === delivery.lastDay ? `Day ${delivery.firstDay}` : `Days ${delivery.firstDay} to ${delivery.lastDay}`
    },

    deliveryText(delivery) {
      return `${delivery.label}: ${this.count(delivery.tonnes.value)} t, ${this.arrivalText(delivery).toLowerCase()}`
    },
  },
}
</script>
