/*
  Checks the elapsed-time routing and the leg explanations (src/renderer/utilities/route-time.js, the time order of jump-graph.js, the timed plan of route-plan.js, the cycles of transport.js and hauling.js, and the Routes page) on a constructed graph, without a save.

  bun scripts/check-route-time.js [--no-mutations]

  Fixture: a graph of systems from one origin to one destination in system 4, with three ways that each win one order: R1 (3 jumps, 8000 km, 420 s), R2 (1 jump, 25000 km, 250 s) and R3 (2 jumps, 12000 km, 240 s) for a fleet that flies 100 km/s and draws a jump shock of 121 to 180 s. The saves hold no dust and the shock is always absorbed by a flight, so the cases that make the time order differ from the others are built here. A second graph holds two ways whose waits are a range that ranks them in opposite ways at its two ends.

  The elapsed times are checked against a clock that is stepped through the journey (a timer that every jump sets and flights and stops run down), not against the walk the code makes of them.

  Mutations: each planted fault must fail the checks it names; benign edits (a wording, the form of a binding, a comment) must leave every check green. Exit code 1 when a check fails. A planted fault is judged on a world that loads the Routes page only when it names a statement that reads the page (`PAGE_KEYS`, which the head holds to the statements that do).
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { assert, isMarked } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const FILES = {
  'route-time': 'utilities/route-time.js',
  'jump-graph': 'utilities/jump-graph.js',
  'route-plan': 'utilities/route-plan.js',
  transport: 'utilities/transport.js',
  hauling: 'utilities/hauling.js',
  routes: 'pages/routes.vue',
}
const UTILITIES = ['route-time', 'jump-graph', 'route-plan', 'transport', 'hauling']
const NAMES = ['route-time', 'jump-graph', 'route-plan', 'provenance', 'transport', 'hauling', 'fleet-profile', 'route-position']
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(path.join(renderer, file), 'utf8').replace(/\r\n/g, '\n')]))
const LABELS_STUB = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
const RECORDER = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults, table: true }); export default (fields) => { globalThis.__persistedFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'
const STORE = { getters: { 'capabilities/result': {}, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const near = (actual, expected, epsilon = 1e-9) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`)

// ---------- the fixture ----------

const VERSION = '2.7.1'
const TECH = 1.5
const SPEED = 100
const SHOCK = { lo: 121, hi: 180 }
const jp = (id, system, link, x, y) => ({ WarpPointID: id, SystemID: system, WPLink: link, Distance: 0, Xcor: x, Ycor: y, JumpGateStrength: 0, Explored: 1, MilitaryRestricted: 0, IgnoreForDistance: 0 })
const pair = (a, b, first, second) => [jp(a, Math.floor(a / 100), b, first[0], first[1]), jp(b, Math.floor(b / 100), a, second[0], second[1])]

// Every pair: the jump point in the nearer system, the one it comes out at.
const GRAPH = [
  ...pair(101, 201, [5000, 0], [0, 0]),
  ...pair(202, 301, [1000, 0], [0, 0]),
  ...pair(302, 401, [1000, 0], [0, 0]),
  ...pair(102, 402, [0, 20000], [1000, 5000]),
  ...pair(103, 501, [-3000, 0], [0, 0]),
  ...pair(502, 403, [6000, 0], [1000, 3000]),
]
const ORIGIN = { SystemID: 1, Xcor: 0, Ycor: 0 }
const DESTINATION = { SystemID: 4, Xcor: 1000, Ycor: 0 }

// Two ways to the place (0, 0) of system 6: one jump and a long flight, or two jumps and short flights.
const RANGE = [
  ...pair(104, 601, [0, -17000], [0, 0]),
  ...pair(105, 701, [1000, 0], [0, 0]),
  ...pair(702, 602, [6000, 0], [1000, 0]),
]
const FAR = { SystemID: 6, Xcor: 0, Ycor: 0 }

// The first graph with every position `SCALE` times as far, so that its flights outlast the retry allowance the timing of a fleet carries (two of the longest subpulses, 43,200 s) and the page, which takes its timing from a fleet, still has a longer route that wins.
const SCALE = 300
const WIDE = GRAPH.map((point) => ({ ...point, Xcor: point.Xcor * SCALE, Ycor: point.Ycor * SCALE }))

const crewed = (extra = {}) => ({ speed: SPEED, speedIn: null, shock: SHOCK, shockMissing: [], startDelay: 0, ...extra })
const ship = (extra = {}) => ({ ShipID: 1, ShipName: 'Hauler', ClassName: 'Freighter', FleetID: 5, GradePoints: 100, CrewMorale: 1, OverhaulFactor: 1, SensorDelay: 0, ArmourThickness: 5, ...extra })
const participant = (extra = {}, role = 'independent') => ({ ship: ship(extra), name: extra.ShipName || 'Hauler', role })

// The clock of a journey worked step by step. Every jump sets a timer of `shock` seconds, flights and stops run it down, and a jump waits for it. `rounds` repeats the journey (a cycle) and gives the seconds of the last round.
const simulate = (events, shock, { startDelay = 0, rounds = 1 } = {}) => {
  let clock = 0
  let ready = startDelay
  let began = 0
  let previous = 0

  for (let round = 0; round < rounds; round++) {
    previous = clock - began
    began = clock

    for (const event of events) {
      if (event.kind === 'jump') {
        clock = Math.max(clock, ready)
        ready = clock + shock
      } else {
        clock += event.seconds
      }
    }
  }

  return { total: clock - began, before: previous }
}

const fly = (seconds) => ({ kind: 'fly', seconds })
const stop = (seconds) => ({ kind: 'handle', seconds })
const JUMP = { kind: 'jump' }

// The wait of a fleet that is stopped by its jump shock, on the game's own clock stepped by subpulse (not by the walk the code makes of the journey). The jump is made `phase` seconds into the first subpulse, which sets a delay of `delay` seconds that this subpulse's end does not run down; every later subpulse's end takes `length` off it. The fleet is at the next jump point `flight` seconds after the jump and transits in the first subpulse that starts with no delay left, or in the one it arrives in. Gives the seconds from arriving to transiting.
const subpulseWait = ({ delay, flight, length, phase }) => {
  const arrival = phase + flight
  let left = delay
  let start = length

  for (;;) {
    if (left <= 0 && start + length > arrival) {
      return Math.max(arrival, start) - arrival
    }

    left = Math.max(0, left - length)
    start += length
  }
}

// The arrival of a fleet set to its maximum speed `speed` that flies `legs` ([{ km, cap }], one for each system in order, `cap` the km/s the system's dust allows or null for none) with no wait at a jump, on the game's own clock stepped by pass over the fleet (not by the walk the code makes of the journey): a pass every `length` seconds, the first `phase` seconds in, gives the speed back and caps it by the system the fleet is in, and a system the fleet enters between two passes lowers it. Before the first pass the fleet holds the cap of the system it starts in. Gives the seconds to the end of the last leg.
const passStepped = (legs, { speed, length, phase }) => {
  let clock = 0
  let next = phase
  let now = speed

  for (const leg of legs) {
    const here = leg.cap === null ? speed : Math.min(speed, leg.cap)
    let left = leg.km

    now = Math.min(now, here)

    while (left > 0) {
      if (left <= now * (next - clock)) {
        clock += left / now
        left = 0
      } else {
        left -= now * (next - clock)
        clock = next
        next += length
        now = here
      }
    }
  }

  return clock
}

// ---------- the world: the modules and the page as shipped, or with planted faults ----------

const resolved = (edit, text) => {
  if (!edit.at) {
    return edit
  }

  const all = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags.replace('g', '')}g`))]

  if (!all.length || (all.length !== 1 && !edit.first)) {
    throw new Error(`The pattern of ${edit.name} does not apply exactly once (${all.length} matches)`)
  }

  return { find: all[0][0], replace: edit.to(all[0]) }
}

const applied = (text, edit) => {
  const change = resolved(edit, text[edit.target])

  return { ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], change.find, change.replace) }
}

// The keys of the statements that read the Routes page (`world.page`, `world.fields`). A world loads the page only for a run of one of them, so a planted fault that names none of them is judged on a world without it. The head records the statements that read the page and fails when that set is not this list; a statement that reads the page of a world without it throws, which credits no fault.
const PAGE_KEYS = ['order', 'page', 'gate', 'distance', 'voice']

const worldOf = async (edits = [], { withPage = true } = {}) => {
  const text = edits.reduce(applied, { ...ORIGINALS })
  const utilitySources = Object.fromEntries(UTILITIES.map((name) => [name, text[name]]))
  const pageSources = { ...Object.fromEntries(UTILITIES.map((name) => [`utilities/${name}`, text[name]])), 'pages/routes': text.routes }
  const loaded = await loadUtilities(NAMES, { sources: utilitySources })
  const page = withPage ? await loadPage('pages/routes', { sources: pageSources, modules: { 'mixins/load-state': LABELS_STUB } }) : null
  // `reading` is the key of the statement that runs (set by `fixtures`), and `readers` the keys of those that read the page.
  const world = { text, m: { time: loaded['route-time'], graph: loaded['jump-graph'], plan: loaded['route-plan'], transport: loaded.transport, hauling: loaded.hauling, fleet: loaded['fleet-profile'], provenance: loaded.provenance }, reading: null, readers: new Set() }
  const reach = () => {
    world.readers.add(world.reading)

    if (!withPage) {
      throw new Error(`the statement ${world.reading} reads the Routes page, which a world loads only for ${PAGE_KEYS.join(', ')}`)
    }
  }

  Object.defineProperty(world, 'page', {
    get: () => {
      reach()

      return page
    },
  })
  world.fields = async () => {
    reach()
    await loadPage('pages/routes', { sources: pageSources, modules: { 'mixins/load-state': LABELS_STUB, 'mixins/persisted-view': RECORDER } })

    return globalThis.__persistedFields
  }

  return world
}

// ---------- the statements ----------

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const memoryDatabase = async (withColumn = true) => {
  const raw = new sqlite3.Database(':memory:')
  const run = (sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

  await run(`create table FCT_System (SystemID, GameID${withColumn ? ', DustDensity' : ''})`)
  await run('create table FCT_RaceSysSurvey (SystemID, GameID, RaceID)')

  const systems = [[1, 1, 0], [5, 1, 500], [6, 1, 100], [7, 1, 200], [8, 2, 300]]

  for (const [id, game, density] of systems) {
    await run(`insert into FCT_System (SystemID, GameID${withColumn ? ', DustDensity' : ''}) values (${id}, ${game}${withColumn ? `, ${density}` : ''})`)
  }

  for (const [system, game, race] of [[1, 1, 2], [5, 1, 2], [6, 1, 3], [7, 1, 2], [8, 2, 2]]) {
    await run(`insert into FCT_RaceSysSurvey (SystemID, GameID, RaceID) values (${system}, ${game}, ${race})`)
  }

  return { query: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows])))), close: () => raw.close() }
}

const fixtures = (world) => {
  const all = []
  // Each statement tells the world its key as it runs, so that the world can record the statements that read the page.
  const add = (name, run) => all.push([name, () => {
    world.reading = keyOf(name)

    return run()
  }])
  const { m } = world
  const { graph, time, plan, transport, hauling } = m
  const search = (points, order, timing, origin = ORIGIN) => graph.searchRoutes(points, [origin], { order, timing: timing ? time.searchTiming(timing) : null })
  const through = (route) => graph.routeLegs(route).filter((step) => step.kind === 'jump').map((step) => step.to.SystemID)
  const eventsOf = (route, timing = crewed()) => time.routeEvents(graph.routeLegs(route), timing)
  const walkOf = (route, timing = crewed(), options = {}) => time.walkEvents(eventsOf(route, timing), timing.shock, { startDelay: timing.startDelay, ...options })
  const transportFixture = () => {
    const endpoint = (name, id, system) => transport.colonyEndpoint({ PopName: name, PopulationID: id, SystemID: system, ShuttleCapacity: 1, ServiceNames: 'Spaceport' })

    return {
      ends: { origin: endpoint('Mars', 7, 1), destination: endpoint('Venus', 8, 4) },
      hull: { ShipName: 'Hauler', ClassName: 'Freighter', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: SPEED, EnginePower: 10, FuelEfficiency: 1, FuelCapacity: 1e9, ShuttleTechnology: TECH },
    }
  }

  add('longer: a route with more jumps and more kilometres wins the fastest time where the validated waits warrant it, and each other order keeps its own winner', () => {
    const timing = crewed()
    const toDestination = (order) => search(GRAPH, order, timing).toPlace(DESTINATION)
    const byJumps = toDestination('jumps')
    const byKm = toDestination('km')
    const byTime = toDestination('time')

    assert.deepEqual(through(byJumps), [4], 'the fewest jumps')
    assert.deepEqual(through(byKm), [2, 3, 4], 'the shortest')
    assert.deepEqual(through(byTime), [5, 4], 'the fastest')
    assert.equal(byTime.jumps, 2)
    assert.ok(byTime.jumps > byJumps.jumps && byTime.km > byKm.km, 'the fastest is longer than the shortest')
    near(byTime.km, 12000)
    near(byKm.km, 8000)
    near(byJumps.km, 25000)
    near(byTime.seconds, 240)
    near(byKm.seconds, 420)
    near(byJumps.seconds, 250)
    assert.ok(byTime.seconds < byJumps.seconds && byJumps.seconds < byKm.seconds)
  })

  add('range: the fastest time ranks by the upper case of the wait and the lower case is shown beside it', () => {
    const timing = crewed()
    const routes = (order) => search(RANGE, order, timing).toPlace(FAR)
    const byTime = routes('time')
    const walked = walkOf(byTime)
    const other = walkOf(routes('km'))
    const longer = [walked, other].find((walk) => walk.jumps === 2)
    const shorter = [walked, other].find((walk) => walk.jumps === 1)

    assert.equal(byTime.jumps, 1, 'the upper case ranks the one jump first')
    near(byTime.seconds, 170)
    assert.deepEqual(shorter.total, { lo: 170, hi: 170 })
    assert.deepEqual(longer.total, { lo: 141, hi: 200 })
    assert.deepEqual(longer.wait, { lo: 61, hi: 120 })
    assert.ok(longer.total.lo < shorter.total.lo, 'the lower case would rank the other way')

    const result = time.elapsedResult(longer.total, [])

    near(result.value, 200 / 86400)
    assert.equal(time.waitResult(longer.wait, []).value, 120)
    assert.deepEqual(time.waitResult(longer.wait, []).units, 's')
  })

  add('unknown: a shock, a speed or a nebula cap the save cannot settle prices a route at no known time, and it never ranks fastest', () => {
    const blind = { speed: SPEED, speedIn: null, shock: null, shockMissing: ['the crew of the fleet'], startDelay: 0 }
    const blindSearch = search(GRAPH, 'time', blind)
    const first = blindSearch.toSystem(3)

    assert.equal(first.jumps, 2)
    assert.equal(first.seconds, Infinity, 'a jump after another has no known time while the shock is not known')
    assert.equal(blindSearch.toPlace(ORIGIN).seconds, 0, 'no jump waits for nothing')
    near(blindSearch.toSystem(5).seconds, 30)

    const pick = search(RANGE, 'time', blind).toPlace(FAR)

    assert.equal(pick.jumps, 1, 'the route whose time is known ranks before the one whose time is not')
    near(pick.seconds, 170)

    const noSpeed = search(GRAPH, 'time', { speed: null, speedIn: null, shock: SHOCK, startDelay: 0 }).toPlace(DESTINATION)

    assert.equal(noSpeed.seconds, Infinity)

    const unsettled = search(GRAPH, 'time', { speed: SPEED, speedIn: null, shock: SHOCK, startDelay: null }).toPlace(DESTINATION)

    assert.equal(unsettled.seconds, Infinity, 'a delay at the start that the save does not hold is not taken as none')

    const walk = walkOf(search(GRAPH, 'km', crewed()).toPlace(DESTINATION), blind)

    assert.equal(walk.wait, null)
    assert.equal(walk.total, null)
    assert.equal(walk.remaining, null)
    near(walk.flight, 80)

    const result = time.elapsedResult(walk.total, time.timingGaps(blind))

    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.inputs.missing, time.timingGaps(blind), 'the result names what it lacks')
    assert.ok(result.inputs.missing.length > 0)
    assert.equal(time.waitResult(walk.wait, ['x']).status, 'unavailable')
    assert.ok(time.timingGaps({ speed: null, shock: SHOCK, startDelay: 0 }).length === 1)
    assert.ok(time.timingGaps({ speed: SPEED, shock: SHOCK, startDelay: null }).length === 1)
    assert.deepEqual(time.timingGaps({ speed: SPEED, shock: SHOCK, startDelay: null }, { cyclic: true }), [])
  })

  add('unsupported: a fleet or class whose timing is not supported gives an explicit unknown or a stated least time, never a plain figure', () => {
    const endpoint = transport.colonyEndpoint({ PopName: 'Mars', PopulationID: 7, SystemID: 1, ShuttleCapacity: 1, ServiceNames: 'Spaceport' })
    const ends = { origin: endpoint, destination: transport.colonyEndpoint({ PopName: 'Venus', PopulationID: 8, SystemID: 4, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }) }
    const hull = { ShipName: 'Hauler', ClassName: 'Freighter', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: SPEED, EnginePower: 10, FuelEfficiency: 1, FuelCapacity: 1e9, ShuttleTechnology: TECH }
    const route = search(GRAPH, 'km', crewed()).toPlace(DESTINATION)
    const steps = graph.routeLegs(route)
    const trip = (timing, jumps) => transport.roundTrip([hull], route.km, ends, TECH, { colonists: true, version: VERSION, support: null, timing, jumps })
    const blind = trip({ steps, dust: {}, armour: 5, shock: null, shockMissing: ['the grade points of Hauler'], startDelay: 0 }, 3)

    assert.equal(blind.status, 'unknown')
    assert.equal(blind.tripSeconds, null)
    assert.ok(blind.problems.some((problem) => problem.where === 'fleet'))
    assert.equal(transport.tripResult(blind).status, 'unavailable')
    assert.ok(transport.tripResult(blind).inputs.missing.length > 0)

    const classRow = trip(null, 3)

    assert.equal(classRow.status, 'ok')
    assert.equal(classRow.waitCounted, false)
    assert.equal(classRow.waitSeconds, null)
    near(classRow.tripSeconds, classRow.travelSeconds + classRow.handlingSeconds)

    const result = transport.tripResult(classRow)

    assert.ok(result.inputs.missing.length > 0, 'a class timed alone names the crew its waits need')
    assert.ok(result.assumptions.length > 0, 'and says the figure is the least the cycle takes')

    const local = trip(null, 0)

    assert.equal(transport.tripResult(local).inputs.missing.length + 1, result.inputs.missing.length, 'a route with no jump waits for nothing, so it lacks no crew')
  })

  add('shock: a ship\'s delay is the rounded-half-even crew performance, a fleet draws the largest of its ships and a hangared ship is left out', () => {
    const delays = (extra) => time.shipShock(ship(extra))

    assert.deepEqual([delays({}).lo, delays({}).hi], [121, 180])
    assert.deepEqual([delays({ GradePoints: 156.25 }).lo, delays({ GradePoints: 156.25 }).hi], [118, 176], 'the half percent goes to the even whole one')
    near(time.crewPerformance(ship({ GradePoints: 156.25 })), 1.02)
    near(time.crewPerformance(ship({ GradePoints: 144 })), 1.02)
    near(time.crewPerformance(ship({ GradePoints: 169 })), 1.03)
    assert.deepEqual([delays({ GradePoints: 0 }).lo, delays({ GradePoints: 0 }).hi], [133, 198])
    assert.deepEqual([delays({ CrewMorale: 0.8 }).lo, delays({ CrewMorale: 0.8 }).hi], [145, 216])
    assert.deepEqual([delays({ OverhaulFactor: 0.9 }).lo, delays({ OverhaulFactor: 0.9 }).hi], [133, 198])
    assert.equal(delays({ GradePoints: null }), null)
    assert.equal(delays({ CrewMorale: undefined }), null)
    assert.equal(delays({ OverhaulFactor: null }), null)
    assert.deepEqual([delays({ CrewMorale: 3 }).lo, delays({ CrewMorale: 3 }).hi], [0, 0], 'a delay below 0 holds nothing')

    const fleet = time.fleetShock([participant({ ShipName: 'Able' }), participant({ ShipName: 'Baker', GradePoints: 0 }), participant({ ShipName: 'Charlie', CrewMorale: 0.8 })])

    assert.equal(fleet.status, 'ok')
    assert.deepEqual([fleet.lo, fleet.hi], [145, 216])
    assert.equal(fleet.limiting.hi, 'Charlie')

    const aboard = time.fleetShock([participant({ ShipName: 'Able' }), participant({ ShipName: 'Craft', GradePoints: 0, CrewMorale: 0.5 }, 'hangared')])

    assert.deepEqual([aboard.lo, aboard.hi], [121, 180], 'a hangared ship adds no delay')
    assert.equal(time.fleetShock([participant({ ShipName: 'Craft' }, 'hangared')]).status, 'none')

    const lacking = time.fleetShock([participant({ ShipName: 'Able' }), participant({ ShipName: 'Baker', GradePoints: null })])

    assert.equal(lacking.status, 'unknown')
    assert.ok(lacking.missing.some((entry) => entry.includes('Baker')) && !lacking.missing.some((entry) => entry.includes('Able')), 'the missing crew names its ship')
    assert.equal(time.fleetTimingOf([participant({ ShipName: 'Baker', GradePoints: null })]).shock, null)
    assert.deepEqual(time.fleetTimingOf([participant({ ShipName: 'Able' })]).shock, { lo: 121, hi: 180 })
  })

  add('offset: a delay the fleet still carries from a jump just made starts the route as a stated offset, and the next leg of a plan carries what the first leaves', () => {
    const delayed = crewed({ startDelay: 300 })
    const timing = time.searchTiming(delayed)
    const byTime = (points) => graph.searchRoutes(points, [ORIGIN], { order: 'time', timing }).toPlace(DESTINATION)
    const chosen = byTime(GRAPH)

    assert.deepEqual(through(chosen), [4], 'the offset makes the one jump the fastest')
    near(chosen.seconds, 350)

    const seconds = (order) => graph.searchRoutes(GRAPH, [ORIGIN], { order, timing }).toPlace(DESTINATION).seconds

    near(seconds('km'), 670)
    near(search(GRAPH, 'time', crewed({ startDelay: 300 })).toPlace(DESTINATION).seconds, 350)

    const first = walkOf(search(GRAPH, 'km', delayed).toPlace(DESTINATION), delayed)

    near(first.total.hi, 670)
    assert.equal(first.events.find((event) => event.kind === 'jump').wait.hi, 250, 'the first jump waits out what the flight has not')
    assert.equal(simulate(first.events, 180, { startDelay: 300 }).total, 670)
    assert.deepEqual(first.remaining, { lo: 111, hi: 170, ready: 170 }, 'the flight after the last jump runs the delay down')

    const short = walkOf(search(GRAPH, 'jumps', crewed()).toPlace(DESTINATION), crewed())
    const carry = time.walkEvents([JUMP, fly(40)], SHOCK, { startDelay: 0 })

    assert.deepEqual(carry.remaining, { lo: 81, hi: 140, ready: 140 })
    assert.deepEqual(time.carriedDelay(carry), { lo: 81, hi: 140, ready: 140 })
    assert.deepEqual(time.carriedDelay(short), { lo: 71, hi: 130, ready: 130 })

    const stopsAt = time.walkEvents([fly(5), JUMP, fly(10)], SHOCK, { startDelay: 20 })

    assert.deepEqual(stopsAt.events[1].wait, { lo: 15, hi: 15 }, 'a start delay is the same for both ends')
    assert.deepEqual(stopsAt.remaining, { lo: 111, hi: 170, ready: 170 })

    const here = { key: 'body:1', kind: 'body', name: 'Home', SystemID: 1, Xcor: 0, Ycor: 0 }
    const middle = { key: 'body:5', kind: 'body', name: 'Middle', SystemID: 5, Xcor: 0, Ycor: 0 }
    const there = { key: 'body:9', kind: 'body', name: 'Venus', SystemID: 4, Xcor: 1000, Ycor: 0 }
    const planned = plan.planRoute([here, middle, there], { cycle: false, jumpPoints: GRAPH, order: 'time', timing: crewed() })

    assert.equal(planned.legs.length, 2)
    near(planned.legs[0].time.total.hi, 30)
    assert.deepEqual(time.carriedDelay(planned.legs[0].time), { lo: 121, hi: 180, ready: 180 }, 'the first leg ends on a jump that has just been made')
    assert.deepEqual(planned.legs[1].time.wait, { lo: 61, hi: 120 }, 'the second leg waits out what the first left')
    near(planned.time.total.hi, 240)
    near(planned.time.flight, 120)
    assert.deepEqual(planned.time.wait, { lo: 61, hi: 120 })
    assert.deepEqual(planned.time.remaining, { lo: 91, hi: 150, ready: 150 }, 'the delay left at the end is carried on')
  })

  add('table: the flight, transit and wait of every route reconcile with its elapsed time, the search\'s time and a stepped clock', () => {
    const timing = crewed()
    const routes = [search(GRAPH, 'jumps', timing).toPlace(DESTINATION), search(GRAPH, 'km', timing).toPlace(DESTINATION), search(GRAPH, 'time', timing).toPlace(DESTINATION), search(RANGE, 'time', timing).toPlace(FAR)]
    const startDelays = [0, 0, 0, 0]

    routes.forEach((route, index) => {
      const walk = walkOf(route)

      near(walk.total.hi, route.seconds)
      near(walk.flight + walk.handling + walk.transit + walk.wait.hi, walk.total.hi)
      near(walk.flight + walk.handling + walk.transit + walk.wait.lo, walk.total.lo)
      assert.equal(walk.transit, 0, 'a transit takes no time')
      assert.equal(walk.handling, 0)
      assert.equal(walk.jumps, route.jumps)
      near(simulate(walk.events, SHOCK.hi, { startDelay: startDelays[index] }).total, walk.total.hi)
      near(simulate(walk.events, SHOCK.lo, { startDelay: startDelays[index] }).total, walk.total.lo)
      near(walk.flight, graph.routeLegs(route).filter((step) => step.kind === 'fly').reduce((sum, step) => sum + step.km, 0) / SPEED)
    })

    const cycleEvents = [stop(30), fly(50), JUMP, fly(10), stop(40), fly(20), JUMP, fly(10)]
    const cycle = time.walkEvents(cycleEvents, SHOCK, { cyclic: true })
    const stepped = simulate(cycleEvents, SHOCK.hi, { rounds: 3 })

    assert.equal(stepped.total, stepped.before, 'the cycle has settled')
    near(cycle.total.hi, stepped.total)
    near(simulate(cycleEvents, SHOCK.lo, { rounds: 3 }).total, cycle.total.lo)
    assert.deepEqual(cycle.remaining, null, 'a cycle has no delay left over')
  })

  add('cycle: the cycle of a fleet on Transport adds the flights both ways, the stops and the waits to the total the annual capacity divides', () => {
    const { ends, hull } = transportFixture()

    ;['km', 'time', 'jumps'].forEach((order) => {
      const route = search(GRAPH, order, crewed()).toPlace(DESTINATION)
      const timing = { steps: graph.routeLegs(route), dust: {}, armour: 5, shock: SHOCK, shockMissing: [], startDelay: 0 }
      const trip = transport.roundTrip([hull], route.km, ends, TECH, { colonists: true, version: VERSION, support: null, timing, jumps: route.jumps })
      const way = graph.routeLegs(route)
      const there = way.map((step) => (step.kind === 'fly' ? fly(step.km / SPEED) : JUMP))
      const back = graph.reverseSteps(way).map((step) => (step.kind === 'fly' ? fly(step.km / SPEED) : JUMP))
      const origin = trip.stops.filter((one) => one.where === 'origin').reduce((sum, one) => sum + one.seconds, 0)
      const destination = trip.stops.filter((one) => one.where === 'destination').reduce((sum, one) => sum + one.seconds, 0)
      const events = [stop(origin), ...there, stop(destination), ...back]
      const stepped = simulate(events, SHOCK.hi, { rounds: 3 })

      assert.equal(trip.status, 'ok')
      assert.equal(trip.waitCounted, true)
      near(trip.tripSeconds, stepped.total)
      near(trip.tripSeconds, trip.travelSeconds + trip.handlingSeconds + trip.transitSeconds + trip.waitSeconds.hi)
      near(trip.travelSeconds, (2 * route.km) / SPEED)
      near(trip.trips, 31536000 / trip.tripSeconds)
      assert.ok(trip.tripSecondsLow <= trip.tripSeconds)
      near(trip.tripSecondsLow, simulate(events, SHOCK.lo, { rounds: 3 }).total)
      assert.equal(trip.cycle.jumps, 2 * route.jumps)
    })
  })

  add('dust: a nebula caps a fleet\'s speed by its thinnest armour, a system with no known armour has no known speed and the loader reads only the race\'s surveyed systems', async () => {
    const at = (armour, dust) => time.speedIn({ speed: SPEED, dust, armour })

    assert.equal(time.dustCap(5, 500), 25)
    assert.equal(time.dustCap(5, 300), 41, 'the cap is cut to a whole number')
    assert.equal(time.dustCap(5, 0), null)
    assert.equal(time.dustCap(null, 500), null)
    assert.equal(at(5, { 5: 500 })(5), 25)
    assert.equal(at(5, { 5: 500 })(1), SPEED, 'a system without dust is flown at the speed')
    assert.equal(at(5, { 5: 50 })(5), SPEED, 'a cap above the speed does not speed the fleet up')
    assert.equal(at(null, { 5: 500 })(5), null)
    assert.equal(at(0, { 5: 500 })(5), null, 'a cap of 0 holds the fleet in the system')
    assert.equal(at(null, { 5: 500 })(1), SPEED)

    const nebula = { speed: SPEED, speedIn: at(5, { 5: 500 }), shock: SHOCK, startDelay: 0 }
    const byTime = search(GRAPH, 'time', nebula).toPlace(DESTINATION)

    assert.deepEqual(through(byTime), [4], 'the nebula slows the fastest route and a shorter-time one wins')
    near(byTime.seconds, 250)
    near(graph.searchRoutes(GRAPH, [ORIGIN], { order: 'km', timing: time.searchTiming(nebula) }).toPlace(DESTINATION).seconds, 420)

    const slowed = walkOf(search(GRAPH, 'time', crewed()).toPlace(DESTINATION), nebula)

    near(slowed.flight, 300)
    near(slowed.flightHi, 390, 1e-9)
    near(slowed.total.lo, 300)
    near(slowed.total.hi, 390)
    assert.deepEqual(slowed.wait, { lo: 0, hi: 0 }, 'the slow flight has run the delay down')

    const blindRoute = search(GRAPH, 'jumps', { speed: SPEED, speedIn: at(null, { 1: 500 }), shock: SHOCK, startDelay: 0 }).toPlace(DESTINATION)

    assert.equal(blindRoute.seconds, Infinity, 'a nebula the armour cannot be weighed against has no known time')

    const database = await memoryDatabase()

    try {
      assert.deepEqual({ ...await time.loadSystemDust(database, { GameID: 1, RaceID: 2 }) }, { 5: 500, 7: 200 })
      assert.deepEqual({ ...await time.loadSystemDust(database, { GameID: 2, RaceID: 2 }) }, { 8: 300 })
    } finally {
      database.close()
    }

    const bare = await memoryDatabase(false)

    try {
      assert.deepEqual({ ...await time.loadSystemDust(bare, { GameID: 1, RaceID: 2 }) }, {}, 'a save without the column has no dust')
    } finally {
      bare.close()
    }
  })

  add('hauling: the cycle of a fleet on Hauling flies its legs, stops at its orders and waits after each order that jumps, and the year divides that total', () => {
    const orders = [
      { label: 'A', SystemID: 1, ExitSystemID: 1, OrderDelay: 0 },
      { label: 'J1', SystemID: 1, ExitSystemID: 2, OrderDelay: 0, MoveActionID: 1 },
      { label: 'B', SystemID: 2, ExitSystemID: 2, OrderDelay: 0 },
      { label: 'J2', SystemID: 2, ExitSystemID: 1, OrderDelay: 0, MoveActionID: 1 },
    ]
    const route = { km: 9000, legs: [{ km: 5000 }, { km: 1000 }, { km: 2000 }, { km: 1000 }] }
    const handling = { seconds: 70, stops: [{ seconds: 30 }, { seconds: 0 }, { seconds: 40 }, { seconds: 0 }], blocked: [], unknown: [] }
    const timing = { shock: SHOCK, shockMissing: [], dust: {}, armour: 5 }
    const fleet = { Speed: SPEED, FuelPerHour: 0 }
    const walk = hauling.cycleWalk(orders, fleet, route, handling, timing)

    near(walk.flight, 90)
    near(walk.handling, 70)
    assert.equal(walk.jumps, 2)
    assert.deepEqual(walk.wait, { lo: 82, hi: 200 })
    assert.deepEqual(walk.total, { lo: 242, hi: 360 })
    near(simulate(walk.events, SHOCK.hi, { rounds: 3 }).total, 360)
    near(simulate(walk.events, SHOCK.lo, { rounds: 3 }).total, 242)

    const year = hauling.routeYear(fleet, route, { perTrip: { minerals: 1000, installations: 0, colonists: 0 } }, handling, 0, walk)

    near(year.cycleDays * 86400, 360)
    near(year.cycleLowDays * 86400, 242)
    near((year.movingDays + year.handlingDays + year.waitDays + year.transitDays) * 86400, 360)
    near(year.trips, 31536000 / 360)
    near(year.minerals, (31536000 / 360) * 1000)

    const lagrange = [orders[0], { ...orders[1], ExitSystemID: 1 }, orders[2], { ...orders[3], ExitSystemID: 2 }]
    const flat = hauling.cycleWalk(lagrange, fleet, route, handling, timing)

    assert.equal(flat.jumps, 0, 'a jump inside the system gives no shock')
    assert.deepEqual(flat.total, { lo: 160, hi: 160 })

    const delayed = hauling.cycleWalk(orders.map((order, index) => (index === 0 ? { ...order, OrderDelay: 100 } : order)), fleet, route, handling, timing)

    assert.deepEqual(delayed.total, { lo: 311, hi: 370 }, 'an order delay is time on the clock that runs the jump shock down')

    const blind = hauling.cycleWalk(orders, fleet, route, handling, { ...timing, shock: null, shockMissing: ['the crew of the fleet'] })

    assert.equal(blind.total, null)
    assert.ok(blind.missing.length > 0)
    assert.equal(hauling.routeYear(fleet, route, { perTrip: { minerals: 1, installations: 0, colonists: 0 } }, handling, 0, blind), null, 'a cycle with no known waits has no year')

    const results = hauling.routeResults(route, null, handling, blind)

    assert.equal(results.cycle.status, 'unavailable')
    assert.equal(results.wait.status, 'unavailable')
    assert.equal(results.freight.status, 'unavailable')
    assert.equal(hauling.cycleWalk(orders, { Speed: 0 }, route, handling, timing), null)
  })

  add('retry: a blocked transit retried at each subpulse makes the longest wait run up to two subpulses past the second the delay clears, and the shortest is that second, for every subpulse length the game runs', () => {
    const LENGTHS = [1, 5, 10, 20, 60, 120, 360, 900, 1800, 7200, 21600]
    const retry = time.RETRY_SLACK

    assert.equal(time.SUBPULSE_MAX, Math.max(...LENGTHS), 'the longest subpulse the game runs')
    assert.equal(retry, 2 * 21600)

    let widest = 0

    LENGTHS.forEach((length) => {
      ;[121, 150, 180].forEach((delay) => {
        ;[0, 30, 150, 500, 4000, 25000, 60000, 100000].forEach((flight) => {
          ;[0, 1, Math.floor(length / 2), length].forEach((phase) => {
            const stepped = subpulseWait({ delay, flight, length, phase })
            const walked = time.walkEvents([JUMP, fly(flight), JUMP], { lo: delay, hi: delay }, { startDelay: 0, retry })
            const wait = walked.events[2].wait
            const label = `delay ${delay}, flight ${flight}, subpulse ${length}, jump ${phase} s in`

            assert.ok(stepped >= wait.lo, `${label}: the game waits ${stepped} s, under the lowest ${wait.lo}`)
            assert.ok(stepped <= wait.hi, `${label}: the game waits ${stepped} s, over the longest ${wait.hi}`)

            if (length === 1) {
              assert.ok(stepped - wait.lo <= 1, `${label}: a one-second subpulse retries the second the delay clears`)
            }

            widest = Math.max(widest, stepped - Math.max(0, delay - flight))
          })
        })
      })
    })

    assert.ok(widest > 21600 + 180, 'the stepped game goes later than one subpulse past the delay, so one is not the allowance')

    const nothing = time.walkEvents([JUMP, fly(5), JUMP], { lo: 0, hi: 0 }, { startDelay: 0, retry })

    assert.deepEqual(nothing.wait, { lo: 0, hi: 0 }, 'a delay that holds nothing gains no allowance')

    const events = [JUMP, fly(1000), JUMP, fly(40)]
    const bare = time.walkEvents(events, SHOCK, { startDelay: 0 })
    const slow = time.walkEvents(events, SHOCK, { startDelay: 0, retry })

    assert.deepEqual(bare.wait, { lo: 0, hi: 0 })
    assert.deepEqual(slow.wait, { lo: 0, hi: SHOCK.hi + retry - 1000 })
    assert.deepEqual(slow.events[0].wait, { lo: 0, hi: 0 }, 'the first jump of a walk with no delay at the start waits for nothing')
    assert.deepEqual({ lo: slow.remaining.lo, hi: slow.remaining.hi }, { lo: bare.remaining.lo, hi: bare.remaining.hi }, 'the delay a walk leaves is the timer, the allowance apart')
    assert.deepEqual(slow.remaining, { lo: 81, hi: 140, ready: SHOCK.hi + retry - 40 }, 'the readiness bound carries the allowance, once')
    assert.equal(bare.remaining.ready, bare.remaining.hi, 'and a walk with no allowance has none')
    near(slow.total.hi - bare.total.hi, SHOCK.hi + retry - 1000)
    near(slow.total.lo, bare.total.lo)

    const started = time.walkEvents([fly(100), JUMP, fly(10)], SHOCK, { startDelay: { lo: 150, hi: 300 }, retry })

    assert.deepEqual(started.events[1].wait, { lo: 50, hi: 300 + retry - 100 }, 'a range carried from an earlier leg takes the allowance at its upper end')

    const timing = time.fleetTimingOf([participant()])

    assert.equal(timing.retry, retry, 'the timing of a fleet carries the allowance')
    assert.equal(time.searchTiming(timing).shock, SHOCK.hi + retry)
    assert.equal(time.searchTiming({ ...timing, startDelay: 300 }).startDelay, 300 + retry)
    assert.equal(time.searchTiming({ ...timing, startDelay: { lo: 100, hi: 300, ready: 500 } }).startDelay, 500, 'a range that carries its readiness bound is priced at it, without a second allowance')
    assert.equal(time.searchTiming({ ...timing, startDelay: { lo: 0, hi: 0, ready: 0 } }).startDelay, 0)
    assert.equal(time.searchTiming({ ...timing, startDelay: 0 }).startDelay, 0)
    assert.equal(time.searchTiming(crewed()).shock, SHOCK.hi, 'a timing without it takes none')

    const ranked = (extra) => through(search(GRAPH, 'time', crewed(extra)).toPlace(DESTINATION))

    assert.deepEqual(ranked({}), [5, 4], 'the longer route wins while the retry is the second the delay clears')
    assert.deepEqual(ranked({ retry: 100 }), [4], 'a retry that costs more makes the one-jump route the fastest, as the upper case ranks')
    near(search(GRAPH, 'time', crewed({ retry: 100 })).toPlace(DESTINATION).seconds, 250)
    near(search(GRAPH, 'time', crewed({ startDelay: 300, retry: 100 })).toPlace(DESTINATION).seconds, 450)

    const { ends, hull } = transportFixture()
    const route = search(GRAPH, 'km', crewed()).toPlace(DESTINATION)
    const steps = graph.routeLegs(route)
    const trip = transport.roundTrip([hull], route.km, ends, TECH, { colonists: true, version: VERSION, support: null, timing: { steps, dust: {}, armour: 5, shock: SHOCK, shockMissing: [], startDelay: 0, retry: 100 }, jumps: route.jumps })
    const cycle = [stop(trip.stops.filter((one) => one.where === 'origin').reduce((sum, one) => sum + one.seconds, 0)), ...steps.map((step) => (step.kind === 'fly' ? fly(step.km / SPEED) : JUMP)), stop(trip.stops.filter((one) => one.where === 'destination').reduce((sum, one) => sum + one.seconds, 0)), ...graph.reverseSteps(steps).map((step) => (step.kind === 'fly' ? fly(step.km / SPEED) : JUMP))]

    near(trip.tripSeconds, simulate(cycle, SHOCK.hi + 100, { rounds: 3 }).total)
    near(trip.tripSecondsLow, simulate(cycle, SHOCK.lo, { rounds: 3 }).total)
    near(trip.tripSeconds, trip.travelSeconds + trip.handlingSeconds + trip.transitSeconds + trip.waitSeconds.hi)

    const orders = [
      { label: 'A', SystemID: 1, ExitSystemID: 1, OrderDelay: 0 },
      { label: 'J1', SystemID: 1, ExitSystemID: 2, OrderDelay: 0, MoveActionID: 1 },
      { label: 'B', SystemID: 2, ExitSystemID: 2, OrderDelay: 0 },
      { label: 'J2', SystemID: 2, ExitSystemID: 1, OrderDelay: 0, MoveActionID: 1 },
    ]
    const legs = { km: 9000, legs: [{ km: 5000 }, { km: 1000 }, { km: 2000 }, { km: 1000 }] }
    const handling = { seconds: 70, stops: [{ seconds: 30 }, { seconds: 0 }, { seconds: 40 }, { seconds: 0 }], blocked: [], unknown: [] }
    const hauled = hauling.cycleWalk(orders, { Speed: SPEED, FuelPerHour: 0 }, legs, handling, { shock: SHOCK, shockMissing: [], dust: {}, armour: 5, retry: 100 })

    near(hauled.total.hi, simulate(hauled.events, SHOCK.hi + 100, { rounds: 3 }).total)
    near(hauled.total.lo, simulate(hauled.events, SHOCK.lo, { rounds: 3 }).total)
    assert.ok(hauled.wait.hi > hauled.wait.lo)
  })

  add('order: the persisted routes order accepts the third objective and the default stays the fewest jumps', async () => {
    const fields = await world.fields()

    assert.equal(fields.order.default, 'jumps')

    ;['jumps', 'km', 'time'].forEach((value) => assert.equal(fields.order.valid(value), true, value))
    ;['fastest', '', null, 3].forEach((value) => assert.equal(fields.order.valid(value), false, String(value)))

    const vm = instantiate(world.page, { $store: STORE, database: null, GameID: 1, RaceID: 2 })

    assert.deepEqual(vm.orders.map((option) => option.value), ['jumps', 'km', 'time'])
    assert.equal(vm.order, 'jumps')
    assert.equal(new Set(vm.orders.map((option) => option.label)).size, 3)
  })

  const pageOver = (over = {}) => {
    const stops = [
      { key: 'fleet:5', kind: 'fleet', name: 'Line', SystemID: 1, Xcor: 0, Ycor: 0, fleet: { FleetID: 5, FleetName: 'Line', Speed: SPEED, CanTransit: 1, AvoidDanger: 0, AvoidAlienSystems: 0 } },
      { key: 'body:9', kind: 'body', name: 'Venus', SystemID: 4, Xcor: DESTINATION.Xcor * SCALE, Ycor: 0 },
    ]
    const proxy = new Proxy({}, { get: (_target, key) => (key in (over.errors || {}) ? over.errors[key] : null), has: () => true })

    return instantiate(world.page, {
      $store: STORE,
      database: null,
      GameID: 1,
      RaceID: 2,
      data: {
        loadErrors: proxy,
        positionRead: null,
        classes: [],
        speed: SPEED,
        order: 'time',
        routeFleet: 'fleet:5',
        stopKeys: stops.map((one) => one.key),
        placeByKey: Object.fromEntries(stops.map((one) => [one.key, one])),
        extra: {},
        lazyState: {},
        avoidDetails: {},
        legNotes: {},
        cycle: false,
        jumpPoints: WIDE,
        lagrangePoints: [],
        systems: [],
        systemDust: {},
        systemNameOf: (id) => `System ${id}`,
        pointName: () => 'a point',
        lagrangeName: () => 'a Lagrange point',
        routeFleetShips: [ship()],
        ...over.data,
      },
    })
  }

  add('page: the Routes page offers the time order, ranks by it for a crewed fleet and lists each leg\'s flight, transit and wait so that they reconcile', () => {
    const vm = pageOver()

    assert.equal(vm.planOrder, 'time')
    assert.equal(vm.timeNotice, '')
    assert.equal(vm.plan.jumps, 2)
    near(vm.plan.km, 12000 * SCALE)
    near(vm.plan.time.total.hi, 61380)
    near(vm.plan.legs[0].route.seconds, vm.plan.time.total.hi, 1e-9)
    near(vm.plan.time.total.lo, 36000)
    assert.deepEqual(vm.plan.time.wait, { lo: 0, hi: 25380 }, 'the second jump waits the delay less the flight, with two of the longest subpulses on the upper case')
    near(vm.plan.time.flight + vm.plan.time.handling + vm.plan.time.transit + vm.plan.time.wait.hi, vm.plan.time.total.hi)
    assert.ok(vm.legHeaders.some((header) => header.value === 'wait') && vm.legHeaders.some((header) => header.value === 'flight') && vm.legHeaders.some((header) => header.value === 'transit'))

    const rows = vm.detailRows.filter((row) => row.flight !== undefined)

    near(rows.reduce((sum, row) => sum + row.flight, 0), vm.plan.time.flight)
    near(rows.reduce((sum, row) => sum + (row.wait ? row.wait.hi : 0), 0), vm.plan.time.wait.hi)
    near(rows.reduce((sum, row) => sum + (row.wait ? row.wait.lo : 0), 0), vm.plan.time.wait.lo)
    assert.ok(rows.filter((row) => row.transit === 0).length === 2, 'each flight that ends at a jump point is followed by its transit')

    const last = vm.detailRows[vm.detailRows.length - 1]

    assert.deepEqual(last.elapsed, { lo: vm.plan.time.total.lo, hi: vm.plan.time.total.hi })
    near(last.timeResult.value, 61380 / 86400)
    assert.equal(vm.planFigures.time.elapsed.status !== 'unavailable', true)
    near(vm.planFigures.time.elapsed.value, 61380 / 86400)
    assert.equal(vm.planFigures.time.wait.value, 25380)
    assert.equal(vm.plan.positions.mode, 'static', 'the plan states that it rests on the saved positions')

    const other = pageOver({ data: { order: 'km' } })

    assert.equal(other.plan.jumps, 3)
    near(other.plan.time.total.hi, 104760)
    const fewest = pageOver({ data: { order: 'jumps' } })

    assert.equal(fewest.plan.jumps, 1)
    near(fewest.plan.time.total.hi, 75000)
  })

  add('page: without a fleet the time order is not ranked and says so, and the waits and elapsed time are unavailable while the flight stays', () => {
    const blind = pageOver({ data: { routeFleet: null, routeFleetShips: [] } })

    assert.equal(blind.planOrder, 'km')
    assert.ok(blind.timeNotice.length > 0)
    assert.equal(blind.plan.jumps, 3, 'it follows the distance')
    assert.equal(blind.plan.time.total, null)
    assert.equal(blind.plan.time.wait, null)
    assert.ok(blind.plan.time.flight > 0)
    assert.equal(blind.planFigures.time.elapsed.status, 'unavailable')

    const last = blind.detailRows[blind.detailRows.length - 1]

    assert.ok(last.timeResult.status !== 'unavailable' && last.timeResult.inputs.missing.length > 0, 'the flight alone stays, as an estimate that names the crew')

    const stale = pageOver({ data: { routeFleetShips: [ship({ FleetID: 9 })] } })

    assert.equal(stale.crewTiming, null, 'the crew of another fleet is not the fleet\'s')
    assert.equal(stale.planOrder, 'km')

    const unread = pageOver({ data: { routeFleetShips: [ship({ GradePoints: null })] } })

    assert.equal(unread.planOrder, 'km')
    assert.ok(unread.crewState.length > 0)

    const jumps = pageOver({ data: { order: 'jumps', routeFleet: null, routeFleetShips: [] } })

    assert.equal(jumps.timeNotice, '')
    assert.equal(jumps.planOrder, 'jumps')

    const none = pageOver({ data: { speed: null } })

    assert.equal(none.plan.time, undefined, 'no speed gives no timed plan')
    assert.ok(none.timeNotice.length > 0)
  })

  add('page: a delay the fleet still carries is a stated start offset on the route and the first jump waits it out', () => {
    const vm = pageOver({ data: { routeFleetShips: [ship({ SensorDelay: 61000 })] } })

    assert.equal(vm.plan.time.startDelay, 61000)
    assert.deepEqual(through(vm.plan.legs[0].route), [4])
    near(vm.plan.time.total.hi, 119200)
    near(vm.plan.legs[0].route.seconds, vm.plan.time.total.hi, 1e-9)
    assert.deepEqual(vm.plan.time.wait, { lo: 1000, hi: 44200 })
    assert.deepEqual(vm.plan.time.remaining, { lo: 0, hi: 0, ready: 28380 }, 'the retry allowance the last jump leaves is carried on')

    const calm = pageOver()

    assert.equal(calm.plan.time.startDelay, 0)

    const unread = pageOver({ data: { routeFleetShips: [ship({ SensorDelay: null })] } })

    assert.equal(unread.plan.time.total, null)
  })

  add('page: a cap the fleet keeps past a jump makes the flight of a leg a range, and the clock of the table adds the ranges up to the elapsed time of the route', () => {
    const caps = { 1: 25 }
    const vm = pageOver({ data: { systemDust: { 1: 500 } } })
    const rows = vm.detailRows.filter((row) => row.flight !== undefined)
    const walked = vm.plan.time
    const steps = vm.plan.legs[0].steps.filter((step) => step.kind === 'fly' || step.kind === 'jump')

    // The seconds of each flight at the two cases, worked out here: the lowest at the cap of its system, the highest also at a cap held from a system before it until 21600 s of flight have gone.
    let held = null
    const lows = []
    const highs = []

    steps.forEach((step) => {
      if (step.kind === 'jump') {
        lows.push(JUMP)
        highs.push(JUMP)

        return
      }

      const own = caps[step.SystemID] || SPEED
      const budget = held ? held.budget : 0
      const speed = budget > 0 ? Math.min(held.speed, own) : own
      const seconds = step.km <= speed * budget ? step.km / speed : budget + (step.km - speed * budget) / own

      lows.push(fly(step.km / own))
      highs.push(fly(seconds))
      held = caps[step.SystemID] ? { speed, budget: 21600 } : budget > 0 && seconds < budget ? { speed: held.speed, budget: budget - seconds } : null
    })

    assert.ok(steps.some((step) => step.kind === 'jump') && steps.some((step) => step.kind === 'fly' && step.SystemID !== 1), 'the route leaves the capped system')
    near(walked.flight, lows.reduce((sum, event) => sum + (event.seconds || 0), 0))
    near(walked.flightHi, highs.reduce((sum, event) => sum + (event.seconds || 0), 0))
    assert.ok(walked.flightHi > walked.flight, 'the cap held past the jump lengthens the highest case')
    near(walked.total.lo, simulate(lows, SHOCK.lo).total)
    near(walked.total.hi, simulate(highs, SHOCK.hi + time.RETRY_SLACK).total)
    near(rows.reduce((sum, row) => sum + row.flight, 0), walked.flight)
    near(rows.reduce((sum, row) => sum + row.flightHi, 0), walked.flightHi)
    rows.forEach((row) => assert.equal(vm.flightText(row.flight, row.flightHi).includes(' to '), row.flight !== row.flightHi, 'a flight is a range exactly when its two cases differ'))
    assert.ok(rows.some((row) => row.flight !== row.flightHi))

    const last = vm.detailRows[vm.detailRows.length - 1]

    assert.deepEqual(last.elapsed, { lo: walked.total.lo, hi: walked.total.hi }, 'the clock of the table ends where the walk does')
    assert.equal(vm.flightText(undefined, undefined), '—')
    assert.equal(vm.flightText(null, null), '—')
  })

  const haulFixture = (actions = [1, 1]) => ({
    orders: [
      { label: 'A', SystemID: 1, ExitSystemID: 1, OrderDelay: 0 },
      { label: 'J1', SystemID: 1, ExitSystemID: 2, OrderDelay: 0, MoveActionID: actions[0] },
      { label: 'B', SystemID: 2, ExitSystemID: 2, OrderDelay: 0 },
      { label: 'J2', SystemID: 2, ExitSystemID: 1, OrderDelay: 0, MoveActionID: actions[1] },
    ],
    handling: { seconds: 70, stops: [{ seconds: 30 }, { seconds: 0 }, { seconds: 40 }, { seconds: 0 }], blocked: [], unknown: [] },
    fleet: { Speed: SPEED, FuelPerHour: 0 },
  })
  const legsOf = (...km) => ({ km: km.reduce((sum, value) => sum + value, 0), legs: km.map((value) => ({ km: value })) })
  const flightsOf = (walk) => walk.events.filter((event) => event.kind === 'fly').map((event) => event.km)

  add('legs: a cycle flown on moved bodies takes each leg at the distance the simulation flew it, so a flight between two jump points keeps its distance and a leg saved at 0 keeps its flight', () => {
    const { orders, handling, fleet } = haulFixture()
    const timing = { shock: SHOCK, shockMissing: [], dust: {}, armour: 5 }
    const moved = hauling.propagatedRoute(legsOf(5000, 1000, 2000, 1000), [[5000], [1000], [4000], [1000]])

    assert.deepEqual(moved.legs.map((leg) => leg.km), [5000, 1000, 4000, 1000])
    near(moved.km, 11000)

    const walk = hauling.cycleWalk(orders, fleet, moved, handling, timing)

    assert.deepEqual(flightsOf(walk), [5000, 1000, 4000, 1000], 'the leg between the jump points is flown at its own distance')
    near(walk.flight, 110)
    near(walk.km, 11000)
    near(walk.total.hi, simulate(walk.events, SHOCK.hi, { rounds: 3 }).total)

    const born = hauling.propagatedRoute(legsOf(5000, 0, 2000, 1000), [[5000], [1000], [2000], [1000]])
    const flown = hauling.cycleWalk(orders, fleet, born, handling, timing)

    assert.deepEqual(flightsOf(flown), [5000, 1000, 2000, 1000], 'a leg saved at 0 and flown at 1000 keeps its flight')
    near(flown.flight, 90)

    const { ends, hull } = transportFixture()
    const route = search(GRAPH, 'km', crewed()).toPlace(DESTINATION)
    const steps = graph.routeLegs(route)
    const out = [5000, 1000, 1000, 2000]
    const back = [3000, 1000, 1000, 4000]
    const trip = transport.roundTrip([hull], route.km, ends, TECH, { colonists: true, version: VERSION, support: null, timing: { steps, flights: { out, back }, dust: {}, armour: 5, shock: SHOCK, shockMissing: [], startDelay: 0 }, jumps: route.jumps })

    assert.deepEqual(flightsOf(trip.cycle), [...out, ...back], 'a cycle of Transport keeps the inter-jump flights of both ways')
    near(trip.travelSeconds, 180)
    near(trip.fuelSeconds, 180)

    const flights = [...out]
    const there = steps.map((step) => (step.kind === 'fly' ? fly(flights.shift() / SPEED) : JUMP))
    const returning = [...back]
    const home = graph.reverseSteps(steps).map((step) => (step.kind === 'fly' ? fly(returning.shift() / SPEED) : JUMP))
    const origin = trip.stops.filter((one) => one.where === 'origin').reduce((sum, one) => sum + one.seconds, 0)
    const destination = trip.stops.filter((one) => one.where === 'destination').reduce((sum, one) => sum + one.seconds, 0)

    near(trip.tripSeconds, simulate([stop(origin), ...there, stop(destination), ...home], SHOCK.hi, { rounds: 3 }).total)
  })

  add('fuel: a nebula that holds the fleet to a lower speed does not change the fuel, which is the distance at the set speed, so the range verdict and the year\'s fuel stand', () => {
    const { ends, hull } = transportFixture()
    const route = search(GRAPH, 'jumps', crewed()).toPlace(DESTINATION)
    const tight = { ...hull, FuelCapacity: 1.5 }
    const tripOver = (dust) => transport.roundTrip([tight], route.km, ends, TECH, { colonists: true, version: VERSION, support: null, timing: { steps: graph.routeLegs(route), dust, armour: 5, shock: SHOCK, shockMissing: [], startDelay: 0 }, jumps: route.jumps })
    const clear = tripOver({})
    const capped = tripOver({ 1: 250 })

    near(route.km, 25000)
    near(clear.travelSeconds, 500)
    near(capped.travelSeconds, 1000, 1e-9)
    near(capped.fuelPerShip, (10 * 1 * (2 * 25000 / SPEED)) / 3600)
    near(capped.fuelPerShip, clear.fuelPerShip)
    assert.equal(clear.status, 'ok')
    assert.equal(capped.status, 'ok', 'the tank holds the fuel of the distance, however slowly it is flown')

    const { orders, handling } = haulFixture()
    const fleet = { Speed: SPEED, FuelPerHour: 36 }
    const legs = legsOf(5000, 1000, 2000, 1000)
    const cargo = { perTrip: { minerals: 1, installations: 0, colonists: 0 } }
    const yearOver = (dust) => {
      const walk = hauling.cycleWalk(orders, fleet, legs, handling, { shock: SHOCK, shockMissing: [], dust, armour: 5 })

      return { walk, year: hauling.routeYear(fleet, legs, cargo, handling, 0, walk) }
    }
    const open = yearOver({})
    const slowed = yearOver({ 1: 250 })

    near(slowed.walk.flight, 150)
    near(slowed.year.fuel, 36 * (9000 / SPEED / 3600) * (31536000 / slowed.walk.total.hi))
    near(open.year.fuel, 36 * (9000 / SPEED / 3600) * (31536000 / open.walk.total.hi))
  })

  add('held: a fleet that is not set to its maximum speed keeps the lowest nebula cap for every leg of its cycle, and a fleet set to its maximum gets its speed back at the next pass over the fleet', () => {
    const { orders, fleet } = haulFixture()
    const handling = { seconds: 0, stops: [{ seconds: 0 }, { seconds: 0 }, { seconds: 0 }, { seconds: 0 }], blocked: [], unknown: [] }
    const legs = legsOf(1e7, 0, 1e7, 0)
    const base = { shock: SHOCK, shockMissing: [], dust: { 1: 500 }, armour: 5, retry: 0 }
    const held = hauling.cycleWalk(orders, fleet, legs, handling, { ...base, holdsSpeed: true })

    near(held.flight, 800000)
    near(held.km, 2e7)
    assert.ok(held.events.filter((event) => event.kind === 'fly').every((event) => event.maxSpeed === undefined), 'a fleet that holds its speed has no restore to bound')
    assert.deepEqual(held.total, { lo: 800000, hi: 800000 }, 'both legs at the cap of 25 km/s')

    const restored = hauling.cycleWalk(orders, fleet, legs, handling, base)

    near(restored.flight, 500000)
    near(restored.flightHi, 516200)
    assert.deepEqual(restored.total, { lo: 500000, hi: 516200 }, 'a fleet set to its maximum flies the second leg at its speed at the lowest case and at the cap for one longest subpulse at the highest')

    const calm = hauling.cycleWalk(orders, fleet, legs, handling, { ...base, dust: {}, holdsSpeed: true })

    near(calm.flight, 200000)

    const elsewhere = hauling.cycleWalk(orders, fleet, legs, handling, { ...base, dust: { 3: 500 }, holdsSpeed: true })

    near(elsewhere.flight, 200000)

    const blind = hauling.cycleWalk(orders, fleet, legs, handling, { ...base, armour: null, holdsSpeed: true })

    assert.equal(blind.total, null)
    assert.deepEqual(blind.missing, [time.nebulaGapOf({ holdsSpeed: true })])
    assert.notDeepEqual(blind.missing, [time.nebulaGapOf({})], 'the gap names the speed the nebula leaves')
    assert.equal(time.fleetTimingOf([participant()], {}, { holdsSpeed: true }).holdsSpeed, true)
    assert.equal(time.fleetTimingOf([participant()]).holdsSpeed, false)

    const year = hauling.routeYear({ ...fleet, FuelPerHour: 36 }, legs, { perTrip: { minerals: 1, installations: 0, colonists: 0 } }, handling, 0, held)

    near(year.fuel, 36 * (2e7 / SPEED / 3600) * (31536000 / 800000))

    const cycle = hauling.routeYear(fleet, legs, { perTrip: { minerals: 1, installations: 0, colonists: 0 } }, handling, 0, restored)

    near(cycle.movingDays * 86400, 516200)
    near((cycle.movingDays + cycle.handlingDays + cycle.waitDays + cycle.transitDays) * 86400, cycle.cycleDays * 86400)
  })

  add('carry: a fleet set to its maximum speed flies at the highest case at the lowest cap of the systems it was in during the last longest subpulse, since the game gives the speed back only at the next pass over the fleet, the lowest case takes it back at once, and a fleet that holds its speed flies the whole cycle at the lowest cap', () => {
    const maximumIn = (dust) => ({ speed: SPEED, speedIn: time.speedIn({ speed: SPEED, dust, armour: 5 }), shock: SHOCK, startDelay: 0 })
    const flights = (timing, ...each) => each.map(([km, system]) => time.flyEvent(km, system, timing))
    const walk = (events, options = {}) => time.walkEvents(events, SHOCK, { startDelay: 0, ...options })
    const clear = maximumIn({ 1: 500 })
    const [capped, outside] = flights(clear, [1000, 1], [1000, 2])

    assert.deepEqual([capped.capSpeed, capped.maxSpeed, outside.capSpeed, outside.maxSpeed], [25, SPEED, null, SPEED], 'a flight in a capped system names its cap, one outside none')

    const both = walk([capped, JUMP, outside])

    assert.deepEqual(both.total, { lo: 50, hi: 80 }, 'the clear flight after the jump is at the lowest case at the speed, at the highest at the cap the pass has not yet given back')
    assert.deepEqual([both.flight, both.flightHi, both.events[2].secondsHi], [50, 80, 40])
    assert.deepEqual(both.slow, [{ speed: 25, budget: time.SUBPULSE_MAX - 40 }], 'the cap that is left runs down by the flight')

    const [heldCapped, heldOutside] = flights({ ...clear, holdsSpeed: true, speedIn: time.heldSpeedIn({ speed: SPEED, dust: { 1: 500 }, armour: 5, systems: [1, 2] }) }, [1000, 1], [1000, 2])

    assert.equal(heldCapped.maxSpeed, undefined, 'a fleet that is not set to its maximum speed has no restore to bound')
    assert.deepEqual(walk([heldCapped, JUMP, heldOutside]).total, { lo: 80, hi: 80 }, 'the cap it holds is exact in both cases')

    const long = walk([capped, JUMP, time.flyEvent(1e6, 2, clear)])

    assert.deepEqual(long.total, { lo: 10040, hi: 26240 }, 'the pass gives the speed back after one longest subpulse: 21600 s at 25 km/s, then the speed')
    assert.deepEqual(long.slow, [], 'and a flight that outlasts the cap leaves none')

    const stopped = (seconds) => walk([capped, JUMP, stop(seconds), outside])

    assert.deepEqual(stopped(10000).total, { lo: 10050, hi: 10080 }, 'a stop that leaves part of the pass keeps the cap for the rest')
    assert.deepEqual(stopped(30000).total, { lo: 30050, hi: 30050 }, 'a stop longer than the pass has the speed back for the next flight')
    assert.deepEqual(walk([capped, JUMP, stop(20000), time.flyEvent(1e5, 2, clear)]).total, { lo: 21040, hi: 22240 }, 'a stop runs the cap down: 1600 s of it are left, then the speed')

    const waited = walk([capped, JUMP, outside, JUMP, time.flyEvent(1e5, 2, clear)], { retry: time.RETRY_SLACK })

    assert.deepEqual(waited.total, { lo: 1161, hi: 44420 }, 'the wait at a jump runs the cap down too: the pass has come round before the last flight')

    const [opening, inside, after] = flights(clear, [1000, 2], [1000, 1], [1e5, 2])

    assert.deepEqual(walk([opening, JUMP, inside, JUMP, after], { retry: time.RETRY_SLACK }).total, { lo: 1131, hi: 47390 }, 'a wait at a jump point in a dust system keeps the cap a whole subpulse past the transit, as the pass that lets the fleet transit sets it there: the last flight is 4,000 s at 25 km/s')

    const second = maximumIn({ 1: 500, 2: 250 })
    const cycle = flights(second, [100000, 1], [100000, 2])
    const around = walk([cycle[0], JUMP, cycle[1], JUMP], { cyclic: true })
    const heldAround = flights({ ...second, holdsSpeed: true, speedIn: time.heldSpeedIn({ speed: SPEED, dust: { 1: 500, 2: 250 }, armour: 5, systems: [1, 2] }) }, [100000, 1], [100000, 2])
    const held = walk([heldAround[0], JUMP, heldAround[1], JUMP], { cyclic: true })

    assert.deepEqual(around.total, { lo: 6000, hi: 8000 }, 'a cycle through two capped systems: each at its own cap at the lowest case, the second at the cap held from the first at the highest')
    assert.deepEqual(held.total, { lo: 8000, hi: 8000 }, 'the fleet that holds its speed flies both at the lowest cap')
    assert.equal(held.flight, around.flightHi, 'switching a fleet to its maximum speed leaves the highest case where the held speed put it')
    assert.ok(around.flight < held.flight)

    const next = walk([cycle[0], JUMP, time.flyEvent(2e6, 2, second)])

    assert.deepEqual(next.total, { lo: 44000, hi: 54800 }, 'the next pass gives the speed back inside a capped system too: the cap it leaves is its own')

    const [higher, lower] = flights(second, [1000, 2], [1000, 1])

    assert.deepEqual(walk([higher, JUMP, lower]).total, { lo: 60, hi: 60 }, 'a cap held above the cap of the system flown leaves the fleet at the system\'s cap')

    const [entered, half, otherHalf, whole] = flights(second, [1000, 1], [5e5, 2], [5e5, 2], [1e6, 2])
    const unsplit = walk([entered, JUMP, whole])

    assert.deepEqual(unsplit.total, { lo: 20040, hi: 30840 }, 'a cap held from a thicker nebula flies on in a thinner one until the pass: 21600 s at 25 km/s, then 50 km/s')
    assert.deepEqual(walk([entered, JUMP, half, otherHalf]).total, unsplit.total, 'the flight split in two keeps the held cap running down: the thinner nebula does not set it again')
    assert.deepEqual(walk([entered, JUMP, half]).slow, [{ speed: 25, budget: time.SUBPULSE_MAX - 20000 }], 'the half that keeps the cap leaves what is left of it')

    // A crew at twice the performance draws no shock, so no wait lets a pass come round at a jump: 40,000 km under the cap of 25 km/s, 500,050 km under the cap of 50 km/s, then 1,000,000 km in a clear system. A pass in the second system can set its cap one second before the fleet leaves, and that cap holds through most of the clear flight while the older, lower one runs out first.
    const swift = { ...second, ...time.fleetTimingOf([participant({ GradePoints: 12100 })], { 1: 500, 2: 250 }) }
    const three = flights(swift, [40000, 1], [500050, 2], [1e6, 3])
    const across = time.walkEvents([three[0], JUMP, three[1], JUMP, three[2]], swift.shock, { startDelay: swift.startDelay, retry: swift.retry })
    const stepped = (legs) => Array.from({ length: 217 }, (_, index) => passStepped(legs, { speed: SPEED, length: time.SUBPULSE_MAX, phase: index * 100 }))
    const passes = stepped([{ km: 40000, cap: 25 }, { km: 500050, cap: 50 }, { km: 1e6, cap: null }])

    assert.deepEqual([swift.shock, swift.startDelay, swift.retry], [{ lo: 0, hi: 0 }, 0, time.RETRY_SLACK], 'the fleet\'s own timing: no shock, no delay at the start, the allowance of the retry')
    assert.deepEqual(across.total, { lo: 21601, hi: 42401 }, 'the highest case flies the clear system 1,598 s at 25 km/s, then at 50 km/s until a subpulse after the transit')
    near(passes[0], 41601)
    assert.deepEqual(passes.filter((seconds) => seconds < across.total.lo || seconds > across.total.hi), [], 'the game\'s clock stepped by pass falls within the range at every phase of the passes')
    assert.deepEqual(time.walkEvents([three[0], JUMP, ...flights(swift, [250000, 2], [250050, 2]), JUMP, ...flights(swift, [3e5, 3], [7e5, 3])], swift.shock, { startDelay: 0, retry: swift.retry }).total, across.total, 'split anywhere, the flights keep both caps running down')

    const blind = flights({ ...clear, speedIn: time.speedIn({ speed: SPEED, dust: { 1: 500 }, armour: null }) }, [1000, 1], [1000, 2])

    assert.equal(walk([blind[0], JUMP, blind[1]]).total, null, 'a cap that cannot be weighed has no time at either case')
    assert.equal(walk([blind[0], JUMP, blind[1]]).flightHi, null)
  })

  add('unweighed: a nebula whose cap is not known (no armour in the save) or is 0 caps a fleet set to its maximum speed that only crosses it, flying no distance there: the walk has no highest case for the flight after the transit out, the search no time for that way, and the plan names the nebula as what the total lacks', () => {
    const points = [...pair(101, 301, [3000, 0], [2000, 0]), ...pair(102, 201, [1000, 0], [1000, 0]), ...pair(202, 302, [1000, 0], [1000, 0])]
    const origin = { SystemID: 1, Xcor: 1000, Ycor: 0 }
    const target = { SystemID: 3, Xcor: 2000, Ycor: 0 }
    const timingOf = (armour, dust) => ({ speed: SPEED, speedIn: time.speedIn({ speed: SPEED, dust, armour }), shock: { lo: 0, hi: 0 }, shockMissing: [], startDelay: 0 })
    const fastest = (timing) => search(points, 'time', timing, origin).toPlace(target)
    const shortest = (timing) => search(points, 'km', timing, origin).toPlace(target)
    const crossing = (walk) => walk.events.find((event) => event.kind === 'fly' && event.step.SystemID === 2)
    const planned = (timing) => plan.planRoute([{ key: 'body:1', kind: 'body', name: 'Place 1', ...origin }, { key: 'body:2', kind: 'body', name: 'Place 2', ...target }], { cycle: false, jumpPoints: points, order: 'km', timing })
    const weighed = timingOf(5, { 2: 500 })
    const weighedWalk = walkOf(shortest(weighed), weighed)

    assert.deepEqual(through(fastest(weighed)), [3], 'the way through the nebula is the shorter but not the faster: 1,000 km at its cap of 25 km/s held past the transit')
    near(fastest(weighed).seconds, 20)
    assert.deepEqual(through(shortest(weighed)), [2, 3])
    assert.deepEqual([crossing(weighedWalk).km, crossing(weighedWalk).capSpeed], [0, 25])
    assert.deepEqual(weighedWalk.total, { lo: 10, hi: 40 })
    assert.deepEqual(planned(weighed).time.total, { lo: 10, hi: 40 })

    for (const [label, timing] of [['no armour known', timingOf(null, { 2: 500 })], ['a cap of 0', timingOf(5, { 2: 20000 })]]) {
      const walk = walkOf(shortest(timing), timing)
      const whole = planned(timing)

      assert.deepEqual(through(fastest(timing)), [3], `${label}: the search takes the way with a known time`)
      near(fastest(timing).seconds, 20)
      assert.deepEqual(through(shortest(timing)), [2, 3], label)
      assert.deepEqual([crossing(walk).km, crossing(walk).seconds, crossing(walk).capSpeed], [0, 0, 0], `${label}: the crossing takes no time and names a cap of no known speed`)
      assert.deepEqual([walk.flight, walk.flightHi, walk.total], [10, null, null], `${label}: the flight after the transit has its lowest case and no highest`)
      assert.deepEqual([whole.time.flight, whole.time.flightHi, whole.time.total, whole.time.missing], [10, null, null, [time.NEBULA_GAP]], label)
    }
  })

  add('ready: a stop on the way splits a route without changing its time, as the readiness bound of the retry and the cap a leg ends in carry into the next leg and the allowance is charged once', () => {
    const body = (id, system, x) => ({ key: `body:${id}`, kind: 'body', name: `Place ${id}`, SystemID: system, Xcor: x, Ycor: 0 })
    const start = body(1, 1, 0)
    const end = { key: 'system:3', kind: 'system', name: 'Three', SystemID: 3 }
    const retry = time.RETRY_SLACK
    const route = (jumpPoints, timing, ...between) => plan.planRoute([start, ...between, end], { cycle: false, jumpPoints, order: 'km', timing: { ...timing, retry } })
    const bounds = [...pair(101, 201, [1000, 0], [0, 0]), ...pair(202, 301, [30000, 0], [0, 0])]

    const direct = route(bounds, crewed())

    assert.deepEqual(direct.time.total, { lo: 310, hi: 43390 })

    const split = route(bounds, crewed(), body(2, 2, 20000))

    assert.deepEqual(split.time.total, direct.time.total, 'a stop on the path changes neither end of the time')
    assert.deepEqual(split.time.wait, direct.time.wait)
    assert.equal(split.km, direct.km)
    assert.deepEqual(time.carriedDelay(split.legs[0].time), { lo: 0, hi: 0, ready: 43180 }, 'the raw delay has run out, the readiness bound has not')
    assert.deepEqual(split.legs[1].time.wait, { lo: 0, hi: 43080 }, 'the second leg still waits for the retry the first leg left')

    const several = route(bounds, crewed(), body(2, 2, 10000), body(3, 2, 20000), body(4, 2, 25000))

    assert.deepEqual(several.time.total, direct.time.total, 'and so do several')
    assert.deepEqual(several.time.remaining, direct.time.remaining)

    const wide = [...pair(101, 201, [1000, 0], [0, 0]), ...pair(202, 301, [5e6, 0], [0, 0])]
    const whole = route(wide, crewed())

    assert.deepEqual(whole.time.total, { lo: 50010, hi: 50010 }, 'a flight longer than the readiness bound waits for nothing')

    const past = route(wide, crewed(), body(2, 2, 4.9e6))

    assert.deepEqual(past.time.total, whole.time.total)
    assert.deepEqual(time.carriedDelay(past.legs[0].time), { lo: 0, hi: 0, ready: 0 }, 'a bound that has passed carries none')
    assert.deepEqual(past.legs[1].time.wait, { lo: 0, hi: 0 })

    const partway = route(wide, crewed(), body(2, 2, 3e6))

    assert.deepEqual(partway.time.total, whole.time.total)
    assert.deepEqual(time.carriedDelay(partway.legs[0].time), { lo: 0, hi: 0, ready: 13380 }, 'a bound that has not passed carries what is left of it')

    const started = time.walkEvents([time.flyEvent(10000, 1, crewed()), JUMP, time.flyEvent(1000, 2, crewed())], SHOCK, { startDelay: { lo: 150, hi: 300, ready: 400 }, retry })

    assert.deepEqual(started.events[1].wait, { lo: 50, hi: 300 }, 'a range that carries its readiness bound waits for it as it is: the allowance is not added again')
    assert.deepEqual(started.remaining, { lo: 111, hi: 170, ready: SHOCK.hi + retry - 10 })

    const nebula = { ...crewed(), speedIn: time.speedIn({ speed: SPEED, dust: { 1: 500 }, armour: 5 }) }
    const capped = route(bounds, nebula)

    assert.deepEqual(capped.time.total, { lo: 340, hi: 43420 }, 'a cap the fleet keeps lengthens the highest case of the flight after the jump')

    const cappedSplit = route(bounds, nebula, body(2, 2, 20000))

    assert.deepEqual(cappedSplit.time.total, capped.time.total, 'and the cap a leg ends in carries into the next leg')
    assert.deepEqual(cappedSplit.time.flightHi, capped.time.flightHi)
    assert.deepEqual(cappedSplit.legs[0].time.slow, [{ speed: 25, budget: time.SUBPULSE_MAX - 800 }])

    const thinner = { ...crewed(), speedIn: time.speedIn({ speed: SPEED, dust: { 1: 500, 2: 250 }, armour: 5 }) }
    const into = (...between) => plan.planRoute([start, ...between, body(9, 2, 1e6)], { cycle: false, jumpPoints: bounds, order: 'km', timing: { ...thinner, retry } })
    const held = into()

    assert.deepEqual(held.time.total, { lo: 20040, hi: 30840 }, 'the cap of system 1 held into the thinner nebula of system 2 until the pass')
    assert.deepEqual(into(body(2, 2, 5e5)).time.total, held.time.total, 'a stop inside the thinner nebula keeps the held cap running down, not set again')
    assert.deepEqual(into(body(2, 2, 2.5e5), body(3, 2, 5e5), body(4, 2, 7.5e5)).time.total, held.time.total, 'and so do several')

    const swift = { ...thinner, ...time.fleetTimingOf([participant({ GradePoints: 12100 })], { 1: 500, 2: 250 }) }
    const beyond = (order, ...between) => plan.planRoute([start, ...between, body(9, 3, 1e6)], { cycle: false, jumpPoints: bounds, order, timing: swift })

    ;['km', 'time'].forEach((order) => {
      const two = beyond(order)

      assert.deepEqual(two.time.total, { lo: 10640, hi: 27140 }, `${order}: with no shock the clear system 3 is flown 20,400 s at the cap of system 1, then 1,200 s at the cap of system 2, then at the speed`)
      assert.deepEqual(beyond(order, body(2, 2, 15000), body(3, 3, 5e5)).time.total, two.time.total, `${order}: stops in system 2 and in system 3 carry both caps into the next leg`)
    })
  })

  add('caps: the fastest time prices each flight at the caps the walk flies it at, and a jump point keeps a later state that holds no cap, or a cap that runs out sooner, beside an earlier one, so the time it finds is the highest case of the walk of its route and no faster route is dropped, whatever the shock', () => {
    const retry = time.RETRY_SLACK
    const walkHi = (route, timing) => time.walkEvents(time.routeEvents(graph.routeLegs(route), timing), SHOCK, { startDelay: 0, retry }).total.hi

    // Two ways to (400000, 0) of system 4: through the nebula of system 2, whose cap the fleet still holds for the flight in system 4, or straight from the origin's system.
    const nebula = { ...crewed(), speedIn: time.speedIn({ speed: SPEED, dust: { 2: 500 }, armour: 5 }), retry }
    const ways = [...pair(101, 201, [100, 0], [0, 0]), ...pair(202, 401, [1250000, 0], [0, 0]), ...pair(102, 402, [-5600000, 0], [0, 0])]
    const place = { SystemID: 4, Xcor: 400000, Ycor: 0 }
    const fastest = search(ways, 'time', nebula).toPlace(place)
    const shortest = search(ways, 'km', nebula).toPlace(place)

    assert.deepEqual(through(fastest), [4], 'the way straight from the origin\'s system wins')
    near(fastest.seconds, 60000)
    near(walkHi(fastest, nebula), fastest.seconds)
    assert.deepEqual(through(shortest), [2, 4])
    near(walkHi(shortest, nebula), 66001)
    near(time.walkEvents(time.routeEvents(graph.routeLegs(shortest), nebula), SHOCK, { startDelay: 0, retry }).total.lo, 54001)

    const planned = plan.planRoute([{ key: 'body:1', kind: 'body', name: 'Start', SystemID: 1, Xcor: 0, Ycor: 0 }, { key: 'body:2', kind: 'body', name: 'End', ...place }], { cycle: false, jumpPoints: ways, order: 'time', timing: nebula })

    assert.deepEqual(planned.time.total, { lo: 60000, hi: 60000 }, 'and the plan takes it')

    // Through the nebula of system 2, then a short flight in system 3 and the wait for the shock there: the cap of system 2 runs out in that wait, so system 4 is flown at the speed.
    const waitedOut = search([...pair(101, 201, [100, 0], [0, 0]), ...pair(202, 301, [1000, 0], [0, 0]), ...pair(302, 401, [1000, 0], [0, 0])], 'time', nebula).toPlace({ SystemID: 4, Xcor: 1e6, Ycor: 0 })

    near(waitedOut.seconds, 96761)
    near(walkHi(waitedOut, nebula), waitedOut.seconds)

    // A crew at twice the performance draws no shock, so only the caps tell the ways apart. Two ways to (100000, 0) of system 5: straight from the origin's system into system 3, then through the nebula of system 4, or round through the thicker nebula of system 2 first. The cap of system 2 runs out in system 4, which sets its own as the fleet leaves it, so the way round is the slower at the highest case.
    const swiftIn = (dust) => ({ ...crewed(), speedIn: time.speedIn({ speed: SPEED, dust, armour: 5 }), ...time.fleetTimingOf([participant({ GradePoints: 12100 })], dust) })
    const zeroWalk = (route, timing) => time.walkEvents(time.routeEvents(graph.routeLegs(route), timing), timing.shock, { startDelay: timing.startDelay, retry: timing.retry }).total
    const fork = swiftIn({ 2: 500, 4: 250 })
    const around = [...pair(102, 201, [0, 0], [0, 0]), ...pair(202, 302, [1000, 0], [-535000, 0]), ...pair(303, 401, [0, 0], [0, 0]), ...pair(402, 501, [5000, 0], [0, 0])]
    const target = { SystemID: 5, Xcor: 100000, Ycor: 0 }
    const quickest = search([...pair(101, 301, [2139000, 0], [0, 0]), ...around], 'time', fork).toPlace(target)
    const roundabout = search(around, 'time', fork).toPlace(target)

    assert.deepEqual(fork.shock, { lo: 0, hi: 0 })
    assert.deepEqual(through(quickest), [3, 4, 5], 'the straight way wins')
    near(quickest.seconds, 23490)
    assert.deepEqual(zeroWalk(quickest, fork), { lo: 22490, hi: 23490 })
    assert.deepEqual(through(roundabout), [2, 3, 4, 5])
    near(roundabout.seconds, 23640)
    assert.deepEqual(zeroWalk(roundabout, fork), { lo: 6490, hi: 23640 }, 'the way round holds the cap of system 4 into system 5')

    // Two ways to the jump point 303 of the clear system 3, out to system 4: through the nebula of system 2, there at 40 s and holding its cap a subpulse, or straight across the origin's system, there at 10,000 s and holding none. The jump point keeps both, and the later one is the faster to (1000000, 0) of system 4.
    const late = swiftIn({ 2: 500 })
    const both = search([...pair(102, 201, [0, 0], [0, 0]), ...pair(202, 301, [1000, 0], [0, 0]), ...pair(103, 302, [1e6, 0], [0, 0]), ...pair(303, 401, [0, 0], [0, 0])], 'time', late)
    const uncapped = both.toPlace({ SystemID: 4, Xcor: 1e6, Ycor: 0 })

    assert.deepEqual(through(both.toSystem(4)), [2, 3, 4], 'the way through the nebula reaches system 4 first')
    near(both.toSystem(4).seconds, 40)
    assert.deepEqual(through(uncapped), [3, 4], 'the later way with no cap is the faster further on')
    near(uncapped.seconds, 20000)
    assert.deepEqual(zeroWalk(uncapped, late), { lo: 20000, hi: 20000 })

    // Two ways to the same jump point 303, each through a nebula with the cap of 25 km/s: through system 2, there at 160 s and holding the cap until 21,760 s, or through system 5, left at once and 8,000 km of system 3 flown at the cap, there at 320 s and holding it until 21,600 s. The later one's cap runs out sooner, the jump point keeps both, and the later one is the faster to (1000000, 0) of system 4.
    const twice = swiftIn({ 2: 500, 5: 500 })
    const sooner = search([...pair(102, 201, [0, 0], [0, 0]), ...pair(202, 301, [4000, 0], [0, 0]), ...pair(105, 501, [0, 0], [0, 0]), ...pair(502, 302, [0, 0], [-8000, 0]), ...pair(303, 401, [0, 0], [0, 0])], 'time', twice)
    const shorterCap = sooner.toPlace({ SystemID: 4, Xcor: 1e6, Ycor: 0 })

    assert.deepEqual(through(sooner.toSystem(4)), [2, 3, 4])
    near(sooner.toSystem(4).seconds, 160)
    assert.deepEqual(through(shorterCap), [5, 3, 4], 'the later way whose cap runs out sooner is the faster further on')
    near(shorterCap.seconds, 26280)
    assert.deepEqual(zeroWalk(shorterCap, twice), { lo: 10080, hi: 26280 })
  })

  add('optimal: on graphs drawn at random with nebulae, the fastest time finds a route whose time is the highest case of its own walk and that no walk of up to four jumps beats, with the retry\'s allowance on the shock, without it and for a crew that draws no shock, and with no shock the game\'s clock stepped by pass falls within that walk\'s range at every phase', () => {
    let seed = 86015
    const random = () => {
      seed = (seed * 48271) % 2147483647

      return seed / 2147483647
    }
    const below = (count) => Math.floor(random() * count)
    const at = () => Math.round((random() * 2 - 1) * 2e6)
    const apart = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)
    const wrong = []
    const zero = time.fleetTimingOf([participant({ GradePoints: 12100 })])

    assert.deepEqual([zero.shock, zero.retry], [{ lo: 0, hi: 0 }, time.RETRY_SLACK], 'a crew at twice the performance draws no shock, and its timing carries the allowance of the retry')

    for (let round = 0; round < 80; round++) {
      const dust = Object.fromEntries([1, 2, 3, 4, 5].filter(() => random() < 0.6).map((system) => [system, [250, 500, 1000][below(3)]]))
      const points = []

      for (let link = 0; link < 7; link++) {
        const [a, b] = [1 + below(5), 1 + below(5)]
        const id = 1000 + 2 * link

        if (a !== b) {
          points.push(jp(id, a, id + 1, at(), at()), jp(id + 1, b, id, at(), at()))
        }
      }

      const origin = { SystemID: 1, Xcor: at(), Ycor: at() }
      const place = { SystemID: 1 + below(5), Xcor: at(), Ycor: at() }

      ;[{ shock: SHOCK, retry: time.RETRY_SLACK }, { shock: SHOCK, retry: 0 }, { shock: zero.shock, retry: zero.retry }].forEach(({ shock, retry }) => {
        const timing = { ...crewed(), shock, speedIn: time.speedIn({ speed: SPEED, dust, armour: 5 }), retry }
        const walked = (events) => time.walkEvents(events, shock, { startDelay: 0, retry }).total.hi
        const found = graph.searchRoutes(points, [origin], { order: 'time', timing: time.searchTiming(timing) }).toPlace(place)
        let best = Infinity
        const extend = (from, events, jumps) => {
          if (from.SystemID === place.SystemID) {
            best = Math.min(best, walked([...events, time.flyEvent(apart(from, place), place.SystemID, timing)]))
          }

          if (jumps < 4) {
            points.filter((exit) => exit.SystemID === from.SystemID && exit !== from).forEach((exit) => extend(points.find((one) => one.WarpPointID === exit.WPLink), [...events, time.flyEvent(apart(from, exit), from.SystemID, timing), JUMP], jumps + 1))
          }
        }

        extend(origin, [], 0)

        const own = found ? walked(time.routeEvents(graph.routeLegs(found), timing)) : Infinity
        const agrees = found ? Math.abs(found.seconds - own) <= 1e-9 * Math.max(1, own) && found.seconds <= best + 1e-9 * Math.max(1, best) : best === Infinity

        if (!agrees) {
          wrong.push({ round, shock: shock.hi, retry, found: found && found.seconds, own, best })
        }

        if (found && shock.hi === 0) {
          const range = time.walkEvents(time.routeEvents(graph.routeLegs(found), timing), shock, { startDelay: 0, retry }).total
          const legs = graph.routeLegs(found).filter((step) => step.kind === 'fly').map((step) => ({ km: step.km, cap: dust[step.SystemID] ? Math.trunc(12500 / dust[step.SystemID]) : null }))
          const outside = Array.from({ length: 24 }, (_, index) => passStepped(legs, { speed: SPEED, length: time.SUBPULSE_MAX, phase: index * 900 })).filter((seconds) => seconds < range.lo * (1 - 1e-9) || seconds > range.hi * (1 + 1e-9))

          if (outside.length) {
            wrong.push({ round, stepped: outside, range })
          }
        }
      })
    }

    assert.deepEqual(wrong, [], 'the search and the walks agree on every graph')
  })

  add('transit: an order is timed by its action id: a standard transit draws the standard window, a squadron transit its own and states the scatter it leaves out, and any other transit is not timed', () => {
    const timing = { ...time.fleetTimingOf([participant()]), retry: 0 }
    const legs = legsOf(5000, 1000, 2000, 1000)
    const walkOver = (actions) => {
      const { orders, handling, fleet } = haulFixture(actions)

      return hauling.cycleWalk(orders, fleet, legs, handling, timing)
    }

    assert.deepEqual(timing.squadronShock, { lo: 11, hi: 30 })
    assert.equal(time.transitModeOf(1), 'standard')
    assert.equal(time.transitModeOf(37), 'squadron')

    const standard = walkOver([1, 1])

    assert.deepEqual(standard.total, { lo: 242, hi: 360 })
    assert.deepEqual(standard.assumptions, [])

    const squadron = walkOver([37, 37])

    assert.deepEqual(squadron.total, { lo: 160, hi: 160 }, 'both shocks run out within the flights and stops')
    assert.deepEqual(squadron.assumptions, [time.SQUADRON_ASSUMPTION])
    assert.deepEqual(walkOver([1, 37]).total, { lo: 211, hi: 270 }, 'the first jump follows a squadron transit, the second a standard one')
    assert.deepEqual(walkOver([37, 1]).total, { lo: 191, hi: 250 })

    const third = walkOver([1, 1])

    assert.deepEqual(third.wait, { lo: 82, hi: 200 })

    for (const [actions, labels] of [[[183, 183], ['J1', 'J2']], [[94, 1], ['J1']], [[1, undefined], ['J2']], [[37, 183], ['J2']]]) {
      const walk = walkOver(actions)

      assert.equal(walk.total, null, `${actions}: not timed`)
      assert.equal(walk.missing.length, labels.length)
      labels.forEach((label, index) => assert.ok(walk.missing[index].includes(`order ${label},`), walk.missing[index]))
    }

    const { handling } = haulFixture()
    const results = hauling.routeResults(legs, null, handling, walkOver([183, 183]))

    assert.equal(results.cycle.status, 'unavailable')
    assert.deepEqual(results.cycle.inputs.missing, walkOver([183, 183]).missing)
    assert.equal(results.wait.status, 'unavailable')

    const last = time.walkEvents([fly(10), { kind: 'jump', unsupported: true, label: 'J' }, fly(10)], SHOCK, { startDelay: 0 })

    assert.equal(last.total, null, 'a walk that ends on a transit that is not timed has no total')
    assert.equal(last.unsupported.length, 1)
    assert.deepEqual(time.unsupportedGaps(last).length, 1)
  })

  add('gate: crew rows kept while the fleet\'s ships are read again or the read failed give no crew timing, so no shock is known and the order falls back', () => {
    const settled = pageOver()

    assert.ok(settled.crewTiming && settled.crewTiming.shock)

    for (const errors of [{ routeFleetShips: undefined }, { routeFleetShips: 'the read failed' }]) {
      const vm = pageOver({ errors })

      assert.equal(vm.crewTiming, null, String(errors.routeFleetShips))
      assert.equal(vm.timing.shock, null)
      assert.equal(vm.planOrder, 'km')
      assert.equal(vm.plan.time.total, null)
    }
  })

  add('distance: under the fastest time the distance table gives each system the elapsed time of the route it lists, the flights and the waits of that route, and no time where a nebula cannot be weighed', () => {
    const systems = [3, 4, 5].map((id) => ({ SystemID: id, Name: `System ${id}` }))
    const rowOf = (view, id) => view.distanceRows.find((row) => row.SystemID === id)
    const expectedOf = (id, extra = {}) => {
      const route = search(WIDE, 'time', crewed({ retry: 43200, ...extra })).toSystem(id)
      const events = eventsOf(route, crewed(extra))

      return { route, lo: simulate(events, SHOCK.lo).total, hi: simulate(events, SHOCK.hi + 43200).total }
    }
    const vm = pageOver({ data: { systems } })

    for (const id of [3, 4, 5]) {
      const expected = expectedOf(id)
      const row = rowOf(vm, id)

      assert.equal(row.timed, true)
      near(row.elapsed.hi, expected.hi)
      near(row.elapsed.lo, expected.lo)
      near(row.timeResult.value, expected.hi / 86400)
    }

    assert.ok(rowOf(vm, 4).elapsed.hi > rowOf(vm, 4).route.km / SPEED, 'the waits are in the time of the row, which the flight alone is not')

    const byKm = pageOver({ data: { systems, order: 'km' } })

    assert.equal(rowOf(byKm, 4).timed, false, 'another order keeps the flight alone')
    assert.equal(rowOf(byKm, 4).elapsed, null)

    const dusty = pageOver({ data: { systems, systemDust: { 1: 500 }, routeFleetShips: [ship({ ArmourThickness: null })] } })

    assert.equal(rowOf(dusty, 4).timed, true)
    assert.equal(rowOf(dusty, 4).elapsed, null, 'a nebula whose cap cannot be weighed gives no time')
    assert.equal(rowOf(dusty, 4).timeResult.status, 'unavailable')

    const late = pageOver({ data: { systems, routeFleetShips: [ship({ SensorDelay: 61000 })] } })
    const lateEvents = eventsOf(search(WIDE, 'time', crewed({ retry: 43200, startDelay: 61000 })).toSystem(4), crewed())

    near(rowOf(late, 4).elapsed.hi, simulate(lateEvents, SHOCK.hi + 43200, { startDelay: 61000 + 43200 }).total, 1e-9)
    near(rowOf(late, 4).elapsed.lo, simulate(lateEvents, SHOCK.lo, { startDelay: 61000 }).total, 1e-9)
  })

  add('voice: the text the time order adds states the race and the fleet, never a person', () => {
    const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i
    const texts = [pageOver().shockFoot, pageOver({ data: { routeFleet: null, routeFleetShips: [] } }).timeNotice, pageOver({ data: { routeFleet: null, routeFleetShips: [] } }).shockFoot, pageOver({ data: { routeFleetShips: [ship({ SensorDelay: 61000 })] } }).shockFoot, time.RETRY_ASSUMPTION, time.NEBULA_GAP, ...pageOver().orders.map((option) => `${option.label} ${option.hint}`)]

    texts.forEach((text) => assert.ok(typeof text === 'string' && text.length > 0 && !PRONOUNS.test(text), text))
  })

  return all
}

// ---------- the faults ----------

// Each planted fault names the source to change, the text to find (`find`/`replace`, or `at` and `to`) and the checks, by key, that must fail. Anchors are code, never wording.
const MUTATIONS = [
  { name: 'the search takes the flight alone as the time of a jump point', target: 'jump-graph', find: 'const waited = Math.max(0, delay - flight.seconds)', replace: 'const waited = 0', fails: ['longer', 'table'] },
  { name: 'the search adds the delay to the flight instead of overlapping them', target: 'jump-graph', find: 'const waited = Math.max(0, delay - flight.seconds)', replace: 'const waited = delay', fails: ['longer', 'table'] },
  { name: 'the search prices an unknown shock as none', target: 'jump-graph', find: 'if (delay === null || flight.seconds === Infinity) {', replace: 'if (flight.seconds === Infinity) {', fails: ['unknown'] },
  { name: 'the search starts every route with no delay', target: 'jump-graph', find: 'const delay = previous ? timing.shock : timing.startDelay', replace: 'const delay = previous ? timing.shock : 0', fails: ['offset', 'unknown'] },
  { name: 'the search takes the shock of a first jump from the start offset', target: 'jump-graph', find: 'const delay = previous ? timing.shock : timing.startDelay', replace: 'const delay = timing.startDelay', fails: ['longer', 'table'] },
  { name: 'the time order ranks by kilometres first', target: 'jump-graph', find: 'time: (a, b) => (a.seconds === b.seconds ? 0 : a.seconds < b.seconds ? -1 : 1) || a.jumps - b.jumps || a.km - b.km', replace: 'time: (a, b) => a.km - b.km', fails: ['longer'] },
  { name: 'the time order ranks by the lower case of the shock', target: 'route-time', find: 'retried(timing.shock.hi, timing.retry || 0)', replace: 'retried(timing.shock.lo, timing.retry || 0)', fails: ['range'] },
  { name: 'a wait is the whole delay, not what the flight has not used', target: 'route-time', find: 'Math.max(0, base - since)', replace: 'Math.max(0, base)', fails: ['table', 'cycle', 'hauling'] },
  { name: 'the crew grade rounds half away from zero', target: 'route-time', find: 'roundHalfEven(Math.sqrt(grade) - 10)', replace: 'Math.round(Math.sqrt(grade) - 10)', fails: ['shock'] },
  { name: 'a hangared ship holds the fleet back', target: 'route-time', at: /const holders = participants\.filter\(\(participant\) => participant\.role !== 'hangared'\)\n {2}const ships/, to: () => 'const holders = participants\n  const ships', fails: ['shock'] },
  { name: 'the fleet draws the smallest delay of its ships', target: 'route-time', find: 'entry.window[key] > best.window[key]', replace: 'entry.window[key] < best.window[key]', fails: ['shock'] },
  { name: 'a ship with no crew in the save draws no delay', target: 'route-time', at: /if \(performance === null\) \{\n {4}return null\n {2}\}/, to: () => 'if (performance === null) {\n    return { performance: 1, multiplier: 1, lo: 0, hi: 0 }\n  }', fails: ['shock'] },
  { name: 'a cycle starts with no shock running', target: 'route-time', at: /if \(cyclic\) \{\n {4}events\.forEach\(step\)\n {2}\}/, to: () => 'if (false) {\n    events.forEach(step)\n  }', fails: ['hauling'] },
  { name: 'the loader reads systems the race has no survey of', target: 'route-time', find: 'inner join FCT_RaceSysSurvey', replace: 'left join FCT_RaceSysSurvey', fails: ['dust'] },
  { name: 'the cap multiplies the density instead of dividing by it', target: 'route-time', find: '(armour * DUST_FACTOR) / density', replace: '(armour * DUST_FACTOR) * density', fails: ['dust'] },
  { name: 'a nebula does not cap the speed', target: 'route-time', find: 'Math.min(speed, cap)', replace: 'speed', fails: ['dust'] },
  { name: 'a plan\'s next leg starts with no delay', target: 'route-plan', find: 'delay = walk ? carriedDelay(walk) : null', replace: 'delay = timing.startDelay', fails: ['offset', 'page'] },
  { name: 'a cycle of a fleet counts the flights and stops without the waits', target: 'transport', find: 'timed ? (timed.total ? timed.total[key] : null)', replace: 'timed ? (timed.total ? timed.flight + timed.handling : null)', fails: ['cycle'] },
  { name: 'a cycle with no known shock is timed all the same', target: 'transport', find: 'const timingProblems = timed && !timed.total ? [timingProblemOf(timed, timing)] : []', replace: 'const timingProblems = []', fails: ['unsupported'] },
  { name: 'a class timed alone does not say its waits are left out', target: 'transport', find: 'const unwaited = trip.jumps > 0 && !trip.waitCounted', replace: 'const unwaited = false', fails: ['unsupported'] },
  { name: 'a cycle of Hauling has no transit at an order that jumps', target: 'hauling', find: '...(order.ExitSystemID !== order.SystemID ? [transit] : [])', replace: '', fails: ['hauling'] },
  { name: 'a cycle of Hauling transits at every order', target: 'hauling', find: 'order.ExitSystemID !== order.SystemID ? [transit] : []', replace: '[transit]', fails: ['hauling'] },
  { name: 'the page ranks by the time without a fleet', target: 'routes', find: 'return this.order === \'time\' && !(this.timing && this.timing.shock) ? \'km\' : this.order', replace: 'return this.order', fails: ['page'] },
  { name: 'the page does not offer the time order', target: 'routes', find: 'value: \'time\', label', replace: 'value: \'timed\', label', fails: ['order'] },
  { name: 'the page defaults to the time order', target: 'routes', find: 'default: \'jumps\', valid: oneOf(ORDERS', replace: 'default: \'time\', valid: oneOf(ORDERS', fails: ['order'] },
  { name: 'the page takes the crew of another fleet', target: 'routes', find: 'ships.some((ship) => ship.FleetID !== fleet.FleetID)', replace: 'false', fails: ['page'] },
  { name: 'the clock of a leg table leaves the waits out', target: 'routes', find: 'clock = timing.wait === undefined ? clock : plus(timing.wait)', replace: 'clock = clock', fails: ['page'] },
  { name: 'the retry allowance is one subpulse', target: 'route-time', find: 'export const RETRY_SLACK = 2 * SUBPULSE_MAX', replace: 'export const RETRY_SLACK = SUBPULSE_MAX', fails: ['retry'] },
  { name: 'the longest subpulse is the one the save ended on', target: 'route-time', find: 'export const SUBPULSE_MAX = 21600', replace: 'export const SUBPULSE_MAX = 7200', fails: ['retry', 'carry'] },
  { name: 'the retry is left off the upper case of a shock', target: 'route-time', find: 'carried ? retried(carried.hi, retry) : null)', replace: 'carried ? carried.hi : null)', fails: ['retry', 'page'] },
  { name: 'the retry is left off the upper case of a start delay', target: 'route-time', find: 'first ? startReady(startDelay, retry)', replace: 'first ? startReady(startDelay, 0)', fails: ['retry', 'page'] },
  { name: 'the retry is put on the lower case of a wait too', target: 'route-time', find: 'const lo = wait(limit(\'lo\'), since)', replace: 'const lo = wait(retried(limit(\'lo\'), retry), since)', fails: ['retry'] },
  { name: 'a delay of 0 takes the retry allowance', target: 'route-time', find: '(delay > 0 ? delay + retry : delay)', replace: '(delay === null ? delay : delay + retry)', fails: ['retry'] },
  { name: 'the search leaves the retry off the shock', target: 'route-time', find: 'retried(timing.shock.hi, timing.retry || 0)', replace: 'timing.shock.hi', fails: ['retry', 'page'] },
  { name: 'the search leaves the retry off the start delay', target: 'route-time', find: 'startReady(timing.startDelay, timing.retry || 0)', replace: 'delayHigh(timing.startDelay)', fails: ['retry', 'page'] },
  { name: 'the timing of a fleet carries no retry', target: 'route-time', find: 'retry: RETRY_SLACK, holdsSpeed', replace: 'retry: 0, holdsSpeed', fails: ['retry', 'page'] },
  { name: 'a plan walks its legs without the retry', target: 'route-plan', find: '{ startDelay: delay, retry: timing.retry, slow }', replace: '{ startDelay: delay, slow }', fails: ['page'] },
  { name: 'the search of a plan leaves the start delay off the retry', target: 'route-plan', find: 'searchTiming({ ...timing, startDelay: delay, slow })', replace: '{ ...searchTiming({ ...timing, startDelay: delay, slow }), startDelay: delay !== null && typeof delay === \'object\' ? delay.hi : delay }', fails: ['page'] },
  { name: 'a cycle of Transport walks without the retry', target: 'transport', find: '{ cyclic: true, retry: timing.retry }', replace: '{ cyclic: true }', fails: ['retry'] },
  { name: 'a cycle of Hauling walks without the retry', target: 'hauling', find: '{ cyclic: true, retry: timing.retry }', replace: '{ cyclic: true }', fails: ['retry'] },
  { name: 'the page leaves the retry off its timing', target: 'routes', find: 'startDelay: crew ? crew.startDelay : null, retry: crew ? crew.retry : 0 }', replace: 'startDelay: crew ? crew.startDelay : null, retry: 0 }', fails: ['page'] },
  { name: 'the page reads the crew rows while the ships are being read again', target: 'routes', find: 'this.loadErrors.routeFleetShips !== null || ', replace: '', fails: ['gate'] },
  { name: 'the distance table times a system by its flight alone', target: 'routes', find: 'const clock = this.planOrder === \'time\' ? this.timing : null', replace: 'const clock = null', fails: ['distance'] },
  { name: 'the distance table shows the flight as the elapsed time', target: 'routes', find: 'elapsed: walk ? walk.total : null', replace: 'elapsed: walk ? { lo: walk.flight, hi: walk.flight } : null', fails: ['distance'] },
  { name: 'the distance table times a system with the wait of the first jump left out', target: 'routes', find: '{ startDelay: clock.startDelay, retry: clock.retry }) : null', replace: '{ startDelay: 0, retry: clock.retry }) : null', fails: ['distance'] },
  { name: 'a cycle of Hauling takes each leg at the average of the route', target: 'hauling', find: 'const km = route.legs[index].km', replace: 'const km = route.km / route.legs.length', fails: ['legs'] },
  { name: 'a propagated route scales its saved legs to the new total', target: 'hauling', find: 'km: flights[index][0] }', replace: 'km: leg.km * (flights.reduce((sum, flight) => sum + flight[0], 0) / route.km) }', fails: ['legs'] },
  { name: 'a cycle of Transport scales its flights to the saved ones', target: 'transport', find: 'routeEvents(timing.steps, clock, flights.out)', replace: 'routeEvents(timing.steps, clock)', fails: ['legs'] },
  { name: 'the fuel of a cycle of Transport follows the seconds under way', target: 'transport', find: '(timed.km === null ? null : timed.km / shipClass.MaxSpeed)', replace: 'timed.flight', fails: ['fuel'] },
  { name: 'the fuel of a year of Hauling follows the seconds under way', target: 'hauling', find: '(walk ? walk.km / fleet.Speed : movingSeconds)', replace: 'movingSeconds', fails: ['fuel'] },
  { name: 'a fleet not set to its maximum speed is restored to its speed in every system', target: 'hauling', find: 'speedIn: timing.holdsSpeed ? heldSpeedIn(', replace: 'speedIn: false ? heldSpeedIn(', fails: ['held'] },
  { name: 'the held speed is the speed of the fleet', target: 'route-time', find: 'Math.min(speed, ...each)', replace: 'speed', fails: ['held'] },
  { name: 'the timing of a fleet leaves the held speed out', target: 'route-time', find: 'retry: RETRY_SLACK, holdsSpeed, fleetShock: shock', replace: 'retry: RETRY_SLACK, holdsSpeed: false, fleetShock: shock', fails: ['held'] },
  { name: 'a squadron transit is a standard one', target: 'route-time', find: '37: \'squadron\'', replace: '37: \'standard\'', fails: ['transit'] },
  { name: 'a squadron transit draws the standard base', target: 'route-time', find: 'export const SQUADRON_BASE = 10', replace: 'export const SQUADRON_BASE = 120', fails: ['transit'] },
  { name: 'a transit of another kind is a standard one', target: 'route-time', find: 'TRANSIT_MODES[actionId] || \'unsupported\'', replace: 'TRANSIT_MODES[actionId] || \'standard\'', fails: ['transit'] },
  { name: 'a transit that is not timed is waited for all the same', target: 'route-time', find: 'event.unsupported || lo === null', replace: 'lo === null', fails: ['transit'] },
  { name: 'a squadron transit leaves the standard shock behind it', target: 'route-time', find: 'event.unsupported ? null : event.shock !== undefined ? event.shock : shock', replace: 'event.unsupported ? null : shock', fails: ['transit'] },
  { name: 'a cycle of Hauling gives a squadron transit the standard shock', target: 'hauling', find: '...(mode === \'squadron\' ? { shock: timing.squadronShock } : {})', replace: '...{}', fails: ['transit'] },
  { name: 'a cycle of Hauling times a transit that is not timed', target: 'hauling', find: '...(mode === \'unsupported\' ? { unsupported: true } : {})', replace: '...{}', fails: ['transit'] },
  { name: 'a leg\'s readiness bound is its raw upper case', target: 'route-time', find: 'ready: Math.max(0, ready() - sinceHi) }', replace: 'ready: Math.max(0, limit(\'hi\') - sinceHi) }', fails: ['retry', 'ready', 'page'] },
  { name: 'a range that carries its readiness bound takes the allowance again', target: 'route-time', find: 'startDelay.ready !== undefined ? startDelay.ready : retried(startDelay.hi, retry)', replace: 'retried(startDelay.ready !== undefined ? startDelay.ready : startDelay.hi, retry)', fails: ['retry', 'ready'] },
  { name: 'a plan\'s next leg starts with no cap held', target: 'route-plan', find: 'slow = walk ? walk.slow : []', replace: 'slow = []', fails: ['ready'] },
  { name: 'a plan walks its legs without the cap the leg before ended in', target: 'route-plan', find: '{ startDelay: delay, retry: timing.retry, slow }', replace: '{ startDelay: delay, retry: timing.retry }', fails: ['ready'] },
  { name: 'a flight after a capped one is at the speed of its own system at once', target: 'route-time', find: 'const held = slow.filter((cap) => cap.speed < inSystem)', replace: 'const held = []', fails: ['carry', 'dust', 'held', 'page'] },
  { name: 'the cap is held for ever', target: 'route-time', find: 'const reach = cap.speed * (cap.budget - seconds)', replace: 'const reach = Infinity', fails: ['carry', 'page'] },
  { name: 'the caps held do not run down', target: 'route-time', find: '.map((cap) => ({ speed: cap.speed, budget: cap.budget - seconds }))', replace: '', fails: ['carry'] },
  { name: 'the wait at a jump does not run the cap down', target: 'route-time', find: 'slow = leaving(aged(slow, hi), here)', replace: 'slow = leaving(slow, here)', fails: ['carry'] },
  { name: 'the lowest case flies at the cap the highest holds', target: 'route-time', at: /since = add\(since, event\.seconds\)\n {6}sinceHi = add\(sinceHi, flown\.seconds\)/, to: () => 'since = add(since, flown.seconds)\n      sinceHi = add(sinceHi, flown.seconds)', fails: ['carry'] },
  { name: 'the upper case of a total takes the flight at its lowest case', target: 'route-time', find: 'hi: flightHi + handling + waiting.hi', replace: 'hi: flight + handling + waiting.hi', fails: ['carry', 'dust', 'held', 'page'] },
  { name: 'a fleet that holds its speed has a restore to bound', target: 'route-time', find: 'if (timing.holdsSpeed || !(timing.speed > 0)) {', replace: 'if (!(timing.speed > 0)) {', fails: ['carry', 'held'] },
  { name: 'a cycle of Hauling leaves the speed mode out of the clock of its flights', target: 'hauling', find: '{ speed: fleet.Speed, holdsSpeed: timing.holdsSpeed, speedIn:', replace: '{ speed: fleet.Speed, speedIn:', fails: ['held'] },
  { name: 'the year of Hauling counts the moving time at its lowest case', target: 'hauling', find: 'const movingSeconds = walk ? walk.flightHi :', replace: 'const movingSeconds = walk ? walk.flight :', fails: ['held'] },
  { name: 'the cycle of Transport counts the flying at its lowest case', target: 'transport', find: 'const travelSeconds = timed ? timed.flightHi :', replace: 'const travelSeconds = timed ? timed.flight :', fails: ['fuel'] },
  { name: 'the flight of a leg is shown at its lowest case only', target: 'routes', find: 'flight === flightHi ? this.span(flight) :', replace: 'true ? this.span(flight) :', fails: ['page'] },
  { name: 'the clock of a leg table takes each flight at its lowest case', target: 'routes', find: '{ lo: timing.flight, hi: timing.flightHi }', replace: '{ lo: timing.flight, hi: timing.flight }', fails: ['page'] },
  { name: 'a transit keeps only the cap of the system it leaves', target: 'route-time', find: '[...slow.filter((held) => held.speed < cap), { speed: cap, budget: SUBPULSE_MAX }]', replace: '[{ speed: cap, budget: SUBPULSE_MAX }]', fails: ['carry', 'ready'] },
  { name: 'the search keeps one state at a jump point', target: 'jump-graph', find: '.some((kept) => firstOnly || covers(kept, state))', replace: '.some(() => true)', fails: ['caps'] },
  { name: 'the search flies the last leg without the cap held', target: 'jump-graph', find: 'flown(leg.km, place.SystemID, slow).seconds', replace: 'flown(leg.km, place.SystemID, []).seconds', fails: ['caps', 'optimal'] },
  { name: 'the search flies a leg to a transit without the cap held', target: 'jump-graph', find: 'const flight = flown(km, systemId, previous ? previous.slow : startCaps)', replace: 'const flight = flown(km, systemId, [])', fails: ['caps', 'optimal'] },
  { name: 'the wait before a transit does not run the cap down in the search', target: 'jump-graph', find: 'slow: leaving(aged(flight.slow, waited), flight.cap)', replace: 'slow: leaving(flight.slow, flight.cap)', fails: ['caps'] },
  { name: 'the search lets a capped state cover a later one with a cap no faster, however soon it runs out', target: 'jump-graph', find: 'other.speed <= cap.speed && b.seconds + other.budget >= a.seconds + cap.budget', replace: 'other.speed <= cap.speed', fails: ['caps'] },
  { name: 'the cap of the system left runs from its last flight, not from the transit', target: 'route-time', find: 'slow = leaving(aged(slow, hi), here)', replace: 'slow = aged(leaving(slow, here), hi)', fails: ['carry'] },
  { name: 'a cap held above the cap of the system is flown at', target: 'route-time', find: 'const held = slow.filter((cap) => cap.speed < inSystem)', replace: 'const held = slow', fails: ['carry', 'optimal'] },
  { name: 'the search does not hold the cap of the system a transit leaves', target: 'jump-graph', find: 'slow: leaving(aged(flight.slow, waited), flight.cap)', replace: 'slow: aged(flight.slow, waited)', fails: ['caps', 'optimal'] },
  { name: 'the search crosses no system to a jump point another state reached first', target: 'jump-graph', find: 'firstOnly || kept.slow.length === 0', replace: 'firstOnly || true', fails: ['caps'] },
  { name: 'a nebula of no known cap leaves no cap state', target: 'route-time', find: 'return { maxSpeed: timing.speed, capSpeed: cap === null ? 0 : cap < timing.speed ? cap : null }', replace: 'return cap === null ? {} : { maxSpeed: timing.speed, capSpeed: cap < timing.speed ? cap : null }', fails: ['unweighed'] },
  { name: 'a cap of no known speed held is flown at no speed for its whole budget', target: 'route-time', find: 'if (held.some((cap) => cap.speed === 0)) {', replace: 'if (false) {', fails: ['unweighed'] },
  { name: 'a plan names the nebula only where the flight at its lowest case is not known', target: 'route-plan', find: 'missing: flightHi === null ? [NEBULA_GAP] : timingGaps(timing)', replace: 'missing: summed((walk) => walk.flight) === null ? [NEBULA_GAP] : timingGaps(timing)', fails: ['unweighed'] },
]

// Edits that change nothing the checks may pin: a wording, the form of a binding, the order of a qualifier, a parenthesised condition, a comment. Each is located by its structure.
const BENIGN = [
  { name: 'the retry assumption reworded', target: 'route-time', at: /(export const RETRY_ASSUMPTION = )'[^']*'/, to: (match) => `${match[1]}'a blocked transit is retried at the start of every subpulse, so the longest wait ends up to two subpulses after the second the delay clears (12 hours with the longest subpulse the game runs, 6 hours) and the shortest ends the second it clears; the subpulse length of the save is not the length of those ahead'` },
  { name: 'the gap text reworded', target: 'route-time', at: /(export const NEBULA_GAP = )'[^']*'/, to: (match) => `${match[1]}'a speed above 0 in every system the route crosses, where the nebula caps it by the thinnest armour in the fleet'` },
  { name: 'a condition of the flight time parenthesised', target: 'route-time', at: /\(?known\(km\) && km === 0\)? \? 0 : \(?known\(km\) && speed > 0\)? \? km \/ speed : null/, to: () => '(known(km) && km === 0) ? 0 : (known(km) && speed > 0) ? km / speed : null' },
  { name: 'a line of comment added to the walk', target: 'route-time', at: /^const add = \(total, seconds\)/m, to: (match) => `// Sums that stay unknown when a part is.\n${match[0]}` },
  { name: 'the notice of the page reworded', target: 'routes', at: /(Fastest time needs a speed: )[^`']*(?=')/, to: (match) => `${match[1]}give one or take a fleet as the first stop. Until then the route follows the shortest distance.` },
  { name: 'the order label of the page reworded', target: 'routes', at: /(value: 'time', label: )'[^']*'/, to: (match) => `${match[1]}'Time, fastest'` },
  { name: 'the order toggle bound by a prop and an event', target: 'routes', at: /v-model="order"|:value="order" @change="order = \$event"/, first: true, to: () => ':value="order" @change="order = $event"' },
  { name: 'a handler of the page written long-hand', target: 'routes', at: /@click="reverse"|v-on:click="reverse"/, first: true, to: () => 'v-on:click="reverse"' },
  { name: 'the empty-ships test of the crew rows written as a length comparison', target: 'routes', at: /!ships\.length|ships\.length === 0/, to: () => 'ships.length === 0' },
  { name: 'the comment of the distance table clock reworded', target: 'routes', at: /\/\/ Under fastest time a system(?:'s time is| is timed)[^\n]*/, to: () => '// Under fastest time a system is timed as the route the search chose is walked: flights, waits and nebula caps, the way the leg table walks them.' },
  { name: 'the speeds of a held cycle taken through a wrapper', target: 'route-time', at: /systems\.map\(speedIn\(\{ speed, dust, armour \}\)\)|systems\.map\(\(system\) => speedIn\(\{ speed, dust, armour \}\)\(system\)\)/, to: () => 'systems.map((system) => speedIn({ speed, dust, armour })(system))' },
  { name: 'the shock windows listed in another order', target: 'route-time', at: /const SHOCK_WINDOWS = \{[^\n]*/, to: () => 'const SHOCK_WINDOWS = { squadron: [SQUADRON_BASE, SQUADRON_ROLL], standard: [SHOCK_BASE, SHOCK_ROLL] }' },
  { name: 'the squadron assumption reworded', target: 'route-time', at: /(export const SQUADRON_ASSUMPTION = )'[^']*'/, to: (match) => `${match[1]}'the arrival of a squadron transit is scattered by up to the range of the jump drive; the save does not give it, so the flight after the transit starts at the jump point'` },
  { name: 'the flight event of a cycle written with a copy of its clock', target: 'hauling', at: /flyEvent\(km, order\.ExitSystemID, (?:clock|\{ \.\.\.clock \})\)/, to: () => 'flyEvent(km, order.ExitSystemID, { ...clock })' },
  { name: 'the distance of a propagated route summed through a map', target: 'hauling', at: /legs\.reduce\(\(total, leg\) => total \+ leg\.km, 0\)|legs\.map\(\(leg\) => leg\.km\)\.reduce\(\(total, km\) => total \+ km, 0\)/, to: () => 'legs.map((leg) => leg.km).reduce((total, km) => total + km, 0)' },
  { name: 'the fuel of a class on Transport written without its parentheses', target: 'transport', at: /\(?fuelSeconds \/ 3600\)?/, to: () => 'fuelSeconds / 3600' },
  { name: 'the fuel of a year of Hauling with its rate parenthesised', target: 'hauling', at: /fuel: \(?fleet\.FuelPerHour\)? \*/, to: () => 'fuel: (fleet.FuelPerHour) *' },
  { name: 'the step of a flight event written as a conditional on null', target: 'route-time', at: /\.\.\.\(step \? \{ step \} : \{\}\)|\.\.\.\(step === null \? \{\} : \{ step \}\)/, to: () => '...(step === null ? {} : { step })' },
  { name: 'the seconds of a flight past its caps parenthesised', target: 'route-time', at: /seconds \+= \(?left \/ inSystem\)?/, to: () => 'seconds += (left / inSystem)' },
  { name: 'the comment of the flight text of the page reworded', target: 'routes', at: /\/\/ (?:A flight as a range from the lowest|The cell of a flight: a range from the lowest)[^\n]*/, to: () => '// The cell of a flight: a range from the lowest to the highest case when they differ, one figure when they agree, a dash where there is none or it is not known.' },
]

const MUTANTS = [...MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation })), ...BENIGN.map((edit, index) => ({ id: `benign:${index}`, benign: true, ...edit }))]
const COMPOSED = MUTATIONS.map((mutation, index) => ({ id: `composed:${index}`, ...mutation }))

// ---------- the parts ----------

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      const given = await test()

      result = given === undefined ? true : given
    } catch (error) {
      result = `${isMarked(error) ? '' : 'threw '}${String(error.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`
    }

    results.push([name, result])
  }

  return results
}

// The keys of `fails` whose statements ran and none of which failed by an assertion: a statement that threw credits no planted fault.
const missedOf = (results, fails) => fails.filter((key) => {
  const ran = results.filter(([name]) => keyOf(name) === key)

  return ran.length > 0 && !ran.some(([, result]) => result !== true && !String(result).startsWith('threw '))
})

const checkHead = async () => {
  // The world without the page runs first, before this process has loaded the page, as the world of a planted fault that names no statement of PAGE_KEYS does.
  const bare = await runStatements(fixtures(await worldOf([], { withPage: false })))
  const world = await worldOf()

  console.log('\nElapsed-time routing on a constructed graph')

  for (const [name, result] of await runStatements(fixtures(world))) {
    check(name, result)
  }

  const strays = [...world.readers].filter((key) => !PAGE_KEYS.includes(key))
  const unread = PAGE_KEYS.filter((key) => !world.readers.has(key))

  check('guard: the statements that read the Routes page are those of PAGE_KEYS, so a planted fault that names none of them is judged on a world without the page', strays.length || unread.length ? `the page is read by ${strays.join(', ') || 'no other statement'} and not by ${unread.join(', ') || 'none of the list'}` : true)

  const unlike = bare.filter(([name, result]) => !PAGE_KEYS.includes(keyOf(name)) && result !== true).map(([name]) => keyOf(name))
  const loud = bare.filter(([name, result]) => PAGE_KEYS.includes(keyOf(name)) && !String(result).startsWith('threw ')).map(([name]) => keyOf(name))
  const credited = PAGE_KEYS.filter((key) => !missedOf(bare, [key]).length)

  check('guard: on a world without the page every other statement passes as it does with the page, and each statement of PAGE_KEYS throws, which credits no planted fault', unlike.length || loud.length || credited.length ? `failed without the page: ${unlike.join(', ') || 'none'}; did not throw: ${loud.join(', ') || 'none'}; credited: ${credited.join(', ') || 'none'}` : true)
}

const checkMutant = async (mutant, composed = false) => {
  const began = Date.now()
  const label = mutant.benign ? 'benign edit kept' : composed ? 'mutation caught on the stacked benign edits' : 'mutation caught'
  let world

  try {
    world = await worldOf(composed ? [...BENIGN, mutant] : [mutant], { withPage: Boolean(mutant.benign) || mutant.fails.some((key) => PAGE_KEYS.includes(key)) })
  } catch (error) {
    check(`${label}: ${mutant.name}`, `${/does not apply|does not parse/.test(error.message) ? 'invalid mutant' : 'does not load'}: ${error.message}`)

    return
  }

  const statements = fixtures(world)

  if (mutant.benign) {
    const results = await runStatements(statements)
    const broken = results.filter(([, result]) => result !== true)

    check(`${label}: ${mutant.name}`, broken.length ? `these checks failed: ${broken.map(([name]) => keyOf(name)).join(', ')}` : true, `${results.length} checks green, ${((Date.now() - began) / 1000).toFixed(1)} s`)

    return
  }

  const absent = mutant.fails.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, mutant.fails)
  const missed = missedOf(results, mutant.fails)

  check(`${label}: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const checkStacked = async () => {
  const began = Date.now()
  const conflicts = []

  for (const first of BENIGN) {
    let after

    try {
      after = applied({ ...ORIGINALS }, first)
    } catch (error) {
      conflicts.push(`${first.name}: ${error.message}`)

      continue
    }

    for (const second of BENIGN) {
      try {
        applied(after, second)
      } catch (error) {
        conflicts.push(`${second.name} after ${first.name}: ${error.message}`)
      }
    }
  }

  check('benign edits: each still applies to a source another has changed', conflicts.length ? conflicts.slice(0, 4).join(' | ') : true, `${BENIGN.length * BENIGN.length} pairs`)

  let results

  try {
    results = await runStatements(fixtures(await worldOf(BENIGN)))
  } catch (error) {
    check('benign edits: all of them together keep every check green', `does not load: ${error.message}`)

    return
  }

  const broken = results.filter(([, result]) => result !== true)

  check('benign edits: all of them together keep every check green', broken.length ? `these checks failed: ${broken.map(([name]) => keyOf(name)).join(', ')}` : true, `${results.length} checks green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
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
    } else if (COMPOSED.some(({ id }) => id === options.part)) {
      await checkMutant(COMPOSED.find(({ id }) => id === options.part), true)
    } else if (options.part === 'stacked') {
      await checkStacked()
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const stacked = options.mutations ? ['stacked'] : []
  const composed = options.mutations ? COMPOSED : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 30 }, ...[...wanted, ...composed].map(({ id }) => ({ args: ['--part', id], weight: 3 })), ...stacked.map((id) => ({ args: ['--part', id], weight: 5 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names; benign edits must leave every check green')
    wanted.forEach(printed)
  }

  if (composed.length) {
    console.log('\nPlanted faults on the source with every benign edit applied: each must still apply once and fail the checks it names')
    composed.forEach(printed)
  }

  if (stacked.length) {
    console.log('\nBenign edits stacked: each still applies after any other, and all of them together leave every check green')
    stacked.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
