/*
  Checks the fuel ledger of a run (src/renderer/utilities/fuel-ledger.js): the litres each ship carries from stop to stop, what a colony or stationary tankers give at a stop, what each source has left, the hours the service takes, the fleets that draw on one stock one after another, and the "Fleets sailing together" panel of /information that shows them.

  Run: bun scripts/check-refuel-legs.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  Three parts, each with a head, planted faults and rewrites that say the same thing (scripts/lib/suite-runner.js):
  - `pure`: the ledger over constructed ships and sites, every expected figure written here from the rules and worked by hand: the legs, a colony with no stock, the rate and the stock as limits, the 20 HS limit of a low rate, the order tankers and recipients are taken in, the reserves, the hours, a closing visit, the litres a run needs, the gates, an input that is not known, and the netting of several fleets over one stock.
  - `real`: the same ledger over the saves, read-only (the Falryx copy of the 2930 artifact and the EggSample save), set against SQL written here and the independent fills of scripts/lib/fuel-service-oracle.js.
  - `page`: /information served by scripts/lib/page-server.js over a copy of the Falryx save in which fleets of cargo ships, a destination spaceport with a stock and a stationary tanker fleet are planted, read back in Chromium: the status, the cycle, the ledger, the tankers, the reserves not read, the draw order and its stability under sorting, the fill target, and the orders of the copy untouched.
  Every planted fault must fail the checks it names by an assertion, and every rewrite must pass every check.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { runSuite } = require('./lib/suite-runner')
const { fuelFillTruth } = require('./lib/fuel-service-oracle')
const { assert, subjectModule, runChecks, judged, caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { observe, validate, HarnessError, settled, installScreen, readFigure, rounded } = require('./lib/browser-observe')
const pageLoading = require('./page-loading')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const MODULE = 'fuel-ledger'
const DETAIL = process.argv.includes('--detail')

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new Error(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

// ---------- constructed ships and sites ----------

const KM = 3.6e6
const GAME_TIME = 1000
const VERSION = '2.7.1'

// A ship as `loadFleetShips` gives it: it burns 10 L/h at its speed of 1,000 km/s, so a leg of 3.6 M km takes an hour and 10 L.
const BASE_SHIP = { ShipID: 1, ShipName: 'Hauler', FleetID: 5, FleetName: 'Convoy', ClassName: 'Freighter', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: 1000, EnginePower: 20, UndamagedEnginePower: 20, OverhaulFactor: 1, GradePoints: 100, CrewMorale: 1, SensorDelay: 0, FuelEfficiency: 0.5, FuelCapacity: 100, Fuel: 50, MaintenanceState: 0, MothershipID: 0, TractorTargetShipID: 0, TractorParentShipID: 0, TractorTargetShipyardID: 0, TowedSize: null, TowedTargetShipID: null, CarrierMothershipID: null, CarrierFleetID: null, ShuttleTechnology: 1.5, MilitaryEngines: 0, Drive: 0, AnyDrive: 0, FleetSpeed: 1000, UseMaximumSpeed: 1, RefuelPriority: 5, ClassRefuelPriority: 5, FuelTanker: 0 }
const hauler = (id, fuel, changes = {}) => ({ ...BASE_SHIP, ShipID: id, ShipName: `Ship ${id}`, Fuel: fuel, ...changes })

// A ship of a stationary tanker fleet as `loadFuelDonors` gives it: a class of 450,000 L/h with one undamaged system.
const TANKER = { ShipID: 501, ShipName: 'Tanker', FleetID: 900, FleetName: 'Tanks', SystemID: 1, ShipClassID: 1, ClassName: 'Tanker class', Fuel: 5000000, FuelCapacity: 5000000, FuelTanker: 1, MinimumFuel: 100000, RefuellingRate: 450000, EnginePower: 100, Harvesters: 0, Size: 100, TransferSystems: 1, UndamagedTransfer: 1, Harvester: 0 }
const tanker = (id, changes = {}) => ({ ...TANKER, ShipID: id, ShipName: `Tanker ${id}`, ...changes })
const depotFleet = (ships, changes = {}) => ({ FleetID: 900, FleetName: 'Tanks', SystemID: 1, OrbitBodyID: 0, Xcor: 0, Ycor: 0, LastMoveTime: 0, FirstOrderStationary: 1, ships, ...changes })
const DEPOT = { name: 'Depot', PopulationID: null, SystemID: 1, Xcor: 0, Ycor: 0 }

const colonyRow = (id, changes = {}) => ({ PopulationID: id, PopName: `Colony ${id}`, SystemID: 1, SystemBodyID: id * 10, Population: 5, FuelStockpile: 1000, FuelProdStatus: 0, RefuellingPoints: 1, Refineries: 0, ...changes })
const sitesOf = (colonies = [], fleets = [], changes = {}) => ({ gameTime: GAME_TIME, rates: { MaxRefuellingRate: 80000, UnderwayReplenishmentRate: 0 }, colonies, fleets, ...changes })
const at = (id, name) => ({ name, PopulationID: id, SystemID: 1, Xcor: 0, Ycor: 0 })
const READ = { ship: () => null, colony: () => null }

const close = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))
const near = (a, b, what) => assert.equal(close(a, b), true, `${what}: ${a} is not ${b}`)

// The ledger of one fleet of `ships`; `fp` is the fleet profile module, which is not under test.
const ledgerOf = ({ mod, fp }, { ships, legs = [KM], stops, sites = sitesOf(), reserves = READ, target, stocks, cycle = false, fleetId = 5, fleetName = 'Convoy' }) => mod.fuelLedger({ profile: fp.fleetProfile(ships, { FleetID: fleetId, FleetName: fleetName }, { basis: 'maximum' }), legs, stops, sites, reserves, version: VERSION, target, stocks, cycle })

const fleetOf = ({ fp }, name, id, ships, legs, stops, cycle = false) => ({ name, profile: fp.fleetProfile(ships, { FleetID: id, FleetName: name }, { basis: 'maximum' }), legs, stops, cycle })

// The first service of the first stop of a ledger.
const firstService = (ledger) => ledger.stops[0].service.services[0]

// ---------- the checks over constructed ships ----------

const legChecks = {
  id: 'legs',
  name: 'the litres of a leg: a ship departs with what it holds, arrives with the rest after the burn, runs dry part of the way along a leg it cannot finish, and the ship that arrives with the smallest share of its tank is the limiting one',
  run: (ctx) => {
    const stops = [at(null, 'A'), at(null, 'B'), at(null, 'C')]
    const dry = ledgerOf(ctx, { ships: [hauler(1, 50), hauler(2, 15)], legs: [KM, KM], stops })

    assert.equal(dry.status, 'range', 'a ship that runs dry on the second leg makes the run range')
    assert.deepEqual(dry.legs[0].ships.map((row) => [row.id, row.departure, row.arrival, row.status]), [[1, 50, 40, 'ok'], [2, 15, 5, 'ok']], 'the first leg: 10 L burnt by each ship, no service at a place that is no colony')
    assert.deepEqual(dry.legs[1].ships.map((row) => [row.id, row.departure, row.arrival, row.status, row.shortfall]), [[1, 40, 30, 'ok', 0], [2, 5, 0, 'dry', 5]], 'the second leg: the ship with 5 L left is short by 5 L and arrives with 0')
    near(dry.legs[1].ships[1].ranKm, 1.8e6, 'the ship runs half of the leg before it is dry')
    assert.deepEqual({ name: dry.limiting.name, leg: dry.limiting.leg, dry: dry.limiting.dry, shortfall: dry.limiting.shortfall }, { name: 'Ship 2', leg: 1, dry: true, shortfall: 5 }, 'the ship that runs dry is the limiting one')
    assert.equal(dry.returnFuel, null, 'a run that does not reach its last stop has no return litres')

    const fits = ledgerOf(ctx, { ships: [hauler(1, 50), hauler(2, 35)], legs: [KM, KM], stops })

    assert.equal(fits.status, 'ok', 'both ships finish both legs')
    assert.deepEqual([fits.returnFuel.get(1), fits.returnFuel.get(2)], [30, 15], 'the litres each ship has on arrival at the last stop')
    assert.deepEqual({ name: fits.limiting.name, share: fits.limiting.share, stop: fits.limiting.stop }, { name: 'Ship 2', share: 0.15, stop: 'C' }, 'the limiting ship is the one with the smallest share of its tank on arrival')
  },
}

const exhaustedChecks = {
  id: 'exhausted',
  name: 'a colony with a refuelling point and no stock cannot serve: blocked with the reason the stock is empty, nothing received, no hours, and the leg after it runs dry',
  run: (ctx) => {
    const ledger = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [at(1, 'Empty'), at(null, 'Far')], sites: sitesOf([colonyRow(1, { FuelStockpile: 0 })]) })
    const service = firstService(ledger)

    assert.deepEqual({ permission: service.permission, gate: service.gate, reason: service.reason }, { permission: 'blocked', gate: 'stock', reason: 'stock-empty' }, 'the colony is blocked at the stock')
    assert.equal(ledger.stops[0].receivedTotal, 0, 'nothing is received')
    assert.equal(ledger.stops[0].hours, 0, 'the service takes no time')
    assert.equal(ledger.status, 'range', 'the leg after the empty colony runs dry')
    assert.equal(ledger.legs[0].ships[0].status, 'dry', 'the ship is dry on the leg')
    assert.equal(ledger.rejected[0].reason, 'stock-empty', 'the refusal is listed with its reason')
  },
}

const rateChecks = {
  id: 'rate-limited',
  name: 'a colony with more stock than the ship wants gives what it wants, over the litres of the deficit at the race\'s rate, with the rest left in the stock',
  run: (ctx) => {
    const ledger = ledgerOf(ctx, { ships: [hauler(1, 0, { FuelCapacity: 10094646 })], stops: [at(1, 'Aurelian'), at(null, 'Far')], sites: sitesOf([colonyRow(1, { FuelStockpile: 12470034.55 })], [], { rates: { MaxRefuellingRate: 160000, UnderwayReplenishmentRate: 0 } }) })
    const service = firstService(ledger)
    const truth = fuelFillTruth.colonyFill({ stock: 12470034.55, reserve: 0, rate: 160000, wants: [{ id: 1, litres: 10094646 }] })

    near(service.received, 10094646, 'the whole deficit is received')
    near(service.hours, 63.0915375, 'the hours are the litres over the rate')
    near(service.residual, 2375388.55, 'the residual is the stock less what was received')
    assert.equal(service.limiter, 'rate', 'the rate is the limit')
    near(truth.total, service.received, 'the independent fill gives the same total')
    near(truth.hours, service.hours, 'the independent fill gives the same hours')
  },
}

const sharedChecks = {
  id: 'stock-shared',
  name: 'ships served from one stock take it in turn in the order of their IDs: each takes what it wants or what is left, the total received is the stock exactly, the residual is 0 and the stock after is 0, and a second plan over the same site starts from the save\'s stock again',
  run: (ctx) => {
    const ships = [...[1, 2, 3, 4, 5].map((id) => hauler(id, 0, { FuelCapacity: 24150 })), hauler(6, 0, { FuelCapacity: 5000000 })]
    const sites = sitesOf([colonyRow(1, { FuelStockpile: 4964043.83 })])
    const input = { ships, stops: [at(1, 'Shared'), at(null, 'Far')], sites }
    const ledger = ledgerOf(ctx, input)
    const service = firstService(ledger)

    assert.deepEqual([1, 2, 3, 4, 5].map((id) => service.perShip.get(id)), [24150, 24150, 24150, 24150, 24150], 'the five small deficits are filled first')
    near(service.perShip.get(6), 4843293.83, 'the last ship receives what is left')
    near(service.received, 4964043.83, 'the total received is the stock')
    near(service.residual, 0, 'nothing is left')
    near(ledger.stocksAfter.get('colony:1'), 0, 'the stock after is 0')
    assert.equal(service.exhausted, true, 'a ship is left short')

    const again = ledgerOf(ctx, input)

    near(firstService(again).perShip.get(6), 4843293.83, 'a second plan over the same site is not netted: the site object carries no draw')
  },
}

const boundaryChecks = {
  id: 'boundary',
  name: 'a tanker of a rate under 20,000 L/h leaves out a recipient over 20 HS, with the reason the recipient is too large when none can be served, and a tanker of 20,000 L/h serves both',
  run: (ctx) => {
    const slow = depotFleet([tanker(501, { RefuellingRate: 15000 })])
    const quick = depotFleet([tanker(501, { RefuellingRate: 20000 })])
    const both = [hauler(1, 40, { Size: 19.744 }), hauler(2, 40, { Size: 39.757 })]
    const served = (fleet, ships) => firstService(ledgerOf(ctx, { ships, stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [fleet]) }))
    const low = served(slow, both)

    assert.deepEqual([low.perShip.get(1), low.perShip.get(2) || 0], [60, 0], 'the ship of 19.744 HS is served and the one of 39.757 HS is not')

    const big = served(slow, [hauler(2, 40, { Size: 39.757 })])

    assert.deepEqual({ permission: big.permission, gate: big.gate, reason: big.reason }, { permission: 'blocked', gate: 'recipient', reason: 'recipient-too-large' }, 'a recipient that is too large and nothing else leaves the fleet blocked at the recipient')

    const edge = served(slow, [hauler(3, 40, { Size: 20 })])

    assert.equal(edge.perShip.get(3), 60, 'a recipient of exactly 20 HS is in')

    const fast = served(quick, both)

    assert.deepEqual([fast.perShip.get(1), fast.perShip.get(2)], [60, 60], 'a rate of 20,000 L/h serves both')
  },
}

const tankerOrderChecks = {
  id: 'tanker-order',
  name: 'tankers give the richest share of their tank first, to recipients in the order of their priority, class priority and tank size; a tanker that cannot serve gives nothing and shows no surplus',
  run: (ctx) => {
    const rich = tanker(502, { Fuel: 200, MinimumFuel: 100, FuelCapacity: 250 })
    const poor = tanker(501, { Fuel: 200, MinimumFuel: 100, FuelCapacity: 500 })
    const blocked = tanker(503, { Fuel: 900, MinimumFuel: 100, FuelCapacity: 1000, TransferSystems: 0, UndamagedTransfer: 0 })
    const ships = [hauler(3, 230, { FuelCapacity: 300 }), hauler(2, 130, { FuelCapacity: 200 }), hauler(1, 30, { FuelCapacity: 100, RefuelPriority: 3 })]
    const ledger = ledgerOf(ctx, { ships, stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [depotFleet([poor, rich, blocked])]) })
    const service = firstService(ledger)
    const truth = fuelFillTruth.tankerFill({ tankers: [{ id: 502, fraction: 0.8, surplus: 100, rate: 450000 }, { id: 501, fraction: 0.4, surplus: 100, rate: 450000 }], recipients: [{ id: 1, priority: 3, classPriority: 5, capacity: 100, size: 20, litres: 70 }, { id: 2, priority: 5, classPriority: 5, capacity: 200, size: 20, litres: 70 }, { id: 3, priority: 5, classPriority: 5, capacity: 300, size: 20, litres: 70 }] })

    assert.deepEqual([1, 2, 3].map((id) => service.perShip.get(id)), [70, 70, 60], 'the first takes 70 from the richer tanker, the second 30 from it and 40 from the other, the third 60 and is short 10')
    assert.deepEqual([1, 2, 3].map((id) => truth.received.get(id)), [70, 70, 60], 'the independent fill gives the same')
    assert.deepEqual(service.tankers.map((row) => [row.name, row.drawn, row.residual]), [['Tanker 503', 0, null], ['Tanker 502', 100, 0], ['Tanker 501', 100, 0]], 'the blocked tanker gives nothing, the richer of the others is drained first and both are empty after')
    assert.equal(service.tankers[0].saved, 0, 'a tanker that cannot serve shows no surplus, not the litres above its floors')
    assert.equal(service.stock, 200, 'the pooled surplus counts only the tankers that can serve')
    assert.equal(service.exhausted, true, 'the third recipient is left short')

    const twin = (id, fuel) => tanker(id, { Fuel: fuel, MinimumFuel: 0, FuelCapacity: 100 })
    const far = { name: 'Far', PopulationID: null, SystemID: 2, Xcor: 5, Ycor: 5 }
    const cycled = ledgerOf(ctx, { ships: [hauler(1, 40)], legs: [KM, KM], stops: [DEPOT, far, DEPOT], sites: sitesOf([], [depotFleet([twin(501, 90), twin(502, 80)])]), cycle: true })
    const again = cycled.stops[2].service.services[0]

    assert.deepEqual([501, 502].map((id) => again.drawn.get(`tanker:${id}`) || 0), [0, 20], 'the opening fill of 60 L leaves the tanker that held 90 of 100 L with 30 L and the other with 80 L, so the closing fill of 20 L comes from the other')
  },
}

const reserveChecks = {
  id: 'reserves',
  name: 'the reserve is a level and not an addition: a tanker gives its fuel above the larger of its minimum and the reserve, a colony holds back its reserve and serves nothing at or under it, and records not read leave the service unknown',
  run: (ctx) => {
    const ships = [hauler(1, 40)]
    const forShip = (reserve) => ({ ship: () => reserve, colony: () => null })
    const gave = firstService(ledgerOf(ctx, { ships, stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [depotFleet([tanker(501, { Fuel: 1000, FuelCapacity: 1000, MinimumFuel: 100 })])]), reserves: forShip(300) }))

    assert.equal(gave.tankers[0].saved, 700, 'the surplus is 1000 less the larger of 100 and 300')

    const colonyAt = (stock, reserve) => firstService(ledgerOf(ctx, { ships, stops: [at(1, 'Held'), at(null, 'Far')], sites: sitesOf([colonyRow(1, { FuelStockpile: stock })]), reserves: { ship: () => null, colony: () => reserve } }))
    const held = colonyAt(500, 600)

    assert.deepEqual({ permission: held.permission, reason: held.reason, available: held.available, received: held.received }, { permission: 'blocked', reason: 'held-by-reserve', available: null, received: 0 }, 'a stock under the reserve serves nothing')

    const level = colonyAt(600, 600)

    assert.deepEqual({ permission: level.permission, reason: level.reason }, { permission: 'blocked', reason: 'held-by-reserve' }, 'a stock at the reserve serves nothing')

    const above = colonyAt(700, 600)

    assert.deepEqual({ permission: above.permission, available: above.available, received: above.received, residual: above.residual }, { permission: 'allowed', available: 100, received: 60, residual: 40 }, 'a stock of 700 with a reserve of 600 offers 100 and gives the 60 the ship wants')

    const unread = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [at(1, 'Unread'), at(null, 'Far')], sites: sitesOf([colonyRow(1)]), reserves: null })

    assert.deepEqual({ permission: firstService(unread).permission, reason: firstService(unread).reason, available: firstService(unread).available }, { permission: 'unknown', reason: 'reserve-unread', available: null }, 'with the records not read the colony cannot be decided and offers no litres')
    assert.equal(unread.status, 'unknown', 'a leg that runs dry without the undecided service leaves the run unknown')

    const carried = ledgerOf(ctx, { ships: [hauler(1, 50)], stops: [at(1, 'Unread'), at(null, 'Far')], sites: sitesOf([colonyRow(1)]), reserves: null })

    assert.deepEqual({ status: carried.status, named: carried.missing.length }, { status: 'unknown', named: 1 }, 'with the records not read the verdict is unknown and names what is missing, though the 50 L aboard carry the leg of 10 L')
  },
}

const hoursChecks = {
  id: 'hours',
  name: 'the hours of a service: a colony serves each ship at the race\'s rate, so the ship that receives most sets the time; tankers serve one recipient each, so the time is at least the litres over their rates together and at least the largest receipt over the highest rate',
  run: (ctx) => {
    const colonyShips = [hauler(1, 240000, { FuelCapacity: 400000 }), hauler(2, 80000, { FuelCapacity: 400000 }), hauler(3, 320000, { FuelCapacity: 400000 })]
    const colony = ledgerOf(ctx, { ships: colonyShips, stops: [at(1, 'Big'), at(null, 'Far')], sites: sitesOf([colonyRow(1, { FuelStockpile: 1e7 })], [], { rates: { MaxRefuellingRate: 160000, UnderwayReplenishmentRate: 0 } }) })

    assert.deepEqual([1, 2, 3].map((id) => firstService(colony).perShip.get(id)), [160000, 320000, 80000], 'the receipts')
    near(colony.stops[0].hours, 2, 'the ship that receives 320,000 L at 160,000 L/h takes 2 h')
    assert.equal(firstService(colony).limiting.id, 2, 'the limiting ship is the one that receives most')

    const two = depotFleet([tanker(501), tanker(502)])
    const single = ledgerOf(ctx, { ships: [hauler(1, 0, { FuelCapacity: 450000 })], stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [two]) })

    near(single.stops[0].hours, 1, 'one recipient of 450,000 L takes at least 1 h from two tankers of 450,000 L/h, not 0.5 h')
    assert.equal(single.stops[0].bound, 'at-least', 'the figure is a lower bound')

    const four = ledgerOf(ctx, { ships: [1, 2, 3, 4].map((id) => hauler(id, 0, { FuelCapacity: 450000 })), stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [two]) })

    near(four.stops[0].hours, 2, 'four recipients of 450,000 L each take at least 2 h')
  },
}

const returnChecks = {
  id: 'return',
  name: 'a cycle of three legs: the origin fill leaves a residual that the closing visit draws, the litres on return are those before the closing fill, and the limiting ship is the one with the smallest share over the plan',
  run: (ctx) => {
    const ledger = ledgerOf(ctx, { ships: [hauler(1, 40), hauler(2, 30, { FuelCapacity: 90 })], legs: [KM, KM, KM], stops: [at(1, 'Origin'), at(null, 'Mid'), at(null, 'Far'), at(1, 'Origin')], sites: sitesOf([colonyRow(1, { FuelStockpile: 150 })]), cycle: true })
    const opening = firstService(ledger)
    const closing = ledger.stops[3].service.services[0]

    assert.deepEqual([opening.perShip.get(1), opening.perShip.get(2)], [60, 60], 'the opening fill takes 60 L each')
    near(opening.residual, 30, 'the opening fill leaves 30 L')
    assert.deepEqual([ledger.returnFuel.get(1), ledger.returnFuel.get(2)], [70, 60], 'the litres on return, before the closing fill')
    assert.deepEqual([closing.perShip.get(1), closing.perShip.get(2)], [30, 0], 'the closing visit draws what the opening visit left, the first ship by ID first')
    near(closing.residual, 0, 'the closing fill leaves nothing')
    assert.equal(ledger.status, 'ok', 'the run fits')
    assert.deepEqual({ name: ledger.limiting.name, leg: ledger.limiting.leg, stop: ledger.limiting.stop }, { name: 'Ship 2', leg: 2, stop: 'Origin' }, 'the ship with 60 of 90 L on return is the limiting one')

    const seconds = ctx.mod.serviceSeconds(ledger)

    near(seconds.closing, (30 / 80000) * 3600, 'the closing fill of 30 L at 80,000 L/h')
    near(seconds.origin, (90 / 80000) * 3600, 'the origin takes the opening fill of 60 L and the closing fill of 30 L')
    assert.equal(seconds.destination, 0, 'no stop between the origin and its return serves')
  },
}

const requiredChecks = {
  id: 'required',
  name: 'the litres a run needs: to the next stop that serves, with the ship\'s reserve as a floor, and a colony debited that and no more',
  run: (ctx) => {
    const ships = [hauler(1, 20)]
    const reserves = { ship: () => 5, colony: () => null }
    const sites = sitesOf([colonyRow(1, { FuelStockpile: 1000 }), colonyRow(2, { FuelStockpile: 1000 })])
    const far = ledgerOf(ctx, { ships, legs: [KM, KM], stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target: 'required' })

    assert.equal(far.required.find((entry) => entry.stop === 0).litres, 5, 'two legs of 10 L need 20 L, the reserve 5 L and the ship has 20 L')
    assert.equal(firstService(far).perShip.get(1), 5, 'the colony gives 5 L')
    assert.equal(far.stocksAfter.get('colony:1'), 995, 'the colony is debited 5 L and no more')
    assert.equal(far.legs[0].ships[0].departure, 25, 'the ship departs with 25 L')

    const near2 = ledgerOf(ctx, { ships, legs: [KM, KM], stops: [at(1, 'A'), at(2, 'B'), at(null, 'C')], sites, reserves, target: 'required' })

    assert.equal(firstService(near2).perShip.get(1) || 0, 0, 'the next stop that serves is one leg away, the 10 L of the leg and the reserve of 5 L are 15 L and the ship has 20 L')

    const full = ledgerOf(ctx, { ships, legs: [KM, KM], stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target: 'full' })

    assert.equal(firstService(full).perShip.get(1), 80, 'a full fill fills the tank')

    const floored = ledgerOf(ctx, { ships: [hauler(1, 20, { FuelTanker: 1, MinimumFuel: 30 })], legs: [KM, KM], stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target: 'required' })

    assert.equal(floored.required.find((entry) => entry.stop === 0).litres, 30, 'a tanker keeps its class minimum of 30 L when that is over the reserve of 5 L: the two legs of 20 L and the 30 L less the 20 L it has')

    const slow = depotFleet([tanker(501, { RefuellingRate: 15000 })])
    const oversized = ledgerOf(ctx, { ships: [hauler(1, 15, { Size: 39.757 })], legs: [KM, KM], stops: [at(1, 'A'), DEPOT, at(null, 'C')], sites: sitesOf([colonyRow(1, { FuelStockpile: 1000 })], [slow]), target: 'required' })
    const burn = oversized.legs[0].ships[0].litres

    near(oversized.required.find((entry) => entry.stop === 0).litres, 2 * burn - 15, 'a stop whose only source cannot serve a ship of 39.757 HS is no stop that serves for it, so the first stop gives the litres of both legs less the 15 L aboard')
    assert.equal(oversized.status, 'ok', 'the run then fits')

    const unreadMinimum = (fuel) => ledgerOf(ctx, { ships: [hauler(1, fuel, { FuelTanker: 1, MinimumFuel: null })], legs: [KM, KM], stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target: 'required' })

    ;[50, 5].forEach((fuel) => {
      assert.equal(unreadMinimum(fuel).status, 'unknown', `a tanker with no class minimum in the save and ${fuel} L aboard leaves the litres it needs, so the run, not known`)
    })
    assert.equal(unreadMinimum(50).missing.some((text) => text.length > 0), true, 'and the run says what is missing')

    const designated = (changes, fuel = 20) => ledgerOf(ctx, { ships: [hauler(1, fuel, changes)], legs: [KM, KM], stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target: 'required' })
    const requiredOf = (ledger) => [ledger.status, (ledger.required.find((entry) => entry.stop === 0) || {}).litres]

    assert.deepEqual(requiredOf(designated({ FuelTanker: null, MinimumFuel: 30 })), ['unknown', null], 'a class whose designation is not in the save, with a minimum over the reserve: the ship might be a tanker that keeps 30 L, so the litres it needs are not known')
    assert.deepEqual(requiredOf(designated({ FuelTanker: 0, MinimumFuel: 30 })), ['ok', 5], 'a class that is known not to be a tanker keeps the reserve and not the minimum')
    assert.deepEqual(requiredOf(designated({ FuelTanker: null, MinimumFuel: 3 })), ['ok', 5], 'a class whose designation is not in the save but whose minimum is under the reserve keeps the reserve either way')
    assert.deepEqual(requiredOf(designated({ FuelTanker: null, MinimumFuel: null })), ['unknown', null], 'a class with neither the designation nor the minimum in the save leaves the litres not known')
    assert.deepEqual(requiredOf(designated({ FuelTanker: 1, MinimumFuel: 30 })), ['ok', 30], 'a class that is a tanker keeps its minimum')

    const fullTank = (changes) => ledgerOf(ctx, { ships: [hauler(1, 100, changes)], legs: [KM], stops: [at(1, 'A'), at(null, 'B')], sites, reserves, target: 'required' })

    ;[{ FuelTanker: null, MinimumFuel: 30 }, { FuelTanker: null, MinimumFuel: null }, { FuelTanker: 1, MinimumFuel: null }].forEach((changes) => {
      assert.deepEqual([...requiredOf(fullTank(changes)), fullTank(changes).stocksAfter.get('colony:1'), fullTank(changes).tainted], ['ok', 0, 1000, []], `a tank that is full needs nothing whatever the floor of the ship is (${JSON.stringify(changes)}), so the run is known and the colony stock untouched`)
    })
    assert.deepEqual(requiredOf(designated({ FuelTanker: null, MinimumFuel: 30 }, 99)), ['unknown', null], 'a tank one litre short of full with the floor not known still leaves the litres not known')
    assert.deepEqual(requiredOf(ledgerOf(ctx, { ships: [hauler(1, 20, { FuelTanker: 1, MinimumFuel: null })], legs: [KM * 10, KM * 10], stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target: 'required' })), ['range', 80], 'a floor not in the save cannot change what two legs of 100 L need when they already ask for more than the tank holds: the tank is filled')

    const sourceless = ledgerOf(ctx, { ships: [hauler(1, 20, { FuelTanker: null, MinimumFuel: 30 })], legs: [KM, KM], stops: [at(null, 'A'), at(1, 'B'), at(null, 'C')], sites, reserves, target: 'required' })

    assert.deepEqual([sourceless.status, sourceless.unknownAt, sourceless.required.find((entry) => entry.stop === 0).litres, sourceless.rejected[0].reason], ['unknown', 0, null, 'required-unknown'], 'a stop with no source whose litres are not known is the first doubt of the run all the same: the litres the run needs there decide what the stops after it hold')
  },
}

const gateChecks = {
  id: 'gates',
  name: 'the gates of a service: a fleet that moved in the last pulse, a first order that is not stationary and every tanker blocked do not serve, and a colony with no population but a point and a stock does',
  run: (ctx) => {
    const ships = [hauler(1, 40)]
    const serviceOf = (sites) => firstService(ledgerOf(ctx, { ships, stops: [DEPOT, at(null, 'Far')], sites }))
    const reasonOf = (service) => ({ permission: service.permission, reason: service.reason })

    assert.deepEqual(reasonOf(serviceOf(sitesOf([], [depotFleet([tanker(501)], { LastMoveTime: GAME_TIME })]))), { permission: 'blocked', reason: 'moved-this-pulse' }, 'a fleet that moved in the last pulse')
    assert.deepEqual(reasonOf(serviceOf(sitesOf([], [depotFleet([tanker(501)], { FirstOrderStationary: 0 })]))), { permission: 'blocked', reason: 'first-order-not-stationary' }, 'a first order that is not stationary')
    assert.deepEqual(reasonOf(serviceOf(sitesOf([], [depotFleet([tanker(501, { TransferSystems: 0, UndamagedTransfer: 0 })])]))), { permission: 'blocked', reason: 'no-eligible-tanker' }, 'every tanker blocked')
    assert.deepEqual(reasonOf(serviceOf(sitesOf([], [depotFleet([tanker(501)])]))), { permission: 'allowed', reason: null }, 'a stationary fleet that has not moved serves')

    const empty = firstService(ledgerOf(ctx, { ships, stops: [at(1, 'Empty'), at(null, 'Far')], sites: sitesOf([colonyRow(1, { Population: 0, FuelStockpile: 1000 })]) }))

    assert.deepEqual({ permission: empty.permission, received: empty.received }, { permission: 'allowed', received: 60 }, 'a colony of population 0 with a point and a stock serves')
  },
}

const unknownChecks = {
  id: 'unknown',
  name: 'an input that is not in the save leaves the run unknown and names the input, never 0 and never dry: the fuel aboard, the stock of a colony, the last move of a fleet',
  run: (ctx) => {
    const nullFuel = ledgerOf(ctx, { ships: [hauler(1, null)], stops: [at(1, 'A'), at(null, 'Far')], sites: sitesOf([colonyRow(1)]) })

    assert.equal(nullFuel.status, 'unknown', 'the fuel aboard is not known')
    assert.equal(nullFuel.missing.some((text) => text.includes('Ship 1')), true, 'the ship is named')
    assert.deepEqual(nullFuel.legs, [], 'no leg is worked out from a fuel that is not known')

    const stock = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [at(1, 'A'), at(null, 'Far')], sites: sitesOf([colonyRow(1, { FuelStockpile: null })]) })

    assert.deepEqual({ permission: firstService(stock).permission, reason: firstService(stock).reason, status: stock.status }, { permission: 'unknown', reason: 'stock-unknown', status: 'unknown' }, 'the stock of the colony is not known and the ship needs it')

    const moved = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [depotFleet([tanker(501)], { LastMoveTime: null })]) })

    assert.deepEqual({ permission: firstService(moved).permission, reason: firstService(moved).reason, status: moved.status }, { permission: 'unknown', reason: 'moved-unknown', status: 'unknown' }, 'the last move of the fleet is not known')

    const reserve = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [at(1, 'A'), at(null, 'Far')], sites: sitesOf([colonyRow(1)]), reserves: null })

    assert.equal(reserve.status, 'unknown', 'reserves not read leave the run unknown')
    assert.equal(reserve.stocksAfter.get('colony:1'), null, 'the stock the undecided service may have drawn is not known')

    const mixed = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [depotFleet([tanker(501, { Fuel: 100001 }), tanker(502, { Fuel: null })])]) })
    const give = firstService(mixed)

    assert.deepEqual({ permission: give.permission, reason: give.reason, received: give.received, status: mixed.status, held: mixed.stocksAfter.get('tanker:502') }, { permission: 'unknown', reason: 'donors-partial', received: null, status: 'unknown', held: null }, 'a tanker whose fuel is not in the save beside a known one leaves the service not known, with no litres received and the stock of both not known')

    const far = { name: 'Far', PopulationID: null, SystemID: 2, Xcor: 5, Ycor: 5 }
    const lone = (name, id, shipId) => fleetOf(ctx, name, id, [hauler(shipId, 40)], [KM * 8], [DEPOT, far])
    const followed = ctx.mod.netLedgers([lone('Alpha', 5, 11), lone('Bravo', 6, 21)], { sites: sitesOf([], [depotFleet([tanker(501, { Fuel: 100060 }), tanker(502, { Fuel: null })])]), reserves: READ, version: VERSION })

    assert.deepEqual(statusesOf(followed), [['Ship 11', 'unknown'], ['Ship 21', 'unknown']], 'the first fleet is not known from the stop with the tanker not decided; the second draws on a tanker that run touched, so it is not known either, not out of range')
    assert.equal(followed.stocks.get('tanker:502'), null, 'the stock of the tanker not decided is not known after the second fleet')

    const oversized = (...fuels) => ledgerOf(ctx, { ships: [hauler(1, 5, { Size: 39.757 })], stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [depotFleet(fuels.map((fuel, index) => tanker(501 + index, { RefuellingRate: 15000, Fuel: fuel })))]) })
    const slowOnly = oversized(100001, null)

    assert.deepEqual({ permission: firstService(slowOnly).permission, reason: firstService(slowOnly).reason, status: slowOnly.status }, { permission: 'unknown', reason: 'donors-partial', status: 'unknown' }, 'a tanker whose fuel is not in the save leaves the stop not known, whatever the tankers that are known could not serve')

    const quickUndecided = ledgerOf(ctx, { ships: [hauler(1, 5, { Size: 39.757 })], stops: [DEPOT, at(null, 'Far')], sites: sitesOf([], [depotFleet([tanker(501, { RefuellingRate: 15000, Fuel: 100001 }), tanker(502, { RefuellingRate: 20000, Fuel: null })])]) })

    assert.deepEqual({ permission: firstService(quickUndecided).permission, reason: firstService(quickUndecided).reason, status: quickUndecided.status }, { permission: 'unknown', reason: 'donors-partial', status: 'unknown' }, 'a tanker of 20,000 L/h whose fuel is not in the save might serve that recipient, so the stop is not known')

    const carried = (changes) => ledgerOf(ctx, { ships: [hauler(1, 50), hauler(2, 10, { MothershipID: 1, CarrierFleetID: 5, CarrierMothershipID: 0, ...changes })], stops: [at(1, 'A'), at(null, 'Far')], sites: sitesOf([colonyRow(1)]) })

    assert.deepEqual({ status: carried({}).status, missing: carried({}).missing }, { status: 'ok', missing: [] }, 'a carried ship with its tank in the save is a recipient and the run is known')
    assert.deepEqual({ status: carried({ FuelCapacity: null }).status, missing: carried({ FuelCapacity: null }).missing }, { status: 'unknown', missing: ['the fuel capacity of Ship 2'] }, 'a carried ship whose tank is not in the save is not read as a ship with no tank: the run is not known and names the ship')

    const stagesOf = () => ledgerOf(ctx, { ships: [hauler(1, 20)], legs: [KM, KM, KM], stops: [at(1, 'A'), at(2, 'B'), at(3, 'C'), at(null, 'D')], sites: sitesOf([colonyRow(1), colonyRow(2, { FuelStockpile: null }), colonyRow(3)]) })
    const stages = stagesOf()
    const [before, doubted, after] = stages.stops

    assert.deepEqual([before.service.permission, before.receivedTotal, close(before.hours, 80 / 80000), before.departure.get(1), stages.legs[0].ships[0].arrival], ['allowed', 80, true, 100, 90], 'the first doubted stop: the stops before it keep their receipts, hours and the fuel on each leg')
    assert.deepEqual([doubted.arrival.get(1), doubted.service.permission, doubted.service.services[0].reason, doubted.receivedTotal, doubted.departure, doubted.hours, stages.unknownAt], [90, 'unknown', 'stock-unknown', null, null, null, 1], 'the first doubted stop: the ship arrives with the fuel the stops before it left, and the service, the receipt and the departure there are not known')
    assert.deepEqual([after.arrival, after.service.permission, after.service.services[0].permission, after.service.services[0].reason, after.service.services[0].received, after.service.services[0].residual, after.service.services[0].hours, after.hours, after.receivedTotal, stages.stops[3].arrival], [null, 'unknown', 'unknown', 'earlier-doubt', null, null, null, null, null, null], 'a stop after the first doubted one carries it: its source reads not known whatever it would give, with no figure, and no fuel arrives')
    assert.deepEqual([stages.legs.map((leg) => leg.status), stages.legs[1].ships[0].arrival, stages.status, stages.returnFuel, stages.limiting, stages.rejected.map((entry) => entry.reason), stages.required.map((need) => need.litres), stages.stocksAfter.get('colony:1'), stages.stocksAfter.get('colony:2'), stages.stocksAfter.get('colony:3'), [...stages.tainted].sort()], [['ok', 'unknown', 'unknown'], null, 'unknown', null, null, ['stock-unknown'], [null, null, null], 920, null, null, ['colony:2', 'colony:3']], 'from the first doubted stop the legs, the return, the limiting ship and the litres a run needs are not known, the cause is listed once, and the sources that stop and the stops after it touch are not known')
    assert.deepEqual(ctx.mod.ledgerRows(stages).map((row) => [row.received, row.legs.map((leg) => leg.departure), row.returned]), [[[80, null, null, null], [100, null, null], null]], 'the rows read the receipts and the leg fuel of the stops before the first doubt, and not known after it')

    const touched = ctx.mod.netLedgers([fleetOf(ctx, 'Alpha', 5, [hauler(11, 20)], [KM, KM, KM], [at(1, 'A'), at(2, 'B'), at(3, 'C'), at(null, 'D')]), fleetOf(ctx, 'Bravo', 6, [hauler(21, 40)], [KM], [at(3, 'C'), far]), fleetOf(ctx, 'Carol', 7, [hauler(31, 40)], [KM], [at(1, 'A'), far])], { sites: sitesOf([colonyRow(1), colonyRow(2, { FuelStockpile: null }), colonyRow(3)]), reserves: READ, version: VERSION })

    assert.deepEqual([statusesOf(touched), touched.ledgers[1].stops[0].service.services[0].reason, touched.ledgers[2].stops[0].service.services[0].reason], [[['Ship 11', 'unknown'], ['Ship 21', 'unknown'], ['Ship 31', 'ok']], 'draw-ahead-unknown', null], 'a fleet behind draws on a source that a doubted run touched after its first doubt: not known there, while a source that run drew before it is known')

    const noSites = ledgerOf(ctx, { ships: [hauler(1, 20)], legs: [KM, KM], stops: [at(1, 'A'), at(null, 'B'), at(1, 'A')], sites: null, cycle: true })

    assert.deepEqual([noSites.status, noSites.unknownAt, noSites.stops.map((stop) => stop.permission), noSites.stops.map((stop) => stop.arrival === null), noSites.returnFuel, noSites.rejected.map((entry) => entry.reason)], ['unknown', 0, ['unknown', 'unknown', 'unknown'], [false, true, true], null, ['sites-unread', 'sites-unread', 'sites-unread']], 'the sites not read doubt every stop that serves, and the stops after the first carry it')

    const blockedAmong = ledgerOf(ctx, { ships: [hauler(1, 20)], legs: [KM], stops: [at(1, 'A'), at(null, 'B')], sites: sitesOf([colonyRow(1, { FuelStockpile: 0 })], [depotFleet([tanker(501, { TransferSystems: null })], { OrbitBodyID: 10 })]) })

    assert.deepEqual([blockedAmong.stops[0].service.services.map((part) => part.reason), blockedAmong.tainted], [['earlier-doubt', 'donors-unknown'], ['tanker:501']], 'a source whose service is blocked for a known cause is no source the doubted stop touches: only the tanker not decided is not known to the fleets behind')

    const slowBehind = ledgerOf(ctx, { ships: [hauler(1, 40, { Size: 20 }), hauler(2, 40, { Size: 40 })], legs: [KM * 2, KM * 2], stops: [at(1, 'Origin'), DEPOT, at(null, 'Far')], sites: sitesOf([colonyRow(1, { FuelStockpile: null })], [depotFleet([K()]), depotFleet([tanker(601, { Fuel: 100060, RefuellingRate: 15000 })], { FleetID: 901 })]) })

    assert.deepEqual([slowBehind.unknownAt, slowBehind.stops[1].service.services.map((part) => part.reason), [...slowBehind.tainted].sort()], [0, ['earlier-doubt', 'earlier-doubt'], ['colony:1', 'tanker:501', 'tanker:601']], 'a source blocked at a stop after the first doubt because the recipient left to it is too large was blocked on the demand the run had when it was doubted, which the unknown input may have changed (the small ship may need more of the fast tanker and so draw on the slow one): it is touched all the same, and not known to the fleets behind')

    const shaken = ctx.mod.netLedgers([fleetOf(ctx, 'Alpha', 5, [hauler(11, 40)], [KM * 3, KM * 3], [DEPOT, at(1, 'Dest'), DEPOT], true), oneShip(ctx, 'Bravo', 6, 21, 40, KM * 8)], { sites: sitesOf([colonyRow(1, { FuelStockpile: 100 })], [depotFleet([tanker(501)], { LastMoveTime: null })]), reserves: READ, version: VERSION })

    assert.equal(shaken.ledgers[0].stocksAfter.get('colony:1'), null, 'a visit that cannot be decided may give the fleet litres, so what it then takes at the next stop, and the stock there, are not known')
    assert.deepEqual(statusesOf(shaken), [['Ship 11', 'unknown'], ['Ship 21', 'unknown']], 'the fleet behind finds that stock not known, not short')

    const quick = (changes) => depotFleet([tanker(601, changes)], { FleetID: 901, FleetName: 'Tanks 2' })
    const sameStop = ledgerOf(ctx, { ships: [hauler(1, 40)], stops: [DEPOT, far], legs: [KM * 8], sites: sitesOf([], [depotFleet([tanker(501, { RefuellingRate: 15000 })], { LastMoveTime: null }), quick({})]) })

    assert.deepEqual([sameStop.status, sameStop.stocksAfter.get('tanker:601'), sameStop.tainted.includes('tanker:601')], ['unknown', null, true], 'a fleet at the stop that cannot be decided may give before the next one, so the draw of the next one is not known')

    const legless = (cycle) => ledgerOf(ctx, { ships: [hauler(1, 40)], legs: cycle ? [null, null] : [null], stops: cycle ? [at(1, 'A'), at(null, 'B'), at(1, 'A')] : [at(1, 'A'), at(null, 'B')], sites: sitesOf([colonyRow(1, { FuelStockpile: 120 })]), cycle })

    assert.deepEqual([legless(true).status, legless(true).stocksAfter.get('colony:1'), legless(true).tainted], ['unknown', null, ['colony:1']], 'a leg whose length is not known leaves the closing visit unsimulated, which may draw from the colony: the stock is not known')
    assert.deepEqual([legless(false).status, legless(false).stocksAfter.get('colony:1')], ['unknown', 60], 'with no visit after the leg the stock the first visit left is known')

    const pair = (second) => ledgerOf(ctx, { ships: [hauler(1, 40), hauler(2, 40, second)], stops: [DEPOT, far], sites: sitesOf([], [depotFleet([tanker(501, { Fuel: 100060 })])]) })
    const rowsOf = (ledger) => ctx.mod.ledgerRows(ledger)
    const known = pair({})
    const unread = pair({ RefuelPriority: null })

    assert.deepEqual([rowsOf(known).map((row) => row.received[0]), rowsOf(known).map((row) => row.legs[0].departure)], [[60, 0], [100, 40]], 'with both priorities in the save the one tanker fills the first ship and leaves the second what it has')
    assert.deepEqual([rowsOf(unread).map((row) => row.received[0]), rowsOf(unread).map((row) => row.legs[0].departure), unread.limiting, firstService(unread).received, firstService(unread).residual, firstService(unread).limiting, firstService(unread).tankers[0].residual, unread.status], [[null, null], [null, null], null, null, null, null, null, 'unknown'], 'a ship whose priority is not in the save could be served first, so what each ship receives, the fuel it leaves with and the figures of the service are not known, though the fuel of the baseline order would be a definite number')

    const cyclic = (leader, follower) => ctx.mod.netLedgers([fleetOf(ctx, 'Alpha', 5, [hauler(11, leader.fuel, { Size: leader.size })], [KM * 2, KM * 2], [DEPOT, at(2, 'Dest'), DEPOT], true), fleetOf(ctx, 'Bravo', 6, [hauler(21, follower.fuel, { Size: follower.size })], [KM * 2, KM * 2], [DEPOT, at(2, 'Dest'), DEPOT], true)], { sites: sitesOf([colonyRow(2, { FuelStockpile: leader.stock })], [depotFleet([tanker(501, { Fuel: 100060, RefuellingRate: 15000 })], { LastMoveTime: leader.moved })]), reserves: READ, version: VERSION })
    const afterUnknown = cyclic({ fuel: 40, size: 20, stock: 100, moved: null }, { fuel: 40, size: 40 })
    const destination = afterUnknown.ledgers[0].stops[1].service.services[0]

    assert.deepEqual([destination.received, destination.residual, rowsOf(afterUnknown.ledgers[0]).map((row) => row.received[1]), afterUnknown.ledgers[0].stocksAfter.get('colony:2'), afterUnknown.ledgers[0].status], [null, null, [null], null, 'unknown'], 'a fill at the origin that cannot be decided changes what the fleet wants at the destination (80 L if the origin gave nothing, 20 L if it filled the tank), so the receipt there is not known, nor the stock it leaves')

    const driedUp = cyclic({ fuel: 5, size: 20, stock: 50, moved: null }, { fuel: 40, size: 40 })

    assert.deepEqual([statusesOf(driedUp), driedUp.ledgers[0].tainted.includes('colony:2')], [[['Ship 11', 'unknown'], ['Ship 21', 'unknown']], true], 'a fleet that runs dry on the baseline before a visit only because an origin fill cannot be decided could reach that visit and draw there, so the stock is not known for the fleet behind')

    const slow = (tankers) => ctx.mod.tankerService(depotFleet(tankers), [R(1, 20, 60)], { gameTime: GAME_TIME, reserves: READ, version: VERSION })
    const alone = slow([K()])
    const beside = slow([K(), U()])

    assert.deepEqual([typeof alone.hours, alone.residual, alone.limiting === null, beside.hours, beside.residual], ['number', 0, false, null, null], 'beside a tanker that could also give the hours (a lower bound by every rate) and the litres left are not known; alone they are')

    const needs = (moved) => ledgerOf(ctx, { ships: [hauler(1, 30)], legs: [KM * 2, KM * 2], stops: [DEPOT, at(2, 'Dest'), far], target: 'required', sites: sitesOf([colonyRow(2, { FuelStockpile: 100 })], [depotFleet([tanker(501, { Fuel: 100060, RefuellingRate: 15000 })], { LastMoveTime: moved })]) }).required.filter((need) => need.stop === 1).map((need) => typeof need.litres)

    assert.deepEqual([needs(null), needs(0)], [['object'], ['number']], 'the litres the run to the next stop needs at the destination are counted from the fuel the ship arrives with, which an origin fill that cannot be decided changes: not known then, a figure when the fill is')

    const prefix = (stock) => ledgerOf(ctx, { ships: [hauler(1, 40), hauler(2, 100, { EnginePower: 90, UndamagedEnginePower: 90 })], legs: [KM, KM], stops: [at(null, 'A'), at(1, 'B'), at(null, 'C')], sites: sitesOf([colonyRow(1, { FuelStockpile: stock })]) })

    assert.deepEqual([prefix(null).limiting, prefix(1000).limiting.name], [null, 'Ship 1'], 'a stock that is not in the save could leave the ship of the first leg or the ship that burns more on the second the one that arrives with the least of its tank: no limiting ship is named while the legs after it are not known')

    const blind = ledgerOf(ctx, { ships: [hauler(1, 40)], legs: [KM, null], stops: [at(null, 'A'), at(null, 'B'), at(null, 'C')] })

    assert.deepEqual([blind.status, blind.limiting], ['unknown', null], 'a leg whose length is not known could leave any ship the one with the least of its tank, so the limiting ship of the legs before it is not named')

    const drawnAhead = (moved) => cyclic({ fuel: 40, size: 20, stock: 100, moved }, { fuel: 40, size: 40 }).ledgers[1].stops[1].service.services[0].takenAhead.map((item) => [item.fleet, typeof item.litres])

    assert.deepEqual([drawnAhead(null), drawnAhead(0)], [[['Alpha', 'object']], [['Alpha', 'number']]], 'what a fleet ahead took of a stock is not known where the fill that fed that draw could not be decided: the fleet behind reads it as not known, not as the baseline litres')

    const behind = (...taken) => ctx.mod.tankerService(depotFleet([K()]), [R(1, 20, 60)], { gameTime: GAME_TIME, reserves: READ, version: VERSION, ahead: { taken: new Map([['tanker:501', taken]]), unknown: new Map() } }).takenAhead

    assert.deepEqual([behind({ fleet: 'Alpha', litres: 5 }, { fleet: 'Alpha', litres: 7 }), behind({ fleet: 'Alpha', litres: null }, { fleet: 'Alpha', litres: 7 }), behind({ fleet: 'Alpha', litres: 5 }, { fleet: 'Bravo', litres: null })], [[{ fleet: 'Alpha', litres: 12 }], [{ fleet: 'Alpha', litres: null }], [{ fleet: 'Alpha', litres: 5 }, { fleet: 'Bravo', litres: null }]], 'what the fleets ahead took of a tanker is summed per fleet where every draw is known and is not known for the fleet where any is')

    const timed = (...tankers) => ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [DEPOT, far], legs: [KM * 8], sites: sitesOf([], [depotFleet(tankers)]) })

    const hoursOnly = timed(tanker(502), tanker(503, { TransferSystems: null }))

    assert.deepEqual([ctx.mod.timingKnown(timed(K())), ctx.mod.timingKnown(timed(K(), tanker(502, { RefuellingRate: 450000, TransferSystems: null }))), ctx.mod.timingKnown(null), hoursOnly.status, ctx.mod.timingKnown(hoursOnly)], [true, false, true, 'unknown', false], 'the hours of a fill that a tanker not decided could shorten are not known, so the time built on them is not: a round trip is timed on the hours it knows only where all are, and a tanker not decided leaves the run not known')

    const undecidedStop = ledgerOf(ctx, { ships: [hauler(1, 5)], stops: [DEPOT, far], legs: [KM * 8], sites: sitesOf([], [depotFleet([K()], { LastMoveTime: null })]) })

    assert.deepEqual([undecidedStop.status, ctx.mod.timingKnown(undecidedStop)], ['unknown', false], 'a service whose permission cannot be decided could add a fill of any length to the cycle, so the time is not known')

    const origin = { name: 'Origin', PopulationID: 1, SystemID: 3, Xcor: 9, Ycor: 9 }
    const lookahead = (moved) => ledgerOf(ctx, { ships: [hauler(1, 5)], legs: [KM * 2, KM * 2], stops: [origin, DEPOT, far], target: 'required', sites: sitesOf([colonyRow(1, { FuelStockpile: 1000 })], [depotFleet([tanker(501, { Fuel: 100060, RefuellingRate: 15000 })], { LastMoveTime: moved })]) })
    const targets = [null, 0, GAME_TIME].map((moved) => lookahead(moved).required.find((need) => need.stop === 0).litres)

    assert.deepEqual(targets, [null, 15, 35], 'the litres the origin fill takes depend on whether the destination serves (the run needs 20 L to reach it, or 40 L to pass it): where the destination cannot be decided the target is not known, and where it can it is 15 L or 35 L')

    const unreached = cyclic({ fuel: 5, size: 20, stock: 50, moved: null }, { fuel: 40, size: 40 }).ledgers[1].stops[1].service.services[0].takenAhead.map((item) => [item.fleet, item.litres])

    assert.deepEqual(unreached, [['Alpha', null]], 'a fleet ahead that could reach a stock and draw there in some completion is named with a draw that is not known, not left out of the draws ahead')

    const noteWith = (low) => {
      const sized = (name, id, shipId, size) => fleetOf(ctx, name, id, [hauler(shipId, 40, { Size: size })], [KM, KM], [far, DEPOT, far], true)
      const net = ctx.mod.netLedgers([sized('Alpha', 5, 11, 40), sized('Bravo', 6, 21, 20)], { sites: sitesOf([], [depotFleet([tanker(501, { Fuel: 100400 }), tanker(502, { RefuellingRate: 15000, Fuel: low })])]), reserves: READ, version: VERSION })

      return ctx.mod.ledgerNote(net.ledgers[1], { litres: String }) || ''
    }

    assert.deepEqual([noteWith(null), noteWith(100000)].map((note) => /leaves/.test(note)), [false, true], 'the litres a draw leaves are not printed where the residual of a source is not known, and are where it is')

    const given = { permission: 'allowed', takenAhead: [{ fleet: 'Alpha', litres: null }, { fleet: 'Bravo', litres: 5 }], residual: 3 }
    const served = { service: { permission: 'allowed', services: [given] }, receivedTotal: 7, stop: { name: 'X' }, hours: null }
    const drawNote = ctx.mod.ledgerNote({ status: 'ok', draw: { position: 3 }, stops: [served] }, { litres: String })
    const dryOf = (stop) => ctx.mod.ledgerNote({ status: 'range', dryLeg: 0, legs: [{ from: { name: 'A' }, to: { name: 'B' }, ships: [{ status: 'dry', shortfall: 5, name: 'S' }] }], rejected: [], stops: [stop] }, { litres: String })
    const dryNote = dryOf(served)
    const unknownOnly = dryOf({ ...served, service: { permission: 'allowed', services: [{ ...given, takenAhead: [{ fleet: 'Alpha', litres: null }] }] } })

    assert.deepEqual([drawNote, dryNote].map((note) => [note.includes('Bravo'), note.includes('Alpha')]), [[true, false], [true, false]], 'a fleet ahead whose draw is not known is not named as drawing first, in the note of a draw or of a dry run')
    assert.equal(unknownOnly.includes('draw first'), false, 'no fleet is said to draw first where the only draw ahead is not known')

    const blocked = { stop: 0, permission: 'blocked', reason: 'taken-ahead', stopName: 'Depot', text: 'The fuel is drawn by the fleets ahead' }
    const whyOf = (ahead) => ctx.mod.ledgerNote({ status: 'range', dryLeg: 0, legs: [{ from: { name: 'A' }, to: { name: 'B' }, ships: [{ status: 'dry', shortfall: 5, name: 'S' }] }], rejected: [{ ...blocked, ahead }], stops: [{ service: null }] }, { litres: String })

    assert.deepEqual([whyOf([{ fleet: 'Alpha', litres: null }]).includes('before it'), whyOf([{ fleet: 'Alpha', litres: null }, { fleet: 'Bravo', litres: 5 }]).includes('Alpha'), whyOf([{ fleet: 'Alpha', litres: null }, { fleet: 'Bravo', litres: 5 }]).includes('Bravo')], [false, false, true], 'a fleet is said to have drawn a source dry only where its draw is known')

    const behindSmall = (moved) => {
      const sized = (name, id, shipId, size, fuel) => fleetOf(ctx, name, id, [hauler(shipId, fuel, { Size: size })], [KM, KM], [far, DEPOT, far], true)
      const net = ctx.mod.netLedgers([sized('Alpha', 5, 11, 20, 40), sized('Bravo', 6, 21, 40, 25)], { sites: sitesOf([], [depotFleet([tanker(501, { Fuel: 100060, RefuellingRate: 15000 })], { LastMoveTime: moved })]), reserves: READ, version: VERSION })

      return [net.ledgers[1].status, net.ledgers[1].rejected.filter((entry) => entry.stop === 1).map((entry) => entry.reason)]
    }

    assert.deepEqual([behindSmall(null), behindSmall(GAME_TIME)], [['range', ['recipient-too-large']], ['range', ['moved-this-pulse']]], 'a recipient too large for the only tanker is blocked by its size whatever the fleet ahead drew of a stock that is not known, and by the move where the tanker moved')
  },
}

// The page's own run methods over a moving route with the real route-position adapters and the orbit propagation, taken from the source of the page: two circular asteroid orbits (0.02 AU at 90 degrees in 48 h and 0.04 AU at 270 degrees in 96 h), a destination tanker fleet of a slow tanker and a fast one whose transfer systems are as the case says, and a hauler of 2,025,000 L aboard and 3,025,000 L of tank burning 1,000,000 L/h.
const methodText = (page, name) => {
  const start = page.indexOf(`    ${name}(`)
  const end = page.indexOf('\n    },', start)

  assert.equal(start >= 0 && end > start, true, `the page has the method ${name}`)

  return page.slice(start, end + 7)
}

const ROW_METHODS = ['safeFields', 'positionsOf', 'pathOf', 'fleetLedgers', 'fleetStageOf', 'flownTripOf', 'flownLegs', 'fleetRunOf', 'simulate', 'propagationOf']
const MOTION_MODULES = ['route-position', 'route-plan', 'jump-graph', 'orbit-propagation', 'route-time', 'transport', 'math', 'load-tracking', 'safe-routes']

const rockOf = (id, distance, bearing, year) => ({ id, systemId: 1, starId: 1, bodyClass: 3, trojan: 0, distance, bearing, year, eccentricity: 0, direction: 0, parentId: 0, parentType: 0, fixed: 0, xcor: distance * 149600000 * Math.cos(((bearing - 90) * Math.PI) / 180), ycor: distance * 149600000 * Math.sin(((bearing - 90) * Math.PI) / 180) })

const motionOf = async (ctx) => {
  const loaded = await loadUtilities(MOTION_MODULES)
  const { page } = ctx
  const constantText = page.slice(page.indexOf('const stopOf ='), page.indexOf('\n', page.indexOf('const capitalised =')))
  // eslint-disable-next-line no-new-func
  const constants = new Function('serviceSeconds', `${constantText}\nreturn { stopOf, sumOf, serviceOf, capitalised }`)(ctx.mod.serviceSeconds)
  const dependency = { ...loaded['route-position'], ...loaded['route-plan'], ...loaded['jump-graph'], ...loaded['orbit-propagation'], ...loaded['route-time'], ...loaded['safe-routes'], ...loaded.transport, ...ctx.fp, ...ctx.mod, ...loaded['load-tracking'], ...constants, SECONDS_PER_DAY: 86400 }
  const keys = Object.keys(dependency).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default')
  const viewText = page.slice(page.indexOf('    ledgerFields(ledger) {'), page.indexOf('    // The round trip sailed cycle after cycle'))
  // eslint-disable-next-line no-new-func
  const methods = new Function(...keys, `return { ${ROW_METHODS.map((name) => methodText(page, name)).join('\n')}\n${viewText} }`)(...keys.map((key) => dependency[key]))
  const format = fs.readFileSync(path.join(root, 'src/renderer/mixins/count-format.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  const counts = new Function('countText', 'isKnownNumber', `return { ${format.slice(format.indexOf('    count(value,'), format.lastIndexOf('\n  },'))} }`)(loaded.math.countText, loaded.math.isKnownNumber)
  const rocks = [rockOf(10, 0.02, 90, 48), rockOf(20, 0.04, 270, 96)]
  // The orbits three times as far and as slow, for the case in which only the closing fill has hours that are not known.
  const wide = rocks.map((rock) => rockOf(rock.id, rock.distance * 3, rock.bearing, rock.year * 3))

  // The row of the fleet as the page builds it, with the endpoints moving (both switches of the game) or held, the transfer systems of the fast tanker as `systems` and the fill target `required` or the full tank. With `closing` ({ priority }) the case is the closing-only one: the wide orbits, the colony with the stock at the destination, a tanker at the origin that serves the closing visit, and a second ship whose class refuelling priority is `priority` (null: not in the save, which leaves only the closing fill undecided).
  return ({ moving, systems, required = false, closing = null }) => {
    const bodies = closing ? wide : rocks
    const facts = { clock: { gameTime: GAME_TIME, lastGrowthTime: GAME_TIME, orbitalMotion: moving, orbitalMotionAst: moving }, fleets: {}, waypoints: {}, problems: [], orbits: { bodies: Object.fromEntries(bodies.map((rock) => [rock.id, rock])), stars: { 1: { id: 1, component: 1, xcor: 0, ycor: 0 } }, points: {}, hidden: {}, hiddenPoints: {}, bodyOf: { 1: 10, 2: 20 }, problems: [] } }
    const columns = bodies.map((rock, index) => ({ ...colonyRow(index + 1), ShuttleCapacity: 1, ServiceNames: 'Spaceport', FuelStockpile: (index === 0) === !closing ? 100000000 : 0, RefuellingPoints: (index === 0) === !closing ? 1 : 0, Xcor: rock.xcor, Ycor: rock.ycor }))
    const places = columns.map((colony, index) => ({ key: `colony:${colony.PopulationID}`, kind: 'colony', name: index ? 'Destination' : 'Origin', colony, group: 'asteroid', SystemID: 1, Xcor: colony.Xcor, Ycor: colony.Ycor }))
    const route = loaded['jump-graph'].searchRoutes([], [places[0]], { order: 'km' }).toPlace(places[1])
    const tank = { FuelCapacity: closing ? 9025000 : 3025000, FuelEfficiency: 50000, CargoCapacity: 1, ColonistCapacity: 0 }
    const ships = closing ? [hauler(1, 9025000, tank), hauler(2, 9025000, { ...tank, ClassRefuelPriority: closing.priority })] : [hauler(1, 2025000, tank)]
    const profile = ctx.fp.fleetProfile(ships, { FleetID: 5, FleetName: 'Moving timing' }, { basis: 'maximum' })
    const endpoints = { origin: loaded.transport.colonyEndpoint(columns[0]), destination: loaded.transport.colonyEndpoint(columns[1]) }
    const setup = { fleet: { FleetID: 5, FleetName: 'Moving timing' }, profile, reach: { pending: false, route }, ledgerable: true }
    const depot = closing ? depotFleet([tanker(601, { Fuel: 1100000, RefuellingRate: 450000 })], { OrbitBodyID: 10 }) : depotFleet([tanker(501, { Fuel: 5000000, RefuellingRate: 15000 }), tanker(502, { Fuel: 5000000, RefuellingRate: 450000, TransferSystems: systems })], { OrbitBodyID: 20 })
    const vm = { ...methods, ...counts, separator: '\'', origin: places[0], destination: places[1], avoid: { active: false }, positionRead: facts, useLagrange: false, database: null, officerSupport: null, systemDust: {}, formulaVersion: VERSION, fuelSites: sitesOf(columns, [depot]), fuelReserveReader: { ship: () => 5, colony: () => 0 }, fillRequired: required, loadErrors: { fuelSites: null } }
    const held = vm.fleetLedgers([setup], (entry) => [entry.reach.route.km, entry.reach.route.km]).get(5)
    const stage = vm.fleetStageOf(setup, endpoints, held)
    const ledger = vm.fleetLedgers([setup], (entry) => vm.flownLegs(entry, stage)).get(5)
    const row = vm.fleetRunOf(setup, endpoints, stage, ledger)

    return { row, stage, ledger, km: route.km, printed: row.ledgerView.stops.map((stop) => ({ key: stop.key, figures: stop.parts.flatMap((part) => part.figures.map((figure) => `${figure.label}: ${figure.text}`)) })) }
  }
}

const motionChecks = {
  id: 'motion',
  name: 'a refuelling whose hours are not known while the endpoints of the route move: the bodies move on while the stops last, so the flown distances and every figure that rests on them (fuel a trip, the litres at the destination, the litres a run needs, the return, the limiting ship, the verdict) are not known, never the figures of a refuelling of no time, which the completions of the unknown contradict; the same stops over held endpoints, and stops whose hours are known, keep their figures',
  run: async (ctx) => {
    const motion = await motionOf(ctx)
    const unknown = motion({ moving: 1, systems: null })
    const slow = motion({ moving: 1, systems: 0 })
    const fast = motion({ moving: 1, systems: 1 })
    const held = motion({ moving: 0, systems: null })
    const needed = motion({ moving: 1, systems: null, required: true })

    const flightOf = (run) => run.row.cycleRows.find((cycleRow) => cycleRow.key === 'flight').text
    const tripFuelOf = (run) => run.row.participantRows.filter((participant) => participant.role === 'independent').map((participant) => [participant.perTrip, participant.share])

    // The completions of the unknown transfer systems differ in what the page would print, which is why the figures are not known.
    assert.equal(slow.row.fuel !== fast.row.fuel && slow.row.returnShare !== fast.row.returnShare && flightOf(slow) !== flightOf(fast) && tripFuelOf(slow)[0][0] !== tripFuelOf(fast)[0][0], true, 'the completions of the transfer systems differ in the fuel a trip, the return, the flying time and the fuel of a ship')

    // Known hours: the flown distances and figures stand.
    for (const known of [slow, fast]) {
      assert.deepEqual([known.stage.moved, known.stage.clockUnknown, known.row.status, known.ledger.legs.filter((leg) => Number.isFinite(leg.km)).length], [true, false, 'ok', 2], 'known hours: the flown distances are the ledger\'s legs and the run can run')
      assert.equal(Number.isFinite(known.row.fuel) && Number.isFinite(known.row.returnShare), true, 'known hours: the fuel a trip and the return are figures')
      assert.deepEqual([flightOf(known) !== 'Not known', tripFuelOf(known).every(([perTrip, share]) => Number.isFinite(perTrip) && Number.isFinite(share))], [true, true], 'known hours: the flying time and the fuel of each ship are figures')
    }

    // The fill target of the switch reaches the ledgers: with the hours known, the run takes the litres it needs with the switch on and a full tank with it off.
    const receivedOf = (run) => run.ledger.stops.map((stop) => stop.receivedTotal)
    const takingNeeded = motion({ moving: 1, systems: 1, required: true })

    assert.deepEqual([receivedOf(takingNeeded).length, receivedOf(takingNeeded)[0] < receivedOf(fast)[0], receivedOf(takingNeeded).some((litres, index) => litres !== receivedOf(fast)[index])], [receivedOf(fast).length, true, true], `the fill target the run needs reaches the ledgers: the first stop gives less than a full tank and the stops differ from those of the full tank (${receivedOf(takingNeeded)} against ${receivedOf(fast)})`)

    // Hours not known: nothing that rests on the flown distances.
    assert.deepEqual([unknown.stage.moved, unknown.stage.clockUnknown, unknown.row.status], [true, true, 'unknown'], 'hours not known beside moving endpoints: the flown distances are not known and the verdict is not')
    assert.equal(unknown.ledger.legs.filter((leg) => Number.isFinite(leg.km)).length, 0, 'hours not known: no leg has a length')
    assert.deepEqual([unknown.row.fuel, unknown.row.fuelShare, unknown.row.returnShare, unknown.row.ledgerView.limiting], [null, null, null, ''], 'hours not known: no fuel a trip, share, return or limiting ship')
    assert.equal(unknown.printed.some((stop) => stop.key === 'destination'), false, 'hours not known: no litres at the destination are printed')
    assert.deepEqual([flightOf(unknown), tripFuelOf(unknown).every(([perTrip, share]) => perTrip === null && share === null)], ['Not known', true], 'hours not known: no flying time and no fuel of a ship for the trip')
    assert.deepEqual([needed.row.status, needed.printed.flatMap((stop) => stop.figures).filter((text) => /^(Stock now|Eligible surplus now|Available to the fleet at entry|Received by the fleet):/.test(text) && !text.endsWith(': Not known'))], ['unknown', []], 'hours not known, the fill target the run needs: the verdict is not known, and the run reads not known from its first stop, so no stock, surplus or receipt is printed as a figure')

    // Held endpoints: the hours move nothing, so the distances stand, but the run is not known from its first doubted stop, so nothing of the whole run is.
    assert.deepEqual([held.stage.moved, held.stage.clockUnknown, held.row.status, held.ledger.legs.map((leg) => leg.km)], [false, false, 'unknown', [held.km, held.km]], 'held endpoints: the hours that are not known leave the distances, and the tanker not decided leaves the verdict not known')
    assert.deepEqual([held.row.fuel, held.row.returnShare], [null, null], 'held endpoints: the run is not known from the stop with the tanker not decided, so the fuel a trip and the return of the fleet are not known')
    assert.deepEqual([flightOf(held), tripFuelOf(held).every(([perTrip, share]) => perTrip === null && share === null), held.row.cycleRows.filter((cycleRow) => ['wait', 'total', 'year'].includes(cycleRow.key)).map((cycleRow) => cycleRow.text)], ['Not known', true, ['Not known', 'Not known', 'Not known']], 'held endpoints: the run is not known from the stop with the tanker not decided, so no flying time, no fuel of a ship for the trip and no total are figures')
    assert.deepEqual([flightOf(needed), tripFuelOf(needed).every(([perTrip, share]) => perTrip === null && share === null), needed.stage.clockUnknown, needed.ledger.legs.filter((leg) => Number.isFinite(leg.km)).length], ['Not known', true, true, 0], 'hours not known, the fill target the run needs: no flying time, no fuel of a ship for the trip and no leg length')

    // Only the closing fill has hours that are not known (the second ship's class priority is not in the save): the first cycle's flights do not depend on it, but the year's mean distance does, so the flown distances are not known either.
    for (const required of [false, true]) {
      for (const priority of [null, 0, 10]) {
        const only = motion({ moving: 1, systems: 1, required, closing: { priority } })
        const settled = priority !== null

        assert.deepEqual([only.stage.moved, only.stage.clockUnknown, only.row.status, flightOf(only) !== 'Not known', tripFuelOf(only).every(([perTrip, share]) => Number.isFinite(perTrip) && Number.isFinite(share)), tripFuelOf(only).every(([perTrip, share]) => perTrip === null && share === null)], [true, !settled, settled ? 'ok' : 'unknown', settled, settled, !settled], `only the closing fill's hours ${settled ? 'known' : 'not known'}, the fill target ${required ? 'the run needs' : 'the full tank'}: the moved flights, the verdict, the flying time and the fuel of each ship`)
      }
    }
  },
}

// A fleet of one ship, drawn from a colony 1 at its first stop.
const oneShip = (ctx, name, id, shipId, fuel, km, cycle = false) => fleetOf(ctx, name, id, [hauler(shipId, fuel)], cycle ? [km, km] : [km], cycle ? [at(1, 'Origin'), at(null, 'Far'), at(1, 'Origin')] : [at(1, 'Origin'), at(null, 'Far')], cycle)

const statusesOf = (result) => result.ledgers.map((ledger) => [ledger.ships[0].name, ledger.status])

const nettingChecks = {
  id: 'netting',
  name: 'fleets that draw on one stock one after another: the fleet ahead is served, the next takes what is left and runs short, the third finds the stock taken by the fleets ahead (not empty), the order picked is the order drawn, and the stock after the last is the stock less what all received',
  run: (ctx) => {
    const sites = sitesOf([colonyRow(1, { FuelStockpile: 90 })])
    const a = oneShip(ctx, 'Alpha', 5, 11, 40, KM * 8)
    const b = oneShip(ctx, 'Bravo', 6, 21, 40, KM * 8)
    const c = oneShip(ctx, 'Charlie', 7, 31, 40, KM * 8)
    const net = (fleets, options = {}) => ctx.mod.netLedgers(fleets, { sites, reserves: READ, version: VERSION, ...options })
    const ab = net([a, b])

    assert.deepEqual(statusesOf(ab), [['Ship 11', 'ok'], ['Ship 21', 'range']], 'Alpha is served and Bravo runs short')
    assert.deepEqual([ab.ledgers[0].stops[0].receivedTotal, ab.ledgers[1].stops[0].receivedTotal], [60, 30], 'Alpha receives its deficit and Bravo the 30 left')
    assert.deepEqual(firstService(ab.ledgers[1]).takenAhead, [{ fleet: 'Alpha', litres: 60 }], 'the draw ahead names Alpha and what it took')
    assert.equal(firstService(ab.ledgers[1]).residual, 0, 'nothing is left after Bravo')
    assert.equal(ab.stocks.get('colony:1'), 0, 'the stock after the last fleet is the stock less what both received')
    assert.deepEqual(ab.ledgers.map((ledger) => ledger.draw), [{ position: 1, of: 2, ahead: [] }, { position: 2, of: 2, ahead: ['Alpha'] }], 'the draw positions')

    const ba = net([b, a])

    assert.deepEqual(statusesOf(ba), [['Ship 21', 'ok'], ['Ship 11', 'range']], 'the order turned about turns the verdicts about')
    assert.equal(ba.stocks.get('colony:1'), 0, 'the stock after the last fleet under the other order')

    const plenty = ctx.mod.netLedgers([a, b], { sites: sitesOf([colonyRow(1, { FuelStockpile: 200 })]), reserves: READ, version: VERSION })

    assert.deepEqual(statusesOf(plenty), [['Ship 11', 'ok'], ['Ship 21', 'ok']], 'a stock for both serves both')
    assert.equal(plenty.stocks.get('colony:1'), 80, 'the stock after both is 200 less 120')

    const abc = net([a, b, c])
    const third = abc.ledgers[2]

    assert.equal(third.stops[0].receivedTotal, 0, 'the third fleet receives nothing')
    assert.deepEqual({ permission: third.rejected[0].permission, reason: third.rejected[0].reason, ahead: third.rejected[0].ahead.map((item) => item.fleet) }, { permission: 'blocked', reason: 'taken-ahead', ahead: ['Alpha', 'Bravo'] }, 'the stock is taken by the two fleets ahead, which is not the stock being empty')
    assert.equal(third.draw.of, 3, 'the draw is of three fleets')

    const required = ctx.mod.netLedgers([oneShip(ctx, 'Alpha', 5, 11, 40, KM * 6.4), oneShip(ctx, 'Bravo', 6, 21, 40, KM * 6.4)], { sites: sitesOf([colonyRow(1, { FuelStockpile: 40 })]), reserves: READ, version: VERSION, target: 'required' })

    assert.deepEqual(required.ledgers.map((ledger) => ledger.stops[0].receivedTotal), [24, 16], 'with the switch on the first fleet takes the 24 L its run needs, and the second the 16 L left')
    assert.deepEqual(statusesOf(required), [['Ship 11', 'ok'], ['Ship 21', 'range']], 'the second fleet is short')
  },
}

const nettingUnknownChecks = {
  id: 'netting-unknown',
  name: 'a fleet ahead whose draw is not known leaves the stock not known for the fleet behind, which is unknown with the reason named, and leaves a stock of another colony as it is',
  run: (ctx) => {
    const sites = sitesOf([colonyRow(1, { FuelStockpile: 90 }), colonyRow(2, { FuelStockpile: 90 })])
    const a = fleetOf(ctx, 'Alpha', 5, [hauler(11, null)], [KM], [at(1, 'Origin'), at(null, 'Far')])
    const b = fleetOf(ctx, 'Bravo', 6, [hauler(21, 5)], [KM], [at(1, 'Origin'), at(null, 'Far')])
    const c = fleetOf(ctx, 'Charlie', 7, [hauler(31, 40)], [KM], [at(2, 'Other'), at(null, 'Far')])
    const net = ctx.mod.netLedgers([a, b, c], { sites, reserves: READ, version: VERSION })
    const [first, second, third] = net.ledgers

    assert.deepEqual([...first.stocksAfter.keys()], ['colony:1'], 'the fleet ahead taints the one stock it may draw on')
    assert.equal(first.stocksAfter.get('colony:1'), null, 'and carries it as not known')
    assert.equal(second.status, 'unknown', 'the fleet behind is unknown, not range')
    assert.deepEqual({ reason: second.rejected[0].reason, ahead: second.rejected[0].unknownAhead }, { reason: 'draw-ahead-unknown', ahead: ['Alpha'] }, 'the reason names the fleet ahead')
    assert.equal(second.stops[0].receivedTotal, null, 'no receipt is counted, it is not known')
    assert.equal(second.missing.some((text) => text.includes('Alpha')), true, 'the missing input names the fleet')
    assert.equal(third.status, 'ok', 'a fleet on another colony is not affected')
    assert.equal(third.stops[0].receivedTotal, 60, 'and is served')
  },
}

const nettingCycleChecks = {
  id: 'netting-cycle',
  name: 'fleets that leave and return to one colony: the fleet ahead draws its closing fill before the fleet behind draws its first (the order of the snapshot, not of time), the assumption is stated, and the order turned about turns the verdicts about',
  run: (ctx) => {
    const sites = sitesOf([colonyRow(1, { FuelStockpile: 120 })])
    const a = oneShip(ctx, 'Alpha', 5, 11, 40, KM * 3, true)
    const b = oneShip(ctx, 'Bravo', 6, 21, 40, KM * 3, true)
    const net = (fleets) => ctx.mod.netLedgers(fleets, { sites, reserves: READ, version: VERSION })
    const ab = net([a, b])

    assert.deepEqual(statusesOf(ab), [['Ship 11', 'ok'], ['Ship 21', 'range']], 'Alpha has both fills, Bravo finds nothing at its departure')
    assert.deepEqual([ab.ledgers[0].stops[0].receivedTotal, ab.ledgers[0].stops[2].receivedTotal], [60, 60], 'Alpha draws 60 L at its departure and 60 L at its closing visit')
    assert.deepEqual({ reason: ab.ledgers[1].rejected[0].reason, ahead: ab.ledgers[1].rejected[0].ahead.map((item) => item.fleet) }, { reason: 'taken-ahead', ahead: ['Alpha'] }, 'Bravo\'s departure is taken by Alpha')
    assert.equal(ab.ledgers[1].assumptions.some((text) => text.includes('not the order in time')), true, 'the assumption is stated')

    const ba = net([b, a])

    assert.deepEqual(statusesOf(ba), [['Ship 21', 'ok'], ['Ship 11', 'range']], 'the mirror order gives Bravo both fills')
  },
}

// The tanker stop's verdict for each gate `tankerService` applies by the state of the input of that gate, for one tanker and for a known tanker beside one whose fuel or rate is not in the save (the table of the evidence's section 6). The rule: a known failure wins; any input of the service that is not in the save, and any tanker that cannot be decided, leaves the service not known, with the receipt not counted. K holds 60 L above its minimum, K15 is the same of a class of 15,000 L/h, U has no fuel in the save, B has no transfer system.
const K = () => tanker(501, { Fuel: 100060 })
const U15 = () => U({ RefuellingRate: 15000 })
const K15 = () => tanker(501, { Fuel: 100060, RefuellingRate: 15000 })
const U = (changes = {}) => tanker(502, { Fuel: null, ...changes })
const B = () => tanker(503, { TransferSystems: 0 })
const HELD = { ship: () => 100060, colony: () => null }

// A recipient of the tanker stop: the id, the size in hull spaces (null when not in the save) and the litres wanted.
const R = (id, size, want = 60) => ({ id, name: `Recipient ${id}`, ship: { RefuelPriority: 5, ClassRefuelPriority: 5 }, fuel: 0, capacity: 100, size, want })
const NOW_NOT_KNOWN_FOR = (key) => (id, saved) => (id === key ? null : saved)
const NOW_OF = (key, litres) => (id, saved) => (id === key ? litres : saved)

const GATE_ROWS = [
  { row: 'moved, known fail', ships: [K()], fleet: { LastMoveTime: GAME_TIME }, expect: ['blocked', 'moved', 'moved-this-pulse'], fill: [0] },
  { row: 'moved, known fail beside an undecided tanker: the fail is known whatever its fuel is', ships: [K(), U()], fleet: { LastMoveTime: GAME_TIME }, expect: ['blocked', 'moved', 'moved-this-pulse'] },
  { row: 'moved, known fail with no tanker decided', ships: [U()], fleet: { LastMoveTime: GAME_TIME }, expect: ['blocked', 'moved', 'moved-this-pulse'] },
  { row: 'moved, not in the save', ships: [K()], fleet: { LastMoveTime: null }, expect: ['unknown', 'moved', 'moved-unknown'], fill: [0] },
  { row: 'moved, not in the save beside an undecided tanker', ships: [K(), U()], fleet: { LastMoveTime: null }, expect: ['unknown', 'moved', 'moved-unknown'] },
  { row: 'stationary, known fail', ships: [K()], fleet: { FirstOrderStationary: 0 }, expect: ['blocked', 'stationary', 'first-order-not-stationary'] },
  { row: 'stationary, known fail beside an undecided tanker', ships: [K(), U()], fleet: { FirstOrderStationary: 0 }, expect: ['blocked', 'stationary', 'first-order-not-stationary'] },
  { row: 'stationary, not in the save', ships: [K()], fleet: { FirstOrderStationary: null }, expect: ['unknown', 'stationary', 'orders-unknown'] },
  { row: 'stationary, not in the save beside an undecided tanker', ships: [K(), U()], fleet: { FirstOrderStationary: null }, expect: ['unknown', 'stationary', 'orders-unknown'] },
  { row: 'a known fail of the fleet wins over an input not in the save of another gate', ships: [K()], fleet: { LastMoveTime: null, FirstOrderStationary: 0 }, expect: ['blocked', 'stationary', 'first-order-not-stationary'] },
  { row: 'donors, a known tanker beside a blocked one: known pass', ships: [K(), B()], expect: ['allowed', null, null], fill: [60] },
  { row: 'donors, a known tanker beside an undecided one: not known whatever the want is, and nothing is counted as received', ships: [K(), U()], expect: ['unknown', 'donors', 'donors-partial'], fill: [0] },
  { row: 'donors, every tanker blocked: known fail', ships: [B()], expect: ['blocked', 'donors', 'no-eligible-tanker'] },
  { row: 'donors, every decided tanker blocked beside an undecided one: it could be a donor', ships: [B(), U()], expect: ['unknown', 'donors', 'donors-unknown'] },
  { row: 'donors, the only tanker not decided: not in the save, whatever the recipient is', ships: [U15()], size: 39.757, expect: ['unknown', 'donors', 'donors-unknown'] },
  { row: 'reserve, the player\'s reserve holds all the surplus: known fail', ships: [K()], options: { reserves: HELD }, expect: ['blocked', 'reserve', 'held-by-reserve'] },
  { row: 'reserve, known fail beside an undecided tanker: not known, its surplus could cure it', ships: [K(), U()], options: { reserves: HELD }, expect: ['unknown', 'donors', 'donors-partial'] },
  { row: 'reserve, the records are not read: the surplus is not known', ships: [K()], options: { reserveRead: false }, expect: ['unknown', 'reserve', 'reserve-unread'] },
  { row: 'draw, the fleets ahead took the surplus from the stock entering the plan: known fail', ships: [K()], options: { nowSurplus: () => 0 }, expect: ['blocked', 'draw', 'drawn-earlier'] },
  { row: 'draw, the surplus was gone entering the plan: known fail', ships: [K()], options: { entrySurplus: () => 0, nowSurplus: () => 0 }, expect: ['blocked', 'draw', 'taken-ahead'] },
  { row: 'draw, known fail beside an undecided tanker: not known', ships: [K(), U()], options: { nowSurplus: () => 0 }, expect: ['unknown', 'donors', 'donors-partial'] },
  { row: 'draw, what the fleets ahead drew is not known', ships: [K()], options: { nowSurplus: () => null }, expect: ['unknown', 'draw', 'draw-ahead-unknown'], fill: [0] },
  { row: 'recipient rate, a class of 450,000 L/h serves a recipient of any size: known pass', ships: [K()], size: 39.757, expect: ['allowed', null, null], fill: [60] },
  { row: 'recipient size, 20 HS is served by a class of 15,000 L/h: known pass', ships: [K15()], size: 20, expect: ['allowed', null, null], fill: [60] },
  { row: 'recipient size, over 20 HS for a class of 15,000 L/h: known fail', ships: [K15()], size: 39.757, expect: ['blocked', 'recipient', 'recipient-too-large'] },
  { row: 'recipient size, known fail beside an undecided tanker of the same class: not known', ships: [K15(), U15()], size: 39.757, expect: ['unknown', 'donors', 'donors-partial'] },
  { row: 'recipient size, not in the save for a class of 15,000 L/h', ships: [K15()], size: null, expect: ['unknown', 'recipient', 'recipient-unknown'] },
  { row: 'recipient size, not in the save for a class of 450,000 L/h: the size does not matter', ships: [K()], size: null, expect: ['allowed', null, null], fill: [60] },
  { row: 'a known fail of the recipient wins over a fleet input not in the save', ships: [K15()], size: 39.757, fleet: { LastMoveTime: null }, expect: ['blocked', 'recipient', 'recipient-too-large'] },
  { row: 'draw, the stock of a tanker that cannot serve the recipient is not known, the compatible one is empty: its stock decides nothing, the stop is blocked', ships: [K(), tanker(502, { Fuel: 100060, RefuellingRate: 15000 })], size: 39.757, options: { nowSurplus: NOW_OF('tanker:501', 0) }, expect: ['blocked', 'draw', 'drawn-earlier'] },
  { row: 'draw, the stock of a tanker that cannot serve the recipient is not known, the compatible one has the litres: the stock decides nothing, the stop serves in full', ships: [K(), tanker(502, { Fuel: 100060, RefuellingRate: 15000 })], size: 39.757, options: { nowSurplus: NOW_NOT_KNOWN_FOR('tanker:502') }, expect: ['allowed', null, null], fill: [60] },
  { row: 'draw, the stock of the one tanker that can serve the recipient is not known: not known', ships: [K(), tanker(502, { Fuel: 100060, RefuellingRate: 15000 })], size: 39.757, options: { nowSurplus: NOW_NOT_KNOWN_FOR('tanker:501') }, expect: ['unknown', 'draw', 'draw-ahead-unknown'] },
  { row: 'draw, the fleets ahead took the surplus of the only tanker, which cannot serve the recipient (15,000 L/h, 39.757 HS): the recipient is what blocks the stop, not the stock', ships: [K15()], size: 39.757, options: { nowSurplus: () => 0 }, expect: ['blocked', 'recipient', 'recipient-too-large'] },
  { row: 'required, the litres a recipient wants are not known: not known whatever the tankers hold', ships: [K()], recipients: [R(1, 20, null)], expect: ['unknown', 'inputs', 'required-unknown'], fill: [0] },
  { row: 'order, two tankers with surplus, the tank of one not in the save: the order that gives the litres is not known', ships: [K(), tanker(502, { Fuel: 100060, FuelCapacity: null })], expect: ['unknown', 'inputs', 'order-unknown'], fill: [0] },
  { row: 'order, two tankers with surplus and both tanks in the save: the order is known', ships: [K(), tanker(502, { Fuel: 100060 })], expect: ['allowed', null, null], fill: [60] },
  { row: 'order, a tanker whose tank is not in the save but whose litres were drawn ahead: it gives nothing now, so the order is known', ships: [K(), tanker(502, { Fuel: 100060, FuelCapacity: null })], options: { nowSurplus: NOW_OF('tanker:502', 0) }, expect: ['allowed', null, null], fill: [60] },
  { row: 'order, a single donor whose tank is not in the save: there is no order to know', ships: [tanker(502, { Fuel: 100060, FuelCapacity: null })], expect: ['allowed', null, null], fill: [60] },
  { row: 'order, a stocked tanker that cannot serve the recipient (15,000 L/h, 39.757 HS) with its tank not in the save beside the donor that gives it all: it is skipped whatever its place, so the order is known', ships: [K(), tanker(502, { Fuel: 100060, RefuellingRate: 15000, FuelCapacity: null })], size: 39.757, expect: ['allowed', null, null], fill: [60] },
  { row: 'order, eight stocked tankers of which seven cannot serve the recipient (15,000 L/h, 39.757 HS) and have no tank in the save: they are skipped whatever their place', ships: [K(), ...Array.from({ length: 7 }, (_, index) => tanker(510 + index, { Fuel: 100060, RefuellingRate: 15000, FuelCapacity: null }))], size: 39.757, expect: ['allowed', null, null], fill: [60] },
  { row: 'fill, a recipient of a size not in the save that follows a recipient of 20 HS beside a tanker of 15,000 L/h: the size decides whether it gets the litres left, so the service is not known', ships: [K15()], recipients: [R(1, 20, 30), R(2, null)], expect: ['unknown', 'inputs', 'recipient-unknown'] },
  { row: 'fill, the same with a tanker of 450,000 L/h, which serves the recipient whatever its size', ships: [K()], recipients: [R(1, 20), R(2, null)], expect: ['allowed', null, null], fill: [60] },
  { row: 'priority, two recipients each wanting the 60 L one tanker holds, the priority of the second not in the save: it could come first, so the service is not known', ships: [K()], recipients: [R(1, 20, 60), { ...R(2, 20, 60), ship: { RefuelPriority: null, ClassRefuelPriority: 5 } }], expect: ['unknown', 'inputs', 'priority-unknown'], fill: [0] },
  { row: 'priority, the class priority of the second not in the save: it could come first, so the service is not known', ships: [K()], recipients: [R(1, 20, 60), { ...R(2, 20, 60), ship: { RefuelPriority: 5, ClassRefuelPriority: null } }], expect: ['unknown', 'inputs', 'priority-unknown'] },
  { row: 'priority, the priority of the only recipient wanting litres not in the save: no other recipient wants, so the order is known', ships: [K()], recipients: [R(1, 20, 60), { ...R(2, 20, 0), ship: { RefuelPriority: null, ClassRefuelPriority: null } }], expect: ['allowed', null, null], fill: [60] },
  { row: 'priority, the priority of the single recipient not in the save: there is no order to know', ships: [K()], recipients: [{ ...R(1, 20, 60), ship: { RefuelPriority: null, ClassRefuelPriority: null } }], expect: ['allowed', null, null], fill: [60] },
]

const tankerGateChecks = {
  id: 'tanker-gates',
  name: 'every gate of a stationary tanker stop by the state of its input (known pass, known fail, not in the save), for one tanker and for a known tanker beside one not decided: a known failure wins, and an input that is not in the save, or a tanker that cannot be decided, leaves the service not known with no litre counted as received',
  run: (ctx) => {
    const wrong = GATE_ROWS.map((entry) => {
      const service = ctx.mod.tankerService(depotFleet(entry.ships, entry.fleet || {}), entry.recipients || [R(1, entry.size === undefined ? 20 : entry.size)], { gameTime: GAME_TIME, reserves: READ, version: VERSION, ...(entry.options || {}) })
      const got = [service.permission, service.gate, service.reason, ...(entry.fill ? [service.received] : [])]
      const want = [...entry.expect, ...(entry.fill || [])]

      return got.join() === want.join() ? null : [entry.row, got, want]
    }).filter(Boolean)

    assert.deepEqual(wrong, [], `${wrong.length} of ${GATE_ROWS.length} rows read another verdict: ${wrong.map((item) => `${item[0]} got ${item[1]}`).join('; ')}`)
  },
}

// The page's own view of a ledger (`ledgerViewOf` over `servicePartOf`), taken from the source of the page, for the figures that the ledger leaves unknown to be read as the page prints them.
const viewOfPage = async (ctx) => {
  const loaded = await loadUtilities(['math'])
  const { page } = ctx
  const constantText = page.slice(page.indexOf('const stopOf ='), page.indexOf('\n', page.indexOf('const capitalised =')))
  // eslint-disable-next-line no-new-func
  const constants = new Function('serviceSeconds', `${constantText}\nreturn { stopOf, sumOf, serviceOf, capitalised }`)(ctx.mod.serviceSeconds)
  const dependency = { ...ctx.fp, ...ctx.mod, ...constants }
  const keys = Object.keys(dependency).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default')
  // eslint-disable-next-line no-new-func
  const methods = new Function(...keys, `return { ${['ledgerViewOf', 'servicePartOf'].map((name) => methodText(page, name)).join('\n')} }`)(...keys.map((key) => dependency[key]))
  const format = fs.readFileSync(path.join(root, 'src/renderer/mixins/count-format.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  const counts = new Function('countText', 'isKnownNumber', `return { ${format.slice(format.indexOf('    count(value,'), format.lastIndexOf('\n  },'))} }`)(loaded.math.countText, loaded.math.isKnownNumber)
  const vm = { ...methods, ...counts, separator: '\'' }

  return (ledger) => vm.ledgerViewOf(ledger)
}

const FAR = { name: 'Far', PopulationID: null, SystemID: 2, Xcor: 5, Ycor: 5 }

// What a stop prints at one source: the figures by their labels, the head and the tanker lines.
const printedPart = (view, stopKey) => {
  const part = view.stops.find((stop) => stop.key === stopKey).parts[0]

  return { head: `${part.kind}, ${part.source}: ${part.verdict}`, figures: Object.fromEntries(part.figures.map((item) => [item.label, item.text])), tankers: part.tankers.map((line) => line.text) }
}

const unreadChecks = {
  id: 'unread-reserve',
  name: 'a reserve that is not read leaves the litres a run needs not known, never 0 and never the litres of a reserve of none: the level a ship keeps is the larger of its reserve and its minimum, so a ship that needs more than its tank holds needs the whole tank whatever the reserve is, and a tank that is full needs nothing',
  run: async (ctx) => {
    const viewOf = await viewOfPage(ctx)
    const sites = sitesOf([colonyRow(1), colonyRow(2)])
    const read = { ship: () => 60, colony: () => 0 }
    const runOf = (changes, reserves, target, legs = [KM, KM]) => ledgerOf(ctx, { ships: [hauler(1, 50, changes)], legs, stops: [at(1, 'A'), at(null, 'B'), at(null, 'C')], sites, reserves, target })
    const needOf = (ledger, stop = 0) => ledger.required.find((entry) => entry.stop === stop).litres
    const rows = [[{ Fuel: 50 }, 30], [{ Fuel: 30 }, 50], [{ Fuel: 50, FuelTanker: 0 }, 30]]

    ;['required', 'full'].forEach((target) => {
      rows.forEach(([changes, litresWanted]) => {
        assert.equal(needOf(runOf(changes, read, target)), litresWanted, `with the reserve read (60 L) the ship ${JSON.stringify(changes)} needs ${litresWanted} L at the first stop, target ${target}`)

        const unread = runOf(changes, null, target)

        assert.deepEqual([unread.status, needOf(unread), needOf(unread, 1)], ['unknown', null, null], `with the reserve not read the ship ${JSON.stringify(changes)} needs a number of litres that is not known, not 0 and not ${litresWanted} L, target ${target}`)
        assert.equal(viewOf(unread).stops[0].needs[0].text, 'Not known', `the page prints the litres a ship needs as not known, target ${target}`)
      })
      assert.equal(viewOf(runOf({ Fuel: 50 }, read, target)).stops[0].needs[0].text, '30 L', `the page prints the litres a ship needs when the reserve is read, target ${target}`)
      assert.deepEqual([needOf(runOf({ Fuel: 50, FuelTanker: 1, MinimumFuel: 80 }, read, target)), needOf(runOf({ Fuel: 50, FuelTanker: 1, MinimumFuel: 80 }, null, target))], [50, null], `a tanker that keeps 80 L at least needs the whole 50 L its tank lacks with the reserve read; with it not read the first stop is doubted and the litres are not known there, target ${target}`)
      assert.deepEqual([needOf(runOf({ Fuel: 5 }, null, target, [KM * 10, KM * 10])), needOf(runOf({ Fuel: 5 }, read, target, [KM * 10, KM * 10]))], [null, 95], `two legs of 100 L ask for more than the tank holds, so the ship needs the tank less what it has (95 L) with the reserve read and not known with it not read, target ${target}`)
      assert.deepEqual([needOf(runOf({ Fuel: 100 }, null, target)), needOf(runOf({ Fuel: 100 }, read, target))], [null, 0], `a full tank needs nothing with the reserve read and not known with it not read, target ${target}`)
    })

    const emptyColony = (changes) => ledgerOf(ctx, { ships: [hauler(1, 50, changes)], legs: [KM], stops: [at(1, 'A'), at(null, 'B')], sites: sitesOf([colonyRow(1, { FuelStockpile: 0 })]), reserves: null, target: 'required' })
    const unreadRun = (ledger) => [ledger.status, ledger.unknownAt, needOf(ledger)]

    assert.deepEqual([unreadRun(emptyColony({ Fuel: 50 })), unreadRun(emptyColony({ Fuel: 50, FuelTanker: 1, MinimumFuel: 100 }))], [['unknown', 0, null], ['ok', null, 50]], 'where the only source at a stop is blocked for a known cause the litres a ship needs are the first doubt: not known with the reserve not read, but the whole tank a tanker that keeps 100 L needs whatever the reserve is')
  },
}

const poolChecks = {
  id: 'pool',
  name: 'a tanker whose transfer systems are not in the save, or an input the service rests on that is not, leaves the service and every figure it gives not known: the surplus of the fleet, what the fleet is given at entry and now, the receipt, the draw of the fleets ahead and the tankers that are not drawn from; a known pool, and a decided tanker, keep their figures; a run carries the doubt to the stops after it',
  run: async (ctx) => {
    const viewOf = await viewOfPage(ctx)
    const undecided = (changes = {}) => U({ Fuel: 100140, TransferSystems: null, UndamagedTransfer: null, ...changes })
    const stopOf = (...tankers) => ledgerOf(ctx, { ships: [hauler(1, 40)], stops: [DEPOT, FAR], legs: [KM * 8], sites: sitesOf([], [depotFleet(tankers)]) })
    const figuresOf = (service) => ({ received: service.received, stock: service.stock, saved: service.saved, entry: service.entry, available: service.available })
    const NUMBERS = (stock) => ({ received: 60, stock, saved: stock, entry: stock, available: stock })

    assert.deepEqual(figuresOf(firstService(stopOf(K()))), NUMBERS(60), 'a known tanker of 60 L gives the 60 L wanted from a surplus of 60 L')
    assert.deepEqual(figuresOf(firstService(stopOf(K(), undecided()))), { received: null, stock: null, saved: null, entry: null, available: null }, 'beside a tanker not decided the receipt, the surplus of the fleet and the pool it is given are not known')

    const blockedFigures = (ships, recipients) => ctx.mod.tankerService(depotFleet(ships, { LastMoveTime: GAME_TIME }), recipients, { gameTime: GAME_TIME, reserves: READ, version: VERSION })
    const beside = blockedFigures([K(), undecided()], [R(1, 20, 60)])
    const sizeless = blockedFigures([K15()], [R(1, null, 60)])

    assert.deepEqual([beside.permission, beside.stock, beside.saved, beside.entry, sizeless.permission, sizeless.stock, sizeless.entry], ['blocked', null, null, null, 'blocked', 60, null], 'a service blocked for a known cause beside a tanker not decided, or for a recipient whose size is not in the save, still prints the surplus and the pool as not known where they are not')
    assert.deepEqual(figuresOf(firstService(stopOf(K(), undecided({ TransferSystems: 1, UndamagedTransfer: 1 })))), NUMBERS(200), 'a tanker that serves makes the surplus 200 L, not the 100 L of the known tanker alone')
    assert.deepEqual(figuresOf(firstService(stopOf(K(), undecided({ TransferSystems: 0 })))), NUMBERS(60), 'a tanker that has no system leaves the 60 L')

    const unread = printedPart(viewOf(stopOf(K(), undecided())), 'origin')
    const readOf = printedPart(viewOf(stopOf(K())), 'origin')

    assert.deepEqual([unread.figures['Eligible surplus now'], unread.figures['Available to the fleet at entry'], unread.figures['Received by the fleet']], ['Not known', 'Not known', undefined], 'the page prints the surplus and the pool as not known and no receipt')
    assert.deepEqual([readOf.figures['Eligible surplus now'], readOf.figures['Available to the fleet at entry']], ['60 L', '60 L'], 'the page prints them when no tanker is undecided')

    const behind = (tankers, taken) => ctx.mod.tankerService(depotFleet(tankers), [R(1, 20, 60)], { gameTime: GAME_TIME, reserves: READ, version: VERSION, ahead: { taken: new Map([['tanker:502', taken]]), unknown: new Map() } }).takenAhead

    assert.deepEqual(behind([K(), undecided()], [{ fleet: 'Alpha', litres: null }]), [{ fleet: 'Alpha', litres: null }], 'a fleet ahead that may have drawn from the tanker not decided is listed with a draw that is not known, not as none')

    const alpha = fleetOf(ctx, 'Alpha', 5, [hauler(11, 40)], [KM * 8], [DEPOT, FAR])
    const bravo = fleetOf(ctx, 'Bravo', 6, [hauler(21, 15, { Size: 40 })], [KM * 8], [DEPOT, FAR])
    const smallFirst = ctx.mod.netLedgers([alpha, bravo], { sites: sitesOf([], [depotFleet([tanker(502, { Fuel: 100060, RefuellingRate: 15000, TransferSystems: null })])]), reserves: READ, version: VERSION })

    assert.deepEqual([smallFirst.ledgers[1].status, firstService(smallFirst.ledgers[1]).takenAhead], ['unknown', [{ fleet: 'Alpha', litres: null }]], 'a ship of 20 HS ahead may have drawn the 60 L of a tanker of 15,000 L/h whose transfer systems are not in the save, so the fleet behind, for which that tanker is the only one, is not known and the draw ahead is listed with litres not known, not as none')
    assert.equal(printedPart(viewOf(smallFirst.ledgers[1]), 'origin').figures['Taken by the fleets ahead'], 'Alpha Not known', 'the page prints that draw as not known')
    assert.deepEqual([firstService(smallFirst.ledgers[1]).entry, firstService(smallFirst.ledgers[1]).available, printedPart(viewOf(smallFirst.ledgers[1]), 'origin').figures['Available to the fleet at entry']], [null, null, 'Not known'], 'the pool the fleet behind is given is not known either: with no tanker known the tanker not decided, whichever recipient it serves, is the whole pool')

    const sizedShip = (id, size, changes = {}) => hauler(id, 40, { Size: size, EnginePower: size === null ? 20 : size, UndamagedEnginePower: size === null ? 20 : size, FuelEfficiency: size === null ? 0.5 : 10 / size, MinimumFuel: 0, ...changes })
    const fuller = (changes = {}) => tanker(502, { Fuel: 100060, RefuellingRate: 15000, FuelCapacity: 100100, TransferSystems: null, UndamagedTransfer: null, ...changes })
    const shared = (...tankers) => ctx.mod.netLedgers([fleetOf(ctx, 'Alpha', 5, [sizedShip(11, 20), sizedShip(12, 40)], [KM * 8], [DEPOT, FAR])], { sites: sitesOf([], [depotFleet(tankers)]), reserves: READ, version: VERSION }).ledgers[0]
    const receivedOf = (ledger) => [firstService(ledger).received, firstService(ledger).reason]

    assert.deepEqual(receivedOf(shared(K(), fuller())), [null, 'donors-partial'], 'a tanker of 15,000 L/h with the same litres and transfer systems not in the save leaves the service not known: the receipt is neither the 60 L of the known tanker alone nor the 120 L with it')
    assert.deepEqual(receivedOf(shared(K(), fuller({ TransferSystems: 1, UndamagedTransfer: 1 }))), [120, null], 'a tanker that serves makes the receipt 120 L')
    assert.deepEqual(receivedOf(shared(K(), fuller({ TransferSystems: 0 }))), [60, null], 'a tanker that has no system leaves the 60 L')

    const unreadPool = ledgerOf(ctx, { ships: [hauler(1, 40, { Size: 40 })], stops: [DEPOT, FAR], legs: [KM * 8], sites: sitesOf([], [depotFleet([K15()])]), reserves: null })
    const unreadOrigin = printedPart(viewOf(unreadPool), 'origin')

    assert.deepEqual([firstService(unreadPool).stock, firstService(unreadPool).entry, firstService(unreadPool).available], [null, null, null], 'with the reserves not read the surplus that the only tanker, which cannot serve a ship of 40 HS, would add to the pool is not known, not 0 L')
    assert.deepEqual([unreadOrigin.figures['Eligible surplus now'], unreadOrigin.figures['Available to the fleet at entry']], ['Not known', 'Not known'], 'the page prints them as not known')

    const carriedOf = (size) => fleetOf(ctx, 'Alpha', 5, [sizedShip(11, 40), sizedShip(12, size, { MothershipID: 11, CarrierMothershipID: 0, CarrierFleetID: 5, CargoCapacity: 0, ColonistCapacity: 0 })], [KM * 8], [DEPOT, FAR])
    const bravoOf = () => fleetOf(ctx, 'Bravo', 6, [sizedShip(21, 40, { FleetID: 6 })], [KM * 8], [DEPOT, FAR])
    const membership = (size, ahead) => ctx.mod.netLedgers(ahead ? [bravoOf(), carriedOf(size)] : [carriedOf(size)], { sites: sitesOf([], [depotFleet([K(), fuller({ TransferSystems: 1, UndamagedTransfer: 1, FuelCapacity: 200000 })])]), reserves: READ, version: VERSION }).ledgers[ahead ? 1 : 0]
    const entryOf = (ledger) => printedPart(viewOf(ledger), 'origin').figures['Available to the fleet at entry']
    const headOf = (ledger) => printedPart(viewOf(ledger), 'origin').head

    assert.deepEqual([null, 20, 40].map((size) => entryOf(membership(size, false))), ['Not known', '120 L', '60 L'], 'a carried ship whose size is not in the save may or may not be served by the slow tanker, so the pool the fleet is given is 120 L or 60 L and is not known, not 120 L')
    assert.deepEqual([null, 20, 40].map((size) => firstService(membership(size, true)).permission), ['unknown', 'allowed', 'blocked'], 'after a fleet ahead that drew the fast tanker\'s 60 L, the carried ship of 20 HS is served by the slow tanker and one of 40 HS is not: the stop is not known, not allowed')
    assert.deepEqual([null, 20, 40].map((size) => entryOf(membership(size, true))), ['Not known', '60 L', '0 L'], 'and the pool the fleet is given is not known either')
    assert.equal(headOf(membership(null, true)).endsWith('Not known: The recipient\'s size is not in the save'), true, 'the heading says the stop is not known and why')

    const leftOf = (size) => ctx.mod.tankerService(depotFleet([tanker(501, { Fuel: 100160 }), tanker(502, { Fuel: 100060, RefuellingRate: 15000, FuelCapacity: 5000000 })]), [R(1, 40, 60), R(2, size, 60)], { gameTime: GAME_TIME, reserves: READ, version: VERSION })

    assert.deepEqual([null, 20, 40].map((size) => leftOf(size).residual), [null, 100, 40], 'the litres left after the fast tanker gives both recipients 60 L are 100 L if the slow tanker serves a recipient of 20 HS and 40 L if it serves none: a size that is not in the save leaves them not known')

    const slowFleet = firstService(ledgerOf(ctx, { ships: [hauler(1, 40, { Size: 40 })], stops: [DEPOT, FAR], legs: [KM * 8], sites: sitesOf([], [depotFleet([K(), tanker(502, { Fuel: 100100, RefuellingRate: 15000 })])]) }))

    assert.deepEqual([slowFleet.stock, slowFleet.entry, slowFleet.available], [160, 60, 60], 'a tanker of 15,000 L/h cannot serve a ship of 40 HS: the surplus of the fleet counts its 100 L, the pool the ship is given does not')

    const serviceOf = (fleet, recipients = [R(1, 20, 60)], options = {}) => ctx.mod.tankerService(depotFleet([K(), tanker(502, { Fuel: 100060 })], fleet), recipients, { gameTime: GAME_TIME, reserves: READ, version: VERSION, ...options })
    const knownOf = (service) => service.tankers.map((item) => [item.key, item.known, item.residual])

    assert.deepEqual(knownOf(serviceOf({})), [['tanker:501', true, 0], ['tanker:502', true, 60]], 'a fleet that serves and draws known litres knows what each tanker gives and has left')
    assert.deepEqual(knownOf(serviceOf({ LastMoveTime: GAME_TIME })).map((item) => item[1]), [true, true], 'a fleet that cannot serve draws from no tanker, which is known')
    assert.deepEqual(knownOf(serviceOf({ LastMoveTime: null })).map((item) => item[1]), [false, false], 'a fleet whose last move is not in the save may serve, so whether a tanker is drawn from is not known, not drawn from')
    assert.deepEqual(knownOf(serviceOf({ FirstOrderStationary: null })).map((item) => item[1]), [false, false], 'a first order that is not in the save is the same')

    const pair = (first, second, wants) => serviceOf({}, [{ ...R(1, 20, wants[0]), ship: { RefuelPriority: first, ClassRefuelPriority: 5 } }, { ...R(2, 20, wants[1]), ship: { RefuelPriority: second, ClassRefuelPriority: 5 } }])
    const limitOf = (service) => service.limiting && service.limiting.id

    assert.deepEqual([limitOf(pair(5, 5, [60, 60])), limitOf(pair(null, 5, [60, 60])), limitOf(pair(null, 5, [60, 30])), limitOf(pair(5, null, [30, 60]))], [1, null, null, null], 'the ship that receives most is named where every priority is in the save, and not where one is not')

    const carriedHauler = hauler(2, 40, { Size: 20, MothershipID: 1, CarrierFleetID: 5, CarrierMothershipID: 0 })
    const origin21 = ledgerOf(ctx, { ships: [hauler(1, 40, { Size: 40 }), carriedHauler], legs: [KM * 2, KM * 2], stops: [at(1, 'Origin'), DEPOT, at(1, 'Origin')], cycle: true, sites: sitesOf([colonyRow(1, { FuelStockpile: null })], [depotFleet([K(), tanker(502, { Fuel: 100060, RefuellingRate: 15000 })])]) })
    const [fromOrigin, atDepot] = origin21.stops
    const depot21 = atDepot.service.services[0]

    assert.deepEqual([fromOrigin.service.services[0].reason, depot21.permission, depot21.reason, figuresOf(depot21), depot21.tankers.map((line) => [line.known, line.residual, line.entry]), origin21.status, origin21.stocksAfter.get('tanker:501'), origin21.stocksAfter.get('tanker:502'), origin21.returnFuel], ['stock-unknown', 'unknown', 'earlier-doubt', { received: null, stock: null, saved: null, entry: null, available: null }, [[false, null, null], [false, null, null]], 'unknown', null, null, null], 'an origin stock that is not in the save leaves the stop after it not known, with a carried ship of 20 HS and a ship of 40 HS beside tankers of 450,000 and 15,000 L/h: no figure of the tankers is counted and their stocks are not known after the run')
  },
}

// The grammar of a displayed duration as `parseSpan` reads it (the table of the evidence's section 6), with the lower-bound words of the module's own table: each accepted form and each malformed one, and a reader that skips an unknown word or reads only the last end of a range, which the table must fail.
const readerChecks = {
  id: 'reader',
  name: 'the readers of the displayed figures read each whole: a duration in each unit the formatter writes (to the precision of its last unit, a range only where the role takes one, the lower bound by the module\'s table of words), a litre figure with its sign, a percentage, a count and an unread placeholder, and fail every other form: an unknown word, a word in the other place, both places, a sign, a figure with no unit, a malformed end of a range, a qualifier inside a range, a figure that only contains the wanted one',
  run: (ctx) => {
    const bound = ctx.mod.SERVICE_BOUNDS['at-least']
    const { before, after } = bound
    const rows = [
      ['33.3 d', { seconds: 33.3 * 86400, qualified: false, range: false }],
      ['20 min 43 s', { seconds: 1243, qualified: false, range: false }],
      ['5 s', { seconds: 5, qualified: false, range: false }],
      [`${before} 1 h 2 min`, { seconds: 3720, qualified: true, range: false }],
      [`1 h 2 min ${after}`, { seconds: 3720, qualified: true, range: false }],
      ['1 h to 2 h', { seconds: 7200, qualified: false, range: true }],
      ['37.3 d to 37.3 d', { seconds: 37.3 * 86400, qualified: false, range: true }],
      ['0 h to 1 h', { seconds: 3600, qualified: false, range: true }],
      ['4.1 mo', { seconds: 4.1 * (30.4 * 86400), qualified: false, range: false }],
      ['2.2 y', { seconds: 2.2 * (365 * 86400), qualified: false, range: false }],
      ['', null],
      ['nonsense', null],
      [before, null],
      ['1', null],
      ['5 weeks', null],
      ['-1 h', null],
      ['\u22121 h', null],
      ['+1 h', null],
      ['1,5 h', null],
      ['at most 1 h', null],
      ['1 h at most', null],
      [`${after} 1 h`, null],
      [`1 h ${before}`, null],
      [`${before} 1 h ${after}`, null],
      ['1 h nonsense', null],
      [`1 h ${after} 2 min`, null],
      ['to 1 h', null],
      ['nonsense 1 h to 2 h', null],
      ['1 h to 2 h nonsense', null],
      ['nonsense to 1 h', null],
      ['-1 h to 2 h', null],
      [`${before} 1 h to 2 h`, null],
      [`1 h to ${before} 2 h`, null],
      ['1 h to 2 h to 3 h', null],
      ['2 h to 1 h', null],
      ['1 h 1 min to 1 h', null],
    ]
    const readBy = (reader) => rows.filter(([text, expected]) => JSON.stringify(reader(text, bound)) !== JSON.stringify(expected)).map(([text]) => text)

    assert.deepEqual(readBy(parseSpan), [], 'the reader reads each form as the grammar says')

    const lastEndOnly = (text, words) => {
      const end = parseEnd(String(text).split(' to ').pop(), words)

      return end && { ...end, range: String(text).includes(' to ') }
    }
    const anyWord = (text, words) => {
      const end = parseEnd(text, { ...words, before: (String(text).match(/^([A-Za-z ]*?)\s*\d/) || [null, ''])[1] || words.before })

      return end && { ...end, range: false }
    }

    assert.equal(readBy(lastEndOnly).includes('nonsense to 1 h'), true, 'a reader that reads the last end of a range alone fails the table')
    assert.equal(readBy(anyWord).includes('at most 1 h'), true, 'a reader that takes any word before the figures as the qualifier fails the table')

    const servicePart = (text) => ({ head: 'Colony, Source: Can serve', values: [['stock', litres(100)], ['ahead', 'None'], ['available', litres(100)], ['received', litres(60)], ['residual', litres(40)], ['hours', text], ['limiting', 'Ship']].map(([role, value]) => ({ role, text: value, on: true })) })
    const serviceProblems = (text, lower) => partProblems('the service', servicePart(text), { stock: 100, ahead: [], entry: 100, served: true, received: 60, residual: 40, hours: 1, bound: lower ? 'at-least' : 'exact', limiting: 'Ship' }, { reasons: {}, verdicts: { allowed: 'Can serve', blocked: 'Cannot serve', unknown: 'Not known' }, bounds: { 'at-least': bound } })
    const exactRoles = [
      ['1 h', false, true],
      ['0 h to 1 h', false, false],
      ['2 h to 1 h', false, false],
      ['1 h to 1 h', false, false],
      [`${before} 1 h`, true, true],
      [`1 h ${after}`, true, true],
      [`${before} 1 h`, false, false],
      ['1 h', true, false],
      [`${before} 0 h to 1 h`, true, false],
    ]

    const wrongRoles = exactRoles.filter(([text, lower, read]) => (serviceProblems(text, lower).length === 0) !== read).map(([text, lower]) => `${text} (${lower ? 'lower bound' : 'exact'}): ${JSON.stringify(serviceProblems(text, lower))}`)

    assert.deepEqual(wrongRoles, [], `the hours of a service are one duration, exact or a lower bound as the service says, and never a range: ${wrongRoles.join('; ')}`)

    const verdictWords = { reasons: { 'stock-empty': 'no fuel' }, verdicts: { allowed: 'Can serve', blocked: 'Cannot serve', unknown: 'Not known' }, bounds: { 'at-least': bound } }
    const verdictOf = (head, expected) => partProblems('the service', { ...servicePart('1 h'), head }, { stock: 100, ahead: [], entry: 100, served: true, received: 60, residual: 40, hours: 1, bound: 'exact', limiting: 'Ship', ...expected }, verdictWords).length
    const blockedOf = (head, permission) => partProblems('the service', { ...servicePart('1 h'), head, values: [] }, { stock: 0, ahead: [], entry: 0, served: false, permission, reason: 'stock-empty' }, verdictWords).filter(([, role]) => role === 'verdict').length
    const verdictRead = [verdictOf('Colony, Source: Can serve'), verdictOf('Colony, Source: Cannot serve'), verdictOf('Colony, Source: Not known'), verdictOf('Colony, Source: Can serve '), verdictOf('Colony, Source: Can serve: no fuel'), verdictOf('Colony, Source: '), blockedOf('Colony, Source: Cannot serve: no fuel', 'blocked'), blockedOf('Colony, Source: Not known: no fuel', 'unknown'), blockedOf('Colony, Source: Can serve: no fuel', 'blocked'), blockedOf('Colony, Source: Not known: no fuel', 'blocked'), blockedOf('Colony, Source: Cannot serve: no fuel', 'unknown'), blockedOf('Colony, Source: Cannot serve', 'blocked'), blockedOf('Colony, Source: no fuel', 'blocked')]

    assert.deepEqual(verdictRead, [0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1], `the head of a source ends with the words of its permission, and with the reason after them where nothing is served, and no other words: ${verdictRead}`)
    assert.deepEqual([secondsOf('0 h to 1 h', bound), secondsOf('0 h to 1 h', bound, { range: true }), secondsOf('2 h to 1 h', bound, { range: true }), secondsOf('1 h', bound)], [null, 3600, null, 3600], 'a range is read only where the role takes one (the wait and the round trip), and its ends are in order')

    const precise = [['27 s', 27, true], ['0 s', 27, false], ['53 min 27 s', 3207, true], ['53 min', 3207, false], ['1 h 53 min', 6807, true], ['2 h', 6807, false], ['2.2 y', 2.2 * 365 * 86400, true], ['2.2 y', 2.5 * 365 * 86400, false], ['4.1 mo', 4.1 * 30.4 * 86400, true], ['4.1 mo', 4.5 * 30.4 * 86400, false], ['33.3 d', 33.3 * 86400, true], ['33.3 d', 34.3 * 86400, false]]
    const imprecise = precise.filter(([text, seconds, same]) => sameSpan(text, seconds, bound) !== same).map(([text, seconds]) => `${text} for ${seconds} s`)

    assert.deepEqual(imprecise, [], `a duration is the figure to the precision of its last unit, never to a fixed tolerance: ${imprecise.join('; ')}`)
    assert.deepEqual([percentFigures('at 40%'), percentFigures('at 140%'), percentFigures('at -40%'), percentFigures('at (40%),'), percentFigures('at 4o%'), percentFigures('at - 40%'), percentFigures('at \u2212 40%'), percentFigures('40% or 140%')], [[40], [140], [-40], [40], [null], [-40], [-40], [40, 140]], 'a percentage is read whole, with its sign even when written apart, and a malformed one is not a number')
    assert.deepEqual([litreFigures('- 100 L'), litreFigures('\u2212 100 L'), litreFigures('((100 L'), litreFigures('(100 L), 5 L left'), litreFigures('5\'000 L, 3 L left')], [['-100'], ['\u2212100'], ['(100'], ['100', '5'], ['5\'000', '3']], 'a litre figure keeps its sign, even apart, and any stray character')

    const unreadOf = (text) => unreadProblems({ table: { rows: [{ id: 1, status: [{ on: true, text: STATUS_WORDS.unknown }] }] }, details: { 1: { ships: [{ cells: [{ on: true, kind: 'received', text }] }] } } }, [{ id: 1, name: 'Plan' }]).length
    const unreadRead = ['0 L', '\u2014', '-1 L', '1e3 L', '5 L', '- 5 L', '0.5 L', 'nonsense'].map(unreadOf)

    assert.deepEqual(unreadRead, [0, 0, 1, 1, 1, 1, 1, 1], `the received cell of an unread view is exactly 0 L or the placeholder, never a negative, a malformed or any other figure: ${unreadRead}`)

    const SHIP = { name: 'Ship', shortfall: 5 }
    const noteOf = (text) => statusProblems({ table: { rows: [{ id: 1, status: [{ on: true, text: STATUS_WORDS.range }], note: [{ on: true, text }] }] } }, [{ id: 1, name: 'Plan', status: 'range', source: { served: false, reason: 'stock-empty', ahead: [] }, dryShip: SHIP, ships: [SHIP] }], { destination: 'Dest', origin: 'Orig' }, { reasons: { 'stock-empty': 'no fuel' } }).length
    const noteRead = ['Dest Orig Ship 5 L no fuel', 'Dest Orig Ship 15 L no fuel', 'Dest Orig Ship - 5 L no fuel', 'Dest Orig Ship 5 no fuel'].map(noteOf)

    assert.deepEqual(noteRead, [0, 1, 1, 1], `the litres of a note are read as figures, so 15 L is not 5 L: ${noteRead}`)

    const names = { destination: 'Dest', origin: 'Orig' }
    const shares = { name: 'Plan', status: 'ok', limiting: { row: { name: 'Ship' }, leg: 0, dry: false, share: 0.4, shortfall: 0 }, back: { row: { name: 'Ship' }, share: 0.8 } }
    const limitRead = ['Ship at Dest 40%', 'Ship at Dest 140%', 'Ship at Dest -40%', 'Ship at Dest 4%', 'Ship at Dest', 'Ship at Dest - 40%', 'Ship at Dest \u2212 40%', 'Ship at Dest 40% or 140%', 'Ship at Dest 40% 4o%'].map((text) => limitProblems(shares, { text }, names).length)
    const backRead = ['Ship 80%', 'Ship 180%', 'Ship -80%', 'Ship 8%', 'Ship - 80%', 'Ship \u2212 80%', 'Ship 80% or 180%', 'Ship 80% 8o%'].map((text) => returnProblems(shares, { text }).length)
    const dryRead = ['Ship at Dest 5 L', 'Ship at Dest 15 L', 'Ship at Dest -5 L', 'Ship at Dest - 5 L', 'Ship at Dest 5 L or 6 L'].map((text) => limitProblems({ ...shares, limiting: { ...shares.limiting, dry: true, shortfall: 5 } }, { text }, names).length)

    assert.deepEqual([limitRead, backRead, dryRead], [[0, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 1], [0, 1, 1, 1, 1]], 'the share of the limiting ship, the return of a row and a shortfall are each the one whole figure of the role: never a figure that contains the wanted one, a detached sign, an extra figure or a malformed one')

    const cycleOf = (changes) => {
      const entries = { flight: '3 h', handling: '3 h', transit: '3 h', wait: '3 h', total: '12 h', year: '730', ...changes }

      return cycleProblems({ table: { rows: [{ id: 1, cells: { 'Trips / yr': entries.year } }] }, details: { 1: { cycle: Object.entries(entries).map(([role, text]) => ({ role, text, on: true })) } } }, [{ id: 1, name: 'Plan', status: 'ok', source: { served: false, hours: 0 } }], { bounds: { 'at-least': bound } }).length
    }
    const cycleRead = [{}, { total: '10 h' }, { total: '12 h 1 min', year: '729' }, { total: '13 h' }, { year: '8.76e2' }, { year: '0x36c' }, { year: '731' }, { wait: '1 h to 3 h', total: '10 h to 12 h' }].map(cycleOf)

    assert.deepEqual(cycleRead, [0, 1, 0, 1, 1, 1, 1, 0], `the total is the sum of the rows to the precision they are written in and the trips a year a whole figure: ${cycleRead}`)
  },
}

const PURE_CHECKS = [legChecks, exhaustedChecks, rateChecks, sharedChecks, boundaryChecks, tankerOrderChecks, reserveChecks, hoursChecks, returnChecks, requiredChecks, gateChecks, unknownChecks, motionChecks, tankerGateChecks, unreadChecks, poolChecks, readerChecks, nettingChecks, nettingUnknownChecks, nettingCycleChecks]

// A fault is a change to one module's source: `module` names it (the ledger by default), or 'page' for the source of /information.
/* eslint-disable no-template-curly-in-string */
const PURE_FAULTS = [
  { name: 'the leg hours taken at a fixed speed, not the fleet\'s', change: swap('(participant.burn * km) / cruise / SECONDS_PER_HOUR', '(participant.burn * km) / 2000 / SECONDS_PER_HOUR'), fails: ['legs'] },
  { name: 'the arrival not clamped at 0 on a leg that runs dry', change: swap('arrival: known ? Math.max(0, departure - litres) : null', 'arrival: known ? departure - litres : null'), fails: ['legs'] },
  { name: 'the limiting ship the first one that burns fuel', change: swap('(!best || item.row.arrivalShare < best.row.arrivalShare || (', '(!best || ('), fails: ['legs', 'return'] },
  { name: 'the second ship reads the colony\'s stock before the first ship\'s draw', change: swap('      left -= give\n      perShip.set(recipient.id, give)', '      perShip.set(recipient.id, give)'), fails: ['stock-shared'] },
  { name: 'the recipient limit of a low rate ignored', change: swap('(!isLowRate(tanker.rate) ? true :', '(true ? true :'), fails: ['boundary'] },
  { name: 'recipients ordered by the size of their tank, largest first', change: swap('rank(a.capacity) - rank(b.capacity)', 'rank(b.capacity) - rank(a.capacity)'), fails: ['tanker-order'] },
  { name: 'tankers ordered by the litres aboard instead of the share of the tank', change: swap('b.fraction - a.fraction ||', 'b.ship.Fuel - a.ship.Fuel ||'), fails: ['tanker-order'] },
  { name: 'the surplus above the floors of a blocked tanker counted', change: swap('saved: donor.eligibleSurplus, entry:', 'saved: donor.aboveFloors, entry:'), fails: ['tanker-order'] },
  { name: 'the player\'s reserve added to the class minimum', module: 'fuel-donors', change: swap('Math.max(minimum, reserve === null ? 0 : reserve)', 'minimum + (reserve === null ? 0 : reserve)'), fails: ['reserves'] },
  { name: 'a stock at the reserve served', change: swap('stock > reserve ? pass(\'reserve\')', 'stock >= reserve ? pass(\'reserve\')'), fails: ['reserves'] },
  { name: 'the colony\'s hours taken from the total received', change: swap('hoursOf(largest[1], rate)', 'hoursOf(received, rate)'), fails: ['hours'] },
  { name: 'the tanker hours taken as the pooled rate alone', change: swap('Math.max(received / pooled, largest[1] / top)', 'received / pooled'), fails: ['hours'] },
  { name: 'the closing visit starts from the full stock again', change: swap('service = serviceAt(stops[index], contextOf(levels, fuel), wants)', 'service = serviceAt(stops[index], contextOf(index === last ? levelsOf(stocks) : levels, fuel), wants)'), fails: ['return'] },
  { name: 'the litres a run needs leave out the floor', change: swap('needs + exact - now', 'needs - now'), fails: ['required'] },
  { name: 'a fleet that moved this pulse served', change: swap('fleet.LastMoveTime === gameTime ? fail(\'moved\', \'moved-this-pulse\')', 'false ? fail(\'moved\', \'moved-this-pulse\')'), fails: ['gates'] },
  { name: 'a first order that is not stationary served', change: swap('Number(orders) === 1 ? pass(\'stationary\')', 'true ? pass(\'stationary\')'), fails: ['gates'] },
  { name: 'a colony with no population rejected', change: swap('site ? pass(\'record\')', 'site && site.Population > 0 ? pass(\'record\')'), fails: ['gates'] },
  { name: 'a fuel aboard that is not known read as 0', change: swap('(entry.role === \'independent\' || entry.tank) && !isNumber(entry.ship.Fuel) ?', '(entry.role === \'independent\' || entry.tank) && false ?'), fails: ['unknown'] },
  { name: 'reserve records not read taken as read', change: swap('const reserveRead = isNumber(reserve)', 'const reserveRead = true'), fails: ['reserves', 'unknown'] },
  { name: 'the stocks not threaded from one fleet to the next', change: swap('current = ledger.stocksAfter', 'current = new Map(stocks)'), fails: ['netting'] },
  { name: 'a stock drawn twice', change: swap('[[key, left]] : []),', '[[key, left - received]] : []),'), fails: ['netting'] },
  { name: 'the draw order turned about', change: swap('const ledgers = fleets.map((fleet, index) => {', 'const ledgers = [...fleets].reverse().map((fleet, index) => {'), fails: ['netting'] },
  { name: 'taken-ahead reported as the stock being empty', change: swap('fail(\'draw\', isNumber(entry) && entry <= 0 ? \'taken-ahead\' : \'drawn-earlier\')', 'fail(\'draw\', \'stock-empty\')'), fails: ['netting'] },
  { name: 'the stock after the last fleet not the stock less what was received', change: swap('return { ledgers, stocks: current, order', 'return { ledgers, stocks: new Map(stocks), order'), fails: ['netting'] },
  { name: 'an unknown draw ahead read as no draw', change: swap('taint: (keys) => keys.forEach((key) => now.set(key, null)),', 'taint: () => {},'), fails: ['netting-unknown', 'unknown'] },
  { name: 'the closing fill not drawn before the next fleet', change: swap('const serving = (index) => index < last || cycle', 'const serving = (index) => index < last'), fails: ['netting-cycle'] },
  { name: 'tankers ordered by the fuel they held entering the plan, after a draw has changed it', change: swap('b.fraction - a.fraction ||', 'fractionOf(b.ship) - fractionOf(a.ship) ||'), fails: ['tanker-order'] },
  { name: 'a tanker\'s class minimum left out of the floor of the litres a run needs', change: swap('const floor = isNumber(minimum) ? Math.max(reserve, minimum) : null', 'const floor = isNumber(minimum) ? reserve : null'), fails: ['required'] },
  { name: 'a service that cannot be decided ignored when the fuel aboard carries the run', change: swap('legUnknown || unknownAt !== null ? \'unknown\' : \'ok\'', 'legUnknown ? \'unknown\' : \'ok\''), fails: ['reserves'] },
  { name: 'the closing fill left out of the seconds a refuelling adds to a cycle', change: swap('origin: at(0) + closing, destination', 'origin: at(0), destination'), fails: ['return'] },
  { name: 'a known failure that an undecided tanker cannot cure read as not known: the moved gate softened by one', change: swap('movedUnknown ? unknown(\'moved\', \'moved-unknown\') : fleet.LastMoveTime === gameTime ? fail(\'moved\', \'moved-this-pulse\') : pass(\'moved\'),\n    orders === null', 'maybe(movedUnknown ? unknown(\'moved\', \'moved-unknown\') : fleet.LastMoveTime === gameTime ? fail(\'moved\', \'moved-this-pulse\') : pass(\'moved\')),\n    orders === null'), fails: ['tanker-gates'] },
  { name: 'a gate that cannot be decided wins over one that fails', change: swap('permission: failed ? \'blocked\' : undecided ? \'unknown\' : \'allowed\'', 'permission: undecided ? \'unknown\' : failed ? \'blocked\' : \'allowed\''), fails: ['tanker-gates'] },
  { name: 'a tanker that cannot serve any recipient kept among those whose stock counts', change: swap('const relevant = eligible.filter((tanker) => !wanting.length || wanting.some((recipient) => servesRecipient(tanker, recipient) !== false))', 'const relevant = eligible'), fails: ['tanker-gates'] },
  { name: 'the stock of a tanker that cannot serve the recipient counted in the draw', change: swap('const drawable = relevant.length ? relevant : eligible', 'const drawable = eligible'), fails: ['pool'] },
  { name: 'the stock of a tanker that cannot serve the recipient not in the save leaves the draw not known', change: swap('pool.some((tanker) => !isNumber(tanker[field])) ? null', 'eligible.some((tanker) => !isNumber(tanker[field])) ? null'), fails: ['tanker-gates'] },
  { name: 'the tank not in the save of a carried ship read as no tank', change: swap('...(!isNumber(entry.capacity) ? [', '...(entry.role === \'independent\' && !isNumber(entry.capacity) ? ['), fails: ['unknown'] },
  { name: 'a designation not in the save with a minimum over the reserve read as a known floor', change: swap('designated === null && floor !== reserve ? null : floor', 'floor'), fails: ['required'] },
  { name: 'a designation not in the save read as no tanker', change: swap('const designated = designation === null || designation === undefined ? null : Number(designation) !== 0', 'const designated = Number(designation) !== 0'), fails: ['required'] },
  { name: 'a stocked tanker that cannot serve any wanting recipient counted among the donors whose order matters', change: swap('const givers = relevant.filter(', 'const givers = eligible.filter('), fails: ['tanker-gates'] },
  { name: 'a full tank asked for litres when the floor or the burn is not in the save', change: swap('return room <= 0 ? 0 : needs !== null', 'return needs !== null'), fails: ['required'] },
  { name: 'a floor not in the save never taken to fill a tank the burn already empties', change: swap(': (needs ?? 0) + low - now >= room ? room : null', ': null'), fails: ['required'] },
  { name: 'the visits after a leg whose length is not known taken as drawing nothing', change: swap('const later = probes.flatMap((probe, index) => (probe && index >= stopResults.length ?', 'const later = probes.flatMap((probe, index) => (false ?'), fails: ['unknown'] },
  { name: 'the litres a fleet ahead drew of a source whose draw is not known read as the baseline litres', change: swap('litres: ledger.tainted.includes(key) ? null : ledger.drawn.get(key) }', 'litres: ledger.drawn.get(key) }'), fails: ['unknown'] },
  { name: 'the litres of a fleet ahead summed over a draw that is not known', change: swap('total.get(item.fleet) === null || item.litres === null ? null : (total.get(item.fleet) || 0) + item.litres', '(total.get(item.fleet) || 0) + item.litres'), fails: ['unknown'] },
  { name: 'the litres a stop needs counted to the stop beyond a service that cannot be decided', change: swap('if (servable[at] === true || (haltAtMaybe && servable[at])) {', 'if (servable[at] === true) {'), fails: ['unknown'] },
  { name: 'a source a fleet may draw with no draw in the baseline left out of the draws ahead', change: swap('new Set([...ledger.drawn.keys(), ...ledger.tainted])', 'new Set([...ledger.drawn.keys()])'), fails: ['unknown'] },
  { name: 'a fleet ahead whose draw is not known named as drawing first in the note of a draw', change: swap('part.takenAhead.filter((item) => item.litres !== null).map((item) => item.fleet)))]\n  const left', 'part.takenAhead.map((item) => item.fleet)))]\n  const left'), fails: ['unknown'] },
  { name: 'a fleet ahead whose draw is not known named as drawing first in the note of a dry run', change: swap('part.takenAhead.some((item) => item.litres !== null)', 'part.takenAhead.length'), fails: ['unknown'] },
  { name: 'a fleet ahead said to have drawn a source dry where no draw of it is known', change: swap('entry.reason === \'taken-ahead\' && entry.ahead.some((item) => item.litres !== null) ?', 'entry.reason === \'taken-ahead\' && entry.ahead.length ?'), fails: ['unknown'] },
  { name: 'a fleet ahead whose draw is not known named among those that drew a source dry', change: swap('${entry.ahead.filter((item) => item.litres !== null).map((item) => item.fleet).join', '${entry.ahead.map((item) => item.fleet).join'), fails: ['unknown'] },
  { name: 'the flown distances taken as known beside refuelling hours that are not', module: 'page', change: swap('return stage.clockUnknown ? [null, null] : stage.moved ?', 'return stage.moved ?'), fails: ['motion'] },
  { name: 'the flying time of the cycle printed beside a run that is not known', module: 'page', change: swap('known ? this.span(trip.travelSeconds) : \'Not known\'', 'this.span(trip.travelSeconds)'), fails: ['motion'] },
  { name: 'the fuel of each ship for the trip printed beside a run that is not known', module: 'page', change: swap('participantRows(profile, known ? trip : null)', 'participantRows(profile, trip)'), fails: ['motion'] },
  { name: 'the fuel of each ship for the trip printed from the distances alone', module: 'page', change: swap('participantRows(profile, known ? trip : null)', 'participantRows(profile, stage.clockUnknown ? null : trip)'), fails: ['motion'] },
  { name: 'a reserve that is not read taken as no reserve in the floor of a run', change: swap('return { exact: null, low: designated === true && isNumber(minimum) ? minimum : 0 }', 'return { exact: 0, low: designated === true && isNumber(minimum) ? minimum : 0 }'), fails: ['unread-reserve'] },
  { name: 'a reserve that is not read taken as no reserve where a tanker keeps a class minimum', change: swap('return { exact: null, low: designated === true && isNumber(minimum) ? minimum : 0 }', 'return { exact: null, low: 0 }'), fails: ['unread-reserve'] },
  { name: 'the litres a ship needs printed as 0 where they are not known', module: 'page', change: swap('text: litres(need.litres) }', 'text: litres(need.litres === null ? 0 : need.litres) }'), fails: ['unread-reserve'] },
  { name: 'the surplus of a fleet printed as 0 where it is not known', module: 'page', change: swap('text: litres(part.stock) }', 'text: litres(part.stock === null ? 0 : part.stock) }'), fails: ['pool'] },
  { name: 'the pool a fleet is given printed as 0 where it is not known', module: 'page', change: swap('text: litres(part.entry) }', 'text: litres(part.entry === null ? 0 : part.entry) }'), fails: ['pool'] },
  { name: 'the pool a fleet is given known where a tanker that cannot serve it holds litres not in the save and no tanker able to serve it is known', change: swap('pool.some((tanker) => !isNumber(tanker[field])) ? null', 'relevant.some((tanker) => !isNumber(tanker[field])) ? null'), fails: ['pool'] },
  { name: 'the first stop whose service cannot be decided not taken as the point from which the run is not known', change: swap('if (service.services.some((part) => part.permission === \'unknown\')) {', 'if (false) {'), fails: ['unknown'] },
  { name: 'the sites not read at a stop that serves not taken as the point from which the run is not known', change: swap('      doubt(index)\n      rejected.push({ stop: index, stopName: stops[index].name, kind: null, source: \'\', permission', '      rejected.push({ stop: index, stopName: stops[index].name, kind: null, source: \'\', permission'), fails: ['unknown'] },
  { name: 'a litres target that is not known not taken as the point from which the run is not known', change: swap('          doubt(index)\n          rejected.push({ stop: index, stopName: stops[index].name, kind: null, source: entry.name', '          rejected.push({ stop: index, stopName: stops[index].name, kind: null, source: entry.name'), fails: ['required'] },
  { name: 'only the first doubted stop read as not known, the stops after it served as the baseline gives them', change: swap('if (unknownAt !== null) {\n        service.services', 'if (unknownAt === index) {\n        service.services'), fails: ['unknown'] },
  { name: 'the legs after the first doubted stop given figures', change: swap('return unread ? { id: entry.id', 'return false ? { id: entry.id'), fails: ['unknown'] },
  { name: 'the limiting ship named from the legs before the first doubted stop', change: swap('limiting: worst && unknownAt === null && !legUnknown ?', 'limiting: worst && !legUnknown ?'), fails: ['unknown'] },
  { name: 'the litres a run needs printed as known from the first doubted stop on', change: swap('required: unknownAt === null ? required : required.map((item) => (item.stop >= unknownAt ? { ...item, litres: null } : item)),', 'required,'), fails: ['unknown'] },
  { name: 'the litres received after the first doubted stop printed as known', change: swap('received: !unread && service ? service.received : null', 'received: service ? service.received : null'), fails: ['unknown'] },
  { name: 'the figures of a source read from the first doubted stop on kept', change: swap('stock: null, saved: null, entry: null, available: null, received: null, residual: null,', 'stock: part.stock, saved: part.saved, entry: part.entry, available: part.available, received: part.received, residual: part.residual,'), fails: ['unknown'] },
  { name: 'the sources a doubted stop may touch left out of the sources not known to the fleets behind', change: swap('          levels.taint(part.keys)\n          part.keys.forEach((key) => tainted.add(key))\n', '          void part.keys\n'), fails: ['unknown'] },
  { name: 'a source that a blocked service does not touch taken as touched by the doubt', change: swap('.filter((part) => part.permission !== \'blocked\' || !FIXED_BLOCKS.has(part.reason)).forEach(', '.forEach('), fails: ['unknown'] },
  { name: 'a source blocked on the demand the run had when it was doubted taken as untouched by the doubt', change: swap('part.permission !== \'blocked\' || !FIXED_BLOCKS.has(part.reason)', 'part.permission !== \'blocked\''), fails: ['unknown'] },
  { name: 'tankers not decided taken as nothing when the known tankers are drained', change: swap('const maybe = (gate) => (undecided.length > 0 && gate.status === \'fail\' ? unknown(gate.gate, \'donors-partial\') : gate)', 'const maybe = (gate) => gate'), fails: ['tanker-gates'] },
  { name: 'an input of a tanker service that is not known left out of the gates', change: swap('input ? unknown(\'inputs\', input) : pass(\'inputs\')', 'pass(\'inputs\')'), fails: ['tanker-gates'] },
  { name: 'a recipient whose size is not in the save not taken as an input of the tanker service', change: swap('sizeDoubt ? \'recipient-unknown\' : givers', 'false ? \'recipient-unknown\' : givers'), fails: ['tanker-gates'] },
  { name: 'the tank that orders the giving tankers not taken as an input of the tanker service', change: swap('givers.length > 1 && givers.some((tanker) => !tanker.orderKnown) ? \'order-unknown\'', 'false ? \'order-unknown\''), fails: ['tanker-gates'] },
  { name: 'the order of a single giving tanker taken as an input of the tanker service', change: swap('givers.length > 1 && givers.some((tanker) => !tanker.orderKnown)', 'givers.some((tanker) => !tanker.orderKnown)'), fails: ['tanker-gates'] },
  { name: 'the priority that orders the recipients not taken as an input of the tanker service', change: swap('wanting.length > 1 && wanting.some((recipient) => !isNumber(recipient.ship.RefuelPriority) || !isNumber(recipient.ship.ClassRefuelPriority)) ? \'priority-unknown\'', 'false ? \'priority-unknown\''), fails: ['tanker-gates'] },
  { name: 'the priority of a single recipient taken as an input of the tanker service', change: swap('wanting.length > 1 && wanting.some((recipient) => !isNumber(recipient.ship.RefuelPriority)', 'wanting.some((recipient) => !isNumber(recipient.ship.RefuelPriority)'), fails: ['tanker-gates'] },
  { name: 'a tanker not decided beside known ones taken as no doubt of the donors', change: swap('eligible.length ? (undecided.length ? unknown(\'donors\', \'donors-partial\') : pass(\'donors\'))', 'eligible.length ? pass(\'donors\')'), fails: ['tanker-gates'] },
  { name: 'tankers not decided and none known taken as no tanker at all', change: swap('undecided.length ? unknown(\'donors\', \'donors-unknown\') : fail(\'donors\', \'no-eligible-tanker\')', 'fail(\'donors\', \'no-eligible-tanker\')'), fails: ['tanker-gates'] },
  { name: 'a recipient too large for the known tankers with a tanker not decided read as a definite block', change: swap('undecided.length ? unknown(\'recipient\', \'donors-partial\') : fail(\'recipient\'', 'fail(\'recipient\''), fails: ['tanker-gates'] },
  { name: 'a recipient too large for the known tankers where its size is not in the save read as a definite block', change: swap('sizeDoubt ? unknown(\'recipient\', \'recipient-unknown\') : undecided.length', 'undecided.length'), fails: ['tanker-gates'] },
  { name: 'the surplus of a fleet printed as known beside a tanker not decided', change: swap('stock: undecided.length ? null : savedTotal,', 'stock: savedTotal,'), fails: ['pool'] },
  { name: 'the saved surplus of a fleet known beside a tanker not decided', change: swap('saved: undecided.length ? null : savedTotal,', 'saved: savedTotal,'), fails: ['pool'] },
  { name: 'the pool a fleet is given known beside a tanker not decided or a recipient whose size is not in the save', change: swap('entry: undecided.length || sizeDoubt ? null : entryTotal,', 'entry: entryTotal,'), fails: ['pool'] },
  { name: 'a tanker said to be drawn from where the service is not known', change: swap('known: decided.permission !== \'unknown\',', 'known: true,'), fails: ['pool'] },
  { name: 'a fleet ahead that may have drawn from a tanker not decided left out of the draws ahead', change: swap('mergeTaken([...eligible, ...undecided].flatMap(', 'mergeTaken([...eligible].flatMap('), fails: ['pool'] },
  { name: 'the time of a run known where a service cannot be decided', change: swap('export const timingKnown = (ledger) => !ledger || ledger.status !== \'unknown\'', 'export const timingKnown = (ledger) => true'), fails: ['unknown'] },
  { name: 'the seconds of a run not known counted from no stop at all', change: swap('if (!ledger || !ledger.stops.length) {', 'if (!ledger || ledger.status === \'unknown\' || !ledger.stops.length) {'), fails: ['motion'] },
  { name: 'the flown distances taken as known beside a capped year whose hours are not', module: 'page', change: swap('clockUnknown: (moved || capped) && !timingKnown(ledger)', 'clockUnknown: moved && !timingKnown(ledger)'), fails: ['motion'] },
  { name: 'the flown distances not known beside moving endpoints whatever the hours', module: 'page', change: swap('clockUnknown: (moved || capped) && !timingKnown(ledger)', 'clockUnknown: moved || capped'), fails: ['motion'] },
  { name: 'the flown distances not known beside hours that are not, though the endpoints are held', module: 'page', change: swap('clockUnknown: (moved || capped) && !timingKnown(ledger)', 'clockUnknown: !timingKnown(ledger)'), fails: ['motion'] },
  { name: 'the next stop that serves looked for with no recipient in mind', change: swap('other === entry ? 1 : 0', '0'), fails: ['required'] },
  { name: 'the switch of the fill target is not passed to the ledgers', module: 'page', change: swap('target: this.fillRequired ? \'required\' : \'full\'', 'target: \'full\''), fails: ['motion'] },
]
/* eslint-enable no-template-curly-in-string */

const PURE_BENIGN = [
  { name: 'the colony\'s reserve written as a ternary', change: swap('(reserves.colony(site.PopulationID) ?? 0)', '(reserves.colony(site.PopulationID) === null ? 0 : reserves.colony(site.PopulationID))') },
  { name: 'the unknown flown distances with the moved test parenthesised', module: 'page', change: swap('return stage.clockUnknown ? [null, null] : stage.moved ?', 'return stage.clockUnknown ? [null, null] : (stage.moved) ?') },
  { name: 'the clock that is not known written as a negated test', module: 'page', change: swap('clockUnknown: (moved || capped) && !timingKnown(ledger)', 'clockUnknown: !(!(moved || capped) || timingKnown(ledger))') },
  { name: 'the fuel of each ship for the trip written as a negated test', module: 'page', change: swap('participantRows(profile, known ? trip : null)', 'participantRows(profile, !known ? null : trip)') },
]

// ---------- the ledger over the saves, read-only ----------

const SAVES = { falryx: 'artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db', egg: 'saves/AuroraDB.db' }
const REAL = { falryx: { GameID: 141, RaceID: 791, fleet: 461113, tankers: 468378 }, egg: { GameID: 138, RaceID: 785, fleet: 462709 } }

const openRead = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(path.join(root, file), sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(raw)))
})
const allOf = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

const withSave = async (key, work) => {
  const raw = await openRead(SAVES[key])

  try {
    return await work(raw, { query: async (sql) => [await allOf(raw, sql)] })
  } finally {
    await closeRaw(raw)
  }
}

const POINTS = 'coalesce((select sum(i.MassRefuelling * a.Amount) from FCT_PopulationInstallations a join DIM_PlanetaryInstallation i on i.PlanetaryInstallationID = a.PlanetaryInstallationID where a.PopID = p.PopulationID and a.GameID = p.GameID), 0)'

const realCargoChecks = {
  id: 'real-cargo',
  name: 'the Falryx 2930 save, race 791: ten cargo ships against a colony with a stock, one with none, one of population 0, and a stationary tanker fleet, each against SQL and the independent fills',
  run: async (ctx) => {
    await withSave('falryx', async (raw, database) => {
      const ids = REAL.falryx
      const ships = await ctx.mod.loadFleetShips(database, { GameID: ids.GameID, RaceID: ids.RaceID, fleetWhere: `FCT_Fleet.FleetID = ${ids.fleet}` })
      const sites = await ctx.mod.loadFuelSites(database, ids)
      const sql = await allOf(raw, `select s.ShipID id, c.FuelCapacity - s.Fuel want, c.FuelCapacity cap from FCT_Ship s join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.FleetID = ${ids.fleet} order by s.ShipID`)
      const [stocks] = [Object.fromEntries((await allOf(raw, `select p.PopName name, p.PopulationID id, p.FuelStockpile stock, p.Population population, ${POINTS} points from FCT_Population p where p.RaceID = ${ids.RaceID} and p.PopName in ('New Concordia', 'Valerian', 'Bremen IV')`)).map((row) => [row.name, row]))]
      const [{ rate }] = await allOf(raw, `select MaxRefuellingRate rate from FCT_Race where RaceID = ${ids.RaceID}`)
      const run = (stop, siteChanges = {}) => ctx.mod.fuelLedger({ profile: ctx.fp.fleetProfile(ships, { FleetID: ids.fleet, FleetName: 'Cargo Fleet Bravo' }, { basis: 'maximum' }), legs: [1e6], stops: [stop, { name: 'Elsewhere', PopulationID: null, SystemID: 1, Xcor: 0, Ycor: 0 }], sites: { ...sites, ...siteChanges }, reserves: READ, version: VERSION })
      const stopOf = (row) => ({ name: row.name, PopulationID: row.id, SystemID: 1, Xcor: 0, Ycor: 0 })

      assert.equal(ships.length, 10, 'the fleet has ten ships')
      assert.equal(sites.rates.MaxRefuellingRate, rate, 'the race\'s rate is the one in the save')

      const wants = sql.map((row) => ({ id: row.id, litres: row.want }))
      const truth = fuelFillTruth.colonyFill({ stock: stocks['New Concordia'].stock, reserve: 0, rate, wants })
      const service = firstService(run(stopOf(stocks['New Concordia'])))

      wants.forEach((want) => near(service.perShip.get(want.id), want.litres, `ship ${want.id} receives its deficit`))
      near(service.perShip.get(196290), 214783.069585257, 'each ship receives 214,783.07 L')
      near(service.received, truth.total, 'the total received')
      near(service.hours, truth.hours, 'the hours')
      near(service.hours, 214783.069585257 / 160000, 'the hours are the largest deficit over the rate, 1.342')
      near(service.residual, stocks['New Concordia'].stock - truth.total, 'the residual is the stock less what was received')

      const empty = firstService(run(stopOf(stocks.Valerian)))

      assert.equal(stocks.Valerian.stock, 0, 'Valerian has no stock in the save')
      assert.deepEqual({ permission: empty.permission, reason: empty.reason, received: empty.received }, { permission: 'blocked', reason: 'stock-empty', received: 0 }, 'a colony with a point and no stock')

      const bremen = firstService(run(stopOf(stocks['Bremen IV'])))

      assert.equal(stocks['Bremen IV'].population, 0, 'Bremen IV has no population in the save')
      assert.equal(bremen.permission, 'allowed', 'a colony of population 0 serves')
      near(bremen.received, truth.total, 'and gives each ship its deficit')

      const fleetRow = sites.fleets.find((fleet) => fleet.FleetID === ids.tankers)
      const [donor] = await allOf(raw, `select s.ShipID id, s.Fuel fuel, c.MinimumFuel minimum, c.RefuellingRate rate, c.FuelCapacity cap from FCT_Ship s join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.FleetID = ${ids.tankers}`)
      const depot = { name: 'Depot', PopulationID: null, SystemID: fleetRow.SystemID, Xcor: fleetRow.Xcor, Ycor: fleetRow.Ycor }
      const surplus = Math.floor(donor.fuel) - donor.minimum
      const filled = fuelFillTruth.tankerFill({ tankers: [{ id: donor.id, fraction: donor.fuel / donor.cap, surplus, rate: donor.rate }], recipients: ships.map((ship) => ({ id: ship.ShipID, priority: ship.RefuelPriority, classPriority: ship.ClassRefuelPriority, capacity: ship.FuelCapacity, size: ship.Size, litres: ship.FuelCapacity - ship.Fuel })) })
      const tankers = firstService(run(depot))

      assert.equal(surplus, 21774428, 'the tanker has 21,774,428 L above its floor')
      assert.equal(fleetRow.FirstOrderStationary, 1, 'the fleet has no order, which is stationary')
      assert.equal(tankers.permission, 'allowed', 'the tanker fleet\'s gates pass')
      assert.equal(tankers.stock, surplus, 'the surplus is the whole litres above the minimum')
      near(tankers.received, filled.total, 'the fleet is filled from the one tanker')
      near(tankers.hours, 2147830.69585257 / 450000, 'the hours are at least the litres over the rate')
      assert.equal(tankers.bound, 'at-least', 'a lower bound')
    })
  },
}

const realColonyChecks = {
  id: 'real-colonies',
  name: 'both saves: every colony of the race with a point and no stock is blocked at the stock, and no colony has a stock and no point',
  run: async (ctx) => {
    for (const key of ['falryx', 'egg']) {
      await withSave(key, async (raw, database) => {
        const ids = REAL[key]
        const sites = await ctx.mod.loadFuelSites(database, ids)
        const rows = await allOf(raw, `select p.PopulationID id, ${POINTS} points, p.FuelStockpile stock from FCT_Population p where p.RaceID = ${ids.RaceID}`)
        const emptyWithPoint = rows.filter((row) => row.points > 0 && row.stock === 0)
        const stockNoPoint = rows.filter((row) => row.points === 0 && row.stock > 0)

        assert.equal(sites.colonies.length, rows.length, `${key}: every colony of the race is listed`)
        assert.equal(stockNoPoint.length, 0, `${key}: no colony has a stock and no point`)

        emptyWithPoint.forEach((row) => {
          const site = sites.colonies.find((colony) => colony.PopulationID === row.id)
          const service = ctx.mod.colonyService(site, [{ id: 1, want: 10 }], { rate: 80000, reserve: 0, saved: 0, now: 0, entry: 0 })

          assert.deepEqual({ permission: service.permission, reason: service.reason }, { permission: 'blocked', reason: 'stock-empty' }, `${key}: colony ${row.id} with a point and no stock`)
        })
      })
    }
  },
}

const realTankerChecks = {
  id: 'real-tankers',
  name: 'the EggSample save, race 785: the fleet of 50 tankers against ten planted recipients: the gates pass with no orders and the fill equals the independent one over all 50',
  run: async (ctx) => {
    await withSave('egg', async (raw, database) => {
      const ids = REAL.egg
      const loaded = await ctx.mod.loadFuelSites(database, ids)
      const fleet = loaded.fleets.find((row) => row.FleetID === ids.fleet)
      const donors = await allOf(raw, `select s.ShipID id, s.Fuel fuel, c.MinimumFuel minimum, c.RefuellingRate rate, c.FuelCapacity cap from FCT_Ship s join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.FleetID = ${ids.fleet}`)
      const recipients = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => hauler(id, 0, { FuelCapacity: 500000 + 50000 * id, RefuelPriority: (id % 3) + 1 }))
      const planted = colonyRow(987654321, { SystemID: fleet.SystemID, SystemBodyID: fleet.OrbitBodyID, FuelStockpile: 0, RefuellingPoints: 0 })
      const sites = { ...loaded, colonies: [...loaded.colonies, planted] }
      const ledger = ledgerOf(ctx, { ships: recipients, stops: [{ name: 'Orbit', PopulationID: planted.PopulationID, SystemID: fleet.SystemID, Xcor: fleet.Xcor, Ycor: fleet.Ycor }, at(null, 'Far')], sites })
      const service = ledger.stops[0].service.services.find((part) => part.kind === 'tankers')
      const truth = fuelFillTruth.tankerFill({ tankers: donors.map((row) => ({ id: row.id, fraction: row.fuel / row.cap, surplus: Math.floor(row.fuel) - row.minimum, rate: row.rate })), recipients: recipients.map((ship) => ({ id: ship.ShipID, priority: ship.RefuelPriority, classPriority: ship.ClassRefuelPriority, capacity: ship.FuelCapacity, size: ship.Size, litres: ship.FuelCapacity })) })

      assert.equal(donors.length, 50, 'the fleet has 50 tankers')
      assert.equal(fleet.FirstOrderStationary, 1, 'the fleet has no orders')
      assert.equal(service.permission, 'allowed', 'the gates pass')
      recipients.forEach((ship) => near(service.perShip.get(ship.ShipID), truth.received.get(ship.ShipID) || 0, `ship ${ship.ShipID} receives what the independent fill gives`))
      donors.forEach((row) => near(service.tankers.find((tanker) => tanker.key === `tanker:${row.id}`).drawn, truth.drawn.get(row.id), `tanker ${row.id} gives what the independent fill takes`))
      near(service.residual, [...truth.residual.values()].reduce((sum, litres) => sum + litres, 0), 'the residual of the fleet')
    })
  },
}

const REAL_CHECKS = [realCargoChecks, realColonyChecks, realTankerChecks]

// ---------- the planted world of the page ----------

const FALRYX = 'saves/AuroraDB_270_Falryx_date_issue.db'
const IDS = { GameID: 141, RaceID: 785 }
const NAMES = { game: 'Orphean Concord', race: 'Meacham Clan' }
const TIMEOUT = 120000

// The run of the page: from colony 48978 (a system with no stock) to the spaceport planted at colony 48979 in the next system, 400 hours at 1,490 km/s each way. Each cargo ship holds 20,000 L (the class is cut to that), starts with 17,000 L and burns the 25.9 L/h of its engines, so a leg takes about 10,360 L, a ship reaches the destination with more than half a leg in its tank (the litres a ship takes to reach the next stop are then exact) and the round trip does not fit without a fill.
const WORLD = { origin: 48978, destination: 48979, originBody: 1989396, destinationBody: 1989404, originSystem: 21629, destinationSystem: 21630, jumpOut: 59542, jumpIn: 59547, classId: 62907, tankerClass: 62897, speed: 1490, hours: 400, capacity: 20000, fuel: 17000, spaceport: 33 }
const LEG_KM = WORLD.hours * 3600 * WORLD.speed
// The fleets of two ships each, named so that the order of their names is the reverse of the order of their IDs.
const FLEETS = [{ id: 460019, name: 'Zulu Convoy', ships: [195834, 195836] }, { id: 460021, name: 'Yankee Convoy', ships: [195838, 195840] }, { id: 460023, name: 'Xray Convoy', ships: [195842, 195844] }]
const NAME_ORDER = ['Xray Convoy', 'Yankee Convoy', 'Zulu Convoy']
// The stationary tanker fleet of the `tankers` variant: a Lynx with 700,000 L above its minimum and a clone of its class with no Transfer - Fuel system.
const TANKERS = { fleetName: 'Depot tankers', source: 460006, eligible: 195791, blocked: 196154, blockedFuel: 1000000 }
// The refuelling rate of the race in the planted copy: low, so that the hours a fill takes show in the days of the round trip.
const RATE = 500

const openRw = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => (error ? reject(error) : resolve(raw)))
})
const runSql = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

// What one ship of the class burns on a leg and what its tank holds, from the class row: litres an hour are the engine power times the class's fuel efficiency.
const worldFigures = async (raw) => {
  const [row] = await allOf(raw, `select EnginePower power, FuelEfficiency efficiency from FCT_ShipClass where ShipClassID = ${WORLD.classId}`)
  const burn = row.power * row.efficiency

  return { burn, leg: burn * WORLD.hours, capacity: WORLD.capacity, fuel: WORLD.fuel }
}

const stockOf = async (raw, variant) => {
  const { leg } = await worldFigures(raw)

  return { full: 1e9, half: 1.5 * 2 * leg, short: 1.5 * leg, zero: 0, tankers: 0 }[variant]
}

const VARIANTS = ['full', 'half', 'short', 'zero', 'tankers']

// The statements that make the copy of the save the page reads, common to every variant.
const baseStatements = () => [
  `update FCT_Race set NPR = 0, MaxRefuellingRate = ${RATE} where RaceID = ${IDS.RaceID}`,
  `update FCT_Population set FuelStockpile = 0 where PopulationID = ${WORLD.origin}`,
  `insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount) values (${IDS.GameID}, ${WORLD.destination}, ${WORLD.spaceport}, 1)`,
  `update FCT_Fleet set OrbitBodyID = 0 where OrbitBodyID in (${WORLD.originBody}, ${WORLD.destinationBody})`,
  `update FCT_SystemBody set OrbitalDistance = 0, Xcor = 0, Ycor = 0 where SystemBodyID in (${WORLD.originBody}, ${WORLD.destinationBody})`,
  `update FCT_JumpPoint set Xcor = ${LEG_KM}, Ycor = 0 where WarpPointID = ${WORLD.jumpOut}`,
  `update FCT_JumpPoint set Xcor = 0, Ycor = 0 where WarpPointID = ${WORLD.jumpIn}`,
  `update FCT_ShipClass set FuelCapacity = ${WORLD.capacity} where ShipClassID = ${WORLD.classId}`,
  `delete from FCT_MoveOrders where FleetID in (${FLEETS.map((fleet) => fleet.id).join(', ')})`,
  ...FLEETS.flatMap((fleet) => [
    `update FCT_Fleet set FleetName = '${fleet.name}', ShippingLine = 0, Speed = ${WORLD.speed}, UseMaximumSpeed = 1, SystemID = ${WORLD.originSystem}, Xcor = 0, Ycor = 0 where FleetID = ${fleet.id}`,
    ...fleet.ships.map((ship) => `update FCT_Ship set FleetID = ${fleet.id}, Fuel = ${WORLD.fuel}, OverhaulFactor = 1 where ShipID = ${ship}`),
  ]),
]

// The statements of the tanker fleet at the destination's body.
const tankerStatements = (fleetId, classId, surplus) => [
  'drop table if exists temp.VIR_Fleet',
  `create temp table VIR_Fleet as select * from FCT_Fleet where FleetID = ${TANKERS.source}`,
  `update temp.VIR_Fleet set FleetID = ${fleetId}, FleetName = '${TANKERS.fleetName}', SystemID = ${WORLD.destinationSystem}, OrbitBodyID = ${WORLD.destinationBody}, Xcor = 0, Ycor = 0, LastMoveTime = 0, ShippingLine = 0`,
  'insert into FCT_Fleet select * from temp.VIR_Fleet',
  'drop table temp.VIR_Fleet',
  'drop table if exists temp.VIR_Clone',
  `create temp table VIR_Clone as select * from FCT_ShipClass where ShipClassID = ${WORLD.tankerClass}`,
  `update temp.VIR_Clone set ShipClassID = ${classId}, ClassName = 'Lynx without a system'`,
  'insert into FCT_ShipClass select * from temp.VIR_Clone',
  'drop table temp.VIR_Clone',
  `insert into FCT_ClassComponent (GameID, ClassID, ComponentID, NumComponent, ChanceToHit, ElectronicCTH) select GameID, ${classId}, ComponentID, NumComponent, ChanceToHit, ElectronicCTH from FCT_ClassComponent where ClassID = ${WORLD.tankerClass} and ComponentID not in (select SDComponentID from FCT_ShipDesignComponents where ComponentTypeID = 61)`,
  `delete from FCT_MoveOrders where FleetID in (${TANKERS.source}, ${fleetId})`,
  `update FCT_Ship set FleetID = ${fleetId}, Fuel = (select MinimumFuel from FCT_ShipClass where ShipClassID = FCT_Ship.ShipClassID) + ${surplus} where ShipID = ${TANKERS.eligible}`,
  `update FCT_Ship set FleetID = ${fleetId}, ShipClassID = ${classId}, Fuel = ${TANKERS.blockedFuel} where ShipID = ${TANKERS.blocked}`,
]

// A copy of the save for each of `variants` in a folder of its own: the destination's stock set, and in `tankers` the stationary fleet.
const plantWorld = async (variants = VARIANTS) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-refuel-legs-'))
  const files = {}
  const figures = {}

  for (const variant of variants) {
    const file = path.join(folder, `${variant}.db`)

    fs.copyFileSync(path.join(root, FALRYX), file)

    const raw = await openRw(file)

    try {
      for (const statement of baseStatements()) {
        await runSql(raw, statement)
      }

      const stock = await stockOf(raw, variant)

      await runSql(raw, `update FCT_Population set FuelStockpile = ${stock} where PopulationID = ${WORLD.destination}`)

      if (variant === 'tankers') {
        const [{ fleet }] = await allOf(raw, 'select max(FleetID) + 1 as fleet from FCT_Fleet')
        const [{ top }] = await allOf(raw, 'select max(ShipClassID) + 1 as top from FCT_ShipClass')

        const { leg } = await worldFigures(raw)

        figures.surplus = Math.floor(3 * leg)

        for (const statement of tankerStatements(fleet, top, figures.surplus)) {
          await runSql(raw, statement)
        }

        figures.tankerFleet = fleet
      }

      figures[variant] = { stock, ...(await worldFigures(raw)) }
    } finally {
      await closeRaw(raw)
    }

    files[variant] = file
  }

  return { folder, files, figures }
}

// ---------- the page, read as a player sees it ----------

const PAGE = 'src/renderer/pages/information.vue'
const ROUTE = `/information?from=colony:${WORLD.origin}&to=colony:${WORLD.destination}`
const STAGE_TIMEOUT = 30000
const FLEET = Object.fromEntries(FLEETS.map((fleet) => [fleet.name.split(' ')[0], fleet]))
const DEFAULT_ORDER = NAME_ORDER.map((name) => FLEETS.find((fleet) => fleet.name === name))
const ALL_IDS = FLEETS.map((fleet) => fleet.id)
// What a variant of the page holds, each variant's one session reading the keys listed: the default view of the variant itself, and for `half` the stages of the picks, the sorts, the fill target and the reserves that cannot be read.
const SESSION_KEYS = { full: ['full'], half: ['half', 'sorts', 'unread', 'picks', 'required'], short: ['short'], zero: ['zero'], tankers: ['tankers'] }
const STATUS_WORDS = { ok: 'Can run', range: 'Out of range', unknown: 'Not known' }
// The verdicts of each variant for the fleets in the order of their names, written from the rules: a full stock fills everyone, one and a half fleets' worth fills the first fleet and one ship of the second, a stock short of the first fleet fills one ship and part of the other, none fills no one, and the tanker fleet gives what the colony holds in the half variant.
const VERDICTS = { full: ['ok', 'ok', 'ok'], half: ['ok', 'range', 'range'], short: ['range', 'range', 'range'], zero: ['range', 'range', 'range'], tankers: ['ok', 'range', 'range'] }

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const openAt = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(raw)))
})

const ordersIn = async (file) => {
  const raw = await openAt(file)

  try {
    const [{ n }] = await allOf(raw, 'select count(*) as n from FCT_MoveOrders')

    return n
  } finally {
    await closeRaw(raw)
  }
}

// What the page should read of the ships, the colonies and the tanker of each variant, from the rows of the planted copy.
const truthOf = async (world) => {
  const variants = {}
  const shipSql = (where) => `select s.ShipID as id, s.ShipName as name, s.Fuel as fuel, s.RefuelPriority as priority, c.RefuelPriority as classPriority, c.FuelCapacity as capacity, c.Size as size, c.MinimumFuel as minimum, c.RefuellingRate as rate from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where ${where}`

  for (const variant of Object.keys(world.files)) {
    const raw = await openAt(world.files[variant])

    try {
      const ships = await allOf(raw, shipSql(`s.ShipID in (${FLEETS.flatMap((fleet) => fleet.ships).join(', ')})`))
      const [tanker] = variant === 'tankers' ? await allOf(raw, shipSql(`s.ShipID = ${TANKERS.eligible}`)) : []
      const [blocked] = variant === 'tankers' ? await allOf(raw, shipSql(`s.ShipID = ${TANKERS.blocked}`)) : []
      const names = await allOf(raw, `select PopulationID as id, PopName as name from FCT_Population where PopulationID in (${WORLD.origin}, ${WORLD.destination})`)

      variants[variant] = { ships: new Map(ships.map((ship) => [ship.id, ship])), tanker: tanker || null, blocked: blocked || null, origin: names.find((row) => row.id === WORLD.origin).name, destination: names.find((row) => row.id === WORLD.destination).name }
    } finally {
      await closeRaw(raw)
    }
  }

  return { figures: world.figures, variants }
}

// The fills of the fleets in `order`, one after another from the one stock of the variant (the colony's, or the tanker's surplus above its minimum), each ship in the order of its ID wanting a full tank, or in `required` mode the litres to reach the next stop, through the independent fills of scripts/lib/fuel-service-oracle.js. Gives, for each fleet: its ships (litres aboard on each leg), the verdict, the source's state when the fleet came to it and what it left, the hours and the ship that limits.
const simulate = (truth, variant, order, { required = false } = {}) => {
  const data = truth.variants[variant]
  const { leg } = truth.figures[variant]
  const tankers = Boolean(data.tanker)
  let left = tankers ? Math.floor(data.tanker.fuel) - data.tanker.minimum : truth.figures[variant].stock
  const stock = left
  const ahead = []

  return order.map((fleet, position) => {
    const ships = fleet.ships.map((id) => data.ships.get(id)).sort((a, b) => a.id - b.id)
    const wants = ships.map((ship) => {
      const arrive = ship.fuel - leg

      return { id: ship.id, litres: required ? Math.max(0, Math.min(ship.capacity - arrive, leg - arrive)) : ship.capacity - arrive }
    })
    const entry = left
    const tankerFill = () => fuelFillTruth.tankerFill({ tankers: [{ id: data.tanker.id, fraction: data.tanker.fuel / data.tanker.capacity, surplus: entry, rate: data.tanker.rate }], recipients: ships.map((ship, index) => ({ id: ship.id, priority: ship.priority || 0, classPriority: ship.classPriority || 0, capacity: ship.capacity, size: ship.size, litres: wants[index].litres })) })
    const fill = tankers ? tankerFill() : fuelFillTruth.colonyFill({ stock: entry, reserve: 0, rate: RATE, wants })
    const served = entry > 0
    const rows = ships.map((ship, index) => {
      const arrive0 = ship.fuel - leg
      const got = fill.received.get(ship.id) || 0
      const depart1 = arrive0 + got
      const dry = depart1 < leg

      const arrive1 = Math.max(0, depart1 - leg)
      const needs0 = served ? leg : 2 * leg
      const need = (now, burn) => Math.max(0, Math.min(ship.capacity - now, burn - now))

      return { id: ship.id, name: ship.name, capacity: ship.capacity, start: ship.fuel, arrive0, got, want: wants[index].litres, depart1, dry, arrive1, req: [need(ship.fuel, needs0), need(arrive0, leg), need(arrive1, needs0)], shortfall: dry ? leg - depart1 : 0 }
    })
    const aheadNow = [...ahead]
    const legs = rows.flatMap((row) => [{ leg: 0, row, share: row.arrive0 / row.capacity, shortfall: 0, dry: false }]).concat(rows.map((row) => ({ leg: 1, row, share: row.arrive1 / row.capacity, shortfall: row.shortfall, dry: row.dry })))
    const limiting = legs.reduce((best, item) => (!best || item.share < best.share || (item.share === best.share && item.shortfall > best.shortfall) ? item : best), null)
    const dryShip = rows.filter((row) => row.dry).sort((a, b) => b.shortfall - a.shortfall)[0] || null
    const biggest = rows.reduce((best, row) => (row.got > (best ? best.got : 0) ? row : best), null)
    const back = rows.reduce((worst, row) => (!worst || row.arrive1 / row.capacity < worst.share ? { row, share: row.arrive1 / row.capacity } : worst), null)
    const total = fill.total
    const exhausted = entry <= 0

    left = tankers ? fill.residual.get(data.tanker.id) : fill.residual

    if (total > 0) {
      ahead.push({ fleet: fleet.name, litres: total })
    }

    return {
      id: fleet.id,
      name: fleet.name,
      position: position + 1,
      of: order.length,
      status: rows.some((row) => row.dry) ? 'range' : 'ok',
      ships: rows,
      limiting,
      dryShip,
      back,
      source: { kind: tankers ? 'tankers' : 'colony', stock, entry: Math.max(0, entry), ahead: aheadNow, served, reason: served ? null : stock > 0 || aheadNow.length ? 'taken-ahead' : 'stock-empty', received: total, residual: left, hours: fill.hours, bound: tankers ? 'at-least' : null, limiting: biggest ? biggest.name : null },
      exhausted,
    }
  })
}

// Run in the page: what the fleets table draws, each row read by the hooks the template carries.
const readTable = () => {
  const { visible, visibleText, hooked } = window.__screen
  const panel = document.querySelector('[data-fleet-panel]')
  const heads = [...panel.querySelectorAll('thead th')].map((head) => head.innerText.trim())
  const rows = [...panel.querySelectorAll('tbody > tr')].filter((row) => row.querySelector('[data-fleet-id]'))

  return {
    heads,
    foot: hooked(panel, 'data-fuel-foot'),
    rows: rows.map((row) => ({ id: Number(row.querySelector('[data-fleet-id]').getAttribute('data-fleet-id')), on: visible(row), name: hooked(row, 'data-fleet-name'), status: hooked(row, 'data-fleet-status'), note: hooked(row, 'data-fleet-note-text'), draw: hooked(row, 'data-fleet-draw'), back: hooked(row, 'data-fuel-return'), cells: Object.fromEntries(heads.map((head, index) => [head, row.children[index] ? visibleText(row.children[index]) : ''])) })),
  }
}

// Run in the page: what the one expanded row draws, the round trip, the fuel of each ship and the sources of each stop.
const readDetail = () => {
  const { visible, visibleText, hooked } = window.__screen
  const open = document.querySelector('[data-fleet-panel] tr.v-data-table__expanded__content')

  if (!open) {
    return null
  }

  const owner = open.previousElementSibling ? open.previousElementSibling.querySelector('[data-fleet-id]') : null

  return {
    fleet: owner ? Number(owner.getAttribute('data-fleet-id')) : null,
    cycle: hooked(open, 'data-cycle-value'),
    ships: [...open.querySelectorAll('[data-ledger-ship]')].map((row) => ({ ship: Number(row.getAttribute('data-ledger-ship')), on: visible(row), cells: [...row.querySelectorAll('[data-ledger-value]')].map((element) => ({ kind: element.getAttribute('data-ledger-value'), key: element.getAttribute('data-ledger-key'), text: visibleText(element), on: visible(element), cell: visibleText(element.closest('td')) })) })),
    stops: [...open.querySelectorAll('[data-service-stop]')].map((stop) => ({ key: stop.getAttribute('data-service-stop'), on: visible(stop), text: visibleText(stop), needs: [...stop.querySelectorAll('[data-service-need]')].map((need) => ({ ship: Number(need.getAttribute('data-service-need')), on: visible(need), text: visibleText(need.querySelector('[data-service-need-value]') || need) })), parts: [...stop.querySelectorAll('[data-service-source]')].map((part) => ({ on: visible(part), head: visibleText(part.firstElementChild), values: hooked(part, 'data-service-value'), tankers: hooked(part, 'data-service-tanker') })) })),
    limiting: hooked(open, 'data-ledger-limiting'),
  }
}

// Run in the page: the notes the optional reads behind the ledgers leave on the panel, each with the input it is for and whether it carries a Retry.
const readNotes = () => {
  const { visible, visibleText } = window.__screen

  return [...document.querySelectorAll('[data-fleet-panel] [data-fuel-note]')].map((note) => ({ input: note.getAttribute('data-fuel-input'), on: visible(note), text: visibleText(note), retry: Boolean(note.querySelector('button')) }))
}

// The page as a worker opens it: the game and the race picked, the run pushed, and the reads that follow finished.
const openPage = async (page, url, step) => {
  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })
  await installScreen(page)

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  await settled(page, { limit: TIMEOUT })
  step(`opening ${ROUTE}`)
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), ROUTE)
  await page.waitForFunction(pageLoading.arrived, ROUTE, { timeout: TIMEOUT })
  await page.waitForFunction(() => document.querySelector('[data-fleet-panel] [data-fleet-id]') !== null, null, { timeout: STAGE_TIMEOUT }).catch(() => {})
  step('waiting for the page to settle')
  await settled(page, { limit: TIMEOUT, loading: pageLoading })
  await page.evaluate(() => {
    window.__fleetVm = () => {
      let vm = document.querySelector('[data-fleet-panel]').__vue__

      while (vm && typeof vm.setFleets !== 'function') {
        vm = vm.$parent
      }

      return vm
    }
  })
  await page.waitForFunction(() => Boolean(window.__fleetVm().fuelReserveRead && window.__fleetVm().fuelReserveRead.ready), null, { timeout: STAGE_TIMEOUT }).catch(() => {})
  await settled(page, { limit: TIMEOUT, loading: pageLoading })
}

// The wait after a step: the screen has drawn what the step changed and the reads that follow it are in.
const settleAfter = (page) => settled(page, { limit: TIMEOUT, loading: pageLoading })

// The row of a fleet opened as a player does it: the table's expanded list emptied, then the fleet's name clicked.
const expandRow = async (page, id) => {
  await page.evaluate(() => {
    window.__fleetVm().fleetsExpanded = []
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.locator(`[data-fleet-panel] [data-fleet-name][data-fleet-id="${id}"]`).click({ timeout: TIMEOUT })
  await page.waitForFunction((fleet) => {
    const open = document.querySelector('[data-fleet-panel] tr.v-data-table__expanded__content')
    const owner = open && open.previousElementSibling ? open.previousElementSibling.querySelector('[data-fleet-id]') : null

    return Boolean(owner) && Number(owner.getAttribute('data-fleet-id')) === fleet
  }, id, { timeout: STAGE_TIMEOUT })
}

// The table and the expanded row of each fleet of `ids`.
const readView = async (page, ids) => {
  const details = {}

  for (const id of ids) {
    await expandRow(page, id)
    details[id] = await page.evaluate(readDetail)
  }

  return { table: await page.evaluate(readTable), details }
}

const pickFleets = async (page, ids) => {
  await page.evaluate((list) => window.__fleetVm().setFleets(list), ids)
  await settleAfter(page)
}

// The option "Take only what the run needs" set as a player does it, from the menu of the options.
const setRequired = async (page, on) => {
  if ((await page.evaluate(() => window.__fleetVm().fillRequired)) === on) {
    return
  }

  await page.locator('button[aria-label="Transport options"]').click({ timeout: TIMEOUT })
  await page.getByText('Take only what the run needs', { exact: true }).click({ timeout: TIMEOUT })
  await page.keyboard.press('Escape')
  await page.waitForFunction((want) => window.__fleetVm().fillRequired === want, on, { timeout: STAGE_TIMEOUT })
  await settleAfter(page)
}

// The table sorted by a header as a player does it: the header clicked, the rows read once the header says the sort is on.
const sortBy = async (page, label, state) => {
  await page.locator('[data-fleet-panel] thead th').filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`) }).first().click({ timeout: TIMEOUT })
  await page.waitForFunction((args) => [...document.querySelectorAll('[data-fleet-panel] thead th')].some((head) => head.innerText.trim() === args.label && head.getAttribute('aria-sort') === args.state), { label, state }, { timeout: STAGE_TIMEOUT })
  await settleAfter(page)

  return { label, state, table: await page.evaluate(readTable) }
}

const SORTS = [['Trips / yr', 'ascending'], ['Status', 'ascending'], ['Fleet', 'ascending'], ['Fleet', 'descending'], ['Draw', 'ascending'], ['Draw', 'descending']]

// The reads of the reserve records made to fail, as the reader's own record of failed reads says it.
const readerFailure = async (page) => {
  await page.evaluate(() => {
    const find = (node) => (node.$options.name === 'FuelReserveReader' ? node : node.$children.map(find).find(Boolean))
    const reader = find(window.__fleetVm())

    reader.loadErrors = { ...reader.loadErrors, reserveObjects: 'planted failure' }
  })
  await settleAfter(page)
}

// The planted failures of the tracked reads taken away, so that a stage starts clear of the one before it whether or not that stage's Retry did its work.
const liftPlanted = async (page) => {
  await page.evaluate(() => {
    const find = (node) => (node.$options.name === 'FuelReserveReader' ? node : node.$children.map(find).find(Boolean))
    const vm = window.__fleetVm()
    const reader = find(vm)

    reader.loadErrors = { ...reader.loadErrors, reserveObjects: null }
    vm.$set(vm.loadErrors, 'fuelSites', null)
  })
  await settleAfter(page)
}

// The read of the refuelling sites made to fail, as the page's own record of failed reads says it.
const sitesFailure = async (page) => {
  await page.evaluate(() => {
    const vm = window.__fleetVm()

    vm.$set(vm.loadErrors, 'fuelSites', 'planted failure')
  })
  await settleAfter(page)
}

// The records of the reserves made not to open, as the reader's own record of its repository says it.
const repositoryFailure = async (page) => {
  await page.evaluate(() => {
    const find = (node) => (node.$options.name === 'FuelReserveReader' ? node : node.$children.map(find).find(Boolean))
    const reader = find(window.__fleetVm())

    reader.reserveRecords = Object.freeze({ repository: null, error: 'planted failure' })
  })
  await settleAfter(page)
}

// The reader's repository made to refuse its records (the refusal the repository raises for a store it cannot read), for as long as `window.__refusal.on` holds: the cause of the failure, which `recordsAllowed` lifts.
const recordsRefused = async (page) => {
  await page.evaluate(() => {
    const find = (node) => (node.$options.name === 'FuelReserveReader' ? node : node.$children.map(find).find(Boolean))
    const reader = find(window.__fleetVm())
    const real = reader.reserveRecords.repository
    const refusal = { on: true }

    window.__refusal = refusal
    reader.reserveRecords = Object.freeze({
      repository: {
        list: (...args) => {
          if (refusal.on) {
            throw Object.assign(new Error('planted failure'), { name: 'RecordsRefused', code: 'planted' })
          }

          return real.list(...args)
        },
      },
      error: null,
    })
  })
  await settleAfter(page)
}

// The cause of the refusal lifted; the page reads nothing again until the player presses Retry.
const recordsAllowed = async (page) => {
  await page.evaluate(() => {
    window.__refusal.on = false
  })
}

// The Retry of the note of an input pressed as a player does it (nothing is pressed where the note carries none), then the wait for the reads it starts to be answered and the screen to have drawn them: whether the note is gone is what the read after it observes.
const retryNote = async (page, input) => {
  const button = page.locator(`[data-fleet-panel] [data-fuel-input="${input}"] button`)

  if (await button.count()) {
    await button.first().click({ timeout: TIMEOUT })
  }

  await settleAfter(page)
}

// The table of the view and the notes on the panel.
const readTableAndNotes = async (page) => ({ table: await page.evaluate(readTable), notes: await page.evaluate(readNotes) })

// One variant of the planted copy served and read in a browser: the stages of `wanted`, and the orders of the copy before and after.
const observeSession = async (variant, wanted) => {
  const file = ENV.world.files[variant]
  const before = await ordersIn(file)

  await ENV.server.useSave(file)

  const seen = await observe(ENV.chrome, async ({ page, step }) => {
    await openPage(page, ENV.server.url, step)
    const out = {}

    if (wanted.includes(variant)) {
      step(`reading the fleets of the ${variant} variant`)
      out[variant] = await readView(page, ALL_IDS)
    }

    if (wanted.includes('sorts')) {
      out.sorts = []

      for (const [label, state] of SORTS) {
        step(`sorting by ${label}, ${state}`)
        out.sorts.push(await sortBy(page, label, state))
      }
    }

    if (wanted.includes('unread')) {
      step('reading the fleets while the reserve records are not read')
      await readerFailure(page)
      out.unread = { ...(await readView(page, ALL_IDS)), notes: await page.evaluate(readNotes) }
      step('trying the reserve records again')
      await retryNote(page, 'reserves')
      out.retried = await readTableAndNotes(page)
      await liftPlanted(page)
      step('reading the fleets while the refuelling sites are not read')
      await sitesFailure(page)
      out.sitesUnread = await readTableAndNotes(page)
      step('trying the refuelling sites again')
      await retryNote(page, 'sites')
      out.sitesRetried = await readTableAndNotes(page)
      await liftPlanted(page)
      step('reading the fleets while the reserve records are refused')
      await recordsRefused(page)
      out.refusedUnread = await readTableAndNotes(page)
      step('lifting the refusal and trying the reserve records again')
      await recordsAllowed(page)
      await retryNote(page, 'reserves')
      out.refusedRetried = await readTableAndNotes(page)
      step('reading the fleets while the reserve records cannot be opened')
      await repositoryFailure(page)
      out.repoUnread = await readTableAndNotes(page)
      step('trying the reserve records again')
      await retryNote(page, 'reserves')
      out.repoRetried = await readTableAndNotes(page)
    }

    if (wanted.includes('picks')) {
      step('picking the fleets, then the other way round')
      await pickFleets(page, [FLEET.Zulu.id, FLEET.Yankee.id])
      out.picks = { ab: await readView(page, [FLEET.Zulu.id, FLEET.Yankee.id]) }
      await pickFleets(page, [FLEET.Yankee.id, FLEET.Zulu.id])
      out.picks.ba = await readView(page, [FLEET.Zulu.id, FLEET.Yankee.id])
    }

    if (wanted.includes('required')) {
      step('taking only what the run needs, then the full tanks again')
      await pickFleets(page, [FLEET.Zulu.id, FLEET.Yankee.id])
      await setRequired(page, true)
      out.required = { on: await readView(page, [FLEET.Zulu.id, FLEET.Yankee.id]) }
      await setRequired(page, false)
      out.required.off = await readView(page, [FLEET.Zulu.id, FLEET.Yankee.id])
    }

    return out
  })

  return { seen, orders: [before, await ordersIn(file)] }
}

// The variants whose sessions read any of `keys`.
const sessionsOf = (keys) => VARIANTS.filter((name) => SESSION_KEYS[name].some((key) => keys.includes(key)))

// The page read for `keys`: the sessions of the variants those keys need, merged. `{ value, unexpected }`, or `{ failed }` with the record of the session that did not get through.
const observeKeys = async (keys, label) => {
  const value = { orders: {} }
  const unexpected = []

  for (const variant of sessionsOf(keys)) {
    const { seen, orders } = await observeSession(variant, SESSION_KEYS[variant].filter((key) => keys.includes(key)))

    validate(seen, `${label} (${variant})`)

    if (unobserved(seen)) {
      return { failed: seen, variant }
    }

    Object.assign(value, seen.value)
    value.orders[variant] = orders
    unexpected.push(...seen.unexpected)
  }

  return { value, unexpected }
}

// ---------- what the checks read the screen by ----------

const oneOf = (entries) => {
  const on = entries.filter((entry) => entry.on)

  return on.length === 1 ? on[0] : null
}

const grouped = (number) => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '\'')
const litres = (value) => `${grouped(rounded(value))} L`
const asLitres = (text) => (typeof text === 'string' && text.endsWith(' L') ? readFigure(text.slice(0, -2), 'Tick') : null)
const STOP_KEYS = ['origin', 'destination', 'closing']
const figure = (value) => grouped(rounded(value))

// The figure written before each litre unit of a text ("5'000 L, 3 L left" gives "5'000" and "3"; a cell's elements are joined without a space, so a unit is a capital L after a space, whatever follows it). A sign written apart from its figure ("- 100 L") is kept with it, and so is any stray character, so a negative or a malformed figure shows and never reads as the figure alone; one opening bracket is allowed before a figure.
const litreFigures = (text) => [...String(text).matchAll(/(?:([-+\u2212]) )?(\S+) L/g)].map((found) => `${found[1] || ''}${found[2].replace(/^\(/, '')}`)

// The figures written before each percent sign of a text, each read whole (`readFigure`) with a sign written apart from it kept: a number, or null for a malformed one ("140%" is 140, "-40%" and "- 40%" are -40, "4o%" is null), never the figure of a part of the token.
const percentFigures = (text) => String(text).split(/\s+/).map((token, index, tokens) => [token, /^[-+\u2212]$/.test(tokens[index - 1] || '') ? tokens[index - 1] : '']).filter(([token]) => token.includes('%')).map(([token, sign]) => readFigure(`${sign}${token.replace(/^\(/, '').replace(/%[,.;:)]*$/, '')}`, 'Tick'))

const UNITS = { d: 86400, h: 3600, min: 60, s: 1, mo: 30.4 * 86400, y: 365 * 86400 }

// One written duration read strictly ("33.3 d", "20 min 43 s", "at least 1 h 2 min", "1 h or more"): its seconds and whether it is qualified as a lower bound. `bound` is the module's word table for a lower bound ({ before, after }): a qualifier is accepted only as the word the table has for its place, and any other word fails the read. Null where a token is neither an unsigned figure with its unit nor the table's word, or there is no figure.
const parseEnd = (text, bound) => {
  const tokens = String(text).trim().split(/\s+/)
  const lead = []
  const trail = []
  let seconds = 0
  let figures = 0

  for (let index = 0; index < tokens.length; index += 1) {
    if (/^\d+(\.\d+)?$/.test(tokens[index])) {
      if (trail.length || !Object.prototype.hasOwnProperty.call(UNITS, tokens[index + 1])) {
        return null
      }

      seconds += Number(tokens[index]) * UNITS[tokens[index + 1]]
      figures += 1
      index += 1
    } else if (/^[A-Za-z]+$/.test(tokens[index])) {
      (figures === 0 ? lead : trail).push(tokens[index])
    } else {
      return null
    }
  }

  const [before, after] = [lead.join(' '), trail.join(' ')]

  return figures && (!before || before === bound.before) && (!after || after === bound.after) && !(before && after) ? { seconds, qualified: Boolean(before || after) } : null
}

// A written duration read whole: one duration, or a range "a to b" of two plain ones (neither end carries a qualifier, the lower end not over the upper), of which the upper end is the value. `range` says which form was read. Null where any part of the text, an end of a range included, does not read.
const parseSpan = (text, bound) => {
  const ends = String(text).split(' to ').map((end) => parseEnd(end, bound))

  return ends.length > 2 || ends.includes(null) ? null : ends.length === 1 ? { ...ends[0], range: false } : ends.some((end) => end.qualified) || ends[0].seconds > ends[1].seconds ? null : { ...ends[1], range: true }
}

// The seconds of a written duration, null where it does not read or is a range in a role that takes one figure (`range` lets a role take a range).
const secondsOf = (text, bound, { range = false } = {}) => {
  const span = parseSpan(text, bound)

  return span && (range || !span.range) ? span.seconds : null
}

// The precision a written duration is drawn in, in seconds, from its last unit as the page's formatter writes it: to the second below an hour, to the minute with hours (the minutes are cut), to a tenth of a day, of a month of 30.4 days or of a year beyond. A range is read by its upper end.
const precisionOf = (text) => {
  const units = [...String(text).split(' to ').pop().matchAll(/\d (d|h|min|s|mo|y)(?=\s|$)/g)].map((found) => found[1])
  const unit = units[units.length - 1]

  return unit === 'y' ? 0.06 * 365 * 86400 : unit === 'mo' ? 0.06 * 30.4 * 86400 : unit === 'd' ? 0.06 * 86400 : units.includes('h') ? 60 : 1
}

// Whether a written duration is `seconds`, to the precision it is written in (`precisionOf`).
const sameSpan = (text, seconds, bound) => {
  const found = secondsOf(text, bound)

  return found !== null && Math.abs(found - seconds) <= precisionOf(text)
}

const rowOf = (view, id) => view.table.rows.find((row) => row.id === id) || null
const valueOf = (part, role) => {
  const entry = oneOf(part.values.filter((candidate) => candidate.role === role))

  return entry ? entry.text : null
}

const plansOf = (truth, key) => {
  if (key === 'picks.ab' || key === 'picks.ba') {
    return simulate(truth, 'half', key === 'picks.ab' ? [FLEET.Zulu, FLEET.Yankee] : [FLEET.Yankee, FLEET.Zulu])
  }

  if (key === 'required.on' || key === 'required.off') {
    return simulate(truth, 'half', [FLEET.Zulu, FLEET.Yankee], { required: key === 'required.on' })
  }

  return simulate(truth, key, DEFAULT_ORDER)
}

// The verdict of each fleet and the note of one that runs dry: the places of the leg, the ship that needs most and what it needs (and no other ship of the fleet), then why the destination does not serve or what it gives and after whom.
const statusProblems = (view, plans, names, words) => plans.flatMap((plan) => {
  const row = rowOf(view, plan.id)

  if (!row) {
    return [[plan.name, 'no row']]
  }

  const problems = []
  const label = oneOf(row.status)

  if (!label || label.text !== STATUS_WORDS[plan.status]) {
    problems.push([plan.name, 'status', label && label.text, STATUS_WORDS[plan.status]])
  }

  if (plan.status === 'range') {
    const note = oneOf(row.note)
    const { source } = plan
    const aheadNames = source.ahead.map((item) => item.fleet)
    const why = source.served ? [] : source.reason === 'taken-ahead' && aheadNames.length ? aheadNames : [words.reasons[source.reason]]
    const gave = source.served && source.received > 0 ? aheadNames : []
    const named = [names.destination, names.origin, plan.dryShip.name, ...why, ...gave]
    const wantedLitres = [figure(plan.dryShip.shortfall), ...(source.served && source.received > 0 ? [figure(source.received)] : [])]
    const missing = note ? [...named.filter((text) => !note.text.includes(text)), ...wantedLitres.filter((text) => !litreFigures(note.text).includes(text))] : named
    const extra = note ? plan.ships.filter((ship) => ship !== plan.dryShip && note.text.includes(ship.name)).map((ship) => ship.name) : []

    if (!note || missing.length || extra.length) {
      problems.push([plan.name, 'note', note && note.text, { missing, extra }])
    }
  }

  return problems
})

// The round trip of each fleet: the refuelling at the destination equal to the hours of the fill (none where nothing was given, none at the origin), the total the sum of the rows, and the trips a year the year over the total.
const cycleProblems = (view, plans, words) => plans.flatMap((plan) => {
  const detail = view.details[plan.id]

  if (!detail) {
    return [[plan.name, 'no expanded row']]
  }

  const problems = []
  const cycle = (key) => {
    const entry = oneOf(detail.cycle.filter((candidate) => candidate.role === key))

    return entry ? entry.text : null
  }
  const refuel = cycle('refuel-destination')
  const given = plan.source.served && plan.source.hours > 0

  if (given) {
    if (!sameSpan(refuel, plan.source.hours * 3600, words.bounds['at-least']) || (parseSpan(refuel, words.bounds['at-least']) || {}).qualified !== (plan.source.bound === 'at-least')) {
      problems.push([plan.name, 'refuelling at the destination', refuel, plan.source.hours * 3600, plan.source.bound])
    }
  } else if (refuel !== null) {
    problems.push([plan.name, 'refuelling drawn where nothing is given', refuel])
  }

  if (cycle('refuel-origin') !== null) {
    problems.push([plan.name, 'refuelling at the origin, which holds no fuel', cycle('refuel-origin')])
  }

  if (cycle('refuel-closing') !== null) {
    problems.push([plan.name, 'refuelling on return at the origin, which holds no fuel', cycle('refuel-closing')])
  }

  const bound = words.bounds['at-least']
  const keys = ['flight', 'handling', 'transit', 'wait']
  const parts = keys.map((key) => secondsOf(cycle(key), bound, { range: key === 'wait' }))
  const total = secondsOf(cycle('total'), bound, { range: true })
  const sum = parts.reduce((all, part) => all + part, 0) + (given ? secondsOf(refuel, bound) : 0)
  const slack = [...keys.map((key) => cycle(key)), cycle('total'), ...(given ? [refuel] : [])].reduce((all, text) => all + precisionOf(text), 0)
  const year = readFigure(cycle('year'), 'Tick')

  if (parts.includes(null) || total === null || Math.abs(total - sum) > slack) {
    problems.push([plan.name, 'total', cycle('total'), sum / 86400])
  } else if (year === null || !(Math.abs(year - 365 / (total / 86400)) <= 0.08)) {
    problems.push([plan.name, 'trips a year', cycle('year'), 365 / (total / 86400)])
  }

  const row = rowOf(view, plan.id)

  if (plan.status === 'ok' && (!row || row.cells['Trips / yr'] !== cycle('year'))) {
    problems.push([plan.name, 'the trips a year of the row and of the round trip differ', row && row.cells['Trips / yr'], cycle('year')])
  }

  return problems
})

// What one source says at a stop: its head, and the figures of `expected` ({ stock, reserve, ahead, entry, received, residual, hours, bound, served, permission, reason }); the head ends with the words of the permission, and of the reason where nothing is served.
const partProblems = (what, part, expected, words) => {
  const problems = []
  const wanted = { stock: litres(expected.stock), ahead: expected.ahead.length ? expected.ahead.map((item) => `${item.fleet} ${litres(item.litres)}`).join(', ') : 'None', available: litres(expected.entry) }

  if (expected.reserve !== undefined) {
    wanted.reserve = litres(expected.reserve)
  }

  if (expected.served) {
    wanted.received = litres(expected.received)
    wanted.residual = litres(expected.residual)
  }

  const permission = expected.served ? 'allowed' : expected.permission || 'blocked'
  const wantedHead = permission === 'allowed' ? words.verdicts.allowed : `${words.verdicts[permission]}: ${words.reasons[expected.reason]}`

  if (typeof part.head !== 'string' || !part.head.endsWith(`: ${wantedHead}`) || part.head.trim() !== part.head) {
    problems.push([what, 'verdict', part.head, wantedHead])
  }

  Object.entries(wanted).forEach(([role, text]) => {
    if (valueOf(part, role) !== text) {
      problems.push([what, role, valueOf(part, role), text])
    }
  })

  const hours = valueOf(part, 'hours')

  if (expected.served) {
    if (!sameSpan(hours, expected.hours * 3600, words.bounds['at-least']) || (parseSpan(hours, words.bounds['at-least']) || {}).qualified !== (expected.bound === 'at-least')) {
      problems.push([what, 'hours', hours, expected.hours * 3600, expected.bound])
    }
  } else if (hours !== null) {
    problems.push([what, 'hours drawn where nothing is given', hours])
  }

  const limit = valueOf(part, 'limiting')

  if (limit !== (expected.served ? expected.limiting : null)) {
    problems.push([what, 'the ship that receives most', limit, expected.served ? expected.limiting : null])
  }

  return problems
}

// The limiting ship of a fleet: the ship, the place of the leg, and its shortfall in litres or its share of the tank in per cent, the one figure of its role read whole beside the names (any other figure, malformed or not, fails it).
const limitProblems = (plan, limit, names) => {
  const { limiting } = plan
  const wantedNames = [limiting.row.name, limiting.leg === 0 ? names.destination : names.origin]
  const figures = limit ? (limiting.dry ? litreFigures(limit.text) : percentFigures(limit.text)) : []
  const wantedFigure = limiting.dry ? figure(limiting.shortfall) : rounded(limiting.share * 100)

  return !limit || wantedNames.some((text) => !limit.text.includes(text)) || figures.length !== 1 || figures[0] !== wantedFigure ? [[plan.name, 'the limiting ship, where it is and its shortfall or share', limit && limit.text, [...wantedNames, wantedFigure]]] : []
}

// The return of a fleet's row: the ship that returns with least and its share of the tank in per cent, the one figure of its role read whole.
const returnProblems = (plan, back) => {
  const wantedFigure = rounded(plan.back.share * 100)

  return plan.status === 'ok' && (!back || !back.text.includes(plan.back.row.name) || percentFigures(back.text).length !== 1 || percentFigures(back.text)[0] !== wantedFigure) ? [[plan.name, 'the return of the row', back && back.text, [plan.back.row.name, wantedFigure]]] : []
}

// Each ship's litres at every column of the ledger, the return, the sources at the origin and at the destination, the limiting ship and the return of the fleet.
const ledgerProblems = (view, plans, names, words) => plans.flatMap((plan) => {
  const detail = view.details[plan.id]

  if (!detail) {
    return [[plan.name, 'no expanded row']]
  }

  const problems = []

  plan.ships.forEach((ship) => {
    const row = detail.ships.find((candidate) => candidate.on && candidate.ship === ship.id)

    if (!row) {
      problems.push([plan.name, ship.name, 'no row'])

      return
    }

    const wanted = { start: ship.start, 'received-0': 0, 'departure-0': ship.start, 'arrival-0': ship.arrive0, 'received-1': ship.got, 'departure-1': ship.depart1, 'arrival-1': ship.arrive1 }

    Object.entries(wanted).forEach(([key, value]) => {
      const cell = row.cells.find((candidate) => candidate.on && candidate.key === key)

      if (!cell || asLitres(cell.text) !== rounded(value)) {
        problems.push([plan.name, ship.name, key, cell && cell.text, rounded(value)])
      }
    })

    STOP_KEYS.forEach((key, index) => {
      const stop = detail.stops.find((candidate) => candidate.on && candidate.key === key)
      const shown = stop ? stop.needs.filter((need) => need.on && need.ship === ship.id) : []

      if (index === 2 && plan.status !== 'ok') {
        if (stop) {
          problems.push([plan.name, ship.name, 'a closing visit of a run that stops short', key])
        }
      } else if (shown.length !== 1 || asLitres(shown[0].text) !== rounded(ship.req[index])) {
        problems.push([plan.name, ship.name, `the litres needed at the ${key}`, shown.map((need) => need.text), rounded(ship.req[index])])
      }
    })

    const last = row.cells.find((candidate) => candidate.on && candidate.key === 'arrival-1')
    const wantedFigures = (ship.dry ? [ship.arrive1, ship.shortfall] : [ship.arrive1]).map(figure)

    if (last && litreFigures(last.cell).join() !== wantedFigures.join()) {
      problems.push([plan.name, ship.name, 'the litres of the last arrival and the shortfall of a ship that runs dry', last.cell, wantedFigures])
    }

    const back = row.cells.find((candidate) => candidate.on && candidate.kind === 'return')
    const wantedBack = plan.status === 'ok' ? litres(ship.arrive1) : '—'

    if (!back || back.text !== wantedBack) {
      problems.push([plan.name, ship.name, 'the return', back && back.text, wantedBack])
    }
  })

  const destination = detail.stops.find((stop) => stop.on && stop.key === 'destination')
  const origin = detail.stops.find((stop) => stop.on && stop.key === 'origin')
  const kind = (stop, name) => (stop ? stop.parts.filter((part) => part.on && part.head.includes(words.kinds[name])) : [])
  const source = plan.source

  if (kind(origin, 'colony').length !== 1) {
    problems.push([plan.name, 'the colony at the origin is not one source', kind(origin, 'colony').length])
  } else {
    problems.push(...partProblems(`${plan.name} at the origin`, kind(origin, 'colony')[0], { stock: 0, reserve: 0, ahead: [], entry: 0, served: false, reason: 'stock-empty' }, words))
  }

  if (kind(destination, source.kind).length !== 1) {
    problems.push([plan.name, `the ${source.kind} at the destination is not one source`, kind(destination, source.kind).length])
  } else {
    problems.push(...partProblems(`${plan.name} at the destination`, kind(destination, source.kind)[0], { ...source, ...(source.kind === 'colony' ? { reserve: 0 } : {}) }, words))
  }

  problems.push(...limitProblems(plan, oneOf(detail.limiting), names))

  const row = rowOf(view, plan.id)

  problems.push(...returnProblems(plan, row ? oneOf(row.back) : null))

  return problems
})

// The tanker fleet at the destination: the part that gives, the line of the eligible tanker with what it gave from and had left, and the line of the one with no transfer system with its reason.
const tankerProblems = (view, plans, truth, words) => plans.flatMap((plan) => {
  const detail = view.details[plan.id]
  const data = truth.variants.tankers

  if (!detail) {
    return [[plan.name, 'no expanded row']]
  }

  const destination = detail.stops.find((stop) => stop.on && stop.key === 'destination')
  const parts = destination ? destination.parts.filter((part) => part.on && part.head.includes(words.kinds.tankers)) : []

  if (parts.length !== 1) {
    return [[plan.name, 'the tanker fleet is not one source', parts.length]]
  }

  const lines = parts[0].tankers.filter((line) => line.on).map((line) => line.text)
  const problems = []
  const lineOf = (name) => lines.filter((line) => line.includes(name))
  const [eligible, blocked] = [lineOf(data.tanker.name), lineOf(data.blocked.name)]
  const wantedFigures = (plan.source.served ? [plan.source.entry, plan.source.residual] : [plan.source.entry]).map(figure)

  if (eligible.length !== 1 || litreFigures(eligible[0]).join() !== wantedFigures.join()) {
    problems.push([plan.name, 'the eligible tanker: the litres it had at entry and has left', eligible, wantedFigures])
  }

  if (blocked.length !== 1 || !blocked[0].includes(words.reasons['no-system']) || litreFigures(blocked[0]).length) {
    problems.push([plan.name, 'the tanker with no transfer system: its reason and no litres', blocked, words.reasons['no-system']])
  }

  return problems
})

// The figures of a fleet's row, as a player reads them across the table.
const figuresOf = (row) => JSON.stringify({ status: row.status.map((entry) => entry.text), note: row.note.map((entry) => entry.text), draw: row.draw.map((entry) => entry.text), trips: row.cells['Trips / yr'], tons: row.cells['Tons / yr'], fuel: row.cells['Fuel / trip'], back: row.back.map((entry) => entry.text) })

// What the draw cells say: each fleet's position in the order and the count of the fleets, its tooltip left aside.
const drawProblems = (view, plans) => plans.flatMap((plan) => {
  const row = rowOf(view, plan.id)
  const draw = row ? oneOf(row.draw) : null

  return !draw || draw.text !== `${plan.position} of ${plan.of}` ? [[plan.name, 'the draw cell', draw && draw.text, `${plan.position} of ${plan.of}`]] : []
})

// What the reserve-unread view says: the verdict not known, no litre received and the reserve not read.
const unreadProblems = (view, plans) => plans.flatMap((plan) => {
  const row = rowOf(view, plan.id)
  const label = row ? oneOf(row.status) : null
  const detail = view.details[plan.id]
  const received = detail ? detail.ships.flatMap((ship) => ship.cells.filter((cell) => cell.on && cell.kind === 'received')) : []
  const problems = []

  if (!label || label.text !== STATUS_WORDS.unknown) {
    problems.push([plan.name, 'status', label && label.text, STATUS_WORDS.unknown])
  }

  if (!detail || received.some((cell) => asLitres(cell.text) !== 0 && cell.text !== '—')) {
    problems.push([plan.name, 'litres received while the reserves are not read', received.map((cell) => cell.text)])
  }

  return problems
})

// The verdict of each fleet in a view that shows only the table: the label `wanted(plan)` gives.
const labelsProblems = (what, view, plans, wanted) => plans.flatMap((plan) => {
  const row = rowOf(view, plan.id)
  const label = row ? oneOf(row.status) : null

  return !label || label.text !== wanted(plan) ? [[what, plan.name, 'status', label && label.text, wanted(plan)]] : []
})

// The notes of the optional reads: one per input in `inputs`, each with a Retry and the failure it was planted with, and none for any other input.
const notesProblems = (what, notes, inputs, failure) => {
  const shown = notes.filter((note) => note.on)
  const problems = inputs.flatMap((input) => {
    const found = shown.filter((note) => note.input === input)

    return found.length !== 1 || !found[0].retry || !found[0].text.includes(failure) ? [[what, input, found.map((note) => note.text), 'one note with a Retry naming the failure']] : []
  })

  return [...problems, ...shown.filter((note) => !inputs.includes(note.input)).map((note) => [what, 'a note of an input that is read', note.input, note.text])]
}

const verdict = (problems) => (problems.length === 0 ? true : short(problems.slice(0, 3)))

// ---------- the checks of the page ----------

const STATUS_KEYS = ['full', 'half', 'zero']

// The sessions a check reads: `needs` for the head, and `least` where a planted fault or a rewrite is judged by the check in fewer (a check judges the variants it is given).
const PAGE_CHECKS = [
  {
    id: 'status',
    name: 'the verdict of each fleet per variant (a full stock, a stock of one and a half fleets, none), and the note of a fleet that runs dry names the leg, the ship that needs most and why the destination does not serve',
    needs: STATUS_KEYS,
    least: ['half'],
    test: (o, t) => verdict(STATUS_KEYS.filter((key) => o[key]).flatMap((key) => {
      const plans = plansOf(t.truth, key)

      if (plans.map((plan) => plan.status).join() !== VERDICTS[key].join()) {
        throw new HarnessError(`the oracle reads the ${key} variant as ${plans.map((plan) => plan.status)}, not ${VERDICTS[key]} as the planted stock says`)
      }

      return statusProblems(o[key], plans, t.truth.variants[key], t.words)
    })),
  },
  {
    id: 'cycle',
    name: 'the refuelling at the destination in the round trip equals the hours of the fill (a colony and a tanker fleet, which only a lower bound is given for), and the total and the trips a year include it',
    needs: ['half', 'tankers'],
    least: ['half'],
    test: (o, t) => verdict(['half', 'tankers'].filter((key) => o[key]).flatMap((key) => cycleProblems(o[key], plansOf(t.truth, key), t.words))),
  },
  {
    id: 'ledger',
    name: 'each ship\'s litres at every leg and fill, what the return of the fleet and of each ship is, the sources at both stops with what they held, what the fleets ahead took, what the fleet received and what is left, the limiting ship',
    needs: ['short', 'half'],
    least: ['half'],
    test: (o, t) => verdict(['short', 'half'].filter((key) => o[key]).flatMap((key) => ledgerProblems(o[key], plansOf(t.truth, key), t.truth.variants[key], t.words))),
  },
  {
    id: 'tankers',
    name: 'the stationary tanker fleet at the destination: the eligible tanker gives, the one with no transfer system is listed with its reason, and the litres each fleet takes from the surplus and leaves in it',
    needs: ['tankers'],
    test: (o, t) => verdict([...tankerProblems(o.tankers, plansOf(t.truth, 'tankers'), t.truth, t.words), ...ledgerProblems(o.tankers, plansOf(t.truth, 'tankers'), t.truth.variants.tankers, t.words)]),
  },
  {
    id: 'unread',
    name: 'with the read of the reserve records or of the refuelling sites failed, no fleet is judged and no litre is drawn as received, one note with a Retry names the read that failed, and once the retry succeeds the verdicts are back and the note is gone',
    needs: ['unread'],
    test: (o, t) => {
      const half = plansOf(t.truth, 'half')

      return verdict([
        ...unreadProblems(o.unread, half),
        ...notesProblems('the reserve records not read', o.unread.notes, ['reserves'], 'planted failure'),
        ...labelsProblems('after the retry of the reserve records', o.retried, half, (plan) => STATUS_WORDS[plan.status]),
        ...notesProblems('after the retry of the reserve records', o.retried.notes, [], 'planted failure'),
        ...labelsProblems('the refuelling sites not read', o.sitesUnread, half, () => STATUS_WORDS.unknown),
        ...notesProblems('the refuelling sites not read', o.sitesUnread.notes, ['sites'], 'planted failure'),
        ...labelsProblems('after the retry of the refuelling sites', o.sitesRetried, half, (plan) => STATUS_WORDS[plan.status]),
        ...notesProblems('after the retry of the refuelling sites', o.sitesRetried.notes, [], 'planted failure'),
        ...labelsProblems('the reserve records not opened', o.repoUnread, half, () => STATUS_WORDS.unknown),
        ...notesProblems('the reserve records not opened', o.repoUnread.notes, ['reserves'], 'planted failure'),
        ...labelsProblems('after the retry of the reserve records not opened', o.repoRetried, half, (plan) => STATUS_WORDS[plan.status]),
        ...notesProblems('after the retry of the reserve records not opened', o.repoRetried.notes, [], 'planted failure'),
        ...labelsProblems('the reserve records refused', o.refusedUnread, half, () => STATUS_WORDS.unknown),
        ...notesProblems('the reserve records refused', o.refusedUnread.notes, ['reserves'], 'planted failure'),
        ...labelsProblems('after the cause of the refusal is lifted and the retry', o.refusedRetried, half, (plan) => STATUS_WORDS[plan.status]),
        ...notesProblems('after the cause of the refusal is lifted and the retry', o.refusedRetried.notes, [], 'planted failure'),
      ])
    },
  },
  {
    id: 'draw',
    name: 'the fleets draw on the stock in the order of the pick (the first picked fleet first, then the other way round) and by name with no pick, and each Draw cell is the position of its fleet whatever the sort',
    needs: ['half', 'picks', 'sorts'],
    test: (o, t) => verdict([
      ...drawProblems(o.half, plansOf(t.truth, 'half')),
      ...['picks.ab', 'picks.ba'].flatMap((key) => {
        const view = o.picks[key.slice(6)]
        const plans = plansOf(t.truth, key)

        return [...drawProblems(view, plans), ...statusProblems(view, plans, t.truth.variants.half, t.words), ...ledgerProblems(view, plans, t.truth.variants.half, t.words)]
      }),
      ...o.sorts.flatMap((sort) => drawProblems(sort, plansOf(t.truth, 'half')).map((problem) => [sort.label, sort.state, ...problem])),
    ]),
  },
  {
    id: 'sort-stable',
    name: 'every figure of every fleet row (verdict, note, fuel, trips, tons, draw) is the same after the table is sorted by trips, by verdict, by fleet either way and by draw either way, and the rows follow the sort',
    needs: ['half', 'sorts'],
    test: (o) => {
      const base = new Map(o.half.table.rows.map((row) => [row.id, figuresOf(row)]))
      const problems = []
      const names = (sort) => sort.table.rows.map((row) => oneOf(row.name).text)

      o.sorts.forEach((sort) => {
        if (sort.table.rows.length !== base.size) {
          problems.push([sort.label, sort.state, 'rows', sort.table.rows.length])
        }

        sort.table.rows.forEach((row) => {
          if (base.get(row.id) !== figuresOf(row)) {
            problems.push([sort.label, sort.state, row.id, figuresOf(row), base.get(row.id)])
          }
        })
      })

      const fleetUp = o.sorts.find((sort) => sort.label === 'Fleet' && sort.state === 'ascending')
      const fleetDown = o.sorts.find((sort) => sort.label === 'Fleet' && sort.state === 'descending')

      if (names(fleetUp).join() !== [...NAME_ORDER].join() || names(fleetDown).join() !== [...NAME_ORDER].reverse().join()) {
        problems.push(['the rows do not follow the sort by fleet', names(fleetUp), names(fleetDown)])
      }

      return verdict(problems)
    },
  },
  {
    id: 'fill-target',
    name: 'with "Take only what the run needs" on, each ship receives the litres the run needs and not a full tank and the second fleet then runs, and the foot changes with the option; off again, the full tanks and the second fleet out of range',
    needs: ['required'],
    test: (o, t) => {
      const problems = []

      ;['on', 'off'].forEach((state) => {
        const view = o.required[state]
        const plans = plansOf(t.truth, `required.${state}`)

        problems.push(...statusProblems(view, plans, t.truth.variants.half, t.words), ...ledgerProblems(view, plans, t.truth.variants.half, t.words))

        if (plans.map((plan) => plan.status).join() !== (state === 'on' ? 'ok,ok' : 'ok,range')) {
          throw new HarnessError(`the oracle reads the fill target ${state} as ${plans.map((plan) => plan.status)}`)
        }
      })

      const foots = ['on', 'off'].map((state) => o.required[state].table.foot.map((entry) => entry.text).join(' '))

      if (foots[0] === foots[1]) {
        problems.push(['the foot does not change with the option', foots[0].slice(-200)])
      }

      return verdict(problems)
    },
  },
  {
    id: 'orders',
    name: 'the orders of the planted copy are as many after every variant as before (a guard, not credited)',
    needs: [],
    test: (o) => verdict(Object.entries(o.orders).filter(([, counts]) => counts[0] !== counts[1]).map(([variant, counts]) => [variant, ...counts])),
  },
  {
    id: 'no-errors',
    name: 'the page raises no error',
    needs: [],
    test: (o) => verdict(o.unexpected.slice(0, 3)),
  },
]

// ---------- the variants of the page ----------

// The file a fault or a rewrite changes where it is not the page itself (`file`).
const READER = 'src/renderer/components/page/FuelReserveReader.vue'

// The module of the ledger as a file, for a rewrite of its word table.
const LEDGER_FILE = `src/renderer/utilities/${MODULE}.js`

/* eslint-disable no-template-curly-in-string */
// The hours of a part of a service as the ledger block writes them, which a fault and the rewrites change.
const HOURS_OF_PART = "`${part.bound === 'at-least' ? `${SERVICE_BOUNDS['at-least'].before} ` : ''}${this.span(part.hours * 3600)}`"

const PAGE_FAULTS = [
  { name: 'the verdict taken from the round trip, not the ledger', change: swap('const status = runs ? ledger.status : trip.status', 'const status = trip.status'), fails: ['status'] },
  { name: 'the refuelling rows are dropped from the round trip', change: swap('        ...refuelling,\n', ''), fails: ['cycle'] },
  { name: 'the trips a year of the round trip leave out the refuelling', change: swap('{ key: \'year\', label: \'Round trips a year\', text: known ? this.count(trip.trips, 1) : \'Not known\' }', '{ key: \'year\', label: \'Round trips a year\', text: known ? this.count(trip.tripSeconds > 0 ? 31536000 / (trip.tripSeconds - trip.serviceSeconds) : 0, 1) : \'Not known\' }'), fails: ['cycle'] },
  { name: 'the litres left after the fleet draw the stock', change: swap('{ key: \'residual\', label: \'Left after the fleet\', text: litres(part.residual) }', '{ key: \'residual\', label: \'Left after the fleet\', text: litres(part.stock) }'), fails: ['ledger'] },
  { name: 'the limiting ship is the first of the fleet', change: swap('`Limiting ship: ${limiting.name}, ', '`Limiting ship: ${ledger.ships[0].name}, '), fails: ['ledger'] },
  { name: 'a tanker that cannot serve is drawn as giving', change: swap('tanker.permission === \'allowed\' && tanker.residual !== null ? `gives from', 'tanker.permission !== \'unknown\' ? `gives from'), fails: ['tankers'] },
  { name: 'the records of the reserves are used whether or not they are read', change: swap('return this.fuelReserveRead && this.fuelReserveRead.ready ? this.fuelReserveRead.reader : null', 'return this.fuelReserveRead ? this.fuelReserveRead.reader : null'), fails: ['unread'] },
  { name: 'the fleets picked are drawn in the order of their IDs', change: swap('[fleetId, index]', '[fleetId, fleetId]'), fails: ['draw'] },
  { name: 'the draw position is the place of the row in the table', change: (text) => swap('item.draw`]="{ item }">', 'item.draw`]="{ item, index }">')(swap('{{ item.draw }} of {{ item.drawOf }}', '{{ index + 1 }} of {{ item.drawOf }}')(text)), fails: ['draw', 'sort-stable'] },
  { name: 'the draw order follows the sort of the table', change: swap('drawOrderOf(this.fleetGroups.filter((fleet) => !chosen.size || chosen.has(fleet.FleetID)), this.chosenFleetIds).map(', 'drawOrderOf(this.fleetGroups.filter((fleet) => !chosen.size || chosen.has(fleet.FleetID)), this.chosenFleetIds)[[].concat(this.fleetsTable.sortDesc)[0] ? \'reverse\' : \'slice\']().map('), fails: ['sort-stable'] },
  { name: 'the refuelling sites are used while their read is failed', change: swap('sites: this.loadErrors.fuelSites === null ? this.fuelSites || null : null', 'sites: this.fuelSites || null'), fails: ['unread'] },
  { name: 'the note of a failed read of the reserve records is not drawn', change: swap('if (reserves && reserves.failed) {', 'if (false && reserves && reserves.failed) {'), fails: ['unread'] },
  { name: 'the Retry of the refuelling sites reads another input', change: swap('this.$asyncComputed.fuelSites.update()', 'this.$asyncComputed.fleetShips.update()'), fails: ['unread'] },
  { name: 'the litres a ship needs to the next serving stop show its capacity', change: swap('text: litres(need.litres)', 'text: litres(ledger.ships.find((ship) => ship.id === need.id).capacity)'), fails: ['ledger'] },
  { name: 'the ship that receives most is the source', change: swap('text: part.limiting.name }', 'text: part.name }'), fails: ['ledger'] },
  { name: 'the lower bound of a fill written as an upper bound in the ledger block, a word outside the module\'s table', change: swap(HOURS_OF_PART, "`${part.bound === 'at-least' ? 'at most ' : ''}${this.span(part.hours * 3600)}`"), fails: ['tankers'] },
  { name: 'a word after the hours of the refuelling in the round trip', change: swap('${this.span(stop.hours * 3600)}` }))', '${this.span(stop.hours * 3600)} nonsense` }))'), fails: ['cycle'] },
  { name: 'the litres an eligible tanker gives from carry a minus sign', change: swap('gives from ${litres(tanker.entry)}, ${litres(tanker.residual)} left', 'gives from -${litres(tanker.entry)}, ${litres(tanker.residual)} left'), fails: ['tankers'] },
  { name: 'the Retry of the reserve records leaves out a repository that did not open', file: READER, change: swap('this.$asyncComputed.reserveRecords.update()', 'this.retryReserves()'), fails: ['unread'] },
  { name: 'the Retry of the reserve reads leaves out a read that failed', file: READER, change: swap('if (this.reserveFailedKeys.length) {', 'if (false) {'), fails: ['unread'] },
  { name: 'the Retry of the reserve records leaves out records that could not be read', file: READER, change: swap('this.reservesChanged()', 'void 0'), fails: ['unread'] },
  { name: 'a word before the lower end of a range of the round trip, drawn as a range whatever its ends', change: swap('(low === high ? this.span(low) : `${this.span(low)} to ${this.span(high)}`)', '`nonsense ${this.span(low)} to ${this.span(high)}`'), fails: ['cycle'] },
  { name: 'the hours of the fill of a colony drawn as a range from nothing in the ledger block, the upper end the right one', change: swap(HOURS_OF_PART, "`${part.bound === 'at-least' ? `${SERVICE_BOUNDS['at-least'].before} ` : '0 s to '}${this.span(part.hours * 3600)}`"), fails: ['ledger'] },
  { name: 'the share of the limiting ship drawn with a digit before it, a figure that contains the right one', change: swap('with ${this.count(limiting.share * 100)}%`', 'with 1${this.count(limiting.share * 100)}%`'), fails: ['ledger'] },
  { name: 'the return share of a row drawn with a digit before it', change: swap('returns with {{ count(item.returnShare * 100) }}%', 'returns with 1{{ count(item.returnShare * 100) }}%'), fails: ['ledger'] },
  { name: 'the trips a year of the round trip drawn in exponent form', change: swap("{ key: 'year', label: 'Round trips a year', text: known ? this.count(trip.trips, 1) : 'Not known' }", "{ key: 'year', label: 'Round trips a year', text: known ? trip.trips.toExponential(2) : 'Not known' }"), fails: ['cycle'] },
  { name: 'the foot says the option is on whatever its state', change: swap('return this.fillRequired ? \'Each ship takes only', 'return true ? \'Each ship takes only'), fails: ['fill-target'] },
  { name: 'the litres of a note drawn with a digit before them', change: swap('litres: (value) => `${this.count(value)} L`, hours:', 'litres: (value) => `1${this.count(value)} L`, hours:'), fails: ['status'] },
  { name: 'a source that can serve headed with the words of one that cannot', change: swap('verdict: allowed ? SERVICE_VERDICTS.allowed :', 'verdict: allowed ? SERVICE_VERDICTS.blocked :'), fails: ['ledger'] },
  { name: 'a source that cannot serve headed with the words of one that can', change: swap('`${SERVICE_VERDICTS[part.permission]}: ${reason}`', '`${SERVICE_VERDICTS.allowed}: ${reason}`'), fails: ['ledger'] },
]

// A rewrite is judged by the checks that read the part of the page it changes (`checks`, and the guards), in the fewest sessions they allow.
const PAGE_BENIGN = [
  { name: 'the verdict "can run" written as a negated test', checks: ['tankers', 'orders', 'no-errors'], change: swap('const works = status === \'ok\'\n      const timed = runs', 'const works = !(status !== \'ok\')\n      const timed = runs') },
  { name: 'the dry mark of a leg worded another way', checks: ['ledger', 'orders', 'no-errors'], change: swap('`runs dry, short by ${litres(leg.shortfall)}`', '`out of fuel, ${litres(leg.shortfall)} needed`') },
  { name: 'the lower bound of a fill written after the hours', checks: ['tankers', 'orders', 'no-errors'], change: swap(HOURS_OF_PART, "`${this.span(part.hours * 3600)}${part.bound === 'at-least' ? ` ${SERVICE_BOUNDS['at-least'].after}` : ''}`") },
  { name: 'the lower-bound wording of the module\'s word table changed, which the check reads from the module as served', checks: ['tankers', 'orders', 'no-errors'], file: LEDGER_FILE, table: true, change: swap("before: 'at least'", "before: 'no fewer than'") },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the run of the page ----------

let ENV = null
const cleanups = []

// The module's own tables of words as the checks read them: the reasons and kinds of a service and the words that mark an hours figure as a lower bound.
const wordsOf = (mod) => ({ reasons: { ...mod.SERVICE_REASONS }, verdicts: { ...mod.SERVICE_VERDICTS }, kinds: { ...mod.SERVICE_KINDS }, bounds: { ...mod.SERVICE_BOUNDS } })

// The tables of words of the module the page is served with: the module as it is, or for a rewrite of the table (`table`) the module as that rewrite changes it, loaded the way the page gets it.
const wordsFor = async (variant) => {
  if (!variant || !variant.table) {
    return ENV.words
  }

  const loaded = await loadUtilities([MODULE], { sources: { [MODULE]: variant.change(fs.readFileSync(path.join(root, variant.file), 'utf8')) } })

  return wordsOf(loaded[MODULE])
}

// A worker's setup for the page: the planted copies of the variants `sessions`, what each should read, the ledger's own tables of words, one page server over the first copy, warmed, and one Chromium.
const setUp = async (sessions) => {
  const { startPageServer } = require('./lib/page-server')
  const world = await plantWorld(sessions)

  cleanups.push(async () => fs.rmSync(world.folder, { recursive: true, force: true }))

  const loaded = await loadUtilities([MODULE])
  const env = { world, truth: await truthOf(world), words: wordsOf(loaded[MODULE]), original: fs.readFileSync(path.join(root, PAGE), 'utf8') }

  env.server = await startPageServer({ save: world.files[sessions[0]] })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/information'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// The page with `variant` ({ change }, null for the page as it is) served and read for `keys`.
const view = async (variant, keys, label) => {
  const file = variant && variant.file ? variant.file : PAGE

  if (variant) {
    ENV.server.replace(file, variant.change(file === PAGE ? ENV.original : fs.readFileSync(path.join(root, file), 'utf8')))
  }

  try {
    return await observeKeys(keys, label)
  } finally {
    if (variant) {
      ENV.server.replace(file, null)
    }
  }
}

// The results of the checks over the record of an observation: { id, name, ok, kind, threw, detail }. A record with no screen to judge stops the run for a fault or a rewrite, and fails every check of the head naming where it stopped.
const pageResults = async (seen, { strict, ids = null, keys, label, env = ENV }) => {
  const chosen = PAGE_CHECKS.filter(({ id }) => !ids || ids.includes(id))

  if (seen.failed) {
    if (strict) {
      throw new HarnessError(`${label} did not get through (${seen.variant}): ${seen.failed.error}`)
    }

    return chosen.map(({ id, name }) => ({ id, name, ok: false, kind: 'unobserved', threw: false, detail: String(seen.failed.error) }))
  }

  const absent = keys.filter((key) => !(key in seen.value))

  if (absent.length) {
    throw new HarnessError(`${label} was read without ${absent.join(', ')}, which its checks judge`)
  }

  const o = { ...seen.value, unexpected: seen.unexpected }
  const judge = (test) => () => {
    const result = test(o, env)

    if (result !== true) {
      assert.fail(result)
    }
  }

  return await runChecks(chosen.map(({ id, name, test }) => ({ id, name, run: judge(test) })))
}

// The keys the checks `ids` (all for null) read: for the head all they need, for a planted fault or a rewrite (`least`) the fewest their judgement holds in.
const neededBy = (ids, { least = false } = {}) => [...new Set(PAGE_CHECKS.filter(({ id }) => !ids || ids.includes(id)).flatMap((check) => (least && check.least) || check.needs))]

// The page as it is, read for the checks `ids` (all for null) in the sessions they need, and judged by them.
const pageHeadOf = (ids, label) => async () => {
  const results = await pageResults(await view(null, neededBy(ids), label), { strict: false, ids, keys: neededBy(ids), label })

  judged(results, label)
  results.forEach((result) => report(result.name, result.ok, result.detail))
}

const pageFault = (fault) => async () => {
  const results = await pageResults(await view(fault, neededBy(fault.fails, { least: true }), `the page with "${fault.name}"`), { strict: true, ids: fault.fails, keys: neededBy(fault.fails, { least: true }), label: `the page with the fault "${fault.name}"` })

  judged(results, fault.name)
  reportFault(fault, results)
}

// A rewrite must pass the checks that read the part of the page it changes (`checks`).
const pageRewrite = (rewrite) => async () => {
  const results = await pageResults(await view(rewrite, neededBy(rewrite.checks, { least: true }), `the page rewritten as "${rewrite.name}"`), { strict: true, ids: rewrite.checks, keys: neededBy(rewrite.checks, { least: true }), label: `the page rewritten as "${rewrite.name}"`, env: { ...ENV, words: await wordsFor(rewrite) } })

  judged(results, rewrite.name)
  reportRewrite(rewrite, results)
}

// ---------- the run ----------

let checks = 0
let failures = 0

const report = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n         ${detail || 'false'}`}`)
}

const reportFault = (fault, results) => {
  report(`fault caught: ${fault.name}`, caughtAll(results, { name: fault.name }), notCaught(results))

  if (DETAIL) {
    results.forEach((result) => console.log(`         ${result.id}: ${result.ok ? 'holds' : result.detail}`))
  }
}

const reportRewrite = (rewrite, results) => {
  const wrong = results.filter((result) => !result.ok).map((result) => `${result.id}: ${result.detail}`)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0, wrong.join('; '))
}

// The checks over the ledger as it is, or with `change` made to the source of `file` (the page of /information for `file` 'page'); `list` the checks and `ids` those that must fail.
const moduleResults = async (list, change, file, ids) => {
  const onPage = file === 'page'
  const page = fs.readFileSync(path.join(root, PAGE), 'utf8')
  const sources = change && !onPage ? { [file]: change(fs.readFileSync(path.join(root, `src/renderer/utilities/${file}.js`), 'utf8')) } : {}
  const loaded = await loadUtilities([MODULE, 'fleet-profile'], { sources })
  const mod = subjectModule({ ...loaded[MODULE], loadFleetShips: loaded['fleet-profile'].loadFleetShips }, 'module')

  return await runChecks(list.filter(({ id }) => !ids || ids.includes(id)), { mod, fp: loaded['fleet-profile'], page: change && onPage ? change(page) : page })
}

const headOf = (list, label) => async () => {
  const results = await moduleResults(list, null, MODULE, null)

  judged(results, label)
  results.forEach((result) => report(result.name, result.ok, result.detail))
}

const faultOf = (fault) => async () => {
  const results = await moduleResults(PURE_CHECKS, fault.change, fault.module || MODULE, fault.fails)

  judged(results, fault.name)
  reportFault(fault, results)
}

const rewriteOf = (rewrite) => async () => {
  const results = await moduleResults(PURE_CHECKS, rewrite.change, rewrite.module || MODULE, null)

  judged(results, rewrite.name)
  reportRewrite(rewrite, results)
}

// The deadlines, in seconds: a pure variant loads the modules and runs the cases, a real variant also reads a save, a page variant reads one session for each variant it needs (the head reads all five), and the setup plants the copies, starts and warms the page server.
const DEADLINES = { pure: 120, real: 300, page: 360, pageHead: 900, setup: 900 + 180 }
// The page fault that is read in one session alone, and the checks that head reads in that session alone: the control of the warm page server runs the one and then the other.
const WARM_CHECKS = ['tankers', 'orders', 'no-errors']
const CONTROL_FAULT = 'a tanker that cannot serve is drawn as giving'

const variantsOf = (mutating) => [
  { key: 'pure', name: 'the head: the ledger over constructed ships and sites', head: true, heading: 'The fuel ledger (utilities/fuel-ledger.js)', deadline: DEADLINES.pure, run: headOf(PURE_CHECKS, 'the module') },
  ...(mutating ? PURE_FAULTS.map((fault, index) => ({ key: `pure-fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the ledger', deadline: DEADLINES.pure, run: faultOf(fault) })) : []),
  ...(mutating ? PURE_BENIGN.map((rewrite, index) => ({ key: `pure-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the ledger that say the same thing', deadline: DEADLINES.pure, run: rewriteOf(rewrite) })) : []),
  { key: 'real', name: 'the head: the ledger over the saves', head: true, heading: '\nThe ledger over the saves, read-only', deadline: DEADLINES.real, run: headOf(REAL_CHECKS, 'the saves') },
  { key: 'page', name: 'the head: the Fleets sailing together panel as it is', head: true, heading: '\nThe Fleets sailing together panel of /information (scripts/lib/page-server.js over a planted copy of a save)', pool: 'suite', needs: VARIANTS, deadline: DEADLINES.pageHead, run: pageHeadOf(null, 'the page') },
  ...(mutating ? [{ key: 'page-warm', name: 'the head: the Fleets sailing together panel as it is, in the session of the tankers', head: true, heading: '\nthe page again in one session, for the control of the warm page server', pool: 'suite', needs: sessionsOf(neededBy(WARM_CHECKS)), deadline: DEADLINES.page, run: pageHeadOf(WARM_CHECKS, 'the page in the session of the tankers') }] : []),
  ...(mutating ? PAGE_FAULTS.map((fault, index) => ({ key: `page-fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the page', pool: 'suite', needs: sessionsOf(neededBy(fault.fails, { least: true })), deadline: DEADLINES.page, run: pageFault(fault) })) : []),
  ...(mutating ? PAGE_BENIGN.map((rewrite, index) => ({ key: `page-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the page that say the same thing', pool: 'suite', needs: sessionsOf(neededBy(rewrite.checks, { least: true })), deadline: DEADLINES.pageHead, run: pageRewrite(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVES.falryx, SAVES.egg, FALRYX],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      const needed = queue.flatMap((variant) => (variant.control ? [...variant.control.fault.needs, ...variant.control.head.needs] : variant.needs || []))

      if (needed.length) {
        ENV = await setUp(VARIANTS.filter((name) => needed.includes(name)))
      }
    },
    // A variant of the modules alone never touched the server: nothing to put back.
    afterEach: async (variant) => {
      if (ENV && ENV.server && !/^(pure|real)/.test(variant.key)) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      const problems = []

      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch((error) => problems.push(String(error && error.message ? error.message : error).split('\n')[0]))
      }

      if (problems.length) {
        throw new Error(`cleanups failed: ${problems.join(' | ')}`)
      }
    },
    control: mutating ? { fault: `page-fault:${PAGE_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'page-warm', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}

module.exports = { plantWorld, WORLD, FLEETS, NAMES, FALRYX, LEG_KM }
