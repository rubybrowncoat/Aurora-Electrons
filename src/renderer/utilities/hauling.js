// Hauling maths for the Hauling Planner: repeating routes walked from their orders, and what they
// move in a year. Sources and checks: docs/plans/aurcalcs/build-3.md § Hauling Planner.

export const SECONDS_PER_YEAR = 31536000

// Move actions that load or unload cargo, by what they carry.
export const LOADS = { 4: 'colonists', 176: 'installations', 178: 'minerals', 223: 'minerals', 165: 'minerals' }
export const UNLOADS = { 6: 'colonists', 96: 'installations', 177: 'installations', 63: 'minerals', 165: 'minerals' }
// "Load Mineral Type" carries up to MaxItems tonnes of one mineral.
const LOAD_MINERAL_TYPE = 178
// Seconds to load or unload one cargo point or one colonist with one shuttle bay of conventional
// shuttles (docs `logistics`, Logistics and Cargo Handling).
const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }
// Craft up to this size can land, so they load without shuttles (docs `logistics`, Cargo Shuttle Bays).
const SMALL_CRAFT_TONS = 500

// Where an order sends the fleet (`X`, `Y`, `SystemID`) and where it is afterwards (`ExitX`,
// `ExitY`, `ExitSystemID`): the same point for a body, the far side for a jump point or a Lagrange
// point jump. Positions are in-system km, bodies at their current place in orbit.
const hasPoint = (order) => order.X !== null && order.X !== undefined && order.ExitX !== null && order.ExitX !== undefined

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// Legs of one cycle of `orders` (in MoveOrder sequence), closing back to the first order's point.
// Returns { legs: [{ from, to, km }], km, problem }: `problem` names why a route can't be walked
// (an order without a position, or a cycle that ends in another system).
export const walkRoute = (orders) => {
  const legs = []
  let position = null

  for (const order of orders) {
    if (!hasPoint(order)) {
      return { legs: [], km: null, problem: `"${order.Description || order.ActionName}" has no position the app can read` }
    }

    const target = { x: order.X, y: order.Y, system: order.SystemID, label: order.label }

    if (position) {
      if (position.system !== target.system) {
        return { legs: [], km: null, problem: `"${order.Description || order.ActionName}" starts in another system than the order before it ends` }
      }

      legs.push({ from: position.label, to: target.label, km: distance(position, target) })
    }

    position = { x: order.ExitX, y: order.ExitY, system: order.ExitSystemID, label: order.exitLabel || order.label }
  }

  if (!orders.length) {
    return { legs: [], km: null, problem: 'No orders' }
  }

  const first = orders[0]

  if (position.system !== first.SystemID) {
    return { legs: [], km: null, problem: 'The last order ends in another system than the first one starts' }
  }

  legs.push({ from: position.label, to: first.label, km: distance(position, { x: first.X, y: first.Y }) })

  return { legs, km: legs.reduce((sum, leg) => sum + leg.km, 0), problem: null }
}

// What one cycle carries: the cargo kinds loaded, the tonnes or colonists per trip (capacity, or
// less when every mineral load is a "Load Mineral Type" with a set amount) and where it's unloaded.
export const cycleCargo = (orders, fleet) => {
  const loads = orders.filter((order) => LOADS[order.MoveActionID])
  const kinds = [...new Set(loads.map((order) => LOADS[order.MoveActionID]))]
  const mineralLoads = loads.filter((order) => LOADS[order.MoveActionID] === 'minerals')
  const capped = mineralLoads.length > 0 && mineralLoads.every((order) => order.MoveActionID === LOAD_MINERAL_TYPE && order.MaxItems > 0)
  const perTrip = {
    minerals: kinds.includes('minerals') ? (capped ? Math.min(fleet.CargoCapacity, mineralLoads.reduce((sum, order) => sum + order.MaxItems, 0)) : fleet.CargoCapacity) : 0,
    installations: kinds.includes('installations') ? fleet.CargoCapacity : 0,
    colonists: kinds.includes('colonists') ? fleet.ColonistCapacity : 0,
  }
  const destinations = orders.filter((order) => UNLOADS[order.MoveActionID] && order.PopulationID > 0).map((order) => ({ PopulationID: order.PopulationID, name: order.PopName || order.label, kind: UNLOADS[order.MoveActionID] }))
  const sources = loads.filter((order) => order.PopulationID > 0).map((order) => ({ PopulationID: order.PopulationID, name: order.PopName || order.label, kind: LOADS[order.MoveActionID] }))

  return { kinds, capped, perTrip, destinations, sources }
}

// Seconds a fleet spends loading or unloading at one stop: every ship works at once, each taking
// cargo x 20 s (colonists x 10 s) / handling modifier, where the modifier is its shuttle bays, plus
// one if the colony has a spaceport or cargo shuttle station, times the race's shuttle technology.
// Commander, governor and admin Logistics bonuses aren't counted, so this errs long. A ship with
// no way to load there (no bays, no station, too big to land) sets `blocked`.
// `ships`: [{ CargoCapacity, ColonistCapacity, Bays, Tons }]; `share`: the part of a full load moved.
export const stopHandling = (order, ships, shuttleTechnology, share = 1) => {
  const kind = LOADS[order.MoveActionID] || UNLOADS[order.MoveActionID]

  if (!kind) {
    return { seconds: 0, blocked: false }
  }

  let seconds = 0
  let blocked = false

  ships.forEach((ship) => {
    const amount = (kind === 'colonists' ? ship.ColonistCapacity : ship.CargoCapacity) * share

    if (!(amount > 0)) {
      return
    }

    const bays = ship.Bays + (order.Station ? 1 : 0) || (ship.Tons <= SMALL_CRAFT_TONS ? 1 : 0)

    if (!bays) {
      blocked = true

      return
    }

    seconds = Math.max(seconds, (amount * HANDLING_SECONDS[kind]) / (bays * (shuttleTechnology || 1)))
  })

  return { seconds, blocked }
}

// A cycling fleet's year: trips at its set speed plus the time stopped (cargo handling and any order
// delays), what it moves, and the fuel its engines burn while moving (litres per hour x hours under
// way). Refuelling and overhauls aren't counted.
export const routeYear = (fleet, route, cargo, delaySeconds = 0) => {
  if (route.km === null || !(fleet.Speed > 0)) {
    return null
  }

  const movingSeconds = route.km / fleet.Speed
  const cycleSeconds = movingSeconds + delaySeconds
  const trips = cycleSeconds > 0 ? SECONDS_PER_YEAR / cycleSeconds : 0

  return {
    cycleDays: cycleSeconds / 86400,
    movingDays: movingSeconds / 86400,
    trips,
    minerals: trips * cargo.perTrip.minerals,
    installations: trips * cargo.perTrip.installations,
    colonists: trips * cargo.perTrip.colonists,
    fuel: fleet.FuelPerHour * (movingSeconds / 3600) * trips,
  }
}

// A freighter class's reach in a year at top speed: billion km, and cargo x billion km.
export const classYear = (shipClass) => {
  const gkm = (shipClass.MaxSpeed * SECONDS_PER_YEAR) / 1e9

  return { gkm, cargoGkm: shipClass.CargoCapacity * gkm * shipClass.Ships, fuel: shipClass.FuelPerHour * 8760 }
}
