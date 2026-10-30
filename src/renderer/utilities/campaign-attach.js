// What the player can do with a record that could not be tied to a campaign by itself (utilities/campaign.js): a new campaign recorded beside candidates that share its GameID (pending), and legacy history that was kept unattached (the pool). Attaching copies: the history of the source is merged into a branch of the chosen campaign (a snapshot at a game time the branch already holds is kept as the branch has it, none is removed), the settings the source holds are copied where the campaign has none (a value the campaign holds is never overwritten), and the source stays as it was, marked as attached. An attachment is idempotent, so one that stopped part way is run again. Nothing here touches a save.

import { branchFileName, campaignSettingsOf, legacyFileName, legacyGameSettings, mergeAnchors, readRegistry, writeRegistry } from './campaign'
import { thinCounted, thinningOfMerge } from './history'
import { requireRecording } from './recording-owner'

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Two lists of snapshots as one in time order; where both hold one at a game time, the first list's stays. `overlaps` counts those. `outcome` is what thinning the union gave (`thinCounted`).
const unionSnapshots = (kept, added) => {
  const known = new Set(kept.map((snapshot) => snapshot.t))
  const fresh = added.filter((snapshot) => !known.has(snapshot.t))
  const outcome = thinCounted([...kept, ...fresh].sort((a, b) => a.t - b.t))

  return { snapshots: outcome.snapshots, outcome, overlaps: added.length - fresh.length, added: fresh.length }
}

// The records of `kept` with those of `added` merged in. A merged series' thinning record is made from both series and the thinning the merge itself needed (`thinningOfMerge`): the game times of the result alone never show that nothing was lost.
const mergeRecords = (kept, added) => {
  const merged = { ...kept }
  let overlaps = 0
  let count = 0

  Object.entries(isObject(added) ? added : {}).forEach(([id, record]) => {
    const result = unionSnapshots(merged[id] && Array.isArray(merged[id].snapshots) ? merged[id].snapshots : [], Array.isArray(record.snapshots) ? record.snapshots : [])
    const series = { ...record, ...(merged[id] || {}), snapshots: result.snapshots }
    const thinning = thinningOfMerge([merged[id], record], result.outcome)

    delete series.thinning
    merged[id] = thinning ? { ...series, thinning } : series
    overlaps += result.overlaps
    count += result.added
  })

  return { merged, overlaps, added: count }
}

// A history file with another merged into it: { history, overlaps, added }, the counts being snapshots (of races and of what they know of alien races) that both files hold at one game time, and that the other file added.
export const mergeHistories = (kept, added) => {
  const races = mergeRecords(isObject(kept.races) ? kept.races : {}, added.races)
  const intel = { ...(isObject(kept.intel) ? kept.intel : {}) }
  let overlaps = races.overlaps
  let count = races.added

  Object.entries(isObject(added.intel) ? added.intel : {}).forEach(([view, aliens]) => {
    const result = mergeRecords(isObject(intel[view]) ? intel[view] : {}, aliens)

    intel[view] = result.merged
    overlaps += result.overlaps
    count += result.added
  })

  return { history: { gameName: kept.gameName !== undefined ? kept.gameName : added.gameName, races: races.merged, intel }, overlaps, added: count }
}

// The race settings that belong to one branch of the campaign they were made in, never copied by an attach: a pin names its branch by id, and the ids of another campaign (or the new branch an attach makes) are other timelines, so a copy would show the pin on a branch it was never made on.
const BRANCH_BOUND_KEYS = ['logPins']

// The settings subtree `{ race: { [RaceID]: { [key]: value } } }` with the values of `added` that `kept` holds none for: { settings, copied, kept }.
const mergeSettings = (kept, added) => {
  const merged = clone(isObject(kept) ? kept : {}) || {}
  let copied = 0
  let skipped = 0

  Object.entries(isObject(added) && isObject(added.race) ? added.race : {}).forEach(([RaceID, values]) => {
    merged.race = isObject(merged.race) ? merged.race : {}
    merged.race[RaceID] = isObject(merged.race[RaceID]) ? merged.race[RaceID] : {}

    Object.entries(isObject(values) ? values : {}).filter(([key]) => !BRANCH_BOUND_KEYS.includes(key)).forEach(([key, value]) => {
      if (merged.race[RaceID][key] === undefined) {
        merged.race[RaceID][key] = clone(value)
        copied += 1
      } else {
        skipped += 1
      }
    })
  })

  return { settings: merged, copied, kept: skipped }
}

const spanOf = (history) => {
  const records = [...Object.values(isObject(history.races) ? history.races : {})]
  const times = records.flatMap((record) => (Array.isArray(record.snapshots) ? record.snapshots.map((snapshot) => snapshot.t) : [])).filter((time) => typeof time === 'number')

  return { first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null, snapshots: records.reduce((total, record) => total + (Array.isArray(record.snapshots) ? record.snapshots.length : 0), 0), races: records.length }
}

// What a source holds, from the registry and the files: { label, GameID, gameName, history, settings, tip }. `from` is { campaignId } (a pending campaign, with every branch of it merged in order) or { poolId } (legacy history kept unattached).
const sourceOf = (io, registry, from) => {
  if (from.poolId) {
    const entry = registry.pool[from.poolId]

    if (!entry) {
      throw new Error('That unattached history is not recorded')
    }

    const settings = legacyGameSettings(io.settings.store, entry.GameID)
    const file = io.file(legacyFileName(entry.GameID)).store

    return { label: `legacy history of game ${entry.GameID}`, GameID: entry.GameID, gameName: entry.gameName, history: isObject(file) ? clone(file) : {}, settings: campaignSettingsOf(settings), tip: null }
  }

  const campaign = registry.campaigns[from.campaignId]

  if (!campaign) {
    throw new Error('That campaign is not recorded')
  }

  const histories = Object.values(campaign.branches).map((branch) => io.file(branchFileName(campaign.id, branch.id)).store)
  const history = histories.reduce((merged, next) => mergeHistories(merged, isObject(next) ? next : {}).history, {})
  const settings = isObject(io.settings.store.campaign) ? io.settings.store.campaign[campaign.id] : undefined

  const tips = Object.values(campaign.branches).map((branch) => branch.tip).sort((a, b) => b.n - a.n)

  return { label: `campaign ${campaign.names[campaign.names.length - 1].name}`, GameID: campaign.gameIds[0], gameName: campaign.names[campaign.names.length - 1].name, history, settings: clone(settings), tip: tips[0] || null, anchor: campaign.anchor, names: campaign.names, gameIds: campaign.gameIds }
}

// What attaching `from` to a branch of a campaign would do, for the player to read before choosing: { source, target, overlaps, added, settingsCopied, settingsKept }. `source` and `target` give the name, game id, recorded span and snapshot counts of each side. `mode` is 'same' (merge into the branch) or 'new-branch' (a branch of its own under it).
export const previewAttach = (io, { from, to, mode = 'same' }) => {
  const registry = readRegistry(io)
  const source = sourceOf(io, registry, from)
  const campaign = registry.campaigns[to.campaignId]

  if (!campaign || !campaign.branches[to.branchId]) {
    throw new Error('That campaign or branch is not recorded')
  }

  const stored = io.file(branchFileName(campaign.id, to.branchId)).store
  const target = isObject(stored) ? stored : {}
  const merged = mode === 'new-branch' ? { overlaps: 0, added: spanOf(source.history).snapshots } : mergeHistories(target, source.history)
  const own = isObject(io.settings.store.campaign) ? io.settings.store.campaign[campaign.id] : undefined
  const settings = mergeSettings(own, source.settings)
  const last = campaign.names[campaign.names.length - 1]

  return {
    source: { label: source.label, GameID: source.GameID, gameName: source.gameName, ...spanOf(source.history) },
    target: { campaignId: campaign.id, branchId: to.branchId, GameID: campaign.gameIds[0], gameName: last ? last.name : null, ...spanOf(target) },
    overlaps: merged.overlaps,
    added: merged.added,
    settingsCopied: settings.copied,
    settingsKept: settings.kept,
  }
}

// Attaches `from` (see previewAttach) to a branch of a campaign: `mode` 'same' merges its history into the branch, 'new-branch' makes a branch of its own under it. Writes the history first, then the settings, then the registry, each after `guard()`. Returns { campaignId, branchId }.
export const attach = (io, { from, to, mode = 'same', now = Date.now(), guard = () => {} }) => {
  requireRecording()
  const registry = readRegistry(io)
  const source = sourceOf(io, registry, from)
  const campaign = registry.campaigns[to.campaignId]

  if (!campaign || !campaign.branches[to.branchId]) {
    throw new Error('That campaign or branch is not recorded')
  }

  if (from.campaignId && from.campaignId === to.campaignId) {
    throw new Error('A campaign cannot be attached to itself')
  }

  const done = from.campaignId ? registry.campaigns[from.campaignId].mergedInto : registry.pool[from.poolId].attachedTo

  if (done && done.campaignId === to.campaignId) {
    return { campaignId: done.campaignId, branchId: done.branchId }
  }

  let branchId = to.branchId

  if (mode === 'new-branch') {
    branchId = `b${++campaign.branchSeq}`
    campaign.branches[branchId] = { id: branchId, parent: to.branchId, fork: null, createdAt: now, seen: now, tip: source.tip ? clone(source.tip) : { n: 0, t: null, digest: '', checkpoints: [], early: {} } }
  } else if (source.tip && source.tip.n >= campaign.branches[branchId].tip.n) {
    campaign.branches[branchId].tip = clone(source.tip)
  }

  if (source.anchor) {
    campaign.anchor = mergeAnchors(campaign.anchor, source.anchor)
    campaign.names = [...campaign.names, ...source.names.filter((entry) => !campaign.names.some((known) => known.name === entry.name))]
    campaign.gameIds = [...campaign.gameIds, ...source.gameIds.filter((GameID) => !campaign.gameIds.includes(GameID))]
  }

  const stored = io.file(branchFileName(campaign.id, branchId)).store
  const history = mergeHistories(isObject(stored) ? stored : {}, source.history).history
  guard()
  io.file(branchFileName(campaign.id, branchId)).store = history

  if (source.settings) {
    guard()

    // Merged over the campaign's settings as they are when written: a page of another window may have written one meanwhile.
    io.settings.update((all) => ({ ...all, campaign: { ...(isObject(all.campaign) ? all.campaign : {}), [campaign.id]: mergeSettings(isObject(all.campaign) ? all.campaign[campaign.id] : undefined, source.settings).settings } }))
  }

  if (from.campaignId) {
    const retired = registry.campaigns[from.campaignId]

    retired.mergedInto = { campaignId: campaign.id, branchId, at: now }
    retired.attachments.forEach((attachment) => {
      const known = campaign.attachments.find((other) => other.path === attachment.path && other.GameID === attachment.GameID)

      if (known) {
        known.branchId = branchId
        known.answer = 'attached-by-player'
        known.pending = []
        known.lastSeen = Math.max(known.lastSeen, attachment.lastSeen)
      } else {
        campaign.attachments.push({ ...attachment, branchId, answer: 'attached-by-player', pending: [] })
      }
    })
  } else {
    registry.pool[from.poolId].attachedTo = { campaignId: campaign.id, branchId, at: now }
  }

  campaign.attachments = campaign.attachments.sort((a, b) => b.lastSeen - a.lastSeen)
  guard()
  writeRegistry(io, registry)

  return { campaignId: campaign.id, branchId }
}

// The player's answer that a pending campaign is a campaign of its own: the question is closed on every attachment of it, and nothing is written to the candidates.
export const keepSeparate = (io, campaignId) => {
  requireRecording()
  const registry = readRegistry(io)
  const campaign = registry.campaigns[campaignId]

  if (!campaign) {
    throw new Error('That campaign is not recorded')
  }

  campaign.attachments.forEach((attachment) => {
    if (attachment.pending && attachment.pending.length) {
      attachment.answer = 'separate'
      attachment.pending = []
    }
  })
  writeRegistry(io, registry)
}
