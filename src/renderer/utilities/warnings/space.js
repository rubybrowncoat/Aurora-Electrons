import _partition from 'lodash/partition'

import { systemBodyName } from '../aurora'
import { linkTo } from '../deep-links'
import { roundToDecimal } from '../math'
import { amount, bodyText, rowsOf } from './common'

export const group = { key: 'space', title: 'Contacts and space', summary: 'Intruders, hazards and finds in space I have surveyed, such as rifts, lifepods, wrecks and ancient constructs, that may need a response.' }

const SECONDS_PER_TWO_WEEKS = 1209600

const CONTACT_TYPES = {
  0: 'Other',
  1: 'Ship',
  3: 'Salvo',
  4: 'Population',
  12: 'GroundUnit',
  14: 'GroundUnit',
  16: 'Shipyard',
}

const HOSTILE = 0

// `13d 4h 2m 9s`, or `Expired` once the pod's two weeks are up.
const podExpiration = (lifepod, gameTime) => {
  let remaining = Math.floor(SECONDS_PER_TWO_WEEKS - (gameTime - lifepod.CreationTime))

  if (remaining <= 0) {
    return 'Expired'
  }

  const days = Math.floor(remaining / 86400)
  remaining -= days * 86400

  const hours = Math.floor(remaining / 3600)
  remaining -= hours * 3600

  const minutes = Math.floor(remaining / 60)
  remaining -= minutes * 60

  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, remaining && `${remaining}s`].filter(Boolean).join(' ')
}

// What a system's contacts add up to by type, hostile ones first; tone is `error` when any is hostile.
const intruderTotals = (totals) => {
  const parts = []
  let hostile = false

  Object.entries(totals).forEach(([type, contacts]) => {
    const [hostiles, neutrals] = _partition(contacts, (contact) => contact.ContactStatus === HOSTILE)

    if (hostiles.length) {
      hostile = true
      parts.push(`${hostiles.length} Hostile ${type}s`)
    }

    if (neutrals.length) {
      parts.push(`${neutrals.length} ${type}s`)
    }
  })

  return { text: parts.join(', '), tone: hostile ? 'error' : undefined }
}

const intruderRaces = (races) => Object.values(races).map(({ Alien, Types }) => {
  const types = Object.entries(Types).filter(([, contacts]) => contacts.length).map(([type, contacts]) => `${contacts.length} ${type}s`).join(', ')

  return `${Alien.AlienRaceName} — ${types}${Alien.ContactStatus === HOSTILE ? ' — Hostile' : ''}`
}).join('; ')

const plural = (count, one, many) => (count === 1 ? `${count} ${one}` : `${count} ${many}`)

const joined = (parts) => parts.filter(Boolean).join(', ')

// How the rift check sorts a colony of the race in the rift's system: with people, or without and then by what it holds (installations, stockpiles, ground units), the first that applies.
const STOCKPILES = ['FuelStockpile', 'MaintenanceStockpile', 'Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const INHABITED = 'coalesce(FCT_Population.Population, 0) != 0'
const UNINHABITED = 'coalesce(FCT_Population.Population, 0) = 0'
const HAS_INSTALLATIONS = 'exists (select 1 from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID)'
const HAS_STOCK = `(${STOCKPILES.map((stockpile) => `coalesce(FCT_Population.${stockpile}, 0) != 0`).join(' or ')})`
const HAS_GROUND_UNITS = 'exists (select 1 from FCT_GroundUnitFormation where FCT_GroundUnitFormation.PopulationID = FCT_Population.PopulationID)'

export const checks = [
  {
    key: 'intruders',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'system')} with intruders`,
    rule: 'Another empire\'s ships, salvos, colonies, ground units or shipyards are detected in a system I have surveyed, unless I am allied with it or it is marked friendly.',
    columns: [
      { key: 'system', text: 'System' },
      { key: 'contacts', text: 'Contacts' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const contacts = await rowsOf(ctx, `select FCT_Contacts.ContactID, FCT_Contacts.SystemID, FCT_Contacts.ContactRaceID, FCT_Contacts.ContactType, FCT_RaceSysSurvey.Name as SystemName, FCT_AlienRace.AlienRaceName, FCT_AlienRace.ContactStatus from FCT_Contacts inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Contacts.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} inner join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_Contacts.ContactRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} where FCT_Contacts.GameID = ${GameID} and FCT_Contacts.DetectRaceID = ${RaceID} and FCT_Contacts.ContactRaceID != ${RaceID} and FCT_Contacts.ContactType in (1, 3, 4, 12, 14, 16) group by FCT_Contacts.ContactID order by FCT_Contacts.LastUpdate desc`)

      const systems = contacts.reduce((aggregate, contact) => {
        if ([2, 3].includes(contact.ContactStatus)) {
          return aggregate
        }

        if (!aggregate[contact.SystemID]) {
          aggregate[contact.SystemID] = {
            SystemID: contact.SystemID,
            SystemName: contact.SystemName,

            Races: {},
            Totals: Object.fromEntries(Object.values(CONTACT_TYPES).map((type) => [type, []])),
          }
        }

        const system = aggregate[contact.SystemID]
        const type = CONTACT_TYPES[contact.ContactType] || 'Other'

        if (!system.Races[contact.ContactRaceID]) {
          system.Races[contact.ContactRaceID] = {
            Alien: contact,

            Types: Object.fromEntries(Object.values(CONTACT_TYPES).map((name) => [name, []])),
          }
        }

        system.Races[contact.ContactRaceID].Types[type].push(contact)
        system.Totals[type].push(contact)

        return aggregate
      }, {})

      return Object.values(systems).map((system) => ({
        id: `system:${system.SystemID}`,
        cells: {
          system: system.SystemName,
          contacts: intruderTotals(system.Totals),
        },
        caption: intruderRaces(system.Races),
        link: linkTo.map(system.SystemID),
      }))
    },
  },
  {
    key: 'dangerous-rifts',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'dangerous rift') + ' in occupied systems',
    rule: 'An aether rift sits in a system where I have fleets, colonies or ground unit bases.',
    columns: [
      { key: 'system', text: 'System' },
      { key: 'size', text: 'Size', align: 'end' },
      { key: 'fleets', text: 'Fleets' },
      { key: 'colonies', text: 'Colonies' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = (condition) => `(select count(*) from FCT_Fleet where FCT_Fleet.SystemID = FCT_AetherRift.SystemID and FCT_Fleet.RaceID = ${RaceID} and ${condition})`
      const colonies = (condition) => `(select count(*) from FCT_Population where FCT_Population.SystemID = FCT_AetherRift.SystemID and FCT_Population.RaceID = ${RaceID} and ${condition})`

      const rifts = await rowsOf(ctx, `select FCT_AetherRift.SystemID, FCT_AetherRift.Xcor, FCT_AetherRift.Ycor, FCT_AetherRift.Diameter, FCT_RaceSysSurvey.Name as SystemName, ${fleets('coalesce(FCT_Fleet.ShippingLine, 0) != 0')} as CivilianFleets, ${fleets('coalesce(FCT_Fleet.ShippingLine, 0) = 0')} as MilitaryFleets, ${colonies(INHABITED)} as InhabitedColonies, ${colonies(`${UNINHABITED} and ${HAS_INSTALLATIONS}`)} as UsedColonies, ${colonies(`${UNINHABITED} and not ${HAS_INSTALLATIONS} and ${HAS_STOCK}`)} as StockedColonies, ${colonies(`${UNINHABITED} and not ${HAS_INSTALLATIONS} and not ${HAS_STOCK} and ${HAS_GROUND_UNITS}`)} as GroundUnitBases from FCT_AetherRift inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_AetherRift.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} where FCT_AetherRift.GameID = ${GameID} order by FCT_AetherRift.Diameter desc`)

      return rifts.filter((rift) => rift.CivilianFleets || rift.MilitaryFleets || rift.InhabitedColonies || rift.UsedColonies || rift.StockedColonies || rift.GroundUnitBases).map((rift) => ({
        id: `rift:${rift.SystemID}:${rift.Xcor}:${rift.Ycor}`,
        cells: {
          system: rift.SystemName,
          size: `${ctx.count(rift.Diameter / 1000000, 2)} Mkm`,
          fleets: joined([rift.MilitaryFleets && plural(rift.MilitaryFleets, 'military fleet', 'military fleets'), rift.CivilianFleets && plural(rift.CivilianFleets, 'civilian fleet', 'civilian fleets')]),
          colonies: joined([
            rift.InhabitedColonies && plural(rift.InhabitedColonies, 'inhabited colony', 'inhabited colonies'),
            rift.UsedColonies && plural(rift.UsedColonies, 'used colony', 'used colonies'),
            rift.StockedColonies && plural(rift.StockedColonies, 'stocked colony', 'stocked colonies'),
            rift.GroundUnitBases && plural(rift.GroundUnitBases, 'ground unit base', 'ground unit bases'),
          ]),
        },
        link: linkTo.map(rift.SystemID),
      }))
    },
  },
  {
    key: 'active-lifepods',
    group: group.key,
    severity: 'attention',
    clock: true,
    title: (count) => amount(count, 'active lifepod'),
    rule: 'Lifepods I have detected are still adrift; their crews last two weeks from the ship\'s loss.',
    columns: [
      { key: 'ship', text: 'Lifepod of' },
      { key: 'crew', text: 'Crew', align: 'end' },
      { key: 'remaining', text: 'Time remaining', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID, GameTime } = ctx

      const lifepods = await rowsOf(ctx, `select FCT_Lifepods.LifepodID, FCT_Lifepods.SystemID, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, FCT_Lifepods.CreationTime, FCT_RaceSysSurvey.Name as SystemName from FCT_Lifepods left join FCT_RaceSysSurvey on FCT_Lifepods.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Lifepods.RaceID = FCT_RaceSysSurvey.RaceID where FCT_Lifepods.GameID = ${GameID} and FCT_Lifepods.RaceID = ${RaceID} order by FCT_Lifepods.CreationTime asc, FCT_Lifepods.Crew desc`)

      return lifepods.map((lifepod) => {
        const remaining = podExpiration(lifepod, GameTime)

        return {
          id: `lifepod:${lifepod.LifepodID}`,
          cells: {
            ship: lifepod.ShipName,
            crew: ctx.count(lifepod.Crew),
            remaining: { text: remaining, tone: remaining === 'Expired' ? 'error' : undefined },
          },
          caption: lifepod.SystemName || undefined,
          link: lifepod.SystemID ? linkTo.map(lifepod.SystemID) : undefined,
        }
      })
    },
  },
  {
    key: 'known-wrecks',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'wreck') + ' in explored space',
    rule: 'A wreck lies in a system I have surveyed.',
    columns: [
      { key: 'wreck', text: 'Wreck' },
      { key: 'size', text: 'Size', align: 'end' },
      { key: 'design', text: 'Design' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const wrecks = await rowsOf(ctx, `select FCT_Wrecks.WreckID, FCT_Wrecks.SystemID, FCT_Wrecks.Size, FCT_ShipClass.ClassName, CAST(CASE WHEN FCT_Wrecks.RaceID = FCT_RaceSysSurvey.RaceID THEN 1 ELSE 0 END AS BIT) as Owned, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Wrecks join FCT_RaceSysSurvey on FCT_Wrecks.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} left join FCT_ShipClass on FCT_Wrecks.ClassID = FCT_ShipClass.ShipClassID left join FCT_SystemBody on FCT_Wrecks.OrbitBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Wrecks.GameID = ${GameID}`)

      return wrecks.map((wreck) => ({
        id: `wreck:${wreck.WreckID}`,
        cells: {
          wreck: wreck.ClassName || 'Unknown class',
          size: ctx.count(wreck.Size, 1),
          design: wreck.Owned ? 'Owned' : '',
        },
        caption: wreck.SystemBodyID ? `${wreck.SystemName} — orbiting ${bodyText(wreck)}` : wreck.SystemName,
        link: linkTo.map(wreck.SystemID),
      }))
    },
  },
  {
    key: 'known-unexploited-constructs',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'unexploited ancient construct'),
    rule: 'An ancient construct on a surveyed body is dormant, or has no colony of mine with 10 million people on it, so its research bonus goes unused.',
    columns: [
      { key: 'construct', text: 'Construct' },
      { key: 'bonus', text: 'Research bonus' },
      { key: 'blocker', text: 'Blocked by' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const [orbitalRows] = await ctx.database.query(`
          select FCT_Fleet.AssignedPopulationID, sum(FCT_ShipCargo.Amount) as LoadedColonistAmount, VIR_StandardBerths.StandardBerthCapacity as StandardBerthCapacity from FCT_Fleet

          left join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID
          inner join (
              select FCT_ClassComponent.ClassID, sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) as StandardBerthCapacity from FCT_ClassComponent

              left join FCT_ShipDesignComponents on FCT_ClassComponent.ComponentID = FCT_ShipDesignComponents.SDComponentID

              where FCT_ShipDesignComponents.ComponentTypeID = 17 and FCT_ShipDesignComponents.SpecialFunction = 7 group by FCT_ClassComponent.ClassID
          ) as VIR_StandardBerths on VIR_StandardBerths.ClassID = FCT_Ship.ShipClassID
          left join FCT_ShipCargo on FCT_Ship.ShipID = FCT_ShipCargo.ShipID and FCT_ShipCargo.CargoTypeID = 1

          where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.AssignedPopulationID != 0 group by FCT_Fleet.AssignedPopulationID
        `)

      // Colonists loaded aboard orbiting ships count towards a colony's population up to the berths they fill.
      const orbitalPopulations = orbitalRows.reduce((accumulator, item) => {
        const loaded = item.LoadedColonistAmount || 0
        const capacity = item.StandardBerthCapacity || 0

        accumulator[item.AssignedPopulationID] = loaded >= capacity ? capacity : loaded

        return accumulator
      }, {})

      const rows = await rowsOf(ctx, `select FCT_AncientConstruct.AncientConstructID, FCT_AncientConstruct.Active, FCT_AncientConstruct.ResearchBonus, DIM_ResearchField.FieldName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, FCT_Population.PopulationID, FCT_Population.Population from FCT_AncientConstruct inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID} left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_AncientConstruct.ResearchField left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_Population on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_Population.RaceID = ${RaceID} where FCT_AncientConstruct.GameID = ${GameID} group by FCT_AncientConstruct.AncientConstructID, FCT_Population.PopulationID order by FCT_AncientConstruct.AncientConstructID`)

      const constructs = new Map()

      for (const row of rows) {
        if (!constructs.has(row.AncientConstructID)) {
          constructs.set(row.AncientConstructID, { construct: row, populations: [] })
        }

        if (row.PopulationID !== null) {
          constructs.get(row.AncientConstructID).populations.push(row.Population + (orbitalPopulations[row.PopulationID] || 0))
        }
      }

      return [...constructs.values()].filter(({ construct, populations }) => !construct.Active || !populations.length || !populations.filter((population) => population > 10).length).map(({ construct, populations }) => ({
        id: `construct:${construct.AncientConstructID}`,
        cells: {
          construct: `${construct.SystemName} — ${systemBodyName(construct)}`,
          bonus: construct.Active ? `${roundToDecimal((construct.ResearchBonus - 1) * 100)}% ${construct.FieldName}` : 'Dormant',
          blocker: populations.length ? 'Lacking 10 million population on the body' : 'No population on the body',
        },
        link: linkTo.planner({
          bodies: [{
            SystemBodyID: construct.SystemBodyID,
            SystemBodyName: construct.SystemBodyName,
            SystemName: construct.SystemName,
            BodyClass: construct.BodyClass,
            Component: construct.Component,
            PlanetNumber: construct.PlanetNumber,
            OrbitNumber: construct.OrbitNumber,
          }],
        }),
      }))
    },
  },
]
