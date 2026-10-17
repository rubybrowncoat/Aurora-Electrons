// The route-position contract: what position each endpoint of a route is held at, how old that position is, and what about it is not known. Route Finder, Transport and Hauling state their routes through it, and replenishment and mission results are meant to.
//
// Every endpoint becomes one record: its identity (the family of place, the key, the id), the position the plan uses, the saved clock that stamps the position (`clock`) with its time (`observedAt`) and its age against the game time (`age`, seconds), the basis of the position (`basis`: 'static', the position the save stores, or 'propagated', a position worked out for the arrival time), whether the endpoint moves at all (`moves`), whether the contract supports it (`supported`) and what is not known about it (`unknown`, `conditions`). The static basis is the baseline: nothing is moved on to the arrival time, a body is held where it stood at its last update, and a fleet with orders or a contact is held where it was seen, never given a later position.
//
// One gate states the mode of every route output (`routeMode`, `routePositions`): a family takes the propagated basis only when an adapter is registered for it in `ADAPTERS`, the consumer takes the adapters (`adapters: ADAPTERS`) because its geometry used the positions they give, and the adapter gives a position; every other family, and every endpoint an adapter declines, stays static with the reason on its record (utilities/orbit-propagation.js `REASONS`). A consumer whose figures rest on the saved positions passes no adapters, so the mode of a figure is the mode of what its distances used.

import { routeLegs } from './jump-graph'
import { groupOf, motionOf, orbitAdapter } from './orbit-propagation'
import { place } from './deep-links'
import { combine, envelope, ofRule, registerRule, unavailable, weakestStatus } from './provenance'

export const POSITION_BASIS = Object.freeze({ STATIC: 'static', PROPAGATED: 'propagated' })

export const ROUTE_MODE = Object.freeze({ STATIC: 'static', PROPAGATED: 'propagated', MIXED: 'mixed' })

// The saved clock that stamps each family's position: 'body' (the time the bodies were last moved), 'fleet' (the fleet's last move), 'contact' (the contact's last update) or 'none' (the place does not move). `motion` is how the family moves: 'fixed', 'orbit' (with its body, when orbital motion is on), 'tied' (carried by a body or not, the save does not say), 'carried' (carried by a body when the save gives it an orbit association: `loadPositionFacts` reads it), 'drift' (no recorded motion) or 'own' (its own motion). `supported: false` marks a family the contract does not vouch for.
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
  'deep-space-population': { clock: 'none', motion: 'drift', supported: false },
  fleet: { clock: 'fleet', motion: 'own' },
  contact: { clock: 'contact', motion: 'own' },
})

export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES))

// Why a position is not known, by condition code.
export const CONDITIONS = Object.freeze({
  'clock-unread': 'the game time and the time the bodies were last moved are not read',
  'clock-inconsistent': 'the position is dated after the game time',
  'motion-switch': 'whether the save has orbital motion on is not recorded',
  'wreck-orbit-tie': 'whether a body carries the wreck is not recorded',
  'waypoint-orbit-unread': 'whether a body carries the waypoint is not recorded',
  'position-unread': 'the position of the place is not recorded',
  'drift-unobserved': 'the save records no motion for a life pod or a deep space population',
  'fleet-state-unread': 'the fleet\'s last move, orbit, anchor and queued orders are not recorded',
  'fleet-orders': 'the fleet has queued orders, so where it will be is not known',
  'fleet-anchored': 'the fleet is anchored to another fleet and moves in formation with it, so where it will be is not known',
  'contact-motion': 'a contact moves on its own and its heading is not known',
  'contact-age-unread': 'the time the contact was last seen is not recorded',
  'stale-contact': 'the contact was last seen before the game time and is not carried forward',
  'cycles-capped': 'the year holds more cycles than the simulation takes, so no yearly figure is worked out and the saved positions stand',
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
  'eccentric-step': 'an eccentric orbit is stepped by 561,600 s, a fitted figure the game does not state, so the position carries an error that grows with the time ahead',
  'family-unknown': 'the kind of place is not one the contract knows',
})

// What each basis holds, by assumption code.
export const ASSUMPTIONS = Object.freeze({
  fixed: 'the place does not move, so its saved position holds at any time',
  'body-held': 'the body moves while the fleet flies; it is held at its saved position, where it stood at the last body update',
  'wreck-held': 'the wreck is held at its saved position; a body may carry it',
  'waypoint-held': 'the waypoint is held at its saved position; a body may carry it',
  unplaced: 'the save records no position for the place, so none is held',
  'drift-held': 'the life pod or deep space population is held at its saved position; its motion is not recorded',
  'fleet-idle': 'the fleet is idle and held where the save has it',
  'fleet-following': 'the fleet orbits a body and moves with it; it is held at its saved position',
  'fleet-held': 'the fleet is held where the save has it now; its later position is not known',
  'contact-held': 'the contact is held where it was last seen; it moves on its own',
  held: 'the place is held where the save has it',
  propagated: 'the position is worked out for the arrival time, continuous in time, while the game moves bodies in steps of days',
  departure: 'the position the save holds at the game time, where the fleet sets out from; its orbit rebuilds to it, and it is not an arrival worked out',
})

const POSITION_VERSIONS = ['2.7.x']

registerRule({
  id: 'route.position',
  versions: POSITION_VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['FCT_Game.GameTime, LastGrowthTime, OrbitalMotion, OrbitalMotionAst', 'FCT_SystemBody.Xcor, Ycor', 'FCT_Fleet.LastMoveTime, OrbitBodyID, Xcor, Ycor', 'FCT_MoveOrders.FleetID', 'FCT_Contacts.LastUpdate'],
  note: 'A figure that rests on the positions the save stores. A body, a colony and a Lagrange point are stored as of the last body update, which trails the game time by up to a few days in the saves examined; the body keeps moving while a fleet flies to it, so a long flight to a body is off by the distance it moves. A fleet with queued orders and a contact have no known later position and none is invented. Places that never move are exact. A figure that takes the adapters (utilities/orbit-propagation.js) moves a supported body on to the arrival time and is propagated; every other figure, and every endpoint the adapters decline, keeps the saved position and says why.',
  assumptions: ['an endpoint is held at the position the save stores unless an adapter moves it on to the arrival time'],
})

registerRule({
  id: 'route.positionAge',
  versions: POSITION_VERSIONS,
  units: 'seconds',
  verification: 'confirmed',
  structure: ['FCT_Game.GameTime, LastGrowthTime', 'FCT_Fleet.LastMoveTime', 'FCT_Contacts.LastUpdate'],
  note: 'The game time less the time the oldest position of the route was stored: for a body, a colony or a Lagrange point the time of the last body update, for a fleet its last move, for a contact its last update. Subtraction of saved times.',
})

const isTime = (value) => typeof value === 'number' && Number.isFinite(value)

const isPosition = (endpoint) => Number.isFinite(endpoint.Xcor) && Number.isFinite(endpoint.Ycor)

const switchOf = (value) => (value === 1 || value === true ? true : value === 0 || value === false ? false : null)

// ---- Endpoints --------------------------------------------------------------------------------------------------------
// An endpoint is { family, key, id, name, SystemID, Xcor, Ycor } with `group` (a body's picker group) and `lastUpdate` (a contact's last update) where the page has them. These build one from what each page holds.
const KIND_FAMILY = Object.freeze({ colony: 'colony', system: 'system', fleet: 'fleet', jump: 'jump-point', lagrange: 'lagrange-point', body: 'body', survey: 'survey-location', waypoint: 'waypoint', wreck: 'wreck', lifepod: 'lifepod', contact: 'contact', aether: 'aether-gate' })

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
export const ADAPTERS = Object.freeze({ body: orbitAdapter, colony: orbitAdapter, 'lagrange-point': orbitAdapter })

export const NO_ADAPTERS = Object.freeze({})

// The basis a family takes at the gate: propagated only with an adapter registered for it.
export const familyBasis = (family, adapters = NO_ADAPTERS) => (typeof adapters[family] === 'function' ? POSITION_BASIS.PROPAGATED : POSITION_BASIS.STATIC)

// Whether the body clock is read: the game time and the time the bodies were last moved.
const bodyClockOf = (facts) => {
  const clock = facts && facts.clock

  return clock && isTime(clock.gameTime) && isTime(clock.lastGrowthTime) ? clock : null
}

// The families that stand on a body, so whose motion follows the body's kind, and the picker groups that name a body that is not an asteroid or a trojan (class 3 cannot tell the two apart).
const BODY_FAMILIES = Object.freeze(['body', 'colony', 'lagrange-point'])

const NON_ASTEROID_GROUPS = Object.freeze(['planet', 'moon', 'comet'])

// The motion group a loader read (`motionOf`); facts that carry none have not read it.
const kindGroup = (group) => (['planet', 'asteroid', 'static'].includes(group) ? group : 'unknown')

// Whether the endpoint moves with the bodies, by the game's orbital motion switches and the motion group of the body it stands on (`motionOf` of utilities/orbit-propagation.js, the game's own update order): nothing moves when the planet and moon switch is off; a 'planet' (a planet, moon, comet, or a trojan, fixed body or waypoint of one) follows that switch; an 'asteroid' (an independent asteroid, or what follows one) also needs its own switch on and is held where the save stores it when that switch reads off; a 'static' body (a fixed body with no parent) never moves; and an 'unknown' one needs both. A switch read as 0 is known to be off and a switch never read is unknown. The group comes from the body's own saved fields when the orbit read holds the body, an order or a colony included, from the loader's read of the owner for a waypoint or a fleet, and from the picker only when it names a planet, moon or comet (class 3 cannot tell an independent asteroid, a trojan and a fixed body apart, so a body, colony or Lagrange point whose body the orbit read lacks is a kind not read). Whether the app can propagate the endpoint is the adapter's question, not this one: a moving endpoint it refuses stays moving, with its reason. A switch the save does not record leaves it unknown unless the other already settles it.
const orbitMotion = (endpoint, facts, conditions) => {
  const clock = facts && facts.clock
  const planets = switchOf(clock && clock.orbitalMotion)
  const rocks = switchOf(clock && clock.orbitalMotionAst)
  const group = groupOf(facts && facts.orbits, endpoint) || (BODY_FAMILIES.includes(endpoint.family) && !NON_ASTEROID_GROUPS.includes(endpoint.group) ? 'unknown' : endpoint.group)
  const both = planets === true && rocks === true ? true : null
  const moves = planets === false || group === 'static' ? false : group === 'asteroid' ? (rocks === false ? false : both) : group === 'unknown' ? both : planets

  if (moves === null && clock) {
    conditions.push('motion-switch')
  }

  return moves
}

// What the saved facts say of a fleet endpoint: { clock, observedAt, moves, assumption, conditions }. A fleet with queued orders or anchored to another fleet may move, so where it will be is not known.
const fleetState = (endpoint, facts, conditions) => {
  const found = facts && facts.fleets ? facts.fleets[endpoint.id] : null

  if (!found || found.following === null || found.following === undefined || found.orders === null || found.orders === undefined || found.anchor === null || found.anchor === undefined) {
    conditions.push('fleet-state-unread')

    return { clock: 'fleet', observedAt: found && isTime(found.lastMoveTime) ? found.lastMoveTime : null, moves: null, assumption: 'fleet-held' }
  }

  const mayMove = found.orders > 0 || found.anchor > 0

  if (found.orders > 0) {
    conditions.push('fleet-orders')
  }

  if (found.anchor > 0) {
    conditions.push('fleet-anchored')
  }

  if (found.following) {
    return { clock: 'body', observedAt: bodyClockOf(facts) ? facts.clock.lastGrowthTime : null, moves: mayMove ? null : orbitMotion({ group: kindGroup(found.group) }, facts, conditions), assumption: mayMove ? 'fleet-held' : 'fleet-following' }
  }

  if (!isTime(found.lastMoveTime)) {
    conditions.push('fleet-state-unread')
  }

  return { clock: 'fleet', observedAt: isTime(found.lastMoveTime) ? found.lastMoveTime : null, moves: mayMove ? null : isTime(found.lastMoveTime) ? false : null, assumption: mayMove ? 'fleet-held' : 'fleet-idle' }
}

// What the saved facts say of a waypoint: one with no orbit association stays where it is, one carried by a body moves with it (an asteroid's switch applies when the body is one, or is not read), and one whose association is not read is unknown.
const waypointState = (endpoint, facts, conditions) => {
  const found = facts && facts.waypoints ? facts.waypoints[endpoint.id] : null

  if (!found || !Number.isInteger(found.orbit)) {
    conditions.push('waypoint-orbit-unread')

    return { clock: 'body', observedAt: bodyClockOf(facts) ? facts.clock.lastGrowthTime : null, moves: null, assumption: 'waypoint-held' }
  } else if (found.orbit <= 0) {
    return { clock: 'none', observedAt: null, moves: false, assumption: 'fixed' }
  }

  const clock = bodyClockOf(facts)

  if (!clock) {
    conditions.push('clock-unread')
  }

  const moves = orbitMotion({ group: kindGroup(found.group) }, facts, conditions)

  return { clock: 'body', observedAt: clock ? clock.lastGrowthTime : null, moves, assumption: moves === false ? 'fixed' : 'body-held' }
}

// The static record of an endpoint: the position the save stores and everything the save says about it.
const staticRecord = (endpoint, facts) => {
  const spec = FAMILIES[endpoint.family]
  const conditions = []
  let state = { clock: spec ? spec.clock : 'none', observedAt: null, moves: false, assumption: 'fixed' }

  if (!spec) {
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

    state = { clock: 'body', observedAt: clock ? clock.lastGrowthTime : null, moves, assumption: spec.motion === 'tied' ? 'wreck-held' : moves === false ? 'fixed' : 'body-held' }
  } else if (spec.motion === 'drift') {
    conditions.push('drift-unobserved')
    state = { clock: 'none', observedAt: null, moves: null, assumption: 'drift-held' }
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

  const supported = Boolean(spec) && spec.supported !== false && !conditions.includes('stale-contact')

  return { state, conditions, age, supported }
}

// The record of one endpoint at the time `at` (null: the departure at the game time, which the static basis uses for every endpoint), reached from `from` ({ Xcor, Ycor }) at `speed` (km/s) when the arrival is to be worked out. `facts` is `loadPositionFacts`' read (with `orbits`, `loadOrbitFacts`'), null while it is not in, in which case the age and the state of a moving endpoint are unknown. `adapters` is where propagation plugs in; with none (the default) the record is the static one.
export const positionRecord = (endpoint, { facts = null, adapters = NO_ADAPTERS, at = null, from = null, speed = null } = {}) => {
  const { state, conditions, age, supported } = staticRecord(endpoint, facts)
  const identity = Object.freeze({ family: endpoint.family, key: endpoint.key === undefined ? `${endpoint.family}:${endpoint.id}` : endpoint.key, id: endpoint.id === undefined ? null : endpoint.id, name: endpoint.name === undefined ? null : endpoint.name })
  const position = isPosition(endpoint) ? Object.freeze({ SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }) : null
  const base = { identity, family: endpoint.family, position, basis: POSITION_BASIS.STATIC, clock: state.clock, observedAt: state.observedAt, age, moves: state.moves, supported, conditions: [...new Set(conditions)], assumption: state.assumption }

  if (familyBasis(endpoint.family, adapters) === POSITION_BASIS.PROPAGATED) {
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
    if (base.moves === false) {
      return Object.freeze({ ...base, unknown: base.conditions.length > 0 })
    }

    const kept = [...new Set([...base.conditions, 'propagation-unavailable', ...(found && Array.isArray(found.reasons) ? found.reasons : [])])]

    return Object.freeze({ ...base, conditions: kept, unknown: true })
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
      const fellBack = kept.basis === POSITION_BASIS.PROPAGATED && record.basis !== POSITION_BASIS.PROPAGATED

      if (fellBack) {
        byKey.set(key, Object.freeze({ ...record, conditions, unknown: true }))
      } else if (conditions.length > kept.conditions.length) {
        byKey.set(key, Object.freeze({ ...kept, conditions, unknown: true }))
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
    missing: Object.freeze(codes.map((code) => CONDITIONS[code])),
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
    const key = [record.assumption, record.conditions.join(','), record.supported].join('|')

    if (!groups.has(key)) {
      groups.set(key, { key, assumption: record.assumption, text: ASSUMPTIONS[record.assumption], names: [], count: 0, ages: [], conditions: record.conditions.map((code) => ({ code, text: CONDITIONS[code] })), supported: record.supported })
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

// The motion group (`motionOf` of utilities/orbit-propagation.js) of each body the IDs name, from the saved fields of the body and of the bodies the game's position update follows from it (a trojan's parent, a fixed body's fixed parent): 'planet', 'asteroid', 'static', or 'unknown' for a body the save does not hold and for one whose class, trojan angle, fixed flag or parent association was not read. A column the save lacks reads as not read, never as 0.
const BODY_MOTION_ROUNDS = 5

const loadBodyGroups = async (database, body, GameID, ids) => {
  const wanted = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  const groups = {}

  if (!wanted.length) {
    return groups
  }

  const known = {}
  const stored = (name, value) => (body.has(name) ? Number(value || 0) : null)
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
  })

  return groups
}

// The facts positions rest on: `clock` { gameTime, lastGrowthTime, orbitalMotion, orbitalMotionAst } of the game (a column the save lacks is null, never 0), `fleets`, by FleetID, of the race's own fleets: { lastMoveTime, following (orbiting a body at exactly the body's coordinates: true, false, or null when the save does not say), orders (queued move orders, null when the save does not say), anchor (the fleet it is anchored to, 0 for none, null when the save does not say) } and `waypoints`, by WaypointID, of the race's own waypoints: { orbit (the body that carries it, 0 for none, null when the save does not say), asteroid (whether that body is an asteroid: true, false, or null when it is not read) }. `problems` names what the save lacks.
export const loadPositionFacts = async (database, { GameID, RaceID }) => {
  const [game, fleet, orders, body, waypoint] = await Promise.all(['FCT_Game', 'FCT_Fleet', 'FCT_MoveOrders', 'FCT_SystemBody', 'FCT_Waypoint'].map((table) => columnsOf(database, table)))
  const problems = []
  const gameColumn = (name) => (game.has(name) ? `FCT_Game.${name}` : 'null')
  let clock = { gameTime: null, lastGrowthTime: null, orbitalMotion: null, orbitalMotionAst: null }

  if (game.has('GameID')) {
    const [[row]] = await database.query(`select ${gameColumn('GameTime')} as GameTime, ${gameColumn('LastGrowthTime')} as LastGrowthTime, ${gameColumn('OrbitalMotion')} as OrbitalMotion, ${gameColumn('OrbitalMotionAst')} as OrbitalMotionAst from FCT_Game where FCT_Game.GameID = :GameID`, { replacements: { GameID } })

    if (row) {
      clock = { gameTime: timeOrNull(row.GameTime), lastGrowthTime: timeOrNull(row.LastGrowthTime), orbitalMotion: row.OrbitalMotion === undefined ? null : row.OrbitalMotion, orbitalMotionAst: row.OrbitalMotionAst === undefined ? null : row.OrbitalMotionAst }
    }
  }

  if (clock.gameTime === null || clock.lastGrowthTime === null) {
    problems.push(`FCT_Game has no ${clock.gameTime === null ? 'GameTime' : 'LastGrowthTime'} in this save`)
  }

  const fleets = {}

  if (['FleetID', 'GameID', 'RaceID'].every((name) => fleet.has(name))) {
    const orbits = ['OrbitBodyID', 'Xcor', 'Ycor'].every((name) => fleet.has(name)) && ['SystemBodyID', 'Xcor', 'Ycor'].every((name) => body.has(name))
    const following = orbits ? 'case when FCT_Fleet.OrbitBodyID is null or FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null then null when FCT_Fleet.OrbitBodyID > 0 and exists (select 1 from FCT_SystemBody where FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBody.Xcor = FCT_Fleet.Xcor and FCT_SystemBody.Ycor = FCT_Fleet.Ycor) then 1 when FCT_Fleet.OrbitBodyID > 0 and exists (select 1 from FCT_SystemBody where FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and (FCT_SystemBody.Xcor is null or FCT_SystemBody.Ycor is null)) then null else 0 end' : 'null'
    const queued = ['FleetID', 'GameID'].every((name) => orders.has(name)) ? '(select count(*) from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = FCT_Fleet.GameID)' : 'null'
    const [rows] = await database.query(`select FCT_Fleet.FleetID, ${fleet.has('LastMoveTime') ? 'FCT_Fleet.LastMoveTime' : 'null'} as LastMoveTime, ${following} as Following, ${fleet.has('OrbitBodyID') ? 'FCT_Fleet.OrbitBodyID' : 'null'} as OrbitBody, ${queued} as Orders, ${fleet.has('AnchorFleetID') ? 'FCT_Fleet.AnchorFleetID' : 'null'} as Anchor from FCT_Fleet where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID`, { replacements: { GameID, RaceID } })

    const fleetGroups = await loadBodyGroups(database, body, GameID, rows.map((row) => row.OrbitBody))

    rows.forEach((row) => {
      fleets[row.FleetID] = Object.freeze({ lastMoveTime: timeOrNull(row.LastMoveTime), following: row.Following === null || row.Following === undefined ? null : Number(row.Following) === 1, group: fleetGroups[row.OrbitBody] || null, orders: row.Orders === null || row.Orders === undefined ? null : Number(row.Orders), anchor: row.Anchor === null || row.Anchor === undefined ? null : Number(row.Anchor) })
    })
  } else {
    problems.push('FCT_Fleet has no FleetID, GameID or RaceID in this save, so no fleet position could be read')
  }

  const waypoints = {}

  if (['WaypointID', 'GameID', 'RaceID', 'OrbitBodyID'].every((name) => waypoint.has(name))) {
    const [rows] = await database.query('select FCT_Waypoint.WaypointID, FCT_Waypoint.OrbitBodyID as Orbit from FCT_Waypoint where FCT_Waypoint.GameID = :GameID and FCT_Waypoint.RaceID = :RaceID', { replacements: { GameID, RaceID } })

    const owners = await loadBodyGroups(database, body, GameID, rows.map((row) => row.Orbit))

    rows.forEach((row) => {
      waypoints[row.WaypointID] = Object.freeze({ orbit: row.Orbit === null || row.Orbit === undefined ? null : Number(row.Orbit), group: owners[row.Orbit] || null })
    })
  } else {
    problems.push('FCT_Waypoint has no WaypointID, GameID, RaceID or OrbitBodyID in this save, so whether a body carries a waypoint could not be read')
  }

  return Object.freeze({ clock: Object.freeze(clock), fleets: Object.freeze(fleets), waypoints: Object.freeze(waypoints), problems: Object.freeze(problems) })
}
