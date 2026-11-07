// Population that lives aboard Ark ships, kept apart from the surface population of Colony Outlook: what each Ark ship holds, where its fleet sits and what each body's orbit adds up to. Evidence: docs/plans/backlog/evidence/AE-061-01.md.
//
// An Ark ship has its class's Ark flag and undamaged standard-berth modules. Stored colonist cargo supplies its people; unknown cargo categories remain unknown, not empty. Each colony separately counts eligible fleets at its coordinates using the saved assignment, without a system restriction. Ship inventories and grand ship totals still count each ship once.

import { combine, isAvailable, ofRule, registerRule, sumResults, unavailable, valueOrNull } from './provenance'

const VERSIONS = ['3.2.x']
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
const ATTRIBUTION = 'Saved positions and assignments stay fixed. Several possible receiving colonies on one body retain attribution alternatives; each scalar stays decided when all alternatives agree. One fleet assignment is shared across coincident bodies, while body and grand ship inventories count each ship once. Coincident different bodies are separate censuses, not a global assignment replay'

registerRule({
  id: ABOARD,
  versions: VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_ShipCargo.Amount (CargoTypeID 1, colonists)', 'FCT_ShipClass.ArkShip'],
  note: 'Colonists aboard an Ark ship in millions: the sum of its colonist cargo rows, as stored. A ship with no relevant cargo rows is empty, a real zero; an unknown category on a potentially positive row makes the amount unavailable, not empty.',
})

registerRule({
  id: BERTHS,
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentValue, ComponentTypeID 17, SpecialFunction 7', 'FCT_DamagedComponent.Number'],
  note: 'Millions of colonists the ship\'s standard berths hold: the standard-berth modules of its class times their capacity, less the damaged ones. The sum without damage matched the stored class colonist capacity of every Ark class in the saves it was checked on; no save has a damaged Ark module, so the damage rule is read from the game, not observed. Cryogenic berths on the same ship are not counted: people in them are not orbital population.',
})

registerRule({
  id: SPECIES,
  versions: VERSIONS,
  units: '',
  verification: 'confirmed',
  structure: ['FCT_ShipCargo.SpeciesID (CargoTypeID 1)', 'FCT_Species.SpeciesName'],
  note: 'The species of the colonists aboard and how many of each, as the colonist cargo rows state them. A potentially positive row without a known species or cargo category makes the figure unavailable.',
})

registerRule({
  id: ORBIT,
  versions: VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['FCT_Fleet.AssignedPopulationID, Xcor, Ycor, CivilianFunction', 'FCT_MoveOrders.FleetID', 'FCT_Population.SystemBodyID', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'Membership is evaluated separately at each colony of the race using the saved fleet position: strictly within 1 unit on each axis, with no move orders and no civilian function. Systems do not restrict the match. Its assigned colony counts the fleet; another colony on the same body holds that assignment. Explicitly unassigned fleets, proven absent assignment targets and assignments on other bodies permit reassignment, retaining alternatives when several colonies on this body can receive the fleet. Unknown inputs make only the memberships they can change unavailable.',
  assumptions: [ATTRIBUTION],
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
  versions: ['x'],
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
  note: 'Colony membership is evaluated separately, so coincident bodies can each count the same ship. Body totals count each applicable ship once per body. Grand totals count each ship once, not the sum of body or colony totals, retaining the same fleet assignment across bodies. A figure stays decided when every supported attribution gives the same contribution, including zero. A ship whose figure is unavailable makes its body or colony sum unavailable. Grand totals leave out unavailable ships and name the omitted count; they are unavailable when no included figure is known.',
  assumptions: [LIMITATION, ATTRIBUTION],
})

registerRule({
  id: BODY_SPECIES,
  versions: VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['the colonists aboard, species and standard berths rules'],
  note: 'The species counted at a body and how many of each: every ship\'s colonist cargo by species, scaled to the share its standard berths hold, summed over the ships at the body. The cargo is as stored, but the share rests on the berths and, past them, on spreading the surplus over the species in proportion.',
  assumptions: [ATTRIBUTION],
})

const rows = (database, sql) => database.query(sql).then(([items]) => items)

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const unique = (list) => [...new Set(list)]

// The race's Ark ships, one row each, with the fleet that carries them, the berths of their undamaged standard-berth modules (null while the class has none), the colonist cargo by species and the race's colonies with the body coordinates. A damaged module counts by its first stored row, as the game finds it.
export const loadArks = async (database, { GameID, RaceID }) => {
  const [ships, cargo, colonies, assignments] = await Promise.all([
    rows(database, `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.ShipClassID, FCT_ShipClass.ClassName, FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.AssignedPopulationID, FCT_Fleet.OrbitBodyID, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.CivilianFunction, (select count(*) from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = ${GameID}) as MoveOrders, (select sum((FCT_ClassComponent.NumComponent - coalesce(VIR_Damage.Number, 0)) * FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID left join FCT_DamagedComponent as VIR_Damage on VIR_Damage.rowid = (select min(VIR_First.rowid) from FCT_DamagedComponent as VIR_First where VIR_First.ShipID = FCT_Ship.ShipID and VIR_First.ComponentID = FCT_ClassComponent.ComponentID) where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${COLONIST_MODULE} and FCT_ShipDesignComponents.SpecialFunction = ${STANDARD_BERTHS}) as Berths from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Fleet.RaceID = ${RaceID} and FCT_ShipClass.ArkShip = 1`),
    rows(database, `select FCT_ShipCargo.ShipID, FCT_ShipCargo.CargoTypeID, FCT_ShipCargo.SpeciesID, FCT_Species.SpeciesName, sum(FCT_ShipCargo.Amount) as Amount, count(*) as Rows, count(FCT_ShipCargo.Amount) as Amounts from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID left join FCT_Species on FCT_Species.SpeciesID = FCT_ShipCargo.SpeciesID and FCT_Species.GameID = FCT_ShipCargo.GameID where FCT_ShipCargo.GameID = ${GameID} and (FCT_ShipCargo.CargoTypeID = ${COLONIST_CARGO} or FCT_ShipCargo.CargoTypeID is null) and FCT_Ship.RaceID = ${RaceID} and FCT_ShipClass.ArkShip = 1 group by FCT_ShipCargo.ShipID, FCT_ShipCargo.CargoTypeID, FCT_ShipCargo.SpeciesID, FCT_Species.SpeciesName`),
    rows(database, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.ComponentNumber, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`),
    rows(database, `select FCT_Population.PopulationID, FCT_Population.SystemBodyID from FCT_Population where FCT_Population.GameID = ${GameID}`),
  ])

  return { ships, cargo, colonies, assignments }
}

const aboardResult = (cargoRows) => {
  if (cargoRows.some((row) => !finite(row.Amount) || row.Amounts !== row.Rows || row.CargoTypeID !== COLONIST_CARGO)) {
    return unavailable({ rule: ABOARD, missing: ['the amount or category of colonists aboard'] })
  }

  return ofRule({ rule: ABOARD, value: cargoRows.reduce((sum, row) => sum + row.Amount, 0) / MILLION, inputs: { present: ['colonist cargo'] } })
}

const berthsResult = (ship) => (finite(ship.Berths) ? ofRule({ rule: BERTHS, value: ship.Berths / MILLION, inputs: { present: ['standard berths of the class'] } }) : unavailable({ rule: BERTHS, missing: ['the class\'s standard berths'] }))

// The species aboard: a colonist cargo row of 0 people holds no species, so it is not listed (the game no longer keeps such a row, and a copy that holds one reads as one that does not). A row of an amount not known stays, and makes the figure unavailable when its species is missing.
const speciesResult = (cargoRows) => {
  const held = cargoRows.filter((row) => row.Amount !== 0)

  if (held.some((row) => !row.SpeciesName || row.CargoTypeID !== COLONIST_CARGO)) {
    return unavailable({ rule: SPECIES, missing: ['the species or category of colonists aboard'] })
  }

  return ofRule({ rule: SPECIES, value: held.map((row) => ({ SpeciesID: row.SpeciesID, name: row.SpeciesName, amount: row.Amount / MILLION })), inputs: { present: ['species of the colonists aboard'] } })
}

const notCounted = (reason, present) => ofRule({ rule: ORBIT, value: { counted: false, reason }, inputs: { present } })

// Membership is local to one colony. Known exclusions short-circuit unread inputs; an unread assignment matters only if another colony on this body could hold it.
const membershipResult = (ship, colony, colonies, colonyById, bodyWide = false, assignmentId = ship.AssignedPopulationID) => {
  const present = ['the saved fleet position, orders, civilian function and colony assignment']
  const excluded = (reason) => notCounted(reason, present)

  if (ship.MoveOrders > 0) return excluded('orders')
  if (finite(ship.CivilianFunction) && ship.CivilianFunction !== 0) return excluded('civilian')
  const axis = (key) => finite(ship[key]) && finite(colony[key]) ? Math.abs(ship[key] - colony[key]) < POSITION_TOLERANCE : null
  const x = axis('Xcor')
  const y = axis('Ycor')

  if (x === false || y === false) return excluded('space')
  const candidates = colonies.filter((other) => other.PopulationID === colony.PopulationID || !finite(colony.SystemBodyID) || !finite(other.SystemBodyID) || other.SystemBodyID === colony.SystemBodyID)
  const reassigned = bodyWide || candidates.length === 1 ? true : null
  const assignedAt = (id) => {
    if (id === 0) return reassigned
    if (id === colony.PopulationID || (bodyWide && colonies.some((other) => other.PopulationID === id))) return true
    const assigned = colonyById.get(id)

    if (!assigned) return reassigned
    if (!finite(assigned.SystemBodyID) || !finite(colony.SystemBodyID)) return null
    return assigned.SystemBodyID === colony.SystemBodyID ? false : reassigned
  }
  const outcomes = finite(assignmentId) ? [assignedAt(assignmentId)] : [assignedAt(0), ...[...colonyById.keys()].map(assignedAt)]
  const assignment = outcomes.every((value) => value === true) ? true : outcomes.every((value) => value === false) ? false : null

  if (assignment === false) return excluded('away')
  const missing = [...(x === null || y === null ? ['the fleet or colony body position'] : []), ...(finite(ship.MoveOrders) ? [] : ['the fleet move orders']), ...(finite(ship.CivilianFunction) ? [] : ['the fleet civilian function']), ...(assignment === null ? ['the fleet colony assignment or which colony receives it'] : [])]

  return missing.length ? unavailable({ rule: ORBIT, missing }) : ofRule({ rule: ORBIT, value: { counted: true, PopulationID: colony.PopulationID, SystemBodyID: colony.SystemBodyID }, inputs: { present } })
}

// A ship has one inventory, but can belong to several per-colony censuses. Grand inclusion keeps the same assignment alternative across all bodies.
const orbitResult = (memberships, bodyMemberships, countedInEveryAssignment) => {
  const results = Object.values(bodyMemberships)
  const bodies = results.filter((result) => isAvailable(result) && result.value.counted).map((result) => result.value.SystemBodyID)
  const matches = Object.values(memberships).filter((result) => isAvailable(result) && result.value.counted).map((result) => result.value)
  const uncertain = Object.values(memberships).some((result) => !isAvailable(result))

  if (bodies.length || countedInEveryAssignment) return ofRule({ rule: ORBIT, value: { counted: true, memberships: matches, bodies, uncertain }, inputs: { present: ['the per-body and per-colony memberships under the same fleet assignment'] }, assumptions: [ATTRIBUTION] })
  const unknown = results.filter((result) => !isAvailable(result))

  return unknown.length ? unavailable({ rule: ORBIT, missing: unique(unknown.flatMap((result) => result.inputs.missing)) }) : notCounted(results.length ? results[0].value.reason : 'space', ['the per-body memberships'])
}

const shipRow = (ship, cargoRows, colonies, colonyById) => {
  const relevantCargo = cargoRows.filter((row) => row.CargoTypeID === COLONIST_CARGO || (!finite(row.CargoTypeID) && !(row.Amount === 0 && row.Amounts === row.Rows)))
  const aboard = aboardResult(relevantCargo)
  const berths = berthsResult(ship)
  const parts = { aboard, berths }
  const occupied = combine({ rule: OCCUPIED, parts, compute: (values) => Math.min(values.aboard, values.berths) })
  const empty = combine({ rule: EMPTY, parts, compute: (values) => Math.max(0, values.berths - values.aboard) })
  const memberships = Object.fromEntries(colonies.map((colony) => [colony.PopulationID, membershipResult(ship, colony, colonies, colonyById)]))
  const bodyColonies = [...new Map(colonies.map((colony) => [colony.SystemBodyID, colony])).values()]
  const bodyMemberships = Object.fromEntries(bodyColonies.map((colony) => [colony.SystemBodyID, membershipResult(ship, colony, colonies, colonyById, true)]))
  const assignments = finite(ship.AssignedPopulationID) ? [ship.AssignedPopulationID] : [0, ...colonyById.keys()]
  const countedInEveryAssignment = assignments.every((id) => bodyColonies.some((colony) => {
    const result = membershipResult(ship, colony, colonies, colonyById, true, id)

    return isAvailable(result) && result.value.counted
  }))
  const orbit = orbitResult(memberships, bodyMemberships, countedInEveryAssignment)
  const aboardValue = valueOrNull(aboard)
  const berthsValue = valueOrNull(berths)

  return {
    ...ship,
    results: { aboard, berths, species: speciesResult(relevantCargo), orbit, occupied, empty },
    memberships,
    bodyMemberships,
    aboard: aboardValue,
    berths: berthsValue,
    occupied: valueOrNull(occupied),
    empty: valueOrNull(empty),
    beyondBerths: aboardValue === null || berthsValue === null ? null : Math.max(0, aboardValue - berthsValue),
    orbit: valueOrNull(orbit),
  }
}

// The species counted at a body: each ship's colonists aboard by species, scaled to the share the berths hold, merged. Zero occupants contribute no species regardless of attribution; positive contributions need the ship's species, colonists and berths.
const bodySpecies = (members) => {
  const contributing = members.filter((member) => !(isAvailable(member.results.occupied) && member.results.occupied.value === 0))
  const parts = Object.fromEntries(contributing.flatMap((member) => ['species', 'aboard', 'berths'].map((name) => [`ship ${member.ShipID} ${name}`, member.results[name]])))
  const scaled = contributing.some((member) => member.aboard !== null && member.occupied !== null && member.aboard > 0 && member.occupied < member.aboard)

  const compute = () => {
    const amounts = new Map()

    contributing.forEach((member) => {
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

// Colony/body censuses retain local uncertainty; grand ship totals count each ship once even when several coincident bodies count it.
export const arkLayer = ({ ships, cargo, colonies, assignments }) => {
  const colonyById = new Map(assignments.map((colony) => [colony.PopulationID, colony]))
  const cargoByShip = new Map()
  const colonyByBody = new Map()

  cargo.forEach((row) => cargoByShip.set(row.ShipID, [...(cargoByShip.get(row.ShipID) || []), row]))
  colonies.forEach((colony) => colonyByBody.set(colony.SystemBodyID, [...(colonyByBody.get(colony.SystemBodyID) || []), colony]))

  const all = ships.map((ship) => shipRow(ship, cargoByShip.get(ship.ShipID) || [], colonies, colonyById))
  const counted = all.filter((ship) => ship.orbit && ship.orbit.counted)
  const elsewhere = all.filter((ship) => ship.orbit && !ship.orbit.counted)
  const unplaced = all.filter((ship) => !ship.orbit)
  const possible = (membership) => !isAvailable(membership) || membership.value.counted
  const scoped = (ship, membership) => isAvailable(membership) ? ship : { ...ship, results: Object.fromEntries(Object.entries(ship.results).map(([key, result]) => [key, isAvailable(result) && (result.value === 0 || (key === 'species' && result.value.length === 0)) ? result : unavailable({ rule: result.rule.id, missing: membership.inputs.missing })])) }
  const totalsOf = (members) => ({ occupied: sumOf(members.map((member) => member.results.occupied)), empty: sumOf(members.map((member) => member.results.empty)) })
  const grand = (name) => partialSumOf([...counted.map((member) => member.results[name]), ...unplaced.map((member) => scoped(member, member.results.orbit).results[name])])
  const grandOccupied = grand('occupied')
  const grandEmpty = grand('empty')
  const bodies = [...colonyByBody.entries()].flatMap(([SystemBodyID, own]) => {
    const members = all.filter((ship) => possible(ship.bodyMemberships[SystemBodyID])).map((ship) => scoped(ship, ship.bodyMemberships[SystemBodyID]))
    if (!members.length) return []
    const surface = own.every((colony) => finite(colony.Population)) ? own.reduce((sum, colony) => sum + colony.Population, 0) : null
    const populationIds = own.filter((colony) => members.some((ship) => possible(ship.memberships[colony.PopulationID]))).map((colony) => colony.PopulationID)

    return [{ SystemBodyID, colonies: own, populationIds, surface, ships: members, species: bodySpecies(members), ...totalsOf(members) }]
  })
  const byPopulation = Object.fromEntries(colonies.map((colony) => {
    const members = all.filter((ship) => possible(ship.memberships[colony.PopulationID])).map((ship) => scoped(ship, ship.memberships[colony.PopulationID]))

    return [colony.PopulationID, { ships: members, ...totalsOf(members) }]
  }))

  return { ships: all, bodies, byPopulation, elsewhere, unplaced, totals: { occupied: grandOccupied.result, empty: grandEmpty.result, unknown: Math.max(grandOccupied.unknown, grandEmpty.unknown), aboardElsewhere: partialSumOf(elsewhere.map((member) => member.results.aboard)).result } }
}
