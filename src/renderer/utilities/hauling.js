// Hauling maths for the Hauling Planner: repeating routes walked from their orders, and what they move in a year. Sources and checks: docs/plans/aurcalcs/build-3.md § Hauling Planner.

import { bonusProvenance, mergeFactors } from './handling-bonuses'
import { ofRule, registerRule, unavailable } from './provenance'
import { RETRY_ASSUMPTION, SQUADRON_ASSUMPTION, flyEvent, handleEvent, heldSpeedIn, nebulaGapOf, speedIn, timingGaps, transitModeOf, unsupportedGaps, waitResult, walkEvents } from './route-time'
import { LOADS, SECONDS_PER_YEAR, UNLOADS, UNVERIFIED_VERSION, landingThreshold, missingInputsOf, stopHandling } from './transport'
import { ITEM_LOADS, ITEM_UNLOADS } from './cargo-actions'

// Orders that move up to MaxItems tonnes of one mineral (Load Mineral Type, Unload Mineral Type, Load Mineral when X available); "Load All Minerals" (62) and "...Until Full" (223) take whatever the colony has, up to a full hold.
const QUANTITY_ACTIONS = new Set([178, 179, 180])
// The cargo of a hold: what each load put in (`from` the colony, `item` the mineral or installation type, null when the order loads whatever there is) and how much of it is held.
const sumOf = (entries) => entries.reduce((total, entry) => total + entry.amount, 0)

// The shares of `amount` that the entries of `list` give up, in proportion to what each holds (all of them when the list holds less).
const sharesOf = (list, amount) => {
  const total = sumOf(list)
  const part = total > 0 ? Math.min(amount, total) / total : 0

  return list.map((entry) => entry.amount * part)
}

// What an unload of `amount` takes out of `entries`, as a map from entry to the amount it gives up: of the cargo of `item` only (what was loaded as that item first, then what was loaded as any), or of everything held when `item` is null.
const drawn = (entries, amount, item) => {
  const exact = item === null ? [] : entries.filter((entry) => entry.item === item)
  const loose = item === null ? entries : entries.filter((entry) => entry.item === null)
  const fromExact = sharesOf(exact, amount)
  const fromLoose = sharesOf(loose, amount - fromExact.reduce((total, share) => total + share, 0))

  return new Map([...exact.map((entry, at) => [entry, fromExact[at]]), ...loose.map((entry, at) => [entry, fromLoose[at]])])
}

// Whether two ledgers are the same to within `SETTLED` of each entry: the same entries in the same order, none apart by more than that.
const sameLedger = (a, b) => Object.keys(a).every((kind) => a[kind].length === b[kind].length && a[kind].every((entry, at) => entry.from === b[kind][at].from && entry.item === b[kind][at].item && Math.abs(entry.amount - b[kind][at].amount) <= SETTLED * Math.max(1, Math.abs(entry.amount))))

// Passes over a cycle to settle what the hold carries into it (a hold that fills a little each pass).
const MAX_PASSES = 200
// How little a pass may change an entry of the ledger, relative to the entry (at least 1 tonne of scale), for the cycle to count as settled.
const SETTLED = 1e-9
// Cargo points of the hold one unit of each kind takes: a tonne of mineral takes two (the game loads available capacity / 2 of a mineral), an installation's tonnes are its cargo points. Colonists have their own berths.
export const CARGO_POINTS = { minerals: 2, installations: 1 }
// What the page says of a cycle whose cargo does not settle within the passes.
export const CARGO_UNSETTLED = 'The cargo of this cycle does not settle within the passes, so what a trip carries and the time its stops take to load and unload are not worked out.'

// The rules this module implements, registered once (utilities/provenance.js). Loading time is `transport.handlingTime`, whose strength and landing rules the Hauling page shares with Transport. Evidence: docs/plans/backlog/evidence/AE-080-01.md.
const HAULING_VERSIONS = ['2.7.x']

registerRule({
  id: 'hauling.routeDistance',
  versions: HAULING_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_MoveOrders', 'FCT_JumpPoint', 'FCT_LagrangePoint', 'FCT_SystemBody'],
  note: 'The straight legs between the places a fleet\'s orders name, through the jump points and Lagrange points they cross, as the game measures a fleet\'s orders. A route with an order whose place the save no longer holds is not traced and has no distance.',
})

registerRule({
  id: 'hauling.cycleTime',
  versions: HAULING_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_Fleet.Speed', 'FCT_MoveOrders.OrderDelay', 'FCT_ShipClass.CargoCapacity, ColonistCapacity'],
  note: 'Moving time at the fleet\'s set speed plus loading and unloading as the stop handling time gives them plus the orders\' own delays plus, for each transit through a jump point, the wait for the jump shock the fleet\'s ships draw where the fleet\'s crew is read, counted at its upper case. Loading counts the officers\' Logistics bonuses, and a cycle comes out long when a bonus is not known; refuelling and overhauls are not counted.',
  assumptions: ['full loads, or the amounts set on the orders', 'the fleet\'s set speed all the way', 'no refuelling or overhaul stops'],
})

registerRule({
  id: 'hauling.freightMoved',
  versions: HAULING_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_MoveOrders.MaxItems', 'FCT_ShipClass.CargoCapacity'],
  note: 'The minerals and installations a cycle carries, followed through the orders and the hold (a tonne of mineral takes two cargo points), times the cycles a year. The capacity arithmetic is exact; the cycles a year are estimated.',
  assumptions: ['the colony has the stock a load asks for'],
})

registerRule({
  id: 'hauling.colonistsMoved',
  versions: HAULING_VERSIONS,
  units: 'colonists/yr',
  verification: 'estimated',
  structure: ['FCT_MoveOrders.MaxItems', 'FCT_ShipClass.ColonistCapacity'],
  note: 'The colonists a cycle unloads, followed through the orders and the berths, times the cycles a year. The capacity arithmetic is exact; the cycles a year are estimated.',
  assumptions: ['the colony has the colonists a load asks for'],
})

registerRule({
  id: 'hauling.fleetFuelPerYear',
  versions: HAULING_VERSIONS,
  units: 'L/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.FuelEfficiency, Size', 'FCT_ClassComponent', 'FCT_DamagedComponent', 'FCT_Fleet.Speed, UseMaximumSpeed'],
  note: 'Litres an hour of each ship under its own power: its undamaged engine power x fuel use per engine-power hour x the share of its own top speed the fleet sails at, summed over those ships (a ship in a hangar or under tow burns none), x hours under way x cycles a year. The fleet sails at its saved speed held to what its slowest ship can reach. Refuelling and overhauls are not counted.',
  assumptions: ['each ship burns at its own share of its own top speed, not at full power', 'the fleet\'s saved speed (held to its maximum) all the way'],
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
  note: 'Each unload is credited with the cargo the fleet holds when it gets there, times the cycles a year.',
  assumptions: ['every cycle delivers the same load'],
})

// How far a repeating route's figures can be trusted, as provenance results { cycle, freight, colonists, fuel }: the rules' own status when the route has a year, unavailable naming what is missing when a ship's eligibility or a timing input isn't known (`handling.unknown`), and null otherwise (a route that can't be traced, can't load or isn't moving says why in its own note).
export const routeResults = (route, year, handling, walk = null) => {
  const { inputs, assumptions: bonusAssumptions } = bonusProvenance({ known: handling.known || [], unknown: handling.unsettled || [] })
  const assumptions = [...(handling.versionSupported ? [] : [UNVERIFIED_VERSION]), ...bonusAssumptions]
  const unknown = (missing) => ({
    cycle: unavailable({ rule: 'hauling.cycleTime', missing }),
    freight: unavailable({ rule: 'hauling.freightMoved', missing }),
    colonists: unavailable({ rule: 'hauling.colonistsMoved', missing }),
    fuel: unavailable({ rule: 'hauling.fleetFuelPerYear', missing }),
  })

  if (year) {
    return {
      ...(walk ? { wait: waitResult(walk.wait, walk.missing) } : {}),
      cycle: ofRule({ rule: 'hauling.cycleTime', value: year.cycleDays, inputs, assumptions: [...assumptions, ...(year.waitDays > 0 ? [RETRY_ASSUMPTION] : []), ...(walk && walk.assumptions ? walk.assumptions : [])] }),
      freight: ofRule({ rule: 'hauling.freightMoved', value: year.minerals + year.installations, inputs, assumptions }),
      colonists: ofRule({ rule: 'hauling.colonistsMoved', value: year.colonists, inputs, assumptions }),
      fuel: ofRule({ rule: 'hauling.fleetFuelPerYear', value: year.fuel, inputs, assumptions }),
    }
  } else if (route.km !== null && handling.unknown.length && !handling.blocked.length) {
    return unknown(missingInputsOf(handling.unknown))
  } else if (route.km !== null && walk && !walk.total && !handling.blocked.length) {
    return { wait: waitResult(null, walk.missing), ...unknown(walk.missing) }
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
const moveCargo = (order, ledger, fleet) => {
  const id = order.MoveActionID
  const kind = LOADS[id] || UNLOADS[id]

  if (!kind) {
    return null
  }

  const entries = ledger[kind]
  const heldOf = (name) => sumOf(ledger[name])
  const loading = !!LOADS[id] && !(UNLOADS[id] && heldOf(kind) > 0)
  const item = (loading ? ITEM_LOADS : ITEM_UNLOADS).has(id) ? order.DestinationItemID : null
  const limit = QUANTITY_ACTIONS.has(id) && order.MaxItems > 0 ? order.MaxItems : Infinity
  const space = kind === 'colonists' ? fleet.ColonistCapacity - heldOf('colonists') : (fleet.CargoCapacity - heldOf('minerals') * CARGO_POINTS.minerals - heldOf('installations') * CARGO_POINTS.installations) / CARGO_POINTS[kind]
  const amount = Math.max(0, Math.min(limit, loading ? space : sumOf(entries.filter((entry) => item === null || entry.item === null || entry.item === item))))

  if (loading) {
    const same = entries.find((entry) => entry.from === order.PopulationID && entry.item === item)

    if (amount > 0) {
      same ? (same.amount += amount) : entries.push({ from: order.PopulationID, item, amount })
    }

    return { kind, direction: 'load', amount, sources: [] }
  }

  const taken = drawn(entries, amount, item)
  const sources = entries.map((entry) => ({ from: entry.from, amount: taken.get(entry) || 0 })).filter((source) => source.amount > 0)

  entries.forEach((entry) => (entry.amount -= taken.get(entry) || 0))
  ledger[kind] = entries.filter((entry) => entry.amount > 1e-9)

  return { kind, direction: 'unload', amount, sources }
}

// What one cycle carries, in the steady state of a fleet that repeats it. The cargo is followed through the orders (a load@A, unload@B, load@B, unload@A cycle delivers two holds), and the first passes warm up the hold, since it may start the cycle full. The hold is a ledger of what was loaded where (`ledger`: for each kind, the entries `{ from, item, amount }` of the colony it was loaded at and the mineral or installation type), so an unload of one type takes only that type (and what was loaded as any), and each delivery names the colonies its cargo came from. Returns `moves` (one per order, with the `sources` of an unload), `perTrip` (tonnes of minerals, tonnes of installations and colonists unloaded in a cycle), `deliveries` (what each unloading colony gets in a cycle, with its `sources`), `holdShare` (what a cycle delivers in minerals and installations, in holds of cargo points) and `settled`: whether the ledger stopped changing within the passes. A cycle that has not settled (a large hold refilled a little a cycle, or one that keeps a cargo no order unloads) has no steady state: the last pass is not what the fleet carries, so it publishes no move, no tonnes and no delivery.
export const cycleCargo = (orders, fleet) => {
  const ledger = { minerals: [], installations: [], colonists: [] }
  let moves = []
  let settled = false

  for (let pass = 0; pass < MAX_PASSES && !settled; pass++) {
    const before = JSON.parse(JSON.stringify(ledger))

    moves = orders.map((order) => moveCargo(order, ledger, fleet))
    settled = sameLedger(before, ledger)
  }

  if (!settled) {
    return { moves: orders.map(() => null), perTrip: { minerals: 0, installations: 0, colonists: 0 }, deliveries: [], holdShare: 0, settled }
  }

  const perTrip = { minerals: 0, installations: 0, colonists: 0 }
  const deliveries = []

  moves.forEach((move, index) => {
    if (move && move.direction === 'unload') {
      perTrip[move.kind] += move.amount

      if (move.amount > 0 && orders[index].PopulationID > 0) {
        deliveries.push({ PopulationID: orders[index].PopulationID, name: orders[index].PopName || orders[index].label, kind: move.kind, amount: move.amount, sources: move.sources })
      }
    }
  })

  const holdShare = fleet.CargoCapacity > 0 ? (perTrip.minerals * CARGO_POINTS.minerals + perTrip.installations * CARGO_POINTS.installations) / fleet.CargoCapacity : 0

  return { moves, perTrip, deliveries, holdShare, settled }
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

// A cycling fleet's year: trips at its set speed plus the time stopped (cargo handling and any order delays), what it moves, and the fuel its engines burn while moving (litres per hour x hours under way). Under a walk the hours under way are the distance over the set speed: a nebula that holds the fleet to a lower speed lowers the engine power in step (the game charges the fleet's speed over its maximum of the engine power), so a longer flight at a lower speed burns the same fuel for the same distance. Refuelling and overhauls aren't counted. A route that can't be traced, a fleet with no speed, a route where a ship can't load or isn't known to (`handling.blocked`, `handling.unknown`), or a cycle whose cargo has not settled (`cargo.settled` false: what it carries a trip is still changing after the passes), has no year: it would never move its cargo, or it can't be told.
export const routeYear = (fleet, route, cargo, handling, delaySeconds = 0, walk = null) => {
  if (route.km === null || !(fleet.Speed > 0) || handling.blocked.length || handling.unknown.length || (walk && !walk.total) || cargo.settled === false) {
    return null
  }

  const movingSeconds = walk ? walk.flightHi : route.km / fleet.Speed
  const cycleSeconds = walk ? walk.total.hi : movingSeconds + handling.seconds + delaySeconds
  const trips = cycleSeconds > 0 ? SECONDS_PER_YEAR / cycleSeconds : 0

  return {
    cycleDays: cycleSeconds / 86400,
    cycleLowDays: walk ? walk.total.lo / 86400 : cycleSeconds / 86400,
    movingDays: movingSeconds / 86400,
    handlingDays: (handling.seconds + delaySeconds) / 86400,
    waitDays: walk ? walk.wait.hi / 86400 : null,
    waitLowDays: walk ? walk.wait.lo / 86400 : null,
    transitDays: walk ? walk.transit / 86400 : null,
    trips,
    minerals: trips * cargo.perTrip.minerals,
    installations: trips * cargo.perTrip.installations,
    colonists: trips * cargo.perTrip.colonists,
    fuel: fleet.FuelPerHour * ((walk ? walk.km / fleet.Speed : movingSeconds) / 3600) * trips,
  }
}

// A route with each leg at the distance the year's simulation flew it (`annual.flights` of `simulateCycles`, one flight for each order's hop, the hops in the order of the legs): a body that moved changes the legs that end at it, and a leg between two jump points keeps its saved distance. The route's distance is the legs' sum.
export const propagatedRoute = (route, flights) => {
  const legs = route.legs.map((leg, index) => ({ ...leg, km: flights[index][0] }))

  return { ...route, legs, km: legs.reduce((total, leg) => total + leg.km, 0) }
}

// One cycle of a fleet's orders as the walk of what it goes through, for `routeYear`: at each order the stop (its loading or unloading and its own delay), then the transit when the order leaves the system (a jump point; a Lagrange jump stays in it and gives no shock), then the flight to the next order. `timing` is { shock ({ lo, hi } or null), squadronShock, shockMissing, dust, armour, holdsSpeed } (`fleetTimingOf` of utilities/route-time.js). `route` as `walkRoute` gives it, each leg at the distance it is flown now: for a cycle flown on the moved bodies, the legs the simulation gives (`annual.flights`), so the legs between two jump points keep their distance. Each transit is timed by its order's `MoveActionID` (`transitModeOf`): a standard transit by the standard shock, a squadron transit by its own with an assumption about the scatter, any other not at all. Null with no timing or no cycle to walk; else `walkEvents`' result with `missing` (what the cycle lacks, empty when it is timed) and `assumptions` (what a timed cycle assumes).
export const cycleWalk = (orders, fleet, route, handling, timing) => {
  if (!timing || route.km === null || !(fleet.Speed > 0) || handling.seconds === null) {
    return null
  }

  const clock = { speed: fleet.Speed, holdsSpeed: timing.holdsSpeed, speedIn: timing.holdsSpeed ? heldSpeedIn({ speed: fleet.Speed, dust: timing.dust, armour: timing.armour, systems: orders.map((order) => order.ExitSystemID) }) : speedIn({ speed: fleet.Speed, dust: timing.dust, armour: timing.armour }) }
  const events = orders.flatMap((order, index) => {
    const km = route.legs[index].km
    const mode = transitModeOf(order.MoveActionID)
    const transit = { kind: 'jump', order, label: order.label, ...(mode === 'squadron' ? { shock: timing.squadronShock } : {}), ...(mode === 'unsupported' ? { unsupported: true } : {}) }

    return [handleEvent(order.label, handling.stops[index].seconds + (order.OrderDelay || 0)), ...(order.ExitSystemID !== order.SystemID ? [transit] : []), flyEvent(km, order.ExitSystemID, clock)]
  })
  const walk = walkEvents(events, timing.shock, { cyclic: true, retry: timing.retry })
  const squadron = walk.events.some((event) => event.kind === 'jump' && event.shock !== undefined)
  const missing = walk.total ? [] : walk.unsupported.length ? unsupportedGaps(walk) : walk.flightHi === null ? [nebulaGapOf(timing)] : timingGaps({ speed: fleet.Speed, shock: timing.shock, shockMissing: timing.shockMissing }, { cyclic: true })

  return { ...walk, missing, assumptions: squadron ? [SQUADRON_ASSUMPTION] : [] }
}

// A freighter class's reach in a year at top speed: billion km, and cargo x billion km.
export const classYear = (shipClass) => {
  const gkm = (shipClass.MaxSpeed * SECONDS_PER_YEAR) / 1e9

  return { gkm, cargoGkm: shipClass.CargoCapacity * gkm * shipClass.Ships, fuel: shipClass.FuelPerHour * 8760 }
}
