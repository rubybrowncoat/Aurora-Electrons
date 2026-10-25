<template>
  <div class="fuel-figures" data-fuel-figures :data-fuel-permission="donor.permission">
    <div class="fuel-permission" :class="permissionClass" data-fuel-text="permission">{{ texts.permission }}<provenance-mark :result="donor.results.permission" /></div>
    <div v-if="texts.reason" class="caption text--secondary" data-fuel-text="reason">{{ texts.reason }}</div>
    <div v-if="texts.limit" class="caption text--secondary" data-fuel-text="limit">{{ texts.limit }}</div>
    <div v-for="figure in figures" :key="figure.key" class="fuel-figure caption" :data-fuel-figure="figure.key">
      <span class="text--secondary">{{ figure.label }}</span>
      <span class="text-no-wrap" data-fuel-value>{{ figure.text }}</span>
    </div>
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { FIGURES, donorTexts } from '../../utilities/fuel-donors'
import ProvenanceMark from '../page/ProvenanceMark.vue'

// The permission of a ship to serve fuel with the four figures kept apart: the fuel stored aboard, the class minimum, the local reserve and the surplus that can be served.
export default {
  name: 'FuelFigures',
  components: { ProvenanceMark },
  mixins: [countFormat],
  props: {
    // A result of `fuelDonor` (utilities/fuel-donors.js).
    donor: { type: Object, required: true },
  },
  computed: {
    texts() {
      return donorTexts(this.donor, (value) => `${this.count(value)} L`)
    },

    figures() {
      return FIGURES.map((figure) => ({ ...figure, text: this.texts[figure.key] }))
    },

    permissionClass() {
      return { 'success--text': this.donor.permission === 'allowed', 'warning--text': this.donor.permission === 'blocked', 'text--secondary': this.donor.permission === 'unknown' }
    },
  },
}
</script>

<style lang="scss">
.fuel-figures {
  min-width: 190px;
  padding: 4px 0;
  font-variant-numeric: tabular-nums;

  .fuel-permission {
    font-weight: 500;
  }

  .fuel-figure {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
}
</style>
