// The recovery ledger: the life pods and the wrecks the race can see in the systems it knows, and the player's own status for each. The status is a typed record of the scenario repository (utilities/scenario-records.js) of kind `recovery.status`, kept in the campaign's scenario file for the race and for the branch it was kept on (policy `branch`, so another branch, race or campaign never sees it). Its payload is `{ ref, status, observed }`: `ref` is what the player saw when the status was kept (`{ type, id, label, systemId, systemName, own, origin, copies }`, for display and for the branch the link was made on), `status` is `acknowledged` or `personal` (a recovery the player means to make; the app gives no order and cannot tell whether it was made) and `observed` is the span the app had observed for the object then (`{ first, last }`) or null. An object with no record is `pending`: pending is the state of an object nobody has annotated, not a stored value.
//
// Three things stay apart and are never merged into one figure: what the save holds now (the objects, read through what the race knows), the player's status (the record) and what the app has observed (the opt-in capture of utilities/observations.js, kinds `lifepod` and `wreck`). A vanished object is told by its link only: the record names the object by id and by what identifies it, and when the save holds no object under that id the entry reads "no longer observed". Nothing marks it rescued, salvaged or resolved: the save cannot say why an object is gone, and the status the player kept stays as it was.
//
// What each side may see (the field rules of the game, as the observer's views have them): the race's own pod shows its ship's name, crew, class and creation time; a foreign pod and a foreign wreck show only the system, the position, the size of a wreck and the class as the race's intelligence names it (`FCT_AlienClass` of the viewing race, `Unknown` where it has none). Every read below is a whitelist of columns, never `select *`: no column of a foreign object that the game hides is selected, stored, compared or hashed. The yield of a wreck and the time a pod's life support lasts are never read.
//
// Identity. An id can be given again after a reload, a rewind or a replayed branch, so the record keeps what names the object besides its id (`fingerprint`): an own pod by the time it was created, its system and its name; an own wreck by its system, class, size and ship; a foreign pod by its system, position and the observer's class; a foreign wreck by its system, size, orbit and the observer's class. A foreign object has no time the save dates it by, so its trail is by content, and the number of objects that match it (`copies`) is counted: an entry whose object has twins is `ambiguous`, never certified. A link that cannot be checked is not read as held and one whose object is not shown to be the one kept is told apart from one that is gone.
//
// Storage and the rules of a stale edit are the repository's. This module takes the repository and the database as arguments, so a check runs it on in-memory stores and databases.

import { place } from './deep-links'
import { checkLink, failure, mayWrite, resolveLink, scopeOf } from './history-milestones'

export { scopeOf }

export const RECOVERY_KIND = 'recovery.status'
export const RECOVERY_SCHEMA = 1

export const STATUSES = Object.freeze({ PENDING: 'pending', ACKNOWLEDGED: 'acknowledged', PERSONAL: 'personal' })

// The statuses a record can hold: pending is no record.
export const KEPT_STATUSES = Object.freeze([STATUSES.ACKNOWLEDGED, STATUSES.PERSONAL])

export const STATUS_ORDER = Object.freeze([STATUSES.PENDING, STATUSES.ACKNOWLEDGED, STATUSES.PERSONAL])

export const STATUS_TEXT = Object.freeze({ pending: 'Pending', acknowledged: 'Acknowledged', personal: 'Personal recovery' })

export const STATUS_HINT = Object.freeze({
  pending: 'Not reviewed yet.',
  acknowledged: 'Seen and noted, with no recovery planned.',
  personal: 'A recovery the player means to make. The app gives no order and cannot tell whether it was made.',
})

// What the switch of the ledger says it does, and the rule the figures follow.
export const OBSERVATION_PURPOSE = 'Records the life pods and wrecks of the race on this branch at each capture, so a row can say since when it has been seen where it is and as it is. Switching it off keeps what was recorded.'
export const OBSERVATION_RULE = 'Observed since is the first capture that saw the object where it is and as it is; nothing before it is claimed, and nothing is known between two captures. A capture keeps only the objects it saw, so an object that is gone is told by the save and by the last observation kept with its status. A fork starts a new span, since an id is not certified across one.'

// Where an entry stands against the open save: `held` (the object under the id is the one kept), `gone` (no object holds the id), `reused` (another object holds it), `unverified` (an object with the kept fingerprint holds it but nothing shows it is the one kept) and `unread` (the save's objects of that kind were not read, so nothing is said).
export const STATES = Object.freeze({ HELD: 'held', GONE: 'gone', REUSED: 'reused', UNVERIFIED: 'unverified', UNREAD: 'unread' })

// The lists of the ledger a row belongs to.
export const GROUPS = Object.freeze({ PRESENT: 'present', GONE: 'gone', REVIEW: 'review', UNREAD: 'unread', AHEAD: 'ahead' })

export const GROUP_TEXT = Object.freeze({
  present: 'In the save',
  gone: 'No longer observed',
  review: 'Needs review',
  unread: 'Not checked',
  ahead: 'Kept at a later game time',
})

export const STATE_TEXT = Object.freeze({
  held: 'The object under this id is the one the status was kept for.',
  gone: 'The open save holds no object under this id, and nothing says why it is gone, so the status stays as it was kept.',
  reused: 'Another object now holds this id, so the status is not applied to it. Remove the status to give that object one of its own.',
  unverified: 'An object with the kept details holds this id, but nothing shows it is the one the status was kept for, so the status is not applied to it.',
  unread: 'The objects of this kind could not be read from the open save, so the status is not compared with it.',
  ahead: 'The status was kept at a later game time than the open save, so it is not applied to it.',
})

export const IDENTITY_TEXT = Object.freeze({
  created: 'Identified by the time it was created.',
  content: 'Identified by what the race knows of it: no time dates it.',
  ambiguous: 'objects in the save match alike, so the id may name any of them.',
})

export const PLACES = Object.freeze(['lifepod', 'wreck'])

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const idOk = (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const copyOf = (value) => JSON.parse(JSON.stringify(value))

const present = (value) => (value === null || value === undefined ? '' : String(value).replace(/\|/g, '/'))

const messageOf = (error) => (error && error.message ? error.message : String(error))

const numberOrNull = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

// The size of a wreck as the game compares it: the stored decimal drifts at the 15th digit across saves, so it is rounded to six decimals.
const sizeKey = (size) => (finite(size) ? size.toFixed(6) : '')

// A coordinate as a whole number of the game's unit: a pod's place never changes once it is made.
const spot = (value) => (finite(value) ? String(Math.round(value)) : '')

// ---- What the save holds ----------------------------------------------------------------------------------------------

const PODS = 'FCT_Lifepods'
const WRECKS = 'FCT_Wrecks'

const KNOWN = (table, { GameID, RaceID }) => `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = ${table}.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}`

const requireIds = ({ GameID, RaceID }) => {
  if (!Number.isSafeInteger(GameID) || !Number.isSafeInteger(RaceID)) {
    throw new RangeError('The recovery reads take a GameID and a RaceID')
  }
}

// The four statements that read what the race can see. A system the race does not know is not joined, so its objects are not read at all. Each statement names its columns: the own ones read what the game shows the owner, the others only what it shows an observer, and the class of a foreign object comes from the observer's own intelligence (`FCT_AlienClass` of the viewing race), never from the class table of the other race.
export const recoverySql = ({ GameID, RaceID }) => {
  requireIds({ GameID, RaceID })

  const context = { GameID, RaceID }

  return {
    ownLifepod: `select FCT_Lifepods.LifepodID, FCT_Lifepods.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Lifepods.Xcor, FCT_Lifepods.Ycor, FCT_Lifepods.ShipName, FCT_Lifepods.Crew, FCT_Lifepods.CreationTime, FCT_Lifepods.ClassID, FCT_ShipClass.ClassName, FCT_HullDescription.HullAbbr from FCT_Lifepods ${KNOWN(PODS, context)} left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Lifepods.ClassID and FCT_ShipClass.GameID = FCT_Lifepods.GameID left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_ShipClass.HullDescriptionID where FCT_Lifepods.GameID = ${GameID} and FCT_Lifepods.RaceID = ${RaceID} order by FCT_Lifepods.LifepodID`,
    lifepod: `select FCT_Lifepods.LifepodID, FCT_Lifepods.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Lifepods.Xcor, FCT_Lifepods.Ycor, FCT_AlienClass.AlienClassID, FCT_AlienClass.ClassName as AlienClassName, FCT_HullDescription.HullAbbr from FCT_Lifepods ${KNOWN(PODS, context)} left join FCT_AlienClass on FCT_AlienClass.GameID = FCT_Lifepods.GameID and FCT_AlienClass.ViewRaceID = ${RaceID} and FCT_AlienClass.ActualClassID = FCT_Lifepods.ClassID left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_AlienClass.HullID where FCT_Lifepods.GameID = ${GameID} and FCT_Lifepods.RaceID != ${RaceID} order by FCT_Lifepods.LifepodID`,
    ownWreck: `select FCT_Wrecks.WreckID, FCT_Wrecks.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Wrecks.OrbitBodyID, FCT_Wrecks.Xcor, FCT_Wrecks.Ycor, FCT_Wrecks.Size, FCT_Wrecks.ClassID, FCT_Wrecks.ShipID, FCT_ShipClass.ClassName, FCT_HullDescription.HullAbbr from FCT_Wrecks ${KNOWN(WRECKS, context)} left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Wrecks.ClassID and FCT_ShipClass.GameID = FCT_Wrecks.GameID left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_ShipClass.HullDescriptionID where FCT_Wrecks.GameID = ${GameID} and FCT_Wrecks.RaceID = ${RaceID} order by FCT_Wrecks.WreckID`,
    wreck: `select FCT_Wrecks.WreckID, FCT_Wrecks.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Wrecks.OrbitBodyID, FCT_Wrecks.Xcor, FCT_Wrecks.Ycor, FCT_Wrecks.Size, FCT_AlienClass.AlienClassID, FCT_AlienClass.ClassName as AlienClassName, FCT_HullDescription.HullAbbr, FCT_AlienRace.Abbrev as RaceTag from FCT_Wrecks ${KNOWN(WRECKS, context)} left join FCT_AlienClass on FCT_AlienClass.GameID = FCT_Wrecks.GameID and FCT_AlienClass.ViewRaceID = ${RaceID} and FCT_AlienClass.ActualClassID = FCT_Wrecks.ClassID left join FCT_HullDescription on FCT_HullDescription.HullDescriptionID = FCT_AlienClass.HullID left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Wrecks.GameID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.AlienRaceID = FCT_Wrecks.RaceID and FCT_AlienClass.AlienClassID is not null where FCT_Wrecks.GameID = ${GameID} and FCT_Wrecks.RaceID != ${RaceID} order by FCT_Wrecks.WreckID`,
  }
}

// The kinds of object the ledger links to, in the shape of the milestones' `LINK_TYPES` (utilities/history-milestones.js), which the link check reads. `place` is the kind of place the object is (the ledger's own and the Route Finder's `place` key), `own` whether the race owns it. `fingerprint` holds only what the game does not change over the object's life and only fields the viewing race may see: the owner's own for an own object, the observer's for any other. `identity` says what makes the object the same one when its id may have been given again: 'created' is the time it was made (an own pod's creation time, the index of the fingerprint part that holds it), 'content' is what the race knows of an object that no time dates.
export const RECOVERY_TARGETS = Object.freeze({
  ownLifepod: Object.freeze({ label: 'Own life pods', place: 'lifepod', own: true, identity: 'created', created: 0, fingerprint: (row) => ['ownLifepod', present(row.created), present(row.systemId), present(row.shipName)].join('|') }),
  lifepod: Object.freeze({ label: 'Life pods', place: 'lifepod', own: false, identity: 'content', fingerprint: (row) => ['lifepod', present(row.systemId), spot(row.x), spot(row.y), present(row.aliasId)].join('|') }),
  ownWreck: Object.freeze({ label: 'Own wrecks', place: 'wreck', own: true, identity: 'content', fingerprint: (row) => ['ownWreck', present(row.systemId), present(row.classId), sizeKey(row.size), present(row.shipId)].join('|') }),
  wreck: Object.freeze({ label: 'Wrecks', place: 'wreck', own: false, identity: 'content', fingerprint: (row) => ['wreck', present(row.systemId), sizeKey(row.size), present(row.orbitBodyId), present(row.aliasId)].join('|') }),
})

export const TYPE_KEYS = Object.freeze(Object.keys(RECOVERY_TARGETS))

const targetOf = (type) => (hasOwn(RECOVERY_TARGETS, type) ? RECOVERY_TARGETS[type] : null)

// The place of an object in Route Finder's terms: `lifepod:7` or `wreck:7`.
export const placeKeyOf = (row) => place[row.place](row.id)

const classLabelOf = (className, hullAbbr) => [hullAbbr, className].filter(Boolean).join(' ')

// The objects of one kind as rows: `{ type, place, id, own, systemId, systemName, x, y, ... }`. An own row also holds what the game shows the owner (a pod's ship name, crew and creation time, a wreck's ship) and a foreign row holds none of it: it carries the observer's class (`aliasId`, `className`, `hullAbbr`, `raceTag`) only.
const rowOf = (type, source) => {
  const target = RECOVERY_TARGETS[type]
  const pod = target.place === 'lifepod'
  const base = { type, place: target.place, id: pod ? source.LifepodID : source.WreckID, own: target.own, systemId: source.SystemID, systemName: present(source.SystemName), x: numberOrNull(source.Xcor), y: numberOrNull(source.Ycor) }

  if (pod) {
    return target.own ? { ...base, shipName: present(source.ShipName), crew: numberOrNull(source.Crew), created: numberOrNull(source.CreationTime), classId: numberOrNull(source.ClassID), className: source.ClassName || null, hullAbbr: source.HullAbbr || null } : { ...base, aliasId: numberOrNull(source.AlienClassID), className: source.AlienClassName || null, hullAbbr: source.HullAbbr || null }
  }

  const size = numberOrNull(source.Size)
  const wreck = { ...base, orbitBodyId: numberOrNull(source.OrbitBodyID), size: size === null ? null : Number(size.toFixed(6)), tons: size === null ? null : size * 50 }

  return target.own ? { ...wreck, classId: numberOrNull(source.ClassID), shipId: numberOrNull(source.ShipID), className: source.ClassName || null, hullAbbr: source.HullAbbr || null } : { ...wreck, aliasId: numberOrNull(source.AlienClassID), className: source.AlienClassName || null, hullAbbr: source.HullAbbr || null, raceTag: String(source.RaceTag || '').trim() || null }
}

// The rows of one kind with the number of rows in the group that match each alike (`copies`): the rows the fingerprint cannot tell apart.
const withCopies = (type, rows) => {
  const counts = new Map()

  rows.forEach((row) => counts.set(RECOVERY_TARGETS[type].fingerprint(row), (counts.get(RECOVERY_TARGETS[type].fingerprint(row)) || 0) + 1))

  return rows.map((row) => ({ ...row, copies: counts.get(RECOVERY_TARGETS[type].fingerprint(row)) }))
}

// The objects the race can see, by kind: `{ objects: { [type]: Map of id to row | null }, failed: { [type]: message } }`. A kind whose statement failed is null, never empty: a record about an object of that kind is then not checked, which is not the same as the object being gone. `options` is the recorder's transaction.
export const loadRecoveryObjects = async (database, { GameID, RaceID }, options = undefined) => {
  const statements = recoverySql({ GameID, RaceID })
  const objects = {}
  const failed = {}

  await Promise.all(TYPE_KEYS.map(async (type) => {
    try {
      const [rows] = await database.query(statements[type], options)

      objects[type] = new Map(withCopies(type, rows.map((source) => rowOf(type, source))).map((row) => [row.id, Object.freeze(row)]))
    } catch (error) {
      objects[type] = null
      failed[type] = messageOf(error)
    }
  }))

  return Object.freeze({ objects: Object.freeze(objects), failed: Object.freeze(failed) })
}

// ---- What the game calls an object ---------------------------------------------------------------------------------------

const tonsText = (row, count) => (row.tons === null ? 'unknown size' : `${count(row.tons)} tons`)

// The label of an object as the game words it: an own pod by its ship's name and crew, a foreign pod by the class the race knows and its id, a wreck by the class (the observer's for another race's, `Unknown` where it has none), the observer's tag of the race when it knows the class, its id and its tons. A foreign pod's name and crew are never part of it. `count(number)` formats a figure.
export const labelOf = (row, count = String) => {
  if (row.place === 'lifepod') {
    return row.own ? `${row.shipName || 'Unnamed'} life pods: ${row.crew === null ? 'crew unknown' : `${count(row.crew)} crew`}` : `${classLabelOf(row.className, row.hullAbbr) || 'Unknown'} life pods #${row.id}`
  }

  return `Wreck of ${row.className || 'Unknown'} class${row.raceTag ? ` [${row.raceTag}]` : ''} #${row.id}: ${tonsText(row, count)}`
}

// The class of an object as the race names it: the owner's class for an own object, the observer's for any other, null where it holds none.
export const classTextOf = (row) => classLabelOf(row.className, row.hullAbbr) || null

// The age of an own pod: the game time since it was made. Nothing else has one the race can read: a foreign pod's creation time is hidden and a wreck has none. It is an age and nothing else: no time left and no verdict is derived from it.
export const ageOf = (row, gameTime) => (row.place === 'lifepod' && row.own && finite(row.created) && finite(gameTime) && gameTime >= row.created ? gameTime - row.created : null)

// ---- What an observation compares ----------------------------------------------------------------------------------------

// The text an observation of an object is hashed from: where it is and what the race knows of it (own or not, the system, the position of a pod, the orbit and the size of a wreck, the class as the viewing race knows it), and for an own object what identifies it besides its id (a pod's creation time and name, a wreck's ship), so an id given again to another object starts a new span. A wreck tied to a body follows the body's clock, so its coordinates are no part of it; a free one is compared by position. Nothing the race may not see is in it.
export const observationSignature = (row) => (row.place === 'lifepod' ? [row.own ? 'own' : 'seen', present(row.systemId), spot(row.x), spot(row.y), present(row.own ? row.classId : row.aliasId), ...(row.own ? [present(row.created), present(row.shipName)] : [])].join('/') : [row.own ? 'own' : 'seen', present(row.systemId), present(row.orbitBodyId), sizeKey(row.size), ...(row.orbitBodyId ? [] : [spot(row.x), spot(row.y)]), present(row.own ? row.classId : row.aliasId), ...(row.own ? [present(row.shipId)] : [])].join('/'))

const observedOf = async (database, ids, options, kinds) => {
  const statements = recoverySql(ids)
  const rows = []

  for (const type of kinds) {
    const [source] = await database.query(statements[type], options)

    rows.push(...source.map((row) => rowOf(type, row)))
  }

  return rows.sort((a, b) => a.id - b.id).map((row) => [row.id, observationSignature(row)])
}

// The life pods and the wrecks of a race at the open save for an observation: `[[id, signature]]`, read with `options` (the recorder's transaction). A save that lacks a table or column the statements read makes the statement fail, so the recorder notes a failed read and not an empty one.
export const readLifepodObservations = (database, { GameID, RaceID }, options = undefined) => observedOf(database, { GameID, RaceID }, options, ['ownLifepod', 'lifepod'])

export const readWreckObservations = (database, { GameID, RaceID }, options = undefined) => observedOf(database, { GameID, RaceID }, options, ['ownWreck', 'wreck'])

// ---- The record ---------------------------------------------------------------------------------------------------------

const PAYLOAD_KEYS = ['ref', 'status', 'observed']

const REF_KEYS = ['type', 'id', 'label', 'systemId', 'systemName', 'own', 'origin', 'copies']

const spanOk = (observed) => observed === null || (isObject(observed) && Object.keys(observed).every((key) => key === 'first' || key === 'last') && finite(observed.first) && finite(observed.last) && observed.first <= observed.last)

// What is wrong with a status to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the status is an object']
  }

  const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a status`)
  const ref = payload.ref

  if (!(isObject(ref) && Object.keys(ref).every((key) => REF_KEYS.includes(key)) && targetOf(ref.type) && idOk(ref.id) && typeof ref.label === 'string' && (ref.systemId === null || Number.isInteger(ref.systemId)) && typeof ref.systemName === 'string' && typeof ref.own === 'boolean' && ref.own === targetOf(ref.type).own && isObject(ref.origin) && isText(ref.origin.campaignId) && isText(ref.origin.branchId) && Number.isInteger(ref.copies) && ref.copies >= 1)) {
    problems.push('ref names the object: its kind, id, label, system, whether it is own, the campaign and branch it was seen on and how many matched it')
  }

  if (!KEPT_STATUSES.includes(payload.status)) {
    problems.push(`status is one of ${KEPT_STATUSES.join(', ')} (pending is no record)`)
  }

  if (!spanOk(payload.observed)) {
    problems.push('observed is null or the first and last game time the object was observed')
  }

  return problems
}

// The adapter of the scenario repository for the statuses. A link is resolved against `context.objects`, the objects of the open save (`loadRecoveryObjects`): a kind of object the save could not give makes the resolution fail, so its links read as unknown and never as missing, and one whose object is not there is missing.
export const recoveryAdapter = Object.freeze({
  kind: RECOVERY_KIND,
  schema: RECOVERY_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    const definition = targetOf(type)

    if (!definition) {
      throw new Error(`${type} is not a kind of object a status names`)
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
export const registerRecoveryLedger = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(recoveryAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

// ---- Where an entry stands against the save ------------------------------------------------------------------------------

// The state of an entry from its link as `resolveLink` gives it.
export const stateOf = (link) => {
  if (!link || (link.status === 'unknown' && !link.unverified)) {
    return STATES.UNREAD
  }

  if (link.status === 'missing') {
    return STATES.GONE
  }

  if (link.status === 'changed') {
    return STATES.REUSED
  }

  return link.status === 'unknown' ? STATES.UNVERIFIED : STATES.HELD
}

const currentRowOf = (context, link) => {
  const objects = context && context.objects ? context.objects[link.type] : null

  return objects instanceof Map ? objects.get(link.id) || null : null
}

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const refusal = (error) => ({ code: error.code, message: error.message })

const entryOf = (item, context) => {
  if (item.links.length !== 1 || !targetOf(item.links[0].type) || item.links[0].type !== item.payload.ref.type || item.links[0].id !== item.payload.ref.id) {
    return null
  }

  const stored = item.links[0]
  const ref = item.payload.ref
  const link = resolveLink(stored, { name: ref.label, origin: ref.origin }, context, RECOVERY_TARGETS)
  const state = stateOf(link)
  const row = state === STATES.UNREAD || state === STATES.GONE ? null : currentRowOf(context, stored)

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    status: item.payload.status,
    type: stored.type,
    place: targetOf(stored.type).place,
    id: ref.id,
    ref: copyOf(ref),
    observed: item.payload.observed === null || item.payload.observed === undefined ? null : { first: item.payload.observed.first, last: item.payload.observed.last },
    madeAt: item.record.base.gameTime,
    ahead: item.status === 'ahead',
    otherBranch: item.flags.includes('other-branch'),
    flags: [...item.flags],
    link,
    state,
    row,
    ambiguous: state === STATES.HELD && row !== null && row.copies > 1,
    identity: targetOf(stored.type).identity,
  }
}

// The statuses of the race in the campaign as the open branch reads them: `{ entries, notes, error }`. `context` is `{ objects, ... }` of the open save, or null while its objects are not read: the links are then not read, which is neither held nor gone. A record the adapter does not understand is a note of the list's own (`notes`). Nothing is written.
export const readRecovery = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: RECOVERY_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))
  const noteOf = (item, reason) => ({ uuid: item.record.uuid, flags: item.flags, reason: reason || `A status written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })
  const notes = listed.filter(unreadable).map((item) => noteOf(item))
  const entries = []

  listed.filter((item) => !unreadable(item)).forEach((item) => {
    const entry = entryOf(item, context)

    if (entry) {
      entries.push(entry)
    } else {
      notes.push(noteOf(item, 'A status whose link does not match what it names is not listed.'))
    }
  })

  return { entries: entries.sort((a, b) => a.ref.label.localeCompare(b.ref.label) || (a.uuid < b.uuid ? -1 : 1)), notes, error: null }
}

// ---- The ledger's rows ---------------------------------------------------------------------------------------------------

const typeOrder = (type) => TYPE_KEYS.indexOf(type)

// The rows of the ledger: one for each object the race can see (with the status held for it, `pending` where none), then the statuses whose object is not the one now under the id, each in the list it belongs to. `{ key, group, place, type, id, object, entry, status }`: `object` is the row of the save (null for a status with no object) and `entry` the status entry (null for a pending object). An entry that is held by an object is shown on the object's row only; two entries that hold one object are both listed for review, since only one of them may stand for it.
export const recoveryRows = ({ objects, entries }) => {
  const applied = entries.filter((entry) => !entry.ahead)
  const holders = new Map()

  applied.filter((entry) => entry.state === STATES.HELD).forEach((entry) => holders.set(`${entry.type}:${entry.id}`, [...(holders.get(`${entry.type}:${entry.id}`) || []), entry]))

  const rows = []
  const overlapping = []

  TYPE_KEYS.forEach((type) => {
    const group = objects ? objects[type] : null

    if (!(group instanceof Map)) {
      return
    }

    ;[...group.values()].forEach((object) => {
      const held = holders.get(`${type}:${object.id}`) || []
      const entry = held.length === 1 ? held[0] : null

      if (held.length > 1) {
        overlapping.push(...held)
      }

      rows.push({ key: `${type}:${object.id}`, group: GROUPS.PRESENT, place: object.place, type, id: object.id, object, entry, status: entry ? entry.status : STATUSES.PENDING })
    })
  })

  rows.sort((a, b) => a.object.systemName.localeCompare(b.object.systemName) || a.place.localeCompare(b.place) || typeOrder(a.type) - typeOrder(b.type) || a.id - b.id)

  const listed = (entry, group) => ({ key: `entry:${entry.uuid}`, group, place: entry.place, type: entry.type, id: entry.id, object: null, current: entry.row, entry, status: entry.status })
  const rest = []

  applied.forEach((entry) => {
    if (entry.state === STATES.GONE) {
      rest.push(listed(entry, GROUPS.GONE))
    } else if (entry.state === STATES.REUSED || entry.state === STATES.UNVERIFIED || overlapping.includes(entry)) {
      rest.push(listed(entry, GROUPS.REVIEW))
    } else if (entry.state === STATES.UNREAD) {
      rest.push(listed(entry, GROUPS.UNREAD))
    }
  })

  entries.filter((entry) => entry.ahead).forEach((entry) => rest.push(listed(entry, GROUPS.AHEAD)))

  return [...rows, ...rest]
}

// The figures over the rows: how many are in each list and, of the objects in the save, how many hold each status.
export const recoveryTotals = (rows) => {
  const groups = Object.fromEntries(Object.values(GROUPS).map((group) => [group, rows.filter((row) => row.group === group).length]))
  const statuses = Object.fromEntries(STATUS_ORDER.map((status) => [status, rows.filter((row) => row.group === GROUPS.PRESENT && row.status === status).length]))

  return { groups, statuses }
}

// ---- Keeping a status -----------------------------------------------------------------------------------------------------

const ASSUMPTIONS = Object.freeze(['The status is the player\'s own: it gives no order to the game and writes nothing to the save', 'The object it names stays the one it was kept for only while the save shows it under the same id with the same details'])

const refOf = (row, scope, count) => ({ type: row.type, id: row.id, label: labelOf(row, count), systemId: Number.isInteger(row.systemId) ? row.systemId : null, systemName: row.systemName, own: row.own, origin: { campaignId: scope.campaignId, branchId: scope.branchId }, copies: row.copies })

// Sets the status of an object of the open save: `row` is the row of `loadRecoveryObjects`, `status` one of STATUSES, `entry` the held entry of the object or null. `pending` removes the status the object holds. A status is kept only against `context`, the objects of the open save for this race, campaign and branch (with its `RaceID`, `campaignId` and `branchId`): an object that is not in it as picked, or that was picked for another race, campaign or branch, is refused. A kind of object that could not be read is refused. `observed` is the span the app has observed for the object, `{ first, last }`, or null. `count(number)` formats a figure of the label. A stale revision is refused with the code 'revision-conflict'; nothing is overwritten.
export const setStatus = async (repository, scope, { row, status, entry = null, observed = null, context = null, count = String }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'status')

    if (!allowed.ok) {
      return allowed
    }

    const invalid = (message) => ({ ok: false, code: 'invalid-status', message })

    if (!Object.values(STATUSES).includes(status)) {
      return invalid(`The status is one of ${STATUS_ORDER.join(', ')}.`)
    }

    if (!(isObject(row) && targetOf(row.type) && idOk(row.id))) {
      return invalid('A status is about one object of the save: pick it.')
    }

    if (status === STATUSES.PENDING) {
      return entry ? await removeStatus(repository, scope, entry) : { ok: true, record: null }
    }

    const checked = checkLink(context, scope, { type: row.type, row }, RECOVERY_TARGETS, 'status')

    if (!checked.ok) {
      return checked
    }

    if (entry && (entry.type !== row.type || entry.id !== row.id || entry.state !== STATES.HELD)) {
      return invalid('The status held is not for this object: remove it first.')
    }

    if (!spanOk(observed)) {
      return invalid('The observed span is null or the first and last game time the object was observed.')
    }

    const payload = { ref: refOf(checked.row, scope, count), status, observed: observed === null ? null : { first: observed.first, last: observed.last } }
    const problems = problemsOf(payload)

    if (problems.length) {
      return invalid(`The status is not valid: ${problems.join('; ')}`)
    }

    if (!entry) {
      const precondition = (items) => {
        if (items.some((item) => item.payload && item.payload.ref && item.payload.ref.type === row.type && item.payload.ref.id === row.id && !item.flags.some((flag) => NOT_SHOWN.includes(flag)))) {
          throw Object.assign(new Error('This id has a status kept already in this campaign and branch, for an object that is not shown to be this one: remove that status first.'), { code: 'exists' })
        }
      }

      return { ok: true, record: repository.create(scope, { kind: RECOVERY_KIND, policy: 'branch', links: [{ type: row.type, id: row.id, row: checked.row }], assumptions: [...ASSUMPTIONS], payload, precondition }) }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { payload: { ...payload, ref: { ...payload.ref, origin: copyOf(entry.ref.origin) } }, assumptions: [...ASSUMPTIONS] }) }
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

// Removes a status over the revision the entry was read at; a stale revision is refused and nothing is removed. A status whose object is gone or reused is removed the same way.
export const removeStatus = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'status')

    if (!allowed.ok) {
      return allowed
    }

    try {
      return { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) }
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
