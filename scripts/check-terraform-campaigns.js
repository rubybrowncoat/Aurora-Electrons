/*
  Checks the terraforming planner's inputs against observed campaigns (backlog AE-059-01), read only.

  node scripts/check-terraform-campaigns.js [--no-mutations]

  Each group opens saves of a recorded campaign read only (SELECTs only) and compares a before/after pair with the rate and climate rules of docs/DATABASE.md:
  - passive: a non-player colony with a fixed fleet of terraformers adds one pressure step per snapshot until the target is passed, then the order is cleared;
  - rate: the change of a gas on a colony with a terraforming order that stood across a pair of saves equals the capacity of the colony at the earlier save (terraformers, racial rate, commanders, installations, modifiers, the game's speed) times the elapsed years of the growth clock times the pressure of one earth-equivalent atmosphere over the body's surface. The elapsed time is read from the growth clock, not the game time: the same pair with the game time is off by percent;
  - climate: the surface temperature of every body with an atmosphere equals the app's recomputed base temperature times the greenhouse factors of the gases that are listed;
  - hidden: some bodies carry more pressure than their listed gases add up to (gases at zero are not saved);
  - plans: the app's plan against what the player did on the same bodies.
  A save that is not there skips its group and says so; a skipped group is never counted as passed. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const SECONDS_PER_YEAR = 31536000
const EARTH_ATMOSPHERE_UNITS = 511187128
const PI = 3.1416
const GROUP_BY = 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})'

const FALRYX = 'artifacts/falryx-sequential-and-rollback'
const falryx = (time) => `${FALRYX}/AuroraDB-${time}.db`
const PASSIVE = 'artifacts/passive-campaign-20261013/snapshots'
const passive = (number) => `${PASSIVE}/AuroraDB_${String(number).padStart(3, '0')}_day_${18250 + (number - 1) * 5}.db`

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

const clockOf = (file, game) => firstOf(file, 'select GameTime, LastGrowthTime, TerraformingSpeed from FCT_Game where GameID = ?', game)

// The capacity of one colony in atmospheres of earth equivalent a year, as the game spends it: undamaged modules on the ships assigned to the colony (racial rate, captain bonus, crew share), the installations, and the colony's modifiers.
const capacityOf = async (file, game, population) => {
  const clock = await clockOf(file, game)
  const rate = (await firstOf(file, 'select TerraformingRate from FCT_Race where GameID = ? and RaceID = ?', game, population.RaceID)).TerraformingRate
  const body = await firstOf(file, 'select RadiationLevel, SystemID from FCT_SystemBody where GameID = ? and SystemBodyID = ?', game, population.SystemBodyID)
  const installations = (await firstOf(file, 'select coalesce(sum(i.Amount * d.TerraformValue), 0) n from FCT_PopulationInstallations i join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = i.PlanetaryInstallationID where i.GameID = ? and i.PopID = ?', game, population.PopulationID)).n
  const governor = await firstOf(file, 'select b.BonusValue v from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID and b.BonusID = 9 where c.GameID = ? and c.CommandType = 3 and c.CommandID = ?', game, population.PopulationID)
  const sector = await firstOf(file, 'select b.BonusValue v from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID and b.BonusID = 9 join FCT_RaceSysSurvey s on s.SectorID = c.CommandID and s.GameID = c.GameID where c.GameID = ? and c.CommandType = 4 and s.SystemID = ? and s.RaceID = ?', game, body.SystemID, population.RaceID)
  const status = await firstOf(file, 'select ProductionMod m from DIM_PopPoliticalStatus where StatusID = ?', population.PoliticalStatus)
  const modifier = (governor ? governor.v : 1) * (sector ? 1 + (sector.v - 1) / 4 : 1) * population.Efficiency * Math.max(0, 1 - (body.RadiationLevel || 0) / 10000) * (1 - Math.min(99, Math.max(0, population.UnrestPoints)) / 100) * (status ? status.m : 1)
  const ships = await rowsOf(file, 'select s.ShipID, s.CurrentCrew, sc.Crew, cc.NumComponent from FCT_Ship s join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID join FCT_ClassComponent cc on cc.ClassID = sc.ShipClassID and cc.GameID = s.GameID join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID join FCT_Fleet fl on fl.FleetID = s.FleetID where s.GameID = ? and d.ComponentTypeID = 33 and fl.AssignedPopulationID = ?', game, population.PopulationID)
  let orbital = 0
  let modules = 0
  let effective = 0

  for (const ship of ships) {
    const damaged = (await firstOf(file, 'select sum(dc.Number) n from FCT_DamagedComponent dc join FCT_ShipDesignComponents d on d.SDComponentID = dc.ComponentID where dc.ShipID = ? and dc.GameID = ? and d.ComponentTypeID = 33', ship.ShipID, game)).n || 0
    const captain = await firstOf(file, 'select b.BonusValue v from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID where c.GameID = ? and c.CommandType = 1 and c.CommandID = ? and b.BonusID = 9', game, ship.ShipID)
    const crew = ship.Crew > 0 ? Math.min(1, ship.CurrentCrew / ship.Crew) : 1
    const count = ship.NumComponent - damaged

    modules += count
    orbital += count * rate * (captain ? captain.v : 1) * crew
    effective += count * (captain ? captain.v : 1) * crew
  }

  return { total: (rate * Math.trunc(installations) * modifier + orbital) * clock.TerraformingSpeed / 100, modules, installations, modifier, rate, speed: clock.TerraformingSpeed, effective }
}

const gasOf = async (file, game, body, gas) => {
  const row = await firstOf(file, 'select GasAtm from FCT_AtmosphericGas where GameID = ? and SystemBodyID = ? and AtmosGasID = ?', game, body, gas)

  return row ? row.GasAtm : 0
}

// The change of one gas the capacity at the earlier save predicts for the elapsed growth clock, and the change observed.
const pairOf = async (before, after, game, populationId, clockOfTime = 'LastGrowthTime') => {
  const population = await firstOf(before, 'select * from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
  const later = await firstOf(after, 'select TerraformStatus, TerraformingGasID from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
  const body = await firstOf(before, 'select Radius from FCT_SystemBody where GameID = ? and SystemBodyID = ?', game, population.SystemBodyID)
  const years = ((await clockOf(after, game))[clockOfTime] - (await clockOf(before, game))[clockOfTime]) / SECONDS_PER_YEAR
  const capacity = await capacityOf(before, game, population)
  const sign = population.TerraformStatus ? 1 : -1
  const predicted = sign * capacity.total * years * EARTH_ATMOSPHERE_UNITS / (4 * PI * body.Radius ** 2)
  const observed = await gasOf(after, game, population.SystemBodyID, population.TerraformingGasID) - await gasOf(before, game, population.SystemBodyID, population.TerraformingGasID)

  return { same: later.TerraformStatus === population.TerraformStatus && later.TerraformingGasID === population.TerraformingGasID, predicted, observed, ratio: observed / predicted, years, radius: body.Radius, capacity }
}

// Pairs whose order stood and whose target was not reached inside the interval: the observed change is the predicted one to four places. [label, earlier save, later save, game, colony]
const AURELIAN = 'saves/AuroraDB_270_unknown.db'
const EXACT = [
  ['Falryx 2713949950 to 2740177930 Verun III carbon dioxide', falryx(2713949950), falryx(2740177930), 141, 49103],
  ['Falryx 2713949950 to 2740177930 Orso oxygen', falryx(2713949950), falryx(2740177930), 141, 49128],
  ['Falryx 2713949950 to 2740177930 Grassi aestusium', falryx(2713949950), falryx(2740177930), 141, 49284],
  ['Falryx 2713949950 to 2740177930 Bremerhaven aestusium', falryx(2713949950), falryx(2740177930), 141, 49304],
  ['Falryx 2794985390 to 2810693885 Espadon gas 15', falryx(2794985390), falryx(2810693885), 141, 49053],
  ['Falryx 2794985390 to 2810693885 Verun III carbon dioxide', falryx(2794985390), falryx(2810693885), 141, 49103],
  ['Falryx 2794985390 to 2810693885 Orso oxygen', falryx(2794985390), falryx(2810693885), 141, 49128],
  ['Falryx 2794985390 to 2810693885 Guardiola aestusium', falryx(2794985390), falryx(2810693885), 141, 49262],
  ['Falryx 2904201340 to 2930673230 Verun III aestusium', falryx(2904201340), falryx(2930673230), 141, 49103],
  ['Falryx 2904201340 to 2930673230 Orso oxygen', falryx(2904201340), falryx(2930673230), 141, 49128],
  ['Falryx 2904201340 to 2930673230 Guardiola aestusium', falryx(2904201340), falryx(2930673230), 141, 49262],
  ['Falryx 2904201340 to 2930673230 Odesa aestusium', falryx(2904201340), falryx(2930673230), 141, 49326],
]

// Fixtures that need no save, worked by hand from the rule (capacity = (rate x whole installations x modifier + rate x modules at crew and captain share) x speed / 100): so each planted fault in the app's arithmetic is detectable whichever saves are present. 0.001 x 5 x 10 x 1.25 + 0.001 x 5 x 3 = 0.0775; 0.001 x 4 x 0.5 = 0.002.
const ARITHMETIC = [
  { label: 'arithmetic: 10.5 installations at modifier 1.25 and 3 staffed modules, speed 500%', rate: 0.001, speed: 500, installations: 10.5, modifier: 1.25, effective: 3, total: 0.0775, observed: 0.2, radius: 6000 },
  { label: 'arithmetic: 4 installations at modifier 0.5, speed 100%', rate: 0.001, speed: 100, installations: 4, modifier: 0.5, effective: 0, total: 0.002, observed: -0.05, radius: 3000 },
].map((fixture) => ({ ...fixture, years: Math.abs(fixture.observed) * 4 * PI * fixture.radius ** 2 / EARTH_ATMOSPHERE_UNITS / fixture.total }))

// The faults planted in the app's own capacity, years and area arithmetic: each must break the app-output assertions. [label, utility, text, replacement, needs the plans' saves]
const APP_FAULTS = [
  ['halved capacity', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier * 0.5'],
  ['doubled Earth surface area', 'terraforming', 'export const EARTH_SURFACE_AREA = 511187128', 'export const EARTH_SURFACE_AREA = 1022374256', true],
  ['years multiplied by the capacity', 'terraforming', 'work / capacity : Infinity', 'work * capacity : Infinity'],
  ['modifier ignored', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers'],
  ['speed ignored', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * terraformers * modifier'],
]
// The app's capacity of each exact pair's colony (installations at the colony's modifier, orbital modules at the crew and captain share), its years for the observed change, and the work of three plans against the rule's independent expectation (the atm to move times the body's area over the Earth's, with the game's 3.1416).
const appOutputs = async (modules, fixtures, plans) => {
  const { terraforming } = modules

  for (const fixture of fixtures) {
    const race = { TerraformingRate: fixture.rate, TerraformingSpeed: fixture.speed }
    const capacity = terraforming.terraformCapacity(race, Math.trunc(fixture.installations), fixture.modifier) + terraforming.terraformCapacity(race, fixture.effective, 1)

    assert.ok(Math.abs(capacity / fixture.total - 1) < 1e-9, `${fixture.label}: capacity ${capacity}, rule ${fixture.total}`)

    const years = terraforming.planYears(Math.abs(fixture.observed) * 4 * PI * fixture.radius ** 2 / EARTH_ATMOSPHERE_UNITS, capacity)

    assert.ok(Math.abs(years / fixture.years - 1) < 5e-4, `${fixture.label}: years ${years}, observed ${fixture.years}`)
  }

  for (const [file, game, race, populationId] of plans) {
    const { assessment, body } = await planOf(modules, file, game, race, populationId)
    const area = 4 * PI * body.Radius ** 2 / EARTH_ATMOSPHERE_UNITS
    const expected = assessment.plan.steps.reduce((sum, step) => sum + step.atm * area, 0)

    for (const step of assessment.plan.steps) {
      assert.ok(Math.abs(step.work / (step.atm * area) - 1) < 1e-5, `plan ${populationId} ${step.label}: work ${step.work}, rule ${step.atm * area}`)
    }

    assert.ok(Math.abs(assessment.plan.work / expected - 1) < 1e-5, `plan ${populationId}: work ${assessment.plan.work}, rule ${expected}`)
    assert.ok(Math.abs(assessment.work / expected - 1) < 1e-5, `plan ${populationId}: assessed work ${assessment.work}, rule ${expected}`)

    const capacity = ARITHMETIC[0].total
    const years = modules.terraforming.planYears(assessment.plan.work, capacity)

    assert.ok(Math.abs(years / (expected / capacity) - 1) < 1e-5, `plan ${populationId}: years ${years}, rule ${expected / capacity}`)
  }
}

// Every pair of saves of one campaign whose colonies kept their order across the pair and moved the ordered gas, for every race of the game: [campaign, earlier save, later save, game]. The three short Falryx pairs and Egg's one interval.
const LEDGER_INTERVALS = [
  ['Falryx A', falryx(2713949950), falryx(2740177930), 141],
  ['Falryx B', falryx(2794985390), falryx(2810693885), 141],
  ['Falryx C', falryx(2904201340), falryx(2930673230), 141],
  ['Egg', 'saves/AuroraDBSaveBackup.db', 'saves/AuroraDB.db', 138],
]

const LEDGER_COUNTS = { exact: 12, 'climate: water vapour condenses': 6, 'rate: capacity changed, observed between the two predictions': 10, 'rate: capacity changed, observed outside the two predictions': 3, 'gap: no cause visible at the two saves': 3 }

// The ledger of the replay: one row per colony whose order (direction and gas) stood across the pair and whose gas changed, with the capacity the rule gives at the earlier and at the later save, the change it predicts at the earlier capacity, the change observed and a class.
const ledgerOf = async () => {
  const rows = []

  for (const [campaign, before, after, game] of LEDGER_INTERVALS) {
    const populations = await rowsOf(before, 'select p.PopulationID, p.PopName, p.TerraformStatus, p.TerraformingGasID, g.Name GasName from FCT_Population p join DIM_Gases g on g.GasID = p.TerraformingGasID where p.GameID = ? and p.TerraformingGasID != 0 order by p.PopulationID', game)

    for (const row of populations) {
      const pair = await pairOf(before, after, game, row.PopulationID)

      if (!pair.same || pair.observed === 0) {
        continue
      }

      const laterPopulation = await firstOf(after, 'select * from FCT_Population where GameID = ? and PopulationID = ?', game, row.PopulationID)
      const later = await capacityOf(after, game, laterPopulation)
      const predictedLater = (row.TerraformStatus === 1 ? 1 : -1) * later.total * pair.years * EARTH_ATMOSPHERE_UNITS / (4 * PI * pair.radius ** 2)

      assert.ok(Number.isFinite(pair.predicted) && Number.isFinite(predictedLater), `${row.PopName}: predictions ${pair.predicted} and ${predictedLater} are not finite`)

      const changed = Math.abs(later.total - pair.capacity.total) > 1e-9 * Math.max(1, pair.capacity.total)
      const bracketed = Math.min(pair.predicted, predictedLater) <= pair.observed && pair.observed <= Math.max(pair.predicted, predictedLater)
      const entry = { campaign, population: row.PopulationID, name: row.PopName.replace(/\s+/g, ' ').replace(/\|/g, '/'), gas: row.GasName, gasId: row.TerraformingGasID, adding: row.TerraformStatus === 1, installations: pair.capacity.installations, modules: pair.capacity.modules, modifier: pair.capacity.modifier, rate: pair.capacity.rate, speed: pair.capacity.speed, capacity: pair.capacity.total, laterCapacity: later.total, radius: pair.radius, years: pair.years, predicted: pair.predicted, predictedLater, observed: pair.observed, ratio: pair.ratio, residual: pair.observed - pair.predicted }

      entry.class = Math.abs(pair.ratio - 1) < 0.0005 ? 'exact' : row.TerraformingGasID === 5 ? 'climate: water vapour condenses' : changed ? (bracketed ? 'rate: capacity changed, observed between the two predictions' : 'rate: capacity changed, observed outside the two predictions') : 'gap: no cause visible at the two saves'
      rows.push(entry)
    }
  }

  return rows
}

const printLedger = (ledger) => {
  console.log('| Interval | Colony | Gas | Direction | Installations | Modules | I | Capacity | Capacity later | R km | Years | Predicted | Predicted later | Observed | Ratio | Residual | Class |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')

  for (const row of ledger) {
    console.log(`| ${row.campaign} | ${row.name} ${row.population} | ${row.gas} | ${row.adding ? 'add' : 'remove'} | ${row.installations} | ${row.modules} | ${row.modifier.toPrecision(4)} | ${row.capacity.toPrecision(5)} | ${row.laterCapacity.toPrecision(5)} | ${row.radius} | ${row.years.toPrecision(5)} | ${row.predicted.toPrecision(6)} | ${row.predictedLater.toPrecision(6)} | ${row.observed.toPrecision(6)} | ${row.ratio.toPrecision(5)} | ${row.residual.toExponential(2)} | ${row.class} |`)
  }
}

// The shared breakdown (utilities/terraform-capacity.js) against the rule oracle above. Each entry is a check of its own, `needs` the saves it reads (missing: SKIP), and `run(modules)` throws when the breakdown disagrees; the planted faults below are loaded from a patched source and must fail the checks they name.
const adminOf = (overrides) => ({ NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.05, Eligible: true, Unknown: null, Systems: new Set([5]), ...overrides })

const sourcesOf = (modules, file, game, race, blocked) => modules['terraform-capacity'].loadTerraformSources(databaseOf(file), { GameID: game, RaceID: race, blocked })
const adminsOf = (modules, file, game, race) => modules['naval-admins'].loadNavalAdmins(databaseOf(file), { GameID: game, RaceID: race, bonusId: 9, share: 'Industrial' })
const missingOf = (result) => (result.inputs ? result.inputs.missing.join('; ') : '')

// A colony and its race worked by hand: 10.5 installations (10 count) at I = 1.2 x 1.1 x 0.9 x 0.99 x 0.9 x 1 (the sector bonus 1.4 counts a quarter of its excess), 8 modules at half the crew, a captain's 1.1 and the admin chain 1 + (1.2 - 1) x 0.05, rate 0.001, speed 500 %, radius 6000 km.
const handSource = () => ({ installations: 10.5, radius: 6000, modifier: { governor: 1.2, sector: 1.4, efficiency: 0.9, radiation: 100, unrest: 10, status: 1 }, ships: [{ ShipID: 1, PopulationID: 1, ParentCommandID: 1, FleetSystemID: 5, crew: 0.5, captain: 1.1, captained: true, modules: 8 }] })

const handExpected = () => {
  const installations = 0.001 * 10 * (1.2 * 1.1 * 0.9 * 0.99 * 0.9 * 1)
  const orbital = 0.001 * (8 * 0.5 * 1.1) * 1.01
  const capacity = (installations + orbital) * 500 / 100

  return { installations, orbital, capacity, rate: capacity * EARTH_ATMOSPHERE_UNITS / (4 * PI * 6000 ** 2) }
}

const near = (value, expected, tolerance, what) => assert.ok(Number.isFinite(value) && Math.abs(value / expected - 1) < tolerance, `${what}: ${value}, rule ${expected}`)

// The breakdown's rate on every colony of one save that terraforms, against the oracle's capacity spread over the body.
const rateOnSave = async (modules, file, game, race) => {
  const { terraformBreakdown, hasTerraformers } = modules['terraform-capacity']
  const sources = await sourcesOf(modules, file, game, race)
  const admins = await adminsOf(modules, file, game, race)
  let compared = 0

  for (const source of Object.values(sources.colonies).filter(hasTerraformers)) {
    const population = await firstOf(file, 'select * from FCT_Population where GameID = ? and PopulationID = ?', game, source.PopulationID)
    const oracle = (await capacityOf(file, game, population)).total * EARTH_ATMOSPHERE_UNITS / (4 * PI * source.radius ** 2)
    const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source, admins })

    assert.equal(rate.status, 'estimated', `${source.PopName}: ${missingOf(rate)}`)

    if (oracle === 0) {
      assert.equal(rate.value, 0, source.PopName)
    } else {
      near(rate.value, oracle, 1e-9, source.PopName)
    }

    compared += 1
  }

  assert.ok(compared > 0, 'no colony with terraformers')
}

// The change of the ordered gas of each exact pair that starts at `before`, the breakdown's rate at the earlier save times the elapsed years against the observed change.
const pairsFrom = async (modules, before) => {
  const { terraformBreakdown } = modules['terraform-capacity']

  for (const [label, from, after, game, populationId] of EXACT.filter(([, file]) => file === before)) {
    const pair = await pairOf(from, after, game, populationId)
    const population = await firstOf(from, 'select RaceID, TerraformStatus from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
    const sources = await sourcesOf(modules, from, game, population.RaceID)
    const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[populationId], admins: await adminsOf(modules, from, game, population.RaceID) })

    assert.equal(rate.status, 'estimated', `${label}: ${missingOf(rate)}`)
    assert.ok(Math.abs((population.TerraformStatus ? 1 : -1) * rate.value * pair.years / pair.observed - 1) < 0.0005, `${label}: breakdown ${rate.value * pair.years}, observed ${pair.observed}`)
  }
}

// A copy of a save in memory with `statements` run on it: the loaders read it as they read a save, and the file is never opened for writing.
const mutatedOf = (file, statements) => {
  const database = Database.deserialize(fs.readFileSync(path.join(root, file)))

  statements.forEach((statement) => database.exec(statement))

  return { query: async (sql) => [database.query(sql).all()], close: () => database.close() }
}

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
  'rate Falryx': { needs: [falryx(2904201340)], run: (modules) => rateOnSave(modules, falryx(2904201340), 141, 791) },
  'speed Falryx': {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { terraformBreakdown, hasTerraformers } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, falryx(2904201340), 141, 791)
      const admins = await adminsOf(modules, falryx(2904201340), 141, 791)
      let compared = 0

      for (const source of Object.values(sources.colonies).filter(hasTerraformers)) {
        const base = terraformBreakdown({ raceRate: sources.raceRate, speed: 100, source, admins }).capacity.value

        assert.ok(base > 0, `${source.PopName}: capacity at the game speed 100 is ${base}`)

        for (const speed of [50, 300, 500]) {
          near(terraformBreakdown({ raceRate: sources.raceRate, speed, source, admins }).capacity.value, base * speed / 100, 1e-9, `${source.PopName} at the game speed ${speed}`)
        }

        compared += 1
      }

      assert.ok(compared > 0, 'no colony with terraformers')
    },
  },
  'rate passive moon': { needs: [passive(2)], run: (modules) => rateOnSave(modules, passive(2), 139, 2) },
  'pairs Falryx A': { needs: [falryx(2713949950), falryx(2740177930)], run: (modules) => pairsFrom(modules, falryx(2713949950)) },
  'pairs Falryx B': { needs: [falryx(2794985390), falryx(2810693885)], run: (modules) => pairsFrom(modules, falryx(2794985390)) },
  'pairs Falryx C': { needs: [falryx(2904201340), falryx(2930673230)], run: (modules) => pairsFrom(modules, falryx(2904201340)) },
  truncation: {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { colonyModifier, terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, falryx(2904201340), 141, 791)

      for (const [id, whole] of [[49045, 6], [49326, 12]]) {
        const source = sources.colonies[id]

        assert.ok(source.installations > whole && source.installations < whole + 1, `${source.PopName}: ${source.installations}`)
        near(terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source }).installations.value, sources.raceRate * whole * colonyModifier(source.modifier).value, 1e-12, source.PopName)
      }
    },
  },
  blocked: {
    needs: [passive(2)],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, passive(2), 139, 2, new Set([9]))
      const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[4] })

      assert.equal(breakdown.orbital.status, 'unavailable')
      assert.ok(/captain/.test(missingOf(breakdown.orbital)), missingOf(breakdown.orbital))
      assert.equal(breakdown.rate.status, 'unavailable')
    },
  },
  damaged: {
    needs: [passive(2)],
    run: async (modules) => {
      const base = await sourcesOf(modules, passive(2), 139, 2)
      const [ship] = base.colonies[4].ships
      const copy = mutatedOf(passive(2), [`insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) select ${ship.ShipID}, FCT_ClassComponent.ComponentID, 139, 1 from FCT_Ship inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = 33 where FCT_Ship.ShipID = ${ship.ShipID} limit 1`])

      try {
        const hurt = await modules['terraform-capacity'].loadTerraformSources(copy, { GameID: 139, RaceID: 2 })
        const modulesOf = (sources, id) => sources.colonies[4].ships.find((item) => item.ShipID === id).modules

        assert.equal(modulesOf(base, ship.ShipID) - modulesOf(hurt, ship.ShipID), 1)

        for (const other of base.colonies[4].ships.filter((item) => item.ShipID !== ship.ShipID)) {
          assert.equal(modulesOf(hurt, other.ShipID), other.modules, `ship ${other.ShipID}`)
        }
      } finally {
        copy.close()
      }
    },
  },
  'damage count missing': {
    needs: [passive(2)],
    run: async (modules) => {
      const base = await sourcesOf(modules, passive(2), 139, 2)
      const [ship] = base.colonies[4].ships
      const copy = mutatedOf(passive(2), [`insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) select ${ship.ShipID}, FCT_ClassComponent.ComponentID, 139, null from FCT_Ship inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = 33 where FCT_Ship.ShipID = ${ship.ShipID} limit 1`])

      try {
        const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
        const sources = await loadTerraformSources(copy, { GameID: 139, RaceID: 2 })
        const hurt = sources.colonies[4].ships.find((item) => item.ShipID === ship.ShipID)
        const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[4], admins: {} })

        assert.equal(hurt.modules, null)
        assert.equal(breakdown.orbital.status, 'unavailable')
        assert.ok(/modules/.test(missingOf(breakdown.orbital)), missingOf(breakdown.orbital))
        assert.equal(base.colonies[4].ships.filter((item) => item.ShipID !== ship.ShipID).every((item) => typeof item.modules === 'number'), true)
      } finally {
        copy.close()
      }
    },
  },
  'bonus value missing: captain': {
    needs: [passive(2)],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const base = await sourcesOf(modules, passive(2), 139, 2)
      const copy = mutatedOf(passive(2), ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 9'])

      try {
        const sources = await loadTerraformSources(copy, { GameID: 139, RaceID: 2 })
        const shipsOf = (loaded) => Object.values(loaded.colonies).flatMap((colony) => colony.ships)
        const captained = shipsOf(base).filter((ship) => ship.captained)

        assert.ok(captained.length > 0 && captained.length < shipsOf(base).length, 'the save needs captained and captainless ships')

        for (const ship of shipsOf(sources)) {
          const before = shipsOf(base).find((item) => item.ShipID === ship.ShipID)

          assert.equal(ship.captain, before.captained ? null : 1, `ship ${ship.ShipID}`)
          assert.equal(ship.captained, before.captained, `ship ${ship.ShipID}`)
        }

        const colony = Object.values(sources.colonies).find((item) => item.ships.some((ship) => ship.captain === null))
        const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: colony, admins: {} })

        assert.equal(breakdown.orbital.status, 'unavailable')
        assert.ok(/captain/.test(missingOf(breakdown.orbital)), missingOf(breakdown.orbital))
      } finally {
        copy.close()
      }
    },
  },
  'bonus value missing: governor and sector': {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const copy = mutatedOf(falryx(2904201340), ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 9'])
      const commands = (type) => `select FCT_Commander.CommandID from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 9 where FCT_Commander.GameID = 141 and FCT_Commander.RaceID = 791 and FCT_Commander.CommandType = ${type}`

      try {
        const governors = new Set((await copy.query(commands(3)))[0].map((row) => row.CommandID))
        const sectored = new Set((await copy.query(`select FCT_Population.PopulationID from FCT_Population inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID where FCT_Population.GameID = 141 and FCT_Population.RaceID = 791 and FCT_RaceSysSurvey.SectorID in (${commands(4)})`))[0].map((row) => row.PopulationID))
        const sources = await loadTerraformSources(copy, { GameID: 141, RaceID: 791 })
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
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const base = await sourcesOf(modules, falryx(2904201340), 141, 791)
      const target = Object.values(base.colonies).find((colony) => colony.installations > 0 && colony.modifier.sector > 1)
      const other = Object.values(base.colonies).find((colony) => colony.SystemID !== target.SystemID && colony.modifier.sector !== null)
      const run = async (statements) => {
        const copy = mutatedOf(falryx(2904201340), statements)

        try {
          return await loadTerraformSources(copy, { GameID: 141, RaceID: 791 })
        } finally {
          copy.close()
        }
      }
      const rateOf = (sources, colony) => terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[colony.PopulationID] }).installations

      assert.ok(target && other, 'the save needs a colony with a sector bonus above 1 and one elsewhere')

      const lost = await run([`update FCT_RaceSysSurvey set SectorID = null where RaceID = 791 and SystemID = ${target.SystemID}`])

      assert.equal(lost.colonies[target.PopulationID].modifier.sector, null)
      assert.equal(rateOf(lost, target).status, 'unavailable')
      assert.ok(/sector/.test(missingOf(rateOf(lost, target))), missingOf(rateOf(lost, target)))
      assert.equal(lost.colonies[other.PopulationID].modifier.sector, other.modifier.sector)

      const none = await run([`update FCT_RaceSysSurvey set SectorID = 0 where RaceID = 791 and SystemID = ${target.SystemID}`])

      assert.equal(none.colonies[target.PopulationID].modifier.sector, 1)
      assert.equal(rateOf(none, target).status, 'estimated', missingOf(rateOf(none, target)))

      const dropped = await run(['alter table FCT_RaceSysSurvey drop column SectorID'])

      assert.ok(Object.values(dropped.colonies).every((colony) => colony.modifier.sector === null), 'every colony has an unknown sector without the column')
      assert.equal(rateOf(dropped, target).status, 'unavailable')
    },
  },
  'admin bonus missing: terraforming': {
    needs: [AURELIAN],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, AURELIAN, 140, 784)
      const base = await adminsOf(modules, AURELIAN, 140, 784)
      const copy = mutatedOf(AURELIAN, ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 9 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 12)'])

      try {
        const admins = await modules['naval-admins'].loadNavalAdmins(copy, { GameID: 140, RaceID: 784, bonusId: 9, share: 'Industrial' })
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
    needs: [AURELIAN],
    run: async (modules) => {
      const { loadNavalAdmins } = modules['naval-admins']
      const { navalAdminChain, orbitalChainGap, orbitalMinerRate } = modules.minerals
      const base = await loadNavalAdmins(databaseOf(AURELIAN), { GameID: 140, RaceID: 784, bonusId: 6, share: 'Industrial' })
      const copy = mutatedOf(AURELIAN, ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 6 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 12)'])

      try {
        const admins = await loadNavalAdmins(copy, { GameID: 140, RaceID: 784, bonusId: 6, share: 'Industrial' })
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
  'fleet command missing': {
    needs: [passive(2)],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const unknown = mutatedOf(passive(2), ['update FCT_Fleet set ParentCommandID = null where AssignedPopulationID > 0'])
      const commandless = mutatedOf(passive(2), ['update FCT_Fleet set ParentCommandID = 0 where AssignedPopulationID > 0'])

      try {
        const lost = await loadTerraformSources(unknown, { GameID: 139, RaceID: 2 })
        const none = await loadTerraformSources(commandless, { GameID: 139, RaceID: 2 })
        const orbitalOf = (sources) => terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[4], admins: {} }).orbital

        assert.ok(lost.colonies[4].ships.length > 0 && lost.colonies[4].ships.every((ship) => ship.ParentCommandID === null))
        assert.equal(orbitalOf(lost).status, 'unavailable')
        assert.ok(/command association/.test(missingOf(orbitalOf(lost))) && !/FCT_|ParentCommandID/.test(missingOf(orbitalOf(lost))), missingOf(orbitalOf(lost)))
        assert.ok(none.colonies[4].ships.every((ship) => ship.ParentCommandID === 0))
        assert.equal(orbitalOf(none).status, 'estimated', missingOf(orbitalOf(none)))
      } finally {
        unknown.close()
        commandless.close()
      }
    },
  },
}

// Faults planted in the shared helper. `fails` names the BREAKDOWN_CHECKS each must break; a fault whose named checks all lack their saves is skipped.
const BREAKDOWN_FAULTS = [
  { label: 'installation sum not rounded down', from: 'raceRate * Math.trunc(source.installations) * modifier.value', to: 'raceRate * source.installations * modifier.value', fails: ['arith', 'truncation', 'rate Falryx'] },
  { label: 'Math.PI for the body area', from: 'export const SURFACE_PI = 3.1416', to: 'export const SURFACE_PI = Math.PI', fails: ['arith', 'rate Falryx'] },
  { label: 'game speed ignored', from: '(values.installations + values.orbital) * speed / 100', to: '(values.installations + values.orbital)', fails: ['arith', 'speed Falryx'] },
  { label: 'naval admin chain ignored', from: 'group.admin * group.effective', to: 'group.effective', fails: ['arith'] },
  { label: 'crew share ignored', from: 'modules === null || known(ship.crew) === null ? null : modules * ship.crew', to: 'modules === null ? null : modules', fails: ['arith', 'unknown'] },
  { label: 'unknown crew read as 1', from: 'modules === null || known(ship.crew) === null ? null : modules * ship.crew', to: 'modules === null ? null : modules * (known(ship.crew) ?? 1)', fails: ['unknown'] },
  { label: 'unknown captain bonus read as 1', from: 'staffed === null || known(ship.captain) === null ? null : staffed * ship.captain', to: 'staffed === null ? null : staffed * (known(ship.captain) ?? 1)', fails: ['unknown'] },
  { label: 'unknown fleet assignment read as no ships', from: "source.shipsKnown === false ? ['the fleets assigned to the colony'] : []", to: '[]', fails: ['unknown'] },
  { label: 'the sector bonus counted in full', from: '1 + (modifier.sector - 1) / 4', to: 'modifier.sector', fails: ['arith', 'rate Falryx'] },
  { label: 'a missing captain read as 0', from: ': null) : 1)', to: ': null) : 0)', fails: ['rate Falryx'] },
  { label: 'an unconfirmed commander bonus read as 1', from: 'captain: row.BonusUnknown ? null : bonusOf(', to: 'captain: bonusOf(', fails: ['blocked'] },
  { label: 'damaged modules counted', from: 'Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))', to: 'row.Designed', fails: ['damaged'] },
  { label: 'a present bonus row without a value read as 1 (captain)', from: 'captain: row.BonusUnknown ? null : bonusOf(row.CaptainBonus, row.CaptainRows, row.CaptainKnown)', to: 'captain: row.BonusUnknown ? null : row.CaptainBonus ?? 1', fails: ['bonus value missing: captain'] },
  { label: 'a present bonus row without a value read as 1 (governor)', from: 'governor: row.BonusUnknown ? null : bonusOf(row.GovernorBonus, row.GovernorRows, row.GovernorKnown)', to: 'governor: row.BonusUnknown ? null : row.GovernorBonus ?? 1', fails: ['bonus value missing: governor and sector'] },
  { label: 'a present bonus row without a value read as 1 (sector)', from: 'sector: row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(row.SectorBonus, row.SectorRows, row.SectorKnown)', to: 'sector: row.BonusUnknown ? null : row.SectorBonus ?? 1', fails: ['bonus value missing: governor and sector'] },
  { label: 'a damage row without a count read as no damage', from: '|| (row.DamageRows > 0 && !isNumber(row.Damaged))', to: '', fails: ['damage count missing'] },
  { module: 'terraform-capacity', label: 'an unknown fleet command named by its saved column', from: "adminGap: 'the fleet\\'s command association'", to: "adminGap: 'FCT_Fleet.ParentCommandID'", fails: ['fleet command missing'] },
  { label: 'an unknown fleet command read as commandless', from: 'const key = isNumber(ship.ParentCommandID) ? ship.ParentCommandID : null', to: 'const key = ship.ParentCommandID || 0', fails: ['fleet command missing'] },
  { label: 'an explicit commandless fleet read as unknown', from: 'const key = isNumber(ship.ParentCommandID) ? ship.ParentCommandID : null', to: 'const key = ship.ParentCommandID || null', fails: ['fleet command missing'] },
  { label: 'an unknown sector association read as no sector', from: 'row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(', to: 'row.BonusUnknown ? null : bonusOf(', fails: ['sector association missing'] },
  { label: 'an explicit no-sector read as unknown', from: 'row.SectorID === 0 ? 1 : bonusOf(', to: 'row.SectorID === 0 ? null : bonusOf(', fails: ['sector association missing'] },
  { module: 'naval-admins', label: 'a naval admin bonus row without a value read as neutral', from: 'admin.BonusRow && !(Number.isFinite(admin.BonusValue) && Number.isFinite(admin.Share)) ? BONUS_UNKNOWN : null', to: 'null', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { module: 'naval-admins', label: 'a naval admin map of valueless bonuses returned empty', from: '(admin.BonusValue && admin.Share) || admin.BonusRow', to: 'admin.BonusValue && admin.Share', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { module: 'minerals', label: 'the chain ignores an unknown command bonus', from: 'if (current.BonusUnknown) {', to: 'if (false) {', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
]

const climateOf = async (modules, file, game, race) => {
  const bodies = await modules['colonization-data'].loadBodies(databaseOf(file), { GameID: game, RaceID: race })
  const residuals = []

  for (const body of bodies) {
    if (!(body.AtmosPress > 0)) {
      continue
    }

    const listed = body.Atmosphere.filter((gas) => !gas.FrozenOut)
    const greenhouse = Math.min(3, 1 + body.AtmosPress / 10 + listed.reduce((sum, gas) => sum + (gas.GHGas ? gas.GasAtm : 0), 0))
    const anti = Math.min(3, 1 + body.DustLevel / 20000 + listed.reduce((sum, gas) => sum + (gas.AntiGHGas ? gas.GasAtm : 0), 0))

    residuals.push(Math.abs(Math.max(1, body.BaseTemp * greenhouse * body.Albedo / anti) - body.SurfaceTemp))
  }

  return residuals
}

const hiddenOf = async (file, game) => firstOf(file, 'select count(*) n, sum(case when (select coalesce(sum(a.GasAtm), 0) from FCT_AtmosphericGas a where a.GameID = b.GameID and a.SystemBodyID = b.SystemBodyID and a.FrozenOut = 0) < b.AtmosPress - 0.000001 then 1 else 0 end) hidden from FCT_SystemBody b where b.GameID = ? and b.AtmosPress > 0', game)

const planOf = async (modules, file, game, race, populationId) => {
  const { habitability, terraforming } = modules
  const database = databaseOf(file)
  const [bodies, species, rules] = await Promise.all([
    modules['colonization-data'].loadBodies(database, { GameID: game, RaceID: race }),
    modules['colonization-data'].loadSpecies(database, { GameID: game, RaceID: race }),
    modules['colonization-data'].loadRaceRules(database, { GameID: game, RaceID: race }),
  ])
  const population = await firstOf(file, 'select SystemBodyID, SpeciesID from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
  const limits = habitability.speciesLimits(species.find((row) => row.SpeciesID === population.SpeciesID))
  const body = bodies.find((row) => row.SystemBodyID === population.SystemBodyID)
  const gases = Object.fromEntries((await rowsOf(file, 'select GasID, Name, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel from DIM_Gases')).map((row) => [row.GasID, { AtmosGasID: row.GasID, AtmosGasName: row.Name, Name: row.Name, BoilingPoint: row.BoilingPoint, GHGas: row.GHGas, AntiGHGas: row.AntiGHGas, Dangerous: row.Dangerous, DangerousLevel: row.DangerousLevel }]))
  const skill = (Array.isArray(rules) ? rules[0] : rules).ColonizationSkill
  const assessment = terraforming.assessTerraforming(body, limits, skill, (id) => gases[id])

  return { assessment, body, limits, skill, cost: (state) => habitability.colonyCost(state, limits, skill) }
}

const stepOf = (assessment, label) => assessment.plan.steps.find((step) => step.label === label)

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

  const skip = (group, files) => {
    skipped += 1
    console.log(`SKIP ${group}: missing ${files.filter((file) => !present(file)).join(', ')}`)
  }

  const modules = await loadUtilities(['habitability', 'terraforming', 'colonization-data', 'colonization', 'terraform-capacity', 'naval-admins', 'minerals'], { stubs: { 'lodash/groupBy': GROUP_BY } })

  const fixtures = []

  for (const [label, before, after, game, populationId] of EXACT) {
    if (!present(before, after)) {
      skip(`rate ${label}`, [before, after])
      continue
    }

    await check(`rate ${label}`, async () => {
      const pair = await pairOf(before, after, game, populationId)

      assert.ok(pair.same, 'the order changed inside the pair')
      assert.ok(Math.abs(pair.ratio - 1) < 0.0005, `observed ${pair.observed} predicted ${pair.predicted} ratio ${pair.ratio}`)
      fixtures.push({ label, ...pair.capacity, observed: pair.observed, years: pair.years, radius: pair.radius })
    })
  }

  if (present(falryx(2904201340), falryx(2930673230))) {
    await check('rate Verun III residual', async () => {
      const pair = await pairOf(falryx(2904201340), falryx(2930673230), 141, 49103)

      assert.ok(Math.abs(pair.observed - pair.predicted) < 1e-9, `residual ${pair.observed - pair.predicted}`)
    })
    await check('rate the game time as the clock is off by percent', async () => {
      const pair = await pairOf(falryx(2904201340), falryx(2930673230), 141, 49103, 'GameTime')

      assert.ok(pair.predicted / pair.observed > 0.98 && pair.predicted / pair.observed < 0.99, `ratio ${pair.predicted / pair.observed}`)
    })
  }

  const passiveFiles = Array.from({ length: 13 }, (_, index) => passive(index + 1))

  if (present(...passiveFiles)) {
    await check('passive one step per snapshot until the target is passed', async () => {
      const body = 2304
      const step = 0.008184411500800627
      const pressure = async (number) => (await firstOf(passive(number), 'select AtmosPress p from FCT_SystemBody where GameID = 139 and SystemBodyID = ?', body)).p
      const order = async (number) => firstOf(passive(number), 'select TerraformStatus s, TerraformingGasID g from FCT_Population where GameID = 139 and PopulationID = 4')

      assert.ok(Math.abs(await pressure(2) - step) < 1e-12, 'the first step')

      for (let number = 3; number <= 12; number += 1) {
        assert.ok(Math.abs((await pressure(number)) - (await pressure(number - 1)) - step) < 1e-12, `snapshot ${number}`)
      }

      assert.ok(await pressure(12) > 0.09 && await pressure(12) < 0.0901, 'the target passed by less than a step')
      assert.equal(await pressure(13), await pressure(12))
      assert.deepEqual(await order(12), { s: 1, g: 10 })
      assert.deepEqual(await order(13), { s: 0, g: 0 })
    })
    await check('passive the capacity of the fleet gives the step', async () => {
      const population = await firstOf(passive(2), 'select * from FCT_Population where GameID = 139 and PopulationID = 4')
      const capacity = await capacityOf(passive(2), 139, population)
      const body = await firstOf(passive(2), 'select Radius from FCT_SystemBody where GameID = 139 and SystemBodyID = 2304')
      const delta = capacity.total * 5 * 86400 / SECONDS_PER_YEAR * EARTH_ATMOSPHERE_UNITS / (4 * PI * body.Radius ** 2)

      assert.ok(Math.abs(delta / 0.008184411500800627 - 1) < 1e-4, `step ${delta}`)
    })
  } else {
    skip('passive', passiveFiles)
  }

  for (const [label, file, game, race, within, outside] of [
    ['Egg', 'saves/AuroraDB.db', 138, 785, 127, 0],
    ['Falryx', falryx(2930673230), 141, 791, 206, 3],
  ]) {
    if (!present(file)) {
      skip(`climate ${label}`, [file])
      continue
    }

    await check(`climate ${label}`, async () => {
      const residuals = await climateOf(modules, file, game, race)

      assert.equal(residuals.filter((value) => value < 0.01).length, within)
      assert.equal(residuals.filter((value) => value >= 0.01).length, outside)
      assert.ok(Math.max(...residuals) < 0.1, `largest ${Math.max(...residuals)}`)
    })
  }

  for (const [label, file, game, bodies, hidden] of [
    ['Egg later', 'saves/AuroraDB.db', 138, 229, 7],
    ['Egg earlier', 'saves/AuroraDBSaveBackup.db', 138, 125, 17],
    ['Falryx last', falryx(2930673230), 141, 372, 43],
    ['passive snapshot 13', passive(13), 139, 48, 10],
  ]) {
    if (!present(file)) {
      skip(`hidden ${label}`, [file])
      continue
    }

    await check(`hidden ${label}`, async () => {
      const row = await hiddenOf(file, game)

      assert.deepEqual({ n: row.n, hidden: row.hidden }, { n: bodies, hidden })
    })
  }

  if (present(falryx(2398452450), falryx(2930673230))) {
    const first = falryx(2398452450)
    const last = falryx(2930673230)

    await check('plan Marcellin: the played final atmosphere is the plan', async () => {
      const { assessment, body } = await planOf(modules, first, 141, 791, 49195)
      const final = (await firstOf(last, 'select AtmosPress p from FCT_SystemBody where GameID = 141 and SystemBodyID = ?', body.SystemBodyID)).p
      const played = await gasOf(last, 141, body.SystemBodyID, 22)

      assert.equal(assessment.outcome, 'yes')
      assert.ok(Math.abs(stepOf(assessment, 'Frigusium').to - played) < 0.02, `plan ${stepOf(assessment, 'Frigusium').to} played ${played}`)
      assert.ok(final > 1.9)
    })
    await check('plan Pio: the played colony cost is 0 without the water the plan adds', async () => {
      const { assessment, body, cost } = await planOf(modules, first, 141, 791, 49202)
      const later = (await planOf(modules, last, 141, 791, 49202)).body
      const water = stepOf(assessment, 'Water Vapour')

      assert.ok(water && water.to - water.from > 0.2, 'the plan adds water')
      assert.ok(Math.abs(later.HydroExt - body.HydroExt) < 0.1, 'the played hydrosphere stays')
      assert.equal(cost(later).current, 0)
      assert.equal(cost(later).periapsis, 0)
      assert.equal(cost(later).apoapsis, 0)
    })
    await check('plan Aoede: the played colony cost is 0 where the plan stays partial', async () => {
      const { assessment, cost } = await planOf(modules, first, 141, 791, 49227)
      const later = (await planOf(modules, last, 141, 791, 49227)).body

      assert.equal(assessment.outcome, 'partial')
      assert.ok(assessment.after.periapsis > 0)
      assert.equal(cost(later).current, 0)
      assert.equal(cost(later).periapsis, 0)
      assert.equal(cost(later).apoapsis, 0)
    })
  } else {
    skip('plan', [falryx(2398452450), falryx(2930673230)])
  }

  const plans = present(falryx(2398452450)) ? [[falryx(2398452450), 141, 791, 49195], [falryx(2398452450), 141, 791, 49202], [falryx(2398452450), 141, 791, 49227]] : []
  const appFixtures = [...ARITHMETIC, ...fixtures]

  if (!plans.length) {
    skip('app plan work', [falryx(2398452450)])
  }

  await check('app capacity, plan years and plan work agree with the rules', async () => appOutputs(modules, appFixtures, plans))

  for (const [label, file, from, to, needsPlans] of mutating() ? APP_FAULTS : []) {
    if (needsPlans && !plans.length) {
      continue
    }

    await check(`app planted fault ${label} is caught`, async () => {
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${file}.js`), 'utf8')
      const planted = await loadUtilities(['habitability', 'terraforming', 'colonization-data'], { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [file]: plantedPatch(`${file}.js`, text, from, to) } })
      const caught = await appOutputs(planted, appFixtures, plans).then(() => false, () => true)

      assert.ok(caught, 'the app-output assertions still pass')
    })
  }

  const breakdownModules = ['habitability', 'terraforming', 'colonization-data', 'terraform-capacity', 'naval-admins', 'minerals']

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
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${module}.js`), 'utf8')
      const planted = await loadUtilities(breakdownModules, { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [module]: plantedPatch(`${module}.js`, text, from, to) } })

      for (const name of required) {
        const caught = await BREAKDOWN_CHECKS[name].run(planted).then(() => false, () => true)

        assert.ok(caught, `${name} still passes`)
      }
    })
  }

  const ledgerFiles = LEDGER_INTERVALS.flatMap(([, before, after]) => [before, after])

  if (present(...ledgerFiles)) {
    await check('ledger covers every moving pair with a class', async () => {
      const ledger = await ledgerOf()
      const counts = ledger.reduce((map, row) => ({ ...map, [row.class]: (map[row.class] || 0) + 1 }), {})

      if (process.argv.includes('--ledger')) {
        printLedger(ledger)
      }

      assert.deepEqual(counts, LEDGER_COUNTS)
      assert.equal(ledger.length, 34)
      assert.equal(ledger.filter((row) => row.class === 'exact').length, EXACT.length)
    })
  } else {
    skip('ledger', ledgerFiles)
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
