// The read of the stored queues the route signatures (utilities/route-signatures.js) are worked out from: the race's fleets that repeat a route or hold a queue of two orders or more, their orders and conditional orders, the move actions' own flags, and the race's order templates. A save without the conditional orders table (FCT_FleetConditionalOrder) is not supported: the read says so and returns nothing.

import { columnsOf } from './mine-bootstrap-data'

const ORDER_COLUMNS = ['MoveOrderID', 'FleetID', 'MoveOrder', 'MoveActionID', 'StartSystemID', 'DestinationType', 'DestinationID', 'PopulationID', 'DestinationItemType', 'DestinationItemID', 'MaxItems', 'MinQuantity', 'OrderDelay', 'OrderDelayRemaining', 'Arrived', 'NewSystemID', 'NewWarpPointID', 'Description']
const REQUIRED_ORDER_COLUMNS = ['MoveOrderID', 'FleetID', 'MoveOrder', 'MoveActionID', 'StartSystemID', 'DestinationType', 'DestinationID']

const NOTHING = Object.freeze({ supported: false, reason: '', fleets: [], orders: [], actions: {}, conditionals: [], standing: {}, templates: [] })

// The move actions' own flags by id: which order field each uses (an item, a quantity, a minimum) and whether it is a transit.
const loadActions = async (database) => {
  const columns = await columnsOf(database, 'DIM_MoveAction')
  const own = (name, alias) => (columns.has(name) ? `DIM_MoveAction.${name}` : '0') + ` as ${alias}`
  const [rows] = await database.query(`select DIM_MoveAction.MoveActionID, DIM_MoveAction.Description, ${own('DestinationItemType', 'Item')}, ${own('SpecifyQuanitity', 'Quantity')}, ${own('MinQuantity', 'Minimum')}, ${own('TransitOrder', 'Transit')} from DIM_MoveAction`)

  return Object.fromEntries(rows.map((row) => [row.MoveActionID, { name: row.Description, item: row.Item || 0, quantity: row.Quantity > 0, minimum: row.Minimum > 0, transit: row.Transit > 0 }]))
}

const loadTemplates = async (database, { GameID, RaceID }) => {
  const [template, order] = await Promise.all([columnsOf(database, 'FCT_OrderTemplate'), columnsOf(database, 'FCT_MoveOrderTemplate')])

  if (!['OrderTemplateID', 'TemplateName', 'GameID', 'RaceID'].every((name) => template.has(name)) || !['OrderTemplateID', 'MoveIndex', 'MoveActionID', 'DestinationType', 'DestinationID', 'StartSystemID'].every((name) => order.has(name))) {
    return []
  }

  const own = (name) => (order.has(name) ? `FCT_MoveOrderTemplate.${name}` : `null as ${name}`)
  const [heads] = await database.query('select FCT_OrderTemplate.OrderTemplateID, FCT_OrderTemplate.TemplateName from FCT_OrderTemplate where FCT_OrderTemplate.GameID = :GameID and FCT_OrderTemplate.RaceID = :RaceID', { replacements: { GameID, RaceID } })
  const [rows] = await database.query(`select FCT_MoveOrderTemplate.OrderTemplateID, FCT_MoveOrderTemplate.MoveIndex, FCT_MoveOrderTemplate.MoveActionID, FCT_MoveOrderTemplate.StartSystemID, FCT_MoveOrderTemplate.DestinationType, FCT_MoveOrderTemplate.DestinationID, ${own('PopulationID')}, ${own('DestinationItemType')}, ${own('DestinationItemID')}, ${own('MaxItems')}, ${own('MinQuantity')}, ${own('OrderDelay')}, ${own('NewSystemID')}, ${own('NewJumpPointID')} from FCT_MoveOrderTemplate where FCT_MoveOrderTemplate.GameID = :GameID and FCT_MoveOrderTemplate.OrderTemplateID in (select FCT_OrderTemplate.OrderTemplateID from FCT_OrderTemplate where FCT_OrderTemplate.GameID = :GameID and FCT_OrderTemplate.RaceID = :RaceID)`, { replacements: { GameID, RaceID } })
  const byTemplate = new Map(heads.map((head) => [head.OrderTemplateID, { ...head, orders: [] }]))

  rows.forEach((row) => byTemplate.has(row.OrderTemplateID) && byTemplate.get(row.OrderTemplateID).orders.push(row))

  return [...byTemplate.values()]
}

// The stored queues of the race: `{ supported, reason, fleets, orders, actions, conditionals, standing, templates }`. `fleets` are the race's fleets (not a shipping line's) that repeat their orders or hold two or more; `orders` their rows of FCT_MoveOrders (with `PopulationRaceID`, the race that owns the colony an order names); `conditionals` the rows of FCT_FleetConditionalOrder with the condition's description; `standing` the number of standing orders by fleet.
export const loadRouteQueues = async (database, { GameID, RaceID }) => {
  const [fleet, order, conditional, standing] = await Promise.all(['FCT_Fleet', 'FCT_MoveOrders', 'FCT_FleetConditionalOrder', 'FCT_FleetStandingOrder'].map((table) => columnsOf(database, table)))

  if (!conditional.has('FleetID')) {
    return { ...NOTHING, reason: 'The save has no conditional orders table, so route signatures are not supported for it.' }
  } else if (!['FleetID', 'FleetName', 'CycleMoves', 'RaceID', 'GameID'].every((name) => fleet.has(name)) || !REQUIRED_ORDER_COLUMNS.every((name) => order.has(name))) {
    return { ...NOTHING, reason: 'The save lacks a column the stored orders are read from.' }
  }

  const replacements = { GameID, RaceID }
  const fleetColumn = (name) => (fleet.has(name) ? `FCT_Fleet.${name}` : `0 as ${name}`)
  const orderColumns = ORDER_COLUMNS.filter((name) => order.has(name)).map((name) => `FCT_MoveOrders.${name}`).join(', ')
  const shipping = fleet.has('ShippingLine') ? 'and FCT_Fleet.ShippingLine = 0' : ''
  const wanted = `FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID ${shipping} and (FCT_Fleet.CycleMoves = 1 or (select count(*) from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) >= 2)`
  const [fleets] = await database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.CycleMoves, ${fleetColumn('Speed')}, ${fleetColumn('IgnoreConditional')}, ${fleetColumn('IgnoreStanding')} from FCT_Fleet where ${wanted} order by FCT_Fleet.FleetID`, { replacements })
  const [orders] = await database.query(`select ${orderColumns}, FCT_Population.RaceID as PopulationRaceID from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID left join FCT_Population on FCT_Population.PopulationID = FCT_MoveOrders.PopulationID and FCT_MoveOrders.PopulationID > 0 where ${wanted} order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`, { replacements })
  const [conditionals] = await database.query('select FCT_FleetConditionalOrder.FleetID, FCT_FleetConditionalOrder.ConditionalOrderID, FCT_FleetConditionalOrder.ConditionID, FCT_FleetConditionalOrder.Priority, FCT_FleetConditionalOrder.CreateFWP, DIM_Condition.Description as ConditionName from FCT_FleetConditionalOrder inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_FleetConditionalOrder.FleetID left join DIM_Condition on DIM_Condition.ConditionID = FCT_FleetConditionalOrder.ConditionID where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID', { replacements })
  const counts = {}

  if (standing.has('FleetID')) {
    const [rows] = await database.query('select FCT_FleetStandingOrder.FleetID, count(*) as Orders from FCT_FleetStandingOrder inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_FleetStandingOrder.FleetID where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID group by FCT_FleetStandingOrder.FleetID', { replacements })

    rows.forEach((row) => { counts[row.FleetID] = row.Orders })
  }

  return { supported: true, reason: '', fleets, orders, actions: await loadActions(database), conditionals, standing: counts, templates: await loadTemplates(database, replacements) }
}
