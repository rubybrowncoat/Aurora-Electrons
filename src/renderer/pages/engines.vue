<template>
  <div>
    <section class="section short-top">
      <h1 class="title">Parameters</h1>

      <v-container fluid>
        <v-row justify="start">
          <v-col cols="12" md="6">
            <v-select v-model="selectedEngine" :items="selectResearches(splitEngines)" item-text="Name" item-value="AdditionalInfo" :hint="`Engine Technology ${selectedEngine ? `- ${selectedEngine} EP/HS` : ''}`" solo persistent-hint dense></v-select>
          </v-col>
          <v-col cols="12" md="6">
            <v-select v-model="selectedFuelConsumtion" :items="selectResearches(splitFuelConsumptions)" item-text="Name" item-value="AdditionalInfo" :hint="`Fuel Efficiency Factor ${selectedFuelConsumtion ? `- ${selectedFuelConsumtion} L/EPH` : ''}`" solo persistent-hint dense></v-select>
          </v-col>
          <v-col cols="12" md="6" lg="8">
            <v-range-slider v-model="selectedThrustModifierRange" :min="0.1" :max="3" :step="0.05" thumb-size="48" :hint="`Engine Power Multplier Range ${selectedThrustModifierRange.length ? `- Between ${selectedThrustModifierRange[0]} and ${selectedThrustModifierRange[1]}` : ''}`" persistent-hint dense>
              <template #thumb-label="{ value }">
                <div class="font-weight-bold" :class="[ value <= edgeThrustModifiers[1] && value >= edgeThrustModifiers[0] ? 'light-green--text text--lighten-3' : 'orange--text text--lighten-1' ]">{{ value }}</div>
              </template>
            </v-range-slider>
            <!-- <b-slider v-model="selectedPower" :custom-formatter="val => `${(val * 100).toFixed(0)}%`" :min="0.1" :max="2.5" :step="0.05" :tooltip-type="powerType" ticks></b-slider> -->
          </v-col>
          <v-col cols="12" md="6" lg="4">
            <v-select v-model="selectedEngineSize" :items="selectResearches(splitEngineSizes)" item-text="Name" item-value="AdditionalInfo" solo dense></v-select>
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field type="number" min="100" v-model.number="selectedTonnage" placeholder="15000" hint="Rough Tonnage (Tons)" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense></v-text-field>
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field type="number" min="10" v-model.number="selectedSpeed" placeholder="2000" hint="Itended Speed (km/s)" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense></v-text-field>
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field type="number" min="0" v-model.number="selectedRange" placeholder="100" hint="Itended Range (B km)" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense></v-text-field>
          </v-col>
          <v-col cols="12" md="6" lg="3">
            <v-select v-model="selectedJump" :items="jumps" hint="Jump Drive Type" solo persistent-hint dense></v-select>
          </v-col>
          <v-col cols="12" md="6" lg="3">
            <v-select v-model="selectedJumpEfficiency" :items="selectResearches(splitJumpEfficiencies)" item-text="Name" item-value="AdditionalInfo" :hint="selectedJump ? `${(selectedSquadronSize * selectedSqudronRadius).toFixed(2)} Total Coefficient` : 'No Jump Drive'" :disabled="!selectedJump" solo persistent-hint dense></v-select>
          </v-col>
          <v-col cols="12" md="6" lg="3">
            <v-select v-model="selectedSquadronSize" :items="selectResearches(splitSquadronSizes)" item-text="Name" item-value="AdditionalInfo2" :hint="`Squadron Size ${selectedSquadronSize ? `- ${selectedSquadronSize}x Coefficient` : ''}`" :disabled="!selectedJump" solo persistent-hint dense>
              <template #item="{ item }">
                {{ item.Name.split(' - ')[1] }}
              </template>
              <template #selection="{ item }">
                {{ item.Name.split(' - ')[1] }}
              </template></v-select>
          </v-col>
          <v-col cols="12" md="6" lg="3">
            <v-select v-model="selectedSqudronRadius" :items="selectResearches(splitSquadronRadiuses)" item-text="Name" item-value="AdditionalInfo2" :hint="`Jump Radius ${selectedSqudronRadius ? `- ${selectedSqudronRadius}x Coefficient` : ''}`" :disabled="!selectedJump" solo persistent-hint dense>
              <template #item="{ item }">
                {{ item.Name.split(' - ')[1] }}
              </template>
              <template #selection="{ item }">
                {{ item.Name.split(' - ')[1] }}
              </template>
            </v-select>
          </v-col>
          <v-col cols="12" md="6">
            <v-select v-model="selectedArmor" :items="selectResearches(splitArmors)" item-text="Name" item-value="AdditionalInfo" :hint="`Armor Technology ${selectedArmor ? `- ${selectedArmor} A/HS` : ''}`" solo persistent-hint dense></v-select>
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field type="number" min="0" v-model.number="selectedLayers" placeholder="1" hint="Armor Layers" solo persistent-hint clearable dense></v-text-field>
          </v-col>
        </v-row>
      </v-container>
      <!-- <div class="columns">
        <div class="column">
          <b-field :label="`Engine Technology (${selectedEngine} EP/HS)`">
            <b-select v-model="selectedEngine" placeholder="Select a Tier">
              <optgroup v-for="(split, index) of splitEngines" :key="index" :label="index ? 'Unresearched' : 'Researched'">
                <option v-for="engine of split" :key="engine.TechSystemID" :value="engine.AdditionalInfo">
                  {{ engine.ComponentName }}
                </option>
              </optgroup>
            </b-select>
          </b-field>
        </div>
        <div class="column">
          <b-field :label="`Engine Fuel Consumption (${selectedConsumption} L/EPH)`">
            <b-select v-model="selectedConsumption" placeholder="Select a Level">
              <optgroup v-for="(split, index) of splitConsumptions" :key="index" :label="index ? 'Unresearched' : 'Researched'">
                <option v-for="consumption of split" :key="consumption.TechSystemID" :value="consumption.AdditionalInfo">
                  {{ (consumption.AdditionalInfo * 100).toFixed(2) }} %
                </option>
              </optgroup>
            </b-select>
          </b-field>
        </div>
      </div>
      <b-field :label="`Engine Power Multiplier (${selectedPower})`">
        <b-slider v-model="selectedPower" :custom-formatter="val => `${(val * 100).toFixed(0)}%`" :min="0.1" :max="2.5" :step="0.05" :tooltip-type="powerType" ticks></b-slider>
      </b-field>
      <div class="columns">
        <div class="column">
          <b-field label="Desired Class Size" message="Tons">
            <b-input v-model.number="classSize" type="number" placeholder="2500" :min="minimumClassSize"></b-input>
          </b-field>
        </div>
        <div class="column">
          <b-field label="Desired Speed" message="Kilometers per Second">
            <b-input v-model.number="speed" type="number" placeholder="1000" :min="minimumSpeed"></b-input>
          </b-field>
        </div>
        <div class="column">
          <b-field label="Desired Range" message="Billions of Kilometers">
            <b-input v-model.number="range" placeholder="10.0" step="0.001" :min="minimumRange" 
              @keyup.native.prevent.alt.up.exact="modifyRange(0.001)"
              @keyup.native.prevent.up.exact="modifyRange(0.1)"
              @keyup.native.prevent.shift.up.exact="modifyRange(1)"
              @keyup.native.prevent.ctrl.up.exact="modifyRange(10)"

              @keyup.native.prevent.alt.down.exact="modifyRange(-0.001)"
              @keyup.native.prevent.down.exact="modifyRange(-0.1)"
              @keyup.native.prevent.shift.down.exact="modifyRange(-1)"
              @keyup.native.prevent.ctrl.down.exact="modifyRange(-10)"></b-input>
          </b-field>
        </div>
        <div class="column">
          <b-field label="Number of Engines">
            <b-input v-model.number="engines" type="number" placeholder="2" :min="minimumEngines"></b-input>
          </b-field>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="columns is-multiline">
        <div class="column is-full is-full-desktop is-half-widescreen">
          <h1 class="title">Engine Stats</h1>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Engine Power</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ totalPower.toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">EP</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ hullSizePower.toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">EP / HS</b-tag>
              </b-taglist>
            </div>
          </b-field>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Fuel Use</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (fuelUsePercentage * 100).toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">%</b-tag>
              </b-taglist>
            </div>
          </b-field>
        </div>
        <div class="column is-full is-full-desktop is-half-widescreen">
          <h1 class="title">Fuel Stats</h1>

          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Required Endurance</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ requiredEndurance.toFixed(0) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Hours</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (requiredEndurance / 24).toFixed(0) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Days</b-tag>
              </b-taglist>
            </div>
          </b-field>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Required Fuel</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ requiredFuel.toFixed(0) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Liters</b-tag>
              </b-taglist>
            </div>
          </b-field>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Max Fuel Burn</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ fuelBurn.toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Liters per Hour</b-tag>
              </b-taglist>
            </div>
          </b-field>
        </div>
        <div class="column is-full is-full-desktop is-half-widescreen">
          <h1 class="title">Hull Stats</h1>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Hull Size</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ hullSize.toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">HS</b-tag>
              </b-taglist>
            </div>
          </b-field>

          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Hull Space for Engines</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ engineSize.toFixed(1) }}</b-tag>
                <b-tag type="is-black" size="is-medium">HS</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (engineSize * 50).toFixed(0) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Tons</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (engineSizePercentage * 100).toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">% of Hull</b-tag>
              </b-taglist>
            </div>
          </b-field>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Hull Space for Fuel</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ fuelSize.toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">HS</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (fuelSize * 50).toFixed(0) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Tons</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (fuelSizePercentage * 100).toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">% of Hull</b-tag>
              </b-taglist>
            </div>
          </b-field>
          
          <b-field grouped group-multiline>
            <div class="control">
              <b-tag type="is-dark" size="is-medium">Hull Space Left for Payload</b-tag>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ remainingSize.toFixed(2) }}</b-tag>
                <b-tag type="is-black" size="is-medium">HS</b-tag>
              </b-taglist>
            </div>
            <div class="control">
              <b-taglist attached>
                <b-tag type="is-primary" size="is-medium">{{ (remainingSize * 50).toFixed(0) }}</b-tag>
                <b-tag type="is-black" size="is-medium">Tons</b-tag>
              </b-taglist>
            </div>
          </b-field>
        </div>
      </div> -->
    </section>
  </div>
</template>

<style lang="scss" scoped>
.short-top {
  padding-top: 0;
}
</style>

<script>
import { Op } from 'sequelize'

import { mapGetters } from 'vuex'

export default {
  components: {},
  data() {
    return {
      jumps: [{
        text: 'None',
        value: 0,
      }, {
        text: 'Military',
        value: 1,
      }, {
        text: 'Commercial',
        value: 7.5,
      }],

      selectedFuelConsumtion: 1,
      selectedEngine: 1,
      selectedEngineSize: 25,

      selectedTonnage: 15000,
      selectedSpeed: 2000,
      selectedRange: 100,

      selectedThrustModifierRange: [0.5, 1],

      selectedJump: 1,
      selectedJumpEfficiency: 4,
      selectedSquadronSize: 1,
      selectedSqudronRadius: 1,

      selectedArmor: 1,
      selectedLayers: 1,

      rules: {
        required: value => !!value || 'Required.',
        positive: value => value > 0 || 'Must be positive.',
      },

      //

      selectedPower: 1,
      selectedConsumption: 1,

      minimumClassSize: 50,
      classSize: null,

      minimumSpeed: 10,
      speed: null,

      minimumRange: 0.001,
      range: null,

      minimumEngines: 1,
      engines: null,
    }
  },
  methods: {
    selectResearches(split) {
      const [researched, unresearched] = split

      return [
        ...(researched.length ? [{ header: 'Researched' }, ...researched] : []),
        ...(unresearched.length ? [{ header: 'Unresearched' }, ...unresearched] : []),
      ]
    },
    
    splitResearched(techs = [], researchedTechIds = []) {
      return techs.reduce(([researched, unresearched], tech) => {
        const split = researchedTechIds.includes(tech.TechSystemID) ? researched : unresearched

        split.push(tech)

        return [researched, unresearched]
      }, [[], []])
    },

    modifyRange(amount) {
      const newRange = Number.parseFloat((this.range + amount).toFixed(3))

      this.range = newRange < this.minimumRange ? this.minimumRange : newRange
    },
  },
  computed: {
    ...mapGetters([
      'database',

      'GameID',
      'RaceID',
    ]),

    researchedTechIds() {
      return this.researchedTechs.map(tech => tech.TechID)
    },

    splitArmors() {
      return this.splitResearched(this.armors, this.researchedTechIds)
    },
    splitEngineSizes() {
      return this.splitResearched(this.enginesSizes, this.researchedTechIds)
    },
    splitEngines() {
      return this.splitResearched(this.engines, this.researchedTechIds)
    },
    splitThrustModifiers() {
      return this.splitResearched(this.thrustModifiers, this.researchedTechIds)
    },
    edgeThrustModifiers() {
      const [researchedThrustModifiers] = this.splitThrustModifiers

      return researchedThrustModifiers.length ? [researchedThrustModifiers[0].AdditionalInfo, researchedThrustModifiers[researchedThrustModifiers.length - 1].AdditionalInfo] : [0.5, 1]
    },
    splitFuelConsumptions() {
      return this.splitResearched(this.fuelConsumptions, this.researchedTechIds)
    },
    splitJumpEfficiencies() {
      return this.splitResearched(this.jumpEfficiencies, this.researchedTechIds)
    },
    splitSquadronSizes() {
      return this.splitResearched(this.squadronSizes, this.researchedTechIds)
    },
    splitSquadronRadiuses() {
      return this.splitResearched(this.squadronRadiuses, this.researchedTechIds)
    },
    
    powerType() {
      if (this.selectedPower >= this.edgePowers[0] && this.selectedPower <= this.edgePowers[1]) {
        return 'is-success'
      }

      return 'is-warning'
    },
    consumptionType() {
      if (this.selectedConsumption >= this.edgeConsumptions[0] && this.selectedConsumption <= this.edgeConsumptions[1]) {
        return 'is-success'
      }

      return 'is-warning'
    },

    // Computed Values
    // totalPower() {
    //   if (!this.classSize || !this.speed || this.classSize < this.minimumClassSize || this.speed < this.minimumSpeed) {
    //     return 0
    //   }

    //   return this.classSize * this.speed / 50000
    // },
    // hullSizePower() {
    //   return this.selectedEngine * this.selectedPower
    // },
    // fuelUsePercentage() {
    //   return Math.sqrt(10 / this.engineSize) * Math.pow(this.selectedPower, 2.5) * this.selectedConsumption
    // },
    // requiredEndurance() {
    //   if (!this.speed || !this.range || this.speed < this.minimumSpeed || this.range < this.minimumRange) {
    //     return 0
    //   }

    //   return 1 / (this.speed * 60 * 60) * this.range * Math.pow(10, 9)
    // },
    // requiredFuel() {
    //   return this.fuelBurn * this.requiredEndurance
    // },
    // fuelBurn() {
    //   return this.totalPower * this.fuelUsePercentage
    // },
    // hullSize() {
    //   if (!this.classSize || this.classSize < this.minimumClassSize) {
    //     return 0
    //   }

    //   return this.classSize / 50
    // },
    // engineSize() {
    //   if (!this.engines || this.engines < this.minimumEngines) {
    //     return 0
    //   }

    //   return this.totalPower / this.hullSizePower / this.engines
    // },
    // engineSizePercentage() {
    //   if (!this.engines || !this.classSize || this.engines < this.minimumEngines || this.classSize < this.minimumClassSize) {
    //     return 0
    //   }

    //   return (this.engineSize * 50) * this.engines / this.classSize
    // },
    // fuelSize() {
    //   return this.requiredFuel / 50000
    // },
    // fuelSizePercentage() {
    //   if (!this.classSize || this.classSize < this.minimumClassSize) {
    //     return 0
    //   }

    //   return (this.fuelSize * 50) / this.classSize
    // },
    // remainingSize() {
    //   if (!this.engines || this.engines < this.minimumEngines) {
    //     return 0
    //   }

    //   return this.hullSize - (this.engineSize * this.engines) - this.fuelSize
    // },
  },
  asyncComputed: {
    researchedTechs: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        return await this.database.query(`select FCT_RaceTech.TechID, FCT_Race.RaceID, FCT_Race.RaceTitle from FCT_RaceTech join FCT_Race on FCT_Race.GameID = FCT_RaceTech.GameID and FCT_Race.NPR = 0 and FCT_RaceTech.RaceID = FCT_Race.RaceID where FCT_RaceTech.GameID = ${this.GameID}`).then(([ items ]) => {
          console.log('Researched Technologies', items)

          return items
        })
      },
      default: [],
    },

    armors: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 84,
          },
          order: [
            ['AdditionalInfo', 'asc'],
          ],
        })
      }, 
      default: [],
    },
    enginesSizes: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 214,
          },
          order: [
            ['AdditionalInfo', 'asc'],
          ],
        })
      }, 
      default: [],
    },
    engines: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 40,
          },
          order: [
            ['AdditionalInfo', 'asc'],
          ],
        })
      }, 
      default: [],
    },
    thrustModifiers: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: {
              [Op.in]: [130, 198],
            },
          },
          order: [
            ['AdditionalInfo', 'asc'],
          ],
        })
      }, 
      default: [],
    },
    fuelConsumptions: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 65,
          },
          order: [
            ['AdditionalInfo', 'desc'],
          ],
        })
      }, 
      default: [],
    },
    jumpEfficiencies: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 8,
          },
          order: [
            ['AdditionalInfo', 'asc'],
          ],
        })
      }, 
      default: [],
    },
    squadronSizes: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 7,
          },
          order: [
            ['AdditionalInfo', 'asc'],
          ],
        })
      }, 
      default: [],
    },
    squadronRadiuses: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return await this.database.models.techSystem.findAll({
          where: {
            TechTypeID: 6,
          },
          order: [
            ['AdditionalInfo2', 'asc'],
          ],
        })
      }, 
      default: [],
    },
  },
}
</script>
