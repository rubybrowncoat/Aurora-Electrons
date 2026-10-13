// Population that lives aboard Ark ships, kept apart from the surface population of Colony Outlook: what each Ark ship holds, where its fleet sits and what each body's orbit adds up to. Evidence: docs/plans/backlog/evidence/AE-061-01.md.
//
// An Ark ship is a ship whose class has the Ark flag (`FCT_ShipClass.ArkShip`, set by the standard-berth modules: colonist transport components with special function 7). Its people are the colonist cargo rows of `FCT_ShipCargo` (one per species), counted up to the berths of the ship's undamaged standard-berth modules. The people of a fleet that sits at its colony's body with no move orders and no civilian function are that colony's orbital population. The save stores no orbital total, so every figure here is read from stored cargo, class and fleet rows and none is compared with a stored total.

import { combine, isAvailable, ofRule, registerRule, sumResults, unavailable, valueOrNull } from './provenance'

const VERSIONS = ['2.7.x']
const COLONIST_CARGO = 1
const COLONIST_MODULE = 17
const STANDARD_BERTHS = 7
const MILLION = 1e6
// The game compares a fleet's coordinates with its colony body's on each axis, strictly under this many units.
const POSITION_TOLERANCE = 1

const ABOARD = 'arks.aboard'
const BERTHS = 'arks.berths'
const SPECIES = 'arks.species'
const ORBIT = 'arks.orbit'
const OCCUPIED = 'arks.occupied'
const EMPTY = 'arks.emptyBerths'
const TOTALS = 'arks.totals'
const BODY_SPECIES = 'arks.bodySpecies'

// Why a fleet's Ark ships are not a colony's orbital population while their people are aboard.
export const ORBIT_REASONS = Object.freeze({
  orders: 'Under move orders',
  civilian: 'In a civilian fleet',
  away: 'Not at its assigned colony',
  space: 'Not at a colony of the race',
})

const LIMITATION = 'Orbital population is held at today\'s figure: its growth and its transfer to the surface are not verified, so none is applied and it is never surface population or workers'

registerRule({
  id: ABOARD,
  versions: VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_ShipCargo.Amount (CargoTypeID 1, colonists)', 'FCT_ShipClass.ArkShip'],
  note: 'Colonists aboard an Ark ship in millions: the sum of its colonist cargo rows, as stored. A ship with no colonist cargo row is empty, a real 0.',
})

registerRule({
  id: BERTHS,
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentValue, ComponentTypeID 17, SpecialFunction 7', 'FCT_DamagedComponent.Number'],
  note: 'Millions of colonists the ship\'s standard berths hold: the standard-berth modules of its class times their capacity, less the damaged ones. The sum without damage matched the stored class colonist capacity of every Ark class in the modded 2.7 save and the stock 2.7.1 save; no save has a damaged Ark module, so the damage rule is read from the game, not observed. Cryogenic berths on the same ship are not counted: people in them are not orbital population.',
})

registerRule({
  id: SPECIES,
  versions: VERSIONS,
  units: '',
  verification: 'confirmed',
  structure: ['FCT_ShipCargo.SpeciesID (CargoTypeID 1)', 'FCT_Species.SpeciesName'],
  note: 'The species of the colonists aboard and how many of each, as the colonist cargo rows state them. A row without a known species makes the figure unavailable.',
})

registerRule({
  id: ORBIT,
  versions: VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['FCT_Fleet.AssignedPopulationID, Xcor, Ycor, SystemID, CivilianFunction, OrbitBodyID', 'FCT_MoveOrders.FleetID', 'FCT_Population.SystemBodyID', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'Where an Ark ship\'s people count: at the body of a colony of the race, when the fleet sits within 1 unit of the body on each axis in its system, has no move orders and is not a civilian fleet. A fleet assigned to a colony it does not sit at, or to none, is placed on the one body of the race\'s colonies at its position, as the game moves a stationary fleet to the colony it orbits; with no such body it is away or in space. The body is found from coordinates because the stored orbit body is 0 for fleets that sit on their colony\'s body; the stored value is not used. A fleet system, or a colony system or body position that decides the match, missing from the save makes the orbit unavailable. The save stores no orbital total, so the rule is read from the game and not compared with one.',
  assumptions: ['The fleet\'s position is where the game counts it'],
})

registerRule({
  id: OCCUPIED,
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the colonists aboard and standard berths rules'],
  note: 'Millions of people an Ark ship contributes to orbital population: the colonists aboard up to its standard berths. Kept apart from the empty berths and from the surface population.',
  assumptions: [LIMITATION],
})

registerRule({
  id: EMPTY,
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the colonists aboard and standard berths rules'],
  note: 'Millions of colonists the ship\'s standard berths could still take: the berths less the colonists aboard, at least 0. Room only, not people.',
})

registerRule({
  id: TOTALS,
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the Ark ships\' own results'],
  note: 'Sums over Ark ships, each counted once, in its own fleet and at one body. A ship whose figure is unavailable makes a body\'s sum unavailable. In the grand totals, a ship whose figure or whose orbit is unknown is left out and named, so the total is partial; it is unavailable only when no ship\'s figure is known.',
  assumptions: [LIMITATION],
})

registerRule({
  id: BODY_SPECIES,
  versions: VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['the colonists aboard, species and standard berths rules'],
  note: 'The species counted at a body and how many of each: every ship\'s colonist cargo by species, scaled to the share its standard berths hold, summed over the ships at the body. The cargo is as stored, but the share rests on the berths and, past them, on spreading the surplus over the species in proportion.',
})

const rows = (database, sql) => database.query(sql).then(([items]) => items)

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const unique = (list) => [...new Set(list)]

// The race's Ark ships, one row each, with the fleet that carries them, the berths of their undamaged standard-berth modules (null while the class has none), the colonist cargo by species and the race's colonies with the body coordinates. A damaged module counts by its first stored row, as the game finds it.
export const loadArks = async (database, { GameID, RaceID }) => {
  const [ships, cargo, colonies] = await Promise.all([
    rows(database, `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.ShipClassID, FCT_ShipClass.ClassName, FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.AssignedPopulationID, FCT_Fleet.OrbitBodyID, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.CivilianFunction, (select count(*) from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = ${GameID}) as MoveOrders, (select sum((FCT_ClassComponent.NumComponent - coalesce(VIR_Damage.Number, 0)) * FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID left join FCT_DamagedComponent as VIR_Damage on VIR_Damage.rowid = (select min(VIR_First.rowid) from FCT_DamagedComponent as VIR_First where VIR_First.ShipID = FCT_Ship.ShipID and VIR_First.ComponentID = FCT_ClassComponent.ComponentID) where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${COLONIST_MODULE} and FCT_ShipDesignComponents.SpecialFunction = ${STANDARD_BERTHS}) as Berths from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_ShipClass.ArkShip = 1`),
    rows(database, `select FCT_ShipCargo.ShipID, FCT_ShipCargo.SpeciesID, FCT_Species.SpeciesName, sum(FCT_ShipCargo.Amount) as Amount, count(*) as Rows, count(FCT_ShipCargo.Amount) as Amounts from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID left join FCT_Species on FCT_Species.SpeciesID = FCT_ShipCargo.SpeciesID and FCT_Species.GameID = FCT_ShipCargo.GameID where FCT_ShipCargo.GameID = ${GameID} and FCT_ShipCargo.CargoTypeID = ${COLONIST_CARGO} and FCT_Ship.RaceID = ${RaceID} and FCT_ShipClass.ArkShip = 1 group by FCT_ShipCargo.ShipID, FCT_ShipCargo.SpeciesID, FCT_Species.SpeciesName`),
    rows(database, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`),
  ])

  return { ships, cargo, colonies }
}

const aboardResult = (cargoRows) => {
  if (cargoRows.some((row) => !finite(row.Amount) || row.Amounts !== row.Rows)) {
    return unavailable({ rule: ABOARD, missing: ['colonists aboard'] })
  }

  return ofRule({ rule: ABOARD, value: cargoRows.reduce((sum, row) => sum + row.Amount, 0) / MILLION, inputs: { present: ['colonist cargo'] } })
}

const berthsResult = (ship) => (finite(ship.Berths) ? ofRule({ rule: BERTHS, value: ship.Berths / MILLION, inputs: { present: ['standard berths of the class'] } }) : unavailable({ rule: BERTHS, missing: ['the class\'s standard berths'] }))

const speciesResult = (cargoRows) => {
  if (cargoRows.some((row) => !row.SpeciesName)) {
    return unavailable({ rule: SPECIES, missing: ['species of the colonists aboard'] })
  }

  return ofRule({ rule: SPECIES, value: cargoRows.map((row) => ({ SpeciesID: row.SpeciesID, name: row.SpeciesName, amount: row.Amount / MILLION })), inputs: { present: ['species of the colonists aboard'] } })
}

const notCounted = (reason, present) => ofRule({ rule: ORBIT, value: { counted: false, reason }, inputs: { present } })

// Where an Ark ship's people count (see the 'arks.orbit' rule): { counted, PopulationID, SystemBodyID } or { counted: false, reason }, unavailable while the fleet's position, system, orders or function, or the system or body position of a colony that could be the one it sits at, is not in the save, or when its position matches several bodies.
const orbitResult = (ship, colonies, colonyById) => {
  const missing = [...(finite(ship.Xcor) && finite(ship.Ycor) ? [] : ['the fleet\'s position']), ...(finite(ship.SystemID) ? [] : ['the fleet\'s system']), ...(finite(ship.MoveOrders) ? [] : ['the fleet\'s move orders']), ...(finite(ship.CivilianFunction) ? [] : ['the fleet\'s function'])]

  if (missing.length) {
    return unavailable({ rule: ORBIT, missing })
  }

  const present = ['the fleet\'s position, system, orders and function']

  if (ship.MoveOrders > 0) {
    return notCounted('orders', present)
  } else if (ship.CivilianFunction !== 0) {
    return notCounted('civilian', present)
  }

  const axis = (fleet, body) => (finite(body) ? Math.abs(fleet - body) < POSITION_TOLERANCE : null)

  // Whether the fleet sits at the colony's body: true or false, null while the colony's system or the body's position (in the fleet's system) is not in the save.
  const at = (colony) => {
    if (!finite(colony.SystemID)) {
      return null
    } else if (colony.SystemID !== ship.SystemID) {
      return false
    }

    const x = axis(ship.Xcor, colony.Xcor)
    const y = axis(ship.Ycor, colony.Ycor)

    return x === false || y === false ? false : x === null || y === null ? null : true
  }

  const assigned = ship.AssignedPopulationID ? colonyById.get(ship.AssignedPopulationID) : null

  if (assigned && at(assigned) === true) {
    const storedElsewhere = ship.OrbitBodyID && ship.OrbitBodyID !== assigned.SystemBodyID ? ['The fleet\'s stored orbit body is not this colony\'s body; its position decides'] : []

    return ofRule({ rule: ORBIT, value: { counted: true, PopulationID: assigned.PopulationID, SystemBodyID: assigned.SystemBodyID }, inputs: { present: [...present, 'the assigned colony'] }, assumptions: storedElsewhere })
  }

  const undecided = colonies.filter((colony) => at(colony) === null)

  if (undecided.length) {
    return unavailable({ rule: ORBIT, missing: unique(undecided.map((colony) => (finite(colony.SystemID) ? `the position of the body of ${colony.PopName}` : `the system of ${colony.PopName}`))), present })
  }

  const matches = colonies.filter((colony) => at(colony) === true)
  const bodies = unique(matches.map((colony) => colony.SystemBodyID))

  if (!bodies.length) {
    return assigned ? notCounted('away', [...present, 'the assigned colony']) : notCounted('space', present)
  } else if (bodies.length > 1) {
    return unavailable({ rule: ORBIT, missing: ['which body the fleet is at (several bodies of colonies match its position)'], present })
  }

  const stored = assigned ? 'The fleet is assigned to a colony it is not at; the game moves a stationary fleet to the colony body it sits at' : 'The fleet is assigned to no colony in the save; the game assigns an orbiting Ark fleet to a colony of the race at its position'

  return ofRule({ rule: ORBIT, value: { counted: true, PopulationID: matches.length === 1 ? matches[0].PopulationID : null, SystemBodyID: bodies[0] }, inputs: { present }, assumptions: [stored] })
}

const shipRow = (ship, cargoRows, colonies, colonyById) => {
  const aboard = aboardResult(cargoRows)
  const berths = berthsResult(ship)
  const parts = { aboard, berths }
  const occupied = combine({ rule: OCCUPIED, parts, compute: (values) => Math.min(values.aboard, values.berths) })
  const empty = combine({ rule: EMPTY, parts, compute: (values) => Math.max(0, values.berths - values.aboard) })
  const orbit = orbitResult(ship, colonies, colonyById)
  const aboardValue = valueOrNull(aboard)
  const berthsValue = valueOrNull(berths)

  return {
    ...ship,
    results: { aboard, berths, species: speciesResult(cargoRows), orbit, occupied, empty },
    aboard: aboardValue,
    berths: berthsValue,
    occupied: valueOrNull(occupied),
    empty: valueOrNull(empty),
    beyondBerths: aboardValue === null || berthsValue === null ? null : Math.max(0, aboardValue - berthsValue),
    orbit: valueOrNull(orbit),
  }
}

// The species counted at a body: each ship's colonists aboard by species, scaled to the share the berths hold, merged. The cargo rows are confirmed, but the share rests on the berths, so the body's figure takes the berths' status and names the allocation. Unavailable while a ship's species, colonists or berths are.
const bodySpecies = (members) => {
  const parts = Object.fromEntries(members.flatMap((member) => ['species', 'aboard', 'berths'].map((name) => [`ship ${member.ShipID} ${name}`, member.results[name]])))
  const scaled = members.some((member) => member.aboard !== null && member.occupied !== null && member.aboard > 0 && member.occupied < member.aboard)

  const compute = () => {
    const amounts = new Map()

    members.forEach((member) => {
      const share = member.aboard > 0 ? member.occupied / member.aboard : 0

      member.results.species.value.forEach((entry) => amounts.set(entry.SpeciesID, { SpeciesID: entry.SpeciesID, name: entry.name, amount: (amounts.has(entry.SpeciesID) ? amounts.get(entry.SpeciesID).amount : 0) + entry.amount * share }))
    })

    return [...amounts.values()].filter((entry) => entry.amount > 0).sort((a, b) => b.amount - a.amount)
  }

  return combine({ rule: BODY_SPECIES, parts, compute, assumptions: scaled ? ['People beyond the standard berths are left out of the species counted, spread over the species aboard in proportion to their numbers'] : [] })
}

const sumOf = (results, assumptions = []) => sumResults({ rule: TOTALS, results, units: 'M people', assumptions })

// A grand total over ships: the ships whose figure is unavailable are left out and counted, never taken as 0; unavailable only when every ship's is. Returns { result, unknown }.
const partialSumOf = (results, assumptions = []) => {
  const known = results.filter(isAvailable)
  const unknown = results.length - known.length

  if (results.length && !known.length) {
    return { result: unavailable({ rule: TOTALS, missing: unique(results.flatMap((result) => result.inputs.missing)), units: 'M people', assumptions }), unknown }
  }

  const parts = Object.fromEntries(known.map((result, index) => [`ship ${index + 1}`, result]))
  const lacking = unique(results.filter((result) => !isAvailable(result)).flatMap((result) => result.inputs.missing))
  const left = unknown ? [`${unknown} of ${results.length} Ark ships are left out: their figure or their orbit is unavailable`] : []

  return { result: combine({ rule: TOTALS, parts, compute: (values) => Object.values(values).reduce((total, value) => total + value, 0), units: 'M people', assumptions: [...assumptions, ...left], inputs: { missing: lacking } }), unknown }
}

// The Ark layer of Colony Outlook from `loadArks`' rows. `ships`: every Ark ship once, with its results. `bodies`: the ships counted at each body, once, with the body's colonies, surface population, occupied people, empty berths and species. `byPopulation`: the same per assigned colony. `elsewhere`: ships whose people are aboard but not orbital population, with the reason. `unplaced`: ships whose orbit the save cannot decide. `totals`: occupied and empty berths over the counted ships, and the people aboard ships that are not counted.
export const arkLayer = ({ ships, cargo, colonies }) => {
  const colonyById = new Map(colonies.map((colony) => [colony.PopulationID, colony]))
  const cargoByShip = new Map()
  const colonyByBody = new Map()

  cargo.forEach((row) => cargoByShip.set(row.ShipID, [...(cargoByShip.get(row.ShipID) || []), row]))
  colonies.forEach((colony) => colonyByBody.set(colony.SystemBodyID, [...(colonyByBody.get(colony.SystemBodyID) || []), colony]))

  const all = ships.map((ship) => shipRow(ship, cargoByShip.get(ship.ShipID) || [], colonies, colonyById))
  const counted = all.filter((ship) => ship.orbit && ship.orbit.counted)
  const elsewhere = all.filter((ship) => ship.orbit && !ship.orbit.counted)
  const unplaced = all.filter((ship) => !ship.orbit)
  const groups = new Map()
  const populations = new Map()

  counted.forEach((ship) => {
    groups.set(ship.orbit.SystemBodyID, [...(groups.get(ship.orbit.SystemBodyID) || []), ship])

    if (ship.orbit.PopulationID) {
      populations.set(ship.orbit.PopulationID, [...(populations.get(ship.orbit.PopulationID) || []), ship])
    }
  })

  const inOrbit = (ship, name, rule) => (ship.orbit ? ship.results[name] : unavailable({ rule, missing: unique([...ship.results.orbit.inputs.missing, ...ship.results[name].inputs.missing]) }))
  const totalsOf = (members) => ({ occupied: sumOf(members.map((member) => member.results.occupied)), empty: sumOf(members.map((member) => member.results.empty)) })
  const grandOccupied = partialSumOf([...counted.map((member) => member.results.occupied), ...unplaced.map((member) => inOrbit(member, 'occupied', OCCUPIED))])
  const grandEmpty = partialSumOf([...counted.map((member) => member.results.empty), ...unplaced.map((member) => inOrbit(member, 'empty', EMPTY))])

  const bodies = [...groups.entries()].map(([SystemBodyID, members]) => {
    const own = colonyByBody.get(SystemBodyID) || []
    const assigned = unique(members.map((member) => member.orbit.PopulationID).filter(Boolean))
    const surface = own.length && own.every((colony) => finite(colony.Population)) ? own.reduce((sum, colony) => sum + colony.Population, 0) : null

    return { SystemBodyID, colonies: own, populationIds: assigned, surface, ships: members, species: bodySpecies(members), ...totalsOf(members) }
  })

  return {
    ships: all,
    bodies,
    byPopulation: Object.fromEntries([...populations.entries()].map(([id, members]) => [id, { ships: members, ...totalsOf(members) }])),
    elsewhere,
    unplaced,
    totals: { occupied: grandOccupied.result, empty: grandEmpty.result, unknown: Math.max(grandOccupied.unknown, grandEmpty.unknown), aboardElsewhere: partialSumOf(elsewhere.map((member) => member.results.aboard)).result },
  }
}
