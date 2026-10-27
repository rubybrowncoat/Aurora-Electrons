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
  - the kind of the body a place stands on (a body, a colony, a Lagrange point, an order's destination, a waypoint, a fleet orbiting a body) is read from the saved fields as the game moves it, a trojan following the planet switch and an independent asteroid also its own, and is unknown where the fields were not read, for every pair of switches, driven from the real loaders over saves of every kind of body;
  - each page tracks the read as an optional input under the key its label has, never holds the page back, shows the strip in its loading, failed and ready states and has a summary on every panel.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names. Each benign edit and all of them together must leave every check green. Representative faults also run with all rewrites, for every check and reader path. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults and the benign edits. `--only=text|text` selects fault and rewrite names or their stable `fault:N`, `composed:N`, `benign:N` and `benign:all` keys; the head still runs every check. `--detail` prints the named failures that catch a fault.

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
  orbit: inRenderer('utilities', 'orbit-propagation.js'),
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
    31: { orbit: 0, group: null },
    32: { orbit: 3, group: 'planet' },
    33: { orbit: 4, group: 'asteroid' },
    34: { orbit: null, group: null },
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

// A summary with its records and assumptions in a fixed order, to compare what two paths state whatever order they list it in.
const canonical = (positions) => ({ ...asJson(positions), records: asJson(positions.records).sort((a, b) => (a.identity.key < b.identity.key ? -1 : 1)), assumptions: [...positions.assumptions].sort() })

// ---- A SQLite database that answers the loader's queries --------------------------------------------------------------
const SCHEMA = `
  create table FCT_Game (GameID integer, GameTime real, LastGrowthTime real, OrbitalMotion integer, OrbitalMotionAst integer);
  create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, LastMoveTime real, OrbitBodyID integer, Xcor real, Ycor real, AnchorFleetID integer);
  create table FCT_MoveOrders (FleetID integer, GameID integer, MoveOrder integer);
  create table FCT_SystemBody (SystemBodyID integer, Xcor real, Ycor real, BodyClass integer, TrojanAsteroid integer, ParentBodyID integer, FixedBody integer);
  create table FCT_Waypoint (WaypointID integer, GameID integer, RaceID integer, OrbitBodyID integer);
`

const ROWS = `
  insert into FCT_Game values (1, 1000000, 900000, 1, 0);
  insert into FCT_SystemBody values (3, 10, 5, 1, 0, 0, 0);
  insert into FCT_SystemBody values (4, null, 5, 3, 0, 0, 0);
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

// A stable copy exposes the pages' cacheQueries without forcing another module graph for every world. The cache itself keeps databases apart with a WeakMap, as in the app.
const QUERY_CACHE = `${fs.readFileSync(inRenderer('utilities', 'query-cache.js'), 'utf8')}\nglobalThis.__routePositionQueryCache = { cacheQueries }`

const worldOf = (edits = []) => {
  const text = { ...ORIGINALS }

  edits.forEach((edit) => {
    const change = resolved(edit, text[edit.target])

    text[edit.target] = patched(FILES[edit.target], text[edit.target], change.from, change.to)
  })

  const utilitySources = { 'route-position': text.position, 'route-plan': text.plan, 'orbit-propagation': text.orbit }
  const pageSources = {
    'utilities/route-position': text.position,
    'utilities/route-plan': text.plan,
    'utilities/orbit-propagation': text.orbit,
    'mixins/route-position': text.mixin,
    'components/page/RoutePositions': text.component,
    'pages/routes': text.routesPage,
    'pages/information': text.transportPage,
    'pages/hauling': text.haulingPage,
  }
  const labelsOf = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
  const modules = memo(() => loadUtilities(['route-position', 'route-plan', 'orbit-propagation', 'jump-graph', 'transport', 'haul-plan', 'provenance', 'places'], { sources: utilitySources }))
  const component = memo(() => loadPage('components/page/RoutePositions', { sources: pageSources }))
  const load = (name) => memo(() => loadPage(name, { sources: pageSources, modules: { 'mixins/load-state': labelsOf } }))
  const kept = (name) => ({ cache: () => globalThis.__routePositionQueryCache, load: memo(() => loadPage(name, { sources: pageSources, modules: { 'mixins/load-state': labelsOf, 'utilities/query-cache': QUERY_CACHE } })) })
  const transport = kept('pages/information')
  const hauling = kept('pages/hauling')

  return { text, modules, component, routes: load('pages/routes'), transport: transport.load, hauling: hauling.load, caches: { transport: transport.cache, hauling: hauling.cache } }
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

check('motion-switch', 'whether a body moves follows the game\'s orbital motion switches, an unrecorded switch is unknown and the life pod family is not supported', async (w) => {
  const off = await positionsOf(w, [BODY], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 0 } } })

  assert.equal(off.records[0].moves, false, 'a body that does not move is exact')
  assert.equal(off.caveat, false)

  const unknown = await positionsOf(w, [BODY], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: null } } })

  assert.equal(unknown.records[0].moves, null)
  assert.ok(unknown.records[0].conditions.includes('motion-switch'))

  const rock = { ...BODY, key: 'body:4', id: 4, group: 'asteroid' }
  const held = { bodies: { 4: { id: 4, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 2, bearing: 90, year: 8760, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 1, ycor: 1 } }, stars: {}, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const pickedOnly = await positionsOf(w, [rock], { facts: { ...FACTS, clock: { ...CLOCK, orbitalMotion: 1, orbitalMotionAst: 0 } } })

  assert.equal(pickedOnly.records[0].moves, null, 'a body the picker calls an asteroid is a trojan or an independent asteroid, and the orbit read that would tell which is missing')
  assert.ok(pickedOnly.records[0].conditions.includes('motion-switch'))

  const split = await positionsOf(w, [rock], { facts: { ...FACTS, orbits: held, clock: { ...CLOCK, orbitalMotion: 1, orbitalMotionAst: 0 } } })

  assert.equal(split.records[0].moves, false, 'an asteroid whose own switch reads off is held where it is saved, a known value and not an unknown one')
  assert.deepEqual(split.records[0].conditions, [])
  assert.equal(split.caveat, false)

  const unreadRocks = await positionsOf(w, [rock], { facts: { ...FACTS, orbits: held, clock: { ...CLOCK, orbitalMotion: 1, orbitalMotionAst: null } } })

  assert.equal(unreadRocks.records[0].moves, null, 'an asteroid switch that was never read leaves it unknown')
  assert.ok(unreadRocks.records[0].conditions.includes('motion-switch'))

  const frozen = await positionsOf(w, [rock], { facts: { ...FACTS, orbits: held, clock: { ...CLOCK, orbitalMotion: 0, orbitalMotionAst: 1 } } })

  assert.equal(frozen.records[0].moves, false, 'with planet and moon motion off nothing moves, whatever the asteroid switch says')
  assert.deepEqual(frozen.records[0].conditions, [])
  assert.equal(frozen.caveat, false)

  const drifting = await positionsOf(w, [{ family: 'lifepod', key: 'lifepod:1', id: 1, SystemID: 1, Xcor: 1, Ycor: 1 }])

  drifting.records.forEach((record) => {
    assert.equal(record.supported, false)
    assert.ok(record.conditions.includes('drift-unobserved'))
  })
  assert.equal((await positionsOf(w, [{ family: 'moon-base', key: 'x:1', id: 1, SystemID: 1, Xcor: 1, Ycor: 1 }])).records[0].conditions[0], 'family-unknown')
})

check('motion-matrix', 'whether an endpoint moves follows the two motion switches for every kind of place, a switch read as 0 being known to be off and one never read unknown: branch by planet switch by asteroid switch, each cell against the rule written out here', async (w) => {
  const rp = (await w.modules())['route-position']
  const rock = (id, extra = {}) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 2, bearing: 90, year: 8760, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 1, ycor: 1, ...extra })
  const bodies = { 1: rock(1, { bodyClass: 1, eccentricity: 0.1 }), 2: rock(2, { bodyClass: 2, parentId: 1 }), 3: rock(3, { trojan: 60, parentId: 1 }), 4: rock(4), 5: rock(5, { bodyClass: 5, eccentricity: 0.5 }), 6: rock(6, { eccentricity: 0.3 }), 7: rock(7, { fixed: 1, fixedParentId: 0 }), 8: rock(8, { fixed: 1, fixedParentId: 1 }), 9: rock(9, { fixed: 1, fixedParentId: 4 }), 10: rock(10, { fixed: 1, fixedParentId: null }) }
  const orbits = { bodies, stars: {}, points: { 91: { id: 91, planetId: 1 }, 92: { id: 92, planetId: 4 } }, hidden: {}, hiddenPoints: {}, bodyOf: { 71: 1, 72: 4 }, problems: [] }
  const at = { SystemID: 1, Xcor: 1, Ycor: 1 }
  const body = (id, group) => ({ family: 'body', key: 'body:' + id, id, ...at, ...(group ? { group } : {}) })
  const waypoint = (id) => ({ family: 'waypoint', key: 'waypoint:' + id, id, ...at })
  const waypoints = { 1: { orbit: 0, group: null }, 2: { orbit: 1, group: 'planet' }, 3: { orbit: 4, group: 'asteroid' }, 4: { orbit: 4, group: 'unknown' }, 5: { orbit: null, group: null }, 6: { orbit: 9, group: 'static' } }

  // The rule: nothing moves with the planet and moon switch off; an independent asteroid, which needs both, stays where it is saved with its own switch off; a planet, moon, comet or trojan follows the planet switch; what is not read is unknown.
  const planetRule = (planets) => (planets === 1 ? true : planets === 0 ? false : null)
  const rockRule = (planets, rocks) => (planets === 0 ? false : rocks === 0 ? false : planets === 1 && rocks === 1 ? true : null)
  const bothRule = (planets, rocks) => (planets === 0 ? false : planets === 1 && rocks === 1 ? true : null)
  const BRANCHES = [
    { name: 'planet', endpoint: body(1), rule: planetRule },
    { name: 'moon', endpoint: body(2), rule: planetRule },
    { name: 'trojan of a planet', endpoint: body(3), rule: planetRule },
    { name: 'comet', endpoint: body(5), rule: planetRule },
    { name: 'fixed body with no parent', endpoint: body(7), rule: () => false },
    { name: 'fixed body of a planet', endpoint: body(8), rule: planetRule },
    { name: 'fixed body of an independent asteroid', endpoint: body(9), rule: rockRule },
    { name: 'fixed body whose parent was not read', endpoint: body(10), rule: bothRule },
    { name: 'type 15 order on a fixed body with no parent', endpoint: rp.orderEndpoint({ DestinationType: 15, DestinationID: 7, SystemID: 1, X: 1, Y: 1 }), rule: () => false },
    { name: 'type 15 order on a fixed body of a planet', endpoint: rp.orderEndpoint({ DestinationType: 15, DestinationID: 8, SystemID: 1, X: 1, Y: 1 }), rule: planetRule },
    { name: 'type 15 order on a fixed body of an independent asteroid', endpoint: rp.orderEndpoint({ DestinationType: 15, DestinationID: 9, SystemID: 1, X: 1, Y: 1 }), rule: rockRule },
    { name: 'type 15 order on a fixed body whose parent was not read', endpoint: rp.orderEndpoint({ DestinationType: 15, DestinationID: 10, SystemID: 1, X: 1, Y: 1 }), rule: bothRule },
    { name: 'independent asteroid, circular', endpoint: body(4), rule: rockRule },
    { name: 'independent asteroid, eccentric', endpoint: body(6), rule: rockRule },
    { name: 'body the orbit read lacks, picked as a planet', endpoint: body(99, 'planet'), rule: planetRule },
    { name: 'body the orbit read lacks, picked as an asteroid', endpoint: body(98, 'asteroid'), rule: bothRule },
    { name: 'body the orbit read lacks, picked as a moon', endpoint: body(97, 'moon'), rule: planetRule },
    { name: 'body the orbit read lacks, picked as a comet', endpoint: body(96, 'comet'), rule: planetRule },
    { name: 'body the orbit read lacks, with no group', endpoint: body(95), rule: bothRule },
    { name: 'colony whose body the orbit read lacks', endpoint: { family: 'colony', key: 'colony:79', id: 79, ...at }, rule: bothRule },
    { name: 'Lagrange point whose body the orbit read lacks', endpoint: { family: 'lagrange-point', key: 'lagrange:99', id: 99, ...at }, rule: bothRule },
    { name: 'colony on a planet', endpoint: { family: 'colony', key: 'colony:71', id: 71, ...at }, rule: planetRule },
    { name: 'colony on an asteroid', endpoint: { family: 'colony', key: 'colony:72', id: 72, ...at }, rule: rockRule },
    { name: 'Lagrange point of a planet', endpoint: { family: 'lagrange-point', key: 'lagrange:91', id: 91, ...at }, rule: planetRule },
    { name: 'Lagrange point of an asteroid, which the game never moves', endpoint: { family: 'lagrange-point', key: 'lagrange:92', id: 92, ...at }, rule: () => false },
    { name: 'waypoint carried by no body', endpoint: waypoint(1), rule: () => false },
    { name: 'waypoint carried by a planet', endpoint: waypoint(2), rule: planetRule },
    { name: 'waypoint carried by an asteroid', endpoint: waypoint(3), rule: rockRule },
    { name: 'waypoint carried by a body of unread kind', endpoint: waypoint(4), rule: bothRule },
    { name: 'waypoint carried by a body that stays', endpoint: waypoint(6), rule: () => false },
    { name: 'waypoint whose body is unread', endpoint: waypoint(5), rule: () => null, unread: 'waypoint-orbit-unread' },
    { name: 'system centre', endpoint: { family: 'system', key: 'system:1', id: 1, ...at }, rule: () => false },
    { name: 'jump point', endpoint: { family: 'jump-point', key: 'jump:1', id: 1, ...at }, rule: () => false },
  ]
  const SWITCHES = [1, 0, null]
  let cells = 0

  BRANCHES.forEach((branch) => {
    SWITCHES.forEach((planets) => {
      SWITCHES.forEach((rocks) => {
        const facts = { ...FACTS, waypoints, orbits, clock: { ...CLOCK, orbitalMotion: planets, orbitalMotionAst: rocks } }
        const [record] = rp.routePositions([branch.endpoint], { facts }).records
        const expected = branch.rule(planets, rocks)
        const label = branch.name + ', planets ' + planets + ', asteroids ' + rocks

        cells += 1
        assert.equal(record.moves, expected, label + ': moves ' + expected)
        assert.equal(record.supported, true, label + ': the contract supports the place')
        assert.equal(record.conditions.includes('motion-switch'), expected === null && !branch.unread && rp.FAMILY_NAMES.includes(branch.endpoint.family) && !['system', 'jump-point'].includes(branch.endpoint.family), label + ': names the switch only when it is the unknown')
      })
    })
  })
  assert.equal(cells, BRANCHES.length * 9)
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

  // A plan with no adapters is the static one; with adapters, the read clock and a speed it is flown, the arrival positions are stated beside the figure on the saved ones, and an adapter that gives no position leaves the saved one with its reason.
  const ahead = (endpoint) => ({ position: { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor + 1, Ycor: endpoint.Ycor }, observedAt: GAME_TIME + 1, conditions: [] })
  const bodies = [stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 1, Ycor: 1 })]
  const saved = plan.planRoute(bodies, { cycle: false, jumpPoints: LINKS, facts: FACTS })
  const given = plan.planRoute(bodies, { cycle: false, jumpPoints: LINKS, facts: FACTS, adapters: { body: ahead }, speed: 1000 })
  const declined = plan.planRoute(bodies, { cycle: false, jumpPoints: LINKS, facts: FACTS, adapters: { body: () => ({ reasons: ['orbit-family'] }) }, speed: 1000 })

  assert.equal(saved.positions.mode, 'static', 'a plan with no adapters does not claim a position its distances did not use')
  assert.equal(saved.static, undefined, 'and has no second figure to state')
  assert.equal(given.positions.mode, 'propagated', 'a plan flown with adapters and a speed states the arrival positions')
  assert.equal(given.static.km, saved.km, 'beside the figure on the saved positions')
  assert.equal(declined.positions.mode, 'static', 'an adapter that gives no position leaves the saved one')
  assert.equal(declined.km, saved.km)
  assert.ok(declined.positions.conditions.some((one) => one.code === 'propagation-unavailable'), 'and says so')

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

check('timed-basis', 'the fastest-time order stays on the positions the save stores: a plan timed with adapters and a speed states the saved positions, carries no second figure, and its waits and elapsed time say the same positions as its distance', async (w) => {
  const m = await w.modules()
  const plan = m['route-plan']
  const bodies = [stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 1, Ycor: 1 })]
  const ahead = (endpoint) => ({ position: { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor + 1, Ycor: endpoint.Ycor }, observedAt: GAME_TIME + 1, conditions: [] })
  const timing = { speed: 1000, speedIn: null, shock: { lo: 10, hi: 20 }, startDelay: 0, retry: 5 }
  const base = { cycle: false, jumpPoints: LINKS, facts: FACTS, order: 'time', timing }
  const timed = plan.planRoute(bodies, base)
  const flown = plan.planRoute(bodies, { ...base, adapters: { body: ahead }, speed: 1000 })
  const figures = plan.planResults(flown)

  assert.ok(timed.time && timed.time.total, 'the plan is timed')
  assert.equal(flown.positions.mode, 'static', 'adapters and a speed leave the timed order on the saved positions')
  assert.equal(flown.static, undefined, 'and give no second figure to state')
  assert.equal(flown.km, timed.km, 'the distance is the one of the saved positions')
  assert.deepEqual(asJson(flown.positions), asJson(timed.positions), 'the positions are those of the plan with no adapters')
  assert.equal(figures.km.status, 'estimated')
  ;['elapsed', 'wait'].forEach((name) => {
    assert.equal(figures.time[name].status, 'estimated', name + ' rests on positions that move')
    flown.positions.missing.forEach((missing) => assert.ok(figures.time[name].inputs.missing.includes(missing), name + ' names what the positions lack'))
    flown.positions.assumptions.forEach((held) => assert.ok(figures.time[name].assumptions.includes(held), name + ' states the positions held'))
  })
})

check('timed-clock', 'a plan or a cycle whose elapsed time is a range stays on the positions the save stores and says so, and one whose time is the flight alone is still flown to the bodies where they are on arrival', async (w) => {
  const m = await w.modules()
  const plan = m['route-plan']
  const rp = m['route-position']
  const ahead = (endpoint) => ({ position: { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor + 1, Ycor: endpoint.Ycor }, observedAt: GAME_TIME + 1, conditions: [] })
  const timing = { speed: 1000, speedIn: null, shock: { lo: 10, hi: 20 }, startDelay: 0, retry: 5 }
  const flown = (stops, extra = {}) => plan.planRoute(stops, { cycle: false, jumpPoints: LINKS, facts: FACTS, adapters: { body: ahead }, speed: 1000, timing, ...extra })

  // A plan with a jump waits for the shock, and a plan in a nebula flies at a lower speed in a system: each has an elapsed time that is a range or is not the distance over the speed, so each stays on the saved positions with no second figure.
  const jumped = flown([stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 1, Ycor: 1 }), stop('body', 5, { Xcor: 20 })])
  const capped = flown([stop('body', 3), stop('body', 4, { Xcor: 20 })], { timing: { ...timing, speedIn: () => 500 } })
  const lone = flown([stop('body', 3), stop('body', 4, { Xcor: 20 })])

  assert.ok(jumped.time && jumped.time.total && jumped.time.wait.hi > 0, 'the plan back across a jump waits for the shock')
  assert.equal(jumped.positions.mode, 'static', 'a wait that is a range leaves the bodies on the saved positions')
  assert.equal(jumped.static, undefined, 'with no second figure')
  assert.ok(capped.time && capped.time.total && capped.time.flightHi !== undefined, 'the plan in a nebula is timed')
  assert.equal(capped.positions.mode, 'static', 'a flight held to a lower speed leaves the bodies on the saved positions')
  assert.equal(capped.static, undefined)
  assert.ok(lone.time && lone.time.total && lone.time.wait.hi === 0, 'the plan in one system has no wait')
  assert.equal(lone.positions.mode, 'propagated', 'a flight alone is the clock the bodies are moved on')
  assert.ok(lone.static, 'and the saved positions are stated beside it')

  // A plan whose flights on the saved positions run the shock down has no wait; a body moved nearer to the jump point shortens the flights since the transit and gives it one. The plan flown on the moved bodies is a range again, so it keeps the saved positions.
  const nearer = (endpoint) => ({ position: { SystemID: endpoint.SystemID, Xcor: endpoint.key === 'body:4' ? 1000 : endpoint.Xcor, Ycor: endpoint.Ycor }, observedAt: GAME_TIME + 1, conditions: [] })
  const across = [stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 13000, Ycor: 0 }), stop('body', 5, { Xcor: 20 })]
  const unmoved = plan.planRoute(across, { cycle: false, jumpPoints: LINKS, facts: FACTS, timing })
  const gained = flown(across, { adapters: { body: nearer } })

  assert.deepEqual(unmoved.time.wait, { lo: 0, hi: 0 }, 'on the saved positions the flights run the shock down')
  assert.equal(gained.positions.mode, 'static', 'a plan that gains a wait on the moved bodies keeps the saved positions')
  assert.equal(gained.static, undefined, 'with no second figure')
  assert.deepEqual(gained.time.total, unmoved.time.total, 'and the time of the saved positions')
  assert.equal(gained.km, unmoved.km)

  // The other way round, a plan that waits on the saved positions keeps them even where the moved bodies would run the shock down: its time on the positions the save stores is a range, so no body is moved on to an arrival.
  const farther = (endpoint) => ({ position: { SystemID: endpoint.SystemID, Xcor: endpoint.key === 'body:4' ? 13000 : endpoint.Xcor, Ycor: endpoint.Ycor }, observedAt: GAME_TIME + 1, conditions: [] })
  const lost = flown([stop('body', 3), stop('body', 4, { SystemID: 2, Xcor: 1000, Ycor: 0 }), stop('body', 5, { Xcor: 20 })], { adapters: { body: farther } })

  assert.ok(lost.time && lost.time.total && lost.time.wait.hi > 0, 'on the saved positions the plan waits')
  assert.equal(lost.positions.mode, 'static', 'so it keeps the saved positions though the moved bodies would not wait')

  // A cycle that waits or flies at a cap gives the saved positions for the first pass and the year.
  const AU = 149600000
  const rock = (id, distance, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rocks = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const orbitFacts = { bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const toRock = (id) => ({ PopulationID: 0, DestinationType: 2, DestinationID: id, SystemID: 1, Jumps: 0, label: `Rock ${id}`, Description: `Rock ${id}`, X: rocks[id - 1].xcor, Y: rocks[id - 1].ycor, ExitX: rocks[id - 1].xcor, ExitY: rocks[id - 1].ycor, ExitSystemID: 1 })
  const [one, two] = [1, 2].map((id) => [rp.orderEndpoint(toRock(id)), rp.orderExitEndpoint(toRock(id))])
  const hop = (from, to, extra) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, leave: to, wait: 0, ...extra })
  const cycles = (extra = {}) => plan.simulateCycles({ hops: [hop(one[1], two[0], { delay: 0, wait: 0 }), hop(two[1], one[0], {})], facts: { ...FACTS, orbits: orbitFacts }, adapters: rp.ADAPTERS, speed: 300, ...extra })
  const free = cycles()
  const waits = cycles({ timed: true })

  assert.equal(free.annual.status, 'propagated', 'the bodies are moved on when the time is the flight')
  assert.notDeepEqual(free.first.km, free.static.km, 'and the first pass is not the saved distance')
  assert.deepEqual(cycles({ timed: false }), free, 'a cycle that is not timed is the one with no option')
  assert.equal(waits.annual.status, 'static', 'a timed cycle keeps the saved positions')
  assert.deepEqual(waits.annual.reasons, ['timed-clock'], 'and gives the reason')
  assert.equal(waits.annual.compared, true)
  assert.deepEqual(waits.first.km, waits.static.km, 'its first pass is the saved distance')
  assert.deepEqual(waits.annual.flights, waits.static.flights)
  assert.equal(waits.annual.meanKm, waits.static.meanKm)
  assert.ok(rp.CONDITIONS['timed-clock'], 'the reason is one the strip words')

  const fixed = cycles({ timed: true, hops: [hop({ ...one[1], family: 'jump-point' }, { ...two[0], family: 'jump-point' }, { delay: 0, wait: 0 })] })

  assert.equal(fixed.annual.status, 'static')
  assert.ok(!fixed.annual.reasons.includes('timed-clock'), 'a cycle of places that do not move is unaffected by the clock')
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
  assert.deepEqual(switched({ orbitalMotionAst: 0 }).records.map((record) => record.moves), [true, false], 'a waypoint carried by an asteroid follows the asteroids\' own switch as well, and a switch read as off is known')
  assert.ok(!switched({ orbitalMotionAst: 0 }).records[1].conditions.includes('motion-switch'))
  assert.deepEqual(switched({ orbitalMotionAst: null }).records.map((record) => record.moves), [true, null], 'and one never read is not')
  assert.ok(switched({ orbitalMotionAst: null }).records[1].conditions.includes('motion-switch'))
  assert.deepEqual(switched({ orbitalMotion: null }).records.map((record) => record.moves), [null, null], 'a switch the save does not record leaves it unknown')

  const unknownBody = rp.routePositions([rock], { facts: { ...FACTS, waypoints: { 33: { orbit: 4, group: 'unknown' } }, clock: { ...CLOCK, orbitalMotionAst: 0 } } })

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
  assert.deepEqual({ ...facts.fleets[5] }, { lastMoveTime: 950000, following: false, group: null, orders: 0, anchor: 0 })
  assert.equal(facts.fleets[11].anchor, 5, 'the fleet a fleet is anchored to')
  assert.equal(facts.fleets[12].anchor, null, 'an anchor that is stored as null is unknown, not none')
  assert.deepEqual(Object.keys(facts.waypoints).map(Number).sort((a, b) => a - b), [31, 32, 33, 34, 35], 'the race\'s waypoints in the game, no other race\'s or game\'s')
  assert.deepEqual({ ...facts.waypoints[31] }, { orbit: 0, group: null }, 'a waypoint carried by no body')
  assert.deepEqual({ ...facts.waypoints[32] }, { orbit: 3, group: 'planet' })
  assert.deepEqual({ ...facts.waypoints[33] }, { orbit: 4, group: 'asteroid' })
  assert.deepEqual({ ...facts.waypoints[34] }, { orbit: null, group: null }, 'an association stored as null is unknown, not none')
  assert.deepEqual({ ...facts.waypoints[35] }, { orbit: 99, group: 'unknown' }, 'a body the read does not hold leaves its kind unknown')
  assert.equal(facts.fleets[6].following, true, 'a fleet at its body\'s exact position follows it')
  assert.equal(facts.fleets[8].following, false, 'a fleet beside its body does not')
  assert.equal(facts.fleets[6].group, 'planet', 'the group of the body a fleet orbits is read: a planet')
  assert.equal(facts.fleets[10].group, 'asteroid', 'an independent asteroid')
  assert.equal(facts.fleets[7].group, null, 'and a fleet that orbits no body has none')
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

// ---- A save of every kind of body, read by the real loaders -----------------------------------------------------------
const OWNER_COLUMNS = ['SystemBodyID', 'GameID', 'SystemID', 'StarID', 'BodyClass', 'TrojanAsteroid', 'OrbitalDistance', 'Bearing', 'Year', 'Eccentricity', 'EccentricityDirection', 'ParentBodyID', 'ParentBodyType', 'FixedBody', 'FixedBodyParentID', 'Xcor', 'Ycor']

// The columns the orbit read needs whole (a save lacking one has no orbit read at all); `FixedBodyParentID` is read when the save has it.
const ORBIT_REQUIRED = ['BodyClass', 'TrojanAsteroid', 'ParentBodyID', 'FixedBody']

// Each body as the save stores it. 1 a planet, 2 its moon, 3 its trojan, 4 an independent asteroid, 5 a comet, 6 an eccentric independent asteroid, 7 the trojan and 8 the moon of the asteroid, 9 a trojan held fixed with no fixed parent, 10 the body of a deep-space population created at the gas giant 12 (class 3, fixed, its fixed parent the gas giant), 11 an asteroid with no trojan angle stored, 13 a deep-space location (fixed, no parent), 14 a fixed body whose fixed parent is the independent asteroid, 15 a trojan whose fixed parent is the planet, 16 a deep-space population at a gas giant that no place stands on and 17 a trojan of an asteroid that no place stands on (their parents are read only by following them).
const OWNERS = [
  { id: 1, name: 'planet', row: { BodyClass: 1, OrbitalDistance: 1, Bearing: 90, Year: 8760, Eccentricity: 0.1 } },
  { id: 2, name: 'moon of a planet', row: { BodyClass: 2, OrbitalDistance: 0.002, Bearing: 10, Year: 100, ParentBodyID: 1, ParentBodyType: 1 } },
  { id: 3, name: 'trojan of a planet', row: { BodyClass: 3, TrojanAsteroid: 60, OrbitalDistance: 1, Bearing: 150, Year: 8760, ParentBodyID: 1, ParentBodyType: 1 } },
  { id: 4, name: 'independent asteroid', row: { BodyClass: 3, OrbitalDistance: 2.5, Bearing: 10, Year: 30000 } },
  { id: 5, name: 'comet', row: { BodyClass: 5, OrbitalDistance: 5, Bearing: 90, Year: 100000, Eccentricity: 0.5 } },
  { id: 6, name: 'eccentric independent asteroid', row: { BodyClass: 3, OrbitalDistance: 3, Bearing: 30, Year: 40000, Eccentricity: 0.3 } },
  { id: 7, name: 'trojan of an asteroid', row: { BodyClass: 3, TrojanAsteroid: 60, OrbitalDistance: 2.5, Bearing: 70, Year: 30000, ParentBodyID: 4, ParentBodyType: 3 } },
  { id: 8, name: 'moon of an asteroid', row: { BodyClass: 2, OrbitalDistance: 0.001, Bearing: 50, Year: 50, ParentBodyID: 4, ParentBodyType: 3 } },
  { id: 9, name: 'trojan held fixed', row: { BodyClass: 3, TrojanAsteroid: 60, OrbitalDistance: 1, Bearing: 150, Year: 8760, ParentBodyID: 1, ParentBodyType: 1, FixedBody: 1 } },
  { id: 10, name: 'deep-space population at a gas giant', row: { BodyClass: 3, OrbitalDistance: 4, Bearing: 200, Year: 1, ParentBodyType: 0, FixedBody: 1, FixedBodyParentID: 12 } },
  { id: 11, name: 'asteroid with no trojan angle stored', row: { BodyClass: 3, TrojanAsteroid: null, OrbitalDistance: 2.5, Bearing: 10, Year: 30000 } },
  { id: 12, name: 'gas giant', row: { BodyClass: 1, OrbitalDistance: 4, Bearing: 200, Year: 30000 } },
  { id: 13, name: 'deep-space location', row: { BodyClass: 3, OrbitalDistance: 6, Bearing: 300, Year: 1, FixedBody: 1 } },
  { id: 14, name: 'fixed body of an independent asteroid', row: { BodyClass: 3, OrbitalDistance: 2.5, Bearing: 10, Year: 1, FixedBody: 1, FixedBodyParentID: 4 } },
  { id: 15, name: 'trojan whose fixed parent is the planet', row: { BodyClass: 3, TrojanAsteroid: 60, OrbitalDistance: 1, Bearing: 90, Year: 8760, ParentBodyID: 1, ParentBodyType: 1, FixedBody: 1, FixedBodyParentID: 1 } },
  { id: 16, name: 'deep-space population at a gas giant that is no place', row: { BodyClass: 3, OrbitalDistance: 7, Bearing: 20, Year: 1, FixedBody: 1, FixedBodyParentID: 19 } },
  { id: 17, name: 'trojan of an asteroid that is no place', row: { BodyClass: 3, TrojanAsteroid: 60, OrbitalDistance: 3.5, Bearing: 80, Year: 35000, ParentBodyID: 18, ParentBodyType: 3 } },
]

// Bodies that are only the parent of another: the body a trojan orbits (18) and the gas giant of a deep-space population (19). A read that does not follow a parent never meets one, because no place stands on it.
const PARENT_ONLY = [
  { id: 18, name: 'asteroid that is a parent only', row: { BodyClass: 3, OrbitalDistance: 3.5, Bearing: 20, Year: 35000 } },
  { id: 19, name: 'gas giant that is a parent only', row: { BodyClass: 1, OrbitalDistance: 7, Bearing: 20, Year: 40000 } },
]

const PICKER_GROUPS = { 1: 'planet', 2: 'moon', 3: 'asteroid', 5: 'comet' }

// The classes of body the game's coordinate update of a Lagrange point sets a position for: a planet (1) and a moon (2), the only owners it moves a point for. A point is made only for those in the matrix; a point on any other owner (a trojan, an independent asteroid, a comet, a fixed body) is malformed data, checked apart with its own expectation.
const LAGRANGE_OWNER_CLASSES = [1, 2]

const POINT_OWNERS = OWNERS.filter((owner) => LAGRANGE_OWNER_CLASSES.includes(owner.row.BodyClass))

const MALFORMED_POINT_OWNERS = OWNERS.filter((owner) => !LAGRANGE_OWNER_CLASSES.includes(owner.row.BodyClass))

// The bodies a deep-space population or location is: class 3 bodies the game creates fixed, and the destination type 15 of a move order reaches.
const FIXED_OWNERS = OWNERS.filter((owner) => owner.row.FixedBody)

const AU_KM = 149600000

// The saved row of a body, with the defaults a save stores and the position of the orbit it is on; a fixed body with a fixed parent has the parent's.
const ownerRows = () => {
  const rows = {}

  ;[...OWNERS, ...PARENT_ONLY].forEach((owner) => {
    const row = { SystemBodyID: owner.id, GameID: 1, SystemID: 1, StarID: 1, TrojanAsteroid: 0, Eccentricity: 0, EccentricityDirection: 0, ParentBodyID: 0, ParentBodyType: 0, FixedBody: 0, FixedBodyParentID: 0, ...owner.row }

    // An eccentric orbit is saved at its far point on the bearing 90, where the rebuilt position equals the saved one.
    const reach = row.OrbitalDistance * AU_KM * (row.Eccentricity > 0 && row.Bearing === 90 ? 1 + row.Eccentricity : 1)

    row.Xcor = reach * Math.cos(((row.Bearing - 90) * Math.PI) / 180)
    row.Ycor = reach * Math.sin(((row.Bearing - 90) * Math.PI) / 180)
    rows[owner.id] = row
  })
  Object.values(rows).filter((row) => row.FixedBody > 0 && row.FixedBodyParentID > 0).forEach((row) => {
    row.Xcor = rows[row.FixedBodyParentID].Xcor
    row.Ycor = rows[row.FixedBodyParentID].Ycor
  })

  return rows
}

const OWNER_ROWS = ownerRows()

// A database of the loaders' tables with those bodies, a colony, a waypoint and a fleet on each and a Lagrange point on each of `pointOwners`, the motion switches given (null stores none), and the body table without one column (a save of another schema) when `without` names it.
const ownerDatabase = (switches, without = null, pointOwners = POINT_OWNERS) => {
  const columns = OWNER_COLUMNS.filter((name) => name !== without)
  const sql = (value) => (value === null || value === undefined ? 'null' : value)
  const bodyRow = (owner) => `insert into FCT_SystemBody (${columns.join(', ')}) values (${columns.map((name) => sql(OWNER_ROWS[owner.id][name])).join(', ')});`

  return databaseOf(`
    create table FCT_Game (GameID, GameTime, LastGrowthTime, OrbitalMotion, OrbitalMotionAst);
    create table FCT_Fleet (FleetID, GameID, RaceID, LastMoveTime, OrbitBodyID, Xcor, Ycor, AnchorFleetID);
    create table FCT_MoveOrders (FleetID, GameID);
    create table FCT_SystemBody (${columns.join(', ')});
    create table FCT_Star (StarID, GameID, Component, Xcor, Ycor);
    create table FCT_LagrangePoint (LagrangePointID, GameID, SystemID, PlanetID, Distance, Bearing, Xcor, Ycor);
    create table FCT_Population (PopulationID, GameID, SystemBodyID);
    create table FCT_RaceSysSurvey (GameID, RaceID, SystemID);
    create table FCT_Waypoint (WaypointID, GameID, RaceID, OrbitBodyID);
  `, `
    insert into FCT_Game values (1, 1000000, 900000, ${sql(switches[0])}, ${sql(switches[1])});
    insert into FCT_Star values (1, 1, 1, 0, 0);
    insert into FCT_RaceSysSurvey values (1, 2, 1);
    ${[...OWNERS, ...PARENT_ONLY].map(bodyRow).join('\n    ')}
    ${OWNERS.map((owner) => `insert into FCT_Population values (${70 + owner.id}, 1, ${owner.id}); insert into FCT_Waypoint values (${100 + owner.id}, 1, 2, ${owner.id}); insert into FCT_Fleet values (${300 + owner.id}, 1, 2, 950000, ${owner.id}, ${OWNER_ROWS[owner.id].Xcor}, ${OWNER_ROWS[owner.id].Ycor}, 0);`).join('\n    ')}
    ${pointOwners.map((owner) => `insert into FCT_LagrangePoint values (${90 + owner.id}, 1, 1, ${owner.id}, 0.1, 30, 1, 1);`).join('\n    ')}
    insert into FCT_Waypoint values (201, 1, 2, 0), (202, 1, 2, 99);
  `)
}

// ---- The oracle: the game's own position update, transcribed ---------------------------------------------------------
// Whether a body's saved position goes stale in one update of the game (UpdateOrbitalPositions), as the game orders the work, and the saved columns that answer reads. Nothing is updated with the planet and moon switch off. With it on, in this order: the primary list (planets and comets, and asteroids that are no trojan while the asteroid switch is on, none of them a fixed body) turns each body on its own orbit; every moon turns; every trojan takes its parent's bearing; every Lagrange point takes its planet's; every fixed body that has a fixed parent takes the parent's position; and the fleets and waypoints tied to a body take the body's. The game sets the fixed flag only on a class 3 body (the only writer is the creation of a deep-space population or location), so that flag is read for class 3 only.
const gameUpdate = (rows, id, planets, rocks) => {
  const reads = new Set()
  const read = (row, column) => {
    reads.add(column)

    return row[column]
  }
  const moved = (target, asteroids) => {
    const row = rows[target]
    const bodyClass = read(row, 'BodyClass')
    const fixed = bodyClass === 3 && read(row, 'FixedBody') > 0

    if (fixed && read(row, 'FixedBodyParentID') > 0) {
      return moved(row.FixedBodyParentID, asteroids)
    } else if (bodyClass === 2) {
      return true
    } else if (bodyClass === 3 && (read(row, 'TrojanAsteroid') || 0) !== 0) {
      return moved(read(row, 'ParentBodyID'), asteroids)
    } else if (bodyClass === 1 || bodyClass === 5) {
      return true
    }

    return bodyClass === 3 && !fixed && asteroids === 1
  }
  const outcomes = new Set()

  ;(planets === null ? [0, 1] : [planets]).forEach((planetSwitch) => {
    ;(rocks === null ? [0, 1] : [rocks]).forEach((rockSwitch) => {
      outcomes.add(planetSwitch === 0 ? false : moved(id, rockSwitch))
    })
  })

  return { value: outcomes.size === 1 ? [...outcomes][0] : null, reads }
}

// What the update does to a Lagrange point: the coordinate update sets a position only for a planet or a moon, so a point owned by anything else is never moved, whatever the switches say, and reads nothing of its owner but the class.
const pointUpdate = (rows, id, planets, rocks) => (LAGRANGE_OWNER_CLASSES.includes(rows[id].BodyClass) ? gameUpdate(rows, id, planets, rocks) : { value: false, reads: new Set(['BodyClass']) })

check('loader-motion-matrix', 'whether a place moves with the bodies follows the game\'s own position update for every place that derives a motion group from saved fields (a body, an order\'s destination of type 2 or, on a fixed body, type 15, a colony, a Lagrange point of a planet or a moon, a waypoint, a fleet orbiting a body) on every kind of body (planet, moon, comet, trojan, independent asteroid, a deep-space population at a gas giant, a deep-space location, fixed bodies of other parents), read by the real loaders from a save with every field and from saves lacking each of the fields the update reads, with each switch read on, read off or never read, against an oracle that transcribes the update', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const orbit = m['orbit-propagation']
  const at = { SystemID: 1, Xcor: 1, Ycor: 1 }
  const both = (planets, rocks) => (planets === 0 ? false : planets === 1 && rocks === 1 ? true : null)
  const VARIANTS = [
    { name: 'a save with every field', without: null },
    { name: 'a save with no trojan field', without: 'TrojanAsteroid' },
    { name: 'a save with no parent field', without: 'ParentBodyID' },
    { name: 'a save with no fixed field', without: 'FixedBody' },
    { name: 'a save with no fixed parent field', without: 'FixedBodyParentID' },
    { name: 'a save with no body class', without: 'BodyClass' },
  ]
  const SWITCHES = [1, 0, null]
  let cells = 0

  // What a place must read: the update's answer when every field it rests on was read, and what is not known (the planet switch off settling it) when one was not. A picked body with no orbit read has the picker's group alone, which names a planet, moon or comet and cannot tell an independent asteroid, a trojan and a fixed body apart.
  const expectedOf = (variant, place, planets, rocks) => {
    const update = (place.point ? pointUpdate : gameUpdate)(OWNER_ROWS, place.owner.id, planets, rocks)
    const orbitRead = !ORBIT_REQUIRED.includes(variant.without)

    if (place.source === 'picker' && !orbitRead) {
      return place.owner.row.BodyClass === 3 ? both(planets, rocks) : update.value
    } else if (place.source === 'orbit' && !orbitRead) {
      return both(planets, rocks)
    }

    return variant.without !== null && update.reads.has(variant.without) ? both(planets, rocks) : update.value
  }

  for (const variant of VARIANTS) {
    for (const planets of SWITCHES) {
      for (const rocks of SWITCHES) {
        const database = await ownerDatabase([planets, rocks], variant.without)
        const places = [
          ...OWNERS.flatMap((owner) => [
            { label: owner.name + ', picked', owner, source: 'picker', endpoint: { family: 'body', key: 'body:' + owner.id, id: owner.id, ...at, group: PICKER_GROUPS[owner.row.BodyClass] } },
            { label: owner.name + ', an order\'s destination', owner, source: 'orbit', endpoint: rp.orderEndpoint({ DestinationType: 2, DestinationID: owner.id, SystemID: 1, X: 1, Y: 1 }) },
            { label: 'a colony on the ' + owner.name, owner, source: 'orbit', endpoint: rp.orderEndpoint({ PopulationID: 70 + owner.id, SystemID: 1, X: 1, Y: 1 }) },
            { label: 'a waypoint on the ' + owner.name, owner, source: 'position', endpoint: rp.orderEndpoint({ DestinationType: 5, DestinationID: 100 + owner.id, SystemID: 1, X: 1, Y: 1 }) },
            { label: 'a fleet orbiting the ' + owner.name, owner, source: 'position', endpoint: { family: 'fleet', key: 'fleet:' + (300 + owner.id), id: 300 + owner.id, ...at } },
          ]),
          ...FIXED_OWNERS.map((owner) => ({ label: 'a type 15 order on the ' + owner.name, owner, source: 'orbit', endpoint: rp.orderEndpoint({ DestinationType: 15, DestinationID: owner.id, SystemID: 1, X: 1, Y: 1 }) })),
          ...POINT_OWNERS.map((owner) => ({ label: 'a Lagrange point of the ' + owner.name, owner, point: true, source: 'orbit', endpoint: rp.orderEndpoint({ DestinationType: 12, DestinationID: 90 + owner.id, SystemID: 1, X: 1, Y: 1 }) })),
        ]
        const read = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })
        const orbits = await orbit.loadOrbitFacts(database, { GameID: 1, RaceID: 2 }, places.map((place) => place.endpoint))
        const facts = { ...read, orbits }

        assert.deepEqual({ orbitalMotion: read.clock.orbitalMotion, orbitalMotionAst: read.clock.orbitalMotionAst }, { orbitalMotion: planets, orbitalMotionAst: rocks }, 'the loader read the switches the save stores')
        places.forEach((place) => {
          const [record] = rp.routePositions([place.endpoint], { facts }).records
          const expected = expectedOf(variant, place, planets, rocks)
          const label = variant.name + ', ' + place.label + ', planets ' + planets + ', asteroids ' + rocks

          cells += 1
          assert.equal(record.moves, expected, label + ': moves ' + expected)
          assert.equal(record.supported, true, label + ': the contract supports the place')
          assert.equal(record.conditions.includes('motion-switch'), expected === null, label + ': names the switch only when it is unknown')
        })

        const none = rp.routePositions([rp.orderEndpoint({ DestinationType: 5, DestinationID: 201, SystemID: 1, X: 1, Y: 1 })], { facts }).records[0]
        const missing = rp.routePositions([rp.orderEndpoint({ DestinationType: 5, DestinationID: 202, SystemID: 1, X: 1, Y: 1 })], { facts }).records[0]

        assert.equal(none.moves, false, variant.name + ': a waypoint on no body stays')
        assert.equal(missing.moves, both(planets, rocks), variant.name + ': a waypoint on a body the read does not hold is a kind not read')
        database.close()
      }
    }
  }

  assert.equal(cells, VARIANTS.length * SWITCHES.length * SWITCHES.length * (OWNERS.length * 5 + FIXED_OWNERS.length + POINT_OWNERS.length))

  // The motion group is the same wherever it is read: the position read's group of a waypoint and of a fleet and the orbit read's group of the body agree for every body, and are the group the update gives it.
  const database = await ownerDatabase([1, 0])
  const read = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })
  const orbits = await orbit.loadOrbitFacts(database, { GameID: 1, RaceID: 2 }, OWNERS.map((owner) => ({ family: 'body', id: owner.id })))

  OWNERS.forEach((owner) => {
    const groupOfUpdate = gameUpdate(OWNER_ROWS, owner.id, 1, 1).value ? (gameUpdate(OWNER_ROWS, owner.id, 1, 0).value ? 'planet' : 'asteroid') : 'static'

    assert.equal(read.waypoints[100 + owner.id].group, groupOfUpdate, owner.name + ': the position read groups the owner of a waypoint as the update moves it')
    assert.equal(read.fleets[300 + owner.id].group, groupOfUpdate, owner.name + ': and the body a fleet orbits')
    assert.equal(orbit.groupOf(orbits, { family: 'body', id: owner.id }), groupOfUpdate, owner.name + ': and so does the orbit read')
  })
  database.close()
})

check('fixed-body-order', 'a type 15 order (a deep space population, reached as the fixed class 3 body it stands on) is a body the contract knows and supports, and read by the real loaders a fixed body with no parent is supported and stays where it is saved on either basis, stating nothing, for every pair of switches, while one with a fixed parent moves as the update moves it and is held at its saved position with the reason it is not propagated', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const orbit = m['orbit-propagation']
  const order = (id, type = 15) => ({ DestinationType: type, DestinationID: id, PopulationID: 0, SystemID: 1, X: 1, Y: 1 })
  const SWITCHES = [1, 0, null]
  let cells = 0

  assert.ok(!rp.FAMILY_NAMES.includes('deep-space-population'), 'no family is kept for a deep space population: an order that reaches one names its body')
  ;[1, 2, 4, 5, 6, 7, 8, 10, 12, 14, 15].forEach((type) => assert.ok(rp.FAMILY_NAMES.includes(rp.orderEndpoint(order(9, type)).family), 'destination type ' + type + ': the family of an order is one the contract knows'))
  assert.equal(rp.orderEndpoint(order(9)).family, 'body')
  assert.equal(rp.orderEndpoint(order(9)).key, rp.orderEndpoint(order(9, 2)).key, 'a deep space population and a body are one place to the pages')

  for (const planets of SWITCHES) {
    for (const rocks of SWITCHES) {
      const database = await ownerDatabase([planets, rocks])
      const endpoints = FIXED_OWNERS.map((owner) => rp.orderEndpoint(order(owner.id)))
      const read = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })
      const orbits = await orbit.loadOrbitFacts(database, { GameID: 1, RaceID: 2 }, endpoints)
      const facts = { ...read, orbits }

      FIXED_OWNERS.forEach((owner, index) => {
        const expected = gameUpdate(OWNER_ROWS, owner.id, planets, rocks).value

        ;[['saved positions', rp.NO_ADAPTERS], ['propagation offered', rp.ADAPTERS]].forEach(([basis, adapters]) => {
          const positions = rp.routePositions([endpoints[index]], { facts, adapters })
          const [record] = positions.records
          const label = 'type 15 order on the ' + owner.name + ', ' + basis + ', planets ' + planets + ', asteroids ' + rocks

          cells += 1
          assert.equal(record.supported, true, label + ': supported')
          assert.equal(record.moves, expected, label + ': moves ' + expected)
          assert.equal(record.basis, 'static', label + ': stands on the saved position, as the app has no orbit for a fixed body')
          assert.equal(record.conditions.includes('motion-switch'), expected === null, label + ': names the switch only when it is unknown')
          assert.equal(record.conditions.includes('orbit-family'), basis === 'propagation offered' && expected !== false, label + ': is refused for its family only when it moves or may')

          if (expected === false) {
            assert.deepEqual(record.conditions, [], label + ': a body that stays states nothing')
            assert.equal(record.assumption, 'fixed', label + ': and is held as fixed')
            assert.deepEqual([positions.caveat, positions.moving, positions.mode, [...positions.unsupported]], [false, 0, 'static', []], label + ': and its summary carries no caveat')
          }
        })
      })
      database.close()
    }
  }
  assert.equal(cells, SWITCHES.length * SWITCHES.length * FIXED_OWNERS.length * 2)

  const location = FIXED_OWNERS.find((owner) => owner.row.FixedBodyParentID === undefined && !owner.row.TrojanAsteroid)

  SWITCHES.forEach((planets) => SWITCHES.forEach((rocks) => assert.equal(gameUpdate(OWNER_ROWS, location.id, planets, rocks).value, false, 'the oracle: a fixed body with no parent never moves, whatever the switches say')))
})

check('lagrange-owner-class', 'a Lagrange point whose owner is neither a planet nor a moon (a trojan, an independent asteroid, a comet, a fixed body) is never moved by the game\'s coordinate update, so read by the real loaders it stays where it is saved for every pair of switches, whatever its owner\'s other fields say, and is unknown only where the class itself was not read', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const orbit = m['orbit-propagation']
  const both = (planets, rocks) => (planets === 0 ? false : planets === 1 && rocks === 1 ? true : null)
  const VARIANTS = [
    { name: 'a save with every field', without: null },
    { name: 'a save with no fixed parent field', without: 'FixedBodyParentID' },
    { name: 'a save with no trojan field', without: 'TrojanAsteroid' },
    { name: 'a save with no body class', without: 'BodyClass' },
  ]
  const SWITCHES = [1, 0, null]
  let cells = 0

  assert.ok(MALFORMED_POINT_OWNERS.length > 0 && MALFORMED_POINT_OWNERS.every((owner) => !POINT_OWNERS.includes(owner)), 'the owners that are neither a planet nor a moon are the ones the matrix leaves out')
  for (const variant of VARIANTS) {
    for (const planets of SWITCHES) {
      for (const rocks of SWITCHES) {
        const database = await ownerDatabase([planets, rocks], variant.without, MALFORMED_POINT_OWNERS)
        const points = MALFORMED_POINT_OWNERS.map((owner) => ({ owner, endpoint: rp.orderEndpoint({ DestinationType: 12, DestinationID: 90 + owner.id, SystemID: 1, X: 1, Y: 1 }) }))
        const read = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })
        const orbits = await orbit.loadOrbitFacts(database, { GameID: 1, RaceID: 2 }, points.map((point) => point.endpoint))

        points.forEach(({ owner, endpoint }) => {
          const facts = { ...read, orbits }
          const [record] = rp.routePositions([endpoint], { facts }).records
          const [offered] = rp.routePositions([endpoint], { facts, adapters: rp.ADAPTERS }).records
          const expected = ORBIT_REQUIRED.includes(variant.without) ? both(planets, rocks) : pointUpdate(OWNER_ROWS, owner.id, planets, rocks).value
          const label = variant.name + ', a Lagrange point of the ' + owner.name + ', planets ' + planets + ', asteroids ' + rocks
          const saved = { SystemID: endpoint.SystemID, Xcor: endpoint.Xcor, Ycor: endpoint.Ycor }

          cells += 1
          assert.equal(record.moves, expected, label + ': moves ' + expected)
          assert.equal(record.conditions.includes('motion-switch'), expected === null, label + ': names the switch only when it is unknown')
          ;[[record, 'on saved positions'], [offered, 'with propagation offered']].forEach(([one, basis]) => {
            assert.equal(one.supported, true, label + ', ' + basis + ': supported')
            assert.equal(one.basis, 'static', label + ', ' + basis + ': stands on the saved position')
            assert.deepEqual(one.position, saved, label + ', ' + basis + ': at the saved coordinates')
            assert.equal(one.moves, expected, label + ', ' + basis + ': moves ' + expected)

            if (expected === false) {
              assert.deepEqual(one.conditions, [], label + ', ' + basis + ': a point that stays states nothing')
              assert.equal(one.assumption, 'fixed', label + ', ' + basis + ': and is held as fixed')
            }
          })
          assert.deepEqual(rp.ADAPTERS['lagrange-point'](endpoint, { facts, at: read.clock.gameTime + 1 }).reasons, [ORBIT_REQUIRED.includes(variant.without) ? 'orbit-missing' : 'orbit-family'], label + ': the adapter refuses to propagate it, for its owner\'s family where the point is read and as not found where the save lacks the columns that read it')
        })
        database.close()
      }
    }
  }
  assert.equal(cells, VARIANTS.length * SWITCHES.length * SWITCHES.length * MALFORMED_POINT_OWNERS.length)
})

check('fixed-proxy-results', 'a deep-space population at a gas giant (a fixed class 3 body that takes its parent\'s position whatever the asteroid switch says), its colony, a waypoint on it and a fleet orbiting it move with the planet switch: with planets on and asteroids off a saved distance to each is an estimate, the body and the colony are refused for the family they are with their reason, and a Route Finder plan from each to a propagated comet is mixed; a deep-space location and a fixed body of an independent asteroid stay where they are saved and state nothing', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const orbit = m['orbit-propagation']
  const plan = m['route-plan']
  const page = await w.routes()
  const graph = m['jump-graph']
  const searchOptions = { order: 'jumps' }

  for (const switches of [[1, 0], [1, 1], [1, null], [0, 1], [null, 0]]) {
    const database = await ownerDatabase(switches)
    const read = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })
    const stopsOf = (id) => {
      const row = OWNER_ROWS[id]
      const near = { SystemID: 1, Xcor: row.Xcor, Ycor: row.Ycor }

      return { body: { ...near, kind: 'body', key: 'body:' + id, name: 'Body ' + id, group: 'asteroid' }, colony: { ...near, kind: 'colony', key: 'colony:' + (70 + id), name: 'Colony ' + id }, waypoint: { ...near, kind: 'waypoint', key: 'waypoint:' + (100 + id), name: 'Waypoint ' + id }, fleet: { ...near, kind: 'fleet', key: 'fleet:' + (300 + id), name: 'Fleet ' + id } }
    }
    const comet = { SystemID: 1, Xcor: OWNER_ROWS[5].Xcor, Ycor: OWNER_ROWS[5].Ycor, kind: 'body', key: 'body:5', name: 'Comet', group: 'comet' }
    const centre = { kind: 'system', key: 'system:1', name: 'Centre', SystemID: 1, Xcor: 0, Ycor: 0 }
    const orbits = await orbit.loadOrbitFacts(database, { GameID: 1, RaceID: 2 }, [...[10, 13, 14, 5].flatMap((id) => Object.values(stopsOf(id)).filter((stop) => ['body', 'colony'].includes(stop.kind)).map(rp.placeEndpoint))])
    const facts = { ...read, orbits }
    const make = (stop) => {
      const stops = [stop, comet]
      const found = graph.searchRoutes([], [stops[0]], searchOptions)

      return instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: read, orbitFacts: orbits, plannedStops: stops, stopKeys: stops.map((one) => one.key), placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])), extra: {}, lazyState: {}, legNotes: {}, systemNameOf: (id) => 'System ' + id, pointName: () => 'a point', lagrangeName: () => 'a Lagrange point', jumpPoints: [], lagrangePoints: [], cycle: false, searchOptions, speedResult: { ...SPEED, value: 1500 }, origin: stops[0], routes: found, openRoutes: found, avoidDetails: {}, systems: [{ SystemID: 1, Name: 'One' }] } })
    }
    const planetsOn = switches[0] === 1
    const exact = (id) => gameUpdate(OWNER_ROWS, id, switches[0], switches[1]).value

    for (const [id, name] of [[10, 'a deep-space population at a gas giant'], [13, 'a deep-space location'], [14, 'a fixed body of an independent asteroid']]) {
      Object.values(stopsOf(id)).forEach((stop) => {
        const label = name + ', ' + stop.kind + ', switches ' + switches
        const [record] = rp.routePositions([rp.placeEndpoint(stop)], { facts, adapters: rp.ADAPTERS }).records
        const km = plan.planResults(plan.planRoute([centre, stop], { cycle: false, jumpPoints: [], facts })).km

        assert.equal(record.moves, exact(id), label + ': moves ' + exact(id))
        assert.equal(km.status, exact(id) === false ? 'confirmed' : 'estimated', label + ': a saved distance to it is ' + (exact(id) === false ? 'confirmed' : 'an estimate'))
        if (planetsOn && switches[1] === 0) {
          const vm = make(stop)

          const own = recordOf(vm.plan.positions, stop.key)

          assert.equal(own.moves, id === 10, label + ': the plan states whether it moves')
          assert.equal(own.basis, 'static', label + ': and stands on the saved position')
          assert.equal(own.conditions.includes('orbit-family'), id === 10 && ['body', 'colony'].includes(stop.kind), label + ': the body and the colony of the one that moves are refused for the family they are in, never taken for stationary')
          assert.equal(recordOf(vm.plan.positions, 'body:5').basis, 'propagated', label + ': the comet is worked out')
          assert.equal(vm.plan.positions.mode, id === 10 ? 'mixed' : 'propagated', label + ': a plan from it to the comet reads ' + (id === 10 ? 'mixed' : 'propagated'))
        }
      })
    }
    database.close()
  }
})

check('waypoint-owner-results', 'a waypoint on a trojan of a moving planet stays an estimate with the asteroid switch off, as the waypoint on the planet is, and a Route Finder plan from it to a planet worked out is stated mixed, while the waypoint on an independent asteroid stays where it is saved and states nothing', async (w) => {
  const m = await w.modules()
  const rp = m['route-position']
  const orbit = m['orbit-propagation']
  const plan = m['route-plan']
  const page = await w.routes()
  const graph = m['jump-graph']
  const database = await ownerDatabase([1, 0])
  const read = await rp.loadPositionFacts(database, { GameID: 1, RaceID: 2 })
  const waypointStop = (id) => stop('waypoint', id, { Xcor: id * 1000, Ycor: 0 })
  const orbits = await orbit.loadOrbitFacts(database, { GameID: 1, RaceID: 2 }, [1, 5].map((id) => ({ family: 'body', id })))
  const bodyStop = (id) => stop('body', id, { Xcor: orbits.bodies[id].xcor, Ycor: orbits.bodies[id].ycor, group: PICKER_GROUPS[OWNERS[id - 1].row.BodyClass] })
  const facts = { ...read, orbits }
  const km = (stops) => plan.planResults(plan.planRoute(stops, { cycle: false, jumpPoints: LINKS, facts })).km

  // The distance between two places that stay where they are saved is confirmed; one end that moves makes it an estimate.
  assert.equal(km([waypointStop(201), waypointStop(104)]).status, 'confirmed', 'a waypoint on an independent asteroid, held with the asteroid switch off, and one on no body: both stay')
  assert.equal(km([waypointStop(201), waypointStop(103)]).status, 'estimated', 'a waypoint on a trojan moves with its planet whatever the asteroid switch says')
  assert.equal(km([waypointStop(201), waypointStop(101)]).status, 'estimated', 'as the waypoint on the planet does')
  assert.equal(km([waypointStop(201), waypointStop(107)]).status, 'confirmed', 'a waypoint on the trojan of an independent asteroid stays with it while the asteroid is held')
  assert.equal(km([waypointStop(201), waypointStop(109)]).status, 'estimated', 'a trojan held fixed is still moved with its parent, as the update does not leave it out')
  assert.equal(km([waypointStop(201), waypointStop(202)]).status, 'estimated', 'a waypoint on a body the read does not hold is not said to stay')

  const searchOptions = { order: 'jumps' }
  const make = (waypointId) => {
    const stops = [bodyStop(1), waypointStop(waypointId), bodyStop(5)]
    const found = graph.searchRoutes([], [stops[0]], searchOptions)

    return instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: read, orbitFacts: orbits, plannedStops: stops, stopKeys: stops.map((one) => one.key), placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])), extra: {}, lazyState: {}, legNotes: {}, systemNameOf: (id) => 'System ' + id, pointName: () => 'a point', lagrangeName: () => 'a Lagrange point', jumpPoints: [], lagrangePoints: [], cycle: false, searchOptions, speedResult: { ...SPEED, value: 1500 }, origin: stops[0], routes: found, openRoutes: found, avoidDetails: {}, systems: [{ SystemID: 1, Name: 'One' }] } })
  }

  // A plan from the planet, by a waypoint, to a comet worked out on its own: a waypoint that moves is a saved position beside it, so the plan is mixed; one that stays adds nothing to the mode.
  ;[[101, 'mixed', 'a waypoint on the planet'], [103, 'mixed', 'a waypoint on the trojan of the planet'], [104, 'propagated', 'a waypoint on an independent asteroid'], [109, 'mixed', 'a waypoint on a trojan held fixed'], [201, 'propagated', 'a waypoint on no body']].forEach(([id, mode, name]) => {
    const vm = make(id)

    assert.equal(recordOf(vm.plan.positions, 'body:5').basis, 'propagated', name + ': the comet is worked out')
    assert.equal(vm.plan.positions.mode, mode, name + ': the plan reads ' + mode + ' with the asteroid switch off')
  })
  database.close()
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
      assert.equal(strip.events?.retry?.value, 'retryPosition', `${name}: the strip retries the read`)
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

// Two routes to one destination of one distance and one jump, by other jump points: found routes, as the search leaves them.
const ROUTE_BY = (destination, km, gates) => {
  const out = { kind: 'fly', at: { WarpPointID: gates[0].out, SystemID: 1, Xcor: gates[0].x, Ycor: gates[0].y }, previous: null, origin: { SystemID: 1, Xcor: 10, Ycor: 5 }, legKm: 1, via: null }
  const jump = { kind: 'jump', at: { WarpPointID: gates[0].in, SystemID: destination.SystemID, Xcor: gates[0].x + 7, Ycor: gates[0].y + 7 }, previous: out }

  return { km, jumps: 1, end: { kind: 'fly', at: destination, previous: jump, legKm: 1, via: null } }
}

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

check('pages-routes-mixed', 'Route Finder states what every leg states: a return leg that crosses the horizon of an orbit the first leg left in its range gives a running distance and time that name the horizon, and a plan flown on the moved bodies beside a table row of saved distances is not stated as wholly flown', async (w) => {
  const page = await w.routes()
  const modules = await w.modules()
  const graph = modules['jump-graph']
  const rp = modules['route-position']
  const AU = 149600000
  const rock = (id, distance, bearing, year, extra = {}) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180), ...extra })
  const factsOf = (rocks) => ({ bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] })
  const stopOf = (one) => stop('body', one.id, { Xcor: one.xcor, Ycor: one.ycor })
  const searchOptions = { order: 'jumps' }
  const make = (rocks, { links, cycle }) => {
    const stops = rocks.map(stopOf)
    const [first] = stops
    const found = graph.searchRoutes(links, [first], searchOptions)

    return instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts: factsOf(rocks), plannedStops: stops, stopKeys: stops.map((one) => one.key), placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])), extra: {}, lazyState: {}, legNotes: {}, systemNameOf: (id) => 'System ' + id, pointName: () => 'a point', lagrangeName: () => 'a Lagrange point', jumpPoints: links, lagrangePoints: [], cycle, searchOptions, speedResult: { ...SPEED, value: 1500 }, origin: first, routes: found, openRoutes: found, avoidDetails: {}, systems: [{ SystemID: 1, Name: 'One' }, { SystemID: 2, Name: 'Two' }] } })
  }

  const eccentric = rock(1, 1, 90, 6000, { bodyClass: 1, eccentricity: 0.2, xcor: 1.2 * AU, ycor: 0 })
  const far = rock(2, 150, 90, 16100000)
  const back = make([eccentric, far], { links: [], cycle: true })
  const [out, home] = back.plan.legs

  assert.equal(out.positions.mode, 'propagated', 'the first leg flies on the moved bodies')
  assert.ok(home.positions.conditions.some((one) => one.code === 'orbit-horizon'), 'the return leg arrives past the horizon of the eccentric orbit')
  assert.ok(!out.positions.conditions.some((one) => one.code === 'orbit-horizon'), 'the first leg does not')
  assert.ok(back.plan.positions.conditions.some((one) => one.code === 'orbit-horizon'), 'the plan names the horizon')

  const returning = back.detailRows.filter((row) => row.leg === 1 && row.km !== null)

  assert.ok(returning.length > 0, 'the return leg flies a distance')
  returning.forEach((row) => {
    assert.ok(row.totalResult.inputs.missing.includes(rp.CONDITIONS['orbit-horizon']), 'the running distance names the horizon')
    assert.ok(row.timeResult.inputs.missing.includes(rp.CONDITIONS['orbit-horizon']), 'the running time names the horizon')
    statesPositions(row.totalResult, back.plan.positions, 'the running distance, over the legs flown so far')
    statesPositions(row.timeResult, back.plan.positions, 'the running time')
  })

  // A body arrived at flown and arrived at again beyond its horizon is stated on the saved position in the running totals of the legs after.
  const twice = make([far, eccentric, far, eccentric], { links: [], cycle: false })
  const met = twice.plan.positions.records.find((record) => record.identity.key === 'body:1')
  const late = twice.detailRows.filter((row) => row.leg === 2 && row.km !== null)

  assert.equal(met.basis, 'static', 'the body stands on the saved position in the plan once a later arrival fell back')
  assert.ok(met.conditions.includes('orbit-horizon'), 'and names the horizon')
  assert.ok(late.length > 0, 'the last leg flies a distance')
  late.forEach((row) => {
    assert.ok(row.totalResult.inputs.missing.includes(rp.CONDITIONS['orbit-horizon']), 'the running distance names the horizon')
    assert.ok(row.timeResult.inputs.missing.includes(rp.CONDITIONS['orbit-horizon']), 'the running time names the horizon')
  })

  const near = rock(1, 1, 90, 8760)
  const next = rock(2, 2, 0, 17520)
  const there = make([near, next], { links: LINKS, cycle: false })
  const [row] = there.distanceRows.filter((one) => one.SystemID === 2)

  assert.equal(there.plan.positions.mode, 'propagated', 'the plan flies on the moved bodies')
  assert.ok(row.route && row.route.km > 0, 'a system is listed at a distance from the first stop')
  assert.equal(there.shownPositions.mode, 'mixed', 'the strip says both while a row of the table stands on the saved position')

  const firstStop = there.shownPositions.records.filter((record) => record.identity.key === 'body:1')

  assert.deepEqual(firstStop.map((record) => record.basis), ['static'], 'the first stop, left from and never arrived at, is the saved one the table measures from')
  assert.equal(there.shownPositions.records.find((record) => record.identity.key === 'body:2').basis, 'propagated', 'and the stop that is arrived at is flown')

  const view = instantiate(await w.component(), { $store: STORE, data: { positions: there.shownPositions, state: { loading: false, failed: '', error: '' } } })

  assert.deepEqual(view.groups.map((group) => group.assumption).sort(), ['body-held', 'propagated'], 'and the strip shows both assumption groups')

  // A plan that comes back to its first stop arrives at it, and the table still measures from the saved one: both stay.
  const round = make([near, next], { links: LINKS, cycle: true })
  const first = round.shownPositions.records.filter((record) => record.identity.key === 'body:1')

  assert.deepEqual(first.map((record) => record.basis).sort(), ['propagated', 'static'], 'the first stop is stated as flown and as saved, neither replacing the other')
  assert.equal(round.shownPositions.mode, 'mixed')
})

const HAULER = (extra = {}) => ({ ShipID: 1, ShipName: 'Hauler', FleetID: 5, FleetName: 'Convoy', ClassName: 'Freighter', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: 1000, EnginePower: 20, UndamagedEnginePower: 20, OverhaulFactor: 1, GradePoints: 100, CrewMorale: 1, SensorDelay: 0, FuelEfficiency: 0.5, FuelCapacity: 1e9, Fuel: 1e9, MaintenanceState: 0, MothershipID: 0, TractorTargetShipID: 0, TractorParentShipID: 0, TractorTargetShipyardID: 0, TowedSize: null, TowedTargetShipID: null, CarrierMothershipID: null, CarrierFleetID: null, ShuttleTechnology: 1.5, MilitaryEngines: 0, Drive: 0, AnyDrive: 0, FleetSpeed: 1000, UseMaximumSpeed: 1, ...extra })

const COLONY = (extra = {}) => ({ PopName: 'Mars', PopulationID: 7, SystemID: 1, Xcor: 10, Ycor: 5, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra })

const FULL_OFFICERS = { mode: 'loaded', withheld: null, gaps: { commander: null, admin: null, governor: null, sector: null }, commanders: {}, governors: {}, sectors: {}, admins: {} }

check('pages-routes-matrix', 'Every distance, time, caption and strip of Route Finder agrees with how it was computed, in every scenario: no speed known, every arrival refused, a plan wholly flown, one flown beside a table of saved distances, a cycle and no read', async (w) => {
  const page = await w.routes()
  const modules = await w.modules()
  const graph = modules['jump-graph']
  const rp = modules['route-position']
  const component = await w.component()
  const AU = 149600000
  const rock = (id, distance, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rocks = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const orbits = { bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const stops = rocks.map((one) => stop('body', one.id, { Xcor: one.xcor, Ycor: one.ycor }))
  const claims = (result) => Boolean(result) && result.assumptions.includes(rp.ASSUMPTIONS.propagated)
  const groupsOf = (positions) => [...new Set(instantiate(component, { $store: STORE, data: { positions, state: { loading: false, failed: '', error: '' } } }).groups.map((group) => group.assumption))].sort()
  const known = (value) => (value === null ? { status: 'unavailable', value: null, rule: { id: 'route.speed' }, inputs: { present: [], missing: ['a speed'] }, assumptions: [], units: 'km/s' } : { ...SPEED, value })
  const make = ({ speed, links, cycle, read = true }) => {
    const found = graph.searchRoutes(links, [stops[0]], { order: 'jumps' })

    return instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(read ? null : undefined), positionFacts: read ? FACTS : undefined, orbitFacts: read ? orbits : undefined, plannedStops: stops, stopKeys: stops.map((one) => one.key), placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])), extra: {}, lazyState: {}, legNotes: {}, systemNameOf: (id) => 'System ' + id, pointName: () => 'a point', lagrangeName: () => 'a Lagrange point', jumpPoints: links, lagrangePoints: [], cycle, searchOptions: { order: 'jumps' }, speedResult: known(speed), origin: stops[0], routes: found, openRoutes: found, avoidDetails: {}, systems: [{ SystemID: 1, Name: 'One' }, { SystemID: 2, Name: 'Two' }] } })
  }

  // What each scenario must read: the plan's own strip and the page's strip (the plan with the table's saved positions), the groups the strip shows, and whether any time or distance claims a position worked out.
  const SCENARIOS = [
    { name: 'no speed known', speed: null, links: LINKS, cycle: false, plan: 'static', shown: 'static', groups: ['body-held'], flown: false },
    { name: 'a speed of 1 km/s, no arrival worked out', speed: 1, links: LINKS, cycle: false, plan: 'static', shown: 'static', groups: ['body-held'], flown: false },
    { name: 'a speed of 10 km/s, no arrival worked out', speed: 10, links: LINKS, cycle: false, plan: 'static', shown: 'static', groups: ['body-held'], flown: false },
    { name: 'a speed of 10 km/s, a cycle', speed: 10, links: [], cycle: true, plan: 'static', shown: 'static', groups: ['body-held'], flown: false },
    { name: 'a plan wholly flown, the table of the first system beside it', speed: 1500, links: [], cycle: false, plan: 'propagated', shown: 'mixed', groups: ['body-held', 'propagated'], flown: true },
    { name: 'a plan flown beside a table of saved distances', speed: 1500, links: LINKS, cycle: false, plan: 'propagated', shown: 'mixed', groups: ['body-held', 'propagated'], flown: true },
    { name: 'a cycle flown', speed: 1500, links: [], cycle: true, plan: 'propagated', shown: 'mixed', groups: ['body-held', 'propagated'], flown: true },
    { name: 'no read', speed: 1500, links: [], cycle: false, read: false, plan: 'static', shown: 'static', groups: ['body-held'], flown: false },
  ]

  SCENARIOS.forEach((scenario) => {
    const vm = make(scenario)
    const label = 'Route Finder, ' + scenario.name

    assert.equal(vm.plan.positions.mode, scenario.plan, label + ': the plan reads ' + scenario.plan)
    assert.equal(vm.shownPositions.mode, scenario.shown, label + ': the strip reads ' + scenario.shown)
    assert.deepEqual(groupsOf(vm.shownPositions), scenario.groups, label + ': and shows its assumption groups')
    vm.plan.legs.forEach((leg) => assert.equal(Boolean(leg.positions) && leg.positions.mode === 'propagated', scenario.flown, label + ': a leg reads propagated only when it is flown'))
    vm.detailRows.forEach((row) => {
      if (row.km !== null && row.km > 0) {
        assert.equal(claims(row.timeResult), scenario.flown, label + ': the running time claims positions worked out only when flown')
        assert.equal(claims(row.totalResult), scenario.flown, label + ': the running distance claims them only when flown')
      }
    })
  })
})

check('pages-disabled-asteroid', 'a stationary asteroid (its own switch read off) is held at its saved position without a propagated claim or an orbital-speed refusal, and a moving planet on the same round trip keeps its propagated year', async (w) => {
  const page = await w.transport()
  const modules = await w.modules()
  const graph = modules['jump-graph']
  const rp = modules['route-position']
  const AU = 149600000
  const asteroid = Object.freeze({ id: 1, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance: 1.8, bearing: 38, year: 22000, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 1.8 * AU * Math.cos(((38 - 90) * Math.PI) / 180), ycor: 1.8 * AU * Math.sin(((38 - 90) * Math.PI) / 180) })
  const planet = Object.freeze({ id: 2, systemId: 1, starId: 1, bodyClass: 1, trojan: 0, distance: 3.1, bearing: 90, year: 400000, eccentricity: 0.1, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: 3.1 * 1.1 * AU, ycor: 0 })
  const orbitsOf = (bodies) => ({ bodies: Object.fromEntries(bodies.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: { 7: 1, 8: 2 }, problems: [] })
  const place = (id, body) => ({ kind: 'colony', key: 'colony:' + id, name: 'Colony ' + id, colony: COLONY({ PopulationID: id, Xcor: body.xcor, Ycor: body.ycor }), SystemID: 1, Xcor: body.xcor, Ycor: body.ycor })
  const facts = { ...FACTS, clock: { ...CLOCK, orbitalMotion: 1, orbitalMotionAst: 0 } }

  // Two stationary asteroids, flown fast and flown below the orbital speed: nothing is worked out and nothing is refused.
  const other = Object.freeze({ ...asteroid, id: 2, distance: 3.1, bearing: 198, year: 40000, xcor: 3.1 * AU * Math.cos(((198 - 90) * Math.PI) / 180), ycor: 3.1 * AU * Math.sin(((198 - 90) * Math.PI) / 180) })

  ;[900, 10].forEach((speed) => {
    const origin = place(7, asteroid)
    const destination = place(8, other)
    const reach = { route: graph.searchRoutes([], [origin]).toPlace(destination), open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
    const ship = HAULER({ MaxSpeed: speed, FleetSpeed: speed, EnginePower: speed / 50, UndamagedEnginePower: speed / 50, UseMaximumSpeed: 0 })
    const vm = instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: facts, orbitFacts: orbitsOf([asteroid, other]), handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin, destination, reachOf: () => reach, fleetShips: [ship] } })

    assert.equal(vm.fleetRuns.length, 1, speed + ' km/s: the fleet is timed')
    vm.fleetRuns.forEach((run) => {
      assert.equal(run.simulation.annual.status, 'static', speed + ' km/s: the year of stationary asteroids is static')
      assert.deepEqual(run.simulation.annual.reasons, [], speed + ' km/s: with no refusal')
      assert.equal(run.propagation, null, speed + ' km/s: and no comparison caption')
    })
    assert.equal(vm.endpointPositions.mode, 'static')
    assert.ok(!vm.endpointPositions.conditions.some((one) => one.code === 'fleet-slower' || one.code === 'motion-switch'), speed + ' km/s: the strip names neither the speed nor the switch')
  })

  // A round trip between a stationary asteroid and a moving planet slower than the planet's neighbours keeps the planet's propagation.
  const origin = place(7, asteroid)
  const destination = place(8, planet)
  const reach = { route: graph.searchRoutes([], [origin]).toPlace(destination), open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
  const ship = HAULER({ MaxSpeed: 20, FleetSpeed: 20, EnginePower: 0.4, UndamagedEnginePower: 0.4, UseMaximumSpeed: 0 })
  const vm = instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: facts, orbitFacts: orbitsOf([asteroid, planet]), handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin, destination, reachOf: () => reach, fleetShips: [ship] } })
  const moved = rp.positionRecord(rp.placeEndpoint(destination), { facts: { ...facts, orbits: orbitsOf([asteroid, planet]) }, adapters: rp.ADAPTERS, from: rp.placeEndpoint(origin), speed: 20 })

  assert.equal(moved.basis, 'propagated', 'the planet is worked out on its own')
  assert.equal(vm.fleetRuns.length, 1, 'the fleet is timed')
  vm.fleetRuns.forEach((run) => {
    assert.equal(run.simulation.annual.status, 'propagated', 'the year keeps the planet\'s arrival')
    assert.ok(!run.simulation.annual.reasons.includes('fleet-slower') && !run.simulation.annual.reasons.includes('motion-switch'), 'the stationary asteroid refuses nothing')
    assert.ok(run.simulation.annual.meanKm !== run.simulation.static.km.reduce((sum, value) => sum + value, 0) / 2, 'and the mean is the propagated one, not the saved')
    assert.equal(run.simulation.first.positions.mode, 'propagated')
  })
})

// The refuelling sites and fuel reserves of a save with no colony or tanker fleet that serves and no fuel kept back, read: a run is decided by the tanks alone.
const NO_SITES = { gameTime: 1, hubEra: 0, rates: { MaxRefuellingRate: 80000, UnderwayReplenishmentRate: 0 }, colonies: [], fleets: [] }
const NO_RESERVES = { ready: true, reader: { colony: () => null, ship: () => null } }

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
  const make = (facts, data = {}, database = null) => instantiate(page, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(facts ? null : undefined), positionFacts: facts, handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: here, destination: there, reachOf: () => reach, fuelSites: NO_SITES, fuelReserveRead: NO_RESERVES, fleetShips: [HAULER({ FleetSpeed: 300, UseMaximumSpeed: 0 })], ...data } })
  const group = { FleetID: 5, FleetName: 'Convoy', civilian: false }
  const shipClass = { ShipClassID: 1, ClassName: 'Freighter', ships: [HAULER()] }
  const ends = { origin: transport.colonyEndpoint(COLONY()), destination: transport.colonyEndpoint(COLONY({ PopulationID: 8, ShuttleCapacity: 0 })) }
  const vm = make(UNSURE)

  // A simulation of a run is kept under the path it flies: the same path again is the one kept, and another path of the same distance and jump count is worked out afresh, as it would be with nothing kept.
  const database = w.caches.transport().cacheQueries({ query: async () => [[]] })
  const kept = make(UNSURE, {}, database)
  const viaA = { ...reach, route: ROUTE_BY(there, route.km, [{ out: 1, in: 2, x: 100, y: 0 }]) }
  const viaB = { ...reach, route: ROUTE_BY(there, route.km, [{ out: 3, in: 4, x: 900, y: 400 }]) }
  const trip = { handlingSeconds: 0, stops: [], service: { origin: 0, destination: 0 } }
  const flownA = kept.simulate(viaA, 1000, trip)

  assert.ok(flownA, 'the run is simulated')
  assert.equal(kept.simulate(viaA, 1000, trip), flownA, 'the same path is kept')
  assert.notEqual(kept.simulate(viaB, 1000, trip), flownA, 'another path is not the one kept')
  assert.deepEqual(asJson(kept.simulate(viaB, 1000, trip)), asJson(vm.simulate(viaB, 1000, trip)), 'and is what it is with nothing kept')
  assert.notDeepEqual(asJson(vm.simulate(viaA, 1000, trip)), asJson(vm.simulate(viaB, 1000, trip)), 'the two paths are not one flight')

  // A cycle whose elapsed time is a range (a wait for the jump shock) is not moved on to arrival instants: Transport hands its walk to the cycles and the year states the saved positions.
  const shocked = { total: { lo: 1, hi: 2 }, wait: { lo: 5, hi: 9 }, events: [] }
  const timedA = vm.simulate(viaA, 1000, { ...trip, cycle: shocked })

  assert.ok(!flownA.annual.reasons.includes('timed-clock'), 'a cycle with no walk is the flight alone')
  assert.equal(timedA.annual.status, 'static', 'a cycle with a wait keeps the saved positions')
  assert.ok(timedA.annual.reasons.includes('timed-clock'), 'and says the clock is the reason')
  assert.deepEqual(asJson(vm.simulate(viaA, 1000, { ...trip, cycle: { ...shocked, wait: { lo: 0, hi: 0 } } })), asJson(vm.simulate(viaA, 1000, trip)), 'a walk with no wait and no flights is the flight alone again')

  // A round trip whose flights on the saved positions run the shock down is flown on the moved bodies. When they bring its ends nearer, so that the flights no longer run the shock down, the round trip is simulated again on the walk that waits: it keeps the saved positions and the trip it has on them.
  const farHere = place('colony', 7, { Xcor: -20 * KM, Ycor: 0 })
  const farThere = place('fleet', 7, { SystemID: 2, Xcor: 20 * KM, Ycor: 0 })
  const farReach = { ...reach, route: modules['jump-graph'].searchRoutes(LINKS, [{ SystemID: 1, Xcor: -20 * KM, Ycor: 0 }], { order: 'jumps' }).toPlace(farThere) }
  const farPositions = rp.routePositions([rp.placeEndpoint(farHere), rp.placeEndpoint(farThere)], { facts: UNSURE })
  const runWith = (simulate) => make(UNSURE, { origin: farHere, destination: farThere, reachOf: () => farReach, simulate }).fleetRuns[0]
  const savedRun = runWith(() => null)
  const tripCycles = []
  const nearerRun = runWith((_reach, _speed, flownTrip) => {
    tripCycles.push(flownTrip.cycle)

    return { annual: flownTrip.cycle.wait.hi > 0 ? { status: 'static', compared: true, reasons: ['timed-clock'], positions: farPositions } : { status: 'propagated', compared: true, reasons: [], flights: [[1000, 1000], [1000, 1000]], meanKm: 2000, positions: farPositions } }
  })

  assert.equal(savedRun.status, 'ok', 'the round trip across the jump works')
  assert.deepEqual(tripCycles.map((cycle) => cycle.wait.hi > 0), [false, true], 'the round trip is simulated again on the walk the moved bodies give it, which waits')
  assert.deepEqual([nearerRun.tripSeconds, nearerRun.trips, nearerRun.km], [savedRun.tripSeconds, savedRun.trips, savedRun.km], 'and keeps the trip it has on the saved positions')
  assert.equal(nearerRun.propagation.moved, false, 'and says the saved positions stand')

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
  const FIGURES = { trips: ['trips/yr', (row) => row.trips], tonsYear: ['t/yr', (row) => row.tonsYear], colonistsYear: ['colonists/yr', (row) => row.colonistsYear], fuel: ['L', (row) => row.fuel], fuelShare: ['%', (row) => row.fuelShare * 100], fuelReturn: ['%', (row) => row.returnShare * 100] }
  const TABLES = [
    ['fleetRuns', run, waitingRun, { trips: 'transport.fleetTrip', tonsYear: 'transport.fleetTrip', colonistsYear: 'transport.fleetTrip', fuel: 'transport.fleetBurn', fuelShare: 'transport.fleetBurn', fuelReturn: 'fuelService.ledger' }],
    ['rows', classRun, waitingClass, { trips: 'transport.freightPerYear', tonsYear: 'transport.freightPerYear', colonistsYear: 'transport.freightPerYear', fuel: 'transport.fuelPerTrip', fuelShare: 'transport.fuelPerTrip' }],
  ]

  TABLES.forEach(([table, known, unread, rules]) => {
    const marks = ['item.trips', 'item.tonsYear', 'item.colonistsYear', 'item.fuel'].flatMap((name) => slotsOf(pageNodes, name).filter((one) => attrOf(one.parent, 'items') === table).flatMap(marksIn))
    const fields = marks.map((mark) => (/^item\.results\.(\w+)$/.exec(resultOf(mark) || '') || [])[1])

    assert.ok(known.results && unread.results, `${table}: a run that works has a result for each yearly and fuel figure`)
    marks.forEach((mark) => assert.equal(attrOf(mark, 'rule'), undefined, `${table}: a mark is a result of the row, not the rule alone`))
    assert.deepEqual([...fields].sort(), Object.keys(rules).sort(), `${table}: each yearly and fuel figure has one mark of the row's result`)
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
  const savedEnds = rp.routePositions([rp.placeEndpoint(here), rp.placeEndpoint(there), ...rp.viaEndpoints(route)], { facts: UNSURE })
  const strip = vm.endpointPositions

  assert.deepEqual(strip.records.map((record) => record.identity.key).sort(), savedEnds.records.map((record) => record.identity.key).sort(), 'the strip states the origin, the destination and the Lagrange points the saved distance is measured through')
  savedEnds.records.forEach((record) => assert.ok(record.conditions.every((code) => strip.records.find((one) => one.identity.key === record.identity.key).conditions.includes(code)), 'and each with what its saved position rests on'))
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

check('pages-hauling-mixed', 'Hauling states what every independent simulation states: a fast class and a slow one on one haul, and a fast fleet and a slow one on one route, give a plan strip, a route strip and a delivery total that say the slow one kept the saved positions, whichever comes first', async (w) => {
  const page = await w.hauling()
  const rp = (await w.modules())['route-position']
  const AU = 149600000
  const rock = (id, distance, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rocks = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const orbitFacts = { bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: { 7: 1, 8: 2 }, problems: [] }
  const colony = (id, rockIndex) => COLONY({ PopulationID: id, PopName: `Colony ${id}`, Xcor: rocks[rockIndex].xcor, Ycor: rocks[rockIndex].ycor })
  const order = (fleet, id, extra) => ({ FleetID: fleet, OrderDelay: 0, ActionName: 'Load', Jumps: 0, ExitSystemID: 1, SystemID: 1, DestinationType: 2, DestinationID: 3, MoveActionID: 62, Description: 'Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport', X: rocks[0].xcor, Y: rocks[0].ycor, ExitX: rocks[0].xcor, ExitY: rocks[0].ycor, ...extra, MoveOrder: id })
  const unload = { ActionName: 'Unload', MoveActionID: 63, Description: 'Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: rocks[1].xcor, Y: rocks[1].ycor, ExitX: rocks[1].xcor, ExitY: rocks[1].ycor }
  const fleetOf = (id, speed) => ({ FleetID: id, FleetName: `Convoy ${id}`, Ships: 1, CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: 1.5, Speed: speed, FuelPerHour: 99 })
  const km = Math.hypot(rocks[0].xcor - rocks[1].xcor, rocks[0].ycor - rocks[1].ycor)
  const haul = { from: colony(7, 0), to: colony(8, 1), km, jumps: 0, tonnes: 1100, queue: 100, minerals: [], detour: null }
  const classOf = (name, speed) => HAULER({ Ships: 2, ClassName: name, ShipClassID: speed, MaxSpeed: speed })
  const FAST = 1500
  const SLOW = 10
  const make = (classes, speeds) => instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts, handlingSupport: FULL_OFFICERS, fleets: speeds.map((speed, index) => fleetOf(5 + index, speed)), orders: speeds.flatMap((_speed, index) => [order(5 + index, 1), order(5 + index, 2, unload)]), fleetShips: speeds.map((speed, index) => HAULER({ FleetID: 5 + index, FleetName: `Convoy ${5 + index}`, ShipID: 1 + index, MaxSpeed: speed, FleetSpeed: speed, UseMaximumSpeed: 0 })), formulaVersion: '2.7.1', plan: { hauls: [haul], unmet: [] }, freighters: classes.map(([name, speed]) => classOf(name, speed)), shuttleTechnology: 1.5, mineralDeliveries: {} } })
  const codesOf = (positions) => positions.conditions.map((one) => one.code)

  ;[[['Fast', FAST], ['Slow', SLOW]], [['Slow', SLOW], ['Fast', FAST]]].forEach((classes) => {
    const order = classes.map(([name]) => name).join(' then ')
    const vm = make(classes, [FAST, SLOW])
    const [row] = vm.planRows
    const flown = (name) => row.estimates.find((estimate) => estimate.flown && estimate.flown.speed === classes.find(([one]) => one === name)[1])

    assert.equal(flown('Fast').flown.annual.status, 'propagated', `${order}: the fast class flies on the moved bodies`)
    assert.equal(flown('Slow').flown.annual.status, 'static', `${order}: the slow class does not`)
    assert.equal(row.positionRecords.length > 0, true)
    assert.equal(vm.planPositions.mode, 'static', `${order}: the plan strip says the colonies stand on the saved positions, as the slow class left them`)
    assert.ok(codesOf(vm.planPositions).includes('fleet-slower'), `${order}: and why`)
    assert.ok(row.pathResult && !row.pathResult.inputs.missing.includes(rp.CONDITIONS['fleet-slower']), `${order}: the haul's own distance is the saved one and states no refusal of a flight`)
    assert.ok(row.estimates.filter((estimate) => estimate.flown && estimate.flown.annual.status === 'static').every((estimate) => estimate.result.inputs.missing.includes(rp.CONDITIONS['fleet-slower'])), `${order}: the time of the slow class names the refusal`)
    assert.ok(vm.planPositions.records.every((record) => record.basis === 'static' || !record.conditions.includes('fleet-slower')), `${order}: a record that carries the refusal is not stated as propagated`)
  })

  ;[[FAST, SLOW], [SLOW, FAST]].forEach((speeds) => {
    const order = speeds.join(' then ')
    const vm = make([['Fast', FAST]], speeds)
    const rows = vm.routeRows

    assert.deepEqual(rows.map((one) => one.positions.mode).sort(), ['propagated', 'static'], `${order}: one fleet is flown and the other is not`)
    assert.equal(vm.fleetPositions.mode, 'static', `${order}: the route strip says the stops stand on the saved positions, as the slow fleet left them`)
    assert.ok(codesOf(vm.fleetPositions).includes('fleet-slower'), `${order}: and why`)

    const total = vm.deliveryRows.find((one) => one.kind === 'minerals' || one.PopulationID === 8)

    assert.ok(total, `${order}: the deliveries are totalled`)
    assert.ok(total.result.inputs.missing.includes(rp.CONDITIONS['fleet-slower']), `${order}: the delivery total names the refusal of the slow fleet`)
  })
})

check('pages-transport-mixed', 'Transport states what every independent run states: two fleets refused for different reasons, one by a body it cannot overtake and one by a year of more cycles than the simulation takes, give a strip that names both, whichever comes first', async (w) => {
  const page = await w.transport()
  const AU = 149600000
  const rock = (id, distance, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rocks = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const orbitFacts = { bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: { 7: 1, 8: 2 }, problems: [] }
  const place = (id, rockIndex) => ({ kind: 'colony', key: 'colony:' + id, name: 'Colony ' + id, colony: COLONY({ PopulationID: id, Xcor: rocks[rockIndex].xcor, Ycor: rocks[rockIndex].ycor }), SystemID: 1, Xcor: rocks[rockIndex].xcor, Ycor: rocks[rockIndex].ycor })
  const here = place(7, 0)
  const there = place(8, 1)
  const km = Math.hypot(rocks[0].xcor - rocks[1].xcor, rocks[0].ycor - rocks[1].ycor)
  const reach = { route: { km, jumps: 0, end: { kind: 'fly', at: there, previous: null, origin: { SystemID: 1, Xcor: here.Xcor, Ycor: here.Ycor }, legKm: km, via: null } }, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
  const make = (speeds) => instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts, handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: here, destination: there, reachOf: () => reach, fleetShips: speeds.map((speed, index) => HAULER({ FleetID: 5 + index, FleetName: 'Convoy ' + (5 + index), ShipID: 1 + index, FleetSpeed: speed, MaxSpeed: speed, EnginePower: speed / 50, UndamagedEnginePower: speed / 50, UseMaximumSpeed: 0 })) } })

  ;[[10, 100000], [100000, 10]].forEach((speeds) => {
    const order = speeds.join(' then ')
    const vm = make(speeds)
    const reasons = vm.fleetRuns.map((run) => run.simulation && run.simulation.annual.reasons).flat()

    assert.ok(reasons.includes('fleet-slower'), order + ': one fleet cannot overtake the body')
    assert.ok(reasons.includes('cycles-capped'), order + ': the other fleet flies more cycles than the simulation takes')
    assert.equal(vm.endpointPositions.mode, 'static', order + ': the strip says the endpoints stand on the saved positions')

    const codes = vm.endpointPositions.conditions.map((one) => one.code)

    assert.ok(codes.includes('fleet-slower'), order + ': the strip names the body the slow fleet cannot overtake')
    assert.ok(codes.includes('cycles-capped'), order + ': and the cap of the fast one')
  })
})

check('pages-saved-distance', 'Hauling and Transport state each figure with the positions it rests on: a distance measured on the saved coordinates is not stated as worked out for the arrival when every simulated year succeeds, the time is, and the strips state both', async (w) => {
  const hauling = await w.hauling()
  const transport = await w.transport()
  const modules = await w.modules()
  const rp = modules['route-position']
  const AU = 149600000
  const rock = (id, distance, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rocks = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const orbitFacts = { bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: { 7: 1, 8: 2 }, problems: [] }
  const claims = (result) => result.assumptions.includes(rp.ASSUMPTIONS.propagated)
  const SPEED_KM = 1500

  // Hauling: a class and a fleet that both fly on the moved bodies.
  const colony = (id, rockIndex) => COLONY({ PopulationID: id, PopName: 'Colony ' + id, Xcor: rocks[rockIndex].xcor, Ycor: rocks[rockIndex].ycor })
  const order = (id, extra) => ({ FleetID: 5, OrderDelay: 0, ActionName: 'Load', Jumps: 0, ExitSystemID: 1, SystemID: 1, DestinationType: 2, DestinationID: 3, MoveActionID: 62, Description: 'Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport', X: rocks[0].xcor, Y: rocks[0].ycor, ExitX: rocks[0].xcor, ExitY: rocks[0].ycor, ...extra, MoveOrder: id })
  const unload = { ActionName: 'Unload', MoveActionID: 63, Description: 'Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: rocks[1].xcor, Y: rocks[1].ycor, ExitX: rocks[1].xcor, ExitY: rocks[1].ycor }
  const km = Math.hypot(rocks[0].xcor - rocks[1].xcor, rocks[0].ycor - rocks[1].ycor)
  const haul = { from: colony(7, 0), to: colony(8, 1), km, jumps: 0, tonnes: 1100, queue: 100, minerals: [], detour: null }
  const vm = instantiate(hauling, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts, handlingSupport: FULL_OFFICERS, fleets: [{ FleetID: 5, FleetName: 'Convoy 5', Ships: 1, CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: 1.5, Speed: SPEED_KM, FuelPerHour: 99 }], orders: [order(1), order(2, unload)], fleetShips: [HAULER({ FleetID: 5, FleetName: 'Convoy 5', MaxSpeed: SPEED_KM, FleetSpeed: SPEED_KM, UseMaximumSpeed: 0 })], formulaVersion: '2.7.1', plan: { hauls: [haul], unmet: [] }, freighters: [HAULER({ Ships: 2, ClassName: 'Fast', ShipClassID: 1, MaxSpeed: SPEED_KM })], shuttleTechnology: 1.5, mineralDeliveries: {} } })
  const [planned] = vm.planRows
  const flownClass = planned.estimates.find((estimate) => estimate.flown)
  const [fleet] = vm.routeRows

  assert.equal(flownClass.flown.annual.status, 'propagated', 'the class flies on the moved bodies')
  assert.ok(claims(flownClass.result), 'its round trip is worked out for the arrival')
  assert.ok(planned.pathResult, 'the haul\'s distance has a result')
  assert.ok(!claims(planned.pathResult), 'the haul\'s distance is measured on the saved coordinates, so it does not say the positions were worked out for the arrival')
  assert.equal(planned.pathResult.value, haul.km)
  const bothBases = async (positions, message) => {
    const view = instantiate(await w.component(), { $store: STORE, data: { positions, state: { loading: false, failed: '', error: '' } } })

    assert.equal(positions.mode, 'mixed', message + ': flown and saved, so mixed')
    assert.ok(positions.records.some((record) => record.basis === 'propagated') && positions.records.some((record) => record.basis === 'static'), message + ': neither basis replaced the other')
    assert.ok(view.groups.some((group) => group.assumption === 'propagated') && view.groups.some((group) => group.assumption !== 'propagated'), message + ': the strip shows both assumption groups')
  }

  await bothBases(vm.planPositions, 'the plan strip')
  assert.equal(fleet.positions.mode, 'propagated', 'the fleet flies on the moved bodies')
  assert.ok(claims(fleet.results.cycle), 'the cycle time of the route is worked out for the arrival')
  assert.ok(fleet.distanceResult && !claims(fleet.distanceResult), 'the route\'s distance is measured on the saved coordinates')
  assert.ok(fleet.legResults.every((result) => !claims(result)), 'and so is each leg')
  await bothBases(vm.fleetPositions, 'the route strip')

  // Transport: a class and a fleet that both fly on the moved bodies.
  const place = (id, rockIndex) => ({ kind: 'colony', key: 'colony:' + id, name: 'Colony ' + id, colony: COLONY({ PopulationID: id, Xcor: rocks[rockIndex].xcor, Ycor: rocks[rockIndex].ycor }), SystemID: 1, Xcor: rocks[rockIndex].xcor, Ycor: rocks[rockIndex].ycor })
  const here = place(7, 0)
  const there = place(8, 1)
  const reach = { route: { km, jumps: 0, end: { kind: 'fly', at: there, previous: null, origin: { SystemID: 1, Xcor: here.Xcor, Ycor: here.Ycor }, legKm: km, via: null } }, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
  const ship = (extra) => HAULER({ MaxSpeed: SPEED_KM, FleetSpeed: SPEED_KM, EnginePower: SPEED_KM / 50, UndamagedEnginePower: SPEED_KM / 50, UseMaximumSpeed: 0, ...extra })
  const run = instantiate(transport, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts, handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: here, destination: there, reachOf: () => reach, fleetShips: [ship()] } })
  const [flownFleet] = run.fleetRuns
  const ends = { origin: modules.transport.colonyEndpoint(COLONY()), destination: modules.transport.colonyEndpoint(COLONY({ PopulationID: 8, ShuttleCapacity: 0 })) }
  const classRun = { ...run.runOf({ FleetID: 5, FleetName: 'Convoy', civilian: false }, { ShipClassID: 1, ClassName: 'Freighter', ships: [ship()] }, reach, ends), ...run.safeFields(reach) }

  assert.equal(flownFleet.simulation.annual.status, 'propagated', 'the fleet flies on the moved bodies')
  assert.ok(claims(flownFleet.provenance), 'its round trip is worked out for the arrival')
  assert.ok(flownFleet.pathResult && !claims(flownFleet.pathResult), 'the fleet\'s distance is measured on the saved coordinates')
  assert.equal(classRun.simulation.annual.status, 'propagated', 'the class flies on the moved bodies')
  assert.ok(claims(classRun.provenance), 'its round trip is worked out for the arrival')
  assert.ok(classRun.pathResult && !claims(classRun.pathResult), 'the class\'s distance is measured on the saved coordinates')
  await bothBases(run.endpointPositions, 'the Transport strip')
})

check('pages-position-matrix', 'Every displayed time, distance, caption and strip of Transport and Hauling agrees with how it was computed, in every scenario: no run, no ships, a class that cannot move, every arrival refused, a round trip beyond the tank, a destination no orbit serves, a body past its horizon and a journey wholly flown', async (w) => {
  const transport = await w.transport()
  const hauling = await w.hauling()
  const modules = await w.modules()
  const rp = modules['route-position']
  const AU = 149600000
  const rock = (id, distance, bearing, year, extra = {}) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180), ...extra })
  const circular = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const eccentric = [rock(1, 1, 90, 6000, { bodyClass: 1, eccentricity: 0.2, xcor: 1.2 * AU, ycor: 0 }), rock(2, 2, 0, 17520)]
  const orbitsOf = (rocks, bodyOf) => ({ bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf, problems: [] })
  const claims = (result) => Boolean(result) && result.assumptions.includes(rp.ASSUMPTIONS.propagated)
  const component = await w.component()
  const groupsOf = (positions) => instantiate(component, { $store: STORE, data: { positions, state: { loading: false, failed: '', error: '' } } }).groups.map((group) => group.assumption).sort()
  const codesOf = (positions) => positions.conditions.map((one) => one.code)
  const FUEL_TANK = { FuelCapacity: 1, Fuel: 1 }

  // What each scenario must read: the strip's mode and assumption groups, and, per row, whether a caption is shown, what it starts with, whether it counts throughput, and whether the time claims positions worked out.
  const SCENARIOS = [
    { name: 'no ships or runs', rocks: circular, speed: null, rows: false, mode: 'static', groups: ['body-held'] },
    { name: 'a class that cannot move', rocks: circular, speed: 0, mode: 'static', groups: ['body-held'], caption: null, flown: false },
    { name: 'every arrival refused', rocks: circular, speed: 10, mode: 'static', groups: ['body-held'], caption: 'Static', codes: ['fleet-slower'], flown: false },
    { name: 'a round trip beyond the tank', rocks: circular, speed: 1500, tank: FUEL_TANK, mode: 'mixed', groups: ['body-held', 'propagated'], caption: 'Propagated', throughput: false, flown: true },
    { name: 'a destination no orbit serves', rocks: circular, speed: 1500, bodyOf: { 7: 1 }, mode: 'static', groups: ['body-held'], caption: 'Static', flown: false },
    { name: 'a body past its horizon', rocks: eccentric, speed: 1500, mode: 'static', groups: ['body-held'], caption: 'Static', codes: ['orbit-horizon'], flown: false },
    { name: 'a journey wholly flown', rocks: circular, speed: 1500, mode: 'mixed', groups: ['body-held', 'propagated'], caption: 'Propagated', throughput: true, flown: true },
  ]
  const km = (rocks) => Math.hypot(rocks[0].xcor - rocks[1].xcor, rocks[0].ycor - rocks[1].ycor)

  // Transport: the class row, the fleet row and the strip.
  SCENARIOS.forEach((scenario) => {
    const { rocks, speed } = scenario
    const distance = km(rocks)
    const place = (id, index) => ({ kind: 'colony', key: 'colony:' + id, name: 'Colony ' + id, colony: COLONY({ PopulationID: id, Xcor: rocks[index].xcor, Ycor: rocks[index].ycor }), SystemID: 1, Xcor: rocks[index].xcor, Ycor: rocks[index].ycor })
    const here = place(7, 0)
    const there = place(8, 1)
    const reach = { route: { km: distance, jumps: 0, end: { kind: 'fly', at: there, previous: null, origin: { SystemID: 1, Xcor: here.Xcor, Ycor: here.Ycor }, legKm: distance, via: null } }, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
    const ship = speed === null ? null : HAULER({ MaxSpeed: speed, FleetSpeed: speed, EnginePower: speed / 50, UndamagedEnginePower: speed / 50, UseMaximumSpeed: 0, ...(scenario.tank || {}) })
    const vm = instantiate(transport, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts: orbitsOf(rocks, scenario.bodyOf || { 7: 1, 8: 2 }), handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: here, destination: there, reachOf: () => reach, fuelSites: NO_SITES, fuelReserveRead: NO_RESERVES, fleetShips: ship ? [ship] : [] } })
    const classRows = ship ? [{ ...vm.runOf({ FleetID: 5, FleetName: 'Convoy', civilian: false }, { ShipClassID: 1, ClassName: 'Freighter', ships: [ship] }, reach, vm.endpoints), ...vm.safeFields(reach) }] : []
    const rows = [...classRows, ...vm.fleetRuns]
    const label = 'Transport, ' + scenario.name

    assert.equal(rows.length, scenario.rows === false ? 0 : 2, label + ': the class row and the fleet row there are')
    assert.equal(vm.endpointPositions.mode, scenario.mode, label + ': the strip reads ' + scenario.mode)
    assert.deepEqual(groupsOf(vm.endpointPositions), scenario.groups, label + ': and shows its assumption groups')
    ;(scenario.codes || []).forEach((code) => assert.ok(codesOf(vm.endpointPositions).includes(code), label + ': the strip names ' + code))
    rows.forEach((row) => {
      const shown = row.status === 'ok' || row.status === 'range'
      const caption = row.propagation ? vm.propagationText(row) : ''

      if (scenario.caption === undefined || scenario.caption === null) {
        assert.equal(caption, '', label + ': no caption, a row with nothing simulated')
      } else {
        assert.ok(caption.startsWith(scenario.caption), label + ': the caption reads ' + scenario.caption + ', not "' + caption + '"')
        assert.ok(shown, label + ': a caption goes with a time that is shown')
        assert.equal(caption.includes('trips/yr'), scenario.throughput !== false && scenario.caption === 'Propagated', label + ': and counts throughput only for a trip that can run')
      }

      if (shown) {
        assert.equal(claims(row.provenance), scenario.flown === true, label + ': the time claims positions worked out only when the year was flown')
        assert.ok(!claims(row.pathResult), label + ': the saved distance never claims it')
      }
    })
  })

  // A route that crosses Lagrange points rests its saved distance on them too, so the strip lists them beside the endpoints.
  const crossing = (() => {
    const here = { kind: 'colony', key: 'colony:7', name: 'colony 7', colony: COLONY(), SystemID: 1, Xcor: 10, Ycor: 5 }
    const there = { kind: 'fleet', key: 'fleet:7', name: 'fleet 7', colony: COLONY(), SystemID: 2, Xcor: 5, Ycor: 5 }
    const route = modules['jump-graph'].searchRoutes(LINKS, [{ SystemID: 1, Xcor: 10, Ycor: 5 }], { order: 'jumps', lagrangePoints: LAGRANGE }).toPlace(there)
    const reach = { route, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }

    return instantiate(transport, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: UNSURE, handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: here, destination: there, reachOf: () => reach, fleetShips: [HAULER({ FleetSpeed: 300, UseMaximumSpeed: 0 })] } })
  })()

  assert.ok(crossing.endpointPositions.records.some((record) => record.identity.family === 'lagrange-point'), 'the strip lists the Lagrange points the saved distance rests on')

  // Hauling: the haul rows, the route rows and the two strips.
  SCENARIOS.forEach((scenario) => {
    const { rocks, speed } = scenario
    const colony = (id, index) => COLONY({ PopulationID: id, PopName: 'Colony ' + id, Xcor: rocks[index].xcor, Ycor: rocks[index].ycor })
    const order = (id, extra) => ({ FleetID: 5, OrderDelay: 0, ActionName: 'Load', Jumps: 0, ExitSystemID: 1, SystemID: 1, DestinationType: 2, DestinationID: id, MoveActionID: 62, Description: 'Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport', X: rocks[0].xcor, Y: rocks[0].ycor, ExitX: rocks[0].xcor, ExitY: rocks[0].ycor, ...extra, MoveOrder: id })
    const unload = { ActionName: 'Unload', MoveActionID: 63, Description: 'Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: rocks[1].xcor, Y: rocks[1].ycor, ExitX: rocks[1].xcor, ExitY: rocks[1].ycor }
    const haul = { from: colony(7, 0), to: colony(8, 1), km: km(rocks), jumps: 0, tonnes: 1100, queue: 100, minerals: [], detour: null }
    const some = speed !== null
    const data = { loadErrors: loadErrorsOf(null), positionFacts: FACTS, orbitFacts: orbitsOf(rocks, scenario.bodyOf || { 7: 1, 8: 2 }), handlingSupport: FULL_OFFICERS, fleets: some ? [{ FleetID: 5, FleetName: 'Convoy 5', Ships: 1, CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: 1.5, Speed: speed, FuelPerHour: 99 }] : [], orders: some ? [order(1), order(2, unload)] : [], fleetShips: some ? [HAULER({ FleetID: 5, FleetName: 'Convoy 5', MaxSpeed: speed, FleetSpeed: speed, EnginePower: speed / 50, UndamagedEnginePower: speed / 50, UseMaximumSpeed: 0 })] : [], formulaVersion: '2.7.1', plan: { hauls: [haul], unmet: [] }, freighters: some ? [HAULER({ Ships: 2, ClassName: 'Class', ShipClassID: 1, MaxSpeed: speed, ...(scenario.tank || {}) })] : [], shuttleTechnology: 1.5, mineralDeliveries: {} }
    const vm = instantiate(hauling, { $store: STORE, database: null, GameID: 1, RaceID: 2, data })
    const label = 'Hauling, ' + scenario.name
    const [planned] = vm.planRows
    const estimates = planned.estimates
    const wholly = scenario.mode === 'mixed'

    assert.equal(vm.planPositions.mode, scenario.mode, label + ': the plan strip reads ' + scenario.mode)
    assert.deepEqual(groupsOf(vm.planPositions), scenario.groups, label + ': and shows its assumption groups')
    ;(scenario.codes || []).forEach((code) => assert.ok(codesOf(vm.planPositions).includes(code), label + ': the plan strip names ' + code))
    estimates.forEach((estimate) => {
      if (scenario.caption === undefined || scenario.caption === null) {
        assert.equal(estimate.propagationText, '', label + ': no caption, a haul with nothing simulated')
      } else {
        assert.ok(estimate.propagationText.startsWith(scenario.caption), label + ': the caption reads ' + scenario.caption + ', not "' + estimate.propagationText + '"')
        assert.equal(estimate.propagationText.includes('trips/yr'), scenario.throughput !== false && scenario.caption === 'Propagated', label + ': and counts throughput only for a trip that can run')
      }

      if (estimate.timed) {
        assert.equal(claims(estimate.result), scenario.flown === true, label + ': the time claims positions worked out only when the year was flown')
      }
    })
    assert.ok(!planned.pathResult || !claims(planned.pathResult), label + ': the saved distance never claims it')

    if (some) {
      const [fleet] = vm.routeRows

      assert.equal(vm.fleetPositions.mode, wholly ? 'mixed' : 'static', label + ': the route strip reads ' + (wholly ? 'mixed' : 'static'))
      assert.deepEqual(groupsOf(vm.fleetPositions), scenario.groups, label + ': and shows its assumption groups')
      assert.ok(!fleet.distanceResult || !claims(fleet.distanceResult), label + ': the saved distance of the route never claims it')

      if (fleet.year && scenario.tank === undefined) {
        assert.equal(claims(fleet.results.cycle), scenario.flown === true, label + ': the cycle time claims positions worked out only when the year was flown')
      }
    }
  })
})

check('pages-endpoint-matrix', 'Every distance, time, caption and strip of Route Finder, Transport and Hauling agrees with the positions its figures used whatever the endpoints are and the game\'s motion switches say: places that never move (system centres, jump points, waypoints held by no body, a fleet), a body no family serves, an asteroid, a colony, a Lagrange point and a body beside a fleet, with the planet and asteroid motion switches on or off, flown fast or refused', async (w) => {
  const transport = await w.transport()
  const hauling = await w.hauling()
  const routes = await w.routes()
  const modules = await w.modules()
  const component = await w.component()
  const graph = modules['jump-graph']
  const rp = modules['route-position']
  const AU = 149600000
  const FAST = 1500
  const SLOW = 10
  const at = (distance, bearing) => ({ xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rock = (id, distance, bearing, year, extra = {}) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, ...at(distance, bearing), ...extra })
  const MOVING = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const PINNED = [rock(1, 1, 90, 8760, { fixed: 1, fixedParentId: 0 }), rock(2, 2, 0, 17520, { fixed: 1, fixedParentId: 0 })]
  const GAS_GIANT = rock(3, 4, 200, 30000, { bodyClass: 1 })
  const PROXIES = [rock(1, 1, 90, 8760, { fixed: 1, fixedParentId: 3 }), rock(2, 2, 0, 17520, { fixed: 1, fixedParentId: 3 }), GAS_GIANT]
  const moon = (id, parent, km, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 2, trojan: 0, distance: km, bearing, year, eccentricity: 0, direction: 0, parentId: parent.id, parentType: 3, fixed: 0, xcor: parent.xcor + km * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: parent.ycor + km * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const MOONS = [moon(5, MOVING[0], 1e6, 90, 240), moon(6, MOVING[1], 2e6, 0, 480)]
  const point = (id, owner) => Object.freeze({ id, systemId: 1, planetId: owner.id, distance: owner.distance / AU, bearing: (owner.bearing + 60) % 360, xcor: MOVING[owner.parentId - 1].xcor + owner.distance * Math.cos(((owner.bearing + 60 - 90) * Math.PI) / 180), ycor: MOVING[owner.parentId - 1].ycor + owner.distance * Math.sin(((owner.bearing + 60 - 90) * Math.PI) / 180) })
  const POINTS = { 31: point(31, MOONS[0]), 32: point(32, MOONS[1]) }
  const orbitsOf = (rocks, bodyOf = { 7: 1, 8: 2 }, points = {}) => ({ bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points, hidden: {}, hiddenPoints: {}, bodyOf, problems: [] })
  const claims = (result) => Boolean(result) && result.assumptions.includes(rp.ASSUMPTIONS.propagated)
  const groupsOf = (positions) => [...new Set(instantiate(component, { $store: STORE, data: { positions, state: { loading: false, failed: '', error: '' } } }).groups.map((group) => group.assumption))].sort()
  const codesOf = (positions) => positions.conditions.map((one) => one.code)
  const known = (value) => ({ ...SPEED, value })
  const place = (kind, id, extra = {}) => ({ ...stop(kind, id), colony: COLONY({ PopulationID: id }), ...extra })
  const here = (rocks) => ({ SystemID: 1, Xcor: rocks[0].xcor, Ycor: rocks[0].ycor })
  const there = (rocks) => ({ SystemID: 1, Xcor: rocks[1].xcor, Ycor: rocks[1].ycor })
  const FLEETS = { ...FACTS.fleets, 8: { lastMoveTime: 960000, following: false, orders: 1, anchor: 0 } }
  const WAYPOINTS = { ...FACTS.waypoints, 41: { orbit: 0, group: null } }

  // The endpoint kinds. The expectation of a cell is told by the class of its kind: 'inert' never moves, is carried by no body or is a fixed body with no parent (nothing to compare), 'pinned' is a body that moves and no family serves (a refusal that is stated), 'moving' is served, and 'beside' is served beside a fleet whose motion is unknown.
  const KINDS = [
    { name: 'system centres', inert: true, links: LINKS, rocks: MOVING, origin: place('system', 1, { SystemID: 1, Xcor: 0, Ycor: 0 }), destination: place('system', 2, { SystemID: 2, Xcor: 0, Ycor: 0 }) },
    { name: 'jump points', inert: true, links: LINKS, rocks: MOVING, origin: place('jump', 11, { SystemID: 1, Xcor: 1000, Ycor: 0 }), destination: place('jump', 21, { SystemID: 2, Xcor: 0, Ycor: 0 }) },
    { name: 'waypoints held by no body', inert: true, rocks: MOVING, facts: { waypoints: WAYPOINTS }, origin: place('waypoint', 31, here(MOVING)), destination: place('waypoint', 41, there(MOVING)) },
    { name: 'fleets', inert: true, rocks: MOVING, facts: { fleets: FLEETS }, origin: place('fleet', 7, here(MOVING)), destination: place('fleet', 8, there(MOVING)) },
    { name: 'deep-space locations that never move', inert: true, rocks: PINNED, origin: place('body', 1, here(PINNED)), destination: place('body', 2, there(PINNED)) },
    { name: 'deep-space populations at a gas giant', pinned: true, rocks: PROXIES, origin: place('body', 1, here(PROXIES)), destination: place('body', 2, there(PROXIES)) },
    { name: 'asteroids', moving: true, asteroid: true, rocks: MOVING, origin: place('body', 1, here(MOVING)), destination: place('body', 2, there(MOVING)) },
    { name: 'colonies', moving: true, asteroid: true, rocks: MOVING, origin: place('colony', 7, here(MOVING)), destination: place('colony', 8, there(MOVING)) },
    { name: 'Lagrange points of moons', moving: true, rocks: [...MOVING, ...MOONS], points: POINTS, origin: place('lagrange', 31, { SystemID: 1, Xcor: POINTS[31].xcor, Ycor: POINTS[31].ycor }), destination: place('lagrange', 32, { SystemID: 1, Xcor: POINTS[32].xcor, Ycor: POINTS[32].ycor }) },
    { name: 'an asteroid beside a fleet', beside: true, asteroid: true, rocks: MOVING, facts: { fleets: FLEETS }, origin: place('body', 1, here(MOVING)), destination: place('fleet', 8, there(MOVING)) },
  ]
  const MOTIONS = [
    { name: 'motion on', clock: CLOCK },
    { name: 'planet motion off', clock: { ...CLOCK, orbitalMotion: 0 } },
    { name: 'asteroid motion off', clock: { ...CLOCK, orbitalMotionAst: 0 } },
  ]

  // What a cell must read, from what the cell is and nothing in the code: the Transport and Hauling strip (the saved distances sit beside what was flown), the caption of a row ('' none, 'Static' the reason the saved positions stand, 'Propagated' the comparison), whether the time claims positions worked out, and the Route Finder plan and page strip (a one-way plan arrives only at its last stop).
  const QUIET = { strip: 'static', caption: '', flown: false, plan: 'static', shown: 'static' }
  const expectOf = (kind, motion, speed) => {
    if (kind.inert || motion.name === 'planet motion off' || (kind.asteroid && motion.name === 'asteroid motion off')) {
      return QUIET
    } else if (kind.pinned || speed === SLOW) {
      return { ...QUIET, caption: 'Static' }
    }

    return { strip: 'mixed', caption: 'Propagated', flown: true, plan: kind.beside ? 'static' : 'propagated', shown: kind.beside ? 'static' : 'propagated' }
  }

  // Each kind meets each motion once and each outcome in at least one of its three motions, and each motion meets each outcome with more than one kind: every pair of the three axes.
  const CELLS = KINDS.flatMap((kind, k) => MOTIONS.map((motion, m) => ({ kind, motion, speed: (k + m) % 2 ? SLOW : FAST })))

  const reachOf = (kind) => ({ route: graph.searchRoutes(kind.links || [], [{ SystemID: kind.origin.SystemID, Xcor: kind.origin.Xcor, Ycor: kind.origin.Ycor }], { order: 'jumps' }).toPlace(kind.destination), open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false })
  const factsOf = (kind, motion) => ({ ...FACTS, ...(kind.facts || {}), clock: motion.clock })

  CELLS.forEach(({ kind, motion, speed }) => {
    const label = kind.name + ', ' + motion.name + ', ' + (speed === FAST ? 'flown fast' : 'refused')
    const expected = expectOf(kind, motion, speed)
    const facts = factsOf(kind, motion)
    const orbitFacts = orbitsOf(kind.rocks, { 7: 1, 8: 2 }, kind.points || {})
    const reach = reachOf(kind)

    // Transport: the class row, the fleet row and the strip.
    const ship = HAULER({ MaxSpeed: speed, FleetSpeed: speed, EnginePower: speed / 50, UndamagedEnginePower: speed / 50, UseMaximumSpeed: 0 })
    const run = instantiate(transport, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: facts, orbitFacts, handlingSupport: FULL_OFFICERS, formulaVersion: '2.7.1', origin: kind.origin, destination: kind.destination, reachOf: () => reach, fuelSites: NO_SITES, fuelReserveRead: NO_RESERVES, fleetShips: [ship] } })
    const classRow = { ...run.runOf({ FleetID: 5, FleetName: 'Convoy', civilian: false }, { ShipClassID: 1, ClassName: 'Freighter', ships: [ship] }, reach, run.endpoints), ...run.safeFields(reach) }

    ;[classRow, ...run.fleetRuns].forEach((row) => {
      const caption = row.propagation ? run.propagationText(row) : ''

      assert.equal(row.status, 'ok', label + ': Transport times the row')
      assert.ok(caption.startsWith(expected.caption) && (expected.caption !== '' || caption === ''), label + ': Transport caption reads "' + expected.caption + '", not "' + caption + '"')
      assert.equal(claims(row.provenance), expected.flown, label + ': Transport time claims positions worked out only when they were')
      assert.ok(!claims(row.pathResult), label + ': Transport saved distance never claims them')
    })
    assert.equal(run.endpointPositions.mode, expected.strip, label + ': Transport strip reads ' + expected.strip)
    assert.equal(groupsOf(run.endpointPositions).includes('propagated'), expected.flown, label + ': Transport strip shows a propagated group only when flown')
    assert.equal(codesOf(run.endpointPositions).includes('propagation-unavailable'), expected.caption === 'Static', label + ': Transport strip states a refusal only for a refusal that matters')

    // Route Finder: the plan's legs and detail rows, the plan strip and the page strip.
    const stops = [kind.origin, kind.destination]
    const found = graph.searchRoutes(kind.links || [], [stops[0]], { order: 'jumps' })
    const finder = instantiate(routes, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(null), positionFacts: facts, orbitFacts, plannedStops: stops, stopKeys: stops.map((one) => one.key), placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])), extra: {}, lazyState: {}, legNotes: {}, systemNameOf: (id) => 'System ' + id, pointName: () => 'a point', lagrangeName: () => 'a Lagrange point', jumpPoints: kind.links || [], lagrangePoints: [], cycle: false, searchOptions: { order: 'jumps' }, speedResult: known(speed), origin: stops[0], routes: found, openRoutes: found, avoidDetails: {}, systems: [{ SystemID: 1, Name: 'One' }, { SystemID: 2, Name: 'Two' }] } })

    assert.equal(finder.plan.positions.mode, expected.plan, label + ': Route Finder plan reads ' + expected.plan)
    assert.equal(finder.shownPositions.mode === 'static', expected.shown === 'static', label + ': Route Finder strip reads ' + expected.shown)
    finder.plan.legs.forEach((leg) => assert.equal(Boolean(leg.positions) && leg.positions.mode !== 'static', expected.plan !== 'static', label + ': Route Finder leg reads propagated only when its arrival was worked out'))
    finder.detailRows.forEach((row) => {
      if (row.km !== null && row.km > 0) {
        assert.equal(claims(row.timeResult), expected.plan !== 'static', label + ': Route Finder running time claims positions worked out only when they were')
        assert.equal(claims(row.totalResult), expected.plan !== 'static', label + ': Route Finder running distance claims them only when they were')
      }
    })
    assert.equal(groupsOf(finder.shownPositions).some((group) => group === 'propagated' || group === 'departure'), expected.plan !== 'static', label + ': Route Finder strip shows a propagated or departure group only when flown')

    if (expected === QUIET) {
      assert.ok(!groupsOf(finder.plan.positions).some((group) => group === 'propagated' || group === 'departure'), label + ': the plan\'s own strip, with nothing that moves, shows neither')
    }
    assert.equal(codesOf(finder.shownPositions).includes('propagation-unavailable'), expected.caption === 'Static' && !kind.beside, label + ': Route Finder strip states a refusal only for a refusal that matters')
  })

  // Hauling reaches colonies only (a haul between two, a route of orders at two): the colony cells of each motion, flown fast and refused.
  const colonies = KINDS.find((kind) => kind.name === 'colonies')

  MOTIONS.forEach((motion) => {
    ;[FAST, SLOW].forEach((speed) => {
      const label = 'Hauling, colonies, ' + motion.name + ', ' + (speed === FAST ? 'flown fast' : 'refused')
      const expected = expectOf(colonies, motion, speed)
      const rocks = colonies.rocks
      const colony = (id, index) => COLONY({ PopulationID: id, PopName: 'Colony ' + id, Xcor: rocks[index].xcor, Ycor: rocks[index].ycor })
      const order = (id, extra) => ({ FleetID: 5, OrderDelay: 0, ActionName: 'Load', Jumps: 0, ExitSystemID: 1, SystemID: 1, DestinationType: 2, DestinationID: id, MoveActionID: 62, Description: 'Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport', X: rocks[0].xcor, Y: rocks[0].ycor, ExitX: rocks[0].xcor, ExitY: rocks[0].ycor, ...extra, MoveOrder: id })
      const unload = { ActionName: 'Unload', MoveActionID: 63, Description: 'Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: rocks[1].xcor, Y: rocks[1].ycor, ExitX: rocks[1].xcor, ExitY: rocks[1].ycor }
      const haul = { from: colony(7, 0), to: colony(8, 1), km: Math.hypot(rocks[0].xcor - rocks[1].xcor, rocks[0].ycor - rocks[1].ycor), jumps: 0, tonnes: 1100, queue: 100, minerals: [], detour: null }
      const data = { loadErrors: loadErrorsOf(null), positionFacts: factsOf(colonies, motion), orbitFacts: orbitsOf(rocks), handlingSupport: FULL_OFFICERS, fleets: [{ FleetID: 5, FleetName: 'Convoy 5', Ships: 1, CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: 1.5, Speed: speed, FuelPerHour: 99 }], orders: [order(1), order(2, unload)], fleetShips: [HAULER({ FleetID: 5, FleetName: 'Convoy 5', MaxSpeed: speed, FleetSpeed: speed, EnginePower: speed / 50, UndamagedEnginePower: speed / 50, UseMaximumSpeed: 0 })], formulaVersion: '2.7.1', plan: { hauls: [haul], unmet: [] }, freighters: [HAULER({ Ships: 2, ClassName: 'Class', ShipClassID: 1, MaxSpeed: speed })], shuttleTechnology: 1.5, mineralDeliveries: {} }
      const vm = instantiate(hauling, { $store: STORE, database: null, GameID: 1, RaceID: 2, data })
      const [planned] = vm.planRows
      const [fleet] = vm.routeRows

      assert.equal(vm.planPositions.mode, expected.strip, label + ': the plan strip reads ' + expected.strip)
      assert.equal(vm.fleetPositions.mode, expected.strip, label + ': the route strip reads ' + expected.strip)
      assert.equal(groupsOf(vm.planPositions).includes('propagated'), expected.flown, label + ': the plan strip shows a propagated group only when flown')
      assert.equal(groupsOf(vm.fleetPositions).includes('propagated'), expected.flown, label + ': the route strip shows a propagated group only when flown')
      planned.estimates.forEach((estimate) => {
        assert.ok(estimate.propagationText.startsWith(expected.caption) && (expected.caption !== '' || estimate.propagationText === ''), label + ': the haul caption reads "' + expected.caption + '", not "' + estimate.propagationText + '"')
        assert.equal(claims(estimate.result), expected.flown, label + ': the haul time claims positions worked out only when they were')
      })
      assert.ok(fleet.propagationText.startsWith(expected.caption) && (expected.caption !== '' || fleet.propagationText === ''), label + ': the route caption reads "' + expected.caption + '", not "' + fleet.propagationText + '"')
      assert.equal(claims(fleet.results.cycle), expected.flown, label + ': the cycle time claims positions worked out only when they were')
      assert.ok(!claims(planned.pathResult) && !claims(fleet.distanceResult), label + ': the saved distances never claim them')
    })
  })
})

check('pages-hauling', 'Hauling states a repeating route and a planned haul with the positions of their endpoints, and the strips the union of every route and every haul', async (w) => {
  const page = await w.hauling()
  const m = await w.modules()
  const rp = m['route-position']
  const order = (fleet, id, extra = {}) => ({ FleetID: fleet, OrderDelay: 0, ActionName: 'Load', Jumps: 0, X: 10, Y: 5, ExitX: 10, ExitY: 5, ExitSystemID: 1, SystemID: 1, DestinationType: 2, DestinationID: 3, MoveActionID: 62, Description: 'Mars: Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra, MoveOrder: id })
  const orders = [order(5, 1), order(5, 2, { ActionName: 'Unload', MoveActionID: 63, Description: 'Venus: Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: 3 * KM, ExitX: 3 * KM }), order(5, 3, { DestinationType: 6, DestinationID: 9, PopulationID: 0, PopName: null, Description: 'Seen again', ActionName: 'Move', MoveActionID: 2, X: 3 * KM + 10, ExitX: 3 * KM + 10 }), order(6, 1, { DestinationType: 6, DestinationID: 10, PopulationID: 0, PopName: null, Description: 'Seen', ActionName: 'Move' })]
  const fleet = (id) => ({ FleetID: id, FleetName: `Cycle ${id}`, Ships: 1, CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: 1.5, Speed: 300, FuelPerHour: 99 })
  const haul = (from, to) => ({ from: COLONY({ PopulationID: from, PopName: `Colony ${from}` }), to: COLONY({ PopulationID: to, PopName: `Colony ${to}`, Xcor: 3 * KM }), km: 3 * KM, jumps: 1, tonnes: 1100, queue: 100, minerals: [], detour: null })
  const hauls = [haul(7, 8), haul(7, 9)]

  const make = (facts, extra = {}, database = null) => instantiate(page, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(facts ? null : undefined), positionFacts: facts, handlingSupport: FULL_OFFICERS, fleets: [fleet(5), fleet(6)], orders, fleetShips: [HAULER({ FleetSpeed: 300, UseMaximumSpeed: 0 })], formulaVersion: '2.7.1', plan: { hauls, unmet: [] }, freighters: [HAULER({ Ships: 2 })], shuttleTechnology: 1.5, mineralDeliveries: {}, ...extra } })
  const vm = make(UNSURE)

  // A route simulation is kept under the delay of its orders and a haul simulation under the path it flies: the same again is the one kept, a change of either is worked out afresh and equals what it is with nothing kept.
  const database = w.caches.hauling().cacheQueries({ query: async () => [[]] })
  const kept = make(UNSURE, {}, database)
  const plain = make(UNSURE)
  const pair = (delay) => [order(5, 1), order(5, 2, { ActionName: 'Unload', MoveActionID: 63, Description: 'Venus: Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: 3 * KM, ExitX: 3 * KM, OrderDelay: delay })]
  const handling = { stops: [{ seconds: 0 }, { seconds: 0 }] }
  const sailing = { Speed: 300 }
  const cycleOf = (vm, delay) => vm.simulateRoute(pair(delay), sailing, handling, {})
  const stayed = cycleOf(kept, 0)

  assert.ok(stayed, 'the route is simulated')
  assert.equal(cycleOf(kept, 0), stayed, 'the same orders are kept')
  assert.notEqual(cycleOf(kept, 864000), stayed, 'orders with another delay are not the ones kept')
  assert.deepEqual(asJson(cycleOf(kept, 864000)), asJson(cycleOf(plain, 864000)))

  // The delay of an order is spent before the flight to it, where the fleet is, and the handling of the stop after the arrival: with bodies that move, spending the delay at the stop instead changes the flight.
  const AU = 149600000
  const rock = (id, distance, bearing, year) => Object.freeze({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * AU * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * AU * Math.sin(((bearing - 90) * Math.PI) / 180) })
  const rocks = [rock(1, 1, 90, 8760), rock(2, 2, 0, 17520)]
  const orbitFacts = { bodies: Object.fromEntries(rocks.map((one) => [one.id, one])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: {}, problems: [] }
  const flying = make(FACTS, { orbitFacts })
  const toRock = (id, extra = {}) => ({ PopulationID: 0, DestinationType: 2, DestinationID: id, PopName: null, Description: `Rock ${id}`, ActionName: 'Move', MoveActionID: 2, X: rocks[id - 1].xcor, Y: rocks[id - 1].ycor, ExitX: rocks[id - 1].xcor, ExitY: rocks[id - 1].ycor, ...extra })
  const bodies = (delay) => [order(5, 1, toRock(1)), order(5, 2, toRock(2, { OrderDelay: delay }))]
  const delayed = flying.simulateRoute(bodies(864000), sailing, handling, {})
  const shocked = { total: { lo: 1, hi: 2 }, wait: { lo: 5, hi: 9 }, events: [] }
  const timedRoute = flying.simulateRoute(bodies(864000), sailing, handling, {}, shocked)

  assert.equal(timedRoute.annual.status, 'static', 'a route whose cycle waits for the jump shock keeps the saved positions')
  assert.ok(timedRoute.annual.reasons.includes('timed-clock'), 'and says the clock is the reason')
  assert.ok(!delayed.annual.reasons.includes('timed-clock'), 'a cycle with no walk is the flight alone')

  const engine = (delay, wait) => {
    const [one, two] = bodies(0).map((o) => [rp.orderEndpoint({ ...o, label: o.Description }), rp.orderExitEndpoint({ ...o, label: o.Description })])
    const hop = (from, to, extra) => ({ steps: [{ kind: 'fly', SystemID: 1, from, to, via: null }], from, to, leave: to, wait: 0, ...extra })

    return m['route-plan'].simulateCycles({ hops: [hop(one[1], two[0], { delay, wait }), hop(two[1], one[0], {})], facts: { ...FACTS, orbits: orbitFacts }, adapters: rp.ADAPTERS, speed: 300 })
  }

  assert.equal(delayed.annual.status, 'propagated', 'the bodies are moved on')
  assert.deepEqual(delayed.first.km, engine(864000, 0).first.km, 'the delay is spent before the flight')
  assert.notDeepEqual(delayed.first.km, engine(0, 864000).first.km, 'and not as the stop\'s handling after the arrival')

  // A cycle whose flights on the saved positions run the shock down is flown on the moved bodies. When they bring the stop in the other system nearer, so that the flights since the transit no longer run the shock down, the cycle is simulated again on the walk that waits: it keeps the saved positions and the year it has on them.
  const transitOrder = (id, extra) => order(5, id, { ActionName: 'Transit', MoveActionID: 1, Jumps: 1, DestinationType: 1, DestinationID: id, PopulationID: 0, PopName: null, Description: `Jump ${id}`, Y: 0, ExitY: 0, ...extra })
  const across = [order(5, 1), transitOrder(2, { X: 20 * KM, ExitX: 0, ExitSystemID: 2 }), order(5, 3, { SystemID: 2, ExitSystemID: 2, X: 10 * KM, Y: 0, ExitX: 10 * KM, ExitY: 0, DestinationType: 6, DestinationID: 11, PopulationID: 0, PopName: null, Description: 'Far', ActionName: 'Move', MoveActionID: 2 }), transitOrder(4, { SystemID: 2, X: 0, ExitX: 20 * KM, ExitSystemID: 1 }), order(5, 5, { ActionName: 'Unload', MoveActionID: 63, Description: 'Venus: Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: 3 * KM, ExitX: 3 * KM })]
  const cycleRowWith = (simulateRoute) => make(UNSURE, { orders: across, fleets: [fleet(5)], simulateRoute }).routeRows[0]
  const savedCycle = cycleRowWith(() => null)
  const nearerFlights = savedCycle.route.legs.map((leg, index) => [index === 1 || index === 2 ? 1000 : leg.km])
  const cycleWalks = []
  const nearerCycle = cycleRowWith((_orders, _sailing, _handling, _held, walk) => {
    cycleWalks.push(walk)

    return { annual: walk.wait.hi > 0 ? { status: 'static', compared: true, reasons: ['timed-clock'], positions: savedCycle.positions } : { status: 'propagated', compared: true, reasons: [], flights: nearerFlights, positions: savedCycle.positions } }
  })

  assert.deepEqual(savedCycle.year && [savedCycle.year.waitLowDays, savedCycle.year.waitDays], [0, 0], 'on the saved positions the cycle does not wait')
  assert.deepEqual(cycleWalks.map((walk) => walk.wait.hi > 0), [false, true], 'the cycle is simulated again on the walk the moved bodies give it, which waits')
  assert.deepEqual(asJson(nearerCycle.year), asJson(savedCycle.year), 'and keeps the year it has on the saved positions')
  assert.equal(nearerCycle.propagationText, `Static: ${rp.CONDITIONS['timed-clock']}.`, 'and says why')

  const moved = haul(7, 8)
  const trip = { tripSeconds: 100, stops: [] }
  const freighter = { MaxSpeed: 1000 }
  const byA = { km: moved.km, jumps: 1, end: ROUTE_BY(moved.to, moved.km, [{ out: 1, in: 2, x: 100, y: 0 }]).end }
  const byB = { km: moved.km, jumps: 1, end: ROUTE_BY(moved.to, moved.km, [{ out: 3, in: 4, x: 900, y: 400 }]).end }
  const hauled = kept.flyHaul(moved, byA, freighter, trip)

  assert.ok(hauled, 'the haul is simulated')
  assert.equal(kept.flyHaul(moved, byA, freighter, trip), hauled, 'the same path is kept')
  assert.notEqual(kept.flyHaul(moved, byB, freighter, trip), hauled, 'another path of the same distance is not the one kept')
  assert.deepEqual(asJson(kept.flyHaul(moved, byB, freighter, trip)), asJson(plain.flyHaul(moved, byB, freighter, trip)))
  assert.notDeepEqual(asJson(plain.flyHaul(moved, byA, freighter, trip)), asJson(plain.flyHaul(moved, byB, freighter, trip)), 'the two paths are not one flight')
  const [row, other] = vm.routeRows
  const forFleet = (id) => orders.filter((one) => one.FleetID === id).flatMap((one) => [rp.orderEndpoint({ ...one, label: one.PopName || one.Description }), rp.orderExitEndpoint({ ...one, label: one.PopName || one.Description })])
  const expected = rp.routePositions(forFleet(5), { facts: UNSURE, adapters: rp.ADAPTERS })

  assert.deepEqual(canonical(row.positions), canonical(expected), 'a repeating route states its orders\' destinations through the gate, the bodies that move as flown to')
  assert.deepEqual(asJson(other.positions), asJson(rp.routePositions(forFleet(6), { facts: UNSURE })))
  assert.ok(row.year, 'the route has a year')
  Object.values(row.results).forEach((result) => statesPositions(result, expected, 'a figure of the route'))
  statesPositions(row.distanceResult, rp.routePositions(forFleet(5), { facts: UNSURE }), 'the route\'s distance')
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
  ['a failing adapter is not said', 'position', 'const kept = [...new Set([...base.conditions, \'propagation-unavailable\', ...(found && Array.isArray(found.reasons) ? found.reasons : [])])]', 'const kept = base.conditions', ['gate-adapter']],
  ['a failing adapter leaves the record propagated', 'position', 'return Object.freeze({ ...base, conditions: kept, unknown: true })', 'return Object.freeze({ ...base, basis: POSITION_BASIS.PROPAGATED, conditions: kept, unknown: true })', ['gate-adapter']],
  ['an adapter lifts what is not supported', 'position', 'supported: supported && found.supported !== false', 'supported: found.supported !== false', ['gate-adapter']],
  ['the mode is always static', 'position', 'return propagated === 0 ? ROUTE_MODE.STATIC : propagated === subjects.length ? ROUTE_MODE.PROPAGATED : ROUTE_MODE.MIXED', 'return ROUTE_MODE.STATIC', ['gate-adapter']],
  ['a place that never moves takes part in the mode whatever an adapter did for it', 'position', 'const subjects = records.filter((record) => record.moves !== false && !record.departure)', 'const subjects = records.filter((record) => (record.moves !== false || record.basis === POSITION_BASIS.PROPAGATED) && !record.departure)', ['gate-adapter']],
  ['a switch that is off leaves an asteroid undecided', 'position', 'const moves = planets === false || group === \'static\' ? false : group', 'const moves = group === \'static\' ? false : group', ['motion-switch']],
  ['an adapter that throws takes the route down', 'position', '} catch (error) {\n      found = null\n    }', '} catch (error) {\n      throw error\n    }', ['gate-adapter']],
  ['a position ahead of the game reads as its size', 'position', 'return seconds < 0 ? `${durationText(-seconds)} ahead` : durationText(seconds)', 'return durationText(Math.abs(seconds))', ['gate-adapter']],
  ['a position ahead of the game reads as current', 'position', '} else if (seconds === 0) {', '} else if (seconds <= 0) {', ['gate-adapter']],
  ['a fleet orbiting a body with no position follows it by default', 'position', 'when FCT_Fleet.OrbitBodyID > 0 and exists (select 1 from FCT_SystemBody where FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and (FCT_SystemBody.Xcor is null or FCT_SystemBody.Ycor is null)) then null ', '', ['loader-schema']],
  ['the summary lists the conditions of the first endpoint only', 'position', 'const codes = [...new Set(records.flatMap((record) => record.conditions))].sort()', 'const codes = [...new Set(records.slice(0, 1).flatMap((record) => record.conditions))].sort()', ['same-gate', 'legs-own-age']],
  ['a place is listed once for each stop', 'position', 'if (!kept) {\n      byKey.set(key, record)', 'if (!kept) {\n      byKey.set(`${key}#${byKey.size}`, record)', ['same-gate']],
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
  ['a leg leaves out the Lagrange points it jumps between', 'plan', ', ...viaEndpoints(route)], { facts, adapters: NO_ADAPTERS })', '], { facts, adapters: NO_ADAPTERS })', ['same-gate']],
  ['a leg is not given the facts', 'plan', ', ...viaEndpoints(route)], { facts, adapters: NO_ADAPTERS })', ', ...viaEndpoints(route)], { adapters: NO_ADAPTERS })', ['same-gate']],
  ['a leg is given the adapters the plan was handed', 'plan', '{ facts, adapters: NO_ADAPTERS })', '{ facts, adapters })', ['same-gate']],
  ['the plan states only its first leg', 'plan', 'summarisePositions(legs.flatMap((leg) => (leg.positions ? leg.positions.records : [])), { merge: true })', 'summarisePositions(legs.slice(0, 1).flatMap((leg) => (leg.positions ? leg.positions.records : [])), { merge: true })', ['same-gate']],
  ['a running distance leaves out the positions', 'plan', 'value: total, inputs: { present: ROUTE_INPUTS } }), positions)', 'value: total, inputs: { present: ROUTE_INPUTS } }))', ['same-gate', 'result-caveat']],
  ['a distance leaves out the positions', 'plan', ': unavailable({ rule: \'route.distanceKm\', missing: [missing] }), positions)', ': unavailable({ rule: \'route.distanceKm\', missing: [missing] }))', ['same-gate', 'result-caveat']],
  ['the read is tracked under another key', 'mixin', 'get: tracked(\'positionFacts\',', 'get: tracked(\'positionRead\',', ['optional-read']],
  ['the read is made for no race', 'mixin', 'return loadPositionFacts(database, { GameID, RaceID })', 'return loadPositionFacts(database, { GameID, RaceID: 2 })', ['optional-read']],
  ['the read holds back the state of a read that has failed', 'mixin', 'failed: joinLabels(failed.map(([key]) => POSITION_LABELS[key]))', 'failed: \'\'', ['optional-read']],
  ['the facts are used while the read is not in', 'mixin', 'if (this.loadErrors.positionFacts !== null) {', 'if (false) {', ['optional-read']],
  ['Route Finder does not label the read', 'routesPage', '  ...POSITION_LABELS,\n', '', ['optional-read']],
  ['Route Finder waits for the read', 'routesPage', '...POSITION_INPUTS', '', ['optional-read']],
  ['Transport does not label the read', 'transportPage', '  ...POSITION_LABELS,\n', '', ['optional-read']],
  ['Transport waits for the read', 'transportPage', '...POSITION_INPUTS', '', ['optional-read']],
  ['Hauling spends an order\'s delay after the arrival', 'haulingPage', 'delay: order.OrderDelay || 0, wait: handling.stops[index].seconds }', 'wait: handling.stops[index].seconds + (order.OrderDelay || 0) }', ['pages-hauling']],
  ['Hauling keeps a route simulation without the delay', 'haulingPage', 'hop.leave.key, hop.delay, hop.wait', 'hop.leave.key, hop.wait', ['pages-hauling']],
  ['Hauling keeps a haul simulation without its path', 'haulingPage', 'route.km, pathKey(steps), wait(\'origin\')', 'route.km, wait(\'origin\')', ['pages-hauling']],
  ['Transport keeps a run simulation without its path', 'transportPage', 'reach.route.km, path, this.useLagrange', 'reach.route.km, this.useLagrange', ['pages-transport']],
  ['Hauling\'s delivery total keeps the first fleet\'s record of a stop', 'haulingPage', 'summarisePositions(records, { merge: true })', 'summarisePositions(records)', ['pages-hauling-mixed']],
  ['Route Finder\'s running total keeps the first leg\'s record of a body', 'routesPage', 'const passed = summarisePositions(flown, { merge: true })', 'const passed = summarisePositions(flown)', ['pages-routes-mixed']],
  ['Hauling states a haul\'s distance with the positions of its flights', 'haulingPage', 'withPositions(this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : distanceResult(haul.km), positions)', 'withPositions(this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : distanceResult(haul.km), flights.length ? flights[0].flown.annual.positions : positions)', ['pages-saved-distance']],
  ['Hauling states a route\'s distance with the positions of its flights', 'haulingPage', 'withPositions(distanceResult(route.km), savedPositions)', 'withPositions(distanceResult(route.km), positions)', ['pages-saved-distance']],
  ['Hauling\'s plan strip leaves out the saved positions of the distances', 'haulingPage', 'this.planRows.flatMap((row) => row.savedRecords))', '[])', ['pages-saved-distance']],
  ['Hauling\'s route strip leaves out the saved positions of the distances', 'haulingPage', 'this.routeRows.flatMap((row) => row.savedPositions.records))', '[])', ['pages-saved-distance']],
  ['Transport states a fleet\'s distance with the positions of its flight', 'transportPage', 'const run = { ...base, ...this.safeFields(reach), ...this.ledgerFields(ledger), status,', 'const run = { ...base, ...this.safeFields(reach), ...this.ledgerFields(ledger), pathResult: withPositions(pathResult(reach.route, this.avoid), positions), status,', ['pages-saved-distance']],
  ['Transport\'s strip leaves out the saved positions of the distances', 'transportPage', 'withSavedComparison(flown, [...ends.records, ...saved])', 'withSavedComparison(flown, [...ends.records])', ['pages-position-matrix']],
  ['Hauling\'s plan strip lets a saved distance replace a flown colony', 'haulingPage', 'return withSavedComparison(this.planRows.flatMap((row) => row.positionRecords), this.planRows.flatMap((row) => row.savedRecords))', 'return summarisePositions([...this.planRows.flatMap((row) => row.positionRecords), ...this.planRows.flatMap((row) => row.savedRecords)], { merge: true })', ['pages-saved-distance']],
  ['Hauling\'s route strip lets a saved distance replace a flown stop', 'haulingPage', 'return withSavedComparison(this.routeRows.flatMap((row) => row.positions.records), this.routeRows.flatMap((row) => row.savedPositions.records))', 'return summarisePositions([...this.routeRows.flatMap((row) => row.positions.records), ...this.routeRows.flatMap((row) => row.savedPositions.records)], { merge: true })', ['pages-saved-distance']],
  ['Transport\'s strip lets a saved distance replace a flown endpoint', 'transportPage', 'return withSavedComparison(flown, [...ends.records, ...saved])', 'return withSavedComparison([...flown, ...ends.records, ...saved], [])', ['pages-saved-distance']],
  ['Route Finder\'s strip lets a table row replace a flown stop', 'routesPage', 'return withSavedComparison(this.plan.positions.records, this.distanceRows.flatMap((row) => (row.positions ? row.positions.records : [])))', 'return summarisePositions([...this.plan.positions.records, ...this.distanceRows.flatMap((row) => (row.positions ? row.positions.records : []))], { merge: true })', ['pages-routes-mixed']],
  ['a saved comparison replaces the simulated record of its endpoint', 'position', "${record.identity.key}${record.comparison ? '|saved' : ''}`", '${record.identity.key}`', ['pages-saved-distance', 'pages-routes-mixed']],
  ['a page strip keeps the first simulation\'s record of an endpoint', 'position', 'const flown = summarisePositions(simulated, { merge: true })', 'const flown = summarisePositions(simulated)', ['pages-hauling-mixed', 'pages-transport-mixed']],
  ['a saved departure is labelled propagated', 'position', 'if (found.departure) {', 'if (false) {', ['pages-routes-matrix']],
  ['a saved departure counts toward the strip\'s mode', 'position', 'record.moves !== false && !record.departure', 'record.moves !== false', ['pages-routes-matrix']],
  ['a refusal is counted against a saved departure', 'plan', 'const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED && !record.departure', 'const refused = (record) => record.basis !== POSITION_BASIS.PROPAGATED', ['pages-position-matrix']],
  ['Transport drops the comparison of a class row beyond the tank', 'transportPage', 'const timed = works || status === \'range\'', 'const timed = works', ['pages-position-matrix']],
  ['Transport drops the comparison of a fleet row beyond the tank', 'transportPage', '      const timed = runs\n      const left = ', '      const timed = works\n      const left = ', ['pages-position-matrix']],
  ['Transport counts the throughput of a row beyond the tank', 'transportPage', 'const throughput = !found.operational ? \'\'', 'const throughput = false ? \'\'', ['pages-position-matrix']],
  ['Hauling counts the throughput of a row beyond the tank', 'haulingPage', 'const throughput = used.status === \'ok\' ?', 'const throughput = true ?', ['pages-position-matrix']],
  ['Transport\'s strip rebuilds the saved ends by orbit', 'transportPage', 'const ends = routePositions([placeEndpoint(this.origin), placeEndpoint(this.destination)], { facts: this.positionRead })', 'const ends = routePositions([placeEndpoint(this.origin), placeEndpoint(this.destination)], { facts: this.positionRead, adapters: ADAPTERS })', ['pages-position-matrix']],
  ['a year in which nothing moves is stated propagated', 'plan', 'const status = unmoved || flownPositions.mode === ROUTE_MODE.STATIC ? \'static\' : \'propagated\'', 'const status = unmoved ? \'static\' : \'propagated\'', ['pages-endpoint-matrix']],
  ['a year in which nothing moves has a comparison', 'plan', 'compared: status === \'propagated\' || unmoved,', 'compared: true,', ['pages-endpoint-matrix']],
  ['a year of places that never move is capped', 'plan', 'const capped = everything.some((record) => record.moves !== false) && cycles.length', 'const capped = cycles.length', ['pages-endpoint-matrix']],
  ['a refusal at a place that never moves counts', 'plan', 'record.basis !== POSITION_BASIS.PROPAGATED && !record.departure && record.moves !== false', 'record.basis !== POSITION_BASIS.PROPAGATED && !record.departure', ['pages-endpoint-matrix']],
  ['a place that never moves states a refusal', 'position', '    if (base.moves === false) {\n      return Object.freeze({ ...base, unknown: base.conditions.length > 0 })\n    }\n\n', '', ['pages-endpoint-matrix']],
  ['a place that never moves is a propagated group', 'position', 'supported: supported && found.supported !== false, conditions: lasting, unknown: lasting.length > 0, assumption: base.moves === false ? base.assumption : \'propagated\' })', 'supported: supported && found.supported !== false, conditions: lasting, unknown: lasting.length > 0, assumption: \'propagated\' })', ['pages-endpoint-matrix']],
  ['a place that never moves is a departure group', 'position', 'assumption: base.moves === false ? base.assumption : \'departure\', departure: true })', 'assumption: \'departure\', departure: true })', ['pages-endpoint-matrix']],
  ['Transport states a comparison for a year in which nothing moves (class row)', 'transportPage', '}))), statusSort: works ? 0 : 1, simulation, propagation: timed && simulation && simulation.annual.compared ?', '}))), statusSort: works ? 0 : 1, simulation, propagation: timed && simulation ?', ['pages-endpoint-matrix']],
  ['Transport states a comparison for a year in which nothing moves (fleet row)', 'transportPage', 'participantRows(profile, known ? trip : null), statusSort: works ? 0 : 1, simulation, propagation: timed && known && simulation && simulation.annual.compared ?', 'participantRows(profile, known ? trip : null), statusSort: works ? 0 : 1, simulation, propagation: timed && known && simulation ?', ['pages-endpoint-matrix']],
  ['Hauling states a comparison for a haul in which nothing moves', 'haulingPage', 'if (!positionRead || !timed || (flown && !flown.annual.compared)) {', 'if (!positionRead || !timed) {', ['pages-endpoint-matrix']],
  ['Hauling states a comparison for a route in which nothing moves', 'haulingPage', '    routeNote(simulation, year, held) {\n      if (!simulation.annual.compared) {\n        return \'\'\n      } else if (simulation.annual.status !== \'propagated\') {', '    routeNote(simulation, year, held) {\n      if (simulation.annual.status !== \'propagated\') {', ['pages-endpoint-matrix']],
  ['an asteroid with its own switch off is unknown', 'position', 'group === \'asteroid\' ? (rocks === false ? false : both)', 'group === \'asteroid\' ? both', ['motion-matrix', 'motion-switch', 'pages-disabled-asteroid', 'pages-endpoint-matrix']],
  ['a switch that was never read settles an asteroid', 'position', 'group === \'asteroid\' ? (rocks === false ? false : both)', 'group === \'asteroid\' ? (rocks !== true ? false : both)', ['motion-matrix', 'motion-switch']],
  ['a Lagrange point ignores the body it rides', 'orbit', 'endpoint.family === \'lagrange-point\' ? ((orbits.points || {})[endpoint.id] || {}).planetId : endpoint.id', 'endpoint.id', ['motion-matrix']],
  ['a body of unread orbits is a planet when the picker calls it an asteroid or names no group', 'position', "!NON_ASTEROID_GROUPS.includes(endpoint.group) ? 'unknown' : endpoint.group", "endpoint.group === 'asteroid' ? 'asteroid' : endpoint.group", ['motion-matrix', 'motion-switch', 'loader-motion-matrix']],
  ['a fleet orbiting a body takes the body for a planet', 'position', 'orbitMotion({ group: kindGroup(found.group) }, facts, conditions), assumption: mayMove', 'orbitMotion(endpoint, facts, conditions), assumption: mayMove', ['loader-motion-matrix']],
  ['a waypoint of unread kind follows the asteroid switch alone', 'position', '[\'planet\', \'asteroid\', \'static\'].includes(group) ? group : \'unknown\'', '[\'planet\', \'asteroid\', \'static\'].includes(group) ? group : \'asteroid\'', ['motion-matrix', 'waypoint-carried', 'loader-motion-matrix']],
  ['a colony on an asteroid is picked as a planet', 'orbit', 'return body ? motionOf(orbits.bodies, id) : null', 'return body ? \'planet\' : null', ['motion-matrix', 'loader-motion-matrix']],
  ['a trojan is the group of a class 3 body, whatever its parent moves by', 'orbit', '  } else if (body.trojan !== 0 && body.parentId > 0) {\n    return motionOf(bodies, body.parentId, depth + 1)\n  }', '  } else if (false) {\n    return motionOf(bodies, body.parentId, depth + 1)\n  }', ['loader-motion-matrix', 'motion-matrix', 'waypoint-owner-results']],
  ['a trojan of an asteroid is a planet', 'orbit', '  } else if (body.trojan !== 0 && body.parentId > 0) {\n    return motionOf(bodies, body.parentId, depth + 1)\n  }', '  } else if (body.trojan !== 0 && body.parentId > 0) {\n    return \'planet\'\n  }', ['loader-motion-matrix']],
  ['a fixed body with a fixed parent is taken for one that stays', 'orbit', 'return motionOf(bodies, body.fixedParentId, depth + 1)', 'return \'static\'', ['loader-motion-matrix', 'fixed-proxy-results', 'motion-matrix']],
  ['a fixed body whose parent was not read is taken for one that stays', 'orbit', 'if (fixed && !isNumber(body.fixedParentId)) {\n    return \'unknown\'', 'if (fixed && !isNumber(body.fixedParentId)) {\n    return \'static\'', ['loader-motion-matrix', 'motion-matrix']],
  ['every fixed body stays', 'orbit', 'return fixed ? \'static\' : \'asteroid\'\n}', 'return \'asteroid\'\n}', ['loader-motion-matrix', 'fixed-proxy-results']],
  ['a fixed class 3 body with no parent moves as an asteroid does', 'orbit', '  return fixed ? \'static\' : \'asteroid\'\n}', '  return fixed ? \'asteroid\' : \'asteroid\'\n}', ['loader-motion-matrix', 'motion-matrix', 'fixed-proxy-results']],
  ['a class 3 body whose fixed flag was not read is taken for one that is not fixed', 'orbit', 'body.bodyClass !== 3 || !isNumber(body.trojan) || !isNumber(body.fixed)', 'body.bodyClass !== 3 || !isNumber(body.trojan)', ['loader-motion-matrix']],
  ['a class 3 body whose trojan angle was not read is taken for no trojan', 'orbit', 'body.bodyClass !== 3 || !isNumber(body.trojan) || !isNumber(body.fixed)', 'body.bodyClass !== 3 || !isNumber(body.fixed)', ['loader-motion-matrix']],
  ['a trojan whose parent was not read is an independent asteroid', 'orbit', '} else if (body.trojan !== 0 && !isNumber(body.parentId)) {\n    return \'unknown\'', '} else if (body.trojan !== 0 && !isNumber(body.parentId)) {\n    return \'asteroid\'', ['loader-motion-matrix']],
  ['the orbit read leaves out the fixed parent of a body', 'orbit', 'fixedParentId: numberOrNull(row.FixedBodyParentID)', 'fixedParentId: 0', ['loader-motion-matrix', 'fixed-proxy-results']],
  ['the orbit read does not follow the fixed parent of a body', 'orbit', ';[row.ParentBodyID, row.FixedBodyParentID].filter', ';[row.ParentBodyID].filter', ['loader-motion-matrix', 'fixed-proxy-results']],
  ['the position read does not follow the fixed parent of a body', 'position', 'pending.push(...[known[row.SystemBodyID].parentId, known[row.SystemBodyID].fixedParentId])', 'pending.push(...[known[row.SystemBodyID].parentId])', ['loader-motion-matrix']],
  ['the position read leaves out the fixed parent column', 'position', '${body.has(\'FixedBodyParentID\') ? \'FCT_SystemBody.FixedBodyParentID\' : \'null\'} as FixedParent', 'null as FixedParent', ['loader-motion-matrix', 'fixed-proxy-results']],
  ['a column the save lacks reads as 0 in the position read', 'position', 'const stored = (name, value) => (body.has(name) ? Number(value || 0) : null)', 'const stored = (name, value) => (body.has(name) ? Number(value || 0) : 0)', ['loader-motion-matrix']],
  ['a body that stays moves with the planet switch', 'position', 'planets === false || group === \'static\' ? false', 'planets === false ? false', ['loader-motion-matrix', 'motion-matrix', 'fixed-proxy-results']],
  ['a waypoint carried by an asteroid ignores its switch', 'position', 'const moves = orbitMotion({ group: kindGroup(found.group) }', 'const moves = orbitMotion({ group: \'planet\' }', ['waypoint-carried', 'loader-motion-matrix']],
  ['Hauling does not label the read', 'haulingPage', '  ...POSITION_LABELS,\n', '', ['optional-read']],
  ['Hauling waits for the read', 'haulingPage', '...POSITION_INPUTS', '', ['optional-read']],
  ['Route Finder plans without the facts', 'routesPage', 'facts: this.positionRead, ', '', ['pages-routes']],
  ['Route Finder states a stop row\'s leg time without its positions', 'routesPage', 'result: leg.route ? this.travelResult(leg.route.km, leg.positions) :', 'result: leg.route ? this.travelResult(leg.route.km) :', ['pages-routes']],
  ['Route Finder states a leg\'s detail time without its positions', 'routesPage', 'withoutWaits(this.travelResult(leg.route.km, leg.positions), this.plan.time.missing)', 'withoutWaits(this.travelResult(leg.route.km), this.plan.time.missing)', ['pages-routes']],
  ['Route Finder states a running distance without the legs flown', 'routesPage', 'totalResult: detailTotal(total, skipped, passed)', 'totalResult: detailTotal(total, skipped)', ['pages-routes']],
  ['Route Finder states a distance flown in a system without its positions', 'routesPage', 'kmResult: distanceResult(step.km, undefined, leg.positions)', 'kmResult: distanceResult(step.km)', ['pages-routes']],
  ['Route Finder counts only the leg flown for the running distance', 'routesPage', 'flown.push(...(leg.positions ? leg.positions.records : []))', 'flown.splice(0, flown.length, ...(leg.positions ? leg.positions.records : []))', ['pages-routes']],
  ['Route Finder states a system\'s distance without its positions', 'routesPage', 'const kmResult = withPositions(figures.km, positions)', 'const kmResult = figures.km', ['pages-routes']],
  ['Route Finder leaves the positions out of a travel result', 'routesPage', 'travelTime(distanceResult(km, undefined, positions), this.speedResult)', 'travelTime(distanceResult(km), this.speedResult)', ['pages-routes']],
  ['Route Finder does not show the strip', 'routesPage', / (?:@retry|v-on:retry)="retryPosition"/, () => '', ['strip-bound']],
  ['Transport leaves a class\'s time as it was', 'transportPage', 'provenance: withPositions(tripResult(trip), positions)', 'provenance: tripResult(trip)', ['pages-transport']],
  ['Transport leaves a fleet\'s time as it was', 'transportPage', 'provenance: withPositions(fleetTripResult(trip, profile), positions)', 'provenance: fleetTripResult(trip, profile)', ['pages-transport']],
  ['Transport leaves a run\'s distance as it was', 'transportPage', 'return withPositions(this.avoid.active ? pathResult(reach.route, this.avoid) : distanceResult(reach.route.km), positions)', 'return this.avoid.active ? pathResult(reach.route, this.avoid) : distanceResult(reach.route.km)', ['pages-transport']],
  ['Transport states a class\'s distance only with an avoid setting', 'transportPage', 'if (!this.avoid.active && !positions.caveat) {', 'if (!this.avoid.active) {', ['pages-transport']],
  ['Transport leaves out the Lagrange points of the route', 'transportPage', ', ...viaEndpoints(reach.route)]', ']', ['pages-transport']],
  ['Transport states no destination', 'transportPage', 'routePositions([placeEndpoint(this.origin), placeEndpoint(this.destination), ...viaEndpoints', 'routePositions([placeEndpoint(this.origin), ...viaEndpoints', ['pages-transport']],
  ['Transport does not bind the strip', 'transportPage', ' :state="positionState"', '', ['strip-bound']],
  ['Hauling leaves a haul\'s time as it was', 'haulingPage', 'const result = withPositions(tripResult(estimate), flown ? flown.annual.positions : positions)', 'const result = tripResult(estimate)', ['pages-hauling']],
  ['Hauling leaves a haul\'s distance as it was', 'haulingPage', 'withPositions(this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : distanceResult(haul.km), positions)', 'this.avoid.active ? pathResult({ km: haul.km }, this.avoid) : distanceResult(haul.km)', ['pages-hauling']],
  ['Hauling leaves a route\'s figures as they were', 'haulingPage', '[name, withPositions(result, positions)]', '[name, result]', ['pages-hauling']],
  ['Hauling leaves a route\'s distance as it was', 'haulingPage', 'withPositions(distanceResult(route.km), savedPositions)', 'distanceResult(route.km)', ['pages-hauling']],
  ['Hauling states a route without its orders', 'haulingPage', 'routePositions(orders.flatMap((order) => [orderEndpoint(order), orderExitEndpoint(order)]), { facts: this.positionRead })', 'routePositions([], { facts: this.positionRead })', ['pages-hauling']],
  ['Hauling\'s strip states only the first haul', 'haulingPage', 'return withSavedComparison(this.planRows.flatMap((row) => row.positionRecords), this.planRows.flatMap((row) => row.savedRecords))', 'return withSavedComparison(this.planRows.slice(0, 1).flatMap((row) => row.positionRecords), this.planRows.slice(0, 1).flatMap((row) => row.savedRecords))', ['pages-hauling']],
  ['Hauling\'s strip states only the first route', 'haulingPage', 'return withSavedComparison(this.routeRows.flatMap((row) => row.positions.records), this.routeRows.flatMap((row) => row.savedPositions.records))', 'return withSavedComparison(this.routeRows.slice(0, 1).flatMap((row) => row.positions.records), this.routeRows.slice(0, 1).flatMap((row) => row.savedPositions.records))', ['pages-hauling']],
  ['Hauling does not bind the plan strip', 'haulingPage', /<route-positions(?=[^>]*:positions="planPositions")([^>]*?) :state="positionState"([^>]*>)/, (m) => `<route-positions${m[1]}${m[2]}`, ['strip-bound']],
  ['Hauling does not bind the routes strip', 'haulingPage', /<route-positions(?=[^>]*:positions="fleetPositions")([^>]*?) :state="positionState"([^>]*>)/, (m) => `<route-positions${m[1]}${m[2]}`, ['strip-bound']],
  ['the strip shows an age while the read is in flight', 'component', 'return this.state.loading ? null : ageResult(this.positions)', 'return ageResult(this.positions)', ['strip-component']],
  ['the strip has no retry', 'component', '@click="$emit(\'retry\')"', '', ['strip-component']],
  ['the strip does not mark the age', 'component', ':result="age"', '', ['strip-component']],
  ['Route Finder\'s strip leaves out the routes of the distance table', 'routesPage', ', this.distanceRows.flatMap((row) => (row.positions ? row.positions.records : [])))', ', [])', ['pages-routes']],
  ['Route Finder\'s strip states the plan\'s legs only', 'routesPage', 'return withSavedComparison(this.plan.positions.records, this.distanceRows.flatMap((row) => (row.positions ? row.positions.records : [])))', 'return this.plan.positions', ['pages-routes']],
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
  ['Hauling leaves a delivery total as it was', 'haulingPage', 'result: withPositions(ofRule({ rule: \'hauling.deliveries\', value: total.amount, units: total.kind === \'colonists\' ? \'colonists/yr\' : \'t/yr\', inputs: { present: [\'the saved orders of the fleets\'] } }), summarisePositions(records, { merge: true }))', 'result: ofRule({ rule: \'hauling.deliveries\', value: total.amount, units: total.kind === \'colonists\' ? \'colonists/yr\' : \'t/yr\', inputs: { present: [\'the saved orders of the fleets\'] } })', ['pages-hauling']],
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
  ['a waypoint carried by a body always moves', 'position', 'const moves = orbitMotion({ group: kindGroup(found.group) }, facts, conditions)', 'const moves = true', ['waypoint-carried']],
  ['the read leaves out the orbit of a waypoint', 'position', 'FCT_Waypoint.OrbitBodyID as Orbit', '0 as Orbit', ['loader-schema']],
  ['the read of waypoints takes every race\'s', 'position', ' from FCT_Waypoint where FCT_Waypoint.GameID = :GameID and FCT_Waypoint.RaceID = :RaceID', ' from FCT_Waypoint where FCT_Waypoint.GameID = :GameID', ['loader-schema']],
  ['an association stored as null reads as none', 'position', 'orbit: row.Orbit === null || row.Orbit === undefined ? null : Number(row.Orbit)', 'orbit: Number(row.Orbit)', ['loader-schema']],
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
  ['the timed order is flown on adapters', 'plan', /const flight = (?:timed \|\| !flightClock\(held, speed\) \? null : flightOf\(\{ facts, adapters, speed \}\)|!timed && flightClock\(held, speed\) \? flightOf\(\{ facts, adapters, speed \}\) : null)/, () => 'const flight = flightOf({ facts, adapters, speed })', ['timed-basis', 'timed-clock']],
  ['a plan that waits for the jump shock is flown on adapters', 'plan', '(plan.time.wait.hi === 0 && plan.time.flightHi', '(plan.time.flightHi', ['timed-clock']],
  ['a plan flown at a cap is flown on adapters', 'plan', ' && plan.time.flightHi === plan.time.flight && Math.abs(plan.time.flight * speed - plan.km) <= 1e-9 * plan.km)', ')', ['timed-clock']],
  ['a plan that is the flight alone is not flown on adapters', 'plan', /const flight = (?:timed \|\| !flightClock\(held, speed\) \? null : flightOf\(\{ facts, adapters, speed \}\)|!timed && flightClock\(held, speed\) \? flightOf\(\{ facts, adapters, speed \}\) : null)/, () => 'const flight = true ? null : flightOf({ facts, adapters, speed })', ['timed-clock']],
  ['a cycle that waits is flown on the bodies\' arrivals', 'plan', 'const clockHeld = timed && everything', 'const clockHeld = false && everything', ['timed-clock', 'pages-transport', 'pages-hauling']],
  ['a cycle on the saved positions does not say so', 'plan', '...(clockHeld ? [\'timed-clock\'] : [])', '...[]', ['timed-clock']],
  ['the first pass of a cycle on the saved positions is the flown one', 'plan', 'const firstKm = clockHeld ? held : cycles[0].km', 'const firstKm = cycles[0].km', ['timed-clock']],
  ['a cycle that does not wait is held on the saved positions', 'plan', 'const clockHeld = timed && everything.some(', 'const clockHeld = everything.some(', ['timed-clock', 'pages-hauling']],
  ['Hauling does not hand the elapsed time of the cycle to the year', 'haulingPage', 'adapters: ADAPTERS, speed: sailing.Speed, timed }', 'adapters: ADAPTERS, speed: sailing.Speed }', ['pages-hauling']],
  ['Hauling takes every cycle for the flight alone', 'haulingPage', 'const timed = !flightOnly(walk, sailing.Speed)', 'const timed = false', ['pages-hauling']],
  ['Transport does not hand the elapsed time of the cycle to the year', 'transportPage', 'speed, lagrangePoints, timed }', 'speed, lagrangePoints }', ['pages-transport']],
  ['Transport takes every cycle for the flight alone', 'transportPage', 'const timed = !flightOnly(trip.cycle, speed)', 'const timed = false', ['pages-transport']],
  ['the elapsed time leaves out the positions', 'plan', 'const made = (result) => withPositions(partial(result), plan.positions)', 'const made = (result) => partial(result)', ['timed-basis']],
  ['a plan that gains a wait on the moved bodies is flown on them', 'plan', 'if (!flightClock(moved, speed)) {', 'if (false) {', ['timed-clock']],
  ['Hauling flies a cycle that gains a wait on the moved bodies on them', 'haulingPage', 'const simulation = flownWalk && !flightOnly(flownWalk, sailing.Speed) ? this.simulateRoute(orders, sailing, handling, held, flownWalk) : first', 'const simulation = first', ['pages-hauling']],
  ['Transport flies a round trip that gains a wait on the moved bodies on them', 'transportPage', 'const simulation = flownTrip && !flightOnly(flownTrip.cycle, profile.cruise) ? this.simulate(reach, profile.cruise, flownTrip) : first', 'const simulation = first', ['pages-transport']],
  ['a deep space population order names a family the contract does not keep', 'position', '\'aether-gate\', 15: \'body\' })', '\'aether-gate\', 15: \'deep-space-population\' })', ['fixed-body-order']],
  ['a deep space population order is a life pod', 'position', '\'aether-gate\', 15: \'body\' })', '\'aether-gate\', 15: \'lifepod\' })', ['fixed-body-order']],
  ['a family is kept for a deep space population no order reaches', 'position', '  lifepod: { clock: \'none\', motion: \'drift\', supported: false },\n', '  lifepod: { clock: \'none\', motion: \'drift\', supported: false },\n  \'deep-space-population\': { clock: \'none\', motion: \'drift\', supported: false },\n', ['fixed-body-order']],
  ['a place that never moves is not supported', 'position', 'spec.supported !== false && !conditions.includes(\'stale-contact\')', 'spec.supported !== false && state.moves !== false && !conditions.includes(\'stale-contact\')', ['fixed-body-order', 'motion-matrix']],
  ['a Lagrange point moves with an owner that is no planet or moon', 'orbit', 'if (body && endpoint.family === \'lagrange-point\' && ', 'if (false && body && endpoint.family === \'lagrange-point\' && ', ['lagrange-owner-class', 'motion-matrix']],
  ['a Lagrange point stays only with an asteroid owner', 'orbit', 'isNumber(body.bodyClass) && !POINT_OWNER_CLASSES.includes(body.bodyClass)', 'body.bodyClass === 3', ['lagrange-owner-class']],
  ['a Lagrange point of a body that is no planet or moon is propagated', 'orbit', 'if (!POINT_OWNER_CLASSES.includes(body.bodyClass)) {', 'if (false && !POINT_OWNER_CLASSES.includes(body.bodyClass)) {', ['lagrange-owner-class']],
]
/* eslint-enable no-template-curly-in-string */

// ---- Benign edits ----------------------------------------------------------------------------------------------------
// Edits that change nothing the checks look at: the wording of an assumption, a condition, a mode and a label, the order of the attributes of the strip and of the lists, and a panel's summary. Each is located by the attribute, key or code it belongs to, never by what it holds now.
const STRING = '\'[^\'\\n]*\''

const BENIGN = [
  { label: 'an assumption reworded with its qualifier moved last', target: 'position', at: new RegExp(`(\\n {2}fixed: )${STRING}`), to: (m) => `${m[1]}'the saved position is exact at any time, as the place stays where it is'` },
  { label: 'a condition reworded', target: 'position', at: new RegExp(`(\\n {2}'fleet-orders': )${STRING}`), to: (m) => `${m[1]}'orders are queued for the fleet and where it goes is not known'` },
  { label: 'a mode label reworded', target: 'component', at: new RegExp(`(\\n {2}static: )${STRING}`), to: (m) => `${m[1]}'Positions as the save stores them'` },
  { label: 'the label of the read reworded', target: 'mixin', at: new RegExp(`(\\n {2}positionFacts: )${STRING}`), to: (m) => `${m[1]}'when each saved position was stored'` },
  { label: 'the strip attributes reordered and its retry written with v-on longhand', target: 'routesPage', at: /<route-positions (:positions="[^"]*") (:state="[^"]*") (class="[^"]*") (@retry="[^"]*") \/>/, to: (m) => `<route-positions ${m[4].replace('@retry', 'v-on:retry')} ${m[3]} ${m[2]} ${m[1]} />` },
  { label: 'the attributes of the strip of Transport reordered', target: 'transportPage', at: /<route-positions (v-if="[^"]*") (:positions="[^"]*") (:state="[^"]*") (class="[^"]*") (@retry="[^"]*") \/>/, to: (m) => `<route-positions ${m[5]} ${m[4]} ${m[3]} ${m[2]} ${m[1]} />` },
  { label: 'the attributes of the strip of Hauling plan reordered', target: 'haulingPage', at: /<route-positions (v-if="planPositions[^"]*") (:positions="planPositions") (:state="[^"]*") (class="[^"]*") (@retry="[^"]*") \/>/, to: (m) => `<route-positions ${m[5]} ${m[4]} ${m[3]} ${m[2]} ${m[1]} />` },
  { label: 'the summary of the Hauling plan panel reworded', target: 'haulingPage', at: /(<v-card class="panel" data-summary=")[^"]*("[^>]*>(?:(?!<v-card class="panel")[\s\S])*?:items="planRows")/, to: (m) => `${m[1]}Hauls that would cover what colonies lack, from the nearest colony with stock, and what each freighter class takes${m[2]}` },
  { label: 'the attributes of the Hauling plan panel reordered', target: 'haulingPage', at: /<v-card class="panel" (data-summary="[^"]*") (elevation="1")([^>]*)>((?:(?!<v-card class="panel")[\s\S])*?:items="planRows")/, to: (m) => `<v-card class="panel" ${m[2]} ${m[1]}${m[3]}>${m[4]}` },
  { label: 'the optional inputs of Transport listed in the opposite order', target: 'transportPage', at: /(const OPTIONAL_INPUTS = )\[('[^']*'(?:, '[^']*')*), (\.\.\.POSITION_INPUTS)\]/, to: (m) => `${m[1]}[${m[3]}, ${m[2].split(', ').reverse().join(', ')}]` },
  { label: 'the optional inputs of Hauling listed in the opposite order', target: 'haulingPage', at: /(const OPTIONAL_INPUTS = )\[('[^']*'(?:, '[^']*')*), (\.\.\.DESIRE_INPUTS), (\.\.\.POSITION_INPUTS)\]/, to: (m) => `${m[1]}[${m[4]}, ${m[3]}, ${m[2].split(', ').reverse().join(', ')}]` },
  { label: 'the label of a position that is current reworded', target: 'position', at: /(\} else if \(seconds === 0\) \{\n {4}return )'[^'\n]*'/, to: (m) => `${m[1]}'at the save time'` },
  { label: 'the label of an age that is not read reworded', target: 'position', at: /(if \(!isTime\(seconds\)\) \{\n {4}return )'[^'\n]*'/, to: (m) => `${m[1]}'not recorded'` },
  { label: 'the label of an age the strip does not read reworded', target: 'component', at: /(this\.age && this\.age\.status !== 'unavailable' \? ageText\(this\.age\.value\) : )'[^'\n]*'/, to: (m) => `${m[1]}'not recorded'` },
  { label: 'the comment on a group that needs both switches reworded', target: 'position', at: /(and an 'unknown' one needs )both\./, to: (m) => `${m[1]}both switches on.` },
  { label: 'the fixed-parent condition parenthesised with its conjuncts reordered', target: 'orbit', at: /\} else if \(fixed && body\.fixedParentId > 0\) \{/, to: () => '} else if ((body.fixedParentId > 0) && fixed) {' },
  { label: 'the timed test of a plan written as its negation', target: 'plan', at: /const flight = (?:timed \|\| !flightClock\(held, speed\) \? null : (flightOf\(\{ facts, adapters, speed \}\))|!timed && flightClock\(held, speed\) \? (flightOf\(\{ facts, adapters, speed \}\)) : null)/, to: (m) => `const flight = !timed && flightClock(held, speed) ? ${m[1] || m[2]} : null` },
  { label: 'the condition of a life pod reworded', target: 'position', at: new RegExp(`(\\n {2}'drift-unobserved': )${STRING}`), to: (m) => `${m[1]}'no motion of a life pod is recorded by the save'` },
  { label: 'the owner class test of a Lagrange point parenthesised with its conjuncts reordered', target: 'orbit', at: /isNumber\(body\.bodyClass\) && !POINT_OWNER_CLASSES\.includes\(body\.bodyClass\)/, to: () => '(!POINT_OWNER_CLASSES.includes(body.bodyClass)) && isNumber(body.bodyClass)' },
].map((edit, index) => ({ ...edit, id: `benign:${index}` }))

const STANDALONE = new Set([
  'benign:0',
  'benign:4',
  'benign:9',
  'benign:15',
])

// Composed faults keep each reader under the rewrites too: utility and loader branches, page inputs, computed rows and summaries, and each independently bound template field.
const COMPOSED = new Set([
  0,
  1,
  8,
  11,
  21,
  22,
  26,
  37,
  45,
  49,
  51,
  53,
  55,
  56,
  57,
  58,
  59,
  60,
  61,
  62,
  63,
  65,
  66,
  67,
  68,
  70,
  71,
  73,
  74,
  75,
  79,
  86,
  87,
  88,
  89,
  90,
  92,
  94,
  95,
  96,
  97,
  99,
  106,
  107,
  108,
  112,
  113,
  116,
  117,
  118,
  119,
  121,
  123,
  124,
  125,
  126,
  130,
  131,
  132,
  133,
  134,
  135,
  136,
  137,
  138,
  139,
  140,
  141,
  142,
  145,
  146,
  147,
  148,
  150,
  151,
  152,
  ...Array.from({ length: 10 }, (_, index) => 157 + index),
  167,
  168,
  179,
  180,
  ...Array.from({ length: 9 }, (_, index) => 183 + index),
  193,
  195,
  197,
  198,
  199,
  201,
  202,
  203,
  206,
  210,
  213,
  218,
  222,
  223,
  224,
  225,
  226,
  227,
  228,
  232,
  236,
  238,
  240,
  244,
  247,
  248,
])

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

// The checks a fault is credited to only when they fail on a value, not on the code under test throwing.
const BY_VALUE = new Set(['timed-basis', 'timed-clock', 'fixed-body-order', 'lagrange-owner-class'])

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const main = async () => {
  const mutate = !process.argv.includes('--no-mutations')
  const only = process.argv.find((argument) => argument.startsWith('--only='))
  const selected = only ? only.slice('--only='.length).split('|').filter(Boolean) : []
  const keep = (key, label) => !only || selected.some((text) => key === text || label.includes(text))
  const detail = process.argv.includes('--detail')
  const began = performance.now()
  const failures = await run(CHECKS, worldOf())

  if (detail) {
    console.log(`TIME head: ${((performance.now() - began) / 1000).toFixed(3)} s; RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`)
  }

  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))

    FAULTS.forEach(([label, , , , fails]) => fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`)))
    const covered = new Set(FAULTS.flatMap(([, , , , fails]) => fails))

    CHECKS.forEach(({ name }) => assert.ok(covered.has(name), `${name}: no planted fault names this check`))
    const composedCoverage = new Set(FAULTS.flatMap(([, , , , fails], index) => COMPOSED.has(index) ? fails : []))

    CHECKS.forEach(({ name }) => assert.ok(composedCoverage.has(name), `${name}: no composed fault names this check`))

    const stages = [
      ...BENIGN.filter((edit) => STANDALONE.has(edit.id) && keep(edit.id, edit.label)).map((edit) => [`benign edit kept: ${edit.label}`, async () => (await run(CHECKS, worldOf([edit]))).map(describeFailure)]),
      ...(keep('benign:all', 'every benign edit applied') ? [['every benign edit applied: every check stays green', async () => (await run(CHECKS, worldOf(BENIGN))).map(describeFailure)]] : []),
    ]
    const benign = await inParallel(stages, async ([label, test]) => {
      const began = performance.now()

      try {
        return await test()
      } finally {
        if (detail) {
          console.log(`TIME ${label}: ${((performance.now() - began) / 1000).toFixed(3)} s; RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`)
        }
      }
    })

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

    const attempts = FAULTS.flatMap(([label, target, from, to, fails], index) => {
      const planted = from instanceof RegExp ? { target, at: from, to } : { target, from, to }

      return [
        ...(keep(`fault:${index}`, label) ? [[label, [planted], fails]] : []),
        ...(COMPOSED.has(index) && keep(`composed:${index}`, `${label}, on the sources with every benign edit`) ? [[`${label}, on the sources with every benign edit`, [...BENIGN, planted], fails]] : []),
      ]
    })
    const outcomes = await inParallel(attempts, async ([label, edits, fails]) => {
      const began = performance.now()
      const world = worldOf(edits)
      const missed = []

      for (const name of fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), world)

        if (!failed || (BY_VALUE.has(name) && !(failed.error instanceof assert.AssertionError))) {
          missed.push(name)
        }

        if (detail && failed) {
          console.log(`CAUGHT ${label}: ${describeFailure(failed)}`)
        }
      }

      if (detail) {
        console.log(`TIME planted fault ${label}: ${((performance.now() - began) / 1000).toFixed(3)} s; RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`)
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
