// What the Galaxy Map can mark at each system, read through what the race knows, as the game shows it: ruins and ancient constructs only on bodies the race has surveyed; aether rifts and wrecks in every system it knows (the game counts every one there, whoever left it); the race's own ships, shipyards and waypoints; the alien contacts it holds now; and how many bodies there its species could live on. Keyed by SystemID as a string, with only the systems that have something.

import groupBy from 'lodash/groupBy'
import { systemBodyName } from './aurora'
import { loadSpecies } from './colonization-data'
import { BODY_CLASS, BODY_TYPE, costFactors, speciesLimits } from './habitability'

const rows = (database, sql) => database.query(sql).then(([items]) => items)

// A body the race has surveyed in a system it knows, with what its name needs.
const surveyedBody = (GameID, RaceID) => `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID}`

const BODY_COLUMNS = 'FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName'

// A ruin is found once the body is surveyed. Ground forces able to study it then identify the race that built it, and construction brigades recover its abandoned installations until none are left.
export const ruinState = (ruin) => (!ruin.factories ? 'used' : ruin.known ? 'identified' : 'found')

// Alien races as the race regards them, by FCT_AlienRace.ContactStatus, and the order a system with contacts of several shows them in: the most threatening first. A race not yet identified comes after the hostile.
const CONTACT_STATUSES = ['hostile', 'neutral', 'friendly', 'allied', 'civilian']

export const CONTACT_ORDER = ['hostile', 'unknown', 'neutral', 'friendly', 'allied', 'civilian']

export const NO_FEATURES = Object.freeze({ ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, warships: 0, ships: 0, shipyards: 0, waypoints: 0, contacts: [] })

export const loadMapFeatures = async (database, { GameID, RaceID }) => {
  const [ruins, constructs, rifts, wrecks, ships, shipyards, waypoints, contacts] = await Promise.all([
    rows(database, `select ${BODY_COLUMNS}, DIM_Ruin.Description as Ruin, FCT_SystemBody.AbandonedFactories, FCT_RuinRace.Name as RuinRaceName, FCT_KnownRuinRace.RuinRaceID is not null as Known
from FCT_SystemBody
${surveyedBody(GameID, RaceID)}
left join DIM_Ruin on DIM_Ruin.RuinID = FCT_SystemBody.RuinID
left join FCT_RuinRace on FCT_RuinRace.RuinRaceID = FCT_SystemBody.RuinRaceID and FCT_RuinRace.GameID = FCT_SystemBody.GameID
left join FCT_KnownRuinRace on FCT_KnownRuinRace.RuinRaceID = FCT_SystemBody.RuinRaceID and FCT_KnownRuinRace.GameID = FCT_SystemBody.GameID and FCT_KnownRuinRace.RaceID = ${RaceID}
where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.RuinID > 0`),
    rows(database, `select ${BODY_COLUMNS}, FCT_AncientConstruct.Active, FCT_AncientConstruct.ResearchBonus, DIM_ResearchField.FieldName
from FCT_AncientConstruct
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID
${surveyedBody(GameID, RaceID)}
left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_AncientConstruct.ResearchField
where FCT_AncientConstruct.GameID = ${GameID}`),
    rows(database, `select FCT_AetherRift.SystemID, count(*) as Rifts
from FCT_AetherRift
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_AetherRift.SystemID and FCT_RaceSysSurvey.GameID = FCT_AetherRift.GameID and FCT_RaceSysSurvey.RaceID = ${RaceID}
where FCT_AetherRift.GameID = ${GameID}
group by FCT_AetherRift.SystemID`),
    rows(database, `select FCT_Wrecks.SystemID, count(*) as Wrecks
from FCT_Wrecks
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Wrecks.SystemID and FCT_RaceSysSurvey.GameID = FCT_Wrecks.GameID and FCT_RaceSysSurvey.RaceID = ${RaceID}
where FCT_Wrecks.GameID = ${GameID}
group by FCT_Wrecks.SystemID`),
    // The game's protection for a system adds up the protection value of each warship there that can move;
    // a ship of a civilian shipping line is no ship of the race's own fleets.
    rows(database, `select FCT_Fleet.SystemID, sum(case when FCT_ShipClass.ProtectionValue > 0 and FCT_ShipClass.MaxSpeed > 0 then FCT_ShipClass.ProtectionValue else 0 end) as Protection, sum(FCT_ShipClass.ProtectionValue > 0) as Warships, sum(FCT_Ship.ShippingLineID = 0) as Ships
from FCT_Ship
inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID
inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.Destroyed = 0
group by FCT_Fleet.SystemID`),
    rows(database, `select FCT_Population.SystemID, count(*) as Shipyards
from FCT_Shipyard
inner join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID
where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID}
group by FCT_Population.SystemID`),
    rows(database, `select FCT_Waypoint.SystemID, count(*) as Waypoints from FCT_Waypoint where FCT_Waypoint.GameID = ${GameID} and FCT_Waypoint.RaceID = ${RaceID} group by FCT_Waypoint.SystemID`),
    // Contacts the race holds now: the game updates each one it still detects to the current time. One contact can have a row for each way it is detected.
    rows(database, `select FCT_Contacts.SystemID, FCT_AlienRace.ContactStatus, count(distinct FCT_Contacts.ContactType || ':' || FCT_Contacts.ContactID) as Contacts
from FCT_Contacts
inner join FCT_Game on FCT_Game.GameID = FCT_Contacts.GameID
left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Contacts.GameID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.AlienRaceID = FCT_Contacts.ContactRaceID
where FCT_Contacts.GameID = ${GameID} and FCT_Contacts.DetectRaceID = ${RaceID} and FCT_Contacts.ContactRaceID != ${RaceID} and FCT_Contacts.LastUpdate = FCT_Game.GameTime
group by FCT_Contacts.SystemID, FCT_AlienRace.ContactStatus`),
  ])

  const features = {}
  const of = (systemId) => {
    const id = String(systemId)

    features[id] = features[id] || { ...NO_FEATURES, ruins: [], constructs: [], contacts: [] }

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
  shipyards.forEach((row) => {
    of(row.SystemID).shipyards = row.Shipyards
  })
  waypoints.forEach((row) => {
    of(row.SystemID).waypoints = row.Waypoints
  })
  contacts.forEach((row) => of(row.SystemID).contacts.push({ status: CONTACT_STATUSES[row.ContactStatus] || 'unknown', count: row.Contacts }))
  Object.values(features).forEach((system) => system.contacts.sort((a, b) => CONTACT_ORDER.indexOf(a.status) - CONTACT_ORDER.indexOf(b.status)))

  return Object.freeze(features)
}

// The bands of colony cost the game counts in a system's summary: habitable under 2, low cost under 3 and medium cost under 5. The game scales each by the race's colonisation tech; the costs here leave the tech out, which comes to the same.
export const COLONY_COST_BANDS = [2, 3, 5]

// How many bodies of each known system fall in each band, as the game counts them for the species the race lives as (its capital's, else its largest): every body's cost now, but for the bodies it can't colonise at all (gas giants, fixed bodies and those too heavy for the species). Returns { species, systems }: the species' name, null for a race without one, and per SystemID as a string one count per band, only for systems with a body in one.
export const loadHabitability = async (database, { GameID, RaceID }) => {
  const [species, [capital]] = await Promise.all([
    loadSpecies(database, { GameID, RaceID }),
    rows(database, `select FCT_Population.SpeciesID from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Capital = 1`),
  ])
  const chosen = (capital && species.find((row) => row.SpeciesID === capital.SpeciesID)) || species[0]

  if (!chosen) {
    return Object.freeze({ species: null, systems: {} })
  }

  const limits = speciesLimits(chosen)
  const top = COLONY_COST_BANDS[COLONY_COST_BANDS.length - 1]
  const tidal = `(case when FCT_SystemBody.TidalLock and FCT_SystemBody.BodyClass != ${BODY_CLASS.MOON} then 5 else 1 end)`
  // Besides the bodies the game can't colonise, this leaves out those whose temperature or pressure alone put them past the last band: each factor is a floor under the cost (see costFactors). On a 2,300-system galaxy that keeps a third of the bodies, and they come one row per system, packed in a string: 0.8 seconds, where a row per body took 4.
  const where = `FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.BodyTypeID not in (${BODY_TYPE.GAS_GIANT}, ${BODY_TYPE.SUPERJOVIAN}) and FCT_SystemBody.FixedBody = 0 and FCT_SystemBody.Gravity <= ${limits.MaximumGravity}
and (FCT_SystemBody.AtmosPress <= ${limits.MaximumPressure} or FCT_SystemBody.AtmosPress < ${top * limits.MaximumPressure})
and FCT_SystemBody.SurfaceTemp > ${limits.MinimumTemperature} - ${top * limits.TemperatureDeviation} * ${tidal}
and FCT_SystemBody.SurfaceTemp < ${limits.MaximumTemperature} + ${top * limits.TemperatureDeviation} * ${tidal}`
  const known = `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}`
  const [packed, gases] = await Promise.all([
    rows(database, `select FCT_SystemBody.SystemID, group_concat(FCT_SystemBody.SystemBodyID || ',' || FCT_SystemBody.BodyClass || ',' || FCT_SystemBody.TidalLock || ',' || FCT_SystemBody.AtmosPress || ',' || FCT_SystemBody.HydroExt || ',' || FCT_SystemBody.Gravity || ',' || FCT_SystemBody.SurfaceTemp, ';') as Bodies
from FCT_SystemBody
${known}
where ${where}
group by FCT_SystemBody.SystemID`),
    rows(database, `select FCT_AtmosphericGas.SystemBodyID, FCT_AtmosphericGas.AtmosGasID, FCT_AtmosphericGas.AtmosGasAmount, FCT_AtmosphericGas.GasAtm, FCT_AtmosphericGas.FrozenOut, DIM_Gases.Dangerous, DIM_Gases.DangerousLevel
from FCT_AtmosphericGas
inner join DIM_Gases on DIM_Gases.GasID = FCT_AtmosphericGas.AtmosGasID
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AtmosphericGas.SystemBodyID
${known}
where ${where}`),
  ])
  const atmospheres = groupBy(gases, 'SystemBodyID')
  const systems = {}

  packed.forEach(({ SystemID, Bodies }) => {
    const counts = COLONY_COST_BANDS.map(() => 0)

    Bodies.split(';').forEach((text) => {
      const [id, BodyClass, TidalLock, AtmosPress, HydroExt, Gravity, SurfaceTemp] = text.split(',').map(Number)
      const { cost } = costFactors({ BodyClass, TidalLock, AtmosPress, HydroExt, Gravity, Atmosphere: atmospheres[id] || [] }, limits, SurfaceTemp)
      const band = COLONY_COST_BANDS.findIndex((limit) => cost < limit)

      if (band >= 0) {
        counts[band] += 1
      }
    })

    if (counts.some(Boolean)) {
      systems[SystemID] = counts
    }
  })

  return Object.freeze({ species: chosen.SpeciesName, systems: Object.freeze(systems) })
}
