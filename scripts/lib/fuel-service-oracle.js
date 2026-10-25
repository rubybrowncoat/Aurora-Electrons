/*
  What the fuel service of each ship of a race should read, worked out here from the rows of the save and never through src/renderer/utilities/fuel-donors.js: the Transfer - Fuel systems each class mounts and each ship has left after damage, and the permission the gates give.

  const { fuelServiceTruth } = require('./lib/fuel-service-oracle')
  const truth = await fuelServiceTruth(all, { GameID, RaceID })   // Map of ShipID to { fuel, minimum, tanker, capacity, rate, systems, left, permission, surplus }

  `all(sql)` answers the rows of a SELECT. Three states are kept apart throughout, as the game's data has them: a count that is a number, a count that is stored as nothing (a class component with no count, a damage row with no number) and so unknown, and a damage row that is absent (no damage). An unknown count is never read as 0. A gate that fails blocks the ship whatever another gate could not decide; with no gate failing, one that cannot be decided leaves the permission unknown.
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

module.exports = { fuelServiceTruth }
