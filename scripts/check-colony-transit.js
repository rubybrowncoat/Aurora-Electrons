/* eslint-disable no-template-curly-in-string */
/*
  Checks the Colonization Planner's transit estimate (src/renderer/utilities/colony-transit.js, with the loaders of colonization-data.js and the search of jump-graph.js it rests on) on worked fixtures and, read-only, on the jump points, Lagrange points, colonies, bodies and ship classes the saves hold.

  bun scripts/check-colony-transit.js [--no-mutations] [--save <save.db> <GameID> <RaceID>]...

  Fixtures: a graph of systems with two chains of three jumps whose legs inside each system differ (the same jump count, a distinct distance and a distinct time), a link charted but not explored, a link whose far side is not charted, stabilised points on the departure side only, a route that is shortest in kilometres with more jumps than the fewest-jump one, a point flagged to be ignored for distance, Lagrange points that shorten a leg, that do not, and a single one. Statements: an unknown route is unknown and never 0 (state, figures, results, sort values, the table's order whichever way it runs), a blank or non-positive speed leaves the time unknown while the distance stays, a changed speed rescales the time and nothing else, a changed drive changes what can be crossed, and no speed, drive or Lagrange setting reaches a system or a jump point the race does not know (compared with a walk over the graph written another way).

  Saves: the loaders against queries written another way; every basis against an independent walk over the raw charted and explored jump points; the same jump count with different system legs in the save's own graph; the speed that only rescales; Lagrange routing that never lengthens a route; the km route equal to the app's Distance column basis; the ship classes' drives. A save that is not there is reported as skipped and never counted as passed.

  Mutations: each planted fault must fail the checks it names, and every one names a fixture check so that it is caught with no save there. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilities = path.join(root, 'src', 'renderer', 'utilities')
const NAMES = ['colony-transit', 'jump-graph', 'provenance', 'transport', 'colonization-data']
const DEFAULT_SAVES = [
  { label: 'modded', file: 'AuroraDB.db', game: 140, race: 784 },
  { label: 'stock', file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
// The parts run as children of the one that was started, so the saves given on its command line reach them through the environment.
const SAVES = process.env.COLONY_TRANSIT_SAVES ? JSON.parse(process.env.COLONY_TRANSIT_SAVES) : DEFAULT_SAVES
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/groupBy': 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})',
}
const T = 'colony-transit'
const J = 'jump-graph'
const D = 'colonization-data'

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  if (result && result.skipped) {
    console.log(`SKIP  ${name}  [${result.skipped}]`)

    return
  }

  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const skip = (reason) => ({ skipped: reason })

// A save-backed statement that passes gives `[true, detail]`, which reads as a pass with the detail.
const sorted = (values) => [...values].sort((a, b) => a - b)
const same = (actual, expected) => assert.deepStrictEqual(actual, expected)
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`)

// ---------- the fixture graph ----------

const M = 1e6
const SECONDS_PER_DAY = 86400
const KM_PER_AU = 149600000

const jp = (id, system, link, x, y, over = {}) => ({ WarpPointID: id, SystemID: system, WPLink: link, Distance: 0, Xcor: x, Ycor: y, JumpGateStrength: 0, Explored: 1, MilitaryRestricted: 0, IgnoreForDistance: 0, ...over })

// System 1 holds the colony. Chain X (11, 22, 32) and chain Y (12, 52, 62) are each three jumps long to systems 4 and 7; X is stabilised at 11 and 22 on the departure side. 13 is charted but not explored (system 8 lies behind it), 14 is explored but its far side is not charted (system 9). 15 is a direct jump to system 10, 16 and 112 the two-jump way to it that is shorter in kilometres. 17 is not stabilised but its far side 121 is.
const JUMP_POINTS = [
  jp(11, 1, 21, 1 * M, 0, { JumpGateStrength: 5 }),
  jp(21, 2, 11, 0, 0),
  jp(22, 2, 31, 3 * M, 0, { JumpGateStrength: 5 }),
  jp(31, 3, 22, 0, 0),
  jp(32, 3, 41, 4 * M, 0),
  jp(41, 4, 32, 0, 0),
  jp(12, 1, 51, 0, 2 * M),
  jp(51, 5, 12, 0, 0),
  jp(52, 5, 61, 0.1 * M, 0),
  jp(61, 6, 52, 0, 0),
  jp(62, 6, 71, 0.2 * M, 0, { IgnoreForDistance: 1 }),
  jp(71, 7, 62, 0, 0),
  jp(13, 1, 81, 0, -1 * M, { Explored: 0 }),
  jp(81, 8, 13, 0, 0),
  jp(14, 1, 91, 0.5 * M, 0.5 * M),
  jp(15, 1, 101, 0, -30 * M),
  jp(101, 10, 15, 0, 0),
  jp(16, 1, 111, -1 * M, 0),
  jp(111, 11, 16, 0, 0),
  jp(112, 11, 102, 1 * M, 0),
  jp(102, 10, 112, 0, 0),
  jp(17, 1, 121, 0, -2 * M),
  jp(121, 12, 17, 0, 0, { JumpGateStrength: 5 }),
]
const HOME = { PopulationID: 1, PopName: 'Home', SystemID: 1, Capital: 1, Population: 100, Xcor: 0, Ycor: 0 }
const ROUTES = { jumpPoints: JUMP_POINTS, capital: HOME, colonies: [HOME] }
const LAGRANGE = [
  { SystemID: 4, Xcor: 0.1 * M, Ycor: 0 },
  { SystemID: 4, Xcor: 4.9 * M, Ycor: 0 },
  { SystemID: 3, Xcor: 2 * M, Ycor: 0 },
  { SystemID: 7, Xcor: 0.1 * M, Ycor: 0 },
  { SystemID: 7, Xcor: 0.1 * M, Ycor: 0 },
]
const body = (id, system, x, y) => ({ SystemBodyID: id, SystemID: system, Xcor: x, Ycor: y })
const BODIES = {
  B0: body(100, 1, 0, 0),
  B1: body(101, 1, 0.5 * M, 0),
  X2: body(102, 2, 1 * M, 0),
  X3: body(103, 3, 1 * M, 0),
  X: body(104, 4, 5 * M, 0),
  Y: body(105, 7, 0.3 * M, 0),
  O: body(106, 10, 1 * M, 0),
  H: body(107, 8, 0, 0),
  U: body(108, 9, 0, 0),
  Z: body(109, 12, 1 * M, 0),
  N: body(110, 2, null, null),
}
const BODY_LIST = Object.values(BODIES)
// The systems each drive can reach from system 1 by the points the race has explored and charted, from a walk over the graph written another way.
const REACHABLE = { drive: [1, 2, 3, 4, 5, 6, 7, 10, 11, 12], gates: [1, 2, 3] }
const HIDDEN_POINTS = [13, 81, 14, 91]
const SPEEDS = [null, 1000, 5000]
const BASES = SPEEDS.flatMap((speed) => ['drive', 'gates'].flatMap((drive) => [true, false].map((lagrange) => ({ speed, drive, lagrange }))))

// ---------- the walk written another way ----------

// The systems reachable from `origins` by fixed-point iteration over the rows: a link is crossed from a system already reached, when its own point is explored (unless `ignoreExplored`), the far point is a row of the list and the drive allows it.
const reachableSystems = (jumpPoints, origins, { gates = false, ignoreExplored = false } = {}) => {
  const rows = new Map(jumpPoints.map((row) => [row.WarpPointID, row]))
  const reached = new Set(origins)
  let grown = true

  while (grown) {
    grown = false

    for (const row of jumpPoints) {
      const far = rows.get(row.WPLink)

      if (reached.has(row.SystemID) && (row.Explored || ignoreExplored) && far && (!gates || row.JumpGateStrength > 0) && !reached.has(far.SystemID)) {
        reached.add(far.SystemID)
        grown = true
      }
    }
  }

  return reached
}

const jumpIdsOf = (m, estimate) => legsOf(m, estimate).filter((leg) => leg.kind === 'jump').map((leg) => [leg.from.WarpPointID, leg.to.WarpPointID])

const legsOf = (m, estimate) => (estimate.route ? m.graph.routeLegs(estimate.route) : [])

// An in-memory SQLite database of the tables `loadTransitClasses` reads, with the ship classes of race 2 in game 1: NoDrive (a component that is no jump drive), Big (an ordinary drive of 100), NullRating (an ordinary drive whose rating is not stored), NullEngine (a commercial drive of 100, the engine flag not stored), NullMixed (an ordinary drive of 100 and a commercial one whose rating is not stored), NullOrdinary (an ordinary drive of 100 and an ordinary one whose rating is not stored), NullSmall (an ordinary drive of 50 and one whose rating is not stored), NoKind (a military hull whose only drive, rated 100, has no kind stored), NoKindSmall (the same drive rated 50), NoKindKnown (an ordinary drive of 100 and a drive of no kind), NoKindUnrated (a drive of no kind and no rating) and NoKindCommercial (a drive of no kind rated 100 on a commercial hull); and three that are left out (another race's, one at speed 1, one with no ship).
const LOADER_FIXTURE = `
  create table FCT_ShipClass (ShipClassID integer primary key, GameID integer, RaceID integer, ClassName text, MaxSpeed integer, Size real, MilitaryEngines integer);
  create table FCT_Ship (ShipID integer primary key, GameID integer, RaceID integer, ShipClassID integer);
  create table FCT_ClassComponent (ClassID integer, ComponentID integer);
  create table FCT_ShipDesignComponents (SDComponentID integer primary key, ComponentTypeID integer, SpecialFunction integer, ComponentValue real);
  insert into FCT_ShipDesignComponents values (10, 16, 0, 100), (11, 16, 0, null), (12, 16, 1, 100), (13, 5, 0, 999), (14, 16, 1, null), (15, 16, 0, 50), (16, 16, null, 100), (17, 16, null, null), (18, 16, null, 50);
  insert into FCT_ShipClass values (1, 1, 2, 'NoDrive', 500, 100, 1), (2, 1, 2, 'Big', 900, 100, 1), (3, 1, 2, 'NullRating', 700, 100, 1), (4, 1, 2, 'NullEngine', 600, 100, null), (5, 1, 2, 'NullMixed', 800, 100, 0), (6, 1, 3, 'Other', 900, 100, 1), (7, 1, 2, 'Slow', 1, 100, 1), (8, 1, 2, 'Empty', 900, 100, 1), (9, 1, 2, 'NullOrdinary', 650, 100, 1), (10, 1, 2, 'NullSmall', 640, 100, 1), (11, 1, 2, 'NoKind', 630, 100, 1), (12, 1, 2, 'NoKindSmall', 620, 100, 1), (13, 1, 2, 'NoKindKnown', 610, 100, 1), (14, 1, 2, 'NoKindUnrated', 605, 100, 1), (15, 1, 2, 'NoKindCommercial', 604, 100, 0);
  insert into FCT_Ship values (1, 1, 2, 1), (2, 1, 2, 2), (3, 1, 2, 3), (4, 1, 2, 4), (5, 1, 2, 5), (6, 1, 3, 6), (7, 1, 2, 7), (8, 1, 2, 9), (9, 1, 2, 10), (10, 1, 2, 11), (11, 1, 2, 12), (12, 1, 2, 13), (13, 1, 2, 14), (14, 1, 2, 15);
  insert into FCT_ClassComponent values (1, 13), (2, 10), (3, 11), (4, 12), (5, 10), (5, 14), (6, 10), (7, 10), (8, 10), (9, 10), (9, 11), (10, 15), (10, 11), (11, 16), (12, 18), (13, 10), (13, 16), (14, 17), (15, 16);
`

// An in-memory SQLite database of the tables `loadJumpPoints` reads, for race 2 in game 1, which knows systems 1, 9 and 10: 14 in system 1 is charted and explored, and its far side 91 in system 9 is in the save but the race has not charted it; 15 in system 1 and its far side 101 in system 10 are both charted and explored.
const JUMP_LOADER_FIXTURE = `
  create table FCT_JumpPoint (WarpPointID integer primary key, GameID integer, SystemID integer, WPLink integer, Distance real, Xcor real, Ycor real, JumpGateStrength integer);
  create table FCT_RaceJumpPointSurvey (GameID integer, RaceID integer, WarpPointID integer, Charted integer, Explored integer, MilitaryRestricted integer, IgnoreForDistance integer);
  create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer);
  insert into FCT_JumpPoint values (14, 1, 1, 91, 0, ${0.5 * M}, ${0.5 * M}, 0), (91, 1, 9, 14, 0, 0, 0, 0), (15, 1, 1, 101, 0, 0, ${-30 * M}, 0), (101, 1, 10, 15, 0, 0, 0, 0);
  insert into FCT_RaceJumpPointSurvey values (1, 2, 14, 1, 1, 0, 0), (1, 2, 91, 0, 0, 0, 0), (1, 2, 15, 1, 1, 0, 0), (1, 2, 101, 1, 1, 0, 0);
  insert into FCT_RaceSysSurvey values (1, 2, 1), (1, 2, 9), (1, 2, 10);
`

const allRows = (raw, text) => new Promise((resolve, reject) => raw.all(text, (error, rows) => (error ? reject(error) : resolve([rows]))))

const memory = (sql) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(':memory:')

  raw.exec(sql, (error) => (error ? reject(error) : resolve({ query: (text) => allRows(raw, text), close: () => raw.close() })))
})

// ---------- the statements without a save ----------

const fixtures = (m) => {
  const all = []
  const add = (name, run) => all.push([name, run])
  const { transitEstimator, transitSortValues, transitLegs, sortTableItems, normaliseSpeed, driveOfClass, basisText, transitText, TRANSIT_STATE_TEXT } = m.transit
  const { isAvailable } = m.provenance
  const estimator = (basis, lagrange = LAGRANGE, routes = ROUTES) => transitEstimator(routes, lagrange, basis)
  const base = { speed: 1000, drive: 'drive', lagrange: false }

  add('three: two bodies three jumps away by different system legs have a distinct distance and a distinct time', () => {
    const estimate = estimator(base)
    const x = estimate(BODIES.X)
    const y = estimate(BODIES.Y)

    assert.strictEqual(x.state, 'routed')
    assert.strictEqual(y.state, 'routed')
    assert.strictEqual(x.jumps, 3)
    assert.strictEqual(y.jumps, 3)
    assert.notStrictEqual(x.km, y.km)
    assert.notStrictEqual(x.days, y.days)
    near(x.km, 13 * M)
    near(y.km, 2.6 * M)
    near(x.days, 13 * M / 1000 / SECONDS_PER_DAY)
    near(y.days, 2.6 * M / 1000 / SECONDS_PER_DAY)
    near(x.au, 13 * M / KM_PER_AU)
  })

  add('three: the legs inside each system are listed and sum to the distance', () => {
    const estimate = estimator(base)
    const x = estimate(BODIES.X)
    const y = estimate(BODIES.Y)

    same(transitLegs(x).map((leg) => [leg.SystemID, leg.km]), [[1, 1 * M], [2, 3 * M], [3, 4 * M], [4, 5 * M]])
    same(transitLegs(y).map((leg) => [leg.SystemID, leg.km]), [[1, 2 * M], [5, 0.1 * M], [6, 0.2 * M], [7, 0.3 * M]])
    near(transitLegs(x).reduce((total, leg) => total + leg.km, 0), x.km)
    near(transitLegs(y).reduce((total, leg) => total + leg.km, 0), y.km)
  })

  add('three: the time sort puts the shorter of two bodies at the same jump count first, whichever way it runs', () => {
    const estimate = estimator(base)
    const items = ['X', 'Y'].map((id) => ({ id, ...(({ value, tie }) => ({ transitValue: value, transitTie: tie }))(transitSortValues(estimate(BODIES[id]), 'time')) }))

    same(sortTableItems(items, ['transitValue'], [false], () => 0).map((item) => item.id), ['Y', 'X'])
    same(sortTableItems(items, ['transitValue'], [true], () => 0).map((item) => item.id), ['X', 'Y'])
  })

  add('order: the route is the shortest in kilometres, which can be longer in jumps than the fewest-jump one', () => {
    const o = estimator(base)(BODIES.O)
    const fewest = m.graph.searchRoutes(JUMP_POINTS, [HOME], { order: 'jumps' }).toPlace(BODIES.O)

    assert.strictEqual(o.jumps, 2)
    near(o.km, 3 * M)
    assert.strictEqual(fewest.jumps, 1)
    near(fewest.km, 31 * M)
  })

  add('unknown: a body behind a link that is charted but not explored has no route: unknown figures, an unavailable result, never 0', () => {
    const h = estimator(base)(BODIES.H)

    assert.strictEqual(h.state, 'no-route')
    ;['km', 'au', 'jumps', 'days', 'route', 'from'].forEach((field) => assert.strictEqual(h[field], null, field))
    assert.strictEqual(isAvailable(h.results.route), false)
    assert.strictEqual(isAvailable(h.results.time), false)
    assert.strictEqual(h.results.route.value, null)
    assert.strictEqual(h.results.time.value, null)
    assert.ok(h.results.route.inputs.missing.length > 0)
  })

  add('unknown: a body in a system whose far side of a link is not charted has no route either', () => {
    const u = estimator(base)(BODIES.U)

    assert.strictEqual(u.state, 'no-route')
    assert.strictEqual(u.km, null)
    assert.strictEqual(u.days, null)
  })

  add('unknown: a body with no position, and a race with no colony to fly from, are unknown by their own state', () => {
    const n = estimator(base)(BODIES.N)
    const none = estimator(base, LAGRANGE, { jumpPoints: JUMP_POINTS, capital: null, colonies: [] })(BODIES.X)
    const blind = estimator(base, LAGRANGE, { jumpPoints: JUMP_POINTS, capital: null, colonies: [{ ...HOME, Xcor: null, Ycor: null }] })(BODIES.X)

    assert.strictEqual(n.state, 'no-position')
    assert.strictEqual(none.state, 'no-origin')
    assert.strictEqual(blind.state, 'no-origin')

    for (const estimate of [n, none, blind]) {
      assert.strictEqual(estimate.km, null)
      assert.strictEqual(estimate.days, null)
      assert.strictEqual(estimate.jumps, null)
      assert.strictEqual(isAvailable(estimate.results.route), false)
      assert.ok(TRANSIT_STATE_TEXT[estimate.state])
    }
  })

  add('unknown: a body at the colony itself is a real 0, not an unknown one', () => {
    const b0 = estimator(base)(BODIES.B0)

    assert.strictEqual(b0.state, 'routed')
    assert.strictEqual(b0.km, 0)
    assert.strictEqual(b0.jumps, 0)
    assert.strictEqual(b0.days, 0)
    assert.strictEqual(isAvailable(b0.results.time), true)
    assert.strictEqual(b0.results.time.value, 0)
  })

  add('unknown: the sort values of an unknown estimate are null for every sort, never 0', () => {
    const h = estimator(base)(BODIES.H)

    for (const sort of ['time', 'distance', 'jumps']) {
      same(transitSortValues(h, sort), { value: null, tie: null })
    }
  })

  add('unknown: the table puts an unknown route after the known ones, whichever way it is sorted, and a real 0 first', () => {
    const estimate = estimator(base)

    for (const sort of ['time', 'distance', 'jumps']) {
      const items = ['H', 'X', 'B0', 'U', 'Y', 'O'].map((id) => {
        const { value, tie } = transitSortValues(estimate(BODIES[id]), sort)

        return { id, transitValue: value, transitTie: tie }
      })
      const up = sortTableItems(items, ['transitValue'], [false], (x, y) => x.localeCompare(y)).map((item) => item.id)
      const down = sortTableItems(items, ['transitValue'], [true], (x, y) => x.localeCompare(y)).map((item) => item.id)

      assert.deepStrictEqual(up.slice(-2), ['H', 'U'], `${sort} up`)
      assert.deepStrictEqual(down.slice(-2), ['H', 'U'], `${sort} down`)
      assert.strictEqual(up[0], 'B0', `${sort} first`)
      assert.strictEqual(down[down.length - 3], 'B0', `${sort} last of the known`)
    }
  })

  add('unknown: a table field that is null sorts last in either direction and an equal pair of nulls keeps its order', () => {
    const items = [{ id: 'a', value: null }, { id: 'b', value: 3 }, { id: 'c', value: null }, { id: 'd', value: 1 }, { id: 'e', value: 0 }]

    same(sortTableItems(items, ['value'], [false], () => 0).map((item) => item.id), ['e', 'd', 'b', 'a', 'c'])
    same(sortTableItems(items, ['value'], [true], () => 0).map((item) => item.id), ['b', 'd', 'e', 'a', 'c'])
    same(sortTableItems(items, [], [false], () => 0).map((item) => item.id), ['a', 'b', 'c', 'd', 'e'])
  })

  add('unknown: text sorts through the collator and a null name last', () => {
    const items = [{ id: 'a', name: null }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Alpha' }]

    same(sortTableItems(items, ['name'], [false], (x, y) => x.localeCompare(y)).map((item) => item.id), ['c', 'b', 'a'])
    same(sortTableItems(items, ['name'], [true], (x, y) => x.localeCompare(y)).map((item) => item.id), ['b', 'c', 'a'])
  })

  add('speed: a blank, zero, negative or non-numeric speed leaves the time unknown while the route and the distance stay known', () => {
    for (const speed of [null, undefined, '', '  ', 0, -5, 'fast', NaN, Infinity]) {
      const x = estimator({ ...base, speed })(BODIES.X)

      assert.strictEqual(x.state, 'routed', String(speed))
      assert.strictEqual(x.days, null, String(speed))
      assert.strictEqual(isAvailable(x.results.time), false, String(speed))
      assert.strictEqual(isAvailable(x.results.route), true, String(speed))
      assert.strictEqual(x.jumps, 3)
      near(x.km, 13 * M)
      same(transitSortValues(x, 'time'), { value: null, tie: 13 * M })
    }
  })

  add('speed: normaliseSpeed keeps a number above 0 and nothing else', () => {
    same([normaliseSpeed(1000), normaliseSpeed('1000'), normaliseSpeed(' 25.5 '), normaliseSpeed(0), normaliseSpeed(-1), normaliseSpeed(''), normaliseSpeed(null), normaliseSpeed(undefined), normaliseSpeed('abc'), normaliseSpeed(NaN)], [1000, 1000, 25.5, null, null, null, null, null, null, null])
  })

  add('speed: a changed speed rescales the time and changes neither the route, the jumps nor the distance', () => {
    const slow = estimator({ ...base, speed: 1000 })
    const fast = estimator({ ...base, speed: 5000 })

    for (const id of ['X', 'Y', 'O', 'X3', 'B1']) {
      const a = slow(BODIES[id])
      const b = fast(BODIES[id])

      assert.strictEqual(a.km, b.km, id)
      assert.strictEqual(a.jumps, b.jumps, id)
      assert.deepStrictEqual(jumpIdsOf(m, a), jumpIdsOf(m, b), id)
      near(a.days / b.days, 5)
      near(b.days, a.km / 5000 / SECONDS_PER_DAY)
    }
  })

  add('speed: a speed that is entered is assumed and the route and time are estimated', () => {
    const x = estimator(base)(BODIES.X)
    const blank = estimator({ ...base, speed: null })(BODIES.X)

    assert.strictEqual(x.results.time.status, 'estimated')
    assert.strictEqual(x.results.route.status, 'estimated')
    assert.ok(x.results.time.assumptions.length > 0)
    assert.ok(x.results.route.assumptions.some((text) => /Lagrange/.test(text)))
    assert.ok(x.results.route.assumptions.some((text) => /one-way|one way/.test(text)))
    assert.strictEqual(blank.results.time.status, 'unavailable')
    assert.ok(blank.results.time.inputs.missing.some((text) => /speed/.test(text)))
    assert.strictEqual(m.provenance.getRule('habitability.transitSpeed').verification, 'assumed')
  })

  add('drive: without a jump drive only a point stabilised on the departure side is crossed, so the ship stops where the stabilised points stop', () => {
    const gates = estimator({ ...base, drive: 'gates' })
    const drive = estimator(base)

    assert.strictEqual(gates(BODIES.X3).state, 'routed')
    assert.strictEqual(gates(BODIES.X3).jumps, 2)
    near(gates(BODIES.X3).km, drive(BODIES.X3).km)
    assert.strictEqual(gates(BODIES.X).state, 'needs-drive')
    assert.strictEqual(drive(BODIES.X).state, 'routed')
    assert.strictEqual(gates(BODIES.Y).state, 'needs-drive')
    assert.strictEqual(gates(BODIES.O).state, 'needs-drive')
  })

  add('drive: a gate only on the far side does not carry the ship through', () => {
    assert.strictEqual(estimator({ ...base, drive: 'gates' })(BODIES.Z).state, 'needs-drive')
    assert.strictEqual(estimator(base)(BODIES.Z).state, 'routed')
  })

  add('drive: a body the explored graph does not reach is no-route under either drive, never the drive\'s fault', () => {
    for (const drive of ['drive', 'gates']) {
      assert.strictEqual(estimator({ ...base, drive })(BODIES.H).state, 'no-route', drive)
      assert.strictEqual(estimator({ ...base, drive })(BODIES.U).state, 'no-route', drive)
    }
  })

  add('drive: a needs-drive body has no figures either, and its time is unavailable', () => {
    const x = estimator({ ...base, drive: 'gates' })(BODIES.X)

    assert.strictEqual(x.km, null)
    assert.strictEqual(x.days, null)
    assert.strictEqual(isAvailable(x.results.time), false)
    assert.ok(x.results.route.inputs.missing.some((text) => /jump drive|stabilised/.test(text)))
    same(transitSortValues(x, 'distance'), { value: null, tie: null })
  })

  add('drive: a jump point whose gate strength the save lacks is not taken as stabilised', () => {
    const blank = JUMP_POINTS.map((point) => (point.WarpPointID === 11 ? { ...point, JumpGateStrength: null } : point))
    const x2 = estimator({ ...base, drive: 'gates' }, LAGRANGE, { ...ROUTES, jumpPoints: blank })(BODIES.X2)

    assert.strictEqual(x2.state, 'needs-drive')
    assert.ok(x2.results.route.assumptions.some((text) => /no gate strength/.test(text)))
  })

  add('drive: a drive change alone changes the state of a body and never its route when it is crossed both ways', () => {
    const states = ['drive', 'gates'].map((drive) => BODY_LIST.map((item) => estimator({ ...base, drive })(item).state))

    assert.notDeepStrictEqual(states[0], states[1])
  })

  add('hidden: whatever the speed, the drive or Lagrange routing, a body is routed exactly when an independent walk over the explored and charted jump points reaches its system', () => {
    for (const basis of BASES) {
      const estimate = estimator(basis)
      const reachable = new Set(reachableSystems(JUMP_POINTS, [1], { gates: basis.drive === 'gates' }))
      const routed = BODY_LIST.filter((item) => estimate(item).state === 'routed').map((item) => item.SystemBodyID)
      const expected = BODY_LIST.filter((item) => reachable.has(item.SystemID) && Number.isFinite(item.Xcor)).map((item) => item.SystemBodyID)

      assert.deepStrictEqual(sorted(routed), sorted(expected), JSON.stringify(basis))
      assert.deepStrictEqual(sorted([...reachable]), REACHABLE[basis.drive], JSON.stringify(basis))
    }
  })

  add('hidden: no route of any basis crosses a link that is not explored or whose far side is not charted, or enters system 8 or 9', () => {
    for (const basis of BASES) {
      const estimate = estimator(basis)

      for (const item of BODY_LIST) {
        for (const leg of legsOf(m, estimate(item)).filter((step) => step.kind === 'jump')) {
          assert.ok(!HIDDEN_POINTS.includes(leg.from.WarpPointID) && !HIDDEN_POINTS.includes(leg.to.WarpPointID), `${JSON.stringify(basis)} crosses ${leg.from.WarpPointID}`)
          assert.strictEqual(leg.from.Explored, 1)
        }
      }
    }

    assert.ok(reachableSystems(JUMP_POINTS, [1], { ignoreExplored: true }).has(8), 'the unexplored link would reach system 8 if it were crossed')
  })

  add('hidden: a changed speed or drive finds no body the other basis cannot: gates reaches a subset of what the jump drive reaches, which is a subset of the explored graph', () => {
    const everything = new Set(reachableSystems(JUMP_POINTS, [1]))
    const routedBy = (basis) => new Set(BODY_LIST.filter((item) => estimator(basis)(item).state === 'routed').map((item) => item.SystemBodyID))
    const drive = routedBy(base)
    const gates = routedBy({ ...base, drive: 'gates' })

    for (const id of gates) {
      assert.ok(drive.has(id), `${id} is reached by gates alone`)
    }

    for (const id of drive) {
      assert.ok(everything.has(BODY_LIST.find((item) => item.SystemBodyID === id).SystemID), `${id} is outside the explored graph`)
    }

    assert.ok(gates.size < drive.size)

    for (const speed of [null, 1, 1e9]) {
      assert.deepStrictEqual(routedBy({ ...base, speed }), drive)
    }
  })

  add('hidden: the loader reads only the jump points the race has charted, so a link whose far side the race has not charted is never crossed and the system behind it is not reached, while a link charted on both sides is', async () => {
    const database = await memory(JUMP_LOADER_FIXTURE)

    try {
      const rows = await m.graph.loadJumpPoints(database, { GameID: 1, RaceID: 2 })
      const routes = m.graph.searchRoutes(rows, [{ SystemID: 1, Xcor: 0, Ycor: 0 }])

      same(sorted(rows.map((row) => row.WarpPointID)), [14, 15, 101])
      assert.strictEqual(routes.toSystem(9), null)
      assert.strictEqual(routes.toSystem(10).jumps, 1)
    } finally {
      database.close()
    }
  })

  add('ignored: a jump point flagged to be ignored for distance is still crossed, as the game\'s own routing ignores the flag', () => {
    const y = estimator(base)(BODIES.Y)

    assert.strictEqual(y.state, 'routed')
    assert.strictEqual(y.jumps, 3)
    assert.strictEqual(m.graph.buildDistanceMap(JUMP_POINTS, [HOME])(BODIES.Y), null)
  })

  add('lagrange: a pair of Lagrange points shortens the last leg when strictly shorter, and the switch turns that off', () => {
    const on = estimator({ ...base, lagrange: true })(BODIES.X)
    const off = estimator({ ...base, lagrange: false })(BODIES.X)

    near(on.km, 8.2 * M)
    near(off.km, 13 * M)
    assert.strictEqual(on.jumps, 3)
    assert.ok(on.days < off.days)
    assert.strictEqual(transitLegs(on)[3].via.length, 2)
    assert.strictEqual(transitLegs(off)[3].via, null)
  })

  add('lagrange: a single Lagrange point in a system, and a pair that is not strictly shorter, change nothing', () => {
    const on = estimator({ ...base, lagrange: true })
    const off = estimator({ ...base, lagrange: false })

    near(transitLegs(on(BODIES.X))[2].km, 4 * M)
    assert.strictEqual(transitLegs(on(BODIES.X))[2].via, null)
    assert.strictEqual(on(BODIES.Y).km, off(BODIES.Y).km)
    assert.strictEqual(transitLegs(on(BODIES.Y))[3].via, null)
  })

  add('lagrange: with the switch on and no Lagrange point in the save, the route is the straight one', () => {
    assert.strictEqual(estimator({ ...base, lagrange: true }, [])(BODIES.X).km, estimator(base)(BODIES.X).km)
  })

  add('sorts: time, distance and jumps order the bodies, ties go to the second figure, and an unknown value is last', () => {
    const estimate = estimator(base)
    const order = (sort, desc) => sortTableItems(['H', 'X', 'Y', 'O', 'B0'].map((id) => {
      const { value, tie } = transitSortValues(estimate(BODIES[id]), sort)

      return { id, transitValue: value, transitTie: tie }
    }), ['transitValue'], [desc], () => 0).map((item) => item.id)

    same(order('time', false), ['B0', 'Y', 'O', 'X', 'H'])
    same(order('time', true), ['X', 'O', 'Y', 'B0', 'H'])
    same(order('distance', false), ['B0', 'Y', 'O', 'X', 'H'])
    same(order('jumps', false), ['B0', 'O', 'Y', 'X', 'H'])
    same(order('jumps', true), ['X', 'Y', 'O', 'B0', 'H'])
  })

  add('sorts: the value and the tie of each sort', () => {
    const x = estimator(base)(BODIES.X)

    same(transitSortValues(x, 'time'), { value: x.days, tie: x.km })
    same(transitSortValues(x, 'distance'), { value: x.km, tie: 3 })
    same(transitSortValues(x, 'jumps'), { value: 3, tie: x.km })
  })

  add('sorts: equal figures are broken by the second figure on the Transit column only when the first is known', () => {
    const items = [{ id: 'a', transitValue: 5, transitTie: 2 }, { id: 'b', transitValue: 5, transitTie: 1 }, { id: 'c', transitValue: null, transitTie: 9 }, { id: 'd', transitValue: null, transitTie: 3 }]

    same(sortTableItems(items, ['transitValue'], [false], () => 0).map((item) => item.id), ['b', 'a', 'c', 'd'])
    same(sortTableItems(items, ['transitValue'], [true], () => 0).map((item) => item.id), ['a', 'b', 'c', 'd'])
  })

  add('sorts: with no speed every time is unknown, so the Time sort keeps the table\'s order and the Distance sort still orders', () => {
    const estimate = estimator({ ...base, speed: null })
    const order = (sort) => sortTableItems(['X', 'Y', 'O'].map((id) => {
      const { value, tie } = transitSortValues(estimate(BODIES[id]), sort)

      return { id, transitValue: value, transitTie: tie }
    }), ['transitValue'], [false], () => 0).map((item) => item.id)

    same(order('time'), ['X', 'Y', 'O'])
    same(order('distance'), ['Y', 'O', 'X'])
  })

  add('class: the drive of a ship class is the jump drive that carries its largest hull, none when the size is not stored', () => {
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 100, AnyDrive: 100 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 50, AnyDrive: 50 }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 0, AnyDrive: 500 }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 0, AnyDrive: 100 }), 'drive')
    same(driveOfClass({ Size: 300, MilitaryEngines: 0, Drive: 0, AnyDrive: 0 }), 'gates')
    same(driveOfClass({ Size: null, MilitaryEngines: 0, Drive: 0, AnyDrive: 0 }), null)
    same(driveOfClass({ Size: 0, MilitaryEngines: 0, Drive: 0, AnyDrive: 0 }), null)
    same(driveOfClass({ Size: undefined, MilitaryEngines: 1, Drive: 0, AnyDrive: 0 }), null)
  })

  add('class: a class whose engine flag or drive rating the save does not store is unknown where the stored figures cannot settle it, and settled where they can', () => {
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 0, AnyDrive: 100 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: undefined, Drive: 0, AnyDrive: 100 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 100, AnyDrive: 100 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 0, AnyDrive: 50 }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 50, AnyDrive: 50 }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: null, AnyDrive: null }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 100, AnyDrive: null }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: null, AnyDrive: 100 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 100, AnyDrive: null }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 100, AnyDrive: null }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: null, AnyDrive: 100 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 50, AnyDrive: null }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 50, DriveUnknown: 1, AnyDrive: 50, AnyDriveUnknown: 0 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 100, DriveUnknown: 1, AnyDrive: 100, AnyDriveUnknown: 1 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 100, DriveUnknown: 0, AnyDrive: 100, AnyDriveUnknown: 1 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 0, DriveUnknown: 0, AnyDrive: 100, AnyDriveUnknown: 1 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 50, DriveUnknown: 1, AnyDrive: 50, AnyDriveUnknown: 1 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 50, DriveUnknown: 0, AnyDrive: 50, AnyDriveUnknown: 1 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 50, DriveUnknown: 0, AnyDrive: 50, AnyDriveUnknown: 1 }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 50, DriveUnknown: 1, AnyDrive: 50, AnyDriveUnknown: 1 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 100, DriveUnknown: 1, AnyDrive: 100, AnyDriveUnknown: 1 }), 'drive')
  })

  add('class: a drive whose kind the save does not store is no ordinary drive proven absent: it leaves a military hull open where it could carry it, and a known sufficient ordinary drive still settles it', () => {
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 0, DriveUnknown: 0, AnyDrive: 100, AnyDriveUnknown: 0, NoKindDrive: 100, NoKindDriveUnknown: 0 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 0, DriveUnknown: 0, AnyDrive: 50, AnyDriveUnknown: 0, NoKindDrive: 50, NoKindDriveUnknown: 0 }), 'gates')
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 0, DriveUnknown: 0, AnyDrive: 0, AnyDriveUnknown: 1, NoKindDrive: 0, NoKindDriveUnknown: 1 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 100, DriveUnknown: 0, AnyDrive: 100, AnyDriveUnknown: 0, NoKindDrive: 100, NoKindDriveUnknown: 1 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: 0, Drive: 0, DriveUnknown: 0, AnyDrive: 100, AnyDriveUnknown: 0, NoKindDrive: 100, NoKindDriveUnknown: 0 }), 'drive')
    same(driveOfClass({ Size: 100, MilitaryEngines: null, Drive: 0, DriveUnknown: 0, AnyDrive: 100, AnyDriveUnknown: 0, NoKindDrive: 100, NoKindDriveUnknown: 0 }), null)
    same(driveOfClass({ Size: 100, MilitaryEngines: 1, Drive: 0, DriveUnknown: 0, AnyDrive: 0, AnyDriveUnknown: 0 }), 'gates')
  })

  add('loader: a class with no jump drive component has a drive of 0, a component whose rating is not stored leaves the drive null, and the other classes read as stored', async () => {
    const database = await memory(LOADER_FIXTURE)

    try {
      const rows = await m.data.loadTransitClasses(database, { GameID: 1, RaceID: 2 })
      const byName = Object.fromEntries(rows.map((row) => [row.ClassName, row]))

      same(rows.map((row) => row.ClassName).sort(), ['Big', 'NoDrive', 'NoKind', 'NoKindCommercial', 'NoKindKnown', 'NoKindSmall', 'NoKindUnrated', 'NullEngine', 'NullMixed', 'NullOrdinary', 'NullRating', 'NullSmall'])
      same([byName.NoDrive.Drive, byName.NoDrive.DriveUnknown, byName.NoDrive.AnyDrive, byName.NoDrive.AnyDriveUnknown], [0, 0, 0, 0])
      same([byName.Big.Drive, byName.Big.DriveUnknown, byName.Big.AnyDrive, byName.Big.AnyDriveUnknown], [100, 0, 100, 0])
      same([byName.NullRating.Drive, byName.NullRating.DriveUnknown, byName.NullRating.AnyDrive, byName.NullRating.AnyDriveUnknown], [0, 1, 0, 1])
      same([byName.NullEngine.MilitaryEngines, byName.NullEngine.Drive, byName.NullEngine.DriveUnknown, byName.NullEngine.AnyDrive, byName.NullEngine.AnyDriveUnknown], [null, 0, 0, 100, 0])
      same([byName.NullMixed.Drive, byName.NullMixed.DriveUnknown, byName.NullMixed.AnyDrive, byName.NullMixed.AnyDriveUnknown], [100, 0, 100, 1])
      same([byName.NullOrdinary.Drive, byName.NullOrdinary.DriveUnknown, byName.NullOrdinary.AnyDrive, byName.NullOrdinary.AnyDriveUnknown], [100, 1, 100, 1])
      same([byName.NullSmall.Drive, byName.NullSmall.DriveUnknown, byName.NullSmall.AnyDrive, byName.NullSmall.AnyDriveUnknown], [50, 1, 50, 1])
      same([byName.NoKind.Drive, byName.NoKind.DriveUnknown, byName.NoKind.AnyDrive, byName.NoKind.NoKindDrive, byName.NoKind.NoKindDriveUnknown], [0, 0, 100, 100, 0])
      same([byName.NoKindUnrated.NoKindDrive, byName.NoKindUnrated.NoKindDriveUnknown, byName.NoKindUnrated.AnyDriveUnknown], [0, 1, 1])
      same([byName.Big.NoKindDrive, byName.Big.NoKindDriveUnknown], [0, 0])
      same(Object.fromEntries(rows.map((row) => [row.ClassName, driveOfClass(row)])), { NoDrive: 'gates', Big: 'drive', NullRating: null, NullEngine: null, NullMixed: 'drive', NullOrdinary: 'drive', NullSmall: null, NoKind: null, NoKindSmall: 'gates', NoKindKnown: 'drive', NoKindUnrated: null, NoKindCommercial: 'drive' })
    } finally {
      database.close()
    }
  })

  add('loader: the classes are the race\'s own with ships and a speed above 1, fastest first', async () => {
    const database = await memory(LOADER_FIXTURE)

    try {
      const rows = await m.data.loadTransitClasses(database, { GameID: 1, RaceID: 2 })

      same(rows.map((row) => row.MaxSpeed), [...rows.map((row) => row.MaxSpeed)].sort((a, b) => b - a))
      assert.ok(!rows.some((row) => ['Other', 'Slow', 'Empty'].includes(row.ClassName)))
    } finally {
      database.close()
    }
  })

  add('text: the basis and the route are said in words, with the legs of each system, and an unknown one says why', () => {
    const x = estimator(base)(BODIES.X)
    const words = transitText(x, { systemName: (id) => `S${id}`, count: (value, decimals = 0) => value.toFixed(decimals) })

    assert.ok(/Home: 3 jumps/.test(words), words)
    assert.ok(/S1 .* AU, then S2/.test(words), words)
    assert.ok(/^No transit estimate: /.test(transitText(estimator(base)(BODIES.H), { systemName: String, count: String })))
    same(basisText({ speed: 1000, drive: 'gates', lagrange: false }), '1000 km/s, stabilised only, no Lagrange points')
    same(basisText({ speed: null, drive: 'drive', lagrange: true }), 'no speed, jump drive, Lagrange points used')
  })

  add('registry: the rules are registered, the speed assumed and the route and time estimated', () => {
    const { getRule } = m.provenance

    same(['habitability.transitSpeed', 'habitability.transitRoute', 'habitability.transitTime'].map((id) => getRule(id).verification), ['assumed', 'estimated', 'estimated'])
    assert.ok(getRule('habitability.transitRoute').assumptions.some((text) => /positions as saved/.test(text)))
  })

  return all
}

// The page's own wiring, read from its source: each new read is tracked under the name it is declared with and labelled once.
const pageStatements = () => {
  const page = fs.readFileSync(path.join(root, 'src', 'renderer', 'pages', 'habitability.vue'), 'utf8')

  return ['lagrangePoints', 'transitClasses'].map((key) => [`page: the read ${key} is labelled, declared and tracked under one name`, () => {
    assert.strictEqual((page.match(new RegExp(`^  ${key}: '`, 'gm')) || []).length, 1, 'one label')
    assert.strictEqual((page.match(new RegExp(`^    ${key}: \\{$`, 'gm')) || []).length, 1, 'one declaration')
    assert.strictEqual((page.match(new RegExp(`tracked\\('${key}'`, 'g')) || []).length, 1, 'one tracked read')
    assert.strictEqual((page.match(new RegExp(`kept\\(this, '${key}'`, 'g')) || []).length, 1, 'one kept read')
  }])
}

// ---------- the saves, read-only ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ query: (sql) => new Promise((resolve, reject) => raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))), close: () => raw.close() })
  })
})

const saveStatements = (m, held) => {
  const opened = new Map()
  const loaded = async (save) => {
    if (!opened.has(save.file)) {
      opened.set(save.file, (async () => {
        const database = await openSave(save.file)

        if (!database) {
          return null
        }

        const ids = { GameID: save.game, RaceID: save.race }
        const raw = async (sql) => (await database.query(sql))[0]
        const [routes, lagrange, classes] = await Promise.all([m.data.loadRoutes(database, ids), m.data.loadLagrangePoints(database, ids), m.data.loadTransitClasses(database, ids)])
        const known = (await raw(`select SystemID from FCT_RaceSysSurvey where GameID = ${save.game} and RaceID = ${save.race}`)).map((row) => row.SystemID)
        const bodies = await raw(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = FCT_SystemBody.GameID and FCT_RaceSysSurvey.RaceID = ${save.race} where FCT_SystemBody.GameID = ${save.game}`)

        return { database, raw, routes, lagrange, classes, known: new Set(known), bodies }
      })())
    }

    return opened.get(save.file)
  }

  held.push(async () => {
    for (const promise of opened.values()) {
      const world = await promise

      if (world) {
        world.database.close()
      }
    }
  })

  const per = (title, run) => SAVES.map((save) => [`real: ${save.label}: ${title}`, async () => {
    const world = await loaded(save)

    return world ? run(world, save) : skip(`${save.file} is not there`)
  }])

  const { transitEstimator, transitLegs } = m.transit
  const basisOf = (drive, speed = 1000, lagrange = false) => ({ speed, drive, lagrange })
  const estimatesOf = (world, basis) => {
    const estimate = transitEstimator(world.routes, world.lagrange, basis)

    return world.bodies.map((item) => ({ item, estimate: estimate(item) }))
  }

  return [
    ...per('the loaders read the jump points the race has charted in the systems it knows, and the Lagrange points of those systems', async (world, save) => {
      const charted = await world.raw(`select FCT_JumpPoint.WarpPointID from FCT_JumpPoint where FCT_JumpPoint.GameID = ${save.game} and FCT_JumpPoint.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${save.game} and RaceID = ${save.race}) and FCT_JumpPoint.WarpPointID in (select WarpPointID from FCT_RaceJumpPointSurvey where GameID = ${save.game} and RaceID = ${save.race} and Charted = 1)`)
      const points = await world.raw(`select SystemID from FCT_LagrangePoint where GameID = ${save.game} and SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${save.game} and RaceID = ${save.race})`)

      same(sorted(world.routes.jumpPoints.map((row) => row.WarpPointID)), sorted(charted.map((row) => row.WarpPointID)))
      assert.strictEqual(world.lagrange.length, points.length)
      assert.ok(world.lagrange.every((point) => world.known.has(point.SystemID)))
      assert.ok(world.routes.jumpPoints.every((row) => world.known.has(row.SystemID)))

      return [true, `${charted.length} charted jump points, ${points.length} Lagrange points`]
    }),
    ...per('every basis reaches exactly the bodies of the systems an independent walk over the charted and explored jump points reaches, and no more', async (world) => {
      const origins = [...new Set(world.routes.colonies.filter((colony) => Number.isFinite(colony.Xcor) && Number.isFinite(colony.Ycor)).map((colony) => colony.SystemID))]
      const withheld = reachableSystems(world.routes.jumpPoints, origins, { ignoreExplored: true })
      const counts = {}

      for (const drive of ['drive', 'gates']) {
        const reachable = reachableSystems(world.routes.jumpPoints, origins, { gates: drive === 'gates' })

        for (const [speed, lagrange] of [[null, false], [1000, true], [4e5, false]]) {
          const routed = estimatesOf(world, basisOf(drive, speed, lagrange)).filter(({ estimate }) => estimate.state === 'routed').map(({ item }) => item.SystemBodyID)
          const expected = world.bodies.filter((item) => reachable.has(item.SystemID) && Number.isFinite(item.Xcor) && Number.isFinite(item.Ycor)).map((item) => item.SystemBodyID)

          assert.deepStrictEqual(sorted(routed), sorted(expected), `${drive} ${speed} ${lagrange}`)
          counts[drive] = routed.length
        }
      }

      assert.ok(counts.gates <= counts.drive)

      return [true, `${counts.drive} of ${world.bodies.length} bodies routed by a jump drive, ${counts.gates} stabilised only, ${[...withheld].filter((id) => !world.known.has(id)).length} unknown systems beyond unexplored links never entered`]
    }),
    ...per('no route crosses a point that is not explored, is not charted, or leads into a system the race has not surveyed', async (world) => {
      const ids = new Set(world.routes.jumpPoints.map((row) => row.WarpPointID))
      let jumps = 0

      for (const drive of ['drive', 'gates']) {
        for (const { estimate } of estimatesOf(world, basisOf(drive, 1000, true))) {
          for (const leg of estimate.route ? m.graph.routeLegs(estimate.route).filter((step) => step.kind === 'jump') : []) {
            jumps++
            assert.ok(ids.has(leg.from.WarpPointID) && ids.has(leg.to.WarpPointID), 'a point the race has not charted')
            assert.strictEqual(leg.from.Explored, 1)
            assert.ok(world.known.has(leg.to.SystemID), 'a system the race has not surveyed')

            if (drive === 'gates') {
              assert.ok(leg.from.JumpGateStrength > 0, 'a point not stabilised on the departure side')
            }
          }
        }
      }

      return [true, `${jumps} jumps walked`]
    }),
    ...per('changing the speed only rescales the time: the route, the jumps and the kilometres of every body stay the same', async (world) => {
      const slow = estimatesOf(world, basisOf('drive', 1000, true))
      const fast = estimatesOf(world, basisOf('drive', 8000, true))
      const blank = estimatesOf(world, basisOf('drive', null, true))
      let timed = 0

      slow.forEach((a, index) => {
        const b = fast[index]
        const c = blank[index]

        assert.strictEqual(a.estimate.state, b.estimate.state)
        assert.strictEqual(a.estimate.km, b.estimate.km)
        assert.strictEqual(a.estimate.jumps, b.estimate.jumps)
        assert.strictEqual(a.estimate.km, c.estimate.km)
        assert.strictEqual(c.estimate.days, null)

        if (a.estimate.state === 'routed') {
          timed++
          near(a.estimate.days, a.estimate.km / 1000 / SECONDS_PER_DAY)
          near(b.estimate.days, a.estimate.days / 8, 1e-9)
        } else {
          assert.strictEqual(a.estimate.days, null)
          assert.strictEqual(a.estimate.km, null)
        }
      })

      return [true, `${timed} timed bodies`]
    }),
    ...per('the same jump count with different system legs gives a distinct distance and a distinct time in the save\'s own graph', async (world) => {
      const byJumps = new Map()

      for (const { item, estimate } of estimatesOf(world, basisOf('drive', 1000, false))) {
        if (estimate.state === 'routed') {
          byJumps.set(estimate.jumps, [...(byJumps.get(estimate.jumps) || []), { item, estimate }])
        }
      }

      const ranked = [...byJumps.entries()].filter(([jumps, list]) => jumps > 0 && new Set(list.map(({ estimate }) => estimate.km)).size > 1).sort(([a], [b]) => (a === 3 ? -1 : b === 3 ? 1 : b - a))

      if (!ranked.length) {
        return skip('no two bodies of the save share a jump count with different distances')
      }

      const [jumps, list] = ranked[0]
      const ordered = [...list].sort((a, b) => a.estimate.km - b.estimate.km)
      const short = ordered[0]
      const long = ordered[ordered.length - 1]

      assert.ok(short.estimate.km < long.estimate.km)
      assert.ok(short.estimate.days < long.estimate.days)
      assert.notDeepStrictEqual(transitLegs(short.estimate).map((leg) => leg.km), transitLegs(long.estimate).map((leg) => leg.km))

      return [true, `${list.length} bodies at ${jumps} jumps, ${Math.round(short.estimate.km)} km against ${Math.round(long.estimate.km)} km`]
    }),
    ...per('a body no route can fly is unknown, not 0, with the jump drive (nothing explored) and without (a point not stabilised): no figure, an unavailable result, a null sort value, and a state that says which', async (world) => {
      const counts = {}

      for (const drive of ['drive', 'gates']) {
        const unreached = estimatesOf(world, basisOf(drive, 1000, false)).filter(({ estimate }) => estimate.state !== 'routed')

        for (const { estimate } of unreached) {
          assert.strictEqual(estimate.km, null)
          assert.strictEqual(estimate.days, null)
          assert.strictEqual(estimate.jumps, null)
          assert.strictEqual(m.provenance.isAvailable(estimate.results.route), false)
          assert.strictEqual(m.transit.transitSortValues(estimate, 'jumps').value, null)
          assert.strictEqual(m.transit.transitSortValues(estimate, 'distance').value, null)
          assert.ok(drive === 'drive' ? estimate.state === 'no-route' : ['needs-drive', 'no-route'].includes(estimate.state))
        }

        counts[drive] = unreached.length
      }

      return [true, `${counts.drive} of ${world.bodies.length} bodies without an explored route, ${counts.gates} when only stabilised points are crossed`]
    }),
    ...per('Lagrange routing never lengthens a route and never changes the jumps', async (world) => {
      const off = estimatesOf(world, basisOf('drive', 1000, false))
      const on = estimatesOf(world, basisOf('drive', 1000, true))
      let shorter = 0

      off.forEach((a, index) => {
        const b = on[index]

        assert.strictEqual(a.estimate.state, b.estimate.state)

        if (a.estimate.state === 'routed') {
          assert.ok(b.estimate.km <= a.estimate.km + 1e-6, 'a longer route with Lagrange points')

          if (b.estimate.km < a.estimate.km) {
            shorter++
          }
        }
      })

      return [true, `${shorter} routes shorter with Lagrange points`]
    }),
    ...per('with a jump drive and no Lagrange points the kilometres are those of the Distance column\'s route', async (world) => {
      const distanceTo = m.graph.buildDistanceMap(world.routes.jumpPoints.map((point) => ({ ...point, IgnoreForDistance: 0 })), world.routes.colonies)
      let compared = 0

      for (const { item, estimate } of estimatesOf(world, basisOf('drive', 1000, false))) {
        const distance = distanceTo(item)

        if (distance === null) {
          assert.strictEqual(estimate.state === 'routed', false)
        } else {
          compared++
          assert.strictEqual(estimate.km, distance.km)
          assert.strictEqual(estimate.jumps, distance.jumps)
        }
      }

      return [true, `${compared} bodies compared`]
    }),
    ...per('the ship classes are the race\'s own classes that move, each with a drive that agrees with the transit rule', async (world, save) => {
      const [{ count }] = await world.raw(`select count(*) as count from FCT_ShipClass where GameID = ${save.game} and RaceID = ${save.race} and MaxSpeed > 1 and exists (select 1 from FCT_Ship where FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.GameID = ${save.game} and FCT_Ship.RaceID = ${save.race})`)

      assert.strictEqual(world.classes.length, count)
      assert.ok(world.classes.every((shipClass) => shipClass.MaxSpeed > 1))
      assert.deepStrictEqual(world.classes.map((shipClass) => shipClass.MaxSpeed), [...world.classes.map((shipClass) => shipClass.MaxSpeed)].sort((a, b) => b - a))

      const drives = world.classes.map((shipClass) => m.transit.driveOfClass(shipClass))

      world.classes.forEach((shipClass, index) => {
        const stored = Number.isFinite(shipClass.Size) && shipClass.Size > 0 && shipClass.MilitaryEngines !== null && !shipClass.DriveUnknown && !shipClass.AnyDriveUnknown && !shipClass.NoKindDrive && !shipClass.NoKindDriveUnknown
        const expected = stored ? (m.transport.fleetCanTransit([shipClass]) ? 'drive' : 'gates') : drives[index]

        assert.strictEqual(drives[index], expected)
      })

      return [true, `${count} classes, ${drives.filter((drive) => drive === 'drive').length} with a drive that carries them`]
    }),
    ...per('the drive sizes the loader reads are the shared columns\' wherever no rating is missing', async (world, save) => {
      const shared = await world.raw(`select FCT_ShipClass.ShipClassID, ${m.transport.JUMP_DRIVE_COLUMNS} from FCT_ShipClass where FCT_ShipClass.GameID = ${save.game} and FCT_ShipClass.RaceID = ${save.race}`)
      const byId = new Map(shared.map((row) => [row.ShipClassID, row]))

      world.classes.forEach((shipClass) => {
        assert.strictEqual(shipClass.Drive, byId.get(shipClass.ShipClassID).Drive)
        assert.strictEqual(shipClass.AnyDrive, byId.get(shipClass.ShipClassID).AnyDrive)
      })

      return [true, `${world.classes.length} classes agree`]
    }),
  ]
}

// ---------- the mutants ----------

// Each mutant plants one fault with a source text to find (once) and its replacement, and names the fixture checks, by key, that must fail.
const MUTATIONS = [
  { name: 'Lagrange routing ignored', file: T, find: 'lagrangePoints: chosen.lagrange ? lagrangePoints : [] }', replace: 'lagrangePoints: [] }', fails: ['lagrange'] },
  { name: 'Lagrange routing always on', file: T, find: 'lagrangePoints: chosen.lagrange ? lagrangePoints : [] }', replace: 'lagrangePoints }', fails: ['lagrange'] },
  { name: 'a ship without a jump drive crosses every explored point', file: T, find: 'const own = searchRoutes(jumpPoints, colonies, chosen.drive === \'gates\' ? { ...options, canTransit: hasGate } : options)', replace: 'const own = searchRoutes(jumpPoints, colonies, options)', fails: ['drive', 'hidden'] },
  { name: 'a gate on either side lets the ship through', file: T, find: 'canTransit: hasGate }', replace: 'canTransit: (point) => hasGate(point) || hasGate({ JumpGateStrength: Number(Boolean(jumpPoints.find((other) => other.WarpPointID === point.WPLink && other.JumpGateStrength > 0))) }) }', fails: ['drive'] },
  { name: 'a needs-drive body read as having no route', file: T, find: 'return open.toPlace(body) ? missingEstimate(\'needs-drive\'', replace: 'return false ? missingEstimate(\'needs-drive\'', fails: ['drive'] },
  { name: 'the open search is the one the drive limits', file: T, find: 'const open = chosen.drive === \'gates\' ? searchRoutes(jumpPoints, colonies, options) : own', replace: 'const open = own', fails: ['drive'] },
  { name: 'a blank speed read as 0', file: T, find: 'return Number.isFinite(speed) && speed > 0 ? speed : null', replace: 'return Number.isFinite(speed) && speed > 0 ? speed : 0', fails: ['speed'] },
  { name: 'a blank speed given a result', file: T, find: 'const speedResultOf = (speed) => (speed === null ?', replace: 'const speedResultOf = (speed) => (speed === undefined ?', fails: ['speed'] },
  { name: 'the time not divided by the speed', file: T, find: 'values.route.km / values.speed / SECONDS_PER_DAY', replace: 'values.route.km / SECONDS_PER_DAY', fails: ['three', 'speed'] },
  { name: 'the time in seconds, not days', file: T, find: 'values.route.km / values.speed / SECONDS_PER_DAY', replace: 'values.route.km / values.speed', fails: ['three', 'speed'] },
  { name: 'a route nothing reaches read as 0 km and 0 jumps', file: T, find: 'return Object.freeze({ state, route: null, km: null, au: null, jumps: null, from: null, days: null,', replace: 'return Object.freeze({ state, route: null, km: 0, au: 0, jumps: 0, from: null, days: null,', fails: ['unknown'] },
  { name: 'a route nothing reaches read as 0 days', file: T, find: 'return Object.freeze({ state, route: null, km: null, au: null, jumps: null, from: null, days: null,', replace: 'return Object.freeze({ state, route: null, km: null, au: null, jumps: null, from: null, days: 0,', fails: ['unknown'] },
  { name: 'a sort value that is unknown read as 0', file: T, find: 'return { value: sort === \'distance\' ? estimate.km : estimate.days, tie:', replace: 'return { value: (sort === \'distance\' ? estimate.km : estimate.days) || 0, tie:', fails: ['unknown'] },
  { name: 'the jumps sort value that is unknown read as 0', file: T, find: 'return { value: estimate.jumps, tie: estimate.km }', replace: 'return { value: estimate.jumps || 0, tie: estimate.km }', fails: ['unknown'] },
  { name: 'unknown figures sorted first when the sort runs down', file: T, find: '(x === null ? 1 : -1) : (typeof x', replace: '(x === null ? 1 : -1) * direction : (typeof x', fails: ['unknown'] },
  { name: 'unknown figures sorted first', file: T, find: '(x === null ? 1 : -1) : (typeof x', replace: '(x === null ? -1 : 1) : (typeof x', fails: ['unknown'] },
  { name: 'a null table field compared as 0', file: T, find: 'const compare = (x, y) => (x === y ? 0 : x === null || y === null ?', replace: 'const compare = (x, y) => (x === y ? 0 : false ?', fails: ['unknown'] },
  { name: 'the sort direction ignored', file: T, find: ': x - y) * direction)', replace: ': x - y))', fails: ['unknown', 'sorts'] },
  { name: 'the time sort tie dropped', file: T, find: 'tie: sort === \'time\' ? estimate.km : estimate.jumps }', replace: 'tie: null }', fails: ['sorts'] },
  { name: 'the jumps sort tie dropped', file: T, find: 'return { value: estimate.jumps, tie: estimate.km }', replace: 'return { value: estimate.jumps, tie: null }', fails: ['sorts'] },
  { name: 'the tie broken on an unknown value', file: T, find: 'by === \'transitValue\' && a[by] !== null ?', replace: 'by === \'transitValue\' ?', fails: ['sorts'] },
  { name: 'a class with no stored size read as carried by a drive', file: T, find: 'if (!Number.isFinite(hull) || hull <= 0) {', replace: 'if (false) {', fails: ['class'] },
  { name: 'a class whose drive is too small read as carried', file: T, find: 'Number.isFinite(size) && size >= hull)', replace: 'Number.isFinite(size) && size > 0)', fails: ['class'] },
  { name: 'a drive whose rating is not stored read as no drive', file: T, find: 'return unrated || sizes.some((size) => !Number.isFinite(size)) ? null : false', replace: 'return false', fails: ['class'] },
  { name: 'the flag that a rating is not stored ignored', file: T, find: 'return unrated || sizes.some(', replace: 'return sizes.some(', fails: ['class'] },
  { name: 'a known sufficient drive discarded when another drive has no rating', file: T, find: 'if (sizes.some((size) => Number.isFinite(size) && size >= hull)) {', replace: 'if (!unrated && sizes.some((size) => Number.isFinite(size) && size >= hull)) {', fails: ['class', 'loader'] },
  { name: 'a sufficient ordinary drive not counted for a commercial hull', file: T, find: 'carries([any, ordinary], Boolean(anyUnrated || ordinaryUnrated), hull)', replace: 'carries([any], Boolean(anyUnrated), hull)', fails: ['class'] },
  { name: 'an ordinary drive with no rating left out of a commercial hull\'s unknowns', file: T, find: 'Boolean(anyUnrated || ordinaryUnrated)', replace: 'Boolean(anyUnrated)', fails: ['class'] },
  { name: 'an engine flag that is not stored read as a commercial hull', file: T, find: 'const unsure = engines === null || engines === undefined', replace: 'const unsure = false', fails: ['class', 'loader'] },
  { name: 'an engine flag that is not stored left no way to tell the drives apart as no drive', file: T, find: 'military === true ? true : null) : engines', replace: 'military === true ? true : false) : engines', fails: ['class', 'loader'] },
  { name: 'a rating that is not stored left out of the unrated flag', file: D, find: 'max(FCT_ShipDesignComponents.ComponentValue is null) ${from}), 0)', replace: '0 ${from}), 0)', fails: ['loader'] },
  { name: 'a drive whose rating is not stored left out of the largest rating', file: D, find: 'coalesce((select max(FCT_ShipDesignComponents.ComponentValue) ${from}), 0) as ${alias},', replace: 'coalesce((select case when max(FCT_ShipDesignComponents.ComponentValue is null) then null else max(FCT_ShipDesignComponents.ComponentValue) end ${from}), 0) as ${alias},', fails: ['loader'] },
  { name: 'a class with no jump drive component read as a drive whose rating is not stored', file: D, find: 'max(FCT_ShipDesignComponents.ComponentValue is null) ${from}), 0)', replace: 'max(FCT_ShipDesignComponents.ComponentValue is null) ${from}), 1)', fails: ['loader'] },
  { name: 'the ordinary drives counted with every kind', file: D, find: 'const ORDINARY_DRIVES = \' and FCT_ShipDesignComponents.SpecialFunction = 0\'', replace: 'const ORDINARY_DRIVES = \'\'', fails: ['loader'] },
  { name: 'a drive whose kind is not stored dropped from the classes read', file: D, find: 'const UNKNOWN_KIND_DRIVES = \' and FCT_ShipDesignComponents.SpecialFunction is null\'', replace: 'const UNKNOWN_KIND_DRIVES = \' and 0\'', fails: ['loader'] },
  { name: 'a drive whose kind is not stored read as no drive for a military hull', file: T, find: 'const military = ordinaryCarries === false && (', replace: 'const military = false && (', fails: ['class', 'loader'] },
  { name: 'a drive whose kind is not stored and has no rating left out of a military hull\'s unknowns', file: T, find: '(noKindUnrated || (Number.isFinite(noKind) && noKind >= hull))', replace: '(Number.isFinite(noKind) && noKind >= hull)', fails: ['class', 'loader'] },
  { name: 'a drive whose kind is not stored always leaves a military hull open', file: T, find: '(noKindUnrated || (Number.isFinite(noKind) && noKind >= hull)) ? null : ordinaryCarries', replace: 'true ? null : ordinaryCarries', fails: ['class', 'loader'] },
  { name: 'the points flagged to be ignored for distance left out of the search', file: T, find: 'const { jumpPoints, colonies } = routes', replace: 'const { colonies } = routes\n  const jumpPoints = routes.jumpPoints.filter((jumpPoint) => !jumpPoint.IgnoreForDistance)', fails: ['ignored'] },
  { name: 'the fewest jumps taken instead of the shortest route', file: T, find: 'const options = { order: \'km\',', replace: 'const options = { order: \'jumps\',', fails: ['order'] },
  { name: 'a body in no known origin system read as reached', file: T, find: 'const hasOrigin = colonies.some(hasPosition)', replace: 'const hasOrigin = true', fails: ['unknown'] },
  { name: 'a body without a position read as routed from the origin', file: T, find: '} else if (!hasPosition(body)) {', replace: '} else if (false) {', fails: ['unknown'] },
  { name: 'the unexplored links crossed', file: J, find: 'if (state.at.Explored && partner &&', replace: 'if (partner &&', fails: ['hidden'] },
  { name: 'a link whose far side is not charted crossed', file: J, find: ' and FCT_RaceJumpPointSurvey.Charted = 1\ninner join FCT_RaceSysSurvey', replace: '\ninner join FCT_RaceSysSurvey', fails: ['hidden'] },
  { name: 'the speed change finds links by crossing more with a faster ship', file: T, find: 'const chosen = normaliseBasis(basis)', replace: 'const chosen = normaliseBasis(basis)\n  chosen.drive = chosen.speed > 1000 ? \'drive\' : chosen.drive', fails: ['hidden'] },
  { name: 'the route estimate stated as confirmed', file: T, find: 'verification: \'estimated\',\n  structure: [\'FCT_JumpPoint.Xcor, Ycor, WPLink, JumpGateStrength\'', replace: 'verification: \'confirmed\',\n  structure: [\'FCT_JumpPoint.Xcor, Ycor, WPLink, JumpGateStrength\'', fails: ['registry', 'speed'] },
  { name: 'the speed stated as estimated', file: T, find: 'verification: \'assumed\',\n  structure: [\'FCT_ShipClass.MaxSpeed\']', replace: 'verification: \'estimated\',\n  structure: [\'FCT_ShipClass.MaxSpeed\']', fails: ['registry', 'speed'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts ----------

const sourcesOf = (mutant) => {
  const sources = {}

  if (mutant) {
    sources[mutant.file] = patched(`${mutant.file}.js`, fs.readFileSync(path.join(utilities, `${mutant.file}.js`), 'utf8'), mutant.find, mutant.replace)
  }

  return sources
}

const modulesOf = async (sources) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources })

  return { transit: loaded[T], graph: loaded[J], provenance: loaded.provenance, transport: loaded.transport, data: loaded['colonization-data'] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const statementsOf = (m, held) => [...fixtures(m), ...pageStatements(), ...saveStatements(m, held)]

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      const given = await test()

      result = given === undefined ? true : Array.isArray(given) ? given : given
    } catch (error) {
      result = `${error.name === 'AssertionError' ? '' : 'threw '}${String(error.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`
    }

    results.push([name, result])
  }

  return results
}

const checkHead = async () => {
  const held = []
  const m = await modulesOf({})

  console.log('\nColonization Planner transit estimate, on fixtures and the saves')

  try {
    for (const [name, result] of await runStatements(statementsOf(m, held))) {
      if (Array.isArray(result)) {
        check(name, result[0], result[1])
      } else {
        check(name, result)
      }
    }
  } finally {
    for (const close of held) {
      await close()
    }
  }
}

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  const held = []
  let m

  try {
    m = await modulesOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  try {
    const statements = [...fixtures(m), ...pageStatements()]
    const absent = mutant.fails.filter((key) => !statements.some(([name]) => keyOf(name) === key))
    const results = await runStatements(statements, mutant.fails)
    const missed = mutant.fails.filter((key) => {
      const ran = results.filter(([name]) => keyOf(name) === key)

      return ran.length > 0 && !ran.some(([, result]) => result !== true)
    })

    check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
  } finally {
    for (const close of held) {
      await close()
    }
  }
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: [] }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--save') {
      options.saves.push({ label: `save ${options.saves.length + 1}`, file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  if (options.saves.length) {
    process.env.COLONY_TRANSIT_SAVES = JSON.stringify(options.saves)
  }

  const wanted = options.mutations ? MUTANTS : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
