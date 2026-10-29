// Colony maths for the Colony Outlook page: body capacity, population growth, infrastructure and the worker split. Sources and checks: docs/plans/aurcalcs/build-2.md § Colony Outlook. The numeric helpers (`bodyCapacity`, `growthRate`, `projectBody`, `workerSplit`) take validated inputs and run in the projection loop; the `...Result` helpers check the inputs, name what a colony lacks and return a provenance result (utilities/provenance.js), so a figure the save cannot support is unavailable rather than 0.

import { UNKNOWN_TEXT, isKnownNumber, roundToDecimal } from './math'
import { combine, isAvailable, registerRule, satisfies, unavailable } from './provenance'

const EARTH_SURFACE_AREA = 511187128
// Millions of people an Earth-sized body holds (docs `colonies`, Population Capacity).
const EARTH_CAPACITY = 12000
// Every non-gas-giant body holds at least 50,000 people.
const MINIMUM_CAPACITY = 0.05
const MONTHS_PER_YEAR = 12
// Workers in millions: a balance this close to zero is balanced, not short.
export const WORKER_TOLERANCE = 0.005
const COLONY_VERSIONS = ['2.7.x']
const TOTALS = 'colonies.totals'

registerRule({
  id: 'colonies.capacity',
  versions: COLONY_VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Radius, HydroExt, TidalLock, BodyClass', 'FCT_Species.PopulationDensityModifier'],
  note: 'Millions of people a body holds before growth stops: its surface area over an Earth-sized body\'s, times 12 bn and the species\' density, less above 75% water (to 1% at 100%) and a fifth on a tide-locked planet (moons exempt), at least 50,000. The save stores no capacity, so no stored figure is compared with it.',
})

registerRule({
  id: 'colonies.crowding',
  versions: COLONY_VERSIONS,
  units: 'share of capacity',
  verification: 'estimated',
  structure: ['FCT_Population.Population', 'FCT_Population.Population summed per body for the race'],
  note: 'The race\'s population on the body (this colony plus the rest of the race\'s there) over the body\'s capacity; growth slows past a third. It rests on the capacity rule and is not compared with a stored figure.',
})

registerRule({
  id: 'colonies.growthRate',
  versions: COLONY_VERSIONS,
  units: 'per year',
  verification: 'estimated',
  structure: ['FCT_Species.PopulationGrowthModifier', 'FCT_Commander, FCT_CommanderBonuses (Population Growth bonus 8)', 'FCT_SystemBody.RadiationLevel', 'FCT_Population.Population'],
  note: 'Annual growth as a fraction: 20% over the cube root of the population in millions (at most 10%), times the species and governor modifiers and the crowding factor, less 1% per 400 points of radiation. The constants have no source in the save and the rate is not compared with a stored change of population.',
})

registerRule({
  id: 'colonies.populationProjection',
  versions: COLONY_VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_Population.Population', 'the growth rate and capacity rules', 'FCT_MoveOrders, FCT_ShipCargo (colonists on their way)', 'the infrastructure cap rule'],
  note: 'Month-by-month population of the race\'s colonies on one body, inbound colonists landed at the start, growth fading as the body fills and stopping at the colony\'s infrastructure cap. The monthly model is not compared with the population of a later save.',
})

registerRule({
  id: 'colonies.infrastructureRate',
  versions: COLONY_VERSIONS,
  units: 'infrastructure per M people',
  verification: 'confirmed',
  structure: ['FCT_Population.ReqInf, Population'],
  note: 'The colony\'s stored infrastructure requirement over its population in millions; the requirement already holds the doubling on a low-gravity body. A requirement of 0 is a colony that needs none. Arithmetic on two stored values.',
})

registerRule({
  id: 'colonies.infrastructureCap',
  versions: COLONY_VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.InfrastructureValue, LGInfrastructureValue', 'FCT_Population.ReqInf, Population', 'FCT_MoveOrders, FCT_ShipCargo (infrastructure on its way)'],
  note: 'Millions of people the colony\'s infrastructure (built and on its way) supports: the infrastructure over the requirement per million; unlimited when the colony needs none. Arithmetic on stored values.',
})

registerRule({
  id: 'colonies.infrastructureNeeded',
  versions: COLONY_VERSIONS,
  units: 'infrastructure',
  verification: 'estimated',
  structure: ['FCT_Population.ReqInf, Population', 'DIM_PlanetaryInstallation.InfrastructureValue, Cost', 'the population projection rule'],
  note: 'Infrastructure still to build to keep the colony growing over the horizon: the projected population without the cap times the requirement per million, less the infrastructure built and on its way. Its cost in BP uses the cheapest installation that gives infrastructure. It rests on the projection and is not compared with a stored figure.',
})

registerRule({
  id: 'colonies.colonyCost',
  versions: COLONY_VERSIONS,
  units: 'colony cost',
  verification: 'confirmed',
  structure: ['FCT_Population.ReqInf, Population', 'FCT_Species.PopulationDensityModifier, Gravity, GravDev', 'FCT_SystemBody.Gravity'],
  note: 'The colony cost the stored infrastructure requirement implies (requirement times density over 100 per million people), halved on a low-gravity body. It sets the share of people in agriculture and environment, and through the worker split it reproduced the stored efficiency of 5 low-gravity colonies of the stock 2.7.1 save (largest difference 0.0027), so the halving holds there.',
})

registerRule({
  id: 'colonies.workers',
  versions: COLONY_VERSIONS,
  units: 'M workers',
  verification: 'confirmed',
  structure: ['FCT_Population.Population', 'FCT_PopulationInstallations, DIM_PlanetaryInstallation.Workers', 'FCT_Shipyard.Capacity, Slipways, SYType', 'the colony cost rule'],
  note: 'Services take (population over 1,000 M) to the 0.25 power of the people, at most 70%; agriculture and environment 5% plus 5% per point of colony cost; the rest can work, against what installations and shipyards need. The efficiency it implies matched the stored one of all 66 colonies of the modded 2.7 save and the stock 2.7.1 save, 19 of them below 1, the largest difference 0.0027. A figure at the horizon rests on the projected population and is an estimate.',
})

registerRule({
  id: 'colonies.attention',
  versions: COLONY_VERSIONS,
  units: 'flag',
  verification: 'estimated',
  structure: ['the worker and population projection rules'],
  note: 'A colony is flagged when it is short of workers now or at the horizon, or when its infrastructure stops growth within the horizon. It is unavailable when none of the three tests is true and one cannot be decided.',
})

registerRule({
  id: TOTALS,
  versions: COLONY_VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['the colonies\' own results'],
  note: 'Sums and counts over the race\'s colonies for the tiles. A colony whose figure is unavailable is left out of a count or sum that says so, or makes a sum that cannot do without it unavailable. A total is only as sure as the weakest colony in it, and none is compared with a stored total.',
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const unique = (list) => [...new Set(list)]

// A result of `rule` for a colony: unavailable naming the `required` columns of `source` that are not numbers (and what its unavailable `parts` lack), otherwise `compute(values)` of the parts' values, at the weakest status of the rule and its parts.
const derive = ({ rule, source = {}, required = [], parts = {}, compute, units }) => {
  const missing = required.filter((name) => !finite(source[name]))
  const present = required.filter((name) => finite(source[name]))

  if (!missing.length) {
    return combine({ rule, parts, compute, units, inputs: { present } })
  }

  const lacking = Object.entries(parts).filter(([, part]) => !isAvailable(part)).flatMap(([name, part]) => (part.inputs.missing.length ? part.inputs.missing : [name]))

  return unavailable({ rule, missing: unique([...missing, ...lacking]), present, units })
}

// Millions of people the body holds before growth stops: surface area, the species' density, less above 75% water (1% at 100%) and a fifth on a tide-locked planet. Moons are exempt from the tidal rule, as in habitability.vue.
export const bodyCapacity = ({ Radius, HydroExt, TidalLock, BodyClass, PopulationDensityModifier }) => {
  const area = 4 * Math.PI * Radius ** 2
  const water = HydroExt > 75 ? Math.max((100 - HydroExt) / 25, 0.01) : 1
  const tidal = TidalLock && BodyClass !== 2 ? 5 : 1

  return Math.max(((area / EARTH_SURFACE_AREA) * EARTH_CAPACITY * PopulationDensityModifier * water) / tidal, MINIMUM_CAPACITY)
}

export const bodyCapacityResult = (colony) => derive({ rule: 'colonies.capacity', source: colony, required: ['Radius', 'HydroExt', 'TidalLock', 'PopulationDensityModifier', ...(colony.TidalLock ? ['BodyClass'] : [])], compute: () => bodyCapacity(colony) })

// Growth before modifiers: 20% / cube root of the population in millions, at most 10%.
export const baseGrowthRate = (population) => (population > 0 ? Math.min(0.1, 0.2 / Math.cbrt(population)) : 0)

// Full growth up to a third of the body's capacity, then a linear fall to none at capacity. A capacity that is not positive has no crowding figure.
export const crowdingFactor = (bodyPopulation, capacity) => (capacity > 0 ? Math.max(0, Math.min(1, 1.5 * (1 - bodyPopulation / capacity))) : NaN)

// Annual growth as a fraction. Radiation takes 1% per 400 points off the result.
export const growthRate = (colony, population, bodyPopulation, capacity) => baseGrowthRate(population) * colony.PopulationGrowthModifier * colony.PopulationGrowthBonus * crowdingFactor(bodyPopulation, capacity) - colony.RadiationLevel / 40000

export const growthRateResult = (colony, capacity) => derive({ rule: 'colonies.growthRate', source: colony, required: ['Population', 'BodyPopulation', 'PopulationGrowthModifier', 'PopulationGrowthBonus', 'RadiationLevel'], parts: { capacity }, compute: ({ capacity: value }) => growthRate(colony, colony.Population, colony.BodyPopulation, value) })

// The race's population on the body as a share of the body's capacity.
export const crowdingResult = (colony, capacity) => derive({ rule: 'colonies.crowding', source: colony, required: ['Population', 'BodyPopulation'], parts: { capacity }, compute: ({ capacity: value }) => (Math.max(0, colony.BodyPopulation - colony.Population) + colony.Population) / value })

// A colony that needs infrastructure needs a population to divide it by.
const withPopulation = (colony) => (colony.ReqInf > 0 && !(colony.Population > 0) ? { ...colony, Population: null } : colony)

// Infrastructure per million people. The game's live requirement (`ReqInf`) already doubles it on low-gravity bodies, so it's used rather than the stale `LastColonyCost`. 0 is a colony that needs none; a requirement the save lacks is unavailable.
export const infrastructureRateResult = (colony) => derive({ rule: 'colonies.infrastructureRate', source: withPopulation(colony), required: ['ReqInf', ...(colony.ReqInf > 0 ? ['Population'] : [])], compute: () => (colony.ReqInf > 0 ? colony.ReqInf / colony.Population : 0) })

// The infrastructure a colony counts: built plus on its way. NaN when a stored quantity is missing.
export const infrastructureOf = (colony, arriving) => {
  const terms = [colony.Infrastructure, colony.LGInfrastructure, arriving ? arriving.Infrastructure : 0]

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

// Workers in millions. Services take (population / 1000 M)^0.25 of the people, at most 70%; agriculture and environment take 5%, plus 5% per point of colony cost; the rest can work. Required: installations and shipyards, today's unless `required` gives the figure of a later day. Reproduces the save's stored Efficiency on the sample.
export const workerSplit = (colony, population, cost, required = colony.InstallationWorkers + colony.YardWorkers) => {
  const service = population > 0 ? Math.min(0.7, (population / 1000) ** 0.25) : 0
  const agriculture = 0.05 + cost * 0.05
  const available = Math.max(0, 1 - service - agriculture) * population

  return {
    population,
    service: service * population,
    agriculture: Math.min(agriculture, 1 - service) * population,
    available,
    required,
    free: available - required,
    efficiency: required > 0 ? Math.min(1, available / required) : 1,
  }
}

// The worker split of a colony now, or at the horizon when given its `projection` result.
export const workerSplitResult = (colony, cost, projection = null) => derive({ rule: 'colonies.workers', source: colony, required: ['InstallationWorkers', 'YardWorkers', ...(projection ? [] : ['Population'])], parts: projection ? { cost, projection } : { cost }, compute: ({ cost: value, projection: later }) => workerSplit(colony, later ? later.final : colony.Population, value) })

// Month-by-month population over `years` for the colonies of one body, with inbound colonists landed at the start. Each member is { colony, inboundColonists, capacity, infrastructureCap }. Growth stops at a colony's infrastructure cap (above it the population shrinks and unrest rises) and fades out toward the body's capacity, which the colonies share: every month each one grows against the body's current total, so populations on the same body crowd each other as they grow. Returns, per member, the monthly series and when each limit is reached (months, or null past the horizon).
export const projectBody = (members, years) => {
  const months = Math.round(years * MONTHS_PER_YEAR)
  let populations = members.map(({ colony, inboundColonists = 0 }) => colony.Population + inboundColonists)
  const results = members.map(({ infrastructureCap = Infinity }, index) => ({ series: [], crowdedAt: null, infrastructureAt: populations[index] >= infrastructureCap ? 0 : null }))

  for (let month = 0; month <= months; month++) {
    const bodyPopulation = populations.reduce((sum, population) => sum + population, 0)

    results.forEach((result, index) => {
      result.series.push(populations[index])

      if (bodyPopulation / members[index].capacity >= 1 / 3 && result.crowdedAt === null) {
        result.crowdedAt = month
      }
    })

    if (month === months) {
      break
    }

    populations = members.map(({ colony, capacity, infrastructureCap = Infinity }, index) => {
      const population = populations[index]
      const rate = growthRate(colony, population, bodyPopulation, capacity)
      let next = population * (1 + rate) ** (1 / MONTHS_PER_YEAR)

      if (rate > 0 && next >= infrastructureCap) {
        next = Math.max(population, infrastructureCap)

        if (results[index].infrastructureAt === null) {
          results[index].infrastructureAt = month + 1
        }
      }

      return Math.max(0, next)
    })
  }

  return results.map((result, index) => ({ ...result, final: populations[index] }))
}

const PROJECTION_COLUMNS = ['Population', 'PopulationGrowthModifier', 'PopulationGrowthBonus', 'RadiationLevel']

// The projections of the colonies of one body, as results. Each member is { colony, inboundColonists, capacity, cap } with `capacity` and `cap` (the infrastructure cap) results; `uncapped` is a member projected without its cap. The colonies grow against each other's population, so one colony the model cannot read leaves every colony of the body unavailable, naming the colony that lacks the input.
export const projectionResults = (members, years, uncapped = null) => {
  const rule = 'colonies.populationProjection'
  const partsOf = (member) => (member === uncapped ? { capacity: member.capacity } : { capacity: member.capacity, cap: member.cap })
  const lacks = members.map((member) => {
    const own = PROJECTION_COLUMNS.filter((name) => !finite(member.colony[name]))
    const parts = Object.entries(partsOf(member)).filter(([, part]) => !isAvailable(part)).flatMap(([name, part]) => (part.inputs.missing.length ? part.inputs.missing : [name]))

    return unique([...own, ...(finite(member.inboundColonists) ? [] : ['colonists on their way']), ...parts])
  })

  if (lacks.some((list) => list.length)) {
    return members.map((member, index) => unavailable({ rule, missing: unique([...lacks[index], ...members.flatMap((other, otherIndex) => (otherIndex === index ? [] : lacks[otherIndex].map((name) => `${name} of ${other.colony.PopName}`)))]), present: PROJECTION_COLUMNS.filter((name) => finite(member.colony[name])) }))
  }

  const projections = projectBody(members.map((member) => ({ colony: member.colony, inboundColonists: member.inboundColonists, capacity: member.capacity.value, infrastructureCap: member === uncapped ? Infinity : member.cap.value })), years)

  return members.map((member, index) => combine({ rule, parts: partsOf(member), compute: () => projections[index], inputs: { present: PROJECTION_COLUMNS } }))
}

// Whether a colony needs attention: short of workers now or at the horizon, or its infrastructure stops growth within it. True as soon as one test is, whatever the others; unavailable when none is and one cannot be decided.
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
    const rate = infrastructureRateResult(colony)

    return { colony, arriving, infrastructure, rate, capacity: bodyCapacityResult(colony), cap: infrastructureCapResult(infrastructure, rate), inboundColonists: arriving ? arriving.Colonists : 0 }
  })

  // Populations of the race on one body grow into the same capacity, so they're projected together.
  members.forEach((member) => (bodies[member.colony.SystemBodyID] = bodies[member.colony.SystemBodyID] || []).push(member))

  return members.map((member) => {
    const { colony, arriving, infrastructure, rate, capacity, cap } = member
    const group = bodies[colony.SystemBodyID]
    const index = group.indexOf(member)
    const projections = projectionResults(group, years)
    const projection = projections[index]
    // The rest of the body's population, month by month, as it grows alongside this colony.
    const otherSeries = projections.every(isAvailable) ? projection.value.series.map((_, month) => projections.reduce((sum, other, otherIndex) => sum + (otherIndex === index ? 0 : other.value.series[month]), 0)) : null
    // Unconstrained by infrastructure: what it would take to keep growing.
    const potential = !isAvailable(cap) || cap.value === Infinity ? projection : projectionResults(group, years, member)[index]
    const cost = colonyCostResult(colony)
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
