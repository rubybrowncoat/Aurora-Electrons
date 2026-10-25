// The desired routes of the player: a route the race should have, kept apart from the observed routes (utilities/route-signatures.js) and never derived from them or from stock, reserves or production.
//
// A desired route is a typed record of the scenario repository (utilities/scenario-records.js) of kind `route.desire`: `{ name, cargo, yearly, note, from, to }`, `cargo` being minerals, installations or colonists, `yearly` the yearly demand in tonnes (colonists for colonists) or null for none, and `from` and `to` the two colonies as the player saw them when the record was last kept (`{ id, name, systemId, systemName, origin }`: the name and the system are for display only, `origin` is the campaign and branch the link was made on). The record's own links are the two colonies (`{ type, id, fingerprint }`, the first the source), made by the rules of the milestones' links (utilities/history-milestones.js) that the notes of the economy share: a colony is never certified as the same one, and a link to a colony that is gone or changed reads stale and is never moved to another colony of the same name or place.
//
// Whether the links still hold is worked out on every read against the colonies of the open save and is never stored. Nothing is written to the save or to any order of the game: every read this module sends is a select. Storage and the rules of a stale edit are the repository's; this module takes the repository and the database as arguments, so a check runs it on in-memory stores.

import { NOTE_TARGETS, registerOnce } from './economy-notes'
import { checkLink, failure, mayWrite, resolveLink } from './history-milestones'
import { DESIRE_CARGO, DESIRE_NAME_LENGTH, DESIRE_NOTE_LENGTH } from './route-signatures'

export { scopeOf } from './history-milestones'

export const DESIRE_KIND = 'route.desire'
export const DESIRE_SCHEMA = 1

const TYPES = Object.freeze({ colony: NOTE_TARGETS.colony })
const PAYLOAD_KEYS = ['name', 'cargo', 'yearly', 'note', 'from', 'to']
const ASSUMPTIONS = Object.freeze(['The desired route is the player\'s own: it gives no order to the game and writes nothing to the save'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const copyOf = (value) => JSON.parse(JSON.stringify(value))

const messageOf = (error) => (error && error.message ? error.message : String(error))

const refOk = (ref) => isObject(ref) && Number.isInteger(ref.id) && typeof ref.name === 'string' && (ref.systemId === null || Number.isInteger(ref.systemId)) && typeof ref.systemName === 'string' && isObject(ref.origin) && isText(ref.origin.campaignId) && isText(ref.origin.branchId)

// What is wrong with a desired route to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the desired route is an object']
  }

  const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a desired route`)

  if (!isText(payload.name) || payload.name.length > DESIRE_NAME_LENGTH) {
    problems.push(`name is 1 to ${DESIRE_NAME_LENGTH} characters`)
  }

  if (!DESIRE_CARGO.includes(payload.cargo)) {
    problems.push(`cargo is one of ${DESIRE_CARGO.join(', ')}`)
  }

  if (payload.yearly !== null && !(typeof payload.yearly === 'number' && Number.isFinite(payload.yearly) && payload.yearly > 0)) {
    problems.push('yearly is a positive number, or null for no demand')
  }

  if (typeof payload.note !== 'string' || payload.note.length > DESIRE_NOTE_LENGTH) {
    problems.push(`note is up to ${DESIRE_NOTE_LENGTH} characters (empty for none)`)
  }

  if (!refOk(payload.from) || !refOk(payload.to)) {
    problems.push('from and to are { id, name, systemId, systemName, origin } of a colony, origin being the campaign and branch it was made on')
  } else if (payload.from.id === payload.to.id) {
    problems.push('from and to are two colonies')
  }

  return problems
}

// The adapter of the scenario repository for the desired routes. A link is resolved against `context.objects.colony`, the colonies of the open save (`loadDesireObjects`).
export const desireAdapter = Object.freeze({
  kind: DESIRE_KIND,
  schema: DESIRE_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    if (type !== 'colony') {
      throw new Error(`${type} is not a kind of object a desired route is about`)
    }

    return NOTE_TARGETS.colony.fingerprint(row)
  },
  resolve: (links, context) => links.map((link) => {
    const objects = context && context.objects ? context.objects[link.type] : null

    if (!(objects instanceof Map)) {
      throw new TypeError(`the ${link.type} objects of the save were not read`)
    }

    return objects.get(link.id) || null
  }),
})

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerRouteDesires = (register) => registerOnce(register, desireAdapter)

// The colonies of the race in the open save a desired route can be about: `{ objects: { colony: Map(id -> row) }, failed, GameID, RaceID }`. A read that fails leaves the colonies out and names the failure, and the links read as unknown, never as missing. Every read is a select.
export const loadDesireObjects = async (database, { GameID, RaceID }) => {
  const failed = {}
  const objects = {}

  try {
    const [rows] = await database.query(NOTE_TARGETS.colony.sql, { replacements: { GameID, RaceID } })

    objects.colony = new Map(rows.map((source) => NOTE_TARGETS.colony.row(source)).map((row) => [row.id, row]))
  } catch (error) {
    failed.colony = messageOf(error)
  }

  return { objects, failed, GameID, RaceID }
}

// ---- Reading -----------------------------------------------------------------------------------------------------------

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const currentRowOf = (context, link) => {
  const objects = context && context.objects ? context.objects[link.type] : null

  return objects instanceof Map ? objects.get(link.id) || null : null
}

const endOf = (stored, named, context) => {
  const link = resolveLink(stored, named, context, TYPES)
  const row = currentRowOf(context, stored)

  return { id: named.id, name: named.name, systemId: named.systemId, systemName: named.systemName, origin: { campaignId: named.origin.campaignId, branchId: named.origin.branchId }, link, stale: link.status === 'missing' || link.status === 'changed', nowNamed: row && link.status !== 'missing' && link.status !== 'changed' && row.name !== named.name ? row.name : null }
}

const entryOf = (item, context) => {
  const [fromLink, toLink] = item.links
  const from = endOf(fromLink, item.payload.from, context)
  const to = endOf(toLink, item.payload.to, context)

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    name: item.payload.name,
    cargo: item.payload.cargo,
    yearly: item.payload.yearly,
    note: item.payload.note,
    from,
    to,
    stale: from.stale || to.stale,
    policy: item.record.association.policy,
    otherBranch: item.flags.includes('other-branch'),
    madeAt: item.record.base.gameTime,
    flags: item.flags,
    links: item.links,
  }
}

const refusal = (error) => ({ code: error.code, message: error.message })

// The desired routes of the race in the campaign as the open branch reads them: `{ entries, notes, error }` by name. `context` is `{ objects, ... }` of the open save, or null while its colonies are not read: the links are then unknown. A record the adapter does not understand is a note of the list's own (`notes`). Nothing is written.
export const readDesires = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: DESIRE_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag)) || item.links.length !== 2

  return {
    entries: listed.filter((item) => !unreadable(item)).map((item) => entryOf(item, context)).sort((a, b) => a.name.localeCompare(b.name) || (a.uuid < b.uuid ? -1 : 1)),
    notes: listed.filter(unreadable).map((item) => ({ uuid: item.record.uuid, flags: item.flags, reason: `A desired route written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })),
    error: null,
  }
}

// ---- Keeping -----------------------------------------------------------------------------------------------------------

const namedOf = (row, scope) => ({ id: row.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: scope.campaignId, branchId: scope.branchId } })

// The end a desired route keeps when it is edited without a new colony picked: the one it has, with the name and the system as the open save has them while the link holds.
const keptEnd = (end, context) => {
  const row = end.link && end.link.status !== 'missing' && end.link.status !== 'changed' ? currentRowOf(context, { type: 'colony', id: end.id }) : null

  return { id: end.id, name: row ? row.name : end.name, systemId: row ? row.systemId || null : end.systemId, systemName: row ? row.systemName || '' : end.systemName, origin: { campaignId: end.origin.campaignId, branchId: end.origin.branchId } }
}

// Keeps a desired route: a new record when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. `from` and `to` are the rows of colonies as `loadDesireObjects` gave them, both given for a new route and both undefined to keep the links the record has; a pair given replaces them, only because the player gave it, and is made only against `context` (the colonies of the open save for this race, campaign and branch): a colony that is not in it as picked, or was picked for another race, campaign or branch, is refused. A stale revision is refused with the code 'revision-conflict' and the stored record, and nothing is written, unless `overwrite` says to write over what is stored. Returns `{ ok: true, record }` or `{ ok: false, code, message }`.
export const saveDesire = async (repository, scope, { entry = null, name, cargo, yearly = null, note = '', from, to, context = null, policy, overwrite = false }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'desired route')

    if (!allowed.ok) {
      return allowed
    }

    const picked = Boolean(from || to)

    if (picked && !(from && to && isObject(from.row) && isObject(to.row))) {
      return { ok: false, code: 'invalid-desire', message: 'The two colonies are given together, each as { row } of a colony.' }
    } else if (!picked && !entry) {
      return { ok: false, code: 'invalid-desire', message: 'A desired route runs between two colonies: pick both.' }
    }

    const checkedFrom = picked ? checkLink(context, scope, { type: 'colony', row: from.row }, TYPES, 'desired route') : null
    const checkedTo = picked ? checkLink(context, scope, { type: 'colony', row: to.row }, TYPES, 'desired route') : null
    const refused = [checkedFrom, checkedTo].find((checked) => checked && !checked.ok)

    if (refused) {
      return refused
    }

    const ends = picked ? { from: namedOf(checkedFrom.row, scope), to: namedOf(checkedTo.row, scope) } : { from: keptEnd(entry.from, context), to: keptEnd(entry.to, context) }
    const payload = { name: typeof name === 'string' ? name.trim() : name, cargo, yearly: yearly === '' || yearly === undefined ? null : yearly, note: typeof note === 'string' ? note.trim() : note, from: ends.from, to: ends.to }
    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-desire', message: `The desired route is not valid: ${problems.join('; ')}` }
    }

    const links = picked ? [{ type: 'colony', id: checkedFrom.row.id, row: checkedFrom.row }, { type: 'colony', id: checkedTo.row.id, row: checkedTo.row }] : []

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: DESIRE_KIND, policy: policy || 'branch', links, assumptions: [...ASSUMPTIONS], payload }) }
    }

    const patch = { payload, assumptions: [...ASSUMPTIONS], ...(picked ? { links } : {}), ...(policy && policy !== entry.policy ? { policy } : {}) }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patch) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      // The colonies and their links are one fact: the stored links stay when no pair was picked, so the colonies kept with them are the stored revision's, never the edited entry's, which another writer may have relinked since.
      return { ok: true, record: repository.reconcile(scope, error, picked ? patch : { ...patch, payload: { ...payload, from: copyOf(error.stored.payload.from), to: copyOf(error.stored.payload.to) } }) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Deletes a desired route over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteDesire = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'desired route')

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}
