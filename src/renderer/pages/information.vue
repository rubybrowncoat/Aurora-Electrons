<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row justify="start">
          <v-col cols="12">
            <div class="display-1">
              Transportation
            </div>
          </v-col>
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
          <template v-if="CivilianShippingLinesActive">
            <v-col cols="12" md="6">
              <v-card>
                <v-card-text class="pb-0">Civilian Freight Capacity</v-card-text>
                <v-card-title>
                  {{ separatedNumber(civilianCargoCapacity, separator) }} Tons per Annum
                </v-card-title>
              </v-card>
            </v-col>
            <v-col cols="12" md="6">
              <v-card>
                <v-card-text class="pb-0">Civilian Colonist Capacity</v-card-text>
                <v-card-title>
                  {{ separatedNumber(civilianColonistCapacity, separator) }} People per Annum
                </v-card-title>
              </v-card>
            </v-col>
          </template>
          <v-col cols="12">
            <v-autocomplete v-model="fleets" :items="fleetNames" label="Specific Military Fleets" item-text="FleetName" item-value="FleetID" clearable multiple small-chips deletable-chips></v-autocomplete>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Military Freight Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(militaryCargoCapacity, separator) }} Tons per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Military Colonist Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(militaryColonistCapacity, separator) }} People per Annum
              </v-card-title>
            </v-card>
          </v-col>
        </v-row>
        <v-row class="mt-8" v-if="CivilianShippingLinesActive && activeInstallations.length">
          <v-col cols="12">
            <div class="display-1">
              Civilian Network Work Orders
            </div>
          </v-col>
          <v-col cols="12" v-for="installation of activeInstallations" :key="installation.PlanetaryInstallationID">
            <v-card>
              <v-card-title>
                {{ installation.Name }}
              </v-card-title>
              <v-card-text>
                <v-simple-table>
                  <template v-slot:default>
                    <thead>
                      <tr>
                        <th style="width: 60%;">Population</th>
                        <th class="text-center">Supply</th>
                        <th class="text-center">Demand</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="demand of demandsAndDepartures[installation.PlanetaryInstallationID]" :key="`${demand.PopulationID}-${demand.PlanetaryInstallationID}`">
                        <td class="py-2">
                          <h3 v-html="populationName(demand)"></h3>
                          <template v-if="demand.Departures.length">
                            <div v-for="cargo of demand.Departures" :key="`${cargo.PlanetaryInstallationID}-${cargo.OriginPopulationID}-${cargo.DestinationPopulationID}`">
                              <template v-if="cargo.DestinationPopulationID">{{ cargo.Amount }} units en route to <span v-html="populationName(cargo, 'Destination', true)"></span></template>
                              <template v-else>{{ cargo.Amount }} in cargo holds without destination.</template>
                            </div>
                          </template>
                        </td>
                        <td class="text-center">{{ demand.SupplyAmount }}</td>
                        <td class="text-center">{{ demand.DemandAmount }}</td>
                      </tr>
                      <tr class="caption" v-if="installationBalance[installation.PlanetaryInstallationID]">
                        <td>Unbalanced</td>
                        <td class="text-center font-weight-bold"><span class="red--text" v-if="installationBalance[installation.PlanetaryInstallationID] > 0">{{ installationBalance[installation.PlanetaryInstallationID] }}</span></td>
                        <td class="text-center font-weight-bold"><span class="red--text" v-if="installationBalance[installation.PlanetaryInstallationID] < 0">{{ Math.abs(installationBalance[installation.PlanetaryInstallationID]) }}</span></td>
                      </tr>
                    </tbody>
                  </template>
                </v-simple-table>
              </v-card-text>
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
import { populationName } from '../../utilities/aurora'

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
    separatedNumber,

    populationName,

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
      'config',
      'database',
      
      'GameID',
      'RaceID',

      'CivilianShippingLinesActive',
    ]),

    separator() {
      const selectedSeparator = this.config.get(`selectedSeparator`, `Tick`)

      return selectedSeparator === 'Tick' ? `'` : selectedSeparator === 'Comma' ? `,` : selectedSeparator === 'Dash' ? `-` : selectedSeparator === 'Space' ? ` ` : ''
    },

    multipliedDistance() {
      return this.distance * this.distanceMultiplier
    },
    
    civilianCargoCapacity() {
      return this.ships.filter(ship => ship.ShippingLineID && ship.MaximumCargoLoadingTime).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.CargoCapacity * secondsPerYear / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumCargoLoadingTime * 2))), 0)
    },
    civilianColonistCapacity() {
      return this.ships.filter(ship => ship.ShippingLineID && ship.MaximumColonistLoadingTime).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.ColonistCapacity * secondsPerYear / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumColonistLoadingTime * 2))), 0)
    },

    militaryCargoCapacity() {
      return this.ships.filter(ship => (this.fleets.length ? this.fleets.includes(ship.FleetID) : true) && !ship.ShippingLineID && ship.MaximumCargoLoadingTime && this.multipliedDistance <= ship.MaxRange).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.CargoCapacity * Math.max(0, secondsPerYear - (secondsPerYear / ship.MaxRangeTime * ship.MaximumRefuellingTime)) / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumCargoLoadingTime * 2))), 0)
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

    activeInstallations() {
      return this.installations.filter(installation => this.demands[installation.PlanetaryInstallationID])
    },
    demandsAndDepartures() {
      return Object.values(this.cargoDestinations).reduce((aggregate, installation) => {
        Object.values(installation).forEach(origin => {
          Object.values(origin).forEach(cargo => {
            if (!aggregate[cargo.InstallationID]) {
              aggregate[cargo.InstallationID] = {}
            }

            if (!aggregate[cargo.InstallationID][cargo.OriginPopulationID]) {
              aggregate[cargo.InstallationID][cargo.OriginPopulationID] = {
                PopulationID: cargo.OriginPopulationID,
                PopName: cargo.OriginPopName,
                PlanetaryInstallationID: cargo.InstallationID,
                InstallationName: cargo.InstallationName,
                SystemName: cargo.OriginSystemName,
                SystemBodyID: cargo.OriginSystemBodyID,
                PlanetNumber: cargo.OriginPlanetNumber,
                OrbitNumber: cargo.OriginOrbitNumber,
                BodyClass: cargo.OriginBodyClass,
                SystemBodyName: cargo.OriginSystemBodyName,
                Component: cargo.OriginComponent,

                DemandAmount: 0,
                SupplyAmount: 0,

                Departures: [],
              }
            }

            aggregate[cargo.InstallationID][cargo.OriginPopulationID].Departures.push(cargo)
          })
        })

        return aggregate
      }, this.demands)
    },
    installationBalance() {
      return this.activeInstallations.reduce((aggregate, installation) => {
        aggregate[installation.PlanetaryInstallationID] = Object.values(this.demands[installation.PlanetaryInstallationID]).reduce((sum, demand) => sum + demand.SupplyAmount - demand.DemandAmount, 0) + (this.cargoDestinations[installation.PlanetaryInstallationID] ? Object.values(this.cargoDestinations[installation.PlanetaryInstallationID]).reduce((sum, destinations) => sum + Object.values(destinations).reduce((cargoSum, cargo) => cargoSum + cargo.Amount, 0), 0) : 0)
        
        return aggregate
      }, {})
    }
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
    // Civilian Economy
    installations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const installations = await this.database.query(`select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name from DIM_PlanetaryInstallation left join FCT_RaceTech on DIM_PlanetaryInstallation.RequiredTechID = FCT_RaceTech.TechID and FCT_RaceTech.RaceID = ${this.RaceID} where DIM_PlanetaryInstallation.CargoPoints > 0 and (FCT_RaceTech.TechID is not null or DIM_PlanetaryInstallation.RequiredTechID = 0) order by DIM_PlanetaryInstallation.Name asc`).then(([ items ]) => {
          console.log('Planetary Installations', items)

          return items
        })

        return installations
      },
      default: [],
    },
    demands: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const demands = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name as InstallationName, FCT_PopInstallationDemand.Amount, FCT_PopInstallationDemand.Export, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_PopInstallationDemand left join FCT_Population on FCT_PopInstallationDemand.PopulationID = FCT_Population.PopulationID left join DIM_PlanetaryInstallation on FCT_PopInstallationDemand.InstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_PopInstallationDemand.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Civilian Demands', items)

          return items.reduce((aggregate, item) => {
            if (!aggregate[item.PlanetaryInstallationID]) {
              aggregate[item.PlanetaryInstallationID] = {}
            }

            if (!aggregate[item.PlanetaryInstallationID][item.PopulationID]) {
              aggregate[item.PlanetaryInstallationID][item.PopulationID] = {
                PopulationID: item.PopulationID,
                PopName: item.PopName,
                PlanetaryInstallationID: item.PlanetaryInstallationID,
                InstallationName: item.InstallationName,
                SystemName: item.SystemName,
                SystemBodyID: item.SystemBodyID,
                PlanetNumber: item.PlanetNumber,
                OrbitNumber: item.OrbitNumber,
                BodyClass: item.BodyClass,
                SystemBodyName: item.SystemBodyName,
                Component: item.Component,

                DemandAmount: 0,
                SupplyAmount: 0,
                
                Departures: [],
              }
            }

            if (item.Export) {
              aggregate[item.PlanetaryInstallationID][item.PopulationID].SupplyAmount += item.Amount
            } else {
              aggregate[item.PlanetaryInstallationID][item.PopulationID].DemandAmount += item.Amount
            }

            return aggregate
          }, {})
        })

        return demands
      },
      default: {},
    },
    cargoDestinations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const destinations = await this.database.query(`select FCT_ShipCargo.CargoID as InstallationID, FCT_ShipCargo.Amount, DIM_PlanetaryInstallation.Name as InstallationName, FCT_ShipCargo.StartingPop as OriginPopulationID, OriginPopulation.PopName as OriginPopName, FCT_MoveOrders.PopulationID as DestinationPopulationID, DestinationPopulation.PopName as DestinationPopName, OriginRaceSysSurvey.Name as OriginSystemName, OriginSystemBody.SystemBodyID as OriginSystemBodyID, OriginSystemBody.PlanetNumber as OriginPlanetNumber, OriginSystemBody.OrbitNumber as OriginOrbitNumber, OriginSystemBody.BodyClass as OriginBodyClass, OriginSystemBodyName.Name as OriginSystemBodyName, OriginStar.Component as OriginComponent, DestinationRaceSysSurvey.Name as DestinationSystemName, DestinationSystemBody.SystemBodyID as DestinationSystemBodyID, DestinationSystemBody.PlanetNumber as DestinationPlanetNumber, DestinationSystemBody.OrbitNumber as DestinationOrbitNumber, DestinationSystemBody.BodyClass as DestinationBodyClass, DestinationSystemBodyName.Name as DestinationSystemBodyName, DestinationStar.Component as DestinationComponent from FCT_ShipCargo left join FCT_Ship on FCT_ShipCargo.ShipID = FCT_Ship.ShipID left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_MoveOrders on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID and FCT_MoveOrders.DestinationItemType = 19 and FCT_MoveOrders.DestinationItemID = FCT_ShipCargo.CargoID left join DIM_PlanetaryInstallation on FCT_ShipCargo.CargoID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_Population as OriginPopulation on FCT_ShipCargo.StartingPop = OriginPopulation.PopulationID left join FCT_SystemBody as OriginSystemBody on OriginPopulation.SystemBodyID = OriginSystemBody.SystemBodyID left join FCT_SystemBodyName as OriginSystemBodyName on OriginSystemBody.SystemBodyID = OriginSystemBodyName.SystemBodyID and OriginPopulation.RaceID = OriginSystemBodyName.RaceID left join FCT_RaceSysSurvey as OriginRaceSysSurvey on OriginPopulation.SystemID = OriginRaceSysSurvey.SystemID and OriginPopulation.RaceID = OriginRaceSysSurvey.RaceID left join FCT_Star as OriginStar on OriginSystemBody.StarID = OriginStar.StarID left join FCT_Population as DestinationPopulation on FCT_MoveOrders.PopulationID = DestinationPopulation.PopulationID left join FCT_SystemBody as DestinationSystemBody on DestinationPopulation.SystemBodyID = DestinationSystemBody.SystemBodyID left join FCT_SystemBodyName as DestinationSystemBodyName on DestinationSystemBody.SystemBodyID = DestinationSystemBodyName.SystemBodyID and DestinationPopulation.RaceID = DestinationSystemBodyName.RaceID left join FCT_RaceSysSurvey as DestinationRaceSysSurvey on DestinationPopulation.SystemID = DestinationRaceSysSurvey.SystemID and DestinationPopulation.RaceID = DestinationRaceSysSurvey.RaceID left join FCT_Star as DestinationStar on DestinationSystemBody.StarID = DestinationStar.StarID where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 2 and FCT_Ship.ShippingLineID != 0`).then(([ items ]) => {
          console.log('Routed Cargo', items)

          return items.reduce((aggregate, item) => {
            if (!aggregate[item.InstallationID]) {
              aggregate[item.InstallationID] = {}
            }
            
            if (!aggregate[item.InstallationID][item.OriginPopulationID]) {
              aggregate[item.InstallationID][item.OriginPopulationID] = {}
            }

            if (!aggregate[item.InstallationID][item.OriginPopulationID][item.DestinationPopulationID]) {
              aggregate[item.InstallationID][item.OriginPopulationID][item.DestinationPopulationID] = {
                InstallationID: item.InstallationID,
                InstallationName: item.InstallationName,

                OriginPopulationID: item.OriginPopulationID,
                OriginPopName: item.OriginPopName,

                OriginSystemName: item.OriginSystemName,
                OriginSystemBodyID: item.OriginSystemBodyID,
                OriginPlanetNumber: item.OriginPlanetNumber,
                OriginOrbitNumber: item.OriginOrbitNumber,
                OriginBodyClass: item.OriginBodyClass,
                OriginSystemBodyName: item.OriginSystemBodyName,
                OriginComponent: item.OriginComponent,

                DestinationPopulationID: item.DestinationPopulationID,
                DestinationPopName: item.DestinationPopName,

                DestinationSystemName: item.DestinationSystemName,
                DestinationSystemBodyID: item.DestinationSystemBodyID,
                DestinationPlanetNumber: item.DestinationPlanetNumber,
                DestinationOrbitNumber: item.DestinationOrbitNumber,
                DestinationBodyClass: item.DestinationBodyClass,
                DestinationSystemBodyName: item.DestinationSystemBodyName,
                DestinationComponent: item.DestinationComponent,

                Amount: 0,
              }
            }

            aggregate[item.InstallationID][item.OriginPopulationID][item.DestinationPopulationID].Amount += item.Amount

            return aggregate
          }, {})
        })

        return destinations
      },
      default: {},
    }
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>

</style>
