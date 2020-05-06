<template>
  <div class="recap-container">
    <div v-if="!GameID">Select a race from the left-side menu.</div>

    <v-container fluid v-if="RaceID">
      <v-row justify="start">
        <v-col cols="12">
          <v-btn class="overline d-inline-block" elevation="1" :color="showResearches ? 'pink lighten-4' : 'light'" small tile dense borderless @click="showResearches = !showResearches">Research</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="showProductions ? 'light-green lighten-2' : 'light'" small tile dense borderless @click="showProductions = !showProductions">Production</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="showShipyards ? 'purple accent-1' : 'light'" small tile dense borderless @click="showShipyards = !showShipyards">Shipyard</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="showShips ? 'blue lighten-4' : 'light'" small tile dense borderless @click="showShips = !showShips">Ship</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="showTrainings ? 'teal accent-3' : 'light'" small tile dense borderless @click="showTrainings = !showTrainings">Training</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" :color="showQueues ? 'yellow lighten-1' : 'light'" small tile dense borderless @click="toggleQueues">Show Queues</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" color="deep-purple accent-2" small dark tile dense borderless v-if="!showResearches || !showProductions || !showShips" @click="restoreTypes">All</v-btn>
        </v-col>
      </v-row>
      <v-row justify="start">
        <v-col cols="12">
          <v-data-table ref="tablle" :headers="headers" :items="tasks" item-key="ID" class="elevation-1" sort-by="RemainingDays" disable-pagination hide-default-footer>
            <template v-slot:item.TaskType="{ item }">
              <span class="py-1 px-2 overline font-weight-medium elevation-1" :class="{
                'pink lighten-4': item.TaskType === 'Research',
                'light-green lighten-2': item.TaskType === 'Production',
                'purple accent-1': item.TaskType === 'Shipyard',
                'blue lighten-4': item.TaskType === 'Ship',
                'teal accent-3': item.TaskType === 'Training',
              }">{{ item.TaskType }}</span>
            </template>
            <template v-slot:item.Name="{ item }">
              <span v-if="item.TaskType === 'Production'">
                {{ roundToDecimal(item.Amount, 1) }}x
              </span>
              {{ item.Name }} 
              <span class="orange--text font-weight-bold" v-if="item.ProjectField !== item.CommanderField">(Field Mismatch)</span>
              <span class="overline uppercase float-right" v-if="item.ShipyardTaskType">[{{ ShipyardTaskTypeMap[item.ShipyardTaskType] }}]</span>
              <span class="overline uppercase float-right" v-if="item.ProductionType">[{{ ProductionTypeMap[item.ProductionType] }}]</span>
              <span v-if="item.TaskType === 'Ship'">({{ item.ClassName }} class)</span>
              <span v-if="item.UpgradeTaskType === 7">to {{ item.ClassName }}</span>
              <span v-if="item.UpgradeTaskType === 8">to {{ item.CapacityTarget }}</span>
            </template>
            <template v-slot:item.AnnualProduction="{ item }">
              <span v-if="item.TaskType === 'Research'">
                {{ Math.round(item.AnnualProduction) }} RP / {{ item.Facilities }} Labs
              </span>
              <span v-if="item.TaskType === 'Production'">
                {{ Math.round(item.AnnualProduction) }} BP / {{ item.Percentage }}%
              </span>
              <span v-if="item.TaskType === 'Ship'">
                {{ Math.round(item.AnnualProduction) }} BP
              </span>
              <span v-if="item.TaskType === 'Shipyard'">
                {{ Math.round(item.AnnualProduction) }} Mod Rate
              </span>
              <span v-if="item.TaskType === 'Training'">
                {{ Math.round(item.AnnualProduction) }} BP
              </span>
            </template>
            <template v-slot:item.RemainingDays="{ item }">
              <span :class="{
                'red--text font-weight-bold': item.Queue,
                'orange--text font-weight-bold': item.Paused,
              }">
                <span v-if="item.UpgradeTaskType === 8">~</span>
                <span v-if="item.Queue && item.TaskType !== 'Research'">Queued</span>
                <span v-else>{{ separatedNumber(roundToDecimal(item.RemainingDays, 1)) }}</span>
              </span>
            </template>
          </v-data-table>
        </v-col>
      </v-row>
    </v-container>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'
import { separatedNumber, roundToDecimal } from '../../utilities/math'

const secondsPerYear = 31536000
const secondsPerDay = 86400

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
      showResearches: true,
      showProductions: true,
      showShipyards: true,
      showShips: true,
      showTrainings: true,

      showQueues: true,

      panels: [0, 1, 2],
    }
  },
  methods: {
    separatedNumber,
    roundToDecimal,

    isTypeActive(type) {
      return this.types.includes(type)
    },

    restoreTypes() {
      this.showResearches = true
      this.showProductions = true
      this.showShipyards = true
      this.showShips = true
      this.showTrainings = true
    },

    toggleQueues() {
      this.showQueues = !this.showQueues
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
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

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

          TaskType: 'Ship',

          TotalAnnualProduction,
          AnnualProduction: TotalAnnualProduction,
          RemainingDays: ship.RemainingProduction / (TotalAnnualProduction / 365) // * (ship.Queue ? 50000 : 1) // No queues in shipyards
        }
      })
    },
    modifiedShipyards() {
      return this.shipyards.map(shipyard => {
        const UpgradeRate = this.populationShipyardUpgradeCapacity(shipyard.PopulationID, shipyard)

        let remainingDays = shipyard.UpgradeTaskType === 8 ? this.shipyardContinualRemainingDays(shipyard) : shipyard.RemainingProduction / UpgradeRate * secondsPerYear / secondsPerDay / (shipyard.UpgradeTaskType === 7 ? shipyard.Slipways : 1)
        
        return {
          ...shipyard,

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

          TaskType: 'Training',

          TotalAnnualProduction,
          AnnualProduction: TotalAnnualProduction,
          RemainingDays: training.RemainingProduction / (TotalAnnualProduction / 365),
        }
      })
    },

    tasks() {
      return [
        ...(this.showResearches ? this.modifiedResearches : []),
        ...(this.showProductions ? this.modifiedProductions : []),
        ...(this.showShipyards ? this.modifiedShipyards : []),
        ...(this.showShips ? this.modifiedShips : []),
        ...(this.showTrainings ? this.modifiedTrainings : []),
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

        const modifiers = await this.database.query(`select *, VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.RadiationProductionModifier as EngineerProductionModifier, VIR_PopulationModifiers.ActualPlanetCommanderConstructionBonus * VIR_PopulationModifiers.ActualSectorCommanderConstructionBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as OverallProductionModifier, VIR_PopulationModifiers.ActualPlanetCommanderShipbuildingBonus * VIR_PopulationModifiers.ActualSectorCommanderShipbuildingBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.ShipBuilding * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as ShipyardBuildRate, VIR_PopulationModifiers.ResearchRateModifier * VIR_PopulationModifiers.Research * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod * VIR_PopulationModifiers.ResearchSpeed as OverallResearchModifier, VIR_PopulationModifiers.GroundFormationConstructionRate * VIR_PopulationModifiers.ActualPlanetCommanderGroundUnitBonus * VIR_PopulationModifiers.ActualSectorCommanderGroundUnitBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as OverallGroundUnitModifier from (select FCT_Population.PopulationID, (FCT_Game.ResearchSpeed / 100.0) as ResearchSpeed, FCT_Game.MinConstructionPeriod, FCT_Race.ConstructionProduction, FCT_Race.OrdnanceProduction, FCT_Race.FighterProduction, FCT_Race.Research, FCT_Race.ShipBuilding, FCT_Race.GroundFormationConstructionRate, coalesce(VIR_PlanetProduction.PlanetCommanderConstructionBonus, 1.0) as ActualPlanetCommanderConstructionBonus, coalesce(VIR_PlanetProduction.PlanetCommanderShipbuildingBonus, 1.0) as ActualPlanetCommanderShipbuildingBonus, coalesce(VIR_PlanetProduction.PlanetCommanderGroundUnitBonus, 1.0) as ActualPlanetCommanderGroundUnitBonus, coalesce(VIR_SectorProduction.SectorCommanderConstructionBonus, 1.0) as ActualSectorCommanderConstructionBonus, coalesce(VIR_SectorProduction.SectorCommanderShipbuildingBonus, 1.0) as ActualSectorCommanderShipbuildingBonus, coalesce(VIR_SectorProduction.SectorCommanderGroundUnitBonus, 1.0) as ActualSectorCommanderGroundUnitBonus, FCT_Species.ProductionRateModifier, FCT_Species.ResearchRateModifier, FCT_Race.EconomicProdModifier, FCT_Race.ShipyardOperations, FCT_Population.Efficiency, (1 - (FCT_SystemBody.RadiationLevel / 10000)) as RadiationProductionModifier, (1 - (FCT_Population.UnrestPoints / 100)) as PoliticalStability, DIM_PopPoliticalStatus.ProductionMod, coalesce(VIR_InstallationProduction.ConstructionPower, 0) as ConstructionPower, coalesce(VIR_InstallationProduction.OrdnanceProductionPower, 0) as OrdnanceProductionPower, coalesce(VIR_InstallationProduction.FighterProductionPower, 0) as FighterProductionPower, coalesce(VIR_GroundPopulationConstruction.GroundConstructionPower, 0) as GroundConstructionPower from FCT_Population left join (select FCT_Commander.CommandID, JOI_ConstructionCommanderBonuses.BonusValue as PlanetCommanderConstructionBonus, JOI_ShipbuildingCommanderBonuses.BonusValue as PlanetCommanderShipbuildingBonus, JOI_GroundUnitCommanderBonuses.BonusValue as PlanetCommanderGroundUnitBonus from FCT_Commander left join FCT_CommanderBonuses as JOI_ConstructionCommanderBonuses on JOI_ConstructionCommanderBonuses.BonusID = 5 and JOI_ConstructionCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_ShipbuildingCommanderBonuses on JOI_ShipbuildingCommanderBonuses.BonusID = 4 and JOI_ShipbuildingCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_GroundUnitCommanderBonuses on JOI_GroundUnitCommanderBonuses.BonusID = 11 and JOI_GroundUnitCommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_PlanetProduction on VIR_PlanetProduction.CommandID = FCT_Population.PopulationID left join (select FCT_Population.PopulationID, 1 + (COALESCE(JOI_ConstructionCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderConstructionBonus, 1 + (COALESCE(JOI_ShipbuildingCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderShipbuildingBonus, 1 + (COALESCE(JOI_GroundUnitCommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorCommanderGroundUnitBonus from FCT_Commander left join FCT_CommanderBonuses as JOI_ConstructionCommanderBonuses on JOI_ConstructionCommanderBonuses.BonusID = 5 and JOI_ConstructionCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_ShipbuildingCommanderBonuses on JOI_ShipbuildingCommanderBonuses.BonusID = 4 and JOI_ShipbuildingCommanderBonuses.CommanderID = FCT_Commander.CommanderID left join FCT_CommanderBonuses as JOI_GroundUnitCommanderBonuses on JOI_GroundUnitCommanderBonuses.BonusID = 5 and JOI_GroundUnitCommanderBonuses.CommanderID = FCT_Commander.CommanderID inner join FCT_RaceSysSurvey on FCT_Commander.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 inner join FCT_Population on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_SectorProduction on VIR_SectorProduction.PopulationID = FCT_Population.PopulationID left join (select FCT_PopulationInstallations.PopID, SUM(DIM_PlanetaryInstallation.ConstructionValue * FCT_PopulationInstallations.Amount) as ConstructionPower, SUM(DIM_PlanetaryInstallation.OrdnanceProductionValue * FCT_PopulationInstallations.Amount) as OrdnanceProductionPower, SUM(DIM_PlanetaryInstallation.FighterProductionValue * FCT_PopulationInstallations.Amount) as FighterProductionPower from DIM_PlanetaryInstallation left join FCT_PopulationInstallations on FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID group by FCT_PopulationInstallations.PopID) as VIR_InstallationProduction on VIR_InstallationProduction.PopID = FCT_Population.PopulationID left join (select FCT_GroundUnitFormation.PopulationID, SUM(VIR_FormationConstruction.FormationConstructionRating * COALESCE(FCT_CommanderBonuses.BonusValue, 1)) as GroundConstructionPower from FCT_GroundUnitFormation left join (select FCT_GroundUnitFormationElement.*, SUM(FCT_GroundUnitFormationElement.Units * FCT_GroundUnitClass.ConstructionRating) as FormationConstructionRating from FCT_GroundUnitFormationElement left join FCT_GroundUnitClass on FCT_GroundUnitFormationElement.ClassID = FCT_GroundUnitClass.GroundUnitClassID group by FCT_GroundUnitFormationElement.FormationID) as VIR_FormationConstruction on FCT_GroundUnitFormation.FormationID = VIR_FormationConstruction.FormationID left join FCT_Commander on FCT_Commander.CommandID = FCT_GroundUnitFormation.FormationID and FCT_Commander.CommanderType in (1,4) and FCT_Commander.CommandType = 5 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 5 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID group by FCT_GroundUnitFormation.PopulationID) as VIR_GroundPopulationConstruction on VIR_GroundPopulationConstruction.PopulationID = FCT_Population.PopulationID left join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join DIM_PopPoliticalStatus on FCT_Population.PoliticalStatus = DIM_PopPoliticalStatus.StatusID left join FCT_Game on FCT_Population.GameID = FCT_Game.GameID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}) as VIR_PopulationModifiers`).then(([ items ]) => {
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

        const projects = await this.database.query(`select FCT_ResearchProject.ProjectID as ID, FCT_Population.PopName, FCT_Population.PopulationID, FCT_TechSystem.Name, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired as RemainingProduction, VIR_ResearchBonus.CommanderBonus, VIR_ResearchBonus.CommanderField, FCT_ResearchProject.ResSpecID as ProjectField, FCT_Anomalies.ResearchField as AnomalyField, FCT_Anomalies.ResearchBonus as AnomalyBonus, case when VIR_ResearchBonus.CommanderField = FCT_ResearchProject.ResSpecID then VIR_ResearchBonus.CommanderBonus * 4 - 3 else VIR_ResearchBonus.CommanderBonus end as ActualCommanderResearchBonus, COALESCE(case when FCT_Anomalies.ResearchField = FCT_ResearchProject.ResSpecID then FCT_Anomalies.ResearchBonus else 1 end, 1) as ActualAnomalyBonus from FCT_ResearchProject left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as CommanderBonus, FCT_Commander.ResSpecID as CommanderField from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 3 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (3,4) and FCT_Commander.CommandType = 7 and FCT_Commander.CommandID <> 0) as VIR_ResearchBonus on VIR_ResearchBonus.CommandID = FCT_ResearchProject.ProjectID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_Anomalies on FCT_SystemBody.SystemBodyID = FCT_Anomalies.SystemBodyID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`).then(([ items ]) => {
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
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>
.recap-container {
  //
}

.panel {
  margin-bottom: 20px;
}

.v-btn--active.no-active::before {                                                                             
  opacity: 0 !important;
}
</style>
