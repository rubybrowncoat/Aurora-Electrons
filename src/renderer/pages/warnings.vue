<template>
  <div class="fill-height">
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row class="mb-5" justify="start" v-if="damagedShips.length || armorDamagedShips.length || lowMoraleCrews.length || lowMaintenanceShips.length || obsoleteShips.length || fullyTrainedShips.length || openFireShips.length">
          <v-col cols="12" class="display-1">
            Ships
          </v-col>
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel v-if="damagedShips.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ damagedShips.length }} damaged ships
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in damagedShips" :key="ship.ShipID">
                        <!-- <v-list-item-icon>
                          <v-icon v-text="item.icon"></v-icon>
                        </v-list-item-icon> -->

                        <v-list-item-content>
                          <v-list-item-title>{{ ship.FleetName }} &mdash; {{ ship.ShipName }}</v-list-item-title>
                          <div class="caption mt-3 font-weight-medium">
                            {{ ship.Components.map(component => `${component.ComponentName} (${component.ComponentCost * 2} MSP)`).join(', ') }}
                          </div>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="armorDamagedShips.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ armorDamagedShips.length }} armor-damaged ships
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in armorDamagedShips" :key="ship.ShipID">
                        <v-list-item-content>
                          <v-list-item-title>{{ ship.FleetName }} &mdash; {{ ship.ShipName }}</v-list-item-title>
                          <v-list-item-subtitle>{{ ship.ArmorDamage }} Damage</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="lowMoraleCrews.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ lowMoraleCrews.length }} low morale crews
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in lowMoraleCrews" :key="ship.ShipID">
                        <v-list-item-content>
                          <v-list-item-title>
                            <span :class="`${levelColor(ship.CrewMorale)}--text font-weight-bold`">{{ roundToDecimal(ship.CrewMorale * 100, 1) }}%</span> 
                            &mdash; {{ ship.FleetName }} &mdash; {{ ship.ShipName }}
                          </v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="lowMaintenanceShips.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ lowMaintenanceShips.length }} low maintenance ships
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in lowMaintenanceShips" :key="ship.ShipID">
                        <v-list-item-content>
                          <v-list-item-title>
                            <span :class="`${levelColor(ship.SupplyLevel)}--text font-weight-bold`">{{ roundToDecimal(ship.SupplyLevel * 100, 1) }}%</span>
                            &mdash; {{ ship.FleetName }} &mdash; {{ ship.ShipName }}</v-list-item-title>
                          <v-list-item-subtitle>
                            {{ roundToDecimal(ship.CurrentMaintSupplies, 1) }}/{{ ship.MaintSupplies }} MSP
                          </v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="obsoleteShips.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ obsoleteShips.length }} active obsolete ships
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in obsoleteShips" :key="ship.ShipID">
                        <v-list-item-content>
                          <v-list-item-title>{{ ship.FleetName }} &mdash; {{ ship.ShipName }}</v-list-item-title>
                          <v-list-item-subtitle>{{ ship.ClassName }} Class</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="fullyTrainedShips.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ fullyTrainedShips.length }} fully trained ships in training fleets
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in fullyTrainedShips" :key="ship.ShipID">
                        <v-list-item-content>
                          <v-list-item-title>{{ ship.FleetName }} &mdash; {{ ship.ShipName }}</v-list-item-title>
                          <v-list-item-subtitle>{{ ship.AdminCommandName }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="openFireShips.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ openFireShips.length }} active fire controls
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="ship in openFireShips" :key="ship.ShipID">
                        <v-list-item-content>
                          <v-list-item-title>{{ ship.FleetName }} &mdash; {{ ship.ShipName }}</v-list-item-title>
                          <ul class="caption mt-3 font-weight-medium">
                            <li v-for="fireControl in ship.FireControls" :key="`#${fireControl.FireControlNum} ${fireControl.FireControlName}`">
                              #{{ fireControl.FireControlNum }} {{ fireControl.FireControlName }}
                            </li>
                          </ul>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
        <v-row class="mb-5" justify="start" v-if="freeConstructionCapacityPopulations.length || freeOrdnanceCapacityPopulations.length || freeFighterCapacityPopulations.length || lowEfficiencyPopulations.length || selfSustainingDestinationPopulations.length">
          <v-col cols="12" class="display-1">
            Populations
          </v-col>
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel v-if="freeConstructionCapacityPopulations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ freeConstructionCapacityPopulations.length }} populations with free construction capacity 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="population in freeConstructionCapacityPopulations" :key="population.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ population.PopName }} &mdash; <span class="font-weight-bold">{{ population.FreePercentage }}%</span> Available Capacity</v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="freeOrdnanceCapacityPopulations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ freeOrdnanceCapacityPopulations.length }} populations with free ordnance production capacity 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="population in freeOrdnanceCapacityPopulations" :key="population.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ population.PopName }} &mdash; <span class="font-weight-bold">{{ population.FreePercentage }}%</span> Available Capacity</v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="freeFighterCapacityPopulations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ freeFighterCapacityPopulations.length }} populations with free fighter production capacity 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="population in freeFighterCapacityPopulations" :key="population.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ population.PopName }} &mdash; <span class="font-weight-bold">{{ population.FreePercentage }}%</span> Available Capacity</v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="lowEfficiencyPopulations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ lowEfficiencyPopulations.length }} low efficiency populations
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="population in lowEfficiencyPopulations" :key="population.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ population.PopName }} &mdash; <span class="font-weight-bold">{{ roundToDecimal(population.Efficiency * 100, 1) }}%</span> Efficiency</v-list-item-title>
                          <v-list-item-subtitle>Population: {{ separatedNumber(roundToDecimal(population.Population * 1000000)) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="selfSustainingDestinationPopulations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ selfSustainingDestinationPopulations.length }} self-sustaining colonist destinations 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="population in selfSustainingDestinationPopulations" :key="population.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ population.PopName }}</v-list-item-title>
                          <v-list-item-subtitle>Population: {{ separatedNumber(roundToDecimal(population.Population * 1000000)) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
        <v-row class="mb-5" justify="start" v-if="governorlessPopulations.length || commanderlessNavalAdministrations.length || commanderlessSectors.length">
          <v-col cols="12" class="display-1">
            Administrations
          </v-col>
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel v-if="governorlessPopulations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ governorlessPopulations.length }} populations without governor 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="population in governorlessPopulations" :key="population.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ population.PopName }}</v-list-item-title>
                          <v-list-item-subtitle>Population: {{ separatedNumber(roundToDecimal(population.Population * 1000000)) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="commanderlessNavalAdministrations.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ commanderlessNavalAdministrations.length }} naval administrations without commander 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="administration in commanderlessNavalAdministrations" :key="administration.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ administration.PopName }} &mdash; {{ administration.AdminCommandName }}</v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="commanderlessSectors.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ commanderlessSectors.length }} sectors without commander 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="sector in commanderlessSectors" :key="sector.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ sector.PopName }} &mdash; {{ sector.SectorName }}</v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
        <v-row class="mb-5" justify="start" v-if="obsoleteShipyards.length || stockpilingCivilianMinerals.length || activeLifePods.length">
          <v-col cols="12" class="display-1">
            Others
          </v-col>
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel v-if="obsoleteShipyards.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ obsoleteShipyards.length }} shipyards tooled to obsolete class 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="shipyard in obsoleteShipyards" :key="shipyard.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ shipyard.PopName }} &mdash; {{ shipyard.ShipyardName }}</v-list-item-title>
                          <v-list-item-subtitle>{{ shipyard.ClassName }} Class &mdash; {{ separatedNumber(shipyard.Capacity) }} Ton Capacity &mdash; Slipways: {{ shipyard.Slipways }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="stockpilingCivilianMinerals.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ stockpilingCivilianMinerals.length }} stockpiling civilian mining colonies
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="colony in stockpilingCivilianMinerals" :key="colony.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title>{{ colony.SystemName }} {{ bodyName(colony) }} &mdash; {{ colony.PopName }}</v-list-item-title>
                          <v-list-item-subtitle>Currently stockpiling {{ separatedNumber(roundToDecimal(colony.TotalStockpile)) }} Tons of mineral</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="activeLifePods.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ activeLifePods.length }} active lifepods
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="lifepod in activeLifePods" :key="lifepod.LifepodID">
                        <v-list-item-content>
                          <v-list-item-title>{{ lifepod.SystemName }} &mdash; {{ lifepod.ShipName }} &mdash; {{ lifepod.Crew }} People</v-list-item-title>
                          <v-list-item-subtitle>Time remaining: {{ podExpiration(lifepod) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
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

const secondsPerTwoWeeks = 1209600
const secondsPerYear = 31536000

export default {
  components: {},
  data() {
    return {
      graph: null,

      distanceMultiplier: 1000000000,
      distance: 1,

      //

      rules: {
        required: value => !!value || 'Required.',
        positive: value => value > 0 || 'Must be positive.',
      },
    }
  },
  methods: {
    separatedNumber,
    roundToDecimal,

    levelColor(morale) {
      if (morale > 0.85) {
        return 'green'
      }

      if (morale < 0.30) {
        return 'red'
      }

      return this.$vuetify.theme.dark ? 'yellow' : 'orange'
    },

    bodyName(body) {
      if (body.BodyName) {
        return body.BodyName
      }
      
      switch (body.BodyClass) {
        case 1: {
          return `${convertDisplayBase(body.Component, 26)} ${romanum.toNumeral(body.PlanetNumber)}`
        }
        case 2: {
          return `${convertDisplayBase(body.Component, 26)} ${romanum.toNumeral(body.PlanetNumber)}-${body.OrbitNumber}`
        }
        case 3: {
          return `Asteroid #${body.OrbitNumber}`
        }
        case 5: {
          return `Comet #${body.OrbitNumber}`
        }
        default: {
          return `System Body #${body.SystemBodyID}`
        }
      }
    },

    podExpiration(lifepod) {
      let remainingSeconds = secondsPerTwoWeeks - (this.GameTime - lifepod.CreationTime)

      const days = Math.floor(remainingSeconds / 86400)
      remainingSeconds -= days * 86400
      
      const hours = Math.floor(remainingSeconds / 3600)
      remainingSeconds -= hours * 3600

      const minutes = Math.floor(remainingSeconds / 60)
      remainingSeconds -= minutes * 60

      return `${days > 0 && `${days}d `}${hours && `${hours}m `}${minutes && `${minutes}m `}${remainingSeconds && `${remainingSeconds}s`}` || 'Expired'
    },
  },
  computed: {
    ...mapGetters([
      'database',
      
      'GameID',
      'RaceID',

      'GameTime',
    ]),
  },
  asyncComputed: {
    damagedShips: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipDesignComponents.Name as ComponentName, FCT_ShipDesignComponents.Cost as ComponentCost from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_DamagedComponent on FCT_Ship.ShipID = FCT_DamagedComponent.ShipID inner join FCT_ShipDesignComponents on FCT_DamagedComponent.ComponentID = FCT_ShipDesignComponents.SDComponentID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0`).then(([ items ]) => {
          console.log('Damaged Ships', items)

          return Object.values(items.reduce((aggregate, item) => {
            if (!aggregate[item.ShipID]) {
              aggregate[item.ShipID] = {
                ShipID: item.ShipID,
                ShipName: item.ShipName,
                FleetName: item.FleetName,

                Components: [],
              }
            }
            
            aggregate[item.ShipID].Components.push({
              ComponentName: item.ComponentName,
              ComponentCost: item.ComponentCost
            })

            return aggregate
          }, {})).map(item => ({
            ...item,

            TotalCost: item.Components.reduce((sum, component) => sum + component.ComponentCost, 0)
          }))
        })

        ships.sort((alpha, beta) => beta.TotalCost - alpha.TotalCost)

        return ships
      },
      default: [],
    },
    armorDamagedShips: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, SUM(Damage) as ArmorDamage from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_ArmourDamage on FCT_Ship.ShipID = FCT_ArmourDamage.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_Ship.ShipID having SUM(Damage) > 0 order by ArmorDamage desc`).then(([ items ]) => {
          console.log('Armor Damaged Ships', items)

          return items
        })

        return ships
      },
      default: [],
    },
    lowMoraleCrews: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_Ship.CrewMorale from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_Ship.CrewMorale < 1 ORDER BY FCT_Ship.CrewMorale ASC`).then(([ items ]) => {
          console.log('Low Morale Ships', items)

          return items
        })

        return ships
      },
      default: [],
    },
    obsoleteShips: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipClass.ClassName from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.Obsolete = 1 ORDER BY FCT_ShipClass.ClassName ASC`).then(([ items ]) => {
          console.log('Obsolete Ships', items)

          return items
        })

        return ships
      },
      default: [],
    },
    lowMaintenanceShips: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_Ship.CurrentMaintSupplies, FCT_ShipClass.MaintSupplies, FCT_Ship.CurrentMaintSupplies / FCT_ShipClass.MaintSupplies as SupplyLevel from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and SupplyLevel < 1 and FCT_ShipClass.MaintSupplies > 0 ORDER BY SupplyLevel ASC`).then(([ items ]) => {
          console.log('Maintenanceless Ships', items)

          return items
        })

        return ships
      },
      default: [],
    },
    fullyTrainedShips: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_NavalAdminCommand.AdminCommandName from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_NavalAdminCommand on FCT_Fleet.ParentCommandID = FCT_NavalAdminCommand.NavalAdminCommandID left join DIM_NavalAdminCommandType on FCT_NavalAdminCommand.AdminCommandTypeID = DIM_NavalAdminCommandType.CommandTypeID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and DIM_NavalAdminCommandType.Description = 'Training' and FCT_Ship.TFPoints = 500 ORDER BY FCT_Fleet.FleetName ASC`).then(([ items ]) => {
          console.log('Fully Trained Ships', items)

          return items
        })

        return ships
      },
      default: [],
    },
    openFireShips: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipDesignComponents.Name as FCName, FCT_FireControlAssignment.FCNum from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_FireControlAssignment on FCT_Ship.ShipID = FCT_FireControlAssignment.ShipID left join FCT_ShipDesignComponents on FCT_FireControlAssignment.FCTypeID = FCT_ShipDesignComponents.SDComponentID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_FireControlAssignment.OpenFire = 1`).then(([ items ]) => {
          console.log('Open Fire Ships', items)

          return Object.values(items.reduce((aggregate, item) => {
            if (!aggregate[item.ShipID]) {
              aggregate[item.ShipID] = {
                ShipID: item.ShipID,
                ShipName: item.ShipName,
                FleetName: item.FleetName,

                FireControls: [],
              }
            }
            
            aggregate[item.ShipID].FireControls.push({
              FireControlName: item.FCName,
              FireControlNum: item.FCNum
            })

            return aggregate
          }, {}))
        })

        return ships
      },
      default: [],
    },
    freeConstructionCapacityPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select VIR_ConstructionPopulation.*, 100 - SUM(FCT_IndustrialProjects.Percentage) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as ConstructionAmount from FCT_Population inner join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.ConstructionValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_ConstructionPopulation left join FCT_IndustrialProjects on VIR_ConstructionPopulation.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType IN (0,3,4) group by FCT_IndustrialProjects.PopulationID having SUM(FCT_IndustrialProjects.Percentage) < 100`).then(([ items ]) => {
          console.log('Free Construction Capacity', items)

          return items
        })

        return ships
      },
      default: [],
    },
    freeOrdnanceCapacityPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select VIR_OrdnanceProductionPopulation.*, 100 - SUM(COALESCE(FCT_IndustrialProjects.Percentage, 0)) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as OrdnanceProductionAmount from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.OrdnanceProductionValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_OrdnanceProductionPopulation left join FCT_IndustrialProjects on VIR_OrdnanceProductionPopulation.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.ProductionType = 1 and FCT_IndustrialProjects.Queue = 0 group by VIR_OrdnanceProductionPopulation.PopulationID`).then(([ items ]) => {
          console.log('Free Ordnance Production Capacity', items)

          return items
        })

        return ships
      },
      default: [],
    },
    freeFighterCapacityPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select VIR_OrdnanceProductionPopulation.*, 100 - SUM(COALESCE(FCT_IndustrialProjects.Percentage, 0)) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as FighterProductionAmount from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.FighterProductionValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_OrdnanceProductionPopulation left join FCT_IndustrialProjects on VIR_OrdnanceProductionPopulation.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.ProductionType = 2 and FCT_IndustrialProjects.Queue = 0 group by VIR_OrdnanceProductionPopulation.PopulationID`).then(([ items ]) => {
          console.log('Free Ordnance Production Capacity', items)

          return items
        })

        return ships
      },
      default: [],
    },
    lowEfficiencyPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Efficiency, FCT_Population.Population from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Efficiency < 1 and FCT_Population.Population > 0 order by FCT_Population.Efficiency asc, FCT_Population.Population desc`).then(([ items ]) => {
          console.log('Low Efficiency Populations', items)

          return items
        })

        return ships
      },
      default: [],
    },
    selfSustainingDestinationPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Efficiency = 1 and FCT_Population.Population > 10 and FCT_Population.Capital = 0 order by FCT_Population.Population desc`).then(([ items ]) => {
          console.log('Self Sustaining Colonist Destinations', items)

          return items
        })

        return ships
      },
      default: [],
    },
    governorlessPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population from FCT_Population left join FCT_Commander on FCT_Population.PopulationID = FCT_Commander.CommandID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Commander.CommanderID is NULL and FCT_Population.Population > 0 order by FCT_Population.Population desc`).then(([ items ]) => {
          console.log('Populations Without Governor', items)

          return items
        })

        return ships
      },
      default: [],
    },
    commanderlessNavalAdministrations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.AdminCommandName, FCT_Population.PopName from FCT_NavalAdminCommand left join FCT_Commander on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID left join FCT_Population on FCT_NavalAdminCommand.PopulationID = FCT_Population.PopulationID where FCT_NavalAdminCommand.GameID = ${this.GameID} and FCT_NavalAdminCommand.RaceID = ${this.RaceID} and FCT_Commander.CommanderID is NULL`).then(([ items ]) => {
          console.log('Naval Administrations Without Commander', items)

          return items
        })

        return ships
      },
      default: [],
    },
    commanderlessSectors: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_SectorCommand.SectorCommandID, FCT_SectorCommand.SectorName, FCT_Population.PopName from FCT_SectorCommand left join FCT_Commander on FCT_SectorCommand.SectorCommandID = FCT_Commander.CommandID left join FCT_Population on FCT_SectorCommand.PopulationID = FCT_Population.PopulationID where FCT_SectorCommand.GameID = ${this.GameID} and FCT_SectorCommand.RaceID = ${this.RaceID} and FCT_Commander.CommanderID is NULL`).then(([ items ]) => {
          console.log('Sectors Without Commander', items)

          return items
        })

        return ships
      },
      default: [],
    },
    obsoleteShipyards: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_Shipyard.ShipyardID, FCT_Shipyard.ShipyardName, FCT_ShipClass.ClassName, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Population.PopName from FCT_Shipyard left join FCT_ShipClass on FCT_Shipyard.BuildClassID = FCT_ShipClass.ShipClassID left join FCT_Population on FCT_Shipyard.PopulationID = FCT_Population.PopulationID where FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID} and FCT_ShipClass.Obsolete = 0 order by FCT_Shipyard.Capacity * FCT_Shipyard.Slipways desc`).then(([ items ]) => {
          console.log('Obsolete Shipyards', items)

          return items
        })

        return ships
      },
      default: [],
    },
    stockpilingCivilianMinerals: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_Population.PopName, FCT_Population.Duranium + FCT_Population.Neutronium + FCT_Population.Corbomite + FCT_Population.Tritanium + FCT_Population.Boronide + FCT_Population.Mercassium + FCT_Population.Vendarite + FCT_Population.Sorium + FCT_Population.Uridium + FCT_Population.Corundium + FCT_Population.Gallicite as TotalStockpile, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.PurchaseCivilianMinerals = 1 and MassDriverDest = 0 order by TotalStockpile desc`).then(([ items ]) => {
          console.log('Stockpiling Civilian Minerals', items)

          return items
        })

        return ships
      },
      default: [],
    },
    activeLifePods: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const ships = await this.database.query(`select FCT_Lifepods.LifepodID, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, FCT_Lifepods.CreationTime, FCT_RaceSysSurvey.Name as SystemName from FCT_Lifepods left join FCT_RaceSysSurvey on FCT_Lifepods.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Lifepods.RaceID = FCT_RaceSysSurvey.RaceID where FCT_Lifepods.GameID = ${this.GameID} and FCT_Lifepods.RaceID = ${this.RaceID} order by FCT_Lifepods.CreationTime asc, FCT_Lifepods.Crew desc`).then(([ items ]) => {
          console.log('Active Lifepods', items)

          return items
        })

        return ships
      },
      default: [],
    },
  },
  watch: {
    // mapElements: {
    //   immediate: true,
    //   handler(data) {
    //     console.log('data', data, this.graph)

    //     if (data && this.graph) {   
    //       console.log('ABDO')
    //       this.graph.graphData(data)
    //     }
    //   }
    // },
  },
}
</script>

<style lang="scss" scoped>

</style>
