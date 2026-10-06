// Fuel and maintenance-supply maths for the Logistics page. Sources and checks:
// docs/plans/aurcalcs/build-2.md § Logistics.

// The racial "Maintenance Production Rate" is BP per facility per year; 1 MSP is 0.25 BP.
export const MSP_PER_BP = 4
// A refinery turns 1 t of Sorium into 2,000 L of fuel.
export const LITRES_PER_TON = 2000
export const HOURS_PER_YEAR = 8760
// Minerals behind 1 MSP (docs `maintenance`, confirmed by the mineral ledger).
export const MSP_MINERALS = [
  { name: 'Duranium', perMsp: 0.1 },
  { name: 'Uridium', perMsp: 0.05 },
  { name: 'Gallicite', perMsp: 0.1 },
]

// L/yr while production is on: refineries x racial rate x the colony's production modifier.
// Matches the game's mineral ledger (Sorium for fuel refining) on every sample colony.
export const refineryOutput = (colony, modifier) => (colony.FuelProdStatus ? colony.Refineries * colony.FuelProduction * modifier : 0)

// MSP/yr the facilities make while production is on, also ledger-checked.
export const mspProduction = (colony, modifier) => colony.MaintenanceFacilities * colony.MSPProduction * MSP_PER_BP * modifier

// Tons the colony's facilities can maintain (docs `maintenance`, rule 6). Never negative: a
// bombarded or rioting colony's modifier bottoms out at zero.
export const facilityCapacity = (colony) => Math.max(0, colony.MaintenanceFacilities * colony.MaintenanceCapacity * colony.Efficiency * colony.CapacityModifier * colony.EconomicProdModifier)

const locationKey = (fleet) => (fleet.OrbitBodyID > 0 ? `body-${fleet.OrbitBodyID}` : `space-${fleet.SystemID}-${Math.round(fleet.Xcor)}-${Math.round(fleet.Ycor)}`)

// Maintenance locations: every colony body, and every spot in space with ships. Ships use MSP
// where they are, not where they're assigned: populations there first, then supply ships, then
// their own. Commercial classes and craft in military hangars need none. Over capacity, every
// ship there is maintained at the Effective Maintenance Rate (capacity / tons) and uses that
// share of its MSP. `modifierOf(PopulationID)`: the colony's overall production modifier.
export const maintenanceLocations = ({ colonies, fleets, modifierOf, maintenanceCapacity, economicModifier }) => {
  const locations = {}
  const at = (key) => (locations[key] = locations[key] || { key, colonies: [], fleets: [] })

  colonies.forEach((colony) => at(`body-${colony.SystemBodyID}`).colonies.push(colony))
  fleets.forEach((fleet) => at(locationKey(fleet)).fleets.push(fleet))

  return Object.values(locations).map((location) => {
    const sum = (list, key) => list.reduce((total, item) => total + (item[key] || 0), 0)
    const surfaceCapacity = location.colonies.reduce((total, colony) => total + facilityCapacity(colony), 0)
    const moduleCapacity = sum(location.fleets, 'MaintenanceModules') * maintenanceCapacity * economicModifier
    const capacity = surfaceCapacity + moduleCapacity
    const tons = sum(location.fleets, 'MaintainedTons')
    const required = sum(location.fleets, 'AnnualMSP')
    const rate = tons > 0 ? Math.min(1, Math.max(0, capacity / tons)) : 1
    const potential = location.colonies.reduce((total, colony) => total + mspProduction(colony, modifierOf(colony.PopulationID)), 0)
    const production = location.colonies.reduce((total, colony) => total + (colony.MaintProdStatus ? mspProduction(colony, modifierOf(colony.PopulationID)) : 0), 0)
    const stock = sum(location.colonies, 'MaintenanceStockpile')
    const supply = sum(location.fleets, 'SupplyMSP')
    const upkeep = required * rate
    const net = production - upkeep

    return {
      ...location,
      surfaceCapacity,
      capacity,
      tons,
      ships: sum(location.fleets, 'MaintainedShips'),
      required,
      rate,
      upkeep,
      potential,
      production,
      stock,
      supply,
      net,
      // Years until the colonies' stock and the supply ships' spare MSP run out.
      runway: net < 0 ? (stock + supply) / -net : null,
      warningLevel: sum(location.colonies, 'WarningMSP'),
    }
  })
}

// Fuel a class burns per ship and year at full power: engine power x litres per EP-hour.
export const fullPowerBurn = (shipClass) => shipClass.EnginePower * shipClass.FuelEfficiency * HOURS_PER_YEAR

// A harvester's fuel per year: modules x the racial refinery rate x commander and admin Mining
// bonuses x the deposit's accessibility x the share of its crew aboard. The workbook's formula
// (the wiki gives a different base rate), so it's an estimate.
export const harvesterOutput = (ship, adminBonus = 1) => {
  const crew = ship.ClassCrew > 0 ? Math.min(1, Math.max(0, ship.CurrentCrew) / ship.ClassCrew) : 1

  return ship.Harvesters * ship.FuelProduction * ship.MiningBonus * adminBonus * (ship.SoriumAccessibility || 0) * crew
}
