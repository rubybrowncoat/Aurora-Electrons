<script>
import resourceReserves from '../../mixins/resource-reserves'
import { fuelReserveOf, fuelReserves } from '../../utilities/resource-reserves'

// Reads the fuel the player keeps at colonies, on ships and on ship classes (the scenario records of utilities/resource-reserves.js, every scenario together) for a page that plans with it, and reports it as `reserves`: `{ ready, loading, failed, error, retry, reader }`. `reader` gives the litres kept for a colony (`colony(PopulationID)`) or a ship (`ship(row)`, its own record over its class's), null where none is kept; `ready` is false while the records or the objects they name are not read, or when they could not be; `failed` and `error` say that a read failed and why, and `retry` reads the failed reads again. It shows nothing and writes nothing.
export default {
  name: 'FuelReserveReader',
  mixins: [resourceReserves],
  computed: {
    // The kind of reserve the shared reads are made for.
    kind() {
      return 'fuel'
    },

    // The sources a record may name: the colonies as well as the ships and ship classes, which the shared reads load for a panel of one kind.
    reserveTypes() {
      return ['colony', 'ship', 'class']
    },

    ready() {
      return !this.reserveState.loading && !this.reserveState.failed && !this.reserveRepositoryError && !this.reserveRead.error && Boolean(this.reserveScope)
    },

    // The words of the failure of the reads, empty when none has failed.
    failure() {
      return this.reserveState.failed ? this.reserveState.error : [this.reserveRepositoryError, this.reserveRead.error].map((error) => (error && error.message ? error.message : String(error || ''))).find(Boolean) || ''
    },

    reserves() {
      const table = fuelReserves(this.reserveRead.entries)
      const reader = Object.freeze({
        colony: (PopulationID) => (table.colony.has(PopulationID) ? table.colony.get(PopulationID).amount : null),
        ship: (ship) => {
          const kept = fuelReserveOf(table, ship)

          return kept ? kept.amount : null
        },
      })

      return { ready: this.ready, loading: !this.ready && !this.failure, failed: Boolean(this.failure), error: this.failure, retry: () => this.retryReads(), reader }
    },
  },
  watch: {
    reserves: {
      immediate: true,
      handler(value) {
        this.$emit('reserves', value)
      },
    },
  },
  methods: {
    // Reads again what failed: the tracked reads, the repository of records that did not open, and the records that could not be read.
    retryReads() {
      if (this.reserveFailedKeys.length) {
        this.retryReserves()
      }

      if (this.reserveRepositoryError) {
        this.$asyncComputed.reserveRecords.update()
      } else if (this.reserveRead.error) {
        this.reservesChanged()
      }
    },
  },
  render() {
    return null
  },
}
</script>
