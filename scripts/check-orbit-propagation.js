/*
  Checks the propagation of known bodies to a fleet's arrival (src/renderer/utilities/orbit-propagation.js and what carries it: the adapters of route-position.js, the flights of jump-graph.js and the cycles and plans of route-plan.js) without a save.

  The fixture is a small save made here in an in-memory SQLite database, read by the real loader. Every position the checks expect comes from an oracle written in this file from the orbit rules in closed form (a circle, an ellipse by its polar equation, a bisection for the arrival) and, for an eccentric body, from the game's own orbit update transcribed from the source with the source's names (`sourceCall`: Game.cs 27669-27687 with SystemBody.cs 806-829), not from the utilities; the one thing it shares with them is the cadence it is told, the lengths of the sub-pulse and of the increment on the clock below. The statements cover the acceptance of AE-087-03 and of AE-302-14:
  - a position is rebuilt from the orbit fields only when it lands within a kilometre of the saved one; a body that misses, an unsurveyed system, a missing field and a family that is not supported keep the saved position and say why;
  - an arrival is solved to a second in at most eight evaluations for circular bodies, moons, trojans, Lagrange points and eccentric bodies, a fleet that is not faster than the body or has no engines has none, and a fleet that does not converge keeps the saved figure with its reason;
  - an eccentric body is carried for less than one orbit from the last update and states the call length it rests on; a circular body is carried over any horizon;
  - an eccentric body is advanced by calls of the game's own update, one for each sub-pulse of the save, or one for each increment when the save moves bodies after movement, each lowering the bearing by the call's seconds over the year at the ratio of the current to the mean speed, with no fixed step and no Kepler solve; a trojan follows its parent; the asteroid switch gates nothing;
  - a Lagrange transfer is flown leg by leg at the time each leg is entered, and its length depends on the direction;
  - a repeated trip arrives at the position the body has reached, waits there and leaves from where the body then is, so each cycle starts from the last arrival;
  - a plan takes the adapted positions, with the saved figure beside it, and every route output states the unsupported cases with their reasons;
  - orbit fields are read only for systems the race has surveyed, and a propagated result is kept per save, profile and scenario.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names, both on the real sources and on the sources with every benign edit applied. Each benign edit, alone and all together, must leave every check green. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults and the benign edits. When the two saves of one game that the measured comparison names are in saves/, the rebuild of every surveyed asteroid is also checked against them; without them that statement is skipped.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const inRenderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)

const FILES = {
  orbit: inRenderer('utilities', 'orbit-propagation.js'),
  position: inRenderer('utilities', 'route-position.js'),
  plan: inRenderer('utilities', 'route-plan.js'),
  graph: inRenderer('utilities', 'jump-graph.js'),
}

const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The oracle ----------------------------------------------------------------------------------------------------------
const KM = 149600000
// The cadence of the save the checks run on, told to the utilities by the clock: the game moves bodies in each sub-pulse, of 7200 seconds, and its latest increment is 432000 seconds long (the figures of the migrated line save).
const SUBPULSE = 7200
const INCREMENT = 432000
const YEAR = 31536000

const rad = (degrees) => (degrees * Math.PI) / 180
const turn = (degrees) => ((degrees % 360) + 360) % 360
const between = (p, q) => Math.hypot(p.Xcor - q.Xcor, p.Ycor - q.Ycor)

const STARS = { 1: { Xcor: 1.2e9, Ycor: -0.7e9, component: 1 }, 2: { Xcor: -3e9, Ycor: 2e9, component: 1 }, 3: { Xcor: 4e9, Ycor: 4e9, component: 2 } }

// Every body: class, orbit (AU, or km around the parent for a moon), eccentricity and its direction, bearing at the last update, year in hours and the star it orbits.
const BODIES = {
  10: { cls: 3, a: 2, e: 0, B: 40, year: 17520, star: 1, system: 1 },
  11: { cls: 1, a: 1.5, e: 0.2, dir: 30, B: 100, year: 13140, star: 1, system: 1 },
  12: { cls: 2, parent: 11, a: 400000, e: 0, B: 10, year: 240, star: 1, system: 1 },
  13: { cls: 3, parent: 11, trojan: 60, a: 1.5, e: 0, B: 160, year: 13140, star: 1, system: 1 },
  14: { cls: 3, a: 3, e: 0.1, dir: 200, B: 250, year: 43800, star: 1, system: 1 },
  15: { cls: 1, a: 1, e: 0, B: 70, year: 8760, star: 1, system: 1 },
  16: { cls: 3, a: 2.5, e: 0, B: 300, year: 20000, star: 2, system: 2 },
  17: { cls: 3, a: 2.2, e: 0, B: 130, year: 18000, star: 1, system: 1, off: 2 },
  18: { cls: 3, a: 2.4, e: 0, B: null, year: 18000, star: 1, system: 1 },
  19: { cls: 3, a: 1, e: 0, B: 200, year: 8760, star: 1, system: 1 },
  20: { cls: 3, a: 2.3, e: 0, B: 15, year: 19000, star: 1, system: 1, off: 0.5 },
  21: { cls: 3, a: 2, e: 0.1, dir: 10, B: 80, year: 17520, star: 3, system: 1 },
  22: { cls: 3, a: 1.8, e: 0.1, dir: 120, B: 200, year: 3000, star: 1, system: 1 },
  23: { cls: 1, a: 1, e: 0.2, dir: 30, B: 100, year: 6000, star: 1, system: 1 },
  24: { cls: 3, a: 150, e: 0, B: 40, year: 16100000, star: 1, system: 1 },
  25: { cls: 1, a: 2, e: 0.15, dir: 70, B: 40, year: 17520, star: 1, system: 1 },
  26: { cls: 1, a: 1, e: 0.1, dir: 250, B: 200, year: 8760, star: 1, system: 1 },
  27: { cls: 1, a: 4.6, e: 0.6, dir: 37, B: 105, year: 87600, star: 1, system: 1 },
}

// The Lagrange points: the planet they sit on (the game moves a point only for a planet or a moon, and a planet is propagated only with an eccentric orbit) and their distance from the star, AU.
const POINTS = { 31: { body: 25, a: 2 }, 32: { body: 26, a: 1 }, 33: { body: 10, a: 2 } }

const circlePoint = (star, a, bearing) => ({ Xcor: star.Xcor + a * KM * Math.cos(rad(bearing - 90)), Ycor: star.Ycor + a * KM * Math.sin(rad(bearing - 90)) })

// A point of an ellipse about the star's focus, by the polar equation of an ellipse about its centre: the centre lies a x e from the star along the direction, the semi-axis b is a x sqrt(1 - e^2), and the point at angle alpha from the major axis is t(alpha) along that angle, then the whole turned by the direction.
const ellipsePoint = (star, body, bearing) => {
  const b = body.a * Math.sqrt(1 - body.e ** 2)
  const alpha = rad(bearing - 90)
  const t = 1 / Math.sqrt((Math.cos(alpha) / body.a) ** 2 + (Math.sin(alpha) / b) ** 2)
  const turned = rad(body.dir || 0)

  return {
    Xcor: star.Xcor + (body.a * body.e * Math.cos(turned) + t * Math.cos(alpha) * Math.cos(turned) - t * Math.sin(alpha) * Math.sin(turned)) * KM,
    Ycor: star.Ycor + (body.a * body.e * Math.sin(turned) + t * Math.cos(alpha) * Math.sin(turned) + t * Math.sin(alpha) * Math.cos(turned)) * KM,
  }
}

// One call of the game's orbit update on an eccentric body at `bearing`, written out from the source with its names: `initial` is `double_25` (`SystemBody.InitialiseOrbitalSpeed`, SystemBody.cs 806-816), `current` is `double_24` (`UpdateCurrentOrbitalSpeed`, SystemBody.cs 819-829) from the distance to the parent in AU the body had after the previous call, and the bearing falls by `deltaSeconds / (Year x 3600)` of a turn at the ratio of the two (Game.cs 27669-27687).
const sourceCall = (body, bearing, deltaSeconds) => {
  const star = STARS[body.star]
  const orbitalDistance = body.a
  const initial = Math.sqrt(2.0 / orbitalDistance - 1.0 / orbitalDistance)
  const distanceToParent = between(ellipsePoint(star, body, bearing), star) / KM
  const current = Math.sqrt(2.0 / distanceToParent - 1.0 / orbitalDistance)
  const num3 = body.e !== 0 ? current / initial : 1.0
  const num = (deltaSeconds / (body.year * 3600.0)) * num3
  let next = bearing - num * 360.0

  while (next < 0.0) {
    next += 360.0
  }

  return next
}

// The bearings of an eccentric body after 0, 1, 2 ... whole calls of `call` seconds from the last update, each the one before it after one more call.
const AFTER = new Map()

const afterCalls = (id, call, calls) => {
  const key = `${id}:${call}`

  if (!AFTER.has(key)) {
    AFTER.set(key, [BODIES[id].B])
  }

  const table = AFTER.get(key)

  while (table.length <= calls) {
    table.push(sourceCall(BODIES[id], table[table.length - 1], call))
  }

  return table[calls]
}

// A snapshot advances circular bearings for the full elapsed time. Eccentric snapshots use whole source calls then one local final call; the oracle table contains whole calls only.
const bearingAt = (id, elapsed, call = SUBPULSE) => {
  const body = BODIES[id]
  const year = body.year * 3600

  if (body.trojan) {
    return turn(bearingAt(body.parent, elapsed, call) + body.trojan)
  } else if (body.e && !body.parent) {
    const whole = Math.floor(elapsed / call)
    const remainder = elapsed - whole * call
    const bearing = afterCalls(id, call, whole)

    return remainder > 0 ? sourceCall(body, bearing, remainder) : bearing
  }

  return turn(body.B - (360 * elapsed) / year)
}

// Where a body is `elapsed` seconds after the last update.
const bodyAt = (id, elapsed, call = SUBPULSE) => {
  const body = BODIES[id]
  const star = STARS[body.star]
  const bearing = bearingAt(id, elapsed, call)

  if (body.cls === 2) {
    const parent = bodyAt(body.parent, elapsed, call)

    return { Xcor: parent.Xcor + body.a * Math.cos(rad(bearing - 90)), Ycor: parent.Ycor + body.a * Math.sin(rad(bearing - 90)) }
  }

  return body.e && !body.trojan ? ellipsePoint(star, body, bearing) : circlePoint(star, body.a, bearing)
}

const pointAt = (id, elapsed, call = SUBPULSE) => ellipsePoint(STARS[BODIES[POINTS[id].body].star], { a: POINTS[id].a, e: BODIES[POINTS[id].body].e, dir: BODIES[POINTS[id].body].dir }, turn(bearingAt(POINTS[id].body, elapsed, call) + 60))

// Movement reads the destination after the pulse-opening call, not a snapshot partial call. The increment-mode phase cases below use explicit call counts instead.
const bodyDuring = (id, elapsed, call = SUBPULSE) => bodyAt(id, Math.ceil(elapsed / call) * call, call)
const pointDuring = (id, elapsed, call = SUBPULSE) => pointAt(id, Math.ceil(elapsed / call) * call, call)

// The arrival of a fleet at `speed` from `from` leaving at `depart`: the root of (distance to the body when it arrives) / speed - T by bisection.
const arrivalOf = (from, depart, speed, positionAt) => {
  let low = 0
  let high = 3e8

  for (let index = 0; index < 200; index += 1) {
    const middle = (low + high) / 2

    if (between(positionAt(depart + middle), from) / speed - middle > 0) {
      low = middle
    } else {
      high = middle
    }
  }

  return (low + high) / 2
}

// ---- The save ------------------------------------------------------------------------------------------------------------
const GAME_TIME = 5000000
const LAST_UPDATE = GAME_TIME
const CADENCE = { orbitalMovementInSubPulse: 1, subPulseLength: SUBPULSE, incrementLength: INCREMENT }
const CLOCK = { gameTime: GAME_TIME, lastGrowthTime: GAME_TIME - 73800, orbitalMotion: 1, ...CADENCE }
const GAME = 1
const RACE = 2

const SCHEMA = `
  create table FCT_SystemBody (SystemBodyID integer, GameID integer, SystemID integer, StarID integer, BodyClass integer, TrojanAsteroid integer, OrbitalDistance real, Bearing real, Year real, Eccentricity real, EccentricityDirection real, ParentBodyID integer, ParentBodyType integer, FixedBody integer, Xcor real, Ycor real);
  create table FCT_Star (StarID integer, GameID integer, ComponentNumber integer, Xcor real, Ycor real);
  create table FCT_LagrangePoint (LagrangePointID integer, GameID integer, SystemID integer, PlanetID integer, Distance real, Bearing real, Xcor real, Ycor real);
  create table FCT_Population (PopulationID integer, GameID integer, SystemBodyID integer);
  create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer);
`

const sqlNumber = (value) => (value === null || value === undefined ? 'null' : String(value))

const rowsOf = () => {
  const bodies = Object.entries(BODIES).map(([id, body]) => {
    const saved = bodyAt(Number(id), 0)
    const x = saved.Xcor + (body.off || 0)

    return `insert into FCT_SystemBody values (${id}, ${GAME}, ${body.system}, ${body.star}, ${body.cls}, ${body.trojan || 0}, ${sqlNumber(body.a)}, ${sqlNumber(body.B)}, ${body.year}, ${body.e}, ${sqlNumber(body.dir || 0)}, ${body.parent || 0}, ${body.parent ? 1 : 0}, 0, ${x}, ${saved.Ycor});`
  })
  const points = Object.entries(POINTS).map(([id, point]) => {
    const saved = pointAt(Number(id), 0)

    return `insert into FCT_LagrangePoint values (${id}, ${GAME}, 1, ${point.body}, ${point.a}, ${turn(BODIES[point.body].B + 60)}, ${saved.Xcor}, ${saved.Ycor});`
  })
  const stars = Object.entries(STARS).map(([id, star]) => `insert into FCT_Star values (${id}, ${GAME}, ${star.component}, ${star.Xcor}, ${star.Ycor});`)

  return [
    ...bodies,
    ...points,
    ...stars,
    // The same body ids in another game, with other orbits: the read keeps to its game.
    'insert into FCT_SystemBody values (10, 2, 1, 1, 3, 0, 9.99, 5, 100, 0, 0, 0, 0, 0, 1, 1);',
    `insert into FCT_Population values (701, ${GAME}, 10);`,
    `insert into FCT_Population values (702, ${GAME}, 16);`,
    // The race has surveyed system 1; another race has surveyed system 2, and the same race has in another game.
    `insert into FCT_RaceSysSurvey values (${GAME}, ${RACE}, 1);`,
    `insert into FCT_RaceSysSurvey values (${GAME}, 3, 2);`,
    `insert into FCT_RaceSysSurvey values (2, ${RACE}, 2);`,
  ].join('\n')
}

const databaseOf = async (schema, rows, log = []) => {
  const raw = new sqlite3.Database(':memory:')
  const exec = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

  await exec(schema)
  await exec(rows)

  return {
    query: (sql) => {
      log.push(sql)

      return new Promise((resolve, reject) => raw.all(sql, (error, found) => (error ? reject(error) : resolve([found]))))
    },
    close: () => raw.close(),
  }
}

const saved = (id) => ({ ...bodyAt(id, 0), SystemID: 1 })

const endpointOfBody = (id) => ({ family: 'body', key: `body:${id}`, id, name: `Body ${id}`, SystemID: BODIES[id].system, Xcor: saved(id).Xcor, Ycor: saved(id).Ycor })

const ENDPOINTS = {
  ...Object.fromEntries(Object.keys(BODIES).map((id) => [`b${id}`, endpointOfBody(Number(id))])),
  c701: { family: 'colony', key: 'colony:701', id: 701, name: 'Colony', SystemID: 1, Xcor: saved(10).Xcor, Ycor: saved(10).Ycor },
  c702: { family: 'colony', key: 'colony:702', id: 702, name: 'Hidden colony', SystemID: 2, Xcor: saved(16).Xcor, Ycor: saved(16).Ycor },
  p31: { family: 'lagrange-point', key: 'lagrange:31', id: 31, name: 'LP 31', SystemID: 1, Xcor: pointAt(31, 0).Xcor, Ycor: pointAt(31, 0).Ycor },
  p32: { family: 'lagrange-point', key: 'lagrange:32', id: 32, name: 'LP 32', SystemID: 1, Xcor: pointAt(32, 0).Xcor, Ycor: pointAt(32, 0).Ycor },
  p33: { family: 'lagrange-point', key: 'lagrange:33', id: 33, name: 'LP 33', SystemID: 1, Xcor: pointAt(33, 0).Xcor, Ycor: pointAt(33, 0).Ycor },
}

const LAGRANGE_ROWS = [31, 32].map((id) => ({ LagrangePointID: id, SystemID: 1, Xcor: pointAt(id, 0).Xcor, Ycor: pointAt(id, 0).Ycor }))

const asJson = (value) => JSON.parse(JSON.stringify(value))

// ---- The world: the modules as shipped, or with edits planted ----------------------------------------------------------
const resolved = (edit, text) => {
  if (!edit.at) {
    return edit
  }

  const found = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags.replace('g', '')}g`))]

  if (found.length !== 1) {
    throw new Error(`The edit of ${edit.target} (${edit.label}) matches ${found.length} times, not once`)
  }

  return { ...edit, from: found[0][0], to: edit.to(found[0]) }
}

const worldOf = (edits = []) => {
  const text = { ...ORIGINALS }

  edits.forEach((edit) => {
    const change = resolved(edit, text[edit.target])

    text[edit.target] = patched(FILES[edit.target], text[edit.target], change.from, change.to)
  })

  const sources = { 'orbit-propagation': text.orbit, 'route-position': text.position, 'route-plan': text.plan, 'jump-graph': text.graph }
  const modules = memo(() => loadUtilities(['orbit-propagation', 'route-position', 'route-plan', 'jump-graph', 'query-cache', 'provenance'], { sources }))
  // The save, its database and the orbit facts the loader reads from it for every endpoint, with the read the pages hold.
  const scene = memo(async () => {
    const m = await modules()
    const log = []
    const database = await databaseOf(SCHEMA, rowsOf(), log)
    const orbits = await m['orbit-propagation'].loadOrbitFacts(database, { GameID: GAME, RaceID: RACE }, Object.values(ENDPOINTS))
    const facts = { clock: CLOCK, fleets: {}, waypoints: {}, problems: [], orbits }

    return { m, database, log, orbits, facts }
  })

  return { text, modules, scene }
}

// ---- The checks ----------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

const adapt = (scene, key, options = {}) => scene.m['orbit-propagation'].orbitAdapter(ENDPOINTS[key], { facts: scene.facts, ...options })

const elapsedAt = (time) => time - LAST_UPDATE

const PROPAGATED = [['b10', (t) => bodyAt(10, t)], ['b11', (t) => bodyAt(11, t)], ['b12', (t) => bodyAt(12, t)], ['b13', (t) => bodyAt(13, t)], ['b14', (t) => bodyAt(14, t)], ['c701', (t) => bodyAt(10, t)], ['p31', (t) => pointAt(31, t)], ['p32', (t) => pointAt(32, t)]]

check('rebuild', 'a position is rebuilt from the orbit fields only when it lands within a kilometre of the saved one, for a circular body, a moon, a trojan, an eccentric body, a colony and a Lagrange point, and the others keep the saved position with their reason', async (w) => {
  const scene = await w.scene()

  assert.deepEqual(asJson(scene.orbits.problems), [], 'the loader reads the fixture whole')
  assert.equal(scene.orbits.bodies[10].distance, 2, 'the read keeps to its game')

  PROPAGATED.forEach(([key, positionAt]) => {
    const held = adapt(scene, key, { at: GAME_TIME })

    assert.equal(held.observedAt, LAST_UPDATE, `${key}: at the game time the saved position stands, dated by the last update`)
    assert.deepEqual({ ...held.position }, { SystemID: ENDPOINTS[key].SystemID, Xcor: ENDPOINTS[key].Xcor, Ycor: ENDPOINTS[key].Ycor })
    assert.deepEqual(held.conditions, [])

    const ahead = adapt(scene, key, { at: GAME_TIME + 1 })
    const there = positionAt(elapsedAt(GAME_TIME + 1))

    assert.ok(!ahead.reasons, `${key}: the orbit is rebuilt`)
    assert.ok(between(ahead.position, there) <= 1, `${key}: a second past the game time it is where the orbit puts it, to a kilometre (${between(ahead.position, there)})`)
  })

  const refused = (key) => adapt(scene, key, { at: GAME_TIME + 1 }).reasons
  const coordinates = (key) => ({ Xcor: ENDPOINTS[key].Xcor, Ycor: ENDPOINTS[key].Ycor })

  assert.deepEqual(refused('b17'), ['orbit-mismatch'], 'a rebuild 2 km from the saved position is not trusted')
  assert.ok(between(coordinates('b17'), bodyAt(17, 0)) < 1e-6, 'the endpoint holds the true position, the rows the offset one')
  assert.ok(!refused('b20'), 'one 0.5 km off is')
  assert.deepEqual(refused('b18'), ['orbit-missing'], 'an orbit with a field the save lacks')
  assert.deepEqual(refused('b15'), ['orbit-family'], 'a circular planet is not a family that is propagated')
  assert.ok(!refused('p33') && between(adapt(scene, 'p33', { at: GAME_TIME + 1 }).position, ENDPOINTS.p33) < 1e-6, 'a Lagrange point of an asteroid keeps its own saved coordinates')
  assert.deepEqual(refused('b21'), ['orbit-star'], 'a body around a star that is not the primary')
  assert.deepEqual(refused('b16'), ['orbit-unsurveyed'], 'a body of a system the race has not surveyed')
  assert.deepEqual(refused('c702'), ['orbit-unsurveyed'], 'a colony on it')
  assert.deepEqual(adapt(scene, 'p31', { facts: { ...scene.facts, orbits: { ...scene.orbits, points: {} } }, at: GAME_TIME + 1 }).reasons, ['orbit-missing'], 'a Lagrange point the read does not have')
  assert.deepEqual(adapt(scene, 'b10', { facts: { ...scene.facts, orbits: null }, at: GAME_TIME + 1 }).reasons, ['orbit-unread'], 'orbits not read')
  assert.deepEqual(adapt(scene, 'b10', { facts: { ...scene.facts, clock: null }, at: GAME_TIME + 1 }).reasons, ['clock-unread'], 'a clock not read')
  assert.deepEqual(adapt(scene, 'b10', { at: GAME_TIME - 1 }).reasons, ['clock-inconsistent'], 'a requested time before the saved coordinates is refused')
})

check('circular-arrival', 'an arrival is solved to a second in at most eight evaluations, for a circular body, a moon, a trojan, an eccentric body, a colony and a Lagrange point, at the position the body has when the fleet gets there', async (w) => {
  const scene = await w.scene()
  const from = { SystemID: 1, Xcor: STARS[1].Xcor + 3e8, Ycor: STARS[1].Ycor - 2e8 }
  const speed = 1500

  PROPAGATED.forEach(([key, positionAt]) => {
    const found = adapt(scene, key, { from, speed, at: GAME_TIME })
    const seconds = arrivalOf(from, GAME_TIME, speed, (time) => positionAt(Math.ceil(elapsedAt(time) / SUBPULSE) * SUBPULSE))
    const there = positionAt(Math.ceil(elapsedAt(GAME_TIME + seconds) / SUBPULSE) * SUBPULSE)

    assert.ok(!found.reasons, `${key}: an arrival is found`)
    assert.ok(Math.abs(found.observedAt - (GAME_TIME + seconds)) <= 1, `${key}: the arrival is the body's by the time it is reached (${found.observedAt - (GAME_TIME + seconds)} s off)`)
    assert.ok(between(found.position, there) <= 30, `${key}: at the position it has then (${between(found.position, there)} km off)`)
    assert.ok(found.solved.evaluations <= 8, `${key}: in at most eight evaluations (${found.solved.evaluations})`)
    assert.ok(Math.abs(found.solved.km - between(from, found.position)) < 1e-6, `${key}: the distance is the flight to that position`)
  })

  const smooth = scene.m['orbit-propagation'].solveArrival({ from: { Xcor: 0, Ycor: 0 }, depart: 0, speed: 100, positionAt: (time) => ({ Xcor: 100000 + 30 * time, Ycor: 0 }), speedOf: () => 30 })

  assert.ok(Math.abs(smooth.seconds - 100000 / 70) <= 1, 'the solver certifies a second, not a minute, against a closed-form moving target')
  const tenFound = adapt(scene, 'b10', { from, speed, at: GAME_TIME })

  assert.ok(Math.abs(tenFound.solved.km - between(from, ENDPOINTS.b10)) > 1e5, 'the flight is not the one to the saved position')

  // A circular orbit repeats after a year of its own.
  const period = BODIES[10].year * 3600
  const first = adapt(scene, 'b10', { at: GAME_TIME + 5e6 }).position
  const again = adapt(scene, 'b10', { at: GAME_TIME + 5e6 + period }).position

  assert.ok(between(first, again) <= 1, 'a circular body is back where it was after its year')
  assert.ok(between(adapt(scene, 'b10', { at: GAME_TIME + 50 * YEAR }).position, bodyAt(10, elapsedAt(GAME_TIME + 50 * YEAR))) <= 1, 'whatever the horizon')
})

check('solver-bounds', 'the arrival is bounded: eight evaluations, a second, and a fleet that has no engines, is not faster than the body or does not converge keeps the saved figure with its reason', async (w) => {
  const scene = await w.scene()
  const m = scene.m['orbit-propagation']
  const along = { positionAt: (time) => ({ Xcor: 5e8 + 30 * time, Ycor: 0 }), speedOf: () => 30 }
  const from = { Xcor: 0, Ycor: 0 }
  const solved = m.solveArrival({ from, depart: 0, speed: 1500, ...along })

  assert.ok(solved.evaluations <= 8)
  assert.ok(Math.abs(solved.seconds - 5e8 / (1500 - 30)) <= 1, 'to a second of the closed form')

  const refusal = (options) => {
    try {
      m.solveArrival({ from, depart: 0, ...along, ...options })
    } catch (error) {
      return error.code
    }

    return null
  }

  assert.equal(refusal({ speed: 31 }), 'arrival-diverged', 'a fleet barely faster than the body does not converge in eight evaluations')
  assert.equal(refusal({ speed: 29 }), 'fleet-slower')
  assert.equal(refusal({ speed: 30 }), 'fleet-slower', 'a fleet as fast as the body does not overtake it')
  assert.equal(refusal({ speed: 1 }), 'fleet-immobile', 'a speed of 1 is no engines')
  assert.equal(refusal({ speed: 0.5 }), 'fleet-immobile')
  assert.equal(refusal({ speed: 0 }), 'speed-unknown')
  assert.equal(refusal({ speed: null }), 'speed-unknown')
  assert.equal(m.ARRIVAL_MAX_EVALUATIONS, 8)
  assert.equal(m.ARRIVAL_TOLERANCE_SECONDS, 1)
  assert.equal(refusal({ speed: 100, speedOf: () => 1, positionAt: (time) => ({ Xcor: time < 2 ? 300 : 100, Ycor: 0 }) }), 'arrival-diverged', 'a boundary jump with no self-consistent flight time is refused, not certified by a smooth speed bound')

  const from10 = { SystemID: 1, Xcor: STARS[1].Xcor + 3e8, Ycor: STARS[1].Ycor }

  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: 1, at: GAME_TIME }).reasons, ['fleet-immobile'])
  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: 20, at: GAME_TIME }).reasons, ['fleet-slower'], 'a body of 30 km/s is not overtaken at 20')
  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: 31, at: GAME_TIME }).reasons, ['arrival-diverged'])
  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: null, at: GAME_TIME }).reasons, ['speed-unknown'])
  assert.ok(!adapt(scene, 'b10', { from: from10, speed: 1500, at: GAME_TIME }).reasons)
})

check('eccentric-horizon', 'an eccentric body is carried for less than one orbit from the last update and states the call length it rests on, a moon or trojan of one inherits the limit, and a circular body has none', async (w) => {
  const scene = await w.scene()
  const elapsed = 2000000

  ;[14, 11, 12, 13].forEach((id) => {
    const found = adapt(scene, `b${id}`, { at: LAST_UPDATE + elapsed })
    const expected = bodyAt(id, elapsed)

    assert.ok(!found.reasons, `body ${id}: carried`)
    assert.ok(between(found.position, expected) <= 1, `body ${id}: where the source's calls put it (${between(found.position, expected)} km)`)
    assert.deepEqual(found.conditions, ['eccentric-cadence'], `body ${id}: states the cadence it rests on`)
  })

  assert.ok(between(bodyAt(14, elapsed), bodyAt(14, elapsed, INCREMENT)) > 1000, 'the call length matters at this horizon, so the fault of another one shows')
  const flown = adapt(scene, 'b11', { at: GAME_TIME, from: ENDPOINTS.b10, speed: 1500 })

  assert.ok(!flown.reasons && flown.solved, 'an arrival at an eccentric body is solved')
  assert.deepEqual(flown.conditions, ['eccentric-cadence'], 'and states the cadence it rests on')
  assert.deepEqual(adapt(scene, 'b10', { at: LAST_UPDATE + elapsed }).conditions, [], 'a circular body does not depend on the cadence')

  const year = (id) => BODIES[id].year * 3600

  assert.ok(!adapt(scene, 'b14', { at: LAST_UPDATE + year(14) - 10 }).reasons, 'just under one orbit')
  assert.deepEqual(adapt(scene, 'b14', { at: LAST_UPDATE + year(14) }).reasons, ['orbit-horizon'], 'a whole orbit is not')
  assert.deepEqual(adapt(scene, 'b11', { at: LAST_UPDATE + year(11) + 1 }).reasons, ['orbit-horizon'])
  assert.deepEqual(adapt(scene, 'b12', { at: LAST_UPDATE + year(11) + 1 }).reasons, ['orbit-horizon'], 'a moon follows its parent\'s horizon')
  assert.deepEqual(adapt(scene, 'b13', { at: LAST_UPDATE + year(11) + 1 }).reasons, ['orbit-horizon'], 'and a trojan')
  assert.ok(!adapt(scene, 'b10', { at: LAST_UPDATE + 100 * year(10) }).reasons, 'a circular orbit has no horizon')
})

check('saved-epoch', 'the played construction-clock gap is not replayed: saved positions, one-second continuity, a sub-pulse, the supported horizon and an arrival all start at GameTime', async (w) => {
  const scene = await w.scene()
  const rp = scene.m['route-position']
  const epoch = 91725410
  const factsAt = (growth, length = 1) => ({ ...scene.facts, clock: { ...CLOCK, gameTime: epoch, lastGrowthTime: growth, subPulseLength: length } })
  const ask = (seconds, growth = epoch - 73800, length = 1, extra = {}) => adapt(scene, 'b27', { facts: factsAt(growth, length), at: epoch + seconds, ...extra })
  const saved = ask(0)
  const one = ask(1)

  assert.equal(saved.observedAt, epoch)
  assert.ok(between(saved.position, ENDPOINTS.b27) <= 1e-6)
  assert.ok(between(one.position, bodyAt(27, 1, 1)) <= 1e-6, 'one exact source second from the saved bearing')
  assert.ok(Math.abs(between(saved.position, one.position) - 7.119526) < 1e-5, 'the continuity probe moves about 7.12 km, not 525378 km')
  assert.ok(between(ask(1800, epoch - 73800, 1800).position, bodyAt(27, 1800, 1800)) <= 1e-6, 'one played-length sub-pulse')
  ;[epoch, epoch - 73800, null, epoch + 10].forEach((growth) => {
    assert.ok(between(ask(1, growth).position, one.position) <= 1e-6, 'construction time has no effect')
    const record = rp.positionRecord(ENDPOINTS.b27, { facts: factsAt(growth) })

    assert.equal(record.observedAt, epoch)
    assert.equal(record.age, 0)
    assert.ok(!record.conditions.includes('clock-unread') && !record.conditions.includes('clock-inconsistent'))
    assert.deepEqual(ask(10 * YEAR, growth, 1800).reasons, ['orbit-horizon'])
    assert.ok(!ask(10 * YEAR - 1, growth, 432000).reasons, 'the horizon starts at GameTime, not construction time')
  })
  const from = { Xcor: ENDPOINTS.b27.Xcor + 500000, Ycor: ENDPOINTS.b27.Ycor - 100000 }
  const flown = ask(0, epoch - 73800, 1, { from, speed: 1500 })
  const seconds = arrivalOf(from, epoch, 1500, (time) => bodyDuring(27, time - epoch, 1))

  assert.ok(flown.solved, 'the gap case has an arrival')
  assert.ok(Math.abs(flown.solved.seconds - seconds) <= 1)
  assert.ok(between(flown.position, bodyDuring(27, flown.solved.seconds, 1)) <= 1e-6)
  assert.ok(between(flown.position, ask(0, epoch, 1, { from, speed: 1500 }).position) <= 1e-6, 'the arrival does not depend on construction time')

  const limitedFacts = factsAt(epoch - 73800, 5)
  const refused = rp.positionRecord(ENDPOINTS.b27, { facts: limitedFacts, adapters: rp.ADAPTERS, at: epoch + 3 * YEAR })
  const summary = rp.summarisePositions([refused], { merge: true })
  const detail = 'the horizon needs 18921600 calls of 5 s against a budget of 100000'

  assert.equal(refused.basis, 'static')
  assert.ok(refused.conditions.includes('cadence-budget'))
  assert.ok(summary.missing.includes(detail), 'provenance carries the exact bound')
  assert.ok(rp.describePositions(summary).some((group) => group.conditions.some((condition) => condition.text === detail)), 'the position strip carries the same bound')
  const figure = rp.withPositions(scene.m.provenance.ofRule({ rule: 'route.positionAge', value: 1 }), summary)

  assert.equal(figure.status, 'estimated')
  assert.ok(figure.inputs.missing.includes(detail), 'every position-dependent figure carries the bound')
  assert.ok(rp.summarisePositions([refused, { ...refused, details: ['another bounded horizon'] }], { merge: true }).missing.includes('another bounded horizon'), 'repeated endpoint summaries retain every bound')
})

check('movement-phase', 'move orders see the pulse-opening orbital update, but the preceding increment update in after-movement mode, including distinct movement and snapshot sides of an exact increment boundary', async (w) => {
  const scene = await w.scene()
  const m = scene.m['orbit-propagation']
  const rp = scene.m['route-position']
  const length = 1800
  const speed = 30
  const endpoint = ENDPOINTS.b27
  const saved = bodyAt(27, 0, length)
  const first = bodyAt(27, length, length)
  const second = bodyAt(27, 2 * length, length)
  const facts = (mode) => ({ ...scene.facts, clock: { ...CLOCK, orbitalMovementInSubPulse: mode, subPulseLength: length, incrementLength: length } })
  const ask = (mode, at, from = null, flightSpeed = speed) => adapt(scene, 'b27', { facts: facts(mode), at: GAME_TIME + at, from, speed: flightSpeed })
  const nearSaved = { Xcor: saved.Xcor, Ycor: saved.Ycor + 5 }
  const short = ask(1, 0, nearSaved)
  const expectedSeconds = between(first, nearSaved) / speed

  assert.ok(short.solved && expectedSeconds > 1 && expectedSeconds < length, 'the first-pulse flight settles inside that pulse')
  assert.ok(Math.abs(short.solved.seconds - expectedSeconds) <= 1e-9)
  assert.ok(between(short.position, first) <= 1e-6, '5 km from the saved body at 30 km/s reaches the body after one whole 1800 s call, not the saved position')
  assert.ok(between(short.position, saved) > 10000, 'the wrong policy has a materially different destination')
  const old = m.solveArrival({ from: nearSaved, depart: GAME_TIME, speed, speedOf: () => 1, positionAt: () => saved })

  assert.ok(Math.abs(old.seconds - 5 / 30) <= 1e-9, 'the old floor policy has its own self-consistent certified arrival')
  assert.ok(Math.abs(short.solved.seconds - old.seconds) > 100, 'residual certification alone cannot distinguish the wrong policy; source order must select the destination')
  const laterFrom = { Xcor: first.Xcor, Ycor: first.Ycor + 5 }
  const later = ask(1, length + 100, laterFrom)

  assert.ok(later.solved && between(later.position, second) <= 1e-6, 'a flight within the subsequent pulse uses its opening call')
  assert.ok(later.solved.time > GAME_TIME + length && later.solved.time < GAME_TIME + 2 * length)
  // Use the rebuilt coordinates to place a representable exact distance on the boundary, while the destination oracle remains the independent source transcription above.
  const rebuiltFirst = ask(1, length).position
  const rebuiltSaved = ask(0, 0).position
  const boundaryFrom = { Xcor: rebuiltFirst.Xcor + Math.sign(saved.Xcor - first.Xcor) * speed * length, Ycor: rebuiltFirst.Ycor }
  const boundary = ask(1, 0, boundaryFrom)

  assert.ok(boundary.solved && boundary.solved.seconds === length, 'an exact pulse-ending arrival is certified')
  assert.ok(between(boundary.position, first) <= 1e-6, 'the ending pulse sees call one, not call zero or two')
  const incrementShort = ask(0, 0, nearSaved)
  const incrementLater = ask(0, length + 100, laterFrom)
  const incrementBoundary = ask(0, 0, { Xcor: rebuiltSaved.Xcor + speed * length, Ycor: rebuiltSaved.Ycor })
  const incrementSecondBoundary = ask(0, length, { Xcor: rebuiltFirst.Xcor + Math.sign(saved.Xcor - first.Xcor) * speed * length, Ycor: rebuiltFirst.Ycor })

  assert.ok(incrementShort.solved && Math.abs(incrementShort.solved.seconds - 5 / 30) <= 1e-7, 'the first increment moves fleets before any orbit update')
  assert.ok(incrementLater.solved && between(incrementLater.position, first) <= 1e-6, 'inside a subsequent increment movement uses the floor, not the ceiling')
  assert.ok(incrementBoundary.solved && incrementBoundary.solved.seconds === length && between(incrementBoundary.position, saved) <= 1e-6, 'movement ending at the first increment boundary sees the pre-update saved position')
  assert.ok(incrementSecondBoundary.solved && incrementSecondBoundary.solved.seconds === length && between(incrementSecondBoundary.position, first) <= 1e-6, 'movement ending at the second boundary sees only the first increment update')
  assert.ok(between(ask(0, length).position, first) <= 1e-6 && between(ask(0, 2 * length).position, second) <= 1e-6, 'snapshots at those boundaries are after their updates')
  ;[0, 1].forEach((mode) => {
    assert.ok(between(ask(mode, 0).position, saved) <= 1e-6, 'a no-movement snapshot exactly at the saved epoch is never advanced')
    assert.ok(between(ask(mode, 0, saved).position, saved) <= 1e-6, 'a zero-duration arrival at the saved epoch is not a movement pulse')
    assert.deepEqual(ask(null, 0, nearSaved).reasons, ['cadence-unread'], 'an unread mode cannot choose the movement phase')
  })
  const record = rp.positionRecord(endpoint, { facts: facts(1), adapters: rp.ADAPTERS, at: GAME_TIME, from: nearSaved, speed })
  const summary = rp.summarisePositions([record])
  const figure = rp.withPositions(scene.m.provenance.ofRule({ rule: 'route.positionAge', value: 1 }), summary)

  assert.ok(between(record.position, first) <= 1e-6, 'the consumer contract keeps the movement destination')
  assert.ok(rp.ASSUMPTIONS.propagated.includes('pulse-opening') && rp.ASSUMPTIONS.propagated.includes('preceding increment') && record.conditions.includes('eccentric-cadence'), 'visible provenance names both source-ordered phases and keeps the cadence condition')
  assert.ok(JSON.stringify(figure).includes('pulse-opening'), 'the position-dependent figure retains the phase provenance')
})

check('source-calls', 'an eccentric body is advanced as the source does it: a call of the update for each sub-pulse, or for each increment when the save moves bodies after movement, lowering the bearing by the call\'s seconds at the ratio of the current to the mean speed, with no fixed step; a trojan follows its parent through the same calls; a cadence that is not read is not guessed', async (w) => {
  const scene = await w.scene()
  const m = scene.m['orbit-propagation']
  // The clock stands at the last body update, so that every `at` is a time after the save and the body is worked out for it.
  const at = (key, seconds, fields = {}) => adapt(scene, key, { facts: { ...scene.facts, clock: { ...CLOCK, gameTime: LAST_UPDATE, ...fields } }, at: LAST_UPDATE + seconds })
  const planet = BODIES[11]
  const placed = (body, bearing) => ellipsePoint(STARS[body.star], body, bearing)
  const onCircle = (body, bearing) => circlePoint(STARS[body.star], body.a, bearing)
  const dropped = (body, seconds) => placed(body, turn(body.B - (360 * seconds) / (body.year * 3600)))

  // One sub-pulse is one call of 7200 seconds, written out from the source, and the ratio of the speeds moves the body from where the bare turn would put it.
  const pulse = at('b11', SUBPULSE)

  assert.ok(!pulse.reasons, 'one sub-pulse is carried')
  assert.ok(between(pulse.position, placed(planet, sourceCall(planet, planet.B, SUBPULSE))) <= 1, `one sub-pulse: one call of the source (${between(pulse.position, placed(planet, sourceCall(planet, planet.B, SUBPULSE)))} km)`)
  assert.ok(between(pulse.position, dropped(planet, SUBPULSE)) > 1000, 'the ratio of the current to the mean speed is in it')
  assert.deepEqual(pulse.conditions, ['eccentric-cadence'])

  // One increment, when the save moves bodies after movement: one call of the increment's length, and the same seconds are sixty sub-pulses when it moves them in each.
  const increment = at('b11', INCREMENT, { orbitalMovementInSubPulse: 0 })
  const sixty = at('b11', INCREMENT)

  assert.ok(between(increment.position, placed(planet, sourceCall(planet, planet.B, INCREMENT))) <= 1, `one increment: one call of the source (${between(increment.position, placed(planet, sourceCall(planet, planet.B, INCREMENT)))} km)`)
  assert.ok(between(sixty.position, bodyAt(11, INCREMENT)) <= 1, 'the same seconds with the option on are the calls of the sub-pulses')
  assert.ok(between(increment.position, sixty.position) > 100, 'so the option picks the cadence')
  assert.ok(between(at('b11', INCREMENT, { orbitalMovementInSubPulse: 0, subPulseLength: null }).position, increment.position) <= 1e-6, 'a save that moves bodies after movement does not need the sub-pulse')
  assert.ok(between(at('b11', INCREMENT, { incrementLength: null }).position, sixty.position) <= 1e-6, 'nor one that moves them in each sub-pulse the increment')

  // Each whole call starts from where the last left the body; a snapshot remainder is one final source call from that boundary.
  let bearing = planet.B

  for (let call = 0; call < 3; call += 1) {
    bearing = sourceCall(planet, bearing, SUBPULSE)
  }

  assert.ok(between(at('b11', 3 * SUBPULSE).position, placed(planet, bearing)) <= 1, 'three sub-pulses are three calls')
  assert.ok(between(at('b11', 3 * SUBPULSE + SUBPULSE / 2).position, placed(planet, sourceCall(planet, bearing, SUBPULSE / 2))) <= 1e-6, 'half a sub-pulse adds one final source call')
  assert.ok(between(at('b11', 1.5 * INCREMENT, { orbitalMovementInSubPulse: 0 }).position, placed(planet, sourceCall(planet, sourceCall(planet, planet.B, INCREMENT), INCREMENT / 2))) <= 1e-6, 'half an increment also adds one final source call')

  // Circular geometry combines the full elapsed time without cadence.
  const rock = BODIES[14]

  assert.ok(between(at('b14', SUBPULSE).position, placed(rock, sourceCall(rock, rock.B, SUBPULSE))) <= 1, 'an eccentric asteroid: one call of the source')
  assert.ok(between(at('b10', 5e6).position, bodyAt(10, 5e6)) <= 1 && between(at('b10', 5e6, { orbitalMovementInSubPulse: 0 }).position, bodyAt(10, 5e6)) <= 1, 'a circle uses the full elapsed time in either mode')
  assert.ok(between(at('b10', 5e6, { orbitalMovementInSubPulse: null, subPulseLength: null, incrementLength: null }).position, bodyAt(10, 5e6)) <= 1e-6, 'a circular snapshot does not require cadence')

  // A trojan is at its parent's bearing plus its offset, the parent being advanced by the calls: not on a circle of its own.
  const trojan = BODIES[13]
  const parentAfter = sourceCall(planet, sourceCall(planet, planet.B, SUBPULSE), SUBPULSE)

  assert.ok(between(at('b13', 2 * SUBPULSE).position, onCircle(trojan, turn(parentAfter + trojan.trojan))) <= 1, 'a trojan follows its parent')
  assert.ok(between(at('b13', 2 * SUBPULSE).position, onCircle(trojan, turn(trojan.B - (360 * 2 * SUBPULSE) / (trojan.year * 3600)))) > 100, 'and not a circle of its own')
  assert.ok(between(at('b13', INCREMENT, { orbitalMovementInSubPulse: 0 }).position, onCircle(trojan, turn(sourceCall(planet, planet.B, INCREMENT) + trojan.trojan))) <= 1, 'by whatever cadence the parent has')

  // A cadence that is not read is not guessed: an eccentric body, and what follows one, is refused, and a length of nothing is no length.
  ;[{ orbitalMovementInSubPulse: null }, { orbitalMovementInSubPulse: 1, subPulseLength: null }, { orbitalMovementInSubPulse: 1, subPulseLength: 0 }, { orbitalMovementInSubPulse: 0, incrementLength: null }, { orbitalMovementInSubPulse: 0, incrementLength: 0 }].forEach((fields) => {
    ;['b11', 'b14', 'b12', 'b13', 'p31'].forEach((key) => assert.deepEqual(at(key, SUBPULSE, fields).reasons, ['cadence-unread'], `${key}: ${JSON.stringify(fields)}`))
  })

  // Short saved calls remain exact through the inclusive budget. Cache lookups in either direction do not change the arithmetic.
  assert.equal(m.MAX_CALLS, 100000)
  ;[1, 3.5, m.MAX_CALLS, m.MAX_CALLS - 1, 1].forEach((seconds) => {
    const found = at('b14', seconds, { subPulseLength: 1 })

    assert.ok(!found.reasons && between(found.position, bodyAt(14, seconds, 1)) <= 1e-6, `${seconds} s: whole one-second calls and a final partial call, including the budget boundary`)
  })
  ;[[m.MAX_CALLS + 1, 1], [3 * YEAR, 5]].forEach(([seconds, length]) => {
    const capped = at('b14', seconds, { subPulseLength: length })

    assert.deepEqual(capped.reasons, ['cadence-budget'], 'an in-horizon body exceeding the budget is refused, never coarsened')
    assert.deepEqual(capped.details, [`the horizon needs ${Math.ceil(seconds / length)} calls of ${length} s against a budget of ${m.MAX_CALLS}`], 'an exact horizon is refused on its whole calls alone')
  })
  const movingFacts = { ...scene.facts, clock: { ...CLOCK, subPulseLength: 1 } }
  const finalCall = bodyAt(14, m.MAX_CALLS, 1)
  const movingFrom = { Xcor: finalCall.Xcor + 5, Ycor: finalCall.Ycor }
  const finalArrival = adapt(scene, 'b14', { facts: movingFacts, at: GAME_TIME + m.MAX_CALLS - 0.5, from: movingFrom, speed: 50000 })
  const movingRefusal = adapt(scene, 'b14', { facts: movingFacts, at: GAME_TIME + m.MAX_CALLS + 0.5, from: movingFrom, speed: 50000 })

  assert.ok(finalArrival.solved && between(finalArrival.position, finalCall) <= 1e-6, 'movement can use exactly the inclusive final call, even before its ending boundary')
  assert.deepEqual(movingRefusal.reasons, ['cadence-budget'])
  assert.deepEqual(movingRefusal.details, ['the horizon needs 100001 calls of 1 s against a budget of 100000'], 'movement counts its opening call in the explicit refusal, each a whole call')
})

check('snapshot-partial', 'snapshots use the entire elapsed time, including below one call and a final partial call, with the same-time parent for moons, trojans and points', async (w) => {
  const scene = await w.scene()
  const length = 1800

  ;[length / 2, length, length + 905, 3 * length].forEach((seconds) => {
    PROPAGATED.forEach(([key]) => {
      const found = adapt(scene, key, { facts: { ...scene.facts, clock: { ...CLOCK, subPulseLength: length } }, at: GAME_TIME + seconds })
      const id = ENDPOINTS[key].id
      const expected = key.startsWith('p') ? pointAt(id, seconds, length) : bodyAt(key === 'c701' ? 10 : id, seconds, length)

      assert.ok(!found.reasons && between(found.position, expected) <= 1e-6, `${key}: ${seconds} s uses the independent source oracle`)
    })
  })
})

check('snapshot-cadence', 'only movement and eccentric propagation need cadence; a moon own circular bearing does not, but an eccentric parent still does', async (w) => {
  const scene = await w.scene()
  const clock = { ...CLOCK, orbitalMovementInSubPulse: null, subPulseLength: null, incrementLength: null }
  const moon = { ...scene.orbits.bodies[12], parentId: 10 }
  const parent = bodyAt(10, 0)
  const here = { Xcor: parent.Xcor + moon.distance * Math.cos(rad(moon.bearing - 90)), Ycor: parent.Ycor + moon.distance * Math.sin(rad(moon.bearing - 90)) }
  const endpoint = { ...ENDPOINTS.b12, ...here }
  const facts = { ...scene.facts, clock, orbits: { ...scene.orbits, bodies: { ...scene.orbits.bodies, 12: { ...moon, xcor: here.Xcor, ycor: here.Ycor } } } }
  const seconds = 905
  const nextParent = bodyAt(10, seconds)
  const bearing = turn(BODIES[12].B - 360 * seconds / (BODIES[12].year * 3600))
  const expected = { Xcor: nextParent.Xcor + moon.distance * Math.cos(rad(bearing - 90)), Ycor: nextParent.Ycor + moon.distance * Math.sin(rad(bearing - 90)) }
  const found = scene.m['orbit-propagation'].orbitAdapter(endpoint, { facts, at: GAME_TIME + seconds })

  assert.ok(!found.reasons && between(found.position, expected) <= 1e-6, 'a circular parent and moon need no cadence')
  assert.deepEqual(adapt(scene, 'b12', { facts: { ...scene.facts, clock }, at: GAME_TIME + seconds }).reasons, ['cadence-unread'], 'an eccentric ancestor needs cadence')
  assert.deepEqual(adapt(scene, 'b10', { facts, at: GAME_TIME, from: { Xcor: ENDPOINTS.b10.Xcor + 5, Ycor: ENDPOINTS.b10.Ycor }, speed: 50000 }).reasons, ['cadence-unread'], 'even circular movement needs its source phase')
})

check('partial-cache', 'partial snapshots never enter the whole-call cache: forward, backward and repeated queries leave snapshots and movement unchanged', async (w) => {
  const scene = await w.scene()
  const length = 1800

  ;[[905, 2705, 1800, 3600, 905], [3600, 2705, 905, 1800, 2705]].forEach((order) => {
    const facts = { ...scene.facts, clock: { ...CLOCK, subPulseLength: length }, orbits: { ...scene.orbits } }

    order.forEach((seconds) => {
      const found = adapt(scene, 'b27', { facts, at: GAME_TIME + seconds })

      assert.ok(!found.reasons && between(found.position, bodyAt(27, seconds, length)) <= 1e-6, `${seconds} s is independent of prior partial queries`)
    })
    const first = bodyAt(27, length, length)
    const from = { Xcor: first.Xcor + 5, Ycor: first.Ycor }
    const arrival = adapt(scene, 'b27', { facts, at: GAME_TIME, from, speed: 50000 })

    assert.ok(arrival.solved && between(arrival.position, first) <= 1e-6, 'movement still sees the whole opening call, not a cached partial')
  })
})

check('partial-budget', 'the inclusive eccentric budget counts a final partial evaluation, and the refusal states the whole calls, the short final call and the budget without coarsening or cache pollution', async (w) => {
  const scene = await w.scene()
  const rp = scene.m['route-position']
  const limit = scene.m['orbit-propagation'].MAX_CALLS
  const facts = { ...scene.facts, clock: { ...CLOCK, subPulseLength: 1 } }
  const ask = (seconds) => adapt(scene, 'b14', { facts, at: GAME_TIME + seconds })
  const partial = ask(limit - 0.5)

  assert.ok(!partial.reasons && between(partial.position, bodyAt(14, limit - 0.5, 1)) <= 1e-6, '99999 whole calls plus a partial is exactly within budget')
  assert.deepEqual(ask(limit + 0.5).reasons, ['cadence-budget'], '100000 whole calls plus a partial exceeds budget')
  assert.deepEqual(ask(limit + 0.5).details, ['the horizon needs 100000 calls of 1 s and a final call of 0.5 s, 100001 evaluations against a budget of 100000'], 'the refusal counts the evaluation once more and names its last call as short')
  const exact = ask(limit)

  assert.ok(!exact.reasons && between(exact.position, bodyAt(14, limit, 1)) <= 1e-6, 'a rejected partial query does not affect the exact budget boundary')

  const longFacts = { ...scene.facts, clock: { ...CLOCK, subPulseLength: 1800 } }
  const horizon = GAME_TIME + limit * 1800 + 900
  const bound = 'the horizon needs 100000 calls of 1800 s and a final call of 900 s, 100001 evaluations against a budget of 100000'

  assert.deepEqual(adapt(scene, 'b27', { facts: longFacts, at: horizon }).details, [bound], '100000 whole calls of the saved length and a 900 s remainder are 100001 evaluations')
  const refused = rp.positionRecord(ENDPOINTS.b27, { facts: longFacts, adapters: rp.ADAPTERS, at: horizon })
  const summary = rp.summarisePositions([refused], { merge: true })
  const figure = rp.withPositions(scene.m.provenance.ofRule({ rule: 'route.positionAge', value: 1 }), summary)

  assert.ok(summary.missing.includes(bound), 'the position provenance states the whole calls, the final call and the budget')
  assert.ok(rp.describePositions(summary).some((group) => group.conditions.some((condition) => condition.text === bound)), 'the position strip carries the same statement')
  assert.ok(figure.inputs.missing.includes(bound), 'a figure that rests on the position carries it')
})

check('family-rules', 'the families are the ones the saves support: a circular independent asteroid, a moon with a parent, a trojan, an eccentric planet, comet or asteroid, and nothing else', async (w) => {
  const m = (await w.modules())['orbit-propagation']
  const body = { fixed: 0, bodyClass: 3, trojan: 0, parentId: 0, eccentricity: 0 }
  const familyOf = (fields) => m.familyOf({ ...body, ...fields })

  assert.equal(familyOf({}), 'circular', 'an independent asteroid on a circle')
  assert.equal(familyOf({ bodyClass: 1 }), null, 'a circular planet')
  assert.equal(familyOf({ bodyClass: 5 }), null, 'a circular comet')
  assert.equal(familyOf({ bodyClass: 1, eccentricity: 0.1 }), 'eccentric')
  assert.equal(familyOf({ bodyClass: 5, eccentricity: 0.9 }), 'eccentric')
  assert.equal(familyOf({ eccentricity: 0.1 }), 'eccentric', 'an eccentric asteroid')
  assert.equal(familyOf({ bodyClass: 2, parentId: 4 }), 'moon')
  assert.equal(familyOf({ bodyClass: 2 }), null, 'a moon with no parent')
  assert.equal(familyOf({ trojan: 60, parentId: 4 }), 'trojan')
  assert.equal(familyOf({ trojan: 60 }), 'circular', 'an offset with no parent is not a trojan')
  assert.equal(familyOf({ fixed: 1, eccentricity: 0.1 }), null, 'a fixed body')
  assert.equal(familyOf({ bodyClass: 4 }), null, 'a class that is not known')
})

check('motion-switch', 'a body that the save does not move stays where it was saved, an unrecorded switch is not guessed, and the asteroid switch gates nothing', async (w) => {
  const scene = await w.scene()
  const later = GAME_TIME + 3e6
  const withClock = (clock) => ({ ...scene.facts, clock: { ...CLOCK, ...clock } })
  const held = (key, clock) => adapt(scene, key, { facts: withClock(clock), at: later })

  ;['b10', 'b11', 'b12', 'b13', 'b14', 'p31'].forEach((key) => {
    assert.ok(between(held(key, { orbitalMotion: 0 }).position, ENDPOINTS[key]) <= 1e-6, `${key}: planet and moon motion off holds everything`)
  })
  ;['b10', 'b11', 'b14', 'p31'].forEach((key) => assert.deepEqual(held(key, { orbitalMotion: null }).reasons, ['motion-switch'], `${key}: the switch not recorded`))
  ;[0, null, 1].forEach((asteroids) => {
    assert.ok(between(held('b10', { orbitalMotionAst: asteroids }).position, bodyAt(10, elapsedAt(later))) <= 1, `an independent asteroid moves whatever its own switch reads (${asteroids})`)
    assert.ok(between(held('b14', { orbitalMotionAst: asteroids }).position, bodyAt(14, elapsedAt(later))) <= 1, `and an eccentric one (${asteroids})`)
    assert.ok(between(held('b11', { orbitalMotionAst: asteroids }).position, bodyAt(11, elapsedAt(later))) <= 1, `and a planet (${asteroids})`)
  })
})

check('lagrange-transfer', 'a Lagrange transfer is flown leg by leg at the time each is entered, so its length depends on when the fleet leaves and on the direction', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const speed = 1500
  const flight = m['route-plan'].flightOf({ facts: scene.facts, adapters: m['route-position'].ADAPTERS, speed })
  const near = (point, offset) => ({ Xcor: point.Xcor + offset, Ycor: point.Ycor, SystemID: 1 })
  const a = near(pointAt(31, elapsedAt(GAME_TIME)), 5e6)
  const b = near(pointAt(32, elapsedAt(GAME_TIME + 9000)), 2e7)

  // The oracle: the straight line, and each ordered pair of points, the entry flown to and the exit taken where that point is when the entry is reached.
  const oracle = (start, end, depart) => {
    const lp = { 31: (t) => pointAt(31, elapsedAt(t)), 32: (t) => pointAt(32, elapsedAt(t)) }
    const candidates = [{ km: between(start, end), via: null }]

    ;[[31, 32], [32, 31]].forEach(([entry, exit]) => {
      const seconds = arrivalOf(start, depart, speed, (time) => pointDuring(entry, elapsedAt(time)))
      const entered = pointDuring(entry, elapsedAt(depart + seconds))
      const left = lp[exit](depart + seconds)

      candidates.push({ km: between(start, entered) + between(left, end), via: [entry, exit] })
    })

    return candidates.sort((x, y) => x.km - y.km)[0]
  }
  const flown = (start, end, depart) => m['jump-graph'].flightInSystem(start, end, LAGRANGE_ROWS, m['route-plan'].motionOf(flight, depart), depart)
  const cases = [[a, b, GAME_TIME, 'out'], [b, a, GAME_TIME, 'back'], [a, b, GAME_TIME + 2e7, 'later']]
  const results = cases.map(([start, end, depart, label]) => {
    const expected = oracle(start, end, depart)
    const found = flown(start, end, depart)

    assert.ok(Math.abs(found.km - expected.km) <= 3000, `${label}: the flight is ${expected.km} km, not ${found.km}`)
    assert.deepEqual(found.via ? found.via.map((point) => point.LagrangePointID) : null, expected.via, `${label}: the same Lagrange points`)

    return { found, expected }
  })

  assert.ok(results[0].expected.via, 'the transfer shortens the way out')
  assert.ok(results[1].expected.via, 'and the way back')
  assert.ok(Math.abs(results[0].found.km - results[1].found.km) > 1000, 'a way out and back are not the same length: the exit is taken where it is when the entry is reached')
  assert.ok(!results[2].found.via || results[2].found.km !== results[0].found.km, 'leaving later is another flight')
  assert.ok(results[0].found.records.length > 0, 'a flight states the positions it rests on')

  // A destination that moves: the last leg of a transfer is flown from the exit at the time the entry is reached, to where the destination is then.
  const reach = (point, from, time) => ({ Xcor: point.Xcor + (point.drift || 0) * time, Ycor: point.Ycor, time: time + (from ? Math.hypot(from.Xcor - point.Xcor, from.Ycor - point.Ycor) : 0), record: null })
  const rows = [{ Xcor: 1000, Ycor: 0, SystemID: 1 }, { Xcor: 5000, Ycor: 0, SystemID: 1 }]
  const drifting = m['jump-graph'].flightInSystem({ Xcor: 0, Ycor: 0, SystemID: 1 }, { Xcor: 5000, Ycor: 100, drift: 1, SystemID: 1 }, rows, { speed: 1, reach }, 0)

  assert.deepEqual(drifting.via, rows, 'the transfer is taken')
  assert.ok(Math.abs(drifting.km - (1000 + Math.hypot(1000, 100))) < 1e-6, `the last leg ends where the destination is when the entry is reached, not where it is at the departure: ${drifting.km}`)

  // A route flown again: each flight leaves when the one before has arrived.
  const steps = [{ kind: 'fly', SystemID: 1, to: { Xcor: 1000, Ycor: 0 } }, { kind: 'fly', SystemID: 1, to: { Xcor: 1000, Ycor: 500, drift: 1 } }]
  const again = m['jump-graph'].flyRoute(steps, { from: { Xcor: 0, Ycor: 0 }, time: 0, motion: { speed: 1, reach } })

  assert.ok(Math.abs(again.flights[1] - Math.hypot(1000, 500)) < 1e-6, `the second flight leaves at the time the first arrives: ${again.flights[1]}`)
  assert.ok(Math.abs(again.seconds - (1000 + Math.hypot(1000, 500))) < 1e-6, 'and the seconds are the sum of the flights over the speed')
})

check('successive-cycles', 'a repeated trip arrives at the position the body has reached, waits there and leaves from where the body then is, so every cycle starts from the last arrival and takes the waits as time', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const facts = { ...scene.facts, clock: { ...CLOCK, subPulseLength: 1 } }
  const speed = 1500
  const waits = [6 * 3600, 3 * 3600]
  const hop = (from, to, wait) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, wait })
  const hops = [hop(ENDPOINTS.b10, ENDPOINTS.b19, waits[0]), hop(ENDPOINTS.b19, ENDPOINTS.b10, waits[1])]
  const result = m['route-plan'].simulateCycles({ hops, facts, adapters: m['route-position'].ADAPTERS, speed })

  // The oracle: the same trip walked body by body.
  const ids = [19, 10]
  const kms = []
  const cycles = []
  let time = GAME_TIME
  let at = { Xcor: ENDPOINTS.b10.Xcor, Ycor: ENDPOINTS.b10.Ycor }
  let firstSeconds = null

  for (let cycle = 0; cycle < 1000 && (!cycle || time - GAME_TIME < YEAR); cycle += 1) {
    const mark = kms.length

    ids.forEach((id, index) => {
      const positionAt = (when) => bodyDuring(id, elapsedAt(when), 1)
      const seconds = arrivalOf(at, time, speed, positionAt)

      kms.push(between(at, positionAt(time + seconds)))
      time += seconds + waits[index]
      at = bodyAt(id, elapsedAt(time), 1)
    })
    cycles.push(kms.slice(mark))

    if (!cycle) {
      firstSeconds = time - GAME_TIME
    }
  }

  const mean = kms.reduce((sum, value) => sum + value, 0) / kms.length
  const savedMean = between(ENDPOINTS.b10, ENDPOINTS.b19)

  assert.equal(result.annual.status, 'propagated')
  assert.equal(result.annual.cycles, cycles.length, 'the same number of cycles in the year')
  assert.equal(result.annual.hops, kms.length)
  assert.ok(Math.abs(result.annual.meanKm - mean) <= 2000, `the mean flight is the walked one: ${result.annual.meanKm} against ${mean}`)
  assert.ok(Math.abs(result.first.kmTotal - cycles[0].reduce((sum, value) => sum + value, 0)) <= 4000, 'the first cycle')
  assert.ok(Math.abs(result.first.seconds - firstSeconds) <= 4, 'the cycle takes its flights and its waits')
  assert.ok(Math.abs(result.static.meanKm - savedMean) <= 1e-6, 'the saved figure stands beside it')
  assert.ok(Math.abs(mean - savedMean) > 1e5, 'and is not the propagated one')
  assert.ok(cycles.length > 2 && Math.abs(cycles[1][0] - cycles[0][0]) > 1e4, 'the second cycle leaves from the first one\'s arrival, not from where the body was saved')
  assert.ok(result.annual.positions.records.every((record) => record.basis === 'propagated'), 'every moving endpoint is stated as propagated')
  assert.equal(result.annual.positions.mode, 'propagated')

  const wait = m['route-plan'].simulateCycles({ hops: [{ ...hops[0], leave: ENDPOINTS.b15 }, hops[1]], facts, adapters: m['route-position'].ADAPTERS, speed })

  assert.equal(wait.annual.status, 'static', 'an exit that is not propagated is said')
})

check('fallbacks', 'every case that is not propagated keeps the saved figure and states its reason: an unsupported family, an unsurveyed system, an orbit that does not rebuild or is missing, a horizon past one orbit, a fleet that is slower, has no engines or does not converge, a contact seen earlier and a fleet with queued orders', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const adapters = m['route-position'].ADAPTERS
  const cycleOf = (key, { wait = 3600, ...options } = {}) => {
    const to = ENDPOINTS[key]
    const hop = (a, b, wait) => ({ steps: [{ kind: 'fly', SystemID: 1, from: a, to: b, via: null }], from: a, to: b, wait })

    return m['route-plan'].simulateCycles({ hops: [hop(ENDPOINTS.b10, to, wait), hop(to, ENDPOINTS.b10, wait)], facts: scene.facts, adapters, speed: 1500, ...options })
  }
  const stated = (result, code) => {
    assert.equal(result.annual.status, 'static', `${code}: the year is the saved one`)
    assert.ok(result.annual.reasons.includes(code), `${code}: and says why (${result.annual.reasons})`)
    assert.ok(Math.abs(result.annual.meanKm - result.static.meanKm) < 1e-6, `${code}: with the saved figure`)
    assert.ok(result.annual.positions.records.some((record) => record.conditions.includes(code)), `${code}: and the strip's records state it`)
  }

  stated(cycleOf('b15'), 'orbit-family')
  stated(cycleOf('b16'), 'orbit-unsurveyed')
  stated(cycleOf('b17'), 'orbit-mismatch')
  stated(cycleOf('b18'), 'orbit-missing')
  stated(cycleOf('b21'), 'orbit-star')
  stated(cycleOf('b19', { speed: 31 }), 'arrival-diverged')
  stated(cycleOf('b19', { speed: 20 }), 'fleet-slower')
  stated(cycleOf('b19', { speed: 1 }), 'fleet-immobile')
  stated(cycleOf('b19', { speed: null }), 'speed-unknown')
  stated(cycleOf('b19', { facts: { ...scene.facts, orbits: null } }), 'orbit-unread')
  stated(cycleOf('b19', { facts: { ...scene.facts, clock: { ...CLOCK, orbitalMotion: null } } }), 'motion-switch')
  assert.equal(cycleOf('b19', { facts: { ...scene.facts, clock: null } }), null, 'with no clock there is no flight to state')
  assert.equal(cycleOf('b19', { adapters: {} }), null, 'with no adapters there is none either')

  // A shorter-period eccentric body crosses its own horizon during a real year of flights, without backdating its saved coordinates.
  const late = cycleOf('b23', { facts: { ...scene.facts, clock: { ...CLOCK, subPulseLength: 360 } }, speed: 50000, wait: 86400 })

  stated(late, 'orbit-horizon')
  assert.equal(late.first.positions.mode, 'propagated', 'the first cycle states its own mode')
  assert.notEqual(late.annual.positions.mode, 'propagated')

  // A fleet is not carried, and a contact seen earlier is not, whatever the adapters are.
  const rp = m['route-position']
  const facts = { ...scene.facts, fleets: { 7: { lastMoveTime: 4990000, following: false, orders: 2, anchor: 0 } } }
  const crowd = rp.routePositions([{ family: 'fleet', key: 'fleet:7', id: 7, SystemID: 1, Xcor: 1, Ycor: 1 }, { family: 'contact', key: 'contact:9', id: 9, SystemID: 1, Xcor: 2, Ycor: 2, lastUpdate: 4990000 }], { facts, adapters })

  assert.deepEqual(Object.keys(adapters).sort(), ['body', 'colony', 'fleet', 'lagrange-point', 'lifepod', 'salvo', 'waypoint', 'wreck'], 'only bodies, what sits on one and the objects a Lagrange point carries are propagated')
  crowd.records.forEach((record) => assert.equal(record.basis, 'static', `${record.identity.key} stays at its saved position`))
  assert.ok(crowd.records[0].conditions.includes('fleet-orders'))
  assert.ok(crowd.records[1].conditions.includes('stale-contact'))
  assert.equal(crowd.mode, 'static')
})

check('plan-gate', 'a plan takes the adapted positions: each leg leaves when the one before arrives, the saved figure stands beside it, and the cases that stay static say why, with no adapters nothing changes', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const plan = m['route-plan']
  const adapters = m['route-position'].ADAPTERS
  const speed = 1500
  const place = (kind, id) => ({ key: `${kind}:${id}`, kind, name: `${kind} ${id}`, SystemID: 1, Xcor: ENDPOINTS[kind === 'colony' ? 'c701' : `b${id}`].Xcor, Ycor: ENDPOINTS[kind === 'colony' ? 'c701' : `b${id}`].Ycor })
  const stops = [place('colony', 701), place('body', 19)]
  const options = { cycle: true, jumpPoints: [], facts: scene.facts }
  const flown = plan.planRoute(stops, { ...options, adapters, speed })
  const held = plan.planRoute(stops, options)

  const first = arrivalOf(ENDPOINTS.b10, GAME_TIME, speed, (time) => bodyDuring(19, elapsedAt(time)))
  const reached = bodyDuring(19, elapsedAt(GAME_TIME + first))
  const back = arrivalOf(reached, GAME_TIME + first, speed, (time) => bodyDuring(10, elapsedAt(time)))
  const home = bodyDuring(10, elapsedAt(GAME_TIME + first + back))

  assert.equal(flown.legs.length, 2)
  assert.ok(Math.abs(flown.legs[0].route.km - between(ENDPOINTS.b10, reached)) <= 3000, 'the first leg flies to where the body is when it gets there')
  assert.ok(Math.abs(flown.legs[1].route.km - between(reached, home)) <= 6000, 'and the leg back leaves from that arrival, to where the first stop is by then')
  assert.ok(Math.abs(flown.legs[1].route.km - between(ENDPOINTS.b19, home)) > 1000, 'not from the saved position of the stop')
  assert.equal(flown.legs[0].staticKm, held.legs[0].route.km, 'each leg has its figure on the saved positions')
  assert.equal(flown.static.km, held.km, 'and the plan its total')
  assert.equal(flown.positions.mode, 'propagated')
  assert.equal(held.positions.mode, 'static', 'a plan with no adapters is the saved one')
  assert.equal(held.static, undefined)
  assert.ok(flown.km !== held.km)

  const pair = [place('body', 15), place('body', 17)]
  const unsupported = plan.planRoute(pair, { ...options, adapters, speed })
  const unsupportedHeld = plan.planRoute(pair, options)

  assert.equal(unsupported.km, unsupportedHeld.km, 'stops that are not propagated keep the saved distance')
  assert.ok(unsupported.positions.records.some((record) => record.conditions.includes('orbit-family')), 'and state why')
  assert.ok(unsupported.positions.records.some((record) => record.conditions.includes('orbit-mismatch')), 'including a rebuilt position that is not the saved one')

  const unfast = plan.planRoute(stops, { ...options, adapters, speed: null })

  assert.equal(unfast.km, held.km, 'with no speed there is no arrival')
  assert.ok(unfast.positions.records.some((record) => record.conditions.includes('speed-unknown')))
})

check('unsurveyed-read', 'orbit fields are read only for systems the race has surveyed, of its own game, and a save that lacks a table reads as unknown', async (w) => {
  const scene = await w.scene()
  const m = scene.m['orbit-propagation']

  assert.equal(scene.orbits.hidden[16], 2, 'the body of the unsurveyed system is named, no more')
  assert.equal(scene.orbits.bodies[16], undefined)
  assert.equal(scene.orbits.hidden[10], undefined, 'a body of a surveyed system is read')
  assert.ok(Object.values(scene.orbits.bodies).every((body) => body.systemId === 1) && Object.keys(scene.orbits.bodies).every((id) => Number(id) !== 16), 'the unsurveyed body\'s orbit is not in the read')
  assert.ok(!scene.orbits.stars[2], 'nor its star')

  const readsOrbits = scene.log.filter((sql) => /OrbitalDistance/.test(sql))

  assert.ok(readsOrbits.length > 0)
  readsOrbits.forEach((sql) => {
    const ids = (/SystemBodyID in \(([\d,]+)\)/.exec(sql) || [])[1] || ''

    assert.ok(!ids.split(',').includes('16'), 'no read of orbit fields names the unsurveyed body')
  })
  assert.ok(scene.log.some((sql) => /FCT_RaceSysSurvey/.test(sql) && /RaceID = 2/.test(sql)), 'the race is the one asked for')

  const bare = await databaseOf('create table FCT_Game (GameID integer);', '')
  const none = await m.loadOrbitFacts(bare, { GameID: GAME, RaceID: RACE }, [ENDPOINTS.b10])

  assert.ok(none.problems.length > 0, 'a save without the tables says what it lacks')

  const noneOf = await m.loadOrbitFacts(bare, { GameID: GAME, RaceID: RACE }, [ENDPOINTS.b10, ENDPOINTS.c701, ENDPOINTS.p31])

  assert.equal(noneOf.problems.length, 3, 'a body, a star and a survey table without their columns each say so')

  const narrow = await databaseOf(SCHEMA.replace('create table FCT_Population (PopulationID integer, GameID integer, SystemBodyID integer);', 'create table FCT_Population (GameID integer);').replace(/create table FCT_LagrangePoint \([^)]*\);/, 'create table FCT_LagrangePoint (LagrangePointID integer);'), '')
  const narrowFacts = await m.loadOrbitFacts(narrow, { GameID: GAME, RaceID: RACE }, [ENDPOINTS.c701, ENDPOINTS.p31])

  assert.equal(narrowFacts.problems.length, 2, 'a colony and a Lagrange point without their columns each say so')
  ;[...noneOf.problems, ...narrowFacts.problems].forEach((text) => assert.ok(text.startsWith('The save lacks ') || text.startsWith('the save has no '), `${text} says what the save lacks`))
  ;[...noneOf.problems, ...narrowFacts.problems].forEach((text) => assert.ok(!/\b(?:FCT|DIM|VIR)_|\.\w|[a-z][A-Z]/.test(text), `${text} names no table or column`))
  assert.deepEqual(none.bodies, {})
  assert.deepEqual(m.orbitAdapter(ENDPOINTS.b10, { facts: { clock: CLOCK, orbits: none }, at: GAME_TIME + 1 }).reasons, ['orbit-missing'])
})

check('cache', 'a propagated result is kept per save, profile and scenario, and goes with the orbit read or a write to the save', async (w) => {
  const scene = await w.scene()
  const m = scene.m['orbit-propagation']
  const database = await databaseOf(SCHEMA, rowsOf())

  scene.m['query-cache'].cacheQueries(database)

  const ids = { GameID: GAME, RaceID: RACE }
  const endpoints = [ENDPOINTS.b10, ENDPOINTS.b19]
  const facts = await m.loadOrbitFacts(database, ids, endpoints)

  assert.equal(await m.loadOrbitFacts(database, ids, endpoints), facts, 'the same read is kept')
  assert.notEqual(await m.loadOrbitFacts(database, ids, [ENDPOINTS.b10]), facts, 'another set of endpoints is another read')

  let computed = 0
  const ask = (profile, scenario, read = facts) => m.cachedPropagation(database, 'unit', { facts: read, profile, scenario }, () => ({ computed: (computed += 1) }))
  const one = ask(1500, 'a')

  assert.equal(ask(1500, 'a'), one, 'asked again')
  assert.equal(computed, 1)
  ask(900, 'a')
  assert.equal(computed, 2, 'another speed works it out again')
  ask(900, 'b')
  assert.equal(computed, 3, 'another scenario')
  ask(900, 'a')
  assert.equal(computed, 3, 'the scenarios are kept apart')
  ask({ speed: 900, ships: 4 }, 'c')
  ask({ speed: 900, ships: 4 }, 'c')
  assert.equal(computed, 4, 'a profile is compared by its value')
  ask({ speed: 900, ships: 5 }, 'c')
  assert.equal(computed, 5)
  ask(900, 'b', { ...facts })
  assert.equal(computed, 6, 'another read of the orbits')
  ask(900, 'a')
  assert.equal(computed, 6, 'the first read of the orbits is still kept')
  ask(900, 'a', { ...facts })
  assert.equal(computed, 7, 'a read of the orbits that is another object is another result')

  const fresh = { ...facts }

  ask(900, 'd', fresh)
  ask(900, 'd', fresh)
  assert.equal(computed, 8)
  await database.query('update FCT_SystemBody set Xcor = Xcor + 1 where SystemBodyID = 10')
  ask(900, 'd', fresh)
  assert.equal(computed, 9, 'a write to the save')
})

check('registration', 'the adapters are registered at the one gate with the states of every reason, and the limits are the stated ones', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const orbit = m['orbit-propagation']

  assert.deepEqual(Object.keys(rp.ADAPTERS).sort(), ['body', 'colony', 'fleet', 'lagrange-point', 'lifepod', 'salvo', 'waypoint', 'wreck'])
  Object.entries(rp.ADAPTERS).forEach(([family, adapter]) => assert.equal(adapter, orbit.ANCHOR_FAMILIES.includes(family) ? orbit.anchorAdapter : orbit.orbitAdapter, `${family}: the adapter of its kind`))
  assert.deepEqual({ ...rp.NO_ADAPTERS }, {}, 'a consumer that passes no adapters has the static positions')
  orbit.REASONS.forEach((code) => assert.ok(typeof rp.CONDITIONS[code] === 'string' && rp.CONDITIONS[code].length > 20, `${code}: a text of its own`))
  assert.equal(new Set(orbit.REASONS.map((code) => rp.CONDITIONS[code])).size, orbit.REASONS.length, 'each reason reads differently')
  assert.equal(orbit.REBUILD_TOLERANCE_KM, 1)
  assert.equal(orbit.ARRIVAL_TOLERANCE_SECONDS, 1)
  assert.equal(orbit.ARRIVAL_MAX_EVALUATIONS, 8)
  assert.equal(orbit.ECCENTRIC_STEP_SECONDS, undefined, 'the fitted step is gone')
  assert.equal(orbit.MAX_CALLS, 100000)

  const body = { family: 'body', key: 'body:10', id: 10, SystemID: 1, Xcor: 1, Ycor: 2 }
  const none = rp.positionRecord(body, { facts: { clock: CLOCK } })
  const reasoned = rp.positionRecord(body, { facts: { clock: CLOCK, orbits: null }, adapters: rp.ADAPTERS, at: GAME_TIME + 1 })

  assert.equal(none.basis, 'static')
  assert.equal(reasoned.basis, 'static')
  assert.ok(reasoned.conditions.includes('propagation-unavailable') && reasoned.conditions.includes('orbit-unread'), 'a record that could not be moved on says so and why')
})

// ---- The anchor family ------------------------------------------------------------------------------------------------
// The objects a Lagrange point carries (fleets, waypoints, wrecks, life pods, missile salvos). No save holds one (neither line fixture has an object whose point is above 0), so each is planted in a database of its own that the loaders of the pages read as they read a save. A moving object is looked at at the saved epoch and at whole calls after it, where the position of a point is the same whichever call a moment between two calls is given to, so the cases do not depend on which call such a moment belongs to.
const ANCHOR_SCHEMA = `
  ${SCHEMA}
  create table FCT_Game (GameID integer, GameTime real, LastGrowthTime real, OrbitalMotion integer, OrbitalMotionAst integer, OrbitalMovementInSubPulse integer, SubPulseLength integer);
  create table FCT_Increments (IncrementID integer, GameID integer, GameTime real, Length integer);
  create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, LastMoveTime real, OrbitBodyID integer, Xcor real, Ycor real, AnchorFleetID integer, OrbitLagrangeID integer, LagrangeStatus integer, SystemID integer);
  create table FCT_MoveOrders (MoveOrderID integer, GameID integer, FleetID integer, MoveOrder integer, MoveActionID integer, DestinationType integer, DestinationID integer, DestinationItemID integer, NewWarpPointID integer, MinDistance real);
  create table FCT_Waypoint (WaypointID integer, GameID integer, RaceID integer, SystemID integer, OrbitBodyID integer, OrbitLagrangeID integer, Xcor real, Ycor real);
  create table FCT_Wrecks (WreckID integer, GameID integer, SystemID integer, OrbitLagrangeID integer, Xcor real, Ycor real);
  create table FCT_Lifepods (LifepodID integer, GameID integer, SystemID integer, OrbitLagrangeID integer, Xcor real, Ycor real);
  create table FCT_MissileSalvo (MissileSalvoID integer, GameID integer, RaceID integer, SystemID integer, OrbitLagrangeID integer, Xcor real, Ycor real);
`

// An object of the planted save: `point` is the point it references (`OrbitLagrangeID`), `stands` the point whose saved position it stands at (`dx` km along the axis away from it), `rides` the point it is expected to ride (0 for none), `read` how the loaders are expected to read it ('riding', 'apart', 'inconsistent' or 'unread') and `has` the conditions its record is expected to state when no adapter moves it. Another race's waypoint and salvo, a wreck of a system the race has not surveyed and an object that references no point are not read.
const planted = (family, id, fields = {}) => ({ family, id, system: 1, point: 0, dx: 0, race: RACE, orders: 0, hold: 0, mode: 2, rides: 0, read: 'unread', has: [], ...fields, stands: fields.stands === undefined ? fields.point || 0 : fields.stands })

const OBJECTS = [
  planted('fleet', 101, { point: 31, rides: 31, read: 'riding' }),
  planted('fleet', 102, { point: 31, dx: 5000, read: 'apart' }),
  planted('fleet', 103, { point: 31, orders: 2, read: 'riding', has: ['fleet-orders'] }),
  planted('fleet', 104, { point: 31, system: 2, read: 'inconsistent', has: ['fleet-point-inconsistent'] }),
  planted('fleet', 105, { point: 33, rides: 33, read: 'riding' }),
  planted('fleet', 106, { point: 32, hold: 101, read: 'riding', has: ['fleet-anchored'] }),
  planted('fleet', 107, { point: 32, mode: 1, rides: 32, read: 'riding' }),
  planted('fleet', 108, { read: 'apart' }),
  planted('waypoint', 201, { point: 32, rides: 32, read: 'riding' }),
  planted('waypoint', 202, { read: 'apart' }),
  planted('waypoint', 203, { point: 32, system: 2, read: 'inconsistent', has: ['anchor-point-inconsistent'] }),
  planted('waypoint', 204, { point: 32, dx: 5000, read: 'riding' }),
  planted('waypoint', 205, { point: 31, rides: 31, read: 'riding' }),
  planted('waypoint', 206, { point: 31, race: 3, has: ['waypoint-orbit-unread'] }),
  planted('wreck', 301, { point: 31, rides: 31, read: 'riding' }),
  planted('wreck', 302, { stands: 31, has: ['wreck-orbit-tie'] }),
  planted('wreck', 303, { point: 31, system: 2, has: ['wreck-orbit-tie'] }),
  planted('wreck', 304, { point: 31, dx: 5000, read: 'riding' }),
  planted('wreck', 305, { point: 99, stands: 31, read: 'inconsistent', has: ['wreck-orbit-tie', 'anchor-point-inconsistent'] }),
  planted('wreck', 306, { point: 34, stands: 31, read: 'inconsistent', has: ['wreck-orbit-tie', 'anchor-point-inconsistent'] }),
  planted('lifepod', 401, { point: 32, rides: 32, read: 'riding' }),
  planted('lifepod', 402, { stands: 32, has: ['drift-unobserved'] }),
  planted('lifepod', 403, { point: 32, dx: 5000, read: 'riding' }),
  planted('salvo', 501, { point: 31, rides: 31, read: 'riding' }),
  planted('salvo', 502, { point: 31, race: 3, has: ['salvo-unanchored'] }),
  planted('salvo', 503, { point: 31, dx: 5000, read: 'riding' }),
  planted('salvo', 504, { point: 31, system: 2, read: 'inconsistent', has: ['salvo-unanchored', 'anchor-point-inconsistent'] }),
  planted('salvo', 505, { stands: 31, has: ['salvo-unanchored'] }),
]

// The move orders planted for a fleet: the bodies it is ordered to, in turn (an order to a body of the system: type 2).
const PLANTED_ORDERS = { 103: [19, 14] }

const FACTS_OF = { fleet: 'fleets', waypoint: 'waypoints', wreck: 'wrecks', lifepod: 'lifepods', salvo: 'salvos' }

const placeOfObject = (object) => (object.stands > 0 ? { Xcor: pointAt(object.stands, 0).Xcor + object.dx, Ycor: pointAt(object.stands, 0).Ycor } : { Xcor: 1000 + object.id, Ycor: 2000 + object.id })

const anchorEndpoint = (object) => ({ family: object.family, key: `${object.family}:${object.id}`, id: object.id, name: `${object.family} ${object.id}`, SystemID: object.system, ...placeOfObject(object) })

const ANCHOR_INSERTS = {
  fleet: (o, at) => `insert into FCT_Fleet values (${o.id}, ${GAME}, ${o.race}, ${GAME_TIME - 1000}, 0, ${at.Xcor}, ${at.Ycor}, ${o.hold}, ${o.point}, ${o.mode}, ${o.system});`,
  waypoint: (o, at) => `insert into FCT_Waypoint values (${o.id}, ${GAME}, ${o.race}, ${o.system}, 0, ${o.point}, ${at.Xcor}, ${at.Ycor});`,
  wreck: (o, at) => `insert into FCT_Wrecks values (${o.id}, ${GAME}, ${o.system}, ${o.point}, ${at.Xcor}, ${at.Ycor});`,
  lifepod: (o, at) => `insert into FCT_Lifepods values (${o.id}, ${GAME}, ${o.system}, ${o.point}, ${at.Xcor}, ${at.Ycor});`,
  salvo: (o, at) => `insert into FCT_MissileSalvo values (${o.id}, ${GAME}, ${o.race}, ${o.system}, ${o.point}, ${at.Xcor}, ${at.Ycor});`,
}

const anchorRows = () => [
  rowsOf(),
  `insert into FCT_Game values (${GAME}, ${GAME_TIME}, ${CLOCK.lastGrowthTime}, 1, 0, 1, ${SUBPULSE});`,
  `insert into FCT_Increments values (1, ${GAME}, ${GAME_TIME - 10}, ${INCREMENT});`,
  // A point of another game under the ID a wreck of this game references: it is not that wreck's point.
  `insert into FCT_LagrangePoint values (34, 2, 1, 25, 2, 0, ${pointAt(31, 0).Xcor}, ${pointAt(31, 0).Ycor});`,
  ...OBJECTS.map((object) => ANCHOR_INSERTS[object.family](object, placeOfObject(object))),
  // A wreck of another game under the ID of a wreck of this one, at a point of this game that nothing of this game references: neither its point nor its place in the read of the wrecks is this game's.
  `insert into FCT_LagrangePoint values (35, ${GAME}, 1, 26, 1, 0, 5, 5);`,
  'insert into FCT_Wrecks values (301, 2, 1, 35, 5, 5);',
  ...Object.entries(PLANTED_ORDERS).flatMap(([fleet, bodies]) => bodies.map((body, index) => `insert into FCT_MoveOrders values (${Number(fleet) * 10 + index}, ${GAME}, ${fleet}, ${index + 1}, 0, 2, ${body}, 0, 0, 0);`)),
].join('\n')

// The loaders' `database.query(sql, { replacements })` over a node-sqlite3 handle, which this file's `databaseOf` does not apply.
const anchorDatabaseOf = async (schema = ANCHOR_SCHEMA, rows = anchorRows()) => {
  const raw = new sqlite3.Database(':memory:')
  const exec = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

  await exec(schema)
  await exec(rows)

  return {
    query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => raw.all(sql.replace(/:([A-Za-z]+)\b/g, (_match, name) => String(replacements[name])), (error, found) => (error ? reject(error) : resolve([found])))),
    close: () => raw.close(),
  }
}

const IDS = { GameID: GAME, RaceID: RACE }

const anchorScenes = new WeakMap()

// The planted save, its two reads (the pages' orbit read for every planted object, and the position read) and the facts they make.
const anchorScene = (w) => {
  if (!anchorScenes.has(w)) {
    anchorScenes.set(w, (async () => {
      const m = await w.modules()
      const database = await anchorDatabaseOf()
      const orbits = await m['orbit-propagation'].loadOrbitFacts(database, IDS, [...OBJECTS.map(anchorEndpoint), ENDPOINTS.c701, ENDPOINTS.b19, ENDPOINTS.b14])
      const positions = await m['route-position'].loadPositionFacts(database, IDS)

      return { m, database, orbits, positions, facts: { ...positions, orbits } }
    })())
  }

  return anchorScenes.get(w)
}

const RIDERS = OBJECTS.filter((object) => object.rides > 0)
// The riders of a point that moves: the point of an asteroid is never moved by the game.
const MOVERS = RIDERS.filter((object) => object.rides !== 33)
const MODES = [{ name: 'a sub-pulse', clock: {}, call: SUBPULSE, calls: [1, 24, 100] }, { name: 'an increment', clock: { orbitalMovementInSubPulse: 0 }, call: INCREMENT, calls: [1, 7, 40] }]
const UNANCHORED_TREATMENT = ['wreck-orbit-tie', 'drift-unobserved', 'salvo-unanchored', 'fleet-point-inconsistent', 'anchor-point-inconsistent', 'waypoint-orbit-unread', 'anchor-unread']
const withClock = (facts, clock) => ({ ...facts, clock: { ...facts.clock, ...clock } })
const coordinatesOf = (position) => ({ Xcor: position.Xcor, Ycor: position.Ycor })

check('anchor-read', 'the loaders select non-fleet followers by same-game/system point reference and fleets by exact coincidence, read each point orbit, keep race and survey scope, and disclose missing fields', async (w) => {
  const { m, orbits, positions } = await anchorScene(w)

  assert.deepEqual(asJson(positions.problems), [], 'the planted save reads whole')
  assert.deepEqual(asJson(orbits.problems), [])
  assert.deepEqual(asJson(positions.clock), asJson(CLOCK), 'the planted clock is the one of the other cases')
  assert.equal(OBJECTS.length, 28)

  OBJECTS.forEach((object) => {
    const found = positions[FACTS_OF[object.family]][object.id]
    const label = `${object.family} ${object.id}`

    if (object.read === 'unread') {
      assert.equal(found, undefined, `${label}: not read`)
    } else {
      assert.ok(found, `${label}: read`)
      assert.equal(Boolean(found.riding), object.read === 'riding', `${label}: source follower eligibility`)
      assert.equal(Boolean(found.pointInconsistent), object.read === 'inconsistent', `${label}: a point outside its game or system is stated`)

      if (object.family !== 'waypoint' || object.point) {
        assert.equal(found.point, object.point, `${label}: the point it references`)
      }
    }
  })

  assert.deepEqual(Object.keys(orbits.points).map(Number).sort(), [31, 32, 33], 'the orbit of every point an object references is read, and no more, the point of another game among them')

  // A table that holds the objects without the point they reference says so, in words, in both reads; a save with no such table has no such objects.
  const rowsWithout = (pattern) => anchorRows().split('\n').filter((line) => !pattern.test(line)).join('\n')
  const lacking = await anchorDatabaseOf(ANCHOR_SCHEMA.replace('create table FCT_Wrecks (WreckID integer, GameID integer, SystemID integer, OrbitLagrangeID integer, Xcor real, Ycor real);', 'create table FCT_Wrecks (WreckID integer, GameID integer, SystemID integer, Xcor real, Ycor real);'), rowsWithout(/FCT_Wrecks/))
  const lackingOrbits = await m['orbit-propagation'].loadOrbitFacts(lacking, IDS, OBJECTS.filter((object) => object.family === 'wreck').map(anchorEndpoint))
  const lackingPositions = await m['route-position'].loadPositionFacts(lacking, IDS)

  assert.equal(lackingOrbits.problems.length, 1)
  assert.equal(lackingPositions.problems.length, 1)
  ;[...lackingOrbits.problems, ...lackingPositions.problems].forEach((text) => assert.ok(!/\b(?:FCT|DIM|VIR)_|\.\w|[a-z][A-Z]/.test(text) && /wrecks/.test(text), `${text} names the kind and no table or column`))
  assert.deepEqual(asJson(lackingPositions.wrecks), {})

  const bare = await anchorDatabaseOf(ANCHOR_SCHEMA.replace(/create table FCT_(Wrecks|Lifepods|MissileSalvo) \([^)]*\);/g, ''), rowsWithout(/FCT_(Wrecks|Lifepods|MissileSalvo)/))
  const bareOrbits = await m['orbit-propagation'].loadOrbitFacts(bare, IDS, OBJECTS.map(anchorEndpoint))
  const barePositions = await m['route-position'].loadPositionFacts(bare, IDS)

  assert.deepEqual(asJson(bareOrbits.problems), [], 'a save without the tables of wrecks, life pods and salvos has none, and says nothing')
  assert.deepEqual(asJson(barePositions.problems), [])
  assert.deepEqual({ wrecks: asJson(barePositions.wrecks), lifepods: asJson(barePositions.lifepods), salvos: asJson(barePositions.salvos) }, { wrecks: {}, lifepods: {}, salvos: {} })
})

check('anchor-rides', 'an object a Lagrange point carries is at the point\'s saved position at the saved epoch and at the point\'s own position after every whole call, by the sub-pulse and by the increment cadence, whatever its kind: fleets, waypoints, wrecks, life pods and missile salvos ride, and an unadapted record stays at the saved position', async (w) => {
  const scene = await anchorScene(w)
  const rp = scene.m['route-position']

  assert.equal(MOVERS.length, 7, 'two fleets, two waypoints, a wreck, a life pod and a salvo ride a point that moves')
  assert.deepEqual([...new Set(MOVERS.map((object) => object.family))].sort(), ['fleet', 'lifepod', 'salvo', 'waypoint', 'wreck'])

  MOVERS.forEach((object) => {
    const endpoint = anchorEndpoint(object)
    const saved = { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }
    const label = `${object.family} ${object.id}`

    assert.ok(between(endpoint, pointAt(object.rides, 0)) < 1e-6, `${label}: stands at the saved position of its point`)

    const held = rp.positionRecord(endpoint, { facts: scene.facts, at: GAME_TIME + SUBPULSE })

    assert.equal(held.basis, 'static', `${label}: no adapter, no motion`)
    assert.deepEqual({ ...held.position }, saved)

    MODES.forEach((mode) => {
      const facts = withClock(scene.facts, mode.clock)
      const start = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at: GAME_TIME })

      assert.deepEqual({ ...start.position }, saved, `${label}: at the saved epoch it is where the save has it, the point's own position`)
      assert.deepEqual({ ...start.anchor }, { point: object.rides }, `${label}: states the point it rides`)
      assert.equal(start.supported, true, `${label}: a supported kind of position`)
      UNANCHORED_TREATMENT.forEach((code) => assert.ok(!start.conditions.includes(code), `${label}: not held for ${code}`))

      mode.calls.forEach((calls) => {
        const elapsed = calls * mode.call
        const at = GAME_TIME + elapsed
        const found = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at })
        const own = rp.positionRecord(ENDPOINTS[`p${object.rides}`], { facts, adapters: rp.ADAPTERS, at })
        const there = pointAt(object.rides, elapsed, mode.call)
        const where = `${label}, ${calls} calls of ${mode.name}`

        assert.equal(found.basis, 'propagated', `${where}: propagated, not held`)
        assert.ok(between(found.position, there) <= 1, `${where}: at the point's position, to a kilometre (${between(found.position, there)})`)
        assert.deepEqual(coordinatesOf(found.position), coordinatesOf(own.position), `${where}: exactly where the point's own adapter puts the point`)
        assert.equal(found.position.SystemID, object.system, `${where}: in its own system`)
        assert.equal(found.observedAt, own.observedAt, `${where}: dated as the point is`)
        assert.ok(between(found.position, saved) > 1000, `${where}: not at the saved position (${between(found.position, saved)})`)
        assert.ok(found.supported, `${where}: supported`)
        own.conditions.forEach((code) => assert.ok(found.conditions.includes(code), `${where}: states ${code} as the point does`))
        UNANCHORED_TREATMENT.forEach((code) => assert.ok(!found.conditions.includes(code), `${where}: not held for ${code}`))
      })
    })
  })

  // What the point cannot give, the object cannot: a point whose orbit is not read, a clock that is not read.
  const wreck = anchorEndpoint(OBJECTS.find((object) => object.id === 301))
  const unread = rp.positionRecord(wreck, { facts: { ...scene.facts, orbits: { ...scene.orbits, points: {} } }, adapters: rp.ADAPTERS, at: GAME_TIME + SUBPULSE })

  assert.equal(unread.basis, 'static')
  assert.ok(unread.conditions.includes('propagation-unavailable') && unread.conditions.includes('orbit-missing'), 'a point the read does not have is stated for its wreck as for the point')

  const lone = rp.positionRecord(wreck, { facts: { ...scene.facts, clock: null }, adapters: rp.ADAPTERS, at: GAME_TIME + SUBPULSE })

  assert.equal(lone.basis, 'static')
  assert.ok(lone.conditions.includes('clock-unread'))

  const direct = scene.m['orbit-propagation'].anchorAdapter(wreck, { facts: scene.facts, at: GAME_TIME + SUBPULSE, base: {} })

  assert.deepEqual(direct.reasons, ['anchor-unread'], 'an adapter given no point refuses with its own reason')
  assert.ok(!scene.m['orbit-propagation'].anchorAdapter.serves({}) && scene.m['orbit-propagation'].anchorAdapter.serves({ anchor: { point: 31 } }))
})

check('anchor-displaced', 'non-fleet followers snap by point reference on the first source-ordered update: every positive snapshot elapsed time, the opening sub-pulse or preceding movement increment, never at the saved epoch', async (w) => {
  const scene = await anchorScene(w)
  const rp = scene.m['route-position']
  const displaced = OBJECTS.filter((object) => object.family !== 'fleet' && object.dx > 0)

  assert.deepEqual(displaced.map((object) => object.family).sort(), ['lifepod', 'salvo', 'waypoint', 'wreck'])
  for (const mode of MODES) {
    const facts = withClock(scene.facts, mode.clock)
    for (const object of displaced) {
      const endpoint = anchorEndpoint(object)
      const saved = coordinatesOf(endpoint)
      const label = `${mode.name}, ${object.family}`

      assert.equal(scene.positions[FACTS_OF[object.family]][object.id].riding, true, `${label}: reference, not coincidence, selects the follower`)
      for (const elapsed of [0, mode.call / 2, mode.call, mode.call * 1.5]) {
        const snapshot = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at: GAME_TIME + elapsed })
        const expected = elapsed === 0 ? saved : pointAt(object.point, elapsed, mode.call)

        assert.ok(between(snapshot.position, expected) < 1e-5, `${label}: snapshot at ${elapsed} keeps the exact epoch saved and counts a final partial call as an update`)
      }
      for (const elapsed of [0, mode.call / 2, mode.call, mode.call * 1.5]) {
        const from = { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor + 5, Ycor: endpoint.Ycor }
        const arrival = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at: GAME_TIME + elapsed, from, speed: 1e8 })
        const calls = mode.clock.orbitalMovementInSubPulse === 0 ? Math.floor(elapsed / mode.call) : Math.floor(elapsed / mode.call) + 1
        const expected = calls === 0 ? saved : pointAt(object.point, calls * mode.call, mode.call)

        assert.equal(arrival.basis, 'propagated', `${label}: arrival is served`)
        assert.ok(between(arrival.position, expected) < 1e-5, `${label}: movement from ${elapsed} sees the source-ordered call`)
      }
      for (const elapsed of mode.clock.orbitalMovementInSubPulse === 0 ? [0, mode.call] : [0]) {
        const zero = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at: GAME_TIME + elapsed, from: endpoint, speed: 1e8 })

        assert.equal(zero.basis, 'propagated', `${label}: zero-duration arrival is served`)
        assert.deepEqual(coordinatesOf(zero.position), saved, `${label}: zero-duration arrival at ${elapsed} sees no source-ordered update`)
      }
      const unread = rp.positionRecord(endpoint, { facts: withClock(facts, { orbitalMovementInSubPulse: null }), adapters: rp.ADAPTERS, at: GAME_TIME + mode.call / 2 })

      assert.equal(unread.basis, 'static')
      assert.ok(unread.conditions.includes('cadence-unread'), `${label}: no snap phase is invented when the option is unread`)
    }
  }
})

check('anchor-static-snap', 'displaced non-fleet followers of a static point keep the saved snapshot until the first applicable update, snap even though the point is fixed, and disclose unread point geometry', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const objects = ['waypoint', 'wreck', 'lifepod', 'salvo'].map((family, index) => planted(family, 900 + index, { point: 33, dx: 5000 }))
  const database = await anchorDatabaseOf(ANCHOR_SCHEMA, `${anchorRows()}\n${objects.map((object) => ANCHOR_INSERTS[object.family](object, placeOfObject(object))).join('\n')}`)

  try {
    const positions = await rp.loadPositionFacts(database, IDS)
    const orbits = await m['orbit-propagation'].loadOrbitFacts(database, IDS, objects.map(anchorEndpoint))
    const point = pointAt(33, 0)

    for (const mode of MODES) {
      for (const motion of [1, 0]) {
        const facts = withClock({ ...positions, orbits }, { ...mode.clock, orbitalMotion: motion })

        for (const object of objects) {
          const endpoint = anchorEndpoint(object)
          const saved = coordinatesOf(endpoint)
          const label = `${object.family}, ${mode.name}, motion ${motion}`

          assert.equal(positions[FACTS_OF[object.family]][object.id].riding, true, `${label}: real loader selects the static point reference`)
          for (const elapsed of [0, mode.call / 2, mode.call, mode.call * 1.5]) {
            const snapshot = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at: GAME_TIME + elapsed })

            assert.ok(between(snapshot.position, motion && elapsed > 0 ? point : saved) < 1e-5, `${label}: every positive snapshot elapsed time counts as an update`)
            assert.equal(snapshot.unknown, false, `${label}: resolved geometry is exact`)
            const from = { SystemID: 1, Xcor: endpoint.Xcor + 5, Ycor: endpoint.Ycor }
            const arrival = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at: GAME_TIME + elapsed, from, speed: 1e8 })
            const updated = motion && (mode.clock.orbitalMovementInSubPulse !== 0 || elapsed >= mode.call)

            assert.ok(between(arrival.position, updated ? point : saved) < 1e-5, `${label}: arrival from ${elapsed} uses the opening sub-pulse or preceding increment`)
            assert.equal(arrival.unknown, false)
          }
          const unreadCadence = withClock(facts, { orbitalMovementInSubPulse: null })
          const snapshot = rp.positionRecord(endpoint, { facts: unreadCadence, adapters: rp.ADAPTERS, at: GAME_TIME + mode.call / 2 })
          const arrival = rp.positionRecord(endpoint, { facts: unreadCadence, adapters: rp.ADAPTERS, at: GAME_TIME + mode.call / 2, from: endpoint, speed: 1e8 })

          assert.ok(between(snapshot.position, motion ? point : saved) < 1e-5, `${label}: a static point snapshot needs no cadence`)
          assert.equal(snapshot.unknown, false)
          assert.equal(arrival.conditions.includes('cadence-unread'), Boolean(motion), `${label}: movement alone requires cadence while motion is on`)
          for (const broken of [
            { ...orbits, points: { ...orbits.points, 33: { ...orbits.points[33], xcor: null } } },
            { ...orbits, bodies: { ...orbits.bodies, 10: { ...orbits.bodies[10], bodyClass: null } } },
            { ...orbits, bodies: {} },
          ]) {
            const unread = rp.positionRecord(endpoint, { facts: { ...facts, orbits: broken }, adapters: rp.ADAPTERS, at: GAME_TIME + mode.call })

            assert.equal(unread.basis, 'static', `${label}: unresolved point is not propagated`)
            assert.equal(unread.unknown, true, `${label}: refusal cannot be suppressed by the static motion group`)
            assert.ok(unread.conditions.includes('propagation-unavailable') && unread.conditions.some((code) => ['orbit-missing', 'motion-classification'].includes(code)), `${label}: named refusal, not a fixed saved position`)
          }
        }
      }
    }
    await database.query(`update FCT_LagrangePoint set Xcor = null where LagrangePointID = 33 and GameID = ${GAME}`)

    const unreadPositions = await rp.loadPositionFacts(database, IDS)

    for (const object of objects) {
      const unread = rp.positionRecord(anchorEndpoint(object), { facts: { ...unreadPositions, orbits }, adapters: rp.ADAPTERS, at: GAME_TIME + SUBPULSE })

      assert.equal(unread.unknown, true, `${object.family}: unread point coordinates in the real loader cannot leave an exact fixed record`)
      assert.ok(unread.conditions.includes('anchor-unread'), `${object.family}: the unread reference geometry has a named reason`)
    }
  } finally {
    database.close()
  }
})

check('anchor-unanchored', 'an object no point is read to carry keeps the treatment of its kind whatever adapters a consumer gives (a wreck is held and says its carrier is not recorded, a life pod drifts, an unanchored salvo is unsupported, a fleet with orders or formation is held), and is not counted as served', async (w) => {
  const scene = await anchorScene(w)
  const rp = scene.m['route-position']
  const { facts } = scene

  OBJECTS.forEach((object) => {
    const endpoint = anchorEndpoint(object)
    const label = `${object.family} ${object.id}`

    const served = object.rides > 0 || (object.family !== 'fleet' && object.read === 'riding')

    assert.equal(rp.isServed(endpoint, { facts, adapters: rp.ADAPTERS }), served, `${label}: served only when a point carries it`)
    assert.equal(rp.isServed(endpoint, { facts, adapters: rp.NO_ADAPTERS }), false, `${label}: no adapter, not served`)

    if (!served) {
      ;[GAME_TIME, GAME_TIME + SUBPULSE].forEach((at) => {
        const held = rp.positionRecord(endpoint, { facts, at })
        const adapted = rp.positionRecord(endpoint, { facts, adapters: rp.ADAPTERS, at })

        assert.deepEqual(asJson(adapted), asJson(held), `${label}: the record is the one of its kind, adapters or none`)
        assert.equal(held.basis, 'static')
        assert.equal(held.anchor, undefined, `${label}: rides no point`)
        assert.equal(held.supported, !['lifepod', 'salvo'].includes(object.family), `${label}: supported by its kind`)
        object.has.forEach((code) => assert.ok(held.conditions.includes(code), `${label}: states ${code} (${held.conditions.join(', ')})`))
      })
    }
  })

  const salvo = rp.positionRecord(anchorEndpoint(OBJECTS.find((object) => object.id === 505)), { facts })

  assert.equal(salvo.assumption, 'salvo-held', 'a salvo that no point carries is held, and says so')
  assert.equal(rp.positionRecord(anchorEndpoint(OBJECTS.find((object) => object.id === 501)), { facts }).assumption, 'anchor-held', 'one that a point carries says what it is held at')

  // A custom adapter registered for a family is the consumer's own: it serves every endpoint of the family, as before.
  const custom = { fleet: () => ({ position: { SystemID: 1, Xcor: 1, Ycor: 2 }, observedAt: GAME_TIME }) }

  assert.equal(rp.isServed(anchorEndpoint(OBJECTS.find((object) => object.id === 102)), { facts, adapters: custom }), true)
})

check('anchor-static-point', 'an object that rides the point of an asteroid, which the game never moves, stays at the saved position and states no refusal for it', async (w) => {
  const scene = await anchorScene(w)
  const rp = scene.m['route-position']
  const fleet = anchorEndpoint(OBJECTS.find((object) => object.id === 105))
  const found = rp.positionRecord(fleet, { facts: scene.facts, adapters: rp.ADAPTERS, at: GAME_TIME + 24 * SUBPULSE })

  assert.equal(found.moves, false, 'the point of an asteroid does not move')
  assert.deepEqual({ ...found.position }, { SystemID: 1, Xcor: fleet.Xcor, Ycor: fleet.Ycor })
  assert.deepEqual({ ...found.anchor }, { point: 33 }, 'it still rides the point')
  assert.ok(!found.conditions.includes('propagation-unavailable') && !found.conditions.includes('orbit-family'), 'no refusal is stated for a place that does not move')
  assert.equal(found.supported, true)
})

check('anchor-arrival', 'a fleet that meets an object a point carries finds it where the point is when it gets there: the arrival, its time and its position are the point\'s own, for each kind of object and at the speed asked', async (w) => {
  const scene = await anchorScene(w)
  const rp = scene.m['route-position']
  const from = { SystemID: 1, Xcor: STARS[1].Xcor + 3e8, Ycor: STARS[1].Ycor - 2e8 }

  ;[1500, 5000].forEach((speed) => {
    MOVERS.forEach((object) => {
      const options = { facts: scene.facts, adapters: rp.ADAPTERS, at: GAME_TIME, from, speed }
      const found = rp.positionRecord(anchorEndpoint(object), options)
      const own = rp.positionRecord(ENDPOINTS[`p${object.rides}`], options)
      const label = `${object.family} ${object.id} at ${speed} km/s`

      assert.equal(found.basis, 'propagated', label)
      assert.deepEqual(coordinatesOf(found.position), coordinatesOf(own.position), `${label}: met where the point is`)
      assert.equal(found.observedAt, own.observedAt, `${label}: when the point is`)
      assert.ok(found.observedAt > GAME_TIME, `${label}: after a flight`)
      assert.ok(between(found.position, anchorEndpoint(object)) > 1000, `${label}: not at the saved position`)
      assert.equal(found.position.SystemID, object.system)
    })
  })

  const slow = rp.positionRecord(anchorEndpoint(OBJECTS.find((object) => object.id === 101)), { facts: scene.facts, adapters: rp.ADAPTERS, at: GAME_TIME, from, speed: 20 })

  assert.equal(slow.basis, 'static')
  assert.ok(slow.conditions.includes('fleet-slower'), 'a fleet slower than the point it follows does not reach the object, as it would not reach the point')
  assert.ok(rp.positionRecord(anchorEndpoint(OBJECTS.find((object) => object.id === 101)), { facts: scene.facts, adapters: rp.ADAPTERS, at: GAME_TIME, from, speed: null }).conditions.includes('speed-unknown'))
})

check('anchor-plan', 'a plan takes an anchored object as it takes the point: a leg to it, a leg from it, and a plan through it come out as the plan through the point, a fleet at a point is the point\'s position at the saved time, and an object no point carries stays at its saved position', async (w) => {
  const scene = await anchorScene(w)
  const plan = scene.m['route-plan']
  const adapters = scene.m['route-position'].ADAPTERS
  const speed = 1500
  const options = { cycle: false, jumpPoints: [], facts: scene.facts }
  const flown = (stops) => plan.planRoute(stops, { ...options, adapters, speed })
  const stop = (kind, id) => {
    const endpoint = kind === 'colony' ? ENDPOINTS.c701 : kind === 'lagrange' ? ENDPOINTS[`p${id}`] : kind === 'body' ? ENDPOINTS[`b${id}`] : anchorEndpoint(OBJECTS.find((object) => object.id === id))

    return { key: `${kind}:${id}`, kind, name: `${kind} ${id}`, SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }
  }

  // To it, from it, and through it.
  ;[101, 301, 201, 107].forEach((id) => {
    const object = OBJECTS.find((one) => one.id === id)
    const kind = object.family
    const point = object.rides
    const label = `${kind} ${id}`

    const toIt = flown([stop('colony', 701), stop(kind, id)])
    const toPoint = flown([stop('colony', 701), stop('lagrange', point)])

    assert.equal(toIt.legs[0].route.km, toPoint.legs[0].route.km, `${label}: a leg to it is the leg to its point`)
    assert.equal(toIt.legs[0].staticKm, toPoint.legs[0].staticKm, `${label}: and so is the saved figure beside it`)
    assert.equal(toIt.positions.mode, 'propagated', `${label}: propagated`)
    assert.notEqual(toIt.legs[0].route.km, toIt.legs[0].staticKm, `${label}: not the leg to where it was saved`)

    const fromIt = flown([stop(kind, id), stop('body', 19)])
    const fromPoint = flown([stop('lagrange', point), stop('body', 19)])

    assert.equal(fromIt.legs[0].route.km, fromPoint.legs[0].route.km, `${label}: a leg from it is the leg from its point`)

    const through = flown([stop('colony', 701), stop(kind, id), stop('body', 19)])
    const throughPoint = flown([stop('colony', 701), stop('lagrange', point), stop('body', 19)])

    assert.deepEqual(through.legs.map((leg) => leg.route.km), throughPoint.legs.map((leg) => leg.route.km), `${label}: a plan through it is the plan through its point`)

    const origin = fromIt.legs[0].positions.records.find((record) => record.identity.key === `${kind}:${id}`)

    assert.deepEqual({ ...origin.position }, { SystemID: object.system, Xcor: ENDPOINTS[`p${point}`].Xcor, Ycor: ENDPOINTS[`p${point}`].Ycor }, `${label}: placed at its point's position at the saved time`)
  })

  // What no point carries stays where it was saved.
  ;[102, 302, 502, 402].forEach((id) => {
    const object = OBJECTS.find((one) => one.id === id)

    if (['fleet', 'wreck', 'lifepod'].includes(object.family)) {
      const apart = flown([stop('colony', 701), stop(object.family, id)])
      const record = apart.legs[0].positions.records.find((one) => one.identity.key === `${object.family}:${id}`)

      assert.equal(apart.legs[0].route.km, apart.legs[0].staticKm, `${object.family} ${id}: the leg is to the saved position`)
      assert.equal(record.basis, 'static')
      assert.ok(!record.conditions.includes('propagation-unavailable'), `${object.family} ${id}: and no motion is refused for it`)
    }
  })
})

// `Fleet.CalculateTotalMoveOrderDistance` (Fleet.cs 7742-7783) for orders to bodies of the fleet's system with no minimum distance, no new warp point and no jump inside the system: the distances from where the fleet is to the destination of the first order, and on from each to the next, the destination's position being the body's position when the sum is made.
const orderDistanceOf = async (database, fleet, start) => {
  const [orders] = await database.query(`select DestinationID from FCT_MoveOrders where FleetID = ${fleet} and GameID = ${GAME} order by MoveOrder`)
  let position = start
  let total = 0

  for (const { DestinationID } of orders) {
    const [[body]] = await database.query(`select Xcor, Ycor from FCT_SystemBody where SystemBodyID = ${DestinationID} and GameID = ${GAME}`)

    total += Math.hypot(position.Xcor - body.Xcor, position.Ycor - body.Ycor)
    position = body
  }

  return total
}

check('anchor-order-distance', 'the route of a fleet parked at a Lagrange point starts at the point\'s position at the saved time, and its distance and its time at the speed asked are the ones of its orders: the sum the game makes of the legs of its move orders from where the fleet stands', async (w) => {
  const scene = await anchorScene(w)
  const plan = scene.m['route-plan']
  const adapters = scene.m['route-position'].ADAPTERS
  const speed = 1500
  const options = { cycle: false, jumpPoints: [], facts: scene.facts }
  const stop = (kind, endpoint) => ({ key: `${kind}:${endpoint.id}`, kind, name: `${kind} ${endpoint.id}`, SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor })
  const orders = PLANTED_ORDERS[103]
  const ordered = await orderDistanceOf(scene.database, 103, anchorEndpoint(OBJECTS.find((object) => object.id === 103)))

  assert.ok(ordered > 1e8, 'the planted orders are a flight of some length')

  // The fleet with the orders and the fleet parked at the same point have the same start and so the same orders' distance.
  ;[103, 101].forEach((id) => {
    const fleet = anchorEndpoint(OBJECTS.find((object) => object.id === id))
    const stops = [stop('fleet', fleet), ...orders.map((body) => stop('body', ENDPOINTS[`b${body}`]))]
    const held = plan.planRoute(stops, options)
    const flight = plan.planRoute(stops, { ...options, adapters, speed })
    const label = `fleet ${id}`

    assert.ok(Math.abs(held.km - ordered) <= 1e-6 * ordered, `${label}: the distance of the route on the saved positions is the sum the game makes of its orders (${held.km} against ${ordered})`)
    assert.ok(Math.abs(flight.static.km - ordered) <= 1e-6 * ordered, `${label}: and it is stated beside the flown one`)
    assert.ok(Math.abs(held.km / speed - ordered / speed) <= 1e-6 * (ordered / speed), `${label}: so is the time at ${speed} km/s`)
    assert.deepEqual(coordinatesOf(flight.legs[0].start), coordinatesOf(pointAt(31, 0)), `${label}: the route starts at the point's position at the saved time`)

    const origin = flight.legs[0].positions.records.find((record) => record.identity.key === `fleet:${id}`)

    assert.deepEqual(coordinatesOf(origin.position), coordinatesOf(pointAt(31, 0)), `${label}: placed at the point's position`)
    assert.ok(flight.km !== held.km, `${label}: the flown route differs, for the bodies move`)
  })
})

// ---- The saves, when they are there ---------------------------------------------------------------------------------------
// Not run: the independent asteroids of one save, moved to the last body update of a later save of the same game, must land on the later save's positions, which needs two saves of one game a year or more apart (the saves A and B of AE-310-03). The calls of the source are checked above against their own transcription, which a single save cannot do against the game over time.
const NOT_RUN = new Map()

check('saves', 'the independent asteroids of one save, moved to the last body update of a later save of the same game, are where that save has them, to a kilometre (needs tier b: two saves of one game a year apart)', async () => ({ skipped: 'needs tier b: two saves of one game a year or more apart (the saves A and B of AE-310-03)' }))

check('review-round-1', 'a fixed body with no parent is never moved, no asteroid switch gates an eccentric asteroid, an unread eccentricity is no orbit, an arrival is certified to a second or declined, and a short-period moon is as fast as it is', async (w) => {
  const m = (await w.modules())['orbit-propagation']
  const K = 149600000
  const body = (id, fields) => ({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 1, bearing: 90, year: 8760, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: K, ycor: 0, ...fields })
  const ask = (bodies, id, extra, options) => {
    const saved = bodies.find((one) => one.id === id)
    const orbits = { bodies: Object.fromEntries(bodies.map((one) => [one.id, Object.freeze(one)])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }

    return m.orbitAdapter({ family: 'body', key: `body:${id}`, id, SystemID: 1, Xcor: saved.xcor, Ycor: saved.ycor }, { facts: { clock: { gameTime: 86400, lastGrowthTime: 0, orbitalMotion: 1, ...CADENCE, ...extra }, orbits }, ...options })
  }
  const eccentric = body(1, { eccentricity: 0.2, xcor: 1.2 * K })
  const later = { at: 172800 }
  const moved = ask([eccentric], 1, { orbitalMotionAst: 0 }, later)

  assert.ok(!moved.reasons && Math.hypot(moved.position.Xcor - eccentric.xcor, moved.position.Ycor - eccentric.ycor) > 1e6, 'an asteroid switch that reads off holds nothing: an eccentric asteroid moves')
  assert.ok(!ask([eccentric], 1, { orbitalMotionAst: null }, later).reasons, 'and one that is not read is not asked for')
  assert.deepEqual(ask([eccentric], 1, { orbitalMotion: null }, later).reasons, ['motion-switch'], 'the planet and moon switch is the one that is not guessed')
  assert.deepEqual(ask([body(1, { eccentricity: null })], 1, {}, later).reasons, ['orbit-missing'], 'an unread eccentricity is not a circle')

  // An order to a body, or to a colony on one, is classified by the body itself: with the one switch unread every body that moves states it, and a fixed body with no parent, which nothing moves, does not.
  const rp = (await w.modules())['route-position']
  const scene = await w.scene()
  const fixed = Object.freeze({ ...scene.orbits.bodies[10], id: 30, fixed: 1, fixedParentId: 0 })
  const facts = { ...scene.facts, clock: { ...scene.facts.clock, orbitalMotion: null }, orbits: { ...scene.orbits, bodies: { ...scene.orbits.bodies, 30: fixed } } }
  const orderTo = (extra) => rp.orderEndpoint({ PopulationID: 0, DestinationType: 2, DestinationID: 10, SurveyLocationID: null, SystemID: 1, X: 5, Y: 5, label: 'Order', ...extra })
  const stated = (endpoint) => rp.positionRecord(endpoint, { facts }).conditions.includes('motion-switch')

  assert.ok(stated(orderTo({})), 'an order to an asteroid body states the switch it does not record')
  assert.ok(stated(orderTo({ PopulationID: 701, DestinationID: 0 })), 'and an order to a colony on one')
  assert.ok(stated(orderTo({ DestinationID: 11 })), 'and an order to a planet')
  assert.ok(stated(orderTo({ DestinationID: 13 })), 'and one to a trojan, which follows its parent')
  assert.ok(!stated(orderTo({ DestinationID: 30 })), 'an order to a fixed body with no parent does not: nothing moves it')
  let certification = null

  try {
    m.solveArrival({ from: { Xcor: 0, Ycor: 0 }, depart: 0, speed: 10, positionAt: (time) => ({ Xcor: 18 + 9 * time, Ycor: 0 }), speedOf: () => 9 })
  } catch (error) {
    certification = error.code
  }
  assert.equal(certification, 'arrival-diverged', 'a small last change alone cannot certify a slowly contracting arrival')
  assert.deepEqual(ask([body(1, {}), body(2, { bodyClass: 2, parentId: 1, distance: 100000, year: 1, xcor: K + 100000 })], 2, {}, { at: 86400, from: { Xcor: K + 100000, Ycor: 10 }, speed: 100 }).reasons, ['fleet-slower'], 'a moon with a one-hour period is as fast as its orbit says')
})

check('review-round-1-flights', 'an order\'s delay is spent before its flight, a Lagrange point carries nobody through a wait and is left through where it is on arrival, a year that cannot be covered or has fallen back is static with its reasons, and the cadence survives the identity summary', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const speed = 1500
  const adapters = m['route-position'].ADAPTERS
  const flyTo = (from, to, extra = {}) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, wait: 0, ...extra })
  const run = (hops, options = {}) => m['route-plan'].simulateCycles({ hops, facts: scene.facts, adapters, speed, ...options })

  // A delay is spent where the fleet is, before the flight.
  const delay = 864000
  const delayed = run([flyTo(ENDPOINTS.b10, ENDPOINTS.b19, { delay }), flyTo(ENDPOINTS.b19, ENDPOINTS.b10)])
  const start = bodyAt(10, elapsedAt(GAME_TIME + delay))
  const first = arrivalOf(start, GAME_TIME + delay, speed, (time) => bodyDuring(19, elapsedAt(time)))

  assert.ok(Math.abs(delayed.first.km[0] - between(start, bodyDuring(19, elapsedAt(GAME_TIME + delay + first)))) <= 3000, 'the first flight leaves after the delay, from where the origin is then')

  // A fleet that reached a Lagrange point stays where it arrived, and a point left through is where it is on arrival.
  const wait = 864000
  const reachedAt = arrivalOf(ENDPOINTS.b10, GAME_TIME, speed, (time) => pointDuring(31, elapsedAt(time)))
  const arrived = pointDuring(31, elapsedAt(GAME_TIME + reachedAt))
  const waiting = run([flyTo(ENDPOINTS.b10, ENDPOINTS.p31, { wait }), flyTo(ENDPOINTS.p31, ENDPOINTS.b10)])
  const back = arrivalOf(arrived, GAME_TIME + reachedAt + wait, speed, (time) => bodyDuring(10, elapsedAt(time)))

  assert.ok(Math.abs(waiting.first.km[1] - between(arrived, bodyDuring(10, elapsedAt(GAME_TIME + reachedAt + wait + back)))) <= 3000, 'a wait at a Lagrange point does not move the fleet with it')

  const through = run([flyTo(ENDPOINTS.b10, ENDPOINTS.b19, { leave: ENDPOINTS.p31, wait }), flyTo(ENDPOINTS.p31, ENDPOINTS.b10)])
  const metAt = arrivalOf(ENDPOINTS.b10, GAME_TIME, speed, (time) => bodyDuring(19, elapsedAt(time)))
  const exit = pointAt(31, elapsedAt(GAME_TIME + metAt))
  const home = arrivalOf(exit, GAME_TIME + metAt + wait, speed, (time) => bodyDuring(10, elapsedAt(time)))

  assert.ok(Math.abs(through.first.km[1] - between(exit, bodyDuring(10, elapsedAt(GAME_TIME + metAt + wait + home)))) <= 3000, 'the exit is where the point is when the fleet arrives, not after the wait')

  // A year the cycles cannot cover.
  const capped = run([flyTo(ENDPOINTS.b10, ENDPOINTS.b19), flyTo(ENDPOINTS.b19, ENDPOINTS.b10)], { speed: 5e6 })

  assert.equal(capped.annual.status, 'static', 'capped ' + JSON.stringify(capped.annual.reasons))
  assert.ok(capped.annual.reasons.includes('cycles-capped'), 'a capped year says so')
  assert.ok(capped.first.positions.records.length > 0)

  // The cadence an eccentric arrival rests on survives the summary of an endpoint met again, and a fallback states static positions.
  const eccentric = run([flyTo(ENDPOINTS.b11, ENDPOINTS.b10, { wait: 86400 }), flyTo(ENDPOINTS.b10, ENDPOINTS.b11, { wait: 86400 })], { facts: { ...scene.facts, clock: { ...CLOCK, subPulseLength: 360 } }, speed: 50000 })
  const record = eccentric.annual.positions.records.find((one) => one.identity.key === 'body:11')

  assert.equal(eccentric.annual.status, 'propagated', 'eccentric ' + JSON.stringify(eccentric.annual.reasons))
  assert.ok(record && record.conditions.includes('eccentric-cadence'), 'the eccentric cadence is stated for an endpoint that is departed from and met again')

  const fallen = run([flyTo(ENDPOINTS.b23, ENDPOINTS.b10, { wait: 86400 }), flyTo(ENDPOINTS.b10, ENDPOINTS.b23, { wait: 86400 })], { facts: { ...scene.facts, clock: { ...CLOCK, subPulseLength: 360 } }, speed: 50000 })

  assert.equal(fallen.annual.status, 'static', 'fallen ' + JSON.stringify(fallen.annual.reasons))
  assert.ok(fallen.annual.reasons.includes('orbit-horizon'), JSON.stringify(fallen.annual.reasons))
  assert.equal(fallen.first.positions.mode, 'propagated', 'the first cycle is still before the horizon')
  assert.equal(fallen.annual.positions.mode, 'static')
  assert.ok(fallen.annual.positions.records.every((one) => one.basis === 'static' && one.conditions.includes('orbit-horizon')), 'every position of a year that fell back is a saved one, with the reason')
})

check('review-round-2', 'a body with a negative eccentricity is as fast as its orbit says, an arrival is certified or declined whatever the sign, a Route Finder cycle states the cadence of a body it returns to, and a year that fell back states the Lagrange points of the saved route', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const K = 149600000

  // The speed bound of an eccentric orbit uses the size of the eccentricity.
  const body = { id: 1, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 1, bearing: 90, year: 8760, eccentricity: -0.35, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 0.65 * K, ycor: 0 }
  const orbits = { bodies: { 1: Object.freeze(body) }, stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const ask = (speed, offset) => m['orbit-propagation'].orbitAdapter({ family: 'body', key: 'body:1', id: 1, SystemID: 1, Xcor: body.xcor, Ycor: body.ycor }, { facts: { clock: { gameTime: 0, lastGrowthTime: 0, orbitalMotion: 1, ...CADENCE }, orbits }, at: 0, from: { Xcor: body.xcor, Ycor: body.ycor + offset }, speed })

  assert.deepEqual(ask(30, 1).reasons, ['fleet-slower'], 'a fleet slower than a body at 43 km/s does not intercept it, whatever the sign of the eccentricity')
  ;[45, 60, 100].forEach((speed) => {
    const found = ask(speed, 5e6)

    if (!found.reasons) {
      const seconds = found.observedAt
      const flown = Math.hypot(found.position.Xcor - body.xcor, found.position.Ycor - (body.ycor + 5e6)) / speed

      assert.ok(Math.abs(seconds - flown) <= 1, `an arrival at ${speed} km/s is where the flight ends, to a second`)
    } else {
      assert.deepEqual(found.reasons, ['arrival-diverged'], 'or it is declined')
    }
  })

  // A plan that returns to a body states the step the way back used.
  const plan = m['route-plan']
  const adapters = m['route-position'].ADAPTERS
  const place = (kind, key, at, SystemID = 1) => ({ key, kind, name: key, SystemID, Xcor: at.Xcor, Ycor: at.Ycor })
  const cycle = plan.planRoute([place('body', 'body:11', ENDPOINTS.b11), place('jump', 'jump:9', { Xcor: ENDPOINTS.b11.Xcor + 2 * K, Ycor: ENDPOINTS.b11.Ycor })], { cycle: true, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })

  assert.equal(cycle.legs.length, 2)
  assert.ok(cycle.legs[1].positions.conditions.some((one) => one.code === 'eccentric-cadence'), 'the way back carries the cadence')
  assert.ok(cycle.positions.conditions.some((one) => one.code === 'eccentric-cadence'), 'and the plan states it though the first record of the body does not')

  // A plan whose return crosses the horizon of the body it returns to is mixed, and says so on the whole plan as on its legs.
  const horizon = plan.planRoute([place('body', 'body:23', ENDPOINTS.b23), place('body', 'body:24', ENDPOINTS.b24)], { cycle: true, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })

  assert.deepEqual(horizon.legs.map((leg) => leg.positions.mode), ['propagated', 'mixed'], 'the way out is flown on moved bodies and the way back is not')
  assert.equal(horizon.positions.mode, 'mixed', 'so the plan is not stated as wholly propagated')
  assert.equal(horizon.positions.records.find((one) => one.identity.key === 'body:23').basis, 'static', 'the body it returned to stands on the saved position')

  // A body arrived at, left from and arrived at again beyond its horizon is one record: the flown arrival's step and the refusal of the later one, on the saved position.
  const twice = plan.planRoute([place('body', 'body:24', ENDPOINTS.b24), place('body', 'body:23', ENDPOINTS.b23), place('body', 'body:24', ENDPOINTS.b24), place('body', 'body:23', ENDPOINTS.b23)], { cycle: false, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })
  const met = twice.positions.records.find((one) => one.identity.key === 'body:23')

  assert.equal(met.basis, 'static', 'a body whose later arrival fell back stands on the saved position')
  assert.deepEqual(met.conditions.filter((code) => code === 'eccentric-cadence' || code === 'orbit-horizon').sort(), ['eccentric-cadence', 'orbit-horizon'], 'with the cadence of its first arrival and the refusal of the later one')
  assert.equal(twice.positions.mode, 'mixed')

  // A year that fell back states every Lagrange point the saved route flies through.
  const jump = (id, Xcor) => ({ family: 'jump-point', key: `jump:${id}`, id, name: `jump ${id}`, SystemID: 1, Xcor, Ycor: 0 })
  const [a, b] = [jump(1, 0), jump(2, 1e8)]
  const points = [{ SystemID: 1, Xcor: 1e6, Ycor: 0, LagrangePointID: 9001 }, { SystemID: 1, Xcor: 1e8 - 1e6, Ycor: 0, LagrangePointID: 9002 }]
  const hop = (from, to) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, wait: 0 })
  const fell = m['route-plan'].simulateCycles({ hops: [hop(a, b), hop(b, a)], facts: scene.facts, adapters, speed: 1500, lagrangePoints: points })

  assert.equal(fell.annual.status, 'static')
  assert.ok(fell.static.meanKm < 5e6, 'the saved route goes by the Lagrange points')
  assert.deepEqual(fell.annual.positions.records.map((one) => one.identity.key).sort(), ['jump:1', 'jump:2', 'lagrange:9001', 'lagrange:9002'], 'the year keeps the points the saved distance uses')
  assert.ok(fell.annual.positions.caveat && fell.annual.positions.conditions.some((one) => one.code === 'orbit-missing'), 'with why their positions stand')
})

check('review-round-6', 'a leg that leaves a body and arrives at it again states the arrival it flew: the cadence of a body met within an orbit, the horizon refusal of one met beyond it, and the static placeholder of a destination never replaces an arrival that was computed for another body', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const plan = m['route-plan']
  const adapters = m['route-position'].ADAPTERS
  const K = 149600000
  const rock = { id: 1, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 0.01, bearing: 90, year: 24, eccentricity: 0.2, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 1.2 * 0.01 * K, ycor: 0 }
  const orbits = { bodies: { 1: Object.freeze(rock) }, stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const again = { key: 'body:1', kind: 'body', name: 'body:1', SystemID: 1, Xcor: rock.xcor, Ycor: rock.ycor }
  const planAt = (offset) => plan.planRoute([again, { key: 'jump:1', kind: 'jump', name: 'fixed turn', SystemID: 1, Xcor: rock.xcor + offset, Ycor: rock.ycor }, again], { cycle: false, jumpPoints: [], facts: { clock: { gameTime: 0, lastGrowthTime: -73800, orbitalMotion: 1, ...CADENCE }, orbits }, adapters, speed: 1500 })
  const codes = (positions) => positions.conditions.map((one) => one.code)
  const within = planAt(2e7)
  const [, leg] = within.legs

  assert.ok(leg.route.km > 1e6, 'the body moves on while the fleet flies, so the leg is a flight')
  assert.ok(codes(leg.positions).includes('eccentric-cadence'), 'the leg states the cadence its arrival rests on, though the body is also where it leaves from')
  assert.ok(codes(within.positions).includes('eccentric-cadence'), 'and so does the plan')
  assert.equal(within.positions.mode, 'propagated')

  const beyond = planAt(1e8)
  const [, past] = beyond.legs

  assert.ok(codes(past.positions).includes('orbit-horizon'), 'a body met beyond its horizon states the refusal')
  assert.notEqual(past.positions.mode, 'propagated', 'and the leg is not stated as flown on the moved body')
  assert.ok(codes(beyond.positions).includes('orbit-horizon'), 'nor is the plan')
  assert.equal(beyond.positions.records.find((one) => one.identity.key === 'body:1').basis, 'static', 'the body stands on the saved position')

  const place = (id) => ({ key: 'body:' + id, kind: 'body', name: 'body ' + id, SystemID: 1, Xcor: ENDPOINTS['b' + id].Xcor, Ycor: ENDPOINTS['b' + id].Ycor })
  const distinct = plan.planRoute([place(10), place(19)], { cycle: false, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })

  assert.equal(distinct.legs[0].positions.mode, 'propagated', 'a leg between two bodies flown on the moved ones stays propagated')
  assert.equal(distinct.legs[0].positions.records.find((one) => one.identity.key === 'body:19').basis, 'propagated', 'the arrival is not replaced by the static placeholder of its destination')
  assert.equal(distinct.positions.mode, 'propagated')
})

check('closing-round-3', 'a saved departure is not a propagated observation: the adapter marks the position it gives for the game time, and a plan that only leaves a body, or whose every arrival is refused, is stated on the saved positions', async (w) => {
  const read = await w.scene()
  const scene = { ...read, facts: { ...read.facts, clock: { ...CLOCK, subPulseLength: 360 } } }
  const m = scene.m
  const adapters = m['route-position'].ADAPTERS
  const place = (id) => ({ key: 'body:' + id, kind: 'body', name: 'body ' + id, SystemID: 1, Xcor: ENDPOINTS['b' + id].Xcor, Ycor: ENDPOINTS['b' + id].Ycor })
  const planAt = (speed) => m['route-plan'].planRoute([place(10), place(19)], { cycle: false, jumpPoints: [], facts: scene.facts, adapters, speed })

  const departed = adapt(scene, 'b10', { at: GAME_TIME })

  assert.equal(departed.departure, true, 'the position held at the game time is marked as a departure')
  assert.ok(!adapt(scene, 'b10', { at: GAME_TIME + 5e6 }).departure, 'a position worked out for a later time is not')
  assert.ok(!adapt(scene, 'b10', { from: ENDPOINTS.b11, speed: 1500, at: GAME_TIME }).departure, 'nor is an arrival')

  const hop = (from, to) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, wait: 86400 })
  const year = m['route-plan'].simulateCycles({ hops: [hop(ENDPOINTS.b10, ENDPOINTS.b11), hop(ENDPOINTS.b11, ENDPOINTS.b10)], facts: scene.facts, adapters, speed: 50000 })

  assert.equal(year.annual.status, 'propagated', 'a year flown from a saved departure is not made static by it')
  assert.equal(year.annual.positions.mode, 'propagated')

  // A year in which nothing moves is static and compares nothing: no refusal is stated for it, whatever the endpoints and the switch are.
  const yearOf = (facts, from, to, speed = 50000, wait = 86400) => m['route-plan'].simulateCycles({ hops: [hop(from, to), hop(to, from)].map((one) => ({ ...one, wait })), facts, adapters, speed })
  const frozen = { ...scene.facts, clock: { ...scene.facts.clock, orbitalMotion: 0 } }
  const jump = (id, Xcor) => ({ family: 'jump-point', key: 'jump:' + id, id, name: 'jump ' + id, SystemID: 1, Xcor, Ycor: 0 })

  ;[['motion off', yearOf(frozen, ENDPOINTS.b10, ENDPOINTS.b11)], ['motion off and refused', yearOf(frozen, ENDPOINTS.b10, ENDPOINTS.b11, 1)], ['jump points', yearOf(scene.facts, jump(1, 0), jump(2, 1e8))], ['jump points flown very fast', yearOf(scene.facts, jump(1, 0), jump(2, 1), 1e6, 0)]].forEach(([name, fixed]) => {
    assert.equal(fixed.annual.status, 'static', name + ': a year in which nothing moves is not propagated')
    assert.equal(fixed.annual.compared, false, name + ': and has no comparison to show')
    assert.deepEqual(fixed.annual.reasons, [], name + ': nor a reason it failed')
    assert.equal(fixed.annual.positions.mode, 'static')
    assert.ok(fixed.annual.positions.conditions.every((one) => one.code !== 'propagation-unavailable' && one.code !== 'cycles-capped'), name + ': nor a refusal in the strip')
  })

  const flownYear = yearOf(scene.facts, ENDPOINTS.b10, ENDPOINTS.b11)

  assert.equal(flownYear.annual.status, 'propagated')
  assert.equal(flownYear.annual.compared, true, 'a year flown on moved positions compares them')

  // A fixed body with no parent (which nothing moves) beside a moving planet: the planet is worked out and the fixed body is held where it is saved, refusing nothing, even below its orbital speed.
  const fixed = Object.freeze({ ...scene.orbits.bodies[10], id: 30, fixed: 1, fixedParentId: 0 })
  const still = { ...scene.facts, orbits: { ...scene.orbits, bodies: { ...scene.orbits.bodies, 30: fixed } } }
  const stillPoint = { family: 'body', key: 'body:30', id: 30, name: 'Fixed body', SystemID: 1, Xcor: ENDPOINTS.b10.Xcor, Ycor: ENDPOINTS.b10.Ycor }
  const rp = m['route-position']
  const planetRecord = rp.positionRecord(ENDPOINTS.b11, { facts: still, adapters, at: GAME_TIME, from: stillPoint, speed: 1500 })
  const rockRecord = rp.positionRecord(stillPoint, { facts: still, adapters, at: GAME_TIME, from: ENDPOINTS.b11, speed: 5 })

  assert.equal(planetRecord.basis, 'propagated', 'the planet is worked out')
  assert.equal(planetRecord.moves, true)
  assert.equal(rockRecord.moves, false, 'the fixed body is known to be held')
  assert.ok(!rockRecord.conditions.includes('fleet-slower') && !rockRecord.conditions.includes('motion-switch'), 'and refuses nothing, however slow the fleet')

  const mixedYear = m['route-plan'].simulateCycles({ hops: [hop(stillPoint, ENDPOINTS.b11), hop(ENDPOINTS.b11, stillPoint)], facts: still, adapters, speed: 50000 })

  assert.equal(mixedYear.annual.status, 'propagated', 'the planet\'s year is kept beside the fixed body')
  assert.equal(mixedYear.annual.compared, true)
  assert.deepEqual(mixedYear.annual.reasons, [])

  const quick = planAt(1500)

  assert.equal(quick.positions.mode, 'propagated', 'a plan flown on the moved bodies is propagated')
  assert.equal(quick.positions.records.find((one) => one.identity.key === 'body:10').departure, true, 'its origin, which it only leaves, is the departure')

  const back = m['route-plan'].planRoute([place(10), place(19), place(10)], { cycle: false, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })
  const origin = back.positions.records.find((one) => one.identity.key === 'body:10')

  assert.ok(!origin.departure && origin.basis === 'propagated', 'a body left from and arrived at again is the arrival, not the departure')

  const arrival = m['route-position'].positionRecord(m['route-position'].placeEndpoint(place(10)), { facts: scene.facts, adapters, at: GAME_TIME, from: ENDPOINTS.b11, speed: 1500 })
  const held = m['route-position'].positionRecord(m['route-position'].placeEndpoint(place(10)), { facts: scene.facts, adapters, at: GAME_TIME })

  assert.equal(arrival.basis, 'propagated')
  assert.equal(held.departure, true)
  ;[{}, { merge: true }].forEach((options) => {
    const [kept] = m['route-position'].summarisePositions([arrival, held], options).records

    assert.ok(!kept.departure && kept.basis === 'propagated', 'a departure met after an arrival does not replace it')
  })

  ;[null, 1, 10].forEach((speed) => {
    const slow = planAt(speed)

    assert.equal(slow.positions.mode, 'static', 'a plan at speed ' + speed + ' that no arrival is flown for stands on the saved positions')
    assert.ok(slow.positions.records.every((record) => record.basis === 'static'), 'and none of its records is propagated')
  })
})

check('review-round-1-read', 'a Lagrange point of an unsurveyed system has none of its orbit fields read, and a path names the jump points and places it passes', async (w) => {
  const scene = await w.scene()
  const database = await databaseOf(SCHEMA, rowsOf())

  await database.query(`insert into FCT_LagrangePoint (LagrangePointID, GameID, SystemID, PlanetID, Distance, Bearing, Xcor, Ycor) values (99, ${GAME}, 2, 10, 1, 0, 0, 0)`)

  const log = []
  const spy = { query: (sql, ...rest) => { log.push(sql); return database.query(sql, ...rest) } }
  const facts = await scene.m['orbit-propagation'].loadOrbitFacts(spy, { GameID: GAME, RaceID: RACE }, [{ family: 'lagrange-point', id: 99, SystemID: 2 }])

  assert.equal(facts.hiddenPoints[99], 2, 'the point is named as unsurveyed')
  assert.ok(!facts.points[99])
  assert.ok(!log.some((sql) => /FCT_LagrangePoint\.Distance/.test(sql) && /\b99\b/.test(sql)), 'no orbit field of it is read')

  const graph = scene.m['jump-graph']
  const through = (id, key = 'colony:7') => [{ kind: 'jump', from: { WarpPointID: 1 }, to: { WarpPointID: id } }, { kind: 'fly', SystemID: 2, from: {}, to: { key }, via: null }]

  assert.notEqual(graph.pathKey(through(2)), graph.pathKey(through(3)), 'routes of one distance that jump through other points are other keys')
  assert.notEqual(graph.pathKey(through(2)), graph.pathKey(through(2, 'colony:8')), 'routes that fly to other places are other keys')
})

// ---- Faults ----------------------------------------------------------------------------------------------------------
// Each plants one change in one source, and the checks named must fail on it. [label, target, text, replacement, the checks that must fail]
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  ['the empty read loses the later problems', 'orbit', 'hiddenPoints: Object.freeze(hiddenPoints), problems: Object.freeze(problems)', 'hiddenPoints: Object.freeze(hiddenPoints), problems: none.problems', ['unsurveyed-read']],
  ['the colony read names its columns', 'orbit', "'The save lacks the ID and body of the colonies, so the bodies of colonies could not be read'", "'FCT_Population has no PopulationID or SystemBodyID in this save, so the bodies of colonies could not be read'", ['unsurveyed-read']],
  ['the Lagrange point read names its columns', 'orbit', "'The save lacks the identity, system, parent body, distance, bearing, position or game of the Lagrange points, so the orbits of Lagrange points could not be read'", "'FCT_LagrangePoint has no LagrangePointID, SystemID, PlanetID, Distance, Bearing, Xcor, Ycor or GameID in this save, so the orbits of Lagrange points could not be read'", ['unsurveyed-read']],
  ['an arrival is solved only to a minute', 'orbit', 'export const ARRIVAL_TOLERANCE_SECONDS = 1', 'export const ARRIVAL_TOLERANCE_SECONDS = 60', ['circular-arrival', 'registration']],
  ['an arrival is searched for eighty times', 'orbit', 'export const ARRIVAL_MAX_EVALUATIONS = 8', 'export const ARRIVAL_MAX_EVALUATIONS = 80', ['solver-bounds', 'registration']],
  ['a rebuild is trusted a kilometre in a thousand', 'orbit', 'export const REBUILD_TOLERANCE_KM = 1', 'export const REBUILD_TOLERANCE_KM = 1000', ['rebuild', 'registration']],
  ['the fitted step is restored', 'orbit', 'const call = length', 'const call = 561600', ['source-calls', 'eccentric-horizon']],
  ['the fitted step constant is exported again', 'orbit', 'export const MAX_CALLS = 100000', 'export const MAX_CALLS = 100000\nexport const ECCENTRIC_STEP_SECONDS = 561600', ['registration']],
  ['the ratio of the current to the mean speed is dropped', 'orbit', 'const turn = (deltaSeconds / (body.year * 3600)) * (current / mean)', 'const turn = (deltaSeconds / (body.year * 3600)) * 1', ['source-calls', 'eccentric-horizon']],
  ['the sub-pulse option is ignored', 'orbit', 'perPulse ? clock.subPulseLength : clock.incrementLength', 'clock.incrementLength', ['source-calls']],
  ['the sub-pulse option is read the wrong way round', 'orbit', 'perPulse ? clock.subPulseLength : clock.incrementLength', 'perPulse ? clock.incrementLength : clock.subPulseLength', ['source-calls']],
  ['the snapshot remainder is dropped', 'orbit', 'bearing = advance(body, star, bearing, remainder)', 'bearing = bearing', ['source-calls', 'snapshot-partial']],
  ['the snapshot partial pollutes the whole-call cache', 'orbit', 'bearing = advance(body, star, bearing, remainder)', 'bearing = advance(body, star, bearing, remainder)\n      calls[whole] = bearing', ['partial-cache']],
  ['the snapshot partial is not budgeted', 'orbit', 'const evaluations = whole + (remainder > 0 ? 1 : 0)', 'const evaluations = whole', ['partial-budget']],
  ['the budget refusal calls the remainder a full call', 'orbit', 'the horizon needs ${needs} against a budget of ${MAX_CALLS}', 'the horizon needs ${evaluations} calls of ${length} s; the app computes at most ${MAX_CALLS}', ['partial-budget', 'saved-epoch', 'source-calls']],
  ['a circular snapshot drops its elapsed remainder', 'orbit', 'const seconds = !planets ? 0 : movement ? whole * (length || 1) : elapsed', 'const seconds = whole * (length || 1)', ['snapshot-partial']],
  ['the call cap silently coarsens the cadence again', 'orbit', 'const call = length', 'const call = Math.max(length, year / MAX_CALLS)', ['source-calls']],
  ['the exact call budget is ignored', 'orbit', 'if (evaluations > MAX_CALLS) {', 'if (false) {', ['source-calls']],
  ['a cadence that is not read is guessed', 'orbit', "if (planets && elapsed > 0 && length === null && (movement || family === 'eccentric')) {", 'if (false) {', ['source-calls']],
  ['a boundary arrival skips residual certification', 'orbit', 'if (Math.abs(distance(arrived) / speed - next) <= ARRIVAL_TOLERANCE_SECONDS) {', 'if (true) {', ['solver-bounds']],
  ['movement restores floor in sub-pulse mode', 'orbit', 'switchOf(clock.orbitalMovementInSubPulse) ? Math.ceil(count)', 'switchOf(clock.orbitalMovementInSubPulse) ? Math.floor(count)', ['movement-phase']],
  ['movement applies ceil in increment mode', 'orbit', ': Math.ceil(count) - 1 : Math.floor(count)', ': Math.ceil(count) : Math.floor(count)', ['movement-phase']],
  ['increment movement takes the post-update boundary', 'orbit', ': Math.ceil(count) - 1 : Math.floor(count)', ': Math.floor(count) : Math.floor(count)', ['movement-phase']],
  ['the saved snapshot at t0 is advanced', 'orbit', 'const depart = isNumber(at) ? at : clock.gameTime', 'const depart = (isNumber(at) ? at : clock.gameTime) + (from ? 0 : callLength(clock))', ['movement-phase', 'rebuild']],
  ['movement phase is lost on a moon parent', 'orbit', "if (family === 'moon') {\n    parent = stateAt(orbits, clock, body.parentId, elapsed, { horizon, depth: depth + 1, movement })", "if (family === 'moon') {\n    parent = stateAt(orbits, clock, body.parentId, elapsed, { horizon, depth: depth + 1 })", ['circular-arrival']],
  ['a trojan turns on a circle of its own', 'orbit', 'bearing = planets ? wrap(parent.bearing + body.trojan) : body.bearing', 'bearing = wrap(body.bearing - (360 * seconds) / year)', ['source-calls']],
  ['a fleet with half an engine moves', 'orbit', '} else if (speed <= 1) {', '} else if (speed < 0.5) {', ['solver-bounds']],
  ['a fleet slower than the body is not refused', 'orbit', 'if (!(speed > fastest)) {', 'if (false) {', ['solver-bounds']],
  ['an eccentric body past one orbit is carried', 'orbit', 'if (horizon && elapsed >= year) {', 'if (false) {', ['eccentric-horizon']],
  ['a circular body turns the wrong way', 'orbit', 'if (family === \'circular\') {\n    bearing = wrap(body.bearing - (360 * seconds) / year)', 'if (family === \'circular\') {\n    bearing = wrap(body.bearing + (360 * seconds) / year)', ['circular-arrival']],
  ['the cadence is not stated', 'orbit', 'conditions: advanced ? [\'eccentric-cadence\'] : [], solved', 'conditions: [], solved', ['eccentric-horizon']],
  ['a trojan leads its parent', 'orbit', 'wrap(parent.bearing + body.trojan)', 'wrap(parent.bearing - body.trojan)', ['rebuild']],
  ['a Lagrange point is a third of the way round', 'orbit', 'const bearing = wrap(state.bearing + 60)', 'const bearing = wrap(state.bearing + 120)', ['rebuild']],
  ['an independent asteroid is held when the asteroid switch reads off', 'orbit', 'const seconds = !planets ? 0 : movement ? whole * (length || 1) : elapsed', 'const seconds = family === \'circular\' && switchOf(clock.orbitalMotionAst) === false ? 0 : !planets ? 0 : movement ? whole * (length || 1) : elapsed', ['motion-switch']],
  ['a rebuild that misses is not looked at', 'orbit', 'verify(orbits, clock, target)\n\n    const depart', 'const depart', ['rebuild']],
  ['an orbit of an unsurveyed system is read', 'orbit', 'const open = sites.filter((row) => surveyed.has(row.SystemID)).map((row) => row.SystemBodyID)', 'const open = sites.map((row) => row.SystemBodyID)', ['rebuild', 'unsurveyed-read']],
  ['the arrival is dated at the departure', 'orbit', 'observedAt: solved.time,', 'observedAt: depart,', ['circular-arrival']],
  ['saved coordinates replay the construction-clock gap', 'orbit', 'time - clock.gameTime, { movement: !!from }', 'time - clock.lastGrowthTime, { movement: !!from }', ['rebuild', 'saved-epoch']],
  ['a star that is not the primary is used', 'orbit', '} else if (star.component !== 1) {', '} else if (false) {', ['rebuild']],
  ['a circular planet is propagated', 'orbit', '} else if (body.bodyClass === 3) {\n    return \'circular\'', '} else if (true) {\n    return \'circular\'', ['family-rules', 'rebuild']],
  ['a result is kept whatever the speed', 'orbit', '${scenario}:${typeof profile === \'object\' ? JSON.stringify(profile) : profile}`', '${scenario}`', ['cache']],
  ['a result is kept whatever the scenario', 'orbit', '`orbit-propagation:${slot}:${scenario}:', '`orbit-propagation:${slot}:', ['cache']],
  ['a fleet is propagated by the orbit of a body', 'position', 'fleet: anchorAdapter,', 'fleet: orbitAdapter,', ['registration', 'anchor-rides', 'anchor-unanchored']],
  ['a fleet a point carries is not propagated', 'position', ' fleet: anchorAdapter,', '', ['fallbacks', 'registration', 'anchor-rides']],
  ['a repeated trip leaves from the saved position', 'plan', 'at = { Xcor: stay.Xcor, Ycor: stay.Ycor }', 'at = { Xcor: hop.to.Xcor, Ycor: hop.to.Ycor }', ['successive-cycles']],
  ['a stop takes no time', 'plan', 'time = run.end.time + (hop.wait || 0)', 'time = run.end.time', ['successive-cycles']],
  ['a year that fell back is called propagated', 'plan', 'const status = unmoved || flownPositions.mode === ROUTE_MODE.STATIC ? \'static\' : \'propagated\'', 'const status = \'propagated\'', ['fallbacks']],
  ['a leg of a plan leaves at the time of the plan', 'plan', 'time = flight && flight.speed ? time + route.km / flight.speed : time', 'time = time', ['plan-gate']],
  ['the plan keeps a zero figure on the saved positions', 'plan', 'static: { jumps: held.jumps, km: held.km, missing: held.missing, positions: held.positions }', 'static: { jumps: held.jumps, km: 0, missing: held.missing, positions: held.positions }', ['plan-gate']],
  ['a Lagrange exit is where it was at the departure', 'graph', 'const left = motion.reach(exit, null, entered.time)', 'const left = motion.reach(exit, null, time)', ['lagrange-transfer']],
  ['the last leg of a transfer leaves at the departure', 'graph', 'const arrived = motion.reach(b, left, entered.time)', 'const arrived = motion.reach(b, left, time)', ['lagrange-transfer']],
  ['a transfer is taken whatever it saves', 'graph', 'if (km < best.km) {\n        best = { km, via: [entry, exit], end: arrived', 'if (true) {\n        best = { km, via: [entry, exit], end: arrived', ['lagrange-transfer']],
  ['a flight does not take time along a route', 'graph', 'time: motion ? here.time + leg.km / motion.speed : here.time', 'time: here.time', ['lagrange-transfer', 'successive-cycles']],
  ['an eccentric asteroid is held when the asteroid switch reads off', 'orbit', 'const planets = switchOf(clock.orbitalMotion)', 'const planets = family === \'eccentric\' && body.bodyClass === 3 && switchOf(clock.orbitalMotionAst) === false ? false : switchOf(clock.orbitalMotion)', ['review-round-1', 'motion-switch']],
  ['an order\'s body is not classified by its own fields', 'position', 'const group = groupOf(facts && facts.orbits, endpoint) || endpoint.group', 'const group = endpoint.group', ['review-round-1']],
  ['a negative eccentricity slows the speed bound', 'orbit', 'const eccentricity = Math.abs(body.eccentricity)', 'const eccentricity = body.eccentricity', ['review-round-2']],
  ['the adapter does not mark the position held at the game time', 'orbit', 'conditions: [], departure: true }', 'conditions: [] }', ['closing-round-3']],
  ['a saved departure is labelled propagated', 'position', 'if (found.departure) {', 'if (false) {', ['closing-round-3']],
  ['a saved departure counts toward the mode', 'position', 'record.moves !== false && !record.departure', 'record.moves !== false', ['closing-round-3']],
  ['a refusal is counted against a saved departure', 'plan', 'const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED && !record.departure', 'const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED', ['closing-round-3', 'successive-cycles']],
  ['a year in which nothing moves is stated propagated', 'plan', 'const status = unmoved || flownPositions.mode === ROUTE_MODE.STATIC ? \'static\' : \'propagated\'', 'const status = unmoved ? \'static\' : \'propagated\'', ['closing-round-3']],
  ['a year in which nothing moves has a comparison', 'plan', 'compared: status === \'propagated\' || unmoved,', 'compared: true,', ['closing-round-3']],
  ['a year of places that never move is capped', 'plan', 'const capped = everything.some((record) => record.moves !== false) && cycles.length', 'const capped = cycles.length', ['closing-round-3']],
  ['a refusal at a place that never moves counts', 'plan', 'record.basis !== POSITION_BASIS.PROPAGATED && !record.departure && record.moves !== false', 'record.basis !== POSITION_BASIS.PROPAGATED && !record.departure', ['closing-round-3']],
  ['a place that never moves states a refusal', 'position', '    if (base.moves === false && !base.anchor) {\n      return Object.freeze({ ...base, unknown: base.conditions.length > 0 })\n    }\n\n', '', ['closing-round-3']],
  ['a fixed body with no parent follows the switch', 'position', 'const moves = planets === false || group === \'static\' ? false : kindGroup(group) === \'unknown\' ? null : planets', 'const moves = planets === false ? false : kindGroup(group) === \'unknown\' ? null : planets', ['closing-round-3', 'review-round-1']],
  ['a saved departure replaces a real record', 'position', '    } else if (record.departure) {\n      // A saved departure adds nothing to a record kept already.\n    } else if (kept.departure) {', '    } else if (kept.departure) {', ['closing-round-3']],
  ['a saved departure is kept over the arrival at it', 'position', '    } else if (kept.departure) {\n      byKey.set(key, record)\n    } else if (merge) {', '    } else if (merge) {', ['closing-round-3']],
  ['a leg merges the placeholder of its destination into its arrival', 'plan', 'summarisePositions([...flown.records, positionRecord(placeEndpoint(to), { facts })])', 'summarisePositions([...flown.records, positionRecord(placeEndpoint(to), { facts })], { merge: true })', ['review-round-6']],
  ['a leg puts the placeholder of its destination before its arrival', 'plan', 'summarisePositions([...flown.records, positionRecord(placeEndpoint(to), { facts })])', 'summarisePositions([positionRecord(placeEndpoint(to), { facts }), ...flown.records])', ['review-round-6']],
  ['a plan keeps the first record of a body alone', 'plan', 'summarisePositions(legs.flatMap((leg) => (leg.positions ? leg.positions.records : [])), { merge: true })', 'summarisePositions(legs.flatMap((leg) => (leg.positions ? leg.positions.records : [])))', ['review-round-2']],
  ['the conditions of a record met again are not merged', 'position', '} else if (merge) {', '} else if (false) {', ['review-round-2']],
  ['a record met again after a fallback stays propagated', 'position', 'if (fellBack) {', 'if (false) {', ['review-round-2']],
  ['a year that fell back leaves out the Lagrange points of the saved route', 'plan', '...heldRuns.flatMap((run) => run.points)', '', ['review-round-2']],
  ['an unread eccentricity is taken as none', 'orbit', '(family !== \'moon\' && !isNumber(body.eccentricity)) || ', '', ['review-round-1']],
  ['the arrival is certified by the last change alone', 'orbit', 'if ((contraction / (1 - contraction)) * Math.abs(next - seconds) <= ARRIVAL_TOLERANCE_SECONDS) {', 'if (Math.abs(next - seconds) <= ARRIVAL_TOLERANCE_SECONDS) {', ['review-round-1']],
  ['a moon\'s own turn is left out of its speed bound', 'orbit', 'turn * body.distance + speedBound(orbits, body.parentId, depth + 1)', 'speedBound(orbits, body.parentId, depth + 1)', ['review-round-1']],
  ['an order\'s delay is dropped', 'plan', '        time += hop.delay\n', '        time += 0\n', ['review-round-1-flights']],
  ['a Lagrange point carries a waiting fleet', 'plan', 'hop.wait > 0 && carries(target, hop.action, hop.wait)', 'hop.wait > 0', ['review-round-1-flights']],
  ['a point left through is taken after the wait', 'plan', 'reachPoint(flight, hop.leave, null, run.end.time)', 'reachPoint(flight, hop.leave, null, time)', ['review-round-1-flights']],
  ['a capped year is a figure', 'plan', 'const unmoved = capped || ', 'const unmoved = ', ['review-round-1-flights']],
  ['a year that fell back states the propagated records', 'plan', 'summarisePositions(unmoved ? [...unserved, ...kept] : [...unserved, ...unmovedFirst(everything)], { merge: true })', 'summarisePositions([...unserved, ...unmovedFirst(everything)], { merge: true })', ['review-round-1-flights']],
  ['an unsurveyed point is read in full', 'orbit', 'pointSites.filter((row) => surveyed.has(row.SystemID)).map((row) => row.LagrangePointID)', 'pointSites.map((row) => row.LagrangePointID)', ['review-round-1-read']],
  ['a path is not part of the key', 'graph', 'step.to.WarpPointID || step.to.key || null, step.via', 'null, step.via', ['review-round-1-read']],
  ['a fixed point is rebuilt from its moving owner', 'orbit', "return { Xcor: point.xcor, Ycor: point.ycor, advanced: false, family: 'static' }", "return { ...stateAt(orbits, clock, point.planetId, elapsed, options), family: 'static' }", ['anchor-static-snap']],
  ['an anchored object takes the point of its own ID', 'orbit', 'key: `lagrange:${anchor.point}`, id: anchor.point,', 'key: `lagrange:${anchor.point}`, id: endpoint.id,', ['anchor-rides', 'anchor-arrival', 'anchor-plan']],
  ['an anchored object is carried at the epoch of the save, not the time asked', 'orbit', 'const found = orbitAdapter(point, { facts, at, from, speed, savedUntilUpdate: true })', 'const found = orbitAdapter(point, { facts, at: facts && facts.clock ? facts.clock.gameTime : at, from, speed, savedUntilUpdate: true })', ['anchor-rides']],
  ['an anchored object is held at the saved position', 'orbit', 'position: { ...found.position, SystemID: endpoint.SystemID }', 'position: { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }', ['anchor-rides', 'anchor-arrival', 'anchor-plan']],
  ['an anchored object goes half the way with its point', 'orbit', 'position: { ...found.position, SystemID: endpoint.SystemID }', 'position: { SystemID: endpoint.SystemID, Xcor: (found.position.Xcor + endpoint.Xcor) / 2, Ycor: (found.position.Ycor + endpoint.Ycor) / 2 }', ['anchor-rides', 'anchor-arrival']],
  ['the anchor adapter serves every object', 'orbit', 'anchorAdapter.serves = (state) => Boolean(state && state.anchor)', 'anchorAdapter.serves = () => true', ['anchor-rides', 'anchor-unanchored']],
  ['the orbit read leaves out the points of anchored objects', 'orbit', ', ...anchored.flatMap((entry) => entry.points)', '', ['anchor-read', 'anchor-rides']],
  ['a table with objects and no point column reads as none and says nothing', 'orbit', 'return { family, lacking: true, points: [] }', 'return { family, lacking: false, points: [] }', ['anchor-read']],
  ['a save with no table of an object is said to lack it', 'orbit', 'if (columns.size === 0) {\n      return { family, lacking: false, points: [] }', 'if (false) {\n      return { family, lacking: false, points: [] }', ['anchor-read']],
  ['the points of the objects of another game are read', 'orbit', 'where ${table}.GameID = ${game} and ${table}.OrbitLagrangeID > 0 and ${table}.${key}', 'where ${table}.OrbitLagrangeID > 0 and ${table}.${key}', ['anchor-read']],
  ['non-fleet followers again require coincidence', 'position', 'FCT_LagrangePoint.Xcor is not null and FCT_LagrangePoint.Ycor is not null', 'FCT_LagrangePoint.Xcor = ${table}.Xcor and FCT_LagrangePoint.Ycor = ${table}.Ycor', ['anchor-read', 'anchor-displaced']],
  ['an object is taken to ride a point of another system', 'position', 'FCT_LagrangePoint.GameID = ${table}.GameID and FCT_LagrangePoint.SystemID = ${table}.SystemID', 'FCT_LagrangePoint.GameID = ${table}.GameID', ['anchor-read']],
  ['an object is taken to ride a point of another game', 'position', 'FCT_LagrangePoint.LagrangePointID = ${table}.OrbitLagrangeID and FCT_LagrangePoint.GameID = ${table}.GameID and ', 'FCT_LagrangePoint.LagrangePointID = ${table}.OrbitLagrangeID and ', ['anchor-read']],
  ['the wrecks and salvos of anyone are read', 'position', '${table}.OrbitLagrangeID > 0 and ${scope}`', '${table}.OrbitLagrangeID > 0`', ['anchor-read']],
  ['the objects of another game are read with this one\'s', 'position', 'where ${table}.GameID = :GameID and ${table}.OrbitLagrangeID > 0', 'where ${table}.OrbitLagrangeID > 0', ['anchor-read', 'anchor-rides']],
  ['no object is taken to ride a point', 'position', 'found.riding === true && Number.isInteger(found.point) && found.point > 0', 'found.riding === false && Number.isInteger(found.point) && found.point > 0', ['anchor-rides', 'anchor-arrival']],
  ['a wreck, life pod or salvo does not state its point', 'position', "assumption: moves === false ? 'fixed' : 'anchor-held', anchor: { point } }", "assumption: moves === false ? 'fixed' : 'anchor-held' }", ['anchor-rides']],
  ['a life pod or salvo a point carries is not supported', 'position', '(spec.supported !== false || Boolean(state.anchor))', 'spec.supported !== false', ['anchor-rides']],
  ['a fleet with orders is taken to ride its point', 'position', '...(!mayMove && ridingPoint(found) !== null ?', '...(ridingPoint(found) !== null ?', ['anchor-unanchored']],
  ['a fleet on the point of an asteroid is taken to move', 'position', "moves: mayMove ? null : orbitMotion({ group: kindGroup(found.group) }, facts, conditions), assumption: mayMove ? 'fleet-held' : 'fleet-following'", "moves: mayMove ? null : true, assumption: mayMove ? 'fleet-held' : 'fleet-following'", ['anchor-static-point']],
  ['a record asks the adapter for every object', 'position', ' && servesState(adapters[endpoint.family], () => state)', '', ['anchor-unanchored']],
  ['an object no point carries is counted as served', 'position', ' && servesState(adapters[endpoint.family], () => staticRecord(endpoint, facts).state)', '', ['anchor-unanchored']],
  ['a waypoint a point carries does not state its point', 'position', '...(point !== null ? { anchor: { point } } : {})', '', ['anchor-rides']],
  ['a waypoint at a point it does not stand at is not said to', 'position', "if (found.pointInconsistent) {\n    conditions.push('anchor-point-inconsistent')", "if (false) {\n    conditions.push('anchor-point-inconsistent')", ['anchor-unanchored']],
  ['a wreck, life pod or salvo at a point it does not stand at is not said to', 'position', "if (found && found.pointInconsistent) {\n      conditions.push('anchor-point-inconsistent')", "if (false) {\n      conditions.push('anchor-point-inconsistent')", ['anchor-unanchored']],
  ['an unanchored salvo is supported', 'position', "salvo: { clock: 'none', motion: 'launched', supported: false }", "salvo: { clock: 'none', motion: 'launched' }", ['anchor-unanchored']],
  ['an unanchored salvo is not said to be so', 'position', "    conditions.push('salvo-unanchored')\n    state = { clock: 'none'", "    state = { clock: 'none'", ['anchor-unanchored']],
  ['a plan sums the legs of a route twice', 'plan', 'jumps += route.jumps\n      km += route.km', 'jumps += route.jumps\n      km += route.km * 2', ['anchor-order-distance']],
  ['a displaced follower snaps before the first update', 'orbit', 'savedUntilUpdate: true })', 'savedUntilUpdate: false })', ['anchor-displaced']],
  ['a displaced follower snaps at the saved epoch', 'orbit', 'Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }\n  const found = orbitAdapter(point', 'Xcor: facts.orbits.points[anchor.point].xcor, Ycor: facts.orbits.points[anchor.point].ycor }\n  const found = orbitAdapter(point', ['anchor-displaced']],
  ['a displaced follower snapshot waits for a whole call', 'orbit', ': time <= clock.gameTime))', ': time < clock.gameTime + callLength(clock)))', ['anchor-displaced', 'anchor-static-snap']],
  ['a displaced follower snaps before the ending increment update', 'orbit', 'time <= clock.gameTime + callLength(clock)', 'time < clock.gameTime + callLength(clock)', ['anchor-displaced']],
  ['a static point follower keeps its saved position after the update', 'orbit', "return { Xcor: point.xcor, Ycor: point.ycor, advanced: false, family: 'static' }", "throw unsupported('orbit-family')", ['anchor-static-snap']],
  ['a static follower refusal is silently suppressed', 'position', 'base.moves === false && !base.anchor', 'base.moves === false || Boolean(base.anchor)', ['anchor-static-snap']],
]
/* eslint-enable no-template-curly-in-string */

// ---- Benign edits ----------------------------------------------------------------------------------------------------
// Edits that change nothing the checks look at: an equivalent form of a helper, the size of a read's chunk, and the wording of a condition.
const STRING = '\'[^\'\\n]*\''

const BENIGN = [
  { label: 'the wrap of a bearing written another way', target: 'orbit', from: 'const wrap = (bearing) => ((bearing % 360) + 360) % 360', to: 'const wrap = (bearing) => bearing - 360 * Math.floor(bearing / 360)' },
  { label: 'the radians of a bearing written another way', target: 'orbit', from: 'const radians = (degrees) => (degrees * Math.PI) / 180', to: 'const radians = (degrees) => degrees * (Math.PI / 180)' },
  { label: 'the chunks of a read made smaller', target: 'orbit', from: 'const chunks = (values, size = 400)', to: 'const chunks = (values, size = 7)' },
  { label: 'a condition reworded', target: 'position', at: new RegExp(`(\\n {2}'fleet-slower': )${STRING}`), to: (m) => `${m[1]}'the fleet is not faster than the body, so no arrival is worked out for it'` },
  { label: 'the explanation of the cadence reworded', target: 'position', at: new RegExp(`(\\n {2}'eccentric-cadence': )${STRING}`), to: (m) => `${m[1]}'an eccentric snapshot repeats saved whole calls and a final remainder; movement uses the opening sub-pulse update or the previous increment before its ending boundary, with no forced future load or edit updates and no guarantee of future cadence'` },
  { label: 'a second condition reworded', target: 'position', at: new RegExp(`(\\n {2}'orbit-horizon': )${STRING}`), to: (m) => `${m[1]}'an eccentric orbit is not carried for a whole orbit or more from its last update'` },
].map((edit, index) => ({ ...edit, id: `benign:${index}` }))

// ---- Run ----------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      const outcome = await body(world)

      if (outcome && outcome.skipped) {
        NOT_RUN.set(name, outcome.skipped)
      }
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const main = async () => {
  const mutate = mutating()
  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length - NOT_RUN.size
  let total = CHECKS.length - NOT_RUN.size

  NOT_RUN.forEach((reason, name) => console.log(`SKIP  ${name}: ${reason} (not run)`))
  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))

    FAULTS.forEach(([label, , , , fails]) => fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`)))

    const stages = [
      ...BENIGN.map((edit) => [`benign edit kept: ${edit.label}`, async () => (await run(CHECKS, worldOf([edit]))).map(describeFailure)]),
      ['every benign edit applied: every check stays green', async () => (await run(CHECKS, worldOf(BENIGN))).map(describeFailure)],
    ]
    const benign = await inParallel(stages, async ([, test]) => test())

    benign.forEach((outcome, index) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL ${stages[index][0]}: ${outcome.message}`)
      } else if (outcome.length) {
        console.log(`FAIL ${stages[index][0]}: ${outcome.join('; ')}`)
      } else {
        passed += 1
      }
    })

    const attempts = FAULTS.flatMap(([label, target, from, to, fails]) => {
      const planted = from instanceof RegExp ? { target, at: from, to } : { target, from, to }

      return [[label, [planted], fails], [`${label}, on the sources with every benign edit`, [...BENIGN, planted], fails]]
    })
    const outcomes = await inParallel(attempts, async ([label, edits, fails]) => {
      refusePlanting(label)
      const world = worldOf(edits)
      const missed = []

      for (const name of fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(name)
        }
      }

      return { label, missed }
    })

    outcomes.forEach((outcome, index) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault ${attempts[index][0]}: ${outcome.message}`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)
  process.exit(passed === total ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
