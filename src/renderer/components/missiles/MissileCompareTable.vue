<template>
  <div class="missile-compare">
    <v-simple-table dense class="missile-compare__table">
      <thead>
        <tr>
          <th class="missile-compare__label">Row</th>
          <th v-for="column in comparison.columns" :key="column.key" class="missile-compare__head" :data-column="column.key" :data-role="column.role" :data-source="column.source">
            <div class="d-flex align-start justify-space-between">
              <div class="missile-compare__name font-weight-medium">{{ column.name }}</div>
              <v-btn v-if="column.role === 'alternative'" x-small icon :aria-label="`Remove ${column.name}`" data-compare="remove" @click="$emit('remove', column.key)"><v-icon x-small>mdi-close</v-icon></v-btn>
            </div>
            <div class="missile-compare__chips">
              <v-chip x-small :color="column.role === 'baseline' ? 'primary' : undefined" outlined data-compare="role">{{ column.role === 'baseline' ? 'Baseline, pinned' : 'Alternative' }}</v-chip>
              <v-chip x-small :color="column.source === 'hypothetical' || column.source === 'manual' ? 'warning' : undefined" outlined data-compare="source">{{ sourceLabels[column.source] }}</v-chip>
              <v-chip v-if="column.obsolete" x-small outlined data-compare="obsolete">Obsolete</v-chip>
              <v-chip v-if="column.limited" x-small outlined data-compare="limited">Capped at its size limit</v-chip>
            </div>
            <div v-if="column.savedId" class="caption text--secondary">Design {{ column.savedId }}</div>
            <div v-else-if="column.seededFrom" class="caption text--secondary">Seeded from design {{ column.seededFrom }}</div>
            <div v-for="message in column.valid ? [] : Object.values(column.errors)" :key="message" class="caption error--text" data-compare="error">{{ message }}</div>
            <div v-for="entry in column.blocked" :key="entry.id" class="caption error--text" data-compare="blocked" :data-blocked="entry.id">Not applied: {{ entry.reason }}</div>
            <div v-if="column.withheld" class="caption text--secondary" data-compare="withheld">No figure is shown for this column: the option asked for is not applied, so any figure would be that of another missile.</div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr class="missile-compare__section"><th :colspan="comparison.columns.length + 1">Inputs</th></tr>
        <tr v-for="row in inputRows" :key="`input-${row.id}`" :data-row="row.id">
          <th class="missile-compare__label" scope="row">
            <v-tooltip top max-width="320">
              <template #activator="{ on }">
                <span v-on="on">{{ row.label }}<v-icon x-small class="ml-1">mdi-information-outline</v-icon></span>
              </template>
              <span>{{ row.hint }}</span>
            </v-tooltip>
            <span v-if="row.unit" class="caption text--secondary"> {{ row.unit }}</span>
          </th>
          <td v-for="column in comparison.columns" :key="column.key" class="missile-compare__cell">
            <template v-if="column.inputs[row.id] && column.inputs[row.id].value !== null">
              <span class="text-no-wrap">{{ count(column.inputs[row.id].value, row.digits) }}</span>
              <div v-if="column.inputs[row.id].size" class="caption text--secondary text-no-wrap">{{ sizeText(column.inputs[row.id].size) }}</div>
              <div class="caption text--disabled">{{ column.inputs[row.id].basis }}</div>
              <provenance-mark v-if="column.inputs[row.id].result" :result="column.inputs[row.id].result" />
            </template>
            <template v-else>
              <span class="text--disabled">—</span>
              <div class="caption text--secondary">{{ column.inputs[row.id] && column.inputs[row.id].note ? column.inputs[row.id].note : 'Not known' }}</div>
            </template>
          </td>
        </tr>
        <tr class="missile-compare__section"><th :colspan="comparison.columns.length + 1">Figures</th></tr>
        <tr v-for="row in figureRows" :key="`figure-${row.id}`" :data-row="row.id" :class="{ 'missile-compare__planner': row.id === 'planner' }">
          <th class="missile-compare__label" scope="row">
            <v-tooltip top max-width="360">
              <template #activator="{ on }">
                <span v-on="on">{{ row.label }}<v-icon x-small class="ml-1">mdi-information-outline</v-icon></span>
              </template>
              <span>{{ row.hint }}</span>
            </v-tooltip>
            <span v-if="row.unit" class="caption text--secondary"> {{ row.unit }}</span>
            <div class="caption text--disabled">{{ row.precision }}</div>
          </th>
          <td v-for="column in comparison.columns" :key="column.key" class="missile-compare__cell" :data-verdict="column.figures[row.id].verdict">
            <template v-if="column.figures[row.id].value !== null">
              <span class="text-no-wrap font-weight-medium">{{ count(column.figures[row.id].value, row.digits) }}</span><provenance-mark :result="column.figures[row.id].result" />
              <div v-if="column.figures[row.id].size" class="caption text--secondary text-no-wrap">{{ sizeText(column.figures[row.id].size) }}</div>
            </template>
            <template v-else>
              <span class="text--disabled">—</span><provenance-mark :result="column.figures[row.id].result" />
              <div class="caption text--secondary" data-compare="reason">{{ column.figures[row.id].reason }}</div>
            </template>
            <div v-if="column.figures[row.id].verdict" class="missile-compare__stored caption">
              <span class="text--secondary">Saved {{ column.figures[row.id].stored === null ? 'unknown' : count(column.figures[row.id].stored, row.digits) }}</span>
              <v-chip x-small outlined :color="verdictColour(column.figures[row.id].verdict)" class="ml-1" data-compare="verdict">{{ verdictText(column.figures[row.id].verdict) }}</v-chip>
              <div v-if="column.figures[row.id].explained" class="text--secondary">{{ column.figures[row.id].explained }}</div>
            </div>
          </td>
        </tr>
        <tr v-if="rowErrors.length" class="missile-compare__errors" data-compare="row-errors">
          <th class="missile-compare__label" scope="row">Planner figure error</th>
          <td v-for="column in comparison.columns" :key="column.key" class="missile-compare__cell caption error--text">{{ column.rowErrors.join(' ') }}</td>
        </tr>
        <tr class="missile-compare__section"><th :colspan="comparison.columns.length + 1">Options the designer does not build</th></tr>
        <tr v-for="option in gatedOptions" :key="`gated-${option.id}`" :data-row="`gated-${option.id}`">
          <th class="missile-compare__label" scope="row">{{ option.label }}</th>
          <td v-for="column in comparison.columns" :key="column.key" class="missile-compare__cell">
            <v-chip x-small outlined :color="gatedColour(gatedOf(column, option.id).state)" data-compare="gated">{{ gatedStateText(gatedOf(column, option.id).state) }}</v-chip>
            <div class="caption text--secondary">{{ gatedOf(column, option.id).reason }}</div>
          </td>
        </tr>
      </tbody>
    </v-simple-table>
    <div v-for="entry in comparison.refused" :key="entry.key" class="caption warning--text mt-2" data-compare="refused">Not compared: {{ entry.name }}. {{ entry.reason }}</div>
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { FIGURE_ROWS, GATED_OPTIONS, INPUT_ROWS, SOURCE_LABELS, gatedStateText } from '../../utilities/missile-designer'
import ProvenanceMark from '../page/ProvenanceMark.vue'

const VERDICTS = { agree: 'Agrees', differ: 'Differs', unknown: 'Unknown', unsupported: 'Unsupported', none: 'No active sensor' }
const VERDICT_COLOURS = { agree: 'success', differ: 'error', unknown: 'warning', unsupported: 'warning', none: undefined }
const GATED_COLOURS = { 'not-offered': undefined, carried: 'primary', recorded: 'warning', blocked: 'error' }

// The side-by-side table of a comparison (utilities/missile-designer.js `compareDesigns`): one column a missile, the baseline first, with the same rows of inputs, figures and gated options for each, every figure with its provenance mark, a size in MSP, HS and tons, and for a saved design what the save stored beside what the rules rebuild, judged. Nothing is worked out here.
export default {
  name: 'MissileCompareTable',
  components: { ProvenanceMark },
  mixins: [countFormat],
  props: {
    comparison: {
      type: Object,
      required: true,
    },
  },
  data() {
    return { inputRows: INPUT_ROWS, figureRows: FIGURE_ROWS, gatedOptions: GATED_OPTIONS, sourceLabels: SOURCE_LABELS, gatedStateText }
  },
  computed: {
    rowErrors() {
      return this.comparison.rowErrors
    },
  },
  methods: {
    sizeText(size) {
      return `${this.count(size.hs, 4)} HS · ${this.count(size.tons, 3)} tons`
    },

    verdictText(verdict) {
      return VERDICTS[verdict] || verdict
    },

    verdictColour(verdict) {
      return VERDICT_COLOURS[verdict]
    },

    gatedColour(state) {
      return GATED_COLOURS[state]
    },

    gatedOf(column, id) {
      return column.gated.find((entry) => entry.id === id)
    },
  },
}
</script>

<style lang="scss" scoped>
.missile-compare__table {
  overflow-x: auto;
}

.missile-compare__label {
  width: 240px;
  min-width: 200px;
  max-width: 260px;
  white-space: normal !important;
  vertical-align: top;
  padding-top: 6px !important;
  padding-bottom: 6px !important;
}

.missile-compare__head {
  min-width: 190px;
  vertical-align: top;
  padding-top: 6px !important;
  padding-bottom: 6px !important;
}

.missile-compare__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
}

.missile-compare__cell {
  vertical-align: top;
  padding-top: 6px !important;
  padding-bottom: 6px !important;
}

.missile-compare__section th {
  text-align: left;
  font-weight: 600;
  background: rgba(128, 128, 128, 0.12);
}

.missile-compare__planner {
  background: rgba(128, 128, 128, 0.06);
}
</style>
