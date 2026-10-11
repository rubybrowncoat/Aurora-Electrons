// Maths for the Transport page: which jump points a fleet's ships can transit, and the round trip of a group of ships between two places. Loading and unloading come from utilities/hauling.js `stopHandling`.

import { SECONDS_PER_YEAR, stopHandling } from './hauling'
import { routeLegs } from './jump-graph'

// DIM_MoveAction: Load All Minerals, Load Colonists, Unload Minerals and Unload Colonists.
const LOAD_CARGO = 62
const LOAD_COLONISTS = 4
const UNLOAD_CARGO = 63
const UNLOAD_COLONISTS = 6
// A class of this size (in hull spaces, 500 t) or less lands on a colony: its handling modifier is 1 whatever bays it has.
const SMALL_CRAFT_SIZE = 10
const TONS_PER_HULL_SPACE = 50

// Whether a fleet can transit an unstabilised jump point on its own: each group of its ships (military engines and commercial engines, ships in a hangar left out) needs a jump drive in the group that is rated for the group's largest ship. Commercial ships count commercial jump drives too; military ships don't. Ships are [{ Size, MilitaryEngines, Drive, AnyDrive, MothershipID }], `Drive` the best ordinary jump drive of the class and `AnyDrive` the best of any kind, as ship sizes.
export const fleetCanTransit = (ships) => {
  const independent = ships.filter((ship) => !ship.MothershipID)
  const covered = (group, driveOf) => !group.length || Math.max(0, ...group.map(driveOf)) >= Math.max(...group.map((ship) => ship.Size))

  return independent.length > 0 && covered(independent.filter((ship) => ship.MilitaryEngines), (ship) => ship.Drive || 0) && covered(independent.filter((ship) => !ship.MilitaryEngines), (ship) => ship.AnyDrive || 0)
}

const hasGate = (jumpPoint) => jumpPoint.JumpGateStrength > 0

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

const handlingProblem = (reason) => (reason === 'crew' ? 'a ship has no crew aboard' : 'no shuttle bays or station, and too big to land')

// One group of ships (one class in one fleet) on a route of `km` one way: the round trip is 2 x km at top speed plus loading cargo and colonists at the origin and unloading them at the destination, each stop taking the slowest ship's time. `stations`: { origin, destination }, whether the colony there has a spaceport or cargo shuttle station. Returns `status`: 'ok', 'blocked' (a ship can't load or unload, `problems` says where), 'range' (the round trip needs more fuel than the tank holds) or 'none' (nothing to time).
export const roundTrip = (ships, km, stations, shuttleTechnology) => {
  const [shipClass] = ships
  const handled = ships.map((ship) => ({
    CargoCapacity: shipClass.CargoCapacity,
    ColonistCapacity: shipClass.ColonistCapacity,
    Bays: shipClass.Size <= SMALL_CRAFT_SIZE ? 1 : shipClass.CargoShuttleStrength,
    Tons: shipClass.Size * TONS_PER_HULL_SPACE,
    CurrentCrew: ship.CurrentCrew,
    ClassCrew: shipClass.ClassCrew,
  }))
  const stops = [
    { where: 'origin', order: LOAD_CARGO, station: stations.origin },
    { where: 'origin', order: LOAD_COLONISTS, station: stations.origin },
    { where: 'destination', order: UNLOAD_CARGO, station: stations.destination },
    { where: 'destination', order: UNLOAD_COLONISTS, station: stations.destination },
  ].map((stop) => ({ ...stop, ...stopHandling({ MoveActionID: stop.order, Station: stop.station }, handled, shuttleTechnology) }))
  const problems = stops.filter((stop) => stop.blocked).map((stop) => ({ where: stop.where, reason: stop.blocked, text: `${stop.where === 'origin' ? 'loading at the origin' : 'unloading at the destination'}: ${handlingProblem(stop.blocked)}` })).filter((problem, index, all) => all.findIndex((other) => other.text === problem.text) === index)
  const handlingSeconds = stops.reduce((total, stop) => total + stop.seconds, 0)
  const travelSeconds = (2 * km) / shipClass.MaxSpeed
  const tripSeconds = travelSeconds + handlingSeconds
  const fuelPerShip = shipClass.EnginePower * shipClass.FuelEfficiency * (travelSeconds / 3600)
  const status = problems.length ? 'blocked' : !(tripSeconds > 0) ? 'none' : fuelPerShip > shipClass.FuelCapacity ? 'range' : 'ok'

  return {
    status,
    problems,
    travelSeconds,
    handlingSeconds,
    tripSeconds,
    trips: tripSeconds > 0 ? SECONDS_PER_YEAR / tripSeconds : 0,
    fuelPerShip,
    fuelShare: shipClass.FuelCapacity > 0 ? fuelPerShip / shipClass.FuelCapacity : 0,
  }
}
