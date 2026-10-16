import { supportNote } from '../utilities/handling-bonuses'

// The optional read of the officers' Logistics bonuses on a page that times cargo handling (Transport, Hauling). The page tracks the read as `handlingSupport` (an async computed over `loadHandlingSupport`), labels it in `INPUT_LABELS` and leaves it out of the reads that hold the page back, as the Mineral Outlook does for its sites panel: while it is in flight or failed the page renders at once with every officer unknown, so the loading times are estimates that err long, and this mixin says so.
export default {
  computed: {
    // The read's own state: { loading, failed, error }.
    handlingSupportState() {
      const state = this.loadErrors.handlingSupport

      return { loading: state === undefined, failed: typeof state === 'string', error: typeof state === 'string' ? state : '' }
    },

    // What the loading maths takes: the officers read, or null until the read has succeeded (an officer not read is unknown, never 1).
    officerSupport() {
      return this.loadErrors.handlingSupport === null ? this.handlingSupport : null
    },

    // What to say about how far the officers were read, { tone, text } or null.
    handlingSupportNote() {
      return supportNote(this.handlingSupportState, this.officerSupport)
    },
  },
  methods: {
    retryHandlingSupport() {
      this.$asyncComputed.handlingSupport.update()
    },
  },
}
