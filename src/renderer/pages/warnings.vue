<template>
  <div class="fill-height">
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row class="mb-5" justify="start" v-if="intruders.length">
          <v-col cols="12" class="display-1">
            Contacts
          </v-col>
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel v-if="intruders.length">
                <v-expansion-panel-header class="font-weight-bold">
                  Intruders detected in {{ intruders.length }} systems
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-expansion-panels hover>
                    <v-expansion-panel v-for="intruder in intruders" :key="intruder.System.SystemID">
                      <v-expansion-panel-header class="font-weight-bold">
                        {{ intruder.System.RaceSystemSurveys[0].Name }} &mdash;&nbsp; <span v-html="intruderTotals(intruder)"></span>
                      </v-expansion-panel-header>

                      <v-expansion-panel-content>
                        <v-list nav dense>
                          <v-list-item-group color="primary">
                            <v-list-item v-for="group of Object.values(intruder.Contacts)" :key="`${intruder.System.SystemID}-${group.Race.RaceID}`">
                              <v-list-item-content>
                                <v-list-item-title>{{ group.Race.AlienRaces[0].AlienRaceName }} &mdash; {{ Object.entries(group.Types).filter(([, contacts]) => contacts.length).map(([type, contacts]) => `${contacts.length} ${type}s`).join(', ') }} <span v-if="group.Race.AlienRaces[0].ContactStatus === 0">&mdash; <span class="red--text">Hostile</span></span></v-list-item-title>
                              </v-list-item-content>
                            </v-list-item>
                          </v-list-item-group>
                        </v-list>
                      </v-expansion-panel-content>
                    </v-expansion-panel>
                  </v-expansion-panels>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
        <v-row class="mb-5" justify="start" v-if="stockpilingCivilianMinerals.length || wastedMiningCapacity.length">
          <v-col cols="12" class="display-1">
            Economy
          </v-col>
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel v-if="stockpilingCivilianMinerals.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ stockpilingCivilianMinerals.length }} stockpiling civilian mining colonies
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="colony in stockpilingCivilianMinerals" :key="colony.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title v-html="populationName(colony)"></v-list-item-title>
                          <v-list-item-subtitle>Currently stockpiling {{ separatedNumber(roundToDecimal(colony.TotalStockpile)) }} Tons of mineral</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="wastedMiningCapacity.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ wastedMiningCapacity.length }} colonies with wasted mining capacity
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="colony in wastedMiningCapacity" :key="colony.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title v-html="populationName(colony)"></v-list-item-title>
                          <div class="caption mt-3 font-weight-medium">
                            {{ colony.Installations.map(installation => `${installation.Amount}x ${installation.Name}`).join(', ') }}
                          </div>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
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
                          <v-list-item-subtitle>{{ ship.ArmorDamage }} damage - Thinnest remaining layer: <span :class="`${levelColor(ship.ThinnestLayer / ship.ArmourThickness)}--text`">{{ ship.ThinnestLayer }}</span> </v-list-item-subtitle>
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
        <v-row class="mb-5" justify="start" v-if="freeConstructionCapacityPopulations.length || freeOrdnanceCapacityPopulations.length || freeFighterCapacityPopulations.length || lowEfficiencyPopulations.length || selfSustainingDestinationPopulations.length || deadResearchProjects.length">
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
                          <v-list-item-title v-html="populationName(population)"></v-list-item-title>
                          <v-list-item-subtitle><span class="font-weight-bold">{{ roundToDecimal(population.FreePercentage, 4) }}%</span> available capacity</v-list-item-subtitle>
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
                          <v-list-item-title v-html="populationName(population)"></v-list-item-title>
                          <v-list-item-subtitle><span class="font-weight-bold">{{ population.FreePercentage }}%</span> available capacity</v-list-item-subtitle>
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
                          <v-list-item-title v-html="populationName(population)"></v-list-item-title>
                          <v-list-item-subtitle><span class="font-weight-bold">{{ population.FreePercentage }}%</span> available capacity</v-list-item-subtitle>
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
                          <v-list-item-title><span :class="`${levelColor(population.Efficiency)}--text font-weight-bold`">{{ roundToDecimal(population.Efficiency * 100, 1) }}%</span> &mdash; <span  v-html="populationName(population)"></span></v-list-item-title>
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
                          <v-list-item-title v-html="populationName(population)"></v-list-item-title>
                          <v-list-item-subtitle>Population: {{ separatedNumber(roundToDecimal(population.Population * 1000000)) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="deadResearchProjects.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ deadResearchProjects.length }} dead research projects 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="research in deadResearchProjects" :key="research.PopulationID">
                        <v-list-item-content>
                          <v-list-item-title><span v-html="populationName(research)"></span> &mdash; {{ research.ResearchName }}</v-list-item-title>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
        <v-row class="mb-5" justify="start" v-if="governorlessPopulations.length || commanderlessNavalAdministrations.length || commanderlessSectors.length || mismatchedResearchFields.length">
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
                          <v-list-item-title v-html="populationName(population)"></v-list-item-title>
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
              <v-expansion-panel v-if="mismatchedResearchFields.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ mismatchedResearchFields.length }} researchers with mismatched projects 
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="researcher in mismatchedResearchFields" :key="researcher.CommanderID">
                        <v-list-item-content>
                          <v-list-item-title><span v-html="populationName(researcher)"></span> &mdash; {{ researcher.CommanderName }} on {{ researcher.ResearchName }}</v-list-item-title>
                          <v-list-item-subtitle>Field: {{ researcher.FieldName }} &mdash; Commander field: {{ researcher.CommanderFieldName }} &mdash; RP: {{ roundToDecimal(researcher.ResearchPointsRequired, 1) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
        <v-row class="mb-5" justify="start" v-if="obsoleteShipyards.length || activeLifepods.length || knownWrecks.length || knownUnexploitedConstructs.length || dangerousRifts.length">
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
              <v-expansion-panel v-if="activeLifepods.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ activeLifepods.length }} active lifepods
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="lifepod in activeLifepods" :key="lifepod.LifepodID">
                        <v-list-item-content>
                          <v-list-item-title>{{ lifepod.SystemName }} &mdash; {{ lifepod.ShipName }} &mdash; {{ lifepod.Crew }} People</v-list-item-title>
                          <v-list-item-subtitle>Time remaining: {{ podExpiration(lifepod) }}</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="knownWrecks.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ knownWrecks.length }} wrecks in explored space
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="wreck in knownWrecks" :key="wreck.WreckID">
                        <v-list-item-content>
                          <v-list-item-title>{{ wreck.SystemName }} &mdash; <span v-if="wreck.SystemBodyID">Orbiting {{ systemBodyName(wreck) }} &mdash; </span> {{ wreck.ClassName }}</v-list-item-title>
                          <v-list-item-subtitle>Size: {{ wreck.Size }}<span v-if="wreck.Owned"> &mdash; Owned design</span></v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="knownUnexploitedConstructs.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ knownUnexploitedConstructs.length }} unexploited ancient constructs
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="construct in knownUnexploitedConstructs" :key="construct.AncientConstructID">
                        <v-list-item-content>
                          <v-list-item-title>{{ construct.SystemBody.System.RaceSystemSurveys[0].Name }} &mdash; {{ modelSystemBodyName(construct.SystemBody) }}</v-list-item-title>
                          <v-list-item-subtitle v-if="construct.Active">{{ roundToDecimal((construct.ResearchBonus - 1) * 100) }}% {{ construct.ResearchField.FieldName }}</v-list-item-subtitle>
                          <v-list-item-subtitle v-else>Dormant</v-list-item-subtitle>
                          <v-list-item-subtitle v-if="construct.OwnPopulations.length">Lacking 10 million population on the body</v-list-item-subtitle>
                          <v-list-item-subtitle v-else>No population on the body</v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </v-list-item-group>
                  </v-list>
                </v-expansion-panel-content>
              </v-expansion-panel>
              <v-expansion-panel v-if="dangerousRifts.length">
                <v-expansion-panel-header class="font-weight-bold">
                  {{ dangerousRifts.length }} dangerous rifts in occupied systems
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-list nav dense>
                    <v-list-item-group color="primary">
                      <v-list-item v-for="(rift, index) in dangerousRifts" :key="index">
                        <v-list-item-content>
                          <v-list-item-title>{{ rift.System.RaceSystemSurveys[0].Name }} &mdash; Size: {{ separatedNumber(roundToDecimal(rift.Diameter / 1000000, 2)) }}Mkm</v-list-item-title>
                          <v-list-item-subtitle>
                            {{ [
                              rift.MilitaryFleets && `${rift.MilitaryFleets} military fleets`,
                              rift.CivilianFleets && `${rift.CivilianFleets} civilian fleets`
                            ].filter(f => f).join(', ') }}
                          </v-list-item-subtitle>
                          <v-list-item-subtitle>
                            {{ [
                              rift.InhabitedColonies && `${rift.InhabitedColonies} inhabited colonies`,
                              rift.UsedColonies && `${rift.UsedColonies} used colonies`,
                              rift.StockedColonies && `${rift.StockedColonies} stocked colonies`,
                              rift.GroundUnitBases && `${rift.GroundUnitBases} ground unit bases`,
                            ].filter(f => f).join(', ') }}
                          </v-list-item-subtitle>
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
import { mapGetters } from 'vuex'

import _partition from 'lodash/partition'

import { separatedNumber, roundToDecimal } from '../../utilities/math'
import { systemBodyName, modelSystemBodyName, populationName } from '../../utilities/aurora'

import { Op } from 'sequelize'

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

    systemBodyName,
    modelSystemBodyName,
    populationName,

    _partition,

    levelColor(morale) {
      if (morale > 0.85) {
        return 'green'
      }

      if (morale < 0.30) {
        return 'red'
      }

      return this.$vuetify.theme.dark ? 'yellow' : 'orange'
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

    intruderTotals(intruder) {
      return Object.entries(intruder.Totals).filter(([, contacts]) => contacts.length).map(([type, contacts]) => {
        const [hostiles, neutrals] = _partition(contacts, contact => contact.ContactRace.AlienRaces[0].ContactStatus === 0)

        const out = []

        if (hostiles.length) {
          out.push(`<span class="red--text">${hostiles.length} Hostile ${type}s</span>`)
        }

        if (neutrals.length) {
          out.push(`${neutrals.length} ${type}s`)
        }
        
        return out.join(', ')
      }).join(', ')
    },
  },
  computed: {
    ...mapGetters([
      'config',
      'database',
      
      'GameID',
      'RaceID',

      'GameTime',
    ]),
  },
  asyncComputed: {
    stockpilingCivilianMinerals: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const colonies = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Duranium + FCT_Population.Neutronium + FCT_Population.Corbomite + FCT_Population.Tritanium + FCT_Population.Boronide + FCT_Population.Mercassium + FCT_Population.Vendarite + FCT_Population.Sorium + FCT_Population.Uridium + FCT_Population.Corundium + FCT_Population.Gallicite as TotalStockpile, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.PurchaseCivilianMinerals = 1 and MassDriverDest = 0 order by TotalStockpile desc`).then(([ items ]) => {
          console.log('Stockpiling Civilian Minerals', items)

          return items
        })

        return colonies
      },
      default: [],
    },
    wastedMiningCapacity: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        // SYSTEM AND BODY NAME SUBQUERIES

        // FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component

        // left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID
        
        const installations = await this.database.query(`select DIM_PlanetaryInstallation.Name, DIM_PlanetaryInstallation.MiningProductionValue, FCT_PopulationInstallations.Amount, FCT_Population.PopulationID, FCT_Population.PopName, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID left join FCT_MineralDeposit ON FCT_Population.SystemBodyID = FCT_MineralDeposit.SystemBodyID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.MiningProductionValue > 0 and FCT_MineralDeposit.MaterialID is null`).then(([ items ]) => {
          console.log('Wasted Mining Capacity', items)

          return Object.values(items.reduce((aggregate, item) => {
            if (!aggregate[item.PopulationID]) {
              aggregate[item.PopulationID] = {
                PopulationID: item.PopulationID,
                PopName: item.PopName,

                SystemName: item.SystemName,
                SystemBodyID: item.SystemBodyID,
                PlanetNumber: item.PlanetNumber,
                OrbitNumber: item.OrbitNumber,
                BodyClass: item.BodyClass,
                SystemBodyName: item.SystemBodyName,
                Component: item.Component,

                Installations: [],
              }
            }
            
            aggregate[item.PopulationID].Installations.push({
              Name: item.Name,
              MiningProductionValue: item.MiningProductionValue,
              Amount: item.Amount,
            })

            return aggregate
          }, {})).map(item => ({
            ...item,

            TotalProductionValue: item.Installations.reduce((sum, installation) => sum + (installation.MiningProductionValue * installation.Amount), 0)
          }))
        })

        installations.sort((alpha, beta) => beta.TotalProductionValue - alpha.TotalProductionValue)

        return installations
      },
      default: [],
    },
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

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, SUM(FCT_ArmourDamage.Damage) as ArmorDamage,FCT_ShipClass.ArmourThickness, MIN(FCT_ShipClass.ArmourThickness - FCT_ArmourDamage.Damage) as ThinnestLayer from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID join FCT_ArmourDamage on FCT_Ship.ShipID = FCT_ArmourDamage.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_Ship.ShipID having SUM(FCT_ArmourDamage.Damage) > 0 order by ArmorDamage desc`).then(([ items ]) => {
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

        const ships = await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ShipClassID, FCT_Fleet.FleetName, FCT_Ship.CurrentMaintSupplies, FCT_ShipClass.MaintSupplies, FCT_Ship.CurrentMaintSupplies / FCT_ShipClass.MaintSupplies as SupplyLevel from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and SupplyLevel < 1 and FCT_ShipClass.MaintSupplies > 0 ORDER BY SupplyLevel ASC`).then(([ items ]) => {
          console.log('Maintenanceless Ships', items)

          return items.filter(item => {
            const exclusions = this.config.get(`game.${this.GameID}.race.${this.RaceID}.maintenanceExclusions`, [])

            return !exclusions.includes(item.ShipClassID) && item.SupplyLevel * 100 <= this.config.get(`game.${this.GameID}.race.${this.RaceID}.maintenanceThreshold`, 100)
          })
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
        
        const populations = await this.database.query(`select VIR_ConstructionPopulation.*, 100 - COALESCE(SUM(FCT_IndustrialProjects.Percentage), 0) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as ConstructionAmount, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population inner join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.ConstructionValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_ConstructionPopulation left join FCT_IndustrialProjects on VIR_ConstructionPopulation.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType IN (0,3,4) group by FCT_IndustrialProjects.PopulationID having FreePercentage > 0`).then(([ items ]) => {
          console.log('Free Construction Capacity', items)

          return items.filter(item => item.FreePercentage > 0.00006)
        })

        return populations
      },
      default: [],
    },
    freeOrdnanceCapacityPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const populations = await this.database.query(`select VIR_OrdnanceProductionPopulation.*, 100 - COALESCE(SUM(FCT_IndustrialProjects.Percentage), 0) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as OrdnanceProductionAmount, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.OrdnanceProductionValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_OrdnanceProductionPopulation left join FCT_IndustrialProjects on VIR_OrdnanceProductionPopulation.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType = 1 group by VIR_OrdnanceProductionPopulation.PopulationID having FreePercentage > 0`).then(([ items ]) => {
          console.log('Free Ordnance Production Capacity', items)

          return items
        })

        return populations
      },
      default: [],
    },
    freeFighterCapacityPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const populations = await this.database.query(`select VIR_OrdnanceProductionPopulation.*, 100 - COALESCE(SUM(FCT_IndustrialProjects.Percentage), 0) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as FighterProductionAmount, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.FighterProductionValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_OrdnanceProductionPopulation left join FCT_IndustrialProjects on VIR_OrdnanceProductionPopulation.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType = 2 group by VIR_OrdnanceProductionPopulation.PopulationID having FreePercentage > 0`).then(([ items ]) => {
          console.log('Free Fighter Production Capacity', items)

          return items
        })

        return populations
      },
      default: [],
    },
    deadResearchProjects: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const populations = await this.database.query(`select VIR_ResearchProductionPopulation.*, FCT_TechSystem.Name as ResearchName from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as ResearchProductionAmount, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.ResearchValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_ResearchProductionPopulation left join FCT_ResearchProject on VIR_ResearchProductionPopulation.PopulationID = FCT_ResearchProject.PopulationID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID where ResearchName is not null group by VIR_ResearchProductionPopulation.PopulationID having SUM(VIR_ResearchProductionPopulation.ResearchProductionAmount) = 0`).then(([ items ]) => {
          console.log('Dead Research Projects', items)

          return items
        })

        return populations
      },
      default: [],
    },
    lowEfficiencyPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const populations = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Efficiency, FCT_Population.Population, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Efficiency < 1 and FCT_Population.Population > 0 order by FCT_Population.Efficiency asc, FCT_Population.Population desc`).then(([ items ]) => {
          console.log('Low Efficiency Populations', items)

          return items
        })

        return populations
      },
      default: [],
    },
    selfSustainingDestinationPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const populations = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Efficiency = 1 and FCT_Population.Population > 10 and FCT_Population.Capital = 0 and FCT_Population.ColonistDestination = 0 order by FCT_Population.Population desc`).then(([ items ]) => {
          console.log('Self Sustaining Colonist Destinations', items)

          return items
        })

        return populations
      },
      default: [],
    },
    governorlessPopulations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const populations = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Population left join FCT_Commander on FCT_Population.PopulationID = FCT_Commander.CommandID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Commander.CommanderID is NULL and FCT_Population.Population > 0 order by FCT_Population.Population desc`).then(([ items ]) => {
          console.log('Populations Without Governor', items)

          return items
        })

        return populations
      },
      default: [],
    },
    mismatchedResearchFields: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const scientists = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_Commander.CommanderID, FCT_Commander.Name as CommanderName, DIM_ResearchField_2.FieldName as CommanderFieldName, FCT_TechSystem.Name as ResearchName, DIM_ResearchField.FieldName, FCT_ResearchProject.ResearchPointsRequired from FCT_ResearchProject inner join FCT_Population on FCT_ResearchProject.PopulationID = FCT_Population.PopulationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join DIM_TechType on FCT_TechSystem.TechTypeID = DIM_TechType.TechTypeID left join DIM_ResearchField on DIM_TechType.FieldID = DIM_ResearchField.ResearchFieldID left join FCT_Commander on FCT_ResearchProject.ProjectID = FCT_Commander.CommandID and FCT_Commander.CommanderType = 3 left join DIM_ResearchField as DIM_ResearchField_2 on FCT_Commander.ResSpecID = DIM_ResearchField_2.ResearchFieldID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID} and DIM_ResearchField.ResearchFieldID != DIM_ResearchField_2.ResearchFieldID`).then(([ items ]) => {
          console.log('Mismatched Research Fields', items)

          return items
        })

        return scientists
      },
      default: [],
    },
    commanderlessNavalAdministrations: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const administrations = await this.database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.AdminCommandName, FCT_Population.PopName from FCT_NavalAdminCommand left join FCT_Commander on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID left join FCT_Population on FCT_NavalAdminCommand.PopulationID = FCT_Population.PopulationID where FCT_NavalAdminCommand.GameID = ${this.GameID} and FCT_NavalAdminCommand.RaceID = ${this.RaceID} and FCT_Commander.CommanderID is NULL`).then(([ items ]) => {
          console.log('Naval Administrations Without Commander', items)

          return items
        })

        return administrations
      },
      default: [],
    },
    commanderlessSectors: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const sectors = await this.database.query(`select FCT_SectorCommand.SectorCommandID, FCT_SectorCommand.SectorName, FCT_Population.PopName from FCT_SectorCommand left join FCT_Commander on FCT_SectorCommand.SectorCommandID = FCT_Commander.CommandID left join FCT_Population on FCT_SectorCommand.PopulationID = FCT_Population.PopulationID where FCT_SectorCommand.GameID = ${this.GameID} and FCT_SectorCommand.RaceID = ${this.RaceID} and FCT_Commander.CommanderID is NULL`).then(([ items ]) => {
          console.log('Sectors Without Commander', items)

          return items
        })

        return sectors
      },
      default: [],
    },
    obsoleteShipyards: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const shipyards = await this.database.query(`select FCT_Shipyard.ShipyardID, FCT_Shipyard.ShipyardName, FCT_ShipClass.ClassName, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Population.PopName from FCT_Shipyard left join FCT_ShipClass on FCT_Shipyard.BuildClassID = FCT_ShipClass.ShipClassID left join FCT_Population on FCT_Shipyard.PopulationID = FCT_Population.PopulationID where FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID} and FCT_ShipClass.Obsolete = 1 order by FCT_Shipyard.Capacity * FCT_Shipyard.Slipways desc`).then(([ items ]) => {
          console.log('Obsolete Shipyards', items)

          return items
        })

        return shipyards
      },
      default: [],
    },
    activeLifepods: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const lifepods = await this.database.query(`select FCT_Lifepods.LifepodID, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, FCT_Lifepods.CreationTime, FCT_RaceSysSurvey.Name as SystemName from FCT_Lifepods left join FCT_RaceSysSurvey on FCT_Lifepods.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Lifepods.RaceID = FCT_RaceSysSurvey.RaceID where FCT_Lifepods.GameID = ${this.GameID} and FCT_Lifepods.RaceID = ${this.RaceID} order by FCT_Lifepods.CreationTime asc, FCT_Lifepods.Crew desc`).then(([ items ]) => {
          console.log('Active Lifepods', items)

          return items
        })

        return lifepods
      },
      default: [],
    },
    knownWrecks: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }
        
        const wrecks = await this.database.query(`select FCT_Wrecks.WreckID, FCT_Wrecks.Size, FCT_ShipClass.ClassName, CAST(CASE WHEN FCT_Wrecks.RaceID = FCT_RaceSysSurvey.RaceID THEN 1 ELSE 0 END AS BIT) as Owned, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Wrecks join FCT_RaceSysSurvey on FCT_Wrecks.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} left join FCT_ShipClass on FCT_Wrecks.ClassID = FCT_ShipClass.ShipClassID left join FCT_SystemBody on FCT_Wrecks.OrbitBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Wrecks.GameID = ${this.GameID}`).then(([ items ]) => {
          console.log('Known Wrecks', items)

          return items
        })

        return wrecks
      },
      default: [],
    },
    knownUnexploitedConstructs: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const constructs = await this.database.models.AncientConstruct.findAll({
          where: {
            GameID: this.GameID,
          },

          include: [{
            model: this.database.models.ResearchField,
          }, {
            required: true,
            model: this.database.models.SystemBody,
            include: [{
              required: false,
              model: this.database.models.Population,
            }, {
              required: true,
              model: this.database.models.System,
              include: [{
                required: true,
                model: this.database.models.RaceSystemSurvey,
                where: {
                  RaceID: this.RaceID,
                },
              }]
            }, {
              required: true,
              model: this.database.models.SystemBodySurvey,
              where: {
                RaceID: this.RaceID,
              },
            }, {
              required: false,
              model: this.database.models.SystemBodyName,
              where: {
                RaceID: this.RaceID,
              },
            }, {
              model: this.database.models.Star,
            }]
          }],
        }).then((items) => {
          console.log('Unexploited Constructs', items)

          return items.map(construct => {
            construct.OwnPopulations = construct.SystemBody.Populations.filter(population => population.RaceID === this.RaceID)
            construct.AlienPopulations = construct.SystemBody.Populations.filter(population => population.RaceID !== this.RaceID)

            return construct
          }).filter(construct => !construct.Active || !construct.OwnPopulations.length || !construct.OwnPopulations.filter(population => population.Population > 10).length)
        })

        return constructs
      },
      default: [],
    },
    dangerousRifts: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const rifts = await this.database.models.AetherRift.findAll({
          where: {
            GameID: this.GameID,
          },

          include: [{
            required: true,
            model: this.database.models.System,
            include: [{
              required: true,
              model: this.database.models.RaceSystemSurvey,
              where: {
                RaceID: this.RaceID,
              },
            }, {
              required: false,
              model: this.database.models.Population,
              where: {
                RaceID: this.RaceID,
              },
              include: [{
                model: this.database.models.PopulationInstallation,
                // include: [{
                //   required: true,
                //   model: this.database.models.PlanetaryInstallation,
                // }]
              }, {
                model: this.database.models.GroundUnitFormation,
              }],
            }, {
              required: false,
              model: this.database.models.Fleet,
              where: {
                RaceID: this.RaceID,
              },
            }],
          }],

          order: [['Diameter', 'DESC']]
        }).then((items) => {
          console.log('Dangerous Rifts', items)

          return items.map(item => {
            const [civilianFleets, militaryFleets] = _partition(item.System.Fleets, fleet => fleet.ShippingLine)

            const [inhabitedColonies, uninhabitedColonies] = _partition(item.System.Populations, population => population.Population)
            const [usedColonies, unusedColonies] = _partition(uninhabitedColonies, population => population.PopulationInstallations.length)
            const [stockedColonies, emptyColonies] = _partition(unusedColonies, population => population.FuelStockpile || population.MaintenanceStockpile || population.Duranium || population.Neutronium || population.Corbomite || population.Tritanium || population.Boronide || population.Mercassium || population.Vendarite || population.Sorium || population.Uridium || population.Corundium || population.Gallicite)
            const [groundUnitBases] = _partition(emptyColonies, population => population.GroundUnitFormations.length)

            return {
              ...item.toJSON(),

              CivilianFleets: civilianFleets.length,
              MilitaryFleets: militaryFleets.length,

              InhabitedColonies: inhabitedColonies.length,
              UsedColonies: usedColonies.length,
              StockedColonies: stockedColonies.length,

              GroundUnitBases: groundUnitBases.length,
            }
          }).filter(item => item.CivilianFleets || item.MilitaryFleets || item.InhabitedColonies || item.UsedColonies || item.StockedColonies || item.GroundUnitBases)
        })

        console.log(rifts)

        return rifts
      },
      default: [],
    },
    intruders: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const contacts = await this.database.models.Contact.findAll({
          where: {
            GameID: this.GameID,
            DetectRaceID: this.RaceID,

            ContactType: {
              [Op.in]: [1, 3, 4, 12, 14, 16]
            }
          },

          group: 'ContactID',
          order: [['LastUpdate', 'DESC']],

          include: [{
            required: true,
            model: this.database.models.System,
            include: [{
              required: true,
              model: this.database.models.RaceSystemSurvey,
              where: {
                RaceID: this.RaceID,
              },
            }],
          }, {
            required: true,
            model: this.database.models.Race,
            as: 'ContactRace',

            where: {
              RaceID: {
                [Op.ne]: this.RaceID
              },
            },

            include: [{
              model: this.database.models.AlienRace,

              where: {
                ViewRaceID: this.RaceID,
              },
            }],
          }, {
            required: false,
            model: this.database.models.Population,
          }]
        }).then((items) => {
          console.log('Intruder Contacts', items)

          const typeMap = {
            0: 'Other',
            1: 'Ship',
            3: 'Salvo',
            4: 'Population',
            12: 'GroundUnit',
            14: 'GroundUnit',
            16: 'Shipyard',
          }

          return Object.values(items.reduce((aggregate, contact) => {
            if (!contact.ContactRace.AlienRaces.length) {
              console.log('!!! NO ALIEN RACE', contact)

              return aggregate
            }

            if ([2, 3].includes(contact.ContactRace.AlienRaces[0].ContactStatus)) {
              return aggregate
            }
            

            if (!aggregate[contact.SystemID]) {
              aggregate[contact.SystemID] = {
                System: contact.System,

                Contacts: {},
                Totals: Object.fromEntries(Object.values(typeMap).map(type => [type, []])),
              }
            }

            if (!aggregate[contact.SystemID].Contacts[contact.ContactRaceID]) {
              aggregate[contact.SystemID].Contacts[contact.ContactRaceID] = {
                Race: contact.ContactRace,

                Types: Object.fromEntries(Object.values(typeMap).map(type => [type, []])),
              }
            }

            aggregate[contact.SystemID].Contacts[contact.ContactRaceID].Types[typeMap[contact.ContactType] || 'Other'].push(contact)
            aggregate[contact.SystemID].Totals[typeMap[contact.ContactType] || 'Other'].push(contact)

            return aggregate
          }, {}))
        })

        return contacts
      },
      default: [],
    },
  },
}
</script>

<style lang="scss" scoped>

</style>
