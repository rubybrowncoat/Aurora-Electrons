// Terraforming plans: which gases to add or remove to make a body liveable for a species, how much work
// that is, and what the body costs afterwards. The game terraforms one gas at a time per colony, adding or
// removing atm at the colony's capacity scaled by the body's surface area,
// so a plan's work is the sum over its gases. See docs/DATABASE.md § Terraforming.
//
// The plan itself is the page's long-standing heuristic (a target atmosphere that centres the species'
// temperature and breathing ranges, found by iterating the greenhouse balance). It is checked against the
// game's formulas, not against a played-out terraform.

import { GAS, HYDROSPHERE, MINIMUM_TERRAFORMING_GRAVITY, colonyCost, hydrosphereAtTemperature, infrastructurePerMillion, orbitOf } from './habitability'

export const EARTH_SURFACE_AREA = 511187128
// Water vapour condenses at this many atm a year and evaporates at this many; a hydro
// extent of 1 % is 1/40 atm of vapour.
export const CONDENSATION_RATE = 0.1
export const EVAPORATION_RATE = 4
export const HYDRO_PER_ATM = 40
const HUMIDITY = 0.01

const TOLERANCE = 1e-4
const GAS_AESTUSIUM = 20
const GAS_FRIGUSIUM = 22
const GAS_NITROGEN = 7

// How a body ends up after terraforming, best first. An outcome reads the colony costs the player pays, so
// the race's colonisation skill (a multiplier under 1 with the tech) counts, as in the game's own lists.
export const OUTCOMES = {
  done: { label: 'Done', description: 'Already liveable for this species; nothing to terraform.', color: 'success' },
  yes: { label: 'Yes', description: 'Terraforming makes it free to colonise.', color: 'success' },
  partial: { label: 'Partial', description: 'Free to colonise at part of its orbit.', color: 'info' },
  near: { label: 'Near', description: 'Ends under 2: cheap, but not free.', color: 'teal' },
  limited: { label: 'Limited', description: 'Ends under 4.', color: 'warning' },
  insufficient: { label: 'Insufficient', description: 'Terraforming helps, but the colony stays expensive.', color: 'deep-orange' },
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

const swingRatios = (body) => {
  const { distance, eccentricity } = orbitOf(body)
  let low = 1
  let high = 1

  if (Number.isFinite(distance) && distance > 0 && Number.isFinite(eccentricity) && eccentricity > 0) {
    low = Math.min(1, Math.sqrt(distance / (distance * (1 + eccentricity))))

    const periapsis = distance * (1 - eccentricity)

    if (periapsis > 0) {
      high = Math.max(1, Math.sqrt(distance / periapsis))
    } else if (eccentricity < 1) {
      high = Math.sqrt(distance / (distance * 0.0001))
    }
  }

  return { low, high }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// Pressures by role: the species' breathing gas, other dangerous gases, water vapour, greenhouse and
// anti-greenhouse gases, and everything else (neutrals).
const summariseAtmosphere = (body, species) => {
  const summary = { breathable: 0, breathableGas: null, toxic: 0, toxics: [], greenhouse: 0, greenhouses: [], antiGreenhouse: 0, antiGreenhouses: [], waterVapour: 0, waterVapourGas: null, neutral: 0, neutrals: [], total: 0 }

  body.Atmosphere.forEach((gas) => {
    const pressure = Number.isFinite(gas.GasAtm) ? gas.GasAtm : 0

    summary.total += pressure

    if (gas.AtmosGasID === species.BreatheID) {
      summary.breathable += pressure
      summary.breathableGas = gas
    } else if (gas.Dangerous) {
      summary.toxic += pressure
      summary.toxics.push(gas)
    } else if (gas.AtmosGasID === GAS.WATER_VAPOUR) {
      summary.waterVapour += pressure
      summary.waterVapourGas = gas
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

  return summary
}

const hydrosphereState = (temperature, pressure) => {
  if (!Number.isFinite(pressure) || pressure <= 0 || (pressure < 0.006 && temperature > 245)) {
    return HYDROSPHERE.NONE
  }

  return hydrosphereAtTemperature(temperature)
}

// Aim for 20 % water (no colony cost), then for what keeps the most people: liquid water between 50 and
// 75 % (above 75 % the body holds fewer people), ice anywhere.
const targetHydroExtent = (current, hydrosphere) => {
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

// Vapour in balance with the water on the surface; only liquid water keeps any in the air.
const equilibriumVapour = (hydrosphere, extent, pressure) => (hydrosphere === HYDROSPHERE.LIQUID && Number.isFinite(extent) && extent >= 0 ? Math.max(pressure, 0) * (extent / 100) * HUMIDITY : 0)

// The ice sheet reflects more than bare rock: changing between the two moves the albedo.
const albedoForHydrosphere = (baseAlbedo, was, now, extent) => {
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

const multipliers = (total, greenhouse, anti, dust) => ({
  greenhouse: Math.min(3, 1 + Math.max(total, 0) / 10 + Math.max(greenhouse, 0)),
  anti: Math.min(3, 1 + dust + Math.max(anti, 0)),
})

// Solves the atmosphere for one albedo. Returns null when the species can't hold it (too much pressure).
const solveAtmosphere = (body, species, albedo, goal, keepNeutralGas) => {
  const { summary, targetBreathable, targetMean, sideNeutral, sideGreenhouse, sideAnti, dust } = goal
  const baseReference = Math.max(body.BaseTemp * albedo, 1)

  if (!Number.isFinite(baseReference) || baseReference <= 0) {
    return null
  }

  const targetRatio = targetMean / baseReference
  const ratioOf = (total, greenhouse, anti) => {
    const { greenhouse: gh, anti: agh } = multipliers(total, greenhouse, anti, dust)

    return gh / (agh || 1)
  }

  let water = Math.min(Math.max(summary.waterVapour, 0), species.MaximumPressure)
  let neutralMain = Math.min(Math.max(summary.neutral - sideNeutral, 0), Math.max(species.MaximumPressure - sideNeutral, 0))

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
    const minimum = Math.max(sideNeutral, targetBreathable > 0 ? targetBreathable / 0.3 - fixed : sideNeutral)
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
    extent = targetHydroExtent(body.HydroExt, hydrosphere)
    water = Math.min(Math.max(equilibriumVapour(hydrosphere, extent, total), 0), species.MaximumPressure)

    const error = ratio - targetRatio

    if (Math.abs(error) < TOLERANCE && Math.abs(neutralMain - previousNeutral) < TOLERANCE && Math.abs(water - previousWater) < TOLERANCE) {
      break
    }

    if (Math.abs(error) >= TOLERANCE) {
      // Too warm: cut the greenhouse gas, or add anti-greenhouse gas. Too cold: the other way round.
      // A multiplier stops at 3, so each gas has a ceiling.
      const maxGreenhouse = Math.max(0, 2 - total / 10)
      const maxAnti = Math.max(0, 2 - dust)

      if (error > 0) {
        const adjustable = Math.max(greenhouse - sideGreenhouse, 0)

        if (adjustable > TOLERANCE) {
          greenhouse = Math.min(sideGreenhouse + adjustable * (targetRatio / ratio), maxGreenhouse)
        } else {
          const room = Math.max(0, species.MaximumPressure - total)

          if (room <= TOLERANCE) {
            return null
          }

          const delta = Math.min(Math.min(Math.max(error, TOLERANCE), room), maxAnti - anti)

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
  extent = targetHydroExtent(body.HydroExt, hydrosphere)

  // Reaching a wetter target means more vapour than the equilibrium: the excess condenses onto the surface.
  const equilibrium = equilibriumVapour(hydrosphere, extent, total)
  const increase = extent - body.HydroExt
  const wanted = increase > 0 ? equilibrium + increase / HYDRO_PER_ATM : equilibrium

  if (wanted >= 0 && wanted <= species.MaximumPressure && targetBreathable + wanted + greenhouse + anti + neutral <= species.MaximumPressure + TOLERANCE) {
    water = wanted
  }

  return { water, greenhouse, anti, neutral, total, temperature, hydrosphere, extent, albedo }
}

// The water step ends when the vapour is in the air; the surface then adjusts by itself, slowly.
const hydrosphereSettling = (body, solution) => {
  const change = solution.extent - body.HydroExt

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

// The plan for one body and species, or null when there is no atmosphere that suits the species. Work is
// in Earth-equivalent atm: the atm to add or remove times the body's surface area over the Earth's.
// Divide by a colony's yearly capacity (atm of an Earth-sized body) for the years.
export const planTerraforming = (body, species) => {
  const area = 4 * Math.PI * body.Radius ** 2
  const areaRatio = area / EARTH_SURFACE_AREA

  if (!(area > 0)) {
    return null
  }

  const summary = summariseAtmosphere(body, species)
  const { low, high } = swingRatios(body)
  const sideGreenhouse = summary.greenhouses.slice(1).reduce((total, gas) => total + (gas.GasAtm || 0), 0)
  const sideAnti = summary.antiGreenhouses.slice(1).reduce((total, gas) => total + (gas.GasAtm || 0), 0)
  const sideNeutral = summary.neutrals.slice(1).reduce((total, gas) => total + (gas.GasAtm || 0), 0)

  // Breathing gas: the nearest edge of the species' range, or where it already is inside it.
  const breatheMin = Math.max(0, species.MinimumBreathablePressure)
  const breatheMax = species.MaximumBreathablePressure
  const nearer = Math.abs(summary.breathable - breatheMin) <= Math.abs(summary.breathable - breatheMax) ? breatheMin : breatheMax
  const targetBreathable = clamp(summary.breathable >= breatheMin - TOLERANCE && summary.breathable <= breatheMax + TOLERANCE ? clamp(summary.breathable, breatheMin, breatheMax) : nearer, breatheMin, breatheMax)

  // Temperature: the mean that keeps both ends of an eccentric orbit inside the range, else the best compromise.
  const minAllowed = species.MinimumTemperature / (low || 1)
  const maxAllowed = species.MaximumTemperature / (high || 1)
  let partial = false
  let targetMean

  if (minAllowed > maxAllowed) {
    targetMean = (minAllowed + maxAllowed) / 2
    partial = true
  } else {
    targetMean = clamp(species.IdealTemperature, minAllowed, maxAllowed)
  }

  const goal = { summary, targetBreathable, targetMean, sideNeutral, sideGreenhouse, sideAnti, dust: Math.max(Number.isFinite(body.DustLevel) ? body.DustLevel : 0, 0) / 20000 }
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

  const temperatureLow = solution.temperature * low
  const temperatureHigh = solution.temperature * high

  if (temperatureLow < species.MinimumTemperature - 0.5 || temperatureHigh > species.MaximumTemperature + 0.5) {
    partial = true
  }

  // The gas each role is added as: a gas already there, else the game's usual one.
  const role = (list, id, name) => (list.length ? { id: list[0].AtmosGasID, name: list[0].AtmosGasName } : { id, name })
  const greenhouseGas = role(summary.greenhouses, GAS_AESTUSIUM, 'Aestusium')
  const antiGas = role(summary.antiGreenhouses, GAS_FRIGUSIUM, 'Frigusium')
  const neutralGas = role(summary.neutrals, GAS_NITROGEN, 'Nitrogen')
  const settling = hydrosphereSettling(body, solution)
  // `set` is the figure to type into the game for the named gas: the role's total less the side gases it keeps.
  const step = (key, label, gasId, from, to, set = to) => ({ key, label, gasId, from, to, set, atm: Math.abs(to - from), work: Math.abs(to - from) * areaRatio })
  const steps = [
    ...summary.toxics.map((gas) => step('toxic', gas.AtmosGasName, gas.AtmosGasID, gas.GasAtm, 0)),
    step('water', 'Water Vapour', GAS.WATER_VAPOUR, summary.waterVapour, solution.water),
    step('breathable', species.BreatheName, species.BreatheID, summary.breathable, targetBreathable),
    step('greenhouse', greenhouseGas.name, greenhouseGas.id, summary.greenhouse, solution.greenhouse, solution.greenhouse - sideGreenhouse),
    step('antiGreenhouse', antiGas.name, antiGas.id, summary.antiGreenhouse, solution.anti, solution.anti - sideAnti),
    step('neutral', neutralGas.name, neutralGas.id, summary.neutral, solution.neutral, solution.neutral - sideNeutral),
  ].filter((candidate) => candidate.work >= TOLERANCE * areaRatio)

  return {
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
      temperatureLow,
      temperatureHigh,
      hydrosphere: solution.hydrosphere,
      hydroExt: solution.extent,
      albedo: solution.albedo,
    },
    from: { pressure: summary.total, breathable: summary.breathable, albedo: body.OriginalAlbedo ?? body.Albedo },
    gases: { greenhouse: greenhouseGas, anti: antiGas, neutral: neutralGas, greenhouseSide: summary.greenhouses.slice(1), antiSide: summary.antiGreenhouses.slice(1), neutralSide: summary.neutrals.slice(1), breathable: summary.breathableGas, waterVapour: summary.waterVapourGas },
    partial,
  }
}

// The atmosphere a plan ends with, as a body would hold it, for pricing the colony after terraforming.
export const terraformedBody = (body, species, plan, gasInfo) => {
  const { target, gases } = plan
  const atmosphere = []
  const add = (id, amount, existing) => {
    if (!Number.isFinite(amount) || amount <= 0 || !id) {
      return
    }

    const info = existing || gasInfo(id) || {}

    atmosphere.push({ AtmosGasID: id, AtmosGasName: info.AtmosGasName || info.Name || 'Unknown', GasAtm: amount, AtmosGasAmount: amount, BoilingPoint: info.BoilingPoint || 0, GHGas: info.GHGas || 0, AntiGHGas: info.AntiGHGas || 0, Dangerous: info.Dangerous || 0, DangerousLevel: info.DangerousLevel || 0, FrozenOut: false })
  }

  add(species.BreatheID, target.breathable, gases.breathable)
  add(GAS.WATER_VAPOUR, target.water, gases.waterVapour)
  add(gases.greenhouse.id, target.greenhouse - target.sideGreenhouse)
  gases.greenhouseSide.forEach((gas) => add(gas.AtmosGasID, gas.GasAtm, gas))
  add(gases.anti.id, target.antiGreenhouse - target.sideAnti)
  gases.antiSide.forEach((gas) => add(gas.AtmosGasID, gas.GasAtm, gas))
  add(gases.neutral.id, target.neutral - target.sideNeutral)
  gases.neutralSide.forEach((gas) => add(gas.AtmosGasID, gas.GasAtm, gas))

  let greenhouse = 0
  let anti = 0

  atmosphere.forEach((gas) => {
    greenhouse += gas.GHGas ? gas.GasAtm : 0
    anti += !gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0
  })

  const surface = Math.max(1, (body.BaseTemp * Math.min(3, 1 + target.pressure / 10 + greenhouse) * target.albedo) / Math.min(3, 1 + body.DustLevel / 20000 + anti))

  return { ...body, SurfaceTemp: surface, Albedo: target.albedo, AtmosPress: target.pressure, HydroExt: target.hydroExt, HydroID: target.hydrosphere, Atmosphere: atmosphere }
}

// Whether the body suits the species as it is: gravity, both ends of the temperature swing, the breathing gas, the
// pressure and no toxic gas.
const isLiveable = (body, species) => {
  const { low, high } = swingRatios(body)
  const summary = summariseAtmosphere(body, species)
  const breatheMin = Math.max(0, species.MinimumBreathablePressure)

  return (
    body.Gravity >= species.MinimumGravity &&
    body.Gravity <= species.MaximumGravity &&
    body.SurfaceTemp * low >= species.MinimumTemperature &&
    body.SurfaceTemp * high <= species.MaximumTemperature &&
    summary.breathable >= breatheMin - TOLERANCE &&
    summary.breathable <= species.MaximumBreathablePressure + TOLERANCE &&
    summary.total <= species.MaximumPressure + TOLERANCE &&
    summary.toxic <= TOLERANCE
  )
}

const equalCosts = (a, b) => Math.abs(a.current - b.current) < 0.01 && Math.abs(a.periapsis - b.periapsis) < 0.01 && Math.abs(a.apoapsis - b.apoapsis) < 0.01

// Everything to know about terraforming one body for one species, whatever the colony's capacity:
// the plan, its work, the cost after it and the outcome. `gasInfo(id)` is the DIM_Gases row of a gas.
export const assessTerraforming = (body, species, skill, gasInfo) => {
  const cost = colonyCost(body, species, skill)
  const lowGravity = body.Gravity < species.MinimumGravity
  const base = { cost, lowGravity, plan: null, work: 0, after: cost.colonisable ? cost : null, outcome: 'no', reason: null }

  if (!cost.colonisable) {
    return { ...base, reason: cost.reason }
  }

  if (isLiveable(body, species)) {
    return { ...base, outcome: 'done' }
  }

  if (body.Gravity < MINIMUM_TERRAFORMING_GRAVITY) {
    return { ...base, reason: 'Too light to keep an atmosphere' }
  }

  const plan = planTerraforming(body, species)

  if (!plan) {
    return { ...base, reason: 'No atmosphere suits the species' }
  }

  const target = terraformedBody(body, species, plan, gasInfo)
  const planned = colonyCost(target, species, skill, true)
  const before = cost.raws
  const after = planned.raws
  const worse = after.current > before.current && after.periapsis > before.periapsis && after.apoapsis > before.apoapsis

  // A plan that makes things worse is no plan: the body stays as it is.
  if (worse) {
    return { ...base, reason: 'Terraforming would make it worse', outcome: outcomeFromCosts(cost, lowGravity) }
  }

  // A plan that doesn't improve the cost is only worth its toxic-gas removal.
  if (equalCosts(after, before)) {
    const toxic = plan.steps.filter((candidate) => candidate.key === 'toxic')

    if (!toxic.length) {
      return { ...base, outcome: outcomeFromCosts(cost, lowGravity), reason: 'Nothing to gain' }
    }

    return { ...base, plan: { ...plan, steps: toxic, work: toxic.reduce((total, candidate) => total + candidate.work, 0) }, after: planned, outcome: outcomeFromCosts(planned, lowGravity) }
  }

  return { ...base, plan, work: plan.work, after: planned, outcome: outcomeFromCosts(planned, lowGravity) }
}

// Years a plan takes at a yearly capacity (atm of an Earth-sized body); Infinity without capacity.
export const planYears = (work, capacity) => (work <= 0 ? 0 : capacity > 0 ? work / capacity : Infinity)

// The Earth-equivalent atm a colony of `terraformers` installations or orbital modules can move in a year:
// racial rate times the game's terraforming speed setting (as a percentage).
export const terraformCapacity = ({ TerraformingRate, TerraformingSpeed }, terraformers, modifier = 1) => TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier

// Infrastructure per million people on the colony the plan leaves.
export const afterInfrastructure = (assessment, species) => (assessment.after ? infrastructurePerMillion(assessment.after.worst, species, assessment.lowGravity) : null)
