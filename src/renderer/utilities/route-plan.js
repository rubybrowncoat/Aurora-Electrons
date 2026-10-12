// A route through several stops, as Route Finder plans it: each leg is the route from one stop to the next over the explored jump points (utilities/jump-graph.js `searchRoutes`), and a cycle adds one back to the first stop.

import { routeLegs, searchRoutes } from './jump-graph'

const positionOf = (place) => ({ SystemID: place.SystemID, Xcor: place.Xcor, Ycor: place.Ycor })

// `stops`: places ({ key, kind, name, SystemID, Xcor, Ycor }) in order. `options` are `searchRoutes`'s (`order`, `canTransit`, `canEnter`, `lagrangePoints`). A leg runs from where the fleet is after the one before: a place is its own position, but a system is where its route arrives, the jump point it comes in through (a leg that starts at a system centre is only the first). Returns:
// - `legs`: one per leg, { index, from, to, start, route, steps }, `route` being { jumps, km, from, end } or null when no explored route joins them, and `steps` its `routeLegs`.
// - `jumps` and `km`: the totals of the legs that have a route; `missing` counts the ones that haven't.
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
  let start = stops.length ? positionOf(stops[0]) : null
  let jumps = 0
  let km = 0
  let missing = 0

  targets.forEach((to, index) => {
    const search = searchFrom(start)
    const route = to.kind === 'system' ? search.toSystem(to.SystemID) : search.toPlace(to)
    const steps = route ? routeLegs(route) : []

    legs.push({ index, from: stops[index], to, start, route, steps, closing: Boolean(cycle) && index === targets.length - 1 })

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
    systems.push(start.SystemID)
  } else if (stops.length) {
    systems.push(stops[0].SystemID)
  }

  return { legs, jumps, km, missing, systems: systems.filter((id, index) => id !== systems[index - 1]) }
}
