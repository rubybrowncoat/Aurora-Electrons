// Milestones of the history page: a note the player pins to an exact game time (a battle, a colonisation, a discovery) and, if wanted, to one object of the save it is about.
//
// A milestone is a typed record of the scenario repository (utilities/scenario-records.js) of kind `history.milestone`: `{ t, type, text, link }`, `t` being the exact game time in seconds, the same unit as a snapshot's `t`. The chart draws the marker at that time and at no other: a marker never moves to a sample, a sample that is thinned away never moves it, and the zoom, the span and the axis only choose which part of the time line is on show. The sample nearest to a milestone is shown beside it (`nearestSample`) and is never stored.
//
// The link is the record's own link (`{ type, id, fingerprint }`), made to a colony, a system, a fleet, a ship or an event of the log, with the object's name kept in the payload as the player saw it, for display only. Whether the link still holds is worked out on every read against the objects of the open save, never stored (`linked`, `missing`, `changed`, `unknown`, and `ambiguous` for a log event the log holds more than once): an object that is gone leaves the milestone with an unresolved link, and the link is never rebound to another object that has the same name. A name is not part of what an object is: the fingerprint of a colony, a system, a fleet or a ship is built from fields the game never changes when the player renames it, so a renamed object stays linked and shows its new name beside the one kept. A log event has no durable ID of its own, and the row ID SQLite gives it (the rowid) changes from one save to the next, so an event is named by its IncrementID and a digest of what the row says (time, type, text and the place it names), and its fingerprint holds the same and how many rows of the increment say the very same.
//
// Branches. A milestone is kept for the whole campaign (`campaign`, the default) or for one branch (`branch`). A rewound save is a branch of the campaign, and nothing is moved or rebound by it: a milestone made at a later game time than the open save is listed as ahead, is not drawn, and is moved to the open save only when the player says so (`moveMilestone`).
//
// The same object after an ID is given again. A save continues the IDs it hands out from the highest ID it holds, so an ID can come back for another object: after a rewind (another branch gives it to another object) and without one (the highest ID of a ship, a fleet or a colony is destroyed, the game is saved and opened again, and the next one made takes it). An ID and a fingerprint that matches are therefore not enough to say it is the same object, on any branch. A link keeps the campaign and branch it was made on (`origin`) and is `linked` only when the object shows that it was there before: a ship by its construction time, a fleet by the time its history says it was created, a system by its discovery time, with the same ID and strictly before the time the branches parted when the link was made on another branch (`sharedHistory`, from the registry's fork times: an object made at the very time of the parting may belong to either side). A colony has no stored date and several colonies can share a body, so nothing in a save shows that the colony with an ID is the one that was linked: a colony link is never `linked`, and reads `changed` only where its system, body or species differ. An object that does not give the time (a fleet with no creation entry in its history, a ship with no construction time) is never `linked` from its ID alone. A link read so says why, is `unknown`, and is not counted as unresolved.
//
// Storage and the rules of a stale edit are the repository's. This module takes the repository as an argument and imports no package, so a check runs it on in-memory stores.

export const MILESTONE_KIND = 'history.milestone'
export const MILESTONE_SCHEMA = 1
export const TEXT_LENGTH = 200
export const RECENT_INCREMENTS = 60
export const INCREMENTS_PER_READ = 400

export const MILESTONE_TYPES = Object.freeze([
  Object.freeze({ value: 'battle', text: 'Battle' }),
  Object.freeze({ value: 'colonisation', text: 'Colonisation' }),
  Object.freeze({ value: 'discovery', text: 'Discovery' }),
  Object.freeze({ value: 'research', text: 'Research' }),
  Object.freeze({ value: 'loss', text: 'Loss' }),
  Object.freeze({ value: 'other', text: 'Other' }),
])

export const typeText = (type) => {
  const found = MILESTONE_TYPES.find((entry) => entry.value === type)

  return found ? found.text : String(type)
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const copyOf = (value) => JSON.parse(JSON.stringify(value))

// ---- Exact game time -----------------------------------------------------------------------------------------------

const yearStart = (year) => {
  const date = new Date(0)

  date.setUTCFullYear(year, 0, 1)
  date.setUTCHours(0, 0, 0, 0)

  return date.getTime()
}

const pad = (number, width = 2) => String(number).padStart(width, '0')

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/

// A game time in seconds as a date and time, `YYYY-MM-DD HH:mm:ss`, on the calendar of the game that starts on the 1st of January of `startYear` (the calendar the page's dates use).
export const gameDateText = (startYear, seconds) => {
  const date = new Date(yearStart(Number(startYear)) + seconds * 1000)

  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

// The game time in seconds of a typed date (`YYYY-MM-DD`, with `HH:mm` or `HH:mm:ss` after it if wanted): `{ ok: true, seconds }`, or `{ ok: false, error }` for text that is no date of the calendar or lies before the game's start.
export const gameSecondsOf = (startYear, text) => {
  const match = DATE_TEXT.exec(String(text === null || text === undefined ? '' : text).trim())

  if (!match || !Number.isFinite(Number(startYear))) {
    return { ok: false, error: 'Type the date as YYYY-MM-DD, with HH:mm or HH:mm:ss after it if the hour matters.' }
  }

  const [year, month, day, hours = 0, minutes = 0, seconds = 0] = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)))
  const date = new Date(0)

  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hours, minutes, seconds, 0)

  const typed = `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`

  if (gameDateText(year, (date.getTime() - yearStart(year)) / 1000) !== typed) {
    return { ok: false, error: 'That is not a date of the calendar.' }
  }

  const elapsed = (date.getTime() - yearStart(Number(startYear))) / 1000

  return elapsed < 0 ? { ok: false, error: 'That date is before the game started.' } : { ok: true, seconds: elapsed }
}

// ---- The objects a milestone links to ------------------------------------------------------------------------------

const hashText = (text, seed = 0x811c9dc5) => {
  let hash = seed

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

const present = (value) => (value === null || value === undefined ? '' : String(value))

// What a row of the game log says and where: the fields the log holds for an event. A row is the same event in another save when all of them are the same, and not when only the words are.
const eventContent = (row) => [row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType].map(present).join('|')

// The durable key of a row of the game log: its IncrementID and a 64-bit digest of what the row says (time, event type and text) and the place it names (system, colony, coordinates and the kind of its ID). The rowid is not a key: SQLite renumbers it from one save to the next.
export const eventKey = (row) => `${row.IncrementID}:${hashText(eventContent(row))}${hashText(eventContent(row), 0x9e3779b1)}`

const plainRow = (type, id, name) => ({ type, id, name: present(name) })

// The kinds of object a milestone links to. `sql` reads the race's objects of the save; `fingerprint` is the text that names what a row is, so an ID that a save gives again to another object tells. It holds only what the game does not change when the player renames the object. `identity` says what makes an object the same one when its ID may have been given again: 'unwitnessed' is an object the save stores nothing about that tells it from another that was given the ID (a colony: no date is stored for it, and one body holds several colonies, one per species), so it is never certified and the fingerprint only shows when it is another one, 'created' is a time the object was made or found (a ship's construction time, a fleet's creation entry, a system's discovery time), which proves it when it is stored, and, on another branch of the campaign, only when it lies strictly before the branches parted, and 'content' is the row itself (a log event, keyed by its increment and what it says). `created` is the index of the fingerprint part that holds the time.
export const LINK_TYPES = Object.freeze({
  colony: Object.freeze({
    label: 'Colony',
    identity: 'unwitnessed',
    sql: 'select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SpeciesID, FCT_Population.SystemID, FCT_Population.SystemBodyID from FCT_Population where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID order by FCT_Population.PopulationID',
    row: (source) => ({ ...plainRow('colony', source.PopulationID, source.PopName), speciesId: source.SpeciesID, systemId: source.SystemID, bodyId: source.SystemBodyID }),
    fingerprint: (row) => ['colony', present(row.systemId), present(row.bodyId), present(row.speciesId)].join('|'),
  }),
  system: Object.freeze({
    label: 'System',
    identity: 'created',
    created: 2,
    sql: 'select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.DiscoveredTime, FCT_System.SystemNumber, FCT_System.Stars from FCT_RaceSysSurvey left join FCT_System on FCT_System.GameID = FCT_RaceSysSurvey.GameID and FCT_System.SystemID = FCT_RaceSysSurvey.SystemID where FCT_RaceSysSurvey.GameID = :GameID and FCT_RaceSysSurvey.RaceID = :RaceID order by FCT_RaceSysSurvey.SystemID',
    row: (source) => ({ ...plainRow('system', source.SystemID, source.Name), number: source.SystemNumber, stars: source.Stars, discovered: source.DiscoveredTime }),
    fingerprint: (row) => ['system', present(row.number), present(row.stars), present(row.discovered)].join('|'),
  }),
  fleet: Object.freeze({
    label: 'Fleet',
    identity: 'created',
    created: 0,
    sql: "select FCT_Fleet.FleetID, FCT_Fleet.FleetName, Founded.CreatedTime from FCT_Fleet left join (select FCT_FleetHistory.FleetID, min(FCT_FleetHistory.GameTime) as CreatedTime from FCT_FleetHistory where FCT_FleetHistory.GameID = :GameID and FCT_FleetHistory.Description like 'Created on%' group by FCT_FleetHistory.FleetID) Founded on Founded.FleetID = FCT_Fleet.FleetID where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID order by FCT_Fleet.FleetID",
    row: (source) => ({ ...plainRow('fleet', source.FleetID, source.FleetName), created: source.CreatedTime }),
    fingerprint: (row) => ['fleet', present(row.created)].join('|'),
  }),
  ship: Object.freeze({
    label: 'Ship',
    identity: 'created',
    created: 0,
    sql: 'select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.Constructed from FCT_Ship where FCT_Ship.GameID = :GameID and FCT_Ship.RaceID = :RaceID order by FCT_Ship.ShipID',
    row: (source) => ({ ...plainRow('ship', source.ShipID, source.ShipName), constructed: source.Constructed }),
    fingerprint: (row) => ['ship', present(row.constructed)].join('|'),
  }),
  event: Object.freeze({
    label: 'Log event',
    identity: 'content',
    fingerprint: (row) => ['event', row.time, row.eventType, row.copies, present(row.systemId), present(row.populationId), present(row.xcor), present(row.ycor), present(row.idType), row.name].join('|'),
  }),
})

export const LINK_TYPE_KEYS = Object.freeze(Object.keys(LINK_TYPES))

const linkTypeOf = (type, types = LINK_TYPES) => (Object.prototype.hasOwnProperty.call(types, type) ? types[type] : null)

const EVENT_COLUMNS = 'FCT_GameLog.IncrementID, FCT_GameLog.Time, FCT_GameLog.EventType, FCT_GameLog.MessageText, FCT_GameLog.SystemID, FCT_GameLog.PopulationID, FCT_GameLog.Xcor, FCT_GameLog.Ycor, FCT_GameLog.IDType'
const EVENT_SCOPE = 'FCT_GameLog.GameID = :GameID and FCT_GameLog.RaceID = :RaceID'

const recentEventsSql = `select ${EVENT_COLUMNS} from FCT_GameLog where ${EVENT_SCOPE} and FCT_GameLog.IncrementID in (select distinct FCT_GameLog.IncrementID from FCT_GameLog where ${EVENT_SCOPE} order by FCT_GameLog.IncrementID desc limit ${RECENT_INCREMENTS})`

const linkedEventsSql = (increments) => `select ${EVENT_COLUMNS} from FCT_GameLog where ${EVENT_SCOPE} and FCT_GameLog.IncrementID in (${increments.join(', ')})`

// The events of rows of the log as objects keyed by their durable key. A row the log holds more than once (the same increment saying the very same, in the same place) is one object that counts its copies: nothing tells the copies apart, so the picker and the link say so (`ambiguous`), and the link changes when the count does.
const eventsOf = (rows, into = new Map()) => {
  const found = new Map()

  rows.forEach((row) => {
    const key = eventKey(row)

    if (found.has(key)) {
      found.get(key).copies += 1
    } else {
      found.set(key, { type: 'event', id: key, name: present(row.MessageText), time: Number(row.Time), eventType: Number(row.EventType), incrementId: Number(row.IncrementID), systemId: row.SystemID, populationId: row.PopulationID, xcor: row.Xcor, ycor: row.Ycor, idType: row.IDType, copies: 1 })
    }
  })

  found.forEach((event, key) => into.set(key, event))

  return into
}

// The increments an object link names, for the read of the log rows a milestone's links need. Every one is kept: `loadObjects` reads them in batches.
export const incrementsOf = (entries) => {
  const wanted = new Set()

  entries.forEach((entry) => entry.links.filter((link) => link.type === 'event').forEach((link) => {
    const increment = Number(String(link.id).split(':')[0])

    if (Number.isInteger(increment)) {
      wanted.add(increment)
    }
  }))

  return [...wanted].sort((a, b) => a - b)
}

const batchesOf = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size))

// The objects of the race in the open save that a milestone can link to, and the ones its links name: `{ objects: { [type]: Map(id -> row) }, failed: { [type]: message }, GameID, RaceID }`, the game and race they were read for. A kind of object the save cannot give is left out of `objects` and named in `failed`, and the links to it read as unknown, never as missing; so is the log when any batch of the linked increments (`increments`, from `incrementsOf`, all of them, INCREMENTS_PER_READ at a time) cannot be read, so an increment that was not read never makes an event read as gone.
export const loadObjects = async (database, { GameID, RaceID, increments = [] }) => {
  const objects = {}
  const failed = {}
  const replacements = { GameID, RaceID }
  const safe = increments.filter((increment) => Number.isInteger(increment))

  await Promise.all([
    ...Object.entries(LINK_TYPES).filter(([, definition]) => definition.sql).map(async ([type, definition]) => {
      try {
        const [rows] = await database.query(definition.sql, { replacements })

        objects[type] = new Map(rows.map((source) => definition.row(source)).map((row) => [row.id, row]))
      } catch (error) {
        failed[type] = error && error.message ? error.message : String(error)
      }
    }),
    (async () => {
      try {
        const [recent] = await database.query(recentEventsSql, { replacements })
        const events = eventsOf(recent)

        for (const batch of batchesOf(safe, INCREMENTS_PER_READ)) {
          const [linked] = await database.query(linkedEventsSql(batch), { replacements })

          eventsOf(linked, events)
        }

        objects.event = events
      } catch (error) {
        failed.event = error && error.message ? error.message : String(error)
      }
    })(),
  ])

  return { objects, failed, GameID, RaceID }
}

// The objects of one kind a link can be made to, as `{ id, name, row, ambiguous }`: events newest first, the rest by name. A log event the log holds more than once (`copies`) is ambiguous: nothing tells its copies apart.
export const linkChoices = (objects, type) => {
  const found = objects && objects[type] ? [...objects[type].values()] : []
  const sorted = type === 'event' ? found.sort((a, b) => b.time - a.time || a.incrementId - b.incrementId || (a.id < b.id ? -1 : 1)) : found.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))

  return sorted.map((row) => ({ id: row.id, name: row.name, row, ambiguous: type === 'event' && row.copies > 1 }))
}

export const LINK_STATUS_TEXT = Object.freeze({
  linked: 'Linked: the object is in this save as it was when linked',
  missing: 'Unresolved: no object with this ID is in this save, and none is picked by name instead',
  changed: 'Unresolved: an object with this ID is in this save but it no longer matches what was linked',
  unknown: 'Not checked: this save\'s objects were not read for this branch',
  ambiguous: 'Ambiguous: the log holds this event more than once, and nothing tells the copies apart',
})

// ---- The same object on another branch -----------------------------------------------------------------------------

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// The branches of a campaign as the registry holds them (`campaign` is its entry), `{ [branchId]: { parent, t } }`: the branch each one left (null for the first) and the game time it left it at, up to which the two hold one history (null when the registry did not record it).
export const branchLineage = (campaign) => {
  const branches = campaign && isObject(campaign.branches) ? campaign.branches : {}

  return Object.fromEntries(Object.entries(branches).filter(([, branch]) => isObject(branch)).map(([id, branch]) => [id, { parent: typeof branch.parent === 'string' ? branch.parent : null, t: isObject(branch.fork) && typeof branch.fork.t === 'number' && Number.isFinite(branch.fork.t) ? branch.fork.t : null }]))
}

// The branch and the branches it descends from, each with the game time up to which it shares its history with the branch the walk began at: Infinity for that one, then the least of the times the branches along the way left theirs at, null from the first of them that did not record one. A branch the registry does not hold ends the walk.
const limitsOf = (branches, from) => {
  const limits = new Map()
  let id = from
  let limit = Infinity

  while (typeof id === 'string' && hasOwn(branches, id) && !limits.has(id)) {
    limits.set(id, limit)

    const { parent, t } = branches[id]

    limit = limit === null || t === null ? null : Math.min(limit, t)
    id = parent
  }

  return limits
}

// The game time up to which the branch a link was made on (`origin`, `{ campaignId, branchId }`) and the open save's branch (`context.branchId`) hold the same history: Infinity when it is one branch, the time the two parted at when the registry says so, and null when nothing says (another campaign, a branch the registry does not hold, a time not recorded).
export const sharedHistory = (context, origin) => {
  if (!context || !isObject(origin) || origin.campaignId !== context.campaignId) {
    return null
  }

  if (origin.branchId === context.branchId) {
    return Infinity
  }

  if (!isObject(context.branches)) {
    return null
  }

  const here = limitsOf(context.branches, context.branchId)
  const there = limitsOf(context.branches, origin.branchId)

  for (const [id, limit] of here) {
    if (there.has(id)) {
      const other = there.get(id)

      return limit === null || other === null ? null : Math.min(limit, other)
    }
  }

  return null
}

const UNVERIFIED_TEXT = Object.freeze({
  unwitnessed: 'Not checked: the save stores no date for a colony, one body can hold several, and the ID of a removed colony can be given again to a new one, so nothing shows this is the colony that was linked',
  untimed: 'Not checked: the save does not give the time this object was made, and an ID can be given again to another object, so nothing shows this is the one that was linked',
  parted: 'Not checked: the object is not shown to have been made before the link\'s branch and this one parted, and an ID can be given again to another object, so this is not known to be the one that was linked',
})

// Why a link whose object is in the open save, with the fingerprint it was linked with, is still not known to be that object: null when it is known, else the reason. An ID can be given again, so a colony, which the save stores no date for, is never known, and a ship, a fleet or a system is known by a time it was made or found, which must also lie strictly before the two branches parted when the link was made on another branch. `types` is the table of kinds the link is one of (the milestones' own by default); a kind of identity 'static' is a row of the game's own catalogue, which every save of every campaign holds as one and the same, so it is known on any branch.
const unverifiedOf = (type, fingerprint, context, origin, types = LINK_TYPES) => {
  const definition = linkTypeOf(type, types)

  if (!definition || definition.identity === 'content' || definition.identity === 'static') {
    return null
  }

  if (definition.identity === 'unwitnessed') {
    return definition.unwitnessedNote || UNVERIFIED_TEXT.unwitnessed
  }

  const parts = String(fingerprint).split('|').slice(1)
  const created = parts[definition.created] === undefined || parts[definition.created] === '' ? NaN : Number(parts[definition.created])

  if (!Number.isFinite(created)) {
    return UNVERIFIED_TEXT.untimed
  }

  const shared = sharedHistory(context, origin)

  return shared !== null && created < shared ? null : UNVERIFIED_TEXT.parted
}

// Whether a link reads as changed only because the save no longer gives the time the object was made (a fleet's creation entry is pruned from its history after a while): nothing else it was linked with differs, so it is not known to be another object.
const timeLost = (stored, row, types = LINK_TYPES) => {
  const definition = linkTypeOf(stored.type, types)

  if (!row || !definition || definition.identity !== 'created') {
    return false
  }

  const was = String(stored.fingerprint).split('|')
  const now = definition.fingerprint(row).split('|')
  const at = definition.created + 1

  return was.length === now.length && was[at] !== '' && now[at] === '' && was.every((part, index) => index === at || part === now[index])
}

// ---- The record ----------------------------------------------------------------------------------------------------

const PAYLOAD_KEYS = ['t', 'type', 'text', 'link']

// What is wrong with a milestone to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the milestone is an object']
  }

  const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a milestone`)

  if (typeof payload.t !== 'number' || !Number.isFinite(payload.t) || payload.t < 0) {
    problems.push('t is the exact game time in seconds, a number from 0')
  }

  if (!MILESTONE_TYPES.some((entry) => entry.value === payload.type)) {
    problems.push(`type is one of ${MILESTONE_TYPES.map((entry) => entry.value).join(', ')}`)
  }

  if (!isText(payload.text) || payload.text.length > TEXT_LENGTH) {
    problems.push(`text is 1 to ${TEXT_LENGTH} characters`)
  }

  const link = payload.link

  if (link !== null && link !== undefined && !(isObject(link) && linkTypeOf(link.type) && (isText(link.id) || (typeof link.id === 'number' && Number.isFinite(link.id))) && typeof link.name === 'string' && isObject(link.origin) && isText(link.origin.campaignId) && isText(link.origin.branchId))) {
    problems.push('link is null or { type, id, name, origin } of a kind of object a milestone links to, origin being the campaign and branch it was made on')
  }

  return problems
}

// The adapter of the scenario repository for the milestones. A link is resolved against `context.objects`, the objects of the open save (`loadObjects`): a link to a kind the save could not give is unknown, one whose object is not there is missing.
export const milestoneAdapter = Object.freeze({
  kind: MILESTONE_KIND,
  schema: MILESTONE_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    const definition = linkTypeOf(type)

    if (!definition) {
      throw new Error(`${type} is not a kind of object a milestone links to`)
    }

    return definition.fingerprint(row)
  },
  resolve: (links, context) => links.map((link) => {
    const objects = context && context.objects ? context.objects[link.type] : null

    if (!(objects instanceof Map)) {
      throw new TypeError(`the ${link.type} objects of the save were not read`)
    }

    return objects.get(link.id) || null
  }),
})

const registered = new WeakSet()

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerMilestones = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(milestoneAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

// The scope of the repository for a save, or null while it is not known: `campaign` is the store's settled campaign ({ campaignId, branchId }), `gameTime` the game clock of the branch shown.
export const scopeOf = ({ campaign, RaceID, branchId = campaign ? campaign.branchId : null, gameTime }) => (campaign && campaign.campaignId && branchId && Number.isInteger(RaceID) && Number.isFinite(gameTime) ? { campaignId: campaign.campaignId, RaceID, branchId, gameTime } : null)

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const noteOf = (item) => ({ uuid: item.record.uuid, flags: item.flags, reason: `A milestone written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })

// The object a link names in the objects of the open save, or null when they were not read or it is not there.
const currentRowOf = (context, link) => {
  const objects = context && context.objects ? context.objects[link.type] : null

  return objects instanceof Map ? objects.get(link.id) || null : null
}

// A link as the list shows it: the repository's status, with `ambiguous` for a log event that is linked but that the log holds more than once, `unknown` for one that is linked by its fingerprint but not known to be the same object (`unverifiedOf`, `unverified` is its reason, and so is one whose time was pruned from the save, `timeLost`), and the name the object has in the open save when it is not the one kept (a renamed object stays linked).
const linkOf = (stored, named, context, types = LINK_TYPES) => {
  const lost = stored.status === 'changed' && timeLost(stored, currentRowOf(context, stored), types)
  const row = stored.status === 'linked' || lost ? currentRowOf(context, stored) : null
  const ambiguous = Boolean(row) && stored.type === 'event' && row.copies > 1
  const unverified = lost ? UNVERIFIED_TEXT.untimed : row && !ambiguous ? unverifiedOf(stored.type, stored.fingerprint, context, named ? named.origin : null, types) : null
  const known = Boolean(row) && !ambiguous && !unverified
  const name = named ? named.name : ''
  const status = ambiguous ? 'ambiguous' : unverified ? 'unknown' : stored.status

  return { type: stored.type, label: linkTypeOf(stored.type, types) ? linkTypeOf(stored.type, types).label : stored.type, id: stored.id, name, origin: named && named.origin ? { campaignId: named.origin.campaignId, branchId: named.origin.branchId } : null, status, reason: ambiguous ? LINK_STATUS_TEXT.ambiguous : unverified || stored.reason || LINK_STATUS_TEXT[stored.status] || '', unverified: Boolean(unverified), current: stored.current === undefined ? null : stored.current, nowNamed: known && stored.type !== 'event' && row.name !== name ? row.name : null, copies: row && stored.type === 'event' ? row.copies : null }
}

// The link check the other records of the scenario repository share (utilities/economy-notes.js): a stored link (`{ type, id, fingerprint, status, ... }` as the repository lists it), the link as the payload names it, the context and the table of kinds it is one of.
export const resolveLink = linkOf

const entryOf = (item, context) => {
  const stored = item.links.length ? item.links[0] : null
  const link = stored ? linkOf(stored, item.payload.link, context) : null
  const provenance = item.record.provenance

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    t: item.payload.t,
    type: item.payload.type,
    text: item.payload.text,
    link,
    unresolved: item.unresolved > 0 && !(link && link.unverified),
    policy: item.record.association.policy,
    status: item.status,
    ahead: item.status === 'ahead',
    otherBranch: item.flags.includes('other-branch'),
    madeAt: item.record.base.gameTime,
    adoptedFrom: provenance && provenance.via === 'adopt' && provenance.from ? { campaignId: provenance.from.campaignId, uuid: provenance.from.uuid } : null,
    flags: [...item.flags.filter((flag) => !(flag === 'changed-link' && link && link.unverified)), ...(link && link.status === 'ambiguous' ? ['ambiguous-link'] : []), ...(link && link.unverified ? ['unverified-link'] : [])],
    links: item.links,
  }
}

const refusal = (error) => ({ code: error.code, message: error.message })

// The milestones of the race in the campaign as the shown branch reads them: `{ entries, notes, error }`, by exact time (the order they were made in for the same time). `context` is `{ objects }` of the open save, or null when the shown branch is not the open save's: its links are then unknown. A record the adapter does not understand is a note. Nothing is written.
export const readMilestones = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: MILESTONE_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))

  return {
    entries: listed.filter((item) => !unreadable(item)).map((item) => entryOf(item, context)).sort((a, b) => a.t - b.t),
    notes: listed.filter(unreadable).map(noteOf),
    error: null,
  }
}

// The copies of attached campaigns' milestones that the campaign holds, on the shown branch and on every other one it has (`branchIds`): a map from the source (campaign and uuid) to `{ uuid, branchId, policy }` of the copy, `branchId` being the branch it was adopted onto, the only one that shows it when it is kept for a branch. The repository refuses a second copy of one source milestone wherever the first is kept, so what the shown branch lists is not enough to tell what is adopted.
const copiesOf = (repository, scope, branchIds) => {
  const copies = new Map()

  for (const branchId of new Set([scope.branchId, ...branchIds])) {
    repository.list({ ...scope, branchId }, { kind: MILESTONE_KIND }).forEach((item) => {
      const provenance = item.record.provenance

      if (provenance && provenance.via === 'adopt' && isObject(provenance.from)) {
        const key = `${provenance.from.campaignId}\u0000${provenance.from.uuid}`

        if (!copies.has(key)) {
          copies.set(key, { uuid: item.record.uuid, branchId: item.record.association.branchId, policy: item.record.association.policy })
        }
      }
    })
  }

  return copies
}

// The milestones of the race in the campaigns attached to the open one (`attach` in utilities/campaign-attach.js, merged into the same branch or as a branch of its own), apart from the campaign's own and never drawn as markers: `{ entries, notes, refused, error }`. An entry is as in `readMilestones` with `attachedFrom`, the source campaign's id, `adopted`, whether the campaign already holds a copy of it on any branch (`branchIds` are its branches), and `adoptedOn`, that copy's `{ uuid, branchId, policy }` or null. Their links are resolved against `context` like the others. A source file that cannot be read is in `refused`, never skipped. Nothing is written: a milestone becomes the campaign's only by `adoptMilestone`.
export const readAttachedMilestones = (repository, scope, context = null, branchIds = []) => {
  const empty = { entries: [], notes: [], refused: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed
  let copies

  try {
    listed = repository.listAttached(scope, { kind: MILESTONE_KIND, context: context || undefined })
    copies = copiesOf(repository, scope, branchIds)
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))
  const copyOfItem = (item) => copies.get(`${item.attachedFrom}\u0000${item.record.uuid}`) || null

  return {
    entries: listed.entries.filter((item) => !unreadable(item)).map((item) => ({ ...entryOf(item, context), attachedFrom: item.attachedFrom, adopted: copyOfItem(item) !== null, adoptedOn: copyOfItem(item) })).sort((a, b) => a.t - b.t),
    notes: listed.entries.filter(unreadable).map(noteOf),
    refused: listed.refused,
    error: null,
  }
}

export const failure = (error) => ({ ok: false, code: (error && error.code) || 'failed', message: error && error.message ? error.message : String(error) })

// Whether the scenario records can be written for `scope` from this window, `what` being the record the refusal names ('milestone' by default): `{ ok: true }` or `{ ok: false, code, message }`. The other records of the repository (utilities/economy-notes.js) are guarded the same way.
export const mayWrite = async (repository, scope, what = 'milestone') => {
  if (!repository) {
    return { ok: false, code: 'no-repository', message: `The scenario records are not available in this window, so the ${what} is not kept.` }
  }

  if (!scope) {
    return { ok: false, code: 'no-scope', message: `The campaign of this save is not settled yet, so the ${what} is not kept.` }
  }

  if (!(await repository.writable(scope.campaignId))) {
    return { ok: false, code: 'not-owner', message: `Another tab holds the scenario file, so the ${what} is not kept.` }
  }

  return { ok: true }
}

const ASSUMPTIONS = Object.freeze(['The time is the exact game time the player gave: it is not the time of a sample, and no sample moves it'])

// Whether a link the player picked may be made in `scope`: the objects it was picked from (`context`, as `loadObjects` gave them, with the campaign and branch of the open save) must be those of the race, campaign and branch the milestone is kept for, hold the object, and hold it as it was picked. Returns `{ ok: true, row }` with the row the open save has now (a renamed object has its new name), or `{ ok: false, code, message }`. `types` is the table of kinds the link is one of and `what` the record it is made for, as for `resolveLink` and `mayWrite`.
export const checkLink = (context, scope, link, types = LINK_TYPES, what = 'milestone') => {
  if (!context || !isObject(context.objects) || context.RaceID !== scope.RaceID || context.campaignId !== scope.campaignId || context.branchId !== scope.branchId) {
    return { ok: false, code: 'link-out-of-scope', message: `The object was picked from another race, campaign, branch or save than the one this ${what} is kept for, so the link is not made. Pick it again.` }
  }

  const objects = context.objects[link.type]

  if (!(objects instanceof Map)) {
    return { ok: false, code: 'link-not-read', message: `The ${link.type} objects of the save were not read, so the link is not made.` }
  }

  const current = objects.get(link.row.id)

  if (!current || linkTypeOf(link.type, types).fingerprint(current) !== linkTypeOf(link.type, types).fingerprint(link.row)) {
    return { ok: false, code: 'link-stale', message: 'The object picked is not in the save as it was picked, so the link is not made. Pick it again.' }
  }

  return { ok: true, row: current }
}

// Keeps a milestone: a new record when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. `link` is `{ type, row }` with the row of an object as `loadObjects` gave it, `null` for no link, and undefined to keep the link the record has; a link given replaces it, only because the player gave it, and is made only against `context`, the objects of the open save for this race, campaign and branch (`loadObjects`, with its GameID and RaceID, and the `campaignId` and `branchId` of the save): an object that is not in it as picked, or that was picked for another race, campaign or branch, is refused. The link keeps the campaign and branch it was made on (`origin`), which is what says on which branches the object's ID can be trusted. `policy` is 'campaign' or 'branch' (a new record is 'campaign' unless told). A stale revision is refused with the code 'revision-conflict' and the stored milestone, and nothing is written, unless `overwrite` says to write over what is stored. Returns `{ ok: true, record }` or `{ ok: false, code, message }`.
export const saveMilestone = async (repository, scope, { entry = null, t, type, text, link, context = null, policy, overwrite = false }) => {
  try {
    const allowed = await mayWrite(repository, scope)

    if (!allowed.ok) {
      return allowed
    }

    if (link && !(isObject(link) && linkTypeOf(link.type) && isObject(link.row))) {
      return { ok: false, code: 'invalid-milestone', message: 'The link is { type, row } of a kind of object a milestone links to' }
    }

    const checked = link ? checkLink(context, scope, link) : null

    if (checked && !checked.ok) {
      return checked
    }

    const row = checked ? checked.row : null
    const named = link === undefined ? (entry && entry.link ? { type: entry.link.type, id: entry.link.id, name: entry.link.name, origin: entry.link.origin } : null) : link ? { type: link.type, id: row.id, name: row.name, origin: { campaignId: scope.campaignId, branchId: scope.branchId } } : null
    const payload = { t: typeof t === 'string' && t.trim() !== '' ? Number(t) : t, type, text: typeof text === 'string' ? text.trim() : text, link: named }
    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-milestone', message: `The milestone is not valid: ${problems.join('; ')}` }
    }

    const links = link ? [{ type: link.type, id: row.id, row }] : []

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: MILESTONE_KIND, policy: policy || 'campaign', links, assumptions: [...ASSUMPTIONS], payload }) }
    }

    const patch = { payload, assumptions: [...ASSUMPTIONS], ...(link === undefined ? {} : { links }), ...(policy && policy !== entry.policy ? { policy } : {}) }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patch) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      return { ok: true, record: repository.reconcile(scope, error, patch) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Copies a milestone of an attached campaign into the open one (`repository.adopt`): a new record of this race on the shown branch with a new uuid, the source left as it is. It is the player's explicit act and the only way an attached milestone becomes the campaign's; one that was adopted already is refused with the code 'collision'.
export const adoptMilestone = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    if (!allowed.ok) {
      return allowed
    }

    if (!entry || !entry.attachedFrom || !entry.uuid) {
      return { ok: false, code: 'invalid-milestone', message: 'The milestone to adopt is one of an attached campaign.' }
    }

    return { ok: true, record: repository.adopt(scope, entry.attachedFrom, entry.uuid) }
  } catch (error) {
    return failure(error)
  }
}

// Moves a milestone made at a later game time to the open save (its payload and its time are not changed), so that it is drawn here.
export const moveMilestone = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    return allowed.ok ? { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { rebase: true }) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// Deletes a milestone over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteMilestone = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// ---- On the chart --------------------------------------------------------------------------------------------------

// The sample nearest to a game time, `{ sampleT, offset }` with `offset` the exact time less the sample's (negative before it), or null when there are no samples. The earlier one wins a tie. Shown beside a milestone; it never changes the milestone's time.
export const nearestSample = (snapshots, t) => {
  let best = null

  snapshots.forEach((snapshot) => {
    if (best === null || Math.abs(t - snapshot.t) < Math.abs(t - best.t)) {
      best = snapshot
    }
  })

  return best === null ? null : { sampleT: best.t, offset: t - best.t }
}

// Whether a game time lies within the span of the samples shown, the only part of the time line a chart draws.
export const withinSamples = (snapshots, t) => snapshots.length > 0 && t >= snapshots[0].t && t <= snapshots[snapshots.length - 1].t

// The markers a chart draws, `{ x, label, uuid }` for the milestones that are not ahead of the save and lie within the samples shown. `x` is `position(t)`, the chart's x of the exact time: nothing about the samples enters it.
export const markersOf = (entries, snapshots, position) => entries.filter((entry) => !entry.ahead && withinSamples(snapshots, entry.t)).map((entry) => ({ x: position(entry.t), label: typeText(entry.type), uuid: entry.uuid }))
