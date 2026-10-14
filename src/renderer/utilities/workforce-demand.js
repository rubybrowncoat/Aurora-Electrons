// What the installations a colony has queued and the shipyard upgrades under way add to the workers it needs, month by month along the Colony Outlook's population series. The queue's completions come from the production cycle forecast (utilities/production.js, utilities/industry-cycle.js), which owns the material scheduling; the yard upgrades from the activity rows and their finish rule. This module only turns those dates into a demand: it never schedules a project, and a date the forecast cannot give stays a range or unknown, never a guess. The helpers take plain rows and return plain data; `committedWorkforce` returns a provenance result (utilities/provenance.js).

import { WORKER_TOLERANCE, workerSplit } from './colonies'
import { FUEL } from './industry-cycle'
import { combine, isAvailable, registerRule, unavailable } from './provenance'
import { flagOf, shipyardFinish, shipyardUpgradeRate } from './production'

const RULE = 'colonies.committedWorkers'
const DAYS_PER_YEAR = 365
const MONTHS_PER_YEAR = 12
// Guards a division that lands on a whole number from falling a hair under it.
const EPSILON = 1e-9
// The game rounds a cycle's build to 4 decimals, which can add up to this much of a unit to a cycle.
const BUILD_ROUNDING = 0.00005
const NPR_GAP = 'the stock of the capital, which a spied empire\'s colony builds from'

registerRule({
  id: RULE,
  versions: ['2.7.x'],
  units: 'M workers',
  verification: 'estimated',
  structure: ['FCT_IndustrialProjects.ProductionID, ProductionType, Amount, PartialCompletion', 'DIM_PlanetaryInstallation.Workers, ConversionFrom', 'FCT_Shipyard.TaskType, SYType, Capacity, Slipways, CapacityTarget, RequiredBP, CompletedBP, PauseActivity', 'FCT_Population.Duranium, Neutronium', 'the production cycle forecast rules', 'the worker and population projection rules'],
  note: 'The workers a colony needs month by month once its queued installations are built and its shipyard upgrades are done, set against the workers its projected population can supply. An installation counts at the day the forecast finishes its project, and a conversion counts the difference of the workers of the two installations; a slipway or capacity upgrade counts at the finish date of its remaining build points. The lower figure counts only completions the forecast and the rates support, the higher one every completion that could have happened by then. A paused task adds nothing, a task that makes no progress adds only what it has already built, and a date that cannot be given is kept as unknown. The forecast reproduces the game\'s cycle arithmetic; a yard upgrade\'s date is an estimate and the figure was not compared with a later save.',
  assumptions: ['no new project, upgrade or colonist is added beyond what the save holds', 'the colony\'s capacity stays what it is today, so a new factory does not speed the queue up', 'a unit adds its workers when it is delivered', 'a yard upgrade\'s minerals are checked against the colony\'s stock today, not against what other work uses first'],
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const unique = (list) => [...new Set(list)]

// The day a month of the population series ends on, and the first month a thing that happens on `day` counts in (at least the first: nothing finishes today).
const dayOfMonth = (month) => (month * DAYS_PER_YEAR) / MONTHS_PER_YEAR
const monthOfDay = (day) => Math.max(1, Math.ceil((day * MONTHS_PER_YEAR) / DAYS_PER_YEAR - EPSILON))

const zeros = (months) => new Array(months + 1).fill(0)

// `amount` from month `start` on, nothing before it or when `start` is null.
const stepFrom = (months, start, amount) => zeros(months).map((_, month) => (start !== null && month >= start ? amount : 0))

// What a yard activity adds, by its type (the shipyard's activity column): 0 is none.
export const YARD_ACTIVITIES = Object.freeze({
  1: 'adding a slipway',
  2: 'adding 500 tons of capacity',
  3: 'adding 1,000 tons of capacity',
  4: 'adding 2,000 tons of capacity',
  5: 'adding 5,000 tons of capacity',
  6: 'adding 10,000 tons of capacity',
  7: 'retooling',
  8: 'a continual capacity upgrade',
})

const CAPACITY_ADDED = Object.freeze({ 2: 500, 3: 1000, 4: 2000, 5: 5000, 6: 10000 })

// The workers a yard needs, in millions: capacity times slipways, a tenth of it at a commercial yard, over 4,000.
export const yardWorkers = (yardType, capacity, slipways) => (capacity * slipways * (yardType === 1 ? 1 : 0.1)) / 4000

// What one yard activity changes in the yard's workers: { delta } (0 for one that changes none, a retool) or { missing } naming what the save lacks or the activity this does not know.
const yardChange = (yard) => {
  const type = yard.UpgradeTaskType

  if (type === 7) {
    return { delta: 0 }
  } else if (!finite(type)) {
    return { missing: ['the type of a shipyard\'s activity'] }
  } else if (!YARD_ACTIVITIES[type]) {
    return { missing: [type === 9 ? 'what a shipyard\'s spacemaster modification changes' : `what a shipyard activity of type ${type} changes`] }
  }

  const missing = [...(finite(yard.SYType) ? [] : ['the shipyard\'s type']), ...(finite(yard.Capacity) ? [] : ['the shipyard\'s capacity']), ...(finite(yard.Slipways) ? [] : ['the shipyard\'s slipways']), ...(type === 8 && flagOf(yard.Paused) !== true && !(yard.CapacityTarget > 0) ? ['the capacity target where the upgrade stops (a continual upgrade with none has no end)'] : [])]

  if (missing.length) {
    return { missing }
  }

  const before = yardWorkers(yard.SYType, yard.Capacity, yard.Slipways)
  const after = type === 1 ? yardWorkers(yard.SYType, yard.Capacity, yard.Slipways + 1) : yardWorkers(yard.SYType, type === 8 ? (yard.CapacityTarget > 0 ? Math.max(yard.CapacityTarget, yard.Capacity) : yard.Capacity) : yard.Capacity + CAPACITY_ADDED[type], yard.Slipways)

  return { delta: after - before }
}

// The changes in a colony's workers its queue and yards hold: { missing, installation: [{ index, project, delta }], yards: [{ yard, delta }] }. `projects`: the colony's industrial projects in the order the forecast takes them, each with `ProductionType`, `ProductionID` and, for a conversion, `ConversionFrom`; `installations`: { [id]: { Workers } }; `yards`: the colony's yards with an activity. `delta` is the workers of one unit built (a conversion: less the installation it replaces) or of the whole yard upgrade, in millions; one that changes nothing is left out. `missing` names what the save lacks: an empty list is a colony whose changes are all known.
export const workforceNeeds = ({ projects, installations, yards }) => {
  const missing = []
  const installation = []
  const changing = []

  projects.forEach((project, index) => {
    if (!finite(project.ProductionType)) {
      missing.push('the production type of a project')

      return
    } else if (project.ProductionType !== 0) {
      return
    }

    const row = installations[project.ProductionID]
    const from = finite(project.ConversionFrom) ? installations[project.ConversionFrom] : null

    if (!row || !finite(row.Workers)) {
      missing.push('the workers an installation takes')
    } else if (finite(project.ConversionFrom) && (!from || !finite(from.Workers))) {
      missing.push('the workers of the installation a conversion replaces')
    } else if (row.Workers - (from ? from.Workers : 0) !== 0) {
      installation.push({ index, project, delta: row.Workers - (from ? from.Workers : 0) })
    }
  })

  yards.forEach((yard) => {
    const change = yardChange(yard)

    if (change.missing) {
      missing.push(...change.missing)
    } else if (change.delta !== 0) {
      changing.push({ yard, delta: change.delta })
    }
  })

  return { missing: unique(missing), installation, yards: changing }
}

// The month-by-month change in the workers needed from units delivered: `sure` units are certain by then, `most` the most that could be, each month by month. A unit adds `delta` workers, so the lower demand is the sure units when `delta` is positive and the most units when it is negative.
const demandOf = (delta, sure, most) => (delta > 0 ? { low: sure.map((units) => units * delta), high: most.map((units) => units * delta) } : { low: most.map((units) => units * delta), high: sure.map((units) => units * delta) })

const resourceName = (resource) => (resource === FUEL ? 'fuel' : resource)

const roundDays = (days) => Math.round(days)

// What stops or cuts a project's build, in words: the first cut and the stall the forecast found.
const limitsOf = (figure) => {
  const limits = []

  if (figure.cut) {
    limits.push(`Cut to what the ${resourceName(figure.cut.resource)} in stock covers from day ${roundDays(figure.cut.day)}${figure.cutOrders === 'some' ? ' in some orders' : ''}`)
  }

  if (figure.outcome === 'stalls' && figure.stall) {
    const { reason, resource } = figure.stall

    limits.push(reason === 'stock' ? `Stops when the ${resourceName(resource)} in stock runs out${figure.stallOrders === 'some' ? ' in some orders' : ''}` : reason === 'source' ? 'Stops when no installation is left to convert' : reason === 'remainder' ? 'Stops with a remainder finer than a build, which the forecast cannot resolve' : reason === 'capacity' ? 'Makes no progress: no capacity to build with' : reason === 'cost' ? 'Makes no progress: the project has no cost recorded' : 'Makes no progress: a cycle\'s build rounds to nothing')
  }

  return limits
}

// The event of one installation project from its forecast figure (the engine's figures for it, `forecast` of the page's figure). `exhaustive`: every order of the colony's projects was tried, so the earliest and latest dates bound the finish; when only some were, a date is not a bound and counts only in the higher demand.
const installationEvent = ({ project, figure, delta, months, exhaustive }) => {
  const total = Math.floor(project.PartialCompletion + project.Amount + EPSILON)
  const fields = { kind: 'installation', id: `project-${project.ID}`, name: project.Name, delta, earliest: figure.earliest, latest: figure.latest, approximate: false, limits: limitsOf(figure) }
  const event = (status, units, sure, most) => ({ ...fields, status, units, ...demandOf(delta, sure, most) })
  const none = zeros(months)

  if (figure.outcome === 'paused') {
    return event('paused', 0, none, none)
  } else if (figure.outcome === 'unresolved') {
    return { ...event('unknown', total, none, stepFrom(months, 1, total)), earliest: null, latest: null }
  }

  const queued = figure.outcome === 'queued'
  // A queued project in the order the forecast kept can start in another: the start any order gives bounds it (a project every order tried leaves queued adds nothing), and where the orders could not all be tried one not tried may start it as soon as the first cycle ends.
  const started = exhaustive ? figure.startEarliest : queued ? figure.cycleDays : 0
  // Most units that can be built, from the best any order gives (or all of them where the forecast could not settle the end); each cycle builds at most the units of its share and a cycle's rounding.
  const most = queued && !exhaustive ? total : Math.max(figure.delivered, Math.floor(project.PartialCompletion + figure.builtRange[1] + EPSILON), figure.stall && figure.stall.reason === 'remainder' ? total : 0)
  const maybe = zeros(months).map((_, month) => {
    if (started === null) {
      return 0
    }

    const cycles = Math.floor((dayOfMonth(month) - started) / figure.cycleDays + EPSILON)

    return cycles > 0 ? Math.min(most, Math.floor(project.PartialCompletion + cycles * (figure.unitsPerCycle + BUILD_ROUNDING) + EPSILON)) : 0
  })

  if (queued) {
    return maybe.some((units) => units > 0) ? event('maybe', 0, none, maybe) : event('queued', 0, none, none)
  }

  const finishes = figure.outcome === 'finishes' && exhaustive && figure.latest !== null
  const sure = zeros(months).map((_, month) => (finishes && dayOfMonth(month) >= figure.latest - EPSILON ? figure.delivered : 0))

  if (figure.outcome === 'finishes') {
    return event(!exhaustive ? 'sampled' : figure.latest !== null && figure.latest === figure.earliest ? 'dated' : 'range', figure.delivered, sure, maybe)
  }

  return event(figure.outcome === 'stalls' ? 'stalled' : 'later', figure.delivered, none, maybe)
}

// The event of one yard activity: its workers join at the finish date of its remaining build points. A paused one adds nothing; one that makes no progress adds nothing; one whose date the save cannot give may finish any time. One short of the Duranium or Neutronium its remaining points take (half each) in the colony's stock finishes no earlier than the rate says, and is counted only in the higher demand. A continual upgrade is counted only in the higher demand, in full from the start: its date is a rate's, its minerals are not checked and what it has raised by then is not known, so no completion of it is certain.
const yardEvent = ({ yard, delta, modifiers, months }) => {
  const type = yard.UpgradeTaskType
  const name = `${yard.ShipyardName || 'A shipyard'}: ${YARD_ACTIVITIES[type]}`
  const fields = { kind: 'yard', id: `yard-${yard.ShipyardID}`, name, delta, units: 1, earliest: null, latest: null, approximate: false, limits: [] }
  const event = (status, sure, most, extra = {}) => ({ ...fields, ...extra, status, ...demandOf(delta, sure, most) })
  const none = zeros(months)
  const paused = flagOf(yard.Paused)

  if (paused === true) {
    return event('paused', none, none, { units: 0 })
  }

  const finish = shipyardFinish(modifiers, yard, shipyardUpgradeRate(modifiers, yard))

  if (finish.idle) {
    return event('stalled', none, none, { units: 0, limits: ['Makes no progress: no build rate to work with'] })
  } else if (!isAvailable(finish.result)) {
    return event('unknown', none, stepFrom(months, 1, 1), { earliest: null, latest: null, limits: [`No date: the save lacks ${finish.result.inputs.missing.join(', ')}`] })
  }

  const day = finish.result.value
  const from = monthOfDay(day)
  const approximate = type === 8
  const needed = type === 8 ? 0 : yard.RemainingProduction / 2
  const stocks = [yard.StockDuranium, yard.StockNeutronium]
  const dated = { earliest: day, latest: day, approximate }

  if (type !== 8 && !stocks.every(finite)) {
    return event('short', none, stepFrom(months, from, 1), { ...dated, limits: ['The colony\'s Duranium or Neutronium stock is not in the save, so the date may be later'] })
  } else if (type !== 8 && stocks.some((stock) => stock < needed)) {
    return event('short', none, stepFrom(months, from, 1), { ...dated, limits: [`The colony holds less than the ${Math.round(needed)} each of Duranium and Neutronium the upgrade takes, so it finishes no earlier than this and may be later`] })
  }

  return type === 8 ? event('approximate', none, stepFrom(months, 1, 1), { ...dated, limits: ['The date is approximate and not certain: a continual upgrade raises the capacity a step a cycle, and its minerals are not checked'] }) : event('dated', stepFrom(months, from, 1), stepFrom(months, from, 1), { ...dated, limits: [] })
}

const firstShort = (free) => {
  const month = free.findIndex((value) => value < -WORKER_TOLERANCE)

  return month === -1 ? null : month
}

// The first month after `first` in which the free workers are no longer short (null where `first` is null or the shortage lasts to the horizon).
const recoveryAfter = (free, first) => {
  const month = first === null ? -1 : free.findIndex((value, index) => index > first && value >= -WORKER_TOLERANCE)

  return month === -1 ? null : month
}

// The first month after the first short one in which the free workers are no longer short (null where there is no short month or the shortage lasts to the horizon).
const recoveryOf = (free) => recoveryAfter(free, firstShort(free))

// Every event of a colony, as the forecast and the yard rows give them: { kind, id, name, delta, units, status, earliest, latest, approximate, limits, low, high }, `low` and `high` the change in the workers needed month by month (the lowest and highest the dates allow).
export const workforceEvents = ({ needs, forecast, modifiers, months }) => [
  ...needs.installation.map(({ index, project, delta }) => installationEvent({ project, figure: { ...forecast.figures[index].forecast, cycleDays: forecast.cycleDays }, delta, months, exhaustive: forecast.orders.exhaustive })),
  ...needs.yards.map(({ yard, delta }) => yardEvent({ yard, delta, modifiers, months })),
]

// The sum of the events' lower and higher change, month by month, on `base` workers.
const requiredSeries = (events, base, months) => ['low', 'high'].map((bound) => zeros(months).map((_, month) => base + events.reduce((sum, event) => sum + event[bound][month], 0)))

// A colony's committed workforce, as a result of 'colonies.committedWorkers': { months, events, required: { low, high }, free: { best, worst }, later: { best, worst }, firstShort: { best, worst }, recovery: { best, worst, worstAfterBest } }, each month by month from now to the horizon (`firstShort` the first month the free workers are short and `recovery` the first month after it they are not, null where there is none; `worstAfterBest` is the worst case's first month not short after the best case's first short month, the end of the worst case's shortage that contains the best case's, which an earlier shortage of the worst case alone does not move). `best` takes the lower demand (a shortage there is certain given the dates the forecast supports), `worst` the higher (a shortage there may happen). `workersNow`, `cost` and `projection` are the colony's results of the Outlook; `needs` is `workforceNeeds` of its queue and yards; `forecast` the forecast of the colony's projects (what `industryForecast` returns, or { gaps }), null while it is still running, only read when a project changes the workers; `modifiers` its production modifiers row.
export const committedWorkforce = ({ colony, workersNow, cost, projection, needs, forecast, modifiers, npr = false }) => {
  const gaps = [...needs.missing]

  if (needs.installation.length) {
    if (!forecast) {
      gaps.push('the queue forecast (still running)')
    } else if (forecast.gaps) {
      gaps.push(...forecast.gaps)
    }
  }

  if (npr && (needs.installation.length || needs.yards.length)) {
    gaps.push(NPR_GAP)
  }

  if (gaps.length) {
    return unavailable({ rule: RULE, missing: unique(gaps) })
  }

  return combine({
    rule: RULE,
    parts: { workersNow, cost, projection },
    inputs: { present: ['the colony\'s queue and shipyard activities'] },
    compute: ({ cost: value, projection: later }) => {
      const months = later.series.length - 1
      const events = workforceEvents({ needs, forecast, modifiers, months })
      const [low, high] = requiredSeries(events, colony.InstallationWorkers + colony.YardWorkers, months)
      const splits = (required) => later.series.map((population, month) => workerSplit(colony, population, value, required[month]))
      const best = splits(low)
      const worst = splits(high)
      const free = { best: best.map((split) => split.free), worst: worst.map((split) => split.free) }

      return { months, events, required: { low, high }, free, later: { best: best[months], worst: worst[months] }, firstShort: { best: firstShort(free.best), worst: firstShort(free.worst) }, recovery: { best: recoveryOf(free.best), worst: recoveryOf(free.worst), worstAfterBest: recoveryAfter(free.worst, firstShort(free.best)) } }
    },
  })
}

// The horizon split of a committed result, the `best` or the `worst` case, as a result shaped like the Outlook's own (`workersLater`): the figures its tiles and flags read.
export const committedSplitResult = (committed, which) => combine({ rule: RULE, parts: { committed }, compute: ({ committed: value }) => value.later[which] })
