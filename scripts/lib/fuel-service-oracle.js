/*
  What the fuel service of each ship of a race should read, worked out here from the rows of the save and never through src/renderer/utilities/fuel-donors.js: the Transfer - Fuel systems each class mounts and each ship has left after damage, and the permission the gates give.

  const { fuelServiceTruth } = require('./lib/fuel-service-oracle')
  const truth = await fuelServiceTruth(all, { GameID, RaceID })   // Map of ShipID to { fuel, minimum, tanker, capacity, rate, systems, left, permission, surplus }

  `all(sql)` answers the rows of a SELECT. Three states are kept apart throughout, as the game's data has them: a count that is a number, a count that is stored as nothing (a class component with no count, a damage row with no number) and so unknown, and a damage row that is absent (no damage). An unknown count is never read as 0. A gate that fails blocks the ship whatever another gate could not decide; with no gate failing, one that cannot be decided leaves the permission unknown.

  `fuelFillTruth.colonyFill` and `fuelFillTruth.tankerFill` give the fills of a colony and of stationary tankers (received per recipient, drawn, residual, total, hours), for scripts/check-refuel-legs.js.
*/

const TRANSFER_FUEL = 61
const HUB_COLUMN = 'RefuellingHub'

// The sum of counts, null when any is unknown.
const summed = (counts) => (counts.includes(null) ? null : counts.reduce((sum, count) => sum + count, 0))

const verdictOf = (gates) => (gates.includes('fail') ? 'blocked' : gates.includes('unknown') ? 'unknown' : 'allowed')

const fuelServiceTruth = async (all, { GameID, RaceID }) => {
  const [ships, components, damage, columns] = await Promise.all([
    all(`select s.ShipID, s.Fuel, s.ShipClassID, c.MinimumFuel, c.FuelTanker, c.RefuellingRate, c.FuelCapacity from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.GameID = ${GameID} and s.RaceID = ${RaceID} and s.ShippingLineID = 0`),
    all(`select cc.ClassID, cc.ComponentID, cc.NumComponent from FCT_ClassComponent cc inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where d.ComponentTypeID = ${TRANSFER_FUEL}`),
    all(`select ShipID, ComponentID, Number from FCT_DamagedComponent where GameID = ${GameID}`),
    all('pragma table_info(FCT_ShipClass)'),
  ])
  const hub = columns.map((column) => column.name).includes(HUB_COLUMN)
  const mounted = new Map()
  const damaged = new Map()

  components.forEach((row) => mounted.set(row.ClassID, [...(mounted.get(row.ClassID) || []), row]))
  damage.forEach((row) => damaged.set(`${row.ShipID}:${row.ComponentID}`, [...(damaged.get(`${row.ShipID}:${row.ComponentID}`) || []), row.Number]))

  return new Map(ships.map((ship) => {
    const own = mounted.get(ship.ShipClassID) || []
    const systems = summed(own.map((row) => row.NumComponent))
    // A component with no damage row is whole; a damage row with no number leaves what is left of it unknown; with several rows the least number is the one taken.
    const left = summed(own.map((row) => {
      const numbers = damaged.get(`${ship.ShipID}:${row.ComponentID}`) || []

      return row.NumComponent === null || numbers.includes(null) ? null : Math.max(0, row.NumComponent - (numbers.length ? Math.min(...numbers) : 0))
    }))
    const known = ship.Fuel !== null && ship.MinimumFuel !== null
    const permission = verdictOf([
      hub ? 'unknown' : 'pass',
      ship.FuelTanker === null ? 'unknown' : ship.FuelTanker === 0 ? 'fail' : 'pass',
      systems === null ? 'unknown' : systems <= 0 ? 'fail' : left === null ? 'unknown' : left <= 0 ? 'fail' : 'pass',
      ship.RefuellingRate === null ? 'unknown' : ship.RefuellingRate > 0 ? 'pass' : 'fail',
      !known ? 'unknown' : Math.floor(ship.Fuel) - ship.MinimumFuel > 0 ? 'pass' : 'fail',
    ])

    return [ship.ShipID, { fuel: ship.Fuel, minimum: ship.MinimumFuel, tanker: ship.FuelTanker, capacity: ship.FuelCapacity, rate: ship.RefuellingRate, systems, left, permission, surplus: permission === 'allowed' ? Math.floor(ship.Fuel) - ship.MinimumFuel : permission === 'blocked' ? 0 : null }]
  }))
}

// ---------- what a service gives, worked out from the rules ----------

const LOW_RATE_LPH = 20000
const LOW_RATE_LIMIT_HS = 20

// The fill of a colony: ships served one after another in the order given from the one stock above the reserve, each taking what it wants or what is left. `stock` and `reserve` in litres (a reserve of 0 holds nothing back), `rate` the litres an hour each ship takes, `wants` [{ id, litres }] in the order served. Gives { received (Map of id to litres), total, residual, hours, limiter }: the hours are those of the ship that receives most, the limiter is 'stock' when a ship is left short, else 'rate' when anything was given, else 'none'.
const colonyFill = ({ stock, reserve = 0, rate, wants }) => {
  let left = Math.max(0, stock - reserve)
  const received = new Map()

  for (const want of wants) {
    const give = Math.min(want.litres, left)

    received.set(want.id, give)
    left -= give
  }

  const gave = [...received.values()]
  const total = gave.reduce((sum, litres) => sum + litres, 0)
  const short = wants.some((want) => received.get(want.id) < want.litres)

  return { received, total, residual: left, hours: total > 0 ? Math.max(...gave) / rate : 0, limiter: short ? 'stock' : total > 0 ? 'rate' : 'none' }
}

// The fill of stationary tankers: the tankers taken the richest share of their tank first (the ship with the lower id first among equals), the recipients taken in the order of their refuelling priority, their class priority and the size of their tank (then id), each recipient drawing from the tankers in turn until it is full or they are dry; a tanker of a rate under 20,000 L/h serves only a recipient of 20 hull spaces or less. `tankers` [{ id, fraction, surplus, rate }], `recipients` [{ id, priority, classPriority, capacity, size, litres }]. Gives { received (Map of id to litres), drawn (Map of tanker id to litres), residual (Map of tanker id to litres), total, hours }: the hours are at least the litres over the rates of the tankers together and at least the largest receipt over the highest rate among the tankers that gave.
const tankerFill = ({ tankers, recipients }) => {
  const richest = [...tankers].sort((a, b) => b.fraction - a.fraction || a.id - b.id)
  const order = [...recipients].sort((a, b) => a.priority - b.priority || a.classPriority - b.classPriority || a.capacity - b.capacity || a.id - b.id)
  const left = new Map(richest.map((tanker) => [tanker.id, tanker.surplus]))
  const drawn = new Map(richest.map((tanker) => [tanker.id, 0]))
  const received = new Map()

  for (const recipient of order) {
    let need = recipient.litres

    for (const tanker of richest) {
      const reaches = !(tanker.rate > 0 && tanker.rate < LOW_RATE_LPH) || recipient.size <= LOW_RATE_LIMIT_HS
      const give = reaches ? Math.min(need, left.get(tanker.id)) : 0

      if (give > 0) {
        need -= give
        left.set(tanker.id, left.get(tanker.id) - give)
        drawn.set(tanker.id, drawn.get(tanker.id) + give)
        received.set(recipient.id, (received.get(recipient.id) || 0) + give)
      }
    }
  }

  const total = [...received.values()].reduce((sum, litres) => sum + litres, 0)
  const active = richest.filter((tanker) => drawn.get(tanker.id) > 0 || left.get(tanker.id) > 0).filter((tanker) => tanker.rate > 0)
  const pooled = active.reduce((sum, tanker) => sum + tanker.rate, 0)
  const top = active.reduce((best, tanker) => Math.max(best, tanker.rate), 0)
  const largest = [...received.values()].reduce((best, litres) => Math.max(best, litres), 0)

  return { received, drawn, residual: left, total, hours: total > 0 && pooled > 0 ? Math.max(total / pooled, largest / top) : 0 }
}

const fuelFillTruth = { colonyFill, tankerFill }

module.exports = { fuelServiceTruth, fuelFillTruth }
