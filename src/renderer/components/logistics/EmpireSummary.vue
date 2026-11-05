<template>
  <v-card class="panel empire-summary" data-summary="List each colony's maintenance capacity, supplies, fuel and services as the game's empire logistics list gives them." elevation="1">
    <div class="panel-head">
      <span class="text-no-wrap">Empire summary<provenance-mark rule="logistics.empireSummary" label /></span>
      <v-select :value="order" :items="orders" item-text="text" item-value="key" label="Order by" dense outlined hide-details class="summary-order" data-summary-order @change="$emit('order', $event)" />
    </div>
    <div v-if="unread" class="px-4 py-2" data-summary-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="$emit('retry')" />
    </div>
    <template v-else>
      <v-simple-table v-if="rows.length" dense class="empire-summary-table">
        <thead>
          <tr>
            <th class="text-left">Colony</th>
            <th v-for="column in columns" :key="column.key" class="text-right" :title="`${column.name}. ${column.hint}`" :data-column="column.key">{{ column.abbreviation }}</th>
            <th v-for="service in services" :key="service.key" class="text-center" :title="service.hint" :data-column="service.key">{{ service.abbreviation }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.PopulationID" :data-colony="row.PopulationID">
            <td class="py-1">
              <div class="font-weight-medium text-no-wrap" data-summary-name>{{ row.name }}</div>
              <div v-if="row.place" class="caption text--secondary text-no-wrap">{{ row.place }}</div>
            </td>
            <td v-for="column in columns" :key="column.key" class="text-right">
              <span class="text-no-wrap" :class="classOf(row, column.key)" :title="titleOf(row, column.key)" :data-figure="column.key">{{ figureText(row, column.key) }}<provenance-mark v-if="row.missing[column.key]" :result="row.missing[column.key]" /></span>
            </td>
            <td v-for="service in services" :key="service.key" class="text-center">
              <span class="text-no-wrap" :class="{ 'text--secondary': !row[service.key] }" :data-service="service.key">{{ row[service.key] ? 'Yes' : UNKNOWN_TEXT }}</span>
            </td>
          </tr>
        </tbody>
      </v-simple-table>
      <div v-else class="px-4 py-3 caption text--secondary" data-summary-empty>No colony has a figure or a service to show.</div>
      <div class="panel-foot caption text--secondary">
        Use it to read each colony's maintenance, fuel and services as the game's Empire Logistics list gives them, and to find colonies whose maintained tonnage outgrows their capacity or whose production is off. A colony shows when it has any capacity, tonnage, production, stock or service. The order is from the largest figure of the chosen column down, colonies with equal figures keeping the order the save stores them. Capacity is the maintenance facilities times the racial capacity, the colony's efficiency, radiation, unrest and political modifiers and the economic modifier. The Maintenance table's capacity leaves the economic modifier out, so the two differ only where it is not 1. The capacity including orbital adds the undamaged maintenance modules of the fleets of the race with no civilian function within one unit of the colony's body on both axes, in whatever system, that are assigned to the colony or to none. The tonnage and the supplies a year are those of the ships exactly at the colony's body in its system, in any state, that are not commercial, not carried by a military hangar and not in a shipyard task of the colony. The Maintenance table instead groups the colonies and ships within one unit and draws the supplies from the stocks in order, so its ship counts and tonnage differ. Production is the racial rate times the colony's overall production modifier times the whole facilities, four times over for maintenance supplies. The Fuel table and the Maintenance table count a part of a refinery or a facility as that part of its output, and the Maintenance table stops at what the minerals in stock allow, so their production can differ from the production here. Amber marks a tonnage above the capacity including orbital and production that is on yet below the supplies needed a year. Red marks production that is switched off though the colony could make some. A dash is a figure of nothing, and a dash with a mark is a figure the save does not give. Yes marks a colony with a refuelling point (spaceport, starport or refuelling station), a resupply point (maintenance facility, cargo shuttle station, spaceport or starport, or a ship with maintenance modules near it) or an ordnance transfer point (spaceport, starport or ordnance transfer station).
      </div>
    </template>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import countFormat from '../../mixins/count-format'
import { FUEL_UNIT, SUMMARY_COLUMNS, SUMMARY_SERVICES, roundedFigure } from '../../utilities/empire-logistics'
import { UNKNOWN_TEXT } from '../../utilities/math'

// The fuel columns count in millions of litres.
const FUEL_KEYS = ['fuel', 'fuelProduction']

export default {
  name: 'EmpireSummary',
  components: { LoadState, ProvenanceMark },
  mixins: [countFormat],
  props: {
    // The rows of `summaryRows` (utilities/empire-logistics.js), each with the page's `name` and `place`; null while the read is not in.
    rows: {
      type: Array,
      default: null,
    },
    // The read's own state: { loading, failed, error }.
    state: {
      type: Object,
      required: true,
    },
    // The column the rows are ordered by.
    order: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      columns: SUMMARY_COLUMNS,
      services: SUMMARY_SERVICES,
      UNKNOWN_TEXT,
    }
  },
  computed: {
    unread() {
      return Boolean(this.state.loading || this.state.failed || !this.rows)
    },

    orders() {
      return SUMMARY_COLUMNS.map((column) => ({ key: column.key, text: `${column.abbreviation} ${column.name}` }))
    },
  },
  methods: {
    // A figure as the game writes it: a dash for a figure of nothing or less and for one the save does not give, the whole figure otherwise, and the fuel in millions of litres to one place with an m.
    figureText(row, key) {
      const value = row[key]

      if (!(value > 0)) {
        return UNKNOWN_TEXT
      }

      return FUEL_KEYS.includes(key) ? `${this.count(roundedFigure(value / FUEL_UNIT, 1), 1)}m` : this.count(roundedFigure(value, 0))
    },

    // The colour the game gives the figure: amber for a tonnage above the capacity including orbital and for production that is on and short, red for production or fuel production that is off.
    classOf(row, key) {
      if (key === 'tons' && row.tonsAbove) {
        return 'warning--text'
      } else if (key === 'production' && row.productionState) {
        return row.productionState === 'short' ? 'warning--text' : 'error--text'
      } else if (key === 'fuelProduction' && row.fuelProductionOff) {
        return 'error--text'
      }

      return row[key] === null || !(row[key] > 0) ? 'text--secondary' : ''
    },

    titleOf(row, key) {
      if (key === 'tons' && row.tonsAbove) {
        return 'The maintained tonnage is above the capacity including orbital'
      } else if (key === 'production' && row.productionState === 'short') {
        return 'Production is on and below the maintenance supplies the ships need in a year'
      } else if (key === 'production' && row.productionState === 'off') {
        return 'Production is switched off though the colony could make maintenance supplies'
      } else if (key === 'fuelProduction' && row.fuelProductionOff) {
        return 'Fuel production is switched off though the colony could make fuel'
      }

      return ''
    },
  },
}
</script>

<style lang="scss">
.empire-summary {
  .summary-order {
    max-width: 22rem;
  }
}
</style>
