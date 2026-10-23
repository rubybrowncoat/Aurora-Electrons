/*
  Checks the fleet that sails together (src/renderer/utilities/fleet-profile.js, the fleet profile component and the Transport and Hauling pages that use it) without a save.

  Every statement runs on ships, fleets and a small SQLite database made here and on the real utilities, component and pages. Nothing is read from a save. The statements cover the acceptance of AE-085-01:
  - a fleet of fast and slow ships shares one travel cycle at the speed of its slowest ship, and each ship burns at its own share of its own speed;
  - the saved fleet speed and the recomputed effective maximum stay apart, and the saved speed is held to what the fleet can reach;
  - a ship in a hangar or under tow burns no fuel of its own and does not limit the fleet, and its holds are not counted but marked as left out;
  - the mass of a ship in tow slows the tug, and damaged or overhaul-reduced engines slow a ship;
  - a fleet with nothing to push it, or a saved speed of 0, is not a route: it gives no trip and no yearly figure;
  - nested hangars, tow chains, a shipyard in tow, a carrier that is elsewhere and holds that are all in tow are unsupported and say why, and a link the save does not state is unknown, never free;
  - the slowest ship sets each loading stop and the ship with the shortest range sets the fuel;
  - the loader reads the engines, links and towed mass from the tables as they are, reads a column the save lacks as null and keeps to the fleets asked for;
  - the pages take speed, burn and counted cargo from the profile, say why a fleet is left out, and track the optional read under the key the page labels it with.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names, both on the real sources and on the sources with every benign edit (wording, attribute order) applied. Each benign edit, and all of them together, must leave every check green. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults and the benign edits. `--only=text|text` selects edits by name and always runs the head and complete benign composition; `--detail` prints the named check's failure for each caught fault.

  The component and the pages are checked by what they do: the pages' computed rows and reads evaluated on a pseudo instance, and the compiled templates' elements and bound expressions. No statement matches source text or prose; only a planted fault names a source anchor, and each is found by an identifier, a key or a code expression.
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
  profile: inRenderer('utilities', 'fleet-profile.js'),
  haulingRules: inRenderer('utilities', 'hauling.js'),
  component: inRenderer('components', 'page', 'FleetProfile.vue'),
  haulingPage: inRenderer('pages', 'hauling.vue'),
  transportPage: inRenderer('pages', 'information.vue'),
}

const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------
const VERSION = '2.7.1'
const TECH = 1.5
const KM = 1e6

// A freighter as `loadFleetShips` gives it: size 20 and engines of power 20, so a top speed of 1000 km/s, burning 0.5 L per engine power hour, unharmed, free (in no hangar, towing and towed by nothing) and with fuel and crew aboard.
const ship = (extra = {}) => ({
  ShipID: 1,
  ShipName: 'Hauler',
  FleetID: 5,
  FleetName: 'Convoy',
  ClassName: 'Freighter',
  Size: 20,
  ShuttleStrength: 2,
  DesignedShuttleStrength: 2,
  CurrentCrew: 100,
  ClassCrew: 100,
  CargoCapacity: 1000,
  ColonistCapacity: 200,
  NavalAdminCommandID: 10,
  MaxSpeed: 1000,
  EnginePower: 20,
  UndamagedEnginePower: 20,
  OverhaulFactor: 1,
  FuelEfficiency: 0.5,
  FuelCapacity: 1e9,
  Fuel: 1e9,
  MaintenanceState: 0,
  MothershipID: 0,
  TractorTargetShipID: 0,
  TractorParentShipID: 0,
  TractorTargetShipyardID: 0,
  TowedSize: null,
  TowedTargetShipID: null,
  CarrierMothershipID: null,
  CarrierFleetID: null,
  ShuttleTechnology: TECH,
  MilitaryEngines: 0,
  Drive: 0,
  AnyDrive: 0,
  FleetSpeed: 1000,
  UseMaximumSpeed: 1,
  ...extra,
})

// A ship of size 40 with the same engines: half the speed.
const slowShip = (extra = {}) => ship({ ShipID: 2, ShipName: 'Slow', Size: 40, MaxSpeed: 500, ...extra })

// A freighter with no engines of its own, pulled by ship 1.
const barge = (extra = {}) => ship({ ShipID: 4, ShipName: 'Barge', EnginePower: 0, UndamagedEnginePower: 0, MaxSpeed: 1, TractorParentShipID: 1, ...extra })

// A tug (ship 1) pulling the barge, whose size is 20.
const tug = (extra = {}) => ship({ TractorTargetShipID: 4, TowedSize: 20, TowedTargetShipID: 0, ...extra })

// A craft with no engines in the hangar of ship 1, which is itself in no hangar.
const craft = (extra = {}) => ship({ ShipID: 3, ShipName: 'Craft', EnginePower: 0, UndamagedEnginePower: 0, MaxSpeed: 1, MothershipID: 1, CarrierMothershipID: 0, CarrierFleetID: 5, ...extra })

const colony = (extra = {}) => ({ PopName: 'Mars', PopulationID: 7, SystemID: 3, ShuttleCapacity: 1, ServiceNames: 'Spaceport', ...extra })

const FULL_OFFICERS = { mode: 'loaded', withheld: null, gaps: { commander: null, admin: null, governor: null, sector: null }, commanders: {}, governors: {}, sectors: {}, admins: {} }

const STORE = { getters: { 'capabilities/result': {}, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }

const near = (actual, expected, message = '') => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${message} ${actual} is not ${expected}`.trim())

const codesOf = (profile) => profile.reasons.map((reason) => reason.code).sort()

// ---- A SQLite database that answers the loader's queries --------------------------------------------------------------
const SCHEMA = `
  create table FCT_Race (RaceID integer, CargoShuttleLoadModifier real);
  create table FCT_Fleet (FleetID integer, FleetName text, Speed integer, UseMaximumSpeed integer, ParentCommandID integer, ShippingLine integer, CycleMoves integer);
  create table FCT_ShipClass (ShipClassID integer, ClassName text, CargoCapacity real, ColonistCapacity real, Size real, Crew integer, MaxSpeed integer, EnginePower real, FuelEfficiency real, FuelCapacity real, MilitaryEngines integer);
  create table FCT_Ship (ShipID integer, GameID integer, RaceID integer, ShipName text, FleetID integer, ShipClassID integer, CurrentCrew integer, Fuel real, OverhaulFactor real, MaintenanceState integer, MothershipID integer, TractorTargetShipID integer, TractorParentShipID integer, TractorTargetShipyardID integer);
  create table FCT_ClassComponent (ClassID integer, ComponentID integer, NumComponent integer);
  create table FCT_ShipDesignComponents (SDComponentID integer, ComponentTypeID integer, ComponentValue real, SpecialFunction integer);
  create table FCT_DamagedComponent (ShipID integer, GameID integer, ComponentID integer, Number integer);
`

// Race 2 of game 1. Fleet 5 (naval admin command 10, set to 500 km/s at its maximum) has a freighter (ship 1, overhaul 0.8) towing a barge (ship 2), a freighter in the hangar of ship 1 (ship 6) and one in the hangar of ship 6 (ship 8). Fleet 6 is a shipping line, fleet 7 a fleet that does not repeat its orders, fleet 8 a fleet with no holds whose escort (ship 3) has one of its two engines damaged. Ship 9 is another race's.
const ROWS = `
  insert into FCT_Race values (2, 1.5);
  insert into FCT_Fleet values (5, 'Convoy', 500, 1, 10, 0, 1), (6, 'Line', 100, 1, 0, 1, 1), (7, 'Pair', 100, 0, 0, 0, 0), (8, 'Guard', 100, 1, 0, 0, 0);
  insert into FCT_ShipClass values (1, 'Freighter', 1000, 200, 20, 100, 1000, 20, 0.5, 1000000, 0), (2, 'Barge', 1000, 0, 20, 100, 1, 0, 0.5, 0, 0), (3, 'Escort', 0, 0, 10, 50, 2000, 20, 0.5, 1000, 1);
  insert into FCT_ShipDesignComponents values (100, 1, 10, 0), (101, 14, 2, 0);
  insert into FCT_ClassComponent values (1, 100, 2), (1, 101, 1), (3, 100, 2);
  insert into FCT_DamagedComponent values (3, 1, 100, 1);
  insert into FCT_Ship values (1, 1, 2, 'Tug', 5, 1, 100, 1000, 0.8, 0, 0, 2, 0, 0), (2, 1, 2, 'Tow', 5, 2, 100, 0, 1, 0, 0, 0, 1, 0), (6, 1, 2, 'Held', 5, 1, 100, 1000, 1, 0, 1, 0, 0, 0), (8, 1, 2, 'Deep', 5, 1, 100, 1000, 1, 0, 6, 0, 0, 0);
  insert into FCT_Ship values (3, 1, 2, 'Escort', 8, 3, 50, 100, 1, 0, 0, 0, 0, 0), (4, 1, 2, 'Pair A', 7, 1, 100, 1000, 1, 0, 0, 0, 0, 0), (5, 1, 2, 'Line A', 6, 1, 100, 1000, 1, 0, 0, 0, 0, 0), (9, 1, 9, 'Alien', 5, 1, 100, 1000, 1, 0, 0, 0, 0, 0);
`

// The same tables of a save from before the ships had a hangar, a tow or an overhaul, and the fleets a setting for their speed: the columns they lack are not there at all.
const OLD_SCHEMA = SCHEMA.replace('Fuel real, OverhaulFactor real, MaintenanceState integer, MothershipID integer, TractorTargetShipID integer, TractorParentShipID integer, TractorTargetShipyardID integer', 'Placeholder integer').replace('Speed integer, UseMaximumSpeed integer, ', '')

const OLD_ROWS = `
  insert into FCT_Race values (2, 1.5);
  insert into FCT_Fleet values (5, 'Convoy', 10, 0, 1);
  insert into FCT_ShipClass values (1, 'Freighter', 1000, 200, 20, 100, 1000, 20, 0.5, 1000000, 0);
  insert into FCT_ClassComponent values (1, 100, 2);
  insert into FCT_ShipDesignComponents values (100, 1, 10, 0);
  insert into FCT_Ship values (1, 1, 2, 'Old', 5, 1, 100, 0);
`

const databaseOf = async (schema, rows) => {
  const raw = new sqlite3.Database(':memory:')
  const exec = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

  await exec(schema)
  await exec(rows)

  return {
    query: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, found) => (error ? reject(error) : resolve([found])))),
    close: () => raw.close(),
  }
}

// ---- The world: the module, the component and the pages as shipped, or with edits planted -------------------------------
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

  const utilitySources = { 'fleet-profile': text.profile, hauling: text.haulingRules }
  const pageSources = {
    'utilities/fleet-profile': text.profile,
    'utilities/hauling': text.haulingRules,
    'components/page/FleetProfile': text.component,
    'pages/hauling': text.haulingPage,
    'pages/information': text.transportPage,
  }
  const labelsOf = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
  const modules = memo(() => loadUtilities(['fleet-profile', 'transport', 'hauling', 'provenance'], { sources: utilitySources }))
  const capabilities = memo(() => loadUtilities(['capabilities']))
  const component = memo(() => loadPage('components/page/FleetProfile', { sources: pageSources }))
  const hauling = memo(() => loadPage('pages/hauling', { sources: pageSources, modules: { 'mixins/load-state': labelsOf } }))
  const transport = memo(() => loadPage('pages/information', { sources: pageSources, modules: { 'mixins/load-state': labelsOf } }))

  return { text, modules, capabilities, component, hauling, transport }
}

// What a trip of the fleet takes from the origin colony to the destination colony, for the ships `ships` read as `basis` says.
const tripOf = async (w, ships, { km = KM, basis = 'maximum', colonists = true } = {}) => {
  const { 'fleet-profile': fp, transport } = await w.modules()
  const profile = fp.fleetProfile(ships, null, { basis })
  const endpoints = { origin: transport.colonyEndpoint(colony()), destination: transport.colonyEndpoint(colony({ PopulationID: 8, ShuttleCapacity: 0 })) }

  return { fp, transport, profile, endpoints, trip: fp.fleetTrip(profile, km, endpoints, { colonists, version: VERSION, support: null }) }
}

// ---- The checks --------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('shared-cycle', 'a fast and a slow ship share one travel cycle at the slowest speed, and each burns at its own share of its own speed', async (w) => {
  const fast = ship()
  const slow = slowShip()
  const { fp, transport, profile, trip, endpoints } = await tripOf(w, [fast, slow])

  assert.equal(profile.status, 'ok')
  assert.equal(profile.effectiveMax, 500, 'the effective maximum is the slowest ship\'s')
  assert.equal(profile.cruise, 500)
  assert.equal(profile.limiting.ship.ShipID, 2, 'the slow ship limits')

  const [fastOne, slowOne] = profile.participants

  near(fastOne.fraction, 500 / 1000)
  near(slowOne.fraction, 1)
  near(fastOne.burn, 20 * 0.5 * 0.5, 'the fast ship burns at half its power')
  near(slowOne.burn, 20 * 1 * 0.5, 'the slow ship burns at its full power')
  near(profile.fuelPerHour, 15)

  assert.equal(trip.status, 'ok')
  near(trip.travelSeconds, (2 * KM) / 500, 'one travel cycle at the shared speed')

  const alone = transport.roundTrip([fast], KM, endpoints, TECH, { version: VERSION, support: null })

  assert.ok(alone.travelSeconds < trip.travelSeconds, 'the fast ship timed alone is quicker than the fleet')

  const hours = trip.travelSeconds / 3600

  trip.fuel.forEach((entry) => near(entry.perTrip, entry.burn * hours, 'every ship burns for the same hours'))
  near(trip.fuelPerTrip, 15 * hours)

  // Three ships: each fraction is the shared speed over the ship's own.
  const third = ship({ ShipID: 7, ShipName: 'Third', Size: 25 })
  const three = fp.fleetProfile([fast, slow, third])

  assert.equal(three.cruise, 500)
  three.participants.forEach((participant) => near(participant.fraction, three.cruise / participant.engine.speed))
  near(three.participants[2].engine.speed, 800)
  near(three.participants[2].fraction, 500 / 800)
})

check('saved-speed', 'the saved fleet speed and the recomputed effective maximum stay apart, and a saved speed above what the fleet can reach is held to it', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const set = (speed, maximum) => [ship({ FleetSpeed: speed, UseMaximumSpeed: maximum }), slowShip({ FleetSpeed: speed, UseMaximumSpeed: maximum })]

  const hand = fp.fleetProfile(set(300, 0), null, { basis: 'saved' })

  assert.equal(hand.cruise, 300)
  assert.equal(hand.cruiseSource, 'saved')
  assert.equal(hand.savedSpeed, 300)
  assert.equal(hand.effectiveMax, 500, 'the maximum is not the saved speed')
  near(hand.participants[0].fraction, 0.3)
  near(hand.participants[1].fraction, 0.6)

  const high = fp.fleetProfile(set(800, 0), null, { basis: 'saved' })

  assert.equal(high.cruise, 500, 'held to the maximum')
  assert.equal(high.cruiseSource, 'saved-capped')
  assert.equal(high.savedSpeed, 800, 'the saved speed is still what the save says')
  assert.equal(high.effectiveMax, 500)

  const stale = fp.fleetProfile(set(123, 1), null, { basis: 'saved' })

  assert.equal(stale.cruise, 500, 'a fleet set to its maximum sails at the recomputed maximum')
  assert.equal(stale.cruiseSource, 'maximum-mode')
  assert.equal(stale.savedSpeed, 123)

  const maximum = fp.fleetProfile(set(300, 0), null, { basis: 'maximum' })

  assert.equal(maximum.cruise, 500, 'the maximum basis ignores the saved speed')
  assert.equal(maximum.savedSpeed, 300)

  const given = fp.fleetProfile(set(300, 0), { FleetID: 5, FleetName: 'Convoy', Speed: 250 }, { basis: 'saved' })

  assert.equal(given.cruise, 250, 'the fleet\'s own row gives the saved speed')

  const none = fp.fleetProfile(set(0, 0), null, { basis: 'saved' })

  assert.equal(none.status, 'immobile', 'a saved speed of 0 does not move')
  assert.ok(codesOf(none).includes('speed-zero'))
  assert.equal(none.cruise, 0)

  const unknown = fp.fleetProfile(set(null, 0), null, { basis: 'saved' })

  assert.equal(unknown.status, 'unknown', 'a speed the save does not state is not 0 or the maximum')
  assert.ok(codesOf(unknown).includes('saved-speed'))
})

check('carried', 'a ship in a hangar or under tow burns no fuel of its own and does not limit the fleet, and its holds are left out and marked, not counted', async (w) => {
  const { fp, trip: hangarTrip } = await tripOf(w, [ship(), craft()])
  const [carrier, carried] = fp.fleetProfile([ship(), craft()]).participants
  const alone = fp.fleetProfile([ship()])

  assert.equal(carrier.role, 'independent')
  assert.equal(carried.role, 'hangared')
  assert.equal(carried.burn, 0)
  assert.equal(carried.engine, null, 'it has no engines of its own to give a speed')
  assert.equal(carried.cargoStatus, 'unsupported')
  near(fp.fleetProfile([ship(), craft()]).fuelPerHour, alone.fuelPerHour, 'the hangared craft adds no burn')
  assert.equal(fp.fleetProfile([ship(), craft()]).effectiveMax, 1000, 'a craft with no engines does not hold the fleet at its own 1 km/s')
  assert.equal(hangarTrip.fuel.length, 1)
  assert.equal(hangarTrip.fuel[0].ship.ShipID, 1)

  const profile = fp.fleetProfile([ship(), craft()])

  assert.equal(profile.cargo.counted.cargo, 1000, 'only the carrier\'s hold is counted')
  assert.equal(profile.cargo.counted.colonists, 200)
  assert.equal(profile.cargo.left.cargo, 1000, 'the craft\'s hold is named as left out')
  assert.deepEqual(profile.cargo.left.ships.map((one) => one.ShipID), [3])
  assert.ok(profile.notes.some((note) => note.code === 'cargo-in-hangar'))
  near(hangarTrip.tonsYear, 1000 * hangarTrip.trips, 'the yearly cargo counts the one hold')

  const towed = fp.fleetProfile([tug(), barge()])
  const [pulling, pulled] = towed.participants

  assert.equal(pulled.role, 'towed')
  assert.equal(pulled.burn, 0)
  assert.equal(pulled.cargoStatus, 'unsupported')
  assert.equal(towed.cargo.counted.cargo, 1000)
  assert.equal(towed.cargo.left.cargo, 1000)
  assert.deepEqual(towed.cargo.left.ships.map((one) => one.ShipID), [4])
  assert.ok(towed.notes.some((note) => note.code === 'cargo-in-tow'))
  assert.equal(towed.limiting.ship.ShipID, 1, 'the tug limits, not the barge with a class speed of 1')
  assert.equal(pulling.role, 'independent')
  near(towed.fuelPerHour, pulling.burn, 'the barge adds no burn')

  const rows = fp.participantRows(towed)

  assert.equal(rows[1].burn, null)
  assert.equal(rows[1].fraction, null)
  assert.equal(rows[1].speed, null)
  assert.ok(Number.isFinite(rows[0].burn))
})

check('tow-mass', 'the mass of a ship in tow slows the tug', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const free = fp.shipSpeed(ship())
  const pulling = fp.shipSpeed(tug())

  assert.equal(free.speed, 1000)
  assert.equal(pulling.speed, 500, 'size 20 and a tow of size 20 give half the speed')
  assert.equal(pulling.mass, 40)

  const profile = fp.fleetProfile([tug(), barge()])

  assert.equal(profile.effectiveMax, 500)
  assert.equal(profile.designMax, 1000, 'the class rating is kept apart from what the tow leaves')
  assert.equal(profile.cruise, 500)
})

check('damage-overhaul', 'damaged engines and an overhaul below 1 lower a ship\'s speed, and the burn base is the engine power it has undamaged', async (w) => {
  const { fp, profile: mixed } = await tripOf(w, [ship(), ship({ ShipID: 2, ShipName: 'Hurt', UndamagedEnginePower: 10, MaxSpeed: 1000 })])

  assert.equal(fp.shipSpeed(ship({ UndamagedEnginePower: 10 })).speed, 500, 'half the engines')
  assert.equal(mixed.effectiveMax, 500, 'the damaged ship holds the fleet below its class rating')
  assert.equal(mixed.designMax, 1000)
  near(mixed.participants[0].fraction, 0.5)
  near(mixed.participants[1].fraction, 1)
  near(mixed.participants[1].burn, 10 * 1 * 0.5, 'the damaged ship burns what its working engines burn')
  near(mixed.participants[0].burn, 20 * 0.5 * 0.5)

  const worn = fp.fleetProfile([ship({ OverhaulFactor: 0.5 })])

  assert.equal(fp.shipSpeed(ship({ OverhaulFactor: 0.5 })).speed, 500, 'half the overhaul')
  assert.equal(worn.cruise, 500)
  near(worn.participants[0].fraction, 1)
  near(worn.participants[0].burn, 20 * 1 * 0.5, 'the engines still burn their full power at the lowered speed')

  const both = fp.fleetProfile([ship(), ship({ ShipID: 2, ShipName: 'Worn', OverhaulFactor: 0.25 })])

  assert.equal(both.effectiveMax, 250)
  near(both.participants[0].fraction, 0.25)
})

check('no-propulsion', 'a fleet with nothing to push it gives no trip and no yearly figure, never a route at 1 km/s', async (w) => {
  const { 'fleet-profile': fp, transport } = await w.modules()
  const endpoints = { origin: transport.colonyEndpoint(colony()), destination: transport.colonyEndpoint(colony({ PopulationID: 8, ShuttleCapacity: 0 })) }
  const cases = {
    'no engines': [ship({ EnginePower: 0, UndamagedEnginePower: 0, MaxSpeed: 1 })],
    'every engine damaged': [ship({ UndamagedEnginePower: 0 })],
    'overhaul spent': [ship({ OverhaulFactor: 0 })],
    'one ship with none among working ones': [ship(), slowShip({ UndamagedEnginePower: 0 })],
  }

  for (const [name, ships] of Object.entries(cases)) {
    const profile = fp.fleetProfile(ships)
    const trip = fp.fleetTrip(profile, KM, endpoints, { version: VERSION })

    assert.equal(profile.status, 'immobile', name)
    assert.ok(codesOf(profile).includes('no-propulsion'), name)
    assert.equal(profile.cruise, null, `${name}: no speed to sail at`)
    assert.equal(trip.status, 'immobile', name)
    assert.equal(trip.tripSeconds, null, name)
    assert.equal(trip.trips, null, name)
    assert.equal(trip.tonsYear, null, name)
    assert.equal(trip.colonistsYear, null, name)
    assert.equal(fp.hauledFleet({ Speed: 800, FuelPerHour: 5, CargoCapacity: 1000, ColonistCapacity: 0 }, profile).Speed, 0, `${name}: Hauling does not move it`)
    assert.ok(profile.reasons.every((reason) => typeof reason.text === 'string' && reason.text.length > 0), `${name}: says why`)
  }

  // A ship with no engines of its own is no problem when something carries or tows it.
  assert.equal(fp.fleetProfile([tug(), barge()]).status, 'ok')
  assert.equal(fp.fleetProfile([ship(), craft()]).status, 'ok')
})

check('unsupported', 'nested hangars, tow chains, a shipyard in tow, a carrier that is elsewhere or missing, no ship under its own power and holds that are all in tow are unsupported and say why', async (w) => {
  const { 'fleet-profile': fp, transport } = await w.modules()
  const endpoints = { origin: transport.colonyEndpoint(colony()), destination: transport.colonyEndpoint(colony({ PopulationID: 8, ShuttleCapacity: 0 })) }
  const cases = [
    ['nested-hangar', [ship(), craft({ ShipID: 6, MothershipID: 1 }), craft({ ShipID: 8, MothershipID: 6, CarrierMothershipID: 1 })]],
    ['hangar-and-tow', [ship(), craft({ TractorParentShipID: 1 })]],
    ['tow-chain', [tug(), barge({ TractorTargetShipID: 7, TowedSize: 20 })]],
    ['tow-chain', [tug({ TowedTargetShipID: 7 }), barge()]],
    ['tows-shipyard', [ship({ TractorTargetShipyardID: 9 })]],
    ['carrier-elsewhere', [ship(), craft({ CarrierFleetID: 99 })]],
    ['carrier-missing', [ship(), craft({ CarrierFleetID: null })]],
    ['no-independent', [barge()]],
    ['cargo-left', [tug({ CargoCapacity: 0, ColonistCapacity: 0 }), barge()]],
  ]

  for (const [code, ships] of cases) {
    const profile = fp.fleetProfile(ships)
    const trip = fp.fleetTrip(profile, KM, endpoints, { version: VERSION })

    assert.equal(profile.status, 'unsupported', code)
    assert.ok(codesOf(profile).includes(code), `${code}: ${codesOf(profile)}`)
    assert.ok(profile.reasons.every((reason) => typeof reason.text === 'string' && reason.text.length > 0), `${code}: says why`)
    assert.equal(trip.status, 'unsupported', code)
    assert.equal(trip.tripSeconds, null, code)
    assert.equal(trip.tonsYear, null, code)
    assert.ok(trip.problems.length > 0, `${code}: the trip carries the reasons`)
    assert.equal(fp.hauledFleet({ Speed: 800, FuelPerHour: 5, CargoCapacity: 1000, ColonistCapacity: 200 }, profile).Speed, 0, `${code}: Hauling does not move it`)
    assert.equal(fp.hauledFleet({ Speed: 800, FuelPerHour: 5, CargoCapacity: 1000, ColonistCapacity: 200 }, profile).CargoCapacity, 0, `${code}: and counts no hold`)
  }

  const provenance = (await w.modules()).provenance
  const none = fp.fleetProfile([barge()])

  assert.equal(provenance.isAvailable(fp.fleetTripResult(fp.fleetTrip(none, KM, endpoints, { version: VERSION }), none)), false, 'the result is unavailable and names the reasons')
})

check('unknown', 'a link, an engine, a hold, a tank or a fleet speed setting the save does not state makes the fleet unknown, never free, unharmed or empty', async (w) => {
  const { 'fleet-profile': fp, provenance } = await w.modules()
  const cases = [
    ['links', [ship({ MothershipID: null })]],
    ['links', [ship({ TractorTargetShipID: null })]],
    ['links', [ship({ TractorParentShipID: null })]],
    ['links', [ship({ TractorTargetShipyardID: null })]],
    ['links', [ship(), craft({ CarrierMothershipID: null })]],
    ['links', [tug({ TowedTargetShipID: null }), barge()]],
    ['speed', [ship({ OverhaulFactor: null })]],
    ['speed', [ship({ UndamagedEnginePower: null })]],
    ['fuel-use', [ship({ FuelEfficiency: null })]],
    ['holds', [ship({ CargoCapacity: null })]],
    ['holds', [ship({ ColonistCapacity: null })]],
    ['holds', [ship(), slowShip({ CargoCapacity: null, ColonistCapacity: null })]],
    ['holds', [ship(), craft({ CargoCapacity: null })]],
    ['tow-mass', [tug({ TowedSize: null }), barge()]],
  ]

  for (const [code, ships] of cases) {
    const profile = fp.fleetProfile(ships)

    assert.equal(profile.status, 'unknown', `${code}: ${JSON.stringify(ships.map((one) => one.ShipID))}`)
    assert.ok(codesOf(profile).includes(code), `${code}: ${codesOf(profile)}`)
    assert.equal(profile.cruise, null)
  }

  // A hold the save does not state is not "no holds": the ships that do state theirs give no total.
  const mixed = await tripOf(w, [ship(), slowShip({ CargoCapacity: null, ColonistCapacity: null })])

  assert.equal(mixed.trip.status, 'unknown')
  assert.equal(mixed.trip.tonsYear, null)
  assert.equal(mixed.trip.trips, null)

  // The setting of the fleet's speed: unknown only when it changes the speed.
  const setting = (flag, saved, basis = 'saved') => fp.fleetProfile([ship({ FleetSpeed: saved, UseMaximumSpeed: flag }), slowShip({ FleetSpeed: saved, UseMaximumSpeed: flag })], null, { basis })

  for (const flag of [null, undefined]) {
    const open = setting(flag, 300)

    assert.equal(open.status, 'unknown', 'a setting that is not stated, with a saved speed below the maximum')
    assert.ok(codesOf(open).includes('speed-mode'))
    assert.equal(open.cruise, null)
    assert.equal(open.savedSpeed, 300)
    assert.equal(open.effectiveMax, 500, 'the maximum is still known')
    assert.equal(setting(flag, 800).status, 'ok', 'a saved speed above the maximum is the maximum either way')
    assert.equal(setting(flag, 800).cruise, 500)
    assert.equal(setting(flag, 500).cruise, 500, 'a saved speed that is the maximum is the same either way')
    assert.equal(setting(flag, 300, 'maximum').cruise, 500, 'the maximum basis does not read the setting')
  }

  assert.equal(setting(0, 300).cruise, 300)
  assert.equal(setting(1, 300).cruise, 500)

  // A tank the save does not state is not a tank of 0: the trip is unknown and withholds its figures, whichever ship it is.
  for (const ships of [[ship({ FuelCapacity: null })], [ship(), slowShip({ FuelCapacity: null })]]) {
    const tank = await tripOf(w, ships)

    assert.equal(tank.profile.status, 'ok', 'the profile does not need the tank')
    assert.equal(tank.trip.status, 'unknown')
    assert.ok(tank.trip.problems.some((problem) => problem.code === 'fuel-capacity'))
    assert.equal(tank.trip.tonsYear, null)
    assert.equal(tank.trip.fuelShare, null)
    assert.equal(provenance.isAvailable(tank.fp.fleetTripResult(tank.trip, tank.profile)), false)
  }

  assert.equal(fp.fleetProfile([tug({ TowedSize: null }), barge()]).status, 'unknown', 'a tow whose mass is not known')
})

check('stop-bottleneck', 'every loading stop is as long as its slowest counted ship, and a ship in tow sets none', async (w) => {
  const slowLoader = ship({ ShipID: 1, ShipName: 'Weak', ShuttleStrength: 1, DesignedShuttleStrength: 1 })
  const strongLoader = ship({ ShipID: 2, ShipName: 'Strong', ShuttleStrength: 4, DesignedShuttleStrength: 4 })
  const both = await tripOf(w, [strongLoader, slowLoader])
  const weakAlone = await tripOf(w, [slowLoader])
  const strongAlone = await tripOf(w, [strongLoader])

  assert.equal(both.trip.status, 'ok')
  assert.ok(strongAlone.trip.handlingSeconds < weakAlone.trip.handlingSeconds, 'a stronger loader is quicker')
  near(both.trip.handlingSeconds, weakAlone.trip.handlingSeconds, 'the slow loader sets every stop, the strong one does not shorten it')
  assert.equal(both.trip.limiting.ship.ShipID, 1)
  assert.equal(both.profile.cargo.counted.cargo, 2000, 'both holds are counted')

  // A weak craft in a hangar or under tow does not slow the stops.
  const carried = await tripOf(w, [strongLoader, craft({ ShuttleStrength: 0.5, DesignedShuttleStrength: 0.5 })])

  near(carried.trip.handlingSeconds, strongAlone.trip.handlingSeconds, 'a carried craft sets no stop')
  assert.equal(carried.trip.limiting.ship.ShipID, 2)

  const towed = await tripOf(w, [tug({ ShuttleStrength: 4, DesignedShuttleStrength: 4 }), barge({ ShuttleStrength: 0.5, DesignedShuttleStrength: 0.5 })])
  const tugAlone = await tripOf(w, [ship({ ShuttleStrength: 4, DesignedShuttleStrength: 4 })])

  near(towed.trip.handlingSeconds, tugAlone.trip.handlingSeconds, 'a towed barge sets no stop')

  // The cargo alone is quicker than cargo and colonists.
  const cargoOnly = await tripOf(w, [slowLoader, strongLoader], { colonists: false })

  assert.ok(cargoOnly.trip.handlingSeconds < both.trip.handlingSeconds)
  assert.equal(cargoOnly.trip.colonistsYear, null)
})

check('fuel-range', 'the ship with the least range sets the fuel limit, at its own burn, and a ship with no tank that burns fuel is out of range', async (w) => {
  const far = 1e8
  const shortFast = await tripOf(w, [ship({ FuelCapacity: 400 }), slowShip()], { km: far })

  // The fast ship burns 5 L/h for 111 h.
  assert.equal(shortFast.trip.status, 'range')
  assert.equal(shortFast.trip.fuelLimiting.ShipID, 1)
  assert.ok(shortFast.trip.fuelShare > 1)
  near(shortFast.trip.fuel[0].share, (5 * (2 * far) / 500 / 3600) / 400)

  const shortSlow = await tripOf(w, [ship(), slowShip({ FuelCapacity: 1000 })], { km: far })

  assert.equal(shortSlow.trip.status, 'range')
  assert.equal(shortSlow.trip.fuelLimiting.ShipID, 2)

  const enough = await tripOf(w, [ship(), slowShip()], { km: far })

  assert.equal(enough.trip.status, 'ok')
  assert.ok(enough.trip.fuelShare < 1)

  const noTank = await tripOf(w, [ship({ FuelCapacity: 0 })])

  assert.equal(noTank.trip.status, 'range', 'an engine that burns with no tank to burn from')
})

check('hauling-fleet', 'a repeating fleet takes its speed, burn and counted holds from the profile, and none of them when it cannot be profiled', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const fleet = { FleetID: 5, FleetName: 'Cycle', Speed: 300, FuelPerHour: 99, CargoCapacity: 2000, ColonistCapacity: 400 }
  const saved = fp.fleetProfile([tug({ FleetSpeed: 300, UseMaximumSpeed: 0 }), barge()], fleet, { basis: 'saved' })
  const hauled = fp.hauledFleet(fleet, saved)

  assert.equal(saved.status, 'ok')
  assert.equal(saved.cruise, 300, 'the fleet row\'s own speed, held to what the tug can pull')
  assert.equal(hauled.Speed, 300)
  near(hauled.FuelPerHour, 20 * (300 / 500) * 0.5, 'the tug burns at its share of its speed, the barge nothing')
  assert.equal(hauled.CargoCapacity, 1000, 'the barge\'s hold is not counted')
  assert.equal(hauled.ColonistCapacity, 200)
  assert.equal(hauled.FleetName, 'Cycle')

  const stuck = fp.hauledFleet(fleet, fp.fleetProfile([tug({ CargoCapacity: 0, ColonistCapacity: 0 }), barge()], fleet, { basis: 'saved' }))

  assert.equal(stuck.Speed, 0)
  assert.equal(stuck.FuelPerHour, 0)
  assert.equal(stuck.CargoCapacity, 0)
})

check('loader', 'the loader reads the engines, links and towed mass from the tables, keeps to the fleets asked for and reads a column the save lacks as null', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const database = await databaseOf(SCHEMA, ROWS)
  const rows = await fp.loadFleetShips(database, { GameID: 1, RaceID: 2, fleetWhere: 'FCT_Fleet.ShippingLine = 0' })
  const byId = Object.fromEntries(rows.map((row) => [row.ShipID, row]))

  assert.deepEqual(rows.map((row) => row.ShipID).sort((a, b) => a - b), [1, 2, 3, 4, 6, 8], 'the race\'s ships of the fleets asked for')
  assert.ok(Object.isFrozen(rows))

  const pulling = byId[1]

  near(pulling.UndamagedEnginePower, 20)
  assert.equal(pulling.OverhaulFactor, 0.8)
  assert.equal(pulling.TractorTargetShipID, 2)
  assert.equal(pulling.TowedSize, 20, 'the size of the ship it tows')
  assert.equal(pulling.TowedTargetShipID, 0, 'what that ship tows')
  assert.equal(pulling.FleetSpeed, 500)
  assert.equal(pulling.UseMaximumSpeed, 1)
  assert.equal(pulling.NavalAdminCommandID, 10)
  assert.equal(pulling.ShuttleTechnology, 1.5)
  assert.equal(pulling.ClassName, 'Freighter')
  assert.equal(byId[2].TractorParentShipID, 1)
  near(byId[2].UndamagedEnginePower, 0)
  near(byId[3].UndamagedEnginePower, 10, 'one of two engines damaged')
  assert.equal(byId[3].EnginePower, 20, 'the class\'s own engine power is not what the ship has left')
  assert.equal(byId[6].MothershipID, 1)
  assert.equal(byId[6].CarrierFleetID, 5, 'the fleet of the carrier')
  assert.equal(byId[6].CarrierMothershipID, 0)
  assert.equal(byId[8].CarrierMothershipID, 1, 'a hangar inside a hangar')
  assert.equal(byId[1].TowedSize, 20)
  assert.equal(byId[6].TowedSize, null, 'a ship that tows nothing has no towed size')

  // What the rows make of a fleet: the tug at 0.8 of 20 over 40 is 400 km/s.
  const fleet = fp.fleetProfile(rows.filter((row) => [1, 2, 6].includes(row.ShipID)))

  assert.equal(fleet.status, 'ok')
  assert.equal(fleet.cruise, 400)
  assert.equal(fleet.cargo.counted.cargo, 1000)
  assert.equal(fleet.cargo.left.cargo, 2000)
  assert.equal(fp.fleetProfile(rows.filter((row) => [1, 6, 8].includes(row.ShipID))).status, 'unsupported', 'the nested hangar')

  const only = await fp.loadFleetShips(database, { GameID: 1, RaceID: 2, fleetWhere: 'FCT_Fleet.FleetID = 8' })

  assert.deepEqual(only.map((row) => row.ShipID), [3])
  database.close()

  // A save before the hangars, tows, overhauls and fleet speed settings: no column is 0, so no ship is taken as free, in no hangar or at full overhaul.
  const old = await databaseOf(OLD_SCHEMA, OLD_ROWS)
  const oldRows = await fp.loadFleetShips(old, { GameID: 1, RaceID: 2 })

  assert.equal(oldRows.length, 1)

  const [oldShip] = oldRows

  ;['MothershipID', 'TractorTargetShipID', 'TractorParentShipID', 'TractorTargetShipyardID', 'OverhaulFactor', 'Fuel', 'MaintenanceState', 'FleetSpeed', 'UseMaximumSpeed', 'LastOverhaul', 'LastShoreLeave', 'GradePoints', 'CrewMorale', 'CurrentMaintSupplies', 'PlannedDeployment', 'MaintSupplies', 'BaseFailureChance', 'MaxDACRoll', 'Commercial', 'MoraleCheckRequired', 'CommercialHangar', 'SupplyShip', 'CarrierCommercialHangar'].forEach((key) => assert.equal(oldShip[key], null, key))
  near(oldShip.UndamagedEnginePower, 20)
  assert.equal(fp.fleetProfile(oldRows).status, 'unknown')
  assert.ok(codesOf(fp.fleetProfile(oldRows)).includes('links'))
  old.close()
})

const FLEET_EIGHT = { GameID: 1, RaceID: 2, fleetWhere: 'FCT_Fleet.FleetID = 8' }

check('loader-null', 'an engine, an installed count or a damage row the save leaves empty makes the ship\'s engine power unknown, and only a missing damage row means nothing damaged', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const readWith = async (statements, query = FLEET_EIGHT) => {
    const database = await databaseOf(SCHEMA, `${ROWS}${statements}`)
    const rows = await fp.loadFleetShips(database, query)

    database.close()

    return rows
  }
  const [damaged] = await readWith('')
  const [whole] = await readWith('delete from FCT_DamagedComponent;')

  near(damaged.UndamagedEnginePower, 10, 'one of two engines damaged')
  near(whole.UndamagedEnginePower, 20, 'no damage row: nothing damaged')

  const cases = [
    ['a damage row with no number', 'update FCT_DamagedComponent set Number = null;'],
    ['an installed count with no number', 'update FCT_ClassComponent set NumComponent = null where ClassID = 3;'],
    ['an engine with no power', 'update FCT_ShipDesignComponents set ComponentValue = null where SDComponentID = 100;'],
  ]

  for (const [label, statements] of cases) {
    const [row] = await readWith(statements)
    const profile = fp.fleetProfile([row])

    assert.equal(row.UndamagedEnginePower, null, label)
    assert.equal(profile.status, 'unknown', label)
    assert.ok(codesOf(profile).includes('speed'), label)
  }

  const [other] = await readWith('update FCT_ShipDesignComponents set ComponentValue = null where SDComponentID = 101;', { GameID: 1, RaceID: 2, fleetWhere: 'FCT_Fleet.FleetID = 7' })

  near(other.UndamagedEnginePower, 20, 'a component that is not an engine does not count')
})

check('loader-columns', 'a link column the save lacks, on its own, reads as null and leaves the ship\'s links unknown', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const columns = /create table FCT_Ship \(([^)]*)\)/.exec(SCHEMA)[1].split(',').map((part) => part.trim().split(' ')[0])
  const LINKS = ['MothershipID', 'TractorTargetShipID', 'TractorParentShipID', 'TractorTargetShipyardID']

  for (const missing of LINKS) {
    const schema = `${SCHEMA.replace('create table FCT_Ship (', 'create table SavedShip (')} create view FCT_Ship as select ${columns.filter((column) => column !== missing).join(', ')} from SavedShip;`
    const database = await databaseOf(schema, ROWS.replace(/insert into FCT_Ship values/g, 'insert into SavedShip values'))
    const [row] = await fp.loadFleetShips(database, { GameID: 1, RaceID: 2, fleetWhere: 'FCT_Fleet.FleetID = 7' })

    database.close()

    const profile = fp.fleetProfile([row])

    assert.equal(row[missing], null, missing)
    LINKS.filter((link) => link !== missing).forEach((link) => assert.equal(row[link], 0, `${link} is still read`))
    assert.equal(profile.status, 'unknown', missing)
    assert.ok(codesOf(profile).includes('links'), missing)
  }
})

// Fleet 9 (one ship of class 4): two engines of 10, two cargo holds of 500 and one of 100, two colonist modules of 100, four passenger modules of 25 and two fuel tanks of 1,000 L, with a cargo bay so the loading is timed. The class stores the sums: 1,100 t, 300 colonists and 2,000 L.
const STORAGE_ROWS = `
  insert into FCT_ShipDesignComponents values (110, 4, 500, 0), (111, 17, 100, 0), (112, 50, 25, 0), (113, 3, 1000, 0), (114, 4, 100, 0);
  insert into FCT_ShipClass values (4, 'Hold', 1100, 300, 20, 100, 1000, 20, 0.5, 2000, 0);
  insert into FCT_ClassComponent values (4, 100, 2), (4, 101, 1), (4, 110, 2), (4, 111, 2), (4, 112, 4), (4, 113, 2), (4, 114, 1);
  insert into FCT_Fleet values (9, 'Holds', 100, 1, 0, 0, 0);
  insert into FCT_Ship values (20, 1, 2, 'Holder', 9, 4, 100, 100, 1, 0, 0, 0, 0, 0);
`
const FLEET_NINE = { GameID: 1, RaceID: 2, fleetWhere: 'FCT_Fleet.FleetID = 9' }

check('loader-storage', 'the holds, colonist berths and tanks a ship has left after damage are what the profile counts and holds the fuel to, and an unstated one is unknown', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const readWith = async (statements = '') => {
    const database = await databaseOf(SCHEMA, `${ROWS}${STORAGE_ROWS}${statements}`)
    const [row] = await fp.loadFleetShips(database, FLEET_NINE)

    database.close()

    return row
  }
  const sum = (row) => [row.CargoCapacity, row.ColonistCapacity, row.FuelCapacity]

  assert.deepEqual(sum(await readWith()), [1100, 300, 2000], 'no damage row: the class\'s capacities')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 100, 1);')), [1100, 300, 2000], 'a damaged engine takes no storage')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (21, 1, 110, 2);')), [1100, 300, 2000], 'another ship\'s damage is not this ship\'s')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 110, 1);')), [600, 300, 2000], 'one cargo hold damaged')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 111, 1);')), [1100, 200, 2000], 'one colonist module damaged')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 112, 3);')), [1100, 225, 2000], 'three passenger modules damaged')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 113, 1);')), [1100, 300, 1000], 'one tank damaged')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 110, 5);')), [100, 300, 2000], 'no more is taken of a component than the class mounts')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 110, 2), (20, 1, 114, 1), (20, 1, 111, 2), (20, 1, 112, 4), (20, 1, 113, 2);')), [0, 0, 0], 'every hold, berth and tank destroyed')

  // Unstated figures: only the capacity they bear on is unknown.
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 110, null);')), [null, 300, 2000], 'a damage row with no number')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 113, 1); update FCT_ShipDesignComponents set ComponentValue = null where SDComponentID = 113;')), [1100, 300, null], 'a damaged tank with no value')
  assert.deepEqual(sum(await readWith('insert into FCT_DamagedComponent values (20, 1, 111, 1); update FCT_ClassComponent set NumComponent = null where ClassID = 4 and ComponentID = 111;')), [1100, null, 2000], 'a damaged module with no installed count')
  assert.deepEqual(sum(await readWith('update FCT_ShipDesignComponents set ComponentValue = null where SDComponentID in (110, 111, 113);')), [1100, 300, 2000], 'no damage row: nothing to subtract, so no figure is unknown')

  // What the profile makes of them.
  const whole = await readWith()
  const half = await readWith('insert into FCT_DamagedComponent values (20, 1, 110, 1), (20, 1, 111, 1), (20, 1, 113, 1);')
  const wholeTrip = await tripOf(w, [whole])
  const halfTrip = await tripOf(w, [half])

  assert.equal(wholeTrip.profile.status, 'ok')
  assert.deepEqual([halfTrip.profile.cargo.counted.cargo, halfTrip.profile.cargo.counted.colonists], [600, 200], 'the cargo and the colonists counted are what the holds have left')
  assert.equal(halfTrip.trip.cargo, 600)
  assert.equal(halfTrip.trip.colonists, 200)
  near(halfTrip.trip.fuelShare, wholeTrip.trip.fuelShare * 2, 'half the tanks is twice the share of them')

  const dry = await tripOf(w, [await readWith('insert into FCT_DamagedComponent values (20, 1, 113, 2);')])

  assert.equal(dry.trip.status, 'range', 'a ship with no tank left cannot make the trip')

  const empty = await tripOf(w, [await readWith('insert into FCT_DamagedComponent values (20, 1, 110, 2), (20, 1, 114, 1), (20, 1, 111, 2), (20, 1, 112, 4);')])

  assert.equal(empty.profile.cargo.ships.length, 0, 'a ship with every hold and berth destroyed is no loader')
  assert.equal(empty.trip.status, 'none')

  const unknownHold = fp.fleetProfile([await readWith('insert into FCT_DamagedComponent values (20, 1, 110, null);')])

  assert.equal(unknownHold.status, 'unknown')
  assert.ok(codesOf(unknownHold).includes('holds'))

  const unknownTank = await tripOf(w, [await readWith('insert into FCT_DamagedComponent values (20, 1, 113, null);')])

  assert.equal(unknownTank.profile.status, 'ok', 'an unknown tank leaves the profile known')
  assert.equal(unknownTank.trip.status, 'unknown')
  assert.ok(unknownTank.trip.problems.some((problem) => problem.code === 'fuel-capacity'))
  assert.equal(unknownTank.trip.fuelPerTrip, null)
})

// The columns the runtime state of a ship reads, added to the tables after their rows as a save that has them holds them.
const RUNTIME_ROWS = `
  alter table FCT_Ship add column LastOverhaul real;
  alter table FCT_Ship add column LastShoreLeave real;
  alter table FCT_Ship add column GradePoints real;
  alter table FCT_Ship add column CrewMorale real;
  alter table FCT_Ship add column CurrentMaintSupplies real;
  alter table FCT_ShipClass add column PlannedDeployment real;
  alter table FCT_ShipClass add column MaintSupplies real;
  alter table FCT_ShipClass add column BaseFailureChance real;
  alter table FCT_ShipClass add column MaxDACRoll integer;
  alter table FCT_ShipClass add column Commercial integer;
  alter table FCT_ShipClass add column MoraleCheckRequired integer;
  alter table FCT_ShipClass add column CommercialHangar integer;
  alter table FCT_ShipClass add column SupplyShip integer;
  update FCT_Ship set LastOverhaul = 1000 + ShipID, LastShoreLeave = 2000 + ShipID, GradePoints = 150, CrewMorale = 0.9, CurrentMaintSupplies = 40 + ShipID;
  update FCT_ShipClass set PlannedDeployment = 12, MaintSupplies = 300, BaseFailureChance = 2, MaxDACRoll = 10, Commercial = 0, MoraleCheckRequired = 1, CommercialHangar = 1, SupplyShip = 0;
  update FCT_ShipClass set CommercialHangar = 0 where ShipClassID = 3;
  insert into FCT_ShipDesignComponents values (200, 31, 1, 0);
  insert into FCT_DamagedComponent values (1, 1, 200, 2), (1, 1, 200, 1), (1, 2, 200, 5), (2, 1, 200, null), (3, 1, 100, 1);
`

check('loader-runtime', 'the loader reads the clocks, stocks, grade, morale, class flags and the engineering a ship has damaged from the tables, the carrier\'s hangar kind through the carrier link, and keeps to the race', async (w) => {
  const { 'fleet-profile': fp } = await w.modules()
  const ids = (rows) => Object.keys(rows).map(Number).sort((a, b) => a - b)
  const read = async (statements = '') => {
    const database = await databaseOf(SCHEMA, `${ROWS}${RUNTIME_ROWS}${statements}`)
    const rows = await fp.loadFleetShips(database, { GameID: 1, RaceID: 2 })

    database.close()

    return Object.fromEntries(rows.map((row) => [row.ShipID, row]))
  }
  const rows = await read()
  const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]))

  assert.deepEqual(ids(rows), [1, 2, 3, 4, 5, 6, 8], 'the race\'s own ships only')
  assert.deepEqual(pick(rows[1], ['LastOverhaul', 'LastShoreLeave', 'GradePoints', 'CrewMorale', 'CurrentMaintSupplies']), { LastOverhaul: 1001, LastShoreLeave: 2001, GradePoints: 150, CrewMorale: 0.9, CurrentMaintSupplies: 41 })
  assert.deepEqual(pick(rows[1], ['PlannedDeployment', 'MaintSupplies', 'BaseFailureChance', 'MaxDACRoll', 'Commercial', 'MoraleCheckRequired', 'CommercialHangar', 'SupplyShip']), { PlannedDeployment: 12, MaintSupplies: 300, BaseFailureChance: 2, MaxDACRoll: 10, Commercial: 0, MoraleCheckRequired: 1, CommercialHangar: 1, SupplyShip: 0 })
  assert.equal(rows[1].DamagedEngineering, 3, 'the damaged engineering rows of this ship and game are summed')
  assert.equal(rows[3].DamagedEngineering, 0, 'a damaged engine is not damaged engineering, and a ship with no row has none')
  assert.equal(rows[2].DamagedEngineering, null, 'an engineering damage row with no number leaves the count unknown')
  assert.equal(rows[4].DamagedEngineering, 0)
  assert.equal(rows[6].CarrierCommercialHangar, 1, 'the carrier\'s class has a commercial hangar')
  assert.equal(rows[8].CarrierCommercialHangar, 1, 'a ship in a hangar of a hangared carrier reads that carrier\'s kind')
  assert.equal(rows[1].CarrierCommercialHangar, null, 'a ship in no hangar has no carrier')
  assert.equal((await read('update FCT_ShipClass set CommercialHangar = 0 where ShipClassID = 1;'))[6].CarrierCommercialHangar, 0, 'a military hangar reads as 0')
  assert.equal((await read('update FCT_ShipClass set CommercialHangar = null where ShipClassID = 1;'))[6].CarrierCommercialHangar, null, 'an unstated hangar kind stays unknown')

  const lacking = await read('alter table FCT_ShipClass drop column CommercialHangar;')

  assert.deepEqual(ids(lacking), ids(rows), 'a save whose classes have no hangar column still gives every ship')
  assert.ok(Object.values(lacking).every((row) => row.CarrierCommercialHangar === null && row.CommercialHangar === null), 'the hangar kind of a carrier is not known, never 0')
  assert.equal(lacking[6].MothershipID, 1, 'the carrier link itself is read')
  assert.equal(lacking[6].CarrierFleetID, rows[6].CarrierFleetID, 'the carrier\'s fleet is still read')
})

check('guarded-column', 'the carrier\'s hangar kind is a column built by name, so the page scan does not list it as one the reports require: a save without it leaves /hauling and /information as they are, while a class column they do read still fails them', async (w) => {
  const capabilities = (await w.capabilities()).capabilities
  const schemaRows = (without = []) => Object.values(capabilities.INPUTS).flat().flatMap((input) => Object.entries(input.reads).flatMap(([table, columns]) => [{ tbl: table, name: 'ROWID_' }, ...columns.filter((column) => !column.includes('*') && !without.includes(`${table}.${column}`)).map((column) => ({ tbl: table, name: column }))]))
  const report = (route, without) => capabilities.evaluate(capabilities.schemaOf(schemaRows(without))).reports[route]

  ;['/hauling', '/information'].forEach((route) => {
    const input = capabilities.INPUTS[route].find((one) => one.key === 'fleetShips')

    assert.ok(!input.reads.FCT_ShipClass.includes('CommercialHangar'), `${route} does not require the carrier's hangar column`)
    assert.ok(input.markers.FCT_ShipClass.includes('*'), `${route} reads the class columns the loader builds by name`)
    assert.ok(input.reads.FCT_ShipClass.includes('MaxSpeed'), `${route} still requires the class columns it reads by name`)

    const full = report(route, [])
    const lacking = report(route, ['FCT_ShipClass.CommercialHangar'])

    assert.equal(lacking.status, full.status, `${route} is as supported as it was`)
    assert.deepEqual(lacking.missing, full.missing)
    assert.deepEqual(lacking.degraded, full.degraded)
    assert.ok(!JSON.stringify(lacking).includes('CommercialHangar'), `${route} names no hangar column as missing`)
    assert.ok([...report(route, ['FCT_ShipClass.MaxSpeed']).missing, ...report(route, ['FCT_ShipClass.MaxSpeed']).degraded].some((entry) => entry.key === 'fleetShips'), `${route} fails on a class column it requires`)
  })

  assert.ok(!/\b\w+\.CommercialHangar\b/.test(w.text.profile), 'the loader names no table\'s carrier column outright')
})

const loadErrorsOf = (state) => new Proxy({}, { get: (_target, key) => (key === 'fleetShips' ? state : null), has: () => true })

// The Transport page on a run from a colony to a site over one route, with the fleets `fleetShips` (a mixed set by default) and each read in the state `state` gives the optional fleets read (null ready, undefined loading, a text failed).
const PLACE = { kind: 'colony', name: 'Mars', colony: colony() }
const TARGET = { kind: 'system', name: 'Site', SystemID: 3 }
const REACH = { route: { km: KM, jumps: 2 }, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }
const transportVmOf = (page, state, data = {}) => instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(state), handlingSupport: FULL_OFFICERS, formulaVersion: VERSION, origin: PLACE, destination: TARGET, reachOf: () => REACH, fleetShips: [ship({ FleetSpeed: 300, UseMaximumSpeed: 0 }), slowShip({ FleetSpeed: 300, UseMaximumSpeed: 0 }), craft({ FleetSpeed: 300, UseMaximumSpeed: 0 })], ...data } })

check('pages', 'the pages take speed, burn and counted cargo from the profile, say why a fleet is left out and track the optional read under the key they label it with', async (w) => {
  const hauling = await w.hauling()
  const transportPage = await w.transport()
  const PLACE_ORDER = { FleetID: 5, OrderDelay: 0, ActionName: 'Load', Jumps: 0, X: 0, Y: 0, ExitX: 0, ExitY: 0, ExitSystemID: 3, SystemID: 3, DestinationType: 0 }
  const orders = [{ ...PLACE_ORDER, MoveActionID: 62, Description: 'Mars: Load', PopName: 'Mars', PopulationID: 7, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }, { ...PLACE_ORDER, MoveActionID: 63, ActionName: 'Unload', Description: 'Venus: Unload', PopName: 'Venus', PopulationID: 8, ShuttleCapacity: 0, X: 3000000, ExitX: 3000000 }]

  // Hauling: a cycle of the tug and its barge between two colonies.
  const fleet = (extra = {}) => ({ FleetID: 5, FleetName: 'Cycle', Ships: 2, CargoCapacity: 2000, ColonistCapacity: 400, ShuttleTechnology: TECH, Speed: 300, FuelPerHour: 99, ...extra })
  const haulingVm = (ships, extra = {}) => instantiate(hauling, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: new Proxy({}, { get: () => null, has: () => true }), handlingSupport: FULL_OFFICERS, fleets: [fleet(extra)], orders, fleetShips: ships, formulaVersion: VERSION } })
  const weakBarge = barge({ ShuttleStrength: 0.01, DesignedShuttleStrength: 0.01 })
  const [row] = haulingVm([tug({ FleetSpeed: 300, UseMaximumSpeed: 0 }), weakBarge]).routeRows

  assert.equal(row.profile.status, 'ok')
  assert.equal(row.Speed, 300, 'the fleet moves at its set speed, not the sum of anything')
  assert.equal(row.speeds.saved, 300)
  assert.equal(row.speeds.effectiveMax, 500, 'the maximum is kept apart from the saved speed')
  assert.ok(row.year, 'a fleet that can move has a year')

  const burnPerHour = (row.year.fuel / (row.year.movingDays * 24)) / row.year.trips

  near(burnPerHour, 20 * (300 / 500) * 0.5, 'the tug burns at its own share of its own speed')
  assert.ok(row.handlingRows.length > 0)
  assert.ok(row.handlingRows.every((one) => one.ship === 'Hauler'), 'the barge in tow loads nothing and sets no stop')
  assert.equal(row.profileText, '')
  assert.equal(row.participantRows.length, 2)

  // A mixed fleet sailing below its fastest ship's maximum: the yearly fuel is each ship's own burn at its own share of its own top speed (0.3 and 0.6 of 1000 and 500 km/s: 3 and 6 L/h), and its provenance is the fleet rule for that, not the full-power burn of the class plan.
  const [mixed] = haulingVm([ship({ FleetSpeed: 300, UseMaximumSpeed: 0 }), slowShip({ FleetSpeed: 300, UseMaximumSpeed: 0 })]).routeRows
  const movingHours = mixed.year.movingDays * 24 * mixed.year.trips

  assert.equal(mixed.profile.status, 'ok')
  near(mixed.profile.fuelPerHour, 9, 'the fleet\'s burn is the sum of each ship at its own fraction')
  near(mixed.year.fuel, 9 * movingHours, 'the yearly fuel follows it')
  assert.ok(Math.abs(mixed.year.fuel - 20 * movingHours) > 1, 'and is not the full-power sum of 20 L/h')
  near(mixed.results.fuel.value, 9 * movingHours, 'the result states the figure shown, reduced-speed burn')
  assert.equal(mixed.results.fuel.rule.id, 'hauling.fleetFuelPerYear', 'under the rule for the fleet\'s own burn')

  const [maximum] = haulingVm([tug({ FleetSpeed: 1000, UseMaximumSpeed: 1 }), weakBarge], { Speed: 1000 }).routeRows

  assert.equal(maximum.Speed, 500)
  assert.equal(maximum.speeds.saved, 1000)

  const [stuck] = haulingVm([barge()]).routeRows

  assert.equal(stuck.year, null, 'a fleet that cannot be profiled has no year')
  assert.equal(stuck.Speed, 0)
  assert.ok(stuck.profileText.length > 0, 'and says why')
  assert.deepEqual([stuck.blocked.length, stuck.unknown.length], [0, 0])

  const [allTowed] = haulingVm([tug({ CargoCapacity: 0, ColonistCapacity: 0 }), barge()]).routeRows

  assert.equal(allTowed.year, null)
  assert.ok(allTowed.profileText.length > 0)

  // Transport: the fleets sailing together.
  const transportVm = (state, data = {}) => transportVmOf(transportPage, state, data)
  const vm = transportVm(null)

  assert.equal(vm.fleetRuns.length, 1)

  const [run] = vm.fleetRuns

  assert.equal(run.status, 'ok')
  assert.equal(run.speed, 500, 'Transport sails the fleet at its effective maximum')
  assert.equal(run.speeds.saved, 300, 'and keeps the saved speed apart')
  assert.equal(run.speeds.effectiveMax, 500)
  assert.equal(run.ships, 3)
  assert.equal(run.independent, 2)
  assert.equal(run.cargo, 2000, 'the craft in the hangar adds no hold')
  near(run.travelSeconds, (2 * KM) / 500)
  near(run.tonsYear, 2000 * run.trips)
  near(run.fuel, 15 * (run.travelSeconds / 3600))
  assert.equal(run.participantRows.length, 3)
  assert.ok(run.conditions.length > 0, 'the hold left out is said')
  assert.ok(run.provenance)
  assert.ok(run.pathResult && run.pathResult.value === KM, 'the route\'s distance has its own result with no avoid setting on')
  assert.ok(run.handlingRows.length > 0)

  const noRoute = transportVm(null, { reachOf: () => ({ route: null, open: null, profile: { gates: false, civilian: false }, blockers: [], safe: null, pending: false }) }).fleetRuns[0]

  assert.equal(noRoute.status, 'noroute')
  assert.equal(noRoute.tripSeconds, null)
  assert.equal(noRoute.tonsYear, null)

  const stuckRun = transportVm(null, { fleetShips: [barge()] }).fleetRuns[0]

  assert.equal(stuckRun.status, 'unsupported')
  assert.equal(stuckRun.tripSeconds, null)
  assert.ok(stuckRun.note.length > 0)
  assert.equal(stuckRun.cargo, null)

  const grounded = transportVm(null, { fleetShips: [ship({ UndamagedEnginePower: 0 })] }).fleetRuns[0]

  assert.equal(grounded.status, 'immobile')
  assert.equal(grounded.tonsYear, null)

  // The read is optional: while it loads or when it fails the page holds nothing back and the panel says so.
  for (const state of [undefined, 'the read failed']) {
    const waiting = transportVm(state)

    assert.deepEqual(waiting.fleetRuns, [], `${state}: no figures`)
    assert.equal(waiting.fleetShipsState.loading, state === undefined)
    assert.equal(waiting.fleetShipsState.failed, state !== undefined)
    assert.deepEqual(waiting.failedInputs, [], `${state}: the read holds no panel back`)
    assert.equal(waiting.inputsLoaded, true)
  }

  // The reads the pages label, track and run are one set, and keep to the fleets each page is about.
  const database = await databaseOf(SCHEMA, ROWS)
  const transportReads = instantiate(transportPage, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: {} } })
  const haulingReads = instantiate(hauling, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

  await transportReads.runAsync('fleetShips')
  await haulingReads.runAsync('fleetShips')
  assert.ok('fleetShips' in transportReads.inputLabels, 'labelled')
  assert.equal(transportReads.loadErrors.fleetShips, null, 'tracked under its label')
  assert.equal(haulingReads.loadErrors.fleetShips, null)
  assert.deepEqual([...new Set(transportReads.fleetShips.map((one) => one.FleetID))].sort(), [5, 7], 'military fleets with holds, no shipping line and none without a hold')
  assert.deepEqual([...new Set(haulingReads.fleetShips.map((one) => one.FleetID))], [5], 'the fleets that repeat their orders')
  assert.ok(haulingReads.fleetShips.every((one) => 'NavalAdminCommandID' in one && 'ShipID' in one))
  database.close()

  // A fleet whose holds the save leaves empty is not dropped from the read: it is profiled as unknown, where a fleet with no holds at all is not a candidate.
  const unsure = await databaseOf(SCHEMA, `${ROWS}
    insert into FCT_ShipClass values (5, 'Unsure', null, 0, 20, 100, 1000, 20, 0.5, 1000000, 0), (6, 'Plain', 0, 0, 20, 100, 1000, 20, 0.5, 1000000, 0);
    insert into FCT_ClassComponent values (5, 100, 2), (5, 101, 1), (6, 100, 2), (6, 101, 1);
    insert into FCT_Fleet values (10, 'Unsure', 100, 1, 0, 0, 0), (11, 'Plain', 100, 1, 0, 0, 0);
    insert into FCT_Ship values (30, 1, 2, 'Mystery', 10, 5, 100, 100, 1, 0, 0, 0, 0, 0), (31, 1, 2, 'Bare', 11, 6, 100, 100, 1, 0, 0, 0, 0, 0);
  `)
  const unsureReads = instantiate(transportPage, { $store: STORE, database: unsure, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

  await unsureReads.runAsync('fleetShips')
  assert.deepEqual([...new Set(unsureReads.fleetShips.map((one) => one.FleetID))].sort((a, b) => a - b), [5, 7, 10], 'the fleet with an empty hold is read, the fleet with none is not')

  const [unsureRun] = transportVmOf(transportPage, null, { fleetShips: unsureReads.fleetShips.filter((one) => one.FleetID === 10) }).fleetRuns

  assert.equal(unsureRun.status, 'unknown', 'the page shows it as unknown, not as absent')
  assert.equal(unsureRun.cargo, null)
  assert.ok(unsureRun.note.length > 0)
  unsure.close()
})

// ---- Templates ------------------------------------------------------------------------------------------------------
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
  const found = node.attrsList.find((attr) => attr.name === name || attr.name === `:${name}`)

  return found ? found.value : undefined
}

const templateOf = (source, filename) => {
  const parsed = compiler.parse({ source, filename })

  return compiler.compileTemplate({ source: (parsed.descriptor || parsed).template.content, filename, id: filename }).ast
}

// eslint-disable-next-line no-new-func
const evaluated = (expression, scope) => new Function('scope', `with (scope) { return (${expression}) }`)(scope)

const classTokens = (node) => (node.staticClass || '').replace(/["']/g, '').split(/\s+/)

// What a panel's summary is for a scope: the stated text, or the bound expression evaluated against the page as it stands (a real instance, not a stand-in).
const summaryOf = (node, scope) => {
  const stated = node.attrsList.find((attr) => attr.name === 'data-summary')
  const bound = node.attrsList.find((attr) => attr.name === ':data-summary')

  return stated ? stated.value : bound ? evaluated(bound.value, scope) : undefined
}

// The page in each state its reads can be in, as `make(loadErrors)` builds it: every read ready, then each read in turn loading and failed with the others ready.
const scenariosOf = (make) => {
  const keys = Object.keys(make({}).inputLabels)
  const ready = Object.fromEntries(keys.map((key) => [key, null]))
  const scenarios = [{ label: 'ready', scope: make(ready) }]

  keys.forEach((key) => {
    scenarios.push({ label: `${key} loading`, scope: make({ ...ready, [key]: undefined }) }, { label: `${key} failed`, scope: make({ ...ready, [key]: 'the read failed' }) })
  })

  return scenarios
}

// What a compiled element shows for a scope: its children once each v-if is resolved, its own text, and the provenance marks in it.
const blocksOf = (node, scope) => node.children.filter((child) => child.type === 1).map((child) => (child.ifConditions ? (child.ifConditions.find(({ exp }) => exp === undefined || evaluated(exp, scope)) || {}).block : child)).filter(Boolean)

const directText = (node, scope) => node.children.filter((child) => child.type !== 1).map((child) => (child.type === 2 ? String(evaluated(child.expression, scope)) : child.text)).join('')

const marksIn = (node, scope) => blocksOf(node, scope).flatMap((block) => (block.tag === 'provenance-mark' ? [block] : marksIn(block, scope)))

// The figures an element shows (an element whose own text has a digit) and those without a mark in it or beside it among its parent's own children.
const audit = (node, scope, beside = false) => {
  const blocks = blocksOf(node, scope)
  const marked = blocks.some((block) => block.tag === 'provenance-mark')
  const shown = /\d/.test(directText(node, scope))
  const result = { figures: shown ? 1 : 0, missing: shown && !beside && !marksIn(node, scope).length ? [directText(node, scope).trim()] : [] }

  blocks.filter((block) => block.tag !== 'provenance-mark').forEach((block) => {
    const inner = audit(block, scope, marked)

    result.figures += inner.figures
    result.missing.push(...inner.missing)
  })

  return result
}

check('template', 'the pages show the profile of each fleet bound to its row, with a provenance mark on each figure and a summary on the panel, and the component shows a row per ship', async (w) => {
  const { provenance } = await w.modules()
  const transportNodes = elementsOf(templateOf(w.text.transportPage, 'information.vue'))
  const haulingNodes = elementsOf(templateOf(w.text.haulingPage, 'hauling.vue'))
  const sentinel = { participantRows: [{ key: 'a' }], speeds: { cruise: 1 }, reasons: ['r'], conditions: ['c'], handlingRows: [{ key: 'h' }], provenance: { status: 'estimated' }, profileText: 'why', route: { km: 5 } }
  const bindings = { participants: 'participantRows', speeds: 'speeds', reasons: 'reasons', conditions: 'conditions', 'handling-rows': 'handlingRows' }

  // Transport: the panel of the fleets sailing together.
  const panel = transportNodes.find((node) => attrOf(node, 'data-fleet-panel') !== undefined)

  assert.ok(panel, 'the panel')
  assert.ok(typeof attrOf(panel, 'data-summary') === 'string' && attrOf(panel, 'data-summary').trim().length > 0, 'the panel\'s summary')

  const inside = elementsOf(panel)
  const table = inside.find((node) => node.tag === 'v-data-table')

  assert.deepEqual(evaluated(attrOf(table, 'items'), { fleetRuns: [sentinel] }), [sentinel], 'the table lists the fleets\' runs')

  const [host, ...others] = inside.filter((node) => node.tag === 'fleet-profile')

  assert.equal(others.length, 0, 'one profile in an expanded row')

  for (const [attribute, key] of Object.entries(bindings)) {
    assert.ok(attrOf(host, attribute), `Transport binds ${attribute}`)
    assert.deepEqual(evaluated(attrOf(host, attribute), { item: sentinel }), sentinel[key], `Transport: ${attribute} is the row's ${key}`)
  }

  const marks = inside.filter((node) => node.tag === 'provenance-mark')
  const rules = new Set(marks.map((mark) => attrOf(mark, 'rule')).filter(Boolean))

  ;['transport.fleetSpeed', 'transport.fleetTrip'].forEach((rule) => assert.ok(rules.has(rule), `a mark for ${rule}`))
  assert.ok(marks.some((mark) => attrOf(mark, 'result')), 'the figures of the row carry results of their own')
  rules.forEach((rule) => assert.ok(provenance.ofRule({ rule, value: 1, inputs: { present: [], missing: [] } }), `${rule} is registered`))
  assert.ok(marks.some((mark) => attrOf(mark, 'result') && evaluated(attrOf(mark, 'result'), { item: { ...sentinel, results: {} } }) === sentinel.provenance), 'the round trip carries its result')
  assert.ok(inside.some((node) => attrOf(node, 'data-fleet-note') !== undefined), 'the panel says while its read is in flight or failed')

  // Hauling: the profile in the expanded row and the reason in the cell.
  const hauled = haulingNodes.filter((node) => node.tag === 'fleet-profile')

  assert.equal(hauled.length, 1)

  for (const [attribute, key] of Object.entries(bindings)) {
    if (attrOf(hauled[0], attribute) !== undefined && key !== 'handlingRows' && key !== 'reasons' && key !== 'conditions') {
      assert.deepEqual(evaluated(attrOf(hauled[0], attribute), { item: { ...sentinel, profileNotes: ['n'] } }), sentinel[key], `Hauling: ${attribute}`)
    }
  }

  assert.deepEqual(evaluated(attrOf(hauled[0], 'conditions'), { item: { profileNotes: ['n'] } }), ['n'], 'Hauling: the notes of the profile')

  const reason = haulingNodes.find((node) => attrOf(node, 'data-fleet-profile-reason') !== undefined)

  assert.ok(reason && reason.if, 'a cell says why the fleet is left out')
  assert.equal(Boolean(evaluated(reason.if, { item: { profileText: 'why', route: { km: 5 } } })), true)
  assert.equal(Boolean(evaluated(reason.if, { item: { profileText: '', route: { km: 5 } } })), false, 'nothing to say when the fleet is profiled')

  // Every panel a page shows has a summary that is a non-empty text: the stated one, or the bound one evaluated on the real page with each of its reads ready, loading and failed.
  const transportOptions = await w.transport()
  const haulingOptions = await w.hauling()
  const haulingMake = (loadErrors) => instantiate(haulingOptions, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors, handlingSupport: FULL_OFFICERS, fleets: [], orders: [], fleetShips: [], formulaVersion: VERSION } })
  const transportMake = (loadErrors) => instantiate(transportOptions, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors, handlingSupport: FULL_OFFICERS, formulaVersion: VERSION, origin: PLACE, destination: TARGET, reachOf: () => REACH, fleetShips: [] } })

  for (const [name, nodes, make] of [['Transport', transportNodes, transportMake], ['Hauling', haulingNodes, haulingMake]]) {
    const panels = nodes.filter((node) => classTokens(node).includes('panel') && elementsOf(node).some((inner) => classTokens(inner).includes('panel-head')))
    const scenarios = scenariosOf(make)

    assert.ok(panels.length > 0, `${name} has panels`)
    assert.ok(scenarios.length >= 3, `${name}: the reads give scenarios`)
    panels.forEach((panelNode, index) => {
      const shown = scenarios.filter(({ scope }) => panelNode.if === undefined || evaluated(panelNode.if, scope))

      assert.ok(shown.length > 0, `${name}: panel ${index} is shown in some state`)
      shown.forEach(({ label, scope }) => {
        const summary = summaryOf(panelNode, scope)

        assert.ok(typeof summary === 'string' && summary.trim().length > 0, `${name}: panel ${index} has a summary while ${label}`)
      })
    })
  }

  // The component: a row per ship, its role and marks.
  const { 'fleet-profile': fp } = await w.modules()
  const profile = fp.fleetProfile([tug(), barge()])
  const { trip } = await tripOf(w, [tug(), barge()])
  const participants = fp.participantRows(profile, trip)
  const component = await w.component()
  const vm = instantiate(component, { $store: { getters: {}, state: {} }, data: { participants, speeds: { cruise: 500, cruiseSource: 'maximum', saved: 300, useMaximum: false, effectiveMax: 500, designMax: 1000, limiting: 'Hauler' }, reasons: [], conditions: [], handlingRows: [] } })
  const nodes = elementsOf(templateOf(w.text.component, 'FleetProfile.vue'))
  const scopeOf = (alias, value) => Object.assign(Object.create(vm), { [alias]: value, _s: (text) => (text === null || text === undefined ? '' : String(text)) })
  const [rowLoop] = nodes.filter((node) => attrOf(node, 'data-participant') !== undefined)

  assert.deepEqual(evaluated(rowLoop.for, vm), participants, 'a row per ship, carried ones too')
  participants.forEach((row) => {
    assert.equal(evaluated(attrOf(rowLoop, 'data-role'), scopeOf(rowLoop.alias, row)), row.role)
    assert.equal(evaluated(attrOf(rowLoop, 'data-limiting'), scopeOf(rowLoop.alias, row)), row.limiting ? 'true' : 'false')
  })

  const burn = nodes.find((node) => attrOf(node, 'data-burn') !== undefined)
  const burnText = (row) => evaluated(burn.children[0].expression, scopeOf(rowLoop.alias, row))

  assert.ok(/\d/.test(burnText(participants[0])), 'a ship under its own power shows its burn')
  assert.ok(!/\d/.test(burnText(participants[1])), 'a ship in tow shows no burn figure')

  const componentMarks = nodes.filter((node) => node.tag === 'provenance-mark')
  const componentRules = new Set(componentMarks.map((mark) => attrOf(mark, 'rule')).filter(Boolean))

  ;['transport.fleetSpeed', 'transport.fleetBurn', 'transport.fleetCargo'].forEach((rule) => assert.ok(componentRules.has(rule), `the component marks ${rule}`))
  componentRules.forEach((rule) => assert.ok(provenance.ofRule({ rule, value: 1, inputs: { present: [], missing: [] } }), `${rule} is registered`))

  // Every figure of the participants table, of the speeds above it and of the fleets table has a mark in it or beside it, in each state it is shown in.
  const scopeIn = (vmOf, extra = {}) => Object.assign(Object.create(vmOf), { _s: (text) => (text === null || text === undefined ? '' : String(text)) }, extra)
  const real = (mark, scope) => (attrOf(mark, 'rule') ? Boolean(provenance.ofRule({ rule: attrOf(mark, 'rule'), value: 1, inputs: { present: [], missing: [] } })) : Boolean(evaluated(attrOf(mark, 'result'), scope)))
  const sets = []

  for (const ships of [[tug(), barge()], [ship(), craft()], [ship(), slowShip()], [ship({ CargoCapacity: 0, ColonistCapacity: 0 })], [ship({ CargoCapacity: null })]]) {
    const made = await tripOf(w, ships)

    sets.push(fp.participantRows(made.profile, made.trip), fp.participantRows(made.profile))
  }

  const rows = sets.flat()

  for (const cell of ['data-own-maximum', 'data-fraction', 'data-burn', 'data-fuel-trip', 'data-cargo', 'data-colonists']) {
    const node = nodes.find((one) => attrOf(one, cell) !== undefined)
    let figures = 0

    assert.ok(node, `the ${cell} cell`)
    rows.forEach((row) => {
      const scope = scopeOf(rowLoop.alias, row)
      const audited = audit(node, scope)

      assert.deepEqual(audited.missing, [], `${cell}: a figure with no mark`)
      assert.ok(marksIn(node, scope).every((mark) => real(mark, scope)), `${cell}: a mark that stands for nothing`)
      figures += audited.figures
    })
    assert.ok(figures > 0, `${cell} shows a figure in some state`)
  }

  const caption = nodes.find((one) => attrOf(one, 'data-fleet-speeds') !== undefined)
  const speedSets = [
    { cruise: 500, cruiseSource: 'maximum', saved: 300, useMaximum: false, effectiveMax: 500, designMax: 1000, limiting: 'Hauler' },
    { cruise: 500, cruiseSource: 'saved-capped', saved: 800, useMaximum: null, effectiveMax: 500, designMax: 500, limiting: '' },
    { cruise: null, cruiseSource: null, saved: null, useMaximum: null, effectiveMax: null, designMax: null, limiting: '' },
    { cruise: 300, cruiseSource: 'saved', saved: 300, useMaximum: true, effectiveMax: 500, designMax: null, limiting: 'Hauler' },
  ]
  let captioned = 0

  for (const speeds of speedSets) {
    const captionVm = instantiate(component, { $store: { getters: {}, state: {} }, data: { participants: [], speeds, reasons: [], conditions: [], handlingRows: [] } })
    const scope = scopeIn(captionVm)
    const audited = audit(caption, scope)

    assert.deepEqual(audited.missing, [], 'a speed with no mark')
    assert.ok(marksIn(caption, scope).every((mark) => real(mark, scope)))
    captioned += audited.figures
  }

  assert.ok(captioned >= 4, 'the speeds are shown')

  const ready = { FleetName: 'Cycle', ships: 3, independent: 2, cargo: 1000, colonists: 200, speed: 500, savedSpeed: 300, effectiveMax: 400, tripSeconds: 86400, jumps: 2, km: 5, status: 'ok', provenance: { status: 'estimated' }, pathResult: { status: 'estimated' }, trips: 3, tonsYear: 3000, colonistsYear: 600, fuel: 12, fuelShare: 0.1, fuelLimiting: 'Hauler', results: { trips: { status: 'estimated' }, tonsYear: { status: 'estimated' }, colonistsYear: { status: 'estimated' }, fuel: { status: 'estimated' }, fuelShare: { status: 'estimated' } } }
  const bare = { FleetName: 'Cycle', ships: 0, independent: 0, cargo: null, colonists: null, speed: null, savedSpeed: null, effectiveMax: null, tripSeconds: null, jumps: 0, km: 0, status: 'unknown', provenance: null, pathResult: null, trips: null, tonsYear: null, colonistsYear: null, fuel: null, fuelShare: null, fuelLimiting: '' }

  // The rows the page itself makes, with no avoid setting on (its distance has the route finder's own result) and for each way a run can come out.
  const grown = (extra) => transportVmOf(transportOptions, null, extra).fleetRuns[0]
  const made = [grown({}), grown({ reachOf: () => ({ ...REACH, route: { km: 1e14, jumps: 2 } }) }), grown({ reachOf: () => ({ ...REACH, route: null }) }), grown({ fleetShips: [barge()] }), grown({ fleetShips: [ship({ UndamagedEnginePower: 0 })] })]
  const items = [ready, bare, { ...ready, savedSpeed: 500, effectiveMax: 500 }, ...made]

  assert.ok(made.some((row) => row.status === 'ok') && made.some((row) => row.status === 'range') && made.some((row) => row.status === 'noroute') && made.some((row) => row.status === 'unsupported') && made.some((row) => row.status === 'immobile'), 'the pages\' own rows cover each way a run comes out')

  const RESULT_RULES = { trips: { trips: 'transport.fleetTrip' }, tonsYear: { tonsYear: 'transport.fleetTrip' }, colonistsYear: { colonistsYear: 'transport.fleetTrip' }, fuel: { fuel: 'transport.fleetBurn', fuelShare: 'transport.fleetBurn' } }

  for (const slot of ['FleetName', 'ships', 'cargo', 'colonists', 'speed', 'tripDays', 'trips', 'tonsYear', 'colonistsYear', 'fuel']) {
    const node = inside.find((one) => typeof one.slotTarget === 'string' && one.slotTarget.replace(/[`'"]/g, '') === `item.${slot}`)
    let figures = 0

    assert.ok(node, `the ${slot} column of the fleets table`)
    items.forEach((item) => {
      const scope = { item, count: String, duration: String, distance: String, tripTitle: String, SECONDS_PER_DAY: 86400, _s: String }
      const audited = audit(node, scope)

      assert.deepEqual(audited.missing, [], `${slot}: a figure with no mark`)
      assert.ok(marksIn(node, scope).every((mark) => real(mark, scope)), `${slot}: a mark that stands for nothing`)
      figures += audited.figures
    })
    assert.ok(figures > 0, `${slot} shows a figure`)

    if (slot in RESULT_RULES) {
      let resolved = 0

      made.filter((row) => row.status === 'ok').forEach((item) => {
        const scope = { item, count: String, duration: String, distance: String, tripTitle: String, SECONDS_PER_DAY: 86400, _s: String }

        marksIn(node, scope).forEach((mark) => {
          const field = (/^item\.results\.(\w+)$/.exec(attrOf(mark, 'result') || '') || [])[1]

          assert.ok(field, `${slot}: a mark of the row's own result`)
          assert.equal(evaluated(attrOf(mark, 'result'), scope).rule.id, RESULT_RULES[slot][field], `${slot}, ${field}: the figure is of the rule that computes it`)
          resolved += 1
        })
      })
      assert.ok(resolved > 0, `${slot}: the page's own row is resolved`)
    }
  }

  // The audit sees a figure of a successful row left with no mark: a distance whose result is missing.
  const tripCell = inside.find((one) => typeof one.slotTarget === 'string' && one.slotTarget.replace(/[`'"]/g, '') === 'item.tripDays')

  assert.ok(audit(tripCell, { item: { ...ready, pathResult: null }, count: String, duration: String, distance: String, tripTitle: String, SECONDS_PER_DAY: 86400, _s: String }).missing.length > 0, 'a distance with no result is a figure with no mark')

  // Hauling: the cell of a repeating fleet states its ships and the speed it sails at, and the saved speed where that differs, each with a mark.
  const fleetCell = haulingNodes.find((one) => typeof one.slotTarget === 'string' && one.slotTarget.replace(/[`'"]/g, '') === 'item.FleetName')
  const cellOf = (extra) => ({ item: { FleetName: 'Cycle', Ships: 2, speedText: '500 km/s', savedText: '(saved 1000)', profile: { status: 'ok' }, routesLink: '', routesName: '', ...extra }, _s: String })
  let cellFigures = 0

  assert.ok(fleetCell, 'the fleet cell of Hauling')
  ;[cellOf({}), cellOf({ savedText: '' }), cellOf({ Ships: 1, speedText: 'no speed', savedText: '', profile: { status: 'unsupported' } })].forEach((scope) => {
    const audited = audit(fleetCell, scope)

    assert.deepEqual(audited.missing, [], 'Hauling: a figure of the fleet cell with no mark')
    assert.ok(marksIn(fleetCell, scope).every((mark) => real(mark, scope)), 'Hauling: a mark that stands for nothing')
    cellFigures += audited.figures
  })
  assert.ok(cellFigures > 0, 'the fleet cell shows figures')
  assert.ok(marksIn(fleetCell, cellOf({})).length >= 3, 'the ships, the speed and the saved speed each carry a mark')
})

// ---- The planted faults ----------------------------------------------------------------------------------------------
// Each plants one change in one source, and the checks named must fail on it. [label, target, text, replacement, the checks that must fail]
const DISTANCE_RESULT = /(pathResult: )(?:this\.pathOf\(reach\)|\(this\.pathOf\(reach\)\))(?=, savedPositions:)/

const FAULTS = [
  ['a ship in a hangar or under tow is taken as under its own power', 'profile', 'const role = hangared ? \'hangared\' : towed ? \'towed\' : \'independent\'', 'const role = \'independent\'', ['carried']],
  ['the holds of carried and towed ships are counted', 'profile', 'const loaders = independent.filter((participant) => participant.cargoStatus === \'counted\').map((participant) => participant.ship)', 'const loaders = participants.filter((participant) => participant.cargoStatus !== \'none\').map((participant) => participant.ship)', ['carried', 'stop-bottleneck']],
  ['the overhaul is left out of a ship\'s speed', 'profile', 'const thrust = power * overhaul', 'const thrust = power', ['damage-overhaul']],
  ['the mass of the ship in tow is left out', 'profile', 'const mass = ship.Size + (towing ? ship.TowedSize : 0)', 'const mass = ship.Size', ['tow-mass']],
  ['the fleet takes the class speeds as its limit', 'profile', 'const speeds = independent.map((participant) => participant.engine.speed)', 'const speeds = independent.map((participant) => participant.ship.MaxSpeed)', ['damage-overhaul', 'tow-mass']],
  ['every ship burns at its full speed', 'profile', 'const fraction = cruise / participant.engine.speed', 'const fraction = 1', ['shared-cycle']],
  ['the burn base is the overhaul-reduced thrust', 'profile', 'enginePower: participant.ship.UndamagedEnginePower', 'enginePower: participant.engine.thrust', ['damage-overhaul']],
  ['a ship with no propulsion gives a route at 1 km/s', 'profile', 'return { speed: MIN_SPEED, thrust: Math.max(0, thrust), mass, propulsion: false }', 'return { speed: MIN_SPEED, thrust: Math.max(0, thrust), mass, propulsion: true }', ['no-propulsion']],
  ['a ship with no propulsion is not a reason', 'profile', 'if (engine.propulsion === false) {', 'if (false) {', ['no-propulsion']],
  ['a link the save does not state is taken as none', 'profile', '(value) => (known(value) ? value > 0 : null)', '(value) => (known(value) ? value > 0 : false)', ['unknown']],
  ['a hangar inside a hangar is supported', 'profile', 'if (linked(ship.CarrierMothershipID)) {', 'if (false) {', ['unsupported']],
  ['a ship that is towed and tows is supported', 'profile', 'if (towed && towing) {', 'if (false) {', ['unsupported']],
  ['a ship that tows a ship that tows is supported', 'profile', '} else if (towing && linked(ship.TowedTargetShipID)) {', '} else if (false) {', ['unsupported']],
  ['a shipyard in tow is supported', 'profile', 'if (shipyard) {', 'if (false) {', ['unsupported']],
  ['a carrier of another fleet is supported', 'profile', '} else if (ship.CarrierFleetID !== fleetId) {', '} else if (false) {', ['unsupported']],
  ['a saved speed above the maximum is not held to it', 'profile', 'saved > effectiveMax ? [effectiveMax, \'saved-capped\'] : [saved, \'saved\']', '[saved, \'saved\']', ['saved-speed']],
  ['the maximum basis sails at the saved speed', 'profile', 'basis === \'maximum\' || useMaximumSpeed === true', 'useMaximumSpeed === true', ['saved-speed']],
  ['a trip out of range is called ok', 'profile', 'const ranged = trip.status === \'ok\' && tightest && tightest.share > 1 ? \'range\' : trip.status', 'const ranged = trip.status', ['fuel-range']],
  ['a ship with no tank has no limit', 'profile', '(capacity > 0 ? perTrip / capacity : perTrip > 0 ? Infinity : 0)', '(capacity > 0 ? perTrip / capacity : 0)', ['fuel-range']],
  ['the stops are timed on the first ship alone', 'profile', 'const trip = roundTrip([{ ...head, MaxSpeed: profile.cruise, EnginePower: 0 }, ...rest]', 'const trip = roundTrip([{ ...head, MaxSpeed: profile.cruise, EnginePower: 0 }]', ['stop-bottleneck']],
  ['the trip flies at the speed of the first ship\'s class', 'profile', 'MaxSpeed: profile.cruise,', 'MaxSpeed: head.MaxSpeed,', ['shared-cycle']],
  ['Hauling moves a fleet that cannot be profiled', 'profile', 'Speed: profile.status === \'ok\' ? profile.cruise : 0,', 'Speed: profile.cruise,', ['unsupported', 'no-propulsion', 'hauling-fleet', 'pages']],
  ['Hauling burns fuel for a fleet that cannot be profiled', 'profile', 'FuelPerHour: profile.status === \'ok\' ? profile.fuelPerHour : 0,', 'FuelPerHour: profile.fuelPerHour,', ['hauling-fleet']],
  // eslint-disable-next-line no-template-curly-in-string
  ['a column the save lacks reads as 0', 'profile', '(hasShipColumn(name) ? `FCT_Ship.${name}` : `null as ${name}`)', '(hasShipColumn(name) ? `FCT_Ship.${name}` : `0 as ${name}`)', ['loader', 'loader-columns']],
  ['the loader ignores the engines damaged', 'profile', 'const DAMAGE_ROWS = \'from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID', 'const DAMAGE_ROWS = \'from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = 0', ['loader']],
  ['the loader leaves the towed mass out', 'profile', 'const mass = through(\'TractorTargetShipID\', \'OTHER_CLASS.Size\')', 'const mass = through(\'TractorTargetShipID\', \'0\')', ['loader']],
  ['the loader leaves the carrier\'s fleet out', 'profile', 'const carrierFleet = through(\'MothershipID\', \'OTHER.FleetID\')', 'const carrierFleet = through(\'MothershipID\', \'0\')', ['loader']],
  ['the loader leaves the carrier\'s own carrier out', 'profile', 'const carrierOfCarrier = through(\'MothershipID\', \'OTHER.MothershipID\')', 'const carrierOfCarrier = through(\'MothershipID\', \'0\')', ['loader']],
  ['Transport sails the fleet at its saved speed', 'transportPage', 'const profile = fleetProfile(fleet.ships, fleet, { basis: \'maximum\' })', 'const profile = fleetProfile(fleet.ships, fleet, { basis: \'saved\' })', ['pages']],
  ['Transport waits for the ships of the fleets', 'transportPage', /(const OPTIONAL_INPUTS = \[[^\]]*?)(?:'fleetShips', |, 'fleetShips')/, (m) => m[1], ['pages']],
  ['Transport labels the read under another key', 'transportPage', /^( {2})fleetShips(: ')/m, (m) => `${m[1]}fleetShipRows${m[2]}`, ['pages']],
  ['Transport tracks the read under another key', 'transportPage', 'get: tracked(\'fleetShips\', async function () {', 'get: tracked(\'fleetShipRows\', async function () {', ['pages']],
  ['Transport reads shipping line ships into the fleets', 'transportPage', 'FCT_Fleet.ShippingLine = 0 and FCT_Fleet.FleetID in', 'FCT_Fleet.FleetID in', ['pages']],
  ['Transport shows no mark on the speed', 'transportPage', /(data-fleet-panel[^]*?\{\{ count\(item\.speed\) \}\}[^<]*)<provenance-mark [^>]*\/>/, (m) => m[1], ['template']],
  ['Transport shows no profile of the fleet', 'transportPage', ':speeds="item.speeds" :reasons="item.reasons"', ':speeds="{}" :reasons="item.reasons"', ['template']],
  ['Hauling reads fleets that do not repeat their orders', 'haulingPage', 'fleetWhere: \'FCT_Fleet.CycleMoves = 1 and FCT_Fleet.ShippingLine = 0\'', 'fleetWhere: \'FCT_Fleet.ShippingLine = 0\'', ['pages']],
  ['Hauling sails the fleet at the maximum, not its set speed', 'haulingPage', 'const profile = fleetProfile(ships, fleet, { basis: \'saved\' })', 'const profile = fleetProfile(ships, fleet, { basis: \'maximum\' })', ['pages']],
  ['Hauling keeps the saved speed', 'haulingPage', 'Speed: sailing.Speed,', 'Speed: fleet.Speed,', ['pages']],
  ['Hauling times the stops on every ship, the towed ones too', 'haulingPage', 'cycleHandling(orders, cargo, sailing, profile.cargo.ships,', 'cycleHandling(orders, cargo, sailing, ships,', ['pages']],
  ['Hauling does not say why a fleet is left out', 'haulingPage', 'v-if="item.profileText && item.route.km !== null"', 'v-if="false"', ['template']],
  ['Hauling shows no profile of the fleet', 'haulingPage', ':participants="item.participantRows"', ':participants="[]"', ['template']],
  ['the component hides the carried ships', 'component', 'v-for="row in participants"', 'v-for="row in participants.filter((one) => one.role === \'independent\')"', ['template']],
  ['the component shows a burn for a carried ship', 'profile', 'burn: participant.burn === undefined || participant.role !== \'independent\' ? null : participant.burn,', 'burn: participant.burn === undefined ? null : participant.burn,', ['carried']],
  ['the component marks no burn', 'component', /(<td [^>]*data-burn[^>]*>(?:(?!<\/td>)[^])*?)<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ...['own-maximum', 'fraction', 'fuel-trip', 'cargo', 'colonists'].map((cell) => [`the component marks no ${cell}`, 'component', new RegExp(`(<td [^>]*data-${cell}(?=[\\s>])[^>]*>(?:(?!</td>)[^])*?)<provenance-mark[^>]*/>`), (m) => m[1], ['template']]),
  ...['saved', 'effectiveMax', 'designMax'].map((figure) => [`the component marks no ${figure} speed`, 'component', new RegExp(`(<span v-if="speeds\\.${figure} !== null[^>]*>(?:(?!</span>)[^])*?)<provenance-mark[^>]*/>`), (m) => m[1], ['template']]),
  ...['cargo', 'colonists', 'trips', 'tonsYear', 'colonistsYear'].map((slot) => [`Transport marks no ${slot} of a fleet`, 'transportPage', new RegExp(`(data-fleet-panel[^]*?#\\[\`item\\.${slot}\`\\]="[^"]*">(?:(?!</template>)[^])*?)<provenance-mark[^>]*/>`), (m) => m[1], ['template']]),
  ['Transport marks no saved and maximum speed', 'transportPage', /(data-fleet-speeds-apart>[^<]*)<provenance-mark[^>]*\/>([^<]*)<provenance-mark[^>]*\/>/, (m) => `${m[1]}${m[2]}`, ['template']],
  ['Transport marks no distance of a fleet', 'transportPage', /(data-fleet-panel[^]*?distance\(item\.km\) \}\})<provenance-mark [^>]*pathResult[^>]*\/>/, (m) => m[1], ['template']],
  ['Transport marks no tank share', 'transportPage', /(\{\{ item\.fuelLimiting \}\})<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ['Transport rules a fleet\'s fuel as its trip', 'transportPage', 'figure(\'transport.fleetBurn\', trip.fuelPerTrip, \'L\')', 'figure(\'transport.fleetTrip\', trip.fuelPerTrip, \'L\')', ['template']],
  ['Transport rules a fleet\'s share of a tank as its trip', 'transportPage', 'figure(\'transport.fleetBurn\', trip.fuelShare * 100, \'%\')', 'figure(\'transport.fleetTrip\', trip.fuelShare * 100, \'%\')', ['template']],
  ['a panel of Transport has no summary', 'transportPage', /<v-card class="panel"(?=[^>]*data-fleet-panel)[^>]*>/, (m) => m[0].replace(/ data-summary="[^"]*"/, ''), ['template']],
  ['the first panel of Hauling has no summary', 'haulingPage', /^([^]*?<v-card class="panel") data-summary="[^"]*"/, (m) => m[1], ['template']],
  ['a panel of Transport has no summary while its optional read loads', 'transportPage', /<v-card class="panel"(?=[^>]*data-fleet-panel)[^>]*>/, (m) => m[0].replace(/ data-summary="([^"]*)"/, (_all, text) => ` :data-summary="loadErrors.fleetShips === undefined ? '' : '${text}'"`), ['template']],
  ['the first panel of Hauling has no summary while a read failed', 'haulingPage', /^([^]*?<v-card class="panel") data-summary="([^"]*)"/, (m) => `${m[1]} :data-summary="loadErrors.fleetShips ? '' : '${m[2]}'"`, ['template']],
  ['a panel of Transport binds its summary to a name the page does not have', 'transportPage', /<v-card class="panel"(?=[^>]*data-fleet-panel)[^>]*>/, (m) => m[0].replace(/ data-summary="[^"]*"/, ' :data-summary="summaryOfTheFleets"'), ['template']],
  ['Transport marks no ship count', 'transportPage', /(count\(item\.ships\) \}\})<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ['Transport marks no count of ships under their own power', 'transportPage', /(\{\{ item\.independent \}\} of \{\{ item\.ships \}\}[^<]*)<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ['Transport gives a fleet no result for its distance when no avoid setting is on', 'transportPage', DISTANCE_RESULT, (m) => `${m[1]}null`, ['pages', 'template']],
  ['Transport drops a fleet whose holds the save leaves empty', 'transportPage', ' or carrierClass.CargoCapacity is null or carrierClass.ColonistCapacity is null', '', ['pages']],
  ['Hauling marks no ship count', 'haulingPage', /(item\.Ships === 1 \? 'ship' : 'ships' \}\})<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ['Hauling marks no speed of the fleet', 'haulingPage', /(\{\{ item\.speedText \}\})<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ['Hauling marks no saved speed', 'haulingPage', /(\{\{ item\.savedText \}\})<provenance-mark[^>]*\/>/, (m) => m[1], ['template']],
  ['the yearly fuel of a fleet states the rule of another figure', 'haulingRules', /(fuel: ofRule\(\{ rule: ')[^']*(', value: year\.fuel)/, (m) => `${m[1]}hauling.freightMoved${m[2]}`, ['pages']],
  ['the loader takes the class\'s capacities, damaged or not', 'profile', /\$\{STORAGE_SQL\}, /, () => 'FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.FuelCapacity, ', ['loader-storage']],
  ['the passenger modules are not berths', 'profile', '[COLONIST_TRANSPORT, PASSENGER_MODULE]', '[COLONIST_TRANSPORT]', ['loader-storage']],
  ['more of a component is taken than the class mounts', 'profile', 'min(FCT_DamagedComponent.Number, FCT_ClassComponent.NumComponent)', 'FCT_DamagedComponent.Number', ['loader-storage']],
  ['a damaged component with no number takes nothing', 'profile', ' or FCT_DamagedComponent.Number is null)) then null else max(', ')) then null else max(', ['loader-storage']],
  ['a damaged component whose count or value the save leaves empty is taken as known', 'profile', 'FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null or FCT_DamagedComponent.Number is null)) then null else max(', 'FCT_DamagedComponent.Number is null)) then null else max(', ['loader-storage']],
  ['a ship in a hangar is not told from one whose carrier link is empty', 'profile', '} else if (linked(ship.CarrierMothershipID) === null) {', '} else if (false) {', ['unknown']],
  ['a shipyard link the save leaves empty is no tow', 'profile', ' || shipyard === null', '', ['unknown']],
  ['a tow target link the save leaves empty is no chain', 'profile', '} else if (towing && linked(ship.TowedTargetShipID) === null && known(ship.TowedSize)) {', '} else if (false) {', ['unknown']],
  ['a hold the save leaves empty is no hold', 'profile', 'const holdsUnknown = !known(ship.CargoCapacity) || !known(ship.ColonistCapacity)', 'const holdsUnknown = false', ['unknown']],
  ['a speed setting the save leaves empty is taken as hand-set', 'profile', 'const modeUnknown = basis === \'saved\' && useMaximumSpeed === null && saved !== null && Math.min(saved, effectiveMax) !== effectiveMax', 'const modeUnknown = false', ['unknown']],
  ['a speed setting that changes nothing makes the speed unknown', 'profile', ' && Math.min(saved, effectiveMax) !== effectiveMax', '', ['unknown']],
  ['the maximum basis reads the speed setting', 'profile', 'const modeUnknown = basis === \'saved\' && ', 'const modeUnknown = ', ['unknown']],
  ['a tank the save leaves empty is a tank of 0', 'profile', 'share: known(capacity) ? (capacity > 0 ? perTrip / capacity : perTrip > 0 ? Infinity : 0) : null', 'share: capacity > 0 ? perTrip / capacity : perTrip > 0 ? Infinity : 0', ['unknown']],
  ['a trip with an unknown tank is run', 'profile', 'const status = trip.status === \'ok\' && tanks.length ? \'unknown\' : ranged', 'const status = ranged', ['unknown']],
  // eslint-disable-next-line no-template-curly-in-string
  ['a damage row with no number is no damage', 'profile', ' or exists (select 1 ${DAMAGE_ROWS} and FCT_DamagedComponent.Number is null)', '', ['loader-null']],
  ['an installed count with no number is none', 'profile', 'FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null or exists (', 'FCT_ShipDesignComponents.ComponentValue is null or exists (', ['loader-null']],
  ['an engine with no power is none', 'profile', 'FCT_ShipDesignComponents.ComponentValue is null or exists (', 'exists (', ['loader-null']],
  ['the damaged engineering is counted from another component type', 'profile', 'const ENGINEERING = 31', 'const ENGINEERING = 30', ['loader-runtime']],
  ['an engineering damage row with no number takes nothing', 'profile', 'Number is null) then null else coalesce(', 'Number is null) then 0 else coalesce(', ['loader-runtime']],
  // eslint-disable-next-line no-template-curly-in-string
  ['the carrier\'s hangar kind is left out', 'profile', 'through(\'MothershipID\', `OTHER_CLASS.${CARRIER_CLASS_COLUMN}`)', 'through(\'MothershipID\', \'0\')', ['loader-runtime']],
  // eslint-disable-next-line no-template-curly-in-string
  ['the carrier\'s hangar kind is read as a named column of the class table', 'profile', 'through(\'MothershipID\', `OTHER_CLASS.${CARRIER_CLASS_COLUMN}`)', 'through(\'MothershipID\', \'OTHER_CLASS.CommercialHangar\')', ['guarded-column']],
  ['a save without the carrier\'s hangar column drops its ships', 'profile', 'const carrierHangar = hasClassColumn(CARRIER_CLASS_COLUMN) ?', 'const carrierHangar = true ?', ['loader-runtime']],
  // eslint-disable-next-line no-template-curly-in-string
  ['a class column the save lacks reads as 0', 'profile', '(hasClassColumn(name) ? `FCT_ShipClass.${name}` : `null as ${name}`)', '(hasClassColumn(name) ? `FCT_ShipClass.${name}` : `0 as ${name}`)', ['loader']],
]

// ---- Benign edits ----------------------------------------------------------------------------------------------------
// Edits that change nothing the checks look at: the wording of a role, a hold label, a source text, a reason, a panel's summary and the order of a panel's attributes. Each is located by the attribute, key or code it belongs to, never by what it holds now.
const STRING = '\'[^\'\\n]*\''

const BENIGN = [
  { label: 'a role reworded', target: 'profile', at: new RegExp(`(towed: )${STRING}`), to: (m) => `${m[1]}'Pulled by a tractor beam'` },
  { label: 'a reason reworded', target: 'profile', at: new RegExp(`(code: 'no-independent', text: )${STRING}`), to: (m) => `${m[1]}'no ship of the fleet moves on its own power'` },
  { label: 'a hold label reworded', target: 'component', at: new RegExp(`(counted: )${STRING}`), to: (m) => `${m[1]}'Loads'` },
  { label: 'a speed source reworded', target: 'component', at: new RegExp(`(saved: )${STRING}`), to: (m) => `${m[1]}'the speed set for the fleet'` },
  { label: 'the summary of the fleets panel reworded', target: 'transportPage', at: /(<v-card class="panel" data-summary=")[^"]*(" data-fleet-panel)/, to: (m) => `${m[1]}How a fleet sails the chosen run as one and what it carries${m[2]}` },
  { label: 'the attributes of the fleets panel reordered', target: 'transportPage', at: /<v-card class="panel" (data-summary="[^"]*") (data-fleet-panel) (elevation="1")>/, to: (m) => `<v-card class="panel" ${m[3]} ${m[2]} ${m[1]}>` },
  { label: 'the attributes of the participants rows reordered', target: 'component', at: /<tr v-for="row in participants" :key="row.key" (:data-participant="row.key") (:data-role="row.role") (:data-limiting="[^"]*")>/, to: (m) => `<tr ${m[3]} ${m[2]} ${m[1]} v-for="row in participants" :key="row.key">` },
  { label: 'the label of the fleets input reworded', target: 'transportPage', at: /^( {2}fleetShips: )'[^']*'/m, to: (m) => `${m[1]}'the membership of the fleets'` },
  { label: 'the optional inputs listed in the opposite order', target: 'transportPage', at: /(const OPTIONAL_INPUTS = )\[((?:'[^']*'|\.\.\.\w+)(?:, (?:'[^']*'|\.\.\.\w+))*)\]/, to: (m) => `${m[1]}[${m[2].split(', ').reverse().join(', ')}]` },
  { label: 'the fleet distance result is parenthesised', target: 'transportPage', at: DISTANCE_RESULT, to: (m) => `${m[1]}(this.pathOf(reach))` },
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
  const only = (process.argv.find((argument) => argument.startsWith('--only=')) || '').slice('--only='.length).split('|').filter(Boolean)
  const selected = (label) => !only.length || only.some((text) => label.includes(text))
  const detail = process.argv.includes('--detail')
  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))

    FAULTS.forEach(([label, , , , fails]) => fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`)))

    const stages = [
      ...BENIGN.filter((edit) => selected(edit.label)).map((edit) => [`benign edit kept: ${edit.label}`, async () => (await run(CHECKS, worldOf([edit]))).map(describeFailure)]),
      ...(!only.length ? BENIGN.slice(1, -1).map((_edit, index) => [`benign edits stacked: the first ${index + 2}`, async () => (await run(CHECKS, worldOf(BENIGN.slice(0, index + 2)))).map(describeFailure)]) : []),
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

    const attempts = FAULTS.filter(([label]) => selected(label)).flatMap(([label, target, from, to, fails]) => {
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
        } else if (detail) {
          console.log(`CAUGHT ${label} by ${describeFailure(failed)}`)
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
