// Where a body is when a fleet arrives: the orbit rebuilt from the fields the save keeps, moved on from the last body update to the arrival time, and the arrival time worked out as the fixed point of "the flight to where the body will be". Only the orbit families the saves support are propagated: circular orbits (independent asteroids, moons, trojans) over any horizon, and eccentric bodies (planets, comets and asteroids with an eccentricity) while less than one orbit has passed since the last body update. Everything else stays at the saved position with the reason named (`REASONS`); no position is invented.
//
// The rules are those of the game's own orbit update, as the saves reproduce them: a body at bearing B on an orbit of semi-major axis a (AU, or km for a moon) lies at the coordinate angle B - 90 degrees; an eccentric body's ellipse centre is offset a x e from its star along EccentricityDirection and the coordinate angle is turned by the same direction; the bearing falls by 360 x seconds / (Year x 3600) at a circular body's rate and at that rate times the ratio of the speed at the body's distance to the mean speed for an eccentric one; a moon is at its parent's position and a trojan has its parent's bearing plus its own offset; a Lagrange point is at its body's bearing plus 60 degrees. The saved position of every body is the position at the last body update (`FCT_Game.LastGrowthTime`), which trails the game time.
//
// What is not known: how often the game updates an eccentric body, which the saves do not record. The positions here are continuous in time, and the eccentric bearing is stepped by `ECCENTRIC_STEP_SECONDS`, a number fitted to saves (the step that gave the least error between two saves of one game), not one the game states, so an eccentric position carries an error that grows with the time ahead (the 'eccentric-step' condition); a circular position does not depend on the step.

import { KM_PER_AU } from './jump-graph'
import { derive } from './query-cache'

// A fleet's arrival is solved to this many seconds and in at most this many evaluations of the body's position, as the bounded fixed point the saves converged in (at most four evaluations to one second in 3,000 body legs at 5,000 km/s).
export const ARRIVAL_TOLERANCE_SECONDS = 1
export const ARRIVAL_MAX_EVALUATIONS = 8

// A rebuilt position more than this far from the saved one is not trusted.
export const REBUILD_TOLERANCE_KM = 1

// The step an eccentric body's bearing is advanced by, fitted to the saves (two saves of one game 0.83 and 0.5 years apart gave the least error at this step), not stated by the game.
export const ECCENTRIC_STEP_SECONDS = 561600

const MAX_PARENTS = 4

// Why a position is not propagated, by condition code (the texts are utilities/route-position.js `CONDITIONS`). A route states each one it fell back on.
export const REASONS = Object.freeze(['clock-unread', 'clock-inconsistent', 'motion-switch', 'orbit-unread', 'orbit-unsurveyed', 'orbit-missing', 'orbit-mismatch', 'orbit-family', 'orbit-star', 'orbit-horizon', 'arrival-diverged', 'fleet-immobile', 'fleet-slower', 'speed-unknown', 'cycles-capped'])

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

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
// How the game's position update moves a body, as it orders the work: the bodies of the primary list move by their own orbit (a planet or comet under the planet and moon switch; an asteroid that is no trojan also needs the asteroid switch; a body held fixed is left out), then every moon (on the planet and moon switch, whatever it orbits), then every trojan (at its parent's bearing, so as the parent moves), then every Lagrange point (at its planet's), and last every fixed body that has a fixed parent takes the position of that parent, with the fleets and waypoints tied to a body after it. Nothing moves with the planet and moon switch off. So the group is: 'planet' (follows the planet and moon switch), 'asteroid' (also needs the asteroid switch), 'static' (a fixed body with no parent, which nothing moves) or 'unknown' (a field the group rests on was not read). A fixed body with a parent, and a trojan, are the group of that parent. `bodies` holds each body's { bodyClass, trojan, parentId, fixed, fixedParentId } by ID, a field not read being null or absent. This is the motion of a body, not whether the app can propagate it: `familyOf` decides that, and a fixed body it does not support is refused with its reason, never taken for one that stays.
export const motionOf = (bodies, id, depth = 0) => {
  const body = bodies[id]

  if (!body || depth > MAX_PARENTS || !isNumber(body.bodyClass)) {
    return 'unknown'
  }

  const fixed = isNumber(body.fixed) && body.fixed > 0

  if (fixed && !isNumber(body.fixedParentId)) {
    return 'unknown'
  } else if (fixed && body.fixedParentId > 0) {
    return motionOf(bodies, body.fixedParentId, depth + 1)
  } else if (body.bodyClass === 1 || body.bodyClass === 5) {
    return fixed ? 'static' : 'planet'
  } else if (body.bodyClass === 2) {
    return 'planet'
  } else if (body.bodyClass !== 3 || !isNumber(body.trojan) || !isNumber(body.fixed)) {
    return 'unknown'
  } else if (body.trojan !== 0 && !isNumber(body.parentId)) {
    return 'unknown'
  } else if (body.trojan !== 0 && body.parentId > 0) {
    return motionOf(bodies, body.parentId, depth + 1)
  }

  return fixed ? 'static' : 'asteroid'
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

// The bearing of an eccentric body after `step` seconds from `bearing`: the fall of a circular orbit's, scaled by the speed the radius gives (vis-viva).
const advance = (body, star, bearing, step) => {
  const here = orbitPoint(body, bearing, star)
  const radius = Math.hypot(here.Xcor - star.Xcor, here.Ycor - star.Ycor) / KM_PER_AU
  const ratio = Math.sqrt(Math.max(0, 2 * body.distance / radius - 1))

  return wrap(bearing - ((360 * step) / (body.year * 3600)) * ratio)
}

// The bearings of an eccentric body after 0, 1, 2 ... whole steps from the last body update, worked out once per orbit read and body as they are asked for: a route works out the same body at many times.
const STEP_TABLES = new WeakMap()

const stepTable = (orbits, body) => {
  const tables = STEP_TABLES.get(orbits) || STEP_TABLES.set(orbits, new Map()).get(orbits)

  if (!tables.has(body.id)) {
    tables.set(body.id, [body.bearing])
  }

  return tables.get(body.id)
}

// The state of a body `elapsed` seconds after the last body update: { Xcor, Ycor, bearing, stepped } where `stepped` is whether an eccentric orbit was stepped on the way. `clock` is { orbitalMotion, orbitalMotionAst }. A body whose orbit is not moving is where it was saved; an eccentric body past one orbit is not worked out (`horizon: false` lifts that, for the speed estimate beside the limit).
const stateAt = (orbits, clock, id, elapsed, { horizon = true, depth = 0 } = {}) => {
  const body = bodyOf(orbits, id, depth)
  const family = familyOf(body)

  if (!family) {
    throw unsupported('orbit-family')
  } else if (!isNumber(body.bearing) || !isNumber(body.distance) || !isNumber(body.year) || body.year <= 0 || (family !== 'moon' && !isNumber(body.eccentricity)) || (family !== 'moon' && body.eccentricity && !isNumber(body.direction))) {
    throw unsupported('orbit-missing')
  } else if (elapsed < 0) {
    throw unsupported('clock-inconsistent')
  }

  const rock = body.bodyClass === 3 && family !== 'trojan'
  const planets = clock.orbitalMotion === 1 || clock.orbitalMotion === true ? true : clock.orbitalMotion === 0 || clock.orbitalMotion === false ? false : null
  const rocks = clock.orbitalMotionAst === 1 || clock.orbitalMotionAst === true ? true : clock.orbitalMotionAst === 0 || clock.orbitalMotionAst === false ? false : null

  if (planets === null || (rock && planets && rocks === null)) {
    throw unsupported('motion-switch')
  }

  const held = !planets || (rock && !rocks)
  const seconds = held ? 0 : elapsed
  const year = body.year * 3600
  let stepped = false
  let bearing = body.bearing
  let parent = null

  if (family === 'circular') {
    bearing = wrap(body.bearing - (360 * seconds) / year)
  } else if (family === 'moon') {
    parent = stateAt(orbits, clock, body.parentId, elapsed, { horizon, depth: depth + 1 })
    stepped = parent.stepped
    bearing = wrap(body.bearing - (360 * seconds) / year)
  } else if (family === 'trojan') {
    parent = stateAt(orbits, clock, body.parentId, elapsed, { horizon, depth: depth + 1 })
    stepped = parent.stepped
    bearing = held ? body.bearing : wrap(parent.bearing + body.trojan)
  } else if (seconds > 0) {
    if (horizon && seconds >= year) {
      throw unsupported('orbit-horizon')
    }

    const star = starOf(orbits, body)
    const full = Math.floor(seconds / ECCENTRIC_STEP_SECONDS)
    const table = stepTable(orbits, body)

    while (table.length <= full) {
      table.push(advance(body, star, table[table.length - 1], ECCENTRIC_STEP_SECONDS))
    }

    stepped = true
    bearing = table[full]

    if (seconds - full * ECCENTRIC_STEP_SECONDS > 0) {
      bearing = advance(body, star, bearing, seconds - full * ECCENTRIC_STEP_SECONDS)
    }
  }

  const point = family === 'moon' ? moonPoint(body.distance, bearing, parent) : orbitPoint(body, bearing, starOf(orbits, body))

  return { ...point, bearing, stepped, family }
}

// The classes of the body a Lagrange point rides: the game's coordinate update of a point sets its position only for a planet (1) and a moon (2), so a point owned by any other class is never moved and stays where it is saved.
const POINT_OWNER_CLASSES = Object.freeze([1, 2])

// The state of a Lagrange point: its body's bearing plus 60 degrees, on the body's own orbit (a planet's eccentric one at the point's distance, a moon's circle of the point's distance in AU converted to km).
const pointStateAt = (orbits, clock, point, elapsed, options = {}) => {
  const body = bodyOf(orbits, point.planetId)

  if (!POINT_OWNER_CLASSES.includes(body.bodyClass)) {
    throw unsupported('orbit-family')
  }

  const state = stateAt(orbits, clock, point.planetId, elapsed, options)
  const bearing = wrap(state.bearing + 60)

  if (!isNumber(point.distance)) {
    throw unsupported('orbit-missing')
  }

  const there = state.family === 'moon' ? moonPoint(point.distance * KM_PER_AU, bearing, stateAt(orbits, clock, body.parentId, elapsed, options)) : orbitPoint({ distance: point.distance, eccentricity: body.eccentricity, direction: body.direction }, bearing, starOf(orbits, body))

  return { ...there, bearing, stepped: state.stepped, family: state.family }
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
      const rebuilt = (item) => stateAt(orbits, { ...clock, orbitalMotion: 1, orbitalMotionAst: 1 }, item.id, 0, { horizon: false })
      const chain = (id, depth = 0) => {
        const body = bodyOf(orbits, id, depth)
        const reasons = [check(rebuilt(body), body)]

        return body.parentId > 0 && ['moon', 'trojan'].includes(familyOf(body)) ? [...reasons, ...chain(body.parentId, depth + 1)] : reasons
      }

      if (target.point) {
        const state = pointStateAt(orbits, { ...clock, orbitalMotion: 1, orbitalMotionAst: 1 }, target.point, 0, { horizon: false })

        outcome = [check(state, { xcor: target.point.xcor, ycor: target.point.ycor }), ...chain(target.point.planetId)].find(Boolean) || null
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
      // The point is where the body is at the arrival the bound certifies, the last evaluation.
      const arrived = positionAt(depart + next)

      return { position: { Xcor: arrived.Xcor, Ycor: arrived.Ycor }, seconds: next, time: depart + next, km: distance(arrived), evaluations: evaluations + 1 }
    }

    seconds = next
  }

  throw unsupported('arrival-diverged')
}

const clockOf = (facts) => {
  const clock = facts && facts.clock

  return clock && isNumber(clock.gameTime) && isNumber(clock.lastGrowthTime) ? clock : null
}

// The adapter registered in utilities/route-position.js `ADAPTERS` for the families that sit on a body: a body, a colony and a Lagrange point. `at` is the time the fleet leaves `from` (the game time when null); with `from` the position is where the fleet meets the endpoint (the arrival solve, `observedAt` the arrival time), without it the position at `at` (the saved one at the game time, since the save is what the game holds now). Returns { position, observedAt, conditions } or { reasons: [codes] } when the endpoint is not propagated, naming why; `base` is the static record.
export const orbitAdapter = (endpoint, { facts, at = null, from = null, speed = null }) => {
  const clock = clockOf(facts)
  const orbits = facts && facts.orbits

  if (!clock) {
    return { reasons: ['clock-unread'] }
  } else if (!orbits) {
    return { reasons: ['orbit-unread'] }
  }

  try {
    const target = resolve(orbits, endpoint)

    verify(orbits, clock, target)

    const depart = isNumber(at) ? at : clock.gameTime
    const saved = { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }
    const positionAt = (time) => stateOfTarget(orbits, clock, target, time - clock.lastGrowthTime, {})
    const speedOf = () => speedAt(orbits, target)

    if (!from) {
      if (depart <= clock.gameTime) {
        positionAt(clock.gameTime)

        return { position: saved, observedAt: clock.lastGrowthTime, conditions: [], departure: true }
      }

      const state = positionAt(depart)

      return { position: { SystemID: endpoint.SystemID, Xcor: state.Xcor, Ycor: state.Ycor }, observedAt: depart, conditions: state.stepped ? ['eccentric-step'] : [] }
    }

    const solved = solveArrival({ from, depart, speed, positionAt, speedOf })
    const stepped = positionAt(solved.time).stepped

    return { position: { SystemID: endpoint.SystemID, ...solved.position }, observedAt: solved.time, conditions: stepped ? ['eccentric-step'] : [], solved }
  } catch (error) {
    if (error.unsupported) {
      return { reasons: [error.code] }
    }

    throw error
  }
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
    const lacking = [['FCT_SystemBody', BODY_COLUMNS, bodyColumns], ['FCT_Star', ['StarID', 'Component', 'Xcor', 'Ycor'], starColumns], ['FCT_RaceSysSurvey', ['SystemID', 'GameID', 'RaceID'], surveyColumns]].map(([table, columns, have]) => [table, missing(columns, have)]).filter(([, absent]) => absent.length)

    lacking.forEach(([table, absent]) => problems.push(`${table} has no ${absent.join(', ')} in this save, so no orbit could be read`))

    const none = Object.freeze({ bodies: Object.freeze({}), stars: Object.freeze({}), points: Object.freeze({}), bodyOf: Object.freeze({}), hidden: Object.freeze({}), hiddenPoints: Object.freeze({}), problems: Object.freeze(problems) })

    if (lacking.length) {
      return none
    }

    const colonyIds = integers(wanted.filter((endpoint) => endpoint.family === 'colony').map((endpoint) => endpoint.id))
    const pointIds = integers(wanted.filter((endpoint) => endpoint.family === 'lagrange-point').map((endpoint) => endpoint.id))
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
      problems.push('FCT_Population has no PopulationID or SystemBodyID in this save, so the bodies of colonies could not be read')
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
      problems.push('FCT_LagrangePoint has no LagrangePointID, SystemID, PlanetID, Distance, Bearing, Xcor, Ycor or GameID in this save, so the orbits of Lagrange points could not be read')
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
        bodies[row.SystemBodyID] = Object.freeze({ id: row.SystemBodyID, systemId: row.SystemID, starId: row.StarID, bodyClass: row.BodyClass, trojan: numberOrNull(row.TrojanAsteroid) || 0, distance: numberOrNull(row.OrbitalDistance), bearing: numberOrNull(row.Bearing), year: numberOrNull(row.Year), eccentricity: numberOrNull(row.Eccentricity), direction: numberOrNull(row.EccentricityDirection), parentId: numberOrNull(row.ParentBodyID) || 0, parentType: numberOrNull(row.ParentBodyType), fixed: numberOrNull(row.FixedBody) || 0, fixedParentId: numberOrNull(row.FixedBodyParentID), xcor: numberOrNull(row.Xcor), ycor: numberOrNull(row.Ycor) })
        starIds.add(row.StarID)

        ;[row.ParentBodyID, row.FixedBodyParentID].filter((parent) => parent > 0 && !bodies[parent] && !hidden[parent]).forEach((parent) => pending.push(parent))
      })
      pending = [...new Set(pending)]
    }

    const stars = {}

    ;(await rowsIn(database, 'select FCT_Star.StarID, FCT_Star.Component, FCT_Star.Xcor, FCT_Star.Ycor from FCT_Star where FCT_Star.StarID', integers([...starIds]))).forEach((row) => {
      stars[row.StarID] = Object.freeze({ id: row.StarID, component: row.Component, xcor: numberOrNull(row.Xcor), ycor: numberOrNull(row.Ycor) })
    })

    return Object.freeze({ bodies: Object.freeze(bodies), stars: Object.freeze(stars), points: Object.freeze(points), bodyOf: Object.freeze(bodyOf), hidden: Object.freeze(hidden), hiddenPoints: Object.freeze(hiddenPoints), problems: Object.freeze(problems) })
  })
}

// What a scenario worked out from the orbit facts is kept per save, one entry for each scenario and profile (`slot` names the kind of result, `scenario` the stops and options as a string, `profile` the speed or the fleet profile the flight is for, compared by value): the entry is worked out again when the read (`facts`, by identity) is another, and goes with the save on a write to a table it reads. A page with several rows that sail at different speeds over one scenario keeps each row's result apart. `compute()` gives the result, which everyone who asks gets as it is.
export const cachedPropagation = (database, slot, { facts, profile, scenario }, compute) => derive(database, `orbit-propagation:${slot}:${scenario}:${typeof profile === 'object' ? JSON.stringify(profile) : profile}`, [facts], compute)
