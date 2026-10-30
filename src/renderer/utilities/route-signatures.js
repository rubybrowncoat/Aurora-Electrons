// Route signatures: which fleets run the same repeating route, how many routes that makes, and what the fleets of each can carry in a year. A route is what the stored orders say, never what a colony needs: nothing here reads stock, reserves or production, and a desired route is only ever the player's own record (utilities/route-desires.js).
//
// A fleet's queue is stored as the live queue: the head order is the one in progress and each completed order is cloned onto the tail, so the same cycle is saved at a different rotation from one save to the next. A route key is therefore the least rotation of the order parts, reduced to the primitive period of a queue that repeats a block. The parts of an order are its path (the jump point a transit enters and leaves by, the Lagrange points of a jump inside a system, or the place a stop is at: the colony when the body holds one of the race's own, else the body) and its service (the action and, where the action's own flags say the field means something, the item, the quantity and the minimum). Pacing (`OrderDelay`) is a second key: fleets with one route and another pacing are a variant of the route, not another route. A different conditional set is another route, since a diversion changes what the fleet does. State never enters a key: `Arrived`, the remaining delay, the numbering of the queue, the rotation, the order's description and the ids.
//
// A group is the fleets with one route key and one conditional set. Every group, and each fleet in it, names the stored orders it was inferred from (`orders`), so an inference can always be traced back.

import { place } from './deep-links'
import { ITEM_LOADS, ITEM_UNLOADS } from './cargo-actions'
import { orderPlaceKey } from './places'
import { ofRule, registerRule, unavailable } from './provenance'
import { LOADS, UNLOADS } from './transport'

const ROUTE_VERSIONS = ['2.7.x']

registerRule({
  id: 'hauling.routeGroup',
  versions: ROUTE_VERSIONS,
  units: 'fleets',
  verification: 'estimated',
  structure: ['FCT_MoveOrders', 'DIM_MoveAction.DestinationItemType, SpecifyQuanitity, MinQuantity, TransitOrder', 'FCT_FleetConditionalOrder', 'FCT_OrderTemplate', 'FCT_MoveOrderTemplate'],
  note: 'Fleets are grouped by the stored orders alone: the least rotation of each order\'s path and service (reduced to its period), with the conditional set. No table links a fleet to a template, so a template name is a match of content and may be a copy of a template since removed; a fleet name is free text.',
  assumptions: ['routes are told apart by the stored orders, not by what the fleets were meant to do'],
})

registerRule({
  id: 'hauling.groupCapacity',
  versions: ROUTE_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['hauling.freightMoved', 'hauling.colonistsMoved'],
  note: 'The yearly moves of each capable fleet of the group, each fleet counted once. A fleet that cannot be timed (not traced, cannot load, cannot move) adds nothing and is named, not guessed.',
  assumptions: ['every cycle delivers the same load'],
})

// Move actions that make a fleet wait at a stock: "Load All Minerals Until Full" and "Load Mineral when X available".
const STOCK_WAITS = new Set([223, 180])
const INTRA_SYSTEM_JUMP = 124
const RESERVE_BALANCE = 165
const MOVABLE_TYPES = new Set([5, 6, 10])
const NO_ACTION = Object.freeze({ item: 0, quantity: false, minimum: false, transit: false })

// ---- The words ---------------------------------------------------------------------------------------------------------

// What the list says about a fleet's queue.
export const SHAPES = Object.freeze({
  route: 'Repeating route',
  empty: 'Repeats nothing: no orders',
  untraceable: 'Cannot be traced',
  closed: 'Closed queue, not repeating',
  'finite-repeat': 'Repeats a fixed number of times',
})

export const PROBLEMS = Object.freeze({
  'one-order': 'a cycle of one order does not repeat',
  chain: 'an order starts in another system than the one before it ends in',
  'start-unknown': 'an order does not say which system it starts in',
})

// What a fleet of a group can do about the group's route.
export const STATES = Object.freeze({
  capable: 'Capable',
  empty: 'No ships',
  incompatible: 'Cannot carry here',
  immobile: 'Not moving',
  unknown: 'Cycle not known',
})

// What a group of fleets on one route amounts to.
export const GROUP_STATUSES = Object.freeze({
  capable: 'Served',
  paused: 'Waiting at a stock',
  conditional: 'Conditional outcome not known',
  unknown: 'Cycle not known',
  incapable: 'No capable fleet',
})

// What a group's capacity leaves out.
export const CAPACITY_NOTES = Object.freeze({
  undetermined: 'Leaves out fleets whose conditional outcome is not known',
})

export const ACTIVITY = Object.freeze({
  timer: 'Waiting on its order timer',
  stock: 'Waiting at a stock',
})

export const CONDITION_STATUSES = Object.freeze({
  none: 'No conditional order',
  ignored: 'Conditional orders ignored',
  armed: 'Armed: no condition is true now',
  'true-now': 'A condition is true now: the outcome is not known',
  unresolvable: 'A condition cannot be read from the save: the outcome is not known',
})

export const RELATIONS = Object.freeze({
  'same-route': 'Same route',
  'same-route-pacing': 'Same route, other pacing',
  'same-route-conditions': 'Same route, other conditional orders',
  'same-flows-path': 'Same flows, other path',
  'same-flows-service': 'Same flows, other service',
  reversed: 'Reversed flow',
  'same-pair': 'Same endpoints, other direction or cargo',
  partial: 'Shares a flow',
  endpoint: 'Shares an endpoint only',
  unrelated: 'Unrelated',
})

export const FLAGS = Object.freeze({
  duplicate: 'Duplicated',
  pacing: 'Other pacing',
  stalled: 'Waiting at a stock',
  timer: 'On a timer',
  unfit: 'unfit',
  conditional: 'Conditional',
})

export const NAME_SOURCES = Object.freeze({
  template: 'from template',
  fleet: 'from fleet name',
  generated: 'from its colonies',
})

// What a group named after a template says about how the template matches: the content of the stored orders, and whether the pacing is the same too.
export const MATCHES = Object.freeze({
  exact: 'content match',
  pacing: 'content match, other pacing',
})

export const COVERAGE = Object.freeze({
  covered: 'Covered',
  paused: 'Waiting at a stock',
  unknown: 'Not known',
  uncovered: 'No capable active fleet',
})

// What the desired routes say of a record kept with no yearly demand, where the demand line would go.
export const DESIRE_DEMAND_NONE = 'No demand set'

export const CARGO_KINDS = Object.freeze({
  minerals: 'Minerals',
  installations: 'Installations',
  colonists: 'Colonists',
})

// The unit the yearly amount of a cargo is told in: tonnes of freight and installations, colonists as a count.
export const CARGO_UNITS = Object.freeze({
  minerals: 't',
  installations: 't',
  colonists: 'colonists',
})

// The cargo a desired route is for, and the lengths of its name and note.
export const DESIRE_CARGO = Object.freeze(Object.keys(CARGO_KINDS))
export const DESIRE_NAME_LENGTH = 120
export const DESIRE_NOTE_LENGTH = 200

// ---- The parts of an order ---------------------------------------------------------------------------------------------

const present = (value) => (value === null || value === undefined ? '' : String(value))

const integer = (value) => (Number.isFinite(value) ? value : 0)

// The integer the game reads a decimal minimum as: half to even.
export const halfEven = (value) => {
  const floor = Math.floor(value)
  const fraction = value - floor

  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
}

// The action's own flags: which order fields it uses. `actions` is { [MoveActionID]: { item, quantity, minimum, transit } } (`loadRouteQueues`).
const actionOf = (actions, id) => (actions && actions[id]) || NO_ACTION

const isTransit = (order, action) => order.DestinationType === 1 && action.transit

const isLagrangeJump = (order) => order.DestinationType === 12 && order.MoveActionID === INTRA_SYSTEM_JUMP

// The place a stop is at, as a place key: the colony when the body holds one of the race's own, else the body (types 2 and 15 read as one), a survey location by its number within the system the order starts in, and any other by its own kind.
const endpointKey = (order, raceId) => {
  if (order.DestinationType === 4) {
    return `survey:${present(order.StartSystemID)}:${present(order.DestinationID)}`
  }

  return orderPlaceKey(order, raceId) || `type${present(order.DestinationType)}:${present(order.DestinationID)}`
}

// The system the fleet is in after an order: the far side of a transit, else where the order starts.
const endSystemOf = (order, action) => (isTransit(order, action) ? order.NewSystemID : order.StartSystemID)

// The three parts of one order: `path` (what it passes or goes to), `service` (what it does there) and `pacing` (its delay), with `stop` (the place key of an order that goes to a place, null for a jump), `action`, `itemId` (the mineral or installation type a typed load or unload names, else null), `amount` (its stored quantity), `limited` (an unload of a type that names a quantity and leaves the rest), `movable` (it goes to an object that moves).
export const orderParts = (order, actions, raceId) => {
  const action = actionOf(actions, order.MoveActionID)
  const jump = isTransit(order, action) || isLagrangeJump(order)
  const stop = jump ? null : endpointKey(order, raceId)
  const path = isTransit(order, action) ? `jump:${present(order.DestinationID)}>${present(order.NewWarpPointID)}` : isLagrangeJump(order) ? `lagrange:${present(order.DestinationID)}>${present(order.DestinationItemID)}` : stop
  const item = action.item > 0 && !isLagrangeJump(order) ? `:i${present(order.DestinationItemType)}.${present(order.DestinationItemID)}` : ''
  const quantity = action.quantity ? `:q${integer(order.MaxItems)}` : ''
  const minimum = action.minimum ? `:m${halfEven(integer(order.MinQuantity))}` : ''
  const typed = ITEM_LOADS.has(order.MoveActionID) || ITEM_UNLOADS.has(order.MoveActionID)

  return { path, service: `${present(order.MoveActionID)}${item}${quantity}${minimum}`, pacing: integer(order.OrderDelay), stop, action: order.MoveActionID, itemId: typed ? present(order.DestinationItemID) : null, amount: integer(order.MaxItems), limited: ITEM_UNLOADS.has(order.MoveActionID) && action.quantity && integer(order.MaxItems) > 0, movable: MOVABLE_TYPES.has(order.DestinationType) }
}

// Why a queue does not close, or null when it does: each order starts in the system the one before it ends in, the first after the last.
export const chainProblem = (queue, actions) => {
  if (queue.some((order) => !(order.StartSystemID > 0))) {
    return 'start-unknown'
  }

  const broken = queue.some((order, index) => {
    const before = queue[(index + queue.length - 1) % queue.length]

    return order.StartSystemID !== endSystemOf(before, actionOf(actions, before.MoveActionID))
  })

  return broken ? 'chain' : null
}

// ---- The key -----------------------------------------------------------------------------------------------------------

const rotate = (list, offset) => [...list.slice(offset), ...list.slice(0, offset)]

const compareLists = (a, b) => {
  for (let index = 0; index < a.length; index++) {
    if (a[index] < b[index]) {
      return -1
    } else if (a[index] > b[index]) {
      return 1
    }
  }

  return 0
}

// The rotation of `keys` that sorts first, and among the rotations that tie on the keys, the one whose `pacing` sorts first (so the pacing is read from one place of the cycle whichever rotation the queue was saved at). `{ offset, rotated, delays }`.
export const leastRotation = (keys, pacing = keys.map(() => 0)) => {
  let best = { offset: 0, rotated: [...keys], delays: [...pacing] }

  for (let offset = 1; offset < keys.length; offset++) {
    const rotated = rotate(keys, offset)
    const delays = rotate(pacing, offset)

    if (compareLists(rotated, best.rotated) < 0 || (compareLists(rotated, best.rotated) === 0 && compareLists(delays, best.delays) < 0)) {
      best = { offset, rotated, delays }
    }
  }

  return best
}

// The smallest length after which every column repeats: a queue that holds one block k times has the period of the block.
export const periodOf = (...columns) => {
  const length = columns.length ? columns[0].length : 0

  for (let period = 1; period < length; period++) {
    if (length % period === 0 && columns.every((column) => column.every((item, index) => item === column[index % period]))) {
      return period
    }
  }

  return length
}

const hashText = (text) => {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

// The key of a queue of order parts: `key` (the least rotation of path and service over its period), `pathKey` (the path alone, the same way), `pacingKey` (the delays aligned to the key), `period`, `length`, `repeats` (the times the block repeats), `headPosition` (where the order in progress sits in the key). A queue with no order has none.
export const signatureOf = (parts) => {
  const length = parts.length

  if (!length) {
    return null
  }

  const keys = parts.map((part) => `${part.path}|${part.service}`)
  const { offset, rotated, delays } = leastRotation(keys, parts.map((part) => part.pacing))
  const period = periodOf(rotated)
  const pacingPeriod = periodOf(rotated, delays)
  const paths = leastRotation(parts.map((part) => part.path)).rotated

  return {
    key: rotated.slice(0, period).join(';'),
    pathKey: paths.slice(0, periodOf(paths)).join(';'),
    pacingKey: delays.slice(0, pacingPeriod).join(','),
    period,
    length,
    repeats: length / period,
    headPosition: ((length - offset) % length) % period,
  }
}

// ---- The flows ---------------------------------------------------------------------------------------------------------

// What a cycle moves, as `{ kind, from, to, key }`: cargo of a kind loaded at one place and unloaded at another, read over two passes of the queue so that what is held on entering the first order is credited to the place it was loaded at. The hold is what each load put in, by place and mineral or installation type, with an upper bound of its size (a load of a quantity puts in at most that, any other load has no bound). An unload takes every source it can reach and empties them, so a place unloaded after another unload receives nothing from sources already delivered; an unload of one type reaches only that type (and what was loaded as any), and when it names a quantity it empties them only if their upper bounds are within it, else it leaves the rest for the next unload. A reserve balance (it loads or unloads as the colony's reserve says) is its own flow at the colony.
export const flowsOf = (parts) => {
  const held = {}
  const found = new Map()
  const keep = (kind, from, to) => found.set(`${kind}|${from}|${to}`, { kind, from, to, key: `${kind}|${from}|${to}` })

  for (let pass = 0; pass < 2; pass++) {
    parts.filter((part) => part.stop).forEach((part) => {
      if (part.action === RESERVE_BALANCE) {
        keep('reserve', part.stop, part.stop)
      } else if (LOADS[part.action]) {
        const entries = held[LOADS[part.action]] || (held[LOADS[part.action]] = new Map())
        const key = `${part.stop}|${part.itemId}`
        const bound = ITEM_LOADS.has(part.action) && part.amount > 0 ? part.amount : Infinity

        entries.set(key, { source: part.stop, item: part.itemId, upper: (entries.has(key) ? entries.get(key).upper : 0) + bound })
      } else if (UNLOADS[part.action] && held[UNLOADS[part.action]]) {
        const entries = held[UNLOADS[part.action]]
        const reached = [...entries.entries()].filter(([, entry]) => !ITEM_UNLOADS.has(part.action) || entry.item === null || entry.item === part.itemId)
        const total = reached.reduce((sum, [, entry]) => sum + entry.upper, 0)

        reached.forEach(([, entry]) => keep(UNLOADS[part.action], entry.source, part.stop))

        if (!part.limited || total <= part.amount) {
          reached.forEach(([key]) => entries.delete(key))
        } else if (Number.isFinite(total)) {
          reached.forEach(([, entry]) => (entry.upper *= (total - part.amount) / total))
        }
      }
    })
  }

  return [...found.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
}

// ---- The conditionals --------------------------------------------------------------------------------------------------

// DIM_Condition: the fuel conditions, by the share of a ship's tanks they test (any ship at or below it), and "Fuel: 100%", true when any ship's tanks are full.
const FUEL_AT_MOST = Object.freeze({ 12: 0.5, 11: 0.4, 10: 0.3, 2: 0.2, 3: 0.1 })
const FUEL_FULL = 1

// Whether one condition is true in the save: 'true-now' or 'armed' for the fuel conditions, whose predicate the ships' tanks settle, and 'unresolvable' for every other (maintenance supplies, speed, a hostile contact, a deployment) and for a fuel condition whose tanks are not all read. A true predicate does not say the queue was diverted: the diversion state is not stored.
export const conditionStatus = (conditionId, ships) => {
  const atMost = FUEL_AT_MOST[conditionId]

  if (atMost === undefined && conditionId !== FUEL_FULL) {
    return 'unresolvable'
  }

  const shares = ships.map((ship) => (Number.isFinite(ship.Fuel) && Number.isFinite(ship.FuelCapacity) && ship.FuelCapacity > 0 ? ship.Fuel / ship.FuelCapacity : null))
  const known = shares.filter((share) => share !== null)
  const met = atMost === undefined ? known.some((share) => share >= 1) : known.some((share) => share <= atMost)

  return met ? 'true-now' : known.length && known.length === shares.length ? 'armed' : 'unresolvable'
}

const CONDITION_RANK = ['true-now', 'unresolvable', 'armed']

// The conditional statuses whose outcome the save does not settle: a condition true now may have diverted the fleet from its queue, and one that cannot be read may do so. A fleet in either is not counted as service.
const UNDETERMINED = new Set(['true-now', 'unresolvable'])

// The conditional rows of a fleet and what they make of it: `key` (the ordered rows, empty for a fleet that ignores them), `rows` each with its status, and `status` (the worst of them: a condition true now, then one that cannot be read, then armed).
export const conditionalOf = (rows, { ignored = false, ships = [] } = {}) => {
  const sorted = [...rows].sort((a, b) => a.Priority - b.Priority || a.ConditionID - b.ConditionID)
  const described = sorted.map((row) => ({ priority: row.Priority, conditionId: row.ConditionID, name: row.ConditionName || '', orderId: row.ConditionalOrderID, createFWP: row.CreateFWP, status: conditionStatus(row.ConditionID, ships) }))
  const key = ignored ? '' : sorted.map((row) => `${row.Priority}:${row.ConditionID}:${row.ConditionalOrderID}:${row.CreateFWP}`).join(';')
  const status = !sorted.length ? 'none' : ignored ? 'ignored' : CONDITION_RANK.find((rank) => described.some((row) => row.status === rank))

  return { key, rows: described, status, ignored }
}

// The places of a cycle in the order it visits them, from the place keys of its orders in queue order: a place that repeats the one before it is one stop and the last place that is the first again is the way back, so a place visited twice between others stays twice (A, B, A, C is not A, B, C).
export const cycleStopsOf = (places) => {
  const stops = places.filter(Boolean).filter((stop, index, all) => stop !== all[index - 1])

  return stops.length > 1 && stops[stops.length - 1] === stops[0] ? stops.slice(0, -1) : stops
}

// The place an order names, as the game words it ("Acrab: Load All Minerals" gives "Acrab"), for a list: the description with the action's own name cut off the end.
const stopLabel = (order, action) => {
  const description = order.Description || ''
  const at = action.name ? description.lastIndexOf(`: ${action.name}`) : -1

  return at > 0 ? description.slice(0, at) : description
}

// ---- A fleet's queue ---------------------------------------------------------------------------------------------------

// The fleet's queue as a record. `fleet`: { FleetID, FleetName, CycleMoves, IgnoreConditional }; `orders`: the fleet's rows of FCT_MoveOrders; `actions` the flags of DIM_MoveAction; `conditionals` the fleet's rows of FCT_FleetConditionalOrder; `standing` the number of its standing-order rows (they apply to an idle fleet only, so they are counted, never part of the key); `ships` its ship rows (for the fuel conditions). The `shape` is 'route' (the fleet repeats a closed queue), 'empty', 'untraceable' (with `problem`), 'closed' or 'finite-repeat' (a queue that does not repeat but carries a cargo flow, never counted as service), or 'none' (a queue that is none of them).
export const describeFleet = (fleet, orders, { actions, raceId, conditionals = [], standing = 0, ships = [] }) => {
  const queue = [...orders].sort((a, b) => a.MoveOrder - b.MoveOrder)
  const parts = queue.map((order) => orderParts(order, actions, raceId))
  const flows = flowsOf(parts)
  const cycling = fleet.CycleMoves === 1
  const problem = queue.length === 1 && cycling ? 'one-order' : chainProblem(queue, actions)
  const signature = signatureOf(parts)
  const conditional = conditionalOf(conditionals, { ignored: Boolean(fleet.IgnoreConditional), ships })
  const shape = cycling ? (!queue.length ? 'empty' : problem ? 'untraceable' : 'route') : queue.length < 2 || problem || !flows.length ? 'none' : signature.repeats > 1 ? 'finite-repeat' : 'closed'
  const [head] = queue
  const headAction = head ? actionOf(actions, head.MoveActionID) : NO_ACTION
  const waiting = !head ? null : head.OrderDelayRemaining > 0 ? 'timer' : head.Arrived && STOCK_WAITS.has(head.MoveActionID) ? 'stock' : null

  return {
    FleetID: fleet.FleetID,
    FleetName: fleet.FleetName,
    shape,
    problem: shape === 'untraceable' ? problem : null,
    length: queue.length,
    route: signature && (shape === 'route' || shape === 'closed' || shape === 'finite-repeat') ? { ...signature, conditionalKey: conditional.key, id: `g${hashText(`${signature.key}\n${conditional.key}`)}` } : null,
    flows,
    stops: cycleStopsOf(parts.map((part) => part.stop)),
    labels: Object.fromEntries(queue.map((order, index) => [parts[index].stop, stopLabel(order, actionOf(actions, order.MoveActionID))]).filter(([stop, label]) => stop && label)),
    movable: parts.some((part) => part.movable),
    orders: queue.map((order) => ({ MoveOrderID: order.MoveOrderID, MoveOrder: order.MoveOrder })),
    head: head ? { MoveOrderID: head.MoveOrderID, MoveOrder: head.MoveOrder, action: head.MoveActionID, actionName: headAction.name || '', waiting, remaining: integer(head.OrderDelayRemaining) } : null,
    waiting,
    conditional,
    standing,
  }
}

// ---- Templates ---------------------------------------------------------------------------------------------------------

// The race's order templates by the route they hold. `templates`: [{ OrderTemplateID, TemplateName, orders }] with `orders` the template's rows (as the fleet's, the far side of a transit under `NewJumpPointID`). A template is a closed loop of two or more orders; an open one names no route.
export const templateIndex = (templates, { actions, raceId }) => {
  const byKey = new Map()

  templates.forEach((template) => {
    const queue = [...template.orders].sort((a, b) => a.MoveIndex - b.MoveIndex).map((order) => ({ ...order, NewWarpPointID: order.NewJumpPointID, PopulationRaceID: raceId }))

    if (queue.length < 2 || chainProblem(queue, actions)) {
      return
    }

    const signature = signatureOf(queue.map((order) => orderParts(order, actions, raceId)))
    const named = byKey.get(signature.key) || []

    named.push({ name: template.TemplateName, pacingKey: signature.pacingKey, OrderTemplateID: template.OrderTemplateID })
    byKey.set(signature.key, named)
  })

  return byKey
}

// ---- Groups ------------------------------------------------------------------------------------------------------------

// The fleets of `records` (`describeFleet` records of shape 'route') as groups: one per route key and conditional set, each with its fleets in id order, its `variants` (the fleets that share a pacing), and the stored orders of every fleet (`links`) that the group was inferred from.
export const groupRoutes = (records) => {
  const byId = new Map()

  records.filter((record) => record.shape === 'route' && record.route).forEach((record) => {
    const group = byId.get(record.route.id) || { id: record.route.id, key: record.route.key, pathKey: record.route.pathKey, conditionalKey: record.route.conditionalKey, flows: record.flows, stops: record.stops, movable: false, fleets: [] }

    group.fleets.push(record)
    group.movable = group.movable || record.movable
    byId.set(group.id, group)
  })

  return [...byId.values()].map((group) => {
    const fleets = group.fleets.sort((a, b) => a.FleetID - b.FleetID)
    const variants = new Map()

    fleets.forEach((record) => variants.set(record.route.pacingKey, [...(variants.get(record.route.pacingKey) || []), record.FleetID]))

    return { ...group, fleets, variants: [...variants.entries()].map(([pacingKey, ids]) => ({ pacingKey, fleetIds: ids })), links: fleets.map((record) => ({ FleetID: record.FleetID, orders: record.orders })) }
  }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.conditionalKey < b.conditionalKey ? -1 : 1))
}

// ---- Relations ---------------------------------------------------------------------------------------------------------

const keysOf = (flows) => new Set(flows.map((flow) => flow.key))

const pairsOf = (flows) => new Set(flows.map((flow) => [flow.from, flow.to].sort().join('|')))

const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item))

const intersects = (a, b) => [...a].some((item) => b.has(item))

const endpointsOf = (record) => new Set(record.flows.length ? record.flows.flatMap((flow) => [flow.from, flow.to]) : record.stops)

// How the routes of two fleets (`describeFleet` records with a route) relate, the first that holds: the same route; the same route at another pacing; the same flows by another path or another service; the same flows reversed; the same endpoint pairs in another direction or kind; a shared flow; a shared endpoint (a hub says nothing about duplication); or none. Only the first two are duplicate service.
export const relationOf = (a, b) => {
  const left = a.route
  const right = b.route

  if (left.key === right.key) {
    return left.conditionalKey !== right.conditionalKey ? 'same-route-conditions' : left.pacingKey === right.pacingKey ? 'same-route' : 'same-route-pacing'
  }

  const flowsA = keysOf(a.flows)
  const flowsB = keysOf(b.flows)

  if (flowsA.size && sameSet(flowsA, flowsB)) {
    return left.pathKey === right.pathKey ? 'same-flows-service' : 'same-flows-path'
  } else if (flowsA.size && flowsB.size) {
    const reversed = new Set(b.flows.map((flow) => `${flow.kind}|${flow.to}|${flow.from}`))

    if (sameSet(flowsA, reversed)) {
      return 'reversed'
    } else if (sameSet(pairsOf(a.flows), pairsOf(b.flows))) {
      return 'same-pair'
    } else if (intersects(flowsA, flowsB)) {
      return 'partial'
    }
  }

  return intersects(endpointsOf(a), endpointsOf(b)) ? 'endpoint' : 'unrelated'
}

// ---- Names -------------------------------------------------------------------------------------------------------------

const joined = (names) => (names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and '))

// A name for the route of a group with where it came from (`NAME_SOURCES`): the names of every template of the same content (`templates` from `templateIndex`; a content match, with `exact` when the pacing of the template named first, the one shown, is also that of a fleet of the group), else the name of the fleets, else one built from the colonies of its flows (`colonyNames`: { [colony place key]: name }), when each of its flows runs between colonies. `others` are the other matching template names.
export const routeName = (group, { templates = new Map(), colonyNames = {} } = {}) => {
  const matched = (templates.get(group.key) || []).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const exact = matched.length > 0 && group.fleets.some((record) => record.route.pacingKey === matched[0].pacingKey)

  if (matched.length) {
    return { name: matched[0].name, source: 'template', others: matched.slice(1).map((template) => template.name), exact }
  }

  const fleetNames = [...new Set(group.fleets.map((record) => record.FleetName).filter(Boolean))]

  if (fleetNames.length === 1) {
    return { name: fleetNames[0], source: 'fleet', others: [], exact: false }
  }

  const named = group.flows.length && group.flows.every((flow) => colonyNames[flow.from] && colonyNames[flow.to])

  if (named) {
    return { name: joined(group.flows.map((flow) => (flow.kind === 'reserve' ? `${colonyNames[flow.from]} reserve` : `${colonyNames[flow.from]} to ${colonyNames[flow.to]} ${flow.kind}`))), source: 'generated', others: [], exact: false }
  }

  return fleetNames.length ? { name: fleetNames[0], source: 'fleet', others: [], exact: false } : { name: 'Unnamed route', source: 'generated', others: [], exact: false }
}

// ---- Coverage ----------------------------------------------------------------------------------------------------------

// What a fleet of a route can do, from the figures the page has worked out for it. `figure`: { ships (the number of ships), holds (some ship has a hold: true, false when every ship's capacities are known and none is above zero, null when a capacity is not in the save), profile ('ok', 'immobile', 'unsupported', 'unknown' or 'none'), traced (the cycle can be walked), blocked (the number of stops a ship cannot load or unload at), unknown (the stops not known to be possible), moving (it has a speed), year (what it moves in a year, or null) }; `needs` the kinds of cargo the route carries (keys of `year`). The state is 'capable' (it has a year that moves some of the cargo of the route), 'empty' (no ship), 'incompatible' (no hold, a hold nothing counts, a ship that cannot load where the route loads, or a year that moves none of the route's cargo), 'immobile', or 'unknown' (the cycle cannot be told: not traced, a profile, a capacity or an eligibility not known). `reason` names the case.
export const memberState = (figure, needs = []) => {
  if (!figure) {
    return { state: 'unknown', reason: 'the fleet\'s figures are not read' }
  } else if (!figure.ships || figure.profile === 'none') {
    return { state: 'empty', reason: 'the fleet has no ships' }
  } else if (figure.holds === null) {
    return { state: 'unknown', reason: 'the capacities of the fleet\'s ships are not in the save' }
  } else if (!figure.holds) {
    return { state: 'incompatible', reason: 'no ship of the fleet has a cargo hold or berths' }
  } else if (figure.profile === 'unsupported') {
    return { state: 'incompatible', reason: 'no hold of the fleet is counted: every hold is in a hangar or under tow, or the fleet is a configuration the planner does not handle' }
  } else if (figure.profile === 'unknown') {
    return { state: 'unknown', reason: 'an input of the fleet\'s ships is not in the save' }
  } else if (!figure.traced) {
    return { state: 'unknown', reason: 'the cycle cannot be traced from the saved orders' }
  } else if (figure.blocked > 0) {
    return { state: 'incompatible', reason: 'a ship of the fleet cannot load or unload at a stop of the route' }
  } else if (figure.unknown > 0) {
    return { state: 'unknown', reason: 'it is not known whether the ships can load at every stop' }
  } else if (figure.profile === 'immobile' || !figure.moving) {
    return { state: 'immobile', reason: 'the fleet has no speed' }
  } else if (figure.year && needs.length && !needs.some((kind) => figure.year[kind] > 0)) {
    return { state: 'incompatible', reason: 'the fleet moves none of the cargo the route carries' }
  } else if (figure.year) {
    return { state: 'capable', reason: '' }
  }

  return { state: 'unknown', reason: 'the cycle could not be timed' }
}

const emptyYear = () => ({ minerals: 0, installations: 0, colonists: 0, trips: 0 })

// The groups with what their fleets can do. `figures`: { [FleetID]: figure } as `memberState` takes it. Each member is `{ record, state, reason, active, paused, undetermined, year }`: `undetermined` is a capable fleet whose conditional orders have an outcome the save does not settle (a condition true now or one that cannot be read), so it is not counted as service; `paused` is a capable fleet held at a stock wait, `active` a capable fleet that is not, both only where the outcome is settled. A group's `capacity` is the yearly moves of its capable fleets whose outcome is settled, each fleet counted once whatever the number of groups or reads that name it, and is null when none is; `potential` is the same for every capable fleet, what they would move if no condition diverted them. `status` is 'capable' (an active capable fleet), 'paused' (capable fleets all held at a stock wait), 'conditional' (none settled, a capable fleet whose conditional outcome is not known), 'unknown' (none capable, some not known) or 'incapable'; `duplicate` is two or more capable fleets (duplicate service), `pacing` that the capable fleets run more than one pacing, `waiting` the fleets on a timer or at a stock.
export const coverGroups = (groups, figures) => groups.map((group) => {
  const seen = new Set()
  const needs = [...new Set(group.flows.map((flow) => (flow.kind === 'reserve' ? 'minerals' : flow.kind)))]
  const members = group.fleets.filter((record) => !seen.has(record.FleetID) && seen.add(record.FleetID)).map((record) => {
    const figure = figures[record.FleetID]
    const { state, reason } = memberState(figure, needs)
    const capable = state === 'capable'
    const undetermined = capable && UNDETERMINED.has(record.conditional.status)

    return { record, state, reason, undetermined, active: capable && !undetermined && record.waiting !== 'stock', paused: capable && !undetermined && record.waiting === 'stock', year: capable ? figure.year : null }
  })
  const capable = members.filter((member) => member.state === 'capable')
  const settled = capable.filter((member) => !member.undetermined)
  const sumOf = (list) => (list.length ? list.reduce((total, member) => ({ minerals: total.minerals + member.year.minerals, installations: total.installations + member.year.installations, colonists: total.colonists + member.year.colonists, trips: total.trips + member.year.trips }), emptyYear()) : null)
  const status = members.some((member) => member.active) ? 'capable' : settled.length ? 'paused' : capable.length ? 'conditional' : members.some((member) => member.state === 'unknown') ? 'unknown' : 'incapable'
  const pacings = new Set(capable.map((member) => member.record.route.pacingKey))

  return { ...group, members, capacity: sumOf(settled), potential: sumOf(capable), capableCount: capable.length, status, duplicate: capable.length > 1, pacing: pacings.size > 1, waiting: members.filter((member) => member.record.waiting).length }
})

// The flags of a covered group (`coverGroups`), each `{ key, text, warning }` in the order of `FLAGS`: duplicated service, other pacing among the capable fleets, a fleet waiting at a stock, a fleet waiting on a timer, the fleets that are empty, incompatible or immobile (counted in the text) and a fleet with conditional orders. A group with none of them and a capable status needs no attention.
export const flagsOf = (group) => {
  const stalled = group.members.filter((member) => member.record.waiting === 'stock').length
  const timed = group.members.filter((member) => member.record.waiting === 'timer').length
  const unfit = group.members.filter((member) => member.state === 'empty' || member.state === 'incompatible' || member.state === 'immobile').length
  const conditional = group.members.some((member) => member.record.conditional.status !== 'none')

  return [
    ...(group.duplicate ? [{ key: 'duplicate', text: FLAGS.duplicate, warning: true }] : []),
    ...(group.pacing ? [{ key: 'pacing', text: FLAGS.pacing, warning: false }] : []),
    ...(stalled > 0 ? [{ key: 'stalled', text: FLAGS.stalled, warning: true }] : []),
    ...(timed > 0 ? [{ key: 'timer', text: FLAGS.timer, warning: false }] : []),
    ...(unfit > 0 ? [{ key: 'unfit', text: `${unfit} ${FLAGS.unfit}`, warning: true }] : []),
    ...(conditional ? [{ key: 'conditional', text: FLAGS.conditional, warning: false }] : []),
  ]
}

// The result a group's capacity is shown with: the rule's own status for a group that has a capable fleet, and unavailable (naming the unknown fleets) for one that has none and cannot be told.
export const capacityResult = (group, kind = 'freight') => {
  if (!group.capacity) {
    return unavailable({ rule: 'hauling.groupCapacity', missing: group.status === 'unknown' ? ['the cycle of every fleet of the group'] : group.status === 'conditional' ? ['the outcome of the conditional orders of the fleets'] : ['a capable fleet'], units: kind === 'colonists' ? 'colonists/yr' : 't/yr' })
  }

  return ofRule({ rule: 'hauling.groupCapacity', value: kind === 'colonists' ? group.capacity.colonists : group.capacity.minerals + group.capacity.installations, units: kind === 'colonists' ? 'colonists/yr' : 't/yr', inputs: { present: ['the saved orders of the fleets', 'the cycle and eligibility of each fleet'], missing: [...(group.members.filter((member) => member.state === 'unknown').length ? ['the cycle of a fleet not known'] : []), ...(group.members.some((member) => member.undetermined) ? ['the outcome of the conditional orders of a fleet'] : [])] } })
}

// The result of the grouping itself: the number of fleets the route has, an inference from the stored orders.
export const groupResult = (group) => ofRule({ rule: 'hauling.routeGroup', value: group.fleets.length, units: 'fleets', inputs: { present: ['the stored orders of the fleets', 'the actions\' own flags'], missing: [] } })

// ---- Desired routes ----------------------------------------------------------------------------------------------------

// Each desired route (the player's own record: `{ id, cargo, from, to, yearly }`, `from` and `to` colonies' PopulationIDs, `yearly` the optional yearly demand in tonnes or colonists) against the observed groups with their coverage (`coverGroups`): `state` is 'covered' (a capable, active fleet runs a cycle that carries the cargo from the first colony to the second, and its unloads at the second colony take some of it from the first), 'paused' (such fleets exist but all are held at a stock wait), 'unknown' (no such fleet, but a matching cycle is observed that cannot be told: a fleet whose profile is unknown, whose unloads do not say which colony their cargo came from, or whose conditional orders have an outcome the save does not settle and that may deliver it) and 'uncovered' (no observed cycle carries it, or the fleets that do cannot, or deliver none of it from the first colony: the reason says which). `capacity` is what those fleets unload at the second colony of the cargo from the first in a year (`deliveries`: the page's per-fleet unloads, `{ [FleetID]: [{ PopulationID, kind, amount, sources }] }`, an amount a trip with its `sources` as `[{ from, amount }]` or null when not known, with the fleet's trips in `year`), each fleet once, a fleet whose conditional outcome is not known left out; `gap` is the demand not met, null with no demand and null where a fleet not known could close it. Observed cycles stay as they are: a desired route changes nothing in them.
export const coverDesires = (desires, covered, deliveries = {}) => desires.map((desire) => {
  if (desire.stale) {
    return { ...desire, state: 'unknown', reason: 'a colony of the record is no longer the one that was linked', groups: [], fleets: [], capacity: null, gap: null }
  }

  const from = place.colony(desire.from)
  const to = place.colony(desire.to)
  const matching = covered.filter((group) => group.flows.some((flow) => flow.kind === desire.cargo && flow.from === from && flow.to === to))
  const members = matching.flatMap((group) => group.members)
  const seen = new Set()
  const capable = members.filter((member) => member.state === 'capable' && member.year[desire.cargo] > 0 && !seen.has(member.record.FleetID) && seen.add(member.record.FleetID))
  const settled = capable.filter((member) => !member.undetermined)
  const shareOf = (member) => {
    const unloads = (deliveries[member.record.FleetID] || []).filter((delivery) => delivery.PopulationID === desire.to && delivery.kind === desire.cargo)

    return deliveries[member.record.FleetID] && unloads.every((delivery) => Array.isArray(delivery.sources)) ? unloads.reduce((sum, delivery) => sum + delivery.sources.filter((source) => source.from === desire.from).reduce((part, source) => part + source.amount, 0), 0) : null
  }
  const shares = new Map(capable.map((member) => [member, shareOf(member)]))
  const serving = settled.filter((member) => shares.get(member) > 0)
  const untold = settled.filter((member) => shares.get(member) === null)
  const unknown = members.filter((member) => member.state === 'unknown')
  const open = capable.filter((member) => member.undetermined && shares.get(member) !== 0)
  const state = serving.some((member) => member.active) ? 'covered' : serving.length ? 'paused' : unknown.length || untold.length || open.length ? 'unknown' : 'uncovered'
  const reason = state === 'unknown' ? (open.length && !unknown.length && !untold.length ? 'a fleet that may deliver it has conditional orders whose outcome is not known' : '') : state !== 'uncovered' ? '' : !matching.length ? 'no observed cycle carries this cargo between these colonies' : capable.length ? 'the fleets on the cycles that carry it unload none of it here from the first colony' : 'the fleets on cycles that carry it cannot carry here'
  const capacity = serving.length ? serving.reduce((total, member) => total + member.year.trips * shares.get(member), 0) : null
  const short = Math.max(0, desire.yearly - (capacity || 0))
  const gap = !(desire.yearly > 0) ? null : short === 0 || (!unknown.length && !untold.length && !open.length) ? short : null

  return { ...desire, state, reason, groups: matching.map((group) => group.id), fleets: serving.map((member) => member.record.FleetID), capacity, gap }
})
