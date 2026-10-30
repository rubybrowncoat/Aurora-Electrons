// Where a deficit mineral could come from: the deposits the race has surveyed, ranked by how soon a first usable load reaches a chosen colony. Four delays are kept apart, each its own figure: the deployment of mines at a site that has none (build time at a colony plus the carry), the extraction that fills a first load, the route a representative carrier flies out and back, and the depletion of the deposit. Nothing is ranked on a figure that is not known: an unknown route, speed, load, destination or mine gives an unknown arrival, and the site goes after the ranked ones. Evidence: docs/plans/backlog/evidence/AE-056-01.md.

import { transitEstimator, normaliseSpeed } from './colony-transit'
import { loadLagrangePoints, loadTransitClasses } from './colonization-data'
import { loadJumpPoints } from './jump-graph'
import { buildDaysResult, mineRequirements } from './mine-bootstrap'
import { columnsOf, gaps, hasAll, loadBootstrapColonies, loadBootstrapProjects, loadMineTypes, selectedColumns } from './mine-bootstrap-data'
import { depositForecastResult, miningSum, surfaceRateResult } from './mineral-outlook'
import { depositForecast, depositStateAt } from './minerals'
import { combine, failureWords, isAvailable, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

const VERSIONS = ['2.7.x']
const DAYS_PER_YEAR = 365

// Hold tonnes of cargo one tonne of mineral takes. A class's cargo capacity is hold tonnes; mines are carried at their own cargo points each, minerals at this many hold tonnes to the tonne.
export const CARGO_PER_MINERAL = 2

registerRule({
  id: 'deficitSites.deposit',
  versions: VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_MineralDeposit.Amount, Accessibility', 'FCT_SystemBodySurveys.SystemBodyID, RaceID'],
  note: 'What the save stores of a deposit on a body the race has surveyed: its amount and its accessibility today. The race sees a deposit only through a survey of the body, so a body it has not surveyed is not read at all, whoever else has surveyed it.',
})

registerRule({
  id: 'deficitSites.extraction',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'assumed',
  structure: ['DIM_PlanetaryInstallation.MiningProductionValue, Workers', 'FCT_Race.MineProduction', 'FCT_MineralDeposit.Accessibility', 'FCT_SystemBody.RadiationLevel'],
  note: 'What the mines entered on the page would dig a year from the deposit, worked as a colony\'s mining rows are: mines times the mining value of one, cut to a whole number, times the race\'s mine production, the deposit\'s accessibility and the body\'s radiation modifier. Hypothetical: no colony works the deposit yet, so the colony efficiency, stability, political status and the governor and sector bonuses are all taken as neutral.',
  assumptions: ['the colony is fully staffed and neutral on efficiency, stability and political status', 'no governor or sector bonus applies', 'the mines work the deposit from the day they stand'],
})

registerRule({
  id: 'deficitSites.load',
  versions: VERSIONS,
  units: 't',
  verification: 'assumed',
  structure: ['FCT_ShipClass.CargoCapacity'],
  note: 'The tonnes of mineral one trip of the representative carrier takes: the cargo hold entered, or the cargo capacity of the ship class picked, over the two hold tonnes each tonne of mineral takes. The hold itself, not this figure, carries the mines to a new site. It is the player\'s choice, not a fleet\'s load. With no hold entered there is no first load and no delivery time.',
  assumptions: ['one carrier, full on every trip', 'the whole hold is free for the mineral'],
})

registerRule({
  id: 'deficitSites.deployment',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['mineBootstrap.localBuild', 'deficitSites.route', 'DIM_PlanetaryInstallation.Cost, CargoPoints'],
  note: 'The days until mines stand at a site that has none: the build at the builder colony over its idle construction capacity, plus the carry of the mines to the site by the representative carrier over the jump points the race has explored. A site already worked by mines has no deployment (0, a fact of the save). The carry is one-way, and a second or later load adds a flight back along the route the carrier can fly.',
  assumptions: ['a ship is free at the builder when the mines are finished, apart from the carrier that delivers the mineral', 'a colony stands on the body, or its founding is not counted'],
})

registerRule({
  id: 'deficitSites.firstLoad',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['deficitSites.extraction', 'deficitSites.load', 'FCT_MineralDeposit.Amount, Accessibility, HalfOriginalAmount, OriginalAcc'],
  note: 'The days the site takes to dig one load of the representative carrier, from the day the mines work it: the cumulative output of the deposit at the extraction, whose accessibility falls once it is mined past half (the Mineral Outlook forecast\'s decline), not the extraction held flat. A deposit that holds less than one load, or whose amount is not read, gives no first load. The minerals already in the site colony\'s stockpile are not counted. A site that delivers by mass driver now has none.',
  assumptions: ['the stock the site colony already holds is not loaded'],
})

registerRule({
  id: 'deficitSites.route',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['habitability.transitRoute', 'habitability.transitTime'],
  note: 'The days the representative carrier flies one way over the jump points the race has explored, from the colony to the site (empty) or from the site back (loaded), each by the shortest route in kilometres the Route Finder\'s search gives. The two directions are searched apart: a jump point explored on one side is not necessarily explored on the other. No route, no speed or no destination leaves the figure unknown.',
  assumptions: ['one speed all the way, loaded or empty', 'no loading, unloading, refuelling, jump shock or acceleration', 'military restriction and danger are not applied'],
})

registerRule({
  id: 'deficitSites.firstDelivery',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['deficitSites.deployment', 'deficitSites.firstLoad', 'deficitSites.route'],
  note: 'The days from now until the first load reaches the destination colony: the carrier leaves the colony now, and leaves the site when it is there and the first load is dug, which is after the deployment and the load\'s extraction, then flies back loaded. A site that already delivers to the colony by a mass-driver route the save names is 0.',
  assumptions: ['the carrier is free and at the destination colony now', 'the load leaves as soon as it is dug'],
})

registerRule({
  id: 'deficitSites.roundTrip',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['deficitSites.route'],
  note: 'The days one carrier takes for a whole trip: out to the site empty and back loaded. Unknown when either direction is.',
})

registerRule({
  id: 'deficitSites.delivered',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['deficitSites.extraction', 'deficitSites.load', 'deficitSites.roundTrip', 'mineralSupply.supply'],
  note: 'What the site delivers a year once running: the lower of its extraction and what one carrier hauls (the mineral load over the round trip). A site that delivers by a mass-driver route the save names shows what that route supplies today, which the ledger and the mass-driver output give.',
  assumptions: ['one carrier'],
})

registerRule({
  id: 'deficitSites.depletion',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['mineral.depositForecast', 'deficitSites.deployment'],
  note: 'The days from now until the deposit is empty at the extraction: the deployment, then the forecast of the deposit\'s years to depletion, whose accessibility falls once it is mined past half. A deposit nothing mines (no extraction, or no accessibility) is not emptied and has no such day.',
  assumptions: ['the extraction holds as the accessibility falls, as the Mineral Outlook forecast has it'],
})

registerRule({
  id: 'deficitSites.rank',
  versions: VERSIONS,
  units: 'rank',
  verification: 'assumed',
  structure: ['deficitSites.firstDelivery', 'deficitSites.delivered', 'deficitSites.deposit'],
  note: 'The order of the sites that can deliver: the earliest first delivery first, a tie by the larger delivery a year, then the larger deposit. A site whose deposit holds less than one load, or with no known arrival, is not ranked. The order is a choice of this page, not a rule of the game.',
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// A mine count as typed: a whole number above 0, else null. A blank is unknown, never 0.
export const normaliseCount = (value) => {
  const count = typeof value === 'string' && !value.trim() ? NaN : Number(value)

  return Number.isInteger(count) && count > 0 ? count : null
}

const SOURCE_NAMES = { jumps: 'the charted jump points', lagrange: 'the Lagrange points', classes: 'the ship classes', types: 'the mine types', colonies: 'the colonies\' places', projects: 'the running projects', race: 'the race\'s mine production' }

export const NO_SITE_DEPOSITS = Object.freeze({ deposits: Object.freeze([]), problems: Object.freeze([]) })

// The deposits of the bodies the race has surveyed, with the body's place, radiation and name parts, how many colonies of the race stand on the body (`OwnColonies`) and how many known alien colonies do (`AlienColonies`, null when the save does not say): { deposits, problems }. A body the race has not surveyed gives no row, so nothing hidden from the race is read or counted. A save without the survey table gives no deposit, naming what it lacks; a column the save lacks reads as null (unknown), never as 0.
export const loadSiteDeposits = async (database, { GameID, RaceID }) => {
  const [deposit, surveys, body, system, star, name, alien, population] = await Promise.all(['FCT_MineralDeposit', 'FCT_SystemBodySurveys', 'FCT_SystemBody', 'FCT_RaceSysSurvey', 'FCT_Star', 'FCT_SystemBodyName', 'FCT_AlienPopulation', 'FCT_Population'].map((table) => columnsOf(database, table)))
  const lacking = [...gaps('FCT_MineralDeposit', deposit, ['GameID', 'SystemBodyID', 'MaterialID']), ...gaps('FCT_SystemBodySurveys', surveys, ['SystemBodyID', 'RaceID']), ...gaps('FCT_SystemBody', body, ['GameID', 'SystemBodyID', 'SystemID']), ...gaps('FCT_RaceSysSurvey', system, ['GameID', 'SystemID', 'RaceID'])]

  if (lacking.length) {
    return { deposits: [], problems: [`the save lacks ${lacking.join(', ')}, so no deposit can be shown as surveyed`] }
  }

  const alienCount = hasAll(alien, ['GameID', 'PopulationID', 'ViewingRaceID']) && hasAll(population, ['PopulationID', 'SystemBodyID']) ? `(select count(*) from FCT_AlienPopulation inner join FCT_Population as VIR_Alien on VIR_Alien.PopulationID = FCT_AlienPopulation.PopulationID where FCT_AlienPopulation.GameID = ${GameID} and FCT_AlienPopulation.ViewingRaceID = ${RaceID} and VIR_Alien.SystemBodyID = FCT_MineralDeposit.SystemBodyID)` : 'null'
  const ownCount = hasAll(population, ['GameID', 'RaceID', 'SystemBodyID']) ? `(select count(*) from FCT_Population as VIR_Own where VIR_Own.GameID = ${GameID} and VIR_Own.RaceID = ${RaceID} and VIR_Own.SystemBodyID = FCT_MineralDeposit.SystemBodyID)` : 'null'
  const surveyed = `select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys where FCT_SystemBodySurveys.RaceID = ${RaceID}${surveys.has('GameID') ? ` and FCT_SystemBodySurveys.GameID = ${GameID}` : ''}`
  const starJoin = hasAll(star, ['StarID', 'Component']) && body.has('StarID') ? 'left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID' : ''
  const nameJoin = hasAll(name, ['SystemBodyID', 'RaceID', 'Name']) ? `left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID}` : ''
  const [rows] = await database.query(`select FCT_MineralDeposit.SystemBodyID, FCT_MineralDeposit.MaterialID, ${selectedColumns('FCT_MineralDeposit', deposit, ['Amount', 'Accessibility', 'HalfOriginalAmount', 'OriginalAcc'])}, FCT_SystemBody.SystemID, ${selectedColumns('FCT_SystemBody', body, ['Xcor', 'Ycor', 'RadiationLevel', 'BodyClass', 'PlanetNumber', 'OrbitNumber'])}, ${system.has('Name') ? 'FCT_RaceSysSurvey.Name' : 'null'} as SystemName, ${starJoin ? 'FCT_Star.Component' : 'null'} as Component, ${nameJoin ? 'FCT_SystemBodyName.Name' : 'null'} as SystemBodyName, 1 as Surveyed, ${alienCount} as AlienColonies, ${ownCount} as OwnColonies from FCT_MineralDeposit inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = FCT_MineralDeposit.GameID ${starJoin} ${nameJoin} where FCT_MineralDeposit.GameID = ${GameID} and FCT_MineralDeposit.SystemBodyID in (${surveyed})`)

  return { deposits: Object.freeze(rows.map((row) => Object.freeze(row))), problems: [] }
}

// The mine types with the mining value of one installation (`Mining`, null when the save lacks it).
const loadMiningTypes = async (database, ids) => {
  const types = await loadMineTypes(database, ids)

  if (!types.length) {
    return types
  }

  const [rows] = await database.query('select PlanetaryInstallationID, MiningProductionValue from DIM_PlanetaryInstallation where MiningProductionValue > 0')
  const values = new Map(rows.map((row) => [row.PlanetaryInstallationID, row.MiningProductionValue]))

  return types.map((type) => ({ ...type, Mining: values.has(type.PlanetaryInstallationID) ? values.get(type.PlanetaryInstallationID) : null }))
}

// The ship classes the race has ships of that move, each with its cargo capacity (`CargoCapacity`, null where the save does not say), for the choice of a representative carrier.
const loadCarrierClasses = async (database, { GameID, RaceID }) => {
  const [classes, columns] = await Promise.all([loadTransitClasses(database, { GameID, RaceID }), columnsOf(database, 'FCT_ShipClass')])

  if (!hasAll(columns, ['ShipClassID', 'CargoCapacity', 'GameID', 'RaceID'])) {
    return classes.map((shipClass) => ({ ...shipClass, CargoCapacity: null }))
  }

  const [rows] = await database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.CargoCapacity from FCT_ShipClass where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID}`)
  const capacities = new Map(rows.map((row) => [row.ShipClassID, row.CargoCapacity]))

  return classes.map((shipClass) => ({ ...shipClass, CargoCapacity: capacities.has(shipClass.ShipClassID) ? capacities.get(shipClass.ShipClassID) : null }))
}

// The race's mine production a mine equivalent a year at accessibility 1 (`MineProduction`, null where the save does not say).
const loadMineProduction = async (database, { GameID, RaceID }) => {
  const columns = await columnsOf(database, 'FCT_Race')

  if (!hasAll(columns, ['GameID', 'RaceID', 'MineProduction'])) {
    return { MineProduction: null }
  }

  const [[row]] = await database.query(`select FCT_Race.MineProduction from FCT_Race where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`)

  return { MineProduction: row && isNumber(row.MineProduction) ? row.MineProduction : null }
}

export const NO_DEPLOYMENT_SOURCES = Object.freeze({ jumpPoints: Object.freeze([]), lagrangePoints: Object.freeze([]), classes: Object.freeze([]), types: Object.freeze([]), colonies: Object.freeze([]), projects: Object.freeze([]), race: Object.freeze({ MineProduction: null }), problems: Object.freeze([]) })

// Everything the deployment and the routes rest on, in one pass: { jumpPoints, lagrangePoints, classes, types, colonies, projects, race, problems }. Each source is read on its own: a read that fails leaves its own part empty (the running projects null, which is not the same as no project running) and is named in `problems` ([{ source, text }]), so what does not rest on it still stands.
export const loadDeploymentSources = async (database, { GameID, RaceID }) => {
  const problems = []
  const attempt = async (source, read, fallback) => {
    try {
      return await read()
    } catch (error) {
      problems.push({ source, text: `${SOURCE_NAMES[source]} could not be read (${failureWords(error)})` })

      return fallback
    }
  }
  const ids = { GameID, RaceID }
  const [jumpPoints, lagrangePoints, classes, types, colonies, projects, race] = await Promise.all([
    attempt('jumps', () => loadJumpPoints(database, ids), []),
    attempt('lagrange', () => loadLagrangePoints(database, ids), []),
    attempt('classes', () => loadCarrierClasses(database, ids), []),
    attempt('types', () => loadMiningTypes(database, ids), []),
    attempt('colonies', () => loadBootstrapColonies(database, ids), []),
    attempt('projects', () => loadBootstrapProjects(database, ids), null),
    attempt('race', () => loadMineProduction(database, ids), { MineProduction: null }),
  ])

  return { jumpPoints, lagrangePoints, classes, types, colonies, projects, race, problems }
}

// The deposits of one mineral a mine could work: those on a body the race has surveyed (`Surveyed` 1; anything else, a null included, is not shown), not exhausted (an amount of 0 or less; a deposit whose amount the save does not say stays, its depletion unknown) and not under a known alien colony. Returns { sites, excluded: { unsurveyed, exhausted, alienHeld } }.
export const candidatesOf = ({ deposits, materialId }) => {
  const excluded = { unsurveyed: 0, exhausted: 0, alienHeld: 0 }
  const sites = []

  deposits.filter((deposit) => deposit.MaterialID === materialId).forEach((deposit) => {
    if (deposit.Surveyed !== 1) {
      excluded.unsurveyed += 1
    } else if (isNumber(deposit.AlienColonies) && deposit.AlienColonies > 0) {
      excluded.alienHeld += 1
    } else if (isNumber(deposit.Amount) && deposit.Amount <= 0) {
      excluded.exhausted += 1
    } else {
      sites.push(deposit)
    }
  })

  return { sites, excluded }
}

// The bodies the race already mines for the mineral, from the supply accounting's sites (mineral-supply.js `mineralSupply`): by SystemBodyID, { sites, extraction (the sum of the sites' extraction results), deliveries: { [destination PopulationID]: [site] } } where a delivery is a site whose route the save names to that colony.
export const minedBodies = (supplySites) => {
  const bodies = new Map()

  supplySites.forEach((site) => {
    const id = site.row.SystemBodyID

    if (!bodies.has(id)) {
      bodies.set(id, { sites: [], extraction: null, deliveries: {} })
    }

    const entry = bodies.get(id)

    entry.sites.push(site)

    if ((site.connection === 'packets' || site.connection === 'driver') && site.destination) {
      ;(entry.deliveries[site.destination.populationId] = entry.deliveries[site.destination.populationId] || []).push(site)
    }
  })

  bodies.forEach((entry) => {
    entry.extraction = miningSum(entry.sites.map((site) => site.extraction))
  })

  return bodies
}

const hasPlace = (point) => Boolean(point) && Number.isFinite(point.Xcor) && Number.isFinite(point.Ycor)

const placeOf = (point) => ({ SystemID: point.SystemID, Xcor: point.Xcor, Ycor: point.Ycor })

const placeKey = (point) => (hasPlace(point) ? `${point.SystemID}:${point.Xcor}:${point.Ycor}` : 'none')

const samePlace = (a, b) => hasPlace(a) && hasPlace(b) && placeKey(a) === placeKey(b)

// One flight of the representative carrier between two places, over the explored jump points, as the estimate of colony-transit.js `transitEstimator`: { state, km, au, jumps, days, results: { route, time } }. Each origin is searched once; the two directions are separate flights. A carrier whose jump-drive eligibility is not known (a `drive` that is neither 'drive' nor 'gates') has no flight, as which jump points it crosses rests on it.
const flights = ({ jumpPoints, lagrangePoints }, basis) => {
  const estimators = new Map()
  const from = (origin) => {
    const key = placeKey(origin)

    if (!estimators.has(key)) {
      estimators.set(key, transitEstimator({ jumpPoints, colonies: hasPlace(origin) ? [placeOf(origin)] : [] }, lagrangePoints, basis))
    }

    return estimators.get(key)
  }

  return (origin, target) => (basis.drive === 'drive' || basis.drive === 'gates' ? from(origin)(placeOf(target)) : noFlight('the carrier\'s jump-drive eligibility', 'no-drive'))
}

// A flight that cannot be worked out for want of a place, with the same shape as an estimate.
const noFlight = (missing, state = 'no-endpoint') => ({ state, km: null, au: null, jumps: null, days: null, results: { route: unavailable({ rule: 'deficitSites.route', missing: [missing] }), time: unavailable({ rule: 'deficitSites.route', missing: [missing], units: 'days' }) } })

const timeOf = (flight) => (isAvailable(flight.results.time) ? ofRule({ rule: 'deficitSites.route', value: flight.results.time.value, inputs: { present: flight.results.time.inputs.present }, units: 'days', assumptions: flight.results.time.assumptions }) : unavailable({ rule: 'deficitSites.route', missing: flight.results.time.inputs.missing, present: flight.results.time.inputs.present, units: 'days', assumptions: flight.results.time.assumptions }))

// The mineral one trip takes, from the cargo hold in tonnes (`cargo`, null when none is entered).
const loadResult = (cargo) => (cargo === null ? unavailable({ rule: 'deficitSites.load', missing: ['a cargo hold (none entered)'], units: 't' }) : ofRule({ rule: 'deficitSites.load', value: cargo / CARGO_PER_MINERAL, inputs: { present: ['the cargo hold entered or taken from a ship class'] }, units: 't', assumptions: [`each tonne of mineral takes ${CARGO_PER_MINERAL} tonnes of hold`] }))

const standing = (rule, text, units) => ofRule({ rule, value: 0, inputs: { present: [text] }, units })

// What the mines entered would dig a year at a site (see the rule): unavailable, naming what is missing, without a mine type, a count, the mining value or workers of the type, the race's mine production or the deposit's accessibility and radiation.
const newExtraction = ({ site, type, count, race }) => {
  const missing = [...(type ? [] : ['a mine type']), ...(count ? [] : ['a number of mines'])]

  if (type && !isNumber(type.Mining)) {
    missing.push(`the mining value of ${type.Name}`)
  }

  if (type && !isNumber(type.Workers)) {
    missing.push(`the workers of ${type.Name}`)
  }

  if (missing.length) {
    return unavailable({ rule: 'deficitSites.extraction', missing, units: 't/yr' })
  }

  const equivalents = type.Mining * count
  const manned = type.Workers > 0
  const row = { ManualMineCount: manned ? equivalents : 0, AutomatedMineCount: manned ? 0 : equivalents, CivilianMineCount: 0, MineProduction: race.MineProduction, Accessibility: site.Accessibility, GovernorBonus: 1, SectorBonus: 1, Efficiency: 1, StabilityModifier: 1, PoliticalModifier: 1, RadiationModifier: isNumber(site.RadiationLevel) ? 1 - site.RadiationLevel / 10000 : null }

  return combine({ rule: 'deficitSites.extraction', parts: { rate: surfaceRateResult(row, false) }, compute: ({ rate }) => rate, units: 't/yr' })
}

const depositResult = (value, column) => (isNumber(value) ? ofRule({ rule: 'deficitSites.deposit', value, inputs: { present: [column] } }) : unavailable({ rule: 'deficitSites.deposit', missing: [column] }))

// The years until a deposit has given `load` at `rate` (t/yr at its accessibility now): the cumulative output of the shared decline model, exact while the output is flat and found by halving the interval once the accessibility falls. Null for a deposit that gives nothing or holds less than the load.
const yearsToDig = (site, rate, load) => {
  const forecast = depositForecast(site, rate)
  const start = depositStateAt(site, rate, 0).amount
  const dug = (years) => start - depositStateAt(site, rate, years).amount
  const flat = load / rate

  if (forecast.idle || start < load) {
    return null
  } else if (Math.abs(dug(flat) - load) <= 1e-9 * Math.max(1, load)) {
    return flat
  }

  let low = 0
  let high = forecast.yearsToDepletion

  for (let step = 0; step < 200; step++) {
    const middle = (low + high) / 2

    if (dug(middle) < load) {
      low = middle
    } else {
      high = middle
    }
  }

  return high
}

// The days one load takes to dig, from the deposit's cumulative output at `extraction`; unavailable when the extraction, the load or the deposit's amount, accessibility or decline is not known, when nothing is dug and when the deposit holds less than one load.
const firstLoadOf = ({ extraction, load, site }) => {
  const rule = 'deficitSites.firstLoad'

  if (isAvailable(extraction) && !(extraction.value > 0)) {
    return unavailable({ rule, missing: ['an extraction above 0 (nothing is dug at the site)'], units: 'days' })
  } else if (isAvailable(load) && isNumber(site.Amount) && site.Amount < load.value) {
    return unavailable({ rule, missing: [`a deposit that holds a full load (${site.Amount} t left, ${load.value} t a trip)`], units: 'days' })
  }

  const forecast = depositForecastResult(site, extraction)

  if (isAvailable(forecast) && forecast.value.idle) {
    return unavailable({ rule, missing: ['a deposit the mines can work (an accessibility above 0)'], units: 'days' })
  }

  return combine({ rule, parts: { extraction, load, forecast }, compute: (values) => yearsToDig(site, values.extraction, values.load) * DAYS_PER_YEAR, units: 'days' })
}

// The deployment of mines at a site that has none, as a result of 'deficitSites.deployment': the build over `build` (a days result) and the carry of the mines from the builder in as many trips as the carrier's cargo hold (`cargo`, hold tonnes) needs for the mines' cargo points. `builder` { colony, rate } or null, `requirement` what `mineRequirements` gives or null, `flight(from, to)` one flight of the carrier. A colony of the race is taken as standing on the body unless the save says none does.
const deploymentOf = ({ here, builder, build, requirement, cargo, flight, foundingNeeded }) => {
  const rule = 'deficitSites.deployment'
  const assumptions = foundingNeeded ? ['a colony must be founded on the body first, and its founding is not counted'] : []

  if (!builder) {
    return unavailable({ rule, missing: ['a colony to build the mines'], units: 'days' })
  }

  let carry

  if (samePlace(builder.colony, here)) {
    carry = standing(rule, 'the builder colony stands on the body', 'days')
  } else {
    const tonnes = requirement ? requirement.tonnes : null
    const missing = [...(tonnes ? (isAvailable(tonnes) ? [] : tonnes.inputs.missing) : ['the cargo points of the mines']), ...(cargo ? [] : ['a cargo hold (none entered)'])]

    if (missing.length) {
      carry = unavailable({ rule, missing, units: 'days' })
    } else {
      const trips = Math.ceil(tonnes.value / cargo)
      const parts = { there: timeOf(flight(builder.colony, here)), ...(trips > 1 ? { back: timeOf(flight(here, builder.colony)) } : {}) }

      carry = combine({ rule, parts, compute: (values) => values.there * trips + (trips > 1 ? values.back * (trips - 1) : 0), units: 'days' })
    }
  }

  return combine({ rule, parts: { build, carry }, compute: (values) => values.build + values.carry, units: 'days', assumptions })
}

const defaultName = (site) => `Body ${site.SystemBodyID}`

// The shortlist for one mineral. `candidates`: `candidatesOf`'s sites; `mined`: `minedBodies`' map (empty when no supply is read); `destination`: the colony to deliver to, { PopulationID, PopName, SystemID, Xcor, Ycor }, or null; `builder`: { colony, rate (the colony's idle construction BP/yr as a result) } or null; `type`: a mine type of `loadDeploymentSources`, or null; `count`: mines, a whole number or null; `basis`: { speed, drive, lagrange, cargo } of the representative carrier, `cargo` the hold in tonnes (a blank speed or cargo is null, never 0; a drive that is not 'drive' or 'gates' is not known and leaves every route unknown); `sources`: `loadDeploymentSources`' value; `nameOf(site)` names a body.
// Each row: { key, SystemBodyID, name, state ('delivering', 'worked' or 'new'), amount, accessibility, distance, deployment, extraction, firstLoad, out, back, roundTrip, depletion, firstDelivery, delivered, exhausts (true when the deposit holds less than one load), notes } with the figures as provenance results and `rank` (the place among the ranked, else null) and `order` (the place in the whole list). The ranked come first by first delivery; then the sites whose deposit holds less than a load; then those with no known arrival.
export const rankSites = ({ candidates, mined = new Map(), destination = null, builder = null, type = null, count = null, basis, sources, nameOf = defaultName }) => {
  const chosen = { speed: normaliseSpeed(basis.speed), drive: basis.drive, lagrange: basis.lagrange }
  const cargoValue = normaliseSpeed(basis.cargo)
  const load = loadResult(cargoValue)
  const flight = flights(sources, chosen)
  const requirement = type && count ? mineRequirements(type, count) : null
  const build = requirement ? buildDaysResult('mineBootstrap.localBuild', requirement.bp, builder ? builder.rate : null) : unavailable({ rule: 'mineBootstrap.localBuild', missing: [type ? 'a number of mines' : 'a mine type'], units: 'days' })

  const rows = candidates.map((site) => {
    const here = placeOf(site)
    const found = mined.get(site.SystemBodyID) || null
    const working = found !== null && (!isAvailable(found.extraction) || found.extraction.value > 0)
    const supplying = working && destination ? (found.deliveries[destination.PopulationID] || []).filter((entry) => isAvailable(entry.supply) && entry.supply.value > 0) : []
    const state = supplying.length ? 'delivering' : working ? 'worked' : 'new'
    const out = destination ? flight(destination, here) : noFlight('a destination colony')
    const back = destination ? flight(here, destination) : noFlight('a destination colony')
    const roundTrip = combine({ rule: 'deficitSites.roundTrip', parts: { out: timeOf(out), back: timeOf(back) }, compute: (values) => values.out + values.back, units: 'days' })
    const extraction = state === 'new' ? newExtraction({ site, type, count, race: sources.race }) : found.extraction
    const deployment = state === 'new' ? deploymentOf({ here, builder, build, requirement, cargo: cargoValue, flight, foundingNeeded: site.OwnColonies === 0 }) : standing('deficitSites.deployment', 'mines already work the deposit', 'days')
    const firstLoad = state === 'delivering' ? standing('deficitSites.firstLoad', 'a mass-driver route the save names delivers now', 'days') : firstLoadOf({ extraction, load, site })
    const firstDelivery = state === 'delivering' ? standing('deficitSites.firstDelivery', 'a mass-driver route the save names delivers now', 'days') : combine({ rule: 'deficitSites.firstDelivery', parts: { deployment, firstLoad, out: timeOf(out), back: timeOf(back) }, compute: (values) => Math.max(values.deployment + values.firstLoad, values.out) + values.back, units: 'days' })
    const delivered = state === 'delivering' ? combine({ rule: 'deficitSites.delivered', parts: Object.fromEntries(supplying.map((entry, index) => [`supply ${index + 1}`, entry.supply])), compute: (values) => Object.values(values).reduce((total, value) => total + value, 0), units: 't/yr' }) : combine({ rule: 'deficitSites.delivered', parts: { extraction, load, roundTrip }, compute: (values) => Math.min(values.extraction, (values.load * DAYS_PER_YEAR) / values.roundTrip), units: 't/yr' })
    const forecast = depositForecastResult(site, extraction)
    const idle = isAvailable(forecast) && forecast.value.idle
    const depletion = idle ? unavailable({ rule: 'deficitSites.depletion', missing: ['a deposit the mines work (nothing is dug at the site, so it is not emptied)'], units: 'days' }) : combine({ rule: 'deficitSites.depletion', parts: { forecast, deployment }, compute: (values) => values.deployment + values.forecast.yearsToDepletion * DAYS_PER_YEAR, units: 'days' })
    const exhausts = state === 'delivering' ? false : isAvailable(load) && isNumber(site.Amount) ? site.Amount < load.value : null
    const notes = []

    if (state === 'new' && site.OwnColonies === 0) {
      notes.push('No colony of the race stands on the body: founding one is not counted.')
    }

    if (state === 'worked' && found.deliveries[destination ? destination.PopulationID : null]) {
      notes.push('A mass-driver route of the save names the chosen colony, but the save shows no delivery by it (none, or none recorded): the carrier hauls the output.')
    } else if (state === 'worked' && found.sites.some((entry) => entry.connection === 'packets' || entry.connection === 'driver')) {
      notes.push('A mass-driver route of the save does not name the chosen colony: the carrier hauls the output.')
    }

    if (exhausts === true) {
      notes.push('The deposit holds less than one load of the carrier.')
    }

    return { key: `${site.SystemBodyID}-${site.MaterialID}`, SystemBodyID: site.SystemBodyID, name: nameOf(site), system: site.SystemName || '', state, site, amount: depositResult(site.Amount, 'the amount of the deposit'), accessibility: depositResult(site.Accessibility, 'the accessibility of the deposit'), distance: out.results.route, out, back, deployment, extraction, firstLoad, roundTrip, depletion, firstDelivery, delivered, exhausts, eta: valueOrNull(firstDelivery), notes, rank: null, order: 0 }
  })

  const group = (row) => (row.exhausts === true ? 1 : row.eta === null ? 2 : 0)
  const larger = (x, y) => (x === null && y === null ? 0 : y === null ? -1 : x === null ? 1 : y - x)
  const ordered = [...rows].sort((a, b) => group(a) - group(b) || (group(a) === 0 ? a.eta - b.eta : 0) || larger(valueOrNull(a.delivered), valueOrNull(b.delivered)) || larger(valueOrNull(a.amount), valueOrNull(b.amount)) || a.name.localeCompare(b.name) || a.SystemBodyID - b.SystemBodyID)

  ordered.forEach((row, index) => {
    row.order = index + 1
    row.rank = group(row) === 0 ? index + 1 : null
    row.rankResult = row.rank === null ? unavailable({ rule: 'deficitSites.rank', missing: [row.exhausts === true ? 'a deposit that holds a full load' : 'a known first delivery'] }) : ofRule({ rule: 'deficitSites.rank', value: row.rank, inputs: { present: ['the first delivery', 'the delivery a year', 'the deposit amount'] } })
  })

  return ordered
}
