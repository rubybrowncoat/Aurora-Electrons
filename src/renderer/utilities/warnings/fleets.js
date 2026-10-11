import { linkTo, place } from '../deep-links'
import { amount, bodyText, rowsOf } from './common'

export const group = { key: 'fleets', title: 'Fleets' }

export const IDLE_FLEETS_KEY = 'idle-fleets'

const idleFleetLocation = (fleet) => {
  if (fleet.ColonyName) {
    return `At ${fleet.ColonyName}`
  } else if (fleet.OrbitBodyID > 0) {
    return `Orbiting ${bodyText(fleet)}`
  } else if (fleet.JumpPointID) {
    return `At a jump point in ${fleet.SystemName}`
  }

  return `Deep space in ${fleet.SystemName}`
}

const idleFleetOrders = (fleet) => [fleet.StandingOrders ? 'Standing orders' : null, fleet.ConditionalOrders ? 'Conditional orders' : null].filter(Boolean).join(', ') || '—'

const strandedMinerReason = (fleet, count) => {
  if (fleet.Reason === 'not surveyed') {
    return 'You haven\'t surveyed this body'
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
].filter(Boolean).join(', ')

export const checks = [
  {
    key: IDLE_FLEETS_KEY,
    group: group.key,
    severity: 'attention',
    title: (count, options = {}) => `${amount(count, 'idle fleet')}${options.idleFleetsAtColonies ? '' : ' away from your colonies'}`,
    rule: 'A mobile military fleet with no orders and at least one ship that is neither overhauling nor docked; fleets following another fleet are left out, and so are fleets parked at your colonies unless the option is on.',
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'ships', text: 'Ships', align: 'end' },
      { key: 'orders', text: 'Orders' },
    ],
    options: ['idleFleetsAtColonies'],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.OrbitBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, VIR_Ships.Ships, (select FCT_Population.PopName from FCT_Population where FCT_Population.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_Population.RaceID = FCT_Fleet.RaceID and FCT_Population.GameID = FCT_Fleet.GameID and FCT_Fleet.OrbitBodyID > 0 limit 1) as ColonyName, (select FCT_JumpPoint.WarpPointID from FCT_JumpPoint where FCT_JumpPoint.SystemID = FCT_Fleet.SystemID and FCT_JumpPoint.GameID = FCT_Fleet.GameID and FCT_JumpPoint.Xcor = FCT_Fleet.Xcor and FCT_JumpPoint.Ycor = FCT_Fleet.Ycor limit 1) as JumpPointID, (select count(*) from FCT_FleetStandingOrder where FCT_FleetStandingOrder.FleetID = FCT_Fleet.FleetID) as StandingOrders, (select count(*) from FCT_FleetConditionalOrder where FCT_FleetConditionalOrder.FleetID = FCT_Fleet.FleetID and FCT_FleetConditionalOrder.GameID = FCT_Fleet.GameID) as ConditionalOrders from FCT_Fleet inner join (select FCT_Ship.FleetID, count(*) as Ships, sum(case when FCT_Ship.MaintenanceState <> 2 and FCT_Ship.MothershipID = 0 then 1 else 0 end) as Available from FCT_Ship where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} group by FCT_Ship.FleetID) as VIR_Ships on VIR_Ships.FleetID = FCT_Fleet.FleetID and VIR_Ships.Available > 0 left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.ShippingLine = 0 and FCT_Fleet.CivilianFunction = 0 and FCT_Fleet.Speed > 1 and FCT_Fleet.AnchorFleetID = 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) order by FCT_Fleet.FleetName`)

      return fleets
        .filter((fleet) => ctx.options.idleFleetsAtColonies || !fleet.ColonyName)
        .map((fleet) => ({
          id: `fleet:${fleet.FleetID}`,
          cells: { fleet: fleet.FleetName, ships: ctx.count(fleet.Ships), orders: idleFleetOrders(fleet) },
          caption: idleFleetLocation(fleet),
          link: linkTo.routes({ from: place.fleet(fleet.FleetID) }),
        }))
    },
  },
  {
    key: 'idle-cargo-ships',
    group: group.key,
    severity: 'attention',
    title: (count) => `${amount(count, 'ship')} carrying cargo with no orders`,
    rule: 'A ship of a mobile military fleet with no orders still holds colonists, installations, minerals or other cargo; civilian shipping lines wait for orders by design and are left out.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'cargo', text: 'Cargo' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ClassName, FCT_RaceSysSurvey.Name as SystemName, sum(case when FCT_ShipCargo.CargoTypeID = 1 then FCT_ShipCargo.Amount else 0 end) as Colonists, sum(case when FCT_ShipCargo.CargoTypeID = 2 then FCT_ShipCargo.Amount else 0 end) as Installations, sum(case when FCT_ShipCargo.CargoTypeID = 3 then FCT_ShipCargo.Amount else 0 end) as Minerals, sum(case when FCT_ShipCargo.CargoTypeID not in (1, 2, 3) then FCT_ShipCargo.Amount else 0 end) as Other from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ShipCargo on FCT_ShipCargo.ShipID = FCT_Ship.ShipID and FCT_ShipCargo.Amount > 0 left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.ShippingLine = 0 and FCT_Fleet.CivilianFunction = 0 and FCT_Fleet.Speed > 1 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) group by FCT_Ship.ShipID order by FCT_Fleet.FleetName, FCT_Ship.ShipName`)

      return ships.map((ship) => ({
        id: `ship:${ship.ShipID}`,
        cells: { ship: ship.ShipName, cargo: `${cargoLabel(ship, ctx.count)} in ${ship.SystemName}` },
        caption: ship.FleetName,
        link: linkTo.routes({ from: place.fleet(ship.FleetID) }),
      }))
    },
  },
  {
    key: 'blind-survey-orders',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'survey order')} without the sensors for them`,
    rule: 'A fleet has a geological or gravitational survey order and none of its ships carries that sensor.',
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'order', text: 'Order' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const orders = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_MoveOrders.MoveOrderID, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.Description, sum(case when FCT_ShipClass.GeoSurvey > 0 then 1 else 0 end) as GeoShips, sum(case when FCT_ShipClass.GravSurvey > 0 then 1 else 0 end) as GravShips from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_MoveOrders.MoveActionID in (9, 12) group by FCT_MoveOrders.MoveOrderID having (FCT_MoveOrders.MoveActionID = 9 and GeoShips = 0) or (FCT_MoveOrders.MoveActionID = 12 and GravShips = 0) order by FCT_Fleet.FleetName, FCT_MoveOrders.MoveOrder`)

      return orders.map((order) => ({
        id: `order:${order.MoveOrderID}`,
        cells: { fleet: order.FleetName, order: order.Description },
        caption: `No ship in the fleet has a ${order.MoveActionID === 9 ? 'geological' : 'gravitational'} survey sensor`,
        link: linkTo.routes({ from: place.fleet(order.FleetID) }),
      }))
    },
  },
  {
    key: 'stranded-miners',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'orbital mining fleet')} at bodies they can't mine`,
    rule: 'A fleet with mining modules and no orders orbits a body you haven\'t surveyed, a body without minerals, or one wider than your orbital mining limit.',
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'reason', text: 'Why' },
      { key: 'modules', text: 'Modules', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.Radius * 2 as Diameter, FCT_Race.MaximumOrbitalMiningDiameter as MaximumDiameter, sum(FCT_ShipClass.MiningModules) as MiningModules, case when FCT_SystemBodySurveys.SystemBodyID is null then 'not surveyed' when VIR_Deposits.Deposits is null then 'no deposits' else 'too large' end as Reason from FCT_Fleet inner join FCT_Race on FCT_Race.RaceID = FCT_Fleet.RaceID and FCT_Race.GameID = FCT_Fleet.GameID inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Fleet.RaceID and FCT_SystemBodySurveys.GameID = FCT_Fleet.GameID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join (select FCT_MineralDeposit.SystemBodyID, count(*) as Deposits from FCT_MineralDeposit where FCT_MineralDeposit.GameID = ${GameID} and FCT_MineralDeposit.Amount > 0 group by FCT_MineralDeposit.SystemBodyID) as VIR_Deposits on VIR_Deposits.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.SystemBodyID is not null where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.OrbitBodyID > 0 and FCT_Ship.MothershipID = 0 and (FCT_SystemBodySurveys.SystemBodyID is null or VIR_Deposits.Deposits is null or FCT_SystemBody.Radius * 2 > FCT_Race.MaximumOrbitalMiningDiameter) and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID) group by FCT_Fleet.FleetID order by FCT_Fleet.FleetName`)

      return fleets.map((fleet) => ({
        id: `fleet:${fleet.FleetID}`,
        cells: { fleet: fleet.FleetName, reason: strandedMinerReason(fleet, ctx.count), modules: ctx.count(fleet.MiningModules) },
        caption: bodyText(fleet),
        link: linkTo.routes({ from: place.fleet(fleet.FleetID) }),
      }))
    },
  },
  {
    key: 'orphaned-fleets',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'fleet')} assigned to a colony that no longer exists`,
    rule: 'A fleet is assigned to a population that is no longer in the save, so it can\'t be supplied or reassigned until you assign it to a colony again.',
    columns: [
      { key: 'fleet', text: 'Fleet' },
      { key: 'system', text: 'System' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.AssignedPopulationID, FCT_RaceSysSurvey.Name as SystemName from FCT_Fleet left join FCT_Population on FCT_Population.PopulationID = FCT_Fleet.AssignedPopulationID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.AssignedPopulationID <> 0 and FCT_Population.PopulationID is null order by FCT_Fleet.FleetName`)

      return fleets.map((fleet) => ({
        id: `fleet:${fleet.FleetID}`,
        cells: { fleet: fleet.FleetName, system: fleet.SystemName || 'An unknown system' },
        link: linkTo.routes({ from: place.fleet(fleet.FleetID) }),
      }))
    },
  },
]
