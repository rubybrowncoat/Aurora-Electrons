/*
  Checks what limits the colony cost at each stage of a terraforming plan (src/renderer/utilities/terraform-limits.js, the limiting-factor bars and the stage table of components/planner/BodyDetail.vue, and the page that hosts them) without a save.

  Every statement runs on bodies and a species made here and on the real utilities and component. Nothing is read from a save. The statements cover the acceptance of AE-070-01:
  - the first stage is the body as the body detail prices it (the same cost factors at now, periapsis and apoapsis, and the factor bars flag the same factors), with the frozen-out flags the save carries;
  - each gas operation of a plan names the factors that limit the cost after it and the factors that would limit it next, every one of them where several are equal (exact ties, ties at the game's four decimals, ties between the orbit points), and says which it cleared and which it revealed;
  - the last stage is the plan's own end state, whatever the colonisation skill, and the water extent changes only in the stage that settles it;
  - a fixed blocker (gravity below the species' minimum, a tidal lock, a body that cannot be colonised) is never promised away by a gas operation: no stage clears it, the cost never goes under the floor it sets, and a plan that reaches the floor says only a fixed factor remains.

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1. `--no-mutations` skips the faults.

  The component and the page are checked by what they do: the component's computed rows and bars evaluated on a pseudo instance, and the compiled templates' elements and bound expressions. No statement matches source text or prose; only a planted fault names a source anchor.
*/
const fs = require('fs')
const path = require('path')
const compiler = require('vue/compiler-sfc')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')

const FILES = {
  habitability: path.join(rendererDirectory, 'utilities', 'habitability.js'),
  limits: path.join(rendererDirectory, 'utilities', 'terraform-limits.js'),
  terraforming: path.join(rendererDirectory, 'utilities', 'terraforming.js'),
  vue: path.join(rendererDirectory, 'components', 'planner', 'BodyDetail.vue'),
  page: path.join(rendererDirectory, 'pages', 'habitability.vue'),
}

const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const GROUP_BY = 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})'
const APPEARANCE = 'export const activeAppearance = () => ({}); export const toneColor = () => \'primary\''

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }

  return value
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------
// The ids the game gives the two breathing gases the fixtures use: the danger of a gas is read by the id of the species' breathing gas.
const OXYGEN_ID = 10
const METHANE_ID = 3

// A species that lives between 258 and 318 K, breathes oxygen between 0.1 and 0.3 atm, bears up to 4 atm and gravity from 0.5 to 1.5. The climate of a fixture body is the game's: base temperature times 1 + pressure / 10 + greenhouse gas, with an albedo of 1, so each surface temperature below is worked by hand.
const SPECIES_ROW = { IdealTemperature: 288, TemperatureDeviation: 30, IdealBreathePressure: 0.2, BreathePressureDeviation: 0.1, IdealGravity: 1, GravityDeviation: 0.5, MaximumPressure: 4, BreatheID: OXYGEN_ID, BreatheName: 'Oxygen', PopulationDensityModifier: 1 }
const METHANE_SPECIES_ROW = { ...SPECIES_ROW, BreatheID: METHANE_ID, BreatheName: 'Methane' }

const DANGER = { DangerousOxygen: 0, DangerousPPMOxygen: 0, DangerousMethane: 0, DangerousPPMMethane: 0, DangerousSulphur: 0, DangerousPPMSulphur: 0, DangerousAmmonia: 0, DangerousPPMAmmonia: 0 }
const gas = (AtmosGasID, AtmosGasName, GasAtm, AtmosGasPercentage, extra = {}) => ({ AtmosGasID, AtmosGasName, GasAtm, AtmosGasPercentage, FreezingPoint: 0, GHGas: 0, AntiGHGas: 0, ...DANGER, FrozenOut: 0, ...extra })
const gasRow = (AtmosGasName, extra = {}) => ({ AtmosGasName, FreezingPoint: 0, GHGas: 0, AntiGHGas: 0, ...DANGER, ...extra })

// Methane is dangerous (rating 2) to an oxygen breather above a share of 0.05 % (500 ppm), and warms. Oxygen is dangerous (rating 3) to a methane breather above 0.005 % (50 ppm): the pair a gas has for each breather is the figure of the DatabaseExport/DIM_Gases.csv row.
const METHANE = { DangerousOxygen: 2, DangerousPPMOxygen: 500, GHGas: 1 }
const OXYGEN = { DangerousMethane: 3, DangerousPPMMethane: 50 }
const GASES = { [METHANE_ID]: gasRow('Methane', METHANE), [OXYGEN_ID]: gasRow('Oxygen', OXYGEN), 5: gasRow('Water Vapour'), 7: gasRow('Nitrogen'), 20: gasRow('Aestusium', { GHGas: 1 }), 22: gasRow('Frigusium', { AntiGHGas: 1 }) }
const GAS_LIST = Object.entries(GASES).map(([id, row]) => ({ GasID: Number(id), Name: row.AtmosGasName, ...row }))
const gasInfo = (id) => GASES[id]

const earthlike = (extra = {}) => ({ BodyClass: 1, BodyTypeID: 1, FixedBody: 0, TidalLock: 0, Radius: 6371, Gravity: 1, SurfaceTemp: 275, BaseTemp: 250, Albedo: 1, StarLuminosity: 1, DustLevel: 0, HydroExt: 50, HydroID: 3, AtmosPress: 1, Eccentricity: 0, OrbitalDistance: 1, Year: 8760, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.8, 80)], ...extra })
const airless = (extra = {}) => earthlike({ SurfaceTemp: 250, HydroExt: 0, HydroID: 1, AtmosPress: 0, Atmosphere: [], ...extra })
const withMethane = [gas(OXYGEN_ID, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.75, 75), gas(METHANE_ID, 'Methane', 0.05, 5, METHANE)]
const thick = [gas(7, 'Nitrogen', 6, 100)]

// An atmosphere of nitrogen, Aestusium (warms), Frigusium (cools), methane and oxygen at the given pressures, shares worked from them.
const crowded = (nitrogen, warming, cooling, methane, oxygen) => {
  const total = nitrogen + warming + cooling + methane + oxygen
  const share = (atm) => (atm / total) * 100

  return [gas(7, 'Nitrogen', nitrogen, share(nitrogen)), gas(20, 'Aestusium', warming, share(warming), { GHGas: 1 }), gas(22, 'Frigusium', cooling, share(cooling), { AntiGHGas: 1 }), gas(METHANE_ID, 'Methane', methane, share(methane), METHANE), gas(OXYGEN_ID, 'Oxygen', oxygen, share(oxygen))]
}

// Hand-worked starts: `airless` is a cold body with no air and no water: the breathing gas (2) and the water (2) tie. `toxic` has methane at 5 % (rating 2) and 10 % water (1). `thick` holds 6 atm of nitrogen at 400 K (temperature 2.7333, pressure 2, water 2). `thin` holds 0.1 atm of nitrogen and no oxygen. `trace` holds 0.0005 atm of methane at exactly its dangerous share, which the game does not call dangerous, so the body is done; `traceOver` holds 0.0006 atm, just over it.
const BODIES = {
  liveable: earthlike(),
  airless: airless(),
  airlessLow: airless({ Gravity: 0.4 }),
  toxic: earthlike({ HydroExt: 10, SurfaceTemp: 287.5, Atmosphere: withMethane }),
  toxicLow: earthlike({ Gravity: 0.4, HydroExt: 10, SurfaceTemp: 287.5, Atmosphere: withMethane }),
  frozenToxic: earthlike({ BaseTemp: 200, SurfaceTemp: 220, HydroExt: 10, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.75, 75), gas(METHANE_ID, 'Methane', 0.05, 5, { ...METHANE, FrozenOut: 1 })] }),
  thick: earthlike({ HydroExt: 0, HydroID: 1, AtmosPress: 6, SurfaceTemp: 400, Atmosphere: thick }),
  thickLocked: earthlike({ HydroExt: 0, HydroID: 1, AtmosPress: 6, SurfaceTemp: 400, Atmosphere: thick, TidalLock: 1 }),
  thin: earthlike({ AtmosPress: 0.1, SurfaceTemp: 252.5, Atmosphere: [gas(7, 'Nitrogen', 0.1, 100)] }),
  trace: earthlike({ AtmosPress: 1.0005, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 19.99), gas(7, 'Nitrogen', 0.8, 79.99), gas(METHANE_ID, 'Methane', 0.0005, 0.05, { DangerousOxygen: 2, DangerousPPMOxygen: 500 })] }),
  traceOver: earthlike({ AtmosPress: 1.0006, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 19.99), gas(7, 'Nitrogen', 0.8, 79.95), gas(METHANE_ID, 'Methane', 0.0006, 0.06, { DangerousOxygen: 2, DangerousPPMOxygen: 500 })] }),
  eccentric: airless({ Eccentricity: 0.3 }),
  moon: earthlike({ BodyClass: 2, ParentOrbitalDistance: 1, ParentEccentricity: 0.2, ParentYear: 8760, HydroExt: 30, HydroID: 4, AtmosPress: 0, SurfaceTemp: 250, Atmosphere: [] }),
  moonLocked: earthlike({ BodyClass: 2, ParentOrbitalDistance: 1, ParentEccentricity: 0.2, ParentYear: 8760, HydroExt: 30, HydroID: 4, AtmosPress: 0, SurfaceTemp: 250, Atmosphere: [], TidalLock: 1 }),
  // Temperature and water both stand at exactly 2; with the temperature at 2.00004 they tie at the four decimals only.
  exactTie: earthlike({ HydroExt: 0, HydroID: 1, SurfaceTemp: 198 }),
  roundTie: earthlike({ HydroExt: 0, HydroID: 1, SurfaceTemp: 197.9988 }),
  gasGiant: earthlike({ BodyTypeID: 4 }),
  fixedBody: airless({ FixedBody: 1 }),
  tooHeavy: airless({ Gravity: 2 }),
  tooLight: airless({ Gravity: 0.05 }),
  // Methane (danger 2) hides the missing breathing gas: removing it reveals the breathing penalty.
  hidden: earthlike({ SurfaceTemp: 287.5, Atmosphere: [gas(7, 'Nitrogen', 0.95, 95), gas(METHANE_ID, 'Methane', 0.05, 5, METHANE)] }),
  // 4.05 atm that the first operations hold at the species' pressure limit and the water step lifts over it again; low gravity stands at 1 throughout.
  floorSwing: earthlike({ BaseTemp: 200, SurfaceTemp: 300, Gravity: 0.4, HydroExt: 10, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // The same air on an eccentric orbit at normal gravity: water condenses over 2.5 years after the last operation.
  condensing: earthlike({ BaseTemp: 200, SurfaceTemp: 300, StarLuminosity: (200 / 255) ** 4, Eccentricity: 0.4, HydroExt: 10, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // A present-distance base below the circular reference makes the stage's changing dampening observable.
  seasonal: earthlike({ BaseTemp: 200, SurfaceTemp: 300, StarLuminosity: (220 / 255) ** 4, Eccentricity: 0.4, HydroExt: 10, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // The plan only removes the methane, yet its target holds 20 % water.
  removalOnly: earthlike({ BaseTemp: 300, SurfaceTemp: 245.5, Gravity: 0.4, HydroExt: 0, HydroID: 1, AtmosPress: 4.05, Atmosphere: crowded(0.8, 1, 2, 0.05, 0.2) }),
  // Condensation takes 0.05 years, under the 0.1 the plan's wait text needs.
  shortSettle: earthlike({ BaseTemp: 200, SurfaceTemp: 300, HydroExt: 19.8, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // No gas operation and no settling, but the target holds 20 % water: the planner's cost after terraforming is 1 against 2.
  noOperation: earthlike({ BaseTemp: 300, SurfaceTemp: 240, StarLuminosity: (300 / 255) ** 4, Gravity: 0.4, HydroExt: 0, HydroID: 4, AtmosPress: 4, Atmosphere: crowded(0.8, 1, 2, 0, 0.2).filter((row) => row.AtmosGasID !== 1) }),
  // A methane breather's world: 286 K is 220 K times 1 + 0.1 + the 0.2 atm of methane, a greenhouse gas, so the air suits and only the 50 % of liquid water (5, its extent times 0.1) is paid for; the same world under an ice sheet pays nothing, as a methane breather has no ice term.
  wetMethane: earthlike({ BaseTemp: 220, SurfaceTemp: 286, Atmosphere: [gas(METHANE_ID, 'Methane', 0.2, 20, METHANE), gas(7, 'Nitrogen', 0.8, 80)] }),
  iceMethane: earthlike({ BaseTemp: 220, SurfaceTemp: 286, HydroID: 4, Atmosphere: [gas(METHANE_ID, 'Methane', 0.2, 20, METHANE), gas(7, 'Nitrogen', 0.8, 80)] }),
  // Methane held out of the air by the cold (frozen out, freezing at 250 K) that the plan's 288 K thaws, and the same where it freezes at 400 K and stays frozen.
  frozenThaws: earthlike({ BaseTemp: 200, SurfaceTemp: 220, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.75, 75), gas(METHANE_ID, 'Methane', 0.05, 5, { ...METHANE, FreezingPoint: 250, FrozenOut: 1 })] }),
  frozenStays: earthlike({ BaseTemp: 200, SurfaceTemp: 220, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.75, 75), gas(METHANE_ID, 'Methane', 0.05, 5, { ...METHANE, FreezingPoint: 400, FrozenOut: 1 })] }),
  // Methane at 0.04 % of the air, under its 0.05 % limit, in air that needs warming: it is benign, so the plan neither removes it nor raises it.
  benignSide: earthlike({ BaseTemp: 200, SurfaceTemp: 220.044, AtmosPress: 1.0004, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 19.99), gas(7, 'Nitrogen', 0.8, 79.97), gas(METHANE_ID, 'Methane', 0.0004, 0.04, METHANE)] }),
}

deepFreeze(BODIES)

// ---- The world: the modules and the component as shipped, or with one planted fault ----------------------------------
const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

const worldOf = (mutation = null) => {
  const text = { ...ORIGINALS }

  if (mutation) {
    text[mutation.target] = patched(FILES[mutation.target], ORIGINALS[mutation.target], mutation.from, mutation.to)
  }

  const modules = memo(() => loadUtilities(['habitability', 'terraforming', 'terraform-limits', 'provenance'], { sources: { habitability: text.habitability, terraforming: text.terraforming, 'terraform-limits': text.limits } }).then((loaded) => ({ habitability: loaded.habitability, terraforming: loaded.terraforming, limits: loaded['terraform-limits'], provenance: loaded.provenance })))
  const component = memo(() => loadPage('components/planner/BodyDetail', { stubs: { 'lodash/groupBy': GROUP_BY }, modules: { 'utilities/appearance': APPEARANCE }, sources: { 'utilities/habitability': text.habitability, 'utilities/terraforming': text.terraforming, 'utilities/terraform-limits': text.limits, 'components/planner/BodyDetail': text.vue } }))
  const cache = new Map()

  // The assessment and the stages of a fixture body at a colonisation skill; `stages` is null where the body has no plan.
  const staged = async (name, skill = 1, row = SPECIES_ROW) => {
    const key = `${name}/${skill}/${row.BreatheID}`

    if (!cache.has(key)) {
      const { habitability, terraforming, limits } = await modules()
      const species = habitability.speciesLimits(row)
      const body = BODIES[name]
      const assessment = terraforming.assessTerraforming(body, species, skill, gasInfo)

      cache.set(key, { name, body, species, assessment, result: limits.terraformStages({ assessment, body, species, skill, gasInfo }) })
    }

    return cache.get(key)
  }

  // The component with the figures of one fixture body as the page gives them.
  const detail = async (name, skill = 1) => {
    const { body, species, assessment } = await staged(name, skill)
    const options = await component()

    return instantiate(options, { $store: { getters: {}, state: {} }, data: { item: { body }, shown: { species, assessment }, rules: { ColonizationSkill: skill }, gases: GAS_LIST, separator: ',', terraformCapacity: 1 } })
  }

  return { text, modules, component, staged, detail }
}

// ---- The checks ------------------------------------------------------------------------------------------------------
const CHECKS = []

const check = (name, description, run) => CHECKS.push({ name, description, run })

const keysOf = (list) => list.map(({ key }) => key)

const round4 = (value) => Math.round(value * 10000) / 10000

// The stages of a fixture that has a plan.
const stagesOf = async (w, name, skill = 1) => {
  const found = await w.staged(name, skill)

  assert.ok(found.result, `${name} has a plan`)

  return { ...found, stages: found.result.stages }
}

const PLANNED = ['liveable', 'airless', 'airlessLow', 'toxic', 'toxicLow', 'frozenToxic', 'thick', 'thickLocked', 'thin', 'trace', 'traceOver', 'eccentric', 'moon', 'moonLocked', 'exactTie', 'roundTie', 'hidden', 'floorSwing', 'condensing', 'removalOnly', 'shortSettle', 'noOperation']

const planned = async (w) => {
  const found = await Promise.all(PLANNED.map((name) => w.staged(name)))

  return found.filter(({ result }) => result)
}

check('start', 'the first stage prices the body as the body detail does: the same cost factors at now, periapsis and apoapsis, saved frozen-out flags and all', async (w) => {
  const { habitability } = await w.modules()
  const species = habitability.speciesLimits(SPECIES_ROW)
  let compared = 0

  for (const name of Object.keys(BODIES)) {
    const body = BODIES[name]
    const cost = habitability.colonyCost(body, species, 1)

    if (!cost.colonisable) {
      continue
    }

    const swings = body.Eccentricity > 0 || body.BodyClass === 2
    const { distance, eccentricity } = habitability.orbitOf(body)
    const now = habitability.costFactors(body, species, body.SurfaceTemp, false)
    const periapsis = swings ? habitability.costFactors(body, species, habitability.temperatureAtDistance(body, distance * (1 - eccentricity)), false) : now
    const apoapsis = swings ? habitability.costFactors(body, species, habitability.temperatureAtDistance(body, distance * (1 + eccentricity)), false) : now

    assert.deepEqual(cost.factors, now.factors, `${name}: the cost's factors are those of now`)
    assert.deepEqual(cost.raws, { current: now.cost, periapsis: periapsis.cost, apoapsis: apoapsis.cost }, `${name}: the cost's three points`)
    assert.equal(cost.raw, Math.max(now.cost, periapsis.cost, apoapsis.cost), `${name}: the worst point`)

    const found = await w.staged(name)

    if (!found.result) {
      continue
    }

    const [start] = found.result.stages

    compared += 1
    assert.equal(start.kind, 'start')
    assert.deepEqual(start.points.current.factors, now.factors, `${name}: stage 0 factors now`)
    assert.deepEqual(start.points.periapsis.factors, periapsis.factors, `${name}: stage 0 factors at periapsis`)
    assert.deepEqual(start.points.apoapsis.factors, apoapsis.factors, `${name}: stage 0 factors at apoapsis`)
    assert.deepEqual({ current: start.cost.current, periapsis: start.cost.periapsis, apoapsis: start.cost.apoapsis }, found.assessment.cost.raws, `${name}: stage 0 costs are the body detail's`)
    assert.equal(start.cost.raw, found.assessment.cost.raw, `${name}: stage 0 worst cost`)
    assert.equal(start.cost.worst, found.assessment.cost.worst, `${name}: stage 0 cost after the skill`)
    assert.equal(start.temperature, body.SurfaceTemp, `${name}: stage 0 temperature as saved`)
    assert.equal(start.pressure, body.AtmosPress, `${name}: stage 0 pressure as saved`)
    assert.equal(start.hydroExt, body.HydroExt, `${name}: stage 0 water as saved`)
  }

  assert.ok(compared >= 10, `${compared} bodies with a plan compared`)
})

check('dampening', 'every planned stage recomputes the stored climate from its own pressure and ocean, the stage cost uses the dampened lunar extreme, and the plan reads its target body\'s swing', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, MaximumPressure: 10 })
  const body = earthlike({ Eccentricity: 0.6, AtmosPress: 5, HydroExt: 100, BaseTemp: 187, SurfaceTemp: 280.5, StarLuminosity: (187 / 255) ** 4, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 4), gas(7, 'Nitrogen', 4.8, 96)] })

  // With f = 0.8 the orbit stays between 268.75 and 313.10 K; without it the hot end exceeds 443 K.
  assert.equal(terraforming.assessTerraforming(body, species, 1, gasInfo).outcome, 'done')
  const { stages } = await stagesOf(w, 'seasonal')

  for (const stage of stages.slice(1)) {
    const state = stage.body
    const gh = Math.min(3, 1 + state.AtmosPress / 10 + state.Atmosphere.reduce((total, gas) => total + (gas.GHGas ? gas.GasAtm : 0), 0))
    const agh = Math.min(3, 1 + state.DustLevel / 20000 + state.Atmosphere.reduce((total, gas) => total + (!gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0), 0))
    const factor = (Math.min(0.5, state.AtmosPress / 10) + Math.min(0.3, state.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(state.Year / 8760))
    const circular = 255 / Math.sqrt(state.OrbitalDistance / Math.sqrt(state.StarLuminosity))
    const expected = Math.max(4, (state.BaseTemp * (1 - factor) + circular * factor) * gh * state.Albedo / agh)

    assert.ok(Math.abs(stage.temperature - expected) < 1e-9, `stage ${stage.index}: the stored climate follows the stage's dampening`)
  }

  const moon = (await stagesOf(w, 'moon')).stages[0]
  const apoapsis = (255 / Math.sqrt(1.2) * 0.91 + 255 * 0.09)

  assert.ok(Math.abs(moon.points.apoapsis.factors.temperature - (258 - apoapsis) / 30) < 1e-9, 'the stage cost uses the dampened lunar extreme')

  // The plan reports the swing its target body actually has, from the same prediction the stages price; the saved body's ends are not it.
  const seasonal = await w.staged('seasonal')
  const ends = habitability.temperaturePoints(terraforming.terraformedBody(seasonal.body, seasonal.species, seasonal.assessment.plan, gasInfo))
  const cold = Math.min(ends.periapsis, ends.apoapsis)
  const hot = Math.max(ends.periapsis, ends.apoapsis)

  assert.ok(Math.abs(seasonal.assessment.plan.target.temperatureLow - cold) < 1e-9, `the plan reports its target's cold end: ${seasonal.assessment.plan.target.temperatureLow}`)
  assert.ok(Math.abs(seasonal.assessment.plan.target.temperatureHigh - hot) < 1e-9, `the plan reports its target's hot end: ${seasonal.assessment.plan.target.temperatureHigh}`)
  assert.equal(seasonal.assessment.plan.partial, cold < seasonal.species.MinimumTemperature || hot > seasonal.species.MaximumTemperature, 'partial exactly when the target cannot hold the range')
})

check('position', 'the liveability verdict reads the dampened swing at the semi-major axis, not where the body is now', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, MaximumPressure: 10 })
  const orbit = { Eccentricity: 0.6, AtmosPress: 5, HydroExt: 100, StarLuminosity: (187 / 255) ** 4, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 4), gas(7, 'Nitrogen', 4.8, 96)] }
  const readings = [0.4, 1, 1.6].map((present) => {
    const climate = earthlike({ ...orbit, BaseTemp: 187 / Math.sqrt(present), DistanceToParent: present })
    const body = { ...climate, SurfaceTemp: habitability.surfaceTemperature(climate, 1.5, 1) }
    const points = habitability.temperaturePoints(body)

    return { present, temperature: body.SurfaceTemp, periapsis: points.periapsis, apoapsis: points.apoapsis, outcome: terraforming.assessTerraforming(body, species, 1, gasInfo).outcome }
  })

  // f = 0.8 makes the priced swing 268.750944–313.101888 K at every position, inside the species' 258–318 K range.
  assert.deepEqual(readings.map(({ outcome }) => outcome), ['done', 'done', 'done'], 'one body and orbit read the same at periapsis, the semi-major axis and apoapsis')
  assert.equal(new Set(readings.map(({ temperature }) => temperature.toFixed(6))).size, 3, 'the three positions carry three different present temperatures')
  assert.equal(new Set(readings.map(({ periapsis }) => periapsis.toFixed(6))).size, 1, 'the priced periapsis does not depend on where the body is now')
  assert.equal(new Set(readings.map(({ apoapsis }) => apoapsis.toFixed(6))).size, 1, 'the priced apoapsis does not depend on where the body is now')
  assert.deepEqual(readings.map(({ present }) => present), [0.4, 1, 1.6])
})

// Terra's phase probe (AE-302-02 r2): an eccentric wet body whose apoapsis crosses the ice transition. The dampened ratio alone keeps that end above the species' minimum and would call the body liveable; the phase-aware prediction, which the colony cost prices, does not.
check('phase', 'the liveability verdict reads the phase-aware extremes the colony cost prices, an ice-albedo step included', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, IdealTemperature: 310, TemperatureDeviation: 75 })
  const body = earthlike({ BaseTemp: 255, SurfaceTemp: 280.5, Albedo: 1, StarLuminosity: 1, Eccentricity: 0.5, OrbitalDistance: 1, Year: 8760, HydroExt: 50, HydroID: 3, AtmosPress: 1, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.8, 80)] })
  const { distance, eccentricity } = habitability.orbitOf(body)
  const periapsis = habitability.temperatureAtDistance(body, distance * (1 - eccentricity))
  const apoapsis = habitability.temperatureAtDistance(body, distance * (1 + eccentricity))
  const points = habitability.temperaturePoints(body)
  const cost = habitability.colonyCost(body, species, 1)
  const factor = habitability.orbitalTemperatureDampening(body)
  const ratio = (swing) => body.SurfaceTemp * (swing * (1 - factor) + factor)
  const ratioApoapsis = ratio(Math.sqrt(distance / (distance * (1 + eccentricity))))
  const assessment = terraforming.assessTerraforming(body, species, 1, gasInfo)

  assert.ok(Math.abs(periapsis - 367.64017818423986) < 1e-9, `periapsis ${periapsis}`)
  assert.ok(Math.abs(apoapsis - 223.7533080967201) < 1e-9, `apoapsis ${apoapsis}`)
  assert.deepEqual({ current: points.current, periapsis: points.periapsis, apoapsis: points.apoapsis }, { current: body.SurfaceTemp, periapsis, apoapsis }, 'the verdict reads the priced extremes')
  assert.deepEqual(cost.raws, { current: 0, periapsis: 0, apoapsis: 0.15 }, 'the priced extremes')
  assert.ok(ratioApoapsis > species.MinimumTemperature && ratioApoapsis > apoapsis, `the ratio form keeps the frozen end liveable: ${ratioApoapsis} K`)
  assert.notEqual(assessment.outcome, 'done', 'a body whose priced apoapsis is outside the species range is not liveable')
  assert.equal(assessment.outcome, 'yes', 'a cooler aim repairs the phase-aware swing rather than calling the saved body done')
  assert.ok(assessment.plan && !assessment.plan.partial, 'the re-aimed full plan is returned')
  const target = terraforming.terraformedBody(body, species, assessment.plan, gasInfo)
  const targetPoints = habitability.temperaturePoints(target)

  Object.values(targetPoints).forEach((temperature) => assert.ok(temperature >= species.MinimumTemperature && temperature <= species.MaximumTemperature, `the phase-aware target fits: ${temperature}`))
  assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 })
})

// Terra's r2 counterexample: ideal-centred warming overshoots periapsis, but a cooler target fits the complete phase-aware swing.
check('targetSearch', 'the atmosphere search re-aims within the species range to find a free whole-orbit target', async (w) => {
  const { habitability, terraforming, limits } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, MaximumPressure: 10 })
  const body = earthlike({ BaseTemp: 180, SurfaceTemp: 198, StarLuminosity: (180 / 255) ** 4, Eccentricity: 0.25, DistanceToParent: 1, HydroID: 4 })
  const witness = terraforming.planTerraforming(body, { ...species, IdealTemperature: 280 }, gasInfo)
  const witnessBody = terraforming.terraformedBody(body, species, witness, gasInfo)
  const witnessPoints = habitability.temperaturePoints(witnessBody)

  assert.ok(Math.abs(witnessPoints.apoapsis - 258.794239) < 1e-6, `280 K witness cold end: ${witnessPoints.apoapsis}`)
  assert.ok(Math.abs(witnessPoints.periapsis - 311.111062) < 1e-6, `280 K witness hot end: ${witnessPoints.periapsis}`)
  assert.deepEqual(habitability.colonyCost(witnessBody, species, 1, true).raws, { current: 0, periapsis: 0, apoapsis: 0 }, 'a feasible alternative exists without changing the species range')
  const assessment = terraforming.assessTerraforming(body, species, 1, gasInfo)

  assert.equal(assessment.outcome, 'yes', 'the planner finds a free whole-orbit plan instead of stopping at the ideal-centred partial plan')
  assert.ok(assessment.plan && !assessment.plan.partial, 'the complete plan is returned')
  const nearest = terraforming.planTerraforming(body, { ...species, IdealTemperature: 286.25 }, gasInfo)

  assert.ok(nearest && !nearest.partial, 'the nearest feasible lattice aim is 286.25 K')
  assert.deepEqual(assessment.plan.target, nearest.target, 'nearest-first selection returns the 286.25 K target, not a farther feasible aim')
  const target = terraforming.terraformedBody(body, species, assessment.plan, gasInfo)
  const points = habitability.temperaturePoints(target)

  Object.values(points).forEach((temperature) => assert.ok(temperature >= species.MinimumTemperature && temperature <= species.MaximumTemperature, `every priced point fits: ${temperature}`))
  assert.ok(target.AtmosPress <= species.MaximumPressure, 'the re-aimed atmosphere respects the pressure limit')
  assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 })
  const stages = limits.terraformStages({ assessment, body, species, skill: 1, gasInfo }).stages

  const last = stages[stages.length - 1].cost

  assert.deepEqual({ current: last.current, periapsis: last.periapsis, apoapsis: last.apoapsis }, assessment.after.raws, 'the final stage prices the selected target')
})

// Sol's r3 counterexample: the atmosphere/ice-albedo response is not ordered, so side pruning discards the feasible 238–244 K branch inside the original 205–265 K limits.
check('targetSearchNonMonotone', 'the bounded search selects a full priced target across a non-monotone atmosphere and ice-albedo response', async (w) => {
  const { habitability, terraforming, limits } = await w.modules()
  const species = habitability.speciesLimits(SPECIES_ROW)
  const body = earthlike({ BaseTemp: 300, SurfaceTemp: 330, Albedo: 0.7, StarLuminosity: (300 / 255) ** 4, Eccentricity: 0.3, DistanceToParent: 1, Year: 2000, HydroExt: 70, HydroID: 3, AtmosPress: 4, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 5), gas(7, 'Nitrogen', 3.8, 95)] })
  const plan = terraforming.planTerraforming(body, species, gasInfo)

  assert.ok(plan && !plan.partial, 'the public planner finds a full plan without changing the 258–318 K bounds')
  const assessment = terraforming.assessTerraforming(body, species, 1, gasInfo)

  assert.equal(assessment.outcome, 'yes', 'the public assessment selects the full plan rather than rejecting the worsening ideal fallback')
  assert.deepEqual(assessment.plan, plan, 'the assessment selects the public planner\'s full plan')
  const target = terraforming.terraformedBody(body, species, plan, gasInfo)
  const points = habitability.temperaturePoints(target)

  Object.values(points).forEach((temperature) => assert.ok(temperature >= species.MinimumTemperature && temperature <= species.MaximumTemperature, `the selected priced temperature fits 258–318 K: ${temperature}`))
  assert.ok(target.AtmosPress <= species.MaximumPressure, 'the selected atmosphere obeys the pressure cap')
  assert.equal(plan.target.temperatureLow, Math.min(...Object.values(points)))
  assert.equal(plan.target.temperatureHigh, Math.max(...Object.values(points)))
  assert.deepEqual(habitability.colonyCost(target, species, 1, true).raws, { current: 0, periapsis: 0, apoapsis: 0 }, 'the raw target costs are zero at every priced point')
  assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 })
  const stages = limits.terraformStages({ assessment, body, species, skill: 1, gasInfo }).stages
  const last = stages[stages.length - 1].cost

  assert.deepEqual({ current: last.current, periapsis: last.periapsis, apoapsis: last.apoapsis }, { current: 0, periapsis: 0, apoapsis: 0 }, 'the ending stage costs are zero at every priced point')
})

check('targetPressureBracket', 'an ideal blocked by the pressure limit still searches for a reachable cooler whole-orbit target', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, MaximumPressure: 1.25 })
  const body = earthlike({ BaseTemp: 120, SurfaceTemp: 132, StarLuminosity: (120 / 255) ** 4, Eccentricity: 0.01, DistanceToParent: 1, HydroID: 4 })
  const witness = terraforming.planTerraforming(body, { ...species, IdealTemperature: 260 }, gasInfo)

  assert.ok(witness && !witness.partial, 'a cooler full plan is attainable under the pressure cap')
  const assessment = terraforming.assessTerraforming(body, species, 1, gasInfo)

  assert.equal(assessment.outcome, 'yes', 'null pressure-limited trials do not terminate the search for a reachable target')
  assert.ok(assessment.plan && !assessment.plan.partial)
  assert.ok(assessment.plan.target.pressure <= species.MaximumPressure)
  assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 })
})

check('targetSearchImpossible', 'a bounded search with no full target retains a temperature-limited plan instead of accepting only its hot end', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, MaximumPressure: 10 })
  const body = earthlike({ BaseTemp: 180, SurfaceTemp: 198, StarLuminosity: (180 / 255) ** 4, Eccentricity: 0.35, DistanceToParent: 1, HydroID: 4 })
  const plan = terraforming.planTerraforming(body, species, gasInfo)
  const target = terraforming.terraformedBody(body, species, plan, gasInfo)
  const points = habitability.temperaturePoints(target)

  assert.ok(plan.partial, 'no whole-orbit target was found in the bounded search')
  assert.ok(Math.min(...Object.values(points)) < species.MinimumTemperature || Math.max(...Object.values(points)) > species.MaximumTemperature, 'the retained partial plan has a genuinely priced temperature blocker')
  assert.notEqual(terraforming.assessTerraforming(body, species, 1, gasInfo).outcome, 'yes', 'a one-extreme success never becomes an all-orbit-free result')
})

check('targetGasPhase', 'the target search prices a greenhouse gas freezing at apoapsis instead of accepting a phase-insensitive full plan', async (w) => {
  const { habitability, terraforming, limits } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, MaximumPressure: 10 })
  const body = earthlike({ BaseTemp: 180, SurfaceTemp: 198, StarLuminosity: (180 / 255) ** 4, Eccentricity: 0.25, DistanceToParent: 1, HydroID: 4 })
  const phasedGasInfo = (id) => id === 20 ? { ...gasInfo(id), FreezingPoint: 290 } : gasInfo(id)
  const assessment = terraforming.assessTerraforming(body, species, 1, phasedGasInfo)

  assert.ok(assessment.plan && assessment.plan.partial, 'no target keeps the cold end warm when the added greenhouse gas freezes')
  assert.ok(assessment.after.raws.apoapsis > 0, 'the frozen greenhouse gas has a priced cold-end penalty')
  const target = terraforming.terraformedBody(body, species, assessment.plan, phasedGasInfo)

  assert.ok(habitability.temperaturePoints(target).apoapsis < species.MinimumTemperature, 'the cold-end temperature is the one the cost prices')
  const stages = limits.terraformStages({ assessment, body, species, skill: 1, gasInfo: phasedGasInfo }).stages

  assert.equal(stages[stages.length - 1].cost.apoapsis, assessment.after.raws.apoapsis, 'the ending stage prices the same gas phase')
})

check('bars', 'the factor bars of the body detail flag the factors the first stage names, every one of a tie', async (w) => {
  const { habitability } = await w.modules()

  for (const name of PLANNED) {
    const found = await w.staged(name)

    if (!found.result) {
      continue
    }

    const vm = await w.detail(name)
    const flagged = vm.factors.filter((bar) => bar.limiting).map((bar) => bar.key)
    const expected = keysOf(habitability.limitingFactors(found.assessment.cost.factors))

    assert.deepEqual(flagged, expected, `${name}: flagged bars`)
    assert.deepEqual(flagged, keysOf(habitability.limitingFactors(found.result.stages[0].points.current.factors)), `${name}: the first stage's factors now`)
    assert.deepEqual(vm.factors.map((bar) => bar.key), habitability.FACTORS.map((factor) => factor.key))
  }

  assert.deepEqual((await w.detail('airless')).factors.filter((bar) => bar.limiting).map((bar) => bar.key), ['breathable', 'hydrosphere'], 'the airless body ties the breathing gas and the water')
})

check('ties', 'equal limiting factors are all named: exact ties, ties at the game\'s four decimals, ties on either side of the limit and the next limit', async (w) => {
  const { habitability } = await w.modules()
  const none = { temperature: 0, pressure: 0, danger: 0, breathable: 0, hydrosphere: 0, gravity: 0 }

  assert.deepEqual(habitability.limitingFactors(none), [])
  assert.deepEqual(keysOf(habitability.limitingFactors({ ...none, breathable: 2, hydrosphere: 2 })), ['breathable', 'hydrosphere'])
  assert.deepEqual(keysOf(habitability.limitingFactors({ ...none, temperature: 1.00004, gravity: 1 })), ['temperature', 'gravity'], 'equal at four decimals')
  assert.deepEqual(keysOf(habitability.limitingFactors({ ...none, temperature: 1.0001, gravity: 1 })), ['temperature'], 'differing at four decimals')
  assert.ok(keysOf(habitability.limitingFactors({ ...none, pressure: 2, danger: 2, hydrosphere: 1 })).includes(habitability.limitingFactor({ ...none, pressure: 2, danger: 2, hydrosphere: 1 }).key), 'the single limiting factor is one of the tied')

  const airlessStart = (await stagesOf(w, 'airless')).stages[0]

  assert.deepEqual(keysOf(airlessStart.limiting), ['breathable', 'hydrosphere'])
  assert.deepEqual(airlessStart.limiting.map(({ value }) => value), [2, 2])
  assert.deepEqual(keysOf(airlessStart.next), ['temperature'])
  assert.ok(Math.abs(airlessStart.next[0].value - 8 / 30) < 1e-12, 'the next limit is the temperature, 8 K under the range over its deviation')

  const exact = (await stagesOf(w, 'exactTie')).stages[0]

  assert.deepEqual(keysOf(exact.limiting), ['temperature', 'hydrosphere'], 'temperature 2 and water 2')
  assert.deepEqual(exact.limiting.map(({ value }) => value), [2, 2])

  const rounded = (await stagesOf(w, 'roundTie')).stages[0]

  assert.deepEqual(keysOf(rounded.limiting), ['temperature', 'hydrosphere'], 'temperature 2.00004 and water 2')
  assert.notEqual(rounded.limiting[0].value, rounded.limiting[1].value)

  const low = (await stagesOf(w, 'toxicLow')).stages[0]

  assert.deepEqual(keysOf(low.limiting), ['danger'])
  assert.deepEqual(keysOf(low.next), ['hydrosphere', 'gravity'], 'water 1 and gravity 1 tie as the next limit')
  assert.deepEqual(low.next.map(({ value }) => value), [1, 1])
  assert.deepEqual(low.next.map(({ fixed }) => fixed), [false, true], 'only gravity is fixed')
})

check('operations', 'each gas operation names the limits after it, what it cleared and what it revealed, with ties, on hand-worked plans', async (w) => {
  const sequence = async (name) => {
    const { stages } = await stagesOf(w, name)

    return {
      stages,
      kinds: stages.map(({ kind }) => kind),
      steps: stages.filter(({ step }) => step).map(({ step }) => step.key),
      limiting: stages.map(({ limiting }) => keysOf(limiting)),
      raw: stages.map(({ cost }) => cost.raw),
      revealed: stages.map(({ revealed }) => revealed),
      cleared: stages.map(({ cleared }) => cleared),
    }
  }

  // Methane at 5 % (danger 2) over 10 % water (1): removing the methane lowers the cost to the water's 1, which the 20 % water of the settling ends.
  const toxic = await sequence('toxic')

  assert.deepEqual(toxic.kinds, ['start', 'step', 'step', 'step', 'settle'])
  assert.deepEqual(toxic.steps, ['toxic', 'water', 'greenhouse'])
  assert.deepEqual(toxic.limiting, [['danger'], ['hydrosphere'], ['hydrosphere'], ['hydrosphere'], []])
  assert.deepEqual(toxic.raw, [2, 1, 1, 1, 0])
  assert.deepEqual(toxic.revealed, [[], ['hydrosphere'], [], [], []])
  assert.deepEqual(toxic.cleared, [[], ['danger'], [], [], ['hydrosphere']])
  assert.deepEqual(keysOf(toxic.stages[0].next), ['hydrosphere'])

  // A cold bare body: the breathing gas and the water tie at 2. Water vapour does not touch the tie; oxygen at its minimum clears the breathing gas; only the settling of the water ends the cost.
  const bare = await sequence('airless')

  assert.deepEqual(bare.kinds, ['start', 'step', 'step', 'step', 'step', 'settle'])
  assert.deepEqual(bare.steps, ['water', 'breathable', 'greenhouse', 'neutral'])
  assert.deepEqual(bare.limiting, [['breathable', 'hydrosphere'], ['breathable', 'hydrosphere'], ['hydrosphere'], ['hydrosphere'], ['hydrosphere'], []])
  assert.deepEqual(bare.raw, [2, 2, 2, 2, 2, 0])
  assert.deepEqual(bare.cleared, [[], [], ['breathable'], [], [], ['hydrosphere']])

  // Oxygen at its minimum is a third of the air it is added to: the breathing gas keeps limiting, by its share, until the neutral gas dilutes it.
  const thin = await sequence('thin')

  assert.deepEqual(thin.steps, ['water', 'breathable', 'greenhouse', 'neutral'])
  assert.deepEqual(thin.limiting, [['breathable'], ['breathable'], ['breathable'], ['breathable'], []])
  assert.deepEqual(thin.cleared[4], ['breathable'])

  // A thick cold-blooded air: warming the body before the nitrogen is removed raises the cost, and removing the nitrogen reveals the water that was tied with the pressure as the next limit.
  const heavy = await sequence('thick')

  assert.deepEqual(heavy.steps, ['water', 'breathable', 'greenhouse', 'neutral'])
  assert.deepEqual(heavy.limiting, [['temperature'], ['temperature'], ['temperature'], ['temperature'], ['hydrosphere'], []])
  assert.ok(heavy.raw[3] > heavy.raw[0], 'an operation can raise the cost')
  assert.deepEqual(keysOf(heavy.stages[0].next), ['pressure', 'breathable', 'hydrosphere'], 'pressure 2, the hidden breathing penalty 2 and water 2 tie as the next limit')
  assert.deepEqual(heavy.revealed[4], ['hydrosphere'])
  assert.deepEqual(heavy.cleared[4], ['temperature'])

  // The orbit: the limit can stand at a point other than now.
  const swing = (await stagesOf(w, 'eccentric')).stages
  const last = swing[swing.length - 1]

  assert.deepEqual(keysOf(last.limiting), ['temperature'])
  assert.deepEqual(last.limiting[0].at, ['periapsis'])
  assert.ok(last.points.current.factors.temperature < last.limiting[0].value, 'not the temperature now')

  const moon = (await stagesOf(w, 'moon')).stages[2]

  assert.deepEqual(keysOf(moon.limiting), ['temperature'])
  assert.deepEqual(moon.limiting[0].at, ['apoapsis'])

  // Methane (danger 2) hides the missing breathing gas: the next limit is the breathing penalty, and the first operation reveals it.
  const hidden = await sequence('hidden')

  assert.equal(hidden.stages[0].points.current.factors.breathable, 0, 'the saved factors still leave the hidden penalty out')
  assert.deepEqual(hidden.limiting.slice(0, 2), [['danger'], ['breathable']])
  assert.deepEqual(keysOf(hidden.stages[0].next), ['breathable'])
  assert.deepEqual(hidden.stages[0].next.map(({ value }) => value), [2])
  assert.deepEqual(hidden.revealed[1], ['breathable'])
  assert.deepEqual(hidden.cleared[1], ['danger'])

  // A limit that another factor only rises above is not cleared: the water step lifts the pressure over the species' limit while the low gravity stands.
  const swung = await sequence('floorSwing')

  assert.deepEqual(swung.steps, ['toxic', 'water', 'greenhouse'])
  assert.deepEqual(swung.limiting.slice(0, 3), [['pressure', 'danger'], ['hydrosphere', 'gravity'], ['pressure']])
  assert.deepEqual(swung.cleared[1], ['pressure', 'danger'])
  assert.deepEqual(swung.cleared[2], [])
  assert.deepEqual(swung.stages[2].overtaken, ['hydrosphere', 'gravity'])

  // A plan that only removes gas but whose target holds the water the plan settles to ends at the cost the Planner shows after terraforming.
  const removal = await stagesOf(w, 'removalOnly')

  assert.ok(removal.assessment.plan.steps.every((step) => step.key === 'toxic'))
  assert.equal(removal.stages[removal.stages.length - 1].cost.raw, removal.assessment.after.raw)
  assert.ok(removal.stages[0].cost.raw > removal.assessment.after.raw, 'the plan\'s target lowers the cost')
  assert.deepEqual(removal.stages.map(({ kind }) => kind), ['start', 'step', 'target'], 'the removal is one stage and the target another')
  assert.equal(removal.stages[1].hydroExt, removal.body.HydroExt, 'removing methane leaves the water as saved')
  assert.equal(removal.stages[1].cost.raw, 2, 'the water still limits after the removal')
  assert.deepEqual(keysOf(removal.stages[1].limiting), ['hydrosphere'])
  assert.ok(!removal.stages[1].cleared.includes('hydrosphere'), 'the removal does not clear the water')
  assert.deepEqual(keysOf(removal.stages[2].limiting), ['gravity'])
  assert.equal(removal.stages[2].step, null)

  // A plan with no gas operation and no settling still moves to its target: the stage after the start is labelled as the end state and carries no step.
  const idle = await stagesOf(w, 'noOperation')

  assert.deepEqual(idle.assessment.plan.steps, [])
  assert.equal(idle.assessment.plan.settling.process, 'Stable')
  assert.deepEqual(idle.stages.map(({ kind }) => kind), ['start', 'target'])
  assert.equal(idle.stages[1].step, null)
  assert.equal(idle.stages[0].cost.raw, 2, 'the saved start is kept')
  assert.equal(idle.stages[1].cost.raw, idle.assessment.after.raw)
  assert.equal(idle.stages[1].hydroExt, idle.assessment.plan.target.hydroExt)
  assert.equal((await w.detail('noOperation')).stageRows.length, 2)
})

check('stages', 'every stage of every plan is what its points say: the worst cost, the factors tied at it, the next below it, the changes from the stage before', async (w) => {
  const { habitability } = await w.modules()
  const species = habitability.speciesLimits(SPECIES_ROW)
  const found = await planned(w)

  assert.ok(found.length >= 10)

  for (const { name, result } of found) {
    let before = null

    result.stages.forEach((stage) => {
      const label = `${name} stage ${stage.index}`
      const distinct = ['current', 'periapsis', 'apoapsis'].filter((point) => point === 'current' || stage.points[point] !== stage.points.current)
      const costs = distinct.map((point) => stage.points[point].cost)
      const raw = Math.max(...costs)

      assert.equal(stage.cost.raw, raw, `${label}: the worst cost is the largest of the points`)

      const worstPoints = distinct.filter((point) => stage.points[point].cost === raw)
      const expected = []

      worstPoints.forEach((point) => {
        Object.entries(stage.points[point].factors).forEach(([key, value]) => {
          if (round4(value) === raw && raw > 0) {
            expected.push(`${key}@${point}`)
          }
        })
      })

      assert.deepEqual(stage.limiting.flatMap(({ key, at }) => at.map((point) => `${key}@${point}`)).sort(), expected.sort(), `${label}: the limiting factors are all those at the worst cost`)
      stage.limiting.forEach((entry) => assert.equal(round4(entry.value), raw, `${label}: ${entry.key} limits at the worst cost`))

      const limitingKeys = new Set(keysOf(stage.limiting))
      const breathing = habitability.breathingFails(stage.body, species)
      const standing = (point, key) => (key === 'breathable' && breathing && stage.points[point].factors.breathable === 0 ? 2 : stage.points[point].factors[key])
      const hides = (point, key) => key === 'breathable' && breathing && stage.points[point].factors.breathable === 0
      const below = distinct.flatMap((point) => Object.keys(stage.points[point].factors).filter((key) => !limitingKeys.has(key) && round4(standing(point, key)) > 0 && (hides(point, key) || round4(standing(point, key)) < raw)).map((key) => ({ key, point, value: round4(standing(point, key)) })))
      const top = Math.max(0, ...below.map(({ value }) => value))
      const nextExpected = top > 0 ? below.filter(({ value }) => value === top).map(({ key, point }) => `${key}@${point}`).sort() : []

      assert.deepEqual(stage.next.flatMap(({ key, at }) => at.map((point) => `${key}@${point}`)).sort(), nextExpected, `${label}: the next limits are the largest below, a hidden breathing penalty included`)
      stage.next.forEach((entry) => assert.ok(round4(entry.value) < raw || (entry.key === 'breathable' && round4(entry.value) <= raw), `${label}: ${entry.key} is below the limit`))
      assert.equal(stage.blocked, stage.limiting.length > 0 && stage.limiting.every(({ fixed }) => fixed), `${label}: blocked is all limits fixed`)
      assert.equal(Number.isFinite(stage.temperature) && Number.isFinite(stage.pressure) && Number.isFinite(stage.hydroExt), true, `${label}: finite figures`)

      const lost = before ? before.limiting.filter((entry) => !limitingKeys.has(entry.key)) : []
      const lowered = (entry) => entry.key !== 'gravity' && Math.max(...distinct.map((point) => round4(standing(point, entry.key)))) < round4(entry.value)

      assert.deepEqual(stage.revealed, before ? keysOf(stage.limiting).filter((key) => !before.limiting.some((entry) => entry.key === key)) : [], `${label}: revealed`)
      assert.deepEqual(stage.cleared, lost.filter(lowered).map(({ key }) => key), `${label}: cleared are those whose penalty fell`)
      assert.deepEqual(stage.overtaken, lost.filter((entry) => !lowered(entry)).map(({ key }) => key), `${label}: overtaken are those another factor rose above`)
      assert.ok(!stage.cleared.includes('gravity'), `${label}: a fixed factor is never cleared`)
      before = stage
    })
  }
})

check('end', 'the last stage is the plan\'s end state at any colonisation skill, and a stage per operation precedes it', async (w) => {
  const { habitability } = await w.modules()

  for (const skill of [1, 0.5]) {
    for (const name of PLANNED) {
      const found = await w.staged(name, skill)

      if (!found.result || !found.assessment.plan) {
        continue
      }

      const { stages } = found.result
      const last = stages[stages.length - 1]
      const { after } = found.assessment
      const label = `${name} at skill ${skill}`

      assert.deepEqual({ current: last.cost.current, periapsis: last.cost.periapsis, apoapsis: last.cost.apoapsis }, after.raws, `${label}: the end costs`)
      assert.equal(last.cost.worst, after.worst, `${label}: the end cost after the skill`)
      assert.deepEqual(keysOf(habitability.limitingFactors(last.points.current.factors)), keysOf(habitability.limitingFactors(after.factors)), `${label}: the end limit now`)
      assert.ok(stages.length >= found.assessment.plan.steps.length + 1, `${label}: a stage per operation`)
    }
  }
})

check('settle', 'the water extent changes only in the stage that settles it, any settling however short has a stage, and a plan with nothing to settle ends with its last operation', async (w) => {
  for (const name of PLANNED) {
    const found = await w.staged(name)

    if (!found.result) {
      continue
    }

    const { stages } = found.result
    const { plan } = found.assessment
    const settles = stages.filter(({ kind }) => kind === 'settle')
    const settling = plan.settling.process !== 'Stable' && plan.settling.years > 0

    assert.equal(settles.length, settling ? 1 : 0, `${name}: a settling stage exactly when the surface settles`)

    stages.filter(({ kind }) => kind === 'step').forEach((stage) => assert.equal(stage.hydroExt, found.body.HydroExt, `${name} stage ${stage.index}: the gas operation leaves the water as saved`))
    stages.filter(({ kind }) => kind === 'target').forEach((stage) => assert.equal(stage.step, null, `${name}: the target is no gas operation`))

    if (settles.length) {
      assert.equal(settles[0].hydroExt, plan.target.hydroExt, `${name}: the settled water is the plan's`)
      assert.equal(stages[stages.length - 1], settles[0], `${name}: settling is last`)
    }
  }

  const bare = (await stagesOf(w, 'airless')).stages

  assert.equal(bare[bare.length - 1].kind, 'settle')
  assert.equal(bare[bare.length - 2].hydroExt, 0)
  assert.equal(bare[bare.length - 1].hydroExt, 20)
  assert.equal(bare[bare.length - 1].cost.raw, 0)

  const thin = (await stagesOf(w, 'thin')).stages

  assert.deepEqual(thin.map(({ kind }) => kind), ['start', 'step', 'step', 'step', 'step'], 'water at 50 % needs no settling')

  const trace = await w.staged('trace')

  assert.equal(trace.assessment.outcome, 'done', 'a gas at exactly its dangerous share is not dangerous: the body needs no plan')
  assert.equal(trace.result, null, 'and has no stages')

  const over = await stagesOf(w, 'traceOver')

  assert.deepEqual([over.assessment.plan.steps[0].key, over.assessment.plan.steps[0].gasId], ['toxic', METHANE_ID], 'a gas just over its dangerous share is removed first')
  assert.deepEqual([over.stages[0].cost.raw, over.stages[1].cost.raw], [2, 0], 'it costs its rating before the removal and nothing after')

  const short = await stagesOf(w, 'shortSettle')

  assert.ok(short.assessment.plan.settling.years > 0 && short.assessment.plan.settling.years <= 0.1, 'a settling too short for the plan\'s wait text')
  assert.equal(short.stages[short.stages.length - 1].kind, 'settle')
  assert.equal(short.stages[short.stages.length - 2].hydroExt, 19.8, 'the last operation leaves the water as saved')
  assert.ok(short.stages[short.stages.length - 2].cost.raw > 0, 'the water still limits before it settles')
  assert.equal(short.stages[short.stages.length - 1].cost.raw, 0)
})

check('conservation', 'every gas operation, the last included, is priced on the atmosphere the operations so far leave, the pressure the sum of the gases as set, and only a settling or a target stage moves to the plan\'s end state', async (w) => {
  for (const name of PLANNED) {
    const found = await w.staged(name)

    if (!found.result) {
      continue
    }

    const { stages } = found.result
    const { plan } = found.assessment
    const gases = new Map(found.body.Atmosphere.map((gas) => [gas.AtmosGasID, gas.GasAtm]))

    plan.steps.forEach((step, index) => {
      if (Number.isFinite(step.set) && step.set > 0) {
        gases.set(step.gasId, step.set)
      } else {
        gases.delete(step.gasId)
      }

      const total = [...gases.values()].reduce((sum, atm) => sum + atm, 0)

      assert.ok(Math.abs(stages[index + 1].pressure - total) < 1e-9, `${name} stage ${index + 1}: the pressure is the sum of the gases the operations leave`)
    })
  }

  // Water that condenses in the settling leaves the air: the operations before it keep it.
  const { stages } = await stagesOf(w, 'condensing')
  const settle = stages[stages.length - 1]
  const lastGas = stages[stages.length - 2]

  assert.equal(settle.kind, 'settle')
  assert.ok(lastGas.pressure - settle.pressure > 0.1, 'the condensed water is still in the air before the settling')
  assert.ok(lastGas.cost.raw > settle.cost.raw, 'the settling lowers the cost the operations leave')
  assert.equal(lastGas.hydroExt, 10)
})

check('fixed', 'a fixed blocker is never promised removed: no stage clears it, the cost keeps its floor and a plan that reaches it says only a fixed factor remains', async (w) => {
  for (const [low, normal] of [['toxicLow', 'toxic'], ['airlessLow', 'airless']]) {
    const lowered = await stagesOf(w, low)
    const free = await stagesOf(w, normal)
    const { stages } = lowered
    const last = stages[stages.length - 1]

    assert.equal(lowered.result.lowGravity, true)
    assert.equal(lowered.result.floor, 1)
    assert.equal(free.result.lowGravity, false)
    assert.equal(free.result.floor, 0)
    assert.deepEqual(stages.map((stage) => stage.points.current.factors.gravity), stages.map(() => 1), `${low}: gravity stands at every stage`)
    stages.forEach((stage) => assert.ok(!stage.cleared.includes('gravity'), `${low} stage ${stage.index}: gravity is not cleared`))
    stages.forEach((stage) => assert.ok(stage.cost.raw >= 1, `${low} stage ${stage.index}: the cost stays at the floor`))
    assert.deepEqual(keysOf(last.limiting), ['gravity'], `${low}: only gravity remains`)
    assert.equal(last.limiting[0].fixed, true)
    assert.equal(last.blocked, true)
    assert.equal(last.cost.raw, 1)
    assert.equal(free.stages[free.stages.length - 1].cost.raw, 0, `${normal}: the same plan reaches 0 with the gravity to hold it`)
    assert.ok(stages.slice(0, -1).every((stage) => !stage.blocked || stage.limiting.every(({ fixed }) => fixed)))
  }

  // A fixed factor that another factor only rises above is overtaken, not cleared.
  const swung = await stagesOf(w, 'floorSwing')

  swung.stages.forEach((stage) => assert.ok(!stage.cleared.includes('gravity'), `floorSwing stage ${stage.index}: gravity is not cleared`))
  assert.ok(swung.stages.some((stage) => stage.overtaken.includes('gravity')), 'gravity is overtaken once')
  assert.deepEqual(swung.stages.map((stage) => stage.points.current.factors.gravity), swung.stages.map(() => 1))

  // The floor is 1 before the colonisation skill, and the cost shown is after it.
  const half = await stagesOf(w, 'toxicLow', 0.5)
  const halfRows = (await w.detail('toxicLow', 0.5))

  assert.equal(half.result.floor, 1)
  assert.equal(half.result.floorWorst, 0.5)
  half.stages.forEach((stage) => assert.ok(stage.cost.worst >= half.result.floorWorst, `skill 0.5 stage ${stage.index}: the shown cost keeps the skill-adjusted floor`))
  assert.equal(half.stages[half.stages.length - 1].cost.worst, half.result.floorWorst)
  assert.equal(halfRows.stageRows[halfRows.stageRows.length - 1].cost, halfRows.cost(half.result.floorWorst), 'the last row shows the floor')
  assert.ok(halfRows.limitNotes.some((note) => note.includes(halfRows.cost(half.result.floorWorst))), 'the note gives the floor as shown')

  // A tidal lock divides the temperature factor by 5 at every stage and is flagged as standing; a moon is never locked.
  const locked = await stagesOf(w, 'thickLocked')
  const twin = await stagesOf(w, 'thick')

  assert.equal(locked.result.tidalLock, true)
  assert.equal(twin.result.tidalLock, false)
  assert.equal((await stagesOf(w, 'moonLocked')).result.tidalLock, false)
  assert.equal(locked.stages.length, twin.stages.length)
  locked.stages.forEach((stage, index) => assert.equal(stage.points.current.factors.temperature, twin.stages[index].points.current.factors.temperature / 5, `stage ${index}: temperature divided by 5`))
  assert.deepEqual(keysOf(locked.stages[0].limiting), ['pressure', 'hydrosphere'], 'the lock moves the limit from the temperature to the pressure and the water')

  const moonLocked = (await stagesOf(w, 'moonLocked')).stages
  const moon = (await stagesOf(w, 'moon')).stages

  moonLocked.forEach((stage, index) => assert.equal(stage.points.current.factors.temperature, moon[index].points.current.factors.temperature, `moon stage ${index}: no lock on a moon`))

  // A body the species can never live on has no plan to promise anything about.
  for (const name of ['gasGiant', 'fixedBody', 'tooHeavy', 'tooLight', 'liveable']) {
    const found = await w.staged(name)

    assert.equal(found.result, null, `${name}: no stages`)
  }
})

check('provenance', 'every stage is a result of a registered rule: the saved first stage of the cost rule, the planned ones estimated under standing assumptions', async (w) => {
  const { provenance } = await w.modules()
  const { stages } = await stagesOf(w, 'toxic')

  stages.forEach((stage) => {
    assert.ok(stage.result && stage.result.rule, `stage ${stage.index} has a result`)
    assert.ok(provenance.getRule(stage.result.rule.id), `stage ${stage.index}: the rule is registered`)
    assert.equal(stage.result.value, stage.cost.raw)
  })

  assert.equal(stages[0].result.rule.id, 'habitability.colonyCost')
  assert.ok(stages.slice(1).every((stage) => stage.result.rule.id !== stages[0].result.rule.id && stage.result.status === 'estimated' && stage.result.assumptions.length > 0))
})

check('component', 'the body detail shows a row per stage with the limits and the next limits of the stage, every figure marked, and notes for what stands', async (w) => {
  const { stages, result } = await stagesOf(w, 'toxicLow')
  const vm = await w.detail('toxicLow')
  const rows = vm.stageRows

  assert.equal(rows.length, stages.length)
  rows.forEach((row, index) => {
    assert.deepEqual(keysOf(row.limiting), keysOf(stages[index].limiting), `row ${index}: limits`)
    assert.deepEqual(keysOf(row.next), keysOf(stages[index].next), `row ${index}: next limits`)
    assert.deepEqual(row.limiting.map(({ fixed }) => fixed), stages[index].limiting.map(({ fixed }) => fixed))
    assert.ok(row.result && row.result.rule, `row ${index}: marked`)
    assert.ok(row.limiting.every((entry) => entry.text.includes(entry.label)))
  })

  assert.equal(rows[stages.length - 1].limiting.length, 1)
  assert.equal(rows[0].next.length, 2, 'a tie as the next limit gives two entries')

  const notes = (name) => w.detail(name).then((found) => found.limitNotes)

  assert.ok((await notes('toxicLow')).length > (await notes('toxic')).length, 'a low-gravity body has a note the same plan on normal gravity lacks')
  assert.ok((await notes('thickLocked')).length > (await notes('thick')).length, 'a tidally locked body has a note its unlocked twin lacks')
  assert.ok((await notes('toxic')).length > 0, 'the plan\'s estimate is noted')
  assert.equal(result.floor, 1)

  const bare = await w.detail('liveable')

  assert.deepEqual(bare.stageRows, [], 'a body with no plan has no stage rows')
  assert.deepEqual(bare.limitNotes, [])
})

// The elements of a compiled Vue template and the attribute a start tag carries (static or bound).
const elementsOf = (root) => {
  const found = []
  const walk = (node) => {
    found.push(node)
    node.children.filter((child) => child.type === 1).forEach(walk)
    ;(node.ifConditions || []).slice(1).forEach(({ block }) => walk(block))
    Object.values(node.scopedSlots || {}).forEach(walk)
  }

  walk(root)

  return found
}

const attrOf = (node, name) => {
  const found = node.attrsList.find((attr) => attr.name === name || attr.name === `:${name}`)

  return found ? found.value : undefined
}

const templateOf = (source, filename) => compiler.compileTemplate({ source: (compiler.parse({ source, filename }).descriptor || compiler.parse({ source, filename })).template.content, filename, id: filename }).ast

// eslint-disable-next-line no-new-func
const evaluated = (expression, scope) => new Function('scope', `with (scope) { return (${expression}) }`)(scope)

check('template', 'the stage table renders a row per stage, its chips the limits and the next limits of the row, and its cost the stage\'s result: the loop bindings evaluated on the component\'s data', async (w) => {
  const nodes = elementsOf(templateOf(w.text.vue, 'BodyDetail.vue'))
  const marked = (marker) => nodes.filter((node) => attrOf(node, 'data-limits') === marker)
  const [table] = marked('table')
  const vm = await w.detail('toxicLow')
  const rowLoop = marked('stage')[0]
  const scopeOf = (row) => Object.assign(Object.create(vm), { [rowLoop.alias]: row })

  assert.equal(marked('table').length, 1)
  assert.equal(marked('stage').length, 1)
  assert.equal(marked('limiting').length, 1)
  assert.equal(marked('next').length, 1)
  assert.ok(elementsOf(table).includes(rowLoop), 'the rows are in the table')

  const rows = evaluated(rowLoop.for, scopeOf(null))

  assert.deepEqual(rows, vm.stageRows, 'the table loops over every stage row')
  assert.ok(rows.length > 1)
  assert.ok(rows.some((row) => row.limiting.length > 0) && rows.some((row) => row.next.length > 0), 'the fixture has chips to show')

  for (const row of rows) {
    const scope = scopeOf(row)

    assert.deepEqual(evaluated(marked('limiting')[0].for, scope), row.limiting, 'the limit chips of the row')
    assert.deepEqual(evaluated(marked('next')[0].for, scope), row.next, 'the next limit chips of the row')
  }

  const cells = elementsOf(rowLoop).filter((node) => node.tag === 'td')
  const marks = cells.flatMap((cell) => elementsOf(cell).filter((node) => node.tag === 'provenance-mark'))
  const [row] = rows

  assert.equal(marks.length, 1, 'the stage row carries one provenance mark')
  assert.equal(evaluated(attrOf(marks[0], 'result'), scopeOf(row)), row.result, 'the mark shows the stage\'s own result')
  assert.ok(cells.length >= 4)
})

check('wiring', 'the page hosting the body detail binds every prop the component declares, the gases among them', async (w) => {
  const declared = Object.keys((await w.component()).props).sort()
  const hosts = elementsOf(templateOf(w.text.page, 'habitability.vue')).filter((node) => node.tag === 'body-detail')

  assert.equal(hosts.length, 1)

  const camelized = (name) => name.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())
  const bound = hosts[0].attrsList.filter((attr) => attr.name.startsWith(':')).map((attr) => camelized(attr.name.slice(1))).sort()

  assert.ok(declared.includes('gases'))
  assert.deepEqual(bound, declared)
  const marker = [{ GasID: 1 }]
  const delivered = evaluated(hosts[0].attrsList.find((attr) => attr.name === ':gases').value, { gases: marker })

  assert.equal(delivered, marker, 'the page hands the body detail its loaded gases')
})

check('breathers', 'a gas dangerous to the species\' breathing gas is removed as toxic and priced by the pair of that breathing gas: methane for an oxygen breather, oxygen for a methane breather', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const air = earthlike({ HydroExt: 10, SurfaceTemp: 287.5, Atmosphere: [gas(OXYGEN_ID, 'Oxygen', 0.2, 20, OXYGEN), gas(7, 'Nitrogen', 0.75, 75), gas(METHANE_ID, 'Methane', 0.05, 5, METHANE)] })
  const oxygenBreather = habitability.speciesLimits(SPECIES_ROW)
  const methaneBreather = habitability.speciesLimits(METHANE_SPECIES_ROW)
  const toxic = (species) => {
    const { plan } = terraforming.assessTerraforming(air, species, 1, gasInfo)

    return plan ? plan.steps.filter(({ key }) => key === 'toxic').map(({ gasId }) => gasId) : null
  }
  const danger = (species) => habitability.colonyCost(air, species, 1).factors.danger

  assert.deepEqual(toxic(oxygenBreather), [METHANE_ID], 'the plan for an oxygen breather removes the methane')
  assert.deepEqual(toxic(methaneBreather), [OXYGEN_ID], 'the plan for a methane breather removes the oxygen')
  assert.equal(danger(oxygenBreather), 2, 'methane rates 2 for an oxygen breather')
  assert.equal(danger(methaneBreather), 3, 'oxygen rates 3 for a methane breather')
})

// Terra's r1 finding: the rows a planned atmosphere is priced on carry each gas's share of the air, as the game stores it (its pressure over the total, in percent), not its pressure.
check('plannedShares', 'a planned atmosphere carries each gas\'s share of the whole air, and the priced breathing and danger verdicts read that share', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits(SPECIES_ROW)
  const body = airless()
  // The plan's end state by role: the gases it leaves, as a plan of `planTerraforming` states them.
  const planOf = (breathable, neutral, neutralSide = []) => ({
    target: { breathable, water: 0, greenhouse: 0, sideGreenhouse: 0, antiGreenhouse: 0, sideAnti: 0, neutral, sideNeutral: 0, pressure: breathable + neutral + neutralSide.reduce((sum, row) => sum + row.GasAtm, 0), hydroExt: 0, hydrosphere: habitability.HYDROSPHERE.NONE, albedo: 1, temperature: 288 },
    gases: { greenhouse: { id: 20, name: 'Aestusium' }, anti: { id: 22, name: 'Frigusium' }, neutral: { id: 7, name: 'Nitrogen' }, greenhouseSide: [], antiSide: [], neutralSide, breathable: undefined, waterVapour: undefined },
  })
  const targetOf = (plan) => terraforming.terraformedBody(body, species, plan, gasInfo)
  const rowOf = (target, id) => target.Atmosphere.find((row) => row.AtmosGasID === id)
  const sharesOf = (target) => Object.fromEntries(target.Atmosphere.map((row) => [row.AtmosGasID, row.AtmosGasPercentage]))

  const breathable = targetOf(planOf(0.2, 0.8))

  assert.deepEqual(sharesOf(breathable), { [OXYGEN_ID]: 20, 7: 80 }, '0.2 atm of oxygen and 0.8 atm of nitrogen are shares of 20 % and 80 %')
  assert.equal(habitability.colonyCost(breathable, species, 1, true).factors.breathable, 0, '20 % of the air is a share the breathing gas may hold')

  // The same 0.2 atm of oxygen in less air is 40 % of it: the priced breathing penalty follows the share, not the pressure.
  const concentrated = targetOf(planOf(0.2, 0.3))

  assert.deepEqual(sharesOf(concentrated), { [OXYGEN_ID]: 40, 7: 60 }, 'the same oxygen pressure in less air is a larger share')
  assert.equal(rowOf(concentrated, OXYGEN_ID).GasAtm, 0.2, 'the oxygen pressure itself is unchanged')
  assert.equal(habitability.colonyCost(concentrated, species, 1, true).factors.breathable, habitability.BREATHING_PENALTY, '40 % of the air is too much of it')

  // Methane at a pressure under the 500 ppm limit is 5 % of this air: the danger verdict follows the share too.
  const tainted = targetOf(planOf(0.2, 0.75, [gas(METHANE_ID, 'Methane', 0.05, 5, METHANE)]))

  assert.equal(rowOf(tainted, METHANE_ID).GasAtm, 0.05, 'the methane pressure is under the 500 ppm limit')
  assert.equal(habitability.colonyCost(tainted, species, 1, true).factors.danger, 2, '5 % methane is over the danger limit for an oxygen breather')
})

// A body that suits a breather other than oxygen but pays for its surface water is not done: the plan drains that water as the game's terraformer does (it keeps removing water vapour until the surface holds none), and the drain shows in the end state and in the work.
check('drain', 'a plan for a breather other than oxygen drains the liquid surface water it pays for, shows it in its end state and its work, and a body that pays nothing for its water needs no plan', async (w) => {
  const wet = await w.staged('wetMethane', 1, METHANE_SPECIES_ROW)
  const { plan } = wet.assessment

  assert.deepEqual(wet.assessment.cost.raws, { current: 5, periapsis: 5, apoapsis: 5 }, '50 % of liquid water costs a methane breather 5')
  assert.equal(wet.assessment.outcome, 'yes', 'a world whose air suits but whose water costs is not done')
  assert.deepEqual(keysOf(plan.steps), ['water'], 'the plan is the drain alone: the air already suits')
  assert.equal(plan.steps[0].drained, 50, 'the plan drains the 50 % of surface water')
  assert.equal(round4(plan.steps[0].atm), 1.25, 'the drain is 1.25 atm of water vapour, 40 % to the atmosphere')
  assert.ok(plan.steps[0].work > 0, 'the drain is work for the terraformers')
  assert.equal(plan.target.hydroExt, 0, 'the plan ends on a dry surface')
  assert.deepEqual(wet.assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 }, 'and the water costs nothing then')

  const kinds = wet.result.stages.map(({ kind }) => kind)

  assert.deepEqual(kinds, ['start', 'step'], 'the completed drain is already the end state')
  assert.equal(wet.result.stages[1].hydroExt, 0, 'the completed gas operation leaves no surface water')
  assert.equal(wet.result.stages[1].cost.raw, 0, 'and costs nothing')

  const ice = await w.staged('iceMethane', 1, METHANE_SPECIES_ROW)

  assert.equal(ice.assessment.outcome, 'done', 'an ice sheet costs a methane breather nothing, so the body is done')
  assert.equal(ice.assessment.plan, null)
})

// Terra's liquid-ammonia counterexample, plus a later gas operation on an eccentric orbit to expose the dry surface's changed dampening.
check('drain stages', 'the completed drain and every later gas row carry the remaining water, phase, cost and dampening, including the displayed rows', async (w) => {
  const { habitability, terraforming, limits } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, BreatheID: 4, BreatheName: 'Ammonia' })
  const body = earthlike({ BaseTemp: 255, SurfaceTemp: 280.5, Atmosphere: [gas(4, 'Ammonia', 0.2, 20), gas(7, 'Nitrogen', 0.8, 80)] })
  const assessment = terraforming.assessTerraforming(body, species, 1, gasInfo)
  const result = limits.terraformStages({ assessment, body, species, skill: 1, gasInfo })

  assert.deepEqual(result.stages.map(({ kind, hydroExt, cost }) => [kind, hydroExt, cost.raw]), [['start', 50, 5], ['step', 0, 0]], 'the water operation itself clears the cost, not a synthetic target')
  const options = await w.component()
  const vm = instantiate(options, { $store: { getters: {}, state: {} }, data: { item: { body }, shown: { species, assessment }, rules: { ColonizationSkill: 1 }, gases: GAS_LIST, separator: ',', terraformCapacity: 1 } })

  assert.deepEqual(vm.stageRows.map(({ cost }) => cost), [vm.cost(5), vm.cost(0)], 'the displayed drain row is already free')

  // Methane's saved surface is intentionally warmer than its atmosphere gives: the hold plan drains first, then the aim search adjusts its cooling gas.
  const seasonal = earthlike({ BaseTemp: 220, SurfaceTemp: 280.5, StarLuminosity: (230 / 255) ** 4, Eccentricity: 0.1, Atmosphere: [gas(3, 'Methane', 0.2, 20, METHANE), gas(7, 'Nitrogen', 0.8, 80)] })
  const methane = habitability.speciesLimits(METHANE_SPECIES_ROW)
  const plan = terraforming.planTerraforming(seasonal, methane, gasInfo)
  const staged = limits.terraformStages({ assessment: { cost: habitability.colonyCost(seasonal, methane, 1), plan }, body: seasonal, species: methane, skill: 1, gasInfo }).stages
  let remaining = 50
  let dryRows = 0

  for (const stage of staged.filter(({ step }) => step)) {
    remaining = Math.max(0, remaining - stage.step.drained)
    assert.equal(stage.hydroExt, remaining, `stage ${stage.index}: water carries across operations`)
    const state = stage.body
    const gh = Math.min(3, 1 + state.AtmosPress / 10 + state.Atmosphere.reduce((sum, row) => sum + (row.GHGas ? row.GasAtm : 0), 0))
    const agh = Math.min(3, 1 + state.Atmosphere.reduce((sum, row) => sum + (row.AntiGHGas ? row.GasAtm : 0), 0))
    const dampening = Math.min(0.5, state.AtmosPress / 10) + Math.min(0.3, remaining / 100 * 0.3)
    const expected = (220 * (1 - dampening) + 230 * dampening) * gh * state.Albedo / agh

    assert.ok(Math.abs(stage.temperature - expected) < 1e-9, `stage ${stage.index}: climate uses the remaining water's dampening`)
    assert.equal(state.HydroID, stage.temperature > 369 ? 2 : stage.temperature > 245 ? 3 : 4, `stage ${stage.index}: water phase follows temperature`)
    assert.equal(stage.points.current.factors.hydrosphere, state.HydroID === 3 ? remaining * 0.1 : 0, `stage ${stage.index}: independent water cost`)
    if (remaining === 0) { dryRows += 1 }
  }

  assert.ok(dryRows >= 2, 'the drain and at least one later gas row are priced dry')
})

// The reviewer's liquid-ammonia probe at 100 Earth atm a year of terraformers (100 installations of rate 1): the drain's work is 1.2472547819851116 Earth atm, so the capacity bound is 4.55 days. The surface evaporates and the terraformer removes only the vapour in the air, so the drain can take longer: the body detail must call the figure a minimum wherever it words a time of the drain, and must not date the stages.
check('drain time', 'the body detail words the time of a drain as a minimum that evaporation can exceed, in the step, the plan\'s total, the installation counts and the colony\'s years, and says no stage is dated; the wording of a plan that drains nothing is as it was', async (w) => {
  const { habitability, terraforming } = await w.modules()
  const species = habitability.speciesLimits({ ...SPECIES_ROW, BreatheID: 4, BreatheName: 'Ammonia' })
  const body = earthlike({ BaseTemp: 255, SurfaceTemp: 280.5, Atmosphere: [gas(4, 'Ammonia', 0.2, 20), gas(7, 'Nitrogen', 0.8, 80)], OwnPopulations: [{ PopulationID: 7 }] })
  const assessment = terraforming.assessTerraforming(body, species, 1, gasInfo)
  const options = await w.component()
  const source = { PopName: 'Colony', installations: 100, ships: [], shipsKnown: true, radius: 6371, modifier: { governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 } }
  const viewOf = (shown, item, capacity) => instantiate(options, { $store: { getters: {}, state: {} }, data: { item, shown, rules: { ColonizationSkill: 1, TerraformingRate: 1, TerraformingSpeed: 100 }, gases: GAS_LIST, separator: ',', terraformCapacity: capacity, terraformSources: { raceRate: 1, speed: 100, colonies: { 7: source } } } })
  const vm = viewOf({ species, assessment, years: terraforming.planYears(assessment.work, 100), yearsBasis: assessment.timeBasis, strategy: 'terraform', value: 1 }, { body }, 100)
  const [water] = assessment.plan.steps

  assert.equal(assessment.timeBasis, terraforming.TIME_BASIS.MINIMUM, 'the probe\'s plan has a minimum')
  assert.ok(Math.abs(terraforming.planYears(assessment.work, 100) * 365 - 4.5524799542456575) < 1e-9, 'the capacity bound is the reviewer\'s 4.55 days')
  assert.equal(vm.stepTime(water), 'at least 4.5 days, and longer where the surface water evaporates slowly', 'the step that drains is a least number of days that evaporation can exceed, floored: the 4.5524-day bound reads 4.5, never 4.6')
  assert.equal(vm.planSummary, 'at least 4.5 days with the terraformers set by the race, 1.247 atm of Earth-equivalent work', 'the plan\'s total is a minimum')
  assert.equal(vm.minimumTime, true, 'the detail knows the time is a minimum')
  assert.equal(vm.minimumTimeNote, terraforming.MINIMUM_TIME_NOTE, 'and says why, once, under the plan\'s heading')
  assert.ok(/evaporat/.test(vm.minimumTimeNote) && /not a finishing date/.test(vm.minimumTimeNote), 'the note names the evaporation and no finishing date')
  assert.equal(vm.installationsTitle, 'Installations to move the work within', 'the installation counts are for the work, not for finishing')
  assert.equal(vm.ownColonies[0].yearsText, 'at least 4.5 days for this plan', 'the colony\'s years are a minimum as well')
  assert.ok(vm.limitNotes.some((note) => /complete/.test(note) && /no stage is dated/.test(note)), 'the stage table says its stages show the drain complete and carry no date')
  assert.equal(vm.time(0.25, terraforming.TIME_BASIS.MINIMUM), 'at least 0.25 years', 'a minimum of 0.1 years or more is worded with the page\'s years')
  // The detail writes years at two decimals under ten and one above, and floors a bound to what it shows: no figure stands above the bound it names.
  assert.equal(vm.time(1.0567, terraforming.TIME_BASIS.MINIMUM), 'at least 1.05 years', 'a 1.0567-year bound reads 1.05 years at two decimals, not the 1.06 nearest rounding gives')
  assert.equal(vm.time(4.49999999995 / 365, terraforming.TIME_BASIS.MINIMUM), 'at least 4.4 days', 'a 4.49999999995-day bound reads 4.4 days on the detail, never the 4.5 it is under')
  assert.equal(vm.time(1.0567, terraforming.TIME_BASIS.CAPACITY), '1.06 years', 'a plan that drains nothing is not floored')
  assert.equal(vm.time(12.36, terraforming.TIME_BASIS.MINIMUM), 'at least 12.3 years', 'a 12.36-year bound reads 12.3 years at one decimal, not 12.4')
  assert.equal(viewOf({ species, assessment }, { body }, 0).stepTime(water), 'forever without terraformers', 'with no terraformers there is no time to name')

  // A plan that drains nothing: the wording of the page as it was.
  const other = await w.staged('toxic')
  const plain = viewOf({ species: other.species, assessment: other.assessment }, { body: other.body }, 100)
  const [first] = other.assessment.plan.steps

  assert.equal(other.assessment.timeBasis, terraforming.TIME_BASIS.CAPACITY, 'a plan that drains nothing has the capacity basis')
  assert.equal(plain.stepTime(first), `about ${plain.years(plain.stepYears(first))}`, 'its step is "about" its years')
  assert.ok(!/^at least/.test(plain.planSummary) && !plain.minimumTime, 'its total is not a minimum')
  assert.equal(plain.installationsTitle, 'Installations to finish within', 'its installations finish within')
  assert.ok(!plain.limitNotes.some((note) => /no stage is dated/.test(note)), 'its stage notes carry no drain note')

  // The template shows the note under the plan's heading when the time is a minimum, and the step line words its time through `stepTime`.
  const nodes = elementsOf(templateOf(w.text.vue, 'BodyDetail.vue'))
  const notes = nodes.filter((node) => attrOf(node, 'data-detail') === 'minimum-time')
  const wordsOf = (node) => node.children.map((child) => child.text || '').join('')

  assert.equal(notes.length, 1, 'the plan\'s heading has one minimum-time note')
  assert.ok(wordsOf(notes[0]).includes('{{ minimumTimeNote }}'), 'the note is the component\'s minimumTimeNote')
  assert.equal(evaluated(notes[0].if, vm), true, 'it is shown for a drain')
  assert.equal(evaluated(notes[0].if, plain), false, 'and not for a plan that drains nothing')
  assert.ok(nodes.some((node) => node.tag === 'v-list-item-subtitle' && wordsOf(node).includes('{{ stepTime(step) }}')), 'a step line words its time by stepTime')
})

// A gas the breather rates is toxic only above its limit and not frozen out; one that thaws at the plan's temperature is toxic there; one under its limit is neither removed nor raised.
check('thaw', 'a gas frozen out now is removed when the plan warms the body past its freezing point and kept where it stays frozen, and a rated gas under its limit is neither removed nor raised', async (w) => {
  const { terraforming } = await w.modules()
  const thawing = await w.staged('frozenThaws')
  const keeping = await w.staged('frozenStays')
  const benign = await w.staged('benignSide')

  assert.ok(thawing.assessment.plan && keeping.assessment.plan && benign.assessment.plan, 'the three bodies have a plan')
  assert.deepEqual(thawing.assessment.plan.steps.filter(({ key }) => key === 'toxic').map(({ gasId }) => gasId), [METHANE_ID], 'the methane that thaws at 288 K is removed')
  assert.deepEqual(keeping.assessment.plan.steps.filter(({ key }) => key === 'toxic'), [], 'the methane that stays frozen is benign')
  assert.ok(benign.assessment.plan.steps.every((step) => step.gasId !== METHANE_ID), 'the methane under its limit is neither removed nor raised')

  const end = terraforming.terraformedBody(benign.body, benign.species, benign.assessment.plan, gasInfo)
  const left = end.Atmosphere.find((row) => row.AtmosGasID === METHANE_ID)

  assert.ok(left && left.GasAtm === 0.0004, 'the methane is in the end air at the pressure it had')
})

// ---- The planted faults ----------------------------------------------------------------------------------------------
// Each plants one change in one source, and the checks named must fail on it. [label, target, text, replacement, the checks that must fail]
const FAULTS = [
  ['a methane breather is rated by the oxygen pair', 'habitability', 'const { dangerous, ppm } = gasDanger(gas, species.BreatheID)', 'const { dangerous, ppm } = gasDanger(gas)', ['breathers']],
  ['the plan sorts the toxic gases by the oxygen pair', 'terraforming', 'const toxicFor = (gas, species, warmedTo) => isDangerousGas(gas, species, 0, false) || (warmedTo !== null && isDangerousGas(gas, species, warmedTo, true))', 'const toxicFor = (gas, species) => isDangerousGas(gas, { ...species, BreatheID: GAS.OXYGEN }, 0, false)', ['breathers']],
  ['a gas the breather rates is toxic whatever its share', 'terraforming', 'const toxicFor = (gas, species, warmedTo) => isDangerousGas(gas, species, 0, false) || (warmedTo !== null && isDangerousGas(gas, species, warmedTo, true))', 'const toxicFor = (gas, species) => gasDanger(gas, species.BreatheID).dangerous > 0', ['settle', 'thaw']],
  ['a gas that thaws at the plan\'s temperature is not toxic there', 'terraforming', '(warmedTo !== null && isDangerousGas(gas, species, warmedTo, true))', 'false', ['thaw']],
  ['a plan never drains the surface water', 'terraforming', 'if (!plan || !leavesDrainableWater(body, species, plan, gasInfo)) {', 'if (true) {', ['drain']],
  ['a body that pays for its surface water is called done', 'terraforming', 'if (suited && !paysForSurfaceWater(body, species)) {', 'if (suited) {', ['drain']],
  ['a drain leaves the water on the surface', 'terraforming', 'return drain ? 0 : current', 'return current', ['drain']],
  ['the drain is no work', 'terraforming', 'work: (Math.abs(to - from) + off / HYDRO_PER_ATM) * areaRatio', 'work: Math.abs(to - from) * areaRatio', ['drain']],
  ['a completed drain stage keeps the saved HydroExt', 'limits', 'bodyAfterTerraformStep(state, step, gasInfo)', 'bodyAfterTerraformStep(state, { ...step, drained: 0 }, gasInfo)', ['drain', 'drain stages']],
  ['later gas stages restore the saved HydroExt', 'limits', 'bodyAfterTerraformStep(state, step, gasInfo)', 'bodyAfterTerraformStep({ ...state, HydroExt: body.HydroExt }, step, gasInfo)', ['drain stages']],
  ['the step that drains is worded as about its years', 'vue', 'stepTimeBasis(step) === TIME_BASIS.MINIMUM', 'false', ['drain time']],
  ['a step that drains is given the capacity basis', 'terraforming', 'export const stepTimeBasis = (step) => (step.drained > 0 ? TIME_BASIS.MINIMUM : TIME_BASIS.CAPACITY)', 'export const stepTimeBasis = () => TIME_BASIS.CAPACITY', ['drain time']],
  ['the plan\'s total is worded as plain years', 'vue', 'const total = this.time(planYears(this.assessment.work, this.terraformCapacity), this.assessment.timeBasis)', 'const total = this.years(planYears(this.assessment.work, this.terraformCapacity))', ['drain time']],
  ['the installation counts are for finishing within', 'vue', 'return this.minimumTime ? \'Installations to move the work within\' : \'Installations to finish within\'', 'return \'Installations to finish within\'', ['drain time']],
  // eslint-disable-next-line no-template-curly-in-string
  ['the colony\'s years are plain years', 'vue', '`${this.time(planYears(this.assessment.work, capacity), this.assessment.timeBasis)} for this plan`', '`${this.years(planYears(this.assessment.work, capacity))} for this plan`', ['drain time']],
  ['the detail floors a minimum at fewer decimals than it writes', 'vue', 'timeWords(value, basis, this.years, value < 10 ? 2 : 1)', 'timeWords(value, basis, this.years, 1)', ['drain time']],
  ['the stage notes do not say no stage is dated', 'vue', '...(this.minimumTime ? [DRAIN_STAGE_NOTE] : []),', '', ['drain time']],
  ['the minimum-time note is never shown', 'vue', '<div v-if="minimumTime" class="caption text--secondary mb-1" data-detail="minimum-time">', '<div v-if="false" class="caption text--secondary mb-1" data-detail="minimum-time">', ['drain time']],
  ['the step line words its time as before', 'vue', ', {{ stepTime(step) }}.</v-list-item-subtitle>', ', about {{ years(stepYears(step)) }}.</v-list-item-subtitle>', ['drain time']],
  ['a tie is cut to its first factor', 'habitability', 'filter((_factor, index) => rounded[index] === top)', 'filter((_factor, index) => rounded[index] === top).slice(0, 1)', ['ties', 'bars']],
  ['a tie is judged without the game\'s rounding', 'habitability', 'const rounded = FACTORS.map((factor) => round4(factors[factor.key]))', 'const rounded = FACTORS.map((factor) => factors[factor.key])', ['ties']],
  ['the cost at periapsis is read at apoapsis', 'habitability', 'distance * (1 - eccentricity)', 'distance * (1 + eccentricity)', ['start']],
  ['gravity is treated as a factor a gas operation can remove', 'limits', 'const FIXED_FACTORS = new Set([\'gravity\'])', 'const FIXED_FACTORS = new Set([])', ['fixed', 'ties']],
  ['every stage carries every operation', 'limits', 'plan.steps.slice(0, applied)', 'plan.steps', ['operations']],
  ['the next limits are cut to the first factor', 'limits', 'merged(others.filter((factor) => round4(factor.value) === top))', 'merged(others.filter((factor) => round4(factor.value) === top).slice(0, 1))', ['ties', 'stages', 'component']],
  ['the gas shares are not recomputed after an operation', 'habitability', 'AtmosGasPercentage: total > 0 ? Math.round((gas.GasAtm / total) * 100 * SHARE_DECIMALS) / SHARE_DECIMALS : 0', 'AtmosGasPercentage: gas.AtmosGasPercentage', ['operations']],
  ['a planned gas row carries its pressure as its share', 'terraforming', 'const rows = withAtmosphereShares(atmosphere)', 'const rows = atmosphere.map((gas) => ({ ...gas, AtmosGasPercentage: gas.GasAtm }))', ['plannedShares']],
  ['the settling stage is never made', 'limits', 'const settles = plan.settling.process !== \'Stable\' && plan.settling.years > 0', 'const settles = false', ['operations', 'settle']],
  ['the first stage is priced as a planned body', 'limits', 'planned: false, previous: null', 'planned: true, previous: null', ['start']],
  ['the limit is read at now only', 'limits', 'distinct.filter((name) => costs[name] === raw)', 'distinct.filter((name) => name === \'current\')', ['stages', 'operations']],
  ['the colonisation skill is dropped from the cost', 'limits', 'worst: raw * skill', 'worst: raw', ['end']],
  ['the changes are not taken from the stage before', 'limits', 'revealed: previous ? limiting.filter(({ key }) => !(previous.limiting.some((entry) => entry.key === key))).map(({ key }) => key) : [],', 'revealed: [],', ['operations', 'stages']],
  ['a hidden breathing penalty is left out of the next limits', 'limits', 'failing && points[name].factors.breathable === 0', 'false', ['operations', 'stages']],
  ['a factor another one rises above is called cleared', 'limits', 'const lowered = (entry) => !entry.fixed && Math.max(...distinct.map((name) => round4(standing(name, entry.key)))) < round4(entry.value)', 'const lowered = () => true', ['fixed', 'operations', 'stages']],
  ['a factor whose penalty stands is called cleared when it only stops limiting', 'limits', 'Math.max(...distinct.map((name) => round4(standing(name, entry.key)))) < round4(entry.value)', 'true', ['operations', 'stages']],
  ['the last operation takes the planner\'s end state', 'limits', 'body: bodyAfter(body, plan, gasInfo, index + 1), species', 'body: index === steps.length - 1 ? ending : bodyAfter(body, plan, gasInfo, index + 1), species', ['conservation', 'settle', 'operations']],
  ['a short settling is left out', 'limits', 'const settles = plan.settling.process !== \'Stable\' && plan.settling.years > 0', 'const settles = plan.settling.process !== \'Stable\' && plan.settling.years > 0.1', ['settle']],
  ['a plan with no gas operation stops at the saved start', 'limits', 'if (settles || !sameCosts || !sameLimits) {', 'if (settles) {', ['operations', 'end']],
  ['a target that differs after the last operation is left out', 'limits', 'if (settles || !sameCosts || !sameLimits) {', 'if (settles || !steps.length) {', ['operations', 'end']],
  ['the floor is stated before the skill', 'limits', 'floorWorst: stages[0].lowGravity ? skill : 0', 'floorWorst: stages[0].lowGravity ? 1 : 0', ['fixed']],
  ['a lock is flagged on a moon', 'limits', 'tidalLock: !!body.TidalLock && body.BodyClass !== BODY_CLASS.MOON', 'tidalLock: !!body.TidalLock', ['fixed']],
  ['the bars flag only the first of a tie', 'vue', 'new Set(limitingFactors(factors).map(', 'new Set(limitingFactors(factors).slice(0, 1).map(', ['bars']],
  ['the stage table loses its provenance mark', 'vue', '<provenance-mark :result="row.result" />', '', ['template']],
  ['the stage table shows no rows', 'vue', 'v-for="row in stageRows"', 'v-for="row in stageRows.slice(0, 0)"', ['template']],
  ['the limit chips show no entries', 'vue', 'v-for="entry in row.limiting"', 'v-for="entry in row.limiting.slice(0, 0)"', ['template']],
  ['the page does not hand the gases over', 'page', ' :gases="gases"', '', ['wiring']],
  ['the plan reads its swing off the saved body', 'terraforming', 'const ends = temperaturePoints(terraformedBody(body, species, plan, gasInfo))', 'const ends = temperaturePoints(body)', ['dampening']],
  ['a stage dampens on the saved pressure', 'terraforming', 'surfaceTemperature({ ...previous, AtmosPress: pressure, HydroExt: extent },', 'surfaceTemperature({ ...previous, HydroExt: extent },', ['dampening']],
  ['the target search returns only the ideal trial', 'terraforming', 'if (initial && !initial.partial && clearsWater(initial)) {', 'if (true) {', ['targetSearch', 'phase']],
  ['the target search ignores the hot extreme', 'terraforming', 'const high = Math.max(ends.current, ends.periapsis, ends.apoapsis)', 'const high = Math.max(ends.current, ends.apoapsis)', ['targetSearch', 'phase']],
  ['the target search ignores the cold extreme', 'terraforming', 'const low = Math.min(ends.current, ends.periapsis, ends.apoapsis)', 'const low = Math.min(ends.current, ends.periapsis)', ['targetSearchImpossible']],
  ['the target search ignores gas freezing at an extreme', 'habitability', 'if (threshold >= gas.FreezingPoint) {', 'if (true) {', ['targetGasPhase']],
  ['a null trial terminates the target search', 'terraforming', 'fallback = fallback || trial', 'if (!trial) { return fallback }\n\n    fallback = fallback || trial', ['targetPressureBracket']],
  ['the target search restores r3 side pruning', 'terraforming', ORIGINALS.terraforming.slice(ORIGINALS.terraforming.indexOf('  // Integer indices'), ORIGINALS.terraforming.indexOf('\n}\n', ORIGINALS.terraforming.indexOf('export const planTerraforming'))), `  const search = (minimum, maximum, cooling) => {
    const edgeAim = cooling ? minimum : maximum
    const edge = planAtTemperature(body, species, gasInfo, edgeAim)
    let reachable = initial ? ideal : edge ? edgeAim : null

    if (edge && !edge.partial) {
      return edge
    }

    fallback = fallback || edge

    for (let iteration = 0; iteration < 32 && maximum - minimum >= TOLERANCE; iteration += 1) {
      const aim = (minimum + maximum) / 2
      const trial = planAtTemperature(body, species, gasInfo, aim)

      if (trial && !trial.partial) {
        return trial
      }

      fallback = fallback || trial
      reachable = trial ? aim : reachable

      if (trial ? trial.target.temperatureLow < species.MinimumTemperature : reachable === null ? cooling : aim < reachable) {
        minimum = aim
      } else {
        maximum = aim
      }
    }

    return null
  }

  const cooling = !fallback || fallback.target.temperatureHigh > species.MaximumTemperature
  const cooler = () => search(species.MinimumTemperature, ideal, true)
  const warmer = () => search(ideal, species.MaximumTemperature, false)

  return (cooling ? cooler() || warmer() : warmer() || cooler()) || fallback`, ['targetSearchNonMonotone']],
  ['the liveability verdict scales the swing from the saved surface temperature', 'terraforming', 'const { current, periapsis, apoapsis } = temperaturePoints(body)', `const { current, periapsis, apoapsis } = (() => {
    const moon = body.BodyClass === 2
    const distance = moon ? body.ParentOrbitalDistance : body.OrbitalDistance
    const eccentricity = moon ? body.ParentEccentricity : body.Eccentricity
    const year = moon ? body.ParentYear : body.Year
    const factor = !distance || !eccentricity || (body.AtmosPress <= 0 && body.HydroExt <= 0) ? 0 : (Math.min(0.5, body.AtmosPress / 10) + Math.min(0.3, body.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(year / 8760))
    const blend = (ratio) => ratio * (1 - factor) + factor

    return { current: body.SurfaceTemp, periapsis: body.SurfaceTemp * blend(Math.max(1, Math.sqrt(distance / (distance * (1 - eccentricity))))), apoapsis: body.SurfaceTemp * blend(Math.min(1, Math.sqrt(distance / (distance * (1 + eccentricity))))) }
  })()`, ['position']],
  ['the liveability verdict extrapolates the swing as a dampened ratio', 'terraforming', 'const { current, periapsis, apoapsis } = temperaturePoints(body)', `const { current, periapsis, apoapsis } = (() => {
    const moon = body.BodyClass === 2
    const distance = moon ? body.ParentOrbitalDistance : body.OrbitalDistance
    const eccentricity = moon ? body.ParentEccentricity : body.Eccentricity
    const year = moon ? body.ParentYear : body.Year
    const present = moon ? body.ParentDistanceToParent : body.DistanceToParent
    const factor = !distance || !eccentricity || (body.AtmosPress <= 0 && body.HydroExt <= 0) ? 0 : (Math.min(0.5, body.AtmosPress / 10) + Math.min(0.3, body.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(year / 8760))
    const blend = (ratio) => ratio * (1 - factor) + factor
    const reach = Number.isFinite(distance) && distance > 0 && Number.isFinite(present) && present > 0 ? Math.sqrt(distance / present) : 1
    const circular = body.SurfaceTemp / (reach * (1 - factor) + factor)

    return { current: body.SurfaceTemp, periapsis: circular * blend(Math.max(1, Math.sqrt(distance / (distance * (1 - eccentricity))))), apoapsis: circular * blend(Math.min(1, Math.sqrt(distance / (distance * (1 + eccentricity))))) }
  })()`, ['phase']],
]

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

const main = async () => {
  const mutate = mutating()
  const baseline = worldOf()
  const failures = await run(CHECKS, baseline)
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach(({ name, error }) => console.log(`FAIL ${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`))

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))
    const outcomes = await inParallel(FAULTS, async ([label, target, from, to, fails]) => {
      refusePlanting(label)
      fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`))

      const world = worldOf({ target, from, to })
      const missed = []

      for (const name of fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(name)
        }
      }

      return { label, missed }
    })

    outcomes.forEach((outcome, index) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault ${FAULTS[index][0]}: ${outcome.message}`)
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
