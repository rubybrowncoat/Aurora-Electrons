// The Colonization Planner's model: every body of the race's known systems, assessed for each of its
// species (what it costs now, what terraforming gets it to, what it holds), given a plan state, and ranked by
// what the player wants from it. The rules live in habitability.js (cost), terraforming.js (plans) and
// colonies.js (capacity); colonization-states.js defines the plan states; this file joins them with minerals and
// distance and holds the ranking.
//
// What makes a body worth settling next, in the order the ranking weighs it (sources in docs/DATABASE.md,
// "Colonization Planner ranking"):
//   - the prize: the people it holds (surface area and the species' density, the game's capacity rule) and/or
//     what its deposits are worth (the game's own deposit value, scaled by how short the race is of each mineral);
//   - the colony cost it takes to live there, on the game's own scale (the cost before the colonisation tech);
//   - the years of terraforming, when it needs them;
//   - the distance to the nearest sizeable colony, which is how far a freighter flies to supply it.
// A body only gets a rank when it is a place to settle at all and worth the trip: it holds the smallest colony
// worth planning for, or its deposits are worth mining, or it is a civilian mining complex site.

import { bodyCapacity } from './colonies'
import { STATE_BY_ID, routeFacts, stateOf } from './colonization-states'
import { KM_PER_AU } from './jump-graph'
import { DEPOSIT_MINIMUM_AMOUNT, MINERALS, RICH_DEPOSIT_VALUE, WORTH_MINING_VALUE, NOT_SCARCE, depositValue, qualifiesForCmc } from './minerals'
import { assessTerraforming, planYears, terraformCapacity } from './terraforming'
import { infrastructurePerMillion, limitingFactor, speciesLimits } from './habitability'

export const GOALS = [
  { id: 'people', label: 'People', icon: 'mdi-account-group-outline', hint: 'Rank by how many people the body holds' },
  { id: 'minerals', label: 'Minerals', icon: 'mdi-pickaxe', hint: 'Rank by what its deposits are worth, with civilian mining complex sites' },
  { id: 'both', label: 'Both', icon: 'mdi-scale-balance', hint: 'People and minerals, each as a share of a good colony' },
]

// What a point of a mineral's deposit value is worth before the race's scarcity of it. The game's own AI weighs
// every mineral alike (RaceAIController.CalculateMineralDepsoitValue), and so does the Planner: scarcity, not a
// fixed table, says which are wanted.
export const DEFAULT_MINERAL_WEIGHTS = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, 1]))

// The knobs of the ranking. A deposit counts from `minimumDeposit` tonnes. `cmcBonus` is the deposit value a
// civilian mining complex site adds. `minimumPeople` is the smallest colony (millions) worth planning for; a
// smaller body is only a target for its deposits. Each scale is where its factor halves: a colony cost (before
// the colonisation tech), the years of terraforming, the AU from the nearest colony.
export const DEFAULT_RANKING = { minimumDeposit: DEPOSIT_MINIMUM_AMOUNT, cmcBonus: 2, minimumPeople: 50, costScale: 3, yearsScale: 25, distanceScale: 60, weights: DEFAULT_MINERAL_WEIGHTS }

// Saved knobs from before this version (a different cost scale, workbook weights, a mineral score) are dropped
// rather than carried over: they meant other things.
export const RANKING_VERSION = 2

// A good colony: 1,000 M people, a deposit value at the game's mining-colony threshold. Each is worth half a
// prize at that size. A body with no charted route from any colony keeps this share of its worth.
const PEOPLE_REFERENCE = 1000
const MINERAL_REFERENCE = RICH_DEPOSIT_VALUE
const NO_ROUTE_FACTOR = 0.3

// A target is ranked from this share of the best one's worth. From `BEST_TARGET_SCORE` it is a best target.
export const MINIMUM_TARGET_SCORE = 10
export const BEST_TARGET_SCORE = 25
const CMC_MAX_STAR_DISTANCE_AU = 80
const CMC_MIN_SYSTEM_POPULATION = 10

export const NO_OUTLOOK = { known: false, minerals: {} }

const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback)
const atLeastZero = (value, fallback) => (value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback)

// The stored knobs, each kept to a sane number; anything else falls back to the default.
export const normaliseRanking = (stored) => {
  const source = stored && typeof stored === 'object' && stored.version === RANKING_VERSION ? stored : {}
  const weights = {}

  MINERALS.forEach((mineral) => {
    weights[mineral.id] = atLeastZero(source.weights && source.weights[mineral.id], DEFAULT_MINERAL_WEIGHTS[mineral.id])
  })

  return {
    version: RANKING_VERSION,
    minimumDeposit: positive(source.minimumDeposit, DEFAULT_RANKING.minimumDeposit),
    cmcBonus: atLeastZero(source.cmcBonus, DEFAULT_RANKING.cmcBonus),
    minimumPeople: positive(source.minimumPeople, DEFAULT_RANKING.minimumPeople),
    costScale: positive(source.costScale, DEFAULT_RANKING.costScale),
    yearsScale: positive(source.yearsScale, DEFAULT_RANKING.yearsScale),
    distanceScale: positive(source.distanceScale, DEFAULT_RANKING.distanceScale),
    weights,
  }
}

// What a body's deposits are worth to this race: each deposit by the game's own value (accessibility, raised for
// a big easy one, halved for a small one), times the mineral's weight and the race's scarcity of it
// (`outlook`, from minerals.js `mineralOutlook`). Civilian mining complex candidates per the Minerals page's rule
// and setting.
export const mineralSummary = (body, ranking, cmcIds, outlook = NO_OUTLOOK) => {
  const lines = body.Minerals.map((deposit) => {
    const mineral = MINERALS.find((candidate) => candidate.id === deposit.MaterialID)
    const scarcity = (outlook.minerals[deposit.MaterialID] || {}).scarcity || NOT_SCARCE
    const base = depositValue(deposit, ranking.minimumDeposit)

    return { id: mineral.id, name: mineral.name, amount: deposit.Amount, accessibility: deposit.Accessibility, base, scarcity, value: base * (ranking.weights[mineral.id] || 0) * scarcity.factor }
  }).sort((a, b) => b.value - a.value || b.amount - a.amount)
  const value = lines.reduce((total, line) => total + line.value, 0)
  const cmc = body.Minerals.filter((deposit) => cmcIds.includes(deposit.MaterialID) && qualifiesForCmc(deposit)).map((deposit) => MINERALS.find((mineral) => mineral.id === deposit.MaterialID).name)

  return {
    surveyed: !!body.BodySurveyed,
    deposits: body.Minerals.length,
    lines,
    value,
    rich: !!body.BodySurveyed && value >= RICH_DEPOSIT_VALUE,
    worthMining: !!body.BodySurveyed && value >= WORTH_MINING_VALUE,
    total: body.Minerals.reduce((sum, deposit) => sum + deposit.Amount, 0),
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

// What one outcome of colonising is worth to the goal, as the parts that multiply into it: the size of the prize
// (people and mining, each 0 to 1), discounted by the colony cost, the years of terraforming and the distance.
// Each discount is 1 at zero and 1/2 at its scale.
const worth = (goal, ranking, { capacity, raw, years, distanceAU, minerals, cmcReady }) => {
  const mineralBase = minerals.surveyed ? minerals.value + (cmcReady ? ranking.cmcBonus : 0) : 0
  const people = capacity / (capacity + PEOPLE_REFERENCE)
  const mining = mineralBase / (mineralBase + MINERAL_REFERENCE)
  const prize = goal === 'people' ? people : goal === 'minerals' ? mining : people + mining
  const cost = 1 / (1 + raw / ranking.costScale)
  const time = 1 / (1 + (Number.isFinite(years) ? years : Infinity) / ranking.yearsScale)
  const distance = distanceAU === null ? NO_ROUTE_FACTOR : 1 / (1 + distanceAU / ranking.distanceScale)

  return { people, mining, prize, cost, time, distance, value: prize * cost * time * distance }
}

// A species on a body, read for the goal at `terraformCapacityPerYear` atm a year of terraforming. `strategy` is
// whether the worth is highest settling as the body is, or waiting for terraforming.
export const evaluate = ({ species, assessment, capacityNow, capacityAfter }, { goal, ranking, terraformCapacityPerYear, distanceAU, minerals, cmcReady }) => {
  const base = { species, assessment, capacityNow, capacityAfter }

  if (!assessment.cost.colonisable) {
    return { ...base, value: 0, parts: null, strategy: 'none', years: null, cost: null, raw: null, capacity: 0, infrastructure: null, nowInfrastructure: null, afterInfrastructure: null }
  }

  const nowInfrastructure = infrastructurePerMillion(assessment.cost.worst, species, assessment.cost.lowGravity)
  const options = [{ strategy: 'now', years: 0, cost: assessment.cost.worst, raw: assessment.cost.raw, capacity: capacityNow, lowGravity: assessment.cost.lowGravity, infrastructure: nowInfrastructure }]
  let afterInfrastructure = null

  if (assessment.plan && assessment.after) {
    afterInfrastructure = infrastructurePerMillion(assessment.after.worst, species, assessment.lowGravity)
    options.push({ strategy: 'terraform', years: planYears(assessment.work, terraformCapacityPerYear), cost: assessment.after.worst, raw: assessment.after.raw, capacity: capacityAfter, lowGravity: assessment.lowGravity, infrastructure: afterInfrastructure })
  }

  const best = options
    .map((option) => {
      const parts = worth(goal, ranking, { ...option, distanceAU, minerals, cmcReady })

      return { ...option, parts, value: parts.value }
    })
    .sort((a, b) => b.value - a.value || a.years - b.years)[0]

  return { ...base, ...best, nowInfrastructure, afterInfrastructure }
}

const sumPeople = (populations) => populations.reduce((total, population) => total + population.Population, 0)

// One row per body for the table and chart: the best species for it (or the chosen one), its alternatives, its
// plan state, and the numbers the columns show. `speciesId` null means the best of all. Every row has a `best`,
// so a race with no species (nothing to compare bodies against) gets no rows at all. `distanceOf` measures from
// the nearest sizeable colony, `capitalDistanceOf` from the capital; `outlook` is the race's mineral outlook.
export const rankBodies = (assessed, { speciesId, goal, ranking, rules, terraformers, distanceOf, capitalDistanceOf, cmcIds, systemPopulation, outlook = NO_OUTLOOK }) => {
  const terraformCapacityPerYear = terraformCapacity(rules, terraformers)

  const rows = assessed
    .filter(({ byspecies }) => byspecies.length)
    .map(({ body, byspecies }) => {
      const minerals = mineralSummary(body, ranking, cmcIds, outlook)
      const site = cmcSite(body, systemPopulation)
      const cmcReady = minerals.cmc.length > 0 && Object.values(site).every(Boolean)
      const distance = distanceOf(body)
      const distanceAU = distance ? distance.km / KM_PER_AU : null
      const capital = capitalDistanceOf(body)
      const evaluations = byspecies.map((entry) => evaluate(entry, { goal, ranking, terraformCapacityPerYear, distanceAU, minerals, cmcReady }))
      const chosen = evaluations.filter((evaluation) => evaluation.species.SpeciesID === speciesId)
      const [best] = [...(chosen.length ? chosen : evaluations)].sort((a, b) => b.value - a.value || (a.cost ?? Infinity) - (b.cost ?? Infinity))
      const settled = { people: sumPeople(body.OwnPopulations), colonies: body.OwnPopulations.length, alien: body.AlienPopulations.length }
      const route = routeFacts(best, planYears(best.assessment.work, terraformCapacityPerYear))
      const facts = { settled, route, richDeposit: minerals.rich, peopleMinimum: ranking.minimumPeople }
      const state = stateOf(facts)
      const room = route ? Math.max(route.capacity, route.plan ? route.plan.capacity || 0 : 0) : 0
      const worthwhile = !!route && (room >= ranking.minimumPeople || minerals.worthMining || cmcReady)

      return {
        body,
        minerals,
        distance: distance ? { ...distance, au: distanceAU } : null,
        capitalDistance: capital ? { ...capital, au: capital.km / KM_PER_AU } : null,
        evaluations,
        best,
        cmcSite: site,
        cmcReady,
        settled: settled.colonies > 0,
        facts,
        state,
        target: STATE_BY_ID[state.id].target && worthwhile,
        rank: null,
        score: null,
      }
    })

  const targets = rows.filter((row) => row.target)
  const top = Math.max(0, ...targets.map((row) => row.best.value))

  targets.forEach((row) => {
    row.score = top > 0 ? (100 * row.best.value) / top : null
  })

  targets
    .filter((row) => row.score >= MINIMUM_TARGET_SCORE)
    .sort((a, b) => b.score - a.score)
    .forEach((row, index) => {
      row.rank = index + 1
    })

  return rows
}

// The factor that sets a cost, as a label for the list ("Water 1.4"), or null.
export const costDriver = (assessmentCost) => (assessmentCost.colonisable ? limitingFactor(assessmentCost.factors) : null)
