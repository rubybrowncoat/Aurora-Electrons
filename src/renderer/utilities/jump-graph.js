// Travel distance from the nearest of some origins (the capital, or every sizeable colony) over the jump points
// the race has charted. A jump costs no distance; the legs inside a system do, in a straight line from jump
// point to jump point. Distances follow the shortest route in kilometres, and the jump count is the count on
// that route (the game's own map distance, Game.PopulateMapDistancesFromSelectedSystem, goes by fewest jumps
// first and measures from the system centre, which is not what a freighter flies).

export const KM_PER_AU = 149600000

const hypot = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)

// `jumpPoints`: charted ones with { WarpPointID, SystemID, WPLink, Xcor, Ycor, Explored, IgnoreForDistance }.
// `origins`: [{ SystemID, Xcor, Ycor, ... }], the places to measure from. Returns `distanceTo(body)`, where body
// is { SystemID, Xcor, Ycor }, giving { km, jumps, from } (the origin it is nearest to) or null when no charted
// route from any origin reaches it.
export const buildDistanceMap = (jumpPoints, origins) => {
  if (!origins.length) {
    return () => null
  }

  const bySystem = {}
  const byId = {}

  jumpPoints.forEach((jumpPoint) => {
    byId[jumpPoint.WarpPointID] = jumpPoint
    ;(bySystem[jumpPoint.SystemID] = bySystem[jumpPoint.SystemID] || []).push(jumpPoint)
  })

  const best = {}
  const queue = origins.flatMap((origin) => (bySystem[origin.SystemID] || []).filter((jumpPoint) => !jumpPoint.IgnoreForDistance).map((jumpPoint) => ({ jumpPoint, km: hypot(origin, jumpPoint), jumps: 0, from: origin })))

  while (queue.length) {
    let nearest = 0

    for (let index = 1; index < queue.length; index++) {
      if (queue[index].km < queue[nearest].km) {
        nearest = index
      }
    }

    const { jumpPoint, km, jumps, from } = queue.splice(nearest, 1)[0]

    if (best[jumpPoint.WarpPointID]) {
      continue
    }

    best[jumpPoint.WarpPointID] = { km, jumps, from }

    // Through the jump point to its partner, which costs no distance.
    const partner = byId[jumpPoint.WPLink]

    if (jumpPoint.Explored && partner && !partner.IgnoreForDistance && !best[partner.WarpPointID]) {
      queue.push({ jumpPoint: partner, km, jumps: jumps + 1, from })
    }

    // Then across the system to its other jump points.
    ;(bySystem[jumpPoint.SystemID] || []).forEach((other) => {
      if (other !== jumpPoint && !best[other.WarpPointID] && !other.IgnoreForDistance) {
        queue.push({ jumpPoint: other, km: km + hypot(jumpPoint, other), jumps, from })
      }
    })
  }

  return (body) => {
    let result = null

    origins.forEach((origin) => {
      const km = origin.SystemID === body.SystemID ? hypot(origin, body) : Infinity

      if (km < (result ? result.km : Infinity)) {
        result = { km, jumps: 0, from: origin }
      }
    })

    ;(bySystem[body.SystemID] || []).forEach((jumpPoint) => {
      const reached = best[jumpPoint.WarpPointID]

      if (reached) {
        const km = reached.km + hypot(jumpPoint, body)

        if (!result || km < result.km) {
          result = { km, jumps: reached.jumps, from: reached.from }
        }
      }
    })

    return result
  }
}
