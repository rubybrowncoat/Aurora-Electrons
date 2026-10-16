// What a body costs a species to live on, from the game's own rules: the colony cost now and at the extremes of its orbit, checked against the infrastructure the game stores for every own colony (docs/DATABASE.md § Colony cost).
//
// A body is `{ Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroID, HydroExt, TidalLock, BodyClass, BodyTypeID, FixedBody, OrbitalDistance, Eccentricity, ParentOrbitalDistance, ParentEccentricity, StarLuminosity, Atmosphere: [gas] }` and a gas `{ AtmosGasID, GasAtm, AtmosGasAmount (percent of the atmosphere), FrozenOut, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel }`. A species is a row of FCT_Species under the names the loader gives it (see `speciesLimits`).

import { ofRule, registerRule, unavailable } from './provenance'

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

const VERSIONS = ['2.7.x']

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
registerRule({
  id: 'habitability.colonyCost',
  versions: VERSIONS,
  units: 'colony cost',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroExt, TidalLock, Eccentricity', 'FCT_AtmosphericGas', 'DIM_Gases', 'FCT_Species', 'FCT_Race.ColonizationSkill'],
  note: 'The largest of six environment factors (docs/DATABASE.md, Colony cost), worst of now, periapsis and apoapsis, times the race\'s colonisation skill. Checked against FCT_Population.ReqInf of the race\'s own colonies: the requirement per million people equals the cost now times the skill, times 100 (200 on low gravity), over PopulationDensityModifier, within 0.1% on 23 of 27 colonies of two saves and within 3.4% on the other four, all low gravity (the stored requirement may predate a change of population; not checked). Periapsis, apoapsis and the worst case have no stored value, and no unsettled body is checked.',
})

registerRule({
  id: 'habitability.infraPerMillion',
  versions: VERSIONS,
  units: 'infrastructure per million people',
  verification: 'estimated',
  structure: ['FCT_Species.PopulationDensityModifier', 'FCT_SystemBody.Gravity'],
  note: 'ceil(colony cost x 100 x 2 on low gravity / PopulationDensityModifier), float noise rounded off first. Before the ceiling the figure matches FCT_Population.ReqInf over Population for the cost now (the check of habitability.colonyCost); the ceiling and the use of the worst cost of the orbit are the Planner\'s reading and have no stored value.',
})

const NOTHING = Object.freeze([])

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// What a body's cost reads: [column, name, must be positive]. A moon and a body on an eccentric orbit also read what the swing between periapsis and apoapsis needs; a body that is not a moon reads its tidal lock; every atmosphere row reads its pressure, share and gas properties (the terraforming plan reads the same ones).
const BODY_INPUTS = [['Gravity', 'gravity'], ['SurfaceTemp', 'surface temperature'], ['AtmosPress', 'atmospheric pressure'], ['HydroExt', 'water extent'], ['HydroID', 'hydrosphere'], ['Radius', 'radius'], ['Eccentricity', 'orbital eccentricity'], ['FixedBody', 'fixed body flag'], ['BaseTemp', 'base temperature'], ['Albedo', 'albedo']]
const TIDAL_INPUTS = [['TidalLock', 'tidal lock']]
const SWING_INPUTS = [['BaseTemp', 'base temperature', true], ['Albedo', 'albedo', true], ['StarLuminosity', 'star luminosity', true]]
const ECCENTRIC_INPUTS = [...SWING_INPUTS, ['OrbitalDistance', 'orbital distance', true]]
const MOON_INPUTS = [...SWING_INPUTS, ['ParentOrbitalDistance', 'planet orbital distance', true], ['ParentEccentricity', 'planet eccentricity']]
const DUST_INPUTS = [['DustLevel', 'dust level']]
const GAS_INPUTS = [['AtmosGasID', 'gas'], ['GasAtm', 'gas pressure'], ['AtmosGasAmount', 'gas share'], ['FrozenOut', 'frozen-out flag'], ['BoilingPoint', 'boiling point'], ['GHGas', 'greenhouse flag'], ['AntiGHGas', 'anti-greenhouse flag'], ['Dangerous', 'danger'], ['DangerousLevel', 'danger level']]
const SPECIES_INPUTS = [['IdealTemperature', 'ideal temperature'], ['TemperatureDeviation', 'temperature deviation', true], ['IdealBreathePressure', 'breathing gas pressure'], ['BreathePressureDeviation', 'breathing gas deviation'], ['MaximumPressure', 'maximum pressure', true], ['IdealGravity', 'ideal gravity'], ['GravityDeviation', 'gravity deviation'], ['PopulationDensityModifier', 'population density', true], ['BreatheID', 'breathing gas']]

const usable = (source, [key, , positive]) => isNumber(source[key]) && (!positive || source[key] > 0)

const lacking = (source, inputs, owner) => (inputs.every((input) => usable(source, input)) ? NOTHING : inputs.filter((input) => !usable(source, input)).map(([, name]) => `${owner} ${name}`))

// The figures of a body that its colony cost and terraforming plan need and the save lacks, by name; the shared empty list when it has them all. A missing figure makes the cost unavailable, never a default (a missing tidal lock is not "not locked", a missing gas pressure is not 0).
export const missingBodyInputs = (body) => {
  const isMoon = body.BodyClass === BODY_CLASS.MOON
  const atmosphere = body.Atmosphere || NOTHING
  const missing = [...lacking(body, BODY_INPUTS, 'body'), ...(isMoon ? NOTHING : lacking(body, TIDAL_INPUTS, 'body')), ...(isMoon ? lacking(body, MOON_INPUTS, 'body') : body.Eccentricity > 0 ? lacking(body, ECCENTRIC_INPUTS, 'body') : NOTHING), ...(atmosphere.length ? lacking(body, DUST_INPUTS, 'body') : NOTHING)]

  for (let index = 0; index < atmosphere.length; index += 1) {
    missing.push(...lacking(atmosphere[index], GAS_INPUTS, 'atmosphere'))
  }

  return missing.length ? [...new Set(missing)] : NOTHING
}

// The same for a species row (the names the loader gives it): the ranges and the density the cost divides by, which must be positive.
export const missingSpeciesInputs = (species) => lacking(species, SPECIES_INPUTS, 'species')

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

// The base temperature the game works with, which is not the saved BaseTemp column. The game works it out again from where a body is now and a moon takes its planet's; the column is only written when a body changes, so it is stale for most eccentric orbits. The saved SurfaceTemp follows the recomputed value on every planet, asteroid, comet and moon of the sample and of three other saves (docs/DATABASE.md § Colony cost). Needs DistanceToParent, the star's luminosity and, for a moon, the parent's DistanceToParent.
export const climateBaseTemp = (body) => equilibriumTemperature(body.BodyClass === BODY_CLASS.MOON && body.ParentDistanceToParent > 0 ? body.ParentDistanceToParent : body.DistanceToParent, body.StarLuminosity)

const round4 = (value) => Math.round(value * 10000) / 10000

export const hydrosphereAtTemperature = (temperature) => (temperature > WATER_BOILING_KELVIN ? HYDROSPHERE.VAPOUR : temperature > WATER_FREEZING_KELVIN ? HYDROSPHERE.LIQUID : HYDROSPHERE.ICE_SHEET)

// A gas is frozen out below its boiling point. A saved body carries the game's flag; a body that doesn't exist yet (a terraforming target) gets the rule the game applies after every change.
const frozenOut = (gas, temperature, planned) => (planned ? temperature < gas.BoilingPoint : !!gas.FrozenOut)

// The surface temperature the body would settle at `distance` AU from its star, with its present atmosphere. It reads the stored BaseTemp: the game never recomputes it from the moving orbit, so the ratio of surface to base temperature is the atmosphere's alone.
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

// The colony cost of a breathing gas outside the species' range.
export const BREATHING_PENALTY = 2

// Whether the breathing gas is outside the species' range or too large a share of the air, whatever else sets the cost. The colony cost only counts it while the cost before it is under 2.
export const breathingFails = (body, species) => {
  const breathing = body.Atmosphere.filter((candidate) => candidate.AtmosGasID === species.BreatheID)
  const pressure = breathing.reduce((total, candidate) => total + candidate.GasAtm, 0)
  const share = breathing.reduce((total, candidate) => total + candidate.AtmosGasAmount, 0)

  return pressure < species.MinimumBreathablePressure || pressure > species.MaximumBreathablePressure || share > MAX_BREATHABLE_PERCENT
}

// The six things that add to a colony cost, each as the game's colony cost factor, and which one decides. The cost is the largest factor, not their sum (the breathable-gas rule only applies below 2). `planned` marks a body that doesn't exist yet. Returns the cost before the race's colonisation skill.
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

  if (round4(cost) < 2 && breathingFails(body, species)) {
    breathableCost = BREATHING_PENALTY
    cost = BREATHING_PENALTY
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

// The cost factors of a body at the three points of its orbit: now, at periapsis and at apoapsis. A body that is neither eccentric nor a moon has only the one, now. `planned` is for a body that doesn't exist yet.
export const costPoints = (body, species, planned = false) => {
  const current = costFactors(body, species, body.SurfaceTemp, planned)

  if (body.Eccentricity > 0 || body.BodyClass === BODY_CLASS.MOON) {
    const { distance, eccentricity } = orbitOf(body)

    return { current, periapsis: costFactors(body, species, temperatureAtDistance(body, distance * (1 - eccentricity)), planned), apoapsis: costFactors(body, species, temperatureAtDistance(body, distance * (1 + eccentricity)), planned) }
  }

  return { current, periapsis: current, apoapsis: current }
}

// Colony cost now, at periapsis and apoapsis, and the worst of them, all times the race's colonisation skill (a tech multiplier, 1 without it). `raw` is the same worst case before the skill, the cost the environment alone sets. `planned` is for a body that doesn't exist yet.
export const colonyCost = (body, species, skill, planned = false) => {
  const reason = uncolonisableReason(body, species)

  if (reason) {
    return { colonisable: false, reason }
  }

  const points = costPoints(body, species, planned)
  const now = points.current
  const periapsis = points.periapsis.cost
  const apoapsis = points.apoapsis.cost

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

// Every factor that sets a cost: all those equal to the largest at the game's four decimals (the cost is rounded there, so factors that agree there are tied), none at zero cost. The factor `limitingFactor` names is always one of them.
export const limitingFactors = (factors) => {
  const rounded = FACTORS.map((factor) => round4(factors[factor.key]))
  const top = Math.max(0, ...rounded)

  return top > 0 ? FACTORS.map((factor) => ({ ...factor, value: factors[factor.key] })).filter((_factor, index) => rounded[index] === top) : []
}

// Infrastructure per million people at a colony cost. A low-gravity colony needs twice as much. The game does this in decimals, so float noise is rounded off before the ceiling.
export const infrastructurePerMillion = (cost, species, lowGravity) => Math.ceil(Number(((cost * 100 * (lowGravity ? LOW_GRAVITY_INFRASTRUCTURE : 1)) / species.PopulationDensityModifier).toFixed(6)))

// The infrastructure per million people at a colony cost as a result: unavailable when the cost is not a number or the species has no positive population density to divide by, never 0 or NaN. `assumptions` are the ones the cost was worked out under.
export const infrastructurePerMillionResult = (cost, species, lowGravity, assumptions = []) => {
  const missing = []

  if (!isNumber(cost)) {
    missing.push('colony cost')
  }

  if (!isNumber(species.PopulationDensityModifier) || species.PopulationDensityModifier <= 0) {
    missing.push('species population density')
  }

  if (missing.length) {
    return unavailable({ rule: 'habitability.infraPerMillion', missing })
  }

  return ofRule({ rule: 'habitability.infraPerMillion', value: infrastructurePerMillion(cost, species, lowGravity), inputs: { present: ['colony cost', 'species population density', 'gravity'] }, assumptions })
}
