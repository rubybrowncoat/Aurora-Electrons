/*
  Checks the propagation of known bodies to a fleet's arrival (src/renderer/utilities/orbit-propagation.js and what carries it: the adapters of route-position.js, the flights of jump-graph.js and the cycles and plans of route-plan.js) without a save.

  The fixture is a small save made here in an in-memory SQLite database, read by the real loader. Every position the checks expect comes from an oracle written in this file from the orbit rules in closed form (a circle, an ellipse by its polar equation, a bisection for the arrival), not from the utilities; the one number it shares with the utility is the update step of an eccentric orbit, which is pinned here by value. The statements cover the acceptance of AE-087-03:
  - a position is rebuilt from the orbit fields only when it lands within a kilometre of the saved one; a body that misses, an unsurveyed system, a missing field and a family that is not supported keep the saved position and say why;
  - an arrival is solved to a second in at most eight evaluations for circular bodies, moons, trojans, Lagrange points and eccentric bodies, a fleet that is not faster than the body or has no engines has none, and a fleet that does not converge keeps the saved figure with its reason;
  - an eccentric body is carried for less than one orbit from the last update and states the fitted update step; a circular body is carried over any horizon;
  - a Lagrange transfer is flown leg by leg at the time each leg is entered, and its length depends on the direction;
  - a repeated trip arrives at the position the body has reached, waits there and leaves from where the body then is, so each cycle starts from the last arrival;
  - a plan takes the adapted positions, with the saved figure beside it, and every route output states the unsupported cases with their reasons;
  - orbit fields are read only for systems the race has surveyed, and a propagated result is kept per save, profile and scenario.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names, both on the real sources and on the sources with every benign edit applied. Each benign edit, alone and all together, must leave every check green. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults and the benign edits. When the two saves of one game that the measured comparison names are in saves/, the rebuild of every surveyed asteroid is also checked against them; without them that statement is skipped.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
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
// The update step of an eccentric orbit, pinned by value: a fitted number the game does not state.
const STEP = 561600
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

const bearingAt = (id, elapsed, step = STEP) => {
  const body = BODIES[id]
  const year = body.year * 3600
  const star = STARS[body.star]

  if (body.trojan) {
    return turn(bearingAt(body.parent, elapsed, step) + body.trojan)
  } else if (body.e && !body.parent) {
    let bearing = body.B

    for (let left = elapsed; left > 0;) {
      const part = Math.min(step, left)
      const radius = between(ellipsePoint(star, body, bearing), star) / KM

      bearing = turn(bearing - ((360 * part) / year) * Math.sqrt(2 * body.a / radius - 1))
      left -= part
    }

    return bearing
  }

  return turn(body.B - (360 * elapsed) / year)
}

// Where a body is `elapsed` seconds after the last update.
const bodyAt = (id, elapsed, step = STEP) => {
  const body = BODIES[id]
  const star = STARS[body.star]
  const bearing = bearingAt(id, elapsed, step)

  if (body.cls === 2) {
    const parent = bodyAt(body.parent, elapsed, step)

    return { Xcor: parent.Xcor + body.a * Math.cos(rad(bearing - 90)), Ycor: parent.Ycor + body.a * Math.sin(rad(bearing - 90)) }
  }

  return body.e && !body.trojan ? ellipsePoint(star, body, bearing) : circlePoint(star, body.a, bearing)
}

const pointAt = (id, elapsed) => ellipsePoint(STARS[BODIES[POINTS[id].body].star], { a: POINTS[id].a, e: BODIES[POINTS[id].body].e, dir: BODIES[POINTS[id].body].dir }, turn(bearingAt(POINTS[id].body, elapsed) + 60))

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
const LAST_UPDATE = 4900000
const CLOCK = { gameTime: GAME_TIME, lastGrowthTime: LAST_UPDATE, orbitalMotion: 1, orbitalMotionAst: 1 }
const GAME = 1
const RACE = 2

const SCHEMA = `
  create table FCT_SystemBody (SystemBodyID integer, GameID integer, SystemID integer, StarID integer, BodyClass integer, TrojanAsteroid integer, OrbitalDistance real, Bearing real, Year real, Eccentricity real, EccentricityDirection real, ParentBodyID integer, ParentBodyType integer, FixedBody integer, Xcor real, Ycor real);
  create table FCT_Star (StarID integer, GameID integer, Component integer, Xcor real, Ycor real);
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
  assert.deepEqual(refused('p33'), ['orbit-family'], 'a Lagrange point of an asteroid is never moved by the game, so it is not a family that is propagated')
  assert.deepEqual(refused('b21'), ['orbit-star'], 'a body around a star that is not the primary')
  assert.deepEqual(refused('b16'), ['orbit-unsurveyed'], 'a body of a system the race has not surveyed')
  assert.deepEqual(refused('c702'), ['orbit-unsurveyed'], 'a colony on it')
  assert.deepEqual(adapt(scene, 'p31', { facts: { ...scene.facts, orbits: { ...scene.orbits, points: {} } }, at: GAME_TIME + 1 }).reasons, ['orbit-missing'], 'a Lagrange point the read does not have')
  assert.deepEqual(adapt(scene, 'b10', { facts: { ...scene.facts, orbits: null }, at: GAME_TIME + 1 }).reasons, ['orbit-unread'], 'orbits not read')
  assert.deepEqual(adapt(scene, 'b10', { facts: { ...scene.facts, clock: null }, at: GAME_TIME + 1 }).reasons, ['clock-unread'], 'a clock not read')
  assert.deepEqual(adapt(scene, 'b10', { facts: { ...scene.facts, clock: { ...CLOCK, lastGrowthTime: GAME_TIME + 10 } } }).reasons, ['clock-inconsistent'], 'a body update dated after the game time')
})

check('circular-arrival', 'an arrival is solved to a second in at most eight evaluations, for a circular body, a moon, a trojan, an eccentric body, a colony and a Lagrange point, at the position the body has when the fleet gets there', async (w) => {
  const scene = await w.scene()
  const from = { SystemID: 1, Xcor: STARS[1].Xcor + 3e8, Ycor: STARS[1].Ycor - 2e8 }
  const speed = 1500

  PROPAGATED.forEach(([key, positionAt]) => {
    const found = adapt(scene, key, { from, speed, at: GAME_TIME })
    const seconds = arrivalOf(from, GAME_TIME, speed, (time) => positionAt(elapsedAt(time)))
    const there = positionAt(elapsedAt(GAME_TIME + seconds))

    assert.ok(!found.reasons, `${key}: an arrival is found`)
    assert.ok(Math.abs(found.observedAt - (GAME_TIME + seconds)) <= 1, `${key}: the arrival is the body's by the time it is reached (${found.observedAt - (GAME_TIME + seconds)} s off)`)
    assert.ok(between(found.position, there) <= 30, `${key}: at the position it has then (${between(found.position, there)} km off)`)
    assert.ok(found.solved.evaluations <= 8, `${key}: in at most eight evaluations (${found.solved.evaluations})`)
    assert.ok(Math.abs(found.solved.km - between(from, found.position)) < 1e-6, `${key}: the distance is the flight to that position`)
  })

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

  const from10 = { SystemID: 1, Xcor: STARS[1].Xcor + 3e8, Ycor: STARS[1].Ycor }

  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: 1, at: GAME_TIME }).reasons, ['fleet-immobile'])
  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: 20, at: GAME_TIME }).reasons, ['fleet-slower'], 'a body of 30 km/s is not overtaken at 20')
  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: 31, at: GAME_TIME }).reasons, ['arrival-diverged'])
  assert.deepEqual(adapt(scene, 'b10', { from: from10, speed: null, at: GAME_TIME }).reasons, ['speed-unknown'])
  assert.ok(!adapt(scene, 'b10', { from: from10, speed: 1500, at: GAME_TIME }).reasons)
})

check('eccentric-horizon', 'an eccentric body is carried for less than one orbit from the last update and states the fitted step, a moon or trojan of one inherits the limit, and a circular body has none', async (w) => {
  const scene = await w.scene()
  const m = scene.m['orbit-propagation']
  const elapsed = 2000000

  assert.equal(m.ECCENTRIC_STEP_SECONDS, STEP, 'the step is the fitted one')

  ;[14, 11, 12, 13].forEach((id) => {
    const found = adapt(scene, `b${id}`, { at: LAST_UPDATE + elapsed })
    const expected = bodyAt(id, elapsed)

    assert.ok(!found.reasons, `body ${id}: carried`)
    assert.ok(between(found.position, expected) <= 1, `body ${id}: where the stepped orbit puts it (${between(found.position, expected)} km)`)
    assert.deepEqual(found.conditions, ['eccentric-step'], `body ${id}: states the step it rests on`)
  })

  assert.ok(between(bodyAt(14, elapsed), bodyAt(14, elapsed, STEP / 10)) > 1000, 'the step matters at this horizon, so the fault of another one shows')
  const flown = adapt(scene, 'b11', { at: GAME_TIME, from: ENDPOINTS.b10, speed: 1500 })

  assert.ok(!flown.reasons && flown.solved, 'an arrival at an eccentric body is solved')
  assert.deepEqual(flown.conditions, ['eccentric-step'], 'and states the step it rests on')
  assert.deepEqual(adapt(scene, 'b10', { at: LAST_UPDATE + elapsed }).conditions, [], 'a circular body does not depend on the step')

  const year = (id) => BODIES[id].year * 3600

  assert.ok(!adapt(scene, 'b14', { at: LAST_UPDATE + year(14) - 10 }).reasons, 'just under one orbit')
  assert.deepEqual(adapt(scene, 'b14', { at: LAST_UPDATE + year(14) }).reasons, ['orbit-horizon'], 'a whole orbit is not')
  assert.deepEqual(adapt(scene, 'b11', { at: LAST_UPDATE + year(11) + 1 }).reasons, ['orbit-horizon'])
  assert.deepEqual(adapt(scene, 'b12', { at: LAST_UPDATE + year(11) + 1 }).reasons, ['orbit-horizon'], 'a moon follows its parent\'s horizon')
  assert.deepEqual(adapt(scene, 'b13', { at: LAST_UPDATE + year(11) + 1 }).reasons, ['orbit-horizon'], 'and a trojan')
  assert.ok(!adapt(scene, 'b10', { at: LAST_UPDATE + 100 * year(10) }).reasons, 'a circular orbit has no horizon')
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

check('motion-switch', 'a body that the save does not move stays where it was saved, and an unrecorded switch is not guessed', async (w) => {
  const scene = await w.scene()
  const later = GAME_TIME + 3e6
  const withClock = (clock) => ({ ...scene.facts, clock: { ...CLOCK, ...clock } })
  const held = (key, clock) => adapt(scene, key, { facts: withClock(clock), at: later })

  assert.ok(between(held('b10', { orbitalMotionAst: 0 }).position, ENDPOINTS.b10) <= 1e-6, 'asteroid motion off holds an asteroid')
  assert.ok(between(held('b11', { orbitalMotionAst: 0 }).position, bodyAt(11, elapsedAt(later))) <= 1, 'and moves a planet')
  ;['b10', 'b11', 'b12', 'b13', 'b14', 'p31'].forEach((key) => {
    assert.ok(between(held(key, { orbitalMotion: 0 }).position, ENDPOINTS[key]) <= 1e-6, `${key}: planet and moon motion off holds everything`)
  })
  ;['b10', 'b11'].forEach((key) => assert.deepEqual(held(key, { orbitalMotion: null }).reasons, ['motion-switch'], `${key}: a planet switch not recorded`))
  assert.deepEqual(held('b10', { orbitalMotionAst: null }).reasons, ['motion-switch'], 'an asteroid switch not recorded')
  assert.ok(!held('b11', { orbitalMotionAst: null }).reasons, 'which a planet does not need')
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
      const seconds = arrivalOf(start, depart, speed, lp[entry])
      const entered = lp[entry](depart + seconds)
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
  const speed = 1500
  const waits = [6 * 3600, 3 * 3600]
  const hop = (from, to, wait) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, wait })
  const hops = [hop(ENDPOINTS.b10, ENDPOINTS.b19, waits[0]), hop(ENDPOINTS.b19, ENDPOINTS.b10, waits[1])]
  const result = m['route-plan'].simulateCycles({ hops, facts: scene.facts, adapters: m['route-position'].ADAPTERS, speed })

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
      const positionAt = (when) => bodyAt(id, elapsedAt(when))
      const seconds = arrivalOf(at, time, speed, positionAt)

      kms.push(between(at, positionAt(time + seconds)))
      time += seconds + waits[index]
      at = positionAt(time)
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

  const wait = m['route-plan'].simulateCycles({ hops: [{ ...hops[0], leave: ENDPOINTS.b15 }, hops[1]], facts: scene.facts, adapters: m['route-position'].ADAPTERS, speed })

  assert.equal(wait.annual.status, 'static', 'an exit that is not propagated is said')
})

check('fallbacks', 'every case that is not propagated keeps the saved figure and states its reason: an unsupported family, an unsurveyed system, an orbit that does not rebuild or is missing, a horizon past one orbit, a fleet that is slower, has no engines or does not converge, a contact seen earlier and a fleet with queued orders', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const adapters = m['route-position'].ADAPTERS
  const cycleOf = (key, options = {}) => {
    const to = ENDPOINTS[key]
    const hop = (a, b, wait) => ({ steps: [{ kind: 'fly', SystemID: 1, from: a, to: b, via: null }], from: a, to: b, wait })

    return m['route-plan'].simulateCycles({ hops: [hop(ENDPOINTS.b10, to, 3600), hop(to, ENDPOINTS.b10, 3600)], facts: scene.facts, adapters, speed: 1500, ...options })
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

  // A body of one orbit and a half, a year after most of its first orbit: the first cycle is carried, the later ones pass the horizon.
  const lateClock = { ...CLOCK, gameTime: LAST_UPDATE + Math.floor(0.9 * BODIES[11].year * 3600) }
  const late = cycleOf('b11', { facts: { ...scene.facts, clock: lateClock } })

  stated(late, 'orbit-horizon')
  assert.equal(late.first.positions.mode, 'propagated', 'the first cycle states its own mode')
  assert.notEqual(late.annual.positions.mode, 'propagated')

  // A fleet is not carried, and a contact seen earlier is not, whatever the adapters are.
  const rp = m['route-position']
  const facts = { ...scene.facts, fleets: { 7: { lastMoveTime: 4990000, following: false, orders: 2, anchor: 0 } } }
  const crowd = rp.routePositions([{ family: 'fleet', key: 'fleet:7', id: 7, SystemID: 1, Xcor: 1, Ycor: 1 }, { family: 'contact', key: 'contact:9', id: 9, SystemID: 1, Xcor: 2, Ycor: 2, lastUpdate: 4990000 }], { facts, adapters })

  assert.deepEqual(Object.keys(adapters).sort(), ['body', 'colony', 'lagrange-point'], 'only bodies and what sits on one are propagated')
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

  const first = arrivalOf(ENDPOINTS.b10, GAME_TIME, speed, (time) => bodyAt(19, elapsedAt(time)))
  const reached = bodyAt(19, elapsedAt(GAME_TIME + first))
  const back = arrivalOf(reached, GAME_TIME + first, speed, (time) => bodyAt(10, elapsedAt(time)))
  const home = bodyAt(10, elapsedAt(GAME_TIME + first + back))

  assert.equal(flown.legs.length, 2)
  assert.ok(Math.abs(flown.legs[0].route.km - between(ENDPOINTS.b10, reached)) <= 3000, 'the first leg flies to where the body is when it gets there')
  assert.ok(Math.abs(flown.legs[1].route.km - between(reached, home)) <= 6000, 'and the leg back leaves from that arrival, to where the first stop is by then')
  assert.ok(Math.abs(flown.legs[1].route.km - between(bodyAt(19, 0), ENDPOINTS.b10)) > 1e5, 'not from the saved position of the stop')
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

  assert.deepEqual(Object.keys(rp.ADAPTERS).sort(), ['body', 'colony', 'lagrange-point'])
  Object.values(rp.ADAPTERS).forEach((adapter) => assert.equal(adapter, orbit.orbitAdapter))
  assert.deepEqual({ ...rp.NO_ADAPTERS }, {}, 'a consumer that passes no adapters has the static positions')
  orbit.REASONS.forEach((code) => assert.ok(typeof rp.CONDITIONS[code] === 'string' && rp.CONDITIONS[code].length > 20, `${code}: a text of its own`))
  assert.equal(new Set(orbit.REASONS.map((code) => rp.CONDITIONS[code])).size, orbit.REASONS.length, 'each reason reads differently')
  assert.equal(orbit.REBUILD_TOLERANCE_KM, 1)
  assert.equal(orbit.ARRIVAL_TOLERANCE_SECONDS, 1)
  assert.equal(orbit.ARRIVAL_MAX_EVALUATIONS, 8)
  assert.equal(orbit.ECCENTRIC_STEP_SECONDS, 561600)

  const body = { family: 'body', key: 'body:10', id: 10, SystemID: 1, Xcor: 1, Ycor: 2 }
  const none = rp.positionRecord(body, { facts: { clock: CLOCK } })
  const reasoned = rp.positionRecord(body, { facts: { clock: CLOCK, orbits: null }, adapters: rp.ADAPTERS, at: GAME_TIME + 1 })

  assert.equal(none.basis, 'static')
  assert.equal(reasoned.basis, 'static')
  assert.ok(reasoned.conditions.includes('propagation-unavailable') && reasoned.conditions.includes('orbit-unread'), 'a record that could not be moved on says so and why')
})

// ---- The saves, when they are there ---------------------------------------------------------------------------------------
// Two saves of one game 31 years apart: the earlier one's independent asteroids moved to the later one's last body update must land on the later save's positions. The later save's bodies were last moved 11,700 s after the instant its own clock says (a residue measured on these saves), which the instant here takes in.
const EARLIER = path.join(root, 'saves', 'AuroraDB_271_skoormit_saved.db')
const LATER = path.join(root, 'saves', 'AuroraDB.db')
const LATER_RESIDUE_SECONDS = 11700

const readOnly = (file) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY)

  return { raw, query: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows])))) }
}

check('saves', 'the independent asteroids of one save, moved to the last body update of a later save of the same game, are where that save has them, to a kilometre (skipped when the saves are not in saves/)', async (w) => {
  if (!fs.existsSync(EARLIER) || !fs.existsSync(LATER)) {
    return
  }

  const m = (await w.modules())['orbit-propagation']
  const before = readOnly(EARLIER)
  const after = readOnly(LATER)
  const ids = { GameID: 138, RaceID: 781 }

  try {
    const [[clock]] = await before.query(`select GameTime, LastGrowthTime, OrbitalMotion, OrbitalMotionAst from FCT_Game where GameID = ${ids.GameID}`)
    const [[next]] = await after.query(`select LastGrowthTime from FCT_Game where GameID = ${ids.GameID}`)

    if (!clock || !next) {
      return
    }

    const [asteroids] = await before.query(`select SystemBodyID, SystemID, Xcor, Ycor from FCT_SystemBody where GameID = ${ids.GameID} and BodyClass = 3 and coalesce(TrojanAsteroid, 0) = 0 and coalesce(Eccentricity, 0) = 0 and coalesce(FixedBody, 0) = 0 and SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${ids.GameID} and RaceID = ${ids.RaceID})`)
    const [later] = await after.query(`select SystemBodyID, Xcor, Ycor from FCT_SystemBody where GameID = ${ids.GameID}`)
    const laterOf = Object.fromEntries(later.map((row) => [row.SystemBodyID, row]))
    const endpoints = asteroids.map((row) => ({ family: 'body', key: `body:${row.SystemBodyID}`, id: row.SystemBodyID, SystemID: row.SystemID, Xcor: row.Xcor, Ycor: row.Ycor }))
    const orbits = await m.loadOrbitFacts(before, ids, endpoints)
    const facts = { clock: { gameTime: clock.GameTime, lastGrowthTime: clock.LastGrowthTime, orbitalMotion: clock.OrbitalMotion, orbitalMotionAst: clock.OrbitalMotionAst }, orbits }
    const worst = endpoints.map((endpoint) => ({ endpoint, found: m.orbitAdapter(endpoint, { facts, at: next.LastGrowthTime + LATER_RESIDUE_SECONDS }) })).filter(({ endpoint, found }) => !found.reasons && laterOf[endpoint.id]).map(({ endpoint, found }) => Math.hypot(found.position.Xcor - laterOf[endpoint.id].Xcor, found.position.Ycor - laterOf[endpoint.id].Ycor))

    assert.ok(worst.length > 100, `${worst.length} asteroids were moved`)
    assert.ok(Math.max(...worst) <= 1, `the worst is ${Math.max(...worst)} km off`)
  } finally {
    before.raw.close()
    after.raw.close()
  }
})

check('review-round-1', 'the asteroid switch holds an eccentric asteroid too, an unread eccentricity is no orbit, an arrival is certified to a second or declined, and a short-period moon is as fast as it is', async (w) => {
  const m = (await w.modules())['orbit-propagation']
  const K = 149600000
  const body = (id, fields) => ({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 1, bearing: 90, year: 8760, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: K, ycor: 0, ...fields })
  const ask = (bodies, id, extra, options) => {
    const saved = bodies.find((one) => one.id === id)
    const orbits = { bodies: Object.fromEntries(bodies.map((one) => [one.id, Object.freeze(one)])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }

    return m.orbitAdapter({ family: 'body', key: `body:${id}`, id, SystemID: 1, Xcor: saved.xcor, Ycor: saved.ycor }, { facts: { clock: { gameTime: 86400, lastGrowthTime: 0, orbitalMotion: 1, orbitalMotionAst: 1, ...extra }, orbits }, ...options })
  }
  const eccentric = body(1, { eccentricity: 0.2, xcor: 1.2 * K })
  const later = { at: 172800 }
  const held = ask([eccentric], 1, { orbitalMotionAst: 0 }, later)

  assert.ok(!held.reasons && Math.hypot(held.position.Xcor - eccentric.xcor, held.position.Ycor - eccentric.ycor) < 1e-6, 'asteroid motion off holds an eccentric asteroid')
  assert.deepEqual(ask([eccentric], 1, { orbitalMotionAst: null }, later).reasons, ['motion-switch'], 'an unread asteroid switch is not guessed')
  assert.ok(Math.hypot(ask([eccentric], 1, {}, later).position.Xcor - eccentric.xcor, ask([eccentric], 1, {}, later).position.Ycor - eccentric.ycor) > 1e6, 'and asteroid motion on moves it')
  assert.deepEqual(ask([body(1, { eccentricity: null })], 1, {}, later).reasons, ['orbit-missing'], 'an unread eccentricity is not a circle')

  // An order to a body, or to a colony on one, is classified by the body itself: an unread asteroid switch is stated for an asteroid and not for a planet.
  const rp = (await w.modules())['route-position']
  const scene = await w.scene()
  const facts = { ...scene.facts, clock: { ...scene.facts.clock, orbitalMotionAst: null } }
  const orderTo = (extra) => rp.orderEndpoint({ PopulationID: 0, DestinationType: 2, DestinationID: 10, SurveyLocationID: null, SystemID: 1, X: 5, Y: 5, label: 'Order', ...extra })
  const stated = (endpoint) => rp.positionRecord(endpoint, { facts }).conditions.includes('motion-switch')

  assert.ok(stated(orderTo({})), 'an order to an asteroid body states the switch it does not record')
  assert.ok(stated(orderTo({ PopulationID: 701, DestinationID: 0 })), 'and an order to a colony on one')
  assert.ok(!stated(orderTo({ DestinationID: 11 })), 'an order to a planet does not')
  assert.ok(!stated(orderTo({ DestinationID: 13 })), 'nor does one to a trojan, which follows its parent')
  assert.deepEqual(ask([body(1, {})], 1, { gameTime: 0 }, { at: 0, from: { Xcor: K, Ycor: 5 }, speed: 30 }).reasons, ['arrival-diverged'], 'a fleet barely faster than the body is not given an arrival it has not reached')
  assert.deepEqual(ask([body(1, {}), body(2, { bodyClass: 2, parentId: 1, distance: 100000, year: 1, xcor: K + 100000 })], 2, {}, { at: 86400, from: { Xcor: K + 100000, Ycor: 10 }, speed: 100 }).reasons, ['fleet-slower'], 'a moon with a one-hour period is as fast as its orbit says')
})

check('review-round-1-flights', 'an order\'s delay is spent before its flight, a Lagrange point carries nobody through a wait and is left through where it is on arrival, a year that cannot be covered or has fallen back is static with its reasons, and the fitted step survives the identity summary', async (w) => {
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
  const first = arrivalOf(start, GAME_TIME + delay, speed, (time) => bodyAt(19, elapsedAt(time)))

  assert.ok(Math.abs(delayed.first.km[0] - between(start, bodyAt(19, elapsedAt(GAME_TIME + delay + first)))) <= 3000, 'the first flight leaves after the delay, from where the origin is then')

  // A fleet that reached a Lagrange point stays where it arrived, and a point left through is where it is on arrival.
  const wait = 864000
  const reachedAt = arrivalOf(ENDPOINTS.b10, GAME_TIME, speed, (time) => pointAt(31, elapsedAt(time)))
  const arrived = pointAt(31, elapsedAt(GAME_TIME + reachedAt))
  const waiting = run([flyTo(ENDPOINTS.b10, ENDPOINTS.p31, { wait }), flyTo(ENDPOINTS.p31, ENDPOINTS.b10)])
  const back = arrivalOf(arrived, GAME_TIME + reachedAt + wait, speed, (time) => bodyAt(10, elapsedAt(time)))

  assert.ok(Math.abs(waiting.first.km[1] - between(arrived, bodyAt(10, elapsedAt(GAME_TIME + reachedAt + wait + back)))) <= 3000, 'a wait at a Lagrange point does not move the fleet with it')

  const through = run([flyTo(ENDPOINTS.b10, ENDPOINTS.b19, { leave: ENDPOINTS.p31, wait }), flyTo(ENDPOINTS.p31, ENDPOINTS.b10)])
  const metAt = arrivalOf(ENDPOINTS.b10, GAME_TIME, speed, (time) => bodyAt(19, elapsedAt(time)))
  const exit = pointAt(31, elapsedAt(GAME_TIME + metAt))
  const home = arrivalOf(exit, GAME_TIME + metAt + wait, speed, (time) => bodyAt(10, elapsedAt(time)))

  assert.ok(Math.abs(through.first.km[1] - between(exit, bodyAt(10, elapsedAt(GAME_TIME + metAt + wait + home)))) <= 3000, 'the exit is where the point is when the fleet arrives, not after the wait')

  // A year the cycles cannot cover.
  const capped = run([flyTo(ENDPOINTS.b10, ENDPOINTS.b19), flyTo(ENDPOINTS.b19, ENDPOINTS.b10)], { speed: 5e6 })

  assert.equal(capped.annual.status, 'static', 'capped ' + JSON.stringify(capped.annual.reasons))
  assert.ok(capped.annual.reasons.includes('cycles-capped'), 'a capped year says so')
  assert.ok(capped.first.positions.records.length > 0)

  // The fitted step survives the summary of an endpoint met again, and a fallback states static positions.
  const eccentric = run([flyTo(ENDPOINTS.b11, ENDPOINTS.b10), flyTo(ENDPOINTS.b10, ENDPOINTS.b11)])
  const record = eccentric.annual.positions.records.find((one) => one.identity.key === 'body:11')

  assert.equal(eccentric.annual.status, 'propagated', 'eccentric ' + JSON.stringify(eccentric.annual.reasons))
  assert.ok(record && record.conditions.includes('eccentric-step'), 'the eccentric step is stated for an endpoint that is departed from and met again')

  const fallen = run([flyTo(ENDPOINTS.b22, ENDPOINTS.b10), flyTo(ENDPOINTS.b10, ENDPOINTS.b22)])

  assert.equal(fallen.annual.status, 'static', 'fallen ' + JSON.stringify(fallen.annual.reasons))
  assert.ok(fallen.annual.reasons.includes('orbit-horizon'), JSON.stringify(fallen.annual.reasons))
  assert.equal(fallen.first.positions.mode, 'propagated', 'the first cycle is still before the horizon')
  assert.equal(fallen.annual.positions.mode, 'static')
  assert.ok(fallen.annual.positions.records.every((one) => one.basis === 'static' && one.conditions.includes('orbit-horizon')), 'every position of a year that fell back is a saved one, with the reason')
})

check('review-round-2', 'a body with a negative eccentricity is as fast as its orbit says, an arrival is certified or declined whatever the sign, a Route Finder cycle states the fitted step of a body it returns to, and a year that fell back states the Lagrange points of the saved route', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const K = 149600000

  // The speed bound of an eccentric orbit uses the size of the eccentricity.
  const body = { id: 1, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 1, bearing: 90, year: 8760, eccentricity: -0.35, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 0.65 * K, ycor: 0 }
  const orbits = { bodies: { 1: Object.freeze(body) }, stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const ask = (speed, offset) => m['orbit-propagation'].orbitAdapter({ family: 'body', key: 'body:1', id: 1, SystemID: 1, Xcor: body.xcor, Ycor: body.ycor }, { facts: { clock: { gameTime: 0, lastGrowthTime: 0, orbitalMotion: 1, orbitalMotionAst: 1 }, orbits }, at: 0, from: { Xcor: body.xcor, Ycor: body.ycor + offset }, speed })

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
  assert.ok(cycle.legs[1].positions.conditions.some((one) => one.code === 'eccentric-step'), 'the way back carries the step')
  assert.ok(cycle.positions.conditions.some((one) => one.code === 'eccentric-step'), 'and the plan states it though the first record of the body does not')

  // A plan whose return crosses the horizon of the body it returns to is mixed, and says so on the whole plan as on its legs.
  const horizon = plan.planRoute([place('body', 'body:23', ENDPOINTS.b23), place('body', 'body:24', ENDPOINTS.b24)], { cycle: true, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })

  assert.deepEqual(horizon.legs.map((leg) => leg.positions.mode), ['propagated', 'mixed'], 'the way out is flown on moved bodies and the way back is not')
  assert.equal(horizon.positions.mode, 'mixed', 'so the plan is not stated as wholly propagated')
  assert.equal(horizon.positions.records.find((one) => one.identity.key === 'body:23').basis, 'static', 'the body it returned to stands on the saved position')

  // A body arrived at, left from and arrived at again beyond its horizon is one record: the flown arrival's step and the refusal of the later one, on the saved position.
  const twice = plan.planRoute([place('body', 'body:24', ENDPOINTS.b24), place('body', 'body:23', ENDPOINTS.b23), place('body', 'body:24', ENDPOINTS.b24), place('body', 'body:23', ENDPOINTS.b23)], { cycle: false, jumpPoints: [], facts: scene.facts, adapters, speed: 1500 })
  const met = twice.positions.records.find((one) => one.identity.key === 'body:23')

  assert.equal(met.basis, 'static', 'a body whose later arrival fell back stands on the saved position')
  assert.deepEqual(met.conditions.filter((code) => code === 'eccentric-step' || code === 'orbit-horizon').sort(), ['eccentric-step', 'orbit-horizon'], 'with the step of its first arrival and the refusal of the later one')
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

check('review-round-6', 'a leg that leaves a body and arrives at it again states the arrival it flew: the fitted step of a body met within an orbit, the horizon refusal of one met beyond it, and the static placeholder of a destination never replaces an arrival that was computed for another body', async (w) => {
  const scene = await w.scene()
  const m = scene.m
  const plan = m['route-plan']
  const adapters = m['route-position'].ADAPTERS
  const K = 149600000
  const rock = { id: 1, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 0.01, bearing: 90, year: 24, eccentricity: 0.2, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 1.2 * 0.01 * K, ycor: 0 }
  const orbits = { bodies: { 1: Object.freeze(rock) }, stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const again = { key: 'body:1', kind: 'body', name: 'body:1', SystemID: 1, Xcor: rock.xcor, Ycor: rock.ycor }
  const planAt = (gameTime) => plan.planRoute([again, again], { cycle: false, jumpPoints: [], facts: { clock: { gameTime, lastGrowthTime: 0, orbitalMotion: 1, orbitalMotionAst: 1 }, orbits }, adapters, speed: 1500 })
  const codes = (positions) => positions.conditions.map((one) => one.code)
  const within = planAt(21600)
  const [leg] = within.legs

  assert.ok(leg.route.km > 1e6, 'the body moves on while the fleet flies, so the leg is a flight')
  assert.ok(codes(leg.positions).includes('eccentric-step'), 'the leg states the fitted step its arrival rests on, though the body is also where it leaves from')
  assert.ok(codes(within.positions).includes('eccentric-step'), 'and so does the plan')
  assert.equal(within.positions.mode, 'propagated')

  const beyond = planAt(86399)
  const [past] = beyond.legs

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
  const scene = await w.scene()
  const m = scene.m
  const adapters = m['route-position'].ADAPTERS
  const place = (id) => ({ key: 'body:' + id, kind: 'body', name: 'body ' + id, SystemID: 1, Xcor: ENDPOINTS['b' + id].Xcor, Ycor: ENDPOINTS['b' + id].Ycor })
  const planAt = (speed) => m['route-plan'].planRoute([place(10), place(19)], { cycle: false, jumpPoints: [], facts: scene.facts, adapters, speed })

  const departed = adapt(scene, 'b10', { at: GAME_TIME })

  assert.equal(departed.departure, true, 'the position held at the game time is marked as a departure')
  assert.ok(!adapt(scene, 'b10', { at: GAME_TIME + 5e6 }).departure, 'a position worked out for a later time is not')
  assert.ok(!adapt(scene, 'b10', { from: ENDPOINTS.b11, speed: 1500, at: GAME_TIME }).departure, 'nor is an arrival')

  const hop = (from, to) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, wait: 0 })
  const year = m['route-plan'].simulateCycles({ hops: [hop(ENDPOINTS.b10, ENDPOINTS.b11), hop(ENDPOINTS.b11, ENDPOINTS.b10)], facts: scene.facts, adapters, speed: 1500 })

  assert.equal(year.annual.status, 'propagated', 'a year flown from a saved departure is not made static by it')
  assert.equal(year.annual.positions.mode, 'propagated')

  // A year in which nothing moves is static and compares nothing: no refusal is stated for it, whatever the endpoints and the switch are.
  const yearOf = (facts, from, to, speed = 1500) => m['route-plan'].simulateCycles({ hops: [hop(from, to), hop(to, from)], facts, adapters, speed })
  const frozen = { ...scene.facts, clock: { ...scene.facts.clock, orbitalMotion: 0 } }
  const jump = (id, Xcor) => ({ family: 'jump-point', key: 'jump:' + id, id, name: 'jump ' + id, SystemID: 1, Xcor, Ycor: 0 })

  ;[['motion off', yearOf(frozen, ENDPOINTS.b10, ENDPOINTS.b11)], ['motion off and refused', yearOf(frozen, ENDPOINTS.b10, ENDPOINTS.b11, 1)], ['jump points', yearOf(scene.facts, jump(1, 0), jump(2, 1e8))], ['jump points flown very fast', yearOf(scene.facts, jump(1, 0), jump(2, 1), 1e6)]].forEach(([name, fixed]) => {
    assert.equal(fixed.annual.status, 'static', name + ': a year in which nothing moves is not propagated')
    assert.equal(fixed.annual.compared, false, name + ': and has no comparison to show')
    assert.deepEqual(fixed.annual.reasons, [], name + ': nor a reason it failed')
    assert.equal(fixed.annual.positions.mode, 'static')
    assert.ok(fixed.annual.positions.conditions.every((one) => one.code !== 'propagation-unavailable' && one.code !== 'cycles-capped'), name + ': nor a refusal in the strip')
  })

  const flownYear = yearOf(scene.facts, ENDPOINTS.b10, ENDPOINTS.b11)

  assert.equal(flownYear.annual.status, 'propagated')
  assert.equal(flownYear.annual.compared, true, 'a year flown on moved positions compares them')

  // A stationary asteroid (its switch read off) beside a moving planet: the planet is worked out and the asteroid is held where it is saved, refusing nothing, even below its orbital speed.
  const still = { ...scene.facts, clock: { ...scene.facts.clock, orbitalMotionAst: 0 } }
  const rp = m['route-position']
  const planetRecord = rp.positionRecord(ENDPOINTS.b11, { facts: still, adapters, at: GAME_TIME, from: ENDPOINTS.b10, speed: 1500 })
  const rockRecord = rp.positionRecord(ENDPOINTS.b10, { facts: still, adapters, at: GAME_TIME, from: ENDPOINTS.b11, speed: 5 })

  assert.equal(planetRecord.basis, 'propagated', 'the planet is worked out')
  assert.equal(planetRecord.moves, true)
  assert.equal(rockRecord.moves, false, 'the asteroid with its own switch off is known to be held')
  assert.ok(!rockRecord.conditions.includes('fleet-slower') && !rockRecord.conditions.includes('motion-switch'), 'and refuses nothing, however slow the fleet')

  const mixedYear = m['route-plan'].simulateCycles({ hops: [hop(ENDPOINTS.b10, ENDPOINTS.b11), hop(ENDPOINTS.b11, ENDPOINTS.b10)], facts: still, adapters, speed: 1500 })

  assert.equal(mixedYear.annual.status, 'propagated', 'the planet\'s year is kept beside the stationary asteroid')
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
  ['the empty read freezes the list the later reads add to', 'orbit', 'problems: Object.freeze([...problems])', 'problems: Object.freeze(problems)', ['unsurveyed-read']],
  ['the colony read names its columns', 'orbit', "'The save lacks the ID and body of the colonies, so the bodies of colonies could not be read'", "'FCT_Population has no PopulationID or SystemBodyID in this save, so the bodies of colonies could not be read'", ['unsurveyed-read']],
  ['the Lagrange point read names its columns', 'orbit', "'The save lacks the identity, system, parent body, distance, bearing, position or game of the Lagrange points, so the orbits of Lagrange points could not be read'", "'FCT_LagrangePoint has no LagrangePointID, SystemID, PlanetID, Distance, Bearing, Xcor, Ycor or GameID in this save, so the orbits of Lagrange points could not be read'", ['unsurveyed-read']],
  ['an arrival is solved only to a minute', 'orbit', 'export const ARRIVAL_TOLERANCE_SECONDS = 1', 'export const ARRIVAL_TOLERANCE_SECONDS = 60', ['circular-arrival', 'registration']],
  ['an arrival is searched for eighty times', 'orbit', 'export const ARRIVAL_MAX_EVALUATIONS = 8', 'export const ARRIVAL_MAX_EVALUATIONS = 80', ['solver-bounds', 'registration']],
  ['a rebuild is trusted a kilometre in a thousand', 'orbit', 'export const REBUILD_TOLERANCE_KM = 1', 'export const REBUILD_TOLERANCE_KM = 1000', ['rebuild', 'registration']],
  ['the eccentric step is a tenth', 'orbit', 'export const ECCENTRIC_STEP_SECONDS = 561600', 'export const ECCENTRIC_STEP_SECONDS = 56160', ['eccentric-horizon', 'registration']],
  ['a fleet with half an engine moves', 'orbit', '} else if (speed <= 1) {', '} else if (speed < 0.5) {', ['solver-bounds']],
  ['a fleet slower than the body is not refused', 'orbit', 'if (!(speed > fastest)) {', 'if (false) {', ['solver-bounds']],
  ['an eccentric body past one orbit is carried', 'orbit', 'if (horizon && seconds >= year) {', 'if (false) {', ['eccentric-horizon']],
  ['a circular body turns the wrong way', 'orbit', 'if (family === \'circular\') {\n    bearing = wrap(body.bearing - (360 * seconds) / year)', 'if (family === \'circular\') {\n    bearing = wrap(body.bearing + (360 * seconds) / year)', ['circular-arrival']],
  ['the fitted step is not stated', 'orbit', 'conditions: stepped ? [\'eccentric-step\'] : [], solved', 'conditions: [], solved', ['eccentric-horizon']],
  ['a trojan leads its parent', 'orbit', 'wrap(parent.bearing + body.trojan)', 'wrap(parent.bearing - body.trojan)', ['rebuild']],
  ['a Lagrange point is a third of the way round', 'orbit', 'const bearing = wrap(state.bearing + 60)', 'const bearing = wrap(state.bearing + 120)', ['rebuild']],
  ['an asteroid that the save holds still moves', 'orbit', 'const held = !planets || (rock && !rocks)', 'const held = !planets', ['motion-switch', 'review-round-1']],
  ['a rebuild that misses is not looked at', 'orbit', 'verify(orbits, clock, target)\n\n    const depart', 'const depart', ['rebuild']],
  ['an orbit of an unsurveyed system is read', 'orbit', 'const open = sites.filter((row) => surveyed.has(row.SystemID)).map((row) => row.SystemBodyID)', 'const open = sites.map((row) => row.SystemBodyID)', ['rebuild', 'unsurveyed-read']],
  ['the arrival is dated at the departure', 'orbit', 'observedAt: solved.time,', 'observedAt: depart,', ['circular-arrival']],
  ['a clock behind the body update is used', 'orbit', '} else if (elapsed < 0) {', '} else if (false) {', ['rebuild']],
  ['a star that is not the primary is used', 'orbit', '} else if (star.component !== 1) {', '} else if (false) {', ['rebuild']],
  ['a circular planet is propagated', 'orbit', '} else if (body.bodyClass === 3) {\n    return \'circular\'', '} else if (true) {\n    return \'circular\'', ['family-rules', 'rebuild']],
  ['a result is kept whatever the speed', 'orbit', '${scenario}:${typeof profile === \'object\' ? JSON.stringify(profile) : profile}`', '${scenario}`', ['cache']],
  ['a result is kept whatever the scenario', 'orbit', '`orbit-propagation:${slot}:${scenario}:', '`orbit-propagation:${slot}:', ['cache']],
  ['a fleet is propagated', 'position', 'export const ADAPTERS = Object.freeze({ body: orbitAdapter, colony: orbitAdapter, \'lagrange-point\': orbitAdapter })', 'export const ADAPTERS = Object.freeze({ body: orbitAdapter, colony: orbitAdapter, fleet: orbitAdapter, \'lagrange-point\': orbitAdapter })', ['fallbacks', 'registration']],
  ['a repeated trip leaves from the saved position', 'plan', 'at = { Xcor: stay.Xcor, Ycor: stay.Ycor }', 'at = { Xcor: hop.to.Xcor, Ycor: hop.to.Ycor }', ['successive-cycles']],
  ['a stop takes no time', 'plan', 'time = run.end.time + (hop.wait || 0)', 'time = run.end.time', ['successive-cycles']],
  ['a year that fell back is called propagated', 'plan', 'const status = unmoved || flownPositions.mode === ROUTE_MODE.STATIC ? \'static\' : \'propagated\'', 'const status = \'propagated\'', ['fallbacks']],
  ['a leg of a plan leaves at the time of the plan', 'plan', 'time = flight && flight.speed ? time + route.km / flight.speed : time', 'time = time', ['plan-gate']],
  ['the plan keeps no figure on the saved positions', 'plan', 'static: { jumps: held.jumps, km: held.km, missing: held.missing, positions: held.positions }', 'static: undefined', ['plan-gate']],
  ['a Lagrange exit is where it was at the departure', 'graph', 'const left = motion.reach(exit, null, entered.time)', 'const left = motion.reach(exit, null, time)', ['lagrange-transfer']],
  ['the last leg of a transfer leaves at the departure', 'graph', 'const arrived = motion.reach(b, left, entered.time)', 'const arrived = motion.reach(b, left, time)', ['lagrange-transfer']],
  ['a transfer is taken whatever it saves', 'graph', 'if (km < best.km) {\n        best = { km, via: [entry, exit], end: arrived', 'if (true) {\n        best = { km, via: [entry, exit], end: arrived', ['lagrange-transfer']],
  ['a flight does not take time along a route', 'graph', 'time: motion ? here.time + leg.km / motion.speed : here.time', 'time: here.time', ['lagrange-transfer', 'successive-cycles']],
  ['an eccentric asteroid ignores the asteroid switch', 'orbit', 'const held = !planets || (rock && !rocks)', 'const held = !planets || (family === \'circular\' && !rocks)', ['review-round-1']],
  ['an order\'s body is not classified by its own fields', 'position', 'const group = groupOf(facts && facts.orbits, endpoint) || (', 'const group = (', ['review-round-1']],
  ['a negative eccentricity slows the speed bound', 'orbit', 'const eccentricity = Math.abs(body.eccentricity)', 'const eccentricity = body.eccentricity', ['review-round-2']],
  ['the adapter does not mark the position held at the game time', 'orbit', 'conditions: [], departure: true }', 'conditions: [] }', ['closing-round-3']],
  ['a saved departure is labelled propagated', 'position', 'if (found.departure) {', 'if (false) {', ['closing-round-3']],
  ['a saved departure counts toward the mode', 'position', 'record.moves !== false && !record.departure', 'record.moves !== false', ['closing-round-3']],
  ['a refusal is counted against a saved departure', 'plan', 'const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED && !record.departure', 'const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED', ['closing-round-3', 'successive-cycles']],
  ['a year in which nothing moves is stated propagated', 'plan', 'const status = unmoved || flownPositions.mode === ROUTE_MODE.STATIC ? \'static\' : \'propagated\'', 'const status = unmoved ? \'static\' : \'propagated\'', ['closing-round-3']],
  ['a year in which nothing moves has a comparison', 'plan', 'compared: status === \'propagated\' || unmoved,', 'compared: true,', ['closing-round-3']],
  ['a year of places that never move is capped', 'plan', 'const capped = everything.some((record) => record.moves !== false) && cycles.length', 'const capped = cycles.length', ['closing-round-3']],
  ['a refusal at a place that never moves counts', 'plan', 'record.basis !== POSITION_BASIS.PROPAGATED && !record.departure && record.moves !== false', 'record.basis !== POSITION_BASIS.PROPAGATED && !record.departure', ['closing-round-3']],
  ['a place that never moves states a refusal', 'position', '    if (base.moves === false) {\n      return Object.freeze({ ...base, unknown: base.conditions.length > 0 })\n    }\n\n', '', ['closing-round-3']],
  ['an asteroid with its own switch off is unknown', 'position', 'group === \'asteroid\' ? (rocks === false ? false : both)', 'group === \'asteroid\' ? both', ['closing-round-3']],
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
  ['a Lagrange point carries a waiting fleet', 'plan', 'hop.wait > 0 && carries(target)', 'hop.wait > 0', ['review-round-1-flights']],
  ['a point left through is taken after the wait', 'plan', 'reachPoint(flight, hop.leave, null, run.end.time)', 'reachPoint(flight, hop.leave, null, time)', ['review-round-1-flights']],
  ['a capped year is a figure', 'plan', 'const unmoved = capped || ', 'const unmoved = ', ['review-round-1-flights']],
  ['a year that fell back states the propagated records', 'plan', 'summarisePositions(unmoved ? [...unserved, ...kept] : [...unserved, ...unmovedFirst(everything)], { merge: true })', 'summarisePositions([...unserved, ...unmovedFirst(everything)], { merge: true })', ['review-round-1-flights']],
  ['an unsurveyed point is read in full', 'orbit', 'pointSites.filter((row) => surveyed.has(row.SystemID)).map((row) => row.LagrangePointID)', 'pointSites.map((row) => row.LagrangePointID)', ['review-round-1-read']],
  ['a path is not part of the key', 'graph', 'step.to.WarpPointID || step.to.key || null, step.via', 'null, step.via', ['review-round-1-read']],
  ['a Lagrange point of an asteroid is propagated', 'orbit', 'if (!POINT_OWNER_CLASSES.includes(body.bodyClass)) {\n    throw unsupported(\'orbit-family\')\n  }', 'if (false) {\n    throw unsupported(\'orbit-family\')\n  }', ['rebuild']],
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
  { label: 'the explanation of the fitted step reworded', target: 'position', at: new RegExp(`(\\n {2}'eccentric-step': )${STRING}`), to: (m) => `${m[1]}'an eccentric orbit is advanced in steps of 561600 seconds, an empirically calibrated value, so the position carries an error that grows with the time ahead'` },
  { label: 'a second condition reworded', target: 'position', at: new RegExp(`(\\n {2}'orbit-horizon': )${STRING}`), to: (m) => `${m[1]}'an eccentric orbit is not carried for a whole orbit or more from its last update'` },
].map((edit, index) => ({ ...edit, id: `benign:${index}` }))

// ---- Run ----------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const main = async () => {
  const mutate = !process.argv.includes('--no-mutations')
  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

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
      const world = worldOf(edits)
      const missed = []

      for (const name of fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), world)

        if (!failed) {
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
