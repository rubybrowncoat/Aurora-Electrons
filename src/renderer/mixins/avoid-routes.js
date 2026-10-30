import { AVOID_OPTIONS, avoidRules } from '../utilities/safe-routes'

const NO_SYSTEMS = Object.freeze([])

// The avoid preferences of a page that plans runs (Transport, Hauling): the page keeps the three fields of `avoidFields` (persisted per race), tracks the read as `avoidSystems` (an async computed over `loadPlannedAvoidSystems`), labels it in `INPUT_LABELS` and leaves it out of the reads that hold the page back. While the read is in flight or failed and a preference is on, nothing is planned over a guess: `avoidPending` is true and the page gives no route and says why, instead of the baseline route as if the preferences were met.
export default {
  data() {
    return { avoidOptionList: AVOID_OPTIONS }
  },
  computed: {
    avoidSettings() {
      return { avoidDanger: this.avoidDanger, avoidAlien: this.avoidAlien, skipNoAutoRoute: this.skipNoAutoRoute }
    },

    avoidActive() {
      return AVOID_OPTIONS.some((option) => this.avoidSettings[option.key])
    },

    // How many preferences are on, for the menu's button.
    avoidCount() {
      return AVOID_OPTIONS.filter((option) => this.avoidSettings[option.key]).length
    },

    // The read's own state: { loading, failed, error }.
    avoidState() {
      const state = this.loadErrors.avoidSystems

      return { loading: state === undefined, failed: typeof state === 'string', error: typeof state === 'string' ? state : '' }
    },

    // The systems read, or null until the read has succeeded.
    avoidRead() {
      return this.loadErrors.avoidSystems === null ? this.avoidSystems : null
    },

    // A preference is on and the systems it reads are not in: no run can be planned under it yet.
    avoidPending() {
      return this.avoidActive && this.avoidRead === null
    },

    // The preferences applied to the known systems; nothing is avoided while none is on or the read is not in.
    avoid() {
      return avoidRules(this.avoidRead || NO_SYSTEMS, this.avoidSettings, (value) => this.count(value))
    },

    // What to say while the read is not in and a preference is on, { tone, text }, or null.
    avoidNote() {
      if (!this.avoidPending) {
        return null
      }

      const { failed, error } = this.avoidState

      return failed ? { tone: 'warning--text', text: `The avoid settings can't be applied: the danger and control of the systems could not be read (${error}).` } : { tone: 'text--secondary', text: 'The avoid settings are applied once the danger and control of the systems are read.' }
    },
  },
  methods: {
    setAvoid(key, value) {
      this[key] = Boolean(value)
    },

    retryAvoid() {
      this.$asyncComputed.avoidSystems.update()
    },
  },
}
