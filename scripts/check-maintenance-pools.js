/*
  Checks the shared maintenance pools of the Logistics page (src/renderer/utilities/maintenance-pools.js, the locations of utilities/logistics.js and the drill-down of components/logistics/MaintenancePool.vue).

  Run: bun scripts/check-maintenance-pools.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  Two parts, each with a head, planted faults and rewrites that say the same thing (scripts/lib/suite-runner.js):
  - `pure`: the grouping of colonies and ships into locations by coordinates (a difference under 1 unit on both axes shares a location, 1 unit or more on either axis does not, whatever the system for a source and only the anchor's own system for a ship), the kinds of ship and what each is to a location (a module platform with no supply designation adds capacity and no shared stock, a commercial supply ship supplies and is not maintained, a ship in a military hangar and a commercial ship use no supplies), the capacity cut to whole tons per source, the assigned colony of a module ship, the figures of a ship, the order the maintenance step serves ships and draws stock (colonies by stock, fullest first and sorted again at every request, then supply ships fullest first only where a cargo shuttle bay allows, then the ship's own stock), the whole stock of a supply ship against its class minimum, the day a stock runs out, and the totals of locations that share a colony.
  - `page`: /logistics (Maintenance supplies) served by scripts/lib/page-server.js over a copy of a save in which ships and colonies of each kind have been planted by SQL, a row of the locations table opened in Chromium and its drill-down read as a player sees it, set against an oracle written here from the tables.
  Every planted fault must fail the checks it names by an assertion, and every rewrite must pass every check.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { runSuite } = require('./lib/suite-runner')
const { observe, validate, HarnessError, settled, installScreen, pairedBy, readFigure } = require('./lib/browser-observe')
const { assert, subjectModule, runChecks, judged, caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const POOLS_FILE = 'src/renderer/utilities/maintenance-pools.js'
const LOGISTICS_FILE = 'src/renderer/utilities/logistics.js'
const PAGE_FILE = 'src/renderer/pages/logistics.vue'
const POOL_FILE = 'src/renderer/components/logistics/MaintenancePool.vue'
const SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const IDS = { GameID: 138, RaceID: 785 }
const NAMES = { game: 'EggSample', race: 'EggSample' }
const TIMEOUT = 120000
const DETAIL = process.argv.includes('--detail')
// The page draws figures in groups of three with the apostrophe under the setting the checks start with.
const GROUPING = 'Tick'
const EPSILON = 0.06

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new Error(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

// ---------- the module, over constructed colonies and ships ----------

const SHIP = { ShipID: 1, ShipName: 'Ship', FleetID: 1, FleetName: 'Fleet', SystemID: 1, SystemName: 'Sol', OrbitBodyID: 1, Xcor: 0, Ycor: 0, AssignedPopulationID: 0, ShipClassID: 1, ClassName: 'Class', Size: 2, Cost: 4000, Commercial: 0, SupplyShip: 0, MinimumSupplies: 0, ClassSupplies: 0, MaintPriority: 5, CurrentMaintSupplies: 0, MaintenanceState: 0, LastOverhaul: 0, MothershipID: 0, CarrierCommercialHangar: null, Modules: 0, Bays: 0 }
const ship = (id, changes = {}) => ({ ...SHIP, ShipID: id, ShipName: `Ship ${id}`, FleetID: id, FleetName: `Fleet ${id}`, ...changes })
const colony = (id, changes = {}) => ({ PopulationID: id, PopName: `Colony ${id}`, SystemID: 1, Xcor: 0, Ycor: 0, MaintenanceFacilities: 1, MaintenanceStockpile: 0, Population: 1, ...changes })
const FULL_COLONY = { MSPProduction: 10, MaintProdStatus: 0, Mines: 0, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6, Efficiency: 1, CapacityModifier: 1, EconomicProdModifier: 1, MaintenanceCapacity: 10.9, WarningMSP: 0, SystemBodyID: 1 }
// A ship that asks 60 MSP a day at full coverage: a class cost of 365 x 4 x 60.
const DAILY_60 = 87600

const clusterOf = (m, colonies, ships = [], { capacityOf = () => 100, racial = 50 } = {}) => m.maintenanceClusters({ colonies, ships, capacityOf, racialCapacity: racial })
const poolOf = (m, colonies, ships) => clusterOf(m, colonies, ships).clusters[0]
const idsOf = (list, key = 'ShipID') => list.map((item) => item[key])
const sourcesOf = (result) => result.clusters.map((cluster) => cluster.sources.map((source) => `${source.kind === 'colony' ? 'c' : 'm'}${source.id}`).join('+'))
const usedOf = (result) => Object.fromEntries(result.providers.map((provider) => [`${provider.kind}${provider.id === null ? '' : provider.id}`, provider.used]))

const clustersCheck = {
  id: 'clusters',
  name: 'sources and ships are grouped by coordinates: under 1 unit on both axes shares a location, 1 unit or more on either axis does not, a source joins whatever the system and a ship only in the anchor\'s system, and the first source anchors with no chaining',
  run: ({ pools: m }) => {
    const shape = (colonies, ships = []) => sourcesOf(clusterOf(m, colonies, ships))

    assert.deepEqual(shape([colony(1), colony(2, { Xcor: 0.99 })]), ['c1+c2'], 'two colonies 0.99 apart on x share a location')
    assert.deepEqual(shape([colony(1), colony(2, { Xcor: 1 })]), ['c1', 'c2'], 'two colonies exactly 1 apart on x do not')
    assert.deepEqual(shape([colony(1), colony(2, { Ycor: 0.99 })]), ['c1+c2'], 'two colonies 0.99 apart on y share a location')
    assert.deepEqual(shape([colony(1), colony(2, { Ycor: 1 })]), ['c1', 'c2'], 'two colonies exactly 1 apart on y do not')
    assert.deepEqual(shape([colony(1), colony(2, { Xcor: 0.99, Ycor: 0.99 })]), ['c1+c2'], 'under 1 unit on both axes shares a location')
    assert.deepEqual(shape([colony(1), colony(2, { Xcor: 0.99, Ycor: 1 })]), ['c1', 'c2'], '1 unit on one axis separates them whatever the other axis says')
    assert.deepEqual(shape([colony(1), colony(2, { Xcor: -0.99 })]), ['c1+c2'], 'the difference is taken without its sign: -0.99 shares')
    assert.deepEqual(shape([colony(1), colony(2, { Xcor: -1 })]), ['c1', 'c2'], 'and -1 does not')
    assert.deepEqual(shape([colony(1), colony(2, { SystemID: 2 })]), ['c1+c2'], 'a source joins by coordinates, whatever its system')
    assert.deepEqual(shape([colony(1), colony(2, { Xcor: 0.6 }), colony(3, { Xcor: 1.2 })]), ['c1+c2', 'c3'], 'the first source anchors: a source within 1 unit of a member and over 1 unit from the anchor does not chain on')

    const ships = [ship(10, { Xcor: 0.99 }), ship(11, { Xcor: 1 }), ship(12, { SystemID: 2 }), ship(13, { Ycor: -0.99 }), ship(14, { Ycor: -1 })]
    const grouped = clusterOf(m, [colony(1)], ships)

    assert.deepEqual(idsOf(grouped.clusters[0].assigned), [10, 13], 'ships under 1 unit from the anchor in its system join, in different fleets')
    assert.deepEqual(idsOf(grouped.places.flatMap((place) => place.ships)), [11, 12, 14], 'a ship 1 unit away on either axis, and a ship at the same coordinates in another system, join no location')

    const kinds = clusterOf(m, [colony(1)], [
      ship(20, { Commercial: 1 }),
      ship(21, { MothershipID: 99, CarrierCommercialHangar: 0 }),
      ship(22, { MothershipID: 99, CarrierCommercialHangar: 1 }),
      ship(23, { Commercial: null }),
      ship(24, { SupplyShip: 1, Commercial: 1 }),
      ship(25, { SupplyShip: 1, Commercial: 0 }),
      ship(26, { SupplyShip: 1, Commercial: 1, MothershipID: 99, CarrierCommercialHangar: 0 }),
      ship(27, { SupplyShip: 0, Commercial: 1, Modules: 3, CurrentMaintSupplies: 7000 }),
    ])
    const pool = kinds.clusters[0]

    assert.deepEqual(idsOf(pool.assigned), [22, 23, 25], 'maintained: a ship in a commercial hangar, a ship of an unknown class, a supply ship that is not commercial')
    assert.deepEqual(idsOf(pool.supplyShips), [24, 25, 26], 'supply ships: the designation is tested before the class and the hangar, so a commercial one and one in a military hangar still supply')
    assert.deepEqual(idsOf(pool.moduleShips), [27], 'the module platform is a source')
    assert.equal(kinds.places.length, 0, 'a commercial ship and a ship in a military hangar are in no location and in no place')
    assert.equal(pool.sources.find((source) => source.kind === 'module').tons, 150, 'the platform adds its modules\' capacity: 3 modules of 50 t')
    assert.equal(pool.supplyShips.some((entry) => entry.ShipID === 27), false, 'a module platform with no supply designation adds no stock to the shared pool')

    const assigned = clusterOf(m, [colony(1), colony(2, { Xcor: 500 }), colony(5, { Xcor: 5000, MaintenanceFacilities: 0 }), colony(6, { Xcor: 6000, MaintenanceFacilities: 0 })], [
      ship(30, { Modules: 1, Commercial: 1, AssignedPopulationID: 2 }),
      ship(31, { Modules: 1, Commercial: 1, Xcor: 900, AssignedPopulationID: 2 }),
      ship(32, { Modules: 1, Commercial: 1, Xcor: 1500, AssignedPopulationID: 99 }),
      ship(33, { Modules: 1, Commercial: 1, Xcor: 2500, AssignedPopulationID: 6 }),
      ship(34, { Modules: 0, Commercial: 1, Xcor: 3500 }),
    ])

    assert.deepEqual(sourcesOf(assigned), ['c1+m30', 'c2', 'm31', 'm32', 'm33'], 'a ship with undamaged modules is a source and a ship with none is not')
    assert.deepEqual(assigned.clusters.map((cluster) => idsOf(cluster.colonies, 'PopulationID')), [[1, 2], [2], [2], [], [6]], 'the colony a module ship is assigned to supports its location wherever it is, and one colony supports several locations')
    assert.deepEqual(idsOf(assigned.clusters[0].located, 'PopulationID'), [1], 'only the colony at the location is located there')
    assert.deepEqual(assigned.clusters[3].missingColonies, [99], 'an assigned colony that is not the race\'s is named, never counted')
    assert.deepEqual(idsOf(assigned.places.flatMap((place) => place.colonies), 'PopulationID'), [5], 'a colony with no facilities that supports no location is a place of its own')

    const unplaced = clusterOf(m, [colony(1)], [ship(42, { Modules: 2, Commercial: 1, Xcor: null, Ycor: null })])

    assert.equal(unplaced.clusters.length, 2, 'a module ship with no position anchors a location of its own')
    assert.equal(unplaced.clusters[1].sources[0].tons, 100, 'with the capacity of its modules')
  },
}

const capacityCheck = {
  id: 'capacity',
  name: 'each source\'s capacity is cut to whole tons before the sources are added, a module platform adds its capacity, and an unknown figure leaves the capacity unknown',
  run: ({ pools: m }) => {
    const cut = poolOf(m, [colony(1, { tons: 10.9 }), colony(2, { tons: 10.9 })], [ship(40, { Modules: 3, Commercial: 1 })])
    const result = m.maintenanceClusters({ colonies: [colony(1, { tons: 10.9 }), colony(2, { tons: 10.9 })], ships: [ship(40, { Modules: 3, Commercial: 1 })], capacityOf: (item) => item.tons, racialCapacity: 50.7 })
    const sources = result.clusters[0].sources

    assert.equal(cut.sources.length, 3, 'two colonies and a module ship share the location')
    assert.deepEqual(sources.map((source) => source.tons), [10, 10, 152], 'a colony of 10.9 t counts 10 and 3 modules of 50.7 t count 152')
    assert.equal(sources.reduce((total, source) => total + source.tons, 0), 172, 'the whole tons add up to 172, not the 173 of the sum cut once')
    assert.equal(m.wholeTons(10.9), 10, 'the cut is a floor')
    assert.equal(m.wholeTons(2.9999999999999996), 3, 'a product just under a whole number keeps its ton')

    const unknown = m.maintenanceClusters({ colonies: [colony(1, { tons: null })], ships: [ship(41, { Modules: null, Commercial: 1 })], capacityOf: (item) => item.tons, racialCapacity: null })

    assert.deepEqual(unknown.clusters[0].sources.map((source) => source.tons), [null, null], 'a colony without a capacity figure and a ship whose modules are not in the save have no tons, never 0')
    assert.equal(m.maintenanceClusters({ colonies: [colony(1)], ships: [ship(42, { Modules: 2, Commercial: 1 })], capacityOf: () => 5, racialCapacity: null }).clusters[0].sources[1].tons, null, 'a race with no module capacity gives a module ship none')
  },
}

const figuresCheck = {
  id: 'figures',
  name: 'what a ship is to the maintenance step: its tonnage and yearly cost by state, the whole stock of a supply ship against its class minimum, and the counts of what the save does not give',
  run: ({ pools: m }) => {
    const f = (changes) => m.shipFigures(ship(1, changes))

    assert.deepEqual([f({}).MaintainedShips, f({}).MaintainedTons, f({}).AnnualMSP], [1, 100, 1000], 'an ordinary ship is maintained at its size x 50 t and a quarter of its cost a year')
    assert.equal(f({ MaintenanceState: 2 }).AnnualMSP, 4000, 'a ship in overhaul needs its whole cost')
    assert.deepEqual([f({ Commercial: 1 }).MaintainedShips, f({ Commercial: 1 }).MaintainedTons, f({ Commercial: 1 }).AnnualMSP], [0, 0, 0], 'a commercial ship needs no maintenance supplies')
    assert.equal(f({ MothershipID: 5, CarrierCommercialHangar: 0 }).MaintainedShips, 0, 'a ship in a military hangar needs none')
    assert.equal(f({ MothershipID: 5, CarrierCommercialHangar: 1 }).MaintainedShips, 1, 'a ship in a commercial hangar does')

    const supply = f({ SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 1500, MinimumSupplies: 1000 })

    assert.equal(supply.SupplyMSP, 1500, 'a supply ship\'s stock is the whole stock the maintenance step draws')
    assert.equal(supply.SupplyAboveMinimum, 500, 'and the part above its class minimum is kept apart')
    assert.deepEqual([f({ SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 50, MinimumSupplies: 400 }).SupplyMSP, f({ SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 50, MinimumSupplies: 400 }).SupplyAboveMinimum], [50, 0], 'a stock below its minimum is still drawn whole and has nothing above the minimum')
    assert.equal(f({ CurrentMaintSupplies: 7000 }).SupplyMSP, 0, 'a ship with no supply designation adds nothing to the supply stock')
    assert.deepEqual([f({ SupplyShip: 1, Commercial: 0 }).MaintainedShips, f({ SupplyShip: 1, Commercial: 0 }).SupplyUnknown], [1, 0], 'a supply ship of a military class is maintained too')
    assert.equal(f({ Commercial: null }).MaintainedUnknown, 1, 'an unknown class is counted unknown')
    assert.equal(f({ Size: null }).TonsUnknown, 1, 'a size that is not stored is counted')
    assert.equal(f({ Cost: null }).AnnualUnknown, 1, 'a cost that is not stored is counted')
    assert.equal(f({ SupplyShip: null }).SupplyUnknown, 1, 'an unknown designation is counted')
    assert.equal(f({ SupplyShip: 1, CurrentMaintSupplies: null, Commercial: 1 }).SupplyUnknown, 1, 'a designated ship with no stock is counted')
  },
}

const drawCheck = {
  id: 'draw',
  name: 'the maintenance step draws colonies by stock (fullest first, sorted again at every request), then supply ships by stock where a cargo shuttle bay allows, then the ship\'s own stock, serves ships in priority order, and reports the day a stock runs out',
  run: ({ pools: m }) => {
    // A location needs a source, so a pool with no stock of its own anchors on a colony holding none.
    const sim = (colonies, ships, { days = 1, coverage = 1 } = {}) => m.simulatePool(poolOf(m, colonies.length ? colonies : [colony(9)], ships), { days, coverage })
    const need = (id, changes = {}) => ship(id, { Cost: DAILY_60, ...changes })
    const richest = [colony(1, { MaintenanceStockpile: 100 }), colony(2, { MaintenanceStockpile: 90 })]

    assert.deepEqual(usedOf(sim(richest, [need(10)], { days: 2 })), { colony1: 60, colony2: 60, own: 0 }, 'colonies are sorted again at every request: 100 and 90 give 60 each over two days, not 100 and 20')
    assert.deepEqual(usedOf(sim(richest, [need(10)])), { colony1: 60, colony2: 0, own: 0 }, 'the fullest colony pays a request it covers whole')
    assert.deepEqual(usedOf(sim([colony(1, { MaintenanceStockpile: 40 }), colony(2, { MaintenanceStockpile: 30 })], [need(10)])), { colony1: 40, colony2: 20, own: 0 }, 'a colony that cannot cover the request is drained and the next one pays the rest')

    const supplyShips = [need(51, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 50, Bays: 1 }), need(52, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 80, Bays: 1 })]
    const fromSupply = sim([], [need(10), ...supplyShips])

    assert.deepEqual([usedOf(fromSupply).supply51, usedOf(fromSupply).supply52], [0, 60], 'with no colony stock the supply ship with the most stock pays a request it covers whole')
    assert.equal(fromSupply.ships.find((row) => row.ShipID === 10).fromSupply, 60, 'and the ship is shown drawing it')
    assert.equal(sim([], [need(10), need(51, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 80, Bays: 0 })]).totals.fromSupply, 0, 'a supply ship with no bay does not serve a ship with none')
    assert.equal(sim([], [need(10, { Bays: 1 }), need(51, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 80, Bays: 0 })]).totals.fromSupply, 60, 'a bay on the ship alone lets a supply ship serve it')
    assert.equal(sim([], [need(10, { Bays: 0 }), need(51, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 80, Bays: 1 })]).totals.fromSupply, 60, 'a bay on the supply ship alone does too')
    assert.equal(sim([], [need(10), need(51, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 80, MinimumSupplies: 30, Bays: 1 })]).totals.fromSupply, 60, 'a supply ship\'s whole stock is drawn: its class minimum holds nothing back from the maintenance step')

    const own = sim([colony(1, { MaintenanceStockpile: 40 })], [need(10, { CurrentMaintSupplies: 100 })])

    assert.deepEqual([own.ships[0].fromColonies, own.ships[0].fromOwn], [40, 20], 'the ship\'s own stock is drawn last and only for what the others leave')
    assert.deepEqual(usedOf(own).own, 20, 'and the own-stock provider shows it')

    const short = sim([], [need(10, { CurrentMaintSupplies: 30 })])

    assert.deepEqual([short.ships[0].fromOwn, short.ships[0].shortfall, short.ships[0].full, short.ships[0].support], [30, 30, false, 0.5], 'a stock that cannot cover a request leaves a shortfall and a support under 1')

    const itself = sim([], [need(10, { SupplyShip: 1, Commercial: 0, CurrentMaintSupplies: 100, Bays: 1 })])

    assert.deepEqual([itself.ships[0].fromSupply, itself.ships[0].fromOwn], [60, 0], 'the supply list includes the recipient itself')
    assert.equal(sim(richest, [need(10)], { coverage: 0.5 }).totals.fromColonies, 30, 'a coverage of one half asks half of the need')
    assert.equal(sim([colony(1, { MaintenanceStockpile: 1000 })], [need(10, { MaintenanceState: 2 })]).totals.fromColonies, 240, 'a ship in overhaul asks its whole cost, 4 times the daily upkeep')

    const dry = sim([colony(1, { MaintenanceStockpile: 120 })], [need(10)], { days: 3 })

    assert.equal(dry.providers.find((provider) => provider.kind === 'colony').depletedDay, 2, 'a colony of 120 under a daily request of 60 is empty on day 2')
    assert.equal(dry.totals.short, 1, 'and the ship is short on day 3')
    assert.equal(dry.providers.find((provider) => provider.kind === 'colony').left, 0, 'with nothing left')

    assert.equal(sim([colony(1, { MaintenanceStockpile: 100 })], [need(10, { Cost: null })]).available, false, 'a ship with no cost leaves the draw unavailable')
    assert.equal(sim([colony(1, { MaintenanceStockpile: null })], [need(10)]).available, false, 'a colony with no stock does too')
    assert.equal(sim([colony(1, { MaintenanceStockpile: 100 })], [need(10, { Bays: null }), need(51, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 5, Bays: 1 })]).available, false, 'and so does a ship whose bays are not known while a supply ship could serve it')
    assert.equal(sim([colony(1, { MaintenanceStockpile: 100 })], [need(10)], { coverage: null }).available, false, 'and a coverage that is not known')
    assert.equal(sim([colony(1, { MaintenanceStockpile: 100 })], [need(10), need(51, { SupplyShip: null, Commercial: 1, CurrentMaintSupplies: 100, Bays: 1 })]).available, false, 'and so does a candidate supply ship whose designation is not known')

    const order = m.serviceOrder([ship(1, { MaintPriority: 9 }), ship(2, { MaintPriority: 5, LastOverhaul: 50 }), ship(3, { MaintPriority: 5, MaintenanceState: 2, LastOverhaul: 90 }), ship(4, { MaintPriority: 5, LastOverhaul: 10 })])

    assert.deepEqual(idsOf(order), [3, 4, 2, 1], 'ships are served by class priority (lowest first), overhaul before upkeep, then the oldest clock')

    const served = sim([colony(1, { MaintenanceStockpile: 60 })], [need(1, { MaintPriority: 9 }), need(2, { MaintPriority: 5 })])

    assert.deepEqual(served.ships.map((row) => [row.ShipID, row.fromColonies]), [[2, 60], [1, 0]], 'when stock covers one request the ship of the lower priority number gets it')
  },
}

const locationsCheck = {
  id: 'locations',
  name: 'a location\'s figures reconcile to its providers: capacity is the whole tons of its sources, the economic modifier multiplies the coverage, the supply stock is the whole stock of the supply ships and a platform adds none, and a colony shared by locations counts once in the totals',
  run: ({ pools: m, logistics: l }) => {
    const colonies = [{ ...colony(1, { MaintenanceStockpile: 200 }), ...FULL_COLONY }]
    const ships = [
      ship(70, { Size: 2, Cost: 4000 }),
      ship(71, { Size: 2, Cost: 4000 }),
      ship(72, { Size: 2, Cost: 4000 }),
      ship(73, { Size: 2, Cost: 4000 }),
      ship(80, { SupplyShip: 1, Commercial: 1, CurrentMaintSupplies: 1500, MinimumSupplies: 1000, Bays: 1 }),
      ship(81, { SupplyShip: 0, Commercial: 1, Modules: 3, CurrentMaintSupplies: 7000 }),
    ]
    const at = (economicModifier) => l.maintenanceLocations({ colonies, ships, modifierOf: () => 1, maintenanceCapacity: 50.7, economicModifier })[0]
    const whole = at(1)

    assert.equal(whole.capacity, 162, 'the colony\'s 10.9 t count 10 and the platform\'s 3 modules of 50.7 t count 152')
    assert.equal(whole.tons, 400, 'four ships of 100 t')
    assert.equal(whole.rate, 162 / 400, 'the coverage is the capacity over the tonnage')
    assert.equal(at(0.5).rate, 162 * 0.5 / 400, 'the economic modifier multiplies the coverage and not the capacity')
    assert.equal(at(0.5).capacity, 162, 'the capacity is as it was')
    assert.equal(at(0.5).economicModifier, 0.5, 'and the row says which modifier it used')
    assert.equal(whole.supply, 1500, 'the supply stock is the whole stock of the supply ship')
    assert.equal(whole.supplyAbove, 500, 'with the part above its minimum apart')
    assert.equal(whole.stock, 200, 'the colony stock is its own')

    const run = m.simulatePool(whole.pool, { days: 1, coverage: whole.rate })
    const held = run.providers.filter((provider) => provider.kind !== 'own').reduce((total, provider) => total + provider.start, 0)

    assert.equal(held, whole.stock + whole.supply, 'the providers of the pool hold what the row says it holds')
    assert.equal(run.providers.some((provider) => provider.kind === 'supply' && provider.id === 81), false, 'and the platform is not one of them')

    const shared = l.maintenanceLocations({
      colonies,
      ships: [ship(90, { Modules: 1, Commercial: 1, Xcor: 5000, AssignedPopulationID: 1 }), ship(91, { Modules: 1, Commercial: 1, Xcor: 9000, AssignedPopulationID: 1 })],
      modifierOf: () => 1,
      maintenanceCapacity: 50,
      economicModifier: 1,
    })

    assert.deepEqual(shared.map((row) => row.stock), [200, 200, 200], 'a colony that supports three locations is in the stock of each')
    assert.equal(l.maintenanceSupplyTotals(shared, () => 1).stock, 200, 'and once in the total')
    assert.equal(l.maintenanceSupplyTotals(shared, () => 1).supply, 0, 'with no supply ship')

    const twice = l.maintenanceSupplyTotals([whole, whole], () => 1)

    assert.equal(twice.supply, 1500, 'a supply ship listed by two locations counts once')

    const place = l.maintenanceLocations({ colonies: [{ ...colony(1), ...FULL_COLONY, MaintenanceFacilities: 0 }], ships: [ship(95)], modifierOf: () => 1, maintenanceCapacity: 50, economicModifier: 1 })

    assert.deepEqual([place[0].pool, place[0].capacity, place[0].tons], [null, 0, 100], 'a colony with no facilities is a place with no pool and no capacity, and the ship at it has no maintenance')

    const across = l.maintenanceLocations({ colonies: [{ ...colony(1), ...FULL_COLONY }], ships: [ship(96, { SystemID: 2, Modules: 1, Commercial: 0, SupplyShip: 1, CurrentMaintSupplies: 200, Bays: 1 })], modifierOf: () => 1, maintenanceCapacity: 50, economicModifier: 1 }).find((row) => row.key === 'pool-colony-1')

    assert.deepEqual([across.tons, across.supply, across.required, across.pool.assigned.length, across.pool.supplyShips.length], [0, 0, 0, 0, 0], 'a module ship that joins a location as a source by coordinates and lies in another system is no maintained ship and no supply provider of it, and the figures of the row agree with its pool')
  },
}

const PURE_CHECKS = [clustersCheck, capacityCheck, figuresCheck, drawCheck, locationsCheck]

/* eslint-disable no-template-curly-in-string */
const PURE_FAULTS = [
  { name: 'the grouping is inclusive at 1 unit on the x axis', file: POOLS_FILE, module: 'maintenance-pools', change: swap('Math.abs(anchor.Xcor - item.Xcor) < CLUSTER_UNITS', 'Math.abs(anchor.Xcor - item.Xcor) <= CLUSTER_UNITS'), fails: ['clusters'] },
  { name: 'the grouping looks at the x axis only', file: POOLS_FILE, module: 'maintenance-pools', change: swap(' && Math.abs(anchor.Ycor - item.Ycor) < CLUSTER_UNITS', ''), fails: ['clusters'] },
  { name: 'the grouping needs both axes within 2 units', file: POOLS_FILE, module: 'maintenance-pools', change: swap('const CLUSTER_UNITS = 1', 'const CLUSTER_UNITS = 2'), fails: ['clusters'] },
  { name: 'a source joins a location only in its own system', file: POOLS_FILE, module: 'maintenance-pools', change: swap('clusters.find((cluster) => withinUnits(cluster, at)) || open(', 'clusters.find((cluster) => cluster.SystemID === at.SystemID && withinUnits(cluster, at)) || open('), fails: ['clusters'] },
  { name: 'a ship joins a location in any system', file: POOLS_FILE, module: 'maintenance-pools', change: swap('candidate.SystemID === ship.SystemID && withinUnits(candidate, ship)', 'withinUnits(candidate, ship)'), fails: ['clusters'] },
  { name: 'the colony a module ship is assigned to is left out', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (Number(ship.AssignedPopulationID) > 0) {', 'if (Number(ship.AssignedPopulationID) < 0) {'), fails: ['clusters'] },
  { name: 'a module platform with no designation holds supply stock', file: POOLS_FILE, module: 'maintenance-pools', change: swap('SupplyMSP: designated === true && stockKnown', 'SupplyMSP: designated !== null && stockKnown'), fails: ['figures'] },
  { name: 'every maintained ship joins the supply list of its location', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (figures.designated !== false) {', 'if (true) {'), fails: ['clusters', 'draw'] },
  { name: 'a ship in a military hangar is maintained', file: POOLS_FILE, module: 'maintenance-pools', change: swap('const carried = Number(ship.MothershipID) > 0 &&', 'const carried = false && Number(ship.MothershipID) > 0 &&'), fails: ['clusters', 'figures'] },
  { name: 'a commercial ship is maintained', file: POOLS_FILE, module: 'maintenance-pools', change: swap('!commercial && !carried', '!carried'), fails: ['clusters', 'figures'] },
  { name: 'a module platform adds no capacity', file: POOLS_FILE, module: 'maintenance-pools', change: swap('ships.filter((ship) => ship.Modules === null || Number(ship.Modules) > 0)', 'ships.filter((ship) => (ship.Modules === null || Number(ship.Modules) > 0) && Number(ship.SupplyShip) === 1)'), fails: ['clusters', 'capacity', 'locations'] },
  { name: 'the capacity of a source is not cut to whole tons', file: POOLS_FILE, module: 'maintenance-pools', change: swap('tons: tons === null ? null : wholeTons(tons) })', 'tons })'), fails: ['capacity', 'locations'] },
  { name: 'the cut rounds up', file: POOLS_FILE, module: 'maintenance-pools', change: swap('export const wholeTons = (value) => Math.floor(value + 1e-9)', 'export const wholeTons = (value) => Math.ceil(value)'), fails: ['capacity', 'locations'] },
  { name: 'the stock of a supply ship is taken above its minimum', file: POOLS_FILE, module: 'maintenance-pools', change: swap('SupplyMSP: designated === true && stockKnown ? Math.max(0, ship.CurrentMaintSupplies) : 0', 'SupplyMSP: designated === true && stockKnown ? Math.max(0, ship.CurrentMaintSupplies - ship.MinimumSupplies) : 0'), fails: ['figures', 'locations'] },
  { name: 'a supply ship is drawn above its minimum only', file: POOLS_FILE, module: 'maintenance-pools', change: swap('start: ship.CurrentMaintSupplies, stock: ship.CurrentMaintSupplies, used: 0', 'start: Math.max(0, ship.CurrentMaintSupplies - ship.MinimumSupplies), stock: Math.max(0, ship.CurrentMaintSupplies - ship.MinimumSupplies), used: 0'), fails: ['draw'] },
  { name: 'the colonies are not sorted again at every request', file: POOLS_FILE, module: 'maintenance-pools', change: swap('colonies.sort((a, b) => b.stock - a.stock)', 'colonies.length'), fails: ['draw'] },
  { name: 'the supply ships are drawn emptiest first', file: POOLS_FILE, module: 'maintenance-pools', change: swap('supply.sort((a, b) => b.stock - a.stock)', 'supply.sort((a, b) => a.stock - b.stock)'), fails: ['draw'] },
  { name: 'a supply ship serves a ship whatever the bays', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (bayless(ship) && bayless(donor.ship)) {', 'if (false) {'), fails: ['draw'] },
  { name: 'a supply ship serves a ship only when both have a bay', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (bayless(ship) && bayless(donor.ship)) {', 'if (bayless(ship) || bayless(donor.ship)) {'), fails: ['draw'] },
  { name: 'a ship never draws its own stock', file: POOLS_FILE, module: 'maintenance-pools', change: swap('const source = owner.own', 'const source = { stock: 0, used: 0, start: 0, depletedDay: null }'), fails: ['draw'] },
  { name: 'a ship in overhaul asks a quarter of its cost', file: POOLS_FILE, module: 'maintenance-pools', change: swap('const dailyNeed = (ship) => (ship.MaintenanceState === OVERHAUL_STATE ? ship.Cost : ship.Cost * ORDINARY_SHARE) / DAYS_PER_YEAR', 'const dailyNeed = (ship) => (ship.Cost * ORDINARY_SHARE) / DAYS_PER_YEAR'), fails: ['draw'] },
  { name: 'the coverage is left out of the request', file: POOLS_FILE, module: 'maintenance-pools', change: swap('const request = full * coverage', 'const request = full'), fails: ['draw'] },
  { name: 'ships are served in the order of their ids', file: POOLS_FILE, module: 'maintenance-pools', change: swap('return last(a.MaintPriority) - last(b.MaintPriority) ||', 'return'), fails: ['draw'] },
  { name: 'the oldest clock is served last', file: POOLS_FILE, module: 'maintenance-pools', change: swap('last(a.LastOverhaul) - last(b.LastOverhaul)', 'last(b.LastOverhaul) - last(a.LastOverhaul)'), fails: ['draw'] },
  { name: 'the day a stock runs out is the day after', file: POOLS_FILE, module: 'maintenance-pools', change: swap('provider.depletedDay = day', 'provider.depletedDay = day + 1'), fails: ['draw'] },
  { name: 'the economic modifier multiplies the capacity and not the coverage', file: LOGISTICS_FILE, module: 'logistics', change: swap('capacity * economicModifier / tons', 'capacity / tons'), fails: ['locations'] },
  { name: 'the totals add a shared colony once for each location', file: LOGISTICS_FILE, module: 'logistics', change: swap('.map((colony) => [colony.PopulationID, colony])).values()]', '.map((colony, index) => [index, colony])).values()]'), fails: ['locations'] },
  { name: 'the supply stock of a location is its stock above the minimums', file: LOGISTICS_FILE, module: 'logistics', change: swap('const supply = columnTotal(STOCK_RULE, supplyRows, \'SupplyMSP\'', 'const supply = columnTotal(STOCK_RULE, supplyRows, \'SupplyAboveMinimum\''), fails: ['locations'] },
  { name: 'a module source in another system counts as a maintained ship and supply provider of the location', file: LOGISTICS_FILE, module: 'logistics', change: swap('const rows = (location.pool ? [...new Set([...location.pool.assigned, ...location.pool.supplyShips])] : location.ships).map', 'const rows = location.ships.map'), fails: ['locations'] },
  { name: 'a candidate supply ship of unknown designation is taken for eligible', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (pool.supplyShips.some((ship) => ship.SupplyShip === null || ship.SupplyShip === undefined)) {', 'if (false) {'), fails: ['draw'] },
]
/* eslint-enable no-template-curly-in-string */

const PURE_BENIGN = [
  { name: 'the condition that decides a supply ship parenthesised', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (figures.designated !== false) {', 'if ((figures.designated !== false)) {') },
  { name: 'the bay test written with the operands turned about', file: POOLS_FILE, module: 'maintenance-pools', change: swap('if (bayless(ship) && bayless(donor.ship)) {', 'if (bayless(donor.ship) && bayless(ship)) {') },
  { name: 'the first-source test of the grouping written as a negated comparison', file: POOLS_FILE, module: 'maintenance-pools', change: swap('Math.abs(anchor.Xcor - item.Xcor) < CLUSTER_UNITS', '!(Math.abs(anchor.Xcor - item.Xcor) >= CLUSTER_UNITS)') },
  { name: 'the coverage of a location written with the operands turned about', file: LOGISTICS_FILE, module: 'logistics', change: swap('capacity * economicModifier / tons', 'economicModifier * capacity / tons') },
]

// ---------- the page, in a browser ----------

const open = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(raw)))
})
const run = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, function (error) { return error ? reject(error) : resolve(this.lastID) }))
const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
const close = (raw) => new Promise((resolve) => raw.close(resolve))

const FACILITIES = '(select sum(d.MaintenanceValue * i.Amount) from FCT_PopulationInstallations i inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = i.PlanetaryInstallationID where i.PopID = p.PopulationID and i.Amount > 0)'
const DROP_BAYS = 'and ComponentID not in (select SDComponentID from FCT_ShipDesignComponents where ComponentTypeID = 14)'

// A class cloned from the save's own, under a new id, with `changes` set and the cargo shuttle bays kept or dropped.
const cloneClass = (source, id, name, changes, dropBays) => [
  'drop table if exists temp.VIR_Clone',
  `create temp table VIR_Clone as select * from FCT_ShipClass where ShipClassID = ${source}`,
  `update temp.VIR_Clone set ShipClassID = ${id}, ClassName = '${name}', ${changes.join(', ')}`,
  'insert into FCT_ShipClass select * from temp.VIR_Clone',
  'drop table temp.VIR_Clone',
  `insert into FCT_ClassComponent (GameID, ClassID, ComponentID, NumComponent, ChanceToHit, ElectronicCTH) select GameID, ${id}, ComponentID, NumComponent, ChanceToHit, ElectronicCTH from FCT_ClassComponent where ClassID = ${source} ${dropBays ? DROP_BAYS : ''}`,
]

// A coordinate 1 unit or more from `value` and one under 1 unit from it, as the doubles the save stores them.
const beyond = (value) => {
  let next = value + 1

  while (Math.abs(next - value) < 1) {
    next = next + Number.EPSILON * Math.max(1, Math.abs(next))
  }

  return next
}
const inside = (value) => value + 0.99

// The ships and colonies planted, by label: a location of colonies (C1, C2, C3) with ordinary ships (class W, 2 x 50 t, a yearly cost of 1,000 MSP), supply ships with and without a cargo shuttle bay, a module ship that is a supply ship and one that is a platform. `where`: a ship's place, `stock`: the stock it holds.
const plan = async (raw) => {
  const q = (sql) => all(raw, sql)
  const first = async (sql) => (await q(sql))[0]
  const candidates = await q(`select p.PopulationID as id, p.SystemID as sys, b.Xcor as x, b.Ycor as y from FCT_Population p inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = ${IDS.GameID} and p.RaceID = ${IDS.RaceID} and coalesce(${FACILITIES}, 0) > 0 and p.Efficiency > 0.5 and p.UnrestPoints = 0 and not exists (select 1 from FCT_Population o inner join FCT_SystemBody ob on ob.SystemBodyID = o.SystemBodyID where o.PopulationID <> p.PopulationID and abs(ob.Xcor - b.Xcor) < 2 and abs(ob.Ycor - b.Ycor) < 2) and not exists (select 1 from FCT_Fleet f inner join FCT_Ship s on s.FleetID = f.FleetID inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where (f.AssignedPopulationID = p.PopulationID or (f.SystemID = p.SystemID and abs(f.Xcor - b.Xcor) < 2 and abs(f.Ycor - b.Ycor) < 2)) and c.MaintModules > 0) order by p.PopulationID`)
  const picked = []

  for (const candidate of candidates) {
    if (picked.length < 3 && !picked.some((other) => other.sys === candidate.sys)) {
      picked.push(candidate)
    }
  }

  if (picked.length < 3) {
    throw new HarnessError('the save has no three quiet colonies with maintenance facilities in three systems to plant ships at')
  }

  const [c1, c2, c3] = picked
  // A facility colony of a fourth system that is made to lie at the coordinates of C1 (a larger one, with a later id, so it joins the location of C1 as a source but is not its anchor), and a colony of a fifth system that loses its maintenance facilities and gets a module platform and a ship beside it.
  const remote = candidates.find((candidate) => candidate.id > c1.id && !picked.some((other) => other.sys === candidate.sys))
  const lone = candidates.find((candidate) => candidate !== remote && remote && candidate.sys !== remote.sys && !picked.some((other) => other.sys === candidate.sys))

  if (!remote || !lone) {
    throw new HarnessError('the save has no two more quiet colonies with maintenance facilities in two more systems (the first with an id above that of the first colony)')
  }

  // The race's own fleets already at a chosen colony are moved a million units off, so each location holds only what is planted.
  for (const at of [...picked, remote, lone]) {
    await run(raw, `update FCT_Fleet set Xcor = Xcor + 1000000, Ycor = Ycor + 1000000 where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID} and SystemID = ${at.sys} and abs(Xcor - ${at.x}) < 2 and abs(Ycor - ${at.y}) < 2`)
  }

  const classId = async (name) => (await first(`select ShipClassID as id from FCT_ShipClass where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID} and ClassName = '${name}'`)).id
  const bonk = await classId('Bonk')
  const well = await classId('Well')
  const shed = await classId('Shed01-0.5k')
  const { top } = await first('select max(ShipClassID) as top from FCT_ShipClass')
  const classes = { W: top + 1, K: top + 2, C: top + 3, S1: top + 4, S2: top + 5, M: top + 6, P: top + 7 }
  const ordinary = ['Size = 2', 'Cost = 4000', 'SupplyShip = 0', 'MinimumSupplies = 0', 'MaintModules = 0', 'MaintPriority = 5']
  const statements = [
    `update FCT_Race set EconomicProdModifier = 1 where RaceID = ${IDS.RaceID}`,
    ...cloneClass(bonk, classes.W, 'Planted ordinary', [...ordinary, 'Commercial = 0', 'CommercialHangar = 1'], true),
    ...cloneClass(bonk, classes.K, 'Planted carrier', [...ordinary, 'Commercial = 0', 'CommercialHangar = 0'], true),
    ...cloneClass(bonk, classes.C, 'Planted commercial', [...ordinary, 'Commercial = 1', 'CommercialHangar = 1'], true),
    ...cloneClass(well, classes.S1, 'Planted supply with bay', ['SupplyShip = 1', 'Commercial = 1', 'MinimumSupplies = 400'], false),
    ...cloneClass(well, classes.S2, 'Planted supply without bay', ['SupplyShip = 1', 'Commercial = 1', 'MinimumSupplies = 500'], true),
    ...cloneClass(shed, classes.M, 'Planted module supply ship', ['SupplyShip = 1', 'Commercial = 1', 'MinimumSupplies = 100'], false),
    ...cloneClass(shed, classes.P, 'Planted module platform', ['SupplyShip = 0', 'Commercial = 1'], false),
    `update FCT_Population set MaintenanceStockpile = 5000 where PopulationID = ${c1.id}`,
    `update FCT_Population set MaintenanceStockpile = 1500 where PopulationID = ${c2.id}`,
    `update FCT_Population set MaintenanceStockpile = 0 where PopulationID = ${c3.id}`,
    `update FCT_SystemBody set Xcor = ${c1.x}, Ycor = ${c1.y} where SystemBodyID = (select SystemBodyID from FCT_Population where PopulationID = ${remote.id})`,
    `update FCT_Population set Population = 99999999, MaintenanceStockpile = 0 where PopulationID = ${remote.id}`,
    `update FCT_PopulationInstallations set Amount = 0 where PopID = ${lone.id} and PlanetaryInstallationID in (select PlanetaryInstallationID from DIM_PlanetaryInstallation where MaintenanceValue > 0)`,
    `update FCT_Population set MaintenanceStockpile = 700 where PopulationID = ${lone.id}`,
  ]

  for (const statement of statements) {
    await run(raw, statement)
  }

  const template = await first(`select s.ShipID as ship, s.FleetID as fleet from FCT_Ship s inner join FCT_Fleet f on f.FleetID = s.FleetID where s.GameID = ${IDS.GameID} and s.RaceID = ${IDS.RaceID} and s.ShippingLineID = 0 order by s.ShipID`)
  const copyColumns = async (table, key) => (await q(`pragma table_info(${table})`)).map((column) => column.name).filter((name) => name !== key).join(', ')
  const fleetColumns = await copyColumns('FCT_Fleet', 'FleetID')
  const shipColumns = await copyColumns('FCT_Ship', 'ShipID')
  const ships = {}
  const fleets = {}
  // A ship in a fleet of its own at a place (or in a fleet already made), with the stock it holds and its state.
  const plant = async (label, { cls, sys, x, y, assigned = 0, stock = 0, carrier = null, inFleet = null }) => {
    let fleet = inFleet === null ? null : fleets[inFleet]

    if (fleet === null) {
      fleet = await run(raw, `insert into FCT_Fleet (${fleetColumns}) select ${fleetColumns} from FCT_Fleet where FleetID = ${template.fleet}`)
      await run(raw, `update FCT_Fleet set FleetName = 'Planted ${label}', SystemID = ${sys}, Xcor = ${x}, Ycor = ${y}, OrbitBodyID = 0, AssignedPopulationID = ${assigned}, RaceID = ${IDS.RaceID}, GameID = ${IDS.GameID} where FleetID = ${fleet}`)
      fleets[label] = fleet
    }

    const id = await run(raw, `insert into FCT_Ship (${shipColumns}) select ${shipColumns} from FCT_Ship where ShipID = ${template.ship}`)

    await run(raw, `update FCT_Ship set FleetID = ${fleet}, ShipName = 'Planted ${label}', ShipClassID = ${classes[cls]}, CurrentMaintSupplies = ${stock}, MaintenanceState = 0, LastOverhaul = 0, MothershipID = ${carrier === null ? 0 : ships[carrier]}, ShippingLineID = 0, RaceID = ${IDS.RaceID}, GameID = ${IDS.GameID} where ShipID = ${id}`)
    ships[label] = id
    fleets[label] = fleets[label] || fleet
  }
  const here = (c) => ({ sys: c.sys, x: c.x, y: c.y })

  await plant('a1', { cls: 'W', ...here(c1) })
  await plant('a2', { cls: 'W', sys: c1.sys, x: inside(c1.x), y: c1.y })
  await plant('a3', { cls: 'W', sys: c1.sys, x: beyond(c1.x), y: c1.y })
  await plant('a4', { cls: 'W', sys: c1.sys, x: c1.x, y: beyond(c1.y) })
  await plant('a5', { cls: 'W', sys: c1.sys, x: c1.x, y: inside(c1.y) })
  await plant('a6', { cls: 'W', sys: c2.sys, x: c1.x, y: c1.y })
  await plant('k', { cls: 'K', ...here(c1) })
  await plant('h1', { cls: 'W', ...here(c1), carrier: 'k', inFleet: 'k' })
  await plant('cm', { cls: 'C', ...here(c1) })
  await plant('s1a', { cls: 'S1', ...here(c1), stock: 3000 })
  await plant('s2a', { cls: 'S2', ...here(c1), stock: 2000 })
  await plant('s4', { cls: 'S1', ...here(c1), stock: 50 })
  await plant('w1', { cls: 'W', ...here(c2) })
  await plant('w2', { cls: 'W', ...here(c2) })
  await plant('w3', { cls: 'W', ...here(c2), stock: 100 })
  await plant('s1b', { cls: 'S1', ...here(c2), stock: 1000 })
  await plant('s2b', { cls: 'S2', ...here(c2), stock: 800 })
  await plant('w4', { cls: 'W', ...here(c3) })
  await plant('w5', { cls: 'W', ...here(c3) })
  await plant('m1', { cls: 'M', ...here(c3), assigned: c1.id, stock: 150000 })
  await plant('p1', { cls: 'P', ...here(c3), stock: 7777 })
  await plant('p2', { cls: 'P', ...here(lone) })
  await plant('w6', { cls: 'W', ...here(lone) })

  return { colonies: { C1: c1.id, C2: c2.id, C3: c3.id, C4: remote.id, C5: lone.id }, ships, classes }
}

// The page's own reading of the planted copy, from the tables with SQL written here: what each location should be, drawn from the rules and not from the module's grouping.
const truthOf = async (raw, planted) => {
  const race = await all(raw, `select MaintenanceCapacity as per, EconomicProdModifier as modifier from FCT_Race where RaceID = ${IDS.RaceID}`)
  const colonies = await all(raw, `select p.PopulationID as id, p.PopName as name, p.SystemID as sys, b.Xcor as x, b.Ycor as y, p.MaintenanceStockpile as stock, p.Efficiency as eff, p.UnrestPoints as unrest, coalesce(b.RadiationLevel, 0) as radiation, coalesce(s.ProductionMod, 1) as political, coalesce(${FACILITIES}, 0) as facilities from FCT_Population p inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID left join DIM_PopPoliticalStatus s on s.StatusID = p.PoliticalStatus where p.GameID = ${IDS.GameID} and p.RaceID = ${IDS.RaceID}`)
  const parts = (type) => `coalesce((select sum(cc.NumComponent) from FCT_ClassComponent cc inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where cc.ClassID = c.ShipClassID and d.ComponentTypeID = ${type}), 0)`
  const ships = await all(raw, `select s.ShipID as id, s.ShipName as name, f.FleetName as fleetName, f.SystemID as sys, f.Xcor as x, f.Ycor as y, f.AssignedPopulationID as assigned, c.ClassName as className, c.Size as size, c.Cost as cost, c.Commercial as commercial, c.SupplyShip as supply, c.MinimumSupplies as minimum, c.MaintPriority as priority, s.CurrentMaintSupplies as stock, s.MaintenanceState as state, s.MothershipID as carrier, (select c2.CommercialHangar from FCT_Ship s2 inner join FCT_ShipClass c2 on c2.ShipClassID = s2.ShipClassID where s2.ShipID = s.MothershipID) as hangar, ${parts(48)} as modules, ${parts(14)} as bays from FCT_Ship s inner join FCT_Fleet f on f.FleetID = s.FleetID inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.GameID = ${IDS.GameID} and s.RaceID = ${IDS.RaceID} and s.ShippingLineID = 0`)
  const near = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1
  const tonsOfColony = (c) => Math.floor(c.facilities * race[0].per * c.eff * Math.max(0, Math.min(1, 1 - c.radiation / 10000)) * Math.max(0, Math.min(1, 1 - c.unrest / 100)) * c.political + 1e-9)
  const designated = (s) => s.supply === 1
  const maintained = (s) => (designated(s) ? s.commercial === 0 : s.commercial === 0 && !(s.carrier > 0 && s.hangar === 0))
  const groups = []

  for (const source of [...colonies.filter((c) => c.facilities > 0).map((c) => ({ kind: 'colony', item: c })), ...ships.filter((s) => s.modules > 0).sort((a, b) => a.id - b.id).map((s) => ({ kind: 'module', item: s }))]) {
    const group = groups.find((candidate) => near(candidate.at, source.item))

    if (group) {
      group.sources.push(source)
    } else {
      groups.push({ at: source.item, sys: source.item.sys, sources: [source] })
    }
  }

  const byId = (id) => colonies.find((c) => c.id === id)
  const locations = groups.map((group) => {
    const members = ships.filter((s) => s.sys === group.sys && near(group.at, s) && (designated(s) || maintained(s)))
    const assignedShips = members.filter(maintained)
    const supplyShips = members.filter(designated)
    const located = group.sources.filter((source) => source.kind === 'colony').map((source) => source.item)
    const supporting = [...located]

    group.sources.filter((source) => source.kind === 'module' && source.item.assigned > 0 && byId(source.item.assigned)).forEach((source) => {
      if (!supporting.includes(byId(source.item.assigned))) {
        supporting.push(byId(source.item.assigned))
      }
    })

    const tons = assignedShips.reduce((total, s) => total + s.size * 50, 0)
    const capacity = group.sources.reduce((total, source) => total + (source.kind === 'colony' ? tonsOfColony(source.item) : Math.floor(source.item.modules * race[0].per + 1e-9)), 0)
    const byStock = (a, b) => b.stock - a.stock || a.id - b.id

    return {
      key: group.sources[0].kind === 'colony' ? `pool-colony-${group.sources[0].item.id}` : `pool-ship-${group.sources[0].item.id}`,
      sys: group.sys,
      x: group.at.x,
      y: group.at.y,
      sources: group.sources.map((source) => ({ key: `${source.kind}-${source.item.id}`, name: source.item.name, tons: source.kind === 'colony' ? tonsOfColony(source.item) : Math.floor(source.item.modules * race[0].per + 1e-9) })),
      capacity,
      tons,
      modifier: race[0].modifier,
      coverage: tons > 0 ? Math.min(1, capacity * race[0].modifier / tons) : 1,
      colonies: supporting.slice().sort(byStock).map((c) => ({ key: `colony-${c.id}`, name: c.name, stock: c.stock, located: located.includes(c) })),
      supply: supplyShips.slice().sort(byStock).map((s) => ({ key: `supply-${s.id}`, name: s.name, stock: s.stock, minimum: s.minimum, bays: s.bays > 0 })),
      ships: assignedShips.map((s) => ({ id: s.id, name: s.name, tons: s.size * 50, annual: (s.state === 2 ? s.cost : s.cost / 4), priority: s.priority, overhaul: s.state === 2, stock: s.stock, bays: s.bays > 0 })),
      platforms: group.sources.filter((source) => source.kind === 'module' && !designated(source.item)).map((source) => source.item.name),
      ownStock: assignedShips.filter((s) => !designated(s)).reduce((total, s) => total + s.stock, 0),
    }
  })
  const placed = new Set(groups.flatMap((group) => ships.filter((s) => s.sys === group.sys && near(group.at, s)).map((s) => s.id)))
  const places = Object.entries(planted.ships).filter(([label, id]) => ['a3', 'a4', 'a6'].includes(label) && !placed.has(id)).map(([label, id]) => ({ key: `place-ship-${id}`, label }))

  const surveyName = async (sys) => (await all(raw, `select Name as name from FCT_RaceSysSurvey where SystemID = ${sys} and RaceID = ${IDS.RaceID}`))[0].name
  // What the location row shows of a pool anchored at a colony: the colony's name and the name of the colony's own system.
  const identity = Object.fromEntries(await Promise.all(Object.entries(planted.colonies).map(async ([label, id]) => [label, { id, name: byId(id).name, system: await surveyName(byId(id).sys) }])))
  const lone = byId(planted.colonies.C5)
  const beside = locations.find((location) => location.sys === lone.sys && Math.abs(location.x - lone.x) < 1 && Math.abs(location.y - lone.y) < 1)
  // A colony with no facilities beside a module platform of another pool: it supports no location, so it is a place of its own.
  const standalone = { key: `place-colony-${lone.id}`, name: lone.name, facilities: lone.facilities, supports: locations.some((location) => location.colonies.some((colony) => colony.key === `colony-${lone.id}`)), poolKey: beside ? beside.key : null, poolSources: beside ? beside.sources.map((source) => source.key) : [] }

  return { locations, places, identity, standalone }
}

// A copy of the save in a folder of its own with the planted colonies' stock and ships, and the oracle of what the page shows.
const saveCopy = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-maintenance-pools-'))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await open(file)

  try {
    const planted = await plan(raw)

    return { folder, file, planted, truth: await truthOf(raw, planted) }
  } finally {
    await close(raw)
  }
}

// What the planted locations' draws are over a year, worked out by hand from the plan: every ordinary ship asks 1,000 MSP a year at full coverage.
// L1 (colony C1, stock 5,000): four maintained ships ask 4,000, all paid by the colony. L2 (colony C2, stock 1,500; a supply ship with a bay holding 1,000, one without a bay holding 800 that no ship can use; one ship holding 100 of its own): three ships ask 3,000 and the colony, the bay ship and the one ship's own stock give 1,500 + 1,000 + 100. L3 (colony C3 holding none, colony C1 assigned elsewhere): two ships ask 2,000, paid by the assigned colony.
const draws = (planted) => ({
  L1: { colonies: 4000, supply: 0, own: 0, short: 0, providers: { [`colony-${planted.colonies.C1}`]: 4000, [`colony-${planted.colonies.C4}`]: 0, [`supply-${planted.ships.s1a}`]: 0, [`supply-${planted.ships.s2a}`]: 0, [`supply-${planted.ships.s4}`]: 0 } },
  L2: { colonies: 1500, supply: 1000, own: 100, short: 3, providers: { [`colony-${planted.colonies.C2}`]: 1500, [`supply-${planted.ships.s1b}`]: 1000, [`supply-${planted.ships.s2b}`]: 0, 'own-null': 100 } },
  L3: { colonies: 2000, supply: 0, own: 0, short: 0, providers: { [`colony-${planted.colonies.C1}`]: 2000, [`colony-${planted.colonies.C3}`]: 0, [`supply-${planted.ships.m1}`]: 0 } },
})

// The reads of a screen, run in the page.
const readScreen = () => {
  const { visible, visibleText, hooked } = window.__screen
  const rowsOf = (root, identity) => [...root.querySelectorAll('tr')].filter((row) => row.hasAttribute(identity)).map((row) => ({ id: row.getAttribute(identity), on: visible(row), cells: hooked(row, 'data-cell') }))
  const poolOf = (element) => ({ key: element.getAttribute('data-pool'), on: visible(element), rule: hooked(element, 'data-pool-rule'), points: hooked(element, 'data-pool-point'), values: hooked(element, 'data-pool-value'), platforms: hooked(element, 'data-pool-platform'), sources: rowsOf(element, 'data-source'), providers: rowsOf(element, 'data-provider'), ships: rowsOf(element, 'data-ship'), empty: hooked(element, 'data-pool-empty'), text: visibleText(element) })
  const locations = [...document.querySelectorAll('[data-location]')].map((element) => {
    const row = element.closest('tr')

    return { key: element.getAttribute('data-location'), on: visible(row), name: hooked(row, 'data-location-name'), place: hooked(row, 'data-location-place'), supply: hooked(row, 'data-location-supply'), unmaintained: hooked(row, 'data-location-unmaintained') }
  })

  return { locations, pools: [...document.querySelectorAll('[data-pool]')].map(poolOf) }
}

// The page opened as a player does it, with the switch of the colonies without ships on where `idle` (the places and the lone colony are rows of those).
const prepare = async (page, url, step, idle) => {
  const stored = { logisticsLocationsTable: { sortBy: ['runwaySort'], sortDesc: [false], itemsPerPage: -1 } }

  await page.context().addInitScript((seed) => {
    const key = 'aurora-electrons:config'

    if (!sessionStorage.getItem('aurora-check-seeded')) {
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...seed }))
      sessionStorage.setItem('aurora-check-seeded', '1')
    }
  }, stored)
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
  step('waiting for the reads that the picking of the race starts')
  await settled(page, { limit: TIMEOUT })

  const target = '/logistics?view=maintenance'

  step('opening the maintenance view of /logistics')
  await page.evaluate((route) => window.$app.$router.push(route, () => {}, () => {}), target)
  await page.waitForFunction(pageLoading.arrived, target, { timeout: TIMEOUT })
  await page.waitForFunction(() => document.querySelector('[data-location]') !== null, null, { timeout: TIMEOUT }).catch(() => {})

  if (idle) {
    step('showing the colonies without ships')
    await page.getByText('Show colonies without ships', { exact: true }).click({ timeout: TIMEOUT })
  }

  step('waiting for the page to settle')
  await settled(page, { limit: TIMEOUT, loading: pageLoading })
}

// A row of the locations table opened as a player does it: a click on the row (on the place under its name, which holds no control) opens it and the drill-down is read once it is drawn. The row stays open: each drill-down is its own element and the observation ends with the page.
const drill = async (page, step, key) => {
  const row = page.locator('tr', { has: page.locator(`[data-location="${key}"]`) }).last()

  step(`opening the location ${key}`)

  const present = await page.evaluate(() => [...document.querySelectorAll('[data-location]')].map((element) => element.getAttribute('data-location')))

  if (!present.includes(key)) {
    throw new Error(`the location ${key} is not in the table; the table lists ${present.length} rows: ${short(present.slice(0, 6))}`)
  }

  await row.locator('[data-location-place]').first().click({ timeout: 30000 })
  step(`waiting for the drill-down of ${key}`)
  await page.waitForFunction((wanted) => document.querySelector(`[data-pool="${wanted}"]`) !== null, key, { timeout: 30000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(os.tmpdir(), 'ae-maintenance-pools-failure.png') })
    throw new Error(`the drill-down of ${key} did not open (${error.message.split('\n')[0]}); open: ${short(await page.evaluate(() => [...document.querySelectorAll('[data-pool]')].map((element) => element.getAttribute('data-pool'))))}`)
  })
  step(`settling after opening ${key}`)
  await settled(page, { limit: TIMEOUT, loading: pageLoading })
  step(`reading the drill-down of ${key}`)

  const seen = await page.evaluate(readScreen)

  return seen.pools.find((pool) => pool.key === key) || null
}

// The drill-downs a check reads: the keys of the locations of the plan (`L1`, `L2`, `L3`), `place:N` for the Nth place, `standalone` for the lone colony.
const DRILLS = {
  rule: ['L1', 'place:0'],
  clusters: ['L1'],
  capacity: ['L1', 'L2', 'L3'],
  providers: ['L1', 'L2', 'L3'],
  draw: ['L1', 'L2', 'L3'],
  shared: ['L1', 'L3'],
  places: ['place:0', 'place:1', 'place:2'],
  totals: [],
  identity: [],
  standalone: ['standalone'],
  'no-errors': [],
}

// The keys of the locations the drill-downs of the checks `ids` (all of them for null) are read at.
const drillKeys = (ids) => {
  const { truth, keys } = ENV.truth
  const wanted = new Set(Object.entries(DRILLS).filter(([id]) => !ids || ids.includes(id)).flatMap(([, list]) => list))
  const table = { ...keys, standalone: truth.standalone.key, ...Object.fromEntries(truth.places.map((place, index) => [`place:${index}`, place.key])) }

  return Object.entries(table).filter(([name]) => wanted.has(name)).map(([, key]) => key)
}

// The checks that read the rows of the places and of the lone colony, which the switch of the colonies without ships brings onto the table.
const SWITCH_CHECKS = new Set(['rule', 'clusters', 'places', 'standalone'])
const needsIdle = (ids) => !ids || ids.some((id) => SWITCH_CHECKS.has(id))

const observePage = (browser, url, ids) => observe(browser, async ({ page, step }) => {
  await prepare(page, url, step, needsIdle(ids))
  step('reading the screen')

  const table = await page.evaluate(readScreen)
  const pools = {}

  for (const key of drillKeys(ids)) {
    pools[key] = await drill(page, step, key)
  }

  return { locations: table.locations, pools }
})

// ---------- the checks of one observation ----------

const verdict = (ok, evidence) => (ok ? true : short(evidence))

const oneOf = (entries) => {
  const on = entries.filter((entry) => entry.on)

  return on.length === 1 ? on[0] : null
}

const figure = (text) => readFigure(text, GROUPING)
const tonsOf = (text) => {
  const match = typeof text === 'string' ? /^(.*) t$/.exec(text) : null

  return match ? figure(match[1]) : null
}
const percentOf = (text) => {
  const match = typeof text === 'string' ? /^(.*)%$/.exec(text) : null

  return match ? figure(match[1]) : null
}
const same = (a, b) => a !== null && b !== null && Math.abs(a - b) <= EPSILON
const valueOf = (pool, role) => {
  const entry = oneOf(pool.values.filter((candidate) => candidate.role === role))

  return entry ? entry.text : null
}
const cellOf = (row, role) => {
  const entry = oneOf(row.cells.filter((candidate) => candidate.role === role))

  return entry ? entry.text : null
}
const rowsByKey = (rows) => Object.fromEntries(rows.filter((row) => row.on).map((row) => [row.id, row]))

// The drill-down of a located pool the oracle describes, or the reason there is none to read.
const poolFor = (o, t, label) => {
  const key = t.truth.locations.find((location) => location.key === t.keys[label]).key

  return { key, pool: o.pools[key] || null, expected: t.truth.locations.find((location) => location.key === key), draw: t.draws[label] }
}

// The draw of each maintained ship of a location over `days` days of daily requests, worked out here from the rules and never from the module: ships in service order (priority, overhaul first, the lower id), each request paid by the colonies (fullest first, sorted again at every request), then by the supply ships fullest first where the ship or the supply ship has a cargo shuttle bay, then by the ship's own stock.
const shipDraws = (location, days) => {
  const colonies = location.colonies.map((entry) => ({ stock: entry.stock }))
  const supply = location.supply.map((entry) => ({ stock: entry.stock, bays: entry.bays }))
  const ships = location.ships.slice().sort((a, b) => a.priority - b.priority || Number(b.overhaul) - Number(a.overhaul) || a.id - b.id).map((entry, index) => ({ ...entry, order: index + 1, pot: { stock: entry.stock }, colonies: 0, supply: 0, own: 0, need: 0, full: true }))
  const take = (pots, ship, key, remaining) => {
    let left = remaining

    for (const pot of pots) {
      const given = Math.min(pot.stock, left)

      pot.stock -= given
      ship[key] += given
      left -= given

      if (left <= 1e-9) {
        return 0
      }
    }

    return left
  }

  for (let day = 1; day <= days; day++) {
    for (const ship of ships) {
      const request = ship.annual / 365

      ship.need += request

      let left = take(colonies.sort((a, b) => b.stock - a.stock), ship, 'colonies', request)

      if (left > 1e-9) {
        left = take(supply.filter((entry) => ship.bays || entry.bays).sort((a, b) => b.stock - a.stock), ship, 'supply', left)
      }

      if (left > 1e-9) {
        left = take([ship.pot], ship, 'own', left)
      }

      if (left > 1e-9) {
        ship.full = false
      }
    }
  }

  return ships.map((ship) => ({ ...ship, support: ship.need > 0 ? (ship.colonies + ship.supply + ship.own) / ship.need : 1 }))
}

const CHECKS = [
  ['rule', 'a location\'s drill-down states the grouping rule (1 unit on both axes) and the five settled points, each once, and a place with no pool says it has none', (o, t) => {
    const { pool } = poolFor(o, t, 'L1')
    const none = o.pools[t.truth.places[0].key]

    if (!pool || !none) {
      return short({ pool: Boolean(pool), none: Boolean(none) })
    }

    const rule = oneOf(pool.rule)
    const points = Object.fromEntries(t.points.map((point) => [point.key, oneOf(pool.points.filter((entry) => entry.role === point.key))]))
    const missing = t.points.filter((point) => !points[point.key])
    const wrongText = t.points.filter((point) => points[point.key] && !(points[point.key].text.includes(point.title) && points[point.key].text.includes(point.text)))

    return verdict(pool.on && rule && rule.role === 'grouping' && rule.text === t.points.find((point) => point.key === 'grouping').text && /\b1 unit\b/.test(rule.text) && pool.points.length === t.points.length && missing.length === 0 && wrongText.length === 0 && none.text.includes(t.words.place.ships) && !none.text.includes(t.words.place.colonies) && oneOf(none.rule) !== null && oneOf(none.rule).role === 'none', { rule: rule && rule.text, missing: missing.map((point) => point.key), wrongText: wrongText.map((point) => point.key), none: none.text.slice(0, 120) })
  }],
  ['clusters', 'the ships of a location are those of its anchor\'s system within 1 unit on both axes, from several fleets, with a ship 1 unit away, in another system, in a military hangar or commercial left out and each of those a place or no row of its own', (o, t) => {
    const { pool, expected } = poolFor(o, t, 'L1')

    if (!pool) {
      return 'no drill-down for the first location'
    }

    const lines = pool.ships.filter((line) => line.on)
    const wanted = expected.ships.map((row) => ({ id: String(row.id) }))
    const { problems } = pairedBy('the ships maintained at the first location', lines, wanted, (line) => line.id, (row) => row.id)
    const planted = t.planted.ships
    const excluded = ['a3', 'a4', 'a6', 'h1', 'cm'].filter((label) => lines.some((line) => line.id === String(planted[label])))
    const shows = new Set(o.locations.filter((location) => location.on).map((location) => location.key))
    const placeKeys = ['a3', 'a4', 'a6'].map((label) => `place-ship-${planted[label]}`)
    const omitted = placeKeys.filter((key) => !shows.has(key))
    const extra = ['a1', 'a2', 'a5', 'k', 'h1', 'cm', 's1a', 's2a', 's4'].filter((label) => shows.has(`place-ship-${planted[label]}`))

    return verdict(problems.length === 0 && excluded.length === 0 && omitted.length === 0 && extra.length === 0, { problems: problems.slice(0, 3), excluded, omitted, extra })
  }],
  ['capacity', 'the capacity sources are those the oracle finds, each with its whole tons, the capacity, the tonnage and the coverage follow them, the economic modifier is shown beside the coverage, and a module platform is named as adding no stock', (o, t) => {
    const problems = []

    for (const label of ['L1', 'L2', 'L3']) {
      const { pool, expected } = poolFor(o, t, label)

      if (!pool) {
        problems.push([label, 'no drill-down'])
        continue
      }

      const found = pairedBy(`the sources of ${label}`, pool.sources.filter((line) => line.on), expected.sources, (line) => line.id, (row) => row.key)

      problems.push(...found.problems)
      found.pairs.forEach(([row, line]) => {
        if (!same(tonsOf(cellOf(line, 'tons')), row.tons)) {
          problems.push([label, row.key, 'tons', cellOf(line, 'tons'), row.tons])
        }

        if (cellOf(line, 'name') !== row.name) {
          problems.push([label, row.key, 'name', cellOf(line, 'name'), row.name])
        }
      })

      const seen = { capacity: tonsOf(valueOf(pool, 'capacity')), tonnage: tonsOf(valueOf(pool, 'tonnage')), coverage: percentOf(valueOf(pool, 'coverage')), modifier: figure(valueOf(pool, 'modifier')) }

      if (!same(seen.capacity, expected.capacity) || !same(seen.tonnage, expected.tons) || seen.coverage === null || Math.abs(seen.coverage - expected.coverage * 100) > 0.06 || !same(seen.modifier, expected.modifier)) {
        problems.push([label, seen, { capacity: expected.capacity, tons: expected.tons, coverage: expected.coverage * 100, modifier: expected.modifier }])
      }

      const platforms = oneOf(pool.platforms)

      if (expected.platforms.length ? !platforms || !expected.platforms.every((name) => platforms.text.includes(name)) : platforms) {
        problems.push([label, 'platforms', platforms && platforms.text, expected.platforms])
      }
    }

    return verdict(problems.length === 0, problems.slice(0, 4))
  }],
  ['providers', 'the providers are the colonies that support the location and the supply ships there in the order the oracle draws them, each with its stock, its class minimum and its cargo shuttle bay, the pool total is the colonies plus the supply ships, and the minimums and what lies above them are kept apart', (o, t) => {
    const problems = []

    for (const label of ['L1', 'L2', 'L3']) {
      const { pool, expected } = poolFor(o, t, label)

      if (!pool) {
        problems.push([label, 'no drill-down'])
        continue
      }

      const lines = pool.providers.filter((line) => line.on)
      const order = [...expected.colonies, ...expected.supply, ...(expected.ownStock > 0 || expected.ships.length ? [{ key: 'own-null' }] : [])]
      const found = pairedBy(`the providers of ${label}`, lines, order, (line) => line.id, (row) => row.key)

      problems.push(...found.problems)
      found.pairs.forEach(([row, line], index) => {
        const stock = figure(cellOf(line, 'stock'))
        const wantedStock = row.key === 'own-null' ? expected.ownStock : row.stock
        const kind = row.key.split('-')[0]
        const name = cellOf(line, 'name')

        if (kind === 'own' ? !new RegExp(`^${expected.ships.length}\\b`).test(name) : name !== row.name) {
          problems.push([label, row.key, 'name', name, kind === 'own' ? expected.ships.length : row.name])
        }

        if (!same(stock, wantedStock) || figure(cellOf(line, 'order')) !== index + 1) {
          problems.push([label, row.key, 'stock or order', cellOf(line, 'stock'), wantedStock, cellOf(line, 'order'), index + 1])
        }

        if (kind === 'supply' && (!same(figure(cellOf(line, 'minimum')), row.minimum) || cellOf(line, 'bay') !== (row.bays ? t.words.bay.yes : t.words.bay.no))) {
          problems.push([label, row.key, 'minimum or bay', cellOf(line, 'minimum'), row.minimum, cellOf(line, 'bay'), row.bays])
        }

        if (kind === 'colony' && cellOf(line, 'where') !== (row.located ? t.words.where.located : t.words.where.assigned)) {
          problems.push([label, row.key, 'where', cellOf(line, 'where')])
        }

        if (kind === 'colony' && cellOf(line, 'kind') !== t.words.providers.colony) {
          problems.push([label, row.key, 'kind', cellOf(line, 'kind')])
        }
      })

      const colonies = expected.colonies.reduce((total, row) => total + row.stock, 0)
      const supply = expected.supply.reduce((total, row) => total + row.stock, 0)
      const minimums = expected.supply.reduce((total, row) => total + Math.min(row.stock, row.minimum), 0)
      const above = expected.supply.reduce((total, row) => total + Math.max(0, row.stock - row.minimum), 0)
      const seen = { pool: figure(valueOf(pool, 'pool')), colonies: figure(valueOf(pool, 'colonies')), supply: figure(valueOf(pool, 'supply')), minimums: figure(valueOf(pool, 'minimums')), above: figure(valueOf(pool, 'above')) }

      if (!same(seen.pool, colonies + supply) || !same(seen.colonies, colonies) || !same(seen.supply, supply) || !same(seen.minimums, minimums) || !same(seen.above, above)) {
        problems.push([label, 'totals', seen, { colonies, supply, minimums, above }])
      }
    }

    return verdict(problems.length === 0, problems.slice(0, 4))
  }],
  ['draw', 'what each provider gives over the period is what the plan says (colonies first, the supply ship with a bay next, a ship\'s own stock last, a supply ship with no bay never), each ship\'s draws add up to the providers\' and to the totals, and a ship short of stock says so', (o, t) => {
    const problems = []

    for (const label of ['L1', 'L2', 'L3']) {
      const { pool, draw, expected } = poolFor(o, t, label)

      if (!pool) {
        problems.push([label, 'no drill-down'])
        continue
      }

      const providers = rowsByKey(pool.providers)

      Object.entries(draw.providers).forEach(([key, used]) => {
        const line = providers[key]

        if (!line || !same(figure(cellOf(line, 'used')), used)) {
          problems.push([label, key, 'used', line && cellOf(line, 'used'), used])
        }
      })

      const ships = pool.ships.filter((line) => line.on)
      const sum = (role) => ships.reduce((total, line) => total + (figure(cellOf(line, role)) ?? NaN), 0)
      const seen = { colonies: figure(valueOf(pool, 'drawnColonies')), supply: figure(valueOf(pool, 'drawnSupply')), own: figure(valueOf(pool, 'drawnOwn')), short: figure(valueOf(pool, 'short')) }

      if (!same(seen.colonies, draw.colonies) || !same(seen.supply, draw.supply) || !same(seen.own, draw.own) || seen.short !== draw.short) {
        problems.push([label, 'totals', seen, draw])
      }

      if (!same(sum('colonies'), draw.colonies) || !same(sum('supply'), draw.supply) || !same(sum('own'), draw.own)) {
        problems.push([label, 'ships do not add up', sum('colonies'), sum('supply'), sum('own')])
      }

      const found = pairedBy(`the ships of ${label}`, ships, shipDraws(expected, 365), (line) => line.id, (row) => String(row.id))

      problems.push(...found.problems)
      found.pairs.forEach(([row, line]) => {
        const seenShip = { order: figure(cellOf(line, 'order')), priority: figure(cellOf(line, 'priority')), tons: tonsOf(cellOf(line, 'tons')), annual: figure(cellOf(line, 'annual')), colonies: figure(cellOf(line, 'colonies')), supply: figure(cellOf(line, 'supply')), own: figure(cellOf(line, 'own')), support: percentOf(cellOf(line, 'support')), status: cellOf(line, 'status'), state: cellOf(line, 'state') }
        const right = same(seenShip.colonies, row.colonies) && same(seenShip.supply, row.supply) && same(seenShip.own, row.own) && same(seenShip.annual, row.annual) && seenShip.priority === row.priority && same(seenShip.tons, row.tons) && seenShip.order === row.order && seenShip.support !== null && Math.abs(seenShip.support - row.support * 100) <= 0.51 && seenShip.status === (row.full ? t.words.support.full : t.words.support.short) && seenShip.state === (row.overhaul ? t.words.states.overhaul : t.words.states.ordinary)

        if (!right || cellOf(line, 'name') !== row.name) {
          problems.push([label, row.id, 'ship', { ...seenShip, name: cellOf(line, 'name') }, { name: row.name, order: row.order, priority: row.priority, tons: row.tons, annual: row.annual, colonies: row.colonies, supply: row.supply, own: row.own, support: row.support * 100, full: row.full }])
        }
      })

      const used = (kind) => Object.entries(providers).filter(([key]) => key.startsWith(kind)).reduce((total, [, line]) => total + (figure(cellOf(line, 'used')) ?? NaN), 0)

      if (!same(used('colony'), draw.colonies) || !same(used('supply'), draw.supply) || !same(used('own'), draw.own)) {
        problems.push([label, 'providers do not add up', used('colony'), used('supply'), used('own')])
      }

      const short = ships.filter((line) => cellOf(line, 'status') === t.words.support.short).length

      if (short !== draw.short) {
        problems.push([label, 'ships short', short, draw.short])
      }

      Object.entries(providers).forEach(([key, line]) => {
        const start = key === 'own-null' ? t.truth.locations.find((location) => location.key === pool.key).ownStock : [...t.truth.locations.find((location) => location.key === pool.key).colonies, ...t.truth.locations.find((location) => location.key === pool.key).supply].find((row) => row.key === key).stock

        const wanted = start - (draw.providers[key] || 0)

        if (!same(figure(cellOf(line, 'left')), wanted)) {
          problems.push([label, key, 'left', cellOf(line, 'left'), wanted])
        }
      })
    }

    return verdict(problems.length === 0, problems.slice(0, 4))
  }],
  ['shared', 'the colony a module ship is assigned to supports its location from elsewhere and also the location it sits at, a module platform\'s stock is in no pool, and the module supply ship\'s stock is', (o, t) => {
    const l3 = poolFor(o, t, 'L3')
    const l1 = poolFor(o, t, 'L1')

    if (!l3.pool || !l1.pool) {
      return 'no drill-down'
    }

    const c1 = `colony-${t.planted.colonies.C1}`
    const line = rowsByKey(l3.pool.providers)[c1]
    const there = rowsByKey(l1.pool.providers)[c1]
    const m1 = rowsByKey(l3.pool.providers)[`supply-${t.planted.ships.m1}`]
    const p1 = rowsByKey(l3.pool.providers)[`supply-${t.planted.ships.p1}`]
    const sources = l3.pool.sources.filter((entry) => entry.on).map((entry) => entry.id)

    return verdict(line && there && cellOf(line, 'where') === t.words.where.assigned && cellOf(there, 'where') === t.words.where.located && m1 && same(figure(cellOf(m1, 'stock')), 150000) && !p1 && !sources.includes(c1) && sources.includes(`module-${t.planted.ships.m1}`) && sources.includes(`module-${t.planted.ships.p1}`), { line: line && cellOf(line, 'where'), there: there && cellOf(there, 'where'), m1: Boolean(m1), p1: Boolean(p1), sources })
  }],
  ['places', 'a ship the grouping leaves out is a place of its own, marked as not maintained, with no pool, no source and no provider', (o, t) => {
    const problems = []

    for (const place of t.truth.places) {
      const row = o.locations.find((location) => location.key === place.key)
      const pool = o.pools[place.key]

      if (!row || !row.on || oneOf(row.unmaintained) === null || oneOf(row.unmaintained).text !== t.words.location.unmaintained || !pool || pool.sources.length > 0 || pool.providers.length > 0 || pool.ships.length > 0 || oneOf(pool.rule) === null || oneOf(pool.rule).role !== 'none') {
        problems.push([place.label, row && row.on, row && row.unmaintained.length, pool && [pool.sources.length, pool.providers.length, pool.rule.map((entry) => entry.role)]])
      }
    }

    return verdict(t.truth.places.length === 3 && problems.length === 0, { problems, places: t.truth.places.length })
  }],
  ['totals', 'the supply caption of a location row is the whole stock of the supply ships there, the class minimums not taken off', (o, t) => {
    const problems = []

    for (const label of ['L1', 'L2', 'L3']) {
      const { key, expected } = poolFor(o, t, label)
      const row = o.locations.find((location) => location.key === key)
      const caption = row ? oneOf(row.supply) : null
      const suffix = ` ${t.words.location.supply}`
      const match = caption && caption.text.endsWith(suffix) && caption.text.startsWith('+') ? [caption.text, caption.text.slice(1, -suffix.length)] : null
      const wanted = expected.supply.reduce((total, entry) => total + entry.stock, 0)

      if (!match || !same(figure(match[1]), wanted)) {
        problems.push([label, caption && caption.text, wanted])
      }
    }

    return verdict(problems.length === 0, problems)
  }],
  ['identity', 'a location anchored at a colony is named and placed from that colony and its system in the row of the table, whatever larger colony of another system lies within the grouping distance of it (that colony is a source of the pool and nothing more)', (o, t) => {
    const problems = []

    for (const [label, colonyLabel] of [['L1', 'C1'], ['L2', 'C2'], ['L3', 'C3']]) {
      const { key } = poolFor(o, t, label)
      const row = o.locations.find((location) => location.key === key)
      const anchor = t.truth.identity[colonyLabel]
      const name = row ? oneOf(row.name) : null
      const place = row ? oneOf(row.place) : null

      if (!row || !row.on || !name || name.text !== anchor.name || !place || !place.text.startsWith(anchor.system) || place.text.startsWith(t.truth.identity.C4.system)) {
        problems.push([label, name && name.text, anchor.name, place && place.text, anchor.system])
      }
    }

    return verdict(problems.length === 0, problems)
  }],
  ['standalone', 'a colony with no maintenance facilities that lies beside a module platform of another pool is a place of its own: its drill-down names it, says no location counts it and claims nothing of the ships there or of what lies nearby, and the platform keeps its own pool', (o, t) => {
    const s = t.truth.standalone
    const row = o.locations.find((location) => location.key === s.key)
    const pool = o.pools[s.key]
    const none = pool ? oneOf(pool.rule) : null
    const platform = o.locations.find((location) => location.key === s.poolKey)
    const name = row ? oneOf(row.name) : null
    const ok = row && row.on && name && name.text === s.name && platform && platform.on && pool && none && none.role === 'none' && none.text.includes(t.words.place.colonies) && !none.text.includes(t.words.place.ships) && pool.sources.length === 0 && pool.providers.length === 0 && pool.ships.length === 0 && pool.text.includes(s.name)

    return verdict(ok, { row: Boolean(row), name: name && name.text, platform: Boolean(platform), rule: none && none.text.slice(0, 160), pool: pool && [pool.sources.length, pool.providers.length, pool.ships.length] })
  }],
  ['no-errors', 'the page raises no error of its own while the locations are opened', (o) => verdict(o.unexpected.length === 0, o.unexpected.slice(0, 3))],
]

/* eslint-disable no-template-curly-in-string */
const PAGE_FAULTS = [
  { name: 'the capacity of a location draws its tonnage', file: POOL_FILE, change: swap('data-pool-value="capacity">{{ tons(location.capacity) }}', 'data-pool-value="capacity">{{ tons(location.tons) }}'), fails: ['capacity'] },
  { name: 'the coverage of a location draws half its figure', file: POOL_FILE, change: swap('data-pool-value="coverage">{{ percent(location.rate) }}', 'data-pool-value="coverage">{{ percent(location.rate / 2) }}'), fails: ['capacity'] },
  { name: 'a source shows the capacity of the whole location', file: POOL_FILE, change: swap('data-cell="tons">{{ tons(source.tons) }}', 'data-cell="tons">{{ tons(location.capacity) }}'), fails: ['capacity'] },
  { name: 'a platform is worded as a designated ship', file: POOL_FILE, change: swap('shipFigures(ship).designated === false', 'shipFigures(ship).designated === true'), fails: ['capacity'] },
  { name: 'the order of the providers starts at 0', file: POOL_FILE, change: swap('order: index + 1, used:', 'order: index, used:'), fails: ['providers'] },
  { name: 'the minimum column draws the stock', file: POOL_FILE, change: swap('data-cell="minimum">{{ provider.minimum === null ? \'\' : msp(provider.minimum) }}', 'data-cell="minimum">{{ provider.minimum === null ? \'\' : msp(provider.stock) }}'), fails: ['providers'] },
  { name: 'the bay column is turned about', file: POOL_FILE, change: swap('Number(ship.Bays) > 0 ? POOL_WORDS.bay.yes : POOL_WORDS.bay.no', 'Number(ship.Bays) > 0 ? POOL_WORDS.bay.no : POOL_WORDS.bay.yes'), fails: ['providers'] },
  { name: 'an assigned colony is worded as at the location', file: POOL_FILE, change: swap('where: located.has(colony.PopulationID) ? POOL_WORDS.where.located : POOL_WORDS.where.assigned', 'where: POOL_WORDS.where.located'), fails: ['providers', 'shared'] },
  { name: 'the pool total leaves out the supply ships', file: POOL_FILE, change: swap('pool: colonies === null || supply === null ? null : colonies + supply', 'pool: colonies'), fails: ['providers'] },
  { name: 'what lies above the minimums is the stock itself', file: POOL_FILE, change: swap('const above = sum(pool.supplyShips, (ship) => (isNumber(ship.CurrentMaintSupplies) && isNumber(ship.MinimumSupplies) ? Math.max(0, ship.CurrentMaintSupplies - ship.MinimumSupplies) : null))', 'const above = sum(pool.supplyShips, (ship) => (isNumber(ship.CurrentMaintSupplies) && isNumber(ship.MinimumSupplies) ? ship.CurrentMaintSupplies : null))'), fails: ['providers'] },
  { name: 'the supply column of a ship draws its own stock', file: POOL_FILE, change: swap('data-cell="supply">{{ msp(item.fromSupply) }}', 'data-cell="supply">{{ msp(item.fromOwn) }}'), fails: ['draw'] },
  { name: 'the drawn column of a provider draws what is left', file: POOL_FILE, change: swap('data-cell="used">{{ msp(provider.used) }}', 'data-cell="used">{{ msp(provider.left) }}'), fails: ['draw'] },
  { name: 'a ship short of stock is worded as covered', file: POOL_FILE, change: swap('run.full ? POOL_WORDS.support.full : POOL_WORDS.support.short', 'POOL_WORDS.support.full'), fails: ['draw'] },
  { name: 'the grouping rule is not shown', file: POOL_FILE, change: swap('<div class="caption text--secondary pool-rule" data-pool-section="rule" data-pool-rule="grouping">', '<div class="caption text--secondary pool-rule" data-pool-section="rule" data-pool-rule="grouping" style="display: none">'), fails: ['rule'] },
  { name: 'the supply caption of a row is the stock above the minimums', file: PAGE_FILE, change: swap('`+${count(item.supply)} ${locationWords.supply}`', '`+${count(item.supplyAbove)} ${locationWords.supply}`'), fails: ['totals'] },
  { name: 'a place is worded as fully maintained', file: PAGE_FILE, change: swap('>{{ locationWords.unmaintained }}</span>', '>Fully maintained</span>'), fails: ['places'] },
  { name: 'the support of every ship is drawn as 100%', file: POOL_FILE, change: swap('data-cell="support">{{ percent(item.support) }}', 'data-cell="support">{{ percent(1) }}'), fails: ['draw'] },
  { name: 'each ship is drawn with the draws of the next ship', file: POOL_FILE, change: swap('const run = this.simShips.get(ship.ShipID)', 'const run = this.simShips.get(this.location.pool.assigned[(index + 1) % this.location.pool.assigned.length].ShipID)'), fails: ['draw'] },
  { name: 'the explanation of each settled point is not drawn', file: POOL_FILE, change: swap('</span> {{ point.text }}</div>', '</span></div>'), fails: ['rule'] },
  { name: 'the displayed names of the first two ships of a location are swapped', file: POOL_FILE, change: swap('data-cell="name">{{ item.name }}</div>', 'data-cell="name">{{ shipRows.length > 1 && item.order <= 2 ? shipRows[2 - item.order].name : item.name }}</div>'), fails: ['draw'] },
  { name: 'a capacity source is displayed under another name', file: POOL_FILE, change: swap('<span data-cell="name">{{ source.name }}</span>', '<span data-cell="name">{{ source.name }} II</span>'), fails: ['capacity'] },
  { name: 'a provider is displayed under another name', file: POOL_FILE, change: swap('<span data-cell="name">{{ provider.name }}</span>', '<span data-cell="name">{{ provider.name }} II</span>'), fails: ['providers'] },
  { name: 'a location is named and placed from its most populous colony wherever it lies', file: PAGE_FILE, change: swap('const main = anchor || here.slice()', 'const main = location.located.slice()'), fails: ['identity'] },
  { name: 'the sentence for the ships of a place is drawn for a place with colonies only', file: POOL_FILE, change: swap('this.location.shipRows.length ? place.ships : \'\'', 'place.ships'), fails: ['standalone'] },
]
/* eslint-enable no-template-curly-in-string */

// A rewrite is judged by the checks that read the part of the page it changes (`checks`), and the drill-downs those checks read are the ones opened.
const PAGE_BENIGN = [
  { name: 'the switch of the locations bound by an explicit prop and event instead of v-model', file: PAGE_FILE, checks: ['standalone', 'clusters', 'no-errors'], change: swap('v-model="showIdleLocations"', ':input-value="showIdleLocations" @change="showIdleLocations = $event"') },
  { name: 'the retry of the supplied-output panel listened to by the longhand of the event', file: PAGE_FILE, checks: ['totals', 'no-errors'], change: swap('@retry="retryMspSupply"', 'v-on:retry="retryMspSupply"') },
  { name: 'the tonnage line states its qualifier after the figure instead of before it', file: POOL_FILE, checks: ['capacity'], change: swap('Tonnage of the assigned ships: <span class="text-no-wrap" data-pool-value="tonnage">{{ tons(location.tons) }}</span>', '<span class="text-no-wrap" data-pool-value="tonnage">{{ tons(location.tons) }}</span> is the tonnage of the assigned ships') },
  { name: 'the supply caption of a row worded with another word of the reviewed table', file: POOLS_FILE, checks: ['totals', 'no-errors'], change: swap('supply: \'on supply ships\'', 'supply: \'aboard supply ships\'') },
  { name: 'the condition of the drill-down parenthesised', file: POOL_FILE, checks: ['rule', 'clusters'], change: swap('<template v-if="location.pool">', '<template v-if="(location.pool)">') },
]

// ---------- the run ----------

let ENV = null
const cleanups = []
let checks = 0
let failures = 0

const MODULES = ['maintenance-pools', 'logistics']

const setUp = async () => {
  const { startPageServer } = require('./lib/page-server')
  const copy = await saveCopy()

  cleanups.push(async () => fs.rmSync(copy.folder, { recursive: true, force: true }))

  const loaded = await loadUtilities(MODULES)
  const { planted, truth } = copy
  const draw = draws(planted)

  if (truth.locations.length === 0) {
    throw new HarnessError('the oracle found no location')
  }

  const keyOf = (colonyId) => truth.locations.find((location) => location.sources.some((source) => source.key === `colony-${colonyId}`)).key
  const keys = { L1: keyOf(planted.colonies.C1), L2: keyOf(planted.colonies.C2), L3: keyOf(planted.colonies.C3) }

  if (new Set(Object.values(keys)).size !== 3 || truth.places.length !== 3) {
    throw new HarnessError(`the planted copy does not have three locations and three places: ${short({ keys, places: truth.places })}`)
  }

  const { identity, standalone } = truth

  if (identity.C4.system === identity.C1.system || identity.C4.system.startsWith(identity.C1.system) || identity.C1.system.startsWith(identity.C4.system)) {
    throw new HarnessError(`the systems of the first and the remote colony cannot be told apart by the name they begin with: ${short([identity.C1.system, identity.C4.system])}`)
  }

  const first = truth.locations.find((location) => location.key === keys.L1)

  if (!first.sources.some((source) => source.key === `colony-${planted.colonies.C4}`) || first.sources[0].key !== `colony-${planted.colonies.C1}`) {
    throw new HarnessError('the remote colony is not a source of the first location, or the first colony is not its anchor')
  }

  if (standalone.facilities !== 0 || standalone.supports || standalone.poolKey === null || !standalone.poolSources.some((source) => source.startsWith('module-'))) {
    throw new HarnessError(`the lone colony is not a colony without facilities that supports no location beside a module pool: ${short(standalone)}`)
  }

  const words = { ...loaded['maintenance-pools'].POOL_WORDS }
  const env = {
    originals: Object.fromEntries([PAGE_FILE, POOL_FILE, POOLS_FILE, LOGISTICS_FILE].map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')])),
    truth: { truth, planted, keys, interesting: Object.values(keys), draws: { L1: draw.L1, L2: draw.L2, L3: draw.L3 }, words, points: loaded['maintenance-pools'].SETTLED_POINTS.map((point) => ({ ...point })) },
  }

  for (const label of ['L1', 'L2', 'L3']) {
    const expected = truth.locations.find((location) => location.key === keys[label])

    if (expected.coverage !== 1) {
      throw new HarnessError(`the planted location ${label} is not at full coverage (${expected.coverage}), so the hand-worked draws do not hold`)
    }
  }

  env.server = await startPageServer({ save: copy.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/logistics'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

const view = async (variant, ids = null) => {
  if (variant) {
    ENV.server.replace(variant.file, variant.change(ENV.originals[variant.file]))
  }

  try {
    const seen = await observePage(ENV.chrome, ENV.server.url, ids)

    if (seen.error !== null) {
      console.error(`the page${variant ? ` with "${variant.name}"` : ''} did not get through: ${seen.error}`)
    }

    // The words the page was served with: the reviewed table of the module as the variant leaves it.
    seen.words = variant && variant.file === POOLS_FILE ? (await loadUtilities(['maintenance-pools'], { sources: { 'maintenance-pools': variant.change(ENV.originals[POOLS_FILE]) } }))['maintenance-pools'].POOL_WORDS : ENV.truth.words

    return seen
  } finally {
    if (variant) {
      ENV.server.replace(variant.file, null)
    }
  }
}

const pageResults = async (seen, { strict, ids = null, label }) => {
  validate(seen, label)

  const chosen = CHECKS.filter(([id]) => !ids || ids.includes(id))

  if (unobserved(seen)) {
    if (strict) {
      throw new HarnessError(`${label} did not get through: ${seen.error}`)
    }

    return chosen.map(([id, name]) => ({ id, name, ok: false, kind: 'unobserved', threw: false, detail: String(seen.error) }))
  }

  const o = { ...seen.value, unexpected: seen.unexpected }
  const judge = (test) => () => {
    const result = test(o, { ...ENV.truth, words: seen.words, truth: ENV.truth.truth, keys: ENV.truth.keys, planted: ENV.truth.planted })

    if (result !== true) {
      assert.fail(result)
    }
  }

  return await runChecks(chosen.map(([id, name, test]) => ({ id, name, run: judge(test) })))
}

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

const checkPageHead = async () => {
  const seen = await view(null)
  const results = await pageResults(seen, { strict: false, label: 'the page' })

  judged(results, 'the page')
  results.forEach((result) => report(result.name, result.ok, result.detail))
}

const checkPageFault = async (fault) => {
  const results = await pageResults(await view(fault, fault.fails), { strict: true, ids: fault.fails, label: `the page with the fault "${fault.name}"` })

  judged(results, fault.name)
  reportFault(fault, results)
}

const checkPageRewrite = async (rewrite) => {
  const seen = await view(rewrite, rewrite.checks)
  const results = await pageResults(seen, { strict: true, ids: rewrite.checks, label: `the page rewritten as "${rewrite.name}"` })

  judged(results, rewrite.name)
  reportRewrite(rewrite, results)
}

const pureResults = async (variant, ids) => {
  const sources = variant ? { [variant.module]: variant.change(fs.readFileSync(path.join(root, variant.file), 'utf8')) } : {}
  const loaded = await loadUtilities(MODULES, { sources })
  const mods = { pools: subjectModule(loaded['maintenance-pools'], 'module'), logistics: subjectModule(loaded.logistics, 'module') }

  return await runChecks(PURE_CHECKS.filter(({ id }) => !ids || ids.includes(id)), mods)
}

const checkPureHead = async () => {
  const results = await pureResults(null)

  judged(results, 'the modules')
  results.forEach((result) => report(result.name, result.ok, result.detail))
}

const checkPureFault = async (fault) => {
  const results = await pureResults(fault, fault.fails)

  judged(results, fault.name)
  reportFault(fault, results)
}

const checkPureRewrite = async (rewrite) => {
  const results = await pureResults(rewrite)

  judged(results, rewrite.name)
  reportRewrite(rewrite, results)
}

const DEADLINES = { page: 300, pure: 120, setup: 900 + 180 }
const CONTROL_FAULT = 'the capacity of a location draws its tonnage'

const variantsOf = (mutating) => [
  { key: 'pure', name: 'the head: the grouping, the figures and the draw of the modules as they are', head: true, heading: 'The shared maintenance pools (utilities/maintenance-pools.js and utilities/logistics.js)', deadline: DEADLINES.pure, run: checkPureHead },
  ...(mutating ? PURE_FAULTS.map((fault, index) => ({ key: `pure-fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the modules', deadline: DEADLINES.pure, run: () => checkPureFault(fault) })) : []),
  ...(mutating ? PURE_BENIGN.map((rewrite, index) => ({ key: `pure-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the modules that say the same thing', deadline: DEADLINES.pure, run: () => checkPureRewrite(rewrite) })) : []),
  { key: 'page', name: 'the head: the Logistics page as it is', head: true, heading: '\nThe drill-down of the maintenance locations on the Logistics page (scripts/lib/page-server.js over a copy of a save)', pool: 'suite', deadline: DEADLINES.page, run: checkPageHead },
  ...(mutating ? PAGE_FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the page', pool: 'suite', deadline: DEADLINES.page, run: () => checkPageFault(fault) })) : []),
  ...(mutating ? PAGE_BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the page that say the same thing', pool: 'suite', deadline: DEADLINES.page, run: () => checkPageRewrite(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.pool === 'suite')) {
        ENV = await setUp()
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
    control: mutating ? { fault: `fault:${PAGE_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'page', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
