import _partition from 'lodash/partition'

import { systemBodyName } from '../aurora'
import { HELD_CONTACT } from '../contacts'
import { linkTo } from '../deep-links'
import { isKnownNumber, roundToDecimal } from '../math'
import { amount, anyOf, bodyText, categoriesOf, checksOf, figure, lacking, listWords, rowsOf, signatureOf, systemText, tokenWords, unknownCell, verdictRows } from './common'

export const group = { key: 'space', title: 'Contacts and space', summary: 'Intruders, hazards and finds in surveyed space that may need a response.' }

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

// `13d 4h 2m 9s`, or `Expired` once the pod's two weeks are up; null while the pod's creation time or the game time is missing.
const podExpiration = (lifepod, gameTime) => {
  if (!isKnownNumber(lifepod.CreationTime) || !isKnownNumber(gameTime)) {
    return null
  }

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

// The inputs a contact can lack, keyed by the kind it is counted apart under, in that order: the standing of its empire, then whether it is held now (the time it was last detected, or the game time).
export const OPEN_INPUTS = Object.freeze({ standing: 'the standing of the empire a contact belongs to', detection: 'the time the race last detected a contact', clock: 'the game time' })

// The words after each count of a system's contacts, as [one, many]: a type of contact by the standing of its empire (keyed as the categories of the row's signature), then the contacts counted apart, by the first input each lacks.
export const CONTACT_WORDS = Object.freeze({
  'hostile Ship': ['Hostile Ship', 'Hostile Ships'],
  'neutral Ship': ['Ship', 'Ships'],
  'hostile Salvo': ['Hostile Salvo', 'Hostile Salvos'],
  'neutral Salvo': ['Salvo', 'Salvos'],
  'hostile Population': ['Hostile Population', 'Hostile Populations'],
  'neutral Population': ['Population', 'Populations'],
  'hostile GroundUnit': ['Hostile Ground Unit', 'Hostile Ground Units'],
  'neutral GroundUnit': ['Ground Unit', 'Ground Units'],
  'hostile Shipyard': ['Hostile Shipyard', 'Hostile Shipyards'],
  'neutral Shipyard': ['Shipyard', 'Shipyards'],
  'hostile Other': ['Hostile Other Contact', 'Hostile Other Contacts'],
  'neutral Other': ['Other Contact', 'Other Contacts'],
  standing: ['contact of unknown standing', 'contacts of unknown standing'],
  detection: ['contact with no stored detection time', 'contacts with no stored detection time'],
  clock: ['contact not known to be detected now', 'contacts not known to be detected now'],
})

const plural = (count, one, many) => (count === 1 ? `${count} ${one}` : `${count} ${many}`)

// `3 Hostile Ships`, the count with the page's separator.
const contactCount = (ctx, count, kind) => `${ctx.count(count)} ${CONTACT_WORDS[kind][count === 1 ? 0 : 1]}`

// What a contact lacks, as keys of OPEN_INPUTS: its empire's standing, and whether it is held now. `Held` is 1 when one of its tracks carries the game time; the query has already left out the contacts whose every track is older.
const openInputs = (contact) => [...(isKnownNumber(contact.ContactStatus) ? [] : ['standing']), ...(contact.Held === 1 ? [] : [isKnownNumber(contact.GameTime) ? 'detection' : 'clock'])]

// The names of every input the contacts counted apart lack.
const openNames = (unknown) => [...new Set(unknown.flatMap((item) => item.open))].map((kind) => OPEN_INPUTS[kind])

// What a system's contacts add up to by type, hostile ones first; tone is `error` when any is hostile. Contacts that lack an input are counted apart, by the first input each lacks, with the unavailable result naming every input missing.
const intruderTotals = (ctx, { Totals, Unknown }) => {
  const parts = []
  let hostile = false

  Object.entries(Totals).forEach(([type, contacts]) => {
    const [hostiles, neutrals] = _partition(contacts, (contact) => contact.ContactStatus === HOSTILE)

    if (hostiles.length) {
      hostile = true
      parts.push(contactCount(ctx, hostiles.length, `hostile ${type}`))
    }

    if (neutrals.length) {
      parts.push(contactCount(ctx, neutrals.length, `neutral ${type}`))
    }
  })

  Object.keys(OPEN_INPUTS).forEach((kind) => {
    const open = Unknown.filter((item) => item.open[0] === kind).length

    if (open) {
      parts.push(contactCount(ctx, open, kind))
    }
  })

  return { text: parts.join(', '), tone: hostile ? 'error' : undefined, result: Unknown.length ? ctx.unknown(openNames(Unknown)) : undefined }
}

// The words of the line under a system that names each empire with contacts there: the name shown for an empire whose name is not stored, and the mark of a hostile one.
export const RACE_WORDS = Object.freeze({ unnamed: 'An unknown empire', hostile: 'Hostile' })

// `Khanate — 4 Ships — Hostile; League — 1 Population`: each empire with contacts in the system, its contacts by type and the mark of a hostile one.
const intruderRaces = (ctx, races) => Object.values(races).map(({ Alien, Types }) => {
  const types = Object.entries(Types).filter(([, contacts]) => contacts.length).map(([type, contacts]) => contactCount(ctx, contacts.length, `neutral ${type}`)).join(', ')

  return `${Alien.AlienRaceName || RACE_WORDS.unnamed} — ${types}${Alien.ContactStatus === HOSTILE ? ` — ${RACE_WORDS.hostile}` : ''}`
}).join('; ')

const joined = (parts) => parts.filter(Boolean).join(', ')

// How the rift check sorts a colony of the race in the rift's system: with people, or without and then by what it holds (installations, stockpiles, ground units), the first that applies. A stored value that is missing leaves the sort open (SQLite's null), which the rift counts apart.
const STOCKPILES = ['FuelStockpile', 'MaintenanceStockpile', 'Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const INHABITED = 'FCT_Population.Population != 0'
const UNINHABITED = 'FCT_Population.Population = 0'
const HAS_INSTALLATIONS = 'exists (select 1 from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID)'
const HAS_STOCK = `(${STOCKPILES.map((stockpile) => `FCT_Population.${stockpile} != 0`).join(' or ')})`
const HAS_GROUND_UNITS = 'exists (select 1 from FCT_GroundUnitFormation where FCT_GroundUnitFormation.PopulationID = FCT_Population.PopulationID)'

const RIFT_COLONY_INPUT = 'the population or stockpiles of a colony in the rift\'s system'

const OCCUPANTS = ['CivilianFleets', 'MilitaryFleets', 'UnknownFleets', 'InhabitedColonies', 'UsedColonies', 'StockedColonies', 'GroundUnitBases']

const OCCUPANT_WORDS = { CivilianFleets: 'civilian fleets', MilitaryFleets: 'military fleets', UnknownFleets: 'unidentified fleets', InhabitedColonies: 'inhabited colonies', UsedColonies: 'colonies in use', StockedColonies: 'stocked colonies', GroundUnitBases: 'ground unit bases' }

export const checks = checksOf([
  {
    key: 'intruders',
    group: group.key,
    severity: 'needs-action',
    material: 'another kind of contact being there',
    captured: [listWords],
    title: (count) => `${amount(count, 'system')} with intruders`,
    rule: 'Another empire\'s ships, salvos, colonies, ground units or shipyards are detected now, on the last sensor pass before the save, in a system the race has surveyed, unless the race is allied with it or it is marked friendly; a contact lost earlier is left out, though the game keeps it for up to a year.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Contacts.ContactType, ContactID, ContactRaceID, SystemID, LastUpdate', 'FCT_Game.GameTime', 'FCT_AlienRace.ContactStatus', 'FCT_RaceSysSurvey.Name'],
      note: 'A presence check on the contacts the race holds now: a contact counts when one of its tracks (one for each way it is detected) carries the game time of the save, the time the game gives every track it still detects at each sensor pass. A lost contact keeps the time it was last detected and stays stored for up to a year; it is left out, whatever its type, colonies included. Each contact counts once, and empires stored as allied or friendly are left out. A contact whose empire has no stored standing, or whose detection time or the game time is not stored, is counted apart; a system whose only contacts are such is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'system', text: 'System' },
      { key: 'contacts', text: 'Contacts' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      // The tracks of the contacts the race may hold now: those at the game time, and those whose time or the game time is not stored. A contact whose every track is older is lost and never read.
      const tracks = await rowsOf(ctx, `select FCT_Contacts.ContactID, FCT_Contacts.SystemID, FCT_Contacts.ContactRaceID, FCT_Contacts.ContactType, (${HELD_CONTACT}) as Held, FCT_Game.GameTime, FCT_RaceSysSurvey.Name as SystemName, FCT_AlienRace.AlienRaceName, FCT_AlienRace.ContactStatus from FCT_Contacts inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Contacts.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} inner join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_Contacts.ContactRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} left join FCT_Game on FCT_Game.GameID = FCT_Contacts.GameID where FCT_Contacts.GameID = ${GameID} and FCT_Contacts.DetectRaceID = ${RaceID} and FCT_Contacts.ContactRaceID != ${RaceID} and FCT_Contacts.ContactType in (1, 3, 4, 12, 14, 16) and (${HELD_CONTACT}) is not 0`)

      // One contact for each type and subject in a system, held while one of its tracks is. A colony's ground units of both kinds are one contact.
      const contacts = new Map()

      tracks.forEach((track) => {
        const type = CONTACT_TYPES[track.ContactType] || 'Other'
        const key = `${track.SystemID}:${type}:${track.ContactID}`
        const kept = contacts.get(key)

        contacts.set(key, kept ? { ...kept, Held: anyOf(kept.Held, track.Held) } : { ...track, Type: type })
      })

      const systems = [...contacts.values()].reduce((aggregate, contact) => {
        if ([2, 3].includes(contact.ContactStatus)) {
          return aggregate
        }

        if (!aggregate[contact.SystemID]) {
          aggregate[contact.SystemID] = {
            SystemID: contact.SystemID,
            SystemName: contact.SystemName,

            Races: {},
            Totals: Object.fromEntries(Object.values(CONTACT_TYPES).map((type) => [type, []])),
            Unknown: [],
          }
        }

        const system = aggregate[contact.SystemID]
        const open = openInputs(contact)

        if (!system.Races[contact.ContactRaceID]) {
          system.Races[contact.ContactRaceID] = {
            Alien: contact,

            Types: Object.fromEntries(Object.values(CONTACT_TYPES).map((name) => [name, []])),
          }
        }

        system.Races[contact.ContactRaceID].Types[contact.Type].push(contact)

        if (open.length) {
          system.Unknown.push({ contact, open })
        } else {
          system.Totals[contact.Type].push(contact)
        }

        return aggregate
      }, {})

      return verdictRows(ctx, Object.values(systems), {
        verdict: (system) => (Object.values(system.Totals).some((totals) => totals.length) ? 1 : null),
        missing: (system) => openNames(system.Unknown),
        build: (system) => ({
          id: `system:${system.SystemID}`,
          cells: {
            system: systemText(system),
            contacts: intruderTotals(ctx, system),
          },
          caption: intruderRaces(ctx, system.Races),
          link: linkTo.map(system.SystemID),
          signature: system.Unknown.length ? null : signatureOf(categoriesOf(Object.entries(system.Totals).flatMap(([type, contacts]) => [...(contacts.some((contact) => contact.ContactStatus === HOSTILE) ? [`hostile ${type}`] : []), ...(contacts.some((contact) => contact.ContactStatus !== HOSTILE) ? [`neutral ${type}`] : [])]))),
        }),
      })
    },
  },
  {
    key: 'dangerous-rifts',
    group: group.key,
    severity: 'needs-action',
    material: 'another kind of occupant being in the rift\'s system',
    captured: [(token) => token.split(',').map((occupant) => OCCUPANT_WORDS[occupant] || occupant).join(', ')],
    title: (count) => amount(count, 'dangerous rift') + ' in occupied systems',
    rule: 'An aether rift sits in a system where the race has fleets, colonies or ground unit bases.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_AetherRift.SystemID, Diameter', 'FCT_Fleet.SystemID, ShippingLine', 'FCT_Population.SystemID, Population and stockpiles', 'FCT_PopulationInstallations', 'FCT_GroundUnitFormation'],
      note: 'A presence check on stored rows: a rift in a system with a fleet of the race, or a colony with people, installations, stockpiles or ground units. A rift whose only possible occupants are colonies with a missing population or stockpile is listed apart, as not evaluated; a missing rift diameter or fleet type shows a dash or is named.',
    },
    columns: [
      { key: 'system', text: 'System' },
      { key: 'size', text: 'Size', align: 'end' },
      { key: 'fleets', text: 'Fleets' },
      { key: 'colonies', text: 'Colonies' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const fleets = (condition) => `(select count(*) from FCT_Fleet where FCT_Fleet.SystemID = FCT_AetherRift.SystemID and FCT_Fleet.RaceID = ${RaceID} and ${condition})`
      const colonies = (condition) => `(select count(*) from FCT_Population where FCT_Population.SystemID = FCT_AetherRift.SystemID and FCT_Population.RaceID = ${RaceID} and (${condition}))`

      const rifts = await rowsOf(ctx, `select FCT_AetherRift.SystemID, FCT_AetherRift.Xcor, FCT_AetherRift.Ycor, FCT_AetherRift.Diameter, FCT_RaceSysSurvey.Name as SystemName, ${fleets('FCT_Fleet.ShippingLine != 0')} as CivilianFleets, ${fleets('FCT_Fleet.ShippingLine = 0')} as MilitaryFleets, ${fleets('FCT_Fleet.ShippingLine is null')} as UnknownFleets, ${colonies(INHABITED)} as InhabitedColonies, ${colonies(`${UNINHABITED} and ${HAS_INSTALLATIONS}`)} as UsedColonies, ${colonies(`${UNINHABITED} and not ${HAS_INSTALLATIONS} and ${HAS_STOCK}`)} as StockedColonies, ${colonies(`${UNINHABITED} and not ${HAS_INSTALLATIONS} and not ${HAS_STOCK} and ${HAS_GROUND_UNITS}`)} as GroundUnitBases, ${colonies(`FCT_Population.Population is null or (${UNINHABITED} and not ${HAS_INSTALLATIONS} and ${HAS_STOCK} is null and not ${HAS_GROUND_UNITS})`)} as OpenColonies from FCT_AetherRift inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_AetherRift.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} where FCT_AetherRift.GameID = ${GameID} order by FCT_AetherRift.Diameter desc`)

      return verdictRows(ctx, rifts, {
        verdict: (rift) => (OCCUPANTS.some((occupant) => rift[occupant] > 0) ? 1 : rift.OpenColonies > 0 ? null : 0),
        missing: () => [RIFT_COLONY_INPUT],
        build: (rift) => ({
          id: `rift:${rift.SystemID}:${rift.Xcor}:${rift.Ycor}`,
          cells: {
            system: systemText(rift),
            size: figure(ctx, rift.Diameter, 'the diameter of the rift', (known) => `${ctx.count(known / 1000000, 2)} Mkm`),
            fleets: (() => {
              const text = joined([rift.MilitaryFleets && plural(rift.MilitaryFleets, 'military fleet', 'military fleets'), rift.CivilianFleets && plural(rift.CivilianFleets, 'civilian fleet', 'civilian fleets'), rift.UnknownFleets && plural(rift.UnknownFleets, 'fleet of unknown type', 'fleets of unknown type')])

              return rift.UnknownFleets ? { text, result: ctx.unknown(['whether a fleet is a shipping line\'s']) } : text
            })(),
            colonies: (() => {
              const text = joined([
                rift.InhabitedColonies && plural(rift.InhabitedColonies, 'inhabited colony', 'inhabited colonies'),
                rift.UsedColonies && plural(rift.UsedColonies, 'used colony', 'used colonies'),
                rift.StockedColonies && plural(rift.StockedColonies, 'stocked colony', 'stocked colonies'),
                rift.GroundUnitBases && plural(rift.GroundUnitBases, 'ground unit base', 'ground unit bases'),
                rift.OpenColonies && plural(rift.OpenColonies, 'colony of unknown use', 'colonies of unknown use'),
              ])

              return rift.OpenColonies ? { text, result: ctx.unknown([RIFT_COLONY_INPUT]) } : text
            })(),
          },
          link: linkTo.map(rift.SystemID),
          signature: rift.OpenColonies > 0 ? null : signatureOf(categoriesOf(OCCUPANTS.filter((occupant) => rift[occupant] > 0))),
        }),
      })
    },
  },
  {
    key: 'active-lifepods',
    group: group.key,
    severity: 'attention',
    material: 'the lifepod expiring',
    captured: [tokenWords({ adrift: 'adrift', expired: 'expired' })],
    clock: true,
    title: (count) => amount(count, 'active lifepod'),
    rule: 'Detected lifepods are still adrift; their crews last two weeks from the ship\'s loss.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Lifepods.CreationTime, Crew, SystemID', 'the game time'],
      note: 'The lifepods, their crews and creation times are stored rows; the two weeks a crew lasts is a figure this page uses, not one read from stored data, so the time remaining is an estimate. A missing creation time or game time shows a dash.',
      assumptions: ['A lifepod crew lasts two weeks (1,209,600 seconds) from the pod\'s creation.'],
    },
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
            ship: lifepod.ShipName || unknownCell(ctx, ['the name of the ship the lifepod came from']),
            crew: figure(ctx, lifepod.Crew, 'the crew of the lifepod'),
            remaining: remaining === null ? unknownCell(ctx, [...lacking(lifepod, { CreationTime: 'the creation time of the lifepod' }), ...(isKnownNumber(GameTime) ? [] : ['the game time'])]) : { text: remaining, tone: remaining === 'Expired' ? 'error' : undefined },
          },
          caption: lifepod.SystemName || undefined,
          link: lifepod.SystemID ? linkTo.map(lifepod.SystemID) : undefined,
          signature: signatureOf(remaining === null ? null : remaining === 'Expired' ? 'expired' : 'adrift'),
        }
      })
    },
  },
  {
    key: 'known-wrecks',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'wreck') + ' in explored space',
    rule: 'A wreck lies in a surveyed system.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Wrecks.SystemID, Size, ClassID, RaceID, OrbitBodyID', 'FCT_ShipClass.ClassName of the race\'s own wrecks', 'FCT_AlienClass.ClassName of the race\'s intelligence on other races\' wrecks', 'FCT_RaceSysSurvey.Name'],
      note: 'A presence check on stored rows: a wreck in a system the race has surveyed. The race\'s own wreck shows its class; another race\'s shows the class name the race\'s intelligence holds, or Unknown. A missing size or owner shows a dash.',
    },
    columns: [
      { key: 'wreck', text: 'Wreck' },
      { key: 'size', text: 'Size', align: 'end' },
      { key: 'design', text: 'Design' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const wrecks = await rowsOf(ctx, `select FCT_Wrecks.WreckID, FCT_Wrecks.SystemID, FCT_Wrecks.Size, case when FCT_Wrecks.RaceID = FCT_RaceSysSurvey.RaceID then FCT_ShipClass.ClassName end as OwnClassName, FCT_AlienClass.ClassName as AlienClassName, (FCT_Wrecks.RaceID = FCT_RaceSysSurvey.RaceID) as Owned, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from FCT_Wrecks join FCT_RaceSysSurvey on FCT_Wrecks.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} left join FCT_ShipClass on FCT_Wrecks.ClassID = FCT_ShipClass.ShipClassID left join FCT_AlienClass on FCT_AlienClass.ActualClassID = FCT_Wrecks.ClassID and FCT_AlienClass.ViewRaceID = ${RaceID} and FCT_AlienClass.GameID = FCT_Wrecks.GameID left join FCT_SystemBody on FCT_Wrecks.OrbitBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_Wrecks.GameID = ${GameID}`)

      return wrecks.map((wreck) => ({
        id: `wreck:${wreck.WreckID}`,
        cells: {
          wreck: wreck.Owned ? wreck.OwnClassName || 'Unknown class' : wreck.AlienClassName || 'Unknown',
          size: figure(ctx, wreck.Size, 'the size of the wreck', (known) => ctx.count(known, 1)),
          design: isKnownNumber(wreck.Owned) ? (wreck.Owned ? 'Owned' : '') : unknownCell(ctx, ['the empire the wreck belonged to']),
        },
        caption: wreck.SystemBodyID ? `${systemText(wreck)} — orbiting ${bodyText(wreck)}` : systemText(wreck),
        link: linkTo.map(wreck.SystemID),
      }))
    },
  },
  {
    key: 'known-unexploited-constructs',
    group: group.key,
    severity: 'info',
    material: 'the blocker changing',
    captured: [tokenWords({ active: 'active', dormant: 'dormant' }), tokenWords({ unpopulated: 'no colony of the race there', populated: 'a colony with over 10 million people', lacking: 'colonies there with 10 million people or fewer' })],
    title: (count) => amount(count, 'unexploited ancient construct'),
    rule: 'An ancient construct on a surveyed body is dormant, or has no colony of the race with 10 million people on it, so its research bonus goes unused.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_AncientConstruct.Active, ResearchBonus, ResearchField', 'FCT_Population.Population', 'FCT_Fleet.AssignedPopulationID', 'FCT_ShipCargo.Amount', 'FCT_ClassComponent berths'],
      note: 'The construct\'s state and the colonies\' populations are stored values; the 10 million population a construct needs is a threshold this page uses, not one read from stored data, and colonists aboard orbiting ships are counted up to the berths they fill. A construct whose state or colony populations are missing, with no known colony of 10 million, is listed apart, as not evaluated.',
      assumptions: ['A construct needs a colony of the race with 10 million people on its body, counting colonists aboard orbiting ships up to the berths they fill.'],
    },
    columns: [
      { key: 'construct', text: 'Construct' },
      { key: 'bonus', text: 'Research bonus' },
      { key: 'blocker', text: 'Blocked by' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const orbitalRows = await rowsOf(ctx, `
          select FCT_Fleet.AssignedPopulationID, total(FCT_ShipCargo.Amount) as LoadedColonistAmount, sum(case when FCT_ShipCargo.ShipID is not null and FCT_ShipCargo.Amount is null then 1 else 0 end) as LoadedGaps, VIR_StandardBerths.StandardBerthCapacity as StandardBerthCapacity, VIR_StandardBerths.BerthGaps as BerthGaps from FCT_Fleet

          left join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID
          inner join (
              select FCT_ClassComponent.ClassID, sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) as StandardBerthCapacity, sum(case when FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null then 1 else 0 end) as BerthGaps from FCT_ClassComponent

              left join FCT_ShipDesignComponents on FCT_ClassComponent.ComponentID = FCT_ShipDesignComponents.SDComponentID

              where FCT_ShipDesignComponents.ComponentTypeID = 17 and FCT_ShipDesignComponents.SpecialFunction = 7 group by FCT_ClassComponent.ClassID
          ) as VIR_StandardBerths on VIR_StandardBerths.ClassID = FCT_Ship.ShipClassID
          left join FCT_ShipCargo on FCT_Ship.ShipID = FCT_ShipCargo.ShipID and FCT_ShipCargo.CargoTypeID = 1

          where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.AssignedPopulationID != 0 group by FCT_Fleet.AssignedPopulationID
        `)

      // Colonists loaded aboard orbiting ships count towards a colony's population up to the berths they fill; null while a cargo amount or a berth is missing.
      const orbitalPopulations = orbitalRows.reduce((accumulator, item) => {
        const known = item.LoadedGaps === 0 && item.BerthGaps === 0 && isKnownNumber(item.StandardBerthCapacity)

        accumulator[item.AssignedPopulationID] = known ? Math.min(item.LoadedColonistAmount, item.StandardBerthCapacity) : null

        return accumulator
      }, {})

      const rows = await rowsOf(ctx, `select FCT_AncientConstruct.AncientConstructID, FCT_AncientConstruct.Active, FCT_AncientConstruct.ResearchBonus, DIM_ResearchField.FieldName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, FCT_Population.PopulationID, FCT_Population.Population from FCT_AncientConstruct inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${RaceID} left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_AncientConstruct.ResearchField left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_Population on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_Population.RaceID = ${RaceID} where FCT_AncientConstruct.GameID = ${GameID} group by FCT_AncientConstruct.AncientConstructID, FCT_Population.PopulationID order by FCT_AncientConstruct.AncientConstructID`)

      const constructs = new Map()

      for (const row of rows) {
        if (!constructs.has(row.AncientConstructID)) {
          constructs.set(row.AncientConstructID, { construct: row, populations: [] })
        }

        if (row.PopulationID !== null) {
          const orbital = orbitalPopulations[row.PopulationID] === undefined ? 0 : orbitalPopulations[row.PopulationID]

          constructs.get(row.AncientConstructID).populations.push(isKnownNumber(row.Population) && isKnownNumber(orbital) ? row.Population + orbital : null)
        }
      }

      // Dormant, or without a colony of 10 million: 1, 0, or null while a state or a population is missing.
      const verdictOf = ({ construct, populations }) => {
        const dormant = isKnownNumber(construct.Active) ? Number(!construct.Active) : null
        const unknown = populations.filter((population) => population === null).length
        const populated = populations.some((population) => population !== null && population > 10)
        const blocked = populated ? 0 : unknown ? null : 1

        return anyOf(dormant, blocked)
      }

      return verdictRows(ctx, [...constructs.values()], {
        verdict: verdictOf,
        missing: ({ construct, populations }) => [...lacking(construct, { Active: 'whether the ancient construct is active' }), ...(populations.includes(null) ? ['the population of a colony on the construct\'s body'] : [])],
        build: ({ construct, populations }) => {
          const known = populations.filter((population) => population !== null)
          const unknown = populations.length - known.length
          const base = known.length ? 'Lacking 10 million population on the body' : unknown ? '' : 'No population on the body'
          const blocker = unknown ? [base, plural(unknown, 'colony of unknown population', 'colonies of unknown population')].filter(Boolean).join(', ') : base

          return {
            id: `construct:${construct.AncientConstructID}`,
            signature: signatureOf(isKnownNumber(construct.Active) ? (construct.Active ? 'active' : 'dormant') : null, unknown ? null : !known.length ? 'unpopulated' : known.some((population) => population > 10) ? 'populated' : 'lacking'),
            cells: {
              construct: `${systemText(construct)} — ${systemBodyName(construct)}`,
              bonus: !isKnownNumber(construct.Active) ? unknownCell(ctx, ['whether the ancient construct is active']) : construct.Active ? figure(ctx, construct.ResearchBonus, 'the research bonus of the ancient construct', (bonus) => `${roundToDecimal((bonus - 1) * 100)}% ${construct.FieldName || 'of an unknown field'}`) : 'Dormant',
              blocker: unknown ? { text: blocker, result: ctx.unknown(['the population of a colony on the construct\'s body']) } : blocker,
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
          }
        },
      })
    },
  },
])
