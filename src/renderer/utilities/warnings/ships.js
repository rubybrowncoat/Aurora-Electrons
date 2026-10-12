import { linkTo, place } from '../deep-links'
import { roundToDecimal } from '../math'
import { amount, levelTone, rowsOf } from './common'

export const group = { key: 'ships', title: 'Ships' }

const fleetLink = (ship) => (ship.FleetID ? linkTo.routes({ from: place.fleet(ship.FleetID) }) : undefined)

const percent = (level) => `${roundToDecimal(level * 100, 1)}%`

// Every ship has its fleet's name under its own.
const shipRow = (ship, cells, extra = {}) => ({
  id: `ship:${ship.ShipID}`,
  cells: { ship: ship.ShipName, ...cells },
  caption: ship.FleetName || undefined,
  link: fleetLink(ship),
  ...extra,
})

export const checks = [
  {
    key: 'undermanned-ships',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'ship')} short of crew`,
    rule: 'A ship has fewer crew aboard than its class needs; survey sensors, harvesters, orbital mining, maintenance, salvage, terraforming and jump point stabilisation modules run at the share of crew aboard, cargo handling slows, and morale drops below half a crew.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'crew', text: 'Crew', align: 'end' },
      { key: 'aboard', text: 'Aboard', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ClassName, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_Ship.CrewMorale from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.Crew > 0 and FCT_Ship.CurrentCrew < FCT_ShipClass.Crew order by FCT_Ship.CurrentCrew * 1.0 / FCT_ShipClass.Crew, FCT_Fleet.FleetName`)

      return ships.map((ship) => {
        const level = ship.CurrentCrew / ship.ClassCrew

        return shipRow(ship, {
          crew: { text: percent(level), tone: levelTone(level) },
          aboard: `${ctx.count(ship.CurrentCrew)} of ${ctx.count(ship.ClassCrew)}`,
        }, { caption: `${ship.FleetName} · ${ship.ClassName} Class` })
      })
    },
  },
  {
    key: 'damaged-ships',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'damaged ship'),
    rule: 'A ship of mine has one or more damaged components; the cost is the maintenance supplies a repair takes.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'components', text: 'Damaged components' },
      { key: 'cost', text: 'Repair', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipDesignComponents.Name as ComponentName, FCT_ShipDesignComponents.Cost as ComponentCost from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_DamagedComponent on FCT_Ship.ShipID = FCT_DamagedComponent.ShipID inner join FCT_ShipDesignComponents on FCT_DamagedComponent.ComponentID = FCT_ShipDesignComponents.SDComponentID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0`)

      const ships = Object.values(items.reduce((aggregate, item) => {
        if (!aggregate[item.ShipID]) {
          aggregate[item.ShipID] = { ShipID: item.ShipID, FleetID: item.FleetID, ShipName: item.ShipName, FleetName: item.FleetName, Components: [], TotalCost: 0 }
        }

        aggregate[item.ShipID].Components.push(`${item.ComponentName} (${ctx.count(item.ComponentCost * 2)} MSP)`)
        aggregate[item.ShipID].TotalCost += item.ComponentCost

        return aggregate
      }, {}))

      return ships.sort((alpha, beta) => beta.TotalCost - alpha.TotalCost).map((ship) => shipRow(ship, { components: ship.Components.join(', '), cost: `${ctx.count(ship.TotalCost * 2)} MSP` }))
    },
  },
  {
    key: 'armor-damaged-ships',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'armor-damaged ship'),
    rule: 'A ship has lost armour: damage on any layer of its armour belt, with the thinnest layer left shown.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'damage', text: 'Damage', align: 'end' },
      { key: 'thinnest', text: 'Thinnest layer', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, SUM(FCT_ArmourDamage.Damage) as ArmorDamage,FCT_ShipClass.ArmourThickness, MIN(FCT_ShipClass.ArmourThickness - FCT_ArmourDamage.Damage) as ThinnestLayer from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID join FCT_ArmourDamage on FCT_Ship.ShipID = FCT_ArmourDamage.ShipID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_Ship.ShipID having SUM(FCT_ArmourDamage.Damage) > 0 order by ArmorDamage desc`)

      return ships.map((ship) => shipRow(ship, {
        damage: ctx.count(ship.ArmorDamage),
        thinnest: { text: ctx.count(ship.ThinnestLayer), tone: levelTone(ship.ThinnestLayer / ship.ArmourThickness) },
      }))
    },
  },
  {
    key: 'low-morale-crews',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'low morale crew'),
    rule: 'A ship\'s crew morale is under 100%.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'morale', text: 'Morale', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_Ship.CrewMorale from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_Ship.CrewMorale < 1 ORDER BY FCT_Ship.CrewMorale ASC`)

      return ships.map((ship) => shipRow(ship, { morale: { text: percent(ship.CrewMorale), tone: levelTone(ship.CrewMorale) } }))
    },
  },
  {
    key: 'low-maintenance-ships',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'low maintenance ship'),
    rule: 'A ship holds less than the maintenance threshold of the supplies its class carries (a supply ship measures against its class minimum), and its class isn\'t excluded; both are set under Options.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'level', text: 'Supplies', align: 'end' },
      { key: 'msp', text: 'MSP', align: 'end' },
    ],
    options: ['maintenanceThreshold', 'maintenanceExclusions'],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const { maintenanceThreshold, maintenanceExclusions } = ctx.options

      const ships = await rowsOf(ctx, `
          select
            FCT_Ship.ShipID,
            FCT_Ship.FleetID,
            FCT_Ship.ShipName,
            FCT_ShipClass.ShipClassID,
            FCT_Fleet.FleetName,
            FCT_ShipClass.MinimumSupplies,
            FCT_Ship.CurrentMaintSupplies,
            FCT_ShipClass.MaintSupplies,
            case
              when FCT_ShipClass.SupplyShip = 1 and FCT_ShipClass.MinimumSupplies > 0
              then min(1.0, CAST(FCT_Ship.CurrentMaintSupplies as real) / FCT_ShipClass.MinimumSupplies)
              when FCT_ShipClass.MaintSupplies > 0
              then min(1.0, CAST(FCT_Ship.CurrentMaintSupplies as real) / FCT_ShipClass.MaintSupplies)
              else 0.0
            end as SupplyLevel
          from FCT_Ship
          left join FCT_Fleet
            on FCT_Ship.FleetID = FCT_Fleet.FleetID
          left join FCT_ShipClass
            on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID
          where
            FCT_Ship.GameID = ${GameID}
            and FCT_Ship.RaceID = ${RaceID}
            and FCT_Ship.ShippingLineID = 0
            and FCT_ShipClass.MaintSupplies > 0
            and SupplyLevel < 1
          order by
            SupplyLevel ASC
        `)

      return ships.filter((ship) => !maintenanceExclusions.includes(ship.ShipClassID) && ship.SupplyLevel * 100 <= maintenanceThreshold).map((ship) => shipRow(ship, {
        level: { text: percent(ship.SupplyLevel), tone: levelTone(ship.SupplyLevel) },
        msp: `${ctx.count(ship.CurrentMaintSupplies, 1)} / ${ctx.count(ship.MaintSupplies)}`,
      }, { link: linkTo.logistics('maintenance') }))
    },
  },
  {
    key: 'obsolete-ships',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'active obsolete ship'),
    rule: 'A ship of mine belongs to a class marked obsolete.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'class', text: 'Class' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipClass.ClassName from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.Obsolete = 1 ORDER BY FCT_ShipClass.ClassName ASC`)

      return ships.map((ship) => shipRow(ship, { class: `${ship.ClassName} Class` }))
    },
  },
  {
    key: 'fully-trained-ships',
    group: group.key,
    severity: 'info',
    title: (count) => `${amount(count, 'fully trained ship')} in training fleets`,
    rule: 'A ship has reached full task force training (500 points) but its fleet still sits under a training naval administration.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'command', text: 'Training command' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_NavalAdminCommand.AdminCommandName from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_NavalAdminCommand on FCT_Fleet.ParentCommandID = FCT_NavalAdminCommand.NavalAdminCommandID left join DIM_NavalAdminCommandType on FCT_NavalAdminCommand.AdminCommandTypeID = DIM_NavalAdminCommandType.CommandTypeID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and DIM_NavalAdminCommandType.Description = 'Training' and FCT_Ship.TFPoints = 500 ORDER BY FCT_Fleet.FleetName ASC`)

      return ships.map((ship) => shipRow(ship, { command: ship.AdminCommandName }))
    },
  },
  {
    key: 'open-fire-ships',
    group: group.key,
    severity: 'info',
    title: (count) => `${amount(count, 'ship')} with fire controls set to open fire`,
    rule: 'A ship has a fire control assigned with open fire switched on.',
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'controls', text: 'Fire controls' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipDesignComponents.Name as FCName, FCT_FireControlAssignment.FCNum from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_FireControlAssignment on FCT_Ship.ShipID = FCT_FireControlAssignment.ShipID left join FCT_ShipDesignComponents on FCT_FireControlAssignment.FCTypeID = FCT_ShipDesignComponents.SDComponentID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_FireControlAssignment.OpenFire = 1`)

      const ships = Object.values(items.reduce((aggregate, item) => {
        if (!aggregate[item.ShipID]) {
          aggregate[item.ShipID] = { ShipID: item.ShipID, FleetID: item.FleetID, ShipName: item.ShipName, FleetName: item.FleetName, FireControls: [] }
        }

        aggregate[item.ShipID].FireControls.push(`#${item.FCNum} ${item.FCName}`)

        return aggregate
      }, {}))

      return ships.map((ship) => shipRow(ship, { controls: ship.FireControls.join(', ') }))
    },
  },
  {
    key: 'misconfigured-supply-classes',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'misconfigured supply ship class', 'misconfigured supply ship classes'),
    rule: 'A supply ship class carries maintenance supplies but has no minimum supply level set, and isn\'t excluded under Options.',
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'problem', text: 'Problem' },
    ],
    options: ['maintenanceExclusions'],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const classes = await rowsOf(ctx, `
          select
            FCT_ShipClass.ShipClassID,
            FCT_ShipClass.ClassName
          from FCT_ShipClass
          where
            FCT_ShipClass.GameID = ${GameID}
            and FCT_ShipClass.RaceID = ${RaceID}
            AND FCT_ShipClass.ClassShippingLineID = 0
            and FCT_ShipClass.SupplyShip = 1
            AND FCT_ShipClass.MaintSupplies > 0
            and FCT_ShipClass.MinimumSupplies = 0
        `)

      return classes.filter((shipClass) => !ctx.options.maintenanceExclusions.includes(shipClass.ShipClassID)).map((shipClass) => ({
        id: `class:${shipClass.ShipClassID}`,
        cells: { class: `${shipClass.ClassName} Class`, problem: 'No minimum supply level set' },
        link: linkTo.logistics('maintenance'),
      }))
    },
  },
  {
    key: 'misconfigured-tanker-classes',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'misconfigured tanker ship class', 'misconfigured tanker ship classes'),
    rule: 'A tanker class with engines carries fuel but has no minimum fuel level set.',
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'problem', text: 'Problem' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const classes = await rowsOf(ctx, `
          select
            FCT_ShipClass.ShipClassID,
            FCT_ShipClass.ClassName
          from FCT_ShipClass
          where
            FCT_ShipClass.GameID = ${GameID}
            and FCT_ShipClass.RaceID = ${RaceID}
            and FCT_ShipClass.ClassShippingLineID = 0
            and FCT_ShipClass.FuelTanker = 1
            and FCT_ShipClass.FuelCapacity > 0
            and FCT_ShipClass.MinimumFuel = 0
            and FCT_ShipClass.EnginePower > 0
        `)

      return classes.map((shipClass) => ({
        id: `class:${shipClass.ShipClassID}`,
        cells: { class: `${shipClass.ClassName} Class`, problem: 'No minimum fuel level set' },
        link: linkTo.logistics('fuel'),
      }))
    },
  },
  {
    key: 'transport-classes-without-shuttles',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'transport ship class', 'transport ship classes') + ' without cargo shuttles',
    rule: 'A current class of more than 10 size that carries cargo or colonists has no cargo shuttle, so it can\'t load or unload without a colony\'s help.',
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'capacity', text: 'Capacity' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const classes = await rowsOf(ctx, `select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.TroopCapacity from FCT_ShipClass where FCT_ShipClass.Size > 10 and (CargoCapacity > 0 or ColonistCapacity > 0) and CargoShuttleStrength = 0 and FCT_ShipClass.Obsolete != 1 and FCT_ShipClass.RaceID = ${RaceID} and FCT_ShipClass.GameID = ${GameID} ORDER BY FCT_ShipClass.ClassName ASC`)

      return classes.map((shipClass) => ({
        id: `class:${shipClass.ShipClassID}`,
        cells: {
          class: `${shipClass.ClassName} Class`,
          capacity: [
            shipClass.CargoCapacity ? `${ctx.count(shipClass.CargoCapacity)} tons` : null,
            shipClass.ColonistCapacity ? `${ctx.count(shipClass.ColonistCapacity)} colonists` : null,
            shipClass.TroopCapacity ? `${ctx.count(shipClass.TroopCapacity)} tons of troops` : null,
          ].filter(Boolean).join(', '),
        },
      }))
    },
  },
  {
    key: 'outdated-crew-quarters',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'ship class', 'ship classes') + ' with outdated crew quarters',
    rule: 'Each class keeps the Crew Quarters Design of the day it was designed, so a current class behind my race\'s design efficiency wastes space on new ships; update it on the class window (unlock the class first).',
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'quarters', text: 'Crew quarters', align: 'end' },
      { key: 'ships', text: 'Ships', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const classes = await rowsOf(ctx, `select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.CrewDesignEfficiency as ClassEfficiency, FCT_Race.CrewDesignEfficiency as RaceEfficiency, FCT_ShipClass.Locked, (select count(*) from FCT_Ship where FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.GameID = FCT_ShipClass.GameID) as Ships from FCT_ShipClass inner join FCT_Race on FCT_Race.RaceID = FCT_ShipClass.RaceID and FCT_Race.GameID = FCT_ShipClass.GameID where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID} and FCT_ShipClass.Obsolete = 0 and FCT_ShipClass.ClassShippingLineID = 0 and FCT_ShipClass.OtherRaceClassID = 0 and FCT_ShipClass.Crew > 0 and FCT_ShipClass.CrewDesignEfficiency > FCT_Race.CrewDesignEfficiency + 0.0001 order by FCT_ShipClass.ClassName`)

      return classes.map((shipClass) => ({
        id: `class:${shipClass.ShipClassID}`,
        cells: {
          class: `${shipClass.ClassName} Class`,
          quarters: `${ctx.count(shipClass.ClassEfficiency * 100)}% (${ctx.count(shipClass.RaceEfficiency * 100)}% possible)`,
          ships: ctx.count(shipClass.Ships),
        },
        caption: shipClass.Locked ? 'Locked' : undefined,
      }))
    },
  },
]
