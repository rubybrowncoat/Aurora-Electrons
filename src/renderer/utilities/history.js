// Empire History: the app's own record of each race, one snapshot per game save it sees. Aurora keeps no history beyond a year of wealth and a few weeks of the mineral ledger, so this is the only way to chart growth. The records belong to a campaign, not to a GameID or a path (utilities/campaign.js), and each branch of a campaign has its own electron-store file in `history/` beside the settings, never the save. See docs/plans/aurcalcs/build-3.md § Empire History.

import Config from 'electron-store'

import { toBoolean, toNumber } from './aurora'
import { GAMES_SQL, MIGRATION_NAME, Superseded, branchFileName, marksOf, observeGame, readRegistry, readThinning, seriesFrom, settle, witnessOf, writeRegistry } from './campaign'
import { COLONY_COLUMNS, colonyBase, colonyChosen, colonyFileName, colonyForkFile, colonyRows, colonySnapshot, colonyWish, entriesAt, idsToRead, joinColonies, readColonies } from './colony-series'
import { archiveChosen, archiveKept, archiveWanted, archiveWish, eventBase, eventCapOfSettings, eventFileName, eventFileProblem, eventForkFile, eventsFrom, mergeEvents, readLogWindow, readRaceEvents, withFailure } from './event-archive'
import { mergeObservations, observationBase, observationChosen, observationEverChosenIn, observationFileName, observationFileProblem, observationForkFile, observationKept, observationWanted, observationWish, observationsFrom, readObservations } from './observations'
import { SERVING_COMMANDER } from './commanders'
import { intelChanged, takeIntel } from './intelligence'
import { UNKNOWN_TEXT, isKnownNumber, roundToDecimal } from './math'
import { combine, failureWords, ofRule, registerRule, sumResults, unavailable } from './provenance'
import { ReadOnly, recordingOwner, requireRecording, withRegistry } from './recording-owner'

const HISTORY_VERSIONS = ['2.7.x']

registerRule({
  id: 'history.population',
  versions: HISTORY_VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_Population.Population'],
  note: 'The sum of the race\'s colony populations when the snapshot was taken, as stored. A colony whose population is not stored leaves the sum unknown.',
})

registerRule({
  id: 'history.colonies',
  versions: HISTORY_VERSIONS,
  units: 'colonies',
  verification: 'confirmed',
  structure: ['FCT_Population.Population'],
  note: 'The number of the race\'s colonies with a population above 0 when the snapshot was taken. A colony whose population is not stored leaves the count unknown.',
})

registerRule({
  id: 'history.treasury',
  versions: HISTORY_VERSIONS,
  units: 'wealth',
  verification: 'confirmed',
  structure: ['FCT_Race.WealthPoints'],
  note: 'The race\'s stored treasury when the snapshot was taken. A save with no stored treasury gives no figure.',
})

registerRule({
  id: 'history.income',
  versions: HISTORY_VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['FCT_Race.AnnualWealth'],
  note: 'The race\'s stored annual wealth when the snapshot was taken. What the column counts (income or net) is inferred from the saves and not checked against the wealth ledger.',
})

registerRule({
  id: 'history.stockpile',
  versions: HISTORY_VERSIONS,
  units: 't, L, MSP',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelStockpile, MaintenanceStockpile, Duranium to Gallicite'],
  note: 'The sum of the colonies\' stockpile of one fuel, maintenance supply or mineral when the snapshot was taken, as stored. Ships\' own stocks are not in it. A colony with no stored amount leaves the sum unknown.',
})

registerRule({
  id: 'history.ships',
  versions: HISTORY_VERSIONS,
  units: 'ships',
  verification: 'confirmed',
  structure: ['FCT_Ship, FCT_ShipClass.Commercial'],
  note: 'The race\'s ships of non-shipping-line fleets, military or commercial by their class, when the snapshot was taken. No ship of a kind is a known 0.',
})

registerRule({
  id: 'history.fleetTonnage',
  versions: HISTORY_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size', 'FCT_Ship'],
  note: 'The class size of each ship times 50 t per hull space, added up. The 50 t per hull space is the app\'s own constant and is not checked against a stored tonnage. A class with no stored size leaves the sum unknown.',
})

registerRule({
  id: 'history.installations',
  versions: HISTORY_VERSIONS,
  units: 'installations',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount'],
  note: 'The installations of one type over the race\'s colonies, added up as stored. A type with no row is none built; a row with no stored amount leaves the type unknown.',
})

registerRule({
  id: 'history.research',
  versions: HISTORY_VERSIONS,
  units: 'RP',
  verification: 'confirmed',
  structure: ['FCT_RaceTech.TechID', 'FCT_TechSystem.DevelopCost'],
  note: 'The development cost of every technology the race has researched, added up as stored. A technology with no stored cost leaves the sum unknown.',
})

registerRule({
  id: 'history.systems',
  versions: HISTORY_VERSIONS,
  units: 'systems',
  verification: 'confirmed',
  structure: ['FCT_RaceSysSurvey'],
  note: 'The number of systems the race knows when the snapshot was taken.',
})

registerRule({
  id: 'history.commanders',
  versions: HISTORY_VERSIONS,
  units: 'commanders',
  verification: 'confirmed',
  structure: ['FCT_Commander'],
  note: 'The number of serving commanders of the race when the snapshot was taken.',
})

registerRule({
  id: 'history.change',
  versions: HISTORY_VERSIONS,
  units: 'as the figure',
  verification: 'confirmed',
  structure: ['two snapshots of the app\'s history file'],
  note: 'The difference between the latest snapshot in the window and the first. Arithmetic on two recorded figures; it is unknown when either is.',
})

registerRule({
  id: 'history.recordedSpan',
  versions: HISTORY_VERSIONS,
  units: 'years',
  verification: 'confirmed',
  structure: ['snapshot game times'],
  note: 'The span between the first and the latest snapshot and how much of the chosen window it fills. Time before the first snapshot was never observed and is not inferred.',
})

registerRule({
  id: 'history.timeAxis',
  versions: HISTORY_VERSIONS,
  units: 'game year',
  verification: 'confirmed',
  structure: ['FCT_Game.StartYear', 'snapshot game times'],
  note: 'A snapshot\'s year is the game\'s start year plus its game time over 31,536,000 s. Without a start year no calendar year can be given and the axis counts game years elapsed.',
})

// The rule each snapshot field is figured by, and the name a result gives for it when the field is missing.
export const SNAPSHOT_FIELDS = Object.freeze({
  population: { rule: 'history.population', label: 'population' },
  colonies: { rule: 'history.colonies', label: 'colony count' },
  wealth: { rule: 'history.treasury', label: 'treasury' },
  income: { rule: 'history.income', label: 'annual income' },
  fuel: { rule: 'history.stockpile', label: 'fuel stockpile' },
  msp: { rule: 'history.stockpile', label: 'maintenance supply stockpile' },
  militaryShips: { rule: 'history.ships', label: 'military ship count' },
  commercialShips: { rule: 'history.ships', label: 'commercial ship count' },
  militaryTons: { rule: 'history.fleetTonnage', label: 'military tonnage' },
  commercialTons: { rule: 'history.fleetTonnage', label: 'commercial tonnage' },
  research: { rule: 'history.research', label: 'research total' },
  systems: { rule: 'history.systems', label: 'known system count' },
  commanders: { rule: 'history.commanders', label: 'commander count' },
})

const figure = (rule, label, value, units) => (isKnownNumber(value) ? ofRule({ rule, value: Number(value), inputs: { present: [label] }, units }) : unavailable({ rule, missing: [label], units }))

// One field of a snapshot as a result of its rule: unavailable, naming the field, when the snapshot lacks it (a record from before the field was kept, or a figure the save could not give), never 0.
export const snapshotResult = (snapshot, key) => {
  const { rule, label } = SNAPSHOT_FIELDS[key]

  return figure(rule, label, snapshot ? snapshot[key] : null)
}

// One mineral's stockpile (`id` 1 to 11) in a snapshot; `name` is the mineral's name.
export const mineralResult = (snapshot, id, name) => figure('history.stockpile', `${name} stockpile`, snapshot && Array.isArray(snapshot.minerals) ? snapshot.minerals[id - 1] : null)

// One installation type's amount in a snapshot: none built when the snapshot lists installations without it, unknown when the snapshot lists none at all or a null amount for it.
export const installationResult = (snapshot, id, name) => {
  const label = `${name} installations`

  if (!snapshot || !snapshot.installations || typeof snapshot.installations !== 'object') {
    return unavailable({ rule: 'history.installations', missing: [label] })
  }

  return Object.prototype.hasOwnProperty.call(snapshot.installations, id) ? figure('history.installations', label, snapshot.installations[id]) : ofRule({ rule: 'history.installations', value: 0, inputs: { present: [label] } })
}

// The change of a figure between two results of one rule (later minus earlier); unavailable when either is.
export const changeResult = (earlier, later) => combine({ rule: 'history.change', parts: { earlier, later }, compute: ({ earlier: from, later: to }) => to - from, units: later.units })

// The sum of results of one rule (the military and commercial tonnage): unavailable when any is.
export const totalResult = (rule, results) => sumResults({ rule, results })

// The default and largest cap on snapshots per series (the Standard retention profile): more than this and the older half is thinned to every other one, so a long campaign keeps its whole span at a coarser grain (about 1 MB per race at the cap). A smaller cap is a chosen profile (`RETENTION_PROFILES`).
export const MAX_SNAPSHOTS = 2000

const HISTORY_FOLDER = 'history'
const MIGRATION_FOLDER = 'migrations'
const BACKUP_FOLDER = 'backups'
const BACKUP_NAME = 'history-before-restore'
const openStores = {}

// A store on one of the app's own files (the registry, a history file, the migration record): reads as electron-store's, and every write is refused unless this tab is the recording owner (utilities/recording-owner.js), so no page or utility can write what the owner alone may.
const openStore = (cwd, name) => {
  const key = `${cwd}/${name}`

  if (!openStores[key]) {
    const config = new Config({ cwd, name })

    openStores[key] = {
      get path () {
        return config.path
      },
      get store () {
        return config.store
      },
      set store (value) {
        requireRecording()
        config.store = value
      },
      get: (path, fallback) => config.get(path, fallback),
      set: (path, value) => {
        requireRecording()
        config.set(path, value)
      },
      delete: (path) => {
        requireRecording()
        config.delete(path)
      },
    }
  }

  return openStores[key]
}

// The files of Empire History, all beside the settings and never the save. `campaigns` in the history folder is the registry (utilities/campaign.js): each campaign the app has recorded with its branches, attached saves and the unattached legacy history. Each branch of a campaign has its own file, `campaign-<campaignId>-<branchId>.json`, holding:
// { gameName, races: { [RaceID]: { raceName, npr, snapshots: [...], thinning? } },
//   intel: { [ViewRaceID]: { [AlienRaceID]: { name, snapshots: [...], thinning? } } } }
// A history file written before campaigns, `game-<GameID>.json`, is kept as it was (the preserved original of the migration, see campaign.js) and read only by that migration. `migrations/campaigns-v1.json` holds the migration's record and copies of those originals.
export const registryStore = () => openStore(HISTORY_FOLDER, 'campaigns')

// The history of one branch of a campaign, a store with `.store`, `.get(path, default)` and `.path`.
export const branchStore = (campaignId, branchId) => openStore(HISTORY_FOLDER, branchFileName(campaignId, branchId))

// The colony series of one branch (utilities/colony-series.js), beside its branch file: a store with `.store`, `.get(path, default)` and `.path`, empty until a colony is chosen and captured.
export const colonyStore = (campaignId, branchId) => openStore(HISTORY_FOLDER, colonyFileName(campaignId, branchId))

// The event archive of one branch (utilities/event-archive.js), beside its branch file: a store with `.store`, `.get(path, default)` and `.path`, empty until a race with the archive on is captured.
export const eventStore = (campaignId, branchId) => openStore(HISTORY_FOLDER, eventFileName(campaignId, branchId))

// The observation record of one branch (utilities/observations.js), beside its branch file: a store with `.store`, `.get(path, default)` and `.path`, empty until a race that observes is captured.
export const observationStore = (campaignId, branchId) => openStore(HISTORY_FOLDER, observationFileName(campaignId, branchId))

// The branch a page of one campaign shows and an answer attaches to: the one the player picked when the campaign has it, else the branch the open save settled to (which stays where the recorder put it).
export const shownBranch = (branchIds, picked, settled) => (picked && branchIds.includes(picked) ? picked : settled)

// Removes one race's history from one branch file, and its colony series, its event archive and its observation record in the branch's own files, for the person who confirmed it: the target is read when this is called, before the wait for the registry lock (another window may hold it for a while), never from what the page shows when the lock is granted. Other races keep theirs, and no other branch or file is touched. With `before` (a game time, in seconds) only what was recorded before it goes: the race's snapshots and colony samples older than it (one exactly at it stays), the events and observations older than it, each record cut by its own bookkeeping (`seriesFrom`, `eventsFrom`, `observationsFrom`), so a series reads as untouched or thinned as before and a later save does not bring back what was cleared. A record the race does not keep is left as it is. Returns whether anything was removed.
export const clearRaceHistory = ({ campaignId, branchId, RaceID, before = null }) => withRegistry(() => {
  if (before !== null && !Number.isFinite(before)) {
    throw new Error('The time to clear before is not a number.')
  }

  // The store's file with the race cut, or null when nothing in it changes. Nothing is written here: a read that throws or a cut that fails must leave every file as it was.
  const planned = (store, cutRecord) => {
    const stored = store.store
    const record = stored.races && stored.races[RaceID]

    if (!record) {
      return null
    }

    const rest = before === null ? null : cutRecord(record, before)

    if (rest === record) {
      return null
    }

    if (rest) {
      stored.races[RaceID] = rest
    } else {
      delete stored.races[RaceID]
    }

    return { store, stored }
  }

  // Every store is read and cut before the first is written, and none is skipped once another changed.
  const changes = [
    planned(branchStore(campaignId, branchId), seriesFrom),
    planned(colonyStore(campaignId, branchId), seriesFrom),
    planned(eventStore(campaignId, branchId), eventsFrom),
    planned(observationStore(campaignId, branchId), observationsFrom),
  ].filter(Boolean)

  changes.forEach(({ store, stored }) => {
    store.store = stored
  })

  return changes.length > 0
})

let appSettings = null

// The stores the campaign rules work on, `settings` being the app's settings store (the store's `config` getter in the app); without one, a store on the settings file is opened. `backup` keeps the backups taken before a history restore (utilities/history-backup.js).
export const campaignStorage = (settings = null) => {
  if (!settings && !appSettings) {
    appSettings = new Config({})
  }

  return {
    registry: registryStore(),
    migration: openStore(MIGRATION_FOLDER, MIGRATION_NAME),
    settings: settings || appSettings,
    file: (name) => openStore(HISTORY_FOLDER, name),
    backup: openStore(BACKUP_FOLDER, BACKUP_NAME),
  }
}

// Player races and NPR empires are recorded. Aurora's special factions (Precursors, Invaders, Rakhas, Eldar, Ancients and the like, `SpecialNPRID` > 0) have no empire to chart.
export const recordsHistory = ({ NPR, SpecialNPRID }) => !toBoolean(NPR) || !(toNumber(SpecialNPRID) > 0)

// Drop every other snapshot in the older half until the list fits, and say how many passes that took and how many snapshots went: { snapshots, passes, dropped, cap }. The first and the latest snapshot stay, as does the order. A pass that cannot shrink the list (a cap below 3) keeps the newest `cap` snapshots instead, so the loop always ends.
export const thinCounted = (snapshots, limit = MAX_SNAPSHOTS) => {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : MAX_SNAPSHOTS
  let result = snapshots
  let passes = 0

  while (result.length > cap) {
    const half = Math.floor(result.length / 2)
    const next = [...result.slice(0, half).filter((_, index) => index % 2 === 0), ...result.slice(half)]

    passes++
    result = next.length < result.length ? next : result.slice(result.length - cap)
  }

  return { snapshots: result, passes, dropped: snapshots.length - result.length, cap }
}

export const thinSnapshots = (snapshots, limit = MAX_SNAPSHOTS) => thinCounted(snapshots, limit).snapshots

// The bounded retention profiles: how many snapshots one series (a race, or one alien race a race knows) keeps before its older half is thinned. Every cap is within `MAX_SNAPSHOTS`, the most a history backup accepts for a series, so no profile makes a history that cannot be backed up.
export const RETENTION_PROFILES = [
  { id: 'compact', label: 'Compact', cap: 500 },
  { id: 'balanced', label: 'Balanced', cap: 1000 },
  { id: 'standard', label: 'Standard', cap: MAX_SNAPSHOTS },
]

export const DEFAULT_RETENTION = 'standard'

// The profile of an id; the default when the id is not one of the profiles (a setting from another version, a hand-edited file).
export const retentionProfile = (id) => RETENTION_PROFILES.find((profile) => profile.id === id) || RETENTION_PROFILES.find((profile) => profile.id === DEFAULT_RETENTION)

// The profile the app's settings hold (`historyRetention`); the default when there are none.
export const retentionOfSettings = (settings) => retentionProfile(settings && settings.store ? settings.store.historyRetention : undefined)

// What a series record says of its thinning: { status, passes, dropped, last }. `status` is 'untouched' (started by the recorder, never thinned), 'thinned' (started by the recorder, thinned `passes` times), 'partial' (thinned at least `passes` times; something else wrote the series, or it began before the record, so more may have happened) or 'unknown' (nothing is known: `passes`, `dropped` and `last` are null, never 0).
export const thinningStatus = (record) => {
  const thinning = record ? readThinning(record.thinning) : null

  if (!thinning) {
    return { status: 'unknown', passes: null, dropped: null, last: null }
  }

  if (thinning.complete && thinning.witness === witnessOf(record.snapshots)) {
    return { status: thinning.passes ? 'thinned' : 'untouched', passes: thinning.passes, dropped: thinning.dropped, last: thinning.last }
  }

  return thinning.passes ? { status: 'partial', passes: thinning.passes, dropped: thinning.dropped, last: thinning.last } : { status: 'unknown', passes: null, dropped: null, last: null }
}

// The `thinning` entry a series record carries after the recorder wrote `outcome` (what `thinCounted` gave for it) over `previous`, the record before, or undefined when nothing is worth writing: a series that began before the record, whose thinning is still unknown, stays as it was.
const retained = (previous, outcome, now) => {
  const prior = previous ? readThinning(previous.thinning) : null
  const intact = prior && prior.witness === witnessOf(previous.snapshots)
  const base = !previous ? { complete: true, passes: 0, dropped: 0, last: null } : { complete: Boolean(intact && prior.complete), passes: prior ? prior.passes : 0, dropped: prior ? prior.dropped : 0, last: prior ? prior.last : null }
  const passes = base.passes + outcome.passes
  const latest = outcome.snapshots[outcome.snapshots.length - 1]

  if (!base.complete && !passes) {
    return undefined
  }

  return {
    complete: base.complete,
    passes,
    dropped: base.dropped + outcome.dropped,
    last: outcome.passes ? { at: now(), t: latest.t, passes: outcome.passes, dropped: outcome.dropped, cap: outcome.cap } : base.last,
    witness: witnessOf(outcome.snapshots),
  }
}

// A record's fields with its thinning entry for the new rows, left out when there is none to write.
const withThinning = (fields, previous, outcome, now) => {
  const thinning = retained(previous, outcome, now)

  return thinning ? { ...fields, thinning } : fields
}

// What one series that goes into a merge says of its own thinning: the rows, the valid record or null, whether the record is intact (it was written for exactly these rows' game times), whether its counts are the whole story (an intact complete record, or a series with no rows at all), and the counts.
const reading = (record) => {
  const rows = record && Array.isArray(record.snapshots) ? record.snapshots : []
  const thinning = record ? readThinning(record.thinning) : null
  const intact = !!thinning && thinning.witness === witnessOf(rows)

  return { rows, thinning, intact, complete: thinning ? thinning.complete && intact : !rows.length, passes: thinning ? thinning.passes : 0, dropped: thinning ? thinning.dropped : 0 }
}

// The `thinning` entry of a series made by merging the series `records` (each a record or undefined for a side that has none), `outcome` being what `thinCounted` gave for the union of their rows, or undefined when nothing is known. A merge is the one place two histories are written as one, so it is where thinning is reconciled, and the game times alone never decide it (two different histories can be thinned to the same times, and a merge cannot bring back what either side lost). The merge's own thinning is dated by game time only (`at` is null), so planning the same merge twice gives the same record:
// - a source whose rows are exactly the result, with nothing thinned by the merge, stands as it was, but only when every other source adds nothing it did not already hold and says nothing against it (it was complete and never thinned, or it carries the very same record and that record is intact, so a record whose rows have changed since never vouches for another): a source with no record, one that was thinned, or one whose record is stale, may have lost samples this one never had, so the result is then never more complete than the least known source;
// - every source complete and never thinned: the result is complete, and the merge's own thinning is all there is;
// - otherwise the counts are a floor (the most any one source or the merge reports, since two histories can describe the same drops) and the result is not complete; with no thinning reported at all nothing is known.
export const thinningOfMerge = (records, outcome) => {
  const sources = records.map(reading)
  const witness = witnessOf(outcome.snapshots)
  const silent = (source) => source.complete && !source.passes
  const standing = outcome.dropped ? undefined : sources.find((source) => source.thinning && witnessOf(source.rows) === witness && sources.every((other) => other === source || silent(other) || (other.intact && JSON.stringify(other.thinning) === JSON.stringify(source.thinning))))

  if (standing) {
    return standing.thinning
  }

  const latest = outcome.snapshots[outcome.snapshots.length - 1]
  const own = outcome.passes ? { at: null, t: latest.t, passes: outcome.passes, dropped: outcome.dropped, cap: outcome.cap } : null

  if (sources.every((source) => source.complete && !source.passes)) {
    return { complete: true, passes: outcome.passes, dropped: outcome.dropped, last: own, witness }
  }

  const passes = Math.max(outcome.passes, ...sources.map((source) => source.passes))

  if (!passes) {
    return undefined
  }

  const lasts = [own, ...sources.map((source) => source.thinning && source.thinning.last)].filter(Boolean)

  return { complete: false, passes, dropped: Math.max(outcome.dropped, ...sources.map((source) => source.dropped)), last: lasts.reduce((newest, candidate) => (candidate.t > newest.t ? candidate : newest)), witness }
}

// What a race's recording covers, from its time-ordered snapshots: { count, first, last, seconds } with the game times of the first and latest snapshot (null when there are none) and the span between them; `covered` is how much of the last `windowSeconds` that span fills, or the whole span when `windowSeconds` is 0, and `inWindow` how many snapshots fall in that window. Nothing is inferred for time before the first snapshot.
export const recordedSpan = (snapshots, windowSeconds = 0) => {
  if (!snapshots.length) {
    return { count: 0, first: null, last: null, seconds: 0, covered: 0, inWindow: 0 }
  }

  const first = snapshots[0].t
  const last = snapshots[snapshots.length - 1].t
  const seconds = last - first
  const since = windowSeconds ? last - windowSeconds : -Infinity

  return { count: snapshots.length, first, last, seconds, covered: windowSeconds ? Math.min(seconds, windowSeconds) : seconds, inWindow: snapshots.filter((snapshot) => snapshot.t >= since).length }
}

const SECONDS_PER_DAY = 86400
const SECONDS_PER_YEAR = 31536000

// The spans in years before the latest snapshot that the page's span toggle and the Clear dialog offer.
export const SPAN_YEARS = [10, 20, 50]

// The words of the Clear dialog that name what it does: the option that removes everything, the option that removes what is older than some years, and the two figures it states.
export const CLEAR_WORDS = { all: 'Everything', older: 'Older than', years: 'years', removed: 'removed', kept: 'kept' }

// What clearing a race's `snapshots` of `years` years does: { before, removed, kept }. 0 years is everything (`before` null, as `clearRaceHistory` takes it). Otherwise `before` is the game time that many years before the race's latest snapshot and a snapshot exactly at it is kept.
export const clearPlan = (snapshots, years) => {
  if (!years) {
    return { before: null, removed: snapshots.length, kept: 0 }
  }

  const before = Math.max(...snapshots.map((snapshot) => snapshot.t)) - years * SECONDS_PER_YEAR
  const removed = snapshots.filter((snapshot) => snapshot.t < before).length

  return { before, removed, kept: snapshots.length - removed }
}

// A span of game time as one figure with its unit (s, min, h, d, y); a dash when it is not known, never 0.
export const durationText = (seconds) => {
  if (!isKnownNumber(seconds)) {
    return UNKNOWN_TEXT
  }

  const value = Number(seconds)

  if (value >= SECONDS_PER_YEAR) {
    return `${roundToDecimal(value / SECONDS_PER_YEAR, 1)} y`
  } else if (value >= SECONDS_PER_DAY) {
    return `${roundToDecimal(value / SECONDS_PER_DAY, 1)} d`
  } else if (value >= 3600) {
    return `${roundToDecimal(value / 3600, 1)} h`
  } else if (value >= 60) {
    return `${roundToDecimal(value / 60, 1)} min`
  }

  return `${roundToDecimal(value, 0)} s`
}

// A size in bytes as B, KiB or MiB; a dash when it is not known, never 0.
export const bytesText = (bytes) => {
  if (!isKnownNumber(bytes)) {
    return UNKNOWN_TEXT
  }

  const value = Number(bytes)

  return value >= 1048576 ? `${roundToDecimal(value / 1048576, 2)} MiB` : value >= 1024 ? `${roundToDecimal(value / 1024, 1)} KiB` : `${value} B`
}

// What a time-ordered list of snapshots holds: { count, first, last, seconds, gaps } with the game times of the first and latest snapshot and the span between them, and `gaps` { count, largest, typical } over the time between neighbours (`typical` the median). Everything that needs two snapshots is null, not 0, when there are fewer.
export const retentionStats = (snapshots) => {
  const times = snapshots.map((snapshot) => snapshot.t).filter((t) => Number.isFinite(t))
  const gaps = times.slice(1).map((t, index) => t - times[index]).sort((a, b) => a - b)
  const middle = Math.floor(gaps.length / 2)

  return {
    count: snapshots.length,
    first: times.length ? times[0] : null,
    last: times.length ? times[times.length - 1] : null,
    seconds: times.length > 1 ? times[times.length - 1] - times[0] : null,
    gaps: {
      count: gaps.length,
      largest: gaps.length ? gaps[gaps.length - 1] : null,
      typical: gaps.length ? (gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2) : null,
    },
  }
}

// The size of a value as the history file stores it, in bytes of compact JSON (the file on disk is indented, so it is larger).
const storedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length

// The measured size of a series record as stored, or null when there is none.
export const measuredBytes = (record) => (record ? storedBytes(record) : null)

// What a retention profile would do to a series record's snapshots as they are now: { cap, thins, kept, dropped, passes, largestGap, bytes, bytesAtCap }. `kept`, `dropped`, `largestGap` and `bytes` are exact for thinning the stored rows now; `bytesAtCap` is a prediction (the average size of a stored snapshot times the cap) of the series' size once it holds as many as the cap. All are null when the series has no snapshots, because nothing is then known to predict from.
export const predictRetention = (record, profile) => {
  const snapshots = record && Array.isArray(record.snapshots) ? record.snapshots : []

  if (!snapshots.length) {
    return { cap: profile.cap, thins: null, kept: null, dropped: null, passes: null, largestGap: null, bytes: null, bytesAtCap: null }
  }

  const thinned = thinCounted(snapshots, profile.cap)

  return {
    cap: profile.cap,
    thins: thinned.dropped > 0,
    kept: thinned.snapshots.length,
    dropped: thinned.dropped,
    passes: thinned.passes,
    largestGap: retentionStats(thinned.snapshots).gaps.largest,
    bytes: storedBytes({ ...record, snapshots: thinned.snapshots }),
    bytesAtCap: Math.round((storedBytes(snapshots) / snapshots.length) * profile.cap),
  }
}

// How many samples a series holds and how far apart they are, in one line: "N samples; gaps up to X (typical Y)". One sample has no gap, which is stated, not shown as 0.
export const samplingText = (stats) => {
  if (!stats.count) {
    return 'No samples'
  }

  if (stats.gaps.largest === null) {
    return `${stats.count} sample${stats.count === 1 ? '' : 's'}; gaps unknown`
  }

  return `${stats.count} samples; gaps up to ${durationText(stats.gaps.largest)} (typical ${durationText(stats.gaps.typical)})`
}

// What the thinning of a series is known to be (`thinningStatus`), in words. `date` writes a game time; the wall-clock time of the latest thinning is a calendar date in UTC.
export const thinningText = ({ status, passes, dropped, last }, date) => {
  if (status === 'unknown') {
    return 'Thinning unknown: this history was recorded or merged without its thinning being noted, so its older half may have been thinned and it is not assumed complete'
  }

  if (status === 'untouched') {
    return 'Never thinned'
  }

  const latest = last ? `; latest thinning at ${date(last.t)} (${last.at === null ? 'made by a merge' : `saved ${new Date(last.at).toISOString().slice(0, 10)}`}, cap ${last.cap})` : ''
  const times = `${passes} time${passes === 1 ? '' : 's'}, dropping ${status === 'partial' ? 'at least ' : ''}${dropped} sample${dropped === 1 ? '' : 's'}`

  return status === 'partial' ? `Older half thinned at least ${times}; the series was also written by something other than the recorder, so more may be unknown${latest}` : `Older half thinned ${times}${latest}`
}

// The sparse-sampling line a chart, table or export of a series advertises: the sampling and the thinning in one sentence.
export const retentionNote = (record, date) => `${samplingText(retentionStats(record && Array.isArray(record.snapshots) ? record.snapshots : []))}. ${thinningText(thinningStatus(record), date)}.`

// The columns the history CSV adds for the sparse sampling: the seconds since the previous row (empty for the first, which has none) and the retention note on the first row.
export const sparseColumns = (snapshots, note) => ({
  header: ['Gap since previous row (s)', 'Retention'],
  rows: snapshots.map((snapshot, index) => [index && Number.isFinite(snapshot.t) && Number.isFinite(snapshots[index - 1].t) ? snapshot.t - snapshots[index - 1].t : null, index ? null : note]),
})

// The snapshots with `snapshot` in time order, thinned to `limit` (see `thinCounted`): it takes the place of one at the same game time, and none at another time is touched, so a save older than what is recorded lands in the past of the record and the later snapshots stay.
const withSnapshot = (snapshots, snapshot, limit) => thinCounted([...snapshots.filter((existing) => existing.t !== snapshot.t), snapshot].sort((a, b) => a.t - b.t), limit)

// How a branch's history file stands against a cap: { series, over, dropped, next: { thins, dropped, replaced } }. `series` counts what it holds (every race and every alien race a race knows), `over` how many hold more snapshots than `cap` and `dropped` how many snapshots thinning the rows stored now would drop. `next` is what the recorder's next save would do, a later snapshot being added before the thinning (that is what the recorder does, so it can thin a series that holds no more than `cap` now, or more passes than thinning the stored rows alone): `thins` how many series it thins and `dropped` how many stored snapshots it discards in all, for an alien series at most, each series taking the way that discards most. An alien series whose new observation matches the snapshot before it gains no snapshot and loses the one stored at that time, which goes before the thinning runs, so the most it discards can be one more than any thinning: `replaced` is the allowance that adds to `dropped` over what thinning alone would give, not a count of the samples that can be removed (a save can remove one from each alien series that holds two or more, and a series whose thinning already discards more than that adds nothing to the allowance). A series is not counted in `thins` for that alone. A colony file has the same `races` shape, so it is measured the same way when it is passed as `history`.
export const seriesOverCap = (history, cap) => {
  const races = Object.values(history && history.races ? history.races : {})
  const aliens = Object.values(history && history.intel ? history.intel : {}).flatMap((views) => Object.values(views))
  const measured = (records, intel) => records.filter((record) => record && Array.isArray(record.snapshots)).map(({ snapshots }) => {
    const stored = thinCounted(snapshots, cap).dropped
    const added = snapshots.length ? withSnapshot(snapshots, { t: snapshots[snapshots.length - 1].t + 1 }, cap).dropped : 0
    const thinned = intel ? Math.max(stored, added) : added
    const removed = intel && snapshots.length ? 1 + thinCounted(snapshots.slice(1), cap).dropped : 0

    return { held: snapshots.length, stored, thinned, next: Math.max(thinned, removed) }
  })
  const series = [...measured(races, false), ...measured(aliens, true)]
  const total = (list, key) => list.reduce((sum, entry) => sum + entry[key], 0)

  return { series: series.length, over: series.filter((entry) => entry.held > cap).length, dropped: total(series, 'stored'), next: { thins: series.filter((entry) => entry.thinned > 0).length, dropped: total(series, 'next'), replaced: total(series, 'next') - total(series, 'thinned') } }
}

// Add one save's snapshots to a branch's history. `history` is the file's contents (or empty); `gameName` is the name the save gave the game, kept as the label of the file, and each snapshot carries the game time it was taken at:
// - `races`: [{ RaceID, raceName, npr, snapshot }];
// - `intel`: { [ViewRaceID]: [{ AlienRaceID, name, snapshot }] }, what each race knows of the others.
// `limit` is how many snapshots a series keeps before its older half is thinned (the chosen retention profile's cap), and `now` gives the wall-clock time a thinning is recorded at; each series record carries what is known of its thinning (`thinning`, see `readThinning`).
// Rules:
// - Which campaign and branch the file belongs to is decided before this (utilities/campaign.js), so a name or an id is never compared here: a different campaign has a different file.
// - Nothing is removed but by thinning. A save at a recorded time replaces that snapshot; a save older than the latest one is inserted in time order, an older save reloaded (a rewind) leaves the later snapshots in place, and a rewound past that is then played differently goes to a branch of its own.
// - A race (or an alien race) missing from this save keeps its past.
// - Intelligence changes slowly, so its snapshot is kept only when something besides the time changed from the snapshot before it.
export const mergeGame = (history, { gameName, races, intel = {} }, { limit = MAX_SNAPSHOTS, now = Date.now } = {}) => {
  const merged = Object.fromEntries(Object.entries(history && history.races ? history.races : {}).map(([RaceID, record]) => [RaceID, { ...record, snapshots: record.snapshots || [] }]))
  const mergedIntel = Object.fromEntries(Object.entries(history && history.intel ? history.intel : {}).map(([ViewRaceID, aliens]) => [ViewRaceID, { ...aliens }]))

  races.forEach(({ RaceID, raceName, npr, snapshot }) => {
    const previous = merged[RaceID]
    const outcome = withSnapshot(previous ? previous.snapshots : [], snapshot, limit)

    merged[RaceID] = withThinning({ raceName, npr, snapshots: outcome.snapshots }, previous, outcome, now)
  })

  Object.entries(intel).forEach(([ViewRaceID, aliens]) => {
    const view = (mergedIntel[ViewRaceID] = mergedIntel[ViewRaceID] || {})

    aliens.forEach(({ AlienRaceID, name, snapshot }) => {
      const previous = view[AlienRaceID]
      const snapshots = previous ? previous.snapshots : []
      const last = snapshots.filter((existing) => existing.t < snapshot.t).pop()
      const outcome = !last || intelChanged(last, snapshot) ? withSnapshot(snapshots, snapshot, limit) : thinCounted(snapshots.filter((existing) => existing.t !== snapshot.t), limit)

      view[AlienRaceID] = withThinning({ name, snapshots: outcome.snapshots }, previous, outcome, now)
    })
  })

  return { gameName, races: merged, intel: mergedIntel }
}

// Add one save's colony snapshots to a branch's colony series (utilities/colony-series.js). `file` is the series' contents (or the seed of a forked branch, or empty); `races` is [{ RaceID, snapshot }] with each snapshot as `colonySnapshot` makes it. Returns { file, changed }: `changed` is false when nothing needs to be written. Rules:
// - A save at a recorded game time with the same ledger (`n`) joins that snapshot (`joinColonies`): the same colonies as before change nothing and are not written again, a colony not in the stored snapshot is added, a colony that was observed and now differs replaces it and marks the snapshot `revised`, and a failed read never replaces an observation. A save at a recorded time with another `n` is another timeline, which the branch rules settle before this, so it is left out.
// - A save older than the latest one is inserted in time order and the later snapshots stay; the snapshots are thinned to `limit` as the empire series are, and each race's record carries its thinning.
// - A race missing from this save keeps its past.
export const mergeColonies = (file, { races }, { limit = MAX_SNAPSHOTS, now = Date.now } = {}) => {
  const merged = Object.fromEntries(Object.entries(file && file.races ? file.races : {}).map(([RaceID, record]) => [RaceID, { ...record, snapshots: record.snapshots || [] }]))
  let changed = false

  races.forEach(({ RaceID, snapshot }) => {
    const previous = merged[RaceID]
    const stored = previous ? previous.snapshots : []
    const same = stored.find((existing) => existing.t === snapshot.t)
    let next = snapshot

    if (same) {
      if (same.n !== snapshot.n) {
        return
      }

      const joined = joinColonies(same.colonies, snapshot.colonies)

      next = colonySnapshot({ t: same.t, n: same.n, colonies: joined.colonies, revised: Boolean(same.revised) || joined.revised })

      if (next.d === same.d) {
        return
      }
    }

    const outcome = thinCounted([...stored.filter((existing) => existing.t !== snapshot.t), next].sort((a, b) => a.t - b.t), limit)

    merged[RaceID] = withThinning({ snapshots: outcome.snapshots }, previous, outcome, now)
    changed = true
  })

  return { file: { columns: COLONY_COLUMNS, races: merged }, changed }
}

// The sum of a column over rows, or null when any row has no stored value: a total with a missing term is unknown, not the sum of the rest. No rows is a known 0.
const sum = (rows, key) => (rows.every((row) => isKnownNumber(row[key])) ? rows.reduce((total, row) => total + Number(row[key]), 0) : null)

const nullable = (value) => (isKnownNumber(value) ? Number(value) : null)

const rounded = (value, scale = 1) => (value === null ? null : Math.round(value * scale) / scale)

// One race's state now, compact enough to keep thousands of: population, treasury, stockpiles, ships, installations, research and exploration. `options` go to every query (the recorder passes its read transaction).
export const takeSnapshot = async (database, { GameID, RaceID }, options = {}) => {
  const query = (sql) => database.query(sql, options).then(([items]) => items)
  const [[race], colonies, ships, installations, [counts]] = await Promise.all([
    query(`select FCT_Game.GameTime, FCT_Game.GameName, FCT_Race.RaceTitle, FCT_Race.WealthPoints, FCT_Race.AnnualWealth from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`),
    query(`select FCT_Population.Population, FCT_Population.FuelStockpile, FCT_Population.MaintenanceStockpile, FCT_Population.Duranium, FCT_Population.Neutronium, FCT_Population.Corbomite, FCT_Population.Tritanium, FCT_Population.Boronide, FCT_Population.Mercassium, FCT_Population.Vendarite, FCT_Population.Sorium, FCT_Population.Uridium, FCT_Population.Corundium, FCT_Population.Gallicite from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`),
    query(`select FCT_ShipClass.Commercial, count(*) as Ships, case when count(FCT_ShipClass.Size) = count(*) then sum(FCT_ShipClass.Size * 50) end as Tons from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_ShipClass.Commercial`),
    query(`select FCT_PopulationInstallations.PlanetaryInstallationID as ID, case when count(FCT_PopulationInstallations.Amount) = count(*) then sum(FCT_PopulationInstallations.Amount) end as Amount from FCT_PopulationInstallations inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_PopulationInstallations.Amount > 0 or FCT_PopulationInstallations.Amount is null) group by FCT_PopulationInstallations.PlanetaryInstallationID`),
    query(`select (select case when count(FCT_TechSystem.DevelopCost) = count(*) then coalesce(sum(FCT_TechSystem.DevelopCost), 0) end from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID}) as Research, (select count(*) from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}) as Systems, (select count(*) from FCT_Commander where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and ${SERVING_COMMANDER}) as Commanders`),
  ])

  if (!race) {
    return null
  }

  // No ship of a kind is a known 0 ships and 0 t; a class with no stored size makes the tonnage null.
  const shipsOf = (commercial) => ships.find((row) => !!row.Commercial === commercial) || { Ships: 0, Tons: 0 }
  const military = shipsOf(false)
  const commercial = shipsOf(true)
  const populated = colonies.every((colony) => isKnownNumber(colony.Population))

  return {
    gameName: race.GameName,
    raceName: race.RaceTitle,
    snapshot: {
      t: race.GameTime,
      population: sum(colonies, 'Population'),
      colonies: populated ? colonies.filter((colony) => colony.Population > 0).length : null,
      wealth: nullable(race.WealthPoints),
      income: nullable(race.AnnualWealth),
      fuel: sum(colonies, 'FuelStockpile'),
      msp: sum(colonies, 'MaintenanceStockpile'),
      // Colony stockpiles, Duranium to Gallicite (mineral IDs 1–11); null where a colony has no stored amount.
      minerals: ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'].map((name) => rounded(sum(colonies, name))),
      militaryShips: military.Ships,
      militaryTons: rounded(nullable(military.Tons)),
      commercialShips: commercial.Ships,
      commercialTons: rounded(nullable(commercial.Tons)),
      // { PlanetaryInstallationID: amount }, null for a type with a row that has no stored amount.
      installations: Object.fromEntries(installations.map((row) => [row.ID, rounded(nullable(row.Amount), 100)])),
      research: nullable(counts.Research),
      systems: counts.Systems,
      commanders: counts.Commanders,
    },
  }
}

// The witness a snapshot carries of the ledger it was taken on: `{ n, digest }`, the increments the save's ledger held and the chained digest after them that also covers each increment's Length (utilities/campaign.js `scanLedger`, `lengthDigest`), so a later save's own ledger digested the same way up to `n` can show whether the snapshot lies on its history. Length is part of it because two forks can share the ID and game time of the increment where they part and differ only in its Length. A snapshot recorded before this was kept has none, and so does one taken of an empty ledger.
export const isChain = (chain) => chain !== null && typeof chain === 'object' && !Array.isArray(chain) && Number.isInteger(chain.n) && chain.n > 0 && typeof chain.digest === 'string' && /^[0-9a-f]{16}$/.test(chain.digest)

const withChain = (snapshot, observation) => {
  const chain = { n: observation.count, digest: observation.lengthDigest }

  return isChain(chain) ? { ...snapshot, chain } : snapshot
}

// The colony read of one race of the pass, or null: `wish` is what the campaigns chose of colonies (colony-series.js `colonyWish`). A race with a colony chosen at the game time of the save gets one statement ({ ids, rows } or, when it failed, { ids, failed }); a race with none gets none, so a pass with no colony chosen reads and adds nothing.
const colonyReadOf = async (database, wish, { GameID, RaceID, t }, options) => {
  const ids = idsToRead(wish, GameID, RaceID, t)

  return ids.length ? readColonies(database, { GameID, ids }, options) : null
}

// The observation reads of one race of the pass, or null: `observe` is what the campaigns chose (observations.js `observationWish`). Only a player race (NPR = 0) with a kind chosen is read, each kind in the transaction of the pass; a kind that fails is that kind's own `{ failed }`, so a pass with nothing chosen issues no statement and a read that fails never fails the empire's snapshot.
const observationReadOf = async (database, observe, { GameID, RaceID, npr }, options) => {
  const kinds = npr ? [] : observationWanted(observe, GameID, RaceID)
  const reads = []

  for (const kind of kinds) {
    reads.push(await readObservations(database, kind, { GameID, RaceID }, options))
  }

  return reads.length ? reads : null
}

// The event reads of one game of the pass: a function giving the read of a race, or null for a race that keeps no archive. `archive` is what the campaigns chose (event-archive.js `archiveWish`). Only player races (NPR = 0) are read, and the log window is read once for the game, when some recorded race of it is wanted, in the same transaction; a failure of that read is each wanted race's own `{ failed }`, so a pass with no archive chosen issues no statement and an archive that cannot be read never fails the empire's snapshot.
const eventReadsOf = async (database, archive, { GameID, races }, options) => {
  const wanted = races.filter((race) => !toBoolean(race.NPR) && archiveWanted(archive, GameID, race.RaceID))

  if (!wanted.length) {
    return () => null
  }

  let window = null
  let failure = null

  try {
    window = await readLogWindow(database, GameID, options)
  } catch (error) {
    failure = error
  }

  return (race, t) => (wanted.includes(race) ? (failure ? Promise.resolve({ failed: failure }) : readRaceEvents(database, { GameID, RaceID: race.RaceID, t, window }, options)) : null)
}

// Everything one pass takes from the save: { read, failed }. `read` is [{ GameID, observation, taken, intel }] per game of the save, `observation` being what identifies its campaign (utilities/campaign.js `observeGame`), `taken` [{ RaceID, raceName, npr, gameName, snapshot }] for each recorded race and `intel` { [ViewRaceID]: takeIntel() }; `failed` is the games that couldn't be read, [{ GameID, stage: 'read', error }]. `marks` is { [GameID]: [increment counts] }, the stored tips the ledger is compared at exactly. It all happens in one read transaction, so a save written meanwhile can't give one race's snapshot the old save and the next one's the new. In SQLite a read transaction holds a shared lock from its first SELECT, which in rollback-journal mode (Aurora's) makes the game wait to commit: the reads are a few dozen small queries and one scan of the game's increments, and the history files are written after it ends.
const readSave = (database, marks = {}, wish = {}, archive = {}, observe = {}) => database.transaction(async (transaction) => {
  const options = { transaction }
  const [races] = await database.query('select FCT_Race.GameID, FCT_Race.RaceID, FCT_Race.NPR, FCT_Race.SpecialNPRID from FCT_Race', options)
  const [games] = await database.query(GAMES_SQL, options)
  const recorded = {}
  const read = []
  const failed = []

  const nprRaces = {}

  races.forEach((race) => {
    if (toBoolean(race.NPR)) {
      nprRaces[race.GameID] = [...(nprRaces[race.GameID] || []), race.RaceID]
    }
  })

  races.filter(recordsHistory).forEach((race) => {
    recorded[race.GameID] = [...(recorded[race.GameID] || []), race]
  })

  for (const game of games) {
    const GameID = Number(game.GameID)
    const taken = []
    const intel = {}

    try {
      const observation = await observeGame(database, game, { options, marks: marks[GameID] })
      const eventReadFor = await eventReadsOf(database, archive, { GameID, races: recorded[game.GameID] || [] }, options)

      for (const race of recorded[game.GameID] || []) {
        const result = await takeSnapshot(database, { GameID: game.GameID, RaceID: race.RaceID }, options)

        if (result) {
          const colonyRead = await colonyReadOf(database, wish, { GameID, RaceID: race.RaceID, t: result.snapshot.t }, options)
          const eventRead = await eventReadFor(race, result.snapshot.t)
          const observationRead = await observationReadOf(database, observe, { GameID, RaceID: race.RaceID, npr: toBoolean(race.NPR) }, options)

          taken.push({ RaceID: race.RaceID, raceName: result.raceName, npr: toBoolean(race.NPR), gameName: result.gameName, snapshot: withChain(result.snapshot, observation), ...(colonyRead ? { colonyRead } : {}), ...(eventRead ? { eventRead } : {}), ...(observationRead ? { observationRead } : {}) })
          intel[race.RaceID] = await takeIntel(database, { GameID: game.GameID, RaceID: race.RaceID }, options)
        }
      }

      read.push({ GameID, observation, taken, intel, nprRaces: nprRaces[game.GameID] || [] })
    } catch (error) {
      failed.push({ GameID, stage: 'read', error })
    }
  }

  return { read, failed }
})

const randomId = () => globalThis.crypto.randomUUID()

const SETTLE_ATTEMPTS = 3

const settleAgain = (storage, options) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return settle(storage, options)
    } catch (error) {
      if (!error.conflict || attempt >= SETTLE_ATTEMPTS) {
        throw error
      }
    }
  }
}

// The record files a branch keeps beside its history file, as `recordProblem` reads them: how each is named, how a stored file is judged readable, the registry mark that says a fork was seeded, and what the file is called in a refusal.
const EVENT_RECORD = Object.freeze({ fileName: eventFileName, problem: eventFileProblem, seeded: 'eventsSeeded', noun: 'event archive' })
const OBSERVATION_RECORD = Object.freeze({ fileName: observationFileName, problem: observationFileProblem, seeded: 'observationsSeeded', noun: 'observation record' })

// Why the record file (`spec`) a branch would merge into or be seeded from cannot be read by this version, or null when it can: its own file, and while it has none and was never given its seed, the file of the branch it forks from, and so on up (the files `eventBase`/`observationBase` and the fork files read). A store that throws when read (damaged JSON, an I/O error) is a file that cannot be read like any other. The recorder leaves such a branch alone, so a file a later version wrote, or a damaged one, is never replaced by a version-1 file, and a read that throws never reaches the pass's outer catch, which would skip the empire's snapshot.
const recordProblem = (storage, campaign, branchId, spec) => {
  let id = branchId

  try {
    while (id) {
      const stored = storage.file(spec.fileName(campaign.id, id)).store
      const problem = spec.problem(stored)

      if (problem) {
        return `the ${spec.noun} of branch ${id} cannot be read (${problem})`
      }

      const branch = campaign.branches[id]

      if ((stored && stored.races) || !branch || branch[spec.seeded] === true || !branch.parent || !branch.fork || !Number.isFinite(branch.fork.t)) {
        return null
      }

      id = branch.parent
    }
  } catch (error) {
    return `the ${spec.noun} of branch ${id} cannot be read (${error && error.message ? error.message : String(error)})`
  }

  return null
}

const eventProblem = (storage, campaign, branchId) => recordProblem(storage, campaign, branchId, EVENT_RECORD)

// What a read of a record file gives, { value } or { problem }: the reads `recordProblem` already passed are made again by the base and fork-file functions, and a store that throws on the second one is the same refusal.
const recordTry = (read, noun = EVENT_RECORD.noun) => {
  try {
    return { value: read() }
  } catch (error) {
    return { problem: `the ${noun} cannot be read (${error && error.message ? error.message : String(error)})` }
  }
}

const eventTry = (read) => recordTry(read)

// The observation seed of a branch the pass created, taken in the same pass for every fork, observed or not, as the colony series and the event archive are: a branch left unmarked would be seeded at its first capture from a parent whose later records the fork cannot have seen. A campaign whose settings never held an observation choice for a race the game does not list as an NPR (`nprRaces`) has no record to seed from, so its fork is only marked and no observation file is opened. A parent without a record seeds nothing and the branch is only marked. It is marked in its own registry write after the seed file, as the event archive's: a record this version cannot read is not seeded from, is reported in `failed`, and the branch stays unmarked so it is seeded when the parent can be read.
const seedObservationFork = (storage, resolution, { GameID, nprRaces, failed, guard }) => {
  if (!resolution.forked) {
    return
  }

  const registry = readRegistry(storage)
  const campaign = registry.campaigns[resolution.campaignId]
  const chosenBefore = observationEverChosenIn(storage.settings ? storage.settings.store : null, resolution.campaignId, nprRaces)
  const problem = chosenBefore ? recordProblem(storage, campaign, resolution.branchId, OBSERVATION_RECORD) : null
  const seed = problem ? { problem } : chosenBefore ? recordTry(() => observationForkFile(storage, campaign, resolution.branchId), OBSERVATION_RECORD.noun) : { value: null }

  if (seed.problem) {
    failed.push({ GameID, stage: 'observations', error: new Error(seed.problem) })

    return
  }

  if (seed.value) {
    guard()
    storage.file(observationFileName(resolution.campaignId, resolution.branchId)).store = seed.value
  }

  const branch = campaign.branches[resolution.branchId]

  if (branch && branch.observationsSeeded !== true) {
    branch.observationsSeeded = true
    guard()
    writeRegistry(storage, registry)
  }
}

// Snapshot every recorded race in the save, and what each knows of the other races, writing each game's history file once, in the history of the campaign and branch the game was settled to (utilities/campaign.js `settle`: the same campaign across a rename, a move or a copy of the file, a branch for a replayed past, a new campaign for a game no recorded one claims). A game that can't be read or written doesn't stop the others (electron-store throws when it can't write, as does web mode's localStorage when the quota is full); its snapshots are lost. `onResolved(GameID, resolution)` is called once a game is settled and `onSaved(GameID)` as soon as its history file is written, so views refresh even if a later game fails. `isCurrent()` is the store's freshness generation guard, asked before every write of the migration, the registry and the history files: a pass that was superseded (a newer save was loaded while it read) stops there, whatever it had done so far being either complete or rolled back by the next pass. A window or tab that is not the recording owner of its database (utilities/recording-owner.js, `ownerGrace` the ms it waits for the lock) records nothing and reports stage 'readonly'; the pass runs under the registry lock shared by every database. `path` is the save's path, kept as an attachment of the campaign and never as its identity. Returns { recorded, failed, superseded }: how many races were saved, the games that couldn't be read or written, [{ GameID, stage: 'read' | 'write' | 'registry' | 'readonly' | 'events', error }] (GameID null and stage 'registry' when the campaign registry is damaged and nothing was recorded; stage 'events' when the branch's event archive cannot be read by this version and was left untouched, the empire's snapshot being recorded all the same), and whether the pass was abandoned.
export const recordHistory = async (database, { onSaved = () => {}, onResolved = () => {}, isCurrent = () => true, storage = campaignStorage(), path = null, now = Date.now, newId = randomId, ownerGrace = undefined } = {}) => {
  const guard = () => {
    if (!isCurrent()) {
      throw new Superseded()
    }
  }

  // Before the registry is read: a window that takes the recording over reads what the previous owner left.
  if (!(await recordingOwner(ownerGrace))) {
    return { recorded: 0, failed: [{ GameID: null, stage: 'readonly', error: new ReadOnly() }], superseded: false }
  }

  const tipsOf = () => {
    try {
      const settings = storage.settings ? storage.settings.store : null
      const coloniesChosen = colonyChosen(settings)
      const eventsChosen = archiveChosen(settings)
      const observationsChosen = observationChosen(settings)
      const campaigns = coloniesChosen || eventsChosen || observationsChosen ? readRegistry(storage).campaigns : null

      return { marks: marksOf(storage), wish: coloniesChosen ? colonyWish(settings, campaigns) : {}, archive: eventsChosen ? archiveWish(settings, campaigns) : {}, observe: observationsChosen ? observationWish(settings, campaigns) : {} }
    } catch (error) {
      return { failure: { recorded: 0, failed: [{ GameID: null, stage: 'registry', error }], superseded: false } }
    }
  }

  const first = tipsOf()

  if (first.failure) {
    return first.failure
  }

  // The save is read outside the registry lock, so a read that hangs cannot hold every window's recording up.
  let { read, failed } = await readSave(database, first.marks, first.wish, first.archive, first.observe)
  let wish = first.wish
  let archive = first.archive
  let observe = first.observe
  let recorded = 0

  // The step of this pass that reads and changes the registry is taken alone under the registry lock shared by every database. A window of another database may have recorded since the tips were read: the save is then read again, here, against the tips now stored (a save read against older tips is settled on a coarser comparison than the tips need).
  return withRegistry(async () => {
    if (!isCurrent()) {
      return { recorded, failed, superseded: true }
    }

    const current = tipsOf()

    if (current.failure) {
      return current.failure
    }

    if (JSON.stringify(current.marks) !== JSON.stringify(first.marks)) {
      ;({ read, failed } = await readSave(database, current.marks, current.wish, current.archive, current.observe))
      wish = current.wish
      archive = current.archive
      observe = current.observe
    }

    for (const { GameID, observation, taken, intel, nprRaces } of read) {
      if (!isCurrent()) {
        return { recorded, failed, superseded: true }
      }

      try {
        guard()

        const resolution = settleAgain(storage, { opened: observation, path, now: now(), newId, guard })

        onResolved(GameID, resolution)

        // A branch this pass created takes the colony series and the event archive of its parent up to the fork now, so what the parent does with them later (a clear, a revision, a colony followed on an earlier save, a capture) never reaches the child. Nothing is written when the parent holds none, but the branch is marked seeded either way, so an empty seed stays empty. Both marks are written in one registry write after the seed files: a pass that stops between the two leaves the branch unmarked, which is seeded from its parent at its first colony or event write.
        if (resolution.forked) {
          const registry = readRegistry(storage)
          const campaign = registry.campaigns[resolution.campaignId]
          const given = colonyForkFile(storage, campaign, resolution.branchId)
          const eventsProblem = eventProblem(storage, campaign, resolution.branchId)
          const seed = eventsProblem ? { problem: eventsProblem } : eventTry(() => eventForkFile(storage, campaign, resolution.branchId))
          const eventsFine = !seed.problem
          const givenEvents = eventsFine ? seed.value : null

          if (seed.problem) {
            failed.push({ GameID, stage: 'events', error: new Error(seed.problem) })
          }

          if (given) {
            guard()
            storage.file(colonyFileName(resolution.campaignId, resolution.branchId)).store = given
          }

          if (givenEvents) {
            guard()
            storage.file(eventFileName(resolution.campaignId, resolution.branchId)).store = givenEvents
          }

          const branch = campaign.branches[resolution.branchId]

          if (branch && (branch.coloniesSeeded !== true || (eventsFine && branch.eventsSeeded !== true))) {
            campaign.branches[resolution.branchId].coloniesSeeded = true

            if (eventsFine) {
              campaign.branches[resolution.branchId].eventsSeeded = true
            }

            guard()
            writeRegistry(storage, registry)
          }
        }

        // The observation seed of a fork, in the same pass as the colony series and the event archive (`seedObservationFork`).
        seedObservationFork(storage, resolution, { GameID, nprRaces, failed, guard })

        if (taken.length) {
          guard()

          const store = storage.file(branchFileName(resolution.campaignId, resolution.branchId))

          store.store = mergeGame(store.store, { gameName: observation.gameName, races: taken, intel }, { limit: retentionOfSettings(storage.settings).cap, now })
          recorded += taken.length
          onSaved(GameID)

          // The colony series is written after the empire's file, behind the same guard, and only for a race with a colony chosen at this save's time in the campaign it settled to: a failed colony read is in it as not read, and never fails the empire's snapshot.
          const captured = taken.filter(({ colonyRead }) => colonyRead).flatMap(({ RaceID, snapshot, colonyRead }) => {
            const entries = entriesAt(wish, resolution.campaignId, RaceID, snapshot.t)

            return entries.length ? [{ RaceID, snapshot: colonySnapshot({ t: snapshot.t, n: observation.count, colonies: colonyRows(entries, colonyRead) }) }] : []
          })

          if (captured.length) {
            const series = storage.file(colonyFileName(resolution.campaignId, resolution.branchId))
            const limit = retentionOfSettings(storage.settings).cap
            const { file, changed } = mergeColonies(colonyBase(storage, readRegistry(storage).campaigns[resolution.campaignId], resolution.branchId), { races: captured }, { limit, now })

            if (changed) {
              guard()
              series.store = file
              onSaved(GameID)
            }
          }

          // The event archive is written after the colony series, behind the same guard, and only for a player race with the archive on in the campaign the save settled to. A read that failed or found no log writes no rows and never fails the empire's snapshot; a pass that adds nothing to the archive does not write it. A branch whose own file, or a parent file it would be seeded from, cannot be read by this version is left untouched (no merge, no write, no seed) and reported as a failure of stage `events`, because writing over it would destroy evidence the page promises to keep. A failed read of a race that keeps an archive is kept in the race's record, so a missed observation is never mistaken for one that was not tried.
          const kept = taken.filter(({ RaceID, eventRead }) => eventRead && archiveKept(archive, resolution.campaignId, RaceID))

          if (kept.length) {
            const campaign = readRegistry(storage).campaigns[resolution.campaignId]
            const checked = eventProblem(storage, campaign, resolution.branchId)
            const base = checked ? { problem: checked } : eventTry(() => eventBase(storage, campaign, resolution.branchId))
            const observed = kept.filter(({ eventRead }) => eventRead.capture)
            const lost = kept.filter(({ eventRead }) => eventRead.failed)

            if (base.problem) {
              failed.push({ GameID, stage: 'events', error: new Error(base.problem) })
            } else if (observed.length || lost.length) {
              const events = storage.file(eventFileName(resolution.campaignId, resolution.branchId))
              const merged = mergeEvents(base.value, { races: observed.map(({ RaceID, eventRead }) => ({ RaceID, capture: eventRead.capture })) }, { cap: eventCapOfSettings(storage.settings), now })
              const file = merged.file
              let changed = merged.changed

              lost.forEach(({ RaceID, snapshot, eventRead }) => {
                file.races[RaceID] = withFailure(file.races[RaceID] || null, { at: now(), t: snapshot.t, reason: failureWords(eventRead.failed) })
                changed = true
              })

              if (changed) {
                guard()
                events.store = file
                onSaved(GameID)
              }
            }
          }

          // The observation record is written after the event archive, behind the same guard, and only for a player race with a kind observed in the campaign the save settled to. A kind that cannot be read is noted as a failed capture and changes no object, so the interval it would have covered stays a gap and never counts as observed unchanged. A record this version cannot read, or a parent record it would be seeded from, is left untouched and reported as a failure of stage `observations`. A pass with nothing observed reads and writes nothing.
          const watched = taken.flatMap(({ RaceID, snapshot, observationRead }) => (observationRead || []).filter(({ kind }) => observationKept(observe, resolution.campaignId, RaceID).includes(kind)).map((read) => ({ RaceID, snapshot, read })))

          if (watched.length) {
            const campaign = readRegistry(storage).campaigns[resolution.campaignId]
            const checked = recordProblem(storage, campaign, resolution.branchId, OBSERVATION_RECORD)
            const base = checked ? { problem: checked } : recordTry(() => observationBase(storage, campaign, resolution.branchId), OBSERVATION_RECORD.noun)

            if (base.problem) {
              failed.push({ GameID, stage: 'observations', error: new Error(base.problem) })
            } else {
              const captures = watched.filter(({ read }) => read.objects).map(({ RaceID, snapshot, read }) => ({ RaceID, kind: read.kind, capture: { t: snapshot.t, n: observation.count, objects: read.objects } }))
              const failures = watched.filter(({ read }) => read.failed).map(({ RaceID, snapshot, read }) => ({ RaceID, kind: read.kind, failure: { t: snapshot.t, at: now(), reason: failureWords(read.failed) } }))
              const forkOf = campaign.branches[resolution.branchId] ? campaign.branches[resolution.branchId].fork : null
              const merged = mergeObservations(base.value, { captures, failures, forkAt: forkOf && isKnownNumber(forkOf.t) ? forkOf.t : null })

              if (merged.changed) {
                guard()
                storage.file(observationFileName(resolution.campaignId, resolution.branchId)).store = merged.file
                onSaved(GameID)
              }
            }
          }
        }
      } catch (error) {
        if (error.superseded) {
          return { recorded, failed, superseded: true }
        }

        failed.push({ GameID, stage: error.readOnly ? 'readonly' : 'write', error })
      }
    }

    return { recorded, failed, superseded: false }
  })
}
