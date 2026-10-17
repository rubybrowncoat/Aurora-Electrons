/*
  Checks the runtime state of the race's actual ships (src/renderer/utilities/ship-runtime.js) without a save.

  Every statement runs on a small SQLite database made here and on the real utilities; one check also reads the saves of a passive campaign (artifacts/passive-campaign-20261013/snapshots) when they are on disk. The statements cover the acceptance of AE-105-04:
  - one record per ship holds the save's revision, the clocks, supplies, fuel, crew, morale and grade as the save has them, the rates worked out from them and the support case, frozen;
  - two callers that ask for the same classes get identical records, whatever the order of the class ids and of the rows;
  - a read that finishes after the game, race, save copy or database changed, after a later read or after `cancel()` is stale and carries no ship;
  - another race's ship is never read, whether it sits in the selected class or in a class of its own, and a class that is not the race's own is rejected;
  - a column the save lacks reads as unknown, never 0, so no rate is given for it;
  - observed figures, calculated rates and the class's planning estimate of its life sit in separate provenance envelopes;
  - a ship in a hangar keeps the age the save gives it, which the hangar's rule moves four years a year toward 0, and a ship at a shore-leave location recovers at the location rate whether or not it is docked; a ship under tow, in no known case or without cover is left unknown, with its reason;
  - over every consecutive pair of saves of a passive campaign, the overhaul date of each military ship moves by exactly the game time that passed.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names, both on the real source and on the source with every benign edit applied. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults and the benign edits.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const inRenderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)

const FILES = { runtime: inRenderer('utilities', 'ship-runtime.js') }
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------
const YEAR = 31536000
const MONTH = 2592000
const NOW = 100000000
const GAME = 1
const RACE = 2
const FOE = 7

const near = (actual, expected, message = '') => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${message} ${actual} is not ${expected}`.trim())

const SCHEMA = ({ old = false, v26 = false, noHit = false } = {}) => `
  create table FCT_Game (GameID integer, GameTime real${old ? '' : ', NoOverhauls integer'}${old || v26 ? '' : ', AllowCMC integer, AncientRelics integer'});
  create table FCT_Race (RaceID integer, ${old ? '' : 'GameID integer, NPR integer, '}CargoShuttleLoadModifier real);
  create table FCT_Fleet (FleetID integer, FleetName text, Speed integer, UseMaximumSpeed integer, ParentCommandID integer, ShippingLine integer, CycleMoves integer);
  create table FCT_ShipClass (ShipClassID integer, ClassName text, GameID integer, RaceID integer, CargoCapacity real, ColonistCapacity real, Size real, Crew integer, MaxSpeed integer, EnginePower real, FuelEfficiency real, FuelCapacity real, MilitaryEngines integer${old ? '' : ', PlannedDeployment real, MaintSupplies real, BaseFailureChance real, MaxDACRoll integer, Commercial integer, MoraleCheckRequired integer, CommercialHangar integer, SupplyShip integer'});
  create table FCT_Ship (ShipID integer, GameID integer, RaceID integer, ShipName text, FleetID integer, ShipClassID integer, CurrentCrew integer, Fuel real, OverhaulFactor real, MaintenanceState integer, MothershipID integer, TractorTargetShipID integer, TractorParentShipID integer, TractorTargetShipyardID integer${old ? '' : ', LastOverhaul real, LastShoreLeave real, GradePoints real, CrewMorale real, CurrentMaintSupplies real'});
  create table FCT_ClassComponent (ClassID integer, ComponentID integer, NumComponent integer${old || noHit ? '' : ', ChanceToHit integer'});
  create table FCT_ShipDesignComponents (SDComponentID integer, ComponentTypeID integer, ComponentValue real, SpecialFunction integer, Cost real);
  create table FCT_DamagedComponent (ShipID integer, GameID integer, ComponentID integer, Number integer);
  create table FCT_ShipyardTask (TaskID integer, GameID integer, RaceID integer, ShipID integer, Paused integer);
`

const insert = (table, rows) => rows.map((row) => `insert into ${table} (${Object.keys(row).join(', ')}) values (${Object.values(row).map((value) => (typeof value === 'string' ? `'${value}'` : value === null ? 'null' : value)).join(', ')});`).join('\n')

// A class of the race: military, 100 crew, a plan of 12 months and 300 MSP, failing 2% a year, with a damage roll of 10, in no commercial hangar and not a supply ship.
const klass = (id, name, extra = {}) => ({ ShipClassID: id, ClassName: name, GameID: GAME, RaceID: RACE, CargoCapacity: 0, ColonistCapacity: 0, Size: 10, Crew: 100, MaxSpeed: 1000, EnginePower: 0, FuelEfficiency: 1, FuelCapacity: 0, MilitaryEngines: 0, PlannedDeployment: 12, MaintSupplies: 300, BaseFailureChance: 2, MaxDACRoll: 10, Commercial: 0, MoraleCheckRequired: 1, CommercialHangar: 0, SupplyShip: 0, ...extra })

// A ship of the race in fleet 5: 100 crew aboard, in no hangar and under no tow, maintenance state 0, its last overhaul 1.5 years and its last shore leave 6 months before the game time, a morale of 0.9 and 150 grade points (a 2% bonus).
const vessel = (id, name, shipClass, extra = {}) => ({ ShipID: id, GameID: GAME, RaceID: RACE, ShipName: name, FleetID: 5, ShipClassID: shipClass, CurrentCrew: 100, Fuel: 1000 + id, OverhaulFactor: 1, MaintenanceState: 0, MothershipID: 0, TractorTargetShipID: 0, TractorParentShipID: 0, TractorTargetShipyardID: 0, LastOverhaul: NOW - 1.5 * YEAR, LastShoreLeave: NOW - 6 * MONTH, GradePoints: 150, CrewMorale: 0.9, CurrentMaintSupplies: 40 + id, ...extra })

const CLASSES = [
  klass(10, 'Warship'),
  klass(11, 'Freighter', { Commercial: 1, MoraleCheckRequired: 0, PlannedDeployment: 0, Crew: 50 }),
  klass(12, 'Carrier'),
  klass(13, 'Hauler', { Commercial: 1, MoraleCheckRequired: 0, PlannedDeployment: 0, CommercialHangar: 1 }),
  klass(14, 'Tanker', { SupplyShip: 1 }),
  klass(15, 'Picket', { PlannedDeployment: 0 }),
  klass(20, 'Raider', { RaceID: FOE }),
]

const SHIPS = [
  vessel(1, 'Alpha', 10),
  vessel(2, 'Bravo', 10, { MaintenanceState: 2 }),
  vessel(3, 'Charlie', 10, { MothershipID: 5, CurrentCrew: 5, LastOverhaul: NOW - 2.5 * YEAR, LastShoreLeave: NOW - 25.58 * MONTH }),
  vessel(4, 'Delta', 10, { TractorParentShipID: 1 }),
  vessel(5, 'Eagle', 12),
  vessel(6, 'Fox', 10, { MothershipID: 7 }),
  vessel(7, 'Golf', 13),
  vessel(8, 'Hotel', 11, { CurrentCrew: 50 }),
  vessel(9, 'India', 10),
  vessel(10, 'Juliet', 14),
  vessel(11, 'Kilo', 10, { MothershipID: 5, TractorParentShipID: 1 }),
  vessel(12, 'Lima', 10, { CurrentCrew: 8 }),
  vessel(13, 'Mike', 10, { CurrentCrew: 10 }),
  vessel(14, 'November', 10, { GradePoints: 156.25, CrewMorale: 1 }),
  vessel(15, 'Oscar', 15),
  vessel(16, 'Captured', 20),
  vessel(50, 'Hostile', 10, { RaceID: FOE, FleetID: 6 }),
  vessel(51, 'Foe', 20, { RaceID: FOE, FleetID: 6 }),
  vessel(60, 'Elsewhere', 10, { GameID: 2 }),
]

// Warship parts: armour to a chance-to-hit of 4 costing 10 and a hull part to 10 costing 20, so a failure costs 10 x 0.4 + 20 x 0.6 = 16 MSP. Ship 9 has engineering damaged (component 200, DIM_ComponentType 31).
const world = ({ old = false, v26 = false, noHit = false, edits = '' } = {}) => `${insert('FCT_Game', [{ GameID: GAME, GameTime: NOW, ...(old ? {} : { NoOverhauls: 0 }), ...(old || v26 ? {} : { AllowCMC: 1, AncientRelics: 1 }) }, { GameID: 2, GameTime: 5, ...(old ? {} : { NoOverhauls: 0 }), ...(old || v26 ? {} : { AllowCMC: 1, AncientRelics: 1 }) }])}
  ${insert('FCT_Race', [{ RaceID: RACE, ...(old ? {} : { GameID: GAME, NPR: 0 }), CargoShuttleLoadModifier: 1.5 }, { RaceID: FOE, ...(old ? {} : { GameID: GAME, NPR: 0 }), CargoShuttleLoadModifier: 1.5 }])}
  ${insert('FCT_Fleet', [{ FleetID: 5, FleetName: 'Fleet', Speed: 500, UseMaximumSpeed: 1, ParentCommandID: 10, ShippingLine: 0, CycleMoves: 1 }, { FleetID: 6, FleetName: 'Raiders', Speed: 500, UseMaximumSpeed: 1, ParentCommandID: 11, ShippingLine: 0, CycleMoves: 1 }])}
  ${insert('FCT_ShipClass', CLASSES.map((row) => (old ? Object.fromEntries(Object.entries(row).filter(([key]) => !['PlannedDeployment', 'MaintSupplies', 'BaseFailureChance', 'MaxDACRoll', 'Commercial', 'MoraleCheckRequired', 'CommercialHangar', 'SupplyShip'].includes(key))) : row)))}
  ${insert('FCT_Ship', SHIPS.map((row) => (old ? Object.fromEntries(Object.entries(row).filter(([key]) => !['LastOverhaul', 'LastShoreLeave', 'GradePoints', 'CrewMorale', 'CurrentMaintSupplies'].includes(key))) : row)))}
  ${insert('FCT_ShipDesignComponents', [{ SDComponentID: 300, ComponentTypeID: 5, ComponentValue: 1, SpecialFunction: 0, Cost: 10 }, { SDComponentID: 301, ComponentTypeID: 5, ComponentValue: 1, SpecialFunction: 0, Cost: 20 }, { SDComponentID: 200, ComponentTypeID: 31, ComponentValue: 1, SpecialFunction: 0, Cost: 5 }])}
  ${insert('FCT_ClassComponent', [{ ClassID: 10, ComponentID: 300, NumComponent: 1, ChanceToHit: 4 }, { ClassID: 10, ComponentID: 301, NumComponent: 1, ChanceToHit: 10 }, { ClassID: 20, ComponentID: 300, NumComponent: 1, ChanceToHit: 5 }].map((row) => (old || noHit ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'ChanceToHit')) : row)))}
  ${insert('FCT_DamagedComponent', [{ ShipID: 9, GameID: GAME, ComponentID: 200, Number: 1 }])}
  ${edits}
`

const databaseOf = async (sql, { schema = SCHEMA() } = {}) => {
  const raw = new sqlite3.Database(':memory:')
  const exec = (text) => new Promise((resolve, reject) => raw.exec(text, (error) => (error ? reject(error) : resolve())))

  await exec(schema)
  await exec(sql)

  return {
    query: (text) => new Promise((resolve, reject) => raw.all(text, (error, found) => (error ? reject(error) : resolve([found])))),
    close: () => raw.close(),
  }
}

const newDatabase = (edits = '') => databaseOf(world({ edits }))

// The same save before ships had clocks, grade and morale, and classes a plan, a failure rate and the flags that decide how a clock runs: none of these columns is there at all.
const oldDatabase = () => databaseOf(world({ old: true }), { schema: SCHEMA({ old: true }) })

// The current save with the stamp of a game version other than 2.7 (FCT_Game lacks both columns the 2.7 shape has).
const oldVersionDatabase = () => databaseOf(world({ v26: true }), { schema: SCHEMA({ v26: true }) })

// The current save whose class components have no chance-to-hit column.
const noThresholdDatabase = () => databaseOf(world({ noHit: true }), { schema: SCHEMA({ noHit: true }) })

// A database whose queries wait for `release()`, to hold a read in flight while the scope changes.
const gated = async () => {
  const inner = await newDatabase()
  let open = null
  const waiting = new Promise((resolve) => {
    open = resolve
  })

  return { database: { query: async (text) => { await waiting; return inner.query(text) }, close: inner.close }, release: () => open() }
}

const byId = (projection) => Object.fromEntries(projection.ships.map((one) => [one.ShipID, one]))

// ---- The world: the module as shipped, or with edits planted -------------------------------------------------------------
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

  const modules = memo(() => loadUtilities(['ship-runtime', 'provenance'], { sources: { 'ship-runtime': text.runtime } }))

  return { text, modules, pairs: edits.length ? 'sample' : 'all' }
}

const read = async (w, database, extra = {}) => {
  const { 'ship-runtime': sr } = await w.modules()

  return sr.loadShipRuntime(database, { GameID: GAME, RaceID: RACE, generation: 3, ...extra })
}

// ---- The checks --------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('shape', 'a record per ship of the race, by ship, with its identity, the save revision, clocks, stocks, crew, class, support, maintenance and deployment, all frozen', async (w) => {
  const projection = await read(w, await newDatabase())
  const ships = byId(projection)

  assert.equal(projection.status, 'ok')
  assert.deepEqual(projection.ships.map((one) => one.ShipID), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 'the race\'s ships of the game, by ship')
  assert.deepEqual(projection.revision, { key: `3:${GAME}:${RACE}:${NOW}`, generation: 3, GameID: GAME, RaceID: RACE, gameTime: NOW })
  assert.ok(projection.ships.every((one) => one.revision === projection.revision), 'every record carries the same revision')
  assert.deepEqual(Object.keys(ships[1]).sort(), ['ClassName', 'FleetID', 'FleetName', 'ShipClassID', 'ShipID', 'ShipName', 'class', 'clocks', 'crew', 'deployment', 'maintenance', 'revision', 'stocks', 'support'])
  assert.deepEqual([ships[1].ShipName, ships[1].ClassName, ships[1].FleetName, ships[1].FleetID, ships[1].ShipClassID], ['Alpha', 'Warship', 'Fleet', 5, 10])
  assert.equal(ships[1].clocks.gameTime.value, NOW)
  assert.equal(ships[1].clocks.lastOverhaul.value, NOW - 1.5 * YEAR)
  assert.equal(ships[1].clocks.lastShoreLeave.value, NOW - 6 * MONTH)
  assert.equal(ships[1].stocks.maintSupplies.value, 41)
  assert.equal(ships[1].stocks.fuel.value, 1001)
  assert.deepEqual([ships[1].crew.current.value, ships[1].crew.required.value, ships[1].crew.fraction.value, ships[1].crew.morale.value, ships[1].crew.grade.value], [100, 100, 1, 0.9, 150])

  const frozen = (value, where) => {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value), `${where} is not frozen`)
      Object.entries(value).forEach(([key, inner]) => frozen(inner, `${where}.${key}`))
    }
  }

  frozen(projection, 'the projection')
  assert.equal(Reflect.set(ships[1].support, 'case', 'normal'), false, 'a record cannot be changed')
})

check('provenance', 'observed figures are confirmed, the rates calculated from them are estimates under their own rules, the class\'s life is on the class and a missing input is unavailable with no value', async (w) => {
  const { provenance } = await w.modules()
  const ship = byId(await read(w, await newDatabase()))[1]

  assert.equal(ship.clocks.lastOverhaul.status, 'confirmed')
  assert.equal(ship.clocks.lastOverhaul.rule.id, 'shipRuntime.observed')
  assert.equal(ship.stocks.fuel.status, 'confirmed')
  assert.equal(ship.crew.morale.status, 'confirmed')
  assert.equal(ship.class.plannedMonths.status, 'confirmed')
  assert.equal(ship.class.failureRate.status, 'confirmed', 'the class\'s stored rate is observed')

  const rates = { age: ship.maintenance.age, failureRate: ship.maintenance.failureRate, failureNow: ship.maintenance.failureNow, supplyDraw: ship.maintenance.supplyDraw, performance: ship.crew.performance, deploymentAge: ship.deployment.age, margin: ship.deployment.margin, recovery: ship.deployment.recovery }

  Object.entries(rates).forEach(([name, result]) => {
    assert.equal(result.status, 'estimated', name)
    assert.notEqual(result.rule.id, 'shipRuntime.observed', `${name} is not an observation`)
    assert.ok(result.rule.id.startsWith('shipRuntime.'), name)
    assert.ok(provenance.getRule(result.rule.id), `${name}: the rule is registered`)
  })

  assert.equal(ship.class.repairCost.rule.id, 'design.averageRepairCost')
  assert.equal(ship.class.life.rule.id, 'design.maintenanceLifeSeries')
  assert.equal(ship.class.life.status, 'estimated')
  assert.ok(!('life' in ship.maintenance) && !('life' in ship.deployment), 'the class\'s life is not a ship\'s figure')
  assert.notDeepEqual(ship.class.life.value, ship.maintenance.failureNow.value)

  const unknown = byId(await read(w, await newDatabase()))[9].maintenance.failureRate

  assert.equal(unknown.status, 'unavailable')
  assert.equal(unknown.value, null)
  assert.ok(unknown.inputs.missing.length > 0, 'it names what is missing')
})

check('rates', 'the clocks, the age, the failure rate at the present clock, the supply draw and the crew performance are the ones AE-106-01 works out from what the save holds', async (w) => {
  const ship = byId(await read(w, await newDatabase()))[1]

  near(ship.maintenance.age.value, 1.5, 'age in years')
  assert.equal(ship.maintenance.failureRate.value, 2)
  near(ship.maintenance.failureNow.value, 3)
  near(ship.class.repairCost.value, 16)
  near(ship.maintenance.supplyDraw.value, 0.48)
  near(ship.crew.performance.value, 1.02 * 0.9)
  near(ship.deployment.age.value, 6, 'deployment age in months')
  near(ship.deployment.planned.value, 12)
  near(ship.deployment.margin.value, 6)
  assert.equal(ship.deployment.overdue, false)
  assert.equal(ship.deployment.mode, 'checked')
  assert.equal(ship.maintenance.clockMode, 'support')
  assert.equal(ship.maintenance.ageRate.status, 'unavailable', 'the age rate outside a hangar needs the maintenance support, which is not read')
  assert.ok(ship.maintenance.ageRate.inputs.missing.length > 0)
  assert.equal(ship.class.life.status, 'estimated')
  assert.equal(typeof ship.class.life.value.life, 'number')

  // A grade whose bonus lands on a half rounds to the even percent, as the game does: sqrt(156.25) - 10 = 2.5 is 2.
  near(byId(await read(w, await newDatabase()))[14].crew.performance.value, 1.02)
  // Ship 3 recovers by its own saved clock, never a value made for it.
  assert.equal(byId(await read(w, await newDatabase()))[3].maintenance.age.status, 'estimated')
})

check('increment', 'the chance of a failure in one increment is given for a ship a maintenance pass tests (outside a hangar, under overhaul, or carried in a commercial hangar), from the caller\'s scenario, and is unavailable without it, for a ship in a military hangar, under tow or of unknown support', async (w) => {
  const scenario = { elapsedYears: 0.01, uncoveredFraction: 1, engineeringBonus: 1, training: false }
  const ships = byId(await read(w, await newDatabase(), { scenario }))
  const bare = byId(await read(w, await newDatabase()))
  const expected = 0.01 * (2 * 1.5) * 1 * (2 - 1.02 * 0.9) * (2 - 1)

  near(ships[1].maintenance.incrementChance.value, expected, 'a ship outside a hangar')
  assert.equal(ships[1].maintenance.incrementChance.rule.id, 'design.incrementFailureChance')
  assert.ok(ships[2].maintenance.incrementChance.value > 0, 'a ship under overhaul')
  assert.equal(bare[1].maintenance.incrementChance.status, 'unavailable', 'no scenario, no chance')
  assert.equal(ships[6].support.case, 'hangared')
  assert.equal(ships[6].maintenance.clockMode, 'support')
  near(ships[6].maintenance.incrementChance.value, expected, 'a ship carried in a commercial hangar follows the ordinary maintenance pass')
  assert.equal(ships[6].maintenance.incrementChance.rule.id, 'design.incrementFailureChance')
  assert.equal(bare[6].maintenance.incrementChance.status, 'unavailable', 'a carried ship has no chance without the caller\'s scenario either')
  ;[3, 4, 7, 8, 10, 11].forEach((id) => assert.equal(ships[id].maintenance.incrementChance.status, 'unavailable', `ship ${id}`))
  assert.ok(ships[3].maintenance.incrementChance.inputs.missing[0].includes('military hangar'), 'a ship in a military hangar is named as such')

  const asked = async (edits) => byId(await read(w, await newDatabase(edits), { scenario }))

  assert.equal((await asked('update FCT_ShipClass set CommercialHangar = 0 where ShipClassID = 13;'))[6].maintenance.incrementChance.status, 'unavailable', 'the carrier\'s hangar is a military one')
  assert.equal((await asked('update FCT_ShipClass set CommercialHangar = null where ShipClassID = 13;'))[6].maintenance.incrementChance.status, 'unavailable', 'the carrier\'s hangar kind is not in the save')
  assert.equal((await asked('update FCT_Ship set MothershipID = null where ShipID = 6;'))[6].maintenance.incrementChance.status, 'unavailable', 'the hangar link is not in the save')
  assert.equal((await asked('update FCT_Ship set TractorParentShipID = 1 where ShipID = 6;'))[6].maintenance.incrementChance.status, 'unavailable', 'a ship both carried and under tow')
  assert.equal((await asked('update FCT_ShipClass set Commercial = 1 where ShipClassID = 10;'))[6].maintenance.incrementChance.status, 'unavailable', 'a commercial class has its clock reset')
  assert.equal((await asked('update FCT_ShipClass set SupplyShip = 1 where ShipClassID = 10;'))[6].maintenance.incrementChance.status, 'unavailable', 'a supply ship follows its cluster')
  assert.equal((await asked('update FCT_Game set NoOverhauls = 1;'))[6].maintenance.incrementChance.status, 'unavailable', 'a game without overhauls')
  assert.equal((await asked('update FCT_Race set NPR = 1;'))[6].maintenance.incrementChance.status, 'unavailable', 'a race that is not played')
  near((await asked('update FCT_Ship set MaintenanceState = 2 where ShipID = 6;'))[6].maintenance.incrementChance.value, expected, 'a carried ship the save marks under overhaul')
})

check('two-callers', 'two callers asking for the same classes get identical records, whatever the order of the ids, of the rows and of the database copy', async (w) => {
  const { 'ship-runtime': sr } = await w.modules()
  const first = await read(w, await newDatabase(), { classIds: [10, 11, 12] })
  const second = await read(w, await newDatabase(), { classIds: [12, 10, 11, 10] })
  const third = await read(w, await newDatabase(), { classIds: [11, 12, 10] })

  assert.ok(first.ships.length > 3)
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)))
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(third)))
  assert.deepEqual(first.revision, second.revision)

  // The projection of one class is the same records as that class in the projection of all of them.
  const all = byId(await read(w, await newDatabase()))
  const one = await read(w, await newDatabase(), { classIds: [10] })

  one.ships.forEach((ship) => assert.deepEqual(JSON.parse(JSON.stringify(ship)), JSON.parse(JSON.stringify(all[ship.ShipID]))))

  // The same rows give the same records in any order.
  const context = { revision: first.revision, gameTime: NOW, npr: false, noOverhauls: false, classes: {}, scenario: {} }
  const rows = first.ships.map((ship) => ({ ShipID: ship.ShipID, ShipName: ship.ShipName, ShipClassID: ship.ShipClassID, ClassName: ship.ClassName, FleetID: ship.FleetID, FleetName: ship.FleetName, CurrentCrew: 100, ClassCrew: 100 }))

  assert.deepEqual(sr.buildShipRuntime(rows, context).map((ship) => ship.ShipID), sr.buildShipRuntime([...rows].reverse(), context).map((ship) => ship.ShipID))
})

check('stale', 'a read that finishes after the game, race, save copy or database changed, after a later read or after a cancel is stale and carries no ship', async (w) => {
  const { 'ship-runtime': sr } = await w.modules()
  const scope = { database: null, GameID: GAME, RaceID: RACE, generation: 1 }
  const reader = sr.createRuntimeReader(() => scope)
  const inFlight = async (change) => {
    const { database, release } = await gated()

    scope.database = database
    scope.GameID = GAME
    scope.RaceID = RACE
    scope.generation = 1

    const pending = reader.read()

    await change(release)

    return pending
  }

  const ok = await inFlight(async (release) => release())

  assert.equal(ok.status, 'ok')
  assert.ok(ok.ships.length > 0)
  assert.ok(sr.isCurrentRuntime(ok, { GameID: GAME, RaceID: RACE, generation: 1 }))
  assert.ok(!sr.isCurrentRuntime(ok, { GameID: GAME, RaceID: RACE, generation: 2 }), 'another save copy')
  assert.ok(!sr.isCurrentRuntime(ok, { GameID: 9, RaceID: RACE, generation: 1 }), 'another game')
  assert.ok(!sr.isCurrentRuntime(ok, { GameID: GAME, RaceID: 3, generation: 1 }), 'another race')

  const staleOf = async (what, change) => {
    const result = await inFlight(async (release) => {
      change()
      release()
    })

    assert.equal(result.status, 'stale', what)
    assert.deepEqual(result.ships, [], `${what}: no ship`)
    assert.equal(result.revision, null, `${what}: no revision`)
  }

  await staleOf('the game changed', () => { scope.GameID = 2 })
  await staleOf('the race changed', () => { scope.RaceID = 3 })
  await staleOf('the save copy changed', () => { scope.generation = 2 })
  await staleOf('another database was opened', () => { scope.database = { query: async () => [[]] } })
  await staleOf('the read was cancelled', () => reader.cancel())

  // A later read makes the earlier one stale and is itself the answer.
  const { database, release } = await gated()

  scope.database = database
  scope.GameID = GAME
  scope.RaceID = RACE
  scope.generation = 1

  const earlier = reader.read()
  const later = reader.read({ classIds: [10] })

  release()
  assert.equal((await earlier).status, 'stale', 'the earlier read')
  assert.equal((await later).status, 'ok', 'the later read')
  assert.ok((await later).ships.every((ship) => ship.ShipClassID === 10))

  // No scope gives no projection.
  scope.database = null
  assert.equal((await reader.read()).status, 'none')
  scope.database = await newDatabase()
  scope.RaceID = 0
  assert.equal((await reader.read()).status, 'none')
})

check('scope', 'another race\'s ship is never read, in the selected class or its own, and a class that is not the race\'s own is rejected, whatever the caller asks for', async (w) => {
  const all = await read(w, await newDatabase())

  assert.ok(!all.ships.some((ship) => [50, 51, 60].includes(ship.ShipID)), 'no ship of another race or game')
  assert.deepEqual(all.rejected, [])
  assert.equal(all.ships.find((ship) => ship.ShipID === 16).class.repairCost.status, 'unavailable', 'a ship of the race in a class of another race has no cost of its own')

  const asked = await read(w, await newDatabase(), { classIds: [10, 20] })

  assert.deepEqual(asked.rejected, [20])
  assert.ok(asked.ships.length > 0 && asked.ships.every((ship) => ship.ShipClassID === 10), 'only the class that is the race\'s own')
  assert.ok(!asked.ships.some((ship) => ship.ShipID === 50), 'a ship of another race in the selected class is not joined through it')

  const foreign = await read(w, await newDatabase(), { classIds: [20] })

  assert.deepEqual(foreign.rejected, [20])
  assert.deepEqual(foreign.ships, [])
  assert.equal(foreign.status, 'ok')

  const other = await read(w, await newDatabase(), { RaceID: FOE })

  assert.deepEqual(other.ships.map((ship) => ship.ShipID), [50, 51], 'the other race, read as its own, sees only its ships')
  assert.deepEqual(other.ships.find((ship) => ship.ShipID === 50).class.repairCost.status, 'unavailable', 'a class of the race\'s own it does not have gives no cost')
})

check('carrier-links', 'a carried ship keeps its carrier\'s id, the carrier\'s hangar kind and fleet and the tow links, so the ships of one fleet group under their own carriers with no second read, and a link the save leaves out is null, never none or a military hangar', async (w) => {
  const grouping = 'update FCT_Ship set MothershipID = 7 where ShipID = 12; update FCT_Ship set MothershipID = 5 where ShipID = 13; update FCT_Ship set TractorTargetShipID = 4 where ShipID = 1;'
  const ships = byId(await read(w, await newDatabase(grouping)))
  const carried = Object.values(ships).filter((ship) => ship.FleetID === 5 && ship.support.mothershipId > 0)
  const byCarrier = {}

  carried.forEach((ship) => {
    byCarrier[ship.support.mothershipId] = [...(byCarrier[ship.support.mothershipId] || []), ship.ShipID]
  })

  assert.deepEqual(byCarrier, { 5: [3, 11, 13], 7: [6, 12] }, 'two carriers in one fleet, each with its own ships')
  ;[3, 11, 13].forEach((id) => assert.deepEqual([ships[id].support.carrierCommercialHangar, ships[id].support.carrierFleetId, ships[id].support.hangared], [false, 5, true], `ship ${id} in a military hangar`))
  ;[6, 12].forEach((id) => assert.deepEqual([ships[id].support.carrierCommercialHangar, ships[id].support.carrierFleetId, ships[id].support.hangared], [true, 5, true], `ship ${id} in a commercial hangar`))
  assert.deepEqual([ships[1].support.mothershipId, ships[1].support.carrierCommercialHangar, ships[1].support.carrierFleetId, ships[1].support.hangared], [0, null, null, false], 'a ship in no hangar has no carrier, which is not an unread one')
  assert.deepEqual([ships[5].support.mothershipId, ships[5].support.carrierCommercialHangar], [0, null], 'a carrier is in no hangar itself')
  assert.deepEqual([ships[1].support.tractorParentShipId, ships[1].support.tractorTargetShipId], [0, 4], 'the ship that tows')
  assert.deepEqual([ships[4].support.tractorParentShipId, ships[4].support.tractorTargetShipId, ships[4].support.towed], [1, 0, true], 'the ship under tow')
  assert.deepEqual([ships[11].support.mothershipId, ships[11].support.tractorParentShipId], [5, 1], 'a ship both carried and under tow keeps both links')

  const unread = byId(await read(w, await newDatabase('update FCT_Ship set MothershipID = null where ShipID in (1, 3); update FCT_Ship set TractorTargetShipID = null where ShipID = 1; update FCT_ShipClass set CommercialHangar = null where ShipClassID = 13;')))

  assert.deepEqual([unread[1].support.mothershipId, unread[1].support.hangared, unread[1].support.carrierCommercialHangar, unread[1].support.tractorTargetShipId], [null, null, null, null], 'a link the save leaves empty is not none')
  assert.deepEqual([unread[3].support.mothershipId, unread[3].support.carrierCommercialHangar], [null, null])
  assert.deepEqual([unread[6].support.mothershipId, unread[6].support.carrierCommercialHangar, unread[6].support.carrierFleetId], [7, null, 5], 'a hangar kind the carrier\'s class leaves empty is not a military hangar')
  assert.deepEqual([unread[11].support.mothershipId, unread[11].support.carrierCommercialHangar], [5, false], 'the other carrier keeps its own kind')

  const without = await read(w, await newDatabase('alter table FCT_Ship drop column MothershipID; alter table FCT_Ship drop column TractorTargetShipID;'))

  assert.equal(without.ships.length, 16, 'a save without the link columns still gives every ship')
  assert.ok(without.ships.every((ship) => ship.support.mothershipId === null && ship.support.carrierCommercialHangar === null && ship.support.carrierFleetId === null && ship.support.tractorTargetShipId === null), 'no link is made up for a column the save lacks')
  assert.ok(without.ships.every((ship) => ship.support.case === 'unknown'), 'a ship whose hangar link is not in the save is of unknown support')
})

check('old-schema', 'a save that lacks the clocks, grade, morale and class flags reads each as unknown, so no rate is given and nothing is 0', async (w) => {
  const projection = await read(w, await oldDatabase())
  const ships = byId(projection)

  assert.equal(projection.status, 'ok')
  assert.ok(projection.ships.length > 0)
  assert.equal(projection.revision.gameTime, NOW, 'the game time is there')

  projection.ships.forEach((ship) => {
    ;[ship.clocks.lastOverhaul, ship.clocks.lastShoreLeave, ship.stocks.maintSupplies, ship.crew.morale, ship.crew.grade, ship.crew.performance, ship.maintenance.age, ship.maintenance.failureRate, ship.maintenance.failureNow, ship.maintenance.supplyDraw, ship.deployment.age, ship.deployment.margin, ship.deployment.recovery, ship.class.plannedMonths, ship.class.failureRate, ship.class.maintSupplies].forEach((result, index) => {
      assert.equal(result.status, 'unavailable', `ship ${ship.ShipID} figure ${index}`)
      assert.equal(result.value, null, `ship ${ship.ShipID} figure ${index}`)
    })

    assert.equal(ship.maintenance.clockMode, 'unknown', `ship ${ship.ShipID}: the game and the race do not say how clocks run`)
    assert.equal(ship.deployment.mode, 'unknown')
    assert.equal(ship.maintenance.ageRate.status, 'unavailable')
    assert.equal(ship.deployment.overdue, null)
    assert.ok(ship.maintenance.clockReason.length > 0)
  })

  assert.equal(ships[1].stocks.fuel.value, 1001, 'what the old save has is still read')
  assert.equal(ships[1].class.commercial, null, 'a class flag the save lacks is unknown')
  assert.equal(ships[1].class.life.status, 'unavailable')
})

check('old-schema-thresholds', 'a save whose class components have no chance-to-hit column still loads, with the repair cost and the class life unavailable and every other figure as read', async (w) => {
  const projection = await read(w, await noThresholdDatabase())
  const ships = byId(projection)

  assert.equal(projection.status, 'ok')
  assert.equal(projection.ships.length, 16, 'every ship of the race is read')
  assert.equal(ships[1].class.repairCost.status, 'unavailable')
  assert.equal(ships[1].class.repairCost.value, null)
  assert.equal(ships[1].class.life.status, 'unavailable')
  assert.equal(ships[1].maintenance.supplyDraw.status, 'unavailable')
  assert.equal(ships[1].maintenance.failureNow.status, 'estimated', 'the rate that needs no cost is still worked out')
  assert.equal(ships[1].class.failureRate.value, 2)
  assert.equal(ships[1].clocks.lastOverhaul.value, NOW - 1.5 * YEAR)
})

check('support-cases', 'the support case is normal, overhaul, hangared or towed from the links and the state, and anything the save or the rules do not settle is unknown with a reason', async (w) => {
  const ships = byId(await read(w, await newDatabase()))
  const cases = Object.fromEntries(Object.entries(ships).map(([id, ship]) => [id, ship.support.case]))

  assert.deepEqual([cases[1], cases[2], cases[3], cases[4], cases[5], cases[6], cases[11]], ['normal', 'overhaul', 'hangared', 'towed', 'normal', 'hangared', 'unknown'])
  assert.ok(ships[11].support.reason.length > 0, 'both in a hangar and under tow')
  assert.equal(ships[3].support.hangared, true)
  assert.equal(ships[4].support.towed, true)
  assert.equal(ships[4].maintenance.ageRate.status, 'unavailable', 'a ship under tow')
  assert.ok(ships[4].support.conditions.some((one) => one.code === 'tow-maintenance'))
  assert.equal(ships[4].maintenance.age.status, 'estimated', 'the clock is still shown as the save has it')

  const noLinks = byId(await read(w, await newDatabase('update FCT_Ship set MothershipID = null where ShipID = 1; update FCT_Ship set MaintenanceState = null where ShipID = 5; update FCT_Ship set MaintenanceState = 7 where ShipID = 12;')))

  assert.equal(noLinks[1].support.case, 'unknown', 'a hangar link the save leaves empty is not none')
  assert.equal(noLinks[5].support.case, 'unknown', 'a state the save leaves empty')
  assert.equal(noLinks[12].support.case, 'unknown', 'a state the rules do not settle')
  ;[1, 5, 12].forEach((id) => assert.ok(noLinks[id].support.reason.length > 0, `ship ${id}`))
})

check('clock-modes', 'a clock is reset for a commercial class and an unplayed race, advanced by a military hangar, left to the cover at a location otherwise, and unknown for a supply ship or a game without overhauls', async (w) => {
  const ships = byId(await read(w, await newDatabase()))
  const modes = Object.fromEntries(Object.entries(ships).map(([id, ship]) => [id, ship.maintenance.clockMode]))

  assert.deepEqual([modes[1], modes[3], modes[6], modes[7], modes[8], modes[10]], ['support', 'advanced', 'support', 'reset', 'reset', 'supply'])
  assert.equal(ships[3].maintenance.ageRate.value, -4, 'a military hangar: the age falls four years a year')
  assert.equal(ships[7].maintenance.ageRate.value, 0, 'a commercial class: the age is held')
  assert.equal(ships[8].maintenance.ageRate.value, 0)
  assert.equal(ships[6].maintenance.ageRate.status, 'unavailable', 'a commercial hangar does not advance the clock')
  assert.equal(ships[10].maintenance.ageRate.status, 'unavailable', 'a supply ship follows its cluster')
  assert.ok(ships[10].maintenance.clockReason.length > 0)
  assert.equal(ships[3].support.clock.mode, 'advanced')

  const npr = byId(await read(w, await newDatabase('update FCT_Race set NPR = 1;')))

  assert.ok(npr[1].maintenance.clockMode === 'reset' && npr[10].maintenance.clockMode === 'reset' && npr[3].maintenance.clockMode === 'reset', 'an unplayed race: every clock set to now, before the supply and hangar cases')
  assert.equal(npr[3].maintenance.ageRate.value, 0)

  const none = byId(await read(w, await newDatabase('update FCT_Game set NoOverhauls = 1;')))

  assert.ok(Object.values(none).every((ship) => ship.maintenance.clockMode === 'unknown'), 'a game with overhauls off')
  assert.ok(Object.values(none).every((ship) => ship.maintenance.ageRate.status === 'unavailable'))

  const unsaid = byId(await read(w, await newDatabase('update FCT_Game set NoOverhauls = null;')))

  assert.equal(unsaid[1].maintenance.clockMode, 'unknown', 'a game that does not say is not taken as on')
  assert.equal(byId(await read(w, await newDatabase('update FCT_Race set NPR = null;')))[1].maintenance.clockMode, 'unknown', 'a race that does not say is not taken as played')
  assert.equal(byId(await read(w, await newDatabase('update FCT_ShipClass set CommercialHangar = null where ShipClassID = 13;')))[6].maintenance.clockMode, 'unknown', 'a carrier whose hangar kind is unstated')
  assert.equal(byId(await read(w, await newDatabase('update FCT_ShipClass set CommercialHangar = null where ShipClassID = 12;')))[3].maintenance.clockMode, 'unknown', 'a carrier whose hangar kind is unstated')
  assert.equal(byId(await read(w, await newDatabase('update FCT_ShipClass set Commercial = null where ShipClassID = 10;')))[1].maintenance.clockMode, 'unknown', 'a class that does not say whether it is commercial')
})

check('docked', 'a docked ship keeps the clocks and the morale the save gives it, with the saved age, the recovery mode beside it and no value held for it', async (w) => {
  const ship = byId(await read(w, await newDatabase()))[3]

  near(ship.maintenance.age.value, 2.5, 'the saved age is kept, not cleared by the hangar')
  near(ship.deployment.age.value, 25.58, 'the saved deployment age is kept')
  assert.equal(ship.clocks.lastShoreLeave.value, NOW - 25.58 * MONTH)
  assert.equal(ship.crew.morale.value, 0.9, 'morale as read')
  assert.equal(ship.deployment.mode, 'checked')
  near(ship.deployment.margin.value, 12 - 25.58)
  assert.equal(ship.deployment.overdue, true)
  assert.equal(ship.support.hangared, true)
  assert.deepEqual(ship.support.conditions.map((one) => one.code).filter((code) => code.startsWith('docked')), ['docked-clocks', 'docked-location'])
  assert.ok(ship.support.conditions.every((one) => one.text.length > 0))
  assert.ok(!JSON.stringify(ship).includes('"held"'), 'no held figure is made up')
})

check('recovery', 'at a shore-leave location the deployment age recovers by g less 1 a month, g being 10 times the crew share (at most 10) and 1 more for a docked ship: independent ships stall at a tenth of the crew, docked ones do not', async (w) => {
  const { provenance } = await w.modules()
  const ships = byId(await read(w, await newDatabase()))

  near(ships[1].deployment.recovery.value, 9, 'an independent ship at a full crew')
  near(ships[12].deployment.recovery.value, 10 * 0.08 - 1, 'an independent ship below a tenth of the crew: the age grows')
  assert.ok(ships[12].deployment.recovery.value < 0)
  assert.equal(ships[13].deployment.recovery.value, 0, 'an independent ship at a tenth of the crew: no recovery')
  near(ships[3].deployment.recovery.value, 0.5, 'a docked ship at a twentieth of the crew still recovers')
  near(ships[1].deployment.eta.value, 6 / 9, 'the months to recover under unchanged conditions')
  near(ships[3].deployment.eta.value, 25.58 / 0.5)
  assert.equal(ships[12].deployment.eta.status, 'unavailable', 'no ETA while the age grows')
  assert.equal(ships[13].deployment.eta.status, 'unavailable', 'no ETA at a stall')
  assert.ok(ships[12].deployment.eta.inputs.missing.length > 0)
  assert.ok(ships[1].deployment.recovery.assumptions.some((text) => /shore-leave location/.test(text)), 'the location is an assumption')

  for (const id of [1, 3]) {
    const eta = ships[id].deployment.eta

    assert.ok(eta.assumptions.some((text) => /shore-leave location/.test(text)), `ship ${id}: the ETA keeps the recovery's location assumption`)
    assert.ok(/shore-leave location/.test(provenance.describeResult(eta)), `ship ${id}: the words of the ETA name the location`)
    assert.ok(/shore-leave location/.test(provenance.exportFields(eta).assumptions), `ship ${id}: the export of the ETA names the location`)
    assert.ok(/do not change/.test(provenance.exportFields(eta).assumptions), `ship ${id}: the ETA's own assumption stays`)
    assert.ok(eta.inputs.present.some((text) => /hangar link/.test(text)), `ship ${id}: the ETA carries the recovery's inputs`)
  }

  const docked = byId(await read(w, await newDatabase('update FCT_Ship set MothershipID = 5, CurrentCrew = 10 where ShipID = 13;')))[13]

  near(docked.deployment.recovery.value, 1, 'a docked ship at a tenth of the crew recovers 1 month a month')
  near(byId(await read(w, await newDatabase('update FCT_Ship set CurrentCrew = 500 where ShipID = 1;')))[1].deployment.recovery.value, 9, 'the crew share is at most 1')
})

check('unread-hangar', 'a hangar link the save leaves empty gives no recovery and no ETA, at a tenth of the crew as at any other, never the independent rate', async (w) => {
  const unread = byId(await read(w, await newDatabase('update FCT_Ship set MothershipID = null where ShipID in (1, 13);')))
  const none = byId(await read(w, await newDatabase()))

  assert.equal(none[13].deployment.recovery.value, 0, 'the same ship with the link read as none is an independent ship that stalls')

  ;[1, 13].forEach((id) => {
    assert.equal(unread[id].support.case, 'unknown', `ship ${id}`)
    assert.equal(unread[id].deployment.recovery.status, 'unavailable', `ship ${id}: no recovery`)
    assert.equal(unread[id].deployment.recovery.value, null)
    assert.ok(unread[id].deployment.recovery.inputs.missing.some((text) => /hangar link/.test(text)), `ship ${id}: the missing link is named`)
    assert.equal(unread[id].deployment.eta.status, 'unavailable', `ship ${id}: no ETA`)
    assert.ok(unread[id].deployment.eta.inputs.missing.some((text) => /hangar link/.test(text)), `ship ${id}: the ETA names it too`)
  })

  assert.equal(unread[1].deployment.age.status, 'estimated', 'the saved clock is still shown')
})

check('class-selection', 'no class ids means every class of the race, an empty list means none, and an id that is not a whole number is rejected, not widened to every class', async (w) => {
  const all = await read(w, await newDatabase())
  const none = await read(w, await newDatabase(), { classIds: [] })
  const mixed = await read(w, await newDatabase(), { classIds: [10, 'x', 1.5] })

  assert.ok(all.ships.length > 10, 'null reads every class')
  assert.equal((await read(w, await newDatabase(), { classIds: null })).ships.length, all.ships.length)
  assert.equal(none.status, 'ok')
  assert.deepEqual(none.ships, [], 'an empty list reads no ship')
  assert.deepEqual(none.classes, {})
  assert.deepEqual(none.rejected, [])
  assert.deepEqual(none.revision, all.revision, 'the empty projection is tagged with the same revision')
  assert.deepEqual(none.formulaVersion, all.formulaVersion)
  assert.ok(mixed.ships.length > 0 && mixed.ships.every((ship) => ship.ShipClassID === 10), 'the whole-number id is read')
  assert.deepEqual(mixed.rejected, ['x', 1.5])
  await assert.rejects(() => read(w, null, { classIds: 10 }), TypeError)

  const { 'ship-runtime': sr } = await w.modules()
  const scope = { database: await newDatabase(), GameID: GAME, RaceID: RACE, generation: 1 }
  const reader = sr.createRuntimeReader(() => scope)

  assert.deepEqual((await reader.read({ classIds: [] })).ships, [], 'the reader passes an empty list through')
  assert.ok((await reader.read()).ships.length > 10)
})

check('version', 'the hangar clock and the shore-leave recovery are given for a 2.7-shaped save only, while the observed clocks and stocks and the other rates stay', async (w) => {
  const current = await read(w, await newDatabase())
  const old = await read(w, await oldVersionDatabase())
  const ships = byId(old)
  const now = byId(current)

  assert.equal(current.formulaVersion, '2.7.x')
  assert.equal(old.formulaVersion, null, 'a save without the 2.7 columns has no version')
  assert.equal(now[1].deployment.recovery.status, 'estimated')
  assert.equal(now[3].maintenance.clockMode, 'advanced')

  ;[1, 3, 13].forEach((id) => {
    assert.equal(ships[id].deployment.recovery.status, 'unavailable', `ship ${id}: no recovery`)
    assert.ok(ships[id].deployment.recovery.inputs.missing.some((text) => /game version 2\.7/.test(text)), `ship ${id}: the version is named`)
    assert.equal(ships[id].deployment.eta.status, 'unavailable', `ship ${id}: no ETA`)
  })

  assert.equal(ships[3].maintenance.clockMode, 'unknown', 'the hangar clock of a carried ship')
  assert.equal(ships[3].maintenance.ageRate.status, 'unavailable')
  assert.ok(ships[3].maintenance.clockReason.includes('game version 2.7'))
  assert.equal(ships[3].maintenance.incrementChance.status, 'unavailable')

  // What the save states stays as read, and what does not depend on the version is still worked out.
  assert.deepEqual(ships[3].clocks.lastOverhaul, now[3].clocks.lastOverhaul)
  assert.deepEqual(ships[3].clocks.lastShoreLeave, now[3].clocks.lastShoreLeave)
  assert.deepEqual(ships[3].stocks, now[3].stocks)
  assert.deepEqual(ships[1].crew, now[1].crew)
  assert.deepEqual(ships[1].maintenance.failureNow, now[1].maintenance.failureNow)
  assert.deepEqual(ships[3].maintenance.age, now[3].maintenance.age)
  assert.deepEqual(ships[1].deployment.margin, now[1].deployment.margin)
  assert.equal(ships[1].maintenance.clockMode, 'support')

  // A ship carried in a commercial hangar is given the ordinary path for a 2.7 save only, the same as one in a military hangar.
  const scenario = { elapsedYears: 0.01, uncoveredFraction: 1, engineeringBonus: 1, training: false }
  const carried = byId(await read(w, await oldVersionDatabase(), { scenario }))

  assert.equal(carried[6].support.case, 'hangared')
  assert.equal(carried[6].maintenance.clockMode, 'unknown', 'a commercial hangar of a save not shown to be 2.7')
  assert.equal(carried[6].maintenance.incrementChance.status, 'unavailable')
  assert.ok(carried[6].maintenance.incrementChance.inputs.missing.some((text) => /game version 2\.7/.test(text)), 'the version is named')
  assert.equal(carried[1].maintenance.incrementChance.status, 'estimated', 'a ship outside a hangar does not depend on the hangar rules')
  assert.ok(byId(await read(w, await newDatabase(), { scenario }))[6].maintenance.incrementChance.value > 0, 'the 2.7 commercial hangar case is kept')
})

check('shipyard-tasks', 'a ship in a shipyard task that is not paused is out of maintenance and failure testing (it has no increment failure chance and says why), a paused task or none leaves it ordinary, and a task the save does not show leaves the ship unknown, never ordinary', async (w) => {
  const scenario = { elapsedYears: 0.01, uncoveredFraction: 1, engineeringBonus: 1, training: false }
  const expected = 0.01 * (2 * 1.5) * 1 * (2 - 1.02 * 0.9) * (2 - 1)
  const tasks = 'insert into FCT_ShipyardTask (TaskID, GameID, RaceID, ShipID, Paused) values (1, 1, 2, 1, 0), (2, 1, 2, 2, 1), (3, 1, 2, 12, 0), (4, 1, 2, 12, 1), (5, 1, 2, 13, 1), (6, 1, 2, 13, 0), (7, 2, 2, 14, 0), (8, 1, 2, 0, 0), (9, 1, 2, 15, null), (10, 1, 2, 6, 0);'
  const asked = async (edits) => byId(await read(w, await newDatabase(edits), { scenario }))
  const ships = await asked(tasks)
  const none = await asked('')

  assert.equal(none[1].support.yardTask, 'none')
  near(none[1].maintenance.incrementChance.value, expected, 'no task')

  assert.equal(ships[1].support.yardTask, 'active')
  assert.equal(ships[1].maintenance.clockMode, 'yard')
  assert.equal(ships[1].maintenance.incrementChance.status, 'unavailable', 'a ship in an active task is not tested for failure')
  assert.equal(ships[1].maintenance.incrementChance.value, null)
  assert.ok(ships[1].maintenance.incrementChance.inputs.missing.some((text) => /shipyard task/.test(text)), 'the reason names the task')
  assert.ok(/shipyard task/.test(ships[1].maintenance.clockReason))
  assert.equal(ships[1].maintenance.ageRate.status, 'estimated', 'the age of a ship in an active task is known to stay as it is')
  assert.equal(ships[1].maintenance.ageRate.value, 0)
  assert.equal(ships[1].maintenance.ageRate.rule.id, 'shipRuntime.yardAgeRate')
  assert.ok(ships[1].maintenance.ageRate.inputs.present.some((text) => /shipyard task/.test(text)))
  assert.ok(ships[1].maintenance.ageRate.assumptions.length > 0 && ships[1].maintenance.ageRate.assumptions.every((text) => !/no yard task/.test(text)), 'the rate does not assume no yard task')
  assert.equal(ships[6].maintenance.ageRate.value, 0, 'a carried ship in a task')
  assert.equal(ships[2].maintenance.ageRate.status, 'unavailable', 'a paused task leaves the ordinary case, whose rate needs the support at the location')
  near(ships[1].maintenance.age.value, 1.5, 'the saved age is still shown')
  assert.equal(ships[2].support.yardTask, 'paused')
  assert.equal(ships[2].maintenance.clockMode, 'support', 'a paused task leaves the ship in maintenance')
  near(ships[2].maintenance.incrementChance.value, expected, 'a ship with a paused task')
  assert.deepEqual([ships[12].support.yardTask, ships[13].support.yardTask], ['active', 'active'], 'one active task among others holds the ship, in either order')
  assert.deepEqual([ships[12].maintenance.incrementChance.status, ships[13].maintenance.incrementChance.status], ['unavailable', 'unavailable'])
  assert.equal(ships[6].support.yardTask, 'active', 'a carried ship in a task')
  assert.equal(ships[6].maintenance.incrementChance.status, 'unavailable')
  assert.equal(ships[14].support.yardTask, 'none', 'a task of the same ship id in another game')
  near(ships[14].maintenance.incrementChance.value, none[14].maintenance.incrementChance.value, 'the other game\'s task does not count')
  assert.equal(ships[5].support.yardTask, 'none', 'a task that names no ship')
  assert.equal(ships[15].support.yardTask, null, 'a task whose pause flag is empty is not known')
  assert.equal(ships[15].maintenance.clockMode, 'unknown')
  assert.equal(ships[15].maintenance.incrementChance.status, 'unavailable')

  const npr = byId(await read(w, await newDatabase(`${tasks} update FCT_Race set NPR = 1;`)))

  assert.equal(npr[1].maintenance.clockMode, 'yard', 'the task is taken before the race that is not played')
  assert.equal(npr[5].maintenance.clockMode, 'reset')

  for (const edit of ['drop table FCT_ShipyardTask;', 'alter table FCT_ShipyardTask drop column Paused;', 'alter table FCT_ShipyardTask drop column ShipID;']) {
    const unread = await read(w, await newDatabase(edit), { scenario })

    assert.equal(unread.ships.length, 16, `${edit}: every ship is still given`)
    assert.ok(unread.ships.every((ship) => ship.support.yardTask === null && ship.maintenance.clockMode === 'unknown' && ship.maintenance.incrementChance.status === 'unavailable'), `${edit}: no ship is taken as outside the tasks`)
    assert.ok(unread.ships.every((ship) => ship.maintenance.ageRate.status === 'unavailable'), `${edit}: no age rate is given for a ship whose task is not known`)
    assert.ok(unread.ships.filter((ship) => ['normal', 'overhaul', 'hangared'].includes(ship.support.case)).every((ship) => ship.maintenance.incrementChance.inputs.missing.some((text) => /shipyard task/.test(text))), `${edit}: the reason names the task`)
    assert.equal(unread.ships[0].clocks.lastOverhaul.status, 'confirmed', `${edit}: the stored clocks are as read`)
  }
})

check('deployment-modes', 'a class with no deployment check or a plan of 0, and a race that is not played, have no margin, no overdue and no recovery; a figure the save leaves out is unknown', async (w) => {
  const ships = byId(await read(w, await newDatabase()))

  assert.equal(ships[7].deployment.mode, 'exempt')
  assert.equal(ships[15].deployment.mode, 'exempt', 'a plan of 0')
  ;[7, 8, 15].forEach((id) => {
    assert.equal(ships[id].deployment.margin.status, 'unavailable', `ship ${id}`)
    assert.equal(ships[id].deployment.overdue, null, `ship ${id}`)
    assert.equal(ships[id].deployment.recovery.status, 'unavailable', `ship ${id}`)
    assert.ok(ships[id].deployment.reason.length > 0)
    assert.equal(ships[id].deployment.age.status, 'estimated', 'the saved clock is still shown')
  })

  const npr = byId(await read(w, await newDatabase('update FCT_Race set NPR = 1;')))

  assert.equal(npr[1].deployment.mode, 'reset')
  assert.equal(npr[1].deployment.margin.status, 'unavailable')
  assert.equal(byId(await read(w, await newDatabase('update FCT_Race set NPR = null;')))[1].deployment.mode, 'unknown')
  assert.equal(byId(await read(w, await newDatabase('update FCT_ShipClass set MoraleCheckRequired = null where ShipClassID = 10;')))[1].deployment.mode, 'unknown')
  assert.equal(byId(await read(w, await newDatabase('update FCT_ShipClass set PlannedDeployment = null where ShipClassID = 10;')))[1].deployment.mode, 'unknown')
  assert.equal(byId(await read(w, await newDatabase('update FCT_Ship set CurrentCrew = null where ShipID = 1;')))[1].deployment.recovery.status, 'unavailable')
})

check('engineering', 'a ship with engineering damaged has no failure rate of its own, a ship with the damage unstated has none either, and the class\'s planning estimate is unchanged', async (w) => {
  const ships = byId(await read(w, await newDatabase()))

  assert.equal(ships[9].maintenance.failureRate.status, 'unavailable')
  assert.equal(ships[9].maintenance.failureNow.status, 'unavailable')
  assert.equal(ships[9].maintenance.supplyDraw.status, 'unavailable')
  assert.equal(ships[9].maintenance.incrementChance.status, 'unavailable')
  assert.deepEqual(ships[9].class.life.value, ships[1].class.life.value, 'the class\'s estimate is a class\'s, not the ship\'s')
  assert.equal(ships[1].maintenance.failureRate.value, 2)

  const unstated = byId(await read(w, await newDatabase('update FCT_DamagedComponent set Number = null;')))

  assert.equal(unstated[9].maintenance.failureRate.status, 'unavailable')
})

check('classes', 'the class\'s own figures and its life estimate are shared by its ships, and a class with no cost or no commercial flag has no life', async (w) => {
  const projection = await read(w, await newDatabase())
  const ships = byId(projection)

  assert.equal(projection.classes[10], ships[1].class)
  assert.equal(ships[1].class, ships[2].class, 'one object per class')
  assert.equal(ships[1].class.commercial, false)
  assert.equal(ships[7].class.commercial, true)
  assert.equal(ships[7].class.life.status, 'unavailable', 'a commercial class has no maintenance life')
  assert.equal(ships[8].class.repairCost.status, 'unavailable', 'a class with no components has no repair cost')
  near(ships[1].class.life.value.firstYear, 0.32)
})

// ---- The saves of a passive campaign -------------------------------------------------------------------------------------
const SNAPSHOTS = path.join(root, 'artifacts', 'passive-campaign-20261013', 'snapshots')
const CAMPAIGN = { GameID: 139, races: [2, 3] }
const STATS = { pairs: 0, intervals: 0, found: null }

const openSnapshot = (file) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY)

  return {
    query: (text) => new Promise((resolve, reject) => raw.all(text, (error, found) => (error ? reject(error) : resolve([found])))),
    close: () => raw.close(),
  }
}

check('snapshot-pairs', 'over every consecutive pair of saves of a passive campaign, the overhaul date of each military ship moves by exactly the game time that passed, and its age stays what the save gives', async (w) => {
  const { 'ship-runtime': sr } = await w.modules()

  if (!fs.existsSync(SNAPSHOTS)) {
    STATS.found = false

    return
  }

  const files = fs.readdirSync(SNAPSHOTS).filter((file) => /^AuroraDB_\d+_day_\d+\.db$/.test(file)).sort()
  const step = w.pairs === 'all' ? 1 : Math.max(1, Math.floor(files.length / 6))
  const picks = files.map((file, index) => [file, index]).filter(([, index]) => index < files.length - 1 && index % step === 0)
  const projectionOf = async (file, RaceID) => {
    const database = openSnapshot(path.join(SNAPSHOTS, file))

    try {
      return await sr.loadShipRuntime(database, { GameID: CAMPAIGN.GameID, RaceID, generation: 1 })
    } finally {
      database.close()
    }
  }
  let intervals = 0

  STATS.found = true

  for (const [file, index] of picks) {
    for (const race of CAMPAIGN.races) {
      const before = byId(await projectionOf(file, race))
      const afterProjection = await projectionOf(files[index + 1], race)
      const after = byId(afterProjection)
      const gameTime = afterProjection.revision.gameTime - Object.values(before)[0].revision.gameTime

      assert.ok(gameTime > 0, `${file}: the game time advanced`)

      Object.values(before).filter((ship) => ship.class.commercial === false && after[ship.ShipID]).forEach((ship) => {
        const next = after[ship.ShipID]

        assert.equal(next.clocks.lastOverhaul.value - ship.clocks.lastOverhaul.value, gameTime, `${file} ship ${ship.ShipID}: the overhaul date moved with the game time`)
        assert.equal(next.maintenance.age.value, ship.maintenance.age.value, `${file} ship ${ship.ShipID}: the age`)
        assert.equal(next.maintenance.age.value, 0, `${file} ship ${ship.ShipID}: the age is the one the save gives`)
        assert.equal(ship.maintenance.clockMode, 'reset', `${file} ship ${ship.ShipID}: an unplayed race`)
        intervals += 1
      })
    }
  }

  assert.ok(intervals > 0, 'at least one ship-interval')

  if (w.pairs === 'all') {
    STATS.pairs = picks.length
    STATS.intervals = intervals
  }
})

// ---- Planted faults ------------------------------------------------------------------------------------------------------
// Each plants one change in the module, and the checks named must fail on it. [label, target, text, replacement, the checks that must fail]
const FAULTS = [
  ['the clock runs the wrong way', 'runtime', 'context.gameTime - value : null', 'value - context.gameTime : null', ['rates', 'docked']],
  ['a military hangar moves the age the wrong way', 'runtime', 'value: 1 - HANGAR_CLOCK_MULTIPLIER', 'value: 1 + HANGAR_CLOCK_MULTIPLIER', ['clock-modes']],
  ['a commercial hangar advances the clock too', 'runtime', '} else if (hangared && !carrierCommercial) {', '} else if (hangared) {', ['clock-modes']],
  ['an unplayed race keeps its clock', 'runtime', '} else if (context.npr === true) {', '} else if (false) {', ['clock-modes']],
  ['a game with overhauls off is run', 'runtime', '} else if (context.noOverhauls === true) {', '} else if (false) {', ['clock-modes']],
  ['a supply ship is taken as an ordinary ship', 'runtime', '} else if (supply) {', '} else if (false) {', ['clock-modes']],
  ['a docked ship recovers at the independent rate', 'runtime', '+ (support.hangared === true ? 1 : 0)', '+ 0', ['recovery']],
  ['the recovery has the sign of the age change', 'runtime', 'value: gain - 1,', 'value: 1 - gain,', ['recovery']],
  ['the shore-leave factor is 9', 'runtime', 'const SHORE_LEAVE_MULTIPLIER = 10', 'const SHORE_LEAVE_MULTIPLIER = 9', ['recovery']],
  ['the crew share is not held to 1', 'runtime', 'SHORE_LEAVE_MULTIPLIER * crew.fraction.value +', 'SHORE_LEAVE_MULTIPLIER * (crew.fraction.value * 5) +', ['recovery']],
  ['an age that does not fall has an ETA', 'runtime', 'recovery.value <= 0 ? lacks(RECOVERY_ETA', 'recovery.value < 0 ? lacks(RECOVERY_ETA', ['recovery']],
  ['a plan of 0 is checked', 'runtime', '} else if (!check || ship.PlannedDeployment === 0) {', '} else if (!check) {', ['deployment-modes']],
  ['the margin has the wrong sign', 'runtime', 'value: ship.PlannedDeployment - age.value', 'value: age.value - ship.PlannedDeployment', ['rates', 'docked']],
  ['a flag the save leaves out is taken as off', 'runtime', 'value === 0 || value === false ? false : null', 'value === 0 || value === false ? false : false', ['old-schema', 'clock-modes', 'deployment-modes']],
  ['morale is left out of the crew performance', 'runtime', '* ship.CrewMorale * ship.OverhaulFactor', '* ship.OverhaulFactor', ['rates']],
  ['the grade bonus rounds half up', 'runtime', 'roundHalfEven(Math.sqrt(grade) - 10)', 'Math.round(Math.sqrt(grade) - 10)', ['rates']],
  ['damaged engineering keeps the class\'s failure rate', 'runtime', 'damaged > 0 ? lacks(FAILURE_RATE', 'damaged > 99 ? lacks(FAILURE_RATE', ['engineering']],
  ['a ship in a commercial hangar is not tested for failure', 'runtime', 'const tested = support.case === \'normal\' || support.case === \'overhaul\' || support.case === \'hangared\'', 'const tested = support.case === \'normal\' || support.case === \'overhaul\'', ['increment']],
  ['a ship in a military hangar is tested for failure', 'runtime', 'clock.mode !== \'support\' ?', 'clock.mode !== \'support\' && clock.mode !== \'advanced\' ?', ['increment']],
  ['a ship whose support is not settled is tested for failure', 'runtime', 'support.case === \'overhaul\' || support.case === \'hangared\'', 'support.case === \'overhaul\' || support.case === \'hangared\' || support.case === \'unknown\'', ['increment']],
  ['the carrier of a carried ship is left out', 'runtime', 'mothershipId: idOf(ship.MothershipID)', 'mothershipId: null', ['carrier-links']],
  ['a carrier link the save leaves empty is no carrier', 'runtime', 'mothershipId: idOf(ship.MothershipID)', 'mothershipId: ship.MothershipID || 0', ['carrier-links']],
  ['an unstated hangar kind of the carrier is taken as commercial', 'runtime', 'carrierCommercialHangar: hangared === true ? flag(ship.CarrierCommercialHangar) : null', 'carrierCommercialHangar: hangared === true ? flag(ship.CarrierCommercialHangar) !== false : null', ['carrier-links']],
  ['the carrier\'s fleet is left out', 'runtime', 'carrierFleetId: hangared === true ? idOf(ship.CarrierFleetID) : null', 'carrierFleetId: null', ['carrier-links']],
  ['the tow parent is left out', 'runtime', 'tractorParentShipId: idOf(ship.TractorParentShipID)', 'tractorParentShipId: null', ['carrier-links']],
  ['the tow target is left out', 'runtime', 'tractorTargetShipId: idOf(ship.TractorTargetShipID)', 'tractorTargetShipId: null', ['carrier-links']],
  ['the projection drops the carrier links', 'runtime', 'mothershipId: support.mothershipId, carrierCommercialHangar: support.carrierCommercialHangar, ', '', ['carrier-links']],
  ['a ship in a hangar and under tow is taken as hangared', 'runtime', '} else if (hangared && towed) {', '} else if (false) {', ['support-cases']],
  ['a hangar link the save leaves out is no hangar', 'runtime', 'if (hangared === null || towed === null) {', 'if (false) {', ['support-cases']],
  ['a hangar link the save leaves out is taken as none for the recovery', 'runtime', 'support.hangared === null ? lacks(RECOVERY,', 'false ? lacks(RECOVERY,', ['unread-hangar']],
  ['the recovery is given for a save that is not shown to be 2.7', 'runtime', 'ruleSupports(RECOVERY, context.version) !== true', 'false', ['version']],
  ['the carried ship is given its clock for a save that is not shown to be 2.7', 'runtime', '} else if (hangared && ruleSupports(AGE_RATE, context.version) !== true) {', '} else if (hangared && !carrierCommercial && ruleSupports(AGE_RATE, context.version) !== true) {', ['version']],
  ['a carried ship is given its clock whatever the version', 'runtime', '} else if (hangared && ruleSupports(AGE_RATE, context.version) !== true) {', '} else if (false) {', ['version']],
  ['a ship in an active yard task is taken as outside the tasks', 'runtime', 'yardTask === \'active\') {', 'yardTask === \'never\') {', ['shipyard-tasks']],
  ['a paused yard task takes the ship out of maintenance', 'runtime', 'paused === true ? \'paused\'', 'paused === true ? \'active\'', ['shipyard-tasks']],
  ['a task table the save lacks is taken as no task', 'runtime', 'context.yardTasks ? context.yardTasks.get(ship.ShipID) || \'none\' : null', 'context.yardTasks ? context.yardTasks.get(ship.ShipID) || \'none\' : \'none\'', ['shipyard-tasks']],
  ['a pause flag the save leaves empty is taken as no task', 'runtime', 'const yardTask = task === \'unknown\' ? null : task', 'const yardTask = task === \'unknown\' ? \'none\' : task', ['shipyard-tasks']],
  ['a paused task after an active one of the same ship hides it', 'runtime', 'before === \'active\' || state === \'active\' ? \'active\'', 'state === \'active\' ? \'active\'', ['shipyard-tasks']],
  // eslint-disable-next-line no-template-curly-in-string
  ['the tasks of every game are read', 'runtime', 'where GameID = ${GameID} and ShipID > 0', 'where ShipID > 0', ['shipyard-tasks']],
  ['a ship in an active yard task is tested for failure', 'runtime', 'clock.mode !== \'support\' ?', 'clock.mode !== \'support\' && clock.mode !== \'yard\' ?', ['shipyard-tasks']],
  ['the yard task is not kept on the support record', 'runtime', 'yardTask: support.yardTask, ', '', ['shipyard-tasks']],
  ['the ETA is built from the recovery figure alone, dropping its location assumption', 'runtime', 'combine({ rule: RECOVERY_ETA, parts: { age, recovery }, compute: (values) => Math.max(0, values.age) / values.recovery })', 'ofRule({ rule: RECOVERY_ETA, value: Math.max(0, age.value) / recovery.value, inputs: { present: [\'the deployment age\', \'the recovery\'] } })', ['recovery']],
  ['the ETA drops the recovery as an input', 'runtime', 'parts: { age, recovery }, compute: (values) => Math.max(0, values.age) / values.recovery', 'parts: { age }, compute: (values) => Math.max(0, values.age) / recovery.value', ['recovery']],
  ['the age of a ship in an active yard task is left unavailable', 'runtime', 'clock.mode === \'yard\' ? ofRule({ rule: YARD_AGE_RATE', 'clock.mode === \'never\' ? ofRule({ rule: YARD_AGE_RATE', ['shipyard-tasks']],
  ['the age of a ship in an active yard task is taken to move', 'runtime', 'ofRule({ rule: YARD_AGE_RATE, value: 0,', 'ofRule({ rule: YARD_AGE_RATE, value: 1,', ['shipyard-tasks']],
  ['the yard age rate is given under the ordinary age rule', 'runtime', 'ofRule({ rule: YARD_AGE_RATE,', 'ofRule({ rule: AGE_RATE,', ['shipyard-tasks']],
  ['the yard age rate carries the no-yard-task assumption', 'runtime', 'rule: YARD_AGE_RATE, value: 0, ', 'rule: YARD_AGE_RATE, value: 0, assumptions: [\'no yard task refits the ship, which would hold the age as it is\'], ', ['shipyard-tasks']],
  ['a task state the save does not show is taken as an ordinary ship', 'runtime', 'yardTask === null) {', 'yardTask === null && false) {', ['shipyard-tasks']],
  ['the version is taken as 2.7 without asking the save', 'runtime', 'version: formulaVersion, npr', 'version: \'2.7.x\', npr', ['version']],
  ['the thresholds are ordered by the column the save may lack', 'runtime', 'order by ShipClassID, ChanceToHit, ComponentID', 'order by FCT_ShipClass.ShipClassID, FCT_ClassComponent.ChanceToHit, FCT_ClassComponent.ComponentID', ['old-schema-thresholds']],
  ['an empty list of classes reads every class', 'runtime', 'classIds === null || classIds === undefined', 'classIds === null || classIds === undefined || classIds.length === 0', ['class-selection']],
  ['an id that is not a whole number is dropped without a word', 'runtime', '...asked.invalid, ', '', ['class-selection']],
  // eslint-disable-next-line no-template-curly-in-string
  ['a state the rules do not settle is normal', 'runtime', 'supportCase = \'unknown\'\n    reason = `maintenance state ${ship.MaintenanceState} is not one the rules settle`', 'supportCase = \'normal\'\n    reason = \'\'', ['support-cases']],
  ['the records are not frozen', 'runtime', 'Object.values(value).forEach(deepFreeze)', 'void value', ['shape']],
  ['the records are left in the order of the rows', 'runtime', '[...rows].sort((a, b) => a.ShipID - b.ShipID)', '[...rows]', ['two-callers']],
  ['the class\'s life is kept on the ship', 'runtime', 'incrementChance: maintenance.incrementChance }', 'incrementChance: maintenance.incrementChance, life: ship.class.life }', ['provenance']],
  ['the observed clock has a rule of its own', 'runtime', 'const observed = (name, value, units) => (known(value) ? ofRule({ rule: OBSERVED,', 'const observed = (name, value, units) => (known(value) ? ofRule({ rule: AGE,', ['provenance']],
  // eslint-disable-next-line no-template-curly-in-string
  ['the other races\' classes are the race\'s own', 'runtime', 'and FCT_ShipClass.RaceID = ${RaceID}${ids', '${ids', ['scope']],
  ['a class that is not the race\'s is not rejected', 'runtime', '...wanted.filter((id) => !owned.includes(id))', '...[]', ['scope']],
  // eslint-disable-next-line no-template-curly-in-string
  ['a ship in a class that is not the race\'s is read when asked for', 'runtime', 'fleetWhere: wanted ? `FCT_ShipClass.ShipClassID in (${owned.join(\', \')})` : \'1 = 1\'', 'fleetWhere: wanted ? `FCT_ShipClass.ShipClassID in (${wanted.join(\', \')})` : \'1 = 1\'', ['scope']],
  ['a late read is shown', 'runtime', 'return run === latest && same(open, current()) ? projection : STALE', 'return projection', ['stale']],
  ['a change of save copy is not a change of scope', 'runtime', 'a.RaceID === b.RaceID && a.generation === b.generation', 'a.RaceID === b.RaceID', ['stale']],
  ['a change of race is not a change of scope', 'runtime', 'a.GameID === b.GameID && a.RaceID === b.RaceID', 'a.GameID === b.GameID', ['stale']],
  ['a cancel changes nothing', 'runtime', 'cancel() {\n      latest += 1\n    },', 'cancel() {\n    },', ['stale']],
  ['an earlier read is not made stale by a later one', 'runtime', 'async read({ classIds = null, scenario = {} } = {}) {\n      latest += 1\n', 'async read({ classIds = null, scenario = {} } = {}) {\n', ['stale']],
  ['a projection of another save copy is current', 'runtime', 'projection.revision.generation === (known(generation) ? generation : null)', 'true', ['stale']],
  ['the revision has no game time', 'runtime', 'GameID, RaceID, gameTime })\n  const rows', 'GameID, RaceID, gameTime: null })\n  const rows', ['shape']],
  ['the overhaul date is the game time', 'runtime', 'lastOverhaul: maintenance.lastOverhaul', 'lastOverhaul: maintenance.age', ['shape', 'snapshot-pairs']],
]

// ---- Benign edits ----------------------------------------------------------------------------------------------------
// Edits that change nothing the checks look at: the wording of a case, a condition's text. Each is located by the key it belongs to, never by what it holds now.
const STRING = '\'[^\'\\n]*\''

const BENIGN = [
  { label: 'the words for a case reworded', target: 'runtime', at: new RegExp(`(towed: )${STRING}`), to: (m) => `${m[1]}'Pulled by a tractor beam'` },
  { label: 'a condition reworded', target: 'runtime', at: new RegExp(`(code: 'tow-maintenance', text: )${STRING}`), to: (m) => `${m[1]}'the upkeep of a ship being towed is not checked'` },
  { label: 'the wording of a rule reworded', target: 'runtime', at: new RegExp(`(id: RECOVERY_ETA,[^]*?note: )${STRING}`), to: (m) => `${m[1]}'The months a ship at a shore-leave location needs to bring its age to 0 as things stand.'` },
].map((edit, index) => ({ ...edit, id: `benign:${index}` }))

// ---- Run ----------------------------------------------------------------------------------------------------------------
const run = async (checks, w) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(w)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const main = async () => {
  const mutate = !process.argv.includes('--no-mutations')
  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (STATS.found === false) {
    console.log(`note: ${path.relative(root, SNAPSHOTS)} is not on disk, so the pair check ran on nothing`)
  } else if (STATS.found) {
    console.log(`pairs: ${STATS.pairs} consecutive saves, ${STATS.intervals} ship-intervals of military ships`)
  }

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))

    FAULTS.forEach(([label, , , , fails]) => fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`)))

    const stages = [
      ...BENIGN.map((edit) => [`benign edit kept: ${edit.label}`, async () => (await run(CHECKS, worldOf([edit]))).map(describeFailure)]),
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

    const attempts = FAULTS.flatMap(([label, target, from, to, fails]) => {
      const planted = from instanceof RegExp ? { target, at: from, to } : { target, from, to }

      return [[label, [planted], fails], [`${label}, on the source with every benign edit`, [...BENIGN, planted], fails]]
    })
    const outcomes = await inParallel(attempts, async ([label, edits, fails]) => {
      const w = worldOf(edits)
      const missed = []

      for (const name of fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), w)

        if (!failed) {
          missed.push(name)
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
