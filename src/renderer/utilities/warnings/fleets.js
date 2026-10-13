import { linkTo, place } from '../deep-links'
import { amount, bodyText, checksOf, lacking, rowsOf, systemText, unknownCell, verdictRows } from './common'

export const group = { key: 'fleets', title: 'Fleets', summary: 'Fleets that sit idle, carry cargo with no orders or hold orders they cannot carry out, so they can be given something to do.' }

export const IDLE_FLEETS_KEY = 'idle-fleets'

const idleFleetLocation = (fleet) => {
  if (fleet.ColonyName) {
    return `At ${fleet.ColonyName}`
  } else if (fleet.OrbitBodyID > 0) {
    return `Orbiting ${bodyText(fleet)}`
  } else if (fleet.JumpPointID) {
    return `At a jump point in ${systemText(fleet)}`
  }

  return `Deep space in ${systemText(fleet)}`
}

const idleFleetOrders = (fleet) => [fleet.StandingOrders ? 'Standing orders' : null, fleet.ConditionalOrders ? 'Conditional orders' : null].filter(Boolean).join(', ') || '—'

const strandedMinerReason = (fleet, count) => {
  if (fleet.Reason === 'not surveyed') {
    return 'Body not surveyed'
  } else if (fleet.Reason === 'no deposits') {
    return 'No minerals here'
  }

  return `${count(fleet.Diameter)} km across, more than the ${count(fleet.MaximumDiameter)} km orbital mining can handle`
}

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

const MINING_FLEET = '(case when sum(case when FCT_ShipClass.MiningModules > 0 then 1 else 0 end) > 0 then 1 else null end)'

// Whether the deposits of a body say it holds minerals: 0 with one, null with none known and one whose amount is not stored, else 1 for no deposit.
const NO_DEPOSITS = '(case when VIR_Deposits.Deposits > 0 then 0 when VIR_Deposits.Gaps > 0 then null else 1 end)'
const TOO_LARGE = '(FCT_SystemBody.Radius * 2 > FCT_Race.MaximumOrbitalMiningDiameter)'
const STRANDED = `((FCT_SystemBodySurveys.SystemBodyID is null) or ${NO_DEPOSITS} or ${TOO_LARGE})`

const ORPHANED = '((FCT_Fleet.AssignedPopulationID <> 0) and FCT_Population.PopulationID is null)'

export const checks = checksOf([
  {
    key: IDLE_FLEETS_KEY,
    group: group.key,
    severity: 'attention',
    title: (count, options = {}) => `${amount(count, 'idle fleet')}${options.idleFleetsAtColonies ? '' : ' away from the colonies'}`,
    rule: 'A mobile military fleet with no orders and at least one ship that is neither overhauling nor docked; fleets following another fleet are left out, and so are fleets parked at the colonies unless the option is on.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Fleet.ShippingLine, CivilianFunction, Speed, AnchorFleetID', 'FCT_Ship.MaintenanceState, MothershipID', 'FCT_MoveOrders'],
      note: 'A presence check on stored rows: a fleet that is mobile (speed above 1), military and not following another, with no move orders and a ship that is neither in maintenance nor carried by a mothership. A fleet with a flag, its speed or a ship\'s state not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'ships', text: 'Ships', align: 'end' },
      { key: 'orders', text: 'Orders' },
    ],
    options: ['idleFleetsAtColonies'],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Fleet.ShippingLine, FCT_Fleet.CivilianFunction, FCT_Fleet.Speed, FCT_Fleet.AnchorFleetID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.OrbitBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, VIR_Ships.Ships, VIR_Ships.Available, VIR_Ships.Undecided, ${IDLE_FLEET} as Verdict, (select FCT_Population.PopName from FCT_Population where FCT_Population.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_Population.RaceID = FCT_Fleet.RaceID and FCT_Population.GameID = FCT_Fleet.GameID and FCT_Fleet.OrbitBodyID > 0 limit 1) as ColonyName, (select FCT_JumpPoint.WarpPointID from FCT_JumpPoint where FCT_JumpPoint.SystemID = FCT_Fleet.SystemID and FCT_JumpPoint.GameID = FCT_Fleet.GameID and FCT_JumpPoint.Xcor = FCT_Fleet.Xcor and FCT_JumpPoint.Ycor = FCT_Fleet.Ycor limit 1) as JumpPointID, (select count(*) from FCT_FleetStandingOrder where FCT_FleetStandingOrder.FleetID = FCT_Fleet.FleetID) as StandingOrders, (select count(*) from FCT_FleetConditionalOrder where FCT_FleetConditionalOrder.FleetID = FCT_Fleet.FleetID and FCT_FleetConditionalOrder.GameID = FCT_Fleet.GameID) as ConditionalOrders from FCT_Fleet inner join (select FCT_Ship.FleetID, count(*) as Ships, sum(case when FCT_Ship.MaintenanceState <> 2 and FCT_Ship.MothershipID = 0 then 1 else 0 end) as Available, sum(case when (FCT_Ship.MaintenanceState <> 2 and FCT_Ship.MothershipID = 0) is null then 1 else 0 end) as Undecided from FCT_Ship where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} group by FCT_Ship.FleetID) as VIR_Ships on VIR_Ships.FleetID = FCT_Fleet.FleetID and (VIR_Ships.Available > 0 or VIR_Ships.Undecided > 0) left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and ${IDLE_FLEET} is not 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) order by FCT_Fleet.FleetName`)

      return verdictRows(ctx, fleets.filter((fleet) => ctx.options.idleFleetsAtColonies || !fleet.ColonyName), {
        missing: (fleet) => [...lacking(fleet, { ...FLEET_INPUTS, AnchorFleetID: 'the fleet it follows' }), ...(fleet.Available > 0 || !(fleet.Undecided > 0) ? [] : ['the maintenance state or the mothership of a ship'])],
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
    title: (count) => `${amount(count, 'orbital mining fleet')} at bodies they can't mine`,
    rule: 'A fleet with mining modules and no orders orbits an unsurveyed body, a body without minerals, or one wider than the orbital mining limit.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_ShipClass.MiningModules', 'FCT_SystemBodySurveys', 'FCT_MineralDeposit.Amount', 'FCT_SystemBody.Radius', 'FCT_Race.MaximumOrbitalMiningDiameter'],
      note: 'The surveyed state and the deposits are stored rows, but the width limit is the race\'s stored orbital mining diameter compared with the body\'s diameter, a reading of the limit that is not checked against the game. A fleet with a deposit amount, a diameter, the limit or a class\'s mining modules not stored is listed apart, as not evaluated.',
      assumptions: ['Orbital mining works on a body up to the race\'s stored maximum diameter, the body\'s diameter being twice its radius.'],
    },
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'reason', text: 'Why' },
      { key: 'modules', text: 'Modules', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.Radius, FCT_SystemBody.Radius * 2 as Diameter, FCT_Race.MaximumOrbitalMiningDiameter as MaximumDiameter, VIR_Deposits.Deposits, VIR_Deposits.Gaps, sum(FCT_ShipClass.MiningModules) as MiningModules, sum(case when FCT_ShipClass.MiningModules > 0 then 1 else 0 end) as ModuleClasses, sum(case when FCT_ShipClass.MiningModules is null then 1 else 0 end) as ModuleGaps, (${STRANDED} and ${MINING_FLEET}) as Verdict, case when FCT_SystemBodySurveys.SystemBodyID is null then 'not surveyed' when ${NO_DEPOSITS} = 1 then 'no deposits' when ${TOO_LARGE} = 1 then 'too large' else 'unknown' end as Reason from FCT_Fleet inner join FCT_Race on FCT_Race.RaceID = FCT_Fleet.RaceID and FCT_Race.GameID = FCT_Fleet.GameID inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and (FCT_ShipClass.MiningModules > 0 or FCT_ShipClass.MiningModules is null) inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Fleet.RaceID and FCT_SystemBodySurveys.GameID = FCT_Fleet.GameID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join (select FCT_MineralDeposit.SystemBodyID, sum(case when FCT_MineralDeposit.Amount > 0 then 1 else 0 end) as Deposits, sum(case when FCT_MineralDeposit.Amount is null then 1 else 0 end) as Gaps from FCT_MineralDeposit where FCT_MineralDeposit.GameID = ${GameID} and (FCT_MineralDeposit.Amount > 0 or FCT_MineralDeposit.Amount is null) group by FCT_MineralDeposit.SystemBodyID) as VIR_Deposits on VIR_Deposits.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.SystemBodyID is not null where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.OrbitBodyID > 0 and FCT_Ship.MothershipID = 0 and ${STRANDED} is not 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) group by FCT_Fleet.FleetID having ${MINING_FLEET} is not 0 order by FCT_Fleet.FleetName`)

      return verdictRows(ctx, fleets, {
        missing: (fleet) => [
          ...lacking(fleet, { Radius: 'the diameter of the body', MaximumDiameter: 'the race\'s orbital mining diameter limit' }),
          ...(fleet.Deposits > 0 || !(fleet.Gaps > 0) ? [] : ['the amount of a mineral deposit on the body']),
          ...(fleet.ModuleClasses > 0 || !(fleet.ModuleGaps > 0) ? [] : ['the mining modules of a ship class']),
        ],
        build: (fleet) => ({
          id: `fleet:${fleet.FleetID}`,
          cells: { fleet: fleet.FleetName, reason: fleet.Reason === 'unknown' ? unknownCell(ctx, ['a stored input the reason rests on']) : strandedMinerReason(fleet, ctx.count), modules: ctx.count(fleet.MiningModules) },
          caption: bodyText(fleet),
          link: linkTo.routes({ from: place.fleet(fleet.FleetID) }),
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
