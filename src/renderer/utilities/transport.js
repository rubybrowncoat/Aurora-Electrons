// Maths for the Transport page and what Hauling shares with it: which jump points a fleet's ships can transit, the loading strength of a ship at a stop and the time a stop takes, and the round trip of a group of ships between two places.

import { crewFraction } from './minerals'
import { routeLegs } from './jump-graph'

export const SECONDS_PER_YEAR = 31536000

// Move actions that load or unload cargo, by what they carry.
export const LOADS = { 4: 'colonists', 176: 'installations', 62: 'minerals', 178: 'minerals', 180: 'minerals', 223: 'minerals', 165: 'minerals' }
export const UNLOADS = { 6: 'colonists', 96: 'installations', 177: 'installations', 63: 'minerals', 179: 'minerals', 165: 'minerals' }
// Seconds to load or unload one cargo point or one colonist at a loading strength of 1 (docs `logistics`, Logistics and Cargo Handling).
const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }
// DIM_MoveAction: Load All Minerals, Load Colonists, Unload Minerals and Unload Colonists.
const LOAD_CARGO = 62
const LOAD_COLONISTS = 4
const UNLOAD_CARGO = 63
const UNLOAD_COLONISTS = 6
// A class of this size (in hull spaces, 500 t) or less lands on a colony: its own loading strength is 1 whatever bays it has.
const SMALL_CRAFT_SIZE = 10
// DIM_ComponentType: Cargo Shuttle Bay.
const CARGO_SHUTTLE_BAY = 14
// A class's cargo shuttle bays as the game adds them up: each bay counts its own strength (ComponentValue), so a high-strength bay is worth its strength, not one. The class's stored CargoShuttleStrength isn't used: in the saves it is sometimes the bay total times the race's technology, which `handlingStrength` applies itself.
const CLASS_BAYS = `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${CARGO_SHUTTLE_BAY}`

// The column `handlingStrength` reads from a ship, for a query that joins FCT_Ship and FCT_ShipClass: `ShuttleStrength`, what the ship's undamaged cargo shuttle bays add up to. A ship's damaged bays are taken off the class's bays by the ship's FCT_DamagedComponent rows, one component design at a time.
export const SHUTTLE_STRENGTH_COLUMNS = `coalesce((select sum(max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID), 0), 0) * FCT_ShipDesignComponents.ComponentValue) ${CLASS_BAYS}), 0) as ShuttleStrength`

// The same column for a query that joins FCT_ShipClass alone: the class's bays as designed, none of them damaged.
export const CLASS_SHUTTLE_STRENGTH_COLUMNS = `coalesce((select sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) ${CLASS_BAYS}), 0) as ShuttleStrength`

// The loading strength of one ship at a stop, by the game's rule: the ship's own strength (1 for a craft of `SMALL_CRAFT_SIZE` hull spaces or less, whatever bays it has; its undamaged bays' strength, `ShuttleStrength`, for a larger ship) times the race's cargo handling technology, plus that technology once more when the colony has a spaceport or cargo shuttle station, however many it has. Commander, governor, admin and sector Logistics bonuses multiply the ship's own term in the game and aren't counted here, so a time comes out long when they apply. Ships are { Size, ShuttleStrength }; `shuttleTechnology` is the race's CargoShuttleLoadModifier, 1 when unknown.
export const handlingStrength = (ship, station, shuttleTechnology) => {
  const technology = shuttleTechnology ?? 1
  const own = ship.Size <= SMALL_CRAFT_SIZE ? 1 : ship.ShuttleStrength || 0

  return own * technology + (station ? technology : 0)
}

// Seconds a group of ships spends loading or unloading at one stop: every ship works at once, each taking cargo x 20 s (colonists x 10 s) / (its `handlingStrength` x its crew fraction), so the stop takes the slowest ship's time. A ship short of crew takes Class Crew / Current Crew times as long (docs `crew-and-commanders`, v2.6; over-crewed ships aren't faster). A ship that can't load there (no crew aboard, or no strength: no undamaged bays, no station and too big to land) sets `blocked` to why: 'crew' or 'bays'. Returns `seconds`, `blocked`, `limiting` (the ship that takes longest, null when none has anything to move) and `strength` (its loading strength).
// `ships`: [{ CargoCapacity, ColonistCapacity, Size, ShuttleStrength, CurrentCrew, ClassCrew }]; `order`: { MoveActionID, Station }; `share`: the part of a full load moved.
export const stopHandling = (order, ships, shuttleTechnology, share = 1) => {
  const kind = LOADS[order.MoveActionID] || UNLOADS[order.MoveActionID]

  if (!kind) {
    return { seconds: 0, blocked: null, limiting: null, strength: 0 }
  }

  let seconds = 0
  let blocked = null
  let limiting = null
  let strength = 0

  ships.forEach((ship) => {
    const amount = (kind === 'colonists' ? ship.ColonistCapacity : ship.CargoCapacity) * share

    if (!(amount > 0)) {
      return
    }

    const crew = crewFraction(ship)
    const shipStrength = handlingStrength(ship, order.Station, shuttleTechnology)

    if (!crew || !(shipStrength > 0)) {
      blocked = blocked || (crew ? 'bays' : 'crew')

      return
    }

    const shipSeconds = (amount * HANDLING_SECONDS[kind]) / (shipStrength * crew)

    if (shipSeconds > seconds) {
      seconds = shipSeconds
      limiting = ship
      strength = shipStrength
    }
  })

  return { seconds, blocked, limiting, strength }
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

const handlingProblem = (reason) => (reason === 'crew' ? 'a ship has no crew aboard' : 'no undamaged shuttle bays or station, and too big to land')

// One group of ships (one class in one fleet) on a route of `km` one way: the round trip is 2 x km at top speed plus loading cargo and colonists at the origin and unloading them at the destination, each stop taking the slowest ship's time (`stopHandling`); `colonists: false` times the cargo alone. Ships are [{ CargoCapacity, ColonistCapacity, Size, ShuttleStrength, CurrentCrew, ClassCrew, MaxSpeed, EnginePower, FuelEfficiency, FuelCapacity }], the first one standing for the group's speed and fuel. `stations`: { origin, destination }, whether the colony there has a spaceport or cargo shuttle station. Returns `status`: 'ok', 'blocked' (a ship can't load or unload, `problems` says where), 'range' (the round trip needs more fuel than the tank holds) or 'none' (nothing to time); `stops`, each stop's `where`, `seconds`, `limiting` ship and its `strength`; `limiting`, the longest stop's { where, ship, strength } (null when nothing is moved).
export const roundTrip = (ships, km, stations, shuttleTechnology, { colonists = true } = {}) => {
  const [shipClass] = ships
  const stops = [
    { where: 'origin', order: LOAD_CARGO, station: stations.origin },
    { where: 'origin', order: LOAD_COLONISTS, station: stations.origin, colonists: true },
    { where: 'destination', order: UNLOAD_CARGO, station: stations.destination },
    { where: 'destination', order: UNLOAD_COLONISTS, station: stations.destination, colonists: true },
  ].filter((stop) => colonists || !stop.colonists).map((stop) => ({ ...stop, ...stopHandling({ MoveActionID: stop.order, Station: stop.station }, ships, shuttleTechnology) }))
  const problems = stops.filter((stop) => stop.blocked).map((stop) => ({ where: stop.where, reason: stop.blocked, text: `${stop.where === 'origin' ? 'loading at the origin' : 'unloading at the destination'}: ${handlingProblem(stop.blocked)}` })).filter((problem, index, all) => all.findIndex((other) => other.text === problem.text) === index)
  const handlingSeconds = stops.reduce((total, stop) => total + stop.seconds, 0)
  const slowest = stops.reduce((longest, stop) => (stop.limiting && (!longest || stop.seconds > longest.seconds) ? stop : longest), null)
  const travelSeconds = (2 * km) / shipClass.MaxSpeed
  const tripSeconds = travelSeconds + handlingSeconds
  const fuelPerShip = shipClass.EnginePower * shipClass.FuelEfficiency * (travelSeconds / 3600)
  const status = problems.length ? 'blocked' : !(tripSeconds > 0) ? 'none' : fuelPerShip > shipClass.FuelCapacity ? 'range' : 'ok'

  return {
    status,
    problems,
    stops: stops.map(({ where, seconds, limiting, strength }) => ({ where, seconds, limiting, strength })),
    limiting: slowest ? { where: slowest.where, ship: slowest.limiting, strength: slowest.strength } : null,
    travelSeconds,
    handlingSeconds,
    tripSeconds,
    trips: tripSeconds > 0 ? SECONDS_PER_YEAR / tripSeconds : 0,
    fuelPerShip,
    fuelShare: shipClass.FuelCapacity > 0 ? fuelPerShip / shipClass.FuelCapacity : 0,
  }
}
