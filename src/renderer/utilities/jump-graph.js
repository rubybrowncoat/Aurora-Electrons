// Routes over the jump points a race has explored, as its fleets fly them: a straight line inside a system, no distance through a jump point. The game's auto-route takes the fewest transits and breaks ties by whichever path it meets first; here ties go to the shorter distance. The galactic map's distance is the shortest in kilometres, centre to centre.

import { ofRule, registerRule, unavailable } from './provenance'

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

// The jump points the race has charted in systems it knows, with its own flags on them. Only explored ones (`Explored`) can be travelled: the far side of the rest is unknown. `Distance` is how far the point sits from its star, which numbers the system's jump points (JP1, JP2, …) as the game lists them. `JumpGateStrength` > 0 is a gate, which ships without a jump drive need to transit from that side; `MilitaryRestricted` keeps civilian shipping out; `IgnoreForDistance` leaves it out of distance measures. The rows are frozen: they are read-only, and Vue would otherwise observe every field of thousands of them.
export const loadJumpPoints = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.SystemID, FCT_JumpPoint.WPLink, FCT_JumpPoint.Distance, FCT_JumpPoint.Xcor, FCT_JumpPoint.Ycor, FCT_JumpPoint.JumpGateStrength, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.MilitaryRestricted, FCT_RaceJumpPointSurvey.IgnoreForDistance
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.GameID = FCT_JumpPoint.GameID and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_JumpPoint.GameID
where FCT_JumpPoint.GameID = ${GameID}`)

  return Object.freeze(rows)
}

// One { SystemID, DestinationID } per charted jump point whose far side is charted too, for SystemMap.
export const jumpLinks = (jumpPoints) => {
  const byId = Object.fromEntries(jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))

  return jumpPoints.filter((jumpPoint) => byId[jumpPoint.WPLink]).map((jumpPoint) => ({ SystemID: jumpPoint.SystemID, DestinationID: byId[jumpPoint.WPLink].SystemID }))
}

const BEFORE = {
  jumps: (a, b) => a.jumps - b.jumps || a.km - b.km,
  km: (a, b) => a.km - b.km || a.jumps - b.jumps,
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
// - `order`: 'jumps' (fewest transits, then distance) or 'km' (shortest distance, then transits).
// - `canTransit(jumpPoint)`: whether the route may jump out through it (a gate for ships without a jump drive).
// - `canEnter(SystemID)`: whether the route may jump into the system; the game's avoid rules apply to the destination too. The origins' own systems are always left freely.
// - `lagrangePoints`: [{ SystemID, Xcor, Ycor }] to jump between inside a system, or none.
// - `motion`: { speed, start, reach } to fly the places that move at the time the fleet leaves the previous point (`start` is the game time the route starts at, the time at a state is `start` plus its km over `speed`, a jump taking none; `reach` is `flightInSystem`'s): the flights inside the system of each leg, the Lagrange points and the destination, are then the positions at those times. Without it every place is where the save stores it.
// Returns `toSystem(SystemID)` (arrival at the system's jump point) and `toPlace({ SystemID, Xcor, Ycor })`, each giving { jumps, km, from, end } or null when nothing reaches it. `from` is the origin the route starts at, and `routeLegs(route)` spells out `end`; with `motion` the route also has `arrival` (where the fleet meets the destination place, { Xcor, Ycor, time, record }) and `routeRecords(route)` gives the records its figures rest on.
export const searchRoutes = (jumpPoints, allOrigins, { order = 'jumps', canTransit = () => true, canEnter = () => true, lagrangePoints = [], motion = null } = {}) => {
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

  // A state is the route standing at a jump point: arrived through it (`jump`), or flown to it (`fly`) from the previous state's jump point, or from the origin when there is none.
  const reached = {}
  const pending = queue(before)
  const timeAt = (km) => (motion ? motion.start + km / motion.speed : 0)
  const fly = (previous, origin, from, to, jumps, km) => {
    const leg = flightInSystem(from, to, lagrangeBySystem[to.SystemID], motion, timeAt(km))

    return { kind: 'fly', at: to, previous, origin, jumps, km: km + leg.km, legKm: leg.km, via: leg.via, ...(motion ? { records: leg.records, arrival: leg.end } : {}) }
  }

  origins.forEach((origin) => (bySystem[origin.SystemID] || []).forEach((jumpPoint) => pending.push(fly(null, origin, origin, jumpPoint, 0, 0))))

  while (pending.size) {
    const state = pending.pop()

    if (reached[state.at.WarpPointID]) {
      continue
    }

    reached[state.at.WarpPointID] = state

    if (state.kind === 'fly') {
      const partner = byId[state.at.WPLink]

      if (state.at.Explored && partner && !reached[partner.WarpPointID] && canTransit(state.at) && canEnter(partner.SystemID)) {
        pending.push({ kind: 'jump', at: partner, previous: state, origin: state.origin, jumps: state.jumps + 1, km: state.km })
      }
    } else {
      // On across the system: one leg per system, as the game queues a route.
      bySystem[state.at.SystemID].forEach((other) => {
        if (other !== state.at && !reached[other.WarpPointID]) {
          pending.push(fly(state, state.origin, state.at, other, state.jumps, state.km))
        }
      })
    }
  }

  const arrivals = (systemId) => (bySystem[systemId] || []).map((jumpPoint) => reached[jumpPoint.WarpPointID]).filter((state) => state && state.kind === 'jump')
  const nearest = (states) => states.reduce((best, state) => (!best || before(state, best) < 0 ? state : best), null)
  const route = (end) => end && { jumps: end.jumps, km: end.km, from: end.origin, end, ...(motion ? { arrival: end.arrival || null } : {}) }

  return {
    toSystem(systemId) {
      const origin = origins.find((candidate) => candidate.SystemID === systemId)

      return origin ? { jumps: 0, km: 0, from: origin, end: null } : route(nearest(arrivals(systemId)))
    },
    toPlace(place) {
      if (!hasPosition(place)) {
        return null
      }

      const lagrange = lagrangeBySystem[place.SystemID]
      const local = origins.filter((origin) => origin.SystemID === place.SystemID).map((origin) => ({ origin, previous: null, from: origin, jumps: 0, km: 0 }))
      const ends = [...local, ...arrivals(place.SystemID).map((state) => ({ origin: state.origin, previous: state, from: state.at, jumps: state.jumps, km: state.km }))].map(({ origin, previous, from, jumps, km }) => {
        const leg = flightInSystem(from, place, lagrange, motion, timeAt(km))

        return { kind: 'fly', at: place, previous, origin, jumps, km: km + leg.km, legKm: leg.km, via: leg.via, ...(motion ? { records: leg.records, arrival: leg.end } : {}) }
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
