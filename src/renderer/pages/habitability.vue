<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row justify="start">
          <v-col cols="6">
            <v-autocomplete
              v-model="selectedSpeciesId"
              :items="species"

              :item-text="item => `${item.SpeciesName} (${separatedNumber(roundToDecimal(item.TotalPopulation, 2))} M)`"
              item-value="SpeciesID"

              label="Species"
              
              auto-select-first
              
              dense
              solo
            ></v-autocomplete>
          </v-col>
          <v-col cols="6">
            <v-text-field type="number" min="10" v-model.number="terraformers" placeholder="40" :hint="`Terraformers at ${selectedSpecies.TerraformingRate} rate`" :rules="[rules.required, rules.positive]" persistent-hint dense solo validate-on-blur></v-text-field>
          </v-col>
          <v-col cols="12">
            <v-select :disabled="filterBySelectedBodies" v-model="systems" :items="systemNames" label="Active Systems" item-text="SystemName" item-value="SystemID" multiple small-chips deletable-chips>
              <template v-slot:prepend-item>
                <v-list-item
                  ripple
                  @click="toggleSystems"
                >
                  <v-list-item-action>
                    <v-icon>{{ systems.length > 0 
                      ? systems.length == systemNames.length 
                        ? 'sentiment_very_satisfied'
                        : 'sentiment_satisfied'
                      : 'sentiment_very_dissatisfied' }}</v-icon>
                  </v-list-item-action>
                  <v-list-item-content>
                    <v-list-item-title>Select All</v-list-item-title>
                  </v-list-item-content>
                </v-list-item>
                <v-divider class="mt-2"></v-divider>
              </template>
            </v-select>
          </v-col>
          <v-col cols="12" v-if="selectedBodies.length || filterBySelectedBodies">
            <v-row>
              <v-col cols="auto">
                <v-btn class="d-block mb-1" style="width: 100%;" small outlined :color="filterBySelectedBodies ? 'red' : ''" @click="filterBySelectedBodies = !filterBySelectedBodies">Isolate in Habitability</v-btn>
                <v-btn :to="{
                  path: 'minerals',
                  query: { 
                    bodies: JSON.stringify(selectedBodies.map(selection => ({ 
                      SystemBodyID: selection.SystemBodyID, 
                      SystemBodyName: selection.SystemBodyName, 
                      SystemName: selection.SystemName, 
                      BodyClass: selection.BodyClass, 
                      Component: selection.Component, 
                      PlanetNumber: selection.PlanetNumber, 
                      OrbitNumber: selection.OrbitNumber, 
                    }))) 
                  },
                }" style="width: 100%;" small outlined>Isolate in Minerals</v-btn>

                <v-btn class="d-block mt-4" style="width: 100%;" small outlined @click="selectedBodies = []; filterBySelectedBodies = false">Clear Selection</v-btn>
              </v-col>
              <v-col>
                <v-chip class="mr-2 mb-2" v-for="body of selectedBodies" :key="body.SystemBodyID" small label outlined close @click:close="() => selectedBodies = selectedBodies.filter(selection => selection.SystemBodyID !== body.SystemBodyID)">{{ body.SystemName }} {{ bodyName(body) }}</v-chip>
              </v-col>
            </v-row>
          </v-col>
          <v-col cols="6" md="3">
            <v-checkbox
              v-model="filterNonTerraformable"
              label="Hide Non-Terraformable"
            ></v-checkbox>
          </v-col>
          <v-col cols="6" md="3">
            <v-checkbox
              v-model="filterWithoutMinerals"
              label="Hide Without Minerals"
            ></v-checkbox>
          </v-col>
          <v-col cols="6" md="3">
            <v-checkbox
              v-model="filterOwnPopulations"
              label="Hide Own Populations"
            ></v-checkbox>
          </v-col>
          <v-col cols="6" md="3">
            <v-checkbox
              v-model="filterOtherPopulations"
              label="Hide Other Populations"
            ></v-checkbox>
          </v-col>
          <v-col cols="12">
            <v-data-table class="elevation-2" :headers="headers" :items="filteredCalculatedBodies" item-key="SystemBodyID" :expanded.sync="expandedRows" :sort-desc.sync="sortDescending" show-expand @click:row="(data, { expand, isExpanded, item }) => item.Liveable && item.TerraformationTime && expand(!isExpanded)">
              <template v-slot:[`item.data-table-expand`]="{ item, isExpanded, expand }">
                <td style="white-space: nowrap;">
                  <v-btn @click.stop="() => selectedBodies = selectedBodies.filter(selection => selection.SystemBodyID !== item.SystemBodyID)" v-if="selectedBodies.find(selection => selection.SystemBodyID === item.SystemBodyID)" color="red" icon><v-icon>mdi-playlist-remove</v-icon></v-btn>
                  <v-btn @click.stop="() => selectedBodies.push(item)" v-else icon><v-icon>mdi-playlist-plus</v-icon></v-btn>
                  
                  <template v-if="item.Liveable">
                    <v-btn @click.stop="expand(false)" v-if="isExpanded" icon><v-icon>mdi-arrow-expand-up</v-icon></v-btn>
                    <v-btn @click.stop="expand(true)" v-else icon><v-icon>mdi-arrow-expand-vertical</v-icon></v-btn>
                  </template>
                </td>
              </template>
              <template v-slot:expanded-item="{ item }">
                <td :colspan="headers.length + 1" class="px-4 py-3" v-if="item.TerraformationPlan">
                  <v-container fluid>
                    <v-row justify="start">
                      <v-col cols="12" md="8">
                        <v-list-item>
                          <v-list-item-content>
                            <v-list-item-title>
                              <h2>Rough Terraforming Blueprint</h2>
                            </v-list-item-title>
                            
                            <v-list-item-subtitle>
                              Hydrographic Extent: {{ roundToDecimal(item.HydroExt, 1) }} &mdash; Albedo: {{ roundToDecimal(item.Albedo, 1) }} (recalculate if albedo changes)
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <template v-if="item.TerraformationPlan.Toxics.length">
                          <v-list-item two-line v-for="toxic of item.TerraformationPlan.Toxics" :key="toxic.AtmosGasID">
                            <v-list-item-content>
                              <v-list-item-title class="text-wrap">
                                Set {{ toxic.AtmosGasName }} to 0 maximum atm.
                              </v-list-item-title>
                              <v-list-item-subtitle>
                                This is going to take about {{ roundToDecimal(toxic.RemovalTime, 1) }} years.
                              </v-list-item-subtitle>
                            </v-list-item-content>
                          </v-list-item>
                        </template>

                        <v-list-item two-line v-if="item.TerraformationPlan.WaterVapourTime">
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              <span v-if="item.TerraformationPlan.WaterVapour > 0">Set Water Vapour to {{ roundToDecimal(item.TerraformationPlan.WaterVapour, 3) }} maximum atm.</span>
                              <span v-else>Set Water Vapour to a small amount and wait for Hydrographic Extent to be higher than 20.</span>
                            </v-list-item-title>
                            <v-list-item-subtitle>
                              This is going to take about {{ roundToDecimal(item.TerraformationPlan.WaterVapourTime, 2) }} years.
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item two-line v-if="item.TerraformationPlan.BreathableTime">
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.BreathableName }} to {{ roundToDecimal(item.TerraformationPlan.Breathable, 3) }} maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle>
                              This is going to take about {{ roundToDecimal(item.TerraformationPlan.BreathableTime, 2) }} years.
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item two-line v-if="item.TerraformationPlan.GreenhouseTime">
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.GreenhouseName }} to {{ roundToDecimal(item.TerraformationPlan.Greenhouse - item.TerraformationPlan.GreenhouseSideContributions, 3) }} maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle>
                              This is going to take about {{ roundToDecimal(item.TerraformationPlan.GreenhouseTime, 2) }} years.
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item two-line v-if="item.TerraformationPlan.AntiGreenhouseTime">
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.AntiGreenhouseName }} to {{ roundToDecimal(item.TerraformationPlan.AntiGreenhouse - item.TerraformationPlan.AntiGreenhouseSideContributions, 3) }} maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle>
                              This is going to take about {{ roundToDecimal(item.TerraformationPlan.AntiGreenhouseTime, 2) }} years.
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item two-line v-if="item.TerraformationPlan.NeutralTime">
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.NeutralName }} to {{ roundToDecimal(item.TerraformationPlan.Neutral - item.TerraformationPlan.NeutralSideContributions, 3) }} maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle>
                              This is going to take about {{ roundToDecimal(item.TerraformationPlan.NeutralTime, 2) }} years.
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>
                      </v-col>
                      <v-col cols="12" md="4">
                        <v-card outlined class="mb-3">
                          <v-list-item three-line>
                            <v-list-item-content>
                              <div class="overline">
                                ATMOSPHERIC PRESSURE
                              </div>
                              <v-list-item-title class="headline mb-1">
                                {{ roundToDecimal(item.TerraformedAtmosphere, 2) }} atm
                              </v-list-item-title>
                              <v-list-item-subtitle>From: {{ roundToDecimal(item.StartingAtmosphere, 2) }}</v-list-item-subtitle>
                            </v-list-item-content>
                          </v-list-item>
                        </v-card>
                        <v-card outlined class="mb-3">
                          <v-list-item three-line>
                            <v-list-item-content>
                              <div class="overline">
                                BREATHABLE PRESSURE
                              </div>
                              <v-list-item-title class="headline mb-1">
                                {{ roundToDecimal(item.TerraformationPlan.Breathable, 2) }} atm
                              </v-list-item-title>
                              <v-list-item-subtitle>From: {{ roundToDecimal(item.TerraformationPlan.BreathableStart, 2) }} ({{ item.TerraformationPlan.BreathableName }})</v-list-item-subtitle>
                            </v-list-item-content>
                          </v-list-item>
                        </v-card>
                        <v-card outlined>
                          <v-list-item three-line>
                            <v-list-item-content>
                              <div class="overline">
                                SURFACE TEMPERATURE
                              </div>
                              <v-list-item-title class="headline mb-1">
                                {{ roundToDecimal(item.TerraformedSurfaceTemperature - 273, 2) }} C
                              </v-list-item-title>
                              <v-list-item-subtitle>From: {{ roundToDecimal(item.SurfaceTemp - 273, 2) }}</v-list-item-subtitle>
                            </v-list-item-content>
                          </v-list-item>
                        </v-card>
                      </v-col>
                    </v-row>
                  </v-container>
                </td>
              </template>
              <template v-slot:[`item.SystemBodyOrder`]="{ item }">
                {{ bodyName(item) }}
              </template>
              <template v-slot:[`item.GroundMineralSurvey`]="{ item }">
                <v-tooltip top>
                  <template #activator="{ on }">
                    <span v-if="item.GroundMineralSurvey" v-on="on">M{{ item.GroundMineralSurvey }}</span>
                    <span v-else v-on="on">❌</span>
                  </template>
                  
                  <span>{{ GroundMineralSurveyMap[item.GroundMineralSurvey] }}</span>
                </v-tooltip>
              </template>
              <template v-slot:[`item.MaximumPopulation`]="{ item }">
                <v-tooltip top v-if="item.Populations.length">
                  <template #activator="{ on }">
                    <span :class="{
                      'green--text text--lighten-1 font-weight-bold': item.OwnPopulation && !item.OtherPopulation,
                      'red--text text--darken-3 font-weight-bold': !item.OwnPopulation && item.OtherPopulation,
                      'orange--text font-weight-bold': item.OwnPopulation && item.OtherPopulation,
                    }" v-on="on">
                      {{ separatedNumber(roundToDecimal(item.TotalPopulation, 2)) }} / {{ separatedNumber(roundToDecimal(item.MaximumPopulation, 2)) }}
                    </span>
                  </template>
                  
                  <span v-if="item.OwnPopulation && item.OtherPopulation">
                    Mixed Population
                  </span>
                  <span v-else-if="item.OwnPopulation">
                    Own Population
                  </span>
                  <span v-else>
                    Alien Population
                  </span>
                </v-tooltip>
                <span v-else>{{ separatedNumber(roundToDecimal(item.MaximumPopulation, 2)) }}</span>
              </template>
              <template v-slot:[`item.MaximumPopulationAtOptimalHydro`]="{ item }">
                <span v-if="item.MaximumPopulationAtOptimalHydro === item.MaximumPopulation" class="green--text text--lighten-1 font-weight-bold">
                  Optimal
                </span>
                <span v-else>
                  {{ separatedNumber(roundToDecimal(item.MaximumPopulationAtOptimalHydro, 2)) }}
                </span>
              </template>
              <template v-slot:[`item.Liveable`]="{ item }">
                <span class="orange--text font-weight-bold" v-if="item.LowGravity && item.Liveable">LG</span>
                <span :class="{
                  'green--text text--lighten-1 font-weight-bold': item.Liveable,
                  'red--text text--darken-3 font-weight-bold': !item.Liveable,
                }" v-else>{{ item.Liveable ? 'Y' : 'N' }}</span>
              </template>
              <template v-slot:[`item.TerraformationTime`]="{ item }">
                <span v-if="item.TerraformationTime > 0">
                  {{ separatedNumber(roundToDecimal(item.TerraformationTime, 1)) }}
                </span>
                <span class="green--text text--lighten-1 font-weight-bold" v-else-if="item.Liveable">
                  Done
                </span>
                <span class="red--text text--darken-3 font-weight-bold" v-else>
                  Impossible
                </span>
              </template>
              <template v-slot:[`item.MiningPotential`]="{ item }">
                <span :class="{
                  'green--text text--lighten-1 font-weight-bold title': item.MiningPotential >= 7.5,
                  'red--text text--darken-3 font-weight-bold': item.MiningPotential <= 3,
                }" v-if="item.Minerals.length">{{ roundToDecimal(item.MiningPotential, 1) }}</span>
                <span class="orange--text font-weight-bold" v-else>N/A</span>
              </template>
              <template v-slot:[`header.MiningPotential`]="{ header }">
                <v-tooltip top>
                  <template v-slot:activator="{ on }">
                    <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
                  </template>
                  <span>Potential calculated for available minerals on the body.</span>
                </v-tooltip>
              </template>
              <template v-slot:[`item.TotalMiningAmount`]="{ item }">
                <span v-if="!item.BodySurveyed" class="orange--text font-weight-bold">
                  Unsurveyed
                </span>
                <span v-else>
                  {{ separatedNumber(roundToDecimal(item.TotalMiningAmount)) }}
                </span>
              </template>
            </v-data-table>
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

const MaterialMap = {
  // 0: 'Nothing',
  1: 'Duranium',
  2: 'Neutronium',
  3: 'Corbomite',
  4: 'Tritanium',
  5: 'Boronide',
  6: 'Mercassium',
  7: 'Vendarite',
  8: 'Sorium',
  9: 'Uridium',
  10: 'Corundium',
  11: 'Gallicite',
}

const GroundMineralSurveyMap = {
  0: 'Completed',
  1: 'Minimal',
  2: 'Low',
  3: 'Good',
  4: 'High',
  5: 'Excellent',
}

const BodyClass = {
  0: 'None',
  1: 'Planet',
  2: 'Moon',
  3: 'Asteroid',
  4: 'JumpPoint',
  5: 'Comet',
  6: 'LagrangePoint',
  7: 'Wormhole',
}

const maxBreathablePercentage = 30
const earthSurfaceArea = 511187128
const baseMaxPop = 12000

export default {
  components: {},
  data() {
    return {
      selectedSpeciesId: null,
      terraformers: 10,

      filterNonTerraformable: false,
      filterWithoutMinerals: false,
      filterOwnPopulations: false,
      filterOtherPopulations: false,

      expandedRows: [],
      sortDescending: [false],
      
      systems: [],

      selectedBodies: [],
      filterBySelectedBodies: false,

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

    toggleSystems() {
      if (!this.systems.length) {
        this.systems = this.systemNames.map(system => system.SystemID)
      } else {
        this.systems = []
      }
    },

    bodyName(body) {
      if (body.SystemBodyName) {
        return body.SystemBodyName
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
    }
  },
  computed: {
    ...mapGetters([
      'database',
      
      'GameID',
      'RaceID',
    ]),

    selectedSpecies() {
      const extant = this.species.find(species => species.SpeciesID === this.selectedSpeciesId)

      return extant || {}
    },
    rawTerraformingPower() {
      return this.selectedSpecies.TerraformingRate * this.terraformers
    },

    filteredCalculatedBodies() {
      return this.calculatedBodies.filter(body => {
        return ( this.filterBySelectedBodies ? !!this.selectedBodies.find(selection => selection.SystemBodyID === body.SystemBodyID) : this.systems.includes(body.SystemID) )
            && (this.filterNonTerraformable ? body.Liveable && !body.LowGravity : true) 
            && (this.filterWithoutMinerals ? body.TotalMiningAmount > 0 : true) 
            && (this.filterOwnPopulations ? !body.OwnPopulation || body.OtherPopulation : true) 
            && (this.filterOtherPopulations ? !body.OtherPopulation || body.OwnPopulation : true) 
      })
    },
    calculatedBodies() {
      console.log('recalculate calculatedBodies')

      return this.selectedSpecies.SpeciesID ? this.bodies.filter(body => body.Gravity <= this.selectedSpecies.IdealGravity + this.selectedSpecies.GravityDeviation).map(body => {
        const localSurfaceArea = 4 * Math.PI * Math.pow(body.Radius, 2)

        // MAXIMUM POPULATION
        const tidalModifier = body.TidalLock && BodyClass[body.BodyClass] !== 'Moon' ? 5 : 1
        const hydroModifier = body.HydroExt > 75 ? Math.max((100 - body.HydroExt) / 25, 0.01) : 1

        const maxPopPreModifiers = (localSurfaceArea / earthSurfaceArea) * baseMaxPop * this.selectedSpecies.PopulationDensityModifier

        const newBody = {
          ...body,

          LowGravity: body.Gravity < this.selectedSpecies.IdealGravity - this.selectedSpecies.GravityDeviation,

          MaximumPopulation: Math.max((maxPopPreModifiers * hydroModifier) / tidalModifier, 0.05),
          MaximumPopulationAtOptimalHydro: Math.max(maxPopPreModifiers / tidalModifier, 0.05),
        }

        if (body.Gravity >= 0.1) {
          const localTerraformingPower = earthSurfaceArea / localSurfaceArea * this.rawTerraformingPower

          const { breathablePressure, toxicPressure, greenhousePressure, antiGreenhousePressure, waterVapourPressure, neutralPressure, totalPressure, toxics, greenhouses, antiGreenhouses, neutrals } = body.Atmosphere.reduce((aggregate, gas) => {
            if (gas.AtmosGasID === this.selectedSpecies.BreatheID) {
              aggregate.breathablePressure += gas.GasAtm
            } else if (gas.Dangerous) {
              aggregate.toxicPressure += gas.GasAtm

              aggregate.toxics.push({
                AtmosGasID: gas.AtmosGasID,
                AtmosGasName: gas.AtmosGasName,
                GasAtm: gas.GasAtm,
                RemovalTime: gas.GasAtm / localTerraformingPower,
              })
            } else if (gas.AtmosGasID === 5) {
              aggregate.waterVapourPressure += gas.GasAtm
            } else if (gas.GHGas) {
              aggregate.greenhousePressure += gas.GasAtm

              aggregate.greenhouses.push({
                AtmosGasID: gas.AtmosGasID,
                AtmosGasName: gas.AtmosGasName,
                GasAtm: gas.GasAtm,
              })
            } else if (gas.AntiGHGas) {
              aggregate.antiGreenhousePressure += gas.GasAtm

              aggregate.antiGreenhouses.push({
                AtmosGasID: gas.AtmosGasID,
                AtmosGasName: gas.AtmosGasName,
                GasAtm: gas.GasAtm,
              })
            } else {
              aggregate.neutralPressure += gas.GasAtm

              aggregate.neutrals.push({
                AtmosGasID: gas.AtmosGasID,
                AtmosGasName: gas.AtmosGasName,
                GasAtm: gas.GasAtm,
              })
            }

            aggregate.totalPressure += gas.GasAtm

            return aggregate
          }, {
            breathablePressure: 0,
            toxicPressure: 0,
            greenhousePressure: 0,
            antiGreenhousePressure: 0,
            waterVapourPressure: 0,
            neutralPressure: 0,
            totalPressure: 0,

            toxics: [],
            greenhouses: [],
            antiGreenhouses: [],
            neutrals: [],
          })

          greenhouses.sort((alpha, beta) => beta.GasAtm - alpha.GasAtm)
          antiGreenhouses.sort((alpha, beta) => beta.GasAtm - alpha.GasAtm)

          const greenhouseFactor = Math.min(1 + (totalPressure / 10) + greenhousePressure - antiGreenhousePressure, 3)
          const surfaceTemperature = body.BaseTemp * greenhouseFactor * body.Albedo

          // WATER VAPOUR
          const waterVapourNeeded = Math.max((20 - Math.min(body.HydroExt, 20)) * 0.025 - waterVapourPressure, 0)
          const waterVapourTime = waterVapourNeeded / localTerraformingPower
          const maxWaterVapourAtmospheres = (localTerraformingPower - 0.1) * waterVapourTime
          const waterVapourCondensationTime = waterVapourNeeded / 0.1 > waterVapourTime ? waterVapourNeeded / 0.1 : waterVapourTime

          // TOXICS
          const toxicRemovalTime = toxicPressure / localTerraformingPower

          // BREATHABLE
          const minimumBreathableDifference = breathablePressure > this.selectedSpecies.IdealBreathePressure + this.selectedSpecies.BreathePressureDeviation ? (this.selectedSpecies.IdealBreathePressure + this.selectedSpecies.BreathePressureDeviation) - breathablePressure : Math.max(this.selectedSpecies.IdealBreathePressure - this.selectedSpecies.BreathePressureDeviation - breathablePressure, 0)
          const minimumBreathableTime = Math.abs(minimumBreathableDifference) / localTerraformingPower

          // MIDSTEP
          const workbasePressure = (totalPressure - waterVapourPressure - toxicPressure) + minimumBreathableDifference
          const workbaseGreenhouseFactor = Math.min(1 + (workbasePressure / 10) + greenhousePressure - antiGreenhousePressure, 3)
          const workbaseSurfaceTemperature = body.BaseTemp * workbaseGreenhouseFactor * body.Albedo

          // GREENHOUSE
          const requiredTemperature = workbaseSurfaceTemperature < this.selectedSpecies.IdealTemperature - this.selectedSpecies.TemperatureDeviation 
            ? this.selectedSpecies.IdealTemperature - this.selectedSpecies.TemperatureDeviation
            : workbaseSurfaceTemperature > this.selectedSpecies.IdealTemperature + this.selectedSpecies.TemperatureDeviation
              ? this.selectedSpecies.IdealTemperature + this.selectedSpecies.TemperatureDeviation
              : workbaseSurfaceTemperature
          const requiredGreenhouseFactor = requiredTemperature / (body.BaseTemp * body.Albedo)
          const deltaGreenhouseFactor = requiredGreenhouseFactor - workbaseGreenhouseFactor

          const greenhouseNeeded = deltaGreenhouseFactor > 0 ? roundToDecimal(deltaGreenhouseFactor / 1.1, 3) : 0
          const antiGreenhouseNeeded = deltaGreenhouseFactor < 0 ? roundToDecimal(Math.abs(deltaGreenhouseFactor / 0.9), 3) : 0
          const greenhouseTime = Math.max(greenhouseNeeded, antiGreenhouseNeeded) / localTerraformingPower

          // RELATIVE PRESSURE
          const combinedRelativeBreathablePressure = workbasePressure + Math.max(greenhouseNeeded, antiGreenhouseNeeded)
          const neutralNeeded = Math.max((breathablePressure + minimumBreathableDifference) / 0.3 - combinedRelativeBreathablePressure, 0)
          const neutralTime = Math.abs(neutralNeeded) / localTerraformingPower

          // RELATIVE HEAT
          const combinedRelativeHeatPressure = combinedRelativeBreathablePressure + neutralNeeded
          const combinedRelativeHeatGreenhouseFactor = 1 + (combinedRelativeHeatPressure / 10) + greenhousePressure + greenhouseNeeded - antiGreenhousePressure - antiGreenhouseNeeded
          const combinedRelativeHeatSurfaceTemperature = body.BaseTemp * combinedRelativeHeatGreenhouseFactor * body.Albedo
          const combinedAntiGreenhouseNeeded = combinedRelativeHeatSurfaceTemperature > this.selectedSpecies.IdealTemperature + this.selectedSpecies.TemperatureDeviation ? combinedRelativeHeatGreenhouseFactor - requiredGreenhouseFactor : 0
          const combinedAntiGreenhouseTime = Math.abs(combinedAntiGreenhouseNeeded) / localTerraformingPower

          // TERRAFORMATION PLAN
          const TerraformationPlan = {
            WaterVapourStart: waterVapourPressure,
            WaterVapour: maxWaterVapourAtmospheres,
            WaterVapourTime: waterVapourCondensationTime,

            BreathableStart: breathablePressure,
            Breathable: breathablePressure + minimumBreathableDifference,
            BreathableTime: minimumBreathableTime,
            BreathableName: this.selectedSpecies.BreatheName,

            ToxicStart: toxicPressure,
            Toxic: 0,
            Toxics: toxics,
            ToxicTime: toxicRemovalTime,

            GreenhouseStart: greenhousePressure,
            Greenhouse: greenhousePressure + greenhouseNeeded,
            GreenhouseName: greenhouses.length ? greenhouses[0].AtmosGasName : 'Aestusium',
            GreenhouseSideContributions: greenhouses.reduce((sum, greenhouse, index) => sum + (index && greenhouse.GasAtm), 0),
            GreenhouseTime: greenhouseNeeded > 0 ? greenhouseTime : 0,

            AntiGreenhouseStart: antiGreenhousePressure,
            AntiGreenhouse: antiGreenhousePressure + antiGreenhouseNeeded + combinedAntiGreenhouseNeeded,
            AntiGreenhouseName: antiGreenhouses.length ? antiGreenhouses[0].AtmosGasName : 'Frigusium',
            AntiGreenhouseSideContributions: antiGreenhouses.reduce((sum, antiGreenhouse, index) => sum + (index && antiGreenhouse.GasAtm), 0),
            AntiGreenhouseTime: (antiGreenhouseNeeded > 0 ? greenhouseTime : 0) + combinedAntiGreenhouseTime,

            NeutralStart: neutralPressure,
            Neutral: neutralPressure + neutralNeeded,
            NeutralName: neutrals.length ? neutrals[0].AtmosGasName : 'Nitrogen',
            NeutralSideContributions: neutrals.reduce((sum, neutral, index) => sum + (index && neutral.GasAtm), 0),
            NeutralTime: neutralTime,
          }

          newBody.TerraformationPlan = TerraformationPlan
          newBody.TerraformationTime = TerraformationPlan.WaterVapourTime + TerraformationPlan.BreathableTime + TerraformationPlan.ToxicTime + TerraformationPlan.GreenhouseTime + TerraformationPlan.AntiGreenhouseTime + TerraformationPlan.NeutralTime

          newBody.StartingAtmosphere = totalPressure
          newBody.TerraformedAtmosphere = TerraformationPlan.Breathable + TerraformationPlan.Greenhouse + TerraformationPlan.AntiGreenhouse + TerraformationPlan.Neutral

          newBody.TerraformedSurfaceTemperature = body.BaseTemp * body.Albedo * combinedRelativeHeatGreenhouseFactor

          newBody.Liveable = newBody.TerraformedAtmosphere < this.selectedSpecies.MaximumPressure
        } else {
          newBody.TerraformationPlan = null
          newBody.TerraformationTime = -Infinity
          newBody.StartingAtmosphere = 0
          newBody.TerraformedAtmosphere = 0
          newBody.TerraformedSurfaceTemperature = body.SurfaceTemp
          newBody.Liveable = false
        }

        // MINERALS
        const [miningPotential, totalMiningAmount] = body.Minerals.reduce(([potential, amount], mineral) => {
          potential += Math.atan(Math.pow(mineral.Amount / 20000, Math.cos((Math.PI / 2) * mineral.Accessibility - (Math.PI / 2))) * ( 0.5 - ( Math.cos(Math.PI * mineral.Accessibility) / 2 )))
          amount += mineral.Amount

          return [potential, amount]
        }, [0, 0])

        newBody.MiningPotential = body.Minerals.length && (miningPotential * 10) / (Math.PI / 2 * body.Minerals.length)
        newBody.TotalMiningAmount = totalMiningAmount
        
        // EXTANT POPULATIONS
        const { totalPopulation, ownPopulation, otherPopulation } = body.Populations.reduce((aggregate, population) => {
          aggregate.totalPopulation += population.Population
          
          const ownExtant = this.species.find(species => species.SpeciesID === population.SpeciesID)
          
          if (ownExtant) {
            aggregate.ownPopulation = true
          } else {
            aggregate.otherPopulation = true
          }

          return aggregate
        }, {
          totalPopulation: 0,
          ownPopulation: false,
          otherPopulation: false,
        })

        newBody.TotalPopulation = totalPopulation
        newBody.OwnPopulation = ownPopulation
        newBody.OtherPopulation = otherPopulation

        return newBody
      }) : []
    },

    systemNames() {
      if (!this.calculatedBodies || !this.calculatedBodies.length) {
        return []
      }

      return Object.values(this.calculatedBodies.reduce((names, item) => {
        if (!names[item.SystemID]) {
          names[item.SystemID] = {
            SystemID: item.SystemID,
            SystemName: item.SystemName,
          }
        }

        return names
      }, {}))
    },

    MaterialMap() {
      return MaterialMap
    },
    GroundMineralSurveyMap() {
      return GroundMineralSurveyMap
    },
    BodyClass() {
      return BodyClass
    },

    headers() {
      const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

      return [
        {
          text: 'System',
          value: 'SystemName',
          divider: true,
        },
        {
          text: 'Body',
          value: 'SystemBodyOrder',
          divider: true,
          sort: collator.compare,
        },
        {
          text: 'Ground',
          value: 'GroundMineralSurvey',
          divider: true,
          align: 'center',
        },
        {
          text: 'Max Population (M)',
          value: 'MaximumPopulation',
          divider: true,
        },
        {
          text: 'Optimal Max (M)',
          value: 'MaximumPopulationAtOptimalHydro',
          divider: true,
        },
        {
          text: 'Terraformable',
          value: 'Liveable',
          divider: true,
          align: 'center',
          sortable: false,
        },
        {
          text: 'Time (Y)',
          value: 'TerraformationTime',
          divider: true,
          align: 'center',
          sort: (alpha, beta) => alpha === -Infinity 
            ? (this.sortDescending[0] ? -1 : 1) 
            : beta === -Infinity 
              ? (this.sortDescending[0] ? 1 : -1) 
              : alpha - beta,
        },
        {
          text: 'Potential',
          value: 'MiningPotential',
          divider: true,
          align: 'center',
        },
        {
          text: 'Total Minerals (T)',
          value: 'TotalMiningAmount',
          divider: true,
        },
      ]
    }
  },
  asyncComputed: {
    bodies: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const bodies = await this.database.query(`select FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.StarID, FCT_SystemBody.RuinID, FCT_SystemBody.RuinRaceID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Radius, FCT_SystemBody.Gravity, FCT_SystemBody.BaseTemp, FCT_SystemBody.SurfaceTemp, FCT_SystemBody.HydroExt, FCT_SystemBody.Albedo, FCT_SystemBody.TidalLock, FCT_SystemBody.RadiationLevel, FCT_SystemBody.DustLevel, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, FCT_Population.PopulationID, FCT_Population.Population, FCT_Population.SpeciesID, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, CAST(CASE WHEN FCT_SystemBodySurveys.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT) AS BodySurveyed, FCT_AtmosphericGas.AtmosGasID, FCT_AtmosphericGas.AtmosGasAmount, FCT_AtmosphericGas.GasAtm, FCT_AtmosphericGas.FrozenOut, DIM_Gases.BoilingPoint, DIM_Gases.GHGas, DIM_Gases.AntiGHGas, DIM_Gases.Dangerous, DIM_Gases.DangerousLevel, DIM_Gases.Name as AtmosGasName from FCT_SystemBody left join FCT_Population on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_RaceSysSurvey on FCT_SystemBody.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = FCT_SystemBody.GameID left join FCT_SystemBodySurveys on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_MineralDeposit on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID and FCT_SystemBodySurveys.SystemBodyID = FCT_MineralDeposit.SystemBodyID left join FCT_AtmosphericGas on FCT_SystemBody.SystemBodyID = FCT_AtmosphericGas.SystemBodyID left join DIM_Gases on FCT_AtmosphericGas.AtmosGasID = DIM_Gases.GasID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBody.BodyTypeID not in (0, 4, 5) and FCT_SystemBody.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID} order by FCT_SystemBody.SystemBodyID asc`).then(([ items ]) => {
          console.log('Terraforming', items)

          const bodyPops = {}
          const bodyMats = {}
          const bodyAtmos = {}

          return Object.values(items.reduce((aggregate, item) => {
            if (!aggregate[item.SystemBodyID]) {
              aggregate[item.SystemBodyID] = {
                SystemBodyID: item.SystemBodyID,
                ParentBodyID: item.ParentBodyID,
                SystemBodyName: item.SystemBodyName,
                SystemName: item.SystemName,
                SystemID: item.SystemID,
                StarID: item.StarID,
                RuinID: item.RuinID,
                RuinRaceID: item.RuinRaceID,
                BodyClass: item.BodyClass,
                BodyTypeID: item.BodyTypeID,
                Component: item.Component,
                PlanetNumber: item.PlanetNumber,
                OrbitNumber: item.OrbitNumber,
                SystemBodyOrder: `${item.Component}-${item.PlanetNumber}-${item.OrbitNumber}`,
                GroundMineralSurvey: item.GroundMineralSurvey,
                BodySurveyed: item.BodySurveyed,

                Radius: item.Radius,
                Gravity: item.Gravity,
                BaseTemp: item.BaseTemp,
                SurfaceTemp: item.SurfaceTemp,
                HydroExt: item.HydroExt,
                Albedo: item.Albedo,
                RadiationLevel: item.RadiationLevel,
                DustLevel: item.DustLevel,

                Populations: [],
                Minerals: [],
                Atmosphere: [],
              }
            }

            if (!bodyPops[item.SystemBodyID]) {
              bodyPops[item.SystemBodyID] = []
            }

            if (!bodyMats[item.SystemBodyID]) {
              bodyMats[item.SystemBodyID] = []
            }

            if (!bodyAtmos[item.SystemBodyID]) {
              bodyAtmos[item.SystemBodyID] = []
            }

            if (item.PopulationID && !bodyPops[item.SystemBodyID].includes(item.PopulationID)) {
              bodyPops[item.SystemBodyID].push(item.PopulationID)

              aggregate[item.SystemBodyID].Populations.push({
                PopulationID: item.PopulationID,
                Population: item.Population,
                SpeciesID: item.SpeciesID,
              })
            }

            if (item.MaterialID && !bodyMats[item.SystemBodyID].includes(item.MaterialID)) {
              bodyMats[item.SystemBodyID].push(item.MaterialID)

              aggregate[item.SystemBodyID].Minerals.push({
                MaterialID: item.MaterialID,
                MaterialName: this.MaterialMap[item.MaterialID],
                Amount: item.Amount,
                Accessibility: item.Accessibility,
                HalfOriginalAmount: item.HalfOriginalAmount,
                OriginalAcc: item.OriginalAcc,
              })
            }

            if (item.AtmosGasID && !bodyAtmos[item.SystemBodyID].includes(item.AtmosGasID)) {
              bodyAtmos[item.SystemBodyID].push(item.AtmosGasID)

              aggregate[item.SystemBodyID].Atmosphere.push({
                AtmosGasID: item.AtmosGasID,
                AtmosGasName: item.AtmosGasName,
                AtmosGasAmount: item.AtmosGasAmount,
                GasAtm: item.GasAtm,
                FrozenOut: item.FrozenOut,
                BoilingPoint: item.BoilingPoint,
                GHGas: item.GHGas,
                AntiGHGas: item.AntiGHGas,
                Dangerous: item.Dangerous,
                DangerousLevel: item.DangerousLevel,
              })
            }

            return aggregate
          }, {}))
        })
              
        return bodies
      },
      default: [],
    },
    species: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const species = await this.database.query(`select FCT_Population.SpeciesID, FCT_Species.SpeciesName, sum(FCT_Population.Population) as TotalPopulation, FCT_Race.TerraformingRate, FCT_Species.BreatheID, DIM_Gases.Name as BreatheName, FCT_Species.Oxygen as IdealBreathePressure, FCT_Species.OxyDev as BreathePressureDeviation, FCT_Species.PressMax as MaximumPressure, FCT_Species.Temperature as IdealTemperature, FCT_Species.TempDev as TemperatureDeviation, FCT_Species.Gravity as IdealGravity, FCT_Species.GravDev as GravityDeviation, FCT_Species.PopulationDensityModifier from FCT_Population left join FCT_Race on FCT_Population.RaceID = FCT_Race.RaceID left join FCT_Species on FCT_Population.SpeciesID = FCT_Species.SpeciesID left join DIM_Gases on FCT_Species.BreatheID = DIM_Gases.GasID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SpeciesID`).then(([ items ]) => {
          console.log('Species', items)

          return items
        })

        if (species.length) {
          this.selectedSpeciesId = species[0].SpeciesID
        }
          
        return species
      },
      default: [],
    },
  },
  asyncData({ route }) {
    const selectedBodies = route.query.bodies ? JSON.parse(route.query.bodies) : []

    return {
      selectedBodies,
      filterBySelectedBodies: route.query.bodies && selectedBodies.length ? true : false,
    }
  },
  watch: {
    systemNames: {
      immediate: true,
      handler(newNames) {
        if (newNames) {
          this.systems = newNames.map(system => system.SystemID)
        }
      }
    },
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>

</style>
