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
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
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
// A species that lives between 258 and 318 K, breathes oxygen between 0.1 and 0.3 atm, bears up to 4 atm and gravity from 0.5 to 1.5. The climate of a fixture body is the game's: base temperature times 1 + pressure / 10 + greenhouse gas, with an albedo of 1, so each surface temperature below is worked by hand.
const SPECIES_ROW = { IdealTemperature: 288, TemperatureDeviation: 30, IdealBreathePressure: 0.2, BreathePressureDeviation: 0.1, IdealGravity: 1, GravityDeviation: 0.5, MaximumPressure: 4, BreatheID: 2, BreatheName: 'Oxygen', PopulationDensityModifier: 1 }

const gas = (AtmosGasID, AtmosGasName, GasAtm, AtmosGasAmount, extra = {}) => ({ AtmosGasID, AtmosGasName, GasAtm, AtmosGasAmount, BoilingPoint: 0, GHGas: 0, AntiGHGas: 0, Dangerous: 0, DangerousLevel: 0, FrozenOut: 0, ...extra })
const gasRow = (AtmosGasName, extra = {}) => ({ AtmosGasName, BoilingPoint: 0, GHGas: 0, AntiGHGas: 0, Dangerous: 0, DangerousLevel: 0, ...extra })

// Methane is dangerous (rating 2) above a share of 0.05 %, and warms.
const METHANE = { Dangerous: 2, DangerousLevel: 500, GHGas: 1 }
const GASES = { 1: gasRow('Methane', METHANE), 2: gasRow('Oxygen'), 5: gasRow('Water Vapour'), 7: gasRow('Nitrogen'), 20: gasRow('Aestusium', { GHGas: 1 }), 22: gasRow('Frigusium', { AntiGHGas: 1 }) }
const GAS_LIST = Object.entries(GASES).map(([id, row]) => ({ GasID: Number(id), Name: row.AtmosGasName, ...row }))
const gasInfo = (id) => GASES[id]

const earthlike = (extra = {}) => ({ BodyClass: 1, BodyTypeID: 1, FixedBody: 0, TidalLock: 0, Radius: 6371, Gravity: 1, SurfaceTemp: 275, BaseTemp: 250, Albedo: 1, StarLuminosity: 1, DustLevel: 0, HydroExt: 50, HydroID: 3, AtmosPress: 1, Eccentricity: 0, OrbitalDistance: 1, Atmosphere: [gas(2, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.8, 80)], ...extra })
const airless = (extra = {}) => earthlike({ SurfaceTemp: 250, HydroExt: 0, HydroID: 1, AtmosPress: 0, Atmosphere: [], ...extra })
const withMethane = [gas(2, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.75, 75), gas(1, 'Methane', 0.05, 5, METHANE)]
const thick = [gas(7, 'Nitrogen', 6, 100)]

// An atmosphere of nitrogen, Aestusium (warms), Frigusium (cools), methane and oxygen at the given pressures, shares worked from them.
const crowded = (nitrogen, warming, cooling, methane, oxygen) => {
  const total = nitrogen + warming + cooling + methane + oxygen
  const share = (atm) => (atm / total) * 100

  return [gas(7, 'Nitrogen', nitrogen, share(nitrogen)), gas(20, 'Aestusium', warming, share(warming), { GHGas: 1 }), gas(22, 'Frigusium', cooling, share(cooling), { AntiGHGas: 1 }), gas(1, 'Methane', methane, share(methane), METHANE), gas(2, 'Oxygen', oxygen, share(oxygen))]
}

// Hand-worked starts: `airless` is a cold body with no air and no water: the breathing gas (2) and the water (2) tie. `toxic` has methane at 5 % (rating 2) and 10 % water (1). `thick` holds 6 atm of nitrogen at 400 K (temperature 2.7333, pressure 2, water 2). `thin` holds 0.1 atm of nitrogen and no oxygen. `trace` holds 0.0005 atm of methane under its dangerous share.
const BODIES = {
  liveable: earthlike(),
  airless: airless(),
  airlessLow: airless({ Gravity: 0.4 }),
  toxic: earthlike({ HydroExt: 10, SurfaceTemp: 287.5, Atmosphere: withMethane }),
  toxicLow: earthlike({ Gravity: 0.4, HydroExt: 10, SurfaceTemp: 287.5, Atmosphere: withMethane }),
  frozenToxic: earthlike({ HydroExt: 10, SurfaceTemp: 287.5, Atmosphere: [gas(2, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.75, 75), gas(1, 'Methane', 0.05, 5, { ...METHANE, FrozenOut: 1 })] }),
  thick: earthlike({ HydroExt: 0, HydroID: 1, AtmosPress: 6, SurfaceTemp: 400, Atmosphere: thick }),
  thickLocked: earthlike({ HydroExt: 0, HydroID: 1, AtmosPress: 6, SurfaceTemp: 400, Atmosphere: thick, TidalLock: 1 }),
  thin: earthlike({ AtmosPress: 0.1, SurfaceTemp: 252.5, Atmosphere: [gas(7, 'Nitrogen', 0.1, 100)] }),
  trace: earthlike({ AtmosPress: 1.0005, Atmosphere: [gas(2, 'Oxygen', 0.2, 19.99), gas(7, 'Nitrogen', 0.8, 79.99), gas(1, 'Methane', 0.0005, 0.05, { Dangerous: 2, DangerousLevel: 500 })] }),
  eccentric: airless({ Eccentricity: 0.3 }),
  moon: earthlike({ BodyClass: 2, ParentOrbitalDistance: 1, ParentEccentricity: 0.2, HydroExt: 30, HydroID: 4, AtmosPress: 0, SurfaceTemp: 250, Atmosphere: [] }),
  moonLocked: earthlike({ BodyClass: 2, ParentOrbitalDistance: 1, ParentEccentricity: 0.2, HydroExt: 30, HydroID: 4, AtmosPress: 0, SurfaceTemp: 250, Atmosphere: [], TidalLock: 1 }),
  // Temperature and water both stand at exactly 2; with the temperature at 2.00004 they tie at the four decimals only.
  exactTie: earthlike({ HydroExt: 0, HydroID: 1, SurfaceTemp: 198 }),
  roundTie: earthlike({ HydroExt: 0, HydroID: 1, SurfaceTemp: 197.9988 }),
  gasGiant: earthlike({ BodyTypeID: 4 }),
  fixedBody: airless({ FixedBody: 1 }),
  tooHeavy: airless({ Gravity: 2 }),
  tooLight: airless({ Gravity: 0.05 }),
  // Methane (danger 2) hides the missing breathing gas: removing it reveals the breathing penalty.
  hidden: earthlike({ SurfaceTemp: 287.5, Atmosphere: [gas(7, 'Nitrogen', 0.95, 95), gas(1, 'Methane', 0.05, 5, METHANE)] }),
  // 4.05 atm that the first operations hold at the species' pressure limit and the water step lifts over it again; low gravity stands at 1 throughout.
  floorSwing: earthlike({ BaseTemp: 200, SurfaceTemp: 300, Gravity: 0.4, HydroExt: 10, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // The same air on an eccentric orbit at normal gravity: water condenses over 2.5 years after the last operation.
  condensing: earthlike({ BaseTemp: 200, SurfaceTemp: 300, StarLuminosity: (200 / 255) ** 4, Eccentricity: 0.4, HydroExt: 10, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // The plan only removes the methane, yet its target holds 20 % water.
  removalOnly: earthlike({ BaseTemp: 300, SurfaceTemp: 245.5, Gravity: 0.4, HydroExt: 0, HydroID: 1, AtmosPress: 4.05, Atmosphere: crowded(0.8, 1, 2, 0.05, 0.2) }),
  // Condensation takes 0.05 years, under the 0.1 the plan's wait text needs.
  shortSettle: earthlike({ BaseTemp: 200, SurfaceTemp: 300, HydroExt: 19.8, AtmosPress: 4.05, Atmosphere: crowded(0.8, 2, 1, 0.05, 0.2) }),
  // No gas operation and no settling, but the target holds 20 % water: the planner's cost after terraforming is 1 against 2.
  noOperation: earthlike({ BaseTemp: 300, SurfaceTemp: 240, StarLuminosity: (300 / 255) ** 4, Gravity: 0.4, HydroExt: 0, HydroID: 4, AtmosPress: 4, Atmosphere: crowded(0.8, 1, 2, 0, 0.2).filter((row) => row.AtmosGasID !== 1) }),
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
  const staged = async (name, skill = 1) => {
    const key = `${name}/${skill}`

    if (!cache.has(key)) {
      const { habitability, terraforming, limits } = await modules()
      const species = habitability.speciesLimits(SPECIES_ROW)
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

const PLANNED = ['liveable', 'airless', 'airlessLow', 'toxic', 'toxicLow', 'frozenToxic', 'thick', 'thickLocked', 'thin', 'trace', 'eccentric', 'moon', 'moonLocked', 'exactTie', 'roundTie', 'hidden', 'floorSwing', 'condensing', 'removalOnly', 'shortSettle', 'noOperation']

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

  const trace = await stagesOf(w, 'trace')

  assert.ok(trace.assessment.plan.steps.every((step) => step.key === 'toxic'), 'a plan that is only toxic-gas removal')
  assert.deepEqual(trace.stages.map(({ kind }) => kind), ['start', 'step'])

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

// ---- The planted faults ----------------------------------------------------------------------------------------------
// Each plants one change in one source, and the checks named must fail on it. [label, target, text, replacement, the checks that must fail]
const FAULTS = [
  ['a tie is cut to its first factor', 'habitability', 'filter((_factor, index) => rounded[index] === top)', 'filter((_factor, index) => rounded[index] === top).slice(0, 1)', ['ties', 'bars']],
  ['a tie is judged without the game\'s rounding', 'habitability', 'const rounded = FACTORS.map((factor) => round4(factors[factor.key]))', 'const rounded = FACTORS.map((factor) => factors[factor.key])', ['ties']],
  ['the cost at periapsis is read at apoapsis', 'habitability', 'distance * (1 - eccentricity)', 'distance * (1 + eccentricity)', ['start']],
  ['gravity is treated as a factor a gas operation can remove', 'limits', 'const FIXED_FACTORS = new Set([\'gravity\'])', 'const FIXED_FACTORS = new Set([])', ['fixed', 'ties']],
  ['every stage carries every operation', 'limits', 'plan.steps.slice(0, applied)', 'plan.steps', ['operations']],
  ['the next limits are cut to the first factor', 'limits', 'merged(others.filter((factor) => round4(factor.value) === top))', 'merged(others.filter((factor) => round4(factor.value) === top).slice(0, 1))', ['ties', 'stages', 'component']],
  ['the gas shares are not recomputed after an operation', 'limits', 'AtmosGasAmount: total > 0 ? Math.round((gas.GasAtm / total) * 100 * SHARE_DECIMALS) / SHARE_DECIMALS : 0', 'AtmosGasAmount: gas.AtmosGasAmount', ['operations']],
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
  const mutate = !process.argv.includes('--no-mutations')
  const baseline = worldOf()
  const failures = await run(CHECKS, baseline)
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach(({ name, error }) => console.log(`FAIL ${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`))

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))
    const outcomes = await inParallel(FAULTS, async ([label, target, from, to, fails]) => {
      fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`))

      const world = worldOf({ target, from, to })
      const missed = []

      for (const name of fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === name), world)

        if (!failed) {
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
