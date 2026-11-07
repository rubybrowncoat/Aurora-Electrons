// What the Ordnance Factory Module and the orbital modules add to ordnance: the class totals (the modules a class mounts and the build points a year they make), and the orbital term a colony's ordnance capacity takes from the ships at it. The pod bay family is not in the game of the line this reads, so nothing here counts a pod bay. Each figure is a provenance result (utilities/provenance.js): a missing factor leaves it unavailable, naming it, and is never taken as 1 or 0. Evidence: docs/plans/backlog/evidence/AE-309-01.md.

import { fleetClaimable, fleetCountsForColony, fleetPlaced } from './colonization'
import { crewFraction } from './crew'
import { navalAdminChain } from './minerals'
import { MINING_BONUS } from './mining-data'
import { combine, ofRule, registerRule, unavailable } from './provenance'

const VERSIONS = ['3.2.x']
const NONE = new Set()

// DIM_ComponentType: Orbital Mining Module and Ordnance Factory Module.
export const ORBITAL_MINING_MODULE = 38
export const ORDNANCE_FACTORY_MODULE = 72
// The commander bonus ID of the Production bonus, which the naval admin chain of the orbital term applies.
export const PRODUCTION_BONUS = 5

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The game's own class recalculation adds every Ordnance Factory Module line to the class's stored count (`FCT_ShipClass.OrdnanceModules`, the sum of the NumComponent of the lines of that component type), saves it and loads it back; the class summary line reads "N modules producing the race's ordnance production times N build points per annum". A ship's capacity of the module is its undamaged modules times the race's ordnance production, with no crew share and no commander bonus, so a class with no damage makes the same figure. No colony adds the module to its capacity: the game only counts it for the colony summary.
registerRule({
  id: 'ordnance.classModules',
  versions: VERSIONS,
  units: 'modules',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.OrdnanceModules', 'FCT_ClassComponent.ClassID, ComponentID, NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID'],
  note: 'The Ordnance Factory Modules a class mounts, as the save stores the class: the game adds up the module lines of the class design and keeps the total. The component lines of the class add up to the same total; a class whose lines disagree with the stored total is shown with both.',
})

registerRule({
  id: 'ordnance.classProduction',
  versions: VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.OrdnanceModules', 'FCT_Race.OrdnanceProduction'],
  note: 'The build points of ordnance a year the modules of a class make: the race\'s ordnance production times the class\'s modules, with no crew share or commander bonus, and fewer for a ship with a damaged module. The game writes no stored figure for it, so it is read from the game\'s rules and checked against nothing saved.',
  assumptions: ['The ship has no damaged Ordnance Factory Module'],
})

// The colony's annual ordnance capacity is its installations' product plus the orbital term: the term is the capacity of the Orbital Mining Module (not the Ordnance Factory Module) of the fleets at the colony, and the added term takes none of the colony's modifiers. The term sums, over the fleets of the colony's race that lie within one unit of the colony's body on both axes and are assigned to the colony, a fleet's capacity of that module (the sum of its ships' capacities) times the fleet's command's Production bonus for the system it is in (the command type's Industrial share); a fleet with no colony is given to the first colony that asks, so an unassigned fleet at the colony counts, and a fleet assigned to another colony, or to this colony but away from it, does not. That test is colonization.js `fleetCountsForColony`, the one the civilian mining complex exclusion reads too. A ship's capacity of the Orbital Mining Module is its undamaged modules times the race's mine production, times its commander's Mining bonus, times the share of the class crew aboard. No 3.1 save the app has holds a build rate written by the game with such a ship at a colony, so the term follows the game's rules and is not checked against a save.
registerRule({
  id: 'production.orbitalOrdnance',
  versions: VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_Race.MineProduction', 'FCT_Fleet.RaceID, AssignedPopulationID, ParentCommandID, SystemID, OrbitBodyID, Xcor, Ycor', 'FCT_Population.PopulationID, RaceID, SystemBodyID', 'FCT_SystemBody.Xcor, Ycor', 'FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent.Number', 'FCT_Commander, FCT_CommanderBonuses (Mining)', 'FCT_NavalAdminCommand (Production)'],
  note: 'What the orbital mining modules of the ships at a colony add to its ordnance capacity: the ships of the race\'s fleets within one unit of the colony\'s body on both axes that are assigned to the colony or to none (a fleet assigned to another colony, or to this one but away from it, adds nothing here, and the game gives a fleet with no colony to the first colony that asks), the race\'s mine production times the undamaged modules, each ship at the share of its class crew aboard and at its captain\'s Mining bonus, times the Production bonus of the naval admin chain at the Industrial share. The game takes the Orbital Mining Module here, not the Ordnance Factory Module, and the colony\'s modifiers do not apply to it. It is read from the game\'s rules; no saved game shows it. A fleet with no colony within one unit of more than one colony of the race, or whose place the save does not give, leaves the term unavailable.',
  assumptions: ['A ship without a captain has a bonus of 1', 'A fleet or colony body with no saved position is matched by the body the fleet orbits'],
})

// The bonus of a commander's rows of one bonus: no row at all is the game's neutral 1, a row whose value is missing is unknown (null).
const bonusOf = (value, rows, known) => (isNumber(rows) && rows > 0 ? (known === rows && isNumber(value) ? value : null) : 1)

// A class's Ordnance Factory totals as `{ modules, production, mounted, agrees }`: `modules` and `production` are results of 'ordnance.classModules' (the stored count) and 'ordnance.classProduction' (the race's ordnance production times it, BP a year), `mounted` the modules the class's own component lines add up to (null when they are not known) and `agrees` whether that is the stored count (null while either is unknown). `stored`: FCT_ShipClass.OrdnanceModules; `mounted`: the NumComponent of the class's Ordnance Factory Module lines; `rate`: FCT_Race.OrdnanceProduction.
export const classOrdnance = ({ stored, mounted = null, rate }) => {
  const modules = isNumber(stored) ? ofRule({ rule: 'ordnance.classModules', value: stored, inputs: { present: ['the class\'s ordnance factory modules'] } }) : unavailable({ rule: 'ordnance.classModules', missing: ['the class\'s ordnance factory modules'] })
  const missing = [...(isNumber(stored) ? [] : ['the class\'s ordnance factory modules']), ...(isNumber(rate) ? [] : ['the race\'s ordnance production'])]
  const production = missing.length ? unavailable({ rule: 'ordnance.classProduction', missing }) : ofRule({ rule: 'ordnance.classProduction', value: stored * rate, inputs: { present: ['the class\'s ordnance factory modules', 'the race\'s ordnance production'] }, assumptions: ['The ship has no damaged Ordnance Factory Module'] })
  const lines = isNumber(mounted) ? mounted : null

  return { modules, production, mounted: lines, agrees: lines === null || !isNumber(stored) ? null : lines === stored }
}

export const NO_ORBITAL_ORDNANCE = Object.freeze({ mineRate: null, colonies: Object.freeze({}) })

// What the orbital term of the race's colonies is made of, as `{ mineRate, colonies: { [PopulationID]: { ships } } }`: the race's mine production and, for each colony of the race, the ships mounting Orbital Mining Modules in the fleets the game counts for it (colonization.js `fleetCountsForColony`: a fleet of the race within one unit of the colony's body on both axes, assigned to the colony or to none): { ShipID, FleetID, ParentCommandID, FleetSystemID, modules (undamaged, null while the damage is not stored), crew (the share of the class crew aboard, null while unknown), captain (the Mining bonus, 1 without a captain, null while unknown), captained, unplaced (the save gives no place for the fleet or the colony's body, so the fleet may or may not be at the colony), contested (the fleet has no colony and lies within one unit of more than one colony of the race, so the game gives it to whichever asks first, which a save does not record) }. The Mining bonus of a lookup row the save does not confirm (`blocked` holds the bonus ID) leaves every captain unknown. A colony with no such ship is not in the map.
export const loadOrbitalOrdnance = async (database, { GameID, RaceID, blocked = NONE }) => {
  const [[race]] = await database.query(`select FCT_Race.MineProduction from FCT_Race where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`)
  const [places] = await database.query(`select FCT_Population.PopulationID, FCT_Population.RaceID, FCT_Population.SystemBodyID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`)
  const withheld = blocked.has(MINING_BONUS)
  const bonusTable = withheld ? 'select null as CommandID, null as BonusValue, null as Rows, null as Known where 0' : `select FCT_Commander.CommandID, max(FCT_CommanderBonuses.BonusValue) as BonusValue, count(*) as Rows, count(FCT_CommanderBonuses.BonusValue) as Known from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType = 1 and FCT_CommanderBonuses.BonusID = ${MINING_BONUS} group by FCT_Commander.CommandID`
  const [lines] = await database.query(`with VIR_Captains as materialized (${bonusTable}) select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Fleet.RaceID as FleetRaceID, FCT_Fleet.AssignedPopulationID, exists (select 1 from FCT_Population as VIR_Assigned where VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID) as AssignedExists, FCT_Fleet.OrbitBodyID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.ParentCommandID, FCT_Fleet.SystemID as FleetSystemID, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_ClassComponent.NumComponent as Designed, (select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID order by FCT_DamagedComponent.rowid limit 1) as Damaged, (select count(*) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID) as DamageRows, VIR_Captains.BonusValue as CaptainBonus, VIR_Captains.Rows as CaptainRows, VIR_Captains.Known as CaptainKnown, ${withheld ? 1 : 0} as BonusWithheld from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.GameID = FCT_Ship.GameID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${ORBITAL_MINING_MODULE} inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join VIR_Captains on VIR_Captains.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${GameID}`)
  const ships = new Map()
  const fleets = new Map()

  // A ship with two lines of the module adds the lines, as the game adds its class components.
  lines.forEach((row) => {
    const ship = ships.get(row.ShipID) || { ShipID: row.ShipID, FleetID: row.FleetID, ParentCommandID: row.ParentCommandID, FleetSystemID: row.FleetSystemID, crew: crewFraction({ CurrentCrew: row.CurrentCrew, ClassCrew: row.ClassCrew }), captain: row.BonusWithheld ? null : bonusOf(row.CaptainBonus, row.CaptainRows, row.CaptainKnown), captained: isNumber(row.CaptainRows) && row.CaptainRows > 0, modules: 0 }
    const damageKnown = row.DamageRows === 0 || isNumber(row.Damaged)

    ship.modules = ship.modules === null || !isNumber(row.Designed) || !damageKnown ? null : ship.modules + Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))
    ships.set(row.ShipID, ship)
    fleets.set(row.ShipID, { RaceID: row.FleetRaceID, AssignedPopulationID: row.AssignedPopulationID, AssignedExists: row.AssignedExists, OrbitBodyID: row.OrbitBodyID, Xcor: row.Xcor, Ycor: row.Ycor })
  })

  const colonies = {}

  // The colonies a ship's fleet may count for: those the game's test says it does, and those the save cannot settle (a fleet of the race that the colony may count and whose place is not given).
  ships.forEach((ship) => {
    const fleet = fleets.get(ship.ShipID)
    const reach = []

    places.forEach((colony) => {
      const placed = fleetPlaced(fleet, colony)

      if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {
        reach.push({ colony, unplaced: !placed })
      }
    })

    reach.forEach(({ colony, unplaced }) => {
      const held = colonies[colony.PopulationID] || { ships: [] }

      held.ships.push(Object.freeze({ ...ship, unplaced, contested: reach.length > 1 }))
      colonies[colony.PopulationID] = held
    })
  })

  Object.values(colonies).forEach((colony) => Object.freeze(colony))

  return Object.freeze({ mineRate: race ? race.MineProduction : null, colonies: Object.freeze(colonies) })
}

// The orbital term of one colony's ordnance capacity (BP/yr), a result of 'production.orbitalOrdnance': `source`, the colony's `{ ships }` of `loadOrbitalOrdnance` (undefined for a colony no fleet counts for, which adds 0), `mineRate` the race's mine production and `admins` the race's naval admin commands for the Production bonus at the Industrial share (`loadNavalAdmins`). The ships of one fleet add up first, then take the Production bonus of the fleet's naval admin chain at the system the fleet is in; a chain the save does not settle leaves the term unavailable, and so does a ship that may add (modules other than 0) and whose fleet's place is not given or whose fleet the game may give to another colony of the race.
export const orbitalOrdnanceTerm = ({ source, mineRate, admins = {} }) => {
  if (!source || source.ships.length === 0) {
    return ofRule({ rule: 'production.orbitalOrdnance', value: 0, inputs: { present: ['no ship with orbital mining modules is at the colony for it to count'] } })
  }

  const missing = []

  if (!isNumber(mineRate)) {
    missing.push('the race\'s mine production')
  }

  const fleets = new Map()

  source.ships.forEach((ship) => {
    const fleet = fleets.get(ship.FleetID) || { system: ship.FleetSystemID, command: ship.ParentCommandID, output: 0 }
    const known = [ship.modules, ship.crew, ship.captain].every(isNumber)

    if (!isNumber(ship.modules)) {
      missing.push('the undamaged modules of a ship with orbital mining modules (its class components or damage)')
    }

    if (!isNumber(ship.crew)) {
      missing.push('the crew of a ship with orbital mining modules or its class crew')
    }

    if (!isNumber(ship.captain)) {
      missing.push('the captain\'s Mining bonus of a ship with orbital mining modules')
    }

    if (ship.modules !== 0 && ship.unplaced) {
      missing.push('where a fleet with orbital mining modules is (the save gives no position for the fleet or the colony\'s body, and no body the fleet orbits)')
    }

    if (ship.modules !== 0 && ship.contested) {
      missing.push('which colony of the race an unassigned fleet with orbital mining modules goes to: it is within one unit of more than one, and the game gives it to the first that asks')
    }

    fleet.output = fleet.output === null || !known ? null : fleet.output + ship.modules * ship.crew * ship.captain
    fleets.set(ship.FleetID, fleet)
  })

  let output = 0

  fleets.forEach((fleet) => {
    if (!isNumber(fleet.command)) {
      missing.push('the naval admin command of a fleet with orbital mining modules')

      return
    }

    const chain = navalAdminChain(admins, fleet.system, fleet.command)

    if (chain.bonus === null) {
      missing.push(chain.unknown || 'the naval admin chain\'s Production bonus')
    } else if (fleet.output !== null) {
      output += fleet.output * chain.bonus
    }
  })

  const gaps = [...new Set(missing)]

  return gaps.length ? unavailable({ rule: 'production.orbitalOrdnance', missing: gaps }) : ofRule({ rule: 'production.orbitalOrdnance', value: mineRate * output, inputs: { present: ['the race\'s mine production', 'the ships\' undamaged modules, crews and captains', 'the naval admin chain'] }, assumptions: source.ships.some((ship) => !ship.captained) ? ['A ship without a captain has a bonus of 1'] : [] })
}

// A colony's ordnance capacity with the orbital term added after the installations' product, which the term does not multiply: a result of `rule` (the capacity rule of the installations), unavailable when either part is.
export const withOrbitalTerm = ({ rule, installations, orbital }) => combine({ rule, parts: { installations, orbital }, compute: (values) => values.installations + values.orbital })

// The orbital term of each of `populationIds` (an object of results of 'production.orbitalOrdnance' by PopulationID), from `source` (`loadOrbitalOrdnance`) and the race's naval admin commands for the Production bonus at the Industrial share (`admins`, from `loadNavalAdmins`, needed only when a colony has such a ship).
export const orbitalOrdnanceTerms = ({ source, admins = {}, populationIds }) => Object.fromEntries(populationIds.map((id) => [id, orbitalOrdnanceTerm({ source: source.colonies[id], mineRate: source.mineRate, admins })]))
