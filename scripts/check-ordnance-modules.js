/*
  Checks what the Ordnance Factory Module and the orbital modules add to ordnance (AE-309-01): the class totals the Designed page shows, the orbital term of a colony's ordnance capacity, and the places the pod bay family no longer reaches.

  Run: bun scripts/check-ordnance-modules.js [--no-mutations]

  The rules are the game's, read from the 3.1.0 source and written here, never read from the modules, and every figure is source-derived: no save played under 3.1 holds a ship with orbital mining modules assigned to a colony, a class with an Ordnance Factory Module or a colony's ordnance capacity written with one (the owner's decision Q7 of AE-31: no played save will be supplied; the played 3.2.0 save holds no ordnance module either), so each case is planted on an in-memory copy of the migrated fixture (saves/AuroraDB-310-spookyerol-migrated.db) with rows shaped as the game writes and loads them:
  - a class keeps its Ordnance Factory Modules in `FCT_ShipClass.OrdnanceModules` (`Game.LoadShipClasses`, Game.cs:17908, and `Game.SaveShipClasses`, Game.cs:10723) as the sum of the NumComponent of its lines of that component type (`ShipClass.cs:3603`), and the summary line gives the race's ordnance production times the modules as the build points a year (ShipClass.cs:4327);
  - a colony's annual ordnance capacity is the installations' product plus `Population.method_211(OrbitalMiningModule, Production)` (Population.cs:4727-4741), a sum over the fleets of the colony's race that lie within one unit of the colony's body on both axes (`Game.AreCoordinatesWithinOneUnit`, Game.cs:37170, strictly less than 1 on each) and are assigned to the colony, a fleet with no colony being given to the first colony that asks (Population.cs:9933-9939), of the fleet's capacity of the Orbital Mining Module (`Ship.method_159`, Ship.cs:6991-7088: the undamaged modules times the race's mine production, times the commander's Mining bonus, times the share of the class crew aboard) times the command's Production bonus at the Industrial share (`NavalAdminCommand.method_5`, NavalAdminCommand.cs:197-300); a fleet assigned to another colony, or to this one but away from it, adds nothing; the game takes the Orbital Mining Module there, not the Ordnance Factory Module, and the colony's modifiers do not multiply the added term;
  - the danger rating counts the protection value a class stores (`FCT_ShipClass.ProtectionValue`), which in the 3.1.0 source comes from beam weapons and missile launchers only (ShipClass.cs:3691 and 3756).
  Every planted row is a copy of a row the fixture holds (a ship, a fleet, a naval admin command, a commander, a class, a class component) with the columns the game's loaders read set to what the case needs.
  The checks:
  - `class-totals`: `classOrdnance` gives the stored module count and, times the race's ordnance production, the build points a year; a class whose component lines disagree with the stored count says so; an unknown count or rate leaves the figure unavailable;
  - `class-detail`: the Designed page's read of a planted class with Ordnance Factory Modules gives its stored count, its lines and the race's rate, and every class of the fixture reads the count its lines add up to;
  - `pods`: the Designed page keeps no Pod size column and no pod reload figure for the research category of the removed pod bay, and no code of the capacity or the danger rating names the pod bay;
  - `danger`: the protection of a system adds a planted class's stored protection value and nothing for its Ordnance Factory Modules;
  - `orbital-term`: the term of a planted ship with orbital mining modules (damaged modules, a short crew, a captain's Mining bonus, a naval admin chain) is the hand-worked figure, and a ship of the other module, of another race, of a fleet assigned to the colony but away from it and of a fleet assigned to another colony adds nothing; a missing factor leaves it unavailable;
  - `orbital-claim`: a fleet at the colony that is assigned to none, within one unit but not on the body, or assigned to a colony that no longer exists is counted for the colony, and one exactly one unit away is not;
  - `orbital-contested`: an unassigned fleet within one unit of two colonies of the race is listed for both and leaves both terms unavailable, naming the claim, while a fleet assigned to one of them is the one colony's alone and the capacity through the mixin is unavailable;
  - `orbital-place`: a fleet or body with no saved position is matched by the body the fleet orbits, and a fleet with neither leaves the colonies it may count for unavailable, naming the position;
  - `capacity`: the colony's ordnance capacity adds the term after the installations' product and never multiplies it by the colony's modifier, and the other capacities and a row without the term are as before;
  - `mixin`: the production modifiers mixin reads the term on the planted copy and gives the colony's capacity through `populationCapacityResult`;
  - `registry`: the rules the figures name are registered for the 3.2 line, and their notes carry no code.
  Where the source does not give a rule the check does not guess it: no figure here is compared with a build rate the game wrote, because none exists.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB-310-spookyerol-migrated.db'
const GAME = 141
const RACE = 784
const OTHER_RACE = 785
const COLONY = 48979
const OTHER_COLONY = 48977
const SYSTEM = 21775

const renderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const FILES = {
  ordnance: renderer('utilities', 'ordnance-modules.js'),
  colonization: renderer('utilities', 'colonization.js'),
  designed: renderer('utilities', 'designed-tech.js'),
  mixin: renderer('mixins', 'production-modifiers.js'),
  safeRoutes: renderer('utilities', 'safe-routes.js'),
  designedPage: renderer('pages', 'designed-tech.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The modules under the names a mixin of the renderer reaches them by, so that every module of the graph is one instance (one rule registry).
const UTILITY_NAMES = { ordnance: '../utilities/ordnance-modules', colonization: '../utilities/colonization', designed: '../utilities/designed-tech', safeRoutes: '../utilities/safe-routes', mixin: '../mixins/production-modifiers' }
const PAGE_NAME = 'pages/designed-tech'

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const PAGE_MODULES = {
  'components/navigation/section-style': 'export const sectionStyle = () => ({})',
  'components/research/status-style': 'export const statusStyle = () => ({})',
  'mixins/load-state': 'export default () => ({})',
}
const STORE = { $store: { getters: { 'capabilities/blockedBonuses': new Set(), 'capabilities/result': { gates: { bonuses: {}, components: {} }, reports: {} }, 'capabilities/report': () => null, config: { get: (_key, fallback) => fallback } }, state: {}, dispatch: async () => {} } }

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules and the page as shipped, or with edits planted ----------------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => {
  const sources = Object.fromEntries(Object.entries(UTILITY_NAMES).map(([key, name]) => [name, texts[key]]))

  return {
    texts,
    modules: memo(() => loadUtilities([...Object.values(UTILITY_NAMES), '../utilities/provenance', '../utilities/naval-admins'], { stubs: STUBS, sources })),
    designedPage: memo(() => loadPage(PAGE_NAME, { stubs: STUBS, modules: PAGE_MODULES, sources: { [PAGE_NAME]: texts.designedPage, ...Object.fromEntries(Object.entries(UTILITY_NAMES).filter(([key]) => key !== 'mixin').map(([key, name]) => [`utilities/${path.posix.basename(name)}`, texts[key]])) } })),
  }
}

// ---- The fixture, as in-memory copies --------------------------------------------------------------------------------------
const literal = (value) => (value === null ? 'null' : typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))

// A copy of the row of `table` with `key` equal to `from`, every column kept but those of `over`.
const cloneRow = (database, table, key, from, over) => {
  const names = database.query(`select name from pragma_table_info('${table}')`).all().map((row) => row.name)
  const select = names.map((name) => (Object.prototype.hasOwnProperty.call(over, name) ? literal(over[name]) : `"${name}"`)).join(', ')

  database.run(`insert into ${table} (${names.map((name) => `"${name}"`).join(', ')}) select ${select} from ${table} where ${key} = ${from}`)
}

const MINING_CLASS = 63059
const MINING_MODULE = 25720
const OFM = 80000
const SHIP_TEMPLATE = 195751
const FLEET_TEMPLATE = 459991
const ADMIN_TEMPLATE = 1364
const ADMIN_COMMANDER_TEMPLATE = 637327
const TOP_RANK = 10318

// The ids of the planted rows, past every id of the fixture.
const IDS = { ship: 9000001, fleet: 9000002, command: 9000003, admin: 9000004, captain: 9000005, barge: 9000006, stale: 9000007, bargeShip: 9000008, bargeFleet: 9000009, otherShip: 9000010, otherFleet: 9000011, unclaimedShip: 9000012, unclaimedFleet: 9000013, factoryShip: 9000014, factoryFleet: 9000015, otherColonyShip: 9000016, otherColonyFleet: 9000017, secondShip: 9000018, awayShip: 9000019, awayFleet: 9000020, elsewhereShip: 9000021, elsewhereFleet: 9000022, nearShip: 9000023, nearFleet: 9000024, goneShip: 9000025, goneFleet: 9000026, edgeShip: 9000027, edgeFleet: 9000028, gonePopulation: 9000029, secondColony: 9000030, sharedShip: 9000031, sharedFleet: 9000032, bodyShip: 9000033, bodyFleet: 9000034, bodyOtherShip: 9000035, bodyOtherFleet: 9000036, blindShip: 9000037, blindFleet: 9000038, freeShip: 9000039, freeFleet: 9000040 }

const addCaptain = (database, shipId, commanderId, bonus) => {
  const template = database.query(`select CommanderID from FCT_Commander where CommandType = 1 and RaceID = ${RACE} limit 1`).get().CommanderID

  cloneRow(database, 'FCT_Commander', 'CommanderID', template, { CommanderID: commanderId, CommandID: shipId })

  if (bonus !== null) {
    database.run(`insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${commanderId}, 6, ${bonus}, ${GAME})`)
  }
}

// The body of a colony and where it is, as `{ SystemBodyID, Xcor, Ycor }`.
const bodyOf = (database, colony) => database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.PopulationID = ${colony}`).get()

// A ship of `classId` in a fleet assigned to `colony` (0 for none) under `command` (the loaders of Game.cs read FCT_Ship, FleetID, FCT_Fleet and FCT_ClassComponent: Game.cs:17227 and 17298-17327). The fleet is where the template fleet is, at the body of colony 48979, unless `at` sets other columns of the fleet (its coordinates and the body it orbits).
const addShip = (database, { ship, fleet, classId = MINING_CLASS, crew, colony = COLONY, command = IDS.command, race = RACE, name = 'Miner', at = {} }) => {
  cloneRow(database, 'FCT_Fleet', 'FleetID', FLEET_TEMPLATE, { FleetID: fleet, FleetName: `${name} fleet`, AssignedPopulationID: colony, ParentCommandID: command, SystemID: SYSTEM, RaceID: race, ...at })
  cloneRow(database, 'FCT_Ship', 'ShipID', SHIP_TEMPLATE, { ShipID: ship, FleetID: fleet, ShipClassID: classId, CurrentCrew: crew, ShipName: name, RaceID: race })
}

const PLANTS = {
  // A race whose ordnance production (900) is not its mine production (600), a ship of the mining class with half its crew, a captain with a Mining bonus of 1.5, 11 of its 151 modules damaged and a naval admin command of the Industrial type (share 0.1) whose commander holds a Production bonus of 1.3 (`NavalAdminCommand.method_5`).
  orbital: (database) => {
    database.run(`update FCT_Race set OrdnanceProduction = 900 where GameID = ${GAME} and RaceID = ${RACE}`)
    cloneRow(database, 'FCT_NavalAdminCommand', 'NavalAdminCommandID', ADMIN_TEMPLATE, { NavalAdminCommandID: IDS.command, ParentAdminCommandID: 0, PopulationID: COLONY, ShipID: 0, AdminCommandTypeID: 4, MinimumRankPriority: 7 })
    cloneRow(database, 'FCT_Commander', 'CommanderID', ADMIN_COMMANDER_TEMPLATE, { CommanderID: IDS.admin, CommandID: IDS.command, RankID: TOP_RANK })
    database.run(`insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${IDS.admin}, 5, 1.3, ${GAME})`)
    addShip(database, { ship: IDS.ship, fleet: IDS.fleet, crew: 3783 })
    addCaptain(database, IDS.ship, IDS.captain, 1.5)
    database.run(`insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${IDS.ship}, ${MINING_MODULE}, ${GAME}, 11)`)
  },
  // The cases that must add nothing: a ship that mounts the Ordnance Factory Module only, a ship of another race in a fleet assigned to the colony and at it, a fleet assigned to the colony but five units from it (it still orbits the body its row names, as a fleet that left keeps its row until the game rewrites it), a fleet assigned to the other colony and at this one; and one that counts only at the other colony: its fleet is assigned to it and at its body. The same class and crew as the miner.
  neutral: (database) => {
    PLANTS.orbital(database)

    const here = bodyOf(database, COLONY)
    const there = bodyOf(database, OTHER_COLONY)

    database.run(`insert into FCT_ClassComponent (ClassID, ComponentID, GameID, NumComponent) values (${IDS.barge}, ${OFM}, ${GAME}, 7)`)
    cloneRow(database, 'FCT_ShipClass', 'ShipClassID', MINING_CLASS, { ShipClassID: IDS.barge, ClassName: 'Factory Barge', OrdnanceModules: 7, MiningModules: 0, ProtectionValue: 0 })
    addShip(database, { ship: IDS.factoryShip, fleet: IDS.factoryFleet, classId: IDS.barge, crew: 100, name: 'Barge' })
    addShip(database, { ship: IDS.otherShip, fleet: IDS.otherFleet, crew: 7566, race: OTHER_RACE, name: 'Foreign' })
    addShip(database, { ship: IDS.awayShip, fleet: IDS.awayFleet, crew: 7566, name: 'Away', at: { Xcor: here.Xcor + 5 } })
    addShip(database, { ship: IDS.elsewhereShip, fleet: IDS.elsewhereFleet, crew: 7566, colony: OTHER_COLONY, name: 'Elsewhere' })
    addShip(database, { ship: IDS.otherColonyShip, fleet: IDS.otherColonyFleet, crew: 7566, colony: OTHER_COLONY, name: 'Other colony', at: { Xcor: there.Xcor, Ycor: there.Ycor, OrbitBodyID: there.SystemBodyID } })
  },
  // Fleets the game counts for the colony although no colony owns them or the position is not the body: one assigned to none and on the body, one assigned to none within one unit on both axes (half a unit off, orbiting no body), one assigned to a colony that no longer exists, and one assigned to none exactly one unit off (strictly less than one counts, so that one is not counted).
  claim: (database) => {
    PLANTS.orbital(database)

    const here = bodyOf(database, COLONY)

    addShip(database, { ship: IDS.unclaimedShip, fleet: IDS.unclaimedFleet, crew: 7566, colony: 0, name: 'Unclaimed' })
    addShip(database, { ship: IDS.nearShip, fleet: IDS.nearFleet, crew: 7566, colony: 0, name: 'Near', at: { Xcor: here.Xcor + 0.5, Ycor: here.Ycor - 0.5, OrbitBodyID: 0 } })
    addShip(database, { ship: IDS.goneShip, fleet: IDS.goneFleet, crew: 7566, colony: IDS.gonePopulation, name: 'Gone' })
    addShip(database, { ship: IDS.edgeShip, fleet: IDS.edgeFleet, crew: 7566, colony: 0, name: 'Edge', at: { Xcor: here.Xcor + 1, OrbitBodyID: 0 } })
  },
  // A second colony of the race on the body of the first (the game tests the body's coordinates alone, so two colonies at one place are both within one unit of a fleet), and a fleet assigned to none at that place.
  contested: (database) => {
    PLANTS.orbital(database)
    cloneRow(database, 'FCT_Population', 'PopulationID', COLONY, { PopulationID: IDS.secondColony, PopName: 'Second Aurelia' })
    addShip(database, { ship: IDS.sharedShip, fleet: IDS.sharedFleet, crew: 7566, colony: 0, name: 'Shared' })
  },
  // Fleets with no saved position that orbit a body: the game's coordinates are not there, so the body stands in (one orbits the body of the colony, one the body of the other colony), each assigned to none.
  bodyOnly: (database) => {
    PLANTS.orbital(database)

    const there = bodyOf(database, OTHER_COLONY)

    addShip(database, { ship: IDS.bodyShip, fleet: IDS.bodyFleet, crew: 7566, colony: 0, name: 'By body', at: { Xcor: null, Ycor: null } })
    addShip(database, { ship: IDS.bodyOtherShip, fleet: IDS.bodyOtherFleet, crew: 7566, colony: 0, name: 'By other body', at: { Xcor: null, Ycor: null, OrbitBodyID: there.SystemBodyID } })
  },
  // A fleet with no saved position that orbits no body, assigned to the colony: the save does not say whether it is there.
  blind: (database) => {
    PLANTS.orbital(database)
    addShip(database, { ship: IDS.blindShip, fleet: IDS.blindFleet, crew: 7566, name: 'Blind', at: { Xcor: null, Ycor: null, OrbitBodyID: 0 } })
  },
  // The same fleet assigned to none: it may be at any colony of the race.
  blindFree: (database) => {
    PLANTS.orbital(database)
    addShip(database, { ship: IDS.freeShip, fleet: IDS.freeFleet, crew: 7566, colony: 0, name: 'Blind and free', at: { Xcor: null, Ycor: null, OrbitBodyID: 0 } })
  },
  // A class with 7 Ordnance Factory Modules, as `Game.cs:17908` loads it and the class recalculation (ShipClass.cs:3603) sums it, and a class whose stored count (7) is not what its lines add up to (5), each with a ship in service, and a stored protection value for the danger case.
  classes: (database) => {
    for (const [classId, name, stored, lines, protection] of [[IDS.barge, 'Factory Barge', 7, 7, 12.5], [IDS.stale, 'Stale Barge', 7, 5, 0]]) {
      cloneRow(database, 'FCT_ShipClass', 'ShipClassID', MINING_CLASS, { ShipClassID: classId, ClassName: name, OrdnanceModules: stored, MiningModules: 0, ProtectionValue: protection })
      database.run(`insert into FCT_ClassComponent (ClassID, ComponentID, GameID, NumComponent) values (${classId}, ${OFM}, ${GAME}, ${lines})`)
    }

    cloneRow(database, 'FCT_Fleet', 'FleetID', FLEET_TEMPLATE, { FleetID: IDS.bargeFleet, FleetName: 'Barge fleet' })
    cloneRow(database, 'FCT_Ship', 'ShipID', SHIP_TEMPLATE, { ShipID: IDS.bargeShip, FleetID: IDS.bargeFleet, ShipClassID: IDS.barge, ShipName: 'Barge' })
  },
}

let BYTES = null
const COPIES = new Map()

const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)

    PLANTS[name](database)
    COPIES.set(name, database)
  }

  return COPIES.get(name)
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

const adapterOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

// The figures worked by hand from the planted rows: the race's mine production and ordnance production of the fixture (600 and 600), the undamaged modules 151 less 11, the crew share 3783 of 7566, the captain's bonus and the one admin command's Industrial share of its Production bonus.
const MINE = 600
const MODULES = 140
const CREW = 0.5
const CAPTAIN = 1.5
const ADMIN = 1 + (1.3 - 1) * 0.1
const TERM = MINE * MODULES * CREW * CAPTAIN * ADMIN
// A fleet of one miner of the same class with a full crew, no captain and no damage (151 modules), under the same admin command.
const UNIT = MINE * 151 * ADMIN

const available = (result) => result.status !== 'unavailable'

// ---- The checks -------------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('class-totals', 'a class shows its stored Ordnance Factory Module count and the race\'s ordnance production times it as the build points a year; lines that disagree with the count are said; an unknown count or rate is unavailable, never 0', async (w) => {
  const { '../utilities/ordnance-modules': o } = await w.modules()
  const seven = o.classOrdnance({ stored: 7, mounted: 7, rate: 600 })
  const stale = o.classOrdnance({ stored: 7, mounted: 5, rate: 600 })
  const none = o.classOrdnance({ stored: 0, mounted: 0, rate: 600 })
  const noCount = o.classOrdnance({ stored: null, mounted: 7, rate: 600 })
  const noRate = o.classOrdnance({ stored: 7, mounted: 7, rate: null })

  assert.equal(seven.modules.value, 7, 'the stored count')
  assert.equal(seven.production.value, 4200, '7 modules at the race\'s 600 a module')
  assert.equal(seven.agrees, true, 'lines and stored count agree')
  assert.equal(stale.modules.value, 7, 'the stored count is what the game reads')
  assert.equal(stale.mounted, 5, 'the lines add up to 5')
  assert.equal(stale.agrees, false, 'the disagreement is told')
  assert.equal(none.production.value, 0, 'a class with none makes none, a known 0')
  assert.equal(available(noCount.modules), false, 'no stored count: unavailable')
  assert.equal(available(noCount.production), false, 'no stored count: no production')
  assert.deepEqual(noCount.production.inputs.missing, ['the class\'s ordnance factory modules'])
  assert.equal(available(noRate.production), false, 'no rate: no production')
  assert.deepEqual(noRate.production.inputs.missing, ['the race\'s ordnance production'])
  assert.equal(noRate.modules.value, 7, 'the count stands without the rate')
  assert.equal(noCount.agrees, null, 'no stored count: no agreement is claimed')
})

check('class-detail', 'the Designed page\'s read of a planted class gives the stored count, the lines and the race\'s rate, shows them for an Ordnance Factory Module design only, and every class of the fixture reads the count its lines add up to', async (w) => {
  const { '../utilities/designed-tech': designed, '../utilities/ordnance-modules': o } = await w.modules()
  const options = await w.designedPage()
  const database = copyOf('classes')
  const vm = instantiate(options, { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { ready: true } })

  await vm.runAsync('classUsage')

  const usage = designed.classUsageByComponent(vm.classUsage)
  const item = designed.withUsage({ SDComponentID: OFM, CategoryID: 31, ComponentTypeID: 72 }, usage)
  const byName = Object.fromEntries(item.classes.map((entry) => [entry.name, entry]))

  assert.deepEqual(Object.keys(byName).sort(), ['Factory Barge', 'Stale Barge'], 'the two planted classes mount the module and no class of the fixture does')
  assert.deepEqual(byName['Factory Barge'].ordnance, { stored: 7, mounted: 7, rate: 600 }, 'the planted class')
  assert.deepEqual(byName['Stale Barge'].ordnance, { stored: 7, mounted: 5, rate: 600 }, 'the class whose lines disagree')
  assert.equal(o.classOrdnance(byName['Factory Barge'].ordnance).production.value, 4200, 'the class\'s build points a year')
  assert.equal(o.classOrdnance(byName['Stale Barge'].ordnance).agrees, false, 'the stale class is told')
  assert.equal(vm.isOrdnanceModule({ ComponentTypeID: 72 }), true, 'the Ordnance Factory Module is shown with its class figures')
  assert.equal(vm.isOrdnanceModule({ ComponentTypeID: 38 }), false, 'another module is not')
  assert.equal(vm.ordnanceText(byName['Factory Barge'], 'modules'), '7', 'the count as the page words it')
  assert.equal(vm.ordnanceText(byName['Factory Barge'], 'production'), '4\'200 BP', 'the build points as the page words them')
  assert.equal(vm.ordnanceText({ ordnance: { stored: null, mounted: null, rate: 600 } }, 'modules'), '—', 'an unknown count is a dash')

  // Every class of the race: the count the page's read gives is the stored column and the lines it adds up are the component lines of type 72, worked here in SQL.
  const oracle = database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.OrdnanceModules, coalesce((select sum(FCT_ClassComponent.NumComponent) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 72), 0) as Lines from FCT_ShipClass where FCT_ShipClass.GameID = ${GAME} and FCT_ShipClass.RaceID = ${RACE}`).all()

  assert.ok(oracle.length > 50, 'the fixture holds its classes')

  for (const row of oracle) {
    const read = usage.ordnanceByClass.get(row.ShipClassID)

    assert.ok(read, `class ${row.ShipClassID} is in the page's read`)
    assert.equal(read.stored, row.OrdnanceModules, `class ${row.ShipClassID}: the stored count`)
    assert.equal(read.mounted, row.Lines, `class ${row.ShipClassID}: the lines`)
  }
})

check('pods', 'the Designed page keeps no Pod size column and no pod reload figure for the research category of the removed pod bay, and no code of the capacity or the danger rating names the pod bay', async (w) => {
  const { '../utilities/designed-tech': designed } = await w.modules()
  const texts = designed.columnsFor(49).map((column) => column.text)
  const fallback = designed.columnsFor(987654).map((column) => column.text)

  assert.deepEqual(texts, fallback, 'the removed pod bay\'s category shows the columns every category has')
  assert.ok(!texts.includes('Pod size'), 'no Pod size column')

  const item = designed.augmentComponent({ SDComponentID: 1, Name: 'Pod', CategoryID: 49, ComponentTypeID: 72, ComponentValue: 10, RateOfFire: 60, Size: 1, Cost: 1, Crew: 1, HTK: 1, MilitarySystem: 1, Obsolete: 0 })

  assert.equal(item.HangarReload, undefined, 'no pod reload figure')
  assert.equal(designed.augmentComponent({ SDComponentID: 2, Name: 'Decoy', CategoryID: 51, ComponentTypeID: 51, ComponentValue: 1, RateOfFire: 60, Size: 1, Cost: 1, Crew: 1, HTK: 1, MilitarySystem: 1, Obsolete: 0 }).HangarReload, 1, 'a decoy launcher keeps its reload')

  for (const target of ['ordnance', 'designed', 'mixin', 'safeRoutes']) {
    const text = w.texts[target]

    assert.ok(!/FighterPod|PodBay|Pod size|ComponentTypeID\s*(?:=|in)\s*\(?\s*65\b/i.test(text.replace(/^\s*\/\/.*$/gm, '')), `${target}: the code names no pod bay`)
  }
})

check('danger', 'the protection of a system adds a planted class\'s stored protection value and nothing for its Ordnance Factory Modules', async (w) => {
  const { '../utilities/safe-routes': routes } = await w.modules()
  const base = Database.deserialize(fs.readFileSync(path.join(root, SAVE)))
  const planted = copyOf('classes')
  const system = base.query(`select FCT_Fleet.SystemID from FCT_Fleet where FleetID = ${FLEET_TEMPLATE}`).get().SystemID
  const protection = async (database) => (await routes.loadPlannedAvoidSystems(adapterOf(database), { GameID: GAME, RaceID: RACE })).find((row) => row.SystemID === system)

  try {
    const before = await protection(base)
    const after = await protection(planted)

    assert.ok(near(after.Protection - (before.Protection || 0), 12.5), `the stored 12.5 is added once: ${before.Protection} to ${after.Protection}`)
    assert.equal(after.ProtectionShips - before.ProtectionShips, 1, 'one ship more is counted')
  } finally {
    base.close()
  }
})

const termOf = async (w, copy, { blocked = new Set(), admins, populationIds = [COLONY, OTHER_COLONY] } = {}) => {
  const { '../utilities/ordnance-modules': o, '../utilities/naval-admins': n } = await w.modules()
  const adapter = adapterOf(copyOf(copy))
  const source = await o.loadOrbitalOrdnance(adapter, { GameID: GAME, RaceID: RACE, blocked })
  const chain = admins || await n.loadNavalAdmins(adapter, { GameID: GAME, RaceID: RACE, bonusId: o.PRODUCTION_BONUS, share: 'Industrial', ranks: true, blocked })

  return { source, chain, terms: o.orbitalOrdnanceTerms({ source, admins: chain, populationIds }), o }
}

// The ships the read lists for a colony, by id.
const shipsOf = (source, colony) => (source.colonies[colony] ? source.colonies[colony].ships.map((ship) => ship.ShipID).sort((a, b) => a - b) : [])
const idsOf = (...ids) => ids.sort((a, b) => a - b)

check('orbital-term', 'the term of a planted ship with orbital mining modules is the mine production times the undamaged modules, the crew share, the captain\'s Mining bonus and the admin chain\'s Production bonus; the other module, another race, a fleet assigned to the colony but away from it and a fleet assigned to another colony add nothing; a missing factor leaves it unavailable', async (w) => {
  const { source, terms } = await termOf(w, 'orbital')

  assert.equal(source.mineRate, MINE, 'the race\'s mine production')
  assert.deepEqual(Object.keys(source.colonies), [String(COLONY)], 'one colony has a ship')

  const [ship] = source.colonies[COLONY].ships

  assert.equal(ship.modules, MODULES, '151 modules less 11 damaged')
  assert.equal(ship.crew, CREW, 'the crew share')
  assert.equal(ship.captain, CAPTAIN, 'the captain\'s Mining bonus')
  assert.ok(near(terms[COLONY].value, TERM), `the term of the colony: ${terms[COLONY].value}, worked by hand ${TERM}`)
  assert.equal(terms[OTHER_COLONY].value, 0, 'a colony with no ship has a known 0')
  assert.equal(terms[COLONY].rule.id, 'production.orbitalOrdnance')

  const neutral = await termOf(w, 'neutral')

  assert.deepEqual(shipsOf(neutral.source, COLONY), [IDS.ship], 'at the colony: its own miner alone (a barge of Ordnance Factory Modules, a ship of another race at it, a fleet assigned to it but five units away and a fleet assigned to the other colony are not counted)')
  assert.deepEqual(shipsOf(neutral.source, OTHER_COLONY), [IDS.otherColonyShip], 'at the other colony: the ship whose fleet is assigned to it and at its body')
  assert.ok(near(neutral.terms[COLONY].value, TERM), `nothing but the miner is added at the colony: ${neutral.terms[COLONY].value}, worked by hand ${TERM}`)
  assert.ok(near(neutral.terms[OTHER_COLONY].value, UNIT), 'the ship at the other colony (151 undamaged modules, a full crew, no captain, the same command) is counted there and not at this colony')
  assert.deepEqual(Object.keys(neutral.source.colonies).sort(), [String(COLONY), String(OTHER_COLONY)].sort(), 'only the two colonies a fleet counts for are read')
})

check('orbital-unknown', 'a Mining or Production bonus the save\'s lookup does not confirm, a chain the save does not settle and a missing mine production leave the term unavailable and say what is missing', async (w) => {
  const { terms: mining } = await termOf(w, 'orbital', { blocked: new Set([6]) })
  const { terms: production } = await termOf(w, 'orbital', { blocked: new Set([5]) })
  const { source, o } = await termOf(w, 'orbital')
  const noRate = o.orbitalOrdnanceTerm({ source: source.colonies[COLONY], mineRate: null, admins: {} })
  const noCrew = o.orbitalOrdnanceTerm({ source: { ships: [{ ...source.colonies[COLONY].ships[0], crew: null }] }, mineRate: MINE, admins: {} })
  const noCommand = o.orbitalOrdnanceTerm({ source: { ships: [{ ...source.colonies[COLONY].ships[0], ParentCommandID: null }] }, mineRate: MINE, admins: {} })
  const noDamage = o.orbitalOrdnanceTerm({ source: { ships: [{ ...source.colonies[COLONY].ships[0], modules: null }] }, mineRate: MINE, admins: {} })

  assert.equal(available(mining[COLONY]), false, 'the Mining bonus withheld')
  assert.ok(mining[COLONY].inputs.missing.some((text) => text.includes('Mining bonus')), `names the Mining bonus: ${mining[COLONY].inputs.missing}`)
  assert.equal(available(production[COLONY]), false, 'the Production bonus withheld')
  assert.equal(production[OTHER_COLONY].value, 0, 'a colony with no ship needs no bonus')
  assert.equal(available(noRate), false, 'no mine production')
  assert.deepEqual(noRate.inputs.missing, ['the race\'s mine production'])
  assert.equal(available(noCrew), false, 'no crew')
  assert.equal(available(noCommand), false, 'no command')
  assert.equal(available(noDamage), false, 'no damage state')
})

check('orbital-shapes', 'a ship without a captain has a bonus of 1, a captain without a Mining bonus row has 1, a full crew and an over-crewed ship are the same, and two fleets take their own admin chains', async (w) => {
  const { o } = await termOf(w, 'orbital')
  const ship = (over) => ({ ShipID: 1, FleetID: 1, ParentCommandID: 1, FleetSystemID: 1, crew: 1, captain: 1, captained: false, modules: 10, ...over })
  const chain = { 1: { NavalAdminCommandID: 1, ParentCommandID: 0, SystemID: 1, BonusValue: 1.2, Share: 0.5, Eligible: true, Unknown: null, BonusUnknown: null, Systems: new Set([1]) } }
  const value = (ships, admins = {}) => o.orbitalOrdnanceTerm({ source: { ships }, mineRate: 100, admins }).value

  assert.ok(near(value([ship({})]), 1000), 'no captain, no admin: 100 a module')
  assert.ok(near(value([ship({ crew: 0.25 })]), 250), 'a quarter of the crew')
  assert.ok(near(value([ship({ captain: 1.5, captained: true })]), 1500), 'a captain\'s bonus')
  assert.ok(near(value([ship({}), ship({ ShipID: 2 })]), 2000), 'two ships of one fleet add')
  assert.ok(near(value([ship({}), ship({ ShipID: 2, FleetID: 2 })], chain), 1000 * 1.1 + 1000 * 1.1), 'each fleet answers to the chain of its command at the system it is in')
  assert.ok(near(value([ship({ FleetSystemID: 2 })], chain), 1000), 'a fleet outside the command\'s range has no bonus')
  assert.equal(o.orbitalOrdnanceTerm({ source: { ships: [ship({})] }, mineRate: 100 }).assumptions.includes('A ship without a captain has a bonus of 1'), true, 'the assumption is told')
  assert.equal(value([ship({ modules: 0, contested: true, unplaced: true })]), 0, 'a ship whose modules are all damaged adds nothing and leaves nothing unknown, whichever colony gets its fleet')
  assert.equal(available(o.orbitalOrdnanceTerm({ source: { ships: [ship({ contested: true })] }, mineRate: 100 })), false, 'a fleet that may go to another colony of the race leaves the term unavailable')
  assert.equal(available(o.orbitalOrdnanceTerm({ source: { ships: [ship({ unplaced: true })] }, mineRate: 100 })), false, 'a fleet whose place the save does not give leaves the term unavailable')
})

check('orbital-claim', 'a fleet assigned to none that is on the colony\'s body, one assigned to none within one unit of it on both axes (and orbiting no body) and one assigned to a colony that no longer exists are counted for the colony; one exactly one unit off is not', async (w) => {
  const { source, terms } = await termOf(w, 'claim')

  assert.deepEqual(shipsOf(source, COLONY), idsOf(IDS.ship, IDS.unclaimedShip, IDS.nearShip, IDS.goneShip), 'the assigned miner, the unassigned fleet on the body, the unassigned fleet half a unit off and the fleet of a colony that is gone; not the fleet exactly one unit off')
  assert.ok(near(terms[COLONY].value, TERM + 3 * UNIT), `the term of the colony: ${terms[COLONY].value}, worked by hand ${TERM + 3 * UNIT}`)
  assert.equal(source.colonies[COLONY].ships.some((ship) => ship.contested || ship.unplaced), false, 'one colony of the race is there, so nothing is contested or unplaced')
  assert.deepEqual(Object.keys(source.colonies), [String(COLONY)], 'no other colony counts any of them')
  assert.equal(terms[OTHER_COLONY].value, 0, 'the other colony has none')
})

check('orbital-contested', 'an unassigned fleet within one unit of two colonies of the race is listed for both and leaves both terms unavailable, naming the claim the game makes by asking order; a fleet assigned to one of them is that colony\'s alone; the capacity through the mixin is unavailable', async (w) => {
  const { source, chain, terms, o } = await termOf(w, 'contested', { populationIds: [COLONY, IDS.secondColony, OTHER_COLONY] })
  const flags = (colony) => Object.fromEntries(source.colonies[colony].ships.map((ship) => [ship.ShipID, ship.contested]))

  assert.deepEqual(shipsOf(source, COLONY), idsOf(IDS.ship, IDS.sharedShip), 'the first colony lists its assigned miner and the unassigned fleet')
  assert.deepEqual(shipsOf(source, IDS.secondColony), [IDS.sharedShip], 'the second colony lists the unassigned fleet and not the miner assigned to the first')
  assert.deepEqual(flags(COLONY), { [IDS.ship]: false, [IDS.sharedShip]: true }, 'the assigned miner is not contested')
  assert.deepEqual(flags(IDS.secondColony), { [IDS.sharedShip]: true }, 'the unassigned fleet is')

  for (const colony of [COLONY, IDS.secondColony]) {
    assert.equal(available(terms[colony]), false, `colony ${colony}: the term is unavailable`)
    assert.ok(terms[colony].inputs.missing.some((text) => text.includes('which colony of the race')), `colony ${colony} names the claim: ${terms[colony].inputs.missing}`)
  }

  assert.equal(terms[OTHER_COLONY].value, 0, 'the colony elsewhere has none')

  const alone = o.orbitalOrdnanceTerm({ source: { ships: source.colonies[COLONY].ships.filter((ship) => ship.ShipID === IDS.ship) }, mineRate: source.mineRate, admins: chain })

  assert.ok(near(alone.value, TERM), 'the assigned miner alone is the colony\'s, as before')

  const { '../mixins/production-modifiers': mixin } = await w.modules()
  const vm = instantiate(mixin.default, { ...STORE, data: { database: adapterOf(copyOf('contested')), GameID: GAME, RaceID: RACE, loadErrors: {} } })

  await vm.runAsync('populationProductionModifiers')

  const capacity = vm.populationCapacityResult(COLONY, 'ordnance')

  assert.equal(available(capacity), false, 'the colony\'s ordnance capacity is unavailable while the claim is open')
  assert.ok(capacity.inputs.missing.some((text) => text.includes('which colony of the race')), `and names the claim: ${capacity.inputs.missing}`)
  assert.ok(vm.populationCapacityResult(COLONY, 'construction').value >= 0 && available(vm.populationCapacityResult(COLONY, 'construction')), 'the construction capacity is not touched')
})

check('orbital-place', 'a fleet or body with no saved position is matched by the body the fleet orbits; a fleet with neither leaves the colonies it may count for unavailable, naming the position', async (w) => {
  const body = await termOf(w, 'bodyOnly')

  assert.deepEqual(shipsOf(body.source, COLONY), idsOf(IDS.ship, IDS.bodyShip), 'the unassigned fleet that orbits the colony\'s body is matched by it')
  assert.deepEqual(shipsOf(body.source, OTHER_COLONY), [IDS.bodyOtherShip], 'the one that orbits the other body is the other colony\'s')
  assert.ok(near(body.terms[COLONY].value, TERM + UNIT), `the colony: ${body.terms[COLONY].value}, worked by hand ${TERM + UNIT}`)
  assert.ok(near(body.terms[OTHER_COLONY].value, UNIT), 'the other colony')
  assert.equal([...body.source.colonies[COLONY].ships, ...body.source.colonies[OTHER_COLONY].ships].some((ship) => ship.unplaced || ship.contested), false, 'a body that stands in settles the place and the claim')

  const blind = await termOf(w, 'blind')

  assert.deepEqual(shipsOf(blind.source, COLONY), idsOf(IDS.ship, IDS.blindShip), 'the fleet assigned to the colony with no place is listed there')
  assert.deepEqual(shipsOf(blind.source, OTHER_COLONY), [], 'and nowhere else: it is assigned to the colony')
  assert.equal(blind.source.colonies[COLONY].ships.find((ship) => ship.ShipID === IDS.blindShip).unplaced, true, 'its place is told not to be given')
  assert.equal(available(blind.terms[COLONY]), false, 'the term is unavailable')
  assert.ok(blind.terms[COLONY].inputs.missing.some((text) => text.includes('where a fleet')), `names the position: ${blind.terms[COLONY].inputs.missing}`)
  assert.equal(blind.terms[OTHER_COLONY].value, 0, 'the other colony is not touched')

  const free = await termOf(w, 'blindFree')

  for (const colony of [COLONY, OTHER_COLONY]) {
    assert.equal(available(free.terms[colony]), false, `colony ${colony}: an unassigned fleet with no place may be at any colony of the race`)
    assert.ok(free.terms[colony].inputs.missing.some((text) => text.includes('where a fleet')), `colony ${colony} names the position: ${free.terms[colony].inputs.missing}`)
  }
})

check('capacity', 'a colony\'s ordnance capacity adds the orbital term after the installations\' product and never multiplies it by the colony\'s modifier; the other capacities and a row without the term are as before; an unknown term leaves the capacity unavailable', async (w) => {
  const { '../mixins/production-modifiers': mixin, '../utilities/ordnance-modules': o } = await w.modules()
  const modifiers = { ConstructionProduction: 100, OverallProductionModifier: 0.5, ConstructionPower: 4, GroundConstructionPower: 0, OrdnanceProduction: 600, OrdnanceProductionPower: 10, FighterProduction: 60, FighterProductionPower: 2 }
  const term = o.orbitalOrdnanceTerm({ source: { ships: [{ ShipID: 1, FleetID: 1, ParentCommandID: 1, FleetSystemID: 1, crew: 1, captain: 1, captained: true, modules: 10 }] }, mineRate: 100, admins: { 1: { NavalAdminCommandID: 1, ParentCommandID: 0, SystemID: 1, BonusValue: null, Share: 0, Eligible: true, Unknown: null, BonusUnknown: null, Systems: new Set([1]) } } })
  const unknown = o.orbitalOrdnanceTerm({ source: { ships: [{ ShipID: 1, FleetID: 1, ParentCommandID: 1, FleetSystemID: 1, crew: null, captain: 1, captained: true, modules: 10 }] }, mineRate: 100 })
  const capacity = (row, kind) => mixin.capacityResult(row, kind, new Set())

  assert.equal(term.value, 1000, 'the hand figure of the term')
  assert.equal(capacity(modifiers, 'ordnance').value, 3000, 'without the term: 600 x 0.5 x 10')
  assert.equal(capacity({ ...modifiers, OrbitalOrdnance: term }, 'ordnance').value, 4000, 'with the term: 3000 + 1000, the term not halved by the colony\'s 0.5')
  assert.equal(capacity({ ...modifiers, OrbitalOrdnance: o.orbitalOrdnanceTerm({ source: undefined, mineRate: 100 }) }, 'ordnance').value, 3000, 'a colony with no ship adds a known 0')
  assert.equal(capacity({ ...modifiers, OrbitalOrdnance: term }, 'construction').value, 200, 'construction is the installations\' alone')
  assert.equal(capacity({ ...modifiers, OrbitalOrdnance: term }, 'fighter').value, 60, 'light naval is the installations\' alone')
  assert.equal(available(capacity({ ...modifiers, OrbitalOrdnance: unknown }, 'ordnance')), false, 'an unknown term: unavailable')
  assert.ok(capacity({ ...modifiers, OrbitalOrdnance: unknown }, 'ordnance').inputs.missing.some((text) => text.includes('crew')), 'and names what is missing')
  assert.equal(capacity({ ...modifiers, OrbitalOrdnance: term }, 'ordnance').rule.id, 'production.populationCapacity', 'the capacity keeps its rule')
  assert.equal(available(mixin.capacityResult({ ...modifiers, OrbitalOrdnance: term }, 'ordnance', new Set([5]))), false, 'a blocked Production bonus still leaves the capacity unavailable')
})

check('mixin', 'the production modifiers mixin reads the orbital term of a planted copy and gives the colony\'s ordnance capacity through populationCapacityResult', async (w) => {
  const { '../mixins/production-modifiers': mixin } = await w.modules()
  const vm = instantiate(mixin.default, { ...STORE, data: { database: adapterOf(copyOf('orbital')), GameID: GAME, RaceID: RACE, loadErrors: {} } })

  await vm.runAsync('populationProductionModifiers')

  const row = vm.populationProductionModifiers[COLONY]

  assert.ok(row, 'the colony has a modifier row')
  assert.ok(near(row.OrbitalOrdnance.value, TERM), `the colony's term: ${row.OrbitalOrdnance.value}`)
  assert.equal(vm.populationProductionModifiers[OTHER_COLONY].OrbitalOrdnance.value, 0, 'the other colony has none')

  const installations = row.OrdnanceProduction * row.OverallProductionModifier * row.OrdnanceProductionPower
  const capacity = vm.populationCapacityResult(COLONY, 'ordnance')

  assert.ok(near(capacity.value, installations + TERM), `the capacity ${capacity.value} is the installations' ${installations} plus the term ${TERM}`)
  assert.ok(near(vm.populationCapacityResult(OTHER_COLONY, 'ordnance').value, vm.populationProductionModifiers[OTHER_COLONY].OrdnanceProduction * vm.populationProductionModifiers[OTHER_COLONY].OverallProductionModifier * vm.populationProductionModifiers[OTHER_COLONY].OrdnanceProductionPower), 'a colony with no ship has the installations\' alone')

  const claimed = instantiate(mixin.default, { ...STORE, data: { database: adapterOf(copyOf('claim')), GameID: GAME, RaceID: RACE, loadErrors: {} } })

  await claimed.runAsync('populationProductionModifiers')

  const claimedRow = claimed.populationProductionModifiers[COLONY]

  assert.ok(near(claimed.populationCapacityResult(COLONY, 'ordnance').value, claimedRow.OrdnanceProduction * claimedRow.OverallProductionModifier * claimedRow.OrdnanceProductionPower + TERM + 3 * UNIT), 'the capacity adds the miner and the three unassigned fleets the colony counts, and not the fleet a unit off')
})

check('registry', 'the rules the figures name are registered for the 3.2 line with their structure, and their notes carry no code', async (w) => {
  const { '../utilities/provenance': provenance } = await w.modules()

  for (const id of ['ordnance.classModules', 'ordnance.classProduction', 'production.orbitalOrdnance']) {
    const rule = provenance.getRule(id)

    assert.ok(rule, `${id} is registered`)
    assert.deepEqual(rule.versions, ['3.2.x'], `${id}: the 3.2 line`)
    assert.ok(rule.structure.length > 0, `${id}: its structure`)
    assert.ok(!/[`]|\b[A-Z][a-z]+[A-Z]\w*\b/.test(rule.note), `${id}: the note carries no code name: ${rule.note}`)
    assert.ok(!/\b(?:2|3)\.\d+(?:\.\d+)?\b/.test(rule.note), `${id}: the note names no release`)
  }
})

// ---- The planted faults ------------------------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the class production ignores the race\'s rate', target: 'ordnance', from: 'value: stored * rate,', to: 'value: stored,', fails: ['class-totals', 'class-detail'] },
  { name: 'the class count is read from the lines and not the stored column', target: 'ordnance', from: "ofRule({ rule: 'ordnance.classModules', value: stored,", to: "ofRule({ rule: 'ordnance.classModules', value: mounted ?? stored,", fails: ['class-totals'] },
  { name: 'a disagreement of lines and count is never told', target: 'ordnance', from: 'agrees: lines === null || !isNumber(stored) ? null : lines === stored', to: 'agrees: lines === null || !isNumber(stored) ? null : true', fails: ['class-totals', 'class-detail'] },
  { name: 'an unknown count is taken as 0', target: 'ordnance', from: "const modules = isNumber(stored) ? ofRule({ rule: 'ordnance.classModules', value: stored,", to: "const modules = isNumber(stored) || true ? ofRule({ rule: 'ordnance.classModules', value: stored || 0,", fails: ['class-totals'] },
  { name: 'the term takes the Ordnance Factory Module and not the Orbital Mining Module', target: 'ordnance', from: 'export const ORBITAL_MINING_MODULE = 38', to: 'export const ORBITAL_MINING_MODULE = 72', fails: ['orbital-term'] },
  { name: 'the term ignores the damaged modules', target: 'ordnance', from: 'ship.modules + Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))', to: 'ship.modules + row.Designed', fails: ['orbital-term', 'mixin'] },
  { name: 'the term ignores the crew share', target: 'ordnance', from: 'ship.modules * ship.crew * ship.captain', to: 'ship.modules * ship.captain', fails: ['orbital-term', 'orbital-shapes', 'mixin'] },
  { name: 'the term ignores the captain\'s Mining bonus', target: 'ordnance', from: 'ship.modules * ship.crew * ship.captain', to: 'ship.modules * ship.crew', fails: ['orbital-term', 'orbital-shapes', 'mixin'] },
  { name: 'the term ignores the admin chain', target: 'ordnance', from: 'output += fleet.output * chain.bonus', to: 'output += fleet.output', fails: ['orbital-term', 'orbital-shapes', 'mixin'] },
  { name: 'the term takes the Mining bonus of the admin chain and not the Production bonus', target: 'ordnance', from: 'export const PRODUCTION_BONUS = 5', to: 'export const PRODUCTION_BONUS = 6', fails: ['orbital-term', 'mixin'] },
  { name: 'the term groups the ships by the colony their fleet is assigned to, wherever the fleet is', target: 'ordnance', from: 'if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', to: 'if (fleet.AssignedPopulationID === colony.PopulationID) {', fails: ['orbital-term', 'orbital-claim', 'orbital-contested', 'orbital-place', 'mixin'] },
  { name: 'the position test dropped: a fleet counts wherever it is', target: 'colonization', from: 'fleet.RaceID === colony.RaceID && fleetAt(fleet, colony) && fleetClaimable(fleet, colony)', to: 'fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)', fails: ['orbital-term', 'orbital-claim', 'orbital-contested', 'orbital-place'] },
  { name: 'the position read from the orbit the fleet is saved with, not from its coordinates', target: 'colonization', from: 'if (bothPositioned(fleet, colony)) {', to: 'if (false) {', fails: ['orbital-term', 'orbital-claim'] },
  { name: 'a fleet exactly one unit off counted', target: 'colonization', from: 'const withinOneUnit = (a, b) => Math.abs(a - b) < 1', to: 'const withinOneUnit = (a, b) => Math.abs(a - b) <= 1', fails: ['orbital-claim'] },
  { name: 'the unassigned fleets dropped: only a fleet assigned to the colony counts', target: 'colonization', from: '!(fleet.AssignedPopulationID > 0) || !fleet.AssignedExists || fleet.AssignedPopulationID === colony.PopulationID', to: 'fleet.AssignedPopulationID === colony.PopulationID', fails: ['orbital-claim', 'orbital-contested', 'orbital-place', 'mixin'] },
  { name: 'a fleet assigned to a colony that no longer exists not counted', target: 'colonization', from: ' || !fleet.AssignedExists || ', to: ' || ', fails: ['orbital-claim', 'mixin'] },
  { name: 'a fleet assigned to another colony counted', target: 'colonization', from: ' && fleetClaimable(fleet, colony)', to: '', fails: ['orbital-term', 'orbital-contested'] },
  { name: 'a fleet of another race counted for the colony', target: 'colonization', from: 'fleet.RaceID === colony.RaceID && fleetAt(fleet, colony)', to: 'fleetAt(fleet, colony)', fails: ['orbital-term'] },
  { name: 'the claim of an unassigned fleet by two colonies not seen', target: 'ordnance', from: 'contested: reach.length > 1 }', to: 'contested: false }', fails: ['orbital-contested'] },
  { name: 'the open claim named nowhere', target: 'ordnance', from: 'if (ship.modules !== 0 && ship.contested) {', to: 'if (false) {', fails: ['orbital-contested', 'orbital-shapes'] },
  { name: 'a fleet with no place taken as not at the colony', target: 'ordnance', from: ': fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', to: ': false) {', fails: ['orbital-place'] },
  { name: 'a fleet with no place counted as placed', target: 'ordnance', from: 'reach.push({ colony, unplaced: !placed })', to: 'reach.push({ colony, unplaced: false })', fails: ['orbital-place'] },
  { name: 'the missing place named nowhere', target: 'ordnance', from: 'if (ship.modules !== 0 && ship.unplaced) {', to: 'if (false) {', fails: ['orbital-place', 'orbital-shapes'] },
  { name: 'a ship with every module damaged still leaves the place unknown', target: 'ordnance', from: 'if (ship.modules !== 0 && ship.unplaced) {', to: 'if (ship.unplaced) {', fails: ['orbital-shapes'] },
  { name: 'the term is taken at the race\'s ordnance production', target: 'ordnance', from: 'select FCT_Race.MineProduction from FCT_Race', to: 'select FCT_Race.OrdnanceProduction as MineProduction from FCT_Race', fails: ['orbital-term'] },
  { name: 'a withheld Mining bonus is read as the neutral 1', target: 'ordnance', from: 'captain: row.BonusWithheld ? null : bonusOf(', to: 'captain: bonusOf(', fails: ['orbital-unknown'] },
  { name: 'an unknown crew is taken as full', target: 'ordnance', from: "missing.push('the crew of a ship with orbital mining modules or its class crew')", to: 'void 0', fails: ['orbital-unknown'] },
  { name: 'the colony without a ship has an unknown term', target: 'ordnance', from: "return ofRule({ rule: 'production.orbitalOrdnance', value: 0,", to: "return unavailable({ rule: 'production.orbitalOrdnance', missing: ['the ships'] }) || ofRule({ rule: 'production.orbitalOrdnance', value: 0,", fails: ['orbital-term', 'capacity', 'mixin'] },
  { name: 'the term multiplies the colony\'s modifier', target: 'ordnance', from: 'compute: (values) => values.installations + values.orbital', to: 'compute: (values) => values.installations + values.orbital * 0.5', fails: ['capacity', 'mixin'] },
  { name: 'the term replaces the installations', target: 'ordnance', from: 'compute: (values) => values.installations + values.orbital', to: 'compute: (values) => values.orbital', fails: ['capacity', 'mixin'] },
  { name: 'the term is added to every capacity', target: 'mixin', from: "return kind === 'ordnance' && modifiers.OrbitalOrdnance ?", to: 'return modifiers.OrbitalOrdnance ?', fails: ['capacity'] },
  { name: 'the term is never added', target: 'mixin', from: "return kind === 'ordnance' && modifiers.OrbitalOrdnance ?", to: 'return false ?', fails: ['capacity', 'mixin'] },
  { name: 'the mixin gives every colony the term of the first', target: 'mixin', from: 'OrbitalOrdnance: orbital[modifier.PopulationID] }', to: 'OrbitalOrdnance: orbital[Object.keys(orbital)[0]] }', fails: ['mixin'] },
  { name: 'the mixin reads no naval admin chain', target: 'mixin', from: "bonusId: PRODUCTION_BONUS, share: 'Industrial', ranks, blocked }) : {}", to: "bonusId: PRODUCTION_BONUS, share: 'Industrial', ranks, blocked: new Set([PRODUCTION_BONUS]) }) : {}", fails: ['mixin'] },
  { name: 'the Pod size column is back', target: 'designed', from: '  34: [...passiveSensorColumns, ...sizeCostCrewHTK],', to: "  49: [plain('Pod size', 'ComponentValue'), ...reloadColumns, ...sizeCostCrewHTK],\n  34: [...passiveSensorColumns, ...sizeCostCrewHTK],", fails: ['pods'] },
  { name: 'the pod reload is back', target: 'designed', from: 'if (categoryId === 51 || categoryId === 3) {', to: 'if (categoryId === 51 || categoryId === 49 || categoryId === 3) {', fails: ['pods'] },
  { name: 'the danger rating names the pod bay', target: 'safeRoutes', from: 'const ALIEN_KEYS', to: "const POD_BAY = 'FighterPodBay'\nconst ALIEN_KEYS", fails: ['pods'] },
  { name: 'the class usage drops the stored count', target: 'designed', from: '{ stored: isKnownNumber(row.OrdnanceModules) ? row.OrdnanceModules : null,', to: '{ stored: null,', fails: ['class-detail'] },
  { name: 'the class usage counts every component as a module', target: 'designed', from: '(row.ComponentTypeID === ORDNANCE_FACTORY_MODULE ? row.NumComponent : 0)', to: 'row.NumComponent', fails: ['class-detail'] },
  { name: 'the page shows the figures for every design', target: 'designedPage', from: 'return item.ComponentTypeID === ORDNANCE_FACTORY_MODULE', to: 'return true', fails: ['class-detail'] },
  { name: 'the page reads the class count of another column', target: 'designedPage', from: 'FCT_ShipClass.OrdnanceModules, FCT_ShipDesignComponents.ComponentTypeID', to: 'FCT_ShipClass.MiningModules as OrdnanceModules, FCT_ShipDesignComponents.ComponentTypeID', fails: ['class-detail'] },
  { name: 'the danger rating reads the class size as its protection', target: 'safeRoutes', from: 'sum(FCT_ShipClass.ProtectionValue) as Protection, count(FCT_Ship.ShipID) as ProtectionShips, count(FCT_ShipClass.ProtectionValue) as ProtectionKnown from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.GameID = ${GameID} group by FCT_Fleet.SystemID) as VIR_Protection on VIR_Protection.SystemID = FCT_RaceSysSurvey.SystemID` : \'\'', to: 'sum(FCT_ShipClass.Size) as Protection, count(FCT_Ship.ShipID) as ProtectionShips, count(FCT_ShipClass.ProtectionValue) as ProtectionKnown from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.GameID = ${GameID} group by FCT_Fleet.SystemID) as VIR_Protection on VIR_Protection.SystemID = FCT_RaceSysSurvey.SystemID` : \'\'', fails: ['danger'] },
  { name: 'the notes name a column', target: 'ordnance', from: 'The build points of ordnance a year the modules of a class make', to: 'The build points of ordnance a year the OrdnanceModules of a class make', fails: ['registry'] },
]

// Rewrites that say the same thing: the clamp of the damaged modules written as a ternary, the unclaimed-fleet clause with the other comparison.
const BENIGN = [
  { name: 'the damaged modules clamped by a ternary', target: 'ordnance', from: 'Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))', to: '(row.Designed - (row.DamageRows > 0 ? row.Damaged : 0) > 0 ? row.Designed - (row.DamageRows > 0 ? row.Damaged : 0) : 0)' },
  { name: 'the assignment clause written with the assignment first', target: 'colonization', from: '!(fleet.AssignedPopulationID > 0) || !fleet.AssignedExists || fleet.AssignedPopulationID === colony.PopulationID', to: 'fleet.AssignedPopulationID === colony.PopulationID || !(fleet.AssignedPopulationID > 0) || !fleet.AssignedExists' },
  { name: 'the unit test written as a negation', target: 'colonization', from: 'const withinOneUnit = (a, b) => Math.abs(a - b) < 1', to: 'const withinOneUnit = (a, b) => !(Math.abs(a - b) >= 1)' },
  { name: 'the open claim written with the other comparison', target: 'ordnance', from: 'contested: reach.length > 1 }', to: 'contested: reach.length >= 2 }' },
  { name: 'the term of a colony with no ship written through a helper', target: 'ordnance', from: 'if (!source || source.ships.length === 0) {', to: 'if (!(source && source.ships.length > 0)) {' },
]
/* eslint-enable no-template-curly-in-string */

// ---- Run ------------------------------------------------------------------------------------------------------------------------
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
  if (!fs.existsSync(path.join(root, SAVE))) {
    console.log(`UNSUPPORTED  the fixture ${SAVE} is not there`)

    return true
  }

  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(CHECKS, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith()

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      // The rewrites go onto the faulty source where their text is still there exactly once: a fault may replace the very text a rewrite says again.
      benign.filter((edit) => texts[edit.target].split(edit.from).length === 2).forEach((edit) => {
        texts[edit.target] = patched(FILES[edit.target], texts[edit.target], edit.from, edit.to)
      })

      const world = worldOf(texts)
      const missed = []

      for (const id of fault.fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
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
    closeCopies()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeCopies()
    process.exit(2)
  })
