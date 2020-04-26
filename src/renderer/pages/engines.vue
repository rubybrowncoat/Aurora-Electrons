<template>
  <div>
    <section class="section short-top">
      <v-container fluid>
        <v-row justify="start">
          <v-col cols="12">
            <v-btn outlined large block :loading="isCalculating" :disabled="!selectedTonnage || !selectedSpeed || !selectedRange || !selectedUsableWeight || !selectedMinimumEngine" color="indigo" @click="doCalculate">Calculate</v-btn>
          </v-col>
        </v-row>
      </v-container>

      <v-expansion-panels hover multiple v-model="panels">
        <v-expansion-panel>
          <v-expansion-panel-header class="font-weight-bold">Global Calculation Parameters</v-expansion-panel-header>

          <v-expansion-panel-content>
            <v-container fluid>
              <v-row justify="start">
                <v-col cols="12" md="6">
                  <v-select v-model="selectedEngine" :items="selectResearches(splitEngines)" item-text="Name" item-value="AdditionalInfo" :hint="`Engine Technology ${selectedEngine ? `- ${selectedEngine} EP/HS` : ''}`" solo persistent-hint dense></v-select>
                </v-col>
                <v-col cols="12" md="6">
                  <v-select v-model="selectedFuelConsumption" :items="selectResearches(splitFuelConsumptions)" item-text="Name" item-value="AdditionalInfo" :hint="`Fuel Efficiency Factor ${selectedFuelConsumption ? `- ${selectedFuelConsumption} L/EPH` : ''}`" solo persistent-hint dense></v-select>
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
                  <v-select v-model="selectedJumpEfficiency" :items="selectResearches(splitJumpEfficiencies)" item-text="Name" item-value="AdditionalInfo" :hint="selectedJump ? `${(selectedSquadronSize * selectedSquadronRadius).toFixed(2)} Total Coefficient` : 'No Jump Drive'" :disabled="!selectedJump" solo persistent-hint dense></v-select>
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
                  <v-select v-model="selectedSquadronRadius" :items="selectResearches(splitSquadronRadiuses)" item-text="Name" item-value="AdditionalInfo2" :hint="`Jump Radius ${selectedSquadronRadius ? `- ${selectedSquadronRadius}x Coefficient` : ''}`" :disabled="!selectedJump" solo persistent-hint dense>
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

        <v-expansion-panel>
          <v-expansion-panel-header class="font-weight-bold">Optimization Parameters</v-expansion-panel-header>

          <v-expansion-panel-content>
            <v-container fluid>
              <v-row justify="start">
                <v-col cols="12" md="4">
                  <v-select v-model="selectedHardTonnage" :items="hardTonnage" hint="Allow Overshooting Rough Tonnage" solo persistent-hint dense></v-select>
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field type="number" min="1" max="100" v-model.number="selectedUsableWeight" placeholder="65" :hint="`Usable Weight Percentage ${selectedUsableWeight ? `- ${remainingUsableWeight}% Remaining` : ''}`" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense></v-text-field>
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field type="number" min="1" v-model.number="selectedMinimumEngine" placeholder="2" hint="Minimum Engines" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense></v-text-field>
                </v-col>
              </v-row>
            </v-container>
          </v-expansion-panel-content>
        </v-expansion-panel>

        <v-expansion-panel :disabled="!optimizationCombinations.length || !actualOptimizationCombination">
          <v-expansion-panel-header class="font-weight-bold">{{ actualOptimizationCombination ? 'Optimization Result' : 'No Results' }}</v-expansion-panel-header>

          <v-expansion-panel-content>
            <v-container fluid>
              <v-row justify="start">
                <v-col cols="12">
                  <v-btn-toggle v-model="selectedOptimization" mandatory group tile dense color="deep-purple accent-3">
                    <v-btn v-for="optimization in optimizations" :key="optimization.value">
                      {{ optimization.text }}
                    </v-btn>
                  </v-btn-toggle>
                </v-col>
                <v-col cols="12" md="6">
                  <v-sheet elevation="2" class="pa-2 body-2">
                    <div>Drive - <span class="font-weight-medium">{{ this.selectedEngineItem.Name }}</span></div>
                    <div>Approximate Speed - <span class="font-weight-medium">{{ this.selectedSpeed }}</span> Km/s</div>
                    <div>Approximate Range - <span class="font-weight-medium">{{ this.selectedRange }}</span> BKm</div>
                    <div>Fuel Efficiency - <span class="font-weight-medium">{{ this.selectedFuelConsumption }}</span> L/EPH</div>
                  </v-sheet>
                </v-col>
                <v-col cols="12" md="6" v-if="this.selectedJump">
                  <v-sheet elevation="2" class="pa-2 body-2">
                    <div>Jump Drive - <span class="font-weight-medium">{{ this.selectedJump === 1 ? 'Military' : 'Commercial' }}</span></div>
                    <div>Efficiency - <span class="font-weight-medium">{{ this.selectedJumpEfficiency }}</span></div>
                    <div>Squadron Size - <span class="font-weight-medium">{{ Number.parseInt(this.selectedSquadronSizeItem.AdditionalInfo) }}</span></div>
                    <div>Squadron Radius - <span class="font-weight-medium">{{ this.selectedSquadronRadiusItem.AdditionalInfo }}</span> Km</div>
                  </v-sheet>
                </v-col>
                <v-col cols="12" md="6" v-if="this.selectedArmor">
                  <v-sheet elevation="2" class="pa-2 body-2">
                    <div>Armor - <span class="font-weight-medium">{{ this.selectedArmorItem.Name }}</span></div>
                  </v-sheet>
                </v-col>
              </v-row>
            </v-container>
            <v-container fluid>
              <v-row justify="start">
                <v-col cols="12" v-if="selectedOptimization === 1">
                  <v-select v-model="selectedOptimizationEngine" :items="usableOptimizationEngineSizes" hint="Intended Engine Size (HS)" solo persistent-hint dense></v-select>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-list two-line dense v-if="actualOptimizationCombination">
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.isCommercial ? 'Commercial' : 'Military' }}</v-list-item-title>
                        <v-list-item-subtitle>Engine Type</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.engineSize }} HS</v-list-item-title>
                        <v-list-item-subtitle>Optimal Engine Size</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ Math.round(actualOptimizationCombination.thrustModifier * 100) }}%</v-list-item-title>
                        <v-list-item-subtitle>Optimal Engine Power</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ separatedNumber(actualOptimizationCombination.roundedRecommendedSize) }} HS ({{ separatedNumber(actualOptimizationCombination.roundedRecommendedTonnage) }} Tons)</v-list-item-title>
                        <v-list-item-subtitle>Recommended Size</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.engineNumber }}</v-list-item-title>
                        <v-list-item-subtitle>Recommended Engine Number</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ separatedNumber(actualOptimizationCombination.recommendedFuel) }} Liters</v-list-item-title>
                        <v-list-item-subtitle>Recommended Fuel</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                  </v-list>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-list two-line dense v-if="actualOptimizationCombination">
                    <v-list-item link v-if="selectedArmor">
                      <v-list-item-content>
                        <v-list-item-title>{{ selectedLayers }} Layers / {{ actualOptimizationCombination.armorColumns }} Columns</v-list-item-title>
                        <v-list-item-subtitle>Armor</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link v-if="selectedArmor">
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.armorSize }} HS</v-list-item-title>
                        <v-list-item-subtitle>Armor Size</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link v-if="selectedJump">
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.jumpDriveSize }} HS ({{ separatedNumber(actualOptimizationCombination.jumpDriveSizeTons) }} Tons)</v-list-item-title>
                        <v-list-item-subtitle>Jump Drive Size</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link v-if="selectedJump">
                      <v-list-item-content>
                        <v-list-item-title>{{ separatedNumber(actualOptimizationCombination.jumpDriveCapacity) }} Tons</v-list-item-title>
                        <v-list-item-subtitle>Jump Drive Capacity</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link>
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.roundedUsableSizeAfterJumpDrive }} HS ({{ separatedNumber(actualOptimizationCombination.roundedUsableSizeAfterJumpDriveTons) }} Tons)</v-list-item-title>
                        <v-list-item-subtitle>Usable Size</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item link v-if="selectedJump">
                      <v-list-item-content>
                        <v-list-item-title>{{ actualOptimizationCombination.roundedUsableSizeAfterArmor }} HS ({{ separatedNumber(actualOptimizationCombination.roundedUsableSizeAfterArmorTons) }} Tons)</v-list-item-title>
                        <v-list-item-subtitle>Usable Size Without Jump Drive</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>
                  </v-list>
                </v-col>
              </v-row>
            </v-container>
          </v-expansion-panel-content>
        </v-expansion-panel>
      </v-expansion-panels>
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

import { mapGetters, mapState, mapMutations, mapActions } from 'vuex'

import { roundToDecimal, separatedNumber, ceilToDecimal } from '../../utilities/math'

export default {
  components: {},
  data() {
    return {
      panels: [0, 1],

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
      
      hardTonnage: [{
        text: 'Yes',
        value: 0,
      }, {
        text: 'No',
        value: 0.5,
      }],

      optimizations: [{
        text: 'Optimize by Available Tonnage',
        value: 0,
      }, {
        text: 'Optimize by Engine Size',
        value: 1,
      }],

      selectedOptimization: 0,
      selectedOptimizationLine: 0,
      selectedOptimizationEngine: 25,

      // selectedArmor: 1,
      // selectedLayers: 1,

      selectedHardTonnage: 0.5,
      selectedUsableWeight: 65,
      selectedMinimumEngine: 2,

      isCalculating: false,

      tonnageCombinations: [],
      engineSizeCombinations: [],

      //

      rules: {
        required: value => !!value || 'Required.',
        positive: value => value > 0 || 'Must be positive.',
      },
    }
  },
  methods: {
    ...mapActions('snackbar', [
      'activateSnackbar',
    ]),

    ...mapMutations('engine', [
      'setSelectedTonnage',
      'setSelectedSpeed',
      'setSelectedRange',
      
      'setSelectedEngine',
      'setSelectedFuelConsumption',
      'setSelectedThrustModifierRange',
      'setSelectedEngineSize',
      
      'setSelectedJump',
      'setSelectedJumpEfficiency',
      'setSelectedSquadronSize',
      'setSelectedSquadronRadius',
      
      'setSelectedArmor',
      'setSelectedLayers',
    ]),

    separatedNumber(number) {
      return separatedNumber(number)
    },

    doCalculate() {
      if (this.calculateCombinations()) {
        this.closePanels(0, 1)
        this.openPanels(2)

        this.activateSnackbar({
          color: 'success',
          text: 'Optimization Results Available',
        })
      } else {
        this.closePanels(2)
        
        this.activateSnackbar({
          color: 'error',
          text: 'No Optimal Results Available',
        })
      }
    },

    closePanels(...closingPanels) {
      this.panels = this.panels.filter(panel => !closingPanels.includes(panel))
    
      return true
    },

    openPanels(...openingPanels) {
      this.panels.push(...openingPanels.filter(panel => !this.panels.includes(panel)))

      return true
    },

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

    calculateCombinations() {
      this.isCalculating = true

      let [tonnageCombinations, engineSizeCombinations] = this.usableThrustModifiers.reduce(([tonnageAggregate, engineSizeAggregate], thrustModifier) => {
        this.usableEngineSizes.forEach(engineSize => {
          const enginePower = this.selectedEngine * engineSize * thrustModifier
          const shipSizePerEngine = (enginePower / this.selectedSpeed) * 1000

          if (engineSize > shipSizePerEngine) {
            return [tonnageAggregate, engineSizeAggregate]
          }

          const shipSizePerEngineTons = shipSizePerEngine * 50

          if (shipSizePerEngineTons <= (this.selectedTonnage / this.selectedMinimumEngine)) {

            const fuelConsumptionPerEngine = this.selectedFuelConsumption * Math.sqrt(10 / engineSize) * Math.pow(thrustModifier, 2.5)
            const roundedFuelConsumptionPerEngine = roundToDecimal(fuelConsumptionPerEngine, 4)

            const fuelPerEngineRounder = Math.ceil(this.selectedRange * Math.pow(10, 9) / this.selectedSpeed / 3600 * fuelConsumptionPerEngine * this.selectedEngine * engineSize * thrustModifier / 5000)
            
            const fuelPerEngine = fuelPerEngineRounder * 5000
            const fuelSizePerEngine = fuelPerEngine / 50000

            const propulsionSizePerEngine = engineSize + fuelSizePerEngine

            if (propulsionSizePerEngine > shipSizePerEngine) {
              return [tonnageAggregate, engineSizeAggregate]
            }

            const usableSizePerEngine = shipSizePerEngine - propulsionSizePerEngine

            const engineNumber = Math.max(Math.round(this.selectedTonnage / shipSizePerEngineTons - this.selectedHardTonnage), 1)
            
            const recommendedSize = engineNumber * shipSizePerEngine
            const roundedRecommendedSize = roundToDecimal(recommendedSize, recommendedSize > 10 ? 0 : 1)

            const recommendedTonnage = recommendedSize * 50
            const roundedRecommendedTonnage = roundedRecommendedSize * 50

            const recommendedFuel = engineNumber * fuelPerEngine

            const preStep = (engineSize + fuelPerEngineRounder / 10) / shipSizePerEngine

            const isCommercial = engineSize >= 25 && thrustModifier <= 0.5
            const isJumpCommercial = this.selectedJump ? this.selectedJump > 1 : isCommercial

            if (isCommercial !== isJumpCommercial) {
              return [tonnageAggregate, engineSizeAggregate]
            }

            // Jump Drive Calculations

            const jumpDriveSizeForTonnage = this.selectedJump ? Math.ceil(recommendedTonnage / this.selectedJumpEfficiency / this.selectedJump / 50) * (this.selectedJump === 1 ? 1 : 10) : 0
            const jumpDriveCapacity = jumpDriveSizeForTonnage * this.selectedJumpEfficiency * this.selectedJump * 50 / (this.selectedJump === 1 ? 1 : 10)

            const jumpDriveSize = Math.round(jumpDriveSizeForTonnage * this.selectedSquadronSize * this.selectedSquadronRadius)
            const jumpDriveSizeTons = Math.round(jumpDriveSize * 50)

            // Armor

            const armorArea = Math.pow(3 * Math.ceil(roundedRecommendedSize) / 4 / Math.PI, 2 / 3) * 4 * Math.PI
            const armorStrength = armorArea * this.selectedLayers / 4
            const armorColumns = Math.floor(armorArea / 4)
            const armorSize = this.selectedArmor ? ceilToDecimal(armorStrength / this.selectedArmor, 1) : 0

            // Usable Size

            const usableSizeAfterPropulsion = roundedRecommendedSize - propulsionSizePerEngine * engineNumber
            const roundedUsableSizeAfterPropulsion = roundToDecimal(usableSizeAfterPropulsion, 1)
            const roundedUsableSizeAfterPropulsionTons = Math.round(roundedUsableSizeAfterPropulsion * 50)

            if (usableSizeAfterPropulsion < 0) {
              return [tonnageAggregate, engineSizeAggregate]
            }

            const usableSizeAfterArmor = usableSizeAfterPropulsion - armorSize
            const roundedUsableSizeAfterArmor = roundToDecimal(usableSizeAfterArmor, 1)
            const roundedUsableSizeAfterArmorTons = Math.round(roundedUsableSizeAfterArmor * 50)

            if (usableSizeAfterArmor < 0) {
              return [tonnageAggregate, engineSizeAggregate]
            }

            const usableSizeAfterJumpDrive = usableSizeAfterArmor - jumpDriveSize
            const roundedUsableSizeAfterJumpDrive = roundToDecimal(usableSizeAfterJumpDrive, 1)
            const roundedUsableSizeAfterJumpDriveTons = Math.round(roundedUsableSizeAfterJumpDrive * 50)

            if (usableSizeAfterJumpDrive < 0) {
              return [tonnageAggregate, engineSizeAggregate]
            }

            const calculationRecap = {
              thrustModifier,
              engineSize,

              isCommercial,

              enginePower,
              engineNumber,
              recommendedSize,
              roundedRecommendedSize,
              recommendedTonnage,
              roundedRecommendedTonnage,
              recommendedFuel,
              roundedFuelConsumptionPerEngine,
              fuelPerEngine,
              fuelSizePerEngine,
              shipSizePerEngine,
              shipSizePerEngineTons,
              propulsionSizePerEngine,

              jumpDriveSizeForTonnage,
              jumpDriveCapacity,
              jumpDriveSize,
              jumpDriveSizeTons,

              armorArea,
              armorStrength,
              armorColumns,
              armorSize,

              roundedUsableSizeAfterPropulsion,
              roundedUsableSizeAfterPropulsionTons,
              roundedUsableSizeAfterArmor,
              roundedUsableSizeAfterArmorTons,
              roundedUsableSizeAfterJumpDrive,
              roundedUsableSizeAfterJumpDriveTons,
            }

            // By Tonnage
            const tonnageCalculation = (Math.abs(this.selectedTonnage - engineNumber * shipSizePerEngineTons) / this.selectedTonnage * this.remainingUsableWeight + preStep) * 10 * this.selectedUsableWeight

            // const tonnageCalculationFull = (Math.pow(Math.abs(this.selectedTonnage - Math.max(Math.round(this.selectedTonnage / 50 / (this.selectedEngine * thrustModifier * engineSize / this.selectedSpeed * 1000) - this.selectedHardTonnage), 1) * (this.selectedEngine * thrustModifier * engineSize / this.selectedSpeed * 1000 * 50)) / this.selectedTonnage, 1) * this.remainingUsableWeight + Math.pow((engineSize + Math.ceil(this.selectedRange * Math.pow(10, 9) / this.selectedSpeed / 3600 * this.selectedFuelConsumption * Math.sqrt(10 / engineSize) * Math.pow(thrustModifier, 2.5) / 5000 * this.selectedEngine * engineSize * thrustModifier) / 10) / (this.selectedEngine * engineSize * thrustModifier / this.selectedSpeed * 1000), 1)) * 10 * this.selectedUsableWeight

            if (shipSizePerEngineTons * 2 * this.selectedHardTonnage <= this.selectedTonnage) {
              tonnageAggregate.push({
                ...calculationRecap,

                calculation: tonnageCalculation,
              })
            }

            // By Engine Size
            const engineSizeCalculation = 1 - preStep
            if (engineSizeCalculation > 0) {
              const sizeScore = Math.pow(Math.abs(recommendedTonnage - this.selectedTonnage) / this.selectedTonnage * 10, 2) + Math.pow(1 - engineSizeCalculation, 4)

              engineSizeAggregate.push({
                ...calculationRecap,
                
                calculation: engineSizeCalculation,
              })
            }
          }
        })

        return [tonnageAggregate, engineSizeAggregate]
      }, [[], []])

      tonnageCombinations.sort((alpha, beta) => {
        return alpha.calculation - beta.calculation
      })

      engineSizeCombinations.sort((alpha, beta) => {
        return beta.calculation - alpha.calculation
      })

      this.tonnageCombinations = tonnageCombinations
      this.engineSizeCombinations = engineSizeCombinations

      this.isCalculating = false

      this.selectedOptimizationLine = 0
      this.selectedOptimizationEngine = this.usableOptimizationEngineSizes[0]

      if (this.optimizationCombinations.length) {
        return true
      }
    },
  },
  computed: {
    ...mapState([
      'engine',
    ]),

    selectedTonnage: {
      set(tonnage) {
        this.setSelectedTonnage(tonnage)
      },
      get() {
        return this.engine.selectedTonnage
      },
    },
    selectedSpeed: {
      set(speed) {
        this.setSelectedSpeed(speed)
      },
      get() {
        return this.engine.selectedSpeed
      },
    },
    selectedRange: {
      set(range) {
        this.setSelectedRange(range)
      },
      get() {
        return this.engine.selectedRange
      },
    },
    
    selectedEngine: {
      set(engine) {
        this.setSelectedEngine(engine)
      },
      get() {
        return this.engine.selectedEngine
      },
    },
    selectedFuelConsumption: {
      set(fuelConsumption) {
        this.setSelectedFuelConsumption(fuelConsumption)
      },
      get() {
        return this.engine.selectedFuelConsumption
      },
    },
    selectedThrustModifierRange: {
      set(thrustModifierRange) {
        this.setSelectedThrustModifierRange(thrustModifierRange)
      },
      get() {
        return this.engine.selectedThrustModifierRange
      },
    },
    selectedEngineSize: {
      set(engineSize) {
        this.setSelectedEngineSize(engineSize)
      },
      get() {
        return this.engine.selectedEngineSize
      },
    },
    
    selectedJump: {
      set(jump) {
        this.setSelectedJump(jump)
      },
      get() {
        return this.engine.selectedJump
      },
    },
    selectedJumpEfficiency: {
      set(jumpEfficiency) {
        this.setSelectedJumpEfficiency(jumpEfficiency)
      },
      get() {
        return this.engine.selectedJumpEfficiency
      },
    },
    selectedSquadronSize: {
      set(squadronSize) {
        this.setSelectedSquadronSize(squadronSize)
      },
      get() {
        return this.engine.selectedSquadronSize
      },
    },
    selectedSquadronRadius: {
      set(squadronRadius) {
        this.setSelectedSquadronRadius(squadronRadius)
      },
      get() {
        return this.engine.selectedSquadronRadius
      },
    },

    selectedEngineItem() {
      return this.engines.find(engine => engine.AdditionalInfo === this.selectedEngine) || {}
    },
    selectedSquadronSizeItem() {
      return this.squadronSizes.find(squadronSize => squadronSize.AdditionalInfo2 === this.selectedSquadronSize) || {}
    },
    selectedSquadronRadiusItem() {
      return this.squadronRadiuses.find(squadronRadius => squadronRadius.AdditionalInfo2 === this.selectedSquadronRadius) || {}
    },
    selectedArmorItem() {
      return this.armors.find(armor => armor.AdditionalInfo === this.selectedArmor) || {}
    },
    
    selectedArmor: {
      set(armor) {
        this.setSelectedArmor(armor)
      },
      get() {
        return this.engine.selectedArmor
      },
    },
    selectedLayers: {
      set(layers) {
        this.setSelectedLayers(layers)
      },
      get() {
        return this.engine.selectedLayers
      },
    },

    ...mapGetters([
      'database',

      'GameID',
      'RaceID',
    ]),

    remainingUsableWeight() {
      return 100 - this.selectedUsableWeight
    },

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

    optimizationCombinations() {
      switch(this.selectedOptimization) {
        case 0: {
          return this.tonnageCombinations
        }
        case 1: {
          return this.optimizationCombinationsFromEngineSize
        }
      }
    },
    actualOptimizationCombination() {
      return this.selectedOptimizationLine >= 0 && this.selectedOptimizationLine < this.optimizationCombinations.length ? this.optimizationCombinations[this.selectedOptimizationLine] : null
    },

    usableOptimizationEngineSizes() {
      const engineSizes = this.engineSizeCombinations.map(combination => combination.engineSize)

      engineSizes.sort((alpha, beta) => {
        return beta - alpha
      })

      return Array.from(new Set(engineSizes))
    },
    optimizationCombinationsFromEngineSize() {
      return this.engineSizeCombinations.filter(combination => combination.engineSize === this.selectedOptimizationEngine)
    },
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
  watch: {
    combinations(newCombinations) {
      
    }
  }
}
</script>
