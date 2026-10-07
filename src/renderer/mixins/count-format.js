import { mapGetters } from 'vuex'

import { roundToDecimal, separatedNumber, thousandsSeparator } from '../utilities/math'

// Numbers as the "Thousands Separator" setting writes them, for components that don't read the setting themselves.
export default {
  computed: {
    ...mapGetters(['config']),

    separator() {
      return thousandsSeparator(this.config.get('selectedSeparator', 'Tick'))
    },
  },
  methods: {
    count(value, decimals = 0) {
      return separatedNumber(roundToDecimal(value || 0, decimals), this.separator)
    },
  },
}
