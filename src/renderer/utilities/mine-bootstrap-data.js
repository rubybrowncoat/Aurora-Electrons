// The reads behind the mine bootstrap comparison (utilities/mine-bootstrap.js): the mine types a race can build, the colonies that could build or receive them, the race's freighter and troop classes, the projects that hold a colony's construction capacity, and the ground formations with their commanders. Each read works out which columns the save has and reads a missing one as null (unknown), never as 0.

import { loadJumpPoints } from './jump-graph'
import { MINERALS } from './minerals'
import { failureWords, inputWords } from './provenance'
import { JUMP_DRIVE_COLUMNS } from './transport'

// The commander bonus the production of ground engineers rests on: Production.
const PRODUCTION_BONUS = 5
// The commander types that can hold a ground formation (ground and combined commanders).
const GROUND_COMMANDER_TYPES = '1, 4'
// FCT_Commander.CommandType of a ground formation.
const FORMATION_COMMAND = 5
// DIM_ComponentType: Cargo Shuttle Bay.
const CARGO_SHUTTLE_BAY = 14

// The cargo handling of a class and of a colony as the Hauling Planner reads them (`CLASS_SHUTTLE_STRENGTH_COLUMNS`, `SHUTTLE_SERVICE_COLUMNS` of utilities/transport.js), except that a figure is zero only when no row contributes to it: a bay whose count or strength is null, or a service installation whose amount or value is null, leaves the sum unknown (null) instead of counting as nothing. The shared columns keep their output for the pages that read them.
const BAYS = `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${CARGO_SHUTTLE_BAY}`
const KNOWN_SHUTTLE_STRENGTH = `case when exists (select 1 ${BAYS} and (FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null)) then null else coalesce((select sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) ${BAYS}), 0) end as ShuttleStrength`
const KNOWN_SERVICE_COLUMNS = 'case when VIR_Service.PopID is null then 0 else VIR_Service.ShuttleCapacity end as ShuttleCapacity, VIR_Service.ServiceNames'
const knownServiceJoin = (gameId, populationColumn) => `left join (select FCT_PopulationInstallations.PopID, case when count(*) > count(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) then null else sum(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) end as ShuttleCapacity, group_concat(DIM_PlanetaryInstallation.Name, ', ') as ServiceNames from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${gameId} and (FCT_PopulationInstallations.Amount is null or FCT_PopulationInstallations.Amount > 0) and (DIM_PlanetaryInstallation.CargoShuttleValue is null or DIM_PlanetaryInstallation.CargoShuttleValue > 0) group by FCT_PopulationInstallations.PopID) as VIR_Service on VIR_Service.PopID = ${populationColumn}`

export { KNOWN_SERVICE_COLUMNS, knownServiceJoin }

export const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

// The select list of `names` from a table aliased `alias`: a column the save lacks reads as null.
export const selectedColumns = (alias, columns, names) => names.map((name) => (columns.has(name) ? `${alias}.${name} as ${name}` : `null as ${name}`)).join(', ')

export const hasAll = (columns, names) => names.every((name) => columns.has(name))

export const gaps = (table, columns, wanted) => (columns.size === 0 ? [inputWords(table)] : wanted.filter((name) => !columns.has(name)).map((name) => inputWords(table, name)))

// Whether a stored flag is set: null when the save does not say (a null value or no column), never false.
const isSet = (value) => (value === null || value === undefined ? null : Number(value) !== 0)

// The installation types that mine and that the race can build, as [{ PlanetaryInstallationID, Name, Cost, CargoPoints, Workers, recipe: { [mineralId]: tonnes }, eligibility: [text] }]. A type needs a mining value above 0. One the save says is not buildable, is civilian or needs a technology the race lacks is left out. A flag the save does not say (a null value, or no such column) is unknown, never permission: the type stays listed and its `eligibility` names what is not said, so every figure of it is unavailable.
export const loadMineTypes = async (database, { GameID, RaceID }) => {
  const [installation, tech] = await Promise.all([columnsOf(database, 'DIM_PlanetaryInstallation'), columnsOf(database, 'FCT_RaceTech')])

  if (!['PlanetaryInstallationID', 'Name', 'MiningProductionValue'].every((name) => installation.has(name))) {
    return []
  }

  const minerals = MINERALS.map((mineral) => (installation.has(mineral.name) ? `DIM_PlanetaryInstallation.${mineral.name} as Recipe${mineral.id}` : `null as Recipe${mineral.id}`)).join(', ')
  const techKnown = hasAll(tech, ['TechID', 'GameID', 'RaceID'])
  const researched = installation.has('RequiredTechID') ? `case when DIM_PlanetaryInstallation.RequiredTechID is null then null when DIM_PlanetaryInstallation.RequiredTechID = 0 then 1 ${techKnown ? `when DIM_PlanetaryInstallation.RequiredTechID in (select FCT_RaceTech.TechID from FCT_RaceTech where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID}) then 1 else 0` : 'else null'} end` : 'null'
  const [rows] = await database.query(`select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name, ${selectedColumns('DIM_PlanetaryInstallation', installation, ['Cost', 'CargoPoints', 'Workers', 'NoBuild', 'CivilianInstallation'])}, ${researched} as Researched, ${minerals} from DIM_PlanetaryInstallation where DIM_PlanetaryInstallation.MiningProductionValue > 0 order by DIM_PlanetaryInstallation.Name`)

  return rows.map((row) => {
    const verdicts = [
      { text: 'whether the installation is barred from building', blocks: isSet(row.NoBuild) },
      { text: 'whether the installation is a civilian one', blocks: isSet(row.CivilianInstallation) },
      { text: 'the race\'s technology for the installation', blocks: row.Researched === null || row.Researched === undefined ? null : Number(row.Researched) === 0 },
    ]

    return { row, verdicts }
  }).filter(({ verdicts }) => !verdicts.some((verdict) => verdict.blocks === true)).map(({ row, verdicts }) => ({ PlanetaryInstallationID: row.PlanetaryInstallationID, Name: row.Name, Cost: row.Cost, CargoPoints: row.CargoPoints, Workers: row.Workers, recipe: MINERALS.some((mineral) => row[`Recipe${mineral.id}`] === null || row[`Recipe${mineral.id}`] === undefined) ? null : Object.fromEntries(MINERALS.map((mineral) => [mineral.id, row[`Recipe${mineral.id}`]])), eligibility: verdicts.filter((verdict) => verdict.blocks === null).map((verdict) => `whether ${row.Name} can be built (${verdict.text})`) }))
}

// The race's colonies with their place, what serves their cargo handling and their mineral stock, as [{ PopulationID, PopName, SystemID, Xcor, Ycor, ShuttleCapacity, ServiceNames, stock: { [mineralId]: tonnes } | null }]. A colony whose body has no position is left out. A save without what serves cargo handling gives null for ShuttleCapacity (not known), never 0.
export const loadBootstrapColonies = async (database, { GameID, RaceID }) => {
  const [population, body, installation, built] = await Promise.all(['FCT_Population', 'FCT_SystemBody', 'DIM_PlanetaryInstallation', 'FCT_PopulationInstallations'].map((table) => columnsOf(database, table)))

  if (!['Xcor', 'Ycor'].every((name) => body.has(name))) {
    return []
  }

  const served = hasAll(installation, ['PlanetaryInstallationID', 'Name', 'CargoShuttleValue']) && hasAll(built, ['GameID', 'PopID', 'PlanetaryInstallationID', 'Amount'])
  const stock = MINERALS.map((mineral) => (population.has(mineral.name) ? `FCT_Population.${mineral.name} as Stock${mineral.id}` : `null as Stock${mineral.id}`)).join(', ')
  const [rows] = await database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, ${served ? KNOWN_SERVICE_COLUMNS : 'null as ShuttleCapacity, null as ServiceNames'}, ${stock} from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID ${served ? knownServiceJoin(GameID, 'FCT_Population.PopulationID') : ''} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`)

  return rows.map((row) => ({ PopulationID: row.PopulationID, PopName: row.PopName, SystemID: row.SystemID, Xcor: row.Xcor, Ycor: row.Ycor, ShuttleCapacity: row.ShuttleCapacity, ServiceNames: row.ServiceNames, stock: MINERALS.every((mineral) => row[`Stock${mineral.id}`] === null || row[`Stock${mineral.id}`] === undefined) ? null : Object.fromEntries(MINERALS.map((mineral) => [mineral.id, row[`Stock${mineral.id}`]])) }))
}

// The industrial projects of the race's colonies with the fields that say what share of a colony's capacity each holds (`industryUsage`): the colony, production type, share, queue place and pause flag.
export const loadBootstrapProjects = async (database, { GameID, RaceID }) => {
  const projects = await columnsOf(database, 'FCT_IndustrialProjects')
  const [rows] = await database.query(`select FCT_IndustrialProjects.PopulationID, ${selectedColumns('FCT_IndustrialProjects', projects, ['ProductionType', 'Percentage', 'Queue'])}, ${projects.has('Pause') ? 'FCT_IndustrialProjects.Pause' : 'null'} as Paused, ${projects.has('Description') ? 'FCT_IndustrialProjects.Description' : 'null'} as Name from FCT_IndustrialProjects where FCT_IndustrialProjects.PopulationID in (select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID})`)

  return rows
}

// The race's freighters and troop ships: { freighters: [class], troops: { lift, ships, classes: [{ ShipClassID, ClassName, TroopCapacity, Ships }] } | null, gaps }. A freighter class is one with cargo space and a speed, with how many of the race's own ships use it, the figures a round trip is timed with (as the Hauling Planner reads them) and the jump drives that decide where it can go (`Drive`, `AnyDrive`, `MilitaryEngines`); a figure the save does not hold is null. `troops` is the troop capacity of each class with ships (null when the save has no troop capacity column), `lift` their sum. `gaps` names the columns the save lacks that the freighters cannot be listed without (then there are none).
export const loadBootstrapFreight = async (database, { GameID, RaceID }) => {
  const [shipClass, ship, classComponent, designComponent] = await Promise.all(['FCT_ShipClass', 'FCT_Ship', 'FCT_ClassComponent', 'FCT_ShipDesignComponents'].map((table) => columnsOf(database, table)))
  const lacking = [...gaps('FCT_ShipClass', shipClass, ['ShipClassID', 'GameID', 'RaceID', 'ClassName', 'CargoCapacity', 'MaxSpeed']), ...gaps('FCT_Ship', ship, ['ShipID', 'ShipClassID', 'ShippingLineID'])]

  if (lacking.length) {
    return { freighters: [], troops: null, gaps: lacking }
  }

  const bays = hasAll(classComponent, ['ClassID', 'ComponentID', 'NumComponent']) && hasAll(designComponent, ['SDComponentID', 'ComponentTypeID', 'ComponentValue'])
  const drives = bays && designComponent.has('SpecialFunction')
  const optional = selectedColumns('FCT_ShipClass', shipClass, ['ColonistCapacity', 'Size', 'EnginePower', 'FuelEfficiency', 'FuelCapacity', 'MilitaryEngines'])
  const [freighters] = await database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.CargoCapacity, FCT_ShipClass.MaxSpeed, ${optional}, ${shipClass.has('Crew') ? 'FCT_ShipClass.Crew' : 'null'} as ClassCrew, ${shipClass.has('EnginePower') && shipClass.has('FuelEfficiency') ? 'FCT_ShipClass.EnginePower * FCT_ShipClass.FuelEfficiency' : 'null'} as FuelPerHour, ${bays ? KNOWN_SHUTTLE_STRENGTH : 'null as ShuttleStrength'}, ${drives ? JUMP_DRIVE_COLUMNS : 'null as Drive, null as AnyDrive'}, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.ShippingLineID = 0 where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID} and FCT_ShipClass.CargoCapacity > 0 and FCT_ShipClass.MaxSpeed > 1 group by FCT_ShipClass.ShipClassID order by Ships desc`)

  if (!shipClass.has('TroopCapacity')) {
    return { freighters, troops: null, gaps: [] }
  }

  const [classes] = await database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.TroopCapacity, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.ShippingLineID = 0 where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID} and FCT_ShipClass.TroopCapacity > 0 group by FCT_ShipClass.ShipClassID order by FCT_ShipClass.TroopCapacity desc`)

  return { freighters, troops: { lift: classes.reduce((total, item) => total + item.TroopCapacity * item.Ships, 0), ships: classes.reduce((total, item) => total + item.Ships, 0), classes }, gaps: [] }
}

// The race's ground formations with what the engineers' construction rests on: { gaps, formations }. `gaps` names the tables and columns the save lacks (then `formations` is empty); a formation is { FormationID, Name, PopulationID, ShipID, ParentFormationID, ownSize, hq, rating, commander }: `ownSize` the whole tonnage of its own elements as it is saved, fractions kept (a troop bay holds a formation by it; the headquarters load takes each formation's tonnage whole, which the command rule does), `hq` the largest headquarters capacity among them, `rating` units x construction rating summed (null while a class has none), and `commander` null with no ground commander, otherwise { bonus } with the Production bonus (1 when the commander has none, null when the bonus lookup is `blocked` or its value is null).
export const loadGroundFormations = async (database, { GameID, RaceID, blocked = new Set() }) => {
  const [formation, element, groundClass, commander, bonus] = await Promise.all(['FCT_GroundUnitFormation', 'FCT_GroundUnitFormationElement', 'FCT_GroundUnitClass', 'FCT_Commander', 'FCT_CommanderBonuses'].map((table) => columnsOf(database, table)))
  const missing = [...gaps('FCT_GroundUnitFormation', formation, ['FormationID', 'PopulationID', 'ShipID', 'ParentFormationID']), ...gaps('FCT_GroundUnitFormationElement', element, ['FormationID', 'ClassID', 'Units']), ...gaps('FCT_GroundUnitClass', groundClass, ['GroundUnitClassID', 'Size', 'ConstructionRating', 'HQCapacity']), ...gaps('FCT_Commander', commander, ['CommanderID', 'CommanderType', 'CommandType', 'CommandID']), ...gaps('FCT_CommanderBonuses', bonus, ['CommanderID', 'BonusID', 'BonusValue'])]

  if (missing.length) {
    return { gaps: missing, formations: [] }
  }

  const [[formations], [elements], [commanders]] = await Promise.all([
    database.query(`select FCT_GroundUnitFormation.FormationID, FCT_GroundUnitFormation.Name, FCT_GroundUnitFormation.PopulationID, FCT_GroundUnitFormation.ShipID, FCT_GroundUnitFormation.ParentFormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${GameID} and FCT_GroundUnitFormation.RaceID = ${RaceID}`),
    database.query(`select FCT_GroundUnitFormationElement.FormationID, FCT_GroundUnitFormationElement.Units, FCT_GroundUnitClass.Size, FCT_GroundUnitClass.ConstructionRating, FCT_GroundUnitClass.HQCapacity from FCT_GroundUnitFormationElement inner join FCT_GroundUnitFormation on FCT_GroundUnitFormation.FormationID = FCT_GroundUnitFormationElement.FormationID left join FCT_GroundUnitClass on FCT_GroundUnitClass.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID where FCT_GroundUnitFormation.GameID = ${GameID} and FCT_GroundUnitFormation.RaceID = ${RaceID}`),
    database.query(`select FCT_Commander.CommandID as FormationID, count(FCT_CommanderBonuses.BonusID) as Rows, max(FCT_CommanderBonuses.BonusValue) as BonusValue, count(FCT_CommanderBonuses.BonusValue) as Known from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${PRODUCTION_BONUS} where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType = ${FORMATION_COMMAND} and FCT_Commander.CommanderType in (${GROUND_COMMANDER_TYPES}) and FCT_Commander.CommandID <> 0 group by FCT_Commander.CommanderID`),
  ])
  const byFormation = {}

  elements.forEach((row) => (byFormation[row.FormationID] = byFormation[row.FormationID] || []).push(row))

  const commanderOf = {}

  commanders.forEach((row) => {
    commanderOf[row.FormationID] = { bonus: blocked.has(PRODUCTION_BONUS) ? null : row.Rows === 0 ? 1 : row.Known === 0 ? null : row.BonusValue }
  })

  const sum = (rows, read) => (rows.some((row) => read(row) === null || read(row) === undefined || row.Units === null || row.Units === undefined) ? null : rows.reduce((total, row) => total + row.Units * read(row), 0))

  return {
    gaps: [],
    formations: formations.map((row) => {
      const own = byFormation[row.FormationID] || []
      const size = sum(own, (element) => element.Size)
      const hq = own.some((item) => item.HQCapacity === null || item.HQCapacity === undefined) ? null : own.reduce((best, item) => Math.max(best, item.HQCapacity), 0)

      return { FormationID: row.FormationID, Name: row.Name, PopulationID: row.PopulationID, ShipID: row.ShipID, ParentFormationID: row.ParentFormationID, ownSize: size, hq, rating: sum(own, (element) => element.ConstructionRating), commander: commanderOf[row.FormationID] || null }
    }),
  }
}

// The race's cargo shuttle technology, which speeds every load and unload. Null when the race row has none or the save lacks the column: the loading strength is then unknown, not 1.
export const loadShuttleTechnology = async (database, { RaceID }) => {
  const race = await columnsOf(database, 'FCT_Race')

  if (!['RaceID', 'CargoShuttleLoadModifier'].every((name) => race.has(name))) {
    return null
  }

  const [[row]] = await database.query(`select FCT_Race.CargoShuttleLoadModifier from FCT_Race where FCT_Race.RaceID = ${RaceID}`)

  return row && row.CargoShuttleLoadModifier > 0 ? row.CargoShuttleLoadModifier : null
}

export const NO_BOOTSTRAP_SOURCES = Object.freeze({ types: [], colonies: [], projects: [], freighters: [], troops: null, ground: Object.freeze({ gaps: [], formations: [] }), jumpPoints: [], shuttleTechnology: null, problems: [] })

// The reads a route rests on, by source: what a failed read of the source leaves unknown.
const SOURCE_NAMES = { types: 'the mine types', colonies: 'the colonies\' places and stock', projects: 'the running projects', freight: 'the freighter and troop ship classes', ground: 'the ground formations', jumps: 'the charted jump points', handling: 'the cargo shuttle technology' }

// Everything the comparison reads, in one pass: { types, colonies, projects, freighters, troops, ground, jumpPoints, shuttleTechnology, problems }. `blocked` is the set of commander bonus IDs the save's lookup does not confirm. Each source is read on its own: a read that fails (a save of another shape, a read that timed out) leaves its own part empty and is named in `problems` ([{ source, retry, text }]) while the other sources stay, so a route that does not rest on it still stands. `retry` marks a read that failed, which a later read may make, as against a column the save lacks.
export const loadBootstrapSources = async (database, { GameID, RaceID, blocked = new Set() }) => {
  const problems = []
  const attempt = async (source, read, fallback) => {
    try {
      return await read()
    } catch (error) {
      problems.push({ source, retry: true, text: `${SOURCE_NAMES[source]} could not be read (${failureWords(error)})` })

      return fallback
    }
  }
  const [types, colonies, projects, freight, ground, jumpPoints, shuttleTechnology] = await Promise.all([
    attempt('types', () => loadMineTypes(database, { GameID, RaceID }), []),
    attempt('colonies', () => loadBootstrapColonies(database, { GameID, RaceID }), []),
    attempt('projects', () => loadBootstrapProjects(database, { GameID, RaceID }), []),
    attempt('freight', () => loadBootstrapFreight(database, { GameID, RaceID }), { freighters: [], troops: null, gaps: [] }),
    attempt('ground', () => loadGroundFormations(database, { GameID, RaceID, blocked }), { gaps: [SOURCE_NAMES.ground], formations: [] }),
    attempt('jumps', () => loadJumpPoints(database, { GameID, RaceID }), []),
    attempt('handling', () => loadShuttleTechnology(database, { RaceID }), null),
  ])

  if (freight.gaps.length) {
    problems.push({ source: 'freight', text: `the save lacks ${freight.gaps.join(', ')}` })
  }

  return { types, colonies, projects, freighters: freight.freighters, troops: freight.troops, ground, jumpPoints, shuttleTechnology, problems }
}
