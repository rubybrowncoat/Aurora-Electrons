<template>
  <div class="missile-optimiser">
    <div class="missile-optimiser__row">
      <div class="missile-optimiser__field missile-optimiser__field--goal">
        <div class="caption text--secondary missile-optimiser__label">Goal</div>
        <v-select :value="fields.goal" :items="goals" item-text="label" item-value="id" aria-label="Goal of the optimisation" :error-messages="errors.goal" dense outlined hide-details="auto" data-field="optimiser-goal" @change="(value) => $emit('field', 'goal', value)" />
      </div>
      <div v-for="limit in limits" :key="limit.id" class="missile-optimiser__field">
        <div class="caption text--secondary missile-optimiser__label">{{ limit.label }}</div>
        <v-text-field :value="fields[limit.id]" :suffix="limit.unit" :aria-label="limit.aria" :error-messages="errors[limit.id]" dense outlined hide-details="auto" :data-field="`optimiser-${limit.id}`" @input="(value) => $emit('field', limit.id, value)" />
      </div>
    </div>
    <div class="caption text--secondary mt-1" data-optimiser="goal-text">{{ goalText }}</div>
    <div class="missile-optimiser__row mt-3">
      <v-simple-table dense class="missile-optimiser__domain">
        <thead>
          <tr>
            <th scope="col">Swept figure</th>
            <th v-for="part in parts" :key="part.id" scope="col">{{ part.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="axis in axes" :key="axis.name" :data-axis="axis.name">
            <th scope="row">{{ axis.label }}<span v-if="axis.unit" class="text--secondary"> ({{ axis.unit }})</span></th>
            <td v-for="part in parts" :key="part.id">
              <v-text-field :value="fields[axis.name][part.id]" :aria-label="`${axis.label}, ${part.label.toLowerCase()}`" :error-messages="errors[`${axis.name}.${part.id}`]" dense outlined hide-details="auto" :data-field="`optimiser-${axis.name}-${part.id}`" @input="(value) => $emit('axis', axis.name, part.id, value)" />
            </td>
          </tr>
        </tbody>
      </v-simple-table>
      <div class="missile-optimiser__options">
        <div v-for="option in options" :key="option.name" class="missile-optimiser__field">
          <div class="caption text--secondary missile-optimiser__label">{{ option.label }}</div>
          <v-select :value="fields[option.name]" :items="modes" item-text="text" item-value="value" :aria-label="`${option.label}: off, on or tried both ways`" :error-messages="errors[option.name]" dense outlined hide-details="auto" :data-field="`optimiser-${option.name}`" @change="(value) => $emit('field', option.name, value)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
// The form of the missile optimiser: the goal and its limits, the figures swept and the options tried. It holds no state; each edit is emitted for the page to keep (`field` with a name and a value, `axis` with a figure, a part and a value).
export default {
  name: 'MissileOptimiser',
  props: {
    fields: { type: Object, required: true },
    errors: { type: Object, required: true },
    goals: { type: Array, required: true },
    goalText: { type: String, default: '' },
    axes: { type: Array, required: true },
    options: { type: Array, required: true },
  },
  data() {
    return {
      parts: [{ id: 'min', label: 'Least' }, { id: 'max', label: 'Greatest' }, { id: 'step', label: 'Step' }],
      modes: [{ text: 'Off', value: 'off' }, { text: 'On', value: 'on' }, { text: 'Both ways', value: 'either' }],
      limits: [
        { id: 'maxMsp', label: 'Size limit', unit: 'MSP', aria: 'Greatest size of the missile in MSP' },
        { id: 'maxBp', label: 'BP limit', unit: 'BP', aria: 'Greatest cost of the missile in BP, blank for none' },
        { id: 'minRangeKm', label: 'Least range', unit: 'km', aria: 'Least range of the missile in km, blank for none' },
        { id: 'minSpeed', label: 'Least speed', unit: 'km/s', aria: 'Least speed of the missile in km/s, blank for none' },
        { id: 'hitChance', label: 'Hit chance', unit: '%', aria: 'Hit chance to reach in percent' },
        { id: 'keep', label: 'Results to keep', unit: '', aria: 'Number of results to keep in the table' },
      ],
    }
  },
}
</script>

<style lang="scss" scoped>
.missile-optimiser__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 16px;
}

.missile-optimiser__field {
  flex: 0 0 150px;
  min-width: 0;
}

.missile-optimiser__field--goal {
  flex: 1 1 260px;
  max-width: 380px;
}

.missile-optimiser__label {
  height: calc(18px * var(--ae-font-scale));
  line-height: calc(18px * var(--ae-font-scale));
  white-space: nowrap;
}

.missile-optimiser__domain {
  flex: 1 1 520px;
  max-width: 720px;
}

.missile-optimiser__options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
</style>
