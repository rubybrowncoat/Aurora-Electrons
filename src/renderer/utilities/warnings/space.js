import _partition from 'lodash/partition'
import { Op } from 'sequelize'

import { modelSystemBodyName } from '../aurora'
import { linkTo } from '../deep-links'
import { roundToDecimal } from '../math'
import { amount, bodyText, rowsOf } from './common'

export const group = { key: 'space', title: 'Contacts and space' }

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
    const [hostiles, neutrals] = _partition(contacts, (contact) => contact.ContactRace.AlienRaces[0].ContactStatus === HOSTILE)

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

const intruderRaces = (races) => Object.values(races).map((race) => {
  const alien = race.Race.AlienRaces[0]
  const types = Object.entries(race.Types).filter(([, contacts]) => contacts.length).map(([type, contacts]) => `${contacts.length} ${type}s`).join(', ')

  return `${alien.AlienRaceName} — ${types}${alien.ContactStatus === HOSTILE ? ' — Hostile' : ''}`
}).join('; ')

const plural = (count, one, many) => (count === 1 ? `${count} ${one}` : `${count} ${many}`)

const joined = (parts) => parts.filter(Boolean).join(', ')

export const checks = [
  {
    key: 'intruders',
    group: group.key,
    severity: 'needs-action',
    title: (count) => `${amount(count, 'system')} with intruders`,
    rule: 'Another empire\'s ships, salvos, colonies, ground units or shipyards are detected in a system you have surveyed, unless you are allied with it or it is marked friendly.',
    columns: [
      { key: 'system', text: 'System' },
      { key: 'contacts', text: 'Contacts' },
    ],
    async read(ctx) {
      const { database, GameID, RaceID } = ctx

      const contacts = await database.models.Contact.findAll({
        where: {
          GameID,
          DetectRaceID: RaceID,

          ContactType: {
            [Op.in]: [1, 3, 4, 12, 14, 16],
          },
        },

        group: 'ContactID',
        order: [['LastUpdate', 'DESC']],

        include: [
          {
            required: true,
            model: database.models.System,
            include: [
              {
                required: true,
                model: database.models.RaceSystemSurvey,
                where: {
                  RaceID,
                },
              },
            ],
          },
          {
            required: true,
            model: database.models.Race,
            as: 'ContactRace',

            where: {
              RaceID: {
                [Op.ne]: RaceID,
              },
            },

            include: [
              {
                model: database.models.AlienRace,

                where: {
                  ViewRaceID: RaceID,
                },
              },
            ],
          },
        ],
      })

      const systems = contacts.reduce((aggregate, contact) => {
        const { ContactStatus } = (contact.ContactRace.AlienRaces[0] || {})

        if (!contact.ContactRace.AlienRaces.length || [2, 3].includes(ContactStatus)) {
          return aggregate
        }

        if (!aggregate[contact.SystemID]) {
          aggregate[contact.SystemID] = {
            SystemID: contact.SystemID,
            SystemName: contact.System.RaceSystemSurveys[0].Name,

            Races: {},
            Totals: Object.fromEntries(Object.values(CONTACT_TYPES).map((type) => [type, []])),
          }
        }

        const system = aggregate[contact.SystemID]
        const type = CONTACT_TYPES[contact.ContactType] || 'Other'

        if (!system.Races[contact.ContactRaceID]) {
          system.Races[contact.ContactRaceID] = {
            Race: contact.ContactRace,

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
    rule: 'An aether rift sits in a system where you have fleets, colonies or ground unit bases.',
    columns: [
      { key: 'system', text: 'System' },
      { key: 'size', text: 'Size', align: 'end' },
      { key: 'fleets', text: 'Fleets' },
      { key: 'colonies', text: 'Colonies' },
    ],
    async read(ctx) {
      const { database, GameID, RaceID } = ctx

      const rifts = await database.models.AetherRift.findAll({
        where: {
          GameID,
        },

        include: [
          {
            required: true,
            model: database.models.System,
            include: [
              {
                required: true,
                model: database.models.RaceSystemSurvey,
                where: {
                  RaceID,
                },
              },
              {
                required: false,
                model: database.models.Population,
                where: {
                  RaceID,
                },
                include: [
                  {
                    model: database.models.PopulationInstallation,
                  },
                  {
                    model: database.models.GroundUnitFormation,
                  },
                ],
              },
              {
                required: false,
                model: database.models.Fleet,
                where: {
                  RaceID,
                },
              },
            ],
          },
        ],

        order: [['Diameter', 'DESC']],
      })

      return rifts.map((rift) => {
        const [civilianFleets, militaryFleets] = _partition(rift.System.Fleets, (fleet) => fleet.ShippingLine)

        const [inhabitedColonies, uninhabitedColonies] = _partition(rift.System.Populations, (population) => population.Population)
        const [usedColonies, unusedColonies] = _partition(uninhabitedColonies, (population) => population.PopulationInstallations.length)
        const [stockedColonies, emptyColonies] = _partition(unusedColonies, (population) => population.FuelStockpile || population.MaintenanceStockpile || population.Duranium || population.Neutronium || population.Corbomite || population.Tritanium || population.Boronide || population.Mercassium || population.Vendarite || population.Sorium || population.Uridium || population.Corundium || population.Gallicite)
        const [groundUnitBases] = _partition(emptyColonies, (population) => population.GroundUnitFormations.length)

        return {
          rift,
          civilianFleets: civilianFleets.length,
          militaryFleets: militaryFleets.length,
          inhabitedColonies: inhabitedColonies.length,
          usedColonies: usedColonies.length,
          stockedColonies: stockedColonies.length,
          groundUnitBases: groundUnitBases.length,
        }
      }).filter((item) => item.civilianFleets || item.militaryFleets || item.inhabitedColonies || item.usedColonies || item.stockedColonies || item.groundUnitBases).map((item) => ({
        id: `rift:${item.rift.SystemID}:${item.rift.Xcor}:${item.rift.Ycor}`,
        cells: {
          system: item.rift.System.RaceSystemSurveys[0].Name,
          size: `${ctx.count(item.rift.Diameter / 1000000, 2)} Mkm`,
          fleets: joined([item.militaryFleets && plural(item.militaryFleets, 'military fleet', 'military fleets'), item.civilianFleets && plural(item.civilianFleets, 'civilian fleet', 'civilian fleets')]),
          colonies: joined([
            item.inhabitedColonies && plural(item.inhabitedColonies, 'inhabited colony', 'inhabited colonies'),
            item.usedColonies && plural(item.usedColonies, 'used colony', 'used colonies'),
            item.stockedColonies && plural(item.stockedColonies, 'stocked colony', 'stocked colonies'),
            item.groundUnitBases && plural(item.groundUnitBases, 'ground unit base', 'ground unit bases'),
          ]),
        },
        link: linkTo.map(item.rift.SystemID),
      }))
    },
  },
  {
    key: 'active-lifepods',
    group: group.key,
    severity: 'attention',
    clock: true,
    title: (count) => amount(count, 'active lifepod'),
    rule: 'Lifepods you have detected are still adrift; their crews last two weeks from the ship\'s loss.',
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
    rule: 'A wreck lies in a system you have surveyed.',
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
    rule: 'An ancient construct on a surveyed body is dormant, or has no colony of yours with 10 million people on it, so its research bonus goes unused.',
    columns: [
      { key: 'construct', text: 'Construct' },
      { key: 'bonus', text: 'Research bonus' },
      { key: 'blocker', text: 'Blocked by' },
    ],
    async read(ctx) {
      const { database, GameID, RaceID } = ctx

      const [orbitalRows] = await database.query(`
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

      const constructs = await database.models.AncientConstruct.findAll({
        where: {
          GameID,
        },

        include: [
          {
            model: database.models.ResearchField,
          },
          {
            required: true,
            model: database.models.SystemBody,
            include: [
              {
                required: false,
                model: database.models.Population,
              },
              {
                required: true,
                model: database.models.System,
                include: [
                  {
                    required: true,
                    model: database.models.RaceSystemSurvey,
                    where: {
                      RaceID,
                    },
                  },
                ],
              },
              {
                required: true,
                model: database.models.SystemBodySurvey,
                where: {
                  RaceID,
                },
              },
              {
                required: false,
                model: database.models.SystemBodyName,
                where: {
                  RaceID,
                },
              },
              {
                model: database.models.Star,
              },
            ],
          },
        ],
      })

      return constructs.map((construct) => {
        const populations = construct.SystemBody.Populations.filter((population) => population.RaceID === RaceID).map((population) => population.Population + (orbitalPopulations[population.PopulationID] || 0))

        return { construct, populations }
      }).filter(({ construct, populations }) => !construct.Active || !populations.length || !populations.filter((population) => population > 10).length).map(({ construct, populations }) => {
        const body = construct.SystemBody
        const systemName = body.System.RaceSystemSurveys[0].Name

        return {
          id: `construct:${construct.AncientConstructID}`,
          cells: {
            construct: `${systemName} — ${modelSystemBodyName(body)}`,
            bonus: construct.Active ? `${roundToDecimal((construct.ResearchBonus - 1) * 100)}% ${construct.ResearchField.FieldName}` : 'Dormant',
            blocker: populations.length ? 'Lacking 10 million population on the body' : 'No population on the body',
          },
          link: linkTo.planner({
            bodies: [{
              SystemBodyID: body.SystemBodyID,
              SystemBodyName: body.SystemBodyNames.length ? body.SystemBodyNames[0].Name : null,
              SystemName: systemName,
              BodyClass: body.BodyClass,
              Component: body.Star.Component,
              PlanetNumber: body.PlanetNumber,
              OrbitNumber: body.OrbitNumber,
            }],
          }),
        }
      })
    },
  },
]
