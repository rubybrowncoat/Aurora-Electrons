/*
  Checks the colony cost of a body for a species of each of the four breathing gases (oxygen, methane, sulphur dioxide, ammonia) and the gravity classes the game suffixes to it (src/renderer/utilities/habitability.js, terraforming.js, terraform-limits.js, colonization-data.js, map-features.js, colonies.js).

  Two kinds of evidence. The oracle: on the migrated fixture and on the played save (the two saves of scripts/lib/fixtures.js), every colony with people has its stored infrastructure requirement turned back into a colony cost by the rule of colonies.js, and the planner's cost of the body for the colony's species (now or worst of the orbit) must be that cost, within the rounding of the stored integer and the growth of the population since it was stored. The saves hold colonies of oxygen, methane, ammonia and sulphur dioxide breathers (the fixture holds oxygen only), reported per breathing gas below. The same saves are the oracle of the freezing rule: a gas is frozen out below its freezing point on every stored row. The planted cases: bodies made here with every column the loaders read, whose costs are worked by hand from the game's rules, for what no stored colony shows (liquid water, ice and vapour for each breather, the water at periapsis and apoapsis, the danger of water vapour per breather, a gas that is dangerous to its own breather, LG, LGR and N at their boundaries, the water a plan drains for each breather, the water vapour of a plan under, at and over its limit, the Galaxy Map's colony-cost bands of a race by its own band options).

  The N predicate is settled by the game's rule: N tests the species' maximum gravity against 0.1, not the body's gravity. `retention` states where the two readings part and counts the species and bodies of the saves where they do.

  The map's danger flag is checked here too: the protection of the race's ships in a system against the system's danger rating, compared unrounded, so a protection of 4.6 against a danger of 5 is a shortfall that rounding would hide.

  The reported body (AE-311-22): Tau Cephei A I of saves/AuroraDB-320-thexruler.db, an oxygen breather's liquid ocean above 75 %, planned with the planner's own loaders and held against an independent working of the game's climate and colony cost rules from the save's own rows (the save is skipped when it is absent).

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults.

  bun scripts/check-breather-cost.js [--no-mutations]
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, subjectModule, runChecks, judged, caughtAll } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { FIXTURE, PLAYED } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const UTILITIES = path.join(root, 'src/renderer/utilities')
const MODULES = ['habitability', 'terraforming', 'terraform-limits', 'colonization-data', 'colonization', 'colonization-states', 'map-features', 'colonies', 'capabilities', 'provenance', 'decimal']
const ORIGINALS = Object.fromEntries(MODULES.map((name) => [name, fs.readFileSync(path.join(UTILITIES, `${name}.js`), 'utf8').replace(/\r\n/g, '\n')]))
const GROUP_BY = 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})'
const BREATHERS = { oxygen: 10, methane: 3, ammonia: 4, 'sulphur dioxide': 15 }
const NAMES = Object.fromEntries(Object.entries(BREATHERS).map(([name, id]) => [id, name]))
const close = (actual, expected, name) => assert.ok(Math.abs(actual - expected) < 1e-9, `${name}: ${actual} != ${expected}`)
const checks = []
const check = (id, name, run) => checks.push({ id, name, run })

// ---- The planted world: the DIM_Gases rows as the 3.2 export holds them (checked against the played save below) --------
// [name, boiling point, freezing point, greenhouse, anti-greenhouse, [rating, parts per million] for oxygen, methane, sulphur dioxide and ammonia breathers].
const GAS_TABLE = {
  3: ['Methane', 112, 91, 1, 0, [2, 500, 0, 0, 0, 0, 2, 10000]],
  4: ['Ammonia', 240, 195, 0, 0, [2, 50, 2, 500, 2, 1000, 0, 0]],
  5: ['Water Vapour', 245, 0, 0, 0, [0, 0, 0, 1000, 3, 5000, 2, 2000]],
  7: ['Nitrogen', 77, 63, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0]],
  10: ['Oxygen', 90, 54, 0, 0, [0, 0, 3, 50, 2, 2000, 3, 200]],
  15: ['Sulphur Dioxide', 263, 197, 1, 0, [2, 5, 2, 200, 0, 0, 2, 200]],
  20: ['Aestusium', 1, 0, 1, 0, [0, 0, 0, 0, 0, 0, 0, 0]],
  22: ['Frigusium', 1, 0, 0, 1, [0, 0, 0, 0, 0, 0, 0, 0]],
}
const DANGER_COLUMNS = ['DangerousOxygen', 'DangerousPPMOxygen', 'DangerousMethane', 'DangerousPPMMethane', 'DangerousSulphur', 'DangerousPPMSulphur', 'DangerousAmmonia', 'DangerousPPMAmmonia']
const tableRow = (id, extra = {}) => {
  const [AtmosGasName, BoilingPoint, FreezingPoint, GHGas, AntiGHGas, danger] = GAS_TABLE[id]

  return { AtmosGasID: id, AtmosGasName, BoilingPoint, FreezingPoint, GHGas, AntiGHGas, ...Object.fromEntries(DANGER_COLUMNS.map((column, index) => [column, danger[index]])), ...extra }
}
const gasInfo = (id) => (GAS_TABLE[id] ? tableRow(id) : null)
const gasOf = (id, GasAtm, AtmosGasPercentage, extra = {}) => ({ ...tableRow(id), GasAtm, AtmosGasPercentage, FrozenOut: 0, ...extra })
// A species of the given breathing gas: it lives between 258 and 318 K, breathes its gas between 0.1 and 0.3 atm, bears up to 4 atm and gravity from 0.5 to 1.5.
const speciesRow = (BreatheID, extra = {}) => ({ IdealTemperature: 288, TemperatureDeviation: 30, IdealBreathePressure: 0.2, BreathePressureDeviation: 0.1, IdealGravity: 1, GravityDeviation: 0.5, MaximumPressure: 4, BreatheID, PopulationDensityModifier: 1, ...extra })
// A planet that costs nothing to a species of the given gas until the case changes it: its own gas at 20 % of the air, nitrogen for the rest, and the water that costs an oxygen breather nothing (50 % liquid) or none for another breather.
const planet = (BreatheID, extra = {}) => ({ BodyClass: 1, BodyTypeID: 1, FixedBody: 0, TidalLock: 0, Radius: 6371, Gravity: 1, SurfaceTemp: 288, BaseTemp: 255, Albedo: 1, StarLuminosity: 1, DustLevel: 0, HydroExt: BreatheID === 10 ? 50 : 0, HydroID: BreatheID === 10 ? 3 : 1, AtmosPress: 1, Eccentricity: 0, OrbitalDistance: 1, Year: 8760, DistanceToParent: 1, Atmosphere: [gasOf(BreatheID, 0.2, 20), gasOf(7, 0.8, 80)], ...extra })
const costOf = (m, BreatheID, body, extra = {}) => m.h.colonyCost(body, m.h.speciesLimits(speciesRow(BreatheID, extra)), 1)

// ---- The saves: the colonies with people, one row each, with the body and the species the planner prices ---------------------
const shim = (database) => ({ query: async (sql) => [database.query(sql).all()] })
const SAVES = [['fixture', FIXTURE], ['played', PLAYED]]

const savedWorld = async (base) => {
  const world = []

  for (const [label, save] of SAVES) {
    const file = path.join(root, save.file)

    if (!fs.existsSync(file)) {
      console.log(`SKIP ${label}: ${save.file} is absent`)
      continue
    }

    const database = new Database(file, { readonly: true })
    const species = new Map(database.query('select SpeciesID, BreatheID, Oxygen as IdealBreathePressure, OxyDev as BreathePressureDeviation, PressMax as MaximumPressure, Temperature as IdealTemperature, TempDev as TemperatureDeviation, Gravity as IdealGravity, GravDev as GravityDeviation, PopulationDensityModifier from FCT_Species').all().map((row) => [row.SpeciesID, base.habitability.speciesLimits(row)]))
    const people = database.query(`select p.PopulationID, p.RaceID, p.PopName, p.Population, p.ReqInf, p.SpeciesID, p.SystemBodyID, r.ColonizationSkill from FCT_Population p join FCT_Race r on r.RaceID = p.RaceID and r.GameID = p.GameID where p.GameID = ${save.gameId} and p.Population > 0`).all()
    const bodies = new Map()

    for (const race of [...new Set(people.map((row) => row.RaceID))]) {
      for (const body of await base['colonization-data'].loadBodies(shim(database), { GameID: save.gameId, RaceID: race })) {
        bodies.set(`${race}/${body.SystemBodyID}`, body)
      }
    }

    const colonies = people.map((row) => ({ name: row.PopName, race: row.RaceID, ReqInf: row.ReqInf, Population: row.Population, skill: row.ColonizationSkill, species: species.get(row.SpeciesID), body: bodies.get(`${row.RaceID}/${row.SystemBodyID}`) }))

    world.push({ label, save, database, species, colonies, races: [...new Set(people.map((row) => row.RaceID))], shim: shim(database) })
  }

  return world
}

// The stored cost of a colony as the rule of colonies.js gives it, as a range: the requirement is the integer part of population x cost x 100 (x 2 on low gravity) / density, so the cost lies from the figure of the requirement up to that of the next whole requirement.
const storedRange = (m, colony) => {
  const lowGravity = colony.body.Gravity < colony.species.MinimumGravity ? 1 : 0
  const of = (ReqInf) => m.c.colonyCostResult({ ReqInf, Population: colony.Population, PopulationDensityModifier: colony.species.PopulationDensityModifier, LowGravity: lowGravity }).value

  return { low: of(colony.ReqInf), high: of(colony.ReqInf + 1) }
}

// A range this narrow tells the cost; a colony of a few hundred people tells only that the cost is under some figure.
const INFORMATIVE = 0.05
// The requirement is stored when the colony is recalculated, and the people and the temperature move after it: a hundredth of the cost and five thousandths of a unit cover one such step.
const slack = (figure) => 0.005 + 0.01 * figure

// Per colony: the stored range, the planner's cost now and worst, whether either lies in the range, and how far the nearer one is from it.
const compared = (m, colonies) => colonies.map((colony) => {
  const { low, high } = storedRange(m, colony)
  const cost = m.h.colonyCost(colony.body, colony.species, colony.skill)
  const reads = cost.colonisable ? [cost.current, cost.worst] : []
  const deviation = (figure) => (figure < low ? low - figure : figure > high ? figure - high : 0)
  const nearest = reads.length ? Math.min(...reads.map(deviation)) : Infinity

  return { name: colony.name, breather: colony.species.BreatheID, lowGravity: colony.body.Gravity < colony.species.MinimumGravity, informative: high - low <= INFORMATIVE, matches: reads.some((figure) => figure >= low - slack(figure) && figure <= high + slack(figure)), nonzero: high > 0.05, deviation: nearest, stored: low, now: reads[0], worst: reads[1] }
})

const summaryOf = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.breather))].sort((a, b) => a - b).map((breather) => {
  const own = rows.filter((row) => row.breather === breather)
  const informative = own.filter((row) => row.informative)

  return [breather, { n: own.length, informative: informative.length, informativeCosts: informative.filter((row) => row.nonzero).length, lowGravity: informative.filter((row) => row.lowGravity).length, matches: own.filter((row) => row.matches).length, maxDeviation: Math.max(0, ...informative.map((row) => row.deviation)) }]
}))

const MINIMUM_INFORMATIVE = { fixture: { 10: 20 }, played: { 3: 6, 4: 5, 10: 10, 15: 6 } }

check('oracle', 'the planner\'s colony cost of every colony with people is the cost its stored infrastructure requirement gives, for each breathing gas the saves hold', (m) => {
  const { world } = m

  assert.ok(world.length > 0, 'a save to compare with')

  for (const { label, colonies } of world) {
    const rows = compared(m, colonies)
    const summary = summaryOf(rows)

    Object.entries(summary).forEach(([breather, figures]) => console.log(`ORACLE ${label} ${NAMES[breather]} breathers: ${figures.n} colonies, ${figures.informative} tell the cost (${figures.informativeCosts} above zero, ${figures.lowGravity} on low gravity), ${figures.matches} match, largest deviation of those that tell ${figures.maxDeviation.toFixed(4)}`))
    assert.deepEqual(rows.filter((row) => !row.matches).map((row) => `${row.name} (${NAMES[row.breather]}): stored ${row.stored}, now ${row.now}, worst ${row.worst}`), [], `${label}: every colony's cost is in the range its stored requirement gives`)
    Object.entries(MINIMUM_INFORMATIVE[label]).forEach(([breather, minimum]) => assert.ok(summary[breather] && summary[breather].informative >= minimum, `${label}: at least ${minimum} colonies of ${NAMES[breather]} breathers tell the cost, not ${summary[breather] && summary[breather].informative}`))
    assert.ok(rows.filter((row) => row.informative && row.nonzero).length >= (label === 'played' ? 20 : 0), `${label}: colonies that tell a cost above zero`)
  }

  const played = world.find(({ label }) => label === 'played')

  if (played) {
    const summary = summaryOf(compared(m, played.colonies))

    assert.ok(Object.values(summary).reduce((total, figures) => total + figures.lowGravity, 0) >= 1, 'a colony on low gravity that tells its cost, so the doubling of the requirement is compared')
  }
})

// ---- Freezing: a gas is frozen out below its freezing point --------------------------------------------------------------------
check('frozen', 'the loaders read the freezing point of a gas and every stored frozen-out flag is the surface temperature under it, in the planner\'s cost as well', async (m) => {
  const { world } = m

  assert.ok(world.length > 0, 'a save to compare with')

  for (const { label, save, database, shim: source, species, races } of world) {
    const own = []
    const seen = new Set()

    for (const race of races) {
      for (const body of await m.d.loadBodies(source, { GameID: save.gameId, RaceID: race })) {
        if (!seen.has(body.SystemBodyID)) {
          seen.add(body.SystemBodyID)
          own.push(body)
        }
      }
    }

    const rows = own.flatMap((body) => body.Atmosphere.map((gas) => ({ body, gas })))
    const stored = new Map(database.query('select GasID, FreezingPoint, BoilingPoint from DIM_Gases').all().map((row) => [row.GasID, row]))
    const unmatched = rows.filter(({ body, gas }) => !!gas.FrozenOut !== (body.SurfaceTemp < gas.FreezingPoint))

    assert.ok(rows.length > 100, `${label}: gas rows to compare, not ${rows.length}`)
    assert.ok(rows.every(({ gas }) => gas.FreezingPoint === stored.get(gas.AtmosGasID).FreezingPoint), `${label}: a gas row of an atmosphere carries the freezing point of DIM_Gases`)
    assert.equal(unmatched.length, 0, `${label}: ${unmatched.length} of ${rows.length} stored flags disagree with the freezing point`)
    assert.ok(rows.some(({ gas }) => gas.FreezingPoint !== stored.get(gas.AtmosGasID).BoilingPoint), `${label}: rows whose boiling point differs, so the two rules differ`)
    assert.ok((await m.d.loadGases(source)).every((gas) => gas.FreezingPoint === stored.get(gas.GasID).FreezingPoint), `${label}: the gas list of the planner carries the freezing point`)
    console.log(`FROZEN ${label}: ${rows.length} gas rows of ${own.length} bodies, every flag is the surface temperature under the freezing point (the boiling point agrees on ${rows.filter(({ body, gas }) => !!gas.FrozenOut === (body.SurfaceTemp < stored.get(gas.AtmosGasID).BoilingPoint)).length})`)

    const limits = [...species.values()].filter((row) => Object.values(BREATHERS).includes(row.BreatheID))
    const unequal = own.filter((body) => body.Atmosphere.length).flatMap((body) => limits.map((row) => [m.h.costFactors(body, row, body.SurfaceTemp, false), m.h.costFactors(body, row, body.SurfaceTemp, true)]).filter(([saved, planned]) => saved.cost !== planned.cost || saved.factors.danger !== planned.factors.danger))

    assert.equal(unequal.length, 0, `${label}: the planned rule of freezing gives the cost of the stored flags`)
  }
})

// ---- The water term ----------------------------------------------------------------------------------------------------------------
const HYDROSPHERE = { none: 1, vapour: 2, liquid: 3, ice: 4 }
// [breathing gas, water, extent in %, the water factor]: oxygen pays below 20 % whatever the water is; methane and ammonia pay a tenth of the extent for liquid water only; sulphur dioxide pays the whole extent for liquid water and 5 % of it for an ice sheet.
const WATER_CASES = [
  [10, 'liquid', 10, 1], [10, 'ice', 10, 1], [10, 'vapour', 10, 1], [10, 'none', 10, 1], [10, 'liquid', 5, 1.5], [10, 'liquid', 20, 0], [10, 'ice', 60, 0],
  [3, 'liquid', 40, 4], [3, 'ice', 40, 0], [3, 'vapour', 40, 0], [3, 'none', 40, 0], [3, 'liquid', 0, 0], [3, 'liquid', 5, 0.5],
  [4, 'liquid', 25, 2.5], [4, 'ice', 25, 0], [4, 'liquid', 29.9, 2.99], [4, 'ice', 16, 0], [4, 'vapour', 25, 0],
  [15, 'liquid', 7, 7], [15, 'ice', 30, 1.5], [15, 'ice', 60, 3], [15, 'vapour', 30, 0], [15, 'none', 30, 0], [15, 'liquid', 0.5, 0.5], [15, 'ice', 0, 0],
]

check('water', 'the water term follows the breathing gas: oxygen below 20 %, a tenth of the liquid extent for methane and ammonia, the whole for sulphur dioxide, and 5 % of an ice sheet for sulphur dioxide alone', (m) => {
  for (const [breather, water, extent, expected] of WATER_CASES) {
    const body = planet(breather, { HydroExt: extent, HydroID: HYDROSPHERE[water] })
    const cost = costOf(m, breather, body)
    const name = `${NAMES[breather]} breather, ${extent} % ${water}`

    close(cost.factors.hydrosphere, expected, `${name}: the water factor`)
    close(cost.current, expected, `${name}: nothing else costs, so the cost is the water factor`)
    close(cost.worst, expected, `${name}: a circular orbit has one cost`)
  }
})

check('extremes', 'the water of a body at periapsis and apoapsis is the state its temperature there gives under the air it has, and each point prices it by the breather', (m) => {
  const type = (pressure, temperature) => m.h.hydrosphereTypeAt({ AtmosPress: pressure }, temperature)

  assert.equal(type(0, 300), HYDROSPHERE.none, 'no air, no water')
  assert.equal(type(0.004, 300), HYDROSPHERE.none, 'under 0.006 atm water above the freezing point does not stay')
  assert.equal(type(0.004, 200), HYDROSPHERE.ice, 'a frozen body under thin air keeps its ice')
  assert.equal(type(0.006, 300), HYDROSPHERE.liquid, 'at 0.006 atm the water stays')
  assert.equal(type(1, 245), HYDROSPHERE.ice, 'at 245 K the water is ice')
  assert.equal(type(1, 245.0001), HYDROSPHERE.liquid, 'above 245 K the water is liquid')
  assert.equal(type(1, 369), HYDROSPHERE.liquid, 'at 369 K the water is liquid')
  assert.equal(type(1, 369.0001), HYDROSPHERE.vapour, 'above 369 K the water is vapour')

  // A planet that swings from 394 to 465 K at periapsis to 180 to 213 K at apoapsis around 300 K now (the greenhouse of methane and sulphur dioxide warms it), on a species that lives anywhere from 0 to 600 K, so the water is the only cost: liquid now, vapour at periapsis, an ice sheet at apoapsis.
  const swing = (breather, extent) => planet(breather, { HydroExt: extent, HydroID: HYDROSPHERE.liquid, SurfaceTemp: 300, Eccentricity: 0.7, OrbitalDistance: 1.5 })
  const range = { IdealTemperature: 300, TemperatureDeviation: 300 }
  const expected = { 3: [1, 0, 0], 4: [1, 0, 0], 15: [10, 0, 0.5], 10: [1, 1, 1] }
  const extentOf = { 3: 10, 4: 10, 15: 10, 10: 10 }

  for (const breather of [3, 4, 15, 10]) {
    const body = swing(breather, extentOf[breather])
    const points = m.h.temperaturePoints(body)
    const species = m.h.speciesLimits(speciesRow(breather, range))
    const cost = m.h.colonyCost(body, species, 1)

    assert.ok(points.periapsis > 369 && points.apoapsis < 245, `the planted orbit crosses both thresholds: ${points.periapsis} and ${points.apoapsis}`)
    close(cost.raws.current, expected[breather][0], `${NAMES[breather]} breather: the water now is liquid`)
    close(cost.raws.periapsis, expected[breather][1], `${NAMES[breather]} breather: the water at periapsis is vapour`)
    close(cost.raws.apoapsis, expected[breather][2], `${NAMES[breather]} breather: the water at apoapsis is an ice sheet`)
  }
})

// ---- The danger set per breather -----------------------------------------------------------------------------------------------
const VAPOUR_CASES = [
  // [breathing gas, share of water vapour in %, the danger factor]: the pair of water vapour for each breather: none for oxygen (0 at 0 ppm) and methane (rating 0), rating 2 above 2,000 ppm for ammonia, rating 3 above 5,000 ppm for sulphur dioxide.
  [10, 5, 0], [3, 5, 0], [4, 0.3, 2], [4, 0.15, 0], [15, 0.6, 3], [15, 0.4, 0],
]

check('vapour', 'water vapour is a danger per breather by its own pair, never a cost line of its own', (m) => {
  for (const [breather, share, expected] of VAPOUR_CASES) {
    const body = planet(breather, { Atmosphere: [gasOf(breather, 0.2, 20), gasOf(5, share / 100, share), gasOf(7, 0.8, 80 - share)] })
    const cost = costOf(m, breather, body)
    const name = `${NAMES[breather]} breather, ${share} % water vapour`

    close(cost.factors.danger, expected, `${name}: the danger factor`)
    close(cost.current, expected, `${name}: the cost`)
    assert.equal(cost.dangerousGas ? cost.dangerousGas.AtmosGasID : null, expected ? 5 : null, `${name}: the dangerous gas`)
  }
})

check('own gas', 'a gas is dangerous to its own breather where the table says so: the danger set leaves no gas out, and the stock table rates none of the four breathing gases dangerous to its own breather', (m) => {
  Object.values(BREATHERS).forEach((breather) => assert.equal(m.h.gasDanger(tableRow(breather), breather).dangerous, 0, `${NAMES[breather]} is no danger to its own breathers in the stock table`))

  // A mod's table that rates ammonia, and oxygen, dangerous to their own breathers at 100 ppm.
  const modded = (breather, extra) => costOf(m, breather, planet(breather, { Atmosphere: [gasOf(breather, 0.2, 20, extra), gasOf(7, 0.8, 80)] }))
  const ammonia = modded(4, { DangerousAmmonia: 2, DangerousPPMAmmonia: 100 })
  const oxygen = modded(10, { DangerousOxygen: 3, DangerousPPMOxygen: 100 })

  close(ammonia.factors.danger, 2, 'an ammonia breather meets the rating its own gas has')
  close(oxygen.factors.danger, 3, 'an oxygen breather meets the rating its own gas has')
  assert.equal(ammonia.dangerousGas.AtmosGasID, 4, 'the dangerous gas of the ammonia breather is its own')
})

check('planned freeze', 'a gas of a body that does not exist yet is frozen out below its freezing point, its boiling point plays no part, and a saved body keeps the flag the game stored', (m) => {
  const wide = m.h.speciesLimits(speciesRow(10, { IdealTemperature: 300, TemperatureDeviation: 300 }))
  // Methane freezes at 91 K and boils at 112 K; it is dangerous (rating 2) to an oxygen breather above 500 ppm.
  const methane = (SurfaceTemp, FrozenOut = 0) => planet(10, { SurfaceTemp, Atmosphere: [gasOf(10, 0.2, 20), gasOf(3, 0.01, 1, { FrozenOut }), gasOf(7, 0.79, 79)] })
  const danger = (body, planned) => m.h.costFactors(body, wide, body.SurfaceTemp, planned).factors.danger

  close(danger(methane(100), true), 2, 'at 100 K the planned methane is not frozen: it is over its freezing point')
  close(danger(methane(91), true), 2, 'at its freezing point the gas is not frozen out')
  close(danger(methane(90.9), true), 0, 'under its freezing point it is frozen out')
  close(danger(methane(300, 1), false), 0, 'a saved body keeps the flag the game stored: frozen at 300 K')
  close(danger(methane(50, 0), false), 2, 'a saved body keeps the flag the game stored: not frozen at 50 K')

  // The greenhouse of a gas works only above its freezing point at the temperature of the point: methane at 0.5 atm warms a body at 100 K by half a unit of greenhouse where it freezes at 91 K, and not where it freezes at 105 K.
  const warmed = (FreezingPoint) => m.h.temperatureAtDistance({ BodyClass: 1, StarLuminosity: 1, SurfaceTemp: 100, BaseTemp: 100, Albedo: 1, AtmosPress: 0.5, DustLevel: 0, HydroExt: 0, HydroID: 1, Eccentricity: 0, Atmosphere: [gasOf(3, 0.5, 100, { FreezingPoint })] }, 6.5025)

  close(warmed(91), 155, 'the gas freezes at 91 K and the point is at 100 K: 1 + 0.05 + 0.5 of greenhouse')
  close(warmed(105), 105, 'the gas freezes at 105 K, over the point: no greenhouse from it')
})

// ---- LG, LGR and N -----------------------------------------------------------------------------------------------------------------
const classOf = (m, species, Gravity) => m.h.costFactors(planet(10, { Gravity }), m.h.speciesLimits(species), 288).gravityClass

check('gravity', 'a body below the species\' minimum gravity is LG under 0.1 g and LGR from 0.1 g, a body at or above the minimum has no class, and the class rides on the cost', (m) => {
  const stock = speciesRow(10)

  assert.equal(classOf(m, stock, 0.05), 'LG', '0.05 g is below the minimum and too light to keep an atmosphere')
  assert.equal(classOf(m, stock, 0.09), 'LG', '0.09 g')
  assert.equal(classOf(m, stock, 0.1), 'LGR', '0.1 g is the retention gravity')
  assert.equal(classOf(m, stock, 0.3), 'LGR', '0.3 g')
  assert.equal(classOf(m, stock, 0.4999), 'LGR', 'just under the minimum')
  assert.equal(classOf(m, stock, 0.5), null, 'at the minimum there is no class')
  assert.equal(classOf(m, stock, 1), null, 'inside the range')

  const low = m.h.colonyCost(planet(10, { Gravity: 0.3 }), m.h.speciesLimits(stock), 1)
  const flat = m.h.colonyCost(planet(10, { Gravity: 1 }), m.h.speciesLimits(stock), 1)

  assert.deepEqual([low.gravityClass, low.lowGravity, low.current], ['LGR', true, 1], 'the cost of a low-gravity body names the class, flags the doubling and has the floor of 1')
  assert.deepEqual([flat.gravityClass, flat.lowGravity, flat.current], [null, false, 0], 'the cost of a body in range has no class')

  // The class is the same for every breather: the gravity does not depend on the gas.
  Object.values(BREATHERS).forEach((breather) => assert.equal(costOf(m, breather, planet(breather, { Gravity: 0.05 })).gravityClass, 'LG', `${NAMES[breather]} breather`))
})

// Species ideals chosen as binary fractions so that the minimum and the maximum are exact.
const WITNESS = { IdealGravity: 0.125, GravityDeviation: 0.0625 }
const LIGHT = { IdealGravity: 0.0625, GravityDeviation: 0.03125 }

check('retention', 'N is told by the species\' maximum gravity against 0.1 g, as the game reads it: a species whose range lies under 0.1 g has N above its minimum, a species that reaches 0.1 g has none', (m) => {
  const light = speciesRow(10, LIGHT)
  const witness = speciesRow(10, WITNESS)

  // A species of 0.03125 to 0.09375 g: the whole range is under the retention gravity.
  assert.equal(classOf(m, light, 0.015625), 'LG', 'under the minimum and under 0.1 g')
  assert.equal(classOf(m, light, 0.03125), null, 'at the minimum there is no class')
  assert.equal(classOf(m, light, 0.0625), 'N', 'above the minimum, and the species cannot reach 0.1 g')
  assert.equal(classOf(m, light, 0.09375), 'N', 'at the maximum of such a species')

  // A species of 0.0625 to 0.1875 g reaches 0.1 g. A body of 0.078125 g is above its minimum and under 0.1 g: the game gives it no class, where the reading of the 3.0 patch note (above the minimum, body under 0.1 g) gives N.
  assert.equal(classOf(m, witness, 0.05), 'LG', 'under the minimum')
  assert.equal(classOf(m, witness, 0.0625), null, 'at the minimum')
  assert.equal(classOf(m, witness, 0.078125), null, 'the witness: the maximum is 0.1875 g, so there is no N')
  assert.equal(classOf(m, witness, 0.125), null, 'above 0.1 g')

  // N is no low gravity: the infrastructure is not doubled for it.
  const body = planet(10, { Gravity: 0.0625 })
  const cost = m.h.colonyCost(body, m.h.speciesLimits(light), 1)

  assert.deepEqual([cost.gravityClass, cost.lowGravity], ['N', false], 'N does not double the infrastructure')

  // Where the two readings part, on the species and the bodies of the saves: N needs a body above the species' minimum, and the note's reading needs it under 0.1 g, the game's a species whose maximum is under 0.1 g. A species whose minimum is 0.1 g or more can have neither.
  for (const { label, save, database, species } of m.world) {
    const limits = [...species.values()]
    const reaching = limits.filter((row) => row.MinimumGravity < 0.1)
    const gravities = database.query(`select distinct Gravity from FCT_SystemBody where GameID = ${save.gameId} and Gravity > 0`).all().map((row) => row.Gravity)
    const bySource = (body, row) => body.Gravity >= row.MinimumGravity ? (row.MaximumGravity >= 0.1 || !(body.Gravity > row.MinimumGravity) ? null : 'N') : null
    const byNote = (body, row) => (body.Gravity > row.MinimumGravity && body.Gravity < 0.1 ? 'N' : null)
    let source = 0
    let note = 0
    let differ = 0

    for (const row of reaching) {
      for (const Gravity of gravities) {
        const told = m.h.gravityClassOf({ Gravity }, row)

        assert.equal(told === 'N', bySource({ Gravity }, row) === 'N', `${label}: the module's N for a species of ${row.MinimumGravity} to ${row.MaximumGravity} g at ${Gravity} g is the predicate of the game`)
        source += told === 'N' ? 1 : 0
        note += byNote({ Gravity }, row) === 'N' ? 1 : 0
        differ += (told === 'N') !== (byNote({ Gravity }, row) === 'N') ? 1 : 0
      }
    }

    limits.filter((row) => row.MinimumGravity >= 0.1).forEach((row) => assert.ok([0.2, 0.5, 1, 1.5, 3].every((Gravity) => m.h.gravityClassOf({ Gravity }, row) !== 'N'), `${label}: a species of minimum ${row.MinimumGravity} g has no N`))
    console.log(`RETENTION ${label}: ${limits.length} species, ${reaching.length} with a minimum under 0.1 g, ${gravities.length} distinct body gravities; N by the game ${source} species-body pairs, by the patch note ${note}, the readings part on ${differ}`)
  }
})

// ---- The planner ---------------------------------------------------------------------------------------------------------------------
// A cold body of 100 % ice that a plan warms: the plan sets the atmosphere and settles the water.
const cold = (BreatheID, extra = {}) => planet(BreatheID, { SurfaceTemp: 198, BaseTemp: 180, StarLuminosity: (180 / 255) ** 4, Eccentricity: 0.25, HydroExt: 100, HydroID: HYDROSPHERE.ice, ...extra })
const plannerSpecies = (m, BreatheID) => m.h.speciesLimits(speciesRow(BreatheID, { IdealTemperature: 280, MaximumPressure: 10 }))
const planFor = (m, BreatheID, extra = {}) => {
  const body = cold(BreatheID, extra)
  const species = plannerSpecies(m, BreatheID)
  const assessment = m.t.assessTerraforming(body, species, 1, gasInfo)

  return { body, species, assessment, target: assessment.plan ? m.t.terraformedBody(body, species, assessment.plan, gasInfo) : null }
}
const vapourShare = (body) => body.Atmosphere.filter((gas) => gas.AtmosGasID === 5).reduce((total, gas) => total + gas.AtmosGasPercentage, 0)

check('planner', 'a plan for a breather other than oxygen selects a cheaper whole-orbit drain where one fits, the water vapour follows the breathing pair\'s limit, and the class and stages carry the gravity class', (m) => {
  const oxygen = planFor(m, 10)
  const methane = planFor(m, 3)
  const sulphur = planFor(m, 15)

  assert.ok(oxygen.target && methane.target && sulphur.target, 'each breather has a plan')
  close(oxygen.target.HydroExt, 75, 'the oxygen target keeps the 75 % that keeps the most people: its melted ocean is drained down to it, not to none and not left at 100 %')
  assert.equal((oxygen.assessment.plan.steps.find((step) => step.key === 'water') || { drained: null }).drained, 25, 'the water step drains the 25 % above 75 %')
  // A full wet target is no reason to keep a water penalty when another sampled atmosphere can finish a thaw and drain over the whole orbit.
  for (const found of [methane, sulphur]) {
    assert.equal(found.target.HydroExt, 0, 'the selected drain leaves no surface water')
    const pressure = found.target.Atmosphere.filter((gas) => !gas.FrozenOut).reduce((sum, gas) => sum + gas.GasAtm, 0)
    const warming = found.target.Atmosphere.filter((gas) => !gas.FrozenOut && gas.GHGas).reduce((sum, gas) => sum + gas.GasAtm, 0)
    const mean = 180 * Math.min(3, 1 + pressure / 10 + warming) * found.target.Albedo
    const dampening = Math.min(0.5, pressure / 10)
    const points = { current: mean, periapsis: mean * ((1 - dampening) / Math.sqrt(0.75) + dampening), apoapsis: mean * ((1 - dampening) / Math.sqrt(1.25) + dampening) }
    const expected = Object.fromEntries(Object.entries(points).map(([point, temperature]) => [point, Math.round(Math.max(0, (250 - temperature) / 30, (temperature - 310) / 30) * 10000) / 10000]))

    assert.deepEqual(found.assessment.after.raws, expected, 'the consistent dry target is independently priced; a conservative rejection need not retain the former full-orbit claim')
    assert.ok(found.assessment.plan.steps.some((step) => step.drained === 100), 'the displayed operations complete that drain')
    assert.ok(found.assessment.after.raw < found.assessment.cost.raw, 'the selected plan improves the whole-orbit cost')
  }
  const dryOxygen = cold(10, { HydroExt: 0, HydroID: HYDROSPHERE.none })
  const oxygenSpecies = plannerSpecies(m, 10)
  const harmless = m.t.planTerraforming(dryOxygen, oxygenSpecies, gasInfo)
  const ratedInfo = (id) => id === 5 ? { ...gasInfo(id), DangerousOxygen: 3, DangerousPPMOxygen: 5000 } : gasInfo(id)
  const rated = m.t.planTerraforming(dryOxygen, oxygenSpecies, ratedInfo)

  assert.ok(harmless, 'the harmless pair can supply a consistent wetter target')
  const harmlessTarget = m.t.terraformedBody(dryOxygen, oxygenSpecies, harmless, gasInfo)
  assert.equal(rated, null, 'a 0.5 % vapour ceiling under 10 atm cannot supply the 0.5 atm needed for a 20 % surface')
  const suppliedShare = ({ target }) => target.water / (target.water + target.breathable + target.greenhouse + target.antiGreenhouse + target.neutral) * 100

  assert.ok(suppliedShare(harmless) > 0.5, 'a harmless water-vapour pair imposes no share limit on the supplied water, including the supply that later condenses')
  assert.ok(vapourShare(harmlessTarget) < suppliedShare(harmless), 'the settled atmosphere does not retain the vapour that became surface water')
  assert.equal(m.t.assessTerraforming(dryOxygen, oxygenSpecies, 1, ratedInfo).plan, null, 'the unsupplied ordinary target is not displayed')
  assert.equal(sulphur.assessment.after.factors.danger, 0, 'the plan adds no gas dangerous to the species')

  // The gravity class of a low-gravity body is carried by the assessment and by the stages.
  const light = planFor(m, 10, { Gravity: 0.3 })
  const stages = m.l.terraformStages({ assessment: light.assessment, body: light.body, species: light.species, skill: 1, gasInfo })

  assert.equal(light.assessment.gravityClass, 'LGR', 'the assessment carries the class')
  assert.ok(stages, 'the plan has stages')
  assert.deepEqual([stages.gravityClass, stages.stages[0].gravityClass], ['LGR', 'LGR'], 'the stages carry the class')
  assert.equal(planFor(m, 10).assessment.gravityClass, null, 'a body in range has none')
})

// ---- The water a plan drains --------------------------------------------------------------------------------------------------
const speciesOf = (m, BreatheID, row = {}) => m.h.speciesLimits(speciesRow(BreatheID, row))
const wet = (BreatheID, extra = {}) => planet(BreatheID, { HydroExt: 50, HydroID: HYDROSPHERE.liquid, SurfaceTemp: 280.5, ...extra })
const ZERO = { current: 0, periapsis: 0, apoapsis: 0 }

check('drain', 'a world whose air suits a breather other than oxygen but whose liquid water costs is not done: the plan drains the water as the game\'s terraformer does and counts the drain as work, ice that no breather can drain is left, what costs nothing needs no plan, and an oxygen breather\'s liquid ocean above 75 % is drained down to 75 % and no further', (m) => {
  const assess = (breather, body, row = {}) => m.t.assessTerraforming(body, speciesOf(m, breather, row), 1, gasInfo)

  // 50 % of liquid water at 280.5 K under 1 atm of the breather's gas and nitrogen: the extent times 0.1 for methane and ammonia, times 1 for sulphur dioxide.
  for (const [breather, cost] of [[3, 5], [4, 5], [15, 50]]) {
    const body = wet(breather)
    const assessment = assess(breather, body)
    const name = `${NAMES[breather]} breather, 50 % liquid water`

    close(assessment.cost.raws.current, cost, `${name}: the water costs its term`)
    assert.equal(assessment.outcome, 'yes', `${name}: the body is not done`)
    assert.deepEqual(assessment.plan.steps.filter((step) => step.gasId === 5).map((step) => step.key), ['water'], `${name}: water vapour has the water step alone, never a removal and an addition`)

    const water = assessment.plan.steps.find((step) => step.key === 'water')

    assert.equal(water.drained, 50, `${name}: the plan drains the 50 %`)
    assert.ok(water.work > 0 && water.atm >= 1.25, `${name}: the drain is work, 1 atm of vapour for each 40 % of the surface`)
    assert.deepEqual(assessment.after.raws, ZERO, `${name}: nothing costs after the plan`)
    assert.equal(m.t.terraformedBody(body, speciesOf(m, breather), assessment.plan, gasInfo).HydroExt, 0, `${name}: the end state is a dry surface`)
  }

  // Nothing to drain: a dry world, and an ice sheet for a breather with no ice term, are done.
  for (const breather of [3, 4, 15]) {
    assert.equal(assess(breather, wet(breather, { HydroExt: 0, HydroID: HYDROSPHERE.none })).outcome, 'done', `${NAMES[breather]} breather: a dry world costs nothing`)
  }

  for (const breather of [3, 4]) {
    assert.equal(assess(breather, wet(breather, { HydroID: HYDROSPHERE.ice })).outcome, 'done', `${NAMES[breather]} breather: an ice sheet costs nothing`)
  }

  // An ice sheet that stays ice is not drained, as the game's evaporation works on liquid water only: a sulphur dioxide breather pays 5 % of its extent for it and the plan cannot take that away.
  const stuck = assess(15, cold(15, { Eccentricity: 0, BaseTemp: 70, SurfaceTemp: 91 }), { IdealTemperature: 150, TemperatureDeviation: 90, MaximumPressure: 10 })

  close(stuck.cost.raws.current, 5, 'the ice sheet costs a sulphur dioxide breather 5 % of its extent')
  assert.notEqual(stuck.outcome, 'done', 'it is not done')
  assert.ok(!stuck.plan || stuck.plan.steps.every((step) => step.drained === 0), 'the ice is not drained')
  close(stuck.after.raws.current, 5, 'the ice still costs after the plan')
  assert.equal(stuck.plan, null, 'the search offers no equal-cost atmosphere change that leaves the water penalty')
  assert.equal(stuck.reason, 'No change of atmosphere in the bounded search lowers the colony cost', 'the reason states that no improving plan was found')

  // The cold ice body on a circular orbit can thaw and drain for the other breathers (all the melted water) and for an oxygen breather (what is above the 75 % that keeps the most people).
  for (const breather of [3, 4, 15]) {
    const { assessment, target } = planFor(m, breather, { Eccentricity: 0 })
    const name = `${NAMES[breather]} breather, 100 % ice warmed to liquid`

    assert.equal(assessment.outcome, 'yes', `${name}: the plan solves it`)
    assert.equal(assessment.plan.steps.find((step) => step.key === 'water').drained, 100, `${name}: the plan drains the melted water`)
    assert.equal(target.HydroExt, 0, `${name}: the end state is a dry surface`)
    assert.deepEqual(assessment.after.raws, ZERO, `${name}: nothing costs after the plan`)
  }

  const sweet = planFor(m, 10, { Eccentricity: 0 })
  const melted = sweet.assessment.plan.steps.find((step) => step.key === 'water')
  const air = sweet.target.Atmosphere.filter((gas) => !gas.FrozenOut)
  // The thawed surface loses the ice albedo it had (0.0015 for each percent of the surface), so the albedo is 1 + 0.0015 * 100; the orbit is circular, so the temperature is the base 180 K times the two multipliers and the albedo.
  const temperature = 180 * Math.min(3, 1 + air.reduce((sum, gas) => sum + gas.GasAtm, 0) / 10 + air.filter((gas) => gas.GHGas).reduce((sum, gas) => sum + gas.GasAtm, 0)) * (1 + 0.0015 * 100)

  assert.equal(sweet.assessment.outcome, 'yes', 'an oxygen breather\'s 100 % ice warmed to liquid is solved')
  assert.equal(melted ? melted.drained : null, 25, 'the plan drains the 25 % above the 75 % that keeps the most people, not the whole melted ocean')
  close(sweet.target.HydroExt, 75, 'the end state keeps 75 % of the surface in water')
  assert.equal(sweet.target.HydroID, HYDROSPHERE.liquid, 'and it is liquid')
  assert.ok(temperature >= 250 && temperature <= 310, `the worked end temperature ${temperature} is inside the species' 250 to 310 K`)
  close(sweet.target.SurfaceTemp, temperature, 'the end temperature is the one the climate rule gives')
  assert.deepEqual(sweet.assessment.after.raws, ZERO, 'nothing costs after the plan')
})

// ---- An oxygen breather's ocean above 75 % ---------------------------------------------------------------------------------------------
// The body of the report (AE-311-22), read from the save it was reported on, a witness on the terms of the played saves of scripts/lib/fixtures.js: Tau Cephei A I (game 161, race 909), a tide-locked planet with a 94.79 % liquid ocean at 75.7 °C and 0.337 atm of oxygen, for the Human species (878: oxygen from 0.1 to 0.3 atm, 287.02 K give or take 24, up to 4 atm). Every liquid end state of an oxygen breather aims the ocean at 75 % (above it the capacity falls), so each needs surface water taken off, which only a drain does.
const REPORTED = Object.freeze({ file: 'saves/AuroraDB-320-thexruler.db', gameId: 161, raceId: 909, bodyId: 2485971, speciesId: 878 })

// The game's climate worked from stored rows alone, with no call of the code under test. At `distance` AU from the star a body is at 255 / sqrt(distance / sqrt(luminosity)) (4 K at least), times the greenhouse multiplier min(3, 1 + pressure / 10 + warming gas) and the albedo, over the anti-greenhouse multiplier min(3, 1 + dust / 20000 + cooling gas). An eccentric body with air or water blends that toward the same at its own orbital distance by the dampening (min(0.5, pressure / 10) + min(0.3, water / 100 * 0.3)) * min(1, 1 / sqrt(year / 8760)), water in percent.
const climateAt = ({ body, luminosity, pressure, warming, cooling, extent }, distance) => {
  const equilibrium = (at) => Math.max(255 / Math.sqrt(at / Math.sqrt(luminosity)), 4)
  const dampening = body.Eccentricity > 0 && (pressure > 0 || extent > 0) ? (Math.min(0.5, pressure / 10) + Math.min(0.3, extent / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(body.Year / 8760)) : 0

  return (equilibrium(distance) * (1 - dampening) + equilibrium(body.OrbitalDistance) * dampening) * Math.min(3, 1 + pressure / 10 + warming) * body.Albedo / Math.min(3, 1 + body.DustLevel / 20000 + cooling)
}

check('oxygen drain', 'an oxygen breather\'s liquid ocean above 75 % is planned with the drain down to 75 %, neither left partial nor drained to none: Tau Cephei A I is free to colonise after the drain, inside the species\' temperature range over its whole orbit, with the cooling gas under 2 atm and the figures held against a working of the game\'s rules from the save\'s own rows', async (m) => {
  const file = path.join(root, REPORTED.file)

  if (!fs.existsSync(file)) {
    console.log(`SKIP oxygen drain: ${REPORTED.file} is absent`)
    return
  }

  const OXYGEN_ID = 10
  const VAPOUR_ID = 5
  const COOLING_ID = 22
  const database = new Database(file, { readonly: true })

  try {
    // What the planner is given: its own loaders' body, species, race rules and gas table.
    const source = shim(database)
    const context = { GameID: REPORTED.gameId, RaceID: REPORTED.raceId }
    const body = (await m.d.loadBodies(source, context)).find((candidate) => candidate.SystemBodyID === REPORTED.bodyId)
    const species = m.h.speciesLimits((await m.d.loadSpecies(source, context)).find((candidate) => candidate.SpeciesID === REPORTED.speciesId))
    const { ColonizationSkill: skill } = await m.d.loadRaceRules(source, context)
    const gases = await m.d.loadGases(source)
    const info = (id) => gases.find((row) => row.GasID === id)

    // What the oracle is given: the stored rows, read here.
    const stored = database.query('select Radius, Gravity, HydroExt, HydroID, Albedo, AtmosPress, DustLevel, OrbitalDistance, DistanceToParent, Eccentricity, Year, SurfaceTemp, StarID from FCT_SystemBody where SystemBodyID = ?').get(REPORTED.bodyId)
    const { Luminosity: luminosity } = database.query('select Luminosity from FCT_Star where StarID = ?').get(stored.StarID)
    const table = new Map(database.query('select GasID, FreezingPoint, GHGas, AntiGHGas, DangerousOxygen, DangerousPPMOxygen from DIM_Gases').all().map((row) => [row.GasID, row]))
    const held = new Map(database.query('select AtmosGasID, GasAtm from FCT_AtmosphericGas where SystemBodyID = ?').all(REPORTED.bodyId).map((row) => [row.AtmosGasID, row.GasAtm]))
    const kind = database.query('select BreatheID, Oxygen, OxyDev, PressMax, Temperature, TempDev, Gravity, GravDev from FCT_Species where SpeciesID = ?').get(REPORTED.speciesId)
    const range = { minimum: kind.Temperature - kind.TempDev, maximum: kind.Temperature + kind.TempDev }
    const breathing = { minimum: kind.Oxygen - kind.OxyDev, maximum: kind.Oxygen + kind.OxyDev }

    assert.ok(body && species && stored && kind.BreatheID === OXYGEN_ID, 'the body and the oxygen-breathing species of the report are in the save')
    assert.ok(stored.HydroID === HYDROSPHERE.liquid && stored.HydroExt > 75, 'the body holds a liquid ocean above 75 %')
    assert.ok(held.get(OXYGEN_ID) > breathing.maximum, 'its oxygen is over what the species breathes')

    // The climate of an atmosphere (gas id to atm, none frozen out) under `extent` % of water at the three points the colony cost prices: the body now, at periapsis and at apoapsis.
    const climate = (amounts, extent) => {
      const sum = (keep) => [...amounts].reduce((total, [id, atm]) => total + (keep(table.get(id)) ? atm : 0), 0)
      const state = { body: stored, luminosity, pressure: sum(() => true), warming: sum((gas) => gas.GHGas), cooling: sum((gas) => gas.AntiGHGas), extent }

      return { pressure: state.pressure, current: climateAt(state, stored.DistanceToParent), periapsis: climateAt(state, stored.OrbitalDistance * (1 - stored.Eccentricity)), apoapsis: climateAt(state, stored.OrbitalDistance * (1 + stored.Eccentricity)) }
    }
    const POINTS = ['current', 'periapsis', 'apoapsis']

    // The oracle reproduces the saved climate before it prices anything: the saved pressure and the saved surface temperature, from the stored gases.
    const now = climate(held, stored.HydroExt)

    assert.ok(Math.abs(now.pressure - stored.AtmosPress) < 1e-9, `the stored gases add to the stored pressure: ${now.pressure} != ${stored.AtmosPress}`)
    assert.ok(Math.abs(now.current - stored.SurfaceTemp) < 1e-6, `the climate rule reproduces the stored surface temperature: ${now.current} != ${stored.SurfaceTemp}`)

    // The cost as saved: breathing outside the range costs 2 unless the temperature already costs more, the temperature costs its excess over the range per deviation and a fifth of it on a tide-locked planet, and the pressure costs nothing under its limit. The oxygen is over its limit and the water of an oxygen breather costs only under 20 %.
    const costNow = Object.fromEntries(POINTS.map((point) => {
      const temperature = Math.max(0, range.minimum - now[point], now[point] - range.maximum) / kind.TempDev / 5

      assert.ok(now.pressure <= kind.PressMax, 'the saved pressure is under the limit, so it costs nothing')

      return [point, Math.round(Math.max(temperature < 2 ? 2 : temperature, 0) * 10000) / 10000]
    }))
    const assessment = m.t.assessTerraforming(body, species, skill, info)

    assert.deepEqual(assessment.cost.raws, costNow, 'the cost as saved is the one the rule gives')

    // The plan: free to colonise, a complete plan, a drain that is a minimum in time.
    const { plan } = assessment

    assert.equal(assessment.outcome, 'yes', `an oxygen breather's ocean above 75 % is planned to free: ${assessment.outcome}`)
    assert.ok(plan && !plan.partial, 'the plan holds the whole orbit in the species\' range, it is not partial')
    assert.equal(assessment.timeBasis, m.t.TIME_BASIS.MINIMUM, 'the plan drains surface water, so its years are a minimum')

    // The drain takes the excess over 75 % off the surface: 94.79 to 75 %, not to none.
    const water = plan.steps.find((step) => step.key === 'water')

    assert.ok(water, 'the plan has a water step')
    close(water.drained, stored.HydroExt - 75, 'the water step drains the part of the ocean above 75 %')
    assert.ok(water.drained < stored.HydroExt - 1, 'and not the whole ocean')

    const end = m.t.terraformedBody(body, species, plan, info)

    close(end.HydroExt, 75, 'the end state keeps 75 % of the surface in water')
    close(plan.target.hydroExt, 75, 'and so does the plan\'s target')

    // The atmosphere the displayed operations leave, from the saved rows: a step sets the figure of its gas (none removes it). The vapour that stays is the humidity of a liquid 75 % ocean under the end pressure, 1 % of the surface's share of the air.
    const after = new Map(held)

    plan.steps.forEach((step) => (step.set > 0 ? after.set(step.gasId, step.set) : after.delete(step.gasId)))
    const planned = climate(after, 75)

    assert.ok(Math.abs(after.get(VAPOUR_ID) - planned.pressure * 0.75 * 0.01) < 1e-8, 'the vapour left is the humidity of a liquid 75 % ocean under the end pressure')
    assert.ok([...after.keys()].every((id) => table.get(id).FreezingPoint < Math.min(...POINTS.map((point) => planned[point]))), 'no gas of the end state freezes out anywhere in the orbit')
    POINTS.forEach((point) => assert.ok(planned[point] > range.minimum && planned[point] < range.maximum && planned[point] > 273.15 && planned[point] < 373.15, `the end temperature at ${point}, ${planned[point]} K, is inside ${range.minimum} to ${range.maximum} K and the ocean stays liquid`))
    assert.ok(Math.abs(end.SurfaceTemp - planned.current) < 1e-6, `the plan's end temperature is the one the climate rule gives: ${end.SurfaceTemp} != ${planned.current}`)
    assert.ok(Math.abs(end.AtmosPress - planned.pressure) < 1e-9, 'and its pressure is the sum of the gases')

    // The cost after: no factor is left. Gravity is in the species' range, the pressure under its limit, the oxygen in its range and under 30 % of the air, no gas the table rates dangerous to oxygen breathers is over its limit, and 75 % of water costs an oxygen breather nothing.
    const share = (id) => after.get(id) / planned.pressure * 100

    assert.ok(stored.Gravity >= kind.Gravity - kind.GravDev && stored.Gravity <= kind.Gravity + kind.GravDev, 'the gravity is in the species\' range')
    assert.ok(planned.pressure <= kind.PressMax, `the end pressure ${planned.pressure} is under ${kind.PressMax} atm`)
    assert.ok(after.get(OXYGEN_ID) >= breathing.minimum - 1e-9 && after.get(OXYGEN_ID) <= breathing.maximum + 1e-9 && share(OXYGEN_ID) <= 30, 'the oxygen is in its range and at most 30 % of the air')
    assert.deepEqual([...after.keys()].filter((id) => table.get(id).DangerousOxygen > 0 && share(id) > table.get(id).DangerousPPMOxygen / 10000), [], 'no gas rated dangerous to an oxygen breather is over its limit')
    assert.deepEqual(assessment.after.raws, ZERO, 'nothing costs after the plan')
    assert.equal(assessment.after.worst, 0, 'and the worst point costs nothing after the colonisation skill')

    // The cooling gas: some is needed (the stored temperature is over the range) and it stays under the 2 atm of cooling the earlier plan ran into, which ended the orbit frozen.
    const cooling = after.get(COOLING_ID) || 0

    assert.ok(cooling > 0 && cooling < 2, `the plan adds ${cooling} atm of the cooling gas, under 2 atm`)

    // The work: the drain is 1 atm of vapour for each 40 % of the surface, the other steps their change of pressure, all over the game's unit of surface (four times 3.1416 times the radius squared against the Earth's 511,187,128).
    const ratio = 4 * 3.1416 * stored.Radius ** 2 / 511187128
    const work = plan.steps.reduce((total, step) => total + (Math.abs((after.get(step.gasId) || 0) - (held.get(step.gasId) || 0)) + step.drained / 40) * ratio, 0)

    close(plan.work, work, 'the work is the change of each gas and the drain at 1 atm for each 40 %')

    // The stages: the surface is as saved before the drain operation, and 75 % after it and in every stage that follows.
    const staged = m.l.terraformStages({ assessment, body, species, skill, gasInfo: info })
    const drainIndex = plan.steps.findIndex((step) => step.drained > 0)

    assert.ok(staged, 'the plan has stages')
    close(staged.stages[drainIndex].hydroExt, stored.HydroExt, 'before the drain the stage holds the surface as saved')
    staged.stages.slice(drainIndex + 1).forEach((stage) => close(stage.hydroExt, 75, 'the drain and the stages after it hold 75 %'))
    console.log(`OXYGEN DRAIN ${body.SystemName} ${body.PlanetNumber}: drains ${water.drained.toFixed(4)} % of ${stored.HydroExt.toFixed(4)} % to 75 %, ${cooling.toFixed(4)} atm of cooling, ${planned.current.toFixed(2)} K now, ${planned.periapsis.toFixed(2)} to ${planned.apoapsis.toFixed(2)} K over the orbit, cost ${assessment.cost.worst} to ${assessment.after.worst}`)
  } finally {
    database.close()
  }
})

// Terra's frozen-start and hold-shortcut counterexamples: the printed sequence must reach a thaw before the water operation can finish.
check('drain order', 'a frozen ammonia world warms before draining, and costly sulphur ice yields its held climate to the warm-then-drain search', (m) => {
  for (const [breather, body, row] of [
    [4, cold(4, { HydroExt: 50, Eccentricity: 0 }), {}],
    [15, cold(15, { BaseTemp: 240 / 1.3, SurfaceTemp: 240, HydroExt: 50, Eccentricity: 0 }), { IdealTemperature: 260, TemperatureDeviation: 40 }],
    [15, cold(15, { BaseTemp: 240 / 1.3, SurfaceTemp: 240, HydroExt: 50, Eccentricity: 0 }), { IdealTemperature: 235, TemperatureDeviation: 30 }],
  ]) {
    const species = speciesOf(m, breather, row)
    const assessment = m.t.assessTerraforming(body, species, 1, gasInfo)
    const name = `${NAMES[breather]} frozen start`

    assert.equal(assessment.outcome, 'yes', `${name}: a reachable zero-cost plan is selected`)
    assert.deepEqual(assessment.after.raws, ZERO, `${name}: the priced end is dry and suitable`)
    const drainIndex = assessment.plan.steps.findIndex((step) => step.drained > 0)

    assert.ok(drainIndex > 0, `${name}: the drain cannot be the first operation`)
    const stages = m.l.terraformStages({ assessment, body, species, skill: 1, gasInfo }).stages
    const before = stages[drainIndex]
    const after = stages[drainIndex + 1]

    assert.equal(before.body.HydroID, HYDROSPHERE.liquid, `${name}: the preceding warming has thawed the surface`)
    assert.equal(before.hydroExt, 50, `${name}: the warming has not drained the water`)
    assert.equal(after.hydroExt, 0, `${name}: the completed drain leaves a dry surface`)
    assert.ok(after.temperature > 245, `${name}: drainage does not refreeze before completion`)
  }

  const body = cold(4, { BaseTemp: 220, SurfaceTemp: 240, StarLuminosity: (220 / 255) ** 4, Eccentricity: 0.15, HydroExt: 50 })
  const species = speciesOf(m, 4, { IdealTemperature: 280, TemperatureDeviation: 60 })
  const points = m.h.temperaturePoints(body)

  assert.ok(points.periapsis > 245 && points.apoapsis < 245, 'the seasonal start thaws at periapsis and freezes at apoapsis')
  const assessment = m.t.assessTerraforming(body, species, 1, gasInfo)
  const stages = m.l.terraformStages({ assessment, body, species, skill: 1, gasInfo }).stages
  const drain = stages.find((stage) => stage.step && stage.step.drained > 0)

  assert.equal(assessment.outcome, 'yes', 'a seasonal thaw can complete the water-removal order')
  assert.ok(drain && drain.hydroExt === 0, 'the completed seasonal drain is dry')
})

// ---- The time a drain takes ------------------------------------------------------------------------------------------------------
// Sol's probe: an ammonia breather's body with 50 % of liquid water at 280.5 K under 1 atm (0.2 atm of ammonia, 0.8 of nitrogen). The drain is 1.2472576986093435 Earth atm of work, so 100 Earth atm a year of terraformers (100 installations of rate 1) move it in 0.0125 years, 4.55 days: the bound of the capacity. The terraformer removes only the vapour in the air and the surface adds vapour in small steps: one such step of 0.005 atm (0.2 % of the surface) leaves 49.8 % of the water, which still costs 4.98.
const YEARS = (years) => `${years} years`
// How a page that writes years at one decimal shows them: the precision a minimum is floored to before it is handed over.
const ONE_PLACE = (years) => `${years.toFixed(1)} years`
// The body detail's precision for a plan under ten years.
const TWO_PLACES = (years) => `${years.toFixed(2)} years`
const DRAIN_WORK = 1.2472576986093435

// The Planner's ranking of one planted body for one species of rate-1 terraformers: the real assessBodies and rankBodies.
const ranked = async (m, BreatheID, body, species = {}, terraformers = 100) => {
  const rules = { ColonizationSkill: 1, TerraformingRate: 1, TerraformingSpeed: 100 }
  const planted = { ...body, SystemBodyID: 1, SystemID: 1, Minerals: [], OwnPopulations: [], AlienPopulations: [], CmcBlockers: [], BodySurveyed: 0, ParentOrbitalDistance: 0, ParentEccentricity: 0, ParentYear: 0 }
  const assessed = await m.z.assessBodies([planted], [{ SpeciesID: 1, SpeciesName: 'Planted', ...speciesRow(BreatheID, species) }], rules, gasInfo)
  const [row] = await m.z.rankBodies(assessed, { speciesId: null, goal: 'people', ranking: m.z.normaliseRanking(null), rules, terraformers, distanceOf: () => ({ km: 1.496e8, jumps: 1, from: null }), capitalDistanceOf: () => null, origins: { colonies: 1, capital: true } })

  return row
}

check('minimum time', 'the years of a plan that drains surface water are the terraformers\' time for its work and are labelled a minimum, in the assessment, its steps, the ranking, the plan states and the provenance of the score; every other plan keeps its time as it was', async (m) => {
  const MINIMUM = m.t.TIME_BASIS.MINIMUM
  const CAPACITY = m.t.TIME_BASIS.CAPACITY
  const body = wet(4)
  const assessment = m.t.assessTerraforming(body, speciesOf(m, 4), 1, gasInfo)

  // The probe: the capacity bound is the figure of the reviewer's probe, and it is a minimum.
  assert.equal(assessment.outcome, 'yes', 'the public assessment says yes')
  assert.deepEqual(assessment.plan.steps.map((step) => [step.key, step.drained]), [['water', 50]], 'one operation drains 50 percentage points')
  close(assessment.work, DRAIN_WORK, 'the water work')

  const years = m.t.planYears(assessment.work, 100)

  close(years, DRAIN_WORK / 100, 'the capacity bound in years')
  close(years * 365, 4.552490599924104, 'the capacity bound in days')
  assert.equal(assessment.timeBasis, MINIMUM, 'the assessment labels the plan\'s years a minimum')
  assert.equal(m.t.planTimeBasis(assessment.plan), MINIMUM, 'so does the plan')
  assert.equal(m.t.stepTimeBasis(assessment.plan.steps[0]), MINIMUM, 'and the step that drains')
  assert.equal(m.t.timeWords(years, assessment.timeBasis, YEARS, 2), 'at least 4.5 days', 'the minimum is worded as a least number of days, not as "under 0.1 years", and floored: the 4.55-day bound reads 4.5, never the 4.6 nearest rounding gives')
  assert.equal(m.t.timeWords(0.25, MINIMUM, YEARS, 2), 'at least 0.25 years', 'a minimum from 0.1 years on keeps the page\'s years')
  assert.equal(m.t.timeWords(1e-6, MINIMUM, YEARS, 2), 'at least a fraction of a day', 'a minimum under a tenth of a day is a fraction of a day')
  assert.equal(m.t.timeWords(Infinity, MINIMUM, YEARS, 2), 'Infinity years', 'no terraformers is no time to name, minimum or not')
  // A lower bound is floored to the figure it is shown at, so it never reads above itself: a bound that would round up is written below it, and a bound exactly on a shown figure keeps it.
  assert.equal(m.t.timeWords(4.55 / 365, MINIMUM, YEARS, 2), 'at least 4.5 days', 'a 4.55-day bound reads 4.5 days, not the 4.6 nearest rounding gives')
  assert.equal(m.t.timeWords(4.5 / 365, MINIMUM, YEARS, 2), 'at least 4.5 days', 'a bound of exactly 4.5 days reads 4.5 days')
  assert.equal(m.t.timeWords(1.06, MINIMUM, ONE_PLACE, 1), 'at least 1.0 years', 'a 1.06-year bound reads 1.0 year at one decimal, not the 1.1 nearest rounding gives')
  assert.equal(m.t.timeWords(1.06, CAPACITY, ONE_PLACE, 1), '1.1 years', 'a plan that drains nothing keeps the nearest rounding of the page, unfloored')
  assert.equal(m.t.timeWords(0.0999, MINIMUM, YEARS, 2), 'at least 36.4 days', 'a bound just under 0.1 years is worded in days, floored there too: 36.4635 days reads 36.4, not the 36.5 nearest rounding gives')
  assert.equal(m.t.timeWords(0.1, MINIMUM, YEARS, 2), 'at least 0.1 years', 'a bound of exactly 0.1 years crosses to the page\'s years')
  // The floor reads the product at 15 significant digits and then checks the figure against the double the caller passed: a bound a hair under a decimal is written under it, an exact decimal keeps it, and a plan that drains nothing keeps the page's nearest rounding.
  assert.equal(m.t.timeWords(1.09999999995, MINIMUM, ONE_PLACE, 1), 'at least 1.0 years', 'a 1.09999999995-year bound reads 1.0 years at one decimal, never the 1.1 it is under')
  assert.equal(m.t.timeWords(4.49999999995 / 365, MINIMUM, YEARS, 2), 'at least 4.4 days', 'a bound of 4.49999999995 days reads 4.4 days, never the 4.5 it is under')
  assert.equal(m.t.timeWords(1.1 - Number.EPSILON * 2, MINIMUM, ONE_PLACE, 1), 'at least 1.0 years', 'the double just below 1.1 reads 1.0 years: 15 digits of its product round to 11, and the comparison steps it down')
  assert.equal(m.t.timeWords(2.3, MINIMUM, ONE_PLACE, 1), 'at least 2.3 years', 'an exact 2.3-year bound keeps its 2.3')
  assert.equal(m.t.timeWords(0.29, MINIMUM, TWO_PLACES, 2), 'at least 0.29 years', 'an exact 0.29-year bound keeps its 0.29, though its product with the scale is 28.999999999999996')
  assert.equal(m.t.timeWords(2.29999999999, MINIMUM, ONE_PLACE, 1), 'at least 2.2 years', 'a 2.29999999999-year bound reads 2.2 years')
  assert.equal(m.t.timeWords(4.5, MINIMUM, ONE_PLACE, 1), 'at least 4.5 years', 'a bound of exactly 4.5 years reads 4.5 years at one decimal')
  assert.equal(m.t.timeWords(1, MINIMUM, ONE_PLACE, 1), 'at least 1.0 years', 'a bound of exactly 1 year reads 1.0 years')
  assert.equal(m.t.timeWords(1.09999999995, CAPACITY, ONE_PLACE, 1), '1.1 years', 'a plan that drains nothing rounds 1.09999999995 to nearest, 1.1: the bound is not floored')
  assert.ok(/evaporat/.test(m.t.MINIMUM_TIME_NOTE) && /minimum/.test(m.t.MINIMUM_TIME_NOTE) && /not a finishing date/.test(m.t.MINIMUM_TIME_NOTE), 'the note names the evaporation and says the time is no finishing date')

  // What the minimum is not: the time the water is gone. Within the capacity bound the surface cannot have given up more than one source-shaped step's vapour, and the water that is left still costs.
  const stepLeft = 50 - (0.005 * 40)

  close(costOf(m, 4, wet(4, { HydroExt: stepLeft })).raws.current, 4.98, 'one 0.005 atm step leaves 49.8 % of the water, which costs 4.98')
  assert.deepEqual(assessment.after.raws, ZERO, 'the end state is dry and costs nothing, as the plan says')

  // A plan with a drain and another operation: the plan's time is a minimum, the other step's is the plain figure of its work.
  const methane = m.t.assessTerraforming(wet(3), speciesOf(m, 3), 1, gasInfo)

  assert.deepEqual(methane.plan.steps.map((step) => [step.key, m.t.stepTimeBasis(step)]), [['water', MINIMUM], ['antiGreenhouse', CAPACITY]], 'only the step that drains is a minimum')
  assert.equal(methane.timeBasis, MINIMUM, 'the plan is a minimum when any step drains')

  // Ordinary oxygen plans keep the surface water and have no drain, as does a body that needs none; an oxygen ocean above 75 % drains the excess, and that is a minimum like any other drain.
  const ordinary = planFor(m, 10, { Eccentricity: 0, HydroExt: 60 }).assessment

  assert.ok(ordinary.plan && ordinary.plan.steps.every((step) => !step.drained), 'the oxygen plan drains nothing')
  assert.equal(ordinary.timeBasis, CAPACITY, 'its years keep the capacity basis')
  assert.ok(ordinary.plan.steps.every((step) => m.t.stepTimeBasis(step) === CAPACITY), 'and so do its steps')
  assert.equal(m.t.timeWords(m.t.planYears(ordinary.work, 100), ordinary.timeBasis, YEARS), YEARS(m.t.planYears(ordinary.work, 100)), 'its time is worded as the plain figure')
  assert.equal(m.t.assessTerraforming(wet(4, { HydroExt: 0, HydroID: HYDROSPHERE.none }), speciesOf(m, 4), 1, gasInfo).timeBasis, CAPACITY, 'a body that needs no plan has the capacity basis')

  const oceanic = planFor(m, 10, { Eccentricity: 0 }).assessment

  assert.deepEqual((oceanic.plan ? oceanic.plan.steps : []).map((step) => [step.key, m.t.stepTimeBasis(step)]), [['greenhouse', CAPACITY], ['water', MINIMUM]], 'an oxygen ocean over 75 % drains the excess in the water step alone, which is the minimum')
  assert.equal(oceanic.timeBasis, MINIMUM, 'and the plan is a minimum')

  // The ranking and the plan states of the probe, at 100 installations of rate 1: the years are the capacity bound, marked, and the state says why.
  const row = await ranked(m, 4, body)
  const facts = row.facts

  assert.equal(row.best.strategy, 'terraform', 'the plan is the best route')
  close(row.best.years, years, 'the ranking uses the capacity bound')
  assert.equal(row.best.yearsBasis, MINIMUM, 'the evaluation labels its years a minimum')
  assert.equal(facts.route.plan.yearsBasis, MINIMUM, 'so does the plan of the route')
  assert.equal(row.state.chip(facts), 'To free · at least 4.5 days', 'the chip of the state')
  assert.ok(row.state.text(facts).includes('takes at least 4.5 days') && row.state.text(facts).includes(m.t.MINIMUM_TIME_NOTE), 'the state\'s text says at least and names the limit')
  assert.ok(row.score !== null && m.z.rowProvenance(row).score.assumptions.some((line) => /years are a minimum/.test(line)), 'the score is marked as resting on a minimum')

  // The states write their years at one decimal under ten and none above, floored there too: bounds whose nearest rounding would overshoot.
  const reTimed = (value) => ({ ...facts, route: { ...facts.route, plan: { ...facts.route.plan, years: value } } })

  assert.equal(row.state.chip(reTimed(2.36)), 'To free · at least 2.3 years', 'a 2.36-year bound reads 2.3 years in the chip, not the 2.4 nearest rounding gives')
  assert.ok(row.state.text(reTimed(2.36)).includes('Terraforming takes at least 2.3 years'), 'and so does the state\'s text')
  assert.equal(row.state.chip(reTimed(12.6)), 'To free · at least 12 years', 'a 12.6-year bound reads 12 years in the chip at the state\'s whole years, not 13')

  const plain = await ranked(m, 10, cold(10, { Eccentricity: 0, HydroExt: 60 }), { IdealTemperature: 280, MaximumPressure: 10 })

  assert.equal(plain.best.strategy, 'terraform', 'the ordinary plan is the best route')
  assert.equal(plain.best.yearsBasis, CAPACITY, 'its years keep the capacity basis')
  assert.ok(!/at least|minimum/.test(`${plain.state.chip(plain.facts)} ${plain.state.text(plain.facts)}`), 'its state says nothing of a minimum')
  assert.ok(!m.z.rowProvenance(plain).score.assumptions.some((line) => /minimum/.test(line)), 'and its score is not marked')
})

check('vapour plan', 'water vapour a breather rates dangerous is toxic over its limit only: at or under it the body is done, over it the plan has one water step for the gas and no removal', (m) => {
  const dry = (breather, share) => planet(breather, { HydroExt: 0, HydroID: HYDROSPHERE.none, Atmosphere: [gasOf(breather, 0.2, 20), gasOf(5, share / 100, share), gasOf(7, 0.8 - share / 100, 80 - share)] })

  // [breathing gas, rating, the share under the limit, at it, over it] in % of the air: ammonia rates water vapour 2 above 2,000 ppm and sulphur dioxide 3 above 5,000 ppm.
  for (const [breather, rating, under, at, over] of [[4, 2, 0.15, 0.2, 0.3], [15, 3, 0.4, 0.5, 0.6]]) {
    const species = speciesOf(m, breather)

    for (const share of [under, at]) {
      const assessment = m.t.assessTerraforming(dry(breather, share), species, 1, gasInfo)

      assert.deepEqual([assessment.outcome, assessment.plan], ['done', null], `${NAMES[breather]} breather, ${share} % vapour: not over the limit, so nothing to do`)
    }

    const assessment = m.t.assessTerraforming(dry(breather, over), species, 1, gasInfo)
    const steps = assessment.plan.steps.filter((step) => step.gasId === 5)
    const name = `${NAMES[breather]} breather, ${over} % vapour`

    close(assessment.cost.raws.current, rating, `${name}: the rating of the vapour is the cost`)
    assert.equal(assessment.outcome, 'yes', `${name}: the plan solves it`)
    assert.deepEqual(steps.map((step) => step.key), ['water'], `${name}: one step for the vapour, the water step, and no removal as a toxic gas`)
    assert.ok(steps[0].to <= at / 100, `${name}: the water step leaves it at or under the limit`)
    assert.deepEqual(assessment.after.raws, ZERO, `${name}: nothing costs after the plan`)
  }
})

// ---- The colony-cost bands of a race by its Galaxy Map options -------------------------------------------------------------
// The columns of FCT_Race the Galaxy Map's own band options are stored in (normal gravity only, then include low gravity, for the bands under 2, 3 and 5: the game draws the badges by them) and the three the tactical map's body colours are (the game paints the discs by them, which no page of the app shows).
const GALAXY_COLUMNS = ['chkHabRangeWorlds', 'chkHabRangeWorldsLowG', 'chkLowCCNormalG', 'chkLowCCLowG', 'chkMediumCCNormalG', 'chkMediumCCLowG']
const TACTICAL_COLUMNS = ['chkShowBodyColours', 'chkCCIncludeLowG', 'chkGasGiantColour']
const PLANTED_SCHEMA = [
  'create table DIM_Gases (GasID integer, Name text, BoilingPoint real, FreezingPoint real, GHGas integer, AntiGHGas integer, DangerousOxygen integer, DangerousPPMOxygen integer, DangerousMethane integer, DangerousPPMMethane integer, DangerousSulphur integer, DangerousPPMSulphur integer, DangerousAmmonia integer, DangerousPPMAmmonia integer)',
  'create table FCT_Species (SpeciesID integer, SpeciesName text, BreatheID integer, Oxygen real, OxyDev real, PressMax real, Temperature real, TempDev real, Gravity real, GravDev real, PopulationDensityModifier real)',
  'create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, SpeciesID integer, Population real, Capital integer)',
  `create table FCT_Race (GameID integer, RaceID integer, ${[...GALAXY_COLUMNS, ...TACTICAL_COLUMNS].map((column) => `${column} integer`).join(', ')})`,
  'create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer)',
  'create table FCT_SystemBody (GameID integer, SystemID integer, SystemBodyID integer, BodyClass integer, BodyTypeID integer, FixedBody integer, TidalLock integer, AtmosPress real, HydroExt real, HydroID integer, Gravity real, SurfaceTemp real)',
  'create table FCT_AtmosphericGas (GameID integer, SystemBodyID integer, AtmosGasID integer, AtmosGasPercentage real, GasAtm real, FrozenOut integer)',
]

// An ammonia-breathing race: bodies of three systems with their ammonia and nitrogen, and the Galaxy Map options (six flags) and tactical options (three) it has.
const plantedRace = ({ galactic = GALAXY_COLUMNS.map(() => 0), tactical = TACTICAL_COLUMNS.map(() => 0) } = {}) => {
  const database = new Database(':memory:')

  PLANTED_SCHEMA.forEach((statement) => database.run(statement))
  Object.keys(GAS_TABLE).forEach((id) => {
    const row = tableRow(Number(id))

    database.run('insert into DIM_Gases values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [row.AtmosGasID, row.AtmosGasName, row.BoilingPoint, row.FreezingPoint, row.GHGas, row.AntiGHGas, ...DANGER_COLUMNS.map((column) => row[column])])
  })
  database.run('insert into FCT_Species values (1, \'Ammonians\', 4, 0.2, 0.1, 4, 288, 30, 1, 0.5, 1)')
  database.run('insert into FCT_Population values (1, 1, 1, 1, 10, 1)')
  database.run(`insert into FCT_Race values (1, 1, ${[...galactic, ...tactical].map(() => '?').join(', ')})`, [...galactic, ...tactical])
  ;[1, 2, 3].forEach((system) => database.run('insert into FCT_RaceSysSurvey values (1, 1, ?)', [system]))

  // [system, body, type, gravity, water, extent]: the ammonia breather pays a tenth of the extent for liquid water and nothing for ice.
  const bodies = [[1, 101, 1, 1, 3, 25], [1, 102, 1, 1, 4, 25], [1, 103, 1, 0.3, 4, 25], [1, 104, 4, 1, 1, 0], [1, 105, 1, 2, 4, 25], [2, 201, 1, 1, 3, 45], [2, 202, 1, 1, 3, 55], [3, 301, 1, 0.3, 4, 25], [3, 302, 1, 0.3, 3, 25]]

  bodies.forEach(([system, id, type, gravity, water, extent]) => {
    database.run('insert into FCT_SystemBody values (1, ?, ?, 1, ?, 0, 0, 1, ?, ?, ?, 288)', [system, id, type, extent, water, gravity])
    ;[[4, 0.2, 20], [7, 0.8, 80]].forEach(([gas, atm, share]) => database.run('insert into FCT_AtmosphericGas values (1, ?, ?, ?, ?, 0)', [id, gas, share, atm]))
  })

  return database
}

check('map', 'the colony-cost layer counts the bodies by the species\' breathing gas and follows the Galaxy Map\'s band options: ice is free for an ammonia breather, a band\'s counts at normal gravity and at every gravity are both carried and the options pick between them, and the tactical options change nothing', async (m) => {
  const { world } = m

  const NEITHER = { normalGravityOnly: false, includeLowGravity: false }
  const run = async (options) => {
    const database = plantedRace(options)

    try {
      return await m.f.loadHabitability(shim(database), { GameID: 1, RaceID: 1 })
    } finally {
      database.close()
    }
  }
  const counts = (habitability) => m.f.allBandCounts(habitability)
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const best = (habitability) => rows.map((row) => m.f.bestBandIndex(habitability, row.id))
  const stock = await run()

  assert.equal(stock.species, 'Ammonians', 'the race lives as its capital\'s species')
  assert.deepEqual(stock.options, { bands: [NEITHER, NEITHER, NEITHER] }, 'a new race has no band option set')
  // System 1: the ice body (cost 0) is in the first band, the low-gravity ice body (floor of 1) too but not at normal gravity, the liquid body (25 % x 0.1 = 2.5) in the second; the gas giant and the heavy body never count. System 2: 45 % liquid (4.5) is in the third band, 55 % (5.5) is in none. System 3: only low-gravity bodies, one in the first band and one in the second.
  assert.deepEqual(stock.systems, { 1: { normal: [1, 1, 0], all: [2, 1, 0] }, 2: { normal: [0, 0, 1], all: [0, 0, 1] }, 3: { normal: [0, 0, 0], all: [1, 1, 0] } }, 'both counts of every band, as the game counts them')
  assert.deepEqual(stock.gaps, {}, 'every body is told')
  assert.deepEqual(counts(stock), { 1: [2, 1, 0], 2: [0, 0, 1], 3: [1, 1, 0] }, 'with neither option on a band counts every body')

  // The options are the game's per band: normal gravity only, then include low gravity.
  const normalOnly = await run({ galactic: [1, 0, 1, 0, 1, 0] })
  const lowToo = await run({ galactic: [1, 1, 0, 1, 0, 1] })
  const mixed = await run({ galactic: [1, 0, 0, 1, 0, 0] })

  assert.deepEqual(normalOnly.options.bands, [{ normalGravityOnly: true, includeLowGravity: false }, { normalGravityOnly: true, includeLowGravity: false }, { normalGravityOnly: true, includeLowGravity: false }], 'the six columns are read as three pairs')
  assert.deepEqual(mixed.options.bands, [{ normalGravityOnly: true, includeLowGravity: false }, { normalGravityOnly: false, includeLowGravity: true }, NEITHER], 'each band has its own pair')
  assert.deepEqual(counts(normalOnly), { 1: [1, 1, 0], 2: [0, 0, 1], 3: [0, 0, 0] }, 'normal gravity only leaves out the bodies below the minimum gravity')
  assert.deepEqual(counts(lowToo), counts(stock), 'the low-gravity option counts every body, the normal-gravity one on the same band or not')
  assert.deepEqual(counts(mixed), { 1: [1, 1, 0], 2: [0, 0, 1], 3: [0, 1, 0] }, 'a band follows its own options, not the others\'')
  assert.deepEqual([normalOnly.systems, mixed.systems], [stock.systems, stock.systems], 'the options choose between the counts and change neither')
  assert.deepEqual(best(stock), [0, 2, 0], 'the best band with every body counted')
  assert.deepEqual(best(normalOnly), [0, 2, -1], 'a system whose only bodies are below the minimum gravity has none at normal gravity')
  assert.deepEqual(best(mixed), [0, 2, 1], 'and the second band, which counts them, still has one')
  assert.deepEqual(m.f.legendCounts(stock, rows).value, { bands: [2, 0, 1], none: 0, unknown: 0 }, 'the legend counts systems by their best band')
  assert.deepEqual(m.f.legendCounts(normalOnly, rows).value, { bands: [1, 0, 1], none: 1, unknown: 0 }, 'the legend follows the options')
  assert.equal(m.f.bodiesByCost(stock, 1).value, '2 under 2 (1 at normal gravity), 1 more under 3', 'the text carries both counts of a band that has them')
  assert.equal(m.f.bodiesByCost(stock, 3).value, '1 under 2 (0 at normal gravity), 1 more under 3 (0 at normal gravity)')
  assert.equal(m.f.bodiesByCost(normalOnly, 1).value, '1 under 2 at normal gravity, 1 more under 3 at normal gravity', 'a band at normal gravity only says so')
  assert.equal(m.f.bodiesByCost(normalOnly, 3).value, '', 'and no body is left in the system whose bodies are all below the minimum')
  assert.equal(m.f.bodiesByCost(mixed, 3).value, '1 under 3 (0 at normal gravity)')

  // The tactical map's colouring options are not the layer's: flipping them changes nothing, whichever Galaxy Map options are set.
  for (const galactic of [undefined, [1, 0, 0, 1, 0, 0]]) {
    const base = await run({ galactic })
    const flipped = await run({ galactic, tactical: [1, 1, 1] })

    assert.deepEqual([flipped.systems, flipped.options], [base.systems, base.options], 'the tactical options change neither the counts nor the options read')
  }

  const words = m.f.bandBasisNote

  assert.ok(words(stock.options).includes('under 2: all gravities, neither option set; under 3: all gravities, neither option set; under 5: all gravities, neither option set'), 'the note says every band counts every body when no option is on')
  assert.ok(words(normalOnly.options).includes('under 2: normal gravity only; under 3: normal gravity only; under 5: normal gravity only'), 'the note says the bands count normal gravity only')
  assert.ok(words(mixed.options).includes('under 2: normal gravity only; under 3: all gravities; under 5: all gravities, neither option set'), 'the note gives each band its own')
  assert.ok(words(stock.options).includes('at or above the species\' minimum') && words(stock.options).includes('worst over the orbit'), 'the note says what normal gravity is and that the cost is the cost now')
  assert.ok(!words(lowToo.options).includes('neither'), 'the low-gravity option on every band leaves no neither')

  // The options as the saves store them.
  const optionsOf = (row) => [0, 1, 2].map((band) => ({ normalGravityOnly: !!row[GALAXY_COLUMNS[2 * band]], includeLowGravity: !!row[GALAXY_COLUMNS[2 * band + 1]] }))

  for (const { label, save, database, shim: source } of world) {
    const saved = database.query(`select ${GALAXY_COLUMNS.join(', ')} from FCT_Race where GameID = ${save.gameId} and RaceID = ${save.raceId}`).get()
    const result = await m.f.loadHabitability(source, { GameID: save.gameId, RaceID: save.raceId })

    assert.deepEqual(result.options.bands, optionsOf(saved), `${label}: the layer reads the options of the race as they are stored`)
    console.log(`MAP ${label}: Galaxy Map options ${GALAXY_COLUMNS.map((column) => `${column} ${saved[column]}`).join(', ')}; ${Object.keys(result.systems).length} systems with a body under 5`)
  }

  // The same layer on the played save, against the cost of each body as the planner's loader and the cost rule give it.
  const played = world.find(({ label }) => label === 'played')

  if (played) {
    const result = await m.f.loadHabitability(played.shim, { GameID: PLAYED.gameId, RaceID: PLAYED.raceId })
    const capital = played.database.query(`select SpeciesID from FCT_Population where GameID = ${PLAYED.gameId} and RaceID = ${PLAYED.raceId} and Capital = 1`).get()
    const limits = played.species.get(capital.SpeciesID)
    const own = await m.d.loadBodies(played.shim, { GameID: PLAYED.gameId, RaceID: PLAYED.raceId })
    const bandsOf = (bodies) => {
      const counted = {}

      bodies.forEach((body) => {
        const band = [2, 3, 5].findIndex((limit) => m.h.costFactors(body, limits, body.SurfaceTemp).cost < limit)

        if (band >= 0) {
          counted[body.SystemID] = counted[body.SystemID] || [0, 0, 0]
          counted[body.SystemID][band] += 1
        }
      })

      return counted
    }
    const colonisable = own.filter((body) => !m.h.uncolonisableReason(body, limits))
    const normal = bandsOf(colonisable.filter((body) => body.Gravity >= limits.MinimumGravity))
    const everything = bandsOf(colonisable)
    const optioned = (values) => m.f.loadHabitability({ query: async (sql) => (sql.includes('chkHabRangeWorlds') ? [[Object.fromEntries(GALAXY_COLUMNS.map((column, index) => [column, values[index]]))]] : played.shim.query(sql)) }, { GameID: PLAYED.gameId, RaceID: PLAYED.raceId })
    const apart = (habitability, basis) => Object.fromEntries(Object.entries(habitability.systems).map(([id, both]) => [id, both[basis]]))
    const occupied = (byId) => Object.fromEntries(Object.entries(byId).filter(([, row]) => row.some(Boolean)))
    const total = (byId) => Object.values(byId).flat().reduce((sum, count) => sum + count, 0)
    const normalOnlyPlayed = await optioned([1, 0, 1, 0, 1, 0])

    assert.equal(Object.keys(result.systems).length > 5, true, 'the played save has systems with bodies in the bands')
    assert.deepEqual(apart(result, 'all'), everything, 'the layer counts what the cost of each body gives, every body that can be colonised')
    assert.deepEqual(occupied(apart(result, 'normal')), normal, 'and, apart, those at or above the species\' minimum gravity')
    assert.deepEqual(counts(result), everything, 'the played race has no Galaxy Map option on, so a band counts every body')
    assert.deepEqual(occupied(counts(normalOnlyPlayed)), normal, 'with normal gravity only on every band it counts those at or above the minimum gravity')
    assert.ok(total(everything) > 10 * total(normal), 'most bodies of the galaxy are below the minimum gravity of the species, so the options change the counts')
    console.log(`MAP played: ${Object.keys(result.systems).length} systems with a body under 5, ${total(normal)} bodies at normal gravity and ${total(everything)} at every gravity, as the cost of each body gives`)
  }
})

// ---- The danger flag: the protection of the race's ships there against the danger rating, unrounded and added as the game's decimal -------------------------------------
// Two systems: ten ships at a stored protection of 0.1 and nine at 0.1, each of a class that moves. A binary sum of the ten gives 0.9999999999999999 and reports a shortfall the game does not; the game's decimal sum is exactly 1.
const protectionFleets = () => {
  const raw = new Database(':memory:')
  const ships = (count, fleet) => Array.from({ length: count }, (_value, index) => `(${fleet * 100 + index + 1}, ${fleet}, 1, 0, 0, 1, 1)`).join(', ')

  raw.exec(`
    create table FCT_Ship (ShipID, FleetID, ShipClassID, ShippingLineID, Destroyed, GameID, RaceID);
    create table FCT_Fleet (FleetID, SystemID);
    create table FCT_ShipClass (ShipClassID, ProtectionValue, MaxSpeed, Commercial);
    insert into FCT_Fleet values (1, 1);
    insert into FCT_Fleet values (2, 2);
    insert into FCT_ShipClass values (1, 0.1, 1, 0);
    insert into FCT_Ship values ${ships(10, 1)};
    insert into FCT_Ship values ${ships(9, 2)};
  `)

  return raw
}

check('danger', 'the map danger flag adds the protection of the race\'s ships there as the game\'s decimal and compares the total with the danger rating without rounding: 4.6 against 5 falls short though it rounds to 5, ten ships at 0.1 against 1 are no shortfall while nine are, an equal or greater protection does not, and a missing rating or protection is unavailable', async (m) => {
  const decimal = (text) => m.n.fromString(text)

  // The counterexample: a protection of 4.6 rounds to 5, so a comparison of the rounded figure would report no shortfall, as the game does not.
  assert.equal(m.f.dangerFlag(5, decimal('4.6')).value, true, 'a protection of 4.6 against a danger of 5 falls short')
  assert.equal(m.f.dangerFlag(5, decimal('5')).value, false, 'an equal protection is no shortfall')
  assert.equal(m.f.dangerFlag(5, decimal('5.1')).value, false, 'a greater protection is no shortfall')
  assert.equal(m.f.dangerFlag(5, m.n.ZERO).value, true, 'a system with no ships of the race falls short')
  assert.equal(m.f.dangerFlag(1, decimal('0.4')).value, true, 'a fractional shortfall of less than one is still a shortfall')
  assert.equal(m.f.dangerFlag(5, null).status, 'unavailable', 'a protection that is not stored is unavailable, never 0')
  assert.equal(m.f.dangerFlag(null, decimal('5')).status, 'unavailable', 'a danger rating that is not stored is unavailable')
  assert.equal(m.f.dangerFlag(5, decimal('4.6')).inputs.present.includes('the protection of the ships there'), true, 'the result names the protection it compared')

  const raw = protectionFleets()

  try {
    const systems = await m.f.loadShipProtection({ query: async (sql) => [raw.query(sql).all()] }, { GameID: 1, RaceID: 1 })
    const ten = systems.find((system) => system.SystemID === 1)
    const nine = systems.find((system) => system.SystemID === 2)

    assert.equal(m.f.protectionText(ten.protection), '1', 'ten ships at 0.1 add to exactly 1 as the game\'s decimal')
    assert.equal(m.f.dangerFlag(1, ten.protection).value, false, 'ten ships at 0.1 against a danger of 1 are no shortfall')
    assert.equal(m.f.protectionText(nine.protection), '0.9', 'nine ships at 0.1 add to 0.9')
    assert.equal(m.f.dangerFlag(1, nine.protection).value, true, 'nine ships at 0.1 against a danger of 1 are a shortfall')
  } finally {
    raw.close()
  }
})

check('capability', 'the tactical colouring options stay declared as unread, the six Galaxy Map options are read by the layer and declared by no one, and the rules of the layer list the game version they were checked for', (m) => {
  const declared = m.k.DECLARED.filter((entry) => entry.table === 'FCT_Race').flatMap((entry) => entry.columns)

  TACTICAL_COLUMNS.forEach((column) => assert.ok(declared.includes(column), `${column} stays declared: no page reads it, as it only paints the body discs of the game's tactical map`))
  GALAXY_COLUMNS.forEach((column) => assert.ok(!declared.includes(column), `${column} is read by the layer, so the registry does not declare it as unread`))

  const reads = fs.readFileSync(path.join(UTILITIES, 'capability-reads.js'), 'utf8')
  const habitability = /habitability: \{ label: 'the habitability', reads: '([^']*)'/.exec(reads)
  const race = habitability ? /FCT_Race\(([^)]*)\)/.exec(habitability[1]) : null
  const columns = race ? race[1].split(' ') : []

  GALAXY_COLUMNS.forEach((column) => assert.ok(columns.includes(column), `${column} is in the read of the map's colony-cost layer`))
  TACTICAL_COLUMNS.forEach((column) => assert.ok(!reads.includes(column), `${column} is in no page's read`))

  const holds = (rule) => m.p.ruleSupports(rule, '3.2.0')

  ;['habitability.colonyCost', 'habitability.infraPerMillion', 'habitability.terraformLimits', 'colonies.colonyCost', 'map.bestBand', 'map.bodiesByCost', 'map.legendCounts'].forEach((rule) => assert.equal(holds(rule), true, `${rule} lists 3.2.x`))
})

check('gas table', 'the planted DIM_Gases rows are the rows of the played save', (m) => {
  const { world } = m

  const played = world.find(({ label }) => label === 'played')

  assert.ok(played, 'the played save')

  for (const id of Object.keys(GAS_TABLE)) {
    const stored = played.database.query('select Name, BoilingPoint, FreezingPoint, GHGas, AntiGHGas, DangerousOxygen, DangerousPPMOxygen, DangerousMethane, DangerousPPMMethane, DangerousSulphur, DangerousPPMSulphur, DangerousAmmonia, DangerousPPMAmmonia from DIM_Gases where GasID = ?').get(Number(id))
    const row = tableRow(Number(id))

    assert.deepEqual([row.AtmosGasName, row.BoilingPoint, row.FreezingPoint, row.GHGas, row.AntiGHGas, ...DANGER_COLUMNS.map((column) => row[column])], [stored.Name, stored.BoilingPoint, stored.FreezingPoint, stored.GHGas, stored.AntiGHGas, stored.DangerousOxygen, stored.DangerousPPMOxygen, stored.DangerousMethane, stored.DangerousPPMMethane, stored.DangerousSulphur, stored.DangerousPPMSulphur, stored.DangerousAmmonia, stored.DangerousPPMAmmonia], `gas ${id}`)
  }
})

// ---- Planted faults --------------------------------------------------------------------------------------------------------------
const WATER_RULE = 'return hydrosphere === HYDROSPHERE.ICE_SHEET && species.BreatheID === GAS.SULPHUR_DIOXIDE ? extent * 0.05 : 0'
const CLASS_RULE = 'return species.MaximumGravity >= MINIMUM_TERRAFORMING_GRAVITY || !(body.Gravity > species.MinimumGravity) ? null : \'N\''
const faults = [
  { name: 'the water rule of the oxygen breather applies to every breather', module: 'habitability', from: 'if (species.BreatheID === GAS.OXYGEN) {', to: 'if (species.BreatheID > 0) {', fails: ['water', 'oracle'] },
  { name: 'liquid water costs its whole extent for methane and ammonia', module: 'habitability', from: 'extent * (species.BreatheID === GAS.SULPHUR_DIOXIDE ? 1 : 0.1)', to: 'extent', fails: ['water', 'oracle'] },
  { name: 'liquid water costs a tenth of its extent for sulphur dioxide', module: 'habitability', from: 'extent * (species.BreatheID === GAS.SULPHUR_DIOXIDE ? 1 : 0.1)', to: 'extent * 0.1', fails: ['water'] },
  { name: 'an ice sheet costs every breather but oxygen', module: 'habitability', from: WATER_RULE, to: 'return hydrosphere === HYDROSPHERE.ICE_SHEET ? extent * 0.05 : 0', fails: ['water', 'oracle'] },
  { name: 'an ice sheet costs sulphur dioxide nothing', module: 'habitability', from: WATER_RULE, to: 'return 0', fails: ['water', 'extremes'] },
  { name: 'an ice sheet costs sulphur dioxide a tenth of its extent', module: 'habitability', from: 'extent * 0.05 : 0', to: 'extent * 0.1 : 0', fails: ['water', 'extremes'] },
  { name: 'the extremes price the stored water', module: 'habitability', from: 'periapsis: costFactors(body, species, extremes[0], planned, hydrosphereTypeAt(body, extremes[0])), apoapsis: costFactors(body, species, extremes[1], planned, hydrosphereTypeAt(body, extremes[1]))', to: 'periapsis: costFactors(body, species, extremes[0], planned), apoapsis: costFactors(body, species, extremes[1], planned)', fails: ['extremes'] },
  { name: 'the water at a point ignores the air', module: 'habitability', from: '(body.AtmosPress === 0 || (body.AtmosPress < MINIMUM_WATER_PRESSURE && temperature > WATER_FREEZING_KELVIN) ? HYDROSPHERE.NONE : hydrosphereAtTemperature(temperature))', to: 'hydrosphereAtTemperature(temperature)', fails: ['extremes'] },
  { name: 'a gas the species breathes is left out of the danger set', module: 'habitability', from: 'if (dangerous > rating && isDangerousGas(gas, species, temperature, planned)) {', to: 'if (dangerous > rating && gas.AtmosGasID !== species.BreatheID && isDangerousGas(gas, species, temperature, planned)) {', fails: ['own gas'] },
  { name: 'a planned gas freezes at its boiling point', module: 'habitability', from: 'temperature < gas.FreezingPoint : !!gas.FrozenOut', to: 'temperature < gas.BoilingPoint : !!gas.FrozenOut', fails: ['planned freeze'] },
  { name: 'the greenhouse of a gas works above its boiling point', module: 'habitability', from: 'if (threshold >= gas.FreezingPoint) {', to: 'if (threshold >= gas.BoilingPoint) {', fails: ['planned freeze'] },
  { name: 'LG and LGR are not told apart', module: 'habitability', from: 'return body.Gravity < MINIMUM_TERRAFORMING_GRAVITY ? \'LG\' : \'LGR\'', to: 'return \'LG\'', fails: ['gravity'] },
  { name: 'the retention gravity is inside LG', module: 'habitability', from: 'return body.Gravity < MINIMUM_TERRAFORMING_GRAVITY ? \'LG\' : \'LGR\'', to: 'return body.Gravity <= MINIMUM_TERRAFORMING_GRAVITY ? \'LG\' : \'LGR\'', fails: ['gravity'] },
  { name: 'N reads the gravity of the body against 0.1 g', module: 'habitability', from: CLASS_RULE, to: 'return body.Gravity >= MINIMUM_TERRAFORMING_GRAVITY || !(body.Gravity > species.MinimumGravity) ? null : \'N\'', fails: ['retention'] },
  { name: 'N is never shown', module: 'habitability', from: CLASS_RULE, to: 'return null', fails: ['retention'] },
  { name: 'N is shown at the minimum too', module: 'habitability', from: CLASS_RULE, to: 'return species.MaximumGravity >= MINIMUM_TERRAFORMING_GRAVITY ? null : \'N\'', fails: ['retention'] },
  { name: 'the cost does not carry the class', module: 'habitability', from: 'gravityClass: now.gravityClass,', to: 'gravityClass: null,', fails: ['gravity', 'planner'] },
  { name: 'the infrastructure of a low-gravity colony is not doubled', module: 'colonies', from: '(colony.LowGravity ? 2 : 1)', to: '1', fails: ['oracle'] },
  { name: 'a plan for any breather aims the water at the oxygen target', module: 'terraforming', from: '  if (species.BreatheID !== GAS.OXYGEN) {\n    return drain ? 0 : current\n  }\n\n', to: '', fails: ['planner', 'drain'] },
  { name: 'the water vapour of a plan has no limit', module: 'terraforming', from: 'const waterShare = waterDanger && waterDanger.dangerous > 0 ? Math.max(0, waterDanger.ppm / 1e6 * (1 - WATER_SHARE_MARGIN)) : 1', to: 'const waterShare = 1', fails: ['planner'] },
  { name: 'the water vapour of a plan is limited for a breather that rates it harmless', module: 'terraforming', from: 'waterDanger && waterDanger.dangerous > 0 ? Math.max', to: 'waterDanger ? Math.max', fails: ['planner'] },
  { name: 'the stages leave out the class', module: 'terraform-limits', from: 'gravityClass: stages[0].gravityClass,', to: 'gravityClass: null,', fails: ['planner'] },
  { name: 'the loader of the planner reads the boiling point of a gas as its freezing point', module: 'colonization-data', from: 'DIM_Gases.FreezingPoint', to: 'DIM_Gases.BoilingPoint as FreezingPoint', fails: ['frozen'] },
  { name: 'the gas list reads the boiling point as the freezing point', module: 'colonization-data', from: 'select GasID, Name, FreezingPoint, GHGas', to: 'select GasID, Name, BoilingPoint as FreezingPoint, GHGas', fails: ['frozen'] },
  { name: 'a body that pays for its surface water is called done', module: 'terraforming', from: 'if (suited && !paysForSurfaceWater(body, species)) {', to: 'if (suited) {', fails: ['drain'] },
  { name: 'a plan never drains the surface water', module: 'terraforming', from: 'if (!plan || !leavesDrainableWater(body, species, plan, gasInfo)) {', to: 'if (true) {', fails: ['drain'] },
  { name: 'a plan for an oxygen breather never drains the ocean it must shrink to 75 %', module: 'terraforming', from: 'return !plan && body.HydroExt > 0 && lever.hydroExt === 0 ?', to: 'return !plan && species.BreatheID !== GAS.OXYGEN && body.HydroExt > 0 && lever.hydroExt === 0 ?', fails: ['oxygen drain', 'drain', 'planner', 'minimum time'], needs: REPORTED },
  { name: 'a drain is allowed without a thawed stage', module: 'terraforming', from: 'if (drainCanComplete(state, water, gasInfo)) {', to: 'if (true) {', fails: ['drain order'] },
  { name: 'the held plan keeps its costly ice and suppresses the aim search', module: 'terraforming', from: 'return plan && !plan.partial && !leavesDrainableWater(body, species, plan, gasInfo) ? plan : null', to: 'return plan && !plan.partial ? plan : null', fails: ['drain order'] },
  { name: 'a full but wet aim suppresses a reachable thaw-and-drain aim', module: 'terraforming', from: 'if (initial && !initial.partial && clearsWater(initial)) {', to: 'if (initial && !initial.partial) {', fails: ['drain order'] },
  { name: 'water vapour a breather rates is dangerous whatever its share', module: 'terraforming', from: 'summary.waterDangerous = summary.waterDangerous || toxicFor(gas, species, null)', to: 'summary.waterDangerous = summary.waterDangerous || gasDanger(gas, species.BreatheID).dangerous > 0', fails: ['vapour plan'] },
  { name: 'dangerous water vapour is taken out as a toxic gas as well', module: 'terraforming', from: '} else if (gas.AtmosGasID === GAS.WATER_VAPOUR) {', to: '} else if (gas.AtmosGasID === GAS.WATER_VAPOUR && !toxicFor(gas, species, warmedTo)) {', fails: ['vapour plan'] },
  { name: 'a plan that drains is given the capacity basis', module: 'terraforming', from: 'timeBasis: planTimeBasis(plan), after: planned', to: 'timeBasis: TIME_BASIS.CAPACITY, after: planned', fails: ['minimum time'] },
  { name: 'a step that drains is given the capacity basis', module: 'terraforming', from: 'export const stepTimeBasis = (step) => (step.drained > 0 ? TIME_BASIS.MINIMUM : TIME_BASIS.CAPACITY)', to: 'export const stepTimeBasis = (step) => TIME_BASIS.CAPACITY', fails: ['minimum time'] },
  { name: 'a plan is a minimum only when every step drains', module: 'terraforming', from: 'plan && plan.steps.some((step) => step.drained > 0)', to: 'plan && plan.steps.every((step) => step.drained > 0)', fails: ['minimum time'] },
  { name: 'a minimum is worded as the plain years', module: 'terraforming', from: 'if (basis !== TIME_BASIS.MINIMUM || !Number.isFinite(years)) {', to: 'if (true) {', fails: ['minimum time'] },
  { name: 'a minimum of days is worded as under 0.1 years', module: 'terraforming', from: 'years >= 0.1 ? text(floored(years, places)) : days >= 0.1', to: 'true ? text(floored(years, places)) : days >= 0.1', fails: ['minimum time'] },
  { name: 'a minimum is worded without its least', module: 'terraforming', from: 'return `at least ${years >= 0.1', to: 'return `${years >= 0.1', fails: ['minimum time'] },
  { name: 'the ranking leaves out the basis of the years', module: 'colonization', from: 'yearsBasis: assessment.timeBasis, cost: assessment.after.worst', to: 'yearsBasis: null, cost: assessment.after.worst', fails: ['minimum time'] },
  { name: 'the score is not marked as resting on a minimum', module: 'colonization', from: '...(best.strategy === \'terraform\' && best.yearsBasis === TIME_BASIS.MINIMUM ? [MINIMUM_YEARS_ASSUMPTION] : [])', to: '...[]', fails: ['minimum time'] },
  { name: 'the plan of a route leaves out the basis of its years', module: 'colonization-states', from: 'years: terraformYears, yearsBasis: assessment.timeBasis,', to: 'years: terraformYears, yearsBasis: null,', fails: ['minimum time'] },
  { name: 'the states word a minimum as plain years', module: 'colonization-states', from: 'const planTime = (plan) => timeWords(plan.years, plan.yearsBasis, years, plan.years < 10 ? 1 : 0)', to: 'const planTime = (plan) => years(plan.years)', fails: ['minimum time'] },
  { name: 'the states floor a minimum to whole years', module: 'colonization-states', from: 'const planTime = (plan) => timeWords(plan.years, plan.yearsBasis, years, plan.years < 10 ? 1 : 0)', to: 'const planTime = (plan) => timeWords(plan.years, plan.yearsBasis, years, 0)', fails: ['minimum time'] },
  { name: 'a lower bound is rounded to nearest, not floored', module: 'terraforming', from: '  const scale = 10 ** places\n  let out = Math.floor(Number((value * scale).toPrecision(15))) / scale\n\n  if (out > value) {\n    out = Math.round(out * scale - 1) / scale\n  }\n\n  return out', to: '  return Math.round(value * 10 ** places) / 10 ** places', fails: ['minimum time'] },
  { name: 'the floor restores the 1e-9 offset that lifts a bound above itself', module: 'terraforming', from: '  const scale = 10 ** places\n  let out = Math.floor(Number((value * scale).toPrecision(15))) / scale\n\n  if (out > value) {\n    out = Math.round(out * scale - 1) / scale\n  }\n\n  return out', to: '  return Math.floor(value * 10 ** places + 1e-9) / 10 ** places', fails: ['minimum time'] },
  { name: 'the floor does not step a lifted figure down to the value passed in', module: 'terraforming', from: '  if (out > value) {', to: '  if (false) {', fails: ['minimum time'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the states leave out the limit of a minimum', module: 'colonization-states', from: 'Number.isFinite(plan.years) ? ` ${MINIMUM_TIME_NOTE}` : \'\')', to: 'Number.isFinite(plan.years) ? \'\' : \'\')', fails: ['minimum time'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the layer leaves out the bodies below the minimum gravity whatever the options', module: 'map-features', from: 'FCT_SystemBody.Gravity <= ${limits.MaximumGravity}', to: 'FCT_SystemBody.Gravity >= ${limits.MinimumGravity} and FCT_SystemBody.Gravity <= ${limits.MaximumGravity}', fails: ['map'] },
  { name: 'the layer follows the tactical low-gravity option for the habitable band', module: 'map-features', from: 'FCT_Race.chkHabRangeWorldsLowG', to: 'FCT_Race.chkCCIncludeLowG as chkHabRangeWorldsLowG', fails: ['map'] },
  { name: 'the layer reads none of the Galaxy Map options', module: 'map-features', from: 'select FCT_Race.chkHabRangeWorlds, FCT_Race.chkHabRangeWorldsLowG, FCT_Race.chkLowCCNormalG, FCT_Race.chkLowCCLowG, FCT_Race.chkMediumCCNormalG, FCT_Race.chkMediumCCLowG from', to: 'select 0 as chkHabRangeWorlds, 0 as chkHabRangeWorldsLowG, 0 as chkLowCCNormalG, 0 as chkLowCCLowG, 0 as chkMediumCCNormalG, 0 as chkMediumCCLowG from', fails: ['map'] },
  { name: 'a band counts every body whatever its options', module: 'map-features', from: '(normalGravityOnly && !includeLowGravity ? \'normal\' : \'all\')', to: '\'all\'', fails: ['map'] },
  { name: 'a band with neither option counts the bodies at normal gravity', module: 'map-features', from: '(normalGravityOnly && !includeLowGravity ? \'normal\' : \'all\')', to: '(includeLowGravity ? \'all\' : \'normal\')', fails: ['map'] },
  { name: 'the normal-gravity option wins over the low-gravity one', module: 'map-features', from: '(normalGravityOnly && !includeLowGravity ? \'normal\' : \'all\')', to: '(normalGravityOnly ? \'normal\' : \'all\')', fails: ['map'] },
  { name: 'the count at normal gravity ignores the gravity', module: 'map-features', from: 'normal[band] += Gravity >= limits.MinimumGravity ? 1 : 0', to: 'normal[band] += 1', fails: ['map'] },
  { name: 'the layer prices the water of every body as liquid', module: 'map-features', from: 'FCT_SystemBody.HydroExt || \',\' || FCT_SystemBody.HydroID || \',\'', to: 'FCT_SystemBody.HydroExt || \',\' || 3 || \',\'', fails: ['map'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the danger flag compares the protection rounded', module: 'map-features', from: 'value: less(protection, fromDouble(danger))', to: 'value: less(fromDouble(Math.round(Number(`${protection.m}e-${protection.s}`))), fromDouble(danger))', fails: ['danger'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the protection is summed as a binary floating-point number', module: 'map-features', from: 'total = add(total, fromDouble(protection))', to: 'total = (() => { const sum = Number(`${total.m}e-${total.s}`) + protection; const [whole, fraction = \'\'] = String(sum).split(\'.\'); return { m: BigInt(whole + fraction), s: fraction.length } })()', fails: ['danger'] },
  { name: 'the registry drops the declared tactical options', module: 'capabilities', from: '  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-302-01\', table: \'FCT_Race\', columns: Object.freeze([\'chkShowBodyColours\', \'chkCCIncludeLowG\', \'chkGasGiantColour\']) }),\n', to: '', fails: ['capability'] },
]

const loadAll = async (module = null, source = null) => {
  const loaded = await loadUtilities(MODULES, { stubs: { 'lodash/groupBy': GROUP_BY }, sources: module ? { [module]: source } : {} })
  const subject = (name) => subjectModule(loaded[name])

  return { h: subject('habitability'), t: subject('terraforming'), l: subject('terraform-limits'), d: subject('colonization-data'), z: subject('colonization'), s: subject('colonization-states'), f: subject('map-features'), n: subject('decimal'), c: subject('colonies'), k: subject('capabilities'), p: subject('provenance') }
}

const main = async () => {
  const loaded = await loadUtilities(['habitability', 'colonization-data'], { stubs: { 'lodash/groupBy': GROUP_BY } })
  const world = await savedWorld(loaded)

  try {
    const results = await runChecks(checks, { ...(await loadAll()), world })

    results.filter(({ ok }) => !ok).forEach(({ name, detail }) => console.log(`FAIL ${name}: ${detail}`))
    let passed = results.filter(({ ok }) => ok).length
    let total = results.length

    for (const fault of mutating() ? faults : []) {
      if (fault.needs && !fs.existsSync(path.join(root, fault.needs.file))) {
        console.log(`SKIP mutant ${fault.name}: ${fault.needs.file} is absent`)
        continue
      }

      total += 1
      refusePlanting(fault.name)
      const source = plantedPatch(`${fault.module}.js`, ORIGINALS[fault.module], fault.from, fault.to)
      const found = await runChecks(checks.filter(({ id }) => fault.fails.includes(id)), { ...(await loadAll(fault.module, source)), world })

      judged(found, fault.name)
      if (caughtAll(found, { name: fault.name })) {
        passed += 1
      } else {
        console.log(`FAIL mutant ${fault.name}: a named check still passes`)
      }
    }

    console.log(`${passed} of ${total} checks passed`)
    process.exitCode = passed === total ? 0 : 1
  } finally {
    world.forEach(({ database }) => database.close())
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
