import { linkTo } from '../deep-links'
import { isKnownNumber, roundToDecimal } from '../math'
import { MINERALS, projectShortages, wholeCapacity } from '../minerals'
import { capacityTerms } from '../mining-data'
import { capacityKind, typesOf } from '../production-types'
import { GFCC_INSTALLATION } from '../production'
import { QUARTER, allOf, amount, bandOf, bandWords, categoriesOf, checksOf, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, listWords, rowsOf, signatureOf, unknownCell, verdictRows } from './common'

export const group = { key: 'industry', title: 'Industry', summary: 'Review idle factory capacity, stalled projects and unused shipyards.' }

// The capacity kind of a project as the paused projects list names it (`capacityKind` of utilities/production-types.js): the Ordnance Projects draw on ordnance capacity, the Engineering and Ground Unit Projects on construction.
const PRODUCTION_KINDS = { ordnance: 'Ordnance', fighter: 'Light Naval', construction: 'Construction' }

// The types of one capacity as the list of a SQL `in (...)`, from the one table of types.
const typesClause = (kind) => `IN (${typesOf(kind).join(',')})`

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

const FACTORY_TYPE = 'the type of an installation of the colony'
const FACTORY_AMOUNT = 'the amount of a factory of the colony'
const PROJECT_SHARE = 'the share, queue state or type of an industrial project of the colony'

// Acquire each known amount and weight independently for the decimal whole-category count, keeping type and amount gaps separately. A known productive subtotal can prove capacity exists despite a gap, but never supplies a complete displayed count. Project shares and queue/type gaps retain their three-valued verdict.
const freeCapacityQuery = ({ GameID, RaceID }, { value, types }) => {
  const project = `(FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType ${types})`

  return `select VIR_Capacity.*, case when sum(case when FCT_IndustrialProjects.ProjectID is null then 0 when ${project} is null then 1 when ${project} = 1 and FCT_IndustrialProjects.Percentage is null then 1 else 0 end) > 0 then null else 100 - COALESCE(SUM(case when ${project} then FCT_IndustrialProjects.Percentage else 0 end), 0) end as FreePercentage from (select FCT_Population.PopulationID, FCT_Population.PopName, ${capacityTerms(`DIM_PlanetaryInstallation.${value}`, `DIM_PlanetaryInstallation.${value} is not null and DIM_PlanetaryInstallation.${value} > 0 and FCT_PopulationInstallations.Amount is not null`)} as CapacityTerms, sum(case when DIM_PlanetaryInstallation.${value} is null then 1 else 0 end) as TypeGaps, sum(case when DIM_PlanetaryInstallation.${value} > 0 and FCT_PopulationInstallations.Amount is null then 1 else 0 end) as AmountGaps, ${COLONY_COLUMNS} from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (DIM_PlanetaryInstallation.${value} > 0 or DIM_PlanetaryInstallation.${value} is null) GROUP BY FCT_Population.PopulationID) as VIR_Capacity left join FCT_IndustrialProjects on VIR_Capacity.PopulationID = FCT_IndustrialProjects.PopulationID group by VIR_Capacity.PopulationID order by VIR_Capacity.PopulationID`
}

const freeCapacityRows = (ctx, populations, alias, minimum = 0) => verdictRows(ctx, populations.map((population) => {
  const capacity = wholeCapacity(null, population.CapacityTerms)
  const gaps = population.TypeGaps > 0 || population.AmountGaps > 0

  return { ...population, [alias]: gaps ? null : capacity, Verdict: allOf(capacity > 0 ? 1 : gaps ? null : 0, isKnownNumber(population.FreePercentage) ? population.FreePercentage > minimum : null) }
}), {
  missing: (population) => [...(population[alias] > 0 ? [] : [...(population.TypeGaps > 0 ? [FACTORY_TYPE] : []), ...(population.AmountGaps > 0 ? [FACTORY_AMOUNT] : [])]), ...(population.FreePercentage === null ? [PROJECT_SHARE] : [])],
  build: (population) => ({
    id: `colony:${population.PopulationID}`,
    cells: {
      colony: colonyText(population),
      installations: population.AmountGaps > 0 ? unknownCell(ctx, [FACTORY_AMOUNT]) : population.TypeGaps > 0 ? unknownCell(ctx, [FACTORY_TYPE]) : figure(ctx, population[alias], FACTORY_AMOUNT),
      free: figure(ctx, population.FreePercentage, PROJECT_SHARE, (known) => `${roundToDecimal(known, 4)}%`),
    },
    link: linkTo.production(population.PopulationID),
    signature: signatureOf(bandOf(isKnownNumber(population.FreePercentage) ? population.FreePercentage / 100 : null, [QUARTER])),
  }),
})

const freeCapacityColumns = (installations) => [
  { key: 'colony', text: 'Colony' },
  { key: 'installations', text: installations, align: 'end' },
  { key: 'free', text: 'Free', align: 'end' },
]

const FREE_CAPACITY_STRUCTURE = ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation capacity values', 'FCT_IndustrialProjects.Percentage, Queue, ProductionType']

const freeCapacityNote = (kind) => `A colony with ${kind} installations whose amounts and weights are converted to decimal individually and summed before taking the whole productive count, and whose nonqueued projects hold less than 100% by their stored shares. Fractional inventory below a whole category unit produces no capacity. The displayed factory count is the effective category count, not raw installed inventory; any unread amount or weight leaves that count unknown. A missing type, amount or project share is reported as not evaluated unless known productive installations already prove capacity exists.`

const projectKind = (project) => (project.ProductionType === null || project.ProductionType === undefined ? null : PRODUCTION_KINDS[capacityKind(project.ProductionType)])

const PROJECT_RUNNING = '(FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.Pause = 0)'

const PROJECT_PAUSED = '(FCT_IndustrialProjects.Pause = 1)'

// A running project with a shortage: the shortages of what is known, as `projectShortages` gives them, and what is not known. The stock is not known when the colony's column is empty, and a need that is not stored may or may not be one, so a project with one and no known shortage can't be judged; the units left are needed for every comparison.
const shortageOf = (project) => {
  const missing = []

  if (!isKnownNumber(project.Amount)) {
    return { short: [], missing: ['the units the project has left'] }
  }

  const known = { ...project }

  MINERALS.forEach((mineral) => {
    if (!isKnownNumber(project[mineral.name])) {
      missing.push(`the ${mineral.name} the project needs per unit`)
      known[mineral.name] = 0
    } else if (project[mineral.name] > 0 && !isKnownNumber(project[`Stock${mineral.name}`])) {
      missing.push(`the colony's ${mineral.name} stock`)
      known[mineral.name] = 0
    }
  })

  if (!isKnownNumber(project.FuelRequired)) {
    missing.push('the fuel the project needs per unit')
    known.FuelRequired = 0
  } else if (project.FuelRequired > 0 && !isKnownNumber(project.StockFuel)) {
    missing.push('the colony\'s fuel stock')
    known.FuelRequired = 0
  }

  return { short: projectShortages(known), missing }
}

export const checks = checksOf([
  {
    key: 'free-construction-capacity',
    group: group.key,
    severity: 'attention',
    material: 'the free share crossing 25% of the capacity',
    captured: [bandWords('free share under 25% of the capacity', 'free share at 25% or more of the capacity')],
    title: (count) => `${amount(count, 'population')} with free construction capacity`,
    rule: 'A colony has construction factories while the industrial projects it is building (not queued) take under 100% of its construction capacity.',
    evidence: {
      verification: 'estimated',
      versions: ['3.2.x'],
      structure: FREE_CAPACITY_STRUCTURE,
      note: freeCapacityNote('construction'),
      assumptions: ['A free share of more than 0.00006% of the capacity counts as free; smaller remainders are rounding.'],
    },
    columns: freeCapacityColumns('Factories'),
    async read(ctx) {
      const populations = await rowsOf(ctx, freeCapacityQuery(ctx, { value: 'ConstructionValue', types: typesClause('construction') }))

      return freeCapacityRows(ctx, populations, 'ConstructionAmount', 0.00006)
    },
  },
  {
    key: 'free-ordnance-capacity',
    group: group.key,
    severity: 'attention',
    material: 'the free share crossing 25% of the capacity',
    captured: [bandWords('free share under 25% of the capacity', 'free share at 25% or more of the capacity')],
    title: (count) => `${amount(count, 'population')} with free ordnance production capacity`,
    rule: 'A colony has ordnance factories while the ordnance projects it is building (not queued) take under 100% of its ordnance capacity.',
    evidence: {
      verification: 'estimated',
      versions: ['3.2.x'],
      structure: FREE_CAPACITY_STRUCTURE,
      note: freeCapacityNote('ordnance'),
    },
    columns: freeCapacityColumns('Factories'),
    async read(ctx) {
      const populations = await rowsOf(ctx, freeCapacityQuery(ctx, { value: 'OrdnanceProductionValue', types: typesClause('ordnance') }))

      return freeCapacityRows(ctx, populations, 'OrdnanceProductionAmount')
    },
  },
  {
    key: 'free-fighter-capacity',
    group: group.key,
    severity: 'attention',
    material: 'the free share crossing 25% of the capacity',
    captured: [bandWords('free share under 25% of the capacity', 'free share at 25% or more of the capacity')],
    title: (count) => `${amount(count, 'population')} with free light naval production capacity`,
    rule: 'A colony has light naval factories while the light naval projects it is building (not queued) take under 100% of its light naval capacity.',
    evidence: {
      verification: 'estimated',
      versions: ['3.2.x'],
      structure: FREE_CAPACITY_STRUCTURE,
      note: freeCapacityNote('light naval'),
    },
    columns: freeCapacityColumns('Factories'),
    async read(ctx) {
      const populations = await rowsOf(ctx, freeCapacityQuery(ctx, { value: 'FighterProductionValue', types: typesClause('fighter') }))

      return freeCapacityRows(ctx, populations, 'FighterProductionAmount')
    },
  },
  {
    key: 'idle-ground-training',
    group: group.key,
    severity: 'info',
    material: 'the unallocated share crossing 25% of the capacity',
    captured: [bandWords('unallocated share under 25% of the capacity', 'unallocated share at 25% or more of the capacity')],
    title: (count) => `${amount(count, 'population')} with idle ground training capacity`,
    rule: 'A colony with people has a positive whole ground force construction complex count, scaled by efficiency, while its nonqueued training tasks leave capacity unallocated.',
    evidence: {
      verification: 'estimated',
      versions: ['3.2.x'],
      structure: ['FCT_PopulationInstallations.Amount', 'FCT_Population.Efficiency, Population', 'FCT_GroundUnitTraining.TaskPercentage'],
      note: 'Only ground force construction complexes (installation type 17) count. Their installed amount is converted to decimal and floored before multiplying by efficiency and the unallocated share. Raw fractional inventory is shown separately and does not imply productive capacity. Missing count, efficiency, population or task share leaves the condition unevaluated.',
      assumptions: ['The warning uses efficiency-scaled complex equivalents, not a full build-point rate; a remainder above 0.005 equivalents is idle, and a colony with no people is excluded.'],
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installed', text: 'GFCCs installed (raw)', align: 'end' },
      { key: 'staffed', text: 'GFCC equivalents', align: 'end' },
      { key: 'allocated', text: 'Allocated', align: 'end' },
      { key: 'idle', text: 'GFCCs unallocated', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const INSTALLED = 'the amount of a ground force construction complex'
      const EFFICIENCY = 'the colony\'s efficiency'
      const ALLOCATED = 'the share of a ground unit training task'

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Efficiency, VIR_Complexes.Installed, VIR_Complexes.Types, VIR_Complexes.TypeGaps, (case when VIR_Tasks.Gaps > 0 then null else coalesce(VIR_Tasks.Allocated, 0) end) as Allocated, coalesce(VIR_Tasks.Tasks, 0) as Tasks, coalesce(VIR_Queue.Queued, 0) as Queued, ${COLONY_COLUMNS} from FCT_Population inner join (select VIR_Types.PopID, case when sum(case when VIR_Types.PlanetaryInstallationID is null or (VIR_Types.PlanetaryInstallationID = ${GFCC_INSTALLATION} and VIR_Types.Amount is null) then 1 else 0 end) > 0 then null else SUM(case when VIR_Types.PlanetaryInstallationID = ${GFCC_INSTALLATION} then VIR_Types.Amount else 0 end) end as Installed, sum(case when VIR_Types.PlanetaryInstallationID = ${GFCC_INSTALLATION} then 1 else 0 end) as Types, sum(case when VIR_Types.PlanetaryInstallationID is null then 1 else 0 end) as TypeGaps from (select FCT_PopulationInstallations.PopID, FCT_PopulationInstallations.PlanetaryInstallationID, MAX(FCT_PopulationInstallations.Amount) as Amount from FCT_PopulationInstallations where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID, FCT_PopulationInstallations.PlanetaryInstallationID) as VIR_Types where (VIR_Types.PlanetaryInstallationID = ${GFCC_INSTALLATION} or VIR_Types.PlanetaryInstallationID is null) group by VIR_Types.PopID) as VIR_Complexes on VIR_Complexes.PopID = FCT_Population.PopulationID left join (select FCT_GroundUnitTraining.PopulationID, SUM(FCT_GroundUnitTraining.TaskPercentage) as Allocated, sum(case when FCT_GroundUnitTraining.TaskPercentage is null then 1 else 0 end) as Gaps, COUNT(*) as Tasks from FCT_GroundUnitTraining where FCT_GroundUnitTraining.GameID = ${GameID} and FCT_GroundUnitTraining.RaceID = ${RaceID} group by FCT_GroundUnitTraining.PopulationID) as VIR_Tasks on VIR_Tasks.PopulationID = FCT_Population.PopulationID left join (select FCT_GroundUnitTrainingQueue.PopulationID, COUNT(*) as Queued from FCT_GroundUnitTrainingQueue where FCT_GroundUnitTrainingQueue.GameID = ${GameID} group by FCT_GroundUnitTrainingQueue.PopulationID) as VIR_Queue on VIR_Queue.PopulationID = FCT_Population.PopulationID ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_Population.Population > 0) is not 0 order by FCT_Population.PopName`)

      const training = populations.map((population) => {
        const Staffed = isKnownNumber(population.Installed) && isKnownNumber(population.Efficiency) ? wholeCapacity(population.Installed) * population.Efficiency : null
        const Unallocated = isKnownNumber(Staffed) && isKnownNumber(population.Allocated) ? Staffed * (100 - Math.min(100, population.Allocated)) / 100 : null

        return { ...population, Staffed, Unallocated, Verdict: allOf(population.Types > 0 ? 1 : population.TypeGaps > 0 ? null : 0, isKnownNumber(population.Population) ? population.Population > 0 : null, isKnownNumber(Unallocated) ? Unallocated > 0.005 : null) }
      }).sort((a, b) => (b.Unallocated ?? -Infinity) - (a.Unallocated ?? -Infinity))

      return verdictRows(ctx, training, {
        missing: (population) => [
          ...(!(population.TypeGaps > 0) ? [] : ['the type of an installation of the colony']),
          ...lacking(population, { Population: 'the colony\'s population', Efficiency: EFFICIENCY }),
          ...(isKnownNumber(population.Installed) || population.TypeGaps > 0 ? [] : [INSTALLED]),
          ...(isKnownNumber(population.Allocated) ? [] : [ALLOCATED]),
        ],
        build: (population) => {
          const staffed = isKnownNumber(population.Efficiency) ? INSTALLED : EFFICIENCY

          return {
            id: `colony:${population.PopulationID}`,
            cells: {
              colony: colonyText(population),
              installed: figure(ctx, population.Installed, INSTALLED, (known) => ctx.count(known, 1)),
              staffed: figure(ctx, population.Staffed, staffed, (known) => ctx.count(known, 1)),
              allocated: figure(ctx, population.Allocated, ALLOCATED, (known) => `${ctx.count(Math.min(100, known), 1)}%`),
              idle: isKnownNumber(population.Unallocated) ? ctx.count(population.Unallocated, 1) : unknownCell(ctx, [...(isKnownNumber(population.Staffed) ? [] : [staffed]), ...(isKnownNumber(population.Allocated) ? [] : [ALLOCATED])]),
            },
            caption: [population.Tasks ? amount(population.Tasks, 'training task') : 'No training task', population.Queued ? `${amount(population.Queued, 'formation')} queued` : ''].filter(Boolean).join(' · '),
            link: linkTo.production(population.PopulationID),
            signature: signatureOf(bandOf(isKnownNumber(population.Allocated) ? (100 - Math.min(100, population.Allocated)) / 100 : null, [QUARTER])),
          }
        },
      })
    },
  },
  {
    key: 'paused-industrial-projects',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'paused industrial project'),
    rule: 'An industrial project is paused: it keeps its share of the colony\'s capacity and builds nothing.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_IndustrialProjects.Pause, Percentage, ProductionType'],
      note: 'A presence check on a stored flag; the share and the capacity kind are stored values. A project whose paused flag is not stored is listed apart, as not evaluated; a share or kind not stored shows a dash.',
    },
    columns: [
      { key: 'project', text: 'Project' },
      { key: 'kind', text: 'Capacity' },
      { key: 'share', text: 'Share', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const projects = await rowsOf(ctx, `select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Pause, ${PROJECT_PAUSED} as Verdict, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID ${COLONY_JOINS} where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and ${PROJECT_PAUSED} is not 0 order by FCT_Population.PopName, FCT_IndustrialProjects.Description`)

      return verdictRows(ctx, projects, {
        missing: (project) => lacking(project, { Pause: 'whether the project is paused' }),
        build: (project) => {
          const kind = projectKind(project)

          return {
            id: `project:${project.ProjectID}`,
            cells: {
              project: project.Description,
              kind: kind || unknownCell(ctx, ['the capacity kind of the project']),
              share: figure(ctx, project.Percentage, 'the share of the colony\'s capacity the project takes', (known) => `${roundToDecimal(known, 2)}%`),
            },
            caption: colonyText(project),
            link: linkTo.production(project.PopulationID),
          }
        },
      })
    },
  },
  {
    key: 'projects-short-of-minerals',
    group: group.key,
    severity: 'attention',
    material: 'another mineral being short',
    captured: [listWords],
    title: (count) => `${amount(count, 'industrial project')} short of minerals`,
    rule: 'A project that is building (not paused or queued) needs more of a mineral or of fuel than its colony holds for the units it has left; each project is checked against the colony\'s whole stock, and a spied empire is skipped because it builds from its capital\'s stock.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_IndustrialProjects.Amount, mineral and fuel needs per unit', 'FCT_Population mineral and fuel stockpiles', 'FCT_IndustrialProjects.Queue, Pause'],
      note: 'The stock is compared with the stored needs of the units left, each project against the colony\'s whole stock; that the game builds from the stock the same way is not checked against the game. A project whose units left, a need, the stock it needs or its queue or paused flag is not stored is listed apart, as not evaluated.',
      assumptions: ['Each project is checked against the colony\'s whole stock, not what other projects of the colony would take first.'],
    },
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

      const projects = await rowsOf(ctx, `select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.FuelRequired, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause, ${PROJECT_RUNNING} as Verdict, ${needs}, ${stocks}, FCT_Population.FuelStockpile as StockFuel, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID ${COLONY_JOINS} where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and ${PROJECT_RUNNING} is not 0 order by FCT_Population.PopName, FCT_IndustrialProjects.Description`)

      const judged = projects.flatMap((project) => {
        const { short, missing } = shortageOf(project)
        const running = project.Verdict

        if (!short.length && !missing.length) {
          return []
        } else if (!short.length || running === null) {
          return [{ ...project, Short: short, Verdict: null, Missing: [...lacking(project, { Queue: 'whether the project is queued', Pause: 'whether the project is paused' }), ...missing] }]
        }

        return [{ ...project, Short: short, Verdict: 1, Missing: missing }]
      })

      return verdictRows(ctx, judged, {
        missing: (project) => project.Missing,
        build: (project) => {
          const [limit] = project.Short

          return {
            id: `project:${project.ProjectID}`,
            cells: {
              project: project.Description,
              short: limit ? project.Short.map((item) => item.name).join(', ') : unknownCell(ctx, project.Missing),
              covered: limit ? `${ctx.count(limit.covered, 1)} of ${ctx.count(project.Amount, 1)}` : unknownCell(ctx, project.Missing),
            },
            caption: colonyText(project),
            link: project.Short.length === 1 && project.Short[0].mineralId ? linkTo.mineralOutlook(project.Short[0].mineralId) : linkTo.production(project.PopulationID),
            signature: project.Missing.length ? null : signatureOf(categoriesOf(project.Short.map((item) => item.name))),
          }
        },
      })
    },
  },
  {
    key: 'idle-slipways',
    group: group.key,
    severity: 'info',
    material: 'the idle share crossing 25% of the slipways',
    captured: [bandWords('idle share under 25% of the slipways', 'idle share at 25% or more of the slipways')],
    title: (count) => `${amount(count, 'shipyard')} with idle slipways`,
    rule: 'A shipyard has more slipways than shipyard tasks, so the slipways without a task build nothing.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Shipyard.Slipways, Capacity, TaskType', 'FCT_ShipyardTask'],
      note: 'A count comparison on stored rows: a shipyard\'s slipways against its shipyard tasks. A shipyard whose slipways are not stored is listed apart, as not evaluated; a capacity not stored shows a dash.',
    },
    columns: [
      { key: 'shipyard', text: 'Shipyard' },
      { key: 'slipways', text: 'Idle slipways', align: 'end' },
      { key: 'capacity', text: 'Capacity', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const IDLE = '(FCT_Shipyard.Slipways > (select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID))'

      const shipyards = await rowsOf(ctx, `select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.TaskType, ${IDLE} as Verdict, (select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID) as Tasks, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_Shipyard inner join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID ${COLONY_JOINS} where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID} and ${IDLE} is not 0 order by FCT_Population.PopName, FCT_Shipyard.ShipyardName`)

      return verdictRows(ctx, shipyards, {
        missing: (shipyard) => lacking(shipyard, { Slipways: 'the shipyard\'s slipways' }),
        build: (shipyard) => ({
          id: `shipyard:${shipyard.ShipyardID}`,
          cells: {
            shipyard: shipyard.ShipyardName,
            slipways: figure(ctx, shipyard.Slipways, 'the shipyard\'s slipways', (known) => `${ctx.count(known - shipyard.Tasks)} of ${ctx.count(known)}`),
            capacity: figure(ctx, shipyard.Capacity, 'the shipyard\'s capacity', (known) => `${ctx.count(known)} t`),
          },
          caption: [colonyText(shipyard), SHIPYARD_ACTIVITIES[shipyard.TaskType]].filter(Boolean).join(' · '),
          link: linkTo.shipyards({ yard: shipyard.ShipyardID }),
          signature: signatureOf(bandOf(isKnownNumber(shipyard.Slipways) && shipyard.Slipways > 0 ? (shipyard.Slipways - shipyard.Tasks) / shipyard.Slipways : null, [QUARTER])),
        }),
      })
    },
  },
  {
    key: 'obsolete-shipyards',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'shipyard')} tooled to an obsolete class`,
    rule: 'A shipyard is set to build a ship class that is marked obsolete.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Shipyard.BuildClassID', 'FCT_ShipClass.Obsolete'],
      note: 'A presence check on a stored flag: a shipyard whose build class is marked obsolete. A shipyard set to a class whose flag, or row, is not stored is listed apart, as not evaluated; a shipyard set to no class is not a warning.',
    },
    columns: [
      { key: 'shipyard', text: 'Shipyard' },
      { key: 'class', text: 'Builds' },
      { key: 'slipways', text: 'Slipways', align: 'end' },
      { key: 'capacity', text: 'Capacity', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const OBSOLETE = '(case when FCT_Shipyard.BuildClassID is null then null when FCT_Shipyard.BuildClassID = 0 then 0 else (FCT_ShipClass.Obsolete = 1) end)'

      const shipyards = await rowsOf(ctx, `select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.BuildClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Obsolete as ClassObsolete, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, ${OBSOLETE} as Verdict, FCT_Population.PopName from FCT_Shipyard left join FCT_ShipClass on FCT_Shipyard.BuildClassID = FCT_ShipClass.ShipClassID left join FCT_Population on FCT_Shipyard.PopulationID = FCT_Population.PopulationID where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID} and ${OBSOLETE} is not 0 order by FCT_Shipyard.Capacity * FCT_Shipyard.Slipways desc`)

      return verdictRows(ctx, shipyards, {
        missing: (shipyard) => [...lacking(shipyard, { BuildClassID: 'the class the shipyard builds' }), ...(isKnownNumber(shipyard.BuildClassID) && !isKnownNumber(shipyard.ClassObsolete) ? ['the stored obsolete flag of the class the shipyard builds'] : [])],
        build: (shipyard) => ({
          id: `shipyard:${shipyard.ShipyardID}`,
          cells: {
            shipyard: shipyard.ShipyardName,
            class: shipyard.ClassName ? `${shipyard.ClassName} Class` : unknownCell(ctx, ['the class the shipyard builds']),
            slipways: figure(ctx, shipyard.Slipways, 'the shipyard\'s slipways'),
            capacity: figure(ctx, shipyard.Capacity, 'the shipyard\'s capacity', (known) => `${ctx.count(known)} t`),
          },
          caption: shipyard.PopName || undefined,
          link: linkTo.shipyards({ yard: shipyard.ShipyardID }),
        }),
      })
    },
  },
])
