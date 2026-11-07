// The route-position contract: what position each endpoint of a route is held at, how old that position is, and what about it is not known. Route Finder, Transport and Hauling state their routes through it, and replenishment and mission results are meant to.
//
// Every endpoint becomes one record: its identity (the family of place, the key, the id), the position the plan uses, the saved clock that stamps the position (`clock`) with its time (`observedAt`) and its age against the game time (`age`, seconds), the basis of the position (`basis`: 'static', the position the save stores, or 'propagated', a position worked out for the arrival time), whether the endpoint moves at all (`moves`), whether the contract supports it (`supported`) and what is not known about it (`unknown`, `conditions`). The static basis is the baseline: nothing is moved on to the arrival time, a body is held where it stood at its last update, and a fleet with orders or a contact is held where it was seen, never given a later position.
//
// One gate states the mode of every route output (`routeMode`, `routePositions`): a family takes the propagated basis only when an adapter is registered for it in `ADAPTERS`, the consumer takes the adapters (`adapters: ADAPTERS`) because its geometry used the positions they give, and the adapter gives a position; every other family, and every endpoint an adapter declines, stays static with the reason on its record (utilities/orbit-propagation.js `REASONS`). A consumer whose figures rest on the saved positions passes no adapters, so the mode of a figure is the mode of what its distances used.

import { lagrangeModeOf, routeLegs, takesLagrange } from './jump-graph'
import { ANCHOR_FAMILIES, POINT_OWNER_CLASSES, anchorAdapter, groupOf, motionOf, orbitAdapter, switchOf } from './orbit-propagation'
import { place } from './deep-links'
import { combine, envelope, ofRule, registerRule, unavailable, weakestStatus } from './provenance'

export const POSITION_BASIS = Object.freeze({ STATIC: 'static', PROPAGATED: 'propagated' })

export const ROUTE_MODE = Object.freeze({ STATIC: 'static', PROPAGATED: 'propagated', MIXED: 'mixed' })

// The saved clock that stamps each family's position: 'body' (the time the bodies were last moved), 'fleet' (the fleet's last move), 'contact' (the contact's last update) or 'none' (the place does not move). `motion` is how the family moves: 'fixed', 'orbit' (with its body, when orbital motion is on), 'tied' (carried by a body or not, the save does not say), 'carried' (carried by a body when the save gives it an orbit association: `loadPositionFacts` reads it), 'drift' (no recorded motion), 'launched' (a missile salvo, which moves on its own) or 'own' (its own motion). A fleet, waypoint, wreck, life pod or missile salvo that a Lagrange point carries (`ANCHOR_FAMILIES` of utilities/orbit-propagation.js) rides that point whatever its family says: `loadPositionFacts` finds it and its record states the point (`anchor`). `supported: false` marks a family the contract does not vouch for.
const FAMILIES = Object.freeze({
  system: { clock: 'none', motion: 'fixed' },
  'jump-point': { clock: 'none', motion: 'fixed' },
  waypoint: { clock: 'body', motion: 'carried' },
  'survey-location': { clock: 'none', motion: 'fixed' },
  'aether-gate': { clock: 'none', motion: 'fixed' },
  body: { clock: 'body', motion: 'orbit' },
  colony: { clock: 'body', motion: 'orbit' },
  'lagrange-point': { clock: 'body', motion: 'orbit' },
  wreck: { clock: 'body', motion: 'tied' },
  lifepod: { clock: 'none', motion: 'drift', supported: false },
  salvo: { clock: 'none', motion: 'launched', supported: false },
  fleet: { clock: 'fleet', motion: 'own' },
  contact: { clock: 'contact', motion: 'own' },
})

export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES))

// Why a position is not known, by condition code.
export const CONDITIONS = Object.freeze({
  'clock-unread': 'the game time is not read',
  'clock-inconsistent': 'the position is dated after the game time',
  'motion-switch': 'whether the save has orbital motion on is not recorded',
  'motion-classification': 'the body or point classification needed to determine motion is not read',
  'fleet-point-inconsistent': 'the fleet references a Lagrange point outside its game or system, or a point whose identity cannot be read; it is not treated as following that point',
  'anchor-point-inconsistent': 'the object references a Lagrange point outside its game or system; it is not treated as riding that point',
  'anchor-unread': 'the Lagrange point the object rides is not read, so no later position is worked out',
  'visitor-association-unread': 'the arrival action is not recorded, so whether the visiting fleet follows the destination during its wait is not known',
  'wreck-orbit-tie': 'whether a body or a Lagrange point carries the wreck is not recorded',
  'waypoint-orbit-unread': 'whether a body or a Lagrange point carries the waypoint is not recorded',
  'position-unread': 'the position of the place is not recorded',
  'drift-unobserved': 'the save records no motion for a life pod',
  'salvo-unanchored': 'the salvo is carried by no Lagrange point and the save records no motion for it, so where it will be is not known',
  'fleet-state-unread': 'the fleet\'s last move, orbit, anchor and queued orders are not recorded',
  'fleet-orders': 'the fleet has queued orders, so where it will be is not known',
  'fleet-anchored': 'the fleet is anchored to another fleet and moves in formation with it, so where it will be is not known',
  'contact-motion': 'a contact moves on its own and its heading is not known',
  'contact-age-unread': 'the time the contact was last seen is not recorded',
  'stale-contact': 'the contact was last seen before the game time and is not carried forward',
  'cycles-capped': 'the year holds more cycles than the simulation takes, so no yearly figure is worked out and the saved positions stand',
  'timed-clock': 'the elapsed time is a range (the wait for the jump shock, a nebula cap), so no single arrival is worked out and the saved positions stand',
  'propagation-unavailable': 'the position at arrival could not be worked out, so the saved position stands',
  'orbit-unread': 'the orbits of the bodies on the route are not read',
  'orbit-unsurveyed': 'the system is not surveyed, so its orbits are not read and the saved position stands',
  'orbit-missing': 'the save lacks the orbit of the body or Lagrange point, so no later position is worked out',
  'orbit-mismatch': 'the orbit rebuilt from the save is more than 1 km from the saved position, so it is not trusted',
  'orbit-family': 'the body is not an independent asteroid, a moon, a trojan or an eccentric orbit, the families whose motion is propagated',
  'orbit-star': 'the body orbits a star that is not the primary of its system, which is not propagated',
  'orbit-horizon': 'an eccentric orbit would pass one full orbit since the last body update, beyond which the position is not worked out',
  'arrival-diverged': 'the arrival time did not settle to 1 s in 8 evaluations',
  'fleet-immobile': 'the fleet has no engines (a speed of 1 or less), so it reaches no moving body',
  'fleet-slower': 'the fleet is not faster than the body, so it does not overtake it and no arrival is worked out',
  'speed-unknown': 'no speed is known for the fleet, so no arrival time is worked out',
  'eccentric-cadence': 'an eccentric snapshot estimates future cadence with whole calls of the saved sub-pulse or latest increment length and one final remainder call; movement sees the pulse-opening update in sub-pulse mode, or the preceding increment update in after-movement mode (including the pre-update side at its ending boundary); future lengths may differ and no future forced load or edit update is assumed',
  'cadence-unread': 'the sub-pulse or increment cadence needed by movement or an eccentric orbit (including a parent) is not recorded, so the saved position stands; a circular snapshot needs no cadence',
  'cadence-budget': 'the exact saved cadence exceeds the supported call budget, so the saved position stands',
  'family-unknown': 'the kind of place is not one the contract knows',
})

// What each basis holds, by assumption code.
export const ASSUMPTIONS = Object.freeze({
  fixed: 'the place does not move, so its saved position holds at any time',
  'body-held': 'the body moves while the fleet flies; it is held at its saved position, where it stood at the last body update',
  'wreck-held': 'the wreck is held at its saved position; a body may carry it',
  'waypoint-held': 'the waypoint is held at its saved position; a body or a Lagrange point may carry it',
  unplaced: 'the save records no position for the place, so none is held',
  'drift-held': 'the life pod is held at its saved position; its motion is not recorded',
  'anchor-held': 'the object rides a Lagrange point and moves with it; it is held at its saved position',
  'salvo-held': 'the salvo is held at its saved position; its motion is not recorded',
  'fleet-idle': 'the fleet is idle and held where the save has it',
  'fleet-following': 'the fleet orbits a body or rides a Lagrange point and moves with it; it is held at its saved position',
  'fleet-held': 'the fleet is held where the save has it now; its later position is not known',
  'contact-held': 'the contact is held where it was last seen; it moves on its own',
  held: 'the place is held where the save has it',
  propagated: 'the position is estimated at the requested time without future forced load or edit updates; snapshots use full elapsed circular bearings or whole eccentric calls and a final remainder call; movement sees the pulse-opening position in sub-pulse mode or the preceding increment position in after-movement mode, before its ending update',
  departure: 'the position the save holds at the game time, where the fleet sets out from; its orbit rebuilds to it, and it is not an arrival worked out',
})

const POSITION_VERSIONS = ['3.2.x']

// The position rule: the game's orbital position update moves the bodies, then the Lagrange points, then what is anchored to them, one call after another; the planet and moon switch (`FCT_Game.OrbitalMotion`) gates it and no asteroid switch does, `FCT_Game.OrbitalMotionAst` being read by nothing; an eccentric body's bearing falls by 360 x deltaSeconds / (Year x 3600) x current / mean; a trojan takes its parent's bearing plus its offset and a Lagrange point its body's bearing plus 60; a call is made for each sub-pulse of `FCT_Game.SubPulseLength` when `FCT_Game.OrbitalMovementInSubPulse` is 1 and once after the movement of an increment, with its length, when it is 0, the sub-pulse length being set from the increment's length; a fleet at a Lagrange point (`FCT_Fleet.OrbitLagrangeID`) follows it only while its position equals the point's, a waypoint, a wreck, a missile salvo and a life pod anchored to one (`OrbitLagrangeID`) take its position at every call, and the mode of a fleet is `FCT_Fleet.LagrangeStatus` (Manual 0, Plotted 1, Dynamic 2), the legacy `FCT_Fleet.AutoLP` being read by nothing.
// Movement phase: the game updates sub-pulse orbits before it processes the movement of the sub-pulse, so its move orders resolve the updated body X/Y. In increment mode the orbital update follows all movement. Movement in (t0 + (n-1)L, t0 + nL] therefore sees call n or n-1 respectively. A snapshot instead reaches its requested time with full circular advance or whole eccentric calls then a local partial call; t0 stays saved. Loading a save forces a 60-second orbital update without advancing GameTime; future forced updates are not predicted and no load history is inferred.
// The eccentric work limit in this rule is orbit-propagation.js MAX_CALLS = 100000, inclusive of a snapshot remainder call over the horizon; no coarsening is permitted.
registerRule({
  id: 'route.position',
  versions: ['3.2.x'],
  units: '',
  verification: 'estimated',
  structure: ['FCT_Game.GameTime, OrbitalMotion, OrbitalMovementInSubPulse, SubPulseLength', 'FCT_Increments.GameTime, Length', 'FCT_SystemBody.Xcor, Ycor', 'FCT_LagrangePoint.PlanetID, GameID, SystemID, Xcor, Ycor', 'FCT_Fleet.GameID, SystemID, LastMoveTime, OrbitBodyID, OrbitLagrangeID, LagrangeStatus, Xcor, Ycor', 'FCT_MoveOrders.FleetID', 'FCT_Waypoint.GameID, SystemID, OrbitBodyID, OrbitLagrangeID, Xcor, Ycor', 'FCT_Wrecks.GameID, SystemID, OrbitLagrangeID, Xcor, Ycor', 'FCT_Lifepods.GameID, SystemID, OrbitLagrangeID, Xcor, Ycor', 'FCT_MissileSalvo.GameID, RaceID, SystemID, OrbitLagrangeID, Xcor, Ycor', 'FCT_Contacts.LastUpdate'],
  note: 'Saved body, colony and Lagrange point coordinates are the baseline at the game time; the last growth time dates only construction. A no-movement snapshot advances circular and moon-own bearings for the full elapsed time, parents at the same time, and trojans from their propagated parent bearing plus offset. An eccentric snapshot uses whole calls of the saved sub-pulse or latest increment length and one final update call for a positive remainder, recalculating current/mean speed at every call. This estimates future cadence, not an exact played call history. Movement instead sees the pulse-opening update in sub-pulse mode: a positive elapsed time uses the ceiling of elapsed time divided by the sub-pulse length. In after-movement increment mode it uses that ceiling minus one, including the pre-update side of an exact ending boundary. Exactly the saved game time stays saved in both modes. At most 100000 update calls per eccentric body are computed over the horizon, including the final partial snapshot call; an excess is refused with the required count, saved length and budget. The cadence is never coarsened. Unread cadence prevents movement and eccentric propagation, including an eccentric ancestor, but not a circular snapshot. No future forced load or edit update is assumed; loading can advance orbits without advancing the game time, and no load count or offset is inferred. A follower must reference a readable point in its own game and system. A fleet also needs exact saved fleet-to-point coordinates; waypoints, wrecks, life pods and missile salvos are selected by reference alone and snap to the point on the first update in the game\'s order, never at the saved epoch, even when the point itself is fixed. A snapshot at any positive elapsed time includes an update; its final partial call counts as an update. Movement before the first increment update keeps a displaced follower at its own saved coordinates; sub-pulse movement sees its snap at the opening call. Unread point coordinates or owner classification are refused with a named condition, not treated as an exact fixed follower. The app conservatively holds fleets with queued orders or a formation leader because their later trajectory is not established; those guards are not the game\'s own conditions for following a point. A visitor to a point-only waypoint acquires no point association and stays at its arrival position through waits and delays. A nonzero-time Salvage action copies an anchored wreck association to its visitor; the stationary-fleet servicing actions the game lists likewise copy an anchored destination fleet association. Other actions confer no point association, and an unread arrival action is disclosed. An object no point carries is held at its saved position, and a fleet with queued orders and a contact have no known later position and none is invented. Places that never move are exact. Every declined adapter keeps the saved position and states why.',
  assumptions: ['an endpoint is held at the position the save stores unless an adapter moves it on to the requested time; no future forced load or edit orbital update is assumed', 'future eccentric cadence is estimated from the saved sub-pulse length or latest increment length, using whole calls then a final snapshot remainder call; movement retains the pulse-opening update in sub-pulse mode or the preceding increment update in after-movement mode (the eccentric-cadence condition for an eccentric orbit)'],
})

registerRule({
  id: 'route.positionAge',
  versions: POSITION_VERSIONS,
  units: 'seconds',
  verification: 'confirmed',
  structure: ['FCT_Game.GameTime', 'FCT_Fleet.LastMoveTime', 'FCT_Contacts.LastUpdate'],
  note: 'The game time less the position timestamp: saved body, colony and Lagrange point positions and their followers are current at the game time; an independent fleet uses its last move and a contact its last update. The last growth time dates construction, not a position.',
})

const isTime = (value) => typeof value === 'number' && Number.isFinite(value)

const isPosition = (endpoint) => Number.isFinite(endpoint.Xcor) && Number.isFinite(endpoint.Ycor)

// ---- Endpoints --------------------------------------------------------------------------------------------------------
// An endpoint is { family, key, id, name, SystemID, Xcor, Ycor } with `group` (a body's picker group) and `lastUpdate` (a contact's last update) where the page has them. These build one from what each page holds.
const KIND_FAMILY = Object.freeze({ colony: 'colony', system: 'system', fleet: 'fleet', jump: 'jump-point', lagrange: 'lagrange-point', body: 'body', survey: 'survey-location', waypoint: 'waypoint', wreck: 'wreck', lifepod: 'lifepod', contact: 'contact', aether: 'aether-gate' })

// The family of an order's destination by the game's destination type. A deep space population (15) is reached as the body it stands on, a fixed class 3 body, so it is a body: whether it moves, and with what, comes from the orbit read of that body (`motionOf` of utilities/orbit-propagation.js), which reads `FixedBody` and `FixedBodyParentID`, and a fixed body with no parent never moves.
const ORDER_FAMILY = Object.freeze({ 1: 'jump-point', 2: 'body', 4: 'survey-location', 5: 'waypoint', 6: 'contact', 7: 'lifepod', 8: 'wreck', 10: 'fleet', 12: 'lagrange-point', 14: 'aether-gate', 15: 'body' })

// The kind of the key an order's destination has in utilities/deep-links.js `place`, so the contract names an endpoint as every page does.
const ORDER_KIND = Object.freeze({ 1: 'jump', 2: 'body', 4: 'survey', 5: 'waypoint', 6: 'contact', 7: 'lifepod', 8: 'wreck', 10: 'fleet', 12: 'lagrange', 14: 'aether', 15: 'body' })

const idOfKey = (key) => {
  const id = Number(String(key).split(':')[1])

  return Number.isInteger(id) ? id : null
}

// A place of utilities/places.js (a Route Finder or Transport stop): its kind says its family.
export const placeEndpoint = (stop) => ({ family: KIND_FAMILY[stop.kind] || null, key: stop.key, id: idOfKey(stop.key), name: stop.name, SystemID: stop.SystemID, Xcor: stop.kind === 'system' ? 0 : stop.Xcor, Ycor: stop.kind === 'system' ? 0 : stop.Ycor, group: stop.group, lastUpdate: stop.lastUpdate === undefined ? null : stop.lastUpdate })

// A colony row ({ PopulationID, PopName, SystemID, Xcor, Ycor }): the body it stands on.
export const colonyPlaceEndpoint = (colony) => ({ family: 'colony', key: place.colony(colony.PopulationID), id: colony.PopulationID, name: colony.PopName, SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor })

// A move order's destination (`DestinationType`, `DestinationID`, `SurveyLocationID`, `PopulationID`, `X`, `Y`, `SystemID`): an order that names one of the race's colonies is that colony, and a survey location is named by its own ID (`DestinationID` is its number within a system); each is keyed as the place of utilities/deep-links.js. An identity the read does not give has a key of its own place and no id. The destination types are the game's.
export const orderEndpoint = (order) => {
  const colony = order.PopulationID > 0
  const family = colony ? 'colony' : ORDER_FAMILY[order.DestinationType] || null
  const kind = colony ? 'colony' : ORDER_KIND[order.DestinationType] || null
  const named = colony ? order.PopulationID : order.DestinationType === 4 ? order.SurveyLocationID : order.DestinationID
  const id = Number.isInteger(named) && named > 0 ? named : null
  const key = !kind ? `unknown:${order.DestinationType}:${order.DestinationID}` : id === null ? `${kind}:unread:${order.SystemID}:${order.DestinationID}` : place[kind](id)

  return { family, key, id, name: order.label || order.Description || null, SystemID: order.SystemID, Xcor: order.X, Ycor: order.Y, lastUpdate: null }
}

// Where an order leaves the fleet: the destination, unless the order comes out on the far side of a jump point or a Lagrange point (`Jumps`), the point `ExitDestinationID`, `ExitSystemID`, `ExitX` and `ExitY` name.
export const orderExitEndpoint = (order) => (order.Jumps ? orderEndpoint({ ...order, PopulationID: 0, DestinationID: order.ExitDestinationID, SurveyLocationID: null, X: order.ExitX, Y: order.ExitY, SystemID: order.ExitSystemID, label: order.exitLabel || order.label }) : orderEndpoint(order))

// A jump point row ({ WarpPointID, SystemID, Xcor, Ycor }).
export const jumpEndpoint = (jump) => ({ family: 'jump-point', key: place.jump(jump.WarpPointID), id: jump.WarpPointID, name: jump.name || null, SystemID: jump.SystemID, Xcor: jump.Xcor, Ycor: jump.Ycor })

// A Lagrange point row ({ SystemID, Xcor, Ycor } and its `LagrangePointID` when the read has it).
export const lagrangeEndpoint = (point) => ({ family: 'lagrange-point', key: point.LagrangePointID ? place.lagrange(point.LagrangePointID) : `lagrange:${point.SystemID}:${point.Xcor}:${point.Ycor}`, id: point.LagrangePointID || null, name: point.name || null, SystemID: point.SystemID, Xcor: point.Xcor, Ycor: point.Ycor })

// The Lagrange points a found route (`searchRoutes`) jumps between, as endpoints.
export const viaEndpoints = (route) => (route ? routeLegs(route).flatMap((leg) => (leg.via ? leg.via.map(lagrangeEndpoint) : [])) : [])

// ---- Records ----------------------------------------------------------------------------------------------------------
// The adapters of propagation, by family: `(endpoint, { facts, at, from, speed, base })` gives { position: { SystemID, Xcor, Ycor }, observedAt (the time the position is for), conditions, supported } for the time `at` (when the fleet leaves `from`, which the adapter flies to the endpoint at `speed` to find the arrival; no `from` is the position at `at`), or { reasons: [condition codes] } or null when it can not (a throw is the same as null); the record's `age` is then the game time less `observedAt`, negative for a time after the save. A figure may be stated propagated only when its geometry used the returned position, so a consumer takes these adapters (`adapters: ADAPTERS`) only when its search and distances take the positions the records carry; with none given every family is static.
// The families of an object that a Lagrange point may carry take the anchor adapter, which serves only the object a point is read to carry (its `serves`): any other fleet, waypoint, wreck, life pod or salvo is held as it was whatever adapters are given.
export const ADAPTERS = Object.freeze({ body: orbitAdapter, colony: orbitAdapter, 'lagrange-point': orbitAdapter, fleet: anchorAdapter, waypoint: anchorAdapter, wreck: anchorAdapter, lifepod: anchorAdapter, salvo: anchorAdapter })

export const NO_ADAPTERS = Object.freeze({})

// The basis a family takes at the gate: propagated only with an adapter registered for it.
export const familyBasis = (family, adapters = NO_ADAPTERS) => (typeof adapters[family] === 'function' ? POSITION_BASIS.PROPAGATED : POSITION_BASIS.STATIC)

// Whether an adapter serves the endpoint: one is registered for its family and, if the adapter names the states it serves (`serves`, as the anchor adapter does: only an object a point carries), the endpoint's static state is one of them. Every place that gates on an adapter asks this, so an unanchored object is never served.
const servesState = (adapter, state) => typeof adapter.serves !== 'function' || adapter.serves(state())

export const isServed = (endpoint, { facts = null, adapters = NO_ADAPTERS } = {}) => familyBasis(endpoint.family, adapters) === POSITION_BASIS.PROPAGATED && servesState(adapters[endpoint.family], () => staticRecord(endpoint, facts).state)

// The families whose orbits are read for a page (`loadOrbitFacts`): the places that sit on a body or a point, and the objects a point may carry, which the read follows to their points. A place of any other family keeps the position the save stores.
export const ORBIT_FAMILIES = Object.freeze(['body', 'colony', 'lagrange-point', ...ANCHOR_FAMILIES])

// Whether the saved-coordinate epoch, the game time, is read.
const bodyClockOf = (facts) => {
  const clock = facts && facts.clock

  return clock && isTime(clock.gameTime) ? clock : null
}

// The motion group a loader read (`motionOf`); facts that carry none have not read it.
const kindGroup = (group) => (group === 'moving' || group === 'static' ? group : 'unknown')

// Motion follows the one orbital switch only after the body/point classification is read. A picker label alone does not read a fixed flag or a parent association. Off is definitively static even when classification is unread.
const orbitMotion = (endpoint, facts, conditions) => {
  const clock = facts && facts.clock
  const planets = switchOf(clock && clock.orbitalMotion)
  const group = groupOf(facts && facts.orbits, endpoint) || endpoint.group
  const moves = planets === false || group === 'static' ? false : kindGroup(group) === 'unknown' ? null : planets

  if (moves === null && clock) {
    conditions.push(planets === null ? 'motion-switch' : 'motion-classification')
  }

  return moves
}

// The Lagrange facts of a fleet the loader read: { lagrange: { point, mode, shortcuts } }, or nothing when the facts carry none. `mode` is the fleet's `LagrangeStatus` and never the legacy `AutoLP` text.
const lagrangeOf = (found) => (found && (found.mode !== undefined || found.point !== undefined) ? { lagrange: { point: Number.isInteger(found.point) ? found.point : null, mode: found.mode === undefined ? null : found.mode, shortcuts: takesLagrange(found.mode, found.orders) } } : {})

// A fleet's Lagrange behaviour in words, for the page that shows it beside the route options (the Route Finder): { mode (the name the game gives it, null when the save does not record it), text, riding (whether the fleet rides a Lagrange point) } from a fleet's position record (`lagrange` and `anchor`), or null for a record that holds none. The mode is the game's `LagrangeStatus`: a Manual fleet's orders take no Lagrange jumps, a Plotted fleet's always do, and a Dynamic fleet's only while no move order is queued (`takesLagrange`).
export const lagrangeWords = (record) => {
  const lagrange = record && record.lagrange

  if (!lagrange) {
    return null
  }

  const riding = Boolean(record.anchor)
  const where = riding ? ' The fleet rides a Lagrange point and moves with it.' : ''
  const modes = {
    manual: ['Manual', 'orders placed for the fleet take no Lagrange jumps.'],
    plotted: ['Plotted', 'orders placed for the fleet take Lagrange jumps.'],
    dynamic: ['Dynamic', `orders placed for the fleet take Lagrange jumps only while none is queued${lagrange.shortcuts === true ? ', and none is' : lagrange.shortcuts === false ? ', and some are' : ', and whether any is queued is not recorded'}.`],
  }

  if (!modes[lagrange.mode]) {
    return { mode: null, text: `The save does not record the Lagrange mode of the fleet.${where}`, riding }
  }

  const [mode, rule] = modes[lagrange.mode]

  return { mode, text: `${mode}: ${rule}${where}`, riding }
}

// What the saved facts say of a fleet endpoint: { clock, observedAt, moves, assumption, lagrange }. A fleet with queued orders or anchored to another fleet may move, so where it will be is not known. A fleet that orbits a body or sits on the Lagrange point it is anchored to (`OrbitLagrangeID`, at the point's own position, as the game's update requires) follows it. `lagrange` is what the save says of the fleet's Lagrange behaviour: { point, mode, shortcuts }, the point it is anchored to (0 for none), its mode (`LagrangeStatus`, 'manual', 'plotted' or 'dynamic') and whether its route takes a Lagrange jump now (`takesLagrange`).
const fleetState = (endpoint, facts, conditions) => {
  const found = facts && facts.fleets ? facts.fleets[endpoint.id] : null

  if (found && found.pointInconsistent) {
    conditions.push('fleet-point-inconsistent')
  }

  if (!found || found.following === null || found.following === undefined || found.orders === null || found.orders === undefined || found.anchor === null || found.anchor === undefined) {
    conditions.push('fleet-state-unread')

    return { clock: 'fleet', observedAt: found && isTime(found.lastMoveTime) ? found.lastMoveTime : null, moves: null, assumption: 'fleet-held', ...lagrangeOf(found) }
  }

  const mayMove = found.orders > 0 || found.anchor > 0

  if (found.orders > 0) {
    conditions.push('fleet-orders')
  }

  if (found.anchor > 0) {
    conditions.push('fleet-anchored')
  }

  if (found.following) {
    return { clock: 'body', observedAt: bodyClockOf(facts) ? facts.clock.gameTime : null, moves: mayMove ? null : orbitMotion({ group: kindGroup(found.group) }, facts, conditions), assumption: mayMove ? 'fleet-held' : 'fleet-following', ...lagrangeOf(found), ...(!mayMove && ridingPoint(found) !== null ? { anchor: { point: ridingPoint(found) } } : {}) }
  }

  if (!isTime(found.lastMoveTime)) {
    conditions.push('fleet-state-unread')
  }

  return { clock: 'fleet', observedAt: isTime(found.lastMoveTime) ? found.lastMoveTime : null, moves: mayMove ? null : isTime(found.lastMoveTime) ? false : null, assumption: mayMove ? 'fleet-held' : 'fleet-idle', ...lagrangeOf(found) }
}

// What the saved facts say of a waypoint: one that no body and no Lagrange point carries stays where it is, one carried by a body (`OrbitBodyID`) or a Lagrange point (`OrbitLagrangeID`) moves with it (the game moves it after its point at every call), and one whose association is not read is unknown.
const waypointState = (endpoint, facts, conditions) => {
  const found = facts && facts.waypoints ? facts.waypoints[endpoint.id] : null
  const carried = found && (found.orbit > 0 || found.point > 0)

  if (!found || !Number.isInteger(found.orbit) || (found.orbit <= 0 && !Number.isInteger(found.point))) {
    conditions.push('waypoint-orbit-unread')

    return { clock: 'body', observedAt: bodyClockOf(facts) ? facts.clock.gameTime : null, moves: null, assumption: 'waypoint-held' }
  } else if (!carried) {
    return { clock: 'none', observedAt: null, moves: false, assumption: 'fixed' }
  }

  const clock = bodyClockOf(facts)

  if (!clock) {
    conditions.push('clock-unread')
  }

  const point = found.orbit > 0 ? null : ridingPoint(found)
  const moves = orbitMotion({ group: point !== null && found.group === 'static' ? 'moving' : kindGroup(found.group) }, facts, conditions)

  if (found.pointInconsistent) {
    conditions.push('anchor-point-inconsistent')
  } else if (found.orbit <= 0 && found.point > 0 && point === null) {
    conditions.push('anchor-unread')
  }

  return { clock: 'body', observedAt: clock ? clock.gameTime : null, moves, assumption: moves === false ? 'fixed' : point !== null ? 'anchor-held' : 'body-held', ...(found.point > 0 ? { lagrange: { point: found.point } } : {}), ...(point !== null ? { anchor: { point } } : {}) }
}

// The point an object rides, from what the loader read: the reference must name a point in its own game and system with readable coordinates. Only fleets also require exact saved coincidence; the other four kinds snap to their point on the first update. Queued-order and formation fleets are conservatively held by the app, not excluded by the game's own conditions.
const ridingPoint = (found) => (found && found.riding === true && Number.isInteger(found.point) && found.point > 0 ? found.point : null)

// Where the loader keeps what it read of the wrecks, life pods and missile salvos a Lagrange point carries, by family.
const ANCHOR_FACTS = Object.freeze({ wreck: 'wrecks', lifepod: 'lifepods', salvo: 'salvos' })

// A wreck, life pod or salvo with a valid same-game/system point reference is snapped to the point at each update, regardless of saved coincidence. Its exact saved snapshot remains until the first update in the game's order. Null keeps the treatment of an unanchored kind.
const anchoredState = (endpoint, facts, conditions) => {
  const found = facts && facts[ANCHOR_FACTS[endpoint.family]] ? facts[ANCHOR_FACTS[endpoint.family]][endpoint.id] : null
  const point = ridingPoint(found)

  if (point === null) {
    if (found && found.pointInconsistent) {
      conditions.push('anchor-point-inconsistent')
    } else if (found && found.point > 0) {
      conditions.push('anchor-unread')
    }

    return null
  }

  const clock = bodyClockOf(facts)

  if (!clock) {
    conditions.push('clock-unread')
  }

  // Even a fixed point can snap a displaced non-fleet follower on the next update.
  const moves = orbitMotion({ group: found.group === 'static' ? 'moving' : kindGroup(found.group) }, facts, conditions)

  return { clock: 'body', observedAt: clock ? clock.gameTime : null, moves, assumption: moves === false ? 'fixed' : 'anchor-held', anchor: { point } }
}

// The static record of an endpoint: the position the save stores and everything the save says about it.
const staticRecord = (endpoint, facts) => {
  const spec = FAMILIES[endpoint.family]
  const conditions = []
  let state = { clock: spec ? spec.clock : 'none', observedAt: null, moves: false, assumption: 'fixed' }

  const anchored = ANCHOR_FACTS[endpoint.family] ? anchoredState(endpoint, facts, conditions) : null

  if (anchored) {
    state = anchored
  } else if (!spec) {
    conditions.push('family-unknown')
    state = { clock: 'none', observedAt: null, moves: null, assumption: 'held' }
  } else if (spec.motion === 'carried') {
    state = waypointState(endpoint, facts, conditions)
  } else if (spec.motion === 'orbit' || spec.motion === 'tied') {
    const clock = bodyClockOf(facts)

    if (!clock) {
      conditions.push('clock-unread')
    }

    if (spec.motion === 'tied') {
      conditions.push('wreck-orbit-tie')
    }

    const moves = spec.motion === 'tied' ? null : orbitMotion(endpoint, facts, conditions)

    state = { clock: 'body', observedAt: clock ? clock.gameTime : null, moves, assumption: spec.motion === 'tied' ? 'wreck-held' : moves === false ? 'fixed' : 'body-held' }
  } else if (spec.motion === 'drift') {
    conditions.push('drift-unobserved')
    state = { clock: 'none', observedAt: null, moves: null, assumption: 'drift-held' }
  } else if (spec.motion === 'launched') {
    conditions.push('salvo-unanchored')
    state = { clock: 'none', observedAt: null, moves: null, assumption: 'salvo-held' }
  } else if (endpoint.family === 'fleet') {
    state = fleetState(endpoint, facts, conditions)

    if (state.clock === 'body' && !bodyClockOf(facts)) {
      conditions.push('clock-unread')
    }
  } else if (endpoint.family === 'contact') {
    conditions.push('contact-motion')

    if (!isTime(endpoint.lastUpdate)) {
      conditions.push('contact-age-unread')
    }

    state = { clock: 'contact', observedAt: isTime(endpoint.lastUpdate) ? endpoint.lastUpdate : null, moves: null, assumption: 'contact-held' }
  }

  if (!isPosition(endpoint)) {
    conditions.push('position-unread')
    state = { ...state, assumption: 'unplaced' }
  }

  const gameClock = facts && facts.clock && isTime(facts.clock.gameTime) ? facts.clock : null
  let age = gameClock && isTime(state.observedAt) ? gameClock.gameTime - state.observedAt : null

  if (age !== null && age < 0) {
    conditions.push('clock-inconsistent')
    age = null
  }

  if (state.clock === 'contact' && age > 0) {
    conditions.push('stale-contact')
  }

  if (state.clock !== 'none' && !gameClock && !conditions.includes('clock-unread') && endpoint.family !== 'fleet') {
    conditions.push('clock-unread')
  }

  const supported = Boolean(spec) && (spec.supported !== false || Boolean(state.anchor)) && !conditions.includes('stale-contact')

  return { state, conditions, age, supported }
}

// The record of one endpoint at the time `at` (null: the departure at the game time, which the static basis uses for every endpoint), reached from `from` ({ Xcor, Ycor }) at `speed` (km/s) when the arrival is to be worked out. `facts` is `loadPositionFacts`' read (with `orbits`, `loadOrbitFacts`'), null while it is not in, in which case the age and the state of a moving endpoint are unknown. `adapters` is where propagation plugs in; with none (the default) the record is the static one.
export const positionRecord = (endpoint, { facts = null, adapters = NO_ADAPTERS, at = null, from = null, speed = null } = {}) => {
  const { state, conditions, age, supported } = staticRecord(endpoint, facts)
  const identity = Object.freeze({ family: endpoint.family, key: endpoint.key === undefined ? `${endpoint.family}:${endpoint.id}` : endpoint.key, id: endpoint.id === undefined ? null : endpoint.id, name: endpoint.name === undefined ? null : endpoint.name })
  const position = isPosition(endpoint) ? Object.freeze({ SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }) : null
  const base = { identity, family: endpoint.family, position, basis: POSITION_BASIS.STATIC, clock: state.clock, observedAt: state.observedAt, age, moves: state.moves, supported, conditions: [...new Set(conditions)], assumption: state.assumption, ...(state.lagrange ? { lagrange: state.lagrange } : {}), ...(state.anchor ? { anchor: Object.freeze({ ...state.anchor }) } : {}) }

  if (familyBasis(endpoint.family, adapters) === POSITION_BASIS.PROPAGATED && servesState(adapters[endpoint.family], () => state)) {
    let found = null

    try {
      found = adapters[endpoint.family](endpoint, { facts, at, from, speed, base })
    } catch (error) {
      found = null
    }

    if (found && found.position && isTime(found.observedAt)) {
      const clock = facts && facts.clock && isTime(facts.clock.gameTime) ? facts.clock : null
      const lasting = [...new Set(found.conditions || [])]

      if (found.departure) {
        return Object.freeze({ ...base, position: Object.freeze({ ...found.position }), observedAt: found.observedAt, age: clock ? clock.gameTime - found.observedAt : null, conditions: lasting, unknown: lasting.length > 0, assumption: base.moves === false ? base.assumption : 'departure', departure: true })
      }

      return Object.freeze({ ...base, basis: POSITION_BASIS.PROPAGATED, position: Object.freeze({ ...found.position }), observedAt: found.observedAt, age: clock ? clock.gameTime - found.observedAt : null, supported: supported && found.supported !== false, conditions: lasting, unknown: lasting.length > 0, assumption: base.moves === false ? base.assumption : 'propagated' })
    }

    // A place that never moves has no arrival to work out, so no refusal is stated for it.
    if (base.moves === false && !base.anchor) {
      return Object.freeze({ ...base, unknown: base.conditions.length > 0 })
    }

    const kept = [...new Set([...base.conditions, 'propagation-unavailable', ...(found && Array.isArray(found.reasons) ? found.reasons : [])])]

    return Object.freeze({ ...base, conditions: kept, ...(found && found.details ? { details: found.details } : {}), unknown: true })
  }

  return Object.freeze({ ...base, unknown: base.conditions.length > 0 })
}

// ---- The route's positions --------------------------------------------------------------------------------------------
// The mode of a set of records, by the one rule every output shares, over the endpoints that move or may (a place that never moves is exact on either basis and takes no part, whatever an adapter did for it): 'static' when none is propagated, 'propagated' when all are, else 'mixed'.
export const routeMode = (records) => {
  const subjects = records.filter((record) => record.moves !== false && !record.departure)
  const propagated = subjects.filter((record) => record.basis === POSITION_BASIS.PROPAGATED).length

  return propagated === 0 ? ROUTE_MODE.STATIC : propagated === subjects.length ? ROUTE_MODE.PROPAGATED : ROUTE_MODE.MIXED
}

const needsClock = (record) => record.clock !== 'none' && record.moves !== false

// The summary of records, once each by identity, the first of an identity standing for it (with `merge`, carrying every condition any record of it states, and the static basis of any that fell back, so a route that kept a saved position on one visit is never stated as wholly propagated: an endpoint left from at the start and met again later, by the fitted step, says so on the one record that stays): { mode, basis, records, clockRead, ageKnown, oldest, moving, unknown, conditions, unsupported, caveat, assumptions, missing }. `oldest` is the greatest age among the records whose position depends on a clock (null when none does, or when one of them has no age yet: `ageKnown` is false), `moving` counts the records that move or may (`moves` not false), `conditions` is [{ code, keys }], `caveat` is whether any figure resting on these positions is an estimate (something moves, is unknown or is unsupported), and `assumptions` and `missing` are the texts a result carries.
export const summarisePositions = (list, { merge = false } = {}) => {
  const byKey = new Map()

  list.forEach((record) => {
    const key = `${record.identity.family}|${record.identity.key}${record.comparison ? '|saved' : ''}`
    const kept = byKey.get(key)

    if (!kept) {
      byKey.set(key, record)
    } else if (record.departure) {
      // A saved departure adds nothing to a record kept already.
    } else if (kept.departure) {
      byKey.set(key, record)
    } else if (merge) {
      const conditions = [...new Set([...kept.conditions, ...record.conditions])]
      const details = [...new Set([...(kept.details || []), ...(record.details || [])])]
      const fellBack = kept.basis === POSITION_BASIS.PROPAGATED && record.basis !== POSITION_BASIS.PROPAGATED

      if (fellBack) {
        byKey.set(key, Object.freeze({ ...record, conditions, ...(details.length ? { details } : {}), unknown: true }))
      } else if (conditions.length > kept.conditions.length || details.length > (kept.details || []).length) {
        byKey.set(key, Object.freeze({ ...kept, conditions, ...(details.length ? { details } : {}), unknown: true }))
      }
    }
  })

  const records = [...byKey.values()]
  const aged = records.filter(needsClock)
  const ageKnown = aged.every((record) => record.age !== null)
  const moving = records.filter((record) => record.moves !== false)
  const codes = [...new Set(records.flatMap((record) => record.conditions))].sort()
  const conditions = codes.map((code) => ({ code, keys: records.filter((record) => record.conditions.includes(code)).map((record) => record.identity.key) }))
  const unsupported = records.filter((record) => !record.supported).map((record) => record.identity.key)
  const caveat = moving.length > 0 || codes.length > 0 || unsupported.length > 0
  const held = [...new Set(records.filter((record) => record.assumption !== 'fixed').map((record) => record.assumption))]
  const clockRead = records.every((record) => !record.conditions.includes('clock-unread'))
  const mode = routeMode(records)

  return Object.freeze({
    mode,
    basis: mode,
    records: Object.freeze(records),
    clockRead,
    ageKnown,
    oldest: aged.length && ageKnown ? Math.max(...aged.map((record) => record.age)) : null,
    moving: moving.length,
    unknown: codes.length > 0,
    conditions: Object.freeze(conditions),
    unsupported: Object.freeze(unsupported),
    caveat,
    assumptions: Object.freeze([...held.map((code) => ASSUMPTIONS[code]), ...(unsupported.length ? ['an endpoint the contract does not support is held at its saved position'] : [])]),
    missing: Object.freeze([...codes.map((code) => CONDITIONS[code]), ...new Set(records.flatMap((record) => record.details || []))]),
  })
}

// The summary of what a page's figures rest on when some of them are measured on the saved positions beside others worked out for the arrival: `simulated` records are summarised as they are (merge: true); a record of `saved` whose endpoint a simulation did move stays a separate observation (`comparison: true`), so it never replaces the worked-out one and the strip reads mixed with both assumptions, and any other saved record joins the summary as it stands.
export const withSavedComparison = (simulated, saved) => {
  const keyOf = (record) => `${record.identity.family}|${record.identity.key}`
  const flown = summarisePositions(simulated, { merge: true })
  const moved = new Set(flown.records.filter((record) => record.basis === POSITION_BASIS.PROPAGATED).map(keyOf))

  return summarisePositions([...flown.records, ...saved.map((record) => (moved.has(keyOf(record)) ? Object.freeze({ ...record, comparison: true }) : record))], { merge: true })
}

// The positions of a route: the records of `endpoints` (each { family, key, id, … }, a falsy one left out) and their summary. The one gate every route output goes through: `facts` and `adapters` are the same for every consumer, so a route states the same mode and unknown conditions wherever it is shown.
export const routePositions = (endpoints, { facts = null, adapters = NO_ADAPTERS, at = null } = {}) => summarisePositions(endpoints.filter(Boolean).map((endpoint) => positionRecord(endpoint, { facts, adapters, at })))

// A result that rests on positions, stated with them: a figure that depends on a body that moves, on a fleet or contact with no known later position or on a position that is not known is at best an estimate, carries what is held and names what is not known. An unavailable result stays so. A summary with nothing to caveat leaves the result as it was.
export const withPositions = (result, positions) => {
  if (!result || !positions || !positions.caveat) {
    return result
  }

  const assumptions = [...result.assumptions, ...positions.assumptions]

  if (result.status === 'unavailable') {
    return envelope({ status: 'unavailable', rule: result.rule.id, inputs: result.inputs, units: result.units, assumptions })
  }

  return envelope({ value: result.value, status: weakestStatus([result.status, 'estimated']), rule: result.rule.id, inputs: { present: result.inputs.present, missing: [...result.inputs.missing, ...positions.missing] }, units: result.units, assumptions })
}

// A figure worked out from the timed results of a route (a year's freight, the days a haul takes) as a result of its own: `rule`, `units` and `value` are the figure's, and its status, assumptions and inputs, the positions' unknowns among them, are those of the results it rests on. Null for no results or no value, and unavailable when one of the results is.
export const figureOf = ({ rule, results, value, units }) => {
  if (!results.length || results.some((result) => !result) || typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return combine({ rule, parts: Object.fromEntries(results.map((result, index) => [`timed result ${index + 1}`, result])), compute: () => value, units })
}

// The age of the oldest position as a result: seconds, unavailable while it is not read, and null when no endpoint depends on a clock.
export const ageResult = (positions) => {
  if (!positions || !positions.records.some(needsClock)) {
    return null
  }

  return positions.ageKnown ? ofRule({ rule: 'route.positionAge', value: positions.oldest, inputs: { present: ['the game time', 'the time of each position'] } }) : unavailable({ rule: 'route.positionAge', missing: ['the game time and the time of each position'] })
}

// A length of time for a line of text: days to one decimal from a day, else hours, else minutes.
const durationText = (seconds) => {
  if (seconds >= 86400) {
    return `${Number((seconds / 86400).toFixed(1))} d`
  } else if (seconds >= 3600) {
    return `${Number((seconds / 3600).toFixed(1))} h`
  }

  return `${Math.max(1, Math.round(seconds / 60))} min`
}

// An age in seconds for a line of text: 0 reads as current, a position after the save (a negative age, a propagated one) reads as that long ahead.
export const ageText = (seconds) => {
  if (!isTime(seconds)) {
    return '—'
  } else if (seconds === 0) {
    return 'current'
  }

  return seconds < 0 ? `${durationText(-seconds)} ahead` : durationText(seconds)
}

// The positions in words for a panel: `groups` are the endpoints that share an assumption and the conditions that go with it, as { key, assumption, text, names, count, ages, conditions: [{ code, text }], supported }, in the order the endpoints first appear. Fixed places are one group.
export const describePositions = (positions) => {
  if (!positions) {
    return []
  }

  const groups = new Map()

  positions.records.forEach((record) => {
    const key = [record.assumption, record.conditions.join(','), record.supported, JSON.stringify(record.details || [])].join('|')

    if (!groups.has(key)) {
      groups.set(key, { key, assumption: record.assumption, text: ASSUMPTIONS[record.assumption], names: [], count: 0, ages: [], conditions: [...record.conditions.map((code) => ({ code, text: CONDITIONS[code] })), ...(record.details || []).map((text) => ({ code: 'cadence-budget-detail', text }))], supported: record.supported })
    }

    const group = groups.get(key)

    group.count += 1
    group.names.push(record.identity.name || record.identity.key)
    group.ages.push(record.age)
  })

  return [...groups.values()]
}

// ---- The read ---------------------------------------------------------------------------------------------------------
const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

const timeOrNull = (value) => (isTime(value) ? value : null)

// The motion group (`motionOf` of utilities/orbit-propagation.js) of each body the IDs name, from the saved fields of the body and of the bodies the game's position update follows from it (a trojan's parent, a fixed body's fixed parent): 'moving', 'static', or 'unknown' for a body the save does not hold and for one whose class, trojan angle, fixed flag or parent association was not read. A column the save lacks reads as not read, never as 0. `classes` holds the body class of each, null when it is not read.
const BODY_MOTION_ROUNDS = 5

const loadBodyGroups = async (database, body, GameID, ids) => {
  const wanted = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  const groups = {}
  const classes = {}

  if (!wanted.length) {
    return { groups, classes }
  }

  const known = {}
  const stored = (name, value) => (body.has(name) && value !== null && value !== undefined ? Number(value) : null)
  const readable = ['SystemBodyID', 'BodyClass'].every((name) => body.has(name))
  let pending = readable ? wanted : []

  for (let round = 0; pending.length && round <= BODY_MOTION_ROUNDS; round += 1) {
    const rows = (await Promise.all(Array.from({ length: Math.ceil(pending.length / 400) }, (_empty, index) => pending.slice(index * 400, (index + 1) * 400)).map(async (part) => (await database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, ${body.has('TrojanAsteroid') ? 'FCT_SystemBody.TrojanAsteroid' : 'null'} as Trojan, ${body.has('ParentBodyID') ? 'FCT_SystemBody.ParentBodyID' : 'null'} as Parent, ${body.has('FixedBody') ? 'FCT_SystemBody.FixedBody' : 'null'} as Fixed, ${body.has('FixedBodyParentID') ? 'FCT_SystemBody.FixedBodyParentID' : 'null'} as FixedParent from FCT_SystemBody where FCT_SystemBody.SystemBodyID in (${part.join(',')})${body.has('GameID') ? ` and FCT_SystemBody.GameID = ${Number(GameID)}` : ''}`))[0]))).flat()

    pending = []
    rows.forEach((row) => {
      known[row.SystemBodyID] = { bodyClass: row.BodyClass === null || row.BodyClass === undefined ? null : Number(row.BodyClass), trojan: stored('TrojanAsteroid', row.Trojan), parentId: stored('ParentBodyID', row.Parent), fixed: stored('FixedBody', row.Fixed), fixedParentId: stored('FixedBodyParentID', row.FixedParent) }
      pending.push(...[known[row.SystemBodyID].parentId, known[row.SystemBodyID].fixedParentId])
    })
    pending = [...new Set(pending.filter((id) => id > 0 && !known[id]))]
  }

  wanted.forEach((id) => {
    groups[id] = motionOf(known, id)
    classes[id] = known[id] ? known[id].bodyClass : null
  })

  return { groups, classes }
}

// The motion group of the body each Lagrange point the IDs name rides, by the point's ID: the game moves a point only with a planet (1) or a moon (2), so a point whose owner is another class is 'static', and otherwise the point moves as its owner does. A point the save does not hold, or whose owner it does not hold, is 'unknown'.
const loadPointGroups = async (database, body, lagrange, GameID, ids) => {
  const wanted = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  const points = {}

  if (!wanted.length || !['LagrangePointID', 'PlanetID'].every((name) => lagrange.has(name))) {
    return points
  }

  const rows = (await Promise.all(Array.from({ length: Math.ceil(wanted.length / 400) }, (_empty, index) => wanted.slice(index * 400, (index + 1) * 400)).map(async (part) => (await database.query(`select FCT_LagrangePoint.LagrangePointID, FCT_LagrangePoint.PlanetID from FCT_LagrangePoint where FCT_LagrangePoint.LagrangePointID in (${part.join(',')})${lagrange.has('GameID') ? ` and FCT_LagrangePoint.GameID = ${Number(GameID)}` : ''}`))[0]))).flat()
  const { groups, classes } = await loadBodyGroups(database, body, GameID, rows.map((row) => row.PlanetID))

  rows.forEach((row) => {
    const owner = Number(row.PlanetID)

    points[row.LagrangePointID] = Number.isFinite(classes[owner]) && !POINT_OWNER_CLASSES.includes(classes[owner]) ? 'static' : groups[owner] || 'unknown'
  })

  return points
}

// The columns a table needs for the identity rule that finds the objects riding a Lagrange point, and the ones of the point table: the object's game, system, point reference and position, and the point's identity, game, system and position.
const ANCHOR_COLUMNS = ['GameID', 'SystemID', 'OrbitLagrangeID', 'Xcor', 'Ycor']
const LAGRANGE_COLUMNS = ['LagrangePointID', 'GameID', 'SystemID', 'Xcor', 'Ycor']

const canRide = (columns, lagrange) => ANCHOR_COLUMNS.every((name) => columns.has(name)) && LAGRANGE_COLUMNS.every((name) => lagrange.has(name))

// Non-fleet followers are selected by point reference, not saved coincidence. -1 means a point outside the object's game/system, null an unread position, 1 a valid reference, 0 no point. The fleet read below retains its exact-X/Y test.
const ridingSql = (table) => {
  const identity = `FCT_LagrangePoint.LagrangePointID = ${table}.OrbitLagrangeID and FCT_LagrangePoint.GameID = ${table}.GameID and FCT_LagrangePoint.SystemID = ${table}.SystemID`

  return `case when ${table}.OrbitLagrangeID is null or ${table}.Xcor is null or ${table}.Ycor is null then null when ${table}.OrbitLagrangeID > 0 and not exists (select 1 from FCT_LagrangePoint where ${identity}) then -1 when ${table}.OrbitLagrangeID > 0 and exists (select 1 from FCT_LagrangePoint where ${identity} and FCT_LagrangePoint.Xcor is not null and FCT_LagrangePoint.Ycor is not null) then 1 when ${table}.OrbitLagrangeID > 0 then null else 0 end`
}

// The facts positions rest on: `clock` { gameTime, lastGrowthTime, orbitalMotion, orbitalMovementInSubPulse, subPulseLength, incrementLength } of the game (a column the save lacks is null, never 0; `incrementLength` is the length of the latest increment the save holds), `fleets`, by FleetID, of the race's own fleets: { lastMoveTime, following (orbiting a body, or anchored to a Lagrange point, at exactly the body's or the point's coordinates: true, false, or null when the save does not say), group (the motion group of the body or of the point's owner it follows), point (the Lagrange point it is anchored to, `OrbitLagrangeID`, 0 for none, null when the save does not say), riding (true when the fleet stands at the point it references, in its own game and system, at its exact saved position: the identity rule that makes it a follower), mode (`LagrangeStatus`: 'manual', 'plotted' or 'dynamic', null when it is not read; the legacy `AutoLP` is read by nothing), orders (queued move orders, null when the save does not say), anchor (the fleet it is anchored to, 0 for none, null when the save does not say) } and `waypoints`, by WaypointID, of the race's own waypoints: { orbit (the body that carries it, 0 for none, null when the save does not say), point (the Lagrange point that carries it, 0 for none, null when the save does not say), group (the motion group of that body, or of that point's owner), riding (the same identity rule) }. `wrecks` (by WreckID), `lifepods` (by LifepodID) and `salvos` (by MissileSalvoID) hold the ones a Lagrange point carries, as { point, group, riding } with `pointInconsistent` for a point reference the rule refuses. `pointInconsistent` is on every kind that names a point outside its game or system, or one it does not stand at. `problems` names what the save lacks.
export const loadPositionFacts = async (database, { GameID, RaceID }) => {
  const [game, fleet, orders, body, waypoint, increments, lagrange, wreck, lifepod, salvo, survey] = await Promise.all(['FCT_Game', 'FCT_Fleet', 'FCT_MoveOrders', 'FCT_SystemBody', 'FCT_Waypoint', 'FCT_Increments', 'FCT_LagrangePoint', 'FCT_Wrecks', 'FCT_Lifepods', 'FCT_MissileSalvo', 'FCT_RaceSysSurvey'].map((table) => columnsOf(database, table)))
  const problems = []
  const gameColumn = (name) => (game.has(name) ? `FCT_Game.${name}` : 'null')
  const incrementLength = ['GameID', 'GameTime', 'Length'].every((name) => increments.has(name)) ? '(select FCT_Increments.Length from FCT_Increments where FCT_Increments.GameID = FCT_Game.GameID order by FCT_Increments.GameTime desc limit 1)' : 'null'
  let clock = { gameTime: null, lastGrowthTime: null, orbitalMotion: null, orbitalMovementInSubPulse: null, subPulseLength: null, incrementLength: null }

  if (game.has('GameID')) {
    const [[row]] = await database.query(`select ${gameColumn('GameTime')} as GameTime, ${gameColumn('LastGrowthTime')} as LastGrowthTime, ${gameColumn('OrbitalMotion')} as OrbitalMotion, ${gameColumn('OrbitalMovementInSubPulse')} as OrbitalMovementInSubPulse, ${gameColumn('SubPulseLength')} as SubPulseLength, ${incrementLength} as IncrementLength from FCT_Game where FCT_Game.GameID = :GameID`, { replacements: { GameID } })

    if (row) {
      clock = { gameTime: timeOrNull(row.GameTime), lastGrowthTime: timeOrNull(row.LastGrowthTime), orbitalMotion: row.OrbitalMotion === undefined ? null : row.OrbitalMotion, orbitalMovementInSubPulse: row.OrbitalMovementInSubPulse === undefined ? null : row.OrbitalMovementInSubPulse, subPulseLength: timeOrNull(row.SubPulseLength), incrementLength: timeOrNull(row.IncrementLength) }
    }
  }

  if (clock.gameTime === null) {
    problems.push('the save has no game time')
  }

  const fleets = {}

  if (['FleetID', 'GameID', 'RaceID'].every((name) => fleet.has(name))) {
    const orbits = ['OrbitBodyID', 'Xcor', 'Ycor'].every((name) => fleet.has(name)) && ['SystemBodyID', 'Xcor', 'Ycor'].every((name) => body.has(name))
    const following = orbits ? 'case when FCT_Fleet.OrbitBodyID is null or FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null then null when FCT_Fleet.OrbitBodyID > 0 and exists (select 1 from FCT_SystemBody where FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBody.Xcor = FCT_Fleet.Xcor and FCT_SystemBody.Ycor = FCT_Fleet.Ycor) then 1 when FCT_Fleet.OrbitBodyID > 0 and exists (select 1 from FCT_SystemBody where FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and (FCT_SystemBody.Xcor is null or FCT_SystemBody.Ycor is null)) then null else 0 end' : 'null'
    const anchored = ['OrbitLagrangeID', 'SystemID', 'Xcor', 'Ycor'].every((name) => fleet.has(name)) && ['LagrangePointID', 'GameID', 'SystemID', 'Xcor', 'Ycor'].every((name) => lagrange.has(name))
    const pointIdentity = 'FCT_LagrangePoint.LagrangePointID = FCT_Fleet.OrbitLagrangeID and FCT_LagrangePoint.GameID = FCT_Fleet.GameID and FCT_LagrangePoint.SystemID = FCT_Fleet.SystemID'
    const followingPoint = anchored ? `case when FCT_Fleet.OrbitLagrangeID is null or FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null then null when FCT_Fleet.OrbitLagrangeID > 0 and not exists (select 1 from FCT_LagrangePoint where ${pointIdentity}) then -1 when FCT_Fleet.OrbitLagrangeID > 0 and exists (select 1 from FCT_LagrangePoint where ${pointIdentity} and FCT_LagrangePoint.Xcor = FCT_Fleet.Xcor and FCT_LagrangePoint.Ycor = FCT_Fleet.Ycor) then 1 when FCT_Fleet.OrbitLagrangeID > 0 and exists (select 1 from FCT_LagrangePoint where ${pointIdentity} and (FCT_LagrangePoint.Xcor is null or FCT_LagrangePoint.Ycor is null)) then null else 0 end` : 'null'
    const queued = ['FleetID', 'GameID'].every((name) => orders.has(name)) ? '(select count(*) from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = FCT_Fleet.GameID)' : 'null'
    const [rows] = await database.query(`select FCT_Fleet.FleetID, ${fleet.has('LastMoveTime') ? 'FCT_Fleet.LastMoveTime' : 'null'} as LastMoveTime, ${following} as Following, ${followingPoint} as FollowingPoint, ${fleet.has('OrbitBodyID') ? 'FCT_Fleet.OrbitBodyID' : 'null'} as OrbitBody, ${fleet.has('OrbitLagrangeID') ? 'FCT_Fleet.OrbitLagrangeID' : 'null'} as OrbitPoint, ${fleet.has('LagrangeStatus') ? 'FCT_Fleet.LagrangeStatus' : 'null'} as LagrangeStatus, ${queued} as Orders, ${fleet.has('AnchorFleetID') ? 'FCT_Fleet.AnchorFleetID' : 'null'} as Anchor from FCT_Fleet where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID`, { replacements: { GameID, RaceID } })

    const { groups: fleetGroups } = await loadBodyGroups(database, body, GameID, rows.map((row) => row.OrbitBody))
    const pointGroups = await loadPointGroups(database, body, lagrange, GameID, rows.map((row) => row.OrbitPoint))
    const unread = (value) => value === null || value === undefined

    rows.forEach((row) => {
      const either = unread(row.Following) || unread(row.FollowingPoint) ? (Number(row.Following) === 1 || Number(row.FollowingPoint) === 1 ? true : null) : Number(row.Following) === 1 || Number(row.FollowingPoint) === 1
      const onPoint = Number(row.FollowingPoint) === 1

      fleets[row.FleetID] = Object.freeze({ lastMoveTime: timeOrNull(row.LastMoveTime), following: either, group: (onPoint ? pointGroups[row.OrbitPoint] : fleetGroups[row.OrbitBody]) || null, point: unread(row.OrbitPoint) ? null : Number(row.OrbitPoint), mode: lagrangeModeOf(row.LagrangeStatus), orders: unread(row.Orders) ? null : Number(row.Orders), anchor: unread(row.Anchor) ? null : Number(row.Anchor), ...(onPoint ? { riding: true } : {}), ...(Number(row.FollowingPoint) === -1 || (!anchored && Number(row.OrbitPoint) > 0) ? { pointInconsistent: true } : {}) })
    })
  } else {
    problems.push('the save has no fleet, game or race identifier on fleets, so no fleet position could be read')
  }

  const waypoints = {}

  if (['WaypointID', 'GameID', 'RaceID', 'OrbitBodyID'].every((name) => waypoint.has(name))) {
    const [rows] = await database.query(`select FCT_Waypoint.WaypointID, FCT_Waypoint.OrbitBodyID as Orbit, ${waypoint.has('OrbitLagrangeID') ? 'FCT_Waypoint.OrbitLagrangeID' : 'null'} as Point, ${canRide(waypoint, lagrange) ? ridingSql('FCT_Waypoint') : 'null'} as Riding from FCT_Waypoint where FCT_Waypoint.GameID = :GameID and FCT_Waypoint.RaceID = :RaceID`, { replacements: { GameID, RaceID } })

    const { groups: owners } = await loadBodyGroups(database, body, GameID, rows.map((row) => row.Orbit))
    const pointOwners = await loadPointGroups(database, body, lagrange, GameID, rows.map((row) => row.Point))

    rows.forEach((row) => {
      const point = row.Point === null || row.Point === undefined ? null : Number(row.Point)

      waypoints[row.WaypointID] = Object.freeze({ orbit: row.Orbit === null || row.Orbit === undefined ? null : Number(row.Orbit), point, group: (Number(row.Orbit) > 0 ? owners[row.Orbit] : pointOwners[row.Point]) || null, ...(Number(row.Riding) === 1 ? { riding: true } : {}), ...(Number(row.Riding) === -1 ? { pointInconsistent: true } : {}) })
    })
  } else {
    problems.push('the save has no waypoint, game, race or orbit body identifier on waypoints, so whether a body or a Lagrange point carries a waypoint could not be read')
  }

  // The wrecks, life pods and missile salvos that a Lagrange point carries (`OrbitLagrangeID` above 0), by ID, as { point, group, riding, pointInconsistent }: the wrecks and life pods of the systems the race has surveyed, whoever's they were, and the race's own salvos. A save that lacks a table reads none of its kind, and one that holds the table without the columns the identity rule needs says so.
  const anchoredKind = async (table, key, columns, scope, noun) => {
    if (columns.size === 0) {
      return {}
    } else if (scope === null || ![key, ...ANCHOR_COLUMNS].every((name) => columns.has(name)) || !LAGRANGE_COLUMNS.every((name) => lagrange.has(name))) {
      problems.push(`the save has no key, game, system, position, race or Lagrange point on ${noun}, so the objects a Lagrange point carries could not be read`)

      return {}
    }

    const [rows] = await database.query(`select ${table}.${key} as ID, ${table}.OrbitLagrangeID as Point, ${ridingSql(table)} as Riding from ${table} where ${table}.GameID = :GameID and ${table}.OrbitLagrangeID > 0 and ${scope}`, { replacements: { GameID, RaceID } })
    const groups = await loadPointGroups(database, body, lagrange, GameID, rows.map((row) => row.Point))

    return Object.fromEntries(rows.map((row) => [row.ID, Object.freeze({ point: Number(row.Point), group: groups[row.Point] || null, riding: Number(row.Riding) === 1, ...(Number(row.Riding) === -1 ? { pointInconsistent: true } : {}) })]))
  }
  const surveyed = (table) => (['SystemID', 'GameID', 'RaceID'].every((name) => survey.has(name)) ? `${table}.SystemID in (select FCT_RaceSysSurvey.SystemID from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = :GameID and FCT_RaceSysSurvey.RaceID = :RaceID)` : null)
  const wrecks = await anchoredKind('FCT_Wrecks', 'WreckID', wreck, surveyed('FCT_Wrecks'), 'wrecks')
  const lifepods = await anchoredKind('FCT_Lifepods', 'LifepodID', lifepod, surveyed('FCT_Lifepods'), 'life pods')
  const salvos = await anchoredKind('FCT_MissileSalvo', 'MissileSalvoID', salvo, salvo.has('RaceID') ? 'FCT_MissileSalvo.RaceID = :RaceID' : null, 'missile salvos')

  return Object.freeze({ clock: Object.freeze(clock), fleets: Object.freeze(fleets), waypoints: Object.freeze(waypoints), wrecks: Object.freeze(wrecks), lifepods: Object.freeze(lifepods), salvos: Object.freeze(salvos), problems: Object.freeze(problems) })
}
