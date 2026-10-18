// Maths for the Transport page and what Hauling shares with it: which jump points a fleet's ships can transit, whether a ship can load or unload at a stop and why not, the loading strength of a ship at a stop and the time a stop takes, and the round trip of a group of ships between two places.

import { crewFraction } from './crew'
import { bonusProvenance, factorCell, mergeFactors, officerFactors, stackFactors } from './handling-bonuses'
import { reverseSteps, routeLegs } from './jump-graph'
import { ofRule, registerRule, ruleSupports, unavailable } from './provenance'
import { handleEvent, nebulaGapOf, routeEvents, speedIn, timingGaps, walkEvents } from './route-time'

export const SECONDS_PER_YEAR = 31536000
const SECONDS_PER_DAY = 86400

// Move actions that load or unload cargo, by what they carry.
export const LOADS = { 4: 'colonists', 176: 'installations', 62: 'minerals', 178: 'minerals', 180: 'minerals', 223: 'minerals', 165: 'minerals' }
export const UNLOADS = { 6: 'colonists', 96: 'installations', 177: 'installations', 63: 'minerals', 179: 'minerals', 165: 'minerals' }
// Move actions that load or unload ground units (Load Ground Unit, Unload Ground Unit, Unload All Ground Units from Transport Bay).
const TROOP_ACTIONS = new Set([86, 87, 88])
// Move actions that hand fuel, maintenance supplies or cargo to another fleet (Join & Refuel Target Fleet, Refuel from own Tankers, Equalise Maintenance Supplies, Resupply from own Supply Ships, Receive Cargo, Join & Refuel Target Sub-Fleet).
const SHIP_TO_SHIP_ACTIONS = new Set([5, 30, 92, 128, 155, 184])
// Seconds to load or unload one cargo point or one colonist at a loading strength of 1 (docs `logistics`, Logistics and Cargo Handling).
const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }
// DIM_MoveAction: Load All Minerals, Load Colonists, Unload Minerals and Unload Colonists.
const LOAD_CARGO = 62
const LOAD_COLONISTS = 4
const UNLOAD_CARGO = 63
const UNLOAD_COLONISTS = 6
// A class of this size (in hull spaces, 500 t) or less lands on a colony: its own loading strength is 1 whatever bays it has. The limit is inclusive.
const SMALL_CRAFT_SIZE = 10
const TONNES_PER_HULL_SPACE = 50
// DIM_ComponentType: Cargo Shuttle Bay.
const CARGO_SHUTTLE_BAY = 14
// A class's cargo shuttle bays as the game adds them up: each bay counts its own strength (ComponentValue), so a high-strength bay is worth its strength, not one. The class's stored CargoShuttleStrength isn't used: in the saves it is sometimes the bay total times the race's technology, which `handlingBreakdown` applies itself.
const CLASS_BAYS = `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${CARGO_SHUTTLE_BAY}`
const DESIGNED_BAYS = `coalesce((select sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) ${CLASS_BAYS}), 0)`

// The columns `handlingBreakdown` and `shipEligibility` read from a ship, for a query that joins FCT_Ship and FCT_ShipClass: `ShuttleStrength`, what the ship's undamaged cargo shuttle bays add up to, and `DesignedShuttleStrength`, what its bays add up to as designed (more than `ShuttleStrength` when some are damaged). A ship's damaged bays are taken off the class's bays by the ship's FCT_DamagedComponent rows, one component design at a time.
export const SHUTTLE_STRENGTH_COLUMNS = `coalesce((select sum(max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID), 0), 0) * FCT_ShipDesignComponents.ComponentValue) ${CLASS_BAYS}), 0) as ShuttleStrength, ${DESIGNED_BAYS} as DesignedShuttleStrength`

// The same column for a query that joins FCT_ShipClass alone: the class's bays as designed, none of them damaged.
export const CLASS_SHUTTLE_STRENGTH_COLUMNS = `${DESIGNED_BAYS} as ShuttleStrength`

// What a colony offers a ship that loads there: `ShuttleCapacity`, the strength of its spaceports and cargo shuttle stations (DIM_PlanetaryInstallation.CargoShuttleValue x amount; the game counts a colony as served from 1), and `ServiceNames`, their names. `SHUTTLE_SERVICE_COLUMNS` goes in the select list and `shuttleServiceJoin` in the from clause of a query that has the colony's id in `populationColumn`.
export const SHUTTLE_SERVICE_COLUMNS = 'coalesce(VIR_Service.ShuttleCapacity, 0) as ShuttleCapacity, VIR_Service.ServiceNames'

export const shuttleServiceJoin = (gameId, populationColumn) => `left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) as ShuttleCapacity, group_concat(DIM_PlanetaryInstallation.Name, ', ') as ServiceNames from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${gameId} and FCT_PopulationInstallations.Amount > 0 and DIM_PlanetaryInstallation.CargoShuttleValue > 0 group by FCT_PopulationInstallations.PopID) as VIR_Service on VIR_Service.PopID = ${populationColumn}`

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js). Evidence: docs/plans/backlog/evidence/AE-080-01.md, AE-081-01.md and AE-082-01.md.
const TRANSPORT_VERSIONS = ['2.7.x']

registerRule({
  id: 'transport.landingThreshold',
  versions: TRANSPORT_VERSIONS,
  units: 'HS',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size'],
  note: 'A craft of 10 hull spaces (500 t) or less, the limit included, lands at a colony and loads with a base strength of 1 whatever bays it has; a larger craft needs undamaged cargo shuttle bays or a spaceport or cargo shuttle station at the colony. Settled by a read-only check of the 2.7.x rule and by the creator\'s public clarification of 500 t in 2.7.1. The limit is said to be 1000 t in 3.0, which is not modelled.',
})

registerRule({
  id: 'transport.cargoEligibility',
  versions: TRANSPORT_VERSIONS,
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size, Crew', 'FCT_Ship.CurrentCrew', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue', 'FCT_DamagedComponent', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.CargoShuttleValue'],
  note: 'A ship loads or unloads minerals, installations or colonists at a colony when its own strength (1 for a landing craft, else its undamaged bays) or the colony\'s spaceport or cargo shuttle station gives a positive strength, and its crew is aboard. The strength terms are checked for 2.7.x; that a ship with no crew aboard cannot load is inferred, not checked against saved data. Ground-unit loading and ship-to-ship transfers are separate rules and are not checked here.',
  assumptions: ['the colony\'s spaceports and cargo shuttle stations are the installations with a cargo shuttle value'],
})

registerRule({
  id: 'transport.handlingStrength',
  versions: TRANSPORT_VERSIONS,
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue', 'FCT_DamagedComponent', 'FCT_Race.CargoShuttleLoadModifier', 'DIM_PlanetaryInstallation.CargoShuttleValue'],
  note: 'A ship\'s loading strength is its own term (1 for a craft of 10 hull spaces or less, else its undamaged bay strength) times the race\'s shuttle technology and times the officers\' Logistics factors (`transport.logisticsBonuses`), plus the technology once more at a colony with a spaceport or cargo shuttle station; that addition is not multiplied by any officer. Matches the game\'s rule for 2.7.x.',
  assumptions: ['a Logistics bonus the save cannot settle counts as 1, so the time errs long'],
})

registerRule({
  id: 'transport.ownStrength',
  versions: TRANSPORT_VERSIONS,
  units: '×',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue', 'FCT_DamagedComponent'],
  note: 'A ship\'s own loading strength: 1 for a craft of 10 hull spaces or less, whatever bays it has, else the strength of its undamaged cargo shuttle bays. A ship with every bay damaged has none of its own.',
  assumptions: ['the bays counted are the undamaged ones of the class lines'],
})

registerRule({
  id: 'transport.shuttleTechnology',
  versions: TRANSPORT_VERSIONS,
  units: '×',
  verification: 'confirmed',
  structure: ['FCT_Race.CargoShuttleLoadModifier'],
  note: 'The race\'s cargo handling technology, the multiplier of every ship\'s own strength at a colony; the same figure is added once for a colony with a spaceport or cargo shuttle station.',
})

registerRule({
  id: 'transport.colonyAddition',
  versions: TRANSPORT_VERSIONS,
  units: '×',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.CargoShuttleValue', 'FCT_Race.CargoShuttleLoadModifier'],
  note: 'A colony with a spaceport or cargo shuttle station adds the race\'s cargo handling technology once to a ship\'s strength, however many it has; no officer\'s bonus multiplies it.',
  assumptions: ['the colony\'s spaceports and cargo shuttle stations are the installations with a cargo shuttle value'],
})

registerRule({
  id: 'transport.handlingTime',
  versions: TRANSPORT_VERSIONS,
  units: 's',
  verification: 'estimated',
  structure: ['FCT_ShipClass.CargoCapacity, ColonistCapacity, Crew', 'FCT_Ship.CurrentCrew'],
  note: 'A stop takes the slowest ship\'s time: cargo x 20 s (colonists x 10 s) divided by its loading strength (`transport.handlingStrength`) and its crew fraction, which applies once; a ship with no crew aboard cannot load and more crew than the class needs is no faster (docs `logistics`, `crew-and-commanders`). Reproduced consistently between Hauling and Transport on both sample saves, not compared with times the game stores.',
  assumptions: ['every ship at the stop loads at once', 'a ship short of crew loads in proportion to the crew it has', 'a Logistics bonus the save cannot settle counts as 1'],
})

registerRule({
  id: 'transport.roundTrip',
  versions: TRANSPORT_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_ShipClass.MaxSpeed', 'the explored jump points'],
  note: 'Twice the route at top speed plus loading and unloading at both ends (`transport.handlingTime`). The route comes from the explored jump points; orders\' own delays and refuelling are not counted. A class timed alone has no crew read, so the jump shock waits (`route.jumpWait`) are left out of it; a fleet\'s trip counts them.',
  assumptions: ['top speed both ways', 'full holds', 'no refuelling or overhaul stops', 'jump shock waits are not counted for a class timed alone'],
})

registerRule({
  id: 'transport.fuelPerTrip',
  versions: TRANSPORT_VERSIONS,
  units: 'L',
  verification: 'estimated',
  structure: ['FCT_ShipClass.EnginePower, FuelEfficiency, FuelCapacity'],
  note: 'Engine power x fuel use per engine-power hour x hours under way. The burn rate matches the engine rule checked for the Propulsion page; refuelling is not counted.',
  assumptions: ['full power for the whole trip'],
})

registerRule({
  id: 'transport.freightPerYear',
  versions: TRANSPORT_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.CargoCapacity, ColonistCapacity'],
  note: 'Ships x capacity x round trips a year (`transport.roundTrip`).',
  assumptions: ['full holds and berths on every trip'],
})

registerRule({
  id: 'transport.civilianFreight',
  versions: TRANSPORT_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_Fleet.ShippingLine', 'FCT_Game.CivilianShippingLinesActive'],
  note: 'The shipping line ships\' round trips on the chosen run, timed like the race\'s own and without the fuel limit.',
  assumptions: ['shipping line ships carry full loads', 'no fuel limit'],
})

registerRule({
  id: 'transport.shipments',
  versions: TRANSPORT_VERSIONS,
  units: 'installations',
  verification: 'confirmed',
  structure: ['FCT_PopInstallationDemand', 'FCT_ShipCargo', 'FCT_MoveOrders'],
  note: 'Sums of the saved requests and of the installations in shipping line holds; nothing is calculated beyond adding them up.',
})

registerRule({
  id: 'transport.routeReach',
  versions: TRANSPORT_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_JumpPoint', 'FCT_LagrangePoint', 'FCT_RaceSysSurvey'],
  note: 'The shortest route over the jump points the race has explored, jumps first; the search was checked against the game\'s own routes (docs `fleet`).',
})

export const UNVERIFIED_VERSION = 'the 2.7.x landing and shuttle rules, though the save\'s game version is not verified'

// The formula version in words for a note.
export const describeFormulaVersion = (version) => (version ? `The save has the 2.7 schema and no version label, so the ${version} rules apply.` : 'The save has no version label and not the 2.7 schema, so the landing rule is not verified for its game version.')

// The largest craft, in hull spaces, that lands at a colony and loads with a strength of 1: the rule's own limit when it holds for the version, null when the version is not known or the rule is not verified for it (3.0 is said publicly to land 1000 t; that is not modelled).
export const landingThreshold = (version) => (ruleSupports('transport.landingThreshold', version) ? SMALL_CRAFT_SIZE : null)

// What kind of transfer an order is: 'cargo' (minerals, installations and colonists, which the shuttle rules govern), 'troops' (ground units, which they don't), 'ship-to-ship' (fuel, supplies or cargo handed to another fleet, which need bays on the ship or the receiving fleet and give a small craft no landing exemption), or null (not a transfer).
export const transferCategory = (moveActionId) => (LOADS[moveActionId] || UNLOADS[moveActionId] ? 'cargo' : TROOP_ACTIONS.has(moveActionId) ? 'troops' : SHIP_TO_SHIP_ACTIONS.has(moveActionId) ? 'ship-to-ship' : null)

// Where a ship loads or unloads: a colony, with whether a spaceport or cargo shuttle station serves it (`row.ShuttleCapacity` from `SHUTTLE_SERVICE_COLUMNS`, null when it is not read), their names, and the colony (`row.PopulationID`, null for a site with no population) and system (`row.SystemID`) whose governor, sector and naval administration give the officers' Logistics bonuses. A place with no colony (a system, a body nobody lives on) moves no cargo.
export const colonyEndpoint = (row, place = row.PopName) => ({ place, colony: true, service: Number.isFinite(row.ShuttleCapacity) ? row.ShuttleCapacity >= 1 : null, services: row.ServiceNames || '', populationId: Number.isFinite(row.PopulationID) ? row.PopulationID : null, systemId: Number.isFinite(row.SystemID) ? row.SystemID : null })

export const bareEndpoint = (place) => ({ place, colony: false, service: false, services: '' })

// What the inputs of an unsupported verdict are called when a result names what is missing.
const INPUT_NAMES = {
  technology: 'the race\'s cargo shuttle technology',
  crew: 'a ship\'s crew',
  size: 'a class\'s size',
  bays: 'a ship\'s cargo shuttle bays',
  service: 'the colony\'s installations',
  'landing-unverified': 'a landing rule verified for the game version',
  'handling-version': 'a loading rule verified for the game version',
  capacity: 'a ship\'s cargo and colonist capacity',
  endpoint: 'the stop\'s colony',
}

// What stands in for a stop whose endpoint was not given: nothing about it is known.
const MISSING_ENDPOINT = Object.freeze({ place: 'the stop', colony: true, service: null, services: '', missing: true })

const endpointOf = (endpoint) => (endpoint && typeof endpoint === 'object' ? endpoint : MISSING_ENDPOINT)

// What an unsupported verdict's reasons say is missing, as names for a provenance result.
export const missingInputsOf = (reasons) => [...new Set(reasons.filter((reason) => reason.status === 'unsupported').map((reason) => INPUT_NAMES[reason.code] || reason.code))]

const shipNameOf = (ship) => ship.ShipName || ship.ClassName || 'A ship'

const tonnes = (size) => `${size * TONNES_PER_HULL_SPACE} t`

// Whether one ship can load or unload cargo at an endpoint by the game's rule: `status` 'permitted' (`via` says what lets it), 'blocked' (`reasons` names the ship or endpoint that lacks what is needed and what is missing: no crew aboard, a place with no colony, bays that are all damaged or a craft over the landing size with no bays at a colony with no spaceport or cargo shuttle station) or 'unsupported' (an input is not in the save, or the landing size is not verified for `version`, so the answer is not known). The ship is { ShipName, ClassName, Size, ShuttleStrength, DesignedShuttleStrength, CurrentCrew, ClassCrew }.
export const shipEligibility = (ship, given, version) => {
  const endpoint = endpointOf(given)
  const name = shipNameOf(ship)
  const place = endpoint.place || 'the stop'
  const verdict = (status, code, text, via = []) => ({ status, ship: name, endpoint: place, via, reasons: status === 'permitted' ? [] : [{ status, code, text, ship: name, endpoint: place }] })
  const bays = ship.ShuttleStrength

  if (endpoint.missing) {
    return verdict('unsupported', 'endpoint', `where ${name} loads or unloads is not known`)
  } else if (!endpoint.colony) {
    return verdict('blocked', 'no-colony', `${place} has no colony, and cargo moves only at a colony`)
  }

  const share = crewFraction(ship)

  if (share === null) {
    return verdict('unsupported', 'crew', `${name}'s crew is not in the save`)
  } else if (share === 0) {
    return verdict('blocked', 'crew', `${name} has no crew aboard`)
  }

  const helped = [endpoint.service === true ? endpoint.services || 'a spaceport or cargo shuttle station' : null, bays > 0 ? 'undamaged cargo shuttle bays' : null].filter(Boolean)

  if (helped.length) {
    return verdict('permitted', null, '', helped)
  } else if (!Number.isFinite(ship.Size)) {
    return verdict('unsupported', 'size', `${name}'s size is not in the save`)
  } else if (landingThreshold(version) === null) {
    return verdict('unsupported', 'landing-unverified', `whether ${name} (${tonnes(ship.Size)}) loads at ${place} depends on the landing size, which is not verified for this save's game version`)
  } else if (ship.Size <= SMALL_CRAFT_SIZE) {
    return verdict('permitted', null, '', [`landing craft of ${tonnes(SMALL_CRAFT_SIZE)} or less`])
  } else if (endpoint.service === null) {
    return verdict('unsupported', 'service', `whether ${place} has a spaceport or cargo shuttle station is not in the save`)
  } else if (bays === null || bays === undefined) {
    return verdict('unsupported', 'bays', `${name}'s cargo shuttle bays are not in the save`)
  }

  const damaged = ship.DesignedShuttleStrength > bays

  return verdict('blocked', damaged ? 'damaged-bays' : 'no-bays', `${name} is over ${tonnes(SMALL_CRAFT_SIZE)} with ${damaged ? 'all its cargo shuttle bays damaged' : 'no cargo shuttle bays'}, and ${place} has no spaceport or cargo shuttle station`)
}

// What a loading strength needs besides a ship that may load: the race's technology, whether the colony has a spaceport or cargo shuttle station (true or false, not unknown), a loading rule verified for the game version, and the ship's size and (over `SMALL_CRAFT_SIZE`) its undamaged bays' strength. Each missing one is a code, said by `GAP_TEXT`.
const strengthGaps = (ship, endpoint, shuttleTechnology, version) => [
  shuttleTechnology > 0 ? null : 'technology',
  typeof endpoint.service === 'boolean' ? null : 'service',
  ruleSupports('transport.handlingStrength', version) ? null : 'handling-version',
  !Number.isFinite(ship.Size) ? 'size' : ship.Size > SMALL_CRAFT_SIZE && !Number.isFinite(ship.ShuttleStrength) ? 'bays' : null,
].filter(Boolean)

const GAP_TEXT = {
  technology: () => 'the race\'s cargo shuttle technology is not in the save',
  service: (_name, place) => `whether ${place} has a spaceport or cargo shuttle station is not in the save`,
  'handling-version': () => 'the loading strength rule is not verified for this save\'s game version',
  size: (name) => `${name}'s size is not in the save`,
  bays: (name) => `${name}'s cargo shuttle bays are not in the save`,
}

// The loading strength of one ship at a stop, by the game's rule, as its terms: the ship's own strength (1 for a craft of `SMALL_CRAFT_SIZE` hull spaces or less, whatever bays it has; its undamaged bays' strength, `ShuttleStrength`, for a larger ship) times the officers' Logistics factors (`officerFactors`, 1 where an officer has no bonus or it is not known) times the race's cargo handling technology is the ship's own term `ownTerm`; the colony's spaceport or cargo shuttle station adds that technology once more, however many it has, as `additive`, which no officer multiplies. `strength` is their sum. Ships are { Size, ShuttleStrength, ShipID, NavalAdminCommandID }; `endpoint` as `colonyEndpoint` gives it; `shuttleTechnology` is the race's CargoShuttleLoadModifier; `version` the formula version; `support` the officers' bonuses. Any input that is not known (`strengthGaps`) gives null, never a guess; an officer that is not known counts as 1 and sets `estimate`.
export const handlingBreakdown = (ship, endpoint, shuttleTechnology, version = null, support = null) => {
  if (strengthGaps(ship, endpoint, shuttleTechnology, version).length) {
    return null
  }

  const own = ship.Size <= SMALL_CRAFT_SIZE ? 1 : ship.ShuttleStrength
  const stack = stackFactors(officerFactors(ship, endpoint, support))
  const ownTerm = own * stack.product * shuttleTechnology
  const additive = endpoint.service ? shuttleTechnology : 0

  return { own, factors: stack.factors, officers: stack.product, technology: shuttleTechnology, ownTerm, additive, strength: ownTerm + additive, estimate: stack.estimate, known: stack.known, unknown: stack.unknown }
}

// Seconds a group of ships spends loading or unloading at one stop: every ship works at once, each taking cargo x 20 s (colonists x 10 s) / (its `handlingBreakdown` strength x its crew fraction), so the stop takes the slowest ship's time. A ship short of crew takes Class Crew / Current Crew times as long, once; an over-crewed ship is no faster and a ship with no crew aboard cannot load (docs `crew-and-commanders`, v2.6).
// `ships`: [{ ShipName, ClassName, ShipID, NavalAdminCommandID, CargoCapacity, ColonistCapacity, Size, ShuttleStrength, DesignedShuttleStrength, CurrentCrew, ClassCrew }]; `order`: { MoveActionID, endpoint } (an endpoint as `colonyEndpoint` gives it); `share`: the part of a full load moved; `version`: the formula version for the landing size (`loadFormulaVersion`); `support`: the officers' Logistics bonuses (`loadHandlingSupport`), `CLASS_ONLY` for a class plan, null when not read.
// Returns `seconds` (null when a ship at the stop can't load or its eligibility is not known), `limiting` (the ship that takes longest, null when none has anything to move), `strength` (its loading strength), `breakdown` (that ship's factors as `handlingBreakdown` gives them, with its `crew` share and `seconds`), `estimate` (an officer's bonus at the stop is not known, so the time is counted without it and errs long) with the officers whose bonus `known` applies and `unknown` is not settled, and `eligibility`: { status: 'permitted' | 'blocked' | 'unsupported', category, appliesCargoRules, via, reasons, checked, version }, `reasons` each { status, code, text, ship, endpoint } naming the responsible ship or endpoint and what is missing. An order that is not a cargo load or unload (`transferCategory`: troops, ship-to-ship transfers, anything else) isn't judged by the cargo rules: `appliesCargoRules` is false and nothing about it is rejected here.
export const stopHandling = (order, ships, shuttleTechnology, share = 1, { version = null, support = null } = {}) => {
  const category = transferCategory(order.MoveActionID)
  const kind = LOADS[order.MoveActionID] || UNLOADS[order.MoveActionID]

  if (!kind) {
    return { seconds: 0, limiting: null, strength: 0, breakdown: null, estimate: false, known: [], unknown: [], eligibility: { status: 'unsupported', category, appliesCargoRules: false, via: [], reasons: [], checked: 0, version } }
  }

  const endpoint = endpointOf(order.endpoint)
  const reasons = []
  const via = new Set()
  let seconds = 0
  let limiting = null
  let strength = 0
  let slowest = null
  const entries = []
  let checked = 0

  ships.forEach((ship) => {
    const name = shipNameOf(ship)
    const capacity = kind === 'colonists' ? ship.ColonistCapacity : ship.CargoCapacity

    if (share > 0 && !Number.isFinite(capacity)) {
      reasons.push({ status: 'unsupported', code: 'capacity', text: `${name}'s ${kind === 'colonists' ? 'colonist' : 'cargo'} capacity is not in the save`, ship: name, endpoint: endpoint.place })

      return
    }

    const amount = capacity * share

    if (!(amount > 0)) {
      return
    }

    checked += 1

    const verdict = shipEligibility(ship, endpoint, version)

    reasons.push(...verdict.reasons)

    if (verdict.status !== 'permitted') {
      return
    }

    verdict.via.forEach((source) => via.add(source))

    const gaps = strengthGaps(ship, endpoint, shuttleTechnology, version)

    if (gaps.length) {
      reasons.push(...gaps.map((gap) => ({ status: 'unsupported', code: gap, text: GAP_TEXT[gap](name, endpoint.place), ship: name, endpoint: endpoint.place })))

      return
    }

    const breakdown = handlingBreakdown(ship, endpoint, shuttleTechnology, version, support)
    const crew = crewFraction(ship)
    const shipSeconds = (amount * HANDLING_SECONDS[kind]) / (breakdown.strength * crew)

    entries.push(breakdown)

    if (shipSeconds > seconds) {
      seconds = shipSeconds
      limiting = ship
      strength = breakdown.strength
      slowest = { ship: name, ...breakdown, crew, seconds: shipSeconds }
    }
  })

  const unique = reasons.filter((reason, index) => reasons.findIndex((other) => other.text === reason.text) === index)
  const status = unique.some((reason) => reason.status === 'blocked') ? 'blocked' : unique.length ? 'unsupported' : 'permitted'
  const merged = mergeFactors(entries.map((entry) => entry.factors))

  return { seconds: unique.length ? null : seconds, limiting, strength, breakdown: slowest, estimate: merged.some((factor) => factor.state === 'unknown'), known: merged.filter((factor) => factor.state === 'applies'), unknown: merged.filter((factor) => factor.state === 'unknown'), eligibility: { status, category, appliesCargoRules: true, via: [...via], reasons: unique, checked, version } }
}

// Whether a fleet can transit an unstabilised jump point on its own: each group of its ships (military engines and commercial engines, ships in a hangar left out) needs a jump drive in the group that is rated for the group's largest ship. Commercial ships count commercial jump drives too; military ships don't. Ships are [{ Size, MilitaryEngines, Drive, AnyDrive, MothershipID }], `Drive` the best ordinary jump drive of the class and `AnyDrive` the best of any kind, as ship sizes.
export const fleetCanTransit = (ships) => {
  const independent = ships.filter((ship) => !ship.MothershipID)
  const covered = (group, driveOf) => !group.length || Math.max(0, ...group.map(driveOf)) >= Math.max(...group.map((ship) => ship.Size))

  return independent.length > 0 && covered(independent.filter((ship) => ship.MilitaryEngines), (ship) => ship.Drive || 0) && covered(independent.filter((ship) => !ship.MilitaryEngines), (ship) => ship.AnyDrive || 0)
}

// The columns `fleetCanTransit` reads from a ship's class, for a query that joins FCT_ShipClass: the largest jump drive of the class, `Drive` among the ordinary ones (component type 16 is a jump drive, special function 0 an ordinary one) and `AnyDrive` among every kind, each as the size of ship it carries (0 for none).
export const JUMP_DRIVE_COLUMNS = 'coalesce((select max(FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 16 and FCT_ShipDesignComponents.SpecialFunction = 0), 0) as Drive, coalesce((select max(FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 16), 0) as AnyDrive'

export const hasGate = (jumpPoint) => jumpPoint.JumpGateStrength > 0

// What a profile of ships may use on a route, for `searchRoutes`. A round trip comes back through every jump point it went through, so a jump point has to be fit to cross from both of its sides. `gates`: only stabilised jump points. `civilian`: no military restricted jump points or systems. `restrictedSystems`: a Set of SystemIDs.
export const transitRule = ({ gates, civilian }, jumpPointById, restrictedSystems) => ({
  canTransit: (jumpPoint) => {
    const far = jumpPointById[jumpPoint.WPLink]

    return Boolean(far) && (!gates || (hasGate(jumpPoint) && hasGate(far))) && (!civilian || !(jumpPoint.MilitaryRestricted || far.MilitaryRestricted))
  },
  canEnter: (systemId) => !civilian || !restrictedSystems.has(systemId),
})

// What a profile's rules stop on a route found without them, in route order: the jump points it can't cross and the systems it can't enter.
export const routeBlockers = (route, { gates, civilian }, restrictedSystems, systemName) => {
  const found = []

  routeLegs(route).forEach((leg) => {
    if (leg.kind !== 'jump') {
      return
    }

    const way = `from ${systemName(leg.from.SystemID)} to ${systemName(leg.to.SystemID)}`

    if (gates && !(hasGate(leg.from) && hasGate(leg.to))) {
      found.push(hasGate(leg.from) || hasGate(leg.to) ? `the jump point ${way} (stabilised on one side only)` : `the unstabilised jump point ${way}`)
    }

    if (civilian && (leg.from.MilitaryRestricted || leg.to.MilitaryRestricted)) {
      found.push(`the military restricted jump point ${way}`)
    }

    if (civilian && restrictedSystems.has(leg.to.SystemID)) {
      found.push(`${systemName(leg.to.SystemID)}, a military restricted system`)
    }
  })

  return [...new Set(found)]
}

const STOPS = [
  { where: 'origin', order: LOAD_CARGO },
  { where: 'origin', order: LOAD_COLONISTS, colonists: true },
  { where: 'destination', order: UNLOAD_CARGO },
  { where: 'destination', order: UNLOAD_COLONISTS, colonists: true },
]

// The upper bound of a cycle's time and the lower one are both a sum of what the walk gives, so a flight that cannot be timed at the highest case (a nebula cap with no armour known, crossed or held) and a shock that is not known are the two things a cycle can lack.
const timingProblemOf = (timed, timing) => (timed.flightHi === null ? { where: 'fleet', status: 'unknown', code: 'dust', text: nebulaGapOf(timing) } : { where: 'fleet', status: 'unknown', code: 'shock', text: timingGaps({ speed: 1, shock: timing.shock, shockMissing: timing.shockMissing }, { cyclic: true }).join(', ') })

// One cycle of a route as the events a fleet goes through: loading at the origin, the route flown, unloading at the destination and the route back, walked as a repeating cycle so the shock of the last jump runs down over the stops. `timing` is { steps (`routeLegs`), flights ({ out, back }, optional: the km of each flight of the way out and of the way back as the simulation of the year flew them, in the order of the steps, which keeps a flight between two jump points at its own distance), dust, armour, shock ({ lo, hi } or null), shockMissing }; without `flights` each flight is the step's own.
const cycleOf = (timing, speed, stops) => {
  const clock = { speed, speedIn: speedIn({ speed, dust: timing.dust, armour: timing.armour }) }
  const handling = (where) => stops.filter((stop) => stop.where === where).reduce((total, stop) => total + stop.seconds, 0)
  const flights = timing.flights || {}

  return walkEvents([handleEvent('origin', handling('origin')), ...routeEvents(timing.steps, clock, flights.out), handleEvent('destination', handling('destination')), ...routeEvents(reverseSteps(timing.steps), clock, flights.back)], timing.shock, { cyclic: true, retry: timing.retry })
}

const stopVerb = (where) => (where === 'origin' ? 'loading at the origin' : 'unloading at the destination')

// One group of ships (one class in one fleet) on a route of `km` one way: the round trip is 2 x km at top speed plus loading cargo and colonists at the origin and unloading them at the destination, each stop taking the slowest ship's time (`stopHandling`); `colonists: false` times the cargo alone. Ships are [{ ShipName, ClassName, CargoCapacity, ColonistCapacity, Size, ShuttleStrength, DesignedShuttleStrength, CurrentCrew, ClassCrew, MaxSpeed, EnginePower, FuelEfficiency, FuelCapacity }], the first one standing for the group's speed and fuel. `endpoints`: { origin, destination }, each a `colonyEndpoint` or `bareEndpoint`. `version`: the formula version (`loadFormulaVersion`), null when the save's is not known.
// `timing` (`fleetTimingOf` of utilities/route-time.js with the route's `steps`): the fleet's crew, which adds the waits for the jump shock to the cycle; `jumps` is the transits one way of a class timed alone, which the result then names as left out.
// Returns `status`: 'ok', 'blocked' (a ship can't load or unload, `problems` says which ship and where), 'unknown' (a needed input is missing or the landing rule is not verified for the version: `problems` says which), 'immobile' (the class has no speed), 'range' (the round trip needs more fuel than the tank holds) or 'none' (nothing to time); `problems`, each { where, status: 'blocked' | 'unsupported', code, text }; `stops`, each stop's `where`, `seconds`, `limiting` ship, its `strength` and `via` (what lets the ships load there); `limiting`, the longest stop's { where, ship, strength } (null when nothing is moved); and the times and fuel, null where they cannot be given: a trip that cannot run has no time of its own.
export const roundTrip = (ships, km, endpoints, shuttleTechnology, { colonists = true, version = null, support = null, timing = null, jumps = 0 } = {}) => {
  const [shipClass] = ships
  const stops = STOPS.filter((stop) => colonists || !stop.colonists).map((stop) => ({ ...stop, ...stopHandling({ MoveActionID: stop.order, endpoint: endpoints[stop.where] }, ships, shuttleTechnology, 1, { version, support }) }))
  const problems = stops.flatMap((stop) => stop.eligibility.reasons.map((reason) => ({ where: stop.where, status: reason.status, code: reason.code, text: `${stopVerb(stop.where)}: ${reason.text}` }))).filter((problem, index, all) => all.findIndex((other) => other.text === problem.text) === index)
  const blocked = problems.some((problem) => problem.status === 'blocked')
  const moves = shipClass.MaxSpeed > 0
  const handlingSeconds = problems.length ? null : stops.reduce((total, stop) => total + stop.seconds, 0)
  const timed = moves && timing && handlingSeconds !== null ? cycleOf(timing, shipClass.MaxSpeed, stops) : null
  const timingProblems = timed && !timed.total ? [timingProblemOf(timed, timing)] : []
  const travelSeconds = timed ? timed.flightHi : moves ? (2 * km) / shipClass.MaxSpeed : null
  // Fuel follows the distance at the set speed: a nebula that holds the fleet at a lower speed lowers its engine power in step, so the longer flight burns what the same distance burns at the set speed.
  const fuelSeconds = timed ? (timed.km === null ? null : timed.km / shipClass.MaxSpeed) : travelSeconds
  const tripSecondsAt = (key) => (!moves || handlingSeconds === null ? null : timed ? (timed.total ? timed.total[key] : null) : travelSeconds + handlingSeconds)
  const tripSeconds = tripSecondsAt('hi')
  const fuelPerShip = moves && fuelSeconds !== null ? shipClass.EnginePower * shipClass.FuelEfficiency * (fuelSeconds / 3600) : null
  const slowest = stops.reduce((longest, stop) => (stop.limiting && (!longest || stop.seconds > longest.seconds) ? stop : longest), null)
  const status = blocked ? 'blocked' : problems.length || timingProblems.length ? 'unknown' : !moves ? 'immobile' : !(tripSeconds > 0) ? 'none' : fuelPerShip > shipClass.FuelCapacity ? 'range' : 'ok'
  const merged = mergeFactors(stops.flatMap((stop) => [stop.known, stop.unknown]))

  return {
    status,
    problems: [...problems, ...timingProblems],
    versionSupported: landingThreshold(version) !== null,
    stops: stops.map(({ where, colonists: moves, seconds, limiting, strength, breakdown, estimate, known, unknown, eligibility }) => ({ where, kind: moves ? 'colonists' : 'cargo', seconds, limiting, strength, breakdown, estimate, known, unknown, via: eligibility.via })),
    limiting: slowest ? { where: slowest.where, ship: slowest.limiting, strength: slowest.strength } : null,
    estimate: merged.some((factor) => factor.state === 'unknown'),
    known: merged.filter((factor) => factor.state === 'applies'),
    unknown: merged.filter((factor) => factor.state === 'unknown'),
    travelSeconds,
    fuelSeconds,
    handlingSeconds,
    jumps,
    waitCounted: Boolean(timed),
    waitSeconds: timed ? timed.wait : null,
    transitSeconds: timed ? timed.transit : null,
    cycle: timed,
    tripSecondsLow: tripSecondsAt('lo'),
    tripSeconds,
    trips: tripSeconds === null ? null : tripSeconds > 0 ? SECONDS_PER_YEAR / tripSeconds : 0,
    fuelPerShip,
    fuelShare: fuelPerShip === null ? null : shipClass.FuelCapacity > 0 ? fuelPerShip / shipClass.FuelCapacity : 0,
  }
}

// The round trip's time as a provenance result: the rule's own status when the trip can run, unavailable naming what is missing when it is 'unknown' or 'immobile', and null for a trip that is blocked or has nothing to time (the status says why). The officers whose Logistics bonus applies are inputs it read, the ones the save cannot settle are missing inputs it counted as 1.
export const tripResult = (trip) => {
  if (trip.status === 'unknown') {
    return unavailable({ rule: 'transport.roundTrip', missing: [...missingInputsOf(trip.problems.filter((problem) => problem.where !== 'fleet')), ...trip.problems.filter((problem) => problem.where === 'fleet').map((problem) => problem.text)] })
  } else if (trip.status === 'immobile') {
    return unavailable({ rule: 'transport.roundTrip', missing: ['a top speed above 0'] })
  } else if (trip.status === 'ok' || trip.status === 'range') {
    const { inputs, assumptions } = bonusProvenance(trip)
    const unwaited = trip.jumps > 0 && !trip.waitCounted

    return ofRule({ rule: 'transport.roundTrip', value: trip.tripSeconds / SECONDS_PER_DAY, inputs: unwaited ? { present: inputs.present, missing: [...inputs.missing, 'the crew of the ships, which the wait after each jump needs'] } : inputs, assumptions: [...(trip.versionSupported ? [] : [UNVERIFIED_VERSION]), ...assumptions, ...(unwaited ? ['the time is the least the cycle takes: the waits for the jump shock are not added'] : [])] })
  }

  return null
}

// The loading strength of each stop as table rows for the breakdown panel: one row per stop that moves cargo, `stops` being [{ key, label, breakdown }] with each `breakdown` as `stopHandling` gives it (null for a stop that moves nothing, which has no row). A row carries the ship that sets the stop, its own strength, each officer's factor with the `cell` that shows it, the technology, the colony's additive term, the crew share, the strength and the seconds, and a provenance result for each: `result` of the strength (the officers whose bonus applies are inputs it read, the unknown ones inputs it lacked), `results` of the own strength, the technology, the colony's addition, the crew share and the seconds, and the `result` of each officer's factor (unavailable for an officer the save cannot settle, which the strength counts as 1).
export const handlingRows = (stops) => stops.filter((stop) => stop.breakdown).map(({ key, label, breakdown }) => {
  const { inputs, assumptions } = bonusProvenance(breakdown)
  const officerResult = (factor) => {
    if (factor.state === 'unknown') {
      return unavailable({ rule: 'transport.logisticsBonuses', missing: [`${factor.label}'s Logistics bonus`] })
    }

    return ofRule({ rule: 'transport.logisticsBonuses', value: factor.value, inputs: { present: factor.state === 'applies' ? [`${factor.label}'s Logistics bonus`] : [] }, assumptions: factor.state === 'none' ? [`${factor.label} has no Logistics bonus, so it counts as 1`] : [] })
  }

  return {
    key,
    stop: label,
    ship: breakdown.ship,
    own: breakdown.own,
    factors: breakdown.factors.map((factor) => ({ ...factor, cell: factorCell(factor), result: officerResult(factor) })),
    officers: breakdown.officers,
    technology: breakdown.technology,
    ownTerm: breakdown.ownTerm,
    additive: breakdown.additive,
    crew: breakdown.crew,
    strength: breakdown.strength,
    seconds: breakdown.seconds,
    estimate: breakdown.estimate,
    result: ofRule({ rule: 'transport.handlingStrength', value: breakdown.strength, inputs, assumptions }),
    results: {
      own: ofRule({ rule: 'transport.ownStrength', value: breakdown.own, inputs: { present: ['the ship\'s size and undamaged cargo shuttle bays'] } }),
      technology: ofRule({ rule: 'transport.shuttleTechnology', value: breakdown.technology, inputs: { present: ['the race\'s cargo shuttle technology'] } }),
      additive: ofRule({ rule: 'transport.colonyAddition', value: breakdown.additive, inputs: { present: ['whether the colony has a spaceport or cargo shuttle station'] } }),
      crew: ofRule({ rule: 'crew.fraction', value: breakdown.crew, inputs: { present: ['the ship\'s crew and its class crew'] } }),
      seconds: Number.isFinite(breakdown.seconds) ? ofRule({ rule: 'transport.handlingTime', value: breakdown.seconds, inputs, assumptions }) : unavailable({ rule: 'transport.handlingTime', missing: ['a loading strength above 0'] }),
    },
  }
})
