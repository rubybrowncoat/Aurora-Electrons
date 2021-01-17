<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <div class="display-1">
          Transportation
        </div>
        <v-row justify="start">
          <v-col cols="12">
            <v-slider
              v-model="distance"
              min="1"
              max="100"
              :hint="`over a distance of ${distance} billion kilometers`"
              thumb-label
              persistent-hint
            ></v-slider>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Civilian Freight Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(civilianCargoCapacity) }} Tons per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Civilian Colonist Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(civilianColonistCapacity) }} People per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12">
            <v-autocomplete v-model="fleets" :items="fleetNames" label="Specific Military Fleets" item-text="FleetName" item-value="FleetID" clearable multiple small-chips deletable-chips></v-autocomplete>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Military Freight Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(militaryCargoCapacity) }} Tons per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Military Colonist Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(militaryColonistCapacity) }} People per Annum
              </v-card-title>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </div>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

import romanum from 'romanum'

import { convertDisplayBase } from '../../utilities/generic'
import { separatedNumber, roundToDecimal } from '../../utilities/math'

const secondsPerYear = 31536000

export default {
  components: {},
  data() {
    return {
      distanceMultiplier: 1000000000,
      distance: 1,

      fleets: [],

      //

      rules: {
        required: value => !!value || 'Required.',
        positive: value => value > 0 || 'Must be positive.',
      },
    }
  },
  methods: {
    separatedNumber(number) {
      return separatedNumber(number)
    },

    flipDistance() {
      if (this.distance > 1000000000) {
        this.distance /= 10
      } else {
        this.distance *= 10
      }
    },
  },
  computed: {
    ...mapGetters([
      'database',
      
      'GameID',
      'RaceID',
    ]),

    multipliedDistance() {
      return this.distance * this.distanceMultiplier
    },
    
    civilianCargoCapacity() {
      return this.ships.filter(ship => ship.ShippingLineID & ship.MaximumCargoLoadingTime).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.CargoCapacity * secondsPerYear / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumCargoLoadingTime * 2))), 0)
    },
    civilianColonistCapacity() {
      return this.ships.filter(ship => ship.ShippingLineID & ship.MaximumColonistLoadingTime).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.ColonistCapacity * secondsPerYear / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumColonistLoadingTime * 2))), 0)
    },

    militaryCargoCapacity() {
      return this.ships.filter(ship => (this.fleets.length ? this.fleets.includes(ship.FleetID) : true) && !ship.ShippingLineID & ship.MaximumCargoLoadingTime && this.multipliedDistance <= ship.MaxRange).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.CargoCapacity * Math.max(0, secondsPerYear - (secondsPerYear / ship.MaxRangeTime * ship.MaximumRefuellingTime)) / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumCargoLoadingTime * 2))), 0)
    },
    militaryColonistCapacity() {
      return this.ships.filter(ship => (this.fleets.length ? this.fleets.includes(ship.FleetID) : true) && !ship.ShippingLineID && ship.MaximumColonistLoadingTime && this.multipliedDistance <= ship.MaxRange).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.ColonistCapacity * Math.max(0, secondsPerYear - (secondsPerYear / ship.MaxRangeTime * ship.MaximumRefuellingTime)) / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumColonistLoadingTime * 2))), 0)
    },

    fleetNames() {
      if (!this.ships || !this.ships.length) {
        return []
      }

      return Object.values(this.ships.reduce((names, ship) => {
        if (!ship.ShippingLineID && (ship.CargoCapacity || ship.ColonistCapacity) && !names[ship.FleetID]) {
          names[ship.FleetID] = {
            FleetID: ship.FleetID,
            FleetName: ship.FleetName,
          }
        }

        return names
      }, {}))
    },
  },
  asyncComputed: {
    ships: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShippingLineID, FCT_ShipClass.ClassName, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.FuelCapacity, FCT_ShipClass.MaxSpeed, COALESCE(FCT_ShipClass.FuelCapacity / ( FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency ) * 3600, 0) as MaxRangeTime, COALESCE(FCT_ShipClass.FuelCapacity / ( FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency ) * 3600 * FCT_ShipClass.MaxSpeed, 0) as MaxRange, COALESCE(20 * FCT_ShipClass.CargoCapacity / ( FCT_ShipClass.CargoShuttleStrength * FCT_Race.CargoShuttleLoadModifier ), 0) as MaximumCargoLoadingTime, COALESCE(10 * FCT_ShipClass.ColonistCapacity / ( FCT_ShipClass.CargoShuttleStrength * FCT_Race.CargoShuttleLoadModifier ), 0) as MaximumColonistLoadingTime, COALESCE(FCT_ShipClass.FuelCapacity / ( FCT_Race.MaxRefuellingRate / 3600 ), 0) as MaximumRefuellingTime, FCT_ShippingLines.LineName, FCT_Fleet.FleetName from FCT_Ship left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID left join FCT_ShippingLines on FCT_Ship.ShippingLineID = FCT_ShippingLines.ShippingLineID left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_Race on FCT_Ship.RaceID = FCT_Race.RaceID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Ships', items)

          return items
        })

        return ships
      },
      default: [],
    },
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>

</style>
