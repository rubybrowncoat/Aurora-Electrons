// The items the race's Engineering, Ordnance and Ground Unit Projects develop, and what each costs to develop: the reads behind the Industry jobs of the Production page. The game offers these projects for the race's own designs that are not yet researched (Population.method_178, method_179 and method_180, Population.cs:8857-8909) and sets the project's cost to twice the item's stored development cost, its minerals to the item's minerals scaled to that cost (Population.SetSelectedIndustrialProjectAndPopulateRequirementsListView, Population.cs:8388-8479, which reads `TechSystem.DevelopCost` of the component, the missile or the ground unit class). The `ProductionID` of the project is the component's `SDComponentID`, the missile's `MissileID` or the ground unit class's `GroundUnitClassID` (Game.SaveIndustrialProjects, Game.cs:11499-11517); the tech of a component or a missile has the same id, and the ground unit class stores its tech's id. Only the projects the game loads are read (`loadedProject` of production-types.js: a row whose colony, species or wealth use the game does not hold is skipped by `Game.LoadIndustrialProjects`). Every figure is a stored value; nothing is computed here, and a table or column the save lacks leaves the item of that kind unread, never read as 0.

import { MINERALS } from './minerals'
import { DEVELOPMENT_ITEMS, PRODUCTION_TYPE, loadedProject } from './production-types'

export const NO_DEVELOPMENT_ITEMS = Object.freeze({ items: Object.freeze({}), unread: Object.freeze([]) })

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

const hasAll = (columns, names) => names.every((name) => columns.has(name))

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// The race's projects of one production type with the item's name and the development cost of its tech, one query for each kind of item (the name and the way to the tech differ).
const ENGINEERING_SQL = ({ GameID, RaceID }) => `select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionID as ItemID, FCT_ShipDesignComponents.Name as ItemName, FCT_TechSystem.DevelopCost as DevelopCost from FCT_IndustrialProjects left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_IndustrialProjects.ProductionID and FCT_ShipDesignComponents.GameID = FCT_IndustrialProjects.GameID left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_IndustrialProjects.ProductionID and FCT_TechSystem.GameID = FCT_IndustrialProjects.GameID where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and FCT_IndustrialProjects.ProductionType = ${PRODUCTION_TYPE.ENGINEERING_PROJECTS} and ${loadedProject()}`

const ORDNANCE_SQL = ({ GameID, RaceID }) => `select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionID as ItemID, FCT_MissileType.Name as ItemName, FCT_TechSystem.DevelopCost as DevelopCost from FCT_IndustrialProjects left join FCT_MissileType on FCT_MissileType.MissileID = FCT_IndustrialProjects.ProductionID and FCT_MissileType.GameID = FCT_IndustrialProjects.GameID left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_IndustrialProjects.ProductionID and FCT_TechSystem.GameID = FCT_IndustrialProjects.GameID where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and FCT_IndustrialProjects.ProductionType = ${PRODUCTION_TYPE.ORDNANCE_PROJECTS} and ${loadedProject()}`

const GROUND_UNIT_SQL = ({ GameID, RaceID }) => `select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionID as ItemID, FCT_GroundUnitClass.ClassName as ItemName, FCT_TechSystem.DevelopCost as DevelopCost from FCT_IndustrialProjects left join FCT_GroundUnitClass on FCT_GroundUnitClass.GroundUnitClassID = FCT_IndustrialProjects.ProductionID and FCT_GroundUnitClass.GameID = FCT_IndustrialProjects.GameID left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_GroundUnitClass.TechSystemID and FCT_TechSystem.GameID = FCT_IndustrialProjects.GameID where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} and FCT_IndustrialProjects.ProductionType = ${PRODUCTION_TYPE.GROUND_UNIT_PROJECTS} and ${loadedProject()}`

// Each kind: its production type, the table of its item and the columns the query needs of it, and the query.
const KINDS = [
  { type: PRODUCTION_TYPE.ENGINEERING_PROJECTS, table: 'FCT_ShipDesignComponents', columns: ['GameID', 'SDComponentID', 'Name'], sql: ENGINEERING_SQL },
  { type: PRODUCTION_TYPE.ORDNANCE_PROJECTS, table: 'FCT_MissileType', columns: ['GameID', 'MissileID', 'Name'], sql: ORDNANCE_SQL },
  { type: PRODUCTION_TYPE.GROUND_UNIT_PROJECTS, table: 'FCT_GroundUnitClass', columns: ['GameID', 'GroundUnitClassID', 'ClassName', 'TechSystemID'], sql: GROUND_UNIT_SQL },
]

// The race's development projects with their items: `items` is { [projectId]: { type, itemId, name, developCost } }, each of name and developCost null where the save does not hold the item or its tech; `unread` lists the production types whose tables or columns the save lacks, whose projects have no entry.
export const loadDevelopmentItems = async (database, { GameID, RaceID }) => {
  const [projects, techs, race, colony, species, wealth, ...tables] = await Promise.all([columnsOf(database, 'FCT_IndustrialProjects'), columnsOf(database, 'FCT_TechSystem'), columnsOf(database, 'FCT_Race'), columnsOf(database, 'FCT_Population'), columnsOf(database, 'FCT_Species'), columnsOf(database, 'DIM_WealthUse'), ...KINDS.map((kind) => columnsOf(database, kind.table))])
  const items = {}
  const unread = []
  const shared = hasAll(projects, ['ProjectID', 'GameID', 'RaceID', 'PopulationID', 'ProductionType', 'ProductionID', 'SpeciesID', 'WealthUse']) && hasAll(techs, ['TechSystemID', 'GameID', 'DevelopCost']) && hasAll(race, ['RaceID', 'GameID']) && hasAll(colony, ['PopulationID', 'GameID']) && hasAll(species, ['SpeciesID', 'GameID']) && hasAll(wealth, ['WealthUseID'])

  for (const [index, kind] of KINDS.entries()) {
    if (!shared || !hasAll(tables[index], kind.columns)) {
      unread.push(kind.type)

      continue
    }

    const [rows] = await database.query(kind.sql({ GameID, RaceID }))

    rows.forEach((row) => {
      items[row.ID] = { type: kind.type, itemId: row.ItemID, name: typeof row.ItemName === 'string' && row.ItemName ? row.ItemName : null, developCost: numberOrNull(row.DevelopCost) }
    })
  }

  return { items, unread }
}

// The stored cost of a development project is twice the item's development cost (Population.cs:8388-8479); a stored cost that is not is stated as stored, with the development cost beside it, and never called twice.
const TWICE_TOLERANCE = 1e-6

// The line under a development project: what it develops, its cost in build points against the item's development cost, and its minerals a unit (each a stored column; a project's amount is 1, so they are the whole project). `project` has `ProductionType`, `ProdPerUnit` and a column per mineral; `entry` is the project's item (`loadDevelopmentItems`) or undefined; `count(value, decimals)` writes a number. A figure the save does not hold is said so, never given as 0.
export const developmentTerms = (project, entry, count) => {
  const figure = (value) => count(value, Number.isInteger(value) ? 0 : 2)
  const label = DEVELOPMENT_ITEMS[project.ProductionType]
  const develops = entry && entry.name ? `Develops ${entry.name} (${label})` : `Develops a ${label} the save does not hold`
  const developCost = entry ? entry.developCost : null
  const known = Number.isFinite(project.ProdPerUnit)
  const twice = known && Number.isFinite(developCost) && Math.abs(project.ProdPerUnit - 2 * developCost) <= TWICE_TOLERANCE * Math.max(1, Math.abs(project.ProdPerUnit))
  const cost = !known ? 'cost not stored' : Number.isFinite(developCost) ? `${figure(project.ProdPerUnit)} BP, ${twice ? 'twice' : 'against'} its development cost of ${figure(developCost)} BP` : `${figure(project.ProdPerUnit)} BP, its development cost not stored`
  const stored = MINERALS.filter((mineral) => Number.isFinite(project[mineral.name]))
  const needed = stored.filter((mineral) => project[mineral.name] > 0).map((mineral) => `${mineral.name} ${figure(project[mineral.name])} t`)
  const gaps = stored.length < MINERALS.length

  return [`${develops}: ${cost}`, needed.length ? needed.join(', ') : gaps ? 'minerals not stored' : 'no minerals', ...(needed.length && gaps ? ['some minerals not stored'] : [])].join(' · ')
}
