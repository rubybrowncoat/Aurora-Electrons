// Hauling maths for the Hauling Planner: repeating routes walked from their orders, and what they
// move in a year. Sources and checks: docs/plans/aurcalcs/build-3.md § Hauling Planner.

export const SECONDS_PER_YEAR = 31536000

// Move actions that load or unload cargo, by what they carry.
export const LOADS = { 4: 'colonists', 176: 'installations', 62: 'minerals', 178: 'minerals', 180: 'minerals', 223: 'minerals', 165: 'minerals' }
export const UNLOADS = { 6: 'colonists', 96: 'installations', 177: 'installations', 63: 'minerals', 179: 'minerals', 165: 'minerals' }
// Orders that move up to MaxItems tonnes of one mineral (Load Mineral Type, Unload Mineral Type, Load
// Mineral when X available); "Load All Minerals" (62) and "...Until Full" (223) take whatever the
// colony has, up to a full hold.
const QUANTITY_ACTIONS = new Set([178, 179, 180])
// Passes over a cycle to settle what the hold carries into it (a hold that fills a little each pass).
const MAX_PASSES = 200
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

// Cargo moved by one order, given what the fleet holds: { kind, direction, amount } or null for an
// order that doesn't load or unload. Minerals and installations share the cargo hold, colonists have
// their own berths. "Load Mineral Type" (178), "Load Mineral when X available" (180) and "Unload
// Mineral Type" (179) move up to MaxItems tonnes; every other order moves all it can: a load fills
// the free space (assuming the colony has the stock), an unload empties what the fleet holds of that
// kind. "Load/Unload Minerals to Reserve Level" (165) unloads what the fleet holds and loads when it
// holds none. MaxItems on installation and colonist orders isn't used: it counts items, not tonnes.
const moveCargo = (order, held, fleet) => {
  const id = order.MoveActionID
  const kind = LOADS[id] || UNLOADS[id]

  if (!kind) {
    return null
  }

  const loading = !!LOADS[id] && !(UNLOADS[id] && held[kind] > 0)
  const limit = QUANTITY_ACTIONS.has(id) && order.MaxItems > 0 ? order.MaxItems : Infinity
  const space = kind === 'colonists' ? fleet.ColonistCapacity - held.colonists : fleet.CargoCapacity - held.minerals - held.installations
  const amount = Math.max(0, Math.min(limit, loading ? space : held[kind]))

  held[kind] += loading ? amount : -amount

  return { kind, direction: loading ? 'load' : 'unload', amount }
}

// What one cycle carries, in the steady state of a fleet that repeats it. The cargo is followed
// through the orders (a load@A, unload@B, load@B, unload@A cycle delivers two holds), and the first
// passes warm up the hold, since it may start the cycle full. Returns `moves` (one per order),
// `perTrip` (tonnes and colonists unloaded in a cycle), `deliveries` (what each unloading colony
// gets in a cycle) and `holdShare` (what a cycle delivers in minerals and installations, in holds).
export const cycleCargo = (orders, fleet) => {
  const held = { minerals: 0, installations: 0, colonists: 0 }
  let moves = []

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = { ...held }

    moves = orders.map((order) => moveCargo(order, held, fleet))

    if (Object.keys(held).every((kind) => held[kind] === before[kind])) {
      break
    }
  }

  const perTrip = { minerals: 0, installations: 0, colonists: 0 }
  const deliveries = []

  moves.forEach((move, index) => {
    if (move && move.direction === 'unload') {
      perTrip[move.kind] += move.amount

      if (move.amount > 0 && orders[index].PopulationID > 0) {
        deliveries.push({ PopulationID: orders[index].PopulationID, name: orders[index].PopName || orders[index].label, kind: move.kind, amount: move.amount })
      }
    }
  })

  const holdShare = fleet.CargoCapacity > 0 ? (perTrip.minerals + perTrip.installations) / fleet.CargoCapacity : 0

  return { moves, perTrip, deliveries, holdShare }
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

// Handling over one cycle: each stop is charged for the cargo its own order moves (`cargo.moves`),
// as that part of every ship's capacity. Returns the total `seconds`, the `stops` and the places
// where some ship `blocked` (as order labels).
export const cycleHandling = (orders, cargo, fleet, ships) => {
  const stops = orders.map((order, index) => {
    const move = cargo.moves[index]
    const capacity = move ? (move.kind === 'colonists' ? fleet.ColonistCapacity : fleet.CargoCapacity) : 0

    return { order, ...stopHandling(order, ships, fleet.ShuttleTechnology, capacity > 0 ? move.amount / capacity : 0) }
  })

  return {
    seconds: stops.reduce((sum, stop) => sum + stop.seconds, 0),
    stops,
    blocked: [...new Set(stops.filter((stop) => stop.blocked).map((stop) => stop.order.label))],
  }
}

// A cycling fleet's year: trips at its set speed plus the time stopped (cargo handling and any order
// delays), what it moves, and the fuel its engines burn while moving (litres per hour x hours under
// way). Refuelling and overhauls aren't counted. A route that can't be traced, or where a ship can't
// load (`handling.blocked`), has no year: it would never move its cargo.
export const routeYear = (fleet, route, cargo, handling, delaySeconds = 0) => {
  if (route.km === null || !(fleet.Speed > 0) || handling.blocked.length) {
    return null
  }

  const movingSeconds = route.km / fleet.Speed
  const cycleSeconds = movingSeconds + handling.seconds + delaySeconds
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
