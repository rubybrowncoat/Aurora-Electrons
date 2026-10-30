// What limits the colony cost after each gas operation of a terraforming plan: the stages of the Planner's plan, each priced with the same colony cost factors as the body detail, and for each stage the factors that set the cost (all of them where several are equal) and the factors that would set it next. See docs/DATABASE.md § Terraforming.
//
// A stage is `{ index, kind ('start', 'step', 'settle' or 'target', the plan's end state when it has no gas operation to carry it), step (the plan step, null for the others), pressure, temperature, hydroExt, cost: { current, periapsis, apoapsis, raw, worst }, points: { current, periapsis, apoapsis } (the cost factors there, each `{ cost, factors, ... }` as `costPoints` gives them), limiting, next, revealed, cleared, overtaken, blocked, result }`. `limiting` and `next` are lists of `{ key, label, value, fixed, at }`, `at` the points of the orbit where the factor stands; a factor is `fixed` when no gas operation changes it (gravity). `next` includes the breathing penalty that a larger factor hides, as the colony cost only counts it below 2. `revealed` are the keys that began to set the cost with this stage; of those that ceased to, `cleared` are the ones whose penalty fell (never a fixed one) and `overtaken` the ones another factor only rose above.
//
// The first stage is the body as saved, priced by the same function as the body detail's factor bars. Every later stage is the plan carried one more gas operation, in the plan's order, each taken in full, on the water extent as saved. The plan's own end state (`terraformedBody`, the atmosphere and water the body detail prices after terraforming) is the stage that settles the surface when the water condenses or evaporates over years after the water step, else the stage of the last operation, so the plan's end agrees with the cost the Planner shows after terraforming.

import { BODY_CLASS, BREATHING_PENALTY, FACTORS, breathingFails, costPoints, limitingFactors } from './habitability'
import { albedoForHydrosphere, hydrosphereState, terraformedBody } from './terraforming'
import { ofRule, registerRule } from './provenance'

const POINTS = ['current', 'periapsis', 'apoapsis']

// The factors no gas operation changes: the body's gravity against the species' range.
const FIXED_FACTORS = new Set(['gravity'])

const SHARE_DECIMALS = 1e9

export const STAGE_ASSUMPTIONS = Object.freeze([
  'each gas operation is carried out in full, in the plan\'s order, before the next one',
  'the water extent changes only in the final settling',
  'the shares of the gases are recomputed from their pressures after each operation',
  'the climate counts every gas as the plan does, frozen out or not',
])

registerRule({
  id: 'habitability.terraformLimits',
  versions: ['2.7.x'],
  units: 'colony cost',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroExt, HydroID, TidalLock, Eccentricity', 'FCT_AtmosphericGas', 'DIM_Gases', 'FCT_Species'],
  note: 'The colony cost factors of the colony cost rule, priced on the atmosphere the Planner\'s terraforming plan leaves after each gas operation. The first stage is the body as saved; every later one is the plan\'s own estimate and was not observed on a played-out terraform. A factor is fixed when no gas operation changes it, so it is never promised away.',
  assumptions: STAGE_ASSUMPTIONS,
})

const gasRow = (id, amount, info) => ({ AtmosGasID: id, AtmosGasName: info.AtmosGasName || info.Name || 'Unknown', GasAtm: amount, AtmosGasAmount: amount, BoilingPoint: info.BoilingPoint || 0, GHGas: info.GHGas || 0, AntiGHGas: info.AntiGHGas || 0, Dangerous: info.Dangerous || 0, DangerousLevel: info.DangerousLevel || 0, FrozenOut: false })

// The share of each gas in the atmosphere, as the atmosphere refresh of the game computes it from the pressures.
const withShares = (rows) => {
  const total = rows.reduce((sum, gas) => sum + gas.GasAtm, 0)

  return rows.map((gas) => ({ ...gas, AtmosGasAmount: total > 0 ? Math.round((gas.GasAtm / total) * 100 * SHARE_DECIMALS) / SHARE_DECIMALS : 0 }))
}

// The body once the first `applied` steps of the plan are done: each step sets its gas to the figure the plan types into the game (`set`), a gas set to nothing leaves. The climate is the plan's: the greenhouse and anti-greenhouse gases and the pressure set the temperature, the temperature sets the water phase, and a change of phase moves the albedo.
const bodyAfter = (body, plan, gasInfo, applied) => {
  const atmosphere = new Map(body.Atmosphere.map((gas) => [gas.AtmosGasID, gas]))

  plan.steps.slice(0, applied).forEach((step) => {
    if (Number.isFinite(step.set) && step.set > 0) {
      const present = atmosphere.get(step.gasId)

      atmosphere.set(step.gasId, present ? { ...present, GasAtm: step.set } : gasRow(step.gasId, step.set, gasInfo(step.gasId) || {}))
    } else {
      atmosphere.delete(step.gasId)
    }
  })

  const rows = withShares([...atmosphere.values()])
  const pressure = rows.reduce((sum, gas) => sum + gas.GasAtm, 0)
  const greenhouse = rows.reduce((sum, gas) => sum + (gas.GHGas ? gas.GasAtm : 0), 0)
  const anti = rows.reduce((sum, gas) => sum + (!gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0), 0)
  const temperatureAt = (albedo) => Math.max(1, (body.BaseTemp * Math.min(3, 1 + pressure / 10 + greenhouse) * albedo) / Math.min(3, 1 + body.DustLevel / 20000 + anti))
  let albedo = body.Albedo
  let temperature = temperatureAt(albedo)
  let hydrosphere = hydrosphereState(temperature, pressure)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const adjusted = albedoForHydrosphere(body.Albedo, body.HydroID, hydrosphere, body.HydroExt)

    if (Math.abs(adjusted - albedo) < 1e-3) {
      break
    }

    albedo = adjusted
    temperature = temperatureAt(albedo)
    hydrosphere = hydrosphereState(temperature, pressure)
  }

  return { ...body, SurfaceTemp: temperature, Albedo: albedo, AtmosPress: pressure, HydroID: hydrosphere, Atmosphere: rows }
}

const merged = (entries) => {
  const byKey = new Map()

  entries.forEach(({ key, label, value, at }) => {
    const known = byKey.get(key)

    if (known) {
      known.at.push(at)
    } else {
      byKey.set(key, { key, label, value, fixed: FIXED_FACTORS.has(key), at: [at] })
    }
  })

  return [...byKey.values()].sort((a, b) => FACTORS.findIndex((factor) => factor.key === a.key) - FACTORS.findIndex((factor) => factor.key === b.key))
}

const round4 = (value) => Math.round(value * 10000) / 10000

// The factors of a stage at each point of the orbit as the colony cost sees them, with the breathing penalty the cost leaves out while a larger one comes first: it would show as soon as that one is gone.
const latentBreathing = (points, distinct, body, species) => {
  const failing = breathingFails(body, species)

  return Object.fromEntries(distinct.map((name) => [name, failing && points[name].factors.breathable === 0]))
}

// One stage: the cost and the factors at each point of the orbit, the factors that set the worst cost (those of every point that reaches it, ties included) and those that would set it once they were cleared (the largest below, other than the limiting ones, ties included, with the breathing penalty a larger factor hides).
const stageOf = ({ index, kind, step, body, species, skill, planned, previous }) => {
  const points = costPoints(body, species, planned)
  const costs = { current: points.current.cost, periapsis: points.periapsis.cost, apoapsis: points.apoapsis.cost }
  const raw = Math.max(costs.current, costs.periapsis, costs.apoapsis)
  const distinct = POINTS.filter((name) => name === 'current' || points[name] !== points.current)
  const latent = latentBreathing(points, distinct, body, species)
  const standing = (name, key) => (key === 'breathable' && latent[name] ? BREATHING_PENALTY : points[name].factors[key])
  const limiting = merged(distinct.filter((name) => costs[name] === raw).flatMap((name) => limitingFactors(points[name].factors).map((factor) => ({ ...factor, at: name }))))
  const keys = new Set(limiting.map(({ key }) => key))
  const others = distinct.flatMap((name) => FACTORS.filter(({ key }) => !keys.has(key)).map((factor) => ({ ...factor, value: standing(name, factor.key), at: name, hidden: factor.key === 'breathable' && latent[name] }))).filter((factor) => round4(factor.value) > 0 && (factor.hidden || round4(factor.value) < raw))
  const top = Math.max(0, ...others.map((factor) => round4(factor.value)))
  const next = top > 0 ? merged(others.filter((factor) => round4(factor.value) === top)) : []
  const lost = previous ? previous.limiting.filter(({ key }) => !keys.has(key)) : []
  const lowered = (entry) => !entry.fixed && Math.max(...distinct.map((name) => round4(standing(name, entry.key)))) < round4(entry.value)

  return {
    index,
    kind,
    step,
    pressure: body.AtmosPress,
    body,
    temperature: body.SurfaceTemp,
    hydroExt: body.HydroExt,
    cost: { current: costs.current, periapsis: costs.periapsis, apoapsis: costs.apoapsis, raw, worst: raw * skill },
    points,
    lowGravity: points.current.lowGravity,
    limiting,
    next,
    revealed: previous ? limiting.filter(({ key }) => !(previous.limiting.some((entry) => entry.key === key))).map(({ key }) => key) : [],
    cleared: lost.filter(lowered).map(({ key }) => key),
    overtaken: lost.filter((entry) => !lowered(entry)).map(({ key }) => key),
    blocked: limiting.length > 0 && limiting.every(({ fixed }) => fixed),
    result: kind === 'start' ? ofRule({ rule: 'habitability.colonyCost', value: raw, inputs: { present: ['body environment', 'species ranges'] } }) : ofRule({ rule: 'habitability.terraformLimits', value: raw, inputs: { present: ['body environment', 'species ranges', 'terraforming plan'] }, assumptions: STAGE_ASSUMPTIONS }),
  }
}

// The stages of the plan in `assessment` (from `assessTerraforming` for the same body, species and `gasInfo`), or null when the body is not colonisable or has no plan. `skill` is the race's colonisation skill, as given to `assessTerraforming`. Every gas operation is priced on the atmosphere the operations so far leave, water extent as saved. The plan's own end state (the atmosphere and water the Planner prices after terraforming) is the stage of the settling when the surface has water to condense or evaporate, else a stage of kind 'target' when it differs from what the last operation leaves (in cost or in what limits it), never the last operation's own stage, so the end always agrees with the Planner's cost after terraforming.
export const terraformStages = ({ assessment, body, species, skill, gasInfo }) => {
  const { plan } = assessment

  if (!plan || !assessment.cost.colonisable) {
    return null
  }

  const { steps } = plan
  const settles = plan.settling.process !== 'Stable' && plan.settling.years > 0
  const ending = terraformedBody(body, species, plan, gasInfo)
  const stages = [stageOf({ index: 0, kind: 'start', step: null, body, species, skill, planned: false, previous: null })]

  steps.forEach((step, index) => {
    stages.push(stageOf({ index: index + 1, kind: 'step', step, body: bodyAfter(body, plan, gasInfo, index + 1), species, skill, planned: true, previous: stages[stages.length - 1] }))
  })

  const last = stages[stages.length - 1]
  const end = stageOf({ index: stages.length, kind: settles ? 'settle' : 'target', step: null, body: ending, species, skill, planned: true, previous: last })
  const sameCosts = POINTS.every((name) => end.cost[name] === last.cost[name])
  const sameLimits = end.limiting.length === last.limiting.length && end.limiting.every((entry, position) => entry.key === last.limiting[position].key && entry.at.join() === last.limiting[position].at.join())

  if (settles || !sameCosts || !sameLimits) {
    stages.push(end)
  }

  return {
    stages,
    floor: stages[0].lowGravity ? 1 : 0,
    floorWorst: stages[0].lowGravity ? skill : 0,
    lowGravity: stages[0].lowGravity,
    tidalLock: !!body.TidalLock && body.BodyClass !== BODY_CLASS.MOON,
    partial: plan.partial,
  }
}
