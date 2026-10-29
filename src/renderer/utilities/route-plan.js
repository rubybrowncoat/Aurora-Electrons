// A route through several stops, as Route Finder plans it: each leg is the route from one stop to the next over the explored jump points (utilities/jump-graph.js `searchRoutes`), and a cycle adds one back to the first stop.

import { flyRoute, routeLegs, routeRecords, routeResults, searchRoutes } from './jump-graph'
import { REASONS } from './orbit-propagation'
import { combine, envelope, ofRule, registerRule, unavailable, weakestStatus } from './provenance'
import { NO_ADAPTERS, POSITION_BASIS, ROUTE_MODE, jumpEndpoint, lagrangeEndpoint, placeEndpoint, positionRecord, routePositions, summarisePositions, viaEndpoints, withPositions } from './route-position'
import { NEBULA_GAP, carriedDelay, elapsedResult, routeEvents, searchTiming, timingGaps, waitResult, walkEvents } from './route-time'

// A system's own place is its centre, (0, 0); any other place is where the save has it, and a place with no position there reaches nothing (`searchRoutes`).
const positionOf = (place) => (place.kind === 'system' ? { SystemID: place.SystemID, Xcor: 0, Ycor: 0 } : { SystemID: place.SystemID, Xcor: place.Xcor, Ycor: place.Ycor })

// `stops`: places ({ key, kind, name, SystemID, Xcor, Ycor }) in order, or for a stop that can't be told `{ key, name, unavailable: true }`. `options` are `searchRoutes`'s (`order`, `canTransit`, `canEnter`, `lagrangePoints`). A leg runs from where the fleet is after the one before: a place is its own position, but a system is where its route arrives, the jump point it comes in through (a leg that starts at a system centre is only the first). A leg into or out of an unavailable stop has no route, and neither joins the stops either side of it. Returns:
// - `legs`: one per leg, { index, from, to, start, route, steps, unavailable, closing }, `index` being that of the stop it leaves, `start` the position it is flown from (null out of an unavailable stop), `route` { jumps, km, from, end } or null when no explored route joins them, and `steps` its `routeLegs`.
// - `jumps` and `km`: the totals of the legs that have a route; `missing` counts the ones that haven't, those of unavailable stops too.
// - `systems`: the SystemIDs the route passes through in order, for the map.
// - `positions`: the positions the plan's figures rest on (utilities/route-position.js `routePositions`), one summary for the whole plan and, on each leg, its own (null for a leg with no endpoints to state). A leg's endpoints are where it is flown from (the stop before it, or the jump point a system stop was reached at, or where the fleet already was when the system is the one it is in) and where it goes, with the Lagrange points it jumps between. `facts` is `loadPositionFacts`' read (null while it is not in); with none the age of a moving endpoint is unknown.
// With no `adapters` the search and the distances use the positions the save stores, so the plan is static. With `adapters` (route-position.js `ADAPTERS`), the read clock and a `speed` (km/s) the plan is flown: each leg leaves at the time the one before arrives, the places that move are where they are when the fleet reaches them (`searchRoutes`' `motion`), a stop that moves is left from the position the fleet met it at, and the legs, the totals and the positions are those of that flight. The plan then also has `static` ({ jumps, km, missing, positions }, the same plan on the saved positions) and each leg its `staticKm`, so both read side by side; an endpoint no adapter moves keeps its saved position and states why in `positions`. Nothing changes without adapters or a read clock.
export const planRoute = (stops, { cycle, jumpPoints, facts = null, adapters = NO_ADAPTERS, speed = null, timing = null, ...options }) => {
  const timed = options.order === 'time'
  const held = walkPlan(stops, { cycle, jumpPoints, facts, options, timing, flight: null })
  const flight = timed || !flightClock(held, speed) ? null : flightOf({ facts, adapters, speed })

  if (!flight) {
    return held
  }

  const moved = walkPlan(stops, { cycle, jumpPoints, facts, options, timing, flight })

  // The bodies moved on can bring a jump point nearer, so that a flight no longer runs the delay down: the plan flown then has a wait, its time is a range again, and it keeps the saved positions.
  if (!flightClock(moved, speed)) {
    return held
  }

  return { ...moved, legs: moved.legs.map((leg, index) => ({ ...leg, staticKm: held.legs[index].route ? held.legs[index].route.km : null })), static: { jumps: held.jumps, km: held.km, missing: held.missing, positions: held.positions } }
}

// Whether the elapsed time of a plan is the flight's own clock: it has none (nothing is claimed as time), or its flights are all at `speed` and no jump waits, so the arrival at a body is the one instant `km / speed` gives. A plan whose elapsed time is a range (a wait for the jump shock, a nebula cap or the cap a fleet keeps) stays on the saved positions: a body cannot be moved on to the arrival of a range, and the distances and the time would otherwise rest on different instants.
const flightClock = (plan, speed) => !plan.time || !plan.time.total || (plan.time.wait.hi === 0 && plan.time.flightHi === plan.time.flight && Math.abs(plan.time.flight * speed - plan.km) <= 1e-9 * plan.km)

const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

// What the flight of a plan needs: the adapters (at least one), the facts with the read body clock and the speed, which may be missing (the adapters then give no arrival and say 'speed-unknown'). Null when the plan is the static one.
export const flightOf = ({ facts, adapters = NO_ADAPTERS, speed = null }) => {
  const clock = facts && facts.clock

  if (!Object.values(adapters).some((adapter) => typeof adapter === 'function') || !clock || !Number.isFinite(clock.gameTime)) {
    return null
  }

  return { facts, adapters, speed: isPositive(speed) ? speed : null, gameTime: clock.gameTime }
}

const endpointCache = new WeakMap()

// The endpoint of a point a search flies to: an endpoint as it is, a Lagrange point row, a place; a jump point has none (it never moves).
const endpointOf = (point) => {
  if (point.family) {
    return point
  } else if (point.WarpPointID !== undefined) {
    return null
  }

  if (!endpointCache.has(point)) {
    endpointCache.set(point, point.kind ? placeEndpoint(point) : point.LagrangePointID !== undefined ? lagrangeEndpoint(point) : null)
  }

  return endpointCache.get(point)
}

// Where the fleet meets `point`, as `searchRoutes`' `motion` and `flyRoute` take it: { Xcor, Ycor, time, record }. A point no adapter serves is where the save has it (and has no record); one that is served is the position record of its endpoint (propagated or, with the reasons on it, static), and the time is the arrival at the flight's speed from `from`.
export const reachPoint = (flight, point, from, time) => {
  const endpoint = endpointOf(point)
  const seconds = (position) => (from && flight.speed ? Math.hypot(position.Xcor - from.Xcor, position.Ycor - from.Ycor) / flight.speed : 0)

  if (!endpoint || typeof flight.adapters[endpoint.family] !== 'function') {
    return { Xcor: point.Xcor, Ycor: point.Ycor, time: time + seconds(point), record: null }
  }

  const record = positionRecord(endpoint, { facts: flight.facts, adapters: flight.adapters, at: time, from, speed: flight.speed })

  if (record.basis === POSITION_BASIS.PROPAGATED) {
    return { Xcor: record.position.Xcor, Ycor: record.position.Ycor, time: from ? record.observedAt : time, record }
  }

  return { Xcor: point.Xcor, Ycor: point.Ycor, time: time + seconds(point), record }
}

// The `motion` of a flight started at `start` (game seconds), or null for the static plan. Without a speed a flight takes no time, and the adapters then decline each arrival.
export const motionOf = (flight, start) => (flight ? { speed: flight.speed || Infinity, start, reach: (point, from, time) => reachPoint(flight, point, from, time) } : null)

const walkPlan = (stops, { cycle, jumpPoints, facts, options, timing, flight }) => {
  const targets = stops.slice(1)

  if (cycle && stops.length > 1) {
    targets.push(stops[0])
  }

  const searches = new Map()
  // The fastest-time order searches with the fleet's timing, the delay it carries into the leg (the retry's allowance on it once, `searchTiming`) and the cap it carries; every other order searches without it, and the waits are worked out over the route it finds.
  const searchFrom = (start, time, delay, slow) => {
    const priced = options.order === 'time' ? searchTiming({ ...timing, startDelay: delay, slow }) : null
    const id = `${start.SystemID}:${start.Xcor}:${start.Ycor}@${time}#${priced ? `${priced.startDelay}~${priced.slow.map((cap) => `${cap.speed}/${cap.budget}`).join(',')}` : ''}`

    if (!searches.has(id)) {
      const searched = priced ? { ...options, timing: priced } : options

      searches.set(id, searchRoutes(jumpPoints, [start], flight ? { ...searched, motion: motionOf(flight, time) } : searched))
    }

    return searches.get(id)
  }
  const legs = []
  const systems = []
  const first = stops[0]
  const recordOf = (endpoint, at) => positionRecord(endpoint, { facts, adapters: flight.adapters, at })
  let time = flight ? flight.gameTime : 0
  let start = first && !first.unavailable ? positionOf(first) : null
  let origin = first && !first.unavailable ? placeEndpoint(first) : null
  let originRecord = flight && origin ? recordOf(origin, time) : null
  let jumps = 0
  let km = 0
  let missing = 0
  let delay = timing ? timing.startDelay : null
  let slow = []
  const timeLegs = []

  targets.forEach((to, index) => {
    const closing = Boolean(cycle) && index === targets.length - 1

    if (!start || to.unavailable) {
      legs.push({ index, from: stops[index], to, start, route: null, steps: [], unavailable: true, closing, positions: null })
      missing += 1

      if (start) {
        systems.push(start.SystemID)
      }

      start = to.unavailable ? null : positionOf(to)
      origin = to.unavailable ? null : placeEndpoint(to)
      originRecord = flight && origin ? recordOf(origin, time) : null
      delay = null
      slow = []

      return
    }

    const search = searchFrom(start, time, delay, slow)
    const route = to.kind === 'system' ? search.toSystem(to.SystemID) : search.toPlace(to)
    const steps = route ? routeLegs(route) : []
    const walk = timing && route ? walkEvents(routeEvents(steps, timing), timing.shock, { startDelay: delay, retry: timing.retry, slow }) : null

    delay = walk ? carriedDelay(walk) : null
    slow = walk ? walk.slow : []

    if (walk) {
      timeLegs.push(walk)
    }
    const flown = flight ? summarisePositions([originRecord, ...routeRecords(route)].filter(Boolean), { merge: true }) : null
    const positions = flight ? summarisePositions([...flown.records, positionRecord(placeEndpoint(to), { facts })]) : routePositions([origin, placeEndpoint(to), ...viaEndpoints(route)], { facts, adapters: NO_ADAPTERS })

    legs.push({ index, from: stops[index], to, start, route, steps, unavailable: false, closing, positions, ...(flight && route ? { seconds: flight.speed ? route.km / flight.speed : null, departs: time } : {}), ...(timing ? { time: walk } : {}) })

    if (route) {
      jumps += route.jumps
      km += route.km
      time = flight && flight.speed ? time + route.km / flight.speed : time
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

    if (to.kind === 'system' && route) {
      if (arrival) {
        start = { SystemID: to.SystemID, Xcor: arrival.Xcor, Ycor: arrival.Ycor }
        origin = jumpEndpoint(arrival)
        originRecord = flight ? positionRecord(origin, { facts }) : null
      }
    } else {
      const reached = route && route.arrival && route.arrival.record ? route.arrival : null
      const met = reached && reached.record.basis === POSITION_BASIS.PROPAGATED ? reached : null

      start = met ? { SystemID: to.SystemID, Xcor: met.Xcor, Ycor: met.Ycor } : positionOf(to)
      origin = placeEndpoint(to)
      originRecord = flight ? (reached ? reached.record : positionRecord(origin, { facts })) : null
    }
  })

  if (targets.length) {
    if (start) {
      systems.push(start.SystemID)
    }
  } else if (first && !first.unavailable) {
    systems.push(first.SystemID)
  }

  const positions = summarisePositions(legs.flatMap((leg) => (leg.positions ? leg.positions.records : [])), { merge: true })

  return { legs, jumps, km, missing, systems: systems.filter((id, index) => id !== systems[index - 1]), positions, ...(timing ? { time: timeTotals(timeLegs, timing, delay) } : {}) }
}

// The time of a whole plan from the walks of its routed legs: { flight (at the lowest case), flightHi (at the highest), handling, transit, wait, total } as `walkEvents` gives them summed (null when a leg's is), `startDelay` what the fleet carried into the plan and `remaining` ({ lo, hi, ready }) what it still carries at the end. `missing` is what the total lacks: the nebula's cap where a flight has no highest case (a nebula the armour cannot weigh caps it, or holds it after it), else `timingGaps`.
const timeTotals = (walks, timing, remaining) => {
  const summed = (read) => walks.reduce((total, walk) => (total === null || read(walk) === null ? null : total + read(walk)), 0)
  const range = (key) => (summed((walk) => (walk.total ? walk.total[key] : null)))
  const waits = (key) => summed((walk) => (walk.wait ? walk.wait[key] : null))
  const total = range('lo') === null ? null : { lo: range('lo'), hi: range('hi') }
  const flightHi = summed((walk) => walk.flightHi)

  return { flight: summed((walk) => walk.flight), flightHi, handling: summed((walk) => walk.handling), transit: summed((walk) => walk.transit), wait: waits('lo') === null ? null : { lo: waits('lo'), hi: waits('hi') }, total, startDelay: timing.startDelay, remaining, missing: flightHi === null ? [NEBULA_GAP] : timingGaps(timing) }
}

const YEAR_SECONDS = 31536000
const MAX_CYCLES = 1000

// The last flight of `steps` made to `to` (the endpoint itself, which moves), so a route walked back arrives at the place it left and not at a bare position.
const retarget = (steps, to) => {
  const last = steps.map((step) => step.kind).lastIndexOf('fly')

  return steps.map((step, index) => (index === last ? { ...step, to } : step))
}

// A record that kept the saved position where an arrival was to be worked out. The departure, validated at the game time, is where a flight sets out from and refuses nothing, and a place that never moves has no arrival to work out.
const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED && !record.departure && record.moves !== false

// A repeated trip flown cycle after cycle for `horizon` seconds (a year): `hops` is the cycle, [{ steps (a found route's `routeLegs`, or `reverseSteps` of one), from, to (endpoints or places with a position, the saved one), wait (seconds spent at `to` before the next hop), leave (optional: the endpoint the fleet leaves from after the wait, when an order exits somewhere other than where it arrived; `to` by default) }], the last hop's `to` being the first hop's `from`. The fleet leaves the first stop at the game time, and each hop is flown (`flyRoute`) from where the fleet is when it starts and at the time it starts: it arrives at the body where it will be, waits there, carried by the body, and leaves from where the body is by then, so the next hop starts from the arrival position and not from the saved one. `flightOf`'s `facts`, `adapters` and `speed` are the same as a plan's. Returns null for a static plan (no adapters, or the clock unread), else:
// - `first`: the first cycle, { km (per hop), kmTotal, seconds (the cycle's time, flights and waits), positions }.
// - `annual`: the cycles within the horizon, { status ('propagated' when a moving endpoint was moved on to its arrival and none that moves was refused, else 'static': the status follows the mode of the year's positions, so a year in which nothing moves is static), reasons (the condition codes behind a static one; none for a year in which nothing moves), compared (whether the year says anything about propagation: it flew on moved positions, or it states why the saved ones stand; false when no endpoint moves, and a figure beside it has no comparison to show), cycles, hops, meanKm (the mean flight of a hop: the propagated mean, or the static when the status is static), covered (seconds simulated), positions }. One endpoint that no adapter moves, in any hop of any cycle, makes the annual figure static and says why; the first cycle states its own.
// - `static`: { km (per hop), meanKm }, the same cycle on the saved positions.
// `annual.flights` and `static.flights` give, for each hop, the km of each flight inside it in the order of its steps (the mean over the cycles of the year for the first): a body that moved changes the flights that end at it and never a flight between two jump points.
// `timed`: the elapsed time of the cycle is a range (a wait for the jump shock, a nebula cap, `flightOnly` of utilities/route-time.js) and not the flight's own clock, so a body that moves is not moved on to an arrival: the year states the saved positions and the reason `timed-clock` (the first cycle too). The same year is flown when it is not, with the bodies where the flights reach them.
export const simulateCycles = ({ hops, facts = null, adapters = NO_ADAPTERS, speed = null, lagrangePoints = [], horizon = YEAR_SECONDS, timed = false }) => {
  const flight = flightOf({ facts, adapters, speed })

  if (!flight || !hops.length) {
    return null
  }

  const walks = hops.map((hop) => ({ ...hop, steps: retarget(hop.steps, hop.to) }))
  const heldRuns = walks.map((hop) => flyRoute(hop.steps, { from: hop.from, time: 0, lagrangePoints }))
  const held = heldRuns.map((run) => run.km)
  const staticMean = held.reduce((sum, value) => sum + value, 0) / held.length
  const records = []
  const cycles = []
  let time = flight.gameTime
  let at = { Xcor: hops[0].from.Xcor, Ycor: hops[0].from.Ycor }
  let firstSeconds = 0

  const start = endpointOf(hops[0].from)
  const departure = start && typeof adapters[start.family] === 'function' ? [positionRecord(start, { facts, adapters, at: time })] : []
  const unserved = [...new Map(walks.flatMap((hop) => [hop.from, hop.to, hop.leave]).map((point) => (point ? endpointOf(point) : null)).filter((endpoint) => endpoint && typeof adapters[endpoint.family] !== 'function').map((endpoint) => [endpoint.key, endpoint])).values()].map((endpoint) => positionRecord(endpoint, { facts }))

  for (let cycle = 0; cycle < MAX_CYCLES && (!cycle || time - flight.gameTime < horizon); cycle += 1) {
    const kms = []
    const flown = []
    const mark = records.length

    const carries = (point) => (endpointOf(point) || {}).family !== 'lagrange-point'

    walks.forEach((hop) => {
      // An order's delay is spent before its flight, where the fleet is: a body or colony carries it on, a Lagrange point does not.
      if (hop.delay > 0) {
        time += hop.delay

        const waited = carries(hop.from) && typeof adapters[(endpointOf(hop.from) || {}).family] === 'function' ? reachPoint(flight, hop.from, null, time) : null

        if (waited) {
          at = { Xcor: waited.Xcor, Ycor: waited.Ycor }

          if (waited.record) {
            records.push(waited.record)
          }
        }
      }

      const run = flyRoute(hop.steps, { from: at, time, lagrangePoints, motion: motionOf(flight, time) })

      kms.push(run.km)
      flown.push(run.flights)
      records.push(...run.records)
      time = run.end.time + (hop.wait || 0)

      // A body carries a fleet that waits at it; a Lagrange point does not, so a fleet that reached one stays where it arrived, and a point left through is where it is when the fleet arrives.
      const target = hop.leave || hop.to
      const stay = hop.wait > 0 && carries(target) ? reachPoint(flight, target, null, time) : hop.leave ? reachPoint(flight, hop.leave, null, run.end.time) : run.end

      at = { Xcor: stay.Xcor, Ycor: stay.Ycor }

      if (stay.record) {
        records.push(stay.record)
      }
    })

    cycles.push({ km: kms, flights: flown, records: records.slice(mark) })

    if (cycle === 0) {
      firstSeconds = time - flight.gameTime
    }

    // A cycle that kept a saved position makes the year static (its mean is the saved one), so the cycles after it add no figure.
    if (cycles[cycles.length - 1].records.some(refused)) {
      break
    }
  }

  const unmovedFirst = (list) => [...list.filter((record) => record.basis !== POSITION_BASIS.PROPAGATED), ...list.filter((record) => record.basis === POSITION_BASIS.PROPAGATED)]
  const everything = [...departure, ...records]
  const capped = everything.some((record) => record.moves !== false) && cycles.length >= MAX_CYCLES && time - flight.gameTime < horizon
  const clockHeld = timed && everything.some((record) => record.moves !== false)
  const unmoved = capped || clockHeld || everything.some(refused)
  const reasons = [...new Set([...(capped ? ['cycles-capped'] : []), ...(clockHeld ? ['timed-clock'] : []), ...everything.filter(refused).flatMap((record) => record.conditions).filter((code) => code === 'propagation-unavailable' || REASONS.includes(code))])].sort()
  const served = [...new Map([...walks.flatMap((hop) => [hop.from, hop.to, hop.leave]), ...heldRuns.flatMap((run) => run.points)].map((point) => (point ? endpointOf(point) : null)).filter((endpoint) => endpoint && typeof adapters[endpoint.family] === 'function').map((endpoint) => [endpoint.key, endpoint])).values()]
  const kept = served.map((endpoint) => { const base = positionRecord(endpoint, { facts }); return Object.freeze({ ...base, conditions: [...new Set([...base.conditions, ...(unmoved ? ['propagation-unavailable', ...reasons.filter((code) => code !== 'propagation-unavailable')] : [])])], unknown: true }) })
  const all = cycles.flatMap((cycle) => cycle.km)
  const flownPositions = summarisePositions(unmoved ? [...unserved, ...kept] : [...unserved, ...unmovedFirst(everything)], { merge: true })
  const status = unmoved || flownPositions.mode === ROUTE_MODE.STATIC ? 'static' : 'propagated'
  const firstKm = clockHeld ? held : cycles[0].km
  const heldFlights = heldRuns.map((run) => run.flights)
  const meanFlights = heldFlights.map((flights, hop) => flights.map((_km, flight) => cycles.reduce((total, cycle) => total + cycle.flights[hop][flight], 0) / cycles.length))

  return {
    speed: flight.speed,
    first: { km: firstKm, kmTotal: firstKm.reduce((sum, value) => sum + value, 0), seconds: firstSeconds, positions: clockHeld ? flownPositions : summarisePositions([...unserved, ...unmovedFirst([...departure, ...cycles[0].records])], { merge: true }) },
    annual: { status, reasons: unmoved ? (reasons.length ? reasons : ['propagation-unavailable']) : [], compared: status === 'propagated' || unmoved, cycles: cycles.length, hops: all.length, meanKm: status === 'static' ? staticMean : all.reduce((sum, value) => sum + value, 0) / all.length, flights: status === 'static' ? heldFlights : meanFlights, covered: time - flight.gameTime, positions: flownPositions },
    static: { km: held, flights: heldFlights, meanKm: staticMean },
  }
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
  note: 'The route\'s distance divided by one speed, in the unit that reads best. A transit takes no time, and the jump shock a fleet waits out after each and the nebula speed caps are not in this figure: the jump wait and the elapsed time count them where the fleet\'s crew is read. Acceleration and refuelling are left out, so the figure is not compared with times the game stores.',
  assumptions: ['one speed all the way', 'no nebula limits or refuelling stops'],
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
  note: 'Counts of the known systems by how an explored route from the first stop meets them: reached, avoided by an option, cut off by an option or out of reach. Which systems an option avoids is its own rule .',
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

// A distance in km as a result: the confirmed arithmetic over the route's positions, unavailable for a figure that is not a number. `positions` (a summary of utilities/route-position.js) makes it an estimate when an endpoint moves or is not known.
export const distanceResult = (km, missing = 'the route\'s distance', positions = null) => withPositions(Number.isFinite(km) ? ofRule({ rule: 'route.distanceKm', value: km, inputs: { present: ROUTE_INPUTS } }) : unavailable({ rule: 'route.distanceKm', missing: [missing] }), positions)

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

// Why a route may not enter a system with `options` { avoidDanger, avoidAlien, skipNoAutoRoute, civilian }, as { reason, assumed, option }, or null when it may. `reason` is the text; `assumed` is true when the save lacks what the test reads, so the system is avoided on an assumption; `option` is the key of the option responsible. `number(n)` writes a rating. `system`: { NoAutoRoute, DangerRating, Controller, ControlKnown, TradeTreaty, MilitaryRestrictedSystem } and what `systemProtection` reads.
export const avoidance = (system, options, number = String) => {
  if (options.skipNoAutoRoute) {
    const flag = flagOf(system.NoAutoRoute)

    if (flag === null) {
      return { reason: 'No auto-route flag not in the save', assumed: true, option: 'skipNoAutoRoute' }
    } else if (flag) {
      return { reason: 'No auto-route', assumed: false, option: 'skipNoAutoRoute' }
    }
  }

  if (options.avoidDanger) {
    if (!Number.isFinite(system.DangerRating)) {
      return { reason: 'Danger rating not in the save', assumed: true, option: 'avoidDanger' }
    } else if (system.DangerRating > 0) {
      const protection = systemProtection(system)

      if (protection === null) {
        return { reason: `Danger rating ${number(system.DangerRating)}, protection of the race's ships not known`, assumed: true, option: 'avoidDanger' }
      } else if (protection <= system.DangerRating) {
        return { reason: `Danger rating ${number(system.DangerRating)}`, assumed: false, option: 'avoidDanger' }
      }
    }
  }

  if (options.avoidAlien) {
    if (system.ControlKnown === false || system.ControlKnown === 0) {
      return { reason: 'Owner not in the save', assumed: true, option: 'avoidAlien' }
    } else if (system.Controller) {
      const treaty = flagOf(system.TradeTreaty)

      if (treaty === null) {
        return { reason: `Held by ${system.Controller}, trade treaty not in the save`, assumed: true, option: 'avoidAlien' }
      } else if (!treaty) {
        return { reason: `Held by ${system.Controller}`, assumed: false, option: 'avoidAlien' }
      }
    }
  }

  if (options.civilian) {
    const flag = flagOf(system.MilitaryRestrictedSystem)

    if (flag === null) {
      return { reason: 'Military restriction not in the save', assumed: true, option: 'civilian' }
    } else if (flag) {
      return { reason: 'Military restricted', assumed: false, option: 'civilian' }
    }
  }

  return null
}

// The jumps and distance of a whole plan as { jumps, km } results, or null for a plan with no leg. A plan none of whose legs has a route is unavailable; one with some unrouted legs gives the totals of the routed ones as an estimate that names the missing legs. `assumptions` (the options' unknown flags) go on every result. The distance rests on the plan's positions (`plan.positions`), the jumps do not.
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

  return { jumps: made('route.jumps', plan.jumps), km: withPositions(made('route.distanceKm', plan.km), plan.positions), ...(plan.time ? { time: timeResults(plan) } : {}) }
}

// A flight time that a wait for the jump shock was meant to join but could not (the crew is not known): the figure stays, as an estimate that names what it lacks and says the waits are not counted. An unavailable result stays so.
export const withoutWaits = (result, missing) => (!result || result.status === 'unavailable' ? result : envelope({ value: result.value, status: weakestStatus([result.status, 'estimated']), rule: result.rule.id, inputs: { present: result.inputs.present, missing: [...result.inputs.missing, ...missing] }, units: result.units, assumptions: [...result.assumptions, 'the waits for the jump shock are not counted'] }))

// The waits and the elapsed time of a timed plan as results, each on the plan's positions (the timed order is on the saved ones): { wait (the longest, seconds), elapsed (days at the upper case) }. A plan with a leg that has no route counts only the legs that have one, as an estimate that says so.
const timeResults = (plan) => {
  const { time } = plan
  const partial = (result) => (plan.missing && result.status !== 'unavailable' ? envelope({ value: result.value, status: 'estimated', rule: result.rule.id, inputs: { present: result.inputs.present, missing: [`an explored route for ${plan.missing} of ${plan.legs.length} legs`] }, units: result.units, assumptions: [...result.assumptions, 'only the legs with a route are counted'] }) : result)
  const made = (result) => withPositions(partial(result), plan.positions)

  return { wait: made(waitResult(time.wait, time.missing)), elapsed: made(elapsedResult(time.total, time.missing)) }
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

// The running distance after a flight as a result: `skipped` is the number of legs before it that no explored route joins, which the total then leaves out. `positions` are those of the legs flown so far.
export const detailTotal = (total, skipped, positions = null) => withPositions(skipped ? envelope({ value: total, status: 'estimated', rule: 'route.detailTotal', inputs: { present: ROUTE_INPUTS, missing: [`an explored route for ${skipped} earlier ${skipped === 1 ? 'leg' : 'legs'}`] }, assumptions: ['only the legs with a route are counted'] }) : ofRule({ rule: 'route.detailTotal', value: total, inputs: { present: ROUTE_INPUTS } }), positions)
