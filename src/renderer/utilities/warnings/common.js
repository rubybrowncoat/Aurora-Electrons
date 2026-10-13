import { populationName, systemBodyName } from '../aurora'
import { UNKNOWN_TEXT, countText, isKnownNumber } from '../math'
import { HAUL_ORDER_ACTIONS, ORBITAL_MINING_MODULE, assessMiningSites, missingNeeds, unknownNeeds } from '../mining-sites'
import { registerRule, unavailable } from '../provenance'
import { loadFormulaVersion } from '../transport'

// Shared by the check modules of the Warnings page. A check is
//
//   { key, group, severity, title(count, options), rule, provenance, columns, options?, clock?, read(ctx) }
//
// `key` is stable and kebab-case; `severity` one of SEVERITIES (index.js); `title` the heading over the check's rows; `rule` one sentence saying when the check fires; `provenance` the id of the registered rule behind it (`warnings.<camelCased key>`, put there by `checksOf`); `columns` the table's `{ key, text, align? }`, the first holding the row's name; `options` the page options `read` depends on (so only those re-read the check when they change); `clock` that it depends on the game time. `read(ctx)` returns rows
//
//   { id, cells, caption?, link?, unevaluated? }
//
// `id` is stable and unique within the check, `cells` hold a column's text or `{ text, tone?, result? }` (`tone` being 'success', 'warning' or 'error'; `result` an unavailable provenance result naming the input a dash stands for), `caption` the line under the first cell and `link` a `linkTo` location. A row with `unevaluated` (an unavailable result naming the missing inputs) is one whose condition could not be decided because a stored value is missing: it is no warning, and the page lists it apart.
//
// `ctx` is { database, GameID, RaceID, RaceNPR, separator, count(value, decimals), options, GameTime?, unknown(missing) }; `unknown` is put there by `checksOf`.

const WARNING_VERSIONS = ['2.7.x']

const ruleName = (key) => key.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())

const UNKNOWN_INPUT = 'an input the check reads'

// Registers the rule behind each check of a module (`evidence` on the check: { verification, structure, note, assumptions? }) and gives the check its `provenance` id; its `read` gets `ctx.unknown(missing)`, an unavailable result of that rule naming `missing` (a list of the inputs a figure or a verdict lacks).
export const checksOf = (checks) => checks.map(({ evidence, read, ...check }) => {
  const provenance = `warnings.${ruleName(check.key)}`

  registerRule({ id: provenance, versions: WARNING_VERSIONS, units: 'rows', verification: evidence.verification, structure: evidence.structure, note: evidence.note, assumptions: evidence.assumptions })

  return { ...check, provenance, read: (ctx) => read({ ...ctx, unknown: (missing = []) => unavailable({ rule: provenance, missing: missing.length ? missing : [UNKNOWN_INPUT], units: 'rows' }) }) }
})

registerRule({
  id: 'warnings.summary',
  versions: WARNING_VERSIONS,
  units: 'rows, checks',
  verification: 'confirmed',
  structure: ['the rows each check returns', 'the muted rows and checks of the race'],
  note: 'Counts of the rows the checks return, by severity, less the muted rows and checks. A row whose condition could not be decided because a stored value is missing, and a check that could not be read, are counted apart and are in none of the warning counts.',
})

// A dash for a value that is not known (null, undefined, NaN), never 0.
export const counter = (separator) => (value, decimals = 0) => countText(value, decimals, separator)

const isMissing = (value) => value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))

// The names of the inputs a row lacks: `inputs` maps a column of the row to the words that name it.
export const lacking = (row, inputs) => Object.entries(inputs).filter(([column]) => isMissing(row[column])).map(([, name]) => name)

// Kleene logic over verdicts (1, 0, null for not known): `allOf` is 0 as soon as one is, else null when one is, else 1; `anyOf` is 1 as soon as one is, else null when one is, else 0. `false` and `true` count as 0 and 1.
const asVerdict = (value) => (value === null || value === undefined ? null : Number(Boolean(value)))

export const allOf = (...verdicts) => {
  const decided = verdicts.map(asVerdict)

  return decided.includes(0) ? 0 : decided.includes(null) ? null : 1
}

export const anyOf = (...verdicts) => {
  const decided = verdicts.map(asVerdict)

  return decided.includes(1) ? 1 : decided.includes(null) ? null : 0
}

// The rows a query kept with `Verdict` (the check's condition as the query evaluates it: 1, 0, or null while a stored value it needs is missing, SQLite's own three-valued logic): a 1 is a warning, a null a row that could not be evaluated, which `missing(item)` names, and a 0 is none. `build(item)` makes the row.
export const verdictRows = (ctx, items, { missing, build, verdict = (item) => item.Verdict }) => items.flatMap((item) => {
  const decided = verdict(item)

  if (decided === 0 || decided === false) {
    return []
  }

  const row = build(item)

  return [decided === null || decided === undefined ? { ...row, unevaluated: ctx.unknown(missing(item)) } : row]
})

// A dash standing for a figure that is not known, with the unavailable result naming the inputs (`names`, a list) it lacks.
export const unknownCell = (ctx, names) => ({ text: UNKNOWN_TEXT, result: ctx.unknown(names) })

// A figure as a cell: its text from `format` (by default a count), or a dash with the unavailable result naming `name` (one input, or a list) when the value is missing. `tone` gives the known figure its tone.
export const figure = (ctx, value, name, format = (known) => ctx.count(known), tone = null) => {
  if (!isKnownNumber(value)) {
    return unknownCell(ctx, [].concat(name))
  }

  const known = Number(value)

  return tone ? { text: format(known), tone: tone(known) } : format(known)
}

export const rowsOf = async (ctx, sql) => {
  const [rows] = await ctx.database.query(sql)

  return rows
}

// `1 damaged ship`, `3 damaged ships`.
export const amount = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

const UNKNOWN_SYSTEM = 'an unknown system'

// A system's name as plain text, never a bare `null`.
export const systemText = (row) => row.SystemName || UNKNOWN_SYSTEM

// A colony row's name as plain text: its system and body, then its own name.
export const colonyText = (row) => populationName({ ...row, SystemName: systemText(row), PopName: row.PopName || 'Unnamed colony' }).replace(/&mdash;/g, '—')

export const bodyText = (row) => systemBodyName(row, { Name: systemText(row) })

// How far a 0 to 1 level is from fine: above 85% good, under 30% bad.
export const levelTone = (level) => (level > 0.85 ? 'success' : level < 0.3 ? 'error' : 'warning')

// The columns and joins that name a colony (`populationName` reads them) on a query over `FCT_Population`.
export const COLONY_COLUMNS = 'FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component'

export const COLONY_JOINS = 'left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID'

// Rows as the page keeps them: frozen, so Vue doesn't observe each cell, with the text a search looks in, and with an id made unique where a query returned one twice. A cell of a column the check shows that is missing (null or undefined) becomes a dash with an unavailable result naming the column, so no blank cell passes for a known empty one.
export const normalizeRows = (rows, check) => {
  const seen = new Map()

  return rows.map((row) => {
    const times = seen.get(row.id) || 0
    const cells = Object.fromEntries(check.columns.map((column) => [column.key, isMissing(row.cells[column.key]) ? { text: UNKNOWN_TEXT, result: unavailable({ rule: check.provenance, missing: [`the stored value behind the ${column.text} column`], units: 'rows' }) } : row.cells[column.key]]))
    const texts = Object.values(cells).map((cell) => (cell !== null && typeof cell === 'object' ? cell.text : cell))

    seen.set(row.id, times + 1)

    return Object.freeze({
      ...row,
      cells,
      id: times ? `${row.id}#${times + 1}` : row.id,
      text: [...texts, row.caption].filter((text) => text !== undefined && text !== null).join(' ').toLowerCase(),
    })
  })
}

// A ship class's name as plain text, never a bare `null`.
export const classText = (row) => (row.ClassName ? `${row.ClassName} Class` : 'An unnamed class')

// The installation totals of each colony, from a query over `FCT_PopulationInstallations`: the capacity of its manned (workers), automated and civilian mining installations (amount times mining value), its mass drivers, its factories and the names of its mines, each with how many installation rows it could not be read from (a type that is not stored, or an amount or value that decides the kind). A kind with no readable row is 0 only when its gap count is 0.
const installationTotals = (GameID) => `select FCT_PopulationInstallations.PopID, sum(case when DIM_PlanetaryInstallation.MiningProductionValue > 0 and DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Manned, sum(case when DIM_PlanetaryInstallation.MiningProductionValue > 0 and DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers = 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Automated, sum(case when DIM_PlanetaryInstallation.MiningProductionValue > 0 and DIM_PlanetaryInstallation.CivilianInstallation = 1 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Civilian, sum(case when DIM_PlanetaryInstallation.MassDriverValue > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MassDriverValue else 0 end) as Drivers, sum(case when (DIM_PlanetaryInstallation.ConstructionValue > 0 or DIM_PlanetaryInstallation.OrdnanceProductionValue > 0 or DIM_PlanetaryInstallation.FighterProductionValue > 0) and FCT_PopulationInstallations.Amount > 0 then 1 else 0 end) as Factories, sum(case when DIM_PlanetaryInstallation.PlanetaryInstallationID is null or DIM_PlanetaryInstallation.MiningProductionValue is null or (DIM_PlanetaryInstallation.MiningProductionValue > 0 and (FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.Workers is null or DIM_PlanetaryInstallation.CivilianInstallation is null)) then 1 else 0 end) as MineGaps, sum(case when DIM_PlanetaryInstallation.PlanetaryInstallationID is null or DIM_PlanetaryInstallation.MassDriverValue is null or (DIM_PlanetaryInstallation.MassDriverValue > 0 and FCT_PopulationInstallations.Amount is null) then 1 else 0 end) as DriverGaps, sum(case when DIM_PlanetaryInstallation.PlanetaryInstallationID is null or DIM_PlanetaryInstallation.ConstructionValue is null or DIM_PlanetaryInstallation.OrdnanceProductionValue is null or DIM_PlanetaryInstallation.FighterProductionValue is null or ((DIM_PlanetaryInstallation.ConstructionValue > 0 or DIM_PlanetaryInstallation.OrdnanceProductionValue > 0 or DIM_PlanetaryInstallation.FighterProductionValue > 0) and FCT_PopulationInstallations.Amount is null) then 1 else 0 end) as FactoryGaps, group_concat(case when DIM_PlanetaryInstallation.MiningProductionValue > 0 and FCT_PopulationInstallations.Amount is not null then FCT_PopulationInstallations.Amount || 'x ' || DIM_PlanetaryInstallation.Name end, ', ') as MineNames from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID`

// How many deposit rows of a body (`body`, a column expression) hold an amount above 0, hold none, or are exhausted at 0 or less, and whether the race has surveyed the body: the columns `depositState` (mining-sites.js) reads.
const depositColumns = (body, game, race) => `(select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = ${body} and FCT_MineralDeposit.GameID = ${game} and FCT_MineralDeposit.Amount > 0) as Deposits, (select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = ${body} and FCT_MineralDeposit.GameID = ${game} and FCT_MineralDeposit.Amount is null) as DepositGaps, (select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = ${body} and FCT_MineralDeposit.GameID = ${game} and FCT_MineralDeposit.Amount <= 0) as Depleted, (select count(*) > 0 from FCT_SystemBodySurveys where FCT_SystemBodySurveys.SystemBodyID = ${body} and FCT_SystemBodySurveys.RaceID = ${race} and FCT_SystemBodySurveys.GameID = ${game}) as Surveyed`

const miningColoniesQuery = ({ GameID, RaceID }) => `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Population, FCT_Population.Efficiency, FCT_Population.Capital, FCT_Population.MassDriverDest, FCT_Race.MineProduction, FCT_SystemBody.RadiationLevel, ${depositColumns('FCT_Population.SystemBodyID', 'FCT_Population.GameID', 'FCT_Population.RaceID')}, coalesce(VIR_Own.Manned, 0) as Manned, coalesce(VIR_Own.Automated, 0) as Automated, coalesce(VIR_Own.Civilian, 0) as Civilian, coalesce(VIR_Own.MineGaps, 0) as MineGaps, VIR_Own.MineNames, coalesce(VIR_Own.Drivers, 0) as Drivers, coalesce(VIR_Own.DriverGaps, 0) as DriverGaps, coalesce(VIR_Own.Factories, 0) as Factories, coalesce(VIR_Own.FactoryGaps, 0) as FactoryGaps, VIR_Destination.PopulationID as DestinationID, VIR_Destination.RaceID as DestinationRaceID, VIR_Destination.SystemID as DestinationSystemID, coalesce(VIR_DestinationOwn.Drivers, 0) as DestinationDrivers, coalesce(VIR_DestinationOwn.DriverGaps, 0) as DestinationGaps, (select count(*) from FCT_Population as VIR_Other where VIR_Other.SystemID = FCT_Population.SystemID and VIR_Other.RaceID = FCT_Population.RaceID and VIR_Other.GameID = FCT_Population.GameID and VIR_Other.PopulationID <> FCT_Population.PopulationID) as OtherColonies, (select count(*) from FCT_MoveOrders where FCT_MoveOrders.PopulationID = FCT_Population.PopulationID and FCT_MoveOrders.GameID = FCT_Population.GameID and FCT_MoveOrders.MoveActionID in (${HAUL_ORDER_ACTIONS.join(', ')})) as HaulOrders, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID and FCT_Race.GameID = FCT_Population.GameID left join (${installationTotals(GameID)}) as VIR_Own on VIR_Own.PopID = FCT_Population.PopulationID left join FCT_Population as VIR_Destination on VIR_Destination.PopulationID = FCT_Population.MassDriverDest and VIR_Destination.GameID = FCT_Population.GameID and FCT_Population.MassDriverDest > 0 left join (${installationTotals(GameID)}) as VIR_DestinationOwn on VIR_DestinationOwn.PopID = VIR_Destination.PopulationID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by FCT_Population.PopName`

// The undamaged orbital mining modules of a ship: its class's component lines of that type, less the ship's damaged ones. Null while a component line has no stored type or count, the class has no line of that type, or a damaged count is not stored; a ship with no damage row has none damaged.
export const WORKING_MODULES = `(case when exists (select 1 from FCT_ClassComponent left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID is null) then null when not exists (select 1 from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${ORBITAL_MINING_MODULE} where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID) then null when exists (select 1 from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${ORBITAL_MINING_MODULE} left join FCT_DamagedComponent on FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and (FCT_ClassComponent.NumComponent is null or (FCT_DamagedComponent.ComponentID is not null and FCT_DamagedComponent.Number is null))) then null else (select sum(max(FCT_ClassComponent.NumComponent - coalesce((select sum(FCT_DamagedComponent.Number) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID), 0), 0)) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${ORBITAL_MINING_MODULE} where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID) end)`

const miningFleetsQuery = ({ GameID, RaceID }) => `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.AssignedPopulationID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.Radius * 2 as Diameter, FCT_Race.MaximumOrbitalMiningDiameter as MaximumDiameter, FCT_Race.MineProduction, ${depositColumns('FCT_Fleet.OrbitBodyID', 'FCT_Fleet.GameID', 'FCT_Fleet.RaceID')}, VIR_Colony.PopulationID as ColonyID, VIR_Colony.PopName as ColonyName, VIR_Assigned.PopulationID as AssignedID, VIR_Assigned.PopName as AssignedName, FCT_Ship.ShipID, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.MiningModules as Modules, (select count(*) from FCT_ClassComponent where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID) as ClassLines, ${WORKING_MODULES} as WorkingModules from FCT_Fleet inner join FCT_Race on FCT_Race.RaceID = FCT_Fleet.RaceID and FCT_Race.GameID = FCT_Fleet.GameID inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and (FCT_ShipClass.MiningModules > 0 or FCT_ShipClass.MiningModules is null) inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join FCT_Population as VIR_Colony on VIR_Colony.PopulationID = (select min(VIR_Own.PopulationID) from FCT_Population as VIR_Own where VIR_Own.SystemBodyID = FCT_Fleet.OrbitBodyID and VIR_Own.RaceID = FCT_Fleet.RaceID and VIR_Own.GameID = FCT_Fleet.GameID) left join FCT_Population as VIR_Assigned on VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID and VIR_Assigned.PopulationID > 0 and VIR_Assigned.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.OrbitBodyID > 0 and FCT_Ship.MothershipID = 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) order by FCT_Fleet.FleetName, FCT_Ship.ShipID`

// The race's mining sites (mining-sites.js `assessMiningSites`): its colonies with mines or assigned orbital miners and its orbital mining fleets without orders, each with the prerequisites it lacks. The three mining checks read the same sites.
export const readMiningSites = async (ctx) => {
  const [colonies, fleets, version] = await Promise.all([rowsOf(ctx, miningColoniesQuery(ctx)), rowsOf(ctx, miningFleetsQuery(ctx)), loadFormulaVersion(ctx.database)])

  return assessMiningSites({ colonies, fleets }, { RaceID: ctx.RaceID, version, count: ctx.count })
}

// The inputs a site's undecided prerequisites and unknown capacity wait on: what `verdictRows` lists as missing for a site not evaluated.
export const needInputs = (site, options) => [...new Set(unknownNeeds(site, options).flatMap((need) => need.inputs)), ...(site.capacityInputs || [])]

// The cell naming each prerequisite a site lacks, then those not known; when none is lacking, the unknown cell of what is undecided.
export const needsCell = (ctx, site, options) => {
  const absent = missingNeeds(site, options)
  const undecided = unknownNeeds(site, options)

  if (!absent.length) {
    return unknownCell(ctx, needInputs(site, options))
  }

  return { text: [...absent, ...undecided].map((need) => need.text).join('; '), tone: 'warning', ...(undecided.length ? { result: ctx.unknown(needInputs(site, options)) } : {}) }
}
