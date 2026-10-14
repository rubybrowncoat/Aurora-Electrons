// The campaign-local repository of the planners' typed records (scenarios, notes): what a planner keeps so that a plan survives a restart, a reload of the save and a rewind, without leaking into another campaign or race. A record belongs to a campaign and a race, never to a GameID or a file path (utilities/campaign.js decides which campaign an opened save is), is typed by an adapter of the planner that owns it, and is never a page's preference key. The repository writes only its own files, one per campaign (`scenarios/campaign-<campaignId>.json`), and never a save or a game order. See docs/plans/backlog/evidence/AE-033-03.md.
//
// The file: `{ version, records: { [uuid]: record }, tombstones: { [uuid]: { revision, deletedAt } } }` (an absent file is an empty one, an absent `tombstones` is none). A record is `{ uuid, kind, schema, payload, campaignId, RaceID, association: { policy, branchId }, base: { branchId, gameTime, ... }, createdAt, updatedAt, revision, versions, assumptions, links: [{ type, id, fingerprint }], provenance }`. A uuid is canonical lowercase UUID text, so it is always a safe own key of the map. `uuid`, `kind`, `campaignId`, `RaceID`, `createdAt` and `provenance` never change; `schema` is the version of the adapter's payload; `base` is the save the record was made against; `versions` are the capability and rule versions the adapter states for the payload; `assumptions` are what the planner took as given; `provenance` says how the record came to be ({ via: 'created' | 'clone' | 'import' | 'adopt', from, at }, with `reconciled` entries when an edit was reconciled). A deleted record leaves a tombstone (its uuid and last revision): a uuid is never issued, cloned, imported or kept again once it has been used in the file, so no revision of a uuid repeats and an edit or delete prepared against a record that was deleted (and perhaps restored from an export) can never land on a newer incarnation of it.
//
// Storage is injected as `storage.open(campaignId)`, a store with `.store` and `.update(change)` (the store client's whole-file compare-and-swap, src/preload/store-client.js), so the rules run on in-memory stores in a check. Every write is one `update`: the change is made over what is stored when the write lands, and made again when another window wrote in between, so two windows never lose each other's writes. A change that throws writes nothing. The browser build's stand-in for the store (scripts/web/shims/electron-store.js) has no such compare-and-swap between tabs, so its storage (`createScenarioStorage`) lets one tab at a time write a campaign's file: the tab holding a Web Lock named for the file (`await writable(campaignId)` asks for it; a tab that waits only reads), every other write is refused with the code 'not-owner'; a browser with no Web Locks writes nothing. In Electron every window writes, through the main process.
//
// Visibility. Every call names a scope `{ campaignId, RaceID, branchId, gameTime }`, the campaign, the race and the branch and game time of the open save. A record is visible to a scope only in the file of its campaign and only for its own RaceID (an integer, never coerced); another race's or campaign's record is not found, whatever its uuid. A record with the policy 'branch' is visible only on the branch it is associated with; one with the policy 'campaign' is visible on every branch of the campaign. A record that is not visible is not found by read, update, clone, delete and export either.
//
// Rewinds and branches. A visible record whose base game time is after the open save's game time is `ahead` (the save was rewound, or the branch was forked before the record's save): it is listed and flagged, never applied as current. A record whose base branch is not the open branch carries the flag `other-branch`. Nothing is moved, merged or re-associated by the repository on a rewind or a fork.
//
// Links. A link names a typed save object by its local ID and the fingerprint the adapter gave the object's row when the link was made. Against the open save (`context`, which the adapter reads) a link is `linked` (the object is there and its fingerprint is the stored one), `missing` (the adapter finds no object under that ID) or `changed` (an object is there and its fingerprint differs: an ID reused after a reload or a rewind) or `unknown` (no context, `null` or none, or no resolver, or the resolver failed). The status is derived on every read and never stored, and a link is never rebound: a missing or changed link stays on the record as it was, inspectable as unresolved (`unresolved`, the flags `missing-link` and `changed-link`), until an edit replaces the links explicitly.
//
// Edits. `update(scope, uuid, expectedRevision, patch)` is refused with a RevisionConflict that carries the stored record when `expectedRevision` is not the stored revision; nothing is overwritten. `reconcile(scope, conflict, patch)` is the explicit path: the caller reads the stored record the conflict carries, decides, and the patch is applied over exactly that revision (and conflicts again if the record moved on); the stale revision is kept in `provenance.reconciled`. A delete names the revision too.
//
// Adapters own the payload: the repository refuses a payload its adapter rejects, a kind with no adapter, and a payload that is not plain JSON, and it changes a stored payload only by the adapter's `migrate` (from an older schema) on an edit; a record of a newer schema than the adapter, or of an unknown kind, is listed with a flag, its payload untouched, and cannot be edited.
//
// Versions. The file's `version` has migrations (`MIGRATIONS`, version 0 being a list of records pinned to a branch with no revision, links or versions); a read migrates in memory and a write stores the migrated file, payload and provenance of each record exactly as they were. A file of a newer version, or one whose shape is not what this module writes (or whose records name another campaign), is refused with a reason (RecordsRefused 'newer-version' or 'damaged'), never read as empty and never written over.
//
// Import and export. `exportRecords` gives a portable bundle of the records visible to a scope with its provenance. `previewImport(bundle, target)` shows what an import would do and writes nothing; `importRecords(bundle, target, { preview })` needs an explicit target `{ campaignId, RaceID, branch }` and the preview of that very bundle and target. Imported records take the target's campaign, race and branch and a new uuid (the bundle's uuid is kept only when the caller asks for it and the file of the target campaign has never held it, as a record or a tombstone; the preview says which), keep their base, versions and links as they were, and record where they came from; an imported link is resolved against the target's save like any other, so an object that is not the same there is `missing` or `changed`, never rebound.
//
// Attached campaigns. When the player attaches a campaign to another (utilities/campaign-attach.js marks the source `mergedInto` in the registry), the source's records stay in the source's own file and are never moved by the attachment. The repository reads the registry (`storage.registry()`, read only, accepted only as far as the campaign module's own reader accepts it) and `listAttached(scope)` lists, apart from `list`, the records of the race in every campaign merged into the open one, directly or through a chain, flagged `attached-campaign` and never mixed into `list` or `exportRecords`; a source file that cannot be read (damaged, newer, or a failed read of the store) is reported in `refused`, not skipped, and does not stop the other sources from being listed. `adopt(scope, sourceCampaignId, uuid)` is the explicit step: it copies one such record into the open campaign as a new record on the open branch, with a new uuid and the provenance of the source, and leaves the source untouched (the source's branches are not the open campaign's branches, so a copy is pinned to the branch that adopts it, never to a guessed one); a source record has one live adopted copy at a time (adopting it again is refused while the copy exists, and allowed once the copy was deleted).
//
// Limits. The browser's write lock is per campaign file, so tabs on different saves of one campaign share it, and a tab holds it until `release` or until its document ends. A deleted uuid's tombstone is kept for good, so the file grows by one small entry for each record ever deleted: that is the cost of never issuing a uuid again.

import Config from 'electron-store'
import { readRegistry } from './campaign'

export const FILE_VERSION = 1
export const BUNDLE_FORMAT = 'aurora-scenario-records'
export const BUNDLE_VERSION = 1
export const SCENARIO_FOLDER = 'scenarios'
export const POLICIES = ['campaign', 'branch']
export const LINK_STATUSES = ['linked', 'missing', 'changed', 'unknown']

const SEGMENT = /^[A-Za-z0-9_-]+$/
const KIND = /^[A-Za-z0-9_.:-]+$/
const EDITABLE = ['payload', 'links', 'assumptions', 'policy', 'rebase']
const UNSAFE_KEYS = ['__proto__']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REGISTRY_FOLDER = 'history'
const REGISTRY_NAME = 'campaigns'
const LOCK_PREFIX = 'aurora-electrons:scenario-records:'
const GRACE = 2000

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]'

const isText = (value) => typeof value === 'string' && value !== ''

const isSegment = (value) => typeof value === 'string' && SEGMENT.test(value)

const isUuid = (value) => typeof value === 'string' && UUID.test(value)

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const isCount = (value) => Number.isInteger(value) && value >= 1

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// Puts `value` at `key` of a map as an own data property, whatever the key is.
const define = (map, key, value) => {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true })
}

// Whether a value survives a round trip through JSON unchanged: plain objects and lists of strings, finite numbers, booleans and null.
const isJson = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.every(isJson)
  }

  return isObject(value) && Object.keys(value).every((key) => !UNSAFE_KEYS.includes(key) && isJson(value[key]))
}

// A short text of a text, for the check that an import is the one that was previewed: two 32-bit mixing passes, 16 hex digits. Evidence of equality, not a security hash.
const digestOf = (text) => {
  let a = 2166136261
  let b = 5381

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    a = Math.imul(a ^ code, 16777619)
    b = Math.imul(b, 33) ^ code
  }

  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

// What an import preview is bound to: the bundle, the target and the choice of uuids; the restore policy adds a marker so a preview of another policy never matches.
const importKey = (bundle, target, keepUuids, restore) => JSON.stringify(restore ? [bundle, target, !!keepUuids, 'restore'] : [bundle, target, !!keepUuids])

const randomId = () => globalThis.crypto.randomUUID()

const oldestFirst = (a, b) => a.createdAt - b.createdAt || (a.uuid < b.uuid ? -1 : 1)

// ---- Errors --------------------------------------------------------------------------------------------------------

// A call the repository refuses, with nothing written. `code` is one of: 'invalid-scope', 'invalid-target', 'invalid-bundle', 'invalid-record', 'invalid-payload', 'invalid-adapter', 'no-adapter', 'unsupported-schema', 'not-found', 'collision', 'preview-required', 'preview-mismatch', 'damaged' (the file is not what this module writes), 'newer-version' (the file was written by a newer version), 'registry-unreadable' (the campaign registry cannot be read, so the attached campaigns are not known) and 'not-owner' (this tab may not write the file: another tab holds it, or the browser has no Web Locks).
export class RecordsRefused extends Error {
  constructor (code, message, detail = {}) {
    super(message)
    this.name = 'RecordsRefused'
    this.code = code
    Object.assign(this, detail)
  }
}

// An edit or a delete made against a revision that is not the stored one. `stored` is a copy of the record as stored; nothing was written.
export class RevisionConflict extends Error {
  constructor (stored, expectedRevision) {
    super(`The record was changed since it was read (it is at revision ${stored.revision}, the edit was made against revision ${expectedRevision}), so nothing was written`)
    this.name = 'RevisionConflict'
    this.code = 'revision-conflict'
    this.stored = stored
    this.expectedRevision = expectedRevision
  }
}

const refuse = (code, message, detail) => new RecordsRefused(code, message, detail)

const damaged = (campaignId, what) => refuse('damaged', `The scenario records of campaign ${campaignId} are damaged (${what}), so nothing was read or written and the file was left as it is`)

// ---- Adapters ------------------------------------------------------------------------------------------------------

// The adapters of the planners: { kind, schema, validate(payload), migrate(payload, fromSchema), fingerprint(type, row), resolve(links, context), versions }. `validate` returns the list of problems with a payload (empty when it is valid; `true` also says valid); `migrate` brings a payload of an older schema to `schema` (required when schema is above 1); `fingerprint` is a text that names what a row of a typed save object is, so a reused ID tells; `resolve` gives, for each link in order, the object's current row or null when the save has none (`fingerprint` and `resolve` come together); `versions` (an object, or a function of the payload) states the capability and rule versions a payload rests on.
export const createAdapterRegistry = () => {
  const adapters = new Map()

  return {
    register (adapter) {
      const problems = []
      const isFunction = (value) => typeof value === 'function'

      if (!isObject(adapter)) {
        throw refuse('invalid-adapter', 'An adapter is an object')
      }

      if (!isText(adapter.kind) || !KIND.test(adapter.kind)) {
        problems.push('kind')
      }

      if (!isCount(adapter.schema)) {
        problems.push('schema')
      }

      if (!isFunction(adapter.validate)) {
        problems.push('validate')
      }

      if (isCount(adapter.schema) && adapter.schema > 1 ? !isFunction(adapter.migrate) : adapter.migrate !== undefined && !isFunction(adapter.migrate)) {
        problems.push('migrate')
      }

      if (isFunction(adapter.fingerprint) !== isFunction(adapter.resolve) || (adapter.fingerprint !== undefined && !isFunction(adapter.fingerprint)) || (adapter.resolve !== undefined && !isFunction(adapter.resolve))) {
        problems.push('fingerprint and resolve')
      }

      if (adapter.versions !== undefined && !isFunction(adapter.versions) && !(isObject(adapter.versions) && isJson(adapter.versions))) {
        problems.push('versions')
      }

      if (problems.length) {
        throw refuse('invalid-adapter', `The adapter ${String(adapter.kind)} is not registered: ${problems.join(', ')} not valid`)
      }

      if (adapters.has(adapter.kind)) {
        throw refuse('invalid-adapter', `The adapter ${adapter.kind} is registered already`)
      }

      adapters.set(adapter.kind, Object.freeze({ ...adapter }))

      return adapters.get(adapter.kind)
    },
    get: (kind) => (typeof kind === 'string' && adapters.has(kind) ? adapters.get(kind) : null),
    kinds: () => [...adapters.keys()],
  }
}

const defaultAdapters = createAdapterRegistry()

// Registers an adapter with the app's own registry, the one `openScenarioRecords` uses.
export const registerAdapter = (adapter) => defaultAdapters.register(adapter)

const problemsOf = (adapter, payload) => {
  let result

  try {
    result = adapter.validate(copy(payload))
  } catch (error) {
    return [`the validation failed (${error && error.message ? error.message : String(error)})`]
  }

  if (result === true) {
    return []
  }

  if (Array.isArray(result)) {
    return result.map(String)
  }

  return [typeof result === 'string' && result !== '' ? result : 'it was not accepted']
}

const checkedPayload = (adapter, payload) => {
  if (!isObject(payload) || !isJson(payload)) {
    throw refuse('invalid-payload', `A ${adapter.kind} payload is a plain JSON object`)
  }

  const problems = problemsOf(adapter, payload)

  if (problems.length) {
    throw refuse('invalid-payload', `The ${adapter.kind} adapter refused the payload: ${problems.join('; ')}`, { problems })
  }

  return copy(payload)
}

const versionsOf = (adapter, payload) => {
  const stated = typeof adapter.versions === 'function' ? adapter.versions(copy(payload)) : (adapter.versions === undefined ? {} : adapter.versions)

  if (!isObject(stated) || !isJson(stated)) {
    throw refuse('invalid-adapter', `The ${adapter.kind} adapter's versions are a plain JSON object`)
  }

  return copy(stated)
}

// The links a record is given: each { type, id, fingerprint } or { type, id, row } (the fingerprint is the adapter's of the row).
const normalizedLinks = (adapter, links) => {
  if (!Array.isArray(links)) {
    throw refuse('invalid-record', 'The links of a record are a list')
  }

  const seen = new Set()

  return links.map((link) => {
    if (!isObject(link) || !isText(link.type) || !(isText(link.id) || isNumber(link.id))) {
      throw refuse('invalid-record', 'A link is { type, id, fingerprint }')
    }

    const key = `${link.type}\u0000${typeof link.id}\u0000${link.id}`

    if (seen.has(key)) {
      throw refuse('invalid-record', `The link ${link.type} ${link.id} is given twice`)
    }

    seen.add(key)

    let fingerprint = link.fingerprint

    if (fingerprint === undefined && link.row !== undefined) {
      if (typeof adapter.fingerprint !== 'function') {
        throw refuse('invalid-record', `The ${adapter.kind} adapter fingerprints no row, so a link is given with its fingerprint`)
      }

      fingerprint = adapter.fingerprint(link.type, copy(link.row))
    }

    if (!isText(fingerprint)) {
      throw refuse('invalid-record', `The link ${link.type} ${link.id} has no fingerprint`)
    }

    return { type: link.type, id: link.id, fingerprint }
  })
}

// Each link of a record against the open save: the link as stored with `status` ('linked', 'missing', 'changed' or 'unknown') and, when an object is there, `current` (its fingerprint now). Nothing is stored and no link is changed.
const resolvedLinks = (adapter, record, context) => {
  const unknown = (reason) => record.links.map((link) => ({ ...copy(link), status: 'unknown', reason }))

  if (!record.links.length) {
    return []
  }

  if (!adapter || typeof adapter.resolve !== 'function' || typeof adapter.fingerprint !== 'function') {
    return unknown('the adapter does not resolve links')
  }

  if (context === undefined || context === null) {
    return unknown('no save was given to resolve the links against')
  }

  let rows

  try {
    rows = adapter.resolve(copy(record.links), context)
  } catch (error) {
    return unknown(`the links could not be resolved (${error && error.message ? error.message : String(error)})`)
  }

  if (!Array.isArray(rows) || rows.length !== record.links.length) {
    return unknown('the adapter did not answer for every link')
  }

  return record.links.map((link, index) => {
    const row = rows[index]

    if (row === null || row === undefined) {
      return { ...copy(link), status: 'missing' }
    }

    try {
      const current = adapter.fingerprint(link.type, row)

      return { ...copy(link), status: current === link.fingerprint ? 'linked' : 'changed', current }
    } catch (error) {
      return { ...copy(link), status: 'unknown', reason: `the object could not be fingerprinted (${error && error.message ? error.message : String(error)})` }
    }
  })
}

// ---- The file ------------------------------------------------------------------------------------------------------

const linkShapeOk = (link) => isObject(link) && isText(link.type) && (isText(link.id) || isNumber(link.id)) && isText(link.fingerprint)

// The fields of a record that are not what this module writes, as a list. `key`, `campaignId` default to the record's own (a record of a bundle, whose campaign is the source's).
const recordProblems = (record, key = record && record.uuid, campaignId = record && record.campaignId) => {
  if (!isObject(record)) {
    return ['it is not an object']
  }

  const problems = []
  const need = (ok, field) => {
    if (!ok) {
      problems.push(field)
    }
  }

  need(isUuid(record.uuid) && record.uuid === key, 'uuid')
  need(isText(record.kind) && KIND.test(record.kind), 'kind')
  need(isCount(record.schema), 'schema')
  need(isObject(record.payload) && isJson(record.payload), 'payload')
  need(isSegment(record.campaignId) && record.campaignId === campaignId, 'campaignId')
  need(Number.isInteger(record.RaceID), 'RaceID')
  need(isObject(record.association) && POLICIES.includes(record.association.policy) && isText(record.association.branchId), 'association')
  need(isObject(record.base) && isText(record.base.branchId) && isNumber(record.base.gameTime) && isJson(record.base), 'base')
  need(isNumber(record.createdAt) && isNumber(record.updatedAt), 'createdAt, updatedAt')
  need(isCount(record.revision), 'revision')
  need(isObject(record.versions) && isJson(record.versions), 'versions')
  need(Array.isArray(record.assumptions) && isJson(record.assumptions), 'assumptions')
  need(Array.isArray(record.links) && record.links.every(linkShapeOk), 'links')
  need(isObject(record.provenance) && isText(record.provenance.via) && isJson(record.provenance), 'provenance')

  return problems
}

// What a version-0 record holds (the earliest shape: a list of records pinned to the branch they were made on, with no revision, links, versions or assumptions).
const v0Problems = (old) => {
  if (!isObject(old)) {
    return ['it is not an object']
  }

  const problems = []
  const need = (ok, field) => {
    if (!ok) {
      problems.push(field)
    }
  }

  need(isUuid(old.uuid), 'uuid')
  need(isText(old.kind) && KIND.test(old.kind), 'kind')
  need(isCount(old.schema), 'schema')
  need(isObject(old.payload) && isJson(old.payload), 'payload')
  need(isSegment(old.campaignId), 'campaignId')
  need(Number.isInteger(old.RaceID), 'RaceID')
  need(isText(old.branchId), 'branchId')
  need(isNumber(old.gameTime), 'gameTime')
  need(isNumber(old.createdAt) && isNumber(old.updatedAt), 'createdAt, updatedAt')
  need(isObject(old.provenance) && isText(old.provenance.via) && isJson(old.provenance), 'provenance')

  return problems
}

// The migrations of the file, each from its version to the next. Version 0: `{ version: 0, records: [{ uuid, kind, schema, payload, campaignId, RaceID, branchId, gameTime, createdAt, updatedAt, provenance }] }`. A version-0 record was made on a branch and is kept there (policy 'branch'), so the migration never widens where it shows; its payload and provenance are carried over as they are.
export const MIGRATIONS = {
  0: (file, campaignId) => {
    if (!Array.isArray(file.records)) {
      throw damaged(campaignId, 'the records of version 0 are not a list')
    }

    const records = {}

    file.records.forEach((old, index) => {
      const problems = v0Problems(old)

      if (problems.length) {
        throw damaged(campaignId, `record ${index} of version 0: ${problems.join(', ')} not valid`)
      }

      if (has(records, old.uuid)) {
        throw damaged(campaignId, `the uuid ${old.uuid} repeats`)
      }

      define(records, old.uuid, {
        uuid: old.uuid,
        kind: old.kind,
        schema: old.schema,
        payload: copy(old.payload),
        campaignId: old.campaignId,
        RaceID: old.RaceID,
        association: { policy: 'branch', branchId: old.branchId },
        base: { branchId: old.branchId, gameTime: old.gameTime },
        createdAt: old.createdAt,
        updatedAt: old.updatedAt,
        revision: 1,
        versions: {},
        assumptions: [],
        links: [],
        provenance: copy(old.provenance),
      })
    })

    return { version: 1, records, tombstones: {}, migrated: [...(Array.isArray(file.migrated) ? file.migrated : []), { from: 0, to: 1 }] }
  },
}

// The stored file as the current version, or a refusal. Nothing is written: an absent (empty) file is an empty current one, an older one is migrated in memory, a newer or damaged one is refused.
const prepared = (stored, campaignId) => {
  if (!isObject(stored)) {
    throw damaged(campaignId, 'it is not an object')
  }

  if (Object.keys(stored).length === 0) {
    return { version: FILE_VERSION, records: {}, tombstones: {} }
  }

  if (!Number.isInteger(stored.version) || stored.version < 0) {
    throw damaged(campaignId, 'it has no version')
  }

  if (stored.version > FILE_VERSION) {
    throw refuse('newer-version', `The scenario records of campaign ${campaignId} were written by a newer version of the app (file version ${stored.version}; this one reads up to ${FILE_VERSION}), so nothing was read or written and the file was left as it is`, { version: stored.version })
  }

  let file = copy(stored)

  while (file.version < FILE_VERSION) {
    file = MIGRATIONS[file.version](file, campaignId)
  }

  if (!isObject(file.records) || (file.migrated !== undefined && !Array.isArray(file.migrated))) {
    throw damaged(campaignId, 'its records are not a map')
  }

  if (file.tombstones === undefined) {
    file.tombstones = {}
  }

  if (!isObject(file.tombstones)) {
    throw damaged(campaignId, 'its tombstones are not a map')
  }

  Object.entries(file.tombstones).forEach(([key, tombstone]) => {
    if (!isUuid(key) || !isObject(tombstone) || !isCount(tombstone.revision) || !isNumber(tombstone.deletedAt)) {
      throw damaged(campaignId, `tombstone ${key} is not valid`)
    }

    if (has(file.records, key)) {
      throw damaged(campaignId, `the uuid ${key} is both a record and a tombstone`)
    }
  })

  Object.entries(file.records).forEach(([key, record]) => {
    const problems = recordProblems(record, key, campaignId)

    if (problems.length) {
      throw damaged(campaignId, `record ${key}: ${problems.join(', ')} not valid`)
    }
  })

  return file
}

// ---- Visibility ----------------------------------------------------------------------------------------------------

const scopeOf = (scope) => {
  const problems = []

  if (!isObject(scope)) {
    throw refuse('invalid-scope', 'A call names its scope { campaignId, RaceID, branchId, gameTime }')
  }

  if (!isSegment(scope.campaignId)) {
    problems.push('campaignId')
  }

  if (!Number.isInteger(scope.RaceID)) {
    problems.push('RaceID')
  }

  if (!isText(scope.branchId)) {
    problems.push('branchId')
  }

  if (!isNumber(scope.gameTime)) {
    problems.push('gameTime')
  }

  if (problems.length) {
    throw refuse('invalid-scope', `The scope is not valid: ${problems.join(', ')}`)
  }

  return { campaignId: scope.campaignId, RaceID: scope.RaceID, branchId: scope.branchId, gameTime: scope.gameTime }
}

const visible = (record, scope) => record.campaignId === scope.campaignId && record.RaceID === scope.RaceID && (record.association.policy === 'campaign' || record.association.branchId === scope.branchId)

const locate = (file, scope, uuid) => {
  const record = typeof uuid === 'string' && has(file.records, uuid) ? file.records[uuid] : null

  if (!record || !visible(record, scope)) {
    throw refuse('not-found', `No record ${String(uuid)} is visible to campaign ${scope.campaignId}, race ${scope.RaceID}, branch ${scope.branchId}`)
  }

  return record
}

// ---- The repository ------------------------------------------------------------------------------------------------

const targetOf = (target) => {
  if (!isObject(target) || !isSegment(target.campaignId) || !Number.isInteger(target.RaceID) || !isText(target.branch)) {
    throw refuse('invalid-target', 'An import names its target { campaignId, RaceID, branch }')
  }

  return { campaignId: target.campaignId, RaceID: target.RaceID, branch: target.branch }
}

const bundleOf = (bundle) => {
  if (!isObject(bundle) || bundle.format !== BUNDLE_FORMAT) {
    throw refuse('invalid-bundle', 'This is not a bundle of scenario records')
  }

  if (!Number.isInteger(bundle.version) || bundle.version < 1 || bundle.version > BUNDLE_VERSION) {
    throw refuse('invalid-bundle', `The bundle is of version ${String(bundle.version)}; this version of the app reads version ${BUNDLE_VERSION}`)
  }

  if (!Array.isArray(bundle.records)) {
    throw refuse('invalid-bundle', 'The bundle holds no list of records')
  }

  return bundle
}

// The repository over `storage` (`storage.open(campaignId)` is a store with `.store` and `.update(change)`), the adapters of `adapters`, a source of uuids and a clock (milliseconds).
export const createRepository = ({ storage, adapters = defaultAdapters, newId = randomId, now = Date.now }) => {
  if (!storage || typeof storage.open !== 'function') {
    throw new TypeError('A repository needs storage.open(campaignId)')
  }

  const storeOf = (campaignId) => {
    const store = storage.open(campaignId)

    if (!store || typeof store.update !== 'function') {
      throw new TypeError('The store of a campaign needs update(change), the whole-file compare-and-swap')
    }

    return store
  }

  const adapterOf = (kind) => {
    const adapter = adapters.get(kind)

    if (!adapter) {
      throw refuse('no-adapter', `No adapter is registered for the kind ${String(kind)}`)
    }

    return adapter
  }

  const readFile = (campaignId) => prepared(storeOf(campaignId).store, campaignId)

  // One write: `work(file)` changes the migrated file in place and returns what the caller is told; it is run again over the file as stored when another window wrote between its read and its write, and a throw writes nothing.
  const transact = (campaignId, work) => {
    let outcome

    storeOf(campaignId).update((stored) => {
      const file = prepared(stored, campaignId)

      outcome = work(file)

      return file
    })

    return outcome
  }

  const freshId = (file) => {
    const uuid = newId()

    if (!isUuid(uuid) || has(file.records, uuid) || has(file.tombstones, uuid)) {
      throw refuse('collision', `The uuid ${String(uuid)} is not a new one`)
    }

    return uuid
  }

  // A record as a planner sees it: the stored record (a copy), the payload (migrated for the view when the adapter's schema is newer than the record's), where it stands against the open save and its links resolved.
  const entryOf = (record, scope, context) => {
    const adapter = adapters.get(record.kind)
    const flags = []
    let payload = copy(record.payload)

    if (!adapter) {
      flags.push('no-adapter')
    } else if (record.schema > adapter.schema) {
      flags.push('newer-schema')
    } else {
      try {
        if (record.schema < adapter.schema) {
          payload = copy(adapter.migrate(copy(record.payload), record.schema))
        }

        if (!isObject(payload) || !isJson(payload) || problemsOf(adapter, payload).length) {
          flags.push('invalid-payload')
        }
      } catch (error) {
        payload = copy(record.payload)
        flags.push('invalid-payload')
      }
    }

    const status = record.base.gameTime > scope.gameTime ? 'ahead' : 'current'

    if (status === 'ahead') {
      flags.push('ahead')
    }

    if (record.base.branchId !== scope.branchId) {
      flags.push('other-branch')
    }

    const links = resolvedLinks(adapter, record, context === undefined || context === null ? undefined : { ...context, campaignId: scope.campaignId, RaceID: scope.RaceID, branchId: scope.branchId, gameTime: scope.gameTime })
    const unresolved = links.filter((link) => link.status === 'missing' || link.status === 'changed').length

    if (links.some((link) => link.status === 'missing')) {
      flags.push('missing-link')
    }

    if (links.some((link) => link.status === 'changed')) {
      flags.push('changed-link')
    }

    return { record: copy(record), payload, status, flags, links, unresolved }
  }

  const applyEdit = (file, scope, uuid, expectedRevision, patch, { reconciled = null } = {}) => {
    const record = locate(file, scope, uuid)

    if (!Number.isInteger(expectedRevision)) {
      throw refuse('invalid-record', 'An edit names the revision it was made against')
    }

    if (record.revision !== expectedRevision) {
      throw new RevisionConflict(copy(record), expectedRevision)
    }

    const keys = isObject(patch) ? Object.keys(patch) : []
    const foreign = keys.filter((key) => !EDITABLE.includes(key))

    if (!keys.length || foreign.length) {
      throw refuse('invalid-record', foreign.length ? `${foreign.join(', ')} cannot be changed by an edit (editable: ${EDITABLE.join(', ')})` : 'An edit changes something')
    }

    const adapter = adapterOf(record.kind)

    if (record.schema > adapter.schema) {
      throw refuse('unsupported-schema', `The record is of schema ${record.schema}, newer than the ${record.kind} adapter's ${adapter.schema}, so it cannot be edited here`)
    }

    const next = copy(record)
    const migrates = record.schema < adapter.schema

    if (patch.payload !== undefined) {
      next.payload = checkedPayload(adapter, patch.payload)
    } else if (migrates) {
      next.payload = checkedPayload(adapter, adapter.migrate(copy(record.payload), record.schema))
    }

    if (patch.payload !== undefined || migrates) {
      next.schema = adapter.schema
      next.versions = versionsOf(adapter, next.payload)
    }

    if (patch.links !== undefined) {
      next.links = normalizedLinks(adapter, patch.links)
    }

    if (patch.assumptions !== undefined) {
      if (!Array.isArray(patch.assumptions) || !isJson(patch.assumptions)) {
        throw refuse('invalid-record', 'The assumptions of a record are a list of plain JSON')
      }

      next.assumptions = copy(patch.assumptions)
    }

    if (patch.policy !== undefined) {
      if (!POLICIES.includes(patch.policy)) {
        throw refuse('invalid-record', `The policy is one of ${POLICIES.join(', ')}`)
      }

      if (patch.policy === 'branch' && next.association.policy !== 'branch') {
        next.association = { policy: 'branch', branchId: scope.branchId }
      } else {
        next.association = { ...next.association, policy: patch.policy }
      }
    }

    if (patch.rebase === true) {
      next.base = { ...next.base, branchId: scope.branchId, gameTime: scope.gameTime }
      next.association = { ...next.association, branchId: scope.branchId }
    }

    next.updatedAt = now()
    next.revision = record.revision + 1

    if (reconciled) {
      next.provenance = { ...next.provenance, reconciled: [...(Array.isArray(next.provenance.reconciled) ? next.provenance.reconciled : []), reconciled] }
    }

    const problems = recordProblems(next, uuid, scope.campaignId)

    if (problems.length) {
      throw refuse('invalid-record', `The edit leaves the record not valid: ${problems.join(', ')}`)
    }

    file.records[uuid] = next

    return copy(next)
  }

  // The records of a bundle against a file: for each, whether it would be imported and under which uuid, and the payload an import would store. With `restore` a record whose uuid the file holds or held once is 'skipped' (never copied under a fresh uuid, never brought back) and every other record keeps its uuid. Writes nothing.
  const planImport = (file, bundle, target, keepUuids, restore = false) => {
    const seen = new Set()

    return bundle.records.map((record, index) => {
      const reasons = []
      let adapter = null
      let payload = null
      const migrated = []

      if (isObject(record)) {
        reasons.push(...recordProblems(record).map((field) => `${field} not valid`))
      } else {
        reasons.push('it is not an object')
      }

      const uuid = isObject(record) && typeof record.uuid === 'string' ? record.uuid : null

      if (uuid !== null) {
        if (seen.has(uuid)) {
          reasons.push('its uuid repeats in the bundle')
        }

        seen.add(uuid)
      }

      if (!reasons.length) {
        adapter = adapters.get(record.kind)

        if (!adapter) {
          reasons.push(`no adapter is registered for ${record.kind}`)
        } else if (record.schema > adapter.schema) {
          reasons.push(`its schema ${record.schema} is newer than the ${record.kind} adapter's ${adapter.schema}`)
        } else {
          try {
            payload = record.schema < adapter.schema ? copy(adapter.migrate(copy(record.payload), record.schema)) : copy(record.payload)

            if (record.schema < adapter.schema) {
              migrated.push(record.schema)
            }

            if (!isObject(payload) || !isJson(payload)) {
              reasons.push('its payload is not plain JSON after migration')
            } else {
              reasons.push(...problemsOf(adapter, payload).map((problem) => `the adapter refused the payload: ${problem}`))
            }
          } catch (error) {
            reasons.push(`its payload could not be migrated (${error && error.message ? error.message : String(error)})`)
          }
        }
      }

      const collides = uuid !== null && has(file.records, uuid)
      const tombstoned = uuid !== null && has(file.tombstones, uuid)
      const item = {
        index,
        uuid,
        kind: isObject(record) && typeof record.kind === 'string' ? record.kind : null,
        status: reasons.length ? 'rejected' : restore && (collides || tombstoned) ? 'skipped' : 'import',
        reasons,
        keepsUuid: (!!keepUuids || restore) && !collides && !tombstoned,
        collides,
        tombstoned,
        foreign: !isObject(record) || record.campaignId !== target.campaignId || record.RaceID !== target.RaceID,
        migratedFrom: migrated.length ? migrated[0] : null,
      }

      return { item, record, payload, adapter }
    })
  }

  // A planned import record (see planImport) as a new record of `target`: the target's campaign, race and branch, revision 1 and the given provenance.
  const materialized = ({ record, payload, adapter }, target, stamp, uuid, provenance) => ({
    ...copy(record),
    uuid,
    schema: adapter.schema,
    payload,
    campaignId: target.campaignId,
    RaceID: target.RaceID,
    association: { policy: record.association.policy, branchId: target.branch },
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
    provenance,
  })

  const unreadable = (campaignId, what) => refuse('registry-unreadable', `The campaign registry could not be read (${what}), so the campaigns attached to ${campaignId} are not known`)

  // The ids of the campaigns merged into `campaignId`, directly or through a chain, from the campaign registry (`storage.registry()`, read only; none when the storage has no registry). A registry the campaign module itself refuses (not an object, a version it does not read, a campaign or branch that is not complete) or whose `mergedInto` is not an id is refused, never read as empty.
  const attachedTo = (campaignId) => {
    if (typeof storage.registry !== 'function') {
      return []
    }

    let stored

    try {
      stored = storage.registry()
      readRegistry({ registry: { store: stored } })
    } catch (error) {
      throw unreadable(campaignId, error && error.message ? error.message : String(error))
    }

    const campaigns = stored.campaigns || {}

    Object.entries(campaigns).forEach(([id, entry]) => {
      const merged = isObject(entry) ? entry.mergedInto : undefined

      if (!isSegment(id) || !isObject(entry) || (merged !== undefined && merged !== null && !(isObject(merged) && isSegment(merged.campaignId)))) {
        throw unreadable(campaignId, `campaign ${id} is not complete`)
      }
    })

    const endOf = (id) => {
      const seen = new Set()
      let current = id

      while (has(campaigns, current) && campaigns[current].mergedInto) {
        if (seen.has(current)) {
          return null
        }

        seen.add(current)
        current = campaigns[current].mergedInto.campaignId
      }

      return current
    }

    return Object.keys(campaigns).filter((id) => id !== campaignId && campaigns[id].mergedInto && endOf(id) === campaignId)
  }

  return {
    // Whether this window may write the records of `campaignId`, waiting up to `grace` ms for it: always in Electron (every window writes, through the main process), in a browser tab only while it holds the Web Lock of the file (storage.writable). A planner asks before its first write; a write before it is granted is refused with the code 'not-owner'.
    writable (campaignId, grace) {
      scenarioFileName(campaignId)

      return typeof storage.writable === 'function' ? storage.writable(campaignId, grace) : Promise.resolve(true)
    },

    // A new record of `kind` made against the open save: { kind, payload, policy ('campaign' by default), links, assumptions, base (extra facts of the save) }.
    create (scope, { kind, payload, policy = 'campaign', links = [], assumptions = [], base = {} } = {}) {
      const s = scopeOf(scope)
      const adapter = adapterOf(kind)

      if (!POLICIES.includes(policy)) {
        throw refuse('invalid-record', `The policy is one of ${POLICIES.join(', ')}`)
      }

      if (!Array.isArray(assumptions) || !isJson(assumptions) || !isObject(base) || !isJson(base)) {
        throw refuse('invalid-record', 'The assumptions are a list and the base facts an object, of plain JSON')
      }

      const checked = checkedPayload(adapter, payload)
      const record = {
        uuid: null,
        kind: adapter.kind,
        schema: adapter.schema,
        payload: checked,
        campaignId: s.campaignId,
        RaceID: s.RaceID,
        association: { policy, branchId: s.branchId },
        base: { ...copy(base), branchId: s.branchId, gameTime: s.gameTime },
        createdAt: 0,
        updatedAt: 0,
        revision: 1,
        versions: versionsOf(adapter, checked),
        assumptions: copy(assumptions),
        links: normalizedLinks(adapter, links),
        provenance: { via: 'created' },
      }

      return transact(s.campaignId, (file) => {
        const stamp = now()
        const stored = { ...copy(record), uuid: freshId(file), createdAt: stamp, updatedAt: stamp }

        define(file.records, stored.uuid, stored)

        return copy(stored)
      })
    },

    // The record `uuid` as an entry (see `list`) when it is visible to the scope, else null. `context` is what the adapter resolves the links against.
    read (scope, uuid, { context } = {}) {
      const s = scopeOf(scope)
      const file = readFile(s.campaignId)
      const record = typeof uuid === 'string' && has(file.records, uuid) ? file.records[uuid] : null

      return record && visible(record, s) ? entryOf(record, s, context) : null
    },

    // The records visible to the scope as entries `{ record, payload, status ('current' or 'ahead'), flags, links, unresolved }`, oldest first. `kind` and `status` narrow the list; `context` is what the adapters resolve the links against.
    list (scope, { kind, status, context } = {}) {
      const s = scopeOf(scope)
      const file = readFile(s.campaignId)

      return Object.values(file.records).filter((record) => visible(record, s) && (kind === undefined || record.kind === kind)).sort(oldestFirst).map((record) => entryOf(record, s, context)).filter((entry) => status === undefined || entry.status === status)
    },

    // Changes a record made against `expectedRevision`: `patch` is { payload, links, assumptions, policy, rebase }; `rebase: true` moves the record's base to the open save. A stale revision throws a RevisionConflict and writes nothing.
    update (scope, uuid, expectedRevision, patch) {
      const s = scopeOf(scope)

      return transact(s.campaignId, (file) => applyEdit(file, s, uuid, expectedRevision, patch))
    },

    // The explicit way out of a RevisionConflict: `patch` is applied over exactly the revision the conflict carries.
    reconcile (scope, conflict, patch) {
      const s = scopeOf(scope)

      if (!(conflict instanceof RevisionConflict) || conflict.stored.campaignId !== s.campaignId) {
        throw refuse('invalid-record', 'A reconcile answers a revision conflict of this campaign')
      }

      return transact(s.campaignId, (file) => applyEdit(file, s, conflict.stored.uuid, conflict.stored.revision, patch, { reconciled: { staleRevision: conflict.expectedRevision, over: conflict.stored.revision, at: now() } }))
    },

    // A copy of a visible record under a new uuid, revision 1, with the provenance of its source; it keeps the source's base and association unless `rebase` moves them to the open save.
    clone (scope, uuid, { rebase = false } = {}) {
      const s = scopeOf(scope)

      return transact(s.campaignId, (file) => {
        const source = locate(file, s, uuid)
        const stamp = now()
        const stored = {
          ...copy(source),
          uuid: freshId(file),
          createdAt: stamp,
          updatedAt: stamp,
          revision: 1,
          provenance: { via: 'clone', at: stamp, from: { uuid: source.uuid, revision: source.revision, createdAt: source.createdAt, base: copy(source.base), via: source.provenance.via } },
        }

        if (rebase === true) {
          stored.base = { ...stored.base, branchId: s.branchId, gameTime: s.gameTime }
          stored.association = { ...stored.association, branchId: s.branchId }
        }

        define(file.records, stored.uuid, stored)

        return copy(stored)
      })
    },

    // Deletes a visible record made against `expectedRevision` (a stale one throws a RevisionConflict); returns the record as it was.
    delete (scope, uuid, expectedRevision) {
      const s = scopeOf(scope)

      return transact(s.campaignId, (file) => {
        const record = locate(file, s, uuid)

        if (!Number.isInteger(expectedRevision)) {
          throw refuse('invalid-record', 'A delete names the revision it was made against')
        }

        if (record.revision !== expectedRevision) {
          throw new RevisionConflict(copy(record), expectedRevision)
        }

        define(file.tombstones, uuid, { revision: record.revision, deletedAt: now() })
        delete file.records[uuid]

        return copy(record)
      })
    },

    // A portable bundle of the records visible to the scope, as stored, with the scope they were exported from. `selection` is { uuids, kind }: the uuids must all be visible, and `kind` narrows the rest.
    exportRecords (scope, selection = {}) {
      const s = scopeOf(scope)
      const file = readFile(s.campaignId)
      const wanted = isObject(selection) && Array.isArray(selection.uuids) ? selection.uuids : null

      if (wanted) {
        wanted.forEach((uuid) => locate(file, s, uuid))
      }

      const records = Object.values(file.records).filter((record) => visible(record, s) && (!wanted || wanted.includes(record.uuid)) && (!isObject(selection) || selection.kind === undefined || record.kind === selection.kind)).sort(oldestFirst)

      return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now(), source: { campaignId: s.campaignId, RaceID: s.RaceID, branchId: s.branchId, gameTime: s.gameTime }, records: copy(records) }
    },

    // What importing the bundle into `target` ({ campaignId, RaceID, branch }, always explicit) would do: `{ target, digest, keepUuids, restore, items, importable, rejected }`, an item being { index, uuid, kind, status ('import', 'rejected', or under `restore` 'skipped'), reasons, keepsUuid, collides (the target's file holds the uuid), tombstoned (it held it once, so a kept uuid is never reused), foreign, migratedFrom }. `restore` is the policy of putting a record back from a backup: a record keeps its uuid, unless the file holds that uuid or held it once, when it is skipped. Writes nothing.
    previewImport (bundle, target, { keepUuids = false, restore = false } = {}) {
      const b = bundleOf(bundle)
      const t = targetOf(target)
      const plan = planImport(readFile(t.campaignId), b, t, keepUuids, restore)

      return {
        target: t,
        digest: digestOf(importKey(b, t, keepUuids, restore)),
        keepUuids: !!keepUuids,
        restore: !!restore,
        items: plan.map((entry) => entry.item),
        importable: plan.filter((entry) => entry.item.status === 'import').length,
        rejected: plan.filter((entry) => entry.item.status === 'rejected').length,
      }
    },

    // Imports the records of the bundle that the preview of this very bundle and target said could be, as new records of the target's campaign, race and branch; returns { imported, rejected, ids: [{ from, to }] }. Nothing is imported without an explicit target and its preview. With `restore` the records the file holds or held are skipped as the file is at the time of the import, not as it was at the preview.
    importRecords (bundle, target, { preview, keepUuids = false, restore = false } = {}) {
      const b = bundleOf(bundle)
      const t = targetOf(target)

      if (!isObject(preview) || typeof preview.digest !== 'string') {
        throw refuse('preview-required', 'An import is made from the preview of the same bundle and target')
      }

      if (preview.digest !== digestOf(importKey(b, t, keepUuids, restore))) {
        throw refuse('preview-mismatch', 'The preview is not of this bundle, target and choice of uuids')
      }

      return transact(t.campaignId, (file) => {
        const plan = planImport(file, b, t, keepUuids, restore)
        const stamp = now()
        const imported = []
        const ids = []

        plan.filter((entry) => entry.item.status === 'import').forEach((entry) => {
          const { item, record } = entry
          const uuid = item.keepsUuid ? record.uuid : freshId(file)
          const stored = materialized(entry, t, stamp, uuid, { via: 'import', at: stamp, from: { uuid: record.uuid, campaignId: record.campaignId, RaceID: record.RaceID, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, association: copy(record.association), exportedAt: b.exportedAt === undefined ? null : b.exportedAt, source: b.source === undefined ? null : copy(b.source) } })

          define(file.records, uuid, stored)
          imported.push(copy(stored))
          ids.push({ from: record.uuid, to: uuid })
        })

        return { imported, rejected: plan.filter((entry) => entry.item.status === 'rejected').map((entry) => entry.item), ids }
      })
    },

    // The records of the scope's race in the campaigns merged into the open campaign, apart from `list`: `{ entries, refused }`. An entry is as in `list`, with the flag 'attached-campaign' and `attachedFrom`, the source campaign's id; its association names the source's branches, which are not the open campaign's, so none of it is applied by the open save. `refused` is the source files that could not be read, { campaignId, file, code, message } (code 'unreadable' when the store itself failed to read the file, the store's message kept), never skipped.
    listAttached (scope, { kind, status, context } = {}) {
      const s = scopeOf(scope)
      const entries = []
      const refused = []

      attachedTo(s.campaignId).forEach((source) => {
        let file

        try {
          file = readFile(source)
        } catch (error) {
          refused.push({ campaignId: source, file: scenarioFileName(source), code: error instanceof RecordsRefused ? error.code : 'unreadable', message: error && error.message ? error.message : String(error) })

          return
        }

        Object.values(file.records).filter((record) => record.RaceID === s.RaceID && (kind === undefined || record.kind === kind)).sort(oldestFirst).forEach((record) => {
          const entry = entryOf(record, s, context)

          entry.flags.push('attached-campaign')
          entries.push({ ...entry, attachedFrom: source })
        })
      })

      return { entries: entries.filter((entry) => status === undefined || entry.status === status), refused }
    },

    // Copies one record of a campaign merged into the open one into the open campaign: a new record of the scope's race on the scope's branch (the policy is kept), with a new uuid, revision 1 and `provenance: { via: 'adopt', from }`. The source is left as it is, one live copy of a source record exists at a time (a copy that was deleted can be made again), and a record its adapter rejects is not adopted.
    adopt (scope, sourceCampaignId, uuid) {
      const s = scopeOf(scope)

      if (!attachedTo(s.campaignId).includes(sourceCampaignId)) {
        throw refuse('not-found', `Campaign ${String(sourceCampaignId)} is not attached to campaign ${s.campaignId}`)
      }

      const source = readFile(sourceCampaignId)
      const record = isUuid(uuid) && has(source.records, uuid) && source.records[uuid].RaceID === s.RaceID ? source.records[uuid] : null

      if (!record) {
        throw refuse('not-found', `No record ${String(uuid)} of race ${s.RaceID} is in campaign ${sourceCampaignId}`)
      }

      const target = { campaignId: s.campaignId, RaceID: s.RaceID, branch: s.branchId }

      return transact(s.campaignId, (file) => {
        const [entry] = planImport(file, { records: [record] }, target, false)

        if (entry.item.status === 'rejected') {
          throw refuse('invalid-record', `The record cannot be adopted: ${entry.item.reasons.join('; ')}`, { reasons: entry.item.reasons })
        }

        const adopted = Object.values(file.records).find((other) => other.provenance.via === 'adopt' && other.provenance.from.campaignId === sourceCampaignId && other.provenance.from.uuid === uuid)

        if (adopted) {
          throw refuse('collision', `The record was adopted already, as ${adopted.uuid}`, { uuid: adopted.uuid })
        }

        const stamp = now()
        const stored = materialized(entry, target, stamp, freshId(file), { via: 'adopt', at: stamp, from: { uuid, campaignId: sourceCampaignId, RaceID: record.RaceID, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, association: copy(record.association) } })

        define(file.records, stored.uuid, stored)

        return copy(stored)
      })
    },
  }
}

// ---- The app's storage ---------------------------------------------------------------------------------------------

export const scenarioFileName = (campaignId) => {
  if (!isSegment(campaignId)) {
    throw refuse('invalid-scope', 'A campaign id is letters, digits, hyphens and underscores')
  }

  return `campaign-${campaignId}`
}

// The storage the repository works on: `open(campaignId)` is one electron-store file per campaign in `scenarios/` beside the settings (the window's store client in the app, whose every write the main process compares as a whole file; the browser's stand-in in web mode), `registry()` the campaign registry's content (history/campaigns, read only), `writable(campaignId, grace)` whether this window may write the file now and `release(campaignId)` gives the write up. Both kinds of file are opened with `strict: true`: the browser's stand-in then reads a value that is not valid JSON as damaged (it throws) and any other present value as it is stored, for the repository's shape check, where its ordinary stores read both as empty; the app's store client and host ignore the option, electron-store itself already throws on a file that is not valid JSON. A store class that says `writesNeedOwner` (the browser's stand-in, which has no compare-and-swap between tabs) is opened with `update` refused, code 'not-owner', unless this tab holds the file's Web Lock (`locks`, `navigator.locks`; without Web Locks no write is made); a tab that is not the writer reads. Never the save.
export const createScenarioStorage = ({ Store = Config, locks = typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null } = {}) => {
  const guarded = Store.writesNeedOwner === true
  const stores = {}
  const claims = new Map()
  let registryStore = null

  const claimOf = (name) => {
    if (!claims.has(name)) {
      const claim = { state: locks ? 'waiting' : 'unavailable', free: () => {}, granted: Promise.resolve(false) }

      if (locks) {
        let grant = () => {}

        claim.granted = new Promise((resolve) => {
          grant = resolve
        })
        // The lock is held while the promise the request's callback returns is pending; `claim.free` settles it.
        locks.request(`${LOCK_PREFIX}${name}`, () => new Promise((resolve) => {
          if (claim.state === 'released') {
            resolve()
            grant(false)

            return
          }

          claim.state = 'owner'
          claim.free = resolve
          grant(true)
        })).catch(() => {
          claim.state = 'unavailable'
          grant(false)
        })
      }

      claims.set(name, claim)
    }

    return claims.get(name)
  }

  const refusal = (campaignId, claim) => (claim && claim.state === 'unavailable' ? refuse('not-owner', 'This browser has no Web Locks, so no tab can be the only one to write the scenario records, and nothing was written', { campaignId }) : refuse('not-owner', `Another tab writes the scenario records of campaign ${campaignId} (or this one has not asked for the right to yet), so nothing was written; this tab only reads them`, { campaignId }))

  return {
    open: (campaignId) => {
      const name = scenarioFileName(campaignId)

      if (!stores[name]) {
        const config = new Store({ cwd: SCENARIO_FOLDER, name, strict: true })

        stores[name] = guarded ? {
          get path () {
            return config.path
          },
          get store () {
            return config.store
          },
          update: (change) => {
            const claim = claims.get(name)

            if (!claim || claim.state !== 'owner') {
              throw refusal(campaignId, claim)
            }

            return config.update(change)
          },
        } : config
      }

      return stores[name]
    },
    registry: () => {
      if (!registryStore) {
        registryStore = new Store({ cwd: REGISTRY_FOLDER, name: REGISTRY_NAME, strict: true })
      }

      return registryStore.store
    },
    writable: async (campaignId, grace = GRACE) => {
      if (!guarded) {
        return true
      }

      const claim = claimOf(scenarioFileName(campaignId))

      if (claim.state === 'waiting') {
        let timer
        const late = new Promise((resolve) => {
          timer = setTimeout(resolve, grace, false)
        })

        await Promise.race([claim.granted, late])
        clearTimeout(timer)
      }

      return claim.state === 'owner'
    },
    release: (campaignId) => {
      const name = scenarioFileName(campaignId)
      const claim = claims.get(name)

      if (claim) {
        claims.delete(name)
        claim.state = 'released'
        claim.free()
      }
    },
  }
}

let appStorage = null

// The page's own storage, made once: every repository of the page shares its one claim on a file.
export const scenarioStorage = () => {
  if (!appStorage) {
    appStorage = createScenarioStorage()
  }

  return appStorage
}

// The repository a planner uses: the page's storage and the adapters registered with `registerAdapter`.
export const openScenarioRecords = ({ storage = scenarioStorage(), adapters = defaultAdapters, newId = randomId, now = Date.now } = {}) => createRepository({ storage, adapters, newId, now })
