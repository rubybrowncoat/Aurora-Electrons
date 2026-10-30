// The share of a colony's construction capacity that builds a ship class's manufactured components by a deadline (the Production page's component calculator). Pure functions on plain rows in and out. The components a class mounts are taken from the colony's own stock once, what is left is built by component projects, which draw on the colony's construction capacity like any other construction project and on the stock of minerals it shares with its other projects; the date a batch of projects finishes comes from the production cycle forecast (production.js, which runs industry-cycle.js) with the batch added to the colony's own projects, so a share held by running work, the order of the queue and a stock a project is held up by all count as the forecast counts them, and nothing of the cycle is worked out again here.

import { categoryOf, industryForecastSteps, prepareForecast } from './production'
import { MINERALS } from './minerals'
import { TERMINATION, UNPACED } from './search-run'
import { isAvailable, registerRule } from './provenance'

registerRule({
  id: 'production.componentPlan',
  versions: ['2.7.x'],
  units: 'share of the construction capacity',
  verification: 'estimated',
  structure: ['FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.Cost and the mineral columns', 'FCT_PopComponent.Amount', 'FCT_IndustrialProjects.Queue, Percentage, ProductionType', 'production.populationCapacity', 'the production cycle forecast'],
  note: 'The share of a colony\'s construction capacity a batch of component projects needs to finish by a deadline, and the share the colony can still give: what its projects out of the queue (running or paused) do not hold, which is the rule the game queues a new project by. The components in stock at the colony are used once, each against its own count; the rest is built by one project for each component, the share split by build points (a divisor method, so a larger share never gives a project less) so they finish together. A class mounts armour and missile engines that no component project builds, parts of a civilian line, prototypes and components the race has not researched or has set obsolete; those are built with the hull by the shipyard and are not in the share. The date comes from the cycle forecast with the batch added. A share above the one free is run with the colony\'s other projects releasing the difference, paused ones first and then the others, the newest first. The least share is established only where the colony\'s stock covers all that its projects and the batch could take; where minerals are contested a larger share can miss a deadline a smaller one meets, so the share is found by a search of the grid and a smaller one may exist.',
  assumptions: ['The batch starts at once, each project at its own share, and the shares do not change while it builds', 'The components are built where they are used; stock at other colonies is not counted'],
})

// The component types no component project builds: armour and missile engines are part of the hull and the missile.
const COMPONENT_ARMOUR = 11
const COMPONENT_MISSILE_ENGINE = 56
const BUILT_WITH_THE_HULL = new Set([COMPONENT_ARMOUR, COMPONENT_MISSILE_ENGINE])

// The projects of a batch have IDs a save's projects never have.
export const BATCH_ID_BASE = 2 ** 31

// A share is given to a hundredth of a percent, which is what the game shows of one.
const SHARE_STEP = 100
const EPSILON = 1e-9
const SECONDS_PER_DAY = 86400
// The whole of a colony's capacity, in hundredths of a percent.
const WHOLE_CAPACITY = 100 * SHARE_STEP
// The game rounds the units a cycle builds to 4 decimals: a build is at most this much above the exact one.
const BUILD_ROUNDING = 0.00005
// What a bound is relaxed by so that a float's last place never makes it exceed the true one, in hundredths of a percent.
const ROUNDING_SLACK = 1e-6
// How many steps the share is swept in where the colony's minerals are contested and the range is too wide to scan, which the bisection cannot be trusted to find the least of.
const SWEEP_PROBES = 16
// The widest range, in hundredths of a percent, scanned a share at a time where the colony's minerals are contested: the least share that meets the deadline is then found, not a sparse sample of them.
const SCAN_LIMIT = 400

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// Whether a component project can build a class's component, with the reason when it cannot, or what the save leaves out of the answer. `part`: { typeId, prototype, shippingLine, researched, obsolete }.
export const buildableOf = (part) => {
  if (!isNumber(part.typeId)) {
    return { buildable: null, missing: ['the component\'s type'] }
  }

  if (BUILT_WITH_THE_HULL.has(part.typeId)) {
    return { buildable: false, why: part.typeId === COMPONENT_ARMOUR ? 'armour is built with the hull' : 'a missile engine is built with its missile' }
  }

  const missing = [['prototype', 'whether the component is a prototype'], ['shippingLine', 'whether the component is a civilian line\'s'], ['researched', 'whether the race has researched the component']].filter(([key]) => part[key] === null || part[key] === undefined).map(([, text]) => text)

  if (part.shippingLine === 1) {
    return { buildable: false, why: 'a civilian line\'s component is not built by a colony' }
  }

  if (part.prototype === 1) {
    return { buildable: false, why: 'a prototype is built with its hull' }
  }

  if (part.researched === 0) {
    return { buildable: false, why: 'the race has not researched it' }
  }

  if (part.researched === 1 && part.obsolete === 1) {
    return { buildable: false, why: 'the race has set it obsolete' }
  }

  if (part.researched === 1 && part.obsolete !== 0) {
    missing.push('whether the race has set the component obsolete')
  }

  return missing.length ? { buildable: null, missing } : { buildable: true }
}

// The units of a component a colony holds: none for a component with no row (the game keeps a row only for what a colony holds), null where a row is there and its amount is not known.
const stockOf = (stock, componentId) => {
  if (!stock || !Object.prototype.hasOwnProperty.call(stock, componentId)) {
    return 0
  }

  return isNumber(stock[componentId]) ? Math.max(0, stock[componentId]) : null
}

// What a batch of `hulls` ships of a class needs of each component, the stock used once and what is left to build. `parts`: the class's components, [{ componentId, name, typeId, count (a hull mounts), cost, minerals: { [mineral]: tonnes a unit }, prototype, shippingLine, researched, obsolete }]; `stock`: { [componentId]: units held at the colony } (a component with no entry is none held: the game keeps a row only for what a colony holds). A hull takes from the stock of each component no more than the hulls need of it, once: the stock of a component is held against all the hulls together, never against each. Returns { rows, units, bp, yardBP, stockBP, neededBP, unknown } with `rows` for every component: { componentId, name, typeId, perHull, needed, held, used, remaining, units (whole units a project builds, 0 for a component no project builds), surplus, cost, bp, buildable, why, missing }; `bp` the build points of the projects, `yardBP` the build points of the remainder that is built with the hull, `stockBP` the stock's share of the class, `neededBP` all of it; `unknown` lists what the save leaves out of a figure, null for none.
export const requirements = ({ parts, hulls, stock }) => {
  const missing = new Set()

  if (!isNumber(hulls) || hulls <= 0) {
    return { invalid: 'the number of hulls' }
  }

  const rows = parts.map((part) => {
    const buildability = buildableOf(part)
    const needed = isNumber(part.count) ? part.count * hulls : null
    const held = stockOf(stock, part.componentId)
    const used = needed === null || held === null ? null : Math.min(held, needed)
    const remaining = needed === null || used === null ? null : needed - used
    const row = { componentId: part.componentId, name: part.name, typeId: part.typeId, perHull: part.count, needed, held, used, remaining, cost: isNumber(part.cost) ? part.cost : null, minerals: part.minerals || {}, buildable: buildability.buildable, why: buildability.why || '', missing: buildability.missing || [] }

    if (needed === null) {
      missing.add(`how many ${part.name} a hull mounts`)
    }

    if (row.cost === null) {
      missing.add(`the cost of ${part.name}`)
    }

    row.missing.forEach((text) => missing.add(`${text} (${part.name})`))

    if (held === null) {
      missing.add(`the stock of ${part.name} at the colony`)
    }

    const units = buildability.buildable === true ? (remaining === null ? null : Math.max(0, Math.ceil(remaining - EPSILON))) : 0

    return { ...row, units, surplus: units === null ? null : units > 0 ? units - remaining : 0, bp: units === null || row.cost === null ? null : units * row.cost }
  })

  const sum = (list, value) => list.reduce((total, row) => total + value(row), 0)
  const costed = rows.filter((row) => row.cost !== null && row.needed !== null && row.held !== null)
  const yard = costed.filter((row) => row.buildable === false)

  return {
    rows,
    units: sum(rows.filter((row) => row.units !== null), (row) => row.units),
    bp: sum(rows.filter((row) => row.bp !== null), (row) => row.bp),
    yardBP: sum(yard, (row) => row.remaining * row.cost),
    stockBP: sum(costed, (row) => row.used * row.cost),
    neededBP: sum(costed, (row) => row.needed * row.cost),
    unknown: missing.size ? [...missing] : null,
  }
}

// What the page reads of a save shaped for the calculator: `classes` (the race's ship classes), `parts` (a row for each component of each class with its type, cost and minerals and the race's research of it), `stock` (a row for each component a colony holds) and `populations` (a row for each colony with the stock of each mineral). Returns { classes: [{ id, name, obsolete }], parts: { [classId]: [part] }, stock: { [populationId]: { [componentId]: units } }, minerals: { [populationId]: { [mineral]: tonnes } } }. A colony's component stock is a row only while it holds some, so no row is none held; a component with no row of the race's research is not researched, except for a spied empire, whose research the save does not show (`npr`), where it is not known.
export const sourcesOf = ({ classes, parts, stock, populations, npr = false }) => {
  const byClass = {}
  const byColony = {}
  const minerals = {}

  parts.forEach((row) => {
    ;(byClass[row.ClassID] = byClass[row.ClassID] || []).push({
      componentId: row.ComponentID,
      name: row.Name,
      typeId: row.ComponentTypeID,
      count: row.NumComponent,
      cost: row.Cost,
      prototype: row.Prototype,
      shippingLine: row.ShippingLineSystem,
      researched: row.ResearchedTech === null || row.ResearchedTech === undefined ? (npr ? null : 0) : 1,
      obsolete: row.TechObsolete === undefined ? null : row.TechObsolete,
      minerals: Object.fromEntries(MINERALS.map((mineral) => [mineral.name, isNumber(row[mineral.name]) ? row[mineral.name] : null])),
    })
  })

  stock.forEach((row) => {
    ;(byColony[row.PopulationID] = byColony[row.PopulationID] || {})[row.ComponentID] = isNumber(row.Amount) ? row.Amount : null
  })

  populations.forEach((row) => {
    minerals[row.PopulationID] = Object.fromEntries(MINERALS.map((mineral) => [mineral.name, isNumber(row[mineral.name]) ? row[mineral.name] : null]))
  })

  return { classes: classes.map((row) => ({ id: row.ShipClassID, name: row.ClassName, obsolete: row.Obsolete === 1 })), parts: byClass, stock: byColony, minerals }
}

// A colony's component stock with the figures entered by hand over it: `edits` is { [componentId]: text or number }; a figure that is not a number of 0 or more is not used and its component is listed in `invalid`, so the stock stays what the save holds. Returns { stock, invalid }.
export const stockWith = (base, edits) => {
  const stock = { ...base }
  const invalid = []

  Object.entries(edits).forEach(([componentId, entered]) => {
    const value = typeof entered === 'string' ? (entered.trim() === '' ? NaN : Number(entered)) : entered

    if (isNumber(value) && value >= 0) {
      stock[componentId] = value
    } else {
      invalid.push(Number(componentId))
    }
  })

  return { stock, invalid }
}

// The share of a colony's construction capacity its projects out of the queue hold, paused ones too: what the game checks before it puts a new project of the category in the queue (the capacity left of 100% must hold the project's share). `projects`: the colony's industrial projects, the rows the page reads. Returns { held, missing }, `missing` naming what the save leaves out of a project that may hold a share.
export const heldShare = (projects) => {
  const missing = new Set()
  let held = 0

  projects.forEach((project) => {
    const category = categoryOf(project.ProductionType)

    if (category === 'unknown') {
      missing.add('the production type of a project')
    } else if (category === 'construction') {
      if (!isNumber(project.Queue)) {
        missing.add('whether a project is queued')
      } else if (project.Queue === 0) {
        if (isNumber(project.Percentage)) {
          held += project.Percentage
        } else {
          missing.add('a project\'s share of the capacity')
        }
      }
    }
  })

  return { held, missing: [...missing] }
}

// The cycles of a colony's production, in days; null when the colony's modifiers do not give the game's construction period.
const cycleDaysOf = (colony) => (colony.modifiers && isNumber(colony.modifiers.MinConstructionPeriod) && colony.modifiers.MinConstructionPeriod > 0 ? colony.modifiers.MinConstructionPeriod / SECONDS_PER_DAY : null)

// The least hundredths of a percent of the capacity a project of `row.units` units at `row.cost` build points a unit can hold and still be done in `cycles` cycles of `cycleDays` days: each cycle builds at most the exact build plus the half of the last place the game rounds a build to, and at least one hundredth. This is a bound no run of the forecast can go under, which the plain division of the build points by the capacity and the time is not: rounding a small build up to 4 decimals makes a slow project faster than it.
const floorOf = (row, capacity, cycles, cycleDays) => {
  const perCycle = row.units / cycles - BUILD_ROUNDING

  if (perCycle <= 0) {
    return 1
  }

  const share = perCycle * row.cost / (capacity * cycleDays / 365) * 100

  return Math.max(1, Math.ceil(share * SHARE_STEP - ROUNDING_SLACK))
}

// `total` hundredths of a percent split among projects in proportion to their build points, each project at least one hundredth and the parts adding up to the total exactly; null when there are fewer hundredths than projects. The hundredths above the first one each take are given one at a time to the project with the most build points a hundredth already held (a divisor method, Webster's), so a larger total never gives a project fewer hundredths: the split of a total is inside the split of every larger one. A split by the largest remainders does not keep this, and with minerals shared a project's hundredth lost to a larger total can stall the batch.
export const allocateShare = (total, weights) => {
  if (total < weights.length) {
    return null
  }

  const sum = weights.reduce((all, weight) => all + weight, 0)
  const shares = weights.map((weight) => (sum > 0 ? weight : 1))
  const parts = weights.map(() => 1)

  for (let seat = weights.length; seat < total; seat++) {
    let best = 0

    for (let index = 1; index < parts.length; index++) {
      if (shares[index] * (2 * parts[best] - 1) > shares[best] * (2 * parts[index] - 1)) {
        best = index
      }
    }

    parts[best] += 1
  }

  return parts
}

// The component projects of a batch as the rows the page reads industrial projects as, out of the queue and not paused: a component project is a construction project that builds `units` of the component for its cost a unit from the minerals its cost columns name. `minerals`: the colony's stock of each mineral, as the page's rows carry it (`Stock<Mineral>`).
const batchRows = (rows, hundredths, colony) => rows.map((row, index) => ({
  ID: BATCH_ID_BASE + index,
  ProductionType: 3,
  PopulationID: colony.populationId,
  Name: row.name,
  Percentage: hundredths[index] / SHARE_STEP,
  Amount: row.units,
  PartialCompletion: 0,
  ProdPerUnit: row.cost,
  Queue: 0,
  Paused: 0,
  FuelRequired: 0,
  ...Object.fromEntries(MINERALS.map((mineral) => [mineral.name, isNumber(row.minerals[mineral.name]) ? row.minerals[mineral.name] : null])),
  ...Object.fromEntries(MINERALS.map((mineral) => [`Stock${mineral.name}`, colony.minerals ? colony.minerals[mineral.name] : null])),
  StockFuel: colony.minerals ? colony.minerals.Fuel : null,
  ConversionFrom: null,
  ConversionSource: null,
}))

// The cycle forecast of a colony's projects with the batch (none for an empty list) added, a generator that yields where the `pace` says the time is up and returns { gaps } for what the save leaves out, or { figures: { [ID]: the engine's figures of the project }, orders }.
function* forecastWith(colony, batch, pace) {
  const projects = [...colony.projects, ...batch]

  if (!projects.length) {
    return { figures: {}, orders: null }
  }

  const prepared = prepareForecast({ projects, capacities: colony.capacities, modifiers: colony.modifiers, arrivals: colony.arrivals || [], npr: colony.npr })
  const forecast = yield * industryForecastSteps(prepared, pace)

  if (forecast.gaps) {
    return { gaps: forecast.gaps }
  }

  return { figures: Object.fromEntries(forecast.figures.map((figure) => [figure.forecast.ID, figure])), orders: forecast.orders }
}

// How a batch of projects at the given hundredths of a percent of the capacity fares against the deadline in the forecast: { meets (every project finishes by the deadline in every order tried: the worst order's finish of the batch is the latest of the projects' latest dates, so this is exact), earliest (the latest of the projects' own earliest dates: no order finishes the batch sooner, though different orders give the projects' earliest dates, so a bound), earliestExact (every project finishes on one date in every order), latest (when the last project finishes in the worst order, null where some order never finishes one), sampled (the orders could not all be tried), held: the first mineral a project is held up by, or null, run, batch }.
function* evaluate(plan, colony, hundredths, deadline, pace) {
  const batch = batchRows(plan.rows, hundredths, colony)
  const run = yield * forecastWith(colony, batch, pace)

  if (run.gaps) {
    return { gaps: run.gaps }
  }

  const figures = batch.map((row) => run.figures[row.ID].forecast)
  const everyEarliest = figures.every((figure) => figure.earliest !== null)
  const everyLatest = figures.every((figure) => figure.latest !== null)
  const stalled = figures.find((figure) => figure.outcome === 'stalls' && figure.stall && figure.stall.resource)
  const last = (key) => Math.max(...figures.map((figure) => figure[key]))

  return {
    meets: everyLatest && last('latest') <= deadline + EPSILON,
    earliest: everyEarliest ? last('earliest') : null,
    earliestExact: everyEarliest && figures.every((figure) => figure.earliest === figure.latest),
    latest: everyLatest ? last('latest') : null,
    sampled: Boolean(run.orders) && !run.orders.exhaustive,
    held: stalled ? { name: stalled.stall.resource, componentName: batch[figures.indexOf(stalled)].Name } : null,
    run,
    batch,
  }
}

// The projects of a batch at a share, for the page: { componentId, name, units, bp, share }.
const allocationOf = (plan, hundredths) => plan.rows.map((row, index) => ({ componentId: row.componentId, name: row.name, units: row.units, bp: row.bp, share: hundredths[index] / SHARE_STEP }))

// What adding the batch does to the colony's own projects: each whose finish moves in the forecast, as { id, name, before, after } with the days (null where the project never finishes).
const displacedBy = (colony, base, run) => colony.projects.map((project) => {
  const before = base.figures[project.ID].forecast
  const after = run.figures[project.ID].forecast
  const moved = before.outcome !== after.outcome || before.earliest !== after.earliest || before.latest !== after.latest || before.start !== after.start

  return moved ? { id: project.ID, name: project.Name, before: before.latest !== null ? before.latest : before.earliest, after: after.latest !== null ? after.latest : after.earliest } : null
}).filter(Boolean)

// The projects of the colony out of the queue that hold a share of the construction capacity, in the order a release of `hundredths` of it takes them: paused ones first (they build nothing, so releasing them moves no work), then the others, the newest project (the highest ID) first. The game gives no order for this, so the order is the plan's own and the plan names it. Returns { projects (the colony's with those shares reduced), released: [{ id, name, paused, from, to }] } in percent of the capacity.
export const redistribution = (projects, hundredths) => {
  if (!(hundredths > EPSILON)) {
    return { projects, released: [] }
  }

  const holders = projects.filter((project) => categoryOf(project.ProductionType) === 'construction' && project.Queue === 0 && isNumber(project.Percentage) && project.Percentage > 0)
  const order = [...holders].sort((a, b) => Number(b.Paused === 1) - Number(a.Paused === 1) || b.ID - a.ID)
  const shares = new Map()
  const released = []
  let left = hundredths

  order.forEach((project) => {
    if (left <= EPSILON) {
      return
    }

    const held = project.Percentage * SHARE_STEP
    const taken = Math.min(left, held)
    const to = taken >= held - ROUNDING_SLACK ? 0 : (held - taken) / SHARE_STEP

    left -= taken
    shares.set(project.ID, to)
    released.push({ id: project.ID, name: project.Name, paused: project.Paused === 1, from: project.Percentage, to })
  })

  return { projects: projects.map((project) => (shares.has(project.ID) ? { ...project, Percentage: shares.get(project.ID) } : project)), released }
}

// Whether no mineral the colony's projects and the batch draw on can run short in the forecast: the stock the forecast starts from covers everything the colony's projects and the batch could take, so no project is ever held up by another and a project of the batch finishes when its own share says, whatever the other projects hold. Then the deadline is met at a share only if it is met at every larger one, which is what lets a bisection find the least. Unknown (a figure the save lacks) is not uncontested. The stock is the one the forecast reads: that of the colony's first project, or of the batch where the colony has none.
const uncontested = (colony, rows) => {
  const names = [...MINERALS.map((mineral) => mineral.name), 'Fuel']
  const stockOfRow = (name) => {
    const value = colony.projects.length ? colony.projects[0][name === 'Fuel' ? 'StockFuel' : `Stock${name}`] : colony.minerals ? colony.minerals[name] : null

    return isNumber(value) ? value : 0
  }

  return names.every((name) => {
    const needs = [
      ...colony.projects.map((project) => [project.Amount, name === 'Fuel' ? project.FuelRequired : project[name]]),
      ...rows.map((row) => [row.units, name === 'Fuel' ? 0 : row.minerals[name]]),
    ]

    return needs.every(([units, each]) => isNumber(units) && isNumber(each)) && needs.reduce((all, [units, each]) => all + (units + BUILD_ROUNDING) * each, 0) <= stockOfRow(name)
  })
}

// Whether the batch alone needs more of some mineral than the colony's stock holds, so that with nothing arriving no share of the capacity finishes it, whatever the colony's other projects do: they only take from the stock. A build counts its units less the rounding of a build to 4 decimals in its favour, and a stock the save leaves out is not known to be short.
const batchShort = (colony, rows) => {
  const stock = colony.projects.length ? colony.projects[0] : null

  return MINERALS.some((mineral) => {
    const held = stock ? stock[`Stock${mineral.name}`] : colony.minerals ? colony.minerals[mineral.name] : null
    const needed = rows.reduce((all, row) => all + Math.max(0, row.units - BUILD_ROUNDING) * row.minerals[mineral.name], 0)

    return isNumber(held) && needed > held + EPSILON
  })
}

// The calculator: `input` is { parts, hulls, stock, deadline (days from now), colony: { populationId, projects (the colony's industrial projects as the page reads them), capacities ({ construction, ordnance, fighter } production.populationCapacity results), modifiers, arrivals, npr, minerals ({ [mineral]: tonnes, Fuel }) } }, a generator that yields where the `pace` says the time is up and returns:
// { status, requirements, deadline, floorShare, capacity, held (the share the colony's projects out of the queue hold), available, required, requiredExact, unreachable, shortfall, allocation, finish, stalled (the mineral that holds the batch up), displaced, gaps, why }
// `status`: 'covered' (the stock holds every component a project would build), 'feasible' (a share the colony can give finishes the batch by the deadline), 'infeasible' (none does: every share the colony can give was tried, or the search was not needed, and none finishes the batch), 'searchLimited' (the colony's minerals are contested, the range of shares the colony can give is too wide to try a share at a time, and none of the shares tried finishes the batch: one not tried may, so nothing is claimed of the colony's capacity, and `shortfall` is null), 'unknown' (the save leaves out a figure the answer rests on, named in `gaps`). `floorShare` is what no schedule can go below: each project builds at most its share of the capacity over the cycles up to the deadline, with the game's rounding of a build to 4 decimals counted in its favour, and holds at least one hundredth of a percent. `required` is the least share, to a hundredth of a percent, that the forecast finishes the batch by the deadline with (`requiredExact` true); where the colony cannot give it, it is the share the colony's other projects would have to leave free (a share of up to the whole capacity), and `shortfall` is the share and the build points a year the colony lacks. Where even the whole capacity is not enough, `required` is null and `unreachable` true (and `stalled` names a mineral the stock runs out of), except where `floorShare` alone passes the whole capacity: `required` is then `floorShare` with `requiredExact` false, a least and not the share found. Where status is 'searchLimited', `required` and `release` are a share found above the share free, by the same search, and a smaller one may do it. `finish` is the batch at the share the colony can give: `latest` is when the last project finishes in the worst order of the colony's projects, exact; `earliest` is no earlier than any order can finish the batch (the latest of the projects' own earliest dates, which different orders give), a bound unless `earliestExact`.
// More of the plan: `requiredKind` ('exact': the least share, established, by a bisection where the colony's minerals are not contested and by trying every hundredth from the floor up where they are and the range is narrow enough; 'found': a share the forecast finishes the batch with, found by a sweep of the shares where the colony's minerals are contested, so a smaller one may exist; 'floor': the floor above the whole capacity), `contested` (the minerals the colony's projects and the batch share could run short, so the deadline can be met at a share and missed at a larger one), `release` (where `required` is above the share free: the shares the colony's other projects out of the queue are taken to release, [{ id, name, paused, from, to }], paused ones first and then the others, the newest project first, the order in which the forecast was run), `settled` (true only where the share search up to the whole capacity was complete or the batch is proved impossible: every share was tried or bisected, the colony has no capacity, the deadline is before the first cycle, or a mineral is short with nothing arriving; false for an 'unknown' plan, a 'found' share, a 'searchLimited' plan and an unreachable or infeasible one whose search above the share free was a sweep) and, where status is 'infeasible' or 'searchLimited' and `unreachable` is true, that no share tried finished the batch (every share where the minerals are not contested; the shares probed where they are and the range was wide).
export function* planSteps(input, pace) {
  const { parts, hulls, stock, deadline, colony } = input
  const needs = requirements({ parts, hulls, stock })

  if (needs.invalid) {
    return { status: 'unknown', gaps: [needs.invalid], requirements: null }
  }

  const result = { status: 'unknown', requirements: needs, deadline, floorShare: null, capacity: null, held: null, available: null, required: null, requiredExact: false, requiredKind: null, contested: false, settled: false, release: [], unreachable: false, shortfall: null, allocation: [], finish: null, stalled: null, displaced: [], gaps: [], why: [] }

  if (needs.unknown) {
    return { ...result, gaps: needs.unknown }
  }

  const rows = needs.rows.filter((row) => row.units > 0)

  if (!rows.length) {
    return { ...result, status: 'covered', required: 0, requiredExact: true }
  }

  if (!isNumber(deadline) || !(deadline > 0)) {
    return { ...result, gaps: ['a deadline after today'] }
  }

  const capacity = colony.capacities.construction

  if (!isAvailable(capacity) || !isNumber(capacity.value)) {
    return { ...result, gaps: capacity && capacity.inputs && capacity.inputs.missing.length ? capacity.inputs.missing : ['the colony\'s construction capacity'] }
  }

  result.capacity = capacity.value

  const plan = { rows }
  const { held, missing } = heldShare(colony.projects)

  if (missing.length) {
    return { ...result, gaps: missing }
  }

  result.held = held
  result.available = Math.max(0, 100 - held)

  if (!(capacity.value > 0)) {
    return { ...result, status: 'infeasible', unreachable: true, settled: true, why: ['the colony has no construction capacity'] }
  }

  const weights = rows.map((row) => row.bp)
  const ceiling = Math.floor(result.available * SHARE_STEP + EPSILON)
  const cycleDays = cycleDaysOf(colony)
  const cycles = cycleDays === null ? null : Math.floor(deadline / cycleDays + EPSILON)

  if (cycles !== null && cycles < 1) {
    return { ...result, status: 'infeasible', unreachable: true, settled: true, why: [`the deadline is before the end of the colony's first production cycle (${cycleDays.toFixed(2)} days)`] }
  }

  const lower = cycles === null ? rows.length : rows.reduce((all, row) => all + floorOf(row, capacity.value, cycles, cycleDays), 0)
  const evaluations = new Map()

  result.floorShare = lower / SHARE_STEP
  result.contested = !uncontested(colony, rows)

  // A share above the one free is one the colony's other projects out of the queue release: the batch is run against the colony with those shares released in the order `redistribution` gives, a state the game could be in, so what the run says is what freeing that share does.
  const at = function* (hundredths) {
    if (!evaluations.has(hundredths)) {
      const parts = allocateShare(hundredths, weights)
      const legal = redistribution(colony.projects, hundredths - ceiling)
      const state = legal.released.length ? { ...colony, projects: legal.projects } : colony

      evaluations.set(hundredths, parts ? { parts, release: legal.released, ...(yield * evaluate(plan, state, parts, deadline, pace)) } : { parts: null, release: [], meets: false, earliest: null, latest: null, earliestExact: false, sampled: false, held: null })
    }

    return evaluations.get(hundredths)
  }

  // The batch needs more of a mineral than the colony's stock holds and nothing arrives, so no share finishes it: a proof only where the forecast runs on that stock (the run at the whole capacity says whether it does), so a colony the save leaves a figure of out (a spied empire's, whose forecast reads the capital's stock) is unknown and never proved.
  const shortProof = result.contested && !(colony.arrivals && colony.arrivals.length) && batchShort(colony, rows)
  const probed = shortProof ? yield * at(WHOLE_CAPACITY) : null

  if (probed && probed.gaps) {
    return { ...result, gaps: probed.gaps }
  }

  const hopeless = shortProof

  const finishOf = (evaluation) => (evaluation.earliest !== null || evaluation.latest !== null ? { earliest: evaluation.earliest, latest: evaluation.latest, earliestExact: evaluation.earliestExact, sampled: evaluation.sampled } : null)

  // The least of the shares from `from` to `to` (hundredths of a percent) that finishes the batch by the deadline, `to` being one that does. Only a bisection: it finds the least where each share that meets the deadline has every larger one meet it too.
  const least = function* (from, to) {
    let low = from
    let high = to

    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const tried = yield * at(middle)

      if (tried.meets) {
        high = middle
      } else {
        low = middle + 1
      }
    }

    return high
  }

  // A share from `from` to `to` that finishes the batch by the deadline: { found (the least the search reached, or null where none was met), complete (whether `found` is the least of the shares from `from` to `to` and, where none was met, whether none does), gaps }. Where the colony's minerals are not contested a share that meets the deadline is met by every larger one, so `to` alone is tried and then bisected for the least. Where they are, a larger share can miss what a smaller one meets: a range of at most `SCAN_LIMIT` hundredths is scanned upward from `from` to the first share that meets it, which is the least, and a wider one is swept in `SWEEP_PROBES` steps to the first probe that meets it with only the stretch before that probe bisected, so the share found meets the deadline and a smaller one may exist, and where no probe meets it a share between the probes may. Where the batch needs more of a mineral than the colony holds and none arrives, no share does, and nothing is tried.
  const first = function* (from, to) {
    if (from > to || hopeless) {
      return { found: null, gaps: null, complete: true }
    }

    const scanned = result.contested && to - from < SCAN_LIMIT
    const complete = !result.contested || scanned
    const probes = scanned ? Array.from({ length: to - from + 1 }, (_, index) => from + index) : result.contested ? Array.from({ length: SWEEP_PROBES + 1 }, (_, index) => Math.round(from + ((to - from) * index) / SWEEP_PROBES)).filter((point, index, list) => index === 0 || point > list[index - 1]) : [to]
    let previous = from - 1

    for (const point of probes) {
      const tried = yield * at(point)

      if (tried.gaps) {
        return { found: null, gaps: tried.gaps, complete }
      } else if (tried.meets) {
        return { found: yield * least(previous + 1, point), gaps: null, complete }
      }

      previous = point
    }

    return { found: null, gaps: null, complete }
  }

  const free = ceiling >= rows.length ? yield * at(ceiling) : null

  if (free && free.gaps) {
    return { ...result, gaps: free.gaps }
  }

  const within = free ? yield * first(Math.min(lower, ceiling), ceiling) : { found: null, gaps: null, complete: true }

  if (within.gaps) {
    return { ...result, gaps: within.gaps }
  }

  if (within.found !== null) {
    const chosen = yield * at(within.found)
    const base = yield * forecastWith(colony, [], pace)

    result.status = 'feasible'
    result.required = chosen.parts.reduce((all, part) => all + part, 0) / SHARE_STEP
    result.requiredExact = within.complete
    result.requiredKind = within.complete ? 'exact' : 'found'
    result.settled = result.requiredKind === 'exact'
    result.finish = finishOf(chosen)
    result.allocation = allocationOf(plan, chosen.parts)
    result.displaced = base.gaps ? [] : displacedBy(colony, base, chosen.run)

    return result
  }

  result.status = within.complete ? 'infeasible' : 'searchLimited'
  result.settled = within.complete

  if (free) {
    result.finish = finishOf(free)
    result.allocation = allocationOf(plan, free.parts)
  }

  if (lower > WHOLE_CAPACITY) {
    result.required = result.floorShare
    result.requiredKind = 'floor'
    result.why = [`the batch needs at least ${result.floorShare.toFixed(2)}% of the capacity, more than all of it`]
  } else {
    const beyond = yield * first(Math.max(lower, ceiling + 1), WHOLE_CAPACITY)

    if (beyond.gaps) {
      return { ...result, status: 'unknown', settled: false, finish: null, allocation: [], gaps: beyond.gaps }
    }

    result.settled = result.settled && beyond.complete

    if (beyond.found !== null) {
      const chosen = yield * at(beyond.found)
      const exact = beyond.complete && result.status === 'infeasible'

      result.required = beyond.found / SHARE_STEP
      result.requiredExact = exact
      result.requiredKind = exact ? 'exact' : 'found'
      result.release = chosen.release
      result.why = [result.status === 'infeasible' ? `the batch needs ${result.required.toFixed(2)}% of the capacity and ${result.available.toFixed(2)}% is free` : `no share tested within the ${result.available.toFixed(2)}% free finishes the batch by the deadline, and a share that was not tested may`]
    } else {
      const whole = yield * at(WHOLE_CAPACITY)
      const stalled = whole.held || (free && free.held)

      result.unreachable = true
      result.stalled = stalled || null
      result.why = [stalled ? `the colony's stock of ${stalled.name} runs out before ${stalled.componentName} is built` : whole.earliest !== null && whole.earliest <= deadline ? 'the order the game takes the colony\'s projects in decides whether it is in time, even with the whole capacity' : 'the cycles of the forecast finish it after the deadline even with the whole capacity']
    }
  }

  if (result.status === 'searchLimited') {
    return result
  }

  if (result.required !== null) {
    const lacking = result.required - result.available

    result.shortfall = { share: lacking, bpPerYear: lacking / 100 * capacity.value }
  }

  return result
}

// The same calculation run to its end at once.
export const planComponents = (input) => {
  const steps = planSteps(input, UNPACED)
  let step = steps.next()

  while (!step.done) {
    step = steps.next()
  }

  return step.value
}

// The counts of a run of one calculation, in the shape of the search runner's.
const runCounts = (done) => ({ total: 1, evaluated: done, pruned: 0, unexplored: 1 - done, feasible: done, retained: done, prunedBy: {} })

// The calculation as the search of one run (`utilities/search-run.js`), yielding wherever the `pace` says the time is up and returning { counts, termination, plan }.
export function* planRun(input, pace) {
  const state = () => ({ progress: 0, counts: runCounts(0), snapshot: () => ({ counts: runCounts(0), plan: null }) })
  const steps = planSteps(input, pace)
  let step = steps.next()

  while (!step.done) {
    yield state()
    step = steps.next()
  }

  return { counts: runCounts(1), termination: TERMINATION.EXHAUSTED, plan: step.value }
}
