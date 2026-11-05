/*
  Checks the cargo loading strength of the 3.1 line (src/renderer/utilities/transport.js `handlingBreakdown`, `stopHandling`, `transferCategory`, hauling.js `cycleCargo` and `cycleHandling`): the base strength of a ship at a stop is its own term, the bays it has times the race's cargo handling technology, plus the technology once more where a spaceport or cargo shuttle station serves the colony, and the officers' Logistics bonuses multiply that whole base; a ship over 10 hull spaces with no undamaged bays counts one bay; and Load All Ship Components (move action 237) is a cargo load with a handling time.

  Run: bun scripts/check-loading-strength.js [--no-mutations]

  Every expected figure is worked out here from the game's rule (`Ship.GetCargoShuttleTransferMultiplier`: the race's load modifier L times the ship's bays Q, Q being 1 for a ship of 10 hull spaces or less and for one whose undamaged bays add up to exactly zero, plus L where the colony's cargo shuttle capacity is at least 1, the sum times the ship commander's, the naval admin command's, the governor's and the sector commander's Logistics multipliers; `Fleet.CalculateLoadOperationTime`: the free capacity times 20 s, times Class Crew over Current Crew where the crew is short, over that multiplier), never read from the module:
  - `formula`: the worked cases (a bayless freighter of 50,000 t at a colony with a spaceport at technology 1 loads in 500,000 s, a ship with 3 bays and a 1.2 commander at technology 1.5 has 7.2, not the 6.9 of the officer multiplying only the ship's own term), the colony's addition inside the officers' product, a colony with no service adding nothing, however many stations the colony has;
  - `bays`: a ship of 10 hull spaces or less has a ship term of 1 whatever bays it has (the limit included), a larger one the undamaged bays' strength, 1 for a ship with no bays and a ship with every bay damaged alike, a bay strength below 1 kept, and a bay count not in the save giving no strength for a ship over the limit;
  - `load-all`: move action 237 is a cargo load of the free capacity of the hold at 20 s a tonne on the same timer as Load All Minerals, a cycle of orders giving it a time and a hold already filled by another load leaving it nothing to load;
  - `components`: the ship components a load puts in the hold stay in it until an unload takes them (`Ship.LoadShipComponentsFromPopulation`, `Ship.UnloadShipComponentsToPopulation`, `Ship.GetAvailableCargoCapacity`): a second load finds the hold full, a load of minerals the space the components left, Unload All Ship Components (189) and Unload Ship Component (141) take them out, Load Ship Component (140) is a load of one component, an unload to another fleet is a transfer between ships, and a load of a set number of components has no cycle;
  - `component-types`: a typed unload after a bulk load leaves an unknown remainder, no downstream free space or exact timer, whereas matching and non-matching typed loads are exact;
  - `fleet-timer`: component tonnes times 20 divided by crew and ship-to-ship strength, with the receiving fleet's addition after the commander and naval command, no landing exemption, governor or sector;
  - `component-display`: the real page's computed route and compiled moved-cargo slot display components delivered, not counted in tonnage, on components-only and mixed routes;
  - `unserved`: a ship with its crew aboard loads at a colony with no spaceport or cargo shuttle station whatever bays it has (`Ship.GetCargoShuttleTransferMultiplier` is positive there, `Ship.method_159` counting one bay for none): a craft of 10 hull spaces or less, a ship over it with no bays or with every bay damaged and a ship with bays, in the stop, the Transport round trip and the Hauling cycle;
  - `versions`: the loading rules hold for the 3.1 line only, the landing rule stays registered for 2.7 alone while the 10 hull space limit of the ship term is the 3.1 line's own, a ship with no bays has a verdict there, and the rule notes cite the members of the source;
  - `footers`: the footers of Hauling and Information say that a ship with no bays loads at the technology alone, not that loading at a colony with no service is not settled;
  - `fixture`: on the interim 3.1 fixture (scripts/lib/fixtures.js, game 141, race 784) the loaders' ship and colony columns, the officers' bonuses and the strength and time of a stop at a colony with a spaceport and one without each equal what is worked out here from the stored rows by SQL and arithmetic written apart from the loaders, for the fleet's ships as saved and for copies in which a freighter class has no bays or a ship has its bay damaged (the fixture has no such ship);
  - `recorded`: the loading times the migrated save stores for loads in progress (the time still to run, the full time is not stored) are no longer than the full-hold time of the same fleet at the same colony by the rule above.
  What no check here can settle on the migrated fixture: the full loading time the 3.1 game stores for a load that has just started (the save holds the remaining time of loads in progress only), which needs a save played under 3.1 (tier b).

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { loadPage, instantiate } = require('./lib/page-loader')
const { renderTree, treeOf } = require('./lib/vue-render')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const VERSION = '3.1.x'
// The Logistics commander bonus (DIM_CommanderBonusType 24) and the cargo shuttle bay component type (DIM_ComponentType 14).
const LOGISTICS = 24
const BAY_TYPE = 14
// A class of 600 hull spaces with one cargo shuttle bay (80 ships on the fixture) and a class of 2,700 with five (16 ships): the freighters the planted cases are made on.
const ONE_BAY_CLASS = 62967
const FIVE_BAY_CLASS = 62926
const NEAR = 1e-9

const FILES = {
  transport: path.join(root, 'src', 'renderer', 'utilities', 'transport.js'),
  hauling: path.join(root, 'src', 'renderer', 'utilities', 'hauling.js'),
  bonuses: path.join(root, 'src', 'renderer', 'utilities', 'handling-bonuses.js'),
  cargo: path.join(root, 'src', 'renderer', 'utilities', 'cargo-actions.js'),
  haulingPage: path.join(root, 'src', 'renderer', 'pages', 'hauling.vue'),
  informationPage: path.join(root, 'src', 'renderer', 'pages', 'information.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules as shipped, or with edits planted ---------------------------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => ({
  texts,
  modules: memo(() => loadUtilities(['transport', 'hauling', 'handling-bonuses', 'handling-support', 'provenance'], { sources: { transport: texts.transport, hauling: texts.hauling, 'handling-bonuses': texts.bonuses, 'cargo-actions': texts.cargo } })),
  page: memo(() => loadPage('pages/hauling', { sources: { 'pages/hauling': texts.haulingPage, 'utilities/hauling': texts.hauling, 'utilities/transport': texts.transport, 'utilities/cargo-actions': texts.cargo, 'utilities/handling-bonuses': texts.bonuses } })),
})

const near = (actual, expected, message = '') => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= NEAR * Math.max(1, Math.abs(expected)), `${message} ${actual} is not ${expected}`.trim())

// ---- Rows the cases are built from ------------------------------------------------------------------------------------
// A ship over the landing size with bays of strength 2, fully crewed, carrying 1,000 t, in the fleet of naval admin command 10.
const ship = (extra = {}) => ({ ShipID: 1, ShipName: 'Hauler', ClassName: 'Freighter', FleetID: 5, Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 0, NavalAdminCommandID: 10, ...extra })

// A colony row as the pages' queries give it: population 7 in system 3 with one spaceport.
const colony = (extra = {}) => ({ PopName: 'Mars', PopulationID: 7, SystemID: 3, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra })

const command = (id, system, parent, bonus, share, systems) => ({ NavalAdminCommandID: id, SystemID: system, ParentCommandID: parent, BonusValue: bonus, Share: share, Eligible: true, Unknown: null, BonusUnknown: null, Systems: new Set(systems) })

const support = (extra = {}) => ({ mode: 'loaded', withheld: null, gaps: { commander: null, admin: null, governor: null, sector: null }, commanders: {}, governors: {}, sectors: {}, admins: {}, ...extra })

// Every officer applies: the ship's commander 1.2, the admin chain 1 + 0.2 x 0.25 = 1.05, the governor 1.1 and the sector commander's quarter, 1 + 0.4 x 0.25 = 1.1.
const FULL = () => support({ commanders: { 1: 1.2 }, governors: { 7: 1.1 }, sectors: { 3: 1.4 }, admins: { 10: command(10, 3, 0, 1.2, 0.25, [3]) } })
const FULL_PRODUCT = 1.2 * 1.05 * 1.1 * 1.1
const NO_GOVERNOR = 1.2 * 1.05 * 1.1
const COMMANDER = () => support({ commanders: { 1: 1.2 } })

const at = (transport, { tech = 1.5, sup = support(), row = {}, extra = {} } = {}) => transport.handlingBreakdown(ship(extra), transport.colonyEndpoint(colony(row)), tech, VERSION, sup)

const stopAt = (transport, order, { tech = 1.5, sup = support(), row = {}, extra = {}, share = 1 } = {}) => transport.stopHandling({ MoveActionID: order, endpoint: transport.colonyEndpoint(colony(row)) }, [ship(extra)], tech, share, { version: VERSION, support: sup })

// A colony with no spaceport and no cargo shuttle station.
const UNSERVED = { ShuttleCapacity: 0, ServiceNames: '' }

// An order of a cycle at an endpoint: Load Mineral Type and the like carry the item and the quantity in `extra`.
const order = (id, endpoint, label, extra = {}) => ({ MoveActionID: id, endpoint, label, PopName: label, PopulationID: endpoint.populationId, MaxItems: 0, ...extra })

// ---- The fixture, as in-memory copies ----------------------------------------------------------------------------------
let CLONES = null

// The class's bay lines and their component design: the component ids of the class's cargo shuttle bays.
const bayDesigns = (database, classId) => database.query(`select FCT_ClassComponent.ComponentID from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = ${classId} and FCT_ShipDesignComponents.ComponentTypeID = ${BAY_TYPE}`).all().map((row) => row.ComponentID)

// The saved bytes once, and the copies the planted cases need, made in memory so that no file is written: as saved; the one-bay class built without bays; one ship of that class with its bay damaged; one ship of the five-bay class with three of its five bays damaged; the five-bay class cut to 10 and to 15 hull spaces (the fixture has no craft of 10 hull spaces or less that carries cargo).
const clones = () => {
  if (!CLONES) {
    const bytes = fs.readFileSync(path.join(root, SAVE))
    const copy = () => Database.deserialize(bytes)
    const intact = copy()
    const bayless = copy()
    const damaged = copy()
    const ten = copy()
    const fifteen = copy()
    const [oneBay] = bayDesigns(intact, ONE_BAY_CLASS)
    const [fiveBays] = bayDesigns(intact, FIVE_BAY_CLASS)
    const first = (classId) => damaged.query(`select ShipID from FCT_Ship where GameID = ${GAME} and ShipClassID = ${classId} order by ShipID limit 1`).get().ShipID

    bayless.run(`delete from FCT_ClassComponent where ClassID = ${ONE_BAY_CLASS} and ComponentID = ${oneBay}`)
    damaged.run(`insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${first(ONE_BAY_CLASS)}, ${oneBay}, ${GAME}, 1)`)
    damaged.run(`insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${first(FIVE_BAY_CLASS)}, ${fiveBays}, ${GAME}, 3)`)
    ten.run(`update FCT_ShipClass set Size = 10 where ShipClassID = ${FIVE_BAY_CLASS}`)
    fifteen.run(`update FCT_ShipClass set Size = 15 where ShipClassID = ${FIVE_BAY_CLASS}`)
    CLONES = { intact, bayless, damaged, ten, fifteen, oneBay, fiveBays, damagedOneBay: first(ONE_BAY_CLASS), damagedFiveBays: first(FIVE_BAY_CLASS) }
  }

  return CLONES
}

const closeClones = () => {
  if (CLONES) {
    ;[CLONES.intact, CLONES.bayless, CLONES.damaged, CLONES.ten, CLONES.fifteen].forEach((database) => database.close())
    CLONES = null
  }
}

const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

// ---- What the rule needs of the stored rows, by SQL and arithmetic written here, apart from the loaders' -------------
// The bays of every ship of the race as the game adds them up: each undamaged bay line counts its component's value (a ship's damaged bays taken off its class's lines by component design), `designed` with none damaged.
const oracleShips = (database) => {
  const lines = database.query(`select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.ComponentValue from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ShipDesignComponents.ComponentTypeID = ${BAY_TYPE}`).all()
  const damage = database.query(`select ShipID, ComponentID, Number from FCT_DamagedComponent where GameID = ${GAME}`).all()
  const ships = database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Ship.ShipClassID, FCT_Ship.CurrentCrew, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.CargoCapacity, FCT_Fleet.ParentCommandID as NavalAdminCommandID from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${GAME} and FCT_Ship.RaceID = ${RACE} order by FCT_Ship.ShipID`).all()

  return ships.map((row) => {
    const own = lines.filter((line) => line.ClassID === row.ShipClassID)
    const hurt = (line) => damage.filter((one) => one.ShipID === row.ShipID && one.ComponentID === line.ComponentID).reduce((sum, one) => sum + one.Number, 0)

    return { ...row, designed: own.reduce((sum, line) => sum + line.NumComponent * line.ComponentValue, 0), bays: own.reduce((sum, line) => sum + Math.max(line.NumComponent - hurt(line), 0) * line.ComponentValue, 0) }
  })
}

// What each colony of the race has: the strength of its cargo shuttle installations, summed from the installations the table names as cargo shuttle ones.
const oracleColonies = (database) => {
  const colonies = database.query(`select PopulationID, PopName, SystemID from FCT_Population where GameID = ${GAME} and RaceID = ${RACE} order by PopulationID`).all()
  const shuttles = Object.fromEntries(database.query('select PlanetaryInstallationID, CargoShuttleValue from DIM_PlanetaryInstallation where CargoShuttleValue > 0').all().map((row) => [row.PlanetaryInstallationID, row.CargoShuttleValue]))
  const built = database.query(`select PopID, PlanetaryInstallationID, Amount from FCT_PopulationInstallations where GameID = ${GAME} and Amount > 0`).all()

  return colonies.map((row) => ({ ...row, capacity: built.filter((one) => one.PopID === row.PopulationID && shuttles[one.PlanetaryInstallationID]).reduce((sum, one) => sum + one.Amount * shuttles[one.PlanetaryInstallationID], 0) }))
}

// The Logistics bonuses stored for the race's ship commanders (by ship) and governors (by population).
const oracleBonuses = (database, type) => Object.fromEntries(database.query(`select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.RaceID = ${RACE} and FCT_Commander.CommandType = ${type} and FCT_CommanderBonuses.BonusID = ${LOGISTICS}`).all().map((row) => [row.CommandID, row.BonusValue]))

const oracleTechnology = (database) => database.query(`select CargoShuttleLoadModifier from FCT_Race where RaceID = ${RACE}`).get().CargoShuttleLoadModifier

// ---- The checks ----------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('formula', 'the base strength is the ship\'s own term plus the colony\'s addition and the officers multiply the whole of it, so a bayless freighter of 50,000 t at a colony with a spaceport loads in 500,000 s at technology 1, a ship with 3 bays and a 1.2 commander has 7.2 and not 6.9, a colony with no service adds nothing, and the number of stations makes no difference', async (w) => {
  const { transport } = await w.modules()

  // The worked example: technology 1, no bays at all, a spaceport and no officer bonus: (1 x 1 + 1) x 1 = 2, so 50,000 x 20 / 2 = 500,000 s each way.
  const bayless = at(transport, { tech: 1, extra: { ShuttleStrength: 0, DesignedShuttleStrength: 0 } })

  assert.ok(bayless, 'the 3.1 line has a loading strength')
  near(bayless.own, 1, 'the ship term of a ship with no bays')
  near(bayless.ownTerm, 1)
  near(bayless.additive, 1)
  near(bayless.base, 2)
  near(bayless.strength, 2)

  const freighter = { ShuttleStrength: 0, DesignedShuttleStrength: 0, CargoCapacity: 50000 }
  const load = stopAt(transport, 62, { tech: 1, extra: freighter })
  const unload = stopAt(transport, 63, { tech: 1, extra: freighter })

  assert.equal(load.eligibility.status, 'permitted', 'the spaceport lets the bayless freighter load')
  near(load.seconds, 500000)
  near(unload.seconds, 500000)

  // Three bays at technology 1.5 with the commander's 1.2: (3 x 1.5 + 1.5) x 1.2 = 7.2, where the officer on the ship's own term alone gives 3 x 1.2 x 1.5 + 1.5 = 6.9.
  const three = at(transport, { sup: COMMANDER(), extra: { ShuttleStrength: 3, DesignedShuttleStrength: 3 } })

  assert.ok(three)
  near(three.ownTerm, 4.5)
  near(three.additive, 1.5)
  near(three.base, 6)
  near(three.officers, 1.2)
  near(three.strength, 7.2)
  assert.ok(Math.abs(three.strength - 6.9) > 0.1, 'the officer does not multiply the ship term alone')
  near(stopAt(transport, 62, { sup: COMMANDER(), extra: { ShuttleStrength: 3, DesignedShuttleStrength: 3 } }).seconds, (1000 * 20) / 7.2)

  // Every officer at once, two bays at technology 1.5: (2 x 1.5 + 1.5) x 1.2 x 1.05 x 1.1 x 1.1.
  const full = at(transport, { sup: FULL() })

  near(full.officers, FULL_PRODUCT)
  near(full.base, 4.5)
  near(full.strength, 4.5 * FULL_PRODUCT)
  near(stopAt(transport, 62, { sup: FULL() }).seconds, (1000 * 20) / (4.5 * FULL_PRODUCT))

  // No spaceport or station: nothing is added, and the officers multiply the ship's own term alone, (2 x 1.5) x 1.2 = 3.6.
  const unserved = at(transport, { sup: COMMANDER(), row: { ShuttleCapacity: 0, ServiceNames: '' } })

  near(unserved.additive, 0)
  near(unserved.base, 3)
  near(unserved.strength, 3.6)

  // The colony adds the technology once, however many stations it has.
  for (const stations of [1, 2, 7]) {
    near(at(transport, { sup: FULL(), row: { ShuttleCapacity: stations } }).strength, 4.5 * FULL_PRODUCT, `${stations} stations`)
  }

  // A colony whose service the save does not state has no strength.
  assert.equal(at(transport, { row: { ShuttleCapacity: null } }), null)

  // The rows of the breakdown table carry the base: the ship's own term and the colony's addition together.
  const [row] = transport.handlingRows([{ key: 'a', label: 'Loading', breakdown: stopAt(transport, 62, { sup: COMMANDER(), extra: { ShuttleStrength: 3, DesignedShuttleStrength: 3 } }).breakdown }])

  near(row.ownTerm, 4.5)
  near(row.additive, 1.5)
  near(row.base, 6)
  near(row.strength, 7.2)
})

check('bays', 'a ship of 10 hull spaces or less has a ship term of 1 whatever bays it has, the limit included, a larger ship the undamaged bays\' strength, and 1 for a ship with no bays and a ship with every bay damaged alike, a bay strength below 1 kept, a bay count not in the save giving no strength for a ship over the limit', async (w) => {
  const { transport } = await w.modules()
  const own = (extra) => {
    const found = at(transport, { extra })

    assert.ok(found, 'a strength')

    return found.own
  }

  near(own({ Size: 10, ShuttleStrength: 9, DesignedShuttleStrength: 9 }), 1, 'a craft of 10 hull spaces, the limit included, whatever bays it has')
  near(own({ Size: 5, ShuttleStrength: 0, DesignedShuttleStrength: 0 }), 1, 'a small craft with no bays')
  near(own({ Size: 10.01, ShuttleStrength: 9, DesignedShuttleStrength: 9 }), 9, 'a craft over the limit counts its bays')
  near(own({ Size: 10.01, ShuttleStrength: 0, DesignedShuttleStrength: 0 }), 1, 'a craft over the limit with no bays')
  near(own({ Size: 600, ShuttleStrength: 0, DesignedShuttleStrength: 3 }), 1, 'a freighter with every bay damaged')
  near(own({ Size: 600, ShuttleStrength: 0.4, DesignedShuttleStrength: 0.4 }), 0.4, 'a bay strength below 1 is not raised to 1')
  near(own({ Size: 600, ShuttleStrength: 1, DesignedShuttleStrength: 3 }), 1, 'a freighter with one bay of three undamaged')
  near(own({ Size: 600, ShuttleStrength: 2, DesignedShuttleStrength: 3 }), 2, 'a freighter with two bays of three undamaged')
  assert.equal(at(transport, { extra: { Size: 600, ShuttleStrength: null } }), null, 'a ship over the limit whose bays are not in the save has no strength')
  near(own({ Size: 5, ShuttleStrength: null }), 1, 'a small craft needs no bay count')

  // The own term is the technology times the ship term, and what a bayless ship has is the same with an officer.
  const withOfficer = at(transport, { sup: COMMANDER(), extra: { Size: 600, ShuttleStrength: 0, DesignedShuttleStrength: 3 } })

  assert.ok(withOfficer, 'a strength')
  near(withOfficer.ownTerm, 1.5)
  near(withOfficer.strength, (1.5 + 1.5) * 1.2)
})

check('load-all', 'move action 237 is a cargo load filling the free capacity of the hold at 20 s a tonne on the timer of the other loads, a cycle of orders gives it a time, a hold already filled by another load leaves it nothing to load, and it is not an unload', async (w) => {
  const { transport, hauling } = await w.modules()

  assert.equal(transport.LOADS[237], 'components', 'a load of ship components')
  assert.equal(transport.UNLOADS[237], undefined, 'Load All Ship Components is not an unload')
  assert.equal(transport.transferCategory(237), 'cargo')
  assert.equal(transport.transferCategory(62), 'cargo')
  assert.equal(transport.transferCategory(500), null, 'an action that is not a transfer')

  // At 20 s a tonne, as Load All Minerals: the free capacity x 20 / (strength x crew share).
  const minerals = stopAt(transport, 62, { sup: FULL() })
  const components = stopAt(transport, 237, { sup: FULL() })

  assert.equal(components.eligibility.category, 'cargo')
  assert.equal(components.eligibility.appliesCargoRules, true)
  assert.equal(components.eligibility.status, 'permitted')
  near(components.seconds, (1000 * 20) / (4.5 * FULL_PRODUCT))
  near(components.seconds, minerals.seconds)
  near(stopAt(transport, 237, { sup: FULL(), share: 0.5 }).seconds, minerals.seconds / 2, 'half the hold')
  near(stopAt(transport, 237, { sup: FULL(), extra: { CurrentCrew: 50 } }).seconds, minerals.seconds * 2, 'half the crew')
  near(stopAt(transport, 237, { sup: FULL(), row: UNSERVED, extra: { Size: 5, ShuttleStrength: 0, DesignedShuttleStrength: 0 } }).seconds, (1000 * 20) / (1.5 * FULL_PRODUCT), 'a bayless craft at a colony with no service loads at the technology alone')

  // A cycle that loads components at one colony and unloads them at another: a time for each stop, the one at the colony with no service at the ship's own term alone.
  const fleet = { FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 0, ShuttleTechnology: 1.5 }
  const here = transport.colonyEndpoint(colony())
  const there = transport.colonyEndpoint(colony({ PopName: 'Venus', PopulationID: 8, ...UNSERVED }))
  const handled = (orders, ships = [ship()]) => {
    const cargo = hauling.cycleCargo(orders, fleet)

    return { cargo, handling: hauling.cycleHandling(orders, cargo, fleet, ships, { version: VERSION, support: FULL() }) }
  }

  const carried = handled([order(237, here, 'Mars'), order(189, there, 'Venus')])

  assert.equal(carried.cargo.settled, true, 'a load of components and the unload of them settle')
  assert.deepEqual(carried.cargo.moves.map((move) => move && [move.kind, move.direction, move.amount]), [['components', 'load', 1000], ['components', 'unload', 1000]])
  assert.deepEqual(carried.cargo.deliveries, [{ PopulationID: 8, name: 'Venus', kind: 'components', amount: 1000, sources: [{ from: 7, amount: 1000 }] }], 'the colony that unloads is credited with the components of the colony that loaded them')
  near(carried.cargo.holdShare, 0)
  assert.ok(carried.handling.seconds > 0, 'a fleet with action 237 shows a handling time')
  near(carried.handling.seconds, (1000 * 20) / (4.5 * FULL_PRODUCT) + (1000 * 20) / (3 * NO_GOVERNOR))
  assert.deepEqual(carried.handling.stops.map((stop) => stop.eligibility.status), ['permitted', 'permitted'])

  // Minerals first: the hold is full (a tonne of mineral takes two points of capacity), so the load of components has nothing to move and takes no time.
  const filled = handled([order(62, here, 'Mars'), order(237, here, 'Mars again'), order(63, there, 'Venus')])

  assert.deepEqual(filled.cargo.moves.map((move) => [move.kind, move.direction, move.amount]), [['minerals', 'load', 500], ['components', 'load', 0], ['minerals', 'unload', 500]])
  near(filled.handling.stops[1].seconds, 0)
  assert.equal(filled.cargo.perTrip.minerals, 500)
})

check('components', 'the ship components a load puts in the hold stay in it until an unload takes them: a second load of components finds the hold full, a load of minerals finds the space the components left and the cycle delivers the two kinds apart, Unload All Ship Components (189) and Unload Ship Component (141) take them out, Load Ship Component (140) loads one component, an unload to another fleet is a transfer between ships, and a load of a set number of components has no cycle', async (w) => {
  const { transport, hauling } = await w.modules()

  // What the game's move actions are: 140 loads and 141 and 189 unload ship components (DIM_MoveAction), all at a colony cargo.
  assert.equal(transport.LOADS[140], 'components')
  assert.equal(transport.UNLOADS[141], 'components')
  assert.equal(transport.UNLOADS[189], 'components')
  assert.equal(transport.UNLOADS[140], undefined, 'Load Ship Component is not an unload')
  assert.equal(transport.LOADS[141], undefined, 'Unload Ship Component is not a load')
  assert.equal(transport.LOADS[189], undefined, 'Unload All Ship Components is not a load')

  for (const id of [140, 141, 189, 237]) {
    assert.equal(transport.transferCategory(id), 'cargo', `move action ${id}`)
    assert.equal(transport.transferCategory(id, 2), 'cargo', `move action ${id} at a body`)
  }

  assert.equal(transport.transferCategory(141, 10), 'ship-to-ship', 'Unload Ship Component to a fleet')
  assert.equal(transport.transferCategory(189, 10), 'ship-to-ship', 'Unload All Ship Components to a fleet')
  assert.equal(transport.transferCategory(63, 10), 'cargo', 'only the unloads of components take a fleet')

  const fleet = { FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 0, ShuttleTechnology: 1.5 }
  const here = transport.colonyEndpoint(colony())
  const there = transport.colonyEndpoint(colony({ PopName: 'Venus', PopulationID: 8, ...UNSERVED }))
  const third = transport.colonyEndpoint(colony({ PopName: 'Ceres', PopulationID: 9, ShuttleCapacity: 2, ServiceNames: 'Spaceport, Cargo Shuttle Station' }))
  const cycle = (orders) => hauling.cycleCargo(orders, fleet)
  const shape = (cargo) => cargo.moves.map((move) => move && [move.kind, move.direction, move.amount])

  // Two loads in a row: the first fills the hold, the second finds it full and moves nothing, and the unload takes the components of the first.
  const consecutive = cycle([order(237, here, 'Mars'), order(237, there, 'Venus'), order(189, third, 'Ceres')])

  assert.equal(consecutive.settled, true)
  assert.deepEqual(shape(consecutive), [['components', 'load', 1000], ['components', 'load', 0], ['components', 'unload', 1000]])
  assert.deepEqual(consecutive.deliveries, [{ PopulationID: 9, name: 'Ceres', kind: 'components', amount: 1000, sources: [{ from: 7, amount: 1000 }] }])

  const timed = hauling.cycleHandling([order(237, here, 'Mars'), order(237, there, 'Venus'), order(189, third, 'Ceres')], consecutive, fleet, [ship()], { version: VERSION, support: FULL() })

  near(timed.stops[0].seconds, (1000 * 20) / (4.5 * FULL_PRODUCT), 'the first load fills the hold')
  near(timed.stops[1].seconds, 0, 'the second load finds it full')
  near(timed.stops[2].seconds, (1000 * 20) / (4.5 * NO_GOVERNOR), 'the unload takes what the first load put in')

  // Two loads and nothing that unloads: the hold stays full of components, so a cycle that finds it full loads nothing.
  assert.deepEqual(shape(cycle([order(237, here, 'Mars'), order(237, there, 'Venus')])), [['components', 'load', 0], ['components', 'load', 0]])

  // Components, then minerals: the minerals find no space, and what the unloads take out is the components.
  const mixed = cycle([order(237, here, 'Mars'), order(62, here, 'Mars'), order(189, there, 'Venus'), order(63, there, 'Venus')])

  assert.deepEqual(shape(mixed), [['components', 'load', 1000], ['minerals', 'load', 0], ['components', 'unload', 1000], ['minerals', 'unload', 0]])
  assert.deepEqual(mixed.perTrip, { minerals: 0, installations: 0, colonists: 0 }, 'ship components are not counted in the freight of a trip')

  // Minerals up to 100 t (200 points), then components in the rest of the hold: 800 t.
  const filling = cycle([order(178, here, 'Mars', { MaxItems: 100, DestinationItemID: 1 }), order(237, here, 'Mars'), order(189, there, 'Venus'), order(63, there, 'Venus')])

  assert.deepEqual(shape(filling), [['minerals', 'load', 100], ['components', 'load', 800], ['components', 'unload', 800], ['minerals', 'unload', 100]])
  assert.deepEqual(filling.deliveries.map(({ PopulationID, kind, amount }) => [PopulationID, kind, amount]), [[8, 'components', 800], [8, 'minerals', 100]], 'the colony is credited with each kind apart')
  assert.equal(filling.perTrip.minerals, 100)

  // Components out, then minerals: the whole hold is free again after the unload.
  const alternating = cycle([order(237, here, 'Mars'), order(189, there, 'Venus'), order(62, there, 'Venus'), order(63, here, 'Mars')])

  assert.deepEqual(shape(alternating), [['components', 'load', 1000], ['components', 'unload', 1000], ['minerals', 'load', 500], ['minerals', 'unload', 500]])
  assert.equal(alternating.perTrip.minerals, 500)

  // One component: Load Ship Component names it, Unload Ship Component takes that one only.
  const named = cycle([order(140, here, 'Mars', { DestinationItemID: 5 }), order(140, here, 'Mars', { DestinationItemID: 6 }), order(141, there, 'Venus', { DestinationItemID: 6 }), order(141, third, 'Ceres', { DestinationItemID: 5 })])

  assert.deepEqual(shape(named), [['components', 'load', 1000], ['components', 'load', 0], ['components', 'unload', 0], ['components', 'unload', 1000]], 'the component loaded is the component unloaded')
  assert.deepEqual(named.deliveries.map(({ PopulationID, amount }) => [PopulationID, amount]), [[9, 1000]])
  assert.deepEqual(shape(cycle([order(140, here, 'Mars', { DestinationItemID: 7 }), order(141, there, 'Venus', { DestinationItemID: 7, MaxItems: 10 })])), [['components', 'load', 1000], ['components', 'unload', 1000]], 'Unload Ship Component carries a quantity and ignores it for its matching type')
  assert.deepEqual(shape(cycle([order(237, here, 'Mars'), order(189, there, 'Venus', { MaxItems: 10 })])), [['components', 'load', 1000], ['components', 'unload', 1000]], 'Unload All Ship Components carries a quantity and ignores it')
  assert.deepEqual(shape(cycle([order(140, here, 'Mars', { DestinationItemID: 5 }), order(189, there, 'Venus')])), [['components', 'load', 1000], ['components', 'unload', 1000]], 'a load of one component with no number fills the hold')

  // A load of a set number of components puts in tonnes the order does not give (it carries no size for the component): no cycle is worked out, and no year follows from it.
  const counted = cycle([order(140, here, 'Mars', { DestinationItemID: 5, MaxItems: 3 }), order(189, there, 'Venus')])

  assert.equal(counted.settled, false)
  assert.equal(counted.unmodelled, hauling.CARGO_COUNTED)
  assert.ok(counted.moves.every((move) => move === null), 'no move is published')
  assert.deepEqual([counted.perTrip, counted.deliveries, counted.holdShare], [{ minerals: 0, installations: 0, colonists: 0 }, [], 0])
  assert.equal(hauling.routeYear({ Speed: 10, FuelPerHour: 1 }, { km: 100 }, counted, { blocked: [], unknown: [], seconds: 3600 }), null, 'a cycle with no cargo worked out has no year')
  assert.equal(cycle([order(176, here, 'Mars', { DestinationItemID: 5, MaxItems: 3 }), order(96, there, 'Venus')]).unmodelled, undefined, 'a load of installations by number is the page\'s established one')

  // The fleet-target timer is real, but its existence does not establish a successful unload to a fleet or free the hold.
  const convoy = transport.bareEndpoint('Convoy')
  const toFleet = { ...order(189, convoy, 'Convoy'), DestinationType: 10, SystemID: 3, PopulationID: 0, TargetCargoSupport: 1 }
  const transferred = cycle([order(237, here, 'Mars'), toFleet])

  assert.equal(transferred.settled, false)
  assert.equal(transferred.unmodelled, hauling.CARGO_TRANSFER)
  assert.deepEqual(transferred.deliveries, [], 'a fleet is credited with no colony delivery')
  assert.equal(transferred.ledger.components[0].amount, null, 'no guaranteed empty hold')
  assert.equal(transferred.ledger.components[0].unknownRemainder, true)

  const passed = transport.stopHandling(toFleet, [ship()], 1.5, 1, { version: VERSION, support: FULL() })

  assert.equal(passed.eligibility.category, 'ship-to-ship')
  assert.equal(passed.eligibility.appliesCargoRules, false)
  assert.deepEqual(passed.eligibility.reasons, [])
  near(passed.seconds, Math.floor(20000 / (2 * 1.5 * 1.2 * 1.05 + 1)))

  const stranded = transport.stopHandling({ ...order(189, convoy, 'Open space'), DestinationType: 2 }, [ship()], 1.5, 1, { version: VERSION, support: FULL() })

  assert.equal(stranded.eligibility.category, 'cargo', 'the same order at a body is cargo')
  assert.deepEqual(stranded.eligibility.reasons.map((reason) => reason.code), ['no-colony'])
})

check('component-types', 'bulk composition is unknown even when a typed unload happens to match, not match or match only part of it; the downstream hold and timer are unavailable, while a known matching typed load and unload are exact', async (w) => {
  const { transport, hauling } = await w.modules()
  const fleet = { FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 0, ShuttleTechnology: 1.5, Speed: 10, FuelPerHour: 1 }
  const here = transport.colonyEndpoint(colony())
  const there = transport.colonyEndpoint(colony({ PopulationID: 8, PopName: 'Venus' }))

  // Three possible colony stocks give the same 237 order bytes: all type 7, no type 7, or a mix. The order cannot distinguish them; no oracle composition is injected into the subject.
  for (const stock of [[{ item: 7, tonnes: 1000 }], [{ item: 8, tonnes: 1000 }], [{ item: 7, tonnes: 300 }, { item: 8, tonnes: 700 }]]) {
    const possibleRemoved = stock.filter((entry) => entry.item === 7).reduce((sum, entry) => sum + entry.tonnes, 0)
    const orders = [order(237, here, 'Mars'), order(141, there, 'Venus', { DestinationItemID: 7 }), order(62, there, 'Venus'), order(63, here, 'Mars')]
    const cargo = hauling.cycleCargo(orders, fleet)

    assert.equal(cargo.settled, false, `possible removal ${possibleRemoved} must not be asserted from a bulk order`)
    assert.equal(cargo.unmodelled, hauling.CARGO_COMPOSITION)
    assert.match(cargo.unmodelled, /some or none.*unknown remainder.*no known free space or handling time/)
    assert.deepEqual(cargo.ledger.components, [{ from: 7, item: null, amount: null, maximum: 1000, unknownRemainder: true }])
    assert.deepEqual(cargo.ledger.minerals, [], 'downstream mineral load is not executed with an invented free hold')
    assert.ok(cargo.moves.every((move) => move === null), 'neither an exact unloaded amount nor a downstream load is published')
    const handling = hauling.cycleHandling(orders, cargo, fleet, [ship()], { version: VERSION, support: FULL() })

    assert.equal(handling.seconds, null, 'the downstream timing is not a zero or full-hold exact time')
    assert.ok(handling.stops.every((stop) => stop.seconds === null), 'the unworked stops do not claim exact zero times')
    assert.equal(handling.unknown[0].text, hauling.CARGO_COMPOSITION)
    assert.equal(hauling.routeYear(fleet, { km: 100 }, cargo, handling), null)
  }

  const typed = (item) => hauling.cycleCargo([order(140, here, 'Mars', { DestinationItemID: 7 }), order(141, there, 'Venus', { DestinationItemID: item }), order(62, there, 'Venus'), order(189, here, 'Mars'), order(63, here, 'Mars')], fleet)
  const matching = typed(7)
  const absent = typed(8)

  assert.equal(matching.settled, true)
  assert.deepEqual(matching.moves.map((move) => move.amount), [1000, 1000, 500, 0, 500], 'a known matching typed unload really frees the hold')
  assert.equal(absent.settled, true)
  assert.deepEqual(absent.moves.map((move) => move.amount), [1000, 0, 0, 1000, 0], 'a known non-matching typed unload frees no space')
  near(hauling.cycleHandling([order(140, here, 'Mars', { DestinationItemID: 7 }), order(141, there, 'Venus', { DestinationItemID: 7 }), order(62, there, 'Venus'), order(189, here, 'Mars'), order(63, here, 'Mars')], matching, fleet, [ship()], { version: VERSION, support: FULL() }).stops[2].seconds, 20000 / 4.5 / NO_GOVERNOR)
})

check('fleet-timer', 'both component unloads to a fleet time the selected tonnes with ship-to-ship bays, technology, commander and naval command, then the receiver addition, and crew exactly once; missing receiver inputs are unavailable', async (w) => {
  const { transport } = await w.modules()
  const convoy = transport.bareEndpoint('Convoy')

  for (const action of [141, 189]) {
    for (const addition of [0, 1]) {
      for (const bays of [0, 0.4, 2]) {
        const target = { ...order(action, convoy, 'Convoy'), DestinationType: 10, DestinationItemID: 7, PopulationID: 0, SystemID: 3, TargetCargoSupport: addition }
        const given = ship({ Size: 5, ShuttleStrength: bays, CurrentCrew: 50 })
        const timed = transport.stopHandling(target, [given], 1.5, 0.3, { version: VERSION, support: FULL() })
        const strength = (bays === 0 ? 1 : bays) * 1.5 * 1.2 * 1.05 + addition

        assert.equal(timed.eligibility.status, 'permitted')
        near(timed.strength, strength, 'no small-craft exemption, governor or sector; receiver +1 after officers and technology')
        near(timed.seconds, Math.floor(300 * 20 / strength / 0.5))
        assert.ok(timed.seconds > 0, 'a fleet unload is not instantaneous')
        assert.deepEqual(timed.breakdown.factors.map((factor) => factor.key), ['commander', 'admin'])
        const missing = transport.stopHandling({ ...target, TargetCargoSupport: null }, [given], 1.5, 0.3, { version: VERSION, support: FULL() })

        assert.equal(missing.seconds, null)
        assert.deepEqual(missing.eligibility.reasons.map((reason) => reason.code), ['receiver-support'])
      }
    }
  }

  const target = { ...order(189, convoy, 'Convoy'), DestinationType: 10, SystemID: 3, TargetCargoSupport: 1 }
  const slow = transport.stopHandling(target, [ship(), ship({ ShipID: 2, ShipName: 'Slow', CurrentCrew: 25 })], 1.5, 1, { version: VERSION, support: FULL() })

  near(slow.seconds, Math.floor(20000 / (2 * 1.5 * 1.05 + 1) / 0.25), 'the fleet takes the slowest ship, not the sum')
  assert.equal(slow.limiting.ShipName, 'Slow')
  assert.equal(transport.stopHandling(target, [ship({ CurrentCrew: 0 })], 1.5, 1, { version: VERSION, support: FULL() }).seconds, null)
})

check('component-display', 'a rendered components-only route reports delivered components not counted in tonnage, never no cargo; mixed freight keeps that qualification', async (w) => {
  const page = await w.page()
  const base = { FleetID: 5, OrderDelay: 0, Jumps: 0, X: 0, Y: 0, ExitX: 0, ExitY: 0, ExitSystemID: 3, SystemID: 3, DestinationType: 2, MaxItems: 0 }
  const load = { ...base, MoveActionID: 237, ActionName: 'Load All Ship Components', Description: 'Mars', PopulationID: 7, PopName: 'Mars', ShuttleCapacity: 1 }
  const unload = { ...base, MoveActionID: 189, ActionName: 'Unload All Ship Components', Description: 'Venus', PopulationID: 8, PopName: 'Venus', ShuttleCapacity: 0, X: 1000000, ExitX: 1000000 }
  const carrier = ship({ MaxSpeed: 1000, EnginePower: 20, UndamagedEnginePower: 20, FuelEfficiency: 0.5, FuelCapacity: 1e9, Fuel: 1e9, OverhaulFactor: 1, GradePoints: 100, CrewMorale: 1, SensorDelay: 0, MothershipID: 0, TractorTargetShipID: 0, TractorParentShipID: 0, TractorTargetShipyardID: 0, MilitaryEngines: 0, ShuttleTechnology: 1.5, FleetSpeed: 1000, UseMaximumSpeed: 1 })
  const movedSlot = w.texts.haulingPage.slice(w.texts.haulingPage.indexOf('<template #[`item.movedSort`]'), w.texts.haulingPage.indexOf('<template #[`item.fuelSort`]'))
  const rendered = renderTree(`<template><v-data-table>${movedSlot}</v-data-table></template>`, {})
  const table = treeOf(rendered.tree).find((node) => node.tag === 'v-data-table')
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join(' ') : node && typeof node === 'object' ? textOf(node.children) : typeof node === 'string' ? node : ''

  assert.deepEqual(rendered.errors, [])
  for (const mixed of [false, true]) {
    const orders = mixed ? [{ ...load, MoveActionID: 178, DestinationItemID: 1, MaxItems: 100 }, load, unload, { ...unload, MoveActionID: 63 }] : [load, unload]
    const vm = instantiate(page, { $store: { getters: {}, state: {} }, GameID: 1, RaceID: 2, data: { loadErrors: new Proxy({}, { get: () => null }), handlingSupport: FULL(), formulaVersion: VERSION, fleets: [{ FleetID: 5, FleetName: 'Components', Speed: 1000, Ships: 1, ShuttleTechnology: 1.5 }], fleetShips: [carrier], orders, simulateRoute: () => null } })
    const [row] = vm.routeRows

    assert.ok(row.year, `the components route has a year to display: ${row.profileText}; ${row.unknownText}; ${row.blockedText}`)
    assert.equal(row.componentsText, 'Components delivered, not counted in tonnage')
    const text = textOf(table.data.scopedSlots['item.movedSort']({ item: row }))

    assert.match(text, /Components delivered, not counted in tonnage/)
    assert.doesNotMatch(text, /No cargo delivered/)
    assert.equal(Boolean(row.freightText), mixed)
  }
})

check('unserved', 'a ship with its crew aboard loads and unloads at a colony with no spaceport or cargo shuttle station whatever bays it has, a craft of 10 hull spaces or less and a ship over it with no bays or with every bay damaged at the technology alone and a ship with bays at the technology times its bays, in the stop, the Transport round trip and the Hauling cycle alike, with no verdict only for an input that is not known', async (w) => {
  const { transport, hauling, provenance } = await w.modules()
  const TECH = 1.5
  const bare = transport.colonyEndpoint(colony(UNSERVED))
  const other = transport.colonyEndpoint(colony({ PopName: 'Venus', PopulationID: 8, ...UNSERVED }))
  const CRAFT = /a craft of 500 t or less/
  const BAYS = /undamaged cargo shuttle bays/
  const ONE = /one bay counted for a ship with no undamaged cargo shuttle bays/
  const cases = [
    ['a bayless craft of 5 hull spaces', { Size: 5, ShuttleStrength: 0, DesignedShuttleStrength: 0 }, 1, CRAFT],
    ['a bayless craft of 10 hull spaces, the limit included', { Size: 10, ShuttleStrength: 0, DesignedShuttleStrength: 0 }, 1, CRAFT],
    ['a craft of 10 hull spaces with bays of strength 3', { Size: 10, ShuttleStrength: 3, DesignedShuttleStrength: 3 }, 1, BAYS],
    ['a bayless ship of 10.5 hull spaces', { Size: 10.5, ShuttleStrength: 0, DesignedShuttleStrength: 0 }, 1, ONE],
    ['a bayless freighter of 600 hull spaces', { Size: 600, ShuttleStrength: 0, DesignedShuttleStrength: 0 }, 1, ONE],
    ['a freighter of 600 hull spaces with every bay of three damaged', { Size: 600, ShuttleStrength: 0, DesignedShuttleStrength: 3 }, 1, ONE],
    ['a freighter with bays of strength 2', { Size: 600, ShuttleStrength: 2, DesignedShuttleStrength: 2 }, 2, BAYS],
    ['a freighter with two of five bays undamaged', { Size: 600, ShuttleStrength: 2, DesignedShuttleStrength: 5 }, 2, BAYS],
  ]
  const fleet = { FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 0, ShuttleTechnology: TECH }
  const aloft = { MaxSpeed: 1000, EnginePower: 100, FuelEfficiency: 1, FuelCapacity: 1e12 }

  for (const [label, extra, own, via] of cases) {
    const given = ship(extra)
    const strength = own * TECH * FULL_PRODUCT
    const seconds = (1000 * 20) / strength
    const farSeconds = (1000 * 20) / (own * TECH * NO_GOVERNOR)
    const verdict = transport.shipEligibility(given, bare, VERSION)

    assert.equal(verdict.status, 'permitted', `${label}: the verdict`)
    assert.ok(verdict.via.some((entry) => via.test(entry)), `${label}: what lets it load is ${verdict.via.join('; ')}`)

    // The stop: a load and an unload of each cargo, at the ship's own term alone and the officers' product.
    for (const action of [62, 63, 237, 189]) {
      const stop = stopAt(transport, action, { sup: FULL(), row: UNSERVED, extra })

      assert.equal(stop.eligibility.status, 'permitted', `${label}: action ${action}`)
      near(stop.strength, strength, `${label}: action ${action} strength`)
      near(stop.seconds, seconds, `${label}: action ${action} time`)
    }

    // The Transport round trip between two colonies with no service: no problem, the time of both stops, the rule verified for the line.
    const trip = transport.roundTrip([{ ...given, ...aloft }], 1e6, { origin: bare, destination: other }, TECH, { colonists: false, version: VERSION, support: FULL() })

    assert.equal(trip.status, 'ok', `${label}: the round trip is ${trip.status}: ${trip.problems.map((problem) => problem.text).join('; ')}`)
    assert.deepEqual(trip.problems, [], `${label}: no problem`)
    assert.equal(trip.versionSupported, true, `${label}: the rule is verified for the line`)
    near(trip.handlingSeconds, seconds + farSeconds, `${label}: both stops`)
    near(trip.tripSeconds, 2e6 / 1000 + seconds + farSeconds, `${label}: the round trip`)

    const shown = transport.tripResult(trip)

    assert.ok(provenance.isAvailable(shown), `${label}: the displayed time is available`)
    assert.ok(!shown.assumptions.includes(transport.UNVERIFIED_VERSION), `${label}: no unverified landing rule is assumed`)
    near(shown.value, (2e6 / 1000 + seconds + farSeconds) / 86400, `${label}: the displayed time`)

    // The Hauling cycle of a load at one colony and an unload at the other.
    const orders = [order(62, bare, 'Mars'), order(63, other, 'Venus')]
    const cargo = hauling.cycleCargo(orders, fleet)
    const handling = hauling.cycleHandling(orders, cargo, fleet, [given], { version: VERSION, support: FULL() })

    assert.deepEqual([handling.blocked, handling.unknown], [[], []], `${label}: nothing blocked or unknown in the cycle`)
    assert.equal(handling.versionSupported, true)
    near(handling.seconds, seconds + farSeconds, `${label}: the cycle's stops`)

    const year = hauling.routeYear({ Speed: 1000, FuelPerHour: 1 }, { km: 1e6 }, cargo, handling)

    assert.ok(year, `${label}: the route has a year`)
    near(year.cycleDays * 86400, 1e6 / 1000 + seconds + farSeconds, `${label}: the cycle`)

    const results = hauling.routeResults({ km: 1e6 }, year, handling)

    assert.ok(provenance.isAvailable(results.cycle) && provenance.isAvailable(results.freight), `${label}: the displayed cycle and freight are available`)
    assert.ok(!results.cycle.assumptions.includes(transport.UNVERIFIED_VERSION), `${label}: no unverified landing rule is assumed in the cycle`)
  }

  // What is still not known stays unknown, and a ship that cannot load is still blocked.
  const bayless = { Size: 600, ShuttleStrength: 0, DesignedShuttleStrength: 0 }

  assert.equal(transport.shipEligibility(ship({ Size: 600, ShuttleStrength: null }), bare, VERSION).status, 'permitted', 'bays not in the save do not decide the verdict')

  const unknownBays = stopAt(transport, 62, { row: UNSERVED, extra: { Size: 600, ShuttleStrength: null } })

  assert.equal(unknownBays.seconds, null, 'but the strength, so the time, needs them')
  assert.deepEqual(unknownBays.eligibility.reasons.map((reason) => [reason.status, reason.code]), [['unsupported', 'bays']])

  const unknownService = stopAt(transport, 62, { row: { ShuttleCapacity: null }, extra: bayless })

  assert.equal(unknownService.eligibility.status, 'unsupported')
  assert.equal(unknownService.seconds, null, 'a colony whose service is not in the save has no strength')
  assert.deepEqual(unknownService.eligibility.reasons.map((reason) => reason.code), ['service'])
  assert.equal(transport.shipEligibility(ship(bayless), transport.colonyEndpoint(colony({ ShuttleCapacity: null })), VERSION).status, 'permitted', 'and the verdict does not wait for it')

  const noRules = transport.shipEligibility(ship(bayless), bare, null)

  assert.equal(noRules.status, 'unsupported', 'a save that states no game rules gets no verdict')
  assert.deepEqual(noRules.reasons.map((reason) => reason.code), ['landing-unverified'])
  assert.deepEqual(transport.shipEligibility(ship({ ...bayless, CurrentCrew: 0 }), bare, VERSION).reasons.map((reason) => [reason.status, reason.code]), [['blocked', 'crew']], 'no crew aboard')
  assert.deepEqual(transport.shipEligibility(ship({ ...bayless, CurrentCrew: null }), bare, VERSION).reasons.map((reason) => [reason.status, reason.code]), [['unsupported', 'crew']], 'a crew not in the save')
  assert.deepEqual(transport.shipEligibility(ship(bayless), transport.bareEndpoint('Open space'), VERSION).reasons.map((reason) => [reason.status, reason.code]), [['blocked', 'no-colony']], 'a place with no colony')

  // The earlier line keeps its landing rule: a craft of 10 hull spaces or less lands, a bayless or bay-damaged ship over it does not, at a colony with no service.
  assert.equal(transport.shipEligibility(ship({ Size: 5, ShuttleStrength: 0, DesignedShuttleStrength: 0 }), bare, '2.7.1').status, 'permitted')
  assert.deepEqual(transport.shipEligibility(ship(bayless), bare, '2.7.1').reasons.map((reason) => [reason.status, reason.code]), [['blocked', 'no-bays']])
  assert.deepEqual(transport.shipEligibility(ship({ Size: 600, ShuttleStrength: 0, DesignedShuttleStrength: 3 }), bare, '2.7.1').reasons.map((reason) => [reason.status, reason.code]), [['blocked', 'damaged-bays']])
})

check('versions', 'the loading rules hold for the 3.1 line only (the order of the officers and the colony\'s addition and the zero-bay ship term are that line\'s), the landing rule stays registered for 2.7 alone while the 10 hull space limit of the ship term is the 3.1 line\'s own, a ship with no bays has a verdict on 3.1, a colony with a spaceport lets the ship load, the officers\' rule is the 3.1 one, and the members of the source are cited in a comment above each rule while the notes, which a tooltip shows, name none', async (w) => {
  const { transport, provenance } = await w.modules()
  const versions = (id) => (provenance.getRule(id) || {}).versions
  const note = (id) => (provenance.getRule(id) || {}).note || ''

  for (const id of ['transport.cargoEligibility', 'transport.handlingStrength', 'transport.ownStrength', 'transport.shuttleTechnology', 'transport.colonyAddition', 'transport.handlingTime', 'transport.logisticsBonuses']) {
    assert.deepEqual(versions(id), ['3.1.x'], `${id} is a 3.1 rule`)
  }

  assert.deepEqual(versions('transport.landingThreshold'), ['2.7.x'], 'the landing rule is the 2.7 line\'s')
  assert.equal(transport.landingThreshold('3.1.x'), 10, 'the shuttle limit of the 3.1 source is 10 hull spaces')
  assert.equal(transport.landingThreshold('2.7.1'), 10)
  assert.equal(transport.landingThreshold(null), null, 'a save that states no game rules has no limit')
  assert.ok(at(transport, { extra: { Size: 20, ShuttleStrength: 0, DesignedShuttleStrength: 0 } }).strength > 0, 'a bayless freighter has a strength on the 3.1 line')
  assert.equal(transport.handlingBreakdown(ship(), transport.colonyEndpoint(colony()), 1.5, '2.7.1', support()), null, 'the 2.7 line has no loading strength of this rule')

  const bareColony = transport.colonyEndpoint(colony(UNSERVED))
  const bayless = ship({ ShuttleStrength: 0, DesignedShuttleStrength: 0 })

  assert.equal(transport.shipEligibility(bayless, bareColony, VERSION).status, 'permitted', 'a bayless freighter at a colony with no service loads on the 3.1 line')
  assert.equal(transport.shipEligibility(bayless, transport.colonyEndpoint(colony()), VERSION).status, 'permitted', 'a spaceport lets it load')
  assert.equal(transport.shipEligibility(ship(), bareColony, VERSION).status, 'permitted', 'undamaged bays let it load')

  // The evidence of the rules is the source's members, cited in the comment above the registration; a note is shown in a tooltip and names none of them.
  const cited = (id) => {
    const text = w.texts.transport
    const at = text.indexOf(`  id: '${id}'`)

    return text.slice(text.lastIndexOf('\n\n', at), at)
  }

  for (const member of ['Ship.GetCargoShuttleTransferMultiplier', 'Ship.LoadShipComponentsFromPopulation', 'Ship.UnloadShipComponentsToPopulation', 'HasSelfShuttledCargoCapacity', 'Commander.method_5']) {
    assert.ok(cited('transport.cargoEligibility').includes(member), `the comment of the eligibility rule cites ${member}`)
  }

  assert.ok(cited('transport.ownStrength').includes('Ship.method_159') && cited('transport.ownStrength').includes('Size <= 10m'), 'the comment of the own strength cites the zero-bay helper and the limit')

  for (const id of ['transport.landingThreshold', 'transport.cargoEligibility', 'transport.ownStrength', 'transport.handlingTime']) {
    assert.ok(!/\bShip\.|\bFleet\.|\bCommander\.|HasSelfShuttled|method_\d+|\.cs\b/.test(note(id)), `the note of ${id} names a member of the source`)
  }

  assert.ok(note('transport.cargoEligibility').includes('a bayless ship over 10 hull spaces at a colony with neither service at the technology alone'), 'the note states the condition')
})

check('footers', 'the footers of Hauling and Information say that a ship over 500 t with no undamaged cargo shuttle bays counts one bay and so loads at a colony with no spaceport or cargo shuttle station at the technology alone, and no longer that loading there is not settled', async (w) => {
  const planned = w.texts.haulingPage
  const informed = w.texts.informationPage

  assert.ok(planned.includes('counts one bay, so it loads at a colony with no spaceport or cargo shuttle station at the technology alone; a stop whose ability to load isn\'t known is named with the reason and has no time'), 'the plan footer of Hauling')
  assert.ok(planned.includes('counts one bay, so it loads and unloads at a colony with no spaceport or cargo shuttle station at the technology alone; a route where it isn\'t known whether a ship can load or unload is named with the reason and left out of the totals'), 'the routes footer of Hauling')
  assert.ok(informed.includes('counts one bay, so it loads at a colony with no spaceport or cargo shuttle station at the technology alone; a class whose ability to load is not known has no time, trips or fuel'), 'the footer of Information')
  assert.ok(planned.includes('Ship components a route loads stay in the hold until an order unloads them'), 'the routes footer of Hauling says components stay in the hold')

  for (const [name, text] of [['Hauling', planned], ['Information', informed]]) {
    assert.ok(!/with no spaceport or cargo shuttle station is not settled/.test(text), `the footer of ${name} still says loading at a colony with no service is not settled`)
  }
})

// ---- The fixture ---------------------------------------------------------------------------------------------------------
check('fixture', 'on the fixture the loaders\' ship columns, colony service, race technology and officers\' bonuses equal what is worked out here from the stored rows, and the strength and loading time of the fleet\'s ships at a colony with a spaceport and at one without equal the rule\'s figure from those rows, for the ships as saved, a freighter class built without bays, ships with bays damaged and a class cut to 10 and to 15 hull spaces', async (w) => {
  const { transport, 'handling-support': handlingSupport } = await w.modules()
  const { intact, bayless, damaged, ten, fifteen } = clones()
  const loaded = (database) => ({ ships: oracleShips(database), colonies: oracleColonies(database) })

  // The loaders' own columns, by the page's queries, against the figures worked out here.
  const shipsRead = async (database) => (await loaderOf(database).query(`select FCT_Ship.ShipID, FCT_Ship.CurrentCrew, FCT_ShipClass.Size, ${transport.SHUTTLE_STRENGTH_COLUMNS} from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GAME} and FCT_Ship.RaceID = ${RACE} order by FCT_Ship.ShipID`))[0]
  const coloniesRead = async (database) => (await loaderOf(database).query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, ${transport.SHUTTLE_SERVICE_COLUMNS} from FCT_Population ${transport.shuttleServiceJoin(GAME, 'FCT_Population.PopulationID')} where FCT_Population.GameID = ${GAME} and FCT_Population.RaceID = ${RACE} order by FCT_Population.PopulationID`))[0]

  for (const [label, database] of [['as saved', intact], ['a class with no bays', bayless], ['bays damaged', damaged], ['a class of 10 hull spaces', ten], ['a class of 15 hull spaces', fifteen]]) {
    const worked = loaded(database)
    const read = await shipsRead(database)

    assert.equal(read.length, worked.ships.length, `${label}: the ships`)
    assert.ok(worked.ships.length > 1000, `${label}: the fixture's ships`)
    read.forEach((row, index) => {
      near(row.ShuttleStrength, worked.ships[index].bays, `${label}: ship ${row.ShipID} undamaged bays`)
      near(row.DesignedShuttleStrength, worked.ships[index].designed, `${label}: ship ${row.ShipID} designed bays`)
    })

    const colonies = await coloniesRead(database)

    assert.equal(colonies.length, worked.colonies.length, `${label}: the colonies`)
    colonies.forEach((row, index) => near(row.ShuttleCapacity, worked.colonies[index].capacity, `${label}: colony ${row.PopulationID} cargo shuttle capacity`))
  }

  const worked = loaded(intact)
  const served = worked.colonies.filter((row) => row.capacity >= 1)
  const unserved = worked.colonies.filter((row) => row.capacity === 0)

  assert.ok(served.length >= 10 && unserved.length >= 10, 'the fixture has colonies with a spaceport and without')
  assert.ok(worked.colonies.some((row) => row.capacity > 1), 'a colony with several stations')

  // The race's technology and the officers' bonuses, read by the loaders the pages use.
  const tech = oracleTechnology(intact)
  const [[race]] = await loaderOf(intact).query(`select FCT_Race.CargoShuttleLoadModifier from FCT_Race where FCT_Race.RaceID = ${RACE}`)

  assert.equal(race.CargoShuttleLoadModifier, tech)
  assert.ok(tech > 0, 'the race has a technology')

  const officers = await handlingSupport.loadHandlingSupport(loaderOf(intact), { GameID: GAME, RaceID: RACE })
  const captains = oracleBonuses(intact, 1)
  const governors = oracleBonuses(intact, 3)

  assert.equal(officers.mode, 'loaded')
  assert.deepEqual(officers.commanders, captains, 'the ship commanders\' Logistics bonuses')
  assert.deepEqual(officers.governors, governors, 'the governors\' Logistics bonuses')
  assert.ok(Object.values(captains).some((value) => value > 1) && Object.values(governors).some((value) => value > 1), 'the fixture has captains and governors with a bonus')

  // The ships tried: of each class that carries cargo, one with a commander's bonus and one without, and a warship; the colonies: with a governor's bonus and a spaceport, with a spaceport and none, with several stations, with none.
  const carriers = worked.ships.filter((row) => row.CargoCapacity > 0)
  const classes = [...new Set(carriers.map((row) => row.ShipClassID))]
  const picked = classes.flatMap((classId) => {
    const members = carriers.filter((row) => row.ShipClassID === classId)

    return [members.find((row) => captains[row.ShipID] > 1), members.find((row) => !(captains[row.ShipID] > 1))].filter(Boolean)
  })
  const places = [served.find((row) => governors[row.PopulationID] > 1), served.find((row) => !(governors[row.PopulationID] > 1)), worked.colonies.find((row) => row.capacity > 1), unserved.find((row) => governors[row.PopulationID] > 1), unserved.find((row) => !(governors[row.PopulationID] > 1))].filter(Boolean)

  assert.ok(picked.length >= 5 && picked.some((row) => captains[row.ShipID] > 1) && picked.some((row) => !(captains[row.ShipID] > 1)) && places.length >= 4, 'the ships and colonies tried: captains with and without a bonus, colonies with and without service')

  const rowOf = (row) => ({ ...row, ShuttleStrength: row.bays, DesignedShuttleStrength: row.designed })
  const compare = async (database, label, ships) => {
    const sup = await handlingSupport.loadHandlingSupport(loaderOf(database), { GameID: GAME, RaceID: RACE })

    for (const row of ships) {
      for (const place of places) {
        const endpoint = transport.colonyEndpoint({ PopName: place.PopName, PopulationID: place.PopulationID, SystemID: place.SystemID, ShuttleCapacity: place.capacity, ServiceNames: place.capacity ? 'service' : '' })
        const given = rowOf(row)
        const found = transport.handlingBreakdown(given, endpoint, tech, VERSION, sup)
        const where = `${label}: ${row.ShipName} (${row.ClassName}) at ${place.PopName}`

        assert.ok(found, `${where}: a strength`)

        const bays = row.Size <= 10 ? 1 : row.bays === 0 ? 1 : row.bays
        const product = found.factors.reduce((all, factor) => (factor.state === 'applies' ? all * factor.value : all), 1)
        const factor = (key) => found.factors.find((one) => one.key === key)

        if (captains[row.ShipID] > 1) {
          assert.equal(factor('commander').state, 'applies', `${where}: the commander's bonus`)
          near(factor('commander').value, captains[row.ShipID], `${where}: the commander's bonus`)
        } else {
          assert.notEqual(factor('commander').state, 'applies', `${where}: no commander's bonus`)
        }

        if (governors[place.PopulationID] > 1) {
          near(factor('governor').value, governors[place.PopulationID], `${where}: the governor's bonus`)
        } else {
          assert.notEqual(factor('governor').state, 'applies', `${where}: no governor's bonus`)
        }

        assert.ok(found.factors.every((one) => one.state !== 'unknown'), `${where}: the officers are all settled`)
        near(found.officers, product, `${where}: the officers' product`)
        near(found.strength, (bays * tech + (place.capacity >= 1 ? tech : 0)) * product, `${where}: strength`)

        const stop = transport.stopHandling({ MoveActionID: 62, endpoint }, [given], tech, 1, { version: VERSION, support: sup })
        const share = Math.min(1, row.CurrentCrew / row.ClassCrew)
        // The loader proceeds whenever the transfer multiplier is not zero and the ship term never is (a ship with no undamaged bay counts one, a craft of 10 hull spaces or less the technology): a ship with its crew aboard loads at a colony with no service, with bays or without, and its time is the rule's.
        assert.equal(stop.eligibility.status, 'permitted', `${where}: the verdict`)
        near(stop.seconds, (row.CargoCapacity * 20) / (found.strength * share), `${where}: loading time`)
      }
    }
  }

  await compare(intact, 'as saved', [...picked, ...worked.ships.filter((row) => row.CargoCapacity === 0).slice(0, 3)])

  // A freighter class built without bays (the fixture has none over 10 hull spaces): its ship term is one, on the loaders' own rows.
  const baylessShips = oracleShips(bayless).filter((row) => row.ShipClassID === ONE_BAY_CLASS)

  assert.ok(baylessShips.length > 50 && baylessShips.every((row) => row.bays === 0 && row.Size > 10), 'the planted class has no bays and is over 10 hull spaces')
  await compare(bayless, 'a class with no bays', baylessShips.slice(0, 2))

  // A ship with its one bay damaged has none undamaged, so one; a ship with three of five bays damaged has two.
  const hurt = oracleShips(damaged)
  const oneDamaged = hurt.find((row) => row.ShipID === CLONES.damagedOneBay)
  const threeDamaged = hurt.find((row) => row.ShipID === CLONES.damagedFiveBays)

  near(oneDamaged.bays, 0)
  near(oneDamaged.designed, 1)
  near(threeDamaged.bays, 2)
  near(threeDamaged.designed, 5)
  await compare(damaged, 'bays damaged', [oneDamaged, threeDamaged])

  // A class of five bays cut to 10 hull spaces (the limit included) has a ship term of one, cut to 15 its five bays.
  for (const [label, database, bays] of [['a class of 10 hull spaces', ten, 1], ['a class of 15 hull spaces', fifteen, 5]]) {
    const cut = oracleShips(database).filter((row) => row.ShipClassID === FIVE_BAY_CLASS)
    const found = transport.handlingBreakdown({ ...cut[0], ShuttleStrength: cut[0].bays, DesignedShuttleStrength: cut[0].designed }, transport.colonyEndpoint({ PopName: 'x', PopulationID: 1, SystemID: 1, ShuttleCapacity: 1, ServiceNames: 'x' }), tech, VERSION, null)

    assert.ok(found, `${label}: a strength`)
    near(found.own, bays, `${label}: the ship term`)
    await compare(database, label, cut.slice(0, 2))
  }
})

const FRESH_LOADS = [356308, 3629660, 3629790, 3629923, 3630056, 3630130]

check('recorded', 'of the loads in progress the migrated save stores a time for, six equal the rule\'s time for the fleet to load a full hold at the colony to the second (the game keeps whole seconds, these are loads that have just begun), the time of each of the rest is no longer than that full time, and the order of the officers and the colony\'s addition before the 3.1 line matches none of them', async (w) => {
  const { transport, 'handling-support': handlingSupport } = await w.modules()
  const { intact } = clones()
  const ships = oracleShips(intact)
  const colonies = Object.fromEntries(oracleColonies(intact).map((row) => [row.PopulationID, row]))
  const tech = oracleTechnology(intact)
  const sup = await handlingSupport.loadHandlingSupport(loaderOf(intact), { GameID: GAME, RaceID: RACE })
  const orders = intact.query(`select FCT_MoveOrders.MoveOrderID, FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.TimeRequired, FCT_MoveOrders.PopulationID from FCT_MoveOrders where FCT_MoveOrders.GameID = ${GAME} and FCT_MoveOrders.TimeRequired > 0 and FCT_MoveOrders.Arrived = 1`).all()
  const loads = orders.filter((row) => transport.LOADS[row.MoveActionID] && transport.LOADS[row.MoveActionID] !== 'colonists' && colonies[row.PopulationID])
  const exact = []
  const earlier = []
  let compared = 0

  for (const order of loads) {
    const place = colonies[order.PopulationID]
    const endpoint = transport.colonyEndpoint({ PopName: place.PopName, PopulationID: place.PopulationID, SystemID: place.SystemID, ShuttleCapacity: place.capacity, ServiceNames: place.capacity ? 'service' : '' })
    const fleet = ships.filter((row) => row.FleetID === order.FleetID && row.CargoCapacity > 0).map((row) => ({ ...row, ShuttleStrength: row.bays, DesignedShuttleStrength: row.designed }))

    if (!fleet.length) {
      continue
    }

    const stop = transport.stopHandling({ MoveActionID: 62, endpoint }, fleet, tech, 1, { version: VERSION, support: sup })

    assert.ok(Number.isFinite(stop.seconds), `order ${order.MoveOrderID}: a time`)
    assert.ok(stop.seconds + 1 >= order.TimeRequired, `order ${order.MoveOrderID}: the full-hold time ${stop.seconds} s is shorter than the time ${order.TimeRequired} s still to run`)
    compared += 1

    if (Math.floor(stop.seconds) === order.TimeRequired) {
      exact.push(order.MoveOrderID)
    }

    // The earlier order, worked here from the same terms: the officers multiply the ship's own term alone and the colony's addition comes after.
    const slowest = Math.max(...fleet.map((row) => {
      const found = transport.handlingBreakdown(row, endpoint, tech, VERSION, sup)

      return (row.CargoCapacity * 20) / ((found.ownTerm * found.officers + found.additive) * Math.min(1, row.CurrentCrew / row.ClassCrew))
    }))

    if (Math.floor(slowest) === order.TimeRequired) {
      earlier.push(order.MoveOrderID)
    }
  }

  assert.ok(compared >= 20, `${compared} loads in progress compared`)
  assert.deepEqual(exact.sort((a, b) => a - b), [...FRESH_LOADS].sort((a, b) => a - b), 'the loads whose stored time is the full time of the hold')
  assert.deepEqual(earlier, [], 'the earlier order of the officers and the colony\'s addition matches none of them')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------------
const FAULTS = [
  { name: 'the colony\'s addition is left out of the officers\' product', target: 'transport', from: 'strength: base * stack.product', to: 'strength: ownTerm * stack.product + additive', fails: ['formula', 'fixture', 'recorded'] },
  { name: 'the officers multiply nothing', target: 'transport', from: 'strength: base * stack.product', to: 'strength: base', fails: ['formula', 'fixture', 'recorded'] },
  { name: 'the officers multiply the colony\'s addition alone', target: 'transport', from: 'strength: base * stack.product', to: 'strength: ownTerm + additive * stack.product', fails: ['formula', 'fixture', 'recorded'] },
  { name: 'the colony adds the technology twice', target: 'transport', from: 'const additive = endpoint.service ? shuttleTechnology : 0', to: 'const additive = endpoint.service ? shuttleTechnology * 2 : 0', fails: ['formula', 'fixture', 'recorded'] },
  { name: 'the colony adds its own term, not the technology', target: 'transport', from: 'const additive = endpoint.service ? shuttleTechnology : 0', to: 'const additive = endpoint.service ? own * shuttleTechnology : 0', fails: ['formula', 'fixture'] },
  { name: 'the colony never adds anything', target: 'transport', from: 'const additive = endpoint.service ? shuttleTechnology : 0', to: 'const additive = 0', fails: ['formula', 'fixture', 'load-all', 'recorded'] },
  { name: 'a ship with no undamaged bays has a ship term of zero', target: 'transport', from: 'const own = ship.Size <= SMALL_CRAFT_SIZE || !(ship.ShuttleStrength > 0) ? 1 : ship.ShuttleStrength', to: 'const own = ship.Size <= SMALL_CRAFT_SIZE ? 1 : ship.ShuttleStrength', fails: ['formula', 'bays', 'fixture'] },
  { name: 'a ship of 10 hull spaces or less counts its bays', target: 'transport', from: 'const own = ship.Size <= SMALL_CRAFT_SIZE || !(ship.ShuttleStrength > 0) ? 1 : ship.ShuttleStrength', to: 'const own = !(ship.ShuttleStrength > 0) ? 1 : ship.ShuttleStrength', fails: ['bays', 'fixture'] },
  { name: 'a bay strength below one is raised to one', target: 'transport', from: 'const own = ship.Size <= SMALL_CRAFT_SIZE || !(ship.ShuttleStrength > 0) ? 1 : ship.ShuttleStrength', to: 'const own = ship.Size <= SMALL_CRAFT_SIZE || !(ship.ShuttleStrength >= 1) ? 1 : ship.ShuttleStrength', fails: ['bays'] },
  { name: 'the limit of the small craft excludes 10 hull spaces', target: 'transport', from: 'ship.Size <= SMALL_CRAFT_SIZE || !(ship.ShuttleStrength > 0)', to: 'ship.Size < SMALL_CRAFT_SIZE || !(ship.ShuttleStrength > 0)', fails: ['bays'] },
  { name: 'the own term leaves out the technology', target: 'transport', from: 'const ownTerm = own * shuttleTechnology', to: 'const ownTerm = own', fails: ['formula', 'bays', 'fixture', 'recorded'] },
  { name: 'the base leaves out the colony\'s addition', target: 'transport', from: 'const base = ownTerm + additive', to: 'const base = ownTerm', fails: ['formula', 'load-all', 'recorded'] },
  { name: 'Load All Ship Components is not a load', target: 'transport', from: ", 237: 'components' }", to: ' }', fails: ['load-all'] },
  { name: 'a load of components takes ten seconds a tonne', target: 'transport', from: 'installations: 20, components: 20, colonists: 10', to: 'installations: 20, components: 10, colonists: 10', fails: ['load-all'] },
  { name: 'a load of components takes no time', target: 'transport', from: 'installations: 20, components: 20, colonists: 10', to: 'installations: 20, components: 0, colonists: 10', fails: ['load-all'] },
  { name: 'a tonne of components takes two points of the hold', target: 'hauling', from: 'installations: 1, components: 1 }', to: 'installations: 1, components: 2 }', fails: ['load-all'] },
  { name: 'a cycle drops the components it loaded', target: 'hauling', from: '    if (amount > 0) {\n      same ?', to: "    if (amount > 0 && kind !== 'components') {\n      same ?", fails: ['components', 'load-all'] },
  { name: 'the free space of a load leaves the components out', target: 'hauling', from: 'const used = Object.entries(CARGO_POINTS).reduce((total, [name, points]) => total + heldOf(name) * points, 0)', to: "const used = heldOf('minerals') * CARGO_POINTS.minerals + heldOf('installations') * CARGO_POINTS.installations", fails: ['components'] },
  { name: 'a load of a set number of components is followed as a full hold', target: 'hauling', from: 'order.MoveActionID === LOAD_SHIP_COMPONENT && order.MaxItems > 0', to: 'false', fails: ['components'] },
  { name: 'a cycle with a set number of components does not say why it is not worked out', target: 'hauling', from: 'return unsettled(CARGO_COUNTED)', to: 'return unsettled()', fails: ['components'] },
  { name: 'the components a cycle unloads are counted in its freight', target: 'hauling', from: 'if (move.kind in perTrip) {', to: 'if (true) {', fails: ['components'] },
  { name: 'Unload All Ship Components is not an unload', target: 'transport', from: ", 189: 'components' }", to: ' }', fails: ['components', 'load-all'] },
  { name: 'Unload Ship Component is not an unload', target: 'transport', from: "141: 'components', ", to: '', fails: ['components'] },
  { name: 'Load Ship Component is not a load', target: 'transport', from: "140: 'components', ", to: '', fails: ['components'] },
  { name: 'an unload of components to a fleet is judged as cargo at a colony', target: 'transport', from: 'FLEET_UNLOADS.has(moveActionId) && destinationType === FLEET_DESTINATION ?', to: 'false ?', fails: ['components'] },
  { name: 'the stop does not tell the destination of its order to the category', target: 'transport', from: 'transferCategory(order.MoveActionID, order.DestinationType)', to: 'transferCategory(order.MoveActionID)', fails: ['components'] },
  { name: 'an unload of one component takes every component', target: 'cargo', from: 'new Set([141, 177, 179])', to: 'new Set([177, 179])', fails: ['components'] },
  { name: 'a load of one component loads no item', target: 'cargo', from: 'new Set([140, 176, 178, 180])', to: 'new Set([176, 178, 180])', fails: ['components'] },
  { name: 'the loading rules are registered for the earlier line', target: 'transport', from: "const LOADING_VERSIONS = ['3.1.x']", to: "const LOADING_VERSIONS = ['2.7.x']", fails: ['formula', 'bays', 'load-all', 'unserved', 'versions', 'fixture', 'recorded'] },
  { name: 'the loading rules are registered for both lines', target: 'transport', from: "const LOADING_VERSIONS = ['3.1.x']", to: "const LOADING_VERSIONS = ['2.7.x', '3.1.x']", fails: ['versions'] },
  { name: 'the landing rule of the earlier line is registered for the later one too', target: 'transport', from: "const TRANSPORT_VERSIONS = ['2.7.x']", to: "const TRANSPORT_VERSIONS = ['2.7.x', '3.1.x']", fails: ['versions'] },
  { name: 'a ship with no undamaged bays is refused at a colony with no service', target: 'transport', from: '} else if (zeroBayBase(version)) {', to: '} else if (false) {', fails: ['unserved', 'versions', 'fixture'] },
  { name: 'a craft of 10 hull spaces or less is let load as a ship with no bays', target: 'transport', from: 'ship.Size <= SMALL_CRAFT_SIZE ? `a craft of', to: 'false ? `a craft of', fails: ['unserved'] },
  { name: 'a ship whose bays are not in the save waits for them to be told whether it loads', target: 'transport', from: "} else if (zeroBayBase(version)) {\n    return verdict('permitted'", to: "} else if (zeroBayBase(version) && Number.isFinite(bays)) {\n    return verdict('permitted'", fails: ['unserved'] },
  { name: 'a ship with no crew aboard is let load', target: 'transport', from: '} else if (share === 0) {', to: '} else if (false) {', fails: ['unserved'] },
  { name: 'the 10 hull space limit is not the 3.1 line\'s own', target: 'transport', from: " || ruleSupports('transport.ownStrength', version) ? SMALL_CRAFT_SIZE : null", to: ' ? SMALL_CRAFT_SIZE : null', fails: ['versions', 'unserved'] },
  { name: 'the comment of the own strength leaves out the helper that counts one bay for none', target: 'transport', from: 'Ship.method_159 (Ship.cs 6991-7024)', to: 'the bay helper (Ship.cs 6991-7024)', fails: ['versions'] },
  { name: 'the comment of the eligibility rule leaves out the order list that does not offer the order', target: 'transport', from: 'HasSelfShuttledCargoCapacity', to: 'HasShuttles', fails: ['versions'] },
  { name: 'the note of the eligibility rule names the transfer multiplier of the source', target: 'transport', from: 'Every loader and unloader of the game proceeds on that test alone', to: 'Every loader and unloader of the game (Ship.GetCargoShuttleTransferMultiplier) proceeds on that test alone', fails: ['versions'] },
  { name: 'the plan footer of Hauling says loading at a colony with no service is not settled', target: 'haulingPage', from: 'so it loads at a colony with no spaceport or cargo shuttle station at the technology alone', to: 'and whether it can load at a colony with no spaceport or cargo shuttle station is not settled', fails: ['footers'] },
  { name: 'the routes footer of Hauling says loading at a colony with no service is not settled', target: 'haulingPage', from: 'so it loads and unloads at a colony with no spaceport or cargo shuttle station at the technology alone', to: 'and whether it can load or unload at a colony with no spaceport or cargo shuttle station is not settled', fails: ['footers'] },
  { name: 'the footer of Information says loading at a colony with no service is not settled', target: 'informationPage', from: 'so it loads at a colony with no spaceport or cargo shuttle station at the technology alone', to: 'and whether it can load at a colony with no spaceport or cargo shuttle station is not settled', fails: ['footers'] },
  { name: 'the officers\' rule is registered for the earlier line', target: 'bonuses', from: "versions: ['3.1.x']", to: "versions: ['2.7.x']", fails: ['versions'] },
  { name: 'the landing size is 20 hull spaces', target: 'transport', from: 'const SMALL_CRAFT_SIZE = 10', to: 'const SMALL_CRAFT_SIZE = 20', fails: ['bays', 'fixture'] },
  { name: 'the rows carry the ship term for the base', target: 'transport', from: '    base: breakdown.base,\n', to: '    base: breakdown.ownTerm,\n', fails: ['formula'] },
  { name: 'a typed unload treats unknown bulk composition as its selected type', target: 'hauling', from: 'item !== null && entries.some((entry) => entry.item === null && entry.amount > 0)', to: 'false', fails: ['component-types'] },
  { name: 'an unknown component remainder is reported as an empty hold', target: 'hauling', from: 'entry.amount = null', to: 'entry.amount = 0', fails: ['component-types', 'components'] },
  { name: 'the component composition reason is discarded', target: 'hauling', from: 'return unsettled(move.unmodelled)', to: 'return unsettled()', fails: ['component-types'] },
  { name: 'an unworked component cycle is given exact handling time', target: 'hauling', from: 'if (cargo.settled === false) {', to: 'if (false) {', fails: ['component-types'] },
  { name: 'a fleet-target unload guarantees an empty hold', target: 'hauling', from: '|| order.DestinationType === 10))', to: '|| false))', fails: ['components'] },
  { name: 'fleet component timers are bypassed', target: 'transport', from: "const fleetComponents = category === 'ship-to-ship' && FLEET_UNLOADS.has(order.MoveActionID)", to: 'const fleetComponents = false', fails: ['fleet-timer'] },
  { name: 'receiver support is left out of the timer', target: 'transport', from: 'strength: shipTerm * stack.product + additive', to: 'strength: shipTerm * stack.product', fails: ['fleet-timer'] },
  { name: 'receiver support is multiplied by the officers', target: 'transport', from: 'strength: shipTerm * stack.product + additive', to: 'strength: (shipTerm + additive) * stack.product', fails: ['fleet-timer'] },
  { name: 'fleet cargo uses the colony small-craft exemption', target: 'transport', from: 'const own = ship.ShuttleStrength === 0 ? 1 : ship.ShuttleStrength', to: 'const own = ship.Size <= SMALL_CRAFT_SIZE || ship.ShuttleStrength === 0 ? 1 : ship.ShuttleStrength', fails: ['fleet-timer'] },
  { name: 'fleet cargo counts the sector bonus', target: 'transport', from: "factor.key === 'commander' || factor.key === 'admin'", to: 'true', fails: ['fleet-timer'] },
  { name: 'fleet component timers keep fractional seconds', target: 'transport', from: 'fleetComponents ? Math.floor(seconds) : seconds', to: 'seconds', fails: ['fleet-timer'] },
  { name: 'components-only routes lose the delivered message', target: 'haulingPage', from: "const componentsText = year && cargo.deliveries.some((delivery) => delivery.kind === 'components' && delivery.amount > 0) ?", to: 'const componentsText = false ?', fails: ['component-display'] },
  { name: 'components-only routes also say no cargo was delivered', target: 'haulingPage', from: '!item.freightText && !item.colonistsText && !item.componentsText', to: '!item.freightText && !item.colonistsText', fails: ['component-display'] },
  { name: 'the components message is hidden from the rendered slot', target: 'haulingPage', from: '<div v-if="item.componentsText" class="caption" data-haul="components">', to: '<div v-if="false" class="caption" data-haul="components">', fails: ['component-display'] },
]

// Rewrites that say the same thing: a tonnage per hull space written as a quotient, a day written as a product, a load action id written as a sum, a pass limit written as a product.
const BENIGN = [
  { name: 'a tonnage per hull space written as a quotient', target: 'transport', from: 'const TONNES_PER_HULL_SPACE = 50', to: 'const TONNES_PER_HULL_SPACE = 100 / 2' },
  { name: 'a day written as a product', target: 'transport', from: 'const SECONDS_PER_DAY = 86400', to: 'const SECONDS_PER_DAY = 24 * 60 * 60' },
  { name: 'the load action id written as a sum', target: 'transport', from: 'const LOAD_CARGO = 62', to: 'const LOAD_CARGO = 61 + 1' },
  { name: 'the pass limit written as a product', target: 'hauling', from: 'const MAX_PASSES = 200', to: 'const MAX_PASSES = 20 * 10' },
]

// ---- Run ------------------------------------------------------------------------------------------------------------------
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

const FIXTURES = { fixture: [SAVE], recorded: [SAVE] }
const absent = (one) => (FIXTURES[one.name] || []).filter((file) => !fs.existsSync(path.join(root, file)))

const main = async () => {
  const available = CHECKS.filter((one) => !absent(one).length)

  CHECKS.filter((one) => absent(one).length).forEach((one) => console.log(`UNSUPPORTED  ${one.name}: the fixture ${absent(one).join(', ')} is not there`))

  const failures = await run(available, worldOf())
  let passed = available.length - failures.length
  let total = available.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    const known = new Set(available.map(({ name }) => name))

    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(available, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith(benign)

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      const world = worldOf(texts)
      const named = fault.fails.filter((id) => known.has(id))
      const missed = []

      for (const id of named) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed, named: named.length }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (!outcome.named) {
        console.log(`FAIL planted fault ${outcome.label}: none of its checks can run here`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    closeClones()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeClones()
    process.exit(2)
  })
