// Event archive: the opt-in record of a race's game log, kept per branch of a campaign beside the branch's history file. A save holds only a moving window of the log (the five game years the game keeps, cut again to the newest 10,000 rows at each load), so what a later save no longer holds survives only here. The choice is campaign state, `campaign.<campaign id>.race.<RaceID>.logArchive` (true) in the settings; the archive of a branch is its own file, `campaign-<campaign id>-<branch id>-events.json`:
// { version: 1, races: { [RaceID]: { increments, spans, tip, revision, captures, conflicts, failures?, cut? } } }
// - `increments` [[IncrementID, GameTime, Length, groups]] in IncrementID order, only increments that hold an event of the race. `(IncrementID, GameTime, Length)` is the increment's identity: after a rewind the same IncrementID names another increment, so an ID alone is never matched across a fork.
// - `groups` [[...EVENT_FIELDS, count]]: the identical rows of an increment as one entry with how many there were. Identical rows are real (up to 63 in one increment of a measured save) and nothing tells them apart, so they are kept and counted as a multiset, never deduplicated to one.
// - `spans` [[from, to]] in game time: the stretches the captures observed. An increment inside a span with no row of the race was observed to hold none; outside every span nothing is known (a gap, never zero events).
// - `tip` the identity of the newest increment any capture observed, events of the race or not: the increment later rows may still join, so the one left open at the next capture. A tip from an increment that held no event of the race still closes the race's older increments.
// - `revision` counts the captures that added or amended rows; `captures` lists the last of them ({ at, t, from, to, rows, added, amended, revision }); `conflicts` the rows a later save contradicted (kept, never deleted); `failures` the captures whose read failed ({ at, t, reason }), so a missed observation is never mistaken for one that was not tried; `cut` the game time before which the cap dropped the oldest increments.
// Design and measurements: docs/plans/backlog/evidence/AE-161-01.md (section 8).

import { branchFileName } from './campaign'
import { isKnownNumber } from './math'

export const EVENT_ARCHIVE_VERSION = 1

// The caps on events per race and branch the History budget offers; 50,000 is the default the owner chose.
export const EVENT_CAPS = Object.freeze([25000, 50000, 100000])
export const EVENT_CAP = 50000

// The most events a race's record can hold under any offered cap: a stored record above it was not written by this version.
export const MAX_EVENTS = Math.max(...EVENT_CAPS)

// What one event costs as stored, in bytes of compact JSON: measured 148 to 209 B for a race's events in each of the eight Falryx saves (190.8 B for the largest, 119,523 events). The size shown before the archive is on is the cap x this.
export const EVENT_BYTES = 200

// The fields of an event as the archive and a pin keep it, in this order (FCT_GameLog's columns without GameID, RaceID and IncrementID).
export const EVENT_FIELDS = Object.freeze(['Time', 'EventType', 'MessageText', 'SystemID', 'PopulationID', 'Xcor', 'Ycor', 'IDType', 'SMOnly'])

const CAPTURES_KEPT = 50
const CONFLICTS_KEPT = 200

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isIdentity = (value) => Array.isArray(value) && value.length === 3 && value.every((part) => Number.isFinite(part))

export const eventFileName = (campaignId, branchId) => `${branchFileName(campaignId, branchId)}-events`

// ---- The choice ----------------------------------------------------------------------------------------------------

const raceValues = (stored, campaignId, RaceID) => {
  const own = isObject(stored) && isObject(stored.campaign) ? stored.campaign[campaignId] : null
  const races = isObject(own) && isObject(own.race) ? own.race : null

  return races && isObject(races[RaceID]) ? races[RaceID] : null
}

// Whether a race keeps an archive in a campaign, as the settings contents (`stored`) say.
export const archiveOn = (stored, campaignId, RaceID) => {
  const values = raceValues(stored, campaignId, RaceID)

  return Boolean(values && values.logArchive === true)
}

// Whether the settings contents hold an archive turned on anywhere. The recorder reads the registry for `archiveWish` only when one is, so a pass with no archive reads the registry no more often than before.
export const archiveChosen = (stored) => isObject(stored) && isObject(stored.campaign) && Object.values(stored.campaign).some((own) => isObject(own) && isObject(own.race) && Object.values(own.race).some((values) => isObject(values) && values.logArchive === true))

// What the recorder reads of the settings: { [campaignId]: { gameIds, races: [RaceID] } } for each campaign (of `campaigns`, the registry's) with an archive on.
export const archiveWish = (stored, campaigns) => {
  const wish = {}

  Object.values(campaigns).filter((campaign) => !campaign.mergedInto).forEach((campaign) => {
    const own = isObject(stored) && isObject(stored.campaign) ? stored.campaign[campaign.id] : null
    const races = isObject(own) && isObject(own.race) ? Object.entries(own.race).filter(([, values]) => isObject(values) && values.logArchive === true).map(([RaceID]) => Number(RaceID)) : []

    if (races.length) {
      wish[campaign.id] = { gameIds: campaign.gameIds, races }
    }
  })

  return wish
}

// Whether a race of a game is to be read, over every campaign that holds the game (the campaign the save settles to is known only after the read).
export const archiveWanted = (wish, GameID, RaceID) => Object.values(wish).some((campaign) => campaign.gameIds.includes(GameID) && campaign.races.includes(Number(RaceID)))

// Whether the campaign the save settled to keeps the race's archive.
export const archiveKept = (wish, campaignId, RaceID) => Boolean(wish[campaignId] && wish[campaignId].races.includes(Number(RaceID)))

// Turns a race's archive on or off in one read-change-write of the settings. Turning it off keeps what was recorded.
export const saveArchiveChoice = (settings, campaignId, RaceID, on) => {
  settings.update((stored) => {
    const campaigns = (stored.campaign = isObject(stored.campaign) ? stored.campaign : {})
    const campaign = (campaigns[campaignId] = isObject(campaigns[campaignId]) ? campaigns[campaignId] : {})
    const races = (campaign.race = isObject(campaign.race) ? campaign.race : {})
    const race = (races[RaceID] = isObject(races[RaceID]) ? races[RaceID] : {})

    if (on) {
      race.logArchive = true
    } else {
      delete race.logArchive
    }

    return stored
  })
}

// The cap the settings hold (`historyEventCap`), or the default.
export const eventCapOfSettings = (settings) => {
  const stored = settings && isObject(settings.store) ? settings.store.historyEventCap : undefined

  return EVENT_CAPS.includes(stored) ? stored : EVENT_CAP
}

// ---- Rows and identity ---------------------------------------------------------------------------------------------

const numberOrNull = (value) => (isKnownNumber(value) ? Number(value) : null)

// An event's fields as the archive keeps them: numbers as numbers, a missing value as null, the message as text.
export const eventFields = (row) => EVENT_FIELDS.map((field) => (field === 'MessageText' ? (row.MessageText === null || row.MessageText === undefined ? null : String(row.MessageText)) : numberOrNull(row[field])))

// The identity of one group of identical rows: the increment and every field. Exact (no hash), so two different events never share it.
export const fingerprint = (IncrementID, fields) => JSON.stringify([Number(IncrementID), ...fields])

// The fingerprint of a row of the log (a page's row or a read's).
export const rowFingerprint = (row) => fingerprint(row.IncrementID, eventFields(row))

// The multiset of a list of rows: Map(fingerprint -> count).
export const rowCounts = (rows) => {
  const counts = new Map()

  rows.forEach((row) => {
    const key = rowFingerprint(row)
    counts.set(key, (counts.get(key) || 0) + 1)
  })

  return counts
}

const sameIdentity = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

export const endOf = (increment) => increment[1] + increment[2]

// The groups of an increment in their stored order: by their fields as JSON text. The text is made once per group, not twice per comparison (an increment of a large save holds thousands of groups).
const sortGroups = (groups) => groups.map((group) => [JSON.stringify(group.slice(0, EVENT_FIELDS.length)), group]).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, group]) => group)

// ---- Reading a save ------------------------------------------------------------------------------------------------

// The window of a game's log in the save, read once per game: { first, ledger } with `first` the oldest increment any row of the game is in (the log's retained start, every race counted) and `ledger` Map(IncrementID -> [IncrementID, GameTime, Length]) from there to the save's newest increment. Null `first` when the log holds no row.
export const readLogWindow = async (database, GameID, options = {}) => {
  const game = Number(GameID)
  const [[{ first }]] = await database.query(`select min(FCT_GameLog.IncrementID) as first from FCT_GameLog where FCT_GameLog.GameID = ${game}`, options)

  if (!isKnownNumber(first)) {
    return { first: null, ledger: new Map() }
  }

  const [rows] = await database.query(`select FCT_Increments.IncrementID, FCT_Increments.GameTime, FCT_Increments.Length from FCT_Increments where FCT_Increments.GameID = ${game} and FCT_Increments.IncrementID >= ${Number(first)} order by FCT_Increments.IncrementID`, options)

  return { first: Number(first), ledger: new Map(rows.map((row) => [Number(row.IncrementID), [Number(row.IncrementID), Number(row.GameTime), Number(row.Length)]])) }
}

// The statement that reads every row of one race's log.
export const raceLogSql = (GameID, RaceID) => `select FCT_GameLog.IncrementID, ${EVENT_FIELDS.map((field) => `FCT_GameLog.${field}`).join(', ')} from FCT_GameLog where FCT_GameLog.GameID = ${Number(GameID)} and FCT_GameLog.RaceID = ${Number(RaceID)}`

// What one capture takes of a race: { t, from, to, increments, ledger, orphans } or, when the read failed, { failed }. `from` and `to` are the identities of the window's first and newest increments, `increments` [[IncrementID, GameTime, Length, groups]] of the race's rows, `ledger` the window's ledger (used to tell a contradicted row from a fork, not stored) and `orphans` the rows whose increment the ledger lacks (none in any save measured; they are left out and counted). Null when the log holds no row: nothing can be said of any interval.
export const captureOf = (rows, window, t) => {
  if (window.first === null || !window.ledger.size) {
    return null
  }

  const ids = [...window.ledger.keys()]
  const from = window.ledger.get(ids[0])
  const to = window.ledger.get(ids[ids.length - 1])
  const byIncrement = new Map()
  let orphans = 0

  rows.forEach((row) => {
    const id = Number(row.IncrementID)
    const identity = window.ledger.get(id)

    if (!identity) {
      orphans++
      return
    }

    const fields = eventFields(row)
    const key = JSON.stringify(fields)
    const groups = byIncrement.get(id) || new Map()

    groups.set(key, groups.has(key) ? [groups.get(key)[0], groups.get(key)[1] + 1] : [fields, 1])
    byIncrement.set(id, groups)
  })

  const increments = [...byIncrement].sort((a, b) => a[0] - b[0]).map(([id, groups]) => [...window.ledger.get(id), [...groups].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, [fields, count]]) => [...fields, count])])

  return { t: Number(t), from, to, increments, ledger: window.ledger, orphans, rows: rows.length - orphans }
}

// Reads one race's log and the window, keeping a failure instead of throwing it so the empire snapshot of the pass does not fail with it: { capture } or { failed }.
export const readRaceEvents = async (database, { GameID, RaceID, t, window = null }, options = {}) => {
  try {
    const seen = window || (await readLogWindow(database, GameID, options))
    const [rows] = await database.query(raceLogSql(GameID, RaceID), options)

    return { capture: captureOf(rows, seen, t), window: seen }
  } catch (error) {
    return { failed: error }
  }
}

// ---- The archive ---------------------------------------------------------------------------------------------------

const emptyRecord = () => ({ increments: [], spans: [], revision: 0, captures: [], conflicts: [] })

export const recordEvents = (record) => record.increments.reduce((sum, increment) => sum + increment[3].reduce((count, group) => count + group[EVENT_FIELDS.length], 0), 0)

// The spans after adding [from, to], merged where they touch.
export const withSpan = (spans, from, to) => {
  const merged = []

  ;[...spans, [from, to]].sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([start, end]) => {
    const last = merged[merged.length - 1]

    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  })

  return merged
}

const FAILURES_KEPT = 50

// A race's record with a capture whose read failed noted: { at, t, reason }, the last 50 kept. The rows, spans and tip are unchanged, so the failed save adds nothing and the interval it would have covered stays a gap.
export const withFailure = (record, { at, t, reason }) => ({ ...(record || { ...emptyRecord() }), failures: [...((record && record.failures) || []), { at: Number(at), t: Number(t), reason: String(reason || 'the read failed') }].slice(-FAILURES_KEPT) })

const conflictKey = (conflict) => `${conflict.increment[0]}|${conflict.increment[1]}|${conflict.reason}|${conflict.group ? JSON.stringify(conflict.group.slice(0, EVENT_FIELDS.length)) : ''}`

// Merges one capture into a race's record: { record, added, amended, conflicts, changed }. Inside the span the archive and the read share, the read's oldest increment (the load may have cut it) and the archive's newest (later rows may still join it) are open: a group takes the larger of the two counts and nothing is reported. Elsewhere a group the read holds fewer of, or none of, is a conflict: recorded, and the archive's rows kept. An increment whose identity in the read is not the archive's is a conflict too and is left as it was (one branch's archive never takes another timeline's rows). Rows outside the shared span are added; the stretch between two captures that share none stays a gap.
export const mergeCapture = (stored, capture, { now = Date.now } = {}) => {
  const record = stored ? { ...emptyRecord(), ...stored, increments: stored.increments.map((increment) => [...increment]), spans: stored.spans.map((span) => [...span]), captures: [...stored.captures], conflicts: [...stored.conflicts] } : emptyRecord()
  const at = now()
  const known = new Map(record.increments.map((increment, index) => [increment[0], index]))
  // The open newest increment is the newest the archive observed (its tip), not the race's newest event: an increment observed later with no event of the race closed the ones before it. Without a tip (a fork's seed, whose parent tip lay past the fork, or a record from before tips were kept), the newest event stays open only when it ends where the observed spans end; an event that ends before them was followed by observed time, so it is closed.
  const tip = isIdentity(record.tip) ? record.tip : null
  const lastStored = record.increments.length ? record.increments[record.increments.length - 1] : null
  const observedEnd = record.spans.length ? Math.max(...record.spans.map(([, end]) => end)) : null
  const newestStored = tip ? tip[0] : lastStored && (observedEnd === null || endOf(lastStored) >= observedEnd) ? lastStored[0] : null
  const openIds = new Set([capture.from[0], newestStored])
  // What the cap dropped stays dropped: the read's increments that ended by `cut` are neither added nor counted, so a race at its cap whose save still holds those rows is not rewritten at every pass.
  const cut = isKnownNumber(record.cut) ? record.cut : null
  const windowStart = cut === null ? capture.from[1] : Math.max(capture.from[1], cut)
  const windowEnd = endOf(capture.to)
  const keys = new Set(record.conflicts.map(conflictKey))
  const found = []
  let added = 0
  let amended = 0

  const conflict = (increment, reason, group, storedCount, readCount) => {
    const entry = { at, t: capture.t, increment: increment.slice(0, 3), reason, ...(group ? { group: group.slice(0, EVENT_FIELDS.length), stored: storedCount, read: readCount } : {}) }

    if (!keys.has(conflictKey(entry))) {
      keys.add(conflictKey(entry))
      found.push(entry)
    }
  }

  // The archive's increments the read's window covers: compared with the read, group by group.
  const readById = new Map(capture.increments.map((increment) => [increment[0], increment]))

  record.increments.forEach((increment, index) => {
    const id = increment[0]

    if (increment[1] < windowStart || endOf(increment) > windowEnd || !capture.ledger.has(id)) {
      return
    }

    if (!sameIdentity(capture.ledger.get(id), increment)) {
      conflict(increment, 'ledger')
      return
    }

    const open = openIds.has(id)
    const read = readById.get(id)
    const readGroups = new Map((read ? read[3] : []).map((group) => [JSON.stringify(group.slice(0, EVENT_FIELDS.length)), group]))
    const groups = increment[3].map((group) => {
      const key = JSON.stringify(group.slice(0, EVENT_FIELDS.length))
      const storedCount = group[EVENT_FIELDS.length]
      const readGroup = readGroups.get(key)
      const readCount = readGroup ? readGroup[EVENT_FIELDS.length] : 0

      readGroups.delete(key)

      if (readCount > storedCount) {
        amended += readCount - storedCount

        if (!open) {
          conflict(increment, 'more', group, storedCount, readCount)
        }

        return [...group.slice(0, EVENT_FIELDS.length), readCount]
      }

      if (readCount < storedCount && !open) {
        conflict(increment, readCount ? 'fewer' : 'missing', group, storedCount, readCount)
      }

      return group
    })

    // Groups only the read holds: new rows of an increment the archive had (the newest growing, or a contradiction elsewhere).
    readGroups.forEach((group) => {
      amended += group[EVENT_FIELDS.length]

      if (!open) {
        conflict(increment, 'more', group, 0, group[EVENT_FIELDS.length])
      }

      groups.push(group)
    })

    record.increments[index] = [...increment.slice(0, 3), sortGroups(groups)]
  })

  // The read's increments the archive does not hold: added. An ID the archive holds with another identity is a conflict (another timeline's increment) and its rows are left out.
  capture.increments.forEach((increment) => {
    if (known.has(increment[0])) {
      const own = record.increments[known.get(increment[0])]

      if (!sameIdentity(own, increment)) {
        conflict(own, 'ledger')
      }
    } else if (cut === null || endOf(increment) > cut) {
      added += increment[3].reduce((count, group) => count + group[EVENT_FIELDS.length], 0)
      record.increments.push(increment.map((part, index) => (index === 3 ? part.map((group) => [...group]) : part)))
    }
  })

  record.increments.sort((a, b) => a[0] - b[0])

  const spans = windowEnd > windowStart ? withSpan(record.spans, windowStart, windowEnd) : record.spans
  const spansChanged = JSON.stringify(spans) !== JSON.stringify(record.spans)
  const nextTip = !tip || capture.to[0] >= tip[0] ? [...capture.to] : tip
  const tipChanged = !tip || !sameIdentity(nextTip, tip)

  record.spans = spans
  record.tip = nextTip
  record.conflicts = [...record.conflicts, ...found].slice(-CONFLICTS_KEPT)

  if (added || amended) {
    record.revision += 1
    record.captures = [...record.captures, { at, t: capture.t, from: capture.from, to: capture.to, rows: capture.rows, added, amended, revision: record.revision }].slice(-CAPTURES_KEPT)
  }

  return { record, added, amended, conflicts: found.length, changed: Boolean(added || amended || found.length || spansChanged || tipChanged || !stored) }
}

// A record cut to at most `cap` events: whole increments go, the oldest first, and `cut` says from when the record holds everything it kept. A span before the cut is clipped to start there.
export const capRecord = (record, cap) => {
  let total = recordEvents(record)

  if (total <= cap) {
    return { record, dropped: 0 }
  }

  const increments = [...record.increments]
  let cut = record.cut
  let dropped = 0

  while (total > cap && increments.length) {
    const oldest = increments.shift()
    const count = oldest[3].reduce((sum, group) => sum + group[EVENT_FIELDS.length], 0)

    total -= count
    dropped += count
    cut = Math.max(isKnownNumber(cut) ? cut : -Infinity, endOf(oldest))
  }

  const spans = record.spans.filter(([, end]) => end > cut).map(([start, end]) => [Math.max(start, cut), end])

  return { record: { ...record, increments, spans, cut, conflicts: record.conflicts.filter((conflict) => endOf(conflict.increment) > cut) }, dropped }
}

// Merges a pass's captures into an archive file ({ races: [{ RaceID, capture }] }), each race's record then cut to `cap`: { file, changed }. A race missing from this pass keeps its record.
export const mergeEvents = (file, { races }, { cap = EVENT_CAP, now = Date.now } = {}) => {
  const merged = { version: EVENT_ARCHIVE_VERSION, races: { ...(isObject(file) && isObject(file.races) ? file.races : {}) } }
  let changed = !(isObject(file) && isObject(file.races))

  races.forEach(({ RaceID, capture }) => {
    if (!capture) {
      return
    }

    const result = mergeCapture(merged.races[RaceID] || null, capture, { now })
    const { record, dropped } = capRecord(result.record, cap)

    if (result.changed || dropped) {
      merged.races[RaceID] = record
      changed = true
    }
  })

  return { file: merged, changed }
}

// ---- Branches ------------------------------------------------------------------------------------------------------

const written = (file) => isObject(file) && isObject(file.races)

const seededBranch = (branch) => Boolean(branch && branch.eventsSeeded === true)

// The records of a file cut to what had happened by game time `t`: whole increments that ended by then, spans clipped to it, captures and conflicts of the increments kept. A race with nothing left is dropped; nothing at all gives {}.
export const eventsUpTo = (file, t) => {
  if (!written(file) || !isKnownNumber(t)) {
    return {}
  }

  const races = Object.fromEntries(Object.entries(file.races).map(([RaceID, record]) => {
    const increments = record.increments.filter((increment) => endOf(increment) <= t)
    const spans = record.spans.filter(([start]) => start < t).map(([start, end]) => [start, Math.min(end, t)])
    const kept = { ...record, increments, spans, captures: record.captures.filter((capture) => capture.t <= t), conflicts: record.conflicts.filter((conflict) => endOf(conflict.increment) <= t), ...(record.failures ? { failures: record.failures.filter((failure) => failure.t <= t) } : {}) }

    // A tip past the fork is the parent's timeline: the seed keeps none, and its first capture closes every inherited increment that ends before the seed's observed span does.
    if (isIdentity(record.tip) && endOf(record.tip) > t) {
      delete kept.tip
    }

    // A cut past the fork removed every event the seed could take; the failures noted by then stay, as a record with no rows, span, tip or cut (the parent's cut is its own timeline too).
    if (isKnownNumber(record.cut) && record.cut > t) {
      return [RaceID, { revision: record.revision, increments: [], spans: [], captures: [], conflicts: [], failures: kept.failures || [] }]
    }

    return [RaceID, kept]
  }).filter(([, record]) => record && (record.increments.length || record.spans.length || (record.failures && record.failures.length))))

  return Object.keys(races).length ? { version: EVENT_ARCHIVE_VERSION, races } : {}
}

// The archive a branch with no file starts from: its parent's up to the fork (and the parent's parent's up to its fork, and so on). Two branches' archives are never merged: a fork takes the parent's past and the two go on apart.
export const eventSeed = (io, campaign, branchId, t) => {
  const file = io.file(eventFileName(campaign.id, branchId)).store

  if (written(file)) {
    return eventsUpTo(file, t)
  }

  const branch = campaign.branches[branchId]

  return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}
}

// The file a branch's next capture merges into: its own, or when it has none and was never given its seed, the seed of its fork.
export const eventBase = (io, campaign, branchId) => {
  const stored = io.file(eventFileName(campaign.id, branchId)).store

  if (written(stored)) {
    return stored
  }

  const branch = campaign.branches[branchId]

  return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? eventSeed(io, campaign, branch.parent, branch.fork.t) : {}
}

// The archive a branch is given in the pass that creates it, frozen at the fork so that a later clear or capture of the parent changes nothing in the child. Null when the branch has a file already or the parent holds no archive up to the fork; the caller then marks the branch `eventsSeeded`, which keeps an empty seed empty.
export const eventForkFile = (io, campaign, branchId) => {
  if (written(io.file(eventFileName(campaign.id, branchId)).store)) {
    return null
  }

  const seed = eventBase(io, campaign, branchId)

  return written(seed) && Object.keys(seed.races).length ? seed : null
}

// ---- Reading the archive -------------------------------------------------------------------------------------------

// The stretches no capture observed, inside the archive's span and before it: [{ from, to }] in game time, `from` null for the unobserved past before the first capture. A gap is unknown, never an interval with no events.
export const gapsOf = (record) => {
  if (!record || !record.spans.length) {
    return []
  }

  const gaps = [{ from: null, to: record.spans[0][0] }]

  record.spans.slice(1).forEach(([start], index) => gaps.push({ from: record.spans[index][1], to: start }))

  return gaps
}

// The rows of a race's record, newest first, one per event (a group of n identical rows gives n rows with its `copies`): { IncrementID, GameTime, Length, ...fields, copies, key } with `key` the group's fingerprint.
export const archiveRows = (record) => {
  if (!record) {
    return []
  }

  const rows = []

  record.increments.forEach(([IncrementID, GameTime, Length, groups]) => {
    groups.forEach((group) => {
      const fields = Object.fromEntries(EVENT_FIELDS.map((field, index) => [field, group[index]]))
      const copies = group[EVENT_FIELDS.length]
      const key = fingerprint(IncrementID, group.slice(0, EVENT_FIELDS.length))

      for (let copy = 0; copy < copies; copy++) {
        rows.push({ IncrementID, GameTime, Length, ...fields, copies, copy, key })
      }
    })
  })

  return rows.sort((a, b) => b.Time - a.Time || b.IncrementID - a.IncrementID)
}

// ---- Reading a window ----------------------------------------------------------------------------------------------

// Whether the stretch (start, end] meets the window (from, to]; a null `start` is unbounded, as the first gap's is.
const meets = (start, end, from, to) => (start === null || start < to) && end > from

// The stretches of a record that may still change: the oldest increment of each span (the load may have cut it) and the newest (later rows may still join it), as [{ kind: 'head' | 'tail', from, to, basis }] in game time. `basis` says what held the increment's identity: 1 a retained capture or the tip, 2 a retained increment, 3 neither (the increment held no retained event, so it ends no later than the next retained one starts, never at the length of the longest retained one).
export const openStretchesOf = (record) => {
  if (!record || !Array.isArray(record.spans)) {
    return []
  }

  const tip = isIdentity(record.tip) ? record.tip : null
  const stretches = []

  record.spans.forEach(([start, end], index) => {
    const capture = record.captures.find((entry) => entry.from[1] === start)
    const retained = record.increments.find((increment) => increment[1] >= start)

    if (capture) {
      stretches.push({ kind: 'head', from: start, to: Math.min(end, start + capture.from[2]), basis: 1 })
    } else if (retained && retained[1] === start) {
      stretches.push({ kind: 'head', from: start, to: Math.min(end, endOf(retained)), basis: 2 })
    } else {
      stretches.push({ kind: 'head', from: start, to: retained ? Math.min(end, retained[1]) : end, basis: 3 })
    }

    const ending = record.increments.find((increment) => endOf(increment) === end)

    if (tip && index === record.spans.length - 1) {
      stretches.push({ kind: 'tail', from: Math.min(end, Math.max(start, tip[1])), to: end, basis: 1 })
    } else if (ending) {
      stretches.push({ kind: 'tail', from: Math.max(start, ending[1]), to: end, basis: 2 })
    } else {
      const inside = record.increments.filter((increment) => increment[1] >= start && endOf(increment) <= end)

      stretches.push({ kind: 'tail', from: Math.max(start, inside.length ? endOf(inside[inside.length - 1]) : start), to: end, basis: 3 })
    }
  })

  return stretches
}

// How far a record covers the window (from, to] of game time, without counting rows: { state, from, to, spans, gaps, openStretches, failures, cut, revision }. `state` is 'unavailable' when the record is missing or has no span, no span meets the window, or the window ends at or before the cap's cut; 'partial' when the window is not inside one span, meets a gap (the unobserved past before the first span included), an open stretch, a failed capture's time, or starts before the cut; else 'observed'. `stretches` are the record's open stretches when the caller has them already.
export const coverageOf = (record, from, to, stretches = openStretchesOf(record)) => {
  const spans = record && Array.isArray(record.spans) ? record.spans : []
  const cut = record && isKnownNumber(record.cut) ? record.cut : null
  const meeting = spans.filter(([start, end]) => meets(start, end, from, to))
  const gaps = gapsOf(record).filter((gap) => meets(gap.from, gap.to, from, to)).map((gap) => ({ from: gap.from === null ? from : Math.max(gap.from, from), to: Math.min(gap.to, to) }))
  const openStretches = stretches.filter((stretch) => meets(stretch.from, stretch.to, from, to))
  const failures = record && Array.isArray(record.failures) ? record.failures.filter((failure) => failure.t > from && failure.t <= to) : []
  const unavailable = !record || !meeting.length || (cut !== null && to <= cut)
  const inside = meeting.length === 1 && meeting[0][0] <= from && meeting[0][1] >= to
  const state = unavailable ? 'unavailable' : !inside || gaps.length || openStretches.length || failures.length || (cut !== null && from < cut) ? 'partial' : 'observed'

  return {
    state,
    from,
    to,
    spans: meeting.map(([start, end]) => [Math.max(start, from), Math.min(end, to)]),
    gaps,
    openStretches,
    failures,
    cut: cut !== null && from < cut ? cut : null,
    revision: record ? record.revision : null,
  }
}

// The state of the window (from, to] of one race's record, with the rows in it: `coverageOf` and `observedRows`, the events whose `Time` lies in the window counted with their copies (null when the state is 'unavailable': an interval no capture covers is unknown, never 0 events). A fork reads `eventsUpTo(file, t)` first, so its window ends at `t`; two branches are never combined.
export const windowState = (record, from, to) => {
  const coverage = coverageOf(record, from, to)
  const observedRows = coverage.state === 'unavailable' ? null : record.increments.reduce((sum, increment) => sum + increment[3].reduce((count, group) => count + (group[0] > from && group[0] <= to ? group[EVENT_FIELDS.length] : 0), 0), 0)

  return { ...coverage, observedRows }
}

// ---- Size ----------------------------------------------------------------------------------------------------------

// The predicted bytes of `events` events: a prediction, labelled as one wherever it is shown.
export const eventEstimate = (events) => events * EVENT_BYTES

// ---- Checking a file -----------------------------------------------------------------------------------------------

const isGroup = (group) => Array.isArray(group) && group.length === EVENT_FIELDS.length + 1 && Number.isSafeInteger(group[EVENT_FIELDS.length]) && group[EVENT_FIELDS.length] > 0 && EVENT_FIELDS.every((field, index) => (field === 'MessageText' ? group[index] === null || typeof group[index] === 'string' : group[index] === null || Number.isFinite(group[index])))

const isCapture = (capture) => isObject(capture) && Number.isFinite(capture.at) && Number.isFinite(capture.t) && isIdentity(capture.from) && isIdentity(capture.to) && [capture.rows, capture.added, capture.amended, capture.revision].every((count) => Number.isSafeInteger(count) && count >= 0)

const CONFLICT_REASONS = ['ledger', 'more', 'fewer', 'missing']

const isConflict = (conflict) => isObject(conflict) && Number.isFinite(conflict.at) && Number.isFinite(conflict.t) && isIdentity(conflict.increment) && CONFLICT_REASONS.includes(conflict.reason) && (conflict.group === undefined ? conflict.reason === 'ledger' : Array.isArray(conflict.group) && conflict.group.length === EVENT_FIELDS.length && isGroup([...conflict.group, 1]) && Number.isSafeInteger(conflict.stored) && conflict.stored >= 0 && Number.isSafeInteger(conflict.read) && conflict.read >= 0)

const isFailure = (failure) => isObject(failure) && Number.isFinite(failure.at) && Number.isFinite(failure.t) && typeof failure.reason === 'string'

// Why a stored archive file cannot be read by this version, or null when it can. `{}` (no file) reads as none.
export const eventFileProblem = (file) => {
  if (file === undefined || file === null || (isObject(file) && !Object.keys(file).length)) {
    return null
  }

  if (!isObject(file) || file.version !== EVENT_ARCHIVE_VERSION || !isObject(file.races) || Object.keys(file).some((key) => !['version', 'races'].includes(key))) {
    return 'not an event archive this version reads'
  }

  for (const [RaceID, record] of Object.entries(file.races)) {
    if (!/^[1-9][0-9]*$/.test(RaceID) || !isObject(record)) {
      return `race ${RaceID} is not a record`
    }

    if (!Array.isArray(record.increments) || !record.increments.every((increment) => Array.isArray(increment) && increment.length === 4 && isIdentity(increment.slice(0, 3)) && Array.isArray(increment[3]) && increment[3].length > 0 && increment[3].every(isGroup))) {
      return `race ${RaceID} has an increment this version cannot read`
    }

    // No cap the budget offers lets a record hold more events than its largest, so a count beyond it is not one this version wrote (and listing it would expand it row by row).
    if (recordEvents(record) > MAX_EVENTS) {
      return `race ${RaceID} holds more events than any cap allows`
    }

    if (record.increments.some((increment, index) => index && increment[0] <= record.increments[index - 1][0])) {
      return `race ${RaceID} has increments out of order`
    }

    if (!Array.isArray(record.spans) || !record.spans.every((span) => Array.isArray(span) && span.length === 2 && Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[0] <= span[1])) {
      return `race ${RaceID} has a span this version cannot read`
    }

    if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.captures) || !record.captures.every(isCapture) || !Array.isArray(record.conflicts) || !record.conflicts.every(isConflict) || (record.failures !== undefined && !(Array.isArray(record.failures) && record.failures.every(isFailure))) || (record.cut !== undefined && !Number.isFinite(record.cut)) || (record.tip !== undefined && !isIdentity(record.tip))) {
      return `race ${RaceID} has a capture record this version cannot read`
    }
  }

  return null
}
