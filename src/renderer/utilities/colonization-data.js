// Reads for the Colonization Planner, all through what the selected race knows: bodies of its known systems (FCT_RaceSysSurvey), deposits only where it has surveyed the body (FCT_SystemBodySurveys), other races' colonies only as its intelligence has them (FCT_AlienPopulation). Every query is scoped by GameID and RaceID.

import groupBy from 'lodash/groupBy'
import { cmcStarInReach } from './colonization'
import { climateBaseTemp } from './habitability'
import { loadJumpPoints } from './jump-graph'
import { MINERALS, PRODUCTION_TYPES, SECONDS_PER_DAY, mineralOutlook, unloggedMining } from './minerals'
import { gateMiningRows, orbitalMiningQuery, surfaceMiningQuery } from './mining-data'
import { loadNavalAdmins } from './naval-admins'
import { ofRule, registerRule, unavailable } from './provenance'

const rows = (database, sql) => database.query(sql).then(([items]) => items)

// A SQL sum that is null, not smaller, when any row of the group has no value (`sum` skips nulls). A group with no rows at all sums to a real 0.
const completeSum = (column) => `case when count(*) = count(${column}) then coalesce(sum(${column}), 0) else null end`

// Every colonisable-looking body of a known system, with the atmosphere, the deposits of a surveyed body and the colonies on it. Gas giants and jump points never appear; asteroids and comets do. Each body also gets `CmcStarInReach` (colonization.js `cmcStarInReach` for its star), and each own colony `BlocksCmc`: whether the game would keep a civilian mining complex off its body (people, automated mines, complexes or ex-complexes, or no orbital miners of the race assigned to it there).
export const loadBodies = async (database, { GameID, RaceID }) => {
  const [bodies, gases, deposits, own, alien, stars, lagrangePoints] = await Promise.all([
    rows(database, `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.StarID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.Radius, FCT_SystemBody.Gravity, FCT_SystemBody.BaseTemp, FCT_SystemBody.SurfaceTemp, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.Albedo, FCT_SystemBody.AtmosPress, FCT_SystemBody.TidalLock, FCT_SystemBody.DustLevel, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.DistanceToParent, FCT_SystemBody.Eccentricity, FCT_SystemBody.FixedBody, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_Star.Component, FCT_Star.Luminosity as StarLuminosity, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSysSurvey.ControlRaceID, FCT_RaceSysSurvey.MilitaryRestrictedSystem, FCT_SystemBodyName.Name as SystemBodyName, VIR_Parent.OrbitalDistance as ParentOrbitalDistance, VIR_Parent.DistanceToParent as ParentDistanceToParent, VIR_Parent.Eccentricity as ParentEccentricity, case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end as BodySurveyed, case when FCT_BannedBodies.SystemBodyID is null then 0 else 1 end as Banned
from FCT_SystemBody
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_SystemBody.GameID
inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID}
left join FCT_SystemBody as VIR_Parent on VIR_Parent.SystemBodyID = FCT_SystemBody.ParentBodyID and FCT_SystemBody.ParentBodyType = 1
left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${RaceID}
where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBody.BodyTypeID not in (0, 4, 5)`),
    rows(database, `select FCT_AtmosphericGas.SystemBodyID, FCT_AtmosphericGas.AtmosGasID, FCT_AtmosphericGas.AtmosGasAmount, FCT_AtmosphericGas.GasAtm, FCT_AtmosphericGas.FrozenOut, DIM_Gases.Name as AtmosGasName, DIM_Gases.BoilingPoint, DIM_Gases.GHGas, DIM_Gases.AntiGHGas, DIM_Gases.Dangerous, DIM_Gases.DangerousLevel
from FCT_AtmosphericGas
left join DIM_Gases on DIM_Gases.GasID = FCT_AtmosphericGas.AtmosGasID
where FCT_AtmosphericGas.GameID = ${GameID}`),
    rows(database, `select FCT_MineralDeposit.SystemBodyID, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc
from FCT_MineralDeposit
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_MineralDeposit.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
where FCT_MineralDeposit.GameID = ${GameID}`),
    rows(database, `select FCT_Population.PopulationID, FCT_Population.SystemBodyID, FCT_Population.SpeciesID, FCT_Population.Population, FCT_Population.PopName, case when FCT_Population.Population > 0 or exists (select 1 from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.PlanetaryInstallationID in (12, 39, 52) and FCT_PopulationInstallations.Amount > 0) or not exists (select 1 from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 where FCT_Fleet.RaceID = FCT_Population.RaceID and FCT_Fleet.OrbitBodyID = FCT_Population.SystemBodyID and FCT_Fleet.AssignedPopulationID in (FCT_Population.PopulationID, 0)) then 1 else 0 end as BlocksCmc
from FCT_Population
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`),
    rows(database, `select FCT_AlienPopulation.PopulationID, FCT_Population.SystemBodyID, FCT_AlienPopulation.AlienRaceID, FCT_AlienPopulation.PopulationAmount
from FCT_AlienPopulation
inner join FCT_Population on FCT_Population.PopulationID = FCT_AlienPopulation.PopulationID
where FCT_AlienPopulation.GameID = ${GameID} and FCT_AlienPopulation.ViewingRaceID = ${RaceID}`),
    rows(database, `select FCT_Star.StarID, FCT_Star.SystemID, FCT_Star.Component, FCT_Star.OrbitingComponent, FCT_Star.OrbitalDistance * (1 + FCT_Star.Eccentricity) as Apoapsis
from FCT_Star
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Star.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_Star.GameID
where FCT_Star.GameID = ${GameID}`),
    rows(database, `select FCT_LagrangePoint.SystemID, FCT_LagrangePoint.StarID, FCT_Star.OrbitingComponent as StarOrbitingComponent, FCT_SystemBody.OrbitalDistance * (1 + FCT_SystemBody.Eccentricity) as PlanetApoapsis
from FCT_LagrangePoint
inner join FCT_Star on FCT_Star.StarID = FCT_LagrangePoint.StarID
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_LagrangePoint.PlanetID
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_LagrangePoint.GameID
where FCT_LagrangePoint.GameID = ${GameID}`),
  ])

  const starsBySystem = groupBy(stars, 'SystemID')
  const pointsBySystem = groupBy(lagrangePoints, 'SystemID')
  const starInReach = new Map(stars.map((star) => [star.StarID, cmcStarInReach(star, starsBySystem[star.SystemID], pointsBySystem[star.SystemID] || [])]))
  const byId = new Map()

  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index]

    body.StoredBaseTemp = body.BaseTemp
    body.BaseTemp = climateBaseTemp(body)
    body.OriginalAlbedo = body.Albedo
    body.OriginalSurfaceTemp = body.SurfaceTemp
    body.SystemBodyOrder = `${body.Component}-${body.PlanetNumber}-${body.OrbitNumber}`
    body.Atmosphere = []
    body.Minerals = []
    body.OwnPopulations = []
    body.AlienPopulations = []
    body.CmcStarInReach = !!starInReach.get(body.StarID)
    byId.set(body.SystemBodyID, body)
  }

  gases.forEach((gas) => byId.has(gas.SystemBodyID) && byId.get(gas.SystemBodyID).Atmosphere.push(gas))
  deposits.forEach((deposit) => byId.has(deposit.SystemBodyID) && byId.get(deposit.SystemBodyID).Minerals.push(deposit))
  own.forEach((population) => byId.has(population.SystemBodyID) && byId.get(population.SystemBodyID).OwnPopulations.push(population))
  alien.forEach((population) => byId.has(population.SystemBodyID) && byId.get(population.SystemBodyID).AlienPopulations.push(population))

  return [...byId.values()]
}

// The species the race lives as (one row per species with a colony of its own), with what the game derives its colony cost from.
export const loadSpecies = (database, { GameID, RaceID }) => rows(database, `select FCT_Population.SpeciesID, FCT_Species.SpeciesName, ${completeSum('FCT_Population.Population')} as TotalPopulation, FCT_Species.BreatheID, DIM_Gases.Name as BreatheName, FCT_Species.Oxygen as IdealBreathePressure, FCT_Species.OxyDev as BreathePressureDeviation, FCT_Species.PressMax as MaximumPressure, FCT_Species.Temperature as IdealTemperature, FCT_Species.TempDev as TemperatureDeviation, FCT_Species.Gravity as IdealGravity, FCT_Species.GravDev as GravityDeviation, FCT_Species.PopulationDensityModifier
from FCT_Population
inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID
left join DIM_Gases on DIM_Gases.GasID = FCT_Species.BreatheID
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}
group by FCT_Population.SpeciesID
order by TotalPopulation desc`)

registerRule({
  id: 'habitability.speciesPopulation',
  versions: ['2.7.x'],
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_Population.Population, SpeciesID, RaceID'],
  note: 'The sum of the stored population over the race\'s colonies of the species, as saved; no calculation beyond the sum.',
})

// A species' population (millions) as a result: unavailable when any of its colonies has no recorded population (the sum would be partial), never 0. A species whose colonies hold no people is a real 0.
export const speciesPopulationResult = (species) => (Number.isFinite(species.TotalPopulation) ? ofRule({ rule: 'habitability.speciesPopulation', value: species.TotalPopulation, inputs: { present: ['FCT_Population.Population'] } }) : unavailable({ rule: 'habitability.speciesPopulation', missing: ['the population of the species'] }))

// What the race rules are while unread, and when the save has no race row: nothing is known, so no default stands in for a missing rate or skill (colonization.js `terraformCapacityResult` and `assessBodies` say what each missing one does).
export const NO_RACE_RULES = Object.freeze({ ColonizationSkill: null, TerraformingRate: null, TerraformingSpeed: null })

// The race's tech multipliers and the game's terraforming speed setting (a percentage), as one row. Without a race row, or with a column that holds nothing, the figure is null.
export const loadRaceRules = (database, { GameID, RaceID }) => rows(database, `select FCT_Race.ColonizationSkill, FCT_Race.TerraformingRate, FCT_Game.TerraformingSpeed
from FCT_Race
inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID
where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`).then(([row]) => row || NO_RACE_RULES)

// Whether a game founds civilian mining complexes, from its `FCT_Game` row. The switch is `FCT_Game.AllowCMC`; a row without it does not count as switched on.
export const cmcAllowedOf = (game) => game.AllowCMC === 1

// What the game asks of the race before it founds a civilian mining complex: complexes switched on for the game (`FCT_Game.AllowCMC`), a shipyard, more than one colony with people or infrastructure, and per system the millions of people in the race's largest colony there (for colonization.js `cmcSite`).
export const loadCmcRules = async (database, { GameID, RaceID }) => {
  const [[race], colonies] = await Promise.all([
    rows(database, `select FCT_Game.AllowCMC, (select count(*) from FCT_Shipyard where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID}) as Shipyards, (select count(*) from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_Population.Population > 0 or exists (select 1 from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.PlanetaryInstallationID = 9 and FCT_PopulationInstallations.Amount > 0))) as SettledColonies
from FCT_Game
where FCT_Game.GameID = ${GameID}`),
    rows(database, `select SystemID, max(Population) as Largest from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID} group by SystemID`),
  ])

  return {
    allowed: !!race && cmcAllowedOf(race),
    shipyard: !!race && race.Shipyards > 0,
    settledColonies: race ? race.SettledColonies : 0,
    largestColony: Object.fromEntries(colonies.map((colony) => [colony.SystemID, colony.Largest])),
  }
}

export const loadGases = (database) => rows(database, 'select GasID, Name, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel from DIM_Gases')

// A colony supplies the next one from this many millions of people up (the Planner's "nearest colony").
export const SUPPLY_BASE_MILLIONS = 1

// The jump points the race has charted in systems it knows, and the places travel is measured from: its capital, and every colony of at least `SUPPLY_BASE_MILLIONS` (the capital among them), with the body's place.
export const loadRoutes = async (database, { GameID, RaceID }) => {
  const [jumpPoints, colonies] = await Promise.all([
    loadJumpPoints(database, { GameID, RaceID }),
    rows(database, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_Population.Population, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor
from FCT_Population
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_Population.Capital = 1 or FCT_Population.Population >= ${SUPPLY_BASE_MILLIONS})`),
  ])

  return { jumpPoints, capital: colonies.find((colony) => colony.Capital) || null, colonies }
}

// The Lagrange points of the systems the race knows, for the transit estimate: where a ship can jump between two of them inside a system (jump-graph.js `searchRoutes`). The points belong to no race, so a system's are all read once the race knows it.
export const loadLagrangePoints = (database, { GameID, RaceID }) => rows(database, `select FCT_LagrangePoint.SystemID, FCT_LagrangePoint.Xcor, FCT_LagrangePoint.Ycor
from FCT_LagrangePoint
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_LagrangePoint.GameID
where FCT_LagrangePoint.GameID = ${GameID}`)

// The largest jump drive of a class as the size of ship it carries, and whether a drive of that kind has no rating stored, read for `driveOfClass` without `JUMP_DRIVE_COLUMNS`' reading of a missing figure as 0: `alias` is the largest rating stored (0 when the class has no such component, which is a drive that carries nothing), `alias`Unknown 1 when a component of that kind has no rating, so a rating that is stored can still prove the hull carried while an unrecorded one only leaves it open. `kind` is the condition on the component's special function that picks the kind: 0 for the ordinary drives, none for every kind, null for a drive whose kind the save does not store (the shared columns leave it out of the ordinary ones, so `driveOfClass` may not read it as no drive).
const driveColumns = (alias, kind) => {
  const from = `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 16${kind}`

  return `coalesce((select max(FCT_ShipDesignComponents.ComponentValue) ${from}), 0) as ${alias}, coalesce((select max(FCT_ShipDesignComponents.ComponentValue is null) ${from}), 0) as ${alias}Unknown`
}

const ORDINARY_DRIVES = ' and FCT_ShipDesignComponents.SpecialFunction = 0'
const UNKNOWN_KIND_DRIVES = ' and FCT_ShipDesignComponents.SpecialFunction is null'

// The ship classes the race has ships of that move, for the transit estimate's choice of a representative ship: the top speed, the size of the largest hull, whether the class is military and the largest jump drives it carries with whether any has no rating (`driveColumns`: the ordinary ones, every kind, and those of a kind the save does not store, `NoKindDrive`), the figures `driveOfClass` reads. A class whose speed the save lacks is not offered: there is no speed to take from it.
export const loadTransitClasses = (database, { GameID, RaceID }) => rows(database, `select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.MaxSpeed, FCT_ShipClass.Size, FCT_ShipClass.MilitaryEngines, ${driveColumns('Drive', ORDINARY_DRIVES)}, ${driveColumns('AnyDrive', '')}, ${driveColumns('NoKindDrive', UNKNOWN_KIND_DRIVES)}, count(FCT_Ship.ShipID) as Ships
from FCT_ShipClass
inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.GameID = FCT_ShipClass.GameID and FCT_Ship.RaceID = ${RaceID}
where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID} and FCT_ShipClass.MaxSpeed > 1
group by FCT_ShipClass.ShipClassID
order by FCT_ShipClass.MaxSpeed desc, FCT_ShipClass.ClassName`)

const MINERAL_COLUMNS = MINERALS.map((mineral) => mineral.name)
const sumOf = (table) => MINERAL_COLUMNS.map((name) => `${completeSum(`${table}.${name}`)} as ${name}`).join(', ')
const byMineralId = (row) => Object.fromEntries(MINERALS.map((mineral) => [mineral.id, row ? row[mineral.name] ?? null : null]))

// How short each mineral is for the race: the Mineral Outlook page's runway (stock, cargo and mass-driver packets over the year's net loss, from the game's mineral ledger), read once for the Planner. The same reads as the page's, over the last 365 days.
const LEDGER_DAYS = 365

// The game's mineral ledger over the last year, summed by mineral and entry type; [] for a save whose ledger holds no row in that time.
const loadLedger = async (database, { GameID, RaceID }) => {
  return rows(database, `select FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, ${completeSum('FCT_RaceMineralData.Amount')} as Amount, min(FCT_RaceMineralData.Time) as FirstTime, max(FCT_RaceMineralData.Time) as LastTime, max(VIR_Ticks.ProductionTicks) as ProductionTicks, max(VIR_Ticks.FirstTick) as FirstTick, max(VIR_Ticks.LastTick) as LastTick
from FCT_RaceMineralData
inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID
cross join (select count(distinct VIR_Production.Time) as ProductionTicks, min(VIR_Production.Time) as FirstTick, max(VIR_Production.Time) as LastTick from FCT_RaceMineralData as VIR_Production inner join FCT_Game as VIR_Now on VIR_Now.GameID = VIR_Production.GameID where VIR_Production.GameID = ${GameID} and VIR_Production.RaceID = ${RaceID} and VIR_Production.Time > VIR_Now.GameTime - ${LEDGER_DAYS * SECONDS_PER_DAY} and VIR_Production.MineralDataType in (${PRODUCTION_TYPES.join(', ')})) as VIR_Ticks
where FCT_RaceMineralData.GameID = ${GameID} and FCT_RaceMineralData.RaceID = ${RaceID} and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${LEDGER_DAYS * SECONDS_PER_DAY}
group by FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType`)
}

// How short each mineral is for the race: the Mineral Outlook page's runway (stock, cargo and mass-driver packets over the year's net loss, from the game's mineral ledger and the mining it leaves out), read once for the Planner with the page's own reads. A sum with a row that has no value (a colony's stock, a cargo line, a packet column, a ledger amount) is null, not the smaller sum of the others: `mineralOutlook` reads null as unknown.
// `ids.blocked` (the commander bonus IDs whose lookup row the save does not confirm) and `ids.ranks` (whether the naval admin commanders' ranks are in the save) leave the mining that rests on them unknown.
export const loadMineralOutlook = async (database, ids) => {
  const { GameID, RaceID, ranks = true, blocked = new Set() } = ids
  const [[game], [stock], cargo, [packets], ledger, surface, orbital, navalAdmins] = await Promise.all([
    rows(database, `select GameTime from FCT_Game where GameID = ${GameID}`),
    rows(database, `select ${sumOf('FCT_Population')} from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID}`),
    rows(database, `select FCT_ShipCargo.CargoID as MaterialID, ${completeSum('FCT_ShipCargo.Amount')} as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID where FCT_ShipCargo.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_ShipCargo.CargoTypeID = 3 group by FCT_ShipCargo.CargoID`),
    rows(database, `select ${sumOf('FCT_MassDriverPackets')} from FCT_MassDriverPackets where GameID = ${GameID} and RaceID = ${RaceID}`),
    loadLedger(database, ids),
    rows(database, surfaceMiningQuery(ids)).then((items) => gateMiningRows(items, blocked)),
    rows(database, orbitalMiningQuery(ids)).then((items) => gateMiningRows(items, blocked)),
    loadNavalAdmins(database, { GameID, RaceID, bonusId: 6, share: 'Industrial', ranks, blocked }),
  ])
  const carried = (mineral) => {
    const aboard = cargo.find((row) => row.MaterialID === mineral.id)
    const onShips = aboard ? aboard.Amount : 0
    const driven = packets ? packets[mineral.name] : null

    return onShips === null || driven === null || driven === undefined ? null : onShips + driven
  }

  return mineralOutlook({
    ledger,
    gameTime: game ? game.GameTime : 0,
    windowDays: LEDGER_DAYS,
    stock: byMineralId(stock),
    transit: Object.fromEntries(MINERALS.map((mineral) => [mineral.id, carried(mineral)])),
    unlogged: unloggedMining({ surface, orbital, navalAdmins }),
  })
}
