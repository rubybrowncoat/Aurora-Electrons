<template>
  <div class="handling-breakdown" data-handling-breakdown>
    <div class="caption text--secondary mb-1">Loading strength at each stop, of the ship that sets its time<provenance-mark rule="transport.logisticsBonuses" /></div>
    <div v-if="!rows.length" class="caption text--secondary" data-handling-empty>No stop moves cargo.</div>
    <v-simple-table v-else dense class="handling-breakdown__table">
      <thead>
        <tr>
          <th>Stop</th>
          <th>Ship</th>
          <th class="text-right">Own</th>
          <th v-for="officer in officers" :key="officer.key" class="text-right">{{ officer.label }}</th>
          <th class="text-right">Technology</th>
          <th class="text-right">Added by the colony</th>
          <th class="text-right">Crew</th>
          <th class="text-right">Strength</th>
          <th class="text-right">Time</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :data-stop="row.key" :data-estimate="row.estimate ? 'true' : 'false'">
          <td class="caption">{{ row.stop }}</td>
          <td class="caption">{{ row.ship }}</td>
          <td class="caption text-right text-no-wrap" data-own>{{ figure(row.own) }}<provenance-mark :result="row.results.own" /></td>
          <td v-for="factor in row.factors" :key="factor.key" class="caption text-right text-no-wrap" :class="{ 'warning--text': factor.state === 'unknown' }" :data-officer="factor.key" :data-state="factor.state" :title="factor.text">{{ factor.cell }}<provenance-mark :result="factor.result" /></td>
          <td class="caption text-right text-no-wrap" data-technology>{{ figure(row.technology) }}<provenance-mark :result="row.results.technology" /></td>
          <td class="caption text-right text-no-wrap" data-additive>{{ row.additive ? `+${figure(row.additive)}` : figure(row.additive) }}<provenance-mark :result="row.results.additive" /></td>
          <td class="caption text-right text-no-wrap" data-crew>{{ `×${figure(row.crew)}` }}<provenance-mark :result="row.results.crew" /></td>
          <td class="caption text-right text-no-wrap font-weight-medium" data-strength>{{ figure(row.strength) }}<provenance-mark :result="row.result" /></td>
          <td class="caption text-right text-no-wrap" data-time>{{ hours(row.seconds) }}<provenance-mark :result="row.results.seconds" /></td>
        </tr>
      </tbody>
    </v-simple-table>
    <div v-if="unknownText" class="caption warning--text mt-1" data-handling-unknown>{{ unknownText }}</div>
  </div>
</template>

<script>
import { OFFICERS } from '../../utilities/handling-bonuses'
import { roundToDecimal } from '../../utilities/math'
import ProvenanceMark from './ProvenanceMark.vue'

// The loading strength of the slowest ship at each stop of a run or a cycle, broken into its terms: the ship's own strength, each officer's Logistics factor, the race's technology and what a colony's spaceport or cargo shuttle station adds (which no officer multiplies), then the crew share the time is divided by. `rows` as `handlingRows` (utilities/transport.js) gives them.
export default {
  name: 'HandlingBreakdown',
  components: { ProvenanceMark },
  props: {
    rows: { type: Array, required: true },
  },
  computed: {
    officers() {
      return OFFICERS
    },

    // The officers whose bonus a stop could not settle, with the reason, once each.
    unknownText() {
      const reasons = new Map()

      this.rows.forEach((row) => row.factors.filter((factor) => factor.state === 'unknown').forEach((factor) => reasons.set(`${factor.label}: ${factor.text}`, true)))

      return reasons.size ? `Counted as 1, so the time errs long. ${[...reasons.keys()].join('; ')}.` : ''
    },
  },
  methods: {
    figure(value) {
      return Number.isFinite(value) ? `${roundToDecimal(value, 3)}` : '—'
    },

    hours(seconds) {
      return Number.isFinite(seconds) ? (seconds >= 3600 ? `${roundToDecimal(seconds / 3600, 1)} h` : `${roundToDecimal(seconds / 60, 1)} min`) : '—'
    },
  },
}
</script>

<style lang="scss" scoped>
.handling-breakdown__table {
  max-width: 1100px;
  background: transparent !important;
}
</style>
