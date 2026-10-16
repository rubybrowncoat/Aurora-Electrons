// The reads behind the places Route Finder offers (utilities/places.js has the ones its page already holds). Every one is limited to the systems the race knows, and returns places with the `text` a search matches. The game lets a fleet move to a charted jump point, a Lagrange point, a body (planet, moon, asteroid or comet), a survey location, a wreck or life pod, one of the race's own waypoints, a colony, a fleet, or a contact the race holds now, each at a position the save stores. Aether gates are only ordered by the game's non-player races, but their place is stored too, so they are read as well.

import { systemBodyName } from './aurora'
import { place } from './deep-links'
import { groupIcon } from './places'

const rows = async (database, sql) => (await database.query(sql))[0]

const textOf = (...words) => words.filter(Boolean).join(' ').toLowerCase()

const known = (table, { GameID, RaceID }) => `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = ${table}.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}`

const ids = (values) => values.map(Number).filter(Number.isInteger).join(',')

const BODY_GROUPS = { 1: 'planet', 2: 'moon', 3: 'asteroid', 5: 'comet' }
const BODY_TYPES = { 1: 'Asteroid', 2: 'Terrestrial planet', 3: 'Dwarf planet', 4: 'Gas giant', 5: 'Super-Jovian', 7: 'Small moon', 8: 'Moon', 9: 'Large moon', 10: 'Small terrestrial moon', 11: 'Terrestrial moon', 14: 'Comet' }
const CONTACT_TYPES = { 1: 'Ship', 3: 'Missile salvo', 4: 'Population', 9: 'Packet', 12: 'Ground forces', 14: 'STO ground forces', 16: 'Shipyard', 22: 'Waypoint' }
// FCT_Waypoint.WaypointType values the game names with a prefix when the waypoint has no name of its own; a waypoint marked for deletion (4) is gone at the next increment.
export const WAYPOINT_NAMES = { 0: 'Waypoint', 1: 'Point of Interest', 2: 'Urgent POI', 3: 'Transit POI', 5: 'Training Waypoint', 6: 'Rendezvous Waypoint', 8: 'Temporary' }
export const MARKED_FOR_DELETION = 4

// How many bodies of each kind and survey locations the known systems hold, so the picker can say what it will list before it reads them: { planet, moon, asteroid, comet, survey }.
export const countLargePlaces = async (database, context) => {
  const { GameID } = context
  const [bodies, survey] = await Promise.all([
    rows(database, `select FCT_SystemBody.BodyClass, count(*) as Count
from FCT_SystemBody
${known('FCT_SystemBody', context)}
where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5)
group by FCT_SystemBody.BodyClass`),
    rows(database, `select count(*) as Count
from FCT_SurveyLocation
${known('FCT_SurveyLocation', context)}
where FCT_SurveyLocation.GameID = ${GameID}`),
  ])
  const counts = { planet: 0, moon: 0, asteroid: 0, comet: 0, survey: survey[0] ? survey[0].Count : 0 }

  bodies.forEach((row) => {
    counts[BODY_GROUPS[row.BodyClass]] = row.Count
  })

  return counts
}

const bodyQuery = (context, only) => `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName, FCT_RaceSysSurvey.Name as SystemName
from FCT_SystemBody
${known('FCT_SystemBody', context)}
left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${context.RaceID} and FCT_SystemBodyName.GameID = ${context.GameID}
where FCT_SystemBody.GameID = ${context.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5)${only ? ` and FCT_SystemBody.SystemBodyID in (${only})` : ''}`

// One place per body: planets, moons, asteroids and comets (the game offers every body of a system, surveyed or not). Asteroids and comets are only numbered inside their system, so the system is in the text a search matches.
const bodyPlaces = (list) => Object.freeze(list.map((row) => {
  const name = systemBodyName(row, { Name: row.SystemName })
  const group = BODY_GROUPS[row.BodyClass]

  return {
    key: place.body(row.SystemBodyID),
    kind: 'body',
    group,
    name,
    subtitle: `${BODY_TYPES[row.BodyTypeID] || 'Body'} in ${row.SystemName}`,
    icon: groupIcon(group),
    SystemID: row.SystemID,
    Xcor: row.Xcor,
    Ycor: row.Ycor,
    text: textOf(name, row.SystemName),
  }
}))

const surveyQuery = (context, only) => `select FCT_SurveyLocation.SurveyLocationID, FCT_SurveyLocation.SystemID, FCT_SurveyLocation.LocationNumber, FCT_SurveyLocation.Xcor, FCT_SurveyLocation.Ycor, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSurveyLocation.LocationNumber as SurveyedNumber
from FCT_SurveyLocation
${known('FCT_SurveyLocation', context)}
left join FCT_RaceSurveyLocation on FCT_RaceSurveyLocation.SystemID = FCT_SurveyLocation.SystemID and FCT_RaceSurveyLocation.LocationNumber = FCT_SurveyLocation.LocationNumber and FCT_RaceSurveyLocation.RaceID = ${context.RaceID} and FCT_RaceSurveyLocation.GameID = FCT_SurveyLocation.GameID
where FCT_SurveyLocation.GameID = ${context.GameID}${only ? ` and FCT_SurveyLocation.SurveyLocationID in (${only})` : ''}`

// One place per survey location: a fixed point of a system that gravitational survey ships go to, surveyed or not.
const surveyPlaces = (list) => Object.freeze(list.map((row) => ({
  key: place.survey(row.SurveyLocationID),
  kind: 'survey',
  group: 'survey',
  name: `Survey location #${row.LocationNumber}`,
  subtitle: `${row.SurveyedNumber === null || row.SurveyedNumber === undefined ? 'Unsurveyed' : 'Surveyed'} in ${row.SystemName}`,
  icon: groupIcon('survey'),
  SystemID: row.SystemID,
  Xcor: row.Xcor,
  Ycor: row.Ycor,
  text: textOf(`Survey location #${row.LocationNumber}`, row.SystemName),
})))

// Every body of the known systems, and every survey location in them. Each is a read of its own that can run to hundreds of thousands of rows on a large save, so the picker asks for it only when it lists that group.
export const loadBodyPlaces = async (database, context) => bodyPlaces(await rows(database, bodyQuery(context)))

export const loadSurveyPlaces = async (database, context) => surveyPlaces(await rows(database, surveyQuery(context)))

// The body and survey location places a list of place keys names, for the stops a route keeps without having read the whole lists. Keys of any other kind are left out.
export const loadPlacesByKeys = async (database, context, keys) => {
  const wanted = { body: [], survey: [] }

  keys.forEach((key) => {
    const [kind, id] = key.split(':')

    if (wanted[kind]) {
      wanted[kind].push(id)
    }
  })

  const [bodies, locations] = await Promise.all([
    ids(wanted.body) ? rows(database, bodyQuery(context, ids(wanted.body))).then(bodyPlaces) : [],
    ids(wanted.survey) ? rows(database, surveyQuery(context, ids(wanted.survey))).then(surveyPlaces) : [],
  ])

  return [...bodies, ...locations]
}

// The race's own waypoints, in order of number.
const loadWaypoints = async (database, context) => (await rows(database, `select FCT_Waypoint.WaypointID, FCT_Waypoint.SystemID, FCT_Waypoint.Xcor, FCT_Waypoint.Ycor, FCT_Waypoint.Number, FCT_Waypoint.WaypointType, FCT_Waypoint.Name, FCT_RaceSysSurvey.Name as SystemName
from FCT_Waypoint
${known('FCT_Waypoint', context)}
where FCT_Waypoint.GameID = ${context.GameID} and FCT_Waypoint.RaceID = ${context.RaceID} and FCT_Waypoint.WaypointType != ${MARKED_FOR_DELETION}
order by FCT_Waypoint.Number`)).map((row) => {
  const name = row.Name || `${WAYPOINT_NAMES[row.WaypointType] || 'Waypoint'} #${row.Number}`

  return {
    key: place.waypoint(row.WaypointID),
    kind: 'waypoint',
    group: 'waypoint',
    name,
    subtitle: `Waypoint in ${row.SystemName}`,
    icon: groupIcon('waypoint'),
    SystemID: row.SystemID,
    Xcor: row.Xcor,
    Ycor: row.Ycor,
    text: textOf(name, row.SystemName),
  }
})

// The game lists every wreck of a system, whoever's it was: the race's own by hull and class, another's by the class name its intelligence holds.
const loadWrecks = async (database, context, count) => (await rows(database, `select FCT_Wrecks.WreckID, FCT_Wrecks.SystemID, FCT_Wrecks.Xcor, FCT_Wrecks.Ycor, FCT_Wrecks.RaceID as WreckRaceID, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_HullDescription.HullAbbr, FCT_AlienClass.ClassName as AlienClassName, FCT_RaceSysSurvey.Name as SystemName
from FCT_Wrecks
${known('FCT_Wrecks', context)}
left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Wrecks.ClassID
left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_ShipClass.HullDescriptionID
left join FCT_AlienClass on FCT_AlienClass.ActualClassID = FCT_Wrecks.ClassID and FCT_AlienClass.ViewRaceID = ${context.RaceID} and FCT_AlienClass.GameID = FCT_Wrecks.GameID
where FCT_Wrecks.GameID = ${context.GameID}
group by FCT_Wrecks.WreckID
order by FCT_ShipClass.Size desc`)).map((row) => {
  const own = row.WreckRaceID === context.RaceID
  const name = `Wreck: ${own ? [row.HullAbbr, row.ClassName].filter(Boolean).join(' ') : row.AlienClassName || 'unknown class'}`

  return {
    key: place.wreck(row.WreckID),
    kind: 'wreck',
    group: 'wreck',
    name,
    subtitle: `${Number.isFinite(row.Size) ? `${count(row.Size * 50)} t wreck` : 'Wreck of unknown size'} in ${row.SystemName}`,
    icon: groupIcon('wreck'),
    SystemID: row.SystemID,
    Xcor: row.Xcor,
    Ycor: row.Ycor,
    text: textOf(name, row.SystemName),
  }
})

const loadLifepods = async (database, context) => (await rows(database, `select FCT_Lifepods.LifepodID, FCT_Lifepods.SystemID, FCT_Lifepods.Xcor, FCT_Lifepods.Ycor, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, FCT_RaceSysSurvey.Name as SystemName
from FCT_Lifepods
${known('FCT_Lifepods', context)}
where FCT_Lifepods.GameID = ${context.GameID}
order by FCT_Lifepods.ShipName`)).map((row) => ({
  key: place.lifepod(row.LifepodID),
  kind: 'lifepod',
  group: 'lifepod',
  name: `Life pods: ${row.ShipName}`,
  subtitle: `${Number.isFinite(row.Crew) ? `${row.Crew} ${row.Crew === 1 ? 'survivor' : 'survivors'}` : 'Survivors not recorded'} in ${row.SystemName}`,
  icon: groupIcon('lifepod'),
  SystemID: row.SystemID,
  Xcor: row.Xcor,
  Ycor: row.Ycor,
  text: textOf('life pods', row.ShipName, row.SystemName),
}))

const loadAetherGates = async (database, context) => (await rows(database, `select FCT_AetherGates.AetherGateID, FCT_AetherGates.SystemID, FCT_AetherGates.Xcor, FCT_AetherGates.Ycor, FCT_RaceSysSurvey.Name as SystemName
from FCT_AetherGates
${known('FCT_AetherGates', context)}
where FCT_AetherGates.GameID = ${context.GameID}
order by FCT_AetherGates.AetherGateID`)).map((row) => ({
  key: place.aether(row.AetherGateID),
  kind: 'aether',
  group: 'aether',
  name: `Aether gate #${row.AetherGateID}`,
  subtitle: `Aether gate in ${row.SystemName}`,
  icon: groupIcon('aether'),
  SystemID: row.SystemID,
  Xcor: row.Xcor,
  Ycor: row.Ycor,
  text: textOf('aether gate', row.AetherGateID, row.SystemName),
}))

// What the race holds now, as the game lists it: contacts last updated this increment, other races' only. A contact is stored once for each way it was detected, so the rows of one contact collapse into a place that answers to each row's `UniqueID` (`aliases`, the other place keys), the one a move order names.
const loadContacts = async (database, context) => (await rows(database, `select max(FCT_Contacts.UniqueID) as UniqueID, group_concat(FCT_Contacts.UniqueID) as UniqueIDs, FCT_Contacts.ContactType, FCT_Contacts.SystemID, FCT_Contacts.ContactName, FCT_Contacts.Xcor, FCT_Contacts.Ycor, max(FCT_Contacts.LastUpdate) as LastUpdate, FCT_AlienRace.AlienRaceName, FCT_RaceSysSurvey.Name as SystemName
from FCT_Contacts
inner join FCT_Game on FCT_Game.GameID = FCT_Contacts.GameID
${known('FCT_Contacts', context)}
left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Contacts.GameID and FCT_AlienRace.ViewRaceID = ${context.RaceID} and FCT_AlienRace.AlienRaceID = FCT_Contacts.ContactRaceID
where FCT_Contacts.GameID = ${context.GameID} and FCT_Contacts.DetectRaceID = ${context.RaceID} and FCT_Contacts.ContactRaceID != ${context.RaceID} and FCT_Contacts.LastUpdate = FCT_Game.GameTime
group by FCT_Contacts.ContactType, FCT_Contacts.ContactID
order by FCT_Contacts.ContactName`)).map((row) => ({
  key: place.contact(row.UniqueID),
  aliases: String(row.UniqueIDs).split(',').map((id) => place.contact(id)),
  kind: 'contact',
  group: 'contact',
  name: row.ContactName,
  subtitle: `${CONTACT_TYPES[row.ContactType] || 'Contact'}${row.AlienRaceName ? ` of ${row.AlienRaceName}` : ''} in ${row.SystemName}`,
  icon: groupIcon('contact'),
  SystemID: row.SystemID,
  Xcor: row.Xcor,
  Ycor: row.Ycor,
  lastUpdate: row.LastUpdate,
  text: textOf(row.ContactName, row.AlienRaceName, row.SystemName),
}))

// The places that come in modest numbers, all read together: waypoints, wrecks, life pods, contacts and aether gates. `count(number)` formats a figure.
export const loadSmallPlaces = async (database, context, count) => {
  const lists = await Promise.all([loadWaypoints(database, context), loadWrecks(database, context, count), loadLifepods(database, context), loadContacts(database, context), loadAetherGates(database, context)])

  return Object.freeze(lists.flat())
}
