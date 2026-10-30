// Campaign identity for the app's own records (Empire History, race-owned settings). A save carries no campaign identifier: GameID is a per-file counter and GameName can be edited or repeated, so neither names a campaign. The app therefore keeps its own opaque campaign identifiers and decides which one an opened save belongs to from two read-only facts of the save that Aurora writes anyway, the anchor (the lowest-numbered systems other than the home system) and the increment ledger (FCT_Increments, an append-only chain that a later save extends, an older save is a prefix of and a replayed save forks from). The path of the file is never an identity: a moved, renamed or copied save is the same campaign. See docs/plans/backlog/evidence/AE-033-01.md and docs/plans/backlog/evidence/AE-033-02.md.
//
// Storage is injected as `io` so the rules run on in-memory stores in a check: `io.registry` (the campaigns, their branches and attachments, and the unattached legacy pool), `io.migration` (the preserved originals of the legacy migration), `io.settings` (the app's settings, whose `campaign.<id>.race.<RaceID>.` subtrees this module moves race-owned keys into) and `io.file(name)` (one history file). Every store is read and written whole through `.store`. Nothing here touches a save.

export const STEP = 64
export const EARLY_COUNTS = [8, 16, 32]
export const ANCHOR_LIMIT = 16
export const MIN_ANCHOR = 8
export const REGISTRY_VERSION = 1
export const FIRST_BRANCH = 'b1'
export const MIGRATION_NAME = 'campaigns-v1'

const ANCHOR_COLUMNS = ['SystemID', 'SystemNumber', 'Age', 'AbundanceModifier', 'Stars', 'DustDensity', 'SystemTypeID']
const ATTACHMENT_LIMIT = 50

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// A write was asked for after the pass that wanted it had been replaced by a newer save (the store's freshness generation moved on). Nothing past the check is written.
export class Superseded extends Error {
  constructor () {
    super('The save was replaced while its campaign was being recorded')
    this.name = 'Superseded'
    this.superseded = true
  }
}

// The key prefix of a race's own settings in a campaign, and the names of its history files.
export const raceKeyPrefix = (campaignId, RaceID) => `campaign.${campaignId}.race.${RaceID}`

export const branchFileName = (campaignId, branchId) => `campaign-${campaignId}-${branchId}`

export const legacyFileName = (GameID) => `game-${GameID}`

// ---- Reading a save ------------------------------------------------------------------------------------------------

const wholeNumber = (value) => {
  const number = Number(value)

  if (!Number.isInteger(number)) {
    throw new TypeError(`Not a whole number: ${value}`)
  }

  return number
}

export const anchorSql = (GameID) => `select FCT_System.SystemID, FCT_System.SystemNumber, round(FCT_System.Age, 4) as Age, FCT_System.AbundanceModifier, FCT_System.Stars, FCT_System.DustDensity, FCT_System.SystemTypeID from FCT_System where FCT_System.GameID = ${wholeNumber(GameID)} and FCT_System.SolSystem = 0 order by FCT_System.SystemID limit ${ANCHOR_LIMIT}`

export const ledgerSql = (GameID) => `select FCT_Increments.IncrementID, FCT_Increments.GameTime, FCT_Increments.Length from FCT_Increments where FCT_Increments.GameID = ${wholeNumber(GameID)} order by FCT_Increments.IncrementID`

export const GAMES_SQL = 'select FCT_Game.GameID, FCT_Game.GameName, FCT_Game.GameTime from FCT_Game'

// A digest of a text: two 32-bit mixing passes over its characters, as 16 hex digits (64 bits). It is evidence that two texts are equal, not a security hash; independent campaigns agree on at most the first increments of a shared template, so a chance match over 64 increments or more is a 64-bit collision.
export const hashText = (text) => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

// A short, order-stable text of a JSON value, for the hashes that guard preserved originals.
export const hashValue = (value) => hashText(value === undefined ? 'undefined' : JSON.stringify(value))

// The chained digest of a game's ledger, `rows` being [{ IncrementID, GameTime, Length }] in IncrementID order: { count, lastId, digest, checkpoints, times, exact, early, lengthDigest, exactLength }. `checkpoints[i]` is the digest after (i + 1) * STEP increments and `times[i]` the game time there; `exact` holds the digest after each of the counts in `marks` (the stored tips the caller will compare against), so a save that extends a stored tip is checked at that exact position and not only at the last checkpoint below it; `early` holds the digest after each of EARLY_COUNTS that the ledger reaches, so two short ledgers that already differ are told apart before STEP increments exist. `lengthDigest` and `exactLength` are the same chain with each increment's Length folded in, the digest a snapshot's witness keeps (utilities/history.js `isChain`): two forks of one ledger can share the ID and game time of the increment where they part and differ only in its Length. The identity digest above never changes, so the tips already stored keep their meaning.
export const scanLedger = (rows, marks = []) => {
  const wanted = new Set(marks)
  const checkpoints = []
  const times = []
  const exact = {}
  const early = {}
  const exactLength = {}
  let digest = ''
  let lengthDigest = ''

  rows.forEach((row, index) => {
    const count = index + 1

    digest = hashText(`${digest}${row.IncrementID}:${row.GameTime};`)
    lengthDigest = hashText(`${lengthDigest}${row.IncrementID}:${row.GameTime}:${row.Length};`)

    if (count % STEP === 0) {
      checkpoints.push(digest)
      times.push(Number(row.GameTime))
    }

    if (wanted.has(count)) {
      exact[count] = digest
      exactLength[count] = lengthDigest
    }

    if (EARLY_COUNTS.includes(count)) {
      early[count] = digest
    }
  })

  return { count: rows.length, lastId: rows.length ? Number(rows[rows.length - 1].IncrementID) : null, digest, checkpoints, times, exact, early, lengthDigest, exactLength }
}

const numberOrNull = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

// The anchor rows as plain arrays in ANCHOR_COLUMNS order, so two reads of one system compare equal whatever their driver returns.
export const anchorOf = (rows) => rows.map((row) => ANCHOR_COLUMNS.map((column) => numberOrNull(row[column])))

// What one game of an opened save shows: `{ GameID, gameName, t, anchor, count, lastId, digest, checkpoints, times, exact }`. `games` is the result of GAMES_SQL's row for the game. One read of the three tables, so a caller reads it inside the pass's read transaction.
export const observeGame = async (database, { GameID, GameName, GameTime }, { options = {}, marks = [] } = {}) => {
  const [anchorRows] = await database.query(anchorSql(GameID), options)
  const [ledgerRows] = await database.query(ledgerSql(GameID), options)

  return { GameID: Number(GameID), gameName: GameName === null || GameName === undefined ? null : String(GameName), t: numberOrNull(GameTime), anchor: anchorOf(anchorRows), ...scanLedger(ledgerRows, marks) }
}

// ---- Relating a save to a recorded campaign ------------------------------------------------------------------------

// Whether two anchors are of one campaign: 'conflict' (a system both hold differs, or a lower-numbered system one holds is missing from the other), 'agree' (no conflict and at least MIN_ANCHOR systems in common) or 'thin' (no conflict, too few in common to tell: a template or a new game).
export const anchorRelation = (a, b) => {
  const left = new Map(a.map((row) => [row[0], row]))
  const right = new Map(b.map((row) => [row[0], row]))
  const common = [...left.keys()].filter((id) => right.has(id))

  if (common.some((id) => left.get(id).some((value, index) => value !== right.get(id)[index]))) {
    return 'conflict'
  }

  const [short, long] = left.size <= right.size ? [left, right] : [right, left]
  const highest = Math.max(-Infinity, ...long.keys())

  if ([...short.keys()].some((id) => id <= highest && !long.has(id))) {
    return 'conflict'
  }

  return common.length >= MIN_ANCHOR ? 'agree' : 'thin'
}

// The most increments, in a multiple of STEP, that two chains of checkpoints agree through: 0 when they differ from the first checkpoint. The chain is cumulative, so once a checkpoint differs every later one does.
export const commonPrefix = (a, b) => {
  let low = 0
  let high = Math.min(a.length, b.length)

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)

    if (a[middle - 1] === b[middle - 1]) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return low * STEP
}

// Whether two ledgers that are both shorter than STEP already differ: at the stored tip's own count when the opened game reaches it (`opened.exact`), else at the longest of EARLY_COUNTS both reach.
const contradicts = (tip, opened, known, agrees) => {
  if (known) {
    return !agrees
  }

  const reached = EARLY_COUNTS.filter((count) => count <= tip.n && count <= opened.count && tip.early && tip.early[count] !== undefined && opened.early && opened.early[count] !== undefined)

  return reached.some((count) => tip.early[count] !== opened.early[count])
}

// How an opened game relates to a recorded branch tip. `stored` is { anchor, tip: { n, digest, checkpoints, early }, names }; `opened` is observeGame's result. The relation is one of:
// - 'different': a system both hold differs, or the ledgers differ already inside their first STEP increments (so an early fork is a separate campaign, never a merge), so these are independent campaigns;
// - 'insufficient': too little to tell (fewer than STEP increments in common, or a thin anchor), so the player is asked; `consistent` is true when what is held agrees with the stored tip and the opened ledger is not the shorter (a continuation or a copy, not a rewind or a stranger that happens to share a start);
// - 'same', 'continues', 'rewound': the opened ledger is the stored tip, extends it, or is a prefix of it;
// - 'fork': the ledgers share a start and then differ (a save rewound and played on).
// A thin anchor is accepted as the same campaign only for the very same point of the ledger under the same game name (a copy of the file): a longer ledger over a thin anchor is not told from a template twin. Returns { relation, common, consistent }, `common` the increments the chains were compared through.
export const relate = (stored, opened) => {
  const anchor = anchorRelation(stored.anchor, opened.anchor)

  if (anchor === 'conflict') {
    return { relation: 'different', common: 0, consistent: false }
  }

  const { n, digest, checkpoints } = stored.tip
  const known = opened.count >= n && (n === 0 || (opened.exact && opened.exact[n] !== undefined))
  let common = 0
  let agrees = null

  if (known) {
    common = n
    agrees = n === 0 || opened.exact[n] === digest
  } else {
    common = Math.floor(Math.min(n, opened.count) / STEP) * STEP
    agrees = common > 0 ? checkpoints[common / STEP - 1] === opened.checkpoints[common / STEP - 1] : null
  }

  if (common < STEP) {
    if (contradicts(stored.tip, opened, known, agrees)) {
      return { relation: 'different', common: 0, consistent: false }
    }

    // An empty recorded ledger holds no increment of the campaign: it agrees with every later save, so it identifies nothing unless the systems do.
    return { relation: 'insufficient', common, consistent: !!known && !!agrees && (n > 0 || anchor === 'agree') }
  }

  if (!agrees) {
    return { relation: anchor === 'agree' ? 'fork' : 'different', common: commonPrefix(checkpoints, opened.checkpoints), consistent: false }
  }

  const relation = opened.count === n ? 'same' : opened.count > n ? 'continues' : 'rewound'

  if (anchor === 'thin') {
    const sameName = (stored.names || []).some((entry) => entry.name === opened.gameName)

    return { relation: relation === 'same' && sameName ? 'same' : 'insufficient', common, consistent: relation !== 'rewound' }
  }

  return { relation, common, consistent: true }
}

// ---- The registry --------------------------------------------------------------------------------------------------

const damaged = (what) => new Error(`The campaign registry is damaged (${what}), so nothing was recorded and it was left as it is`)

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// Refuses a registry that is not the shape this module writes, instead of treating it as empty and writing over it. An absent registry (nothing stored yet) is valid and empty.
const validRegistry = (stored) => {
  if (isObject(stored) && !Object.keys(stored).length) {
    return
  }

  if (!isObject(stored)) {
    throw damaged('it is not an object')
  }

  if (stored.version !== undefined && (!isNumber(stored.version) || stored.version > REGISTRY_VERSION)) {
    throw damaged(`version ${stored.version} is not one this version reads`)
  }

  if (stored.campaigns !== undefined && !isObject(stored.campaigns)) {
    throw damaged('campaigns is not an object')
  }

  if (stored.pool !== undefined && !isObject(stored.pool)) {
    throw damaged('pool is not an object')
  }

  Object.entries(stored.campaigns || {}).forEach(([id, entry]) => {
    const ok = isObject(entry) && entry.id === id && Array.isArray(entry.names) && Array.isArray(entry.gameIds) && Array.isArray(entry.anchor) && Array.isArray(entry.attachments) && isObject(entry.branches) && Object.keys(entry.branches).length > 0 && isNumber(entry.branchSeq)

    if (!ok) {
      throw damaged(`campaign ${id} is not complete`)
    }

    Object.entries(entry.branches).forEach(([branchId, branch]) => {
      if (!isObject(branch) || branch.id !== branchId || !isObject(branch.tip) || !isNumber(branch.tip.n) || typeof branch.tip.digest !== 'string' || !Array.isArray(branch.tip.checkpoints)) {
        throw damaged(`branch ${branchId} of campaign ${id} is not complete`)
      }
    })
  })

  Object.entries(stored.pool || {}).forEach(([id, entry]) => {
    if (!isObject(entry) || entry.id !== id) {
      throw damaged(`unattached history ${id} is not complete`)
    }
  })
}

// What each registry object read held, as text, so a write can tell that another writer (another tab of the web build, which has no single-instance lock) changed the registry since the read it is based on.
const stamps = new WeakMap()

// The registry changed between the read a decision is based on and its write. Nothing was written; the caller reads again and decides again.
export class RegistryChanged extends Error {
  constructor () {
    super('The campaign registry was changed by another writer while it was being updated')
    this.name = 'RegistryChanged'
    this.conflict = true
  }
}

export const readRegistry = (io) => {
  const stored = io.registry.store

  validRegistry(stored)

  const registry = { version: REGISTRY_VERSION, ...clone(stored), campaigns: clone(stored.campaigns || {}), pool: clone(stored.pool || {}) }

  stamps.set(registry, JSON.stringify(stored))

  return registry
}

const tipOf = (observation) => ({ n: observation.count, t: observation.t, digest: observation.digest, checkpoints: observation.checkpoints, early: observation.early })

const RANK = { same: 0, continues: 1, rewound: 2, attached: 3 }

const campaignsOfGame = (registry, GameID) => Object.values(registry.campaigns).filter((campaign) => !campaign.mergedInto && campaign.gameIds.includes(GameID)).sort((a, b) => a.createdAt - b.createdAt)

// The stored tips' increment counts of the games a save may hold, for `scanLedger`'s `marks`: { [GameID]: [n] }.
export const marksOf = (io) => {
  const marks = {}

  Object.values(readRegistry(io).campaigns).filter((campaign) => !campaign.mergedInto).forEach((campaign) => {
    campaign.gameIds.forEach((GameID) => {
      marks[GameID] = [...(marks[GameID] || []), ...Object.values(campaign.branches).map((branch) => branch.tip.n)]
    })
  })

  return marks
}

// How one recorded campaign takes an opened game: 'match' (a branch it continues, repeats or is a prefix of, or one an answer or an earlier pass fixed to this path), 'fork' (it left a branch at a common point), 'insufficient' (no evidence either way) or 'different'. `explicit` is true when the player's own answer ('kept apart' or 'attached') fixed the save at this path to the branch.
// A path alone never decides: an inferred attachment of the path takes a save only when the evidence is consistent with it (the opened ledger holds the stored tip's own increments and goes on from there, `consistent` in `relate`); a ledger that already differs is 'different' before any path is looked at, and one that cannot be compared (shorter than the tip) is asked about.
const judgeCampaign = (campaign, opened, path) => {
  const rows = Object.values(campaign.branches).map((branch) => ({ branch, ...relate({ anchor: campaign.anchor, tip: branch.tip, names: campaign.names }, opened) }))
  const answered = path ? campaign.attachments.find((attachment) => attachment.path === path && attachment.GameID === opened.GameID && (attachment.answer === 'separate' || attachment.answer === 'attached-by-player')) : null
  const explicitRow = answered ? rows.find((row) => row.branch.id === answered.branchId && (row.relation in RANK || (row.relation === 'insufficient' && (row.consistent || row.branch.tip.n === 0)))) : null
  const strong = rows.filter((row) => row.relation in RANK).sort((a, b) => RANK[a.relation] - RANK[b.relation] || b.branch.seen - a.branch.seen)

  if (explicitRow) {
    return { kind: 'match', campaign, branch: explicitRow.branch, relation: explicitRow.relation in RANK ? explicitRow.relation : 'attached', explicit: true }
  }

  if (strong.length) {
    return { kind: 'match', campaign, branch: strong[0].branch, relation: strong[0].relation, explicit: false }
  }

  const forks = rows.filter((row) => row.relation === 'fork').sort((a, b) => b.common - a.common)

  if (forks.length) {
    return { kind: 'fork', campaign, parent: forks[0].branch, common: forks[0].common }
  }

  const thin = rows.filter((row) => row.relation === 'insufficient')

  if (thin.length) {
    const inferred = path ? campaign.attachments.find((attachment) => attachment.path === path && attachment.GameID === opened.GameID && thin.some((row) => row.consistent && row.branch.id === attachment.branchId)) : null

    if (inferred) {
      return { kind: 'match', campaign, branch: campaign.branches[inferred.branchId], relation: 'attached', explicit: false }
    }

    return { kind: 'insufficient', campaign, branches: thin.map((row) => row.branch) }
  }

  return { kind: 'different', campaign }
}

// Which campaign an opened game belongs to, against the registry: { kind: 'match', campaign, branch, relation } | { kind: 'fork', campaign, parent, common } | { kind: 'new', pending: [{ campaignId, branchId }] }. A save that no recorded campaign claims starts a new one; where a campaign shares its GameID and the evidence cannot tell, the new campaign is recorded with the candidates it may belong to, and the player decides. Nothing is merged on a guess, and the player's own answer for a path outranks what a campaign's ledger would say.
export const decide = (registry, opened, path = null) => {
  const judged = campaignsOfGame(registry, opened.GameID).map((campaign) => judgeCampaign(campaign, opened, path))
  const matches = judged.filter((entry) => entry.kind === 'match').sort((a, b) => Number(b.explicit) - Number(a.explicit) || RANK[a.relation] - RANK[b.relation])

  if (matches.length) {
    return matches[0]
  }

  const forks = judged.filter((entry) => entry.kind === 'fork').sort((a, b) => b.common - a.common)

  if (forks.length) {
    return forks[0]
  }

  return { kind: 'new', pending: judged.filter((entry) => entry.kind === 'insufficient').flatMap((entry) => entry.branches.map((branch) => ({ campaignId: entry.campaign.id, branchId: branch.id }))) }
}

export const mergeAnchors = (current, observed) => {
  if (observed.length <= current.length || anchorRelation(current, observed) === 'conflict') {
    return current
  }

  const byId = new Map([...current, ...observed].map((row) => [row[0], row]))

  return [...byId.values()].sort((a, b) => a[0] - b[0]).slice(0, ANCHOR_LIMIT)
}

const upsertAttachment = (campaign, { path, opened, branchId, now, pending = null }) => {
  const existing = campaign.attachments.find((attachment) => attachment.path === path && attachment.GameID === opened.GameID)

  if (existing) {
    existing.gameName = opened.gameName
    existing.branchId = branchId
    existing.lastSeen = now
  } else {
    campaign.attachments.push({ path, GameID: opened.GameID, gameName: opened.gameName, branchId, lastSeen: now, answer: pending && pending.length ? null : 'inferred', pending: pending || [] })
  }

  campaign.attachments = campaign.attachments.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, ATTACHMENT_LIMIT)
}

const touchCampaign = (campaign, branch, opened, { path, now, relation }) => {
  const last = campaign.names[campaign.names.length - 1]

  if (!last || last.name !== opened.gameName) {
    campaign.names.push({ name: opened.gameName, t: opened.t, seen: now })
  }

  if (!campaign.gameIds.includes(opened.GameID)) {
    campaign.gameIds.push(opened.GameID)
  }

  campaign.anchor = mergeAnchors(campaign.anchor, opened.anchor)
  campaign.seen = now
  branch.seen = now

  if ((relation === 'continues' && opened.count > branch.tip.n) || (relation === 'attached' && opened.count >= branch.tip.n)) {
    branch.tip = tipOf(opened)
  }

  upsertAttachment(campaign, { path, opened, branchId: branch.id, now })
}

const newCampaign = ({ id, opened, path, now, provenance, pending }) => {
  const campaign = {
    id,
    provenance,
    createdAt: now,
    seen: now,
    names: [{ name: opened.gameName, t: opened.t, seen: now }],
    gameIds: [opened.GameID],
    anchor: opened.anchor,
    branchSeq: 1,
    branches: { [FIRST_BRANCH]: { id: FIRST_BRANCH, parent: null, fork: null, createdAt: now, seen: now, tip: tipOf(opened) } },
    attachments: [],
    legacy: null,
  }

  upsertAttachment(campaign, { path, opened, branchId: FIRST_BRANCH, now, pending })

  return campaign
}

// ---- The legacy migration ------------------------------------------------------------------------------------------
// Before this module, history was one file per GameID, `game-<GameID>.json`, and race-owned settings sat under `game.<GameID>.race.<RaceID>.`. Neither says which campaign it came from, so the migration is done a game at a time, when a save that holds the game is opened, and only claims a legacy record for the opened campaign when nothing contradicts it ('single'): the game name is the one the file recorded, no race's recorded series falls where it could only grow (systems known, research done), and no campaign of the registry already shares the GameID. Anything else is 'ambiguous' and the legacy file and settings stay where they are as an unattached pool entry, for the player to attach to a campaign. The legacy file and the legacy settings are never changed: they are the preserved originals, copied whole into the migration record with their hashes, and a unit that did not finish is rolled back from them.

const DISCONTINUITY_KEYS = ['systems', 'research']

// The first place a legacy file's series falls where it could only grow, as text, or null.
const discontinuity = (history) => {
  for (const [RaceID, record] of Object.entries(isObject(history.races) ? history.races : {})) {
    const snapshots = Array.isArray(record.snapshots) ? record.snapshots : []

    for (const key of DISCONTINUITY_KEYS) {
      for (let index = 1; index < snapshots.length; index++) {
        const [before, after] = [snapshots[index - 1][key], snapshots[index][key]]

        if (typeof before === 'number' && typeof after === 'number' && after < before) {
          return `${key} falls from ${before} to ${after} for race ${RaceID} at game time ${snapshots[index].t}`
        }
      }
    }
  }

  return null
}

const racesIn = (history) => Object.keys(isObject(history.races) ? history.races : {}).length

// The settings the app stored under the legacy key of a game, as they are in the store: `game` and each game's `race` hold their ids as keys, and a settings file written by the library of released versions holds those two maps as lists (the id is the position, a slot that holds nothing is null), older ones as objects. Undefined when the game has none.
export const legacyGameSettings = (store, GameID) => {
  const found = Array.isArray(store.game) || isObject(store.game) ? store.game[GameID] : undefined

  return found === null ? undefined : found
}

// Puts `value` as the legacy settings of a game back into `settings`, in the shape `game` has there (a list stays a list).
const putLegacyGameSettings = (settings, GameID, value) => {
  if (Array.isArray(settings.game)) {
    settings.game[GameID] = value
  } else {
    settings.game = { ...(isObject(settings.game) ? settings.game : {}), [GameID]: value }
  }
}

// The campaign's copy of a game's legacy settings: its `race` map is an object keyed by RaceID (the shape the pages and the preference import read), whichever shape was stored. Only that map is changed; values such as pins and groups stay as they are, and the stored original is never touched.
export const campaignSettingsOf = (legacy) => {
  const copy = clone(legacy)

  if (isObject(copy) && Array.isArray(copy.race)) {
    copy.race = Object.fromEntries(copy.race.map((values, RaceID) => [RaceID, values]).filter(([, values]) => values !== null && values !== undefined))
  }

  return copy
}

// What the app has stored under the legacy keys of a game: { history, settings }, each null when it holds nothing.
export const legacyOf = (io, GameID) => {
  const history = clone(io.file(legacyFileName(GameID)).store)
  const settings = clone(legacyGameSettings(io.settings.store, GameID))

  return { history: isObject(history) && (racesIn(history) || history.gameName) ? history : null, settings: isObject(settings) && Object.keys(settings).length ? settings : null }
}

// The verdict for a legacy record of a game, before anything is written: { verdict: 'single' | 'ambiguous', reason }.
export const legacyVerdict = (legacy, opened, registry) => {
  if (campaignsOfGame(registry, opened.GameID).length) {
    return { verdict: 'ambiguous', reason: 'another campaign of this app already has this game id' }
  }

  if (legacy.history && legacy.history.gameName !== undefined && legacy.history.gameName !== opened.gameName) {
    return { verdict: 'ambiguous', reason: `the file recorded the game "${legacy.history.gameName}", the open save's is "${opened.gameName}"` }
  }

  const fall = legacy.history ? discontinuity(legacy.history) : null

  return fall ? { verdict: 'ambiguous', reason: `the recorded series may mix campaigns: ${fall}` } : { verdict: 'single', reason: 'one campaign holds this game id and nothing in the record contradicts it' }
}

const readUnits = (io) => {
  const stored = io.migration.store

  if (isObject(stored) && !Object.keys(stored).length) {
    return {}
  }

  if (!isObject(stored) || !isObject(stored.units)) {
    throw new Error('The migration record is damaged, so nothing was recorded and it was left as it is')
  }

  return clone(stored.units)
}

const writeUnits = (io, units) => {
  io.migration.store = { version: REGISTRY_VERSION, units }
}

// Writes a registry read by `readRegistry`, refusing (RegistryChanged, nothing written) when the stored registry is no longer the one it was read from.
export const writeRegistry = (io, registry) => {
  const read = stamps.get(registry)

  if (read !== undefined && JSON.stringify(io.registry.store) !== read) {
    throw new RegistryChanged()
  }

  io.registry.store = registry
}

// Changes the settings in place and writes them, as one step over what is stored when it is written: a page of another window may have written a setting since they were read.
const writeSettings = (io, change) => {
  io.settings.update((settings) => {
    change(settings)

    return settings
  })
}

const spanOf = (history) => {
  const times = Object.values(isObject(history.races) ? history.races : {}).flatMap((record) => (Array.isArray(record.snapshots) ? record.snapshots.map((snapshot) => snapshot.t) : [])).filter((time) => typeof time === 'number')

  return { first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null, snapshots: Object.values(isObject(history.races) ? history.races : {}).reduce((total, record) => total + (Array.isArray(record.snapshots) ? record.snapshots.length : 0), 0), races: racesIn(history) }
}

// Rolls back a unit of the legacy migration: the preserved originals are checked against their hashes first (a damaged copy stops it with nothing changed), then everything the unit created is removed (its history files, its settings subtree, its registry entry) and the legacy history and settings are put back if they no longer match their originals. `keep` leaves the unit recorded as 'rolled-back', so a requested rollback is not run again by itself; an interrupted unit (`keep` false) is dropped, so the next pass runs it again from the same originals and reaches the same verdict. Safe to run again after being interrupted.
export const rollbackUnit = (io, GameID, { keep = false, guard = () => {} } = {}) => {
  const units = readUnits(io)
  const unit = units[GameID]

  if (!unit) {
    return false
  }

  const { originals, created } = unit

  if (hashValue(originals.history) !== originals.historyHash || hashValue(originals.settings) !== originals.settingsHash) {
    throw new Error(`The preserved original of game ${GameID} does not match its hash, so the rollback changed nothing`)
  }

  guard()
  created.files.forEach((name) => {
    io.file(name).store = {}
  })

  guard()

  if (created.campaignId) {
    writeSettings(io, (settings) => {
      if (isObject(settings.campaign)) {
        delete settings.campaign[created.campaignId]

        if (!Object.keys(settings.campaign).length) {
          delete settings.campaign
        }
      }
    })
  }

  guard()

  const registry = readRegistry(io)

  delete registry.campaigns[created.campaignId]
  delete registry.pool[created.poolId]
  writeRegistry(io, registry)

  guard()

  if (originals.history !== null && hashValue(io.file(legacyFileName(GameID)).store) !== originals.historyHash) {
    io.file(legacyFileName(GameID)).store = clone(originals.history)
  }

  if (originals.settings !== null && hashValue(legacyGameSettings(io.settings.store, GameID)) !== originals.settingsHash) {
    writeSettings(io, (settings) => {
      putLegacyGameSettings(settings, GameID, clone(originals.settings))
    })
  }

  guard()

  if (keep) {
    units[GameID] = { ...unit, state: 'rolled-back', rolledBackAt: Date.now() }
  } else {
    delete units[GameID]
  }

  writeUnits(io, units)

  return true
}

// Rolls back every unit that was started and not finished (a pass superseded or a write failed part way), so no campaign is left half built. Run at the start of a pass, before anything reads the registry.
export const recoverMigrations = (io, { guard = () => {} } = {}) => Object.entries(readUnits(io)).filter(([, unit]) => unit.state === 'staged').map(([GameID]) => Number(GameID)).filter((GameID) => rollbackUnit(io, GameID, { guard }))

// The campaign whose settings hold what the legacy game `GameID` had under `game.<GameID>` (its migration made a campaign of them, or the player attached them to one; a campaign merged into another counts as that one), or null when none does yet: nothing reads those legacy settings any more, so a record that names them can only be moved to this campaign. Throws when the registry or the migration record is damaged.
export const legacyCampaignOf = (io, GameID) => {
  const registry = readRegistry(io)
  const unit = readUnits(io)[GameID]
  const pooled = Object.values(registry.pool).find((entry) => entry.GameID === GameID && entry.attachedTo)
  let id = unit && unit.state === 'committed' && unit.created.campaignId ? unit.created.campaignId : pooled ? pooled.attachedTo.campaignId : null

  while (id && registry.campaigns[id] && registry.campaigns[id].mergedInto) {
    id = registry.campaigns[id].mergedInto.campaignId
  }

  return id && registry.campaigns[id] ? id : null
}

// Migrates the legacy record of the opened game, if it has one that was not handled before; returns what it did, or null. A 'single' verdict makes a campaign of the legacy record with a first branch of its history and a copy of its settings; an 'ambiguous' one only registers the record in the pool, in place, for the player to attach. Every write is preceded by `guard()`, which throws Superseded once the pass has been replaced, and the unit is marked committed last: whatever stops it before that leaves a staged unit for `recoverMigrations`.
const migrateLegacy = (io, { opened, registry, guard, newId, now, path, matched }) => {
  const units = readUnits(io)

  if (units[opened.GameID]) {
    return null
  }

  const legacy = legacyOf(io, opened.GameID)

  if (!legacy.history && !legacy.settings) {
    return null
  }

  const verdict = matched ? { verdict: 'ambiguous', reason: 'the open save already belongs to a campaign this app recorded' } : legacyVerdict(legacy, opened, registry)
  const campaignId = verdict.verdict === 'single' ? newId() : null
  const poolId = verdict.verdict === 'ambiguous' ? `legacy-${opened.GameID}-${now}` : null
  const unit = {
    GameID: opened.GameID,
    state: 'staged',
    verdict: verdict.verdict,
    reason: verdict.reason,
    startedAt: now,
    committedAt: null,
    originals: { history: legacy.history, historyHash: hashValue(legacy.history), settings: legacy.settings, settingsHash: hashValue(legacy.settings) },
    created: { files: campaignId ? [branchFileName(campaignId, FIRST_BRANCH)] : [], campaignId, poolId },
  }

  guard()
  units[opened.GameID] = unit
  writeUnits(io, units)

  if (campaignId) {
    guard()
    io.file(branchFileName(campaignId, FIRST_BRANCH)).store = clone(legacy.history || {})

    if (legacy.settings) {
      guard()
      writeSettings(io, (settings) => {
        settings.campaign = { ...(isObject(settings.campaign) ? settings.campaign : {}), [campaignId]: campaignSettingsOf(legacy.settings) }
      })
    }

    guard()

    const next = readRegistry(io)
    const campaign = newCampaign({ id: campaignId, opened, path, now, provenance: 'legacy-assumed', pending: [] })

    campaign.legacy = { from: `game ${opened.GameID}`, verdict: verdict.verdict, reason: verdict.reason, migratedAt: now, conflict: false }
    next.campaigns[campaignId] = campaign
    writeRegistry(io, next)
  } else {
    guard()

    const next = readRegistry(io)

    next.pool[poolId] = { id: poolId, GameID: opened.GameID, gameName: legacy.history ? legacy.history.gameName || null : null, verdict: verdict.verdict, reason: verdict.reason, file: legacy.history ? legacyFileName(opened.GameID) : null, settings: !!legacy.settings, span: legacy.history ? spanOf(legacy.history) : null, createdAt: now, attachedTo: null }
    writeRegistry(io, next)
  }

  guard()
  units[opened.GameID] = { ...unit, state: 'committed', committedAt: now }
  writeUnits(io, units)

  return { verdict: verdict.verdict, reason: verdict.reason, campaignId, poolId }
}

// ---- A series' thinning record -------------------------------------------------------------------------------------

// A series' thinning record, `thinning`, says what is known of how its snapshots were thinned (utilities/history.js): { complete, passes, dropped, last, witness }. `complete` is true only when the series was started by the recorder and nothing but the recorder has written it since, or when every series it was made from was complete and never thinned, so `passes` (how many times the older half was thinned) and `dropped` (how many snapshots that removed) are the whole story. `last` is the latest thinning, { at (wall-clock ms, or null for a thinning a merge made, which is dated by game time only), t (game time of the latest snapshot then), passes, dropped, cap }, or null. `witness` is a digest of the game times the series held when the record was written: a series written by something else since no longer matches it, and the counts then stand only as a lower bound.
const THINNING_KEYS = ['complete', 'passes', 'dropped', 'last', 'witness']
const LAST_KEYS = ['at', 'cap', 'dropped', 'passes', 't']
const isCount = (value) => Number.isInteger(value) && value >= 0
const isWallClock = (value) => value === null || (typeof value === 'number' && Number.isFinite(new Date(value).getTime()))
const hasOnly = (value, keys) => Object.keys(value).every((key) => keys.includes(key))

// A series' thinning record as the file holds it, normalised, or null when it is absent or is not a valid record (a file from before it, a hand edit, a time no calendar date can hold): nothing is then known, which is not the same as nothing thinned.
export const readThinning = (raw) => {
  if (!isObject(raw) || !hasOnly(raw, THINNING_KEYS) || typeof raw.complete !== 'boolean' || !isCount(raw.passes) || !isCount(raw.dropped) || typeof raw.witness !== 'string' || !raw.witness) {
    return null
  }

  if (raw.dropped < raw.passes || (raw.passes === 0) !== (raw.last === null)) {
    return null
  }

  if (raw.last === null) {
    return { complete: raw.complete, passes: 0, dropped: 0, last: null, witness: raw.witness }
  }

  const { last } = raw

  if (!isObject(last) || !hasOnly(last, LAST_KEYS) || !isWallClock(last.at) || !Number.isFinite(last.t) || !isCount(last.passes) || last.passes < 1 || !isCount(last.dropped) || last.dropped < last.passes || !Number.isInteger(last.cap) || last.cap < 1 || last.passes > raw.passes || last.dropped > raw.dropped) {
    return null
  }

  return { complete: raw.complete, passes: raw.passes, dropped: raw.dropped, last: { at: last.at, t: last.t, passes: last.passes, dropped: last.dropped, cap: last.cap }, witness: raw.witness }
}

// The digest of the game times a series holds, which a thinning record carries as its witness.
export const witnessOf = (snapshots) => hashValue((snapshots || []).map((snapshot) => snapshot.t))

// The thinning record of a series after a fork cut its snapshots to `kept` (those at or before game time `t`), or undefined when nothing stays established. The record is believed only if it is intact (complete, and the series still holds the game times it was written for) and every thinning in it happened while the series' latest snapshot was no later than `t`: the snapshots those thinnings dropped were then all at or before `t`, so they belong to the fork's timeline and the counts are the fork's own. A thinning later than the fork, or a record that is not intact, says nothing about what the fork lost, so it is not carried over.
export const thinningUpTo = (record, kept, t) => {
  const thinning = readThinning(record.thinning)

  if (!thinning || !thinning.complete || thinning.witness !== witnessOf(record.snapshots) || (thinning.passes && thinning.last.t > t)) {
    return undefined
  }

  return { ...thinning, witness: witnessOf(kept) }
}

// A series' record after a clear removed its snapshots before game time `before` (those at or after it stay), or the record itself when it holds none that old, or null when none is left. The thinning record is believed as before: where it was intact (written for exactly the game times the series held) its witness follows the kept times, so the series reads as untouched or thinned as it did and never as partial; where it was not intact it is left as it was and stays as unknown or partial as it was. A clear is not a thinning, so no pass and no dropped snapshot is added.
export const seriesFrom = (record, before) => {
  const snapshots = Array.isArray(record.snapshots) ? record.snapshots : []
  const kept = snapshots.filter((snapshot) => snapshot.t >= before)

  if (kept.length === snapshots.length) {
    return record
  }

  if (!kept.length) {
    return null
  }

  const thinning = readThinning(record.thinning)
  const intact = thinning && thinning.witness === witnessOf(snapshots)

  return { ...record, snapshots: kept, ...(intact ? { thinning: { ...thinning, witness: witnessOf(kept) } } : {}) }
}

// ---- Settling an opened game ---------------------------------------------------------------------------------------

// The seed of a branch forked from `parent` at game time `t`: the parent's records without any snapshot after the fork point, so the branch reads as one timeline. A series' thinning record comes along only where it still holds for the cut (`thinningUpTo`); otherwise the fork's series reads as thinned unknown.
const upTo = (history, t) => {
  if (!isObject(history) || t === null) {
    return {}
  }

  const seeded = (record) => {
    const snapshots = (record.snapshots || []).filter((snapshot) => snapshot.t <= t)
    const fields = { ...record, snapshots }
    const thinning = thinningUpTo(record, snapshots, t)

    delete fields.thinning

    return thinning ? { ...fields, thinning } : fields
  }

  const cut = (records) => Object.fromEntries(Object.entries(isObject(records) ? records : {}).map(([id, record]) => [id, seeded(record)]).filter(([, record]) => record.snapshots.length))

  return { gameName: history.gameName, races: cut(history.races), intel: Object.fromEntries(Object.entries(isObject(history.intel) ? history.intel : {}).map(([view, aliens]) => [view, cut(aliens)]).filter(([, aliens]) => Object.keys(aliens).length)) }
}

// Decides which campaign and branch the opened game belongs to and records it: the registry's entry is created or updated, a forked branch is seeded, and a legacy record is migrated when one was never handled. Returns { campaignId, branchId, relation, created, forked, pending, legacy } where `relation` is the evidence that matched ('same', 'continues', 'rewound', 'attached', 'fork', or 'new'), `pending` the candidates a new campaign may really belong to (the player is asked) and `legacy` what the migration did, or null. `guard()` is called before every write and throws Superseded; there is no await in here, so the registry is read and written without another pass in between.
export const settle = (io, { opened, path = null, now = Date.now(), newId, guard = () => {} }) => {
  recoverMigrations(io, { guard })

  const first = readRegistry(io)
  const found = decide(first, opened, path)
  const legacy = migrateLegacy(io, { opened, registry: first, guard, newId, now, path, matched: found.kind !== 'new' })
  // The write below is checked against the read the decision was made on, unless the migration wrote in between.
  const registry = legacy ? readRegistry(io) : first

  if (found.kind === 'match') {
    const campaign = registry.campaigns[found.campaign.id]
    const branch = campaign.branches[found.branch.id]

    touchCampaign(campaign, branch, opened, { path, now, relation: found.relation })
    guard()
    writeRegistry(io, registry)

    return { campaignId: campaign.id, branchId: branch.id, relation: found.relation, created: false, forked: false, pending: [], legacy }
  }

  if (found.kind === 'fork') {
    const campaign = registry.campaigns[found.campaign.id]
    const parent = campaign.branches[found.parent.id]
    const branchId = `b${++campaign.branchSeq}`
    const forkTime = found.common ? opened.times[found.common / STEP - 1] : null

    campaign.branches[branchId] = { id: branchId, parent: parent.id, fork: { n: found.common, digest: found.common ? parent.tip.checkpoints[found.common / STEP - 1] : '', t: forkTime }, createdAt: now, seen: now, tip: tipOf(opened) }
    touchCampaign(campaign, campaign.branches[branchId], opened, { path, now, relation: 'fork' })
    guard()
    io.file(branchFileName(campaign.id, branchId)).store = upTo(io.file(branchFileName(campaign.id, parent.id)).store, forkTime)
    guard()
    writeRegistry(io, registry)

    return { campaignId: campaign.id, branchId, relation: 'fork', created: false, forked: true, pending: [], legacy }
  }

  if (legacy && legacy.campaignId) {
    const campaign = registry.campaigns[legacy.campaignId]

    return { campaignId: campaign.id, branchId: FIRST_BRANCH, relation: 'new', created: true, forked: false, pending: [], legacy }
  }

  const campaignId = newId()
  const campaign = newCampaign({ id: campaignId, opened, path, now, provenance: 'observed', pending: found.pending })

  registry.campaigns[campaignId] = campaign

  Object.values(registry.campaigns).filter((other) => other.id !== campaignId && !other.mergedInto && other.provenance === 'legacy-assumed' && other.gameIds.includes(opened.GameID) && other.legacy).forEach((other) => {
    other.legacy.conflict = true
  })

  guard()
  writeRegistry(io, registry)

  return { campaignId, branchId: FIRST_BRANCH, relation: 'new', created: true, forked: false, pending: found.pending, legacy }
}
