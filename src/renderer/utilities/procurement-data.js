// The reads behind the component procurement manifest (utilities/procurement-manifest.js): the colonies with their shipyards, the shipyard tasks, the queued component projects and the tons each component weighs. The class parts and the component stock are not read here: the Component calculator's read (`componentSources`) already holds them, and the manifest uses that same read so the two cannot disagree. Each read works out which columns the save has and says whether it could be read; a column the save lacks reads as null (unknown), never as 0.

import { loadOwnComponents, quantityOf } from './design-data'
import { PRODUCTION_TYPE, loadedProject } from './production-types'
import { valueOrNull } from './provenance'

// The production type of a component project (its ProductionID is the component's ID), and the types of the development projects the manifest reads beside it (Engineering, Ordnance and Ground Unit Projects; utilities/production-types.js): only the component and Engineering Projects add components to a colony's stock, the manifest counts the other two by kind.
export const COMPONENT_PROJECT = PRODUCTION_TYPE.COMPONENTS

const PROJECT_TYPES = [COMPONENT_PROJECT, PRODUCTION_TYPE.ENGINEERING_PROJECTS, PRODUCTION_TYPE.ORDNANCE_PROJECTS, PRODUCTION_TYPE.GROUND_UNIT_PROJECTS]

export const NO_PROCUREMENT_SOURCES = Object.freeze({ colonies: Object.freeze({}), tasks: Object.freeze([]), projects: Object.freeze([]), components: Object.freeze({}), read: Object.freeze({ colonies: false, tasks: false, projects: false, components: false }) })

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

// The select list of `names` from a table aliased `alias`: a column the save lacks reads as null.
const selectedColumns = (alias, columns, names) => names.map((name) => (columns.has(name) ? `${alias}.${name} as ${name}` : `null as ${name}`)).join(', ')

const hasAll = (columns, names) => names.every((name) => columns.has(name))

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// The race's colonies: { [populationId]: { id, name, systemId, systemName, yards } }. `yards` counts the colony's shipyards (null when the save has no shipyard table).
const loadColonies = async (database, { GameID, RaceID }) => {
  const [population, survey, yard] = await Promise.all(['FCT_Population', 'FCT_RaceSysSurvey', 'FCT_Shipyard'].map((table) => columnsOf(database, table)))

  if (!hasAll(population, ['PopulationID', 'PopName', 'GameID', 'RaceID'])) {
    return { colonies: {}, read: false }
  }

  const name = hasAll(survey, ['SystemID', 'RaceID', 'Name']) && population.has('SystemID') ? 'FCT_RaceSysSurvey.Name' : 'null'
  const join = name === 'null' ? '' : 'left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID'
  const yards = hasAll(yard, ['PopulationID', 'GameID']) ? '(select count(*) from FCT_Shipyard where FCT_Shipyard.PopulationID = FCT_Population.PopulationID and FCT_Shipyard.GameID = FCT_Population.GameID)' : 'null'
  const [rows] = await database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, ${selectedColumns('FCT_Population', population, ['SystemID'])}, ${name} as SystemName, ${yards} as Yards from FCT_Population ${join} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by FCT_Population.PopulationID`)

  return { colonies: Object.fromEntries(rows.map((row) => [row.PopulationID, { id: row.PopulationID, name: row.PopName, systemId: numberOrNull(row.SystemID), systemName: row.SystemName === undefined ? null : row.SystemName, yards: numberOrNull(row.Yards) }])), read: true }
}

// The race's shipyard tasks, one row each as stored with the class cost: [{ id, populationId, typeId, classId, refitId, paused, useComponents, totalBP, completedBP, hulls (NumShips, the ships the task still makes, null where the save stores none), classCost }]. The cost is what the ship costs without any component credit; a task of a lower total was made with stock credited against it.
const loadTasks = async (database, { GameID, RaceID }) => {
  const [task, shipClass] = await Promise.all([columnsOf(database, 'FCT_ShipyardTask'), columnsOf(database, 'FCT_ShipClass')])

  if (!hasAll(task, ['TaskID', 'GameID', 'RaceID', 'PopulationID', 'TaskTypeID'])) {
    return { tasks: [], read: false }
  }

  const cost = shipClass.has('Cost') && shipClass.has('ShipClassID') && task.has('ClassID') ? 'FCT_ShipClass.Cost' : 'null'
  const join = cost === 'null' ? '' : 'left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID'
  const [rows] = await database.query(`select FCT_ShipyardTask.TaskID, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.TaskTypeID, ${selectedColumns('FCT_ShipyardTask', task, ['ClassID', 'RefitID', 'Paused', 'UseComponents', 'TotalBP', 'CompletedBP', 'NumShips'])}, ${cost} as ClassCost from FCT_ShipyardTask ${join} where FCT_ShipyardTask.GameID = ${GameID} and FCT_ShipyardTask.RaceID = ${RaceID} order by FCT_ShipyardTask.TaskID`)

  return { tasks: rows.map((row) => ({ id: row.TaskID, populationId: row.PopulationID, typeId: numberOrNull(row.TaskTypeID), classId: numberOrNull(row.ClassID), refitId: numberOrNull(row.RefitID), paused: numberOrNull(row.Paused), useComponents: numberOrNull(row.UseComponents), totalBP: numberOrNull(row.TotalBP), completedBP: numberOrNull(row.CompletedBP), hulls: numberOrNull(row.NumShips), classCost: numberOrNull(row.ClassCost) })), read: true }
}

// The race's queued component projects and development projects the game loads (utilities/production-types.js `loadedProject`): [{ id, productionType, populationId, componentId, amount, partial, percentage, queue, paused, name }]. `componentId` is the project's `ProductionID`: the component of a component or Engineering Project, the missile of an Ordnance Project, the ground unit class of a Ground Unit Project. `amount` and `partial` are the stored remaining amount and part-built unit (null when the save lacks them); `paused` is the pause flag as stored (null when the save lacks it).
const loadProjects = async (database, { GameID, RaceID }) => {
  const [projects, race, colony, species, wealth] = await Promise.all(['FCT_IndustrialProjects', 'FCT_Race', 'FCT_Population', 'FCT_Species', 'DIM_WealthUse'].map((table) => columnsOf(database, table)))

  if (!hasAll(projects, ['ProjectID', 'GameID', 'RaceID', 'PopulationID', 'ProductionType', 'ProductionID', 'SpeciesID', 'WealthUse']) || !hasAll(race, ['RaceID', 'GameID']) || !hasAll(colony, ['PopulationID', 'GameID']) || !hasAll(species, ['SpeciesID', 'GameID']) || !hasAll(wealth, ['WealthUseID'])) {
    return { projects: [], read: false }
  }

  const [rows] = await database.query(`select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.ProductionID, ${selectedColumns('FCT_IndustrialProjects', projects, ['Amount', 'PartialCompletion', 'Percentage', 'Queue', 'Description'])}, ${projects.has('Pause') ? 'FCT_IndustrialProjects.Pause' : 'null'} as Paused from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and FCT_IndustrialProjects.ProductionType in (${PROJECT_TYPES.join(', ')}) and ${loadedProject()} order by FCT_IndustrialProjects.ProjectID`)

  return { projects: rows.map((row) => ({ id: row.ProjectID, productionType: numberOrNull(row.ProductionType), populationId: row.PopulationID, componentId: row.ProductionID, amount: numberOrNull(row.Amount), partial: numberOrNull(row.PartialCompletion), percentage: numberOrNull(row.Percentage), queue: numberOrNull(row.Queue), paused: numberOrNull(row.Paused), name: row.Description || null })), read: true }
}

// What the race has researched of each component the shared design data holds: { [componentId]: { id, name, typeId, cost, tons } }, with cost (build points a unit) and tons (what a unit weighs in cargo) null where not known.
const loadSharedComponents = async (database, { GameID, RaceID }) => {
  const components = await loadOwnComponents(database, { GameID, RaceID }, { identify: false })

  return Object.fromEntries(components.map((component) => [component.id, { id: component.id, name: component.name, typeId: component.type.id, cost: component.cost, tons: valueOrNull(quantityOf(component, 'tons')) }]))
}

// Everything the manifest reads besides the Component calculator's read: { colonies, tasks, projects, components, read: { colonies, tasks, projects, components } }, where `read` says per source whether the save had it to read.
export const loadProcurementSources = async (database, { GameID, RaceID }) => {
  const [colonies, tasks, projects, components] = await Promise.all([loadColonies(database, { GameID, RaceID }), loadTasks(database, { GameID, RaceID }), loadProjects(database, { GameID, RaceID }), loadSharedComponents(database, { GameID, RaceID })])

  return { colonies: colonies.colonies, tasks: tasks.tasks, projects: projects.projects, components, read: { colonies: colonies.read, tasks: tasks.read, projects: projects.read, components: Object.keys(components).length > 0 } }
}
