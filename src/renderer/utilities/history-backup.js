// A round trip of Empire History through a file: the versioned backup envelope, the checks a file passes before anything is previewed, the plan of what restoring it would do to the campaigns, history files and annotations the app holds, and the restore itself. Everything but `applyRestore` is a pure function of the stores it is given, so a preview or a cancel writes nothing.
//
// The envelope is `{ format, version, exportedAt, schemas, retention, units, excludes, campaigns, digest }`. Each campaign is `{ id, entry, branches, annotations }`: `entry` is the campaign's registry entry (its names, game ids, anchor, branches with their tips and the saves attached), `branches` holds each branch's history file as it is stored (`{ gameName, races: { [RaceID]: { raceName, npr, coverage, snapshots } }, intel: { [ViewRaceID]: { [AlienRaceID]: { name, coverage, snapshots } } } }`) and `annotations` the scenario records of the campaign as bundles of utilities/scenario-records.js, one per race and branch. Where a series sits in the file is its scope: a race's own figures are under `races`, what a viewing race knows of another under `intel` and the viewing race, so no figure of one race is ever read as another's. `units` states what each figure is measured in, `coverage` what each series spans, and `digest` makes an altered or truncated file known.
//
// Association rules (the decision of CP-DATA-01, explicit association). Campaign ids are the app's own random ids and are never renamed. A restore only ever adds to what is stored: names, game ids, attached saves, branches and a branch tip that is further along the same timeline. It never changes an answer the player gave, a merge, a legacy mark or a tip that is not on the same timeline, never merges two campaigns and never rebinds a branch; a campaign of another id that shares a game id is restored as a campaign of its own. Whatever is not applied is reported with its reason.
//
// Each history file is restored by its own policy: `merge` keeps what is stored and adds the backup's snapshots at other game times (at one game time the stored snapshot stays, as when a history is attached to a campaign), `replace` makes the selected series the backup's, `keep` leaves the file as it is. A policy applies to the series of the races selected, all of them by default. Metadata (a race's name, an alien race's name) comes from the side whose series reaches the later game time, the stored one on a tie.
//
// Annotations are the scenario records of the planners. A record is restored with its uuid when the campaign's file holds no record of that uuid and has not held one before (a deleted record stays deleted); the repository's import creates the record afresh, so its revision and times are the restore's and the original ones are kept in its provenance.

import { EARLY_COUNTS, REGISTRY_VERSION, STEP, anchorRelation, branchFileName, commonPrefix, hashValue, mergeAnchors, readRegistry, writeRegistry } from './campaign'
import { MAX_SNAPSHOTS, recordedSpan, thinSnapshots } from './history'
import { requireRecording } from './recording-owner'
import { BUNDLE_FORMAT, BUNDLE_VERSION } from './scenario-records'

export const FORMAT = 'aurora-electrons-history'
export const VERSION = 1
export const POLICIES = ['merge', 'replace', 'keep']
export const ANNOTATION_POLICIES = ['merge', 'keep']
export const ASSOCIATION_POLICIES = ['merge', 'keep']
// The largest file a restore reads, in bytes. A campaign of years is a few megabytes.
export const MAX_BYTES = 50 * 1024 * 1024
// The pre-restore backups kept, newest first.
export const KEPT_BACKUPS = 3

export const LIMITS = Object.freeze({ campaigns: 200, branches: 200, races: 64, views: 64, aliens: 512, names: 1000, gameIds: 100, attachments: 50, pending: 50, checkpoints: 100000, installations: 500, bundles: 1000, records: 100000, text: 2000 })

// What each figure of a race's snapshot is measured in, and of a snapshot of what a race knows of another.
export const UNITS = Object.freeze({
  t: 'game seconds',
  population: 'million people',
  colonies: 'colonies',
  wealth: 'wealth points',
  income: 'wealth points per year',
  fuel: 'litres',
  msp: 'maintenance supply points',
  minerals: 'tons, Duranium to Gallicite',
  militaryShips: 'ships',
  militaryTons: 'tons',
  commercialShips: 'ships',
  commercialTons: 'tons',
  installations: 'installations by type id',
  research: 'research points',
  systems: 'systems',
  commanders: 'commanders',
})

export const INTEL_UNITS = Object.freeze({
  t: 'game seconds',
  contact: 'contact status code',
  comm: 'communication status code',
  translation: 'translation points',
  points: 'diplomatic points',
  intel: 'intelligence points',
  granted: 'treaty bitmask',
  received: 'treaty bitmask',
  ships: 'ships',
  tons: 'tons',
  lost: 'ships',
  classes: 'classes',
  populations: 'colonies',
  population: 'million people',
  systems: 'systems',
  ground: 'ground unit classes',
  sensors: 'sensors',
})

export const EXCLUDES = Object.freeze(['unattached legacy history', 'migration records', 'settings of races'])

const ID = /^[A-Za-z0-9_-]+$/
const BRANCH = /^b[1-9]\d*$/
const NUMERIC = /^(0|[1-9]\d*)$/
const ATTACHMENT_LIMIT = 50
const ANSWERS = ['inferred', 'separate', 'attached-by-player']

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const isCount = (value) => Number.isInteger(value) && value >= 0

const utf8Size = (body) => new TextEncoder().encode(body).length

// Whether the text `body` is at most MAX_BYTES once written as UTF-8, the size of the file a backup is saved as.
const fitsLimit = (body) => body.length <= MAX_BYTES && (body.length * 3 <= MAX_BYTES || utf8Size(body) <= MAX_BYTES)

const canonical = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (isObject(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}

const plainJson = (value, depth = 0) => {
  if (depth > 40) {
    return false
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.every((item) => plainJson(item, depth + 1))
  }

  return isObject(value) && Object.entries(value).every(([key, inner]) => key !== '__proto__' && plainJson(inner, depth + 1))
}

// A backup the app refuses to read or to apply, with nothing changed.
export class Rejected extends Error {
  constructor (message) {
    super(message)
    this.name = 'Rejected'
  }
}

// What a restore would change is no longer what the preview showed (the registry or a file changed since). Nothing was written; the preview is read again.
export class Changed extends Error {
  constructor () {
    super('What the backup would change differs from the preview, so nothing was written; read the preview again')
    this.name = 'Changed'
    this.changed = true
  }
}

const bad = (where, what) => {
  throw new Rejected(`${where}: ${what}`)
}

// ---- The envelope's checks -----------------------------------------------------------------------------------------

// The units a backup states for the figures of a snapshot: every figure of this version, each in the unit this version records it in, and no other. A backup that omits a declaration, or states a map of its own, is refused, so no figure is ever read in a unit nobody stated.
const sameUnits = (declared, known, where) => {
  if (!isObject(declared)) {
    bad(where, 'the units are not stated')
  }

  Object.entries(declared).forEach(([field, unit]) => {
    if (!Object.prototype.hasOwnProperty.call(known, field)) {
      bad(where, `the figure ${field} is not one this version records`)
    }

    if (unit !== known[field]) {
      bad(where, `the figure ${field} is measured in ${String(unit)} here and in ${known[field]} in this version, so its values would be misread`)
    }
  })

  Object.keys(known).forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(declared, field)) {
      bad(where, `the units of the figure ${field} are not stated`)
    }
  })
}

const text = (value, where, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null)) {
    return
  }

  if (typeof value !== 'string' || value.length > LIMITS.text) {
    bad(where, `is not a text of at most ${LIMITS.text} characters`)
  }
}

const allowed = (object, keys, where) => {
  Object.keys(object).forEach((key) => {
    if (!keys.includes(key)) {
      bad(where, `holds ${key}, which this version does not read`)
    }
  })
}

const nullableNumber = (value) => value === null || isNumber(value)

const checkSnapshot = (snapshot, units, where) => {
  if (!isObject(snapshot)) {
    bad(where, 'is not an object')
  }

  if (!isNumber(snapshot.t) || snapshot.t < 0) {
    bad(where, 'has no finite, non-negative game time t')
  }

  Object.entries(snapshot).forEach(([field, value]) => {
    if (!Object.prototype.hasOwnProperty.call(units, field)) {
      bad(where, `holds the figure ${field}, whose units the backup does not state`)
    }

    if (field === 'minerals') {
      if (!Array.isArray(value) || value.length !== 11 || !value.every(nullableNumber)) {
        bad(where, 'minerals is not 11 amounts')
      }
    } else if (field === 'installations') {
      if (!isObject(value) || Object.keys(value).length > LIMITS.installations || !Object.entries(value).every(([id, amount]) => NUMERIC.test(id) && nullableNumber(amount))) {
        bad(where, 'installations is not amounts by installation type id')
      }
    } else if (!nullableNumber(value)) {
      bad(where, `${field} is not a finite number or null`)
    }
  })
}

const checkSeries = (series, where, { race, units }) => {
  if (!isObject(series)) {
    bad(where, 'is not an object')
  }

  allowed(series, race ? ['raceName', 'npr', 'coverage', 'snapshots'] : ['name', 'coverage', 'snapshots'], where)

  if (race) {
    text(series.raceName, `${where} raceName`, { optional: true })

    if (series.npr !== undefined && typeof series.npr !== 'boolean') {
      bad(where, 'npr is not true or false')
    }
  } else {
    text(series.name, `${where} name`, { optional: true })
  }

  if (!Array.isArray(series.snapshots) || series.snapshots.length > MAX_SNAPSHOTS) {
    bad(where, `snapshots is not a list of at most ${MAX_SNAPSHOTS}`)
  }

  series.snapshots.forEach((snapshot, index) => {
    checkSnapshot(snapshot, units, `${where} snapshot ${index}`)

    if (index > 0 && !(snapshot.t > series.snapshots[index - 1].t)) {
      bad(where, `snapshot ${index} is not later than the one before it`)
    }
  })

  const { count, first, last } = recordedSpan(series.snapshots)

  if (!isObject(series.coverage) || series.coverage.count !== count || series.coverage.first !== first || series.coverage.last !== last || Object.keys(series.coverage).length !== 3) {
    bad(where, 'its coverage does not match its snapshots')
  }
}

const checkFile = (file, where, units) => {
  if (!isObject(file)) {
    bad(where, 'is not an object')
  }

  allowed(file, ['gameName', 'races', 'intel'], where)
  text(file.gameName, `${where} gameName`, { optional: true })

  if (file.races !== undefined) {
    if (!isObject(file.races) || Object.keys(file.races).length > LIMITS.races) {
      bad(where, 'races is not a map of at most 64 races')
    }

    Object.entries(file.races).forEach(([RaceID, series]) => {
      if (!NUMERIC.test(RaceID)) {
        bad(where, `${RaceID} is not a race id`)
      }

      checkSeries(series, `${where} race ${RaceID}`, { race: true, units: units.race })
    })
  }

  if (file.intel !== undefined) {
    if (!isObject(file.intel) || Object.keys(file.intel).length > LIMITS.views) {
      bad(where, 'intel is not a map of at most 64 viewing races')
    }

    Object.entries(file.intel).forEach(([view, aliens]) => {
      if (!NUMERIC.test(view) || !isObject(aliens) || Object.keys(aliens).length > LIMITS.aliens) {
        bad(where, `the intelligence of ${view} is not a map of alien races under a race id`)
      }

      Object.entries(aliens).forEach(([alien, series]) => {
        if (!NUMERIC.test(alien)) {
          bad(where, `${alien} is not a race id`)
        }

        checkSeries(series, `${where} what race ${view} knows of race ${alien}`, { race: false, units: units.intelligence })
      })
    })
  }
}

const checkTip = (tip, where) => {
  if (!isObject(tip) || !isCount(tip.n) || typeof tip.digest !== 'string' || !Array.isArray(tip.checkpoints) || tip.checkpoints.length > LIMITS.checkpoints || !tip.checkpoints.every((digest) => typeof digest === 'string') || (tip.t !== undefined && !nullableNumber(tip.t)) || !plainJson(tip)) {
    bad(where, 'is not a ledger tip')
  }

  if (tip.early !== undefined && (!isObject(tip.early) || !Object.entries(tip.early).every(([count, digest]) => EARLY_COUNTS.includes(Number(count)) && typeof digest === 'string'))) {
    bad(where, 'its early digests are not valid')
  }
}

const checkEntry = (entry, id, where) => {
  if (!isObject(entry) || entry.id !== id || !plainJson(entry)) {
    bad(where, 'its registry entry is not valid')
  }

  if (!isNumber(entry.createdAt) || !isNumber(entry.seen)) {
    bad(where, 'its registry entry has no creation and last-seen times')
  }

  if (!Array.isArray(entry.names) || entry.names.length > LIMITS.names || !entry.names.every((name) => isObject(name) && typeof name.name === 'string' && name.name.length <= LIMITS.text && nullableNumber(name.t) && isNumber(name.seen))) {
    bad(where, 'its names are not valid')
  }

  if (!Array.isArray(entry.gameIds) || entry.gameIds.length > LIMITS.gameIds || !entry.gameIds.every(isCount)) {
    bad(where, 'its game ids are not valid')
  }

  if (!Array.isArray(entry.anchor) || entry.anchor.length > 16 || !entry.anchor.every((row) => Array.isArray(row) && row.length <= 8 && row.every(nullableNumber))) {
    bad(where, 'its anchor is not valid')
  }

  const branchIds = isObject(entry.branches) ? Object.keys(entry.branches) : []

  if (branchIds.length < 1 || branchIds.length > LIMITS.branches || !branchIds.every((branchId) => BRANCH.test(branchId))) {
    bad(where, 'its branches are not valid')
  }

  branchIds.forEach((branchId) => {
    const branch = entry.branches[branchId]

    if (!isObject(branch) || branch.id !== branchId || !(branch.parent === null || branch.parent === undefined || Object.prototype.hasOwnProperty.call(entry.branches, branch.parent)) || !isNumber(branch.createdAt) || !isNumber(branch.seen)) {
      bad(where, `branch ${branchId} is not valid`)
    }

    checkTip(branch.tip, `${where} branch ${branchId} tip`)
  })

  if (!isCount(entry.branchSeq) || entry.branchSeq < Math.max(...branchIds.map((branchId) => Number(branchId.slice(1))))) {
    bad(where, 'its branch counter is behind its branches')
  }

  if (!Array.isArray(entry.attachments) || entry.attachments.length > LIMITS.attachments) {
    bad(where, `its attached saves are not a list of at most ${LIMITS.attachments}`)
  }

  entry.attachments.forEach((attachment) => {
    const ok = isObject(attachment) && typeof attachment.path === 'string' && attachment.path.length <= LIMITS.text && isCount(attachment.GameID) && Object.prototype.hasOwnProperty.call(entry.branches, attachment.branchId) && isNumber(attachment.lastSeen) && (attachment.answer === null || ANSWERS.includes(attachment.answer)) && Array.isArray(attachment.pending) && attachment.pending.length <= LIMITS.pending && attachment.pending.every((candidate) => isObject(candidate) && typeof candidate.campaignId === 'string' && typeof candidate.branchId === 'string')

    if (!ok) {
      bad(where, 'an attached save is not valid')
    }
  })

  if (entry.mergedInto !== undefined && !(isObject(entry.mergedInto) && typeof entry.mergedInto.campaignId === 'string' && typeof entry.mergedInto.branchId === 'string' && isNumber(entry.mergedInto.at))) {
    bad(where, 'its merge mark is not valid')
  }
}

const checkBundle = (bundle, campaignId, where, branchIds) => {
  if (!isObject(bundle) || bundle.format !== BUNDLE_FORMAT || !Number.isInteger(bundle.version) || bundle.version < 1) {
    bad(where, 'is not a bundle of scenario records')
  }

  if (bundle.version > BUNDLE_VERSION) {
    throw new Rejected(`${where}: the annotations are of version ${bundle.version}, written by a newer version of the app; this version reads up to version ${BUNDLE_VERSION}`)
  }

  if (!Array.isArray(bundle.records) || !plainJson(bundle)) {
    bad(where, 'its records are not a list of plain data')
  }

  if (!isObject(bundle.source) || bundle.source.campaignId !== campaignId || !Number.isInteger(bundle.source.RaceID) || typeof bundle.source.branchId !== 'string' || !ID.test(bundle.source.branchId)) {
    bad(where, 'does not name the campaign, race and branch it was made for')
  }

  if (!branchIds.includes(bundle.source.branchId)) {
    bad(where, `names the branch ${bundle.source.branchId}, which the campaign does not have`)
  }

  bundle.records.forEach((record, index) => {
    if (!isObject(record) || typeof record.uuid !== 'string') {
      bad(where, `record ${index} has no uuid`)
    }

    if (record.campaignId !== campaignId || record.RaceID !== bundle.source.RaceID || !isObject(record.association) || record.association.branchId !== bundle.source.branchId) {
      bad(where, `the record ${record.uuid} belongs to another campaign, race or branch than the bundle it is in`)
    }
  })
}

const checkEnvelope = (envelope) => {
  if (!isObject(envelope) || envelope.format !== FORMAT) {
    throw new Rejected('This file is not a history backup of Aurora Electrons')
  }

  if (!Number.isInteger(envelope.version) || envelope.version < 1) {
    throw new Rejected('The backup has no version this app knows')
  }

  if (envelope.version > VERSION) {
    throw new Rejected(`The backup is of version ${envelope.version}, written by a newer version of the app; this version reads up to version ${VERSION}, so nothing was read`)
  }

  if (!isObject(envelope.schemas) || !Number.isInteger(envelope.schemas.registry) || !Number.isInteger(envelope.schemas.annotations)) {
    throw new Rejected('The backup does not state the schemas of its campaign records and annotations')
  }

  if (envelope.schemas.registry > REGISTRY_VERSION) {
    throw new Rejected(`The campaign records of the backup are of version ${envelope.schemas.registry}, written by a newer version of the app; this version reads up to version ${REGISTRY_VERSION}`)
  }

  if (envelope.schemas.annotations > BUNDLE_VERSION) {
    throw new Rejected(`The annotations of the backup are of version ${envelope.schemas.annotations}, written by a newer version of the app; this version reads up to version ${BUNDLE_VERSION}`)
  }

  if (!isNumber(envelope.exportedAt) || envelope.exportedAt < 0) {
    throw new Rejected('The backup has no export time')
  }

  if (!isObject(envelope.retention) || !isCount(envelope.retention.maxSnapshots) || envelope.retention.maxSnapshots < 1) {
    throw new Rejected('The backup does not state how many snapshots a series keeps')
  }

  if (!isObject(envelope.units)) {
    throw new Rejected('The backup does not state its units')
  }

  sameUnits(envelope.units.race, UNITS, 'The units of a race\'s figures')
  sameUnits(envelope.units.intelligence, INTEL_UNITS, 'The units of what a race knows of another')

  if (!Array.isArray(envelope.campaigns) || envelope.campaigns.length > LIMITS.campaigns) {
    throw new Rejected(`The backup does not hold a list of at most ${LIMITS.campaigns} campaigns`)
  }

  if (envelope.digest !== hashValue(envelope.campaigns)) {
    throw new Rejected('The backup was altered or damaged after it was made: its digest does not match its campaigns')
  }

  const ids = new Set()
  const entries = {}
  let records = 0
  const uuids = new Set()

  envelope.campaigns.forEach((campaign, index) => {
    const where = `Campaign ${index + 1}`

    if (!isObject(campaign) || typeof campaign.id !== 'string' || !ID.test(campaign.id)) {
      bad(where, 'has no campaign id of letters, digits, hyphens and underscores')
    }

    if (ids.has(campaign.id)) {
      bad(where, `repeats the campaign ${campaign.id}`)
    }

    ids.add(campaign.id)
    allowed(campaign, ['id', 'entry', 'branches', 'annotations'], where)
    checkEntry(campaign.entry, campaign.id, `Campaign ${campaign.id}`)
    entries[campaign.id] = campaign.entry

    const branchIds = Object.keys(campaign.entry.branches)

    if (!isObject(campaign.branches) || Object.keys(campaign.branches).sort().join() !== [...branchIds].sort().join()) {
      bad(`Campaign ${campaign.id}`, 'does not hold a history file for each of its branches, and no other')
    }

    branchIds.forEach((branchId) => checkFile(campaign.branches[branchId], `Campaign ${campaign.id} branch ${branchId}`, envelope.units))

    if (!Array.isArray(campaign.annotations) || campaign.annotations.length > LIMITS.bundles) {
      bad(`Campaign ${campaign.id}`, 'its annotations are not a list of bundles')
    }

    campaign.annotations.forEach((bundle, position) => {
      checkBundle(bundle, campaign.id, `Campaign ${campaign.id} annotations ${position + 1}`, branchIds)
      records += bundle.records.length

      bundle.records.forEach((record) => {
        const key = [campaign.id, record.uuid].join('/')

        if (uuids.has(key)) {
          bad(`Campaign ${campaign.id} annotations ${position + 1}`, `the annotation ${record.uuid} is in the campaign more than once`)
        }

        uuids.add(key)
      })
    })
  })

  if (records > LIMITS.records) {
    throw new Rejected(`The backup holds more than ${LIMITS.records} annotations`)
  }

  try {
    readRegistry({ registry: { store: { version: envelope.schemas.registry, campaigns: entries } } })
  } catch (error) {
    throw new Rejected(`The campaign records of the backup are not valid: ${error.message}`)
  }
}

// The backup in `body`, a text: `{ envelope }` when it passes every check, else `{ errors: [message] }`, before anything is previewed. Nothing is stored or changed.
export const parseBackup = (body) => {
  if (typeof body !== 'string') {
    return { errors: ['The backup is not a text'] }
  }

  if (!fitsLimit(body)) {
    return { errors: [`The file is larger than ${MAX_BYTES / (1024 * 1024)} MB, the most a backup is read at`] }
  }

  let envelope

  try {
    envelope = JSON.parse(body)
  } catch (error) {
    return { errors: [`The file is not valid JSON (${error.message})`] }
  }

  try {
    checkEnvelope(envelope)
  } catch (error) {
    return { errors: [error instanceof Rejected ? error.message : `The file is not a history backup this version reads (${error && error.message ? error.message : String(error)})`] }
  }

  return { envelope }
}

// ---- Building a backup ---------------------------------------------------------------------------------------------

const seriesCoverage = (snapshots) => {
  const { count, first, last } = recordedSpan(snapshots)

  return { count, first, last }
}

const withCoverage = (file) => {
  const covered = (series) => ({ ...series, coverage: seriesCoverage(Array.isArray(series.snapshots) ? series.snapshots : []) })

  return {
    ...file,
    ...(isObject(file.races) ? { races: Object.fromEntries(Object.entries(file.races).map(([RaceID, series]) => [RaceID, covered(series)])) } : {}),
    ...(isObject(file.intel) ? { intel: Object.fromEntries(Object.entries(file.intel).map(([view, aliens]) => [view, Object.fromEntries(Object.entries(aliens).map(([alien, series]) => [alien, covered(series)]))])) } : {}),
  }
}

const withoutCoverage = (file) => {
  const bare = ({ coverage: _coverage, ...series }) => series

  return {
    ...file,
    ...(isObject(file.races) ? { races: Object.fromEntries(Object.entries(file.races).map(([RaceID, series]) => [RaceID, bare(series)])) } : {}),
    ...(isObject(file.intel) ? { intel: Object.fromEntries(Object.entries(file.intel).map(([view, aliens]) => [view, Object.fromEntries(Object.entries(aliens).map(([alien, series]) => [alien, bare(series)]))])) } : {}),
  }
}

const branchOrder = (a, b) => Number(a.slice(1)) - Number(b.slice(1))

// An envelope this version made, checked as a file would be and small enough to be read back: a backup the app could not restore is never offered or kept.
const checkedBackup = (envelope) => {
  try {
    checkEnvelope(envelope)
  } catch (error) {
    if (error instanceof Rejected) {
      throw new Rejected(`The history cannot be written as a backup this version could read again: ${error.message}`)
    }

    throw error
  }

  if (!fitsLimit(JSON.stringify(envelope))) {
    throw new Rejected(`The history is larger than ${MAX_BYTES / (1024 * 1024)} MB as a backup, the most this version reads back, so no backup was made`)
  }

  return envelope
}

// The envelope of `campaignIds` (every campaign when none is named), read from the stores of `io` at the time `at` (milliseconds). `annotations` is the adapter of the scenario records (see `annotationsOf`); without one the envelope holds none. The envelope is checked as a file would be, so a backup this version could not read again is never offered.
export const buildBackup = (io, { campaignIds = null, at, annotations = null } = {}) => {
  const registry = readRegistry(io)
  const ids = campaignIds || Object.keys(registry.campaigns).sort()
  const campaigns = ids.map((id) => {
    const entry = registry.campaigns[id]

    if (!entry) {
      throw new Rejected(`The campaign ${id} is not recorded`)
    }

    const branches = {}

    Object.keys(entry.branches).sort(branchOrder).forEach((branchId) => {
      const file = io.file(branchFileName(id, branchId)).store

      branches[branchId] = withCoverage(isObject(file) ? clone(file) : {})
    })

    const bundles = annotations ? annotations.groups(id).map((group) => {
      const bundle = annotations.export({ campaignId: id, RaceID: group.RaceID, branchId: group.branchId, gameTime: 0 })

      return { ...bundle, records: bundle.records.filter((record) => record.association && record.association.branchId === group.branchId) }
    }).filter((bundle) => bundle.records.length) : []

    return { id, entry: clone(entry), branches, annotations: bundles }
  })
  const plain = clone(campaigns)
  const envelope = {
    format: FORMAT,
    version: VERSION,
    exportedAt: at,
    schemas: { registry: registry.version, annotations: BUNDLE_VERSION },
    retention: { maxSnapshots: MAX_SNAPSHOTS },
    units: { race: { ...UNITS }, intelligence: { ...INTEL_UNITS } },
    excludes: [...EXCLUDES],
    campaigns: plain,
    digest: hashValue(plain),
  }

  return checkedBackup(envelope)
}

// The file name a downloaded backup is given.
export const backupFileName = (envelope) => {
  const day = new Date(envelope.exportedAt).toISOString().slice(0, 10)
  const only = envelope.campaigns.length === 1 ? envelope.campaigns[0].entry.names[envelope.campaigns[0].entry.names.length - 1] : null
  const label = only ? only.name.replace(/[^\w-]+/g, '_') : 'all-campaigns'

  return `aurora-history-${label}-${day}.json`
}

// The file name of a copy kept before a restore. It depends on nothing inside the copy, which may be damaged, only on the time it was kept (in UTC, as the name of a backup is), so it can always be named.
export const recoveryFileName = (entry) => {
  const kept = new Date(isNumber(entry && entry.at) ? entry.at : NaN)
  const stamp = Number.isNaN(kept.getTime()) ? 'unknown-time' : `${kept.toISOString().slice(0, 19).replace(/[^\d]/g, '-')}-utc`

  return `aurora-history-before-restore-${stamp}.json`
}

// ---- The scenario records of a campaign ----------------------------------------------------------------------------

// The adapter the backup reads and restores annotations through, over a scenario repository (`openScenarioRecords()`) and the storage it works on: `groups(campaignId)` the race and branch of each record the campaign's file holds, and the repository's `exportRecords`, `previewImport`, `importRecords` and `writable`.
export const annotationsOf = (repository, storage) => ({
  groups: (campaignId) => {
    const file = storage.open(campaignId).store
    const seen = new Map()

    Object.values(isObject(file) && isObject(file.records) ? file.records : {}).forEach((record) => {
      if (isObject(record) && Number.isInteger(record.RaceID) && isObject(record.association) && typeof record.association.branchId === 'string' && ID.test(record.association.branchId)) {
        seen.set(`${record.RaceID}/${record.association.branchId}`, { RaceID: record.RaceID, branchId: record.association.branchId })
      }
    })

    return [...seen.values()].sort((a, b) => a.RaceID - b.RaceID || branchOrder(a.branchId, b.branchId))
  },
  export: (scope) => repository.exportRecords(scope),
  preview: (bundle, target, options) => repository.previewImport(bundle, target, options),
  import: (bundle, target, options) => repository.importRecords(bundle, target, options),
  writable: (campaignId) => repository.writable(campaignId),
})

// ---- Planning a restore --------------------------------------------------------------------------------------------

const usableFile = (file) => {
  if (!isObject(file)) {
    return false
  }

  const series = (record) => isObject(record) && (record.snapshots === undefined || (Array.isArray(record.snapshots) && record.snapshots.every((snapshot) => isObject(snapshot) && isNumber(snapshot.t))))

  return (file.races === undefined || (isObject(file.races) && Object.values(file.races).every(series))) && (file.intel === undefined || (isObject(file.intel) && Object.values(file.intel).every((aliens) => isObject(aliens) && Object.values(aliens).every(series))))
}

// The series of a file by key, each { key, owner (the race, or the viewing race), kind, RaceID, alien, record }.
const seriesOf = (file) => {
  const found = new Map()

  Object.entries(isObject(file.races) ? file.races : {}).forEach(([RaceID, record]) => found.set(`race:${RaceID}`, { key: `race:${RaceID}`, owner: RaceID, kind: 'race', RaceID, alien: null, record }))
  Object.entries(isObject(file.intel) ? file.intel : {}).forEach(([view, aliens]) => Object.entries(aliens).forEach(([alien, record]) => found.set(`intel:${view}:${alien}`, { key: `intel:${view}:${alien}`, owner: view, kind: 'intel', RaceID: view, alien, record })))

  return found
}

const snapshotsOf = (record) => (record && Array.isArray(record.snapshots) ? record.snapshots : [])

const labelOf = (entry) => {
  const name = entry.kind === 'race' ? entry.record.raceName : entry.record.name

  return entry.kind === 'race' ? `race ${entry.RaceID}${name ? ` (${name})` : ''}` : `what race ${entry.RaceID} knows of race ${entry.alien}${name ? ` (${name})` : ''}`
}

// One series of a file merged, replaced or kept: { snapshots, stats }.
const planSeries = (stored, given, policy) => {
  const known = new Map(stored.map((snapshot) => [snapshot.t, snapshot]))
  const offered = new Map(given.map((snapshot) => [snapshot.t, snapshot]))
  const shared = given.filter((snapshot) => known.has(snapshot.t))
  const conflicts = shared.filter((snapshot) => canonical(snapshot) !== canonical(known.get(snapshot.t))).length
  const stats = { stored: stored.length, backup: given.length, added: given.length - shared.length, identical: shared.length - conflicts, conflicts, removed: 0, thinned: 0, result: stored.length }

  if (policy === 'keep') {
    return { snapshots: stored, stats: { ...stats, added: 0 } }
  }

  if (policy === 'replace') {
    stats.removed = stored.filter((snapshot) => !offered.has(snapshot.t)).length
    stats.result = given.length

    return { snapshots: given, stats }
  }

  const united = [...stored, ...given.filter((snapshot) => !known.has(snapshot.t))].sort((a, b) => a.t - b.t)
  const thinned = thinSnapshots(united)

  stats.thinned = united.length - thinned.length
  stats.result = thinned.length

  return { snapshots: thinned, stats }
}

const lastTime = (snapshots) => (snapshots.length ? snapshots[snapshots.length - 1].t : -Infinity)

// A history file with the series of `given` (the races chosen, or all) merged, replaced or kept: { file, rows, totals }. The stored file is not changed.
const planFile = (stored, given, { policy, races }) => {
  const own = seriesOf(stored)
  const offered = seriesOf(given)
  const whole = policy === 'replace' && !races
  const hasRaces = whole ? isObject(given.races) : isObject(stored.races) || isObject(given.races)
  const hasIntel = whole ? isObject(given.intel) : isObject(stored.intel) || isObject(given.intel)
  const result = { races: clone(isObject(stored.races) ? stored.races : {}), intel: clone(isObject(stored.intel) ? stored.intel : {}) }
  const selected = (owner) => !races || races.includes(owner)
  const visited = new Map(offered)
  const rows = []

  // Replace makes the races chosen what the backup holds, so a series the file holds and the backup lacks is dropped too.
  if (policy === 'replace') {
    own.forEach((entry, key) => {
      if (!visited.has(key)) {
        visited.set(key, entry)
      }
    })
  }

  visited.forEach((entry, key) => {
    if (!selected(entry.owner)) {
      return
    }

    const theirs = offered.get(key)
    const kept = own.get(key)
    const before = snapshotsOf(kept && kept.record)
    const planned = planSeries(before, snapshotsOf(theirs && theirs.record), policy)

    if (policy !== 'keep' && !theirs) {
      if (entry.kind === 'race') {
        delete result.races[entry.RaceID]
      } else {
        delete result.intel[entry.RaceID][entry.alien]
      }
    } else if (policy !== 'keep') {
      const newer = !kept || policy === 'replace' || lastTime(snapshotsOf(entry.record)) > lastTime(before)
      const record = { ...(newer ? entry.record : kept.record), snapshots: clone(planned.snapshots) }

      if (entry.kind === 'race') {
        result.races[entry.RaceID] = record
      } else {
        result.intel[entry.RaceID] = isObject(result.intel[entry.RaceID]) ? result.intel[entry.RaceID] : {}
        result.intel[entry.RaceID][entry.alien] = record
      }
    }

    rows.push({ key: entry.key, kind: entry.kind, label: labelOf(entry), scope: entry.kind === 'race' ? { race: entry.RaceID } : { viewedBy: entry.RaceID, race: entry.alien }, ...planned.stats })
  })

  const givenViews = isObject(given.intel) ? Object.keys(given.intel) : []

  if (policy !== 'keep') {
    givenViews.filter((view) => result.intel[view] === undefined && selected(view)).forEach((view) => {
      result.intel[view] = {}
    })
  }

  if (policy === 'replace') {
    Object.keys(result.intel).filter((view) => selected(view) && !givenViews.includes(view)).forEach((view) => {
      delete result.intel[view]
    })
  }

  const totals = rows.reduce((sum, row) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + row[key]])), { stored: 0, backup: 0, added: 0, identical: 0, conflicts: 0, removed: 0, thinned: 0, result: 0 })
  const gameName = policy === 'replace' && given.gameName !== undefined ? given.gameName : stored.gameName !== undefined ? stored.gameName : given.gameName
  const file = { ...(gameName !== undefined ? { gameName } : {}), ...(hasRaces ? { races: result.races } : {}), ...(hasIntel ? { intel: result.intel } : {}) }

  return { file, rows, totals }
}

// The digest of the first `count` increments a tip holds evidence of: the checkpoint at a multiple of STEP, or one of the early digests; undefined for any other count.
const digestAt = (tip, count) => {
  if (count > 0 && count % STEP === 0 && count / STEP <= tip.checkpoints.length) {
    return tip.checkpoints[count / STEP - 1]
  }

  return EARLY_COUNTS.includes(count) && tip.early ? tip.early[count] : undefined
}

// How the backup's tip of a branch relates to the stored one: 'same', 'extends' (further along the same timeline), 'behind' (the stored tip is further), or 'different' / 'unknown' (not the same timeline, or too little recorded to tell). One tip is a continuation of the other only when the longer one holds the digest of the whole of the shorter one's increments: a checkpoint below the shorter tip says nothing of the increments after it, which may be another timeline's.
const tipRelation = (stored, given) => {
  if (stored.n === given.n && stored.digest === given.digest) {
    return 'same'
  }

  const shared = Math.min(stored.checkpoints.length, given.checkpoints.length)

  if (shared > 0 && commonPrefix(stored.checkpoints, given.checkpoints) < shared * STEP) {
    return 'different'
  }

  const early = EARLY_COUNTS.filter((count) => count <= stored.n && count <= given.n && stored.early && given.early && stored.early[count] !== undefined && given.early[count] !== undefined)

  if (early.some((count) => stored.early[count] !== given.early[count])) {
    return 'different'
  }

  if (stored.n === given.n) {
    return 'different'
  }

  const longer = given.n > stored.n ? given : stored
  const shorter = longer === given ? stored : given
  const proof = shorter.n === 0 ? shorter.digest : digestAt(longer, shorter.n)

  if (proof === undefined) {
    return 'unknown'
  }

  if (proof !== shorter.digest) {
    return 'different'
  }

  return longer === given ? 'extends' : 'behind'
}

// The stored registry entry with what the backup's adds to it: { merged, added, kept }. A name, a game id, a saved path or a branch the entry lacks is added, a tip further along the same timeline advances it; nothing else is changed, and what differs is listed in `kept`.
const mergeEntry = (stored, given, relations) => {
  const merged = clone(stored)
  const added = { names: 0, gameIds: 0, attachments: 0, branches: 0, tips: 0, anchor: 0 }
  const kept = []

  given.names.forEach((name) => {
    if (!merged.names.some((own) => own.name === name.name && own.t === name.t)) {
      merged.names.push(clone(name))
      added.names += 1
    }
  })

  if (added.names) {
    merged.names = merged.names.sort((a, b) => a.seen - b.seen)
  }

  given.gameIds.forEach((GameID) => {
    if (!merged.gameIds.includes(GameID)) {
      merged.gameIds.push(GameID)
      added.gameIds += 1
    }
  })

  const anchor = mergeAnchors(merged.anchor, given.anchor)

  if (canonical(anchor) !== canonical(merged.anchor)) {
    merged.anchor = anchor
    added.anchor = 1
  }

  merged.createdAt = Math.min(merged.createdAt, given.createdAt)
  merged.seen = Math.max(merged.seen, given.seen)

  Object.keys(given.branches).sort(branchOrder).forEach((branchId) => {
    const branch = given.branches[branchId]
    const own = merged.branches[branchId]

    if (!own) {
      merged.branches[branchId] = clone(branch)
      added.branches += 1

      return
    }

    const relation = relations[branchId]

    if (relation === 'different' || relation === 'unknown') {
      kept.push(relation === 'different' ? `branch ${branchId} is a different timeline in the backup, so the stored one is kept` : `branch ${branchId} cannot be told from the stored one, so the stored one is kept`)

      return
    }

    own.seen = Math.max(own.seen, branch.seen)

    if (relation === 'extends') {
      own.tip = clone(branch.tip)
      added.tips += 1
    }
  })

  merged.branchSeq = Math.max(merged.branchSeq, given.branchSeq)

  given.attachments.forEach((attachment) => {
    const own = merged.attachments.find((candidate) => candidate.path === attachment.path && candidate.GameID === attachment.GameID)

    if (!own) {
      if (merged.attachments.length < ATTACHMENT_LIMIT) {
        merged.attachments.push(clone(attachment))
        added.attachments += 1
      } else {
        kept.push(`the saved path ${attachment.path} is not added: the campaign already holds ${ATTACHMENT_LIMIT}`)
      }
    } else if (own.answer !== attachment.answer || own.branchId !== attachment.branchId) {
      kept.push(`the saved path ${attachment.path} stays attached as it is stored (branch ${own.branchId}, ${own.answer === null ? 'unanswered' : own.answer})`)
    }
  })

  if (given.mergedInto && canonical(given.mergedInto) !== canonical(merged.mergedInto)) {
    kept.push('the backup marks the campaign as merged into another, which is not applied')
  }

  return { merged, added, kept }
}

const lastName = (entry) => (entry.names.length ? entry.names[entry.names.length - 1].name : entry.id)

const choiceOf = (choices, id, branchIds) => {
  const campaign = isObject(choices) && isObject(choices.campaigns) && isObject(choices.campaigns[id]) ? choices.campaigns[id] : {}
  const policy = (value, list, what) => {
    if (value === undefined) {
      return 'merge'
    }

    if (!list.includes(value)) {
      throw new Rejected(`${String(value)} is not a policy for ${what}`)
    }

    return value
  }
  const files = {}

  branchIds.forEach((branchId) => {
    const file = isObject(campaign.files) && isObject(campaign.files[branchId]) ? campaign.files[branchId] : {}

    files[branchId] = { policy: policy(file.policy, POLICIES, `the history of branch ${branchId}`), races: Array.isArray(file.races) && file.races.length ? file.races.map(String) : null }
  })

  return { association: policy(campaign.association, ASSOCIATION_POLICIES, 'the campaign record'), annotations: policy(campaign.annotations, ANNOTATION_POLICIES, 'the annotations'), files }
}

// The choices that restore everything the backup holds by merging: `{ campaigns: { [id]: { association, annotations, files: { [branchId]: { policy, races } } } } }`.
export const defaultChoices = (envelope) => ({
  campaigns: Object.fromEntries(envelope.campaigns.map((campaign) => [campaign.id, { association: 'merge', annotations: 'merge', files: Object.fromEntries(Object.keys(campaign.branches).map((branchId) => [branchId, { policy: 'merge', races: null }])) }])),
})

// One bundle of annotations against the campaign's scenario file: the counts of what would be added, is there already, was deleted since or cannot be restored, and the import to make. The import is the repository's restore policy: a record is added under its own uuid only when the file neither holds it nor held it once, decided inside the import itself, so a stored or deleted record is never copied or brought back. `locked` says why nothing is imported, but the counts are still given.
const planGroup = (annotations, campaignId, bundle, locked) => {
  const row = { RaceID: bundle.source.RaceID, branchId: bundle.source.branchId, records: bundle.records.length, add: 0, existing: 0, deleted: 0, rejected: 0, reasons: [], locked, refused: null }
  const target = { campaignId, RaceID: bundle.source.RaceID, branch: bundle.source.branchId }

  if (!annotations || !bundle.records.length) {
    return { row, work: null }
  }

  try {
    const whole = annotations.preview(bundle, target, { restore: true })
    const taken = whole.items.filter((item) => item.status === 'import').length

    row.existing = whole.items.filter((item) => item.status === 'skipped' && item.collides).length
    row.deleted = whole.items.filter((item) => item.status === 'skipped' && !item.collides && item.tombstoned).length
    row.rejected = whole.items.filter((item) => item.status === 'rejected').length
    row.reasons = whole.items.filter((item) => item.status === 'rejected').slice(0, 5).map((item) => `${item.uuid || `record ${item.index + 1}`}: ${item.reasons.join('; ')}`)

    if (locked || !taken) {
      return { row: { ...row, add: locked ? 0 : taken, restorable: taken }, work: null }
    }

    return { row: { ...row, add: taken, restorable: taken }, work: { campaignId, target, bundle, preview: whole } }
  } catch (error) {
    row.refused = error && error.message ? error.message : String(error)

    return { row, work: null }
  }
}

const NO_CHANGE = Object.freeze({ names: 0, gameIds: 0, attachments: 0, branches: 0, tips: 0, anchor: 0 })

const planCampaign = ({ io, registry, given, choice, annotations }) => {
  const stored = registry.campaigns[given.id] || null
  const notes = []
  const branchIds = Object.keys(given.branches).sort(branchOrder)
  let status

  if (stored) {
    status = anchorRelation(stored.anchor, given.entry.anchor) === 'conflict' ? 'conflict' : 'known'
  } else {
    const alike = Object.values(registry.campaigns).filter((campaign) => !campaign.mergedInto && campaign.gameIds.some((GameID) => given.entry.gameIds.includes(GameID)) && anchorRelation(campaign.anchor, given.entry.anchor) !== 'conflict')

    status = alike.length ? 'ambiguous' : 'new'

    if (alike.length) {
      notes.push(`It shares a game id with ${alike.map((campaign) => `"${lastName(campaign)}"`).join(', ')} and nothing tells them apart, so nothing is merged: it is restored as a campaign of its own`)
    }
  }

  if (status === 'conflict') {
    notes.push('The stored campaign of this id has a different galaxy, so nothing of this campaign is restored')
  }

  const relations = {}

  if (stored) {
    branchIds.forEach((branchId) => {
      relations[branchId] = stored.branches[branchId] ? tipRelation(stored.branches[branchId].tip, given.entry.branches[branchId].tip) : 'new'
    })
  }

  const skipped = status === 'conflict' || (choice.association === 'keep' && !stored)
  let entry = null
  let association = { added: { ...NO_CHANGE }, kept: [] }

  if (!skipped) {
    if (!stored) {
      entry = clone(given.entry)
    } else if (choice.association === 'merge') {
      const result = mergeEntry(stored, given.entry, relations)

      association = { added: result.added, kept: result.kept }
      entry = canonical(result.merged) === canonical(stored) ? null : result.merged
    } else {
      association.kept.push('the campaign record is kept as it is stored')
    }
  }

  const resulting = skipped ? {} : (entry || stored || { branches: {} }).branches
  const files = []
  const writes = { files: [], imports: [] }

  branchIds.forEach((branchId) => {
    const name = branchFileName(given.id, branchId)
    const requested = choice.files[branchId]
    const reason = skipped ? (status === 'conflict' ? 'the stored campaign has a different galaxy' : 'the campaign is not restored') : !resulting[branchId] ? 'the branch is not part of the stored campaign' : relations[branchId] === 'different' ? 'the backup holds a different timeline for this branch' : relations[branchId] === 'unknown' ? 'too little is recorded to tell whether the backup is the same timeline' : null
    const current = io.file(name).store
    const row = { branchId, name, requested: requested.policy, policy: reason ? 'keep' : requested.policy, locked: reason, races: requested.races, raceChoices: [], relation: stored ? relations[branchId] : 'new', series: [], totals: { stored: 0, backup: 0, added: 0, identical: 0, conflicts: 0, removed: 0, thinned: 0, result: 0 }, status: 'kept', stored: false }
    const file = withoutCoverage(given.branches[branchId])

    const racesOf = [file, isObject(current) ? current : {}]
    const raceName = (RaceID) => racesOf.map((item) => item.races && item.races[RaceID] && item.races[RaceID].raceName).find(Boolean)

    row.raceChoices = [...new Set([...seriesOf(file).values(), ...(usableFile(current) ? seriesOf(current).values() : [])].map((series) => series.owner))].sort((a, b) => Number(a) - Number(b)).map((RaceID) => ({ RaceID, label: `Race ${RaceID}${raceName(RaceID) ? ` (${raceName(RaceID)})` : ''}` }))
    row.stored = isObject(current) && Object.keys(current).length > 0

    if (!usableFile(current)) {
      row.policy = 'keep'
      row.locked = row.locked || 'the stored file is not a history file this version reads'
    }

    if (!row.locked) {
      const planned = planFile(isObject(current) ? current : {}, file, { policy: row.policy, races: requested.races })

      row.series = planned.rows
      row.totals = planned.totals

      if (row.policy !== 'keep' && canonical(planned.file) !== canonical(isObject(current) ? current : {})) {
        row.status = row.stored ? 'changes' : 'new'
        writes.files.push({ name, value: planned.file, from: hashValue(isObject(current) ? current : {}) })
      } else {
        row.status = row.policy === 'keep' ? 'kept' : 'unchanged'
      }
    }

    files.push(row)
  })

  const bundles = Array.isArray(given.annotations) ? given.annotations : []
  const groups = bundles.map((bundle) => {
    const file = files.find((candidate) => candidate.branchId === bundle.source.branchId)
    const locked = skipped ? 'the campaign is not restored' : !annotations ? 'annotations are not available here' : choice.annotations === 'keep' ? 'kept as stored' : file.locked ? 'the branch is not restored' : null
    const planned = planGroup(annotations, given.id, bundle, locked)

    if (planned.work) {
      writes.imports.push(planned.work)
    }

    return planned.row
  })

  return {
    stored: !!stored,
    entry,
    writes,
    view: {
      id: given.id,
      name: lastName(given.entry),
      status,
      skipped,
      notes,
      requested: choice.association,
      association: { policy: skipped ? 'keep' : choice.association, ...association, changed: !!entry },
      files,
      annotations: { policy: skipped || !annotations || !bundles.length ? 'keep' : choice.annotations, requested: choice.annotations, available: !!annotations, groups, total: bundles.reduce((sum, bundle) => sum + bundle.records.length, 0) },
    },
  }
}

// What restoring `envelope` would do to the stores of `io`, by the choices made (see `defaultChoices`): `{ preview, digest, writes }`. `preview` is plain data to show before anything is applied (per campaign: its status, what the record would gain and what it keeps, each history file's policy with its series' counts of stored, backup, added, identical, conflicting, removed and thinned snapshots and the result, and each group of annotations with how many would be added, are there already or were deleted since), `digest` identifies it, and `writes` is what `applyRestore` writes. Nothing is written here.
export const planRestore = ({ io, envelope, choices = {}, annotations = null }) => {
  const registry = readRegistry(io)
  const planned = envelope.campaigns.map((given) => planCampaign({ io, registry, given, choice: choiceOf(choices, given.id, Object.keys(given.branches)), annotations }))
  const registryChanges = {}
  const files = planned.flatMap((campaign) => campaign.writes.files)
  const imports = planned.flatMap((campaign) => campaign.writes.imports)

  planned.forEach((campaign) => {
    if (campaign.entry) {
      registry.campaigns[campaign.view.id] = campaign.entry
      registryChanges[campaign.view.id] = campaign.entry
    }
  })

  const campaigns = planned.map((campaign) => campaign.view)
  const confirmations = []

  campaigns.forEach((campaign) => {
    const removed = campaign.files.filter((file) => file.policy === 'replace').reduce((sum, file) => sum + file.totals.removed + file.totals.conflicts, 0)

    if (removed) {
      confirmations.push(`Replacing the history of "${campaign.name}" drops or overwrites ${removed} stored snapshot${removed === 1 ? '' : 's'}`)
    }

    if (campaign.status === 'ambiguous' && !campaign.skipped) {
      confirmations.push(`"${campaign.name}" is added as a campaign of its own beside one that may be the same`)
    }
  })

  const affected = planned.filter((campaign) => campaign.stored && (campaign.entry || campaign.writes.files.length || campaign.writes.imports.length)).map((campaign) => campaign.view.id)
  const totals = campaigns.reduce((sum, campaign) => ({
    campaigns: sum.campaigns + (campaign.skipped ? 0 : 1),
    files: sum.files + campaign.files.filter((file) => file.status === 'changes' || file.status === 'new').length,
    added: sum.added + campaign.files.reduce((total, file) => total + (file.policy === 'keep' ? 0 : file.totals.added), 0),
    conflicts: sum.conflicts + campaign.files.reduce((total, file) => total + (file.policy === 'keep' ? 0 : file.totals.conflicts), 0),
    removed: sum.removed + campaign.files.reduce((total, file) => total + (file.policy === 'replace' ? file.totals.removed : 0), 0),
    annotations: sum.annotations + campaign.annotations.groups.reduce((total, group) => total + group.add, 0),
    registry: sum.registry + (campaign.association.changed ? 1 : 0),
  }), { campaigns: 0, files: 0, added: 0, conflicts: 0, removed: 0, annotations: 0, registry: 0 })
  const writes = { files, registry: Object.keys(registryChanges).length ? registry : null, imports, affected }
  const digest = hashValue({ files, registry: registryChanges, imports: imports.map((work) => [work.campaignId, work.target, work.preview.digest]), preview: campaigns, confirmations })

  return { preview: { exportedAt: envelope.exportedAt, campaigns, totals, needsConfirmation: confirmations, nothingToDo: !files.length && !imports.length && !writes.registry }, digest, writes }
}

// ---- Keeping a backup before a restore -----------------------------------------------------------------------------

const keptEntry = (entry) => isObject(entry) && isNumber(entry.at) && isObject(entry.envelope) && typeof entry.label === 'string'

const keptStore = (io) => {
  const stored = io.backup ? io.backup.store : null

  return isObject(stored) ? stored : {}
}

// The backups made before restores, newest first: [{ at, label, envelope }].
export const keptBackups = (io) => {
  const { entries } = keptStore(io)

  return Array.isArray(entries) ? entries.filter(keptEntry) : []
}

// The restore that did not finish, if any: `{ at, id, key, label, envelope }`. Whatever is stored as unfinished counts, readable or not, so a damaged record is never taken for no record and never replaced: a field it lacks is filled with a stand-in (an id from a fingerprint of the stored value, so a different stored value is a different restore, an empty key that no restore has, a label naming it unreadable, the stored value itself as the envelope when that is no object), and `unfinishedProblem` says whether it can be read back. It holds the history as it was before that restore began, which the files the restore wrote before it stopped no longer do, so it is never aged out by the backups of later restores: it stays until that restore is finished by applying it again (the same backup with the same choices, its `key`) or is abandoned (by its `id`). No other restore completes it or is applied while it stays.
export const unfinishedRestore = (io) => {
  const { unfinished } = keptStore(io)

  if (unfinished === undefined || unfinished === null) {
    return null
  }

  const entry = isObject(unfinished) ? unfinished : {}
  const at = isNumber(entry.at) ? entry.at : 0
  const label = typeof entry.label === 'string' ? entry.label : 'an unreadable record of an unfinished restore'

  return { at, id: typeof entry.id === 'string' && entry.id ? entry.id : hashValue(['unnamed', unfinished]), key: typeof entry.key === 'string' ? entry.key : '', label, envelope: isObject(entry.envelope) ? entry.envelope : { unreadable: unfinished } }
}

const lastNames = (envelope) => envelope.campaigns.map((campaign) => (campaign.entry.names.length ? campaign.entry.names[campaign.entry.names.length - 1].name : campaign.id)).join(', ')

// What identifies a restore across its retries: the backup it restores from and the choices it was made with. Another backup, or the same one with other choices, is another restore.
const restoreKey = (envelope, choices) => hashValue({ source: envelope.digest, choices: canonical(choices) })

// Why the pinned copy cannot be read back, or null when it can: the same schema, digest and size checks as a backup that is picked, so a damaged copy is never taken for a recovery point.
export const unfinishedProblem = (held) => {
  const read = parseBackup(JSON.stringify(held.envelope))

  return read.errors ? read.errors[0] : null
}

// Throws Rejected, with nothing changed, when the pinned copy cannot be read back, and leaves the stored copy as it is.
const requireReadable = (held) => {
  const problem = unfinishedProblem(held)

  if (problem) {
    throw new Rejected(`The history kept for the unfinished restore cannot be read back (${problem}), so nothing was restored. It is left as it is in the backup store; abandon the unfinished restore to put it among the other copies`)
  }
}

// The restore a pinned copy belongs to is not the one being applied: nothing is written until it is finished or abandoned.
const requireContinuation = (held, key) => {
  if (held.key !== key) {
    throw new Rejected(`A restore that did not finish is still kept (${held.label}), so nothing was restored. Apply that restore again with the same choices to finish it, or abandon it first`)
  }
}

// The backup a restore is made from, kept before its first write and until it finishes. Only the restore that pinned a copy (its `key`) may use it again: the copy is checked as a file would be, reused and extended with the campaigns it does not hold yet; any other restore is refused while it stays. Throws Rejected, with nothing changed, when it cannot be made, is larger than a file is read at, cannot be kept, or cannot be read back.
const pinBackup = (io, { ids, at, key, annotations }) => {
  if (!io.backup) {
    throw new Rejected('There is nowhere to keep a backup of the current history, so nothing was restored')
  }

  const held = unfinishedRestore(io)

  if (held) {
    requireContinuation(held, key)
    requireReadable(held)
  }

  const missing = ids.filter((id) => !held || !held.envelope.campaigns.some((campaign) => campaign.id === id))

  if (held && !missing.length) {
    return held
  }

  let envelope

  try {
    envelope = buildBackup(io, { campaignIds: missing, at, annotations })

    if (held) {
      const campaigns = [...held.envelope.campaigns, ...envelope.campaigns]

      envelope = checkedBackup({ ...held.envelope, campaigns, digest: hashValue(campaigns) })
    }
  } catch (error) {
    if (error instanceof Rejected) {
      throw new Rejected(`The backup of the current history could not be made (${error.message}), so nothing was restored`)
    }

    throw error
  }

  const entry = { at: held ? held.at : envelope.exportedAt, id: held ? held.id : hashValue([envelope.exportedAt, envelope.digest]), key, label: `before restoring ${lastNames(envelope)}`, envelope }
  const before = keptStore(io)

  try {
    io.backup.store = { version: 1, entries: keptBackups(io), unfinished: entry }
  } catch (error) {
    throw new Rejected(`The backup of the current history could not be kept (${error && error.message ? error.message : String(error)}), so nothing was restored`)
  }

  const kept = unfinishedRestore(io)
  const read = kept ? parseBackup(JSON.stringify(kept.envelope)) : { errors: ['it is not there'] }

  if (!kept || kept.at !== entry.at || read.errors || read.envelope.digest !== envelope.digest) {
    try {
      io.backup.store = before
    } catch (error) {
      throw new Rejected(`The backup of the current history was not kept so that it can be read back, and could not be taken out again (${error && error.message ? error.message : String(error)}); it is listed as unfinished and can be abandoned`)
    }

    throw new Rejected('The backup of the current history was not kept so that it can be read back, so nothing was restored')
  }

  return kept
}

// The pinned backup is filed with the others, newest first: the restore it protected is finished, or abandoned.
const fileAway = (io, held) => {
  try {
    io.backup.store = { version: 1, entries: [{ at: held.at, label: held.label, envelope: held.envelope }, ...keptBackups(io)].slice(0, KEPT_BACKUPS) }
  } catch (error) {
    throw new Rejected(`The backup kept before the restore could not be filed with the others (${error && error.message ? error.message : String(error)}); it stays listed as unfinished until it is abandoned`)
  }

  return { at: held.at, label: held.label }
}

// Stops treating the restore with the pin `expectedId` as unfinished: its backup is filed with the others, where later restores age it out, and nothing else changes. Returns the filed backup, or null when no restore is unfinished. A pin that is not `expectedId` (another window finished that restore or began another since it was shown) is refused and left as it is. The caller holds the registry lock (`withRegistry`).
export const abandonRestore = (io, expectedId) => {
  requireRecording()

  const held = unfinishedRestore(io)

  if (!held) {
    return null
  }

  if (held.id !== expectedId) {
    throw new Rejected(`The unfinished restore is not the one that was shown (${held.label} is kept now), so none was abandoned`)
  }

  return fileAway(io, held)
}

// Restores `envelope` into the stores of `io` by `choices`, for the player who saw the preview with the digest `expected`. Nothing is written when this tab does not record (ReadOnly), when the plan made now (and again after the wait for the annotation files) differs from the preview (Changed), when the preview asked for a confirmation that `confirmed` does not give, when the backup of the current history cannot be made, kept and read back first, or when another restore is unfinished (its kept backup stays until that restore, the same backup with the same choices, is applied again to the end, or it is abandoned). The caller holds the registry lock (`withRegistry`). The order is the backup, the history files, the annotations and the registry last, and each step can be made again: a restore that stopped part way is run again, keeps its first backup (see `unfinishedRestore`) and finds what it already did; when nothing is left to do, running it again files that backup. `guard()` is called before each write. Returns `{ applied, files, imports, registry, backup }`.
export const applyRestore = async ({ io, envelope, choices = {}, expected, confirmed = false, now = Date.now, guard = () => {}, annotations = null }) => {
  requireRecording()

  const key = restoreKey(envelope, choices)
  const { preview, digest, writes } = planRestore({ io, envelope, choices, annotations })

  if (digest !== expected) {
    throw new Changed()
  }

  if (preview.needsConfirmation.length && !confirmed) {
    throw new Rejected('The restore needs the confirmation the preview asks for')
  }

  if (preview.nothingToDo) {
    const finished = unfinishedRestore(io)

    if (!finished || finished.key !== key) {
      return { applied: false, files: 0, imports: 0, registry: false, backup: null }
    }

    requireReadable(finished)

    return { applied: false, files: 0, imports: 0, registry: false, backup: fileAway(io, finished) }
  }

  for (const work of writes.imports) {
    if (!(await annotations.writable(work.campaignId))) {
      throw new Rejected(`This tab may not write the annotations of the campaign ${work.campaignId} now; another tab holds them, so nothing was restored`)
    }
  }

  if (writes.imports.length) {
    requireRecording()

    if (planRestore({ io, envelope, choices, annotations }).digest !== expected) {
      throw new Changed()
    }
  }

  const pinned = unfinishedRestore(io)

  if (pinned) {
    requireContinuation(pinned, key)
  }

  let held = pinned

  if (writes.affected.length) {
    guard()
    held = pinBackup(io, { ids: writes.affected, at: now(), key, annotations })
  } else if (pinned) {
    requireReadable(pinned)
  }

  writes.files.forEach(({ name, value }) => {
    guard()
    io.file(name).store = value
  })

  let imported = 0

  writes.imports.forEach((work) => {
    guard()
    imported += annotations.import(work.bundle, work.target, { preview: work.preview, restore: true }).imported.length
  })

  if (writes.registry) {
    guard()
    writeRegistry(io, writes.registry)
  }

  return { applied: true, files: writes.files.length, imports: imported, registry: !!writes.registry, backup: held ? fileAway(io, held) : null }
}
