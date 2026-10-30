// Colony series: the opt-in record of chosen colonies, one observation per game save the recorder sees. Empire History (utilities/history.js) keeps one aggregate per race; this keeps the stocks of colonies the player chose, each as the save showed it at its game time, and never anything between two saves. The choice is campaign state, `campaign.<campaign id>.race.<RaceID>.historyColonies` in the settings; the series of a branch is its own file beside the branch file, `campaign-<campaign id>-<branch id>-colonies.json`:
// { columns: [...COLONY_COLUMNS], races: { [RaceID]: { snapshots: [{ t, n, d, revised?, colonies: [[PopulationID, state, ...values]] }], thinning? } } }
// `t` is the game time of the save, `n` the increments its ledger held (the width of the unobserved interval between two snapshots), `d` a digest of `colonies`. `state` is 0 observed (the values follow, a missing stored value is null and a stored zero is 0), 1 gone (no row for the colony in the save), 2 another race's (the race that holds it follows), 3 not the colony that was chosen (the row is the race's but on another body) or 4 not read (the read failed). A colony with no entry in a snapshot was not chosen at that time. Nothing here is ever a 0 that was not observed.

import { branchFileName, hashValue, thinningUpTo } from './campaign'
import { isKnownNumber } from './math'

// The most colonies one race has chosen at a time: 5.3 MB at the snapshot cap and about 0.2 s a rewrite, against 37.6 MB and about 2 s for the 432 colonies of the largest race measured.
export const MAX_COLONIES = 50

// What one colony costs in one snapshot as stored, in bytes of compact JSON: measured 43 to 65 B for populated colonies, 116 B for a lone one. The size shown before a colony is chosen is snapshots x colonies x this.
export const COLONY_BYTES = 55

// The figures of an observed colony in `[id, 0, ...values]` order, the column each is read from and the rounding it is kept at (population to 0.001 million, the rest to whole units).
const FIGURES = [
  ['population', 'Population', 1000],
  ['fuel', 'FuelStockpile', 1],
  ['msp', 'MaintenanceStockpile', 1],
  ['Duranium', 'Duranium', 1],
  ['Neutronium', 'Neutronium', 1],
  ['Corbomite', 'Corbomite', 1],
  ['Tritanium', 'Tritanium', 1],
  ['Boronide', 'Boronide', 1],
  ['Mercassium', 'Mercassium', 1],
  ['Vendarite', 'Vendarite', 1],
  ['Sorium', 'Sorium', 1],
  ['Uridium', 'Uridium', 1],
  ['Corundium', 'Corundium', 1],
  ['Gallicite', 'Gallicite', 1],
]

export const COLONY_COLUMNS = Object.freeze(FIGURES.map(([name]) => name))

export const COLONY_STATES = Object.freeze({ OBSERVED: 0, GONE: 1, OTHER_RACE: 2, DIFFERENT: 3, UNAVAILABLE: 4 })

// What a state that is not an observation says, for a chart's break in the line.
export const COLONY_STATE_TEXT = Object.freeze({ 1: 'gone from this save', 2: 'held by another race', 3: 'not the colony that was chosen', 4: 'not read' })

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export const colonyFileName = (campaignId, branchId) => `${branchFileName(campaignId, branchId)}-colonies`

// ---- The choice ----------------------------------------------------------------------------------------------------

// A colony the player chose: { id, since, name, bodyId, raceId, until? }. `since` is the game time of the save that was open when it was chosen, `until` the one when it was dropped (the series is kept); `name`, `bodyId` and `raceId` are the colony's name, body and owner then, the stamp a later save's colony of that ID is compared with.
const validEntry = (entry) => isObject(entry) && Number.isSafeInteger(entry.id) && entry.id > 0 && Number.isFinite(entry.since) && (entry.until === undefined || Number.isFinite(entry.until))

export const entriesOf = (list) => (Array.isArray(list) ? list.filter(validEntry) : [])

// The entries without an `until`: the colonies chosen now.
export const chosenNow = (entries) => entries.filter((entry) => entry.until === undefined)

// The entries that apply to a save at game time `t`: chosen at or before it and not dropped before it.
export const activeAt = (entries, t) => entries.filter((entry) => entry.since <= t && (entry.until === undefined || t <= entry.until))

export class ColonyLimit extends Error {
  constructor (limit = MAX_COLONIES) {
    super(`At most ${limit} colonies of a race can be followed at a time`)
    this.name = 'ColonyLimit'
    this.limit = limit
  }
}

// The entries after choosing `colony` ({ id, name, bodyId, raceId }) at game time `since`; one already chosen is left as it is, and a choice past the limit throws ColonyLimit.
export const withColony = (entries, colony, since) => {
  if (chosenNow(entries).some((entry) => entry.id === colony.id)) {
    return entries
  }

  if (chosenNow(entries).length >= MAX_COLONIES) {
    throw new ColonyLimit()
  }

  return [...entries, { id: colony.id, since, name: colony.name, bodyId: isKnownNumber(colony.bodyId) ? Number(colony.bodyId) : null, raceId: isKnownNumber(colony.raceId) ? Number(colony.raceId) : null }]
}

// The entries after dropping the colony `id` at game time `until`: its series is kept, and no save after `until` adds to it.
export const withoutColony = (entries, id, until) => entries.map((entry) => (entry.id === id && entry.until === undefined ? { ...entry, until } : entry))

// What the recorder reads of the settings: { [campaignId]: { gameIds, races: { [RaceID]: entries } } } for each campaign (of `campaigns`, the registry's) that has chosen a colony. `stored` is the settings store's contents.
export const colonyWish = (stored, campaigns) => {
  const wish = {}

  Object.values(campaigns).filter((campaign) => !campaign.mergedInto).forEach((campaign) => {
    const own = isObject(stored) && isObject(stored.campaign) ? stored.campaign[campaign.id] : null
    const races = isObject(own) && isObject(own.race) ? own.race : {}
    const wanted = Object.fromEntries(Object.entries(races).map(([RaceID, values]) => [RaceID, entriesOf(isObject(values) ? values.historyColonies : null)]).filter(([, entries]) => entries.length))

    if (Object.keys(wanted).length) {
      wish[campaign.id] = { gameIds: campaign.gameIds, races: wanted }
    }
  })

  return wish
}

// Whether the settings contents hold a colony chosen anywhere. The recorder reads the registry for `colonyWish` only when one is, so a pass with no colony chosen reads the registry no more often than it did before colonies could be chosen.
export const colonyChosen = (stored) => isObject(stored) && isObject(stored.campaign) && Object.values(stored.campaign).some((own) => isObject(own) && isObject(own.race) && Object.values(own.race).some((values) => isObject(values) && entriesOf(values.historyColonies).length > 0))

// The colony IDs to read for a race of a game at game time `t`, over every campaign that holds the game (the campaign the save settles to is known only after it is read): none when no campaign chose a colony of the race then.
export const idsToRead = (wish, GameID, RaceID, t) => [...new Set(Object.values(wish).filter((campaign) => campaign.gameIds.includes(GameID)).flatMap((campaign) => activeAt(campaign.races[RaceID] || [], t).map((entry) => entry.id)))].sort((a, b) => a - b)

// The entries of the campaign the save settled to that apply at `t`.
export const entriesAt = (wish, campaignId, RaceID, t) => (wish[campaignId] ? activeAt(wish[campaignId].races[RaceID] || [], t) : [])

// Writes the entries of one race into settings contents (`stored`, as `settings.update` gives them), creating the path.
export const putEntries = (stored, campaignId, RaceID, entries) => {
  const campaigns = (stored.campaign = isObject(stored.campaign) ? stored.campaign : {})
  const campaign = (campaigns[campaignId] = isObject(campaigns[campaignId]) ? campaigns[campaignId] : {})
  const races = (campaign.race = isObject(campaign.race) ? campaign.race : {})
  const race = (races[RaceID] = isObject(races[RaceID]) ? races[RaceID] : {})

  race.historyColonies = entries
}

// Changes one race's entries as `change(entries)` says, in one read-change-write of the settings (so another window's write is not lost), and returns the entries written. A change that throws writes nothing.
export const saveEntries = (settings, campaignId, RaceID, change) => {
  let written = []

  settings.update((stored) => {
    const current = isObject(stored.campaign) && isObject(stored.campaign[campaignId]) && isObject(stored.campaign[campaignId].race) && isObject(stored.campaign[campaignId].race[RaceID]) ? entriesOf(stored.campaign[campaignId].race[RaceID].historyColonies) : []

    written = change(current)
    putEntries(stored, campaignId, RaceID, written)

    return stored
  })

  return written
}

// ---- Reading a save ------------------------------------------------------------------------------------------------

// The statement that reads the chosen colonies of a game: the row of each, if the save has one, with its owner and body to tell whether it is still the colony that was chosen.
export const colonySql = (GameID, ids) => `select FCT_Population.PopulationID, FCT_Population.RaceID, FCT_Population.SystemBodyID, ${FIGURES.map(([, column]) => `FCT_Population.${column}`).join(', ')} from FCT_Population where FCT_Population.GameID = ${Number(GameID)} and FCT_Population.PopulationID in (${ids.map(Number).join(', ')})`

// What one pass takes of the colonies of a race: { ids, rows } or, when the read failed, { ids, failed: error }. The failure is kept, not thrown, so the empire snapshot of the pass does not fail with it.
export const readColonies = async (database, { GameID, ids }, options = {}) => {
  try {
    const [rows] = await database.query(colonySql(GameID, ids), options)

    return { ids, rows }
  } catch (error) {
    return { ids, failed: error }
  }
}

const figure = (value, scale) => (isKnownNumber(value) ? Math.round(Number(value) * scale) / scale : null)

// The colonies of a snapshot, [[PopulationID, state, ...values]] in ID order: one for each colony of `entries` (those that apply at the save's time; the latest entry of an ID gives the stamp), from what `read` ({ rows } or { failed }) found. A colony the read does not show is gone, never 0; a read that failed leaves every colony not read.
export const colonyRows = (entries, read) => {
  const stamps = new Map()

  entries.slice().sort((a, b) => a.since - b.since).forEach((entry) => stamps.set(entry.id, entry))

  const found = new Map((read.rows || []).map((row) => [Number(row.PopulationID), row]))

  return [...stamps.values()].sort((a, b) => a.id - b.id).map((entry) => {
    const row = found.get(entry.id)

    if (read.failed) {
      return [entry.id, COLONY_STATES.UNAVAILABLE]
    }

    if (!row) {
      return [entry.id, COLONY_STATES.GONE]
    }

    if (isKnownNumber(entry.raceId) && !isKnownNumber(row.RaceID)) {
      return [entry.id, COLONY_STATES.UNAVAILABLE]
    }

    if (isKnownNumber(entry.raceId) && Number(row.RaceID) !== Number(entry.raceId)) {
      return [entry.id, COLONY_STATES.OTHER_RACE, Number(row.RaceID)]
    }

    if (isKnownNumber(entry.bodyId) && !isKnownNumber(row.SystemBodyID)) {
      return [entry.id, COLONY_STATES.UNAVAILABLE]
    }

    if (isKnownNumber(entry.bodyId) && Number(row.SystemBodyID) !== Number(entry.bodyId)) {
      return [entry.id, COLONY_STATES.DIFFERENT]
    }

    return [entry.id, COLONY_STATES.OBSERVED, ...FIGURES.map(([, column, scale]) => figure(row[column], scale))]
  })
}

export const colonyDigest = (colonies) => hashValue(colonies)

// A snapshot of `colonies` at game time `t` on a ledger of `n` increments.
export const colonySnapshot = ({ t, n, colonies, revised = false }) => ({ t, n, d: colonyDigest(colonies), ...(revised ? { revised: true } : {}), colonies })

// The colonies of two snapshots at one game time, `stored` and `incoming` (a second read of the same save, or a later pass over it): every colony either holds, the incoming entry replacing the stored one except where it is a failed read over an observation (which never erases it). `revised` is true when an entry that had been observed now differs.
export const joinColonies = (stored, incoming) => {
  const joined = new Map(stored.map((entry) => [entry[0], entry]))
  let revised = false

  incoming.forEach((entry) => {
    const old = joined.get(entry[0])

    if (!old) {
      joined.set(entry[0], entry)
    } else if (!(entry[1] === COLONY_STATES.UNAVAILABLE && old[1] !== COLONY_STATES.UNAVAILABLE) && JSON.stringify(old) !== JSON.stringify(entry)) {
      revised = revised || old[1] !== COLONY_STATES.UNAVAILABLE
      joined.set(entry[0], entry)
    }
  })

  return { colonies: [...joined.values()].sort((a, b) => a[0] - b[0]), revised }
}

// ---- Branches ------------------------------------------------------------------------------------------------------

// Whether a file holds a series of some race.
export const hasRaces = (file) => isObject(file) && isObject(file.races) && Object.keys(file.races).length > 0

// Whether a branch has a colony file of its own: one written by a capture, a fork's seed or a clear, even when every race was cleared from it. Such a file is never seeded from the parent again, so what was cleared stays cleared.
const written = (file) => isObject(file) && isObject(file.races)

// Whether a branch was given its colony seed when it was created (`coloniesSeeded` on its registry entry, set once the seed file, if the parent held any series, was written). Such a branch with no colony file started empty and is never seeded from its parent afterwards, so what the parent records or clears later never reaches it. A branch without the mark predates it, or was caught between the registry write and the mark, and is seeded from its parent at its first colony write.
const seeded = (branch) => Boolean(branch && branch.coloniesSeeded === true)

// The series of a file cut to the snapshots at or before game time `t`: what a branch forked at `t` is seeded with. A series' thinning record comes along only where it still holds for the cut (campaign.js `thinningUpTo`); a race with no snapshot left is dropped; nothing at all gives {}.
export const colonyUpTo = (file, t) => {
  if (!hasRaces(file) || !isKnownNumber(t)) {
    return {}
  }

  const races = Object.fromEntries(Object.entries(file.races).map(([RaceID, record]) => {
    const snapshots = (record.snapshots || []).filter((snapshot) => snapshot.t <= t)
    const fields = { ...record, snapshots }
    const thinning = thinningUpTo(record, snapshots, t)

    delete fields.thinning

    return [RaceID, thinning ? { ...fields, thinning } : fields]
  }).filter(([, record]) => record.snapshots.length))

  return Object.keys(races).length ? { columns: COLONY_COLUMNS, races } : {}
}

// The series a branch starts from when it has no file yet: its own file's contents when it has them, else its parent's up to the fork (and the parent's own parent's up to the parent's fork, and so on). The records of two branches are never merged: a fork takes the parent's past and the two go on apart. `io` is the storage (`io.file(name).store`), `campaign` the registry's entry. A branch with no parent, or one forked before any increment was common, starts empty.
export const colonySeed = (io, campaign, branchId, t) => {
  const file = io.file(colonyFileName(campaign.id, branchId)).store

  if (written(file)) {
    return colonyUpTo(file, t)
  }

  const branch = campaign.branches[branchId]

  return branch && !seeded(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}
}

// The file a branch's next colony snapshots are merged into: its own, or when it has none, the seed of its fork (a branch forked from the branch `parent` at game time `fork.t`).
export const colonyBase = (io, campaign, branchId) => {
  const stored = io.file(colonyFileName(campaign.id, branchId)).store

  if (written(stored)) {
    return stored
  }

  const branch = campaign.branches[branchId]

  return branch && !seeded(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, branch.fork.t) : {}
}

// The colony file a branch is given in the pass that creates it: the seed of its fork, frozen there so that a later clear or revision of the parent changes nothing in the child. Null when the branch has a file already or the parent holds no colony series up to the fork (a branch already marked seeded has none to give, `colonyBase`), so a campaign that never followed a colony gets no colony file; the caller then marks the branch seeded (`coloniesSeeded`), which is what keeps an empty seed empty.
export const colonyForkFile = (io, campaign, branchId) => {
  if (written(io.file(colonyFileName(campaign.id, branchId)).store)) {
    return null
  }

  const seed = colonyBase(io, campaign, branchId)

  return hasRaces(seed) ? seed : null
}

// ---- Size ----------------------------------------------------------------------------------------------------------

// The predicted bytes of `colonies` colonies in `snapshots` snapshots: a prediction, labelled as one wherever it is shown.
export const colonyEstimate = ({ snapshots, colonies }) => snapshots * colonies * COLONY_BYTES
