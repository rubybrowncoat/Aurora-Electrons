// Terraforming plans: which gases to add or remove to make a body liveable for a species, how much work that is, and what the body costs afterwards. The game terraforms one gas at a time per colony, adding or removing atm at the colony's capacity scaled by the body's surface area, so a plan's work is the sum over its gases. See docs/DATABASE.md § Terraforming.
//
// The plan itself is the page's long-standing heuristic (a target atmosphere found by iterating the greenhouse balance). It first aims at the species' ideal temperature, then searches the species' range for a mean whose complete, phase-aware orbital swing fits. It is checked against the game's formulas, not against a played-out terraform.

import { PI_APPROX } from './colonies'
import { GAS, HYDROSPHERE, MINIMUM_TERRAFORMING_GRAVITY, colonyCost, costPoints, dangerColumnsOf, gasDanger, hydrosphereAtTemperature, hydrosphereTypeAt, infrastructurePerMillion, isDangerousGas, orbitOf, surfaceTemperature, temperaturePoints, withAtmosphereShares } from './habitability'

export const EARTH_SURFACE_AREA = 511187128
// Water vapour condenses at this many atm a year and evaporates at this many; a hydro extent of 1 % is 1/40 atm of vapour.
export const CONDENSATION_RATE = 0.1
export const EVAPORATION_RATE = 4
export const HYDRO_PER_ATM = 40
const HUMIDITY = 0.01
// Absolute allowance for numerical residue in the final water balance, in atm; independent of the search tolerance.
const WATER_STATIONARITY_ALLOWANCE = 1e-8

const TOLERANCE = 1e-4
const TARGET_TEMPERATURE_STEP = 0.25
// If no whole-orbit target fits, sample the full capped cooling-to-warming multiplier span in this many equal rungs. Means outside the species' range can reduce the worst seasonal cost.
const PARTIAL_TEMPERATURE_RUNGS = 32
// The fraction a share of water vapour stays under its limit by, so that the rounding of the shares never tips it over.
const WATER_SHARE_MARGIN = 1e-6
const GAS_AESTUSIUM = 20
const GAS_FRIGUSIUM = 22
const GAS_NITROGEN = 7

// The two levers that raise an eccentric body's temperature dampening (0.1 for each atm of pressure up to 0.5, 0.003 for each percent of surface water up to 0.3, both times a factor that falls with the length of the year), which a plan pulls only where the greenhouse and anti-greenhouse gases cannot bring both extremes into the species' range: more water on the surface, more pressure in the air. `NO_LEVER` is a plan that pulls none; a lever is `{ hydroExt, pressure }`, the least surface water in percent and the least pressure in atm the plan holds (0 for no floor).
export const LEVER = Object.freeze({ WATER: 'water', PRESSURE: 'pressure' })
const NO_LEVER = Object.freeze({ hydroExt: 0, pressure: 0 })
// The pressure term of the dampening stops growing at 5 atm, so more air gains nothing; the lever searches in this many equal rungs from what the body has to what the lever can reach.
const DAMPENING_PRESSURE = 5
const LEVER_RUNGS = 8
// How near the solver's temperature must come to the aim for the aim to be attained, in kelvin; the solver stops at a ratio within 1e-4, so an attained mean is within a few hundredths of a kelvin.
const ATTAINED = 0.1

// How a body ends up after terraforming, best first. An outcome reads the colony costs the player pays, so the race's colonisation skill (a multiplier under 1 with the tech) counts, as in the game's own lists. `color` is a tone (`toneColor` in appearance.js).
export const OUTCOMES = {
  done: { label: 'Done', description: 'Already liveable for this species; nothing to terraform.', color: 'success' },
  yes: { label: 'Yes', description: 'Terraforming makes it free to colonise.', color: 'success' },
  partial: { label: 'Partial', description: 'Free to colonise at part of its orbit.', color: 'info' },
  near: { label: 'Near', description: 'Ends under 2: cheap, but not free.', color: 'cheap' },
  limited: { label: 'Limited', description: 'Ends under 4.', color: 'warning' },
  insufficient: { label: 'Insufficient', description: 'Terraforming helps, but the colony stays expensive.', color: 'insufficient' },
  no: { label: 'No', description: 'Can not be terraformed to suit this species.', color: 'error' },
}

const outcomeFromCosts = ({ current, periapsis, apoapsis }, lowGravity) => {
  if (current === 0 && periapsis === 0 && apoapsis === 0 && !lowGravity) {
    return 'yes'
  }

  if (current === 0 || periapsis === 0 || apoapsis === 0) {
    return 'partial'
  }

  const worst = Math.max(current, periapsis, apoapsis)

  return worst < 2 ? 'near' : worst < 4 ? 'limited' : 'insufficient'
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// A gas the plan takes out of the air: dangerous to the species' breathers as the game tests it (`isDangerousGas`: rated by the breather's pair, above its limit and not frozen out) now, or, for a plan that warms the body to `warmedTo`, once it thaws there. A rated gas below its limit, or frozen out and staying so, is benign and stays as it is.
const toxicFor = (gas, species, warmedTo) => isDangerousGas(gas, species, 0, false) || (warmedTo !== null && isDangerousGas(gas, species, warmedTo, true))

// Pressures by role: the species' breathing gas, other dangerous gases, water vapour, greenhouse and anti-greenhouse gases, and everything else (neutrals). Water vapour keeps its own role whatever the breather rates it: `waterDangerous` says it is over the limit now, and the plan keeps it under the limit as the water step. Each of the three gas roles has one gas the plan changes (`...Lead`, the first the breather's pair does not rate) and the rest it leaves as they are (`...Side`), so a rated gas that is benign now is never raised toward its limit.
const summariseAtmosphere = (body, species, warmedTo = null) => {
  const summary = { breathable: 0, breathableGas: null, toxic: 0, toxics: [], greenhouse: 0, greenhouses: [], antiGreenhouse: 0, antiGreenhouses: [], waterVapour: 0, waterVapourGas: null, waterDangerous: false, neutral: 0, neutrals: [], total: 0 }

  body.Atmosphere.forEach((gas) => {
    const pressure = Number.isFinite(gas.GasAtm) ? gas.GasAtm : 0

    summary.total += pressure

    if (gas.AtmosGasID === species.BreatheID) {
      summary.breathable += pressure
      summary.breathableGas = gas
    } else if (gas.AtmosGasID === GAS.WATER_VAPOUR) {
      summary.waterVapour += pressure
      summary.waterVapourGas = gas
      summary.waterDangerous = summary.waterDangerous || toxicFor(gas, species, null)
    } else if (toxicFor(gas, species, warmedTo)) {
      summary.toxic += pressure
      summary.toxics.push(gas)
    } else if (gas.GHGas) {
      summary.greenhouse += pressure
      summary.greenhouses.push(gas)
    } else if (gas.AntiGHGas) {
      summary.antiGreenhouse += pressure
      summary.antiGreenhouses.push(gas)
    } else {
      summary.neutral += pressure
      summary.neutrals.push(gas)
    }
  })

  const leadOf = (list) => list.find((gas) => !(gasDanger(gas, species.BreatheID).dangerous > 0)) || null

  summary.greenhouseLead = leadOf(summary.greenhouses)
  summary.greenhouseSide = summary.greenhouses.filter((gas) => gas !== summary.greenhouseLead)
  summary.antiLead = leadOf(summary.antiGreenhouses)
  summary.antiSide = summary.antiGreenhouses.filter((gas) => gas !== summary.antiLead)
  summary.neutralLead = leadOf(summary.neutrals)
  summary.neutralSide = summary.neutrals.filter((gas) => gas !== summary.neutralLead)

  return summary
}

export const hydrosphereState = (temperature, pressure) => {
  if (!Number.isFinite(pressure) || pressure <= 0 || (pressure < 0.006 && temperature > 245)) {
    return HYDROSPHERE.NONE
  }

  return hydrosphereAtTemperature(temperature)
}

// An oxygen breather aims for 20 % water (no colony cost), then for what keeps the most people: liquid water between 50 and 75 % (above 75 % the body holds fewer people), ice anywhere. Any other breather pays for liquid water by its extent (sulphur dioxide for ice as well) and never for water it lacks, so a plan for one keeps the extent as saved unless `drain` is set, when it aims for none: the game's terraformer, set to remove water vapour, keeps removing it until the surface holds no water and the oceans evaporate to refill the air.
const plainHydroExtent = (current, hydrosphere, species, drain) => {
  if (species.BreatheID !== GAS.OXYGEN) {
    return drain ? 0 : current
  }

  if (current < 20) {
    return 20
  }

  if (hydrosphere === HYDROSPHERE.LIQUID) {
    if (current < 50) {
      return Math.min(60, Math.max(20, current + 10))
    }

    return current > 75 ? 75 : clamp(current, 50, 75)
  }

  if (hydrosphere === HYDROSPHERE.VAPOUR) {
    return Math.min(100, Math.max(20, current + 10))
  }

  return Math.max(current, 20)
}

// The surface water a plan aims for: what it would hold anyway, or the lever's floor where that is more and nothing is drained.
const targetHydroExtent = (current, hydrosphere, species, drain, lever) => {
  const plain = plainHydroExtent(current, hydrosphere, species, drain)

  return !drain && lever.hydroExt > plain ? lever.hydroExt : plain
}

// Vapour in balance with the water on the surface; only liquid water keeps any in the air.
const equilibriumVapour = (hydrosphere, extent, pressure) => (hydrosphere === HYDROSPHERE.LIQUID && Number.isFinite(extent) && extent >= 0 ? Math.max(pressure, 0) * (extent / 100) * HUMIDITY : 0)

// The ice sheet reflects more than bare rock: changing between the two moves the albedo.
export const albedoForHydrosphere = (baseAlbedo, was, now, extent) => {
  if (now === was) {
    return baseAlbedo
  }

  let adjusted = baseAlbedo

  if (was !== HYDROSPHERE.ICE_SHEET) {
    if (now === HYDROSPHERE.ICE_SHEET) {
      adjusted -= extent * 0.0015
    }
  } else {
    adjusted += extent * 0.0015
  }

  return Number.isFinite(adjusted) && adjusted > 0 ? adjusted : baseAlbedo
}

// One stationary gas-phase refresh for operations and settled endpoints. An all-frozen atmosphere has a decaying residual pressure, not a stationary zero-pressure state, so it is not priced.
const refreshAtmosphere = (previous, atmosphere, extent, albedo, temperature = previous.SurfaceTemp) => {
  const rows = withAtmosphereShares(atmosphere.map((gas) => ({ ...gas })))

  for (let attempt = 0; attempt < 32; attempt += 1) {
    let pressure = 0
    let greenhouse = 0
    let anti = 0

    rows.forEach((gas) => {
      gas.FrozenOut = temperature < gas.FreezingPoint
      pressure += gas.FrozenOut ? 0 : gas.GasAtm
      greenhouse += !gas.FrozenOut && gas.GHGas ? gas.GasAtm : 0
      anti += !gas.FrozenOut && gas.AntiGHGas ? gas.GasAtm : 0
    })

    if (rows.length && pressure === 0) {
      return null
    }

    const surface = surfaceTemperature({ ...previous, AtmosPress: pressure, HydroExt: extent }, Math.min(3, 1 + pressure / 10 + greenhouse), Math.min(3, 1 + previous.DustLevel / 20000 + anti), albedo)

    if (rows.every((gas) => gas.FrozenOut === (surface < gas.FreezingPoint))) {
      return { ...previous, SurfaceTemp: surface, Albedo: albedo, AtmosPress: pressure, HydroExt: extent, HydroID: hydrosphereState(surface, pressure), Atmosphere: rows }
    }

    temperature = surface
  }

  return null
}

// One completed gas operation, shared by the execution-order search and the stage table. Recompute the climate on the state the preceding operation left; a drain removes surface water inside its own operation, so all later operations use its dry dampening and phase/albedo history.
export const bodyAfterTerraformStep = (body, step, gasInfo) => {
  const atmosphere = new Map(body.Atmosphere.map((gas) => [gas.AtmosGasID, gas]))

  if (Number.isFinite(step.set) && step.set > 0) {
    const info = atmosphere.get(step.gasId) || gasInfo(step.gasId) || {}

    atmosphere.set(step.gasId, { ...info, AtmosGasID: step.gasId, AtmosGasName: info.AtmosGasName || info.Name || 'Unknown', GasAtm: step.set, FreezingPoint: info.FreezingPoint || 0, GHGas: info.GHGas || 0, AntiGHGas: info.AntiGHGas || 0, ...dangerColumnsOf(info), FrozenOut: false })
  } else {
    atmosphere.delete(step.gasId)
  }

  const climate = (previous, extent) => {
    const initial = refreshAtmosphere(previous, [...atmosphere.values()], extent, previous.Albedo)

    if (!initial) {
      return null
    }

    const albedo = albedoForHydrosphere(previous.Albedo, previous.HydroID, initial.HydroID, extent)
    const refreshed = albedo === previous.Albedo ? initial : refreshAtmosphere(initial, initial.Atmosphere, extent, albedo)

    return refreshed && refreshed.HydroID === initial.HydroID ? refreshed : null
  }
  const wet = climate(body, body.HydroExt)

  return wet && step.drained > 0 ? climate(wet, Math.max(0, body.HydroExt - step.drained)) : wet
}

// The water-removal order must be able to finish: at a common priced point the surface must evaporate both before removal and at its dry endpoint. This also covers seasonal thaws without pretending that an all-orbit ice sheet evaporates.
const drainCanComplete = (body, water, gasInfo) => {
  const wet = bodyAfterTerraformStep(body, { ...water, drained: 0 }, gasInfo)
  const dry = bodyAfterTerraformStep(body, water, gasInfo)
  if (!wet || !dry) {
    return false
  }

  const before = temperaturePoints(wet)
  const after = temperaturePoints(dry)
  const evaporates = (state, temperature) => [HYDROSPHERE.LIQUID, HYDROSPHERE.VAPOUR].includes(hydrosphereTypeAt(state, temperature))

  return ['current', 'periapsis', 'apoapsis'].some((point) => evaporates(wet, before[point]) && evaporates(dry, after[point]))
}

// Keep the established gas order and insert the drain at the first stage where it can complete. If none can, reject this dry trial rather than price an unreachable end state.
const sequenceDrain = (body, steps, gasInfo) => {
  const water = steps.find((step) => step.drained > 0)

  if (!water) {
    return steps
  }

  const gases = steps.filter((step) => step !== water)
  let state = body

  for (let index = 0; index <= gases.length; index += 1) {
    if (drainCanComplete(state, water, gasInfo)) {
      gases.splice(index, 0, water)
      return gases
    }

    if (index < gases.length) {
      state = bodyAfterTerraformStep(state, gases[index], gasInfo)

      if (!state) {
        return null
      }
    }
  }

  return null
}

const multipliers = (total, greenhouse, anti, dust) => ({
  greenhouse: Math.min(3, 1 + Math.max(total, 0) / 10 + Math.max(greenhouse, 0)),
  anti: Math.min(3, 1 + dust + Math.max(anti, 0)),
})

// Solves the atmosphere for one albedo. Returns null when the species can't hold it (too much pressure).
const solveAtmosphere = (body, species, albedo, goal, keepNeutralGas) => {
  const { summary, targetBreathable, targetMean, sideNeutral, sideGreenhouse, sideAnti, dust, waterShare, ownGreenhouse, ownAnti, hold, drain, lever } = goal
  const baseReference = Math.max(body.BaseTemp * albedo, 1)

  if (!Number.isFinite(baseReference) || baseReference <= 0) {
    return null
  }

  const targetRatio = targetMean / baseReference
  // The breathing gas warms or cools the air itself where the table says so (methane and sulphur dioxide warm), as the planned body's climate counts it; the plan keeps it at `targetBreathable`, so it is one more fixed share of the greenhouse and anti-greenhouse gas.
  const ratioOf = (total, greenhouse, anti) => {
    const { greenhouse: gh, anti: agh } = multipliers(total, greenhouse + ownGreenhouse, anti + ownAnti, dust)

    return gh / (agh || 1)
  }

  let water = Math.min(Math.max(summary.waterVapour, 0), species.MaximumPressure)
  let neutralMain = Math.min(Math.max(summary.neutral - sideNeutral, 0), Math.max(species.MaximumPressure - sideNeutral, 0))
  // The most water vapour the air may hold for a breather that rates it dangerous: the plan never adds a gas dangerous to the species, so the vapour stays under the limit of the breather's pair (no limit where the pair rates it harmless).
  const waterCeiling = (rest) => (waterShare < 1 ? rest * waterShare / (1 - waterShare) : Infinity)

  if (!Number.isFinite(neutralMain) || neutralMain < 0) {
    neutralMain = 0
  }

  // Harmless neutral gas is kept as far as the limits allow, since removing it is terraforming work for nothing;
  // a body with no room left for the greenhouse gas it needs is solved again with the least neutral gas.
  const keepNeutral = keepNeutralGas ? Math.max(summary.neutral - sideNeutral, 0) : 0
  let greenhouse = Math.max(summary.greenhouse, sideGreenhouse)
  let anti = Math.max(summary.antiGreenhouse, sideAnti)
  let total = Math.max(summary.total, 0)
  let ratio = targetRatio
  let temperature = targetMean
  let hydrosphere = body.HydroID
  let extent = body.HydroExt

  // The neutral gas has to be enough to keep the breathing gas under 30 % and the whole under the species' pressure limit.
  const neutralRange = (fixed) => {
    const minimum = Math.max(sideNeutral, targetBreathable > 0 ? targetBreathable / 0.3 - fixed : sideNeutral, lever.pressure - fixed)
    const maximum = Math.max(sideNeutral, species.MaximumPressure - fixed)

    return { minimum, maximum }
  }

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const previousNeutral = neutralMain
    const previousWater = water
    const fixed = targetBreathable + water + greenhouse + anti
    const { minimum, maximum } = neutralRange(fixed)

    if (minimum > maximum + TOLERANCE) {
      return null
    }

    neutralMain = clamp(keepNeutral, Math.max(0, minimum - sideNeutral), Math.max(0, maximum - sideNeutral))
    total = fixed + neutralMain + sideNeutral
    ratio = ratioOf(total, greenhouse, anti)
    temperature = ratio * baseReference
    hydrosphere = hydrosphereState(temperature, total)
    extent = targetHydroExtent(body.HydroExt, hydrosphere, species, drain, lever)
    water = Math.min(Math.max(equilibriumVapour(hydrosphere, extent, total), 0), species.MaximumPressure, waterCeiling(total - previousWater))

    const error = ratio - targetRatio

    // A plan that holds the climate has no temperature to reach: it changes the water and what the water needs, and the greenhouse and anti-greenhouse gases stay as they are.
    if ((hold || Math.abs(error) < TOLERANCE) && Math.abs(neutralMain - previousNeutral) < TOLERANCE && Math.abs(water - previousWater) < TOLERANCE) {
      break
    }

    if (!hold && Math.abs(error) >= TOLERANCE) {
      // Too warm: cut the greenhouse gas, or add anti-greenhouse gas. Too cold: the other way round. A multiplier stops at 3, so each gas has a ceiling.
      const maxGreenhouse = Math.max(0, 2 - total / 10 - ownGreenhouse)
      const maxAnti = Math.max(0, 2 - dust - ownAnti)

      if (error > 0) {
        const adjustable = Math.max(greenhouse - sideGreenhouse, 0)

        if (adjustable > TOLERANCE) {
          greenhouse = Math.min(sideGreenhouse + adjustable * (targetRatio / ratio), maxGreenhouse)
        } else {
          const room = Math.max(0, species.MaximumPressure - total)

          if (room <= TOLERANCE) {
            return null
          }

          // The anti-greenhouse gas that takes the ratio to its target in one step, on the air as this pass leaves it (the water has moved). The gas adds to the pressure too, a tenth of it to the warming (the greenhouse multiplier is 1 + pressure / 10 + gas); stepping by the error alone overshoots a target above 1, and the other branch does not bring it back.
          const { greenhouse: gh, anti: agh } = multipliers(total - previousWater + water, greenhouse + ownGreenhouse, anti + ownAnti, dust)
          const exact = (gh - targetRatio * agh) / (targetRatio - 0.1)
          const needed = gh + exact / 10 > 3 ? (3 - targetRatio * agh) / targetRatio : exact
          const delta = Math.min(Math.min(Math.max(targetRatio > 0.1 ? needed : error, TOLERANCE), room), maxAnti - anti)

          if (delta > 0) {
            anti += delta
          }
        }
      } else {
        const adjustable = Math.max(anti - sideAnti, 0)

        if (adjustable > TOLERANCE) {
          anti = Math.min(sideAnti + adjustable * (targetRatio / ratio), maxAnti)
        } else {
          const room = Math.max(0, species.MaximumPressure - total)

          if (room <= TOLERANCE) {
            return null
          }

          const delta = Math.min(Math.min(Math.max(-error, TOLERANCE), room), maxGreenhouse - greenhouse)

          if (delta > 0) {
            greenhouse += delta
          }
        }
      }
    }
  }

  const fixed = targetBreathable + water + greenhouse + anti
  const { minimum, maximum } = neutralRange(fixed)

  if (minimum > maximum + TOLERANCE) {
    return null
  }

  neutralMain = clamp(keepNeutral, Math.max(0, minimum - sideNeutral), Math.max(0, maximum - sideNeutral))
  const neutral = neutralMain + sideNeutral
  total = fixed + neutral
  ratio = ratioOf(total, greenhouse, anti)
  temperature = ratio * baseReference
  hydrosphere = hydrosphereState(temperature, total)
  extent = targetHydroExtent(body.HydroExt, hydrosphere, species, drain, lever)

  // Reaching a wetter target means more vapour than the equilibrium: the excess condenses onto the surface.
  const equilibrium = equilibriumVapour(hydrosphere, extent, total)
  const increase = extent - body.HydroExt
  const wanted = increase > 0 ? equilibrium + increase / HYDRO_PER_ATM : equilibrium

  if (wanted >= 0 && wanted <= species.MaximumPressure && targetBreathable + wanted + greenhouse + anti + neutral <= species.MaximumPressure + TOLERANCE) {
    water = Math.min(wanted, waterCeiling(total - water))
  }

  // Whether the vapour a wetter target needs is in the air: a surface that is to gain water only gains it from vapour that fits under the pressure limit and the vapour limit of the breather.
  const supplied = !(increase > TOLERANCE) || water >= wanted - TOLERANCE

  return { water, greenhouse, anti, neutral, total, temperature, hydrosphere, extent, albedo, supplied }
}

// The water step ends when the vapour is in the air; the surface then adjusts by itself, slowly. A drained surface adjusts inside the step instead: the terraformer removes the water the surface gives up, so nothing is left to settle.
const hydrosphereSettling = (body, solution, drained) => {
  const change = solution.extent - body.HydroExt

  if (drained) {
    return { process: 'Stable', years: 0 }
  }

  if (Math.abs(change) <= 0.1) {
    return { process: 'Stable', years: 0 }
  }

  if (change > 0) {
    const excess = solution.water - equilibriumVapour(solution.hydrosphere, solution.extent, solution.total)

    return excess > TOLERANCE ? { process: 'Condense', years: excess / CONDENSATION_RATE } : { process: 'Stable', years: 0 }
  }

  const evaporating = Math.abs(change) / HYDRO_PER_ATM

  return evaporating > TOLERANCE ? { process: 'Evaporate', years: evaporating / EVAPORATION_RATE } : { process: 'Stable', years: 0 }
}

// The plan for one target mean, with the existing pressure, gas-multiplier and breathing limits. `hold` keeps the climate the air gives (the greenhouse and anti-greenhouse gases are left as they are) and `drain` takes the water off the surface, which the game's terraformer does by removing water vapour until the surface is dry. Each trial solves its own atmosphere and albedo before pricing its swing; no ratio extrapolates an extreme from another trial.
const planFor = (body, species, gasInfo, targetMean, hold, drain, lever = NO_LEVER) => {
  // The body's surface in the game's unit of work: four times its pi (3.1416), the same figure the capacity rule spreads pressure over, so a plan's work and that spread are inverses.
  const area = 4 * PI_APPROX * body.Radius ** 2
  const areaRatio = area / EARTH_SURFACE_AREA

  if (!(area > 0)) {
    return null
  }

  const summary = summariseAtmosphere(body, species, targetMean)
  const sideGreenhouse = summary.greenhouseSide.reduce((total, gas) => total + (gas.GasAtm || 0), 0)
  const sideAnti = summary.antiSide.reduce((total, gas) => total + (gas.GasAtm || 0), 0)
  const sideNeutral = summary.neutralSide.reduce((total, gas) => total + (gas.GasAtm || 0), 0)

  // Breathing gas: the nearest edge of the species' range, or where it already is inside it.
  const breatheMin = Math.max(0, species.MinimumBreathablePressure)
  const breatheMax = species.MaximumBreathablePressure
  const nearer = Math.abs(summary.breathable - breatheMin) <= Math.abs(summary.breathable - breatheMax) ? breatheMin : breatheMax
  const targetBreathable = clamp(summary.breathable >= breatheMin - TOLERANCE && summary.breathable <= breatheMax + TOLERANCE ? clamp(summary.breathable, breatheMin, breatheMax) : nearer, breatheMin, breatheMax)

  // The share of the air the water vapour may hold where the species' pair rates it dangerous, a hair under the limit; 1 where the pair rates it harmless or the table has no row of it.
  const waterInfo = gasInfo(GAS.WATER_VAPOUR)
  const waterDanger = waterInfo ? gasDanger(waterInfo, species.BreatheID) : null
  const waterShare = waterDanger && waterDanger.dangerous > 0 ? Math.max(0, waterDanger.ppm / 1e6 * (1 - WATER_SHARE_MARGIN)) : 1
  // The breathing gas's own climate effect: the row the body has of it, else the table's.
  const own = summary.breathableGas || gasInfo(species.BreatheID)
  const ownGreenhouse = own && own.GHGas ? targetBreathable : 0
  const ownAnti = own && !own.GHGas && own.AntiGHGas ? targetBreathable : 0
  const goal = { summary, targetBreathable, targetMean, sideNeutral, sideGreenhouse, sideAnti, waterShare, ownGreenhouse, ownAnti, hold, drain, lever, dust: Math.max(Number.isFinite(body.DustLevel) ? body.DustLevel : 0, 0) / 20000 }
  let albedo = body.Albedo
  const solve = (value, keep) => solveAtmosphere(body, species, value, goal, keep)
  let keep = true
  let solution = solve(albedo, keep)

  if (!solution) {
    keep = false
    solution = solve(albedo, keep)
  }

  if (!solution) {
    return null
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const adjusted = albedoForHydrosphere(body.Albedo, body.HydroID, solution.hydrosphere, body.HydroExt)

    if (Math.abs(adjusted - albedo) < 1e-3) {
      break
    }

    albedo = adjusted

    const again = solve(albedo, keep)

    if (!again) {
      break
    }

    solution = again
  }

  // The gas each role is added as: the gas of it the plan changes, else the game's usual one.
  const role = (lead, id, name) => (lead ? { id: lead.AtmosGasID, name: lead.AtmosGasName } : { id, name })
  const greenhouseGas = role(summary.greenhouseLead, GAS_AESTUSIUM, 'Aestusium')
  const antiGas = role(summary.antiLead, GAS_FRIGUSIUM, 'Frigusium')
  const neutralGas = role(summary.neutralLead, GAS_NITROGEN, 'Nitrogen')
  // The surface water a drain takes off, in percent of the surface: the terraformer removes it as vapour, 1 atm for every 40 %.
  const drained = drain ? Math.max(body.HydroExt - solution.extent, 0) : 0
  const settling = hydrosphereSettling(body, solution, drained > 0)
  // The levers this plan pulls: the surface water raised over what it would hold anyway, and the pressure held at the floor the lever sets (the neutral gas that fills the air up to it).
  const raisedWater = !drain && lever.hydroExt > 0 && solution.extent > plainHydroExtent(body.HydroExt, solution.hydrosphere, species, drain) + TOLERANCE
  const raisedPressure = lever.pressure > 0 && solution.total <= lever.pressure + TOLERANCE

  // Water that is to gain extent condenses from vapour in the air: where that vapour does not fit, the plan cannot raise the surface and is no plan.
  if (!solution.supplied) {
    return null
  }

  // `set` is the figure to type into the game for the named gas: the role's total less the side gases it keeps. `drained` is the surface water, in percent, the step also takes off. `lever` names the dampening lever the step pulls, or null.
  const step = (key, label, gasId, from, to, set = to, off = 0, pulled = null) => ({ key, label, gasId, from, to, set, drained: off, lever: pulled, atm: Math.abs(to - from) + off / HYDRO_PER_ATM, work: (Math.abs(to - from) + off / HYDRO_PER_ATM) * areaRatio })
  const operations = [
    ...summary.toxics.map((gas) => step('toxic', gas.AtmosGasName, gas.AtmosGasID, gas.GasAtm, 0)),
    step('water', 'Water Vapour', GAS.WATER_VAPOUR, summary.waterVapour, solution.water, solution.water, drained, raisedWater ? LEVER.WATER : null),
    step('breathable', species.BreatheName, species.BreatheID, summary.breathable, targetBreathable),
    step('greenhouse', greenhouseGas.name, greenhouseGas.id, summary.greenhouse, solution.greenhouse, solution.greenhouse - sideGreenhouse),
    step('antiGreenhouse', antiGas.name, antiGas.id, summary.antiGreenhouse, solution.anti, solution.anti - sideAnti),
    step('neutral', neutralGas.name, neutralGas.id, summary.neutral, solution.neutral, solution.neutral - sideNeutral, 0, raisedPressure ? LEVER.PRESSURE : null),
  ].filter((candidate) => candidate.work >= TOLERANCE * areaRatio)
  const steps = sequenceDrain(body, operations, gasInfo)

  if (!steps) {
    return null
  }

  // Every displayed operation must also have a consistent climate; invalid stages cannot establish that a drain thaws.
  const operated = steps.reduce((state, candidate) => state && bodyAfterTerraformStep(state, candidate, gasInfo), body)

  if (!operated) {
    return null
  }

  const plan = {
    steps,
    work: steps.reduce((total, candidate) => total + candidate.work, 0),
    settling,
    // The atmosphere the plan ends with, by role.
    target: {
      water: solution.water,
      breathable: targetBreathable,
      greenhouse: solution.greenhouse,
      antiGreenhouse: solution.anti,
      neutral: solution.neutral,
      sideGreenhouse,
      sideAnti,
      sideNeutral,
      pressure: solution.total,
      temperature: solution.temperature,
      hydrosphere: solution.hydrosphere,
      hydroExt: solution.extent,
      albedo: solution.albedo,
    },
    from: { pressure: body.AtmosPress, breathable: summary.breathable, albedo: body.OriginalAlbedo ?? body.Albedo },
    gases: { greenhouse: greenhouseGas, anti: antiGas, neutral: neutralGas, greenhouseSide: summary.greenhouseSide, antiSide: summary.antiSide, neutralSide: summary.neutralSide, breathable: summary.breathableGas, waterVapour: summary.waterVapourGas },
    partial: false,
    // The levers that raise the dampening this plan pulls, null when it pulls none.
    dampening: raisedWater || raisedPressure ? { levers: [...(raisedWater ? [LEVER.WATER] : []), ...(raisedPressure ? [LEVER.PRESSURE] : [])] } : null,
    // Whether the solver reached the aimed mean; a body whose greenhouse or anti-greenhouse gas is at its limit does not.
    attained: Math.abs(solution.temperature - targetMean) < ATTAINED,
  }

  if (drained > 0) {
    const end = operated

    plan.target.pressure = end.AtmosPress
    plan.target.temperature = end.SurfaceTemp
    plan.target.hydrosphere = end.HydroID
    plan.target.hydroExt = end.HydroExt
    plan.target.albedo = end.Albedo
  }

  // Refresh the settled gas phases once for every consumer of this endpoint; a phase cycle has no stationary atmosphere to price.
  const endpoint = terraformedBody(body, species, plan, gasInfo)

  if (!endpoint) {
    return null
  }

  plan.target.pressure = endpoint.AtmosPress
  plan.target.temperature = endpoint.SurfaceTemp
  plan.target.hydrosphere = endpoint.HydroID
  // The same three temperatures the ending stage prices, including phase changes. No temperature tolerance can turn a nonzero priced temperature cost into a complete plan.
  const ends = temperaturePoints(endpoint)
  const low = Math.min(ends.current, ends.periapsis, ends.apoapsis)
  const high = Math.max(ends.current, ends.periapsis, ends.apoapsis)

  plan.target.temperatureLow = low
  plan.target.temperatureHigh = high
  plan.partial = low < species.MinimumTemperature || high > species.MaximumTemperature

  return plan
}

// Whether a plan leaves a breather other than oxygen paying for water. Try a drain even for a frozen target: an earlier stage may thaw it, but `sequenceDrain` must find that executable stage before any dry target is promised.
const leavesDrainableWater = (body, species, plan, gasInfo) => {
  if (species.BreatheID === GAS.OXYGEN || !(body.HydroExt > 0)) {
    return false
  }

  const end = terraformedBody(body, species, plan, gasInfo)

  return Object.values(costPoints(end, species, true)).some(({ factors }) => factors.hydrosphere > 0)
}

// One trial of the target search: retain a complete drain in preference to a wet target, and a complete wet target in preference to a partial drain. When both alternatives are partial, price both settled endpoints by whole-orbit cost, with less work breaking ties. A plan that raises the surface water (`lever.hydroExt`) drains nothing.
const planAtTemperature = (body, species, gasInfo, targetMean, hold = false, lever = NO_LEVER) => {
  const plan = planFor(body, species, gasInfo, targetMean, hold, false, lever)

  if (!plan || !leavesDrainableWater(body, species, plan, gasInfo)) {
    // A refused wet endpoint is not a prerequisite for a stationary dry one. Keep the existing drain alternative and its operation-order feasibility checks.
    return !plan && species.BreatheID !== GAS.OXYGEN && body.HydroExt > 0 && lever.hydroExt === 0 ? planFor(body, species, gasInfo, targetMean, hold, true, lever) : plan
  }

  // A plan that raises the surface water holds the water the lever sets: it drains none of it.
  if (lever.hydroExt > 0) {
    return plan
  }

  const draining = planFor(body, species, gasInfo, targetMean, hold, true, lever)

  if (!draining || (!plan.partial && draining.partial)) {
    return plan
  }

  if (!draining.partial) {
    return draining
  }

  const wetCost = leftCost(body, species, plan, gasInfo)
  const dryCost = leftCost(body, species, draining, gasInfo)

  return dryCost < wetCost || (dryCost === wetCost && draining.work < plan.work) ? draining : plan
}

// The plan for one body and species with `reached` whether the atmosphere solver attained the mean of some aim, or null as `plan` only when no candidate solves an atmosphere. Try the clamped ideal, then the 0.25 K lattice from the minimum plus the exact maximum, nearest to the ideal first (lower on ties), without duplicates or response-based pruning. At most ceil((maximum - minimum) / 0.25) + 2 trials, with the existing bounded inner solver.
// Every sampled feasible witness and every feasible aim interval strictly wider than 0.25 K inside the species' range is found. Narrower islands can be missed; this is neither a continuum nor an alternative-atmosphere guarantee. The first full plan that clears the non-oxygen water cost wins. Otherwise the fallback is the lowest final whole-orbit colony cost, with less work breaking ties, including 33 extra aims across the capped cooling-to-warming span. Drainage searches insertion points among that trial's gas operations, not extra temporary atmospheres outside the sampled aims.
const searchAims = (body, species, gasInfo, lever) => {
  const minimum = species.MinimumTemperature
  const maximum = species.MaximumTemperature
  const ideal = clamp(species.IdealTemperature, minimum, maximum)
  const initial = planAtTemperature(body, species, gasInfo, ideal, false, lever)
  let fallback = initial
  // A mean is attained where the solver reaches it: with the greenhouse or anti-greenhouse gas at its limit it falls short, and no more dampening of the swing around it can bring that body into the range.
  const attains = (plan) => !!plan && plan.attained
  let reached = attains(initial)
  const clearsWater = (plan) => !leavesDrainableWater(body, species, plan, gasInfo)

  if (initial && !initial.partial && clearsWater(initial)) {
    return { plan: initial, reached }
  }

  let fallbackCost = initial ? leftCost(body, species, initial, gasInfo) : Infinity
  const consider = (trial) => {
    if (!trial) {
      return
    }

    const cost = leftCost(body, species, trial, gasInfo)

    if (!fallback || cost < fallbackCost || (cost === fallbackCost && trial.work < fallback.work)) {
      fallback = trial
      fallbackCost = cost
    }
  }

  // Integer indices generate L + k*h for k*h < W, followed by exact U. The two pointers merge the lower and upper candidates by distance without allocating or sorting a candidate list.
  const latticeCount = Math.ceil((maximum - minimum) / TARGET_TEMPERATURE_STEP)
  const aimAt = (index) => index === latticeCount ? maximum : minimum + index * TARGET_TEMPERATURE_STEP
  let lower = Math.min(Math.floor((ideal - minimum) / TARGET_TEMPERATURE_STEP), latticeCount)
  let upper = lower + 1

  while (lower >= 0 || upper <= latticeCount) {
    const takeLower = lower >= 0 && (upper > latticeCount || ideal - aimAt(lower) <= aimAt(upper) - ideal)
    const aim = aimAt(takeLower ? lower-- : upper++)

    if (aim === ideal) {
      continue
    }

    const trial = planAtTemperature(body, species, gasInfo, aim, false, lever)

    if (trial && !trial.partial && clearsWater(trial)) {
      return { plan: trial, reached: true }
    }

    reached = reached || attains(trial)
    consider(trial)
  }

  // A hot periapsis can need a mean below the species' minimum, even with a cold present position. Both gas multipliers cap at 3; sample that physical span rather than forcing the mean into the comfort range.
  const reference = body.BaseTemp * body.Albedo

  for (let index = 0; index <= PARTIAL_TEMPERATURE_RUNGS; index += 1) {
    const aim = reference * (1 / 3 + (3 - 1 / 3) * index / PARTIAL_TEMPERATURE_RUNGS)

    if (aim < minimum || aim > maximum) {
      consider(planAtTemperature(body, species, gasInfo, aim, false, lever))
    }
  }

  return { plan: fallback, reached }
}

// The rungs of each lever ladder: the surface water from what the body holds to the whole surface, the pressure from what it holds to what the species bears (the dampening's pressure term stops at 5 atm), and both together; each ladder in `LEVER_RUNGS` equal steps, weakest first. Empty for a body whose orbit is circular (no seasons to damp) and for a lever that has no room left.
const leverLadders = (body, species) => {
  const { distance, eccentricity } = orbitOf(body)

  if (!(distance > 0 && eccentricity > 0) || !Number.isFinite(body.HydroExt) || !Number.isFinite(body.AtmosPress)) {
    return []
  }

  const rungs = (from, to) => (to > from ? Array.from({ length: LEVER_RUNGS }, (_, index) => from + (to - from) * (index + 1) / LEVER_RUNGS) : [])
  const waters = rungs(Math.max(body.HydroExt, 0), 100)
  const airs = rungs(Math.max(body.AtmosPress, 0), Math.min(DAMPENING_PRESSURE, species.MaximumPressure))

  return [
    waters.map((hydroExt) => ({ hydroExt, pressure: 0 })),
    airs.map((pressure) => ({ hydroExt: 0, pressure })),
    waters.length && airs.length ? waters.map((hydroExt, index) => ({ hydroExt, pressure: airs[index] })) : [],
  ].filter((ladder) => ladder.length)
}

// The colony cost a plan leaves, worst of the three priced points before the race's skill; Infinity where no colony can stand on the body.
const leftCost = (body, species, plan, gasInfo) => {
  const cost = colonyCost(terraformedBody(body, species, plan, gasInfo), species, 1, true)

  return cost.colonisable ? cost.raw : Infinity
}

// The weakest rung of a ladder with a plan that `fits`, taking the more dampening a rung pulls, the more of the whole orbit's swing a plan can hold in the species' range (a rung that fits is not followed by one that does not): the top rung first, which ends a ladder that cannot fit at all, then a bisection down; at most 1 + log2(LEVER_RUNGS) searches of the aims.
const weakestRung = (ladder, fits) => {
  let found = fits(ladder[ladder.length - 1])

  if (!found) {
    return null
  }

  let low = 0
  let high = ladder.length - 1

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const plan = fits(ladder[middle])

    if (plan) {
      found = plan
      high = middle
    } else {
      low = middle + 1
    }
  }

  return found
}

// Where no aim of the greenhouse and anti-greenhouse gases fits both extremes in the species' range but some aim's mean is attained, the body's own dampening can be raised: more surface water, more pressure, or both. Of the three ladders the plan that moves the least work wins; it must fit the whole orbit, need only gases the table has figures of and leave a lower colony cost than the plan with no lever (a lever the species pays for, such as the liquid water of a breather other than oxygen, is no gain when it costs more than the temperature it saves). Null when no rung does.
const raisedDampening = (body, species, gasInfo, partial) => {
  const baseline = leftCost(body, species, partial, gasInfo)
  const fits = (lever) => {
    const { plan } = searchAims(body, species, gasInfo, lever)

    return plan && !plan.partial && plan.dampening && !planGasGaps(species, plan, gasInfo).length && leftCost(body, species, plan, gasInfo) < baseline ? plan : null
  }

  return leverLadders(body, species).map((ladder) => weakestRung(ladder, fits)).reduce((best, plan) => (plan && (!best || plan.work < best.work) ? plan : best), null)
}

// The plan for one body and species, or null only when no candidate solves an atmosphere. The search of the aims, and where it leaves an extreme outside the species' range although some aim's mean is attained, the cheapest plan that also pulls a dampening lever.
export const planTerraforming = (body, species, gasInfo) => {
  const { plan, reached } = searchAims(body, species, gasInfo, NO_LEVER)

  return plan && plan.partial && reached ? raisedDampening(body, species, gasInfo, plan) || plan : plan
}

// The gases a plan ends the atmosphere with, as [id, atm, the body's own row of the gas or undefined]; the gases it removes are not in it.
const planAdditions = (species, plan) => {
  const { target, gases } = plan

  return [
    [species.BreatheID, target.breathable, gases.breathable],
    [GAS.WATER_VAPOUR, target.water, gases.waterVapour],
    [gases.greenhouse.id, target.greenhouse - target.sideGreenhouse],
    ...gases.greenhouseSide.map((gas) => [gas.AtmosGasID, gas.GasAtm, gas]),
    [gases.anti.id, target.antiGreenhouse - target.sideAnti],
    ...gases.antiSide.map((gas) => [gas.AtmosGasID, gas.GasAtm, gas]),
    [gases.neutral.id, target.neutral - target.sideNeutral],
    ...gases.neutralSide.map((gas) => [gas.AtmosGasID, gas.GasAtm, gas]),
  ]
}

const addedGas = (id, amount) => Number.isFinite(amount) && amount > 0 && id

const GAS_FIELDS = ['FreezingPoint', 'GHGas', 'AntiGHGas']

// The DIM_Gases rows (`gasInfo(id)`) a plan needs to price its end state that the save lacks, or holds no figure of, by name: only gases the plan adds (an amount above 0) that the body has no row of itself. The danger it needs is the pair of the species' breathing gas.
export const planGasGaps = (species, plan, gasInfo) => {
  const ids = planAdditions(species, plan).filter(([id, amount, existing]) => {
    if (!addedGas(id, amount) || existing) {
      return false
    }

    const info = gasInfo(id)

    return !info || !GAS_FIELDS.every((field) => Number.isFinite(info[field])) || !Object.values(gasDanger(info, species.BreatheID)).every(Number.isFinite)
  }).map(([id]) => id)

  return [...new Set(ids)].map((id) => `the properties of gas ${id}`)
}

// At the refreshed held-position climate neither water process may move more than the numerical allowance. Hot vapour is one-sided: condensation is disabled, so an excess may remain.
const waterIsStationary = (body) => {
  const extent = body.HydroExt
  const phase = body.HydroID
  const vapour = body.Atmosphere.filter((gas) => gas.AtmosGasID === GAS.WATER_VAPOUR).reduce((sum, gas) => sum + gas.GasAtm, 0)
  const liquidTarget = body.AtmosPress * (extent / 100) * HUMIDITY

  if (phase === HYDROSPHERE.NONE && extent > 0) {
    return false
  }

  if (body.SurfaceTemp <= 369 && vapour - (phase === HYDROSPHERE.LIQUID ? liquidTarget : 0) > WATER_STATIONARITY_ALLOWANCE) {
    return false
  }

  return !(extent > 0 && [HYDROSPHERE.LIQUID, HYDROSPHERE.VAPOUR].includes(phase) && (phase === HYDROSPHERE.LIQUID ? liquidTarget : extent / HYDRO_PER_ATM) - vapour > WATER_STATIONARITY_ALLOWANCE)
}

// The settled atmosphere a plan ends with. Water moves between the supplied vapour and surface without changing their combined inventory. Trials whose refreshed climate contradicts the proposed water transfer or ice albedo are discarded, not ranked.
export const terraformedBody = (body, species, plan, gasInfo) => {
  const { target } = plan
  const drained = (plan.steps || []).reduce((sum, step) => sum + (step.drained || 0), 0)
  const transferred = (target.hydroExt - body.HydroExt + drained) / HYDRO_PER_ATM
  const waterStep = plan.steps?.find((step) => step.gasId === GAS.WATER_VAPOUR)
  const suppliedWater = plan.steps ? waterStep?.set ?? body.Atmosphere.filter((gas) => gas.AtmosGasID === GAS.WATER_VAPOUR).reduce((sum, gas) => sum + gas.GasAtm, 0) : target.water

  // A smaller surface without a completed drain needs a water-balance solution, not an arbitrary extent target. This bounded search does not promise that evaporation.
  if (transferred < 0) {
    return null
  }

  if (suppliedWater - transferred < -1e-10) {
    return null
  }

  const atmosphere = []

  planAdditions(species, plan).forEach(([id, supplied, existing]) => {
    const amount = id === GAS.WATER_VAPOUR ? Math.max(0, suppliedWater - transferred) : supplied
    if (!addedGas(id, amount)) {
      return
    }

    const info = existing || gasInfo(id) || {}

    atmosphere.push({ AtmosGasID: id, AtmosGasName: info.AtmosGasName || info.Name || 'Unknown', GasAtm: amount, FreezingPoint: info.FreezingPoint || 0, GHGas: info.GHGas || 0, AntiGHGas: info.AntiGHGas || 0, ...dangerColumnsOf(info), FrozenOut: false })
  })

  const endpoint = refreshAtmosphere(body, atmosphere, target.hydroExt, target.albedo, target.temperature)

  if (!endpoint || (transferred > 0 && endpoint.SurfaceTemp > 369)) {
    return null
  }

  // A phase change after solving would require another albedo/climate solution. Keep this bounded model conservative instead of retaining the old phase's albedo.
  const expectedAlbedo = albedoForHydrosphere(body.Albedo, body.HydroID, endpoint.HydroID, body.HydroExt)

  if (!(Math.abs(endpoint.Albedo - expectedAlbedo) < 1e-10)) {
    return null
  }

  return waterIsStationary(endpoint) ? endpoint : null
}

// Whether the body suits the species as it is, its surface water apart: gravity, the temperature at each point the colony cost prices, the breathing gas, the pressure and no toxic gas, which for each gas means the breather's own test (a rating, a share over its limit, not frozen out), water vapour included. The temperatures are `temperaturePoints`, the same phase-aware prediction the stage costs read, so an ice-albedo or gas-phase change at an extreme counts against liveability.
const suitsClimate = (body, species) => {
  const { current, periapsis, apoapsis } = temperaturePoints(body)
  const summary = summariseAtmosphere(body, species)
  const breatheMin = Math.max(0, species.MinimumBreathablePressure)
  const within = (temperature) => temperature >= species.MinimumTemperature && temperature <= species.MaximumTemperature

  return body.Gravity >= species.MinimumGravity && body.Gravity <= species.MaximumGravity && within(current) && within(periapsis) && within(apoapsis) && summary.breathable >= breatheMin - TOLERANCE && summary.breathable <= species.MaximumBreathablePressure + TOLERANCE && summary.total <= species.MaximumPressure + TOLERANCE && summary.toxic <= TOLERANCE && !summary.waterDangerous
}

// Whether the surface water costs a breather other than oxygen anything at a point the colony cost prices (liquid water by its extent, and for sulphur dioxide ice as well): such a body is not done, however well its air suits. An oxygen breather's own water term (below 20 %) is left to the plan, as the verdict has always left it.
const paysForSurfaceWater = (body, species) => species.BreatheID !== GAS.OXYGEN && Object.values(costPoints(body, species)).some(({ factors }) => factors.hydrosphere > 0)

// Hold an already suitable climate only if the water cost is cleared too. Otherwise the bounded aim search must be allowed to find a warmer thaw-and-drain target.
const planHolding = (body, species, gasInfo) => {
  const plan = planAtTemperature(body, species, gasInfo, body.SurfaceTemp, true)

  return plan && !plan.partial && !leavesDrainableWater(body, species, plan, gasInfo) ? plan : null
}

// Everything to know about terraforming one body for one species, whatever the colony's capacity: the plan, its work, what its years are (`timeBasis`, see `TIME_BASIS`: a plan that drains the surface water has only a minimum), the cost after it and the outcome. `gasInfo(id)` is the DIM_Gases row of a gas. When the plan introduces a gas the table holds no figures of, the result has `missing` (the rows, by name) and no outcome of the plan: the plan cannot be priced, so it is not known to be worse or better.
export const assessTerraforming = (body, species, skill, gasInfo) => {
  const cost = colonyCost(body, species, skill)
  const lowGravity = body.Gravity < species.MinimumGravity
  const base = { cost, lowGravity, gravityClass: cost.colonisable ? cost.gravityClass : null, plan: null, work: 0, timeBasis: TIME_BASIS.CAPACITY, after: cost.colonisable ? cost : null, outcome: 'no', reason: null }

  if (!cost.colonisable) {
    return { ...base, reason: cost.reason }
  }

  const suited = suitsClimate(body, species)

  if (suited && !paysForSurfaceWater(body, species)) {
    return { ...base, outcome: 'done' }
  }

  if (body.Gravity < MINIMUM_TERRAFORMING_GRAVITY) {
    return { ...base, reason: 'Too light to keep an atmosphere' }
  }

  const plan = (suited && planHolding(body, species, gasInfo)) || planTerraforming(body, species, gasInfo)

  if (!plan) {
    return { ...base, reason: 'No change of atmosphere in the bounded search lowers the colony cost', outcome: outcomeFromCosts(cost, lowGravity) }
  }

  const missing = planGasGaps(species, plan, gasInfo)

  // Pricing the end state needs the figures of every gas the plan introduces; without them the plan is neither worse nor better, it is unknown.
  if (missing.length) {
    return { ...base, missing }
  }

  const target = terraformedBody(body, species, plan, gasInfo)
  const planned = colonyCost(target, species, skill, true)
  const improvesCost = planned.raw < cost.raw
  const meetsOtherGoal = body.Atmosphere.some((gas) => isDangerousGas(gas, species, body.SurfaceTemp, false) && plan.steps.some((step) => step.gasId === gas.AtmosGasID && step.set < gas.GasAtm) && !target.Atmosphere.some((after) => after.AtmosGasID === gas.AtmosGasID && isDangerousGas(after, species, target.SurfaceTemp, true)))
  const reason = leavesDrainableWater(body, species, plan, gasInfo) ? 'Surface water remains: the bounded search found no drain that completes after a thaw and leaves the whole orbit within the species temperature range' : null

  // Compare the same worst-of-orbit cost the header, ending stage and ranking use. Equal-cost work is useful only when it also removes a dangerous gas; retain the complete plan so its operations and priced end state agree.
  if (planned.raw > cost.raw || (!improvesCost && !meetsOtherGoal)) {
    return { ...base, reason: 'No change of atmosphere in the bounded search lowers the colony cost', outcome: outcomeFromCosts(cost, lowGravity) }
  }

  return { ...base, reason, plan, work: plan.work, timeBasis: planTimeBasis(plan), after: planned, outcome: outcomeFromCosts(planned, lowGravity) }
}

// Years a plan takes at a yearly capacity (atm of an Earth-sized body); Infinity without capacity.
export const planYears = (work, capacity) => (work <= 0 ? 0 : capacity > 0 ? work / capacity : Infinity)

// What the years of a plan are. `capacity`: the terraformers' time for the plan's work, the estimate of every plan that takes no surface water off. `minimum`: a plan that drains the surface takes at least that time and no more is known. The terraformer removes only the water vapour in the air and the surface adds vapour only by evaporation, in steps that depend on the vapour already there, so more installations do not shorten the drain and it can take longer than their capacity needs. That evaporation is not modelled: no tick is replayed.
export const TIME_BASIS = Object.freeze({ CAPACITY: 'capacity', MINIMUM: 'minimum' })

// The reason a drain's time is a minimum, for every place that shows the figure.
export const MINIMUM_TIME_NOTE = 'A minimum, not a finishing date: the terraformers remove only the water vapour in the air, and the surface evaporates more into it only in small steps and only while it is thawed, so the drain can take longer than their capacity needs, however many installations work.'

// The basis of the years of one step and of a plan: a step that takes surface water off is a minimum, and so is a plan with such a step.
export const stepTimeBasis = (step) => (step.drained > 0 ? TIME_BASIS.MINIMUM : TIME_BASIS.CAPACITY)
export const planTimeBasis = (plan) => (plan && plan.steps.some((step) => step.drained > 0) ? TIME_BASIS.MINIMUM : TIME_BASIS.CAPACITY)

const DAYS_PER_YEAR = 365

// A figure floored to the decimals it is written at, so that a lower bound never reads above itself. The product is read at 15 significant digits, which takes up the binary error of the scale that would otherwise floor a figure written at those decimals, 0.29 years to 0.28 (0.29 * 100 is 28.999999999999996). A figure the reading lifts above the value it comes from steps down to the figure below it: the comparison is against the double the caller passed, so a bound just under a decimal is written under it, not at it.
const floored = (value, places) => {
  const scale = 10 ** places
  let out = Math.floor(Number((value * scale).toPrecision(15))) / scale

  if (out > value) {
    out = Math.round(out * scale - 1) / scale
  }

  return out
}

// The years of a time of `basis` in words, `text` being how the page writes years at `places` decimals: a minimum is "at least" them, floored to those decimals so that no figure stands above the bound it names, and given in days where the years read "under 0.1 years", so that "at least" never stands before "under". Years that are not a finite number (no terraformers) read as `text` gives them. The time of a plan that drains nothing is the terraformers' estimate, and keeps `text`'s nearest rounding.
export const timeWords = (years, basis, text, places = 1) => {
  if (basis !== TIME_BASIS.MINIMUM || !Number.isFinite(years)) {
    return text(years)
  }

  const days = years * DAYS_PER_YEAR

  return `at least ${years >= 0.1 ? text(floored(years, places)) : days >= 0.1 ? `${floored(days, 1)} days` : 'a fraction of a day'}`
}

// The Earth-equivalent atm a colony of `terraformers` installations or orbital modules can move in a year: racial rate times the game's terraforming speed setting (as a percentage).
export const terraformCapacity = ({ TerraformingRate, TerraformingSpeed }, terraformers, modifier = 1) => TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier

// Infrastructure per million people on the colony the plan leaves.
export const afterInfrastructure = (assessment, species) => (assessment.after ? infrastructurePerMillion(assessment.after.worst, species, assessment.lowGravity) : null)
