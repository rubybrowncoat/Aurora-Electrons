import { industryForecastRun } from '../utilities/production'
import { RESPONSIVENESS, RUN_STATUS, TERMINATION, createRun, createRunSlot } from '../utilities/search-run'

// A new task as soon as the browser has had its turn, which still comes in a hidden window.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(null)
})

// The production cycle forecast of the colonies' industrial projects, run a slice at a time with a turn for the browser between slices and kept with the key of the input it was for (`forecastCurrent`: the forecast of what the page holds now, or null while one is running). The host component gives `industryPlans`, { [PopulationID]: `prepareForecast`'s result }; the forecast is run again whenever anything it is made from changes, and only for the colonies that have no gap.
export default {
  data() {
    return {
      forecastState: Object.freeze({ key: null, colonies: null, error: null }),
    }
  },
  computed: {
    // What the run is given: the plain input of the engine for each colony that has one.
    forecastRunInput() {
      return { colonies: Object.entries(this.industryPlans).filter(([, prepared]) => !prepared.gaps).map(([populationId, prepared]) => ({ populationId: Number(populationId), input: prepared.input })) }
    },

    // The input as text: a forecast is the one of this key, and a different key is a different forecast.
    forecastKey() {
      return JSON.stringify(this.forecastRunInput)
    },

    // The forecast the page shows: the outcome of the run kept, only while it is the forecast of what the page holds now.
    forecastCurrent() {
      return this.forecastState.key === this.forecastKey ? this.forecastState : null
    },
  },
  watch: {
    forecastKey: {
      immediate: true,
      handler() {
        this.startForecast()
      },
    },
  },
  beforeDestroy() {
    if (this.forecastSlot) {
      this.forecastSlot.invalidate(TERMINATION.CLOSED)
    }
  },
  methods: {
    // The slot that keeps the one forecast run whose result the page shows; made on first use, not reactive (it holds live generators).
    forecastRunSlot() {
      if (!this.forecastSlot) {
        this.forecastSlot = createRunSlot()
      }

      return this.forecastSlot
    },

    // The search of one run: the colonies' forecasts one after the other.
    forecastSearch(colonies, pace) {
      return industryForecastRun(colonies, pace)
    },

    // Ends the forecast running, if any, and starts the forecast of the colonies as they are now; resolves when that run has ended and its outcome was kept or dropped. A run whose input changed meanwhile is ended and its outcome is never kept.
    startForecast() {
      const slot = this.forecastRunSlot()
      const colonies = Object.entries(this.industryPlans).filter(([, prepared]) => !prepared.gaps).map(([populationId, prepared]) => ({ populationId, prepared }))

      slot.invalidate(TERMINATION.INPUT_CHANGED)

      return this.driveForecast(slot.start(createRun({ kind: 'production-forecast', input: this.forecastRunInput, domain: { signature: 'colony-cycle-forecast', total: colonies.length }, search: (pace) => this.forecastSearch(colonies, pace) })), this.forecastKey)
    },

    // Runs a forecast a slice at a time with a turn for the browser between slices, then keeps its outcome with the key of the input it was for.
    async driveForecast(run, key) {
      const slot = this.forecastRunSlot()

      try {
        while (run.running) {
          run.advance(RESPONSIVENESS.sliceMs)

          if (run.running) {
            await nextTask()
          }

          if (!slot.isCurrent(run)) {
            return
          }
        }

        const outcome = slot.publish(run)

        if (outcome) {
          this.forecastState = Object.freeze({ key, colonies: outcome.result && outcome.status === RUN_STATUS.COMPLETE ? outcome.result.forecasts : null, error: outcome.error || (outcome.status === RUN_STATUS.COMPLETE ? null : 'the forecast was stopped before it finished') })
        }
      } catch (error) {
        if (slot.isCurrent(run)) {
          this.forecastState = Object.freeze({ key, colonies: null, error: error.message })
        }
      }
    },
  },
}
