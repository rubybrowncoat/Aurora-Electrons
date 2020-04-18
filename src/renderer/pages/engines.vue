<template>
  <div>
    <section class="section short-top">
      <h1 class="title">Parameters</h1>
      <div class="columns">
        <div class="column">
          <b-field :label="`Engine Technology (${selectedEngine} EP/HS)`">
            <b-select v-model="selectedEngine" placeholder="Select a Tier">
              <optgroup v-for="(split, index) of splitEngines" :key="index" :label="index ? 'Unresearched' : 'Researched'">
                <option v-for="engine of split" :key="engine.TechSystemID" :value="engine.AdditionalInfo">
                  {{ engine.ComponentName }} <!-- ({{ engine.AdditionalInfo }} EP/HS) -->
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
                  {{ (consumption.AdditionalInfo * 100).toFixed(2) }} % <!-- ({{ engine.AdditionalInfo }} EP/HS) -->
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
            <b-input v-model.number="range" type="number" placeholder="10.0" step="0.001" :min="minimumRange"></b-input>
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
        <div class="column is-full-desktop is-half-widescreen">
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
        <div class="column is-full-desktop is-half-widescreen">
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
        <div class="column is-full-desktop is-half-widescreen">
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
      </div>
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
      selectedEngine: 1,
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
  methods: {},
  computed: {
    ...mapGetters([
      'database', 
      'game',
    ]),
    
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

    researchedPowerMultipliers() {
      if (!this.techLines.powers) {
        return []
      }

      return this.techLines.powers.reduce((multipliers, power) => {
        if (this.researchedTechIds.includes(power.TechSystemID)) {
          multipliers.push(power.AdditionalInfo)
        }

        return multipliers
      }, [])
    },
    edgePowers() {
      if (!this.researchedPowerMultipliers.length) {
        return [0.5, 1]
      }

      return [this.researchedPowerMultipliers[0], this.researchedPowerMultipliers[this.researchedPowerMultipliers.length - 1]]
    },

    splitConsumptions() {
      if (!this.techLines.consumption) {
        return [[], []]
      }

      return this.techLines.consumption.reduce(([researched, unresearched], consumption) => {
        if (this.researchedTechIds.includes(consumption.TechSystemID)) {
          researched.push(consumption)
        } else {
          unresearched.push(consumption)
        }
        
        return [researched, unresearched]
      }, [[], []])
    },
    splitEngines() {
      if (!this.techLines.engines) {
        return [[], []]
      }

      return this.techLines.engines.reduce(([researched, unresearched], engine) => {
        if (this.researchedTechIds.includes(engine.TechSystemID)) {
          researched.push(engine)
        } else {
          unresearched.push(engine)
        }
        
        return [researched, unresearched]
      }, [[], []])
    },

    researchedTechIds() {
      return this.researchedTech.map(tech => tech.TechID)
    },

    // Computed Values
    totalPower() {
      if (!this.classSize || !this.speed || this.classSize < this.minimumClassSize || this.speed < this.minimumSpeed) {
        return 0
      }

      return this.classSize * this.speed / 50000
    },
    hullSizePower() {
      return this.selectedEngine * this.selectedPower
    },
    fuelUsePercentage() {
      return Math.sqrt(10 / this.engineSize) * Math.pow(this.selectedPower, 2.5) * this.selectedConsumption
    },
    requiredEndurance() {
      if (!this.speed || !this.range || this.speed < this.minimumSpeed || this.range < this.minimumRange) {
        return 0
      }

      return 1 / (this.speed * 60 * 60) * this.range * Math.pow(10, 9)
    },
    requiredFuel() {
      return this.fuelBurn * this.requiredEndurance
    },
    fuelBurn() {
      return this.totalPower * this.fuelUsePercentage
    },
    hullSize() {
      if (!this.classSize || this.classSize < this.minimumClassSize) {
        return 0
      }

      return this.classSize / 50
    },
    engineSize() {
      if (!this.engines || this.engines < this.minimumEngines) {
        return 0
      }

      return this.totalPower / this.hullSizePower / this.engines
    },
    engineSizePercentage() {
      if (!this.engines || !this.classSize || this.engines < this.minimumEngines || this.classSize < this.minimumClassSize) {
        return 0
      }

      return (this.engineSize * 50) * this.engines / this.classSize
    },
    fuelSize() {
      return this.requiredFuel / 50000
    },
    fuelSizePercentage() {
      if (!this.classSize || this.classSize < this.minimumClassSize) {
        return 0
      }

      return (this.fuelSize * 50) / this.classSize
    },
    remainingSize() {
      if (!this.engines || this.engines < this.minimumEngines) {
        return 0
      }

      return this.hullSize - (this.engineSize * this.engines) - this.fuelSize
    },
  },
  asyncComputed: {
    researchedTech: {
      async get() {
        if (!this.database || !this.game) {
          return []
        }

        return await this.database.query(`select FCT_RaceTech.TechID, FCT_Race.RaceID, FCT_Race.RaceTitle from FCT_RaceTech join FCT_Race on FCT_Race.GameID = FCT_RaceTech.GameID and FCT_Race.NPR = 0 and FCT_RaceTech.RaceID = FCT_Race.RaceID where FCT_RaceTech.GameID = ${this.game}`).then(([ items ]) => {
          console.log('Researched Technologies', items)

          return items
        })
      },
      default: [],
    },
    techLines: {
      async get() {
        if (!this.database || !this.database.models.techSystem) {
          return []
        }

        return {
          engines: await this.database.models.techSystem.findAll({
            where: {
              TechTypeID: 40,
            },
            order: [
              ['AdditionalInfo', 'asc'],
            ],
          }),
          powers: await this.database.models.techSystem.findAll({
            where: {
              TechTypeID: {
                [Op.in]: [130, 198],
              },
            },
            order: [
              ['AdditionalInfo', 'asc'],
            ],
          }),
          consumption: await this.database.models.techSystem.findAll({
            where: {
              TechTypeID: 65,
            },
            order: [
              ['AdditionalInfo', 'desc'],
            ],
          }),
        }
      },
      default: () => ({
        engines: [],
        powers: [],
        consumption: [],
      }),
    },
  },
}
</script>
