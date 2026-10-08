// Routes over the jump points a race has explored, as its fleets fly them: a straight line inside a system, no
// distance through a jump point. The game's auto-route (Fleet.FindNearestAutoRouteDestination) takes the fewest
// transits and breaks ties by whichever path it meets first; here ties go to the shorter distance. The galactic
// map's distance (Game.PopulateMapDistancesFromSelectedSystem) is the shortest in kilometres, centre to centre.

export const KM_PER_AU = 149600000

const hypot = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)

// The jump points the race has charted in systems it knows, with its own flags on them. Only explored ones
// (`Explored`) can be travelled: the far side of the rest is unknown. `JumpGateStrength` > 0 is a gate, which
// ships without a jump drive need to transit from that side; `MilitaryRestricted` keeps civilian shipping out.
export const loadJumpPoints = (database, { GameID, RaceID }) => database.query(`select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.SystemID, FCT_JumpPoint.WPLink, FCT_JumpPoint.Xcor, FCT_JumpPoint.Ycor, FCT_JumpPoint.JumpGateStrength, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.MilitaryRestricted
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_JumpPoint.GameID
where FCT_JumpPoint.GameID = ${GameID}`).then(([rows]) => rows)

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

// The way from `a` to `b` inside one system. With two or more Lagrange points there, a fleet that uses them flies
// to one, jumps to another at no distance and goes on from there, when that beats the straight line
// (Fleet.QueueMoveOrder with AutoIncludeLagrangePoints). `via` is that [entry, exit] pair, or null.
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

// Single-source shortest routes from the nearest of `origins` ([{ SystemID, Xcor, Ycor }], a system's centre is
// 0, 0) over `jumpPoints` (loadJumpPoints rows). Options:
// - `order`: 'jumps' (fewest transits, then distance) or 'km' (shortest distance, then transits).
// - `canTransit(jumpPoint)`: whether the route may jump out through it (a gate for ships without a jump drive).
// - `canEnter(SystemID)`: whether the route may jump into the system; the game's avoid rules apply to the
//   destination too. The origins' own systems are always left freely.
// - `lagrangePoints`: [{ SystemID, Xcor, Ycor }] to jump between inside a system, or none.
// Returns `toSystem(SystemID)` (arrival at the system's jump point) and `toPlace({ SystemID, Xcor, Ycor })`, each
// giving { jumps, km, from, end } or null when nothing reaches it. `from` is the origin the route starts at, and
// `routeLegs(route)` spells out `end`.
export const searchRoutes = (jumpPoints, origins, { order = 'jumps', canTransit = () => true, canEnter = () => true, lagrangePoints = [] } = {}) => {
  const before = BEFORE[order]
  const byId = {}
  const bySystem = {}
  const lagrangeBySystem = {}

  jumpPoints.forEach((jumpPoint) => {
    byId[jumpPoint.WarpPointID] = jumpPoint
    ;(bySystem[jumpPoint.SystemID] = bySystem[jumpPoint.SystemID] || []).push(jumpPoint)
  })
  lagrangePoints.forEach((point) => {
    ;(lagrangeBySystem[point.SystemID] = lagrangeBySystem[point.SystemID] || []).push(point)
  })

  // A state is the route standing at a jump point: arrived through it (`jump`), or flown to it (`fly`) from the
  // previous state's jump point, or from the origin when there is none.
  const reached = {}
  const pending = queue(before)
  const fly = (previous, origin, from, to, jumps, km) => {
    const leg = inSystem(from, to, lagrangeBySystem[to.SystemID])

    return { kind: 'fly', at: to, previous, origin, jumps, km: km + leg.km, legKm: leg.km, via: leg.via }
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
  const route = (end) => end && { jumps: end.jumps, km: end.km, from: end.origin, end }

  return {
    toSystem(systemId) {
      const origin = origins.find((candidate) => candidate.SystemID === systemId)

      return origin ? { jumps: 0, km: 0, from: origin, end: null } : route(nearest(arrivals(systemId)))
    },
    toPlace(place) {
      const lagrange = lagrangeBySystem[place.SystemID]
      const local = origins.filter((origin) => origin.SystemID === place.SystemID).map((origin) => ({ origin, previous: null, from: origin, jumps: 0, km: 0 }))
      const ends = [...local, ...arrivals(place.SystemID).map((state) => ({ origin: state.origin, previous: state, from: state.at, jumps: state.jumps, km: state.km }))].map(({ origin, previous, from, jumps, km }) => {
        const leg = inSystem(from, place, lagrange)

        return { kind: 'fly', at: place, previous, origin, jumps, km: km + leg.km, legKm: leg.km, via: leg.via }
      })

      return route(nearest(ends))
    },
  }
}

// The legs of a route, in order: { kind: 'fly', SystemID, from, to, km, via } inside a system (`from` is the
// origin or the jump point the route arrived through, `to` a jump point or the destination, `via` the Lagrange
// points it jumps between), and { kind: 'jump', from, to } through a jump point.
export const routeLegs = (route) => {
  const legs = []

  for (let state = route.end; state; state = state.previous) {
    if (state.kind === 'jump') {
      legs.unshift({ kind: 'jump', from: state.previous.at, to: state.at })
    } else {
      legs.unshift({ kind: 'fly', SystemID: state.at.SystemID, from: state.previous ? state.previous.at : state.origin, to: state.at, km: state.legKm, via: state.via })
    }
  }

  return legs
}

// Travel distance from the nearest of `origins` (the capital, or every sizeable colony) to a body: `distanceTo({
// SystemID, Xcor, Ycor })` gives { km, jumps, from } on the shortest route in kilometres, or null when no explored
// route from any origin reaches it.
export const buildDistanceMap = (jumpPoints, origins) => {
  const routes = searchRoutes(jumpPoints, origins, { order: 'km' })

  return (body) => {
    const found = routes.toPlace(body)

    return found && { km: found.km, jumps: found.jumps, from: found.from }
  }
}
