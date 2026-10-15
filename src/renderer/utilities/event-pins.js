// Event pins: events of the game log the player marked to keep in view, per campaign, race and branch. The page stores them under `campaign.<campaign id>.race.<RaceID>.logPins` in the settings:
// { version: 1, seeded: { [branchId]: true }, pins: [{ id, branch, from, at, increment, fields, count, names, note }] }
// A pin holds a copy of its event (`fields`, utilities/event-archive.js EVENT_FIELDS, and `names`, the type, system and colony names shown when it was pinned), the identity of its increment ([IncrementID, GameTime, Length]) and how many identical rows its group held (`count`): it is found again by that fingerprint, never by the row's position (`rowid` changes at every save). A group of identical rows is pinned as one, with its count, since nothing tells its rows apart. `branch` is the branch the pin belongs to and `from` the branch it was made on (a fork inherits its parent's pins of events that had happened by the fork). Design: docs/plans/backlog/evidence/AE-161-01.md section 8.4.

import { fingerprint, EVENT_FIELDS, eventFields } from './event-archive'
import { isKnownNumber } from './math'

export const PINS_VERSION = 1

// The most pins a race keeps per branch.
export const MAX_PINS = 500

// What a pin's state says on the page.
export const PIN_STATES = Object.freeze({
  held: 'In this save',
  count: 'Unresolved: the save holds a different number of these identical events',
  ledger: 'Unresolved: the save\'s increment with this number is another one (another timeline)',
  gone: 'Gone from the retained log: the save covers the time and does not hold it',
  older: 'Older than the save\'s log',
  newer: 'Later than this save',
  unread: 'The log could not be read',
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isIdentity = (value) => Array.isArray(value) && value.length === 3 && value.every((part) => Number.isFinite(part))

const isFields = (value) => Array.isArray(value) && value.length === EVENT_FIELDS.length && EVENT_FIELDS.every((field, index) => (field === 'MessageText' ? value[index] === null || typeof value[index] === 'string' : value[index] === null || Number.isFinite(value[index])))

const validPin = (pin) => isObject(pin) && typeof pin.id === 'string' && pin.id.length > 0 && typeof pin.branch === 'string' && typeof pin.from === 'string' && Number.isFinite(pin.at) && isIdentity(pin.increment) && isFields(pin.fields) && Number.isSafeInteger(pin.count) && pin.count > 0 && isObject(pin.names) && typeof pin.note === 'string'

export const emptyPins = () => ({ version: PINS_VERSION, seeded: {}, pins: [] })

// The stored value as a pin store, an empty one when nothing is stored, or null when it is not one this version reads (the page then shows the pins as unavailable and writes nothing over them).
export const readPins = (value) => {
  if (value === undefined || value === null) {
    return emptyPins()
  }

  if (!isObject(value) || value.version !== PINS_VERSION || !isObject(value.seeded) || !Array.isArray(value.pins) || !value.pins.every(validPin)) {
    return null
  }

  return value
}

// The fingerprint a pin is found by.
export const pinKey = (pin) => fingerprint(pin.increment[0], pin.fields)

// The pins of a branch, the newest first.
export const pinsOf = (store, branch) => store.pins.filter((pin) => pin.branch === branch).sort((a, b) => b.fields[0] - a.fields[0] || b.increment[0] - a.increment[0])

// The pin of a branch on the group a row belongs to, or null.
export const pinOfRow = (store, branch, row) => {
  const key = fingerprint(row.IncrementID, eventFields(row))

  return store.pins.find((pin) => pin.branch === branch && pinKey(pin) === key) || null
}

export class PinLimit extends Error {
  constructor (limit = MAX_PINS) {
    super(`At most ${limit} events can be pinned on a branch`)
    this.name = 'PinLimit'
    this.limit = limit
  }
}

// The store after pinning `row` (a log row) on `branch`: `increment` is its increment's identity, `count` how many identical rows its group holds, `names` { type, system, colony }. A group already pinned is left as it is; a pin past the limit throws PinLimit.
export const withPin = (store, branch, row, { increment, count, names, at, id }) => {
  if (pinOfRow(store, branch, row)) {
    return store
  }

  if (pinsOf(store, branch).length >= MAX_PINS) {
    throw new PinLimit()
  }

  const pin = { id, branch, from: branch, at, increment: increment.map(Number), fields: eventFields(row), count, names: { type: names.type || null, system: names.system || null, colony: names.colony || null }, note: '' }

  // One pin the store cannot read would hide every pin of the race (readPins rejects the whole store), so a pin readPins would reject is refused here.
  if (!validPin(pin)) {
    throw new Error('This event cannot be pinned: the pin would not be readable.')
  }

  return { ...store, pins: [...store.pins, pin] }
}

export const withoutPin = (store, branch, id) => ({ ...store, pins: store.pins.filter((pin) => !(pin.branch === branch && pin.id === id)) })

export const withNote = (store, branch, id, note) => ({ ...store, pins: store.pins.map((pin) => (pin.branch === branch && pin.id === id ? { ...pin, note: String(note || '') } : pin)) })

// The store with `branch` given its parent's pins: those of events that had ended by the fork (`lineage` { [branchId]: { parent, t } }, history-milestones.js `branchLineage`), the parent seeded first. A branch is seeded once; one with no parent or no known fork time is marked with nothing copied. Without a lineage nothing changes, so a branch whose registry could not be read is seeded later.
export const seededPins = (store, branch, lineage, walked = new Set()) => {
  if (store.seeded[branch] || !lineage || !lineage[branch] || walked.has(branch)) {
    return store
  }

  walked.add(branch)

  const { parent, t } = lineage[branch]
  let next = store

  if (parent && isKnownNumber(t)) {
    next = seededPins(next, parent, lineage, walked)

    const own = new Set(next.pins.filter((pin) => pin.branch === branch).map(pinKey))
    const inherited = next.pins.filter((pin) => pin.branch === parent && pin.increment[1] + pin.increment[2] <= t && !own.has(pinKey(pin))).map((pin) => ({ ...pin, branch }))

    next = { ...next, pins: [...next.pins, ...inherited] }
  }

  return { ...next, seeded: { ...next.seeded, [branch]: true } }
}

// What the open save says of a pin: a key of PIN_STATES. `counts` is the save's multiset of the race's rows (event-archive.js `rowCounts`), `window` the log's window ({ first, ledger }, event-archive.js `readLogWindow`) or null when it could not be read. The oldest increment of the window may have been cut by the load, so a pin there that the save no longer holds is older than the log, not gone.
export const pinState = (pin, counts, window) => {
  if (!window) {
    return 'unread'
  }

  const [id] = pin.increment

  if (window.first === null || id < window.first) {
    return 'older'
  }

  const identity = window.ledger.get(id)

  if (!identity) {
    return 'newer'
  }

  if (identity[1] !== pin.increment[1] || identity[2] !== pin.increment[2]) {
    return 'ledger'
  }

  const held = counts.get(pinKey(pin)) || 0

  if (held === pin.count) {
    return 'held'
  }

  if (!held) {
    return id === window.first ? 'older' : 'gone'
  }

  return 'count'
}
