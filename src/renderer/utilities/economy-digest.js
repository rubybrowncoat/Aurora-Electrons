// The economic change digest: what the saves the app observed show of the race's economy since the last acknowledged save, as the net difference of two observed boundaries and nothing between them.
//
// The two boundaries are snapshots of the branch's own history (utilities/history.js): the acknowledged one, kept whole in the digest's own store file, and the one recorded for the open save. What is compared:
// - finished production: the installations of each type and the ships of the race's colonies and fleets, summed as the snapshots hold them. A rise is installations or ships that the save shows and the earlier one did not; the game says nothing of how they came to be, and a build that started and finished between the two is one net change, never two events;
// - bottlenecks: a stockpile of the colonies summed to none, or back above none, and the treasury below nothing, or back above it; for the colonies the History page follows (utilities/colony-series.js) the same per colony, and a followed colony that is gone or another race's;
// - project notes: the notes of the race on the branch (utilities/economy-notes.js) as they were kept at the acknowledgment against now: a note added, removed or edited.
// Changes are grouped by the object they are about: a followed colony takes its production-side changes and the notes about it (or about its body); a note about a body, fleet or tech has a group of its own; what is summed over the race is one group.
//
// Observation gaps are never filled. Two saves seen can be far apart in game time (the saves between were never open while the app ran, or the older ones were thinned away); the digest says how many saves were seen between the boundaries, the longest stretch with none, and how many ledger increments the stretch spans when both snapshots carry a ledger witness. Anything that began and ended inside a stretch (a build that finished and was spent, a stock that emptied and refilled, a note edited and edited back) leaves no trace here.
//
// An acknowledgment is a record of the race in its campaign and branch, kept in a store file of its own, `economy-digest/campaign-<campaign id>`, and in no shared document: { races: { [RaceID]: { version, branches: { [branchId]: { at, snapshot, colonies, notes, items } } } } }. Only the digest's writers write that file, so no other settings writer can write an older copy of the document over an acknowledgment (the browser build's settings store replaces its whole document), and the settings reset, the preferences export and import and the history backup and restore (which read named files of the history folder and the settings the pages declare) neither carry nor erase it. `snapshot` holds the figures the digest reads of the save at the boundary (with its ledger witness), `colonies` the followed colonies' rows at that game time, `notes` the notes as kept then (null when they could not be read), and `items` the changes acknowledged one at a time, each with the signature of the change it was acknowledged at. A branch's record is its own: no other branch of the campaign, and no other campaign, ever reads it, a fork starts with none (an attach copies settings and history files, never this one), and no comparison runs when the open save lies before the boundary or its ledger does not extend the boundary's. Nothing is written to a save.

import Config from 'electron-store'
import { COLONY_COLUMNS, COLONY_STATES, COLONY_STATE_TEXT } from './colony-series'
import { isKnownNumber } from './math'
import { MINERALS } from './minerals'
import { combine, ofRule, registerRule, unavailable } from './provenance'

const DIGEST_VERSIONS = ['2.7.x']

registerRule({
  id: 'digest.installations',
  versions: DIGEST_VERSIONS,
  units: 'installations',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount', 'two snapshots of the app\'s history file'],
  note: 'The installations of one type over the race\'s colonies in the open save less those at the acknowledged boundary, as the two snapshots hold them. A rise is installations the save shows and the boundary did not; the game does not say they were built, and a build started and finished between the two is one net change. A type the boundary lists without an amount, or a snapshot with no installations, leaves the change unknown.',
})

registerRule({
  id: 'digest.ships',
  versions: DIGEST_VERSIONS,
  units: 'ships',
  verification: 'confirmed',
  structure: ['FCT_Ship, FCT_ShipClass.Commercial', 'two snapshots of the app\'s history file'],
  note: 'The race\'s military or commercial ships of non-shipping-line fleets in the open save less those at the boundary. A rise is ships the save shows and the boundary did not, however they came to be; ships gained and lost between the two cancel.',
})

registerRule({
  id: 'digest.stock',
  versions: DIGEST_VERSIONS,
  units: 'as the stockpile',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelStockpile, MaintenanceStockpile, Duranium to Gallicite', 'two snapshots of the app\'s history file'],
  note: 'The stockpile of one fuel, maintenance supply or mineral over the race\'s colonies, summed, in the open save less the boundary. It is a bottleneck only in the sense that the sum is none: one colony may hold stock while the rest run dry, and a sum with a colony\'s amount missing is unknown, never 0. A stock that emptied and refilled between the two saves leaves no trace.',
})

registerRule({
  id: 'digest.treasury',
  versions: DIGEST_VERSIONS,
  units: 'wealth',
  verification: 'confirmed',
  structure: ['FCT_Race.WealthPoints', 'two snapshots of the app\'s history file'],
  note: 'The race\'s stored treasury in the open save less the boundary. A treasury below nothing is read as overdrawn; what the game does about one is not checked here, and the snapshots do not show what moved the treasury.',
})

registerRule({
  id: 'digest.colonyStock',
  versions: DIGEST_VERSIONS,
  units: 'as the stockpile',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelStockpile, MaintenanceStockpile, Duranium to Gallicite', 'the colony series of the app\'s history'],
  note: 'One followed colony\'s stockpile in the open save less its stockpile at the boundary, both observed. A stock that emptied and refilled between the two saves leaves no trace, and a colony that was not followed at the boundary has no earlier figure.',
})

registerRule({
  id: 'digest.colonyState',
  versions: DIGEST_VERSIONS,
  units: 'states',
  verification: 'confirmed',
  structure: ['FCT_Population.RaceID, SystemBodyID', 'the colony series of the app\'s history'],
  note: 'Whether the followed colony was the race\'s observed colony at the boundary and is in the open save: 1 for a colony that is no longer in the save, is another race\'s or is on another body, and -1 for one that is observed again. A colony not read in either save has no state.',
})

registerRule({
  id: 'digest.note',
  versions: DIGEST_VERSIONS,
  units: 'fields',
  verification: 'confirmed',
  structure: ['the race\'s project notes in the app\'s scenario records'],
  note: 'How many of a note\'s title, status, next action and linked object differ from the note kept at the boundary; 1 for a note added or removed. Notes are the player\'s own records, compared as stored, and are not read from the save.',
})

registerRule({
  id: 'digest.coverage',
  versions: DIGEST_VERSIONS,
  units: 's',
  verification: 'confirmed',
  structure: ['snapshot game times', 'the ledger witness of two snapshots'],
  note: 'The game time between two saves the app observed and how many saves it observed between them. The longest stretch without a save is the widest interval over which a change is known only by its net result; nothing in it is inferred.',
})

export const DIGEST_FOLDER = 'economy-digest'
export const DIGEST_VERSION = 1

// The most notes a record keeps as the baseline (a race with more has its notes left out of the comparison and says so, since the file holds every race of the campaign) and the most changes acknowledged one at a time.
export const MAX_NOTES = 200
export const MAX_ITEMS = 500

// The part of a record's key a state of the digest is read by.
export const STATES = Object.freeze({
  READY: 'ready',
  NONE: 'none',
  REWOUND: 'rewound',
  DIVERGED: 'diverged',
  UNRECORDED: 'unrecorded',
  WAITING: 'waiting',
  UNCONFIRMED: 'unconfirmed',
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const isChain = (chain) => isObject(chain) && Number.isInteger(chain.n) && chain.n > 0 && typeof chain.digest === 'string' && /^[0-9a-f]{16}$/.test(chain.digest)

// ---- The record --------------------------------------------------------------------------------------------------------

export class DigestLimit extends Error {
  constructor () {
    super(`At most ${MAX_ITEMS} changes can be acknowledged one at a time; acknowledge the digest as a whole to start again from the open save`)
    this.name = 'DigestLimit'
  }
}

// The record was changed after the page read it (another window, another save): nothing was written.
export class DigestChanged extends Error {
  constructor () {
    super('The acknowledgment was changed after it was read here, so nothing was written; the digest reads it again')
    this.name = 'DigestChanged'
  }
}

// The campaign, branch or race the panel shows changed while an acknowledgment waited for its turn: nothing was written, since it was made for another scope.
export class DigestScopeChanged extends Error {
  constructor () {
    super('The campaign, branch or race changed while the acknowledgment waited, so nothing was written')
    this.name = 'DigestScopeChanged'
  }
}

// The stored value cannot be read by this version: nothing is written over it.
export class DigestUnreadable extends Error {
  constructor (reason) {
    super(`The stored acknowledgments cannot be read (${reason}), so nothing was written over them`)
    this.name = 'DigestUnreadable'
  }
}

// The stored list of one figure of a snapshot: undefined (not kept), or a list of numbers and nulls.
const validFigures = (list) => list === undefined || (Array.isArray(list) && list.every((value) => value === null || Number.isFinite(value)))

const validSnapshot = (snapshot) => isObject(snapshot) && Number.isFinite(snapshot.t) && (snapshot.chain === undefined || isChain(snapshot.chain)) && validFigures(snapshot.minerals) && (snapshot.installations === undefined || (isObject(snapshot.installations) && Object.values(snapshot.installations).every((value) => value === null || Number.isFinite(value)))) && ['wealth', 'fuel', 'msp', 'militaryShips', 'commercialShips'].every((key) => snapshot[key] === undefined || snapshot[key] === null || Number.isFinite(snapshot[key]))

const validColonies = (colonies) => isObject(colonies) && Object.entries(colonies).every(([id, row]) => /^\d+$/.test(id) && Array.isArray(row) && row.length >= 1 && Number.isInteger(row[0]) && row.slice(1).every((value) => value === null || Number.isFinite(value)))

const validNote = (note) => isObject(note) && typeof note.title === 'string' && typeof note.status === 'string' && typeof note.next === 'string' && typeof note.type === 'string' && (typeof note.id === 'string' || Number.isFinite(note.id)) && typeof note.name === 'string' && typeof note.fingerprint === 'string' && typeof note.origin === 'string'

const validNotes = (notes) => notes === null || (isObject(notes) && Object.keys(notes).length <= MAX_NOTES && Object.values(notes).every(validNote))

const validItems = (items) => isObject(items) && Object.keys(items).length <= MAX_ITEMS && Object.values(items).every((signature) => typeof signature === 'string')

const validRecord = (record) => isObject(record) && Number.isFinite(record.at) && validSnapshot(record.snapshot) && validColonies(record.colonies) && validNotes(record.notes) && validItems(record.items)

export const emptyStore = () => ({ version: DIGEST_VERSION, branches: {} })

// The stored value as the digest's store: { ok: true, store }, an empty one when nothing is stored, or { ok: false, reason } when it is not one this version reads (the page then shows the digest as unavailable and writes nothing over it).
export const readStore = (value) => {
  if (value === undefined || value === null) {
    return { ok: true, store: emptyStore() }
  }

  if (!isObject(value) || value.version !== DIGEST_VERSION || !isObject(value.branches)) {
    return { ok: false, reason: 'another version wrote it or it is damaged' }
  }

  const damaged = Object.entries(value.branches).find(([, record]) => !validRecord(record))

  return damaged ? { ok: false, reason: `the record of branch ${damaged[0]} is damaged` } : { ok: true, store: value }
}

// A branch's own record, or null. A fork never reads its parent's, and no branch reads another's.
export const recordOf = (store, branchId) => (store && typeof branchId === 'string' && hasOwn(store.branches, branchId) ? store.branches[branchId] : null)

export const withRecord = (store, branchId, record) => ({ ...store, branches: { ...store.branches, [branchId]: record } })

// The store with one change acknowledged on its own, at the signature it had (`key` and `signature` of a digest's item). A change already acknowledged at that signature is left as it is.
export const withItem = (store, branchId, key, signature) => {
  const record = recordOf(store, branchId)

  if (!record) {
    return store
  }

  if (!hasOwn(record.items, key) && Object.keys(record.items).length >= MAX_ITEMS) {
    throw new DigestLimit()
  }

  return withRecord(store, branchId, { ...record, items: { ...record.items, [key]: signature } })
}

// The store with an acknowledged change shown again.
export const withoutItem = (store, branchId, key) => {
  const record = recordOf(store, branchId)

  if (!record || !hasOwn(record.items, key)) {
    return store
  }

  const items = { ...record.items }

  delete items[key]

  return withRecord(store, branchId, { ...record, items })
}

// The record that acknowledges a digest as a whole: its boundary becomes the open save (`now` of the digest), with no change acknowledged one at a time.
export const recordFrom = (now, at) => ({ at, snapshot: now.snapshot, colonies: now.colonies, notes: now.notes, items: {} })

// The digest's store file of one campaign: the store of `economy-digest/campaign-<campaign id>`, a file no other writer of the app opens. `Store` is the store class (electron-store's, or the web build's stand-in). The store is strict, as the scenario records' are: a file that is not valid JSON is an error on every read and write, never an empty store that an acknowledgment would then overwrite (the app's store host answers with the damaged file's name for the same file).
export const digestStore = (campaignId, Store = Config) => {
  if (typeof campaignId !== 'string' || !/^[\w-]+$/.test(campaignId)) {
    throw new Error('The acknowledgments of an economic change need a campaign')
  }

  return new Store({ cwd: DIGEST_FOLDER, name: `campaign-${campaignId}`, strict: true })
}

// One race's store as the file holds it: { ok: true, store }, an empty one when the file or the race has none, or { ok: false, reason } when the file or the race's record is not one this version reads.
export const readRace = (races, RaceID) => {
  if (races === undefined || races === null) {
    return readStore(undefined)
  }

  if (!isObject(races)) {
    return { ok: false, reason: 'the file is damaged' }
  }

  return readStore(hasOwn(races, RaceID) ? races[RaceID] : undefined)
}

// Changes one race's store as `change(store)` says, in one read-change-write of the digest's file (so another window's write is not lost), and returns the store written. A file or a store this version cannot read, or a change that throws, writes nothing.
export const saveDigest = (store, RaceID, change) => {
  let written = null

  store.update((document) => {
    if (!isObject(document) || (document.races !== undefined && !isObject(document.races))) {
      throw new DigestUnreadable('the file is damaged')
    }

    const read = readRace(document.races, RaceID)

    if (!read.ok) {
      throw new DigestUnreadable(read.reason)
    }

    written = change(read.store)

    return { ...document, races: { ...document.races, [RaceID]: written } }
  })

  return written
}

// The browser build's store cannot compare and swap: the tabs of one browser share localStorage, and a tab can write between another's read and write of the whole document. No lock was available to keep one at a time, so nothing was written.
export class DigestUnprotected extends Error {
  constructor () {
    super('This browser has no Web Locks, so no tab can be the only one to write the acknowledgments, and nothing was written')
    this.name = 'DigestUnprotected'
  }
}

export const DIGEST_LOCK = 'aurora-electrons:economy-digest'

const browserLocks = () => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null)

// `saveDigest` kept to one writer at a time where the store is not atomic across windows (the store class says so with `writesNeedOwner`, as the scenario records' storage reads it): the stored record is read, compared (`guarded`) and written inside one exclusive Web Lock shared by every tab, so an acknowledgment made on a record another tab has changed since is refused, never written over it. The digest's file has no other writer, so the lock covers all of them. With no Web Locks the write is refused. The Electron store's own compare-and-swap `update` needs none.
export const saveDigestSafely = async (store, RaceID, change, locks = browserLocks()) => {
  if (!store || !store.constructor || store.constructor.writesNeedOwner !== true) {
    return saveDigest(store, RaceID, change)
  }

  if (!locks) {
    throw new DigestUnprotected()
  }

  return locks.request(DIGEST_LOCK, () => saveDigest(store, RaceID, change))
}

// The change to a store that writes `next` as the branch's record only while the stored record is still the one the page read (`expected`, as `recordOf` gave it or null), so an acknowledgment made on a digest that has since changed is refused. `next(store)` gives the store.
export const guarded = (branchId, expected, next) => (store) => {
  if (JSON.stringify(recordOf(store, branchId)) !== JSON.stringify(expected)) {
    throw new DigestChanged()
  }

  return next(store)
}

// ---- What a boundary keeps ---------------------------------------------------------------------------------------------

const SNAPSHOT_KEYS = ['t', 'wealth', 'fuel', 'msp', 'minerals', 'militaryShips', 'commercialShips', 'installations', 'chain']

// The figures of a snapshot the digest reads, as a boundary keeps them.
export const pickSnapshot = (snapshot) => JSON.parse(JSON.stringify(Object.fromEntries(SNAPSHOT_KEYS.filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]]))))

// The snapshot recorded at exactly game time `t`, or null.
export const snapshotAt = (snapshots, t) => snapshots.find((snapshot) => snapshot.t === t) || null

// The followed colonies' rows `{ [PopulationID]: [state, ...values] }` of the colony series at game time `t`, or null when the series holds no snapshot then or holds one of another ledger (`n`, the increments of the empire snapshot's ledger witness, null when it has none).
export const colonyRowsAt = (colonyRecord, t, n) => {
  const snapshot = colonyRecord && Array.isArray(colonyRecord.snapshots) ? colonyRecord.snapshots.find((candidate) => candidate.t === t) : null

  if (!snapshot || !Array.isArray(snapshot.colonies) || (n !== null && snapshot.n !== n)) {
    return null
  }

  return Object.fromEntries(snapshot.colonies.filter((row) => Array.isArray(row)).map((row) => [row[0], row.slice(1)]))
}

// The link identity of a note as the Notebook keeps it: the fingerprint the object's row had when the link was made and the campaign and branch the link was made on. The ID alone is not an identity, since a fork can reuse it for another object; the name is not one either, since a rename keeps the link.
const linkIdentity = (entry) => ({ fingerprint: Array.isArray(entry.links) && entry.links.length && typeof entry.links[0].fingerprint === 'string' ? entry.links[0].fingerprint : '', origin: isObject(entry.target.origin) ? `${entry.target.origin.campaignId}/${entry.target.origin.branchId}` : '' })

const noteFields = (entry) => ({ title: entry.title, status: entry.status, next: entry.next, type: entry.target.type, id: entry.target.id, name: entry.target.name, ...linkIdentity(entry) })

// Whether the Notebook's check finds the object the note links to still the one that was linked: only then is the note about the live object with its ID.
const liveLink = (entry) => isObject(entry.link) && entry.link.status === 'linked'

// The notes as a boundary keeps them, `{ [uuid]: { title, status, next, type, id, name } }`, or null when they could not be read (`entries` null) or are more than the record holds: no change of a note is then compared.
export const noteBaseline = (entries) => (Array.isArray(entries) && entries.length <= MAX_NOTES ? Object.fromEntries(entries.map((entry) => [entry.uuid, noteFields(entry)])) : null)

// ---- Judging a comparison ----------------------------------------------------------------------------------------------

// Whether the acknowledged boundary (`from`, a snapshot) and the open save's snapshot (`to`) can be compared, `snapshots` being the branch's recorded series: { ok: true }, or { ok: false, state, reason }.
// - the open save lies before the boundary: the game was rewound past it, and the changes between are not the open save's to show;
// - the ledger witnesses disagree: the open save's has fewer increments than the boundary's, or the same count with another digest, so it is not the boundary's history continued;
// - the series holds a snapshot at the boundary's time with another witness: what was recorded there is not what was acknowledged.
export const judgeBoundary = ({ from, to, snapshots }) => {
  if (to.t < from.t) {
    return { ok: false, state: STATES.REWOUND, reason: 'The open save lies before the acknowledged boundary, so the changes since it are not comparable here. They show again once the game passes the boundary.' }
  }

  if (from.chain && to.chain && (to.chain.n < from.chain.n || (to.chain.n === from.chain.n && to.chain.digest !== from.chain.digest))) {
    return { ok: false, state: STATES.DIVERGED, reason: 'The ledger of the open save does not continue the ledger of the acknowledged boundary, so the two are not one history and no comparison is made.' }
  }

  const recorded = snapshotAt(snapshots, from.t)

  if (recorded && recorded.chain && from.chain && (recorded.chain.n !== from.chain.n || recorded.chain.digest !== from.chain.digest)) {
    return { ok: false, state: STATES.DIVERGED, reason: 'The history recorded at the acknowledged boundary is not the save that was acknowledged, so no comparison is made.' }
  }

  return { ok: true }
}

// ---- Coverage ----------------------------------------------------------------------------------------------------------

// What the observation covers between the boundary and the open save: { seconds, observed, gaps, largest, increments, thinning }. `observed` counts the saves the app recorded strictly between the two, `gaps` the stretches between neighbouring observations (the boundary and the open save included), `largest` the longest of them, `increments` how many ledger increments the two witnesses span (null when either lacks one), and `thinning` the status of the series' thinning (history.js `thinningStatus`), null when it is not known.
export const coverageOf = ({ from, to, snapshots, thinning = null }) => {
  const between = snapshots.filter((snapshot) => snapshot.t > from.t && snapshot.t < to.t).map((snapshot) => snapshot.t)
  const times = to.t > from.t ? [from.t, ...between, to.t] : [from.t]
  const gaps = times.slice(1).map((t, index) => ({ from: times[index], to: t, seconds: t - times[index] }))
  const spans = from.chain && to.chain && to.chain.n >= from.chain.n

  return {
    seconds: to.t - from.t,
    observed: between.length,
    gaps,
    largest: gaps.length ? Math.max(...gaps.map((gap) => gap.seconds)) : null,
    increments: spans ? to.chain.n - from.chain.n : null,
    thinning: thinning ? thinning.status : null,
    result: ofRule({ rule: 'digest.coverage', value: to.t - from.t, inputs: { present: ['snapshot game times'] } }),
  }
}

// ---- The changes -------------------------------------------------------------------------------------------------------

const figure = (rule, label, value) => (isKnownNumber(value) ? ofRule({ rule, value: Number(value), inputs: { present: [label] } }) : unavailable({ rule, missing: [label] }))

const changeOf = (rule, earlier, later) => combine({ rule, parts: { earlier, later }, compute: (values) => values.later - values.earlier })

const hasInstallations = (snapshot) => isObject(snapshot.installations)

// An installation type's amount in a snapshot: none built when the snapshot lists installations without it, unknown when it lists none at all or a null amount for it.
const installationAmount = (snapshot, id, label) => {
  if (!hasInstallations(snapshot)) {
    return unavailable({ rule: 'digest.installations', missing: [`${label} installations`] })
  }

  return hasOwn(snapshot.installations, id) ? figure('digest.installations', `${label} installations`, snapshot.installations[id]) : ofRule({ rule: 'digest.installations', value: 0, inputs: { present: [`${label} installations`] } })
}

const STOCKS = Object.freeze([
  Object.freeze({ id: 'fuel', label: 'Fuel', units: 'L', read: (snapshot) => snapshot.fuel }),
  Object.freeze({ id: 'msp', label: 'Maintenance supplies', units: 'MSP', read: (snapshot) => snapshot.msp }),
  ...MINERALS.map((mineral) => Object.freeze({ id: `mineral:${mineral.id}`, label: mineral.name, units: 't', read: (snapshot) => (Array.isArray(snapshot.minerals) ? snapshot.minerals[mineral.id - 1] : undefined) })),
])

// `index` is the figure's place in a colony row once its state is taken off the front (`colonyRowsAt`): the state is first, the figures follow in COLONY_COLUMNS order.
const COLONY_STOCKS = Object.freeze(COLONY_COLUMNS.filter((column) => column !== 'population').map((column) => Object.freeze({ id: column, label: column === 'fuel' ? 'Fuel' : column === 'msp' ? 'Maintenance supplies' : column, units: column === 'fuel' ? 'L' : column === 'msp' ? 'MSP' : 't', index: COLONY_COLUMNS.indexOf(column) + 1 })))

// The items an empire-wide comparison finds: { items, unknown }. `names` maps an installation type's ID to its name.
const empireChanges = (from, to, names) => {
  const items = []
  const unknown = []
  const group = { type: 'empire', id: 0, name: 'The race\'s colonies and fleets, summed' }

  const known = (key, label, change, item) => {
    if (change.value === null) {
      unknown.push({ key, label, missing: change.inputs.missing, result: change })

      return
    }

    if (change.value !== 0) {
      items.push({ ...item, key, label, group, result: change, change: change.value })
    }
  }

  if (!hasInstallations(from) || !hasInstallations(to)) {
    unknown.push({ key: 'production:installations', label: 'Installations', missing: [hasInstallations(from) ? 'installations of the open save' : 'installations at the boundary'], result: unavailable({ rule: 'digest.installations', missing: [hasInstallations(from) ? 'installations of the open save' : 'installations at the boundary'] }) })
  } else {
    const ids = [...new Set([...Object.keys(from.installations), ...Object.keys(to.installations)])].sort((a, b) => Number(a) - Number(b))

    ids.forEach((id) => {
      const label = names[id] || `Installation ${id}`
      const earlier = installationAmount(from, id, label)
      const later = installationAmount(to, id, label)

      known(`production:installation:${id}`, label, changeOf('digest.installations', earlier, later), { kind: 'production', area: 'installations', from: earlier.value, to: later.value, direction: null })
    })
  }

  ;[['military', 'Military ships', 'militaryShips'], ['commercial', 'Commercial ships', 'commercialShips']].forEach(([id, label, field]) => {
    const earlier = figure('digest.ships', label, from[field])
    const later = figure('digest.ships', label, to[field])

    known(`production:ships:${id}`, label, changeOf('digest.ships', earlier, later), { kind: 'production', area: 'ships', from: earlier.value, to: later.value, direction: null })
  })

  STOCKS.forEach((stock) => {
    const earlier = figure('digest.stock', `${stock.label} stockpile`, stock.read(from))
    const later = figure('digest.stock', `${stock.label} stockpile`, stock.read(to))
    const change = changeOf('digest.stock', earlier, later)

    if (change.value === null) {
      unknown.push({ key: `bottleneck:stock:${stock.id}`, label: `${stock.label} stockpile`, missing: change.inputs.missing, result: change })
    } else if ((earlier.value > 0) !== (later.value > 0)) {
      items.push({ kind: 'bottleneck', area: 'stock', key: `bottleneck:stock:${stock.id}`, label: stock.label, units: stock.units, from: earlier.value, to: later.value, change: change.value, direction: later.value > 0 ? 'refilled' : 'emptied', group, result: change })
    }
  })

  const wealthBefore = figure('digest.treasury', 'treasury', from.wealth)
  const wealthNow = figure('digest.treasury', 'treasury', to.wealth)
  const wealth = changeOf('digest.treasury', wealthBefore, wealthNow)

  if (wealth.value === null) {
    unknown.push({ key: 'bottleneck:treasury', label: 'Treasury', missing: wealth.inputs.missing, result: wealth })
  } else if ((wealthBefore.value < 0) !== (wealthNow.value < 0)) {
    items.push({ kind: 'bottleneck', area: 'treasury', key: 'bottleneck:treasury', label: 'Treasury', units: 'wealth', from: wealthBefore.value, to: wealthNow.value, change: wealth.value, direction: wealthNow.value < 0 ? 'overdrawn' : 'credit', group, result: wealth })
  }

  return { items, unknown }
}

// The followed colonies' changes between two sets of rows (`before` at the boundary, `now` at the open save, `{ [id]: [state, ...values] }`): { items, unknown }. A colony with no row at the boundary was not followed then and has nothing to compare; a colony not read in either save is unknown.
const colonyChanges = (before, now, nameOf) => {
  const items = []
  const unknown = []

  Object.keys(now).forEach((id) => {
    if (!hasOwn(before, id)) {
      return
    }

    const group = { type: 'colony', id: Number(id), name: nameOf(Number(id)) }
    const [stateBefore] = before[id]
    const [stateNow] = now[id]

    if (stateBefore === COLONY_STATES.UNAVAILABLE || stateNow === COLONY_STATES.UNAVAILABLE) {
      unknown.push({ key: `colony:${id}`, label: `${group.name}`, missing: ['the colony\'s row in one of the saves'], result: unavailable({ rule: 'digest.colonyState', missing: ['the colony\'s row in one of the saves'] }) })

      return
    }

    if ((stateBefore === COLONY_STATES.OBSERVED) !== (stateNow === COLONY_STATES.OBSERVED)) {
      const lost = stateNow !== COLONY_STATES.OBSERVED
      const result = ofRule({ rule: 'digest.colonyState', value: lost ? 1 : -1, inputs: { present: ['the colony series'] } })

      items.push({ kind: 'colony', area: 'state', key: `colony:${id}:state`, label: group.name, direction: lost ? 'lost' : 'regained', state: lost ? stateNow : stateBefore, group, result, change: result.value, from: null, to: null })

      return
    }

    if (stateNow !== COLONY_STATES.OBSERVED) {
      return
    }

    COLONY_STOCKS.forEach((stock) => {
      const earlier = figure('digest.colonyStock', `${group.name} ${stock.label} stockpile`, before[id][stock.index])
      const later = figure('digest.colonyStock', `${group.name} ${stock.label} stockpile`, now[id][stock.index])
      const change = changeOf('digest.colonyStock', earlier, later)

      if (change.value === null) {
        unknown.push({ key: `colony:${id}:stock:${stock.id}`, label: `${group.name}: ${stock.label} stockpile`, missing: change.inputs.missing, result: change })
      } else if ((earlier.value > 0) !== (later.value > 0)) {
        items.push({ kind: 'bottleneck', area: 'colonyStock', key: `colony:${id}:stock:${stock.id}`, label: stock.label, units: stock.units, from: earlier.value, to: later.value, change: change.value, direction: later.value > 0 ? 'refilled' : 'emptied', group, result: change })
      }
    })
  })

  return { items, unknown }
}

const FIELD_LABELS = Object.freeze({ title: 'title', status: 'status', next: 'next action', link: 'linked object' })

// The notes' changes between the baseline kept at the boundary (`before`, null when unknown) and the notes now (`entries`, null when they could not be read): { items, unknown }. A note is compared by its title, status, next action and linked object (type and ID, never the name it shows); a note is never matched to another by its title.
const noteChanges = (before, entries) => {
  if (before === null || entries === null) {
    const missing = [before === null ? 'the notes kept at the boundary' : 'a complete read of the notes of this branch']

    return { items: [], unknown: [{ key: 'note:all', label: 'Project notes', missing, result: unavailable({ rule: 'digest.note', missing }) }] }
  }

  const items = []
  const now = new Map(entries.map((entry) => [entry.uuid, entry]))
  const groupOf = (type, id, name, live) => ({ type, id, name, live })

  entries.forEach((entry) => {
    const fields = noteFields(entry)
    const group = groupOf(fields.type, fields.id, fields.name, liveLink(entry))

    if (!hasOwn(before, entry.uuid)) {
      const result = ofRule({ rule: 'digest.note', value: 1, inputs: { present: ['the project notes'] } })

      items.push({ kind: 'note', area: 'note', key: `note:${entry.uuid}`, direction: 'added', label: fields.title, note: fields, group, result, change: 1, changes: [], signature: JSON.stringify(['added', fields.title, fields.status, fields.next, fields.type, fields.id, fields.fingerprint, fields.origin]) })

      return
    }

    const old = before[entry.uuid]
    const changes = [
      ...(old.title !== fields.title ? [{ field: 'title', from: old.title, to: fields.title }] : []),
      ...(old.status !== fields.status ? [{ field: 'status', from: old.status, to: fields.status }] : []),
      ...(old.next !== fields.next ? [{ field: 'next', from: old.next, to: fields.next }] : []),
      ...(old.type !== fields.type || old.id !== fields.id || old.fingerprint !== fields.fingerprint || old.origin !== fields.origin ? [{ field: 'link', from: `${old.type}:${old.id}`, to: `${fields.type}:${fields.id}`, fromName: old.name, toName: fields.name, sameId: old.type === fields.type && old.id === fields.id }] : []),
    ]

    if (changes.length) {
      const result = ofRule({ rule: 'digest.note', value: changes.length, inputs: { present: ['the project notes'] } })

      items.push({ kind: 'note', area: 'note', key: `note:${entry.uuid}`, direction: 'edited', label: fields.title, note: fields, group, result, change: changes.length, changes, signature: JSON.stringify(['edited', fields.title, fields.status, fields.next, fields.type, fields.id, fields.fingerprint, fields.origin]) })
    }
  })

  Object.entries(before).filter(([uuid]) => !now.has(uuid)).forEach(([uuid, old]) => {
    const result = ofRule({ rule: 'digest.note', value: 1, inputs: { present: ['the project notes'] } })

    items.push({ kind: 'note', area: 'note', key: `note:${uuid}`, direction: 'removed', label: old.title, note: old, group: groupOf(old.type, old.id, old.name, false), result, change: 1, changes: [], signature: JSON.stringify(['removed', old.title, old.status, old.next, old.type, old.id, old.fingerprint, old.origin]) })
  })

  return { items, unknown: [] }
}

// How a change reads to the player acknowledging it: the pair of its direction and what moved, so the same net change gives the same signature and a different one does not.
const signatureOf = (item) => item.signature || JSON.stringify([item.direction, item.from, item.to, item.change])

const KIND_ORDER = Object.freeze({ production: 0, bottleneck: 1, colony: 2, note: 3 })

const TYPE_ORDER = Object.freeze({ empire: 0, colony: 1, body: 2, fleet: 3, tech: 4, design: 5 })

const FIELD_ORDER = Object.freeze(['title', 'status', 'next', 'link'])

// The groups of a digest's items: a followed colony's group takes the notes about it and about its body (`colonies`, `[{ id, name, bodyId }]`, the colonies the History page follows), but only a note whose link the Notebook finds intact; a note whose link is stale or not checked, or that was removed, is about an object the ID may no longer name, so it has a group of its own marked `stale`. Any other note is grouped by the object it is about, and what is summed over the race has a group of its own. Items of a group are in the order production, bottleneck, colony and note.
export const groupItems = (items, colonies) => {
  const byBody = new Map(colonies.filter((colony) => isKnownNumber(colony.bodyId)).map((colony) => [Number(colony.bodyId), colony]))
  const groups = new Map()

  items.forEach((item) => {
    const own = item.group
    const stale = item.kind === 'note' && own.live === false
    const colony = item.kind === 'note' && !stale && own.type === 'body' ? byBody.get(Number(own.id)) : null
    const target = colony ? { type: 'colony', id: Number(colony.id), name: colony.name } : own
    const key = `${target.type}:${target.id}${stale ? ':stale' : ''}`

    if (!groups.has(key)) {
      groups.set(key, { key, type: target.type, id: target.id, name: target.name, stale, items: [] })
    }

    groups.get(key).items.push(item)
  })

  return [...groups.values()].map((group) => ({ ...group, items: group.items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1)) })).sort((a, b) => (TYPE_ORDER[a.type] === undefined ? 9 : TYPE_ORDER[a.type]) - (TYPE_ORDER[b.type] === undefined ? 9 : TYPE_ORDER[b.type]) || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1))
}

export const noteFieldOrder = (changes) => [...changes].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))

export const fieldLabel = (field) => FIELD_LABELS[field] || field

// ---- The digest --------------------------------------------------------------------------------------------------------

const emptyDigest = (state, reason = '') => ({ state, reason, boundary: null, to: null, now: null, coverage: null, groups: [], items: [], hidden: 0, unknown: [], record: null })

// The digest of a race on one branch for the open save.
// - `record`: the branch's stored acknowledgment (`recordOf`), null when none was made;
// - `snapshots`: the race's recorded snapshots of the branch in time order; `gameTime` the open save's game time, whose own snapshot is the one compared;
// - `colonyRecord`: the race's colony series of the branch ({ snapshots }) or null; `colonies` the colonies the History page follows ({ id, name, bodyId }), the stamp of each as it was last chosen;
// - `notes`: the entries of `readNotes` for the race on the branch, null when they could not be read;
// - `names`: installation type ID to name; `thinning`: the series' thinning status, null when not known;
// - `recording`: what the recorder has reported for the open save (`recordingStateOf`): '' when it wrote the snapshot of this copy of the save, otherwise the stage of its failure or 'pending'. Anything else leaves the snapshot found at the game time unconfirmed, and nothing is compared.
// The result has the state (`STATES`), the reason when no comparison is made, `boundary` { at, t } of the acknowledgment and `to` { t }, `now` (what acknowledging records), `coverage`, the changes as `items` with `acknowledged` set on those acknowledged one at a time, `hidden` their count, the figures not comparable as `unknown`, and the `groups` of the changes still to show.
export const buildDigest = ({ record, snapshots, gameTime, colonyRecord = null, colonies = [], notes = null, names = {}, thinning = null, recording = '' }) => {
  const series = Array.isArray(snapshots) ? snapshots : []
  const to = isKnownNumber(gameTime) ? snapshotAt(series, Number(gameTime)) : null

  if (!isKnownNumber(gameTime)) {
    return emptyDigest(STATES.WAITING, 'The game time of the open save is not known yet.')
  }

  if (recording) {
    return emptyDigest(STATES.UNCONFIRMED, recordingText(recording))
  }

  if (!to) {
    return emptyDigest(STATES.UNRECORDED, 'The open save has no recorded snapshot yet, so nothing can be compared with it. The app records one each time a save is read while it is open.')
  }

  const rows = colonyRowsAt(colonyRecord, to.t, to.chain ? to.chain.n : null)
  const now = { snapshot: pickSnapshot(to), colonies: rows || {}, notes: noteBaseline(notes) }
  const base = { ...emptyDigest(STATES.NONE), to: { t: to.t }, now }

  if (!record) {
    return { ...base, reason: 'No acknowledgment was made on this branch, so there is nothing to compare the open save with. Acknowledging records the open save as the boundary; the changes after it show here.' }
  }

  const from = record.snapshot
  const boundary = { at: record.at, t: from.t }
  const judged = judgeBoundary({ from, to, snapshots: series })

  if (!judged.ok) {
    return { ...base, state: judged.state, reason: judged.reason, boundary, record }
  }

  const empire = empireChanges(from, to, names)
  const colonyList = Array.isArray(colonies) ? colonies : []
  const nameOf = (id) => {
    const entry = colonyList.filter((candidate) => candidate.id === id).pop()

    return entry ? entry.name : `Colony ${id}`
  }
  const followed = rows ? colonyChanges(record.colonies, rows, nameOf) : { items: [], unknown: Object.keys(record.colonies).length ? [{ key: 'colony:all', label: 'The followed colonies', missing: ['the colony series at the open save'], result: unavailable({ rule: 'digest.colonyState', missing: ['the colony series at the open save'] }) }] : [] }
  const noted = noteChanges(record.notes, notes)
  const items = [...empire.items, ...followed.items, ...noted.items].map((item) => {
    const signature = signatureOf(item)

    return { ...item, signature, acknowledged: hasOwn(record.items, item.key) && record.items[item.key] === signature }
  })
  const shown = items.filter((item) => !item.acknowledged)

  return { ...base, state: STATES.READY, reason: '', boundary, record, coverage: coverageOf({ from, to, snapshots: series, thinning }), items, hidden: items.length - shown.length, unknown: [...empire.unknown, ...followed.unknown, ...noted.unknown], groups: groupItems(shown, colonyList) }
}

// ---- Words -------------------------------------------------------------------------------------------------------------

const KIND_TEXT = Object.freeze({ production: 'Finished production', bottleneck: 'Bottlenecks', colony: 'Followed colonies', note: 'Project notes' })

export const kindText = (kind) => KIND_TEXT[kind] || kind

const signed = (value, count) => `${value > 0 ? '+' : '-'}${count(Math.abs(value))}`

// One change as a sentence, `count(value, decimals)` writing a figure and `status(value)` a note's status.
export const itemText = (item, count, status = (value) => value) => {
  if (item.area === 'installations' || item.area === 'ships') {
    return `${item.label}: ${signed(item.change, count)} net (${count(item.from)} to ${count(item.to)})`
  }

  if (item.area === 'stock' || item.area === 'colonyStock') {
    return item.direction === 'emptied' ? `${item.label} stockpile ran out (${count(item.from)} to ${count(item.to)} ${item.units})` : `${item.label} stockpile is above none again (${count(item.from)} to ${count(item.to)} ${item.units})`
  }

  if (item.area === 'treasury') {
    return item.direction === 'overdrawn' ? `Treasury is below nothing (${count(item.from)} to ${count(item.to)})` : `Treasury is back above nothing (${count(item.from)} to ${count(item.to)})`
  }

  if (item.area === 'state') {
    return item.direction === 'lost' ? `Colony is ${COLONY_STATE_TEXT[item.state] || 'no longer observed'}` : 'Colony is observed again'
  }

  if (item.direction === 'added') {
    return `Note added: ${item.label} (${status(item.note.status)})`
  }

  if (item.direction === 'removed') {
    return `Note removed: ${item.label}`
  }

  return `Note edited: ${item.label}; ${noteFieldOrder(item.changes).map((change) => (change.field === 'status' ? `${fieldLabel(change.field)} ${status(change.from)} to ${status(change.to)}` : change.field === 'link' ? (change.sameId ? `${fieldLabel(change.field)} ${change.toName} (the object behind the ID is not the one linked before)` : `${fieldLabel(change.field)} ${change.fromName} to ${change.toName}`) : `${fieldLabel(change.field)} changed`)).join('; ')}`
}

// What the observation covers as data, in the order it is told: [{ kind, text, ...figures }], `duration(seconds)` writing a span. 'boundary' when the open save is the boundary itself (no game time passed). Otherwise 'observed' (the saves observed strictly between, the game time apart and the widest stretch without one, as the gap it is), 'ledger' (the increments the two witnesses span, null when either save lacks one), 'net' (only the net change over each stretch is shown, nothing inside one), and 'thinning' when the history was or may have been thinned.
export const coverageParts = (coverage, duration) => {
  if (coverage.seconds === 0) {
    return [{ kind: 'boundary', seconds: 0, text: 'The open save is the acknowledged boundary itself: no game time has passed since it, so only a change to the project notes can show.' }]
  }

  const saves = coverage.observed === 0 ? 'No save was observed between the boundary and the open save' : `${coverage.observed} ${coverage.observed === 1 ? 'save was' : 'saves were'} observed between the boundary and the open save`
  const widest = coverage.gaps.find((gap) => gap.seconds === coverage.largest) || null
  const parts = [
    { kind: 'observed', observed: coverage.observed, seconds: coverage.seconds, widest, text: `${saves}, ${duration(coverage.seconds)} of game time apart; the longest stretch without an observation is ${duration(coverage.largest)}.` },
    { kind: 'ledger', increments: coverage.increments, text: `${coverage.increments === null ? 'The ledger increments between them are not known, and the two saves are not shown to be one history' : `The ledger advanced ${coverage.increments} ${coverage.increments === 1 ? 'increment' : 'increments'} between them`}.` },
    { kind: 'net', text: 'Only the net change over each stretch is shown; anything that began and ended inside one is not.' },
  ]

  if (coverage.thinning === 'unknown') {
    parts.push({ kind: 'thinning', status: 'unknown', text: 'Whether the history was thinned over this stretch is not known.' })
  } else if (coverage.thinning === 'thinned' || coverage.thinning === 'partial') {
    parts.push({ kind: 'thinning', status: coverage.thinning, text: 'The history was thinned, so some saves of this stretch may have been observed and dropped.' })
  }

  return parts
}

// What the observation covers in words.
export const coverageText = (coverage, duration) => coverageParts(coverage, duration).map((part) => part.text).join(' ')

// The recorder's failures (`failures` of store/history.js) that leave the snapshot of the open save unconfirmed, the stage of the first one that names this game or the whole save, or '' when none does. A failure to read the save, to write the history, to use the campaign registry, or the recording being another tab's means this pass did not write the open save's snapshot, so a snapshot found at the same game time may be an earlier read of the same save; a failure of the event archive alone leaves it as written.
export const RECORDING_STAGES = Object.freeze(['read', 'write', 'registry', 'readonly'])

export const recordingFailureOf = (failures, GameID) => {
  const found = (Array.isArray(failures) ? failures : []).find((failure) => failure && RECORDING_STAGES.includes(failure.stage) && (failure.GameID === null || failure.GameID === Number(GameID)))

  return found ? found.stage : ''
}

export const RECORDING_PENDING = 'pending'

// What the recorder has reported for the open save, as the stage of its failure, 'pending' or '': `history` is the store's { failures, passes } (store/history.js), `GameID` the open game and `generation` the copy of the save now open. A failure comes first. Without one, only a pass of the recorder that wrote the empire's snapshot of this game on this copy of the save (`passes[GameID] === generation`) confirms the snapshot found at the open save's game time; while the pass is still running, or none was made for this copy, the answer is 'pending', since an absent failure is not a successful recording.
export const recordingStateOf = (history, GameID, generation) => {
  const failure = recordingFailureOf(history ? history.failures : null, GameID)

  if (failure) {
    return failure
  }

  const passes = history && history.passes ? history.passes : {}

  return GameID !== null && GameID !== undefined && generation !== undefined && generation !== null && hasOwn(passes, GameID) && passes[GameID] === generation ? '' : RECORDING_PENDING
}

const RECORDING_CAUSES = Object.freeze({
  read: 'the recorder could not read the open save',
  write: 'the history of this branch could not be written for it, so a snapshot found at the same game time may be an earlier read of the save',
  registry: 'the campaign registry could not be used, so the open save was not recorded',
  readonly: 'another window or tab records this history, so it is not known here that the open save is recorded',
  [RECORDING_PENDING]: 'the recorder has not finished recording it, so a snapshot found at the same game time may be an earlier read of the save',
})

// Why the open save's figures are not taken as recorded, for the `recordingStateOf` answer `stage`.
export const recordingText = (stage) => `The figures of the open save are not recorded: ${RECORDING_CAUSES[stage] || 'the recorder reported a failure for it'}. Nothing is compared and nothing can be acknowledged until the open save is recorded.`
