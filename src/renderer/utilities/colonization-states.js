// The Colonization Planner's plan states: what a body is to the race looking at it, and what it takes to settle
// it. One table, read by the ranking (can it be a target), the page (chip, tooltip, legend, counts, filter) and
// docs/DATABASE.md, so a state is defined here and nowhere else.
//
// A state is decided from facts about the body (see `routeFacts` and `stateOf`), first match in table order. The
// route is the one the ranking prefers for the best species: settle it as it is, or wait for terraforming.
//   - who lives there: an own colony with people, an own colony without, a known alien colony;
//   - whether any species can live there, and what a colony costs now against after terraforming;
//   - whether its deposits are rich enough for a mining colony, whatever people could do there.
// Colony cost bands are the game's own: the Minerals window colours a body blue under 2, cyan under 3 and brown
// under 6 times the race's colonisation skill, so they are read on the cost before the skill
// (`raw`), and a race with the cost-cutting tech lands in the same band as one without. What a colony really
// pays is the infrastructure per million people, shown beside the band.

import { RICH_DEPOSIT_VALUE } from './minerals'
import { roundToDecimal } from './math'

// Upper bounds (exclusive) of the cost bands, on the cost before the colonisation skill.
export const COST_BANDS = { cheap: 2, moderate: 3, costly: 6 }

export const costBand = (raw) => (raw <= 0 ? 'free' : raw < COST_BANDS.cheap ? 'cheap' : raw < COST_BANDS.moderate ? 'moderate' : raw < COST_BANDS.costly ? 'costly' : 'severe')

const number = (value, places = 1) => roundToDecimal(value, places).toString()
const years = (value) => (!Number.isFinite(value) ? 'never with these terraformers' : value < 0.1 ? 'under 0.1 years' : `${number(value, value < 10 ? 1 : 0)} years`)
const perMillion = (infrastructure) => `${infrastructure} infrastructure per million people`
const people = (millions) => (millions >= 1000 ? `${number(millions / 1000, 1)} billion` : `${number(millions, millions < 10 ? 2 : 0)} million`)

// What the states read about one body, `facts`: `settled` is { people (millions), colonies (own populations),
// alien (known alien populations) }; `route` the best species' numbers (see `routeFacts`), or null when no
// species can live there; `richDeposit` whether its deposits reach the game's mining-colony value;
// `peopleMinimum` the smallest colony worth planning for, in millions.

// The numbers of one species on one body, before and after terraforming.
export const routeFacts = (evaluation, terraformYears) => {
  const { assessment, capacityNow, capacityAfter, species } = evaluation

  if (!assessment.cost.colonisable) {
    return null
  }

  const plan = assessment.plan && assessment.after && evaluation.strategy === 'terraform' ? { raw: assessment.after.raw, cost: assessment.after.worst, outcome: assessment.outcome, years: terraformYears, capacity: capacityAfter, infrastructure: evaluation.afterInfrastructure } : null

  return {
    species: species.SpeciesName,
    raw: assessment.cost.raw,
    cost: assessment.cost.worst,
    lowGravity: assessment.cost.lowGravity,
    infrastructure: evaluation.nowInfrastructure,
    capacity: capacityNow,
    outcome: assessment.outcome,
    plan,
  }
}

// A body is a terraforming state when the ranking's best route for it is to wait for the plan (`route.plan` is
// only there then): its worth after the years of work beats settling it as it is.
const terraforms = (route) => !!route.plan

const peopleRoom = (route) => Math.max(route.capacity, route.plan ? route.plan.capacity || 0 : 0)

const settleNow = (route, extra = '') => `Costs ${number(route.cost, 2)} for ${route.species}${extra}, which is ${perMillion(route.infrastructure)}${route.lowGravity ? ' (low gravity doubles it)' : ''}. It holds ${people(route.capacity)}.`

// The table. `when` decides, `text` says it for one body with its numbers, `rule` says it in general. `target`
// is whether the state can be ranked as a place to settle next. `group` orders the legend.
export const PLAN_STATES = [
  {
    id: 'colony',
    label: 'Colony',
    group: 'Already yours',
    color: 'success',
    icon: 'mdi-home-city',
    target: false,
    rule: 'You have an own colony here with people on it.',
    when: ({ settled }) => settled.people > 0,
    text: ({ settled }) => `Your own colony: ${people(settled.people)} live here${settled.colonies > 1 ? ` across ${settled.colonies} colonies` : ''}.`,
    chip: ({ settled }) => `Colony · ${people(settled.people)}`,
  },
  {
    id: 'outpost',
    label: 'Outpost',
    group: 'Already yours',
    color: 'info',
    icon: 'mdi-tent',
    target: false,
    rule: 'You have an own colony here with no people yet (installations only).',
    when: ({ settled }) => settled.colonies > 0,
    text: () => 'Your own colony with no people on it yet: installations only.',
    chip: () => 'Outpost',
  },
  {
    id: 'foreign',
    label: 'Alien colony',
    group: 'Not a target',
    color: 'error',
    icon: 'mdi-flag-variant',
    target: false,
    rule: 'Your intelligence shows an alien colony here.',
    when: ({ settled }) => settled.alien > 0,
    text: ({ settled }) => `A known alien colony${settled.alien > 1 ? `s (${settled.alien})` : ''} is here.`,
    chip: () => 'Alien colony',
  },
  {
    id: 'unfit',
    label: 'Not habitable',
    group: 'Not a target',
    color: 'error',
    icon: 'mdi-cancel',
    target: false,
    rule: 'No species of yours can live here: too heavy for all of them, or a fixed body. A rich deposit can still be mined with a civilian complex or ships.',
    when: ({ route }) => route === null,
    text: ({ richDeposit }) => `No species of yours can live here (gravity or a fixed body).${richDeposit ? ' The deposits are rich: a civilian mining complex or orbital miners can still work them.' : ''}`,
    chip: () => 'Not habitable',
  },
  {
    id: 'mining',
    label: 'Mining colony',
    group: 'Mining',
    color: 'amber darken-3',
    icon: 'mdi-pickaxe',
    target: true,
    rule: `Deposits worth ${RICH_DEPOSIT_VALUE} or more (the game's own threshold for seeding a mining colony) on a body too small to hold the colony worth planning for (see "Smallest colony" in Ranking). Plan it for the mines, not the people.`,
    when: ({ route, richDeposit, peopleMinimum }) => richDeposit && peopleRoom(route) < peopleMinimum,
    text: ({ route, peopleMinimum }) => `Rich deposits on a body that holds only ${people(peopleRoom(route))} (under ${peopleMinimum} M). Colonise it for the mines: ${perMillion(route.infrastructure)} at a cost of ${number(route.cost, 2)}.`,
    chip: ({ route }) => `Mining · ${route.infrastructure}/M`,
  },
  {
    id: 'terraform-free',
    label: 'Terraform to free',
    group: 'Terraform first',
    color: 'purple',
    icon: 'mdi-earth-arrow-right',
    target: true,
    rule: 'The best route is to terraform first, and the plan makes the colony cost 0 at every point of the orbit, so it needs no infrastructure afterwards.',
    when: ({ route }) => terraforms(route) && route.plan.outcome === 'yes',
    text: ({ route }) => `Terraforming takes ${years(route.plan.years)} with your terraformers and leaves the colony free, against ${perMillion(route.infrastructure)} now. It then holds ${people(route.plan.capacity)}.`,
    chip: ({ route }) => `To free · ${years(route.plan.years)}`,
  },
  {
    id: 'terraform-partial',
    label: 'Terraform, part free',
    group: 'Terraform first',
    color: 'indigo',
    icon: 'mdi-earth-arrow-right',
    target: true,
    rule: 'The best route is to terraform first, but the plan frees the colony at part of an eccentric orbit only, so some of the year it still costs infrastructure.',
    when: ({ route }) => terraforms(route) && route.plan.outcome === 'partial',
    text: ({ route }) => `Terraforming takes ${years(route.plan.years)} and makes it free at part of its orbit; the worst point still costs ${number(route.plan.cost, 2)}. It then holds ${people(route.plan.capacity)}.`,
    chip: ({ route }) => `Part free · ${years(route.plan.years)}`,
  },
  {
    id: 'terraform-cheaper',
    label: 'Terraform to cheaper',
    group: 'Terraform first',
    color: 'blue-grey',
    icon: 'mdi-earth-arrow-right',
    target: true,
    rule: 'The best route is to terraform first: the plan lowers the colony cost, but not to 0.',
    when: ({ route }) => terraforms(route),
    text: ({ route }) => `Terraforming takes ${years(route.plan.years)} and lowers the cost from ${number(route.cost, 2)} to ${number(route.plan.cost, 2)}, ${perMillion(route.plan.infrastructure)} against ${route.infrastructure} now.`,
    chip: ({ route }) => `Cheaper · ${years(route.plan.years)}`,
  },
  {
    id: 'free',
    label: 'Free colony',
    group: 'Settle now',
    color: 'success',
    icon: 'mdi-check-circle',
    target: true,
    rule: 'The colony cost is 0 at every point of the orbit: no infrastructure, ever. Rare, and the best a body can be.',
    when: ({ route }) => costBand(route.raw) === 'free',
    text: ({ route }) => `Colony cost 0 for ${route.species} all year round: settle it and grow with no infrastructure. It holds ${people(route.capacity)}.`,
    chip: () => 'Free colony',
  },
  {
    id: 'cheap',
    label: 'Cheap',
    group: 'Settle now',
    color: 'teal',
    icon: 'mdi-home-plus',
    target: true,
    rule: `Colony cost under ${COST_BANDS.cheap} before your colonisation tech (the game's blue band). Settle it as it is and build the infrastructure it needs.`,
    when: ({ route }) => costBand(route.raw) === 'cheap',
    text: ({ route }) => settleNow(route),
    chip: ({ route }) => `Cheap · ${route.infrastructure}/M`,
  },
  {
    id: 'moderate',
    label: 'Moderate',
    group: 'Settle now',
    color: 'light-blue darken-1',
    icon: 'mdi-home-plus',
    target: true,
    rule: `Colony cost ${COST_BANDS.cheap} to ${COST_BANDS.moderate} before your colonisation tech (the game's cyan band). The usual price of a breathable-gas or dry world: settle it and build the infrastructure.`,
    when: ({ route }) => costBand(route.raw) === 'moderate',
    text: ({ route }) => settleNow(route),
    chip: ({ route }) => `Moderate · ${route.infrastructure}/M`,
  },
  {
    id: 'costly',
    label: 'Costly',
    group: 'Settle now',
    color: 'orange darken-2',
    icon: 'mdi-home-alert',
    target: true,
    rule: `Colony cost ${COST_BANDS.moderate} to ${COST_BANDS.costly} before your colonisation tech (the game's brown band). Possible, but each million people needs a lot of infrastructure.`,
    when: ({ route }) => costBand(route.raw) === 'costly',
    text: ({ route }) => settleNow(route),
    chip: ({ route }) => `Costly · ${route.infrastructure}/M`,
  },
  {
    id: 'severe',
    label: 'Severe',
    group: 'Settle now',
    color: 'deep-orange darken-3',
    icon: 'mdi-home-alert',
    target: true,
    rule: `Colony cost ${COST_BANDS.costly} or more before your colonisation tech. Hostile: only a very large body or a rich deposit makes it worth the infrastructure.`,
    when: ({ route }) => costBand(route.raw) === 'severe',
    text: ({ route }) => settleNow(route),
    chip: ({ route }) => `Severe · ${route.infrastructure}/M`,
  },
]

export const STATE_BY_ID = Object.fromEntries(PLAN_STATES.map((state) => [state.id, state]))

export const stateOf = (facts) => PLAN_STATES.find((state) => state.when(facts))

export const STATE_GROUPS = [...new Set(PLAN_STATES.map((state) => state.group))].map((group) => ({ group, states: PLAN_STATES.filter((state) => state.group === group) }))
