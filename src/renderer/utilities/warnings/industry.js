import { linkTo } from '../deep-links'
import { roundToDecimal } from '../math'
import { MINERALS, projectShortages } from '../minerals'
import { amount, colonyText, COLONY_COLUMNS, COLONY_JOINS, rowsOf } from './common'

export const group = { key: 'industry', title: 'Industry', summary: 'Idle factory capacity, stalled projects and unused shipyards, so it is clear where industry is not producing what it could.' }

const PRODUCTION_KINDS = { 1: 'Ordnance', 2: 'Fighters' }

// `FCT_Shipyard.TaskType`: what a yard is busy modifying; 0 is nothing.
const SHIPYARD_ACTIVITIES = {
  1: 'Adding a slipway',
  2: 'Adding 500 tons of capacity',
  3: 'Adding 1,000 tons of capacity',
  4: 'Adding 2,000 tons of capacity',
  5: 'Adding 5,000 tons of capacity',
  6: 'Adding 10,000 tons of capacity',
  7: 'Retooling',
  8: 'Continual capacity upgrade',
  9: 'Spacemaster modification',
}

// A colony with some capacity that its projects of one kind leave unshared. `value` names the installation value that makes the capacity, `alias` the total of those installations, and `types` the project types sharing it.
const freeCapacityQuery = ({ GameID, RaceID }, { value, alias, types }) => `select VIR_Capacity.*, 100 - COALESCE(SUM(FCT_IndustrialProjects.Percentage), 0) as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, SUM(FCT_PopulationInstallations.Amount) as ${alias}, ${COLONY_COLUMNS} from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.${value} > 0 GROUP BY FCT_Population.PopulationID) as VIR_Capacity left join FCT_IndustrialProjects on VIR_Capacity.PopulationID = FCT_IndustrialProjects.PopulationID and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType ${types} group by VIR_Capacity.PopulationID having FreePercentage > 0`

const freeCapacityRows = (ctx, populations, alias) => populations.map((population) => ({
  id: `colony:${population.PopulationID}`,
  cells: {
    colony: colonyText(population),
    installations: ctx.count(population[alias]),
    free: `${roundToDecimal(population.FreePercentage, 4)}%`,
  },
  link: linkTo.production(population.PopulationID),
}))

const freeCapacityColumns = (installations) => [
  { key: 'colony', text: 'Colony' },
  { key: 'installations', text: installations, align: 'end' },
  { key: 'free', text: 'Free', align: 'end' },
]

const projectKind = (project) => PRODUCTION_KINDS[project.ProductionType] || 'Construction'

export const checks = [
  {
    key: 'free-construction-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'population')} with free construction capacity`,
    rule: 'A colony has construction factories while the industrial projects it is building (not queued) take under 100% of its construction capacity.',
    columns: freeCapacityColumns('Factories'),
    async read(ctx) {
      const populations = await rowsOf(ctx, freeCapacityQuery(ctx, { value: 'ConstructionValue', alias: 'ConstructionAmount', types: 'IN (0,3,4)' }))

      return freeCapacityRows(ctx, populations.filter((population) => population.FreePercentage > 0.00006), 'ConstructionAmount')
    },
  },
  {
    key: 'free-ordnance-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'population')} with free ordnance production capacity`,
    rule: 'A colony has ordnance factories while the ordnance projects it is building (not queued) take under 100% of its ordnance capacity.',
    columns: freeCapacityColumns('Factories'),
    async read(ctx) {
      const populations = await rowsOf(ctx, freeCapacityQuery(ctx, { value: 'OrdnanceProductionValue', alias: 'OrdnanceProductionAmount', types: '= 1' }))

      return freeCapacityRows(ctx, populations, 'OrdnanceProductionAmount')
    },
  },
  {
    key: 'free-fighter-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'population')} with free fighter production capacity`,
    rule: 'A colony has fighter factories while the fighter projects it is building (not queued) take under 100% of its fighter capacity.',
    columns: freeCapacityColumns('Factories'),
    async read(ctx) {
      const populations = await rowsOf(ctx, freeCapacityQuery(ctx, { value: 'FighterProductionValue', alias: 'FighterProductionAmount', types: '= 2' }))

      return freeCapacityRows(ctx, populations, 'FighterProductionAmount')
    },
  },
  {
    key: 'idle-ground-training',
    group: group.key,
    severity: 'info',
    title: (count) => `${amount(count, 'population')} with idle ground training capacity`,
    rule: 'A colony with people on it has ground force construction complexes staffed at its efficiency while the ground unit training tasks under way (not queued) take under 100% of that capacity, so the rest trains nothing; a colony with no training task at all counts as fully idle.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installed', text: 'GFCCs installed', align: 'end' },
      { key: 'staffed', text: 'GFCCs staffed', align: 'end' },
      { key: 'allocated', text: 'Allocated', align: 'end' },
      { key: 'idle', text: 'GFCCs unallocated', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select VIR_Training.*, VIR_Training.Staffed * (100 - min(100, VIR_Training.Allocated)) / 100 as Unallocated from (select FCT_Population.PopulationID, FCT_Population.PopName, VIR_Complexes.Installed, VIR_Complexes.Installed * min(1, FCT_Population.Efficiency) as Staffed, coalesce(VIR_Tasks.Allocated, 0) as Allocated, coalesce(VIR_Tasks.Tasks, 0) as Tasks, coalesce(VIR_Queue.Queued, 0) as Queued, ${COLONY_COLUMNS} from FCT_Population inner join (select VIR_Types.PopID, SUM(VIR_Types.Amount * DIM_PlanetaryInstallation.GroundTrainingValue) as Installed from (select FCT_PopulationInstallations.PopID, FCT_PopulationInstallations.PlanetaryInstallationID, MAX(FCT_PopulationInstallations.Amount) as Amount from FCT_PopulationInstallations where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID, FCT_PopulationInstallations.PlanetaryInstallationID) as VIR_Types inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = VIR_Types.PlanetaryInstallationID where DIM_PlanetaryInstallation.GroundTrainingValue > 0 group by VIR_Types.PopID) as VIR_Complexes on VIR_Complexes.PopID = FCT_Population.PopulationID left join (select FCT_GroundUnitTraining.PopulationID, SUM(FCT_GroundUnitTraining.TaskPercentage) as Allocated, COUNT(*) as Tasks from FCT_GroundUnitTraining where FCT_GroundUnitTraining.GameID = ${GameID} and FCT_GroundUnitTraining.RaceID = ${RaceID} group by FCT_GroundUnitTraining.PopulationID) as VIR_Tasks on VIR_Tasks.PopulationID = FCT_Population.PopulationID left join (select FCT_GroundUnitTrainingQueue.PopulationID, COUNT(*) as Queued from FCT_GroundUnitTrainingQueue where FCT_GroundUnitTrainingQueue.GameID = ${GameID} group by FCT_GroundUnitTrainingQueue.PopulationID) as VIR_Queue on VIR_Queue.PopulationID = FCT_Population.PopulationID ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Population > 0) as VIR_Training where VIR_Training.Staffed * (100 - min(100, VIR_Training.Allocated)) / 100 > 0.005 order by Unallocated desc, VIR_Training.PopName`)

      return populations.map((population) => ({
        id: `colony:${population.PopulationID}`,
        cells: {
          colony: colonyText(population),
          installed: ctx.count(population.Installed, 1),
          staffed: ctx.count(population.Staffed, 1),
          allocated: `${ctx.count(Math.min(100, population.Allocated), 1)}%`,
          idle: ctx.count(population.Unallocated, 1),
        },
        caption: [population.Tasks ? amount(population.Tasks, 'training task') : 'No training task', population.Queued ? `${amount(population.Queued, 'formation')} queued` : ''].filter(Boolean).join(' · '),
        link: linkTo.production(population.PopulationID),
      }))
    },
  },
  {
    key: 'paused-industrial-projects',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'paused industrial project'),
    rule: 'An industrial project is paused: it keeps its share of the colony\'s capacity and builds nothing.',
    columns: [
      { key: 'project', text: 'Project' },
      { key: 'kind', text: 'Capacity' },
      { key: 'share', text: 'Share', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const projects = await rowsOf(ctx, `select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Percentage, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID ${COLONY_JOINS} where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and FCT_IndustrialProjects.Pause = 1 order by FCT_Population.PopName, FCT_IndustrialProjects.Description`)

      return projects.map((project) => ({
        id: `project:${project.ProjectID}`,
        cells: { project: project.Description, kind: projectKind(project), share: `${roundToDecimal(project.Percentage, 2)}%` },
        caption: colonyText(project),
        link: linkTo.production(project.PopulationID),
      }))
    },
  },
  {
    key: 'projects-short-of-minerals',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'industrial project')} short of minerals`,
    rule: 'A project that is building (not paused or queued) needs more of a mineral or of fuel than its colony holds for the units it has left; each project is checked against the colony\'s whole stock, and a spied empire is skipped because it builds from its capital\'s stock.',
    columns: [
      { key: 'project', text: 'Project' },
      { key: 'short', text: 'Short of' },
      { key: 'covered', text: 'Stock covers', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      if (ctx.RaceNPR) {
        return []
      }

      const needs = MINERALS.map((mineral) => `FCT_IndustrialProjects.${mineral.name}`).join(', ')
      const stocks = MINERALS.map((mineral) => `FCT_Population.${mineral.name} as Stock${mineral.name}`).join(', ')

      const projects = await rowsOf(ctx, `select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.FuelRequired, ${needs}, ${stocks}, FCT_Population.FuelStockpile as StockFuel, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID ${COLONY_JOINS} where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.Pause = 0 order by FCT_Population.PopName, FCT_IndustrialProjects.Description`)

      return projects.flatMap((project) => {
        const short = projectShortages(project)

        if (!short.length) {
          return []
        }

        const [limit] = short

        return [{
          id: `project:${project.ProjectID}`,
          cells: {
            project: project.Description,
            short: short.map((item) => item.name).join(', '),
            covered: `${ctx.count(Math.max(0, limit.covered), 1)} of ${ctx.count(project.Amount, 1)}`,
          },
          caption: colonyText(project),
          link: short.length === 1 && short[0].mineralId ? linkTo.mineralOutlook(short[0].mineralId) : linkTo.production(project.PopulationID),
        }]
      })
    },
  },
  {
    key: 'idle-slipways',
    group: group.key,
    severity: 'info',
    title: (count) => `${amount(count, 'shipyard')} with idle slipways`,
    rule: 'A shipyard has more slipways than shipyard tasks, so the slipways without a task build nothing.',
    columns: [
      { key: 'shipyard', text: 'Shipyard' },
      { key: 'slipways', text: 'Idle slipways', align: 'end' },
      { key: 'capacity', text: 'Capacity', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const shipyards = await rowsOf(ctx, `select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.TaskType, (select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID) as Tasks, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_Shipyard inner join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID ${COLONY_JOINS} where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID} and FCT_Shipyard.Slipways > (select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID) order by FCT_Population.PopName, FCT_Shipyard.ShipyardName`)

      return shipyards.map((shipyard) => ({
        id: `shipyard:${shipyard.ShipyardID}`,
        cells: {
          shipyard: shipyard.ShipyardName,
          slipways: `${ctx.count(shipyard.Slipways - shipyard.Tasks)} of ${ctx.count(shipyard.Slipways)}`,
          capacity: `${ctx.count(shipyard.Capacity)} t`,
        },
        caption: [colonyText(shipyard), SHIPYARD_ACTIVITIES[shipyard.TaskType]].filter(Boolean).join(' · '),
        link: linkTo.production(shipyard.PopulationID),
      }))
    },
  },
  {
    key: 'obsolete-shipyards',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'shipyard')} tooled to an obsolete class`,
    rule: 'A shipyard is set to build a ship class that is marked obsolete.',
    columns: [
      { key: 'shipyard', text: 'Shipyard' },
      { key: 'class', text: 'Builds' },
      { key: 'slipways', text: 'Slipways', align: 'end' },
      { key: 'capacity', text: 'Capacity', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const shipyards = await rowsOf(ctx, `select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_ShipClass.ClassName, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Population.PopName from FCT_Shipyard left join FCT_ShipClass on FCT_Shipyard.BuildClassID = FCT_ShipClass.ShipClassID left join FCT_Population on FCT_Shipyard.PopulationID = FCT_Population.PopulationID where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID} and FCT_ShipClass.Obsolete = 1 order by FCT_Shipyard.Capacity * FCT_Shipyard.Slipways desc`)

      return shipyards.map((shipyard) => ({
        id: `shipyard:${shipyard.ShipyardID}`,
        cells: {
          shipyard: shipyard.ShipyardName,
          class: `${shipyard.ClassName} Class`,
          slipways: ctx.count(shipyard.Slipways),
          capacity: `${ctx.count(shipyard.Capacity)} t`,
        },
        caption: shipyard.PopName || undefined,
        link: shipyard.PopulationID ? linkTo.production(shipyard.PopulationID) : undefined,
      }))
    },
  },
]
