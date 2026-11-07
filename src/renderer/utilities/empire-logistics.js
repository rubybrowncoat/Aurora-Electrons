// The Empire Logistics summary of the Logistics page: one row per colony with the figures of the game's Empire Logistics tab (Economics, Empire Data), worked out as the game works them out, from the colony rows of the page and two reads of the ships. The rules and what the owner's capture of the tab showed: docs/plans/backlog/evidence/AE-304-03.md.

import { MAINTENANCE_MODULE, ORDINARY_SHARE, undamagedCount, withinUnits } from './maintenance-pools'
import { registerRule, unavailable } from './provenance'

const SUMMARY_VERSIONS = ['3.2.x']
export const SUMMARY_RULE = 'logistics.empireSummary'
// Tons of ship in a hull space, and the litres the fuel columns count in.
export const TONS_PER_HULL_SPACE = 50
export const FUEL_UNIT = 1e6
// What a maintenance facility column is multiplied by for the colony's yearly production of maintenance supplies.
export const PRODUCTION_PERIODS = 4

// The columns the tab orders by, in its order, with the name each carries in the game and the words the page gives them. Each orders its rows from the largest down.
export const SUMMARY_COLUMNS = Object.freeze([
  Object.freeze({ key: 'capacity', abbreviation: 'M-CAP', name: 'Maintenance capacity', hint: 'Tons of ships the maintenance facilities of the colony maintain, after its efficiency, radiation, unrest, political status and the economic modifier.' }),
  Object.freeze({ key: 'orbital', abbreviation: 'M-CIO', name: 'Maintenance capacity including orbital', hint: 'The capacity with the undamaged maintenance modules of the ships near the colony added, a module being the racial capacity of one facility.' }),
  Object.freeze({ key: 'tons', abbreviation: 'M-TONS', name: 'Maintained tonnage', hint: 'Tons of the ships that sit exactly at the colony and count against its maintenance. Amber when the tonnage is above the capacity including orbital.' }),
  Object.freeze({ key: 'year', abbreviation: 'M-YEAR', name: 'Maintenance supplies needed per year', hint: 'A quarter of the cost of the ships counted in the maintained tonnage, as the maintenance supplies those ships use in a year.' }),
  Object.freeze({ key: 'stock', abbreviation: 'M-MSP', name: 'Maintenance supply stockpile', hint: 'Maintenance supplies in stock at the colony.' }),
  Object.freeze({ key: 'production', abbreviation: 'M-PROD', name: 'Maintenance supply production per year', hint: 'Maintenance supplies the colony makes in a year at its production modifier. Red when production is switched off though the colony could make some; amber when production is on and below the supplies needed per year.' }),
  Object.freeze({ key: 'fuel', abbreviation: 'F-MLT', name: 'Fuel stockpile (millions of litres)', hint: 'Fuel in stock at the colony, in millions of litres.' }),
  Object.freeze({ key: 'fuelProduction', abbreviation: 'F-PRDM', name: 'Fuel production per year (millions of litres)', hint: 'Fuel the refineries of the colony make in a year at its production modifier, in millions of litres. Red when fuel production is switched off though the colony could make some.' }),
])

// The three services the tab marks with Yes, in its order, with what each stands for.
export const SUMMARY_SERVICES = Object.freeze([
  Object.freeze({ key: 'refuel', abbreviation: 'REF', hint: 'A refuelling point: a spaceport, starport or refuelling station.' }),
  Object.freeze({ key: 'resupply', abbreviation: 'RES', hint: 'A resupply point: a maintenance facility, a cargo shuttle station, spaceport or starport, or a maintenance module on a ship near the colony.' }),
  Object.freeze({ key: 'ordnance', abbreviation: 'ORD', hint: 'An ordnance transfer point: a spaceport, starport or ordnance transfer station.' }),
])

registerRule({
  id: SUMMARY_RULE,
  versions: SUMMARY_VERSIONS,
  units: 't, MSP, L',
  verification: 'confirmed',
  structure: ['FCT_Population.Efficiency, MaintenanceStockpile, MaintProdStatus, FuelStockpile, FuelProdStatus, SystemBodyID', 'FCT_PopulationInstallations.Amount with DIM_PlanetaryInstallation.MaintenanceValue, RefineryProductionValue, MassRefuelling, MassOrdnanceTransfer, CargoShuttleValue', 'FCT_Race.MaintenanceCapacity, MSPProduction, FuelProduction, EconomicProdModifier', 'FCT_SystemBody.Xcor, Ycor, RadiationLevel, FCT_Population.UnrestPoints, DIM_PopPoliticalStatus.ProductionMod', 'FCT_Fleet.SystemID, Xcor, Ycor, AssignedPopulationID, CivilianFunction', 'FCT_Ship.MothershipID, FCT_ShipClass.Size, Cost, Commercial, CommercialHangar', 'FCT_ShipyardTask.ShipID with FCT_Shipyard.PopulationID', 'FCT_ClassComponent and FCT_DamagedComponent (the undamaged maintenance modules)'],
  note: 'The figures of the Empire Logistics tab of the game, worked out as the game works them out and reproduced for every colony of the owner\'s capture of the tab, in value, order, colour and flags. Capacity is the maintenance facilities times the racial capacity, the colony\'s efficiency, radiation, unrest and political modifiers and the economic modifier. The tonnage and the supplies a year are those of the ships that sit exactly at the colony\'s body, that are not commercial, not carried by a military hangar and not in a shipyard task of the colony; the modules add to capacity from every fleet of the race near the colony, whichever system it is in. Production is the racial rate times the colony\'s overall production modifier times the whole facilities, four times over for maintenance supplies.',
  assumptions: ['A fleet near several colonies with no colony assigned supports the first of them in the list, as the game assigns it when it builds the figures', 'The colonies are listed in the order the save stores them, which is the order the game builds its list in, and equal figures keep that order'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// What the summary reads beside the page's colony rows, read once and for the summary alone.
// `tonnage`: one row per colony that has ships counting against its maintenance: { PopulationID, Ships, Size, Cost, Unknown } (the hull spaces and the cost summed, `Unknown` the ships whose class lacks either). A ship counts when its fleet is in the colony's system at the colony body's exact position, its class is not commercial, it is not carried by a ship whose class has no commercial hangar, and it is not in a shipyard task of a shipyard of the colony.
// `modules`: one row per ship of the race in a fleet with no civilian function that has undamaged maintenance modules (or whose count the save does not give): { FleetID, ShipID, Xcor, Ycor, AssignedPopulationID, Modules (null where not given) }.
// `services`: one row per colony with installations: { PopulationID, RefuelPoints, OrdnancePoints, ShuttlePoints } (the sums of amount times the installation's refuelling, ordnance transfer and cargo shuttle value).
// `listing`: the race's colonies' IDs in the order the save stores them, the order the game lists its colonies in.
export const loadSummarySources = async (database, { GameID, RaceID }) => {
  const tonnage = `select FCT_Population.PopulationID, count(*) as Ships, sum(FCT_ShipClass.Size) as Size, sum(FCT_ShipClass.Cost) as Cost, sum(case when FCT_ShipClass.Size is null or FCT_ShipClass.Cost is null then 1 else 0 end) as Unknown from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID inner join FCT_Fleet on FCT_Fleet.GameID = FCT_Population.GameID and FCT_Fleet.RaceID = FCT_Population.RaceID and FCT_Fleet.SystemID = FCT_Population.SystemID and FCT_Fleet.Xcor = FCT_SystemBody.Xcor and FCT_Fleet.Ycor = FCT_SystemBody.Ycor inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID left join (select FCT_Ship.ShipID, FCT_ShipClass.CommercialHangar from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID}) as VIR_Mothership on VIR_Mothership.ShipID = FCT_Ship.MothershipID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Ship.GameID = ${GameID} and coalesce(FCT_ShipClass.Commercial, 0) = 0 and (VIR_Mothership.CommercialHangar is null or VIR_Mothership.CommercialHangar <> 0) and not exists (select 1 from FCT_ShipyardTask inner join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID where FCT_ShipyardTask.ShipID = FCT_Ship.ShipID and FCT_Shipyard.PopulationID = FCT_Population.PopulationID) group by FCT_Population.PopulationID`
  const modules = `select * from (select FCT_Fleet.FleetID, FCT_Ship.ShipID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.AssignedPopulationID, ${undamagedCount(MAINTENANCE_MODULE)} as Modules from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.CivilianFunction = 0) where Modules is null or Modules > 0 order by FleetID, ShipID`
  const services = `select FCT_PopulationInstallations.PopID as PopulationID, sum(DIM_PlanetaryInstallation.MassRefuelling * FCT_PopulationInstallations.Amount) as RefuelPoints, sum(DIM_PlanetaryInstallation.MassOrdnanceTransfer * FCT_PopulationInstallations.Amount) as OrdnancePoints, sum(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) as ShuttlePoints from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID`
  const listing = `select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by FCT_Population.rowid`
  const [tonnageRows] = await database.query(tonnage)
  const [moduleRows] = await database.query(modules)
  const [serviceRows] = await database.query(services)
  const [listingRows] = await database.query(listing)

  return Object.freeze({ tonnage: Object.freeze(tonnageRows), modules: Object.freeze(moduleRows), services: Object.freeze(serviceRows), listing: Object.freeze(listingRows.map((row) => row.PopulationID)) })
}

// The products of figures the save gives, null when any is not given.
const product = (...factors) => (factors.every(isNumber) ? factors.reduce((result, factor) => result * factor, 1) : null)

// Truncates toward zero, as the game casts a sum of installations to a whole number of them.
const whole = (value) => (isNumber(value) ? Math.trunc(value) : null)

const missingOf = (names) => unavailable({ rule: SUMMARY_RULE, missing: names })

// The modules each colony counts. The game visits the colonies in list order and, for each, the fleets of the race with no civilian function within one unit of the colony's body on both axes, in whatever system: a fleet with no assigned colony is assigned to the first colony that visits it. A colony counts the modules of the fleets assigned to it. `null` for a colony near a fleet whose module count the save does not give.
const orbitalModules = ({ colonies, modules }) => {
  const fleets = new Map()

  for (const ship of modules) {
    const fleet = fleets.get(ship.FleetID) || { FleetID: ship.FleetID, Xcor: ship.Xcor, Ycor: ship.Ycor, assigned: Number(ship.AssignedPopulationID) > 0 ? Number(ship.AssignedPopulationID) : 0, modules: 0, unknown: false }

    if (isNumber(ship.Modules)) {
      fleet.modules += ship.Modules
    } else {
      fleet.unknown = true
    }

    fleets.set(ship.FleetID, fleet)
  }

  const counts = new Map()

  for (const colony of colonies) {
    let count = 0
    let unknown = false

    for (const fleet of fleets.values()) {
      if (!withinUnits(colony, fleet)) {
        continue
      }

      if (fleet.assigned === 0) {
        fleet.assigned = colony.PopulationID
      }

      if (fleet.assigned === colony.PopulationID) {
        count += fleet.modules
        unknown = unknown || fleet.unknown
      }
    }

    counts.set(colony.PopulationID, unknown ? null : count)
  }

  return counts
}

// The colonies in the order of `listing` (the IDs in the order the save stores them), a colony the listing does not name after those that it does, by ID.
const listedColonies = (colonies, listing) => {
  const place = new Map(listing.map((id, index) => [id, index]))
  const rank = (colony) => (place.has(colony.PopulationID) ? place.get(colony.PopulationID) : Infinity)

  return [...colonies].sort((a, b) => (rank(a) === rank(b) ? a.PopulationID - b.PopulationID : rank(a) - rank(b)))
}

// A figure rounded to `decimals` places as the game writes it (decimal arithmetic, a half rounded away from zero), for a figure the page worked out in floating point: the product is cleaned of the last digits a binary product adds (4.05 million as 4049999.9999999995 is still 4.05 million) before it is rounded.
export const roundedFigure = (value, decimals = 0) => {
  const scale = 10 ** decimals
  const scaled = Number((Math.abs(value) * scale).toPrecision(12))

  return (value < 0 ? -1 : 1) * Math.round(scaled) / scale
}

// A production switch as saved: true when on, false when off, null when the save does not give it.
const switchOf = (value) => (value === null || value === undefined ? null : Number(value) !== 0)

// The summary of the race's colonies, listed as the game lists them: only a colony with some figure or service shows, ordered from the largest `order` column down (`capacity` as the tab opens), colonies with equal figures in the order the save stores them. `colonies`: the page's rows with `MaintenanceFacilities` and `Refineries` (the sums of amount times the installation's value); `sources`: `loadSummarySources`'s; `modifierOf(PopulationID)`: the colony's overall production modifier or null.
// A row: { colony, PopulationID, capacity, orbital, tons, year, stock, production, fuel, fuelProduction (each a number, null where the save does not give what it needs; a figure of 0 or less is not shown), refuel, resupply, ordnance (true or false), tonsAbove (the tonnage is above the capacity including orbital), productionState ('short': production is on and below the supplies needed a year, 'off': production is off though the colony could make some, null), fuelProductionOff (fuel production is off though the colony could make some), missing: { [key]: result } for each figure that is null }.
export const summaryRows = ({ colonies, sources, modifierOf, order = 'capacity' }) => {
  const listed = listedColonies(colonies, sources.listing)
  const tonnage = new Map(sources.tonnage.map((row) => [row.PopulationID, row]))
  const services = new Map(sources.services.map((row) => [row.PopulationID, row]))
  const modules = orbitalModules({ colonies: listed, modules: sources.modules })
  const rows = listed.map((colony) => {
    const modifier = modifierOf(colony.PopulationID)
    const missing = {}
    // A figure the save does not give is null, and the row keeps the result that names what is missing.
    const figure = (key, value, names) => {
      if (value === null) {
        missing[key] = missingOf(names)
      }

      return value
    }
    const capacity = product(colony.MaintenanceFacilities, colony.MaintenanceCapacity, colony.Efficiency, colony.CapacityModifier, colony.EconomicProdModifier)
    const moduleCount = modules.get(colony.PopulationID)
    const added = moduleCount > 0 ? product(moduleCount, colony.MaintenanceCapacity, colony.EconomicProdModifier) : 0
    const held = tonnage.get(colony.PopulationID)
    const heldKnown = !held || Number(held.Unknown) === 0
    const service = services.get(colony.PopulationID) || { RefuelPoints: 0, OrdnancePoints: 0, ShuttlePoints: 0 }
    const row = {
      colony,
      PopulationID: colony.PopulationID,
      capacity: figure('capacity', capacity, ['the maintenance facilities, the racial capacity and the colony\'s modifiers']),
      orbital: figure('orbital', capacity === null || moduleCount === null || added === null ? null : capacity + added, ['the maintenance capacity and the maintenance modules of the ships near the colony']),
      tons: figure('tons', !held ? 0 : heldKnown ? Number(held.Size) * TONS_PER_HULL_SPACE : null, ['the hull spaces of the ship classes at the colony']),
      year: figure('year', !held ? 0 : heldKnown ? Number(held.Cost) * ORDINARY_SHARE : null, ['the cost of the ship classes at the colony']),
      stock: figure('stock', isNumber(colony.MaintenanceStockpile) ? colony.MaintenanceStockpile : null, ['the maintenance supplies in stock']),
      production: figure('production', product(colony.MSPProduction, modifier, whole(colony.MaintenanceFacilities), PRODUCTION_PERIODS), ['the colony\'s production modifier and the racial maintenance supply production']),
      fuel: figure('fuel', isNumber(colony.FuelStockpile) ? colony.FuelStockpile : null, ['the fuel in stock']),
      fuelProduction: figure('fuelProduction', product(colony.FuelProduction, modifier, whole(colony.Refineries)), ['the colony\'s production modifier and the racial fuel production']),
      refuel: whole(service.RefuelPoints) > 0,
      resupply: whole(colony.MaintenanceFacilities) > 0 || moduleCount > 0 || whole(service.ShuttlePoints) > 0,
      ordnance: whole(service.OrdnancePoints) > 0,
      missing,
    }
    const productionOn = switchOf(colony.MaintProdStatus)
    const fuelOn = switchOf(colony.FuelProdStatus)

    row.tonsAbove = isNumber(row.tons) && isNumber(row.orbital) && row.tons > row.orbital
    row.productionState = !isNumber(row.production) || productionOn === null ? null : productionOn ? (isNumber(row.year) && row.year > row.production ? 'short' : null) : row.production > 0 ? 'off' : null
    row.fuelProductionOff = isNumber(row.fuelProduction) && fuelOn === false && row.fuelProduction > 0

    return row
  })
  const shown = (row) => row.orbital !== 0 || row.tons !== 0 || row.production !== 0 || row.fuel !== 0 || row.fuelProduction !== 0 || row.refuel || row.resupply || row.ordnance || row.stock !== 0
  // The game adds decimals, so colonies with the same ships have equal figures whatever the order of the sum; the same sums in binary differ in their last digits, so a key is cleaned of them before the figures are compared.
  const keyOf = (row) => (isNumber(row[order]) ? Number(row[order].toPrecision(12)) : -Infinity)

  return rows.filter(shown).sort((a, b) => (keyOf(a) === keyOf(b) ? 0 : keyOf(b) - keyOf(a)))
}
