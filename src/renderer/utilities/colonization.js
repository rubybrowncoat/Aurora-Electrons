// The Colonization Planner's model: every body of the race's known systems, assessed for each of its species (what it costs now, what terraforming gets it to, what it holds), given a plan state, and ranked by what the player wants from it. The rules live in habitability.js (cost), terraforming.js (plans) and colonies.js (capacity); colonization-states.js defines the plan states; this file joins them with minerals and distance and holds the ranking.
//
// What makes a body worth settling next, in the order the ranking weighs it (sources in docs/DATABASE.md, "Colonization Planner ranking"):
//   - the prize: the people it holds (surface area and the species' density, the game's capacity rule) and/or what its deposits are worth (the game's own deposit value, scaled by how short the race is of each mineral);
//   - the colony cost it takes to live there, on the game's own scale (the cost before the colonisation tech);
//   - the years of terraforming, when it needs them;
//   - the distance to the nearest sizeable colony, which is how far a freighter flies to supply it.
// A body only gets a rank when it is a place to settle at all and worth the trip: it holds the smallest colony worth planning for, or its deposits are worth mining, or it is a civilian mining complex site.

import { bodyCapacity } from './colonies'
import { routeFacts, stateOf } from './colonization-states'
import { KM_PER_AU } from './jump-graph'
import { CMC_MINERAL_IDS, DEPOSIT_MINIMUM_AMOUNT, MINERALS, RICH_DEPOSIT_VALUE, WORTH_MINING_VALUE, depositValueResult, qualifiesForCmc, scarcityResult } from './minerals'
import { combine, ofRule, registerRule, unavailable, valueOrNull } from './provenance'
import { assessTerraforming, planYears, terraformCapacity } from './terraforming'
import { infrastructurePerMillion, infrastructurePerMillionResult, limitingFactor, missingBodyInputs, missingSpeciesInputs, speciesLimits } from './habitability'

export const GOALS = [
  { id: 'people', label: 'People', icon: 'mdi-account-group-outline', hint: 'Rank by how many people the body holds' },
  { id: 'minerals', label: 'Minerals', icon: 'mdi-pickaxe', hint: 'Rank by what its deposits are worth, with civilian mining complex sites' },
  { id: 'both', label: 'Both', icon: 'mdi-scale-balance', hint: 'People and minerals, each as a share of a good colony' },
]

// What a point of a mineral's deposit value is worth before the race's scarcity of it. The game's own AI weighs every mineral alike, and so does the Planner: scarcity, not a fixed table, says which are wanted.
export const DEFAULT_MINERAL_WEIGHTS = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, 1]))

// The knobs of the ranking. A deposit counts from `minimumDeposit` tonnes. `cmcBonus` is the deposit value a civilian mining complex site adds. `minimumPeople` is the smallest colony (millions) worth planning for; a smaller body is only a target for its deposits. Each scale is where its factor halves: a colony cost (before the colonisation tech), the years of terraforming, the AU from the nearest colony.
export const DEFAULT_RANKING = { minimumDeposit: DEPOSIT_MINIMUM_AMOUNT, cmcBonus: 2, minimumPeople: 50, costScale: 3, yearsScale: 25, distanceScale: 60, weights: DEFAULT_MINERAL_WEIGHTS }

// Saved knobs from before this version (a different cost scale, workbook weights, a mineral score) are dropped rather than carried over: they meant other things.
export const RANKING_VERSION = 2

// A good colony: 1,000 M people, a deposit value at the game's mining-colony threshold. Each is worth half a prize at that size. A body with no charted route from any colony keeps this share of its worth.
const PEOPLE_REFERENCE = 1000
const MINERAL_REFERENCE = RICH_DEPOSIT_VALUE
const NO_ROUTE_FACTOR = 0.3

// A target is ranked from this share of the best one's worth. From `BEST_TARGET_SCORE` it is a best target.
export const MINIMUM_TARGET_SCORE = 10
export const BEST_TARGET_SCORE = 25
const CMC_REACH_AU = 80
const CMC_MIN_COLONY_POPULATION = 10
const GAS_GIANT_TYPES = [4, 5]

export const NO_OUTLOOK = { known: false, minerals: {} }

// A mineral the outlook says nothing of (no outlook read yet) counts once, as holding; `rankBodies` reports that as an assumption while the outlook is not known.
const HOLDING = scarcityResult(Infinity)

const VERSIONS = ['2.7.x']

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js). The colony cost and the infrastructure per million are in habitability.js, the species' population in colonization-data.js.
registerRule({
  id: 'habitability.terraformRate',
  versions: VERSIONS,
  units: 'atm of an Earth-sized body a year',
  verification: 'estimated',
  structure: ['FCT_Race.TerraformingRate', 'FCT_Game.TerraformingSpeed'],
  note: 'The race\'s terraforming rate times the game\'s terraforming speed (a percentage) times the terraformers entered: the capacity of colonies with no modifier on their output. The save stores no capacity to compare with. A colony of the race on a body is broken down apart (terraform.capacity: governor, sector commander, efficiency, radiation, stability, political status, orbital modules with their crews, captains and naval admin chain), and the ranking and the years of a plan use the terraformers entered.',
  assumptions: ['no output modifier on the terraformers entered'],
})

registerRule({
  id: 'habitability.bodyCapacity',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Radius, HydroExt, TidalLock, BodyClass', 'FCT_Species.PopulationDensityModifier'],
  note: 'Millions of people a body holds before growth stops: surface area times the species\' density, less above 75% water and a fifth on a tide-locked planet (colonies.js bodyCapacity, the rule of docs/DATABASE.md). The save stores no capacity to compare with, so the figure is not checked against saved values.',
})

registerRule({
  id: 'habitability.mineralValue',
  versions: VERSIONS,
  units: 'deposit value',
  verification: 'assumed',
  structure: ['FCT_MineralDeposit.Amount, Accessibility', 'FCT_SystemBodySurveys', 'FCT_RaceMineralData'],
  note: 'The sum over a body\'s surveyed deposits of the deposit value (accessibility, raised for a big easy deposit and halved for a small one; minerals.js depositValue) times the mineral\'s weight set in Ranking times the race\'s scarcity factor from the Mineral Outlook runway. A deposit with no recorded amount (or, over the minimum amount, no accessibility), or of a mineral whose runway is unknown, leaves the sum unknown; a mineral weighted 0 counts for nothing. The weights and the scarcity bands are the Planner\'s choice, and the deposit value is not compared with a stored value.',
  assumptions: ['mineral weights as set in Ranking'],
})

registerRule({
  id: 'habitability.distance',
  versions: VERSIONS,
  units: 'km, jumps',
  verification: 'estimated',
  structure: ['FCT_RaceJumpPointSurvey.Charted, Explored, IgnoreForDistance', 'FCT_JumpPoint', 'FCT_Population.Capital, Population', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'The kilometres and jumps of the shortest route over the race\'s charted and explored jump points from the nearest colony with people, the capital included (jump-graph.js). The fewest-jump search reproduced 109 of 110 transit chains stored in move orders (docs/DATABASE.md, Routes); the kilometre route and the choice of the nearest colony as the place to measure from are the Planner\'s reading and have no stored value.',
})

registerRule({
  id: 'habitability.score',
  versions: VERSIONS,
  units: '% of the best target',
  verification: 'assumed',
  structure: ['FCT_SystemBody', 'FCT_Species', 'FCT_MineralDeposit', 'FCT_Population', 'FCT_RaceJumpPointSurvey'],
  note: 'A planner ranking, not a game rule. Worth is the prize (the share of 1,000 M people the body holds and the share of a deposit value of 6, the game\'s mining-colony threshold, that its deposits are worth, or both added) times a discount 1 / (1 + x / scale) for each of the colony cost before the skill, the years of terraforming and the AU from the nearest colony. Each body takes the better of settling it as it is and waiting for its terraforming, and the best species. The score is the share of the best target\'s worth; a target ranks from 10% and is best from 25%. The weights, scales and thresholds are the Planner\'s choice. The whole path was read in colonization.js; none of it is compared with a game value.',
  assumptions: ['mineral weights, discount scales and thresholds as set in Ranking'],
})

registerRule({
  id: 'habitability.filterCount',
  versions: VERSIONS,
  units: 'bodies',
  verification: 'confirmed',
  structure: ['FCT_SystemBody', 'FCT_Population'],
  note: 'The number of bodies of the loaded list that pass a view, plan state, body class, system or filter test. The counting is exact; which body falls in a view or a state follows its rank and colony cost, so a count built on them takes their status.',
})

// The colonisation skill an assessment uses when the race row has none. A figure worked out with it says so.
const ASSUMED_SKILL = 1
const SKILL_ASSUMPTION = 'a colonisation skill of 1, the race row has none'

const NOTHING = Object.freeze([])

// What a pair of a body and a species is when the save lacks a figure of either that the cost reads: not colonisable on paper, but the entry's `missing` names the figures, so it reads as unknown, not as N/A.
const UNKNOWN_ASSESSMENT = Object.freeze({ cost: Object.freeze({ colonisable: false, reason: 'Figures missing' }), lowGravity: false, plan: null, work: 0, after: null, outcome: 'no', reason: null })

// The plan state of a body whose best route cannot be told: the figures it needs are missing. It stands apart from the table of states (colonization-states.js) and is listed beside it.
export const UNKNOWN_STATE = Object.freeze({
  id: 'unknown',
  label: 'Unknown',
  group: 'Not worked out',
  color: 'warning',
  icon: 'mdi-help-circle-outline',
  target: false,
  rule: 'A figure the plan needs is missing from the save (a body or species figure, or the terraforming capacity), so no state is given.',
  when: () => false,
  text: ({ unknown }) => `Not worked out: missing ${unknown.join(', ')}.`,
  chip: () => 'Unknown',
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The yearly terraforming capacity of `terraformers` as a result. A missing race rate or speed setting, or a count that is not a positive number, makes it unavailable; a rate of 0 (a race without the tech) is a real capacity of 0.
export const terraformCapacityResult = (rules, terraformers) => {
  const inputs = [['FCT_Race.TerraformingRate', isNumber(rules.TerraformingRate)], ['FCT_Game.TerraformingSpeed', isNumber(rules.TerraformingSpeed)], ['terraformers', isNumber(terraformers) && terraformers > 0]]
  const present = inputs.filter(([, known]) => known).map(([name]) => name)
  const missing = inputs.filter(([, known]) => !known).map(([name]) => name)

  if (missing.length) {
    return unavailable({ rule: 'habitability.terraformRate', missing, present })
  }

  return ofRule({ rule: 'habitability.terraformRate', value: terraformCapacity(rules, terraformers), inputs: { present }, assumptions: [`${terraformers} terraformers`] })
}

// Where the places travel is measured from, when the race has none.
export const NO_ORIGINS = Object.freeze({ colonies: 0, capital: false })

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

// What a body's deposits are worth to this race: each deposit by the game's own value (accessibility, raised for a big easy one, halved for a small one), times the mineral's weight and the race's scarcity of it (`outlook`, from minerals.js `mineralOutlook`). Civilian mining complex candidates per the game's deposit rule (minerals.js `qualifiesForCmc`).
// A deposit with no recorded amount or accessibility, or of a mineral whose runway is unknown, has no value (`value` null on its line); a body with any such line has `value` null and `missing` naming what is lacking, never a sum that counts the line as 0. A mineral weighted 0 counts for nothing whatever its deposit. A line keeps the results it was worked out from (`baseResult`, `scarcityResult`) for `rowProvenance`.
export const mineralSummary = (body, ranking, outlook = NO_OUTLOOK) => {
  const lines = body.Minerals.map((deposit) => {
    const mineral = MINERALS.find((candidate) => candidate.id === deposit.MaterialID)
    const weight = ranking.weights[mineral.id] || 0
    const entry = outlook.minerals[deposit.MaterialID]
    const tier = entry ? entry.scarcityResult : HOLDING
    const baseResult = depositValueResult(deposit, ranking.minimumDeposit)
    const base = valueOrNull(baseResult)
    const scarcity = valueOrNull(tier)
    const value = weight === 0 || base === 0 ? 0 : base === null || scarcity === null ? null : base * weight * scarcity.factor
    const missing = value === null ? [...(base === null ? baseResult.inputs.missing.map((input) => `${input} of ${mineral.name}`) : []), ...(scarcity === null ? [`the ${mineral.name} runway`] : [])] : NOTHING

    return { id: mineral.id, name: mineral.name, amount: deposit.Amount, accessibility: deposit.Accessibility, base, scarcity, value, weight, baseResult, scarcityResult: tier, missing }
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount)
  const unknown = lines.filter((line) => line.value === null)
  const value = unknown.length ? null : lines.reduce((total, line) => total + line.value, 0)
  const cmc = body.Minerals.filter((deposit) => CMC_MINERAL_IDS.includes(deposit.MaterialID) && qualifiesForCmc(deposit)).map((deposit) => MINERALS.find((mineral) => mineral.id === deposit.MaterialID).name)

  return {
    surveyed: !!body.BodySurveyed,
    deposits: body.Minerals.length,
    lines,
    value,
    missing: unknown.length ? [...new Set(unknown.flatMap((line) => line.missing))] : NOTHING,
    rich: !!body.BodySurveyed && value >= RICH_DEPOSIT_VALUE,
    worthMining: !!body.BodySurveyed && value >= WORTH_MINING_VALUE,
    total: body.Minerals.every((deposit) => isNumber(deposit.Amount)) ? body.Minerals.reduce((sum, deposit) => sum + deposit.Amount, 0) : null,
    cmc,
  }
}

// Whether the game counts a body as near enough to its star for a civilian mining complex: an asteroid, comet or planet that is not a gas giant needs its farthest point under 80 AU; a moon goes by its planet's orbital distance.
export const cmcBodyInReach = (body) => {
  if (body.BodyClass === 2) {
    return body.ParentOrbitalDistance < CMC_REACH_AU
  }

  if (body.BodyClass === 1 && GAS_GIANT_TYPES.includes(body.BodyTypeID)) {
    return false
  }

  return [1, 3, 5].includes(body.BodyClass) && body.OrbitalDistance * (1 + (body.Eccentricity || 0)) < CMC_REACH_AU
}

// Whether the game lets a body of this star host a civilian mining complex. The primary star always does. A companion does when it, or for a companion of a companion the star it circles, keeps under 80 AU from what it orbits, or else when the primary has a Lagrange point on a planet within 80 AU and so does the companion (or the star it circles). `stars` are the system's stars, `lagrangePoints` its Lagrange points with their star's OrbitingComponent and their planet's apoapsis.
export const cmcStarInReach = (star, stars, lagrangePoints) => {
  if (star.Component === 1) {
    return true
  }

  const near = (point) => point.PlanetApoapsis < CMC_REACH_AU
  const primaryLink = lagrangePoints.some((point) => point.StarOrbitingComponent === 0 && near(point))
  const linked = (starIds) => primaryLink && lagrangePoints.some((point) => starIds.includes(point.StarID) && near(point))

  if (star.OrbitingComponent === 1) {
    return star.Apoapsis < CMC_REACH_AU || linked([star.StarID])
  }

  const circled = stars.find((other) => other.Component === star.OrbitingComponent)

  return !!circled && (circled.Apoapsis < CMC_REACH_AU || linked([star.StarID, circled.StarID]))
}

// Before the race's rules load, no body is a ready site.
export const NO_CMC_RULES = { allowed: false, shipyard: false, settledColonies: 0, largestColony: {} }

// What the game also wants for a civilian mining complex, beyond the deposit. Of the race (`rules`, from colonization-data.js `loadCmcRules`): complexes switched on for the game, a shipyard, more than one colony with people or infrastructure. Of the body: one of the race's colonies in the system over 10 M people, the body and its star in reach, not banned, and no colony on it.
// A colony of the race that has no people, no automated mines or complexes and orbital miners at work doesn't count (`BlocksCmc`); the game counts every race's colonies, and the race knows the alien ones it has intelligence on.
export const cmcSite = (body, rules) => ({
  allowed: rules.allowed,
  shipyard: rules.shipyard,
  settledColonies: rules.settledColonies > 1,
  populatedSystem: (rules.largestColony[body.SystemID] || 0) > CMC_MIN_COLONY_POPULATION,
  nearStar: cmcBodyInReach(body),
  starInReach: !!body.CmcStarInReach,
  notBanned: !body.Banned,
  uncolonised: !body.AlienPopulations.length && body.OwnPopulations.every((population) => !population.BlocksCmc),
})

const CMC_NEEDS = {
  allowed: 'civilian mining complexes switched on for the game',
  shipyard: 'a shipyard',
  settledColonies: 'more than one colony with people or infrastructure',
  populatedSystem: 'a colony in the system with over 10 M people',
  nearStar: 'a body under 80 AU from its star at its farthest (a moon: its planet\'s orbit), and not a gas giant',
  starInReach: 'a star the game counts as in reach (a companion within 80 AU of what it orbits, or linked by Lagrange points within 80 AU)',
  notBanned: 'a body that is not banned',
  uncolonised: 'a body with no colony on it (a colony with only orbital miners is fine)',
}

// The site's unmet conditions as one sentence.
export const cmcNote = (site) => {
  const missing = Object.keys(CMC_NEEDS).filter((key) => !site[key]).map((key) => CMC_NEEDS[key])

  return missing.length ? `The game also needs ${missing.join(', ')}.` : 'It meets the game\'s other conditions.'
}

// Give rendering and input a turn between batches on large saves.
const mapBodies = async (bodies, transform) => {
  const result = new Array(bodies.length)

  for (let index = 0; index < bodies.length; index += 1) {
    result[index] = transform(bodies[index])

    if ((index + 1) % 512 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  return result
}

// Every body assessed for every species, once: costs now and after terraforming, outcome and plan. The plan doesn't depend on the colony's capacity, so changing the terraformers doesn't redo any of this. A body or species the save lacks a figure of that the cost or the plan reads is not assessed: its entry is unknown (`missing` names the figures), never a cost worked out from a default. That includes a gas the plan introduces that DIM_Gases holds no figures of (`assessTerraforming` says so before pricing the plan, whatever it would have priced at); a gas the plan does not use is not asked for. A race row without a colonisation skill is assessed at 1, which `rankBodies` reports as an assumption.
export const assessBodies = async (bodies, speciesRows, rules, gasInfo) => {
  const species = speciesRows.map(speciesLimits)
  const speciesMissing = species.map(missingSpeciesInputs)
  const skill = isNumber(rules.ColonizationSkill) ? rules.ColonizationSkill : ASSUMED_SKILL

  return mapBodies(bodies, (body) => {
    const bodyMissing = missingBodyInputs(body)

    return {
      body,
      byspecies: species.map((one, index) => {
        if (bodyMissing.length || speciesMissing[index].length) {
          return { species: one, assessment: UNKNOWN_ASSESSMENT, capacityNow: null, capacityAfter: null, missing: [...bodyMissing, ...speciesMissing[index]] }
        }

        const assessment = assessTerraforming(body, one, skill, gasInfo)

        if (assessment.missing) {
          return { species: one, assessment: UNKNOWN_ASSESSMENT, capacityNow: null, capacityAfter: null, missing: assessment.missing }
        }

        const capacityOf = (hydroExt) => (assessment.cost.colonisable ? bodyCapacity({ Radius: body.Radius, HydroExt: hydroExt, TidalLock: body.TidalLock, BodyClass: body.BodyClass, PopulationDensityModifier: one.PopulationDensityModifier }) : 0)

        return {
          species: one,
          assessment,
          capacityNow: capacityOf(body.HydroExt),
          capacityAfter: assessment.plan ? capacityOf(assessment.plan.target.hydroExt) : null,
          missing: NOTHING,
        }
      }),
    }
  })
}

// What one outcome of colonising is worth to the goal, as the parts that multiply into it: the size of the prize (people and mining, each 0 to 1), discounted by the colony cost, the years of terraforming and the distance. Each discount is 1 at zero and 1/2 at its scale.
const worth = (goal, ranking, { capacity, raw, years, distanceAU, minerals, cmcReady }) => {
  const mineralBase = minerals.surveyed ? (minerals.value ?? 0) + (cmcReady ? ranking.cmcBonus : 0) : 0
  const people = capacity / (capacity + PEOPLE_REFERENCE)
  const mining = mineralBase / (mineralBase + MINERAL_REFERENCE)
  const prize = goal === 'people' ? people : goal === 'minerals' ? mining : people + mining
  const cost = 1 / (1 + raw / ranking.costScale)
  const time = 1 / (1 + (Number.isFinite(years) ? years : Infinity) / ranking.yearsScale)
  const distance = distanceAU === null ? NO_ROUTE_FACTOR : 1 / (1 + distanceAU / ranking.distanceScale)

  return { people, mining, prize, cost, time, distance, value: prize * cost * time * distance }
}

// A species on a body, read for the goal at `terraformCapacityPerYear` atm a year of terraforming, or null when that is unknown (no terraforming option is weighed then). `strategy` is whether the worth is highest settling as the body is, or waiting for terraforming. An unknown entry (`missing`) is worth nothing and has no strategy. With a goal that counts the deposits and a deposit value that is unknown (`mineralsUnknown`), the mining part and the prize are null and the value only orders the species: the row is unknown (`rankBodies`).
export const evaluate = ({ species, assessment, capacityNow, capacityAfter, missing = NOTHING }, { goal, ranking, terraformCapacityPerYear, distanceAU, minerals, cmcReady }) => {
  const mineralsUnknown = goal !== 'people' && minerals.surveyed && minerals.value === null
  const base = { species, assessment, capacityNow, capacityAfter, missing, mineralsUnknown }

  if (!assessment.cost.colonisable) {
    return { ...base, value: 0, parts: null, strategy: 'none', years: null, cost: null, raw: null, capacity: 0, infrastructure: null, nowInfrastructure: null, afterInfrastructure: null }
  }

  const nowInfrastructure = infrastructurePerMillion(assessment.cost.worst, species, assessment.cost.lowGravity)
  const options = [{ strategy: 'now', years: 0, cost: assessment.cost.worst, raw: assessment.cost.raw, capacity: capacityNow, lowGravity: assessment.cost.lowGravity, infrastructure: nowInfrastructure }]
  let afterInfrastructure = null

  if (assessment.plan && assessment.after && terraformCapacityPerYear !== null) {
    afterInfrastructure = infrastructurePerMillion(assessment.after.worst, species, assessment.lowGravity)
    options.push({ strategy: 'terraform', years: planYears(assessment.work, terraformCapacityPerYear), cost: assessment.after.worst, raw: assessment.after.raw, capacity: capacityAfter, lowGravity: assessment.lowGravity, infrastructure: afterInfrastructure })
  }

  const best = options.map((option) => {
    const parts = worth(goal, ranking, { ...option, distanceAU, minerals, cmcReady })

    return { ...option, parts, value: parts.value }
  }).sort((a, b) => b.value - a.value || a.years - b.years)[0]

  return { ...base, ...best, parts: mineralsUnknown ? { ...best.parts, mining: null, prize: null } : best.parts, nowInfrastructure, afterInfrastructure }
}

const sumPeople = (populations) => populations.reduce((total, population) => total + population.Population, 0)

// One row per body for the table and chart: the best species for it (or the chosen one), its alternatives, its plan state, and the numbers the columns show. `speciesId` null means the best of all. Every row has a `best`, so a race with no species (nothing to compare bodies against) gets no rows at all. `distanceOf` measures from the nearest sizeable colony, `capitalDistanceOf` from the capital, and `origins` says how many such places the race has (`NO_ORIGINS` for none), so a missing distance can say why; `outlook` is the race's mineral outlook; `cmcRules` is what `cmcSite` needs of the race.
// What cannot be told stays unknown: a row whose best route needs a figure the save lacks (a body or species figure, or the terraforming capacity when a plan is in play) has the `UNKNOWN_STATE`, no score and no rank, and `unknown` names the figures. `basis` is what every row was worked out under, for `rowProvenance`.
export const rankBodies = async (assessed, { speciesId, goal, ranking, rules, terraformers, distanceOf, capitalDistanceOf, cmcRules = NO_CMC_RULES, outlook = NO_OUTLOOK, origins = NO_ORIGINS }) => {
  const capacity = terraformCapacityResult(rules, terraformers)
  const terraformCapacityPerYear = valueOrNull(capacity)
  const basis = Object.freeze({ skillAssumed: !isNumber(rules.ColonizationSkill), capacity, outlookKnown: !!outlook.known, origins, goal })

  const rows = await mapBodies(assessed.filter(({ byspecies }) => byspecies.length), ({ body, byspecies }) => {
    const minerals = mineralSummary(body, ranking, outlook)
    const site = cmcSite(body, cmcRules)
    const cmcReady = minerals.cmc.length > 0 && Object.values(site).every(Boolean)
    const distance = distanceOf(body)
    const distanceAU = distance ? distance.km / KM_PER_AU : null
    const capital = capitalDistanceOf(body)
    const evaluations = byspecies.map((entry) => evaluate(entry, { goal, ranking, terraformCapacityPerYear, distanceAU, minerals, cmcReady }))
    const chosen = evaluations.filter((evaluation) => evaluation.species.SpeciesID === speciesId)
    const considered = chosen.length ? chosen : evaluations
    const [best] = [...considered].sort((a, b) => b.value - a.value || (b.missing.length > 0) - (a.missing.length > 0) || (a.cost ?? Infinity) - (b.cost ?? Infinity))
    const unknownSpecies = considered.some((evaluation) => evaluation.missing.length) ? considered.filter((evaluation) => evaluation.missing.length).map((evaluation) => evaluation.species.SpeciesName) : NOTHING
    const planUnknown = terraformCapacityPerYear === null && considered.some((evaluation) => evaluation.assessment.plan && evaluation.assessment.after)
    const settled = { people: sumPeople(body.OwnPopulations), colonies: body.OwnPopulations.length, alien: body.AlienPopulations.length }
    const route = routeFacts(best, terraformCapacityPerYear === null ? null : planYears(best.assessment.work, terraformCapacityPerYear))
    let facts = { settled, route, richDeposit: minerals.rich, peopleMinimum: ranking.minimumPeople }
    let state = stateOf(facts)
    let unknown = NOTHING
    const room = route ? Math.max(route.capacity, route.plan ? route.plan.capacity || 0 : 0) : 0

    if (best.missing.length && state.id === 'unfit') {
      unknown = best.missing
    } else if (planUnknown && state.target) {
      unknown = capacity.inputs.missing
    } else if (minerals.surveyed && minerals.value === null && mineralsDecide(facts, state, goal, room, ranking)) {
      unknown = minerals.missing
    }

    if (unknown.length) {
      facts = { ...facts, unknown }
      state = UNKNOWN_STATE
    }

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
      target: state.target && worthwhile,
      unknown,
      unknownSpecies,
      basis,
      rank: null,
      score: null,
    }
  })

  const targets = rows.filter((row) => row.target)
  const top = targets.reduce((maximum, row) => Math.max(maximum, row.best.value), 0)

  targets.forEach((row) => {
    row.score = top > 0 ? (100 * row.best.value) / top : null
  })

  targets.filter((row) => row.score >= MINIMUM_TARGET_SCORE).sort((a, b) => b.score - a.score).forEach((row, index) => {
    row.rank = index + 1
  })

  return rows
}

// The factor that sets a cost, as a label for the list ("Water 1.4"), or null.
export const costDriver = (assessmentCost) => (assessmentCost.colonisable ? limitingFactor(assessmentCost.factors) : null)

const COST_INPUTS = ['body environment', 'species ranges', 'colonisation skill']
const CAPACITY_INPUTS = ['body size and water', 'species density']

// Whether a deposit value that is unknown could change a row: its state (a rich deposit makes a mining target), whether it is worth the trip, or the score of a goal that counts the deposits. A people-only goal on a body that holds the smallest colony whatever its deposits is not affected, and neither is a body that is no target either way.
const mineralsDecide = (facts, state, goal, room, ranking) => {
  const rich = stateOf({ ...facts, richDeposit: true })

  return (state.target || rich.target) && (goal !== 'people' || rich !== state || room < ranking.minimumPeople)
}

const lineResult = (line) => (line.value !== null && (line.weight === 0 || line.base === 0) ? ofRule({ rule: 'habitability.mineralValue', value: 0, inputs: { present: [line.weight === 0 ? 'the mineral weight (0)' : 'the deposit amount (under the minimum)'] } }) : combine({ rule: 'habitability.mineralValue', parts: { deposit: line.baseResult, scarcity: line.scarcityResult }, compute: (values) => values.deposit * line.weight * values.scarcity.factor }))

// The deposit value of a surveyed body as a result: unavailable, naming the deposit figures or the runway that is lacking, when any deposit has no value.
const mineralsResult = (minerals, assumptions) => combine({ rule: 'habitability.mineralValue', parts: Object.fromEntries(minerals.lines.map((line, index) => [`${line.name} ${index + 1}`, lineResult(line)])), compute: () => minerals.value, inputs: { present: ['surveyed deposits'] }, assumptions })

// The results behind the figures one row shows, worked out when the row is shown: each is null where the figure does not exist by rule (a body no species can live on, a body that is not a target, an unsurveyed body), a result with the figure where it does, and unavailable, naming the missing inputs, where the save lacks them. The figures are those of the row; this only wraps them.
export const rowProvenance = (row) => {
  const { best, basis } = row
  const colonisable = best.strategy !== 'none'
  const skill = basis.skillAssumed ? [SKILL_ASSUMPTION] : []
  const lacking = best.missing.length ? best.missing : null
  const assumptions = [...(!row.distance && row.score !== null ? [`a body with no charted route keeps ${Math.round(NO_ROUTE_FACTOR * 100)}% of its worth`] : []), ...(!basis.outlookKnown && basis.goal !== 'people' ? ['no mineral ledger in the save: every mineral counts once'] : []), ...(row.unknownSpecies.length ? [`species left out for missing figures: ${row.unknownSpecies.join(', ')}`] : [])]
  const scored = row.score === null ? null : best.assessment.plan && best.assessment.after ? combine({ rule: 'habitability.score', parts: { capacity: basis.capacity }, compute: () => row.score, assumptions }) : ofRule({ rule: 'habitability.score', value: row.score, assumptions })

  return {
    cost: lacking ? unavailable({ rule: 'habitability.colonyCost', missing: lacking }) : colonisable ? ofRule({ rule: 'habitability.colonyCost', value: best.cost, inputs: { present: COST_INPUTS }, assumptions: [...skill, ...(best.strategy === 'terraform' ? ['the terraforming plan is carried out'] : [])] }) : null,
    infrastructure: lacking ? unavailable({ rule: 'habitability.infraPerMillion', missing: lacking }) : colonisable ? infrastructurePerMillionResult(best.assessment.cost.worst, best.species, best.assessment.cost.lowGravity, skill) : null,
    capacity: lacking ? unavailable({ rule: 'habitability.bodyCapacity', missing: lacking }) : colonisable ? ofRule({ rule: 'habitability.bodyCapacity', value: best.capacity, inputs: { present: CAPACITY_INPUTS } }) : null,
    score: row.unknown.length ? unavailable({ rule: 'habitability.score', missing: row.unknown }) : scored,
    distance: row.distance ? ofRule({ rule: 'habitability.distance', value: row.distance, inputs: { present: ['charted jump points', 'colony places'] } }) : unavailable({ rule: 'habitability.distance', missing: [basis.origins.colonies ? 'a charted, explored route from a colony' : 'a capital or colony with people to measure from'] }),
    minerals: row.minerals.surveyed ? mineralsResult(row.minerals, basis.outlookKnown ? [] : ['no mineral ledger in the save: every mineral counts once']) : null,
  }
}

// The results behind one species' cost and population limit on a body as it is today: null where the species cannot settle the body, unavailable, naming the missing inputs, where the save lacks them. The figures are `assessment.cost.worst` and `capacityNow`, those the body detail shows.
export const nowProvenance = (row, evaluation) => {
  const { assessment, missing } = evaluation

  if (missing.length) {
    return { cost: unavailable({ rule: 'habitability.colonyCost', missing }), capacity: unavailable({ rule: 'habitability.bodyCapacity', missing }) }
  }

  if (!assessment.cost.colonisable) {
    return { cost: null, capacity: null }
  }

  return {
    cost: ofRule({ rule: 'habitability.colonyCost', value: assessment.cost.worst, inputs: { present: COST_INPUTS }, assumptions: row.basis.skillAssumed ? [SKILL_ASSUMPTION] : [] }),
    capacity: ofRule({ rule: 'habitability.bodyCapacity', value: evaluation.capacityNow, inputs: { present: CAPACITY_INPUTS } }),
  }
}
