import { loadJumpLinks } from './jump-graph'
import { navalAdminRadius, navalAdminRequiredRanks, systemsWithinJumps } from './minerals'

// An assigned commander whose rank cannot be evaluated (no rank, no rank row or no priority) leaves what the command's required rank and its eligibility depend on unknown: the command, and every command above it, whose required rank counts it.
const RANK_UNEVALUABLE = 'the rank of a naval admin commander in this command or below it (FCT_Commander.RankID, FCT_Ranks.Priority) is not in the save'
// Why a command's bonus cannot be applied down its chain when the save lacks the officers' ranks.
const RANKS_UNKNOWN = 'the ranks of the naval admin commanders (FCT_Commander.RankID and FCT_Ranks are not in the save)'
// Why a command's bonus cannot be applied when its commander has the bonus row and the row, or the command type's share, holds no value.
const BONUS_UNKNOWN = 'the value of a naval admin commander\'s bonus, or the share of its command type (FCT_CommanderBonuses.BonusValue, DIM_NavalAdminCommandType)'
const NO_BLOCKED = new Set()

// The command-type shares a bonus can come from (`DIM_NavalAdminCommandType` columns).
const SHARES = ['Industrial', 'Survey', 'Logistics', 'Engineering', 'CrewTraining', 'Tactical', 'Reaction', 'FleetTraining']

// The tables and columns `loadNavalAdmins` reads, { [table]: [column] }, for a loader that must know before it runs whether the save has them. `share` is the command-type column it takes. The ranks' own are in `NAVAL_ADMIN_RANK_READS` and count only with `ranks`. A loader that finds one missing leaves the commands unknown instead of letting the query fail.
export const navalAdminReads = (share) => ({
  FCT_NavalAdminCommand: ['NavalAdminCommandID', 'ParentAdminCommandID', 'ShipID', 'MinimumRankPriority', 'PopulationID', 'AdminCommandTypeID', 'GameID', 'RaceID'],
  FCT_Population: ['PopulationID', 'SystemID'],
  FCT_PopulationInstallations: ['PopID', 'Amount', 'PlanetaryInstallationID', 'GameID'],
  DIM_PlanetaryInstallation: ['PlanetaryInstallationID', 'NavalHeadquartersValue'],
  FCT_Ship: ['ShipID', 'FleetID', 'GameID', 'RaceID'],
  FCT_Fleet: ['FleetID', 'SystemID', 'GameID', 'RaceID'],
  DIM_NavalAdminCommandType: ['CommandTypeID', 'Radius', share],
  FCT_Commander: ['CommanderID', 'CommandID', 'CommandType', 'RaceID'],
  FCT_CommanderBonuses: ['CommanderID', 'BonusID', 'BonusValue'],
  FCT_JumpPoint: ['SystemID', 'WarpPointID', 'WPLink', 'GameID'],
  FCT_RaceJumpPointSurvey: ['WarpPointID', 'RaceID', 'Charted', 'Explored'],
  FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'GameID'],
})

// What the officers' ranks add to `navalAdminReads`: without them `loadNavalAdmins` runs with `ranks: false` and every command's chain is unknown.
export const NAVAL_ADMIN_RANK_READS = Object.freeze({
  FCT_Commander: Object.freeze(['RankID']),
  FCT_Ranks: Object.freeze(['RankID', 'Priority']),
  FCT_Fleet: Object.freeze(['ParentCommandID']),
})

// The race's naval admin commands with one commander bonus, ready for `navalAdminChainBonus`: { [NavalAdminCommandID]: { SystemID, ParentCommandID, BonusValue, Share, Eligible, Systems } }. `bonusId`: the `FCT_CommanderBonuses.BonusID` (6 Mining, 2 Survey); `share`: the command-type column that scales it ('Industrial', 'Survey'). An empty map when no command carries the bonus. Radius, required rank and flag bridges: docs/DATABASE.md § Commander bonus rules.
export const loadNavalAdmins = async (database, { GameID, RaceID, bonusId, share, ranks = true, blocked = NO_BLOCKED }) => {
  if (!SHARES.includes(share)) {
    throw new Error(`Unknown naval admin share: ${share}`)
  }

  const admins = await database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.ParentAdminCommandID as ParentCommandID, FCT_NavalAdminCommand.ShipID, FCT_NavalAdminCommand.MinimumRankPriority, case when FCT_NavalAdminCommand.ShipID > 0 then VIR_Flagship.SystemID else FCT_Population.SystemID end as SystemID, coalesce(VIR_Headquarters.Level, 0) as HeadquartersLevel, ${ranks ? 'FCT_Ranks.Priority' : 'null'} as RankPriority, FCT_CommanderBonuses.BonusValue, FCT_CommanderBonuses.CommanderID is not null as BonusRow, FCT_Commander.CommanderID is not null as Assigned, DIM_NavalAdminCommandType.Radius, DIM_NavalAdminCommandType.${share} as Share from FCT_NavalAdminCommand left join FCT_Population on FCT_Population.PopulationID = FCT_NavalAdminCommand.PopulationID left join (select FCT_PopulationInstallations.PopID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.NavalHeadquartersValue) as Level from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} and DIM_PlanetaryInstallation.NavalHeadquartersValue > 0 group by FCT_PopulationInstallations.PopID) as VIR_Headquarters on VIR_Headquarters.PopID = FCT_NavalAdminCommand.PopulationID left join (select FCT_Ship.ShipID, FCT_Fleet.SystemID from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID}) as VIR_Flagship on VIR_Flagship.ShipID = FCT_NavalAdminCommand.ShipID left join DIM_NavalAdminCommandType on DIM_NavalAdminCommandType.CommandTypeID = FCT_NavalAdminCommand.AdminCommandTypeID left join FCT_Commander on FCT_Commander.CommandID = FCT_NavalAdminCommand.NavalAdminCommandID and FCT_Commander.CommandType = 12 and FCT_Commander.RaceID = FCT_NavalAdminCommand.RaceID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${Number(bonusId)}${ranks ? ' left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID' : ''} where FCT_NavalAdminCommand.GameID = ${GameID} and FCT_NavalAdminCommand.RaceID = ${RaceID}`).then(([items]) => items)

  const withheld = blocked.has(Number(bonusId)) ? `commander bonus ${bonusId} (its lookup row in the save does not read as expected)` : null

  if (!withheld && !admins.some((admin) => (admin.BonusValue && admin.Share) || admin.BonusRow)) {
    return {}
  }

  const captains = !ranks ? [] : await database.query(`select FCT_Fleet.ParentCommandID as NavalAdminCommandID, min(FCT_Ranks.Priority) as RankPriority, sum(FCT_Ranks.Priority is null) as Unranked from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_Commander on FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 1 and FCT_Commander.RaceID = FCT_Ship.RaceID left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.ParentCommandID > 0 group by FCT_Fleet.ParentCommandID`).then(([items]) => items)
  const links = await loadJumpLinks(database, { GameID, RaceID })
  const graph = {}

  links.forEach((link) => {
    ;(graph[link.SystemID] = graph[link.SystemID] || new Set()).add(link.DestinationID)
    ;(graph[link.DestinationID] = graph[link.DestinationID] || new Set()).add(link.SystemID)
  })

  const byId = Object.fromEntries(admins.map((admin) => [admin.NavalAdminCommandID, admin]))
  const required = ranks ? navalAdminRequiredRanks(byId, Object.fromEntries(captains.map((captain) => [captain.NavalAdminCommandID, captain.RankPriority]))) : {}

  // The commands whose eligibility rests on a rank that cannot be evaluated: those whose own commander's rank cannot, those with a ship commander in a directly attached fleet whose rank cannot, and each one above them (a required rank counts the ranks below it). A vacant command is never eligible, so it is not unknown.
  const reached = new Set()
  const seeds = ranks ? [...admins.filter((admin) => admin.Assigned && !Number.isFinite(admin.RankPriority)), ...captains.filter((captain) => captain.Unranked > 0).map((captain) => byId[captain.NavalAdminCommandID]).filter(Boolean)] : []

  seeds.forEach((seed) => {
    for (let current = seed; current && !reached.has(current.NavalAdminCommandID); current = byId[current.ParentCommandID]) {
      reached.add(current.NavalAdminCommandID)
    }
  })

  const unranked = new Set([...reached].filter((id) => byId[id].Assigned))

  return Object.fromEntries(admins.map((admin) => {
    const radius = navalAdminRadius(admin)
    const unevaluable = unranked.has(admin.NavalAdminCommandID)

    return [admin.NavalAdminCommandID, {
      ...admin,
      Eligible: ranks ? admin.RankPriority != null && admin.RankPriority <= required[admin.NavalAdminCommandID] : null,
      Unknown: withheld || (ranks ? null : RANKS_UNKNOWN),
      BonusUnknown: admin.BonusRow && !(Number.isFinite(admin.BonusValue) && Number.isFinite(admin.Share)) ? BONUS_UNKNOWN : null,
      Systems: admin.SystemID == null ? new Set() : systemsWithinJumps(graph, admin.SystemID, radius),
      ...(unevaluable ? { Eligible: null, Unknown: withheld || RANK_UNEVALUABLE } : {}),
    }]
  }))
}
