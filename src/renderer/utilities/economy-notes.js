// The project notebook of the economy: a note on one body, colony, fleet, known tech or designed tech of the race, with a status and the next action.
//
// A note is a typed record of the scenario repository (utilities/scenario-records.js) of kind `economy.note`: `{ title, status, next, target }`, `target` being `{ type, id, name, systemId, systemName, origin }`: what the note is about as the player saw it when the note was last kept (the name and the system, for display only) and the campaign and branch the link was made on (`origin`). The record's own link is the object (`{ type, id, fingerprint }`), made by the same rules as the links of the history page's milestones: this module imports the link check from utilities/history-milestones.js and adds no rule of its own to it, only the kinds of object a note is about (`NOTE_TARGETS`).
//
// Whether the link still holds is worked out on every read against the objects of the open save and is never stored: `linked`, `missing`, `changed`, and `unknown` (shown as not checked) for an object that is there but is not known to be the one that was linked. A note whose link is `missing` or `changed` is stale: it stays readable, with the name and the system the object had when the note was last kept, and the link is never moved to another object that has the same name or the same place. A rename keeps the link (the fingerprints hold only what the game never changes when the player renames an object) and the note shows the new name beside the one kept; the name kept is written again only when the note is edited while the link holds.
//
// What makes the object the same one when an ID may have been given again (the rules of the milestones, one kind each):
// - a body is known by the time its system was discovered by the race (a body of a system generated after a rewind can take the ID of another body), which must lie strictly before the time the branches parted when the note was made on another branch;
// - a fleet is known by the time its history says it was created, as for a milestone;
// - a colony is never known: the save stores no date for it, and the ID of a removed colony can be given again. Its link reads not checked, and the note shows the name the colony with that ID, at the same body and species, has now, apart from the link;
// - a tech of the game's catalogue is known on every branch and every campaign: the catalogue is the same in every save;
// - a tech the race designed is never known, as a colony is not: a designed tech has no stored date, and the IDs of the designed techs of a rewound save are given again.
//
// The notes are kept for the branch (the default: a branch of the campaign has its own notes, as a race does) or for the whole campaign. They are the repository's: a stale edit is refused, a note is kept in the race's own record, and nothing is written to the save or to any order of the game: every read this module sends is a select.
//
// Storage and the rules of a stale edit are the repository's. This module takes the repository and the database as arguments, so a check runs it on in-memory stores.

import { systemBodyName } from './aurora'
import { LINK_TYPES, checkLink, failure, mayWrite, resolveLink } from './history-milestones'

export { scopeOf } from './history-milestones'

export const NOTE_KIND = 'economy.note'
export const NOTE_SCHEMA = 1
export const TITLE_LENGTH = 120
export const NEXT_LENGTH = 200
export const BODIES_PER_READ = 400

export const NOTE_STATUSES = Object.freeze([
  Object.freeze({ value: 'idea', text: 'Idea' }),
  Object.freeze({ value: 'planned', text: 'Planned' }),
  Object.freeze({ value: 'in-progress', text: 'In progress' }),
  Object.freeze({ value: 'blocked', text: 'Blocked' }),
  Object.freeze({ value: 'done', text: 'Done' }),
  Object.freeze({ value: 'dropped', text: 'Dropped' }),
])

const STATUS_ORDER = Object.freeze(['in-progress', 'blocked', 'planned', 'idea', 'done', 'dropped'])

export const statusText = (status) => {
  const found = NOTE_STATUSES.find((entry) => entry.value === status)

  return found ? found.text : String(status)
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const copyOf = (value) => JSON.parse(JSON.stringify(value))

const present = (value) => (value === null || value === undefined ? '' : String(value))

const messageOf = (error) => (error && error.message ? error.message : String(error))

const BODY_CLASSES = '1, 2, 3, 5'

const bodySql = (filter) => `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSysSurvey.DiscoveredTime from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = :RaceID and FCT_RaceSysSurvey.GameID = :GameID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = :RaceID and FCT_SystemBodyName.GameID = :GameID where FCT_SystemBody.GameID = :GameID and FCT_SystemBody.BodyClass in (${BODY_CLASSES}) and ${filter} order by FCT_SystemBody.SystemBodyID`

const bodiesOfSystemSql = bodySql('FCT_SystemBody.SystemID = :SystemID')

const bodiesByIdSql = (ids) => bodySql(`FCT_SystemBody.SystemBodyID in (${ids.join(', ')})`)

const techSql = 'select FCT_TechSystem.TechSystemID, FCT_TechSystem.Name, FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.RaceID, DIM_TechType.Description as TechTypeName, FCT_RaceTech.TechID as Researched from FCT_TechSystem left join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID left join FCT_RaceTech on FCT_RaceTech.TechID = FCT_TechSystem.TechSystemID and FCT_RaceTech.RaceID = :RaceID and FCT_RaceTech.GameID = :GameID where FCT_TechSystem.GameID = 0 order by FCT_TechSystem.TechSystemID'

const designSql = 'select FCT_TechSystem.TechSystemID, FCT_TechSystem.Name, FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.RaceID, DIM_TechType.Description as TechTypeName from FCT_TechSystem left join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_TechSystem.GameID = :GameID and FCT_TechSystem.RaceID = :RaceID order by FCT_TechSystem.TechSystemID'

const techRow = (type, source) => ({ type, id: source.TechSystemID, name: present(source.Name), group: present(source.TechTypeName), typeId: source.TechTypeID, info: source.AdditionalInfo, info2: source.AdditionalInfo2, cost: source.DevelopCost, raceId: source.RaceID, researched: source.Researched !== undefined && source.Researched !== null, systemId: null, systemName: '' })

// The kinds of object a note is about, in the shape of the milestones' `LINK_TYPES` (utilities/history-milestones.js), which the link check reads. `sql` reads the race's objects of the save (a body has none: the save holds some thousands, so `loadBodies` reads them by ID and by system); `fingerprint` holds only what the game does not change when the player renames the object; `identity` says what makes the object the same one when its ID may have been given again ('created' with the index of the fingerprint part that holds the time, 'unwitnessed' with the note shown beside the link, 'static'). `systemId` and `systemName` are where the object is now, null and empty for a tech.
export const NOTE_TARGETS = Object.freeze({
  body: Object.freeze({
    label: 'Body',
    identity: 'created',
    created: 5,
    placed: true,
    row: (source) => ({ type: 'body', id: source.SystemBodyID, name: systemBodyName({ SystemBodyName: source.SystemBodyName, BodyClass: source.BodyClass, PlanetNumber: source.PlanetNumber, OrbitNumber: source.OrbitNumber, Component: source.Component, SystemBodyID: source.SystemBodyID }, { Name: source.SystemName }), systemId: source.SystemID, systemName: present(source.SystemName), planetNumber: source.PlanetNumber, orbitNumber: source.OrbitNumber, bodyClass: source.BodyClass, bodyTypeId: source.BodyTypeID, discovered: source.DiscoveredTime }),
    fingerprint: (row) => ['body', present(row.systemId), present(row.planetNumber), present(row.orbitNumber), present(row.bodyClass), present(row.bodyTypeId), present(row.discovered)].join('|'),
  }),
  colony: Object.freeze({
    label: 'Colony',
    identity: 'unwitnessed',
    placed: true,
    sql: 'select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SpeciesID, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_RaceSysSurvey.Name as SystemName from FCT_Population left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID order by FCT_Population.PopulationID',
    row: (source) => ({ ...LINK_TYPES.colony.row(source), systemName: present(source.SystemName) }),
    fingerprint: LINK_TYPES.colony.fingerprint,
  }),
  fleet: Object.freeze({
    label: 'Fleet',
    identity: 'created',
    created: LINK_TYPES.fleet.created,
    sql: "select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, Founded.CreatedTime from FCT_Fleet left join (select FCT_FleetHistory.FleetID, min(FCT_FleetHistory.GameTime) as CreatedTime from FCT_FleetHistory where FCT_FleetHistory.GameID = :GameID and FCT_FleetHistory.Description like 'Created on%' group by FCT_FleetHistory.FleetID) Founded on Founded.FleetID = FCT_Fleet.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = :GameID and FCT_Fleet.RaceID = :RaceID order by FCT_Fleet.FleetID",
    row: (source) => ({ ...LINK_TYPES.fleet.row(source), systemId: source.SystemID || null, systemName: present(source.SystemName) }),
    fingerprint: LINK_TYPES.fleet.fingerprint,
  }),
  tech: Object.freeze({
    label: 'Tech',
    identity: 'static',
    sql: techSql,
    row: (source) => techRow('tech', source),
    fingerprint: (row) => ['tech', present(row.typeId), present(row.info), present(row.info2), present(row.cost)].join('|'),
  }),
  design: Object.freeze({
    label: 'Designed tech',
    identity: 'unwitnessed',
    unwitnessedNote: 'Not checked: the save stores no date for a tech the race designed, and the IDs of the designed techs of a rewound save are given again to other designs, so nothing shows this is the one that was linked',
    sql: designSql,
    row: (source) => techRow('design', source),
    fingerprint: (row) => ['design', present(row.typeId), present(row.info), present(row.info2), present(row.cost), present(row.raceId)].join('|'),
  }),
})

export const NOTE_TARGET_KEYS = Object.freeze(Object.keys(NOTE_TARGETS))

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const targetOf = (type) => (hasOwn(NOTE_TARGETS, type) ? NOTE_TARGETS[type] : null)

// ---- The objects a note is about -------------------------------------------------------------------------------------

const batchesOf = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size))

// The IDs of the bodies the notes link to, from entries read without the save's objects (`readNotes` with no context), for the read of the bodies the links name.
export const bodyIdsOf = (entries) => [...new Set(entries.filter((entry) => entry.target && entry.target.type === 'body').map((entry) => entry.target.id).filter((id) => Number.isInteger(id)))]

// The objects of the race in the open save that a note can be about, other than bodies: `{ objects: { [type]: Map(id -> row) }, systems: [{ id, name }], failed: { [type]: message }, GameID, RaceID }`. A kind that cannot be read is left out of `objects` and named in `failed`, and the links to it read as unknown, never as missing. The bodies are not in it (the save holds some thousands): `loadBodies` reads the ones a note links to and the ones of the system the form picks from, and `withBodies` adds them. Every read is a select.
export const loadNoteObjects = async (database, { GameID, RaceID }) => {
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
    ...Object.entries(NOTE_TARGETS).filter(([, definition]) => definition.sql).map(([type, definition]) => attempt(type, async () => {
      const [rows] = await database.query(definition.sql, { replacements })

      objects[type] = new Map(rows.map((source) => definition.row(source)).map((row) => [row.id, row]))
    })),
    attempt('system', async () => {
      const [rows] = await database.query(LINK_TYPES.system.sql, { replacements })

      systems = rows.map((source) => ({ id: source.SystemID, name: present(source.Name) })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    }),
  ])

  return { objects, systems, failed, GameID, RaceID }
}

// The bodies a note can be about, as a Map of id to row: the ones `bodyIds` names (the bodies the notes link to, read BODIES_PER_READ at a time) and all of the bodies of the system `systemId` (the one the form picks from, null for none), of the systems the race knows. It throws when a read fails, so a body that was not read is never taken for one that is gone. Every read is a select.
export const loadBodies = async (database, { GameID, RaceID, bodyIds = [], systemId = null }) => {
  const bodies = new Map()
  const replacements = { GameID, RaceID }
  const keep = (rows) => rows.forEach((source) => {
    const row = NOTE_TARGETS.body.row(source)

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

// The objects of `loaded` (`loadNoteObjects`) with the bodies `loadBodies` gave. Without them (still being read, or the read failed) the objects have no bodies at all, so a link to a body reads as not checked and never as gone.
export const withBodies = (loaded, bodies) => (loaded && bodies instanceof Map ? { ...loaded, objects: { ...loaded.objects, body: bodies } } : loaded)

// The objects of one kind a note can be about, as `{ id, name, text, row }` sorted by name. `systemId` limits the bodies to one system (a body is only offered inside a system); `researched` limits the catalogue techs to the ones the race has researched.
export const noteChoices = (objects, type, { systemId = null, researched = true } = {}) => {
  const found = objects && objects[type] instanceof Map ? [...objects[type].values()] : []
  const shown = found.filter((row) => (type !== 'body' || row.systemId === systemId) && (type !== 'tech' || !researched || row.researched))

  return shown.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)).map((row) => ({ id: row.id, name: row.name, row, text: row.group ? `${row.name} · ${row.group}` : row.systemName && type !== 'body' ? `${row.name} · ${row.systemName}` : row.name }))
}

// ---- The record ------------------------------------------------------------------------------------------------------

const PAYLOAD_KEYS = ['title', 'status', 'next', 'target']

const idOk = (id) => isText(id) || (typeof id === 'number' && Number.isFinite(id))

// What is wrong with a note to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the note is an object']
  }

  const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a note`)

  if (!isText(payload.title) || payload.title.length > TITLE_LENGTH) {
    problems.push(`title is 1 to ${TITLE_LENGTH} characters`)
  }

  if (!NOTE_STATUSES.some((entry) => entry.value === payload.status)) {
    problems.push(`status is one of ${NOTE_STATUSES.map((entry) => entry.value).join(', ')}`)
  }

  if (typeof payload.next !== 'string' || payload.next.length > NEXT_LENGTH) {
    problems.push(`next is the next action, up to ${NEXT_LENGTH} characters (empty for none)`)
  }

  const target = payload.target

  if (!(isObject(target) && targetOf(target.type) && idOk(target.id) && typeof target.name === 'string' && (target.systemId === null || Number.isInteger(target.systemId)) && typeof target.systemName === 'string' && isObject(target.origin) && isText(target.origin.campaignId) && isText(target.origin.branchId))) {
    problems.push('target is { type, id, name, systemId, systemName, origin } of a kind of object a note is about, origin being the campaign and branch it was made on')
  }

  return problems
}

// The adapter of the scenario repository for the notes. A link is resolved against `context.objects`, the objects of the open save (`loadNoteObjects`): a link to a kind the save could not give is unknown, one whose object is not there is missing.
export const noteAdapter = Object.freeze({
  kind: NOTE_KIND,
  schema: NOTE_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    const definition = targetOf(type)

    if (!definition) {
      throw new Error(`${type} is not a kind of object a note is about`)
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
export const registerEconomyNotes = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(noteAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const noteOf = (item) => ({ uuid: item.record.uuid, flags: item.flags, reason: `A note written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })

const currentRowOf = (context, link) => {
  const objects = context && context.objects ? context.objects[link.type] : null

  return objects instanceof Map ? objects.get(link.id) || null : null
}

const rankOf = (status) => {
  const rank = STATUS_ORDER.indexOf(status)

  return rank === -1 ? STATUS_ORDER.length : rank
}

// Where a note is for the system filter: the system the object is in now when the link holds, or when it is a place the object's fingerprint holds and the object with the ID matches it (a body's system, a colony's); the system the object had when the note was last kept, marked `lastKnown`, otherwise (a stale link, a fleet that is not known to be the one that was linked). A tech has no system.
const placeOf = (stored, link, row, target) => {
  const holds = Boolean(row) && stored && stored.status === 'linked' && (link.status === 'linked' || Boolean(targetOf(target.type) && targetOf(target.type).placed))

  if (holds) {
    return { systemId: row.systemId || null, systemName: row.systemName || '', lastKnown: false }
  }

  return { systemId: target.systemId, systemName: target.systemName, lastKnown: true }
}

const entryOf = (item, context) => {
  const stored = item.links.length ? item.links[0] : null
  const target = item.payload.target
  const link = stored ? resolveLink(stored, target, context, NOTE_TARGETS) : null
  const row = stored ? currentRowOf(context, stored) : null
  const stale = Boolean(link) && (link.status === 'missing' || link.status === 'changed')

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    title: item.payload.title,
    status: item.payload.status,
    statusText: statusText(item.payload.status),
    next: item.payload.next,
    target: { type: target.type, label: targetOf(target.type) ? targetOf(target.type).label : target.type, id: target.id, name: target.name, systemId: target.systemId, systemName: target.systemName, origin: { campaignId: target.origin.campaignId, branchId: target.origin.branchId } },
    link,
    stale,
    holderName: link && link.status === 'unknown' && row ? row.name : null,
    place: placeOf(stored, link || { status: 'unknown' }, row, target),
    policy: item.record.association.policy,
    otherBranch: item.flags.includes('other-branch'),
    madeAt: item.record.base.gameTime,
    flags: [...item.flags.filter((flag) => !(flag === 'changed-link' && link && link.unverified)), ...(link && link.unverified ? ['unverified-link'] : [])],
    links: item.links,
  }
}

const refusal = (error) => ({ code: error.code, message: error.message })

// The notes of the race in the campaign as the open branch reads them: `{ entries, notes, error }`, in the order of their status (what is under way first) and then by title. `context` is `{ objects, ... }` of the open save, or null while its objects are not read: the links are then unknown, and the system is the one kept. A record the adapter does not understand is a note of the list's own (`notes`). Nothing is written.
export const readNotes = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: NOTE_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))

  return {
    entries: listed.filter((item) => !unreadable(item)).map((item) => entryOf(item, context)).sort((a, b) => rankOf(a.status) - rankOf(b.status) || a.title.localeCompare(b.title) || (a.uuid < b.uuid ? -1 : 1)),
    notes: listed.filter(unreadable).map(noteOf),
    error: null,
  }
}

// ---- The system filter -----------------------------------------------------------------------------------------------

export const ALL_SYSTEMS = 'all'
export const NO_SYSTEM = 'none'

// The choices of the system filter: all the notes, the notes about an object with no system (a tech), and each system that holds a note, with the number of notes in it.
export const systemOptions = (entries) => {
  const counts = new Map()

  entries.forEach((entry) => {
    const id = entry.place.systemId

    if (id !== null && id !== undefined) {
      counts.set(id, { id, name: entry.place.systemName || `System ${id}`, count: (counts.has(id) ? counts.get(id).count : 0) + 1 })
    }
  })

  const none = entries.filter((entry) => entry.place.systemId === null || entry.place.systemId === undefined).length

  return [
    { value: ALL_SYSTEMS, text: 'All systems', count: entries.length },
    ...(none ? [{ value: NO_SYSTEM, text: 'No system', count: none }] : []),
    ...[...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id).map((entry) => ({ value: entry.id, text: entry.name, count: entry.count })),
  ]
}

// The notes of one system (`systemId`), of no system (NO_SYSTEM) or all of them (ALL_SYSTEMS): the note of a body, a colony or a fleet is in the system its object is in.
export const filterBySystem = (entries, systemId) => {
  if (systemId === ALL_SYSTEMS || systemId === undefined || systemId === null) {
    return entries
  }

  if (systemId === NO_SYSTEM) {
    return entries.filter((entry) => entry.place.systemId === null || entry.place.systemId === undefined)
  }

  return entries.filter((entry) => entry.place.systemId === systemId)
}

// ---- Keeping a note --------------------------------------------------------------------------------------------------

const ASSUMPTIONS = Object.freeze(['The note is the player\'s own: it gives no order to the game and writes nothing to the save'])

// The target a note keeps when it is edited without a new link: the one it has, with the name and the system of the object as the open save has them while the link holds.
const keptTarget = (entry, context) => {
  const kept = entry.target
  const row = entry.link && entry.link.status === 'linked' ? currentRowOf(context, kept) : null

  return {
    type: kept.type,
    id: kept.id,
    name: row ? row.name : kept.name,
    systemId: row ? row.systemId || null : kept.systemId,
    systemName: row ? row.systemName || '' : kept.systemName,
    origin: { campaignId: kept.origin.campaignId, branchId: kept.origin.branchId },
  }
}

// Keeps a note: a new record when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. `target` is `{ type, row }` with the row of an object as `loadNoteObjects` gave it, and undefined to keep the link the note has (a note always has one); a target given replaces it, only because the player gave it, and is made only against `context`, the objects of the open save for this race, campaign and branch (`loadNoteObjects`, with its GameID and RaceID, and the `campaignId` and `branchId` of the save): an object that is not in it as picked, or that was picked for another race, campaign or branch, is refused. The link keeps the campaign and branch it was made on (`origin`). `policy` is 'branch' (the default for a new note) or 'campaign'. A stale revision is refused with the code 'revision-conflict' and the stored note, and nothing is written, unless `overwrite` says to write over what is stored. Returns `{ ok: true, record }` or `{ ok: false, code, message }`.
export const saveNote = async (repository, scope, { entry = null, title, status, next = '', target, context = null, policy, overwrite = false }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'note')

    if (!allowed.ok) {
      return allowed
    }

    if (target && !(isObject(target) && targetOf(target.type) && isObject(target.row))) {
      return { ok: false, code: 'invalid-note', message: 'The target is { type, row } of a kind of object a note is about' }
    }

    if (!target && !entry) {
      return { ok: false, code: 'invalid-note', message: 'A note is about one object: pick it.' }
    }

    const checked = target ? checkLink(context, scope, target, NOTE_TARGETS, 'note') : null

    if (checked && !checked.ok) {
      return checked
    }

    const row = checked ? checked.row : null
    const named = target ? { type: target.type, id: row.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: scope.campaignId, branchId: scope.branchId } } : keptTarget(entry, context)
    const payload = { title: typeof title === 'string' ? title.trim() : title, status, next: typeof next === 'string' ? next.trim() : next, target: named }
    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-note', message: `The note is not valid: ${problems.join('; ')}` }
    }

    const links = target ? [{ type: target.type, id: row.id, row }] : []

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: NOTE_KIND, policy: policy || 'branch', links, assumptions: [...ASSUMPTIONS], payload }) }
    }

    const patch = { payload, assumptions: [...ASSUMPTIONS], ...(target ? { links } : {}), ...(policy && policy !== entry.policy ? { policy } : {}) }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patch) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      // A note's target and its link are one fact: the stored link stays when no object was picked, so the target kept with it is the stored revision's, never the edited entry's, which another writer may have relinked since.
      return { ok: true, record: repository.reconcile(scope, error, target ? patch : { ...patch, payload: { ...payload, target: copyOf(error.stored.payload.target) } }) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Deletes a note over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteNote = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'note')

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}
