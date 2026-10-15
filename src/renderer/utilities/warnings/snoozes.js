// Snoozes of the Warnings page: a warning put aside for a while, kept apart from the permanent mutes (`warningsMuted`), which this module never reads or writes. A snooze is a record of the race in its campaign, `campaign.<id>.race.<RaceID>.warningsSnoozed`, so a race or a campaign never sees another's.
//
// The store is `{ version, seeded, records }`. A record is `{ id, check, scope, rowId, stamp, setAt, branch, from, reason, options, until }`: `scope` is 'item' (one row, `rowId` the id the check gave it) or 'check' (the whole check, `rowId` null); `setAt` the game time it was set at; `branch` the branch of the campaign it belongs to and `from` the branch it was copied from (null when it was made on `branch`); `reason` the player's own words; `options` the check's options when it was set; `until` one of `{ kind: 'date', expiresAt }` (a game time in seconds), `{ kind: 'clear' }` (until the row, or for a check the whole list, is seen gone) and `{ kind: 'material', signature }` (until a declared change: the signature of the row as text, or for a check `{ [rowId]: signature }`). A snooze never stores a shown figure, a name or a sort position.
//
// Rules, each one a decision of the snooze evidence:
//   - A failed read of a check changes no record of it. A row ends its snooze only by being absent from a read that succeeded, and a check ends one only by listing no row at all; a row that could not be evaluated, an id the check lists twice, a signature or an identity that cannot be read all keep the record and show the row with a note. A stored signature is never overwritten.
//   - An end is an observed one: a disappearance ends the episode, and a return is a new episode that shows.
//   - A date ends the snooze at or after it, by the game's own clock; with the game time unknown the row shows and the record stays.
//   - 'Until it changes materially' compares the declared signature only, and only while the options of the check are those the snooze was set under; with other options it holds until the row clears.
//   - Records are per branch. A branch forked from another is seeded, once, with the records of its parent set at or before the game time of the fork, and nothing is merged back. A copied snooze of one item applies only when the identity stamp of the object (`STAMPED`) is the one it was made with; with no stamp to compare it shows the row with a note instead of hiding it. A record set later than the game time of the open save (a rewind) ends nothing: its end shows the row with a note.
//
// The module imports nothing, so a check runs it on a plain database.

export const VERSION = 1
export const REASON_LENGTH = 200
export const SCOPES = Object.freeze(['check', 'item'])
export const KINDS = Object.freeze(['date', 'clear', 'material'])

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const isText = (value) => typeof value === 'string' && value !== ''

export const NOTES = Object.freeze({
  ambiguous: 'The check lists this id more than once, so no snooze holds it.',
  unevaluated: 'The condition could not be decided from the save, so the snooze is kept and not applied.',
  stamp: 'The identity of the object could not be read, so the snooze is kept and does not hide the row.',
  signature: 'An input of the declared change could not be read, so the snooze is kept and does not hide the row.',
  options: 'The options of the check changed since the snooze was set, so it holds until the row clears.',
  branch: 'Snoozed on another branch of the campaign; nothing identifies this object here, so the row stays in view.',
  ahead: 'The save is earlier than the moment the snooze was set, so nothing ends it.',
  clock: 'The game time of the save is not known, so the date of the snooze cannot be told.',
})

export const ENDED = Object.freeze({
  expired: 'The date of the snooze came.',
  absent: 'The row left the check, so its episode ended.',
  changed: 'The declared fields of the row changed.',
  different: 'The id now belongs to another object.',
  cleared: 'The check listed nothing, so its episode ended.',
  cancelled: 'The snooze was cancelled.',
  replaced: 'The snooze was replaced by another.',
})

// The ended snoozes kept for the forks still to come (owner decision, 2026-10-15): a save of an older point first opened after more than this many endings since that point starts its branch without the ones cut.
export const PAST_LIMIT = 5000

export const emptyStore = () => ({ version: VERSION, seeded: {}, records: [], past: [] })

export const idOf = (branch, check, scope, rowId) => [branch, check, scope, rowId === null ? '' : rowId].join('|')

const validUntil = (until, scope) => {
  if (!isObject(until)) {
    return false
  }

  if (until.kind === 'date') {
    return isFiniteNumber(until.expiresAt)
  }

  if (until.kind === 'clear') {
    return true
  }

  return until.kind === 'material' && (scope === 'item' ? isText(until.signature) : isObject(until.signatures) && Object.values(until.signatures).every(isText))
}

const validRecord = (record) => isObject(record) && isText(record.id) && isText(record.check) && SCOPES.includes(record.scope) && (record.scope === 'item' ? isText(record.rowId) : record.rowId === null) && (record.stamp === null || isText(record.stamp)) && isFiniteNumber(record.setAt) && isText(record.branch) && (record.from === null || isText(record.from)) && typeof record.reason === 'string' && isObject(record.options) && validUntil(record.until, record.scope)

const validPast = (entry) => validRecord(entry) && isObject(entry.ended) && isFiniteNumber(entry.ended.at) && isText(entry.ended.reason)

// One episode of a snooze: a record is set once and ends once, so what it was set at and ended at tell two episodes of an id apart, as a snooze cancelled and made again at one game time is two.
const pastKey = (entry) => `${entry.id}@${entry.setAt}@${entry.ended.at}`

// What a stored value holds: `{ ok: true, store, dropped }` (a missing value is the empty store; `dropped` counts the records that were not valid and are left out), or `{ ok: false, reason }` for a value that is no store of this version, which is never written over.
export const readStore = (value) => {
  if (value === undefined || value === null) {
    return { ok: true, store: emptyStore(), dropped: 0 }
  }

  if (!isObject(value) || value.version !== VERSION || !Array.isArray(value.records) || !isObject(value.seeded) || (value.past !== undefined && !Array.isArray(value.past))) {
    return { ok: false, reason: 'The stored snoozes are not in a form this version reads.' }
  }

  const records = value.records.filter(validRecord)
  const seen = new Set()
  const unique = records.filter((record) => !seen.has(record.id) && seen.add(record.id))
  const stored = value.past || []
  const kept = new Set()
  const past = stored.filter(validPast).filter((entry) => !kept.has(pastKey(entry)) && kept.add(pastKey(entry)))
  const seeded = Object.fromEntries(Object.entries(value.seeded).filter(([, entry]) => isObject(entry)))

  return { ok: true, store: { version: VERSION, seeded, records: unique, past }, dropped: value.records.length - unique.length + stored.length - past.length }
}

// The snoozes of a branch that are in force (the ones that ended are in `past`).
export const forBranch = (store, branch, check = null) => store.records.filter((record) => record.branch === branch && (check === null || record.check === check))

// Adds a record in force; a record of the same id it replaces moves to `past`, ended at the game time the new one was set.
export const addRecord = (store, record) => {
  const replaced = store.records.filter((stored) => stored.id === record.id)

  return { ...store, records: [...store.records.filter((stored) => stored.id !== record.id), record], past: [...store.past, ...replaced.map((stored) => ({ ...stored, ended: { at: record.setAt, reason: 'replaced' } }))] }
}

// Ends records: each `{ id, at, reason }` moves its record out of force into `past` with the game time it ended at, which a branch forked earlier than that still inherits. An end at an unknown game time is not kept (such a record is never inherited).
export const endRecords = (store, ends) => {
  const gone = store.records.filter((record) => ends.some((end) => end.id === record.id))

  if (!gone.length) {
    return store
  }

  const entries = gone.map((record) => ({ record, end: ends.find((end) => end.id === record.id) })).filter(({ end }) => isFiniteNumber(end.at)).map(({ record, end }) => ({ ...record, ended: { at: end.at, reason: end.reason } }))

  return { ...store, records: store.records.filter((record) => !ends.some((end) => end.id === record.id)), past: [...store.past, ...entries] }
}

// The store with the ended records cut to the newest PAST_LIMIT. Before any is cut every branch the registry knows is seeded (`lineage()` gives the account of the branches, or null), because an ended record is the only trace of what a branch forked before its end had in force: once a branch is seeded it no longer needs them, so what the cut loses is never something a known branch inherits. While the registry cannot be read nothing is cut. A branch the registry only learns of later (a fork made from a time older than the newest PAST_LIMIT endings) cannot inherit what was cut.
export const pruned = (store, lineage) => {
  if (store.past.length <= PAST_LIMIT) {
    return store
  }

  const known = lineage()

  if (!isObject(known)) {
    return store
  }

  const every = Object.keys(known).reduce((current, branch) => seeded(current, branch, known), store)

  return { ...every, past: every.past.slice(-PAST_LIMIT) }
}

// The store with the branch seeded from its parent, once: what the parent had in force at the game time the branch left it at (the records set at or before it and not ended before it, ended ones included, so the order of visits and what the parent did since change nothing), kept under the branch, with `from` naming the branch they were first made on. The parent is seeded first, so a chain of forks carries a record down. A branch with no parent, a parent or a fork time the registry does not give leaves the store as it is (a missing fork time copies nothing); a seeded branch is marked, so a cancelled copy is not made again.
export const seeded = (store, branch, lineage, walked = new Set()) => {
  if (!isObject(lineage) || !hasOwn(lineage, branch) || hasOwn(store.seeded, branch) || walked.has(branch)) {
    return store
  }

  const { parent, t } = lineage[branch]

  if (parent === null || !hasOwn(lineage, parent)) {
    return store
  }

  walked.add(branch)

  const base = seeded(store, parent, lineage, walked)
  const known = new Set(base.records.map((record) => record.id))
  const inForce = base.records.filter((record) => record.branch === parent && record.setAt <= t)
  const ended = base.past.filter((entry) => entry.branch === parent && entry.setAt <= t && entry.ended.at > t).sort((alpha, beta) => beta.setAt - alpha.setAt)
  const copies = t === null ? [] : [...inForce, ...ended].map(({ ended: _ended, ...record }) => ({ ...record, branch, from: record.from || record.branch, id: idOf(branch, record.check, record.scope, record.rowId) })).filter((record) => !known.has(record.id) && known.add(record.id))

  return { ...base, seeded: { ...base.seeded, [branch]: { from: parent, t } }, records: [...base.records, ...copies] }
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value)

// Whether two sets of options are one, whatever the order of their keys.
export const sameOptions = (a, b) => JSON.stringify(canonical(a || {})) === JSON.stringify(canonical(b || {}))

// ---- Identity stamps -----------------------------------------------------------------------------------------------

// The objects an ID of a row names, by the prefix of the row's id, whose identity is read from the save: what the game gives an ID to again for another object (after a rewind, or once the highest ID is gone) shows as another stamp. Every other prefix has no stamp, and a snooze of it is not trusted across a fork.
export const STAMPED = Object.freeze({
  ship: Object.freeze({ table: 'FCT_Ship', key: 'ShipID', columns: Object.freeze(['ShipClassID', 'Constructed']) }),
  colony: Object.freeze({ table: 'FCT_Population', key: 'PopulationID', columns: Object.freeze(['SystemBodyID']) }),
  commander: Object.freeze({ table: 'FCT_Commander', key: 'CommanderID', columns: Object.freeze(['CareerStart', 'Female', 'SpeciesID']) }),
  wreck: Object.freeze({ table: 'FCT_Wrecks', key: 'WreckID', columns: Object.freeze(['ShipID', 'SystemID', 'ClassID']) }),
})

const BATCH = 400

// The namespace of a row's id: the text before its first colon (`ship:12` is `ship`).
export const namespaceOf = (rowId) => (typeof rowId === 'string' && rowId.includes(':') ? rowId.slice(0, rowId.indexOf(':')) : null)

export const isStamped = (rowId) => hasOwn(STAMPED, namespaceOf(rowId) || '')

const idNumber = (rowId) => {
  const rest = rowId.slice(rowId.indexOf(':') + 1)

  return /^\d{1,15}$/.test(rest) ? Number(rest) : null
}

export const stampSql = (namespace, GameID, ids) => {
  const { table, key, columns } = STAMPED[namespace]

  return `select ${table}.${key} as StampKey, ${columns.map((column) => `${table}.${column} as ${column}`).join(', ')} from ${table} where ${table}.GameID = ${Number(GameID)} and ${table}.${key} in (${ids.join(', ')})`
}

const stampToken = (value) => (typeof value === 'number' ? String(Math.round(value * 1000000) / 1000000) : String(value))

// The identity stamp of each row id, as a Map of the id to its stamp text, or to null while it cannot be read (a failed read, an object that is not there, a column that is empty): never a stamp made of what was not read. An id of a namespace with no stamp is not in the map.
export const readStamps = async (database, GameID, rowIds) => {
  const stamps = new Map()
  const wanted = [...new Set(rowIds)].filter(isStamped)

  await Promise.all(Object.keys(STAMPED).map(async (namespace) => {
    const mine = wanted.filter((rowId) => namespaceOf(rowId) === namespace)

    mine.forEach((rowId) => stamps.set(rowId, null))

    const numbered = mine.map((rowId) => [rowId, idNumber(rowId)]).filter(([, number]) => number !== null)

    for (let start = 0; start < numbered.length; start += BATCH) {
      const batch = numbered.slice(start, start + BATCH)

      try {
        const [rows] = await database.query(stampSql(namespace, GameID, batch.map(([, number]) => number)))
        const columns = STAMPED[namespace].columns

        rows.forEach((row) => {
          const rowId = `${namespace}:${row.StampKey}`
          const values = columns.map((column) => row[column])

          if (stamps.has(rowId) && values.every((value) => value !== null && value !== undefined)) {
            stamps.set(rowId, `${namespace}:${values.map(stampToken).join(',')}`)
          }
        })
      } catch (error) {
        // The ids of the batch stay null: not read.
      }
    }
  }))

  return stamps
}

// ---- Making a record -----------------------------------------------------------------------------------------------

const cut = (text) => String(text === undefined || text === null ? '' : text).trim().slice(0, REASON_LENGTH)

const copyOf = (value) => JSON.parse(JSON.stringify(value === undefined ? {} : value))

const evaluable = (read) => read.rows.filter((row) => !row.unevaluated)

// A record of a snooze, or the reason there is none. `read` is the check's last successful read ({ rows, GameTime, options }), `row` the row of an item snooze, `expiresAt` the game time of a date, `stamps` the result of `readStamps` for the row.
export const makeRecord = ({ check, scope, kind, row = null, expiresAt = null, reason = '', read, stamps = new Map(), branch }) => {
  if (!isText(branch)) {
    return { ok: false, error: 'The campaign branch of the save is not known, so a snooze has nowhere to be kept.' }
  }

  if (!read || !Array.isArray(read.rows)) {
    return { ok: false, error: 'The check has not been read, so there is nothing to snooze.' }
  }

  if (!SCOPES.includes(scope) || !KINDS.includes(kind)) {
    return { ok: false, error: 'That kind of snooze does not exist.' }
  }

  if (!isFiniteNumber(read.GameTime)) {
    return { ok: false, error: 'The game time of the save is not known, so a snooze cannot be set.' }
  }

  if (kind === 'date' && !(isFiniteNumber(expiresAt) && expiresAt > read.GameTime)) {
    return { ok: false, error: 'The date has to be later than the game time of the save.' }
  }

  if (kind === 'material' && !check.material) {
    return { ok: false, error: 'This check declares no material change, so it cannot be snoozed until one.' }
  }

  const until = kind === 'date' ? { kind, expiresAt } : { kind }
  let rowId = null
  let stamp = null

  if (scope === 'item') {
    if (!row || row.unevaluated) {
      return { ok: false, error: 'A row that could not be evaluated is no warning, so it is not snoozed.' }
    }

    if (row.ambiguous) {
      return { ok: false, error: 'The check lists this id more than once, so no snooze can hold one of them.' }
    }

    if (kind === 'material') {
      if (!isText(row.signature)) {
        return { ok: false, error: 'An input of the declared change cannot be read, so the row cannot be snoozed until it changes.' }
      }

      until.signature = row.signature
    }

    rowId = row.raw

    if (isStamped(rowId)) {
      stamp = stamps.get(rowId)

      if (!isText(stamp)) {
        return { ok: false, error: 'The identity of the object cannot be read, so its snooze cannot be told from one of another object.' }
      }
    }
  } else {
    const rows = evaluable(read)

    if (!read.rows.length) {
      return { ok: false, error: 'The check lists nothing, so there is nothing to snooze.' }
    }

    if (kind === 'material') {
      if (!rows.length || rows.some((listed) => listed.ambiguous || !isText(listed.signature))) {
        return { ok: false, error: 'An input of the declared change cannot be read for a row, so the check cannot be snoozed until it changes.' }
      }

      until.signatures = Object.fromEntries(rows.map((listed) => [listed.raw, listed.signature]))
    }
  }

  return { ok: true, record: { id: idOf(branch, check.key, scope, rowId), check: check.key, scope, rowId, stamp, setAt: read.GameTime, branch, from: null, reason: cut(reason), options: copyOf(read.options), until } }
}

// ---- Evaluating records --------------------------------------------------------------------------------------------

const snoozed = (...notes) => ({ state: 'snoozed', notes })

const shown = (...notes) => ({ state: 'shown', notes })

const ended = (reason) => ({ end: reason })

const dateVerdict = (until, now) => (now === null ? shown(NOTES.clock) : now >= until.expiresAt ? ended('expired') : snoozed())

const itemVerdict = (record, found, context) => {
  const { now, stamps, options } = context
  const { until } = record
  const expired = until.kind === 'date' && now !== null && now >= until.expiresAt

  if (!found.length) {
    return ended(expired ? 'expired' : 'absent')
  }

  if (found.length > 1) {
    return shown(NOTES.ambiguous)
  }

  const [row] = found

  if (row.unevaluated) {
    return shown(NOTES.unevaluated)
  }

  if (record.stamp !== null) {
    const current = stamps.get(record.rowId)

    if (typeof current !== 'string') {
      return shown(NOTES.stamp)
    }

    if (current !== record.stamp) {
      return ended('different')
    }
  }

  if (expired) {
    return ended('expired')
  }

  if (record.stamp === null && record.from) {
    return shown(NOTES.branch)
  }

  if (until.kind === 'date') {
    return dateVerdict(until, now)
  }

  if (until.kind === 'material') {
    if (!sameOptions(record.options, options)) {
      return snoozed(NOTES.options)
    }

    if (typeof row.signature !== 'string' || row.signature === '') {
      return shown(NOTES.signature)
    }

    return row.signature === until.signature ? snoozed() : ended('changed')
  }

  return snoozed()
}

const checkVerdicts = (record, read, context) => {
  const { now, options } = context
  const { until } = record

  if (!read.rows.length) {
    return { end: until.kind === 'date' && now !== null && now >= until.expiresAt ? 'expired' : 'cleared' }
  }

  const verdicts = evaluable(read).map((row) => {
    if (until.kind === 'date') {
      return [row, dateVerdict(until, now)]
    }

    if (until.kind !== 'material') {
      return [row, snoozed()]
    }

    if (!sameOptions(record.options, options)) {
      return [row, snoozed(NOTES.options)]
    }

    if (row.ambiguous) {
      return [row, shown(NOTES.ambiguous)]
    }

    if (typeof row.signature !== 'string' || row.signature === '') {
      return [row, shown(NOTES.signature)]
    }

    return [row, hasOwn(until.signatures, row.raw) && until.signatures[row.raw] === row.signature ? snoozed() : ended('changed')]
  })

  const cause = verdicts.find(([, verdict]) => verdict.end)

  return cause ? { end: cause[1].end } : { verdicts: new Map(verdicts) }
}

// What the records of one check (all on the open branch) say of a read of it (`{ ok, rows, GameTime, options }`, rows as `normalizeRows` gives them), with `stamps` the identity stamps of the item rows (`readStamps`): `{ failed, ended, rows, check }`. `ended` lists `{ record, reason }` to be dropped; `rows` maps the id a row has on the page to `{ record, state, notes }`, `state` being 'snoozed' (hidden) or 'shown' (the record is kept and the row stays in view, with its notes); `check` is the record of the whole check still in force. A failed read gives `failed: true` and nothing else: every record is left as it is.
export const evaluate = (records, read, stamps = new Map()) => {
  const result = { failed: false, ended: [], rows: new Map(), check: null }

  if (!read || read.ok !== true || !Array.isArray(read.rows)) {
    result.failed = true

    return result
  }

  const now = isFiniteNumber(read.GameTime) ? read.GameTime : null
  const context = { now, stamps, options: read.options || {} }
  const byRaw = new Map()

  read.rows.forEach((row) => byRaw.set(row.raw, [...(byRaw.get(row.raw) || []), row]))

  const claim = (row, record, verdict) => {
    const held = result.rows.get(row.id)

    if (!held || (held.state === 'shown' && verdict.state === 'snoozed')) {
      result.rows.set(row.id, { record, state: verdict.state, notes: verdict.notes })
    }
  }

  const items = records.filter((record) => record.scope === 'item')
  const checks = records.filter((record) => record.scope === 'check')

  items.forEach((record) => {
    const found = byRaw.get(record.rowId) || []
    const verdict = itemVerdict(record, found, context)
    const ahead = now !== null && record.setAt > now

    if (verdict.end && !ahead) {
      result.ended.push({ record, reason: verdict.end })
    } else if (verdict.end) {
      found.forEach((row) => claim(row, record, shown(NOTES.ahead)))
    } else {
      found.forEach((row) => claim(row, record, verdict))
    }
  })

  checks.forEach((record) => {
    const verdict = checkVerdicts(record, read, context)
    const ahead = now !== null && record.setAt > now

    if (verdict.end && !ahead) {
      result.ended.push({ record, reason: verdict.end })

      return
    }

    result.check = record
    evaluable(read).forEach((row) => claim(row, record, verdict.end ? shown(NOTES.ahead) : verdict.verdicts.get(row)))
  })

  return result
}

// A snooze's end in words: `formatDate` makes the text of a game time in seconds.
export const untilText = (record, formatDate) => (record.until.kind === 'date' ? `until ${formatDate(record.until.expiresAt)}` : record.until.kind === 'clear' ? (record.scope === 'check' ? 'until the check clears' : 'until it clears') : 'until it changes materially')
