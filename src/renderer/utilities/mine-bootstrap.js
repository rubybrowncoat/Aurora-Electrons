// The three routes to mining capacity at a colony that has too little of it: mines built elsewhere and carried in, mines built by the colony's own industry, and mines built with the help of ground engineers moved to the colony. Each route states what works now, what limits it and what the save does not say. The rules are in docs/plans/backlog/evidence/AE-045-01.md.

import { WORKER_TOLERANCE, people, workerSplit } from './colonies'
import { haulByClass } from './haul-plan'
import { routeLegs, searchRoutes } from './jump-graph'
import { roundToDecimal } from './math'
import { MINERALS } from './minerals'
import { freeCapacity } from './production'
import { combine, isAvailable, ofRule, registerRule, ruleSupports, unavailable, valueOrNull } from './provenance'
import { fleetCanTransit, hasGate, transitRule } from './transport'

const VERSIONS = ['2.7.x']
const DAYS_PER_YEAR = 365
// The share of a parent headquarters' commander bonus a subordinate formation takes up.
const PARENT_SHARE = 0.25

registerRule({
  id: 'mineBootstrap.requirements',
  versions: VERSIONS,
  units: '',
  verification: 'confirmed',
  structure: ['DIM_PlanetaryInstallation.Cost, CargoPoints, Workers and the mineral columns'],
  note: 'What a number of one installation type takes: its build cost times the number, its cargo points times the number (an installation weighs its cargo points in tonnes of cargo), the workers it needs and the minerals of its recipe. A type with Workers above 0 is manned, one with 0 is automated and needs no workers.',
})

registerRule({
  id: 'mineBootstrap.localBuild',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_Population.Efficiency, the colony\'s construction capacity and its running projects', 'DIM_PlanetaryInstallation.Cost, Workers'],
  note: 'The days the colony\'s own construction takes: the build cost over the share of its yearly construction capacity that running projects leave idle. The capacity already carries the saved efficiency, so a colony short of workers builds slower. Manned mines add workers to the colony\'s requirement and can push its efficiency down once built.',
  assumptions: ['the idle share stays as it is', 'the whole idle share goes to the mines', 'the mineral stock covers the recipe'],
})

registerRule({
  id: 'mineBootstrap.import',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_Population (builder colony capacity and stock)', 'FCT_ShipClass.CargoCapacity, MaxSpeed, Size, MilitaryEngines and the jump drives of the class', 'FCT_Ship (ships of each class)', 'jump points'],
  note: 'The days to build the mines at another colony of the race (the same capacity rule as the local build) and to carry them in by one freighter class (holds times the round trip of the Hauling Planner). A class whose jump drives cover its size crosses unstabilised jump points itself; any other class takes a route over stabilised jump points, or needs a jump-capable tender. The freight deficit is the tonnage beyond one lift of the whole class, the labour deficit the workers the mines need beyond the colony\'s free workers (a shortage the colony already has is not the mines\').',
  assumptions: ['the freighters are free and fully crewed', 'full holds', 'the stock at the builder covers the recipe', 'mines already installed elsewhere are not counted'],
})

registerRule({
  id: 'mineBootstrap.groundAssistance',
  versions: VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_GroundUnitFormation (population, ship and parent)', 'FCT_GroundUnitFormationElement.Units', 'FCT_GroundUnitClass.ConstructionRating, Size, HQCapacity', 'FCT_Commander, FCT_CommanderBonuses (bonus 5, Production)', 'FCT_Race.ConstructionProduction, EconomicProdModifier'],
  note: 'Engineers add race construction rate x economic modifier x radiation x the sum over their formations of units x construction rating x the formation\'s commander multiplier. A commander counts its Production bonus when the formation\'s own headquarters capacity covers the tonnage of the formation and its subordinates (otherwise the formation has no bonus), and each parent at the same colony with a commander adds a quarter of its own bonus excess. A formation is carried whole by one troop ship. The same rule counts the engineers already at the colony in its capacity. The saved assignment of engineers to fortification work is not stored, so the figure is an upper bound.',
  assumptions: ['no engineers are assigned to fortification work', 'a moved formation keeps only the parents already at the colony', 'moving the engineers takes no time and the troop ships are free'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const plainNumber = (value, decimals = 0) => String(roundToDecimal(value, decimals))

// `one` for a count of 1, `many` (the plural by an s) otherwise.
export const plural = (count, one, many = `${one}s`) => (count === 1 ? one : many)

// The figures of the routes' text, written with `format` (number, decimals) => text: the page's own number format, so the text agrees with the figure rows.
const texts = (format) => ({
  figure: (value, decimals = 0) => format(value, decimals),
  tonnes: (value) => `${format(value, 0)} t`,
  days: (value) => {
    const decimals = value < 10 ? 1 : 0
    const shown = roundToDecimal(value, decimals)

    return `${format(shown, decimals)} ${plural(shown, 'day')}`
  },
})

// A figure the route works out as a provenance result: at the rule's own status for a number, unavailable naming `name` otherwise.
const derived = (rule, value, { units = '', name, present = [] }) => (isNumber(value) ? ofRule({ rule, value, inputs: { present }, units }) : unavailable({ rule, missing: [name], units }))

const mineralName = (id) => (MINERALS.find((mineral) => mineral.id === id) || { name: `mineral ${id}` }).name

// What `quantity` of an installation type (`type`: { Name, Cost, CargoPoints, Workers, recipe: { [mineralId]: amount }, eligibility: [text] }) takes: { type, quantity, manned, bp, tonnes, workers, recipe } where bp, tonnes and workers are results (unavailable, naming the missing column, for a null one) and recipe is the minerals the number needs as [{ id, name, tonnes }] (null when the save lacks the recipe). `eligibility` names what the save does not say about whether the race can build the type (empty, or absent, when it does): every result is then unavailable. `manned` is null when the type's workers are not known: the workers result says so and a route never takes the type as automated.
export const mineRequirements = (type, quantity) => {
  const rule = 'mineBootstrap.requirements'
  const unknownEligibility = type.eligibility && type.eligibility.length ? type.eligibility : null
  const times = (value, text, units) => {
    if (unknownEligibility) {
      return unavailable({ rule, missing: unknownEligibility, units })
    }

    return isNumber(value) && isNumber(quantity) ? ofRule({ rule, value: value * quantity, inputs: { present: [text] }, units }) : unavailable({ rule, missing: [isNumber(quantity) ? text : 'a number of mines'], units })
  }

  return {
    type,
    quantity,
    manned: isNumber(type.Workers) ? type.Workers > 0 : null,
    bp: times(type.Cost, `the build cost of ${type.Name}`, 'BP'),
    tonnes: times(type.CargoPoints, `the cargo points of ${type.Name}`, 't'),
    workers: times(type.Workers, `the workers of ${type.Name}`, 'M workers'),
    recipe: type.recipe && isNumber(quantity) ? Object.entries(type.recipe).filter(([, amount]) => isNumber(amount) && amount > 0).map(([id, amount]) => ({ id: Number(id), name: mineralName(Number(id)), tonnes: amount * quantity })) : null,
  }
}

const routeBase = (id, title) => ({ id, title, status: 'unavailable', figures: {}, worksNow: [], limits: [], missing: [] })

// The minerals a stock (`stock`: { [mineralId]: tonnes }, null when it is not read) lacks for a recipe: [{ id, name, need, have, short }], and whether the stock is known.
const mineralGaps = (recipe, stock) => {
  if (!recipe) {
    return { known: false, short: [], missing: ['the installation\'s mineral recipe'] }
  } else if (!stock) {
    return { known: false, short: [], missing: ['the colony\'s mineral stock'] }
  }

  const unknown = recipe.filter((item) => !isNumber(stock[item.id]))
  const short = recipe.filter((item) => isNumber(stock[item.id]) && stock[item.id] < item.tonnes).map((item) => ({ ...item, have: stock[item.id], short: item.tonnes - stock[item.id] }))

  return { known: unknown.length === 0, short, missing: unknown.map((item) => `the stock of ${item.name}`) }
}

// The colony's workers once `extra` more are needed (millions), re-split with the colony's own cost: { free, efficiency } or null when a figure is missing.
const staffed = (split, cost, extra) => (split && isNumber(cost) && isNumber(extra) ? workerSplit({}, split.population, cost, split.required + extra) : null)

// The days a build of `bp` takes at `rate` BP/yr, as a result of `rule`.
const buildDays = (rule, bp, rate) => combine({ rule, parts: { bp, rate }, compute: ({ bp: cost, rate: perYear }) => (perYear > 0 ? (cost / perYear) * DAYS_PER_YEAR : Infinity), units: 'days' })

// The same days for a figure a page shows: unavailable, naming what is missing, when the cost or the rate is not known or no capacity is idle.
export const buildDaysResult = (rule, bp, rate) => {
  if (!isAvailable(bp)) {
    return unavailable({ rule, missing: bp.inputs.missing, units: 'days' })
  } else if (!rate || !isAvailable(rate)) {
    return unavailable({ rule, missing: rate ? rate.inputs.missing : ['the colony\'s construction capacity'], units: 'days' })
  }

  return rate.value > 0 ? buildDays(rule, bp, rate) : unavailable({ rule, missing: ['idle construction capacity (none is free)'], units: 'days' })
}

// The modifiers with the colony's saved efficiency taken out of the overall figure: what the colony's factory capacity would be fully staffed. Null when the efficiency is 0 or unknown (the full capacity is then not known), so the caller gives no figure.
export const fullStaffModifiers = (modifiers, efficiency) => (modifiers && isNumber(efficiency) && efficiency > 0 && isNumber(modifiers.OverallProductionModifier) ? { ...modifiers, OverallProductionModifier: modifiers.OverallProductionModifier / efficiency } : null)

// The idle part of a colony's construction capacity as a BP/yr result: `capacity` the colony's yearly construction capacity (a 'production.populationCapacity' result), `usage` the share running projects hold ({ used, missing } of `industryUsage`, undefined for none).
export const idleConstruction = (capacity, usage) => freeCapacity(capacity, usage).free

// What the mines themselves ask of the colony that receives them, however they are built: the workers of manned mines against the colony's free workers (now and at the horizon) and the minerals of the recipe against a stock. `shortNow` and `shortLater` are the workers the mines need that the colony does not have, never more than the mines need: a shortage the colony already has is not the mines' (automated mines need no workers, so theirs is 0). Null when the colony's workers or colony cost are not known.
const mineNeeds = ({ requirement, workers, stock, t }) => {
  const known = isAvailable(requirement.workers)
  const extra = known ? requirement.workers.value : 0
  const afterNow = known ? staffed(workers.now, workers.cost, extra) : null
  const afterLater = known ? staffed(workers.later, workers.cost, extra) : null
  const shortOf = (after) => (after ? Math.min(extra, Math.max(0, -after.free)) : null)
  const shortNow = shortOf(afterNow)
  const shortLater = shortOf(afterLater)
  const gaps = mineralGaps(requirement.recipe, stock)
  const missing = known ? (extra > 0 && !afterNow ? ['the colony\'s workers and colony cost'] : []) : requirement.workers.inputs.missing
  const limits = []

  if (shortNow > WORKER_TOLERANCE) {
    limits.push(`The manned mines need ${people(extra)} of workers the colony does not have: ${people(-afterNow.free)} short once built, so the efficiency falls to ${t.figure(afterNow.efficiency * 100)}%.`)
  } else if (shortLater > WORKER_TOLERANCE) {
    limits.push(`The manned mines leave the colony ${people(-afterLater.free)} short of workers at the horizon.`)
  }

  if (gaps.short.length) {
    limits.push(`The colony's stock is short of ${gaps.short.map((item) => `${item.name} by ${t.tonnes(item.short)}`).join(', ')}.`)
  }

  return { extra, afterNow, afterLater, shortNow, shortLater, gaps, limits, missing: [...missing, ...gaps.missing], gapped: shortNow > WORKER_TOLERANCE || shortLater > WORKER_TOLERANCE || gaps.short.length > 0 }
}

// Route 2: the colony's own industry. `capacity`: { now, full } construction capacity results (`full` unavailable when the colony's efficiency is 0 or unknown), `usage` as `idleConstruction` takes it, `colony`: { Efficiency }, `workers`: { now, later, cost } (the colony's `workerSplit` figures now and at the horizon, null when unknown; `cost` the colony cost), `stock`: { [mineralId]: tonnes } or null, `gaps` the reads that failed (texts), which leave the route unavailable, `format`: (number, decimals) => text, how the figures in the text are written.
export const localRoute = ({ requirement, capacity, usage, colony, workers, stock, gaps: readGaps = [], format = plainNumber }) => {
  const t = texts(format)
  const route = routeBase('local', 'Local industry')
  const missing = []
  const rate = capacity.now ? idleConstruction(capacity.now, usage) : null
  const full = capacity.full ? idleConstruction(capacity.full, usage) : null
  const needs = [requirement.bp, requirement.workers]

  needs.filter((result) => !isAvailable(result)).forEach((result) => missing.push(...result.inputs.missing))
  missing.push(...readGaps)

  if (!rate || !isAvailable(rate)) {
    missing.push(...(rate ? rate.inputs.missing : ['the colony\'s construction capacity']))
  }

  if (missing.length) {
    return { ...route, missing: [...new Set(missing)], limits: ['The colony\'s local build cannot be judged without these inputs.'] }
  }

  const rule = 'mineBootstrap.localBuild'
  const build = buildDays(rule, requirement.bp, rate)
  const understaffed = Boolean(workers.now) && workers.now.free < -WORKER_TOLERANCE
  const lostBP = isAvailable(full) && isAvailable(rate) ? Math.max(0, full.value - rate.value) : null
  const need = mineNeeds({ requirement, workers, stock, t })
  const efficiencyAfter = need.afterNow ? need.afterNow.efficiency : null
  const results = {
    efficiencyNow: derived(rule, colony.Efficiency, { name: 'the colony\'s saved efficiency', present: ['FCT_Population.Efficiency'] }),
    efficiencyAfter: derived(rule, efficiencyAfter, { name: 'the colony\'s workers and colony cost', present: ['the colony\'s worker split', 'the workers of the mines'] }),
  }
  const figures = { rate, full, days: build, lostBP, efficiencyNow: isNumber(colony.Efficiency) ? colony.Efficiency : null, efficiencyAfter, freeAfterNow: need.afterNow ? need.afterNow.free : null, freeAfterLater: need.afterLater ? need.afterLater.free : null, shortMinerals: need.gaps.short, results }
  const worksNow = []
  const limits = []

  if (!(rate.value > 0)) {
    limits.push(colony.Efficiency === 0 ? 'The colony makes no construction at an efficiency of 0, so it cannot build the mines.' : 'The colony has no idle construction capacity: its capacity is 0 or running projects hold all of it.')

    return { ...route, status: 'blocked', figures, limits, missing: [...new Set([...missing, ...need.gaps.missing])] }
  }

  worksNow.push(`Builds the mines in ${t.days(build.value)} at ${t.figure(rate.value)} BP/yr of idle construction capacity.`)

  if (understaffed) {
    limits.push(`Full local production is not possible: the colony is ${people(-workers.now.free)} short of workers, so it makes ${lostBP === null ? 'less than its full capacity' : `${t.figure(lostBP)} BP/yr less than fully staffed`} (efficiency ${t.figure((colony.Efficiency || 0) * 100)}%).`)
  }

  limits.push(...need.limits)

  return { ...route, status: understaffed || need.gapped ? 'limited' : 'works', figures, worksNow, limits, missing: [...new Set(need.missing)] }
}

const FUEL_INPUTS = { EnginePower: 'the engine power', FuelEfficiency: 'the fuel use per engine power', FuelCapacity: 'the fuel capacity' }

// The fuel inputs of a freighter class that are not known (null or not read), as names.
const fuelGaps = (shipClass) => Object.entries(FUEL_INPUTS).filter(([key]) => !isNumber(shipClass[key])).map(([, label]) => `${label} of ${shipClass.ClassName}`)

// What a haul of the mines takes by each freighter class: `freighters` is [{ ClassName, CargoCapacity, MaxSpeed, Ships, Size, MilitaryEngines, Drive, AnyDrive, ... }] as the Hauling Planner reads them, `route` the route as `builderOptions` gives it ({ jumps, km, ungated }) and `gatedRoute` the route over stabilised jump points only (or null). A class whose jump drives cover its size crosses unstabilised jump points on its own; any other class takes the stabilised route when there is one, and otherwise needs a jump-capable tender (`transit.tender` 'required', or 'unknown' when the save does not say what drives the class has). Returns the classes timed ({ shipClass, estimate, lift, deficit, trips, transit }) with the quickest that can run without a tender first.
export const freightOptions = ({ tonnes: weight, route, gatedRoute, from, to, freighters, shuttleTechnology, version }) => freighters.filter((shipClass) => shipClass.CargoCapacity > 0).map((shipClass) => {
  const driveKnown = [shipClass.Drive, shipClass.AnyDrive, shipClass.MilitaryEngines, shipClass.Size].every(isNumber)
  const covered = route.ungated === 0 ? true : driveKnown ? fleetCanTransit([{ Size: shipClass.Size, MilitaryEngines: shipClass.MilitaryEngines, Drive: shipClass.Drive, AnyDrive: shipClass.AnyDrive }]) : null
  const detour = covered !== true && gatedRoute
  const leg = detour ? gatedRoute : route
  const tender = covered === true || detour ? 'none' : covered === false ? 'required' : 'unknown'
  const fuel = fuelGaps(shipClass)
  const timed = haulByClass({ tonnes: weight, km: leg.km, from, to }, shipClass, shuttleTechnology, version, 'installations')
  const estimate = fuel.length && (timed.status === 'ok' || timed.status === 'range') ? { ...timed, status: 'unknown', problems: [{ where: 'route', status: 'unsupported', code: 'fuel', text: `${fuel.join(', ')} not known` }], tripSeconds: null, trips: null, tripDays: null, oneShipDays: null, classDays: null, fuelPerShip: null, fuelShare: null } : timed
  const lift = Math.max(1, shipClass.Ships) * shipClass.CargoCapacity

  return { shipClass, estimate, fuel, lift, deficit: Math.max(0, weight - lift), trips: Math.ceil(estimate.holds / Math.max(1, shipClass.Ships)), transit: { ungated: route.ungated, tender, detour: Boolean(detour), jumps: leg.jumps, km: leg.km } }
}).sort((a, b) => Number(b.estimate.status === 'ok' && b.transit.tender === 'none') - Number(a.estimate.status === 'ok' && a.transit.tender === 'none') || Number(b.estimate.status === 'ok') - Number(a.estimate.status === 'ok') || (a.estimate.classDays ?? Infinity) - (b.estimate.classDays ?? Infinity))

// The charted route to `target` from a place as { jumps, km, ungated }, `ungated` the jump points on it that are not stabilised on both sides (a ship with no jump drive covering it needs a tender there), or null when no explored route joins them.
const describeRoute = (route) => (route ? { jumps: route.jumps, km: route.km, ungated: routeLegs(route).filter((leg) => leg.kind === 'jump' && !(hasGate(leg.from) && hasGate(leg.to))).length } : null)

// The colonies of the race that could build the mines, the quickest build first: `builders` is [{ colony, rate, stock }] (`rate` the idle construction capacity as a result), `target` the colony meant to gain mining. Each carries the charted route to the target ({ jumps, km, ungated } or null when none), the route over stabilised jump points only (`gatedRoute`, null when none) and the build days. A builder with no rate comes last.
export const builderOptions = ({ requirement, target, builders, jumpPoints }) => {
  const origin = [{ SystemID: target.SystemID, Xcor: target.Xcor, Ycor: target.Ycor }]
  const byId = Object.fromEntries(jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
  const search = searchRoutes(jumpPoints, origin, { order: 'km' })
  const stabilised = searchRoutes(jumpPoints, origin, { order: 'km', ...transitRule({ gates: true, civilian: false }, byId, new Set()) })

  return builders.filter((builder) => builder.colony.PopulationID !== target.PopulationID).map((builder) => {
    const place = { SystemID: builder.colony.SystemID, Xcor: builder.colony.Xcor, Ycor: builder.colony.Ycor }
    const route = describeRoute(search.toPlace(place))
    const gated = describeRoute(stabilised.toPlace(place))
    const rate = builder.rate && isAvailable(builder.rate) && builder.rate.value > 0 ? builder.rate.value : null
    const bp = valueOrNull(requirement.bp)

    return { ...builder, route, gatedRoute: gated, buildDays: rate !== null && bp !== null ? (bp / rate) * DAYS_PER_YEAR : null }
  }).sort((a, b) => Number(b.route !== null && b.buildDays !== null) - Number(a.route !== null && a.buildDays !== null) || (a.buildDays ?? Infinity) - (b.buildDays ?? Infinity) || (a.route ? a.route.km : Infinity) - (b.route ? b.route.km : Infinity))
}

// Route 1: the mines built at `builder` ({ colony, rate, stock, route, gatedRoute, buildDays } of `builderOptions`, null when no colony is a candidate) and carried to `target`. `freighters`, `shuttleTechnology` and `version` as `freightOptions` takes them; `workers` and `format` as `localRoute` takes them (the target's workers); `gaps` the reads that failed, which leave the route unavailable.
export const importRoute = ({ requirement, target, builder, freighters, shuttleTechnology, version, workers, gaps: readGaps = [], format = plainNumber }) => {
  const t = texts(format)
  const route = routeBase('import', 'Import')
  const missing = [...new Set([requirement.bp, requirement.tonnes, requirement.workers].filter((result) => !isAvailable(result)).flatMap((result) => result.inputs.missing))]

  if (missing.length || readGaps.length) {
    return { ...route, missing: [...missing, ...readGaps], limits: ['The import cannot be judged without these inputs.'] }
  }

  const weight = requirement.tonnes.value
  const need = mineNeeds({ requirement, workers, stock: null, t })
  const { extra } = need
  // The mines' own labour need beyond the colony's free workers; the colony's shortage before they stand is kept apart.
  const existing = (split) => (split ? Math.max(0, -split.free) : null)
  const labour = { needed: extra, deficitNow: need.shortNow, deficitLater: need.shortLater, existingNow: existing(workers.now), existingLater: existing(workers.later), manned: requirement.manned }
  const standing = ['Mines already installed at other colonies are not counted.', 'Whether the freighters are free is not read.']
  const limits = []
  const unread = [...standing]
  const rule = 'mineBootstrap.import'
  const figures = { tonnes: requirement.tonnes, labour, builder: builder ? { name: builder.colony.PopName, jumps: builder.route ? builder.route.jumps : null, km: builder.route ? builder.route.km : null, buildDays: builder.buildDays } : null }
  const labourResults = {
    needed: requirement.workers,
    deficitNow: derived(rule, labour.deficitNow, { units: 'M workers', name: 'the colony\'s workers and colony cost', present: ['the workers of the mines', 'the colony\'s worker split'] }),
    deficitLater: derived(rule, labour.deficitLater, { units: 'M workers', name: 'the colony\'s workers and colony cost', present: ['the workers of the mines', 'the colony\'s worker split at the horizon'] }),
    existingNow: derived(rule, labour.existingNow, { units: 'M workers', name: 'the colony\'s worker split', present: ['the colony\'s worker split'] }),
  }

  if (!builder) {
    return { ...route, status: 'blocked', figures: { ...figures, results: { labour: labourResults } }, limits: ['No other colony of the race can build the mines.'], missing: unread }
  }

  const gaps = mineralGaps(requirement.recipe, builder.stock)
  const buildResult = derived(rule, builder.buildDays, { units: 'days', name: `the idle construction capacity of ${builder.colony.PopName}`, present: [`the build cost of ${requirement.type.Name}`, `the idle construction capacity of ${builder.colony.PopName}`] })
  const untimed = (name) => ({ buildDays: buildResult, haulDays: derived(rule, null, { units: 'days', name }), totalDays: derived(rule, null, { units: 'days', name }), freight: derived(rule, null, { units: 'trips', name }), labour: labourResults })

  if (!builder.route) {
    return { ...route, status: 'blocked', figures: { ...figures, results: untimed(`a charted route from ${builder.colony.PopName} to the colony`) }, limits: [`${builder.colony.PopName} has no charted route to the colony.`], missing: [...unread, ...gaps.missing] }
  }

  if (builder.buildDays === null) {
    const rate = builder.rate

    if (!rate || !isAvailable(rate)) {
      const names = rate ? rate.inputs.missing : [`the idle construction capacity of ${builder.colony.PopName}`]

      return { ...route, status: 'unavailable', figures: { ...figures, results: { ...untimed(names.join(', ')), buildDays: unavailable({ rule, missing: names, units: 'days' }) } }, limits: [`The build at ${builder.colony.PopName} cannot be judged without these inputs.`], missing: [...unread, ...names, ...gaps.missing] }
    }

    return { ...route, status: 'blocked', figures: { ...figures, results: untimed(`the idle construction capacity of ${builder.colony.PopName}`) }, limits: [`${builder.colony.PopName} has no idle construction capacity.`], missing: [...unread, ...gaps.missing] }
  }

  const options = freightOptions({ tonnes: weight, route: builder.route, gatedRoute: builder.gatedRoute, from: builder.colony, to: target, freighters, shuttleTechnology, version })
  const unaided = options.find((option) => option.estimate.status === 'ok' && option.transit.tender === 'none') || null
  const tendered = unaided ? null : options.find((option) => option.estimate.status === 'ok') || null
  const best = unaided || tendered
  const inputsUnknown = [...new Set(options.filter((option) => option.estimate.status === 'unknown').flatMap((option) => [...option.fuel, ...option.estimate.problems.filter((problem) => problem.status === 'unsupported' && problem.code !== 'fuel').map((problem) => problem.text)]))]

  if (!best && inputsUnknown.length) {
    const lifted = options[0]

    return { ...route, status: 'unavailable', figures: { ...figures, freightDeficit: lifted.deficit, trips: lifted.trips, results: { ...untimed(inputsUnknown.join(', ')), freight: derived(rule, lifted.trips, { units: 'trips', name: 'a freighter class that can lift the mines', present: ['the cargo capacity of the freighter class'] }) } }, limits: ['The haul cannot be judged without these inputs.'], missing: [...unread, ...inputsUnknown, ...gaps.missing] }
  }

  unread.push(...inputsUnknown)

  const lifted = best || options[0] || null
  const deficit = lifted ? lifted.deficit : weight
  const totalDays = best ? builder.buildDays + best.estimate.classDays : null
  const results = {
    buildDays: buildResult,
    haulDays: derived(rule, best ? best.estimate.classDays : null, { units: 'days', name: 'a freighter class that can run the haul', present: ['the cargo capacity, speed and fuel of the freighter class', 'the cargo handling at both colonies'] }),
    totalDays: derived(rule, totalDays, { units: 'days', name: 'a freighter class that can run the haul', present: [`the build days at ${builder.colony.PopName}`, 'the haul days of the freighter class'] }),
    labour: labourResults,
  }
  results.freight = derived(rule, lifted ? lifted.trips : null, { units: 'trips', name: 'a freighter class that can lift the mines', present: ['the cargo capacity of the freighter class'] })

  Object.assign(figures, { options, best, freightDeficit: deficit, trips: lifted ? lifted.trips : null, tripDays: best ? best.estimate.tripDays : null, haulDays: best ? best.estimate.classDays : null, totalDays, shortMinerals: gaps.short, results })

  if (!options.length) {
    limits.push(`No freighter: the whole ${t.tonnes(weight)} is a freight deficit.`)
  } else if (!best) {
    const why = options[0].estimate.problems.map((problem) => problem.text).join('; ')

    limits.push(`No freighter class can run the haul (${options[0].estimate.status}${why ? `: ${why}` : ''}).`)
  }

  const worksNow = []

  if (best) {
    const jumps = best.transit.jumps

    worksNow.push(`${builder.colony.PopName} builds the mines in ${t.days(builder.buildDays)}; ${best.shipClass.ClassName} (${best.shipClass.Ships} ${plural(best.shipClass.Ships, 'ship')}) carries them over ${jumps} ${plural(jumps, 'jump')} in ${best.trips} ${plural(best.trips, 'trip')}, ${t.days(best.estimate.classDays)}${tendered ? ', if a tender takes it through' : ''}.`)

    if (best.transit.detour) {
      worksNow.push(`The freighters take a route over stabilised jump points only, ${t.figure(best.transit.km)} km: ${best.shipClass.ClassName} has no jump drive that covers its size.`)
    }

    if (tendered) {
      limits.push(`Jump tender needed: ${best.transit.ungated} ${plural(best.transit.ungated, 'jump point on the route is', 'jump points on the route are')} not stabilised on both sides and ${best.shipClass.ClassName} ${best.transit.tender === 'required' ? 'has no jump drive that covers its size' : 'is not known to have one'}. The haul runs only with a jump-capable ship that takes it through.`)
      unread.push(best.transit.tender === 'required' ? 'A jump-capable tender for the freighters (or stabilised jump points on the route)' : 'The jump drives of the freighter classes')
    }

    if (deficit > 0) {
      limits.push(`Freight deficit: ${t.tonnes(deficit)} beyond one lift of ${t.tonnes(best.lift)}, so ${best.trips} ${plural(best.trips, 'trip')}.`)
    }
  }

  if (need.shortNow !== null && need.shortNow > WORKER_TOLERANCE) {
    limits.push(`Labour deficit: the mines need ${people(extra)} of workers and the colony is ${people(need.shortNow)} short of them once they stand.`)
  } else if (need.shortLater !== null && need.shortLater > WORKER_TOLERANCE) {
    limits.push(`Labour deficit at the horizon: ${people(need.shortLater)} short.`)
  } else if (extra > 0 && !need.afterNow) {
    unread.push('The colony\'s workers and colony cost')
  }

  if (gaps.short.length) {
    limits.push(`${builder.colony.PopName}'s stock is short of ${gaps.short.map((item) => `${item.name} by ${t.tonnes(item.short)}`).join(', ')}.`)
  }

  const blocked = !best
  const gapped = deficit > 0 || Boolean(tendered) || need.shortNow > WORKER_TOLERANCE || need.shortLater > WORKER_TOLERANCE || gaps.short.length > 0

  return { ...route, status: blocked ? 'blocked' : gapped ? 'limited' : 'works', figures, worksNow, limits, missing: [...new Set([...unread, ...gaps.missing])] }
}

// The command chain of ground formations. `formations`: every formation of the race, { FormationID, PopulationID, ParentFormationID, ownSize, hq, commander } where `commander` is null for none, otherwise { bonus } (the Production bonus, 1 when the commander has none, null when the save does not say). A formation's headquarters capacity modifier is 1 when its tonnage and its subordinates' fit within its own headquarters capacity, 0 when they do not.
// The headquarters load counts each formation's own tonnage whole (the fraction dropped); the carriage of a formation keeps its fraction.
const treeSize = (formation, children, seen = new Set()) => {
  if (seen.has(formation.FormationID)) {
    return null
  }

  seen.add(formation.FormationID)

  const parts = (children[formation.FormationID] || []).map((child) => treeSize(child, children, seen))

  return isNumber(formation.ownSize) && parts.every(isNumber) ? Math.floor(formation.ownSize) + parts.reduce((sum, part) => sum + part, 0) : null
}

const capacityModifier = (formation, children) => {
  const total = treeSize(formation, children)

  return total === null || !isNumber(formation.hq) ? null : total > formation.hq ? 0 : 1
}

// The multiplier a formation's commander gives its construction, standing at `population`: 1 with no commander; otherwise its own bonus (scaled by its capacity modifier) times each parent's quarter-share going up while the parent stands at the same colony and has a commander. Null when a figure on the way is not known.
export const commandMultiplier = (formation, population, byId, children) => {
  if (!formation.commander) {
    return 1
  }

  const bonus = formation.commander.bonus
  const capacity = capacityModifier(formation, children)

  if (!isNumber(bonus) || capacity === null) {
    return null
  }

  let multiplier = capacity >= 1 ? bonus : 1 + (bonus - 1) * capacity
  let child = formation
  let where = population
  const seen = new Set([formation.FormationID])

  for (;;) {
    const parent = byId[child.ParentFormationID]

    if (!parent || !parent.PopulationID || parent.PopulationID !== where || !parent.commander || seen.has(parent.FormationID)) {
      return multiplier
    }

    const parentCapacity = capacityModifier(parent, children)

    if (!isNumber(parent.commander.bonus) || parentCapacity === null) {
      return null
    }

    multiplier *= 1 + (parent.commander.bonus - 1) * PARENT_SHARE * parentCapacity
    seen.add(parent.FormationID)
    child = parent
    where = parent.PopulationID
  }
}

const indexFormations = (formations) => {
  const byId = {}
  const children = {}

  formations.forEach((formation) => {
    byId[formation.FormationID] = formation
    ;(children[formation.ParentFormationID] = children[formation.ParentFormationID] || []).push(formation)
  })

  return { byId, children }
}

// The construction rating of the engineers standing at `population`, rule-mapped: the sum of units x rating x commander multiplier over the formations there, as { power, unknown } (`unknown`: the formations whose rating or command chain is not known, left out of the power). Formations aboard ships (no population) and formations without construction rating add nothing.
export const engineerPower = (formations, population) => {
  const { byId, children } = indexFormations(formations)
  const unknown = []
  let power = 0

  formations.filter((formation) => formation.PopulationID === population && !formation.ShipID && (formation.rating === null || formation.rating > 0)).forEach((formation) => {
    const multiplier = formation.rating === null ? null : commandMultiplier(formation, population, byId, children)

    if (multiplier === null) {
      unknown.push(formation)
    } else {
      power += formation.rating * multiplier
    }
  })

  return { power, unknown }
}

// The colony's production modifiers with the engineers' rating worked out by the mapped command rule (`engineerPower`) in place of the one the Production page's modifiers hold, so the capacity of a colony and the engineers the route adds are counted by one formula, as { modifiers, unknown }. `modifiers` is null when the rule is not mapped for the version or the save lacks a column of the formations (the Production page's modifiers stand then) and when a figure of the colony's engineers is not known (`unknown` then lists those formations: the capacity is not known either).
export const mappedEngineers = (modifiers, ground, version, population) => {
  if (!modifiers || ruleSupports('mineBootstrap.groundAssistance', version) !== true || ground.gaps.length) {
    return { modifiers: null, unknown: [] }
  }

  const { power, unknown } = engineerPower(ground.formations, population)

  return unknown.length ? { modifiers: null, unknown } : { modifiers: { ...modifiers, GroundConstructionPower: power }, unknown: [] }
}

export const withMappedEngineers = (modifiers, ground, version, population) => mappedEngineers(modifiers, ground, version, population).modifiers

const engineerGap = (unknown) => `a construction rating, size, headquarters capacity or commander bonus the save leaves null for ${listed(unknown, (formation) => formation.Name || `formation ${formation.FormationID}`)}`

// The unavailable construction capacity of a colony whose engineers have a figure the save leaves null, naming the formations; null when the engineers are known or the rule is not mapped for the save.
export const engineerCapacityGap = (modifiers, ground, version, population) => {
  const { unknown } = mappedEngineers(modifiers, ground, version, population)

  return unknown.length ? unavailable({ rule: 'mineBootstrap.groundAssistance', missing: [engineerGap(unknown)], units: 'BP/yr' }) : null
}

// Which engineer formations (`candidates`, each { formation }) the race's troop ships can carry. A formation is not split among ships: the whole of its own tonnage goes into one ship's bay. `troopCapacity.classes` is [{ TroopCapacity, Ships }]. A formation larger than the largest bay is carried by no ship at all (`oversize`); with no bay at all every formation of known tonnage is `oversize`, a tonnage of 0 included. The others go the largest first, each into the first ship with room, and those the first lift leaves without room wait for another lift of the same ships (`later`). Returns { carried, later, lifts, oversize, unsized }: the candidates the first lift carries, those that need another lift, the number of lifts all the carriable ones take, the candidates no bay holds and those whose tonnage is not known. It always returns: each lift carries at least the largest formation that fits the largest bay.
export const carryFormations = (candidates, troopCapacity) => {
  const bays = troopCapacity.classes.flatMap((item) => (isNumber(item.TroopCapacity) ? Array(Math.max(0, item.Ships)).fill(item.TroopCapacity) : []))
  const biggest = Math.max(...bays)
  const sized = candidates.filter((candidate) => isNumber(candidate.formation.ownSize)).sort((a, b) => b.formation.ownSize - a.formation.ownSize)
  const lifts = []
  let pending = sized.filter((candidate) => candidate.formation.ownSize <= biggest)

  while (pending.length) {
    const rooms = [...bays]
    const lift = []
    const waiting = []

    pending.forEach((candidate) => {
      const at = rooms.findIndex((room) => room >= candidate.formation.ownSize)

      if (at < 0) {
        waiting.push(candidate)
      } else {
        rooms[at] -= candidate.formation.ownSize
        lift.push(candidate)
      }
    })

    lifts.push(lift)
    pending = waiting
  }

  return { carried: lifts[0] || [], later: lifts.slice(1).flat(), lifts: lifts.length, oversize: sized.filter((candidate) => candidate.formation.ownSize > biggest), unsized: candidates.filter((candidate) => !isNumber(candidate.formation.ownSize)) }
}

const listed = (items, name) => `${items.slice(0, 3).map(name).join(', ')}${items.length > 3 ? ' and others' : ''}`

// Route 3: engineers moved to the colony. `ground`: { gaps, formations } from the loader (`gaps` the schema columns the save lacks), `factor`: { ConstructionProduction, EngineerProductionModifier } of the colony (null columns unknown), `capacity` the colony's yearly construction capacity result now (with its own engineers counted by `withMappedEngineers`), `usage`, `workers`, `stock` and `format` as `localRoute` takes them, `version` the formula version, `troopCapacity` the race's troop ships ({ lift, ships, classes: [{ TroopCapacity, Ships }] }, null when not read). Unavailable with the reason when the rules this relies on are not mapped for the save. The engineers do not change what the mines themselves need: the workers of manned mines and the minerals of the recipe are assessed as the local route does.
export const groundRoute = ({ requirement, target, ground, factor, capacity, usage, version, troopCapacity, workers = { now: null, later: null, cost: null }, stock = null, gaps: readGaps = [], format = plainNumber }) => {
  const t = texts(format)
  const route = routeBase('ground', 'Ground-force assistance')
  const reasons = []

  if (ruleSupports('mineBootstrap.groundAssistance', version) !== true) {
    reasons.push('the construction rating and command rules are mapped only for a save that states the game rules it was played under')
  }

  if (ground.gaps.length) {
    reasons.push(`the save lacks ${ground.gaps.join(', ')}`)
  }

  reasons.push(...readGaps)

  if (!factor || !isNumber(factor.ConstructionProduction) || !isNumber(factor.EngineerProductionModifier)) {
    reasons.push('the colony\'s race construction rate and engineer modifier')
  }

  if (reasons.length) {
    return { ...route, status: 'unavailable', limits: [`Unavailable: ${reasons.join('; ')}.`], missing: reasons }
  }

  const { byId, children } = indexFormations(ground.formations)
  const factorValue = factor.ConstructionProduction * factor.EngineerProductionModifier
  const atTarget = engineerPower(ground.formations, target.PopulationID)
  const candidates = ground.formations.filter((formation) => formation.PopulationID > 0 && formation.PopulationID !== target.PopulationID && !formation.ShipID && (formation.rating === null || formation.rating > 0)).map((formation) => {
    const multiplier = formation.rating === null ? null : commandMultiplier(formation, target.PopulationID, byId, children)

    return { formation, rating: formation.rating, multiplier, power: multiplier === null ? null : formation.rating * multiplier, bp: multiplier === null ? null : formation.rating * multiplier * factorValue }
  })
  const aboard = ground.formations.filter((formation) => !formation.PopulationID && formation.ShipID > 0 && formation.rating > 0)
  const unknown = candidates.filter((candidate) => candidate.power === null)

  if (unknown.length || atTarget.unknown.length) {
    const named = [...unknown.map((candidate) => candidate.formation), ...atTarget.unknown]
    const reason = engineerGap(named)

    return { ...route, status: 'unavailable', limits: [`Unavailable: ${reason}.`], missing: [reason] }
  }

  const rule = 'mineBootstrap.groundAssistance'
  const sum = (items) => items.reduce((total, candidate) => total + candidate.bp, 0)
  const carriage = troopCapacity && Array.isArray(troopCapacity.classes) ? carryFormations(candidates, troopCapacity) : null
  const movable = carriage ? [...carriage.carried, ...carriage.later] : candidates
  const addedUpper = sum(candidates)
  const added = sum(movable)
  const present = atTarget.power * factorValue
  const bp = valueOrNull(requirement.bp)
  const need = mineNeeds({ requirement, workers, stock, t })
  const withAdded = (amount) => (isAvailable(capacity) ? combine({ rule, parts: { capacity }, compute: (values) => values.capacity + amount, units: 'BP/yr' }) : capacity)
  const rateNow = isAvailable(capacity) ? idleConstruction(capacity, usage) : null
  const rateWith = isAvailable(capacity) ? idleConstruction(withAdded(added), usage) : null
  const daysNow = buildDaysResult(rule, requirement.bp, rateNow)
  const daysWith = buildDaysResult(rule, requirement.bp, rateWith)
  const troopNeeded = carriage ? movable.reduce((total, candidate) => total + candidate.formation.ownSize, 0) : null
  const results = {
    added: derived(rule, added, { units: 'BP/yr', name: 'the engineers\' construction rating', present: ['the construction rating, size and commander of each engineer formation', 'the race construction rate and engineer modifier'] }),
    present: derived(rule, present, { units: 'BP/yr', name: 'the engineers already at the colony', present: ['the construction rating and commander of the formations at the colony'] }),
    rateNow: rateNow || unavailable({ rule, missing: ['the colony\'s construction capacity'], units: 'BP/yr' }),
    rateWith: rateWith || unavailable({ rule, missing: ['the colony\'s construction capacity'], units: 'BP/yr' }),
    daysNow,
    daysWith,
    troop: derived(rule, troopNeeded, { units: 't', name: 'the troop ships and the size of the engineer formations', present: ['the size of each engineer formation', 'the troop ship bays'] }),
  }
  const figures = { candidates, aboard, added, addedUpper, present, carried: carriage ? movable : null, lifts: carriage ? carriage.lifts : null, oversize: carriage ? carriage.oversize : [], troopNeeded, rateNow: valueOrNull(rateNow), rateWith: valueOrNull(rateWith), daysNow: valueOrNull(daysNow), daysWith: valueOrNull(daysWith), troopCapacity, results }
  const limits = ['Engineers assigned to fortification work are excluded by the game and the assignment is not saved, so the figure is an upper bound.', 'The move time of the engineers is not modelled.']
  const worksNow = []
  const missing = ['Whether the engineers are assigned to fortification work', ...need.missing, ...(rateNow === null ? ['the colony\'s construction capacity and the share its running projects hold'] : []), ...(bp === null ? requirement.bp.inputs.missing : [])]

  if (present > 0) {
    worksNow.push(`Engineers already at the colony add ${t.figure(present)} BP/yr to its construction capacity, which the local route counts.`)
  }

  if (!candidates.length) {
    return { ...route, status: 'blocked', figures, worksNow, limits: ['No engineers stand at other colonies.', ...limits], missing }
  }

  const rateText = `${t.figure(added)} BP/yr${bp !== null && figures.daysWith !== null ? `, bringing the build to ${t.days(figures.daysWith)}${figures.daysNow !== null ? ` from ${t.days(figures.daysNow)}` : ''}` : ''}`
  let stuck = false

  if (carriage === null) {
    missing.push('The race\'s troop ships and their bays')
    worksNow.push(`${candidates.length} engineer ${plural(candidates.length, 'formation')} at other colonies add up to ${rateText}, if the troop ships can carry them.`)
  } else {
    const sizes = candidates.filter((candidate) => isNumber(candidate.formation.ownSize)).map((candidate) => candidate.formation.ownSize)
    const largest = troopCapacity.classes.reduce((best, item) => (isNumber(item.TroopCapacity) ? Math.max(best, item.TroopCapacity) : best), 0)

    if (!(troopCapacity.lift > 0)) {
      limits.push('The race has no troop ship that could carry them.')
      stuck = true
    } else if (!movable.length && !carriage.unsized.length) {
      limits.push(`No troop ship can carry an engineer formation whole: the smallest needs ${t.tonnes(Math.min(...sizes))} and the largest troop bay holds ${t.tonnes(largest)}. A formation is not split among ships.`)
      stuck = true
    } else {
      if (movable.length) {
        worksNow.push(`${movable.length} engineer ${plural(movable.length, 'formation')} that a troop ship can carry add up to ${rateText}.`)
        limits.push(`Moving them takes ${t.tonnes(troopNeeded)} of troop capacity${carriage.lifts > 1 ? ` in ${carriage.lifts} lifts of the same ships` : ''}; the race's troop ships hold ${t.tonnes(troopCapacity.lift)} in ${troopCapacity.ships} ${plural(troopCapacity.ships, 'ship')} at a time.`)
      }

      if (carriage.later.length) {
        limits.push(`${carriage.later.length} engineer ${plural(carriage.later.length, 'formation waits', 'formations wait')} for a further lift of the troop ships, which the figure counts and the move time does not.`)
      }

      if (carriage.oversize.length) {
        limits.push(`${carriage.oversize.length} engineer ${plural(carriage.oversize.length, 'formation is', 'formations are')} too large for any troop ship (the largest bay holds ${t.tonnes(largest)}) and not counted: ${listed(carriage.oversize, (candidate) => `${candidate.formation.Name || `formation ${candidate.formation.FormationID}`} ${t.tonnes(candidate.formation.ownSize)}`)}. Together they would add ${t.figure(sum(carriage.oversize))} BP/yr.`)
      }
    }

    if (carriage.unsized.length) {
      missing.push(`the size of ${listed(carriage.unsized, (candidate) => candidate.formation.Name || `formation ${candidate.formation.FormationID}`)}, to know if a troop ship can carry it`)
    }
  }

  if (aboard.length) {
    limits.push(`${aboard.length} more engineer ${plural(aboard.length, 'formation is', 'formations are')} aboard ships and not counted.`)
  }

  if (rateWith !== null && isAvailable(rateWith) && !(rateWith.value > 0)) {
    limits.push('The colony has no idle construction capacity: running projects hold all of it, so more capacity does not start the mines.')
    stuck = true
  }

  limits.push(...need.limits)

  return { ...route, status: stuck ? 'blocked' : 'limited', figures, worksNow, limits, missing: [...new Set(missing)] }
}

// All three routes for one target colony, in the order import, local, ground. `format` (number, decimals) => text writes the figures in the routes' text.
export const compareRoutes = ({ requirement, target, local, importing, ground, format = plainNumber }) => [
  importRoute({ requirement, target, ...importing, format }),
  localRoute({ requirement, ...local, format }),
  groundRoute({ requirement, target, ...ground, format }),
]

export const ROUTE_STATUS = Object.freeze({
  works: 'Works now',
  limited: 'Works with limits',
  blocked: 'Blocked',
  unavailable: 'Unavailable',
})
