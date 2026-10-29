import { linkTo, place } from '../deep-links'
import { isKnownNumber } from '../math'
import { TRAINING_COMMAND, TRAINING_JOINS, allOf, amount, anyOf, bodyText, checksOf, figure, lacking, needInputs, needsCell, needsSignature, needWords, readMiningSites, rowsOf, systemText, verdictRows } from './common'

export const group = { key: 'fleets', title: 'Fleets', summary: 'Fleets that sit idle, carry cargo with no orders or hold orders they cannot carry out.' }

export const IDLE_FLEETS_KEY = 'idle-fleets'

// The words that open the line under an idle fleet, before the name of the place.
export const LOCATION_WORDS = Object.freeze({ parked: 'At', orbiting: 'Orbiting', jumpPoint: 'At a jump point in', deepSpace: 'Deep space in' })

// The places whose parked fleets the warning leaves out: the title and the option name them.
export const PARKED_PLACES = 'colonies and anchorages'

const idleFleetLocation = (fleet) => {
  if (fleet.ParkedName) {
    return `${LOCATION_WORDS.parked} ${fleet.ParkedName}`
  } else if (fleet.OrbitBodyID > 0) {
    return `${LOCATION_WORDS.orbiting} ${bodyText(fleet)}`
  } else if (fleet.JumpPointID) {
    return `${LOCATION_WORDS.jumpPoint} ${systemText(fleet)}`
  }

  return `${LOCATION_WORDS.deepSpace} ${systemText(fleet)}`
}

const idleFleetOrders = (fleet) => [fleet.StandingOrders ? 'Standing orders' : null, fleet.ConditionalOrders ? 'Conditional orders' : null].filter(Boolean).join(', ') || '—'

const cargoLabel = (ship, count) => [
  ship.Colonists ? `${count(ship.Colonists)} colonists` : null,
  ship.Installations ? `${count(ship.Installations, 2)} installations` : null,
  ship.Minerals ? `${count(ship.Minerals)} t of minerals` : null,
  ship.Other ? `${count(ship.Other, 2)} other cargo` : null,
  ship.Unrecorded ? `${amount(ship.Unrecorded, 'cargo entry', 'cargo entries')} with no amount recorded` : null,
].filter(Boolean).join(', ')

// The fleet's flags the idle and cargo checks need: a mobile military fleet, as 1, or null while one of them is not stored.
const MILITARY_FLEET = '(FCT_Fleet.ShippingLine = 0 and FCT_Fleet.CivilianFunction = 0 and FCT_Fleet.Speed > 1)'

const IDLE_FLEET = `(${MILITARY_FLEET} and FCT_Fleet.AnchorFleetID = 0 and (case when VIR_Ships.Available > 0 then 1 else null end))`

const FLEET_INPUTS = { ShippingLine: 'whether the fleet is a shipping line', CivilianFunction: 'the fleet\'s civilian function', Speed: 'the fleet\'s speed' }

// A cargo hold entry that holds something, as 1, or null while an amount is not stored and none is known to hold something.
const LOADED = '(case when sum(case when FCT_ShipCargo.Amount > 0 then 1 else 0 end) > 0 then 1 when sum(case when FCT_ShipCargo.Amount is null then 1 else 0 end) > 0 then null else 0 end)'

const ORPHANED = '((FCT_Fleet.AssignedPopulationID <> 0) and FCT_Population.PopulationID is null)'

// The component types of a station: a Maintenance Module and a Recreational Module.
const MAINTENANCE_MODULE = 48
const RECREATIONAL_MODULE = 57

// The game's own distance of a ship at a colony or at a fleet with recreational modules: the same system and less than this many km apart on each axis.
const NEAR = 1
const AXES = ['Xcor', 'Ycor']

const UNNAMED = { colony: 'an unnamed colony', fleet: 'an unnamed fleet' }

export const PARKED_GAPS = {
  fleet: 'the system and position of the fleet',
  colony: 'the system and position of the body of a colony',
  station: 'the system and position of a fleet that may hold recreational or maintenance modules',
  componentType: 'the type of a component a ship of a fleet that may hold recreational or maintenance modules carries',
  shipClass: 'the class of a ship of a fleet that may hold recreational or maintenance modules',
  modules: 'the number of recreational or maintenance modules a ship holds or has damaged',
  command: 'the type of the naval administration the fleet sits under',
}

// The populations of the race with the position of their bodies.
const populationsQuery = ({ GameID, RaceID }) => `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by FCT_Population.PopulationID`

// The damaged modules of a ship's component line, and whether one of them has no stored number.
const DAMAGED_MODULES = 'coalesce((select sum(FCT_DamagedComponent.Number) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID), 0)'

const DAMAGE_UNKNOWN = 'exists (select 1 from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID and FCT_DamagedComponent.Number is null)'

// The undamaged modules of a ship's component line: the class's count less the ship's damaged ones, null while the count or a damaged number is not stored.
const UNDAMAGED_MODULES = `(case when FCT_ClassComponent.NumComponent is null or ${DAMAGE_UNKNOWN} then null else max(FCT_ClassComponent.NumComponent - ${DAMAGED_MODULES}, 0) end)`

// The ships that count for a station: those not carried in a hangar.
const UNDOCKED = 'coalesce(FCT_Ship.MothershipID, 0) = 0'

// The inputs between a ship and a module that are not stored, each counted by ship whatever the types of the ship's other component lines: no stored class or one that names no class row, and a component line present for the class (told from an absent one by the joined key, `ClassID`) whose component is not stored, has no definition row or has no stored type.
const SHIP_CLASS_UNKNOWN = '(FCT_Ship.ShipClassID is null or FCT_ShipClass.ShipClassID is null)'

const COMPONENT_TYPE_UNKNOWN = '(FCT_ClassComponent.ClassID is not null and FCT_ShipDesignComponents.ComponentTypeID is null)'

// The undamaged modules of one type in a fleet's ship lines, and how many lines of it have no stored count.
const moduleColumns = (type, name) => `sum(case when FCT_ShipDesignComponents.ComponentTypeID = ${type} then ${UNDAMAGED_MODULES} end) as ${name}Working, sum(case when FCT_ShipDesignComponents.ComponentTypeID = ${type} and ${UNDAMAGED_MODULES} is null then 1 else 0 end) as ${name}Gaps`

// The race's fleets with the undamaged modules of both types on the ships not docked in a hangar, how many lines of each have no stored count, and how many ships have an input to a module that is not stored; only the lines that bear on a station are read.
const stationsQuery = ({ GameID, RaceID }) => `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, ${moduleColumns(MAINTENANCE_MODULE, 'Maintenance')}, ${moduleColumns(RECREATIONAL_MODULE, 'Recreational')}, count(distinct case when ${COMPONENT_TYPE_UNKNOWN} then FCT_Ship.ShipID end) as Untyped, count(distinct case when ${SHIP_CLASS_UNKNOWN} then FCT_Ship.ShipID end) as Unclassed from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID left join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and ${UNDOCKED} and (FCT_ShipDesignComponents.ComponentTypeID in (${MAINTENANCE_MODULE}, ${RECREATIONAL_MODULE}) or ${SHIP_CLASS_UNKNOWN} or ${COMPONENT_TYPE_UNKNOWN}) group by FCT_Fleet.FleetID order by FCT_Fleet.FleetName, FCT_Fleet.FleetID`

// The fleets of those rows, each with its modules by type, in the order of the rows.
const stationsOf = (rows) => rows.map((row) => ({ FleetID: row.FleetID, FleetName: row.FleetName, SystemID: row.SystemID, Xcor: row.Xcor, Ycor: row.Ycor, Modules: { [MAINTENANCE_MODULE]: { Working: row.MaintenanceWorking, Gaps: row.MaintenanceGaps }, [RECREATIONAL_MODULE]: { Working: row.RecreationalWorking, Gaps: row.RecreationalGaps } }, Untyped: row.Untyped, Unclassed: row.Unclassed }))

const placeKnown = (row) => ['SystemID', ...AXES].every((column) => isKnownNumber(row[column]))

// Whether `other` lies at the fleet's place by the game's test: the same system and within 1 km on both axes (1, 0, or null while a position it needs is not stored; one axis that settles it is enough).
const atPlace = (fleet, other) => allOf(isKnownNumber(fleet.SystemID) && isKnownNumber(other.SystemID) ? Number(fleet.SystemID) === Number(other.SystemID) : null, ...AXES.map((axis) => (isKnownNumber(fleet[axis]) && isKnownNumber(other[axis]) ? Math.abs(Number(fleet[axis]) - Number(other[axis])) < NEAR : null)))

// Whether a station has an undamaged module of the type: 1, 0, or null while a line of it has no stored count and none known to work is left, or while a component line of the station has no stored type or a ship of it no stored class (it could be a module of this type).
const holds = (station, type) => {
  const modules = station.Modules[type]

  return modules && modules.Working > 0 ? 1 : (modules && modules.Gaps > 0) || station.Untyped > 0 || station.Unclassed > 0 ? null : 0
}

// Whether a module line of a type has no stored count and none of the type is known to work.
const countUnknown = (station, type) => Boolean(station.Modules[type]) && !(station.Modules[type].Working > 0) && station.Modules[type].Gaps > 0

// Whether a station can support the fleet: a maintenance module any fleet takes, a recreational one every fleet but one under a Training command, which the game gives no shore leave.
const supports = (station, fleet) => anyOf(holds(station, MAINTENANCE_MODULE), allOf(holds(station, RECREATIONAL_MODULE), isKnownNumber(fleet.Training) ? Number(!fleet.Training) : null))

const positionGaps = (fleet, other, name) => [...(placeKnown(fleet) ? [] : [PARKED_GAPS.fleet]), ...(placeKnown(other) ? [] : [name])]

const stationGaps = (fleet, station) => [
  ...(atPlace(fleet, station) === null ? positionGaps(fleet, station, PARKED_GAPS.station) : []),
  ...(supports(station, fleet) === null && station.Untyped > 0 ? [PARKED_GAPS.componentType] : []),
  ...(supports(station, fleet) === null && station.Unclassed > 0 ? [PARKED_GAPS.shipClass] : []),
  ...(supports(station, fleet) === null && (countUnknown(station, MAINTENANCE_MODULE) || countUnknown(station, RECREATIONAL_MODULE)) ? [PARKED_GAPS.modules] : []),
  ...(supports(station, fleet) === null && !isKnownNumber(fleet.Training) && holds(station, RECREATIONAL_MODULE) !== 0 ? [PARKED_GAPS.command] : []),
]

// Where a fleet is parked: `Parked` (1 at a population of the race or at another fleet that supports it, 0, or null while the fleet's own system or position, a position, a module count or component type, or its command's type that could decide it is not stored), `ParkedName` (the population whose body the fleet orbits, else the largest there, else the first station by name) and `ParkedGaps`, the inputs a null leaves out.
const parkedAt = (fleet, populations, stations) => {
  const colonies = populations.map((population) => ({ population, verdict: atPlace(fleet, population) }))
  const anchorages = stations.filter((station) => station.FleetID !== fleet.FleetID).map((station) => ({ station, verdict: allOf(atPlace(fleet, station), supports(station, fleet)) }))
  const colony = colonies.filter((entry) => entry.verdict === 1).map((entry) => entry.population).sort((a, b) => Number(b.SystemBodyID === fleet.OrbitBodyID) - Number(a.SystemBodyID === fleet.OrbitBodyID) || (b.Population || 0) - (a.Population || 0))[0]
  const anchorage = anchorages.find((entry) => entry.verdict === 1)

  return {
    Parked: placeKnown(fleet) ? anyOf(...colonies.map((entry) => entry.verdict), ...anchorages.map((entry) => entry.verdict)) : null,
    ParkedName: colony ? colony.PopName || UNNAMED.colony : anchorage ? anchorage.station.FleetName || UNNAMED.fleet : null,
    ParkedGaps: [...new Set([...(placeKnown(fleet) ? [] : [PARKED_GAPS.fleet]), ...colonies.filter((entry) => entry.verdict === null).flatMap((entry) => positionGaps(fleet, entry.population, PARKED_GAPS.colony)), ...anchorages.filter((entry) => entry.verdict === null).flatMap((entry) => stationGaps(fleet, entry.station))])],
  }
}

export const checks = checksOf([
  {
    key: IDLE_FLEETS_KEY,
    group: group.key,
    severity: 'attention',
    title: (count, options = {}) => `${amount(count, 'idle fleet')}${options.idleFleetsAtColonies ? '' : ` away from the ${PARKED_PLACES}`}`,
    rule: 'A mobile military fleet with no orders and at least one ship that is neither overhauling nor docked; fleets following another fleet are left out, and so are fleets parked at a colony or an anchorage unless the option is on. A fleet is parked when it lies within 1 km, on both axes, of a colony (a deep space population included) or of another fleet with an undamaged recreational or maintenance module aboard a ship that is not docked in a hangar; a fleet under a Training command counts only at a colony or at a maintenance module.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Fleet.ShippingLine, CivilianFunction, Speed, AnchorFleetID, SystemID, Xcor, Ycor, ParentCommandID', 'FCT_Ship.MaintenanceState, MothershipID, ShipClassID', 'FCT_ShipClass.ShipClassID', 'FCT_MoveOrders', 'FCT_Population.SystemID, SystemBodyID, Population', 'FCT_SystemBody.Xcor, Ycor', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent.Number', 'FCT_NavalAdminCommand.AdminCommandTypeID', 'DIM_NavalAdminCommandType.Description'],
      note: 'A presence check on stored rows: a fleet that is mobile (speed above 1), military and not following another, with no move orders and a ship that is neither in maintenance nor carried by a mothership. It is parked, and left out, when a population of the race in its system has its body within 1 km of the fleet on both axes (the game\'s own test of a ship at a colony for shore leave and maintenance), or another fleet of the race in its system lies within 1 km of it with an undamaged recreational or maintenance module (component types 57 and 48) on a ship that is not docked in a hangar; a module ship docked in a hangar does not count. A fleet under a Training command is parked only at a population or at a maintenance module, as the game gives it no shore leave; parked means at a place that can support the fleet, not that the game is maintaining it now. It is the same place at the time of the save, and the capacity of a maintenance module and the speed or orders of its fleet are not tested. A fleet with a flag, its speed, its position, a ship\'s state, a module count, a ship\'s class, a component\'s type, a damaged count or its command\'s type not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'ships', text: 'Ships', align: 'end' },
      { key: 'orders', text: 'Orders' },
    ],
    options: ['idleFleetsAtColonies'],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const [fleets, populations, stations] = await Promise.all([
        rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.ParentCommandID, FCT_Fleet.ShippingLine, FCT_Fleet.CivilianFunction, FCT_Fleet.Speed, FCT_Fleet.AnchorFleetID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.OrbitBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, VIR_Ships.Ships, VIR_Ships.Available, VIR_Ships.Undecided, ${IDLE_FLEET} as Verdict, ${TRAINING_COMMAND} as Training, (select FCT_JumpPoint.WarpPointID from FCT_JumpPoint where FCT_JumpPoint.SystemID = FCT_Fleet.SystemID and FCT_JumpPoint.GameID = FCT_Fleet.GameID and FCT_JumpPoint.Xcor = FCT_Fleet.Xcor and FCT_JumpPoint.Ycor = FCT_Fleet.Ycor limit 1) as JumpPointID, (select count(*) from FCT_FleetStandingOrder where FCT_FleetStandingOrder.FleetID = FCT_Fleet.FleetID) as StandingOrders, (select count(*) from FCT_FleetConditionalOrder where FCT_FleetConditionalOrder.FleetID = FCT_Fleet.FleetID and FCT_FleetConditionalOrder.GameID = FCT_Fleet.GameID) as ConditionalOrders from FCT_Fleet inner join (select FCT_Ship.FleetID, count(*) as Ships, sum(case when FCT_Ship.MaintenanceState <> 2 and FCT_Ship.MothershipID = 0 then 1 else 0 end) as Available, sum(case when (FCT_Ship.MaintenanceState <> 2 and FCT_Ship.MothershipID = 0) is null then 1 else 0 end) as Undecided from FCT_Ship where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} group by FCT_Ship.FleetID) as VIR_Ships on VIR_Ships.FleetID = FCT_Fleet.FleetID and (VIR_Ships.Available > 0 or VIR_Ships.Undecided > 0) left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID ${TRAINING_JOINS} where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and ${IDLE_FLEET} is not 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) order by FCT_Fleet.FleetName`),
        rowsOf(ctx, populationsQuery(ctx)),
        rowsOf(ctx, stationsQuery(ctx)),
      ])

      const anchorages = stationsOf(stations)
      const parked = fleets.map((fleet) => ({ ...fleet, ...parkedAt(fleet, populations, anchorages) }))

      return verdictRows(ctx, parked, {
        verdict: (fleet) => (ctx.options.idleFleetsAtColonies ? fleet.Verdict : allOf(fleet.Verdict, fleet.Parked === null ? null : Number(!fleet.Parked))),
        missing: (fleet) => [...lacking(fleet, { ...FLEET_INPUTS, AnchorFleetID: 'the fleet it follows' }), ...(fleet.Available > 0 || !(fleet.Undecided > 0) ? [] : ['the maintenance state or the mothership of a ship']), ...(ctx.options.idleFleetsAtColonies || fleet.Parked !== null ? [] : fleet.ParkedGaps)],
        build: (fleet) => ({
          id: `fleet:${fleet.FleetID}`,
          cells: { fleet: fleet.FleetName, ships: ctx.count(fleet.Ships), orders: idleFleetOrders(fleet) },
          caption: idleFleetLocation(fleet),
          link: linkTo.routes({ from: place.fleet(fleet.FleetID) }),
        }),
      })
    },
  },
  {
    key: 'idle-cargo-ships',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'ship')} carrying cargo with no orders`,
    rule: 'A ship of a mobile military fleet with no orders still holds colonists, installations, minerals or other cargo; civilian shipping lines wait for orders by design and are left out.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Fleet.ShippingLine, CivilianFunction, Speed', 'FCT_MoveOrders', 'FCT_ShipCargo.Amount'],
      note: 'A presence check on stored rows: a ship of a mobile military fleet with no move orders and a cargo row with an amount above 0. A ship with a fleet flag or speed not stored, or only cargo rows without an amount, is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'cargo', text: 'Cargo' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.ShippingLine, FCT_Fleet.CivilianFunction, FCT_Fleet.Speed, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ClassName, FCT_RaceSysSurvey.Name as SystemName, sum(case when FCT_ShipCargo.CargoTypeID = 1 then FCT_ShipCargo.Amount else 0 end) as Colonists, sum(case when FCT_ShipCargo.CargoTypeID = 2 then FCT_ShipCargo.Amount else 0 end) as Installations, sum(case when FCT_ShipCargo.CargoTypeID = 3 then FCT_ShipCargo.Amount else 0 end) as Minerals, sum(case when FCT_ShipCargo.CargoTypeID not in (1, 2, 3) then FCT_ShipCargo.Amount else 0 end) as Other, sum(case when FCT_ShipCargo.Amount is null then 1 else 0 end) as Unrecorded, sum(case when FCT_ShipCargo.Amount > 0 then 1 else 0 end) as Loaded, (${MILITARY_FLEET} and ${LOADED}) as Verdict from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ShipCargo on FCT_ShipCargo.ShipID = FCT_Ship.ShipID and (FCT_ShipCargo.Amount > 0 or FCT_ShipCargo.Amount is null) left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and ${MILITARY_FLEET} is not 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) group by FCT_Ship.ShipID having ${LOADED} is not 0 order by FCT_Fleet.FleetName, FCT_Ship.ShipName`)

      return verdictRows(ctx, ships, {
        missing: (ship) => [...lacking(ship, FLEET_INPUTS), ...(ship.Loaded > 0 || !(ship.Unrecorded > 0) ? [] : ['the amount of a cargo entry'])],
        build: (ship) => ({
          id: `ship:${ship.ShipID}`,
          cells: { ship: ship.ShipName, cargo: `${cargoLabel(ship, ctx.count)} in ${systemText(ship)}` },
          caption: ship.FleetName,
          link: linkTo.routes({ from: place.fleet(ship.FleetID) }),
        }),
      })
    },
  },
  {
    key: 'blind-survey-orders',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'survey order')} without the sensors for them`,
    rule: 'A fleet has a geological or gravitational survey order and none of its ships carries that sensor.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_MoveOrders.MoveActionID', 'FCT_ShipClass.GeoSurvey, GravSurvey'],
      note: 'A presence check on stored class values: a survey order whose fleet has no ship of a class with that sensor. An order whose fleet has a class with the sensor value not stored, and none known to carry it, is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'order', text: 'Order' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const orders = await rowsOf(ctx, `select VIR_Orders.*, (case when VIR_Orders.MoveActionID = 9 then (case when VIR_Orders.GeoShips > 0 then 0 when VIR_Orders.GeoGaps > 0 then null else 1 end) when VIR_Orders.MoveActionID = 12 then (case when VIR_Orders.GravShips > 0 then 0 when VIR_Orders.GravGaps > 0 then null else 1 end) else 0 end) as Verdict from (select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_MoveOrders.MoveOrderID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.Description, sum(case when FCT_ShipClass.GeoSurvey > 0 then 1 else 0 end) as GeoShips, sum(case when FCT_ShipClass.GeoSurvey is null then 1 else 0 end) as GeoGaps, sum(case when FCT_ShipClass.GravSurvey > 0 then 1 else 0 end) as GravShips, sum(case when FCT_ShipClass.GravSurvey is null then 1 else 0 end) as GravGaps from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_MoveOrders.MoveActionID in (9, 12) group by FCT_MoveOrders.MoveOrderID) as VIR_Orders where Verdict is not 0 order by VIR_Orders.FleetName, VIR_Orders.MoveOrder`)

      return verdictRows(ctx, orders, {
        missing: (order) => [order.MoveActionID === 9 ? 'the geological survey strength of a ship class' : 'the gravitational survey strength of a ship class'],
        build: (order) => ({
          id: `order:${order.MoveOrderID}`,
          cells: { fleet: order.FleetName, order: order.Description },
          caption: `No ship in the fleet has a ${order.MoveActionID === 9 ? 'geological' : 'gravitational'} survey sensor`,
          link: linkTo.routes({ from: place.fleet(order.FleetID) }),
        }),
      })
    },
  },
  {
    key: 'stranded-miners',
    group: group.key,
    severity: 'needs-action',
    material: 'another prerequisite of mining being missing',
    captured: [needWords],
    title: (count) => `${amount(count, 'orbital mining fleet')} that can't mine where they are`,
    rule: 'A fleet with mining modules and no orders orbits a body where it can\'t mine: no colony of the race there to take the output, a body wider than the orbital mining limit, no mineral deposit, no mine production, no working module or no crew. Each missing prerequisite is named; a body the race has not surveyed is listed apart, as its deposits are not known.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Fleet.OrbitBodyID, AssignedPopulationID, MothershipID', 'FCT_Population.SystemBodyID', 'FCT_ShipClass.Crew', 'FCT_Ship.CurrentCrew', 'FCT_ClassComponent.NumComponent', 'FCT_DamagedComponent.Number', 'FCT_SystemBodySurveys', 'FCT_MineralDeposit.Amount', 'FCT_SystemBody.Radius', 'FCT_Race.MaximumOrbitalMiningDiameter, MineProduction'],
      note: 'The surveyed state, the deposits, the body\'s diameter against the race\'s orbital mining limit, the working modules and the crew aboard are stored facts; a surveyed body with no deposit left (empty or exhausted: the save does not tell them apart) is confirmed, while a body the race has not surveyed is unknown, not empty. That the output goes to the race\'s colony on the body, or to the colony the fleet is assigned to, is read from the game\'s rules and applies only to a save whose game rules are known. A fleet with a deposit amount, a diameter, the limit, a class\'s modules or the crew not stored is listed apart, as not evaluated.',
      assumptions: ['Orbital mining works on a body up to the race\'s stored maximum diameter, the body\'s diameter being twice its radius.', 'A fleet not assigned to a colony, or assigned to one that is gone, is assigned to the colony on its body.', 'A fleet crewed in part still mines; only a fleet with no crew aboard is listed.'],
    },
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'reason', text: 'Missing' },
      { key: 'modules', text: 'Modules', align: 'end' },
    ],
    async read(ctx) {
      const { fleets } = await readMiningSites(ctx)

      const sites = fleets.map((site) => ({ ...site, Verdict: site.producing === null ? null : 1 - site.producing }))

      return verdictRows(ctx, sites, {
        missing: (site) => needInputs(site),
        build: (site) => ({
          id: `fleet:${site.id}`,
          cells: { fleet: site.row.FleetName, reason: needsCell(ctx, site), modules: figure(ctx, site.modules, 'the mining modules of a ship class') },
          caption: bodyText(site.row),
          link: linkTo.routes({ from: place.fleet(site.id) }),
          signature: needsSignature(site),
        }),
      })
    },
  },
  {
    key: 'orphaned-fleets',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'fleet')} assigned to a colony that no longer exists`,
    rule: 'A fleet is assigned to a population that is no longer in the save, so it can\'t be supplied or reassigned until it is assigned to a colony again.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Fleet.AssignedPopulationID', 'FCT_Population.PopulationID'],
      note: 'A presence check on stored rows: a fleet assigned to a population id with no population row. A fleet whose assignment is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'system', text: 'System' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.AssignedPopulationID, ${ORPHANED} as Verdict, FCT_RaceSysSurvey.Name as SystemName from FCT_Fleet left join FCT_Population on FCT_Population.PopulationID = FCT_Fleet.AssignedPopulationID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and ${ORPHANED} is not 0 order by FCT_Fleet.FleetName`)

      return verdictRows(ctx, fleets, {
        missing: (fleet) => lacking(fleet, { AssignedPopulationID: 'the colony the fleet is assigned to' }),
        build: (fleet) => ({
          id: `fleet:${fleet.FleetID}`,
          cells: { fleet: fleet.FleetName, system: fleet.SystemName || 'An unknown system' },
          link: linkTo.routes({ from: place.fleet(fleet.FleetID) }),
        }),
      })
    },
  },
])
