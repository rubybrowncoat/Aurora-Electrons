// What each colony holds of every mineral, against the reserve the race keeps there and what the colony's build queue still needs: the reads and the rules the Mineral Breakdown and the Hauling Planner share.

import { MINERALS } from './minerals'

const NAMES = MINERALS.map((mineral) => mineral.name)
const sums = (table) => NAMES.map((name) => `sum(${table}.${name}) as ${name}`).join(', ')
const byPopulation = (rows) => Object.freeze(Object.fromEntries(rows.map((row) => [row.PopulationID, row])))

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

// One colony's minerals: stock, reserve, what its queue still needs, what is on its way by mass driver (`inbound`), what is free to move (stock above the reserve) and its state. `colony` carries the STOCK_COLUMNS; `needs` and `inbound` are its rows of the two reads below, if it has any; `exporting` is whether its mass driver ships somewhere.
export const colonyMinerals = (colony, needs = {}, inbound = {}, exporting = false) => MINERALS.map((mineral) => {
  const values = {
    stock: colony[mineral.name] || 0,
    reserve: colony[`Reserve${mineral.name}`] || 0,
    needs: needs[mineral.name] || 0,
    inbound: inbound[mineral.name] || 0,
  }

  return { ...mineral, ...values, free: Math.max(0, values.stock - values.reserve), state: stockState(values, exporting) }
})

// What each colony's queue still needs, by PopulationID: its industrial projects (per unit, times the units left; paused and queued ones too) and its shipyard tasks (their full cost, times the share of build points left).
export const loadQueueNeeds = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select VIR_Needs.PopulationID, ${sums('VIR_Needs')} from (select FCT_IndustrialProjects.PopulationID, ${NAMES.map((name) => `FCT_IndustrialProjects.${name} * FCT_IndustrialProjects.Amount as ${name}`).join(', ')} from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = ${GameID} and FCT_IndustrialProjects.RaceID = ${RaceID} union all select FCT_ShipyardTask.PopulationID, ${NAMES.map((name) => `FCT_ShipyardTask.${name} * (FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP) / FCT_ShipyardTask.TotalBP as ${name}`).join(', ')} from FCT_ShipyardTask where FCT_ShipyardTask.GameID = ${GameID} and FCT_ShipyardTask.RaceID = ${RaceID} and FCT_ShipyardTask.TotalBP > 0) as VIR_Needs group by VIR_Needs.PopulationID`)

  return byPopulation(rows)
}

// Mass-driver packets in flight, by the PopulationID they are bound for.
export const loadPacketsInFlight = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_MassDriverPackets.DestID as PopulationID, ${sums('FCT_MassDriverPackets')} from FCT_MassDriverPackets where FCT_MassDriverPackets.GameID = ${GameID} and FCT_MassDriverPackets.RaceID = ${RaceID} group by FCT_MassDriverPackets.DestID`)

  return byPopulation(rows)
}
