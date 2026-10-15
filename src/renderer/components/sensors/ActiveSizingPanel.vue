<template>
  <div class="active-sizing" data-sensors="sizing">
    <div v-for="scenario in views" :key="scenario.key" class="active-sizing__scenario" :data-sizing-scenario="scenario.key">
      <div v-if="views.length > 1" class="subtitle-2 mb-1">{{ scenario.label }}</div>
      <div v-for="problem in scenario.problems" :key="problem" class="caption warning--text mb-1" data-sizing="problem">{{ problem }}</div>
      <div v-if="scenario.empty" class="caption text--secondary" data-sizing="empty">{{ scenario.empty }}</div>
      <v-simple-table v-else dense :data-sizing-table="scenario.key">
        <thead>
          <tr>
            <th class="text-right">Resolution (HS)</th>
            <th class="text-right">Search size (HS)</th>
            <th class="text-right">Search reach (million km)</th>
            <th class="text-right">Fire control size (HS)</th>
            <th class="text-right">Fire control reach (million km)</th>
            <th class="text-right">Pair size (HS)</th>
            <th class="text-right">Pair cost (BP)</th>
            <th class="text-right">Uridium</th>
            <th class="text-right">Corbomite</th>
            <th class="text-right">Crew</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in scenario.rows" :key="row.key" :class="{ 'is-selected': row.selected, 'text--secondary': !row.feasible }" :data-sizing-row="row.resolution">
            <td class="text-right text-no-wrap">{{ shown(row.resolutionResult, 0) }}<provenance-mark :result="row.resolutionResult" /><v-chip v-if="row.best" x-small outlined class="ml-2" data-sizing="best">Best</v-chip></td>
            <td class="text-right text-no-wrap" data-sizing="search-size">{{ shown(row.search.size, 2) }}<provenance-mark :result="row.search.size" /></td>
            <td class="text-right text-no-wrap" data-sizing="search-reach">{{ shown(row.search.reach, 3, MILLION) }}<provenance-mark :result="row.search.reach" /></td>
            <td class="text-right text-no-wrap" data-sizing="fire-control-size">{{ shown(row.fireControl.size, 2) }}<provenance-mark :result="row.fireControl.size" /></td>
            <td class="text-right text-no-wrap" data-sizing="fire-control-reach">{{ shown(row.fireControl.reach, 3, MILLION) }}<provenance-mark :result="row.fireControl.reach" /></td>
            <td class="text-right text-no-wrap" data-sizing="pair-size">{{ shown(row.totalHS, 2) }}<provenance-mark :result="row.totalHS" /></td>
            <td class="text-right text-no-wrap" data-sizing="pair-cost">{{ shown(row.totalCost, 1) }}<provenance-mark :result="row.totalCost" /></td>
            <td class="text-right text-no-wrap">{{ shown(row.uridium, 1) }}<provenance-mark :result="row.uridium" /></td>
            <td class="text-right text-no-wrap">{{ shown(row.corbomite, 1) }}<provenance-mark :result="row.corbomite" /></td>
            <td class="text-right text-no-wrap">{{ shown(row.crew, 0) }}<provenance-mark :result="row.crew" /></td>
            <td data-sizing="verdict">{{ row.verdict }}</td>
          </tr>
        </tbody>
      </v-simple-table>
    </div>
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { isAvailable } from '../../utilities/provenance'
import { sizingEmpty, sizingRows } from '../../utilities/sensor-view'
import ProvenanceMark from '../page/ProvenanceMark.vue'

// Ranges are listed in millions of km.
const MILLION = 1e6

// The sizing table of the Sensor Planner's active mode: for each legal resolution the smallest search sensor and the smallest missile fire control that reach the wanted range against the target, their ranges, and the pair's size, cost, minerals and crew, or which member has no legal size that reaches it. `scenarios` is [{ key, label, sizing }], each `sizing` the result of `activeSizing` (utilities/sensor-planner.js); a target with a cloak has a second scenario, the cloak damaged. It holds no state and no panel: the page or the embed that shows it gives the head and the rules.
export default {
  name: 'ActiveSizingPanel',
  components: { ProvenanceMark },
  mixins: [countFormat],
  props: {
    scenarios: { type: Array, required: true },
  },
  data() {
    return { MILLION }
  },
  computed: {
    views() {
      return this.scenarios.map(({ key, label, sizing }) => ({ key, label, problems: sizing.problems, empty: sizingEmpty(sizing.request), rows: sizingRows(sizing) }))
    },
  },
  methods: {
    // A figure of a result as text, divided by `divisor`: Unknown for a result with no value, never 0.
    shown(result, decimals = 0, divisor = 1) {
      return isAvailable(result) ? this.count(result.value / divisor, decimals) : 'Unknown'
    },
  },
}
</script>

<style lang="scss" scoped>
.active-sizing__scenario + .active-sizing__scenario {
  margin-top: 16px;
}

.is-selected {
  background: var(--ae-row-selected);
}

td {
  font-variant-numeric: tabular-nums;
}
</style>
