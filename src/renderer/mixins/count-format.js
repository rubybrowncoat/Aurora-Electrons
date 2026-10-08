import { mapGetters } from 'vuex'

import { roundToDecimal, separatedNumber, thousandsSeparator } from '../utilities/math'

// Numbers as the "Thousands Separator" setting writes them, for components that don't read the setting themselves,
// and spans of days in the unit that reads best.
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
    // `3 h`, `12.5 d`, `4.1 mo` (30.4-day months), `2.3 y`.
    duration(days) {
      if (days < 1) {
        return `${Math.max(1, Math.round(days * 24))} h`
      } else if (days < 60) {
        return `${roundToDecimal(days, 1)} d`
      } else if (days < 730) {
        return `${roundToDecimal(days / 30.4, 1)} mo`
      }

      return `${roundToDecimal(days / 365, 1)} y`
    },
  },
}
