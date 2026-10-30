// What the ledger of utilities/resource-ledger.js takes from the save: one feed for each colony and resource, with the stock the colony holds now, what it makes, the deliveries on their days (the mass-driver packets in flight, the hauls of the Hauling plan) and the withdrawals the Hauling plan makes against it, beside the minimum the game stores for the colony and the minimum of the race's ship classes. The Logistics page feeds fuel and maintenance supplies and the Hauling page the minerals. Every read is a select and nothing is written to the save.
//
// A figure the save does not give is null, never 0: a stock that is not recorded has no run, a production that cannot be worked out is not counted, and a packet or a haul whose time is not known is listed as untimed and never counted. The days are those of the maintenance supply ledger: a packet takes its distance over its speed, a haul the days its freighters need for every trip (utilities/msp-supply.js `packetArrival`, `timeHauls`).

import { LITRES_PER_TON, MSP_MINERALS, mspOutput, mspProduction, refineryOutput, refineryYield, soriumLasts } from './logistics'
import { MINERALS } from './minerals'
import { packetArrival } from './msp-supply'
import { PLAN_SCENARIO } from './resource-ledger'
import { isAvailable, valueOrNull } from './provenance'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const DAYS_PER_YEAR = 365

const CLASS_SQL = 'select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.MinimumFuel, FCT_ShipClass.MinimumSupplies, count(FCT_Ship.ShipID) as Ships from FCT_ShipClass inner join FCT_Ship on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.GameID = FCT_ShipClass.GameID where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID group by FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.MinimumFuel, FCT_ShipClass.MinimumSupplies order by FCT_ShipClass.ClassName'

// The ship classes of the race that have ships, with the minimum of fuel and of supplies each keeps back when it gives them: a column the save leaves null stays null. The read throws when it fails, so a class that was not read is never taken for one with no minimum.
export const loadClassMinimums = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(CLASS_SQL, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({ ShipClassID: row.ShipClassID, ClassName: row.ClassName, MinimumFuel: isNumber(row.MinimumFuel) ? row.MinimumFuel : null, MinimumSupplies: isNumber(row.MinimumSupplies) ? row.MinimumSupplies : null, Ships: row.Ships })))
}

const SUPPLY_SQL = 'select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.MaintenanceStockpile, FCT_Population.MaintProdStatus, FCT_Population.FuelStockpile, FCT_Population.FuelProdStatus, FCT_Population.Sorium, FCT_Population.Duranium, FCT_Population.Uridium, FCT_Population.Gallicite, FCT_Race.MSPProduction, FCT_Race.FuelProduction, coalesce(VIR_Installations.MaintenanceFacilities, 0) as MaintenanceFacilities, coalesce(VIR_Installations.Refineries, 0) as Refineries from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.MaintenanceValue * FCT_PopulationInstallations.Amount) as MaintenanceFacilities, sum(DIM_PlanetaryInstallation.RefineryProductionValue * FCT_PopulationInstallations.Amount) as Refineries from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = :GameID and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID'

// What the supplies feeds need of each colony that a host other than the Logistics page does not read: the stockpiles of fuel and maintenance supplies, whether each production is on, the refineries and maintenance facilities, the racial rates and the stocks the two productions draw on, as the Logistics page reads them. The read throws when it fails, so a colony whose production was not read is never taken for one that makes nothing.
export const loadSupplyState = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(SUPPLY_SQL, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
}

const SUPPLY_COLUMNS = { fuel: 'MinimumFuel', msp: 'MinimumSupplies' }

// The minimum the game stores at the colony, apart from the class minimum and the player's reserve: the colony's reserve of a mineral (null when the save leaves it blank), and for fuel and supplies none, since a colony has no stored minimum of either.
export const gameMinimumOf = (colony, resource) => {
  if (resource === 'fuel' || resource === 'msp') {
    return { applies: false, value: null, why: `A colony has no saved minimum of ${resource === 'fuel' ? 'fuel' : 'maintenance supplies'}.` }
  }

  const value = colony[`Reserve${resource}`]

  return isNumber(value) ? { applies: true, value, why: '' } : { applies: true, value: null, why: 'The save does not record the colony\'s reserve of this mineral.' }
}

// The most a ship class in service keeps back of fuel or of supplies, and the class that keeps it: `{ applies, value, className, classes, positive, unknown, why }`. A mineral has none; with the classes not read there is no figure, and one whose column is blank leaves the figure to the classes that have one.
export const classMinimumOf = (classes, resource) => {
  const column = SUPPLY_COLUMNS[resource]

  if (!column) {
    return { applies: false, value: null, className: null, classes: 0, positive: 0, unknown: 0, why: 'A ship class has no mineral minimum.' }
  }

  if (!classes) {
    return { applies: true, value: null, className: null, classes: 0, positive: 0, unknown: 0, why: 'The ship classes were not read.' }
  }

  const known = classes.filter((shipClass) => isNumber(shipClass[column]))
  const top = known.reduce((best, shipClass) => (!best || shipClass[column] > best[column] ? shipClass : best), null)

  return { applies: true, value: top ? top[column] : null, className: top && top[column] > 0 ? top.ClassName : null, classes: known.length, positive: known.filter((shipClass) => shipClass[column] > 0).length, unknown: classes.length - known.length, why: top ? '' : 'No ship class with ships records a minimum.' }
}

const stockOf = (value) => (isNumber(value) && value >= 0 ? value : null)

// The fuel and the maintenance supplies each colony holds and makes, one feed each. `colonies`: the Logistics page's rows, or `loadSupplyState`'s; `modifierOf(PopulationID)`: the colony's production modifier or null; `place(colony)`: where it is, for the list; `classes`: `loadClassMinimums` or null. The refineries make what their capacity gives (refineries x racial rate x modifier, whatever the Sorium held now, so a refinery that starts empty makes fuel once Sorium arrives) and the maintenance facilities at their own rate, each from the colony's mineral stocks: the feed names them (`productionInputs`: 1 t of Sorium for 2,000 L of fuel, the minerals behind 1 MSP) so the ledger takes them from the stock the plans and hauls draw on, tick by tick against the balance then, and while those stocks are not among the feeds the refineries run until the Sorium held now is spent (`productionLasts`, none at all under 1 t, as the page's own yield) and the facilities until the present stock of the scarcest input mineral is spent (`productionBudget`, the same stock the supplies' year output is capped by, as in utilities/msp-supply.js). An output that cannot be worked out is null and is not counted, and a colony whose Sorium stock is not in the save has no fuel output unless its refineries make nothing.
export const supplyFeeds = ({ colonies, modifierOf, place = () => '', classes = null }) => colonies.flatMap((colony) => {
  const modifier = modifierOf(colony.PopulationID)
  const capacity = refineryOutput(colony, modifier)
  const fuel = isNumber(colony.Sorium) ? capacity : refineryYield(colony, modifier)
  const lasts = soriumLasts(colony, capacity)
  const output = mspOutput(colony, modifier)
  const limits = MSP_MINERALS.map((mineral) => (isNumber(colony[mineral.name]) ? Math.max(0, colony[mineral.name]) / mineral.perMsp : null))
  const makes = isAvailable(output) ? (colony.MaintProdStatus ? valueOrNull(mspProduction(colony, modifier)) : 0) : null
  const base = { sourceId: colony.PopulationID, sourceName: colony.PopName, place: place(colony), arrivals: [], withdrawals: [] }

  return [
    { ...base, key: `${colony.PopulationID}:fuel`, resource: 'fuel', stock: stockOf(colony.FuelStockpile), production: valueOrNull(fuel), productionLasts: isNumber(colony.Sorium) && colony.Sorium < 1 ? 0 : isAvailable(lasts) && isNumber(lasts.value) ? Math.floor(lasts.value * DAYS_PER_YEAR) : null, productionBudget: null, productionInputs: [{ key: `${colony.PopulationID}:Sorium`, perUnit: 1 / LITRES_PER_TON }], minimums: { game: gameMinimumOf(colony, 'fuel'), class: classMinimumOf(classes, 'fuel') } },
    { ...base, key: `${colony.PopulationID}:msp`, resource: 'msp', stock: stockOf(colony.MaintenanceStockpile), production: makes, productionLasts: null, productionBudget: makes > 0 && limits.every(isNumber) ? Math.min(...limits) : null, productionInputs: MSP_MINERALS.map((mineral) => ({ key: `${colony.PopulationID}:${mineral.name}`, perUnit: mineral.perMsp })), minimums: { game: gameMinimumOf(colony, 'msp'), class: classMinimumOf(classes, 'msp') } },
  ]
})

// The mineral each packet in flight carries to the colony it is bound for, as the deliveries of the ledger: `Map` of `${PopulationID}:${mineral}` to the arrivals, each on the day its distance over its speed gives, or with no day (and the reason) where the packet cannot be timed. A mineral the packet does not carry, or leaves blank, is no delivery.
export const packetDeliveries = (rows) => {
  const deliveries = new Map()

  rows.forEach((row) => {
    const timing = packetArrival(row)

    MINERALS.forEach((mineral) => {
      if (isNumber(row[mineral.name]) && row[mineral.name] > 0) {
        const key = `${row.DestID}:${mineral.name}`

        if (!deliveries.has(key)) {
          deliveries.set(key, [])
        }

        deliveries.get(key).push({ id: `packet:${row.PacketID}:${mineral.name}`, label: 'Mass-driver packet', scenario: null, day: timing.days, amount: row[mineral.name], source: 'packet', why: timing.why })
      }
    })
  })

  return deliveries
}

// The Hauling plan's own draws and deliveries by colony and mineral: a haul the freighters carry (`timed[index].days`, the entry of `timeHauls` for the haul) takes its tonnes of each mineral from the colony it starts at on the first day and gives them to the colony it ends at when its freighters have made every trip, the two sharing one id so the ledger credits the delivery with what the draw was served. A haul no freighter carries (no class, or every ship given to another haul) moves nothing, as in utilities/msp-supply.js: its draw and its delivery are both untimed, with the reason, and neither is counted. `plan`: `planHauls`' result.
export const haulFlows = ({ plan, timed = null }) => {
  const withdrawals = new Map()
  const deliveries = new Map()
  const push = (map, key, item) => {
    if (!map.has(key)) {
      map.set(key, [])
    }

    map.get(key).push(item)
  }

  plan.hauls.forEach((haul, index) => {
    const days = timed && timed[index] && isNumber(timed[index].days) ? timed[index].days : null
    const why = timed && timed[index] ? timed[index].why : 'the haul is not timed'

    haul.minerals.forEach((mineral) => {
      push(withdrawals, `${haul.from.PopulationID}:${mineral.name}`, { id: `haul:${haul.key}:${mineral.name}`, label: `Haul to ${haul.to.PopName}`, scenario: PLAN_SCENARIO, source: 'haul', day: days === null ? null : 0, amount: mineral.tonnes, why })
      push(deliveries, `${haul.to.PopulationID}:${mineral.name}`, { id: `haul:${haul.key}:${mineral.name}`, label: `Haul from ${haul.from.PopName}`, scenario: PLAN_SCENARIO, source: 'haul', day: days, amount: mineral.tonnes, why })
    })
  })

  return { withdrawals, deliveries }
}

// The minerals each colony holds, one feed for each colony and mineral. `colonies`: the Hauling page's rows (the minerals and their `Reserve<mineral>` columns); `plan`: `planHauls`' result and `timed` its `timeHauls` (null when the freighters are not known); `packets`: `loadPacketRows` of msp-supply, or null while it is not read. What the colonies mine is not counted: the page reads no mining, so a feed's production is null.
export const mineralFeeds = ({ colonies, place = () => '', plan = null, timed = null, packets = null, classes = null }) => {
  const flows = plan ? haulFlows({ plan, timed }) : { withdrawals: new Map(), deliveries: new Map() }
  const landing = packets ? packetDeliveries(packets) : new Map()

  return colonies.flatMap((colony) => MINERALS.map((mineral) => {
    const key = `${colony.PopulationID}:${mineral.name}`

    return { key, sourceId: colony.PopulationID, sourceName: colony.PopName, place: place(colony), resource: mineral.name, stock: stockOf(colony[mineral.name]), production: null, productionLasts: null, arrivals: [...(landing.get(key) || []), ...(flows.deliveries.get(key) || [])], withdrawals: flows.withdrawals.get(key) || [], minimums: { game: gameMinimumOf(colony, mineral.name), class: classMinimumOf(classes, mineral.name) } }
  }))
}
