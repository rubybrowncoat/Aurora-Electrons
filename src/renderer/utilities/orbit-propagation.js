// Saved body and point coordinates are the baseline at GameTime, not the construction-cycle LastGrowthTime. Snapshots advance to the requested time; movement sees the pulse-opening update in sub-pulse mode, or the preceding increment update in after-movement mode. Eccentric horizons must remain below one orbit and within MAX_CALLS. Every refusal keeps the saved position with its reason.
//
// The rules are those of the game's own orbit update, as the saves reproduce them: a body at bearing B on an orbit of semi-major axis a (AU, or km for a moon) lies at the coordinate angle B - 90 degrees; an eccentric body's ellipse centre is offset a x e from its star along EccentricityDirection and the coordinate angle is turned by the same direction; one call of the update with `deltaSeconds` lowers a circular body's and a moon's bearing by 360 x deltaSeconds / (Year x 3600) and an eccentric body's by that times current / mean, `mean = sqrt(2 / a - 1 / a)` and `current = sqrt(2 / r - 1 / a)` at the distance r from the star that the body has when the call begins, so an eccentric position is one call after another and no Kepler solve; a moon is at its parent's position and a trojan has its parent's bearing plus its own offset; a Lagrange point is at its body's bearing plus 60 degrees. Nothing moves with the planet and moon switch (`FCT_Game.OrbitalMotion`) off, and there is no asteroid switch: `OrbitalMotionAst` is stored and read by no part of the update, which selects every non-fixed independent asteroid.
//
// Future cadence is estimated from SubPulseLength when OrbitalMovementInSubPulse is 1, otherwise the latest FCT_Increments.Length. The game advances the clock, updates sub-pulse orbits, then processes movement; after-increment orbits update only after movement ends. Thus movement in (t0 + (n-1)L, t0 + nL] sees call n in sub-pulse mode and call n-1 in increment mode. A no-movement snapshot instead advances circular and moon-own bearings for the entire elapsed time, and an eccentric bearing by whole calls then one final remainder call. That local partial call never enters the whole-call cache. Exactly t0 remains saved. Every eccentric call recalculates current/mean and counts against MAX_CALLS; no coarser substitute is used. Prediction assumes no future forced load/edit updates: loading can force 60 seconds of orbital advance without advancing GameTime, but saved coordinates remain the baseline and no load history is inferred here.

import { KM_PER_AU } from './jump-graph'
import { inputWords } from './provenance'
import { derive } from './query-cache'

// A fleet's arrival is solved to this many seconds and in at most this many evaluations of the body's position, as the bounded fixed point the saves converged in (at most four evaluations to one second in 3,000 body legs at 5,000 km/s).
export const ARRIVAL_TOLERANCE_SECONDS = 1
export const ARRIVAL_MAX_EVALUATIONS = 8

// A rebuilt position more than this far from the saved one is not trusted.
export const REBUILD_TOLERANCE_KM = 1

// The maximum update calls computed for one eccentric body over the requested horizon, including a snapshot's final partial call. Longer horizons are refused, never silently advanced at a different cadence.
export const MAX_CALLS = 100000

const MAX_PARENTS = 4

// Why a position is not propagated, by condition code (the texts are utilities/route-position.js `CONDITIONS`). A route states each one it fell back on.
export const REASONS = Object.freeze(['clock-unread', 'clock-inconsistent', 'motion-switch', 'motion-classification', 'cadence-unread', 'cadence-budget', 'orbit-unread', 'orbit-unsurveyed', 'orbit-missing', 'orbit-mismatch', 'orbit-family', 'orbit-star', 'orbit-horizon', 'anchor-unread', 'visitor-association-unread', 'arrival-diverged', 'fleet-immobile', 'fleet-slower', 'speed-unknown', 'cycles-capped'])

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// A game switch as a flag: true for 1 or true, false for 0 or false, null for a value that was not read.
export const switchOf = (value) => (value === 1 || value === true ? true : value === 0 || value === false ? false : null)

// The length of one call of the game's orbit update, seconds, from the save's clock: one sub-pulse when the save moves bodies in each sub-pulse (`orbitalMovementInSubPulse` 1, the sub-pulse length the save holds), one increment when it moves them after the movement of an increment (0, the length of the latest increment the save holds), and null when the option or its length is not read. Later increments may be of another length: that is the assumption of the 'eccentric-cadence' condition.
export const callLength = (clock) => {
  const perPulse = switchOf(clock.orbitalMovementInSubPulse)
  const seconds = perPulse === null ? null : perPulse ? clock.subPulseLength : clock.incrementLength

  return isNumber(seconds) && seconds > 0 ? seconds : null
}

const radians = (degrees) => (degrees * Math.PI) / 180

const wrap = (bearing) => ((bearing % 360) + 360) % 360

// One error per code, made once: a route that falls back throws it at every cycle, and an error's stack is costly to make.
const RAISED = new Map()

const unsupported = (code) => {
  if (!RAISED.has(code)) {
    RAISED.set(code, Object.assign(new Error(code), { code, unsupported: true }))
  }

  return RAISED.get(code)
}

// ---- Geometry ---------------------------------------------------------------------------------------------------------
// The point of a body on its orbit at `bearing` around `centre` ({ Xcor, Ycor }), in km. `body` is { distance (AU), eccentricity, direction (degrees) }; a circular body ignores the direction.
const orbitPoint = (body, bearing, centre) => {
  const eccentricity = body.eccentricity || 0
  const a = body.distance

  if (!eccentricity) {
    const angle = radians(bearing - 90)

    return { Xcor: centre.Xcor + a * KM_PER_AU * Math.cos(angle), Ycor: centre.Ycor + a * KM_PER_AU * Math.sin(angle) }
  }

  const b = a * Math.sqrt(1 - eccentricity * eccentricity)
  const theta = radians(450 - bearing)
  const radius = (a * b) / Math.sqrt((b * Math.cos(theta)) ** 2 + (a * Math.sin(theta)) ** 2)
  const rotation = radians(body.direction || 0)
  const angle = radians(bearing - 90) + rotation

  return { Xcor: centre.Xcor + (a * eccentricity * Math.cos(rotation) + radius * Math.cos(angle)) * KM_PER_AU, Ycor: centre.Ycor + (a * eccentricity * Math.sin(rotation) + radius * Math.sin(angle)) * KM_PER_AU }
}

// A moon's point: a circle of its km radius around its parent.
const moonPoint = (radiusKm, bearing, parent) => {
  const angle = radians(bearing - 90)

  return { Xcor: parent.Xcor + radiusKm * Math.cos(angle), Ycor: parent.Ycor + radiusKm * Math.sin(angle) }
}

// ---- The families -----------------------------------------------------------------------------------------------------
// The family of a body as the saved fields tell it: 'moon', 'trojan', 'eccentric' (a planet, comet or asteroid with an eccentricity), 'circular' (an independent asteroid with none). A fixed body, a circular planet or comet and anything else is not a family that is propagated.
export const familyOf = (body) => {
  if (body.fixed > 0) {
    return null
  } else if (body.bodyClass === 2 && body.parentId > 0) {
    return 'moon'
  } else if (isNumber(body.trojan) && body.trojan !== 0 && body.parentId > 0) {
    return 'trojan'
  } else if ([1, 3, 5].includes(body.bodyClass) && body.eccentricity) {
    return 'eccentric'
  } else if (body.bodyClass === 3) {
    return 'circular'
  }

  return null
}

// ---- The motion group --------------------------------------------------------------------------------------------------
// How the game's position update moves a body, as it orders the work: the bodies of the primary list move by their own orbit (a planet or comet, and an asteroid that is no trojan, all under the one planet and moon switch; a body held fixed is left out), then every moon (on the same switch, whatever it orbits), then every trojan (at its parent's bearing, so as the parent moves), then every Lagrange point (at its planet's), and last every fixed body that has a fixed parent takes the position of that parent, with the fleets and waypoints tied to a body after it. Nothing moves with that switch off, and no other switch gates a body. So the group is: 'moving' (follows the switch), 'static' (a fixed body with no parent, which nothing moves) or 'unknown' (a field the group rests on was not read). A fixed body with a parent, and a trojan, are the group of that parent. `bodies` holds each body's { bodyClass, trojan, parentId, fixed, fixedParentId } by ID, a field not read being null or absent. This is the motion of a body, not whether the app can propagate it: `familyOf` decides that, and a fixed body it does not support is refused with its reason, never taken for one that stays.
export const motionOf = (bodies, id, depth = 0) => {
  const body = bodies[id]

  if (!body || depth > MAX_PARENTS || !isNumber(body.bodyClass) || !isNumber(body.fixed)) {
    return 'unknown'
  }

  const fixed = isNumber(body.fixed) && body.fixed > 0

  if (fixed && !isNumber(body.fixedParentId)) {
    return 'unknown'
  } else if (fixed && body.fixedParentId > 0) {
    return motionOf(bodies, body.fixedParentId, depth + 1)
  } else if (body.bodyClass === 1 || body.bodyClass === 5) {
    return fixed ? 'static' : 'moving'
  } else if (body.bodyClass === 2) {
    return 'moving'
  } else if (body.bodyClass !== 3 || !isNumber(body.trojan)) {
    return 'unknown'
  } else if (body.trojan !== 0 && !isNumber(body.parentId)) {
    return 'unknown'
  } else if (body.trojan !== 0 && body.parentId > 0) {
    return motionOf(bodies, body.parentId, depth + 1)
  }

  return fixed ? 'static' : 'moving'
}

const bodyOf = (orbits, id, depth = 0) => {
  const body = orbits.bodies[id]

  if (!body) {
    throw unsupported(orbits.hidden && orbits.hidden[id] !== undefined ? 'orbit-unsurveyed' : 'orbit-missing')
  } else if (depth > MAX_PARENTS) {
    throw unsupported('orbit-family')
  }

  return body
}

const starOf = (orbits, body) => {
  const star = orbits.stars[body.starId]

  if (!star || !isNumber(star.xcor) || !isNumber(star.ycor)) {
    throw unsupported('orbit-missing')
  } else if (star.component !== 1) {
    throw unsupported('orbit-star')
  }

  return { Xcor: star.xcor, Ycor: star.ycor }
}

// One call of the game's orbit update on an eccentric body that is at `bearing`: the bearing falls by 360 x deltaSeconds / (Year x 3600) at the ratio of the current speed (`sqrt(2 / r - 1 / a)`, r being the body's distance from its star now) to the mean speed (`sqrt(2 / a - 1 / a)`), the way the game does it. The ratio is the one at the start of the call, so a longer call is a coarser one.
const advance = (body, star, bearing, deltaSeconds) => {
  const here = orbitPoint(body, bearing, star)
  const distance = Math.hypot(here.Xcor - star.Xcor, here.Ycor - star.Ycor) / KM_PER_AU
  const mean = Math.sqrt(2 / body.distance - 1 / body.distance)
  const current = Math.sqrt(Math.max(0, 2 / distance - 1 / body.distance))
  const turn = (deltaSeconds / (body.year * 3600)) * (current / mean)

  const next = bearing - turn * 360

  return next < 0 ? wrap(next) : next
}

// The bearings of an eccentric body after 0, 1, 2 ... whole calls of the update of `length` seconds each from the last body update, kept per orbit read, body and call length and worked out as they are asked for: a route works out the same body at many times. Each entry is the previous one after one more call, as the game works it out.
const CALLS = new WeakMap()

const callsOf = (orbits, body, length) => {
  const tables = CALLS.get(orbits) || CALLS.set(orbits, new Map()).get(orbits)
  const key = `${body.id}:${length}`

  if (!tables.has(key)) {
    tables.set(key, [body.bearing])
  }

  return tables.get(key)
}

// The state of a body `elapsed` seconds after the saved epoch: { Xcor, Ycor, bearing, advanced }. Snapshots reach the full elapsed time; `movement` selects whole calls in the move-order phase, including the pre-update side of an exact increment boundary. `advanced` marks an eccentric orbit whose estimate rests on the saved call length. A body whose orbit is not moving stays saved; an eccentric body past one orbit is not worked out (`horizon: false` lifts that for rebuilds).
const stateAt = (orbits, clock, id, elapsed, { horizon = true, depth = 0, movement = false } = {}) => {
  const body = bodyOf(orbits, id, depth)
  const family = familyOf(body)

  if (!family) {
    throw unsupported('orbit-family')
  } else if (!isNumber(body.bearing) || !isNumber(body.distance) || !isNumber(body.year) || body.year <= 0 || (family !== 'moon' && !isNumber(body.eccentricity)) || (family !== 'moon' && body.eccentricity && !isNumber(body.direction))) {
    throw unsupported('orbit-missing')
  } else if (elapsed < 0) {
    throw unsupported('clock-inconsistent')
  }

  const planets = switchOf(clock.orbitalMotion)

  if (planets === null) {
    throw unsupported('motion-switch')
  }

  const length = callLength(clock)

  if (planets && elapsed > 0 && length === null && (movement || family === 'eccentric')) {
    throw unsupported('cadence-unread')
  }

  const count = elapsed / (length || 1)
  const whole = !planets ? 0 : movement && elapsed > 0 ? switchOf(clock.orbitalMovementInSubPulse) ? Math.ceil(count) : Math.ceil(count) - 1 : Math.floor(count)
  const seconds = !planets ? 0 : movement ? whole * (length || 1) : elapsed
  const remainder = !planets || movement ? 0 : elapsed - whole * (length || 1)
  const year = body.year * 3600
  let advanced = false
  let bearing = body.bearing
  let parent = null

  if (family === 'circular') {
    bearing = wrap(body.bearing - (360 * seconds) / year)
  } else if (family === 'moon') {
    parent = stateAt(orbits, clock, body.parentId, elapsed, { horizon, depth: depth + 1, movement })
    advanced = parent.advanced
    bearing = wrap(body.bearing - (360 * seconds) / year)
  } else if (family === 'trojan') {
    parent = stateAt(orbits, clock, body.parentId, elapsed, { horizon, depth: depth + 1, movement })
    advanced = parent.advanced
    bearing = planets ? wrap(parent.bearing + body.trojan) : body.bearing
  } else if (planets && elapsed > 0) {
    if (horizon && elapsed >= year) {
      throw unsupported('orbit-horizon')
    }

    const evaluations = whole + (remainder > 0 ? 1 : 0)

    if (evaluations > MAX_CALLS) {
      const needs = remainder > 0 ? `${whole} calls of ${length} s and a final call of ${remainder} s, ${evaluations} evaluations` : `${evaluations} calls of ${length} s`

      throw Object.assign(new Error('cadence-budget'), { code: 'cadence-budget', unsupported: true, details: [`the horizon needs ${needs} against a budget of ${MAX_CALLS}`] })
    }

    const star = starOf(orbits, body)
    const call = length
    const calls = callsOf(orbits, body, call)

    while (calls.length <= whole) {
      calls.push(advance(body, star, calls[calls.length - 1], call))
    }

    advanced = true
    bearing = calls[whole]

    if (remainder > 0) {
      bearing = advance(body, star, bearing, remainder)
    }
  }

  const point = family === 'moon' ? moonPoint(body.distance, bearing, parent) : orbitPoint(body, bearing, starOf(orbits, body))

  return { ...point, bearing, advanced, family }
}

// The classes of the body a Lagrange point rides: the game's coordinate update of a point sets its position only for a planet (1) and a moon (2), so a point owned by any other class is never moved and stays where it is saved.
export const POINT_OWNER_CLASSES = Object.freeze([1, 2])

// The state of a Lagrange point: its body's bearing plus 60 degrees, on the body's own orbit (a planet's eccentric one at the point's distance, a moon's circle of the point's distance in AU converted to km).
const pointStateAt = (orbits, clock, point, elapsed, options = {}) => {
  const body = bodyOf(orbits, point.planetId)

  if (!isNumber(body.bodyClass)) {
    throw unsupported('motion-classification')
  } else if (!POINT_OWNER_CLASSES.includes(body.bodyClass)) {
    if (!isNumber(point.xcor) || !isNumber(point.ycor)) {
      throw unsupported('orbit-missing')
    } else if (elapsed < 0) {
      throw unsupported('clock-inconsistent')
    } else if (switchOf(clock.orbitalMotion) === null) {
      throw unsupported('motion-switch')
    } else if (switchOf(clock.orbitalMotion) && elapsed > 0 && options.movement && callLength(clock) === null) {
      throw unsupported('cadence-unread')
    }

    // The owner class leaves the point fixed, but the following objects still snap to these coordinates on an orbital update.
    return { Xcor: point.xcor, Ycor: point.ycor, advanced: false, family: 'static' }
  }

  const state = stateAt(orbits, clock, point.planetId, elapsed, options)
  const bearing = wrap(state.bearing + 60)

  if (!isNumber(point.distance)) {
    throw unsupported('orbit-missing')
  }

  const there = state.family === 'moon' ? moonPoint(point.distance * KM_PER_AU, bearing, stateAt(orbits, clock, body.parentId, elapsed, options)) : orbitPoint({ distance: point.distance, eccentricity: body.eccentricity, direction: body.direction }, bearing, starOf(orbits, body))

  return { ...there, bearing, advanced: state.advanced, family: state.family }
}

// What an endpoint names in the orbit read: the point of a Lagrange point, the body of a body or of a colony (`bodyOf` maps the race's colonies to their bodies).
// The motion group (`motionOf`) of the body an endpoint stands on or is, from the body's own fields and those of its parents, null when the orbit read does not hold the body or the endpoint is not on one. A Lagrange point rides the body it belongs to, and is 'static' when that body is neither a planet nor a moon.
export const groupOf = (orbits, endpoint) => {
  if (!orbits || !orbits.bodies || (endpoint.family !== 'body' && endpoint.family !== 'colony' && endpoint.family !== 'lagrange-point')) {
    return null
  }

  const id = endpoint.family === 'colony' ? (orbits.bodyOf || {})[endpoint.id] : endpoint.family === 'lagrange-point' ? ((orbits.points || {})[endpoint.id] || {}).planetId : endpoint.id
  const body = Number.isInteger(id) ? orbits.bodies[id] : null

  if (body && endpoint.family === 'lagrange-point' && isNumber(body.bodyClass) && !POINT_OWNER_CLASSES.includes(body.bodyClass)) {
    return 'static'
  }

  return body ? motionOf(orbits.bodies, id) : null
}

const resolve = (orbits, endpoint) => {
  if (endpoint.family === 'lagrange-point') {
    const point = orbits.points[endpoint.id]

    if (!point) {
      throw unsupported(orbits.hiddenPoints && orbits.hiddenPoints[endpoint.id] !== undefined ? 'orbit-unsurveyed' : 'orbit-missing')
    }

    return { point }
  }

  const id = endpoint.family === 'colony' ? orbits.bodyOf[endpoint.id] : endpoint.id

  if (!Number.isInteger(id)) {
    throw unsupported('orbit-missing')
  }

  return { id }
}

const stateOfTarget = (orbits, clock, target, elapsed, options) => (target.point ? pointStateAt(orbits, clock, target.point, elapsed, options) : stateAt(orbits, clock, target.id, elapsed, options))

const verified = new WeakMap()

// Whether the orbit fields rebuild the saved position, to within `REBUILD_TOLERANCE_KM`: a body is checked with its parents and a Lagrange point with its body. A rebuild that misses is a save whose orbit fields do not agree with its own coordinates and is not propagated.
const verify = (orbits, clock, target) => {
  const key = target.point ? `point:${target.point.id}` : `body:${target.id}`

  if (!verified.has(orbits)) {
    verified.set(orbits, new Map())
  }

  const known = verified.get(orbits)

  if (!known.has(key)) {
    const check = (state, saved) => (isNumber(saved.xcor) && isNumber(saved.ycor) && Math.hypot(state.Xcor - saved.xcor, state.Ycor - saved.ycor) <= REBUILD_TOLERANCE_KM ? null : 'orbit-mismatch')
    let outcome = null

    try {
      const rebuilt = (item) => stateAt(orbits, { ...clock, orbitalMotion: 1 }, item.id, 0, { horizon: false })
      const chain = (id, depth = 0) => {
        const body = bodyOf(orbits, id, depth)
        const reasons = [check(rebuilt(body), body)]

        return body.parentId > 0 && ['moon', 'trojan'].includes(familyOf(body)) ? [...reasons, ...chain(body.parentId, depth + 1)] : reasons
      }

      if (target.point) {
        const state = pointStateAt(orbits, { ...clock, orbitalMotion: 1 }, target.point, 0, { horizon: false })

        outcome = state.family === 'static' ? null : [check(state, { xcor: target.point.xcor, ycor: target.point.ycor }), ...chain(target.point.planetId)].find(Boolean) || null
      } else {
        outcome = chain(target.id).find(Boolean) || null
      }
    } catch (error) {
      outcome = error.unsupported ? error.code : 'orbit-missing'
    }

    known.set(key, outcome)
  }

  if (known.get(key)) {
    throw unsupported(known.get(key))
  }
}

// ---- The arrival ------------------------------------------------------------------------------------------------------
// An upper bound of the speed of a body, km/s, over its whole orbit, from its orbit fields and not from positions sampled in time: a circle turns at 2 pi over its year; an eccentric orbit turns at most sqrt((1 + |e|) / (1 - |e|)) times that fast (the saved eccentricity may be negative, which turns the geometry and not the speed), on a path whose speed is at most the turn times a sqrt(1 + (e^2 / (2 (1 - e^2)))^2) (the ellipse's radius and the change of it); a moon adds its parent's bound to its own turn about the parent; a trojan turns at its parent's rate.
const turnBound = (orbits, id, depth = 0) => {
  const body = bodyOf(orbits, id, depth)
  const family = familyOf(body)
  const rate = (2 * Math.PI) / (body.year * 3600)

  if (family === 'trojan') {
    return turnBound(orbits, body.parentId, depth + 1)
  }

  const eccentricity = Math.abs(body.eccentricity)

  return family === 'eccentric' ? rate * Math.sqrt((1 + eccentricity) / (1 - eccentricity)) : rate
}

const pathFactor = (eccentricity) => (eccentricity ? Math.sqrt(1 + (eccentricity ** 2 / (2 * (1 - eccentricity ** 2))) ** 2) : 1)

const speedBound = (orbits, id, depth = 0) => {
  const body = bodyOf(orbits, id, depth)
  const family = familyOf(body)
  const turn = turnBound(orbits, id, depth)

  return family === 'moon' ? turn * body.distance + speedBound(orbits, body.parentId, depth + 1) : turn * body.distance * KM_PER_AU * pathFactor(body.eccentricity)
}

const speedAt = (orbits, target) => {
  if (!target.point) {
    return speedBound(orbits, target.id)
  }

  const body = bodyOf(orbits, target.point.planetId)

  if (!POINT_OWNER_CLASSES.includes(body.bodyClass)) {
    return 0
  }

  const turn = turnBound(orbits, target.point.planetId)

  return familyOf(body) === 'moon' ? turn * target.point.distance * KM_PER_AU + speedBound(orbits, body.parentId, 1) : turn * target.point.distance * KM_PER_AU * pathFactor(body.eccentricity)
}

// The arrival of a fleet flying from `from` ({ Xcor, Ycor }) at `speed` (km/s), leaving at `depart` (game seconds), to a body whose position `positionAt(time)` gives: the fixed point of `T = |position(depart + T) - from| / speed`, started from the body where it is at the departure, to `ARRIVAL_TOLERANCE_SECONDS` in at most `ARRIVAL_MAX_EVALUATIONS` evaluations of the position. `speedOf(time)` is the body's speed (km/s): the search contracts by the body's speed over the fleet's, so a fleet that is not faster than the body has no arrival (`fleet-slower`), and one with no engines (a speed of 1 or less) none either (`fleet-immobile`). Returns { position, seconds, time, km, evaluations } or throws an unsupported error with the code.
export const solveArrival = ({ from, depart, speed, positionAt, speedOf }) => {
  if (!isNumber(speed) || speed <= 0) {
    throw unsupported('speed-unknown')
  } else if (speed <= 1) {
    throw unsupported('fleet-immobile')
  }

  const distance = (position) => Math.hypot(position.Xcor - from.Xcor, position.Ycor - from.Ycor)
  let position = positionAt(depart)
  let evaluations = 1
  let seconds = distance(position) / speed
  const fastest = speedOf(depart)

  if (!(speed > fastest)) {
    throw unsupported('fleet-slower')
  }

  while (evaluations < ARRIVAL_MAX_EVALUATIONS - 1) {
    position = positionAt(depart + seconds)
    evaluations += 1
    const next = distance(position) / speed

    // The fixed point's error after this step is at most L / (1 - L) of the last change, L being the body's speed bound over the fleet's.
    const contraction = fastest / speed

    if ((contraction / (1 - contraction)) * Math.abs(next - seconds) <= ARRIVAL_TOLERANCE_SECONDS) {
      // Whole-call positions jump at boundaries, so the smooth speed bound alone cannot certify an arrival. Check the returned position against its flight time as well.
      const arrived = positionAt(depart + next)

      evaluations += 1

      if (Math.abs(distance(arrived) / speed - next) <= ARRIVAL_TOLERANCE_SECONDS) {
        return { position: { Xcor: arrived.Xcor, Ycor: arrived.Ycor }, seconds: next, time: depart + next, km: distance(arrived), evaluations }
      }
    }

    seconds = next
  }

  throw unsupported('arrival-diverged')
}

const clockOf = (facts) => {
  const clock = facts && facts.clock

  return clock && isNumber(clock.gameTime) ? clock : null
}

// The adapter registered in utilities/route-position.js `ADAPTERS` for the families that sit on a body: a body, a colony and a Lagrange point. `at` is the time the fleet leaves `from` (the game time when null); with `from` the position is where the fleet meets the endpoint (the arrival solve, `observedAt` the arrival time), without it the position at `at` (the saved one at the game time, since the save is what the game holds now). Returns { position, observedAt, conditions } or { reasons: [codes] } when the endpoint is not propagated, naming why; `base` is the static record.
export const orbitAdapter = (endpoint, { facts, at = null, from = null, speed = null, savedUntilUpdate = false }) => {
  const clock = clockOf(facts)
  const orbits = facts && facts.orbits

  if (!clock) {
    return { reasons: ['clock-unread'] }
  } else if (!orbits) {
    return { reasons: ['orbit-unread'] }
  }

  try {
    const target = resolve(orbits, endpoint)

    if (switchOf(clock.orbitalMotion) !== false && groupOf(orbits, endpoint) === 'unknown') {
      throw unsupported('motion-classification')
    }

    verify(orbits, clock, target)

    const depart = isNumber(at) ? at : clock.gameTime
    const saved = { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }
    const positionAt = (time) => {
      const state = stateOfTarget(orbits, clock, target, time - clock.gameTime, { movement: !!from })

      // A displaced follower keeps its own saved coordinates until the first update its phase sees: any positive snapshot elapsed time (including a final partial call), opening sub-pulse for movement, preceding increment for movement. stateOfTarget still validates cadence/orbit before this override.
      const beforeUpdate = savedUntilUpdate && (switchOf(clock.orbitalMotion) === false || (from && switchOf(clock.orbitalMovementInSubPulse) === false ? time <= clock.gameTime + callLength(clock) : time <= clock.gameTime))

      return time === clock.gameTime || beforeUpdate ? { ...state, Xcor: saved.Xcor, Ycor: saved.Ycor } : state
    }
    const speedOf = () => speedAt(orbits, target)

    if (!from) {
      if (depart === clock.gameTime) {
        positionAt(clock.gameTime)

        return { position: saved, observedAt: clock.gameTime, conditions: [], departure: true }
      }

      const state = positionAt(depart)

      return { position: { SystemID: endpoint.SystemID, Xcor: state.Xcor, Ycor: state.Ycor }, observedAt: depart, conditions: state.advanced ? ['eccentric-cadence'] : [] }
    }

    const solved = solveArrival({ from, depart, speed, positionAt, speedOf })
    const advanced = positionAt(solved.time).advanced

    return { position: { SystemID: endpoint.SystemID, ...solved.position }, observedAt: solved.time, conditions: advanced ? ['eccentric-cadence'] : [], solved }
  } catch (error) {
    if (error.unsupported) {
      return { reasons: [error.code], ...(error.details ? { details: error.details } : {}) }
    }

    throw error
  }
}

// ---- The anchor family ------------------------------------------------------------------------------------------------
// The objects the game's position update carries with a Lagrange point (`OrbitLagrangeID`), in the game's order: after a point has moved, a fleet that stands at the point's own position takes it, then a missile salvo, a waypoint, a wreck and a life pod each take the point's position at every call. A displaced non-fleet follower keeps its saved coordinates at the exact saved epoch and until its first update in that order; a snapshot's final partial call counts as an update, while movement retains its whole-call phase. No other table anchors an object to a point (the population carries no such column), a deep space population being the fixed class 3 body it stands on. This is the adapter of those families: an object the position contract found anchored (`base.anchor`, the point it rides, by the identity rule of utilities/route-position.js) follows the point through its own adapter, including every refusal; an object no point carries is not served by it.
export const ANCHOR_FAMILIES = Object.freeze(['fleet', 'waypoint', 'wreck', 'lifepod', 'salvo'])

// The table and key column that hold the point each family is anchored to.
const ANCHOR_TABLES = Object.freeze({ fleet: ['FCT_Fleet', 'FleetID'], waypoint: ['FCT_Waypoint', 'WaypointID'], wreck: ['FCT_Wrecks', 'WreckID'], lifepod: ['FCT_Lifepods', 'LifepodID'], salvo: ['FCT_MissileSalvo', 'MissileSalvoID'] })

// What each kind is called in the text that says a save lacks what the read needs.
const ANCHOR_NOUNS = Object.freeze({ fleet: 'fleets', waypoint: 'waypoints', wreck: 'wrecks', lifepod: 'life pods', salvo: 'missile salvos' })

export const anchorAdapter = (endpoint, { facts, at = null, from = null, speed = null, base = null }) => {
  const anchor = base && base.anchor

  if (!anchor || !Number.isInteger(anchor.point) || anchor.point <= 0) {
    return { reasons: ['anchor-unread'] }
  }

  const point = { family: 'lagrange-point', key: `lagrange:${anchor.point}`, id: anchor.point, name: null, SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }
  const found = orbitAdapter(point, { facts, at, from, speed, savedUntilUpdate: true })

  return found.position ? { ...found, position: { ...found.position, SystemID: endpoint.SystemID } } : found
}

// The adapter serves only an object a point is read to carry (`state.anchor` of its static record): any other object is held by the treatment of its kind whatever adapters a consumer gives, and a consumer asks `serves` before it counts the endpoint as served.
anchorAdapter.serves = (state) => Boolean(state && state.anchor)

// The Lagrange points that the endpoints of the anchor families ride, as { family, lacking, points }: the points the save names for them (`OrbitLagrangeID` above 0), and `lacking` true when the table of the family holds the objects without the column or the key (a save with no such table has no such objects, and says nothing). The orbit read takes these points with the ones the endpoints name, so an anchored object's point has its orbit.
const anchorPointsOf = (database, game, wanted) => {
  const families = [...new Set(wanted.map((endpoint) => endpoint.family).filter((family) => ANCHOR_TABLES[family]))]

  return Promise.all(families.map(async (family) => {
    const [table, key] = ANCHOR_TABLES[family]
    const columns = await columnsOf(database, table)

    if (columns.size === 0) {
      return { family, lacking: false, points: [] }
    } else if (!['GameID', key, 'OrbitLagrangeID'].every((name) => columns.has(name))) {
      return { family, lacking: true, points: [] }
    }

    const rows = await rowsIn(database, `select ${table}.OrbitLagrangeID from ${table} where ${table}.GameID = ${game} and ${table}.OrbitLagrangeID > 0 and ${table}.${key}`, integers(wanted.filter((endpoint) => endpoint.family === family).map((endpoint) => endpoint.id)))

    return { family, lacking: null, points: rows.map((row) => row.OrbitLagrangeID) }
  }))
}

// ---- The read ---------------------------------------------------------------------------------------------------------
const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

const integers = (values) => [...new Set(values.map(Number).filter(Number.isInteger))]

const listOf = (values) => values.join(',')

const chunks = (values, size = 400) => Array.from({ length: Math.ceil(values.length / size) }, (_empty, index) => values.slice(index * size, (index + 1) * size))

const rowsIn = async (database, select, values) => (await Promise.all(chunks(values).map(async (part) => (await database.query(`${select} in (${listOf(part)})`))[0]))).flat()

const numberOrNull = (value) => (isNumber(value) ? value : null)

const BODY_COLUMNS = ['SystemBodyID', 'SystemID', 'StarID', 'GameID', 'BodyClass', 'TrojanAsteroid', 'OrbitalDistance', 'Bearing', 'Year', 'Eccentricity', 'EccentricityDirection', 'ParentBodyID', 'ParentBodyType', 'FixedBody', 'Xcor', 'Ycor']

// The orbit fields of what the endpoints name: `bodies` by SystemBodyID (the body each endpoint stands on, its parents and its Lagrange points' bodies), `stars` by StarID, `points` by LagrangePointID, `bodyOf` (the body of each colony, by PopulationID), `hidden` (the systems of named bodies the race has not surveyed, by SystemBodyID) and `hiddenPoints` likewise. Only bodies and Lagrange points of systems the race has surveyed (`FCT_RaceSysSurvey`) have their orbit fields read: the save holds the coordinates of every system, and those of the others are not the race's to use. `problems` names what the save lacks. Kept per save, game and race with the endpoints that were asked for (utilities/query-cache.js `derive`).
export const loadOrbitFacts = (database, { GameID, RaceID }, endpoints) => {
  const wanted = endpoints.filter(Boolean)
  const key = JSON.stringify(wanted.map((endpoint) => [endpoint.family, endpoint.id]).sort())

  return derive(database, 'orbit-facts', [GameID, RaceID, key], async () => {
    const [bodyColumns, pointColumns, populationColumns, starColumns, surveyColumns] = await Promise.all(['FCT_SystemBody', 'FCT_LagrangePoint', 'FCT_Population', 'FCT_Star', 'FCT_RaceSysSurvey'].map((table) => columnsOf(database, table)))
    const problems = []
    const game = Number(GameID)
    const race = Number(RaceID)
    const missing = (columns, have) => columns.filter((name) => !have.has(name))
    const lacking = [['FCT_SystemBody', BODY_COLUMNS, bodyColumns], ['FCT_Star', ['StarID', 'ComponentNumber', 'Xcor', 'Ycor'], starColumns], ['FCT_RaceSysSurvey', ['SystemID', 'GameID', 'RaceID'], surveyColumns]].map(([table, columns, have]) => [table, missing(columns, have)]).filter(([, absent]) => absent.length)

    lacking.forEach(([table, absent]) => problems.push(`the save has no ${absent.map((column) => inputWords(table, column)).join(', ')}, so no orbit could be read`))

    const none = Object.freeze({ bodies: Object.freeze({}), stars: Object.freeze({}), points: Object.freeze({}), bodyOf: Object.freeze({}), hidden: Object.freeze({}), hiddenPoints: Object.freeze({}), problems: Object.freeze([...problems]) })

    if (lacking.length) {
      return none
    }

    const colonyIds = integers(wanted.filter((endpoint) => endpoint.family === 'colony').map((endpoint) => endpoint.id))
    const anchored = await anchorPointsOf(database, game, wanted)
    const pointIds = integers([...wanted.filter((endpoint) => endpoint.family === 'lagrange-point').map((endpoint) => endpoint.id), ...anchored.flatMap((entry) => entry.points)])

    anchored.filter((entry) => entry.lacking).forEach((entry) => problems.push(`The save lacks the key, game or Lagrange point of the ${ANCHOR_NOUNS[entry.family]}, so the points that they ride could not be read`))

    const bodyIds = new Set(integers(wanted.filter((endpoint) => endpoint.family === 'body').map((endpoint) => endpoint.id)))
    const bodyOf = {}
    const points = {}
    const hiddenPoints = {}
    const hidden = {}
    const bodies = {}
    const surveyed = new Set((await database.query(`select FCT_RaceSysSurvey.SystemID from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${game} and FCT_RaceSysSurvey.RaceID = ${race}`))[0].map((row) => row.SystemID))

    if (colonyIds.length && populationColumns.has('PopulationID') && populationColumns.has('SystemBodyID')) {
      ;(await rowsIn(database, `select FCT_Population.PopulationID, FCT_Population.SystemBodyID from FCT_Population where FCT_Population.GameID = ${game} and FCT_Population.PopulationID`, colonyIds)).forEach((row) => {
        if (Number.isInteger(row.SystemBodyID)) {
          bodyOf[row.PopulationID] = row.SystemBodyID
          bodyIds.add(row.SystemBodyID)
        }
      })
    } else if (colonyIds.length) {
      problems.push('The save lacks the ID and body of the colonies, so the bodies of colonies could not be read')
    }

    if (pointIds.length && ['LagrangePointID', 'SystemID', 'PlanetID', 'Distance', 'Bearing', 'Xcor', 'Ycor', 'GameID'].every((name) => pointColumns.has(name))) {
      const pointSites = await rowsIn(database, `select FCT_LagrangePoint.LagrangePointID, FCT_LagrangePoint.SystemID from FCT_LagrangePoint where FCT_LagrangePoint.GameID = ${game} and FCT_LagrangePoint.LagrangePointID`, pointIds)

      pointSites.filter((row) => !surveyed.has(row.SystemID)).forEach((row) => {
        hiddenPoints[row.LagrangePointID] = row.SystemID
      })
      ;(await rowsIn(database, `select FCT_LagrangePoint.LagrangePointID, FCT_LagrangePoint.SystemID, FCT_LagrangePoint.PlanetID, FCT_LagrangePoint.Distance, FCT_LagrangePoint.Bearing, FCT_LagrangePoint.Xcor, FCT_LagrangePoint.Ycor from FCT_LagrangePoint where FCT_LagrangePoint.GameID = ${game} and FCT_LagrangePoint.LagrangePointID`, pointSites.filter((row) => surveyed.has(row.SystemID)).map((row) => row.LagrangePointID))).forEach((row) => {
        if (surveyed.has(row.SystemID)) {
          points[row.LagrangePointID] = Object.freeze({ id: row.LagrangePointID, systemId: row.SystemID, planetId: row.PlanetID, distance: numberOrNull(row.Distance), bearing: numberOrNull(row.Bearing), xcor: numberOrNull(row.Xcor), ycor: numberOrNull(row.Ycor) })

          if (Number.isInteger(row.PlanetID)) {
            bodyIds.add(row.PlanetID)
          }
        }
      })
    } else if (pointIds.length) {
      problems.push('The save lacks the identity, system, parent body, distance, bearing, position or game of the Lagrange points, so the orbits of Lagrange points could not be read')
    }

    const starIds = new Set()
    let pending = [...bodyIds]

    for (let round = 0; pending.length && round <= MAX_PARENTS; round += 1) {
      const sites = await rowsIn(database, `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID from FCT_SystemBody where FCT_SystemBody.GameID = ${game} and FCT_SystemBody.SystemBodyID`, pending)

      sites.filter((row) => !surveyed.has(row.SystemID)).forEach((row) => {
        hidden[row.SystemBodyID] = row.SystemID
      })

      const open = sites.filter((row) => surveyed.has(row.SystemID)).map((row) => row.SystemBodyID)
      const rows = await rowsIn(database, `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.StarID, FCT_SystemBody.BodyClass, FCT_SystemBody.TrojanAsteroid, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.Bearing, FCT_SystemBody.Year, FCT_SystemBody.Eccentricity, FCT_SystemBody.EccentricityDirection, FCT_SystemBody.ParentBodyID, FCT_SystemBody.ParentBodyType, FCT_SystemBody.FixedBody, ${bodyColumns.has('FixedBodyParentID') ? 'FCT_SystemBody.FixedBodyParentID' : 'null'} as FixedBodyParentID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_SystemBody where FCT_SystemBody.GameID = ${game} and FCT_SystemBody.SystemBodyID`, open)

      pending = []
      rows.forEach((row) => {
        bodies[row.SystemBodyID] = Object.freeze({ id: row.SystemBodyID, systemId: row.SystemID, starId: row.StarID, bodyClass: row.BodyClass, trojan: numberOrNull(row.TrojanAsteroid), distance: numberOrNull(row.OrbitalDistance), bearing: numberOrNull(row.Bearing), year: numberOrNull(row.Year), eccentricity: numberOrNull(row.Eccentricity), direction: numberOrNull(row.EccentricityDirection), parentId: numberOrNull(row.ParentBodyID), parentType: numberOrNull(row.ParentBodyType), fixed: numberOrNull(row.FixedBody), fixedParentId: numberOrNull(row.FixedBodyParentID), xcor: numberOrNull(row.Xcor), ycor: numberOrNull(row.Ycor) })
        starIds.add(row.StarID)

        ;[row.ParentBodyID, row.FixedBodyParentID].filter((parent) => parent > 0 && !bodies[parent] && !hidden[parent]).forEach((parent) => pending.push(parent))
      })
      pending = [...new Set(pending)]
    }

    const stars = {}

    ;(await rowsIn(database, 'select FCT_Star.StarID, FCT_Star.ComponentNumber, FCT_Star.Xcor, FCT_Star.Ycor from FCT_Star where FCT_Star.StarID', integers([...starIds]))).forEach((row) => {
      stars[row.StarID] = Object.freeze({ id: row.StarID, component: row.ComponentNumber, xcor: numberOrNull(row.Xcor), ycor: numberOrNull(row.Ycor) })
    })

    return Object.freeze({ bodies: Object.freeze(bodies), stars: Object.freeze(stars), points: Object.freeze(points), bodyOf: Object.freeze(bodyOf), hidden: Object.freeze(hidden), hiddenPoints: Object.freeze(hiddenPoints), problems: Object.freeze(problems) })
  })
}

// What a scenario worked out from the orbit facts is kept per save, one entry for each scenario and profile (`slot` names the kind of result, `scenario` the stops and options as a string, `profile` the speed or the fleet profile the flight is for, compared by value): the entry is worked out again when the read (`facts`, by identity) is another, and goes with the save on a write to a table it reads. A page with several rows that sail at different speeds over one scenario keeps each row's result apart. `compute()` gives the result, which everyone who asks gets as it is.
export const cachedPropagation = (database, slot, { facts, profile, scenario }, compute) => derive(database, `orbit-propagation:${slot}:${scenario}:${typeof profile === 'object' ? JSON.stringify(profile) : profile}`, [facts], compute)
