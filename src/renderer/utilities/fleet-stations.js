// The intended station and preferred supply base of a fleet, kept as the player's own notes: where the fleet is meant to sit and which colony it is meant to resupply at, apart from where it is now and from the orders saved for it.
//
// A note is a typed record of the scenario repository (utilities/scenario-records.js) of kind `fleet.station`, kept in the campaign's scenario file for the race and by default for the branch only. Its payload is `{ fleet, station, base, note }`: `fleet` is the fleet the note belongs to, `station` a body or a waypoint (or null) and `base` a colony (or null). Each of the three is a reference `{ type, id, name, systemId, systemName, origin, confirmed }`: what the player saw when the note was last kept (the name and system, for display only), the campaign and branch the link was made on (`origin`) and the object as the player confirmed it (`confirmed`: its fingerprint, its name and, for a fleet, the classes of its ships). The record's links are the fleet, then the station, then the base, each as far as the note has it, in that order.
//
// Three things stay apart and are never merged into one figure: the note (what the player intends), the fleet's location (what the save holds now, compared with the note only when both are known to be the objects the note named) and the orders saved for the fleet (what the game will do). The app issues no order and writes nothing to the save: every read is a select.
//
// Whether a link still holds is worked out on every read against the objects of the open save and is never stored. An ID can be given again (a fleet deleted and a new one made, a waypoint cleared, a colony removed), so an object is the one the note named only where the save proves it (a fleet's creation entry, a body's system discovery time: `held` by evidence) or where the player confirmed that very object, by its fingerprint, name and, for a fleet, the overlap of its ship classes (`held` by confirmation; a waypoint and a colony are held this way only, the creation time of a waypoint being set again whenever the game refreshes it). An object that is there under the ID but is not shown to be the one named (its fingerprint differs, or the save stores nothing that tells) needs review: nothing is compared with it, the note attaches to no fleet until the player confirms it, and the link is never moved to another object by its name or its place. An object that is not there is gone: a deleted fleet leaves its note archived, a deleted station or base leaves the note stale, both readable with the name and system they last had.
//
// Where a fleet is against its station: a fleet that is in the orbit of the station's body (or of the body a waypoint is tied to) is on station by that identity, whatever coordinates the body had when the note was made. Otherwise the stored position is compared with the station's own within the distance below which the game takes two points for one; a body that is only matched by position is not followed by the fleet when it moves.
//
// Storage and the rules of a stale edit are the repository's. This module takes the repository and the database as arguments, so a check runs it on in-memory stores.

import { systemBodyName } from './aurora'
import { NOTE_TARGETS, noteChoices, withBodies } from './economy-notes'
import { LINK_TYPES, checkLink, failure, mayWrite, resolveLink, sharedHistory } from './history-milestones'
import { MARKED_FOR_DELETION, WAYPOINT_NAMES } from './place-data'
import { ofRule, registerRule, unavailable } from './provenance'

export { scopeOf } from './history-milestones'
export { withBodies }

export const STATION_KIND = 'fleet.station'
export const STATION_SCHEMA = 1
export const NOTE_LENGTH = 200
export const BODIES_PER_READ = 400

// Two points less than this far apart (km) are one point to the game's movement: a distance under a kilometre is taken for none.
export const ON_STATION_KM = 1

// A waypoint asked for within this distance (per axis, in the stored coordinate unit) of one that is there is that one to the game, which only refreshes its creation time; two fixed points that near are the same spot.
const WAYPOINT_SAME_SPOT = 1

export const ROLES = Object.freeze(['fleet', 'station', 'base'])

export const ROLE_TYPES = Object.freeze({
  fleet: Object.freeze(['fleet']),
  station: Object.freeze(['body', 'waypoint']),
  base: Object.freeze(['colony']),
})

export const VERDICTS = Object.freeze({ HELD: 'held', REVIEW: 'review', GONE: 'gone', UNREAD: 'unread' })

const STATION_VERSIONS = ['2.7.x']

registerRule({
  id: 'fleetStation.onStation',
  versions: STATION_VERSIONS,
  verification: 'estimated',
  structure: ['FCT_Fleet.OrbitBodyID, AssignedPopulationID, SystemID, Xcor, Ycor', 'FCT_SystemBody.SystemBodyID, Xcor, Ycor', 'FCT_Waypoint.OrbitBodyID, SystemID, Xcor, Ycor', 'FCT_Population.SystemBodyID'],
  note: 'A fleet is on station when it is in the orbit of the station\'s body (or of the body a waypoint is tied to): the game puts a fleet that arrives at a body with no minimum distance into that body\'s orbit and moves it with the body, so the orbit is the identity and the coordinates follow. A fleet not in that orbit is on station only if its stored position is within a kilometre of the station\'s, the distance below which the game takes two points for one, and a body matched by position alone is not followed when it moves. The comparison is made only against the object the note named, never one that has taken its ID.',
  assumptions: ['the stored coordinates are kilometres', 'a fleet that is moving is compared at its stored position'],
})

registerRule({
  id: 'fleetStation.distance',
  versions: STATION_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['FCT_Fleet.Xcor, Ycor, SystemID', 'FCT_SystemBody.Xcor, Ycor', 'FCT_Waypoint.Xcor, Ycor'],
  note: 'The straight line between the fleet\'s stored position and the station\'s, in the same system. Nothing is given between two systems, and a moving fleet is taken at the position last stored for it.',
  assumptions: ['the stored coordinates are kilometres'],
})

registerRule({
  id: 'fleetStation.notes',
  versions: STATION_VERSIONS,
  units: 'notes',
  verification: 'confirmed',
  structure: ['the scenario records of kind fleet.station'],
  note: 'A count of the player\'s own notes in the open campaign and branch, read from the scenario repository; it says nothing about the save.',
})

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const idOk = (id) => isText(id) || (typeof id === 'number' && Number.isFinite(id))

const copyOf = (value) => JSON.parse(JSON.stringify(value))

const present = (value) => (value === null || value === undefined ? '' : String(value))

const messageOf = (error) => (error && error.message ? error.message : String(error))

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const batchesOf = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size))

// The ship classes of a fleet: the ones the ships have, [] for a fleet that has no ship, and null where ships are there (or are not counted) and no class is known, which is not the same as a fleet with no ship.
const classesOf = (text, ships) => {
  const known = text === null || text === undefined || text === '' ? [] : [...new Set(String(text).split(',').map(Number).filter(Number.isInteger))].sort((a, b) => a - b)

  return known.length > 0 ? known : ships === 0 ? [] : null
}

// ---- The objects a note is about -------------------------------------------------------------------------------------

const FLEET_SQL = "select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.OrbitBodyID, FCT_Fleet.AssignedPopulationID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, Founded.CreatedTime, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, (select group_concat(distinct FCT_Ship.ShipClassID) from FCT_Ship where FCT_Ship.FleetID = FCT_Fleet.FleetID and FCT_Ship.GameID = FCT_Fleet.GameID) as Classes, (select count(*) from FCT_Ship where FCT_Ship.FleetID = FCT_Fleet.FleetID and FCT_Ship.GameID = FCT_Fleet.GameID) as Ships from FCT_Fleet left join (select FCT_FleetHistory.FleetID, min(FCT_FleetHistory.GameTime) as CreatedTime from FCT_FleetHistory where FCT_FleetHistory.GameID = :GameID and FCT_FleetHistory.Description like 'Created on%' group by FCT_FleetHistory.FleetID) Founded on Founded.FleetID = FCT_Fleet.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBody.GameID = FCT_Fleet.GameID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodyName.RaceID = FCT_Fleet.RaceID and FCT_SystemBodyName.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID order by FCT_Fleet.FleetID"

const WAYPOINT_SQL = `select FCT_Waypoint.WaypointID, FCT_Waypoint.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Waypoint.OrbitBodyID, FCT_Waypoint.CreationTime, FCT_Waypoint.Xcor, FCT_Waypoint.Ycor, FCT_Waypoint.Number, FCT_Waypoint.WaypointType, FCT_Waypoint.Name from FCT_Waypoint left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Waypoint.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Waypoint.RaceID and FCT_RaceSysSurvey.GameID = FCT_Waypoint.GameID where FCT_Waypoint.GameID = :GameID and FCT_Waypoint.RaceID = :RaceID and FCT_Waypoint.WaypointType != ${MARKED_FOR_DELETION} order by FCT_Waypoint.Number`

const BODY_CLASSES = '1, 2, 3, 5'

const bodySql = (filter) => `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSysSurvey.DiscoveredTime from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = :RaceID and FCT_RaceSysSurvey.GameID = :GameID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = :RaceID and FCT_SystemBodyName.GameID = :GameID where FCT_SystemBody.GameID = :GameID and FCT_SystemBody.BodyClass in (${BODY_CLASSES}) and ${filter} order by FCT_SystemBody.SystemBodyID`

const bodiesOfSystemSql = bodySql('FCT_SystemBody.SystemID = :SystemID')

const bodiesByIdSql = (ids) => bodySql(`FCT_SystemBody.SystemBodyID in (${ids.join(', ')})`)

const ORDERS_SQL = 'select FCT_MoveOrders.MoveOrderID, FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.Description, FCT_MoveOrders.DestinationType, FCT_MoveOrders.DestinationID, FCT_MoveOrders.MinDistance, FCT_MoveOrders.Arrived from FCT_MoveOrders where FCT_MoveOrders.GameID = :GameID and FCT_MoveOrders.RaceID = :RaceID order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveOrderID'

// The game's destination types of a move order that name a body (2 system body, 15 deep space population) and a waypoint (5).
const BODY_DESTINATIONS = Object.freeze([2, 15])
const WAYPOINT_DESTINATION = 5

// The kinds of object a note names, in the shape of the milestones' `LINK_TYPES` (utilities/history-milestones.js), which the link check reads. `fingerprint` holds only what the game does not change when the player renames the object; `identity` says what makes the object the same one when its ID may have been given again ('created' with the index of the fingerprint part that holds the time, 'unwitnessed' for an object the save dates nowhere). The rows carry where the object is now: `x` and `y` are its stored position and null where the save holds none.
export const STATION_TARGETS = Object.freeze({
  fleet: Object.freeze({
    label: 'Fleet',
    identity: 'created',
    created: NOTE_TARGETS.fleet.created,
    sql: FLEET_SQL,
    row: (source) => ({
      ...NOTE_TARGETS.fleet.row(source),
      orbitBodyId: numberOrNull(source.OrbitBodyID),
      orbitName: source.OrbitBodyID > 0 && source.BodyClass !== null && source.BodyClass !== undefined ? systemBodyName({ SystemBodyName: source.SystemBodyName, BodyClass: source.BodyClass, PlanetNumber: source.PlanetNumber, OrbitNumber: source.OrbitNumber, Component: source.Component, SystemBodyID: source.OrbitBodyID }, { Name: source.SystemName }) : '',
      assignedPopulationId: numberOrNull(source.AssignedPopulationID),
      x: numberOrNull(source.Xcor),
      y: numberOrNull(source.Ycor),
      classes: classesOf(source.Classes, numberOrNull(source.Ships)),
      ships: numberOrNull(source.Ships),
    }),
    fingerprint: NOTE_TARGETS.fleet.fingerprint,
  }),
  body: Object.freeze({
    label: 'Body',
    identity: 'created',
    created: NOTE_TARGETS.body.created,
    row: (source) => ({ ...NOTE_TARGETS.body.row(source), x: numberOrNull(source.Xcor), y: numberOrNull(source.Ycor) }),
    fingerprint: NOTE_TARGETS.body.fingerprint,
  }),
  // A waypoint's creation time is not its birth date: the game sets it again whenever a waypoint is asked for at a spot where one is (placing a waypoint, a point of interest refreshed), so it is not part of the fingerprint and a refresh never reads as another object. The save dates a waypoint nowhere else, so it is held by the player's confirmation, as a colony is: the system and number in the fingerprint, and in the confirmation the anchor the game gives the waypoint when it makes it (the body it is tied to, or for a point tied to none its fixed position). The game gives the ID and the number again after the highest waypoint is deleted and the save reloaded, so a replacement can share both and the name; its anchor tells it apart. A tied waypoint's coordinates follow its body and are no evidence, so a body that moves leaves the waypoint held.
  waypoint: Object.freeze({
    label: 'Waypoint',
    identity: 'unwitnessed',
    sql: WAYPOINT_SQL,
    row: (source) => ({
      type: 'waypoint',
      id: source.WaypointID,
      name: source.Name || `${WAYPOINT_NAMES[source.WaypointType] || 'Waypoint'} #${source.Number}`,
      systemId: numberOrNull(source.SystemID),
      systemName: present(source.SystemName),
      number: numberOrNull(source.Number),
      created: numberOrNull(source.CreationTime),
      orbitBodyId: numberOrNull(source.OrbitBodyID),
      x: numberOrNull(source.Xcor),
      y: numberOrNull(source.Ycor),
    }),
    fingerprint: (row) => ['waypoint', present(row.systemId), present(row.number)].join('|'),
  }),
  colony: Object.freeze({
    label: 'Colony',
    identity: 'unwitnessed',
    sql: NOTE_TARGETS.colony.sql,
    row: NOTE_TARGETS.colony.row,
    fingerprint: NOTE_TARGETS.colony.fingerprint,
  }),
})

const targetOf = (type) => (hasOwn(STATION_TARGETS, type) ? STATION_TARGETS[type] : null)

const READ_TYPES = Object.freeze(['fleet', 'waypoint', 'colony'])

// The objects of the race in the open save that a note can name, other than bodies: `{ objects: { [type]: Map(id -> row) }, systems: [{ id, name }], failed: { [type]: message }, GameID, RaceID }`. A kind that cannot be read is left out of `objects` and named in `failed`, and a link to it reads as not read, never as gone. The bodies are not in it (the save holds some thousands): `loadStationBodies` reads the ones a note names and the ones of the system the form picks from. Every read is a select.
export const loadStationObjects = async (database, { GameID, RaceID }) => {
  const objects = {}
  const failed = {}
  const replacements = { GameID, RaceID }
  let systems = []
  const attempt = async (key, work) => {
    try {
      await work()
    } catch (error) {
      failed[key] = messageOf(error)
    }
  }

  await Promise.all([
    ...READ_TYPES.map((type) => attempt(type, async () => {
      const [rows] = await database.query(STATION_TARGETS[type].sql, { replacements })

      objects[type] = new Map(rows.map((source) => STATION_TARGETS[type].row(source)).map((row) => [row.id, row]))
    })),
    attempt('system', async () => {
      const [rows] = await database.query(LINK_TYPES.system.sql, { replacements })

      systems = rows.map((source) => ({ id: source.SystemID, name: present(source.Name) })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    }),
  ])

  return { objects, systems, failed, GameID, RaceID }
}

// The bodies a note can name, as a Map of id to row: the ones `bodyIds` names (read BODIES_PER_READ at a time) and every body of the system `systemId` (the one the form picks from, null for none), of the systems the race knows. It throws when a read fails, so a body that was not read is never taken for one that is gone. Every read is a select.
export const loadStationBodies = async (database, { GameID, RaceID, bodyIds = [], systemId = null }) => {
  const bodies = new Map()
  const replacements = { GameID, RaceID }
  const keep = (rows) => rows.forEach((source) => {
    const row = STATION_TARGETS.body.row(source)

    bodies.set(row.id, row)
  })

  if (Number.isInteger(systemId)) {
    keep((await database.query(bodiesOfSystemSql, { replacements: { ...replacements, SystemID: systemId } }))[0])
  }

  for (const batch of batchesOf(bodyIds.filter((id) => Number.isInteger(id)), BODIES_PER_READ)) {
    keep((await database.query(bodiesByIdSql(batch), { replacements }))[0])
  }

  return bodies
}

// The move orders saved for each fleet of the race, as a Map of FleetID to the orders in the queue's order: `{ id, order, text, destinationType, destinationId, minDistance, arrived }`, a column the save leaves null being null. The orders are read, never given.
export const loadFleetOrders = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(ORDERS_SQL, { replacements: { GameID, RaceID } })
  const orders = new Map()

  rows.forEach((source) => {
    const list = orders.get(source.FleetID) || []

    list.push({ id: source.MoveOrderID, order: numberOrNull(source.MoveOrder), text: source.Description === null || source.Description === undefined ? null : String(source.Description), destinationType: numberOrNull(source.DestinationType), destinationId: numberOrNull(source.DestinationID), minDistance: numberOrNull(source.MinDistance), arrived: source.Arrived === null || source.Arrived === undefined ? null : Boolean(source.Arrived) })
    orders.set(source.FleetID, list)
  })

  return orders
}

// The ids of the bodies the notes name as a station, from entries read without the save's objects (`readStations` with no context), for the read of the bodies.
export const stationBodyIds = (entries) => [...new Set(entries.map((entry) => entry.intent.station).filter((view) => view && view.type === 'body').map((view) => view.id).filter((id) => Number.isInteger(id)))]

// The objects of one kind a note can name, as `{ id, name, text, row }` sorted by name: the bodies of `systemId` only (a body is offered inside a system).
export const stationChoices = (objects, type, { systemId = null } = {}) => noteChoices(objects, type, { systemId })

// ---- The record ------------------------------------------------------------------------------------------------------

const PAYLOAD_KEYS = ['fleet', 'station', 'base', 'note']

const anchorOk = (anchor) => isObject(anchor) && ((anchor.body !== undefined && Object.keys(anchor).length === 1 && Number.isInteger(anchor.body) && anchor.body > 0) || (Object.keys(anchor).length === 2 && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)))

const confirmedOk = (confirmed) => isObject(confirmed) && typeof confirmed.fingerprint === 'string' && typeof confirmed.name === 'string' && (confirmed.classes === null || (Array.isArray(confirmed.classes) && confirmed.classes.every(Number.isInteger))) && typeof confirmed.gameTime === 'number' && Number.isFinite(confirmed.gameTime) && (confirmed.anchor === undefined || confirmed.anchor === null || anchorOk(confirmed.anchor))

const refProblems = (role, ref) => {
  if (!(isObject(ref) && ROLE_TYPES[role].includes(ref.type) && idOk(ref.id) && typeof ref.name === 'string' && (ref.systemId === null || Number.isInteger(ref.systemId)) && typeof ref.systemName === 'string' && isObject(ref.origin) && isText(ref.origin.campaignId) && isText(ref.origin.branchId) && confirmedOk(ref.confirmed))) {
    return [`${role} is { type, id, name, systemId, systemName, origin, confirmed } of ${ROLE_TYPES[role].join(' or ')}, origin being the campaign and branch it was made on and confirmed the object as it was confirmed`]
  }

  return []
}

// What is wrong with a note to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the note is an object']
  }

  const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a note`)

  problems.push(...refProblems('fleet', payload.fleet))

  ;['station', 'base'].forEach((role) => {
    if (payload[role] !== null) {
      problems.push(...refProblems(role, payload[role]))
    }
  })

  if (typeof payload.note !== 'string' || payload.note.length > NOTE_LENGTH) {
    problems.push(`note is the player's words, up to ${NOTE_LENGTH} characters (empty for none)`)
  }

  return problems
}

// The links of a payload in the order the record keeps them: the fleet, then the station and the base it has.
const rolesOf = (payload) => ROLES.filter((role) => isObject(payload[role]))

// A link that is not read is told apart from one that is not there: the adapter answers with this for a kind of object the save could not give, and the repository takes the link as not known when asked its fingerprint.
const UNREAD = Object.freeze({ unread: true })

// The adapter of the scenario repository for the notes. A link is resolved against `context.objects`, the objects of the open save (`loadStationObjects` and the bodies): a link to a kind the save could not give is unknown, one whose object is not there is missing.
export const stationAdapter = Object.freeze({
  kind: STATION_KIND,
  schema: STATION_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    const definition = targetOf(type)

    if (!definition) {
      throw new Error(`${type} is not a kind of object a station note names`)
    }

    if (row === UNREAD) {
      throw new Error(`the ${type} objects of the save were not read`)
    }

    return definition.fingerprint(row)
  },
  resolve: (links, context) => links.map((link) => {
    const objects = context && context.objects ? context.objects[link.type] : null

    return objects instanceof Map ? objects.get(link.id) || null : UNREAD
  }),
})

const registered = new WeakSet()

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerFleetStations = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(stationAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

// ---- Whether an object is the one that was named --------------------------------------------------------------------

const overlaps = (kept, now) => Array.isArray(kept) && Array.isArray(now) && ((kept.length === 0 && now.length === 0) || kept.some((id) => now.includes(id)))

// What the save holds of a waypoint that the game does not change when the waypoint is only refreshed: the body it is tied to (the coordinates then follow the body, so they are no evidence), or, for a point tied to none, its fixed position. Null when the row does not say which of the two it is: a null tie, or a point without coordinates.
const waypointAnchorOf = (row) => {
  if (typeof row.orbitBodyId !== 'number' || !Number.isFinite(row.orbitBodyId)) {
    return null
  }

  if (row.orbitBodyId > 0) {
    return { body: row.orbitBodyId }
  }

  return finite(row.x, row.y) ? { x: row.x, y: row.y } : null
}

// Whether the waypoint now under the ID sits where the confirmed one did: the same body, or a fixed point within the game's one unit of the same spot (the distance under which the game takes a waypoint asked for as the one already there). Anything not known on either side is not shown to be the same.
const sameAnchor = (kept, now) => {
  if (!anchorOk(kept) || !anchorOk(now)) {
    return false
  }

  return kept.body !== undefined ? now.body === kept.body : now.body === undefined && Math.abs(now.x - kept.x) < WAYPOINT_SAME_SPOT && Math.abs(now.y - kept.y) < WAYPOINT_SAME_SPOT
}

// The object as it is described when the player confirms or picks it: what is checked against the object under the ID later.
const describeRow = (type, row, gameTime) => ({ fingerprint: STATION_TARGETS[type].fingerprint(row), name: row.name, classes: type === 'fleet' ? row.classes : null, ...(type === 'waypoint' ? { anchor: waypointAnchorOf(row) } : {}), gameTime })

// Whether the player's confirmation of an object can be relied on in the open save: it was made on the branch the save is open on, or on a branch that shared its history with this one up to a time after the confirmation. A confirmation made after the branches parted says nothing of the object this branch holds under the ID (the same ID, name and classes can be given again after a fork, even at the same tick), and one whose branch the registry does not tell is not known to share any history.
const confirmationShared = (ref, context) => {
  const shared = sharedHistory(context, ref.origin)

  return shared !== null && ref.confirmed.gameTime < shared
}

// Whether the object now under the ID is the very one the player confirmed: the same fingerprint and name and, for a fleet, ship classes that overlap those it had, for a waypoint the same anchor, and a confirmation that holds on the open branch.
const confirmedHolds = (ref, row, context) => {
  const confirmed = ref.confirmed

  return Boolean(confirmed) && confirmationShared(ref, context) && confirmed.fingerprint === STATION_TARGETS[ref.type].fingerprint(row) && confirmed.name === row.name && (ref.type !== 'fleet' || overlaps(confirmed.classes, row.classes)) && (ref.type !== 'waypoint' || sameAnchor(confirmed.anchor, waypointAnchorOf(row)))
}

const currentRowOf = (context, link) => {
  const objects = context && context.objects ? context.objects[link.type] : null

  return objects instanceof Map ? objects.get(link.id) || null : null
}

// What the player can check by eye when an object under the ID is not shown to be the one named: whether it has the name and, for a fleet, ship classes the confirmed one had (null where the classes of either are not known).
const resemblanceOf = (ref, row) => ({ sameName: row.name === ref.confirmed.name || row.name === ref.name, classesOverlap: ref.type === 'fleet' && Array.isArray(ref.confirmed.classes) && Array.isArray(row.classes) ? overlaps(ref.confirmed.classes, row.classes) : null })

// The verdict on one reference: `link` is the link as `resolveLink` gives it, `row` the object now under the ID (null when there is none). `held` is an object known to be the one named, by evidence the save holds (`evidence`) or by the player's confirmation of that very object (`confirmed`); `review` is an object under the ID that is not shown to be it (`reused`: its fingerprint differs, so another object made later holds the ID; `unwitnessed`: the save stores nothing that tells); `gone` is no object under the ID; `unread` is a link that could not be checked, which says nothing about the object.
export const verdictOf = (ref, link, row, context = null) => {
  if (!link || (link.status === 'unknown' && !link.unverified)) {
    return { state: VERDICTS.UNREAD, basis: null, reason: link && link.reason ? link.reason : 'The link could not be checked against the save.', resemblance: null }
  }

  if (link.status === 'missing') {
    return { state: VERDICTS.GONE, basis: null, reason: link.reason || 'The object is no longer in the save.', resemblance: null }
  }

  if (link.status === 'changed') {
    return { state: VERDICTS.REVIEW, basis: 'reused', reason: link.reason || 'Another object now holds the ID.', resemblance: row ? resemblanceOf(ref, row) : null }
  }

  if (link.status === 'linked') {
    return { state: VERDICTS.HELD, basis: 'evidence', reason: '', resemblance: null }
  }

  if (row && confirmedHolds(ref, row, context)) {
    return { state: VERDICTS.HELD, basis: 'confirmed', reason: '', resemblance: null }
  }

  return { state: VERDICTS.REVIEW, basis: 'unwitnessed', reason: link.reason || 'The save does not show that this is the object the note named.', resemblance: row ? resemblanceOf(ref, row) : null }
}

// ---- Where a fleet is against its station and its base --------------------------------------------------------------

const finite = (...values) => values.every((value) => typeof value === 'number' && Number.isFinite(value))

const kmBetween = (a, b) => (finite(a.x, a.y, b.x, b.y) ? Math.hypot(a.x - b.x, a.y - b.y) : null)

const stateResult = (state, present = [], missing = []) => (state === 'unknown' ? unavailable({ rule: 'fleetStation.onStation', missing, present }) : ofRule({ rule: 'fleetStation.onStation', value: state, inputs: { present, missing } }))

const distanceResult = (km) => (km === null ? null : ofRule({ rule: 'fleetStation.distance', value: km, inputs: { present: ['the fleet\'s position', 'the station\'s position'] } }))

const UNKNOWN = (role, reason, missing = []) => ({ role, state: 'unknown', basis: null, movement: null, where: null, distance: null, reason, result: stateResult('unknown', [], missing.length ? missing : [reason]) })

// The body whose orbit makes the fleet follow the station: the body itself, or the body a waypoint is tied to. Null for a waypoint tied to none.
const anchorOf = (station) => {
  const id = station.type === 'body' ? station.id : station.orbitBodyId

  return typeof id === 'number' && id > 0 ? id : null
}

// The fleet (a row of `loadStationObjects`) against the station (a row of a body or a waypoint), both known to be the objects the note named. `{ role: 'station', state: 'on' | 'off' | 'unknown', basis: 'orbit' | 'position' | null, movement, where, distance, reason, result }`: `movement` is what becomes of the fleet when the station moves, said only for a fleet on station: 'follows' (in the station's orbit), 'left-behind' (at the body by position alone, in no orbit of it), 'fixed' (the station is a point tied to no body) and 'unknown' where the fleet's orbit or the body a waypoint is tied to is not recorded, so neither the following nor the fixed point is known; `where` what the fleet is doing when it is off station, `distance` the result of the distance in km when both positions are known in one system.
export const compareStation = (fleet, station) => {
  const anchor = anchorOf(station)
  const anchorUnknown = station.type === 'waypoint' && station.orbitBodyId === null
  const sameSystem = finite(fleet.systemId, station.systemId) ? fleet.systemId === station.systemId : null
  const km = sameSystem ? kmBetween(fleet, station) : null
  const inputs = ['the fleet\'s orbit', 'the fleet\'s system', 'the station']

  if (anchor !== null && fleet.orbitBodyId === anchor) {
    return { role: 'station', state: 'on', basis: 'orbit', movement: 'follows', where: null, distance: distanceResult(km), reason: '', result: stateResult('on', inputs) }
  }

  if (km !== null && km < ON_STATION_KM) {
    const movement = anchorUnknown ? 'unknown' : anchor === null ? 'fixed' : fleet.orbitBodyId === null ? 'unknown' : 'left-behind'

    return { role: 'station', state: 'on', basis: 'position', movement, where: null, distance: distanceResult(km), reason: '', result: stateResult('on', [...inputs, 'the positions']) }
  }

  if (sameSystem === false) {
    return { role: 'station', state: 'off', basis: null, movement: null, where: 'other-system', distance: null, reason: '', result: stateResult('off', inputs) }
  }

  // Off station is said only when the evidence establishes it: the positions are both known and apart, and nothing unknown could still put the fleet in the station's orbit (the fleet's own orbit, or the body a waypoint is tied to).
  const orbitUnknown = fleet.orbitBodyId === null

  if (km === null) {
    return UNKNOWN('station', sameSystem === null ? 'The fleet\'s system or the station\'s is not known.' : 'The position of the fleet or of the station is not known, so the distance between them is not.', [sameSystem === null ? 'the fleet\'s system or the station\'s' : 'the fleet\'s position and the station\'s'])
  }

  if ((orbitUnknown && (anchor !== null || anchorUnknown)) || (anchorUnknown && fleet.orbitBodyId > 0)) {
    return UNKNOWN('station', anchorUnknown ? 'The body the station is tied to is not known, so the fleet\'s orbit cannot be compared with it.' : 'The fleet\'s orbit is not known, so it cannot be compared with the station\'s.', [anchorUnknown ? 'the body the station is tied to' : 'the fleet\'s orbit'])
  }

  const where = fleet.orbitBodyId !== null && fleet.orbitBodyId > 0 ? 'other-orbit' : 'open-space'

  return { role: 'station', state: 'off', basis: null, movement: null, where, distance: distanceResult(km), reason: '', result: stateResult('off', inputs) }
}

// The fleet against its base (a colony): at the base when it is in the orbit of the colony's body or assigned to the colony.
export const compareBase = (fleet, colony) => {
  const inputs = ['the fleet\'s orbit', 'the colony\'s body']
  const orbiting = typeof colony.bodyId === 'number' && colony.bodyId > 0 && fleet.orbitBodyId === colony.bodyId
  const assigned = fleet.assignedPopulationId !== null && fleet.assignedPopulationId > 0 && fleet.assignedPopulationId === colony.id

  if (orbiting || assigned) {
    return { role: 'base', state: 'on', basis: 'orbit', movement: null, where: null, distance: null, reason: '', result: stateResult('on', inputs) }
  }

  // A colony whose body is not known, or a fleet whose orbit or assignment is not, leaves the comparison open: only a known orbit, a known assignment and a known body of the colony make a fleet away from its base.
  if (fleet.orbitBodyId === null || fleet.assignedPopulationId === null || typeof colony.bodyId !== 'number') {
    return UNKNOWN('base', fleet.orbitBodyId === null || fleet.assignedPopulationId === null ? 'The fleet\'s orbit or its assigned colony is not known.' : 'The colony\'s body is not known.', [fleet.orbitBodyId === null || fleet.assignedPopulationId === null ? 'the fleet\'s orbit and assigned colony' : 'the colony\'s body'])
  }

  return { role: 'base', state: 'off', basis: null, movement: null, where: fleet.orbitBodyId > 0 ? 'other-orbit' : 'open-space', distance: null, reason: '', result: stateResult('off', inputs) }
}

// ---- Reading the notes -----------------------------------------------------------------------------------------------

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const noteOf = (item, reason) => ({ uuid: item.record.uuid, flags: item.flags, reason: reason || `A note written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })

const refusal = (error) => ({ code: error.code, message: error.message })

// One reference of a note as the list shows it: what the player kept, the link checked against the open save and the verdict on it, the object now under the ID apart from the note (`row`, null when there is none) and the name it has now when it is the one named and was renamed.
const viewOf = (role, item, context) => {
  const ref = item.payload[role]

  if (!isObject(ref)) {
    return null
  }

  const stored = item.links[rolesOf(item.payload).indexOf(role)]
  const link = resolveLink(stored, ref, context, STATION_TARGETS)
  const row = currentRowOf(context, stored)
  const verdict = verdictOf(ref, link, row, context)
  const nowNamed = verdict.state === VERDICTS.HELD && row && row.name !== ref.name ? row.name : null

  return { role, type: ref.type, label: targetOf(ref.type) ? targetOf(ref.type).label : ref.type, id: ref.id, name: ref.name, nowNamed, systemId: ref.systemId, systemName: ref.systemName, origin: { campaignId: ref.origin.campaignId, branchId: ref.origin.branchId }, confirmed: copyOf(ref.confirmed), link, verdict, row: verdict.state === VERDICTS.HELD || verdict.state === VERDICTS.REVIEW ? row : null }
}

const entryOf = (item, context) => {
  const roles = rolesOf(item.payload)

  if (item.links.length !== roles.length) {
    return null
  }

  const fleet = viewOf('fleet', item, context)
  const station = viewOf('station', item, context)
  const base = viewOf('base', item, context)
  const held = (view) => Boolean(view) && view.verdict.state === VERDICTS.HELD
  const fleetHeld = held(fleet)
  const ahead = item.status === 'ahead'
  const compare = (view, compareOf, role) => {
    if (!view) {
      return null
    }

    if (ahead) {
      return UNKNOWN(role, 'The note was made at a later game time than this save, so it is not applied to it.', ['a note made at or before this save\'s time'])
    }

    if (!fleetHeld) {
      return UNKNOWN(role, 'The fleet is not confirmed as the one the note was made for.', ['the fleet the note was made for'])
    }

    if (view.verdict.state === VERDICTS.GONE) {
      return UNKNOWN(role, `The ${view.label.toLowerCase()} is no longer in the save.`, [`the ${view.label.toLowerCase()} the note named`])
    }

    if (view.verdict.state === VERDICTS.REVIEW) {
      return UNKNOWN(role, `The ${view.label.toLowerCase()} is not confirmed as the one the note named.`, [`the ${view.label.toLowerCase()} the note named, confirmed`])
    }

    if (view.verdict.state === VERDICTS.UNREAD || !view.row) {
      return UNKNOWN(role, `The ${view.label.toLowerCase()} could not be checked against the save.`, [`the ${view.label.toLowerCase()} the note named`])
    }

    return compareOf(fleet.row, view.row)
  }

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    policy: item.record.association.policy,
    otherBranch: item.flags.includes('other-branch'),
    madeAt: item.record.base.gameTime,
    ahead,
    flags: [...item.flags],
    intent: { fleet, station, base, note: item.payload.note },
    fleetState: fleet.verdict.state,
    location: { station: compare(station, compareStation, 'station'), base: compare(base, compareBase, 'base') },
    stale: ahead ? [] : [station, base].filter((view) => view && view.verdict.state === VERDICTS.GONE).map((view) => view.role),
    review: ahead ? [] : [fleet, station, base].filter((view) => view && view.verdict.state === VERDICTS.REVIEW).map((view) => view.role),
    links: item.links,
  }
}

// The notes of the race in the campaign as the open branch reads them: `{ entries, notes, error }`. `context` is `{ objects, ... }` of the open save, or null while its objects are not read: the links are then not read, which is neither held nor gone. A record the adapter does not understand is a note of the list's own (`notes`). Nothing is written.
export const readStations = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: STATION_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))
  const entries = []
  const notes = listed.filter(unreadable).map((item) => noteOf(item))

  listed.filter((item) => !unreadable(item)).forEach((item) => {
    const entry = entryOf(item, context)

    if (entry) {
      entries.push(entry)
    } else {
      notes.push(noteOf(item, 'A note whose links do not match what it names is not listed.'))
    }
  })

  return { entries: entries.sort((a, b) => (a.intent.fleet.name.localeCompare(b.intent.fleet.name)) || (a.uuid < b.uuid ? -1 : 1)), notes, error: null }
}

// ---- The fleets with their notes --------------------------------------------------------------------------------------

// Whether the destination of an order is the station itself, by the kind and the ID of the destination alone: 'station' when both are known and are the station's, 'other' when either is known and is not, and 'unknown' when what the save gives (a kind or an ID left null) cannot show either.
const destinationOf = (last, station) => {
  const kind = last.destinationType === null ? null : station.type === 'body' ? BODY_DESTINATIONS.includes(last.destinationType) : last.destinationType === WAYPOINT_DESTINATION
  const same = last.destinationId === null ? null : last.destinationId === station.id

  return kind === false || same === false ? 'other' : kind === true && same === true ? 'station' : 'unknown'
}

// What is saved for a fleet, as saved. `destination` says whether the last saved order has the station itself as its destination ('station', 'other' or 'unknown' as above; null with no held station or no order); it says nothing of where the fleet stops, which a minimum distance moves: `standoff` is 'none' for a minimum distance of 0, 'set' for one above 0 (the fleet stops short of the destination) and 'unknown' for one the save does not give.
const ordersOf = (fleet, orders, entry) => {
  if (!(orders instanceof Map)) {
    return { read: false, list: [], destination: null, standoff: null }
  }

  const list = orders.get(fleet.id) || []
  const station = entry && entry.intent.station && entry.intent.station.verdict.state === VERDICTS.HELD ? entry.intent.station : null
  const last = list.length ? list[list.length - 1] : null
  const destination = station && last ? destinationOf(last, station) : null
  const standoff = destination === 'station' ? (last.minDistance === null ? 'unknown' : last.minDistance > 0 ? 'set' : 'none') : null

  return { read: true, list, destination, standoff }
}

// What a row says of the fleet itself, apart from any note: its system, the body it orbits and whether it is in orbit at all.
const placeOf = (fleet) => ({ systemId: fleet.systemId, systemName: fleet.systemName, orbitBodyId: fleet.orbitBodyId, orbitName: fleet.orbitName, inOrbit: fleet.orbitBodyId === null ? null : fleet.orbitBodyId > 0 })

// The fleets of the race as rows with their notes beside them, and the notes that belong to no fleet of the race as it stands: `{ rows, review, archived, unchecked, ahead, overlapping }`. A note is attached to a fleet's row only when the fleet is known to be the one the note was made for and nothing else competes for it. `review` holds the notes whose fleet ID is held by an object not shown to be that fleet (nothing of the note is compared with it), `archived` those whose fleet is no longer in the save, `unchecked` those whose fleet could not be checked, `ahead` those made at a later game time than the open save (kept and shown, never applied), and `overlapping` the notes of one fleet when it has more than one (every one of them is listed for the player to keep one or delete the others, and none is applied meanwhile). A row has `intent` (what the note keeps), `place` (where the fleet is now) and `location` (the note compared with where the fleet is) and `orders` (what is saved for the fleet): the four are never folded into one.
export const stationRows = ({ fleets, entries, orders = null }) => {
  const list = fleets instanceof Map ? [...fleets.values()] : Array.isArray(fleets) ? fleets : []
  const current = entries.filter((entry) => !entry.ahead)
  const holders = new Map()

  current.filter((entry) => entry.fleetState === VERDICTS.HELD).forEach((entry) => holders.set(entry.intent.fleet.id, [...(holders.get(entry.intent.fleet.id) || []), entry]))

  const overlapping = current.filter((entry) => entry.fleetState === VERDICTS.HELD && holders.get(entry.intent.fleet.id).length > 1)
  const rows = list.map((fleet) => {
    const same = holders.get(fleet.id) || []
    const entry = same.length === 1 ? same[0] : null
    const stale = entry ? entry.stale : []
    const review = entry ? entry.review : []
    const off = entry ? ['station', 'base'].filter((role) => entry.location[role] && entry.location[role].state === 'off') : []
    const overlap = same.length > 1 ? same.length : 0

    return { key: fleet.id, fleet, entry, intent: entry ? entry.intent : null, place: placeOf(fleet), location: entry ? entry.location : null, orders: ordersOf(fleet, orders, entry), flags: { off, stale, review, overlap, attention: off.length + stale.length + review.length + overlap > 0 } }
  })

  rows.sort((a, b) => Number(b.flags.attention) - Number(a.flags.attention) || Number(Boolean(b.entry)) - Number(Boolean(a.entry)) || a.fleet.name.localeCompare(b.fleet.name) || a.key - b.key)

  return {
    rows,
    review: current.filter((entry) => entry.fleetState === VERDICTS.REVIEW),
    archived: current.filter((entry) => entry.fleetState === VERDICTS.GONE),
    unchecked: current.filter((entry) => entry.fleetState === VERDICTS.UNREAD),
    ahead: entries.filter((entry) => entry.ahead),
    overlapping,
  }
}

// ---- The manual checklist --------------------------------------------------------------------------------------------

// What to set in the game for a fleet's note, as steps `{ key, ... }` with the object each is about; the wording is the panel's. The steps ask for orders the player gives in the game: this app gives none. A target that is not confirmed or is gone gets a step to pick it again, never an order to a stand-in.
export const checklistOf = (row) => {
  const entry = row.entry

  if (!entry) {
    return []
  }

  const steps = [{ key: 'open', fleet: entry.intent.fleet.nowNamed || entry.intent.fleet.name, systemName: row.place.systemName }]
  const station = entry.intent.station
  const base = entry.intent.base

  if (station) {
    const comparison = entry.location.station

    if (station.verdict.state !== VERDICTS.HELD) {
      steps.push({ key: 'repick', role: 'station', target: station.name, reason: station.verdict.state })
    } else if (comparison && comparison.state === 'on' && comparison.basis === 'position' && comparison.movement === 'left-behind') {
      steps.push({ key: 'orbit', role: 'station', target: station.row.name, type: station.type })
    } else if (comparison && comparison.state !== 'on') {
      steps.push({ key: 'move', role: 'station', target: station.row.name, type: station.type, tied: station.type === 'body' || anchorOf(station.row) !== null, systemName: station.row.systemName })
    }
  }

  if (base) {
    const comparison = entry.location.base

    if (base.verdict.state !== VERDICTS.HELD) {
      steps.push({ key: 'repick', role: 'base', target: base.name, reason: base.verdict.state })
    } else if (comparison && comparison.state !== 'on') {
      steps.push({ key: 'resupply', role: 'base', target: base.row.name, systemName: base.row.systemName })
    }
  }

  return steps
}

// ---- Keeping a note ---------------------------------------------------------------------------------------------------

const ASSUMPTIONS = Object.freeze(['The note is the player\'s own: it gives no order to the game and writes nothing to the save', 'The fleet it names stays the one the note was made for only while the save shows it, or the player confirmed that very object'])

const refOf = (type, row, scope, gameTime) => ({ type, id: row.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: scope.campaignId, branchId: scope.branchId }, confirmed: describeRow(type, row, gameTime) })

// The reference a note keeps for a role it is edited without a new pick: the one it has, with the name and the system of the object as the open save has them while the object is known to be the one named. Its confirmation is renewed only when the save's own evidence holds the object on the branch the note was made on; any other confirmation (the player's, or one made on another branch) stays as it was given, because renewing it would date it to a time and a branch it was never made at.
const keptRef = (ref, view, scope) => {
  const row = view && view.verdict.state === VERDICTS.HELD ? view.row : null

  if (!row) {
    return copyOf(ref)
  }

  const renewed = view.verdict.basis === 'evidence' && ref.origin.branchId === scope.branchId

  return { type: ref.type, id: ref.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: ref.origin.campaignId, branchId: ref.origin.branchId }, confirmed: renewed ? describeRow(ref.type, row, gameTimeOf(scope)) : copyOf(ref.confirmed) }
}

const gameTimeOf = (scope) => (Number.isFinite(scope.gameTime) ? scope.gameTime : 0)

const NO_EVIDENCE = 'The save dates this fleet nowhere and records no ship class for it, so nothing can show later that the fleet under this ID is the one the note was made for.'

const NO_ANCHOR = 'The save does not say whether this waypoint is tied to a body or where it sits, so nothing can show later that the waypoint under this ID is the one the note was made for.'

const noEvidenceOf = (type) => (type === 'waypoint' ? NO_ANCHOR : NO_EVIDENCE)

// A fleet the save does not date and gives no ship class for, or a waypoint that says neither the body it is tied to nor where it sits: no later read can show it is the same object, so a note about it would stay under review for good.
const unverifiable = (type, row) => (type === 'fleet' && (row.created === null || row.created === undefined) && row.classes === null) || (type === 'waypoint' && waypointAnchorOf(row) === null)

// The payload and the links of a note from what is kept (`base`: `{ payload, links }` of the record it edits, null for a new one) and the picks made: a role that is undefined is kept as it is, null is cleared and `{ type, row }` is picked.
const assemble = (base, picks, scope, views, note) => {
  const payload = { fleet: null, station: null, base: null, note }
  const links = []
  const stored = new Map()

  if (base) {
    rolesOf(base.payload).forEach((role, index) => stored.set(role, { ref: base.payload[role], link: base.links[index] }))
  }

  for (const role of ROLES) {
    const pick = picks[role]

    if (pick === undefined) {
      const kept = stored.get(role)

      if (kept) {
        payload[role] = keptRef(kept.ref, views ? views[role] : null, scope)
        links.push({ type: kept.link.type, id: kept.link.id, fingerprint: kept.link.fingerprint })
      }
    } else if (pick !== null) {
      payload[role] = refOf(pick.type, pick.row, scope, gameTimeOf(scope))
      links.push({ type: pick.type, id: pick.row.id, row: pick.row })
    }
  }

  return { payload, links }
}

// Keeps a note: a new record when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. `fleet` is `{ type: 'fleet', row }` for a new note (a note belongs to one fleet for good, so an edit takes none), `station` and `base` are undefined to keep what the note has, null to clear it and `{ type, row }` to pick, `row` being as `loadStationObjects` or `loadStationBodies` gave it. A pick is made only against `context`, the objects of the open save for this race, campaign and branch (with its `RaceID`, `campaignId` and `branchId`): an object that is not in it as picked, or that was picked for another race, campaign or branch, is refused. A fleet that has a note already is refused, so there is one note for each fleet in a branch. A stale revision is refused with the code 'revision-conflict' and the stored note, and nothing is written, unless `overwrite` says to write over what is stored (the roles not picked are then the stored ones). Returns `{ ok: true, record }` or `{ ok: false, code, message }`.
export const saveStation = async (repository, scope, { entry = null, fleet, station, base, note = '', context = null, policy, overwrite = false }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'station note')

    if (!allowed.ok) {
      return allowed
    }

    const picks = { fleet: entry ? undefined : fleet, station, base }
    const invalid = (message) => ({ ok: false, code: 'invalid-note', message })

    if (entry && fleet !== undefined) {
      return invalid('A note belongs to one fleet for good: delete it and make another for a different fleet.')
    }

    if (!entry && !(isObject(fleet) && fleet.type === 'fleet' && isObject(fleet.row))) {
      return invalid('A note is about one fleet: pick it.')
    }

    for (const role of ROLES) {
      const pick = picks[role]

      if (pick === undefined || pick === null) {
        continue
      }

      if (!(isObject(pick) && ROLE_TYPES[role].includes(pick.type) && isObject(pick.row))) {
        return invalid(`The ${role} is { type, row } of ${ROLE_TYPES[role].join(' or ')}.`)
      }
    }

    const checked = {}

    for (const role of ROLES) {
      const pick = picks[role]

      if (pick) {
        checked[role] = checkLink(context, scope, pick, STATION_TARGETS, 'station note')

        if (!checked[role].ok) {
          return checked[role]
        }
      }
    }

    if (!entry && unverifiable('fleet', checked.fleet.row)) {
      return { ok: false, code: 'unverifiable', message: NO_EVIDENCE }
    }

    if (checked.station && unverifiable(picks.station.type, checked.station.row)) {
      return { ok: false, code: 'unverifiable', message: noEvidenceOf(picks.station.type) }
    }

    const fleetId = entry ? entry.intent.fleet.id : fleet.row.id
    const listedAt = (branchId) => repository.list({ ...scope, branchId }, { kind: STATION_KIND }).filter((item) => item.payload && item.payload.fleet && item.payload.fleet.id === fleetId && !item.flags.some((flag) => NOT_SHOWN.includes(flag)) && !(entry && item.record.uuid === entry.uuid))

    if (!entry && listedAt(scope.branchId).length) {
      return { ok: false, code: 'exists', message: 'This fleet ID has a note already in this campaign and branch: edit it, or review it if the fleet is not the one it was made for.' }
    }

    // A note shared with the campaign shows on every branch, so it must not meet another note of the fleet on any of them.
    if (policy === 'campaign' && (!entry || entry.policy !== 'campaign')) {
      const branches = context && isObject(context.branches) ? Object.keys(context.branches) : []
      const met = [...new Set([scope.branchId, ...branches])].some((branchId) => listedAt(branchId).length > 0)

      if (met) {
        return { ok: false, code: 'exists', message: 'This fleet has another note on this or another branch of the campaign, so sharing this one would give the fleet two notes: delete or edit the other first.' }
      }
    }

    const rows = Object.fromEntries(Object.entries(picks).map(([role, pick]) => [role, pick ? { type: pick.type, row: checked[role].row } : pick]))
    const text = typeof note === 'string' ? note.trim() : note
    const views = entry ? entry.intent : null
    const made = assemble(entry ? { payload: entryPayload(entry), links: entry.links } : null, rows, scope, views, text)
    const problems = problemsOf(made.payload)

    if (problems.length) {
      return invalid(`The note is not valid: ${problems.join('; ')}`)
    }

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: STATION_KIND, policy: policy || 'branch', links: made.links, assumptions: [...ASSUMPTIONS], payload: made.payload }) }
    }

    const changed = ROLES.some((role) => picks[role] !== undefined)
    const patch = { payload: made.payload, assumptions: [...ASSUMPTIONS], ...(changed ? { links: made.links } : {}), ...(policy && policy !== entry.policy ? { policy } : {}) }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patch) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      const again = assemble({ payload: error.stored.payload, links: error.stored.links }, rows, scope, null, text)

      return { ok: true, record: repository.reconcile(scope, error, { ...patch, payload: again.payload, links: again.links }) }
    }
  } catch (error) {
    return failure(error)
  }
}

// The payload of an entry as it is stored: the references the entry shows, without what it worked out.
const entryPayload = (entry) => ({ fleet: refOfView(entry.intent.fleet), station: refOfView(entry.intent.station), base: refOfView(entry.intent.base), note: entry.intent.note })

const refOfView = (view) => (view ? { type: view.type, id: view.id, name: view.name, systemId: view.systemId, systemName: view.systemName, origin: { campaignId: view.origin.campaignId, branchId: view.origin.branchId }, confirmed: copyOf(view.confirmed) } : null)

// Confirms the object that now holds the ID of one reference of a note (`role`), when the save does not show it is the one the note named (the verdict is `review`): the reference is made again from that object as the open save has it, the link with it, and the confirmation is the player's, on this branch. It does not touch the other references, and it is refused for a reference that is held, gone or not read. A stale revision is refused with the code 'revision-conflict'.
export const confirmTarget = async (repository, scope, { entry, role, context = null }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'station note')

    if (!allowed.ok) {
      return allowed
    }

    const view = entry && ROLES.includes(role) ? entry.intent[role] : null

    if (!view) {
      return { ok: false, code: 'invalid-note', message: `The note has no ${role} to confirm.` }
    }

    if (view.verdict.state !== VERDICTS.REVIEW || !view.row) {
      return { ok: false, code: 'not-in-review', message: `The ${view.label.toLowerCase()} is not waiting for review, so there is nothing to confirm.` }
    }

    const checked = checkLink(context, scope, { type: view.type, row: view.row }, STATION_TARGETS, 'station note')

    if (!checked.ok) {
      return checked
    }

    if (unverifiable(view.type, checked.row)) {
      return { ok: false, code: 'unverifiable', message: noEvidenceOf(view.type) }
    }

    const picks = { fleet: undefined, station: undefined, base: undefined, [role]: { type: view.type, row: checked.row } }
    const made = assemble({ payload: entryPayload(entry), links: entry.links }, picks, scope, entry.intent, entry.intent.note)
    const problems = problemsOf(made.payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-note', message: `The note is not valid: ${problems.join('; ')}` }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { payload: made.payload, links: made.links, assumptions: [...ASSUMPTIONS] }) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
    }
  } catch (error) {
    return failure(error)
  }
}

// Deletes a note over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteStation = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'station note')

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// Moves a note made at a later game time than the open save (an `ahead` note) to the open save, on the open branch: the explicit step that makes it current. It is refused for a note that is not ahead, and for a fleet that has another note in the open branch already; a stale revision is refused with the code 'revision-conflict'. What the note names is checked as for any note once it is current.
export const rebaseStation = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'station note')

    if (!allowed.ok) {
      return allowed
    }

    if (!entry || !entry.ahead) {
      return { ok: false, code: 'not-ahead', message: 'The note was not made after this save, so there is nothing to move.' }
    }

    const other = repository.list(scope, { kind: STATION_KIND }).some((item) => item.record.uuid !== entry.uuid && item.payload && item.payload.fleet && item.payload.fleet.id === entry.intent.fleet.id && item.status !== 'ahead' && !item.flags.some((flag) => NOT_SHOWN.includes(flag)))

    if (other) {
      return { ok: false, code: 'exists', message: 'This fleet has another note on this branch already: delete or edit that one first.' }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { rebase: true }) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
    }
  } catch (error) {
    return failure(error)
  }
}
