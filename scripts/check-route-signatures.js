/*
  Checks how the Hauling page groups the fleets that run the same repeating route, and how it covers and audits them (src/renderer/utilities/route-signatures.js, route-queues.js, route-audit.js, route-desires.js, the components of components/hauling and the page itself), against queues and databases worked out by hand here.

  Run: CHECK_JOBS=1 bun scripts/check-route-signatures.js [--no-mutations] [--detail] [--variants=<key>[,<key>...]] [--only=<text>|<text>] [--resume]

  The statements cover the acceptance of AE-090-02:
  - a saved queue is the live queue, so one cycle is saved at every rotation (and a queue holding a block twice is the block): every rotation and every repeat of one cycle gives one route, whose fleets are listed once;
  - the key of a route is the path and the service of each order; mineral, quantity and a flagged minimum are part of it, the pacing only sorts the fleets of a route into sub-groups, and another set of conditional orders makes another route;
  - the ten relations between two routes, the shapes of a queue (a route, a queue with no orders, one that cannot be traced, a closed queue, one that repeats a fixed number of times, none) and the classes of the states of a fleet on a route;
  - two identical observed cycles group once with both fleets, their capacity is summed once, and a group's capacity, status and duplicate flag follow its capable fleets;
  - a desired route with no capable active fleet is `uncovered`, which is not the `unknown` of a cycle that is observed and cannot be told, and a desired route is only ever the player's own record, kept apart from the observed groups;
  - the History page's backup registers the desired routes: a restore previewed through the adapter its own `backupAnnotations` returns keeps a kept route, which a repository with no adapter of the kind rejects;
  - every group and every fleet of it names the stored orders it was inferred from;
  - the loader reads the queues of a database made here, in a save of 2.6 or later, and says why it cannot read one that predates the conditional orders;
  - the page, in a browser over a constructed copy of a save, draws the groups, their fleets, their stored orders, their capacity (the fleets' own figures of the table above it, summed once), their flags and the queues that do not repeat, each read back by the `data-*` hook it carries and against the page's own tables of words.

  Every planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names by a wrong value of its own, never because a call threw (scripts/lib/fault-credit.js); each benign rewrite (a v-on longhand, an explicit prop and event in place of v-model, a qualifier moved from the front of a label to the back, an element of another kind, parts of a line in another order, a parenthesised condition and the like) must leave every check green. Prints `N of N checks passed`; a failed check, a fault that no named check catches and a rewrite that changes a verdict each set exit code 1. The suite runs through scripts/lib/suite-runner.js: the head of the pure parts, the head of the panel of the routes and the head of the desired routes (`page`, `page-desires`), and each fault and rewrite in a worker, the page ones on a page server and a browser started once for them (Playwright's Chromium).

  No statement matches source text or prose: an expected value is a fixture's own, a SQL answer or a figure of the page above the panel.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Database } = require('bun:sqlite')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { runSuite } = require('./lib/suite-runner')
const { assert, runChecks, caughtBy, subjectModule, harnessStore, boundary } = require('./lib/fault-credit')

const root = path.resolve(__dirname, '..')
const inRenderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)

const FILES = {
  signatures: inRenderer('utilities', 'route-signatures.js'),
  audit: inRenderer('utilities', 'route-audit.js'),
  queues: inRenderer('utilities', 'route-queues.js'),
  desires: inRenderer('utilities', 'route-desires.js'),
  cargo: inRenderer('utilities', 'hauling.js'),
  groups: inRenderer('components', 'hauling', 'RouteGroups.vue'),
  page: inRenderer('pages', 'hauling.vue'),
  desireView: inRenderer('components', 'hauling', 'RouteDesires.vue'),
  desireMixin: inRenderer('mixins', 'route-desires.js'),
  history: inRenderer('pages', 'history.vue'),
}
const UTILITY_NAMES = { signatures: 'route-signatures', audit: 'route-audit', queues: 'route-queues', desires: 'route-desires', cargo: 'hauling' }
const NAMES = ['route-signatures', 'route-audit', 'route-queues', 'route-desires', 'hauling', 'scenario-records', 'provenance', 'history-milestones', 'economy-notes']

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
// The scenario records of a loaded History page as a module of their own, so the adapters one copy of the page registers are not the registry of another.
const recordsOf = (tag) => ({ 'utilities/scenario-records': `${fs.readFileSync(inRenderer('utilities', 'scenario-records.js'), 'utf8')}\n// ${tag}\n` })
// The store the History page is given is the harness's: a read of it that fails stops the run, where the page's own code runs behind the boundary of scripts/lib/fault-credit.js.
const PAGE_STORE = harnessStore({ getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100000 }, state: { history: { revision: 0 } }, dispatch: async () => {} }, { 'history/campaign': ['object'], GameTime: ['number'] })

const options = { mutations: !process.argv.includes('--no-mutations'), detail: process.argv.includes('--detail') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  [${String(detail).slice(0, 600)}]` : ''}`)
}

// ---- Fixtures: the move actions' own flags, and the orders of queues worked out by hand --------------------------------

const RACE = 7
const ACTIONS = {
  1: { name: 'Standard Transit', item: 0, quantity: false, minimum: false, transit: true },
  4: { name: 'Load Colonists', item: 0, quantity: true, minimum: false, transit: false },
  6: { name: 'Unload Colonists', item: 0, quantity: true, minimum: false, transit: false },
  62: { name: 'Load All Minerals', item: 0, quantity: false, minimum: false, transit: false },
  63: { name: 'Unload All Minerals', item: 0, quantity: false, minimum: false, transit: false },
  96: { name: 'Unload All Installations', item: 0, quantity: false, minimum: false, transit: false },
  124: { name: 'Standard Transit Inside System', item: 13, quantity: false, minimum: false, transit: false },
  165: { name: 'Balance Minerals', item: 0, quantity: false, minimum: false, transit: false },
  176: { name: 'Load Installation', item: 2, quantity: true, minimum: false, transit: false },
  177: { name: 'Unload Installation', item: 19, quantity: true, minimum: false, transit: false },
  178: { name: 'Load Mineral Type', item: 1, quantity: true, minimum: false, transit: false },
  179: { name: 'Unload Mineral Type', item: 20, quantity: true, minimum: false, transit: false },
  180: { name: 'Load Mineral when X available', item: 1, quantity: true, minimum: true, transit: false },
  223: { name: 'Load All Minerals Until Full', item: 0, quantity: false, minimum: false, transit: false },
}

// The colony of system n is population 100 + n on body 1000 + n; the jump points between systems a and b are 1000 a + b (leaving a) and 1000 b + a (entering b), moved by `via` for another pair.
const stop = (system, action, extra = {}) => ({ StartSystemID: system, MoveActionID: action, DestinationType: 2, DestinationID: 1000 + system, PopulationID: 100 + system, PopulationRaceID: RACE, ...extra })
const jump = (from, to, via = 0) => ({ StartSystemID: from, MoveActionID: 1, DestinationType: 1, DestinationID: via + from * 1000 + to, NewSystemID: to, NewWarpPointID: via + to * 1000 + from })
const spec = (load) => (Array.isArray(load) ? load : [load])

// One cycle between the colonies of two systems: load there, cross, unload here, cross back. `load` and `unload` are an action or [action, extra fields of the order].
const loop = (load, unload, { from = 1, to = 2, via = 0 } = {}) => [stop(from, ...spec(load)), jump(from, to, via), stop(to, ...spec(unload)), jump(to, from, via)]
const MINERALS = () => loop(223, 63)

// A cycle through three colonies: round the ring one way, or the other.
const RING = () => [stop(1, 223), jump(1, 2), stop(2, 63), stop(2, 223), jump(2, 3), stop(3, 63), jump(3, 1)]
const RING_BACK = () => [stop(1, 223), jump(1, 3), stop(3, 63), stop(3, 223), jump(3, 2), stop(2, 63), jump(2, 1)]

const blank = { MoveOrderID: 0, FleetID: 0, MoveOrder: 0, MoveActionID: 0, StartSystemID: 0, DestinationType: 0, DestinationID: 0, PopulationID: 0, PopulationRaceID: null, DestinationItemType: 0, DestinationItemID: 0, MaxItems: 0, MinQuantity: 0, OrderDelay: 0, OrderDelayRemaining: 0, Arrived: 0, NewSystemID: 0, NewWarpPointID: 0, Description: '' }

const rotated = (list, by) => [...list.slice(by % (list.length || 1)), ...list.slice(0, by % (list.length || 1))]

// The stored rows of a fleet's queue: the parts rotated, numbered from 1 (the head), the ids 100 x fleet + place. `head` changes the head row.
const storedOf = (fleetId, parts, { rotate = 0, head = {} } = {}) => rotated(parts, rotate).map((part, index) => ({ ...blank, ...part, MoveOrderID: fleetId * 100 + index, FleetID: fleetId, MoveOrder: index + 1, ...(index === 0 ? head : {}) }))

const CONDITION = { Priority: 1, ConditionID: 10, ConditionalOrderID: 33, CreateFWP: 0, ConditionName: 'Fuel at or below 30%' }

const ship = (fuel, capacity = 100) => ({ Fuel: fuel, FuelCapacity: capacity })

const recordOf = (m, id, parts, { rotate = 0, cycle = 1, name = `Fleet ${id}`, head = {}, conditionals = [], ignored = false, standing = 0, ships = [] } = {}) => m.sig.describeFleet({ FleetID: id, FleetName: name, CycleMoves: cycle, IgnoreConditional: ignored ? 1 : 0 }, storedOf(id, parts, { rotate, head }), { actions: ACTIONS, raceId: RACE, conditionals, standing, ships })

// The fleets of a list as the sorted sets of their ids, one set a group: what the page draws as "these fleets run one route".
const partitionOf = (m, records) => m.sig.groupRoutes(records).map((group) => group.fleets.map((record) => record.FleetID).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])

const figure = (extra = {}) => ({ ships: 2, holds: true, profile: 'ok', traced: true, blocked: 0, unknown: 0, moving: true, year: { minerals: 100, installations: 0, colonists: 0, trips: 4 }, ...extra })

const yearOf = (minerals, installations, colonists, trips) => ({ minerals, installations, colonists, trips })

// ---- The checks of the pure parts --------------------------------------------------------------------------------------

const CHECKS = []
const add = (id, name, run, part = 'head') => CHECKS.push({ id, name, run, part })

add('rotation', 'one cycle saved at every rotation is one route, and a cycle with the same stops the other way round is not', ({ m }) => {
  const cycle = MINERALS()
  const records = [0, 1, 2, 3].map((by) => recordOf(m, 10 + by, cycle, { rotate: by }))
  const other = recordOf(m, 20, loop(223, 63, { from: 2, to: 1 }))
  const ring = recordOf(m, 30, RING())
  const back = recordOf(m, 31, RING_BACK())

  assert.deepEqual(partitionOf(m, [...records, other]), [[10, 11, 12, 13], [20]], 'the fleets of each route')
  assert.deepEqual(partitionOf(m, [ring, back]), [[30], [31]], 'the ring one way and the other')
  assert.equal(new Set(records.map((record) => record.route.key)).size, 1, 'the keys of the four rotations')
  assert.equal(new Set(records.map((record) => record.route.id)).size, 1, 'the ids of the four rotations')
  assert.notEqual(records[0].route.key, other.route.key, 'the key of the other route')

  // Where the head order sits in the key moves with the rotation: one step of rotation is one step of the head.
  records.forEach((record, by) => assert.equal((record.route.headPosition - records[0].route.headPosition + 4) % 4, by, `the head of the fleet saved at rotation ${by}`))
})

add('period', 'a queue that holds a cycle twice or three times is that cycle, and one order of it that differs is another route', ({ m }) => {
  const cycle = MINERALS()
  const single = recordOf(m, 1, cycle)
  const twice = recordOf(m, 2, [...cycle, ...cycle], { rotate: 1 })
  const thrice = recordOf(m, 3, [...cycle, ...cycle, ...cycle])
  const different = recordOf(m, 4, [...cycle, ...loop([178, { DestinationItemID: 1, MaxItems: 5 }], 63)])

  assert.deepEqual(partitionOf(m, [single, twice, thrice, different]), [[1, 2, 3], [4]], 'the fleets of each route')
  assert.deepEqual([single, twice, thrice].map((record) => [record.route.period, record.route.length, record.route.repeats]), [[4, 4, 1], [4, 8, 2], [4, 12, 3]], 'period, length and repeats')
  assert.equal(m.sig.periodOf(['a', 'b', 'a', 'b']), 2, 'the period of a repeated pair')
  assert.equal(m.sig.periodOf(['a', 'b', 'a']), 3, 'a queue that does not repeat a block is its own period')
  assert.equal(m.sig.periodOf(['a', 'a']), 1, 'a pair of the same order is one order twice')
  assert.equal(m.sig.periodOf(['a']), 1, 'the period of one')
  assert.equal(m.sig.periodOf(['a', 'a'], ['x', 'y']), 2, 'a column that differs keeps the period whole')
  assert.equal(m.sig.periodOf([]), 0, 'the period of nothing')
})

add('key-fields', 'mineral, quantity and the minimum a load is flagged to read tell routes apart; a field the action does not read, the delay and the same place by body or colony do not', ({ m }) => {
  const load = (action, extra) => loop([action, extra], 63)
  const fleets = (list) => partitionOf(m, list.map(([id, parts]) => recordOf(m, id, parts)))
  const quantities = fleets([[1, load(178, { DestinationItemID: 1, MaxItems: 100 })], [2, load(178, { DestinationItemID: 1, MaxItems: 100 })], [3, load(178, { DestinationItemID: 1, MaxItems: 200 })], [4, load(178, { DestinationItemID: 2, MaxItems: 100 })]])

  assert.deepEqual(quantities, [[1, 2], [3], [4]], 'a load of one mineral: same quantity, another quantity, another mineral')

  // MinQuantity is a number of the game read as an integer, half to even, and only a load flagged to read it counts.
  const minimum = (value) => load(180, { DestinationItemID: 1, MaxItems: 10, MinQuantity: value })

  assert.deepEqual(fleets([[1, minimum(5)], [2, minimum(5.4)], [3, minimum(6)], [4, minimum(4.5)], [5, minimum(5.5)], [6, minimum(6.5)]]), [[1, 2], [3, 5, 6], [4]], 'the minimum read half to even: 5 and 5.4 are 5; 6, 5.5 and 6.5 are 6; 4.5 is 4')
  assert.deepEqual(fleets([[1, load(178, { DestinationItemID: 1, MaxItems: 10, MinQuantity: 3 })], [2, load(178, { DestinationItemID: 1, MaxItems: 10, MinQuantity: 9 })]]), [[1, 2]], 'a minimum that a load not flagged for it does not read')
  assert.deepEqual(fleets([[1, load(223, { MaxItems: 5 })], [2, load(223, { MaxItems: 9 })]]), [[1, 2]], 'a quantity that a load not flagged for it does not read')
  assert.deepEqual(fleets([[1, MINERALS()], [2, loop(62, 63)], [3, loop(223, 63, { via: 500 })], [4, loop(223, 63, { to: 3 })]]), [[1], [2], [3], [4]], 'another action, another jump point, another colony')
  assert.deepEqual(fleets([[1, MINERALS()], [2, MINERALS().map((part, index) => (index === 0 ? { ...part, OrderDelay: 3600 } : part))]]), [[1, 2]], 'the delay of an order does not tell routes apart')
  assert.deepEqual(fleets([[1, MINERALS()], [2, MINERALS().map((part) => (part.DestinationType === 2 ? { ...part, DestinationType: 15 } : part))]]), [[1, 2]], 'a body that a colony is on, reached as a deep space population or as a body')
  assert.deepEqual(fleets([[1, MINERALS()], [2, MINERALS().map((part) => (part.DestinationType === 2 ? { ...part, PopulationID: 0 } : part))]]), [[1], [2]], 'the bare body of a colony is not the colony')
  assert.deepEqual(fleets([[1, MINERALS()], [2, MINERALS().map((part) => (part.DestinationType === 2 ? { ...part, PopulationRaceID: RACE + 1 } : part))]]), [[1], [2]], 'a colony of another race is only its body')
})

add('path-identity', 'a jump inside a system is told by its entry and its exit, and a survey location by the system it is in', ({ m }) => {
  const fleets = (list) => partitionOf(m, list.map(([id, parts, rotate]) => recordOf(m, id, parts, { rotate })))
  const within = (entry, exit) => [stop(1, 223), { StartSystemID: 1, MoveActionID: 124, DestinationType: 12, DestinationID: entry, DestinationItemID: exit }, jump(1, 2), stop(2, 63), jump(2, 1)]

  assert.deepEqual(fleets([[1, within(5, 6)], [2, within(5, 6), 2], [3, within(5, 7)], [4, within(8, 6)]]), [[1, 2], [3], [4]], 'the same entry and exit at another rotation; the same entry and another exit; another entry and the same exit')

  const surveyed = (system, location) => [stop(1, 223), { ...jump(1, 2), NewSystemID: system }, { StartSystemID: system, MoveActionID: 63, DestinationType: 4, DestinationID: location }, { ...jump(2, 1), StartSystemID: system }]

  assert.deepEqual(fleets([[1, surveyed(2, 7)], [2, surveyed(2, 7), 1], [3, surveyed(3, 7)], [4, surveyed(2, 8)]]), [[1, 2], [3], [4]], 'the same location of one system at another rotation; the same number in another system; another location')
})

add('pacing', 'fleets with one route and other delays are one group of sub-groups, the delay read from the same place of the cycle whichever rotation it is saved at', ({ m }) => {
  const delayed = (index, seconds) => MINERALS().map((part, at) => (at === index ? { ...part, OrderDelay: seconds } : part))
  const plain = recordOf(m, 1, MINERALS())
  const paced = recordOf(m, 2, delayed(1, 3600))
  const pacedRotated = recordOf(m, 3, delayed(1, 3600), { rotate: 2 })
  const other = recordOf(m, 4, delayed(2, 3600))
  const group = m.sig.groupRoutes([plain, paced, pacedRotated, other])

  assert.equal(group.length, 1, 'one group')
  assert.deepEqual(group[0].variants.map((variant) => variant.fleetIds).sort((a, b) => a[0] - b[0]), [[1], [2, 3], [4]], 'the sub-groups')
  assert.equal(paced.route.pacingKey, pacedRotated.route.pacingKey, 'the pacing of one cycle saved at two rotations')
  assert.notEqual(paced.route.pacingKey, other.route.pacingKey, 'a delay on another order of the cycle')
  assert.equal(m.sig.relationOf(plain, paced), 'same-route-pacing', 'the relation of two pacings')
  assert.equal(m.sig.relationOf(paced, pacedRotated), 'same-route', 'the relation of one pacing at two rotations')
})

add('conditions', 'another set of conditional orders is another route, a fleet that ignores them is on the route without them, and standing orders change nothing', ({ m }) => {
  const plain = recordOf(m, 1, MINERALS())
  const conditioned = recordOf(m, 2, MINERALS(), { conditionals: [CONDITION] })
  const same = recordOf(m, 3, MINERALS(), { conditionals: [{ ...CONDITION }] })
  const another = recordOf(m, 4, MINERALS(), { conditionals: [{ ...CONDITION, ConditionalOrderID: 34 }] })
  const ignored = recordOf(m, 5, MINERALS(), { conditionals: [CONDITION], ignored: true })
  const standing = recordOf(m, 6, MINERALS(), { standing: 3 })
  const two = recordOf(m, 7, MINERALS(), { conditionals: [{ ...CONDITION, Priority: 2, ConditionID: 1, ConditionalOrderID: 35 }, CONDITION] })
  const twoOther = recordOf(m, 8, MINERALS(), { conditionals: [CONDITION, { ...CONDITION, Priority: 2, ConditionID: 1, ConditionalOrderID: 35 }] })

  assert.deepEqual(partitionOf(m, [plain, conditioned, same, another, ignored, standing, two, twoOther]), [[1, 5, 6], [2, 3], [4], [7, 8]], 'the groups by conditional set')
  assert.equal(m.sig.relationOf(plain, conditioned), 'same-route-conditions', 'the relation of two sets')
  assert.deepEqual([plain, conditioned, ignored, standing].map((record) => record.conditional.status), ['none', 'unresolvable', 'ignored', 'none'], 'the status of each set (no ship is read, so a fuel condition cannot be told)')
  assert.equal(ignored.conditional.ignored, true, 'the flag of the fleet that ignores them stays')
  assert.equal(standing.standing, 3, 'the standing orders are counted')

  // The fuel conditions: any ship at or below the share the condition names, or full for 1; any other condition cannot be read.
  const statusOf = (condition, ...tanks) => m.sig.conditionStatus(condition, tanks.map((tank) => ship(...tank)))

  assert.equal(statusOf(10, [30]), 'true-now', 'fuel at 30% for the condition at or below 30%')
  assert.equal(statusOf(10, [31]), 'armed', 'fuel at 31% is above it')
  assert.equal(statusOf(10, [31], [10]), 'true-now', 'one ship low is enough')
  assert.equal(statusOf(12, [50]), 'true-now', 'the 50% condition')
  assert.equal(statusOf(11, [41]), 'armed', 'the 40% condition')
  assert.equal(statusOf(2, [20]), 'true-now', 'the 20% condition')
  assert.equal(statusOf(3, [11]), 'armed', 'the 10% condition')
  assert.equal(statusOf(1, [100]), 'true-now', 'tanks full')
  assert.equal(statusOf(1, [99]), 'armed', 'tanks not full')
  assert.equal(statusOf(10, [31], [0, 0]), 'unresolvable', 'a tank with no capacity cannot be read')
  assert.equal(statusOf(10), 'unresolvable', 'a fleet with no ship cannot be read')
  assert.equal(statusOf(77, [5]), 'unresolvable', 'a condition of anything but fuel cannot be read')
  assert.equal(recordOf(m, 9, MINERALS(), { conditionals: [CONDITION], ships: [ship(90)] }).conditional.status, 'armed', 'armed in a fleet whose tanks are 90%')
  assert.equal(recordOf(m, 9, MINERALS(), { conditionals: [CONDITION], ships: [ship(20)] }).conditional.status, 'true-now', 'true now in a fleet whose tanks are 20%')
  assert.equal(recordOf(m, 9, MINERALS(), { conditionals: [CONDITION, { ...CONDITION, ConditionID: 77, Priority: 2 }], ships: [ship(90)] }).conditional.status, 'unresolvable', 'the worst of two conditions')
})

add('shapes', 'a queue is a route, empty, untraceable (with why), closed, a fixed number of repeats or none, and only a route is service', ({ m }) => {
  const cycle = MINERALS()
  const shapes = {
    route: recordOf(m, 1, cycle),
    empty: recordOf(m, 2, []),
    oneOrder: recordOf(m, 3, [stop(1, 223)]),
    chain: recordOf(m, 4, [stop(1, 223), stop(2, 63)]),
    unknown: recordOf(m, 5, [stop(0, 223), jump(0, 2)]),
    closed: recordOf(m, 6, cycle, { cycle: 0 }),
    finite: recordOf(m, 7, [...cycle, ...cycle], { cycle: 0 }),
    none: recordOf(m, 8, loop(63, 63), { cycle: 0 }),
    single: recordOf(m, 9, [stop(1, 223)], { cycle: 0 }),
    noFlow: recordOf(m, 10, loop(1, 1), { cycle: 0 }),
  }

  assert.deepEqual(Object.fromEntries(Object.entries(shapes).map(([name, record]) => [name, [record.shape, record.problem]])), {
    route: ['route', null],
    empty: ['empty', null],
    oneOrder: ['untraceable', 'one-order'],
    chain: ['untraceable', 'chain'],
    unknown: ['untraceable', 'start-unknown'],
    closed: ['closed', null],
    finite: ['finite-repeat', null],
    none: ['none', null],
    single: ['none', null],
    noFlow: ['none', null],
  }, 'the shape and the problem of each queue')
  assert.deepEqual(partitionOf(m, Object.values(shapes)), [[1]], 'only the fleet that repeats a route is on one')
  assert.deepEqual([shapes.empty, shapes.closed, shapes.finite, shapes.route].map((record) => record.route === null), [true, false, false, false], 'a queue with no orders has no route')
  assert.equal(shapes.finite.route.repeats, 2, 'the repeats of the queue that repeats twice')
  assert.deepEqual(Object.keys(m.raw.SHAPES).sort(), ['closed', 'empty', 'finite-repeat', 'route', 'untraceable'], 'the shapes that are named')
  assert.deepEqual(Object.keys(m.raw.PROBLEMS).sort(), ['chain', 'one-order', 'start-unknown'], 'the problems that are named')
})

add('flows', 'a cycle moves what its loads and unloads say, read over two passes so that what is held on entering the cycle is credited to its source', ({ m }) => {
  const flowsOf = (parts, rotate = 0) => recordOf(m, 1, parts, { rotate }).flows.map(({ kind, from, to }) => `${kind}|${from}|${to}`)
  const one = ['minerals|colony:101|colony:102']

  assert.deepEqual(flowsOf(MINERALS()), one, 'minerals from one colony to the other')

  for (const by of [1, 2, 3]) {
    assert.deepEqual(flowsOf(MINERALS(), by), one, `the same flow at rotation ${by}`)
  }

  assert.deepEqual(flowsOf(loop(4, 6)), ['colonists|colony:101|colony:102'], 'colonists')
  assert.deepEqual(flowsOf(loop(176, 96)), ['installations|colony:101|colony:102'], 'installations')
  assert.deepEqual(flowsOf(loop(165, 165)), ['reserve|colony:101|colony:101', 'reserve|colony:102|colony:102'], 'a reserve balance is its own flow at each colony')
  assert.deepEqual(flowsOf([stop(1, 178, { DestinationItemID: 1, MaxItems: 5 }), stop(1, 178, { DestinationItemID: 2, MaxItems: 5 }), jump(1, 2), stop(2, 63), jump(2, 1)]), one, 'two loads of different minerals at one colony are one flow')
  assert.deepEqual(flowsOf(loop(63, 63)), [], 'an unload with nothing loaded is no flow')
  assert.deepEqual(flowsOf(RING()), ['minerals|colony:101|colony:102', 'minerals|colony:102|colony:103'], 'what is held stays held at the next unload')
  assert.deepEqual(flowsOf([stop(1, 223), jump(1, 2), stop(2, 63), jump(2, 3), stop(3, 63), jump(3, 1)]), one, 'a second unload finds nothing left of what the first took')
  const typed = (system, action, item, quantity = 0) => stop(system, action, { DestinationItemID: item, MaxItems: quantity })

  assert.deepEqual(flowsOf([typed(1, 178, 1, 5), jump(1, 2), typed(2, 179, 1, 5), jump(2, 3), stop(3, 63), jump(3, 1)]), ['minerals|colony:101|colony:102'], 'an unload of a quantity that is all the load takes it all')
  assert.deepEqual(flowsOf([typed(1, 178, 1, 10), jump(1, 2), typed(2, 179, 1, 5), jump(2, 3), stop(3, 63), jump(3, 1)]), ['minerals|colony:101|colony:102', 'minerals|colony:101|colony:103'], 'an unload of part of a load leaves the rest to the next')
  assert.deepEqual(flowsOf([typed(1, 178, 1, 10), jump(1, 2), typed(2, 179, 1, 5), jump(2, 3), typed(3, 179, 1, 5), jump(3, 4), stop(4, 63), jump(4, 1)]), ['minerals|colony:101|colony:102', 'minerals|colony:101|colony:103'], 'two unloads of a quantity that together take the load leave nothing for the last')
  assert.deepEqual(flowsOf([typed(1, 178, 1, 5), jump(1, 2), typed(2, 178, 2, 5), jump(2, 3), typed(3, 179, 1), jump(3, 4), stop(4, 63), jump(4, 1)]), ['minerals|colony:101|colony:103', 'minerals|colony:102|colony:104'], 'an unload of one mineral takes that mineral only')
  assert.deepEqual(flowsOf([stop(1, 223), jump(1, 2), typed(2, 179, 1), jump(2, 3), stop(3, 63), jump(3, 1)]), one, 'what was loaded as any mineral may be the one an unload names')
  assert.deepEqual(flowsOf([stop(1, 178, { DestinationItemID: 1, MaxItems: 5 }), jump(1, 2), stop(2, 179, { DestinationItemID: 1 }), jump(2, 3), stop(3, 63), jump(3, 1)]), ['minerals|colony:101|colony:102'], 'an unload that names no quantity takes all that is held')
  assert.deepEqual(flowsOf([stop(1, 4), jump(1, 2), stop(2, 6, { MaxItems: 5 }), jump(2, 3), stop(3, 6), jump(3, 1)]), ['colonists|colony:101|colony:102'], 'an unload of colonists takes all it can whatever its quantity says')
  assert.deepEqual(flowsOf([stop(1, 4), jump(1, 2), stop(2, 6), jump(2, 3), stop(3, 6), jump(3, 1)]), ['colonists|colony:101|colony:102'], 'an unload of all that is held leaves nothing')
  assert.deepEqual(flowsOf([stop(1, 223), jump(1, 2), stop(2, 63, { MaxItems: 5 }), jump(2, 3), stop(3, 63), jump(3, 1)]), one, 'a quantity an action does not read does not limit it')
  assert.deepEqual(flowsOf([stop(1, 223), jump(1, 3), stop(3, 62), jump(3, 2), stop(2, 63), jump(2, 1)]), ['minerals|colony:101|colony:102', 'minerals|colony:103|colony:102'], 'two loads for one unload are two flows')
})

add('relations', 'the relation of two routes is the first that holds of ten', ({ m }) => {
  const relation = (a, b) => m.sig.relationOf(a, b)
  const base = recordOf(m, 1, MINERALS())
  const cases = {
    'same-route': recordOf(m, 2, MINERALS(), { rotate: 1 }),
    'same-route-pacing': recordOf(m, 3, MINERALS().map((part, index) => (index === 1 ? { ...part, OrderDelay: 60 } : part))),
    'same-route-conditions': recordOf(m, 4, MINERALS(), { conditionals: [CONDITION] }),
    'same-flows-path': recordOf(m, 5, loop(223, 63, { via: 500 })),
    'same-flows-service': recordOf(m, 6, loop(62, 63)),
    reversed: recordOf(m, 7, loop(223, 63, { from: 2, to: 1 })),
    'same-pair': recordOf(m, 8, loop(4, 6)),
    partial: recordOf(m, 9, RING()),
    endpoint: recordOf(m, 10, loop(4, 6, { from: 3, to: 2 })),
    unrelated: recordOf(m, 11, loop(223, 63, { from: 3, to: 4 })),
  }

  Object.entries(cases).forEach(([expected, other]) => assert.equal(relation(base, other), expected, `the relation of the route to the one that is "${expected}"`))
  assert.deepEqual(Object.keys(m.raw.RELATIONS).sort(), Object.keys(cases).sort(), 'the relations that are named')
  assert.equal(relation(cases.reversed, base), 'reversed', 'a reversed flow is reversed from either side')
  assert.equal(relation(cases.partial, base), 'partial', 'a shared flow from either side')
})

add('names', 'a route is named by its template (every matching template listed), else its fleet, else its colonies, with where the name came from', ({ m }) => {
  const rowsOf = (parts) => parts.map((part, index) => ({ ...part, MoveIndex: index + 1, NewJumpPointID: part.NewWarpPointID, MoveOrderID: undefined }))
  const template = (id, name, parts, by = 0) => ({ OrderTemplateID: id, TemplateName: name, orders: rowsOf(rotated(parts, by)) })
  const index = m.sig.templateIndex([template(1, 'Zeta run', MINERALS()), template(2, 'Alpha run', MINERALS(), 2), template(3, 'Open', [stop(1, 223), jump(1, 2), stop(2, 63)]), template(4, 'One', [stop(1, 223)]), template(5, 'Paced', MINERALS().map((part, at) => (at === 0 ? { ...part, OrderDelay: 90 } : part)))], { actions: ACTIONS, raceId: RACE })

  assert.equal(index.size, 1, 'a template that is no cycle, open or of one order, names no route')

  const group = (records) => m.sig.groupRoutes(records)[0]
  const one = group([recordOf(m, 1, MINERALS(), { name: 'Hauler One' })])
  const named = m.sig.routeName(one, { templates: index })

  assert.deepEqual([named.name, named.source, named.others, named.exact], ['Alpha run', 'template', ['Paced', 'Zeta run'].sort(), true], 'the first of the matching templates, the others, and that the pacing matches too')
  assert.equal(m.sig.routeName(group([recordOf(m, 1, MINERALS(), { name: 'Hauler One' }), recordOf(m, 2, MINERALS(), { name: 'Hauler One' })]), {}).source, 'fleet', 'two fleets of one name')
  assert.deepEqual([m.sig.routeName(one, {}).name, m.sig.routeName(one, {}).source], ['Hauler One', 'fleet'], 'a route with no template is named by its fleet')

  const two = group([recordOf(m, 1, MINERALS(), { name: 'Hauler One' }), recordOf(m, 2, MINERALS(), { name: 'Hauler Two' })])
  const generated = m.sig.routeName(two, { colonyNames: { 'colony:101': 'Alpha', 'colony:102': 'Beta' } })

  assert.equal(generated.source, 'generated', 'two fleets of two names are named by their colonies')
  assert.ok(generated.name.includes('Alpha') && generated.name.includes('Beta'), `the generated name ${generated.name} names both colonies`)
  assert.equal(m.sig.routeName(two, { colonyNames: { 'colony:101': 'Alpha' } }).source, 'fleet', 'a colony with no name leaves the name of a fleet')
  assert.deepEqual(Object.keys(m.raw.NAME_SOURCES).sort(), ['fleet', 'generated', 'template'], 'the sources that are named')

  const paced = m.sig.routeName(group([recordOf(m, 1, MINERALS().map((part, at) => (at === 0 ? { ...part, OrderDelay: 90 } : part)), { name: 'Slow' })]), { templates: m.sig.templateIndex([template(1, 'Plain run', MINERALS())], { actions: ACTIONS, raceId: RACE }) })

  assert.deepEqual([paced.name, paced.source, paced.exact], ['Plain run', 'template', false], 'a template of the same route at another pacing is a match of content, not an exact one')

  const slowed = MINERALS().map((part, at) => (at === 0 ? { ...part, OrderDelay: 90 } : part))
  const first = m.sig.routeName(group([recordOf(m, 1, MINERALS(), { name: 'Hauler One' })]), { templates: m.sig.templateIndex([template(1, 'A slow template', slowed), template(2, 'Z matching template', MINERALS())], { actions: ACTIONS, raceId: RACE }) })

  assert.deepEqual([first.name, first.exact, first.others], ['A slow template', false, ['Z matching template']], 'the name shown is the first template, and its match is the one told: another pacing, though a template listed after it matches the pacing')

  const last = m.sig.routeName(group([recordOf(m, 1, slowed, { name: 'Hauler One' })]), { templates: m.sig.templateIndex([template(1, 'A plain template', MINERALS()), template(2, 'Z slow template', slowed)], { actions: ACTIONS, raceId: RACE }) })

  assert.deepEqual([last.name, last.exact, last.others], ['A plain template', false, ['Z slow template']], 'the first template at another pacing, and the second at the same one')

  const alike = m.sig.routeName(group([recordOf(m, 1, MINERALS(), { name: 'Hauler One' }), recordOf(m, 2, slowed, { name: 'Hauler Two' })]), { templates: m.sig.templateIndex([template(1, 'A plain template', MINERALS())], { actions: ACTIONS, raceId: RACE }) })

  assert.deepEqual([alike.name, alike.exact], ['A plain template', true], 'a fleet of the group at the same pacing as the template makes the match exact')
})

add('states', 'what a fleet of a route can do is told from the figures the page has for it', ({ m }) => {
  const table = [
    ['a fleet with ships, a hold, a cycle and a year', figure(), 'capable'],
    ['no figures at all', null, 'unknown'],
    ['no ship', figure({ ships: 0 }), 'empty'],
    ['a profile of none', figure({ profile: 'none' }), 'empty'],
    ['no hold', figure({ holds: false }), 'incompatible'],
    ['capacities of the ships not in the save', figure({ holds: null }), 'unknown'],
    ['no counted hold', figure({ profile: 'unsupported' }), 'incompatible'],
    ['a ship that cannot load at a stop', figure({ blocked: 1 }), 'incompatible'],
    ['an input not in the save', figure({ profile: 'unknown' }), 'unknown'],
    ['a cycle that cannot be traced', figure({ traced: false }), 'unknown'],
    ['stops not known to be possible', figure({ unknown: 2 }), 'unknown'],
    ['an immobile profile', figure({ profile: 'immobile' }), 'immobile'],
    ['no speed', figure({ moving: false }), 'immobile'],
    ['no year to the cycle', figure({ year: null }), 'unknown'],
  ]

  table.forEach(([name, given, expected]) => assert.equal(m.sig.memberState(given).state, expected, name))
  table.filter(([, , expected]) => expected !== 'capable').forEach(([name, given]) => assert.ok(m.sig.memberState(given).reason.length > 0, `the reason for ${name}`))
  assert.equal(m.sig.memberState(figure()).reason, '', 'a capable fleet needs no reason')
  assert.notEqual(m.sig.memberState(figure({ ships: 0 })).reason, m.sig.memberState(figure({ holds: false })).reason, 'the reasons of two states differ')
  assert.deepEqual(Object.keys(m.raw.STATES).sort(), ['capable', 'empty', 'immobile', 'incompatible', 'unknown'], 'the states that are named')
  assert.deepEqual(Object.keys(m.raw.GROUP_STATUSES).sort(), ['capable', 'conditional', 'incapable', 'paused', 'unknown'], 'the statuses of a group that are named')
  assert.deepEqual(Object.keys(m.raw.MATCHES).sort(), ['exact', 'pacing'], 'the matches of a template that are named')
})

add('cargo-fit', 'a fleet that moves none of the cargo a route carries is not capable of the route', ({ m }) => {
  const cargo = figure({ year: yearOf(100, 0, 0, 4) })
  const berths = figure({ year: yearOf(0, 0, 50, 4) })
  const state = (given, ...needs) => m.sig.memberState(given, needs).state

  assert.deepEqual([state(cargo, 'minerals'), state(cargo, 'colonists'), state(berths, 'colonists'), state(berths, 'minerals')], ['capable', 'incompatible', 'capable', 'incompatible'], 'a fleet of holds and a fleet of berths, on a route of freight and of colonists')
  assert.deepEqual([state(cargo, 'installations'), state(figure({ year: yearOf(0, 30, 0, 4) }), 'installations')], ['incompatible', 'capable'], 'installations')
  assert.equal(state(cargo, 'minerals', 'colonists'), 'capable', 'a route of both is served by a fleet that moves one of them')
  assert.equal(state(cargo), 'capable', 'a route that names no cargo')
  assert.ok(m.sig.memberState(cargo, ['colonists']).reason.length > 0, 'the reason it is not capable')

  const group = (parts, figures) => m.sig.coverGroups(m.sig.groupRoutes([recordOf(m, 1, parts), recordOf(m, 2, parts, { rotate: 1 })]), figures)[0]
  const colonists = group(loop(4, 6), { 1: berths, 2: cargo })

  assert.deepEqual([colonists.members.map((member) => member.state), colonists.capacity, colonists.capableCount, colonists.duplicate, colonists.status], [['capable', 'incompatible'], yearOf(0, 0, 50, 4), 1, false, 'capable'], 'a fleet of holds on a colonist route adds nothing and is no duplicate')
  assert.deepEqual([group(loop(4, 6), { 1: cargo, 2: cargo }).status, group(loop(4, 6), { 1: cargo, 2: cargo }).capacity], ['incapable', null], 'no fleet of berths on a colonist route')

  const freight = group(MINERALS(), { 1: cargo, 2: berths })

  assert.deepEqual([freight.members.map((member) => member.state), freight.duplicate], [['capable', 'incompatible'], false], 'a fleet of berths on a freight route adds nothing')
  assert.deepEqual([group(loop(165, 165), { 1: cargo, 2: cargo }).status, group(loop(165, 165), { 1: cargo, 2: cargo }).duplicate], ['capable', true], 'a reserve balance is carried by a fleet that moves freight')

  const wanted = { id: 'd', name: 'Wanted', cargo: 'colonists', from: 101, to: 102, yearly: null, stale: false }
  const refused = m.sig.coverDesires([wanted], m.sig.coverGroups(m.sig.groupRoutes([recordOf(m, 1, loop(4, 6))]), { 1: cargo }), {})[0]

  assert.deepEqual([refused.state, refused.capacity], ['uncovered', null], 'a desired colonist route is not covered by a fleet of holds')

  const mixed = [stop(1, 223), stop(1, 4), jump(1, 2), stop(2, 63), stop(2, 6), jump(2, 1)]
  const both = figure({ year: yearOf(100, 0, 50, 4) })
  const unloaded = (kind) => ({ PopulationID: 102, kind, amount: 10, sources: [{ from: 101, amount: 10 }] })
  const askedFor = (figures) => m.sig.coverDesires([wanted, { ...wanted, id: 'm', cargo: 'minerals' }], m.sig.coverGroups(m.sig.groupRoutes([recordOf(m, 1, mixed)]), figures), { 1: [unloaded('colonists'), unloaded('minerals')] }).map((desire) => [desire.cargo, desire.state])

  assert.deepEqual(askedFor({ 1: cargo }), [['colonists', 'uncovered'], ['minerals', 'covered']], 'a fleet of holds on a route of freight and colonists covers the freight and not the colonists')
  assert.deepEqual(askedFor({ 1: berths }), [['colonists', 'covered'], ['minerals', 'uncovered']], 'a fleet of berths on the same route covers the colonists and not the freight')
  assert.deepEqual(askedFor({ 1: both }), [['colonists', 'covered'], ['minerals', 'covered']], 'a fleet that moves both covers both')
})

add('cargo-sources', 'what a stop unloads is credited to the stops it was loaded at', ({ m }) => {
  const fleet = { CargoCapacity: 1000, ColonistCapacity: 0 }
  const order = (action, population, extra = {}) => ({ MoveActionID: action, PopulationID: population, PopName: `Colony ${population}`, MaxItems: 0, ...extra })
  const deliveries = (orders) => m.hauling.cycleCargo(orders, fleet).deliveries.map(({ PopulationID, kind, amount, sources }) => ({ PopulationID, kind, amount, sources }))
  const common = [{ PopulationID: 103, kind: 'minerals', amount: 100, sources: [{ from: 101, amount: 10 }, { from: 102, amount: 90 }] }]
  const loads = [order(178, 101, { MaxItems: 10 }), order(178, 102, { MaxItems: 90 })]

  assert.deepEqual(deliveries([...loads, order(63, 103)]), common, 'two stops load for one unload')
  assert.deepEqual(deliveries([order(63, 103), ...loads]), common, 'the same, with the unload first: what is held when the cycle begins')
  assert.equal(m.hauling.cycleCargo([...loads, order(63, 103)], fleet).perTrip.minerals, 100, 'the cargo of the trip is the same')
  assert.deepEqual(deliveries([order(223, 101), order(63, 102), order(223, 102), order(63, 101)]), [{ PopulationID: 102, kind: 'minerals', amount: 500, sources: [{ from: 101, amount: 500 }] }, { PopulationID: 101, kind: 'minerals', amount: 500, sources: [{ from: 102, amount: 500 }] }], 'a hold taken each way is credited to the stop it came from')
  assert.deepEqual(deliveries([order(178, 101, { MaxItems: 100, DestinationItemID: 1 }), order(178, 102, { MaxItems: 100, DestinationItemID: 1 }), order(179, 103, { MaxItems: 100, DestinationItemID: 1 }), order(63, 104)]), [{ PopulationID: 103, kind: 'minerals', amount: 100, sources: [{ from: 101, amount: 50 }, { from: 102, amount: 50 }] }, { PopulationID: 104, kind: 'minerals', amount: 100, sources: [{ from: 101, amount: 50 }, { from: 102, amount: 50 }] }], 'a limited unload of one mineral takes each source of that mineral in proportion')
  assert.deepEqual(deliveries([order(178, 101, { MaxItems: 10, DestinationItemID: 1 }), order(178, 102, { MaxItems: 90, DestinationItemID: 2 }), order(179, 103, { MaxItems: 10, DestinationItemID: 1 }), order(63, 104)]), [{ PopulationID: 103, kind: 'minerals', amount: 10, sources: [{ from: 101, amount: 10 }] }, { PopulationID: 104, kind: 'minerals', amount: 90, sources: [{ from: 102, amount: 90 }] }], 'an unload of one mineral takes what was loaded as that mineral, and the rest goes to the unload of all')

  const typed = (quantity) => [order(178, 101, { MaxItems: 10, DestinationItemID: 1 }), order(178, 102, { MaxItems: 90, DestinationItemID: 2 }), order(179, 103, { MaxItems: quantity, DestinationItemID: 1 }), order(63, 104)]
  const above = m.hauling.cycleCargo(typed(100), fleet)
  const below = m.hauling.cycleCargo(typed(4), fleet)

  assert.deepEqual([above.deliveries.map(({ PopulationID, amount, sources }) => [PopulationID, amount, sources]), above.perTrip.minerals], [[[103, 10, [{ from: 101, amount: 10 }]], [104, 90, [{ from: 102, amount: 90 }]]], 100], 'a quantity above what is held of the mineral takes what is held of it, and the rest goes to the unload of all')
  assert.deepEqual([below.deliveries.map(({ PopulationID, amount, sources }) => [PopulationID, amount, sources]), below.perTrip.minerals], [[[103, 4, [{ from: 101, amount: 4 }]], [104, 96, [{ from: 101, amount: 6 }, { from: 102, amount: 90 }]]], 100], 'a quantity below what is held takes that, and the rest is delivered to the unload of all')
  assert.deepEqual([above.settled, below.settled], [true, true], 'a hold that is loaded and unloaded whole or by quantity settles')

  // A hold of 1,000 t that is refilled by one tonne a cycle from each of two colonies mixes its colonies far more slowly than its totals settle: the mix of the last pass is not the mix of the steady state.
  const slow = m.hauling.cycleCargo([order(178, 101, { DestinationItemID: 1 }), order(179, 103, { MaxItems: 1, DestinationItemID: 1 }), order(178, 102, { MaxItems: 1, DestinationItemID: 1 }), order(179, 104, { MaxItems: 1, DestinationItemID: 1 })], { CargoCapacity: 2000, ColonistCapacity: 0 })

  assert.deepEqual([slow.settled, slow.perTrip, slow.deliveries, slow.moves.every((move) => move === null), slow.holdShare], [false, { minerals: 0, installations: 0, colonists: 0 }, [], true, 0], 'a cycle whose mix of colonies has not settled publishes no move, no tonnes and no delivery: the last pass is not what the fleet carries')

  // A hold that takes one tonne of a mineral no order unloads each cycle and is filled up with another mineral that is: the first mineral takes the hold over, a tonne a pass, so what the cycle carries is still falling when the passes end.
  const accumulating = m.hauling.cycleCargo([order(178, 101, { MaxItems: 1, DestinationItemID: 1 }), order(178, 102, { DestinationItemID: 2 }), order(179, 103, { DestinationItemID: 2 })], { CargoCapacity: 2000, ColonistCapacity: 0 })
  const yearOfCargo = (cargo) => m.hauling.routeYear({ Speed: 10, FuelPerHour: 1 }, { km: 100 }, cargo, { blocked: [], unknown: [], seconds: 3600 })

  assert.equal(accumulating.settled, false, 'a hold that fills with cargo no order unloads has not settled in the passes')
  assert.deepEqual([accumulating, slow].map(yearOfCargo), [null, null], 'a cycle that has not settled has no year, so no capacity and no service')
  assert.equal(yearOfCargo(above).minerals, yearOfCargo(above).trips * 100, 'a cycle that settles has the year of what it carries a trip')
})

add('groups', 'two identical observed cycles group once with both fleets and their capacity is summed once; the status and the flags follow the capable fleets', ({ m }) => {
  const first = recordOf(m, 1, MINERALS())
  const second = recordOf(m, 2, MINERALS(), { rotate: 2 })
  const groups = m.sig.groupRoutes([first, second])

  assert.equal(groups.length, 1, 'two identical cycles are one group')
  assert.deepEqual(groups[0].fleets.map((record) => record.FleetID), [1, 2], 'both fleets are in it')

  const covered = m.sig.coverGroups(groups, { 1: figure({ year: yearOf(100, 20, 5, 3) }), 2: figure({ year: yearOf(60, 0, 0, 2) }) })[0]

  assert.deepEqual(covered.capacity, yearOf(160, 20, 5, 5), 'the capacity is the two fleets\' yearly moves, once')
  assert.deepEqual([covered.members.length, covered.capableCount, covered.duplicate, covered.status], [2, 2, true, 'capable'], 'members, capable fleets, duplicate and status')

  const listedTwice = m.sig.coverGroups([{ ...groups[0], fleets: [first, first, second] }], { 1: figure({ year: yearOf(100, 20, 5, 3) }), 2: figure({ year: yearOf(60, 0, 0, 2) }) })[0]

  assert.deepEqual([listedTwice.members.length, listedTwice.capacity], [2, yearOf(160, 20, 5, 5)], 'a fleet that two reads name counts once')

  const mixed = m.sig.coverGroups(groups, { 1: figure({ year: yearOf(100, 0, 0, 3) }), 2: figure({ holds: false }) })[0]

  assert.deepEqual([mixed.capacity, mixed.capableCount, mixed.duplicate, mixed.status, mixed.members.map((member) => member.state)], [yearOf(100, 0, 0, 3), 1, false, 'capable', ['capable', 'incompatible']], 'a fleet that cannot carry adds nothing and is named')
  assert.deepEqual(mixed.members.map((member) => member.year), [yearOf(100, 0, 0, 3), null], 'a fleet that cannot carry has no yearly moves of its own')

  const none = m.sig.coverGroups(groups, { 1: figure({ holds: false }), 2: figure({ ships: 0 }) })[0]

  assert.deepEqual([none.capacity, none.status, none.duplicate], [null, 'incapable', false], 'no capable fleet')

  const unknown = m.sig.coverGroups(groups, { 1: figure({ profile: 'unknown' }), 2: figure({ holds: false }) })[0]

  assert.deepEqual([unknown.capacity, unknown.status], [null, 'unknown'], 'a fleet that cannot be told leaves the group not known')

  const pacings = m.sig.coverGroups(m.sig.groupRoutes([first, recordOf(m, 3, MINERALS().map((part, index) => (index === 1 ? { ...part, OrderDelay: 60 } : part)))]), { 1: figure(), 3: figure() })[0]

  assert.deepEqual([pacings.pacing, pacings.duplicate], [true, true], 'capable fleets at two pacings')
})

add('status', 'a fleet waiting at a stock holds its route as paused, one waiting on a timer does not, and the wait is told apart', ({ m }) => {
  const atStock = (id) => recordOf(m, id, MINERALS(), { head: { MoveActionID: 223, Arrived: 1 } })
  const onTimer = (id) => recordOf(m, id, MINERALS(), { head: { OrderDelayRemaining: 500 } })
  const run = (records, figures) => m.sig.coverGroups(m.sig.groupRoutes(records), figures)[0]
  const both = { 1: figure(), 2: figure() }

  assert.deepEqual([atStock(1).waiting, onTimer(1).waiting, recordOf(m, 1, MINERALS()).waiting], ['stock', 'timer', null], 'the wait of the head order')
  assert.deepEqual([recordOf(m, 1, MINERALS(), { head: { MoveActionID: 63, Arrived: 1 } }).waiting, recordOf(m, 1, MINERALS(), { head: { MoveActionID: 223, Arrived: 0 } }).waiting], [null, null], 'an arrival at another action, and a stock wait not yet reached, are no wait')
  assert.equal(recordOf(m, 1, MINERALS(), { head: { MoveActionID: 223, Arrived: 1, OrderDelayRemaining: 5 } }).waiting, 'timer', 'a delay still to run comes before the stock wait')

  const paused = run([atStock(1), atStock(2)], both)

  assert.deepEqual([paused.status, paused.waiting, paused.members.map((member) => [member.active, member.paused])], ['paused', 2, [[false, true], [false, true]]], 'every capable fleet at a stock')

  const mixed = run([atStock(1), recordOf(m, 2, MINERALS())], both)

  assert.deepEqual([mixed.status, mixed.waiting], ['capable', 1], 'one fleet moving keeps the route served')
  assert.deepEqual([run([onTimer(1)], { 1: figure() }).status, run([onTimer(1)], { 1: figure() }).waiting], ['capable', 1], 'a timer is not a pause')
  assert.equal(run([atStock(1)], { 1: figure({ holds: false }) }).status, 'incapable', 'a fleet that cannot carry is not paused but incapable')
})

add('flags', 'a group is flagged for each of: duplicated service, another pacing, a wait at a stock, a wait on a timer, unfit fleets and conditional orders', ({ m }) => {
  const stock = { MoveActionID: 223, Arrived: 1 }
  const timer = { OrderDelayRemaining: 500 }
  const flagsOf = (records, figures) => m.sig.flagsOf(m.sig.coverGroups(m.sig.groupRoutes(records), figures)[0])
  const keysOf = (records, figures) => flagsOf(records, figures).map((flag) => flag.key)
  const same = (id, extra) => recordOf(m, id, MINERALS(), extra)
  const slow = (id, extra) => recordOf(m, id, MINERALS().map((part, index) => (index === 1 ? { ...part, OrderDelay: 3600 } : part)), extra)

  assert.deepEqual(keysOf([same(1)], { 1: figure() }), [], 'one capable fleet with nothing to note')
  assert.deepEqual(keysOf([same(1), same(2)], { 1: figure(), 2: figure() }), ['duplicate'], 'two capable fleets')
  assert.deepEqual(keysOf([same(1), slow(2)], { 1: figure(), 2: figure() }), ['duplicate', 'pacing'], 'two capable fleets at another pacing')
  assert.deepEqual(keysOf([same(1, { head: stock })], { 1: figure() }), ['stalled'], 'a fleet waiting at a stock')
  assert.deepEqual(keysOf([same(1, { head: timer })], { 1: figure() }), ['timer'], 'a fleet waiting on a timer')
  assert.deepEqual(keysOf([same(1, { head: stock }), same(2, { head: timer })], { 1: figure(), 2: figure() }), ['duplicate', 'stalled', 'timer'], 'a stock wait and a timer are told apart')
  assert.deepEqual(keysOf([same(1, { conditionals: [CONDITION] })], { 1: figure() }), ['conditional'], 'a fleet with a conditional order')
  assert.deepEqual(keysOf([same(1), same(2)], { 1: figure(), 2: figure({ ships: 0 }) }), ['unfit'], 'a fleet with no ship')

  const unfit = flagsOf([same(1), same(2), same(3), same(4)], { 1: figure(), 2: figure({ ships: 0 }), 3: figure({ holds: false }), 4: figure({ moving: false }) }).find((flag) => flag.key === 'unfit')

  assert.equal(unfit.text, `3 ${m.raw.FLAGS.unfit}`, 'the unfit fleets are counted: empty, incompatible and immobile')
  assert.deepEqual(keysOf([same(1), same(2)], { 1: figure(), 2: figure({ profile: 'unknown' }) }), [], 'a fleet that cannot be told is not unfit')

  const conditional = { conditionals: [CONDITION] }
  const all = flagsOf([same(1, { head: stock, ...conditional }), slow(2, conditional), same(3, { head: timer, ...conditional }), same(4, conditional)], { 1: figure(), 2: figure(), 3: figure(), 4: figure({ ships: 0 }) })

  assert.deepEqual(all.map((flag) => flag.key), ['duplicate', 'pacing', 'stalled', 'timer', 'unfit', 'conditional'], 'every flag, in the order of the words')
  assert.deepEqual(all.map((flag) => flag.warning), [true, false, true, false, true, false], 'the flags that call for a look')
  assert.deepEqual(all.map((flag) => flag.text), [m.raw.FLAGS.duplicate, m.raw.FLAGS.pacing, m.raw.FLAGS.stalled, m.raw.FLAGS.timer, `1 ${m.raw.FLAGS.unfit}`, m.raw.FLAGS.conditional], 'the words of each')
})

add('freight-reader', 'the freight text of the table is read whole, as tonnes with the error of its rounding, or the check fails', () => {
  const rejected = (text) => {
    try {
      tonnesOf(text)
    } catch (error) {
      return true
    }

    return false
  }

  assert.deepEqual(tonnesOf('7 t minerals'), { tonnes: 7, error: 0.5 }, 'tonnes without a suffix')
  assert.deepEqual(tonnesOf('1.2 M t minerals, 40 k t installations'), { tonnes: 1.24e6, error: 5050 }, 'a list of two with suffixes')
  assert.deepEqual(['-5 t minerals', 'x5 t minerals', '5 G t minerals', '5 t ore', '7 t minerals, ', '7 t minerals and 8 t minerals', '7 t minerals, junk', '', '5 t minerals 3'].map(rejected), [true, true, true, true, true, true, true, true, true], 'a text that is not a list of figures of tonnes')
})

add('page-cleanup', 'the page pool closes every part whatever another part does, and a part that did not close fails the teardown by name instead of being logged and forgotten. It checks the harness\'s own closer, not the code under test, so no planted fault applies', async () => {
  const closed = []
  const failing = [['the server', () => { closed.push('server'); throw new Error('port busy') }], ['the browser', () => { closed.push('browser'); return Promise.reject(new Error('crashed')) }], ['the folder', () => { closed.push('folder') }]]
  const failure = await closeAll(failing).then(() => null, (error) => error)

  assert.deepEqual(closed, ['server', 'browser', 'folder'], 'every part is closed, the ones after a failure too')
  assert.ok(failure !== null, 'a part that did not close fails the teardown')
  assert.equal(failure.name, 'HarnessError', 'the failure is the one the runner tells as a failure of the run')
  assert.ok(failure.message.includes('the server') && failure.message.includes('port busy') && failure.message.includes('the browser') && failure.message.includes('crashed'), 'each part that failed is named with its error')
  assert.equal(await closeAll([['the folder', () => {}]]).then(() => 'closed', () => 'failed'), 'closed', 'a pool whose parts all close leaves no failure')
})

add('desires', 'a desired route with no capable active fleet is uncovered, which is not unknown; a stale link reads unknown; and the record is the player\'s own', ({ m }) => {
  const observed = (records, figures) => m.sig.coverGroups(m.sig.groupRoutes(records), figures).map((group) => ({ ...group, name: m.sig.routeName(group, {}) }))
  const desire = (extra = {}) => ({ id: 'd', name: 'Wanted', cargo: 'minerals', from: 101, to: 102, yearly: 500, stale: false, ...extra })
  const deliveries = { 1: [{ PopulationID: 102, kind: 'minerals', amount: 40, sources: [{ from: 101, amount: 40 }] }, { PopulationID: 999, kind: 'minerals', amount: 7, sources: [{ from: 101, amount: 7 }] }, { PopulationID: 102, kind: 'installations', amount: 9, sources: [{ from: 101, amount: 9 }] }], 2: [{ PopulationID: 102, kind: 'minerals', amount: 25, sources: [{ from: 101, amount: 25 }] }] }
  const first = recordOf(m, 1, MINERALS())
  const second = recordOf(m, 2, MINERALS(), { rotate: 1 })
  const served = observed([first, second], { 1: figure({ year: yearOf(100, 0, 0, 3) }), 2: figure({ year: yearOf(60, 0, 0, 2) }) })
  const result = (desires, groups = served, given = deliveries) => m.sig.coverDesires(desires, groups, given)
  const [covered] = result([desire()])

  assert.deepEqual([covered.state, covered.fleets, covered.capacity, covered.gap], ['covered', [1, 2], 3 * 40 + 2 * 25, 500 - 170], 'a route a capable fleet runs: the unloads at its second colony, each fleet\'s trips over them')
  assert.deepEqual(covered.groups, [served[0].id], 'the group that covers it')
  assert.equal(result([desire({ yearly: 100 })])[0].gap, 0, 'a demand below the capacity has no gap')
  assert.equal(result([desire({ yearly: null })])[0].gap, null, 'no demand, no gap')

  const uncovered = result([desire({ cargo: 'colonists' }), desire({ from: 102, to: 101 }), desire({ to: 103 })])

  assert.deepEqual(uncovered.map((entry) => [entry.state, entry.capacity, entry.fleets, entry.groups]), [['uncovered', null, [], []], ['uncovered', null, [], []], ['uncovered', null, [], []]], 'another cargo, the other direction, another colony: no observed cycle carries it')

  const incompatible = observed([first], { 1: figure({ holds: false }) })
  const refused = result([desire()], incompatible)[0]
  const never = result([desire({ to: 103 })], incompatible)[0]

  assert.deepEqual([refused.state, refused.capacity], ['uncovered', null], 'a cycle whose fleets cannot carry leaves the route uncovered')
  assert.notEqual(refused.reason, never.reason, 'the reason that no cycle carries it is not the reason that the fleets cannot')
  assert.ok(refused.reason.length > 0 && never.reason.length > 0, 'both say why')

  const cannotTell = result([desire()], observed([first], { 1: figure({ profile: 'unknown' }) }))[0]

  assert.deepEqual([cannotTell.state, cannotTell.capacity], ['unknown', null], 'an observed cycle that cannot be told is unknown, never uncovered')
  assert.notEqual(cannotTell.state, refused.state, 'unknown is not uncovered')
  assert.equal(result([desire()], observed([recordOf(m, 1, MINERALS(), { head: { MoveActionID: 223, Arrived: 1 } })], { 1: figure() }))[0].state, 'paused', 'a fleet held at a stock')

  const stale = result([desire({ stale: true })])[0]

  assert.deepEqual([stale.state, stale.fleets, stale.capacity], ['unknown', [], null], 'a colony that is no longer the one linked reads unknown')
  assert.equal(result([]).length, 0, 'no desired route, no row')

  // Several colonies deliver to one: each is credited with its own share of the unload.
  const sink = observed([recordOf(m, 1, [stop(1, 223), jump(1, 3), stop(3, 62), jump(3, 2), stop(2, 63), jump(2, 1)])], { 1: figure({ year: yearOf(100, 0, 0, 3) }) })
  const shared = { 1: [{ PopulationID: 102, kind: 'minerals', amount: 100, sources: [{ from: 101, amount: 10 }, { from: 103, amount: 90 }] }] }

  assert.deepEqual([101, 103].map((from) => result([desire({ from })], sink, shared)[0].capacity), [3 * 10, 3 * 90], 'each colony that loads for a common unload is credited with its own part of it')

  // A fleet on a cycle that could carry the cargo covers the desire only when its unloads at the second colony take cargo from the first.
  const unload = (to, from, sources = [{ from, amount: 40 }]) => ({ PopulationID: to, kind: 'minerals', amount: 40, sources })
  const answer = (given) => result([desire()], served, given)[0]
  const elsewhere = answer({ 1: [unload(999, 101)], 2: [unload(999, 101)] })
  const otherSource = answer({ 1: [unload(102, 103)], 2: [unload(102, 103)] })
  const mixedUp = answer({ 1: [unload(102, 101, null)], 2: [unload(102, 101)] })
  const untold = answer({ 1: [unload(102, 101, null)], 2: [unload(102, 101, null)] })
  const notGiven = answer({})

  assert.deepEqual([elsewhere, otherSource].map((entry) => [entry.state, entry.fleets, entry.capacity]), [['uncovered', [], null], ['uncovered', [], null]], 'fleets that unload the cargo at no such colony, or take none of it from the first, do not cover')
  assert.notEqual(elsewhere.reason, never.reason, 'the reason that the fleets do not deliver it is not the reason that no cycle carries it')
  assert.notEqual(elsewhere.reason, refused.reason, 'the reason that the fleets deliver none of it is not the reason that they cannot carry')
  assert.deepEqual([mixedUp.state, mixedUp.fleets, mixedUp.capacity], ['covered', [2], 2 * 40], 'a fleet whose sources are not known does not cover, and does not hide the one that does')
  assert.deepEqual([untold, notGiven].map((entry) => [entry.state, entry.fleets, entry.capacity]), [['unknown', [], null], ['unknown', [], null]], 'fleets whose unloads are not attributed, or not given, leave the route unknown, never uncovered or covered')

  // The shortfall of a demand of 500 a year is what is known: the whole demand where no service is known, unknown where a fleet that is not known could meet it, none where what is known meets it.
  const small = result([desire({ yearly: 60 })], served, { 1: [unload(102, 101, null)], 2: [unload(102, 101)] })[0]

  assert.deepEqual([elsewhere.gap, otherSource.gap, cannotTell.gap, untold.gap, notGiven.gap, mixedUp.gap, small.gap], [500, 500, null, null, null, null, 0], 'a shortfall is the whole demand for a route no fleet serves, unknown where a fleet that cannot be told could serve it, and none where the fleets that are known meet the demand')
  assert.deepEqual(Object.keys(m.raw.COVERAGE).sort(), ['covered', 'paused', 'uncovered', 'unknown'], 'the coverages that are named')
})

add('undetermined', 'a fleet whose conditional orders have an outcome the save does not settle is named and left out of the capacity, and a group or desired route with no other fleet is not known to be served', ({ m }) => {
  const trueNow = { conditionals: [CONDITION], ships: [ship(20)] }
  const armed = { conditionals: [CONDITION], ships: [ship(90)] }
  const unread = { conditionals: [CONDITION, { ...CONDITION, ConditionID: 77, Priority: 2 }], ships: [ship(90)] }
  const ignores = { conditionals: [CONDITION], ships: [ship(20)], ignored: true }
  const run = (records, figures) => m.sig.coverGroups(m.sig.groupRoutes(records), figures)[0]
  const a = yearOf(100, 0, 0, 3)
  const b = yearOf(60, 0, 0, 2)
  const sum = yearOf(160, 0, 0, 5)
  const read = (group) => [group.status, group.capacity, group.potential, group.capableCount, group.members.map((member) => [member.undetermined, member.active, member.paused])]

  assert.deepEqual([trueNow, armed, unread, ignores].map((extra) => recordOf(m, 1, MINERALS(), extra).conditional.status), ['true-now', 'armed', 'unresolvable', 'ignored'], 'the outcomes of the conditional orders of the fixtures')
  assert.deepEqual(read(run([recordOf(m, 1, MINERALS(), trueNow)], { 1: figure({ year: a }) })), ['conditional', null, a, 1, [[true, false, false]]], 'a fleet with a condition true now: the route is not known to be served, and the capacity is none')
  assert.deepEqual(read(run([recordOf(m, 1, MINERALS(), unread)], { 1: figure({ year: a }) })), ['conditional', null, a, 1, [[true, false, false]]], 'a fleet with a condition that cannot be read, the same')
  assert.deepEqual(read(run([recordOf(m, 1, MINERALS(), armed)], { 1: figure({ year: a }) })), ['capable', a, a, 1, [[false, true, false]]], 'a fleet whose conditions are all false serves the route')
  assert.deepEqual(read(run([recordOf(m, 1, MINERALS(), ignores)], { 1: figure({ year: a }) })), ['capable', a, a, 1, [[false, true, false]]], 'a fleet that ignores its conditional orders serves the route')
  assert.deepEqual(read(run([recordOf(m, 1, MINERALS(), trueNow)], { 1: figure({ holds: false }) })), ['incapable', null, null, 0, [[false, false, false]]], 'a fleet that cannot carry is incapable before it is undetermined')

  const mixed = m.sig.groupRoutes([recordOf(m, 1, MINERALS(), armed), recordOf(m, 2, MINERALS(), trueNow)])

  assert.equal(mixed.length, 1, 'two fleets with the same conditional orders are one group, whatever their outcome')

  const together = m.sig.coverGroups(mixed, { 1: figure({ year: a }), 2: figure({ year: b }) })[0]

  assert.deepEqual(read(together), ['capable', a, sum, 2, [[false, true, false], [true, false, false]]], 'the capacity counts the fleet whose outcome is settled; what the other would move is kept apart')
  assert.equal(together.duplicate, true, 'both fleets are capable of the route, which the duplicate flag says')
  assert.deepEqual(m.sig.flagsOf(together).map((flag) => flag.key), ['duplicate', 'conditional'], 'the flags of a group with an undetermined fleet')

  const stocked = m.sig.coverGroups(m.sig.groupRoutes([recordOf(m, 1, MINERALS(), { ...armed, head: { MoveActionID: 223, Arrived: 1 } }), recordOf(m, 2, MINERALS(), trueNow)]), { 1: figure({ year: a }), 2: figure({ year: b }) })[0]

  assert.deepEqual([stocked.status, stocked.capacity], ['paused', a], 'a fleet at a stock and one that is not known: paused, and the capacity of the settled one')

  const bothOpen = run([recordOf(m, 1, MINERALS(), trueNow), recordOf(m, 2, MINERALS(), { ...trueNow, rotate: 1 })], { 1: figure({ year: a }), 2: figure({ year: b }) })

  assert.deepEqual([bothOpen.status, bothOpen.capacity, bothOpen.potential], ['conditional', null, sum], 'every fleet undetermined')

  const unavailable = (group) => m.sig.capacityResult(group).status === 'unavailable'

  assert.deepEqual([unavailable(bothOpen), unavailable(together), unavailable(run([recordOf(m, 1, MINERALS(), armed)], { 1: figure({ year: a }) }))], [true, false, false], 'a group of undetermined fleets has no capacity result; one with a settled fleet has')
  assert.deepEqual([m.sig.capacityResult(bothOpen).inputs.missing.length, m.sig.capacityResult(together).inputs.missing.length, m.sig.capacityResult(run([recordOf(m, 1, MINERALS(), armed)], { 1: figure({ year: a }) })).inputs.missing.length], [1, 1, 0], 'what a capacity result lacks: the outcome, in both groups that have an undetermined fleet')
  assert.deepEqual(Object.keys(m.raw.CAPACITY_NOTES), ['undetermined'], 'the note that names the fleets left out of a capacity')
  assert.ok(Object.values(m.raw.CAPACITY_NOTES).every((text) => text.length > 0), 'and says it')

  // The desired routes: an undetermined fleet is not service, and it keeps the route from being uncovered or short.
  const unload = (to, from, amount = 40) => ({ PopulationID: to, kind: 'minerals', amount, sources: [{ from, amount }] })
  const desire = (extra = {}) => ({ id: 'd', name: 'Wanted', cargo: 'minerals', from: 101, to: 102, yearly: 500, stale: false, ...extra })
  const observed = (records, figures) => m.sig.coverGroups(m.sig.groupRoutes(records), figures).map((group) => ({ ...group, name: m.sig.routeName(group, {}) }))
  const deliveries = { 1: [unload(102, 101, 40)], 2: [unload(102, 101, 25)] }
  const answer = (records, given = deliveries, extra = {}) => m.sig.coverDesires([desire(extra)], observed(records, { 1: figure({ year: a }), 2: figure({ year: b }) }), given)[0]
  const only = answer([recordOf(m, 1, MINERALS(), trueNow), recordOf(m, 2, MINERALS(), unread)])

  assert.deepEqual([only.state, only.fleets, only.capacity, only.gap], ['unknown', [], null, null], 'a route whose only fleets have conditions of no known outcome is not known, not uncovered, and its shortfall is not told')
  assert.notEqual(only.reason, '', 'and says why')
  assert.deepEqual([answer([recordOf(m, 1, MINERALS(), trueNow), recordOf(m, 2, MINERALS(), unread)], deliveries, { yearly: null })].map((entry) => [entry.state, entry.gap]), [['unknown', null]], 'with no demand, no gap either')

  const settled = answer([recordOf(m, 1, MINERALS(), armed), recordOf(m, 2, MINERALS(), trueNow)])

  assert.deepEqual([settled.state, settled.fleets, settled.capacity, settled.gap], ['covered', [1], 3 * 40, null], 'a settled fleet covers the route, its capacity leaves the other out, and the shortfall is not told while the other could close it')
  assert.equal(answer([recordOf(m, 1, MINERALS(), armed), recordOf(m, 2, MINERALS(), trueNow)], deliveries, { yearly: 100 }).gap, 0, 'a demand the settled fleet meets has no shortfall')

  const elsewhere = answer([recordOf(m, 1, MINERALS(), armed), recordOf(m, 2, MINERALS(), trueNow)], { 1: [unload(102, 101, 40)], 2: [unload(999, 101, 25)] })

  assert.deepEqual([elsewhere.state, elsewhere.capacity, elsewhere.gap], ['covered', 3 * 40, 500 - 3 * 40], 'an undetermined fleet that takes none of the cargo to the colony cannot close the shortfall, which is told')

  const none = answer([recordOf(m, 1, MINERALS(), trueNow), recordOf(m, 2, MINERALS(), trueNow)], { 1: [unload(999, 101)], 2: [unload(999, 101)] })

  assert.deepEqual([none.state, none.gap], ['uncovered', 500], 'undetermined fleets that deliver none of it leave the route uncovered')
})

add('cycle-stops', 'the stops of a cycle are its places in the order of the queue: a place visited twice is two stops, and only a repeat of the one before and the return to the first are dropped', ({ m }) => {
  assert.deepEqual(m.sig.cycleStopsOf(['a', 'b', 'a', 'c']), ['a', 'b', 'a', 'c'], 'a place that comes twice stays twice')
  assert.deepEqual(m.sig.cycleStopsOf(['a', 'b', 'b', 'c', 'a']), ['a', 'b', 'c'], 'a repeat of the stop before is one stop, and the return to the first is not another')
  assert.deepEqual(m.sig.cycleStopsOf(['a', null, 'b', undefined, '', 'a']), ['a', 'b'], 'a stop with no place is no stop')
  assert.deepEqual([m.sig.cycleStopsOf([]), m.sig.cycleStopsOf(['a']), m.sig.cycleStopsOf(['a', 'a'])], [[], ['a'], ['a']], 'no stop, one stop, one place twice in a row')

  const revisit = recordOf(m, 1, [stop(1, 223), jump(1, 2), stop(2, 63), jump(2, 1), stop(1, 223), jump(1, 3), stop(3, 63), jump(3, 1)])

  assert.equal(revisit.stops.length, 4, 'a queue that visits the first place again on the way round has four stops')
  assert.equal(revisit.stops[0], revisit.stops[2], 'the first place comes again as the third stop')
  assert.deepEqual(m.sig.groupRoutes([revisit])[0].stops, revisit.stops, 'the group has the stops of its fleet')
})

add('links', 'every group, and every fleet of it, names the stored orders it was inferred from, in the order they are stored', ({ m }) => {
  const first = recordOf(m, 1, MINERALS())
  const second = recordOf(m, 2, MINERALS(), { rotate: 3 })
  const [group] = m.sig.groupRoutes([first, second])

  assert.deepEqual(first.orders, storedOf(1, MINERALS()).map((row) => ({ MoveOrderID: row.MoveOrderID, MoveOrder: row.MoveOrder })), 'the orders of a fleet')
  assert.deepEqual(second.orders, storedOf(2, MINERALS(), { rotate: 3 }).map((row) => ({ MoveOrderID: row.MoveOrderID, MoveOrder: row.MoveOrder })), 'the orders of a fleet saved at a rotation, as they are stored')
  assert.deepEqual(group.links.map((link) => [link.FleetID, link.orders.map((order) => order.MoveOrderID)]), [[1, [100, 101, 102, 103]], [2, [200, 201, 202, 203]]], 'the links of the group')

  // The queue of the fleet is read out of the order the rows come in.
  const shuffled = m.sig.describeFleet({ FleetID: 3, FleetName: 'F3', CycleMoves: 1, IgnoreConditional: 0 }, storedOf(3, MINERALS()).reverse(), { actions: ACTIONS, raceId: RACE })

  assert.deepEqual(shuffled.orders.map((order) => order.MoveOrder), [1, 2, 3, 4], 'the orders are in their order whatever order the rows come in')
  assert.equal(shuffled.route.key, first.route.key, 'and the route is the same')
})

const QUEUES = (extra = {}) => {
  const fleets = []
  const orders = []
  const conditionals = []
  const put = (id, parts, options = {}) => {
    fleets.push({ FleetID: id, FleetName: options.name || `Fleet ${id}`, CycleMoves: options.cycle === undefined ? 1 : options.cycle, Speed: 1000, IgnoreConditional: 0, IgnoreStanding: 0 })
    orders.push(...storedOf(id, parts, options))
  }

  put(1, MINERALS(), { name: 'Alpha' })
  put(2, MINERALS(), { name: 'Beta', rotate: 2 })
  put(3, loop(223, 63, { from: 2, to: 1 }), { name: 'Gamma' })
  put(4, MINERALS(), { name: 'Closed', cycle: 0 })
  put(5, [...MINERALS(), ...MINERALS()], { name: 'Twice', cycle: 0 })
  put(6, [], { name: 'Empty' })
  put(7, [stop(1, 223)], { name: 'One' })
  put(8, loop(4, 6, { from: 3, to: 2 }), { name: 'Hub' })
  put(9, MINERALS(), { name: 'Conditional' })
  conditionals.push({ FleetID: 9, ...CONDITION })

  return { supported: true, reason: '', fleets, orders, actions: ACTIONS, conditionals, standing: { 1: 2 }, templates: [], ...extra }
}

add('audit', 'the audit puts the groups, the queues that do not repeat and the ones that are broken apart, sums a group once and lists only the relations that say something', ({ m }) => {
  const rows = { 1: { profile: { status: 'ok' }, route: { km: 5 }, blocked: [], unknown: [], year: yearOf(100, 0, 0, 3), Speed: 10, cargo: { deliveries: [] } }, 2: { profile: { status: 'ok' }, route: { km: 5 }, blocked: [], unknown: [], year: yearOf(60, 0, 0, 2), Speed: 10, cargo: { deliveries: [] } }, 3: { profile: { status: 'ok' }, route: { km: 5 }, blocked: [], unknown: [], year: yearOf(10, 0, 0, 1), Speed: 10, cargo: { deliveries: [] } } }
  const hold = [{ CargoCapacity: 10, ColonistCapacity: 0 }]
  const audit = m.audit.auditOf({ queues: QUEUES(), raceId: RACE, ships: { 1: hold, 2: hold, 3: hold, 8: hold, 9: hold }, rows, colonyNames: { 'colony:101': 'Alpha', 'colony:102': 'Beta' } })
  const byFleet = Object.fromEntries(audit.groups.flatMap((group) => group.fleets.map((record) => [record.FleetID, group])))

  assert.equal(audit.supported, true, 'a save of 2.6 or later is supported')
  assert.deepEqual(audit.groups.map((group) => group.fleets.map((record) => record.FleetID)).sort((a, b) => a[0] - b[0]), [[1, 2], [3], [8], [9]], 'the groups: the two identical cycles once, the reversed flow, the hub, the conditional route alone')
  assert.equal(byFleet[1], byFleet[2], 'the two fleets are in one group')
  assert.deepEqual(byFleet[1].capacity, yearOf(160, 0, 0, 5), 'their capacity is summed once')
  assert.equal(byFleet[9].capacity, null, 'a fleet the page has no row for adds nothing and has no capacity')
  assert.equal(byFleet[9].status, 'unknown', 'and its group is not known, which is not incapable')
  assert.deepEqual(audit.closed.map((record) => [record.FleetID, record.shape]).sort((a, b) => a[0] - b[0]), [[4, 'closed'], [5, 'finite-repeat']], 'the queues that do not repeat and carry cargo, listed')
  assert.deepEqual(audit.broken.map((record) => [record.FleetID, record.shape, record.problem]).sort((a, b) => a[0] - b[0]), [[6, 'empty', null], [7, 'untraceable', 'one-order']], 'the fleets set to repeat that are not on a route')
  assert.deepEqual(audit.counts, { cycling: 5, groups: 4, duplicates: 1, closed: 2, broken: 2 }, 'the counts: a closed queue is never counted as a fleet of a route')
  assert.equal(audit.groups.some((group) => group.fleets.some((record) => [4, 5].includes(record.FleetID))), false, 'no closed queue is in a group')
  assert.deepEqual(byFleet[1].related.map((entry) => entry.relation).sort(), ['reversed', 'same-route-conditions'], 'the reversed flow and the same route with other conditional orders are listed and the hub that shares an endpoint with a route is not')
  assert.deepEqual(byFleet[3].related.map((entry) => entry.relation), ['reversed', 'reversed'], 'and the other way round, once to each of the routes it reverses')
  assert.deepEqual(byFleet[9].related.map((entry) => entry.relation).sort(), ['reversed', 'same-route-conditions'], 'the same route with other conditional orders is listed, and the flow reversed')
  assert.deepEqual(byFleet[8].related, [], 'a route that shares nothing with another lists nothing')
  assert.equal(byFleet[8].status, 'unknown', 'a group with no row is not known')
  assert.deepEqual([byFleet[1].name.source, byFleet[1].name.name.includes('Alpha'), byFleet[1].name.name.includes('Beta')], ['generated', true, true], 'the name of a group of two fleets of two names is generated from them')
  assert.equal(byFleet[1].labels['colony:101'], 'Alpha', 'the places of a group are named by the colonies')

  const old = m.audit.auditOf({ queues: { ...QUEUES(), supported: false, reason: 'no conditional table' }, raceId: RACE })

  assert.deepEqual([old.supported, old.reason, old.groups, old.closed, old.broken, old.counts.groups], [false, 'no conditional table', [], [], [], 0], 'a save that cannot be read says why and lists nothing')
  assert.equal(m.audit.auditOf({ queues: null, raceId: RACE }).supported, false, 'no read is not supported')

  const delivering = { cargo: { deliveries: [{ PopulationID: 102, kind: 'minerals', amount: 10, sources: [{ from: 101, amount: 10 }] }] } }
  const desired = m.audit.auditOf({ queues: QUEUES(), raceId: RACE, ships: { 1: hold, 2: hold, 3: hold, 8: hold, 9: hold }, rows: { ...rows, 1: { ...rows[1], ...delivering }, 2: { ...rows[2], ...delivering } }, desires: [{ id: 'd1', name: 'Wanted', cargo: 'minerals', from: 101, to: 102, yearly: 50, stale: false }, { id: 'd2', name: 'Missing', cargo: 'minerals', from: 104, to: 102, yearly: null, stale: false }] })

  assert.deepEqual(desired.desires.map((entry) => [entry.id, entry.state]), [['d1', 'covered'], ['d2', 'uncovered']], 'the desired routes are set against the observed groups')
  assert.deepEqual(desired.groups.map((group) => group.id), audit.groups.map((group) => group.id), 'and change none of them')
})

add('figure', 'the figures of a fleet are the ones of its row in the table above, and a fleet with no row has none', ({ m }) => {
  const row = { profile: { status: 'ok' }, route: { km: 12 }, blocked: [1], unknown: [2, 3], year: yearOf(1, 2, 3, 4), Speed: 5 }

  assert.deepEqual(m.audit.figureOf(row, [{}, {}]), { ships: 2, holds: true, profile: 'ok', traced: true, blocked: 1, unknown: 2, moving: true, year: yearOf(1, 2, 3, 4) }, 'a fleet with a row')
  assert.deepEqual(m.audit.figureOf({ ...row, route: { km: null }, Speed: 0, year: null }, [{}]), { ships: 1, holds: true, profile: 'ok', traced: false, blocked: 1, unknown: 2, moving: false, year: null }, 'a cycle that cannot be traced, a fleet that does not move, no year')
  assert.deepEqual(m.audit.figureOf(null, [{ CargoCapacity: 0, ColonistCapacity: 0 }]), { ships: 1, holds: false, profile: 'unknown', traced: false, blocked: 0, unknown: 0, moving: false, year: null }, 'a fleet with no row and no hold')
  assert.equal(m.audit.figureOf(null, [{ CargoCapacity: 0, ColonistCapacity: 4 }]).holds, true, 'a fleet with berths has a hold')
  assert.equal(m.sig.memberState(m.audit.figureOf(null, [{ CargoCapacity: 5 }])).state, 'unknown', 'a fleet the page does not time is not known, whatever it holds')
  assert.equal(m.audit.figureOf(null, [{ CargoCapacity: null, ColonistCapacity: null }]).holds, null, 'a fleet whose capacities are not in the save has no known hold')
  assert.equal(m.audit.figureOf(null, [{ CargoCapacity: 0, ColonistCapacity: null }]).holds, null, 'a capacity of zero and another not read')
  assert.equal(m.audit.figureOf(null, [{ CargoCapacity: 0, ColonistCapacity: 0 }, { CargoCapacity: null, ColonistCapacity: 4 }]).holds, true, 'a berth settles it')
  assert.equal(m.sig.memberState(m.audit.figureOf(null, [{ CargoCapacity: null, ColonistCapacity: null }])).state, 'unknown', 'capacities not in the save make the fleet not known')
  assert.equal(m.sig.memberState(m.audit.figureOf(null, [{ CargoCapacity: 0, ColonistCapacity: 0 }])).state, 'incompatible', 'capacities of zero make it incompatible')
})

// ---- The loader, over a database made here ------------------------------------------------------------------------------

const database = (db) => ({
  query: async (sql, { replacements = {} } = {}) => {
    const named = Object.fromEntries(Object.entries(replacements).filter(([key]) => sql.includes(`:${key}`)).map(([key, value]) => [`:${key}`, value]))

    return [db.query(sql).all(named), {}]
  },
})

const ORDER_COLUMNS = 'MoveOrderID integer, GameID integer, RaceID integer, FleetID integer, MoveActionID integer, MoveOrder integer, StartSystemID integer, DestinationType integer, DestinationID integer, PopulationID integer, DestinationItemType integer, DestinationItemID integer, MaxItems integer, MinQuantity real, OrderDelay integer, OrderDelayRemaining integer, Arrived integer, NewSystemID integer, NewWarpPointID integer, Description text'

// A database with the tables the loader reads. `old` leaves out the conditional table, as a save that predates 2.6 does.
const queueDatabase = ({ old = false } = {}) => {
  const db = new Database(':memory:')

  db.run('create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, FleetName text, CycleMoves integer, ShippingLine integer, Speed integer, IgnoreConditional integer, IgnoreStanding integer)')
  db.run(`create table FCT_MoveOrders (${ORDER_COLUMNS})`)
  db.run('create table FCT_Population (PopulationID integer, RaceID integer)')
  db.run('create table DIM_MoveAction (MoveActionID integer, Description text, DestinationItemType integer, SpecifyQuanitity integer, MinQuantity integer, TransitOrder integer)')
  db.run('create table FCT_OrderTemplate (OrderTemplateID integer, TemplateName text, StartSystemID integer, GameID integer, RaceID integer)')
  db.run('create table FCT_MoveOrderTemplate (OrderTemplateID integer, GameID integer, MoveIndex integer, MoveActionID integer, StartSystemID integer, DestinationType integer, DestinationID integer, PopulationID integer, DestinationItemType integer, DestinationItemID integer, MaxItems integer, MinQuantity real, OrderDelay integer, NewSystemID integer, NewJumpPointID integer)')

  if (!old) {
    db.run('create table FCT_FleetConditionalOrder (FleetID integer, GameID integer, ConditionalOrderID integer, ConditionID integer, Priority integer, CreateFWP integer)')
    db.run('create table FCT_FleetStandingOrder (FleetID integer, StandingOrderID integer, Priority integer, GameID integer)')
    db.run('create table DIM_Condition (ConditionID integer, Description text, DisplayOrder integer)')
  }

  return db
}

const fill = (db, { game = 1, race = RACE } = {}) => {
  const fleet = db.prepare('insert into FCT_Fleet values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const order = db.prepare(`insert into FCT_MoveOrders values (${ORDER_COLUMNS.split(',').map(() => '?').join(', ')})`)
  const add = (id, name, cycle, parts, { shipping = 0, owner = race, gameId = game, rotate = 0 } = {}) => {
    fleet.run(id, gameId, owner, name, cycle, shipping, 1000, 0, 0)
    storedOf(id, parts, { rotate }).forEach((row) => order.run(row.MoveOrderID, gameId, owner, row.FleetID, row.MoveActionID, row.MoveOrder, row.StartSystemID, row.DestinationType, row.DestinationID, row.PopulationID, row.DestinationItemType, row.DestinationItemID, row.MaxItems, row.MinQuantity, row.OrderDelay, row.OrderDelayRemaining, row.Arrived, row.NewSystemID, row.NewWarpPointID, row.Description))
  }

  add(1, 'Repeats', 1, MINERALS())
  add(2, 'Repeats rotated', 1, MINERALS(), { rotate: 1 })
  add(3, 'Closed', 0, MINERALS())
  add(4, 'Idle with one order', 0, [stop(1, 223)])
  add(5, 'A shipping line', 1, MINERALS(), { shipping: 9 })
  add(6, 'Another race', 1, MINERALS(), { owner: race + 1 })
  add(7, 'Another game', 1, MINERALS(), { gameId: game + 1 })
  add(8, 'Empty repeat', 1, [])
  db.run('insert into FCT_Population values (101, 7), (102, 7), (103, 8)')

  Object.entries(ACTIONS).forEach(([id, action]) => db.run('insert into DIM_MoveAction values (?, ?, ?, ?, ?, ?)', [Number(id), action.name, action.item, action.quantity ? 1 : 0, action.minimum ? 1 : 0, action.transit ? 1 : 0]))
}

add('loader', 'the loader reads the queues of the race in the game from a save of 2.6 or later, the flags of the actions, the conditional and standing orders and the templates, and says why it reads none from an older save', async ({ m }) => {
  const db = queueDatabase()

  fill(db)
  db.run('insert into FCT_FleetConditionalOrder values (3, 1, 33, 10, 1, 0), (6, 1, 34, 10, 1, 0)')
  db.run('insert into DIM_Condition values (10, \'Fuel at or below 30%\', 1)')
  db.run('insert into FCT_FleetStandingOrder values (1, 5, 1, 1), (1, 6, 2, 1), (2, 5, 1, 1), (6, 5, 1, 1)')
  db.run('insert into FCT_OrderTemplate values (50, \'Mineral run\', 1, 1, 7), (51, \'Of another race\', 1, 1, 8), (52, \'Of another game\', 1, 2, 7)')
  db.run('insert into FCT_MoveOrderTemplate values (50, 1, 1, 223, 1, 2, 1001, 101, 0, 0, 0, 0, 30, 0, 0), (50, 1, 2, 1, 1, 1, 1002, 0, 0, 0, 0, 0, 0, 2, 2001), (51, 1, 1, 223, 1, 2, 1001, 101, 0, 0, 0, 0, 0, 0, 0)')

  const queues = await m.queues.loadRouteQueues(database(db), { GameID: 1, RaceID: RACE })

  assert.deepEqual([queues.supported, queues.reason], [true, ''], 'a save with the conditional orders is supported')
  assert.deepEqual(queues.fleets.map((fleet) => fleet.FleetID), [1, 2, 3, 8], 'the fleets: repeating or holding two orders or more, of the race, the game and no shipping line')
  assert.deepEqual(queues.orders.filter((order) => order.FleetID === 2).map((order) => order.MoveOrderID), storedOf(2, MINERALS(), { rotate: 1 }).map((row) => row.MoveOrderID), 'a fleet\'s orders in their order')
  assert.deepEqual([...new Set(queues.orders.map((order) => order.FleetID))], [1, 2, 3], 'the orders of those fleets only')
  assert.deepEqual(queues.orders.filter((order) => order.FleetID === 1 && order.PopulationID > 0).map((order) => order.PopulationRaceID), [7, 7], 'the race that owns the colony of an order')
  assert.deepEqual(queues.actions[178], { name: 'Load Mineral Type', item: 1, quantity: true, minimum: false, transit: false }, 'the flags of an action')
  assert.deepEqual([queues.actions[180].minimum, queues.actions[1].transit, queues.actions[223].quantity], [true, true, false], 'the flags of three more')
  assert.deepEqual(queues.conditionals.map((row) => [row.FleetID, row.ConditionID, row.ConditionalOrderID, row.ConditionName]), [[3, 10, 33, 'Fuel at or below 30%']], 'the conditional orders of the race\'s repeating fleets, with the condition\'s words')
  assert.deepEqual(queues.standing, { 1: 2, 2: 1 }, 'the standing orders counted by fleet')
  assert.deepEqual(queues.templates.map((template) => [template.OrderTemplateID, template.TemplateName, template.orders.length]), [[50, 'Mineral run', 2]], 'the templates of the race in the game with their rows')

  const audit = m.audit.auditOf({ queues, raceId: RACE })

  assert.deepEqual(audit.groups.map((group) => group.fleets.map((record) => record.FleetID)), [[1, 2]], 'the two rows of one cycle, read from the database, are one group')
  assert.deepEqual(audit.closed.map((record) => record.FleetID), [3], 'the closed queue is listed apart')
  assert.deepEqual(audit.broken.map((record) => [record.FleetID, record.shape]), [[8, 'empty']], 'the empty repeat is named')

  const older = queueDatabase({ old: true })

  fill(older)

  const unsupported = await m.queues.loadRouteQueues(database(older), { GameID: 1, RaceID: RACE })

  assert.deepEqual([unsupported.supported, unsupported.fleets, unsupported.orders, unsupported.templates], [false, [], [], []], 'a save that predates the conditional orders is not supported and reads nothing')
  assert.ok(unsupported.reason.length > 0, 'and says why')

  const bare = new Database(':memory:')

  bare.run('create table FCT_FleetConditionalOrder (FleetID integer)')
  bare.run('create table FCT_Fleet (FleetID integer)')
  bare.run('create table FCT_MoveOrders (FleetID integer)')

  const missing = await m.queues.loadRouteQueues(database(bare), { GameID: 1, RaceID: RACE })

  assert.deepEqual([missing.supported, missing.reason.length > 0], [false, true], 'a save without the columns the orders are read from is not supported')
})

// ---- The desired routes as records --------------------------------------------------------------------------------------

const memory = () => {
  const files = new Map()
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      const next = change(this.store)

      this.store = next

      return next
    },
  })

  return { files, storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => ({}), writable: () => Promise.resolve(true) } }
}

// A repository of desired routes over memory, with the two colonies of the race a route can run between: Alpha (101) in System 1 and Beta (102) in System 2.
const desireWorld = async (m) => {
  const registry = m.records.createAdapterRegistry()
  let ids = 0
  let clock = 1000

  m.desires.registerRouteDesires(registry.register)

  const repository = m.records.createRepository({ storage: memory().storage, adapters: registry, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, now: () => ++clock })
  const scope = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 100000 }
  const source = (id, name, system) => ({ PopulationID: id, PopName: name, SpeciesID: 1, SystemID: system, SystemBodyID: 1000 + system, SystemName: `System ${system}` })
  const objects = await m.desires.loadDesireObjects(database({ query: () => ({ all: () => [source(101, 'Alpha', 1), source(102, 'Beta', 2)] }) }), { GameID: 1, RaceID: RACE })

  return { repository, scope, context: { ...objects, campaignId: 'c1', branchId: 'b1' }, row: (id) => objects.objects.colony.get(id) }
}

add('desire-records', 'a desired route is kept as a local record of its own: it validates, links its two colonies, is read back with its links, and nothing it does reaches the observed groups', async ({ m }) => {
  const { repository, scope, context, row } = await desireWorld(m)
  const valid = { name: 'Wanted run', cargo: 'minerals', yearly: 120, note: 'for the mine', from: { id: 101, name: 'Alpha', systemId: 1, systemName: 'System 1', origin: { campaignId: 'c1', branchId: 'b1' } }, to: { id: 102, name: 'Beta', systemId: 2, systemName: 'System 2', origin: { campaignId: 'c1', branchId: 'b1' } } }

  assert.deepEqual(m.desires.problemsOf(valid), [], 'a valid record has no problem')
  assert.ok(m.desires.problemsOf({ ...valid, cargo: 'fuel' }).length > 0, 'a cargo that is not hauled')
  assert.ok(m.desires.problemsOf({ ...valid, to: valid.from }).length > 0, 'a route from a colony to itself')
  assert.ok(m.desires.problemsOf({ ...valid, name: ' ' }).length > 0, 'a name that is blank')
  assert.ok(m.desires.problemsOf({ ...valid, name: 'x'.repeat(m.raw.DESIRE_NAME_LENGTH + 1) }).length > 0, 'a name that is too long')
  assert.ok(m.desires.problemsOf({ ...valid, yearly: -4 }).length > 0, 'a demand below zero')
  assert.ok(m.desires.problemsOf({ ...valid, stock: 5 }).length > 0, 'a field a desired route does not have: it is never derived from stock')
  assert.deepEqual(m.desires.problemsOf({ ...valid, yearly: null }), [], 'no demand is allowed')

  const saved = await m.desires.saveDesire(repository, scope, { name: 'Wanted run', cargo: 'minerals', yearly: 120, note: 'for the mine', from: { row: row(101) }, to: { row: row(102) }, context })

  assert.equal(saved.ok, true, `the record is kept: ${saved.message || ''}`)

  const read = m.desires.readDesires(repository, scope, context)

  assert.deepEqual(read.entries.map((entry) => [entry.name, entry.cargo, entry.yearly, entry.from.id, entry.to.id, entry.stale]), [['Wanted run', 'minerals', 120, 101, 102, false]], 'the record read back with its two colonies')
  assert.deepEqual(m.audit.desiresOf(read.entries).map((entry) => [entry.cargo, entry.from, entry.to, entry.yearly, entry.stale]), [['minerals', 101, 102, 120, false]], 'and as the audit takes it')

  const same = await m.desires.saveDesire(repository, scope, { name: 'Loop', cargo: 'minerals', from: { row: row(101) }, to: { row: row(101) }, context })

  assert.equal(same.ok, false, 'a route from a colony to itself is refused')

  const outside = await m.desires.saveDesire(repository, scope, { name: 'Elsewhere', cargo: 'minerals', from: { row: { ...row(101), id: 555 } }, to: { row: row(102) }, context })

  assert.equal(outside.ok, false, 'a colony the save does not have is refused')

  const gone = { ...context, objects: { colony: new Map([[102, row(102)]]) } }

  assert.equal(m.desires.readDesires(repository, scope, gone).entries[0].stale, true, 'a colony that is no longer in the save leaves the link stale')
  assert.equal(m.desires.readDesires(repository, scope, null).entries[0].stale, false, 'a save not read yet does not call a link stale')

  // The observed groups are the same with and without the record: a desired route is read after them and changes none.
  const audit = (desires) => m.audit.auditOf({ queues: QUEUES(), raceId: RACE, desires }).groups.map((group) => [group.id, group.fleets.map((record) => record.FleetID)])

  assert.deepEqual(audit(m.audit.desiresOf(read.entries)), audit([]), 'the observed groups are the same with the record')

  const removed = await m.desires.deleteDesire(repository, scope, read.entries[0])

  assert.equal(removed.ok, true, 'the record is deleted over its revision')
  assert.deepEqual(m.desires.readDesires(repository, scope, context).entries, [], 'and gone')
})

add('colony-choices', 'the colonies a desired route can run between are listed by name, with the system', ({ m }) => {
  const row = (id, name, systemName) => ({ id, name, systemName })
  const objects = { colony: new Map([[3, row(3, 'Beta', 'Sol')], [1, row(1, 'Alpha', 'Sol')], [2, row(2, 'Alpha', '')]]) }

  assert.deepEqual(m.audit.colonyChoices(objects).map((choice) => [choice.id, choice.name, choice.text]), [[1, 'Alpha', 'Alpha (Sol)'], [2, 'Alpha', 'Alpha'], [3, 'Beta', 'Beta (Sol)']], 'sorted by name then id')
  assert.deepEqual([m.audit.colonyChoices(null), m.audit.colonyChoices({})], [[], []], 'no colonies are read')
})

add('backup', 'the History page\'s backup registers the desired routes, so a restore in a session that never opened the Hauling page keeps a kept route that a repository without the adapter rejects', async ({ m, history }) => {
  const { repository, scope, context, row } = await desireWorld(m)
  const saved = await m.desires.saveDesire(repository, scope, { name: 'Wanted run', cargo: 'minerals', yearly: 120, note: '', from: { row: row(101) }, to: { row: row(102) }, context })

  assert.equal(saved.ok, true, `the record is kept: ${saved.message || ''}`)

  const bundle = repository.exportRecords(scope)
  const target = { campaignId: 'c2', RaceID: RACE, branch: 'b1' }
  const bare = m.records.createRepository({ storage: memory().storage, adapters: m.records.createAdapterRegistry(), newId: () => '00000000-0000-4000-8000-000000000900', now: () => 5000 }).previewImport(bundle, target, { restore: true })

  assert.deepEqual([bare.rejected, bare.importable], [1, 0], 'a repository with no adapter of the kind rejects the route, so the restore turns on the registration')

  const { adapter, error } = await instantiate(await history(), { boundary, $store: PAGE_STORE, database: null, GameID: 1, RaceID: RACE, data: {} }).backupAnnotations()

  assert.equal(error, null, 'the page opens the records for the backup')

  const preview = adapter.preview(bundle, target, { restore: true })

  assert.deepEqual([preview.rejected, preview.importable, preview.items.map((item) => [item.kind, item.status])], [0, 1, [['route.desire', 'import']]], 'the page\'s backup restores the route')
})

// ---- The faults and the rewrites of the pure sources --------------------------------------------------------------------

const S = 'signatures'
const A = 'audit'
const Q = 'queues'
const D = 'desires'
const G = 'groups'
const C = 'cargo'
const H = 'history'
/* eslint-disable no-template-curly-in-string */

// { name, file, find (the text, once) or at (a pattern, once) with to, fails: the ids of the checks one of which must fail by a value }
const MUTATIONS = [
  { name: 'a queue is keyed as saved, not at its least rotation', file: S, find: 'const { offset, rotated, delays } = leastRotation(keys, parts.map((part) => part.pacing))', to: 'const offset = 0\n  const rotated = keys\n  const delays = parts.map((part) => part.pacing)', fails: ['rotation', 'period', 'links'] },
  { name: 'the head position does not follow the rotation', file: S, find: 'headPosition: ((length - offset) % length) % period,', to: 'headPosition: 0,', fails: ['rotation'] },
  { name: 'the key is not reduced to its period', file: S, find: 'const period = periodOf(rotated)\n', to: 'const period = length\n', fails: ['period'] },
  { name: 'the period ignores the last order', file: S, find: 'for (let period = 1; period < length; period++) {', to: 'for (let period = 1; period < length - 1; period++) {', fails: ['period'] },
  { name: 'the quantity of a load is not part of the service', file: S, find: "const quantity = action.quantity ? `:q${integer(order.MaxItems)}` : ''", to: "const quantity = ''", fails: ['key-fields'] },
  { name: 'the quantity of every load is part of the service', file: S, find: 'const quantity = action.quantity ?', to: 'const quantity = action.quantity || order.MaxItems > 0 ?', fails: ['key-fields'] },
  { name: 'the mineral of a load is not part of the service', file: S, find: "const item = action.item > 0 && !isLagrangeJump(order) ? `:i${present(order.DestinationItemType)}.${present(order.DestinationItemID)}` : ''", to: "const item = ''", fails: ['key-fields'] },
  { name: 'the minimum of a load is cut, not read half to even', file: S, find: 'const minimum = action.minimum ? `:m${halfEven(integer(order.MinQuantity))}` : \'\'', to: 'const minimum = action.minimum ? `:m${Math.trunc(integer(order.MinQuantity))}` : \'\'', fails: ['key-fields'] },
  { name: 'the minimum is read half up', file: S, find: 'return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1', to: 'return fraction < 0.5 ? floor : floor + 1', fails: ['key-fields'] },
  { name: 'the minimum is part of the service of a load not flagged for it', file: S, find: 'const minimum = action.minimum ?', to: 'const minimum = true ?', fails: ['key-fields'] },
  { name: 'the delay is part of the key', file: S, find: 'key: rotated.slice(0, period).join(\';\'),', to: 'key: `${rotated.slice(0, period).join(\';\')}@${delays.slice(0, period).join(\',\')}`,', fails: ['pacing', 'key-fields'] },
  { name: 'the delay is read from where the queue was saved, not where the cycle starts', file: S, find: 'const { offset, rotated, delays } = leastRotation(keys, parts.map((part) => part.pacing))', to: 'const { offset, rotated } = leastRotation(keys, parts.map((part) => part.pacing))\n  const delays = parts.map((part) => part.pacing)', fails: ['pacing'] },
  { name: 'a colony is told from its bare body', file: S, find: 'return orderPlaceKey(order, raceId) ||', to: 'return `body:${present(order.DestinationID)}` ||', fails: ['key-fields', 'flows'] },
  { name: 'the colony of another race is the colony', file: S, find: 'const endpointKey = (order, raceId) => {', to: 'const endpointKey = (order, raceId) => {\n  raceId = order.PopulationRaceID', fails: ['key-fields'] },
  { name: 'the conditional set is not part of the group', file: S, find: 'id: `g${hashText(`${signature.key}\\n${conditional.key}`)}`', to: 'id: `g${hashText(signature.key)}`', fails: ['conditions', 'audit'] },
  { name: 'the conditional rows are keyed in the order they were read', file: S, find: 'const sorted = [...rows].sort((a, b) => a.Priority - b.Priority || a.ConditionID - b.ConditionID)', to: 'const sorted = [...rows]', fails: ['conditions'] },
  { name: 'a fleet that ignores its conditional orders keeps their key', file: S, find: "const key = ignored ? '' :", to: 'const key =', fails: ['conditions'] },
  { name: 'the standing orders are part of the key', file: S, find: 'hashText(`${signature.key}\\n${conditional.key}`)', to: 'hashText(`${signature.key}\\n${conditional.key}${standing}`)', fails: ['conditions'] },
  { name: 'a fuel condition at its share is armed', file: S, find: 'known.some((share) => share <= atMost)', to: 'known.some((share) => share < atMost)', fails: ['conditions'] },
  { name: 'a condition of anything but fuel is armed', file: S, find: "if (atMost === undefined && conditionId !== FUEL_FULL) {\n    return 'unresolvable'", to: "if (atMost === undefined && conditionId !== FUEL_FULL) {\n    return 'armed'", fails: ['conditions'] },
  { name: 'a condition that is true now is called armed', file: S, find: "return met ? 'true-now' :", to: "return met ? 'armed' :", fails: ['conditions'] },
  { name: 'a closed queue is a route', file: S, find: "const shape = cycling ? (!queue.length ? 'empty' : problem ? 'untraceable' : 'route') :", to: "const shape = true ? (!queue.length ? 'empty' : problem ? 'untraceable' : 'route') :", fails: ['shapes', 'audit'] },
  { name: 'a queue that repeats a fixed number of times is closed', file: S, find: "signature.repeats > 1 ? 'finite-repeat' : 'closed'", to: "'closed'", fails: ['shapes', 'audit'] },
  { name: 'a queue of one order repeats', file: S, find: 'const problem = queue.length === 1 && cycling ? \'one-order\' : chainProblem(queue, actions)', to: 'const problem = chainProblem(queue, actions)', fails: ['shapes'] },
  { name: 'the chain of a queue is not checked', file: S, find: "return broken ? 'chain' : null", to: 'return null', fails: ['shapes'] },
  { name: 'a closed queue with no cargo is listed', file: S, find: "queue.length < 2 || problem || !flows.length ? 'none'", to: "queue.length < 2 || problem ? 'none'", fails: ['shapes', 'audit'] },
  { name: 'what is held is lost at the wrap of the cycle', file: S, find: 'for (let pass = 0; pass < 2; pass++) {', to: 'for (let pass = 0; pass < 1; pass++) {', fails: ['flows', 'rotation'] },
  { name: 'a reserve balance is a flow between two colonies', file: S, find: "keep('reserve', part.stop, part.stop)", to: "keep('minerals', part.stop, part.stop)", fails: ['flows'] },
  { name: 'an unload with nothing held is a flow', file: S, find: 'UNLOADS[part.action] && held[UNLOADS[part.action]]', to: "UNLOADS[part.action] && (held[UNLOADS[part.action]] = held[UNLOADS[part.action]] || new Map([['self', { source: part.stop, item: null, upper: Infinity }]]))", fails: ['flows'] },
  { name: 'a reversed flow is the same pair', file: S, find: 'if (sameSet(flowsA, reversed)) {\n      return \'reversed\'', to: 'if (sameSet(flowsA, reversed)) {\n      return \'same-pair\'', fails: ['relations'] },
  { name: 'a shared flow is a shared endpoint', file: S, find: "} else if (intersects(flowsA, flowsB)) {\n      return 'partial'", to: "} else if (intersects(flowsA, flowsB)) {\n      return 'endpoint'", fails: ['relations'] },
  { name: 'the same route at another pacing is the same route', file: S, find: "left.pacingKey === right.pacingKey ? 'same-route' : 'same-route-pacing'", to: "'same-route'", fails: ['pacing', 'relations'] },
  { name: 'another conditional set is the same route', file: S, find: "left.conditionalKey !== right.conditionalKey ? 'same-route-conditions' : left.pacingKey", to: "false ? 'same-route-conditions' : left.pacingKey", fails: ['conditions', 'relations', 'audit'] },
  { name: 'the same flows by another service are another path', file: S, find: "left.pathKey === right.pathKey ? 'same-flows-service' : 'same-flows-path'", to: "'same-flows-path'", fails: ['relations'] },
  { name: 'the group of a route is not told apart from another with the same flows', file: S, find: 'const group = byId.get(record.route.id) ||', to: 'const group = byId.get(`${record.flows.map((flow) => flow.key)}`) ||', fails: ['rotation', 'key-fields'] },
  { name: 'the fleets of a group are not in the order of their ids', file: S, find: 'const fleets = group.fleets.sort((a, b) => a.FleetID - b.FleetID)', to: 'const fleets = group.fleets.slice().reverse()', fails: ['groups', 'links'] },
  { name: 'the stored orders of a fleet are not kept', file: S, find: 'orders: queue.map((order) => ({ MoveOrderID: order.MoveOrderID, MoveOrder: order.MoveOrder })),', to: 'orders: [],', fails: ['links', 'audit'] },
  { name: 'the orders of a fleet are in the order the rows come in', file: S, find: 'const queue = [...orders].sort((a, b) => a.MoveOrder - b.MoveOrder)', to: 'const queue = [...orders]', fails: ['links', 'shapes'] },
  { name: 'the links of a group name only its first fleet', file: S, find: 'links: fleets.map((record) => ({ FleetID: record.FleetID, orders: record.orders })) }', to: 'links: fleets.slice(0, 1).map((record) => ({ FleetID: record.FleetID, orders: record.orders })) }', fails: ['links'] },
  { name: 'the capacity of two fleets is the larger of them', file: S, find: 'list.reduce((total, member) => ({ minerals: total.minerals + member.year.minerals,', to: 'list.reduce((total, member) => ({ minerals: Math.max(total.minerals, member.year.minerals),', fails: ['groups', 'audit'] },
  { name: 'a fleet that two reads name counts twice', file: S, find: 'const members = group.fleets.filter((record) => !seen.has(record.FleetID) && seen.add(record.FleetID)).map(', to: 'const members = group.fleets.map(', fails: ['groups'] },
  { name: 'a fleet that cannot carry adds its capacity', file: S, find: 'year: capable ? figure.year : null }', to: 'year: figure && figure.year ? figure.year : null }', fails: ['groups'] },
  { name: 'the capacity of a group with no capable fleet is zero', file: S, find: '(list.length ? list.reduce((total, member) => ({', to: '(true ? list.reduce((total, member) => ({', fails: ['groups', 'audit'] },
  { name: 'a duplicated route is one with a fleet more than none', file: S, find: 'duplicate: capable.length > 1,', to: 'duplicate: members.length > 1,', fails: ['groups'] },
  { name: 'a group is served when it has a capable fleet held at a stock', file: S, find: "const status = members.some((member) => member.active) ? 'capable' : settled.length ? 'paused' :", to: "const status = settled.length ? 'capable' :", fails: ['status'] },
  { name: 'a fleet waiting on a timer is paused', file: S, find: "active: capable && !undetermined && record.waiting !== 'stock'", to: 'active: capable && !undetermined && !record.waiting', fails: ['status'] },
  { name: 'a group with a fleet not known is incapable', file: S, find: "members.some((member) => member.state === 'unknown') ? 'unknown' : 'incapable'", to: "'incapable'", fails: ['groups', 'audit'] },
  { name: 'a delay still to run does not come before a stock wait', file: S, find: "head.OrderDelayRemaining > 0 ? 'timer' : head.Arrived && STOCK_WAITS.has(head.MoveActionID) ? 'stock' : null", to: "head.Arrived && STOCK_WAITS.has(head.MoveActionID) ? 'stock' : head.OrderDelayRemaining > 0 ? 'timer' : null", fails: ['status'] },
  { name: 'an arrival at any action is a stock wait', file: S, find: 'head.Arrived && STOCK_WAITS.has(head.MoveActionID)', to: 'head.Arrived', fails: ['status'] },
  { name: 'a fleet with no hold is capable', file: S, find: "} else if (!figure.holds) {\n    return { state: 'incompatible'", to: "} else if (false) {\n    return { state: 'incompatible'", fails: ['states'] },
  { name: 'a fleet that cannot be traced is incompatible', file: S, find: "return { state: 'unknown', reason: 'the cycle cannot be traced from the saved orders' }", to: "return { state: 'incompatible', reason: 'the cycle cannot be traced from the saved orders' }", fails: ['states'] },
  { name: 'a fleet with a ship that cannot load is capable', file: S, find: 'else if (figure.blocked > 0) {', to: 'else if (figure.blocked > 99) {', fails: ['states'] },
  { name: 'a fleet with stops not known is capable', file: S, find: 'else if (figure.unknown > 0) {', to: 'else if (figure.unknown > 99) {', fails: ['states'] },
  { name: 'a fleet that does not move is capable', file: S, find: "figure.profile === 'immobile' || !figure.moving", to: "figure.profile === 'immobile'", fails: ['states'] },
  { name: 'no reason is given for a state', file: S, find: "return { state: 'incompatible', reason: 'no ship of the fleet has a cargo hold or berths' }", to: "return { state: 'incompatible', reason: '' }", fails: ['states'] },
  { name: 'a desired route nothing carries is unknown', file: S, find: "serving.length ? 'paused' : unknown.length || untold.length || open.length ? 'unknown' : 'uncovered'", to: "serving.length ? 'paused' : 'unknown'", fails: ['desires'] },
  { name: 'a desired route a cycle cannot tell is uncovered', file: S, find: "serving.length ? 'paused' : unknown.length || untold.length || open.length ? 'unknown' : 'uncovered'", to: "serving.length ? 'paused' : 'uncovered'", fails: ['desires'] },
  { name: 'a desired route is covered by a fleet held at a stock', file: S, find: "const state = serving.some((member) => member.active) ? 'covered' : serving.length ? 'paused'", to: "const state = serving.length ? 'covered' : serving.length ? 'paused'", fails: ['desires'] },
  { name: 'a stale link is uncovered', file: S, find: "return { ...desire, state: 'unknown', reason: 'a colony of the record is no longer the one that was linked',", to: "return { ...desire, state: 'uncovered', reason: 'a colony of the record is no longer the one that was linked',", fails: ['desires'] },
  { name: 'a desired route is covered by the reverse direction', file: S, find: 'flow.kind === desire.cargo && flow.from === from && flow.to === to', to: 'flow.kind === desire.cargo && ((flow.from === from && flow.to === to) || (flow.from === to && flow.to === from))', fails: ['desires'] },
  { name: 'a desired route is covered by any cargo', file: S, find: 'flow.kind === desire.cargo && flow.from === from', to: 'flow.from === from', fails: ['desires'] },
  { name: 'the capacity of a desired route counts every unload of a fleet', file: S, find: '(deliveries[member.record.FleetID] || []).filter((delivery) => delivery.PopulationID === desire.to && delivery.kind === desire.cargo)', to: '(deliveries[member.record.FleetID] || [])', fails: ['desires'] },
  { name: 'a gap is negative when the capacity is over the demand', file: S, find: 'Math.max(0, desire.yearly - (capacity || 0))', to: '(desire.yearly - (capacity || 0))', fails: ['desires'] },
  { name: 'a template of the same content is not a match when its pacing differs', file: S, find: 'const matched = (templates.get(group.key) || []).slice().sort(', to: 'const matched = (templates.get(group.key) || []).filter((template) => group.fleets.some((record) => record.route.pacingKey === template.pacingKey)).slice().sort(', fails: ['names'] },
  { name: 'only the first matching template is named', file: S, find: 'others: matched.slice(1).map((template) => template.name),', to: 'others: [],', fails: ['names'] },
  { name: 'an open template names a route', file: S, find: 'if (queue.length < 2 || chainProblem(queue, actions)) {', to: 'if (queue.length < 1) {', fails: ['names'] },
  { name: 'the name of a fleet is preferred to the template', file: S, find: 'if (matched.length) {\n    return { name: matched[0].name', to: 'if (matched.length && !group.fleets[0].FleetName) {\n    return { name: matched[0].name', fails: ['names'] },
  { name: 'a route named by its colonies says nothing when a colony has no name', file: S, find: 'group.flows.every((flow) => colonyNames[flow.from] && colonyNames[flow.to])', to: 'group.flows.every((flow) => true)', fails: ['names'] },
  { name: 'a fleet with a row of its own has no hold in the figures', file: A, find: 'return { ships: ships.length, holds: true, profile: row.profile.status,', to: 'return { ships: ships.length, holds, profile: row.profile.status,', fails: ['figure'] },
  { name: 'the figures of a fleet with no row say it moves', file: A, find: "profile: 'unknown', traced: false, blocked: 0, unknown: 0, moving: false, year: NO_YEAR }", to: "profile: 'ok', traced: true, blocked: 0, unknown: 0, moving: true, year: NO_YEAR }", fails: ['figure'] },
  { name: 'a closed queue is a group of the audit', file: A, find: 'const covered = coverGroups(groupRoutes(records), figures)', to: 'const covered = coverGroups(groupRoutes(records.map((record) => (record.shape === \'closed\' ? { ...record, shape: \'route\' } : record))), figures)', fails: ['audit'] },
  { name: 'every relation is listed', file: A, find: "const LISTED_RELATIONS = new Set(['same-route-conditions', 'same-flows-path', 'same-flows-service', 'reversed', 'same-pair', 'partial'])", to: "const LISTED_RELATIONS = new Set(['same-route-conditions', 'same-flows-path', 'same-flows-service', 'reversed', 'same-pair', 'partial', 'endpoint'])", fails: ['audit'] },
  { name: 'the closed queues are counted as fleets of a route', file: A, find: 'counts: { cycling: records.filter((record) => record.shape === \'route\').length,', to: 'counts: { cycling: records.filter((record) => record.shape !== \'empty\').length,', fails: ['audit'] },
  { name: 'an unsupported save lists its queues anyway', file: A, find: 'if (!queues || !queues.supported) {', to: 'if (!queues) {', fails: ['audit'] },
  { name: 'a desired route is added to the groups', file: A, find: 'desires: coverDesires(desires, groups, deliveries),', to: 'desires: coverDesires(desires, groups, deliveries), groups: groups.concat(desires.map((desire) => ({ id: desire.id, fleets: [{ FleetID: 0 }], related: [], members: [], flows: [], labels: {}, name: { name: desire.name, source: \'generated\', others: [] } }))),', fails: ['audit', 'desire-records'] },
  { name: 'the colonies are listed in the order they were read', file: A, find: '.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)', to: '', fails: ['colony-choices'] },
  { name: 'the fleets of a shipping line are read', file: Q, find: "const shipping = fleet.has('ShippingLine') ? 'and FCT_Fleet.ShippingLine = 0' : ''", to: "const shipping = ''", fails: ['loader'] },
  { name: 'the fleets of every race are read', file: Q, find: 'FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID ${shipping} and (FCT_Fleet.CycleMoves = 1', to: 'FCT_Fleet.GameID = :GameID ${shipping} and (FCT_Fleet.CycleMoves = 1', fails: ['loader'] },
  { name: 'a fleet that does not repeat is read', file: Q, find: 'and (FCT_Fleet.CycleMoves = 1 or (select count(*) from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) >= 2)', to: '', fails: ['loader'] },
  { name: 'a save without conditional orders is called supported', file: Q, find: "return { ...NOTHING, reason: 'The save has no conditional orders table", to: "return { ...NOTHING, supported: true, reason: 'The save has no conditional orders table", fails: ['loader'] },
  { name: 'the flags of the actions are not read', file: Q, find: 'item: row.Item || 0, quantity: row.Quantity > 0, minimum: row.Minimum > 0, transit: row.Transit > 0', to: 'item: 0, quantity: false, minimum: false, transit: false', fails: ['loader', 'key-fields'] },
  { name: 'the standing orders are not counted', file: Q, find: 'rows.forEach((row) => { counts[row.FleetID] = row.Orders })', to: '', fails: ['loader'] },
  { name: 'the templates of every race are read', file: Q, find: "from FCT_OrderTemplate where FCT_OrderTemplate.GameID = :GameID and FCT_OrderTemplate.RaceID = :RaceID', { replacements: { GameID, RaceID } })\n  const [rows]", to: "from FCT_OrderTemplate where FCT_OrderTemplate.GameID = :GameID', { replacements: { GameID, RaceID } })\n  const [rows]", fails: ['loader'] },
  { name: 'a desired route is valid with a stock field', file: D, find: 'const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a desired route`)', to: 'const problems = []', fails: ['desire-records'] },
  { name: 'a desired route from a colony to itself is valid', file: D, find: '} else if (payload.from.id === payload.to.id) {', to: '} else if (false) {', fails: ['desire-records'] },
  { name: 'a desired route may carry any cargo', file: D, find: 'if (!DESIRE_CARGO.includes(payload.cargo)) {', to: 'if (false) {', fails: ['desire-records'] },
  { name: 'a desire is read as stale when the colony is not read', file: D, find: "stale: link.status === 'missing' || link.status === 'changed'", to: "stale: link.status !== 'evidence'", fails: ['desire-records'] },
  { name: 'a fleet that moves none of the cargo of a route is capable of it', file: S, find: '} else if (figure.year && needs.length && !needs.some((kind) => figure.year[kind] > 0)) {', to: '} else if (false) {', fails: ['cargo-fit'] },
  { name: 'a fleet must move every cargo of a route to be capable of it', file: S, find: '!needs.some((kind) => figure.year[kind] > 0)', to: '!needs.every((kind) => figure.year[kind] > 0)', fails: ['cargo-fit'] },
  { name: 'a reserve balance asks for a cargo of its own', file: S, find: "(flow.kind === 'reserve' ? 'minerals' : flow.kind)", to: 'flow.kind', fails: ['cargo-fit'] },
  { name: 'a fleet whose capacities are not in the save is incompatible', file: S, find: '} else if (figure.holds === null) {', to: '} else if (false) {', fails: ['states'] },
  { name: 'a capacity not in the save counts as no hold', file: A, find: 'capacities.every((capacity) => Number.isFinite(capacity)) ? false : null', to: 'capacities.every((capacity) => Number.isFinite(capacity)) ? false : false', fails: ['figure'] },
  { name: 'a capacity of zero is a hold', file: A, find: 'capacities.some((capacity) => capacity > 0) ? true', to: 'capacities.some((capacity) => capacity >= 0) ? true', fails: ['figure'] },
  { name: 'an unload leaves what it took held', file: S, find: 'if (!part.limited || total <= part.amount) {', to: 'if (false) {', fails: ['flows'] },
  { name: 'an unload takes all that is held even when it is limited', file: S, find: 'if (!part.limited || total <= part.amount) {', to: 'if (true) {', fails: ['flows'] },
  { name: 'only the last load is held', file: S, find: '        entries.set(key, { source: part.stop,', to: '        entries.clear()\n        entries.set(key, { source: part.stop,', fails: ['flows'] },
  { name: 'every unload with a quantity is limited', file: S, find: 'limited: ITEM_UNLOADS.has(order.MoveActionID) && action.quantity && integer(order.MaxItems) > 0', to: 'limited: ITEM_UNLOADS.has(order.MoveActionID) && action.quantity', fails: ['flows'] },
  { name: 'an unload of colonists with a quantity stored is limited', file: S, find: 'limited: ITEM_UNLOADS.has(order.MoveActionID) && action.quantity && integer(order.MaxItems) > 0', to: 'limited: action.quantity && integer(order.MaxItems) > 0', fails: ['flows'] },
  { name: 'a desired route counts every source of the unloads at its second colony', file: S, find: '.filter((source) => source.from === desire.from)', to: '', fails: ['desires'] },
  { name: 'a survey location is the same in every system', file: S, find: '`survey:${present(order.StartSystemID)}:${present(order.DestinationID)}`', to: '`survey:0:${present(order.DestinationID)}`', fails: ['path-identity'] },
  { name: 'a jump inside a system ignores its exit', file: S, find: '`lagrange:${present(order.DestinationID)}>${present(order.DestinationItemID)}`', to: '`lagrange:${present(order.DestinationID)}>0`', fails: ['path-identity'] },
  { name: 'a jump inside a system ignores its entry', file: S, find: '`lagrange:${present(order.DestinationID)}>${present(order.DestinationItemID)}`', to: '`lagrange:0>${present(order.DestinationItemID)}`', fails: ['path-identity'] },
  { name: 'every unload is credited to the first stop loaded at', file: C, find: 'entries.push({ from: order.PopulationID, item, amount })', to: 'entries.push({ from: 0, item, amount })', fails: ['cargo-sources'] },
  { name: 'the cycle is read at its first pass', file: C, find: 'for (let pass = 0; pass < MAX_PASSES && !settled; pass++) {', to: 'for (let pass = 0; pass < 1; pass++) {', fails: ['cargo-sources'] },
  { name: 'an unload leaves what it took in the hold', file: C, find: 'entries.forEach((entry) => (entry.amount -= taken.get(entry) || 0))', to: 'entries.forEach(() => 0)', fails: ['cargo-sources'] },
  { name: 'an unload takes the whole of each source', file: C, find: 'return list.map((entry) => entry.amount * part)', to: 'return list.map((entry) => entry.amount)', fails: ['cargo-sources'] },
  { name: 'another pacing is never flagged', file: S, find: "...(group.pacing ? [{ key: 'pacing'", to: "...(false ? [{ key: 'pacing'", fails: ['flags'] },
  { name: 'a wait at a stock is flagged only for two fleets', file: S, find: '...(stalled > 0 ? [{ key:', to: '...(stalled > 1 ? [{ key:', fails: ['flags'] },
  { name: 'a wait on a timer is flagged by a wait at a stock', file: S, find: "...(timed > 0 ? [{ key: 'timer'", to: "...(stalled > 0 ? [{ key: 'timer'", fails: ['flags'] },
  { name: 'a timer is any wait', file: S, find: "const timed = group.members.filter((member) => member.record.waiting === 'timer').length", to: 'const timed = group.members.filter((member) => member.record.waiting).length', fails: ['flags'] },
  { name: 'an immobile fleet is not unfit', file: S, find: " || member.state === 'immobile').length", to: ').length', fails: ['flags'] },
  { name: 'the unfit flag does not count the fleets', file: S, find: '`${unfit} ${FLAGS.unfit}`', to: 'FLAGS.unfit', fails: ['flags'] },
  { name: 'a group is conditional only when a condition is true now', file: S, find: "group.members.some((member) => member.record.conditional.status !== 'none')", to: "group.members.some((member) => member.record.conditional.status === 'true-now')", fails: ['flags'] },
  { name: 'another pacing is a flag that calls for a look', file: S, find: "{ key: 'pacing', text: FLAGS.pacing, warning: false }", to: "{ key: 'pacing', text: FLAGS.pacing, warning: true }", fails: ['flags'] },
  { name: 'a desired route is covered by a fleet that moves none of its cargo', file: S, find: "member.state === 'capable' && member.year[desire.cargo] > 0 &&", to: "member.state === 'capable' &&", fails: ['cargo-fit'] },
  { name: 'an unload of one item takes the cargo of every item', file: C, find: 'const loose = item === null ? entries : entries.filter((entry) => entry.item === null)', to: 'const loose = entries', fails: ['cargo-sources'] },
  { name: 'a load keeps no item', file: C, find: 'const item = (loading ? ITEM_LOADS : ITEM_UNLOADS).has(id) ? order.DestinationItemID : null', to: 'const item = !loading && ITEM_UNLOADS.has(id) ? order.DestinationItemID : null', fails: ['cargo-sources'] },
  { name: 'the amount of an unload of one item is the whole hold', file: C, find: 'sumOf(entries.filter((entry) => item === null || entry.item === null || entry.item === item))', to: 'sumOf(entries)', fails: ['cargo-sources'] },
  { name: 'an unload of a quantity that is all the load leaves it held', file: S, find: '!part.limited || total <= part.amount', to: '!part.limited || false', fails: ['flows'] },
  { name: 'an unload of part of a load takes it all', file: S, find: '!part.limited || total <= part.amount', to: '!part.limited || true', fails: ['flows'] },
  { name: 'a load of a quantity has no bound', file: S, find: 'const bound = ITEM_LOADS.has(part.action) && part.amount > 0 ? part.amount : Infinity', to: 'const bound = Infinity', fails: ['flows'] },
  { name: 'an unload of one type reaches every type', file: S, find: '!ITEM_UNLOADS.has(part.action) || entry.item === null || entry.item === part.itemId', to: 'true', fails: ['flows'] },
  { name: 'an unload of one type does not reach what was loaded as any', file: S, find: '!ITEM_UNLOADS.has(part.action) || entry.item === null || entry.item === part.itemId', to: '!ITEM_UNLOADS.has(part.action) || entry.item === part.itemId', fails: ['flows'] },
  { name: 'the bound of what is left of a load is not lowered by an unload', file: S, find: 'entry.upper *= (total - part.amount) / total', to: 'entry.upper *= 1', fails: ['flows'] },
  { name: 'a cycle that has not settled publishes its last pass', file: C, find: 'if (!settled) {', to: 'if (false) {', fails: ['cargo-sources'] },
  { name: 'a cycle is never settled', file: C, find: 'settled = sameLedger(before, ledger)', to: 'settled = false', fails: ['cargo-sources'] },
  { name: 'a cycle is settled after one pass', file: C, find: 'settled = sameLedger(before, ledger)', to: 'settled = true', fails: ['cargo-sources'] },
  { name: 'a fleet that unloads none of the cargo from the first colony covers the desired route', file: S, find: 'const serving = settled.filter((member) => shares.get(member) > 0)', to: 'const serving = settled', fails: ['desires'] },
  { name: 'a fleet whose unloads name no source is no cause for doubt', file: S, find: 'const untold = settled.filter((member) => shares.get(member) === null)', to: 'const untold = []', fails: ['desires'] },
  { name: 'a fleet with no unloads given has none', file: S, find: 'return deliveries[member.record.FleetID] && unloads.every(', to: 'return unloads.every(', fails: ['desires'] },
  { name: 'an unload with no sources named is an unload from none', file: S, find: 'unloads.every((delivery) => Array.isArray(delivery.sources)) ? unloads.reduce((sum, delivery) => sum + delivery.sources.filter(', to: 'unloads.every(() => true) ? unloads.reduce((sum, delivery) => sum + (delivery.sources || []).filter(', fails: ['desires'] },
  { name: 'the reason fleets deliver none of it is the reason they cannot carry', file: S, find: "capable.length ? 'the fleets on the cycles that carry it unload none of it here from the first colony' : 'the fleets on cycles that carry it cannot carry here'", to: "'the fleets on cycles that carry it cannot carry here'", fails: ['desires'] },
  { name: 'a cycle that has not settled has a year', file: C, find: '(walk && !walk.total) || cargo.settled === false) {', to: '(walk && !walk.total)) {', fails: ['cargo-sources'] },
  { name: 'the shortfall of a route that cannot be told is its whole demand', file: S, find: 'short === 0 || (!unknown.length && !untold.length && !open.length) ? short : null', to: 'short', fails: ['desires'] },
  { name: 'a demand that what is known meets is a shortfall when a fleet is not known', file: S, find: 'short === 0 || (!unknown.length && !untold.length && !open.length) ? short : null', to: '!unknown.length && !untold.length && !open.length ? short : null', fails: ['desires'] },
  { name: 'a fleet with a condition true now is service', file: S, find: 'const undetermined = capable && UNDETERMINED.has(record.conditional.status)', to: 'const undetermined = false', fails: ['undetermined'] },
  { name: 'a fleet with a condition that cannot be read is service', file: S, find: "const UNDETERMINED = new Set(['true-now', 'unresolvable'])", to: "const UNDETERMINED = new Set(['true-now'])", fails: ['undetermined'] },
  { name: 'a fleet with a condition true now is not told apart', file: S, find: "const UNDETERMINED = new Set(['true-now', 'unresolvable'])", to: "const UNDETERMINED = new Set(['unresolvable'])", fails: ['undetermined'] },
  { name: 'a fleet whose conditions are all false is undetermined', file: S, find: "const UNDETERMINED = new Set(['true-now', 'unresolvable'])", to: "const UNDETERMINED = new Set(['true-now', 'unresolvable', 'armed'])", fails: ['undetermined'] },
  { name: 'a fleet that ignores its conditional orders is undetermined', file: S, find: "const UNDETERMINED = new Set(['true-now', 'unresolvable'])", to: "const UNDETERMINED = new Set(['true-now', 'unresolvable', 'ignored'])", fails: ['undetermined'] },
  { name: 'the capacity of a group counts the fleets of no known outcome', file: S, find: 'capacity: sumOf(settled), potential: sumOf(capable)', to: 'capacity: sumOf(capable), potential: sumOf(capable)', fails: ['undetermined', 'groups'] },
  { name: 'what a group could move leaves out the fleets of no known outcome', file: S, find: 'capacity: sumOf(settled), potential: sumOf(capable)', to: 'capacity: sumOf(settled), potential: sumOf(settled)', fails: ['undetermined'] },
  { name: 'a group of fleets of no known outcome is not known', file: S, find: "capable.length ? 'conditional' :", to: "capable.length ? 'unknown' :", fails: ['undetermined'] },
  { name: 'a group is served when a fleet of no known outcome is capable', file: S, find: "const status = members.some((member) => member.active) ? 'capable' :", to: "const status = capable.length ? 'capable' :", fails: ['undetermined', 'status'] },
  { name: 'a fleet of no known outcome covers the desired route', file: S, find: 'seen.add(member.record.FleetID))\n  const settled = capable.filter((member) => !member.undetermined)', to: 'seen.add(member.record.FleetID))\n  const settled = capable', fails: ['undetermined'] },
  { name: 'a fleet of no known outcome is no cause for doubt about a desired route', file: S, find: 'const open = capable.filter((member) => member.undetermined && shares.get(member) !== 0)', to: 'const open = []', fails: ['undetermined'] },
  { name: 'a fleet of no known outcome that delivers none of the cargo is a cause for doubt', file: S, find: 'const open = capable.filter((member) => member.undetermined && shares.get(member) !== 0)', to: 'const open = capable.filter((member) => member.undetermined)', fails: ['undetermined'] },
  { name: 'a desired route that only fleets of no known outcome may serve is uncovered', file: S, find: "unknown.length || untold.length || open.length ? 'unknown'", to: "unknown.length || untold.length ? 'unknown'", fails: ['undetermined'] },
  { name: 'the shortfall of a route is told while a fleet of no known outcome could close it', file: S, find: 'short === 0 || (!unknown.length && !untold.length && !open.length) ? short : null', to: 'short === 0 || (!unknown.length && !untold.length) ? short : null', fails: ['undetermined'] },
  { name: 'the stops of a cycle are its places once each', file: S, find: 'stops: cycleStopsOf(parts.map((part) => part.stop)),', to: 'stops: [...new Set(parts.map((part) => part.stop).filter(Boolean))],', fails: ['cycle-stops'] },
  { name: 'a stop that repeats the one before is another stop', file: S, find: '.filter((stop, index, all) => stop !== all[index - 1])', to: '.filter(() => true)', fails: ['cycle-stops'] },
  { name: 'the return to the first stop is another stop', file: S, find: 'stops.length > 1 && stops[stops.length - 1] === stops[0] ? stops.slice(0, -1) : stops', to: 'stops', fails: ['cycle-stops'] },
  { name: 'a place that is nowhere is a stop', file: S, find: 'places.filter(Boolean).filter(', to: 'places.filter(', fails: ['cycle-stops'] },
  { name: 'the match of a template is the match of any of them', file: S, find: 'group.fleets.some((record) => record.route.pacingKey === matched[0].pacingKey)', to: 'group.fleets.some((record) => matched.some((template) => template.pacingKey === record.route.pacingKey))', fails: ['names'] },
  { name: 'the match of a template is the match of the last of them', file: S, find: 'group.fleets.some((record) => record.route.pacingKey === matched[0].pacingKey)', to: 'group.fleets.some((record) => record.route.pacingKey === matched[matched.length - 1].pacingKey)', fails: ['names'] },
  { name: 'the match of a template needs every fleet at its pacing', file: S, find: 'group.fleets.some((record) => record.route.pacingKey === matched[0].pacingKey)', to: 'group.fleets.every((record) => record.route.pacingKey === matched[0].pacingKey)', fails: ['names'] },
  { name: 'the History page\'s backup leaves the desired routes unregistered', file: H, find: '        desires.registerRouteDesires(records.registerAdapter)\n', to: '', fails: ['backup'] },
]

// Rewrites that say the same thing: each must leave every statement green. `family` names the kind of rewrite.
const BENIGN = [
  { name: 'the transit test of an order parenthesised', family: 'parenthesised condition', file: S, find: 'const path = isTransit(order, action) ?', to: 'const path = (isTransit(order, action)) ?' },
  { name: 'the words of a group status written with the qualifier last', family: 'qualifier moved', file: S, find: "  capable: 'Served',\n  paused: 'Waiting at a stock',", to: "  capable: 'Served',\n  paused: 'At a stock, waiting'," },
  { name: 'a reason worded with a synonym', family: 'synonym', file: S, find: "reason: 'the fleet has no ships'", to: "reason: 'the fleet holds no ship'" },
  { name: 'a name source worded another way', family: 'synonym', file: S, find: "fleet: 'from fleet name',", to: "fleet: 'from the name of the fleet'," },
  { name: 'the comparison of two conditional sets written the other way round', family: 'condition turned round', file: S, find: 'return left.conditionalKey !== right.conditionalKey', to: 'return right.conditionalKey !== left.conditionalKey' },
  { name: 'the halves of an even number written the other way', family: 'condition turned round', file: S, find: 'floor % 2 === 0 ? floor : floor + 1', to: '(floor % 2 !== 0) ? floor + 1 : floor' },
  { name: 'the empty year written as a function result', family: 'rewrite', file: A, find: 'const NO_YEAR = null', to: 'const NO_YEAR = (() => null)()' },
  { name: 'the loader\'s required columns listed in another order', family: 'list order', file: Q, find: "const REQUIRED_ORDER_COLUMNS = ['MoveOrderID', 'FleetID', 'MoveOrder', 'MoveActionID', 'StartSystemID', 'DestinationType', 'DestinationID']", to: "const REQUIRED_ORDER_COLUMNS = ['DestinationID', 'DestinationType', 'StartSystemID', 'MoveActionID', 'MoveOrder', 'FleetID', 'MoveOrderID']" },
  { name: 'the check for capacities not in the save written the other way round', family: 'condition turned round', file: S, find: '} else if (figure.holds === null) {', to: '} else if (null === figure.holds) {' },
  { name: 'the limit of an unload written with its terms swapped', family: 'condition turned round', file: S, find: 'limited: ITEM_UNLOADS.has(order.MoveActionID) && action.quantity && integer(order.MaxItems) > 0', to: 'limited: integer(order.MaxItems) > 0 && action.quantity && ITEM_UNLOADS.has(order.MoveActionID)' },
  { name: 'the sum of the held cargo written the other way round', family: 'condition turned round', file: C, find: '.reduce((total, entry) => total + entry.amount, 0)', to: '.reduce((total, entry) => entry.amount + total, 0)' },
  { name: 'the sources a delivery is covered by written the other way round', family: 'condition turned round', file: S, find: 'const serving = settled.filter((member) => shares.get(member) > 0)', to: 'const serving = settled.filter((member) => 0 < shares.get(member))' },
  { name: 'the scale of the settled test written with its terms swapped', family: 'condition turned round', file: C, find: 'Math.max(1, Math.abs(entry.amount))', to: 'Math.max(Math.abs(entry.amount), 1)' },
  { name: 'the test for a cycle that has not settled written with its terms swapped', family: 'condition turned round', file: C, find: 'cargo.settled === false', to: 'false === cargo.settled' },
  { name: 'the shortfall of a demand written with its conditions swapped', family: 'condition turned round', file: S, find: 'short === 0 || (!unknown.length && !untold.length && !open.length) ? short : null', to: '(!open.length && !untold.length && !unknown.length) || short === 0 ? short : null' },
]

// ---- Running the checks over a set of sources ---------------------------------------------------------------------------

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

const sourcesOf = () => Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, read(file)]))

// The text to find and its replacement for a fault or a rewrite: the literal `find`, once.
const applied = (sources, edit) => {
  const count = sources[edit.file].split(edit.find).length - 1

  if (count !== 1) {
    throw new Error(`The anchor of "${edit.name}" matches ${count} times, not once`)
  }

  return { ...sources, [edit.file]: patched(path.basename(FILES[edit.file]), sources[edit.file], edit.find, edit.to) }
}

// The History page is loaded once for each text of it and of the utilities it reaches, so the faults that change neither reuse the copy of the head.
const historyPages = new Map()

const contextOf = async (sources) => {
  const changed = Object.keys(UTILITY_NAMES).filter((key) => sources[key] !== read(FILES[key]))
  const overrides = Object.fromEntries(changed.map((key) => [UTILITY_NAMES[key], sources[key]]))
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: overrides })
  const subject = (name) => subjectModule(loaded[name])
  const raw = { ...loaded['route-signatures'], ...loaded['route-desires'] }
  const pageUtilities = Object.fromEntries(changed.map((key) => [`utilities/${UTILITY_NAMES[key]}`, sources[key]]))
  const pageKey = JSON.stringify([sources.history, pageUtilities])
  const history = () => {
    if (!historyPages.has(pageKey)) {
      historyPages.set(pageKey, loadPage('pages/history', { stubs: STUBS, dynamicImports: true, sources: { 'pages/history': sources.history, ...pageUtilities, ...recordsOf(`the page ${historyPages.size}`) } }))
    }

    return historyPages.get(pageKey)
  }

  return { m: { sig: subject('route-signatures'), audit: subject('route-audit'), queues: subject('route-queues'), desires: subject('route-desires'), hauling: subject('hauling'), records: subject('scenario-records'), raw }, history }
}

const headChecks = () => CHECKS.filter((item) => item.part === 'head')

const runAll = async (sources) => runChecks(headChecks(), await contextOf(sources))

const failedOf = (results) => results.filter((result) => !result.ok)

const detail = (results) => results.map((result) => `${result.id}: ${result.kind}: ${String(result.detail).split('\n').slice(0, 3).join(' ')}`).join('; ')

// ---- The page, in a browser over a constructed copy of a save ----------------------------------------------------------

const SAVE = { file: 'AuroraDB.db', game: 'Aurelian Empire', race: 'Aurelian Empire', GameID: 140, RaceID: 784 }
const TIMEOUT = 120000

// The world: the fleets of the page are these and no other. Each is a fleet of the save with ships, whose queue is made here.
const WORLD = { A: 460251, B: 460255, C: 460047, D: 460188, E: 460033, F: 460114, G: 460159, H: 460167, I: 460187, J: 460576, K: 460220 }

const all = (db, sql, ...params) => db.query(sql).all(...params)

// A copy of the save in which the fleets of WORLD are the only fleets the page reads: A runs a cycle, B and C run it too (B saved at another rotation, C with a delay on one order), D runs another that two templates of its content name (the first of them with a delay D does not have) and E the same as D with a conditional order whose outcome the save cannot tell, F holds A's cycle closed, I holds it twice, G repeats one order and H none, and K runs a cycle of its own places whose hold never settles.
const constructedWorld = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-route-signatures-'))
  const file = path.join(folder, 'constructed.db')

  fs.copyFileSync(path.join(root, SAVE.file), file)

  const db = new Database(file)
  const ids = Object.values(WORLD)
  const queueOf = (fleet) => all(db, 'select * from FCT_MoveOrders where FleetID = ? order by MoveOrder', fleet)
  const columns = all(db, "select name from pragma_table_info('FCT_MoveOrders')").map((row) => row.name)
  const insert = db.prepare(`insert into FCT_MoveOrders (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`)
  let next = all(db, 'select max(MoveOrderID) as top from FCT_MoveOrders')[0].top
  const sources = {}

  ids.forEach((id) => { sources[id] = queueOf(id) })
  db.run(`update FCT_Fleet set ShippingLine = 1 where GameID = ${SAVE.GameID} and RaceID = ${SAVE.RaceID} and FleetID not in (${ids.join(', ')})`)
  ids.forEach((id) => db.run(`update FCT_Fleet set ShippingLine = 0, CycleMoves = 1 where FleetID = ${id}`))

  // Puts `rows` (another fleet's queue, rotated by `by`, the delay of its first order set to `delay`) in place of the queue of `fleet`.
  const give = (fleet, rows, { by = 0, delay = null, repeat = 1 } = {}) => {
    db.run(`delete from FCT_MoveOrders where FleetID = ${fleet}`)

    const chosen = rotated(rows, by)
    const list = Array.from({ length: repeat }, () => chosen).flat()

    list.forEach((row, index) => {
      const made = { ...row, MoveOrderID: ++next, FleetID: fleet, MoveOrder: index + 1, Arrived: 0, OrderDelayRemaining: 0 }

      if (delay !== null && index === 0) {
        made.OrderDelay = delay
      }

      insert.run(...columns.map((name) => made[name]))
    })
  }

  give(WORLD.B, sources[WORLD.A], { by: 3 })
  give(WORLD.C, sources[WORLD.A], { delay: 3600 })
  give(WORLD.E, sources[WORLD.D])
  give(WORLD.F, sources[WORLD.A])
  give(WORLD.I, sources[WORLD.A], { repeat: 2 })
  give(WORLD.G, sources[WORLD.D].slice(0, 1))

  // K keeps the places of its own queue, which no other fleet runs, with the first order loading one tonne of a mineral, a second order filling the hold with another and the unload taking only the other: the first mineral is never unloaded, so it takes the hold over a tonne a pass and the cycle never settles.
  const [loadRow, ...unloadRows] = sources[WORLD.K]
  const unloadRow = unloadRows.find((row) => row.MoveActionID === 63)

  give(WORLD.K, [{ ...loadRow, MoveActionID: 178, MaxItems: 1, DestinationItemID: 1 }, { ...loadRow, MoveActionID: 178, MaxItems: 0, DestinationItemID: 2 }, ...unloadRows.map((row) => (row === unloadRow ? { ...row, MoveActionID: 179, MaxItems: 0, DestinationItemID: 2 } : row))])
  db.run(`delete from FCT_MoveOrders where FleetID = ${WORLD.H}`)
  db.run(`update FCT_Fleet set CycleMoves = 0 where FleetID in (${WORLD.F}, ${WORLD.I})`)
  db.run(`insert into FCT_FleetConditionalOrder (FleetID, GameID, ConditionalOrderID, ConditionID, Priority, CreateFWP) values (${WORLD.E}, ${SAVE.GameID}, 33, 9, 1, 0)`)
  db.run(`update FCT_MoveOrders set OrderDelayRemaining = 400 where FleetID = ${WORLD.C} and MoveOrder = 1`)

  // Two templates of the cycle of D, one of them saved at another rotation and the other with a delay on one order.
  db.run('delete from FCT_MoveOrderTemplate')
  db.run('delete from FCT_OrderTemplate')

  const templated = (id, name, by, delay = 0) => {
    db.run(`insert into FCT_OrderTemplate (OrderTemplateID, TemplateName, StartSystemID, GameID, RaceID) values (${id}, '${name}', 0, ${SAVE.GameID}, ${SAVE.RaceID})`)
    rotated(sources[WORLD.D], by).forEach((row, index) => db.run('insert into FCT_MoveOrderTemplate (OrderTemplateID, PopulationID, MoveActionID, NewSystemID, Description, OrderDelay, DestinationType, DestinationID, NewJumpPointID, GameID, DestinationItemID, MaxItems, MinQuantity, StartSystemID, MoveIndex, DestinationItemType) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, row.PopulationID, row.MoveActionID, row.NewSystemID, row.Description, index === 0 ? delay : row.OrderDelay, row.DestinationType, row.DestinationID, row.NewWarpPointID, SAVE.GameID, row.DestinationItemID, row.MaxItems, row.MinQuantity, row.StartSystemID, index + 1, row.DestinationItemType]))
  }

  templated(9001, 'Template Zed', 1)
  templated(9002, 'Template Alef', 0, 90)

  const expected = {}

  ids.forEach((id) => {
    const queue = all(db, 'select MoveOrderID, MoveOrder, MoveActionID, Arrived, OrderDelayRemaining from FCT_MoveOrders where FleetID = ? order by MoveOrder', id)
    const [fleet] = all(db, 'select FleetName, CycleMoves from FCT_Fleet where FleetID = ?', id)

    expected[id] = { name: fleet.FleetName, cycle: fleet.CycleMoves, orders: queue.map((row) => row.MoveOrderID), numbers: queue.map((row) => row.MoveOrder), head: queue[0] || null, conditional: all(db, 'select count(*) as c from FCT_FleetConditionalOrder where FleetID = ?', id)[0].c > 0, length: queue.length }
  })

  // The conditional orders whose outcome the save cannot tell: a condition on the tanks is read from the ships' fuel, any other (here, a hostile contact in the system) is not.
  const unread = new Set(all(db, "select distinct FCT_FleetConditionalOrder.FleetID from FCT_FleetConditionalOrder join DIM_Condition on DIM_Condition.ConditionID = FCT_FleetConditionalOrder.ConditionID where DIM_Condition.Description not like 'Fuel:%'").map((row) => row.FleetID))

  ids.forEach((id) => { expected[id].undetermined = unread.has(id) })

  // How the queues that do not repeat are told apart, from the counts of orders: one order repeated is no route, none is empty, the cycle of A once is closed and twice a fixed number of repeats.
  const cycleLength = expected[WORLD.A].length
  const shapeOf = (id) => (expected[id].length === 0 ? 'empty' : expected[id].length === 1 ? 'untraceable' : expected[id].length === cycleLength ? 'closed' : expected[id].length === 2 * cycleLength ? 'finite-repeat' : null)
  const shapes = Object.fromEntries([WORLD.F, WORLD.I, WORLD.G, WORLD.H].map((id) => [id, shapeOf(id)]))

  // The template the page names a route after is the first by name of the templates of its content; it is a match of the pacing when its delays are those of the fleet.
  const delaysOf = (sql, id) => all(db, sql, id).map((row) => row.OrderDelay).sort((a, b) => a - b).join(',')
  const [firstTemplate, ...otherTemplates] = all(db, 'select OrderTemplateID, TemplateName from FCT_OrderTemplate order by TemplateName')
  const templates = { first: firstTemplate.TemplateName, others: otherTemplates.map((row) => row.TemplateName), match: delaysOf('select OrderDelay from FCT_MoveOrderTemplate where OrderTemplateID = ?', firstTemplate.OrderTemplateID) === delaysOf('select OrderDelay from FCT_MoveOrders where FleetID = ?', WORLD.D) ? 'exact' : 'pacing' }

  // The colonies of the desired routes: where a fleet loads and where it unloads, and the words the page lists a colony with.
  const popOf = (fleet, actions) => all(db, `select distinct PopulationID from FCT_MoveOrders where FleetID = ? and MoveActionID in (${actions.join(', ')}) and PopulationID > 0`, fleet).map((row) => row.PopulationID)
  const colonyText = Object.fromEntries(all(db, 'select FCT_Population.PopulationID, FCT_Population.PopName, FCT_RaceSysSurvey.Name as SystemName from FCT_Population left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID where FCT_Population.GameID = ? and FCT_Population.RaceID = ?', SAVE.GameID, SAVE.RaceID).map((row) => [row.PopulationID, row.SystemName ? `${row.PopName} (${row.SystemName})` : row.PopName]))
  const [loadA] = popOf(WORLD.A, [223])
  const [unloadA] = popOf(WORLD.A, [63])
  const [loadD] = popOf(WORLD.D, [223])
  const [unloadD] = popOf(WORLD.D, [63])
  const [loadK] = popOf(WORLD.K, [178])
  const [unloadK] = popOf(WORLD.K, [179])
  const colonies = { A: { from: loadA, to: unloadA }, D: { from: loadD, to: unloadD }, K: { from: loadK, to: unloadK } }
  const colonistOrders = all(db, `select count(*) as c from FCT_MoveOrders where FleetID in (${ids.join(', ')}) and MoveActionID in (4, 6)`)[0].c
  const names = Object.fromEntries(all(db, 'select PopulationID, PopName from FCT_Population where GameID = ? and RaceID = ?', SAVE.GameID, SAVE.RaceID).map((row) => [row.PopulationID, row.PopName]))
  const stops = (fleet) => all(db, 'select distinct PopulationID from FCT_MoveOrders where FleetID = ? and MoveActionID in (223, 63) and PopulationID > 0', fleet).map((row) => row.PopulationID)

  const stopsOfA = stops(WORLD.A)

  db.close()

  return { folder, file, expected, names, stops: { A: stopsOfA }, shapes, templates, colonies, colonyText, colonistOrders }
}

const TREE = { groups: '[data-route-groups]', table: '[data-route-table]' }

const pageLoading = require('./page-loading')

// Waits, each frame, until a condition of the page holds that the operation the check started makes true, and says whether it did within the bound: the verdict is the check's, a fault that keeps it from holding is judged by the values read afterwards, never by this wait timing out.
const EFFECT_WAIT = 10000

const effectDone = (page, step, what, expression) => {
  step(`waiting for ${what}`)

  return page.waitForFunction(expression, null, { timeout: EFFECT_WAIT, polling: 'raf' }).then(() => true, () => false)
}

// Waits until the reads of the page are done (none of its asynchronous reads is updating and no progress bar works: scripts/page-loading.js), which is the completion of what its arrival started.
const readsDone = async (page, step, what) => {
  step(`waiting for the reads of ${what}`)
  await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT, polling: 'raf' })
}

// The ids of the groups the table draws, in its order. Runs in the page.
const groupIdsOf = () => [...document.querySelectorAll('[data-route-groups] [data-route-table] tbody tr [data-route-group]')].map((element) => element.getAttribute('data-route-group'))

// Opens the detail of a group, unless it is open. Runs in the page.
const openGroup = (id) => {
  const row = [...document.querySelectorAll('[data-route-groups] [data-route-table] tbody tr')].find((candidate) => {
    const group = candidate.querySelector('[data-route-group]')

    return Boolean(group) && group.getAttribute('data-route-group') === id
  })
  const expander = row ? row.querySelector('.v-data-table__expand-icon') : null

  if (expander && !expander.classList.contains('v-data-table__expand-icon--active')) {
    expander.click()
  }
}

// Whether the detail of a group is drawn, which is when the opening of it is done. Runs in the page.
const groupOpened = (id) => Boolean(document.querySelector(`[data-route-groups] [data-route-detail="${id}"]`))

// What the panel draws of one group and its open detail: the text of each element its hooks name, and whether it is on screen. Runs in the page.
const readGroup = (id) => {
  const screen = window.__screen
  const entries = (root, attribute) => screen.hooked(root, attribute).filter((entry) => entry.on)
  const texts = (root, attribute) => entries(root, attribute).map((entry) => entry.text)
  const row = [...document.querySelectorAll('[data-route-groups] [data-route-table] tbody tr')].find((candidate) => {
    const group = candidate.querySelector('[data-route-group]')

    return Boolean(group) && group.getAttribute('data-route-group') === id
  })
  const detail = document.querySelector(`[data-route-groups] [data-route-detail="${id}"]`)
  const fleets = detail ? [...detail.querySelectorAll('[data-route-fleet]')] : []

  return {
    id,
    name: texts(row, 'data-route-name'),
    source: texts(row, 'data-route-source'),
    match: texts(row, 'data-route-match'),
    others: texts(row, 'data-route-other').map((text) => text.replace(/^, /, '')),
    status: entries(row, 'data-route-status').map((entry) => ({ key: entry.role, text: entry.text })),
    count: texts(row, 'data-route-fleet-count'),
    capacity: texts(row, 'data-route-capacity'),
    capacityUnknown: entries(row, 'data-route-capacity-unknown').length,
    capacityNotes: texts(row, 'data-route-capacity-note'),
    flags: entries(row, 'data-route-flag').map((entry) => entry.role),
    flagTexts: texts(row, 'data-route-flag'),
    expanded: Boolean(detail),
    fleets: fleets.map((fleet) => ({ id: fleet.getAttribute('data-route-fleet'), names: texts(fleet, 'data-route-fleet-name'), state: fleet.getAttribute('data-route-member-state'), stateText: texts(fleet, 'data-route-member-text'), orders: entries(fleet, 'data-route-order').map((entry) => entry.role), orderNumbers: texts(fleet, 'data-route-order-number'), orderIds: texts(fleet, 'data-route-order-id'), shown: screen.visible(fleet) })),
    related: detail ? entries(detail, 'data-route-relation').length : 0,
    relationLabels: detail ? texts(detail, 'data-route-relation-label') : [],
    relationNames: detail ? texts(detail, 'data-route-relation-name') : [],
    variants: detail ? entries(detail, 'data-route-variants').length : 0,
    conditionalStatus: detail ? texts(detail, 'data-route-conditional-status') : [],
  }
}

// What the panel draws of the queues that do not repeat, and of its own state. Runs in the page.
const readQueues = () => {
  const screen = window.__screen
  const panel = document.querySelector('[data-route-groups]')
  const entries = (root, attribute) => screen.hooked(root, attribute).filter((entry) => entry.on)
  const texts = (root, attribute) => entries(root, attribute).map((entry) => entry.text)
  const listed = (attribute) => [...panel.querySelectorAll(`[${attribute}]`)].filter((element) => screen.visible(element)).map((element) => ({ id: element.getAttribute(attribute), names: texts(element, 'data-route-fleet-name'), shapes: texts(element, 'data-route-shape'), orders: entries(element, 'data-route-order').map((entry) => entry.role), orderNumbers: texts(element, 'data-route-order-number'), orderIds: texts(element, 'data-route-order-id') }))

  return { closed: listed('data-route-closed-fleet'), broken: listed('data-route-broken-fleet'), closedNone: entries(panel, 'data-route-closed-none').length, unsupported: entries(panel, 'data-route-unsupported').length, count: texts(panel, 'data-route-count') }
}

// The ids of the groups the panel draws now. Runs in the page.
const groupsShown = () => window.__screen.hooked(document.querySelector('[data-route-groups]'), 'data-route-group').filter((entry) => entry.on).map((entry) => entry.role)

// The groups, each opened in turn and read once its detail is drawn, and the queues that do not repeat.
const readGroups = async (page, step) => {
  const groups = []

  for (const id of await page.evaluate(groupIdsOf)) {
    step(`opening the group ${id}`)
    await page.evaluate(openGroup, id)
    await effectDone(page, step, `the detail of the group ${id}`, `(${groupOpened})(${JSON.stringify(id)})`)
    await readsDone(page, step, `the group ${id}`)
    groups.push(await page.evaluate(readGroup, id))
  }

  return { groups, ...(await page.evaluate(readQueues)) }
}

// The table above the panel: each fleet of the page with the freight it moves in a year, as the page writes it. Runs in the page.
const readFleetTable = () => {
  const screen = window.__screen
  const rows = [...document.querySelectorAll('[data-hauling-routes] tbody tr')].filter((row) => row.querySelector('[data-fleet-name]'))

  return rows.map((row) => ({ name: screen.visibleText(row.querySelector('[data-fleet-name]')), moved: screen.hooked(row, 'data-haul').filter((entry) => entry.role === 'moved' && entry.on).map((entry) => entry.text) }))
}

// Opens the detail of a fleet of the table above the panel, unless it is open. Runs in the page.
const openFleet = (name) => {
  const row = [...document.querySelectorAll('[data-hauling-routes] tbody tr')].find((candidate) => {
    const element = candidate.querySelector('[data-fleet-name]')

    return Boolean(element) && window.__screen.visibleText(element).startsWith(name)
  })
  const expander = row && row.querySelector('.v-data-table__expand-icon')

  if (expander && !expander.classList.contains('v-data-table__expand-icon--active')) {
    expander.click()
  }
}

// Whether the detail of a fleet of the table is drawn, which is when the opening of it is done: the row after its row is the expanded one. Runs in the page.
const fleetOpened = (name) => {
  const row = [...document.querySelectorAll('[data-hauling-routes] tbody tr')].find((candidate) => {
    const element = candidate.querySelector('[data-fleet-name]')

    return Boolean(element) && window.__screen.visibleText(element).startsWith(name)
  })

  return Boolean(row && row.nextElementSibling && row.nextElementSibling.classList.contains('v-data-table__expanded__content'))
}

// What the detail of a fleet of the table draws of the cargo of its cycle, by the hooks of the template. Runs in the page.
const readFleetDetail = (name) => {
  const screen = window.__screen
  const row = [...document.querySelectorAll('[data-hauling-routes] tbody tr')].find((candidate) => {
    const element = candidate.querySelector('[data-fleet-name]')

    return Boolean(element) && screen.visibleText(element).startsWith(name)
  })
  const detail = row ? row.nextElementSibling : null
  const hooked = (attribute) => (detail ? screen.hooked(detail, attribute).filter((entry) => entry.on) : [])

  return { name, opened: Boolean(detail && detail.querySelector('[data-cycle-parts], [data-cargo-unsettled], [data-handling-breakdown]')), unsettled: hooked('data-cargo-unsettled').map((entry) => entry.text), breakdown: hooked('data-handling-breakdown').length, share: hooked('data-hold-share').length, cycle: hooked('data-cycle-parts').length }
}

// The details of the fleets named, each opened in turn and read once its detail is drawn.
const readCargo = async (page, step, names) => {
  const found = []

  for (const name of names) {
    step(`opening the detail of ${name}`)
    await page.evaluate(openFleet, name)
    await effectDone(page, step, `the detail of ${name}`, `(${fleetOpened})(${JSON.stringify(name)})`)
    await readsDone(page, step, `the detail of ${name}`)
    found.push(await page.evaluate(readFleetDetail, name))
  }

  return found
}

const UNITS = { bn: [1e9, 1e7 / 2], M: [1e6, 1e4 / 2], k: [1e3, 50] }

// The tonnes (and the least they can be off by) of a freight text of the table, as "1.2 M t minerals, 40 k t installations".
const tonnesOf = (text) => text.split(', ').reduce((sum, part) => {
  const match = /^(\d+(?:\.\d+)?)(?: (bn|M|k))? t (?:minerals|installations)$/.exec(part)

  assert.ok(match, `the freight text "${text}" holds "${part}", which is not a figure of tonnes`)

  const [scale, error] = match[2] ? UNITS[match[2]] : [1, 0.5]

  return { tonnes: sum.tonnes + Number(match[1]) * scale, error: sum.error + error }
}, { tonnes: 0, error: 0 })

// The app, opened (or opened again after a reload) with the game picked, at the Hauling page.
const arrive = async (page, step, url, { reload = false } = {}) => {
  const { installScreen } = require('./lib/browser-observe')

  if (reload) {
    step('reloading the page')
    await page.reload({ timeout: TIMEOUT })
  } else {
    step('opening the app')
    await installScreen(page)
    await page.goto(url, { timeout: TIMEOUT })
  }

  await page.waitForFunction(() => Boolean(window.$app && window.$app.$store), null, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${SAVE.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    await picker.getByText(SAVE.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID), null, { timeout: TIMEOUT })
  step('opening Hauling')
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/hauling')
  await page.waitForFunction(pageLoading.arrived, '/hauling', { timeout: TIMEOUT })
}

const open = async (browser, url, world) => {
  const { observe } = require('./lib/browser-observe')

  return observe(browser, async ({ page, step }) => {
    await arrive(page, step, url)
    step('waiting for the groups and the fleets of the table')
    await page.waitForSelector(`${TREE.groups} ${TREE.table} [data-route-group]`, { state: 'attached', timeout: TIMEOUT })
    await page.waitForFunction((names) => {
      const rows = [...document.querySelectorAll('[data-hauling-routes] [data-fleet-name]')].map((element) => element.textContent.trim())

      return names.every((name) => rows.some((row) => row.startsWith(name)))
    }, world.capableNames, { timeout: TIMEOUT })
    await readsDone(page, step, 'the page')
    step('reading the groups')

    const grouped = await readGroups(page, step)
    const table = await page.evaluate(readFleetTable)
    const cargo = await readCargo(page, step, [world.expected[WORLD.K].name, world.expected[WORLD.A].name])
    const grouping = await page.evaluate(() => window.$app.$store.getters.config.get('selectedSeparator', 'Tick'))
    const shownAll = await page.evaluate(groupsShown)

    step('showing the flagged routes only')
    await page.locator('[data-route-groups] input[data-route-flagged]').click({ force: true, timeout: 20000 })

    const switched = await page.waitForFunction(() => document.querySelector('[data-route-groups] input[data-route-flagged]').checked, null, { timeout: 20000 }).then(() => true, () => false)

    await effectDone(page, step, 'the switch of the flagged routes', "document.querySelector('[data-route-groups] input[data-route-flagged]').getAttribute('aria-checked') === 'true'")
    await readsDone(page, step, 'the flagged routes')

    const shownFlagged = await page.evaluate(groupsShown)

    return { ...grouped, table, cargo, grouping, shownAll, shownFlagged, switched }
  })
}

const browserChecks = []
const addBrowser = (id, name, run) => browserChecks.push({ id, name, run })

const byFleet = (seen) => {
  const owner = new Map()

  seen.groups.forEach((group) => group.fleets.forEach((fleet) => owner.set(Number(fleet.id), group)))

  return (key) => owner.get(WORLD[key]) || null
}

const setOf = (group) => (group ? group.fleets.map((fleet) => Number(fleet.id)).sort((a, b) => a - b) : [])

const idsOf = (...keys) => keys.map((key) => WORLD[key]).sort((a, b) => a - b)

const capableOf = (seen, world, key) => {
  const row = seen.table.find((entry) => entry.name.startsWith(world.expected[WORLD[key]].name))

  return Boolean(row && row.moved.length)
}

addBrowser('screen-groups', 'the groups drawn are the fleets that run one route: the cycle at three rotations and pacings once, the same route with a conditional order apart, no queue that does not repeat among them', ({ seen, world }) => {
  const owner = byFleet(seen, world)

  assert.deepEqual(seen.groups.map((group) => setOf(group)).sort((a, b) => a[0] - b[0]), [idsOf('A', 'B', 'C'), idsOf('D'), idsOf('E'), idsOf('J'), idsOf('K')].sort((a, b) => a[0] - b[0]), 'the fleets of each group')
  assert.equal(owner('F'), null, 'a closed queue is on no route')
  assert.equal(owner('I'), null, 'a queue that repeats a fixed number of times is on no route')
  assert.equal(owner('G'), null, 'a fleet that repeats one order is on no route')
  assert.equal(owner('H'), null, 'a fleet that repeats none is on no route')
  assert.deepEqual(seen.groups.map((group) => group.count.map((text) => Number(text))).sort((a, b) => a[0] - b[0]), [[1], [1], [1], [1], [3]], 'the count of fleets each row states')
  assert.ok(seen.groups.every((group) => group.expanded), 'each group opens to list its fleets')
})

// A whole number drawn as a figure: read whole and signed, never matched to a wording.
const wholeOf = (text, what) => {
  const { readFigure } = require('./lib/browser-observe')
  const value = readFigure(text, 'None')

  assert.ok(value !== null && Number.isInteger(value), `${what} is drawn as "${text}", not as a whole number`)

  return value
}

// The stored orders a fleet or a queue draws, as [number, id], read from the number and the id it draws for each.
const pairsOf = (entry) => {
  assert.equal(entry.orderNumbers.length, entry.orderIds.length, `a number and an id are drawn for each stored order of ${entry.id}`)

  return entry.orderNumbers.map((number, at) => [wholeOf(number, 'the number of a stored order'), wholeOf(entry.orderIds[at], 'the id of a stored order')])
}

const expectedPairs = (world, id) => world.expected[id].numbers.map((number, at) => [number, world.expected[id].orders[at]])

// The one entry of a table of words whose wording is `text`.
const keyOfText = (words, text, what) => {
  const found = Object.entries(words).filter(([, wording]) => wording === text).map(([key]) => key)

  assert.equal(found.length, 1, `${what} "${text}" is the wording of one entry of the table of words`)

  return found[0]
}

// Whether a fleet waits at a stock that no delay holds: the first order of its queue as the save has it.
const stalledOf = (world, key) => {
  const { head } = world.expected[WORLD[key]]

  return Boolean(head && head.Arrived && [223, 180].includes(head.MoveActionID) && !head.OrderDelayRemaining)
}

addBrowser('screen-links', 'every fleet of a group names its stored orders, all of them and in the order they are stored', ({ seen, world }) => {
  seen.groups.forEach((group) => group.fleets.forEach((fleet) => assert.deepEqual(fleet.orders.map(Number), world.expected[Number(fleet.id)].orders, `the stored orders listed for fleet ${fleet.id}`)))
  seen.groups.forEach((group) => group.fleets.forEach((fleet) => assert.deepEqual(pairsOf(fleet), expectedPairs(world, Number(fleet.id)), `the stored orders drawn for fleet ${fleet.id}: their number and id`)))
  seen.groups.forEach((group) => group.fleets.forEach((fleet) => assert.deepEqual(fleet.names, [world.expected[Number(fleet.id)].name], `the name drawn for fleet ${fleet.id}`)))
})

addBrowser('screen-filter', 'the switch of the flagged routes keeps the groups that show a flag or are not served, and nothing else', ({ seen }) => {
  const attention = (group) => group.flags.length > 0 || group.status[0].key !== 'capable'

  assert.equal(seen.switched, true, 'the switch is on once it is clicked')
  assert.deepEqual([...seen.shownAll].sort(), seen.groups.map((group) => group.id).sort(), 'every group is drawn before the switch')
  assert.ok(seen.groups.some((group) => !attention(group)), `one group shows no flag and is served: ${JSON.stringify(seen.groups.map((group) => [group.flags, group.status[0].key, group.fleets.map((fleet) => fleet.state)]))}`)
  assert.deepEqual([...seen.shownFlagged].sort(), seen.groups.filter(attention).map((group) => group.id).sort(), 'the groups drawn after the switch')
})

addBrowser('screen-capacity', 'the capacity of a group is the yearly freight of its capable fleets whose conditional outcome is known, taken from the table above and summed once, and a group with none says so and says what it left out', ({ seen, world, labels }) => {
  const grouping = ['Tick', 'Comma', 'Dash', 'Space', 'None'].includes(seen.grouping) ? seen.grouping : 'Tick'
  const { readFigure } = require('./lib/browser-observe')
  const owner = byFleet(seen, world)

  for (const key of ['A', 'D', 'E', 'J', 'K']) {
    const group = owner(key)
    const capable = Object.keys(WORLD).filter((other) => owner(other) === group && capableOf(seen, world, other))
    const settled = capable.filter((other) => !world.expected[WORLD[other]].undetermined)
    const expected = settled.reduce((sum, other) => {
      const row = seen.table.find((entry) => entry.name.startsWith(world.expected[WORLD[other]].name))
      const part = tonnesOf(row.moved.join(', '))

      return { tonnes: sum.tonnes + part.tonnes, error: sum.error + part.error }
    }, { tonnes: 0, error: 0 })

    if (!settled.length) {
      assert.equal(group.capacity.length, 0, `the capacity of the group of ${key}: no fleet whose outcome is known, no figure`)
      assert.equal(group.capacityUnknown, 1, `the group of ${key} says its capacity is not known`)
    } else {
      assert.equal(group.capacity.length, 1, `the capacity of the group of ${key} is drawn once`)

      const drawn = readFigure(group.capacity[0].replace(/ t\/yr$/, ''), grouping)

      assert.ok(drawn !== null, `the capacity of the group of ${key} reads as a figure: ${group.capacity[0]}`)
      assert.ok(Math.abs(drawn - expected.tonnes) <= expected.error + 1, `the capacity of the group of ${key} is ${drawn}, the table's ${settled.length} fleet(s) of a known outcome sum to ${expected.tonnes} (within ${expected.error})`)
    }

    assert.deepEqual(group.capacityNotes, capable.length > settled.length ? [labels.CAPACITY_NOTES.undetermined] : [], `the note of the fleets left out of the capacity of the group of ${key}`)
  }

  assert.equal(world.expected[WORLD.E].undetermined, true, 'the conditional order of E is one the save cannot settle')
  assert.equal(capableOf(seen, world, 'E'), true, 'E has a figure in the table, so the capacity it leaves out is one it has')
})

addBrowser('screen-state', 'each fleet of a group is told capable exactly where the table above gives it a figure, and each group status reads from its fleets', ({ seen, world, labels }) => {
  const owner = byFleet(seen, world)

  seen.groups.forEach((group) => {
    group.fleets.forEach((fleet) => assert.equal(fleet.state === 'capable', capableOf(seen, world, Object.keys(WORLD).find((key) => WORLD[key] === Number(fleet.id))), `the state of fleet ${fleet.id} (${fleet.state})`))
    assert.ok(Object.keys(labels.STATES).includes(group.fleets[0].state), 'the state of a fleet is one the page names')
    group.fleets.forEach((fleet) => assert.deepEqual(fleet.stateText, [labels.STATES[fleet.state]], `the words of the state of fleet ${fleet.id}`))
    assert.equal(group.status.length, 1, 'one status is drawn for each group')
    assert.equal(group.status[0].text, labels.GROUP_STATUSES[group.status[0].key], `the words of the status ${group.status[0].key}`)
  })

  for (const key of ['A', 'D', 'E', 'J', 'K']) {
    const group = owner(key)
    const capable = Object.keys(WORLD).filter((other) => owner(other) === group && capableOf(seen, world, other))
    const settled = capable.filter((other) => !world.expected[WORLD[other]].undetermined)
    const moving = settled.filter((other) => !stalledOf(world, other))
    const expected = moving.length ? 'capable' : settled.length ? 'paused' : capable.length ? 'conditional' : group.fleets.some((fleet) => fleet.state === 'unknown') ? 'unknown' : 'incapable'

    assert.equal(group.status[0].key, expected, `the status of the group of ${key}`)
    assert.equal(keyOfText(labels.GROUP_STATUSES, group.status[0].text, `the status drawn for the group of ${key}`), expected, `the words of the status of the group of ${key} are those of ${expected}`)
  }
})

addBrowser('screen-flags', 'a group is flagged duplicated when two of its fleets are capable, at another pacing when they differ in it, conditional when a fleet has conditional orders, and related routes are listed', ({ seen, world, labels }) => {
  const owner = byFleet(seen, world)

  for (const key of ['A', 'D', 'E', 'J']) {
    const group = owner(key)
    const members = Object.keys(WORLD).filter((other) => owner(other) === group)
    const capable = members.filter((other) => capableOf(seen, world, other))
    const head = (other) => world.expected[WORLD[other]].head
    const timed = (other) => Boolean(head(other) && head(other).OrderDelayRemaining > 0)

    assert.equal(group.flags.includes('duplicate'), capable.length > 1, `the duplicate flag of the group of ${key}`)
    assert.equal(group.flags.includes('conditional'), members.some((other) => world.expected[WORLD[other]].conditional), `the conditional flag of the group of ${key}`)
    assert.equal(group.flags.includes('stalled'), members.some((other) => stalledOf(world, other)), `the flag of a wait at a stock of the group of ${key}`)
    assert.equal(group.flags.includes('timer'), members.some(timed), `the flag of a wait on a timer of the group of ${key}`)
  }

  const a = owner('A')
  const capableA = ['A', 'B', 'C'].filter((key) => capableOf(seen, world, key))
  const kindsOf = (group) => group.relationLabels.map((label) => keyOfText(labels.RELATIONS, label, 'the relation drawn'))

  assert.equal(a.flags.includes('pacing'), capableA.includes('C') && capableA.length > 1, 'the flag of fleets at another pacing')
  assert.equal(a.variants, 1, 'the sub-groups of the delay are told under the group')
  assert.deepEqual(kindsOf(owner('D')), ['same-route-conditions'], 'the route of D lists the route of E as the same with other conditional orders')
  assert.deepEqual(kindsOf(owner('E')), ['same-route-conditions'], 'and the other way round')
  assert.deepEqual(owner('D').relationNames, owner('E').name, 'the route of D names the route of E by the name drawn for it')
  assert.deepEqual(owner('E').relationNames, owner('D').name, 'and the other way round')
  assert.ok(owner('E').conditionalStatus.length > 0 && owner('E').conditionalStatus.every((text) => text === labels.CONDITION_STATUSES.unresolvable), 'the conditional order of E is told as one whose outcome cannot be read from the save')
  assert.ok(owner('D').conditionalStatus.length > 0 && owner('D').conditionalStatus.every((text) => text === labels.CONDITION_STATUSES.none), 'the route of D has no conditional order')

  seen.groups.forEach((group) => {
    const unfit = group.fleets.filter((fleet) => ['empty', 'incompatible', 'immobile'].includes(fleet.state)).length

    assert.equal(group.flags.includes('unfit'), unfit > 0, `the flag of the unfit fleets of group ${group.id}`)
    assert.equal(group.flagTexts.length, group.flags.length, 'every flag is drawn once')
    group.flags.forEach((key, at) => assert.equal(group.flagTexts[at], key === 'unfit' ? `${unfit} ${labels.FLAGS.unfit}` : labels.FLAGS[key], `the words of the flag ${key}`))
    assert.equal(group.relationLabels.length, group.related, 'every related route is drawn with its words')
    assert.equal(group.relationNames.length, group.related, 'every related route is drawn with its name')
  })
})

addBrowser('screen-names', 'a route is named by its template (every matching template listed) or its fleets, with where the name came from beside it, and how the first template matches in the words of its table', ({ seen, world, labels }) => {
  const owner = byFleet(seen, world)
  const d = owner('D')
  const e = owner('E')
  const a = owner('A')
  const matched = [labels.MATCHES[world.templates.match]]

  assert.deepEqual([d.name, d.source, d.others], [[world.templates.first], [labels.NAME_SOURCES.template], world.templates.others], 'the route that two templates match')
  assert.deepEqual([e.name, e.source, e.others], [[world.templates.first], [labels.NAME_SOURCES.template], world.templates.others], 'the same content with a conditional order is a match too')
  assert.deepEqual([d.match, e.match], [matched, matched], 'how the first template matches: the content, and its pacing against the fleets\' own')
  assert.equal(world.templates.match, 'pacing', 'the first template of the world has a delay D does not have')
  assert.deepEqual(a.match, [], 'no template is named for a route no template matches')
  assert.ok([labels.NAME_SOURCES.generated, labels.NAME_SOURCES.fleet].includes(a.source[0]), 'a route of three fleets is named by its colonies or by a fleet')

  const names = Object.keys(WORLD).filter((key) => owner(key) === a).map((key) => world.expected[WORLD[key]].name)

  if (a.source[0] === labels.NAME_SOURCES.generated) {
    assert.ok(world.stops.A.every((colony) => a.name[0].includes(world.names[colony])), `the name ${a.name[0]} names the colonies it runs between`)
  } else {
    assert.ok(names.includes(a.name[0]), 'a fleet\'s name')
  }
})

addBrowser('screen-unsettled', 'the detail of a fleet whose cargo never settles says so in the words of the page and draws no trip load, hold share, cycle time or handling, and the detail of a fleet whose cargo settles draws its handling', ({ seen, world, labels }) => {
  const [unsettled, settled] = seen.cargo

  assert.deepEqual([unsettled.opened, settled.opened], [true, true], 'the detail of both fleets is opened')
  assert.deepEqual([unsettled.unsettled, unsettled.breakdown, unsettled.share, unsettled.cycle], [[labels.CARGO_UNSETTLED], 0, 0, 0], `the detail of ${world.expected[WORLD.K].name}, whose first mineral is never unloaded`)
  assert.deepEqual([settled.unsettled, settled.breakdown], [[], 1], `the detail of ${world.expected[WORLD.A].name}`)
})

addBrowser('screen-closed', 'the queues that close but do not repeat are listed apart with their stored orders and the words of their shape, never in a group; the fleets set to repeat that cannot are named', ({ seen, world, labels }) => {
  const shown = (list) => list.map((entry) => [Number(entry.id), entry.shapes]).sort((a, b) => a[0] - b[0])
  const wording = (key) => [WORLD[key], [labels.SHAPES[world.shapes[WORLD[key]]]]]

  assert.deepEqual([WORLD.F, WORLD.I, WORLD.G, WORLD.H].map((id) => world.shapes[id]), ['closed', 'finite-repeat', 'untraceable', 'empty'], 'the shapes of the queues of the world, from their number of orders')
  assert.deepEqual(shown(seen.closed), [wording('F'), wording('I')].sort((a, b) => a[0] - b[0]), 'the queues that do not repeat, in the words of their shape')
  seen.closed.forEach((entry) => assert.deepEqual(entry.orders.map(Number), world.expected[Number(entry.id)].orders, `the stored orders of the closed queue of fleet ${entry.id}`))
  seen.closed.forEach((entry) => assert.deepEqual(pairsOf(entry), expectedPairs(world, Number(entry.id)), `the stored orders drawn for the closed queue of fleet ${entry.id}`))
  seen.closed.forEach((entry) => assert.deepEqual(entry.names, [world.expected[Number(entry.id)].name], `the name drawn for the closed queue of fleet ${entry.id}`))
  seen.broken.forEach((entry) => assert.deepEqual(entry.names, [world.expected[Number(entry.id)].name], `the name drawn for the broken queue of fleet ${entry.id}`))
  seen.broken.forEach((entry) => assert.deepEqual(pairsOf(entry), expectedPairs(world, Number(entry.id)), `the stored orders drawn for the broken queue of fleet ${entry.id}: their number and id`))
  assert.equal(seen.closedNone, 0, 'the note that none is closed is not drawn')
  assert.deepEqual(shown(seen.broken), [wording('G'), wording('H')].sort((a, b) => a[0] - b[0]), 'the fleets set to repeat that are not on a route, in the words of their shape')
  assert.ok(seen.groups.every((group) => group.fleets.every((fleet) => ![WORLD.F, WORLD.I, WORLD.G, WORLD.H].includes(Number(fleet.id)))), 'none of them is in a group')
})

// The page's own words, loaded from the modules of the sources the browser serves.
const wordsOf = async () => {
  const loaded = await loadUtilities(['route-signatures', 'hauling'], { stubs: STUBS })
  const { STATES, GROUP_STATUSES, NAME_SOURCES, FLAGS, RELATIONS, MATCHES, SHAPES, CAPACITY_NOTES, COVERAGE, CARGO_KINDS, CARGO_UNITS, CONDITION_STATUSES, DESIRE_DEMAND_NONE } = loaded['route-signatures']

  return { STATES, GROUP_STATUSES, NAME_SOURCES, FLAGS, RELATIONS, MATCHES, SHAPES, CAPACITY_NOTES, COVERAGE, CARGO_KINDS, CARGO_UNITS, CONDITION_STATUSES, DESIRE_DEMAND_NONE, CARGO_UNSETTLED: loaded.hauling.CARGO_UNSETTLED }
}

// ---- The desired routes: made, changed, reloaded and deleted in the page ---------------------------------------------------

// What the panel of the desired routes draws and the records the browser keeps. Runs in the page.
const readDesires = () => {
  const screen = window.__screen
  const panel = document.querySelector('[data-route-desires]')
  const entries = (root, attribute) => screen.hooked(root, attribute).filter((entry) => entry.on)
  const texts = (root, attribute) => entries(root, attribute).map((entry) => entry.text)
  const rows = [...panel.querySelectorAll('[data-desire-row]')].filter((element) => screen.visible(element)).map((element) => {
    const row = element.closest('tr')

    return {
      key: element.getAttribute('data-desire-row'),
      name: texts(row, 'data-desire-name-text'),
      from: texts(row, 'data-desire-from-text'),
      to: texts(row, 'data-desire-to-text'),
      cargo: texts(row, 'data-desire-cargo-text'),
      note: texts(row, 'data-desire-note-text'),
      state: texts(row, 'data-desire-state-text'),
      stateKey: entries(row, 'data-desire-state-value').map((entry) => entry.role),
      capacity: texts(row, 'data-desire-capacity'),
      delivered: texts(row, 'data-desire-delivered'),
      deliveredUnit: texts(row, 'data-desire-delivered-unit'),
      demand: texts(row, 'data-desire-demand'),
      demandUnit: texts(row, 'data-desire-demand-unit'),
      demandNone: texts(row, 'data-desire-demand-none'),
      gap: texts(row, 'data-desire-gap'),
      gapUnit: texts(row, 'data-desire-gap-unit'),
    }
  })

  return {
    waiting: entries(panel, 'data-desire-waiting').length,
    errors: entries(panel, 'data-desire-error').length,
    newButton: entries(panel, 'data-desire-new').length,
    form: entries(panel, 'data-desire-form').length,
    messages: texts(panel, 'data-desire-message'),
    count: texts(panel, 'data-desire-count-number'),
    rows,
  }
}

// The desired routes the browser keeps in its storage, as the records are stored: the payload of each and the identities of the deleted. Runs in the page.
const readStored = () => {
  const records = []
  const tombstones = []

  Object.keys(localStorage).filter((key) => key.includes('campaign-')).forEach((key) => {
    const file = JSON.parse(localStorage.getItem(key))

    Object.values(file.records || {}).filter((record) => record.kind === 'route.desire').forEach((record) => records.push({ uuid: record.uuid, revision: record.revision, name: record.payload.name, cargo: record.payload.cargo, yearly: record.payload.yearly, note: record.payload.note, from: record.payload.from.id, to: record.payload.to.id }))
    Object.keys(file.tombstones || {}).forEach((uuid) => tombstones.push(uuid))
  })

  return { records: records.sort((a, b) => (a.name < b.name ? -1 : 1)), tombstones: tombstones.sort() }
}

// The condition of a wait polled every frame in the page, for the write the check started: the record is in the browser's storage (`named`) or one more identity is kept as deleted (`tombstones`), and the panel draws exactly the routes that are kept (unless `drawn` is false), with no form open and no read of the page running.
const keptExpression = (effect) => `(() => {
  const stored = (${readStored})()
  const effect = ${JSON.stringify(effect)}
  const names = (list) => list.map((name) => String(name).trim()).sort().join('|')
  const drawn = [...document.querySelectorAll('[data-route-desires] [data-desire-row] [data-desire-name-text]')].map((element) => element.textContent)
  const written = effect.named === undefined || stored.records.some((record) => record.name === effect.named)
  const deleted = effect.tombstones === undefined || stored.tombstones.length >= effect.tombstones
  const shown = effect.drawn === false || names(drawn) === names(stored.records.map((record) => record.name))

  return written && deleted && shown && !document.querySelector('[data-route-desires] [data-desire-form]') && !(${pageLoading})()
})()`

// The panel of the desired routes once the write the check started is kept and drawn (`completed` says whether it was), with what is kept.
const stageOf = async (page, step, what, effect = {}) => {
  const completed = await effectDone(page, step, `the panel to draw ${what}`, keptExpression(effect))

  return { ...(await page.evaluate(readDesires)), stored: await page.evaluate(readStored), completed }
}

const FORM_WAIT = 20000

const pickColony = async (page, field, text) => {
  await page.locator(`input[data-desire-${field}]`).click({ timeout: FORM_WAIT })
  await page.locator(`input[data-desire-${field}]`).fill(text, { timeout: FORM_WAIT })
  await page.locator('.menuable__content__active').getByText(text, { exact: true }).first().click({ timeout: FORM_WAIT })
}

const pickCargo = async (page, text) => {
  await page.locator('.v-select__slot').filter({ has: page.locator('input[data-desire-cargo]') }).click({ timeout: FORM_WAIT })
  await page.locator('.menuable__content__active').getByText(text, { exact: true }).first().click({ timeout: FORM_WAIT })
}

// Presses "keep" and says whether the form closed and the record is kept (it is when the form was filled in), never failing on it: the check judges the value.
const keep = async (page, step, what) => {
  step(`keeping ${what}`)
  await page.locator('[data-desire-save]').click({ timeout: FORM_WAIT })

  const closed = await page.waitForFunction(() => !document.querySelector('[data-desire-form]'), null, { timeout: EFFECT_WAIT, polling: 'raf' }).then(() => true, () => false)
  const written = await effectDone(page, step, `${what} to be kept`, keptExpression({ named: what, drawn: false }))

  return closed && written
}

const desireRowOf = (page, name) => page.locator('[data-route-desires] tr').filter({ has: page.locator('[data-desire-name-text]', { hasText: name }) })

const WANTED = [
  { name: 'Ore from Veles', route: 'A', cargo: 'minerals', yearly: 1e9, serving: ['A', 'B', 'C'], open: [], unknown: false },
  { name: 'Ore met from Veles', route: 'A', cargo: 'minerals', yearly: 1, serving: ['A', 'B', 'C'], open: [], unknown: false },
  { name: 'Ore from Lyrenia', route: 'D', cargo: 'minerals', yearly: 1e9, serving: ['D'], open: ['E'], unknown: false },
  { name: 'Settlers to Aurelia', route: 'A', cargo: 'colonists', yearly: 500, serving: [], open: [], unknown: false },
  { name: 'Ore from Elysium', route: 'K', cargo: 'minerals', yearly: 100, serving: [], open: [], unknown: true },
  { name: 'Ore for Aurelia, no demand', route: 'A', cargo: 'minerals', yearly: null, serving: ['A', 'B', 'C'], open: [], unknown: false },
]
const EDITED = { name: 'Ore from Veles, renamed', yearly: 2e9 }
const REMOVED = 'Settlers to Aurelia'
// The routes the refresh flow keeps: two the fleets of the world cover.
const REFRESHED = WANTED.slice(0, 2)

const openDesires = async (browser, url, world, labels, refresh = false) => {
  const { observe } = require('./lib/browser-observe')

  return observe(browser, async ({ page, step }) => {
    // The reads of the stored orders wait here while `holding.on` is set, until the check lets them go; only the refresh flow intercepts the database calls.
    const holding = { on: false, routes: [], arrived: null, resolve: null }
    await arrive(page, step, url)
    step('waiting for the desired routes')
    await page.waitForSelector('[data-route-desires] [data-desire-new]', { state: 'attached', timeout: TIMEOUT })
    await page.waitForFunction((names) => {
      const rows = [...document.querySelectorAll('[data-hauling-routes] [data-fleet-name]')].map((element) => element.textContent.trim())

      return names.every((name) => rows.some((row) => row.startsWith(name)))
    }, world.capableNames, { timeout: TIMEOUT })
    await readsDone(page, step, 'the page')

    const grouping = await page.evaluate(() => window.$app.$store.getters.config.get('selectedSeparator', 'Tick'))
    const stages = { empty: await stageOf(page, step, 'the empty panel') }
    const created = []
    const wanted = refresh ? REFRESHED : WANTED

    // What the flow returns when a step it needs is not offered: the stages read so far and why it stopped, judged by the checks as values.
    const ended = async (aborted, changed = null) => ({ table: await page.evaluate(readFleetTable), grouping, stages, created, changed, aborted })

    if (stages.empty.newButton !== 1) {
      return ended('the panel offers no way to make a route')
    }

    for (const want of wanted) {
      step(`making ${want.name}`)
      await page.locator('[data-desire-new]').click({ timeout: FORM_WAIT })
      await page.waitForSelector('[data-desire-form]', { state: 'attached', timeout: FORM_WAIT })
      await page.locator('input[data-desire-name]').fill(want.name, { timeout: FORM_WAIT })
      await pickColony(page, 'from', world.colonyText[world.colonies[want.route].from])
      await pickColony(page, 'to', world.colonyText[world.colonies[want.route].to])

      if (want.cargo !== 'minerals') {
        await pickCargo(page, labels.CARGO_KINDS[want.cargo])
      }

      if (want.yearly !== null) {
        await page.locator('input[data-desire-yearly]').fill(String(want.yearly), { timeout: FORM_WAIT })
      }

      created.push({ name: want.name, closed: await keep(page, step, want.name) })
    }

    stages.created = await stageOf(page, step, 'the kept routes', { named: wanted[wanted.length - 1].name })

    // The save renewed with the read of its stored orders held back, as when the save is read again (the new copy has no kept reads): the page keeps the orders of the read before while it waits, and what the panel draws meanwhile is judged.
    if (refresh) {
      step('renewing the save, the read of the stored orders held back')
      await page.route('**/__aurora-db/query', async (route) => {
        if (holding.on && /ConditionName/.test(route.request().postData() || '')) {
          holding.routes.push(route)
          holding.resolve()
        } else {
          await route.continue()
        }
      })
      holding.arrived = new Promise((resolve) => { holding.resolve = resolve })
      holding.on = true
      await page.evaluate(() => { window.$app.$store.dispatch('renew', { storagePath: window.$app.$store.state.databasePath }) })

      let timer = null
      const asked = await Promise.race([holding.arrived.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), EFFECT_WAIT) })])

      clearTimeout(timer)

      const drawn = await effectDone(page, step, 'the panel to draw the routes while the saved orders are read', `(() => { const vm = window.$app.$route.matched[0].instances.default; return vm.loadErrors.routeQueues === undefined && vm.loadErrors.desireObjects === null && document.querySelectorAll('[data-route-desires] [data-desire-row]').length === ${wanted.length} })()`)

      stages.refreshing = { ...(await page.evaluate(readDesires)), asked, pending: drawn && await page.evaluate(() => window.$app.$route.matched[0].instances.default.loadErrors.routeQueues === undefined) }
      holding.on = false

      for (const route of holding.routes.splice(0)) {
        await route.continue()
      }

      stages.refreshed = await stageOf(page, step, 'the panel once the saved orders are read again')

      return ended(null)
    }

    const edited = EDITED.name

    // A panel that did not draw the routes it kept (the stage above fails on it) is read again from what is kept, so that the stages after it are still read.
    if (!(await desireRowOf(page, WANTED[0].name).count())) {
      await arrive(page, step, url, { reload: true })
      await page.waitForSelector('[data-desire-new]', { state: 'attached', timeout: TIMEOUT })
      await readsDone(page, step, 'the reloaded panel')
    }

    const editor = desireRowOf(page, WANTED[0].name).locator('[data-desire-edit]')

    if (!(await editor.count())) {
      return ended('the route made has no way to be changed')
    }

    step(`changing ${WANTED[0].name}`)
    await editor.click({ timeout: FORM_WAIT })
    await page.waitForSelector('[data-desire-form]', { state: 'attached', timeout: FORM_WAIT })
    await page.locator('input[data-desire-name]').fill(edited, { timeout: FORM_WAIT })
    await page.locator('input[data-desire-yearly]').fill(String(EDITED.yearly), { timeout: FORM_WAIT })

    const changed = await keep(page, step, edited)

    stages.edited = await stageOf(page, step, 'the changed route', { named: edited })
    await arrive(page, step, url, { reload: true })
    await page.waitForSelector('[data-desire-new]', { state: 'attached', timeout: TIMEOUT })
    stages.reloaded = await stageOf(page, step, 'the reloaded panel')

    const remover = desireRowOf(page, REMOVED).locator('[data-desire-delete]')

    if (!(await remover.count())) {
      return ended('the route to delete has no way to be deleted', changed)
    }

    step(`deleting ${REMOVED}`)
    await remover.click({ timeout: FORM_WAIT })
    await desireRowOf(page, REMOVED).locator('[data-desire-delete-confirm]').click({ timeout: FORM_WAIT })
    stages.deleted = await stageOf(page, step, 'the panel without the deleted route', { tombstones: stages.reloaded.stored.tombstones.length + 1 })
    await arrive(page, step, url, { reload: true })
    await page.waitForSelector('[data-desire-new]', { state: 'attached', timeout: TIMEOUT })
    stages.reloadedAfterDelete = await stageOf(page, step, 'the reloaded panel without the deleted route')

    return ended(null, changed)
  })
}

const desireChecks = []
const addDesire = (id, name, run) => desireChecks.push({ id, name, run })
const refreshChecks = []
const addRefresh = (id, name, run) => refreshChecks.push({ id, name, run })

// What the table of the fleets above the panel says of the fleets a route is run by: the freight each moves in a year, in tonnes of the cargo, and whether it moves any.
const flowOf = (table, world, key, cargo) => {
  const row = table.find((entry) => entry.name.startsWith(world.expected[WORLD[key]].name))
  const parts = row ? row.moved.filter((part) => part.endsWith(` t ${cargo}`)) : []

  return { capable: Boolean(row && row.moved.length), ...(parts.length ? tonnesOf(parts.join(', ')) : { tonnes: 0, error: 0 }) }
}

// The coverage the page owes a desired route, worked from the fleets' own figures of the table above and the heads of their queues, as the world builds them: the fleets that serve it deliver its cargo, the fleets of a conditional outcome the save cannot tell may deliver it too and so leave the shortfall open.
const oracleOf = (want, world, table) => {
  const flows = want.serving.map((key) => ({ key, ...flowOf(table, world, key, want.cargo) })).filter((flow) => flow.capable && flow.tonnes > 0)
  const open = want.open.filter((key) => flowOf(table, world, key, want.cargo).capable)
  const capacity = flows.length ? { tonnes: flows.reduce((sum, flow) => sum + flow.tonnes, 0), error: flows.reduce((sum, flow) => sum + flow.error, 0) } : null
  const state = flows.length ? (flows.some((flow) => !stalledOf(world, flow.key)) ? 'covered' : 'paused') : want.unknown ? 'unknown' : 'uncovered'
  const short = want.yearly === null ? null : Math.max(0, want.yearly - (capacity ? capacity.tonnes : 0))
  const gap = short === null ? null : short === 0 || (!want.unknown && !open.length) ? short : null

  return { state, capacity, gap, error: capacity ? capacity.error : 0 }
}

const rowsOf = (stage, name) => stage.rows.filter((row) => row.name.length === 1 && row.name[0] === name)

const keptOf = (want, world) => ({ name: want.name, cargo: want.cargo, yearly: want.yearly, note: '', from: world.colonies[want.route].from, to: world.colonies[want.route].to })

const withoutKeys = (record) => ({ name: record.name, cargo: record.cargo, yearly: record.yearly, note: record.note, from: record.from, to: record.to })

const byName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name))

// One row of the panel against the coverage and the record it is owed, field by field, every figure read whole and signed.
const assertRow = ({ row, want, world, table, labels, grouping, unavailable = false }) => {
  const { readFigure } = require('./lib/browser-observe')
  const expected = unavailable ? { state: 'unknown', capacity: null, gap: null, error: 0 } : oracleOf(want, world, table)
  const unit = labels.CARGO_UNITS[want.cargo]
  const once = (list, what) => {
    assert.equal(list.length, 1, `${what} of "${want.name}" is drawn once`)

    return list[0]
  }
  const figureOf = (text, what) => {
    const value = readFigure(text, ['Tick', 'Comma', 'Dash', 'Space', 'None'].includes(grouping) ? grouping : 'Tick')

    assert.ok(value !== null, `${what} of "${want.name}" reads as a figure: ${text}`)

    return value
  }

  assert.equal(once(row.name, 'the name'), want.name, `the name drawn for "${want.name}"`)
  assert.equal(once(row.from, 'the first colony'), world.colonyText[world.colonies[want.route].from], `the first colony of "${want.name}"`)
  assert.equal(once(row.to, 'the second colony'), world.colonyText[world.colonies[want.route].to], `the second colony of "${want.name}"`)
  assert.equal(once(row.cargo, 'the cargo'), labels.CARGO_KINDS[want.cargo], `the cargo of "${want.name}"`)
  assert.deepEqual(row.note, [], `no note is drawn for "${want.name}"`)

  const state = keyOfText(labels.COVERAGE, once(row.state, 'the coverage'), `the coverage drawn for "${want.name}"`)

  assert.equal(state, expected.state, `the coverage of "${want.name}": the fleets of the table above give ${expected.state}`)
  assert.equal(once(row.stateKey, 'the coverage key'), expected.state, `the coverage identity of "${want.name}"`)

  if (expected.capacity === null) {
    assert.deepEqual([row.delivered, row.deliveredUnit], [[], []], `no delivered freight is drawn for "${want.name}", nor its unit`)
    assert.ok(once(row.capacity, 'the capacity').startsWith('—'), `the capacity of "${want.name}" is the dash: ${row.capacity[0]}`)
  } else {
    const delivered = figureOf(once(row.delivered, 'the delivered freight'), 'the delivered freight')

    assert.ok(Math.abs(delivered - expected.capacity.tonnes) <= expected.error + 1, `the freight delivered for "${want.name}" is ${delivered}, the fleets of the table above move ${expected.capacity.tonnes} (within ${expected.error})`)
    assert.equal(once(row.deliveredUnit, 'the unit of the delivered freight'), unit, `the freight delivered for "${want.name}" is told in the unit of its cargo`)
  }

  if (want.yearly === null) {
    assert.deepEqual([row.demand, row.demandUnit], [[], []], `no demand figure is drawn for "${want.name}", nor its unit: it is kept without one`)
    assert.equal(once(row.demandNone, 'the line that says no demand is set'), labels.DESIRE_DEMAND_NONE, `the record kept without demand says so: "${want.name}"`)
  } else {
    assert.equal(figureOf(once(row.demand, 'the demand'), 'the demand'), want.yearly, `the demand drawn for "${want.name}"`)
    assert.equal(once(row.demandUnit, 'the unit of the demand'), unit, `the demand of "${want.name}" is told in the unit of its cargo`)
    assert.deepEqual(row.demandNone, [], `no line that says no demand is set is drawn beside the demand of "${want.name}"`)
  }

  if (expected.gap === null) {
    assert.deepEqual([row.gap, row.gapUnit], [[], []], `no shortfall is drawn for "${want.name}", nor its unit: a fleet that may deliver it is not known to`)
  } else {
    const gap = figureOf(once(row.gap, 'the shortfall'), 'the shortfall')

    assert.ok(Math.abs(gap - expected.gap) <= expected.error + 1, `the shortfall drawn for "${want.name}" is ${gap}, the demand less the freight of the table above is ${expected.gap} (within ${expected.error})`)
    assert.equal(once(row.gapUnit, 'the unit of the shortfall'), unit, `the shortfall of "${want.name}" is told in the unit of its cargo`)
  }
}

const countOf = (stage, what) => {
  assert.equal(stage.count.length, 1, `the count of the routes is drawn once (${what})`)

  return wholeOf(stage.count[0], `the count of the routes (${what})`)
}

const asEdited = (want) => (want.name === WANTED[0].name ? { ...want, ...EDITED } : want)

const rowsAreRight = (stage, seen, world, labels, list, what) => {
  assert.equal(stage.completed, true, `the panel draws exactly the routes that are kept once the operation is done (${what})`)
  assert.deepEqual([stage.waiting, stage.errors, stage.newButton, stage.form], [0, 0, 1, 0], `the panel is ready with no form open (${what})`)
  assert.deepEqual(stage.messages, [], `no message is drawn (${what})`)
  assert.equal(countOf(stage, what), list.length, `the number of routes counted (${what})`)
  assert.deepEqual(stage.rows.map((row) => row.name[0]), byName(list).map((want) => want.name), `the routes drawn, in the order of their names (${what})`)
  list.forEach((want) => assertRow({ row: rowsOf(stage, want.name)[0], want, world, table: seen.table, labels, grouping: seen.grouping }))
}

addDesire('desire-panel', 'the panel of the desired routes is ready for a save with none: no wait, no error, the button, no form, no route, and nothing kept', ({ seen }) => {
  const stage = seen.stages.empty

  assert.deepEqual([stage.waiting, stage.errors, stage.newButton, stage.form], [0, 0, 1, 0], 'the panel is ready with no form open')
  assert.deepEqual(stage.rows, [], 'no route is drawn')
  assert.equal(countOf(stage, 'none kept'), 0, 'the number of routes counted')
  assert.deepEqual([stage.stored.records, stage.stored.tombstones], [[], []], 'nothing is kept')
})

addDesire('desire-created', 'each desired route made in the form closes it, is drawn with its colonies, cargo, coverage and capacity worked from the fleets of the table above, and is kept as the record the form made', ({ seen, world, labels }) => {
  const stage = seen.stages.created

  assert.ok(stage, `the routes were made in the form: ${seen.aborted}`)

  assert.deepEqual(seen.created, WANTED.map((want) => ({ name: want.name, closed: true })), 'the form closes once each route is kept')
  assert.equal(world.colonistOrders, 0, 'no fleet of the world loads colonists: nothing serves the route of settlers')
  assert.equal(flowOf(seen.table, world, 'K', 'minerals').capable, false, 'the fleet whose cargo never settles has no figure in the table above')
  assert.equal(flowOf(seen.table, world, 'E', 'minerals').capable && world.expected[WORLD.E].undetermined, true, 'the fleet of the conditional order has a figure and an outcome the save cannot tell')
  rowsAreRight(stage, seen, world, labels, WANTED, 'the kept routes')
  assert.deepEqual(stage.stored.records.map(withoutKeys), byName(WANTED.map((want) => keptOf(want, world))), 'the records kept: name, cargo, yearly demand, note and the colonies of each')
  assert.deepEqual(stage.rows.map((row) => row.key).sort(), stage.stored.records.map((record) => record.uuid).sort(), 'each route drawn is the record of its identity')
  assert.equal(new Set(stage.stored.records.map((record) => record.uuid)).size, WANTED.length, 'no identity is kept twice')
})

addDesire('desire-edited', 'a desired route changed in the form keeps its identity and colonies, takes the new name and demand with a new revision, and leaves the others as they were', ({ seen, world, labels }) => {
  assert.ok(seen.stages.created && seen.stages.edited, `the route was changed in the form: ${seen.aborted}`)

  const before = seen.stages.created
  const after = seen.stages.edited
  const list = WANTED.map(asEdited)

  assert.equal(seen.changed, true, 'the form closes once the change is kept')
  rowsAreRight(after, seen, world, labels, list, 'after the change')

  const first = before.stored.records.find((record) => record.name === WANTED[0].name)
  const changed = after.stored.records.find((record) => record.name === EDITED.name)

  assert.ok(first && changed, 'the route is kept before and after the change')
  assert.equal(changed.uuid, first.uuid, 'the change is made to the record, not to a new one')
  assert.ok(changed.revision > first.revision, `the revision of the record rises: ${first.revision} to ${changed.revision}`)
  assert.deepEqual(rowsOf(after, EDITED.name)[0].key, first.uuid, 'the route drawn is the record changed')
  assert.deepEqual(after.stored.records.map(withoutKeys), byName(list.map((want) => keptOf(want, world))), 'the records kept after the change')
  assert.deepEqual(after.stored.records.filter((record) => record.uuid !== first.uuid), before.stored.records.filter((record) => record.uuid !== first.uuid), 'the other records are as they were, revision and all')
})

addDesire('desire-reloaded', 'the desired routes are drawn again after the page is reloaded, as they were, from what the browser kept', ({ seen }) => {
  assert.ok(seen.stages.edited && seen.stages.reloaded, `the page was reloaded after the change: ${seen.aborted}`)
  assert.equal(seen.stages.reloaded.completed, true, 'the panel draws the routes that are kept once the page is reloaded')
  assert.deepEqual(seen.stages.reloaded.rows, seen.stages.edited.rows, 'the routes drawn after the reload are the routes drawn before it')
  assert.deepEqual(seen.stages.reloaded.stored, seen.stages.edited.stored, 'what is kept is what was kept')
})

addDesire('desire-deleted', 'a desired route deleted is gone from the panel and the records and its identity is never used again, and it is gone after a reload', ({ seen, world, labels }) => {
  assert.ok(seen.stages.reloaded && seen.stages.deleted && seen.stages.reloadedAfterDelete, `the route was deleted in the panel: ${seen.aborted}`)

  const list = WANTED.map(asEdited).filter((want) => want.name !== REMOVED)
  const gone = seen.stages.reloaded.stored.records.find((record) => record.name === REMOVED)

  assert.ok(gone, 'the route to delete is kept before it')

  for (const [stage, what] of [[seen.stages.deleted, 'after the deletion'], [seen.stages.reloadedAfterDelete, 'after the deletion and a reload']]) {
    rowsAreRight(stage, seen, world, labels, list, what)
    assert.deepEqual(stage.stored.records.map(withoutKeys), byName(list.map((want) => keptOf(want, world))), `the records kept ${what}`)
    assert.deepEqual(stage.stored.tombstones, [gone.uuid], `the identity of the deleted route is kept as deleted ${what}`)
  }

  assert.deepEqual(seen.stages.reloadedAfterDelete.rows, seen.stages.deleted.rows, 'the routes after the reload are the routes before it')
})

addRefresh('desire-refreshed', 'while the saved orders are read again the desired routes stay as records and draw no coverage from the orders of the read before, and the coverage is back once they are read', ({ seen, world, labels }) => {
  assert.ok(seen.stages.created && seen.stages.refreshing && seen.stages.refreshed, `the save was renewed with the read of the saved orders held back: ${seen.aborted}`)

  const stage = seen.stages.refreshing

  rowsAreRight(seen.stages.created, seen, world, labels, REFRESHED, 'before the save is renewed')
  assert.ok(stage.asked === true && stage.pending === true, `the read of the saved orders is out and the page waits for it: asked ${stage.asked}, pending ${stage.pending}`)
  assert.deepEqual([stage.waiting, stage.errors, stage.newButton, stage.form], [0, 0, 1, 0], 'the panel is ready with no form open')
  assert.equal(countOf(stage, 'while the saved orders are read'), REFRESHED.length, 'the number of routes counted')
  assert.deepEqual(stage.rows.map((row) => row.name[0]), byName(REFRESHED).map((want) => want.name), 'the routes drawn while the saved orders are read, in the order of their names')
  REFRESHED.forEach((want) => assertRow({ row: rowsOf(stage, want.name)[0], want, world, table: seen.table, labels, grouping: seen.grouping, unavailable: true }))
  rowsAreRight(seen.stages.refreshed, seen, world, labels, REFRESHED, 'once the saved orders are read again')
})

// A page fault or rewrite is read through the groups of the panel of the routes (`open`) or through the flow of the desired routes (`openDesires`): a fault reads the desired routes when every check it names is one of theirs, a rewrite says where it reads.
const BROWSER_MUTATIONS = [
  { name: 'the groups list every fleet apart', file: S, find: 'const group = byId.get(record.route.id) ||', to: 'const group = byId.get(`${record.route.id}${record.FleetID}`) ||', fails: ['screen-groups', 'screen-capacity', 'screen-flags'] },
  { name: 'the capacity of a group counts its fleets twice', file: S, find: 'minerals: total.minerals + member.year.minerals, installations: total.installations + member.year.installations,', to: 'minerals: total.minerals + 2 * member.year.minerals, installations: total.installations + 2 * member.year.installations,', fails: ['screen-capacity'] },
  { name: 'the capacity of a group counts the fleets whose conditional outcome is not known', file: S, find: 'capacity: sumOf(settled), potential: sumOf(capable)', to: 'capacity: sumOf(capable), potential: sumOf(capable)', fails: ['screen-capacity'] },
  { name: 'the fleets left out of a capacity are not told', file: G, find: '<div v-if="item.leftOut" class="caption text--secondary" data-route-capacity-note>', to: '<div v-if="false" class="caption text--secondary" data-route-capacity-note>', fails: ['screen-capacity'] },
  { name: 'a group of fleets whose conditional outcome is not known is not known', file: S, find: "capable.length ? 'conditional' :", to: "capable.length ? 'unknown' :", fails: ['screen-state'] },
  { name: 'a closed queue is a fleet of a route', file: S, find: "const shape = cycling ? (!queue.length ? 'empty' : problem ? 'untraceable' : 'route') :", to: "const shape = (cycling || queue.length > 3) ? (!queue.length ? 'empty' : problem ? 'untraceable' : 'route') :", fails: ['screen-groups', 'screen-closed'] },
  { name: 'the duplicate flag is drawn for every group', file: S, find: "...(group.duplicate ? [{ key: 'duplicate'", to: "...(true ? [{ key: 'duplicate'", fails: ['screen-flags'] },
  { name: 'a flag is drawn as its key', file: G, find: ':data-route-flag="flag.key">{{ flag.text }}</v-chip>', to: ':data-route-flag="flag.key">{{ flag.key }}</v-chip>', fails: ['screen-flags'] },
  { name: 'a related route is drawn with its relation key', file: G, find: '<span data-route-relation-label>{{ relationText(related.relation) }}</span>', to: '<span data-route-relation-label>{{ related.relation }}</span>', fails: ['screen-flags'] },
  { name: 'a conditional order whose outcome is not known is told armed', file: G, find: 'return CONDITION_STATUSES[record.conditional.status]', to: 'return CONDITION_STATUSES.armed', fails: ['screen-flags'] },
  { name: 'the flagged-only switch drops the groups that are not served and show no flag', file: G, find: 'row.flags.length > 0 || row.status !== \'capable\'', to: 'row.flags.length > 0', fails: ['screen-filter'] },
  { name: 'the flagged-only switch keeps every group', file: G, find: 'this.flaggedOnly ? this.rows.filter((row) => row.flags.length > 0 || row.status !== \'capable\') : this.rows', to: 'this.rows', fails: ['screen-filter'] },
  { name: 'a stored order is drawn with its number as its id', file: G, find: '(order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span><span v-if="!member.record.orders.length">none</span>', to: '(order <span data-route-order-id>{{ order.MoveOrder }}</span>)</span><span v-if="!member.record.orders.length">none</span>', fails: ['screen-links'] },
  { name: 'the fleets of a group are drawn without the first of their stored orders', file: G, find: 'v-for="(order, index) in member.record.orders"', to: 'v-for="(order, index) in member.record.orders.slice(1)"', fails: ['screen-links'] },
  { name: 'the status of a group is drawn in the words of another', file: G, find: 'statusText: GROUP_STATUSES[group.status],', to: "statusText: GROUP_STATUSES[group.status === 'capable' ? 'paused' : group.status],", fails: ['screen-state'] },
  { name: 'the name source of a route is drawn as the fleet whatever it is', file: G, find: 'return NAME_SOURCES[name.source]', to: 'return NAME_SOURCES.fleet', fails: ['screen-names'] },
  { name: 'the match of a template is always told as a match of content', file: G, find: 'return name.exact ? MATCHES.exact : MATCHES.pacing', to: 'return MATCHES.exact', fails: ['screen-names'] },
  { name: 'the match of a template is the match of the last of them', file: S, find: 'group.fleets.some((record) => record.route.pacingKey === matched[0].pacingKey)', to: 'group.fleets.some((record) => record.route.pacingKey === matched[matched.length - 1].pacingKey)', fails: ['screen-names'] },
  { name: 'the closed queues are drawn in the words of a route', file: G, find: 'return SHAPES[record.shape]', to: 'return SHAPES.route', fails: ['screen-closed'] },
  { name: 'the closed queues are drawn without the first of their stored orders', file: G, find: 'v-for="(order, index) in record.orders" :key="order.MoveOrderID" :data-route-order="order.MoveOrderID">{{ index ? \', \' : \'\' }}#<span data-route-order-number>{{ order.MoveOrder }}</span> (order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span></div>\n        </div>\n        <div v-if="!audit.closed.length"', to: 'v-for="(order, index) in record.orders.slice(1)" :key="order.MoveOrderID" :data-route-order="order.MoveOrderID">{{ index ? \', \' : \'\' }}#<span data-route-order-number>{{ order.MoveOrder }}</span> (order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span></div>\n        </div>\n        <div v-if="!audit.closed.length"', fails: ['screen-closed'] },
  { name: 'the broken queues are drawn without the first of their stored orders', file: G, find: '<div v-if="record.orders.length" class="caption text--secondary" data-route-orders>Stored orders: <span v-for="(order, index) in record.orders"', to: '<div v-if="record.orders.length" class="caption text--secondary" data-route-orders>Stored orders: <span v-for="(order, index) in record.orders.slice(1)"', fails: ['screen-closed'] },
  { name: 'the other templates of a route are not named', file: G, find: 'v-for="(other, index) in item.name.others" :key="other" data-route-other', to: 'v-for="(other, index) in item.name.others.slice(1)" :key="other" data-route-other', fails: ['screen-names'] },
  { name: 'a fleet of a group is drawn under the name of the first fleet', file: G, find: 'data-route-fleet-name>{{ member.record.FleetName }}', to: 'data-route-fleet-name>{{ item.members[0].record.FleetName }}', fails: ['screen-links'] },
  { name: 'a closed queue is drawn under the name of the first closed queue', file: G, find: 'data-route-fleet-name>{{ record.FleetName }}</span>\n          <span class="text--secondary"> · <span data-route-shape>{{ shapeText(record) }}</span> · {{ flowsOf(record) }}', to: 'data-route-fleet-name>{{ audit.closed[0].FleetName }}</span>\n          <span class="text--secondary"> · <span data-route-shape>{{ shapeText(record) }}</span> · {{ flowsOf(record) }}', fails: ['screen-closed'] },
  { name: 'the panel is drawn transparent', file: G, find: 'elevation="1" data-route-groups>', to: 'elevation="1" data-route-groups style="opacity: 0">', fails: ['screen-groups', 'screen-capacity', 'screen-flags', 'screen-links', 'screen-names', 'screen-closed', 'screen-state', 'screen-filter'] },
  { name: 'the handling of a cycle that never settles is drawn', file: 'page', find: '<handling-breakdown v-if="item.cargo.settled" :rows', to: '<handling-breakdown v-if="true" :rows', fails: ['screen-unsettled'] },
  { name: 'the note that a cycle never settles is not drawn', file: 'page', find: '<div v-else class="caption text--secondary mt-2" data-cargo-unsettled>', to: '<div v-else-if="false" class="caption text--secondary mt-2" data-cargo-unsettled>', fails: ['screen-unsettled'] },
  { name: 'the note that a cycle never settles is drawn in other words', file: 'page', find: 'data-cargo-unsettled>{{ cargoUnsettled }}</div>', to: 'data-cargo-unsettled>{{ cargoUnsettled.toUpperCase() }}</div>', fails: ['screen-unsettled'] },
  { name: 'the desired routes the panel keeps are not read again', file: 'page', find: '@changed="desiresChanged"', to: '@changed="() => {}"', fails: ['desire-created', 'desire-edited', 'desire-deleted'] },
  { name: 'the coverage of a desired route is always told covered', file: 'desireView', find: 'data-desire-state-text>{{ coverageText(item.cover.state) }}', to: "data-desire-state-text>{{ coverageText('covered') }}", fails: ['desire-created'] },
  { name: 'a route nothing serves is drawn with a freight delivered', file: 'desireView', find: '<div v-if="item.cover.capacity !== null"><span data-desire-delivered>', to: '<div v-if="item.cover.capacity !== null || item.cover.state === \'uncovered\'"><span data-desire-delivered>', fails: ['desire-created'] },
  { name: 'the shortfall is drawn as the demand', file: 'desireView', find: '<span data-desire-gap>{{ number(item.cover.gap) }}</span>', to: '<span data-desire-gap>{{ number(item.entry.yearly) }}</span>', fails: ['desire-created'] },
  { name: 'the cargo of a desired route is drawn as minerals', file: 'desireView', find: 'data-desire-cargo-text>{{ cargoText(item.entry.cargo) }}', to: "data-desire-cargo-text>{{ cargoText('minerals') }}", fails: ['desire-created'] },
  { name: 'the colonies of a desired route are drawn the other way round', file: 'desireView', find: '<span data-desire-from-text>{{ endText(item.entry.from) }}</span> → <span data-desire-to-text>{{ endText(item.entry.to) }}</span>', to: '<span data-desire-from-text>{{ endText(item.entry.to) }}</span> → <span data-desire-to-text>{{ endText(item.entry.from) }}</span>', fails: ['desire-created'] },
  { name: 'the count of the desired routes is one over', file: 'desireView', find: '<span data-desire-count-number>{{ rows.length }}</span>', to: '<span data-desire-count-number>{{ rows.length + 1 }}</span>', fails: ['desire-panel', 'desire-created'] },
  { name: 'a desired route is kept with no demand', file: 'desireView', find: 'yearly: Number.isNaN(yearly) ? draft.yearly : yearly,', to: 'yearly: null,', fails: ['desire-created'] },
  { name: 'a desired route is kept with its colonies the other way round', file: 'desireView', find: 'from: draft.fromPick ? { row: draft.fromPick.row } : undefined, to: draft.toPick ? { row: draft.toPick.row } : undefined,', to: 'from: draft.toPick ? { row: draft.toPick.row } : undefined, to: draft.fromPick ? { row: draft.fromPick.row } : undefined,', fails: ['desire-created'] },
  { name: 'a desired route changed is kept as another record', file: 'desireView', find: 'entry: entry ? { ...entry, revision: draft.revision } : null,', to: 'entry: null,', fails: ['desire-edited'] },
  { name: 'a desired route deleted is not deleted', file: 'desireView', find: 'const result = await deleteDesire(this.repository, this.scope, entry)', to: 'const result = { ok: true }', fails: ['desire-deleted'] },
  { name: 'the first desired route is deleted for any', file: 'desireView', find: '@click="remove(item.entry)"', to: '@click="remove(rows[0].entry)"', fails: ['desire-deleted'] },
  { name: 'the panel of the desired routes is hidden', file: 'desireView', find: 'elevation="1" data-route-desires>', to: 'elevation="1" v-show="false" data-route-desires>', fails: ['desire-panel'] },
  { name: 'the panel of the desired routes sits in a hidden ancestor', file: 'page', find: '<route-desires :state="desireState" :read="desireRead" :covers="routeAudit.desires" :repository="desireRepository" :repository-error="desireRepositoryError" :scope="desireScope" :context="desireContext" :choices="desireChoices" :separator="separator" @retry="retryDesires" @changed="desiresChanged" />', to: '<div style="display: none"><route-desires :state="desireState" :read="desireRead" :covers="routeAudit.desires" :repository="desireRepository" :repository-error="desireRepositoryError" :scope="desireScope" :context="desireContext" :choices="desireChoices" :separator="separator" @retry="retryDesires" @changed="desiresChanged" /></div>', fails: ['desire-panel'] },
  { name: 'the actions of a desired route are put in a slot the table does not have', file: 'desireView', find: '<template #[`item.actions`]="{ item }">', to: '<template #[`item.rowActions`]="{ item }">', fails: ['desire-edited'] },
  { name: 'the desired routes kept are not read when the page opens', file: 'desireMixin', find: 'return this.desireRecords && this.desireRecords.desires ? this.desireRecords.desires.readDesires(', to: 'return this.desireRecords && this.desireRecords.desires && this.desireRevision ? this.desireRecords.desires.readDesires(', fails: ['desire-reloaded'] },
  { name: 'the desired routes are covered from the saved orders of the read before', file: 'page', find: 'queues: this.loadErrors.routeQueues === null ? this.routeQueues : null,', to: 'queues: this.routeQueues,', fails: ['desire-refreshed'] },
  { name: 'the freight delivered by a desired route is told in the unit of colonists', file: 'desireView', find: '<span data-desire-delivered-unit>{{ unit(item.entry.cargo) }}</span>', to: "<span data-desire-delivered-unit>{{ unit('colonists') }}</span>", fails: ['desire-created'] },
  { name: 'the demand of a desired route is told in tonnes whatever its cargo', file: 'desireView', find: '<span data-desire-demand-unit>{{ unit(item.entry.cargo) }}</span>', to: "<span data-desire-demand-unit>{{ unit('minerals') }}</span>", fails: ['desire-created'] },
  { name: 'the unit of the shortfall of a desired route is hidden', file: 'desireView', find: '<span data-desire-gap-unit>', to: '<span v-show="false" data-desire-gap-unit>', fails: ['desire-created'] },
  { name: 'a desired route kept without demand does not say so', file: 'desireView', find: '<div v-else class="caption text--secondary" data-desire-demand-none>', to: '<div v-if="false" class="caption text--secondary" data-desire-demand-none>', fails: ['desire-created'] },
  { name: 'a desired route kept with a demand says that none is set', file: 'desireView', find: '<div v-else class="caption text--secondary" data-desire-demand-none>', to: '<div class="caption text--secondary" data-desire-demand-none>', fails: ['desire-created'] },
  { name: 'the conditional status of a fleet is hidden', file: G, find: '<span data-route-conditional-status>', to: '<span v-show="false" data-route-conditional-status>', fails: ['screen-flags'] },
]

const BROWSER_BENIGN = [
  { name: 'the switch of the flagged routes bound by a prop and an event', family: 'prop and event for v-model', reads: 'groups', file: G, find: '<v-switch v-model="flaggedOnly"', to: '<v-switch :input-value="flaggedOnly" @change="flaggedOnly = $event"' },
  { name: 'the flags of a group iterated over a parenthesised list', family: 'parenthesised condition', reads: 'groups', file: G, find: 'v-for="flag in item.flags"', to: 'v-for="flag in (item.flags)"' },
  { name: 'the closed queues titled with a suffix', family: 'qualifier moved', reads: 'groups', file: G, find: 'Queues that do not repeat ({{ audit.closed.length }})', to: '({{ audit.closed.length }}) queues that do not repeat' },
  { name: 'the empty table worded with a synonym', family: 'synonym', reads: 'groups', file: G, find: 'no-data-text="No fleet repeats a route."', to: 'no-data-text="No fleet runs a repeating route."' },
  { name: 'the handling of a settled cycle drawn on a strict comparison', family: 'condition turned round', reads: 'groups', file: 'page', find: '<handling-breakdown v-if="item.cargo.settled" :rows', to: '<handling-breakdown v-if="item.cargo.settled === true" :rows' },
  { name: 'the note of a cycle that never settles drawn as a paragraph', family: 'element kind', reads: 'groups', file: 'page', find: '<div v-else class="caption text--secondary mt-2" data-cargo-unsettled>{{ cargoUnsettled }}</div>', to: '<p v-else class="caption text--secondary mt-2" data-cargo-unsettled>{{ cargoUnsettled }}</p>' },
  { name: 'the number and the id of a stored order told the other way round', family: 'parts reordered', reads: 'groups', file: G, find: '#<span data-route-order-number>{{ order.MoveOrder }}</span> (order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span><span v-if="!member.record.orders.length">none</span>', to: 'order <span data-route-order-id>{{ order.MoveOrderID }}</span> at position <span data-route-order-number>{{ order.MoveOrder }}</span></span><span v-if="!member.record.orders.length">none</span>' },
  { name: 'the button of a new desired route with the event in its longhand', family: 'v-on longhand', reads: 'desires', file: 'desireView', find: 'data-desire-new @click="startNew"', to: 'data-desire-new v-on:click="startNew"' },
  { name: 'the demand of a desired route read through a list', family: 'condition rewritten', reads: 'desires', file: 'desireView', find: "draft.yearly === '' || draft.yearly === null ? null : Number(draft.yearly)", to: "['', null].includes(draft.yearly) ? null : Number(draft.yearly)" },
  { name: 'the count of the desired routes told after its word', family: 'parts reordered', reads: 'desires', file: 'desireView', find: "<span data-desire-count-number>{{ rows.length }}</span> {{ rows.length === 1 ? 'route' : 'routes' }}", to: "{{ rows.length === 1 ? 'Route' : 'Routes' }} kept: <span data-desire-count-number>{{ rows.length }}</span>" },
  { name: 'the amount delivered by a desired route told after its words', family: 'layout rewritten', reads: 'desires', file: 'desireView', find: '<div v-if="item.cover.capacity !== null"><span data-desire-delivered>{{ number(item.cover.capacity) }}</span> <span data-desire-delivered-unit>{{ unit(item.entry.cargo) }}</span> a year delivered</div>', to: '<div v-if="item.cover.capacity !== null">Delivered a year: <span data-desire-delivered>{{ number(item.cover.capacity) }}</span> <span data-desire-delivered-unit>{{ unit(item.entry.cargo) }}</span></div>' },
  { name: 'the conditional status of a fleet told after the names of its conditions', family: 'qualifier moved', reads: 'groups', file: G, find: '<span data-route-conditional-status>{{ conditionStatusText(member.record) }}</span><template v-if="member.record.conditional.rows.length">: <span data-route-conditional-names>{{ conditionNames(member.record) }}</span></template>', to: '<template v-if="member.record.conditional.rows.length"><span data-route-conditional-names>{{ conditionNames(member.record) }}</span>: </template><span data-route-conditional-status>{{ conditionStatusText(member.record) }}</span>' },
]

const readsOfFault = (mutation) => (mutation.fails.every((id) => id === 'desire-refreshed') ? 'refresh' : mutation.fails.every((id) => id.startsWith('desire-')) ? 'desires' : 'groups')

// ---- The variants ----------------------------------------------------------------------------------------------------------

const runHead = async () => {
  console.log('\nRoute signatures: the groups of fleets that run one route, their coverage and the audit, on fixtures worked by hand')

  for (const result of await runAll(sourcesOf())) {
    check(`${result.id}: ${result.name}`, result.ok, `${result.kind}: ${result.detail}`)
  }

  const ids = new Set(CHECKS.map((item) => item.id))
  const pageIds = new Set([...browserChecks, ...desireChecks, ...refreshChecks].map((item) => item.id))
  const unnamed = [
    ...MUTATIONS.flatMap((mutation) => mutation.fails.filter((id) => !ids.has(id)).map((id) => `${mutation.name} names ${id}`)),
    ...BROWSER_MUTATIONS.flatMap((mutation) => mutation.fails.filter((id) => !pageIds.has(id)).map((id) => `${mutation.name} names ${id}`)),
  ]

  check('mutations: every planted fault names checks that exist', unnamed.length === 0, unnamed.join('; '))

  const lost = []

  ;[...MUTATIONS, ...BENIGN, ...BROWSER_MUTATIONS, ...BROWSER_BENIGN].forEach((edit) => {
    try {
      applied(sourcesOf(), edit)
    } catch (error) {
      lost.push(error.message)
    }
  })
  check('mutations: every anchor of a fault and a rewrite is found once', lost.length === 0, lost.join('; '))
}

const runMutant = async (index) => {
  const mutation = MUTATIONS[index]
  const began = Date.now()
  const failed = failedOf(await runAll(applied(sourcesOf(), mutation)))
  const credited = failed.filter((result) => result.kind === 'assertion')

  check(`mutation caught: ${mutation.name}`, caughtBy(failed, mutation.fails, { name: mutation.name }), `expected a value of ${mutation.fails.join(', ')}; ${failed.length ? detail(failed) : 'every check held'}`)

  if (options.detail) {
    console.log(`      caught by ${credited.map((result) => result.id).join(', ') || 'nothing'} in ${Date.now() - began} ms`)
  }
}

const runBenign = async (index) => {
  const edit = BENIGN[index]
  const failed = failedOf(await runAll(applied(sourcesOf(), edit)))

  check(`benign rewrite (${edit.family}): ${edit.name}: no check fails`, failed.length === 0, detail(failed))
}

const runBenignTogether = async () => {
  const sources = BENIGN.reduce((current, edit) => applied(current, edit), sourcesOf())
  const failed = failedOf(await runAll(sources))

  check('benign rewrites together: no check fails', failed.length === 0, detail(failed))
}

// The page server, the browser and the world the page variants of a worker share, started by `prepare`.
const PAGE = { world: null, labels: null, sources: null, server: null, chrome: null }

const startPage = async () => {
  const { startPageServer } = require('./lib/page-server')

  PAGE.world = constructedWorld()
  PAGE.world.capableNames = [PAGE.world.expected[WORLD.A].name, PAGE.world.expected[WORLD.D].name]
  PAGE.labels = await wordsOf()
  PAGE.sources = sourcesOf()
  PAGE.server = await startPageServer({ save: PAGE.world.file })
  PAGE.chrome = await require('playwright').chromium.launch()

  const warmed = await PAGE.server.warm(PAGE.chrome, { routes: ['/hauling'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
}

// Closes every part of the pool, each whatever another does, and fails with the name and the error of each that did not close, so that the runner tells the teardown as failed.
const closeAll = async (closers) => {
  const failures = []

  for (const [what, close] of closers) {
    try {
      await close()
    } catch (error) {
      failures.push(`${what}: ${error.message}`)
    }
  }

  if (failures.length) {
    const { HarnessError } = require('./lib/browser-observe')

    throw new HarnessError(`the page pool did not close cleanly: ${failures.join('; ')}`)
  }
}

const closePage = async () => {
  try {
    await closeAll([['the page server', () => PAGE.server && PAGE.server.stop()], ['the browser', () => PAGE.chrome && PAGE.chrome.close()], ['the constructed world', () => PAGE.world && fs.rmSync(PAGE.world.folder, { recursive: true, force: true })]])
  } finally {
    PAGE.server = null
    PAGE.chrome = null
    PAGE.world = null
  }
}

// The page over the sources given, read the way `reads` says; the files it served are put back whatever happens.
const pageSeen = async (reads, given, what) => {
  const { report, HarnessError } = require('./lib/browser-observe')
  const { unobserved } = require('./lib/fault-credit')

  Object.entries(FILES).forEach(([key, file]) => PAGE.server.replace(file, given[key] === PAGE.sources[key] ? null : given[key]))

  try {
    const seen = reads === 'groups' ? await open(PAGE.chrome, PAGE.server.url, PAGE.world) : await openDesires(PAGE.chrome, PAGE.server.url, PAGE.world, PAGE.labels, reads === 'refresh')

    report(`the page with ${what}`, seen)

    if (unobserved(seen)) {
      throw new HarnessError(`the page with ${what} did not get through: ${seen.error}`)
    }

    return seen
  } finally {
    Object.values(FILES).forEach((file) => PAGE.server.replace(file, null))
  }
}

const pageChecksOf = (reads) => (reads === 'desires' ? desireChecks : reads === 'refresh' ? refreshChecks : browserChecks)

const judgePage = (reads, seen) => runChecks(pageChecksOf(reads), { seen: seen.value, world: PAGE.world, labels: PAGE.labels })

const runPage = async (reads) => {
  const seen = await pageSeen(reads, PAGE.sources, 'the sources as they are')

  for (const result of await judgePage(reads, seen)) {
    check(`${result.id}: ${result.name}`, result.ok, `${result.kind}: ${result.detail}`)
  }

  check(`no page error and no console error was raised (${reads})`, seen.unexpected.length === 0, seen.unexpected.join('; '))
}

const runPageFault = async (index) => {
  const mutation = BROWSER_MUTATIONS[index]
  const reads = readsOfFault(mutation)
  const failed = failedOf(await judgePage(reads, await pageSeen(reads, applied(PAGE.sources, mutation), `the fault "${mutation.name}"`)))
  const credited = failed.filter((result) => mutation.fails.includes(result.id) && result.kind === 'assertion')

  check(`mutation caught: ${mutation.name}: credited by ${credited.map((result) => result.id).join(', ') || 'nothing'}`, caughtBy(failed, mutation.fails, { name: mutation.name }), failed.map((result) => `${result.id}: ${result.kind}: ${String(result.detail).split('\n')[0]}`).join('; '))
}

const runPageBenign = async (index) => {
  const edit = BROWSER_BENIGN[index]
  const failed = failedOf(await judgePage(edit.reads, await pageSeen(edit.reads, applied(PAGE.sources, edit), `the rewrite "${edit.name}"`)))

  check(`benign rewrite (${edit.family}): ${edit.name}: no check fails`, failed.length === 0, detail(failed))
}

const runPageBenignTogether = async () => {
  const sources = BROWSER_BENIGN.reduce((current, edit) => applied(current, edit), PAGE.sources)
  const failed = []

  for (const reads of ['groups', 'desires']) {
    failed.push(...failedOf(await judgePage(reads, await pageSeen(reads, sources, 'every benign rewrite'))))
  }

  check('benign rewrites of the page together: no check fails', failed.length === 0, detail(failed))
}

// The deadlines, in seconds, to be set from the times measured (`--detail` says each variant's): a page variant waits at most TIMEOUT (120 s) for each step.
const DEADLINES = { head: 240, memory: 120, page: 420, setup: 900 }
const MEMORY_HEADING = '\nPlanted faults and benign rewrites of the sources'
const PAGE_HEADING = '\nPlanted faults and benign rewrites of the page and the desired routes'

const variantsOf = () => [
  { key: 'head', name: 'the head: the pure parts of the sources as they are', head: true, pool: 'memory', deadline: DEADLINES.head, run: runHead },
  { key: 'page', name: 'the head: the panel of the routes over a constructed copy of a save', heading: '\nThe Hauling page: the panels over a constructed copy of a save', head: true, pool: 'page', deadline: DEADLINES.page, run: () => runPage('groups') },
  { key: 'page-desires', name: 'the head: the desired routes made, changed, reloaded and deleted in the page', head: true, pool: 'page', deadline: DEADLINES.page, run: () => runPage('desires') },
  { key: 'page-refresh', name: 'the head: the desired routes while the saved orders of a renewed save are read', head: true, pool: 'page', deadline: DEADLINES.page, run: () => runPage('refresh') },
  ...(options.mutations ? [
    ...MUTATIONS.map((mutation, index) => ({ key: `mutant:${index}`, name: `planted fault: ${mutation.name}`, heading: MEMORY_HEADING, pool: 'memory', deadline: DEADLINES.memory, run: () => runMutant(index) })),
    ...BENIGN.map((edit, index) => ({ key: `benign:${index}`, name: `benign rewrite: ${edit.name}`, heading: MEMORY_HEADING, pool: 'memory', deadline: DEADLINES.memory, run: () => runBenign(index) })),
    { key: 'benign:together', name: 'every benign rewrite of the sources together', heading: MEMORY_HEADING, pool: 'memory', deadline: DEADLINES.memory, run: runBenignTogether },
    ...BROWSER_MUTATIONS.map((mutation, index) => ({ key: `page-fault:${index}`, name: `planted fault of the page: ${mutation.name}`, heading: PAGE_HEADING, pool: 'page', deadline: DEADLINES.page, run: () => runPageFault(index) })),
    ...BROWSER_BENIGN.map((edit, index) => ({ key: `page-benign:${index}`, name: `benign rewrite of the page: ${edit.name}`, heading: PAGE_HEADING, pool: 'page', deadline: DEADLINES.page, run: () => runPageBenign(index) })),
    { key: 'page-benign:together', name: 'every benign rewrite of the page together', heading: PAGE_HEADING, pool: 'page', deadline: DEADLINES.page * 2, run: runPageBenignTogether },
  ] : []),
]

// The planted fault the control runs before the head of the page: one the head of the panel of the routes catches.
const CONTROL_FAULT = 'the panel is drawn transparent'

const run = async () => {
  const totals = await runSuite({
    script: __filename,
    variants: variantsOf(),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.pool === 'page')) {
        await startPage()
      }
    },
    afterEach: async () => {
      if (PAGE.server) {
        await PAGE.server.reset()
      }
    },
    close: closePage,
    control: options.mutations ? { fault: `page-fault:${BROWSER_MUTATIONS.findIndex((mutation) => mutation.name === CONTROL_FAULT)}`, head: 'page', heading: '\nThe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

run().catch(async (error) => {
  console.error(error)
  await closePage().catch(() => {})
  process.exit(2)
})
