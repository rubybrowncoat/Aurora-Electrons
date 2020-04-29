<template>
  <div class="recap-container">
    <div v-if="!GameID">Select a race from the left-side menu.</div>
    
    <v-container fluid v-if="RaceID">
      <v-row justify="start">
        <v-col cols="12">
          <v-btn-toggle class="d-inline-block" v-model="types" tile dense group multiple borderless>
            <v-btn class="overline" elevation="1" active-class="font-weight-medium no-active" v-for="type in availableTypes" :key="type" :color="!types.includes(type) ? 'light' : (type === 'Research' ? 'pink lighten-4' : type === 'Production' ? 'light-green lighten-2' : 'blue lighten-4')" small :value="type">{{ type }}</v-btn>
          </v-btn-toggle>
          <v-btn class="overline d-inline-block" elevation="1" :color="showQueues ? 'yellow lighten-1' : 'light'" small tile dense borderless @click="toggleQueues">Show Queues</v-btn>
          <v-btn class="overline d-inline-block" elevation="1" color="deep-purple accent-2" small dark tile dense borderless v-if="types.length !== availableTypes.length" @click="restoreTypes">All</v-btn>
        </v-col>
      </v-row>
      <v-row justify="start">
        <v-col cols="12">
          <v-data-table ref="tablle" :headers="headers" :items="tasks" item-key="ID" class="elevation-1" sort-by="RemainingDays" disable-pagination hide-default-footer>
            <template v-slot:item.TaskType="{ item }">
              <span class="py-1 px-2 overline font-weight-medium elevation-1" :class="{
                'pink lighten-4': item.TaskType === 'Research',
                'light-green lighten-2': item.TaskType === 'Production',
                'blue lighten-4': item.TaskType === 'Ship',
              }">{{ item.TaskType }}</span>
            </template>
            <template v-slot:item.Name="{ item }">
              <span v-if="item.TaskType === 'Production'">{{ roundToDecimal(item.Amount, 1) }}x</span>
              {{ item.Name }} 
              <span v-if="item.TaskType === 'Ship'">({{ item.ClassName }} class)</span>
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
            </template>
            <template v-slot:item.RemainingDays="{ item }">
              <span :class="{
                'red--text font-weight-bold': item.Queue,
                'orange--text font-weight-bold': item.Paused,
              }">
                <span v-if="item.Queue">Queued</span>
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

const improvedConstructionRateTechTypeId = 25

export default {
  components: {},
  data() {
    return {
      availableTypes: ['Research', 'Production', 'Ship'],
      types: ['Research', 'Production', 'Ship'],

      showQueues: true,

      panels: [0, 1, 2],
    }
  },
  methods: {
    separatedNumber,
    roundToDecimal,

    restoreTypes() {
      this.types = [...this.availableTypes]
    },

    toggleQueues() {
      this.showQueues = !this.showQueues
    },
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    tasks() {
      return [
        ...(this.types.includes('Research') ? this.research.filter(research => this.showQueues ? true : !research.Queue).map(research => ({
          ...research,

          RemainingDays: research.RemainingDays * (research.Queue ? 50000 : 1),
          TaskType: 'Research',
        })) : []),
        ...(this.types.includes('Production') ? this.production.filter(production => this.showQueues ? true : !production.Queue).map(production => ({
          ...production,

          RemainingDays: production.RemainingDays * (production.Queue ? 50000 : 1),
          TaskType: 'Production',
        })) : []),
        ...(this.types.includes('Ship') ? this.ships.filter(ship => this.showQueues ? true : !ship.Queue).map(ship => ({
          ...ship,

          RemainingDays: ship.RemainingDays * (ship.Queue ? 50000 : 1),
          TaskType: 'Ship',
        })) : []),
      ]
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
  },
  asyncComputed: {
    research: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const queues = await this.database.query(`select FCT_ResearchQueue.CurrentProjectID, FCT_ResearchQueue.ResearchOrder, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost from FCT_ResearchQueue left join FCT_TechSystem on FCT_ResearchQueue.TechSystemID = FCT_TechSystem.TechSystemID`).then(([ items ]) => {
          console.log('Research queue', items)

          return items
        })

        const projects = await this.database.query(`select *, VIR_ResearchProjects.ResearchModifier * VIR_ResearchProjects.Facilities * VIR_ResearchProjects.ActualCommanderBonus * VIR_ResearchProjects.ActualAnomalyBonus as AnnualProduction, VIR_ResearchProjects.ResearchPointsRequired / (VIR_ResearchProjects.ResearchModifier * VIR_ResearchProjects.Facilities * VIR_ResearchProjects.ActualCommanderBonus * VIR_ResearchProjects.ActualAnomalyBonus / 365) as RemainingDays from (select *, case when VIR_ResearchProjectsIntermediary.CommanderField = VIR_ResearchProjectsIntermediary.ProjectField then VIR_ResearchProjectsIntermediary.CommanderBonus * 4 - 3 else VIR_ResearchProjectsIntermediary.CommanderBonus end as ActualCommanderBonus, COALESCE(case when VIR_ResearchProjectsIntermediary.AnomalyField = VIR_ResearchProjectsIntermediary.ProjectField then VIR_ResearchProjectsIntermediary.AnomalyBonus else 1 end, 1) as ActualAnomalyBonus from (select FCT_ResearchProject.ProjectID, FCT_Population.PopName, FCT_TechSystem.Name, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired, FCT_Species.ResearchRateModifier * FCT_Race.Research * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * (1 - (FCT_SystemBody.RadiationLevel / 10000)) * (1 - (FCT_Population.UnrestPoints / 100)) * DIM_PopPoliticalStatus.ProductionMod * (FCT_Game.ResearchSpeed / 100) as ResearchModifier, VIR_ResearchBonus.CommanderBonus, VIR_ResearchBonus.CommanderField, FCT_ResearchProject.ResSpecID as ProjectField, FCT_Anomalies.ResearchField as AnomalyField, FCT_Anomalies.ResearchBonus as AnomalyBonus from FCT_ResearchProject left join FCT_Game on FCT_ResearchProject.GameID = FCT_Game.GameID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as CommanderBonus, FCT_Commander.ResSpecID as CommanderField from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 3 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (3,4) and FCT_Commander.CommandType = 7 and FCT_Commander.CommandID <> 0) as VIR_ResearchBonus on VIR_ResearchBonus.CommandID = FCT_ResearchProject.ProjectID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join FCT_Race on FCT_ResearchProject.RaceID = FCT_Race.RaceID left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join DIM_PopPoliticalStatus on FCT_Population.PoliticalStatus = DIM_PopPoliticalStatus.StatusID left join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_Anomalies on FCT_SystemBody.SystemBodyID = FCT_Anomalies.SystemBodyID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}) as VIR_ResearchProjectsIntermediary) as VIR_ResearchProjects`).then(([ items ]) => {
          console.log('Research projects', items)

          return items
        })

        const projectMap = projects.reduce((map, project) => {
          map[project.ProjectID] = project

          return map
        }, {})

        return [...projects, ...queues.reduce((reduction, queue) => {
          const currentProject = projectMap[queue.CurrentProjectID]

          if (currentProject) {
            reduction.push({
              ID: `${currentProject.ProjectID}-${queue.ResearchOrder}`,
              PopName: currentProject.PopName,
              Name: queue.Name,
              Facilities: currentProject.Facilities,
              ResearchPointsRequired: queue.DevelopCost,
              AnnualProduction: currentProject.AnnualProduction,
              RemainingDays: queue.DevelopCost / (currentProject.AnnualProduction / 365),
              Queue: true,
            })
          }

          return reduction
        }, [])]
      },
      default: [],
    },
    ships: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        return await this.database.query(`select VIR_ShipyardTasks.TaskID as ID, VIR_ShipyardTasks.PopName, VIR_ShipyardTasks.TaskTypeID, VIR_ShipyardTasks.UnitName as Name, VIR_ShipyardTasks.ClassName, VIR_ShipyardTasks.Size, VIR_ShipyardTasks.Paused, VIR_ShipyardTasks.RemainingBP, (1 + (VIR_ShipyardTasks.Size * VIR_ShipyardTasks.CommercialModifier / 100 - 1) / 2) * VIR_ShipyardTasks.ShipyardBuildRate as AnnualProduction, VIR_ShipyardTasks.ShipyardBuildRate, VIR_ShipyardTasks.RemainingBP / (((1 + (VIR_ShipyardTasks.Size * VIR_ShipyardTasks.CommercialModifier / 100 - 1) / 2) * VIR_ShipyardTasks.ShipyardBuildRate) / 365) as RemainingDays from (select FCT_ShipyardTask.TaskID, FCT_Population.PopName, FCT_ShipyardTask.TaskTypeID, FCT_ShipyardTask.UnitName, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipyardTask.Paused, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingBP, (case when FCT_Shipyard.SYType = 1 then 1 else 0.25 end) as CommercialModifier, (1 - (FCT_SystemBody.RadiationLevel / 10000)) as RadiationProductionModifier, (1 - (FCT_Population.UnrestPoints / 100)) as PoliticalStabilityProductionModifier, 1 * FCT_Species.ProductionRateModifier * FCT_Race.ShipBuilding * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * (1 - (FCT_SystemBody.RadiationLevel / 10000)) * (1 - (FCT_Population.UnrestPoints / 100)) * DIM_PopPoliticalStatus.ProductionMod * COALESCE(VIR_PlanetaryProduction.PlanetaryProductionBonus, 1) * COALESCE(VIR_SectorProduction.SectorProductionBonus, 1) as ShipyardBuildRate, * from FCT_ShipyardTask left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as PlanetaryProductionBonus from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 4 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_PlanetaryProduction on VIR_PlanetaryProduction.CommandID = FCT_ShipyardTask.PopulationID left join (select FCT_Population.PopulationID, 1 + (COALESCE(FCT_CommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorProductionBonus from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 4 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID inner join FCT_RaceSysSurvey on FCT_Commander.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 inner join FCT_Population on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_SectorProduction on VIR_SectorProduction.PopulationID = FCT_ShipyardTask.PopulationID left join FCT_Race on FCT_ShipyardTask.RaceID = FCT_Race.RaceID left join FCT_Population on FCT_Population.PopulationID = FCT_ShipyardTask.PopulationID left join DIM_PopPoliticalStatus on FCT_Population.PoliticalStatus = DIM_PopPoliticalStatus.StatusID left join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID where FCT_ShipyardTask.GameID = ${this.GameID} and FCT_ShipyardTask.RaceID = ${this.RaceID}) as VIR_ShipyardTasks order by RemainingDays asc`).then(([ items ]) => {
          console.log('Ships', items)

          return items
        })
      },
      default: [],
    },
    production: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        return await this.database.query(`select VIR_IndustrialProjects.ProjectID as ID, VIR_IndustrialProjects.PopName, VIR_IndustrialProjects.Description as Name, VIR_IndustrialProjects.Percentage, VIR_IndustrialProjects.Amount, VIR_IndustrialProjects.Amount * VIR_IndustrialProjects.ProdPerUnit as RemainingProduction, VIR_IndustrialProjects.Queue, VIR_IndustrialProjects.Paused, VIR_IndustrialProjects.TotalPlanetaryProduction + VIR_IndustrialProjects.TotalGroundProduction as TotalAnnualProduction, (VIR_IndustrialProjects.TotalPlanetaryProduction + VIR_IndustrialProjects.TotalGroundProduction) * (VIR_IndustrialProjects.Percentage / 100) as AnnualProduction, (VIR_IndustrialProjects.Amount * VIR_IndustrialProjects.ProdPerUnit) / ((VIR_IndustrialProjects.TotalPlanetaryProduction + VIR_IndustrialProjects.TotalGroundProduction) * (VIR_IndustrialProjects.Percentage / 100) / 365) as RemainingDays from (select FCT_IndustrialProjects.ProjectID, FCT_Population.PopName, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause as Paused, COALESCE(FCT_Race.ConstructionProduction * COALESCE(VIR_PlanetaryProduction.PlanetaryProductionBonus, 1) * COALESCE(VIR_SectorProduction.SectorProductionBonus, 1) * FCT_Race.EconomicProdModifier * FCT_Species.ProductionRateModifier * (1 - (FCT_Population.UnrestPoints / 100)) * (1 - (FCT_SystemBody.RadiationLevel / 10000)) * DIM_PopPoliticalStatus.ProductionMod * FCT_Population.Efficiency * VIR_PlanetaryConstruction.ConstructionPower, 0) as TotalPlanetaryProduction, COALESCE(FCT_Race.ConstructionProduction * FCT_Race.EconomicProdModifier * (1 - (FCT_SystemBody.RadiationLevel / 10000)) * VIR_GroundPopulationConstruction.GroundConstructionRating, 0) as TotalGroundProduction from FCT_IndustrialProjects left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue as PlanetaryProductionBonus from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 5 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_PlanetaryProduction on VIR_PlanetaryProduction.CommandID = FCT_IndustrialProjects.PopulationID left join (select FCT_Population.PopulationID, 1 + (COALESCE(FCT_CommanderBonuses.BonusValue, 1) - 1) * 0.25 as SectorProductionBonus from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 5 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID inner join FCT_RaceSysSurvey on FCT_Commander.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 inner join FCT_Population on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_SectorProduction on VIR_SectorProduction.PopulationID = FCT_IndustrialProjects.PopulationID left join FCT_Race on FCT_IndustrialProjects.RaceID = FCT_Race.RaceID left join (select FCT_PopulationInstallations.PopID, SUM(DIM_PlanetaryInstallation.ConstructionValue * FCT_PopulationInstallations.Amount) as ConstructionPower from DIM_PlanetaryInstallation left join FCT_PopulationInstallations on FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID where DIM_PlanetaryInstallation.ConstructionValue > 0 group by FCT_PopulationInstallations.PopID) as VIR_PlanetaryConstruction on VIR_PlanetaryConstruction.PopID = FCT_IndustrialProjects.PopulationID left join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID left join DIM_PopPoliticalStatus on FCT_Population.PoliticalStatus = DIM_PopPoliticalStatus.StatusID left join (select FCT_GroundUnitFormation.PopulationID, SUM(VIR_FormationConstruction.FormationConstructionRating * COALESCE(FCT_CommanderBonuses.BonusValue, 1)) as GroundConstructionRating from FCT_GroundUnitFormation left join (select FCT_GroundUnitFormationElement.*, SUM(FCT_GroundUnitFormationElement.Units * FCT_GroundUnitClass.ConstructionRating) as FormationConstructionRating from FCT_GroundUnitFormationElement left join FCT_GroundUnitClass on FCT_GroundUnitFormationElement.ClassID = FCT_GroundUnitClass.GroundUnitClassID group by FCT_GroundUnitFormationElement.FormationID) as VIR_FormationConstruction on FCT_GroundUnitFormation.FormationID = VIR_FormationConstruction.FormationID left join FCT_Commander on FCT_Commander.CommandID = FCT_GroundUnitFormation.FormationID and FCT_Commander.CommanderType in (1,4) and FCT_Commander.CommandType = 5 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 5 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID group by FCT_GroundUnitFormation.PopulationID) as VIR_GroundPopulationConstruction on VIR_GroundPopulationConstruction.PopulationID = FCT_IndustrialProjects.PopulationID where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID}) as VIR_IndustrialProjects order by VIR_IndustrialProjects.Queue asc, RemainingDays asc`).then(([ items ]) => {
          console.log('Industrial Production', items)

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
