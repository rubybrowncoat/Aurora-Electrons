<template>
  <div class="launcher-coverage">
    <div class="launcher-coverage__target">
      <v-text-field :value="jammer" label="Target sensor jammer" :error-messages="jammerProblem" aria-label="Strength of the target's sensor jammer, which cuts the reach of an active sensor" dense outlined hide-details="auto" class="launcher-coverage__figure" data-field="launcher-jammer" @input="(value) => $emit('jammer', value)" />
    </div>
    <div v-for="sensor in sensors" :key="sensor.role" class="launcher-coverage__sensor" :data-launch-sensor="sensor.role">
      <div class="caption text--secondary">{{ sensor.label }}</div>
      <div class="launcher-coverage__row">
        <v-select :value="selection[sensor.role].id" :items="items[sensor.role]" item-text="text" item-value="value" :placeholder="'Typed figures'" :aria-label="`${sensor.label}: a saved sensor of the race`" clearable dense outlined hide-details class="launcher-coverage__pick" :data-field="`launcher-${sensor.role}`" @change="(value) => $emit('sensor', sensor.role, 'id', value === undefined ? null : value)" />
        <v-text-field v-for="part in parts" :key="part.id" :value="selection[sensor.role][part.id]" :label="part.label" :suffix="part.unit" :disabled="selection[sensor.role].id !== null" :error-messages="sensor.problems[part.id]" :aria-label="`${sensor.label}: ${part.label}`" dense outlined hide-details="auto" class="launcher-coverage__figure" :data-field="`launcher-${sensor.role}-${part.id}`" @input="(value) => $emit('sensor', sensor.role, part.id, value)" />
      </div>
      <div class="caption mt-1" :data-coverage="sensor.role">{{ sensor.text }}</div>
    </div>
    <div v-if="!missiles.length" class="caption text--secondary mt-3" data-launcher="no-missiles">No baseline is pinned and no optimisation has been run for the current inputs, so no missile is set beside the sensors yet.</div>
    <v-simple-table v-else dense class="mt-3" data-launcher="missiles">
      <thead>
        <tr>
          <th scope="col">Missile</th>
          <th scope="col">Its own sensor's reach</th>
          <th scope="col">Greatest range</th>
          <th scope="col">Fire control against its range</th>
          <th scope="col">Fire control against its own sensor's reach</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="missile in missiles" :key="missile.label" :data-launcher-missile="missile.label">
          <th scope="row">{{ missile.label }}</th>
          <td :class="{ 'text--disabled': missile.ownReachKm === null }">{{ missile.ownReachText }}</td>
          <td :class="{ 'text--disabled': missile.flightRangeKm === null }">{{ missile.flightRangeText }}</td>
          <td>{{ missile.overFlightText }}</td>
          <td>{{ missile.overOwnReachText }}</td>
        </tr>
      </tbody>
    </v-simple-table>
  </div>
</template>

<script>
// The launching ship's missile fire control and search sensor beside the missile's own sensor and its range: the sensors are chosen among the saved ones of the race or typed, and nothing is added up. The target's sensor jammer is entered here, apart from the missile jammer of the hit chance. It holds no state; each edit of a sensor is emitted as `sensor` with a role, a field and a value, and the jammer as `jammer`.
export default {
  name: 'LauncherCoverage',
  props: {
    sensors: { type: Array, required: true },
    selection: { type: Object, required: true },
    items: { type: Object, required: true },
    missiles: { type: Array, required: true },
    jammer: { type: String, required: true },
    jammerProblem: { type: String, default: '' },
  },
  data() {
    return {
      parts: [{ id: 'rangeKm', label: 'Maximum range', unit: 'km' }, { id: 'resolution', label: 'Resolution', unit: 'HS' }, { id: 'eccm', label: 'ECCM', unit: '' }],
    }
  },
}
</script>

<style lang="scss" scoped>
.launcher-coverage__sensor + .launcher-coverage__sensor {
  margin-top: 12px;
}

.launcher-coverage__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.launcher-coverage__target {
  margin-bottom: 12px;
}

.launcher-coverage__pick {
  flex: 1 1 260px;
  max-width: 380px;
}

.launcher-coverage__figure {
  flex: 0 0 180px;
}
</style>
