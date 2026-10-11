// What the Galaxy Map can mark at each system, read through what the race knows, as the game shows it:
// ruins and ancient constructs only on bodies the race has surveyed; aether rifts and wrecks in every system
// it knows (the game counts every one there, whoever left it); and the race's own ships. Keyed by SystemID as
// a string, with only the systems that have something.

import { systemBodyName } from './aurora'

const rows = (database, sql) => database.query(sql).then(([items]) => items)

// A body the race has surveyed in a system it knows, with what its name needs.
const surveyedBody = (GameID, RaceID) => `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID}`

const BODY_COLUMNS = 'FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName'

// A ruin is found once the body is surveyed. Ground forces able to study it then identify the race that
// built it, and construction brigades recover its abandoned installations until none are left.
export const ruinState = (ruin) => (!ruin.factories ? 'used' : ruin.known ? 'identified' : 'found')

export const loadMapFeatures = async (database, { GameID, RaceID }) => {
  const [ruins, constructs, rifts, wrecks, ships] = await Promise.all([
    rows(
      database,
      `select ${BODY_COLUMNS}, DIM_Ruin.Description as Ruin, FCT_SystemBody.AbandonedFactories, FCT_RuinRace.Name as RuinRaceName, FCT_KnownRuinRace.RuinRaceID is not null as Known
from FCT_SystemBody
${surveyedBody(GameID, RaceID)}
left join DIM_Ruin on DIM_Ruin.RuinID = FCT_SystemBody.RuinID
left join FCT_RuinRace on FCT_RuinRace.RuinRaceID = FCT_SystemBody.RuinRaceID and FCT_RuinRace.GameID = FCT_SystemBody.GameID
left join FCT_KnownRuinRace on FCT_KnownRuinRace.RuinRaceID = FCT_SystemBody.RuinRaceID and FCT_KnownRuinRace.GameID = FCT_SystemBody.GameID and FCT_KnownRuinRace.RaceID = ${RaceID}
where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.RuinID > 0`
    ),
    rows(
      database,
      `select ${BODY_COLUMNS}, FCT_AncientConstruct.Active, FCT_AncientConstruct.ResearchBonus, DIM_ResearchField.FieldName
from FCT_AncientConstruct
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID
${surveyedBody(GameID, RaceID)}
left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_AncientConstruct.ResearchField
where FCT_AncientConstruct.GameID = ${GameID}`
    ),
    rows(
      database,
      `select FCT_AetherRift.SystemID, count(*) as Rifts
from FCT_AetherRift
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_AetherRift.SystemID and FCT_RaceSysSurvey.GameID = FCT_AetherRift.GameID and FCT_RaceSysSurvey.RaceID = ${RaceID}
where FCT_AetherRift.GameID = ${GameID}
group by FCT_AetherRift.SystemID`
    ),
    rows(
      database,
      `select FCT_Wrecks.SystemID, count(*) as Wrecks
from FCT_Wrecks
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Wrecks.SystemID and FCT_RaceSysSurvey.GameID = FCT_Wrecks.GameID and FCT_RaceSysSurvey.RaceID = ${RaceID}
where FCT_Wrecks.GameID = ${GameID}
group by FCT_Wrecks.SystemID`
    ),
    // The game's protection for a system adds up the protection value of each warship there that can move;
    // a ship of a civilian shipping line is no ship of the race's own fleets.
    rows(
      database,
      `select FCT_Fleet.SystemID, sum(case when FCT_ShipClass.ProtectionValue > 0 and FCT_ShipClass.MaxSpeed > 0 then FCT_ShipClass.ProtectionValue else 0 end) as Protection, sum(FCT_ShipClass.ProtectionValue > 0) as Warships, sum(FCT_Ship.ShippingLineID = 0) as Ships
from FCT_Ship
inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID
inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.Destroyed = 0
group by FCT_Fleet.SystemID`
    ),
  ])

  const features = {}
  const of = (systemId) => {
    const id = String(systemId)

    features[id] = features[id] || { ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, warships: 0, ships: 0 }

    return features[id]
  }

  ruins.forEach((row) => of(row.SystemID).ruins.push({ body: systemBodyName(row), ruin: row.Ruin || 'Ruins', race: row.Known ? row.RuinRaceName : null, known: Boolean(row.Known), factories: row.AbandonedFactories || 0 }))
  constructs.forEach((row) => of(row.SystemID).constructs.push({ body: systemBodyName(row), active: Boolean(row.Active), field: row.FieldName || 'an unknown field', bonus: row.ResearchBonus || 1 }))
  rifts.forEach((row) => {
    of(row.SystemID).rifts = row.Rifts
  })
  wrecks.forEach((row) => {
    of(row.SystemID).wrecks = row.Wrecks
  })
  ships.forEach((row) => Object.assign(of(row.SystemID), { protection: row.Protection || 0, warships: row.Warships || 0, ships: row.Ships || 0 }))

  return Object.freeze(features)
}
