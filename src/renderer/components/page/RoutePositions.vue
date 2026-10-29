<template>
  <div class="route-positions caption text--secondary">
    <v-alert v-if="state.failed" type="error" outlined dense class="mb-1">
      Couldn't read {{ state.failed }}: {{ state.error }}. Distances and times hold every position at its saved place with its age unknown.
      <template #append>
        <v-btn small text color="error" @click="$emit('retry')">Retry</v-btn>
      </template>
    </v-alert>
    <template v-if="positions && positions.records.length">
      <div class="route-positions__head">
        <v-btn v-if="collapsed !== null" icon x-small class="mr-1" :aria-label="collapsed ? 'Show the groups of positions' : 'Hide the groups of positions'" :aria-expanded="String(!collapsed)" data-positions-toggle @click="$emit('update:collapsed', !collapsed)"><v-icon small>{{ collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down' }}</v-icon></v-btn>
        <span class="font-weight-medium">{{ modeText }}</span><provenance-mark rule="route.position" />
        <span v-if="state.loading" class="ml-2">Age of the saved positions: reading…</span>
        <span v-else-if="age" class="ml-2">Oldest saved position: <span class="text-no-wrap">{{ ageValue }}</span><provenance-mark :result="age" /></span>
        <span v-if="collapsed" class="ml-2" data-positions-hidden>{{ hiddenText }}</span>
      </div>
      <ul v-if="!collapsed" class="route-positions__groups">
        <li v-for="group in groups" :key="group.key" :data-assumption="group.assumption" :data-supported="String(group.supported)">
          <span class="route-positions__names">{{ names(group) }}</span>: {{ group.text }}.
          <span v-for="condition in group.conditions" :key="condition.code" :data-condition="condition.code" class="route-positions__condition">Unknown: {{ condition.text }}.</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<script>
import { ageResult, ageText, describePositions } from '../../utilities/route-position'
import ProvenanceMark from './ProvenanceMark.vue'

const MODE_TEXT = {
  static: 'Saved positions',
  propagated: 'Positions worked out for the arrival time',
  mixed: 'Saved and worked-out positions',
}

const LISTED = 3

// The positions a route's figures rest on, as the contract states them (utilities/route-position.js): the mode, the age of the oldest saved position and, for each group of endpoints that share an assumption, what is held and what is not known. `positions` is a plan's, a leg's or a row's summary, `state` the read's `{ loading, failed, error }` (mixins/route-position.js). While the read is in flight the age reads as being read, never 0. `collapsed` is null where the groups always show; a boolean shows a toggle that folds the groups away (they can be long on a page with many routes), leaving the count of groups and of those with unknowns, and the host keeps the choice (`:collapsed.sync`).
export default {
  name: 'RoutePositions',
  components: { ProvenanceMark },
  props: {
    positions: {
      type: Object,
      default: null,
    },
    state: {
      type: Object,
      default: () => ({ loading: false, failed: '', error: '' }),
    },
    collapsed: {
      type: Boolean,
      default: null,
    },
  },
  computed: {
    modeText() {
      return MODE_TEXT[this.positions.mode]
    },
    age() {
      return this.state.loading ? null : ageResult(this.positions)
    },
    hiddenText() {
      const unknown = this.groups.filter((group) => group.conditions.length).length

      return `${this.groups.length} ${this.groups.length === 1 ? 'group' : 'groups'}, ${unknown} with unknowns`
    },
    ageValue() {
      return this.age && this.age.status !== 'unavailable' ? ageText(this.age.value) : 'unknown'
    },
    groups() {
      return describePositions(this.positions)
    },
  },
  methods: {
    names(group) {
      const shown = group.names.slice(0, LISTED).join(', ')

      return group.count > LISTED ? `${shown} and ${group.count - LISTED} more` : shown
    },
  },
}
</script>

<style lang="scss" scoped>
.route-positions__groups {
  margin: 2px 0 0;
  padding-left: 16px;
}

.route-positions__condition {
  margin-left: 4px;
}
</style>
