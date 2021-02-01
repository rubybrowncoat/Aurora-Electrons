<template>
  <div class="recap-container">
    <div v-if="!GameID">Select a race from the left-side menu.</div>

    <v-container fluid v-if="RaceID">
      <v-row justify="start">
        <v-col cols="12">
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Research', showResearches)" small tile dense borderless @click="setShowResearches(!showResearches)">Research</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Production', showProductions)" small tile dense borderless @click="setShowProductions(!showProductions)">Production</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Shipyard', showShipyards)" small tile dense borderless @click="setShowShipyards(!showShipyards)">Shipyard</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Ship', showShips)" small tile dense borderless @click="setShowShips(!showShips)">Ship</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Training', showTrainings)" small tile dense borderless @click="setShowTrainings(!showTrainings)">Training</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Terraforming', showTerraformings)" small tile dense borderless @click="setShowTerraformings(!showTerraformings)">Terraforming</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="typeColor('Queue', showQueues)" small tile dense borderless @click="setShowQueues(!showQueues)">Show Queues</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" color="typeColor()" small dark tile dense borderless v-if="!showResearches || !showProductions || !showShips || !showShipyards || !showTrainings || !showTerraformings" @click="resetProductionFilters">All</v-btn>
        </v-col>
      </v-row>
      <v-row justify="start">
        <v-col cols="12">
          <v-data-table ref="table" :headers="headers" :items="tasks" item-key="ID" class="elevation-1" sort-by="RemainingDays" disable-pagination hide-default-footer multi-sort>
            <template v-slot:[`item.TaskType`]="{ item }">
              <span class="py-1 px-2 overline font-weight-medium elevation-1" :class="typeColor(item.TaskType)">{{ item.TaskType }}</span>
            </template>
            <template v-slot:[`item.Name`]="{ item }">
              <span v-if="item.TaskType === 'Production'">
                {{ roundToDecimal(item.Amount, 1) }}x
              </span>
              {{ item.Name }} 
              <span class="orange--text font-weight-bold" v-if="item.ProjectField !== item.CommanderField">(Field Mismatch)</span>
              <span class="overline uppercase float-right" v-if="item.ShipyardTaskType">[{{ ShipyardTaskTypeMap[item.ShipyardTaskType] }}]</span>
              <span class="overline uppercase float-right" v-if="item.ProductionType">[{{ ProductionTypeMap[item.ProductionType] }}]</span>
              <span v-if="item.TaskType === 'Ship'">({{ item.ClassName }} class)</span>
              <span v-if="item.TaskType === 'Terraforming'">
                {{ item.GasName }} to {{ item.MaxAtm }} Atm
                <div v-if="item.GasName === 'Water Vapour'" class="caption small">
                  Hydrographic Extent to {{ item.TerraformStatus ? 'at least 20%' : 'at most 75%' }}.
                </div>
              </span>
              <span v-if="item.UpgradeTaskType === 7">to {{ item.ClassName }}</span>
              <span v-if="item.UpgradeTaskType === 8">to {{ item.CapacityTarget }}</span>
            </template>
            <template v-slot:[`item.AnnualProduction`]="{ item }">
              <span v-if="item.TaskType === 'Research'">
                {{ separatedNumber(roundToDecimal(item.AnnualProduction, 0)) }} RP / {{ item.Facilities }} Labs
              </span>
              <span v-if="item.TaskType === 'Production'">
                {{ separatedNumber(roundToDecimal(item.AnnualProduction, 0)) }} BP / {{ item.Percentage }}%
              </span>
              <span v-if="item.TaskType === 'Ship'">
                {{ separatedNumber(roundToDecimal(item.AnnualProduction, 0)) }} BP
              </span>
              <span v-if="item.TaskType === 'Shipyard'">
                {{ separatedNumber(roundToDecimal(item.AnnualProduction, 0)) }} Mod Rate
              </span>
              <span v-if="item.TaskType === 'Training'">
                {{ separatedNumber(roundToDecimal(item.AnnualProduction, 0)) }} BP
              </span>
              <span v-if="item.TaskType === 'Terraforming'">
                {{ roundToDecimal(item.AnnualProduction, 4) }} Atm
              </span>
            </template>
            <template v-slot:[`item.RemainingDays`]="{ item }">
              <span :class="{
                'red--text font-weight-bold': item.Queue,
                'orange--text font-weight-bold': item.Paused,
              }">
                <span v-if="item.Queue && item.TaskType !== 'Research'">Queued</span>
                <span v-else-if="item.RemainingDays === 0" class="light-green--text font-weight-bold">Done!</span>
                <span v-else><span v-if="item.UpgradeTaskType === 8 || item.TaskType === 'Terraforming'">~</span> {{ separatedNumber(roundToDecimal(item.RemainingDays, 1)) }}</span>
              </span>
            </template>
            <template v-slot:[`item.PopulationID`]="{ item }">
              <span v-if="populationProductionModifiers[item.PopulationID]" v-html="populationName(populationProductionModifiers[item.PopulationID])"></span>
            </template>
          </v-data-table>
        </v-col>
      </v-row>
    </v-container>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapActions, mapGetters, mapMutations, mapState } from 'vuex'

import { separatedNumber, roundToDecimal } from '../../utilities/math'
import { populationName } from '../../utilities/aurora'

const secondsPerYear = 31536000
const secondsPerDay = 86400

const earthSurfaceArea = 511187128

const condensationPerYear = 0.1
const condensationToHydroRate = 40
const waterVapourInAtmosphere = 0.01

const ProductionTypeMap = {
  0: 'Construction',
  1: 'Ordnance',
  2: 'Fighter',
  3: 'Component',
  4: 'Space Station',
}

const ShipyardTaskTypeMap = {
  0: 'Construction',
  1: 'Repair',
  2: 'Refit',
  3: 'Scrap',
  4: 'Auto Refit',
}

const ShipyardUpgradeTypeMap = {
  1: 'Add Slipway',
  2: 'Add 500 ton Capacity',
  3: 'Add 1000 ton Capacity',
  4: 'Add 2000 ton Capacity',
  5: 'Add 5000 ton Capacity',
  6: 'Add 10,000 ton Capacity',
  7: 'Retool',
  8: 'Continual Capacity Upgrade',
  9: 'Spacemaster Modification',
}

export default {
  components: {},
  data() {
    return {
      // showResearches: true,
      // showProductions: true,
      // showShipyards: true,
      // showShips: true,
      // showTrainings: true,
      // showTerraformings: true,

      // showQueues: true,

      panels: [0, 1, 2],
    }
  },
  methods: {
    ...mapActions('production', [
      'resetProductionFilters',
    ]),

    ...mapMutations('production', [
      'setShowResearches',
      'setShowProductions',
      'setShowShipyards',
      'setShowShips',
      'setShowTrainings',
      'setShowTerraformings',
      
      'setShowQueues',
    ]),

    separatedNumber,
    roundToDecimal,

    populationName,

    typeColor(type, active = true) {
      if (!active) {
        return 'light'
      }

      switch(type) {
        case 'Research': {
          return this.$vuetify.theme.dark ? 'pink darken-2' : 'pink lighten-4'
        }
        case 'Production': {
          return this.$vuetify.theme.dark ? 'light-green darken-2' : 'light-green lighten-2'
        }
        case 'Shipyard': {
          return this.$vuetify.theme.dark ? 'purple darken-1' : 'purple accent-1'
        }
        case 'Ship': {
          return this.$vuetify.theme.dark ? 'blue' : 'blue lighten-4'
        }
        case 'Training': {
          return this.$vuetify.theme.dark ? 'teal darken-1' : 'teal accent-3'
        }
        case 'Terraforming': {
          return this.$vuetify.theme.dark ? 'lime darken-1' : 'lime lighten-3'
        }
        case 'Queue': {
          return this.$vuetify.theme.dark ? 'yellow darken-3' : 'yellow lighten-1'
        }
        default: {
          return 'deep-purple accent-2'
        }
      }
    },

    populationMinConstructionPeriod(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.MinConstructionPeriod
    },
    populationConstructionCapacity(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return (modifiers.ConstructionProduction * modifiers.OverallProductionModifier * modifiers.ConstructionPower) + (modifiers.ConstructionProduction * modifiers.EngineerProductionModifier * modifiers.GroundConstructionPower)
    },
    populationOrdnanceCapacity(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.OrdnanceProduction * modifiers.OverallProductionModifier * modifiers.OrdnanceProductionPower
    },
    populationFighterCapacity(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.FighterProduction * modifiers.OverallProductionModifier * modifiers.FighterProductionPower
    },
    populationShipyardCapacity(populationId, ship) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.ShipyardBuildRate * (1 + (ship.Size * ship.CommercialModifier / 100 - 1) / 2)
    },
    populationShipyardUpgradeCapacity(populationId, shipyard) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      const commercialModifier = shipyard.SYType === 1 ? 1 : 0.1

      return (1 + (shipyard.Capacity * commercialModifier / 5000 - 1) / 2) * modifiers.ShipyardBuildRate
    },
    populationResearchCapacity(populationId, research) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return research.ActualCommanderResearchBonus * research.ActualAnomalyBonus * modifiers.OverallResearchModifier * research.Facilities;
    },
    populationTrainingCapacity(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.OverallGroundUnitModifier
    },

    terraformingRate(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.TerraformingRate 
    },
    populationTerraformingRate(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.PopulationTerraformingRate 
    },
    populationTerraformingSpeed(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      if (!modifiers) {
        return 0
      }

      return modifiers.TerraformingSpeed 
    },

    shipyardContinualRemainingDays(shipyard) {
      const modifiers = this.populationProductionModifiers[shipyard.PopulationID]

      if (!modifiers) {
        return 0
      }

      const roi = modifiers.MinConstructionPeriod / secondsPerYear
      const periodDays = modifiers.MinConstructionPeriod / secondsPerDay
      
      let periods = 0
      let lastUpgrade = 0
      let newCapacity = shipyard.Capacity
      do {
        const wat = (120 * shipyard.Slipways) * modifiers.ShipyardOperations
        const stepUpgradeRate = this.populationShipyardUpgradeCapacity(shipyard.PopulationID, {
          SYType: shipyard.SYType,
          Capacity: newCapacity,
        }) * roi

        lastUpgrade = stepUpgradeRate / wat * (shipyard.SYType === 1 ? 500 : 5000)
        newCapacity += lastUpgrade
        periods += 1
      } while (newCapacity < shipyard.CapacityTarget)

      // const extraPeriod = modifiers.MinConstructionPeriod * (newCapacity - shipyard.CapacityTarget) / lastUpgrade
      // const extraPeriodDays = extraPeriod / secondsPerDay

      return periods * periodDays
    },
    
    navalAdminBonus(SystemID, NavalAdminCommandID) {
      if (!this.adminsWithSystems || !Object.values(this.adminsWithSystems).length) {
        return 1
      }

      const administration = this.adminsWithSystems[NavalAdminCommandID]

      if (!administration || !administration.Systems.has(SystemID) || !administration.BonusValue) {
        return 1
      }

      return (1 + (administration.BonusValue - 1) * administration.Industrial) * this.navalAdminBonus(SystemID, administration.ParentCommandID)
    },
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    ...mapState('production', [
      'showResearches',
      'showProductions',
      'showShipyards',
      'showShips',
      'showTrainings',
      'showTerraformings',
      
      'showQueues',
    ]),

    adminsWithSystems() {
      if (!Object.values(this.raceSystems).length) {
        return {}
      }

      return this.navalAdministrations.reduce((map, navalAdministration) => {
        if (!this.raceSystems[navalAdministration.SystemID]) {
          return map
        }

        map[navalAdministration.NavalAdminCommandID] = {
          ...navalAdministration,

          Systems: new Array(navalAdministration.NavalAdminCommandLevel).fill(null).reduce(aggregate => {
            const systemArray = [...aggregate]

            systemArray.forEach((system) => {
              system.Neighbors.forEach(aggregate.add, aggregate)
            })

            return aggregate
          }, new Set([this.raceSystems[navalAdministration.SystemID]]))
        }

        return map
      }, {})
    },

    modifiedResearches() {
      const modifiedResearches = this.researches.map(research => {
        const TotalAnnualProduction = this.populationResearchCapacity(research.PopulationID, research)

        return {
          ...research,

          TaskType: 'Research',

          TotalAnnualProduction,
          AnnualProduction: TotalAnnualProduction,
          RemainingDays: research.RemainingProduction / (TotalAnnualProduction / 365),
        }
      })

      const dayMap = modifiedResearches.reduce((map, research) => {
        map[research.ID] = research.RemainingDays
        
        return map
      }, {})

      return modifiedResearches.map(research => {
        if (research.Queue) {
          const extraDays = research.QueueChain.reduce((sum, projectId) => sum + dayMap[projectId], 0)
        
          return {
            ...research,

            ID: `research-${research.ID}`,

            RemainingDays: research.RemainingDays + extraDays,
          }
        }

        return research
      })
    },
    modifiedProductions() {
      return this.productions.map(production => {
        const TotalAnnualProduction = production.ProductionType === 1 
          ? this.populationOrdnanceCapacity(production.PopulationID)
          : production.ProductionType === 2
            ? this.populationFighterCapacity(production.PopulationID)
            : this.populationConstructionCapacity(production.PopulationID)

        const AnnualProduction = TotalAnnualProduction * (production.Percentage / 100)

        return {
          ...production,

          ID: `production-${production.ID}`,
          TaskType: 'Production',
          
          TotalAnnualProduction,
          AnnualProduction,
          RemainingDays: production.RemainingProduction / (AnnualProduction / 365) * (production.Queue ? 50000 : 1),
        }
      })
    },
    modifiedShips() {
      return this.ships.map(ship => {
        const TotalAnnualProduction = this.populationShipyardCapacity(ship.PopulationID, ship)

        return {
          ...ship,

          ID: `ship-${ship.ID}`,
          TaskType: 'Ship',

          TotalAnnualProduction,
          AnnualProduction: TotalAnnualProduction,
          RemainingDays: ship.RemainingProduction / (TotalAnnualProduction / 365) // * (ship.Queue ? 50000 : 1) // No queues in shipyards!
        }
      })
    },
    modifiedShipyards() {
      return this.shipyards.map(shipyard => {
        const UpgradeRate = this.populationShipyardUpgradeCapacity(shipyard.PopulationID, shipyard)

        let remainingDays = shipyard.UpgradeTaskType === 8 ? this.shipyardContinualRemainingDays(shipyard) : shipyard.RemainingProduction / UpgradeRate * secondsPerYear / secondsPerDay / (shipyard.UpgradeTaskType === 7 ? shipyard.Slipways : 1)
        
        return {
          ...shipyard,

          ID: `shipyard-${shipyard.ID}`,
          TaskType: 'Shipyard',

          Name: `${shipyard.ShipyardName} - ${ShipyardUpgradeTypeMap[shipyard.UpgradeTaskType]}`,
          AnnualProduction: UpgradeRate,
          RemainingDays: remainingDays
        }
      })
    },
    modifiedTrainings() {
      return this.trainings.map(training => {
        const TotalAnnualProduction = this.populationTrainingCapacity(training.PopulationID)
        
        return {
          ...training,

          ID: `training-${training.ID}`,
          TaskType: 'Training',

          TotalAnnualProduction,
          AnnualProduction: TotalAnnualProduction,
          RemainingDays: training.RemainingProduction / (TotalAnnualProduction / 365),
        }
      })
    },
    modifiedTerraformings() {
      return Object.values(this.terraforms.reduce((map, terraform) => {
        if (terraform.TerraformStatus && !terraform.MaxAtm) {
          return map
        }

        if (!map[terraform.PopulationID]) {
          map[terraform.PopulationID] = {
            ...terraform,

            planetaryCapacity: 0,
            orbitalCapacity: 0,
          }
        }

        if (terraform.ParentCommandID) {
          map[terraform.PopulationID].orbitalCapacity += this.terraformingRate(terraform.PopulationID) * this.navalAdminBonus(terraform.SystemID, terraform.ParentCommandID) * terraform.Terraformers
        } else {
          map[terraform.PopulationID].planetaryCapacity += this.populationTerraformingRate(terraform.PopulationID) * terraform.Terraformers
        }

        return map
      }, {})).map(terraform => {
        const localSurfaceArea = 4 * Math.PI * Math.pow(terraform.Radius, 2)
        const totalCapacity = (terraform.planetaryCapacity + terraform.orbitalCapacity) * this.populationTerraformingSpeed(terraform.PopulationID)
        const localCapacity = totalCapacity * (earthSurfaceArea / localSurfaceArea)

        const terraformingTask = {
          ...terraform,

          ID: `terraforming-${terraform.PopulationID}`,
          TaskType: 'Terraforming',

          TotalAnnualProduction: totalCapacity * (earthSurfaceArea / localSurfaceArea),
          AnnualProduction: 0,
          RemainingDays: 0,
        }

        terraformingTask.AnnualProduction = terraformingTask.TotalAnnualProduction

        if (terraform.GasName === 'Water Vapour' && terraform.HydroID === 3 && terraformingTask.TotalAnnualProduction) {
          const minConstructionPeriod = this.populationMinConstructionPeriod(terraform.PopulationID)

          const roi = minConstructionPeriod / secondsPerYear
          const periodDays = minConstructionPeriod / secondsPerDay

          const roiCapacity = localCapacity / secondsPerYear * minConstructionPeriod
          const roiCondensation = roi * condensationPerYear

          const condensationPoint = terraform.AtmosPress * (terraform.HydroExt / 100) * waterVapourInAtmosphere

          let periods = 0
          if (terraform.TerraformStatus) {
            let cycleExtent = terraform.HydroExt
            let cycleAtm = terraform.GasAtm
            let cyclePress = terraform.AtmosPress
            while (cycleExtent <= 20) {
              const roiCondensationPoint = cyclePress * (cycleExtent / 100) * waterVapourInAtmosphere
              const roiEndLevel = cycleAtm + roiCapacity

              const condensationAmount = roiEndLevel > roiCondensationPoint
                ? cycleAtm - roiCondensation < roiCondensationPoint
                  ? cycleAtm - roiCondensationPoint
                  : cycleAtm - roiCondensation
                : 0

              cyclePress = cyclePress + Math.max(0, roiEndLevel - cycleAtm - condensationAmount) 
              cycleAtm = Math.max(0, roiEndLevel - condensationAmount)
              cycleExtent += condensationAmount * condensationToHydroRate

              periods += 1
            }
          } else {
            let cycleExtent = terraform.HydroExt
            let cycleAtm = terraform.GasAtm
            let cyclePress = terraform.AtmosPress
            while (cycleExtent > 75) {
              const roiEvaporationPoint = cyclePress * (cycleExtent / 100) * waterVapourInAtmosphere
              const roiEndLevel = cycleAtm - roiCapacity

              if (roiEndLevel > roiEvaporationPoint) {
                cycleAtm = roiEndLevel
              } else {
                const evaporationAmount = roiEndLevel < 0
                  ? roiEvaporationPoint
                  : roiEndLevel < roiEvaporationPoint
                    ? roiEvaporationPoint - terraform.GasAtm
                    : 0

                if (roiEndLevel < 0) {
                  cyclePress = cyclePress - cycleAtm + evaporationAmount
                  cycleAtm = roiEvaporationPoint
                } else {
                  cyclePress += evaporationAmount
                  cycleAtm = roiEndLevel + evaporationAmount
                }
                
                cycleExtent -= evaporationAmount * condensationToHydroRate
              }

              periods += 1
            }
          }

          terraformingTask.RemainingDays = periods * periodDays
        } else {
          terraformingTask.RemainingDays = Math.max(0, terraform.TerraformStatus ? terraform.MaxAtm - terraform.GasAtm : terraform.GasAtm - terraform.MaxAtm) / (terraformingTask.TotalAnnualProduction / 365)
        }
        
        return terraformingTask
      })
    },

    tasks() {
      return [
        ...(this.showResearches ? this.modifiedResearches : []),
        ...(this.showProductions ? this.modifiedProductions : []),
        ...(this.showShipyards ? this.modifiedShipyards : []),
        ...(this.showShips ? this.modifiedShips : []),
        ...(this.showTrainings ? this.modifiedTrainings : []),
        ...(this.showTerraformings ? this.modifiedTerraformings : []),
      ].filter(task => this.showQueues ? true : !task.Queue)
    },

    headers() {
      return [
        {
          text: 'Type',
          value: 'TaskType',
          align: 'center',
          width: 130,
        },
        {
          text: 'Remaining Days',
          value: 'RemainingDays',
          align: 'right',
          width: 150,
        },
        {
          text: 'Population',
          value: 'PopulationID',
          align: 'left',
        },
        {
          text: 'Name',
          value: 'Name',
          divider: true,
        },
        {
          text: 'Annual Production',
          value: 'AnnualProduction',
          align: 'right',
        },
      ]
    },
    
    ProductionTypeMap() {
      return ProductionTypeMap
    },
    ShipyardTaskTypeMap() {
      return ShipyardTaskTypeMap
    },
    ShipyardUpgradeTypeMap() {
      return ShipyardUpgradeTypeMap
    },
  },
  asyncComputed: {
    populationProductionModifiers: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const modifiers = await this.database.query(`select VIR_PopulationModifiers.PopulationID, VIR_PopulationModifiers.PopName, VIR_PopulationModifiers.ShipyardOperations, VIR_PopulationModifiers.MinConstructionPeriod, VIR_PopulationModifiers.FighterProduction, VIR_PopulationModifiers.FighterProductionPower, VIR_PopulationModifiers.OrdnanceProduction, VIR_PopulationModifiers.OrdnanceProductionPower, VIR_PopulationModifiers.ConstructionProduction, VIR_PopulationModifiers.ConstructionPower, VIR_PopulationModifiers.GroundConstructionPower, VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.RadiationProductionModifier as EngineerProductionModifier, VIR_PopulationModifiers.ActualPlanetCommanderConstructionBonus * VIR_PopulationModifiers.ActualSectorCommanderConstructionBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as OverallProductionModifier, VIR_PopulationModifiers.ActualPlanetCommanderShipbuildingBonus * VIR_PopulationModifiers.ActualSectorCommanderShipbuildingBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.ShipBuilding * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as ShipyardBuildRate,VIR_PopulationModifiers.TerraformingRate, VIR_PopulationModifiers.ActualPlanetCommanderTerraformingBonus * VIR_PopulationModifiers.ActualSectorCommanderTerraformingBonus * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod * VIR_PopulationModifiers.TerraformingRate as PopulationTerraformingRate, VIR_PopulationModifiers.TerraformingSpeed, VIR_PopulationModifiers.ResearchRateModifier * VIR_PopulationModifiers.Research * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod * VIR_PopulationModifiers.ResearchSpeed as OverallResearchModifier, VIR_PopulationModifiers.GroundFormationConstructionRate * VIR_PopulationModifiers.ActualPlanetCommanderGroundUnitBonus * VIR_PopulationModifiers.ActualSectorCommanderGroundUnitBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as OverallGroundUnitModifier, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from (select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_Population.RaceID, (FCT_Game.ResearchSpeed / 100.0) as ResearchSpeed, (FCT_Game.TerraformingSpeed / 100.0) as TerraformingSpeed, FCT_Game.MinConstructionPeriod, FCT_Race.ConstructionProduction, FCT_Race.OrdnanceProduction, FCT_Race.FighterProduction, FCT_Race.Research, FCT_Race.ShipBuilding, FCT_Race.GroundFormationConstructionRate, coalesce(VIR_PlanetProduction.PlanetCommanderConstructionBonus, 1.0) as ActualPlanetCommanderConstructionBonus, coalesce(VIR_PlanetProduction.PlanetCommanderShipbuildingBonus, 1.0) as ActualPlanetCommanderShipbuildingBonus, coalesce(VIR_PlanetProduction.PlanetCommanderTerraformingBonus, 1.0) as ActualPlanetCommanderTerraformingBonus, coalesce(VIR_PlanetProduction.PlanetCommanderGroundUnitBonus, 1.0) as ActualPlanetCommanderGroundUnitBonus, coalesce(VIR_SectorProduction.SectorCommanderConstructionBonus, 1.0) as ActualSectorCommanderConstructionBonus, coalesce(VIR_SectorProduction.SectorCommanderShipbuildingBonus, 1.0) as ActualSectorCommanderShipbuildingBonus, coalesce(VIR_SectorProduction.SectorCommanderTerraformingBonus, 1.0) as ActualSectorCommanderTerraformingBonus, coalesce(VIR_SectorProduction.SectorCommanderGroundUnitBonus, 1.0) as ActualSectorCommanderGroundUnitBonus, FCT_Species.ProductionRateModifier, FCT_Race.TerraformingRate, FCT_Species.ResearchRateModifier, FCT_Race.EconomicProdModifier, FCT_Race.ShipyardOperations, FCT_Population.Efficiency, (1 - (FCT_SystemBody.RadiationLevel / 10000)) as RadiationProductionModifier, (1 - (FCT_Population.UnrestPoints / 100)) as PoliticalStability, DIM_PopPoliticalStatus.ProductionMod, coalesce(VIR_InstallationProduction.ConstructionPower, 0) as ConstructionPower, coalesce(VIR_InstallationProduction.OrdnanceProductionPower, 0) as OrdnanceProductionPower, coalesce(VIR_InstallationProduction.FighterProductionPower, 0) as FighterProductionPower, coalesce(VIR_GroundPopulationConstruction.GroundConstructionPower, 0) as GroundConstructionPower from FCT_Population left join (select FCT_Commander.CommandID, JOI_ConstructionCommanderBonuses.BonusValue as PlanetCommanderConstructionBonus, JOI_ShipbuildingCommanderBonuses.BonusValue as PlanetCommanderShipbuildingBonus, JOI_TerraformingCommanderBonuses.BonusValue as PlanetCommanderTerraformingBonus, JOI_GroundUnitCommanderBonuses.BonusValue as PlanetCommanderGroundUnitBonus from FCT_Commander left join FCT_CommanderBonuses as JOI_ConstructionCommanderBonuses on JOI_ConstructionCommanderBonuses.BonusID = 5 and JOI_ConstructionCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_ShipbuildingCommanderBonuses on JOI_ShipbuildingCommanderBonuses.BonusID = 4 and JOI_ShipbuildingCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_TerraformingCommanderBonuses on JOI_TerraformingCommanderBonuses.BonusID = 9 and JOI_TerraformingCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_GroundUnitCommanderBonuses on JOI_GroundUnitCommanderBonuses.BonusID = 11 and JOI_GroundUnitCommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_PlanetProduction on VIR_PlanetProduction.CommandID = FCT_Population.PopulationID left join (select FCT_Population.PopulationID, 1 + (COALESCE(JOI_ConstructionCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderConstructionBonus, 1 + (COALESCE(JOI_ShipbuildingCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderShipbuildingBonus, 1 + (COALESCE(JOI_TerraformingCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderTerraformingBonus, 1 + (COALESCE(JOI_GroundUnitCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderGroundUnitBonus from FCT_Commander left join FCT_CommanderBonuses as JOI_ConstructionCommanderBonuses on JOI_ConstructionCommanderBonuses.BonusID = 5 and JOI_ConstructionCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_ShipbuildingCommanderBonuses on JOI_ShipbuildingCommanderBonuses.BonusID = 4 and JOI_ShipbuildingCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_TerraformingCommanderBonuses on JOI_TerraformingCommanderBonuses.BonusID = 9 and JOI_TerraformingCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_GroundUnitCommanderBonuses on JOI_GroundUnitCommanderBonuses.BonusID = 5 and JOI_GroundUnitCommanderBonuses.CommanderID = FCT_Commander.CommanderID inner join FCT_RaceSysSurvey on FCT_Commander.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 inner join FCT_Population on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_SectorProduction on VIR_SectorProduction.PopulationID = FCT_Population.PopulationID left join (select FCT_PopulationInstallations.PopID, SUM(DIM_PlanetaryInstallation.ConstructionValue * FCT_PopulationInstallations.Amount) as ConstructionPower, SUM(DIM_PlanetaryInstallation.OrdnanceProductionValue * FCT_PopulationInstallations.Amount) as OrdnanceProductionPower, SUM(DIM_PlanetaryInstallation.FighterProductionValue * FCT_PopulationInstallations.Amount) as FighterProductionPower from DIM_PlanetaryInstallation left join FCT_PopulationInstallations on FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID group by FCT_PopulationInstallations.PopID) as VIR_InstallationProduction on VIR_InstallationProduction.PopID = FCT_Population.PopulationID left join (select FCT_GroundUnitFormation.PopulationID, SUM(VIR_FormationConstruction.FormationConstructionRating * COALESCE(FCT_CommanderBonuses.BonusValue, 1)) as GroundConstructionPower from FCT_GroundUnitFormation left join (select FCT_GroundUnitFormationElement.*, SUM(FCT_GroundUnitFormationElement.Units * FCT_GroundUnitClass.ConstructionRating) as FormationConstructionRating from FCT_GroundUnitFormationElement left join FCT_GroundUnitClass on FCT_GroundUnitFormationElement.ClassID = FCT_GroundUnitClass.GroundUnitClassID group by FCT_GroundUnitFormationElement.FormationID) as VIR_FormationConstruction on FCT_GroundUnitFormation.FormationID = VIR_FormationConstruction.FormationID left join FCT_Commander on FCT_Commander.CommandID = FCT_GroundUnitFormation.FormationID and FCT_Commander.CommanderType in (1,4) and FCT_Commander.CommandType = 5 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 5 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID group by FCT_GroundUnitFormation.PopulationID) as VIR_GroundPopulationConstruction on VIR_GroundPopulationConstruction.PopulationID = FCT_Population.PopulationID left join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join DIM_PopPoliticalStatus on FCT_Population.PoliticalStatus = DIM_PopPoliticalStatus.StatusID left join FCT_Game on FCT_Population.GameID = FCT_Game.GameID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}) as VIR_PopulationModifiers left join FCT_SystemBody on VIR_PopulationModifiers.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and VIR_PopulationModifiers.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on VIR_PopulationModifiers.SystemID = FCT_RaceSysSurvey.SystemID and VIR_PopulationModifiers.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID`).then(([ items ]) => {
          console.log('Population Production Modifiers', items)

          return items
        })

        return modifiers.reduce((map, modifier) => {
          map[modifier.PopulationID] = modifier
          
          return map
        }, {})
      },
      default: {},
    },
    researches: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const queues = await this.database.query(`select FCT_ResearchQueue.CurrentProjectID, FCT_ResearchQueue.ResearchOrder, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost, DIM_TechType.FieldID as ProjectField from FCT_ResearchQueue left join FCT_TechSystem on FCT_ResearchQueue.TechSystemID = FCT_TechSystem.TechSystemID left join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_ResearchQueue.GameID = ${this.GameID}`).then(([ items ]) => {
          console.log('Research queue', items)

          return items
        })

        const projects = await this.database.query(`select FCT_ResearchProject.ProjectID as ID, FCT_Population.PopName, FCT_Population.PopulationID, FCT_TechSystem.Name, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired as RemainingProduction, VIR_ResearchBonus.CommanderBonus, VIR_ResearchBonus.CommanderField, FCT_ResearchProject.ResSpecID as ProjectField, FCT_AncientConstruct.ResearchField as AnomalyField, FCT_AncientConstruct.ResearchBonus as AnomalyBonus, case when VIR_ResearchBonus.CommanderField = FCT_ResearchProject.ResSpecID then VIR_ResearchBonus.CommanderBonus * 4 - 3 else VIR_ResearchBonus.CommanderBonus end as ActualCommanderResearchBonus, COALESCE(case when FCT_AncientConstruct.ResearchField = FCT_ResearchProject.ResSpecID then FCT_AncientConstruct.ResearchBonus else 1 end, 1) as ActualAnomalyBonus from FCT_ResearchProject left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as CommanderBonus, FCT_Commander.ResSpecID as CommanderField from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 3 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (3,4) and FCT_Commander.CommandType = 7 and FCT_Commander.CommandID <> 0) as VIR_ResearchBonus on VIR_ResearchBonus.CommandID = FCT_ResearchProject.ProjectID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_AncientConstruct on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Research projects', items)

          return items
        })

        const projectMap = projects.reduce((map, project) => {
          map[project.ID] = project

          return map
        }, {})

        return [...projects, ...queues.reduce((reduction, queue) => {
          const currentProject = projectMap[queue.CurrentProjectID]

          if (currentProject) {
            reduction.push({
              ProjectID: currentProject.ID,
              ID: `${currentProject.ID}-${queue.ResearchOrder}`,
              PopName: currentProject.PopName,
              PopulationID: currentProject.PopulationID,
              Name: queue.Name,
              ProjectField: queue.ProjectField,
              CommanderField: currentProject.CommanderField,
              Facilities: currentProject.Facilities,
              RemainingProduction: queue.DevelopCost,
              Queue: true,
              Paused: currentProject.Paused,
              QueueChain: [currentProject.ID, ...queues.filter(subQueue => subQueue.CurrentProjectID === queue.CurrentProjectID && subQueue.ResearchOrder < queue.ResearchOrder).map(subQueue => `${currentProject.ID}-${subQueue.ResearchOrder}`)],
              ActualCommanderResearchBonus: currentProject.ProjectField === queue.ProjectField ? currentProject.ActualCommanderResearchBonus : currentProject.CommanderBonus,
              ActualAnomalyBonus: currentProject.ProjectField === queue.ProjectField ? currentProject.ActualAnomalyBonus : 1,
            })
          }

          return reduction
        }, [])]
      },
      default: [],
    },
    productions: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.PopulationID, FCT_Population.PopName, FCT_IndustrialProjects.Description as Name, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.Amount * FCT_IndustrialProjects.ProdPerUnit as RemainingProduction, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause as Paused from FCT_IndustrialProjects left join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Industrial Production', items)

          return items
        })
      },
      default: [],
    },
    ships: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipyardTask.TaskID as ID, FCT_Population.PopName, FCT_ShipyardTask.TaskTypeID as ShipyardTaskType, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingProduction, FCT_ShipyardTask.Paused, (case when FCT_Shipyard.SYType = 1 then 1.0 else 0.25 end) as CommercialModifier from FCT_ShipyardTask left join FCT_Population on FCT_Population.PopulationID = FCT_ShipyardTask.PopulationID left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID where FCT_ShipyardTask.GameID = ${this.GameID} and FCT_ShipyardTask.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Ships', items)

          return items
        })
      },
      default: [],
    },
    shipyards: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Shipyard.ShipyardID as ID, FCT_Population.PopName, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.RetoolClassID, FCT_ShipClass.ClassName, FCT_Shipyard.TaskType as UpgradeTaskType, FCT_Shipyard.RequiredBP - FCT_Shipyard.CompletedBP as RemainingProduction, FCT_Shipyard.PauseActivity as Paused, FCT_Shipyard.CapacityTarget from FCT_Shipyard left join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID left join FCT_ShipClass on FCT_Shipyard.RetoolClassID = FCT_ShipClass.ShipClassID where FCT_Shipyard.TaskType <> 0 and FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Shipyards', items)

          return items
        })
      },
      default: [],
    },
    trainings: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_GroundUnitTraining.TaskID as ID, FCT_Population.PopName, FCT_GroundUnitTraining.PopulationID, FCT_GroundUnitTraining.FormationName as Name, FCT_GroundUnitTraining.TotalBP - FCT_GroundUnitTraining.CompletedBP as RemainingProduction from FCT_GroundUnitTraining left join FCT_Population on FCT_Population.PopulationID = FCT_GroundUnitTraining.PopulationID where FCT_GroundUnitTraining.GameID = ${this.GameID} and FCT_GroundUnitTraining.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Trainings', items)

          return items
        })
      },
      default: [],
    },
    navalAdministrations: {
       async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const admins = await this.database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.PopulationID, FCT_Population.SystemID, FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.NavalHeadquartersValue as NavalAdminCommandLevel, FCT_CommanderBonuses.BonusValue, DIM_NavalAdminCommandType.Radius, DIM_NavalAdminCommandType.Industrial from FCT_NavalAdminCommand inner join FCT_PopulationInstallations on FCT_PopulationInstallations.PopID = FCT_NavalAdminCommand.PopulationID left join FCT_Population on FCT_NavalAdminCommand.PopulationID = FCT_Population.PopulationID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID left join DIM_NavalAdminCommandType on FCT_NavalAdminCommand.AdminCommandTypeID = DIM_NavalAdminCommandType.CommandTypeID left join FCT_Commander on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 12 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 9 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_NavalAdminCommand.GameID = ${this.GameID} and FCT_NavalAdminCommand.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.NavalHeadquartersValue > 0`).then(([ items ]) => {
          console.log('Naval Administrations', items)

          return items.map(item => ({
            ...item,

            Radius: item.Radius * Math.floor(Math.log(item.NavalAdminCommandLevel) / Math.log(2))
          }))
        })

        return admins
      },
      default: [],
    },
    terraforms: {
       async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const orbitalTerraformers = await this.database.query(`select sum(FCT_ShipClass.Terraformers * FCT_CommanderBonuses.BonusValue) as Terraformers, FCT_Fleet.ParentCommandID, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.AtmosPress, FCT_SystemBody.Radius, FCT_Population.TerraformStatus, DIM_Gases.Name as GasName, FCT_Population.MaxAtm, FCT_AtmosphericGas.GasAtm from FCT_Ship left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_Population on FCT_Fleet.OrbitBodyID = FCT_Population.SystemBodyID and FCT_Ship.RaceID = FCT_Population.RaceID left join FCT_Commander on FCT_Ship.ShipID = FCT_Commander.CommandID and FCT_Commander.CommandType = 1 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 9 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join FCT_Race on FCT_Population.RaceID = FCT_Race.RaceID left join DIM_Gases on FCT_Population.TerraformingGasID = DIM_Gases.GasID left join FCT_AtmosphericGas on FCT_Population.SystemBodyID = FCT_AtmosphericGas.SystemBodyID and FCT_Population.TerraformingGasID = FCT_AtmosphericGas.AtmosGasID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipClass.Terraformers > 0 and FCT_Population.TerraformingGasID != 0 group by FCT_Population.PopulationID, FCT_Fleet.ParentCommandID`).then(([ items ]) => {
          console.log('Orbital Terraforms', items)

          return items
        })

        const planetaryTerraformers = await this.database.query(`select sum(DIM_PlanetaryInstallation.TerraformValue * FCT_PopulationInstallations.Amount) as Terraformers, NULL as ParentCommandID, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.AtmosPress, FCT_SystemBody.Radius, FCT_Population.TerraformStatus, DIM_Gases.Name as GasName, FCT_Population.MaxAtm, FCT_AtmosphericGas.GasAtm from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID left join FCT_Population on FCT_PopulationInstallations.PopID = FCT_Population.PopulationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join FCT_Race on FCT_Population.RaceID = FCT_Race.RaceID left join DIM_Gases on FCT_Population.TerraformingGasID = DIM_Gases.GasID left join FCT_AtmosphericGas on FCT_Population.SystemBodyID = FCT_AtmosphericGas.SystemBodyID and FCT_Population.TerraformingGasID = FCT_AtmosphericGas.AtmosGasID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.TerraformValue > 0 and FCT_Population.TerraformingGasID != 0 group by FCT_Population.PopulationID`).then(([ items ]) => {
          console.log('Planetary Terraforms', items)

          return items
        })

        return [
          ...orbitalTerraformers,
          ...planetaryTerraformers,
        ]
      },
      default: [],
    },
    raceSystems: {
      async get() {
        if (!this.database || !this.GameID) {
          return {}
        }

        const systems = await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Systems', items)

          return items.reduce((map, item) => {
            map[item.SystemID] = {
              SystemID: String(item.SystemID),
              Name: item.Name,

              Neighbors: new Set(),
            }
            
            return map
          }, {})
        })

        await this.database.query(`select FCT_JumpPoint.*, VIR_Destination.SystemID as DestinationID, FCT_RaceSysSurvey.Name, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.Charted, FCT_RaceJumpPointSurvey.Hide from FCT_JumpPoint inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_JumpPoint as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID left join FCT_RaceJumpPointSurvey on FCT_JumpPoint.WarpPointID = FCT_RaceJumpPointSurvey.WarpPointID and FCT_Race.RaceID = FCT_RaceJumpPointSurvey.RaceID where FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1`).then(([ items ]) => {
          console.log('Jump Points', items)

          items.forEach(item => {
            const origin = systems[item.SystemID]
            const destination = systems[item.DestinationID]

            if (origin && destination) {
              origin.Neighbors.add(destination)
            }
          })
        })

        return systems
      },
      default: {},
    },
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>
.panel {
  margin-bottom: 20px;
}

.v-btn--active.no-active::before {                                                                             
  opacity: 0 !important;
}
</style>
