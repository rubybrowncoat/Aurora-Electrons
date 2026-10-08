// Reads for the Colonization Planner, all through what the selected race knows: bodies of its known systems
// (FCT_RaceSysSurvey), deposits only where it has surveyed the body (FCT_SystemBodySurveys), other races'
// colonies only as its intelligence has them (FCT_AlienPopulation). Every query is scoped by GameID and RaceID.

import groupBy from 'lodash/groupBy'
import { cmcStarInReach } from './colonization'
import { climateBaseTemp } from './habitability'
import { loadJumpPoints } from './jump-graph'
import { MINERALS, PRODUCTION_TYPES, SECONDS_PER_DAY, mineralOutlook, unloggedMining } from './minerals'
import { orbitalMiningQuery, surfaceMiningQuery } from './mining-data'
import { loadNavalAdmins } from './naval-admins'

const rows = (database, sql) => database.query(sql).then(([items]) => items)

// Every colonisable-looking body of a known system, with the atmosphere, the deposits of a surveyed body
// and the colonies on it. Gas giants and jump points never appear; asteroids and comets do. Each body also gets
// `CmcStarInReach` (colonization.js `cmcStarInReach` for its star), and each own colony `BlocksCmc`: whether the
// game would keep a civilian mining complex off its body (people, automated mines, complexes or ex-complexes, or
// no orbital miners of the race assigned to it there; Game.TryEstablishCivilianMiningColony).
export const loadBodies = async (database, { GameID, RaceID }) => {
  const [bodies, gases, deposits, own, alien, stars, lagrangePoints] = await Promise.all([
    rows(
      database,
      `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.StarID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.Radius, FCT_SystemBody.Gravity, FCT_SystemBody.BaseTemp, FCT_SystemBody.SurfaceTemp, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.Albedo, FCT_SystemBody.AtmosPress, FCT_SystemBody.TidalLock, FCT_SystemBody.DustLevel, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.DistanceToParent, FCT_SystemBody.Eccentricity, FCT_SystemBody.FixedBody, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_Star.Component, FCT_Star.Luminosity as StarLuminosity, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSysSurvey.ControlRaceID, FCT_RaceSysSurvey.MilitaryRestrictedSystem, FCT_SystemBodyName.Name as SystemBodyName, VIR_Parent.OrbitalDistance as ParentOrbitalDistance, VIR_Parent.DistanceToParent as ParentDistanceToParent, VIR_Parent.Eccentricity as ParentEccentricity, case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end as BodySurveyed, case when FCT_BannedBodies.SystemBodyID is null then 0 else 1 end as Banned
from FCT_SystemBody
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_SystemBody.GameID
inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID}
left join FCT_SystemBody as VIR_Parent on VIR_Parent.SystemBodyID = FCT_SystemBody.ParentBodyID and FCT_SystemBody.ParentBodyType = 1
left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${RaceID}
where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBody.BodyTypeID not in (0, 4, 5)`
    ),
    rows(
      database,
      `select FCT_AtmosphericGas.SystemBodyID, FCT_AtmosphericGas.AtmosGasID, FCT_AtmosphericGas.AtmosGasAmount, FCT_AtmosphericGas.GasAtm, FCT_AtmosphericGas.FrozenOut, DIM_Gases.Name as AtmosGasName, DIM_Gases.BoilingPoint, DIM_Gases.GHGas, DIM_Gases.AntiGHGas, DIM_Gases.Dangerous, DIM_Gases.DangerousLevel
from FCT_AtmosphericGas
inner join DIM_Gases on DIM_Gases.GasID = FCT_AtmosphericGas.AtmosGasID
where FCT_AtmosphericGas.GameID = ${GameID}`
    ),
    rows(
      database,
      `select FCT_MineralDeposit.SystemBodyID, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc
from FCT_MineralDeposit
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_MineralDeposit.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
where FCT_MineralDeposit.GameID = ${GameID}`
    ),
    rows(
      database,
      `select FCT_Population.PopulationID, FCT_Population.SystemBodyID, FCT_Population.SpeciesID, FCT_Population.Population, FCT_Population.PopName, case when FCT_Population.Population > 0 or exists (select 1 from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.PlanetaryInstallationID in (12, 39, 52) and FCT_PopulationInstallations.Amount > 0) or not exists (select 1 from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 where FCT_Fleet.RaceID = FCT_Population.RaceID and FCT_Fleet.OrbitBodyID = FCT_Population.SystemBodyID and FCT_Fleet.AssignedPopulationID in (FCT_Population.PopulationID, 0)) then 1 else 0 end as BlocksCmc
from FCT_Population
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`
    ),
    rows(
      database,
      `select FCT_AlienPopulation.PopulationID, FCT_Population.SystemBodyID, FCT_AlienPopulation.AlienRaceID, FCT_AlienPopulation.PopulationAmount
from FCT_AlienPopulation
inner join FCT_Population on FCT_Population.PopulationID = FCT_AlienPopulation.PopulationID
where FCT_AlienPopulation.GameID = ${GameID} and FCT_AlienPopulation.ViewingRaceID = ${RaceID}`
    ),
    rows(
      database,
      `select FCT_Star.StarID, FCT_Star.SystemID, FCT_Star.Component, FCT_Star.OrbitingComponent, FCT_Star.OrbitalDistance * (1 + FCT_Star.Eccentricity) as Apoapsis
from FCT_Star
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Star.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_Star.GameID
where FCT_Star.GameID = ${GameID}`
    ),
    rows(
      database,
      `select FCT_LagrangePoint.SystemID, FCT_LagrangePoint.StarID, FCT_Star.OrbitingComponent as StarOrbitingComponent, FCT_SystemBody.OrbitalDistance * (1 + FCT_SystemBody.Eccentricity) as PlanetApoapsis
from FCT_LagrangePoint
inner join FCT_Star on FCT_Star.StarID = FCT_LagrangePoint.StarID
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_LagrangePoint.PlanetID
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_LagrangePoint.GameID
where FCT_LagrangePoint.GameID = ${GameID}`
    ),
  ])

  const starsBySystem = groupBy(stars, 'SystemID')
  const pointsBySystem = groupBy(lagrangePoints, 'SystemID')
  const starInReach = new Map(stars.map((star) => [star.StarID, cmcStarInReach(star, starsBySystem[star.SystemID], pointsBySystem[star.SystemID] || [])]))
  const byId = new Map()

  bodies.forEach((body) => {
    byId.set(body.SystemBodyID, {
      ...body,
      StoredBaseTemp: body.BaseTemp,
      BaseTemp: climateBaseTemp(body),
      OriginalAlbedo: body.Albedo,
      OriginalSurfaceTemp: body.SurfaceTemp,
      SystemBodyOrder: `${body.Component}-${body.PlanetNumber}-${body.OrbitNumber}`,
      Atmosphere: [],
      Minerals: [],
      OwnPopulations: [],
      AlienPopulations: [],
      CmcStarInReach: !!starInReach.get(body.StarID),
    })
  })

  gases.forEach((gas) => byId.has(gas.SystemBodyID) && byId.get(gas.SystemBodyID).Atmosphere.push(gas))
  deposits.forEach((deposit) => byId.has(deposit.SystemBodyID) && byId.get(deposit.SystemBodyID).Minerals.push(deposit))
  own.forEach((population) => byId.has(population.SystemBodyID) && byId.get(population.SystemBodyID).OwnPopulations.push(population))
  alien.forEach((population) => byId.has(population.SystemBodyID) && byId.get(population.SystemBodyID).AlienPopulations.push(population))

  return [...byId.values()]
}

// The species the race lives as (one row per species with a colony of its own), with what the game derives its
// colony cost from.
export const loadSpecies = (database, { GameID, RaceID }) =>
  rows(
    database,
    `select FCT_Population.SpeciesID, FCT_Species.SpeciesName, sum(FCT_Population.Population) as TotalPopulation, FCT_Species.BreatheID, DIM_Gases.Name as BreatheName, FCT_Species.Oxygen as IdealBreathePressure, FCT_Species.OxyDev as BreathePressureDeviation, FCT_Species.PressMax as MaximumPressure, FCT_Species.Temperature as IdealTemperature, FCT_Species.TempDev as TemperatureDeviation, FCT_Species.Gravity as IdealGravity, FCT_Species.GravDev as GravityDeviation, FCT_Species.PopulationDensityModifier
from FCT_Population
inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID
left join DIM_Gases on DIM_Gases.GasID = FCT_Species.BreatheID
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}
group by FCT_Population.SpeciesID
order by TotalPopulation desc`
  )

// The race's tech multipliers and the game's terraforming speed setting (a percentage), as one row.
export const loadRaceRules = (database, { GameID, RaceID }) =>
  rows(
    database,
    `select FCT_Race.ColonizationSkill, FCT_Race.TerraformingRate, FCT_Game.TerraformingSpeed
from FCT_Race
inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID
where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`
  ).then(([row]) => row || { ColonizationSkill: 1, TerraformingRate: 0, TerraformingSpeed: 100 })

// What the game asks of the race before it founds a civilian mining complex (Game.ProcessNewCivilianMiningColonyCreation):
// complexes switched on for the game, a shipyard, more than one colony with people or infrastructure, and per system
// the millions of people in the race's largest colony there (for colonization.js `cmcSite`).
export const loadCmcRules = async (database, { GameID, RaceID }) => {
  const [[race], colonies] = await Promise.all([
    rows(
      database,
      `select FCT_Game.AllowCMC, (select count(*) from FCT_Shipyard where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID}) as Shipyards, (select count(*) from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_Population.Population > 0 or exists (select 1 from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.PlanetaryInstallationID = 9 and FCT_PopulationInstallations.Amount > 0))) as SettledColonies
from FCT_Game
where FCT_Game.GameID = ${GameID}`
    ),
    rows(database, `select SystemID, max(Population) as Largest from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID} group by SystemID`),
  ])

  return {
    allowed: !!race && race.AllowCMC === 1,
    shipyard: !!race && race.Shipyards > 0,
    settledColonies: race ? race.SettledColonies : 0,
    largestColony: Object.fromEntries(colonies.map((colony) => [colony.SystemID, colony.Largest])),
  }
}

export const loadGases = (database) => rows(database, 'select GasID, Name, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel from DIM_Gases')

// A colony supplies the next one from this many millions of people up (the Planner's "nearest colony").
export const SUPPLY_BASE_MILLIONS = 1

// The jump points the race has charted in systems it knows, and the places travel is measured from: its capital,
// and every colony of at least `SUPPLY_BASE_MILLIONS` (the capital among them), with the body's place.
export const loadRoutes = async (database, { GameID, RaceID }) => {
  const [jumpPoints, colonies] = await Promise.all([
    loadJumpPoints(database, { GameID, RaceID }),
    rows(
      database,
      `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_Population.Population, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor
from FCT_Population
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_Population.Capital = 1 or FCT_Population.Population >= ${SUPPLY_BASE_MILLIONS})`
    ),
  ])

  return { jumpPoints, capital: colonies.find((colony) => colony.Capital) || null, colonies }
}

const MINERAL_COLUMNS = MINERALS.map((mineral) => mineral.name)
const sumOf = (table) => MINERAL_COLUMNS.map((name) => `sum(${table}.${name}) as ${name}`).join(', ')
const byMineralId = (row) => Object.fromEntries(MINERALS.map((mineral) => [mineral.id, (row && row[mineral.name]) || 0]))

// How short each mineral is for the race: the Mineral Outlook page's runway (stock, cargo and mass-driver packets
// over the year's net loss, from the game's mineral ledger), read once for the Planner. The same reads as the
// page's, over the last 365 days.
const LEDGER_DAYS = 365

// The game's mineral ledger (Aurora 2.6 and later) over the last year, summed by mineral and entry type; [] for a
// save that doesn't have the table.
const loadLedger = async (database, { GameID, RaceID }) => {
  const [table] = await rows(database, "select count(*) as Present from sqlite_master where type = 'table' and name = 'FCT_RaceMineralData'")

  if (!table.Present) {
    return []
  }

  return rows(
    database,
    `select FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, sum(FCT_RaceMineralData.Amount) as Amount, min(FCT_RaceMineralData.Time) as FirstTime, max(FCT_RaceMineralData.Time) as LastTime, max(VIR_Ticks.ProductionTicks) as ProductionTicks, max(VIR_Ticks.FirstTick) as FirstTick, max(VIR_Ticks.LastTick) as LastTick
from FCT_RaceMineralData
inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID
cross join (select count(distinct VIR_Production.Time) as ProductionTicks, min(VIR_Production.Time) as FirstTick, max(VIR_Production.Time) as LastTick from FCT_RaceMineralData as VIR_Production inner join FCT_Game as VIR_Now on VIR_Now.GameID = VIR_Production.GameID where VIR_Production.GameID = ${GameID} and VIR_Production.RaceID = ${RaceID} and VIR_Production.Time > VIR_Now.GameTime - ${LEDGER_DAYS * SECONDS_PER_DAY} and VIR_Production.MineralDataType in (${PRODUCTION_TYPES.join(', ')})) as VIR_Ticks
where FCT_RaceMineralData.GameID = ${GameID} and FCT_RaceMineralData.RaceID = ${RaceID} and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${LEDGER_DAYS * SECONDS_PER_DAY}
group by FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType`
  )
}

// How short each mineral is for the race: the Mineral Outlook page's runway (stock, cargo and mass-driver packets
// over the year's net loss, from the game's mineral ledger and the mining it leaves out), read once for the
// Planner with the page's own reads.
export const loadMineralOutlook = async (database, ids) => {
  const { GameID, RaceID } = ids
  const [[game], [stock], cargo, [packets], ledger, surface, orbital, navalAdmins] = await Promise.all([
    rows(database, `select GameTime from FCT_Game where GameID = ${GameID}`),
    rows(database, `select ${sumOf('FCT_Population')} from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID}`),
    rows(database, `select FCT_ShipCargo.CargoID as MaterialID, sum(FCT_ShipCargo.Amount) as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID where FCT_ShipCargo.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_ShipCargo.CargoTypeID = 3 group by FCT_ShipCargo.CargoID`),
    rows(database, `select ${sumOf('FCT_MassDriverPackets')} from FCT_MassDriverPackets where GameID = ${GameID} and RaceID = ${RaceID}`),
    loadLedger(database, ids),
    rows(database, surfaceMiningQuery(ids)),
    rows(database, orbitalMiningQuery(ids)),
    loadNavalAdmins(database, { GameID, RaceID, bonusId: 6, share: 'Industrial' }),
  ])
  const carried = (mineral) => ((cargo.find((row) => row.MaterialID === mineral.id) || {}).Amount || 0) + ((packets && packets[mineral.name]) || 0)

  return mineralOutlook({
    ledger,
    gameTime: game ? game.GameTime : 0,
    windowDays: LEDGER_DAYS,
    stock: byMineralId(stock),
    transit: Object.fromEntries(MINERALS.map((mineral) => [mineral.id, carried(mineral)])),
    unlogged: unloggedMining({ surface, orbital, navalAdmins }),
  })
}
