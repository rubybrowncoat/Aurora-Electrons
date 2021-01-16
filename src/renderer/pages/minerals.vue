<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-if="bodyGroups">
      <v-container fluid>
        <v-row justify="start">
          <!-- <v-col cols="12">
            <v-btn-toggle class="mb-3" v-model="materials" color="deep-purple accent-3" tile dense group multiple borderless>
              <v-btn v-for="(material, key) in MaterialMap" :key="key" small :value="material">{{ material }}</v-btn>
            </v-btn-toggle>
          </v-col> -->
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel>
                <v-expansion-panel-header class="font-weight-bold">
                  Filters
                </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-container fluid>
                    <v-row justify="start">
                      <v-col cols="12">
                        <v-btn-toggle class="d-block" v-model="materials" :color="$vuetify.theme.dark ? 'purple lighten-3' : 'deep-purple accent-3'" tile dense group multiple borderless>
                          <v-btn v-for="(material, key) in MaterialMap" :key="key" small :value="material">{{ material }}</v-btn>
                        </v-btn-toggle>
                      </v-col>
                    </v-row>
                    <v-row justify="start" v-for="(filter, index) in filters" :key="index">
                      <v-col cols="12" md="6">
                        <v-sheet class="d-flex flex-row">
                          <div class="d-flex mr-2">
                            <v-btn color="red" dense @click="removeFilter(index)" :disabled="!index && filters.length === 1">
                              <v-icon dark>mdi-minus</v-icon>
                            </v-btn>
                          </div>
                          <v-select class="d-flex" v-model="filter.selectedMaterial" :items="filterMaterials" hint="Filtered Material" solo persistent-hint dense></v-select>
                        </v-sheet>
                      </v-col>
                      <v-col cols="12" md="3">
                        <v-select v-model="filter.selectedAccessibility" :items="accessibilities" hint="Minimum Accessibility" solo persistent-hint dense></v-select>
                      </v-col>
                      <v-col cols="12" md="3">
                        <v-text-field type="number" min="1" v-model.number="filter.selectedAmount" placeholder="45000" hint="Minimum Quantity" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense></v-text-field>
                      </v-col>
                    </v-row>
                    <v-row>
                      <v-col>
                        <v-btn color="success d-flex mr-2" dark @click="addFilter">
                          <v-icon dark>mdi-plus</v-icon>
                        </v-btn>
                      </v-col>
                    </v-row>
                  </v-container>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
          <v-col cols="12">
            <v-select v-model="systems" :items="systemNames" label="Active Systems" item-text="SystemName" item-value="SystemID" multiple small-chips deletable-chips>
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
          <v-col cols="12">
            <v-data-table class="elevation-2" :headers="headers" :items="preFilteredBodyGroups">
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
              <template v-slot:[`item.Potential`]="{ item }">
                <v-tooltip top>
                  <template #activator="{ on }">
                    <span :class="{
                      'green--text text--lighten-1 font-weight-bold title': item.Potential >= Math.PI / 2 * materialCount * 0.75,
                      'red--text text--darken-3 font-weight-bold': item.Potential <= Math.PI / 2 * materialCount * 0.3,
                    }" v-on="on">{{ roundToDecimal(( item.Potential * 10 ) / ( Math.PI / 2 * materialCount )) }}</span>
                  </template>
                  
                  <span>{{ roundToDecimal(item.Potential, 3) }}</span>
                </v-tooltip>
              </template>
              <template v-for="material in materials" v-slot:[`item.${material}`]="{ item }">
                <span :class="{
                  'green--text text--lighten-1 font-weight-bold': item[material].Accessibility > 0.7,
                  'red--text text--darken-3 font-weight-bold': item[material].Accessibility <= 0.2,
                  'orange--text text--accent-3': item[material].Accessibility <= 0.4 && item[material].Accessibility > 0.2,
                }" :key="material" v-if="item[material]">{{ separatedNumber(roundToDecimal(item[material].Amount)) }} ({{ item[material].Accessibility }})</span>
              </template>
              <template v-slot:[`item.TotalAmount`]="{ item }">
                {{ separatedNumber(Math.round(item.TotalAmount)) }}
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

const baseFilter = {
  selectedMaterial: 'Any',
  selectedAccessibility: 0.0,
  selectedAmount: null,
}

export default {
  components: {},
  data() {
    return {
      filterMaterials: ['Any', 'All Present', 'All', ...Object.values(MaterialMap)],

      accessibilities: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
      selectedAccessibility: 0.1,

      filters: [{
        ...baseFilter,
      }],

      selectedAmount: null,

      panels: [0, 1, 2],
      
      materials: Object.values(MaterialMap),
      systems: [],

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
    
    addFilter() {
      this.filters.push({
        ...baseFilter,
      })
    },
    removeFilter(index) {
      this.filters.splice(index, 1)
    },
    
    applyMaterialFilter(material, filter) {
      const insideAccessibilityRange = material.Accessibility >= filter.selectedAccessibility
                
      if (filter.selectedAmount) {
        return material.Amount >= filter.selectedAmount && insideAccessibilityRange
      }

      return insideAccessibilityRange
    },

    toggleSystems() {
      if (!this.systems.length) {
        this.systems = this.systemNames.map(system => system.SystemID)
      } else {
        this.systems = []
      }
    },
    bodyName(processedBody) {
      if (processedBody.SystemBodyName) {
        return processedBody.SystemBodyName
      }
      
      switch (processedBody.SystemBodyClass) {
        case 1: {
          return `${convertDisplayBase(processedBody.SystemComponent, 26)} ${romanum.toNumeral(processedBody.PlanetNumber)}`
        }
        case 2: {
          return `${convertDisplayBase(processedBody.SystemComponent, 26)} ${romanum.toNumeral(processedBody.PlanetNumber)}-${processedBody.OrbitNumber}`
        }
        case 3: {
          return `Asteroid #${processedBody.OrbitNumber}`
        }
        case 5: {
          return `Comet #${processedBody.OrbitNumber}`
        }
        default: {
          return `System Body #${processedBody.SystemBodyID}`
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

    bodyGroups() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      const aggregation = this.minerals.reduce((bodies, item) => {
        if (!this.systems.includes(item.SystemID)) {
          return bodies
        }

        if (!bodies[item.SystemBodyID]) {
          bodies[item.SystemBodyID] = {
            SystemID: item.SystemID,
            SystemName: item.SystemName,
            SystemComponent: item.Component,

            SystemBodyID: item.SystemBodyID,
            SystemBodyName: item.SystemBodyName,
            SystemBodyOrder: `${item.Component}-${item.PlanetNumber}-${item.OrbitNumber}`,

            PlanetNumber: item.PlanetNumber,
            OrbitNumber: item.OrbitNumber,

            SystemBodyClass: item.BodyClass,
            SystemBodyType: item.BodyTypeID,

            GroundMineralSurvey: item.GroundMineralSurvey,
          }
        }

        bodies[item.SystemBodyID][this.MaterialMap[item.MaterialID]] = {
          Amount: item.Amount,
          Accessibility: item.Accessibility,

          HalfOriginalAmount: item.HalfOriginalAmount,
          OriginalAcc: item.OriginalAcc,
        }

        return bodies
      }, {})

      return Object.values(aggregation).map(body => {
        const [totalPotential, totalAmount] = Object.values(this.materials).reduce(([potential, amount], materialId) => {
          const material = body[materialId]

          if (material) {
            potential += Math.atan(Math.pow(material.Amount / 20000, Math.cos((Math.PI / 2) * material.Accessibility - (Math.PI / 2))) * ( 0.5 - ( Math.cos(Math.PI * material.Accessibility) / 2 )))
            amount += material.Amount
          }

          return [potential, amount]
        }, [0, 0])

        return {
          ...body,

          Potential: totalPotential,
          TotalAmount: totalAmount,
        }
      })
    },
    systemNames() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      return Object.values(this.minerals.reduce((names, item) => {
        if (!names[item.SystemID]) {
          names[item.SystemID] = {
            SystemID: item.SystemID,
            SystemName: item.SystemName,
          }
        }

        return names
      }, {}))
    },

    preFilteredBodyGroups() {
      return this.bodyGroups.filter(body => {
        return this.filters.every(filter => {
          switch (filter.selectedMaterial) {
            case 'Any': {
              return this.materials.some(materialName => {
                const material = body[materialName]

                if (!material) {
                  return false
                }

                return this.applyMaterialFilter(material, filter)
              })
            }
            case 'All Present': {
              return this.materials.every(materialName => {
                const material = body[materialName]

                if (!material) {
                  return true
                }

                return this.applyMaterialFilter(material, filter)
              })
            }
            case 'All': {
              return this.materials.every(materialName => {
                const material = body[materialName]

                if (!material) {
                  return false
                }

                return this.applyMaterialFilter(material, filter)
              })
            }
            default: {
              const material = body[filter.selectedMaterial]

              if (!material) {
                return false
              }

              return this.applyMaterialFilter(material, filter) 
            }
          }
        })
      })
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

    materialCount() {
      return Object.keys(this.materials).length
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
          sort: (alpha, beta) => {
            console.log(alpha, beta)
            return collator.compare(alpha, beta)
          }
        },
        {
          text: 'Potential',
          value: 'Potential',
          divider: true,
          align: 'center',
        },
        {
          text: 'Ground',
          value: 'GroundMineralSurvey',
          divider: true,
          align: 'center',
        },
        ...this.materials.map(material => ({
          text: material,
          value: material,
          sortable: true,
          align: 'center',
          sort: (alpha, beta) => {
            const alphaQuantity = alpha ? alpha.Amount : 0
            const betaQuantity = beta ? beta.Amount : 0

            return betaQuantity - alphaQuantity
          },
        })),
        {
          text: 'Total',
          value: 'TotalAmount',
        },
      ]
    }
  },
  asyncComputed: {
    minerals: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const minerals = await this.database.query(`select FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.StarID, FCT_SystemBody.RuinID, FCT_SystemBody.RuinRaceID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName from FCT_MineralDeposit join FCT_RaceSysSurvey on FCT_SystemBody.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBody on FCT_MineralDeposit.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID left join FCT_Race on FCT_Race.RaceID = FCT_SystemBodySurveys.RaceID and FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}) and FCT_MineralDeposit.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Minerals', items)

          return items
        })

        // const minerals = await this.database.query(`select FCT_MineralDeposit.*, FCT_SystemBody.Name as SystemBodyName, FCT_SystemBody.GroundMineralSurvey, DIM_KnownSystems.Name as SystemName from FCT_MineralDeposit left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID left join FCT_System on FCT_System.SystemID = FCT_MineralDeposit.SystemID left join DIM_KnownSystems on DIM_KnownSystems.KnownSystemID = FCT_System.SystemNumber where FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID join FCT_Race on FCT_Race.RaceID = FCT_SystemBodySurveys.RaceID and FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID})`).then(([ items ]) => {
        //   console.log('Minerals', items)

        //   return items
        // })
              
        return minerals
      },
      default: [],
    },
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
