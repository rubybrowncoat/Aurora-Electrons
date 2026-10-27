// The maintenance pools of the Logistics page: where ships are maintained, which sources give a location its capacity and its stock, and in what order the stock is drawn. A location is a cluster of sources (colonies with maintenance facilities and ships with undamaged maintenance modules) the way the game groups them, not a body or a rounded spot. The rules and what the saves hold: docs/plans/backlog/evidence/AE-097-01.md.

import { registerRule } from './provenance'

// DIM_ComponentType: Maintenance Module, and Transfer - Cargo / MSP (the cargo shuttle bay).
export const MAINTENANCE_MODULE = 48
export const CARGO_SHUTTLE_BAY = 14
// FCT_Ship.MaintenanceState of a ship under overhaul; any other state is ordinary upkeep.
export const OVERHAUL_STATE = 2
// The share of its cost a ship needs a year in ordinary upkeep; an overhaul needs the whole cost.
export const ORDINARY_SHARE = 0.25
export const DAYS_PER_YEAR = 365
// A source or ship joins a location when both coordinates differ from the anchor's by less than this many units.
export const CLUSTER_UNITS = 1

const POOL_VERSIONS = ['2.7.x']

registerRule({
  id: 'logistics.maintenancePool',
  versions: POOL_VERSIONS,
  units: 't, MSP',
  verification: 'estimated',
  structure: ['FCT_Population.MaintenanceFacilities and its body\'s FCT_SystemBody.Xcor, Ycor', 'FCT_Ship, FCT_Fleet.Xcor, Ycor, SystemID, AssignedPopulationID', 'FCT_ClassComponent and FCT_DamagedComponent (the undamaged maintenance modules and cargo shuttle bays)', 'FCT_ShipClass.Commercial, Size, Cost, SupplyShip, MinimumSupplies, MaintPriority', 'FCT_Ship.CurrentMaintSupplies, MaintenanceState, LastOverhaul'],
  note: 'The location groups, capacity sources, assigned ships and stock providers as the game builds them for its maintenance step: the first source anchors a location and later ones join it within one unit on both axes (ships also in the same system). The grouping, the whole-ton cut of each source, the draw order and the cargo shuttle bay condition are the stated game rules; none is compared with a stored value, and a location near the one unit edge depends on the order the game meets its sources.',
  assumptions: ['The sources are met colonies first, then ships, each by ID', 'Positions are the saved ones: bodies and ships that move shift the groups'],
})

registerRule({
  id: 'logistics.poolDraw',
  versions: POOL_VERSIONS,
  units: 'MSP',
  verification: 'estimated',
  structure: ['logistics.maintenancePool', 'FCT_ShipClass.Cost, MaintPriority', 'FCT_Ship.MaintenanceState, LastOverhaul, CurrentMaintSupplies'],
  note: 'The stock a location\'s ships would draw over the chosen period at their present states, in daily steps: ships by class priority, overhaul first, oldest clock first; each takes its cost share (a quarter of its yearly cost in ordinary upkeep, all of it in overhaul) times the capacity coverage from the colonies by stock, largest first, then from supply ships by stock, largest first (when the ship or the supply ship has an undamaged cargo shuttle bay), then from its own stock. Production, deliveries, finished overhauls and the clocks are not modelled.',
  assumptions: ['No colony makes or receives supplies over the period', 'A ship stays in its state, at its place and in its class order', 'A day is the step; the game steps by its own increments'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// A class component's count less the ship's damaged ones, for the components of `type` (a ship with no damage row has every one; a count or a damaged row's number the save does not give leaves it null).
const classRows = (type) => `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${type}`
const damageRows = 'from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID'
const undamagedCount = (type) => `case when exists (select 1 ${classRows(type)} and (FCT_ClassComponent.NumComponent is null or exists (select 1 ${damageRows} and FCT_DamagedComponent.Number is null))) then null else coalesce((select sum(max(cast(FCT_ClassComponent.NumComponent as integer) - coalesce((select FCT_DamagedComponent.Number ${damageRows}), 0), 0)) ${classRows(type)}), 0) end`

// Every ship of the race with what the maintenance step reads of it: where its fleet is and the colony the fleet is assigned to, its class (size, cost, designations, minimum, priority), its state and clock, its own stock, the undamaged maintenance modules and cargo shuttle bays, and the class of the ship that carries it. One row per ship, the race's own ships only (never a shipping line's). A figure the save does not give reads as null.
export const loadMaintenanceShips = async (database, { GameID, RaceID }) => {
  const sql = `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.OrbitBodyID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.AssignedPopulationID, FCT_Ship.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipClass.Cost, FCT_ShipClass.Commercial, FCT_ShipClass.SupplyShip, FCT_ShipClass.MinimumSupplies, FCT_ShipClass.MaintSupplies as ClassSupplies, FCT_ShipClass.MaintPriority, FCT_Ship.CurrentMaintSupplies, FCT_Ship.MaintenanceState, FCT_Ship.LastOverhaul, FCT_Ship.MothershipID, VIR_Mothership.CommercialHangar as CarrierCommercialHangar, ${undamagedCount(MAINTENANCE_MODULE)} as Modules, ${undamagedCount(CARGO_SHUTTLE_BAY)} as Bays from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join (select FCT_Ship.ShipID, FCT_ShipClass.CommercialHangar from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID}) as VIR_Mothership on VIR_Mothership.ShipID = FCT_Ship.MothershipID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 order by FCT_Ship.ShipID`
  const [rows] = await database.query(sql)

  return Object.freeze(rows)
}

// What a ship means to the maintenance step, as the columns the location figures sum: whether it is maintained (its tonnage must be covered), its tonnage and yearly cost, the supply stock it holds when it is designated a supply ship, and the counts (0 or 1) of what the save does not describe. A supply ship is tried for a location before any other test and is maintained unless its class is commercial; any other ship is maintained when it is not commercial and not carried by a military hangar. `null` for what the save does not give.
export const shipFigures = (ship) => {
  const designated = ship.SupplyShip === null || ship.SupplyShip === undefined ? null : Number(ship.SupplyShip) === 1
  const commercial = ship.Commercial === null || ship.Commercial === undefined ? null : Number(ship.Commercial) === 1
  const carried = Number(ship.MothershipID) > 0 && ship.CarrierCommercialHangar !== null && ship.CarrierCommercialHangar !== undefined && Number(ship.CarrierCommercialHangar) === 0
  const maintained = designated === true ? (commercial === null ? null : !commercial) : commercial === null ? null : !commercial && !carried
  const sizeKnown = isNumber(ship.Size)
  const costKnown = isNumber(ship.Cost) && isNumber(ship.MaintenanceState)
  const stockKnown = isNumber(ship.CurrentMaintSupplies) && isNumber(ship.MinimumSupplies)

  return {
    designated,
    commercial,
    maintained,
    MaintainedShips: maintained === true ? 1 : 0,
    MaintainedTons: maintained === true && sizeKnown ? ship.Size * 50 : 0,
    AnnualMSP: maintained === true && costKnown ? (ship.MaintenanceState === OVERHAUL_STATE ? ship.Cost : ship.Cost * ORDINARY_SHARE) : 0,
    SupplyMSP: designated === true && stockKnown ? Math.max(0, ship.CurrentMaintSupplies) : 0,
    SupplyAboveMinimum: designated === true && stockKnown ? Math.max(0, ship.CurrentMaintSupplies - ship.MinimumSupplies) : 0,
    MaintainedUnknown: maintained === null ? 1 : 0,
    TonsUnknown: maintained === true && !sizeKnown ? 1 : 0,
    AnnualUnknown: maintained === true && !costKnown ? 1 : 0,
    SupplyUnknown: designated === null || (designated === true && !stockKnown) ? 1 : 0,
  }
}

// A coordinate pair the save gives.
const placed = (item) => isNumber(item.Xcor) && isNumber(item.Ycor)

// Whether `item` lies within the units of an anchor on both axes: a difference of `CLUSTER_UNITS` or more on either axis is outside, and a position the save does not give is nowhere.
export const withinUnits = (anchor, item) => placed(anchor) && placed(item) && Math.abs(anchor.Xcor - item.Xcor) < CLUSTER_UNITS && Math.abs(anchor.Ycor - item.Ycor) < CLUSTER_UNITS

// A capacity cut to a whole number of tons (the game cuts each source before adding them); the small guard keeps a product that floats just under a whole number from losing a ton.
export const wholeTons = (value) => Math.floor(value + 1e-9)

const byId = (key) => (a, b) => a[key] - b[key]

// The locations of a race, built the game's way. `colonies`: the race's colonies with `SystemID`, `Xcor`, `Ycor` of their body and `MaintenanceFacilities`; `ships`: the rows of `loadMaintenanceShips`; `capacityOf(colony)`: the colony's tons of capacity, null where its figures are not in the save; `racialCapacity`: the race's tons for one maintenance module, null when not in the save.
// Colonies with maintenance facilities are met first (by ID), then ships with an undamaged maintenance module (by ID). The first source of a location anchors it; a later source joins the first location whose anchor it is within one unit of on both axes, in whatever system (as the game does), else it anchors another. A module ship's assigned colony also supports the location, wherever it is. Every ship the game tries for a location (supply ships, and ships that are not commercial or carried by a military hangar) joins the first location in its own system within one unit of its fleet. What joins no location is `places`: the colonies without facilities that support no location, and the ships left with no location, grouped the same way, with no capacity. A ship the save does not describe, or one with no position, is kept with the ships left over and counted unknown.
// A location: { key, anchor, SystemID, Xcor, Ycor, sources: [{ kind: 'colony' | 'module', id, colony | ship, tons (null when not known) }], colonies (the supporting colonies in the order the game drains them), located (those among them at the location), missingColonies (assigned colony IDs not among `colonies`), moduleShips, assigned, supplyShips, ships (every ship of the location, once) }.
export const maintenanceClusters = ({ colonies, ships, capacityOf, racialCapacity }) => {
  const clusters = []
  const colonyById = new Map(colonies.map((colony) => [colony.PopulationID, colony]))
  const open = (key, anchor, at) => {
    const cluster = { key, anchor, SystemID: at.SystemID, Xcor: at.Xcor, Ycor: at.Ycor, sources: [], colonies: [], located: [], missingColonies: [], moduleShips: [], assigned: [], supplyShips: [], ships: [] }

    clusters.push(cluster)

    return cluster
  }
  const joined = (key, anchor, at) => clusters.find((cluster) => withinUnits(cluster, at)) || open(key, anchor, at)
  const support = (cluster, colony) => {
    if (!cluster.colonies.includes(colony)) {
      cluster.colonies.push(colony)
    }
  }

  colonies.filter((colony) => colony.MaintenanceFacilities > 0).sort(byId('PopulationID')).forEach((colony) => {
    const at = { SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor }
    const cluster = joined(`pool-colony-${colony.PopulationID}`, { kind: 'colony', id: colony.PopulationID }, at)
    const tons = capacityOf(colony)

    cluster.sources.push({ kind: 'colony', id: colony.PopulationID, colony, tons: tons === null ? null : wholeTons(tons) })
    support(cluster, colony)
    cluster.located.push(colony)
  })

  ships.filter((ship) => ship.Modules === null || Number(ship.Modules) > 0).sort(byId('ShipID')).forEach((ship) => {
    const cluster = joined(`pool-ship-${ship.ShipID}`, { kind: 'module', id: ship.ShipID }, ship)
    const known = ship.Modules !== null && isNumber(racialCapacity)

    cluster.sources.push({ kind: 'module', id: ship.ShipID, ship, tons: known ? wholeTons(Number(ship.Modules) * racialCapacity) : null })
    cluster.moduleShips.push(ship)

    if (Number(ship.AssignedPopulationID) > 0) {
      const colony = colonyById.get(ship.AssignedPopulationID)

      if (colony) {
        support(cluster, colony)
      } else if (!cluster.missingColonies.includes(ship.AssignedPopulationID)) {
        cluster.missingColonies.push(ship.AssignedPopulationID)
      }
    }
  })

  const places = []
  const supporting = new Set(clusters.flatMap((cluster) => cluster.colonies))
  const placeFor = (item, key) => places.find((place) => place.SystemID === item.SystemID && withinUnits(place, item)) || (places.push({ key, SystemID: item.SystemID, Xcor: item.Xcor, Ycor: item.Ycor, colonies: [], ships: [] }), places[places.length - 1])

  colonies.filter((colony) => !(colony.MaintenanceFacilities > 0) && !supporting.has(colony)).sort(byId('PopulationID')).forEach((colony) => {
    placeFor({ SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor }, `place-colony-${colony.PopulationID}`).colonies.push(colony)
  })

  ships.slice().sort(byId('ShipID')).forEach((ship) => {
    const figures = shipFigures(ship)
    const tried = figures.designated === true || figures.designated === null || figures.maintained !== false

    if (!tried) {
      return
    }

    const cluster = clusters.find((candidate) => candidate.SystemID === ship.SystemID && withinUnits(candidate, ship))

    if (!cluster) {
      placeFor(ship, `place-ship-${ship.ShipID}`).ships.push(ship)

      return
    }

    cluster.ships.push(ship)

    if (figures.designated !== false) {
      cluster.supplyShips.push(ship)
    }

    if (figures.maintained !== false) {
      cluster.assigned.push(ship)
    }
  })

  clusters.forEach((cluster) => {
    cluster.moduleShips.forEach((ship) => {
      if (!cluster.ships.includes(ship)) {
        cluster.ships.push(ship)
      }
    })
  })

  return { clusters, places }
}

// The order the game serves the ships of a location: class maintenance priority (lowest first), overhaul before ordinary upkeep, the oldest clock first. A figure the save does not give sorts last.
export const serviceOrder = (ships) => ships.slice().sort((a, b) => {
  const last = (value) => (isNumber(value) ? value : Infinity)

  return last(a.MaintPriority) - last(b.MaintPriority) || (isNumber(b.MaintenanceState) ? b.MaintenanceState : -Infinity) - (isNumber(a.MaintenanceState) ? a.MaintenanceState : -Infinity) || last(a.LastOverhaul) - last(b.LastOverhaul) || a.ShipID - b.ShipID
})

// What each rule of the grouping says, with the point it settles: shown on the drill-down and the foot of the maintenance panel.
export const SETTLED_POINTS = Object.freeze([
  { key: 'grouping', title: 'Grouping', text: 'A colony with maintenance facilities or a ship with an undamaged maintenance module anchors a location; a later one joins the first location it lies less than 1 unit from on both axes, a difference of 1 unit or more on either axis starting another. Ships join a location in their own system only. The orbited body plays no part, and a location near the 1 unit edge depends on the order the game meets its sources.' },
  { key: 'bay', title: 'Cargo shuttle bay', text: 'A supply ship\'s stock serves a ship only when the supply ship or the ship has an undamaged cargo shuttle bay.' },
  { key: 'minimum', title: 'Class minimum', text: 'The maintenance step draws a supply ship\'s whole stock: the class minimum holds stock back from transfers and damage control only, so the minimum is shown beside the stock and not taken off it.' },
  { key: 'cut', title: 'Whole tons', text: 'Each source\'s capacity is cut to a whole number of tons before the sources are added: a colony\'s facilities, and each module ship by itself.' },
  { key: 'assigned', title: 'Assigned colony', text: 'The colony a module ship\'s fleet is assigned to supports the location the ship is in, wherever that colony is. One colony can support several locations and the earliest location drains it first; each location\'s draw here is worked out on its own, as if no other location drew from the colony.' },
])

// The words of a location's coverage, for a screen: the capacity of the sources over the tonnage assigned, times the economic modifier, held at 1 at most.
export const COVERAGE_FORMULA = 'Coverage is the capacity over the tonnage of the assigned ships, times the race\'s economic modifier, at most 100%.'

// One day of upkeep for `ship`, as the full MSP its state needs in a day (ordinary upkeep a quarter of the yearly cost, overhaul the whole cost).
const dailyNeed = (ship) => (ship.MaintenanceState === OVERHAUL_STATE ? ship.Cost : ship.Cost * ORDINARY_SHARE) / DAYS_PER_YEAR

const bayless = (ship) => Number(ship.Bays) === 0

// The stock a location's ships draw over `days` at their present states, in daily steps, drawn in the game's order. `pool`: a location of `maintenanceClusters`; `coverage`: the share of every ship's need that is requested (capacity over tonnage times the modifier, at most 1; null when not known). A source of unknown stock, a ship of unknown cost, state or bays (while a supply ship could serve it) leaves the result unavailable with `missing` naming it.
// The result: { available, missing, days, providers: [{ kind: 'colony' | 'supply' | 'own', id, name, start, used, left, depletedDay (the day its stock ran out, null when it did not) }], ships: [{ ShipID, need (MSP over the period at full support), requested, fromColonies, fromSupply, fromOwn, drawn, shortfall, support (drawn over need), full (every request paid) }], totals: { need, requested, fromColonies, fromSupply, fromOwn, shortfall, full, short } }.
export const simulatePool = (pool, { days, coverage }) => {
  const maintained = pool.assigned
  const missing = []

  if (!isNumber(coverage)) {
    missing.push('the capacity coverage')
  }

  if (maintained.some((ship) => shipFigures(ship).maintained === null)) {
    missing.push('the class of a ship the save does not describe')
  }

  if (maintained.some((ship) => !isNumber(ship.Cost) || !isNumber(ship.MaintenanceState))) {
    missing.push('the cost or state of a maintained ship')
  }

  if (pool.colonies.some((colony) => !isNumber(colony.MaintenanceStockpile))) {
    missing.push('a colony\'s maintenance stockpile')
  }

  if (pool.supplyShips.some((ship) => !isNumber(ship.CurrentMaintSupplies))) {
    missing.push('a supply ship\'s stock')
  }

  if (pool.supplyShips.some((ship) => ship.SupplyShip === null || ship.SupplyShip === undefined)) {
    missing.push('the supply designation of a ship')
  }

  if (pool.supplyShips.length && [...maintained, ...pool.supplyShips].some((ship) => ship.Bays === null || ship.Bays === undefined)) {
    missing.push('the undamaged cargo shuttle bays of a ship')
  }

  if (maintained.some((ship) => !isNumber(ship.CurrentMaintSupplies))) {
    missing.push('the own stock of a maintained ship')
  }

  if (missing.length) {
    return { available: false, missing, days, providers: [], ships: [], totals: null }
  }

  const colonies = pool.colonies.map((colony) => ({ kind: 'colony', id: colony.PopulationID, name: colony.PopName, start: colony.MaintenanceStockpile, stock: colony.MaintenanceStockpile, used: 0, depletedDay: null }))
  const supply = pool.supplyShips.slice().sort(byId('ShipID')).map((ship) => ({ kind: 'supply', id: ship.ShipID, ship, name: ship.ShipName, start: ship.CurrentMaintSupplies, stock: ship.CurrentMaintSupplies, used: 0, depletedDay: null }))
  const supplyById = new Map(supply.map((provider) => [provider.id, provider]))
  const owners = serviceOrder(maintained).map((ship) => ({ ship, own: supplyById.get(ship.ShipID) || { stock: ship.CurrentMaintSupplies, used: 0, start: ship.CurrentMaintSupplies, depletedDay: null }, need: 0, requested: 0, fromColonies: 0, fromSupply: 0, fromOwn: 0, full: true }))
  const own = { kind: 'own', start: 0, used: 0 }

  owners.forEach((owner) => {
    own.start += supplyById.has(owner.ship.ShipID) ? 0 : owner.ship.CurrentMaintSupplies
  })

  const mark = (provider, day) => {
    if (provider.depletedDay === null && provider.stock <= 0 && provider.start > 0) {
      provider.depletedDay = day
    }
  }

  for (let day = 1; day <= days; day++) {
    owners.forEach((owner) => {
      const { ship } = owner
      const full = dailyNeed(ship)
      const request = full * coverage
      let remaining = request
      let paid = false

      owner.need += full
      owner.requested += request

      colonies.sort((a, b) => b.stock - a.stock)

      for (const colony of colonies) {
        if (colony.stock >= remaining) {
          colony.stock -= remaining
          colony.used += remaining
          owner.fromColonies += remaining
          mark(colony, day)
          paid = true
          remaining = 0
          break
        }

        if (colony.stock > 0) {
          remaining -= colony.stock
          colony.used += colony.stock
          owner.fromColonies += colony.stock
          colony.stock = 0
          mark(colony, day)
        }
      }

      if (!paid) {
        supply.sort((a, b) => b.stock - a.stock)

        for (const donor of supply) {
          if (bayless(ship) && bayless(donor.ship)) {
            continue
          }

          if (donor.stock >= remaining) {
            donor.stock -= remaining
            donor.used += remaining
            owner.fromSupply += remaining
            mark(donor, day)
            paid = true
            remaining = 0
            break
          }

          if (donor.stock > 0) {
            remaining -= donor.stock
            donor.used += donor.stock
            owner.fromSupply += donor.stock
            donor.stock = 0
            mark(donor, day)
          }
        }
      }

      if (!paid) {
        const source = owner.own

        if (source.stock >= remaining) {
          source.stock -= remaining
          source.used += remaining
          mark(source, day)
          owner.fromOwn += remaining
          remaining = 0
        } else if (source.stock > 0) {
          remaining -= source.stock
          source.used += source.stock
          owner.fromOwn += source.stock
          source.stock = 0
          mark(source, day)
        }
      }

      if (remaining > 1e-9) {
        owner.full = false
      }
    })
  }

  owners.forEach((owner) => {
    if (!supplyById.has(owner.ship.ShipID)) {
      own.used += owner.own.used
    }
  })

  const rows = owners.map((owner) => {
    const drawn = owner.fromColonies + owner.fromSupply + owner.fromOwn

    return { ShipID: owner.ship.ShipID, need: owner.need, requested: owner.requested, fromColonies: owner.fromColonies, fromSupply: owner.fromSupply, fromOwn: owner.fromOwn, drawn, shortfall: Math.max(0, owner.requested - drawn), support: owner.need > 0 ? drawn / owner.need : 1, full: owner.full }
  })
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0)
  const providers = [
    ...colonies.sort((a, b) => b.start - a.start).map(({ stock, ...provider }) => ({ ...provider, left: stock })),
    ...supply.sort((a, b) => b.start - a.start || a.id - b.id).map((provider) => ({ kind: provider.kind, id: provider.id, name: provider.name, start: provider.start, used: provider.used, depletedDay: provider.depletedDay, left: provider.stock })),
    { kind: 'own', id: null, name: null, start: own.start, used: own.used, left: own.start - own.used, depletedDay: null },
  ]

  return {
    available: true,
    missing: [],
    days,
    providers,
    ships: rows,
    totals: { need: sum('need'), requested: sum('requested'), fromColonies: sum('fromColonies'), fromSupply: sum('fromSupply'), fromOwn: sum('fromOwn'), shortfall: sum('shortfall'), full: rows.filter((row) => row.full).length, short: rows.filter((row) => !row.full).length },
  }
}

// The days of a period given in years, as the simulation steps them.
export const periodDays = (years) => Math.round(years * DAYS_PER_YEAR)

// The words a screen uses for the kinds, states and results of a location's drill-down (reviewed prose: the wording is not asserted by any check, only which word stands for which kind).
export const POOL_WORDS = Object.freeze({
  sources: { colony: 'Colony', module: 'Module ship' },
  providers: { colony: 'Colony', supply: 'Supply ship', own: 'Ships\' own stock' },
  states: { ordinary: 'Ordinary upkeep', overhaul: 'Overhaul' },
  support: { full: 'Stock covers its need', short: 'Short of stock', unknown: 'Not worked out' },
  bay: { yes: 'Yes', no: 'No', unknown: 'Not known' },
  where: { located: 'At the location', assigned: 'Assigned colony, elsewhere' },
  location: { supply: 'on supply ships', unmaintained: 'Not maintained' },
  place: { ships: 'No maintenance location lies within the grouping distance of these ships in their system, so they are not maintained and use no supplies.', colonies: 'No maintenance location counts the colonies here: none has maintenance facilities and no ship with an undamaged maintenance module is assigned to any of them.' },
})
