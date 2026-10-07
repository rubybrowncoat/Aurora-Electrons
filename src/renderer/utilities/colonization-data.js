// Reads for the Colonization Planner, all through what the selected race knows: bodies of its known systems
// (FCT_RaceSysSurvey), deposits only where it has surveyed the body (FCT_SystemBodySurveys), other races'
// colonies only as its intelligence has them (FCT_AlienPopulation). Every query is scoped by GameID and RaceID.

import { climateBaseTemp } from './habitability'

const rows = (database, sql) => database.query(sql).then(([items]) => items)

// Every colonisable-looking body of a known system, with the atmosphere, the deposits of a surveyed body
// and the colonies on it. Gas giants and jump points never appear; asteroids and comets do.
export const loadBodies = async (database, { GameID, RaceID }) => {
  const [bodies, gases, deposits, own, alien] = await Promise.all([
    rows(
      database,
      `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.Radius, FCT_SystemBody.Gravity, FCT_SystemBody.BaseTemp, FCT_SystemBody.SurfaceTemp, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.Albedo, FCT_SystemBody.AtmosPress, FCT_SystemBody.TidalLock, FCT_SystemBody.DustLevel, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.DistanceToParent, FCT_SystemBody.Eccentricity, FCT_SystemBody.FixedBody, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_Star.Component, FCT_Star.Luminosity as StarLuminosity, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSysSurvey.ControlRaceID, FCT_RaceSysSurvey.MilitaryRestrictedSystem, FCT_SystemBodyName.Name as SystemBodyName, VIR_Parent.OrbitalDistance as ParentOrbitalDistance, VIR_Parent.DistanceToParent as ParentDistanceToParent, VIR_Parent.Eccentricity as ParentEccentricity, case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end as BodySurveyed, case when FCT_BannedBodies.SystemBodyID is null then 0 else 1 end as Banned
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
    rows(database, `select PopulationID, SystemBodyID, SpeciesID, Population, PopName from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID}`),
    rows(
      database,
      `select FCT_AlienPopulation.PopulationID, FCT_Population.SystemBodyID, FCT_AlienPopulation.AlienRaceID, FCT_AlienPopulation.PopulationAmount
from FCT_AlienPopulation
inner join FCT_Population on FCT_Population.PopulationID = FCT_AlienPopulation.PopulationID
where FCT_AlienPopulation.GameID = ${GameID} and FCT_AlienPopulation.ViewingRaceID = ${RaceID}`
    ),
  ])

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

export const loadGases = (database) => rows(database, 'select GasID, Name, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel from DIM_Gases')

// The jump points the race has charted in systems it knows, and its capital's place, for travel distances.
export const loadRoutes = async (database, { GameID, RaceID }) => {
  const [jumpPoints, capitals] = await Promise.all([
    rows(
      database,
      `select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.SystemID, FCT_JumpPoint.WPLink, FCT_JumpPoint.Xcor, FCT_JumpPoint.Ycor, FCT_JumpPoint.JumpGateStrength, FCT_JumpPoint.JumpGateRaceID, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.IgnoreForDistance
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_JumpPoint.GameID
where FCT_JumpPoint.GameID = ${GameID}`
    ),
    rows(
      database,
      `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor
from FCT_Population
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Capital = 1`
    ),
  ])

  return { jumpPoints, capital: capitals[0] || null }
}
