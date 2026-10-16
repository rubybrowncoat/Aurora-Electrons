/*
  Checks how the officers' Logistics bonuses stack on a ship's loading strength (src/renderer/utilities/handling-bonuses.js, handling-support.js, naval-admins.js, transport.js, hauling.js, haul-plan.js, the breakdown component and the Transport and Hauling pages) without a save.

  Every statement runs on ships, colonies, officers and a database made here and on the real utilities, component and pages. Nothing is read from a save. The statements cover the acceptance of AE-082-01:
  - the ship's own term changes with each applicable officer bonus (the ship commander, the naval admin chain at the stop's system, the colony governor, the sector commander), and the colony's additive term does not;
  - a crew deficit applies once, an over-crewed ship is no faster and a ship with no crew aboard cannot load;
  - Transport (the round trip and the fleets sailing together), Hauling (the cycle) and the repeated scenarios (the class plans) share one breakdown of the factors, and the pages hand the loaded officers to it;
  - an officer the save cannot settle makes the figure an estimate that lists the officers it knows, and an officer with no row is no bonus, not an unknown;
  - the loader reads the officers from SQLite databases built here with the columns the real queries use: every prerequisite it lacks becomes a gap of its own factor and never rejects the read, and a population with no naval headquarters still covers its own system;
  - the read follows the race the page shows, and every figure of the breakdown carries a provenance result.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names, alone and after every benign edit (a rewording, a reordered attribute list, extra whitespace) has been applied; each benign edit alone and all of them together must leave every check green. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and an edit whose anchor does not match exactly once each set exit code 1. `--no-mutations` skips the faults and the benign edits.

  The component and the pages are checked by what they do: the component's computed values and the pages' computed rows evaluated on a pseudo instance, the asynchronous read on a real Vue instance, and the compiled templates' elements and bound expressions evaluated against rendered states. No statement matches source text or prose; a planted fault or a benign edit finds its place by an attribute, a key or a piece of code, never by what the page says.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const compiler = require('vue/compiler-sfc')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const inRenderer = (...parts) => path.join(rendererDirectory, ...parts)

const FILES = {
  bonuses: inRenderer('utilities', 'handling-bonuses.js'),
  support: inRenderer('utilities', 'handling-support.js'),
  admins: inRenderer('utilities', 'naval-admins.js'),
  transport: inRenderer('utilities', 'transport.js'),
  hauling: inRenderer('utilities', 'hauling.js'),
  plan: inRenderer('utilities', 'haul-plan.js'),
  minerals: inRenderer('utilities', 'minerals.js'),
  crew: inRenderer('utilities', 'crew.js'),
  profile: inRenderer('utilities', 'fleet-profile.js'),
  mixin: inRenderer('mixins', 'handling-support.js'),
  component: inRenderer('components', 'page', 'HandlingBreakdown.vue'),
  profileComponent: inRenderer('components', 'page', 'FleetProfile.vue'),
  haulingPage: inRenderer('pages', 'hauling.vue'),
  transportPage: inRenderer('pages', 'information.vue'),
}

// The fleet profile of Transport and Hauling is a feature of its own: where its two files are not part of the tree, what asserts them is left out.
const FLEET_PROFILE = fs.existsSync(FILES.profile) && fs.existsSync(FILES.profileComponent)

if (!FLEET_PROFILE) {
  delete FILES.profile
  delete FILES.profileComponent
}

const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------
const VERSION = '2.7.1'
// The race's cargo shuttle technology (the load modifier): every strength below is worked from it by hand.
const TECH = 1.5
const IDS = { GameID: 1, RaceID: 2 }

// A ship over the landing size with undamaged bays of strength 2, fully crewed, in the fleet of naval admin command 10.
const ship = (extra = {}) => ({ ShipID: 1, ShipName: 'Hauler', ClassName: 'Freighter', FleetID: 5, FleetName: 'Line', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: 1000, EnginePower: 10, FuelEfficiency: 1, FuelCapacity: 1e9, ShuttleTechnology: TECH, UndamagedEnginePower: 20, OverhaulFactor: 1, Fuel: 1e9, MaintenanceState: 0, MothershipID: 0, TractorTargetShipID: 0, TractorParentShipID: 0, TractorTargetShipyardID: 0, TowedSize: null, FleetSpeed: 1000, UseMaximumSpeed: 1, ...extra })

// A colony row as the pages' queries give it: population 7 in system 3 with one spaceport.
const colony = (extra = {}) => ({ PopName: 'Mars', PopulationID: 7, SystemID: 3, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra })

// A naval admin command as `loadNavalAdmins` gives it: its commander's bonus, the command type's share, the systems in its radius.
const command = (id, system, parent, bonus, share, systems) => ({ NavalAdminCommandID: id, SystemID: system, ParentCommandID: parent, BonusValue: bonus, Share: share, Eligible: true, Unknown: null, BonusUnknown: null, Systems: new Set(systems) })

const support = (extra = {}) => ({ mode: 'loaded', withheld: null, gaps: { commander: null, admin: null, governor: null, sector: null }, commanders: {}, governors: {}, sectors: {}, admins: {}, ...extra })

// Every officer applies: the ship's commander 1.2, the admin chain 1 + 0.2 x 0.25 = 1.05, the governor 1.1 and the sector commander's quarter, 1 + 0.4 x 0.25 = 1.1.
const FULL = () => support({ commanders: { 1: 1.2 }, governors: { 7: 1.1 }, sectors: { 3: 1.4 }, admins: { 10: command(10, 3, 0, 1.2, 0.25, [3]) } })
const FULL_PRODUCT = 1.2 * 1.05 * 1.1 * 1.1

// The governor's bonus has a row with no value, so that officer is unknown and the rest apply.
const PARTIAL = () => support({ commanders: { 1: 1.2 }, governors: { 7: null }, sectors: { 3: 1.4 }, admins: { 10: command(10, 3, 0, 1.2, 0.25, [3]) } })

const OFFICERS = ['commander', 'admin', 'governor', 'sector']

const near = (actual, expected, message = '') => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${message} ${actual} is not ${expected}`.trim())

const states = (factors) => Object.fromEntries(factors.map((factor) => [factor.key, factor.state]))

// What two breakdowns of the same ship at the same stop must agree on.
const terms = (breakdown) => ({ own: breakdown.own, factors: breakdown.factors.map(({ key, state, value }) => [key, state, value]), officers: breakdown.officers, technology: breakdown.technology, ownTerm: breakdown.ownTerm, additive: breakdown.additive, strength: breakdown.strength, estimate: breakdown.estimate })

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- SQLite databases the loader reads --------------------------------------------------------------------------------
// The tables and columns the loader's queries use, listed here from the queries themselves: a database lacking one of them answers the query that names it with an error, as a save of another version would.
const SCHEMA = {
  FCT_Commander: ['CommanderID', 'RaceID', 'CommandType', 'CommandID', 'RankID'],
  FCT_CommanderBonuses: ['CommanderID', 'BonusID', 'BonusValue'],
  FCT_RaceSysSurvey: ['GameID', 'SystemID', 'RaceID', 'SectorID'],
  FCT_NavalAdminCommand: ['NavalAdminCommandID', 'ParentAdminCommandID', 'ShipID', 'MinimumRankPriority', 'PopulationID', 'AdminCommandTypeID', 'GameID', 'RaceID'],
  FCT_Population: ['PopulationID', 'SystemID'],
  FCT_PopulationInstallations: ['GameID', 'PopID', 'PlanetaryInstallationID', 'Amount'],
  DIM_PlanetaryInstallation: ['PlanetaryInstallationID', 'NavalHeadquartersValue'],
  FCT_Ship: ['ShipID', 'FleetID', 'GameID', 'RaceID'],
  FCT_Fleet: ['FleetID', 'SystemID', 'GameID', 'RaceID', 'ParentCommandID'],
  DIM_NavalAdminCommandType: ['CommandTypeID', 'Radius', 'Logistics'],
  FCT_Ranks: ['RankID', 'Priority'],
  FCT_JumpPoint: ['GameID', 'SystemID', 'WarpPointID', 'WPLink'],
  FCT_RaceJumpPointSurvey: ['WarpPointID', 'RaceID', 'Charted'],
}

// What each factor of the loader needs of the database, by hand: the commander and the governor the officers' tables, the sector commander the survey's sector too, and the admin chain everything the naval admin query and the fleet's command read. The ranks only ever make the chain's eligibility known.
const OFFICER_TABLES = { FCT_Commander: ['CommanderID', 'RaceID', 'CommandType', 'CommandID'], FCT_CommanderBonuses: ['CommanderID', 'BonusID', 'BonusValue'] }
const NEEDS = {
  commander: OFFICER_TABLES,
  governor: OFFICER_TABLES,
  sector: { ...OFFICER_TABLES, FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'SectorID'] },
  admin: {
    ...OFFICER_TABLES,
    FCT_RaceSysSurvey: ['GameID', 'SystemID', 'RaceID'],
    FCT_NavalAdminCommand: SCHEMA.FCT_NavalAdminCommand,
    FCT_Population: SCHEMA.FCT_Population,
    FCT_PopulationInstallations: SCHEMA.FCT_PopulationInstallations,
    DIM_PlanetaryInstallation: SCHEMA.DIM_PlanetaryInstallation,
    FCT_Ship: SCHEMA.FCT_Ship,
    FCT_Fleet: SCHEMA.FCT_Fleet,
    DIM_NavalAdminCommandType: SCHEMA.DIM_NavalAdminCommandType,
    FCT_JumpPoint: SCHEMA.FCT_JumpPoint,
    FCT_RaceJumpPointSurvey: SCHEMA.FCT_RaceJumpPointSurvey,
  },
}

// Race 2 has a ship commander (ship 1: 1.2; ship 2 has a bonus row with no value), the governor of population 7 (1.1), the sector commander of system 3 (1.4) and the commander of naval admin command 10 (1.2) whose headquarters is on population 70 in system 3, one jump from system 4. Race 9's commander of ship 1 has 5, and a commander has another bonus (6) that is no business of the loader.
const ROWS = () => ({
  FCT_Commander: [
    { CommanderID: 1, RaceID: 2, CommandType: 1, CommandID: 1, RankID: 1 },
    { CommanderID: 2, RaceID: 2, CommandType: 1, CommandID: 2, RankID: 1 },
    { CommanderID: 3, RaceID: 2, CommandType: 3, CommandID: 7, RankID: 1 },
    { CommanderID: 4, RaceID: 2, CommandType: 4, CommandID: 5, RankID: 1 },
    { CommanderID: 5, RaceID: 2, CommandType: 12, CommandID: 10, RankID: 2 },
    { CommanderID: 6, RaceID: 9, CommandType: 1, CommandID: 1, RankID: 1 },
  ],
  FCT_CommanderBonuses: [
    { CommanderID: 1, BonusID: 24, BonusValue: 1.2 },
    { CommanderID: 1, BonusID: 6, BonusValue: 1.9 },
    { CommanderID: 2, BonusID: 24, BonusValue: null },
    { CommanderID: 3, BonusID: 24, BonusValue: 1.1 },
    { CommanderID: 4, BonusID: 24, BonusValue: 1.4 },
    { CommanderID: 5, BonusID: 24, BonusValue: 1.2 },
    { CommanderID: 6, BonusID: 24, BonusValue: 5 },
  ],
  FCT_RaceSysSurvey: [{ GameID: 1, SystemID: 3, RaceID: 2, SectorID: 5 }, { GameID: 1, SystemID: 4, RaceID: 2, SectorID: 0 }],
  FCT_NavalAdminCommand: [{ NavalAdminCommandID: 10, ParentAdminCommandID: 0, ShipID: 0, MinimumRankPriority: 0, PopulationID: 70, AdminCommandTypeID: 1, GameID: 1, RaceID: 2 }],
  FCT_Population: [{ PopulationID: 70, SystemID: 3 }],
  FCT_PopulationInstallations: [{ GameID: 1, PopID: 70, PlanetaryInstallationID: 1, Amount: 1 }],
  DIM_PlanetaryInstallation: [{ PlanetaryInstallationID: 1, NavalHeadquartersValue: 1 }],
  FCT_Ship: [{ ShipID: 1, FleetID: 1, GameID: 1, RaceID: 2 }],
  FCT_Fleet: [{ FleetID: 1, SystemID: 3, GameID: 1, RaceID: 2, ParentCommandID: 10 }],
  DIM_NavalAdminCommandType: [{ CommandTypeID: 1, Radius: 1, Logistics: 0.25 }],
  FCT_Ranks: [{ RankID: 1, Priority: 5 }, { RankID: 2, Priority: 1 }],
  FCT_JumpPoint: [{ GameID: 1, SystemID: 3, WarpPointID: 100, WPLink: 101 }, { GameID: 1, SystemID: 4, WarpPointID: 101, WPLink: 100 }],
  FCT_RaceJumpPointSurvey: [{ WarpPointID: 100, RaceID: 2, Charted: 1 }, { WarpPointID: 101, RaceID: 2, Charted: 1 }],
})

// The names of the tables and columns an `omit` entry takes out: 'Table' the whole table, 'Table.Column' one column.
const kept = (table, omit) => (omit.includes(table) ? null : SCHEMA[table].filter((column) => !omit.includes(`${table}.${column}`)))

// An in-memory database with the schema (less `omit`) and the rows (`rows` changes the default ones), answering the way the page's database does: `query(sql)` gives [rows]. `queries` lists every statement it was asked.
const sqliteOf = ({ omit = [], rows = (data) => data } = {}) => {
  const database = new Database(':memory:')
  const data = rows(ROWS())
  const queries = []

  Object.keys(SCHEMA).forEach((table) => {
    const columns = kept(table, omit)

    if (!columns) {
      return
    }

    database.exec(`create table ${table} (${columns.join(', ')})`)
    ;(data[table] || []).forEach((row) => database.query(`insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => (row[column] === undefined ? null : row[column]))))
  })

  return { queries, query: async (sql) => { queries.push(sql); return [database.query(sql).all()] }, close: () => database.close() }
}

// A database that records what it is asked and has nothing.
const recorder = () => {
  const queries = []

  return { queries, query: async (sql) => { queries.push(sql); return [[]] } }
}

// ---- The world: the modules, the component and the pages as shipped, or with planted faults -------------------------
const worldOf = (text) => {
  const utilitySources = { 'handling-bonuses': text.bonuses, 'handling-support': text.support, 'naval-admins': text.admins, transport: text.transport, hauling: text.hauling, 'haul-plan': text.plan, minerals: text.minerals, crew: text.crew, ...(FLEET_PROFILE ? { 'fleet-profile': text.profile } : {}) }
  const pageSources = {
    ...Object.fromEntries(Object.entries(utilitySources).map(([name, source]) => [`utilities/${name}`, source])),
    'mixins/handling-support': text.mixin,
    'components/page/HandlingBreakdown': text.component,
    ...(FLEET_PROFILE ? { 'components/page/FleetProfile': text.profileComponent } : {}),
    'pages/hauling': text.haulingPage,
    'pages/information': text.transportPage,
  }
  const labelsOf = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
  const modules = memo(() => loadUtilities(['handling-bonuses', 'handling-support', 'naval-admins', 'transport', 'hauling', 'haul-plan', 'minerals', 'crew', 'provenance'], { sources: utilitySources }))
  const component = memo(() => loadPage('components/page/HandlingBreakdown', { sources: pageSources }))
  const profileComponent = memo(() => (FLEET_PROFILE ? loadPage('components/page/FleetProfile', { sources: pageSources }) : null))
  const hauling = memo(() => loadPage('pages/hauling', { sources: pageSources, modules: { 'mixins/load-state': labelsOf } }))
  const transport = memo(() => loadPage('pages/information', { sources: pageSources, modules: { 'mixins/load-state': labelsOf } }))

  return { text, modules, component, profileComponent, hauling, transport }
}

// ---- The checks --------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

const STORE = { getters: { 'capabilities/result': {}, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }

check('ship-term', 'the ship\'s own term changes with each applicable officer bonus and with no other, and the colony\'s additive term stays what the race\'s technology gives', async (w) => {
  const { transport } = await w.modules()
  const at = (sup, shipExtra = {}, row = {}) => transport.handlingBreakdown(ship(shipExtra), transport.colonyEndpoint(colony(row)), TECH, VERSION, sup)
  const bare = at(support())

  near(bare.own, 2)
  near(bare.ownTerm, 2 * TECH)
  near(bare.additive, TECH)
  near(bare.strength, 2 * TECH + TECH)
  assert.deepEqual(states(bare.factors), { commander: 'none', admin: 'none', governor: 'none', sector: 'none' })

  // One officer at a time: [the support with the bonus at `value`, the factor it gives].
  const SOLO = {
    commander: (value) => [support({ commanders: { 1: value } }), value],
    admin: (value) => [support({ admins: { 10: command(10, 3, 0, value, 0.5, [3]) } }), 1 + (value - 1) * 0.5],
    governor: (value) => [support({ governors: { 7: value } }), value],
    sector: (value) => [support({ sectors: { 3: value } }), 1 + (value - 1) * 0.25],
  }

  for (const key of OFFICERS) {
    const seen = []

    for (const value of [1.1, 1.5, 2]) {
      const [sup, factor] = SOLO[key](value)
      const found = at(sup)

      assert.deepEqual(states(found.factors), { ...states(bare.factors), [key]: 'applies' }, `${key} alone applies`)
      near(found.officers, factor, `${key} product`)
      near(found.ownTerm, 2 * factor * TECH, `${key} own term`)
      near(found.additive, TECH, `${key} leaves the additive term`)
      near(found.strength, found.ownTerm + found.additive, `${key} strength`)
      seen.push(found.ownTerm)
    }

    assert.ok(seen[0] < seen[1] && seen[1] < seen[2], `${key}: a larger bonus gives a larger own term`)
  }

  const full = at(FULL())

  assert.deepEqual(states(full.factors), { commander: 'applies', admin: 'applies', governor: 'applies', sector: 'applies' })
  near(full.officers, FULL_PRODUCT)
  near(full.officers, full.factors.reduce((product, factor) => product * factor.value, 1))
  near(full.ownTerm, 2 * FULL_PRODUCT * TECH)
  near(full.additive, TECH)
  near(full.strength, 2 * FULL_PRODUCT * TECH + TECH)

  // A landing craft's own strength is 1 whatever bays it has, and the officers multiply that.
  const small = at(FULL(), { Size: 10, ShuttleStrength: 9 })

  near(small.own, 1)
  near(small.ownTerm, FULL_PRODUCT * TECH)

  // A stop with no colony has no governor and no sector commander; a colony with no officer row has none either.
  const site = at(FULL(), {}, { PopulationID: null })

  assert.deepEqual(states(site.factors), { commander: 'applies', admin: 'applies', governor: 'none', sector: 'none' })
  near(site.officers, 1.2 * 1.05)
})

check('additive', 'what a spaceport or cargo shuttle station adds is the race\'s technology once, whatever the officers and however many stations, and no officer multiplies it', async (w) => {
  const { transport } = await w.modules()
  const at = (sup, row = {}, shipExtra = {}) => transport.handlingBreakdown(ship(shipExtra), transport.colonyEndpoint(colony(row)), TECH, VERSION, sup)

  for (const sup of [support(), FULL(), null]) {
    for (const stations of [1, 2, 7]) {
      const found = at(sup, { ShuttleCapacity: stations })

      near(found.additive, TECH, `${stations} stations`)
      near(found.strength - found.ownTerm, TECH, `${stations} stations`)
    }
  }

  near(at(FULL()).additive, at(support()).additive, 'the additive term is the same with and without officers')
  assert.ok(at(FULL()).ownTerm > at(support()).ownTerm)

  const unserved = at(FULL(), { ShuttleCapacity: 0 })

  near(unserved.additive, 0)
  near(unserved.strength, unserved.ownTerm)
  assert.equal(at(FULL(), { ShuttleCapacity: null }), null, 'a colony whose service is not in the save has no strength')
  assert.equal(at(FULL(), {}, { ShuttleStrength: null }), null, 'a ship whose bays are not in the save has no strength')
})

check('crew', 'a crew deficit applies once, an over-crewed ship is no faster and a ship with no crew aboard cannot load', async (w) => {
  const { transport } = await w.modules()
  const endpoint = transport.colonyEndpoint(colony())
  const run = (extra) => transport.stopHandling({ MoveActionID: 62, endpoint }, [ship(extra)], TECH, 1, { version: VERSION, support: FULL() })
  const full = run({})
  const strength = 2 * FULL_PRODUCT * TECH + TECH

  near(full.strength, strength)
  near(full.seconds, (1000 * 20) / strength)
  near(full.breakdown.crew, 1)

  const half = run({ CurrentCrew: 50 })

  near(half.seconds, full.seconds * 2, 'half the crew takes twice as long')
  near(half.breakdown.crew, 0.5)
  near(half.strength, full.strength, 'the deficit is not part of the strength')
  near(run({ CurrentCrew: 25 }).seconds, full.seconds * 4, 'a quarter of the crew takes four times as long, not sixteen')
  near(run({ CurrentCrew: 300 }).seconds, full.seconds, 'more crew than the class needs is no faster')
  near(run({ CurrentCrew: 300 }).breakdown.crew, 1)
  near(run({ ClassCrew: 0, CurrentCrew: 0 }).seconds, full.seconds, 'a class with no crew is never scaled')

  const empty = run({ CurrentCrew: 0 })

  assert.equal(empty.seconds, null)
  assert.equal(empty.eligibility.status, 'blocked')
  assert.ok(empty.eligibility.reasons.some((reason) => reason.code === 'crew' && reason.status === 'blocked'))
  assert.equal(empty.breakdown, null)

  const unread = run({ CurrentCrew: null })

  assert.equal(unread.seconds, null)
  assert.equal(unread.eligibility.status, 'unsupported')

  // The same deficit in a group of ships: the slowest sets the stop and a full crew beside it changes nothing.
  const group = transport.stopHandling({ MoveActionID: 62, endpoint }, [ship(), ship({ CurrentCrew: 50 })], TECH, 1, { version: VERSION, support: FULL() })

  near(group.seconds, full.seconds * 2)
})

check('shared', 'Transport, Hauling and the class plans give a ship the same breakdown at the same stop, and a class plan has no officers', async (w) => {
  const { transport, hauling, 'haul-plan': plan } = await w.modules()
  const origin = transport.colonyEndpoint(colony())
  const destination = transport.colonyEndpoint(colony({ PopName: 'Venus', PopulationID: 8, SystemID: 4, ShuttleCapacity: 0 }))
  const sup = support({ commanders: { 1: 1.2 }, governors: { 7: 1.1, 8: 1.3 }, sectors: { 3: 1.4, 4: 2 }, admins: { 10: command(10, 3, 0, 1.2, 0.25, [3, 4]) } })
  const direct = (kind, where) => transport.stopHandling({ MoveActionID: kind, endpoint: where }, [ship()], TECH, 1, { version: VERSION, support: sup })
  const loading = direct(62, origin)
  const unloading = direct(63, destination)

  // The two ends differ in every officer but the ship's commander, so the comparison is not of equal numbers.
  assert.notDeepEqual(terms(loading.breakdown), terms(unloading.breakdown))

  const orders = [{ MoveActionID: 62, endpoint: origin, label: 'Mars' }, { MoveActionID: 63, endpoint: destination, label: 'Venus' }]
  const fleet = { FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: TECH }
  const cycle = hauling.cycleHandling(orders, hauling.cycleCargo(orders, fleet), fleet, [ship()], { version: VERSION, support: sup })

  assert.deepEqual(cycle.stops.map((stop) => terms(stop.breakdown)), [terms(loading.breakdown), terms(unloading.breakdown)], 'the cycle')
  near(cycle.seconds, loading.seconds + unloading.seconds)

  const trip = transport.roundTrip([ship()], 1e6, { origin, destination }, TECH, { colonists: true, version: VERSION, support: sup })
  const cargo = trip.stops.filter((stop) => stop.kind === 'cargo')

  assert.deepEqual(cargo.map((stop) => terms(stop.breakdown)), [terms(loading.breakdown), terms(unloading.breakdown)], 'the round trip')
  assert.ok(trip.stops.some((stop) => stop.kind === 'colonists'))
  assert.deepEqual(trip.stops.filter((stop) => stop.kind === 'colonists').map((stop) => terms(stop.breakdown).factors), [terms(loading.breakdown).factors, terms(unloading.breakdown).factors].slice(0, 1).concat(trip.stops.filter((stop) => stop.kind === 'colonists').slice(1).map(() => terms(unloading.breakdown).factors)), 'the colonist stops carry the same factors as the cargo stops at the same end')

  const classPlan = plan.haulByClass({ tonnes: 1000, km: 1e6, from: colony(), to: colony({ PopName: 'Venus', PopulationID: 8, SystemID: 4 }) }, { ShipClassID: 1, ClassName: 'Freighter', CargoCapacity: 1000, ColonistCapacity: 0, MaxSpeed: 1000, Size: 20, ShuttleStrength: 2, ClassCrew: 10, EnginePower: 10, FuelEfficiency: 1, FuelCapacity: 1e12, Ships: 1 }, TECH, VERSION)

  assert.equal(classPlan.status, 'ok')

  for (const stop of classPlan.stops) {
    assert.deepEqual(states(stop.breakdown.factors), { commander: 'none', admin: 'none', governor: 'none', sector: 'none' }, 'a class plan has no officers')
    near(stop.breakdown.officers, 1)
    assert.equal(stop.breakdown.estimate, false, 'a class plan is not an estimate for want of officers')
  }

  const plain = transport.stopHandling({ MoveActionID: 62, endpoint: origin }, [ship({ ShipID: 99 })], TECH, 1, { version: VERSION, support: support() })

  assert.deepEqual(terms(classPlan.stops[0].breakdown).factors, terms(plain.breakdown).factors, 'a class plan counts as a save with no officer bonus')
})

check('estimate', 'an officer the save cannot settle makes the figure an estimate that counts it as 1 and lists the officers it knows and the ones it lacks', async (w) => {
  const { transport, hauling, 'handling-bonuses': bonuses } = await w.modules()
  const endpoint = transport.colonyEndpoint(colony())
  const partial = PARTIAL()
  const stop = (sup, ships = [ship()]) => transport.stopHandling({ MoveActionID: 62, endpoint }, ships, TECH, 1, { version: VERSION, support: sup })
  const found = stop(partial)

  assert.equal(found.estimate, true)
  assert.equal(found.breakdown.estimate, true)
  assert.deepEqual(found.known.map((factor) => factor.key), ['commander', 'admin', 'sector'])
  assert.deepEqual(found.unknown.map((factor) => factor.key), ['governor'])
  assert.deepEqual(states(found.breakdown.factors), { commander: 'applies', admin: 'applies', governor: 'unknown', sector: 'applies' })
  near(found.breakdown.officers, 1.2 * 1.05 * 1.1, 'the unknown governor counts as 1')
  near(found.seconds, (1000 * 20) / (2 * 1.2 * 1.05 * 1.1 * TECH + TECH), 'the time counts the officers it knows')

  const settled = stop(FULL())

  assert.equal(settled.estimate, false)
  assert.deepEqual(settled.unknown, [])
  assert.ok(found.seconds > settled.seconds, 'a time with an officer missing errs long')

  // Two ships at a stop: an officer unknown for one of them is unknown for the stop, even where the other has no bonus.
  const mixed = stop(support({ commanders: { 1: 1.2, 2: null } }), [ship(), ship({ ShipID: 2 })])

  assert.equal(mixed.estimate, true)
  assert.deepEqual(mixed.unknown.map((factor) => factor.key), ['commander'])
  assert.deepEqual(mixed.known, [])

  // The round trip and the cycle say the same of the officers, and the provenance result names them.
  const trip = transport.roundTrip([ship()], 1e6, { origin: endpoint, destination: endpoint }, TECH, { colonists: false, version: VERSION, support: partial })

  assert.equal(trip.estimate, true)
  assert.deepEqual(trip.known.map((factor) => factor.key), ['commander', 'admin', 'sector'])
  assert.deepEqual(trip.unknown.map((factor) => factor.key), ['governor'])

  const result = transport.tripResult(trip)
  const whole = transport.tripResult(transport.roundTrip([ship()], 1e6, { origin: endpoint, destination: endpoint }, TECH, { colonists: false, version: VERSION, support: FULL() }))

  assert.equal(result.inputs.present.length, 3)
  assert.equal(result.inputs.missing.length, 1)
  assert.ok(result.assumptions.length > whole.assumptions.length, 'the estimate says what it assumes')
  assert.equal(whole.inputs.missing.length, 0)
  assert.equal(whole.inputs.present.length, 4)

  const orders = [{ MoveActionID: 62, endpoint, label: 'Mars' }, { MoveActionID: 63, endpoint, label: 'Mars' }]
  const fleet = { FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 0, ShuttleTechnology: TECH }
  const cycle = hauling.cycleHandling(orders, hauling.cycleCargo(orders, fleet), fleet, [ship()], { version: VERSION, support: partial })

  assert.equal(cycle.estimate, true)
  assert.deepEqual(cycle.known.map((factor) => factor.key), ['commander', 'admin', 'sector'])
  assert.deepEqual(cycle.unsettled.map((factor) => factor.key), ['governor'])
  assert.deepEqual(cycle.unknown, [], 'an officer the save cannot settle is no problem with the cycle')

  const year = hauling.routeYear({ Speed: 1000, FuelPerHour: 1 }, { km: 1e6 }, hauling.cycleCargo(orders, fleet), cycle)
  const results = hauling.routeResults({ km: 1e6 }, year, cycle)

  for (const key of ['cycle', 'freight', 'colonists', 'fuel']) {
    assert.equal(results[key].inputs.present.length, 3, key)
    assert.equal(results[key].inputs.missing.length, 1, key)
    assert.ok(results[key].assumptions.length > 0, key)
  }

  assert.deepEqual(bonuses.bonusProvenance({ known: [], unknown: [] }).assumptions, [])
})

check('absent-vs-null', 'an officer with no row has no bonus, one with a row that holds no value is unknown, and nothing read, a bonus withheld or a column the save lacks leaves every officer unknown', async (w) => {
  const { 'handling-bonuses': bonuses, 'handling-support': loader } = await w.modules()
  const endpoint = { populationId: 7, systemId: 3 }
  const factors = (sup, extra = {}) => bonuses.officerFactors({ ShipID: 1, NavalAdminCommandID: 10, ...extra }, endpoint, sup)

  assert.deepEqual(states(factors(support())), { commander: 'none', admin: 'none', governor: 'none', sector: 'none' }, 'no rows: no bonus')
  assert.deepEqual(states(factors(support({ commanders: { 1: null }, governors: { 7: null }, sectors: { 3: null } }))), { commander: 'unknown', admin: 'none', governor: 'unknown', sector: 'unknown' }, 'rows without a value')
  assert.deepEqual(states(factors(support({ commanders: { 1: 1 } }))), { commander: 'none', admin: 'none', governor: 'none', sector: 'none' }, 'a bonus of 1 is no bonus')
  assert.deepEqual(states(factors(null)), { commander: 'unknown', admin: 'unknown', governor: 'unknown', sector: 'unknown' }, 'nothing read')
  assert.deepEqual(states(factors({ mode: 'loading' })), { commander: 'unknown', admin: 'unknown', governor: 'unknown', sector: 'unknown' }, 'not loaded')
  assert.deepEqual(states(factors(support({ gaps: { commander: 'the save lacks FCT_Commander (table)', admin: null, governor: null, sector: null } }))), { commander: 'unknown', admin: 'none', governor: 'none', sector: 'none' }, 'a gap leaves one officer unknown')
  assert.deepEqual(states(factors(bonuses.CLASS_ONLY)), { commander: 'none', admin: 'none', governor: 'none', sector: 'none' }, 'a class plan')
  assert.deepEqual(states(factors(support(), { NavalAdminCommandID: undefined })), { commander: 'none', admin: 'unknown', governor: 'none', sector: 'none' }, 'a fleet whose command is not read')
  assert.deepEqual(states(bonuses.officerFactors({ ShipID: 1, NavalAdminCommandID: 10 }, { populationId: 7, systemId: null }, FULL())), { commander: 'applies', admin: 'unknown', governor: 'applies', sector: 'unknown' }, 'a stop whose system is not known')

  for (const factor of factors(null)) {
    assert.equal(factor.value, 1, 'an unknown officer counts as 1')
  }

  const withheld = sqliteOf()
  const blocked = await loader.loadHandlingSupport(withheld, { ...IDS, blocked: new Set([24]) })

  assert.equal(withheld.queries.length, 0, 'a withheld bonus reads nothing')
  assert.deepEqual(states(factors(blocked)), { commander: 'unknown', admin: 'unknown', governor: 'unknown', sector: 'unknown' })

  const read = await loader.loadHandlingSupport(sqliteOf(), IDS)

  assert.deepEqual(states(factors(read)), { commander: 'applies', admin: 'applies', governor: 'applies', sector: 'applies' })
  assert.deepEqual(states(factors(read, { ShipID: 2 })).commander, 'unknown', 'a bonus row with no value')
  assert.deepEqual(states(factors(read, { ShipID: 3 })).commander, 'none', 'no bonus row')
})

check('admin-chain', 'the naval admin chain is the fleet\'s command up its parents, read at the stop\'s system, and a fleet with no command answers to the top command', async (w) => {
  const { 'handling-bonuses': bonuses } = await w.modules()
  const admin = (sup, systemId, extra = {}) => bonuses.officerFactors({ ShipID: 1, NavalAdminCommandID: 10, ...extra }, { populationId: 7, systemId }, sup).find((factor) => factor.key === 'admin')
  const near3 = support({ admins: { 10: command(10, 3, 0, 1.2, 0.25, [3]) } })

  near(admin(near3, 3).value, 1.05)
  assert.equal(admin(near3, 3).state, 'applies')
  assert.equal(admin(near3, 4).state, 'none', 'a stop out of the command\'s range is not served by it')
  assert.equal(admin(support({ admins: { 10: command(10, 3, 0, 1.2, 0.25, [3, 4]) } }), 4).state, 'applies', 'the same command reaches the other system')

  // A fleet command 10 under 11, whose headquarters (system 5) the first command's headquarters (system 3) must be inside the range of: both apply from system 3.
  const tree = support({ admins: { 10: command(10, 3, 11, 1.2, 0.25, [3]), 11: command(11, 5, 0, 1.4, 0.5, [3, 5]) } })

  near(admin(tree, 3).value, 1.05 * 1.2, 'each command passes its commander\'s bonus scaled by its own share')
  near(admin(support({ admins: { 10: command(10, 3, 11, 1.2, 0.25, [3]), 11: command(11, 5, 0, 1.4, 0.5, [5]) } }), 3).value, 1.05, 'a parent that does not reach the child\'s headquarters does not apply')

  // A fleet with no command (0) answers to the command with no parent.
  const top = support({ admins: { 10: command(10, 3, 0, 1.2, 0.25, [3]), 12: command(12, 3, 10, 1.1, 0.25, [3]) } })

  near(admin(top, 3, { NavalAdminCommandID: 0 }).value, 1.05, 'the top command')
  near(admin(top, 3, { NavalAdminCommandID: null }).value, 1.05)
  near(admin(top, 3, { NavalAdminCommandID: 12 }).value, 1.05 * (1 + 0.1 * 0.25), 'the fleet\'s own command, then its parent')

  // A command whose rank or bonus the save does not settle makes the chain unknown, never 1.
  const rankless = support({ admins: { 10: { ...command(10, 3, 0, 1.2, 0.25, [3]), Eligible: null, Unknown: 'the ranks are not in the save' } } })

  assert.equal(admin(rankless, 3).state, 'unknown')
  assert.equal(admin(rankless, 3).text, 'the ranks are not in the save')
  assert.equal(admin(support({ admins: { 10: { ...command(10, 3, 0, null, 0.25, [3]), BonusUnknown: 'no bonus value' } } }), 3).state, 'unknown')
  assert.equal(admin(support({ admins: { 10: { ...command(10, 3, 0, 1.2, 0.25, [3]), Eligible: false } } }), 3).state, 'none', 'a command with no commander of the required rank passes nothing on')
})

check('loader', 'the loader reads the race\'s officers\' Logistics bonuses from the database and nothing of another race or another bonus, and a table with no rows is no bonus', async (w) => {
  const { 'handling-support': loader } = await w.modules()
  const read = await loader.loadHandlingSupport(sqliteOf(), IDS)

  assert.equal(read.mode, 'loaded')
  assert.equal(read.withheld, null)
  assert.deepEqual(read.gaps, { commander: null, admin: null, governor: null, sector: null })
  assert.deepEqual(read.commanders, { 1: 1.2, 2: null }, 'a row with no value is kept as null, the other race\'s and the other bonus are not read')
  assert.deepEqual(read.governors, { 7: 1.1 })
  assert.deepEqual(read.sectors, { 3: 1.4 })
  assert.deepEqual(Object.keys(read.admins), ['10'])

  const [admin] = Object.values(read.admins)

  near(admin.BonusValue, 1.2)
  near(admin.Share, 0.25)
  assert.equal(admin.Eligible, true)
  assert.deepEqual([...admin.Systems].sort(), [3, 4], 'a headquarters of capacity 1 reaches one jump')

  const other = await loader.loadHandlingSupport(sqliteOf(), { GameID: 1, RaceID: 9 })

  assert.deepEqual([other.commanders, other.governors, other.sectors, other.admins], [{ 1: 5 }, {}, {}, {}], 'another race reads its own')

  const empty = await loader.loadHandlingSupport(sqliteOf({ rows: (data) => ({ ...data, FCT_CommanderBonuses: [] }) }), IDS)

  assert.deepEqual([empty.commanders, empty.governors, empty.sectors, empty.admins], [{}, {}, {}, {}], 'no rows is no bonus')
  assert.deepEqual(empty.gaps, { commander: null, admin: null, governor: null, sector: null })
})

check('loader-schema', 'a table or column the save lacks is a gap of the factors that read it and never rejects the read, the other factors are still read, and the officers\' ranks only make the chain unknown', async (w) => {
  const { 'handling-support': loader } = await w.modules()
  const baseline = await loader.loadHandlingSupport(sqliteOf(), IDS)
  const dataOf = { commander: (read) => read.commanders, governor: (read) => read.governors, sector: (read) => read.sectors, admin: (read) => Object.keys(read.admins) }
  const needs = (key, table, column) => Object.prototype.hasOwnProperty.call(NEEDS[key], table) && (column === null ? true : NEEDS[key][table].includes(column))
  const cases = Object.entries(SCHEMA).flatMap(([table, columns]) => [[table, null], ...columns.map((column) => [table, column])])

  assert.equal(cases.length, Object.values(SCHEMA).reduce((total, columns) => total + columns.length + 1, 0))

  for (const [table, column] of cases) {
    const label = column === null ? `${table} (table)` : `${table}.${column}`
    const database = sqliteOf({ omit: [column === null ? table : label] })
    let found

    try {
      found = await loader.loadHandlingSupport(database, IDS)
    } catch (error) {
      throw new Error(`${label} missing: the read was rejected (${error.message})`)
    } finally {
      database.close()
    }

    const ranksOnly = !OFFICERS.some((key) => needs(key, table, column))

    for (const key of OFFICERS) {
      const gap = found.gaps[key]
      const expected = needs(key, table, column)

      assert.equal(typeof gap === 'string' && gap.length > 0, expected, `${label} missing: the ${key} ${expected ? 'has a gap' : 'has none'}`)

      if (expected) {
        assert.deepEqual(dataOf[key](found), key === 'admin' ? [] : {}, `${label} missing: the ${key} has nothing read`)
      } else {
        assert.deepEqual(dataOf[key](found), dataOf[key](baseline), `${label} missing: the ${key} is still read`)
      }
    }

    if (ranksOnly) {
      assert.deepEqual(Object.keys(found.admins), ['10'], `${label} missing: the commands are still read`)
      assert.equal(found.admins[10].Eligible, null, `${label} missing: eligibility is not known`)
      assert.equal(typeof found.admins[10].Unknown, 'string', `${label} missing: the chain says why it is unknown`)
    }
  }
})

check('zero-hq', 'a naval command on a population with no headquarters capacity covers its own system, a command with no location covers none, and the factor follows', async (w) => {
  const { 'handling-support': loader, 'handling-bonuses': bonuses, minerals } = await w.modules()
  const factorAt = (read, systemId) => bonuses.officerFactors({ ShipID: 1, NavalAdminCommandID: 10 }, { populationId: 7, systemId }, read).find((factor) => factor.key === 'admin')

  // The radius itself: no capacity is a radius of 0, a flag bridge too, and a headquarters adds a jump per doubling of its level.
  assert.equal(minerals.navalAdminRadius({ ShipID: 0, HeadquartersLevel: 0, Radius: 2 }), 0)
  assert.equal(minerals.navalAdminRadius({ ShipID: 0, HeadquartersLevel: null, Radius: 2 }), 0)
  assert.equal(minerals.navalAdminRadius({ ShipID: 9, HeadquartersLevel: 4, Radius: 2 }), 0)
  assert.equal(minerals.navalAdminRadius({ ShipID: 0, HeadquartersLevel: 1, Radius: 1 }), 1)
  assert.equal(minerals.navalAdminRadius({ ShipID: 0, HeadquartersLevel: 4, Radius: 2 }), 6)

  const covered = await loader.loadHandlingSupport(sqliteOf(), IDS)

  assert.deepEqual([...covered.admins[10].Systems].sort(), [3, 4])
  assert.equal(factorAt(covered, 4).state, 'applies', 'a headquarters with capacity reaches the next system')

  const bare = await loader.loadHandlingSupport(sqliteOf({ rows: (data) => ({ ...data, FCT_PopulationInstallations: [] }) }), IDS)

  assert.deepEqual([...bare.admins[10].Systems], [3], 'no capacity still covers the origin system')
  assert.equal(factorAt(bare, 3).state, 'applies', 'a stop in the origin system is served')
  near(factorAt(bare, 3).value, 1 + 0.2 * 0.25)
  assert.equal(factorAt(bare, 4).state, 'none', 'a stop one jump away is not')

  const listed = await loader.loadHandlingSupport(sqliteOf({ rows: (data) => ({ ...data, DIM_PlanetaryInstallation: [{ PlanetaryInstallationID: 1, NavalHeadquartersValue: 0 }] }) }), IDS)

  assert.deepEqual([...listed.admins[10].Systems], [3], 'an installation with no headquarters value gives none')

  const nowhere = await loader.loadHandlingSupport(sqliteOf({ rows: (data) => ({ ...data, FCT_Population: [] }) }), IDS)

  assert.equal(nowhere.admins[10].SystemID, null)
  assert.equal(nowhere.admins[10].Systems.size, 0, 'a command with no location covers no system')
  assert.equal(factorAt(nowhere, 3).state, 'none')
})

check('sector-assignment', 'a system whose sector is not recorded makes the sector factor unknown and an estimate, an explicit no sector or a sector commander with no Logistics bonus row is no bonus, and a row with no value is unknown', async (w) => {
  const { 'handling-support': loader, transport } = await w.modules()
  const endpoint = transport.colonyEndpoint(colony())
  const surveyed = (sector) => (data) => ({ ...data, FCT_RaceSysSurvey: data.FCT_RaceSysSurvey.map((row) => (row.SystemID === 3 ? { ...row, SectorID: sector } : row)) })
  const bonusOf = (value) => (data) => ({ ...data, FCT_CommanderBonuses: data.FCT_CommanderBonuses.map((row) => (row.CommanderID === 4 ? { ...row, BonusValue: value } : row)) })
  const without = (data) => ({ ...data, FCT_CommanderBonuses: data.FCT_CommanderBonuses.filter((row) => row.CommanderID !== 4) })
  const cases = [
    ['a sector with a commander bonus', surveyed(5), { 3: 1.4 }, 'applies'],
    ['no sector recorded (null)', surveyed(null), { 3: null }, 'unknown'],
    ['explicitly no sector (0)', surveyed(0), {}, 'none'],
    ['a sector commander with no Logistics row', without, {}, 'none'],
    ['a sector commander whose row has no value', bonusOf(null), { 3: null }, 'unknown'],
  ]

  for (const [label, rows, expected, state] of cases) {
    const database = sqliteOf({ rows })
    const read = await loader.loadHandlingSupport(database, IDS)
    const found = transport.handlingBreakdown(ship(), endpoint, TECH, VERSION, read)

    database.close()
    assert.deepEqual(read.sectors, expected, `${label}: what is read`)
    assert.deepEqual(read.gaps, { commander: null, admin: null, governor: null, sector: null }, `${label}: no gap`)
    assert.equal(states(found.factors).sector, state, `${label}: the factor`)
    assert.equal(found.estimate, state === 'unknown', `${label}: the estimate`)
    assert.deepEqual(found.unknown.map((factor) => factor.key), state === 'unknown' ? ['sector'] : [], `${label}: what is unknown`)
  }

  const [valid, lost, none] = await Promise.all([surveyed(5), surveyed(null), surveyed(0)].map(async (rows) => {
    const database = sqliteOf({ rows })
    const read = await loader.loadHandlingSupport(database, IDS)

    database.close()

    return transport.handlingBreakdown(ship(), endpoint, TECH, VERSION, read)
  }))

  near(lost.strength, none.strength, 'an unknown sector counts as 1, as no sector does')
  assert.ok(valid.strength > lost.strength, 'a sector bonus raises the strength')
})

check('rank-unknown', 'an assigned naval commander whose rank cannot be evaluated (no priority, no rank or no rank row) makes the chain unknown, and a vacant command or a known insufficient rank is no bonus', async (w) => {
  const { 'handling-support': loader, transport } = await w.modules()
  const endpoint = transport.colonyEndpoint(colony())
  const ranks = (change) => (data) => ({ ...data, FCT_Ranks: change(data.FCT_Ranks) })
  const commanders = (change) => (data) => ({ ...data, FCT_Commander: change(data.FCT_Commander) })
  const adminOf = (rows) => async () => {
    const database = sqliteOf({ rows })
    const read = await loader.loadHandlingSupport(database, IDS)

    database.close()

    return read
  }
  const cases = [
    ['a valid rank', (data) => data, 'applies'],
    ['no priority', ranks((list) => list.map((row) => (row.RankID === 2 ? { ...row, Priority: null } : row))), 'unknown'],
    ['no rank on the commander', commanders((list) => list.map((row) => (row.CommanderID === 5 ? { ...row, RankID: null } : row))), 'unknown'],
    ['no row for the rank', ranks((list) => list.filter((row) => row.RankID !== 2)), 'unknown'],
    ['a vacant command', commanders((list) => list.filter((row) => row.CommanderID !== 5)), 'none'],
    ['a known junior rank', (data) => ({ ...data, FCT_NavalAdminCommand: data.FCT_NavalAdminCommand.map((row) => ({ ...row, MinimumRankPriority: 1 })), FCT_Ranks: data.FCT_Ranks.map((row) => (row.RankID === 2 ? { ...row, Priority: 3 } : row)) }), 'none'],
  ]

  for (const [label, rows, state] of cases) {
    const read = await adminOf(rows)()
    const found = transport.handlingBreakdown(ship(), endpoint, TECH, VERSION, read)

    assert.equal(states(found.factors).admin, state, `${label}: the factor`)
    assert.equal(found.estimate, state === 'unknown', `${label}: the estimate`)
    assert.deepEqual(found.unknown.map((factor) => factor.key), state === 'unknown' ? ['admin'] : [], `${label}: what is unknown`)

    if (state === 'applies') {
      near(found.factors.find((factor) => factor.key === 'admin').value, 1.05)
    }
  }

  // The commands above an unevaluable rank are unknown too (their required rank counts it) and a vacant one above them is not: it has no commander to be eligible.
  const tree = (data) => ({
    ...data,
    FCT_NavalAdminCommand: [
      { ...data.FCT_NavalAdminCommand[0], ParentAdminCommandID: 11 },
      { ...data.FCT_NavalAdminCommand[0], NavalAdminCommandID: 11, ParentAdminCommandID: 12 },
      { ...data.FCT_NavalAdminCommand[0], NavalAdminCommandID: 12, ParentAdminCommandID: 0 },
    ],
    FCT_Commander: [...data.FCT_Commander.map((row) => (row.CommanderID === 5 ? { ...row, RankID: null } : row)), { CommanderID: 7, RaceID: 2, CommandType: 12, CommandID: 11, RankID: 2 }],
    FCT_CommanderBonuses: [...data.FCT_CommanderBonuses, { CommanderID: 7, BonusID: 24, BonusValue: 1.1 }],
  })
  const read = await adminOf(tree)()

  assert.equal(typeof read.admins[10].Unknown, 'string', 'the command of the unevaluable rank')
  assert.equal(typeof read.admins[11].Unknown, 'string', 'the command above it')
  assert.equal(read.admins[10].Eligible, null)
  assert.equal(read.admins[11].Eligible, null)
  assert.equal(read.admins[12].Unknown, null, 'a vacant command above is not unknown')
  assert.equal(read.admins[12].Eligible, false)

  // A vacant command below an assigned one with a rank is no unknown for the one above.
  const below = await adminOf((data) => ({ ...tree(data), FCT_Commander: tree(data).FCT_Commander.filter((row) => row.CommanderID !== 5) }))()

  assert.equal(below.admins[10].Unknown, null, 'a vacant command')
  assert.equal(below.admins[11].Unknown, null, 'a command above a vacant one')
  assert.equal(below.admins[11].Eligible, true)
})

check('captain-rank', 'a ship commander of a directly attached fleet whose rank cannot be evaluated (no priority, no rank or no rank row) makes the command and each assigned command above it unknown, a fleet with no commander or with known ranks is no unknown, and one unranked captain among known ones is enough', async (w) => {
  const { 'handling-support': loader, transport } = await w.modules()
  const endpoint = transport.colonyEndpoint(colony())
  const read = async (change) => {
    const database = sqliteOf({ rows: change })
    const found = await loader.loadHandlingSupport(database, IDS)

    database.close()

    return found
  }
  const second = (data, rankId) => ({
    ...data,
    FCT_Ship: [...data.FCT_Ship, { ShipID: 2, FleetID: 1, GameID: 1, RaceID: 2 }],
    FCT_Commander: data.FCT_Commander.map((row) => (row.CommanderID === 2 ? { ...row, RankID: rankId } : row)),
  })
  const cases = [
    ['a known captain', (data) => data, 'applies'],
    ['two known captains', (data) => second(data, 1), 'applies'],
    ['a fleet with no commander', (data) => ({ ...data, FCT_Commander: data.FCT_Commander.filter((row) => row.CommanderID !== 1) }), 'applies'],
    ['a captain with no priority', (data) => ({ ...data, FCT_Ranks: data.FCT_Ranks.map((row) => (row.RankID === 1 ? { ...row, Priority: null } : row)) }), 'unknown'],
    ['a captain with no rank', (data) => ({ ...data, FCT_Commander: data.FCT_Commander.map((row) => (row.CommanderID === 1 ? { ...row, RankID: null } : row)) }), 'unknown'],
    ['a captain whose rank has no row', (data) => ({ ...data, FCT_Ranks: data.FCT_Ranks.filter((row) => row.RankID !== 1) }), 'unknown'],
    ['a known and an unranked captain', (data) => second(data, null), 'unknown'],
    ['a known and a captain whose rank has no row', (data) => second(data, 9), 'unknown'],
  ]

  for (const [label, change, state] of cases) {
    const found = await read(change)
    const breakdown = transport.handlingBreakdown(ship(), endpoint, TECH, VERSION, found)

    assert.equal(states(breakdown.factors).admin, state, `${label}: the factor`)
    assert.equal(breakdown.estimate, state === 'unknown', `${label}: the estimate`)
    assert.deepEqual(breakdown.unknown.map((factor) => factor.key), state === 'unknown' ? ['admin'] : [], `${label}: what is unknown`)

    if (state === 'applies') {
      near(breakdown.factors.find((factor) => factor.key === 'admin').value, 1.05)
    }

    assert.equal(typeof found.admins[10].Unknown === 'string', state === 'unknown', `${label}: the command`)
  }

  // The commands above are unknown as well (their required rank counts the captain), a vacant one above is not, and a vacant command with an unranked captain stays neutral.
  const tree = (data) => ({
    ...data,
    FCT_NavalAdminCommand: [
      { ...data.FCT_NavalAdminCommand[0], ParentAdminCommandID: 11 },
      { ...data.FCT_NavalAdminCommand[0], NavalAdminCommandID: 11, ParentAdminCommandID: 12 },
      { ...data.FCT_NavalAdminCommand[0], NavalAdminCommandID: 12, ParentAdminCommandID: 0 },
    ],
    FCT_Commander: [...data.FCT_Commander.map((row) => (row.CommanderID === 1 ? { ...row, RankID: null } : row)), { CommanderID: 7, RaceID: 2, CommandType: 12, CommandID: 11, RankID: 2 }],
    FCT_CommanderBonuses: [...data.FCT_CommanderBonuses, { CommanderID: 7, BonusID: 24, BonusValue: 1.1 }],
  })
  const above = await read(tree)

  assert.equal(typeof above.admins[10].Unknown, 'string', 'the command of the captain')
  assert.equal(typeof above.admins[11].Unknown, 'string', 'the command above it')
  assert.equal(above.admins[11].Eligible, null)
  assert.equal(above.admins[12].Unknown, null, 'a vacant command above is not unknown')

  const vacant = await read((data) => ({ ...tree(data), FCT_Commander: tree(data).FCT_Commander.filter((row) => row.CommanderID !== 5) }))

  assert.equal(vacant.admins[10].Unknown, null, 'a vacant command with an unranked captain')
  assert.equal(typeof vacant.admins[11].Unknown, 'string', 'the command above a vacant one holding the captain')
})

check('race-switch', 'the officers\' read starts again when the race the page shows changes, on both pages', async (w) => {
  const Vue = require('vue')

  if (!Vue.__handlingBonusesReady) {
    Vue.config.productionTip = false
    Vue.config.devtools = false
    Vue.config.silent = true
    Vue.use(require('vue-async-computed').default, { errorHandler: () => {} })
    Vue.__handlingBonusesReady = true
  }

  const until = async (test, what) => {
    for (let waited = 0; waited < 2000; waited += 10) {
      if (test()) {
        return
      }

      await pause()
    }

    throw new Error(`the page did not reach: ${what}`)
  }

  for (const [name, load] of [['Hauling', w.hauling], ['Transport', w.transport]]) {
    const options = await load()
    const gates = options.mixins.find((mixin) => mixin && mixin.methods && mixin.methods.capabilityGates)
    const read = options.asyncComputed.handlingSupport

    assert.ok(gates, `${name}: the page reads the capability check`)
    assert.ok(read && typeof read.get === 'function', `${name}: the page has the read`)

    const shown = Vue.observable({ race: 2 })
    const database = sqliteOf()
    const vm = new Vue({
      mixins: [gates],
      data: () => ({ loadErrors: {} }),
      computed: { database: () => database, GameID: () => 1, RaceID: () => shown.race },
      asyncComputed: { handlingSupport: { get: read.get, default: null } },
      beforeCreate() {
        this.$store = STORE
      },
    })

    try {
      await until(() => vm.loadErrors.handlingSupport === null && vm.handlingSupport && vm.handlingSupport.commanders[1] === 1.2, `${name}: the officers of the first race`)
      shown.race = 9
      await until(() => vm.loadErrors.handlingSupport === null && vm.handlingSupport && vm.handlingSupport.commanders[1] === 5, `${name}: the officers of the race it was switched to`)
      assert.ok(database.queries.some((sql) => /FCT_Commander\.RaceID = 9\b/.test(sql)), `${name}: asked for the other race`)
    } finally {
      vm.$destroy()
      database.close()
    }
  }
})

check('rows', 'the breakdown rows carry each term of the strength, a cell that tells a bonus from none and from unknown, and a provenance result for every figure that names what it read', async (w) => {
  const { transport } = await w.modules()
  const stop = (sup, row = {}) => transport.stopHandling({ MoveActionID: 62, endpoint: transport.colonyEndpoint(colony(row)) }, [ship({ CurrentCrew: 50 })], TECH, 1, { version: VERSION, support: sup })
  const rowsOf = (sup, row) => transport.handlingRows([{ key: 'a', label: 'Loading', breakdown: stop(sup, row).breakdown }, { key: 'b', label: 'Nothing moves', breakdown: null }])
  const rows = rowsOf(support({ commanders: { 1: 1.2 }, governors: { 7: null } }))

  assert.equal(rows.length, 1, 'a stop that moves nothing has no row')

  const [row] = rows
  const cells = Object.fromEntries(row.factors.map((factor) => [factor.key, factor.cell]))

  assert.equal(row.stop, 'Loading')
  near(row.own, 2)
  near(row.technology, TECH)
  near(row.additive, TECH)
  near(row.crew, 0.5)
  near(row.ownTerm, 2 * 1.2 * TECH)
  near(row.strength, 2 * 1.2 * TECH + TECH)
  assert.equal(row.estimate, true)
  assert.equal(new Set(Object.values(cells)).size, 3, 'a bonus, none and unknown show differently')
  assert.equal(cells.sector, cells.admin, 'two officers with no bonus show alike')
  assert.notEqual(cells.governor, cells.sector, 'an unknown officer does not show as none')
  assert.ok(/1\.2/.test(cells.commander), 'the bonus shows its multiplier')
  assert.equal(row.result.inputs.present.length, 1)
  assert.equal(row.result.inputs.missing.length, 1)
  near(row.result.value, row.strength)
  assert.equal(rowsOf(FULL())[0].estimate, false)
  assert.equal(rowsOf(FULL())[0].result.inputs.missing.length, 0)

  // A provenance result for every figure, settled or not: its value is the figure, and an officer the save cannot settle has none.
  for (const [label, found] of [['settled', rowsOf(FULL())[0]], ['partial', row], ['no colony addition', rowsOf(FULL(), { ShuttleCapacity: 0 })[0]]]) {
    const figures = { own: found.own, technology: found.technology, additive: found.additive, crew: found.crew, seconds: found.seconds }

    assert.deepEqual(Object.keys(found.results).sort(), Object.keys(figures).sort(), `${label}: a result for each term`)

    for (const [key, figure] of Object.entries(figures)) {
      const result = found.results[key]

      assert.ok(result && result.rule && typeof result.rule.id === 'string', `${label}: ${key} carries a result`)
      assert.equal(result.status === 'unavailable', false, `${label}: ${key} has a value`)
      near(result.value, figure, `${label}: ${key}`)
    }

    for (const factor of found.factors) {
      assert.ok(factor.result && typeof factor.result.rule.id === 'string', `${label}: ${factor.key} carries a result`)

      if (factor.state === 'unknown') {
        assert.equal(factor.result.status, 'unavailable', `${label}: ${factor.key} is unknown`)
        assert.equal(factor.result.value, null)
        assert.ok(factor.result.inputs.missing.length > 0, `${label}: ${factor.key} names what is missing`)
      } else {
        near(factor.result.value, factor.value, `${label}: ${factor.key}`)
        assert.equal(factor.result.inputs.missing.length, 0, `${label}: ${factor.key} lacks nothing`)
        assert.equal(factor.result.inputs.present.length > 0 || factor.result.assumptions.length > 0, true, `${label}: ${factor.key} says what it rests on`)
      }
    }
  }

  assert.equal(new Set(row.factors.filter((factor) => factor.state === 'applies').map((factor) => factor.result.inputs.present[0])).size, row.factors.filter((factor) => factor.state === 'applies').length, 'each applying officer is named')
  assert.notEqual(row.factors.find((factor) => factor.key === 'governor').result.status, row.factors.find((factor) => factor.key === 'commander').result.status, 'an unknown officer differs from one that applies')
})

// The elements of a compiled Vue template and the attribute a start tag carries (static or bound).
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
  const found = node.attrsList.find((attr) => attr.name === name || attr.name === `:${name}` || attr.name === `v-bind:${name}`)

  return found ? found.value : undefined
}

const isBound = (node, name) => node.attrsList.some((attr) => attr.name === `:${name}` || attr.name === `v-bind:${name}`)

const templateOf = (source, filename) => {
  const parsed = compiler.parse({ source, filename })

  return compiler.compileTemplate({ source: (parsed.descriptor || parsed).template.content, filename, id: filename }).ast
}

// eslint-disable-next-line no-new-func
const evaluated = (expression, scope) => new Function('scope', `with (scope) { return (${expression}) }`)(scope)

const classesOf = (node) => (node.staticClass ? JSON.parse(node.staticClass).split(/\s+/) : [])

// The data a page's rows read, with the officers' read in the state `state` (undefined while it loads, a message when it failed, null once it succeeded).
const loadErrorsOf = (state) => new Proxy({}, { get: (_target, key) => (key === 'handlingSupport' ? state : null), has: () => true })

const PLACE_ORDER = { FleetID: 5, OrderDelay: 0, ActionName: 'Load', Jumps: 0, X: 0, Y: 0, ExitX: 0, ExitY: 0, ExitSystemID: 3, SystemID: 3, DestinationType: 0 }
const ORDERS = [{ ...PLACE_ORDER, MoveActionID: 62, Description: 'Mars: Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }, { ...PLACE_ORDER, MoveActionID: 63, ActionName: 'Unload', Description: 'Venus: Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0 }]
const CYCLE = { FleetID: 5, FleetName: 'Cycle', CargoCapacity: 1000, ColonistCapacity: 200, ShuttleTechnology: TECH, Speed: 1000, FuelPerHour: 1 }
const REACH = { route: { km: 1e6, jumps: 0 }, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }

// A Hauling page instance: one fleet that repeats a cycle from colony 7 to colony 8, with the officers read in `state`.
const haulingVmOf = (page) => (state, data = {}) => instantiate(page, { $store: STORE, database: recorder(), GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(state), handlingSupport: FULL(), fleets: [CYCLE], orders: ORDERS, fleetShips: [ship()], formulaVersion: VERSION, ...data } })

// A Transport page instance: a run from colony 7 to a colony site, with the fleet's ship, the officers read in `state`.
const transportVmOf = (page) => (state, data = {}) => instantiate(page, { $store: STORE, database: recorder(), GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(state), handlingSupport: FULL(), formulaVersion: VERSION, origin: { kind: 'colony', name: 'Mars', colony: colony() }, destination: { kind: 'system', name: 'Site', SystemID: 3 }, reachOf: () => REACH, fleetShips: [ship()], ...data } })

check('pages', 'the Hauling and Transport pages hand the officers they read to the shared handling maths (the class runs and the fleets sailing together each), hold off no panel for them and track the read under the key the page labels it with', async (w) => {
  const hauling = await w.hauling()
  const transportPage = await w.transport()
  const names = ['commander', 'admin', 'governor', 'sector']

  // Hauling: a cycle of one fleet, loading at colony 7 and unloading at colony 8, which has no governor.
  const haulingVm = haulingVmOf(hauling)
  const rowOf = (vm) => vm.routeRows[0]
  const loaded = rowOf(haulingVm(null))
  const [origin, site] = loaded.handlingRows

  assert.deepEqual(origin.factors.map((factor) => factor.key), names)
  assert.deepEqual(states(origin.factors), { commander: 'applies', admin: 'applies', governor: 'applies', sector: 'applies' })
  assert.deepEqual(states(site.factors), { commander: 'applies', admin: 'applies', governor: 'none', sector: 'applies' }, 'a colony with no governor row has none')
  near(origin.ownTerm, 2 * FULL_PRODUCT * TECH)
  near(origin.additive, TECH)
  assert.equal(loaded.estimate, false)

  for (const state of [undefined, 'the read failed']) {
    const vm = haulingVm(state)
    const waiting = rowOf(vm)

    assert.equal(vm.officerSupport, null, 'officers not read are not taken from a stale value')
    assert.equal(waiting.estimate, true, `${state}: an estimate`)
    assert.deepEqual(states(waiting.handlingRows[0].factors), { commander: 'unknown', admin: 'unknown', governor: 'unknown', sector: 'unknown' })
    assert.ok(vm.handlingSupportNote && vm.handlingSupportNote.text, `${state}: the page says the officers were not read`)
    assert.ok(waiting.handlingHours > loaded.handlingHours, 'a cycle without the officers errs long')
    assert.deepEqual(vm.failedInputs, [], 'the officers\' read holds no panel back')
    assert.equal(vm.inputsLoaded, true)
  }

  assert.equal(haulingVm(null).handlingSupportNote, null)
  assert.equal(haulingVm('the read failed').handlingSupportState.failed, true)
  assert.equal(haulingVm(undefined).handlingSupportState.loading, true)

  // The reads the page labels, tracks and runs are one set: the officers' read lands in `loadErrors` under its label.
  const database = sqliteOf()
  const reads = instantiate(hauling, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

  await reads.runAsync('handlingSupport')
  assert.ok('handlingSupport' in reads.inputLabels, 'labelled')
  assert.equal(reads.loadErrors.handlingSupport, null, 'tracked under its label')
  assert.deepEqual(reads.handlingSupport.commanders, { 1: 1.2, 2: null })
  assert.deepEqual(reads.handlingSupport.governors, { 7: 1.1 })
  database.close()

  const ships = recorder()
  const shipsAsked = instantiate(hauling, { $store: STORE, database: ships, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

  await shipsAsked.runAsync('fleetShips')
  assert.ok(ships.queries.some((sql) => /FCT_Fleet\.ParentCommandID as NavalAdminCommandID/.test(sql)), 'the ships carry their fleet\'s command')

  // Transport, the class runs: a run from a colony to a colony site.
  const transportVm = transportVmOf(transportPage)
  const group = { FleetID: 5, FleetName: 'Line', civilian: false }
  const shipClass = { ShipClassID: 1, ClassName: 'Freighter', ships: [ship()] }
  const runOf = (vm) => vm.runOf(group, shipClass, { route: { km: 1e6, jumps: 0 } }, vm.endpoints)
  const run = runOf(transportVm(null))
  const [start, , end] = run.handlingRows

  assert.deepEqual(states(start.factors), { commander: 'applies', admin: 'applies', governor: 'applies', sector: 'applies' })
  assert.deepEqual(states(end.factors), { commander: 'applies', admin: 'applies', governor: 'none', sector: 'none' })
  assert.deepEqual(terms({ ...origin, officers: origin.officers, estimate: origin.estimate, factors: origin.factors }).factors, terms({ ...start, factors: start.factors }).factors, 'Transport and Hauling give the same factors at the same stop')
  near(start.strength, origin.strength)
  near(end.strength, 2 * 1.2 * 1.05 * TECH, 'a stop with no colony has neither governor nor sector')
  assert.equal(run.estimate, false)

  // Transport, the fleets sailing together (where the fleet profile is part of the tree).
  const fleetRun = FLEET_PROFILE ? transportVm(null).fleetRuns[0] : null

  if (FLEET_PROFILE) {
    assert.ok(fleetRun && fleetRun.handlingRows.length > 0, 'the fleet has stops')
    assert.deepEqual(states(fleetRun.handlingRows[0].factors), { commander: 'applies', admin: 'applies', governor: 'applies', sector: 'applies' }, 'the fleet\'s stops carry the officers')
    near(fleetRun.handlingRows[0].strength, start.strength, 'the fleet and the class give a ship the same strength')
    assert.equal(fleetRun.estimate, false)
  }

  for (const state of [undefined, 'the read failed']) {
    const vm = transportVm(state)
    const waiting = runOf(vm)
    const waitingFleet = FLEET_PROFILE ? vm.fleetRuns[0] : null

    assert.equal(vm.officerSupport, null)
    assert.equal(waiting.estimate, true)
    assert.deepEqual(states(waiting.handlingRows[0].factors), { commander: 'unknown', admin: 'unknown', governor: 'unknown', sector: 'unknown' })
    assert.ok(vm.handlingSupportNote && vm.handlingSupportNote.text)
    assert.ok(waiting.handlingSeconds > run.handlingSeconds)
    assert.deepEqual(vm.failedInputs, [])
    assert.equal(vm.inputsLoaded, true)

    if (FLEET_PROFILE) {
      assert.equal(waitingFleet.estimate, true, `${state}: the fleet is an estimate`)
      assert.deepEqual(states(waitingFleet.handlingRows[0].factors), { commander: 'unknown', admin: 'unknown', governor: 'unknown', sector: 'unknown' })
      assert.ok(waitingFleet.handlingSeconds > fleetRun.handlingSeconds)
    }
  }

  const transportDatabase = sqliteOf()
  const transportReads = instantiate(transportPage, { $store: STORE, database: transportDatabase, GameID: 1, RaceID: 2, data: { loadErrors: {} } })
  const asked = recorder()
  const shipsRead = instantiate(transportPage, { $store: STORE, database: asked, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

  await transportReads.runAsync('handlingSupport')
  assert.ok('handlingSupport' in transportReads.inputLabels)
  assert.equal(transportReads.loadErrors.handlingSupport, null)
  assert.deepEqual(transportReads.handlingSupport.sectors, { 3: 1.4 })
  transportDatabase.close()
  await shipsRead.runAsync('ships')
  assert.ok(asked.queries.some((sql) => /FCT_Fleet\.ParentCommandID as NavalAdminCommandID/.test(sql)), 'the ships carry their fleet\'s command')
})

// The cells of the component that show a figure, by the attribute that marks them, and the figure of a row each shows.
const FIGURE_CELLS = { own: (row) => row.own, technology: (row) => row.technology, additive: (row) => row.additive, crew: (row) => row.crew, strength: (row) => row.strength, time: (row) => row.seconds }

check('template', 'every breakdown host of both pages is bound to the rows of its own row and shows them, and the component shows a cell per officer and a provenance mark with the right result beside every figure', async (w) => {
  const sentinel = [{ key: 'row' }]
  const profileProps = FLEET_PROFILE ? Object.keys((await w.profileComponent()).props || {}) : []

  // The hosts, each selected by what it is (a breakdown, or the fleet profile that is given the rows) and asserted on its own.
  const hostsOf = (page) => {
    const nodes = elementsOf(templateOf(w.text[page], `${page}.vue`))

    return { direct: nodes.filter((node) => node.tag === 'handling-breakdown'), profiles: nodes.filter((node) => node.tag === 'fleet-profile' && attrOf(node, 'handling-rows') !== undefined) }
  }
  const inRow = { item: { handlingRows: sentinel } }

  for (const page of ['haulingPage', 'transportPage']) {
    const { direct, profiles } = hostsOf(page)

    assert.ok(direct.length > 0, `${page}: the class or route table shows a breakdown`)

    for (const host of direct) {
      assert.ok(attrOf(host, 'rows'), `${page}: a breakdown is bound to rows`)
      assert.deepEqual(evaluated(attrOf(host, 'rows'), inRow), sentinel, `${page}: the rows of the row`)
    }

    for (const host of profiles) {
      assert.deepEqual(evaluated(attrOf(host, 'handling-rows'), inRow), sentinel, `${page}: the rows given to the fleet profile`)
    }

    if (FLEET_PROFILE && page === 'transportPage') {
      assert.ok(profiles.length > 0, 'Transport: the fleet profile is given the rows of the fleet')
    }

    assert.ok(elementsOf(templateOf(w.text[page], `${page}.vue`)).some((node) => attrOf(node, 'data-handling-note') !== undefined), `${page}: the note on the officers' read`)
  }

  // The fleet profile's own host (where the fleet profile is part of the tree): shown for rows, bound to the rows it was given, and never for none.
  if (FLEET_PROFILE) {
    assert.ok(profileProps.includes('handlingRows'), 'the fleet profile takes the rows')

    const inProfile = elementsOf(templateOf(w.text.profileComponent, 'FleetProfile.vue')).filter((node) => node.tag === 'handling-breakdown')

    assert.ok(inProfile.length > 0, 'the fleet profile shows a breakdown')

    for (const host of inProfile) {
      assert.deepEqual(evaluated(attrOf(host, 'rows'), { handlingRows: sentinel }), sentinel, 'the fleet profile\'s breakdown shows the rows it was given')
      assert.equal(Boolean(host.if && evaluated(host.if, { handlingRows: sentinel })), true, 'it is shown for rows')
      assert.equal(Boolean(host.if && evaluated(host.if, { handlingRows: [] })), false, 'and hidden for none')
    }
  }

  // The component: the rows of the stops, an officer cell each, and a mark with its own result beside every figure.
  const { transport } = await w.modules()
  const component = await w.component()
  const nodes = elementsOf(templateOf(w.text.component, 'HandlingBreakdown.vue'))
  const [rowLoop] = nodes.filter((node) => attrOf(node, 'data-stop') !== undefined)
  const officers = nodes.filter((node) => node.tag === 'th' && node.for)
  const cells = nodes.filter((node) => attrOf(node, 'data-officer') !== undefined)

  assert.equal(officers.length, 1)
  assert.equal(cells.length, 1)
  assert.ok(nodes.some((node) => node.tag === 'provenance-mark' && attrOf(node, 'rule')), 'the header names the rule')

  const { provenance } = await w.modules()
  const named = nodes.find((node) => node.tag === 'provenance-mark' && attrOf(node, 'rule'))

  assert.ok(provenance.ofRule({ rule: attrOf(named, 'rule'), value: 1, inputs: { present: [], missing: [] } }), 'the rule the mark names is registered')

  const markOf = (cell) => {
    const marks = elementsOf(cell).filter((node) => node.tag === 'provenance-mark')

    assert.equal(marks.length, 1, 'a figure carries one mark')
    assert.ok(isBound(marks[0], 'result'), 'the mark is bound to a result')

    return marks[0]
  }
  const cases = [
    ['settled', support({ commanders: { 1: 1.2 }, governors: { 7: 1.1 }, sectors: { 3: 1.4 }, admins: { 10: command(10, 3, 0, 1.2, 0.25, [3]) } }), {}, 100],
    ['partial', PARTIAL(), {}, 50],
    ['unread', null, { ShuttleCapacity: 0 }, 100],
  ]

  for (const [label, sup, row, crew] of cases) {
    const stop = transport.stopHandling({ MoveActionID: 62, endpoint: transport.colonyEndpoint(colony(row)) }, [ship({ CurrentCrew: crew })], TECH, 1, { version: VERSION, support: sup })
    const rows = transport.handlingRows([{ key: 'a', label: 'Loading', breakdown: stop.breakdown }])
    const vm = instantiate(component, { $store: { getters: {}, state: {} }, data: { rows } })
    const scopeOf = (extra) => Object.assign(Object.create(vm), extra)

    assert.deepEqual(evaluated(rowLoop.for, vm), rows, `${label}: a row per stop`)
    assert.deepEqual(evaluated(officers[0].for, vm).map((officer) => officer.key), OFFICERS, `${label}: a header per officer`)
    assert.deepEqual(evaluated(cells[0].for, scopeOf({ [rowLoop.alias]: rows[0] })), rows[0].factors, `${label}: a cell per officer`)

    for (const factor of rows[0].factors) {
      const scope = scopeOf({ [rowLoop.alias]: rows[0], [cells[0].alias]: factor })

      assert.equal(evaluated(attrOf(cells[0], 'data-state'), scope), factor.state, `${label}: the state of ${factor.key}`)
      assert.equal(evaluated(attrOf(markOf(cells[0]), 'result'), scope), factor.result, `${label}: the result beside ${factor.key}`)
      assert.equal(factor.result.status === 'unavailable', factor.state === 'unknown', `${label}: ${factor.key} has a result only when settled`)
    }

    for (const [key, figure] of Object.entries(FIGURE_CELLS)) {
      const found = nodes.filter((node) => attrOf(node, `data-${key}`) !== undefined)

      assert.equal(found.length, 1, `${label}: one ${key} cell`)

      const result = evaluated(attrOf(markOf(found[0]), 'result'), scopeOf({ [rowLoop.alias]: rows[0] }))

      assert.ok(result && result.rule, `${label}: the ${key} mark has a result`)
      assert.equal(result.status === 'unavailable', false, `${label}: the ${key} result has a value`)
      near(result.value, figure(rows[0]), `${label}: the result beside ${key} is its figure`)
    }

    assert.equal(vm.unknownText.length > 0, label !== 'settled', `${label}: the component says which officers were unknown`)
  }
})

// A panel is a `.panel` of the compiled template; the summary it carries is the attribute's value, which a bound one gives by its expression evaluated in the page.
const panelsOf = (source, filename) => elementsOf(templateOf(source, filename)).filter((node) => classesOf(node).includes('panel'))

const summaryOf = (panel, scope) => {
  if (isBound(panel, 'data-summary')) {
    return evaluated(attrOf(panel, 'data-summary'), scope)
  }

  return attrOf(panel, 'data-summary')
}

// Whether a panel is on the page in a state: false only where its own condition is evaluated and false (a condition that needs the row of a table is taken as shown).
const shownIn = (panel, scope) => {
  if (!panel.if) {
    return true
  }

  try {
    return Boolean(evaluated(panel.if, scope))
  } catch (error) {
    return true
  }
}

check('summary', 'every panel of both pages states its summary, a nonblank text that is the same whether the page is filled, empty, loading, failed or read in part', async (w) => {
  const hauling = await w.hauling()
  const transportPage = await w.transport()
  const haulingVm = haulingVmOf(hauling)
  const transportVm = transportVmOf(transportPage)
  const gap = support({ gaps: { commander: null, admin: 'the save lacks a table of the admin chain', governor: null, sector: null } })
  const views = {
    haulingPage: [
      ['filled', haulingVm(null)],
      ['empty', haulingVm(null, { fleets: [], orders: [], fleetShips: [] })],
      ['loading', haulingVm(undefined)],
      ['failed', haulingVm('the read failed')],
      ['partial', haulingVm(null, { handlingSupport: gap })],
    ],
    transportPage: [
      ['filled', transportVm(null)],
      ['empty', transportVm(null, { origin: null, destination: null, fleetShips: [] })],
      ['loading', transportVm(undefined)],
      ['failed', transportVm('the read failed')],
      ['partial', transportVm(null, { handlingSupport: gap })],
    ],
  }

  for (const [page, list] of Object.entries(views)) {
    const panels = panelsOf(w.text[page], `${page}.vue`)
    const seen = panels.map(() => new Set())

    assert.ok(panels.length > 0, `${page}: the page has panels`)

    for (const [label, vm] of list) {
      const scope = Object.assign(Object.create(vm), {})
      let shown = 0

      panels.forEach((panel, index) => {
        if (!shownIn(panel, scope)) {
          return
        }

        shown += 1

        const summary = summaryOf(panel, scope)

        assert.ok(typeof summary === 'string' && summary.trim().length > 0, `${page}, ${label}: panel ${index + 1} has no summary`)
        seen[index].add(summary)
      })

      assert.ok(shown > 0, `${page}, ${label}: a panel is shown`)
    }

    seen.forEach((summaries, index) => assert.ok(summaries.size <= 1, `${page}: panel ${index + 1} changes its summary with the state of the page`))
  }
})

// ---- Edits: the benign ones and the planted faults ---------------------------------------------------------------------
// Each edit changes one source where the pattern `at` matches it exactly once, to what `to` makes of the match; a fault names the checks that must fail on it (`fails`), a benign edit none. The patterns find their place by code, an attribute or a key, never by what the page says.
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const QUOTED = '"[^"]*"|\'[^\']*\''

const edit = (name, file, at, to, fails = []) => ({ name, file, at, to, fails })

// An edit of the fleet profile's host, which is run only where the fleet profile is part of the tree, and the same fault on the page's own code, run only where it is not.
const fleetEdit = (...args) => ({ ...edit(...args), fleets: true })
const bareEdit = (...args) => ({ ...edit(...args), fleets: false })
const present = (one) => one.fleets === undefined || one.fleets === FLEET_PROFILE

// A fault that swaps one piece of code (found as written) for another.
const swap = (name, file, from, replacement, fails) => edit(name, file, new RegExp(escaped(from)), () => replacement, fails)

// The attributes of a start tag in the opposite order, written out again.
const reversed = (inside) => [...inside.matchAll(new RegExp(`([^\\s=]+)(?:\\s*=\\s*(${QUOTED}))?`, 'g'))].reverse().map(([, name, value]) => (value === undefined ? name : `${name}=${value}`)).join(' ')

// The start tag of the panel that carries the note on the officers' read, and the summary attribute inside it replaced by `replacement`.
const HANDLING_PANEL = /<v-card(?=[^>]*\bclass="panel")[^>]*>(?=(?:(?!<\/v-card>)[\s\S])*?data-handling-note)/
const summaryEdit = (name, file, replacement, fails) => edit(name, file, HANDLING_PANEL, (m) => m[0].replace(new RegExp(`\\sdata-summary\\s*=\\s*(?:${QUOTED})`), replacement), fails)

// The key of the page's labels: the `handlingSupport` entry of the object that labels the reads.
const LABEL_KEY = /(const INPUT_LABELS = \{(?:(?!\n\})[\s\S])*?\n\s+)handlingSupport(?=:)/

// A cell of the component: the whole of the cell that carries `marker`, the mark inside it taken out or bound to `result`.
const cellMark = (marker) => new RegExp(`(<td\\b[^>]*\\b${marker}\\b[^>]*>(?:(?!</td>)[\\s\\S])*?)<provenance-mark\\b[^>]*/>`)

const BENIGN = [
  edit('the label of the read reworded on Hauling', 'haulingPage', /(\n\s+handlingSupport: )(?:'(?:[^'\\]|\\.)*'|"[^"]*")/, (m) => `${m[1]}'Officer bonuses'`),
  edit('the label of the read reworded on Transport', 'transportPage', /(\n\s+handlingSupport: )(?:'(?:[^'\\]|\\.)*'|"[^"]*")/, (m) => `${m[1]}'Officer bonuses'`),
  edit('the summary of the handling panel of Hauling reworded', 'haulingPage', HANDLING_PANEL, (m) => m[0].replace(new RegExp(`(\\sdata-summary\\s*=\\s*)(?:${QUOTED})`), '$1"What the repeated routes take, in another wording."')),
  edit('the summary of the handling panel of Transport reworded', 'transportPage', HANDLING_PANEL, (m) => m[0].replace(new RegExp(`(\\sdata-summary\\s*=\\s*)(?:${QUOTED})`), '$1"How the chosen run goes, in another wording."')),
  edit('the attributes of the breakdown host of Hauling reordered', 'haulingPage', /<handling-breakdown([^>]*?)\s*\/>/, (m) => `<handling-breakdown ${reversed(m[1])} />`),
  edit('the attributes of the breakdown host of Transport reordered', 'transportPage', /<handling-breakdown([^>]*?)\s*\/>/, (m) => `<handling-breakdown ${reversed(m[1])} />`),
  fleetEdit('the attributes of the fleet profile of Transport reordered', 'transportPage', /<fleet-profile([^>]*?)\s*\/>/, (m) => `<fleet-profile ${reversed(m[1])} />`),
  fleetEdit('the attributes of the breakdown host of the fleet profile reordered', 'profileComponent', /<handling-breakdown([^>]*?)\s*\/>/, (m) => `<handling-breakdown ${reversed(m[1])} />`),
  edit('whitespace in the mark of the strength', 'component', /<provenance-mark\s+:result\s*=\s*"row\.result"\s*\/>/, () => '<provenance-mark  :result = "row.result"  />'),
  edit('whitespace in the mark of the time', 'component', /<provenance-mark\s+:result\s*=\s*"row\.results\.seconds"\s*\/>/, () => '<provenance-mark   :result  =  "row.results.seconds"   />'),
  edit('the caption of the component reworded', 'component', /(<div class="caption text--secondary mb-1">)[^<]*(?=<provenance-mark)/, (m) => `${m[1]}Strength per stop`),
  edit('the note on the officers\' read being loaded reworded', 'bonuses', /(tone: 'text--secondary', text: )'(?:[^'\\]|\\.)*'/, (m) => `${m[1]}'Reading the officers.'`),
  edit('the comment above the rows reworded', 'transport', /(?<=\n)\/\/[^\n]*(?=\nexport const handlingRows\b)/, () => '// One row per stop, in another wording.'),
  edit('the first line of the bonuses module reworded', 'bonuses', /^\/\/[^\n]*/, () => '// The officers\' Logistics bonuses, in another wording.'),
  edit('the reason of officers not being read reworded', 'bonuses', /(return OFFICER_KEYS\.map\(\(key\) => unknown\(key, )(?:'(?:[^'\\]|\\.)*')(\)\))/, (m) => `${m[1]}'no officer was loaded'${m[2]}`),
  edit('the noun of the governor reworded', 'bonuses', /(personal\('governor',\s*support\.governors,\s*endpoint\.populationId,\s*)(?:'(?:[^'\\]|\\.)*'|"[^"]*")(?=[,)])/, (m) => `${m[1]}'local governor'`),
  edit('the words of the officer cells reworded', 'bonuses', /(factor\.state === 'none' \? )'[^']*' : '[^']*'/, (m) => `${m[1]}'-' : 'Not known'`),
].filter(present).map((one, index) => ({ ...one, id: `benign:${index}` }))

const FAULTS = [
  swap('the colony\'s additive term is multiplied by the officers', 'transport', 'const additive = endpoint.service ? shuttleTechnology : 0', 'const additive = endpoint.service ? shuttleTechnology * stack.product : 0', ['additive', 'ship-term']),
  swap('the colony adds the technology twice', 'transport', 'const additive = endpoint.service ? shuttleTechnology : 0', 'const additive = endpoint.service ? shuttleTechnology * 2 : 0', ['additive']),
  swap('the sector commander\'s bonus is taken in full', 'bonuses', 'const SECTOR_SHARE = 0.25', 'const SECTOR_SHARE = 1', ['ship-term']),
  edit('the governor is left out', 'bonuses', /personal\('governor',\s*support\.governors,\s*endpoint\.populationId,[^)]*\)/, () => "none('governor', 'x')", ['ship-term']),
  edit('the ship commander is left out', 'bonuses', /personal\('commander',\s*support\.commanders,\s*ship\.ShipID,[^)]*\)/, () => "none('commander', 'x')", ['ship-term']),
  swap('a stop with no colony still has a governor and a sector', 'bonuses', 'const colony = endpoint && Number.isFinite(endpoint.populationId)', 'const colony = endpoint', ['ship-term', 'pages']),
  swap('the admin chain is read at the wrong system', 'bonuses', 'fleetCommandChain(support.admins || {}, endpoint.systemId, ship.NavalAdminCommandID)', 'fleetCommandChain(support.admins || {}, 0, ship.NavalAdminCommandID)', ['admin-chain', 'ship-term']),
  swap('a fleet with no command skips the top command', 'minerals', 'commandId || (root ? root.NavalAdminCommandID : 0)', 'commandId', ['admin-chain']),
  swap('an unknown chain counts as no bonus', 'bonuses', 'chain.bonus === null ? unknown(\'admin\', chain.unknown)', 'chain.bonus === null ? none(\'admin\', chain.unknown)', ['admin-chain']),
  swap('the crew deficit is applied twice', 'transport', '(amount * HANDLING_SECONDS[kind]) / (breakdown.strength * crew)', '(amount * HANDLING_SECONDS[kind]) / (breakdown.strength * crew * crew)', ['crew']),
  swap('an over-crewed ship loads faster', 'crew', 'Math.min(1, Math.max(0, ship.CurrentCrew) / ship.ClassCrew)', 'Math.max(0, ship.CurrentCrew) / ship.ClassCrew', ['crew']),
  swap('a ship with no crew aboard is let through', 'transport', '} else if (share === 0) {', '} else if (false) {', ['crew']),
  swap('the crew deficit is folded into the strength', 'transport', 'const ownTerm = own * stack.product * shuttleTechnology', 'const ownTerm = own * stack.product * shuttleTechnology * (crewFraction(ship) || 1)', ['crew']),
  swap('an unknown officer does not make the figure an estimate', 'bonuses', 'estimate: factors.some((factor) => factor.state === \'unknown\'),', 'estimate: false,', ['estimate']),
  swap('an officer unknown for one ship is hidden by another', 'bonuses', 'const rank = { unknown: 2, applies: 1, none: 0 }', 'const rank = { unknown: 0, applies: 1, none: 2 }', ['estimate']),
  swap('the estimate does not name the officers it lacks', 'bonuses', 'missing: unknown.map(', 'missing: [].map(', ['estimate', 'rows']),
  swap('a row with no value counts as neutral', 'bonuses', '} else if (!Number.isFinite(map[id])) {', '} else if (false) {', ['absent-vs-null']),
  swap('a missing row counts as unknown', 'bonuses', '} else if (!has(map, id)) {', '} else if (false) {', ['absent-vs-null', 'ship-term']),
  edit('officers not read count as no bonus', 'bonuses', /(return OFFICER_KEYS\.map\(\(key\) => )unknown(\(key, [^\n]*\)\)\n\s*\}\n\n\s*const gap = )/, (m) => `${m[1]}none${m[2]}`, ['absent-vs-null', 'pages']),
  swap('a class plan reads officers', 'plan', 'support: CLASS_ONLY', 'support: null', ['shared']),
  swap('the cycle ignores the officers', 'hauling', 'capacity > 0 ? (move.amount * (CARGO_POINTS[move.kind] || 1)) / capacity : 0, { version, support })', 'capacity > 0 ? (move.amount * (CARGO_POINTS[move.kind] || 1)) / capacity : 0, { version })', ['shared', 'estimate']),
  swap('the round trip ignores the officers', 'transport', 'endpoints[stop.where] }, ships, shuttleTechnology, 1, { version, support })', 'endpoints[stop.where] }, ships, shuttleTechnology, 1, { version })', ['shared', 'estimate']),
  swap('the routes\' provenance leaves the officers out', 'hauling', 'const { inputs, assumptions: bonusAssumptions } = bonusProvenance({ known: handling.known || [], unknown: handling.unsettled || [] })', 'const { inputs, assumptions: bonusAssumptions } = bonusProvenance({ known: [], unknown: [] })', ['estimate']),
  swap('the loader reads the sector column the save lacks', 'support', 'support.gaps.sector = sectors.length ? reason(sectors) : null', 'support.gaps.sector = null', ['loader-schema']),
  swap('the loader reads the commander table the save lacks', 'support', 'support.gaps.commander = officers.length ? reason(officers) : null', 'support.gaps.commander = null', ['loader-schema']),
  swap('the loader reads the admin chain the save lacks', 'support', 'support.gaps.admin = chain.length ? reason(chain) : null', 'support.gaps.admin = null', ['loader-schema']),
  edit('a missing prerequisite of the admin chain rejects the whole read', 'support', /support\.gaps\.admin \? \{\} : (?=loadNavalAdmins\()/, () => '', ['loader-schema']),
  swap('a save without the ranks is read as if it had them', 'support', 'const ranked = ranks && !lacking(rankReads).length', 'const ranked = ranks', ['loader-schema']),
  swap('the fleet\'s command column is not required', 'support', 'const FLEET_READS = { FCT_Fleet: [\'ParentCommandID\'] }', 'const FLEET_READS = { FCT_Fleet: [] }', ['loader-schema']),
  swap('the sector gap leaves out the officers\' tables', 'support', 'const sectors = [...officers, ...lacking(SECTOR_READS)]', 'const sectors = [...lacking(SECTOR_READS)]', ['loader-schema']),
  edit('a column of the admin query is not in the list of what it needs', 'admins', /(DIM_NavalAdminCommandType: \[)'CommandTypeID', 'Radius', share(\])/, (m) => `${m[1]}'CommandTypeID', share${m[2]}`, ['loader-schema']),
  edit('the population of the admin query is not in the list of what it needs', 'admins', /FCT_Population: \['PopulationID', 'SystemID'\],\n/, () => '', ['loader-schema']),
  swap('the loader reads a bonus that is withheld', 'support', 'if (blocked.has(LOGISTICS_BONUS)) {', 'if (false) {', ['absent-vs-null']),
  edit('the loader turns a bonus with no value into 1', 'support', /(const byId = [^\n]*\? row\.BonusValue : )null/, (m) => `${m[1]}1`, ['loader', 'absent-vs-null']),
  edit('the loader reads the other race\'s officers', 'support', /\sand FCT_Commander\.RaceID = \$\{RaceID\}(?= and FCT_Commander\.CommandType = \$\{type\})/, () => '', ['loader']),
  swap('a command with no headquarters capacity covers nothing', 'admins', 'Systems: admin.SystemID == null ? new Set() : systemsWithinJumps(graph, admin.SystemID, radius)', 'Systems: admin.SystemID == null || radius < 1 ? new Set() : systemsWithinJumps(graph, admin.SystemID, radius)', ['zero-hq']),
  swap('a command with no location covers a system of nothing', 'admins', 'Systems: admin.SystemID == null ? new Set() : systemsWithinJumps(graph, admin.SystemID, radius)', 'Systems: systemsWithinJumps(graph, admin.SystemID, radius)', ['zero-hq']),
  edit('a population with no headquarters capacity has no radius', 'minerals', /(if \(ShipID \|\| !\(HeadquartersLevel >= 1\)\) \{\s+return )0/, (m) => `${m[1]}null`, ['zero-hq']),
  edit('a system with no recorded sector reads as no sector', 'support', /(row\.SectorID === null \|\| row\.SectorID === undefined \? )\[\[row\.SystemID, null\]\]/, (m) => `${m[1]}[]`, ['sector-assignment']),
  edit('an explicit no sector reads as unknown', 'support', /(row\.SectorID === null \|\| row\.SectorID === undefined)( \? \[\[row\.SystemID, null\]\])/, (m) => `${m[1]} || row.SectorID === 0${m[2]}`, ['sector-assignment']),
  edit('a sector commander with no Logistics row reads as unknown', 'support', /row\.SectorID > 0 && row\.BonusRow/, () => 'row.SectorID > 0', ['sector-assignment']),
  edit('the sector read drops a system with no recorded sector in its join', 'support', /(from FCT_RaceSysSurvey )left join(?= FCT_Commander)/, (m) => `${m[1]}inner join`, ['sector-assignment']),
  edit('a rank that cannot be evaluated does not make the command unknown', 'admins', /Unknown: withheld \|\| RANK_UNEVALUABLE/, () => 'Unknown: withheld', ['rank-unknown']),
  edit('a rank that cannot be evaluated leaves the eligibility to its priority', 'admins', /\{ Eligible: null, Unknown: withheld/, () => '{ Unknown: withheld', ['rank-unknown']),
  edit('a vacant command is unknown for want of a rank', 'admins', /admin\.Assigned && !Number\.isFinite/, () => '!Number.isFinite', ['rank-unknown']),
  edit('a vacant command above an unevaluable rank is unknown', 'admins', /\.filter\(\(id\) => byId\[id\]\.Assigned\)/, () => '', ['rank-unknown']),
  edit('the commands above an unevaluable rank are not unknown', 'admins', /(current && !reached\.has\(current\.NavalAdminCommandID\); current = )byId\[current\.ParentCommandID\]/, (m) => `${m[1]}null`, ['rank-unknown']),
  edit('the loader does not tell an assigned commander from a vacant command', 'admins', /FCT_Commander\.CommanderID is not null as Assigned, /, () => 'false as Assigned, ', ['rank-unknown']),
  edit('the captains of a fleet are only the ranked ones', 'admins', /left join (FCT_Ranks on FCT_Ranks\.RankID = FCT_Commander\.RankID where FCT_Fleet)/, (m) => `inner join ${m[1]}`, ['captain-rank']),
  edit('an unranked captain does not make its command unknown', 'admins', /\.\.\.captains\.filter\(\(captain\) => captain\.Unranked > 0\)/, () => '...[]', ['captain-rank']),
  edit('a captain with no priority is not unranked', 'admins', /sum\(FCT_Ranks\.Priority is null\)/, () => 'sum(FCT_Ranks.RankID is null)', ['captain-rank']),
  edit('only a captain with no rank on the commander is unranked', 'admins', /sum\(FCT_Ranks\.Priority is null\)/, () => 'sum(FCT_Commander.RankID is null and FCT_Ranks.RankID is null)', ['captain-rank']),
  edit('a known captain hides an unranked one', 'admins', /sum\(FCT_Ranks\.Priority is null\) as Unranked/, () => 'min(FCT_Ranks.Priority is null) as Unranked', ['captain-rank']),
  edit('the commands above an unranked captain are not unknown', 'admins', /(captain\.Unranked > 0\)\.map\(\(captain\) => byId\[captain\.NavalAdminCommandID\]\))/, (m) => m[1] + '.map((seed) => ({ ...seed, ParentCommandID: 0 }))', ['captain-rank']),
  edit('the read takes the race after the first wait on Hauling', 'haulingPage', /(get: tracked\('handlingSupport', async function \(\) \{\n)(\s*)(const \{ database, GameID, RaceID \} = this)/, (m) => `${m[1]}${m[2]}await Promise.resolve()\n${m[2]}${m[3]}`, ['race-switch']),
  edit('the read takes the race after the first wait on Transport', 'transportPage', /(get: tracked\('handlingSupport', async function \(\) \{\n)(\s*)(const \{ database, GameID, RaceID \} = this)/, (m) => `${m[1]}${m[2]}await Promise.resolve()\n${m[2]}${m[3]}`, ['race-switch']),
  edit('the cell shows an unknown officer as none', 'bonuses', /(export const factorCell = \(factor\) => \(factor\.state === 'applies' \? multiplier\(factor\.value\) : )factor\.state === 'none' (\? )/, (m) => `${m[1]}factor.state === 'none' || factor.state === 'unknown' ${m[2]}`, ['rows']),
  swap('the row leaves the colony\'s additive term out', 'transport', '    additive: breakdown.additive,\n', '    additive: 0,\n', ['rows']),
  edit('an unknown officer has a result with a value', 'transport', /if \(factor\.state === 'unknown'\) \{/, () => 'if (false) {', ['rows', 'template']),
  edit('the result of the crew share is a different figure', 'transport', /(crew: ofRule\(\{ rule: 'crew\.fraction', value: )breakdown\.crew/, (m) => `${m[1]}1`, ['rows', 'template']),
  edit('the result of the time is a different figure', 'transport', /(seconds: Number\.isFinite\(breakdown\.seconds\) \? ofRule\(\{ rule: 'transport\.handlingTime', value: )breakdown\.seconds/, (m) => `${m[1]}breakdown.strength`, ['rows', 'template']),
  edit('the result of the technology is a different figure', 'transport', /(technology: ofRule\(\{ rule: 'transport\.shuttleTechnology', value: )breakdown\.technology/, (m) => `${m[1]}breakdown.own`, ['rows', 'template']),
  edit('the result of the colony\'s addition is a different figure', 'transport', /(additive: ofRule\(\{ rule: 'transport\.colonyAddition', value: )breakdown\.additive/, (m) => `${m[1]}breakdown.technology`, ['rows', 'template']),
  edit('the result of the own strength is a different figure', 'transport', /(own: ofRule\(\{ rule: 'transport\.ownStrength', value: )breakdown\.own/, (m) => `${m[1]}breakdown.ownTerm`, ['rows', 'template']),
  edit('the rows carry no results for the figures', 'transport', /\n\s+results: \{(?:(?!\n\s{4}\},)[\s\S])*\n\s{4}\},/, () => '\n    results: {},', ['rows', 'template']),
  edit('the rows carry no result for an officer', 'transport', /factors: breakdown\.factors\.map\(\(factor\) => \(\{ \.\.\.factor, cell: factorCell\(factor\), result: officerResult\(factor\) \}\)\)/, () => 'factors: breakdown.factors.map((factor) => ({ ...factor, cell: factorCell(factor) }))', ['rows', 'template']),
  ...['own', 'technology', 'additive', 'crew', 'strength', 'time'].map((key) => edit(`the ${key} cell shows no provenance mark`, 'component', cellMark(`data-${key}`), (m) => m[1], ['template'])),
  edit('the officer cells show no provenance mark', 'component', cellMark('data-officer'), (m) => m[1], ['template']),
  edit('the technology cell carries the result of the own strength', 'component', /(data-technology>[^<]*(?:\{\{[^}]*\}\}[^<]*)?<provenance-mark :result=")row\.results\.technology/, (m) => `${m[1]}row.results.own`, ['template']),
  edit('the time cell carries the result of the crew share', 'component', /(data-time>[^<]*(?:\{\{[^}]*\}\}[^<]*)?<provenance-mark\s+:result\s*=\s*")row\.results\.seconds/, (m) => `${m[1]}row.results.crew`, ['template']),
  edit('the strength cell carries the result of the own strength', 'component', /(data-strength>[^<]*(?:\{\{[^}]*\}\}[^<]*)?<provenance-mark\s+:result\s*=\s*")row\.result(?=")/, (m) => `${m[1]}row.results.own`, ['template']),
  edit('the Hauling page does not hand the officers over', 'haulingPage', /(cycleHandling\([^)]*\{ version: this\.formulaVersion, support: )this\.officerSupport/, (m) => `${m[1]}null`, ['pages']),
  edit('the Transport page does not hand the officers to the class runs', 'transportPage', /(roundTrip\([^)]*\{ colonists: true, version: this\.formulaVersion, support: )this\.officerSupport/, (m) => `${m[1]}null`, ['pages']),
  fleetEdit('the Transport page does not hand the officers to the fleets', 'transportPage', /(fleetTrip\(profile, reach\.route\.km, endpoints, \{ colonists: true, version: this\.formulaVersion, support: )this\.officerSupport/, (m) => `${m[1]}null`, ['pages']),
  edit('the Hauling page waits for the officers', 'haulingPage', /const CORE_INPUTS = Object\.keys\(INPUT_LABELS\)\.filter\(\(key\) => !OPTIONAL_INPUTS\.includes\(key\)\)/, () => 'const CORE_INPUTS = Object.keys(INPUT_LABELS)', ['pages']),
  edit('the Transport page waits for the officers', 'transportPage', /const CORE_INPUTS = Object\.keys\(INPUT_LABELS\)\.filter\(\(key\) => !OPTIONAL_INPUTS\.includes\(key\)\)/, () => 'const CORE_INPUTS = Object.keys(INPUT_LABELS)', ['pages']),
  edit('the Hauling page tracks the read under another key', 'haulingPage', /tracked\('handlingSupport'(?=, async function)/, () => 'tracked(\'officers\'', ['pages']),
  edit('the Transport page tracks the read under another key', 'transportPage', /tracked\('handlingSupport'(?=, async function)/, () => 'tracked(\'officers\'', ['pages']),
  edit('the Hauling page labels the read under another key', 'haulingPage', LABEL_KEY, (m) => `${m[1]}officerSupport`, ['pages']),
  edit('the Transport page labels the read under another key', 'transportPage', LABEL_KEY, (m) => `${m[1]}officerSupport`, ['pages']),
  fleetEdit('the Hauling page reads ships without their fleet\'s command', 'profile', /FCT_Fleet\.ParentCommandID as NavalAdminCommandID, /, () => '', ['pages']),
  bareEdit('the Hauling page reads ships without their fleet\'s command', 'haulingPage', /FCT_Fleet\.ParentCommandID as NavalAdminCommandID, /, () => '', ['pages']),
  edit('the Transport page reads ships without their fleet\'s command', 'transportPage', /FCT_Fleet\.ParentCommandID as NavalAdminCommandID, /, () => '', ['pages']),
  swap('a failed read still hands over its last value', 'mixin', 'return this.loadErrors.handlingSupport === null ? this.handlingSupport : null', 'return this.handlingSupport', ['pages']),
  edit('the breakdown shows no officer cells', 'component', /v-for="factor in row\.factors"/, () => 'v-for="factor in row.factors.slice(0, 0)"', ['template']),
  edit('the breakdown shows no officer headers', 'component', /v-for="officer in officers"/, () => 'v-for="officer in officers.slice(0, 0)"', ['template']),
  edit('the Hauling page shows no breakdown', 'haulingPage', /<handling-breakdown\b[^>]*\/>/, () => '', ['template']),
  edit('the Transport page shows no breakdown of its classes', 'transportPage', /<handling-breakdown\b[^>]*\/>/, () => '', ['template']),
  fleetEdit('the Transport page gives its fleets no rows', 'transportPage', /\s:handling-rows\s*=\s*(?:"[^"]*"|'[^']*')/, () => '', ['template']),
  fleetEdit('the Transport page gives its fleets the rows of nothing', 'transportPage', /(\s:handling-rows\s*=\s*)(?:"[^"]*"|'[^']*')/, (m) => `${m[1]}"[]"`, ['template']),
  edit('the Hauling page binds its breakdown to other rows', 'haulingPage', /(<handling-breakdown\b[^>]*?:rows\s*=\s*)(?:"[^"]*"|'[^']*')/, (m) => `${m[1]}"[]"`, ['template']),
  edit('the Transport page binds its breakdown to other rows', 'transportPage', /(<handling-breakdown\b[^>]*?:rows\s*=\s*)(?:"[^"]*"|'[^']*')/, (m) => `${m[1]}"[]"`, ['template']),
  fleetEdit('the fleet profile shows no breakdown', 'profileComponent', /<handling-breakdown\b[^>]*\/>/, () => '', ['template']),
  fleetEdit('the fleet profile binds its breakdown to other rows', 'profileComponent', /(<handling-breakdown\b[^>]*?:rows\s*=\s*)(?:"[^"]*"|'[^']*')/, (m) => `${m[1]}"[]"`, ['template']),
  fleetEdit('the fleet profile shows its breakdown for no rows', 'profileComponent', /(<handling-breakdown\b[^>]*?)\sv-if\s*=\s*(?:"[^"]*"|'[^']*')/, (m) => `${m[1]} v-if="false"`, ['template']),
  ...[['Hauling', 'haulingPage'], ['Transport', 'transportPage']].flatMap(([name, file]) => [
    summaryEdit(`the handling panel of ${name} has no summary`, file, '', ['summary']),
    summaryEdit(`the handling panel of ${name} has a null summary`, file, ' :data-summary="null"', ['summary']),
    summaryEdit(`the handling panel of ${name} has a blank summary`, file, ' data-summary=" "', ['summary']),
    summaryEdit(`the handling panel of ${name} has no summary while the read failed`, file, ' :data-summary="handlingSupportState.failed ? null : \'a summary\'"', ['summary']),
    summaryEdit(`the handling panel of ${name} has no summary while the read is partial`, file, ' :data-summary="handlingSupportNote ? null : \'a summary\'"', ['summary']),
    summaryEdit(`the handling panel of ${name} changes its summary while the read loads`, file, ' :data-summary="handlingSupportState.loading ? \'one summary\' : \'another summary\'"', ['summary']),
  ]),
].filter(present).map((one, index) => ({ ...one, id: `fault:${index}` }))

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

const short = (error) => (error && error.message ? error.message : String(error)).split('\n').slice(0, 4).join('\n  ')

// The edit's pattern must match exactly once; the source with the edit applied.
const applied = (sources, one) => {
  const matches = [...sources[one.file].matchAll(new RegExp(one.at.source, `${one.at.flags.replace('g', '')}g`))]

  if (matches.length !== 1) {
    throw new Error(`${one.name}: the pattern matches ${matches.length} times, not once`)
  }

  const [match] = matches

  return { ...sources, [one.file]: patched(path.basename(FILES[one.file]), sources[one.file], match[0], one.to(match)) }
}

const stacked = (edits) => edits.reduce(applied, ORIGINALS)

const main = async () => {
  const mutate = !process.argv.includes('--no-mutations')
  const failures = await run(CHECKS, worldOf(ORIGINALS))
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach(({ name, error }) => console.log(`FAIL ${name}: ${short(error)}`))

  const settle = (label, problem) => {
    total += 1

    if (problem) {
      console.log(`FAIL ${label}: ${problem}`)
    } else {
      passed += 1
    }
  }

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))
    const every = (list, work) => inParallel(list, work)
    // A planted fault on sources `base`: every check it names must fail.
    const caught = async (fault, base) => {
      fault.fails.forEach((name) => assert.ok(known.has(name), `${fault.name}: no check named ${name}`))

      const world = worldOf(applied(base, fault))
      const missed = []

      for (const name of fault.fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), world)

        if (!failed) {
          missed.push(name)
        }
      }

      return missed.length ? `still passes ${missed.join(', ')}` : null
    }
    // The checks that fail on sources `base` (none, when every edit applied to it is benign).
    const green = async (base) => (await run(CHECKS, worldOf(base))).map(({ name, error }) => `${name}: ${short(error)}`).join('\n  ')

    const outcomes = await every(BENIGN, async (one) => green(applied(ORIGINALS, one)))

    outcomes.forEach((outcome, index) => settle(`benign edit ${BENIGN[index].name}`, outcome instanceof Error ? outcome.message : outcome))

    const conflicts = []

    for (const first of BENIGN) {
      for (const second of BENIGN) {
        try {
          applied(applied(ORIGINALS, first), second)
        } catch (error) {
          conflicts.push(`${second.name} after ${first.name}: ${error.message}`)
        }
      }
    }

    settle('benign edits: each applies to a source another has changed', conflicts.slice(0, 4).join('\n  '))

    let everything = null

    try {
      everything = stacked(BENIGN)
    } catch (error) {
      settle('benign edits: all of them together keep every check green', error.message)
    }

    if (everything) {
      settle('benign edits: all of them together keep every check green', await green(everything))

      const composed = await every(FAULTS, (fault) => caught(fault, everything))

      composed.forEach((outcome, index) => settle(`planted fault after every benign edit: ${FAULTS[index].name}`, outcome instanceof Error ? outcome.message : outcome))
    }

    const alone = await every(FAULTS, (fault) => caught(fault, ORIGINALS))

    alone.forEach((outcome, index) => settle(`planted fault: ${FAULTS[index].name}`, outcome instanceof Error ? outcome.message : outcome))
  }

  console.log(`${passed} of ${total} checks passed`)
  process.exit(passed === total ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
