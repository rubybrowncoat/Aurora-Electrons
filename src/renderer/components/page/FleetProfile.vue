<template>
  <div class="fleet-profile" data-fleet-profile>
    <div class="caption text--secondary mb-1" data-fleet-speeds>
      <span v-if="speeds.cruise !== null">Sails at {{ count(speeds.cruise) }} km/s, {{ SOURCE_TEXT[speeds.cruiseSource] }}<provenance-mark rule="transport.fleetSpeed" />.</span>
      <span v-else>No speed to sail at.</span>
      <span v-if="speeds.saved !== null"> Saved fleet speed {{ count(speeds.saved) }} km/s<provenance-mark rule="transport.fleetSpeed" />{{ speeds.useMaximum === true ? ', set to the maximum' : speeds.useMaximum === false ? ', set by hand' : '' }}.</span>
      <span v-if="speeds.effectiveMax !== null"> Effective maximum {{ count(speeds.effectiveMax) }} km/s<provenance-mark rule="transport.fleetSpeed" />{{ speeds.limiting ? `, held by ${speeds.limiting}` : '' }}.</span>
      <span v-if="speeds.designMax !== null && speeds.effectiveMax !== null && speeds.designMax !== speeds.effectiveMax"> The slowest class design is rated {{ count(speeds.designMax) }} km/s<provenance-mark rule="transport.fleetSpeed" />; damage, overhaul or a tow lowers a ship from its class rating.</span>
    </div>
    <v-simple-table dense class="fleet-profile__table" data-fleet-participants>
      <thead>
        <tr>
          <th>Ship</th>
          <th>Role</th>
          <th class="text-right">Own maximum</th>
          <th class="text-right">Sails at</th>
          <th class="text-right">Burn</th>
          <th class="text-right">Fuel / trip</th>
          <th class="text-right">Cargo</th>
          <th class="text-right">Colonists</th>
          <th>Holds</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in participants" :key="row.key" :data-participant="row.key" :data-role="row.role" :data-limiting="row.limiting ? 'true' : 'false'">
          <td class="caption">
            <div>{{ row.ship }}<v-icon v-if="row.limiting" x-small class="ml-1" title="Sets the speed of the fleet" data-limiting-ship>mdi-speedometer-slow</v-icon></div>
            <div class="text--secondary">{{ row.className }}</div>
          </td>
          <td class="caption">{{ row.roleText }}</td>
          <td class="caption text-right text-no-wrap" data-own-maximum>{{ row.speed === null ? '—' : `${count(row.speed)} km/s` }}<provenance-mark v-if="row.speed !== null" rule="transport.fleetSpeed" /></td>
          <td class="caption text-right text-no-wrap" data-fraction>{{ row.fraction === null ? '—' : `${count(row.fraction * 100, 1)}%` }}<provenance-mark v-if="row.fraction !== null" rule="transport.fleetBurn" /></td>
          <td class="caption text-right text-no-wrap" data-burn>{{ row.role !== 'independent' ? 'none' : row.burn === null ? '—' : `${count(row.burn, 1)} L/h` }}<provenance-mark v-if="row.role === 'independent' && row.burn !== null" rule="transport.fleetBurn" /></td>
          <td class="caption text-right text-no-wrap" data-fuel-trip>
            <template v-if="row.perTrip !== null">{{ count(row.perTrip) }} L<span v-if="row.share !== null" class="text--secondary"> · {{ count(row.share * 100) }}% of a tank</span><provenance-mark rule="transport.fleetBurn" /></template>
            <template v-else>—</template>
          </td>
          <td class="caption text-right text-no-wrap" data-cargo>{{ row.cargo === null ? '—' : `${count(row.cargo)} t` }}<provenance-mark v-if="row.cargo !== null" rule="transport.fleetCargo" /></td>
          <td class="caption text-right text-no-wrap" data-colonists>{{ row.colonists === null ? '—' : count(row.colonists) }}<provenance-mark v-if="row.colonists !== null" rule="transport.fleetCargo" /></td>
          <td class="caption text-no-wrap" :data-cargo-status="row.cargoStatus">{{ HOLD_TEXT[row.cargoStatus] }}<provenance-mark v-if="row.cargoStatus !== 'none'" rule="transport.fleetCargo" /></td>
        </tr>
      </tbody>
    </v-simple-table>
    <div v-for="text in conditions" :key="text" class="caption text--secondary mt-1" data-fleet-condition>{{ text }}</div>
    <div v-for="reason in reasons" :key="reason" class="caption warning--text mt-1" data-fleet-reason>{{ reason }}</div>
    <handling-breakdown v-if="handlingRows.length" :rows="handlingRows" class="mt-3" />
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import HandlingBreakdown from './HandlingBreakdown.vue'
import ProvenanceMark from './ProvenanceMark.vue'

const SOURCE_TEXT = {
  maximum: 'the effective maximum of its slowest ship',
  'maximum-mode': 'the effective maximum, as the fleet is set to its maximum speed',
  saved: 'the speed saved for the fleet',
  'saved-capped': 'the effective maximum, as the saved speed is higher than the fleet can reach',
}

const HOLD_TEXT = {
  none: 'No holds',
  counted: 'Counted',
  unsupported: 'Not counted',
  unknown: 'Not known',
}

// What a fleet sails with: every ship as a participant (under its own power, in a hangar or under tow), the speed each could make and the share of it the fleet sails at, what each burns, and the holds that count. `participants` as `participantRows` (utilities/fleet-profile.js) gives them; `speeds` the profile's saved speed, effective maximum and the ship that holds it apart; `reasons` why the fleet is not profiled; `conditions` what holds for it without stopping the profile; `handlingRows` the loading strength at each stop of a trip as `handlingRows` (utilities/transport.js) gives them.
export default {
  name: 'FleetProfile',
  components: { HandlingBreakdown, ProvenanceMark },
  mixins: [countFormat],
  props: {
    participants: { type: Array, required: true },
    speeds: { type: Object, required: true },
    reasons: { type: Array, default: () => [] },
    conditions: { type: Array, default: () => [] },
    handlingRows: { type: Array, default: () => [] },
  },
  data() {
    return { SOURCE_TEXT, HOLD_TEXT }
  },
}
</script>

<style lang="scss" scoped>
.fleet-profile__table {
  max-width: 1100px;
  background: transparent !important;
}
</style>
