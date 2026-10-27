// Routes over the jump points a race has explored, as its fleets fly them: a straight line inside a system, no distance through a jump point. The game's auto-route takes the fewest transits and breaks ties by whichever path it meets first; here ties go to the shorter distance. The galactic map's distance is the shortest in kilometres, centre to centre.

import { ofRule, registerRule, unavailable } from './provenance'
import { aged, carriedFlight, flyEvent, leaving } from './route-time'

export const KM_PER_AU = 149600000

const hasPosition = (point) => Number.isFinite(point.Xcor) && Number.isFinite(point.Ycor)

const hypot = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)

// The rules of a route over the explored jump points, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js). The plan-level ones (totals, travel time, speed, avoid options) are in utilities/route-plan.js.
const ROUTE_VERSIONS = ['2.7.x']

registerRule({
  id: 'route.jumps',
  versions: ROUTE_VERSIONS,
  units: 'jumps',
  verification: 'confirmed',
  structure: ['FCT_JumpPoint.WPLink', 'FCT_RaceJumpPointSurvey.Explored', 'FCT_RaceJumpPointSurvey.Charted'],
  note: 'The fewest transits over the jump points the race has explored, the shorter way breaking a tie; the search was checked against the game\'s own routes (docs `fleet`). A link the race has not explored, or one with no position in the save, is never crossed, so a system only such links reach has no route.',
})

registerRule({
  id: 'route.distanceKm',
  versions: ROUTE_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_JumpPoint.Xcor, Ycor', 'FCT_LagrangePoint.Xcor, Ycor', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'The straight-line distances flown inside each system between the places the route passes, summed; a jump takes no distance and a system\'s centre is where the galactic map measures from. Arithmetic over saved positions: a place with no position in the save has no distance.',
})

const ROUTE_INPUTS = ['the explored jump points', 'their positions']

// The jumps and kilometres of a found route, or unavailable results naming `missing` for a route nothing explored reaches: `route` is a `searchRoutes` route or null. A route never has 0 for a missing one.
export const routeResults = (route, missing = 'an explored route') => {
  if (!route) {
    return { jumps: unavailable({ rule: 'route.jumps', missing: [missing] }), km: unavailable({ rule: 'route.distanceKm', missing: [missing] }) }
  }

  return { jumps: ofRule({ rule: 'route.jumps', value: route.jumps, inputs: { present: ROUTE_INPUTS } }), km: ofRule({ rule: 'route.distanceKm', value: route.km, inputs: { present: ROUTE_INPUTS } }) }
}

// The race knows the link of a charted jump point (`WPLink`, and with it the system beyond) when it has explored the point or the point at the far end. A charted point it has explored neither way keeps its identity and position and has no link: the game shows the far side of it as unexplored. A query that uses it joins the race's survey of the point as `FCT_RaceJumpPointSurvey` and its survey of the point at the far end, charted, as `VIR_FarSurvey`.
export const LINK_KNOWN_SQL = '(FCT_RaceJumpPointSurvey.Explored = 1 or VIR_FarSurvey.Explored = 1)'

// The jump points the race has charted in systems it knows, with its own flags on them. Only explored ones (`Explored`) can be travelled: the far side of the rest is unknown, so `WPLink` is null unless the point or the one at the far end is explored. `Distance` is how far the point sits from its star, which numbers the system's jump points (JP1, JP2, …) as the game lists them. `JumpGateStrength` > 0 is a gate, which ships without a jump drive need to transit from that side; `MilitaryRestricted` keeps civilian shipping out; `IgnoreForDistance` leaves it out of distance measures. The rows are frozen: they are read-only, and Vue would otherwise observe every field of thousands of them.
export const loadJumpPoints = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.SystemID, case when ${LINK_KNOWN_SQL} then FCT_JumpPoint.WPLink else null end as WPLink, FCT_JumpPoint.Distance, FCT_JumpPoint.Xcor, FCT_JumpPoint.Ycor, FCT_JumpPoint.JumpGateStrength, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.MilitaryRestricted, FCT_RaceJumpPointSurvey.IgnoreForDistance
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.GameID = FCT_JumpPoint.GameID and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_JumpPoint.GameID
left join FCT_RaceJumpPointSurvey as VIR_FarSurvey on VIR_FarSurvey.WarpPointID = FCT_JumpPoint.WPLink and VIR_FarSurvey.RaceID = ${RaceID} and VIR_FarSurvey.GameID = FCT_JumpPoint.GameID and VIR_FarSurvey.Charted = 1
where FCT_JumpPoint.GameID = ${GameID}`)

  return Object.freeze(rows)
}

// One { SystemID, DestinationID } per jump point of `jumpPoints` (`loadJumpPoints` rows) whose far point is charted too and that the race has explored from either end, for SystemMap. A charted point it has explored neither way has no link.
export const jumpLinks = (jumpPoints) => {
  const byId = Object.fromEntries(jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))

  return jumpPoints.filter((jumpPoint) => byId[jumpPoint.WPLink] && (jumpPoint.Explored || byId[jumpPoint.WPLink].Explored)).map((jumpPoint) => ({ SystemID: jumpPoint.SystemID, DestinationID: byId[jumpPoint.WPLink].SystemID }))
}

// One { SystemID, DestinationID } per jump point the race has charted and explored from either end whose far point it has charted in a system it knows, read straight from the save for a page that needs only the links. The same pairs as `jumpLinks` over `loadJumpPoints`, without the flags a route reads. The rows are frozen.
export const loadJumpLinks = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_JumpPoint.SystemID, VIR_Destination.SystemID as DestinationID
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_JumpPoint as VIR_Destination on VIR_Destination.WarpPointID = FCT_JumpPoint.WPLink
inner join FCT_RaceJumpPointSurvey as VIR_FarSurvey on VIR_FarSurvey.WarpPointID = VIR_Destination.WarpPointID and VIR_FarSurvey.RaceID = ${RaceID} and VIR_FarSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}
inner join FCT_RaceSysSurvey as VIR_FarSystem on VIR_FarSystem.SystemID = VIR_Destination.SystemID and VIR_FarSystem.RaceID = ${RaceID} and VIR_FarSystem.GameID = ${GameID}
where FCT_JumpPoint.GameID = ${GameID} and ${LINK_KNOWN_SQL}`)

  return Object.freeze(rows)
}

const BEFORE = {
  jumps: (a, b) => a.jumps - b.jumps || a.km - b.km,
  km: (a, b) => a.km - b.km || a.jumps - b.jumps,
  // Seconds that are not known are Infinity, which never ranks before a known time; two of them tie and fall to the distance.
  time: (a, b) => (a.seconds === b.seconds ? 0 : a.seconds < b.seconds ? -1 : 1) || a.jumps - b.jumps || a.km - b.km,
}

// A binary heap of states, the one `before` puts first on top.
const queue = (before) => {
  const items = []
  const swap = (i, j) => ([items[i], items[j]] = [items[j], items[i]])

  return {
    get size() {
      return items.length
    },
    push(item) {
      items.push(item)

      for (let i = items.length - 1; i > 0 && before(items[i], items[(i - 1) >> 1]) < 0; i = (i - 1) >> 1) {
        swap(i, (i - 1) >> 1)
      }
    },
    pop() {
      const top = items[0]
      const last = items.pop()

      if (items.length) {
        items[0] = last

        for (let i = 0; ;) {
          const left = 2 * i + 1
          const right = left + 1
          let first = i

          if (left < items.length && before(items[left], items[first]) < 0) {
            first = left
          }

          if (right < items.length && before(items[right], items[first]) < 0) {
            first = right
          }

          if (first === i) {
            break
          }

          swap(i, first)
          i = first
        }
      }

      return top
    },
  }
}

// The way from `a` to `b` inside one system. With two or more Lagrange points there, a fleet that uses them flies to one, jumps to another at no distance and goes on from there, when that beats the straight line. `via` is that [entry, exit] pair, or null.
const inSystem = (a, b, lagrangePoints = []) => {
  let best = { km: hypot(a, b), via: null }

  lagrangePoints.forEach((entry) => {
    lagrangePoints.forEach((exit) => {
      const km = hypot(a, entry) + hypot(exit, b)

      if (entry !== exit && km < best.km) {
        best = { km, via: [entry, exit] }
      }
    })
  })

  return best
}

// The way from `a` to `b` inside one system for a fleet that leaves `a` at `time` (game seconds), when the places move: `motion` is { speed (km/s), reach(point, from, time) }. `reach` gives where the fleet meets `point` as { Xcor, Ycor, time, record }: flown to from `from` ({ Xcor, Ycor }) at `time`, or, with no `from`, where `point` is at `time`; `time` of the result is the arrival, and `record` is the position record the figure rests on (null for a place that does not move). The straight flight and every entry Lagrange point are each flown at `time`; a point's exit is where it is when the fleet arrives at its entry (the jump takes no time), and the last leg is flown from there at that time, so the way depends on the time, and on the direction since the entry and exit swap. Gives { km, via, end (where the fleet meets `b`), records } with `via` the chosen [entry, exit] points, or null.
export const flightInSystem = (a, b, lagrangePoints = [], motion = null, time = 0) => {
  if (!motion) {
    return inSystem(a, b, lagrangePoints)
  }

  const direct = motion.reach(b, a, time)
  const records = (...reached) => reached.map((item) => item.record).filter(Boolean)
  let best = { km: hypot(a, direct), via: null, end: direct, records: records(direct) }

  lagrangePoints.forEach((entry) => {
    const entered = motion.reach(entry, a, time)

    lagrangePoints.forEach((exit) => {
      if (entry === exit) {
        return
      }

      const left = motion.reach(exit, null, entered.time)
      const arrived = motion.reach(b, left, entered.time)
      const km = hypot(a, entered) + hypot(left, arrived)

      if (km < best.km) {
        best = { km, via: [entry, exit], end: arrived, records: records(entered, left, arrived) }
      }
    })
  })

  return best
}

// Single-source shortest routes from the nearest of `origins` ([{ SystemID, Xcor, Ycor }], a system's centre is 0, 0) over `jumpPoints` (loadJumpPoints rows). Options:
// - `order`: 'jumps' (fewest transits, then distance), 'km' (shortest distance, then transits) or 'time' (the least elapsed time, then transits, then distance; it needs `timing`).
// - `timing`: { speed, speedIn, holdsSpeed, shock, startDelay, slow } (`searchTiming` of utilities/route-time.js): the fleet's speed (`speedIn(SystemID)` where a system caps it), whether it holds a speed of its own, the upper case of the jump shock in seconds, the delay it starts with and the caps it starts with (`aged` of utilities/route-time.js, none when absent). Each flight is priced as `walkEvents` prices it at the upper case (`carriedFlight` and `leaving`: a fleet set to its maximum speed flies at the lowest cap of the systems it was in during the last longest subpulse, and a nebula whose cap the armour cannot weigh, crossed even at no distance, leaves a cap of no known speed that gives every flight under it no known time), a flight after a transit takes the longer of its own time and the shock still running, the first one the longer of its time and the start delay, and the wait runs the caps down; a transit takes none. A flight, shock or start delay that is not known prices the route at Infinity seconds. Every route found with it has `seconds`; the clock of `motion` stays distance over speed.
// - `canTransit(jumpPoint)`: whether the route may jump out through it (a gate for ships without a jump drive).
// - `canEnter(SystemID)`: whether the route may jump into the system; the game's avoid rules apply to the destination too. The origins' own systems are always left freely.
// - `lagrangePoints`: [{ SystemID, Xcor, Ycor }] to jump between inside a system, or none.
// - `motion`: { speed, start, reach } to fly the places that move at the time the fleet leaves the previous point (`start` is the game time the route starts at, the time at a state is `start` plus its km over `speed`, a jump taking none; `reach` is `flightInSystem`'s): the flights inside the system of each leg, the Lagrange points and the destination, are then the positions at those times. Without it every place is where the save stores it.
// Returns `toSystem(SystemID)` (arrival at the system's jump point) and `toPlace({ SystemID, Xcor, Ycor })`, each giving { jumps, km, from, end } or null when nothing reaches it. `from` is the origin the route starts at, and `routeLegs(route)` spells out `end`; with `motion` the route also has `arrival` (where the fleet meets the destination place, { Xcor, Ycor, time, record }) and `routeRecords(route)` gives the records its figures rest on.
export const searchRoutes = (jumpPoints, allOrigins, { order = 'jumps', canTransit = () => true, canEnter = () => true, lagrangePoints = [], motion = null, timing = null } = {}) => {
  if (order === 'time' && !timing) {
    throw new Error('The time order needs the fleet\'s timing')
  }

  const before = BEFORE[order]
  const origins = allOrigins.filter(hasPosition)
  const byId = {}
  const bySystem = {}
  const lagrangeBySystem = {}

  jumpPoints.filter(hasPosition).forEach((jumpPoint) => {
    byId[jumpPoint.WarpPointID] = jumpPoint
    ;(bySystem[jumpPoint.SystemID] = bySystem[jumpPoint.SystemID] || []).push(jumpPoint)
  })
  lagrangePoints.filter(hasPosition).forEach((point) => {
    ;(lagrangeBySystem[point.SystemID] = lagrangeBySystem[point.SystemID] || []).push(point)
  })

  // A state is the route standing at a jump point: arrived through it (`jump`), or flown to it (`fly`) from the previous state's jump point, or from the origin when there is none. A jump point keeps the states no other one there covers (`covered`). In every other order the first state at a jump point is its only one. In the time order the queue gives the states no earlier than the ones kept, and a kept state covers a later one when every cap it still holds once the later one stands there is matched by a cap of the later one that is no faster and holds no shorter (`covers`; a state with no cap covers every later one, and a cap of no known speed, 0, is matched only by another one). The highest case flies at a speed that only the caps of the last longest subpulse lower, so the kept state is never the slower of the two at the same instant wherever they go, its delay runs from an earlier transit, and it reaches every place no later: the rule drops no faster route, whatever the delay. A state's caps run out within one longest subpulse, so the states a jump point keeps are less than that apart; where nothing caps the fleet the first one is the only one.
  const reached = {}
  const pending = queue(before)
  const timeAt = (km) => (motion ? motion.start + km / motion.speed : 0)
  const firstOnly = order !== 'time'
  const startCaps = (timing && timing.slow) || []
  const covers = (a, b) => a.slow.every((cap) => a.seconds + cap.budget <= b.seconds || b.slow.some((other) => other.speed <= cap.speed && b.seconds + other.budget >= a.seconds + cap.budget))
  const covered = (state) => (reached[state.at.WarpPointID] || []).some((kept) => firstOnly || covers(kept, state))
  // The upper case of a flight of `km` in a system from the cap state `slow`: { seconds (Infinity when no speed is known), slow, cap (the system's, `flyEvent`'s `capSpeed`) }.
  const flown = (km, systemId, slow) => {
    const event = flyEvent(km, systemId, timing)
    const leg = carriedFlight(event, slow)

    return leg.seconds === null ? { seconds: Infinity, slow: [], cap: null } : { ...leg, cap: event.capSpeed }
  }
  // When the fleet can transit from a jump point after flying to it, and the caps it then holds: the flight, then what is left of the delay (the shock after the transit before, or the start delay), which runs the caps down, and the cap of the system it leaves (`leaving`).
  const readyAt = (previous, km, systemId) => {
    const delay = previous ? timing.shock : timing.startDelay
    const flight = flown(km, systemId, previous ? previous.slow : startCaps)

    if (delay === null || flight.seconds === Infinity) {
      return { seconds: Infinity, slow: [] }
    }

    const waited = Math.max(0, delay - flight.seconds)

    return { seconds: (previous ? previous.seconds : 0) + flight.seconds + waited, slow: leaving(aged(flight.slow, waited), flight.cap) }
  }
  const fly = (previous, origin, from, to, jumps, km) => {
    const leg = flightInSystem(from, to, lagrangeBySystem[to.SystemID], motion, timeAt(km))

    return { kind: 'fly', at: to, previous, origin, jumps, km: km + leg.km, legKm: leg.km, via: leg.via, ...(timing ? readyAt(previous, leg.km, to.SystemID) : {}), ...(motion ? { records: leg.records, arrival: leg.end } : {}) }
  }

  origins.forEach((origin) => (bySystem[origin.SystemID] || []).forEach((jumpPoint) => pending.push(fly(null, origin, origin, jumpPoint, 0, 0))))

  while (pending.size) {
    const state = pending.pop()

    if (covered(state)) {
      continue
    }

    ;(reached[state.at.WarpPointID] = reached[state.at.WarpPointID] || []).push(state)

    if (state.kind === 'fly') {
      const partner = byId[state.at.WPLink]

      if (state.at.Explored && partner && canTransit(state.at) && canEnter(partner.SystemID)) {
        const next = { kind: 'jump', at: partner, previous: state, origin: state.origin, jumps: state.jumps + 1, km: state.km, ...(timing ? { seconds: state.seconds, slow: state.slow } : {}) }

        if (!covered(next)) {
          pending.push(next)
        }
      }
    } else {
      // On across the system: one leg per system, as the game queues a route.
      bySystem[state.at.SystemID].forEach((other) => {
        if (other !== state.at && !(reached[other.WarpPointID] || []).some((kept) => firstOnly || kept.slow.length === 0)) {
          const next = fly(state, state.origin, state.at, other, state.jumps, state.km)

          if (!covered(next)) {
            pending.push(next)
          }
        }
      })
    }
  }

  const arrivals = (systemId) => (bySystem[systemId] || []).flatMap((jumpPoint) => reached[jumpPoint.WarpPointID] || []).filter((state) => state.kind === 'jump')
  const nearest = (states) => states.reduce((best, state) => (!best || before(state, best) < 0 ? state : best), null)
  const route = (end) => end && { jumps: end.jumps, km: end.km, from: end.origin, end, ...(timing ? { seconds: end.seconds } : {}), ...(motion ? { arrival: end.arrival || null } : {}) }

  return {
    toSystem(systemId) {
      const origin = origins.find((candidate) => candidate.SystemID === systemId)

      return origin ? { jumps: 0, km: 0, from: origin, end: null, ...(timing ? { seconds: 0 } : {}) } : route(nearest(arrivals(systemId)))
    },
    toPlace(place) {
      if (!hasPosition(place)) {
        return null
      }

      const lagrange = lagrangeBySystem[place.SystemID]
      const local = origins.filter((origin) => origin.SystemID === place.SystemID).map((origin) => ({ origin, previous: null, from: origin, jumps: 0, km: 0, seconds: 0, slow: startCaps }))
      const ends = [...local, ...arrivals(place.SystemID).map((state) => ({ origin: state.origin, previous: state, from: state.at, jumps: state.jumps, km: state.km, seconds: state.seconds, slow: state.slow }))].map(({ origin, previous, from, jumps, km, seconds, slow }) => {
        const leg = flightInSystem(from, place, lagrange, motion, timeAt(km))

        return { kind: 'fly', at: place, previous, origin, jumps, km: km + leg.km, legKm: leg.km, via: leg.via, ...(timing ? { seconds: seconds + flown(leg.km, place.SystemID, slow).seconds } : {}), ...(motion ? { records: leg.records, arrival: leg.end } : {}) }
      })

      return route(nearest(ends))
    },
  }
}

// The legs of a route, in order: { kind: 'fly', SystemID, from, to, km, via } inside a system (`from` is the origin or the jump point the route arrived through, `to` a jump point or the destination, `via` the Lagrange points it jumps between), and { kind: 'jump', from, to } through a jump point. A route found with `motion` also has `records` on each flight, the position records its distance rests on.
export const routeLegs = (route) => {
  const legs = []

  for (let state = route.end; state; state = state.previous) {
    if (state.kind === 'jump') {
      legs.unshift({ kind: 'jump', from: state.previous.at, to: state.at })
    } else {
      legs.unshift({ kind: 'fly', SystemID: state.at.SystemID, from: state.previous ? state.previous.at : state.origin, to: state.at, km: state.legKm, via: state.via, ...(state.records ? { records: state.records } : {}) })
    }
  }

  return legs
}

// The legs of a route walked the other way: the last leg first, each flight from where it ended to where it began. The Lagrange points a flight jumps between are not carried over, since the way back picks them afresh.
export const reverseSteps = (steps) => [...steps].reverse().map((step) => (step.kind === 'jump' ? { kind: 'jump', from: step.to, to: step.from } : { kind: 'fly', SystemID: step.SystemID, from: step.to, to: step.from, km: step.km, via: null, records: [] }))

// A route's `steps` (`routeLegs`) flown again by a fleet that is at `from` ({ Xcor, Ycor }) at `time`: each flight inside a system by `flightInSystem` (Lagrange points of `lagrangePoints` by system, `motion` as `searchRoutes` takes it) from where the fleet is, a jump moving it to the far point at no time. Gives { km, seconds, end (where the fleet is at the end, { Xcor, Ycor, time }), records, flights }, `flights` being the km of each flight; the same steps flown at another time are another distance when a place on them moves.
export const flyRoute = (steps, { from, time, lagrangePoints = [], motion = null }) => {
  const bySystem = {}

  lagrangePoints.filter(hasPosition).forEach((point) => {
    ;(bySystem[point.SystemID] = bySystem[point.SystemID] || []).push(point)
  })

  let here = { Xcor: from.Xcor, Ycor: from.Ycor, time }
  let km = 0
  const records = []
  const flights = []
  const points = []

  steps.forEach((step) => {
    if (step.kind === 'jump') {
      here = { Xcor: step.to.Xcor, Ycor: step.to.Ycor, time: here.time }

      return
    }

    const leg = flightInSystem(here, step.to, bySystem[step.SystemID], motion, here.time)
    const end = leg.end || { Xcor: step.to.Xcor, Ycor: step.to.Ycor }

    km += leg.km
    flights.push(leg.km)
    points.push(...(leg.via || []))
    records.push(...(leg.records || []))
    here = { Xcor: end.Xcor, Ycor: end.Ycor, time: motion ? here.time + leg.km / motion.speed : here.time }
  })

  return { km, seconds: motion ? here.time - time : 0, end: here, records, flights, points }
}

// A route's steps as a string that names the path they take: the jump points it passes and the places and Lagrange points it flies to, so two routes of the same distance and jumps that go by other points differ. A cache of what is flown over a route keys on it.
export const pathKey = (steps) => JSON.stringify(steps.map((step) => (step.kind === 'jump' ? ['jump', step.from.WarpPointID, step.to.WarpPointID] : ['fly', step.SystemID, step.to.WarpPointID || step.to.key || null, step.via ? step.via.map((point) => point.LagrangePointID) : null])))

// The position records a route found with `motion` rests on, once each in the order of its flights.
export const routeRecords = (route) => (route ? routeLegs(route).flatMap((leg) => leg.records || []) : [])

// Travel distance from the nearest of `origins` (the capital, or every sizeable colony) to a body: `distanceTo({ SystemID, Xcor, Ycor })` gives { km, jumps, from } on the shortest route in kilometres, or null when no explored route from any origin reaches it. Jump points the race marked to ignore for distance are left out.
export const buildDistanceMap = (jumpPoints, origins) => {
  const routes = searchRoutes(jumpPoints.filter((jumpPoint) => !jumpPoint.IgnoreForDistance), origins, { order: 'km' })

  return (body) => {
    const found = routes.toPlace(body)

    return found && { km: found.km, jumps: found.jumps, from: found.from }
  }
}
