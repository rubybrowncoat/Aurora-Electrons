// What limits the colony cost after each gas operation of a terraforming plan: the stages of the Planner's plan, each priced with the same colony cost factors as the body detail, and for each stage the factors that set the cost (all of them where several are equal) and the factors that would set it next. See docs/DATABASE.md § Terraforming.
//
// A stage is `{ index, kind ('start', 'step', 'settle' or 'target', the plan's end state when it has no gas operation to carry it), step (the plan step, null for the others), pressure, temperature, hydroExt, cost: { current, periapsis, apoapsis, raw, worst }, points: { current, periapsis, apoapsis } (the cost factors there, each `{ cost, factors, ... }` as `costPoints` gives them), limiting, next, revealed, cleared, overtaken, blocked, result }`. `limiting` and `next` are lists of `{ key, label, value, fixed, at }`, `at` the points of the orbit where the factor stands; a factor is `fixed` when no gas operation changes it (gravity). `next` includes the breathing penalty that a larger factor hides, as the colony cost only counts it below 2. `revealed` are the keys that began to set the cost with this stage; of those that ceased to, `cleared` are the ones whose penalty fell (never a fixed one) and `overtaken` the ones another factor only rose above.
//
// The first stage is the body as saved, priced by the same function as the body detail's factor bars. Every later stage carries one completed gas operation in the plan's order. A drain changes the extent inside its water operation; later operations inherit that extent, temperature-dependent phase and dampening. Other condensation or evaporation is priced in the final settling stage, as in the Planner's end state. A stage carries no date: the time of a drain is a minimum (`TIME_BASIS` in terraforming.js), so a stage after it shows the drain complete, not when it completes.

import { BODY_CLASS, BREATHING_PENALTY, FACTORS, breathingFails, costPoints, limitingFactors } from './habitability'
import { bodyAfterTerraformStep, terraformedBody } from './terraforming'
import { ofRule, registerRule } from './provenance'

const POINTS = ['current', 'periapsis', 'apoapsis']

// The factors no gas operation changes: the body's gravity against the species' range.
const FIXED_FACTORS = new Set(['gravity'])

export const STAGE_ASSUMPTIONS = Object.freeze([
  'each gas operation is carried out in full, in the plan\'s order, before the next one',
  'a water drain completes inside its gas operation; later operations inherit the remaining water, while other condensation or evaporation settles at the end',
  'a drain is shown complete, not dated: it takes at least the terraformers\' time for its work, and the evaporation of the surface water, which is not modelled, can make it longer',
  'the shares of the gases are recomputed from their pressures after each operation',
  'the climate counts every gas as the plan does, frozen out or not',
  'each stage recomputes its own dampening, and the plan reads its target\'s swing, from that body\'s pressure and water extent, using the parent orbit and year for a moon',
])

registerRule({
  id: 'habitability.terraformLimits',
  versions: ['3.2.x'],
  units: 'colony cost',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Gravity, SurfaceTemp, BaseTemp, Albedo, AtmosPress, DustLevel, HydroExt, HydroID, TidalLock, Eccentricity, Year, StarLuminosity', 'FCT_SystemBody.ParentOrbitalDistance, ParentEccentricity, ParentYear', 'FCT_AtmosphericGas', 'DIM_Gases', 'FCT_Species'],
  note: 'The colony cost factors of the colony cost rule, priced on the atmosphere and surface water the Planner\'s terraforming plan leaves after each completed gas operation. The water factor and danger set are those of the species\' breathing gas. A non-oxygen drain is ordered only after a stage where the surface can evaporate, including a seasonal thaw; a frozen surface cannot drain. The completed drain and all later stages carry the remaining water, and the stages carry no dates: the time of a drain is a minimum, the terraformers\' time for its work, because the terraformer removes only the vapour in the air and the surface evaporates only in small steps; that evaporation is not modelled. Every stage recomputes its phase, albedo and dampened swing from the state the preceding operation leaves, on the orbital year, the parent\'s for a moon, and carries the gravity class. Other condensation or evaporation settles at the end. The first stage is the body as saved; later stages are estimates of the plan, not a played-out terraform.',
  assumptions: STAGE_ASSUMPTIONS,
})

// Replay completed operations on the state each predecessor leaves, using the same execution model that decides where a drain can finish.
const bodyAfter = (body, plan, gasInfo, applied) => plan.steps.slice(0, applied).reduce((state, step) => bodyAfterTerraformStep(state, step, gasInfo), body)

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
    gravityClass: points.current.gravityClass,
    limiting,
    next,
    revealed: previous ? limiting.filter(({ key }) => !(previous.limiting.some((entry) => entry.key === key))).map(({ key }) => key) : [],
    cleared: lost.filter(lowered).map(({ key }) => key),
    overtaken: lost.filter((entry) => !lowered(entry)).map(({ key }) => key),
    blocked: limiting.length > 0 && limiting.every(({ fixed }) => fixed),
    result: kind === 'start' ? ofRule({ rule: 'habitability.colonyCost', value: raw, inputs: { present: ['body environment', 'species ranges'] } }) : ofRule({ rule: 'habitability.terraformLimits', value: raw, inputs: { present: ['body environment', 'species ranges', 'terraforming plan'] }, assumptions: STAGE_ASSUMPTIONS }),
  }
}

// The stages of the assessment's plan, each operation priced on the state its predecessors leave. A completed drain immediately changes HydroExt and every later stage inherits it. Other surface settling is last; a distinct target stage is retained only when the Planner's end state differs in cost or limits.
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
    gravityClass: stages[0].gravityClass,
    tidalLock: !!body.TidalLock && body.BodyClass !== BODY_CLASS.MOON,
    partial: plan.partial,
  }
}
