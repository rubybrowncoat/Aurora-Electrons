import { allLoaded, joinLabels } from '../utilities/load-tracking'

// The read state of a page whose async-computed reads are wrapped in `tracked` (utilities/load-tracking.js), which components/page/LoadState.vue shows. `labels` maps each tracked read to the words that name it when it fails ('the jump points'). `ready` is every read in; a page that also waits on something else overrides it, building on `inputsLoaded`.
export default (labels) => {
  const keys = Object.keys(labels)

  return {
    data() {
      return {
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
    },
    methods: {
      retryFailedInputs() {
        this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
      },
    },
  }
}
