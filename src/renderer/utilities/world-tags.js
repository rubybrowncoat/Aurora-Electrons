// The personal tags of the race's bodies: a short label the player puts on one body (a planet, a moon, an asteroid or a comet) of a system the race knows, to find it again from the Notebook and the Galaxy Map.
//
// A tag is a typed record of the scenario repository (utilities/scenario-records.js) of kind `world.tag`, in the campaign's scenario file beside the notes of utilities/economy-notes.js: `{ tag, target }`, `target` being `{ type: 'body', id, name, systemId, systemName, origin }`, what the tag is about as the player saw it when the tag was last kept (the name and the system, for display only) and the campaign and branch the link was made on. The record's own link is the body (`{ type: 'body', id, fingerprint }`), made by the notes' body rule (`NOTE_TARGETS.body`) and checked by the same code as the notes and the milestones (utilities/history-milestones.js): this module adds no rule of its own to it.
//
// Which body is known: any body of class planet, moon, asteroid or comet in a system the race has a row of in FCT_RaceSysSurvey, whether or not the race has surveyed it (the notes' rule, `loadBodies`). The game lists every body of a known system on its system view, so a survey is not needed to see one; the map's ruins and ancient constructs also need the body surveyed (FCT_SystemBodySurveys), a narrower rule that a tag does not use.
//
// A tag is on one body only: tagging a moon leaves its planet and its system untagged, and nothing here reads or writes the map's clusters (`mapGroups`) or borders. One body has one tag: tagging a tagged body changes its tag, clearing deletes the record. A tag is kept for the branch (the campaign, the race and the branch of the open save): another race, branch or campaign never lists it.
//
// Whether the link still holds is worked out on every read against the bodies of the open save and is never stored: `linked`, `missing`, `changed` and `unknown` (shown as not checked, for a body that is there but not known to be the one that was tagged). A tag whose link is `missing` or `changed` is stale: it stays listed, with the name and the system the body had when the tag was last kept, and is never moved to another body that has the same name or the same place. A rename keeps the link. A body is known by the time its system was discovered by the race, so a save from before that discovery (a rewind) holds no such body, or another one under the same ID: the tag reads gone or changed there, and `ahead` says the tag was made at a later game time than the save open.
//
// Nothing here gives an order to the game or writes the save: every read is a select. The repository and the database are arguments, so a check runs this on in-memory stores.

import { NOTE_TARGETS, noteAdapter, noteChoices, registerOnce } from './economy-notes'
import { BODY_CLASS } from './habitability'
import { checkLink, failure, mayWrite, resolveLink } from './history-milestones'

export { bodyIdsOf, loadBodies, scopeOf } from './economy-notes'

export const TAG_KIND = 'world.tag'
export const TAG_SCHEMA = 1
export const TAG_LENGTH = 40

// The kinds of object a tag is about, in the shape the link check reads: the notes' own body, and no other.
export const WORLD_TARGETS = Object.freeze({ body: NOTE_TARGETS.body })

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const copyOf = (value) => JSON.parse(JSON.stringify(value))

const CLASS_TEXT = Object.freeze({ [BODY_CLASS.PLANET]: 'Planet', [BODY_CLASS.MOON]: 'Moon', [BODY_CLASS.ASTEROID]: 'Asteroid', [BODY_CLASS.COMET]: 'Comet' })

// The text of a tag as it is kept: the ends trimmed and every run of white space one space.
export const tagTextOf = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value)

// Where the body fingerprint keeps what a tag shows of the body apart from its link: 'body|system|planet|orbit|class|type|discovered'.
const CLASS_PART = 4
const DISCOVERED_PART = NOTE_TARGETS.body.created + 1

const partOf = (fingerprint, index) => {
  const part = String(fingerprint).split('|')[index]

  return part === undefined || part === '' || !Number.isFinite(Number(part)) ? null : Number(part)
}

// What is wrong with a tag to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the tag is an object']
  }

  const problems = Object.keys(payload).filter((key) => !['tag', 'target'].includes(key)).map((key) => `${key} is not a field of a tag`)

  if (!isText(payload.tag) || payload.tag.length > TAG_LENGTH || tagTextOf(payload.tag) !== payload.tag) {
    problems.push(`tag is 1 to ${TAG_LENGTH} characters, with no space at its ends and one space between words`)
  }

  const target = payload.target

  if (!(isObject(target) && target.type === 'body' && (isText(target.id) || (typeof target.id === 'number' && Number.isFinite(target.id))) && typeof target.name === 'string' && (target.systemId === null || Number.isInteger(target.systemId)) && typeof target.systemName === 'string' && isObject(target.origin) && isText(target.origin.campaignId) && isText(target.origin.branchId))) {
    problems.push('target is { type: \'body\', id, name, systemId, systemName, origin }, origin being the campaign and branch the tag was made on')
  }

  return problems
}

// The adapter of the scenario repository for the tags: the notes' resolution of a body link, for a body only.
export const tagAdapter = Object.freeze({
  kind: TAG_KIND,
  schema: TAG_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    if (type !== 'body') {
      throw new Error(`${type} is not a kind of object a tag is about`)
    }

    return noteAdapter.fingerprint(type, row)
  },
  resolve: noteAdapter.resolve,
})

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerWorldTags = (register) => registerOnce(register, tagAdapter)

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const noteOf = (item) => ({ uuid: item.record.uuid, flags: item.flags, reason: `A tag written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })

const entryOf = (item, context) => {
  const stored = item.links.length ? item.links[0] : null
  const target = item.payload.target
  const link = stored ? resolveLink(stored, target, context, WORLD_TARGETS) : null
  const bodies = context && context.objects ? context.objects.body : null
  const row = stored && bodies instanceof Map ? bodies.get(stored.id) || null : null
  const stale = Boolean(link) && (link.status === 'missing' || link.status === 'changed')
  const bodyClass = stored ? partOf(stored.fingerprint, CLASS_PART) : null

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    tag: item.payload.tag,
    target: { type: 'body', id: target.id, name: target.name, systemId: target.systemId, systemName: target.systemName, origin: { campaignId: target.origin.campaignId, branchId: target.origin.branchId } },
    kind: CLASS_TEXT[bodyClass] || 'Body',
    link,
    stale,
    place: { systemId: target.systemId, systemName: row && link && link.status === 'linked' && row.systemName ? row.systemName : target.systemName, lastKnown: stale },
    discoveredAt: stored ? partOf(stored.fingerprint, DISCOVERED_PART) : null,
    ahead: item.flags.includes('ahead'),
    madeAt: item.record.base.gameTime,
    flags: item.flags,
    links: item.links,
  }
}

const isUnreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))

// The tags of the race in the campaign as the open branch reads them: `{ entries, notes, error }`, by tag, system and body. `context` is `{ objects: { body: Map(id -> row) }, RaceID, campaignId, branchId, branches }` of the open save, or null while its bodies are not read: the links are then unknown, and the system is the one kept. A record the adapter does not understand is a note of the list's own (`notes`). Nothing is written.
export const readTags = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: TAG_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      const { code, message } = failure(error)

      return { ...empty, error: { code, message } }
    }

    throw error
  }

  return {
    entries: listed.filter((item) => !isUnreadable(item)).map((item) => entryOf(item, context)).sort((a, b) => a.tag.localeCompare(b.tag) || a.place.systemName.localeCompare(b.place.systemName) || a.target.name.localeCompare(b.target.name) || (a.uuid < b.uuid ? -1 : 1)),
    notes: listed.filter(isUnreadable).map(noteOf),
    error: null,
  }
}

// The bodies of one system a tag can be put on, as `{ id, name, text, row }` sorted by name, from the bodies `loadBodies` read: the class is named beside the name.
export const tagChoices = (bodies, systemId) => noteChoices({ body: bodies }, 'body', { systemId }).map((choice) => ({ ...choice, text: `${choice.name} · ${CLASS_TEXT[choice.row.bodyClass] || 'Body'}` }))

// ---- The filter ------------------------------------------------------------------------------------------------------

export const ALL_TAGS = 'all'
export const STALE_TAGS = 'stale'

// The value of the filter for one tag text: a tag is never taken for a choice that is not one.
export const tagValue = (tag) => `tag:${tag}`

// The choices of the filter: all the tags, each tag text with the number of bodies it is on, and the stale tags when there are any.
export const tagOptions = (entries) => {
  const counts = new Map()

  entries.forEach((entry) => counts.set(entry.tag, (counts.get(entry.tag) || 0) + 1))

  const stale = entries.filter((entry) => entry.stale).length

  return [
    { value: ALL_TAGS, text: 'All tags', count: entries.length },
    ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, count]) => ({ value: tagValue(tag), text: tag, count })),
    ...(stale ? [{ value: STALE_TAGS, text: 'Stale tags', count: stale }] : []),
  ]
}

// The tags of one choice of the filter (`tagOptions`): all of them, the stale ones, or the ones with one tag text.
export const filterByTag = (entries, value) => {
  if (value === ALL_TAGS) {
    return entries
  }

  return value === STALE_TAGS ? entries.filter((entry) => entry.stale) : entries.filter((entry) => tagValue(entry.tag) === value)
}

// The tag texts in use, for the form to offer.
export const tagSuggestions = (entries) => [...new Set(entries.map((entry) => entry.tag))].sort((a, b) => a.localeCompare(b))

// The tags by the system their body is in (the last known one for a stale tag), as an object keyed by SystemID text: `{ [SystemID]: { entries, stale } }`, `stale` being true when every tag there is stale.
export const tagsBySystem = (entries) => {
  const systems = {}

  entries.filter((entry) => entry.place.systemId !== null).forEach((entry) => {
    const key = String(entry.place.systemId)

    systems[key] = systems[key] || { entries: [], stale: true }
    systems[key].entries.push(entry)
    systems[key].stale = systems[key].stale && entry.stale
  })

  return systems
}

// ---- Keeping a tag ---------------------------------------------------------------------------------------------------

const ASSUMPTIONS = Object.freeze(['The tag is the player\'s own: it gives no order to the game and writes nothing to the save'])

// The target a tag keeps when its text is edited without a new link: the one it has, with the name and the system of the body as the open save has them while the link holds.
const keptTarget = (entry, context) => {
  const kept = entry.target
  const bodies = context && context.objects ? context.objects.body : null
  const row = entry.link && entry.link.status === 'linked' && bodies instanceof Map ? bodies.get(kept.id) || null : null

  return { type: 'body', id: kept.id, name: row ? row.name : kept.name, systemId: row ? row.systemId || null : kept.systemId, systemName: row ? row.systemName || '' : kept.systemName, origin: { campaignId: kept.origin.campaignId, branchId: kept.origin.branchId } }
}

const conflict = (error) => ({ ok: false, code: 'revision-conflict', message: `${error.message} The tag was changed elsewhere, so nothing is written. It is listed as it is now.` })

// The tag a body has among `entries`: the one that is that body (the same ID and the same fingerprint), or null. A stale tag of the same ID is another record.
const matchOf = (entries, row) => entries.find((one) => one.links[0] && one.links[0].id === row.id && one.links[0].fingerprint === WORLD_TARGETS.body.fingerprint(row)) || null

// The refusal when the tag a body has now (`same`, from `matchOf`) is not what the form recorded when the body was picked (`asked`, `{ uuid, revision }` or `{ uuid: null, revision: null }` for a body that had none): null when it is.
const movedSince = (asked, same) => {
  if (asked.uuid === null ? !same : same && same.uuid === asked.uuid && same.revision === asked.revision) {
    return null
  }

  return { ok: false, code: 'revision-conflict', message: `The tag of this body ${asked.uuid === null ? 'was made' : same ? 'was changed' : 'was cleared'} elsewhere after the body was picked, so nothing is written. Pick the body again to see it as it is now.` }
}

// What a precondition of `repository.create` throws for a refusal, so the write is not made and `saveTag` reports the refusal.
class TagMoved extends Error {
  constructor (refusal) {
    super(refusal.message)
    this.name = 'TagMoved'
    this.refusal = refusal
  }
}

// What a form records when it picks the body `row`, to make its tag later over: `{ uuid, revision }` of the tag the body has in `entries` (all of the branch's tags, not the ones a filter shows), or `{ uuid: null, revision: null }` when the body has none. `saveTag` refuses the save when that is no longer so.
export const expectedOf = (entries, row) => {
  const held = row ? matchOf(entries, row) : null

  return held ? { uuid: held.uuid, revision: held.revision } : { uuid: null, revision: null }
}

// Keeps a tag: the text `tag` on a body, or the text of the tag `entry` names.
// - `target` is `{ type: 'body', row }` with a row as `loadBodies` gave it: the tag of that body is made, or changed when the body has one that is the same body (the same ID and the same fingerprint). `expected` is required with it: what the form recorded when the body was picked (`expectedOf`). A body that has a tag now that it had none, a tag that is not the one at that revision, or a tag that is gone, is refused with the code 'revision-conflict' and nothing is written. The link is made only against `context`, the bodies of the open save for this race, campaign and branch, and only for a body that is there as it was picked. A stale tag of the same ID is another record: it is never changed into the tag of the body that holds the ID now.
// - without `target`, `entry` (read at the revision it holds) has its text changed and keeps its link, also while it is stale.
// A stale revision is refused with the code 'revision-conflict' and nothing is written. Returns `{ ok: true, record, unchanged }` or `{ ok: false, code, message }`.
export const saveTag = async (repository, scope, { entry = null, tag, target, expected, context = null }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'tag')

    if (!allowed.ok) {
      return allowed
    }

    if (target && !(isObject(target) && target.type === 'body' && isObject(target.row))) {
      return { ok: false, code: 'invalid-tag', message: 'The target is { type: \'body\', row }' }
    }

    if (!target && !entry) {
      return { ok: false, code: 'invalid-tag', message: 'A tag is on one body: pick it.' }
    }

    const checked = target ? checkLink(context, scope, target, WORLD_TARGETS, 'tag') : null

    if (checked && !checked.ok) {
      return checked
    }

    const row = checked ? checked.row : null
    const same = row ? matchOf(readTags(repository, scope, context).entries, row) : null
    let asked = null

    if (target) {
      asked = isObject(expected) && (expected.uuid === null ? expected.revision === null : isText(expected.uuid) && Number.isInteger(expected.revision)) ? expected : null

      if (!asked) {
        return { ok: false, code: 'invalid-tag', message: 'A tag is made over what the body had when it was picked: the expectation is missing' }
      }

      const moved = movedSince(asked, same)

      if (moved) {
        return moved
      }
    }

    const edited = target ? same : entry
    const named = row && !same ? { type: 'body', id: row.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: scope.campaignId, branchId: scope.branchId } } : keptTarget(edited, context)
    const payload = { tag: tagTextOf(tag), target: named }
    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-tag', message: `The tag is not valid: ${problems.join('; ')}` }
    }

    if (!edited) {
      // The expectation is checked again inside the write, over the tags stored when it is made, so another window's write between the read above and the swap is a refusal and not a second tag of the body.
      const precondition = (listed) => {
        const moved = movedSince(asked, matchOf(listed.filter((item) => !isUnreadable(item)).map((item) => entryOf(item, context)), row))

        if (moved) {
          throw new TagMoved(moved)
        }
      }

      try {
        return { ok: true, record: repository.create(scope, { kind: TAG_KIND, policy: 'branch', links: [{ type: 'body', id: row.id, row }], assumptions: [...ASSUMPTIONS], payload, context: context || undefined, precondition }), unchanged: false }
      } catch (error) {
        if (error && error.name === 'TagMoved') {
          return error.refusal
        }

        throw error
      }
    }

    if (edited.tag === payload.tag) {
      return { ok: true, record: null, unchanged: true }
    }

    try {
      return { ok: true, record: repository.update(scope, edited.uuid, edited.revision, { payload, assumptions: [...ASSUMPTIONS] }), unchanged: false }
    } catch (error) {
      if (target && error && error.name === 'RecordsRefused' && error.code === 'not-found') {
        return movedSince(asked, null)
      }

      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      return { ...conflict(error), stored: copyOf(error.stored.payload) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Clears a tag: deletes its record over the revision the entry was read at. A stale revision is refused and nothing is deleted.
export const clearTag = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'tag')

    if (!allowed.ok) {
      return allowed
    }

    try {
      return { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) }
    } catch (error) {
      if (error && error.name === 'RevisionConflict') {
        return conflict(error)
      }

      throw error
    }
  } catch (error) {
    return failure(error)
  }
}
