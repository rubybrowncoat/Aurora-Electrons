import { linkTo } from '../deep-links'
import { amount, colonyText, COLONY_COLUMNS, COLONY_JOINS, rowsOf } from './common'

export const group = { key: 'research', title: 'Research', summary: 'Idle labs, dead or forgotten projects and scientists working outside their field, so the race\'s research makes full use of what it has.' }

export const checks = [
  {
    key: 'idle-research-labs',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'colony with idle research labs', 'colonies with idle research labs'),
    rule: 'A colony has more research facilities than its projects use, so some labs sit idle.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'labs', text: 'Labs', align: 'end' },
      { key: 'used', text: 'In use', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as AvailableFacilities, coalesce(VIR_PopulationResearch.Facilities, 0) as OccupiedFacilities, ${COLONY_COLUMNS} from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID ${COLONY_JOINS} left join (select FCT_ResearchProject.PopulationID, SUM("FCT_ResearchProject"."Facilities") as "Facilities" from FCT_ResearchProject where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} group by "FCT_ResearchProject"."PopulationID") as VIR_PopulationResearch on FCT_Population.PopulationID = VIR_PopulationResearch.PopulationID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.ResearchValue > 0 GROUP BY FCT_Population.PopulationID having AvailableFacilities > OccupiedFacilities`)

      return populations.map((population) => ({
        id: `colony:${population.PopulationID}`,
        cells: {
          colony: colonyText(population),
          labs: ctx.count(population.AvailableFacilities),
          used: ctx.count(population.OccupiedFacilities),
        },
        link: linkTo.techTree(),
      }))
    },
  },
  {
    key: 'dead-research-projects',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'dead research project'),
    rule: 'A colony has a research project but its labs add up to no research, so the project never advances.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'project', text: 'Project' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select VIR_ResearchProductionPopulation.*, FCT_TechSystem.Name as ResearchName from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as ResearchProductionAmount, ${COLONY_COLUMNS} from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.ResearchValue > 0 GROUP BY FCT_Population.PopulationID) as VIR_ResearchProductionPopulation left join FCT_ResearchProject on VIR_ResearchProductionPopulation.PopulationID = FCT_ResearchProject.PopulationID left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID where ResearchName is not null group by VIR_ResearchProductionPopulation.PopulationID having SUM(VIR_ResearchProductionPopulation.ResearchProductionAmount) = 0`)

      return populations.map((population) => ({
        id: `colony:${population.PopulationID}`,
        cells: {
          colony: colonyText(population),
          project: population.ResearchName,
        },
        link: linkTo.techTree(),
      }))
    },
  },
  {
    key: 'forgotten-prototypes',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'research prototype') + ' with no project',
    rule: 'A component is marked for research but no lab is researching it and no colony has it queued.',
    columns: [
      { key: 'component', text: 'Component' },
      { key: 'type', text: 'Type' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const components = await rowsOf(ctx, `select FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, DIM_ComponentType.TypeDescription from FCT_RaceTech inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID left join DIM_ComponentType on DIM_ComponentType.ComponentTypeID = FCT_ShipDesignComponents.ComponentTypeID where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID} and FCT_ShipDesignComponents.Prototype = 3 and not exists (select 1 from FCT_ResearchProject where FCT_ResearchProject.TechID = FCT_RaceTech.TechID and FCT_ResearchProject.RaceID = FCT_RaceTech.RaceID and FCT_ResearchProject.GameID = FCT_RaceTech.GameID) and not exists (select 1 from FCT_ResearchQueue inner join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID where FCT_ResearchQueue.TechSystemID = FCT_RaceTech.TechID and FCT_ResearchQueue.GameID = FCT_RaceTech.GameID and FCT_Population.RaceID = FCT_RaceTech.RaceID) order by FCT_ShipDesignComponents.Name`)

      return components.map((component) => ({
        id: `component:${component.SDComponentID}`,
        cells: {
          component: component.Name,
          type: component.TypeDescription,
        },
        link: linkTo.techTree(),
      }))
    },
  },
  {
    key: 'mismatched-research-fields',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'researcher') + ' with mismatched projects',
    rule: 'A scientist leads a project outside their own research field.',
    columns: [
      { key: 'commander', text: 'Researcher' },
      { key: 'project', text: 'Project' },
      { key: 'field', text: 'Project field' },
      { key: 'specialty', text: 'Specialty' },
      { key: 'points', text: 'RP required', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const scientists = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, ${COLONY_COLUMNS}, FCT_Commander.CommanderID, FCT_Commander.Name as CommanderName, DIM_ResearchField_2.FieldName as CommanderFieldName, FCT_TechSystem.Name as ResearchName, DIM_ResearchField.FieldName, FCT_ResearchProject.ResearchPointsRequired from FCT_ResearchProject inner join FCT_Population on FCT_ResearchProject.PopulationID = FCT_Population.PopulationID ${COLONY_JOINS} left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join DIM_TechType on FCT_TechSystem.TechTypeID = DIM_TechType.TechTypeID left join DIM_ResearchField on DIM_TechType.FieldID = DIM_ResearchField.ResearchFieldID left join FCT_Commander on FCT_ResearchProject.ProjectID = FCT_Commander.CommandID and FCT_Commander.CommanderType = 3 left join DIM_ResearchField as DIM_ResearchField_2 on FCT_Commander.ResSpecID = DIM_ResearchField_2.ResearchFieldID where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} and DIM_ResearchField.ResearchFieldID != DIM_ResearchField_2.ResearchFieldID`)

      return scientists.map((scientist) => ({
        id: `commander:${scientist.CommanderID}`,
        cells: {
          commander: scientist.CommanderName,
          project: scientist.ResearchName,
          field: scientist.FieldName,
          specialty: scientist.CommanderFieldName,
          points: ctx.count(scientist.ResearchPointsRequired, 1),
        },
        caption: colonyText(scientist),
        link: linkTo.commanders({ commander: scientist.CommanderID }),
      }))
    },
  },
]
