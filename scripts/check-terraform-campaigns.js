/*
  Checks the terraforming planner's inputs against observed campaigns (backlog AE-059-01), read only.

  node scripts/check-terraform-campaigns.js

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
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')

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
const RIN = ['AuroraDB_260_Reisen.db', 'saves/AuroraDB_26Simple.db', 139]
const EXACT = [
  ['Rin Venus carbon dioxide', ...RIN, 48989],
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

// Every pair of saves of one campaign whose colonies kept their order across the pair and moved the ordered gas, for every race of the game: [campaign, earlier save, later save, game]. The three short Falryx pairs, Rin's pair and Egg's one interval.
const LEDGER_INTERVALS = [
  ['Falryx A', falryx(2713949950), falryx(2740177930), 141],
  ['Falryx B', falryx(2794985390), falryx(2810693885), 141],
  ['Falryx C', falryx(2904201340), falryx(2930673230), 141],
  ['Rin', RIN[0], RIN[1], 139],
  ['Egg', 'saves/AuroraDBSaveBackup.db', 'saves/AuroraDB.db', 138],
]

const LEDGER_COUNTS = { exact: 13, 'climate: water vapour condenses': 6, 'rate: capacity changed, observed between the two predictions': 10, 'rate: capacity changed, observed outside the two predictions': 3, 'gap: no cause visible at the two saves': 3 }

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

  const modules = await loadUtilities(['habitability', 'terraforming', 'colonization-data', 'colonization'], { stubs: { 'lodash/groupBy': GROUP_BY } })

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

  if (present(...RIN.slice(0, 2))) {
    await check('rate Venus residual', async () => {
      const pair = await pairOf(RIN[0], RIN[1], 139, 48989)

      assert.ok(Math.abs(pair.observed - pair.predicted) < 1e-9, `residual ${pair.observed - pair.predicted}`)
    })
    await check('rate the game time as the clock is off by percent', async () => {
      const pair = await pairOf(RIN[0], RIN[1], 139, 48989, 'GameTime')

      assert.ok(pair.predicted / pair.observed > 0.96 && pair.predicted / pair.observed < 0.98, `ratio ${pair.predicted / pair.observed}`)
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
    ['Rin', RIN[1], 139, 779, 65, 0],
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
    ['Rin later', RIN[1], 139, 226, 0],
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

  for (const [label, file, from, to, needsPlans] of APP_FAULTS) {
    if (needsPlans && !plans.length) {
      continue
    }

    await check(`app planted fault ${label} is caught`, async () => {
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${file}.js`), 'utf8')
      const planted = await loadUtilities(['habitability', 'terraforming', 'colonization-data'], { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [file]: patched(`${file}.js`, text, from, to) } })
      const caught = await appOutputs(planted, appFixtures, plans).then(() => false, () => true)

      assert.ok(caught, 'the app-output assertions still pass')
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
      assert.equal(ledger.length, 35)
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
