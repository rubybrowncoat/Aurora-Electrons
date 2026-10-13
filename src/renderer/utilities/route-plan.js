// A route through several stops, as Route Finder plans it: each leg is the route from one stop to the next over the explored jump points (utilities/jump-graph.js `searchRoutes`), and a cycle adds one back to the first stop.

import { routeLegs, routeResults, searchRoutes } from './jump-graph'
import { combine, envelope, ofRule, registerRule, unavailable } from './provenance'

// A system's own place is its centre, (0, 0); any other place is where the save has it, and a place with no position there reaches nothing (`searchRoutes`).
const positionOf = (place) => (place.kind === 'system' ? { SystemID: place.SystemID, Xcor: 0, Ycor: 0 } : { SystemID: place.SystemID, Xcor: place.Xcor, Ycor: place.Ycor })

// `stops`: places ({ key, kind, name, SystemID, Xcor, Ycor }) in order, or for a stop that can't be told `{ key, name, unavailable: true }`. `options` are `searchRoutes`'s (`order`, `canTransit`, `canEnter`, `lagrangePoints`). A leg runs from where the fleet is after the one before: a place is its own position, but a system is where its route arrives, the jump point it comes in through (a leg that starts at a system centre is only the first). A leg into or out of an unavailable stop has no route, and neither joins the stops either side of it. Returns:
// - `legs`: one per leg, { index, from, to, start, route, steps, unavailable, closing }, `index` being that of the stop it leaves, `start` the position it is flown from (null out of an unavailable stop), `route` { jumps, km, from, end } or null when no explored route joins them, and `steps` its `routeLegs`.
// - `jumps` and `km`: the totals of the legs that have a route; `missing` counts the ones that haven't, those of unavailable stops too.
// - `systems`: the SystemIDs the route passes through in order, for the map.
export const planRoute = (stops, { cycle, jumpPoints, ...options }) => {
  const targets = stops.slice(1)

  if (cycle && stops.length > 1) {
    targets.push(stops[0])
  }

  const searches = new Map()
  const searchFrom = (start) => {
    const id = `${start.SystemID}:${start.Xcor}:${start.Ycor}`

    if (!searches.has(id)) {
      searches.set(id, searchRoutes(jumpPoints, [start], options))
    }

    return searches.get(id)
  }
  const legs = []
  const systems = []
  const first = stops[0]
  let start = first && !first.unavailable ? positionOf(first) : null
  let jumps = 0
  let km = 0
  let missing = 0

  targets.forEach((to, index) => {
    const closing = Boolean(cycle) && index === targets.length - 1

    if (!start || to.unavailable) {
      legs.push({ index, from: stops[index], to, start, route: null, steps: [], unavailable: true, closing })
      missing += 1

      if (start) {
        systems.push(start.SystemID)
      }

      start = to.unavailable ? null : positionOf(to)

      return
    }

    const search = searchFrom(start)
    const route = to.kind === 'system' ? search.toSystem(to.SystemID) : search.toPlace(to)
    const steps = route ? routeLegs(route) : []

    legs.push({ index, from: stops[index], to, start, route, steps, unavailable: false, closing })

    if (route) {
      jumps += route.jumps
      km += route.km
      steps.forEach((step) => systems.push(step.kind === 'jump' ? step.to.SystemID : step.SystemID))

      if (!steps.length) {
        systems.push(start.SystemID)
      }
    } else {
      missing += 1
      systems.push(start.SystemID)
    }

    // A system is reached at the jump point a route comes in through, or is where the fleet already is.
    const arrival = route && route.end && to.kind === 'system' ? route.end.at : null

    start = to.kind === 'system' && route ? (arrival ? { SystemID: to.SystemID, Xcor: arrival.Xcor, Ycor: arrival.Ycor } : start) : positionOf(to)
  })

  if (targets.length) {
    if (start) {
      systems.push(start.SystemID)
    }
  } else if (first && !first.unavailable) {
    systems.push(first.SystemID)
  }

  return { legs, jumps, km, missing, systems: systems.filter((id, index) => id !== systems[index - 1]) }
}

// The rules of a planned route: its totals, the speed and time it is flown at, the stops' options and the figures drawn from them. The rules of one route's jumps and distance are in utilities/jump-graph.js.
const PLAN_VERSIONS = ['2.7.x']
const SECONDS_PER_DAY = 86400
const ROUTE_INPUTS = ['the explored jump points', 'their positions']

registerRule({
  id: 'route.travelTime',
  versions: PLAN_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['route.distanceKm', 'route.effectiveSpeed'],
  note: 'The route\'s distance divided by one speed, in the unit that reads best. Jumps take no time here; the jump shock after each, nebula speed limits, acceleration and refuelling are left out, so the figure is not compared with times the game stores.',
  assumptions: ['one speed all the way', 'no jump shock, nebula limits or refuelling stops'],
})

registerRule({
  id: 'route.effectiveSpeed',
  versions: PLAN_VERSIONS,
  units: 'km/s',
  verification: 'assumed',
  structure: ['FCT_ShipClass.MaxSpeed', 'FCT_Fleet.Speed'],
  note: 'The speed a route is flown at: the one entered here or taken from a fleet, otherwise the median top speed of the ship classes the race has ships of that move. With neither there is no speed and no travel time.',
  assumptions: ['the speed entered here, or the median top speed of the classes in service'],
})

registerRule({
  id: 'route.stabilisedJumps',
  versions: PLAN_VERSIONS,
  units: 'jumps',
  verification: 'confirmed',
  structure: ['FCT_JumpPoint.JumpGateStrength', 'FCT_LagrangePoint'],
  note: 'Counts of the route\'s steps from the save: the jumps made through a stabilised jump point (gate strength above 0) and the systems where the route jumps between Lagrange points.',
})

registerRule({
  id: 'route.reachableCount',
  versions: PLAN_VERSIONS,
  units: 'systems',
  verification: 'confirmed',
  structure: ['FCT_RaceSysSurvey', 'FCT_JumpPoint', 'FCT_RaceJumpPointSurvey.Explored'],
  note: 'Counts of the known systems by how an explored route from the first stop meets them: reached, avoided by an option, cut off by an option or out of reach. Which systems an option avoids is its own rule (`route.avoidance`).',
  assumptions: ['the avoid and transit options chosen here'],
})

registerRule({
  id: 'route.avoidance',
  versions: PLAN_VERSIONS,
  units: 'systems',
  verification: 'assumed',
  structure: ['FCT_RaceSysSurvey.DangerRating, NoAutoRoute, MilitaryRestrictedSystem, ControlRaceID', 'FCT_ShipClass.ProtectionValue', 'FCT_AlienRace.TradeTreaty', 'FCT_RaceJumpPointSurvey.MilitaryRestricted', 'FCT_JumpPoint.JumpGateStrength'],
  note: 'The movement settings of a fleet applied to a route: a system is avoided for a danger rating its own ships\' protection value does not outweigh, for an alien owner without a trade treaty, for the no auto-route flag or, for civilian shipping, for military restriction; a jump point is left out unless stabilised or unrestricted when those options are on. The settings are the player\'s choice, and the danger rule itself is not checked against saved routes.',
  assumptions: ['a system or jump point whose flag or rating the save does not hold is avoided, since a fleet entering it unchecked could be unsafe', 'a system with no ships of the race has a protection value of 0'],
})

registerRule({
  id: 'route.detailTotal',
  versions: PLAN_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['route.distanceKm'],
  note: 'The distance flown so far along the plan, a running sum of the legs\' flights. After a leg that no explored route joins it counts only the legs that have a route.',
})

registerRule({
  id: 'route.reachShade',
  versions: PLAN_VERSIONS,
  units: 'shade',
  verification: 'assumed',
  note: 'A display scale, not a game rule: a reachable system\'s shade fades with its distance (or jumps) from the first stop as a share of the farthest reachable system\'s, and a stop, a system on the route, an avoided system and one out of reach each have their own colour or size.',
  assumptions: ['shades and sizes are a display choice'],
})

// A distance in km as a result: the confirmed arithmetic over the route's positions, unavailable for a figure that is not a number.
export const distanceResult = (km, missing = 'the route\'s distance') => (Number.isFinite(km) ? ofRule({ rule: 'route.distanceKm', value: km, inputs: { present: ROUTE_INPUTS } }) : unavailable({ rule: 'route.distanceKm', missing: [missing] }))

// The speed a route is flown at, as a result: `speed` is the one entered or taken from a fleet (a number above 0), else the median of `classSpeeds` (the top speeds of the classes in service that move, fastest first). With neither, unavailable: there is no default speed.
export const flightSpeed = (speed, classSpeeds) => {
  if (speed > 0) {
    return ofRule({ rule: 'route.effectiveSpeed', value: speed, inputs: { present: ['the speed entered'] }, assumptions: ['the speed entered here is flown the whole way'] })
  }

  const speeds = classSpeeds.filter((value) => Number.isFinite(value) && value > 0)

  if (!speeds.length) {
    return unavailable({ rule: 'route.effectiveSpeed', missing: ['a speed (none entered, and the race has no ship class in service that moves)'] })
  }

  return ofRule({ rule: 'route.effectiveSpeed', value: speeds[Math.floor(speeds.length / 2)], inputs: { present: ['the ship classes\' top speeds'] }, assumptions: ['the median top speed of the classes in service'] })
}

// The time to fly `distance` (a result in km) at `speed` (`effectiveSpeed`'s result), in days; unavailable when either is. A distance of 0 is a real 0 days.
export const travelTime = (distance, speed) => combine({ rule: 'route.travelTime', parts: { distance, speed }, compute: (values) => values.distance / values.speed / SECONDS_PER_DAY })

// The options of a plan as a search takes them, from `options` { gatesOnly, civilian } and the jump points: `canTransit(jumpPoint)` and `assumptions`, the jump points whose gate strength or restriction the save lacks being treated as not transitable while an option that reads it is on.
export const transitOptions = (options, jumpPoints) => {
  const { gatesOnly, civilian } = options
  const unknownGates = gatesOnly ? jumpPoints.filter((jumpPoint) => !Number.isFinite(jumpPoint.JumpGateStrength)).length : 0
  const unknownRestrictions = civilian ? jumpPoints.filter((jumpPoint) => jumpPoint.MilitaryRestricted === null || jumpPoint.MilitaryRestricted === undefined).length : 0
  const assumptions = []

  if (unknownGates) {
    assumptions.push(`${unknownGates} ${unknownGates === 1 ? 'jump point has' : 'jump points have'} no gate strength in the save and ${unknownGates === 1 ? 'is' : 'are'} not taken as stabilised`)
  }

  if (unknownRestrictions) {
    assumptions.push(`${unknownRestrictions} ${unknownRestrictions === 1 ? 'jump point has' : 'jump points have'} no restriction flag in the save and ${unknownRestrictions === 1 ? 'is' : 'are'} taken as restricted`)
  }

  return {
    canTransit: (jumpPoint) => (!gatesOnly || jumpPoint.JumpGateStrength > 0) && (!civilian || jumpPoint.MilitaryRestricted === 0 || jumpPoint.MilitaryRestricted === false),
    assumptions,
  }
}

const flagOf = (value) => (value === null || value === undefined ? null : Boolean(value))

// The protection value of the race's ships in a system, or null when it is not known: 0 for a system with none of the race's ships, the sum when every ship's class has a value, null when some do not. `system`: { Protection, ProtectionShips, ProtectionKnown }, the sum and the counts of the race's ships there and of those whose class has a protection value.
export const systemProtection = (system) => {
  if (!Number.isFinite(system.ProtectionShips)) {
    return null
  } else if (!system.ProtectionShips) {
    return 0
  }

  return system.ProtectionKnown >= system.ProtectionShips && Number.isFinite(system.Protection) ? system.Protection : null
}

// Why a route may not enter a system with `options` { avoidDanger, avoidAlien, skipNoAutoRoute, civilian }, as { reason, assumed }, or null when it may. `reason` is the text; `assumed` is true when the save lacks what the test reads, so the system is avoided on an assumption. `number(n)` writes a rating. `system`: { NoAutoRoute, DangerRating, Controller, ControlKnown, TradeTreaty, MilitaryRestrictedSystem } and what `systemProtection` reads.
export const avoidance = (system, options, number = String) => {
  if (options.skipNoAutoRoute) {
    const flag = flagOf(system.NoAutoRoute)

    if (flag === null) {
      return { reason: 'No auto-route flag not in the save', assumed: true }
    } else if (flag) {
      return { reason: 'No auto-route', assumed: false }
    }
  }

  if (options.avoidDanger) {
    if (!Number.isFinite(system.DangerRating)) {
      return { reason: 'Danger rating not in the save', assumed: true }
    } else if (system.DangerRating > 0) {
      const protection = systemProtection(system)

      if (protection === null) {
        return { reason: `Danger rating ${number(system.DangerRating)}, protection of the race's ships not known`, assumed: true }
      } else if (protection <= system.DangerRating) {
        return { reason: `Danger rating ${number(system.DangerRating)}`, assumed: false }
      }
    }
  }

  if (options.avoidAlien) {
    if (system.ControlKnown === false || system.ControlKnown === 0) {
      return { reason: 'Owner not in the save', assumed: true }
    } else if (system.Controller) {
      const treaty = flagOf(system.TradeTreaty)

      if (treaty === null) {
        return { reason: `Held by ${system.Controller}, trade treaty not in the save`, assumed: true }
      } else if (!treaty) {
        return { reason: `Held by ${system.Controller}`, assumed: false }
      }
    }
  }

  if (options.civilian) {
    const flag = flagOf(system.MilitaryRestrictedSystem)

    if (flag === null) {
      return { reason: 'Military restriction not in the save', assumed: true }
    } else if (flag) {
      return { reason: 'Military restricted', assumed: false }
    }
  }

  return null
}

// The jumps and distance of a whole plan as { jumps, km } results, or null for a plan with no leg. A plan none of whose legs has a route is unavailable; one with some unrouted legs gives the totals of the routed ones as an estimate that names the missing legs. `assumptions` (the options' unknown flags) go on every result.
export const planResults = (plan, assumptions = []) => {
  const legs = plan.legs.length

  if (!legs) {
    return null
  }

  const routed = legs - plan.missing

  if (!routed) {
    const none = routeResults(null, 'an explored route for each leg')

    return { jumps: unavailable({ rule: 'route.jumps', missing: none.jumps.inputs.missing, assumptions }), km: unavailable({ rule: 'route.distanceKm', missing: none.km.inputs.missing, assumptions }) }
  }

  const made = (rule, value) => (plan.missing ? envelope({ value, status: 'estimated', rule, inputs: { present: ROUTE_INPUTS, missing: [`an explored route for ${plan.missing} of ${legs} legs`] }, assumptions: [...assumptions, 'only the legs with a route are counted'] }) : ofRule({ rule, value, inputs: { present: ROUTE_INPUTS }, assumptions }))

  return { jumps: made('route.jumps', plan.jumps), km: made('route.distanceKm', plan.km) }
}

// The route's stabilised jumps and Lagrange steps as results: `steps` are the plan's steps. A jump point with no gate strength in the save is not counted as stabilised, which the result of the count says.
export const stepCounts = (steps) => {
  const jumps = steps.filter((step) => step.kind === 'jump')
  const unknown = jumps.filter((step) => !Number.isFinite(step.from.JumpGateStrength)).length
  const stabilised = jumps.filter((step) => step.from.JumpGateStrength > 0).length
  const lagrange = steps.filter((step) => step.via).length
  const make = (value) => (unknown ? envelope({ value, status: 'estimated', rule: 'route.stabilisedJumps', inputs: { present: ['the jump points\' positions'], missing: [`the gate strength of ${unknown} ${unknown === 1 ? 'jump point' : 'jump points'}`] }, assumptions: ['a jump point with no gate strength is not stabilised'] }) : ofRule({ rule: 'route.stabilisedJumps', value, inputs: { present: ['the jump points\' gate strengths'] } }))

  return { stabilised: make(stabilised), lagrange: ofRule({ rule: 'route.stabilisedJumps', value: lagrange, inputs: { present: ['the Lagrange points'] } }) }
}

// The running distance after a flight as a result: `skipped` is the number of legs before it that no explored route joins, which the total then leaves out.
export const detailTotal = (total, skipped) => (skipped ? envelope({ value: total, status: 'estimated', rule: 'route.detailTotal', inputs: { present: ROUTE_INPUTS, missing: [`an explored route for ${skipped} earlier ${skipped === 1 ? 'leg' : 'legs'}`] }, assumptions: ['only the legs with a route are counted'] }) : ofRule({ rule: 'route.detailTotal', value: total, inputs: { present: ROUTE_INPUTS } }))
