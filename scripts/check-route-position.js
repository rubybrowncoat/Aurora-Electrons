/*
  Checks the route-position contract (src/renderer/utilities/route-position.js, the plan that carries it, the mixin and the strip that show it, and the Route Finder, Transport and Hauling pages that use it) without a save.

  Every statement runs on endpoints, saved facts and a small SQLite database made here and on the real utilities, mixin, component and pages. Nothing is read from a save. The statements cover the acceptance of AE-087-02:
  - static positions are reproducible at a save timestamp: the same endpoints and facts give the same records whatever the arrival time asked for, each position is the one the save stores, and a body's age is the game time less the time the bodies were last moved;
  - a body, a fleet and a contact each give their own age and assumption, a fleet with orders and a contact are held where they are with nothing invented for later, and a contact seen before the game time is not supported;
  - a clock that is not read gives no age (never 0) and a place that never moves has none to give;
  - one gate states the mode: a family takes the propagated basis only with an adapter that gives a position, an adapter that cannot falls back to the saved position and says so, and the route's mode counts only the endpoints that move;
  - every dependent output states the same positions: the plan's legs, its totals and its running distances, a Transport run, a Hauling plan and a repeating route all take the records of the same endpoints from the same gate, so their mode and unknown conditions agree;
  - a result that rests on positions is an estimate that names what is held and unknown, an unavailable one stays so, and a route of fixed places is left as it was;
  - the read is schema-aware: a missing column or table reads as unknown, a fleet follows a body only at its exact position, and the read keeps to the race;
  - each page tracks the read as an optional input under the key its label has, never holds the page back, shows the strip in its loading, failed and ready states and has a summary on every panel.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names, both on the real sources and on the sources with every benign edit applied. Each benign edit, alone, stacked and all together, must leave every check green. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults and the benign edits.

  The pages are checked by what they do (their computed rows evaluated on a pseudo instance) and by the compiled templates' elements and bound expressions. No statement matches source text or prose; only a planted fault names a source anchor, and each is found by an identifier, a key or a code expression.
*/
const fs = require('fs')
const path = require('path')
const compiler = require('vue/compiler-sfc')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const inRenderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)

const FILES = {
  position: inRenderer('utilities', 'route-position.js'),
  plan: inRenderer('utilities', 'route-plan.js'),
  mixin: inRenderer('mixins', 'route-position.js'),
  component: inRenderer('components', 'page', 'RoutePositions.vue'),
  routesPage: inRenderer('pages', 'routes.vue'),
  transportPage: inRenderer('pages', 'information.vue'),
  haulingPage: inRenderer('pages', 'hauling.vue'),
}

const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------
const GAME_TIME = 1000000
const BODY_TIME = 900000
const KM = 1e6

const CLOCK = { gameTime: GAME_TIME, lastGrowthTime: BODY_TIME, orbitalMotion: 1, orbitalMotionAst: 1 }

// The race's fleets as the read gives them: 5 idle since 950000, 6 orbiting a body with nothing queued, 7 with two queued orders, 11 anchored to fleet 5 with no orders of its own. The race's waypoints: 31 carried by no body, 32 by a planet, 33 by an asteroid, 34 with an orbit association that is not recorded.
const FACTS = {
  clock: CLOCK,
  fleets: {
    5: { lastMoveTime: 950000, following: false, orders: 0, anchor: 0 },
    6: { lastMoveTime: 100, following: true, orders: 0, anchor: 0 },
    7: { lastMoveTime: 970000, following: false, orders: 2, anchor: 0 },
    11: { lastMoveTime: 960000, following: false, orders: 0, anchor: 5 },
  },
  waypoints: {
    31: { orbit: 0, asteroid: null },
    32: { orbit: 3, asteroid: false },
    33: { orbit: 4, asteroid: true },
    34: { orbit: null, asteroid: null },
  },
  problems: [],
}

const BODY = { family: 'body', key: 'body:3', id: 3, name: 'Earth', SystemID: 1, Xcor: 10, Ycor: 5, group: 'planet' }
const FIXED = { family: 'jump-point', key: 'jump:11', id: 11, name: 'Gate', SystemID: 1, Xcor: 100, Ycor: 0 }
const IDLE = { family: 'fleet', key: 'fleet:5', id: 5, name: 'Idle', SystemID: 1, Xcor: 1, Ycor: 1 }
const FOLLOWER = { family: 'fleet', key: 'fleet:6', id: 6, name: 'Follower', SystemID: 1, Xcor: 10, Ycor: 5 }
const BUSY = { family: 'fleet', key: 'fleet:7', id: 7, name: 'Busy', SystemID: 1, Xcor: 2, Ycor: 2 }
const ANCHORED = { family: 'fleet', key: 'fleet:11', id: 11, name: 'Anchored', SystemID: 1, Xcor: 5, Ycor: 5 }
const WAYPOINTS = Object.fromEntries([[31, 'Fixed waypoint'], [32, 'Planet waypoint'], [33, 'Asteroid waypoint'], [34, 'Unread waypoint']].map(([id, name]) => [id, { family: 'waypoint', key: `waypoint:${id}`, id, name, SystemID: 1, Xcor: 7, Ycor: 7 }]))
const SEEN = { family: 'contact', key: 'contact:9', id: 9, name: 'Seen', SystemID: 1, Xcor: 3, Ycor: 3, lastUpdate: 990000 }
const CURRENT = { ...SEEN, key: 'contact:10', id: 10, name: 'Current', lastUpdate: GAME_TIME }

const stop = (kind, id, extra = {}) => ({ key: `${kind}:${id}`, kind, name: `${kind} ${id}`, SystemID: 1, Xcor: 10, Ycor: 5, ...extra })

const jumpPoint = (WarpPointID, SystemID, WPLink, Xcor) => ({ WarpPointID, SystemID, WPLink, Distance: 0, Xcor, Ycor: 0, JumpGateStrength: 0, Explored: 1, MilitaryRestricted: 0, IgnoreForDistance: 0 })

// Systems 1 and 2 joined by one explored link, a mile apart.
const LINKS = [jumpPoint(11, 1, 21, 1000), jumpPoint(21, 2, 11, 0)]

const asJson = (value) => JSON.parse(JSON.stringify(value))

// ---- A SQLite database that answers the loader's queries --------------------------------------------------------------
const SCHEMA = `
  create table FCT_Game (GameID integer, GameTime real, LastGrowthTime real, OrbitalMotion integer, OrbitalMotionAst integer);
  create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, LastMoveTime real, OrbitBodyID integer, Xcor real, Ycor real, AnchorFleetID integer);
  create table FCT_MoveOrders (FleetID integer, GameID integer, MoveOrder integer);
  create table FCT_SystemBody (SystemBodyID integer, Xcor real, Ycor real, BodyClass integer);
  create table FCT_Waypoint (WaypointID integer, GameID integer, RaceID integer, OrbitBodyID integer);
`

const ROWS = `
  insert into FCT_Game values (1, 1000000, 900000, 1, 0);
  insert into FCT_SystemBody values (3, 10, 5, 1);
  insert into FCT_SystemBody values (4, null, 5, 3);
  insert into FCT_Fleet values (5, 1, 2, 950000, 0, 1, 1, 0);
  insert into FCT_Fleet values (6, 1, 2, 100, 3, 10, 5, 0);
  insert into FCT_Fleet values (7, 1, 2, 970000, 0, 2, 2, 0);
  insert into FCT_Fleet values (8, 1, 2, 960000, 3, 10, 6, 0);
  insert into FCT_Fleet values (9, 1, 2, null, 3, null, null, 0);
  insert into FCT_Fleet values (10, 1, 2, 960000, 4, 10, 5, 0);
  insert into FCT_Fleet values (11, 1, 2, 960000, 0, 5, 5, 5);
  insert into FCT_Fleet values (12, 1, 2, 960000, 0, 6, 6, null);
  insert into FCT_Fleet values (20, 1, 3, 960000, 0, 4, 4, 0);
  insert into FCT_Fleet values (21, 2, 2, 960000, 0, 4, 4, 0);
  insert into FCT_MoveOrders values (7, 1, 1), (7, 1, 2), (7, 2, 1), (21, 2, 1);
  insert into FCT_Waypoint values (31, 1, 2, 0), (32, 1, 2, 3), (33, 1, 2, 4), (34, 1, 2, null), (35, 1, 2, 99), (36, 1, 3, 3), (37, 2, 2, 3);
`

// A save of an older schema: no motion switches, no last move or orbit and no orders table.
const OLD_SCHEMA = `
  create table FCT_Game (GameID integer, GameTime real, LastGrowthTime real);
  create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, Xcor real, Ycor real);
  create table FCT_SystemBody (SystemBodyID integer, Xcor real, Ycor real);
`

const OLD_ROWS = `
  insert into FCT_Game values (1, 1000000, 900000);
  insert into FCT_Fleet values (5, 1, 2, 1, 1);
`

const databaseOf = async (schema, rows) => {
  const raw = new sqlite3.Database(':memory:')
  const exec = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

  await exec(schema)
  await exec(rows)

  return {
    query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => raw.all(sql.replace(/:([A-Za-z]+)\b/g, (_match, name) => String(replacements[name])), (error, found) => (error ? reject(error) : resolve([found])))),
    close: () => raw.close(),
  }
}

const STORE = { getters: { 'capabilities/result': {}, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }

// ---- The world: the modules, the mixin, the component and the pages as shipped, or with edits planted -------------------
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

  const utilitySources = { 'route-position': text.position, 'route-plan': text.plan }
  const pageSources = {
    'utilities/route-position': text.position,
    'utilities/route-plan': text.plan,
    'mixins/route-position': text.mixin,
    'components/page/RoutePositions': text.component,
    'pages/routes': text.routesPage,
    'pages/information': text.transportPage,
    'pages/hauling': text.haulingPage,
  }
  const labelsOf = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
  const modules = memo(() => loadUtilities(['route-position', 'route-plan', 'jump-graph', 'transport', 'haul-plan', 'provenance', 'places'], { sources: utilitySources }))
  const component = memo(() => loadPage('components/page/RoutePositions', { sources: pageSources }))
  const load = (name) => memo(() => loadPage(name, { sources: pageSources, modules: { 'mixins/load-state': labelsOf } }))

  return { text, modules, component, routes: load('pages/routes'), transport: load('pages/information'), hauling: load('pages/hauling') }
}

// ---- The checks --------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

const positionsOf = async (w, endpoints, options = { facts: FACTS }) => (await w.modules())['route-position'].routePositions(endpoints, options)

const recordOf = (positions, key) => positions.records.find((record) => record.identity.key === key)

check('static-baseline', 'static positions are reproducible at a save timestamp: the same records whatever the arrival time, the saved position and the age as the game time less the last body update', async (w) => {
  const endpoints = [BODY, FIXED, IDLE, BUSY, SEEN]
  const first = await positionsOf(w, endpoints)
  const again = await positionsOf(w, endpoints, { facts: JSON.parse(JSON.stringify(FACTS)) })
  const later = await positionsOf(w, endpoints, { facts: FACTS, at: 9e9 })
  const earlier = await positionsOf(w, endpoints, { facts: FACTS, at: 5 })

  assert.deepEqual(asJson(first), asJson(again), 'the same facts, the same records')
  assert.deepEqual(asJson(first), asJson(later), 'the arrival time moves nothing on the static basis')
  assert.deepEqual(asJson(first), asJson(earlier))
  assert.equal(first.mode, 'static')
  first.records.forEach((record) => {
    assert.equal(record.basis, 'static', `${record.identity.key} is on the static basis`)
    assert.ok(Object.isFrozen(record), `${record.identity.key} is frozen`)
    assert.deepEqual({ ...record.position }, { SystemID: 1, Xcor: record.position.Xcor, Ycor: record.position.Ycor })
  })

  const body = recordOf(first, 'body:3')

  assert.deepEqual({ ...body.position }, { SystemID: 1, Xcor: 10, Ycor: 5 }, 'the position is the one the save stores')
  assert.equal(body.observedAt, BODY_TIME)
  assert.equal(body.age, GAME_TIME - BODY_TIME, 'age is the game time less the last body update')
  assert.equal(body.clock, 'body')
  assert.equal(body.moves, true)
  assert.equal(body.identity.family, 'body')
})

check('legs-own-age', 'a body, a fleet and a contact each give their own age and assumption, a fleet with orders and a contact are held with no later position invented, and a contact seen earlier is not supported', async (w) => {
  const positions = await positionsOf(w, [BODY, IDLE, FOLLOWER, BUSY, SEEN, CURRENT, FIXED])
  const [body, idle, follower, busy, seen, current, fixed] = positions.records

  assert.equal(body.age, GAME_TIME - BODY_TIME)
  assert.equal(idle.age, GAME_TIME - 950000, 'an idle fleet is dated by its last move')
  assert.equal(idle.clock, 'fleet')
  assert.equal(idle.moves, false)
  assert.equal(follower.clock, 'body', 'a fleet orbiting a body moves with it and takes the body clock')
  assert.equal(follower.age, GAME_TIME - BODY_TIME)
  assert.equal(busy.age, GAME_TIME - 970000)
  assert.equal(seen.age, GAME_TIME - 990000, 'a contact is dated by its last update')
  assert.equal(seen.clock, 'contact')
  assert.equal(current.age, 0, 'a contact seen at the game time is current')
  assert.equal(new Set([body, idle, busy, seen].map((record) => record.assumption)).size, 4, 'each family states its own assumption')
  assert.equal(new Set([body.age, idle.age, busy.age, seen.age]).size, 4, 'and its own age')

  assert.ok(busy.conditions.includes('fleet-orders'), 'queued orders are said')
  assert.equal(busy.moves, null, 'whether a fleet with orders moves is not known')
  assert.deepEqual({ ...busy.position }, { SystemID: 1, Xcor: 2, Ycor: 2 }, 'and no later position is invented for it')
  assert.ok(!idle.conditions.includes('fleet-orders'))
  assert.ok(seen.conditions.includes('contact-motion'), 'a contact moves on its own')
  assert.ok(seen.conditions.includes('stale-contact'))
  assert.equal(seen.supported, false, 'a contact seen before the game time is not carried forward')
  assert.equal(current.supported, true)
  assert.deepEqual({ ...seen.position }, { SystemID: 1, Xcor: 3, Ycor: 3 }, 'a contact stays where it was seen')

  assert.equal(fixed.age, null, 'a place that never moves has no age to give')
  assert.equal(fixed.moves, false)
  assert.deepEqual(fixed.conditions, [])
  assert.equal(positions.moving, 5, 'everything but the fixed place and the idle fleet moves or may')
  assert.deepEqual(positions.unsupported, ['contact:9'])
  assert.ok(positions.unknown)
  assert.ok(positions.caveat)
  assert.equal(positions.oldest, GAME_TIME - BODY_TIME, 'the oldest saved position')
})

check('motion-switch', 'whether a body moves follows the game\'s orbital motion switches, an unrecorded switch is unknown and the lifepod and deep-space families are not supported', async (w) => {
  const off = await positionsOf(w, [BODY], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 0 } } })

  assert.equal(off.records[0].moves, false, 'a body that does not move is exact')
  assert.equal(off.caveat, false)

  const unknown = await positionsOf(w, [BODY], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: null } } })

  assert.equal(unknown.records[0].moves, null)
  assert.ok(unknown.records[0].conditions.includes('motion-switch'))

  const rock = { ...BODY, key: 'body:4', id: 4, group: 'asteroid' }
  const split = await positionsOf(w, [rock], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 1, orbitalMotionAst: 0 } } })

  assert.equal(split.records[0].moves, null, 'an asteroid follows its own switch, which must agree with the planets\'')

  const frozen = await positionsOf(w, [rock], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 0, orbitalMotionAst: 1 } } })

  assert.equal(frozen.records[0].moves, false, 'with planet and moon motion off nothing moves, whatever the asteroid switch says')
  assert.deepEqual(frozen.records[0].conditions, [])
  assert.equal(frozen.caveat, false)

  const drifting = await positionsOf(w, [{ family: 'lifepod', key: 'lifepod:1', id: 1, SystemID: 1, Xcor: 1, Ycor: 1 }, { family: 'deep-space-population', key: 'deep-space-population:2', id: 2, SystemID: 1, Xcor: 1, Ycor: 1 }])

  drifting.records.forEach((record) => {
    assert.equal(record.supported, false)
    assert.ok(record.conditions.includes('drift-unobserved'))
  })
  assert.equal((await positionsOf(w, [{ family: 'moon-base', key: 'x:1', id: 1, SystemID: 1, Xcor: 1, Ycor: 1 }])).records[0].conditions[0], 'family-unknown')
})

check('clock-unread', 'a clock that is not read gives no age and never 0, the summary says so and the age result is unavailable', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const unread = rp.routePositions([BODY, IDLE, FIXED], { facts: null })

  assert.equal(unread.ageKnown, false)
  assert.equal(unread.oldest, null)
  assert.equal(unread.clockRead, false)
  unread.records.filter((record) => record.family !== 'jump-point').forEach((record) => assert.equal(record.age, null, `${record.identity.key} has no age`))
  assert.ok(recordOf(unread, 'body:3').conditions.includes('clock-unread'))
  assert.ok(unread.caveat)
  assert.equal(rp.ageResult(unread).status, 'unavailable')
  assert.equal(rp.ageResult(unread).value, null)
  assert.equal(recordOf(unread, 'jump:11').age, null)

  const partial = rp.routePositions([BODY], { facts: { clock: { ...CLOCK, gameTime: null }, fleets: {}, problems: [] } })

  assert.equal(partial.records[0].age, null, 'a game time that is not read leaves no age')
  assert.equal(partial.ageKnown, false)

  const behind = rp.routePositions([BODY], { facts: { clock: { ...CLOCK, lastGrowthTime: GAME_TIME + 10 }, fleets: {}, problems: [] } })

  assert.equal(behind.records[0].age, null, 'a position dated after the game time has no age')
  assert.ok(behind.records[0].conditions.includes('clock-inconsistent'))

  const nothing = rp.routePositions([FIXED], { facts: null })

  assert.equal(rp.ageResult(nothing), null, 'no endpoint depends on a clock, so there is no age to state')
  assert.equal(nothing.caveat, false)

  const unseen = rp.routePositions([{ ...SEEN, lastUpdate: null }], { facts: FACTS })

  assert.equal(unseen.records[0].age, null, 'a contact with no last update has no age')
  assert.ok(unseen.records[0].conditions.includes('contact-age-unread'))
  assert.equal(rp.routePositions([IDLE], { facts: { ...FACTS, fleets: {} } }).records[0].conditions[0], 'fleet-state-unread', 'a fleet the read does not hold is not guessed')
})

check('gate-adapter', 'one gate states the mode: a family takes the propagated basis only with an adapter that gives a position, a failing adapter falls back to the saved position and says so, and only endpoints that move count', async (w) => {
  const rp = (await w.modules())['route-position']
  const ahead = { position: { SystemID: 1, Xcor: 99, Ycor: 98 }, observedAt: GAME_TIME + 500, conditions: [] }
  const seen = []
  const adapters = { body: (endpoint, context) => { seen.push([endpoint.key, context.at, context.base.basis]); return ahead } }

  assert.equal(rp.familyBasis('body', adapters), 'propagated')
  assert.equal(rp.familyBasis('fleet', adapters), 'static', 'a family with no adapter stays static')
  assert.equal(rp.familyBasis('body', {}), 'static')

  const propagated = rp.routePositions([BODY, FIXED], { facts: FACTS, adapters, at: 1234 })
  const body = recordOf(propagated, 'body:3')

  assert.equal(body.basis, 'propagated')
  assert.deepEqual({ ...body.position }, ahead.position)
  assert.equal(body.observedAt, ahead.observedAt)
  assert.equal(body.age, GAME_TIME - ahead.observedAt, 'the age is against the game time')
  assert.equal(body.assumption, 'propagated')
  assert.deepEqual(seen, [['body:3', 1234, 'static']], 'the adapter gets the endpoint, the arrival time and the static record')
  assert.equal(propagated.mode, 'propagated', 'a place that never moves takes no part in the mode')
  assert.equal(recordOf(propagated, 'jump:11').basis, 'static')

  assert.equal(rp.routePositions([BODY, BUSY], { facts: FACTS, adapters }).mode, 'mixed', 'a fleet that has no adapter is held')
  assert.equal(rp.routePositions([BODY, BODY], { facts: FACTS }).mode, 'static')
  assert.equal(rp.routePositions([FIXED], { facts: FACTS, adapters }).mode, 'static')

  const failing = rp.routePositions([BODY], { facts: FACTS, adapters: { body: () => null } })
  const kept = failing.records[0]

  assert.equal(kept.basis, 'static')
  assert.deepEqual({ ...kept.position }, { SystemID: 1, Xcor: 10, Ycor: 5 }, 'the saved position stands')
  assert.ok(kept.conditions.includes('propagation-unavailable'))
  assert.equal(kept.unknown, true)
  assert.equal(failing.mode, 'static')
  assert.ok(failing.unknown)

  const unsupported = rp.routePositions([SEEN], { facts: FACTS, adapters: { contact: () => ahead } })

  assert.equal(unsupported.records[0].basis, 'propagated')
  assert.equal(unsupported.records[0].supported, false, 'an adapter cannot lift what the contract does not support')
  assert.equal(rp.routePositions([SEEN], { facts: FACTS, adapters: { contact: () => ({ ...ahead, supported: false }) } }).records[0].supported, false)
  assert.equal(rp.routePositions([CURRENT], { facts: FACTS, adapters: { contact: () => ({ ...ahead, supported: false }) } }).records[0].supported, false, 'and an adapter can withdraw support')

  const throwing = rp.routePositions([BODY], { facts: FACTS, adapters: { body: () => { throw new Error('unavailable orbit') } } })

  assert.equal(throwing.records[0].basis, 'static', 'an adapter that throws falls back as one that gives nothing does')
  assert.deepEqual({ ...throwing.records[0].position }, { SystemID: 1, Xcor: 10, Ycor: 5 })
  assert.ok(throwing.records[0].conditions.includes('propagation-unavailable'))
  assert.equal(throwing.mode, 'static')

  const fixedOnly = rp.routePositions([FIXED], { facts: FACTS, adapters: { 'jump-point': () => ahead } })

  assert.equal(fixedOnly.records[0].basis, 'propagated')
  assert.equal(fixedOnly.mode, 'static', 'a place that never moves takes no part in the mode, an adapter that answered for it or not')

  const still = { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 0 } }, adapters }

  assert.equal(rp.routePositions([BODY], still).mode, 'static', 'a body that does not move is not propagated in the mode')
  assert.equal(rp.routePositions([BODY, BUSY], still).mode, 'static', 'and with a fleet an adapter leaves, the route has nothing propagated that moves')
  assert.equal(rp.routePositions([BODY, BUSY], { ...still, adapters: { ...adapters, fleet: () => ahead } }).mode, 'propagated')
  assert.notEqual(rp.ageText(body.age), rp.ageText(0), 'a position after the save is not current')
  assert.notEqual(rp.ageText(-3600), rp.ageText(3600), 'a position after the save is not as old as one before it')
  assert.equal(new Set([0, 3600, -3600, 90000, null].map((seconds) => rp.ageText(seconds))).size, 5, 'a current, an older, an ahead, a day-old and an unread position each read apart')
})

check('same-gate', 'every dependent route output states the same positions: the plan\'s legs, totals and running distances, a Transport run and a Hauling plan take the same records from the same gate', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const plan = m['route-plan']
  const graph = m['jump-graph']
  const origin = stop('colony', 7, { name: 'Mars' })
  const target = stop('fleet', 7, { SystemID: 2, Xcor: 5, Ycor: 5 })
  const lagrange = [{ SystemID: 1, Xcor: 100, Ycor: 0, LagrangePointID: 31 }, { SystemID: 1, Xcor: 900, Ycor: 0, LagrangePointID: 32 }]
  const planned = plan.planRoute([origin, target], { cycle: false, jumpPoints: LINKS, lagrangePoints: lagrange, facts: FACTS })
  const [leg] = planned.legs

  assert.ok(leg.route, 'a route joins the stops')
  assert.deepEqual(planned.legs.map((one) => asJson(one.positions)), [asJson(planned.positions)], 'one leg: the plan states the leg\'s positions')

  const keys = planned.positions.records.map((record) => record.identity.key)

  assert.ok(keys.includes('colony:7') && keys.includes('fleet:7'), 'both stops are stated')
  assert.ok(keys.includes('lagrange:31') && keys.includes('lagrange:32'), 'and the Lagrange points the leg jumps between')
  assert.ok(planned.positions.conditions.some((one) => one.code === 'fleet-orders') && planned.positions.missing.length > 0, 'the fleet\'s queued orders are said')

  // Transport states a run's endpoints and the Lagrange points of its route through the same calls.
  const route = graph.searchRoutes(LINKS, [{ SystemID: 1, Xcor: 10, Ycor: 5 }], { order: 'jumps', lagrangePoints: lagrange }).toPlace({ SystemID: 2, Xcor: 5, Ycor: 5 })
  const transport = rp.routePositions([rp.placeEndpoint(origin), rp.placeEndpoint(target), ...rp.viaEndpoints(route)], { facts: FACTS })

  assert.deepEqual(asJson(transport), asJson(planned.positions), 'Transport and Route Finder state the same positions for the same route')

  // Hauling reaches the same colony through a colony row and through an order, and the record is the same.
  const colonyRow = { PopulationID: 7, PopName: 'Mars', SystemID: 1, Xcor: 10, Ycor: 5 }
  const viaRow = rp.routePositions([rp.colonyPlaceEndpoint(colonyRow)], { facts: FACTS }).records[0]
  const viaOrder = rp.routePositions([rp.orderEndpoint({ DestinationType: 2, DestinationID: 3, PopulationID: 7, label: 'Mars', SystemID: 1, X: 10, Y: 5 })], { facts: FACTS }).records[0]
  const viaStop = rp.routePositions([rp.placeEndpoint(origin)], { facts: FACTS }).records[0]

  assert.deepEqual(asJson(viaRow), asJson(viaOrder), 'a colony row and an order that names it')
  assert.deepEqual(asJson({ ...viaRow, identity: null }), asJson({ ...viaStop, identity: null }), 'a colony row and a stop of the same colony')
  assert.equal(viaRow.identity.key, viaStop.identity.key)
  assert.equal(rp.orderEndpoint({ DestinationType: 10, DestinationID: 5, SystemID: 1, X: 1, Y: 1 }).family, 'fleet')
  assert.equal(rp.orderEndpoint({ DestinationType: 6, DestinationID: 9, SystemID: 1, X: 1, Y: 1 }).family, 'contact')
  assert.equal(rp.orderEndpoint({ DestinationType: 12, DestinationID: 31, SystemID: 1, X: 1, Y: 1 }).family, 'lagrange-point')

  // The figures of the plan state the summary's mode and unknown conditions.
  const figures = plan.planResults(planned)

  assert.equal(figures.km.status, 'estimated')
  planned.positions.missing.forEach((missing) => assert.ok(figures.km.inputs.missing.includes(missing), 'the distance names what the positions lack'))
  planned.positions.assumptions.forEach((held) => assert.ok(figures.km.assumptions.includes(held)))
  assert.deepEqual(plan.distanceResult(KM, undefined, planned.positions).inputs.missing, figures.km.inputs.missing)
  assert.deepEqual(plan.detailTotal(KM, 0, planned.positions).inputs.missing, figures.km.inputs.missing)

  // Without the read every output holds the saved positions with their age unknown.
  const waiting = plan.planRoute([origin, target], { cycle: false, jumpPoints: LINKS, lagrangePoints: lagrange })

  assert.equal(waiting.positions.ageKnown, false)
  assert.equal(plan.planResults(waiting).km.status, 'estimated')
  assert.ok(waiting.positions.conditions.some((one) => one.code === 'clock-unread'))

  // The plan's search and distances use the saved positions, so it is static whatever adapters it is handed.
  const ahead = { position: { SystemID: 1, Xcor: 1, Ycor: 1 }, observedAt: GAME_TIME + 1, conditions: [] }
  const bodies = [stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 1, Ycor: 1 })]
  const given = plan.planRoute(bodies, { cycle: false, jumpPoints: LINKS, facts: FACTS, adapters: { body: () => ahead } })
  const saved = plan.planRoute(bodies, { cycle: false, jumpPoints: LINKS, facts: FACTS })

  assert.equal(given.positions.mode, 'static', 'a plan does not claim a position its distances did not use')
  assert.equal(given.legs[0].positions.mode, 'static')
  assert.deepEqual(asJson(given.positions), asJson(saved.positions))
  assert.equal(given.km, saved.km)

  // Each leg of a longer route states its own positions, and the plan the union.
  const three = plan.planRoute([origin, target, stop('contact', 9, { SystemID: 2, Xcor: 1, Ycor: 1 })], { cycle: false, jumpPoints: LINKS, facts: FACTS })

  assert.equal(three.legs.length, 2)
  assert.ok(three.legs[0].positions.records.every((record) => record.identity.key !== 'contact:9'))
  assert.ok(three.legs[1].positions.records.some((record) => record.identity.key === 'contact:9'))
  assert.ok(three.positions.records.some((record) => record.identity.key === 'contact:9'))
  assert.ok(three.positions.conditions.some((one) => one.code === 'contact-motion'), 'the plan states the unknowns of every endpoint, not the first\'s')
  assert.ok(three.legs[1].positions.unknown)
  assert.equal(new Set(three.positions.records.map((record) => record.identity.key)).size, three.positions.records.length, 'the union lists each endpoint once')
})

check('result-caveat', 'a result that rests on positions is an estimate that names what is held and unknown, an unavailable one stays so, the jumps are left alone and a route of fixed places stays as it was', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const plan = m['route-plan']
  const moving = rp.routePositions([BODY, BUSY], { facts: FACTS })
  const fixed = rp.routePositions([FIXED], { facts: FACTS })
  const exact = plan.distanceResult(KM)

  assert.equal(exact.status, 'confirmed')
  assert.equal(plan.distanceResult(KM, undefined, fixed).status, 'confirmed', 'fixed places leave the distance as it was')

  const caveat = plan.distanceResult(KM, undefined, moving)

  assert.equal(caveat.status, 'estimated')
  assert.equal(caveat.value, KM, 'the value is the same figure')
  assert.ok(caveat.inputs.missing.length > 0 && caveat.assumptions.length > exact.assumptions.length)
  assert.equal(rp.withPositions({ ...exact, status: 'assumed' }, moving).status, 'estimated', 'an assumed result rests on the positions too, and an estimate is the weaker')
  assert.equal(rp.withPositions(exact, null), exact)
  assert.equal(rp.withPositions(null, moving), null)

  const none = plan.distanceResult(null, 'the distance', moving)

  assert.equal(none.status, 'unavailable', 'an unavailable result is never raised to an estimate')
  assert.equal(none.value, null)
  assert.deepEqual(none.inputs.missing, ['the distance'], 'and names only what it lacked')

  const stops = [stop('system', 1, { Xcor: 0, Ycor: 0 }), stop('system', 2, { SystemID: 2, Xcor: 0, Ycor: 0 })]
  const flat = plan.planRoute(stops, { cycle: false, jumpPoints: LINKS, facts: FACTS })
  const flatFigures = plan.planResults(flat)

  assert.equal(flat.positions.caveat, false)
  assert.equal(flatFigures.km.status, 'confirmed', 'systems and jump points are fixed')

  const bodies = plan.planRoute([stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 1, Ycor: 1 })], { cycle: false, jumpPoints: LINKS, facts: FACTS })
  const figures = plan.planResults(bodies)

  assert.equal(figures.km.status, 'estimated')
  assert.equal(figures.jumps.status, 'confirmed', 'the jumps do not rest on a position')
  assert.deepEqual(figures.jumps.inputs.missing, [])
  assert.ok(plan.detailTotal(KM, 0, bodies.positions).status === 'estimated')
  assert.ok(plan.detailTotal(KM, 0, flat.positions).status === 'confirmed')
})

check('waypoint-carried', 'a waypoint carried by a body moves with the body\'s clock and switches, one carried by none is fixed, and one whose association is not read is unknown, never fixed', async (w) => {
  const rp = (await w.modules())['route-position']
  const [fixed, planet, rock, unread] = Object.values(WAYPOINTS)
  const positions = rp.routePositions([fixed, planet, rock, unread], { facts: FACTS })
  const [fixedRecord, planetRecord, rockRecord, unreadRecord] = positions.records

  assert.equal(fixedRecord.moves, false, 'a waypoint carried by no body stays where it is')
  assert.equal(fixedRecord.age, null)
  assert.deepEqual(fixedRecord.conditions, [])
  assert.equal(fixedRecord.assumption, 'fixed')
  assert.equal(planetRecord.moves, true, 'a waypoint carried by a planet moves with it')
  assert.equal(planetRecord.clock, 'body')
  assert.equal(planetRecord.age, GAME_TIME - BODY_TIME, 'and is as old as the last body update')
  assert.deepEqual(planetRecord.conditions, [])
  assert.deepEqual({ ...planetRecord.position }, { SystemID: 1, Xcor: 7, Ycor: 7 }, 'it is held where the save has it')
  assert.equal(rockRecord.moves, true)
  assert.equal(unreadRecord.moves, null, 'a waypoint whose association is not recorded is not said to stay or to move')
  assert.ok(unreadRecord.conditions.includes('waypoint-orbit-unread'))
  assert.equal(unreadRecord.unknown, true)
  assert.equal(new Set([fixedRecord, planetRecord, unreadRecord].map((record) => `${record.assumption}|${record.conditions.join(',')}|${record.moves}`)).size, 3, 'fixed, carried and unread are each stated apart')
  assert.ok(positions.caveat)
  assert.equal(positions.moving, 3)
  assert.ok(positions.conditions.some((one) => one.code === 'waypoint-orbit-unread' && one.keys.join() === unread.key))

  const switched = (clock) => rp.routePositions([planet, rock], { facts: { ...FACTS, clock: { ...CLOCK, ...clock } } })

  assert.deepEqual(switched({ orbitalMotion: 0 }).records.map((record) => record.moves), [false, false], 'with motion off a carried waypoint does not move, and states none of the unknowns')
  assert.equal(switched({ orbitalMotion: 0 }).caveat, false)
  assert.deepEqual(switched({ orbitalMotionAst: 0 }).records.map((record) => record.moves), [true, null], 'a waypoint carried by an asteroid follows the asteroids\' own switch as well')
  assert.ok(switched({ orbitalMotionAst: 0 }).records[1].conditions.includes('motion-switch'))
  assert.deepEqual(switched({ orbitalMotion: null }).records.map((record) => record.moves), [null, null], 'a switch the save does not record leaves it unknown')

  const unknownBody = rp.routePositions([rock], { facts: { ...FACTS, waypoints: { 33: { orbit: 4, asteroid: null } }, clock: { ...CLOCK, orbitalMotionAst: 0 } } })

  assert.equal(unknownBody.records[0].moves, null, 'a body whose kind is not read needs both switches')

  const never = rp.routePositions([fixed, planet], { facts: { ...FACTS, waypoints: undefined } })

  never.records.forEach((record) => assert.ok(record.conditions.includes('waypoint-orbit-unread'), `${record.identity.key}: a read that holds no waypoints leaves the association unread`))
  assert.ok(rp.routePositions([{ ...fixed, key: 'waypoint:99', id: 99 }], { facts: FACTS }).records[0].conditions.includes('waypoint-orbit-unread'), 'a waypoint the read does not hold is not guessed')

  const waiting = rp.routePositions([fixed], { facts: null })

  assert.equal(waiting.records[0].unknown, true, 'while the read is not in, a waypoint is not said to stay')
  assert.ok(waiting.records[0].conditions.includes('waypoint-orbit-unread'))
  assert.equal(waiting.ageKnown, false)
})

check('fleet-anchored', 'a fleet anchored to another fleet may move in formation without orders of its own, so where it will be is not known, and an anchor the save does not record is unknown', async (w) => {
  const rp = (await w.modules())['route-position']
  const positions = rp.routePositions([IDLE, ANCHORED], { facts: FACTS })
  const [idle, anchored] = positions.records

  assert.equal(idle.moves, false)
  assert.equal(anchored.moves, null, 'an anchored fleet with an empty queue is not idle')
  assert.ok(anchored.conditions.includes('fleet-anchored'))
  assert.ok(!anchored.conditions.includes('fleet-orders'))
  assert.notEqual(anchored.assumption, idle.assumption)
  assert.equal(anchored.unknown, true)
  assert.deepEqual({ ...anchored.position }, { SystemID: 1, Xcor: 5, Ycor: 5 }, 'no later position is invented for it')
  assert.equal(positions.moving, 1)
  assert.ok(positions.caveat)

  const orbiting = rp.routePositions([FOLLOWER], { facts: { ...FACTS, fleets: { 6: { ...FACTS.fleets[6], anchor: 5 } } } }).records[0]

  assert.equal(orbiting.moves, null, 'a fleet at a body but anchored to a fleet is not carried by the body alone')
  assert.ok(orbiting.conditions.includes('fleet-anchored'))

  const both = rp.routePositions([BUSY], { facts: { ...FACTS, fleets: { 7: { ...FACTS.fleets[7], anchor: 5 } } } }).records[0]

  assert.ok(both.conditions.includes('fleet-orders') && both.conditions.includes('fleet-anchored'), 'queued orders and an anchor are each said')

  const unread = rp.routePositions([IDLE], { facts: { ...FACTS, fleets: { 5: { ...FACTS.fleets[5], anchor: null } } } }).records[0]

  assert.equal(unread.moves, null, 'an anchor that is not recorded is not none')
  assert.ok(unread.conditions.includes('fleet-state-unread'))

  const missing = rp.routePositions([IDLE], { facts: { ...FACTS, fleets: { 5: { lastMoveTime: 950000, following: false, orders: 0 } } } }).records[0]

  assert.ok(missing.conditions.includes('fleet-state-unread'), 'and neither is a read that has no anchor at all')
})

check('unread-position', 'a present endpoint with no coordinate is unknown, whether it moves or not, and is never described as holding its saved position', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const plan = m['route-plan']
  const unplaced = [{ ...BODY, Xcor: null }, { ...FIXED, Ycor: null }, { ...WAYPOINTS[31], Xcor: undefined }, { ...IDLE, Xcor: null, Ycor: null }, { ...BODY, key: 'body:8', id: 8, Xcor: Number.NaN }]

  for (const clock of [CLOCK, { ...CLOCK, orbitalMotion: 0 }]) {
    const positions = rp.routePositions(unplaced, { facts: { ...FACTS, clock } })

    positions.records.forEach((record) => {
      assert.equal(record.position, null, `${record.identity.key}: no position is stated`)
      assert.ok(record.conditions.includes('position-unread'), `${record.identity.key}: the unread position is said, moving or not (motion switch ${clock.orbitalMotion})`)
      assert.equal(record.unknown, true)
      assert.notEqual(record.assumption, 'fixed', `${record.identity.key}: a position that is not recorded does not hold at any time`)
    })
    assert.ok(positions.caveat)
    assert.ok(positions.unknown)
    assert.ok(positions.missing.length > 0)
    rp.describePositions(positions).forEach((group) => {
      assert.ok(group.conditions.some((one) => one.code === 'position-unread'), 'the strip states it for each group')
      assert.notEqual(group.assumption, 'fixed')
    })
  }

  const placed = rp.routePositions([BODY, FIXED, WAYPOINTS[31]], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 0 } } })

  assert.equal(placed.caveat, false, 'a placed fixed endpoint is still exact')
  assert.ok(placed.records.every((record) => !record.conditions.includes('position-unread')))
  assert.ok(rp.routePositions([rp.placeEndpoint(stop('system', 1, { Xcor: undefined, Ycor: undefined }))], { facts: FACTS }).records[0].conditions.length === 0, 'a system is its own centre')

  const planned = plan.planRoute([stop('colony', 7), stop('body', 3, { Xcor: null })], { cycle: false, jumpPoints: LINKS, facts: FACTS })

  assert.equal(planned.legs[0].route, null)
  assert.ok(planned.legs[0].positions.conditions.some((one) => one.code === 'position-unread'), 'a leg to a place with no coordinate states it')
  assert.ok(planned.positions.unknown)
})

check('effective-start', 'a leg states the position it is flown from: the stop before it, the jump point a system stop was reached at, or where the fleet already was when the system is the one it is in', async (w) => {
  const plan = (await w.modules())['route-plan']
  const mover = stop('body', 3, { Xcor: 100, Ycor: 20 })
  const goal = stop('waypoint', 31, { Xcor: 300, Ycor: 20 })
  const kept = plan.planRoute([mover, stop('system', 1, { Xcor: 0, Ycor: 0 }), goal], { cycle: false, jumpPoints: LINKS, facts: FACTS })
  const [first, second] = kept.legs

  assert.deepEqual({ ...second.start }, { SystemID: 1, Xcor: 100, Ycor: 20 }, 'a same-system stop leaves the fleet where it was')
  assert.equal(second.route.km, 200)
  assert.deepEqual(second.positions.records.map((record) => record.identity.key).sort(), ['body:3', 'waypoint:31'], 'the leg states the body it starts from, not the system centre')
  assert.deepEqual({ ...second.positions.records.find((record) => record.identity.key === 'body:3').position }, { SystemID: 1, Xcor: 100, Ycor: 20 })
  assert.equal(second.positions.caveat, true, 'and the body\'s caveat stays on the leg')
  assert.ok(second.positions.moving >= 1)
  assert.ok(first.positions.records.some((record) => record.identity.key === 'system:1'))

  const through = plan.planRoute([mover, stop('system', 2, { SystemID: 2, Xcor: 0, Ycor: 0 }), stop('waypoint', 31, { SystemID: 2, Xcor: 40, Ycor: 0 })], { cycle: false, jumpPoints: LINKS, facts: FACTS })
  const [, after] = through.legs

  assert.deepEqual({ ...after.start }, { SystemID: 2, Xcor: 0, Ycor: 0 }, 'a system is reached at the jump point a route comes in through')
  assert.deepEqual(after.positions.records.map((record) => record.identity.key).sort(), ['jump:21', 'waypoint:31'], 'the leg states that jump point as its start')
  assert.deepEqual({ ...after.positions.records.find((record) => record.identity.key === 'jump:21').position }, { ...after.start })
  assert.equal(after.positions.caveat, false, 'a jump point and a waypoint nothing carries are exact')

  for (const planned of [kept, through]) {
    planned.legs.forEach((leg) => assert.deepEqual({ ...leg.positions.records[0].position }, { ...leg.start }, 'the first record of a leg is the position it is flown from'))
  }

  const cut = plan.planRoute([mover, { key: 'colony:8', name: 'Lost', unavailable: true }, stop('system', 1, { Xcor: 0, Ycor: 0 }), goal], { cycle: false, jumpPoints: LINKS, facts: FACTS })

  assert.deepEqual({ ...cut.legs[2].start }, { SystemID: 1, Xcor: 0, Ycor: 0 }, 'after an unavailable stop the fleet is at the next stop')
  assert.ok(cut.legs[2].positions.records.some((record) => record.identity.key === 'system:1'))
  assert.ok(cut.legs[2].positions.records.every((record) => record.identity.key !== 'body:3'))
})

check('order-identity', 'an order\'s destination is keyed as every page names the place, a survey location by its own ID and never by its number within a system, and an order through a jump point or a Lagrange point leaves the fleet at the far side', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const typed = [[1, {}], [2, {}], [2, { PopulationID: 7, PopulationRaceID: 2 }], [4, { SurveyLocationID: 648661 }], [5, {}], [6, {}], [7, {}], [8, {}], [10, {}], [12, {}], [14, {}], [15, {}]]

  typed.forEach(([type, extra]) => {
    const order = { DestinationType: type, DestinationID: 9, PopulationID: 0, SystemID: 1, X: 1, Y: 2, ...extra }

    assert.equal(rp.orderEndpoint(order).key, m.places.orderPlaceKey(order, 2), `destination type ${type}: the key of the place the pages name`)
    assert.equal(rp.orderEndpoint(order).id, Number(rp.orderEndpoint(order).key.split(':')[1]), `destination type ${type}: its id is the one in the key`)
  })

  const survey = (SystemID, SurveyLocationID) => ({ DestinationType: 4, DestinationID: 1, PopulationID: 0, SurveyLocationID, SystemID, X: 5, Y: 5, label: `Location in ${SystemID}` })
  const sols = rp.routePositions([survey(21625, 648661), survey(21629, 648781)].map(rp.orderEndpoint), { facts: FACTS })

  assert.equal(sols.records.length, 2, 'survey locations of equal number in two systems are two endpoints')
  assert.deepEqual(sols.records.map((record) => record.identity.id), [648661, 648781])
  assert.equal(sols.records[0].identity.family, 'survey-location')

  const unread = rp.routePositions([survey(21625, null), survey(21629, undefined)].map(rp.orderEndpoint), { facts: FACTS })

  assert.equal(unread.records.length, 2, 'a survey location whose ID is not read is not taken for another of the same number')
  unread.records.forEach((record) => {
    assert.equal(record.identity.id, null, 'and has no id')
    assert.notEqual(record.identity.key, m.places.orderPlaceKey({ ...survey(1, 1), SurveyLocationID: 1 }, 2), 'nor for the location of that ID')
  })

  const transit = { DestinationType: 12, DestinationID: 31, PopulationID: 0, SystemID: 1, X: 100, Y: 0, Jumps: 1, ExitDestinationID: 32, ExitSystemID: 1, ExitX: 900, ExitY: 0, label: 'Jump', exitLabel: 'Landing' }
  const exit = rp.orderExitEndpoint(transit)

  assert.equal(exit.key, m.places.orderPlaceKey({ ...transit, DestinationID: 32 }, 2), 'a Lagrange jump comes out at the point it names')
  assert.equal(exit.family, 'lagrange-point')
  assert.deepEqual([exit.SystemID, exit.Xcor, exit.Ycor], [1, 900, 0])
  assert.equal(exit.name, 'Landing')
  assert.notEqual(exit.key, rp.orderEndpoint(transit).key)

  const gate = rp.orderExitEndpoint({ DestinationType: 1, DestinationID: 11, PopulationID: 0, SystemID: 1, X: 1000, Y: 0, Jumps: 1, ExitDestinationID: 21, ExitSystemID: 2, ExitX: 0, ExitY: 0 })

  assert.deepEqual([gate.family, gate.key, gate.SystemID, gate.Xcor], ['jump-point', m.places.orderPlaceKey({ DestinationType: 1, DestinationID: 21 }, 2), 2, 0], 'and a transit through a jump point in the system on the far side')

  const stays = { ...transit, Jumps: 0 }

  assert.deepEqual(asJson(rp.orderExitEndpoint(stays)), asJson(rp.orderEndpoint(stays)), 'an order that goes through nothing leaves the fleet where it went')
  assert.equal(rp.orderExitEndpoint({ ...transit, ExitDestinationID: null }).id, null, 'an exit whose identity is not read has none')
  assert.equal(rp.routePositions([rp.orderEndpoint(transit), rp.orderExitEndpoint({ ...transit, ExitDestinationID: undefined })], { facts: FACTS }).records.length, 2, 'and is not taken for the point the order goes to')
})

// ---- The read ----------------------------------------------------------------------------------------------------------
check('loader-schema', 'the read gives the clock, the race\'s fleets and waypoints, a missing column or table reads as unknown, a fleet follows a body only at its exact position and the read keeps to the race and game', async (w) => {
  const rp = (await w.modules())['route-position']
  const database = await databaseOf(SCHEMA, ROWS)
  const facts = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })

  assert.deepEqual({ ...facts.clock }, { gameTime: GAME_TIME, lastGrowthTime: BODY_TIME, orbitalMotion: 1, orbitalMotionAst: 0 })
  assert.deepEqual(Object.keys(facts.fleets).map(Number).sort((a, b) => a - b), [5, 6, 7, 8, 9, 10, 11, 12], 'the race\'s fleets in the game, no other race\'s or game\'s')
  assert.deepEqual({ ...facts.fleets[5] }, { lastMoveTime: 950000, following: false, orders: 0, anchor: 0 })
  assert.equal(facts.fleets[11].anchor, 5, 'the fleet a fleet is anchored to')
  assert.equal(facts.fleets[12].anchor, null, 'an anchor that is stored as null is unknown, not none')
  assert.deepEqual(Object.keys(facts.waypoints).map(Number).sort((a, b) => a - b), [31, 32, 33, 34, 35], 'the race\'s waypoints in the game, no other race\'s or game\'s')
  assert.deepEqual({ ...facts.waypoints[31] }, { orbit: 0, asteroid: null }, 'a waypoint carried by no body')
  assert.deepEqual({ ...facts.waypoints[32] }, { orbit: 3, asteroid: false })
  assert.deepEqual({ ...facts.waypoints[33] }, { orbit: 4, asteroid: true })
  assert.deepEqual({ ...facts.waypoints[34] }, { orbit: null, asteroid: null }, 'an association stored as null is unknown, not none')
  assert.deepEqual({ ...facts.waypoints[35] }, { orbit: 99, asteroid: null }, 'a body the read does not hold leaves its kind unknown')
  assert.equal(facts.fleets[6].following, true, 'a fleet at its body\'s exact position follows it')
  assert.equal(facts.fleets[8].following, false, 'a fleet beside its body does not')
  assert.equal(facts.fleets[9].following, null, 'a fleet with no position is not said to follow or not')
  assert.equal(facts.fleets[10].following, null, 'a fleet at a body whose position is not stored is not said to follow or not')
  assert.equal(facts.fleets[9].lastMoveTime, null)
  assert.equal(facts.fleets[7].orders, 2, 'queued orders are counted for the game')
  assert.equal(facts.fleets[5].orders, 0)
  assert.deepEqual(facts.problems, [])
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.fleets) && Object.isFrozen(facts.waypoints))
  assert.equal(rp.routePositions([ANCHORED], { facts }).records[0].moves, null, 'an anchored fleet read from the save is not idle')
  assert.equal(rp.routePositions([WAYPOINTS[32]], { facts }).records[0].moves, true, 'a carried waypoint read from the save moves')
  assert.equal(rp.routePositions([WAYPOINTS[31]], { facts }).records[0].moves, false)

  const other = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 3 })

  assert.deepEqual(Object.keys(other.fleets), ['20'], 'another race reads its own fleets')
  assert.deepEqual(Object.keys(other.waypoints), ['36'], 'and its own waypoints')
  assert.deepEqual(Object.keys((await rp.loadPositionFacts(database, { GameID: 2, RaceID: 2 })).fleets), ['21'])
  assert.deepEqual(Object.keys((await rp.loadPositionFacts(database, { GameID: 2, RaceID: 2 })).waypoints), ['37'])
  assert.equal((await rp.loadPositionFacts(database, { GameID: 2, RaceID: 2 })).clock.gameTime, null, 'a game with no row has no clock')
  database.close()

  const old = await databaseOf(OLD_SCHEMA, OLD_ROWS)
  const read = await rp.loadPositionFacts(old, { GameID: 1, RaceID: 2 })

  assert.equal(read.clock.gameTime, GAME_TIME)
  assert.equal(read.clock.orbitalMotion, null, 'a switch the save lacks is unknown, not off')
  assert.equal(read.clock.orbitalMotionAst, null)
  assert.equal(read.fleets[5].lastMoveTime, null, 'a missing last move is null, not 0')
  assert.equal(read.fleets[5].following, null, 'a missing orbit is unknown')
  assert.equal(read.fleets[5].orders, null, 'a missing orders table is unknown, not none')
  assert.equal(read.fleets[5].anchor, null, 'a missing anchor column is unknown, not none')
  assert.deepEqual(read.waypoints, {}, 'a missing waypoint table reads no waypoints')
  assert.ok(read.problems.some((problem) => problem.includes('FCT_Waypoint')), 'and names what it lacks')
  assert.equal(rp.routePositions([WAYPOINTS[31]], { facts: read }).records[0].unknown, true, 'a waypoint of such a save is not said to stay')
  assert.equal(rp.routePositions([IDLE], { facts: read }).records[0].age, null)
  old.close()

  const bare = await databaseOf('create table FCT_Game (GameID integer);', 'insert into FCT_Game values (1);')
  const empty = await rp.loadPositionFacts(bare, { GameID: 1, RaceID: 2 })

  assert.equal(empty.clock.gameTime, null)
  assert.deepEqual(empty.fleets, {})
  assert.deepEqual(empty.waypoints, {})
  assert.ok(empty.problems.length >= 3, 'what the save lacks is named')
  bare.close()
})

// ---- The mixin, the strip and the pages ---------------------------------------------------------------------------------
const loadErrorsOf = (state) => new Proxy({}, { get: (_target, key) => (key === 'positionFacts' ? state : null), has: () => true })

const PAGES = [['routes', 'pages/routes'], ['transport', 'pages/information'], ['hauling', 'pages/hauling']]

check('optional-read', 'each page tracks the position read under the key it labels it with, holds nothing back while it loads or fails, and reads again for another race', async (w) => {
  const database = await databaseOf(SCHEMA, ROWS)

  for (const [name] of PAGES) {
    const page = await w[name]()
    const make = (state, extra = {}) => instantiate(page, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(state), ...extra } })
    const reads = instantiate(page, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

    assert.equal(typeof reads.inputLabels.positionFacts, 'string', `${name}: labelled`)
    await reads.runAsync('positionFacts')
    assert.equal(reads.loadErrors.positionFacts, null, `${name}: tracked under its label`)
    assert.equal(reads.positionFacts.clock.gameTime, GAME_TIME)
    assert.deepEqual(Object.keys(reads.positionFacts.fleets).map(Number).sort((a, b) => a - b), [5, 6, 7, 8, 9, 10, 11, 12], `${name}: the race's fleets`)
    assert.deepEqual(Object.keys(reads.positionFacts.waypoints).map(Number).sort((a, b) => a - b), [31, 32, 33, 34, 35], `${name}: the race's waypoints`)
    assert.equal(reads.positionRead, reads.positionFacts, `${name}: the facts once the read succeeded`)

    const elsewhere = instantiate(page, { $store: STORE, database, GameID: 1, RaceID: 3, data: { loadErrors: {} } })

    await elsewhere.runAsync('positionFacts')
    assert.deepEqual(Object.keys(elsewhere.positionFacts.fleets), ['20'], `${name}: another race reads again`)

    for (const state of [undefined, 'the read failed']) {
      const waiting = make(state, { positionFacts: reads.positionFacts })

      assert.equal(waiting.positionRead, null, `${name} ${state}: a read that is not in gives no facts`)
      assert.equal(waiting.positionState.loading, state === undefined)
      assert.equal(waiting.positionState.failed.length > 0, state !== undefined)
      assert.deepEqual(waiting.failedInputs, [], `${name} ${state}: the read holds the page back from nothing`)
      assert.equal(waiting.inputsLoaded, true)
    }

    assert.equal(make(null, { positionFacts: reads.positionFacts }).positionState.loading, false)
  }

  database.close()
})

const elementsOf = (rootNode) => {
  const found = []
  const walk = (node) => {
    found.push(node)
    node.children.filter((child) => child.type === 1).forEach(walk)
    ;(node.ifConditions || []).slice(1).forEach(({ block }) => walk(block))
    Object.values(node.scopedSlots || {}).forEach(walk)
  }

  walk(rootNode)

  return found
}

const attrOf = (node, name) => {
  const found = node.attrsList.find((attr) => attr.name === name || attr.name === `:${name}`)

  return found ? found.value : undefined
}

const templateOf = (source, filename) => {
  const parsed = compiler.parse({ source, filename })

  return compiler.compileTemplate({ source: (parsed.descriptor || parsed).template.content, filename, id: filename }).ast
}

const classTokens = (node) => (node.staticClass || '').replace(/["']/g, '').split(/\s+/)

const TEMPLATES = [['routes', 'routesPage', 'routes.vue'], ['transport', 'transportPage', 'information.vue'], ['hauling', 'haulingPage', 'hauling.vue']]

// A bound expression of a template evaluated against a page instance: a name the page does not have throws.
// eslint-disable-next-line no-new-func
const evaluated = (expression, scope) => new Function('scope', `with (scope) { return (${expression}) }`)(scope)

const scopeOf = (vm) => new Proxy({}, { has: (_target, key) => typeof key === 'string' && key in vm, get: (_target, key) => (typeof key === 'symbol' ? undefined : vm[key]) })

// The scoped slots of a data table by name, as the template wrote it: a slot used by two tables is listed twice.
const slotsOf = (nodes, name) => nodes.filter((node) => node.tag === 'template' && typeof node.slotTarget === 'string' && node.slotTarget.replace(/[`'"]/g, '') === name)

const marksIn = (node) => elementsOf(node).filter((one) => one.tag === 'provenance-mark')

const resultOf = (mark) => attrOf(mark, 'result')

const STATES = [['loaded', null], ['pending', undefined], ['failed', 'the read failed']]

check('strip-bound', 'each page binds the strip to a summary of its own positions and to the read\'s state, retries the read, and every top-level panel has a summary in the loaded, pending and failed states', async (w) => {
  for (const [name, source, file] of TEMPLATES) {
    const nodes = elementsOf(templateOf(w.text[source], file))
    const strips = nodes.filter((node) => node.tag === 'route-positions')
    const page = await w[name]()

    assert.ok(strips.length >= 1, `${name}: the strip is shown`)

    strips.forEach((strip) => {
      assert.ok(attrOf(strip, 'positions'), `${name}: the strip has positions`)
      assert.equal(attrOf(strip, 'state'), 'positionState', `${name}: and the read's state`)
      assert.equal(strip.events.retry.value, 'retryPosition', `${name}: the strip retries the read`)
      assert.ok(!classTokens(strip).includes('panel'), `${name}: the strip is not a panel, so it adds none to summarise`)
    })

    const panels = nodes.filter((node) => classTokens(node).includes('panel'))

    assert.ok(panels.length > 0, `${name}: the page has panels`)
    panels.forEach((panel) => {
      const stated = panel.attrsList.find((attr) => attr.name === 'data-summary' || attr.name === ':data-summary')

      assert.ok(stated, `${name}: every panel has a summary`)
      STATES.forEach(([label, state]) => {
        const vm = instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(state), positionFacts: state === null ? FACTS : null } })
        let text = null

        try {
          text = stated.name === 'data-summary' ? stated.value : evaluated(stated.value, scopeOf(vm))
        } catch (error) {
          text = null
        }

        assert.ok(typeof text === 'string' && text.trim().length > 0, `${name}, ${label}: every panel has a summary in the state it is rendered in`)
      })
    })
  }
})

check('strip-component', 'the strip says it is reading while the read is in flight, names a failed read with a retry, states the age with a mark and never shows an age before the read', async (w) => {
  const rp = (await w.modules())['route-position']
  const component = await w.component()
  const positions = rp.routePositions([BODY, BUSY, SEEN, FIXED], { facts: FACTS })
  const unread = rp.routePositions([BODY, BUSY], { facts: null })
  const vmOf = (given, state) => instantiate(component, { $store: STORE, data: { positions: given, state } })
  const ready = vmOf(positions, { loading: false, failed: '', error: '' })

  assert.equal(ready.age.value, GAME_TIME - BODY_TIME, 'the age of the oldest saved position')
  assert.equal(ready.ageValue, rp.ageText(GAME_TIME - BODY_TIME))
  assert.equal(ready.groups.length, rp.describePositions(positions).length)
  assert.equal(ready.modeText.length > 0, true)
  assert.ok(ready.groups.some((group) => group.conditions.some((condition) => condition.code === 'fleet-orders')), 'a fleet with orders is listed with its condition')

  const loading = vmOf(positions, { loading: true, failed: '', error: '' })

  assert.equal(loading.age, null, 'no age while the read is in flight')

  const failed = vmOf(unread, { loading: false, failed: 'the age of the saved positions', error: 'x' })

  assert.equal(failed.age.status, 'unavailable', 'a failed read leaves the age unavailable')
  assert.equal(typeof failed.ageValue, 'string')
  assert.ok(failed.ageValue.length > 0 && !/\d/.test(failed.ageValue), 'an age that is not read states no figure')
  assert.ok([0, 3600, -3600, 90000].every((seconds) => rp.ageText(seconds) !== failed.ageValue), 'and reads apart from every age that is')

  const nodes = elementsOf(templateOf(w.text.component, 'RoutePositions.vue'))
  const marks = nodes.filter((node) => node.tag === 'provenance-mark')

  assert.ok(marks.some((mark) => attrOf(mark, 'rule') === 'route.position'), 'the positions carry their rule')
  assert.ok(marks.some((mark) => attrOf(mark, 'result') === 'age'), 'the age carries its result')
  assert.ok(nodes.some((node) => node.tag === 'v-btn' && node.events && node.events.click), 'the failed read can be retried')
  assert.ok(nodes.some((node) => attrOf(node, 'data-condition') !== undefined), 'each unknown condition is listed')
  assert.ok(rp.ageResult(positions).rule.id === 'route.positionAge')
})

const UNSURE = { ...FACTS, clock: { ...CLOCK, orbitalMotion: null } }

const SPEED = { status: 'assumed', value: 1000, rule: { id: 'route.speed' }, inputs: { present: [], missing: [] }, assumptions: [], units: 'km/s' }

const LAGRANGE = [{ SystemID: 1, Xcor: 100, Ycor: 0, LagrangePointID: 31 }, { SystemID: 1, Xcor: 900, Ycor: 0, LagrangePointID: 32 }]

// A result that rests on the positions: an estimate that names every unknown the positions state.
const statesPositions = (result, positions, message) => {
  assert.ok(result, message)
  assert.equal(result.status, 'estimated', message)
  assert.ok(positions.missing.length > 0, `${message}: there is something to name`)
  positions.missing.forEach((missing) => assert.ok(result.inputs.missing.includes(missing), `${message}: names "${missing}"`))
}

check('pages-routes', 'Route Finder states every leg, total, running distance and distance row with the positions it rests on, over the legs flown so far', async (w) => {
  const page = await w.routes()
  const graph = (await w.modules())['jump-graph']
  const rp = (await w.modules())['route-position']
  const seen = stop('contact', 9, { name: 'Seen', lastUpdate: 990000 })
  const mars = stop('colony', 7, { name: 'Mars' })
  const busy = stop('fleet', 7, { SystemID: 2, Xcor: 5, Ycor: 5, name: 'Busy' })
  const stops = [seen, mars, busy]
  const searchOptions = { order: 'jumps', lagrangePoints: LAGRANGE }
  const make = (facts, extra = {}) => instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(facts ? null : undefined), positionFacts: facts, plannedStops: stops, stopKeys: stops.map((one) => one.key), placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])), extra: {}, lazyState: {}, legNotes: {}, systemNameOf: (id) => `System ${id}`, pointName: () => 'a point', lagrangeName: () => 'a Lagrange point', jumpPoints: LINKS, lagrangePoints: LAGRANGE, cycle: false, searchOptions, speedResult: SPEED, origin: mars, routes: graph.searchRoutes(LINKS, [mars], searchOptions), openRoutes: graph.searchRoutes(LINKS, [mars], searchOptions), avoidDetails: {}, systems: [{ SystemID: 1, Name: 'One' }, { SystemID: 2, Name: 'Two' }], ...extra } })
  const vm = make(UNSURE)
  const [first, second] = vm.plan.legs

  assert.ok(second.route && first.route, 'a route joins every pair of stops')
  assert.ok(second.positions.records.some((record) => record.identity.key === 'fleet:7' && record.conditions.includes('fleet-orders')), 'the plan reads the fleet\'s orders from the facts')
  assert.ok(!second.positions.records.some((record) => record.identity.key === 'contact:9'), 'a leg states its own endpoints')
  assert.ok(vm.plan.positions.records.some((record) => record.identity.key === 'contact:9'), 'and the plan all of them')
  statesPositions(vm.planFigures.km, vm.plan.positions, 'the plan\'s distance')
  assert.equal(vm.planFigures.jumps.status, 'confirmed', 'the jumps do not rest on a position')

  const rows = vm.stopRows

  statesPositions(rows[1].leg.result, second.positions, 'the time of the leg the second stop leaves')
  statesPositions(rows[0].leg.result, first.positions, 'the time of the first leg')
  assert.ok(!rows[1].leg.result.inputs.missing.includes(rp.CONDITIONS['contact-motion']), 'a leg states only its own unknowns: the contact is not an endpoint of the second leg')
  assert.ok(rows[0].leg.result.inputs.missing.includes(rp.CONDITIONS['contact-motion']), 'and the first leg, which ends at the contact, does')
  statesPositions(vm.legTimeResult(1), second.positions, 'the time of a leg in the detail')

  const detail = vm.detailRows
  const last = detail[detail.length - 1]

  assert.ok(detail.length > 0)
  detail.filter((row) => row.leg === 1 && row.km !== null).forEach((row) => {
    statesPositions(row.kmResult, second.positions, 'the distance flown in a system')
    statesPositions(row.totalResult, vm.plan.positions, 'the running distance, over the legs flown so far')
    statesPositions(row.timeResult, vm.plan.positions, 'the running time')
  })
  assert.equal(last.leg, 1)
  detail.filter((row) => row.leg === 0 && row.km !== null).forEach((row) => assert.ok(row.totalResult.inputs.missing.length < last.totalResult.inputs.missing.length, 'the first leg\'s total does not yet rest on the later legs\' unknowns'))

  const [row] = vm.distanceRows.filter((one) => one.SystemID === 2)

  assert.ok(row.route, 'a system is reached')
  assert.equal(row.kmResult.status, 'estimated', 'a distance from a colony rests on the colony\'s position')
  assert.equal(row.timeResult.status, 'estimated')
  assert.ok(row.kmResult.inputs.missing.length > 0)
  assert.equal(row.jumpsResult.status, 'confirmed')

  const waiting = make(undefined)

  assert.equal(waiting.plan.positions.ageKnown, false, 'while the read is not in the age is unknown')
  assert.deepEqual(waiting.failedInputs, [])
  assert.ok(waiting.plan.positions.conditions.some((one) => one.code === 'clock-unread'))

  assert.equal(vm.travelResult(KM).inputs.missing.length, 0, 'a distance stated with no positions is as it was')

  const single = make(UNSURE, { plannedStops: [mars], stopKeys: [mars.key] })
  const nodes = elementsOf(templateOf(w.text.routesPage, 'routes.vue'))
  const [strip] = nodes.filter((node) => node.tag === 'route-positions')
  const shown = evaluated(attrOf(strip, 'positions'), scopeOf(single))

  assert.equal(single.plan.legs.length, 0, 'one stop has no leg')
  assert.ok(shown.records.some((record) => record.identity.key === 'colony:7'), 'the strip still states the first stop\'s position')
  assert.equal(shown.caveat, true)
  assert.equal(shown.ageKnown, true)
  assert.equal(shown.oldest, GAME_TIME - BODY_TIME, 'and its age')
  assert.ok(evaluated(attrOf(strip, 'positions'), scopeOf(vm)).records.some((record) => record.identity.key === 'contact:9'), 'with legs, the strip states every leg\'s positions as well')

  const [kmSlot] = slotsOf(nodes, 'item.kmSort')
  const kmMarks = marksIn(kmSlot).filter((mark) => resultOf(mark) === 'item.kmResult')

  assert.equal(kmMarks.length, 1, 'the distance column marks every distance with its result')
  assert.equal(evaluated(kmMarks[0].if, scopeOf({ item: { route: { km: 1 }, kmResult: row.kmResult } })), true, 'a distance resting on a position is marked')
  assert.equal(evaluated(kmMarks[0].if, scopeOf({ item: { route: null, kmResult: { status: 'confirmed' } } })), true, 'a row with no route is marked as well')
})

const HAULER = (extra = {}) => ({ ShipID: 1, ShipName: 'Hauler', FleetID: 5, FleetName: 'Convoy', ClassName: 'Freighter', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: 1000, EnginePower: 20, UndamagedEnginePower: 20, OverhaulFactor: 1, FuelEfficiency: 0.5, FuelCapacity: 1e9, Fuel: 1e9, MaintenanceState: 0, MothershipID: 0, TractorTargetShipID: 0, TractorParentShipID: 0, TractorTargetShipyardID: 0, TowedSize: null, TowedTargetShipID: null, CarrierMothershipID: null, CarrierFleetID: null, ShuttleTechnology: 1.5, MilitaryEngines: 0, Drive: 0, AnyDrive: 0, FleetSpeed: 1000, UseMaximumSpeed: 1, ...extra })

const COLONY = (extra = {}) => ({ PopName: 'Mars', PopulationID: 7, SystemID: 1, Xcor: 10, Ycor: 5, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra })

const FULL_OFFICERS = { mode: 'loaded', withheld: null, gaps: { commander: null, admin: null, governor: null, sector: null }, commanders: {}, governors: {}, sectors: {}, admins: {} }

check('pages-transport', 'Transport states a run\'s time and distance with the same positions, the Lagrange points of its route included, for a class and for a fleet, and adds nothing to a route of fixed places', async (w) => {
  const page = await w.transport()
  const modules = await w.modules()
  const rp = modules['route-position']
  const transport = modules.transport
  const place = (kind, id, extra = {}) => ({ kind, key: `${kind}:${id}`, name: `${kind} ${id}`, colony: COLONY(), SystemID: 1, Xcor: 10, Ycor: 5, ...extra })
  const here = place('colony', 7)
  const there = place('fleet', 7, { SystemID: 2, Xcor: 5, Ycor: 5 })
  const route = modules['jump-graph'].searchRoutes(LINKS, [{ SystemID: 1, Xcor: 10, Ycor: 5 }], { order: 'jumps', lagrangePoints: LAGRANGE }).toPlace(there)
  const reach = { route, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
  const make = (facts, data = {}) => instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(facts ? null : undefined), positionFacts: facts, handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: here, destination: there, reachOf: () => reach, fleetShips: [HAULER({ FleetSpeed: 300, UseMaximumSpeed: 0 })], ...data } })
  const group = { FleetID: 5, FleetName: 'Convoy', civilian: false }
  const shipClass = { ShipClassID: 1, ClassName: 'Freighter', ships: [HAULER()] }
  const ends = { origin: transport.colonyEndpoint(COLONY()), destination: transport.colonyEndpoint(COLONY({ PopulationID: 8, ShuttleCapacity: 0 })) }
  const vm = make(UNSURE)
  const expected = rp.routePositions([rp.placeEndpoint(here), rp.placeEndpoint(there), ...rp.viaEndpoints(route)], { facts: UNSURE })
  const stated = vm.positionsOf(reach)

  assert.ok(rp.viaEndpoints(route).length === 2, 'the route jumps between two Lagrange points')
  assert.deepEqual(asJson(stated), asJson(expected), 'a run states its endpoints and the Lagrange points of its route through the gate')
  assert.ok(stated.records.some((record) => record.identity.key === 'lagrange:31'))
  assert.ok(stated.records.some((record) => record.identity.key === 'fleet:7'), 'the destination is stated')
  assert.ok(stated.caveat)

  const [run] = vm.fleetRuns

  statesPositions(run.provenance, stated, 'the fleet\'s time')
  statesPositions(run.pathResult, stated, 'the fleet\'s distance')
  assert.equal(run.pathResult.value, route.km)

  const classRun = vm.runOf(group, shipClass, reach, ends)
  const waiting = make(undefined)
  const waitingClass = waiting.runOf(group, shipClass, reach, ends)
  const waitingRun = waiting.fleetRuns[0]
  const pageNodes = elementsOf(templateOf(w.text.transportPage, 'information.vue'))
  const FIGURES = { trips: ['trips/yr', (row) => row.trips], tonsYear: ['t/yr', (row) => row.tonsYear], colonistsYear: ['colonists/yr', (row) => row.colonistsYear], fuel: ['L', (row) => row.fuel], fuelShare: ['%', (row) => row.fuelShare * 100] }
  const TABLES = [
    ['fleetRuns', run, waitingRun, { trips: 'transport.fleetTrip', tonsYear: 'transport.fleetTrip', colonistsYear: 'transport.fleetTrip', fuel: 'transport.fleetBurn', fuelShare: 'transport.fleetBurn' }],
    ['rows', classRun, waitingClass, { trips: 'transport.freightPerYear', tonsYear: 'transport.freightPerYear', colonistsYear: 'transport.freightPerYear', fuel: 'transport.fuelPerTrip', fuelShare: 'transport.fuelPerTrip' }],
  ]

  TABLES.forEach(([table, known, unread, rules]) => {
    const marks = ['item.trips', 'item.tonsYear', 'item.colonistsYear', 'item.fuel'].flatMap((name) => slotsOf(pageNodes, name).filter((one) => attrOf(one.parent, 'items') === table).flatMap(marksIn))
    const fields = marks.map((mark) => (/^item\.results\.(\w+)$/.exec(resultOf(mark) || '') || [])[1])

    assert.ok(known.results && unread.results, `${table}: a run that works has a result for each yearly and fuel figure`)
    marks.forEach((mark) => assert.equal(attrOf(mark, 'rule'), undefined, `${table}: a mark is a result of the row, not the rule alone`))
    assert.deepEqual([...fields].sort(), Object.keys(FIGURES).sort(), `${table}: each yearly and fuel figure has one mark of the row's result`)
    marks.forEach((mark, index) => {
      const [units, shown] = FIGURES[fields[index]]

      ;[[known, true], [unread, false]].forEach(([row, loaded]) => {
        const result = evaluated(resultOf(mark), scopeOf({ item: row }))

        assert.equal(result.rule.id, rules[fields[index]], `${table}, ${fields[index]}: the rule of the figure`)
        assert.equal(result.units, units, `${table}, ${fields[index]}: its own units, not the trip's`)
        assert.equal(result.value, shown(row), `${table}, ${fields[index]}: the figure displayed beside the mark`)

        if (loaded) {
          statesPositions(result, stated, `${table}, ${fields[index]}: the positions the row's time rests on`)
        } else {
          assert.ok(result.inputs.missing.includes(rp.CONDITIONS['clock-unread']), `${table}, ${fields[index]}: the unread clock while the read is not in`)
        }
      })
    })
  })

  statesPositions(classRun.provenance, stated, 'the class\'s time')
  statesPositions(vm.safeFields(reach).pathResult, stated, 'a class\'s distance, with no avoid setting on')

  assert.equal(waiting.positionsOf(reach).ageKnown, false, 'the age is unknown while the read is not in')
  assert.ok(waiting.runOf(group, shipClass, reach, ends).provenance.inputs.missing.length > 0)
  assert.deepEqual(waiting.failedInputs, [])

  const fixedPlace = (id) => ({ kind: 'system', key: `system:${id}`, name: `system ${id}`, SystemID: id, Xcor: 0, Ycor: 0, colony: COLONY() })
  const flat = make(UNSURE, { origin: fixedPlace(1), destination: fixedPlace(2), reachOf: () => ({ ...reach, route: { km: KM, jumps: 2 } }) })

  assert.equal(flat.endpointPositions.caveat, false)
  assert.equal(flat.safeFields({ ...reach, route: { km: KM, jumps: 2 } }).pathResult, null, 'systems are fixed: nothing to add to the distance')
  const plain = flat.runOf(group, shipClass, { ...reach, route: { km: KM, jumps: 2 } }, ends).provenance

  stated.missing.forEach((missing) => assert.ok(!plain.inputs.missing.includes(missing), 'and the time names none of the positions\' unknowns'))
  assert.deepEqual(plain.assumptions.filter((one) => stated.assumptions.includes(one)), [], 'and takes none of their assumptions')
  assert.deepEqual(asJson(vm.endpointPositions), asJson(rp.routePositions([rp.placeEndpoint(here), rp.placeEndpoint(there)], { facts: UNSURE })), 'the strip states the origin and the destination')
  assert.equal(make(UNSURE, { destination: null }).endpointPositions, null, 'no strip without a destination')

  const working = { ...classRun, status: 'ok', ships: 1, trips: 730, km: route.km, jumps: route.jumps, cargo: 10, colonists: 1, tonsYear: 7300, colonistsYear: 730 }
  const second = { ...working, trips: 5, tonsYear: 100, colonistsYear: 10 }
  const tiled = make(UNSURE, { rows: [working, second], civilianRuns: [working], CivilianShippingLinesActive: true })
  const annual = tiled.tiles.filter((tile) => tile.result)
  const tileOf = (rule, units) => annual.find((tile) => tile.result.rule.id === rule && tile.result.units === units)
  const expectedTiles = [[tileOf('transport.freightPerYear', 't/yr'), 7400, 0, ' t'], [tileOf('transport.freightPerYear', 'colonists/yr'), 740, 0, ''], [tileOf('transport.freightPerYear', 'trips/yr'), 735, 1, ''], [tileOf('transport.civilianFreight', 't/yr'), 7300, 0, ' t']]

  assert.equal(annual.length, 4, 'every annual tile carries a result')
  expectedTiles.forEach(([tile, value, digits, suffix]) => {
    assert.ok(tile, 'the tile has a result in its own rule and units')
    assert.equal(tile.result.value, value, 'the result holds the quantity the tile displays')
    assert.equal(tile.value, `${tiled.count(value, digits)}${suffix}`, 'and that quantity is the one displayed')
    statesPositions(tile.result, stated, 'an annual tile')
  })
  assert.ok(annual.every((tile) => tile.result.rule.id !== 'transport.roundTrip'), 'no annual tile states a round trip')
  assert.equal(make(UNSURE, { rows: [], civilianRuns: [], CivilianShippingLinesActive: true }).tiles.filter((tile) => tile.result).length, 0, 'and none with no run to state')
})

check('pages-hauling', 'Hauling states a repeating route and a planned haul with the positions of their endpoints, and the strips the union of every route and every haul', async (w) => {
  const page = await w.hauling()
  const rp = (await w.modules())['route-position']
  const order = (fleet, id, extra = {}) => ({ FleetID: fleet, OrderDelay: 0, ActionName: 'Load', Jumps: 0, X: 10, Y: 5, ExitX: 10, ExitY: 5, ExitSystemID: 1, SystemID: 1, DestinationType: 2, DestinationID: 3, MoveActionID: 62, Description: 'Mars: Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra, MoveOrder: id })
  const orders = [order(5, 1), order(5, 2, { ActionName: 'Unload', MoveActionID: 63, Description: 'Venus: Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: 3 * KM, ExitX: 3 * KM }), order(5, 3, { DestinationType: 6, DestinationID: 9, PopulationID: 0, PopName: null, Description: 'Seen again', ActionName: 'Move', MoveActionID: 2, X: 3 * KM + 10, ExitX: 3 * KM + 10 }), order(6, 1, { DestinationType: 6, DestinationID: 10, PopulationID: 0, PopName: null, Description: 'Seen', ActionName: 'Move' })]
  const fleet = (id) => ({ FleetID: id, FleetName: `Cycle ${id}`, Ships: 1, CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: 1.5, Speed: 300, FuelPerHour: 99 })
  const haul = (from, to) => ({ from: COLONY({ PopulationID: from, PopName: `Colony ${from}` }), to: COLONY({ PopulationID: to, PopName: `Colony ${to}`, Xcor: 3 * KM }), km: 3 * KM, jumps: 1, tonnes: 1100, queue: 100, minerals: [], detour: null })
  const hauls = [haul(7, 8), haul(7, 9)]
  const make = (facts, extra = {}) => instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(facts ? null : undefined), positionFacts: facts, handlingSupport: FULL_OFFICERS, fleets: [fleet(5), fleet(6)], orders, fleetShips: [HAULER({ FleetSpeed: 300, UseMaximumSpeed: 0 })], formulaVersion: '2.7.1', plan: { hauls, unmet: [] }, freighters: [HAULER({ Ships: 2 })], shuttleTechnology: 1.5, mineralDeliveries: {}, ...extra } })
  const vm = make(UNSURE)
  const [row, other] = vm.routeRows
  const forFleet = (id) => orders.filter((one) => one.FleetID === id).flatMap((one) => [rp.orderEndpoint({ ...one, label: one.PopName || one.Description }), rp.orderExitEndpoint({ ...one, label: one.PopName || one.Description })])
  const expected = rp.routePositions(forFleet(5), { facts: UNSURE })

  assert.deepEqual(asJson(row.positions), asJson(expected), 'a repeating route states its orders\' destinations through the gate')
  assert.deepEqual(asJson(other.positions), asJson(rp.routePositions(forFleet(6), { facts: UNSURE })))
  assert.ok(row.year, 'the route has a year')
  Object.values(row.results).forEach((result) => statesPositions(result, expected, 'a figure of the route'))
  statesPositions(row.distanceResult, expected, 'the route\'s distance')
  assert.equal(row.distanceResult.value, row.route.km)
  assert.ok(vm.fleetPositions.conditions.some((one) => one.code === 'contact-motion'), 'the strip states the unknowns of every route')
  assert.equal(vm.fleetPositions.records.length, new Set([...row.positions.records, ...other.positions.records].map((record) => record.identity.key)).size)

  const ends = (from, to) => rp.routePositions([rp.colonyPlaceEndpoint(from), rp.colonyPlaceEndpoint(to)], { facts: UNSURE })
  const [planned] = vm.planRows

  assert.ok(planned.estimates.length > 0)
  planned.estimates.forEach((estimate) => statesPositions(estimate.result, ends(hauls[0].from, hauls[0].to), 'a haul\'s time per class'))
  planned.estimates.filter((estimate) => estimate.timed).forEach((estimate) => {
    const ends01 = ends(hauls[0].from, hauls[0].to)

    assert.equal(estimate.oneShipResult.value, estimate.oneShipDays, 'the days for one ship are the figure displayed')
    assert.equal(estimate.classResult.value, estimate.classDays, 'and the days of the class')
    ;[estimate.oneShipResult, estimate.classResult].forEach((result) => {
      assert.equal(result.rule.id, 'hauling.haulDays', 'a haul\'s days are worked out by their own rule')
      assert.equal(result.units, 'days')
      statesPositions(result, ends01, 'a haul\'s days to complete')
    })
  })
  assert.ok(planned.best.holds > 1, 'the best class needs more than one hold')
  assert.notEqual(planned.best.oneShipDays, planned.best.tripDays, 'so the days for one ship are not the days of one trip')
  assert.notEqual(planned.best.classDays, planned.best.oneShipDays, 'and the days of the class are not those of one ship')
  assert.equal(planned.best.oneShipResult.value, planned.best.oneShipDays)
  statesPositions(planned.pathResult, ends(hauls[0].from, hauls[0].to), 'a haul\'s distance')
  assert.equal(planned.pathResult.value, hauls[0].km)
  assert.deepEqual(vm.planPositions.records.map((record) => record.identity.key).sort(), ['colony:7', 'colony:8', 'colony:9'], 'the strip states every colony of every haul once')

  const waiting = make(undefined)

  assert.equal(waiting.routeRows[0].positions.ageKnown, false)
  assert.equal(waiting.planPositions.ageKnown, false)
  assert.deepEqual(make(UNSURE, { plan: { hauls: [], unmet: [] } }).planPositions.records, [], 'no strip without a haul')

  assert.equal(row.legResults.length, row.route.legs.length, 'every leg has a result of its own')
  assert.ok(!row.legResults[0].inputs.missing.includes(rp.CONDITIONS['contact-motion']), 'a leg between colonies states none of the contact\'s unknowns')
  assert.ok(row.legResults[1].inputs.missing.includes(rp.CONDITIONS['contact-motion']), 'a leg to the contact does')
  assert.ok(row.legResults[row.legResults.length - 1].inputs.missing.includes(rp.CONDITIONS['contact-motion']), 'and the one back from it')
  statesPositions(planned.best.result, ends(hauls[0].from, hauls[0].to), 'the best class\'s days')
  assert.equal(planned.jumpsResult.rule.id, 'route.jumps', 'the jump count carries its own mark')
  assert.equal(planned.jumpsResult.status, 'confirmed', 'and it does not rest on a position')

  const kinds = [['minerals', 5], ['installations', 3], ['colonists', 100]]
  const delivered = make(UNSURE, { routeRows: [{ year: { trips: 2 }, cargo: { deliveries: kinds.map(([kind, amount]) => ({ PopulationID: 8, kind, name: 'Venus', amount })) }, FleetName: 'Cycle 5', positions: row.positions }] }).deliveryRows

  assert.equal(delivered.length, kinds.length)
  kinds.forEach(([kind, amount]) => {
    const total = delivered.find((one) => one.kind === kind)

    statesPositions(total.result, row.positions, `a delivery total of ${kind}`)
    assert.equal(total.result.value, total.amount, `a delivery total of ${kind} is the figure displayed`)
    assert.equal(total.amount, 2 * amount)
    assert.equal(total.result.units, kind === 'colonists' ? 'colonists/yr' : 't/yr', `a delivery total of ${kind} is in what it counts`)
  })

  // A leg after a transit starts at the order's exit, and the exit joins the route's summary.
  const transit = [order(8, 1), order(8, 2, { DestinationType: 12, DestinationID: 31, PopulationID: 0, PopName: null, Description: 'Jump', ActionName: 'Jump', MoveActionID: 124, Jumps: 1, X: 100, Y: 0, ExitX: 900, ExitY: 0, ExitDestinationID: 32 }), order(8, 3, { DestinationType: 5, DestinationID: 31, PopulationID: 0, PopName: null, Description: 'Held', ActionName: 'Move', MoveActionID: 2, X: 1000, Y: 0, ExitX: 1000, ExitY: 0 })]
  const [crossing] = make(FACTS, { orders: transit, fleets: [fleet(8)] }).routeRows
  const legKeys = crossing.legPositions.map((positions) => positions.records.map((record) => record.identity.key))

  assert.equal(crossing.legPositions.length, crossing.route.legs.length, 'every leg states its own positions')
  assert.deepEqual(legKeys[0], ['colony:7', 'lagrange:31'], 'a leg into the transit ends where the transit starts')
  assert.deepEqual(legKeys[1], ['lagrange:32', 'waypoint:31'], 'the leg after it starts at the far side, not at the point the order went to')
  assert.deepEqual({ ...crossing.legPositions[1].records[0].position }, { SystemID: 1, Xcor: 900, Ycor: 0 }, 'at the exit\'s position')
  assert.deepEqual(crossing.positions.records.map((record) => record.identity.key).sort(), ['colony:7', 'lagrange:31', 'lagrange:32', 'waypoint:31'], 'the exit Lagrange point is in the route\'s summary')
  assert.equal(crossing.legResults[1].status, 'estimated', 'the leg from the exit rests on the Lagrange point\'s clock')
  assert.ok(crossing.legResults[1].inputs.missing.length > 0 || crossing.legResults[1].assumptions.length > 0)

  // The read of the orders names where each order comes out and its survey location.
  const sent = []
  const reader = instantiate(page, { $store: STORE, database: { query: async (sql) => { sent.push(sql); return [[]] } }, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

  await reader.runAsync('orders')

  const asked = sent.find((sql) => /FCT_MoveOrders/.test(sql))

  assert.ok(asked, 'the page reads the orders')
  assert.ok(/\bas ExitDestinationID\b/.test(asked), 'the read gives the identity of the point an order comes out at')
  assert.ok(/\bSurveyLocationID\b/.test(asked), 'and of a survey location')

  const nodes = elementsOf(templateOf(w.text.haulingPage, 'hauling.vue'))
  const slot = (name) => slotsOf(nodes, name).flatMap((one) => marksIn(one).map((mark) => ({ mark, slot: one })))
  const [distanceMark] = slot('item.km').filter(({ mark }) => resultOf(mark) === 'item.pathResult')
  const [jumpsMark] = slot('item.km').filter(({ mark }) => resultOf(mark) === 'item.jumpsResult')

  assert.ok(distanceMark && jumpsMark, 'the distance and the jump count each have a mark')
  assert.ok(!(distanceMark.mark.parent.children || []).some((one) => (one.text || '').includes('item.jumps')), 'the distance mark does not sit with the jump count')
  assert.ok((jumpsMark.mark.parent.children || []).some((one) => (one.text || '').includes('item.jumps')), 'the jump count\'s mark sits with it')
  assert.equal(slot('item.bestSort').filter(({ mark }) => resultOf(mark) === 'item.best.oneShipResult').length, 1, 'the best class\'s days are marked')

  const expanded = slot('expanded-item').map(({ mark }) => resultOf(mark))

  assert.ok(expanded.length >= 3, 'a haul\'s three times per class are marked')
  assert.equal(expanded.filter((one) => one === 'item.legResults[index]').length, 1, 'a leg of a route is marked')
  assert.equal(slot('item.amount').filter(({ mark }) => resultOf(mark) === 'item.result').length, 1, 'a delivery total is marked')

  const waitingPlan = make(undefined).planRows[0]
  const bestMarks = slot('item.bestSort').map(({ mark }) => resultOf(mark))
  const cellsOf = [[bestMarks, { item: waitingPlan }, [waitingPlan.best.oneShipDays]], [expanded.filter((one) => typeof one === 'string' && one.startsWith('estimate.')), { estimate: waitingPlan.estimates.find((one) => one.timed) }, null]]

  assert.deepEqual(bestMarks, ['item.best.oneShipResult'], 'the best class\'s days are marked with the days for one ship')
  assert.equal(expanded.filter((one) => one === 'estimate.oneShipResult').length, 1, 'the days for one ship are marked with their own result')
  assert.equal(expanded.filter((one) => one === 'estimate.classResult').length, 1, 'and the days of a class')
  assert.equal(expanded.filter((one) => one === 'estimate.result').length, 1, 'and the one trip with its own')
  cellsOf.forEach(([expressions, scope, shown]) => expressions.forEach((expression) => {
    const result = evaluated(expression, scopeOf(scope))

    assert.ok(result.inputs.missing.includes(rp.CONDITIONS['clock-unread']), 'a figure of a haul names the unread clock while the read is not in')
    assert.ok(shown === null || shown.includes(result.value), 'and holds the figure displayed')
  }))
})

// ---- Faults ----------------------------------------------------------------------------------------------------------
// Each plants one change in one source, and the checks named must fail on it. [label, target, text, replacement, the checks that must fail]
const AGE = 'let age = gameClock && isTime(state.observedAt) ? gameClock.gameTime - state.observedAt : null'

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  ['an age is not worked out', 'position', AGE, 'let age = gameClock && isTime(state.observedAt) ? 0 : null', ['static-baseline', 'legs-own-age']],
  ['an age that is not read is 0', 'position', AGE, 'let age = gameClock && isTime(state.observedAt) ? gameClock.gameTime - state.observedAt : 0', ['clock-unread']],
  ['a position dated after the game time still has an age', 'position', 'if (age !== null && age < 0) {', 'if (false) {', ['clock-unread']],
  ['queued orders are not said', 'position', 'if (found.orders > 0) {', 'if (false) {', ['legs-own-age']],
  ['a fleet with orders is taken as idle', 'position', 'moves: mayMove ? null : isTime(found.lastMoveTime) ? false : null', 'moves: false', ['legs-own-age']],
  ['a contact is not dated by its last update', 'position', 'observedAt: isTime(endpoint.lastUpdate) ? endpoint.lastUpdate : null, moves: null, assumption: \'contact-held\'', 'observedAt: null, moves: null, assumption: \'contact-held\'', ['legs-own-age']],
  ['a contact seen earlier is supported', 'position', ' && !conditions.includes(\'stale-contact\')', '', ['legs-own-age']],
  ['a fleet at its body\'s position takes the fleet clock', 'position', 'return { clock: \'body\', observedAt: bodyClockOf(facts) ? facts.clock.lastGrowthTime : null, moves: mayMove', 'return { clock: \'fleet\', observedAt: bodyClockOf(facts) ? facts.clock.lastGrowthTime : null, moves: mayMove', ['legs-own-age']],
  ['an unrecorded motion switch is taken as moving', 'position', 'if (moves === null && clock) {', 'if (false) {', ['motion-switch']],
  ['a switch that is off is taken as moving', 'position', 'const planets = switchOf(clock && clock.orbitalMotion)', 'const planets = switchOf(clock && clock.orbitalMotion) === false ? true : switchOf(clock && clock.orbitalMotion)', ['motion-switch']],
  ['a life pod is supported', 'position', 'spec.supported !== false', 'true', ['motion-switch']],
  ['the gate ignores the adapters', 'position', 'typeof adapters[family] === \'function\' ? POSITION_BASIS.PROPAGATED : POSITION_BASIS.STATIC', 'POSITION_BASIS.STATIC', ['gate-adapter']],
  ['a failing adapter is not said', 'position', 'const kept = [...new Set([...base.conditions, \'propagation-unavailable\'])]', 'const kept = base.conditions', ['gate-adapter']],
  ['a failing adapter leaves the record propagated', 'position', 'return Object.freeze({ ...base, conditions: kept, unknown: true })', 'return Object.freeze({ ...base, basis: POSITION_BASIS.PROPAGATED, conditions: kept, unknown: true })', ['gate-adapter']],
  ['an adapter lifts what is not supported', 'position', 'supported: supported && found.supported !== false', 'supported: found.supported !== false', ['gate-adapter']],
  ['the mode is always static', 'position', 'return propagated === 0 ? ROUTE_MODE.STATIC : propagated === subjects.length ? ROUTE_MODE.PROPAGATED : ROUTE_MODE.MIXED', 'return ROUTE_MODE.STATIC', ['gate-adapter']],
  ['a place that never moves takes part in the mode whatever an adapter did for it', 'position', 'const subjects = records.filter((record) => record.moves !== false)', 'const subjects = records.filter((record) => record.moves !== false || record.basis === POSITION_BASIS.PROPAGATED)', ['gate-adapter']],
  ['a switch that is off leaves an asteroid undecided', 'position', 'const moves = planets === false ? false : endpoint.group', 'const moves = endpoint.group', ['motion-switch']],
  ['an adapter that throws takes the route down', 'position', '} catch (error) {\n      found = null\n    }', '} catch (error) {\n      throw error\n    }', ['gate-adapter']],
  ['a position ahead of the game reads as its size', 'position', 'return seconds < 0 ? `${durationText(-seconds)} ahead` : durationText(seconds)', 'return durationText(Math.abs(seconds))', ['gate-adapter']],
  ['a position ahead of the game reads as current', 'position', '} else if (seconds === 0) {', '} else if (seconds <= 0) {', ['gate-adapter']],
  ['a fleet orbiting a body with no position follows it by default', 'position', 'when FCT_Fleet.OrbitBodyID > 0 and exists (select 1 from FCT_SystemBody where FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and (FCT_SystemBody.Xcor is null or FCT_SystemBody.Ycor is null)) then null ', '', ['loader-schema']],
  ['the summary lists the conditions of the first endpoint only', 'position', 'const codes = [...new Set(records.flatMap((record) => record.conditions))].sort()', 'const codes = [...new Set(records.slice(0, 1).flatMap((record) => record.conditions))].sort()', ['same-gate', 'legs-own-age']],
  ['a place is listed once for each stop', 'position', 'if (seen.has(key)) {', 'if (false) {', ['same-gate']],
  ['an order that names a colony is its body', 'position', 'const colony = order.PopulationID > 0', 'const colony = false', ['same-gate']],
  ['a Lagrange point is not keyed', 'position', 'key: point.LagrangePointID ? place.lagrange(point.LagrangePointID) : `lagrange:${point.SystemID}:${point.Xcor}:${point.Ycor}`', 'key: `lagrange:${point.SystemID}`', ['same-gate']],
  ['a caveat is stated with nothing to caveat', 'position', 'if (!result || !positions || !positions.caveat) {', 'if (!result || !positions) {', ['result-caveat']],
  ['an unavailable result is raised to an estimate', 'position', 'if (result.status === \'unavailable\') {', 'if (false) {', ['result-caveat']],
  ['a result keeps its status', 'position', 'status: weakestStatus([result.status, \'estimated\'])', 'status: result.status', ['result-caveat', 'same-gate']],
  ['what is missing is not named', 'position', 'inputs: { present: result.inputs.present, missing: [...result.inputs.missing, ...positions.missing] }', 'inputs: { present: result.inputs.present, missing: result.inputs.missing }', ['result-caveat', 'same-gate']],
  ['a fleet is found by the wrong key', 'position', 'facts.fleets ? facts.fleets[endpoint.id] : null', 'facts.fleets ? facts.fleets[endpoint.key] : null', ['legs-own-age']],
  ['a fleet beside its body follows it', 'position', ' and FCT_SystemBody.Ycor = FCT_Fleet.Ycor', '', ['loader-schema']],
  ['a missing last move reads as 0', 'position', 'fleet.has(\'LastMoveTime\') ? \'FCT_Fleet.LastMoveTime\' : \'null\'', 'fleet.has(\'LastMoveTime\') ? \'FCT_Fleet.LastMoveTime\' : \'0\'', ['loader-schema']],
  ['a missing orders table reads as no orders', 'position', 'FCT_MoveOrders.GameID = FCT_Fleet.GameID)\' : \'null\'', 'FCT_MoveOrders.GameID = FCT_Fleet.GameID)\' : \'0\'', ['loader-schema']],
  ['a missing motion switch reads as off', 'position', 'game.has(name) ? `FCT_Game.${name}` : \'null\'', 'game.has(name) ? `FCT_Game.${name}` : \'0\'', ['loader-schema']],
  ['the fleets of every race are read', 'position', ' and FCT_Fleet.RaceID = :RaceID', '', ['loader-schema']],
  ['the orders of every game are counted', 'position', ' and FCT_MoveOrders.GameID = FCT_Fleet.GameID)', ')', ['loader-schema']],
  ['the plan ignores the positions in its distance', 'plan', 'km: withPositions(made(\'route.distanceKm\', plan.km), plan.positions)', 'km: made(\'route.distanceKm\', plan.km)', ['same-gate', 'result-caveat', 'pages-routes']],
  ['the plan caveats its jumps', 'plan', 'jumps: made(\'route.jumps\', plan.jumps)', 'jumps: withPositions(made(\'route.jumps\', plan.jumps), plan.positions)', ['result-caveat', 'pages-routes']],
  ['a leg leaves out the Lagrange points it jumps between', 'plan', ', ...viaEndpoints(route)], { facts, adapters: {} })', '], { facts, adapters: {} })', ['same-gate']],
  ['a leg is not given the facts', 'plan', ', ...viaEndpoints(route)], { facts, adapters: {} })', ', ...viaEndpoints(route)], { adapters: {} })', ['same-gate', 'pages-routes']],
  ['a leg is given the adapters the plan was handed', 'plan', '{ facts, adapters: {} })', '{ facts, adapters: options.adapters })', ['same-gate']],
  ['the plan states only its first leg', 'plan', 'summarisePositions(legs.flatMap((leg) => (leg.positions ? leg.positions.records : [])))', 'summarisePositions(legs.slice(0, 1).flatMap((leg) => (leg.positions ? leg.positions.records : [])))', ['same-gate']],
  ['a running distance leaves out the positions', 'plan', 'value: total, inputs: { present: ROUTE_INPUTS } }), positions)', 'value: total, inputs: { present: ROUTE_INPUTS } }))', ['same-gate', 'result-caveat']],
  ['a distance leaves out the positions', 'plan', ': unavailable({ rule: \'route.distanceKm\', missing: [missing] }), positions)', ': unavailable({ rule: \'route.distanceKm\', missing: [missing] }))', ['same-gate', 'result-caveat']],
  ['the read is tracked under another key', 'mixin', 'get: tracked(\'positionFacts\',', 'get: tracked(\'positionRead\',', ['optional-read']],
  ['the read is made for no race', 'mixin', 'return loadPositionFacts(database, { GameID, RaceID })', 'return loadPositionFacts(database, { GameID, RaceID: 2 })', ['optional-read']],
  ['the read holds back the state of a read that has failed', 'mixin', 'failed: typeof state === \'string\' ? joinLabels([POSITION_LABELS.positionFacts]) : \'\'', 'failed: \'\'', ['optional-read']],
  ['the facts are used while the read is not in', 'mixin', 'return this.loadErrors.positionFacts === null ? this.positionFacts : null', 'return this.positionFacts', ['optional-read']],
  ['Route Finder does not label the read', 'routesPage', '  ...POSITION_LABELS,\n', '', ['optional-read']],
  ['Route Finder waits for the read', 'routesPage', '...POSITION_INPUTS', '', ['optional-read']],
  ['Transport does not label the read', 'transportPage', '  ...POSITION_LABELS,\n', '', ['optional-read']],
  ['Transport waits for the read', 'transportPage', '...POSITION_INPUTS', '', ['optional-read']],
  ['Hauling does not label the read', 'haulingPage', '  ...POSITION_LABELS,\n', '', ['optional-read']],
  ['Hauling waits for the read', 'haulingPage', '...POSITION_INPUTS', '', ['optional-read']],
  ['Route Finder plans without the facts', 'routesPage', 'facts: this.positionRead, ', '', ['pages-routes']],
  ['Route Finder states a stop row\'s leg time without its positions', 'routesPage', 'result: leg.route ? this.travelResult(leg.route.km, leg.positions) :', 'result: leg.route ? this.travelResult(leg.route.km) :', ['pages-routes']],
  ['Route Finder states a leg\'s detail time without its positions', 'routesPage', 'return leg && leg.route ? this.travelResult(leg.route.km, leg.positions) : null', 'return leg && leg.route ? this.travelResult(leg.route.km) : null', ['pages-routes']],
  ['Route Finder states a running distance without the legs flown', 'routesPage', 'totalResult: detailTotal(total, skipped, passed)', 'totalResult: detailTotal(total, skipped)', ['pages-routes']],
  ['Route Finder states a distance flown in a system without its positions', 'routesPage', 'kmResult: distanceResult(step.km, undefined, leg.positions)', 'kmResult: distanceResult(step.km)', ['pages-routes']],
  ['Route Finder counts only the leg flown for the running distance', 'routesPage', 'flown.push(...(leg.positions ? leg.positions.records : []))', 'flown.splice(0, flown.length, ...(leg.positions ? leg.positions.records : []))', ['pages-routes']],
  ['Route Finder states a system\'s distance without its positions', 'routesPage', 'const kmResult = withPositions(figures.km, positions)', 'const kmResult = figures.km', ['pages-routes']],
  ['Route Finder leaves the positions out of a travel result', 'routesPage', 'travelTime(distanceResult(km, undefined, positions), this.speedResult)', 'travelTime(distanceResult(km), this.speedResult)', ['pages-routes']],
  ['Route Finder does not show the strip', 'routesPage', ' @retry="retryPosition"', '', ['strip-bound']],
  ['Transport leaves a class\'s time as it was', 'transportPage', 'provenance: withPositions(tripResult(trip), positions)', 'provenance: tripResult(trip)', ['pages-transport']],
  ['Transport leaves a fleet\'s time as it was', 'transportPage', 'provenance: withPositions(fleetTripResult(trip, profile), positions)', 'provenance: fleetTripResult(trip, profile)', ['pages-transport']],
  ['Transport leaves a fleet\'s distance as it was', 'transportPage', 'pathResult: withPositions(pathResult(reach.route, this.avoid), positions)', 'pathResult: pathResult(reach.route, this.avoid)', ['pages-transport']],
  ['Transport states a class\'s distance only with an avoid setting', 'transportPage', 'if (!this.avoid.active && !positions.caveat) {', 'if (!this.avoid.active) {', ['pages-transport']],
  ['Transport leaves out the Lagrange points of the route', 'transportPage', ', ...viaEndpoints(reach.route)]', ']', ['pages-transport']],
  ['Transport states no destination', 'transportPage', 'routePositions([placeEndpoint(this.origin), placeEndpoint(this.destination), ...viaEndpoints', 'routePositions([placeEndpoint(this.origin), ...viaEndpoints', ['pages-transport']],
  ['Transport does not bind the strip', 'transportPage', ' :state="positionState"', '', ['strip-bound']],
  ['Hauling leaves a haul\'s time as it was', 'haulingPage', 'const result = withPositions(tripResult(estimate), positions)', 'const result = tripResult(estimate)', ['pages-hauling']],
  ['Hauling leaves a haul\'s distance as it was', 'haulingPage', 'withPositions(this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : distanceResult(haul.km), positions)', 'this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : distanceResult(haul.km)', ['pages-hauling']],
  ['Hauling leaves a route\'s figures as they were', 'haulingPage', '[name, withPositions(result, positions)]', '[name, result]', ['pages-hauling']],
  ['Hauling leaves a route\'s distance as it was', 'haulingPage', 'withPositions(distanceResult(route.km), positions)', 'distanceResult(route.km)', ['pages-hauling']],
  ['Hauling states a route without its orders', 'haulingPage', 'routePositions(orders.flatMap((order) => [orderEndpoint(order), orderExitEndpoint(order)]), { facts: this.positionRead })', 'routePositions([], { facts: this.positionRead })', ['pages-hauling']],
  ['Hauling\'s strip states only the first haul', 'haulingPage', 'this.plan.hauls.flatMap(', 'this.plan.hauls.slice(0, 1).flatMap(', ['pages-hauling']],
  ['Hauling\'s strip states only the first route', 'haulingPage', 'this.routeRows.flatMap((row) => row.positions.records)', 'this.routeRows.slice(0, 1).flatMap((row) => row.positions.records)', ['pages-hauling']],
  ['Hauling does not bind the plan strip', 'haulingPage', /<route-positions(?=[^>]*:positions="planPositions")([^>]*?) :state="positionState"([^>]*>)/, (m) => `<route-positions${m[1]}${m[2]}`, ['strip-bound']],
  ['Hauling does not bind the routes strip', 'haulingPage', /<route-positions(?=[^>]*:positions="fleetPositions")([^>]*?) :state="positionState"([^>]*>)/, (m) => `<route-positions${m[1]}${m[2]}`, ['strip-bound']],
  ['the strip shows an age while the read is in flight', 'component', 'return this.state.loading ? null : ageResult(this.positions)', 'return ageResult(this.positions)', ['strip-component']],
  ['the strip has no retry', 'component', '@click="$emit(\'retry\')"', '', ['strip-component']],
  ['the strip does not mark the age', 'component', ':result="age"', '', ['strip-component']],
  ['Route Finder\'s strip leaves out the routes of the distance table', 'routesPage', ', ...this.distanceRows.flatMap((row) => (row.positions ? row.positions.records : []))', '', ['pages-routes']],
  ['Route Finder\'s strip states the plan\'s legs only', 'routesPage', 'return summarisePositions([...this.plan.positions.records, ...this.distanceRows.flatMap((row) => (row.positions ? row.positions.records : []))])', 'return this.plan.positions', ['pages-routes']],
  ['Route Finder does not mark a distance of the table', 'routesPage', '<provenance-mark v-if="!item.route || item.kmResult.status !== \'confirmed\'" :result="item.kmResult" />', '', ['pages-routes']],
  ['Route Finder marks a distance of the table only when there is a route', 'routesPage', 'v-if="!item.route || item.kmResult.status !== \'confirmed\'"', 'v-if="item.kmResult.status !== \'confirmed\'"', ['pages-routes']],
  ['Transport states no figure of a year', 'transportPage', 'results: runs.map((run) => run.provenance)', 'results: []', ['pages-transport']],
  ['Transport states no civilian figure of a year', 'transportPage', 'result: this.CivilianShippingLinesActive ? yearOf(civilian, \'transport.civilianFreight\', civilianTonsYear, \'t/yr\') : null,', 'result: null,', ['pages-transport']],
  ['Transport states civilian freight as the race\'s', 'transportPage', '\'transport.civilianFreight\', civilianTonsYear', '\'transport.freightPerYear\', civilianTonsYear', ['pages-transport']],
  ['Transport leaves the freight tile as it was', 'transportPage', 'yearOf(working, \'transport.freightPerYear\', tonsYear, \'t/yr\')', 'null', ['pages-transport']],
  ['Transport leaves the colonists tile as it was', 'transportPage', 'yearOf(working, \'transport.freightPerYear\', colonistsYear, \'colonists/yr\')', 'null', ['pages-transport']],
  ['Transport leaves the trips tile as it was', 'transportPage', 'yearOf(working, \'transport.freightPerYear\', trips, \'trips/yr\')', 'null', ['pages-transport']],
  ['Transport states the freight tile as a round trip', 'transportPage', '\'transport.freightPerYear\', tonsYear', '\'transport.roundTrip\', tonsYear', ['pages-transport']],
  ['Transport states the colonists tile with the freight', 'transportPage', '\'transport.freightPerYear\', colonistsYear, \'colonists/yr\'', '\'transport.freightPerYear\', tonsYear, \'colonists/yr\'', ['pages-transport']],
  ['Transport states the trips tile as a single trip', 'transportPage', '\'transport.freightPerYear\', trips, \'trips/yr\'', '\'transport.freightPerYear\', 1, \'trips/yr\'', ['pages-transport']],
  ['Transport states a yearly figure in days', 'transportPage', '\'transport.freightPerYear\', tonsYear, \'t/yr\'', '\'transport.freightPerYear\', tonsYear, \'days\'', ['pages-transport']],
  ...[['rows', 'class'], ['fleetRuns', 'fleet']].flatMap(([items, table]) => ['trips', 'tonsYear', 'colonistsYear', 'fuel', 'fuelShare'].map((field) => [`Transport marks a ${table} table's ${field} with the rule alone`, 'transportPage', new RegExp(`(:items="${items}"[^]*?)<provenance-mark :result="item\\.results\\.${field}" />`), (m) => `${m[1]}<provenance-mark rule="transport.fleetTrip" />`, ['pages-transport']])),
  ['Transport states a class\'s figures without the positions', 'transportPage', 'results: [run.provenance], value, units })\n        const results = { trips: figure(\'transport.freightPerYear\'', 'results: [tripResult(trip)], value, units })\n        const results = { trips: figure(\'transport.freightPerYear\'', ['pages-transport']],
  ['Transport states a fleet\'s figures without the positions', 'transportPage', 'results: [run.provenance], value, units })\n        const results = { trips: figure(\'transport.fleetTrip\'', 'results: [fleetTripResult(trip, profile)], value, units })\n        const results = { trips: figure(\'transport.fleetTrip\'', ['pages-transport']],
  ['Transport rules a fleet\'s fuel as its trip', 'transportPage', 'figure(\'transport.fleetBurn\', trip.fuelPerTrip, \'L\')', 'figure(\'transport.fleetTrip\', trip.fuelPerTrip, \'L\')', ['pages-transport']],
  ['Transport rules a fleet\'s share of a tank as its trip', 'transportPage', 'figure(\'transport.fleetBurn\', trip.fuelShare * 100, \'%\')', 'figure(\'transport.fleetTrip\', trip.fuelShare * 100, \'%\')', ['pages-transport']],
  ['Transport rules a class\'s fuel as its freight', 'transportPage', 'figure(\'transport.fuelPerTrip\', trip.fuelPerShip * count, \'L\')', 'figure(\'transport.freightPerYear\', trip.fuelPerShip * count, \'L\')', ['pages-transport']],
  ['Transport rules a class\'s share of a tank as its round trip', 'transportPage', 'figure(\'transport.fuelPerTrip\', trip.fuelShare * 100, \'%\')', 'figure(\'transport.roundTrip\', trip.fuelShare * 100, \'%\')', ['pages-transport']],
  ['Transport rules a class\'s trips as its fuel', 'transportPage', 'figure(\'transport.freightPerYear\', trip.trips, \'trips/yr\')', 'figure(\'transport.fuelPerTrip\', trip.trips, \'trips/yr\')', ['pages-transport']],
  ['Transport states a class\'s freight as its trips', 'transportPage', 'figure(\'transport.freightPerYear\', base.cargo === null ? null : base.cargo * trip.trips, \'t/yr\')', 'figure(\'transport.freightPerYear\', trip.trips, \'t/yr\')', ['pages-transport']],
  ['Transport states a fleet\'s freight as its trip days', 'transportPage', 'figure(\'transport.fleetTrip\', trip.tonsYear, \'t/yr\')', 'figure(\'transport.fleetTrip\', trip.tripSeconds / SECONDS_PER_DAY, \'t/yr\')', ['pages-transport']],
  ['Transport states a fleet\'s share of a tank as a fraction', 'transportPage', 'figure(\'transport.fleetBurn\', trip.fuelShare * 100, \'%\')', 'figure(\'transport.fleetBurn\', trip.fuelShare, \'%\')', ['pages-transport']],
  ['a derived figure takes the value of its results', 'position', 'compute: () => value, units', 'compute: (values) => Object.values(values)[0], units', ['pages-transport', 'pages-hauling']],
  ['a derived figure keeps the units of its rule', 'position', 'compute: () => value, units', 'compute: () => value', ['pages-transport']],
  ['Hauling states the days of a class with the days of one trip', 'haulingPage', 'classResult: days(estimate.classDays)', 'classResult: days(estimate.tripDays)', ['pages-hauling']],
  ['Hauling states the days for one ship with the days of one trip', 'haulingPage', 'oneShipResult: days(estimate.oneShipDays)', 'oneShipResult: days(estimate.tripDays)', ['pages-hauling']],
  ['Hauling states the days to complete a haul as a round trip', 'haulingPage', 'rule: \'hauling.haulDays\'', 'rule: \'transport.roundTrip\'', ['pages-hauling']],
  ['Hauling states the days to complete a haul without its positions', 'haulingPage', 'results: [result], value', 'results: [tripResult(estimate)], value', ['pages-hauling']],
  ['Hauling marks the best class with one trip', 'haulingPage', '<provenance-mark v-if="item.best.oneShipResult" :result="item.best.oneShipResult" />', '<provenance-mark v-if="item.best.result" :result="item.best.result" />', ['pages-hauling']],
  ['Hauling does not mark the best class\'s days', 'haulingPage', '<provenance-mark v-if="item.best.oneShipResult" :result="item.best.oneShipResult" />', '', ['pages-hauling']],
  ['Hauling does not mark the days for one ship', 'haulingPage', /(estimate\.oneShipDays[^\n]*?)<provenance-mark v-if="estimate\.oneShipResult" :result="estimate\.oneShipResult" \/>/, (m) => m[1], ['pages-hauling']],
  ['Hauling does not mark the days of a class', 'haulingPage', /(estimate\.classDays[^\n]*?)<provenance-mark v-if="estimate\.classResult" :result="estimate\.classResult" \/>/, (m) => m[1], ['pages-hauling']],
  ['Hauling marks the days for one ship with one trip', 'haulingPage', /(estimate\.oneShipDays[^\n]*?<provenance-mark v-if=")estimate\.oneShipResult(" :result=")estimate\.oneShipResult(" \/>)/, (m) => `${m[1]}estimate.result${m[2]}estimate.result${m[3]}`, ['pages-hauling']],
  ['Hauling marks the days of a class with one trip', 'haulingPage', /(estimate\.classDays[^\n]*?<provenance-mark v-if=")estimate\.classResult(" :result=")estimate\.classResult(" \/>)/, (m) => `${m[1]}estimate.result${m[2]}estimate.result${m[3]}`, ['pages-hauling']],
  ['Hauling does not mark the distance of a leg', 'haulingPage', '<provenance-mark v-if="item.legResults[index].status !== \'confirmed\'" :result="item.legResults[index]" />', '', ['pages-hauling']],
  ['Hauling does not mark a delivery total', 'haulingPage', '<provenance-mark :result="item.result" />', '', ['pages-hauling']],
  ['Hauling marks the jump count with the distance\'s result', 'haulingPage', '<provenance-mark :result="item.jumpsResult" />', '<provenance-mark v-if="item.pathResult" :result="item.pathResult" />', ['pages-hauling']],
  ['Hauling gives the jump count no result', 'haulingPage', 'jumpsResult: routeFigures({ jumps: haul.jumps, km: haul.km }).jumps,', 'jumpsResult: null,', ['pages-hauling']],
  ['Hauling leaves a leg\'s distance as it was', 'haulingPage', 'withPositions(distanceResult(leg.km), legPositions[index])', 'distanceResult(leg.km)', ['pages-hauling']],
  ['Hauling states a leg with the positions of its own start', 'haulingPage', 'orders[(index + 1) % orders.length]', 'orders[index]', ['pages-hauling']],
  ['Hauling\'s delivery totals leave out the positions of the fleets', 'haulingPage', 'total.records.push(...row.positions.records)', 'total.records.push()', ['pages-hauling']],
  ['Hauling leaves a delivery total as it was', 'haulingPage', 'result: withPositions(ofRule({ rule: \'hauling.deliveries\', value: total.amount, units: total.kind === \'colonists\' ? \'colonists/yr\' : \'t/yr\', inputs: { present: [\'the saved orders of the fleets\'] } }), summarisePositions(records))', 'result: ofRule({ rule: \'hauling.deliveries\', value: total.amount, units: total.kind === \'colonists\' ? \'colonists/yr\' : \'t/yr\', inputs: { present: [\'the saved orders of the fleets\'] } })', ['pages-hauling']],
  ['Hauling states a delivery of colonists in tonnes', 'haulingPage', 'units: total.kind === \'colonists\' ? \'colonists/yr\' : \'t/yr\', ', '', ['pages-hauling']],
  ['Hauling states a delivery of freight in colonists', 'haulingPage', 'units: total.kind === \'colonists\' ? \'colonists/yr\' : \'t/yr\', ', 'units: \'colonists/yr\', ', ['pages-hauling']],
  ['Hauling starts a leg where the order before it went', 'haulingPage', 'routePositions([orderExitEndpoint(orders[index]), ', 'routePositions([orderEndpoint(orders[index]), ', ['pages-hauling']],
  ['Hauling leaves the exits of the orders out of a route\'s summary', 'haulingPage', 'routePositions(orders.flatMap((order) => [orderEndpoint(order), orderExitEndpoint(order)]), { facts: this.positionRead })', 'routePositions(orders.map(orderEndpoint), { facts: this.positionRead })', ['pages-hauling']],
  ['Hauling does not read where an order comes out', 'haulingPage', 'as ExitDestinationID,', 'as ExitDestination,', ['pages-hauling']],
  ['a transit leaves the fleet where it went', 'position', 'export const orderExitEndpoint = (order) => (order.Jumps ? ', 'export const orderExitEndpoint = (order) => (false ? ', ['order-identity', 'pages-hauling']],
  ['an order names a survey location by its number in the system', 'position', 'order.DestinationType === 4 ? order.SurveyLocationID : order.DestinationID', 'order.DestinationID', ['order-identity']],
  ['an identity that is not read is keyed by the number of the destination', 'position', 'id === null ? `${kind}:unread:${order.SystemID}:${order.DestinationID}`', 'id === null ? `${kind}:${order.DestinationID}`', ['order-identity']],
  ['an order is keyed by the name of its family', 'position', ': place[kind](id)', ': `${family}:${id}`', ['order-identity', 'pages-hauling']],
  ['a waypoint is taken as fixed', 'position', 'waypoint: { clock: \'body\', motion: \'carried\' }', 'waypoint: { clock: \'none\', motion: \'fixed\' }', ['waypoint-carried']],
  ['a waypoint whose association is not read is taken as fixed', 'position', 'if (!found || !Number.isInteger(found.orbit)) {', 'if (!found) {', ['waypoint-carried']],
  ['a waypoint the read does not hold is taken as fixed', 'position', 'facts && facts.waypoints ? facts.waypoints[endpoint.id] : null', 'facts && facts.waypoints ? facts.waypoints[endpoint.id] : { orbit: 0, asteroid: null }', ['waypoint-carried']],
  ['a waypoint carried by an asteroid ignores its switch', 'position', 'found.asteroid === false ? \'planet\' : \'asteroid\'', '\'planet\'', ['waypoint-carried']],
  ['a waypoint carried by a body always moves', 'position', 'const moves = orbitMotion({ group: found.asteroid === false ? \'planet\' : \'asteroid\' }, facts, conditions)', 'const moves = true', ['waypoint-carried']],
  ['the read leaves out the orbit of a waypoint', 'position', 'FCT_Waypoint.OrbitBodyID as Orbit', '0 as Orbit', ['loader-schema']],
  ['the read of waypoints takes every race\'s', 'position', ' from FCT_Waypoint where FCT_Waypoint.GameID = :GameID and FCT_Waypoint.RaceID = :RaceID', ' from FCT_Waypoint where FCT_Waypoint.GameID = :GameID', ['loader-schema']],
  ['an association stored as null reads as none', 'position', 'orbit: row.Orbit === null || row.Orbit === undefined ? null : Number(row.Orbit)', 'orbit: Number(row.Orbit)', ['loader-schema']],
  ['the kind of the body is not read', 'position', 'when FCT_SystemBody.BodyClass = 3 then 1 else 0 end from FCT_SystemBody', 'when FCT_SystemBody.BodyClass = 3 then 0 else 0 end from FCT_SystemBody', ['loader-schema']],
  ['an anchored fleet with no orders is idle', 'position', 'const mayMove = found.orders > 0 || found.anchor > 0', 'const mayMove = found.orders > 0', ['fleet-anchored', 'loader-schema']],
  ['an anchor is not said', 'position', 'if (found.anchor > 0) {', 'if (false) {', ['fleet-anchored']],
  ['an anchor that is not read is taken as none', 'position', ' || found.anchor === null || found.anchor === undefined) {', ') {', ['fleet-anchored']],
  ['a save with no anchor column reads as no anchors', 'position', 'fleet.has(\'AnchorFleetID\') ? \'FCT_Fleet.AnchorFleetID\' : \'null\'', 'fleet.has(\'AnchorFleetID\') ? \'FCT_Fleet.AnchorFleetID\' : \'0\'', ['loader-schema']],
  ['an anchor stored as null reads as none', 'position', 'anchor: row.Anchor === null || row.Anchor === undefined ? null : Number(row.Anchor)', 'anchor: Number(row.Anchor)', ['loader-schema']],
  ['an unread position is not said', 'position', 'if (!isPosition(endpoint)) {', 'if (false) {', ['unread-position']],
  ['an unread position is said only of a place that moves', 'position', 'if (!isPosition(endpoint)) {', 'if (!isPosition(endpoint) && state.moves !== false) {', ['unread-position']],
  ['an endpoint with no position holds its saved position', 'position', 'state = { ...state, assumption: \'unplaced\' }', 'state = { ...state }', ['unread-position']],
  ['a system takes the coordinates of its stop', 'position', 'Xcor: stop.kind === \'system\' ? 0 : stop.Xcor', 'Xcor: stop.Xcor', ['unread-position']],
  ['a leg starts at the stop before it', 'plan', 'routePositions([origin, placeEndpoint(to), ...viaEndpoints(route)]', 'routePositions([placeEndpoint(stops[index]), placeEndpoint(to), ...viaEndpoints(route)]', ['effective-start']],
  ['a system reached through a jump point is where the route came from', 'plan', 'origin = jumpEndpoint(arrival)', 'origin = placeEndpoint(to)', ['effective-start']],
  ['a system stop in the system the fleet is in resets where it started', 'plan', 'if (to.kind === \'system\' && route) {\n      if (arrival) {', 'if (to.kind === \'system\' && route) {\n      origin = placeEndpoint(to)\n\n      if (arrival) {', ['effective-start']],
  ['an unavailable stop leaves the start as it was', 'plan', 'origin = to.unavailable ? null : placeEndpoint(to)', 'origin = to.unavailable ? null : origin', ['effective-start']],
  ['a panel\'s summary is empty while the read is in flight', 'haulingPage', /(<v-card class="panel")(?=[^>]*data-summary=)([^>]*?)>(?=(?:(?!<v-card class="panel")[\s\S])*?:items="planRows")/, (m) => `${m[1]}${m[2].replace(/\s*data-summary="[^"]*"/, ' :data-summary="positionState.loading ? \'\' : \'text\'"')}>`, ['strip-bound']],
  ['a panel\'s summary is bound to a name the page has not got', 'haulingPage', /(<v-card class="panel")(?=[^>]*data-summary=)([^>]*?)>(?=(?:(?!<v-card class="panel")[\s\S])*?:items="planRows")/, (m) => `${m[1]}${m[2].replace(/\s*data-summary="[^"]*"/, ' :data-summary="unboundSummary"')}>`, ['strip-bound']],
]
/* eslint-enable no-template-curly-in-string */

// ---- Benign edits ----------------------------------------------------------------------------------------------------
// Edits that change nothing the checks look at: the wording of an assumption, a condition, a mode and a label, the order of the attributes of the strip and of the lists, and a panel's summary. Each is located by the attribute, key or code it belongs to, never by what it holds now.
const STRING = '\'[^\'\\n]*\''

const BENIGN = [
  { label: 'an assumption reworded', target: 'position', at: new RegExp(`(\\n {2}fixed: )${STRING}`), to: (m) => `${m[1]}'the place stays where it is, so its saved position is exact at any time'` },
  { label: 'a condition reworded', target: 'position', at: new RegExp(`(\\n {2}'fleet-orders': )${STRING}`), to: (m) => `${m[1]}'orders are queued for the fleet and where it goes is not known'` },
  { label: 'a mode label reworded', target: 'component', at: new RegExp(`(\\n {2}static: )${STRING}`), to: (m) => `${m[1]}'Positions as the save stores them'` },
  { label: 'the label of the read reworded', target: 'mixin', at: new RegExp(`(\\n {2}positionFacts: )${STRING}`), to: (m) => `${m[1]}'when each saved position was stored'` },
  { label: 'the attributes of the strip of Route Finder reordered', target: 'routesPage', at: /<route-positions (:positions="[^"]*") (:state="[^"]*") (class="[^"]*") (@retry="[^"]*") \/>/, to: (m) => `<route-positions ${m[4]} ${m[3]} ${m[2]} ${m[1]} />` },
  { label: 'the attributes of the strip of Transport reordered', target: 'transportPage', at: /<route-positions (v-if="[^"]*") (:positions="[^"]*") (:state="[^"]*") (class="[^"]*") (@retry="[^"]*") \/>/, to: (m) => `<route-positions ${m[5]} ${m[4]} ${m[3]} ${m[2]} ${m[1]} />` },
  { label: 'the attributes of the strip of Hauling plan reordered', target: 'haulingPage', at: /<route-positions (v-if="planPositions[^"]*") (:positions="planPositions") (:state="[^"]*") (class="[^"]*") (@retry="[^"]*") \/>/, to: (m) => `<route-positions ${m[5]} ${m[4]} ${m[3]} ${m[2]} ${m[1]} />` },
  { label: 'the summary of the Hauling plan panel reworded', target: 'haulingPage', at: /(<v-card class="panel" data-summary=")[^"]*(" elevation="1">(?:(?!<v-card class="panel")[\s\S])*?:items="planRows")/, to: (m) => `${m[1]}Hauls that would cover what colonies lack, from the nearest colony with stock, and what each freighter class takes${m[2]}` },
  { label: 'the attributes of the Hauling plan panel reordered', target: 'haulingPage', at: /<v-card class="panel" (data-summary="[^"]*") (elevation="1")>((?:(?!<v-card class="panel")[\s\S])*?:items="planRows")/, to: (m) => `<v-card class="panel" ${m[2]} ${m[1]}>${m[3]}` },
  { label: 'the optional inputs of Transport listed in the opposite order', target: 'transportPage', at: /(const OPTIONAL_INPUTS = )\[('[^']*'(?:, '[^']*')*), (\.\.\.POSITION_INPUTS)\]/, to: (m) => `${m[1]}[${m[3]}, ${m[2].split(', ').reverse().join(', ')}]` },
  { label: 'the optional inputs of Hauling listed in the opposite order', target: 'haulingPage', at: /(const OPTIONAL_INPUTS = )\[('[^']*'(?:, '[^']*')*), (\.\.\.POSITION_INPUTS)\]/, to: (m) => `${m[1]}[${m[3]}, ${m[2].split(', ').reverse().join(', ')}]` },
  { label: 'the label of a position that is current reworded', target: 'position', at: /(\} else if \(seconds === 0\) \{\n {4}return )'[^'\n]*'/, to: (m) => `${m[1]}'at the save time'` },
  { label: 'the label of an age that is not read reworded', target: 'position', at: /(if \(!isTime\(seconds\)\) \{\n {4}return )'[^'\n]*'/, to: (m) => `${m[1]}'not recorded'` },
  { label: 'the label of an age the strip does not read reworded', target: 'component', at: /(this\.age && this\.age\.status !== 'unavailable' \? ageText\(this\.age\.value\) : )'[^'\n]*'/, to: (m) => `${m[1]}'not recorded'` },
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
      ...BENIGN.slice(1, -1).map((_edit, index) => [`benign edits stacked: the first ${index + 2}`, async () => (await run(CHECKS, worldOf(BENIGN.slice(0, index + 2)))).map(describeFailure)]),
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
