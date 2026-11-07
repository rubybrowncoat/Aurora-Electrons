/*
  Checks the terraforming planner's inputs against the rules of the game and the saves of the 3.2 line (the migrated fixture and the played saves), read only.

  node scripts/check-terraform-campaigns.js [--no-mutations]

  Each group works from a save of the line read only (SELECTs only; a planted case runs on an in-memory copy) or from a fixture that needs none, and compares the shared breakdown and the planner's arithmetic with the rules of docs/DATABASE.md:
  - arithmetic: fixtures worked by hand from the rule through the app's capacity, years and area arithmetic and through the shared breakdown, and the faults planted in them;
  - shared rule: the terraforming capacity of every colony of the fixture and of the played save equals an independent working under the fleet-at-colony rule the game applies (a fleet counts at the colony when it is of the colony's race, within one unit of the colony's body on both axes, and assigned to the colony or to none), and the planted fleets — one assigned to the colony but away from it, one assigned to none at it, one assigned to none that the game may give to two colonies — are read as the rule says;
  - bonus rows: a Terraforming bonus row without a value, a missing sector association and a naval admin bonus row without a value leave the terms they feed unavailable on a copy of a save of the line, never neutral;
  - one-year: the Environment tab's one-year lines of the played colony and of every body of the two saves against a working from the saved rows and the game's methods, and the planted gases, dust and moon;
  - planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step.
  A save that is not there skips its group and says so; a skipped group is never counted as passed. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { Database } = require('bun:sqlite')
const { assert, runChecks, judged, caughtAll } = require('./lib/fault-credit')
const { FIXTURE, PLAYED } = require('./lib/fixtures')
const { loadUtilities } = require('./lib/utilities')
const { loadModules, instantiate } = require('./lib/page-loader')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const EARTH_ATMOSPHERE_UNITS = 511187128
const PI = 3.1416
const GROUP_BY = 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})'
const PRODUCTION_STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const handles = new Map()

const handleOf = (file) => {
  if (!handles.has(file)) {
    handles.set(file, new Promise((resolve, reject) => {
      const database = new sqlite3.Database(path.join(root, file), sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(database)))
    }))
  }

  return handles.get(file)
}

const rowsOf = async (file, sql, ...parameters) => {
  const database = await handleOf(file)

  return new Promise((resolve, reject) => database.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve(rows))))
}

const firstOf = async (file, sql, ...parameters) => (await rowsOf(file, sql, ...parameters))[0]
const databaseOf = (file) => ({ query: async (sql) => [await rowsOf(file, sql)] })
const present = (...files) => files.every((file) => fs.existsSync(path.join(root, file)))

// The terraforming capacity of every colony of a race under the fleet-at-colony rule the game applies, worked from the save's own rows: the installations and their modifier, and the terraformer modules of the ships in the fleets of the race within one unit of the colony's body on both axes that are assigned to the colony or to none (a fleet assigned to a colony that no longer exists counts as assigned to none), each ship at the share of its class crew aboard and at its captain's Terraforming bonus. The naval admin chain's multiplier is the one factor not re-derived here: it is the app's own chain over the commands `loadNavalAdmins` gives, so a fault confined to the chain is out of this working's reach. Returns `{ colonies, placeless }`: per colony its ships (ShipIDs), installations' output, orbital output and capacity, `ambiguous` (an unassigned fleet the game may give to either of more than one colony, whose term is unavailable) and `unknown` (a figure the save does not hold); `placeless` names the fleets with terraformer modules that have neither a position nor an orbit body, which this working does not settle.
const sharedCapacityOf = async (database, { game, race, chainOf }) => {
  const query = async (sql) => (await database.query(sql))[0]
  const [rateRow] = await query(`select TerraformingRate from FCT_Race where GameID = ${game} and RaceID = ${race}`)
  const [speedRow] = await query(`select TerraformingSpeed from FCT_Game where GameID = ${game}`)
  const rate = rateRow ? rateRow.TerraformingRate : null
  const speed = speedRow ? speedRow.TerraformingSpeed : null
  const colonies = await query(`select FCT_Population.PopulationID, FCT_Population.SystemBodyID, FCT_Population.PoliticalStatus, FCT_Population.Efficiency, FCT_Population.UnrestPoints, FCT_SystemBody.SystemID, FCT_SystemBody.Xcor as BodyX, FCT_SystemBody.Ycor as BodyY, FCT_SystemBody.RadiationLevel from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${game} and FCT_Population.RaceID = ${race}`)
  const fleetRows = await query(`select FCT_Fleet.FleetID, coalesce(FCT_Fleet.AssignedPopulationID, 0) as Assigned, exists (select 1 from FCT_Population VIR_Assigned where VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID) as AssignedExists, FCT_Fleet.OrbitBodyID, FCT_Fleet.Xcor as FleetX, FCT_Fleet.Ycor as FleetY, (select count(*) from FCT_Population VIR_Place inner join FCT_SystemBody VIR_Body on VIR_Body.SystemBodyID = VIR_Place.SystemBodyID where VIR_Place.GameID = ${game} and VIR_Place.RaceID = ${race} and ((FCT_Fleet.Xcor is not null and FCT_Fleet.Ycor is not null and VIR_Body.Xcor is not null and VIR_Body.Ycor is not null and abs(FCT_Fleet.Xcor - VIR_Body.Xcor) < 1 and abs(FCT_Fleet.Ycor - VIR_Body.Ycor) < 1) or ((FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null or VIR_Body.Xcor is null or VIR_Body.Ycor is null) and FCT_Fleet.OrbitBodyID = VIR_Place.SystemBodyID))) as Places from FCT_Fleet where FCT_Fleet.GameID = ${game} and FCT_Fleet.RaceID = ${race} and exists (select 1 from FCT_Ship VIR_Ship inner join FCT_ClassComponent VIR_Class on VIR_Class.ClassID = VIR_Ship.ShipClassID and VIR_Class.GameID = VIR_Ship.GameID inner join FCT_ShipDesignComponents VIR_Design on VIR_Design.SDComponentID = VIR_Class.ComponentID and VIR_Design.ComponentTypeID = 33 where VIR_Ship.FleetID = FCT_Fleet.FleetID and VIR_Ship.GameID = ${game} and VIR_Ship.RaceID = ${race})`)
  const fleets = new Map(fleetRows.map((row) => [row.FleetID, row]))
  const bonusOf = async (type, command) => (await query(`select max(FCT_CommanderBonuses.BonusValue) as value, count(*) as rows, count(FCT_CommanderBonuses.BonusValue) as known from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${game} and FCT_Commander.CommandType = ${type} and FCT_Commander.CommandID = ${command} and FCT_CommanderBonuses.BonusID = 9`))[0]
  const bonusValue = (row) => (!row || !(row.rows > 0) ? 1 : row.known === row.rows && Number.isFinite(row.value) ? row.value : null)
  const capacity = {}

  for (const colony of colonies) {
    const governor = bonusValue(await bonusOf(3, colony.PopulationID))
    const [association] = await query(`select SectorID from FCT_RaceSysSurvey where GameID = ${game} and RaceID = ${race} and SystemID = ${colony.SystemID}`)
    const sector = !association || association.SectorID === null ? null : association.SectorID === 0 ? 1 : bonusValue(await bonusOf(4, association.SectorID))
    const [status] = await query(`select ProductionMod from DIM_PopPoliticalStatus where StatusID = ${colony.PoliticalStatus}`)
    const [installation] = await query(`select coalesce(sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.TerraformValue), 0) as amount from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${game} and FCT_PopulationInstallations.PopID = ${colony.PopulationID} and DIM_PlanetaryInstallation.TerraformValue > 0`)
    const bodyX = colony.BodyX === null ? 'null' : colony.BodyX
    const bodyY = colony.BodyY === null ? 'null' : colony.BodyY
    const at = `((FCT_Fleet.Xcor is not null and FCT_Fleet.Ycor is not null and ${bodyX} is not null and ${bodyY} is not null and abs(FCT_Fleet.Xcor - ${bodyX}) < 1 and abs(FCT_Fleet.Ycor - ${bodyY}) < 1) or ((FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null or ${bodyX} is null or ${bodyY} is null) and FCT_Fleet.OrbitBodyID = ${colony.SystemBodyID}))`
    const claim = `(coalesce(FCT_Fleet.AssignedPopulationID, 0) = 0 or not exists (select 1 from FCT_Population VIR_Assigned where VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID) or FCT_Fleet.AssignedPopulationID = ${colony.PopulationID})`
    const lines = await query(`select FCT_Ship.ShipID, FCT_Fleet.FleetID, FCT_Fleet.ParentCommandID, FCT_Fleet.SystemID as FleetSystemID, FCT_ShipClass.Crew as ClassCrew, FCT_Ship.CurrentCrew, FCT_ClassComponent.NumComponent as Designed, (case when FCT_ShipClass.Crew is null then null when FCT_ShipClass.Crew > 0 then min(1.0, max(0, FCT_Ship.CurrentCrew) * 1.0 / FCT_ShipClass.Crew) else 1.0 end) as CrewShare, (select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID order by FCT_DamagedComponent.rowid limit 1) as Damaged, (select count(*) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID) as DamageRows, max(FCT_CommanderBonuses.BonusValue) as CaptainBonus, count(FCT_CommanderBonuses.BonusValue) as CaptainKnown, count(FCT_CommanderBonuses.CommanderID) as CaptainRows from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.GameID = FCT_Ship.GameID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = 33 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_Commander on FCT_Commander.GameID = ${game} and FCT_Commander.CommandType = 1 and FCT_Commander.CommandID = FCT_Ship.ShipID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 9 where FCT_Ship.GameID = ${game} and FCT_Ship.RaceID = ${race} and FCT_Fleet.RaceID = ${race} and ${at} and ${claim} group by FCT_Ship.ShipID, FCT_ClassComponent.ComponentID`)
    const ships = new Map()

    lines.forEach((row) => {
      const ship = ships.get(row.ShipID) || { ShipID: row.ShipID, FleetID: row.FleetID, FleetSystemID: row.FleetSystemID, ParentCommandID: row.ParentCommandID, crew: row.CrewShare, captain: row.CaptainRows > 0 ? (row.CaptainKnown === row.CaptainRows && Number.isFinite(row.CaptainBonus) ? row.CaptainBonus : null) : 1, modules: 0 }

      ship.modules = ship.modules === null || !Number.isFinite(row.Designed) || (row.DamageRows > 0 && !Number.isFinite(row.Damaged)) ? null : ship.modules + Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))
      ships.set(row.ShipID, ship)
    })

    const modifier = Number.isFinite(governor) && sector !== null && Number.isFinite(colony.Efficiency) && Number.isFinite(colony.UnrestPoints) && Number.isFinite(colony.RadiationLevel) && status && Number.isFinite(status.ProductionMod) ? governor * (1 + (sector - 1) / 4) * colony.Efficiency * Math.max(0, 1 - colony.RadiationLevel / 10000) * (1 - Math.min(99, Math.max(0, colony.UnrestPoints)) / 100) * status.ProductionMod : null
    const counted = [...ships.values()]
    let ambiguous = false
    let unknown = !Number.isFinite(rate) || !Number.isFinite(speed) || (installation.amount > 0 && modifier === null)

    counted.forEach((ship) => {
      const fleet = fleets.get(ship.FleetID)
      const chain = chainOf(ship.FleetSystemID, ship.ParentCommandID)

      ship.chain = chain

      if (!Number.isFinite(ship.modules) || !Number.isFinite(ship.crew) || !Number.isFinite(ship.captain) || !Number.isFinite(chain)) {
        unknown = true
      }

      if ((fleet.Assigned === 0 || !fleet.AssignedExists) && fleet.Places > 1) {
        ambiguous = true
      }
    })

    const installations = installation.amount === 0 ? 0 : rate * Math.trunc(installation.amount) * modifier
    const orbital = rate * counted.reduce((total, ship) => total + (Number.isFinite(ship.modules) && Number.isFinite(ship.crew) && Number.isFinite(ship.captain) && Number.isFinite(ship.chain) ? ship.modules * ship.crew * ship.captain * ship.chain : 0), 0)

    capacity[colony.PopulationID] = { ships: counted.map((ship) => ship.ShipID), installations, orbital, capacity: (installations + orbital) * speed / 100, ambiguous, unknown }
  }

  return { colonies: capacity, placeless: fleetRows.filter((fleet) => !(Number.isFinite(fleet.FleetX) && Number.isFinite(fleet.FleetY)) && !(fleet.OrbitBodyID > 0)).map((fleet) => fleet.FleetID) }
}

// Fixtures that need no save, worked by hand from the rule (capacity = (rate x whole installations x modifier + rate x modules at crew and captain share) x speed / 100): so each planted fault in the app's arithmetic is detectable whichever saves are present. 0.001 x 5 x 10 x 1.25 + 0.001 x 5 x 3 = 0.0775; 0.001 x 4 x 0.5 = 0.002.
const ARITHMETIC = [
  { label: 'arithmetic: 10.5 installations at modifier 1.25 and 3 staffed modules, speed 500%', rate: 0.001, speed: 500, installations: 10.5, modifier: 1.25, effective: 3, total: 0.0775, observed: 0.2, radius: 6000 },
  { label: 'arithmetic: 4 installations at modifier 0.5, speed 100%', rate: 0.001, speed: 100, installations: 4, modifier: 0.5, effective: 0, total: 0.002, observed: -0.05, radius: 3000 },
].map((fixture) => ({ ...fixture, years: Math.abs(fixture.observed) * 4 * PI * fixture.radius ** 2 / EARTH_ATMOSPHERE_UNITS / fixture.total }))

// The faults planted in the app's own capacity and years arithmetic: each must break the app-output assertions. [label, utility, text, replacement, the assertions that must fail]
const APP_FAULTS = [
  ['halved capacity', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier * 0.5', ['capacity']],
  ['years multiplied by the capacity', 'terraforming', 'work / capacity : Infinity', 'work * capacity : Infinity', ['years']],
  ['modifier ignored', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers', ['capacity']],
  ['speed ignored', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * terraformers * modifier', ['capacity']],
]
// The app's capacity of each fixture (installations at the modifier, orbital modules at the crew and captain share) and its years for the observed change, against the rule's independent expectation.
const appOutputs = async (modules, fixtures, only = null) => {
  const { terraforming } = modules

  for (const fixture of fixtures) {
    const race = { TerraformingRate: fixture.rate, TerraformingSpeed: fixture.speed }
    const capacity = terraforming.terraformCapacity(race, Math.trunc(fixture.installations), fixture.modifier) + terraforming.terraformCapacity(race, fixture.effective, 1)

    if (!only || only === 'capacity') {
      assert.ok(Math.abs(capacity / fixture.total - 1) < 1e-9, `${fixture.label}: capacity ${capacity}, rule ${fixture.total}`)
    }

    const years = terraforming.planYears(Math.abs(fixture.observed) * 4 * PI * fixture.radius ** 2 / EARTH_ATMOSPHERE_UNITS, capacity)

    if (!only || only === 'years') {
      assert.ok(Math.abs(years / fixture.years - 1) < 5e-4, `${fixture.label}: years ${years}, observed ${fixture.years}`)
    }
  }
}

// The shared breakdown (utilities/terraform-capacity.js) against the rule oracle above. Each entry is a check of its own, `needs` the saves it reads (missing: SKIP), and `run(modules)` throws when the breakdown disagrees; the planted faults below are loaded from a patched source and must fail the checks they name.
const adminOf = (overrides) => ({ NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.05, Eligible: true, Unknown: null, Systems: new Set([5]), ...overrides })

const sourcesOf = (modules, file, game, race, blocked) => modules['terraform-capacity'].loadTerraformSources(databaseOf(file), { GameID: game, RaceID: race, blocked })
const adminsOf = (modules, file, game, race) => modules['naval-admins'].loadNavalAdmins(databaseOf(file), { GameID: game, RaceID: race, bonusId: 9, share: 'Industrial' })
const missingOf = (result) => (result.inputs ? result.inputs.missing.join('; ') : '')

// A colony and its race worked by hand: 10.5 installations (10 count) at I = 1.2 x 1.1 x 0.9 x 0.99 x 0.9 x 1 (the sector bonus 1.4 counts a quarter of its excess), 8 modules at half the crew, a captain's 1.1 and the admin chain 1 + (1.2 - 1) x 0.05, rate 0.001, speed 500 %, radius 6000 km.
const handSource = () => ({ installations: 10.5, radius: 6000, gravity: 1, modifier: { governor: 1.2, sector: 1.4, efficiency: 0.9, radiation: 100, unrest: 10, status: 1 }, ships: [{ ShipID: 1, PopulationID: 1, ParentCommandID: 1, FleetSystemID: 5, crew: 0.5, captain: 1.1, captained: true, modules: 8 }] })

const handExpected = () => {
  const installations = 0.001 * 10 * (1.2 * 1.1 * 0.9 * 0.99 * 0.9 * 1)
  const orbital = 0.001 * (8 * 0.5 * 1.1) * 1.01
  const capacity = (installations + orbital) * 500 / 100

  return { installations, orbital, capacity, rate: capacity * EARTH_ATMOSPHERE_UNITS / (4 * PI * 6000 ** 2) }
}

const near = (value, expected, tolerance, what) => assert.ok(Number.isFinite(value) && Math.abs(value / expected - 1) < tolerance, `${what}: ${value}, rule ${expected}`)

const FIXTURE_CASE = Object.freeze({ game: FIXTURE.gameId, race: FIXTURE.raceId })
const PLAYED_CASE = Object.freeze({ game: PLAYED.gameId, race: PLAYED.raceId })

// The app's capacity of every colony of one save against `sharedCapacityOf`: the ships each colony counts, the installations' output, the orbital output and the capacity. A colony whose fleet the save cannot settle must be unavailable there, naming the unsettled place or claim. `database` is the save or an in-memory copy read through its `query`.
const assertSharedRule = async (modules, database, { game, race }, label) => {
  const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
  const sources = await loadTerraformSources(database, { GameID: game, RaceID: race })
  const admins = await modules['naval-admins'].loadNavalAdmins(database, { GameID: game, RaceID: race, bonusId: 9, share: 'Industrial' })
  const expected = await sharedCapacityOf(database, { game, race, chainOf: (system, command) => modules.minerals.navalAdminChain(admins, system, command).bonus })
  const breakdowns = {}
  let compared = 0
  let shipped = 0

  assert.deepEqual(expected.placeless, [], `${label}: a terraformer fleet with neither a position nor an orbit body`)

  for (const source of Object.values(sources.colonies)) {
    const oracle = expected.colonies[source.PopulationID]
    const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source, admins })
    const listed = source.ships.map((ship) => ship.ShipID).sort((left, right) => left - right)
    const counted = [...oracle.ships].sort((left, right) => left - right)

    breakdowns[source.PopulationID] = breakdown
    assert.deepEqual(listed, counted, `${label} ${source.PopName}: the ships the colony counts`)
    compared += 1
    shipped += listed.length

    if (oracle.ambiguous) {
      assert.equal(breakdown.orbital.status, 'unavailable', `${label} ${source.PopName}: ${missingOf(breakdown.orbital)}`)
      assert.ok(/which colony of the race/.test(missingOf(breakdown.orbital)), `${label} ${source.PopName}: ${missingOf(breakdown.orbital)}`)
      assert.equal(breakdown.capacity.status, 'unavailable', `${label} ${source.PopName}`)
      continue
    }

    if (oracle.unknown) {
      assert.equal(breakdown.capacity.status, 'unavailable', `${label} ${source.PopName}: ${missingOf(breakdown.capacity)}`)
      continue
    }

    assert.equal(breakdown.capacity.status, 'estimated', `${label} ${source.PopName}: ${missingOf(breakdown.capacity)}`)

    if (oracle.installations === 0) {
      assert.equal(breakdown.installations.value, 0, `${label} ${source.PopName}: installations`)
    } else {
      near(breakdown.installations.value, oracle.installations, 1e-12, `${label} ${source.PopName}: installations`)
    }

    if (oracle.orbital === 0) {
      assert.equal(breakdown.orbital.value, 0, `${label} ${source.PopName}: orbital`)
    } else {
      near(breakdown.orbital.value, oracle.orbital, 1e-12, `${label} ${source.PopName}: orbital`)
    }

    if (oracle.capacity === 0) {
      assert.equal(breakdown.capacity.value, 0, `${label} ${source.PopName}: capacity`)
    } else {
      near(breakdown.capacity.value, oracle.capacity, 1e-12, `${label} ${source.PopName}: capacity`)
    }
  }

  assert.ok(compared > 0, `${label}: no colony compared`)

  return { sources, admins, expected: expected.colonies, breakdowns, compared, shipped }
}

// A copy of a save in memory with `statements` run on it: the loaders read it as they read a save, and the file is never opened for writing.
const mutatedOf = (file, statements) => {
  const database = Database.deserialize(fs.readFileSync(path.join(root, file)))

  statements.forEach((statement) => database.exec(statement))

  return { query: async (sql) => [database.query(sql).all()], close: () => database.close() }
}

// The fixture's one colony with terraforming installations has neither a governor nor a sector commander with a Terraforming bonus, so the copies that plant a bonus row without a value first give it both: a governor row of the race with a Terraforming bonus is moved onto the colony and its system is put under a sector commander that has one, which is how the game holds them for a colony that terraforms.
const governedColony = async (modules) => {
  const sources = await sourcesOf(modules, FIXTURE.file, FIXTURE_CASE.game, FIXTURE_CASE.race)
  const colony = Object.values(sources.colonies).find((source) => source.installations > 0)
  const bonused = (type) => firstOf(FIXTURE.file, 'select c.CommanderID, c.CommandID from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID and b.BonusID = 9 where c.GameID = ? and c.RaceID = ? and c.CommandType = ? limit 1', FIXTURE_CASE.game, FIXTURE_CASE.race, type)
  const governor = await bonused(3)
  const sector = await bonused(4)

  assert.ok(colony && governor && sector, 'the fixture needs a colony with terraforming installations, a governor and a sector commander with a Terraforming bonus')

  return [`update FCT_Commander set CommandID = ${colony.PopulationID} where CommanderID = ${governor.CommanderID}`, `update FCT_RaceSysSurvey set SectorID = ${sector.CommandID} where GameID = ${FIXTURE_CASE.game} and RaceID = ${FIXTURE_CASE.race} and SystemID = ${colony.SystemID}`]
}

// ---- The Environment tab's one-year lines (AE-304-05) ------------------------------------------------------------------
// What the game's Environment tab writes for a colony that terraforms (SystemBody.PopulateAtmosphereListView, SystemBody.cs:4316-4320): "Add Aestusium for one year" as a plus before the change that `method_37` (2079-2100) gives with the colony's yearly pressure on the body added to the greenhouse gas, "Add Frigusium for one year" as the change with a tenth of it added to the greenhouse gas and the whole of it to the anti-greenhouse gas, each against the temperature `method_2` (303-344, with the dampening of `method_1`, 262-301) has just written. Worked here from the saved rows and those methods, never by the app's helper. The base temperature is the game's: 255 / sqrt(distance / sqrt(luminosity)) at the distance now, never under 4 K, and a moon takes its planet's (SystemBody.cs:895, 909-912, 2594-2598).
const TAB_LABELS = { aestusium: 'Add Aestusium for one year', frigusium: 'Add Frigusium for one year' }

// A .NET double written with `#,0.#` (Helpers.smethod_60): the value read at 15 significant digits, rounded half away from zero at one decimal, the thousands set apart, and a negative that rounds to nothing without its sign. Worked on the digits, not on a number.
const tabFigureOf = (value) => {
  const text = Math.abs(value) < 1e-6 ? '0.00000000000000' : Math.abs(value).toPrecision(15)
  const [whole, fraction = ''] = text.split('.')
  const tenths = BigInt(whole + (fraction[0] || '0')) + (fraction[1] >= '5' ? 1n : 0n)
  const digits = tenths.toString().padStart(2, '0')
  const integer = digits.slice(0, -1).replace(/\B(?=(\d{3})+$)/g, ',')
  const unsigned = digits.slice(-1) === '0' ? integer : `${integer}.${digits.slice(-1)}`

  return value < 0 && tenths > 0n ? `-${unsigned}` : unsigned
}

// The rows the tab reads for every body of a game, by body: the climate figures, the planet's orbit for a moon, the star's luminosity, and the pressure of the greenhouse and of the anti-greenhouse gases that are not frozen out (the tab's own sums, taken in the order it lists the gases, the greatest first).
const oneYearRows = async (database, game) => {
  const query = async (sql) => (await database.query(sql))[0]
  const bodies = await query(`select b.SystemBodyID, b.BodyClass, b.Albedo, b.AtmosPress, b.DustLevel, b.HydroExt, b.SurfaceTemp, b.OrbitalDistance, b.DistanceToParent, b.Eccentricity, b.Year, p.OrbitalDistance as ParentOrbitalDistance, p.DistanceToParent as ParentDistanceToParent, p.Eccentricity as ParentEccentricity, p.Year as ParentYear, s.Luminosity from FCT_SystemBody b inner join FCT_Star s on s.StarID = b.StarID left join FCT_SystemBody p on p.SystemBodyID = b.ParentBodyID and b.ParentBodyType = 1 where b.GameID = ${game} and b.BodyClass in (1, 2, 3, 5) and b.BodyTypeID not in (0, 4, 5)`)
  const gases = await query(`select a.SystemBodyID, a.GasAtm, a.FrozenOut, g.GHGas, g.AntiGHGas from FCT_AtmosphericGas a left join DIM_Gases g on g.GasID = a.AtmosGasID where a.GameID = ${game}`)
  const sums = new Map()

  for (const gas of gases.sort((left, right) => right.GasAtm - left.GasAtm)) {
    const sum = sums.get(gas.SystemBodyID) || { greenhouse: 0, anti: 0, frozen: 0 }

    if (gas.FrozenOut) {
      sum.frozen += 1
    } else if (gas.GHGas) {
      sum.greenhouse += gas.GasAtm
    } else if (gas.AntiGHGas) {
      sum.anti += gas.GasAtm
    }

    sums.set(gas.SystemBodyID, sum)
  }

  return new Map(bodies.map((row) => [row.SystemBodyID, { row, ...(sums.get(row.SystemBodyID) || { greenhouse: 0, anti: 0, frozen: 0 }) }]))
}

// The tab's figures for one body at a yearly pressure `yearly` on it (atm): the temperature now, the two estimates and the texts of the two lines, with whether a factor stood at the cap of 3. Null where a figure the tab reads is not in the rows.
const tabOf = ({ row, greenhouse, anti }, yearly) => {
  const moon = row.BodyClass === 2
  const figures = [row.Albedo, row.AtmosPress, row.DustLevel, row.HydroExt, row.OrbitalDistance, row.DistanceToParent, row.Eccentricity, row.Year, row.Luminosity, ...(moon ? [row.ParentOrbitalDistance, row.ParentDistanceToParent, row.ParentEccentricity, row.ParentYear] : [])]

  if (!figures.every(Number.isFinite)) {
    return null
  }

  const distance = moon ? row.ParentOrbitalDistance : row.OrbitalDistance
  const eccentricity = moon ? row.ParentEccentricity : row.Eccentricity
  const year = moon ? row.ParentYear : row.Year
  const dampening = eccentricity === 0 || distance === 0 ? 0 : (Math.min(0.5, row.AtmosPress / 10) + Math.min(0.3, row.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(year / 8760))
  const factors = (gh, agh) => [Math.min(3, 1 + row.AtmosPress / 10 + gh), Math.min(3, 1 + row.DustLevel / 20000 + agh)]
  const base = Math.max(4, 255 / Math.pow((moon && row.ParentDistanceToParent > 0 ? row.ParentDistanceToParent : row.DistanceToParent) / Math.pow(row.Luminosity, 0.5), 0.5))
  const [now, nowAnti] = factors(greenhouse, anti)
  const circular = 255 / Math.pow(distance / Math.pow(row.Luminosity, 0.5), 0.5) * now * row.Albedo / nowAnti
  const climate = base * now * row.Albedo / nowAnti
  const surface = Math.max(4, dampening <= 0 ? climate : climate * (1 - dampening) + circular * dampening)
  const estimate = (gh, agh) => {
    const [factor, antiFactor] = factors(gh, agh)

    return base * factor * row.Albedo / antiFactor
  }
  const aestusium = estimate(greenhouse + yearly, anti)
  const frigusium = estimate(greenhouse + yearly / 10, anti + yearly)

  return { base, surface, aestusium, frigusium, aestusiumText: `+${tabFigureOf(aestusium - surface)}`, frigusiumText: tabFigureOf(frigusium - surface), capped: now === 3 || nowAnti === 3 }
}

// The app's one-year lines against the tab's. The tab puts a plus before the Aestusium figure whatever its sign ("+-0.4" for a fall); the app writes a plus only before a figure that is not a fall, and nothing else of the line differs.
const assertTab = (found, tab, label) => {
  const close = (value, expected, what) => assert.ok(Math.abs(value - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${what} ${value}, tab ${expected}`)

  close(found.current, tab.surface, 'the temperature now')
  assert.equal(found.aestusium.label, TAB_LABELS.aestusium, `${label}: the Aestusium label`)
  assert.equal(found.frigusium.label, TAB_LABELS.frigusium, `${label}: the Frigusium label`)
  close(found.aestusium.temperature, tab.aestusium, 'the Aestusium estimate')
  close(found.frigusium.temperature, tab.frigusium, 'the Frigusium estimate')
  close(found.aestusium.change, tab.aestusium - tab.surface, 'the Aestusium change')
  close(found.frigusium.change, tab.frigusium - tab.surface, 'the Frigusium change')
  assert.equal(found.aestusium.text, tab.aestusiumText.replace('+-', '-'), `${label}: the Aestusium figure`)
  assert.equal(found.frigusium.text, tab.frigusiumText, `${label}: the Frigusium figure`)
}

// A colony's rate on a body (a result of 'production.terraformRate') of a chosen size: one installation worth `yearly` atm on a body with the Earth's surface at the game's speed 100 and no modifier, so that the rate is `yearly` to the last digit but one; null `yearly` is a race with no terraforming rate, so the result is unavailable.
const NEUTRAL_MODIFIER = Object.freeze({ governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 })
const rateOf = (modules, yearly) => modules['terraform-capacity'].terraformBreakdown({ raceRate: yearly, speed: 100, source: { installations: 1, radius: Math.sqrt(EARTH_ATMOSPHERE_UNITS / (4 * PI)), modifier: NEUTRAL_MODIFIER, ships: [], shipsKnown: true }, admins: {} }).rate

const insertGas = (game, body, gas, atm, frozen) => `insert into FCT_AtmosphericGas (GameID, SystemBodyID, AtmosGasID, AtmosGasPercentage, GasAtm, FrozenOut) values (${game}, ${body}, ${gas}, 0, ${atm}, ${frozen})`

const BREAKDOWN_CHECKS = {
  arith: {
    needs: [],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const expected = handExpected()
      const breakdown = terraformBreakdown({ raceRate: 0.001, speed: 500, source: handSource(), admins: { 1: adminOf() } })

      assert.equal(breakdown.rate.status, 'estimated')
      near(breakdown.installations.value, expected.installations, 1e-12, 'installations')
      near(breakdown.orbital.value, expected.orbital, 1e-12, 'orbital')
      near(breakdown.capacity.value, expected.capacity, 1e-12, 'capacity')
      near(breakdown.rate.value, expected.rate, 1e-12, 'rate')
      assert.deepEqual([breakdown.installations, breakdown.orbital, breakdown.capacity, breakdown.rate].map((result) => result.rule.id), ['terraform.installationOutput', 'terraform.orbitalOutput', 'terraform.capacity', 'production.terraformRate'])
      assert.deepEqual([breakdown.installations, breakdown.orbital, breakdown.capacity, breakdown.rate].map((result) => result.rule.versions), [['3.2.x'], ['3.2.x'], ['3.2.x'], ['3.2.x']], 'the four rules hold for the line of the played saves')
      assert.ok(breakdown.lines.some((line) => line.key === 'admin0' && Math.abs(line.value - 1.01) < 1e-12))
    },
  },
  unknown: {
    needs: [],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const at = (changes, { raceRate = 0.001, speed = 500, admins = { 1: adminOf() } } = {}) => terraformBreakdown({ raceRate, speed, source: { ...handSource(), ...changes }, admins })
      const ship = (changes) => ({ ...handSource().ships[0], ...changes })
      const unavailable = (breakdown, term, pattern, what) => {
        assert.equal(breakdown[term].status, 'unavailable', what)
        assert.ok(pattern.test(missingOf(breakdown[term])), `${what}: ${missingOf(breakdown[term])}`)
      }

      unavailable(at({ ships: [ship({ crew: null })] }), 'orbital', /crew/, 'unknown crew')
      unavailable(at({ ships: [ship({ modules: null })] }), 'orbital', /modules/, 'unknown modules')
      unavailable(at({ ships: [ship({ captain: null, captained: false })] }), 'orbital', /captain/, 'unknown captain bonus')
      unavailable(at({}, { admins: { 1: adminOf({ BonusValue: null, Unknown: 'FCT_Commander.RankID' }) } }), 'orbital', /RankID/, 'unknown admin chain')
      unavailable(at({ shipsKnown: false, ships: [] }), 'orbital', /assigned to the colony/, 'unknown fleet assignment')
      unavailable(at({ installations: null }), 'installations', /installations/, 'unknown installations')
      unavailable(at({ modifier: { ...handSource().modifier, governor: null } }), 'installations', /governor/, 'unknown governor')
      unavailable(at({ modifier: { ...handSource().modifier, efficiency: null } }), 'installations', /efficiency/, 'unknown efficiency')
      unavailable(at({ modifier: { ...handSource().modifier, unrest: null } }), 'installations', /stability/, 'unknown unrest')
      unavailable(at({ radius: null }), 'rate', /radius/, 'unknown radius')
      unavailable(at({}, { speed: null }), 'capacity', /speed/, 'unknown speed')
      unavailable(at({}, { raceRate: null }), 'installations', /rate/, 'unknown race rate')

      const none = at({ installations: 0, ships: [], modifier: { governor: null, sector: null, efficiency: null, radiation: null, unrest: null, status: null } })

      assert.equal(none.installations.status, 'estimated')
      assert.equal(none.installations.value, 0)
      assert.equal(none.orbital.value, 0)
    },
  },
  'bonus value missing: governor and sector': {
    needs: [FIXTURE.file],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const copy = mutatedOf(FIXTURE.file, [...await governedColony(modules), 'update FCT_CommanderBonuses set BonusValue = null where BonusID = 9'])
      const commands = (type) => `select FCT_Commander.CommandID from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 9 where FCT_Commander.GameID = ${FIXTURE_CASE.game} and FCT_Commander.RaceID = ${FIXTURE_CASE.race} and FCT_Commander.CommandType = ${type}`

      try {
        const governors = new Set((await copy.query(commands(3)))[0].map((row) => row.CommandID))
        const sectored = new Set((await copy.query(`select FCT_Population.PopulationID from FCT_Population inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID where FCT_Population.GameID = ${FIXTURE_CASE.game} and FCT_Population.RaceID = ${FIXTURE_CASE.race} and FCT_RaceSysSurvey.SectorID in (${commands(4)})`))[0].map((row) => row.PopulationID))
        const sources = await loadTerraformSources(copy, { GameID: FIXTURE_CASE.game, RaceID: FIXTURE_CASE.race })
        const colonies = Object.values(sources.colonies)

        assert.ok(governors.size > 0 && sectored.size > 0, 'the save needs governors and a sector commander with a Terraforming bonus')

        for (const colony of colonies) {
          assert.equal(colony.modifier.governor, governors.has(colony.PopulationID) ? null : 1, `${colony.PopName} governor`)
          assert.equal(colony.modifier.sector, sectored.has(colony.PopulationID) ? null : 1, `${colony.PopName} sector`)
        }

        for (const [what, found] of [['governor', colonies.find((colony) => colony.installations > 0 && governors.has(colony.PopulationID))], ['sector', colonies.find((colony) => colony.installations > 0 && sectored.has(colony.PopulationID))]]) {
          assert.ok(found, `a colony with installations and a ${what} row`)

          const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: found })

          assert.equal(breakdown.installations.status, 'unavailable', what)
          assert.ok(new RegExp(what).test(missingOf(breakdown.installations)), `${what}: ${missingOf(breakdown.installations)}`)
        }
      } finally {
        copy.close()
      }
    },
  },
  'sector association missing': {
    needs: [FIXTURE.file],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const plant = await governedColony(modules)
      const run = async (statements) => {
        const copy = mutatedOf(FIXTURE.file, [...plant, ...statements])

        try {
          return await loadTerraformSources(copy, { GameID: FIXTURE_CASE.game, RaceID: FIXTURE_CASE.race })
        } finally {
          copy.close()
        }
      }
      const base = await run([])
      const target = Object.values(base.colonies).find((colony) => colony.installations > 0 && colony.modifier.sector > 1)
      const other = Object.values(base.colonies).find((colony) => colony.SystemID !== target.SystemID && colony.modifier.sector !== null)
      const rateOf = (sources, colony) => terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[colony.PopulationID] }).installations

      assert.ok(target && other, 'the save needs a colony with a sector bonus above 1 and one elsewhere')

      const lost = await run([`update FCT_RaceSysSurvey set SectorID = null where RaceID = ${FIXTURE_CASE.race} and SystemID = ${target.SystemID}`])

      assert.equal(lost.colonies[target.PopulationID].modifier.sector, null)
      assert.equal(rateOf(lost, target).status, 'unavailable')
      assert.ok(/sector/.test(missingOf(rateOf(lost, target))), missingOf(rateOf(lost, target)))
      assert.equal(lost.colonies[other.PopulationID].modifier.sector, other.modifier.sector)

      const none = await run([`update FCT_RaceSysSurvey set SectorID = 0 where RaceID = ${FIXTURE_CASE.race} and SystemID = ${target.SystemID}`])

      assert.equal(none.colonies[target.PopulationID].modifier.sector, 1)
      assert.equal(rateOf(none, target).status, 'estimated', missingOf(rateOf(none, target)))

      const dropped = await run(['alter table FCT_RaceSysSurvey drop column SectorID'])

      assert.ok(Object.values(dropped.colonies).every((colony) => colony.modifier.sector === null), 'every colony has an unknown sector without the column')
      assert.equal(rateOf(dropped, target).status, 'unavailable')
    },
  },
  'admin bonus missing: terraforming': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const base = await adminsOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const copy = mutatedOf(PLAYED.file, ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 9 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 12)'])

      try {
        const admins = await modules['naval-admins'].loadNavalAdmins(copy, { GameID: PLAYED_CASE.game, RaceID: PLAYED_CASE.race, bonusId: 9, share: 'Industrial' })
        const chained = Object.values(sources.colonies).filter((colony) => terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: colony, admins: base }).lines.some((line) => /^admin/.test(line.key) && line.value !== null && line.value !== 1))

        assert.ok(chained.length > 0, 'the save needs a colony whose orbital output rests on an admin bonus')
        assert.ok(Object.keys(admins).length > 0, 'a map of valueless bonuses is not empty')

        for (const colony of chained) {
          const orbital = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: colony, admins }).orbital

          assert.equal(orbital.status, 'unavailable', colony.PopName)
          assert.ok(/bonus, or the share of its command type/.test(missingOf(orbital)), `${colony.PopName}: ${missingOf(orbital)}`)
        }
      } finally {
        copy.close()
      }
    },
  },
  'admin bonus missing: another consumer': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const { loadNavalAdmins } = modules['naval-admins']
      const { navalAdminChain, orbitalChainGap, orbitalMinerRate } = modules.minerals
      const base = await loadNavalAdmins(databaseOf(PLAYED.file), { GameID: PLAYED_CASE.game, RaceID: PLAYED_CASE.race, bonusId: 6, share: 'Industrial' })
      const copy = mutatedOf(PLAYED.file, ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 6 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 12)'])

      try {
        const admins = await loadNavalAdmins(copy, { GameID: PLAYED_CASE.game, RaceID: PLAYED_CASE.race, bonusId: 6, share: 'Industrial' })
        const found = Object.values(base).flatMap((admin) => [...admin.Systems].map((system) => ({ system, command: admin.NavalAdminCommandID }))).find(({ system, command }) => {
          const chain = navalAdminChain(base, system, command)

          return chain.unknown === null && chain.bonus !== 1
        })

        assert.ok(found, 'the save needs a miner position whose chain rests on a Mining bonus')

        const row = { Diameter: 1, MaximumOrbitalMiningDiameter: 2, SystemID: found.system, NavalAdminCommandID: found.command }

        assert.equal(navalAdminChain(admins, found.system, found.command).bonus, null)
        assert.ok(/bonus, or the share of its command type/.test(orbitalChainGap(row, admins)), String(orbitalChainGap(row, admins)))
        assert.equal(orbitalMinerRate(row, admins), null)
      } finally {
        copy.close()
      }
    },
  },
  'shared rule: fixture': {
    needs: [FIXTURE.file],
    run: (modules) => assertSharedRule(modules, databaseOf(FIXTURE.file), FIXTURE_CASE, 'fixture'),
  },
  'shared rule: played': {
    needs: [PLAYED.file],
    run: (modules) => assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played'),
  },
  'planted: an assigned fleet away from its colony counts nothing': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const base = await assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played')
      const held = Object.values(base.sources.colonies).find((source) => source.ships.length > 0)

      assert.ok(held && base.breakdowns[held.PopulationID].capacity.value > 0, 'the played save needs a terraformer fleet at its colony')

      const away = mutatedOf(PLAYED.file, [`update FCT_Fleet set Xcor = Xcor + 1000, Ycor = Ycor + 1000 where FleetID = ${held.ships[0].FleetID}`])

      try {
        const planted = await assertSharedRule(modules, away, PLAYED_CASE, 'away')

        assert.deepEqual(planted.sources.colonies[held.PopulationID].ships.map((ship) => ship.ShipID), [], 'the fleet away from its colony counted')
        assert.equal(planted.breakdowns[held.PopulationID].orbital.value, 0, 'the fleet away from its colony')
      } finally {
        away.close()
      }
    },
  },
  'planted: an unassigned fleet at the colony is counted': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const base = await assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played')
      const held = Object.values(base.sources.colonies).find((source) => source.ships.length > 0)

      assert.ok(held, 'the played save needs a terraformer fleet at its colony')

      const fleetId = held.ships[0].FleetID
      const ships = held.ships.filter((ship) => ship.FleetID === fleetId).map((ship) => ship.ShipID)
      const free = mutatedOf(PLAYED.file, [`update FCT_Fleet set AssignedPopulationID = 0 where FleetID = ${fleetId}`])

      try {
        const planted = await assertSharedRule(modules, free, PLAYED_CASE, 'unassigned')
        const listed = planted.sources.colonies[held.PopulationID].ships

        assert.deepEqual(listed.map((ship) => ship.ShipID), ships, 'the unassigned fleet at the colony')
        assert.ok(listed.every((ship) => !ship.contested), 'the unassigned fleet is at one colony')
        near(planted.breakdowns[held.PopulationID].capacity.value, base.breakdowns[held.PopulationID].capacity.value, 1e-12, 'the unassigned fleet at the colony')
      } finally {
        free.close()
      }
    },
  },
  'planted: a fleet the game may give to two colonies leaves the term unavailable': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const base = await assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played')
      const held = Object.values(base.sources.colonies).find((source) => source.ships.length > 0)
      const other = held ? Object.values(base.sources.colonies).find((source) => source.PopulationID !== held.PopulationID && Number.isFinite(source.Xcor) && Number.isFinite(source.Ycor)) : null

      assert.ok(held && other, 'the played save needs a colony with a terraformer fleet and another colony of the race')

      const fleetId = held.ships[0].FleetID
      const contested = mutatedOf(PLAYED.file, [`update FCT_Fleet set AssignedPopulationID = 0 where FleetID = ${fleetId}`, `update FCT_SystemBody set Xcor = ${held.Xcor}, Ycor = ${held.Ycor} where SystemBodyID = ${other.SystemBodyID}`])

      try {
        const planted = await assertSharedRule(modules, contested, PLAYED_CASE, 'ambiguous')

        for (const source of [held, other]) {
          const breakdown = planted.breakdowns[source.PopulationID]

          assert.equal(breakdown.orbital.status, 'unavailable', `${source.PopName}: ${missingOf(breakdown.orbital)}`)
          assert.ok(/which colony of the race/.test(missingOf(breakdown.orbital)), `${source.PopName}: ${missingOf(breakdown.orbital)}`)
          assert.ok(planted.sources.colonies[source.PopulationID].ships.some((ship) => ship.contested), `${source.PopName}: contested`)
        }
      } finally {
        contested.close()
      }
    },
  },
  'one-year: the played colony against the game\'s Environment tab': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const { hasTerraformers, oneYearEstimate, terraformBreakdown } = modules['terraform-capacity']
      const database = databaseOf(PLAYED.file)
      const sources = await sourcesOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const admins = await adminsOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const bodies = await modules['colonization-data'].loadBodies(database, { GameID: PLAYED_CASE.game, RaceID: PLAYED_CASE.race })
      const rows = await oneYearRows(database, PLAYED_CASE.game)
      // The capacity is the working of the shared rule (the installations, the fleets at the colony, the modifiers and the game's speed from the save's rows); the naval admin chain's multiplier is the one factor taken from the app, as in that working.
      const expected = await sharedCapacityOf(database, { game: PLAYED_CASE.game, race: PLAYED_CASE.race, chainOf: (system, command) => modules.minerals.navalAdminChain(admins, system, command).bonus })
      let compared = 0

      for (const source of Object.values(sources.colonies).filter(hasTerraformers)) {
        const population = await firstOf(PLAYED.file, 'select * from FCT_Population where GameID = ? and PopulationID = ?', PLAYED_CASE.game, source.PopulationID)
        const { Radius: radius } = await firstOf(PLAYED.file, 'select Radius from FCT_SystemBody where GameID = ? and SystemBodyID = ?', PLAYED_CASE.game, population.SystemBodyID)
        const yearly = expected.colonies[population.PopulationID].capacity * EARTH_ATMOSPHERE_UNITS / (4 * PI * radius ** 2)
        const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source, admins })
        const found = oneYearEstimate(bodies.find((row) => row.SystemBodyID === population.SystemBodyID), rate)
        const entry = rows.get(population.SystemBodyID)
        const tab = tabOf(entry, yearly)

        assert.ok(yearly > 0 && found && found.status === 'estimated', `${source.PopName}: ${found ? missingOf(found) : 'no line for a colony that moves pressure'}`)
        near(found.value.rate, yearly, 1e-9, `${source.PopName}: the yearly pressure on the body`)
        assert.ok(Math.abs(tab.surface - entry.row.SurfaceTemp) < 1e-6, `${source.PopName}: the working's temperature now ${tab.surface}, saved ${entry.row.SurfaceTemp}`)
        assertTab(found.value, tab, source.PopName)
        compared += 1
      }

      assert.ok(compared > 0, 'no colony with terraformers')
    },
  },
  'one-year: every body of the two saves': {
    needs: [PLAYED.file, FIXTURE.file],
    run: async (modules) => {
      const { oneYearEstimate } = modules['terraform-capacity']
      const rates = [0.0004, 0.05, 2].map((yearly) => rateOf(modules, yearly))
      const seen = { compared: 0, unavailable: 0, frozen: 0, moons: 0, eccentric: 0, capped: 0, falls: 0 }

      for (const [file, { game, race }] of [[PLAYED.file, PLAYED_CASE], [FIXTURE.file, FIXTURE_CASE]]) {
        const database = databaseOf(file)
        const bodies = await modules['colonization-data'].loadBodies(database, { GameID: game, RaceID: race })
        const rows = await oneYearRows(database, game)

        for (const body of bodies) {
          const entry = rows.get(body.SystemBodyID)

          for (const rate of rates) {
            const found = oneYearEstimate(body, rate)
            const tab = tabOf(entry, rate.value)

            if (!tab) {
              assert.equal(found.status, 'unavailable', `${file} ${body.SystemBodyID}: a figure the tab reads is not in the save`)
              seen.unavailable += 1
              continue
            }

            assert.equal(found.status, 'estimated', `${file} ${body.SystemBodyID}: ${missingOf(found)}`)
            assertTab(found.value, tab, `${file} ${body.SystemBodyID}`)
            seen.compared += 1
            seen.frozen += entry.frozen > 0 ? 1 : 0
            seen.moons += entry.row.BodyClass === 2 ? 1 : 0
            seen.eccentric += (entry.row.BodyClass === 2 ? entry.row.ParentEccentricity : entry.row.Eccentricity) > 0 ? 1 : 0
            seen.capped += tab.capped ? 1 : 0
            seen.falls += found.value.aestusium.text.startsWith('-') ? 1 : 0
          }
        }
      }

      assert.ok(seen.compared > 10000, `${seen.compared} lines compared`)
      assert.ok(seen.frozen > 0 && seen.moons > 0 && seen.eccentric > 0 && seen.capped > 0 && seen.falls > 0, `the saves cover frozen gases, moons, eccentric orbits, the cap of 3 and a fall under Aestusium: ${JSON.stringify(seen)}`)
    },
  },
  'one-year: planted cases': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const { hasTerraformers, oneYearEstimate, terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const admins = await adminsOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const held = Object.values(sources.colonies).find(hasTerraformers)
      const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: held, admins })
      const { p: parent } = await firstOf(PLAYED.file, 'select ParentBodyID p from FCT_SystemBody where GameID = ? and SystemBodyID = ?', PLAYED_CASE.game, held.SystemBodyID)
      const at = held.SystemBodyID
      const game = PLAYED_CASE.game
      const read = async (statements) => {
        const copy = mutatedOf(PLAYED.file, statements)

        try {
          const body = (await modules['colonization-data'].loadBodies(copy, { GameID: game, RaceID: PLAYED_CASE.race })).find((row) => row.SystemBodyID === at)
          const entry = (await oneYearRows(copy, game)).get(at)
          const tab = tabOf(entry, rate.value)
          const found = oneYearEstimate(body, rate)

          assert.equal(found.status, 'estimated', missingOf(found))
          assertTab(found.value, tab, 'planted')

          return { body, entry, tab, found: found.value }
        } finally {
          copy.close()
        }
      }
      const plain = await read([])

      // The tab sums the gases that are not frozen out: a frozen greenhouse gas moves neither the temperature now nor an estimate.
      const frozen = await read([insertGas(game, at, 20, 0.4, 1)])

      assert.equal(frozen.tab.surface, plain.tab.surface, 'a frozen gas leaves the temperature now')
      assert.equal(frozen.tab.aestusium, plain.tab.aestusium, 'and the Aestusium estimate')
      assert.equal(frozen.found.aestusium.temperature, plain.found.aestusium.temperature)

      // Greenhouse and anti-greenhouse gas past the cap of 3: more gas moves nothing, so the Aestusium estimate is the base temperature times the albedo, and the Frigusium estimate too.
      const capped = await read([insertGas(game, at, 20, 2.5, 0), insertGas(game, at, 22, 2.5, 0)])

      assert.ok(capped.tab.capped, 'both factors stand at the cap')
      assert.ok(Math.abs(capped.found.aestusium.temperature - capped.tab.base * capped.entry.row.Albedo) < 1e-9, 'the capped greenhouse factor against the capped anti-greenhouse factor')
      assert.ok(Math.abs(capped.found.frigusium.temperature - capped.tab.base * capped.entry.row.Albedo) < 1e-9)
      assert.notEqual(capped.found.current, plain.found.current, 'the temperature now follows the gases the save lists, not the temperature it kept')

      // Dust adds to the anti-greenhouse factor.
      const dusty = await read([`update FCT_SystemBody set DustLevel = 6000 where SystemBodyID = ${at}`])

      assert.notEqual(dusty.tab.surface, plain.tab.surface, 'dust cools the body')
      assert.ok(dusty.found.frigusium.temperature < plain.found.frigusium.temperature)

      // A moon takes its planet's orbit: the planet's distance now sets the base temperature, its orbital distance the circular temperature the dampening blends in, and only the temperature now has the blend (the tab's estimates have none).
      const closer = `update FCT_SystemBody set DistanceToParent = 0.5 where SystemBodyID = ${parent}`
      const blended = await read([closer])
      const circular = await read([closer, `update FCT_SystemBody set Eccentricity = 0 where SystemBodyID = ${parent}`])

      assert.notEqual(blended.tab.surface, plain.tab.surface, 'the planet\'s distance now sets the moon\'s base temperature')
      assert.notEqual(blended.tab.surface, circular.tab.surface, 'the planet\'s eccentricity switches the dampening on')
      assert.equal(blended.tab.aestusium, circular.tab.aestusium, 'the estimate has no dampening')
      assert.equal(blended.tab.frigusium, circular.tab.frigusium)

      // No pressure moved: no line. A figure the tab reads missing: unavailable and named, never a default. A rate that is unavailable: the same.
      assert.equal(oneYearEstimate(plain.body, rateOf(modules, 0)), null, 'a colony that moves no pressure has no line')

      for (const [label, body, named] of [['albedo', { ...plain.body, Albedo: null }, 'albedo'], ['base temperature', { ...plain.body, BaseTemp: undefined }, 'base temperature'], ['dust level', { ...plain.body, DustLevel: undefined }, 'dust level']]) {
        const missing = oneYearEstimate(body, rate)

        assert.equal(missing.status, 'unavailable', `a body without its ${label}`)
        assert.ok(missing.inputs.missing.some((text) => text.includes(named)), `names the ${label}: ${missingOf(missing)}`)
      }

      const unknown = oneYearEstimate(plain.body, rateOf(modules, null))

      assert.equal(unknown.status, 'unavailable', 'a colony whose rate is not known')
      assert.ok(/terraforming rate/.test(missingOf(unknown)), missingOf(unknown))
    },
  },
  'planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step': {
    needs: [FIXTURE.file],
    run: async (modules) => {
      const data = modules['colonization-data']
      const ask = { GameID: FIXTURE_CASE.game, RaceID: FIXTURE_CASE.race }
      const base = databaseOf(FIXTURE.file)
      const [species] = await data.loadSpecies(base, ask)
      const chosen = (await data.loadBodies(base, ask)).find((row) => row.BodyClass === 1 && !row.OwnPopulations.length && !row.AlienPopulations.length)
      // A planet of the fixture's with the air and the water taken off, on an orbit of eccentricity 0.3 whose present distance gives a base temperature of 250 K, and a species that lives between 258 and 318 K, breathes oxygen at 0.1 to 0.3 atm and bears 4 atm: its mean can be reached with gases, its extremes cannot.
      const distance = Math.sqrt(chosen.StarLuminosity) * (255 / 250) ** 2
      const copy = mutatedOf(FIXTURE.file, [
        `update FCT_SystemBody set Radius = 6371, Gravity = 1, AtmosPress = 0, HydroExt = 0, HydroID = 1, Albedo = 1, DustLevel = 0, TidalLock = 0, Eccentricity = 0.3, OrbitalDistance = ${distance}, DistanceToParent = ${distance}, Year = 8760 where SystemBodyID = ${chosen.SystemBodyID}`,
        `delete from FCT_AtmosphericGas where SystemBodyID = ${chosen.SystemBodyID}`,
        `update FCT_Species set Temperature = 288, TempDev = 30, Oxygen = 0.2, OxyDev = 0.1, PressMax = 4, Gravity = 1, GravDev = 0.5, BreatheID = 10 where SpeciesID = ${species.SpeciesID}`,
      ])

      try {
        const body = (await data.loadBodies(copy, ask)).find((row) => row.SystemBodyID === chosen.SystemBodyID)
        const limits = modules.habitability.speciesLimits((await data.loadSpecies(copy, ask)).find((row) => row.SpeciesID === species.SpeciesID))
        const { ColonizationSkill: skill } = await data.loadRaceRules(copy, ask)
        const gases = Object.fromEntries((await data.loadGases(copy)).map((row) => [row.GasID, { AtmosGasID: row.GasID, AtmosGasName: row.Name, ...row }]))
        const gasInfo = (id) => gases[id]
        const assessment = modules.terraforming.assessTerraforming(body, limits, skill, gasInfo)
        const { plan } = assessment
        const { stages } = modules['terraform-limits'].terraformStages({ assessment, body, species: limits, skill, gasInfo })
        const range = { low: limits.MinimumTemperature, high: limits.MaximumTemperature }

        // The mean is tolerable, and so is the whole orbit once the plan has pulled its lever; the gases alone leave an extreme outside the range.
        assert.equal(body.Eccentricity, 0.3)
        assert.equal(assessment.outcome, 'yes', 'the plan fits the whole orbit')
        assert.ok(plan && !plan.partial, 'no temperature limit is kept')
        assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 })
        assert.ok(plan.target.temperature >= range.low && plan.target.temperature <= range.high, 'the mean the plan reaches is in the range')
        assert.ok(stages[0].extremes.apoapsis < range.low, 'the body starts with its cold end under the range')

        const gasesOnly = stages[stages.length - 2]

        assert.ok(gasesOnly.extremes.periapsis > range.high, 'after every gas operation the hot end is still over the range')

        // The dampening step: proposed, named in its step and its stage, with its effect on both extremes, priced like the other steps and carrying the time basis.
        assert.ok(plan.dampening && plan.dampening.levers.length > 0, 'the plan names its levers')

        const lever = plan.steps.find((step) => step.lever)
        const area = 4 * PI * body.Radius ** 2 / EARTH_ATMOSPHERE_UNITS
        const end = stages[stages.length - 1]

        assert.ok(lever && lever.work > 0, 'a step pulls a lever and is work')

        for (const step of plan.steps) {
          assert.ok(Math.abs(step.work / (step.atm * area) - 1) < 1e-5, `${step.label}: work ${step.work}, rule ${step.atm * area}`)
        }

        assert.ok(Math.abs(plan.work / plan.steps.reduce((total, step) => total + step.atm * area, 0) - 1) < 1e-5, 'the plan\'s work is its steps\'')
        assert.equal(stages.find((stage) => stage.step && stage.step.key === lever.key).lever, lever.lever, 'the stage of the step names the lever')
        assert.equal(end.lever, 'water', 'the stage that settles the added vapour names the surface water')
        assert.ok(end.effect.dampening.to > end.effect.dampening.from && end.hydroExt === 100, 'and shows it raise the dampening with the whole surface under water')
        assert.ok(end.extremes.periapsis <= range.high && end.extremes.apoapsis >= range.low, 'both ends of the orbit end in the range')
        assert.ok(stages.every((stage) => stage.step ? stage.timeBasis === 'capacity' : stage.timeBasis === null), 'each operation carries the capacity basis, the end state none')
        assert.equal(end.cost.raw, assessment.after.raw, 'the last stage is the plan\'s cost after terraforming')
      } finally {
        copy.close()
      }
    },
  },
}

// Faults planted in the shared helper. `fails` names the BREAKDOWN_CHECKS each must break; a fault whose named checks all lack their saves is skipped.
const BREAKDOWN_FAULTS = [
  { label: 'the fleet position test dropped', from: 'if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', to: 'if (fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', fails: ['planted: an assigned fleet away from its colony counts nothing'] },
  { label: 'an unassigned fleet at the colony ignored', from: 'if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', to: 'if (fleet.AssignedPopulationID === colony.PopulationID && fleetPlaced(fleet, colony) && fleetCountsForColony(fleet, colony)) {', fails: ['planted: an unassigned fleet at the colony is counted'] },
  { label: 'an ambiguous fleet resolved silently', from: 'contested: reach.length > 1', to: 'contested: false', fails: ['planted: a fleet the game may give to two colonies leaves the term unavailable'] },
  { label: 'the rules labelled for the earlier line', from: "const VERSIONS = ['3.2.x']", to: "const VERSIONS = ['2.7.x']", fails: ['arith'] },
  { label: 'installation sum not rounded down', from: 'raceRate * Math.trunc(source.installations) * modifier.value', to: 'raceRate * source.installations * modifier.value', fails: ['arith'] },
  { label: 'Math.PI for the body area', from: 'export const SURFACE_PI = 3.1416', to: 'export const SURFACE_PI = Math.PI', fails: ['arith'] },
  { label: 'game speed ignored', from: '(values.installations + values.orbital) * speed / 100', to: '(values.installations + values.orbital)', fails: ['arith'] },
  { label: 'naval admin chain ignored', from: 'group.admin * group.effective', to: 'group.effective', fails: ['arith'] },
  { label: 'crew share ignored', from: 'modules === null || known(ship.crew) === null ? null : modules * ship.crew', to: 'modules === null ? null : modules', fails: ['arith', 'unknown'] },
  { label: 'unknown crew read as 1', from: 'modules === null || known(ship.crew) === null ? null : modules * ship.crew', to: 'modules === null ? null : modules * (known(ship.crew) ?? 1)', fails: ['unknown'] },
  { label: 'unknown captain bonus read as 1', from: 'staffed === null || known(ship.captain) === null ? null : staffed * ship.captain', to: 'staffed === null ? null : staffed * (known(ship.captain) ?? 1)', fails: ['unknown'] },
  { label: 'unknown fleet assignment read as no ships', from: "source.shipsKnown === false ? ['the fleets assigned to the colony'] : []", to: '[]', fails: ['unknown'] },
  { label: 'the sector bonus counted in full', from: '1 + (modifier.sector - 1) / 4', to: 'modifier.sector', fails: ['arith'] },
  { label: 'a missing captain read as 0', from: ': null) : 1)', to: ': null) : 0)', fails: ['shared rule: fixture'] },
  { label: 'a present bonus row without a value read as 1 (governor)', from: 'governor: row.BonusUnknown ? null : bonusOf(row.GovernorBonus, row.GovernorRows, row.GovernorKnown)', to: 'governor: row.BonusUnknown ? null : row.GovernorBonus ?? 1', fails: ['bonus value missing: governor and sector'] },
  { label: 'a present bonus row without a value read as 1 (sector)', from: 'sector: row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(row.SectorBonus, row.SectorRows, row.SectorKnown)', to: 'sector: row.BonusUnknown ? null : row.SectorBonus ?? 1', fails: ['bonus value missing: governor and sector'] },
  { label: 'an unknown sector association read as no sector', from: 'row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(', to: 'row.BonusUnknown ? null : bonusOf(', fails: ['sector association missing'] },
  { label: 'an explicit no-sector read as unknown', from: 'row.SectorID === 0 ? 1 : bonusOf(', to: 'row.SectorID === 0 ? null : bonusOf(', fails: ['sector association missing'] },
  { module: 'naval-admins', label: 'a naval admin bonus row without a value read as neutral', from: 'admin.BonusRow && !(Number.isFinite(admin.BonusValue) && Number.isFinite(admin.Share)) ? BONUS_UNKNOWN : null', to: 'null', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { module: 'naval-admins', label: 'a naval admin map of valueless bonuses returned empty', from: '(admin.BonusValue && admin.Share) || admin.BonusRow', to: 'admin.BonusValue && admin.Share', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { module: 'minerals', label: 'the chain ignores an unknown command bonus', from: 'if (current.BonusUnknown) {', to: 'if (false) {', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { label: 'Frigusium takes the whole year\'s gas as greenhouse gas', from: 'estimate(greenhouse + yearly / 10, anti + yearly)', to: 'estimate(greenhouse + yearly, anti + yearly)', fails: ['one-year: the played colony against the game\'s Environment tab', 'one-year: every body of the two saves'] },
  { label: 'Frigusium adds only a tenth of the year\'s gas as anti-greenhouse gas', from: 'estimate(greenhouse + yearly / 10, anti + yearly)', to: 'estimate(greenhouse + yearly / 10, anti + yearly / 10)', fails: ['one-year: the played colony against the game\'s Environment tab', 'one-year: every body of the two saves'] },
  { label: 'the anti-greenhouse gas left out of the sums', from: 'const anti = sum(unfrozen.map((gas) => (!gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0)))', to: 'const anti = 0', fails: ['one-year: planted cases', 'one-year: every body of the two saves'] },
  { label: 'gases frozen out counted', from: 'const unfrozen = (body.Atmosphere || []).filter((gas) => !gas.FrozenOut)', to: 'const unfrozen = body.Atmosphere || []', fails: ['one-year: planted cases', 'one-year: every body of the two saves'] },
  { label: 'dust left out of the anti-greenhouse factor', from: 'const dust = body.DustLevel / 20000', to: 'const dust = 0', fails: ['one-year: planted cases'] },
  { label: 'the cap of 3 dropped from the estimate', from: 'body.BaseTemp * Math.min(3, 1 + body.AtmosPress / 10 + greenhouseGas) * body.Albedo', to: 'body.BaseTemp * (1 + body.AtmosPress / 10 + greenhouseGas) * body.Albedo', fails: ['one-year: planted cases', 'one-year: every body of the two saves'] },
  { label: 'the temperature now taken as saved, not as the tab recomputes it', from: 'const current = surfaceTemperature(body, Math.min(3, 1 + body.AtmosPress / 10 + greenhouse), Math.min(3, 1 + dust + anti))', to: 'const current = body.SurfaceTemp', fails: ['one-year: planted cases'] },
  { label: 'a plus before every Aestusium figure', from: "label === AESTUSIUM && !figure.startsWith('-') ? '+' : ''", to: "label === AESTUSIUM ? '+' : ''", fails: ['one-year: every body of the two saves'] },
  { label: 'the figure floored, not rounded', from: 'Math.round(Number((Math.abs(value) * 10).toPrecision(15))) / 10', to: 'Math.floor(Number((Math.abs(value) * 10).toPrecision(15))) / 10', fails: ['one-year: the played colony against the game\'s Environment tab', 'one-year: every body of the two saves'] },
  { label: 'a colony that moves no pressure gets a line', from: 'if (!(rate.value > 0)) {', to: 'if (false) {', fails: ['one-year: planted cases'] },
  { module: 'terraforming', label: 'no dampening lever is ever pulled', from: 'return plan && plan.partial && reached ? raisedDampening(body, species, gasInfo, plan) || plan : plan', to: 'return plan', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
  { module: 'terraforming', label: 'a lever step is priced at half its atm', from: 'work: (Math.abs(to - from) + off / HYDRO_PER_ATM) * areaRatio })', to: 'work: (Math.abs(to - from) + off / HYDRO_PER_ATM) * areaRatio * (pulled ? 0.5 : 1) })', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
  { module: 'terraforming', label: 'the water step never names its lever', from: 'raisedWater ? LEVER.WATER : null', to: 'null', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
  { module: 'terraform-limits', label: 'the stage that settles the water does not name it', from: 'lever: waterLever ? LEVER.WATER : null', to: 'lever: null', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
]

// Public seams: the Production page's jobs catch omissions from the count and timeline; terraformFinish catches wrong stop cycles and climate branches. These source-arithmetic cases do not claim a played-save finishing-date oracle.
const waterJob = (extra = {}) => ({ Gravity: 1, TerraformStatus: 1, MaxAtm: 0.25, GasName: 'Water Vapour', GasAtm: 0.125, GasAtmUnknown: 0, HydroID: 3, HydroExt: 20, AtmosPress: 1, SurfaceTemp: 369, BaseTemp: 350, Albedo: 1, DustLevel: 0, BodyClass: 1, BodyTypeID: 2, Eccentricity: 0, OrbitalDistance: 1, Year: 8760, StarLuminosity: 1, Atmosphere: [{ AtmosGasID: 7, GasAtm: 0.875, FrozenOut: 0, FreezingPoint: 63, GHGas: 0, AntiGHGas: 0 }, { AtmosGasID: 5, GasAtm: 0.125, FrozenOut: 0, FreezingPoint: 0, GHGas: 0, AntiGHGas: 0 }], ...extra })
const PRODUCTION_CHECKS = [
  {
    id: 'unlimited-job',
    run: ({ page, production }) => {
      const vm = instantiate(page, { $store: { getters: {}, state: {}, dispatch: async () => {} }, data: { terraforms: [{ PopulationID: 1, TerraformStatus: 1, MaxAtm: 0, GasName: 'Oxygen', GasAtm: 0.5 }], terraformSources: { raceRate: 0.001, speed: 100, colonies: { 1: handSource() } }, navalAdmins: { 1: adminOf() }, populationProductionModifiers: { 1: { MinConstructionPeriod: 86400 } }, colony: () => ({ colonyName: 'Test colony', place: '', body: null }) } })

      assert.equal(vm.terraformingJobs.length, 1, 'an adding target of 0 atm still adds gas')
      const [job] = vm.terraformingJobs
      const timeline = production.completionBins([job], { years: 10, bins: 10 }, ['terraforming'])

      assert.equal(job.days, null, 'the running job has no completion date')
      assert.equal(timeline.total, 0)
      assert.deepEqual(timeline.skipped, { unknown: 0, idle: 1, done: 0 }, 'unlimited work is not reported as already done')
    },
  },
  {
    id: 'unlimited-finish',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.1 })
      const finish = production.terraformFinish({ MinConstructionPeriod: 31536000 }, { TerraformStatus: 1, MaxAtm: 0, GasName: 'Oxygen', GasAtm: 0.5 }, rate)

      assert.equal(finish.result.value, null, 'an unlimited addition has no finite completion')
      assert.equal(finish.idle, true, 'the job is omitted from completion bins, not counted as done')
      assert.ok(finish.note.includes('No stop target'))
      assert.equal(production.terraformFinish({}, { GasName: 'Water Vapour', TerraformStatus: 1, MaxAtm: 0 }, rate).result.value, null, 'the zero-target branch needs no climate or period to establish no completion')
    },
  },
  {
    id: 'gravity-finish',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.125 })
      const modifiers = { MinConstructionPeriod: 31536000 }
      const ordinary = { TerraformStatus: 1, MaxAtm: 1, GasName: 'Oxygen', GasAtm: 0.5, GasAtmUnknown: 0 }

      // Population.ProcessTerraforming:1057 returns before any update below Helpers.cs:861's 0.1 g minimum, including clearing empty removals. Equality is eligible; an unknown gravity is not assumed eligible.
      for (const job of [ordinary, waterJob(), ...[null, 0].map((GasAtm) => ({ ...ordinary, TerraformStatus: 0, MaxAtm: 0, GasAtm }))]) {
        const blocked = production.terraformFinish(modifiers, { ...job, Gravity: 0.05 }, rate)

        assert.equal(blocked.result.value, null, '0.05 g cannot complete any selected gas order')
        assert.equal(blocked.idle, true, 'the selected order is not already completed')
        assert.ok(blocked.note.includes('gravity') && blocked.note.includes('No completion'), 'the reason is stated in plain words')
        assert.deepEqual(production.completionBins([{ days: blocked.result.value, finishIdle: blocked.idle }], { years: 10, bins: 10 }, ['terraforming']).skipped, { unknown: 0, idle: 1, done: 0 })

        for (const Gravity of [0.1, 1]) {
          assert.ok(production.terraformFinish(modifiers, { ...job, Gravity }, rate).result.value > 0, `${Gravity} g permits a future finish`)
        }

        for (const Gravity of [null, undefined]) {
          const unknown = production.terraformFinish(modifiers, { ...job, Gravity }, rate)

          assert.equal(unknown.result.value, null)
          assert.equal(unknown.idle, false, 'unknown eligibility is a missing input, not a known stalled order')
          assert.ok(unknown.result.inputs.missing.some((text) => text.includes('gravity')))
        }
      }
    },
  },
  {
    id: 'gravity-inputs',
    needs: [FIXTURE.file],
    run: async ({ page, production }) => {
      const colony = await firstOf(FIXTURE.file, `select PopulationID, SystemBodyID from FCT_Population where GameID = ${FIXTURE.gameId} and RaceID = ${FIXTURE.raceId} and SystemBodyID > 0 limit 1`)
      const copy = mutatedOf(FIXTURE.file, [`update FCT_SystemBody set Gravity = 0.05 where SystemBodyID = ${colony.SystemBodyID}`])

      try {
        const terraform = { PopulationID: colony.PopulationID, TerraformStatus: 1, MaxAtm: 1, GasName: 'Oxygen', GasAtm: 0.5, GasAtmUnknown: 0, Gravity: 1 }
        const vm = instantiate(page, { $store: { getters: {}, state: {}, dispatch: async () => {} }, database: copy, GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId, data: { terraforms: [terraform], navalAdmins: { 1: adminOf() }, populationProductionModifiers: { [colony.PopulationID]: { MinConstructionPeriod: 31536000 } }, colony: () => ({ colonyName: 'Test colony', place: '', body: null }) } })

        for (const gravity of [0.05, 0.1, 1, null]) {
          await copy.query(`update FCT_SystemBody set Gravity = ${gravity === null ? 'null' : gravity} where SystemBodyID = ${colony.SystemBodyID}`)
          const sources = await vm.runAsync('terraformSources')

          vm.terraformSources = { raceRate: 0.001, speed: 100, colonies: { [colony.PopulationID]: { ...handSource(), gravity: sources.colonies[colony.PopulationID].gravity } } }
          assert.equal(vm.terraformingJobs.length, 1, 'a selected order is kept even when it cannot advance')
          const [job] = vm.terraformingJobs
          const bins = production.completionBins([job], { years: 10, bins: 10 }, ['terraforming'])

          assert.ok(job.rateResult.value > 0, 'the real capacity producer supplies positive held capacity')

          if (gravity === 0.05) {
            assert.equal(job.days, null, 'the page uses the saved low gravity, not merely positive capacity')
            assert.ok(job.status.note?.includes('No completion') && job.status.note.includes('gravity'), 'the page identifies known blocked gravity rather than missing eligibility')
            assert.deepEqual(bins.skipped, { unknown: 0, idle: 1, done: 0 })
          } else if (gravity === null) {
            assert.equal(job.days, null, 'unknown saved gravity never means eligible')
            assert.ok(job.finishResult.inputs.missing.some((text) => text.includes('gravity')))
            assert.deepEqual(bins.skipped, { unknown: 1, idle: 0, done: 0 })
          } else {
            assert.ok(job.days > 0, 'the minimum and above permit a finite finish')
            assert.equal(bins.total + bins.later, 1)
          }
        }
      } finally {
        copy.close()
      }
    },
  },
  {
    id: 'target-cycle',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.125 })
      const modifiers = { MinConstructionPeriod: 31536000 }
      const job = { Gravity: 1, TerraformStatus: 1, MaxAtm: 1, GasName: 'Oxygen', GasAtm: 0.5 }

      assert.equal(production.terraformFinish(modifiers, job, rate).result.value, 1825, '0.5 + 4 × 0.125 = 1 is not past the adding target; the fifth year stops')
      assert.equal(production.terraformFinish(modifiers, { ...job, TerraformStatus: 0, GasAtm: 1.5 }, rate).result.value, 1460, 'removing stops on equality after four years')
      assert.equal(production.terraformFinish(modifiers, { ...job, GasAtm: null, GasAtmUnknown: 0, MaxAtm: 0.0625 }, rate).result.value, 730, 'the first increment creates a missing gas; the second checks its target')
      assert.deepEqual([...provenance.getRule('production.jobCount').versions], ['3.2.x'])
      assert.deepEqual([...provenance.getRule('production.terraformFinish').versions], ['3.2.x'])
      assert.deepEqual([...provenance.getRule('production.timeline').versions], ['2.7.x'], 'the broad timeline still depends on unrepaired research, training and industrial forecasts')
    },
  },
  {
    id: 'decimal-add',
    run: ({ page, production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.1 })
      const terraform = { PopulationID: 1, Gravity: 1, TerraformStatus: 1, MaxAtm: 0.6, GasName: 'Oxygen', GasAtm: 0.3 }
      const modifiers = { MinConstructionPeriod: 31536000 }

      // Population.ProcessTerraforming:1098-1099: repeated double additions give 0.4, 0.5, 0.6, 0.7; equality on the third increment does not stop addition.
      assert.equal(production.terraformFinish(modifiers, terraform, rate).result.value, 1460, 'non-binary addition needs four increments, not the quotient-rounded three')
      assert.equal(production.terraformFinish(modifiers, { ...terraform, GasAtm: 0.1, MaxAtm: 0.3 }, rate).result.value, 730, '0.1 + 0.1 + 0.1 exceeds 0.3 after two updates; no blanket extra increment or rounding')
      const source = { installations: 1, radius: 1, gravity: 1, modifier: { governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 }, ships: [] }
      const vm = instantiate(page, { $store: { getters: {}, state: {}, dispatch: async () => {} }, data: { terraforms: [terraform], terraformSources: { raceRate: 0.1 / (EARTH_ATMOSPHERE_UNITS / (4 * PI)), speed: 100, colonies: { 1: source } }, navalAdmins: {}, populationProductionModifiers: { 1: modifiers }, colony: () => ({ colonyName: 'Test colony', place: '', body: null }) } })
      const [job] = vm.terraformingJobs
      const bins = production.completionBins([job], { years: 6, bins: 6 }, ['terraforming'])

      assert.equal(job.rateResult.value, 0.1, 'the public capacity input gives the stated annual step')
      assert.equal(job.days, 1460)
      assert.deepEqual(bins.counts.terraforming, [0, 0, 0, 0, 1, 0], 'the job lands in year four, not year three')
    },
  },
  {
    id: 'decimal-remove',
    run: ({ page, production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.1 })
      const terraform = { PopulationID: 1, Gravity: 1, TerraformStatus: 0, MaxAtm: 0.3, GasName: 'Oxygen', GasAtm: 0.6 }
      const modifiers = { MinConstructionPeriod: 31536000 }

      // Population.ProcessTerraforming:1074-1077: repeated double subtractions give 0.5, 0.4, 0.30000000000000004, 0.20000000000000004; the third remains above the target.
      assert.equal(production.terraformFinish(modifiers, terraform, rate).result.value, 1460, 'non-binary removal needs four increments, not the quotient-rounded three')
      const source = { installations: 1, radius: 1, gravity: 1, modifier: { governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 }, ships: [] }
      const vm = instantiate(page, { $store: { getters: {}, state: {}, dispatch: async () => {} }, data: { terraforms: [terraform], terraformSources: { raceRate: 0.1 / (EARTH_ATMOSPHERE_UNITS / (4 * PI)), speed: 100, colonies: { 1: source } }, navalAdmins: {}, populationProductionModifiers: { 1: modifiers }, colony: () => ({ colonyName: 'Test colony', place: '', body: null }) } })
      const [job] = vm.terraformingJobs
      const bins = production.completionBins([job], { years: 6, bins: 6 }, ['terraforming'])

      assert.equal(job.rateResult.value, 0.1)
      assert.equal(job.days, 1460)
      assert.deepEqual(bins.counts.terraforming, [0, 0, 0, 0, 1, 0])
    },
  },
  {
    id: 'empty-removal',
    run: ({ page, production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.125 })
      const modifiers = { MinConstructionPeriod: 31536000 }

      // Population.ProcessTerraforming:1065-1088,1107-1110: a selected ordinary-gas removal is cleared only during the next production tick, whether no atmosphere row exists or a present row starts at zero pressure.
      for (const GasAtm of [null, 0]) {
        const terraform = { Gravity: 1, PopulationID: 1, TerraformStatus: 0, MaxAtm: 0, GasName: 'Oxygen', GasAtm, GasAtmUnknown: 0 }

        assert.equal(production.terraformFinish(modifiers, terraform, rate).result.value, 365, `${GasAtm === null ? 'absent' : 'present-zero'} gas still needs the first assumed increment to clear the selected order`)
        const vm = instantiate(page, { $store: { getters: {}, state: {}, dispatch: async () => {} }, data: { terraforms: [terraform], terraformSources: { raceRate: 0.001, speed: 100, colonies: { 1: handSource() } }, navalAdmins: { 1: adminOf() }, populationProductionModifiers: { 1: modifiers }, colony: () => ({ colonyName: 'Test colony', place: '', body: null }) } })

        assert.equal(vm.terraformingJobs.length, 1, 'the selected removal remains visible before the tick')
        const [job] = vm.terraformingJobs
        const timeline = production.completionBins([job], { years: 4, bins: 2 }, ['terraforming'])

        assert.equal(job.status.id, 'running', 'the selected order is still running')
        assert.equal(job.rateNote, 'Removing')
        assert.equal(job.days, 365, 'the displayed finish is the next assumed increment')
        assert.equal(timeline.total, 1)
        assert.deepEqual(timeline.counts.terraforming, [1, 0])
        assert.deepEqual(timeline.skipped, { unknown: 0, idle: 0, done: 0 }, 'the timeline must not count the selected order as already done')
      }
    },
  },
  {
    id: 'water-temperature',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.125 })
      const modifiers = { MinConstructionPeriod: 31536000 }

      // At 369 K the first cycle condenses 0.1 atm: gas 0.025, pressure 0.9, hydro 24; adding 0.125 leaves gas 0.15 and pressure 1.025. The source update gives 350 × 1.1025 = 385.875 K and a vapour hydrosphere. Next cycle cannot condense; it evaporates 0.1 atm then adds 0.125, passing 0.25.
      assert.equal(production.terraformFinish(modifiers, waterJob(), rate).result.value, 730, 'the increment warms the body above the condensation gate')
      assert.equal(production.terraformFinish(modifiers, waterJob({ SurfaceTemp: 370, MaxAtm: 0.1875 }), rate).result.value, 365, 'above 369 K the initial cycle cannot condense')
      assert.equal(production.terraformFinish(modifiers, waterJob({ MaxAtm: 0.1875 }), rate).result.value, 730, 'at exactly 369 K the initial cycle does condense')
      assert.equal(production.terraformFinish(modifiers, waterJob({ SurfaceTemp: null }), rate).result.status, 'unavailable', 'an unknown temperature is not a cold body')
    },
  },
  {
    id: 'water-thaw',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.001 })
      const job = waterJob({ MaxAtm: 0.002999, GasAtm: 0, HydroID: 4, AtmosPress: 0.999, SurfaceTemp: 270, BaseTemp: 325.67, Atmosphere: [{ AtmosGasID: 7, GasAtm: 0.999, FrozenOut: 0, FreezingPoint: 63, GHGas: 0, AntiGHGas: 0 }, { AtmosGasID: 5, GasAtm: 0, FrozenOut: 0, FreezingPoint: 0, GHGas: 0, AntiGHGas: 0 }] })

      // SystemBody.ProcessHydrosphereTransition:2507-2514 and Game.ProcessWaterVapourEvaporation:27464-27475: the first addition leaves pressure 1 and vapour 0.001; thaw refills 0.001, leaving extent 19.96 before albedo rises to 1.02994. Temperature is 325.67 × 1.1001 × 1.02994 = 368.99615783598 K, not 369.01765401 K. Next condensation leaves vapour 0.001997996, so the second addition reaches only 0.002997996; the third increment passes the target.
      assert.equal(production.terraformFinish({ MinConstructionPeriod: 31536000 }, job, rate).result.value, 1095, 'thaw evaporation precedes albedo, preserving next-increment condensation and a third-increment finish')
    },
  },
  {
    id: 'water-giants',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.125 })
      const modifiers = { MinConstructionPeriod: 31536000 }
      const job = waterJob({ MaxAtm: 0.1875, SurfaceTemp: 300, BaseTemp: 300, Atmosphere: [{ AtmosGasID: 7, GasAtm: 0.875, FrozenOut: 0, FreezingPoint: 63, GHGas: 1, AntiGHGas: 0 }, { AtmosGasID: 5, GasAtm: 0.125, FrozenOut: 0, FreezingPoint: 0, GHGas: 0, AntiGHGas: 0 }] })

      // SystemBody.UpdateSurfaceTemp:2024-2027: both giant types stay at BaseTemp = 300 K, ignoring the non-neutral atmosphere. First condensation/addition leaves gas 0.15 and pressure 1.025; ordinary-body temperature would be 300 × (1 + 1.025 / 10 + 0.875) = 593.25 K. Giants keep condensing, reaching 0.175 then 0.2 atm: the third increment passes 0.1875, not the ordinary body's second.
      for (const BodyTypeID of [4, 5]) {
        assert.equal(production.terraformFinish(modifiers, { ...job, BodyTypeID }, rate).result.value, 1095, `body type ${BodyTypeID} stays at its base temperature`)
      }

      assert.equal(production.terraformFinish(modifiers, job, rate).result.value, 730, 'ordinary bodies still apply greenhouse warming')
      assert.equal(production.terraformFinish(modifiers, { ...job, BodyTypeID: null }, rate).result.status, 'unavailable', 'an unknown body type cannot silently take the ordinary climate branch')
    },
  },
  {
    id: 'water-inputs',
    needs: [FIXTURE.file],
    run: async ({ page, production, provenance }) => {
      const colony = await firstOf(FIXTURE.file, `select PopulationID, SystemBodyID from FCT_Population where GameID = ${FIXTURE.gameId} and RaceID = ${FIXTURE.raceId} and SystemBodyID > 0 limit 1`)
      const copy = mutatedOf(FIXTURE.file, [
        `update FCT_Population set TerraformingGasID = 5, TerraformStatus = 1, MaxAtm = 0.1875 where PopulationID = ${colony.PopulationID}`,
        `update FCT_Star set Luminosity = 1 where StarID = (select StarID from FCT_SystemBody where SystemBodyID = ${colony.SystemBodyID})`,
        `update FCT_SystemBody set BaseTemp = 100, DistanceToParent = ${(255 / 350) ** 2}, BodyClass = 1, BodyTypeID = 2, Eccentricity = 0, Albedo = 1, DustLevel = 0, SurfaceTemp = 369, HydroID = 3, HydroExt = 20, AtmosPress = 1 where SystemBodyID = ${colony.SystemBodyID}`,
        `delete from FCT_AtmosphericGas where SystemBodyID = ${colony.SystemBodyID}`,
        insertGas(FIXTURE.gameId, colony.SystemBodyID, 7, 0.875, 0),
        insertGas(FIXTURE.gameId, colony.SystemBodyID, 5, 0.125, 0),
      ])

      try {
        const vm = instantiate(page, { $store: { getters: {}, state: {}, dispatch: async () => {} }, database: copy, GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId })
        const job = (await vm.runAsync('terraforms')).find((row) => row.PopulationID === colony.PopulationID)
        const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 0.125 })

        assert.equal(production.terraformFinish({ MinConstructionPeriod: 31536000 }, job, rate).result.value, 730, 'the live read supplies the evolving climate, including base temperature from distance rather than the stale stored column')
        await copy.query('update DIM_Gases set GHGas = 1 where GasID = 7')

        for (const BodyTypeID of [4, 5]) {
          await copy.query(`update FCT_SystemBody set BodyTypeID = ${BodyTypeID}, DistanceToParent = ${(255 / 300) ** 2}, SurfaceTemp = 300 where SystemBodyID = ${colony.SystemBodyID}`)
          const giant = (await vm.runAsync('terraforms')).find((row) => row.PopulationID === colony.PopulationID)

          assert.equal(production.terraformFinish({ MinConstructionPeriod: 31536000 }, giant, rate).result.value, 1095, `the live read distinguishes giant type ${BodyTypeID} before forecasting its climate`)
        }
      } finally {
        copy.close()
      }
    },
  },
  {
    id: 'ordinary-limit',
    run: ({ production, provenance }) => {
      const rate = provenance.ofRule({ rule: 'production.terraformRate', value: 1 })
      const modifiers = { MinConstructionPeriod: 31536000 }
      const job = { Gravity: 1, TerraformStatus: 1, MaxAtm: 99999, GasName: 'Oxygen', GasAtm: 0 }

      assert.equal(production.terraformFinish(modifiers, job, rate).result.value, 36500000, 'a finish on increment 100,000 is included')
      assert.equal(production.terraformFinish(modifiers, { ...job, TerraformStatus: 0, GasAtm: 100000, MaxAtm: 0 }, rate).result.value, 36500000, 'removal on the last searched increment is included')
      const beyond = production.terraformFinish(modifiers, { ...job, MaxAtm: 100000 }, rate)

      assert.equal(beyond.result.value, null, 'no completion beyond the explicit increment cap is claimed')
      assert.equal(beyond.idle, true)
      assert.ok(beyond.note.includes('100,000 increments'), 'the bound is disclosed, not described as never finishing')
    },
  },
]
const PRODUCTION_FAULTS = [
  { file: 'pages/production.vue', from: 'colonies[terraform.PopulationID] && hasTerraformers(colonies[terraform.PopulationID])', to: '!(terraform.TerraformStatus && terraform.MaxAtm === 0) && colonies[terraform.PopulationID] && hasTerraformers(colonies[terraform.PopulationID])', fails: ['unlimited-job'] },
  { file: 'utilities/production.js', from: 'if (status && terraform.MaxAtm === 0) {', to: 'if (false) {', fails: ['unlimited-finish'] },
  { file: 'utilities/production.js', from: 'done = gas > terraform.MaxAtm && terraform.MaxAtm > 0', to: 'done = gas >= terraform.MaxAtm && terraform.MaxAtm > 0', fails: ['target-cycle'] },
  { file: 'utilities/production.js', from: 'gas = step\n        present = true', to: 'gas = step\n        present = true\n        done = gas > terraform.MaxAtm && terraform.MaxAtm > 0', fails: ['target-cycle'] },
  { file: 'utilities/production.js', from: '(gas <= terraform.MaxAtm && terraform.MaxAtm > 0)', to: '(gas < terraform.MaxAtm && terraform.MaxAtm > 0)', fails: ['target-cycle'] },
  { file: 'utilities/production.js', from: 'body.SurfaceTemp <= 369 && water.GasAtm > humidity', to: 'water.GasAtm > humidity', fails: ['water-temperature'] },
  { file: 'utilities/production.js', from: 'body.SurfaceTemp <= 369 && water.GasAtm > humidity', to: 'body.SurfaceTemp < 369 && water.GasAtm > humidity', fails: ['water-temperature'] },
  { file: 'utilities/production.js', from: 'updateWaterClimate(body, water)', to: 'void body', fails: ['water-temperature'] },
  { file: 'utilities/production.js', from: 'const CONDENSATION_PER_YEAR = 0.1', to: 'const CONDENSATION_PER_YEAR = 0.05', fails: ['water-temperature'] },
  { file: 'pages/production.vue', from: 'row.BaseTemp = isKnownNumber(distance) && distance > 0 && isKnownNumber(row.StarLuminosity) && row.StarLuminosity > 0 ? climateBaseTemp(row) : null', to: 'row.BaseTemp = 100', fails: ['water-inputs'] },
  { file: 'utilities/production.js', from: 'evaporateWater(body, water, 0)\n    body.Albedo += 0.0015 * body.HydroExt', to: 'body.Albedo += 0.0015 * body.HydroExt\n    evaporateWater(body, water, 0)', fails: ['water-thaw'] },
  { file: 'utilities/production.js', from: 'body.BodyTypeID === BODY_TYPE.GAS_GIANT || body.BodyTypeID === BODY_TYPE.SUPERJOVIAN', to: 'false', fails: ['water-giants'] },
  { file: 'pages/production.vue', from: 'FCT_SystemBody.BodyTypeID, FCT_SystemBodyName.Name as SystemBodyName', to: 'null as BodyTypeID, FCT_SystemBodyName.Name as SystemBodyName', fails: ['water-inputs'] },
  { file: 'utilities/production.js', from: 'compute: () => (cycle * period) / SECONDS_PER_DAY', to: 'compute: () => (status || terraform.GasAtm > 0 ? cycle * period : 0) / SECONDS_PER_DAY', fails: ['empty-removal'] },
  { file: 'utilities/production.js', from: 'isNumber(terraform.Gravity) && terraform.Gravity < 0.1', to: 'false', fails: ['gravity-finish'] },
  { file: 'utilities/production.js', from: 'terraform.Gravity < 0.1', to: 'terraform.Gravity <= 0.1', fails: ['gravity-finish'] },
  { file: 'utilities/production.js', from: "...(isNumber(terraform.Gravity) ? [] : ['the body\\'s gravity'])", to: '...[]', fails: ['gravity-finish'] },
  { file: 'pages/production.vue', from: 'Gravity: colonies[terraform.PopulationID].gravity', to: 'Gravity: 1', fails: ['gravity-inputs'] },
  { file: 'utilities/terraform-capacity.js', from: 'gravity: row.Gravity', to: 'gravity: null', fails: ['gravity-inputs'] },
  { file: 'pages/production.vue', from: 'FCT_SystemBody.Radius, FCT_SystemBody.Gravity, FCT_SystemBody.SurfaceTemp', to: 'FCT_SystemBody.Radius, null as Gravity, FCT_SystemBody.SurfaceTemp', fails: ['water-inputs'] },
  { file: 'utilities/production.js', from: 'gas += step', to: 'gas = terraform.GasAtm + cycle * step', fails: ['decimal-add'] },
  { file: 'utilities/production.js', from: 'gas -= step', to: 'gas = terraform.GasAtm - cycle * step', fails: ['decimal-remove'] },
  { file: 'utilities/production.js', from: 'gas += step', to: 'gas = Math.round((gas + step) * 1e12) / 1e12', fails: ['decimal-add'] },
  { file: 'utilities/production.js', from: 'cycle <= ORDINARY_GAS_INCREMENT_CAP', to: 'cycle < ORDINARY_GAS_INCREMENT_CAP', fails: ['ordinary-limit'] },
]

const productionModules = async (sources = {}) => {
  const loaded = await loadModules(['pages/production', 'utilities/production', 'utilities/provenance'], { stubs: PRODUCTION_STUBS, sources })

  return { page: loaded['pages/production'].default, production: loaded['utilities/production'], provenance: loaded['utilities/provenance'] }
}

const main = async () => {
  let passed = 0
  let total = 0
  let skipped = 0
  const failures = []

  const check = async (name, test) => {
    total += 1

    try {
      await test()
      passed += 1
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }

  const skip = (group, files, reason = '') => {
    skipped += 1

    const missing = files.filter((file) => !present(file))

    console.log(`SKIP ${group}: ${missing.length ? `missing ${missing.join(', ')}` : reason}`)
  }

  const modules = await loadUtilities(['habitability', 'terraforming', 'terraform-limits', 'colonization-data', 'colonization', 'terraform-capacity', 'naval-admins', 'minerals'], { stubs: { 'lodash/groupBy': GROUP_BY } })

  await check('app capacity and plan years agree with the rules', async () => appOutputs(modules, ARITHMETIC))

  for (const [label, file, from, to, fails] of mutating() ? APP_FAULTS : []) {
    await check(`app planted fault ${label} is caught`, async () => {
      refusePlanting(label)
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${file}.js`), 'utf8')
      const planted = await loadUtilities(['habitability', 'terraforming', 'colonization-data'], { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [file]: plantedPatch(`${file}.js`, text, from, to) } })
      const results = await runChecks(fails.map((id) => ({ id, name: `app ${id}`, run: () => appOutputs(planted, ARITHMETIC, id) })), {})

      judged(results, label)

      const caught = caughtAll(results, { name: label })

      assert.ok(caught, 'the app-output assertions still pass')
    })
  }

  const breakdownModules = ['habitability', 'terraforming', 'terraform-limits', 'colonization-data', 'terraform-capacity', 'naval-admins', 'minerals']

  for (const [name, { needs, run }] of Object.entries(BREAKDOWN_CHECKS)) {
    if (!present(...needs)) {
      skip(`breakdown ${name}`, needs)
      continue
    }

    await check(`breakdown ${name}`, async () => run(modules))
  }

  for (const { module = 'terraform-capacity', label, from, to, fails } of mutating() ? BREAKDOWN_FAULTS : []) {
    const required = fails.filter((name) => present(...BREAKDOWN_CHECKS[name].needs))

    if (!required.length) {
      skip(`breakdown planted fault ${label}`, fails.flatMap((name) => BREAKDOWN_CHECKS[name].needs))
      continue
    }

    await check(`breakdown planted fault ${label} fails ${required.join(', ')}`, async () => {
      refusePlanting(label)
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${module}.js`), 'utf8')
      const planted = await loadUtilities(breakdownModules, { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [module]: plantedPatch(`${module}.js`, text, from, to) } })

      const results = await runChecks(required.map((id) => ({ id, name: id, run: () => BREAKDOWN_CHECKS[id].run(planted) })), {})

      judged(results, label)
      assert.ok(caughtAll(results, { name: label }), `the named breakdown checks still pass: ${required.join(', ')}`)
    })
  }

  const production = await productionModules()

  for (const { id, run, needs = [] } of PRODUCTION_CHECKS) {
    if (!present(...needs)) {
      skip(`production ${id}`, needs)
      continue
    }

    await check(`production ${id}`, () => run(production))
  }

  for (const { file, from, to, fails } of mutating() ? PRODUCTION_FAULTS : []) {
    await check(`production planted fault ${from}`, async () => {
      refusePlanting(from)
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', file), 'utf8')
      const source = plantedPatch(file, text, from, to)
      const planted = await productionModules({ [file.replace(/\.(js|vue)$/, '')]: source })
      const results = await runChecks(PRODUCTION_CHECKS.filter(({ id }) => fails.includes(id)).map(({ id, run }) => ({ id, name: id, run: () => run(planted) })), {})

      judged(results, from)
      assert.ok(caughtAll(results, { name: from }), 'the production assertions still pass')
    })
  }
  await Promise.allSettled([...handles.values()].map(async (handle) => (await handle).close()))

  for (const failure of failures) {
    console.log(`FAIL ${failure}`)
  }

  console.log(`${passed} of ${total} checks passed${skipped ? ` (${skipped} groups skipped)` : ''}`)
  process.exitCode = passed === total ? 0 : 1
}

main().catch((error) => {
  console.log(error.stack)
  process.exitCode = 1
})
