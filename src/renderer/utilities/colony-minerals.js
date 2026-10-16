// What each colony holds of every mineral, against the reserve the race keeps there and what the colony's build queue still needs: the reads and the rules the Mineral Breakdown and the Hauling Planner share.

import { MINERALS } from './minerals'
import { combine, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

const COLONY_VERSIONS = ['2.7.x']

// The rules of a colony's mineral figures, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
registerRule({
  id: 'minerals.colonyStock',
  versions: COLONY_VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_Population.<mineral>', 'FCT_Population.Reserve<mineral>'],
  note: 'What a colony holds and keeps in reserve of a mineral are stored columns, and what is free to move is the stock above the reserve, never under 0: arithmetic on stored values, with no game formula in it. A colony whose stock or reserve is not recorded has no figure: it is neither 0 nor free to move.',
})

registerRule({
  id: 'minerals.stockState',
  versions: COLONY_VERSIONS,
  units: 'state',
  verification: 'confirmed',
  structure: ['FCT_Population.<mineral>', 'FCT_Population.Reserve<mineral>', 'the colony\'s queue needs', 'FCT_Population.MassDriverDest'],
  note: 'The state of a colony\'s mineral, most pressing first: short when the queue needs a tonne or more than the stock, then stock the mass driver would ship that the queue needs, below the reserve, free to move above it, all reserved, and nothing held. Thresholds of 1 t on stored values, as differences under a tonne are rounding. The state needs the stock, the reserve and the queue needs: with any unknown, it is unknown. It is as certain as the queue needs it reads.',
})

registerRule({
  id: 'minerals.queueNeeds',
  versions: COLONY_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_IndustrialProjects.<mineral>, Amount', 'FCT_ShipyardTask.<mineral>, TotalBP, CompletedBP, TaskTypeID'],
  note: 'What a colony\'s queue still needs of a mineral: each industrial project\'s cost per unit times the units left (paused and queued ones too), plus each shipyard task\'s cost times the share of its build points left. A scrap task needs nothing, as the stock is neither checked nor spent for it. The sums were not compared with a saved shortage. A colony with no project or task needs 0; a colony whose queue was not read, or whose cost is not recorded, has no figure.',
})

registerRule({
  id: 'minerals.inFlight',
  versions: COLONY_VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_MassDriverPackets.<mineral>, DestID'],
  note: 'The cargo of the mass-driver packets in flight to a colony, summed by mineral from the stored packets: arithmetic on stored values. A colony with no packet bound for it has 0; a read that was not made, or a cargo that is not recorded, leaves no figure.',
})

const NAMES = MINERALS.map((mineral) => mineral.name)
const sums = (table) => NAMES.map((name) => `sum(${table}.${name}) as ${name}`).join(', ')
// How many terms of each sum are null, since SQL leaves a null term out of a sum: `Missing<mineral>` beside each summed column.
const missingTerms = (table) => NAMES.map((name) => `sum(case when ${table}.${name} is null then 1 else 0 end) as Missing${name}`).join(', ')
const byPopulation = (rows) => Object.freeze(Object.fromEntries(rows.map((row) => [row.PopulationID, row])))

// FCT_ShipyardTask.TaskTypeID of a scrap task.
const SCRAP_TASK = 3

// The stock and reserve of every mineral, for a read of FCT_Population.
export const STOCK_COLUMNS = NAMES.map((name) => `FCT_Population.${name}, FCT_Population.Reserve${name}`).join(', ')

// A colony's state for one mineral, most pressing first. Differences under a tonne are rounding.
export const STOCK_STATES = {
  short: { order: 0, label: 'Short for queue', icon: 'mdi-alert-circle-outline', color: 'error' },
  exported: { order: 1, label: 'Driver ships queue stock', icon: 'mdi-arrow-top-right-thick', color: 'warning' },
  below: { order: 2, label: 'Below reserve', icon: 'mdi-arrow-down-bold-circle-outline', color: 'warning' },
  surplus: { order: 3, label: 'Free to move', icon: 'mdi-check-circle-outline', color: 'success' },
  held: { order: 4, label: 'All reserved', icon: 'mdi-lock-outline', color: undefined },
  empty: { order: 5, label: 'Nothing held', icon: 'mdi-circle-outline', color: undefined },
  unknown: { order: 6, label: 'Unknown', icon: 'mdi-help-circle-outline', color: undefined },
}
export const PRESSING = ['short', 'exported', 'below']

export const stockState = ({ stock, reserve, needs }, exporting) => {
  if (needs - stock >= 1) {
    return 'short'
  } else if (exporting && needs - reserve >= 1 && stock - reserve >= 1) {
    return 'exported'
  } else if (reserve - stock >= 1) {
    return 'below'
  } else if (stock - reserve >= 1) {
    return 'surplus'
  }

  return stock >= 1 ? 'held' : 'empty'
}

// One colony's minerals: stock, reserve, what its queue still needs, what is on its way by mass driver (`inbound`), what is free to move (stock above the reserve) and its state. `colony` carries the STOCK_COLUMNS; `needs` and `inbound` are its rows of the two reads below, if it has any; `exporting` is whether its mass driver ships somewhere. A figure the save does not record reads as 0 here, for the planners that only add tonnes up: `colonyMineralResults` keeps it unknown.
export const colonyMinerals = (colony, needs = {}, inbound = {}, exporting = false) => MINERALS.map((mineral) => {
  const values = {
    stock: colony[mineral.name] || 0,
    reserve: colony[`Reserve${mineral.name}`] || 0,
    needs: needs[mineral.name] || 0,
    inbound: inbound[mineral.name] || 0,
  }

  return { ...mineral, ...values, free: Math.max(0, values.stock - values.reserve), state: stockState(values, exporting) }
})

const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const stored = (rule, value, column) => (known(value) ? ofRule({ rule, value, inputs: { present: [column] } }) : unavailable({ rule, missing: [column] }))

// A summed figure of a read row (`loadQueueNeeds`, `loadPacketsInFlight`): unavailable, naming `column`, when the sum is not a number or any term of it was null (the row's `Missing<mineral>` count), as SQL leaves a null term out of a sum.
const summed = (rule, row, name, column) => (row[`Missing${name}`] > 0 ? unavailable({ rule, missing: [column] }) : stored(rule, row[name], column))

// What a colony's queue still needs of one mineral. `needs` is the whole of `loadQueueNeeds` (null when it was not read, which leaves every colony's need unknown); a colony with no row in it has nothing queued, which is a need of 0.
const queueNeedsOf = (needs, populationId, name) => {
  if (!needs) {
    return unavailable({ rule: 'minerals.queueNeeds', missing: ['the build queue'] })
  }

  const row = needs[populationId]

  return row ? summed('minerals.queueNeeds', row, name, `the queue cost of ${name} (FCT_IndustrialProjects.${name}, Amount; FCT_ShipyardTask.${name}, TotalBP, CompletedBP)`) : ofRule({ rule: 'minerals.queueNeeds', value: 0, inputs: { present: ['FCT_IndustrialProjects', 'FCT_ShipyardTask'] } })
}

// What is on its way to a colony by mass driver. `packets` is the whole of `loadPacketsInFlight` (null when it was not read); a colony with no row has no packet bound for it.
const inboundOf = (packets, populationId, name) => {
  if (!packets) {
    return unavailable({ rule: 'minerals.inFlight', missing: ['the mass-driver packets'] })
  }

  const row = packets[populationId]

  return row ? summed('minerals.inFlight', row, name, `FCT_MassDriverPackets.${name}`) : ofRule({ rule: 'minerals.inFlight', value: 0, inputs: { present: ['FCT_MassDriverPackets'] } })
}

// A colony's stock of one mineral and what is on its way to it by mass driver, as results: the part of `colonyMineralResults` that needs neither the reserve nor the queue.
export const stockAndInbound = (colony, packets, mineral) => ({ stock: stored('minerals.colonyStock', colony[mineral.name], `FCT_Population.${mineral.name}`), inbound: inboundOf(packets, colony.PopulationID, mineral.name) })

// `colonyMinerals` with the unknown kept apart from 0: each of a mineral's stock, reserve, free, needs, inbound and state is a provenance result in `results`, and the same name holds its value, or null when unknown. A colony whose stock or reserve is not recorded has no free stock and no state; one whose queue needs are unknown has no state. `needs` and `packets` are the whole reads (`loadQueueNeeds`, `loadPacketsInFlight`), or null when one was not made; `exporting` is whether the colony's mass driver ships somewhere.
export const colonyMineralResults = (colony, needs, packets, exporting = false) => MINERALS.map((mineral) => {
  const { stock, inbound } = stockAndInbound(colony, packets, mineral)
  const reserve = stored('minerals.colonyStock', colony[`Reserve${mineral.name}`], `FCT_Population.Reserve${mineral.name}`)
  const needsResult = queueNeedsOf(needs, colony.PopulationID, mineral.name)
  const results = {
    stock,
    reserve,
    free: combine({ rule: 'minerals.colonyStock', parts: { stock, reserve }, compute: (values) => Math.max(0, values.stock - values.reserve) }),
    needs: needsResult,
    inbound,
    state: combine({ rule: 'minerals.stockState', parts: { stock, reserve, needs: needsResult }, compute: (values) => stockState(values, exporting) }),
  }

  return { ...mineral, stock: valueOrNull(stock), reserve: valueOrNull(reserve), free: valueOrNull(results.free), needs: valueOrNull(needsResult), inbound: valueOrNull(results.inbound), state: valueOrNull(results.state), results }
})

// The most pressing state among a colony's `minerals` (entries of `colonyMineralResults`), with the result that carries its provenance. A mineral with an unknown state is not fine: when none of the others is pressing, the colony's state is 'unknown'. `unknown` lists those minerals.
export const worstState = (minerals) => {
  const settled = minerals.filter((mineral) => mineral.state !== null)
  const unknown = minerals.filter((mineral) => mineral.state === null)
  const worst = settled.reduce((state, mineral) => (STOCK_STATES[mineral.state].order < STOCK_STATES[state].order ? mineral.state : state), 'empty')
  const state = unknown.length && !PRESSING.includes(worst) ? 'unknown' : worst
  const partsOf = (list) => Object.fromEntries(list.map((mineral) => [mineral.name, mineral.results.state]))
  const result = state === 'unknown' ? combine({ rule: 'minerals.stockState', parts: partsOf(unknown), compute: () => state }) : combine({ rule: 'minerals.stockState', parts: partsOf(settled), compute: () => state, assumptions: unknown.length ? [`${unknown.length} ${unknown.length === 1 ? 'mineral' : 'minerals'} with an unknown state not counted`] : [] })

  return { state, result, unknown }
}

// What each colony's queue still needs, by PopulationID: its industrial projects (per unit, times the units left; paused and queued ones too) and its shipyard tasks (their full cost, times the share of build points left). A scrap task needs nothing: the game neither checks the stock against its mineral figures nor spends them, and the other task types (construction, repair, refit) draw them. A term that cannot be worked out (a cost, an amount, the build points or the task type not recorded) is null and counted in the row's `Missing<mineral>`, so `colonyMineralResults` can tell a partial sum from a complete one.
export const loadQueueNeeds = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select VIR_Needs.PopulationID, ${sums('VIR_Needs')}, ${missingTerms('VIR_Needs')} from (select FCT_IndustrialProjects.PopulationID, ${NAMES.map((name) => `FCT_IndustrialProjects.${name} * FCT_IndustrialProjects.Amount as ${name}`).join(', ')} from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} union all select FCT_ShipyardTask.PopulationID, ${NAMES.map((name) => `case when FCT_ShipyardTask.TaskTypeID is null then null else FCT_ShipyardTask.${name} * (FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP) / FCT_ShipyardTask.TotalBP end as ${name}`).join(', ')} from FCT_ShipyardTask where FCT_ShipyardTask.GameID = ${GameID} and FCT_ShipyardTask.RaceID = ${RaceID} and (FCT_ShipyardTask.TotalBP is null or FCT_ShipyardTask.TotalBP > 0) and (FCT_ShipyardTask.TaskTypeID is null or FCT_ShipyardTask.TaskTypeID <> ${SCRAP_TASK})) as VIR_Needs group by VIR_Needs.PopulationID`)

  return byPopulation(rows)
}

// Mass-driver packets in flight, by the PopulationID they are bound for, with each mineral's null terms counted in `Missing<mineral>`.
export const loadPacketsInFlight = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_MassDriverPackets.DestID as PopulationID, ${sums('FCT_MassDriverPackets')}, ${missingTerms('FCT_MassDriverPackets')} from FCT_MassDriverPackets where FCT_MassDriverPackets.GameID = ${GameID} and FCT_MassDriverPackets.RaceID = ${RaceID} group by FCT_MassDriverPackets.DestID`)

  return byPopulation(rows)
}
