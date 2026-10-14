<template>
  <div class="missile-draft" :data-draft="draft.key">
    <div class="missile-draft__head d-flex align-center flex-wrap">
      <v-text-field :value="draft.name" label="Name" :error-messages="errors.name" :aria-label="`Name of ${draft.key}`" dense outlined hide-details="auto" class="missile-draft__name" @input="(value) => change({ name: value })" />
      <v-btn-toggle :value="draft.techMode" mandatory dense class="ml-3" @change="(value) => change({ techMode: value })">
        <v-btn value="page" small aria-label="Design with the tech levels of the page">Tech of the page</v-btn>
        <v-btn value="manual" small aria-label="Design with typed tech figures">Typed tech</v-btn>
      </v-btn-toggle>
      <v-spacer />
      <v-btn small text color="error" aria-label="Remove this alternative" data-draft="remove" @click="$emit('remove', draft.key)"><v-icon small left>mdi-close</v-icon>Remove</v-btn>
    </div>
    <div v-if="draft.seededFrom" class="caption text--secondary mt-1">Seeded from design {{ draft.seededFrom }}. The baseline keeps the figures the save stored.</div>
    <div class="missile-draft__fields mt-2">
      <div v-for="field in fields" :key="field.id" class="missile-draft__field" :data-field="field.id">
        <v-text-field :value="draft[field.id]" :label="field.label" :suffix="field.unit" :error-messages="errors[field.id]" :aria-label="`${field.label} of ${draft.name || draft.key}`" dense outlined hide-details="auto" @input="(value) => change({ [field.id]: value })" />
        <div v-if="field.size" class="caption text--secondary">{{ sizeNote(draft[field.id]) }}</div>
      </div>
    </div>
    <div class="missile-draft__options mt-1">
      <div v-for="option in options" :key="option.id" class="missile-draft__option mr-4">
        <v-checkbox :input-value="draft.options[option.id]" :label="option.label" :error="Boolean(blockedReasons[option.id])" dense hide-details class="mt-0" :data-option="option.id" @change="(value) => changeOption(option.id, !!value)" />
        <div v-if="blockedReasons[option.id]" class="caption error--text" :data-blocked="option.id">Not applied: {{ blockedReasons[option.id] }}</div>
      </div>
    </div>
    <div v-if="carried.length" class="caption text--secondary mt-1" data-draft="carried">Carried from the saved design and kept as it was: {{ carried.join(', ') }}.</div>
    <div v-if="draft.techMode === 'manual'" class="missile-draft__manual mt-3">
      <div class="caption text--secondary mb-1">The tech figures typed here stand in for the race's levels: a figure left blank is unknown, and every result built on them is assumed.</div>
      <div class="missile-draft__fields">
        <div v-for="line in manualLines" :key="line.id" class="missile-draft__field" :data-manual="line.id">
          <v-text-field :value="draft.manual[line.id]" :label="line.label" :error-messages="errors[`manual.${line.id}`]" :aria-label="`${line.label} typed for ${draft.name || draft.key}`" dense outlined hide-details="auto" @input="(value) => changeManual(line.id, value)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { LINE_LABELS, emptyManual, sizeOf } from '../../utilities/missile-designer'
import { entered } from '../../utilities/missile-hit'

const FIELDS = [
  { id: 'engines', label: 'Engines', unit: '' },
  { id: 'engineMsp', label: 'Engine size, each', unit: 'MSP', size: true },
  { id: 'thrust', label: 'Thrust modifier', unit: '×' },
  { id: 'fuelMsp', label: 'Fuel', unit: 'MSP', size: true },
  { id: 'warheadMsp', label: 'Warhead', unit: 'MSP', size: true },
  { id: 'warheads', label: 'Warheads', unit: '' },
  { id: 'decoys', label: 'ECM decoys', unit: '' },
  { id: 'activeMsp', label: 'Active sensor', unit: 'MSP', size: true },
  { id: 'thermalMsp', label: 'Thermal sensor', unit: 'MSP', size: true },
  { id: 'emMsp', label: 'EM sensor', unit: 'MSP', size: true },
  { id: 'geoMsp', label: 'Geo sensor', unit: 'MSP', size: true },
  { id: 'resolution', label: 'Sensor resolution', unit: 'HS' },
  { id: 'sizeLimit', label: 'Size limit', unit: 'MSP', size: true },
]

const OPTIONS = [
  { id: 'eccm', label: 'ECCM' },
  { id: 'terminal', label: 'Terminal guidance' },
  { id: 'retarget', label: 'Retargeting' },
  { id: 'laser', label: 'Laser warhead' },
]

const MANUAL_LINES = Object.keys(emptyManual()).map((id) => ({ id, label: LINE_LABELS[id] }))

// The fields of one designed alternative (utilities/missile-designer.js `emptyDraft`), as typed: the page keeps the text and the designer reads it, so text that is not a figure stays on its field with its error and no number replaces it. Sizes are in MSP with the HS and tons beside.
export default {
  name: 'MissileDraftEditor',
  props: {
    draft: {
      type: Object,
      required: true,
    },
    errors: {
      type: Object,
      default: () => ({}),
    },
    blocked: {
      type: Array,
      default: () => [],
    },
  },
  data() {
    return { fields: FIELDS, options: OPTIONS, manualLines: MANUAL_LINES }
  },
  computed: {
    // Why each option asked for is not applied, by option.
    blockedReasons() {
      return Object.fromEntries(this.blocked.map((entry) => [entry.id, entry.reason]))
    },

    carried() {
      const { carried } = this.draft

      return [carried.stages > 0 ? `a second stage (design ${carried.stageId || 'unnamed'})` : '', carried.shipDecoy ? 'a ship decoy warhead' : '', carried.groundPod ? 'a ground attack pod' : '', carried.enhancedRadiation ? 'an enhanced radiation warhead' : ''].filter(Boolean)
    },
  },
  methods: {
    change(patch) {
      this.$emit('input', { ...this.draft, ...patch })
    },

    changeOption(id, value) {
      this.change({ options: { ...this.draft.options, [id]: value } })
    },

    changeManual(id, value) {
      this.change({ manual: { ...this.draft.manual, [id]: value } })
    },

    sizeNote(text) {
      const value = entered(text)
      const size = value === null ? null : sizeOf(value)

      return size ? `${Number(size.hs.toFixed(4))} HS · ${Number(size.tons.toFixed(3))} tons` : ''
    },
  },
}
</script>

<style lang="scss" scoped>
.missile-draft__name {
  max-width: 260px;
}

.missile-draft__fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.missile-draft__field {
  flex: 0 0 150px;
  min-width: 0;
}

.missile-draft__options {
  display: flex;
  flex-wrap: wrap;
}

.missile-draft__option {
  max-width: 260px;
}
</style>
