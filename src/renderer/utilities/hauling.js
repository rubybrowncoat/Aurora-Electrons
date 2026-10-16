// Hauling maths for the Hauling Planner: repeating routes walked from their orders, and what they move in a year. Sources and checks: docs/plans/aurcalcs/build-3.md § Hauling Planner.

import { bonusProvenance, mergeFactors } from './handling-bonuses'
import { ofRule, registerRule, unavailable } from './provenance'
import { LOADS, SECONDS_PER_YEAR, UNLOADS, UNVERIFIED_VERSION, landingThreshold, missingInputsOf, stopHandling } from './transport'

// Orders that move up to MaxItems tonnes of one mineral (Load Mineral Type, Unload Mineral Type, Load Mineral when X available); "Load All Minerals" (62) and "...Until Full" (223) take whatever the colony has, up to a full hold.
const QUANTITY_ACTIONS = new Set([178, 179, 180])
// Passes over a cycle to settle what the hold carries into it (a hold that fills a little each pass).
const MAX_PASSES = 200
// Cargo points of the hold one unit of each kind takes: a tonne of mineral takes two (the game loads available capacity / 2 of a mineral), an installation's tonnes are its cargo points. Colonists have their own berths.
export const CARGO_POINTS = { minerals: 2, installations: 1 }

// The rules this module implements, registered once (utilities/provenance.js). Loading time is `transport.handlingTime`, whose strength and landing rules the Hauling page shares with Transport. Evidence: docs/plans/backlog/evidence/AE-080-01.md.
const HAULING_VERSIONS = ['2.7.x']

registerRule({
  id: 'hauling.routeDistance',
  versions: HAULING_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_MoveOrders', 'FCT_JumpPoint', 'FCT_LagrangePoint', 'FCT_SystemBody'],
  note: 'The straight legs between the places a fleet\'s orders name, through the jump points and Lagrange points they cross, as the game measures a fleet\'s orders (docs `fleet`). A route with an order whose place the save no longer holds is not traced and has no distance.',
})

registerRule({
  id: 'hauling.cycleTime',
  versions: HAULING_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_Fleet.Speed', 'FCT_MoveOrders.OrderDelay', 'FCT_ShipClass.CargoCapacity, ColonistCapacity'],
  note: 'Moving time at the fleet\'s set speed plus loading and unloading as `transport.handlingTime` gives them plus the orders\' own delays. Loading counts the officers\' Logistics bonuses as `transport.logisticsBonuses` gives them, and a cycle comes out long when a bonus is not known; refuelling and overhauls are not counted.',
  assumptions: ['full loads, or the amounts set on the orders', 'the fleet\'s set speed all the way', 'no refuelling or overhaul stops'],
})

registerRule({
  id: 'hauling.freightMoved',
  versions: HAULING_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_MoveOrders.MaxItems', 'FCT_ShipClass.CargoCapacity'],
  note: 'The minerals and installations a cycle carries, followed through the orders and the hold (a tonne of mineral takes two cargo points), times the cycles a year (`hauling.cycleTime`). The capacity arithmetic is exact; the cycles a year are estimated.',
  assumptions: ['the colony has the stock a load asks for'],
})

registerRule({
  id: 'hauling.colonistsMoved',
  versions: HAULING_VERSIONS,
  units: 'colonists/yr',
  verification: 'estimated',
  structure: ['FCT_MoveOrders.MaxItems', 'FCT_ShipClass.ColonistCapacity'],
  note: 'The colonists a cycle unloads, followed through the orders and the berths, times the cycles a year (`hauling.cycleTime`). The capacity arithmetic is exact; the cycles a year are estimated.',
  assumptions: ['the colony has the colonists a load asks for'],
})

registerRule({
  id: 'hauling.fuelPerYear',
  versions: HAULING_VERSIONS,
  units: 'L/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.EnginePower, FuelEfficiency', 'FCT_Fleet.Speed'],
  note: 'Litres an hour at full power (engine power x fuel use per engine-power hour, as the Propulsion page\'s rule gives it) x hours under way x cycles a year. Refuelling and overhauls are not counted.',
  assumptions: ['full power while moving'],
})

registerRule({
  id: 'hauling.classYear',
  versions: HAULING_VERSIONS,
  units: 'billion km/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.MaxSpeed, CargoCapacity, EnginePower, FuelEfficiency'],
  note: 'Top speed x a year of seconds, capacity x that distance, and the full-power burn over a year.',
  assumptions: ['top speed and full power all year, never stopping to load or refuel'],
})

registerRule({
  id: 'hauling.deliveries',
  versions: HAULING_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_MoveOrders.PopulationID'],
  note: 'Each unload is credited with the cargo the fleet holds when it gets there, times the cycles a year (`hauling.cycleTime`).',
  assumptions: ['every cycle delivers the same load'],
})

// How far a repeating route's figures can be trusted, as provenance results { cycle, freight, colonists, fuel }: the rules' own status when the route has a year, unavailable naming what is missing when a ship's eligibility or a timing input isn't known (`handling.unknown`), and null otherwise (a route that can't be traced, can't load or isn't moving says why in its own note).
export const routeResults = (route, year, handling) => {
  const { inputs, assumptions: bonusAssumptions } = bonusProvenance({ known: handling.known || [], unknown: handling.unsettled || [] })
  const assumptions = [...(handling.versionSupported ? [] : [UNVERIFIED_VERSION]), ...bonusAssumptions]

  if (year) {
    return {
      cycle: ofRule({ rule: 'hauling.cycleTime', value: year.cycleDays, inputs, assumptions }),
      freight: ofRule({ rule: 'hauling.freightMoved', value: year.minerals + year.installations, inputs, assumptions }),
      colonists: ofRule({ rule: 'hauling.colonistsMoved', value: year.colonists, inputs, assumptions }),
      fuel: ofRule({ rule: 'hauling.fuelPerYear', value: year.fuel, inputs, assumptions }),
    }
  } else if (route.km !== null && handling.unknown.length && !handling.blocked.length) {
    const missing = missingInputsOf(handling.unknown)

    return {
      cycle: unavailable({ rule: 'hauling.cycleTime', missing }),
      freight: unavailable({ rule: 'hauling.freightMoved', missing }),
      colonists: unavailable({ rule: 'hauling.colonistsMoved', missing }),
      fuel: unavailable({ rule: 'hauling.fuelPerYear', missing }),
    }
  }

  return null
}

// Where an order sends the fleet (`X`, `Y`, `SystemID`) and where it is afterwards (`ExitX`, `ExitY`, `ExitSystemID`): the same point, unless the order goes through a jump point or jumps between Lagrange points and leaves it on the far side. Positions are in-system km, each destination where the save has it now. An order whose destination the save no longer holds (or a jump point whose far side is uncharted) has none.
const hasPoint = (order) => order.X !== null && order.X !== undefined && order.ExitX !== null && order.ExitX !== undefined

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// Legs of one cycle of `orders` (in MoveOrder sequence), closing back to the first order's point. Returns { legs: [{ from, to, km }], km, problem }: `problem` names why a route can't be walked (an order without a position, or a cycle that ends in another system).
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

// Cargo moved by one order, given what the fleet holds: { kind, direction, amount } or null for an order that doesn't load or unload, the amount in tonnes of minerals, tonnes of installations or colonists. Minerals and installations share the cargo hold (a tonne of mineral takes `CARGO_POINTS.minerals` of its capacity), colonists have their own berths. "Load Mineral Type" (178), "Load Mineral when X available" (180) and "Unload Mineral Type" (179) move up to MaxItems tonnes; every other order moves all it can: a load fills the free space (assuming the colony has the stock), an unload empties what the fleet holds of that kind. "Load/Unload Minerals to Reserve Level" (165) unloads what the fleet holds and loads when it holds none. MaxItems on installation and colonist orders isn't used: it counts items, not tonnes.
const moveCargo = (order, held, fleet) => {
  const id = order.MoveActionID
  const kind = LOADS[id] || UNLOADS[id]

  if (!kind) {
    return null
  }

  const loading = !!LOADS[id] && !(UNLOADS[id] && held[kind] > 0)
  const limit = QUANTITY_ACTIONS.has(id) && order.MaxItems > 0 ? order.MaxItems : Infinity
  const space = kind === 'colonists' ? fleet.ColonistCapacity - held.colonists : (fleet.CargoCapacity - held.minerals * CARGO_POINTS.minerals - held.installations * CARGO_POINTS.installations) / CARGO_POINTS[kind]
  const amount = Math.max(0, Math.min(limit, loading ? space : held[kind]))

  held[kind] += loading ? amount : -amount

  return { kind, direction: loading ? 'load' : 'unload', amount }
}

// What one cycle carries, in the steady state of a fleet that repeats it. The cargo is followed through the orders (a load@A, unload@B, load@B, unload@A cycle delivers two holds), and the first passes warm up the hold, since it may start the cycle full. Returns `moves` (one per order), `perTrip` (tonnes of minerals, tonnes of installations and colonists unloaded in a cycle), `deliveries` (what each unloading colony gets in a cycle) and `holdShare` (what a cycle delivers in minerals and installations, in holds of cargo points).
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

  const holdShare = fleet.CargoCapacity > 0 ? (perTrip.minerals * CARGO_POINTS.minerals + perTrip.installations * CARGO_POINTS.installations) / fleet.CargoCapacity : 0

  return { moves, perTrip, deliveries, holdShare }
}

// Handling over one cycle: each stop is charged for the cargo its own order moves (`cargo.moves`), as that part of every ship's capacity, counting the cargo points a tonne of mineral takes, and takes the slowest ship's time (`stopHandling`). An order's `endpoint` (`colonyEndpoint` or `bareEndpoint`) is where it loads or unloads; `version` the formula version (`loadFormulaVersion`) and `support` the officers' Logistics bonuses (`loadHandlingSupport`, null when not read, so every officer is unknown). Returns the total `seconds` (null when a stop can't be timed), the `stops` (each with the `limiting` ship that sets its time, that ship's `strength`, its `breakdown` and its `eligibility`), `limiting` (the longest stop's { place, ship, strength, breakdown }, null when nothing is moved), the places where a ship can't load, `blocked`: [{ place, status, code, text }] with the responsible ship or colony named in `text`, the places where it isn't known whether one can (a missing input, or a landing size not verified for the version), `unknown`, in the same form, and the officers whose Logistics bonus `known` applies and is `unsettled` (`estimate`: the time counts an unsettled bonus as 1 and errs long). Only cargo orders count: loading troops is no cargo rule's business.
export const cycleHandling = (orders, cargo, fleet, ships, { version = null, support = null } = {}) => {
  const stops = orders.map((order, index) => {
    const move = cargo.moves[index]
    const capacity = move ? (move.kind === 'colonists' ? fleet.ColonistCapacity : fleet.CargoCapacity) : 0
    const handled = stopHandling(order, ships, fleet.ShuttleTechnology, capacity > 0 ? (move.amount * (CARGO_POINTS[move.kind] || 1)) / capacity : 0, { version, support })

    if (!move || Number.isFinite(capacity)) {
      return { order, ...handled }
    }

    const gap = { status: 'unsupported', code: 'capacity', text: `${fleet.FleetName}'s ${move.kind === 'colonists' ? 'colonist' : 'cargo'} capacity is not in the save`, ship: fleet.FleetName, endpoint: order.label }

    return { order, ...handled, seconds: null, eligibility: { ...handled.eligibility, status: handled.eligibility.status === 'blocked' ? 'blocked' : 'unsupported', reasons: [...handled.eligibility.reasons, gap] } }
  })
  const longest = stops.reduce((slowest, stop) => (stop.limiting && (!slowest || stop.seconds > slowest.seconds) ? stop : slowest), null)
  const problems = stops.flatMap((stop) => stop.eligibility.reasons.map((reason) => ({ place: stop.order.label, status: reason.status, code: reason.code, text: reason.text }))).filter((problem, index, all) => all.findIndex((other) => other.text === problem.text) === index)
  const merged = mergeFactors(stops.flatMap((stop) => [stop.known, stop.unknown]))

  return {
    seconds: problems.length ? null : stops.reduce((sum, stop) => sum + stop.seconds, 0),
    stops,
    limiting: longest ? { place: longest.order.label, ship: longest.limiting, strength: longest.strength, breakdown: longest.breakdown } : null,
    blocked: problems.filter((problem) => problem.status === 'blocked'),
    unknown: problems.filter((problem) => problem.status === 'unsupported'),
    estimate: merged.some((factor) => factor.state === 'unknown'),
    known: merged.filter((factor) => factor.state === 'applies'),
    unsettled: merged.filter((factor) => factor.state === 'unknown'),
    versionSupported: landingThreshold(version) !== null,
  }
}

// A cycling fleet's year: trips at its set speed plus the time stopped (cargo handling and any order delays), what it moves, and the fuel its engines burn while moving (litres per hour x hours under way). Refuelling and overhauls aren't counted. A route that can't be traced, a fleet with no speed, or a route where a ship can't load or isn't known to (`handling.blocked`, `handling.unknown`), has no year: it would never move its cargo, or it can't be told.
export const routeYear = (fleet, route, cargo, handling, delaySeconds = 0) => {
  if (route.km === null || !(fleet.Speed > 0) || handling.blocked.length || handling.unknown.length) {
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
