import { mapGetters } from 'vuex'

import { countText, figureText, isKnownNumber, rangeFigure, thousandsSeparator } from '../utilities/math'

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
      return figureText(this.spanFigure(seconds))
    },
    // A span as a range figure: its number apart from the unit that follows it, so that a range writes the unit once (`5–9 s`), and a span of two parts (`3 min 20 s`, `2 h 5 min`) marked compound, so that a range keeps each end's own text. A dash for a value that is not known.
    spanFigure(seconds) {
      if (!isKnownNumber(seconds)) {
        return rangeFigure('—')
      }

      const whole = Math.round(seconds)

      if (whole < 60) {
        return rangeFigure(`${whole}`, { unit: ' s' })
      } else if (whole < 3600) {
        return whole % 60 ? rangeFigure(`${Math.floor(whole / 60)} min ${whole % 60} s`, { compound: true }) : rangeFigure(`${Math.floor(whole / 60)}`, { unit: ' min' })
      } else if (whole < 86400) {
        const minutes = Math.floor((whole % 3600) / 60)

        return minutes ? rangeFigure(`${Math.floor(whole / 3600)} h ${minutes} min`, { compound: true }) : rangeFigure(`${Math.floor(whole / 3600)}`, { unit: ' h' })
      }

      return this.durationFigure(seconds / 86400)
    },
    // `3 h`, `12.5 d`, `4.1 mo` (30.4-day months), `2.3 y`; the figure of a long span is grouped as a count is (`910'038'079.5 y`). A dash for a value that is not known.
    duration(days) {
      return figureText(this.durationFigure(days))
    },
    // A duration in days as a range figure: its number apart from the unit that follows it, so that a range writes the unit once. A dash for a value that is not known.
    durationFigure(days) {
      if (!isKnownNumber(days)) {
        return rangeFigure('—')
      }

      if (days < 1) {
        return rangeFigure(`${Math.max(1, Math.round(days * 24))}`, { unit: ' h' })
      } else if (days < 60) {
        return rangeFigure(this.count(days, 1), { unit: ' d' })
      } else if (days < 730) {
        return rangeFigure(this.count(days / 30.4, 1), { unit: ' mo' })
      }

      return rangeFigure(this.count(days / 365, 1), { unit: ' y' })
    },
  },
}
