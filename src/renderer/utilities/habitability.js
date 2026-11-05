// What a body costs a species to live on, from the game's own rules: the colony cost now and at the extremes of its orbit, checked against the infrastructure the game stores for every own colony (docs/DATABASE.md § Colony cost).
//
// A body is `{ Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroID, HydroExt, TidalLock, BodyClass, BodyTypeID, FixedBody, OrbitalDistance, Eccentricity, Year, ParentOrbitalDistance, ParentEccentricity, ParentYear, StarLuminosity, Atmosphere: [gas] }` and a gas `{ AtmosGasID, GasAtm, AtmosGasPercentage (percent of the atmosphere), FrozenOut, BoilingPoint, GHGas, AntiGHGas, DangerousOxygen, DangerousPPMOxygen, DangerousMethane, DangerousPPMMethane, DangerousSulphur, DangerousPPMSulphur, DangerousAmmonia, DangerousPPMAmmonia }` (`gasDanger` picks the danger pair of the species' breathing gas). A species is a row of FCT_Species under the names the loader gives it (see `speciesLimits`).

import { ofRule, registerRule, unavailable } from './provenance'

export const BODY_CLASS = { PLANET: 1, MOON: 2, ASTEROID: 3, COMET: 5 }
export const BODY_TYPE = { GAS_GIANT: 4, SUPERJOVIAN: 5 }
export const HYDROSPHERE = { NONE: 1, VAPOUR: 2, LIQUID: 3, ICE_SHEET: 4 }
export const GAS = { METHANE: 3, AMMONIA: 4, WATER_VAPOUR: 5, OXYGEN: 10, SULPHUR_DIOXIDE: 15 }

// The DIM_Gases columns that say how dangerous a gas is to a breather of each breathing gas, as [rating, level in parts per million of the atmosphere]. The game picks the pair by the species' breathing gas (SystemBody.method_54); a breathing gas without a pair has no dangerous gas.
const BREATHER_DANGER = Object.freeze({
  [GAS.OXYGEN]: Object.freeze(['DangerousOxygen', 'DangerousPPMOxygen']),
  [GAS.METHANE]: Object.freeze(['DangerousMethane', 'DangerousPPMMethane']),
  [GAS.SULPHUR_DIOXIDE]: Object.freeze(['DangerousSulphur', 'DangerousPPMSulphur']),
  [GAS.AMMONIA]: Object.freeze(['DangerousAmmonia', 'DangerousPPMAmmonia']),
})
const NO_DANGER = Object.freeze({ dangerous: 0, ppm: 0 })

// Every danger column of DIM_Gases, one pair for each breathing gas.
export const DANGER_COLUMNS = Object.freeze(Object.values(BREATHER_DANGER).flat())

// How dangerous a gas row is to a breather of `breathingGas` (the species' BreatheID, oxygen where none is given): `dangerous` is the rating the colony cost takes and `ppm` the share of the atmosphere, in parts per million, above which the gas counts.
export const gasDanger = (gas, breathingGas = GAS.OXYGEN) => {
  const pair = BREATHER_DANGER[breathingGas]

  return pair ? { dangerous: gas[pair[0]], ppm: gas[pair[1]] } : NO_DANGER
}

// The danger columns of a DIM_Gases row (`info`), 0 where the table holds none, for the row of an atmosphere that a plan adds a gas to.
export const dangerColumnsOf = (info) => Object.fromEntries(DANGER_COLUMNS.map((column) => [column, info[column] || 0]))

const SHARE_DECIMALS = 1e9

// The atmosphere rows with the share of each gas in the air (`AtmosGasPercentage`), recomputed from the pressures as the atmosphere refresh of the game does: the gas's pressure over the total, in percent, to nine decimals; a body with no air has no share.
export const withAtmosphereShares = (rows) => {
  const total = rows.reduce((sum, gas) => sum + gas.GasAtm, 0)

  return rows.map((gas) => ({ ...gas, AtmosGasPercentage: total > 0 ? Math.round((gas.GasAtm / total) * 100 * SHARE_DECIMALS) / SHARE_DECIMALS : 0 }))
}

// A gas above this share of the atmosphere is too much of a good thing.
export const MAX_BREATHABLE_PERCENT = 30
// Terraforming and atmosphere retention need at least this gravity.
export const MINIMUM_TERRAFORMING_GRAVITY = 0.1
// Infrastructure a low-gravity colony needs per unit of colony cost.
export const LOW_GRAVITY_INFRASTRUCTURE = 2

const ICE_SHEET_ALBEDO_STEP = 0.0015
const WATER_BOILING_KELVIN = 369
const WATER_FREEZING_KELVIN = 245

const VERSIONS = ['3.1.x']

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
registerRule({
  id: 'habitability.colonyCost',
  versions: VERSIONS,
  units: 'colony cost',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroExt, HydroID, TidalLock, Eccentricity, Year, StarLuminosity', 'FCT_SystemBody.ParentOrbitalDistance, ParentEccentricity, ParentYear', 'FCT_AtmosphericGas', 'DIM_Gases', 'FCT_Species', 'FCT_Race.ColonizationSkill'],
  note: 'The largest of six environment factors, worst of now, periapsis and apoapsis, times the race\'s colonisation skill. The temperature swing follows the dampened orbital rule: the stored climate is blended toward the circular-orbit temperature, less on a long orbit, and a moon takes its parent\'s orbit and year. Checked against the stored infrastructure requirement of the race\'s own colonies: the requirement per million people equals the cost now times the skill, times 100 (200 on low gravity), over the species\' density modifier, within 0.1% on 23 of 27 colonies of two saves and within 3.4% on the other four, all low gravity (the stored requirement may predate a change of population; not checked). Periapsis, apoapsis and the worst case have no stored value, and no unsettled body is checked.',
})

registerRule({
  id: 'habitability.infraPerMillion',
  versions: VERSIONS,
  units: 'infrastructure per million people',
  verification: 'estimated',
  structure: ['FCT_Species.PopulationDensityModifier', 'FCT_SystemBody.Gravity'],
  note: 'The colony cost times 100 (200 on low gravity) over the species\' density modifier, rounded up, float noise rounded off first. Before the rounding the figure matches the stored infrastructure requirement over the population for the cost now (the check of the colony cost rule); the rounding and the use of the worst cost of the orbit are the planner\'s reading and have no stored value.',
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
const DANGER_INPUTS = [['DangerousOxygen', 'danger to oxygen breathers'], ['DangerousPPMOxygen', 'danger level for oxygen breathers'], ['DangerousMethane', 'danger to methane breathers'], ['DangerousPPMMethane', 'danger level for methane breathers'], ['DangerousSulphur', 'danger to sulphur dioxide breathers'], ['DangerousPPMSulphur', 'danger level for sulphur dioxide breathers'], ['DangerousAmmonia', 'danger to ammonia breathers'], ['DangerousPPMAmmonia', 'danger level for ammonia breathers']]
const GAS_INPUTS = [['AtmosGasID', 'gas'], ['GasAtm', 'gas pressure'], ['AtmosGasPercentage', 'gas share'], ['FrozenOut', 'frozen-out flag'], ['BoilingPoint', 'boiling point'], ['GHGas', 'greenhouse flag'], ['AntiGHGas', 'anti-greenhouse flag'], ...DANGER_INPUTS]
const SPECIES_INPUTS = [['IdealTemperature', 'ideal temperature'], ['TemperatureDeviation', 'temperature deviation', true], ['IdealBreathePressure', 'breathing gas pressure'], ['BreathePressureDeviation', 'breathing gas deviation'], ['MaximumPressure', 'maximum pressure', true], ['IdealGravity', 'ideal gravity'], ['GravityDeviation', 'gravity deviation'], ['PopulationDensityModifier', 'population density', true], ['BreatheID', 'breathing gas']]

const usable = (source, [key, , positive]) => isNumber(source[key]) && (!positive || source[key] > 0)

const lacking = (source, inputs, owner) => (inputs.every((input) => usable(source, input)) ? NOTHING : inputs.filter((input) => !usable(source, input)).map(([, name]) => `${owner} ${name}`))

// The figures of a body that its colony cost and terraforming plan need and the save lacks, by name; the shared empty list when it has them all. A missing figure makes the cost unavailable, never a default (a missing tidal lock is not "not locked", a missing gas pressure is not 0).
export const missingBodyInputs = (body) => {
  const isMoon = body.BodyClass === BODY_CLASS.MOON
  const atmosphere = body.Atmosphere || NOTHING
  const dampens = (body.AtmosPress > 0 || body.HydroExt > 0) && (isMoon ? body.ParentEccentricity : body.Eccentricity) > 0
  const missing = [...lacking(body, BODY_INPUTS, 'body'), ...(isMoon ? NOTHING : lacking(body, TIDAL_INPUTS, 'body')), ...(isMoon ? lacking(body, MOON_INPUTS, 'body') : body.Eccentricity > 0 ? lacking(body, ECCENTRIC_INPUTS, 'body') : NOTHING), ...(dampens ? isMoon ? lacking(body, [['ParentYear', 'planet orbital year']], 'body') : lacking(body, [['Year', 'orbital year']], 'body') : NOTHING), ...(atmosphere.length ? lacking(body, DUST_INPUTS, 'body') : NOTHING)]

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

// SystemBody.method_1: an eccentric body's atmosphere and ocean smooth its seasons, less on a long orbit. A moon uses the planet's orbit and year, never the planet's atmosphere.
export const orbitalTemperatureDampening = (body) => {
  const { distance, eccentricity, year } = orbitOf(body)

  if (!distance || !eccentricity || (body.AtmosPress <= 0 && body.HydroExt <= 0)) {
    return 0
  }

  return (Math.min(0.5, body.AtmosPress / 10) + Math.min(0.3, body.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(year / 8760))
}

const dampenedTemperature = (body, temperature, greenhouse, antiGreenhouse, albedo) => {
  const factor = orbitalTemperatureDampening(body)

  if (factor <= 0) {
    return Math.max(1, temperature)
  }

  const { distance } = orbitOf(body)
  const circular = 255 / Math.sqrt(distance / Math.sqrt(body.StarLuminosity)) * greenhouse * albedo / antiGreenhouse

  return temperature * (1 - factor) + circular * factor
}

// SystemBody.method_2: the saved/current climate uses its base temperature and the same blend, with a final 4 K floor. The prediction at a distance below has different floors.
export const surfaceTemperature = (body, greenhouse, antiGreenhouse, albedo = body.Albedo) => Math.max(4, dampenedTemperature(body, body.BaseTemp * greenhouse * albedo / antiGreenhouse, greenhouse, antiGreenhouse, albedo))

// SystemBody.method_65/method_3: predict gas phases from the surface/base ratio, then blend the Kelvin climate toward the circular-orbit temperature before predicting a water phase change. The base has a 4 K floor; only an undampened result has a 1 K floor.
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
  let temperature = dampenedTemperature(body, (equilibrium * greenhouse * albedo) / antiGreenhouse, greenhouse, antiGreenhouse, albedo)

  if (body.HydroExt > 0) {
    const was = body.HydroID
    const now = hydrosphereAtTemperature(temperature)

    if (was !== now) {
      if (was === HYDROSPHERE.ICE_SHEET) {
        albedo += ICE_SHEET_ALBEDO_STEP * body.HydroExt
      } else if (now === HYDROSPHERE.ICE_SHEET) {
        albedo -= ICE_SHEET_ALBEDO_STEP * body.HydroExt
      }

      temperature = dampenedTemperature(body, (equilibrium * greenhouse * albedo) / antiGreenhouse, greenhouse, antiGreenhouse, albedo)
    }
  }

  return temperature
}

// The worst dangerous gas, to a breather of the species' breathing gas, that is present beyond its limit, never the species' own breathing gas.
const dangerousGas = (body, species, temperature, planned) => {
  let worst = null
  let rating = 0

  body.Atmosphere.forEach((gas) => {
    const { dangerous, ppm } = gasDanger(gas, species.BreatheID)

    if (dangerous > rating && gas.AtmosGasID !== species.BreatheID && !frozenOut(gas, temperature, planned) && gas.AtmosGasPercentage > ppm / 10000) {
      worst = gas
      rating = dangerous
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
  const share = breathing.reduce((total, candidate) => total + candidate.AtmosGasPercentage, 0)

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
  const dangerCost = gas ? gasDanger(gas, species.BreatheID).dangerous : 0
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
export const orbitOf = (body) => (body.BodyClass === BODY_CLASS.MOON ? { distance: body.ParentOrbitalDistance, eccentricity: body.ParentEccentricity, year: body.ParentYear } : { distance: body.OrbitalDistance, eccentricity: body.Eccentricity, year: body.Year })

// The orbital extremes of a body: the temperature at periapsis and at apoapsis as `temperatureAtDistance` predicts them, with the seasonal blend, the gas-phase threshold and the ice-albedo step; null for a body that is neither eccentric nor a moon, which has only the present climate.
const orbitalExtremes = (body) => {
  if (!(body.Eccentricity > 0 || body.BodyClass === BODY_CLASS.MOON)) {
    return null
  }

  const { distance, eccentricity } = orbitOf(body)

  return [temperatureAtDistance(body, distance * (1 - eccentricity)), temperatureAtDistance(body, distance * (1 + eccentricity))]
}

// The temperature a body is priced at: now, at periapsis and at apoapsis. A body that is neither eccentric nor a moon reads its present climate at all three. The liveability verdict reads the same three, so it judges the temperatures the colony cost prices.
export const temperaturePoints = (body) => {
  const extremes = orbitalExtremes(body)
  const current = body.SurfaceTemp

  return extremes ? { current, periapsis: extremes[0], apoapsis: extremes[1] } : { current, periapsis: current, apoapsis: current }
}

// The cost factors of a body at the three points of its orbit: now, at periapsis and at apoapsis. A body that is neither eccentric nor a moon has only the one, now. `planned` is for a body that doesn't exist yet.
export const costPoints = (body, species, planned = false) => {
  const current = costFactors(body, species, body.SurfaceTemp, planned)
  const extremes = orbitalExtremes(body)

  if (extremes) {
    return { current, periapsis: costFactors(body, species, extremes[0], planned), apoapsis: costFactors(body, species, extremes[1], planned) }
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
