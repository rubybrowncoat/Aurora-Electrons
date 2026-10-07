import { navalAdminRadius, navalAdminRequiredRanks, systemsWithinJumps } from './minerals'

// The command-type shares a bonus can come from (`DIM_NavalAdminCommandType` columns).
const SHARES = ['Industrial', 'Survey', 'Logistics', 'Engineering', 'CrewTraining', 'Tactical', 'Reaction', 'FleetTraining']

// The race's naval admin commands with one commander bonus, ready for `navalAdminChainBonus`:
// { [NavalAdminCommandID]: { SystemID, ParentCommandID, BonusValue, Share, Eligible, Systems } }.
// `bonusId`: the `FCT_CommanderBonuses.BonusID` (6 Mining, 2 Survey); `share`: the command-type
// column that scales it ('Industrial', 'Survey'). An empty map when no command carries the bonus.
// Radius, required rank and flag bridges: docs/DATABASE.md § Commander bonus rules.
export const loadNavalAdmins = async (database, { GameID, RaceID, bonusId, share }) => {
  if (!SHARES.includes(share)) {
    throw new Error(`Unknown naval admin share: ${share}`)
  }

  const admins = await database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.ParentAdminCommandID as ParentCommandID, FCT_NavalAdminCommand.ShipID, FCT_NavalAdminCommand.MinimumRankPriority, case when FCT_NavalAdminCommand.ShipID > 0 then VIR_Flagship.SystemID else FCT_Population.SystemID end as SystemID, coalesce(VIR_Headquarters.Level, 0) as HeadquartersLevel, FCT_Ranks.Priority as RankPriority, FCT_CommanderBonuses.BonusValue, DIM_NavalAdminCommandType.Radius, DIM_NavalAdminCommandType.${share} as Share from FCT_NavalAdminCommand left join FCT_Population on FCT_Population.PopulationID = FCT_NavalAdminCommand.PopulationID left join (select FCT_PopulationInstallations.PopID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.NavalHeadquartersValue) as Level from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} and DIM_PlanetaryInstallation.NavalHeadquartersValue > 0 group by FCT_PopulationInstallations.PopID) as VIR_Headquarters on VIR_Headquarters.PopID = FCT_NavalAdminCommand.PopulationID left join (select FCT_Ship.ShipID, FCT_Fleet.SystemID from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID}) as VIR_Flagship on VIR_Flagship.ShipID = FCT_NavalAdminCommand.ShipID left join DIM_NavalAdminCommandType on DIM_NavalAdminCommandType.CommandTypeID = FCT_NavalAdminCommand.AdminCommandTypeID left join FCT_Commander on FCT_Commander.CommandID = FCT_NavalAdminCommand.NavalAdminCommandID and FCT_Commander.CommandType = 12 and FCT_Commander.RaceID = FCT_NavalAdminCommand.RaceID left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${Number(bonusId)} where FCT_NavalAdminCommand.GameID = ${GameID} and FCT_NavalAdminCommand.RaceID = ${RaceID}`).then(([items]) => items)

  if (!admins.some((admin) => admin.BonusValue && admin.Share)) {
    return {}
  }

  const captains = await database.query(`select FCT_Fleet.ParentCommandID as NavalAdminCommandID, min(FCT_Ranks.Priority) as RankPriority from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_Commander on FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 1 and FCT_Commander.RaceID = FCT_Ship.RaceID inner join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.ParentCommandID > 0 group by FCT_Fleet.ParentCommandID`).then(([items]) => items)
  const links = await database.query(`select FCT_JumpPoint.SystemID, VIR_Destination.SystemID as DestinationID from FCT_JumpPoint inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.Charted = 1 inner join FCT_JumpPoint as VIR_Destination on VIR_Destination.WarpPointID = FCT_JumpPoint.WPLink inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = VIR_Destination.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID} where FCT_JumpPoint.GameID = ${GameID}`).then(([items]) => items)
  const graph = {}

  links.forEach((link) => {
    ;(graph[link.SystemID] = graph[link.SystemID] || new Set()).add(link.DestinationID)
    ;(graph[link.DestinationID] = graph[link.DestinationID] || new Set()).add(link.SystemID)
  })

  const byId = Object.fromEntries(admins.map((admin) => [admin.NavalAdminCommandID, admin]))
  const required = navalAdminRequiredRanks(byId, Object.fromEntries(captains.map((captain) => [captain.NavalAdminCommandID, captain.RankPriority])))

  return Object.fromEntries(admins.map((admin) => {
    const radius = navalAdminRadius(admin)

    return [admin.NavalAdminCommandID, {
      ...admin,
      Eligible: admin.RankPriority != null && admin.RankPriority <= required[admin.NavalAdminCommandID],
      Systems: radius === null || admin.SystemID == null ? new Set() : systemsWithinJumps(graph, admin.SystemID, radius),
    }]
  }))
}
