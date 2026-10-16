// How many people a colony can give up as colonists before it cannot staff its own industry or falls below a floor the player sets, as the Colony Outlook's panel shows it. Everything here is in millions of people and rests on the Outlook's own worker split (`workerSplit`, rule 'colonies.workers'): the services and the agriculture the population needs are taken first, the rest can work, and the colony is short when the installations and shipyards need more workers than that. The helpers take plain rows and results and return provenance results (utilities/provenance.js).
//
// Three things stay apart. The current view reads only the colony as it is today: the installations and shipyards standing now, the population now, the colony cost. The committed view is an option that takes the demand of the queue from the Outlook's committed workforce result and never changes the current figures. The emigrant pool is a limit on shipping-line pickups only; a fleet of the race loads the residents themselves. A pickup that is yet to happen (a company ship that has not been bought, the pool after loads already queued, the pressure at the next refresh) is not forecast: its result is unavailable whatever the inputs are.
//
// A blank floor or batch is not known, never 0. A floor or batch that is not a number of at least 0 is refused. A colony the read has no row for, or a stored field that is null, is unknown.

import { WORKER_TOLERANCE, infrastructureCapResult, infrastructureOf, workerSplit } from './colonies'
import { combine, isAvailable, ofRule, registerRule, unavailable } from './provenance'

const VERSIONS = ['2.7.x']

// Workers in millions: a balance this close to zero counts as staffed when the removable population is searched for.
const EPSILON = 1e-9
// Bisection rounds that narrow a monotone stretch of the worker curve to its boundary.
const BISECTIONS = 60
// The population where the services share reaches its 70% cap. Above it the workers rise (or stay flat) as the population does; below it they follow a concave curve (people minus a services share that grows faster than they do), so the populations that keep a fixed need staffed form one stretch.
const SERVICE_CAP_POPULATION = 1000 * 0.7 ** 4

export const COLONIST_ROLES = Object.freeze({ 0: 'destination', 1: 'source', 2: 'stable' })
export const IMPERIAL_STATUS = 1

export const NO_COLONIST_SOURCES = Object.freeze({ rows: Object.freeze([]), problems: Object.freeze([]) })

registerRule({
  id: 'colonistFloor.staffing',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_Population.Population', 'FCT_PopulationInstallations.Amount', 'FCT_Shipyard.Slipways', 'the worker split rule'],
  note: 'The lowest population the colony could be left with that still has as many workers as its installations and shipyards need today, found by taking people away step by step and stopping before the first step that leaves it short. Every population between that lowest one and the current one keeps the colony staffed, so the figure never counts a removal that passes through a shortage. The worker split under it is confirmed against stored efficiency; the search for the limit is not checked against saved data. A colony already short has no room to give.',
  assumptions: ['the installations, shipyards and colony cost stay as they are today', 'the services and agriculture take their share of the people who remain', 'people living aboard Ark ships are not counted as workers'],
})

registerRule({
  id: 'colonistFloor.removable',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the staffing rule', 'the retained floor entered here'],
  note: 'The smaller of two limits: the population above the retained floor the player entered, and the population above the lowest one that keeps the installations staffed. The limit that is smaller is the one that binds; with no floor entered only the staffing limit applies, and a floor that is blank is not 0.',
  assumptions: ['the retained floor is the player\'s own figure, not a game rule'],
})

registerRule({
  id: 'colonistFloor.outcome',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the staffing rule', 'the batch entered here'],
  note: 'What a colony is left with after the selected batch leaves it: the population, the services and agriculture those people need, the workers that remain, the workers the industry needs and the workers it is short, each from the same worker split. The shortage is the workers the industry needs beyond those that remain, never negative; a balance within the Outlook\'s tolerance is not a shortage.',
  assumptions: ['the batch leaves at once and nothing grows back', 'the batch is the selected number of colonists, a figure the player chose'],
})

registerRule({
  id: 'colonistFloor.committed',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the committed workforce rule', 'the staffing rule'],
  note: 'The same limit and shortage as the current view, with the workers needed taken at the horizon of the committed workforce: the lower figure counts only completions the forecast supports, the higher one every completion that could happen. The people are today\'s: no growth to the horizon is credited, so a colony that would grow into the demand still shows the gap.',
  assumptions: ['the colony keeps today\'s population apart from the batch', 'the queue completes as the committed workforce rule says'],
})

registerRule({
  id: 'colonistFloor.source',
  versions: VERSIONS,
  verification: 'estimated',
  structure: ['FCT_Population.ColonistDestination', 'FCT_Population.PoliticalStatus', 'FCT_Population.MilitaryRestrictedColony'],
  note: 'Whether the colony is one civilian shipping lines may take colonists from: it must be marked a source of colonists, be an imperial population and not be restricted to military use. The stored marker is read as 0 a destination, 1 a source and 2 stable, which follows the order of the game\'s own list and the capital of nearly every save examined being marked a source; no save states the meaning, so the reading is not confirmed. A fleet of the race can load the residents of any colony the order reaches, whatever the marker says.',
})

registerRule({
  id: 'colonistFloor.pool',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['FCT_Population.AvailableColonists', 'FCT_Population.ColonizationPressure', 'FCT_Population.Population'],
  note: 'The emigrants the colony holds ready for shipping lines, in millions of people as stored. The pool refills each refresh by the pressure as a percentage of the population per year, and cannot rise above that share of the population; the share the batch leaves behind is shown as the ceiling the pool could refill to. The pressure is recomputed from conditions at a refresh, so neither the pool nor the ceiling is a forecast.',
  assumptions: ['the pool is read as stored, in millions of people'],
})

registerRule({
  id: 'colonistFloor.civilian',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the source rule', 'the pool rule'],
  note: 'How much of the batch shipping lines could take now: nothing from a colony they may not load from, otherwise the batch up to the emigrants the pool holds. The rest of the batch can leave only in a fleet of the race. Loads already queued for a company ship are not read, so the pool may be larger than what is left for a new pickup.',
  assumptions: ['no shipping-line load is queued against the pool'],
})

registerRule({
  id: 'colonistFloor.futurePickups',
  versions: VERSIONS,
  units: 'M people',
  verification: 'estimated',
  structure: ['the shipping lines\' ships', 'the pool after queued loads'],
  note: 'Which shipping-line ships will call at the colony and how many colonists they will take is not known from the save: it depends on ships not yet built or assigned, on the pool after loads already queued and on the pressure at each refresh. No figure is given.',
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const numberOrNull = (value) => (finite(value) ? value : null)

const flagOrNull = (value) => (value === 0 || value === 1 ? value : null)

// A figure the player typed, in millions of people: { value, state }, `state` 'blank' (nothing typed: not known), 'ok' (a number of at least 0) or 'invalid'.
export const parseAmount = (text) => {
  if (text === null || text === undefined) {
    return { value: null, state: 'blank' }
  }

  const trimmed = typeof text === 'string' ? text.trim() : text

  if (trimmed === '') {
    return { value: null, state: 'blank' }
  }

  const value = typeof trimmed === 'number' ? trimmed : Number(trimmed)

  return finite(value) && value >= 0 ? { value, state: 'ok' } : { value: null, state: 'invalid' }
}

// The populations the downward search takes one stretch at a time: 0, the services cap when it lies below `population`, and `population`. On each stretch the staffed populations are a single interval that reaches the stretch's upper end whenever that end is staffed (the workers only rise above the cap, and the curve below it is concave), so a stretch whose lower end is short has its boundary inside it and nothing narrower than a step can be skipped.
const staffingBreakpoints = ({ population }) => [...new Set([0, ...(SERVICE_CAP_POPULATION < population ? [SERVICE_CAP_POPULATION] : []), population])].sort((a, b) => a - b)

// The lowest population that keeps `required` workers staffed (null when the colony is short today): going down from `population` one stretch at a time, the first stretch whose lower end is short is narrowed by bisection to the last population that is not. 0 when no removal leaves the colony short.
export const staffingMinimum = ({ population, cost, required }) => {
  const staffed = (level) => workerSplit({}, level, cost, required).free >= -EPSILON

  if (!(population >= 0) || !staffed(population)) {
    return null
  }

  const points = staffingBreakpoints({ population })

  for (let at = points.length - 1; at > 0; at -= 1) {
    if (!staffed(points[at - 1])) {
      let low = points[at - 1]
      let high = points[at]

      for (let round = 0; round < BISECTIONS; round += 1) {
        const middle = (low + high) / 2

        if (staffed(middle)) {
          high = middle
        } else {
          low = middle
        }
      }

      return high
    }
  }

  return 0
}

// The two limits on a removal and which one binds: `floor` is the number the player entered (null for none) and `minimum` the staffing minimum (null for a colony short today, which can give nothing). `binding` is 'floor', 'staffing', 'both' or 'none' (nothing binds: the whole population could go).
export const removalLimit = ({ population, floor, minimum }) => {
  const floorLimit = floor === null ? null : Math.max(0, population - floor)
  const staffingLimit = minimum === null ? 0 : Math.max(0, population - minimum)
  const limit = floorLimit === null ? staffingLimit : Math.min(floorLimit, staffingLimit)
  let binding = 'none'

  if (limit < population - EPSILON) {
    if (floorLimit !== null && Math.abs(floorLimit - staffingLimit) <= EPSILON) {
      binding = 'both'
    } else {
      binding = floorLimit !== null && floorLimit < staffingLimit ? 'floor' : 'staffing'
    }
  }

  return { limit, floorLimit, staffingLimit, binding, alreadyShort: minimum === null }
}

// What a colony is left with after `batch` leaves: the population and its split, the workers short (never negative) and what breaks. `before` is the split today.
export const batchOutcome = ({ population, cost, required, batch, floor = null }) => {
  const remaining = Math.max(0, population - batch)
  const before = workerSplit({}, population, cost, required)
  const after = workerSplit({}, remaining, cost, required)
  const shortage = Math.max(0, -after.free)
  const short = shortage > WORKER_TOLERANCE
  const breaks = [...(floor !== null && remaining < floor - EPSILON ? ['floor'] : []), ...(short ? ['staffing'] : [])]

  return { batch, population, remaining, service: after.service, agriculture: after.agriculture, workers: after.available, workersBefore: before.available, required: after.required, free: after.free, spare: Math.max(0, after.free), shortage, short, efficiency: after.efficiency, shortBefore: -before.free > WORKER_TOLERANCE, floorShortfall: floor === null ? null : Math.max(0, floor - remaining), breaks }
}

// The people of the colony as the worker split counts them, from its result: { population, required }.
const termsOf = (workers) => ({ population: workers.population, required: workers.required })

// The staffing figures of a colony today, from the Outlook's worker split and colony cost results: { population, required, free, workers, minimum, short } with `minimum` the staffing minimum.
export const staffingResult = ({ workers, cost }) => combine({
  rule: 'colonistFloor.staffing',
  parts: { workers, cost },
  compute: ({ workers: split, cost: value }) => {
    const { population, required } = termsOf(split)

    return { population, required, free: split.free, workers: split.available, service: split.service, agriculture: split.agriculture, minimum: staffingMinimum({ population, cost: value, required }), short: -split.free > WORKER_TOLERANCE }
  },
})

// The population the colony can give up, the limit that binds and the numbers behind it. `floor` is the parsed floor ({ value, state }): a floor that is not a number makes the result unavailable, a blank one is no floor.
export const removableResult = ({ staffing, floor }) => {
  if (floor.state === 'invalid') {
    return unavailable({ rule: 'colonistFloor.removable', missing: ['the retained floor (not a number of at least 0)'] })
  }

  return combine({
    rule: 'colonistFloor.removable',
    parts: { staffing },
    assumptions: floor.state === 'ok' ? ['the retained floor entered here'] : ['no retained floor is set'],
    compute: ({ staffing: value }) => ({ ...removalLimit({ population: value.population, floor: floor.value, minimum: value.minimum }), population: value.population }),
  })
}

// The reason a batch cannot be worked with, as an unavailable result of `rule`, or null when it can: blank, not a number, or larger than the colony's population (`workers` is the Outlook's worker split result, which holds the population). Shared by everything a batch is applied to, so no figure is shown for a batch the colony cannot give.
const batchProblem = (rule, { workers, batch }) => {
  if (batch.state !== 'ok') {
    return unavailable({ rule, missing: [batch.state === 'blank' ? 'the batch size' : 'the batch size (not a number of at least 0)'] })
  }

  if (isAvailable(workers) && batch.value > workers.value.population + EPSILON) {
    return unavailable({ rule, missing: ['a batch no larger than the colony\'s population'] })
  }

  return null
}

// What the colony is left with after the batch: unavailable for a batch that is blank, not a number, or larger than the population.
export const outcomeResult = ({ workers, cost, batch, floor }) => {
  const problem = batchProblem('colonistFloor.outcome', { workers, batch })

  if (problem) {
    return problem
  }

  return combine({
    rule: 'colonistFloor.outcome',
    parts: { workers, cost },
    compute: ({ workers: split, cost: value }) => batchOutcome({ population: split.population, cost: value, required: split.required, batch: batch.value, floor: floor.state === 'ok' ? floor.value : null }),
  })
}

// The limit and the batch's outcome with the workers needed taken from the committed workforce result at its horizon, as { supported, possible }: each side is { required, minimum, limit, floorLimit, staffingLimit, binding, alreadyShort, outcome } (`outcome` null with no usable batch). `supported` counts the completions the forecast supports, `possible` every one that could happen. Unavailable when the committed result is.
export const committedResult = ({ workers, cost, committed, floor, batch }) => {
  if (floor.state === 'invalid') {
    return unavailable({ rule: 'colonistFloor.committed', missing: ['the retained floor (not a number of at least 0)'] })
  }

  return combine({
    rule: 'colonistFloor.committed',
    parts: { workers, cost, committed },
    assumptions: floor.state === 'ok' ? ['the retained floor entered here'] : ['no retained floor is set'],
    compute: ({ workers: split, cost: value, committed: queue }) => {
      const { population } = termsOf(split)
      const side = (series) => {
        const required = series[series.length - 1]
        const minimum = staffingMinimum({ population, cost: value, required })
        const usable = batch.state === 'ok' && batch.value <= population + EPSILON

        return { required, minimum, ...removalLimit({ population, floor: floor.value, minimum }), population, outcome: usable ? batchOutcome({ population, cost: value, required, batch: batch.value, floor: floor.state === 'ok' ? floor.value : null }) : null }
      }

      return { supported: side(queue.required.low), possible: side(queue.required.high) }
    },
  })
}

// The colony's role and whether shipping lines may load from it. The stored marker is 0 a destination, 1 a source, 2 stable. `row` is the colony's row of `loadColonistSources` (undefined: the read has no row for it) and `read` says whether the read could run at all.
export const sourceResult = ({ row, read = true }) => {
  const rule = 'colonistFloor.source'

  if (!row) {
    return unavailable({ rule, missing: [read ? 'the colony\'s row in the colonist source read' : 'the colonist source read'] })
  }

  const role = Object.prototype.hasOwnProperty.call(COLONIST_ROLES, row.ColonistDestination) ? COLONIST_ROLES[row.ColonistDestination] : null
  const imperial = row.PoliticalStatus === null ? null : row.PoliticalStatus === IMPERIAL_STATUS
  const unrestricted = row.MilitaryRestrictedColony === null ? null : row.MilitaryRestrictedColony === 0
  const checks = [
    { name: 'the colony\'s colonist marker', ok: role === null ? null : role === 'source', reason: 'the colony is not marked a source of colonists' },
    { name: 'the colony\'s political status', ok: imperial, reason: 'the colony is not an imperial population' },
    { name: 'the colony\'s military restriction', ok: unrestricted, reason: 'the colony is restricted to military use' },
  ]
  const refused = checks.filter((check) => check.ok === false)
  const unknown = checks.filter((check) => check.ok === null)
  const present = checks.filter((check) => check.ok !== null).map((check) => check.name)

  if (!refused.length && unknown.length) {
    return unavailable({ rule, missing: unknown.map((check) => check.name), present })
  }

  return ofRule({ rule, value: { role, eligible: refused.length === 0, reasons: refused.map((check) => check.reason) }, inputs: { present, missing: unknown.map((check) => check.name) } })
}

// The colony's emigrant pool as stored, and the ceiling it could refill to at the current pressure and after the batch: { stored, pressure, ceiling, ceilingAfter } in millions, a figure the save lacks as null. Unavailable when the pool itself is null or the colony has no row.
export const poolResult = ({ row, population, batch, read = true }) => {
  const rule = 'colonistFloor.pool'

  if (!row) {
    return unavailable({ rule, missing: [read ? 'the colony\'s row in the colonist source read' : 'the colonist source read'] })
  }

  if (row.AvailableColonists === null) {
    return unavailable({ rule, missing: ['the colony\'s emigrant pool'], present: row.ColonizationPressure === null ? [] : ['the colony\'s colonization pressure'] })
  }

  const pressure = row.ColonizationPressure
  const known = pressure !== null && finite(population)
  const usable = batch.state === 'ok' && finite(population) && batch.value <= population + EPSILON

  return ofRule({
    rule,
    value: { stored: row.AvailableColonists, pressure, ceiling: known ? (pressure / 100) * population : null, ceilingAfter: known && usable ? (pressure / 100) * Math.max(0, population - batch.value) : null },
    inputs: { present: ['the colony\'s emigrant pool', ...(known ? ['the colony\'s colonization pressure'] : [])], missing: known ? [] : ['the colony\'s colonization pressure'] },
  })
}

// How much of the batch shipping lines could take now and how much only a fleet of the race could: { takes, left, eligible }. Unavailable when the batch (blank, invalid or larger than the colony), the colony's population, the source or the pool is.
export const civilianResult = ({ workers, source, pool, batch }) => {
  const problem = batchProblem('colonistFloor.civilian', { workers, batch })

  if (problem) {
    return problem
  }

  return combine({
    rule: 'colonistFloor.civilian',
    parts: { workers, source, pool },
    compute: ({ source: role, pool: stored }) => {
      const takes = role.eligible ? Math.min(batch.value, Math.max(0, stored.stored)) : 0

      return { takes, left: Math.max(0, batch.value - takes), eligible: role.eligible }
    },
  })
}

// The people the infrastructure already built at the colony supports, without what is on its way (the Outlook's own cap counts the deliveries too): `colony` is the Outlook's row (its infrastructure fields) and `rate` its infrastructure-per-million result. Millions of people; Infinity when the colony needs none; unavailable when a stored quantity is missing.
export const presentSupportResult = ({ colony, rate }) => infrastructureCapResult(infrastructureOf(colony, null), rate)

// The colonists shipping lines will take in the future: never a figure, whatever the pool, the pressure and the queue say.
export const futurePickupsResult = () => unavailable({ rule: 'colonistFloor.futurePickups', missing: ['the shipping-line ships that will call at the colony', 'the emigrant pool after the loads already queued', 'the colonization pressure at the next refresh'] })

// Every result of one colony: { staffing, removable, outcome, committed, source, pool, civilian, future }. `workers` and `cost` are the Outlook's current results for the colony (rows' `r.workersNow` and `r.cost`); `committed` is the Outlook's committed workforce result, or null when the committed view is off (then `committed` here is null too and nothing of the current figures changes). `sources` is `loadColonistSources`' read, `floor` and `batch` the typed texts.
export const assessColony = ({ populationId, workers, cost, committed = null, sources = NO_COLONIST_SOURCES, floor, batch }) => {
  const parsedFloor = parseAmount(floor)
  const parsedBatch = parseAmount(batch)
  const row = sources.rows.find((candidate) => candidate.PopulationID === populationId)
  const read = sources.read !== false
  const staffing = staffingResult({ workers, cost })
  const population = staffing.value ? staffing.value.population : null
  const source = sourceResult({ row, read })
  const pool = poolResult({ row, population, batch: parsedBatch, read })

  return {
    floor: parsedFloor,
    batch: parsedBatch,
    staffing,
    removable: removableResult({ staffing, floor: parsedFloor }),
    outcome: outcomeResult({ workers, cost, batch: parsedBatch, floor: parsedFloor }),
    committed: committed ? committedResult({ workers, cost, committed, floor: parsedFloor, batch: parsedBatch }) : null,
    source,
    pool,
    civilian: civilianResult({ workers, source, pool, batch: parsedBatch }),
    future: futurePickupsResult(),
  }
}

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

const hasAll = (columns, names) => names.every((name) => columns.has(name))

const FIELDS = ['ColonistDestination', 'PoliticalStatus', 'MilitaryRestrictedColony', 'AvailableColonists', 'ColonizationPressure']

// The race's colonist source fields, one row per colony: { rows: [{ PopulationID, ColonistDestination, PoliticalStatus, MilitaryRestrictedColony, AvailableColonists, ColonizationPressure }], problems: [text], read }. A column the save lacks reads as null (not known, never 0) and is named in `problems`; a save without the population table's keys has no rows and `read` false.
export const loadColonistSources = async (database, { GameID, RaceID }) => {
  const columns = await columnsOf(database, 'FCT_Population')

  if (!hasAll(columns, ['PopulationID', 'GameID', 'RaceID'])) {
    return { rows: [], problems: ['FCT_Population has no PopulationID, GameID or RaceID in this save, so no colonist source field could be read'], read: false }
  }

  const select = FIELDS.map((name) => (columns.has(name) ? `FCT_Population.${name} as ${name}` : `null as ${name}`)).join(', ')
  const [rows] = await database.query(`select FCT_Population.PopulationID, ${select} from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by FCT_Population.PopulationID`)

  return {
    rows: rows.map((row) => ({ PopulationID: row.PopulationID, ColonistDestination: numberOrNull(row.ColonistDestination), PoliticalStatus: numberOrNull(row.PoliticalStatus), MilitaryRestrictedColony: flagOrNull(row.MilitaryRestrictedColony), AvailableColonists: numberOrNull(row.AvailableColonists), ColonizationPressure: numberOrNull(row.ColonizationPressure) })),
    problems: FIELDS.filter((name) => !columns.has(name)).map((name) => `FCT_Population.${name} is not in this save`),
    read: true,
  }
}
