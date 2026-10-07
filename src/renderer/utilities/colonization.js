// The Colonization Planner's model: every body of the race's known systems, assessed for each of its
// species (what it costs now, what terraforming gets it to, what it holds), and ranked by what the player
// wants from it. The rules live in habitability.js (cost), terraforming.js (plans) and colonies.js (capacity);
// this file joins them with minerals and distance and holds the ranking.

import { bodyCapacity } from './colonies'
import { KM_PER_AU } from './jump-graph'
import { MINERALS, qualifiesForCmc } from './minerals'
import { assessTerraforming, planYears, terraformCapacity } from './terraforming'
import { infrastructurePerMillion, limitingFactor, speciesLimits } from './habitability'

export const GOALS = [
  { id: 'people', label: 'People', icon: 'mdi-account-group-outline', hint: 'Rank by how many people the body holds' },
  { id: 'minerals', label: 'Minerals', icon: 'mdi-pickaxe', hint: 'Rank by the mineral score and civilian mining complexes' },
  { id: 'both', label: 'Both', icon: 'mdi-scale-balance', hint: 'People and minerals, each as a share of a good colony' },
]

// The workbook's weights (Aur_Calcs `SurfMin!J1:T1`): what a point of accessibility is worth per mineral.
export const DEFAULT_MINERAL_WEIGHTS = { 1: 1, 2: 1, 3: 0.25, 4: 0.01, 5: 1, 6: 1, 7: 1.25, 8: 0.01, 9: 0.01, 10: 1, 11: 1.25 }

// The knobs of the ranking. A deposit counts from `minimumDeposit` tonnes. `cmcBonus` is the mineral score a
// civilian mining complex site adds. Each scale is where its factor halves: a colony cost, the years of
// terraforming, the AU from the capital.
export const DEFAULT_RANKING = { minimumDeposit: 1000, cmcBonus: 2, costScale: 3, yearsScale: 25, distanceScale: 60, weights: DEFAULT_MINERAL_WEIGHTS }

// A good colony: 1,000 M people, a mineral score of 5. The "both" goal reads each as its share of one.
const PEOPLE_REFERENCE = 1000
const MINERAL_REFERENCE = 5
const CMC_MAX_STAR_DISTANCE_AU = 80
const CMC_MIN_SYSTEM_POPULATION = 10

const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback)

// The stored knobs, each kept to a sane number; anything else falls back to the default.
export const normaliseRanking = (stored) => {
  const source = stored && typeof stored === 'object' ? stored : {}
  const weights = {}

  MINERALS.forEach((mineral) => {
    const value = Number(source.weights && source.weights[mineral.id])

    weights[mineral.id] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_MINERAL_WEIGHTS[mineral.id]
  })

  return {
    minimumDeposit: positive(source.minimumDeposit, DEFAULT_RANKING.minimumDeposit),
    cmcBonus: Number.isFinite(Number(source.cmcBonus)) && Number(source.cmcBonus) >= 0 && source.cmcBonus !== null && source.cmcBonus !== '' ? Number(source.cmcBonus) : DEFAULT_RANKING.cmcBonus,
    costScale: positive(source.costScale, DEFAULT_RANKING.costScale),
    yearsScale: positive(source.yearsScale, DEFAULT_RANKING.yearsScale),
    distanceScale: positive(source.distanceScale, DEFAULT_RANKING.distanceScale),
    weights,
  }
}

// The workbook's mineral score: accessibility times the mineral's weight over every deposit of at least
// `minimumDeposit` tonnes. Civilian mining complex candidates per the Minerals page's rule and setting.
export const mineralSummary = (body, ranking, cmcIds) => {
  const deposits = body.Minerals
  const score = deposits.reduce((total, deposit) => total + (deposit.Amount >= ranking.minimumDeposit ? deposit.Accessibility * (ranking.weights[deposit.MaterialID] || 0) : 0), 0)
  const cmc = deposits.filter((deposit) => cmcIds.includes(deposit.MaterialID) && qualifiesForCmc(deposit)).map((deposit) => MINERALS.find((mineral) => mineral.id === deposit.MaterialID).name)

  return {
    surveyed: !!body.BodySurveyed,
    deposits: deposits.length,
    score,
    total: deposits.reduce((sum, deposit) => sum + deposit.Amount, 0),
    cmc,
  }
}

// The AU between a body and its star (a moon's star distance is its parent's).
export const starDistance = (body) => (body.BodyClass === 2 ? body.ParentOrbitalDistance : body.OrbitalDistance)

// What the game also wants of a civilian mining complex site, beyond the deposit (docs, C# Civilian Mining Check):
// an own colony in the system with 10 M people, a body within 80 AU of its star, no ban and no colony yet.
export const cmcSite = (body, systemPopulation) => ({
  populatedSystem: (systemPopulation[body.SystemID] || 0) >= CMC_MIN_SYSTEM_POPULATION,
  nearStar: starDistance(body) < CMC_MAX_STAR_DISTANCE_AU,
  notBanned: !body.Banned,
  uncolonised: !body.OwnPopulations.length,
})

// Own millions of people per system.
export const populationBySystem = (bodies) => {
  const totals = {}

  bodies.forEach((body) => {
    body.OwnPopulations.forEach((population) => {
      totals[body.SystemID] = (totals[body.SystemID] || 0) + population.Population
    })
  })

  return totals
}

// Every body assessed for every species, once: costs now and after terraforming, outcome and plan. The plan
// doesn't depend on the colony's capacity, so changing the terraformers doesn't redo any of this.
export const assessBodies = (bodies, speciesRows, rules, gasInfo) => {
  const species = speciesRows.map(speciesLimits)

  return bodies.map((body) => ({
    body,
    byspecies: species.map((one) => {
      const assessment = assessTerraforming(body, one, rules.ColonizationSkill, gasInfo)
      const capacityOf = (hydroExt) => (assessment.cost.colonisable ? bodyCapacity({ Radius: body.Radius, HydroExt: hydroExt, TidalLock: body.TidalLock, BodyClass: body.BodyClass, PopulationDensityModifier: one.PopulationDensityModifier }) : 0)

      return {
        species: one,
        assessment,
        capacityNow: capacityOf(body.HydroExt),
        capacityAfter: assessment.plan ? capacityOf(assessment.plan.target.hydroExt) : null,
      }
    }),
  }))
}

// What one outcome of colonising is worth to the goal: the size of the prize, discounted by the colony's
// cost, the years of terraforming and the distance. Each discount is 1 at zero and 1/2 at its scale.
const worth = (goal, ranking, { capacity, cost, years, distanceAU, minerals }) => {
  const mineralBase = minerals.surveyed ? minerals.score + (minerals.cmc.length ? ranking.cmcBonus : 0) : 0
  const base = goal === 'people' ? capacity : goal === 'minerals' ? mineralBase : capacity / (capacity + PEOPLE_REFERENCE) + mineralBase / (mineralBase + MINERAL_REFERENCE)
  const costFactor = 1 / (1 + cost / ranking.costScale)
  const yearsFactor = 1 / (1 + (Number.isFinite(years) ? years : Infinity) / ranking.yearsScale)
  const distanceFactor = distanceAU === null ? 1 : 1 / (1 + distanceAU / ranking.distanceScale)

  return base * costFactor * yearsFactor * distanceFactor
}

// A species on a body, read for the goal at `capacity` atm a year of terraforming. `strategy` is whether the
// worth is highest settling as the body is, or waiting for terraforming.
export const evaluate = ({ species, assessment, capacityNow, capacityAfter }, { goal, ranking, terraformCapacityPerYear, distanceAU, minerals }) => {
  if (!assessment.cost.colonisable) {
    return { species, assessment, capacityNow, capacityAfter, value: 0, strategy: 'none', years: null, cost: null, capacity: 0, infrastructure: null }
  }

  const now = { strategy: 'now', years: 0, cost: assessment.cost.worst, capacity: capacityNow, lowGravity: assessment.cost.lowGravity }
  const options = [now]

  if (assessment.plan && assessment.after) {
    options.push({ strategy: 'terraform', years: planYears(assessment.work, terraformCapacityPerYear), cost: assessment.after.worst, capacity: capacityAfter, lowGravity: assessment.lowGravity })
  }

  const best = options
    .map((option) => ({ ...option, value: worth(goal, ranking, { ...option, distanceAU, minerals }) }))
    .sort((a, b) => b.value - a.value || a.years - b.years)[0]

  return {
    species,
    assessment,
    capacityNow,
    capacityAfter,
    ...best,
    infrastructure: infrastructurePerMillion(best.cost, species, best.lowGravity),
  }
}

// One row per body for the table and chart: the best species for it (or the chosen one), its alternatives,
// and the numbers the columns show. `speciesId` null means the best of all. Every row has a `best`, so a race
// with no species (nothing to compare bodies against) gets no rows at all.
export const rankBodies = (assessed, { speciesId, goal, ranking, rules, terraformers, distanceOf, cmcIds, systemPopulation }) => {
  const terraformCapacityPerYear = terraformCapacity(rules, terraformers)

  const rows = assessed.filter(({ byspecies }) => byspecies.length).map(({ body, byspecies }) => {
    const minerals = mineralSummary(body, ranking, cmcIds)
    const distance = distanceOf(body)
    const distanceAU = distance ? distance.km / KM_PER_AU : null
    const evaluations = byspecies.map((entry) => evaluate(entry, { goal, ranking, terraformCapacityPerYear, distanceAU, minerals }))
    const chosen = evaluations.filter((evaluation) => evaluation.species.SpeciesID === speciesId)
    const [best] = [...(chosen.length ? chosen : evaluations)].sort((a, b) => b.value - a.value || (a.cost ?? Infinity) - (b.cost ?? Infinity))

    return { body, minerals, distance: distance ? { ...distance, au: distanceAU } : null, evaluations, best, cmcSite: cmcSite(body, systemPopulation) }
  })

  const settled = (row) => row.body.OwnPopulations.length > 0
  const top = Math.max(0, ...rows.filter((row) => !settled(row)).map((row) => row.best.value))

  rows.forEach((row) => {
    row.rank = null
    row.settled = settled(row)
    row.score = !row.settled && top > 0 ? (100 * row.best.value) / top : null
  })

  const ranked = rows.filter((row) => row.score !== null && row.score > 0).sort((a, b) => b.score - a.score)

  ranked.forEach((row, index) => {
    row.rank = index + 1
  })

  return rows
}

// The factor that sets a cost, as a label for the list ("Water 1.4"), or null.
export const costDriver = (assessmentCost) => (assessmentCost.colonisable ? limitingFactor(assessmentCost.factors) : null)
