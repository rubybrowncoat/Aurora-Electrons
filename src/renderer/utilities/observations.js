// Object observations: the opt-in record of how long the objects of a kind (a race's ground formations, later its lifepods and wrecks) have been seen unchanged. The save keeps a formation's place and elements but no date they were set, so the only age that can be given is the one the app observed: from the first save it read in which the object looked as it does now. The choice is campaign state, `campaign.<campaign id>.race.<RaceID>.observe` (the kinds kept, a list) in the settings; the record of a branch is its own file beside the branch file, `campaign-<campaign id>-<branch id>-observations.json`:
// { version: 1, races: { [RaceID]: { kinds: { [kind]: { captures, objects, failures?, cut?, seed? } } } } }
// - `captures` [[t, n]] in game time, one for each save the recorder read the kind from, `n` being the increments its ledger held. Between two captures nothing is known, so a capture is the only evidence of time that passed.
// - `objects` { [id]: [first, last, digest] or [first, last, digest, mark] }: the objects the newest capture saw. `first` is the game time of the capture that first saw the object as the digest describes it, `last` the newest capture that saw it so, and every capture between them saw it so too (an object not seen by a capture is dropped, one that differs starts again). The fourth entry says why the run started: 1, a stored object differed (it moved or changed); 2, the parent branch saw the object so before the fork and the first capture of this branch restarted the run, since an id is not certified across a fork. Its absence says the object was not seen before. An object is told by its id alone only inside the branch file: ids repeat across a fork and nothing in a save dates them.
// - `failures` [{ at, t, reason }] the captures whose read failed, so a missed observation is never mistaken for one that was not tried; `cut` the game time of the newest capture the cap dropped; `seed` the game time a fork's seed was cut at, the captures up to it being the parent branch's.
// A kind is generic: an object is (kind, id, digest) and a kind's reader gives the objects of a race at a save (OBSERVED_KINDS). Design: docs/plans/backlog/evidence/AE-111-02.md.

import { branchFileName, hashValue } from './campaign'
import { readFormationObservations } from './ground-formations'
import { isKnownNumber } from './math'

export const OBSERVATION_VERSION = 1

const MOVED = 1
const RESTARTED = 2

// What each kind is read as. `read(database, { GameID, RaceID }, options)` gives the race's objects at the open save as [[id, signature]], `noun` names one of them for the page.
export const OBSERVED_KINDS = Object.freeze({
  formation: Object.freeze({ label: 'Ground formations', noun: 'formation', read: readFormationObservations }),
})

export const KIND_NAMES = Object.freeze(Object.keys(OBSERVED_KINDS))

// The most captures a record keeps; the oldest are dropped past it and `cut` says when.
export const CAPTURES_KEPT = 500

// The most objects of one kind a record can hold: a stored record above it was not written by this version.
export const MAX_OBJECTS = 100000

// What one object costs as stored, in bytes of compact JSON: 56 B, a ceiling over the 49.7 B measured for the 3,288 formations of the largest race read (163,565 B for one capture: the id, the two game times and the 16-digit digest), which leaves room for longer ids and the moved mark. What one capture costs: 18 B.
export const OBJECT_BYTES = 56
export const CAPTURE_BYTES = 18

const FAILURES_KEPT = 50

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export const observationFileName = (campaignId, branchId) => `${branchFileName(campaignId, branchId)}-observations`

// ---- The choice ----------------------------------------------------------------------------------------------------

const raceValues = (stored, campaignId, RaceID) => {
  const own = isObject(stored) && isObject(stored.campaign) ? stored.campaign[campaignId] : null
  const races = isObject(own) && isObject(own.race) ? own.race : null

  return races && isObject(races[RaceID]) ? races[RaceID] : null
}

const kindsOf = (values) => (values && Array.isArray(values.observe) ? KIND_NAMES.filter((kind) => values.observe.includes(kind)) : [])

// The kinds a race keeps observed in a campaign, as the settings contents (`stored`) say.
export const observedKinds = (stored, campaignId, RaceID) => kindsOf(raceValues(stored, campaignId, RaceID))

// Whether the settings hold a choice for the race in the campaign, on or turned off again. A race never chosen has no record to read, so a page reads no file for it.
export const observationEverChosen = (stored, campaignId, RaceID) => {
  const values = raceValues(stored, campaignId, RaceID)

  return Boolean(values) && Array.isArray(values.observe)
}

// Whether any race of the campaign holds a choice in the settings, on or turned off again, the races named in `except` (the NPR races of the save) aside: an NPR is never read, so its choice leaves no record. A campaign with none has no record anywhere, so a fork of it reads no observation file.
export const observationEverChosenIn = (stored, campaignId, except = []) => {
  const own = isObject(stored) && isObject(stored.campaign) ? stored.campaign[campaignId] : null
  const skipped = except.map(String)

  return isObject(own) && isObject(own.race) && Object.entries(own.race).some(([RaceID, values]) => !skipped.includes(RaceID) && isObject(values) && Array.isArray(values.observe))
}

// Whether the settings contents hold any kind observed anywhere. The recorder reads the registry for `observationWish` only when one is, so a pass with none reads the registry no more often than before.
export const observationChosen = (stored) => isObject(stored) && isObject(stored.campaign) && Object.values(stored.campaign).some((own) => isObject(own) && isObject(own.race) && Object.values(own.race).some((values) => kindsOf(values).length > 0))

// What the recorder reads of the settings: { [campaignId]: { gameIds, races: { [RaceID]: [kind] } } } for each campaign (of `campaigns`, the registry's) with a kind observed.
export const observationWish = (stored, campaigns) => {
  const wish = {}

  Object.values(campaigns).filter((campaign) => !campaign.mergedInto).forEach((campaign) => {
    const own = isObject(stored) && isObject(stored.campaign) ? stored.campaign[campaign.id] : null
    const races = isObject(own) && isObject(own.race) ? Object.fromEntries(Object.entries(own.race).map(([RaceID, values]) => [Number(RaceID), kindsOf(values)]).filter(([, kinds]) => kinds.length)) : {}

    if (Object.keys(races).length) {
      wish[campaign.id] = { gameIds: campaign.gameIds, races }
    }
  })

  return wish
}

// The kinds of a race of a game to be read, over every campaign that holds the game (the campaign the save settles to is known only after the read).
export const observationWanted = (wish, GameID, RaceID) => KIND_NAMES.filter((kind) => Object.values(wish).some((campaign) => campaign.gameIds.includes(GameID) && (campaign.races[Number(RaceID)] || []).includes(kind)))

// The kinds the campaign the save settled to keeps of the race.
export const observationKept = (wish, campaignId, RaceID) => (wish[campaignId] ? wish[campaignId].races[Number(RaceID)] || [] : [])

// Turns one kind of a race on or off in one read-change-write of the settings. Turning it off keeps what was recorded.
export const saveObservationChoice = (settings, campaignId, RaceID, kind, on) => {
  if (!OBSERVED_KINDS[kind]) {
    throw new RangeError(`${kind} is not a kind that is observed`)
  }

  settings.update((stored) => {
    const campaigns = (stored.campaign = isObject(stored.campaign) ? stored.campaign : {})
    const campaign = (campaigns[campaignId] = isObject(campaigns[campaignId]) ? campaigns[campaignId] : {})
    const races = (campaign.race = isObject(campaign.race) ? campaign.race : {})
    const race = (races[RaceID] = isObject(races[RaceID]) ? races[RaceID] : {})
    const kinds = kindsOf(race).filter((name) => name !== kind)

    if (on) {
      kinds.push(kind)
    }

    if (kinds.length) {
      race.observe = KIND_NAMES.filter((name) => kinds.includes(name))
    } else if (Array.isArray(race.observe)) {
      race.observe = []
    } else {
      delete race.observe
    }

    return stored
  })
}

// ---- Reading a save ------------------------------------------------------------------------------------------------

// What one capture takes of a race: { kind, objects: [[id, digest]] } or, when the read failed, { kind, failed }. A kind's reader gives each object's signature (a text of what the object is compared by) and the digest is its hash. The failure is kept, not thrown, so the empire snapshot of the pass does not fail with it.
export const readObservations = async (database, kind, { GameID, RaceID }, options = undefined) => {
  try {
    const objects = await OBSERVED_KINDS[kind].read(database, { GameID, RaceID }, options)

    return { kind, objects: objects.map(([id, signature]) => [id, hashValue(signature)]) }
  } catch (error) {
    return { kind, failed: error }
  }
}

// The game time and the increments of the open save, as a capture holds them: { t, n }, or null when the save does not say. The page sets what a record says against this, so a record of a later save is never taken for the open one.
export const readOpenSave = async (database, { GameID }) => {
  try {
    if (!Number.isSafeInteger(Number(GameID))) {
      return null
    }

    const [game] = await database.query(`select FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${Number(GameID)}`)
    const [ledger] = await database.query(`select count(FCT_Increments.IncrementID) as n from FCT_Increments where FCT_Increments.GameID = ${Number(GameID)}`)

    return game.length && isKnownNumber(Number(game[0].GameTime)) && ledger.length ? { t: Number(game[0].GameTime), n: Number(ledger[0].n) } : null
  } catch {
    return null
  }
}

// ---- The record ----------------------------------------------------------------------------------------------------

const emptyRecord = () => ({ captures: [], objects: {} })

export const recordObjects = (record) => Object.keys(record.objects).length

// The objects a race's record holds, over every kind.
export const raceObservations = (race) => Object.values(race && race.kinds ? race.kinds : {}).reduce((sum, record) => sum + recordObjects(record), 0)

const copyRecord = (record) => ({ ...record, captures: record.captures.map((capture) => [...capture]), objects: Object.fromEntries(Object.entries(record.objects).map(([id, entry]) => [id, [...entry]])), ...(record.failures ? { failures: record.failures.map((failure) => ({ ...failure })) } : {}) })

const entryEquals = (a, b) => a.length === b.length && a.every((part, index) => part === b[index])

// Merges one capture ({ t, n, objects: [[id, digest]] }) into a record: { record, changed, outcome }. `outcome` is 'first' (the record had no capture), 'added' (a later save), 'again' (the save of the newest capture read again), 'behind' (a save older than the newest capture, which never extends a run) or 'ledger' (the same game time on another ledger, which is another timeline). Behind and ledger leave the record as it was. A run goes on only where the object was seen with the same digest; a new or differing object starts at this capture, and one the capture did not see is dropped.
export const mergeCapture = (stored, capture) => {
  const record = stored ? copyRecord(stored) : emptyRecord()
  const tip = record.captures.length ? record.captures[record.captures.length - 1] : null

  if (tip && capture.t < tip[0]) {
    return { record: stored, changed: false, outcome: 'behind' }
  }

  if (tip && capture.t === tip[0] && capture.n !== tip[1]) {
    return { record: stored, changed: false, outcome: 'ledger' }
  }

  const again = Boolean(tip) && capture.t === tip[0]
  const seed = isKnownNumber(record.seed) ? record.seed : null
  const objects = {}

  capture.objects.forEach(([id, digest]) => {
    const before = record.objects[id]

    if (before && before[2] === digest) {
      if (again) {
        objects[id] = before
      } else if (seed !== null && before[1] <= seed) {
        // The parent branch saw the object, and its id is not certified across the fork: the span starts at the first capture of this branch.
        objects[id] = [capture.t, capture.t, digest, RESTARTED]
      } else {
        objects[id] = [before[0], capture.t, digest, ...(before[3] ? [before[3]] : [])]
      }
    } else {
      objects[id] = before ? [capture.t, capture.t, digest, MOVED] : [capture.t, capture.t, digest]
    }
  })

  const unchanged = again && Object.keys(objects).length === Object.keys(record.objects).length && Object.entries(objects).every(([id, entry]) => record.objects[id] && entryEquals(record.objects[id], entry))

  if (unchanged) {
    return { record: stored, changed: false, outcome: 'again' }
  }

  record.objects = objects

  if (!again) {
    record.captures.push([capture.t, capture.n])
  }

  return { record: capRecord(record), changed: true, outcome: tip ? (again ? 'again' : 'added') : 'first' }
}

// A record with the oldest captures dropped past the cap; `cut` is the game time of the newest dropped one. The objects stay: their runs are kept whole.
export const capRecord = (record) => {
  if (record.captures.length <= CAPTURES_KEPT) {
    return record
  }

  const dropped = record.captures.slice(0, record.captures.length - CAPTURES_KEPT)

  return { ...record, captures: record.captures.slice(dropped.length), cut: Math.max(isKnownNumber(record.cut) ? record.cut : -Infinity, dropped[dropped.length - 1][0]) }
}

// A record with a capture whose read failed noted: { at, t, reason }, the last 50 kept. The objects and captures are unchanged, so the failed save adds nothing and the interval it would have covered stays a gap. The same failure noted again for the same save is not a new one (null, nothing to write).
export const withFailure = (record, { at, t, reason }) => {
  const failures = record && record.failures ? record.failures : []
  const last = failures[failures.length - 1]
  const text = String(reason || 'the read failed')

  if (last && last.t === Number(t) && last.reason === text) {
    return null
  }

  return { ...(record || emptyRecord()), failures: [...failures, { at: Number(at), t: Number(t), reason: text }].slice(-FAILURES_KEPT) }
}

// Merges a pass's captures into an observation file ({ captures: [{ RaceID, kind, capture }] }): { file, changed }. A record missing from this pass keeps its past. `forkAt` is the game time the branch left its parent at, when it did: a record with no seed of its own (a branch frozen with an empty seed) is given it, so the first capture after the fork restarts every object seen before, as a record seeded from the parent does.
export const mergeObservations = (file, { captures = [], failures = [], forkAt = null }) => {
  const merged = { version: OBSERVATION_VERSION, races: Object.fromEntries(Object.entries(isObject(file) && isObject(file.races) ? file.races : {}).map(([RaceID, race]) => [RaceID, { kinds: { ...race.kinds } }])) }
  let changed = !(isObject(file) && isObject(file.races))

  const put = (RaceID, kind, record) => {
    merged.races[RaceID] = merged.races[RaceID] || { kinds: {} }
    merged.races[RaceID].kinds[kind] = record
    changed = true
  }

  captures.forEach(({ RaceID, kind, capture }) => {
    const before = merged.races[RaceID] ? merged.races[RaceID].kinds[kind] || null : null
    const result = mergeCapture(isKnownNumber(forkAt) && !(before && isKnownNumber(before.seed)) ? { ...(before || emptyRecord()), seed: forkAt } : before, capture)

    if (result.changed) {
      put(RaceID, kind, result.record)
    }
  })

  failures.forEach(({ RaceID, kind, failure }) => {
    const next = withFailure(merged.races[RaceID] ? merged.races[RaceID].kinds[kind] || null : null, failure)

    if (next) {
      put(RaceID, kind, next)
    }
  })

  return { file: merged, changed }
}

// ---- Branches ------------------------------------------------------------------------------------------------------

// Whether a branch has an observation file of its own: one written by a capture, a fork's seed or a clear, even when every race was cleared from it. Such a file is never seeded from the parent again, so what was cleared stays cleared.
const written = (file) => isObject(file) && isObject(file.races)

// Whether a branch was given its observation seed when it was created (`observationsSeeded` on its registry entry, set once the seed file, if the parent held any record, was written). Such a branch with no file started empty and is never seeded from its parent afterwards, so what the parent records or clears later never reaches it.
const seededBranch = (branch) => Boolean(branch && branch.observationsSeeded === true)

// A record cut to what had been observed by game time `t`: the captures at or before it, and each object a retained capture at or before `t` saw, its newest sighting being the newest such capture in its run (a run's captures all saw it, so nothing after the fork leaks in and nothing before it is lost). An object first seen after `t` has no such capture and is dropped: its id may name another object in the branch that parts at `t`. So is an object whose every capture up to `t` was dropped past the cap: nothing witnesses it, and carrying it would leave the seed a record this version cannot read. The cut is the branch's `seed`.
const recordUpTo = (record, t) => {
  const captures = record.captures.filter(([time]) => time <= t)
  const objects = {}

  Object.entries(record.objects).forEach(([id, [first, last, digest, mark]]) => {
    const seen = captures.filter(([time]) => time >= first && time <= last)

    if (!seen.length) {
      return
    }

    objects[id] = [first, seen[seen.length - 1][0], digest, ...(mark ? [mark] : [])]
  })

  const dropped = isKnownNumber(record.cut) ? Math.min(record.cut, t) : null

  return { captures, objects, ...(record.failures ? { failures: record.failures.filter((failure) => failure.t <= t) } : {}), ...(dropped !== null ? { cut: dropped } : {}), seed: t }
}

// The records of a file cut to game time `t` (`recordUpTo`). A kind with no capture, object or failure left is dropped, then a race with no kind; nothing at all gives {}.
export const observationsUpTo = (file, t) => {
  if (!written(file) || !isKnownNumber(t)) {
    return {}
  }

  const races = {}

  Object.entries(file.races).forEach(([RaceID, race]) => {
    const kinds = Object.fromEntries(Object.entries(race.kinds).map(([kind, record]) => [kind, recordUpTo(record, t)]).filter(([, record]) => record.captures.length || Object.keys(record.objects).length || (record.failures && record.failures.length)))

    if (Object.keys(kinds).length) {
      races[RaceID] = { kinds }
    }
  })

  return Object.keys(races).length ? { version: OBSERVATION_VERSION, races } : {}
}

// The file a branch with no file starts from: its parent's up to the fork (and the parent's parent's up to its fork, and so on). Two branches' records are never merged: a fork takes the parent's past and the two go on apart.
export const observationSeed = (io, campaign, branchId, t) => {
  const file = io.file(observationFileName(campaign.id, branchId)).store

  if (written(file)) {
    return observationsUpTo(file, t)
  }

  const branch = campaign.branches[branchId]

  return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? observationSeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}
}

// The file a branch's next capture merges into: its own, or when it has none and was never given its seed, the seed of its fork.
export const observationBase = (io, campaign, branchId) => {
  const stored = io.file(observationFileName(campaign.id, branchId)).store

  if (written(stored)) {
    return stored
  }

  const branch = campaign.branches[branchId]

  return branch && !seededBranch(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? observationSeed(io, campaign, branch.parent, branch.fork.t) : {}
}

// The file a branch is given in the pass that creates it, frozen at the fork so that a later clear or capture of the parent changes nothing in the child. Null when the branch has a file already or the parent holds no record up to the fork; the caller then marks the branch `observationsSeeded`, which keeps an empty seed empty.
export const observationForkFile = (io, campaign, branchId) => {
  if (written(io.file(observationFileName(campaign.id, branchId)).store)) {
    return null
  }

  const seed = observationBase(io, campaign, branchId)

  return written(seed) && Object.keys(seed.races).length ? seed : null
}

// ---- Reading the record --------------------------------------------------------------------------------------------

// What the record says of one object: { id, first, last, digest, basis, captures, longest, failed, inherited } or null when the record holds none. `basis` is 'import' (seen by the first capture the record holds, so its age before the app read it is unknown), 'appeared' (not there at the capture before, so no older than that), 'moved' (differed at the capture before) or 'branch' (the parent branch saw the object as it is before the fork, and a span never crosses a fork, so it starts at this branch's first capture). `captures` counts the captures of the run still held and `longest` is the widest stretch between two of them, { from, to }, since between two captures nothing is known: the object may have gone and come back. `failed` counts the failed captures inside the run and `inherited` is whether the run still sits in the parent's past (`seed`), as a run does until this branch's first capture restarts it. A span is never "unchanged for" its length: it is observed at each of its captures and unknown between them.
// `before` is also given: the game time of the newest capture before `first` (the capture that did not see the object as it is), or null when the record holds none.
export const spanOf = (record, id) => {
  const entry = record && record.objects ? record.objects[id] : null

  if (!entry) {
    return null
  }

  const [first, last, digest, mark] = entry
  const times = record.captures.map(([t]) => t).filter((t) => t >= first && t <= last)
  const cut = isKnownNumber(record.cut) ? record.cut : null
  const seed = isKnownNumber(record.seed) ? record.seed : null
  let longest = null

  times.slice(1).forEach((t, index) => {
    if (longest === null || t - times[index] > longest.to - longest.from) {
      longest = { from: times[index], to: t }
    }
  })

  return {
    id: Number(id),
    first,
    last,
    digest,
    basis: mark === MOVED ? 'moved' : mark === RESTARTED ? 'branch' : cut === null && record.captures.length && first === record.captures[0][0] ? 'import' : 'appeared',
    before: record.captures.map(([t]) => t).filter((t) => t < first).pop() ?? null,
    captures: times.length,
    longest,
    failed: record.failures ? record.failures.filter((failure) => failure.t > first && failure.t < last).length : 0,
    inherited: seed !== null && first <= seed,
  }
}

// What the page shows of one current object against a record: { state, span }. `state` is 'observed' (the record holds the object as it is now), 'changed' (it holds the object as it was before a change the recorder has not read yet), 'new' (it holds no such object), 'unrecorded' (the record holds no capture, or the object was not read) or 'ahead' (the open save is older than the newest capture, or on another ledger at the same game time: the record describes a save this one is not, so the object is not compared). `digest` is the object's digest in the open save, null when it was not read; `open` is { t, n }, the game time and the increments of the open save, as a capture holds them.
export const observationOf = (record, id, digest, open = undefined) => {
  if (!record || !record.captures.length || digest === null || digest === undefined) {
    return { state: 'unrecorded', span: null }
  }

  const tip = record.captures[record.captures.length - 1]

  if (open && (open.t < tip[0] || (open.t === tip[0] && open.n !== tip[1]))) {
    return { state: 'ahead', span: null }
  }

  const span = spanOf(record, id)

  if (!span) {
    return { state: 'new', span: null }
  }

  return { state: span.digest === digest ? 'observed' : 'changed', span }
}

// The widest stretch between two captures anywhere in a record, { from, to }, or null with fewer than two.
export const widestGap = (record) => {
  let widest = null

  record.captures.slice(1).forEach(([t], index) => {
    if (widest === null || t - record.captures[index][0] > widest.to - widest.from) {
      widest = { from: record.captures[index][0], to: t }
    }
  })

  return widest
}

// ---- Size ----------------------------------------------------------------------------------------------------------

// The predicted bytes of a record of `objects` objects holding `captures` captures: a prediction, labelled as one wherever it is shown.
export const observationEstimate = ({ objects, captures = CAPTURES_KEPT }) => objects * OBJECT_BYTES + captures * CAPTURE_BYTES

// ---- Checking a file -----------------------------------------------------------------------------------------------

const isCapture = (capture) => Array.isArray(capture) && capture.length === 2 && Number.isFinite(capture[0]) && Number.isSafeInteger(capture[1]) && capture[1] >= 0

const isFailure = (failure) => isObject(failure) && Number.isFinite(failure.at) && Number.isFinite(failure.t) && typeof failure.reason === 'string'

const isEntry = (entry) => Array.isArray(entry) && (entry.length === 3 || (entry.length === 4 && (entry[3] === MOVED || entry[3] === RESTARTED))) && Number.isFinite(entry[0]) && Number.isFinite(entry[1]) && entry[0] <= entry[1] && typeof entry[2] === 'string' && /^[0-9a-f]{16}$/.test(entry[2])

// Why a record cannot be read by this version, or null when it can.
const recordProblem = (record) => {
  if (!isObject(record) || !Array.isArray(record.captures) || !record.captures.every(isCapture) || !isObject(record.objects)) {
    return 'is not a record of captures and objects'
  }

  if (Object.keys(record).some((key) => !['captures', 'objects', 'failures', 'cut', 'seed'].includes(key))) {
    return 'holds a key this version does not know'
  }

  if (record.captures.length > CAPTURES_KEPT || record.captures.some((capture, index) => index && capture[0] <= record.captures[index - 1][0])) {
    return 'holds captures that are too many or out of order'
  }

  const ids = Object.keys(record.objects)

  if (ids.length > MAX_OBJECTS || !ids.every((id) => /^[1-9][0-9]*$/.test(id)) || !Object.values(record.objects).every(isEntry)) {
    return 'holds an object this version cannot read'
  }

  if (record.captures.length && Object.values(record.objects).some((entry) => entry[1] > record.captures[record.captures.length - 1][0])) {
    return 'holds an object seen after its newest capture'
  }

  if (!record.captures.length && ids.length) {
    return 'holds objects with no capture'
  }

  const times = new Set(record.captures.map(([t]) => t))
  const cut = isKnownNumber(record.cut) ? record.cut : -Infinity

  if (Object.values(record.objects).some(([first, last]) => !times.has(last) || !(times.has(first) || first <= cut))) {
    return 'holds an object that no capture saw'
  }

  if (record.failures !== undefined && !(Array.isArray(record.failures) && record.failures.length <= FAILURES_KEPT && record.failures.every(isFailure))) {
    return 'holds a failure this version cannot read'
  }

  if ((record.cut !== undefined && !Number.isFinite(record.cut)) || (record.seed !== undefined && !Number.isFinite(record.seed))) {
    return 'holds a cut or a seed this version cannot read'
  }

  return null
}

// Why a stored observation file cannot be read by this version, or null when it can. `{}` (no file) reads as none.
export const observationFileProblem = (file) => {
  if (file === undefined || file === null || (isObject(file) && !Object.keys(file).length)) {
    return null
  }

  if (!isObject(file) || file.version !== OBSERVATION_VERSION || !isObject(file.races) || Object.keys(file).some((key) => !['version', 'races'].includes(key))) {
    return 'not an observation file this version reads'
  }

  for (const [RaceID, race] of Object.entries(file.races)) {
    if (!/^[1-9][0-9]*$/.test(RaceID) || !isObject(race) || !isObject(race.kinds) || Object.keys(race).some((key) => key !== 'kinds')) {
      return `race ${RaceID} is not a record`
    }

    for (const [kind, record] of Object.entries(race.kinds)) {
      const problem = OBSERVED_KINDS[kind] ? recordProblem(record) : 'is not a kind this version observes'

      if (problem) {
        return `race ${RaceID} ${kind} ${problem}`
      }
    }
  }

  return null
}
