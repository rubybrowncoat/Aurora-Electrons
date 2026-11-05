/*
  Checks the orbital-temperature rule of SystemBody.method_1/method_2/method_3 (Aurora 3.1.0) on hand-worked bodies, including moons and the distinct temperature floors. The save comparison requires a finite stored temperature, prediction and delta: a non-finite figure is a failed comparison, never a match. The optional saves are read only: the migrated save records a 2.7-versus-3.1 delta, not an oracle; the shipped save records a time-zero comparison, but its body rows are identical to the shipped 3.0.0 save (root measurement, AE-302-02 evidence). Specimen S2 of AE-310-03 remains the played-and-saved moon oracle.
  bun scripts/check-habitability.js [--no-mutations]
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, subjectModule, runChecks, judged, caughtAll } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const file = path.join(root, 'src/renderer/utilities/habitability.js')
const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const GROUP_BY = 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})'
const bodyOf = (extra = {}) => ({ BodyClass: 1, Eccentricity: 0.6, OrbitalDistance: 1, Year: 8760, DistanceToParent: 1, StarLuminosity: 1, BaseTemp: 255, SurfaceTemp: 280.5, Albedo: 1, AtmosPress: 1, DustLevel: 0, HydroExt: 50, HydroID: 3, Atmosphere: [{ GasAtm: 1, BoilingPoint: 0, GHGas: 0, AntiGHGas: 0 }], ...extra })
const close = (actual, expected, name) => assert.ok(Math.abs(actual - expected) < 1e-9, `${name}: ${actual} != ${expected}`)
const checks = []
const check = (id, name, run) => checks.push({ id, name, run })

check('factor', 'pressure and ocean contributions cap separately and the year reduces only long-orbit dampening', (h) => {
  close(h.orbitalTemperatureDampening(bodyOf()), 0.25, 'one atmosphere and half an ocean')
  close(h.orbitalTemperatureDampening(bodyOf({ AtmosPress: 20, HydroExt: 200 })), 0.8, 'separate caps')
  close(h.orbitalTemperatureDampening(bodyOf({ AtmosPress: 20, HydroExt: 200, Year: 35040 })), 0.4, 'four-year orbit')
  close(h.orbitalTemperatureDampening(bodyOf({ Year: 2190 })), 0.25, 'short orbit does not amplify')
  close(h.orbitalTemperatureDampening(bodyOf({ Eccentricity: 0 })), 0, 'circular orbit')
  close(h.orbitalTemperatureDampening(bodyOf({ OrbitalDistance: 0 })), 0, 'no orbit')
  close(h.orbitalTemperatureDampening(bodyOf({ AtmosPress: 0, HydroExt: 0, Year: undefined })), 0, 'barren body does not read a year')
})

check('extremes', 'the extremes blend kelvin temperatures toward the circular-orbit temperature before an ice transition', (h) => {
  const body = bodyOf()
  close(h.temperatureAtDistance(body, 0.4), (255 / Math.sqrt(0.4) * 0.75 + 255 * 0.25) * 1.1, 'periapsis')
  close(h.temperatureAtDistance(body, 1.6), (255 / Math.sqrt(1.6) * 0.75 + 255 * 0.25) * 1.1 * 0.925, 'apoapsis freezes the ocean after the blend')
  const barren = bodyOf({ AtmosPress: 0, HydroExt: 0, Atmosphere: [], Year: undefined })
  close(h.temperatureAtDistance(barren, 0.4), 255 / Math.sqrt(0.4), 'barren periapsis unchanged')
  close(h.temperatureAtDistance(barren, 1.6), 255 / Math.sqrt(1.6), 'barren apoapsis unchanged')
})

check('moon', 'a moon takes its parent orbit and year but its own atmosphere and ocean', (h) => {
  const moon = bodyOf({ BodyClass: 2, OrbitalDistance: 0.001, Eccentricity: 0, Year: 24, ParentOrbitalDistance: 1, ParentEccentricity: 0.6, ParentYear: 35040, HydroExt: 0 })
  close(h.orbitalTemperatureDampening(moon), 0.05, 'parent year and moon pressure')
  close(h.temperatureAtDistance(moon, 0.4), (255 / Math.sqrt(0.4) * 0.95 + 255 * 0.05) * 1.1, 'parent circular reference')
  close(h.orbitalTemperatureDampening({ ...moon, ParentOrbitalDistance: undefined, ParentEccentricity: undefined, ParentYear: undefined }), 0, 'missing parent follows the game no-parent rule')
})

check('floors', 'method_3 floors the base at 4 K and only an undampened result at 1 K; stored temperatures floor at 4 K', (h) => {
  const barren = bodyOf({ AtmosPress: 0, HydroExt: 0, Atmosphere: [], Albedo: 0.5, BaseTemp: 4 })
  close(h.temperatureAtDistance(barren, 1e8), 2, '4 K base floor')
  close(h.temperatureAtDistance({ ...barren, Albedo: 0.01 }, 1e8), 1, '1 K undampened floor')
  const wet = bodyOf({ OrbitalDistance: 1e8, Albedo: 0.01, BaseTemp: 4, HydroExt: 0 })
  close(h.temperatureAtDistance(wet, 1e8), 4 * 1.1 * 0.01 * 0.9 + 255 / 1e4 * 1.1 * 0.01 * 0.1, 'no final dampened floor or circular base floor')
  close(h.surfaceTemperature(wet, 1.1, 1), 4, 'stored 4 K floor')
})

check('stored', 'the stored-temperature rule blends the present and circular temperatures without deriving climate factors from a dampened SurfaceTemp', (h) => {
  const body = bodyOf({ DistanceToParent: 0.4, BaseTemp: 255 / Math.sqrt(0.4), HydroExt: 0 })
  close(h.surfaceTemperature(body, 1.7, 1.2), (body.BaseTemp * 0.9 + 255 * 0.1) * 1.7 / 1.2, 'stored greenhouse factors')
})

check('inputs', 'eccentric wet bodies require an orbital year, and moons require the parent year', (h) => {
  assert.ok(h.missingBodyInputs(bodyOf({ Year: undefined })).includes('body orbital year'))
  assert.ok(h.missingBodyInputs(bodyOf({ BodyClass: 2, ParentOrbitalDistance: 1, ParentEccentricity: 0.6 })).includes('body planet orbital year'))
  assert.ok(!h.missingBodyInputs(bodyOf({ AtmosPress: 0, HydroExt: 0, Year: undefined })).includes('body orbital year'))
})

// The gases of DIM_Gases the checks below price, each with its four breathers' danger pairs as the 3.1 export holds them (DatabaseExport/DIM_Gases.csv): a gas is dangerous to a breather by the rating of the pair of the breathing gas, above the parts per million of the atmosphere the pair gives.
const gasOf = (AtmosGasID, AtmosGasPercentage, GasAtm, danger) => ({ AtmosGasID, AtmosGasPercentage, GasAtm, FrozenOut: 0, BoilingPoint: 0, GHGas: 0, AntiGHGas: 0, DangerousOxygen: danger[0], DangerousPPMOxygen: danger[1], DangerousMethane: danger[2], DangerousPPMMethane: danger[3], DangerousSulphur: danger[4], DangerousPPMSulphur: danger[5], DangerousAmmonia: danger[6], DangerousPPMAmmonia: danger[7] })
const METHANE = (share) => gasOf(3, share, share / 100, [2, 500, 0, 0, 0, 0, 2, 10000])
const AMMONIA = (share) => gasOf(4, share, share / 100, [2, 50, 2, 500, 2, 1000, 0, 0])
const NITROGEN = (share) => gasOf(7, share, share / 100, [0, 0, 0, 0, 0, 0, 0, 0])
const OXYGEN = (share) => gasOf(10, share, share / 100, [0, 0, 3, 50, 2, 2000, 3, 200])
const SULPHUR_DIOXIDE = (share) => gasOf(15, share, share / 100, [2, 5, 2, 200, 0, 0, 2, 200])
const BREATHERS = { oxygen: 10, methane: 3, ammonia: 4, sulphur: 15 }
const breatherOf = (h, BreatheID) => h.speciesLimits({ IdealTemperature: 288, TemperatureDeviation: 30, IdealBreathePressure: 0.2, BreathePressureDeviation: 0.1, IdealGravity: 1, GravityDeviation: 0.5, MaximumPressure: 4, BreatheID, PopulationDensityModifier: 1 })
const airOf = (Atmosphere) => ({ BodyClass: 1, TidalLock: 0, AtmosPress: 1, HydroExt: 50, Gravity: 1, Atmosphere })

check('accessor', 'the danger of a gas is the pair of the breathing gas: oxygen without a species, none for a gas the game has no pair for', (h) => {
  const read = (gas, breathing) => {
    const { dangerous, ppm } = h.gasDanger(gas, breathing)

    return [dangerous, ppm]
  }

  assert.deepEqual(read(METHANE(1)), [2, 500], 'no breathing gas reads the oxygen pair')
  assert.deepEqual(read(OXYGEN(1), BREATHERS.oxygen), [0, 0], 'oxygen is no danger to an oxygen breather')
  assert.deepEqual(read(OXYGEN(1), BREATHERS.methane), [3, 50], 'the methane pair')
  assert.deepEqual(read(OXYGEN(1), BREATHERS.sulphur), [2, 2000], 'the sulphur dioxide pair')
  assert.deepEqual(read(OXYGEN(1), BREATHERS.ammonia), [3, 200], 'the ammonia pair')
  assert.deepEqual(read(OXYGEN(1), 7), [0, 0], 'a breathing gas the game has no pair for reads as no danger')
})

check('danger', 'the worst dangerous gas and its rating are those of the species\' breathing gas, never the oxygen pair', (h) => {
  const air = airOf([OXYGEN(10), METHANE(10), AMMONIA(10), SULPHUR_DIOXIDE(10), NITROGEN(60)])
  // The gas and the rating each breather meets: the first gas of the highest rating among those other than its own breathing gas.
  const expected = { oxygen: [3, 2], methane: [10, 3], ammonia: [10, 3], sulphur: [10, 2] }

  Object.entries(BREATHERS).forEach(([name, id]) => {
    const { dangerousGas, factors } = h.costFactors(air, breatherOf(h, id), 288)

    assert.deepEqual([dangerousGas ? dangerousGas.AtmosGasID : null, factors.danger], expected[name], `${name} breather: the worst gas and its rating`)
  })
})

check('limit', 'a gas is dangerous above the parts per million of the breather\'s pair, counted on its share of the atmosphere', (h) => {
  const worst = (breathing, atmosphere) => {
    const { dangerousGas } = h.costFactors(airOf(atmosphere), breatherOf(h, breathing), 288)

    return dangerousGas ? dangerousGas.AtmosGasID : null
  }

  // Methane is dangerous to an oxygen breather above 500 ppm (0.05 % of the atmosphere), oxygen to a methane breather above 50 ppm (0.005 %); the pressure of the gas plays no part.
  assert.equal(worst(BREATHERS.oxygen, [METHANE(0.049), NITROGEN(99.9)]), null, 'methane under its limit')
  assert.equal(worst(BREATHERS.oxygen, [METHANE(0.051), NITROGEN(99.9)]), 3, 'methane over its limit')
  assert.equal(worst(BREATHERS.methane, [OXYGEN(0.0049), NITROGEN(99.9)]), null, 'oxygen under its limit')
  assert.equal(worst(BREATHERS.methane, [OXYGEN(0.0051), NITROGEN(99.9)]), 10, 'oxygen over its limit')
})

check('share', 'the breathing gas fails above 30 % of the air by its share of the atmosphere, not by its pressure', (h) => {
  const species = breatherOf(h, BREATHERS.oxygen)

  assert.equal(h.breathingFails(airOf([{ ...OXYGEN(35), GasAtm: 0.25 }, NITROGEN(65)]), species), true, 'a share over 30 % at a pressure inside the range')
  assert.equal(h.breathingFails(airOf([{ ...OXYGEN(25), GasAtm: 0.25 }, NITROGEN(75)]), species), false, 'a share under 30 % at the same pressure')
})

check('gas inputs', 'a gas row without its share or the danger pair of any breather leaves the body unpriced, naming the figure', (h) => {
  const missing = (gas) => h.missingBodyInputs(bodyOf({ Atmosphere: [gas] })).filter((name) => name.startsWith('atmosphere'))
  const figures = [['AtmosGasPercentage', 'gas share'], ['DangerousOxygen', 'danger to oxygen breathers'], ['DangerousPPMOxygen', 'danger level for oxygen breathers'], ['DangerousMethane', 'danger to methane breathers'], ['DangerousPPMMethane', 'danger level for methane breathers'], ['DangerousSulphur', 'danger to sulphur dioxide breathers'], ['DangerousPPMSulphur', 'danger level for sulphur dioxide breathers'], ['DangerousAmmonia', 'danger to ammonia breathers'], ['DangerousPPMAmmonia', 'danger level for ammonia breathers']]

  assert.deepEqual(missing(OXYGEN(20)), [], 'a whole row lacks nothing')
  figures.forEach(([column, name]) => assert.deepEqual(missing({ ...OXYGEN(20), [column]: null }), [`atmosphere ${name}`], column))
})

// The oracle's own arithmetic: a finite comparison is a match, and a missing input that leaves the prediction non-finite is a
// failed comparison, never a match. The mutant below makes a planet read its missing parent distance, so this check goes red.
check('oracle', 'the oracle counts only a finite prediction and a finite delta as a match', (h) => {
  const summary = compared(h, [bodyOf({ GHFactor: 1.1, AGHFactor: 1 }), bodyOf({ GHFactor: 1.1, AGHFactor: 1, Year: undefined })])

  assert.equal(summary.count, 2, 'both bodies are compared')
  assert.equal(summary.match, 1, 'only the finite comparison matches')
  assert.equal(summary.invalid, 1, 'the missing orbital year is a failed comparison, not a match')
  assert.equal(summary.differ, 0, 'neither comparison is a finite difference')
  assert.equal(summary.maxAbsError, 0, 'the finite comparison is exact')
})

const faults = [
  { name: 'dampening omitted', from: 'return (Math.min(0.5, body.AtmosPress / 10) + Math.min(0.3, body.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(year / 8760))', to: 'return 0', fails: ['factor', 'extremes', 'moon', 'stored'] },
  { name: 'pressure cap omitted', from: 'Math.min(0.5, body.AtmosPress / 10)', to: 'body.AtmosPress / 10', fails: ['factor'] },
  { name: 'ocean cap omitted', from: 'Math.min(0.3, body.HydroExt / 100 * 0.3)', to: '(body.HydroExt / 100 * 0.3)', fails: ['factor'] },
  { name: 'short years amplify dampening', from: 'Math.min(1, 1 / Math.sqrt(year / 8760))', to: '(1 / Math.sqrt(year / 8760))', fails: ['factor'] },
  { name: 'moon year used', from: 'year: body.ParentYear', to: 'year: body.Year', fails: ['moon'] },
  { name: 'moon distance used', from: 'distance: body.ParentOrbitalDistance', to: 'distance: body.OrbitalDistance', fails: ['moon'] },
  { name: 'moon eccentricity used', from: 'eccentricity: body.ParentEccentricity', to: 'eccentricity: body.Eccentricity', fails: ['moon'] },
  { name: 'circular orbits dampened', from: 'if (!distance || !eccentricity || (body.AtmosPress <= 0 && body.HydroExt <= 0))', to: 'if (!distance || (body.AtmosPress <= 0 && body.HydroExt <= 0))', fails: ['factor'] },
  { name: 'base floor removed', from: 'Math.max(255 / Math.sqrt(distance / Math.sqrt(luminosity)), 4)', to: '(255 / Math.sqrt(distance / Math.sqrt(luminosity)))', fails: ['floors'] },
  { name: 'dampened temperature floored at 1 K', from: 'return temperature * (1 - factor) + circular * factor', to: 'return Math.max(1, temperature * (1 - factor) + circular * factor)', fails: ['floors'] },
  { name: 'undampened result floored at 4 K', from: 'return Math.max(1, temperature)', to: 'return Math.max(4, temperature)', fails: ['floors'] },
  { name: 'circular base floored at 4 K', from: '255 / Math.sqrt(distance / Math.sqrt(body.StarLuminosity))', to: 'equilibriumTemperature(distance, body.StarLuminosity)', fails: ['floors'] },
  { name: 'stored temperature floored at 1 K', from: 'Math.max(4, dampenedTemperature(body, body.BaseTemp * greenhouse * albedo / antiGreenhouse, greenhouse, antiGreenhouse, albedo))', to: 'Math.max(1, dampenedTemperature(body, body.BaseTemp * greenhouse * albedo / antiGreenhouse, greenhouse, antiGreenhouse, albedo))', fails: ['floors'] },
  { name: 'planet year treated as optional', from: "lacking(body, [['Year', 'orbital year']], 'body')", to: 'NOTHING', fails: ['inputs'] },
  { name: 'a planet reads its missing parent distance', from: 'equilibriumTemperature(body.BodyClass === BODY_CLASS.MOON && body.ParentDistanceToParent > 0 ? body.ParentDistanceToParent : body.DistanceToParent, body.StarLuminosity)', to: 'equilibriumTemperature(body.ParentDistanceToParent, body.StarLuminosity)', fails: ['oracle'] },
  { name: 'a non-oxygen breather reads the oxygen pair', from: 'const pair = BREATHER_DANGER[breathingGas]', to: 'const pair = BREATHER_DANGER[GAS.OXYGEN]', fails: ['accessor', 'danger', 'limit'] },
  { name: 'no breathing gas reads the methane pair', from: 'export const gasDanger = (gas, breathingGas = GAS.OXYGEN) => {', to: 'export const gasDanger = (gas, breathingGas = GAS.METHANE) => {', fails: ['accessor'] },
  { name: 'the worst gas is chosen by the oxygen pair', from: 'const { dangerous, ppm } = gasDanger(gas, species.BreatheID)', to: 'const { dangerous, ppm } = gasDanger(gas)', fails: ['danger', 'limit'] },
  { name: 'the danger cost reads the oxygen pair of the worst gas', from: 'const dangerCost = gas ? gasDanger(gas, species.BreatheID).dangerous : 0', to: 'const dangerCost = gas ? gasDanger(gas).dangerous : 0', fails: ['danger'] },
  { name: 'the danger limit is read on the pressure of the gas', from: 'gas.AtmosGasPercentage > ppm / 10000', to: 'gas.GasAtm > ppm / 10000', fails: ['limit'] },
  { name: 'the breathing share is read on the pressure of the gas', from: 'total + candidate.AtmosGasPercentage, 0)', to: 'total + candidate.GasAtm, 0)', fails: ['share'] },
  { name: 'the danger pairs are not required of a gas', from: ', ...DANGER_INPUTS]', to: ']', fails: ['gas inputs'] },
  { name: 'the share of a gas is not required', from: '[\'AtmosGasPercentage\', \'gas share\'], ', to: '', fails: ['gas inputs'] },
]

// A finite number, so that a missing figure never reads as agreement: a non-finite stored or predicted temperature, or a
// non-finite delta, is a failed comparison and never a match (`Math.abs(NaN) > 0.01` is false).
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const measured = ({ stored, predicted, delta }) => finite(stored) && finite(predicted) && finite(delta)

const compared = (h, bodies) => {
  const deltas = bodies.map((body) => {
    const predicted = h.surfaceTemperature({ ...body, BaseTemp: h.climateBaseTemp(body) }, body.GHFactor, body.AGHFactor)

    return { id: body.SystemBodyID, moon: body.BodyClass === 2, stored: body.SurfaceTemp, predicted, delta: predicted - body.SurfaceTemp }
  })
  const valid = deltas.filter(measured)
  const invalid = deltas.filter((entry) => !measured(entry))
  const different = valid.filter(({ delta }) => Math.abs(delta) > 0.01)
  const abs = valid.map(({ delta }) => Math.abs(delta)).sort((a, b) => a - b)

  return { count: bodies.length, match: valid.length - different.length, differ: different.length, invalid: invalid.length, moons: deltas.filter(({ moon }) => moon).length, minAbsDelta: abs[0] || 0, maxAbsDelta: abs[abs.length - 1] || 0, meanAbsDelta: abs.length ? abs.reduce((sum, delta) => sum + delta, 0) / abs.length : 0, maxAbsError: Math.max(0, ...abs), differences: different, invalidBodies: invalid }
}

const oracle = async (h) => {
  for (const [name, fixture] of [['migrated-2.7-temperatures', 'AuroraDB-310-spookyerol-migrated.db'], ['shipped-3.1-time-zero', 'AuroraDB_310_shipped.db']]) {
    const filename = path.join(root, 'saves', fixture)

    if (!fs.existsSync(filename)) {
      console.log(`SKIP ${name}: ${fixture} is absent`)
      continue
    }

    const database = new Database(filename, { readonly: true })

    try {
      const bodies = database.query('select b.*, s.Luminosity as StarLuminosity, p.OrbitalDistance as ParentOrbitalDistance, p.Eccentricity as ParentEccentricity, p.Year as ParentYear, p.DistanceToParent as ParentDistanceToParent from FCT_SystemBody b join FCT_Star s on s.StarID = b.StarID and s.GameID = b.GameID left join FCT_SystemBody p on p.SystemBodyID = b.ParentBodyID and p.GameID = b.GameID and b.ParentBodyType = 1').all()
      const eccentricWet = (body) => (body.BodyClass === 2 ? body.ParentEccentricity : body.Eccentricity) > 0 && (body.AtmosPress > 0 || body.HydroExt > 0)
      const summary = compared(h, bodies.filter(eccentricWet))

      if (name === 'migrated-2.7-temperatures') {
        const specified = bodies.filter((body) => body.Eccentricity > 0.1 && (body.AtmosPress > 0 || body.HydroExt > 0))

        assert.equal(specified.length, 59, 'the AE-310-01 interim specimen identifies 59 bodies with eccentricity above 0.1')
        console.log(`ORACLE ${name} specified-59 ${JSON.stringify(compared(h, specified))}`)
      }

      console.log(`ORACLE ${name} eccentric-atmosphere-ocean ${JSON.stringify(summary)}`)
      console.log(`ORACLE ${name} all-bodies ${JSON.stringify(compared(h, bodies))}`)
      if (name === 'shipped-3.1-time-zero') {
        assert.equal(bodies.length, 706, 'the pristine time-zero specimen has 706 bodies')
        const planets = compared(h, bodies.filter((body) => body.BodyClass !== 2 && eccentricWet(body)))

        assert.equal(planets.count, 7, 'the time-zero specimen has seven eccentric atmosphere/ocean planets')
        assert.equal(planets.match, 7, 'the seven planets match the source rule within 0.01 K')
        assert.equal(planets.invalid, 0, 'every one of the seven planets compares as a finite number')
        console.log('OPEN 3.1 moon check: specimen S2 of AE-310-03 must be played and saved after an orbital update; the shipped lunar temperatures predate that observation')
      }
    } finally {
      database.close()
    }
  }
}

const main = async () => {
  const loaded = await loadUtilities(['habitability'])
  const h = subjectModule(loaded.habitability)
  const results = await runChecks(checks, h)

  results.filter(({ ok }) => !ok).forEach(({ name, detail }) => console.log(`FAIL ${name}: ${detail}`))
  let passed = results.filter(({ ok }) => ok).length
  let total = results.length

  for (const fault of mutating() ? faults : []) {
    total += 1
    refusePlanting(fault.name)
    const source = plantedPatch('habitability.js', original, fault.from, fault.to)
    const mutant = subjectModule((await loadUtilities(['habitability'], { sources: { habitability: source } })).habitability)
    const found = await runChecks(checks.filter(({ id }) => fault.fails.includes(id)), mutant)

    judged(found, fault.name)
    if (caughtAll(found, { name: fault.name })) {
      passed += 1
    } else {
      console.log(`FAIL mutant ${fault.name}: a named check still passes`)
    }
  }

  const modules = await loadUtilities(['colonization-data'], { stubs: { 'lodash/groupBy': GROUP_BY } })
  // The planner's loader on the migrated 3.1 save: the year inputs reach the rule and every gas row of an atmosphere carries the figures the rule reads (the share and the danger pairs in their 3.1 columns). It is not a temperature oracle.
  const fixture = path.join(root, 'saves/AuroraDB-310-spookyerol-migrated.db')

  if (fs.existsSync(fixture)) {
    total += 1
    const database = new Database(fixture, { readonly: true })

    try {
      const bodies = await modules['colonization-data'].loadBodies({ query: async (sql) => [database.query(sql).all()] }, { GameID: 141, RaceID: 784 })
      const atmospheres = bodies.flatMap((body) => body.Atmosphere)

      assert.ok(bodies.length > 0 && bodies.every((body) => Number.isFinite(body.Year)), 'the planner loads every body year')
      assert.ok(bodies.some((body) => body.BodyClass === 2) && bodies.filter((body) => body.BodyClass === 2).every((body) => Number.isFinite(body.ParentYear)), 'the planner loads every moon parent year')
      assert.ok(atmospheres.length > 0 && bodies.every((body) => h.missingBodyInputs(body).every((name) => !name.startsWith('atmosphere'))), 'every gas row of an atmosphere carries its share and the danger pairs of the four breathers')
      console.log(`LOADER ${bodies.length} bodies carry orbital years and ${atmospheres.length} gas rows carry their 3.1 gas columns`)
      passed += 1
    } finally {
      database.close()
    }
  }

  await oracle(h)
  console.log(`${passed} of ${total} checks passed`)
  process.exitCode = passed === total ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
