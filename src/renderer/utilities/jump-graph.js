// Travel distance from the capital over the jump points the race has charted. A jump costs no distance;
// the legs inside a system do, in a straight line from jump point to jump point. Distances follow the
// shortest route in kilometres, and the jump count is the count on that route (the game's own map
// distance, Game.PopulateMapDistancesFromSelectedSystem, goes by fewest jumps first and measures from
// the system centre, which is not what a freighter flies).

export const KM_PER_AU = 149600000

const hypot = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)

// `jumpPoints`: charted ones with { WarpPointID, SystemID, WPLink, Xcor, Ycor, Explored, IgnoreForDistance }.
// `capital`: { SystemID, Xcor, Ycor } or null. Returns `distanceTo(body)`, where body is { SystemID, Xcor, Ycor },
// giving { km, jumps } or null when no charted route reaches it.
export const buildDistanceMap = (jumpPoints, capital) => {
  if (!capital) {
    return () => null
  }

  const bySystem = {}
  const byId = {}

  jumpPoints.forEach((jumpPoint) => {
    byId[jumpPoint.WarpPointID] = jumpPoint
    ;(bySystem[jumpPoint.SystemID] = bySystem[jumpPoint.SystemID] || []).push(jumpPoint)
  })

  const best = {}
  const queue = (bySystem[capital.SystemID] || []).filter((jumpPoint) => !jumpPoint.IgnoreForDistance).map((jumpPoint) => ({ jumpPoint, km: hypot(capital, jumpPoint), jumps: 0 }))

  while (queue.length) {
    let nearest = 0

    for (let index = 1; index < queue.length; index++) {
      if (queue[index].km < queue[nearest].km) {
        nearest = index
      }
    }

    const { jumpPoint, km, jumps } = queue.splice(nearest, 1)[0]

    if (best[jumpPoint.WarpPointID]) {
      continue
    }

    best[jumpPoint.WarpPointID] = { km, jumps }

    // Through the jump point to its partner, which costs no distance.
    const partner = byId[jumpPoint.WPLink]

    if (jumpPoint.Explored && partner && !partner.IgnoreForDistance && !best[partner.WarpPointID]) {
      queue.push({ jumpPoint: partner, km, jumps: jumps + 1 })
    }

    // Then across the system to its other jump points.
    ;(bySystem[jumpPoint.SystemID] || []).forEach((other) => {
      if (other !== jumpPoint && !best[other.WarpPointID] && !other.IgnoreForDistance) {
        queue.push({ jumpPoint: other, km: km + hypot(jumpPoint, other), jumps })
      }
    })
  }

  return (body) => {
    let result = body.SystemID === capital.SystemID ? { km: hypot(capital, body), jumps: 0 } : null

    ;(bySystem[body.SystemID] || []).forEach((jumpPoint) => {
      const reached = best[jumpPoint.WarpPointID]

      if (reached) {
        const km = reached.km + hypot(jumpPoint, body)

        if (!result || km < result.km) {
          result = { km, jumps: reached.jumps }
        }
      }
    })

    return result
  }
}
