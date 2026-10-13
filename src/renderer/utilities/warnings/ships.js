import { CREW_MODULE_TYPES, crewEffects, crewFraction, crewFractionSql } from '../crew'
import { linkTo, place } from '../deep-links'
import { roundHalfEven } from '../design-rules'
import { isKnownNumber, roundToDecimal } from '../math'
import { loadFormulaVersion } from '../transport'
import { allOf, amount, anyOf, checksOf, classText, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, levelTone, rowsOf, unknownCell, verdictRows } from './common'

export const group = { key: 'ships', title: 'Ships', summary: 'Ships and ship classes with crew, damage, maintenance, training or design problems, so they can be repaired or refit before they matter.' }

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

// A ship that is not a shipping line's, as 1, or null while the line is not stored.
const SHIP_LINE = '(FCT_Ship.ShippingLineID = 0)'

const LINE_INPUTS = { ShippingLineID: 'whether the ship belongs to a shipping line' }

// Two figures in one cell, `left` and `right` joined by `join`, each with its unit and the pair closed by `close`: a dash for one that is not known, with the unavailable result naming it.
const pairCell = (ctx, { left, right, join, leftName, rightName, leftDecimals = 0, rightDecimals = 0, leftUnit = '', rightUnit = '', close = '' }) => {
  const part = (value, decimals, unit) => (isKnownNumber(value) ? `${ctx.count(value, decimals)}${unit}` : ctx.count(value, decimals))
  const text = `${part(left, leftDecimals, leftUnit)}${join}${part(right, rightDecimals, rightUnit)}${close}`
  const names = [...(isKnownNumber(left) ? [] : [leftName]), ...(isKnownNumber(right) ? [] : [rightName])]

  return names.length ? { text, result: ctx.unknown(names) } : text
}

// The colonies where a fleet can take on replacement crew: the race's own with more than a million people, the fleet's own system first and then the largest. Up to three are named.
const REPLACEMENT_LIMIT = 3

const replacementText = (ship, colonies) => {
  if (!colonies.length) {
    return 'No colony of the race has over a million people'
  }

  const inFleetSystem = (colony) => Number(colony.SystemID === ship.SystemID)
  const ordered = [...colonies].sort((alpha, beta) => inFleetSystem(beta) - inFleetSystem(alpha) || beta.Population - alpha.Population)
  const named = ordered.slice(0, REPLACEMENT_LIMIT).map((colony) => colonyText(colony)).join('; ')

  return ordered.length > REPLACEMENT_LIMIT ? `${named}; ${ordered.length - REPLACEMENT_LIMIT} more` : named
}

// The crew grade the game turns into a performance modifier, in percent: the root of the grade points less 10. It and the crew morale are separate from the share of the crew aboard.
const gradeText = (ship) => {
  if (!Number.isFinite(ship.GradePoints) || ship.GradePoints < 0) {
    return 'grade unknown'
  }

  const grade = roundHalfEven(Math.sqrt(ship.GradePoints) - 10)

  return `grade ${grade >= 0 ? '+' : ''}${grade}%`
}

// A class with no deployment morale check (a commercial one, or any class with no military system or survey sensor) never loses morale to deployment, but its crew deficit still slows what it does.
const moraleText = (ship) => [ship.MoraleCheckRequired ? (Number.isFinite(ship.CrewMorale) ? `morale ${percent(ship.CrewMorale)}` : 'morale unknown') : 'no morale check', gradeText(ship)].join(' · ')

const modulesOf = (lines) => lines.reduce((modules, line) => ({ ...modules, [line.TypeID]: { designed: line.Designed, working: line.Working } }), {})

const holdsOf = (ship) => {
  const capacities = [ship.CargoCapacity, ship.ColonistCapacity, ship.TroopCapacity]

  return capacities.every(Number.isFinite) ? capacities.some((capacity) => capacity > 0) : null
}

const CREW_ABOARD = 'the ship\'s crew aboard'
const CLASS_CREW = 'the crew the ship class needs'

const UNDERMANNED = '(FCT_ShipClass.Crew > 0 and FCT_Ship.CurrentCrew < FCT_ShipClass.Crew)'

const ARMOUR_DAMAGED = '(case when SUM(FCT_ArmourDamage.Damage) > 0 then 1 when sum(case when FCT_ArmourDamage.Damage is null then 1 else 0 end) > 0 then null else 0 end)'

// How full a ship's supplies are against what its class asks: a supply ship against its class minimum when it has one, any other against what its class carries, 1 at most; null while an input is not stored.
const SUPPLY_LEVEL = 'case when FCT_ShipClass.SupplyShip is null then null when FCT_ShipClass.SupplyShip = 1 and FCT_ShipClass.MinimumSupplies is null then null when FCT_ShipClass.SupplyShip = 1 and FCT_ShipClass.MinimumSupplies > 0 then min(1.0, CAST(FCT_Ship.CurrentMaintSupplies as real) / FCT_ShipClass.MinimumSupplies) when FCT_ShipClass.MaintSupplies is null then null when FCT_ShipClass.MaintSupplies > 0 then min(1.0, CAST(FCT_Ship.CurrentMaintSupplies as real) / FCT_ShipClass.MaintSupplies) else 0.0 end'

// The inputs the supply level lacks.
const supplyGaps = (ship) => [
  ...(isKnownNumber(ship.CurrentMaintSupplies) ? [] : ['the maintenance supplies the ship holds']),
  ...(isKnownNumber(ship.SupplyShip) ? [] : ['whether the ship class is a supply ship']),
  ...(ship.SupplyShip === 1 && !isKnownNumber(ship.MinimumSupplies) ? ['the minimum supplies of the ship class'] : []),
  ...(!(ship.SupplyShip === 1 && ship.MinimumSupplies > 0) && !isKnownNumber(ship.MaintSupplies) ? ['the maintenance supplies the ship class carries'] : []),
]

const TRAINING_COMMAND = '(case when FCT_Fleet.ParentCommandID is null then null when FCT_Fleet.ParentCommandID = 0 then 0 else (DIM_NavalAdminCommandType.Description = \'Training\') end)'

const CAPACITY_LABELS = [['CargoCapacity', 'tons'], ['ColonistCapacity', 'colonists'], ['TroopCapacity', 'tons of troops']]

export const checks = checksOf([
  {
    key: 'undermanned-ships',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'ship')} short of crew`,
    rule: 'A ship has fewer crew aboard than its class needs, so its holds and its survey, harvester, orbital mining, maintenance, salvage, terraforming and stabilisation modules work at the share aboard (estimates read from the game\'s rules; over-crewing adds nothing). Morale and crew grade are separate, and a class with no morale check still loses this throughput; replacement crew joins at a colony of over a million people.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew', 'FCT_ClassComponent', 'FCT_DamagedComponent'],
      note: 'The crew aboard and the class crew are stored values; what a shortfall slows is read from the game\'s rules, with no saved game showing a short-crewed ship doing it, so the effects are not checked against stored data. A ship whose crew aboard or class crew is not stored is listed apart, as not evaluated.',
      assumptions: ['A shortfall slows a ship\'s holds and modules at the share of the class crew aboard.'],
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'crew', text: 'Crew', align: 'end' },
      { key: 'aboard', text: 'Aboard', align: 'end' },
      { key: 'slowed', text: 'Slowed' },
      { key: 'morale', text: 'Morale and grade' },
      { key: 'replace', text: 'Replace crew at' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const short = `FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 and ${UNDERMANNED} is not 0`

      const ships = await rowsOf(ctx, `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ClassName, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_Ship.CrewMorale, FCT_Ship.GradePoints, FCT_ShipClass.MoraleCheckRequired, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.TroopCapacity, ${UNDERMANNED} as Verdict, (select count(*) from FCT_ClassComponent where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID) as ClassLines from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where ${short} order by ${crewFractionSql()}, FCT_Fleet.FleetName`)

      if (!ships.length) {
        return []
      }

      const [lines, colonies, version] = await Promise.all([
        rowsOf(ctx, `select FCT_Ship.ShipID, FCT_ShipDesignComponents.ComponentTypeID as TypeID, sum(FCT_ClassComponent.NumComponent) as Designed, sum(max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID), 0), 0)) as Working from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID in (${CREW_MODULE_TYPES.join(', ')}) where ${short} group by FCT_Ship.ShipID, FCT_ShipDesignComponents.ComponentTypeID`),
        rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Population, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Population > 1`),
        loadFormulaVersion(ctx.database),
      ])

      const linesByShip = lines.reduce((byShip, line) => ({ ...byShip, [line.ShipID]: [...(byShip[line.ShipID] || []), line] }), {})

      return verdictRows(ctx, ships, {
        missing: (ship) => lacking(ship, { CurrentCrew: CREW_ABOARD, ClassCrew: CLASS_CREW }),
        build: (ship) => {
          const level = crewFraction(ship)
          const effects = crewEffects(ship, { modules: ship.ClassLines > 0 ? modulesOf(linesByShip[ship.ShipID] || []) : null, holds: holdsOf(ship), version })
          const stopped = effects.some((effect) => effect.state === 'blocked' || effect.state === 'stopped' || effect.state === 'unsupported')

          return shipRow(ship, {
            crew: level === null ? unknownCell(ctx, lacking(ship, { CurrentCrew: CREW_ABOARD, ClassCrew: CLASS_CREW })) : { text: percent(level), tone: levelTone(level) },
            aboard: pairCell(ctx, { left: ship.CurrentCrew, right: ship.ClassCrew, join: ' of ', leftName: CREW_ABOARD, rightName: CLASS_CREW }),
            slowed: effects.length ? { text: effects.map((effect) => effect.text).join(' · '), tone: stopped ? 'error' : 'warning' } : 'No hold or module the crew share scales',
            morale: moraleText(ship),
            replace: replacementText(ship, colonies),
          }, { caption: `${ship.FleetName || 'An unnamed fleet'} · ${classText(ship)}` })
        },
      })
    },
  },
  {
    key: 'damaged-ships',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'damaged ship'),
    rule: 'A ship has one or more damaged components; the cost is the maintenance supplies a repair takes.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_DamagedComponent', 'FCT_ShipDesignComponents.Cost', 'FCT_Ship.ShippingLineID'],
      note: 'A presence check on stored rows: a ship with a damaged component row. The repair cost is twice the stored component cost; a cost not stored shows a dash. A ship whose shipping line is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'components', text: 'Damaged components' },
      { key: 'cost', text: 'Repair', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const COST = 'the cost of a damaged component'

      const items = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Ship.ShippingLineID, ${SHIP_LINE} as Verdict, FCT_Fleet.FleetName, FCT_ShipDesignComponents.Name as ComponentName, FCT_ShipDesignComponents.Cost as ComponentCost from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_DamagedComponent on FCT_Ship.ShipID = FCT_DamagedComponent.ShipID left join FCT_ShipDesignComponents on FCT_DamagedComponent.ComponentID = FCT_ShipDesignComponents.SDComponentID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and ${SHIP_LINE} is not 0`)

      const ships = Object.values(items.reduce((aggregate, item) => {
        if (!aggregate[item.ShipID]) {
          aggregate[item.ShipID] = { ShipID: item.ShipID, FleetID: item.FleetID, ShipName: item.ShipName, FleetName: item.FleetName, ShippingLineID: item.ShippingLineID, Verdict: item.Verdict, Components: [], TotalCost: 0, CostGaps: 0 }
        }

        const ship = aggregate[item.ShipID]

        ship.Components.push(`${item.ComponentName || 'An unknown component'} (${ctx.count(isKnownNumber(item.ComponentCost) ? item.ComponentCost * 2 : null)} MSP)`)

        if (isKnownNumber(item.ComponentCost)) {
          ship.TotalCost += item.ComponentCost
        } else {
          ship.CostGaps += 1
        }

        return aggregate
      }, {}))

      return verdictRows(ctx, ships.sort((alpha, beta) => (alpha.CostGaps > 0) - (beta.CostGaps > 0) || beta.TotalCost - alpha.TotalCost), {
        missing: (ship) => lacking(ship, LINE_INPUTS),
        build: (ship) => shipRow(ship, { components: ship.Components.join(', '), cost: figure(ctx, ship.CostGaps > 0 ? null : ship.TotalCost, COST, (known) => `${ctx.count(known * 2)} MSP`) }),
      })
    },
  },
  {
    key: 'armor-damaged-ships',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'armor-damaged ship'),
    rule: 'A ship has lost armour: damage on any layer of its armour belt, with the thinnest layer left shown.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ArmourDamage.Damage', 'FCT_ShipClass.ArmourThickness', 'FCT_Ship.ShippingLineID'],
      note: 'A minimum over stored values: the damage of the armour layers, and the class thickness less the heaviest damage as the thinnest layer left. A ship whose shipping line is not stored, or with armour damage rows and no damage amount known to be above 0, is listed apart, as not evaluated; a thickness or damage not stored shows a dash.',
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'damage', text: 'Damage', align: 'end' },
      { key: 'thinnest', text: 'Thinnest layer', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const DAMAGE = 'the damage of an armour layer'
      const THICKNESS = 'the armour thickness of the ship class'

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_Ship.ShippingLineID, SUM(FCT_ArmourDamage.Damage) as ArmorDamage, sum(case when FCT_ArmourDamage.Damage is null then 1 else 0 end) as DamageGaps, FCT_ShipClass.ArmourThickness, MIN(FCT_ShipClass.ArmourThickness - FCT_ArmourDamage.Damage) as ThinnestLayer, (${SHIP_LINE} and ${ARMOUR_DAMAGED}) as Verdict from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID join FCT_ArmourDamage on FCT_Ship.ShipID = FCT_ArmourDamage.ShipID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and ${SHIP_LINE} is not 0 group by FCT_Ship.ShipID having ${ARMOUR_DAMAGED} is not 0 order by ArmorDamage desc`)

      return verdictRows(ctx, ships, {
        missing: (ship) => [...lacking(ship, LINE_INPUTS), ...(ship.ArmorDamage > 0 || !(ship.DamageGaps > 0) ? [] : [DAMAGE])],
        build: (ship) => shipRow(ship, {
          damage: figure(ctx, ship.DamageGaps > 0 ? null : ship.ArmorDamage, DAMAGE),
          thinnest: figure(ctx, ship.DamageGaps > 0 ? null : ship.ThinnestLayer, ship.DamageGaps > 0 ? DAMAGE : THICKNESS, (known) => ctx.count(known), (known) => levelTone(known / ship.ArmourThickness)),
        }),
      })
    },
  },
  {
    key: 'low-morale-crews',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'low morale crew'),
    rule: 'A ship\'s crew morale is under 100%.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Ship.CrewMorale', 'FCT_Ship.ShippingLineID'],
      note: 'The condition is a stored crew morale under 1, which is the threshold this page uses, not one the game states; the colour of the morale (above 85% good, under 30% bad) is also this page\'s choice. A ship whose morale or shipping line is not stored is listed apart, as not evaluated.',
      assumptions: ['Any morale under 100% is listed, and the colour bands (85% and 30%) are a choice of this page.'],
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'morale', text: 'Morale', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const LOW_MORALE = `(${SHIP_LINE} and FCT_Ship.CrewMorale < 1)`

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_Ship.ShippingLineID, FCT_Ship.CrewMorale, ${LOW_MORALE} as Verdict from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and ${LOW_MORALE} is not 0 ORDER BY FCT_Ship.CrewMorale ASC`)

      return verdictRows(ctx, ships, {
        missing: (ship) => lacking(ship, { ...LINE_INPUTS, CrewMorale: 'the ship\'s crew morale' }),
        build: (ship) => shipRow(ship, { morale: figure(ctx, ship.CrewMorale, 'the ship\'s crew morale', percent, levelTone) }),
      })
    },
  },
  {
    key: 'low-maintenance-ships',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'low maintenance ship'),
    rule: 'A ship holds less than the maintenance threshold of the supplies its class carries (a supply ship measures against its class minimum), and its class isn\'t excluded; both are set under Options.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Ship.CurrentMaintSupplies', 'FCT_ShipClass.MaintSupplies, MinimumSupplies, SupplyShip', 'FCT_Ship.ShippingLineID'],
      note: 'The supplies held are stored, but the ratio to the class figure (the minimum for a supply ship, else what the class carries) and the threshold set under Options are this page\'s reading, not checked against the game. A ship whose supplies, or the class figure it is measured against, are not stored is listed apart, as not evaluated.',
      assumptions: ['A ship is measured against its class minimum when it is a supply ship with one set, else against the supplies its class carries; the share is capped at 100%.', 'The share at or under the threshold under Options is listed.'],
    },
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
            VIR_Supplies.*,
            (VIR_Supplies.ShippingLineID = 0 and VIR_Supplies.MaintSupplies > 0 and VIR_Supplies.SupplyLevel < 1) as Verdict
          from (
            select
              FCT_Ship.ShipID,
              FCT_Ship.FleetID,
              FCT_Ship.ShipName,
              FCT_Ship.ShippingLineID,
              FCT_ShipClass.ShipClassID,
              FCT_Fleet.FleetName,
              FCT_ShipClass.SupplyShip,
              FCT_ShipClass.MinimumSupplies,
              FCT_Ship.CurrentMaintSupplies,
              FCT_ShipClass.MaintSupplies,
              ${SUPPLY_LEVEL} as SupplyLevel
            from FCT_Ship
            left join FCT_Fleet
              on FCT_Ship.FleetID = FCT_Fleet.FleetID
            left join FCT_ShipClass
              on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID
            where
              FCT_Ship.GameID = ${GameID}
              and FCT_Ship.RaceID = ${RaceID}
          ) as VIR_Supplies
          where
            Verdict is not 0
          order by
            SupplyLevel ASC
        `)

      const judged = ships.filter((ship) => !maintenanceExclusions.includes(ship.ShipClassID)).map((ship) => ({ ...ship, Verdict: allOf(ship.Verdict, isKnownNumber(ship.SupplyLevel) ? ship.SupplyLevel * 100 <= maintenanceThreshold : null) }))

      return verdictRows(ctx, judged, {
        missing: (ship) => [...lacking(ship, LINE_INPUTS), ...(isKnownNumber(ship.MaintSupplies) ? [] : ['the maintenance supplies the ship class carries']), ...(isKnownNumber(ship.SupplyLevel) ? [] : supplyGaps(ship))],
        build: (ship) => shipRow(ship, {
          level: figure(ctx, ship.SupplyLevel, supplyGaps(ship), percent, levelTone),
          msp: pairCell(ctx, { left: ship.CurrentMaintSupplies, right: ship.MaintSupplies, join: ' / ', leftName: 'the maintenance supplies the ship holds', rightName: 'the maintenance supplies the ship class carries', leftDecimals: 1 }),
        }, { link: linkTo.logistics('maintenance') }),
      })
    },
  },
  {
    key: 'obsolete-ships',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'active obsolete ship'),
    rule: 'A ship belongs to a class marked obsolete.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ShipClass.Obsolete', 'FCT_Ship.ShippingLineID'],
      note: 'A presence check on a stored flag: a ship whose class is marked obsolete. A ship whose class flag, class row or shipping line is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'class', text: 'Class' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const OBSOLETE = `(${SHIP_LINE} and FCT_ShipClass.Obsolete = 1)`

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Ship.ShippingLineID, FCT_Fleet.FleetName, FCT_ShipClass.ClassName, FCT_ShipClass.Obsolete, ${OBSOLETE} as Verdict from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_ShipClass on FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and ${OBSOLETE} is not 0 ORDER BY FCT_ShipClass.ClassName ASC`)

      return verdictRows(ctx, ships, {
        missing: (ship) => lacking(ship, { ...LINE_INPUTS, Obsolete: 'the obsolete flag of the ship\'s class' }),
        build: (ship) => shipRow(ship, { class: ship.ClassName ? `${ship.ClassName} Class` : unknownCell(ctx, ['the name of the ship\'s class']) }),
      })
    },
  },
  {
    key: 'fully-trained-ships',
    group: group.key,
    severity: 'info',
    title: (count) => `${amount(count, 'fully trained ship')} in training fleets`,
    rule: 'A ship has reached full task force training (500 points) but its fleet still sits under a training naval administration.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Ship.TFPoints', 'FCT_Fleet.ParentCommandID', 'FCT_NavalAdminCommand.AdminCommandTypeID', 'DIM_NavalAdminCommandType.Description'],
      note: 'The training points and the fleet\'s administration are stored, but that 500 points is full training is a figure this page uses, not one the game states. A ship whose training points, or the type of its fleet\'s administration, is not stored is listed apart, as not evaluated.',
      assumptions: ['A ship at 500 task force training points is fully trained.'],
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'command', text: 'Training command' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const TRAINED = `(FCT_Ship.TFPoints = 500 and ${TRAINING_COMMAND})`

      const ships = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Ship.TFPoints, FCT_Fleet.FleetName, FCT_Fleet.ParentCommandID, FCT_NavalAdminCommand.AdminCommandName, DIM_NavalAdminCommandType.Description as CommandType, ${TRAINED} as Verdict from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID left join FCT_NavalAdminCommand on FCT_Fleet.ParentCommandID = FCT_NavalAdminCommand.NavalAdminCommandID left join DIM_NavalAdminCommandType on FCT_NavalAdminCommand.AdminCommandTypeID = DIM_NavalAdminCommandType.CommandTypeID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and ${TRAINED} is not 0 ORDER BY FCT_Fleet.FleetName ASC`)

      return verdictRows(ctx, ships, {
        missing: (ship) => [...lacking(ship, { TFPoints: 'the task force training points of the ship' }), ...(!isKnownNumber(ship.ParentCommandID) || !ship.CommandType ? ['the type of the naval administration the fleet sits under'] : [])],
        build: (ship) => shipRow(ship, { command: ship.AdminCommandName || unknownCell(ctx, ['the naval administration the fleet sits under']) }),
      })
    },
  },
  {
    key: 'open-fire-ships',
    group: group.key,
    severity: 'info',
    title: (count) => `${amount(count, 'ship')} with fire controls set to open fire`,
    rule: 'A ship has a fire control assigned with open fire switched on.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_FireControlAssignment.OpenFire'],
      note: 'A presence check on a stored flag: a ship with a fire control whose open fire flag is on. A ship whose fire controls have the flag not stored, and none on, is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'ship', text: 'Ship' },
      { key: 'controls', text: 'Fire controls' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipDesignComponents.Name as FCName, FCT_FireControlAssignment.FCNum, FCT_FireControlAssignment.OpenFire, (FCT_FireControlAssignment.OpenFire = 1) as Verdict from FCT_Ship left join FCT_Fleet on FCT_Ship.FleetID = FCT_Fleet.FleetID join FCT_FireControlAssignment on FCT_Ship.ShipID = FCT_FireControlAssignment.ShipID left join FCT_ShipDesignComponents on FCT_FireControlAssignment.FCTypeID = FCT_ShipDesignComponents.SDComponentID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and (FCT_FireControlAssignment.OpenFire = 1) is not 0`)

      const ships = Object.values(items.reduce((aggregate, item) => {
        if (!aggregate[item.ShipID]) {
          aggregate[item.ShipID] = { ShipID: item.ShipID, FleetID: item.FleetID, ShipName: item.ShipName, FleetName: item.FleetName, FireControls: [], Verdict: 0 }
        }

        const ship = aggregate[item.ShipID]

        if (item.Verdict !== null) {
          ship.FireControls.push(`#${item.FCNum} ${item.FCName || 'an unknown fire control'}`)
        }

        ship.Verdict = anyOf(ship.Verdict, item.Verdict)

        return aggregate
      }, {}))

      return verdictRows(ctx, ships, {
        missing: () => ['whether a fire control of the ship is set to open fire'],
        build: (ship) => shipRow(ship, { controls: ship.FireControls.length ? ship.FireControls.join(', ') : unknownCell(ctx, ['whether a fire control of the ship is set to open fire']) }),
      })
    },
  },
  {
    key: 'misconfigured-supply-classes',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'misconfigured supply ship class', 'misconfigured supply ship classes'),
    rule: 'A supply ship class carries maintenance supplies but has no minimum supply level set, and isn\'t excluded under Options.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ShipClass.SupplyShip, MaintSupplies, MinimumSupplies, ClassShippingLineID'],
      note: 'A comparison of stored class values: a supply ship class that carries supplies with a minimum of 0. A class with one of them not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'problem', text: 'Problem' },
    ],
    options: ['maintenanceExclusions'],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const MISCONFIGURED = '(FCT_ShipClass.ClassShippingLineID = 0 and FCT_ShipClass.SupplyShip = 1 and FCT_ShipClass.MaintSupplies > 0 and FCT_ShipClass.MinimumSupplies = 0)'

      const classes = await rowsOf(ctx, `
          select
            FCT_ShipClass.ShipClassID,
            FCT_ShipClass.ClassName,
            FCT_ShipClass.ClassShippingLineID,
            FCT_ShipClass.SupplyShip,
            FCT_ShipClass.MaintSupplies,
            FCT_ShipClass.MinimumSupplies,
            ${MISCONFIGURED} as Verdict
          from FCT_ShipClass
          where
            FCT_ShipClass.GameID = ${GameID}
            and FCT_ShipClass.RaceID = ${RaceID}
            and ${MISCONFIGURED} is not 0
        `)

      return verdictRows(ctx, classes.filter((shipClass) => !ctx.options.maintenanceExclusions.includes(shipClass.ShipClassID)), {
        missing: (shipClass) => lacking(shipClass, { ClassShippingLineID: 'whether the class belongs to a shipping line', SupplyShip: 'whether the ship class is a supply ship', MaintSupplies: 'the maintenance supplies the ship class carries', MinimumSupplies: 'the minimum supplies of the ship class' }),
        build: (shipClass) => ({
          id: `class:${shipClass.ShipClassID}`,
          cells: { class: classText(shipClass), problem: 'No minimum supply level set' },
          link: linkTo.logistics('maintenance'),
        }),
      })
    },
  },
  {
    key: 'misconfigured-tanker-classes',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'misconfigured tanker ship class', 'misconfigured tanker ship classes'),
    rule: 'A tanker class with engines carries fuel but has no minimum fuel level set.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ShipClass.FuelTanker, FuelCapacity, MinimumFuel, EnginePower, ClassShippingLineID'],
      note: 'A comparison of stored class values: a tanker class with engines and fuel capacity and a minimum fuel of 0. A class with one of them not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'problem', text: 'Problem' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const MISCONFIGURED = '(FCT_ShipClass.ClassShippingLineID = 0 and FCT_ShipClass.FuelTanker = 1 and FCT_ShipClass.FuelCapacity > 0 and FCT_ShipClass.MinimumFuel = 0 and FCT_ShipClass.EnginePower > 0)'

      const classes = await rowsOf(ctx, `
          select
            FCT_ShipClass.ShipClassID,
            FCT_ShipClass.ClassName,
            FCT_ShipClass.ClassShippingLineID,
            FCT_ShipClass.FuelTanker,
            FCT_ShipClass.FuelCapacity,
            FCT_ShipClass.MinimumFuel,
            FCT_ShipClass.EnginePower,
            ${MISCONFIGURED} as Verdict
          from FCT_ShipClass
          where
            FCT_ShipClass.GameID = ${GameID}
            and FCT_ShipClass.RaceID = ${RaceID}
            and ${MISCONFIGURED} is not 0
        `)

      return verdictRows(ctx, classes, {
        missing: (shipClass) => lacking(shipClass, { ClassShippingLineID: 'whether the class belongs to a shipping line', FuelTanker: 'whether the ship class is a tanker', FuelCapacity: 'the fuel capacity of the ship class', MinimumFuel: 'the minimum fuel of the ship class', EnginePower: 'the engine power of the ship class' }),
        build: (shipClass) => ({
          id: `class:${shipClass.ShipClassID}`,
          cells: { class: classText(shipClass), problem: 'No minimum fuel level set' },
          link: linkTo.logistics('fuel'),
        }),
      })
    },
  },
  {
    key: 'transport-classes-without-shuttles',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'transport ship class', 'transport ship classes') + ' without cargo shuttles',
    rule: 'A current class of more than 10 size that carries cargo or colonists has no cargo shuttle, so it can\'t load or unload without a colony\'s help.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_ShipClass.Size, CargoCapacity, ColonistCapacity, TroopCapacity, CargoShuttleStrength, Obsolete'],
      note: 'The capacities and the shuttle strength are stored class values; that a class of more than 10 size needs shuttles is a threshold of this page, not one the game states. A class with one of the values not stored is listed apart, as not evaluated.',
      assumptions: ['A class of more than 10 size that carries cargo or colonists needs a cargo shuttle.'],
    },
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'capacity', text: 'Capacity' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const TRANSPORT = '(FCT_ShipClass.Size > 10 and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0) and FCT_ShipClass.CargoShuttleStrength = 0 and FCT_ShipClass.Obsolete != 1)'

      const classes = await rowsOf(ctx, `select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.TroopCapacity, FCT_ShipClass.CargoShuttleStrength, FCT_ShipClass.Obsolete, ${TRANSPORT} as Verdict from FCT_ShipClass where ${TRANSPORT} is not 0 and FCT_ShipClass.RaceID = ${RaceID} and FCT_ShipClass.GameID = ${GameID} ORDER BY FCT_ShipClass.ClassName ASC`)

      return verdictRows(ctx, classes, {
        missing: (shipClass) => lacking(shipClass, { Size: 'the size of the ship class', CargoCapacity: 'the cargo capacity of the ship class', ColonistCapacity: 'the colonist capacity of the ship class', CargoShuttleStrength: 'the cargo shuttle strength of the ship class', Obsolete: 'the obsolete flag of the ship class' }),
        build: (shipClass) => {
          const gaps = CAPACITY_LABELS.filter(([column]) => !isKnownNumber(shipClass[column]))
          const parts = CAPACITY_LABELS.map(([column, unit]) => (isKnownNumber(shipClass[column]) ? (shipClass[column] ? `${ctx.count(shipClass[column])} ${unit}` : null) : `${unit} not stored`)).filter(Boolean).join(', ')

          return {
            id: `class:${shipClass.ShipClassID}`,
            cells: {
              class: classText(shipClass),
              capacity: gaps.length ? { text: parts, result: ctx.unknown(gaps.map(([, unit]) => `the ${unit} capacity of the ship class`)) } : parts,
            },
          }
        },
      })
    },
  },
  {
    key: 'outdated-crew-quarters',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'ship class', 'ship classes') + ' with outdated crew quarters',
    rule: 'Each class keeps the Crew Quarters Design of the day it was designed, so a current class behind the race\'s design efficiency wastes space on new ships; update it on the class window (unlock the class first).',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ShipClass.CrewDesignEfficiency, Crew, Obsolete, OtherRaceClassID, ClassShippingLineID', 'FCT_Race.CrewDesignEfficiency'],
      note: 'A comparison of two stored efficiencies, the class\'s against the race\'s (with a margin of 0.0001 for rounding). A class with one of the values not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'class', text: 'Class' },
      { key: 'quarters', text: 'Crew quarters', align: 'end' },
      { key: 'ships', text: 'Ships', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx
      const OUTDATED = '(FCT_ShipClass.Obsolete = 0 and FCT_ShipClass.ClassShippingLineID = 0 and FCT_ShipClass.OtherRaceClassID = 0 and FCT_ShipClass.Crew > 0 and FCT_ShipClass.CrewDesignEfficiency > FCT_Race.CrewDesignEfficiency + 0.0001)'
      const CLASS_EFFICIENCY = 'the crew quarters efficiency of the ship class'
      const RACE_EFFICIENCY = 'the crew quarters efficiency of the race'

      const classes = await rowsOf(ctx, `select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Obsolete, FCT_ShipClass.ClassShippingLineID, FCT_ShipClass.OtherRaceClassID, FCT_ShipClass.Crew, FCT_ShipClass.CrewDesignEfficiency as ClassEfficiency, FCT_Race.CrewDesignEfficiency as RaceEfficiency, FCT_ShipClass.Locked, ${OUTDATED} as Verdict, (select count(*) from FCT_Ship where FCT_Ship.ShipClassID = FCT_ShipClass.ShipClassID and FCT_Ship.GameID = FCT_ShipClass.GameID) as Ships from FCT_ShipClass inner join FCT_Race on FCT_Race.RaceID = FCT_ShipClass.RaceID and FCT_Race.GameID = FCT_ShipClass.GameID where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID} and ${OUTDATED} is not 0 order by FCT_ShipClass.ClassName`)

      return verdictRows(ctx, classes, {
        missing: (shipClass) => lacking(shipClass, { Obsolete: 'the obsolete flag of the ship class', ClassShippingLineID: 'whether the class belongs to a shipping line', OtherRaceClassID: 'whether the class is another race\'s', Crew: 'the crew the ship class needs', ClassEfficiency: CLASS_EFFICIENCY, RaceEfficiency: RACE_EFFICIENCY }),
        build: (shipClass) => ({
          id: `class:${shipClass.ShipClassID}`,
          cells: {
            class: classText(shipClass),
            quarters: pairCell(ctx, { left: isKnownNumber(shipClass.ClassEfficiency) ? shipClass.ClassEfficiency * 100 : null, right: isKnownNumber(shipClass.RaceEfficiency) ? shipClass.RaceEfficiency * 100 : null, join: ' (', leftUnit: '%', rightUnit: '% possible', close: ')', leftName: CLASS_EFFICIENCY, rightName: RACE_EFFICIENCY }),
            ships: ctx.count(shipClass.Ships),
          },
          caption: shipClass.Locked ? 'Locked' : undefined,
        }),
      })
    },
  },
])
