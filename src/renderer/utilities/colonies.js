// Colony maths for the Colony Outlook page: body capacity, population growth, infrastructure and
// the worker split. Sources and checks: docs/plans/aurcalcs/build-2.md § Colony Outlook.

const EARTH_SURFACE_AREA = 511187128
// Millions of people an Earth-sized body holds (docs `colonies`, Population Capacity).
const EARTH_CAPACITY = 12000
// Every non-gas-giant body holds at least 50,000 people.
const MINIMUM_CAPACITY = 0.05
const MONTHS_PER_YEAR = 12

// Millions of people the body holds before growth stops: surface area, the species' density,
// less above 75% water (1% at 100%) and a fifth on a tide-locked planet. Moons are exempt from
// the tidal rule, as in habitability.vue.
export const bodyCapacity = ({ Radius, HydroExt, TidalLock, BodyClass, PopulationDensityModifier }) => {
  const area = 4 * Math.PI * Radius ** 2
  const water = HydroExt > 75 ? Math.max((100 - HydroExt) / 25, 0.01) : 1
  const tidal = TidalLock && BodyClass !== 2 ? 5 : 1

  return Math.max(((area / EARTH_SURFACE_AREA) * EARTH_CAPACITY * PopulationDensityModifier * water) / tidal, MINIMUM_CAPACITY)
}

// Growth before modifiers: 20% / cube root of the population in millions, at most 10%.
export const baseGrowthRate = (population) => (population > 0 ? Math.min(0.1, 0.2 / Math.cbrt(population)) : 0)

// Full growth up to a third of the body's capacity, then a linear fall to none at capacity.
export const crowdingFactor = (bodyPopulation, capacity) => (capacity > 0 ? Math.max(0, Math.min(1, 1.5 * (1 - bodyPopulation / capacity))) : 0)

// Annual growth as a fraction. Radiation takes 1% per 400 points off the result.
export const growthRate = (colony, population, bodyPopulation, capacity) => baseGrowthRate(population) * colony.PopulationGrowthModifier * colony.PopulationGrowthBonus * crowdingFactor(bodyPopulation, capacity) - (colony.RadiationLevel || 0) / 40000

// Infrastructure per million people. The game's live requirement (`ReqInf`) already doubles it on
// low-gravity bodies (Aurora 2.6), so it's used rather than the stale `LastColonyCost`.
export const infrastructurePerMillion = (colony) => (colony.ReqInf > 0 && colony.Population > 0 ? colony.ReqInf / colony.Population : 0)

// Millions of people the colony's infrastructure supports; Infinity when it needs none.
export const infrastructureCapacity = (colony, infrastructure = colony.Infrastructure + colony.LGInfrastructure) => {
  const perMillion = infrastructurePerMillion(colony)

  return perMillion ? infrastructure / perMillion : Infinity
}

// The colony cost the infrastructure requirement implies (ReqInf = population x CC x 100 / density).
// From Aurora 2.6 a low-gravity body needs twice the infrastructure at the same colony cost (docs
// `planetary-installations`), and ReqInf holds that factor; a pre-2.6 save has separate LG infrastructure instead.
export const colonyCost = (colony) => (colony.ReqInf > 0 && colony.Population > 0 ? (colony.ReqInf * colony.PopulationDensityModifier) / (colony.Population * 100 * (colony.LowGravity && !colony.LegacyLowGravity ? 2 : 1)) : 0)

// Workers in millions. Services take (population / 1000 M)^0.25 of the people, at most 70%;
// agriculture and environment take 5%, plus 5% per point of colony cost; the rest can work.
// Required: installations and shipyards. Reproduces the save's stored Efficiency on the sample.
export const workerSplit = (colony, population) => {
  const service = population > 0 ? Math.min(0.7, (population / 1000) ** 0.25) : 0
  const agriculture = 0.05 + colonyCost(colony) * 0.05
  const available = Math.max(0, 1 - service - agriculture) * population
  const required = colony.InstallationWorkers + colony.YardWorkers

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

// Month-by-month population over `years` for the colonies of one body, with inbound colonists
// landed at the start. Each member is { colony, inboundColonists, capacity, infrastructureCap }.
// Growth stops at a colony's infrastructure cap (above it the population shrinks and unrest
// rises) and fades out toward the body's capacity, which the colonies share: every month each one
// grows against the body's current total, so populations on the same body crowd each other as they grow.
// Returns, per member, the monthly series and when each limit is reached (months, or null past the horizon).
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
