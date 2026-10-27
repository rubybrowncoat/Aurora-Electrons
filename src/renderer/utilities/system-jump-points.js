// The jump points of one system as the System view draws them: the points the race has charted there, and for each only what the race may see of it. Where a point leads is known only once the point is explored, so the far system's id and name are read for an explored point alone; the link, the builder of the gate and the flags the race does not read are never selected. A gate is a point with a gate strength above 0.

import { FAR_SIDE_TEXT } from './jump-infrastructure'

// The charted jump points of `SystemID` (the system must be known to the race): { WarpPointID, SystemID, Xcor, Ycor, JumpGateStrength, Explored, DestinationID, DestinationName }. The last two are null for a point that is not explored, and for an explored one whose far system the race does not know.
export const loadSystemJumpPoints = async (database, { GameID, RaceID, SystemID }) => {
  const [rows] = await database.query(`select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.SystemID, FCT_JumpPoint.Xcor, FCT_JumpPoint.Ycor, FCT_JumpPoint.JumpGateStrength, FCT_RaceJumpPointSurvey.Explored, FarSystem.SystemID as DestinationID, FarSystem.Name as DestinationName
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.GameID = FCT_JumpPoint.GameID and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_JumpPoint.GameID
left join FCT_JumpPoint as FarPoint on FCT_RaceJumpPointSurvey.Explored = 1 and FarPoint.WarpPointID = FCT_JumpPoint.WPLink and FarPoint.GameID = FCT_JumpPoint.GameID
left join FCT_RaceSysSurvey as FarSystem on FarSystem.SystemID = FarPoint.SystemID and FarSystem.RaceID = ${RaceID} and FarSystem.GameID = FCT_JumpPoint.GameID
where FCT_JumpPoint.GameID = ${GameID} and FCT_JumpPoint.SystemID = ${SystemID}`)

  return rows
}

// How a point of `loadSystemJumpPoints` is drawn: { explored, gate, label, destinationId }. The label is the far system's name for an explored point whose far system the race knows, else the word of FAR_SIDE_TEXT for the point: an unexplored point never names a system, whatever its row carries.
export const jumpPointLook = (point) => {
  const explored = Number(point.Explored) === 1
  const name = point.DestinationName === null || point.DestinationName === undefined ? '' : String(point.DestinationName).trim()

  return {
    explored,
    gate: point.JumpGateStrength > 0,
    label: explored && name ? name : FAR_SIDE_TEXT[explored ? 'uncharted' : 'unexplored'],
    destinationId: explored && point.DestinationID ? point.DestinationID : null,
  }
}
