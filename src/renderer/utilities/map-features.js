// What the Galaxy Map can mark at each system, read through what the race knows, as the game shows it: ruins and ancient constructs only on bodies the race has surveyed; aether rifts and wrecks in every system it knows (the game counts every one there, whoever left it); the race's own ships, shipyards and waypoints; the alien contacts it holds now; and how many bodies there its species could live on. Keyed by SystemID as a string, with only the systems that have something.

import groupBy from 'lodash/groupBy'
import { systemBodyName } from './aurora'
import { loadSpecies } from './colonization-data'
import { BODY_CLASS, BODY_TYPE, costFactors, speciesLimits } from './habitability'
import { versionAssumptions } from './map-figures'
import { ofRule, registerRule, unavailable } from './provenance'

const rows = (database, sql) => database.query(sql).then(([items]) => items)

// A body the race has surveyed in a system it knows, with what its name needs.
const surveyedBody = (GameID, RaceID) => `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID}
inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID}`

const BODY_COLUMNS = 'FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName'

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
const FEATURE_VERSIONS = ['2.7.x']

registerRule({
  id: 'map.ruinState',
  versions: FEATURE_VERSIONS,
  units: 'state',
  verification: 'confirmed',
  structure: ['FCT_SystemBody.AbandonedFactories, RuinRaceID', 'FCT_KnownRuinRace'],
  note: 'The state of a ruin as the stored values give it: no abandoned installations left is used, a builder race the race has identified is identified, else found. A ruin with no stored count of installations has no state. What each state means for play is read from the stored values, not checked in the game.',
})

registerRule({
  id: 'map.constructBonus',
  versions: FEATURE_VERSIONS,
  units: '%',
  verification: 'confirmed',
  structure: ['FCT_AncientConstruct.ResearchBonus, Active'],
  note: 'The research bonus of an active ancient construct, the stored multiplier less one in percent. A construct with no stored bonus has none shown.',
})

registerRule({
  id: 'map.dangerFlag',
  versions: FEATURE_VERSIONS,
  units: 'flag',
  verification: 'assumed',
  structure: ['FCT_RaceSysSurvey.DangerRating', 'FCT_ShipClass.ProtectionValue, MaxSpeed', 'FCT_Ship', 'FCT_Fleet.SystemID'],
  note: 'Whether the protection of the race\'s ships in a system, rounded, falls short of its danger rating. The comparison is a planner rule that is not checked against the game. A system with no ships of the race has a protection of 0; a ship class with no stored protection or speed leaves the protection unknown.',
})

// A ruin's state as a result of 'map.ruinState' (value 'used', 'identified' or 'found'), unavailable when its installations left are not stored. A ruin with ground forces to study it is identified once its builders are known; construction brigades recover its installations until none are left.
export const ruinState = (ruin) => (Number.isFinite(ruin.factories) ? ofRule({ rule: 'map.ruinState', value: ruin.factories <= 0 ? 'used' : ruin.known ? 'identified' : 'found', inputs: { present: ['the installations left', 'whether its builders are known'] } }) : unavailable({ rule: 'map.ruinState', missing: ['the installations left on the ruin'] }))

// An active construct's research bonus as a result of 'map.constructBonus', in percent; unavailable when no bonus is stored.
export const constructBonus = (construct) => (Number.isFinite(construct.bonus) ? ofRule({ rule: 'map.constructBonus', value: Math.round((construct.bonus - 1) * 100), inputs: { present: ['the construct\'s research bonus'] } }) : unavailable({ rule: 'map.constructBonus', missing: ['the construct\'s research bonus'] }))

// Whether the race's ships in a system fall short of its danger, a result of 'map.dangerFlag' (value true or false): `protection` is null when a ship class there has no stored protection or speed, and 0 where the race has no ships there.
export const dangerFlag = (danger, protection) => {
  const missing = [!Number.isFinite(danger) && 'the system\'s danger rating', !Number.isFinite(protection) && 'the protection of the ships there'].filter(Boolean)

  return missing.length ? unavailable({ rule: 'map.dangerFlag', missing }) : ofRule({ rule: 'map.dangerFlag', value: Math.round(protection) < danger, inputs: { present: ['the danger rating', 'the protection of the ships there'] } })
}

// Alien races as the race regards them, by FCT_AlienRace.ContactStatus, and the order a system with contacts of several shows them in: the most threatening first. A race not yet identified comes after the hostile.
const CONTACT_STATUSES = ['hostile', 'neutral', 'friendly', 'allied', 'civilian']

export const CONTACT_ORDER = ['hostile', 'unknown', 'neutral', 'friendly', 'allied', 'civilian']

export const NO_FEATURES = Object.freeze({ ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, military: 0, ships: 0, shipyards: 0, waypoints: 0, contacts: [] })

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
    // The game's protection for a system adds up the protection value of each ship there that has one and can move. Military ships are those of a class not marked commercial, survey ships included. `UnknownClasses` counts the ships whose class has no stored protection value (or no speed, where it has a value).
    // A ship of a civilian shipping line is no ship of the race's own fleets.
    rows(database, `select FCT_Fleet.SystemID, sum(case when FCT_ShipClass.ProtectionValue > 0 and FCT_ShipClass.MaxSpeed > 0 then FCT_ShipClass.ProtectionValue else 0 end) as Protection, sum(FCT_ShipClass.ProtectionValue is null or (FCT_ShipClass.ProtectionValue > 0 and FCT_ShipClass.MaxSpeed is null)) as UnknownClasses, sum(FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.Commercial = 0) as Military, sum(FCT_Ship.ShippingLineID = 0) as Ships
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

  ruins.forEach((row) => of(row.SystemID).ruins.push({ body: systemBodyName(row), ruin: row.Ruin || 'Ruins', race: row.Known ? row.RuinRaceName : null, known: Boolean(row.Known), factories: Number.isFinite(row.AbandonedFactories) ? row.AbandonedFactories : null }))
  constructs.forEach((row) => of(row.SystemID).constructs.push({ body: systemBodyName(row), active: Boolean(row.Active), field: row.FieldName || 'an unknown field', bonus: Number.isFinite(row.ResearchBonus) ? row.ResearchBonus : null }))
  rifts.forEach((row) => {
    of(row.SystemID).rifts = row.Rifts
  })
  wrecks.forEach((row) => {
    of(row.SystemID).wrecks = row.Wrecks
  })
  ships.forEach((row) => Object.assign(of(row.SystemID), { protection: row.UnknownClasses > 0 ? null : row.Protection || 0, military: row.Military || 0, ships: row.Ships || 0 }))
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

// How many bodies of each known system fall in each band, as the game counts them for the species the race lives as (its capital's, else its largest): every body's cost now, but for the bodies it can't colonise at all (gas giants, fixed bodies and those too heavy for the species). Returns { species, systems, gaps }: the species' name, null for a race without one, per SystemID as a string one count per band, only for systems with a body in one, and per SystemID as a string the number of bodies whose cost can't be told because the save lacks an input it needs (a body whose test the missing value leaves undecided, or a gas with no stored amount), only for systems with such a body: their counts and bands are lower bounds.
export const loadHabitability = async (database, { GameID, RaceID }) => {
  const [species, [capital]] = await Promise.all([
    loadSpecies(database, { GameID, RaceID }),
    rows(database, `select FCT_Population.SpeciesID from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Capital = 1`),
  ])
  const chosen = (capital && species.find((row) => row.SpeciesID === capital.SpeciesID)) || species[0]

  if (!chosen) {
    return Object.freeze({ species: null, systems: {}, gaps: {} })
  }

  const limits = speciesLimits(chosen)
  const top = COLONY_COST_BANDS[COLONY_COST_BANDS.length - 1]
  // The tidal multiplier of the filters (see costFactors): a moon never takes it and a body not tidally locked neither; a body whose lock or class the save lacks, and could be a locked planet, takes the widest reading (×5), so it is kept (and counted as a gap) unless even that excludes it.
  const tidal = `(case when FCT_SystemBody.BodyClass = ${BODY_CLASS.MOON} then 1 when FCT_SystemBody.TidalLock is not null and not FCT_SystemBody.TidalLock then 1 else 5 end)`
  // Besides the bodies the game can't colonise, this leaves out those whose temperature or pressure alone put them past the last band: each factor is a floor under the cost (see costFactors). On a 2,300-system galaxy that keeps a third of the bodies, and they come one row per system, packed in a string: 0.8 seconds, where a row per body took 4.
  const filters = `FCT_SystemBody.BodyTypeID not in (${BODY_TYPE.GAS_GIANT}, ${BODY_TYPE.SUPERJOVIAN}) and FCT_SystemBody.FixedBody = 0 and FCT_SystemBody.Gravity <= ${limits.MaximumGravity}
and (FCT_SystemBody.AtmosPress <= ${limits.MaximumPressure} or FCT_SystemBody.AtmosPress < ${top * limits.MaximumPressure})
and FCT_SystemBody.SurfaceTemp > ${limits.MinimumTemperature} - ${top * limits.TemperatureDeviation} * ${tidal}
and FCT_SystemBody.SurfaceTemp < ${limits.MaximumTemperature} + ${top * limits.TemperatureDeviation} * ${tidal}`
  const where = `FCT_SystemBody.GameID = ${GameID} and ${filters}`
  // The fields a body is packed with: a null among them drops the body from the packed string. A moon's tidal lock cannot change its cost, so a moon with none stored is packed as not locked.
  const fields = `FCT_SystemBody.SystemBodyID || ',' || FCT_SystemBody.BodyClass || ',' || (case when FCT_SystemBody.BodyClass = ${BODY_CLASS.MOON} then coalesce(FCT_SystemBody.TidalLock, 0) else FCT_SystemBody.TidalLock end) || ',' || FCT_SystemBody.AtmosPress || ',' || FCT_SystemBody.HydroExt || ',' || FCT_SystemBody.Gravity || ',' || FCT_SystemBody.SurfaceTemp`
  const known = `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}`
  const [packed, gases, undecided, gasGaps] = await Promise.all([
    rows(database, `select FCT_SystemBody.SystemID, group_concat(${fields}, ';') as Bodies
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
    // Bodies the filters above neither keep nor drop: a missing value leaves a test undecided, or the packing loses a field.
    rows(database, `select FCT_SystemBody.SystemID, count(*) as Bodies
from FCT_SystemBody
${known}
where FCT_SystemBody.GameID = ${GameID} and (((${filters}) is null) or ((${filters}) and ((${fields}) is null)))
group by FCT_SystemBody.SystemID`),
    // The bodies that pass the filters, whole in every packed field, with a gas whose amounts or danger the save lacks: their cost is not told, so they stay out of the band counts.
    rows(database, `select distinct FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID
from FCT_AtmosphericGas
left join DIM_Gases on DIM_Gases.GasID = FCT_AtmosphericGas.AtmosGasID
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AtmosphericGas.SystemBodyID
${known}
where ${where} and (${fields}) is not null and (FCT_AtmosphericGas.GasAtm is null or FCT_AtmosphericGas.AtmosGasAmount is null or FCT_AtmosphericGas.FrozenOut is null or DIM_Gases.GasID is null or DIM_Gases.Dangerous is null or DIM_Gases.DangerousLevel is null)`),
  ])
  const gaps = {}
  const gasGapped = new Set(gasGaps.map(({ SystemBodyID }) => SystemBodyID))

  undecided.forEach(({ SystemID, Bodies }) => {
    gaps[SystemID] = (gaps[SystemID] || 0) + Bodies
  })
  gasGaps.forEach(({ SystemID }) => {
    gaps[SystemID] = (gaps[SystemID] || 0) + 1
  })
  const atmospheres = groupBy(gases, 'SystemBodyID')
  const systems = {}

  // A system whose every body lost a packed field comes back with nothing packed: its bodies are in `gaps`.
  packed.filter(({ Bodies }) => Bodies).forEach(({ SystemID, Bodies }) => {
    const counts = COLONY_COST_BANDS.map(() => 0)

    Bodies.split(';').forEach((text) => {
      const [id, BodyClass, TidalLock, AtmosPress, HydroExt, Gravity, SurfaceTemp] = text.split(',').map(Number)

      if (gasGapped.has(id)) {
        return
      }

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

  return Object.freeze({ species: chosen.SpeciesName, systems: Object.freeze(systems), gaps: Object.freeze(gaps) })
}

registerRule({
  id: 'map.bestBand',
  versions: FEATURE_VERSIONS,
  units: 'band',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Gravity, SurfaceTemp, AtmosPress, HydroExt, TidalLock, BodyClass', 'FCT_AtmosphericGas', 'FCT_Species', 'FCT_Population.SpeciesID, Capital'],
  note: 'The lowest colony-cost band (under 2, 3 or 5) a system has a body in, for the species the race lives as, before colonisation technology. The cost formula follows the planner rules for colony cost and is not reproduced against a stored value; the species falls back to the race\'s largest when its capital has none. Without the cost run, or without a species, the band is unknown, which is not the same as no body under 5.',
})

registerRule({
  id: 'map.bodiesByCost',
  versions: FEATURE_VERSIONS,
  units: 'bodies',
  verification: 'estimated',
  structure: ['FCT_SystemBody', 'FCT_AtmosphericGas', 'FCT_Species'],
  note: 'How many bodies of a system fall in each colony-cost band, each counted in the lowest band it fits. The cost formula is as for the best band.',
})

registerRule({
  id: 'map.legendCounts',
  versions: FEATURE_VERSIONS,
  units: 'systems',
  verification: 'estimated',
  structure: ['FCT_SystemBody', 'FCT_AtmosphericGas', 'FCT_Species'],
  note: 'How many systems have each colony-cost band as their best, and how many have no body under the last band. The cost formula is as for the best band.',
})

// The index in COLONY_COST_BANDS of the lowest band system `systemId` has a body in, -1 for none (no body under the last band), or null when the bands can't be told: `habitability` is `loadHabitability`'s answer. A system with a body whose cost can't be told (`gaps`) has a known band only when it already has a body in the lowest one, which nothing can beat. The markers read it once `legendCounts` is available (the 'map.bestBand' rule).
export const bestBandIndex = (habitability, systemId) => {
  const counts = habitability.systems[systemId]
  const band = counts ? counts.findIndex(Boolean) : -1

  return habitability.gaps[systemId] && band !== 0 ? null : band
}

// What stops the colony costs being read, or null when they are: `habitability` is `loadHabitability`'s answer, or null while it loads or after it failed, and `reason` the page's words for it.
const costGap = (habitability, reason) => (habitability && habitability.species ? null : reason || 'the race\'s colony costs')

const COSTS_READ = ['the species\' colony costs']

const BODY_GAP = 'a stored value a body\'s colony cost needs (temperature, pressure, gravity, water, tidal lock or a gas\'s amounts)'

// A system's bodies by colony cost as a result of 'map.bodiesByCost': the value is the text, '' where no body falls in a band, and the result is unavailable while the costs are not read or for a system with a body whose cost can't be told. Each band counts the bodies not already in a lower one.
export const bodiesByCost = (habitability, systemId, { reason = null, version = null } = {}) => {
  const gap = costGap(habitability, reason)
  const assumptions = versionAssumptions('map.bodiesByCost', version)

  if (gap) {
    return unavailable({ rule: 'map.bodiesByCost', missing: [gap], assumptions })
  }

  if (habitability.gaps[systemId]) {
    return unavailable({ rule: 'map.bodiesByCost', missing: [BODY_GAP], present: COSTS_READ, assumptions })
  }

  const counts = habitability.systems[systemId]
  const text = COLONY_COST_BANDS.map((limit, band) => ({ limit, bodies: counts ? counts[band] : 0 })).filter((part) => part.bodies).map((part, index) => `${part.bodies} ${index ? 'more ' : ''}under ${part.limit}`).join(', ')

  return ofRule({ rule: 'map.bodiesByCost', value: text, inputs: { present: COSTS_READ }, assumptions })
}

// How many of `rows` (the map's systems, each with an `id`) have each band as their best, as a result of 'map.legendCounts' with the value { bands, none, unknown }: `unknown` counts the systems whose best band can't be told (`bestBandIndex`), which are in none of the others. Unavailable while the costs are not read.
export const legendCounts = (habitability, rows, { reason = null, version = null } = {}) => {
  const gap = costGap(habitability, reason)
  const assumptions = versionAssumptions('map.legendCounts', version)

  if (gap) {
    return unavailable({ rule: 'map.legendCounts', missing: [gap], assumptions })
  }

  const bands = COLONY_COST_BANDS.map(() => 0)
  let none = 0
  let unknown = 0

  rows.forEach((row) => {
    const band = bestBandIndex(habitability, row.id)

    if (band === null) {
      unknown += 1
    } else if (band < 0) {
      none += 1
    } else {
      bands[band] += 1
    }
  })

  return ofRule({ rule: 'map.legendCounts', value: { bands, none, unknown }, inputs: unknown ? { present: COSTS_READ, missing: [BODY_GAP] } : { present: COSTS_READ }, assumptions })
}
