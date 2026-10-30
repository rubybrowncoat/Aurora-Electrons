// The fleet that sails together: which ships of a fleet move it and which only ride along, the one speed they share, what each burns at that speed, the cargo that is really counted and the stop that holds the cycle up. Transport times the fleet as one (beside its classes timed alone) and Hauling takes a repeating fleet's speed, burn and cargo from it. The rules and what the saves hold: docs/plans/backlog/evidence/AE-085-01.md.

import { burnPerHour, classSpeed } from './design-rules'
import { bonusProvenance } from './handling-bonuses'
import { columnsOf } from './mine-bootstrap-data'
import { ofRule, registerRule, unavailable } from './provenance'
import { RETRY_ASSUMPTION } from './route-time'
import { JUMP_DRIVE_COLUMNS, SHUTTLE_STRENGTH_COLUMNS, UNVERIFIED_VERSION, missingInputsOf, roundTrip } from './transport'

const SECONDS_PER_DAY = 86400
// DIM_ComponentType: Engine, FuelStorage, CargoHold, ColonistTransport and PassengerModule.
const ENGINE = 1
const FUEL_STORAGE = 3
const CARGO_HOLD = 4
const COLONIST_TRANSPORT = 17
const PASSENGER_MODULE = 50
// DIM_ComponentType Engineering Spaces: the components whose damage raises a ship's own failure rate.
const ENGINEERING = 31
// The slowest speed the game gives a ship, in km/s.
const MIN_SPEED = 1

const FLEET_VERSIONS = ['2.7.x']

registerRule({
  id: 'transport.fleetSpeed',
  versions: FLEET_VERSIONS,
  units: 'km/s',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size, EnginePower', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID, ComponentValue', 'FCT_DamagedComponent', 'FCT_Ship.OverhaulFactor, MothershipID, TractorTargetShipID, TractorParentShipID', 'FCT_Fleet.Speed, UseMaximumSpeed'],
  note: 'A fleet sails at the speed of its slowest independent ship: 1,000 x the ship\'s undamaged engine power x its overhaul factor / its mass (its size, plus the size of a ship it tows), cut to a whole number. A ship in a hangar or under tow does not limit it, and a ship with no working engines that nothing carries leaves the fleet unable to move. The saved speed is kept apart from this recomputed maximum: a fleet set to its maximum takes the maximum, any other the saved speed up to it.',
  assumptions: ['a ship with no fuel aboard or in maintenance is taken at its working speed, as the plan assumes full tanks'],
})

registerRule({
  id: 'transport.fleetBurn',
  versions: FLEET_VERSIONS,
  units: 'L/h',
  verification: 'estimated',
  structure: ['FCT_ShipClass.FuelEfficiency, FuelCapacity', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID, ComponentValue', 'FCT_DamagedComponent', 'the engines and fuel tanks the ship has undamaged'],
  note: 'Each independent ship burns its undamaged engine power x the fuel use per engine-power hour x the share of its own top speed the fleet sails at, so a faster ship in a slower fleet burns less than at full power. Carried and towed ships burn nothing. The ships\' tanks are not pooled: the fleet is held to the ship whose tank the round trip empties first, by the tank capacity it has left after damage.',
  assumptions: ['full tanks at the origin', 'no refuelling stops'],
})

registerRule({
  id: 'transport.fleetCargo',
  versions: FLEET_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_ShipClass.CargoCapacity, ColonistCapacity', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID, ComponentValue', 'FCT_DamagedComponent', 'FCT_Ship.MothershipID, TractorParentShipID'],
  note: 'The holds and berths of the independent ships, each counted once, each as the ship has it after damage (the class\'s capacity less its damaged cargo holds and colonist or passenger modules). What a ship carries in a hangar or under tow can be loaded or not by the game\'s rules for a version this planner has not checked, so such a craft\'s cargo is left out and named, not guessed.',
  assumptions: ['cargo aboard a carried or towed craft is not counted'],
})

registerRule({
  id: 'transport.fleetTrip',
  versions: FLEET_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['transport.fleetSpeed', 'transport.fleetCargo', 'the explored jump points'],
  note: 'One travel cycle for the whole fleet: twice the route at the fleet\'s one speed plus loading and unloading at both ends, each stop taking the slowest ship\'s time, and the wait for the jump shock the ships draw, counted at its upper case. Ships work in parallel at a stop, so a fast ship waits for the slowest at the stop and sails at the fleet\'s speed.',
  assumptions: ['one speed all the way and both ways', 'full holds', 'no refuelling or overhaul stops'],
})

// The columns of FCT_Ship the profile reads that the save may lack: a column the save lacks reads as null (not known), never as 0.
const OPTIONAL_SHIP_COLUMNS = ['Fuel', 'RefuelPriority', 'OverhaulFactor', 'MaintenanceState', 'MothershipID', 'TractorTargetShipID', 'TractorParentShipID', 'TractorTargetShipyardID', 'LastOverhaul', 'LastShoreLeave', 'GradePoints', 'CrewMorale', 'CurrentMaintSupplies', 'SensorDelay']

// The columns of FCT_ShipClass the ship's runtime state reads that the save may lack: the planned deployment, the stored maintenance supplies and failure rate, and the flags that decide how a ship's clocks run. Each reads as null (not known) when the save lacks it.
const OPTIONAL_CLASS_COLUMNS = ['PlannedDeployment', 'MaintSupplies', 'BaseFailureChance', 'MaxDACRoll', 'Commercial', 'MoraleCheckRequired', 'CommercialHangar', 'SupplyShip', 'ArmourThickness', 'FuelTanker', 'MinimumFuel']

// The class column that tells a commercial hangar from a military one. It is named through this constant so the page scan sees a column built by name (a bare marker, not a required column): a save without it still loads every ship, the carrier's hangar kind reading null.
const CARRIER_CLASS_COLUMN = 'CommercialHangar'

// A ship's engines as the game counts them, an undamaged engine power: each engine component the class has (DIM_ComponentType Engine) less the ship's damaged ones, times the engine's power. The class's `EnginePower` is the same sum with none damaged. A component row with no count or no power, or a damaged-component row with no number, leaves the sum unknown (null); only a ship with no damage row for a component has none of it damaged.
const ENGINE_ROWS = `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${ENGINE}`
const DAMAGE_ROWS = 'from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID'
const ENGINE_SQL = `case when exists (select 1 ${ENGINE_ROWS} and (FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null or exists (select 1 ${DAMAGE_ROWS} and FCT_DamagedComponent.Number is null))) then null else coalesce((select sum(max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number ${DAMAGE_ROWS}), 0), 0) * FCT_ShipDesignComponents.ComponentValue) ${ENGINE_ROWS}), 0) end`

// A capacity the ship has left: the class's stored capacity less what its damaged storage components held (each damaged component's value times the number of that component damaged, cut to a whole number, at most the number the class mounts). A damaged row with no number, or a mounted component with no count or no value behind one, leaves it unknown (null); a ship with no damage row for a storage component has the whole class capacity.
const storageSql = (column, types) => {
  const rows = `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID inner join FCT_DamagedComponent on FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID and FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID in (${types.join(', ')})`

  return `case when exists (select 1 ${rows} and (FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null or FCT_DamagedComponent.Number is null)) then null else max(FCT_ShipClass.${column} - coalesce((select sum(cast(FCT_ShipDesignComponents.ComponentValue * min(FCT_DamagedComponent.Number, FCT_ClassComponent.NumComponent) as integer)) ${rows}), 0), 0) end as ${column}`
}
const STORAGE_SQL = [storageSql('CargoCapacity', [CARGO_HOLD]), storageSql('ColonistCapacity', [COLONIST_TRANSPORT, PASSENGER_MODULE]), storageSql('FuelCapacity', [FUEL_STORAGE])].join(', ')

// The engineering components a ship has damaged (DIM_ComponentType Engineering Spaces): their damage raises the ship's own failure rate above the class's stored one. A damaged row with no number leaves it unknown (null); a ship with no damage row for engineering has 0.
const ENGINEERING_DAMAGE_ROWS = `from FCT_DamagedComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_DamagedComponent.ComponentID where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_ShipDesignComponents.ComponentTypeID = ${ENGINEERING}`
const ENGINEERING_DAMAGE_SQL = `case when exists (select 1 ${ENGINEERING_DAMAGE_ROWS} and FCT_DamagedComponent.Number is null) then null else coalesce((select sum(FCT_DamagedComponent.Number) ${ENGINEERING_DAMAGE_ROWS}), 0) end`

// The size of the class of the ship `idColumn` points at, and what that ship itself points at, in the fleet and the carrier or tug it names.
const otherShip = (idColumn, what) => `(select ${what} from FCT_Ship as OTHER inner join FCT_ShipClass as OTHER_CLASS on OTHER_CLASS.ShipClassID = OTHER.ShipClassID where OTHER.ShipID = ${idColumn} and OTHER.GameID = FCT_Ship.GameID)`

// What a profile needs of every ship of the fleets it is read for: the ship and its class (speed, fuel, holds and the loading strength `stopHandling` reads), the engines it has undamaged, how it is carried or towed and by what, and the clocks, stocks, crew state and class flags the ship's runtime state (utilities/ship-runtime.js) is worked out from. `fleetWhere` selects the fleets and ships (a condition over FCT_Fleet and the joined FCT_ShipClass). A column an old save lacks reads as null, so the ship is not known to be free or carried rather than assumed free. The race's own ships only.
export const loadFleetShips = async (database, { GameID, RaceID, fleetWhere = '1 = 1' }) => {
  const [shipColumns, fleetColumns, classColumns] = await Promise.all([columnsOf(database, 'FCT_Ship'), columnsOf(database, 'FCT_Fleet'), columnsOf(database, 'FCT_ShipClass')])
  const hasShipColumn = (name) => shipColumns.size === 0 || shipColumns.has(name)
  const hasClassColumn = (name) => classColumns.size === 0 || classColumns.has(name)
  const optional = OPTIONAL_SHIP_COLUMNS.map((name) => (hasShipColumn(name) ? `FCT_Ship.${name}` : `null as ${name}`))
  const classOptional = [...OPTIONAL_CLASS_COLUMNS.map((name) => (hasClassColumn(name) ? `FCT_ShipClass.${name}` : `null as ${name}`)), `${hasClassColumn('RefuelPriority') ? 'FCT_ShipClass.RefuelPriority' : 'null'} as ClassRefuelPriority`]
  const fleetColumn = (name) => (fleetColumns.size === 0 || fleetColumns.has(name) ? `FCT_Fleet.${name}` : 'null')
  const through = (column, what) => (hasShipColumn(column) ? otherShip(`FCT_Ship.${column}`, what) : 'null')
  const mass = through('TractorTargetShipID', 'OTHER_CLASS.Size')
  const towedTarget = through('TractorTargetShipID', 'OTHER.TractorTargetShipID')
  const carrierOfCarrier = through('MothershipID', 'OTHER.MothershipID')
  const carrierFleet = through('MothershipID', 'OTHER.FleetID')
  const carrierHangar = hasClassColumn(CARRIER_CLASS_COLUMN) ? through('MothershipID', `OTHER_CLASS.${CARRIER_CLASS_COLUMN}`) : 'null'
  const sql = `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Ship.ShipClassID, FCT_Ship.CurrentCrew, ${optional.join(', ')}, FCT_Fleet.FleetName, ${fleetColumn('Speed')} as FleetSpeed, ${fleetColumn('UseMaximumSpeed')} as UseMaximumSpeed, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_ShipClass.ClassName, ${classOptional.join(', ')}, ${STORAGE_SQL}, FCT_ShipClass.Size, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.MilitaryEngines, FCT_Race.CargoShuttleLoadModifier as ShuttleTechnology, ${SHUTTLE_STRENGTH_COLUMNS}, ${JUMP_DRIVE_COLUMNS}, ${ENGINE_SQL} as UndamagedEnginePower, ${ENGINEERING_DAMAGE_SQL} as DamagedEngineering, ${mass} as TowedSize, ${towedTarget} as TowedTargetShipID, ${carrierOfCarrier} as CarrierMothershipID, ${carrierFleet} as CarrierFleetID, ${carrierHangar} as CarrierCommercialHangar from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and (${fleetWhere}) order by FCT_Fleet.FleetName, FCT_ShipClass.ClassName, FCT_Ship.ShipName`
  const [rows] = await database.query(sql)

  return Object.freeze(rows)
}

const nameOf = (ship) => ship.ShipName || ship.ClassName || 'A ship'

const known = (value) => Number.isFinite(value)

// Whether a link column says the ship is linked (a positive id), is not (0), or does not say (null).
const linked = (value) => (known(value) ? value > 0 : null)

const hasHolds = (ship) => ship.CargoCapacity > 0 || ship.ColonistCapacity > 0

// What a ship's engines give: its undamaged engine power (the class's engines less its damaged ones) and the share its overhaul leaves, the speed that and its mass make and why it is none. `speed` is the game's maximum for the ship (at least 1 km/s, at most 270,000), null when an input is missing; `thrust` is the power times the overhaul factor; `mass` the ship's size plus the size of a ship it tows. A ship with nothing to push it (`thrust` 0) has `propulsion` false.
export const shipSpeed = (ship) => {
  const power = ship.UndamagedEnginePower
  const overhaul = ship.OverhaulFactor
  const towing = linked(ship.TractorTargetShipID)

  if (!known(power) || !known(overhaul) || !known(ship.Size) || towing === null || (towing && !known(ship.TowedSize))) {
    return { speed: null, thrust: null, mass: null, propulsion: null }
  }

  const thrust = power * overhaul
  const mass = ship.Size + (towing ? ship.TowedSize : 0)

  if (!(thrust > 0) || !(mass > 0)) {
    return { speed: MIN_SPEED, thrust: Math.max(0, thrust), mass, propulsion: false }
  }

  return { speed: Math.max(MIN_SPEED, classSpeed({ enginePower: thrust, sizeHS: mass })), thrust, mass, propulsion: true }
}

// Why a ship with no push gives none: every engine is damaged, the class has none or the overhaul is spent.
const noPropulsion = (ship) => {
  const name = nameOf(ship)

  if (!(ship.EnginePower > 0)) {
    return `${name} has no engines`
  } else if (!(ship.UndamagedEnginePower > 0)) {
    return `${name} has every engine damaged`
  }

  return `${name} has an overhaul factor of 0`
}

const ROLE_TEXT = { independent: 'Under its own power', hangared: 'In a hangar', towed: 'Under tow' }

// One ship of the fleet as the profile sees it. `role`: 'independent' (it moves the fleet and burns fuel), 'hangared' (carried by a ship of the fleet) or 'towed' (pulled by a tractor beam); the last two sail with the ship that holds them and burn nothing of their own. `issues` are what stops the fleet being profiled with it, `{ status: 'unsupported' | 'unknown', code, text, ship }`, and `conditions` what is true of it now without changing the plan.
const participantOf = (ship, fleetId) => {
  const name = nameOf(ship)
  const hangared = linked(ship.MothershipID)
  const towed = linked(ship.TractorParentShipID)
  const towing = linked(ship.TractorTargetShipID)
  const shipyard = linked(ship.TractorTargetShipyardID)
  const issues = []
  const conditions = []
  const issue = (status, code, text) => issues.push({ status, code, text, ship: name })

  if (hangared === null || towed === null || towing === null || shipyard === null) {
    issue('unknown', 'links', `whether ${name} is in a hangar, under tow or towing is not in the save`)
  }

  const role = hangared ? 'hangared' : towed ? 'towed' : 'independent'

  if (hangared && towed) {
    issue('unsupported', 'hangar-and-tow', `${name} is both in a hangar and under tow`)
  }

  if (hangared) {
    if (linked(ship.CarrierMothershipID)) {
      issue('unsupported', 'nested-hangar', `${name} is in the hangar of a ship that is itself in a hangar`)
    } else if (!known(ship.CarrierFleetID)) {
      issue('unsupported', 'carrier-missing', `the carrier of ${name} is not in the save`)
    } else if (linked(ship.CarrierMothershipID) === null) {
      issue('unknown', 'links', `whether the carrier of ${name} is itself in a hangar is not in the save`)
    } else if (ship.CarrierFleetID !== fleetId) {
      issue('unsupported', 'carrier-elsewhere', `${name} is in the hangar of a ship of another fleet`)
    }
  }

  if (towed && towing) {
    issue('unsupported', 'tow-chain', `${name} is under tow and tows another ship`)
  } else if (towing && linked(ship.TowedTargetShipID)) {
    issue('unsupported', 'tow-chain', `${name} tows a ship that tows another`)
  } else if (towing && linked(ship.TowedTargetShipID) === null && known(ship.TowedSize)) {
    issue('unknown', 'links', `whether the ship ${name} tows tows another is not in the save`)
  }

  if (shipyard) {
    issue('unsupported', 'tows-shipyard', `${name} tows a shipyard, whose mass this planner does not count`)
  }

  if (towing && !known(ship.TowedSize)) {
    issue('unknown', 'tow-mass', `the size of the ship ${name} tows is not in the save`)
  }

  if (role === 'independent') {
    const engine = shipSpeed(ship)

    if (engine.propulsion === false) {
      issue('immobile', 'no-propulsion', `${noPropulsion(ship)} and nothing carries or tows it, so the fleet cannot move`)
    } else if (engine.propulsion === null) {
      const missing = [!known(ship.UndamagedEnginePower) ? 'its engines' : null, !known(ship.OverhaulFactor) ? 'its overhaul factor' : null, !known(ship.Size) ? 'its size' : null].filter(Boolean)

      issue('unknown', 'speed', `${name}'s ${missing.length ? missing.join(' and ') : 'speed'} is not in the save`)
    }

    if (!known(ship.FuelEfficiency)) {
      issue('unknown', 'fuel-use', `${name}'s fuel use is not in the save`)
    }

    if (ship.Fuel === 0) {
      conditions.push({ code: 'no-fuel', text: `${name} has no fuel aboard, which holds it at 1 km/s until it is refuelled` })
    }

    if (known(ship.MaintenanceState) && ship.MaintenanceState !== 0) {
      conditions.push({ code: 'maintenance', text: `${name} has maintenance state ${ship.MaintenanceState} set, so the fleet may be held while it lasts and the plan assumes it has ended` })
    }
  }

  const holdsUnknown = !known(ship.CargoCapacity) || !known(ship.ColonistCapacity)
  const cargoStatus = holdsUnknown ? 'unknown' : !hasHolds(ship) ? 'none' : role === 'independent' ? 'counted' : 'unsupported'

  if (holdsUnknown) {
    issue('unknown', 'holds', `the holds of ${name} are not in the save`)
  }

  if (cargoStatus === 'unsupported') {
    conditions.push({ code: role === 'hangared' ? 'cargo-in-hangar' : 'cargo-in-tow', text: `${name}'s holds are not counted: loading and unloading by a craft ${role === 'hangared' ? 'in a hangar' : 'under tow'} is not validated for this game version` })
  }

  return { ship, name, role, roleText: ROLE_TEXT[role], issues, conditions, cargoStatus, engine: role === 'independent' ? shipSpeed(ship) : null }
}

const sum = (list, field) => list.reduce((total, item) => total + (known(item[field]) ? item[field] : 0), 0)

// The fleet as it sails together. `ships`: the fleet's ship rows as `loadFleetShips` gives them, `fleet`: { FleetID, FleetName } (read from the first ship's row when absent). `basis` is the speed it sails at: 'maximum' (the recomputed effective maximum: what the fleet could do) or 'saved' (the fleet's set speed, taken at its maximum when the fleet is set to it and otherwise held to it).
// Returns `status`: 'ok', 'immobile' (no independent ship can move: a ship with no working engines that nothing carries or tows, a saved speed of 0), 'unsupported' (a nested or chained hangar or tow, a shipyard under tow, no independent ship, every hold in a hangar or under tow: `reasons` names each), 'unknown' (an input is not in the save) or 'none' (the fleet has no ships); `reasons` each { status, code, text, ship }; `notes` what stays true without stopping the profile (cargo left out of a carried or towed craft, a ship without fuel); `participants`; the speeds `savedSpeed`, `useMaximumSpeed`, `effectiveMax` (the slowest independent ship's), `limiting` (that ship), `designMax` (the classes' top speeds' slowest, for what damage, overhaul and tow have taken) and `cruise` (the speed sailed at), `cruiseSource` ('maximum', 'maximum-mode', 'saved', 'saved-capped'); `fuelPerHour` (all burning ships at cruise) and `cargo`: { ships (the rows that load), counted: { cargo, colonists }, left: { cargo, colonists, ships } }.
export const fleetProfile = (ships, fleet = null, { basis = 'maximum' } = {}) => {
  const [first] = ships
  const FleetID = fleet ? fleet.FleetID : first ? first.FleetID : null
  const FleetName = fleet && fleet.FleetName ? fleet.FleetName : first ? first.FleetName : ''
  const savedSpeed = known(fleet && fleet.Speed) ? fleet.Speed : first && known(first.FleetSpeed) ? first.FleetSpeed : null
  const useMaximumSpeed = fleet && fleet.UseMaximumSpeed !== undefined ? linked(fleet.UseMaximumSpeed) : first ? linked(first.UseMaximumSpeed) : null
  const participants = ships.map((ship) => participantOf(ship, FleetID))
  const independent = participants.filter((participant) => participant.role === 'independent')
  const reasons = participants.flatMap((participant) => participant.issues)
  const notes = participants.flatMap((participant) => participant.conditions)
  const result = { FleetID, FleetName, savedSpeed, useMaximumSpeed, effectiveMax: null, designMax: null, limiting: null, cruise: null, cruiseSource: null, fuelPerHour: null, participants, reasons, notes, cargo: { ships: [], counted: { cargo: 0, colonists: 0 }, left: { cargo: 0, colonists: 0, ships: [] } }, basis }

  if (!ships.length) {
    return { ...result, status: 'none' }
  }

  if (!independent.length && !reasons.length) {
    reasons.push({ status: 'unsupported', code: 'no-independent', text: 'every ship of the fleet is in a hangar or under tow, so it moves with its carrier or tug, which is not combined across fleets', ship: '' })
  }

  const worst = ['unsupported', 'unknown', 'immobile'].find((status) => reasons.some((reason) => reason.status === status))

  if (worst) {
    return { ...result, status: worst }
  }

  const speeds = independent.map((participant) => participant.engine.speed)
  const effectiveMax = Math.min(...speeds)
  const limiting = independent.find((participant) => participant.engine.speed === effectiveMax)
  const designSpeeds = independent.map((participant) => participant.ship.MaxSpeed).filter(known)
  const designMax = designSpeeds.length === independent.length ? Math.min(...designSpeeds) : null
  const saved = known(savedSpeed) ? savedSpeed : null
  const [cruise, cruiseSource] = basis === 'maximum' || useMaximumSpeed === true ? [effectiveMax, basis === 'maximum' ? 'maximum' : 'maximum-mode'] : saved === null ? [null, null] : saved > effectiveMax ? [effectiveMax, 'saved-capped'] : [saved, 'saved']
  const modeUnknown = basis === 'saved' && useMaximumSpeed === null && saved !== null && Math.min(saved, effectiveMax) !== effectiveMax

  if (modeUnknown) {
    return { ...result, status: 'unknown', effectiveMax, designMax, limiting, reasons: [{ status: 'unknown', code: 'speed-mode', text: `whether ${FleetName || 'the fleet'} is set to sail at its maximum speed is not in the save, and its saved speed is not that maximum`, ship: '' }] }
  } else if (cruise === null) {
    return { ...result, status: 'unknown', effectiveMax, designMax, limiting, reasons: [{ status: 'unknown', code: 'saved-speed', text: `the speed of ${FleetName || 'the fleet'} is not in the save`, ship: '' }] }
  } else if (!(cruise > 0)) {
    return { ...result, status: 'immobile', effectiveMax, designMax, limiting, cruise, cruiseSource, reasons: [{ status: 'immobile', code: 'speed-zero', text: `${FleetName || 'the fleet'} is set to a speed of 0`, ship: '' }] }
  }

  const burning = participants.map((participant) => {
    if (participant.role !== 'independent') {
      return { ...participant, fraction: null, burn: 0 }
    }

    const fraction = cruise / participant.engine.speed

    return { ...participant, fraction, burn: burnPerHour({ enginePower: participant.ship.UndamagedEnginePower, fuelPerEph: participant.ship.FuelEfficiency, fraction }) }
  })
  const loaders = independent.filter((participant) => participant.cargoStatus === 'counted').map((participant) => participant.ship)
  const left = participants.filter((participant) => participant.cargoStatus === 'unsupported').map((participant) => participant.ship)
  const cargo = { ships: loaders, counted: { cargo: sum(loaders, 'CargoCapacity'), colonists: sum(loaders, 'ColonistCapacity') }, left: { cargo: sum(left, 'CargoCapacity'), colonists: sum(left, 'ColonistCapacity'), ships: left } }
  const sailing = { ...result, participants: burning, effectiveMax, designMax, limiting, cruise, cruiseSource, fuelPerHour: sum(burning, 'burn'), cargo }

  if (!loaders.length && left.length) {
    return { ...sailing, status: 'unsupported', reasons: [{ status: 'unsupported', code: 'cargo-left', text: 'every hold of the fleet is in a hangar or under tow, whose loading is not validated for this game version', ship: '' }] }
  }

  return { ...sailing, status: 'ok' }
}

// What one round trip of the fleet takes: the shared travel cycle, the stops and the fuel of each burning ship. `profile` as `fleetProfile` gives it, `km` the route one way, `endpoints` { origin, destination } as roundTrip takes them; `colonists: false` times the cargo alone; `version` and `support` as roundTrip. Returns roundTrip's `status` and fields (the fleet's one speed is the travel speed, so `travelSeconds` is shared by every ship) with the profile's own status where it can't run (`unsupported`, `immobile`, `unknown`, `none`), `fuel` [{ ship, burn, perTrip, share }] for the ships that burn, `fuelPerTrip` (all of them), `fuelShare` (the highest, of the tank of `fuelLimiting`), the round trip's `cargo` and `colonists` per trip and `tonsYear`/`colonistsYear` (null unless the trip runs). A trip whose longest-range ship needs more fuel than its tank holds is 'range'.
export const fleetTrip = (profile, km, endpoints, { colonists = true, version = null, support = null, timing = null, service = null } = {}) => {
  const empty = { problems: [], stops: [], limiting: null, estimate: false, known: [], unknown: [], versionSupported: false, travelSeconds: null, handlingSeconds: null, waitSeconds: null, transitSeconds: null, cycle: null, tripSecondsLow: null, tripSeconds: null, trips: null, fuel: [], fuelPerTrip: null, fuelShare: null, fuelLimiting: null, cargo: 0, colonists: 0, tonsYear: null, colonistsYear: null }

  if (profile.status !== 'ok') {
    return { ...empty, status: profile.status, problems: profile.reasons.map((reason) => ({ where: 'fleet', status: reason.status, code: reason.code, text: reason.text })) }
  }

  const { ships: loaders, counted } = profile.cargo

  if (!loaders.length) {
    return { ...empty, status: 'none' }
  }

  const [head, ...rest] = loaders
  const trip = roundTrip([{ ...head, MaxSpeed: profile.cruise, EnginePower: 0 }, ...rest], km, endpoints, head.ShuttleTechnology, { colonists, version, support, timing, ...(service ? { service } : {}) })
  const hours = trip.fuelSeconds === null ? null : trip.fuelSeconds / 3600
  const fuel = profile.participants.filter((participant) => participant.role === 'independent').map((participant) => {
    const perTrip = participant.burn * hours
    const capacity = participant.ship.FuelCapacity

    return { ship: participant.ship, burn: participant.burn, fraction: participant.fraction, perTrip, share: known(capacity) ? (capacity > 0 ? perTrip / capacity : perTrip > 0 ? Infinity : 0) : null }
  })
  const tanks = fuel.filter((entry) => entry.share === null)
  const tightest = fuel.filter((entry) => entry.share !== null).reduce((worst, entry) => (!worst || entry.share > worst.share ? entry : worst), null)
  const ranged = trip.status === 'ok' && tightest && tightest.share > 1 ? 'range' : trip.status
  const status = trip.status === 'ok' && tanks.length ? 'unknown' : ranged
  const runs = status === 'ok' || status === 'range'

  return {
    ...empty,
    ...trip,
    status,
    problems: status === 'unknown' && tanks.length ? [...trip.problems, ...tanks.map((entry) => ({ where: 'fleet', status: 'unknown', code: 'fuel-capacity', text: `the fuel capacity of ${nameOf(entry.ship)} is not in the save` }))] : trip.problems,
    fuel,
    fuelPerTrip: tanks.length ? null : fuel.reduce((total, entry) => total + entry.perTrip, 0),
    fuelShare: tanks.length ? null : tightest ? tightest.share : 0,
    fuelLimiting: tanks.length || !tightest ? null : tightest.ship,
    cargo: counted.cargo,
    colonists: colonists ? counted.colonists : 0,
    tonsYear: runs ? counted.cargo * trip.trips : null,
    colonistsYear: runs && colonists ? counted.colonists * trip.trips : null,
  }
}

// The cycle's days as a provenance result: the rule's own status when the fleet can run, unavailable naming what is missing or why when it is 'unknown', 'immobile' or 'unsupported', and null for a trip that is blocked or has nothing to time (its status says why). The speed the profile took and the cargo it left out are assumptions.
export const fleetTripResult = (trip, profile) => {
  if (trip.status === 'ok' || trip.status === 'range') {
    const { inputs, assumptions } = bonusProvenance(trip)
    const notes = [...(profile.cargo.left.ships.length ? ['the holds of carried or towed craft are not counted'] : []), ...(trip.waitSeconds && trip.waitSeconds.hi > 0 ? [RETRY_ASSUMPTION] : [])]

    return ofRule({ rule: 'transport.fleetTrip', value: trip.tripSeconds / SECONDS_PER_DAY, inputs, assumptions: [...(trip.versionSupported ? [] : [UNVERIFIED_VERSION]), ...assumptions, ...notes] })
  } else if (trip.status === 'unknown' || trip.status === 'unsupported' || trip.status === 'immobile') {
    const stopProblems = trip.problems.filter((problem) => problem.where !== 'fleet')
    const missing = [...new Set([...stopProblems.length ? missingInputsOf(stopProblems) : [], ...trip.problems.filter((problem) => problem.where === 'fleet').map((problem) => problem.text)])]

    return unavailable({ rule: 'transport.fleetTrip', missing })
  }

  return null
}

// The ships of a profile as table rows for the participants panel: its role, what its engines give, the share of that the fleet sails at, what it burns and for a trip (`trip` as `fleetTrip` gives it) what the round trip costs and how much of its tank that is, and what its cargo does.
export const participantRows = (profile, trip = null) => profile.participants.map((participant) => {
  const { ship } = participant
  const fuel = trip ? trip.fuel.find((entry) => entry.ship.ShipID === ship.ShipID) : null

  return {
    key: ship.ShipID,
    ship: participant.name,
    className: ship.ClassName,
    role: participant.role,
    roleText: participant.roleText,
    speed: participant.engine ? participant.engine.speed : null,
    designSpeed: ship.MaxSpeed,
    towing: linked(ship.TractorTargetShipID) === true,
    fraction: participant.fraction === undefined ? null : participant.fraction,
    burn: participant.burn === undefined || participant.role !== 'independent' ? null : participant.burn,
    perTrip: fuel ? fuel.perTrip : null,
    share: fuel ? fuel.share : null,
    limiting: Boolean(profile.limiting && profile.limiting.ship.ShipID === ship.ShipID),
    cargoStatus: participant.cargoStatus,
    cargo: participant.cargoStatus === 'none' ? null : ship.CargoCapacity,
    colonists: participant.cargoStatus === 'none' ? null : ship.ColonistCapacity,
    conditions: participant.conditions.map((condition) => condition.text),
  }
})

// A repeating fleet in the shape Hauling's cycle maths takes: the fleet row with the profile's speed, the burn of its ships at that speed and the holds that are really counted, `Speed` 0 when the profile is not 'ok' (so the fleet is not moving) and the loading ships in place of every ship of the fleet.
export const hauledFleet = (fleet, profile) => ({
  ...fleet,
  Speed: profile.status === 'ok' ? profile.cruise : 0,
  FuelPerHour: profile.status === 'ok' ? profile.fuelPerHour : 0,
  CargoCapacity: profile.cargo.counted.cargo,
  ColonistCapacity: profile.cargo.counted.colonists,
})
