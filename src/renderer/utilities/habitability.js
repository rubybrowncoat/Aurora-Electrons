// What a body costs a species to live on, from the game's own rules: the colony cost now and at the extremes of
// its orbit, checked against the infrastructure the game stores for every own colony (docs/DATABASE.md § Colony
// cost).
//
// A body is `{ Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroID, HydroExt, TidalLock,
// BodyClass, BodyTypeID, FixedBody, OrbitalDistance, Eccentricity, ParentOrbitalDistance,
// ParentEccentricity, StarLuminosity, Atmosphere: [gas] }` and a gas `{ AtmosGasID, GasAtm, AtmosGasAmount
// (percent of the atmosphere), FrozenOut, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel }`.
// A species is a row of FCT_Species under the names the loader gives it (see `speciesLimits`).

export const BODY_CLASS = { PLANET: 1, MOON: 2, ASTEROID: 3, COMET: 5 }
export const BODY_TYPE = { GAS_GIANT: 4, SUPERJOVIAN: 5 }
export const HYDROSPHERE = { NONE: 1, VAPOUR: 2, LIQUID: 3, ICE_SHEET: 4 }
export const GAS = { WATER_VAPOUR: 5 }

// A gas above this share of the atmosphere is too much of a good thing.
export const MAX_BREATHABLE_PERCENT = 30
// Terraforming and atmosphere retention need at least this gravity.
export const MINIMUM_TERRAFORMING_GRAVITY = 0.1
// Infrastructure a low-gravity colony needs per unit of colony cost.
export const LOW_GRAVITY_INFRASTRUCTURE = 2

const ICE_SHEET_ALBEDO_STEP = 0.0015
const WATER_BOILING_KELVIN = 369
const WATER_FREEZING_KELVIN = 245

export const FACTORS = [
  { key: 'temperature', label: 'Temperature' },
  { key: 'pressure', label: 'Pressure' },
  { key: 'danger', label: 'Dangerous gas' },
  { key: 'breathable', label: 'Breathable gas' },
  { key: 'hydrosphere', label: 'Water' },
  { key: 'gravity', label: 'Gravity' },
]

// FCT_Species with the ranges the game derives from it.
export const speciesLimits = (species) => ({
  ...species,
  MinimumTemperature: species.IdealTemperature - species.TemperatureDeviation,
  MaximumTemperature: species.IdealTemperature + species.TemperatureDeviation,
  MinimumBreathablePressure: species.IdealBreathePressure - species.BreathePressureDeviation,
  MaximumBreathablePressure: species.IdealBreathePressure + species.BreathePressureDeviation,
  MinimumGravity: species.IdealGravity - species.GravityDeviation,
  MaximumGravity: species.IdealGravity + species.GravityDeviation,
})

// The temperature a body would have with no atmosphere at `distance` AU from its star, in kelvin.
export const equilibriumTemperature = (distance, luminosity) => Math.max(255 / Math.sqrt(distance / Math.sqrt(luminosity)), 4)

// The base temperature the game works with, which is not the saved BaseTemp column. The game works it out
// again from where a body is now and a moon takes its planet's; the column is only written when a body changes, so it is stale for most eccentric
// orbits. The saved SurfaceTemp follows the recomputed value on every planet, asteroid, comet and moon of
// the sample and of three other saves (docs/DATABASE.md § Colony cost). Needs DistanceToParent, the star's
// luminosity and, for a moon, the parent's DistanceToParent.
export const climateBaseTemp = (body) => equilibriumTemperature(body.BodyClass === BODY_CLASS.MOON && body.ParentDistanceToParent > 0 ? body.ParentDistanceToParent : body.DistanceToParent, body.StarLuminosity)

const round4 = (value) => Math.round(value * 10000) / 10000

export const hydrosphereAtTemperature = (temperature) => (temperature > WATER_BOILING_KELVIN ? HYDROSPHERE.VAPOUR : temperature > WATER_FREEZING_KELVIN ? HYDROSPHERE.LIQUID : HYDROSPHERE.ICE_SHEET)

// A gas is frozen out below its boiling point. A saved body carries the game's flag; a body that doesn't
// exist yet (a terraforming target) gets the rule the game applies after every change.
const frozenOut = (gas, temperature, planned) => (planned ? temperature < gas.BoilingPoint : !!gas.FrozenOut)

// The surface temperature the body would settle at `distance` AU from its star, with its present
// atmosphere. It reads the stored BaseTemp: the game never recomputes it from the
// moving orbit, so the ratio of surface to base temperature is the atmosphere's alone.
export const temperatureAtDistance = (body, distance) => {
  const equilibrium = equilibriumTemperature(distance, body.StarLuminosity)
  const ratio = body.SurfaceTemp / (body.BaseTemp * body.Albedo)
  const threshold = equilibrium * body.Albedo * ratio
  let greenhouse = 1
  let antiGreenhouse = 1

  if (body.Atmosphere.length) {
    let greenhouseAtm = 0
    let antiGreenhouseAtm = 0

    body.Atmosphere.forEach((gas) => {
      if (threshold >= gas.BoilingPoint) {
        greenhouseAtm += gas.GHGas ? gas.GasAtm : 0
        antiGreenhouseAtm += gas.AntiGHGas ? gas.GasAtm : 0
      }
    })

    greenhouse = Math.min(3, 1 + body.AtmosPress / 10 + greenhouseAtm)
    antiGreenhouse = Math.min(3, 1 + body.DustLevel / 20000 + antiGreenhouseAtm)
  }

  let albedo = body.Albedo
  let temperature = Math.max(1, (equilibrium * greenhouse * albedo) / antiGreenhouse)

  if (body.HydroExt > 0) {
    const was = body.HydroID
    const now = hydrosphereAtTemperature(temperature)

    if (was !== now) {
      if (was === HYDROSPHERE.ICE_SHEET) {
        albedo += ICE_SHEET_ALBEDO_STEP * body.HydroExt
      } else if (now === HYDROSPHERE.ICE_SHEET) {
        albedo -= ICE_SHEET_ALBEDO_STEP * body.HydroExt
      }

      temperature = Math.max(1, (equilibrium * greenhouse * albedo) / antiGreenhouse)
    }
  }

  return temperature
}

// The worst dangerous gas that is present beyond its limit, never the species' own breathing gas.
const dangerousGas = (body, species, temperature, planned) => {
  let worst = null

  body.Atmosphere.forEach((gas) => {
    if (gas.Dangerous > (worst ? worst.Dangerous : 0) && gas.AtmosGasID !== species.BreatheID && !frozenOut(gas, temperature, planned) && gas.AtmosGasAmount > gas.DangerousLevel / 10000) {
      worst = gas
    }
  })

  return worst
}

// The six things that add to a colony cost, each as the game's colony cost factor, and which one decides.
// The cost is the largest factor, not their sum (the breathable-gas rule only applies below 2).
// `planned` marks a body that doesn't exist yet. Returns the cost before the race's colonisation skill.
export const costFactors = (body, species, temperature, planned = false) => {
  const tidal = body.TidalLock && body.BodyClass !== BODY_CLASS.MOON ? 5 : 1
  let temperatureCost = 0

  if (temperature < species.MinimumTemperature) {
    temperatureCost = Math.abs(species.MinimumTemperature - temperature) / species.TemperatureDeviation
  } else if (temperature > species.MaximumTemperature) {
    temperatureCost = Math.abs(species.MaximumTemperature - temperature) / species.TemperatureDeviation
  }

  temperatureCost /= tidal

  const pressureCost = body.AtmosPress > species.MaximumPressure ? Math.max(2, body.AtmosPress / species.MaximumPressure) : 0
  const gas = dangerousGas(body, species, temperature, planned)
  const dangerCost = gas ? gas.Dangerous : 0
  let cost = Math.max(dangerCost, temperatureCost, pressureCost)
  let breathableCost = 0

  if (round4(cost) < 2) {
    const breathing = body.Atmosphere.filter((candidate) => candidate.AtmosGasID === species.BreatheID)
    const pressure = breathing.reduce((total, candidate) => total + candidate.GasAtm, 0)
    const share = breathing.reduce((total, candidate) => total + candidate.AtmosGasAmount, 0)

    if (pressure < species.MinimumBreathablePressure || pressure > species.MaximumBreathablePressure || share > MAX_BREATHABLE_PERCENT) {
      breathableCost = 2
      cost = 2
    }
  }

  const hydrosphereCost = body.HydroExt < 20 ? (20 - body.HydroExt) / 10 : 0
  cost = Math.max(cost, hydrosphereCost)

  const lowGravity = body.Gravity < species.MinimumGravity
  const gravityCost = lowGravity ? 1 : 0

  if (lowGravity && cost < 1) {
    cost = 1
  }

  return {
    cost: round4(cost),
    lowGravity,
    dangerousGas: gas,
    factors: { temperature: temperatureCost, pressure: pressureCost, danger: dangerCost, breathable: breathableCost, hydrosphere: hydrosphereCost, gravity: gravityCost },
  }
}

// Why a body can't be colonised at all, or null.
export const uncolonisableReason = (body, species) => {
  if (body.BodyTypeID === BODY_TYPE.GAS_GIANT || body.BodyTypeID === BODY_TYPE.SUPERJOVIAN) {
    return 'Gas giant'
  }

  if (body.FixedBody) {
    return 'Fixed body'
  }

  if (body.Gravity > species.MaximumGravity) {
    return 'Too heavy'
  }

  return null
}

// The orbit that sets the temperature swing: a moon follows its parent planet.
export const orbitOf = (body) => (body.BodyClass === BODY_CLASS.MOON ? { distance: body.ParentOrbitalDistance, eccentricity: body.ParentEccentricity } : { distance: body.OrbitalDistance, eccentricity: body.Eccentricity })

// Colony cost now, at periapsis and apoapsis, and the worst of them, all times the race's colonisation
// skill (a tech multiplier, 1 without it). `raw` is the same worst case before the skill, the cost the
// environment alone sets. `planned` is for a body that doesn't exist yet.
export const colonyCost = (body, species, skill, planned = false) => {
  const reason = uncolonisableReason(body, species)

  if (reason) {
    return { colonisable: false, reason }
  }

  const now = costFactors(body, species, body.SurfaceTemp, planned)
  let periapsis = now.cost
  let apoapsis = now.cost

  if (body.Eccentricity > 0 || body.BodyClass === BODY_CLASS.MOON) {
    const { distance, eccentricity } = orbitOf(body)

    periapsis = costFactors(body, species, temperatureAtDistance(body, distance * (1 - eccentricity)), planned).cost
    apoapsis = costFactors(body, species, temperatureAtDistance(body, distance * (1 + eccentricity)), planned).cost
  }

  const raw = Math.max(now.cost, periapsis, apoapsis)

  return {
    colonisable: true,
    current: now.cost * skill,
    periapsis: periapsis * skill,
    apoapsis: apoapsis * skill,
    worst: raw * skill,
    raw,
    raws: { current: now.cost, periapsis, apoapsis },
    lowGravity: now.lowGravity,
    factors: now.factors,
    dangerousGas: now.dangerousGas,
  }
}

// What the biggest factor is, for a cost line like "Water 1.4". Null at zero cost.
export const limitingFactor = (factors) => {
  const [first] = FACTORS.map((factor) => ({ ...factor, value: factors[factor.key] })).sort((a, b) => b.value - a.value)

  return first && first.value > 0 ? first : null
}

// Infrastructure per million people at a colony cost. A low-gravity colony needs
// twice as much. The game does this in decimals, so float noise is rounded off before the ceiling.
export const infrastructurePerMillion = (cost, species, lowGravity) => Math.ceil(Number(((cost * 100 * (lowGravity ? LOW_GRAVITY_INFRASTRUCTURE : 1)) / species.PopulationDensityModifier).toFixed(6)))
