import { allLoaded, joinLabels } from '../utilities/load-tracking'

// The read state of a page whose async-computed reads are wrapped in `tracked` (utilities/load-tracking.js), which components/page/LoadState.vue shows. `labels` maps each tracked read to the words that name it when it fails ('the jump points'). `ready` is every read in; a page that also waits on something else overrides it, building on `inputsLoaded`.
//
// Each read that settles is also recorded in the freshness store (store/freshness.js), per page and input, through `tracked`'s `inputSettled` hook: a success moves the input's last successful read time and generation, a failure only marks it failed, so the last good read stays on record as stale until a retry succeeds.
export default (labels) => {
  const keys = Object.keys(labels)

  return {
    data() {
      return {
        inputsPage: this.$route ? this.$route.path : null,
        loadErrors: {},
      }
    },
    computed: {
      failedInputs() {
        return keys.filter((key) => this.loadErrors[key])
      },

      failedInputsText() {
        return joinLabels(this.failedInputs.map((key) => labels[key]))
      },

      inputsLoaded() {
        return allLoaded(this.loadErrors, keys)
      },

      ready() {
        return this.inputsLoaded
      },

      // What the freshness store holds for this page's inputs: { [key]: { label, readAt, generation, failedAt, message } }, with `readAt` the wall-clock time (ms) of the input's last successful read.
      inputReads() {
        return this.$store.state.freshness.inputs[this.inputsPage] || {}
      },

      // The failed inputs that still have an earlier successful read on record: what they last showed is stale, not missing.
      staleInputs() {
        return this.failedInputs.filter((key) => this.inputReads[key] && this.inputReads[key].readAt !== null)
      },
    },
    beforeDestroy() {
      this.$store.commit('freshness/pageClosed', { page: this.inputsPage })
    },
    methods: {
      retryFailedInputs() {
        this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
      },

      // Called by `tracked` when a read's latest request settles: `error` is null for a success and the message for a failure. A read that settles after its page has closed has no page left to belong to.
      inputSettled(key, error) {
        if (this._isDestroyed || typeof this.inputsPage !== 'string') {
          return
        }

        if (error === null) {
          this.$store.commit('freshness/inputRead', { page: this.inputsPage, key, label: labels[key], at: Date.now(), generation: this.$store.state.freshness.generation })
        } else {
          this.$store.commit('freshness/inputFailed', { page: this.inputsPage, key, label: labels[key], at: Date.now(), message: error })
        }
      },
    },
  }
}
