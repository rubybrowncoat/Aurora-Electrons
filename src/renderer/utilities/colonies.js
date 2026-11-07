// Colony maths for the Colony Outlook page: body capacity, population growth, infrastructure and the worker split. Sources and checks: docs/plans/aurcalcs/build-2.md § Colony Outlook. The numeric helpers (`bodyCapacity`, `growthRate`, `projectBody`, `workerSplit`) take validated inputs and run in the projection loop; the `...Result` helpers check the inputs, name what a colony lacks and return a provenance result (utilities/provenance.js), so a figure the save cannot support is unavailable rather than 0.

import { ceilRatio, floorRatio, fromDouble, fromString, multiply, round, toNumber } from './decimal'
import { colonyCost } from './habitability'
import { UNKNOWN_TEXT, isKnownNumber, roundToDecimal } from './math'
import { combine, isAvailable, ofRule, registerRule, satisfies, unavailable } from './provenance'

const EARTH_SURFACE_AREA = 511187128
// Millions of people an Earth-sized body holds (docs `colonies`, Population Capacity).
const EARTH_CAPACITY = 12000
// Every non-gas-giant body holds at least 50,000 people.
const MINIMUM_CAPACITY = 0.05
const MONTHS_PER_YEAR = 12
// Workers in millions: a balance this close to zero is balanced, not short.
export const WORKER_TOLERANCE = 0.005
const COLONY_VERSIONS = ['3.2.x']
// The growth rule is checked against source-worked ordering, radiation rounding and shortfall cases.
const GROWTH_VERSIONS = ['3.2.x']
// The implied colony cost alone: check-breather-cost runs every colony with people of the fixture and of a played save through it against the planner's cost for the colony's species.
const COST_VERSIONS = ['3.2.x']
const TOTALS = 'colonies.totals'

// Math.PI remains retained for family 12.
registerRule({
  id: 'colonies.capacity',
  versions: ['2.7.x'],
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Radius, HydroExt, TidalLock, BodyClass', 'FCT_Species.PopulationDensityModifier', 'the current colony cost'],
  note: 'A non-colonisable body holds no surface population; otherwise capacity is surface area over Earth times the baseline density and species density, reduced above three quarters water and on tide-locked planets, with a minimum of 50,000 people.',
  assumptions: ['the geometric area is an approximation'],
})

// The game sums every race's surface residents on each body.
registerRule({
  id: 'colonies.crowding',
  versions: COLONY_VERSIONS,
  units: 'share of capacity',
  verification: 'estimated',
  structure: ['FCT_Population.Population summed per body across all races in the game'],
  note: 'All surface residents on the body, across every race, over the body\'s capacity; growth slows past a third. Orbital people are not surface residents. It rests on the capacity rule and is not compared with a stored figure.',
  assumptions: ['a body whose colonies include an unknown population has no crowding figure'],
})

registerRule({
  id: 'colonies.growthRate',
  versions: GROWTH_VERSIONS,
  units: 'per year',
  verification: 'estimated',
  structure: ['FCT_Species.PopulationGrowthModifier, PopulationDensityModifier', 'FCT_Commander, FCT_CommanderBonuses (Population Growth bonus 8)', 'FCT_SystemBody.RadiationLevel', 'FCT_Population.Population', 'the current colony cost and infrastructure'],
  note: 'Annual growth is a negative quarter of the infrastructure-shortfall colony cost, or the capped base rate times the governor bonus. Only positive growth takes the species modifier. The radiation penalty is rounded to two percentage-point decimals, ties to even, before subtraction; only a still-positive rate is crowded by all races\' surface residents above one third of capacity, with denominator 0.6667. No surface people means zero growth; a non-colonisable colony loses its surface population at an annual rate of one.',
  assumptions: ['current colony cost, gravity and infrastructure are evaluated at the snapshot climate; no temperature evolution or unrest is forecast'],
})

// A monthly horizon approximation, not a replay of saved increments.
registerRule({
  id: 'colonies.populationProjection',
  versions: COLONY_VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_Population.Population', 'the growth rate and capacity rules', 'FCT_MoveOrders, FCT_ShipCargo (colonists on their way)', 'the infrastructure cap rule'],
  note: 'Each production increment changes population linearly by the annual growth rate times the elapsed years. This horizon estimate takes monthly increments, recalculating the annual rate, shared surface crowding and truncated current infrastructure requirement at each boundary. An infrastructure shortfall causes shrinkage rather than clamping the population to the supported-population metric.',
  assumptions: ['each increment is one twelfth of a year, not the actual saved production-increment sequence', 'the selected race\'s surface colonies grow together; other races\' surface residents remain fixed at their snapshot populations and still count toward crowding', 'inbound colonists and infrastructure arrive at the start; no other migration, construction, temperature, radiation, governor or species change occurs', 'current and maximum colony costs stay at the snapshot climate, rather than following seasons or terraforming', 'radiation uses decimal ties-to-even rounding and the total infrastructure requirement is truncated per increment; population, cube roots and crowding use floating-point estimates rather than reproducing every decimal operation of a later save'],
})

registerRule({
  id: 'colonies.infrastructureRate',
  versions: COLONY_VERSIONS,
  units: 'infrastructure per M people',
  verification: 'confirmed',
  structure: ['FCT_Population.ReqInf, Population'],
  note: 'The colony\'s stored infrastructure requirement over its population in millions; the requirement already holds the doubling on a low-gravity body. A requirement of 0 is a colony that needs none. Arithmetic on two stored values.',
})

// The game reads no LGInfrastructureValue.
registerRule({
  id: 'colonies.infrastructureCap',
  versions: COLONY_VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.InfrastructureValue', 'the maximum colony cost, species density and gravity multiplier', 'FCT_MoveOrders, FCT_ShipCargo (infrastructure on its way)'],
  note: 'Supported population is ordinary infrastructure divided by the separately ceiling-rounded maximum colony cost times one hundred times the gravity multiplier over species density, at least one for a positive cost. Low gravity doubles the requirement, not the infrastructure balance. A zero cost needs no infrastructure. The truncated saved total requirement is not divided back by population to infer this denominator.',
})

registerRule({
  id: 'colonies.infrastructureNeeded',
  versions: COLONY_VERSIONS,
  units: 'infrastructure',
  verification: 'estimated',
  structure: ['FCT_Population.ReqInf, Population', 'DIM_PlanetaryInstallation.InfrastructureValue, Cost', 'the population projection rule'],
  note: 'Infrastructure still to build to support the projected population at the horizon: the projected population times the requirement per million, less the infrastructure built and on its way. Its cost in BP uses the cheapest installation that gives infrastructure. It rests on the projection and is not compared with a stored figure.',
})

registerRule({
  id: 'colonies.colonyCost',
  versions: COST_VERSIONS,
  units: 'colony cost',
  verification: 'confirmed',
  structure: ['FCT_Population.ReqInf, Population', 'FCT_Species.PopulationDensityModifier, Gravity, GravDev', 'FCT_SystemBody.Gravity'],
  note: 'The colony cost the stored infrastructure requirement implies (requirement times density over 100 per million people), halved on a low-gravity body. It sets the share of people in agriculture and environment, and through the worker split it reproduced the stored efficiency of 5 low-gravity colonies of a save it was checked on (largest difference 0.0027), so the halving holds there. Against the planner\'s colony cost of the body, now or worst of the orbit, it agrees on every colony with people of the migrated fixture (22, oxygen breathers) and of a played save (44, oxygen, methane, ammonia and sulphur dioxide breathers), within a hundredth of the cost and five thousandths of a unit: the stored requirement is one step older than the climate and the people it is read against, and a colony of a few hundred people tells its cost only as a range.',
})

// The game's total population includes orbital people.
registerRule({
  id: 'colonies.workers',
  versions: COLONY_VERSIONS,
  units: 'M workers',
  verification: 'confirmed',
  structure: ['FCT_Population.Population', 'the orbital population census', 'FCT_PopulationInstallations, DIM_PlanetaryInstallation.Workers', 'FCT_Shipyard.Capacity, Slipways, SYType, ParentShipID', 'the maximum colony cost'],
  note: 'The agriculture and environment share is capped at one and applies to surface people using the maximum colony cost. Services use surface plus orbital people, with share (total population over one thousand million) to the quarter power, at most seven tenths, reduced to what agriculture leaves. The remainder can staff installations and colony shipyards; yards aboard ships need no colony workers.',
  assumptions: ['orbital people stay in place over the surface-population horizon; the orbital census keeps its own membership limitations'],
})

registerRule({
  id: 'colonies.attention',
  versions: ['x'],
  units: 'flag',
  verification: 'estimated',
  structure: ['the worker and population projection rules'],
  note: 'A colony is flagged when it is short of workers now or at the horizon, or when its population outgrows the support of its infrastructure within the horizon. It is unavailable when none of the three tests is true and one cannot be decided.',
})

registerRule({
  id: TOTALS,
  versions: ['x'],
  units: '',
  verification: 'estimated',
  structure: ['the colonies\' own results'],
  note: 'Sums and counts over the race\'s colonies for the tiles. A colony whose figure is unavailable is left out of a count or sum that says so, or makes a sum that cannot do without it unavailable. A total is only as sure as the weakest colony in it, and none is compared with a stored total.',
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const unique = (list) => [...new Set(list)]

export const environmentCostResult = (body, species, skill) => ofRule({ rule: 'habitability.colonyCost', value: colonyCost(body, species, skill), inputs: { present: ['the body\'s climate', 'the colony\'s species', 'the race\'s colonisation skill'] }, assumptions: ['the present climate and the orbit\'s maximum colony cost stay fixed over the population horizon'] })

// The words for the colony figures a result can lack, by the field of the colony row that holds them.
const BODY_CENSUS_MISSING = 'the population of another colony on the body'
const FIELD_WORDS = { Radius: 'the body\'s radius', HydroExt: 'the body\'s hydrographic extent', TidalLock: 'whether the body is tidally locked', BodyClass: 'the body\'s class', RadiationLevel: 'the body\'s radiation level', LowGravity: 'whether the body has low gravity', PopulationDensityModifier: 'the species\' population density modifier', PopulationGrowthModifier: 'the species\' population growth modifier', PopulationGrowthBonus: 'the colony\'s population growth bonus', Population: 'the colony\'s population', BodyPopulation: BODY_CENSUS_MISSING, ReqInf: 'the infrastructure the colony requires', Infrastructure: 'the infrastructure of the colony', InfrastructureCost: 'the cost of an infrastructure installation', InstallationWorkers: 'the workers the installations need', YardWorkers: 'the workers the yards need' }

const wordsOf = (name) => ({ CurrentColonyCost: 'the current colony cost', MaximumColonyCost: 'the maximum colony cost', OrbitalPopulation: 'the orbital population' }[name] || FIELD_WORDS[name] || name)

// A result of `rule` for a colony: unavailable naming the `required` columns of `source` that are not numbers (and what its unavailable `parts` lack), otherwise `compute(values)` of the parts' values, at the weakest status of the rule and its parts.
const derive = ({ rule, source = {}, required = [], parts = {}, compute, units }) => {
  const missing = required.filter((name) => !finite(source[name])).map(wordsOf)
  const present = required.filter((name) => finite(source[name]))

  if (source.EnvironmentCost) {
    parts = { ...parts, environment: source.EnvironmentCost }
  }

  if (!missing.length) {
    return combine({ rule, parts, compute, units, inputs: { present } })
  }

  const lacking = Object.entries(parts).filter(([, part]) => !isAvailable(part)).flatMap(([name, part]) => (part.inputs.missing.length ? part.inputs.missing : [name]))

  return unavailable({ rule, missing: unique([...missing, ...lacking]), present, units })
}

// Millions of people the body holds before growth stops: surface area, the species' density, less above 75% water (1% at 100%) and a fifth on a tide-locked planet. Moons are exempt from the tidal rule, as in habitability.vue.
export const bodyCapacity = ({ Radius, HydroExt, TidalLock, BodyClass, PopulationDensityModifier, CurrentColonyCost }) => {
  if (CurrentColonyCost === -1) {
    return 0
  }

  const area = 4 * Math.PI * Radius ** 2
  const water = HydroExt > 75 ? Math.max((100 - HydroExt) / 25, 0.01) : 1
  const tidal = TidalLock && BodyClass !== 2 ? 5 : 1

  return Math.max(((area / EARTH_SURFACE_AREA) * EARTH_CAPACITY * PopulationDensityModifier * water) / tidal, MINIMUM_CAPACITY)
}

export const bodyCapacityResult = (colony) => derive({ rule: 'colonies.capacity', source: colony, required: ['CurrentColonyCost', ...(colony.CurrentColonyCost === -1 ? [] : ['Radius', 'HydroExt', 'TidalLock', 'PopulationDensityModifier', ...(colony.TidalLock ? ['BodyClass'] : [])])], compute: () => bodyCapacity(colony) })

// Growth before modifiers: 20% / cube root of the population in millions, at most 10%.
export const baseGrowthRate = (population) => (population > 0 ? Math.min(0.1, 0.2 / Math.cbrt(population)) : 0)

// Full growth up to a third of the body's capacity, then a linear fall to none at capacity. A capacity that is not positive has no crowding figure.
export const crowdingFactor = (bodyPopulation, capacity) => (capacity > 0 ? (bodyPopulation <= capacity / 3 ? 1 : Math.max(0, (capacity - bodyPopulation) / (capacity * 0.6667))) : 0)

// The game subtracts the rounded radiation penalty before crowding and never crowds a negative rate.
export const growthRate = (colony, population, bodyPopulation, capacity, infrastructure = infrastructureOf(colony, null)) => {
  if (!(population > 0)) {
    return 0
  }
  if (colony.CurrentColonyCost === -1) {
    return -1
  }

  const cost = colony.CurrentColonyCost
  const requirement = cost > 0 ? floorRatio(multiply(multiply(fromDouble(population), fromDouble(cost)), fromString(colony.LowGravity ? '200' : '100')), fromDouble(colony.PopulationDensityModifier)) : 0
  const shortfall = requirement > infrastructure ? cost * (infrastructure > 0 ? (requirement - infrastructure) / requirement : 1) : 0

  const growth = shortfall > 0 ? -shortfall * 0.25 : baseGrowthRate(population) * colony.PopulationGrowthBonus
  const radiation = toNumber(round(multiply(fromDouble(colony.RadiationLevel), fromString('0.0025')), 2)) / 100
  const rate = (growth > 0 ? growth * colony.PopulationGrowthModifier : growth) - radiation

  return rate > 0 ? rate * crowdingFactor(bodyPopulation, capacity) : rate
}

export const growthRateResult = (colony, capacity) => derive({ rule: 'colonies.growthRate', source: colony, required: ['Population', 'BodyPopulation', 'CurrentColonyCost', 'PopulationDensityModifier', 'LowGravity', 'Infrastructure', 'PopulationGrowthModifier', 'PopulationGrowthBonus', 'RadiationLevel'], parts: { capacity }, compute: ({ capacity: value }) => growthRate(colony, colony.Population, colony.BodyPopulation, value) })

// All races' surface population on the body as a share of the body's capacity.
export const crowdingResult = (colony, capacity) => derive({ rule: 'colonies.crowding', source: colony, required: ['Population', 'BodyPopulation'], parts: { capacity }, compute: ({ capacity: value }) => (Math.max(0, colony.BodyPopulation - colony.Population) + colony.Population) / value })

// A colony that needs infrastructure needs a population to divide it by.
const withPopulation = (colony) => (colony.ReqInf > 0 && !(colony.Population > 0) ? { ...colony, Population: null } : colony)

// Infrastructure per million people. The game's live requirement (`ReqInf`) already doubles it on low-gravity bodies, so it's used rather than the stale `LastColonyCost`. 0 is a colony that needs none; a requirement the save lacks is unavailable.
export const infrastructureRateResult = (colony) => derive({ rule: 'colonies.infrastructureRate', source: withPopulation(colony), required: ['ReqInf', ...(colony.ReqInf > 0 ? ['Population'] : [])], compute: () => (colony.ReqInf > 0 ? colony.ReqInf / colony.Population : 0) })

// RecalculateColonyInfrastructureMetrics ceilings the maximum cost requirement independently of the truncated saved total.
export const infrastructureSupportRateResult = (colony) => derive({
  rule: 'colonies.infrastructureCap',
  source: colony,
  required: ['MaximumColonyCost', 'PopulationDensityModifier', 'LowGravity'],
  units: 'infrastructure per M people',
  compute: () => {
    const cost = colony.MaximumColonyCost
    const numerator = multiply(fromDouble(cost), fromString(colony.LowGravity ? '200' : '100'))

    return cost > 0 ? Math.max(1, ceilRatio(numerator, fromDouble(colony.PopulationDensityModifier))) : cost === 0 ? 0 : Math.ceil(toNumber(numerator) / colony.PopulationDensityModifier)
  },
})

// The game counts only InfrastructureValue; low gravity changes the requirement, not the balance.
export const infrastructureOf = (colony, arriving) => {
  const terms = [colony.Infrastructure, arriving ? arriving.Infrastructure : 0]

  return terms.every(finite) ? terms.reduce((sum, value) => sum + value, 0) : NaN
}

// Millions of people the colony's infrastructure supports; Infinity when it needs none.
export const infrastructureCapResult = (infrastructure, rate) => derive({ rule: 'colonies.infrastructureCap', source: { Infrastructure: infrastructure }, required: ['Infrastructure'], parts: { rate }, compute: ({ rate: perMillion }) => (perMillion ? infrastructure / perMillion : Infinity) })

// Infrastructure to build to keep growing to the horizon, from the population unconstrained by infrastructure. A colony that needs none needs 0, whatever its projection.
export const infrastructureNeededResult = (infrastructure, rate, uncapped) => {
  if (isAvailable(rate) && rate.value === 0) {
    return combine({ rule: 'colonies.infrastructureNeeded', parts: { rate }, compute: () => 0 })
  }

  return derive({ rule: 'colonies.infrastructureNeeded', source: { Infrastructure: infrastructure }, required: ['Infrastructure'], parts: { rate, projection: uncapped }, compute: ({ rate: perMillion, projection }) => Math.max(0, Math.ceil(projection.final * perMillion - infrastructure)) })
}

// What that infrastructure costs, in BP. Nothing to build costs nothing, whatever the installation's price.
export const infrastructureCostResult = (colony, needed) => {
  if (isAvailable(needed) && needed.value === 0) {
    return combine({ rule: 'colonies.infrastructureNeeded', parts: { needed }, compute: () => 0, units: 'BP' })
  }

  return derive({ rule: 'colonies.infrastructureNeeded', source: colony, required: ['InfrastructureCost'], parts: { needed }, compute: ({ needed: amount }) => amount * colony.InfrastructureCost, units: 'BP' })
}

// The colony cost the infrastructure requirement implies (ReqInf = population x CC x 100 / density). A low-gravity body needs twice the infrastructure at the same colony cost (docs `planetary-installations`), and ReqInf holds that factor.
export const colonyCostResult = (colony) => derive({ rule: 'colonies.colonyCost', source: withPopulation(colony), required: ['ReqInf', ...(colony.ReqInf > 0 ? ['Population', 'PopulationDensityModifier', 'LowGravity'] : [])], compute: () => (colony.ReqInf > 0 ? (colony.ReqInf * colony.PopulationDensityModifier) / (colony.Population * 100 * (colony.LowGravity ? 2 : 1)) : 0) })

// RecalculateWorkforceBreakdown allocates agriculture from surface people first, then services from surface plus orbital people, reducing services rather than agriculture when the two fill the total.
export const workerSplit = (colony, population, cost, required = colony.InstallationWorkers + colony.YardWorkers) => {
  const orbitalPopulation = colony.OrbitalPopulation ?? 0
  const totalPopulation = population + orbitalPopulation
  const agriculture = Math.min(1, 0.05 * (cost + 1)) * population
  const service = Math.min(totalPopulation > 0 ? Math.min(0.7, (totalPopulation / 1000) ** 0.25) * totalPopulation : 0, totalPopulation - agriculture)
  const available = Math.max(0, totalPopulation - agriculture - service)

  return {
    population,
    orbitalPopulation,
    totalPopulation,
    service,
    agriculture,
    available,
    required,
    free: available - required,
    efficiency: required > 0 ? Math.min(1, available / required) : 1,
  }
}

// The worker split of a colony now, or at the horizon when given its `projection` result.
export const workerSplitResult = (colony, cost, projection = null) => derive({ rule: 'colonies.workers', source: colony, required: ['InstallationWorkers', 'YardWorkers', ...(projection ? [] : ['Population'])], parts: { cost, ...(projection ? { projection } : {}), ...(colony.OrbitalPopulationResult ? { orbital: colony.OrbitalPopulationResult } : {}) }, compute: ({ cost: value, projection: later }) => workerSplit(colony, later ? later.final : colony.Population, value) })

// Residents outside the selected race are known at the snapshot but held fixed over its horizon. An unknown census has no figure rather than a share of a partial total.
const fixedSurfacePopulation = (members) => {
  const census = members.length ? members[0].colony.BodyPopulation : 0
  const own = members.reduce((sum, member) => sum + member.colony.Population, 0)

  return finite(census) && finite(own) ? Math.max(0, census - own) : null
}

// Monthly horizon estimate: re-evaluate the annual rate and the integer current requirement at each boundary, then take one linear 1/12-year production increment. Infrastructure support is a warning threshold, not a hard population clamp.
export const projectBody = (members, years) => {
  const months = Math.round(years * MONTHS_PER_YEAR)
  const fixedPopulation = fixedSurfacePopulation(members)

  // The result helpers return unavailable before this point when the census is unknown; a direct call gets no figure rather than a share of a partial total.
  if (fixedPopulation === null) {
    return null
  }

  let populations = members.map(({ colony, inboundColonists = 0 }) => colony.Population + inboundColonists)
  const results = members.map(({ infrastructureCap = Infinity }, index) => ({ series: [], crowdedAt: null, infrastructureAt: populations[index] >= infrastructureCap ? 0 : null }))

  for (let month = 0; month <= months; month++) {
    const bodyPopulation = fixedPopulation + populations.reduce((sum, population) => sum + population, 0)

    results.forEach((result, index) => {
      result.series.push(populations[index])

      if (bodyPopulation / members[index].capacity >= 1 / 3 && result.crowdedAt === null) {
        result.crowdedAt = month
      }
    })

    if (month === months) {
      break
    }

    populations = members.map(({ colony, capacity, infrastructure = infrastructureOf(colony, null), infrastructureCap = Infinity }, index) => {
      const population = populations[index]
      const rate = growthRate(colony, population, bodyPopulation, capacity, infrastructure)
      const next = population * (1 + rate / MONTHS_PER_YEAR)

      if (next >= infrastructureCap && results[index].infrastructureAt === null) {
        results[index].infrastructureAt = month + 1
      }

      return Math.max(0, next)
    })
  }

  return results.map((result, index) => ({ ...result, final: populations[index] }))
}

const PROJECTION_COLUMNS = ['Population', 'BodyPopulation', 'CurrentColonyCost', 'PopulationDensityModifier', 'LowGravity', 'Infrastructure', 'PopulationGrowthModifier', 'PopulationGrowthBonus', 'RadiationLevel']

// The projections of the colonies of one body, as results. Each member is { colony, inboundColonists, capacity, cap } with `capacity` and `cap` (the infrastructure cap) results; `uncapped` is a member projected without its cap. The colonies grow against each other's population, so one colony the model cannot read leaves every colony of the body unavailable, naming the colony that lacks the input.
export const projectionResults = (members, years, uncapped = null) => {
  const rule = 'colonies.populationProjection'
  const partsOf = (member) => (member === uncapped ? { capacity: member.capacity } : { capacity: member.capacity, cap: member.cap })
  // The body's census is shared by every colony on it, so an unknown term in it is not repeated as each colony's own missing input.
  const census = members.every((member) => finite(member.colony.BodyPopulation)) ? [] : [BODY_CENSUS_MISSING]
  const lacks = members.map((member) => {
    const own = PROJECTION_COLUMNS.filter((name) => name !== 'BodyPopulation' && !finite(member.colony[name])).map(wordsOf)
    const parts = Object.entries(partsOf(member)).filter(([, part]) => !isAvailable(part)).flatMap(([name, part]) => (part.inputs.missing.length ? part.inputs.missing : [name]))

    return unique([...own, ...(finite(member.inboundColonists) ? [] : ['colonists on their way']), ...parts])
  })

  if (census.length || lacks.some((list) => list.length)) {
    return members.map((member, index) => unavailable({ rule, missing: unique([...census, ...lacks[index], ...members.flatMap((other, otherIndex) => (otherIndex === index ? [] : lacks[otherIndex].map((name) => `${name} of ${other.colony.PopName}`)))]), present: PROJECTION_COLUMNS.filter((name) => finite(member.colony[name])) }))
  }

  const projections = projectBody(members.map((member) => ({ colony: member.colony, inboundColonists: member.inboundColonists, capacity: member.capacity.value, infrastructure: member === uncapped ? Infinity : infrastructureOf(member.colony, member.arriving), infrastructureCap: member === uncapped ? Infinity : member.cap.value })), years)

  return members.map((member, index) => combine({ rule, parts: partsOf(member), compute: () => projections[index], inputs: { present: PROJECTION_COLUMNS } }))
}

// Whether a colony needs attention: short of workers now or at the horizon, or its population outgrows its infrastructure's support within it. True as soon as one test is, whatever the others; unavailable when none is and one cannot be decided.
export const attentionResult = (workersNow, workersLater, projection) => {
  const rule = 'colonies.attention'
  const parts = { workersNow, workersLater, projection }
  const verdicts = [satisfies(workersNow, (workers) => workers.free < -WORKER_TOLERANCE), satisfies(workersLater, (workers) => workers.free < -WORKER_TOLERANCE), satisfies(projection, (later) => later.infrastructureAt !== null)]

  if (verdicts.includes(true)) {
    return combine({ rule, parts: Object.fromEntries(Object.entries(parts).filter(([, part]) => isAvailable(part))), compute: () => true })
  }

  return combine({ rule, parts, compute: () => false })
}

// A total over the colonies' results for a tile: the sum of `pick(value)` (a count when `pick` gives 0 or 1). Unavailable with no colonies. A colony whose result is unavailable makes the total unavailable, or with `partial` is left out and named in the result's assumptions. Returns { result, unknown } with the number of colonies left out.
export const totalResult = ({ results, pick, partial = false, units }) => {
  const known = results.filter(isAvailable)
  const unknown = results.length - known.length
  const lacking = unique(results.filter((result) => !isAvailable(result)).flatMap((result) => result.inputs.missing))

  if (!results.length) {
    return { result: unavailable({ rule: TOTALS, missing: ['colonies'], units }), unknown }
  }

  if (partial && !known.length) {
    return { result: unavailable({ rule: TOTALS, missing: lacking, units }), unknown }
  }

  const parts = Object.fromEntries((partial ? known : results).map((result, index) => [`colony ${index + 1}`, result]))
  const compute = (values) => Object.values(values).reduce((sum, value) => sum + pick(value), 0)
  const left = partial && unknown ? { assumptions: [`${unknown} of ${results.length} colonies are left out: their figure is unavailable`], inputs: { missing: lacking } } : {}

  return { result: combine({ rule: TOTALS, parts, compute, units, ...left }), unknown }
}

// Everything the Colony Outlook shows per colony, as results: the colonies (as read), the inbound rows, the horizon in years. Each entry is { colony, arriving, otherSeries, results }; `otherSeries` is the rest of the body's population month by month as it grows alongside the colony, null when the body has no projection.
export const outlookColonies = (colonies, inbound, years) => {
  const arrivals = Object.fromEntries(inbound.map((row) => [row.PopulationID, row]))
  const bodies = {}

  const members = colonies.map((colony) => {
    const arriving = arrivals[colony.PopulationID] || null
    const infrastructure = infrastructureOf(colony, arriving)
    const rate = infrastructureSupportRateResult(colony)

    return { colony, arriving, infrastructure, rate, capacity: bodyCapacityResult(colony), cap: infrastructureCapResult(infrastructure, rate), inboundColonists: arriving ? arriving.Colonists : 0 }
  })

  // The selected race's populations grow together; the body's other surface residents stay fixed.
  members.forEach((member) => (bodies[member.colony.SystemBodyID] = bodies[member.colony.SystemBodyID] || []).push(member))

  return members.map((member) => {
    const { colony, arriving, infrastructure, rate, capacity, cap } = member
    const group = bodies[colony.SystemBodyID]
    const index = group.indexOf(member)
    const projections = projectionResults(group, years)
    const projection = projections[index]
    const fixedPopulation = fixedSurfacePopulation(group)
    // The chart's remaining surface population includes fixed residents of other races.
    const otherSeries = projections.every(isAvailable) ? projection.value.series.map((_, month) => fixedPopulation + projections.reduce((sum, other, otherIndex) => sum + (otherIndex === index ? 0 : other.value.series[month]), 0)) : null
    // Unconstrained by infrastructure: what it would take to keep growing.
    const potential = !isAvailable(cap) || cap.value === Infinity ? projection : projectionResults(group, years, member)[index]
    const cost = derive({ rule: 'habitability.colonyCost', source: colony, required: ['MaximumColonyCost'], compute: () => colony.MaximumColonyCost, units: 'colony cost' })
    const workersNow = workerSplitResult(colony, cost)
    const workersLater = workerSplitResult(colony, cost, projection)
    const needed = infrastructureNeededResult(infrastructure, rate, potential)

    return {
      colony,
      arriving,
      otherSeries,
      results: {
        capacity,
        fill: crowdingResult(colony, capacity),
        growth: growthRateResult(colony, capacity),
        projection,
        rate,
        cap,
        needed,
        neededCost: infrastructureCostResult(colony, needed),
        cost,
        workersNow,
        workersLater,
        attention: attentionResult(workersNow, workersLater, projection),
      },
    }
  })
}

// Millions of people, at a readable precision; a dash when the figure is not known (null, undefined or not finite), never '0'. A real 0 reads '0'.
export const people = (millions) => {
  if (!isKnownNumber(millions)) {
    return UNKNOWN_TEXT
  }

  const value = Math.abs(millions)

  if (value === 0) {
    return '0'
  } else if (value >= 1000) {
    return `${roundToDecimal(millions / 1000, 2)} bn`
  } else if (value >= 10) {
    return `${roundToDecimal(millions, 1)} M`
  } else if (value >= 1) {
    return `${roundToDecimal(millions, 2)} M`
  }

  return `${roundToDecimal(millions * 1000, 0)} k`
}
