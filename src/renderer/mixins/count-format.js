import { mapGetters } from 'vuex'

import { countText, isKnownNumber, roundToDecimal, thousandsSeparator } from '../utilities/math'

// Numbers as the "Thousands Separator" setting writes them, for components that don't read the setting themselves, and spans of days in the unit that reads best.
export default {
  computed: {
    ...mapGetters(['config']),

    separator() {
      return thousandsSeparator(this.config.get('selectedSeparator', 'Tick'))
    },
  },
  methods: {
    // A dash for a value that is not known (null, undefined, NaN), never 0.
    count(value, decimals = 0) {
      return countText(value, decimals, this.separator)
    },
    // Seconds down to the second: `45 s`, `3 min 20 s`, `2 h 5 min`, and days beyond that (`duration`). A dash for a value that is not known.
    span(seconds) {
      if (!isKnownNumber(seconds)) {
        return '—'
      }

      const whole = Math.round(seconds)
      const parts = (big, bigUnit, small, smallUnit) => `${Math.floor(big)} ${bigUnit}${small ? ` ${small} ${smallUnit}` : ''}`

      if (whole < 60) {
        return `${whole} s`
      } else if (whole < 3600) {
        return parts(whole / 60, 'min', whole % 60, 's')
      } else if (whole < 86400) {
        return parts(whole / 3600, 'h', Math.floor((whole % 3600) / 60), 'min')
      }

      return this.duration(seconds / 86400)
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
