<template>
  <div>
    <section class="section short-top">
      <v-expansion-panels hover :value="0">
        <v-expansion-panel>
          <v-expansion-panel-header class="font-weight-bold">Calculation Parameters</v-expansion-panel-header>

          <v-expansion-panel-content>
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
          </v-expansion-panel-content>
        </v-expansion-panel>
      </v-expansion-panels>

      {{ combinations }}

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
    
    usableEngineSizes() {
      return [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 9, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 10, 10.25, 10.5, 10.75, 11, 11.25, 11.5, 11.75, 12, 12.25, 12.5, 12.75, 13, 13.25, 13.5, 13.75, 14, 14.25, 14.5, 14.75, 15, 15.25, 15.5, 15.75, 16, 16.25, 16.5, 16.75, 17, 17.25, 17.5, 17.75, 18, 18.25, 18.5, 18.75, 19, 19.25, 19.5, 19.75, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398, 399, 400].filter(size => size <= this.selectedEngineSize)
    },
    usableThrustModifiers() {
      const thrusts = []

      const [start, end] = this.selectedThrustModifierRange
      
      let control = start
      while (control < end) {
        thrusts.push(control)
        
        control = Math.round(((control * 100) + 5)) / 100
      }
      
      return [...thrusts, end]
    },

    combinations() {
      let calculatedCombinations = this.usableThrustModifiers.reduce((combinations, thrustModifier) => {
        this.usableEngineSizes.forEach(engineSize => {
          combinations.push({
            thrustModifier,
            engineSize,

            calculation: (1 - (engineSize + Math.ceil(this.selectedRange * Math.pow(10, 9) / this.selectedSpeed / 3600 * this.selectedFuelConsumtion * Math.sqrt(10 / engineSize) * Math.pow(thrustModifier, 2.5) / 5000 * this.selectedEngine * engineSize * thrustModifier) / 10) / (this.selectedEngine * engineSize * thrustModifier / this.selectedSpeed * 1000)),
          })
        })

        return combinations
      }, [])

      calculatedCombinations.sort((alpha, beta) => {
        return beta.calculation - alpha.calculation
      })

      console.log(calculatedCombinations.slice(0, 20))
    }

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
