// The live line under each page in the section flyout: route -> async ({ database, GameID, RaceID, ... }) => string | null.
// Each peek is a few cheap queries scoped to the selected race, validated against the sample and a large save in
// docs/plans/aurcalcs/ (see ARCHITECTURE.md). A route with no entry has no peek. Kept apart from the page registry,
// which Node also requires. The context also carries `StartYear`, `separator` (the thousands separator),
// `historyRecorded` and `snapshotSummary` (the history store's getter).

import { gameTime } from './aurora'
import { people } from './colonies'
import { compact as compactLitres } from './logistics'
import { MINERALS, compact as compactTons } from './minerals'
import { roundToDecimal, separatedNumber } from './math'

const PEEK_WINDOW_DAYS = 30

const row = async (database, sql) => {
  const [rows] = await database.query(sql)

  return rows[0]
}

const plural = (count, one, many) => (count === 1 ? one : many)

// `1'414 bodies`, with the user's separator.
const counted = (count, separator, one, many) => `${separatedNumber(count, separator)} ${plural(count, one, many)}`

export const peeks = {
  '/production': async ({ database, GameID, RaceID, separator }) => {
    const { Jobs, Paused } = await row(database, `select
      (select count(*) from FCT_ResearchProject where GameID = ${GameID} and RaceID = ${RaceID})
      + (select count(*) from FCT_IndustrialProjects where GameID = ${GameID} and RaceID = ${RaceID} and coalesce(Queue, 0) = 0)
      + (select count(*) from FCT_ShipyardTask where GameID = ${GameID} and RaceID = ${RaceID})
      + (select count(*) from FCT_Shipyard where GameID = ${GameID} and RaceID = ${RaceID} and TaskType <> 0)
      + (select count(*) from FCT_GroundUnitTraining where GameID = ${GameID} and RaceID = ${RaceID})
      + (select count(*) from (
          select FCT_Population.PopulationID from FCT_Ship
            inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
            inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID
            inner join FCT_Population on FCT_Population.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_Population.RaceID = FCT_Ship.RaceID
            where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_ShipClass.Terraformers > 0 and FCT_Population.TerraformingGasID <> 0 and not (FCT_Population.TerraformStatus <> 0 and coalesce(FCT_Population.MaxAtm, 0) = 0)
          union
          select FCT_Population.PopulationID from FCT_PopulationInstallations
            inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID
            inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID
            where FCT_PopulationInstallations.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.TerraformValue > 0 and FCT_Population.TerraformingGasID <> 0 and not (FCT_Population.TerraformStatus <> 0 and coalesce(FCT_Population.MaxAtm, 0) = 0))) as Jobs,
      (select count(*) from FCT_IndustrialProjects where GameID = ${GameID} and RaceID = ${RaceID} and coalesce(Queue, 0) = 0 and Pause = 1)
      + (select count(*) from FCT_ShipyardTask where GameID = ${GameID} and RaceID = ${RaceID} and Paused = 1)
      + (select count(*) from FCT_Shipyard where GameID = ${GameID} and RaceID = ${RaceID} and TaskType <> 0 and PauseActivity = 1) as Paused`)

    return `${counted(Jobs, separator, 'job', 'jobs')}${Paused > 0 ? `, ${Paused} paused` : ''}`
  },

  '/warnings': async ({ database, GameID, RaceID, separator }) => {
    const { IntruderSystems, DamagedShips } = await row(database, `select
      (select count(distinct FCT_Contacts.SystemID) from FCT_Contacts
        inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Contacts.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}
        inner join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_Contacts.ContactRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.GameID = ${GameID}
        where FCT_Contacts.GameID = ${GameID} and FCT_Contacts.DetectRaceID = ${RaceID} and FCT_Contacts.ContactType in (1, 3, 4, 12, 14, 16) and FCT_Contacts.ContactRaceID <> ${RaceID} and FCT_AlienRace.ContactStatus not in (2, 3)) as IntruderSystems,
      (select count(distinct FCT_Ship.ShipID) from FCT_Ship
        inner join FCT_DamagedComponent on FCT_DamagedComponent.ShipID = FCT_Ship.ShipID
        inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_DamagedComponent.ComponentID
        where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0) as DamagedShips`)

    const named = [
      IntruderSystems > 0 ? counted(IntruderSystems, separator, 'intruder system', 'intruder systems') : null,
      DamagedShips > 0 ? counted(DamagedShips, separator, 'damaged ship', 'damaged ships') : null,
    ].filter(Boolean)

    return named.length ? named.join(', ') : 'No intruders or damage'
  },

  '/log': async ({ database, GameID, RaceID, separator }) => {
    const { Events } = await row(database, `select count(*) as Events from FCT_GameLog
      inner join DIM_EventType on DIM_EventType.EventTypeID = FCT_GameLog.EventType
      inner join FCT_Game on FCT_Game.GameID = FCT_GameLog.GameID
      where FCT_GameLog.GameID = ${GameID} and FCT_GameLog.RaceID = ${RaceID} and FCT_GameLog.Time > FCT_Game.GameTime - ${PEEK_WINDOW_DAYS} * 86400`)

    return `${counted(Events, separator, 'event', 'events')} in ${PEEK_WINDOW_DAYS} days`
  },

  '/minerals': async ({ database, GameID, RaceID, separator }) => {
    const { Bodies, Systems } = await row(database, `select count(distinct FCT_SystemBody.SystemBodyID) as Bodies, count(distinct FCT_SystemBody.SystemID) as Systems from FCT_MineralDeposit
      inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID
      inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}
      where FCT_MineralDeposit.GameID = ${GameID} and FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys where FCT_SystemBodySurveys.GameID = ${GameID} and FCT_SystemBodySurveys.RaceID = ${RaceID})`)

    return `${counted(Bodies, separator, 'body', 'bodies')} in ${counted(Systems, separator, 'system', 'systems')}`
  },

  '/mineral-outlook': async ({ database, GameID, RaceID }) => {
    const stock = await row(database, `select sum(FCT_Population.Duranium) as Duranium, sum(FCT_Population.Neutronium) as Neutronium, sum(FCT_Population.Corbomite) as Corbomite, sum(FCT_Population.Tritanium) as Tritanium, sum(FCT_Population.Boronide) as Boronide, sum(FCT_Population.Mercassium) as Mercassium, sum(FCT_Population.Vendarite) as Vendarite, sum(FCT_Population.Sorium) as Sorium, sum(FCT_Population.Uridium) as Uridium, sum(FCT_Population.Corundium) as Corundium, sum(FCT_Population.Gallicite) as Gallicite from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`)
    const lowest = MINERALS.reduce((least, { name }) => ((stock[name] || 0) < (stock[least.name] || 0) ? { name } : least), MINERALS[0])

    return `Lowest stock: ${lowest.name} ${compactTons(stock[lowest.name] || 0)}`
  },

  '/finances': async ({ database, GameID, RaceID, separator }) => {
    const { WealthPoints } = await row(database, `select FCT_Race.WealthPoints from FCT_Race where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`)

    return `Treasury ${separatedNumber(roundToDecimal(WealthPoints || 0, 0), separator)}`
  },

  '/colony-outlook': async ({ database, GameID, RaceID, separator }) => {
    const { Colonies, Millions } = await row(database, `select count(*) as Colonies, coalesce(sum(FCT_Population.Population), 0) as Millions from FCT_Population
      inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID
      inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
      where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Population > 0`)

    return `${counted(Colonies, separator, 'colony', 'colonies')}, ${people(Millions)}`
  },

  '/logistics': async ({ database, GameID, RaceID }) => {
    const { Litres } = await row(database, `select
      (select coalesce(sum(FCT_Population.FuelStockpile), 0) from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID})
      + (select coalesce(sum(FCT_Ship.Fuel), 0) from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.FuelCapacity > 0) as Litres`)

    return `Fuel stock ${compactLitres(Litres)} L`
  },

  '/hauling': async ({ database, GameID, RaceID, separator }) => {
    const { Routes } = await row(database, `select count(*) as Routes from (select FCT_Fleet.FleetID from FCT_Fleet
      inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID
      inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
      where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0
      group by FCT_Fleet.FleetID having sum(FCT_ShipClass.CargoCapacity) > 0 or sum(FCT_ShipClass.ColonistCapacity) > 0)`)

    return counted(Routes, separator, 'repeating route', 'repeating routes')
  },

  '/map': async ({ database, GameID, RaceID, separator }) => {
    const { Systems } = await row(database, `select count(*) as Systems from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}`)

    return `${counted(Systems, separator, 'system', 'systems')} known`
  },

  '/survey-progress': async ({ database, GameID, RaceID, separator }) => {
    const { Unsurveyed } = await row(database, `select count(*) as Unsurveyed from FCT_RaceSysSurvey
      inner join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID
      left join (select SystemID, count(*) as Locations from FCT_SurveyLocation where GameID = ${GameID} group by SystemID) as VIR_Locations on VIR_Locations.SystemID = FCT_RaceSysSurvey.SystemID
      left join (select SystemID, count(*) as Locations from FCT_RaceSurveyLocation where GameID = ${GameID} and RaceID = ${RaceID} group by SystemID) as VIR_Surveyed on VIR_Surveyed.SystemID = FCT_RaceSysSurvey.SystemID
      left join (select FCT_SystemBody.SystemID, sum(FCT_SystemBody.Radius / 100.0 * (case when FCT_SystemBody.BodyTypeID in (4, 5) then 1 else 10 end)) as Points from FCT_SystemBody
        where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5)
          and FCT_SystemBody.SystemBodyID not in (select SystemBodyID from FCT_SystemBodySurveys where GameID = ${GameID} and RaceID = ${RaceID})
          and FCT_SystemBody.SystemBodyID not in (select SystemBodyID from FCT_BannedBodies where GameID = ${GameID} and RaceID = ${RaceID})
        group by FCT_SystemBody.SystemID) as VIR_Bodies on VIR_Bodies.SystemID = FCT_RaceSysSurvey.SystemID
      where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}
        and max(0, coalesce(VIR_Locations.Locations, 0) - coalesce(VIR_Surveyed.Locations, 0)) * coalesce(FCT_System.JumpPointSurveyPoints, 0) + coalesce(VIR_Bodies.Points, 0) > 0`)

    return `${counted(Unsurveyed, separator, 'system', 'systems')} to survey`
  },

  '/routes': async ({ database, GameID, RaceID, separator }) => {
    const { JumpPoints, Gates } = await row(database, `select count(*) as JumpPoints, coalesce(sum(case when FCT_JumpPoint.JumpGateStrength > 0 then 1 else 0 end), 0) as Gates from FCT_JumpPoint
      inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.Charted = 1 and FCT_RaceJumpPointSurvey.Explored = 1
      inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}
      where FCT_JumpPoint.GameID = ${GameID}`)

    return `${counted(JumpPoints, separator, 'explored jump point', 'explored jump points')}, ${counted(Gates, separator, 'gate', 'gates')}`
  },

  '/lagrange': async ({ database, GameID, RaceID, separator }) => {
    const { Points, Systems } = await row(database, `select count(*) as Points, count(distinct FCT_LagrangePoint.SystemID) as Systems from FCT_LagrangePoint
      inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}
      where FCT_LagrangePoint.GameID = ${GameID}`)

    return `${counted(Points, separator, 'stable point', 'stable points')} in ${counted(Systems, separator, 'system', 'systems')}`
  },

  // Special factions have no Intelligence page.
  '/intelligence': async ({ database, GameID, RaceID, historyRecorded }) => {
    if (!historyRecorded) {
      return null
    }

    const { Races, Hostile } = await row(database, `select count(*) as Races, coalesce(sum(case when FCT_AlienRace.ContactStatus = 0 then 1 else 0 end), 0) as Hostile from FCT_AlienRace
      where FCT_AlienRace.GameID = ${GameID} and FCT_AlienRace.ViewRaceID = ${RaceID}`)

    return `${Races} ${plural(Races, 'race', 'races')}, ${Hostile} hostile`
  },

  // Not a save query: the recorder's file, through the history store's cached getter.
  '/history': async ({ GameID, RaceID, StartYear, separator, historyRecorded, snapshotSummary }) => {
    const summary = historyRecorded ? snapshotSummary(GameID, RaceID) : null

    if (!summary) {
      return null
    }

    return summary.count
      ? `${counted(summary.count, separator, 'snapshot', 'snapshots')}, latest ${gameTime(StartYear, summary.latest).format('YYYY-MM-DD')}`
      : 'No snapshots yet'
  },

  '/commanders': async ({ database, GameID, RaceID, separator }) => {
    const { Vacant } = await row(database, `select count(*) as Vacant from FCT_Population
      where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Population > 0
        and FCT_Population.PopulationID not in (select FCT_Commander.CommandID from FCT_Commander where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.Deceased = 0 and FCT_Commander.CommandID is not null)`)

    return Vacant > 0 ? `${separatedNumber(Vacant, separator)} ${plural(Vacant, 'colony needs', 'colonies need')} a governor` : 'All colonies have governors'
  },

  '/technologies': async ({ database, GameID, RaceID, separator }) => {
    const { Available, Running } = await row(database, `select count(*) as Available, (select count(*) from FCT_ResearchProject where GameID = ${GameID} and RaceID = ${RaceID}) as Running from FCT_TechSystem
      inner join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID
      inner join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = DIM_TechType.FieldID
      where FCT_TechSystem.GameID = 0 and DIM_ResearchField.DoNotDisplay != 1 and FCT_TechSystem.RuinOnly = 0 and FCT_TechSystem.RaceID in (0, ${RaceID})
        and (FCT_TechSystem.Prerequisite1 = 0 or FCT_TechSystem.Prerequisite1 in (select TechID from FCT_RaceTech where GameID = ${GameID} and RaceID = ${RaceID}))
        and (FCT_TechSystem.Prerequisite2 = 0 or FCT_TechSystem.Prerequisite2 in (select TechID from FCT_RaceTech where GameID = ${GameID} and RaceID = ${RaceID}))
        and FCT_TechSystem.TechSystemID not in (select TechID from FCT_RaceTech where GameID = ${GameID} and RaceID = ${RaceID})
        and FCT_TechSystem.TechSystemID not in (select TechID from FCT_ResearchProject where GameID = ${GameID} and RaceID = ${RaceID})
        and FCT_TechSystem.TechSystemID not in (select TechSystemID from FCT_ResearchQueue inner join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID where FCT_ResearchQueue.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID})`)

    return `${separatedNumber(Available, separator)} to research now, ${separatedNumber(Running, separator)} running`
  },

  '/designed-tech': async ({ database, GameID, RaceID, separator }) => {
    const { Components, Obsolete } = await row(database, `select count(*) as Components, coalesce(sum(case when FCT_RaceTech.Obsolete then 1 else 0 end), 0) as Obsolete from FCT_RaceTech
      inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID
      inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID
      inner join DIM_ResearchCategories on DIM_ResearchCategories.CategoryID = FCT_TechSystem.CategoryID and (DIM_ResearchCategories.PlayerDefined or DIM_ResearchCategories.Components)
      where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID} and FCT_TechSystem.RaceID = FCT_RaceTech.RaceID`)

    return `${counted(Components, separator, 'component', 'components')}${Obsolete > 0 ? `, ${Obsolete} obsolete` : ''}`
  },
}
