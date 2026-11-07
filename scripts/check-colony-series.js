/*
  Checks the colony series: the opt-in record of chosen colonies (src/renderer/utilities/colony-series.js and its use in utilities/history.js, plugins/history.js, store/history.js).

  node scripts/check-colony-series.js [--no-mutations]

  Groups, each check numbered and keyed (a mutation names the keys it must break):
  - rows: the record of a colony (the states, the rounding, a stored zero against a missing value), what is chosen and when it applies, the limit of 50, the size estimate;
  - merge: the series of a branch (the same save again, a colony added, a revision, a failed read over an observation, an older save, the cap, a branch seeded from its parent);
  - single: the recorder over the fixture save (scripts/lib/fixtures.js), read only: no statement and no write without a choice, one statement with one, the figures against SQL written here, a repeat write nothing, a failed read, a pass superseded at every guard, the retention cap;
  - chain: the recorder over the played campaign (A, B and the two branches from B, C1 and C2), read only: C2 opened after C1 is a rollback to B and a play on, so a fork cut at the last whole 64 increments the two ledgers share, the colony series the fork is seeded with (up to the cut and none later, though no colony is followed any more and the parent's series is cleared afterwards), the figures of each branch against SQL written here, the first branch left as it was by the fork, and C1 opened again after C2 capturing nothing.
  A save that is not there skips the group that reads it and says so; nothing is read from a save but SELECTs (the files are opened read only).

  Everything else runs on in-memory stores. Each mutation of the utilities is planted in an isolated copy (scripts/lib/mutant-source.js) and must break the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { loadPage, replacing, instantiate } = require('./lib/page-loader')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')
const { FIXTURE, PLAYED, PLAYED_NEXT, PLAYED_C1, PLAYED_C2 } = require('./lib/fixtures')
const { STEP, partingOf } = require('./lib/played-chain')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const MODDED = { file: path.join(root, FIXTURE.file), GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId }
const NAMES = ['history', 'colony-series', 'campaign', 'recording-owner']

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The stores of the history folder, kept in one map by folder and name: what `clearRaceHistory` and `colonyStore` read and write.
const STORE_STUB = `const files = (globalThis.__colonySeriesStores = globalThis.__colonySeriesStores || new Map())
export default class Config {
  constructor ({ cwd = '', name = 'config' } = {}) { this.key = cwd + '/' + name }
  get store () { return JSON.parse(JSON.stringify(files.get(this.key) || {})) }
  set store (value) { files.set(this.key, JSON.parse(JSON.stringify(value))) }
  get path () { return this.key }
  get (key, fallback) { return key.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), this.store) ?? fallback }
}`

const STUBS = {
  'electron-store': STORE_STUB,
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// The text of each file of the utilities, read once for all the loads of the process: the folder does not change while the checks run, and a mutant's own text is given as `sources`.
const texts = new Map()

const loadModules = async (sources = {}) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory: utilitiesDirectory, sources, texts })

  return { history: loaded.history, colony: loaded['colony-series'], campaign: loaded.campaign, reload: () => loadModules(sources) }
}

// ---------- the saves, read only ----------

const handles = new Map()

const handleOf = (file) => {
  if (!handles.has(file)) {
    handles.set(file, new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(handle)))
    }))
  }

  return handles.get(file)
}

const rowCache = new Map()

// A save is read only, so the rows a statement gives are the same each time it is run. Each caller gets rows of its own.
const rowsOf = async (file, sql) => {
  const key = `${file}\n${sql}`

  if (!rowCache.has(key)) {
    rowCache.set(key, handleOf(file).then((handle) => new Promise((resolve, reject) => handle.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))))
  }

  return (await rowCache.get(key)).map((row) => ({ ...row }))
}

// The database the recorder reads, as scripts/check-history-retention.js gives it: one transaction that is the connection, each statement logged, the colony statement made to fail on request.
const databaseOf = (file, { log = null, failColonies = false } = {}) => ({
  transaction: (work) => work({ id: 'transaction' }),
  query: async (sql) => {
    if (log) {
      log.push(sql)
    }

    if (failColonies && /PopulationID in \(/.test(sql)) {
      throw new Error('disk I/O error')
    }

    return [await rowsOf(file, sql)]
  },
})

// What is written independently of the utility: the 14 figures of a colony row as the record keeps them, population to 0.001 and the rest to whole units.
const COLUMNS = ['Population', 'FuelStockpile', 'MaintenanceStockpile', 'Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']

const expectedRow = (row) => [row.PopulationID, 0, Math.round(row.Population * 1000) / 1000, ...COLUMNS.slice(1).map((column) => Math.round(row[column]))]

const colonyRowsOf = (file, GameID, RaceID) => rowsOf(file, `select PopulationID, PopName, RaceID, SystemBodyID, ${COLUMNS.join(', ')} from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID}`)

const gameTimeOf = async (file, GameID) => (await rowsOf(file, `select GameTime from FCT_Game where GameID = ${GameID}`))[0].GameTime

// ---------- an installation: each store a JSON value read and written whole ----------

const installation = ({ seed = {}, counter = 1000, clock = 1000000 } = {}) => {
  const files = new Map(Object.entries(seed).map(([name, value]) => [name, clone(value)]))
  const writes = []
  let cut = () => false
  let ids = counter
  let time = clock

  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      writes.push({ name, cut: cut() })
      files.set(name, clone(value))
    },
    update (change) {
      this.store = change(this.store)

      return this.store
    },
  })

  return {
    files,
    writes,
    put: (name, value) => files.set(name, clone(value)),
    setCut: (test) => { cut = test },
    newId: () => `c${++ids}`,
    now: () => ++time,
    io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), backup: store('backup'), file: (name) => store(`file:${name}`) },
    registry: () => ({ campaigns: {}, pool: {}, ...(clone(files.get('registry')) || {}) }),
    campaignId: (GameID) => Object.entries((clone(files.get('registry')) || { campaigns: {} }).campaigns).filter(([, campaign]) => GameID === undefined || (campaign.gameIds || []).includes(GameID)).map(([id]) => id)[0],
    branch: (campaignId, branchId = 'b1') => clone(files.get(`file:campaign-${campaignId}-${branchId}`)) || {},
    colonies: (campaignId, branchId = 'b1') => clone(files.get(`file:campaign-${campaignId}-${branchId}-colonies`)),
    copy: () => installation({ seed: Object.fromEntries(files), counter: ids, clock: time }),
    colonyWrites: () => writes.filter(({ name }) => name.endsWith('-colonies')).length,
  }
}

const record = (m, inst, file, { log, failColonies, isCurrent, onResolved } = {}) => m.history.recordHistory(databaseOf(file, { log, failColonies }), { storage: inst.io, path: `C:/saves/${path.basename(file)}`, now: inst.now, newId: inst.newId, isCurrent, onResolved })

const settled = async (m, inst, file) => {
  await record(m, inst, file)

  return inst.campaignId()
}

const chose = (m, inst, campaignId, RaceID, entries) => {
  const settings = inst.files.get('settings') || {}

  m.colony.putEntries(settings, campaignId, RaceID, entries)
  inst.put('settings', settings)
}

const statementsOfColonies = (log) => log.filter((sql) => /PopulationID in \(/.test(sql))

// ---------- the scenarios, each run once for a set of modules ----------

// The fixture save, one pass at a time on copies of one installation.
const single = async (m) => {
  const { file, GameID, RaceID } = MODDED
  const t = await gameTimeOf(file, GameID)
  const rows = await colonyRowsOf(file, GameID, RaceID)
  const stock = (row) => COLUMNS.slice(1).some((column) => Number(row[column]) > 0)
  const biggest = rows.slice().sort((a, b) => b.Population - a.Population)[0]
  const empty = rows.find((row) => !stock(row) && Number(row.Population) === 0)
  const stamp = (row, over = {}) => ({ id: row.PopulationID, since: t, name: row.PopName, bodyId: row.SystemBodyID, raceId: row.RaceID, ...over })
  const another = rows.find((row) => row !== biggest && row !== empty && stock(row))
  const unseen = 1 + Math.max(...rows.map((row) => row.PopulationID)) + 1000
  const entries = [stamp(biggest), stamp(empty), stamp(another, { raceId: 99999 }), stamp(rows.find((row) => row !== biggest && row !== empty && row !== another), { bodyId: 7 }), { id: unseen, since: t, name: 'nowhere', bodyId: 1, raceId: RaceID }]
  const result = { t, rows, biggest, empty, entries, another, unseen }

  // Settled with nothing chosen: the baseline of the empire file and of the statements.
  const plain = installation()
  const plainLog = []

  await record(m, plain, file, { log: plainLog })
  await record(m, plain, file)
  result.plain = { files: plain.files, colonyWrites: plain.colonyWrites(), names: [...plain.files.keys()].filter((name) => name.includes('colonies')), log: plainLog, branch: plain.branch(plain.campaignId()) }

  // The opt-in: the same save is read again with the colonies chosen.
  const inst = installation()
  const campaignId = await settled(m, inst, file)

  chose(m, inst, campaignId, RaceID, entries)
  inst.start = inst.copy()

  const chosenLog = []
  const firstWrites = inst.writes.length
  const first = await record(m, inst, file, { log: chosenLog })

  result.campaignId = campaignId
  result.first = { run: first, series: inst.colonies(campaignId), statements: statementsOfColonies(chosenLog).length, branch: inst.branch(campaignId), order: inst.writes.slice(firstWrites).map(({ name }) => name) }
  result.afterFirst = inst.colonyWrites()

  await record(m, inst, file)
  await record(m, inst, file)
  result.afterRepeat = { writes: inst.colonyWrites(), series: inst.colonies(campaignId) }

  const restarted = await m.reload()

  await record(restarted, inst, file)
  result.afterRestart = { writes: inst.colonyWrites(), series: inst.colonies(campaignId) }

  // A failed colony read: the empire file as with a good read, every colony not read.
  const failing = installation()
  const failingId = await settled(m, failing, file)

  chose(m, failing, failingId, RaceID, entries)

  const failedRun = await record(m, failing, file, { failColonies: true })

  result.failed = { run: failedRun, series: failing.colonies(failingId), branch: failing.branch(failingId) }

  await record(m, failing, file)
  result.filled = failing.colonies(failingId)

  const erased = installation()
  const erasedId = await settled(m, erased, file)

  chose(m, erased, erasedId, RaceID, entries)
  await record(m, erased, file)

  const kept = erased.colonies(erasedId)

  await record(m, erased, file, { failColonies: true })
  result.erased = { kept, after: erased.colonies(erasedId) }

  // Not chosen at this time, or chosen under no campaign: nothing is read and nothing is written.
  const idle = installation()
  const idleId = await settled(m, idle, file)
  const idleLog = []

  chose(m, idle, idleId, RaceID, [stamp(biggest, { until: t - 1 }), stamp(empty, { since: t + 1 })])
  await record(m, idle, file, { log: idleLog })
  chose(m, idle, 'campaign-of-nobody', RaceID, [stamp(biggest)])
  await record(m, idle, file, { log: idleLog })
  result.idle = { statements: statementsOfColonies(idleLog).length, writes: idle.colonyWrites() }

  // The profile in force caps the colony series as it caps the empire's: 500 snapshots held, one more, and the older half is thinned.
  const capped = installation()
  const cappedId = await settled(m, capped, file)

  chose(m, capped, cappedId, RaceID, entries.slice(0, 1))
  capped.put('settings', { ...capped.files.get('settings'), historyRetention: 'compact' })

  const held = Array.from({ length: 500 }, (_, index) => m.colony.colonySnapshot({ t: 1000 + index, n: index + 1, colonies: [[biggest.PopulationID, 0, ...Array(14).fill(index)]] }))

  capped.put(`file:campaign-${cappedId}-b1-colonies`, { columns: m.colony.COLONY_COLUMNS, races: { [RaceID]: { snapshots: held } } })
  await record(m, capped, file)

  const cappedSeries = capped.colonies(cappedId).races[RaceID]

  result.capped = { snapshots: cappedSeries.snapshots, thinning: m.history.thinningStatus(cappedSeries), held }

  // A pass superseded at each of its checks: a newer snapshot already stored stays, nothing is written after the pass was replaced, and what is written is whole.
  const base = inst.start.copy()
  const later = m.colony.colonySnapshot({ t: t + 5000, n: 1, colonies: [[biggest.PopulationID, 0, ...Array(14).fill(9)]] })

  base.put(`file:campaign-${campaignId}-b1-colonies`, { columns: m.colony.COLONY_COLUMNS, races: { [RaceID]: { snapshots: [later] } } })

  let guards = 0

  await record(m, base.copy(), file, { isCurrent: () => { guards++; return true } })

  let unchangedGuards = 0

  await record(m, inst.copy(), file, { isCurrent: () => { unchangedGuards++; return true } })

  result.superseded = []

  for (let allowed = 0; allowed <= guards; allowed++) {
    const run = base.copy()
    let calls = 0

    run.setCut(() => calls > allowed)

    const outcome = await record(m, run, file, { isCurrent: () => ++calls <= allowed })
    const series = run.colonies(campaignId)

    result.superseded.push({ allowed, superseded: outcome.superseded, afterCut: run.writes.filter(({ cut }) => cut).length, series: series ? series.races[RaceID].snapshots : null, wrote: run.colonyWrites() })
  }

  result.guards = guards
  result.unchangedGuards = unchangedGuards
  result.later = later

  return result
}

// ---------- the played campaign ----------

// A, B and the two branches from B, in the order of play (scripts/lib/fixtures.js); the game and the race are the campaign's.
const CHAIN = [['A', PLAYED], ['B', PLAYED_NEXT], ['C1', PLAYED_C1], ['C2', PLAYED_C2]].map(([letter, played]) => ({ letter, file: path.join(root, played.file), GameID: played.gameId, RaceID: played.raceId }))
const CHAIN_THERE = CHAIN.every(({ file }) => fs.existsSync(file))

// The ledger of a save as the recorder reads it (an increment is its ID and its game time).
const ledgerOf = (file, GameID) => rowsOf(file, `select IncrementID, GameTime from FCT_Increments where GameID = ${GameID} order by IncrementID`)

// The campaign recorded in the order of play: the colony of the race with the largest population chosen on A, the colony B added chosen on B, C1, then C2, which parts from C1 at B (a rollback to B and a play on), the colony C2 added chosen on C2, and C1 opened again. A copy of the installation taken before C2 follows a fork made when no colony is followed any more, the parent's series cleared afterwards and a colony chosen on the fork.
const chain = async (m) => {
  const { GameID, RaceID } = CHAIN[0]
  const times = {}
  const rows = {}
  const ledgers = {}

  for (const { letter, file } of CHAIN) {
    times[letter] = await gameTimeOf(file, GameID)
    rows[letter] = await colonyRowsOf(file, GameID, RaceID)
    ledgers[letter] = await ledgerOf(file, GameID)
  }

  const fileOf = (letter) => CHAIN.find((entry) => entry.letter === letter).file
  const rowOf = (letter, id) => rows[letter].find((row) => row.PopulationID === id)
  const stamped = (letter, id) => ({ id, since: times[letter], name: rowOf(letter, id).PopName, bodyId: rowOf(letter, id).SystemBodyID, raceId: rowOf(letter, id).RaceID })
  const added = (from, to) => rows[to].filter((row) => !rows[from].some((other) => other.PopulationID === row.PopulationID)).map((row) => row.PopulationID)
  const ids = { earth: rows.A.slice().sort((a, b) => b.Population - a.Population)[0].PopulationID, rantz: added('A', 'B')[0], virginis: added('C1', 'C2')[0] }
  const result = { GameID, RaceID, times, rows, ledgers, ids, added: { B: added('A', 'B'), C2: added('C1', 'C2') }, relations: {} }
  const inst = installation()
  let last = null

  const rec = async (target, letter, options = {}) => {
    await record(m, target, fileOf(letter), { onResolved: (id, resolution) => { last = id === GameID ? resolution : last }, ...options })

    return last
  }

  result.relations.A = (await rec(inst, 'A')).relation

  const campaignId = inst.campaignId(GameID)
  const followed = (target) => target.files.get('settings').campaign[campaignId].race[RaceID].historyColonies

  result.campaignId = campaignId
  chose(m, inst, campaignId, RaceID, [stamped('A', ids.earth)])
  await rec(inst, 'A')
  result.relations.B = (await rec(inst, 'B')).relation
  chose(m, inst, campaignId, RaceID, [...followed(inst), stamped('B', ids.rantz)])
  await rec(inst, 'B')
  result.relations.C1 = (await rec(inst, 'C1')).relation
  result.parent = { registry: inst.registry().campaigns[campaignId], series: inst.colonies(campaignId) }

  const stopped = inst.copy()
  const emptyFile = { columns: [...m.colony.COLONY_COLUMNS], races: {} }

  result.emptyFile = emptyFile

  const fork = await rec(inst, 'C2')

  result.relations.C2 = fork.relation
  result.fork = { forked: fork.forked, branchId: fork.branchId, registry: inst.registry().campaigns[campaignId], b1: inst.colonies(campaignId, 'b1'), b2: inst.colonies(campaignId, 'b2') }
  chose(m, inst, campaignId, RaceID, [...followed(inst), stamped('C2', ids.virginis)])
  await rec(inst, 'C2')
  result.chosen = { b1: inst.colonies(campaignId, 'b1'), b2: inst.colonies(campaignId, 'b2') }

  const writes = inst.colonyWrites()
  const reopened = await rec(inst, 'C1')

  result.reopened = { relation: reopened.relation, branchId: reopened.branchId, writes: inst.colonyWrites() - writes, b1: inst.colonies(campaignId, 'b1'), b2: inst.colonies(campaignId, 'b2') }

  // The colonies are no longer followed when C2 is opened, so the pass that makes the fork captures none; the parent's series is cleared afterwards and a colony is chosen on the fork.
  chose(m, stopped, campaignId, RaceID, followed(stopped).reduce((entries, entry) => m.colony.withoutColony(entries, entry.id, times.C1), followed(stopped)))
  await rec(stopped, 'C2')
  result.stopped = { registry: stopped.registry().campaigns[campaignId], b1: stopped.colonies(campaignId, 'b1'), b2: stopped.colonies(campaignId, 'b2'), writes: stopped.colonyWrites() }
  stopped.put(`file:campaign-${campaignId}-b1-colonies`, emptyFile)
  chose(m, stopped, campaignId, RaceID, [stamped('C2', ids.virginis)])
  await rec(stopped, 'C2')
  result.cleared = { b1: stopped.colonies(campaignId, 'b1'), b2: stopped.colonies(campaignId, 'b2') }

  return result
}

// ---------- the checks ----------

const checks = []
const check = (key, name, needs, run) => checks.push({ key, name, needs, run })

const obs = (id, base = 1) => [id, 0, ...Array(14).fill(base)]

const TIMES = (series) => series.snapshots.map((snapshot) => snapshot.t)

const stateOf = (snapshot, id) => snapshot.colonies.find((entry) => entry[0] === id)

check('rows', 'a colony is observed with its figures rounded (population to 0.001, the rest whole), a stored zero is 0 and a missing value null', 'unit', ({ m }) => {
  const entry = { id: 7, since: 0, name: 'A', bodyId: 100, raceId: 5 }
  const row = { PopulationID: 7, RaceID: 5, SystemBodyID: 100, Population: 12.34567, FuelStockpile: 100.4, MaintenanceStockpile: 0, Duranium: 7.6, Neutronium: 0, Corbomite: 1, Tritanium: 2, Boronide: 3, Mercassium: 4, Vendarite: 5, Sorium: 6, Uridium: 7, Corundium: 8, Gallicite: null }

  assert.deepEqual(m.colony.colonyRows([entry], { rows: [row] }), [[7, 0, 12.346, 100, 0, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, null]])
  assert.deepEqual(m.colony.COLONY_COLUMNS, ['population', 'fuel', 'msp', 'Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'])
})

check('states', 'a colony the save does not show is gone, another race holds it, another body is another object, and a failed read leaves every colony not read: none of them a zero', 'unit', ({ m }) => {
  const entry = { id: 7, since: 0, name: 'A', bodyId: 100, raceId: 5 }
  const row = { PopulationID: 7, RaceID: 5, SystemBodyID: 100, Population: 1, FuelStockpile: 1, MaintenanceStockpile: 1, Duranium: 1, Neutronium: 1, Corbomite: 1, Tritanium: 1, Boronide: 1, Mercassium: 1, Vendarite: 1, Sorium: 1, Uridium: 1, Corundium: 1, Gallicite: 1 }

  assert.deepEqual(m.colony.colonyRows([entry], { rows: [] }), [[7, 1]])
  assert.deepEqual(m.colony.colonyRows([entry], { rows: [{ ...row, RaceID: 6 }] }), [[7, 2, 6]])
  assert.deepEqual(m.colony.colonyRows([entry], { rows: [{ ...row, SystemBodyID: 101 }] }), [[7, 3]])
  assert.deepEqual(m.colony.colonyRows([entry], { rows: [{ ...row, RaceID: null }] }), [[7, 4]])
  assert.deepEqual(m.colony.colonyRows([entry, { ...entry, id: 8 }], { rows: [row], failed: new Error('no') }), [[7, 4], [8, 4]])
})

check('wish', 'a colony applies from its first game time to its last, and only the campaigns that hold the game are read', 'unit', ({ m }) => {
  const entry = (id, over = {}) => ({ id, since: 0, name: `C${id}`, bodyId: 1, raceId: 5, ...over })
  const stored = { campaign: { cA: { race: { 5: { historyColonies: [entry(1), entry(2, { since: 100 }), entry(3, { until: 50 }), { id: 'bad' }] } } }, cB: { race: { 5: { historyColonies: [entry(9)] } } }, cC: { race: { 5: { historyColonies: [entry(10)] } } } } }
  const wish = m.colony.colonyWish(stored, { cA: { id: 'cA', gameIds: [1] }, cB: { id: 'cB', gameIds: [2] }, cC: { id: 'cC', gameIds: [1], mergedInto: 'cA' }, cD: { id: 'cD', gameIds: [1] } })

  assert.deepEqual(Object.keys(wish).sort(), ['cA', 'cB'])
  assert.deepEqual(m.colony.idsToRead(wish, 1, 5, 50), [1, 3])
  assert.deepEqual(m.colony.idsToRead(wish, 1, 5, 51), [1])
  assert.deepEqual(m.colony.idsToRead(wish, 1, 5, 120), [1, 2])
  assert.deepEqual(m.colony.idsToRead(wish, 2, 5, 10), [9])
  assert.deepEqual(m.colony.idsToRead(wish, 1, 6, 10), [])
  assert.deepEqual(m.colony.idsToRead(wish, 3, 5, 10), [])
  assert.deepEqual(m.colony.entriesAt(wish, 'cA', 5, 120).map((e) => e.id), [1, 2])
  assert.deepEqual(m.colony.entriesAt(wish, 'cB', 5, 120).map((e) => e.id), [9])
  assert.deepEqual(m.colony.entriesAt(wish, 'cZ', 5, 120), [])
  assert.equal(m.colony.colonyChosen(stored), true)
  assert.equal(m.colony.colonyChosen(null), false)
  assert.equal(m.colony.colonyChosen({}), false)
  assert.equal(m.colony.colonyChosen({ campaign: { cA: { race: { 5: { historyColonies: [] } } }, cB: { other: 1 } } }), false)
})

check('limit', 'at most 50 colonies of a race are chosen at a time, a dropped colony keeps its entry, and a colony chosen twice is chosen once', 'unit', ({ m }) => {
  let entries = []

  for (let id = 1; id <= 50; id++) {
    entries = m.colony.withColony(entries, { id, name: `C${id}`, bodyId: id, raceId: 5 }, 10)
  }

  assert.equal(entries.length, 50)
  assert.throws(() => m.colony.withColony(entries, { id: 51, name: 'C51', bodyId: 51, raceId: 5 }, 10), (error) => error.name === 'ColonyLimit' && error.limit === 50)
  assert.equal(m.colony.withColony(entries, { id: 50, name: 'C50', bodyId: 50, raceId: 5 }, 11), entries)

  const dropped = m.colony.withoutColony(entries, 3, 99)

  assert.equal(dropped.length, 50)
  assert.equal(dropped.find((entry) => entry.id === 3).until, 99)
  assert.equal(m.colony.chosenNow(dropped).length, 49)
  assert.equal(m.colony.withColony(dropped, { id: 51, name: 'C51', bodyId: 51, raceId: 5 }, 100).length, 51)
})

check('settings', 'the choice is one read-change-write of the settings under campaign.<id>.race.<RaceID>.historyColonies, other keys stay, and a change that throws writes nothing', 'unit', ({ m }) => {
  let stored = { historyRetention: 'compact', campaign: { c1: { race: { 7: { warningsMuted: ['x'] } } } } }
  let writes = 0
  const settings = { update: (change) => { const next = change(JSON.parse(JSON.stringify(stored))); writes++; stored = next } }
  const written = m.colony.saveEntries(settings, 'c1', 7, (entries) => m.colony.withColony(entries, { id: 4, name: 'Four', bodyId: 9, raceId: 7 }, 55))

  assert.deepEqual(written, [{ id: 4, since: 55, name: 'Four', bodyId: 9, raceId: 7 }])
  assert.deepEqual(stored.campaign.c1.race[7].historyColonies, written)
  assert.deepEqual(stored.campaign.c1.race[7].warningsMuted, ['x'])
  assert.equal(stored.historyRetention, 'compact')
  assert.throws(() => settings.update(() => { throw new Error('refused') }))
  assert.equal(writes, 1)
})

check('estimate', 'the size shown before a colony is chosen is snapshots x colonies x 55 bytes', 'unit', ({ m }) => {
  assert.equal(m.colony.COLONY_BYTES, 55)
  assert.equal(m.colony.colonyEstimate({ snapshots: 2000, colonies: 50 }), 5500000)
  assert.equal(m.colony.colonyEstimate({ snapshots: 500, colonies: 1 }), 27500)
})

check('same', 'the same save read again at the same game time with the same colonies changes nothing and is not written', 'unit', ({ m }) => {
  const first = m.history.mergeColonies({}, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies: [obs(1), obs(2)] }) }] })
  const again = m.history.mergeColonies(first.file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies: [obs(2), obs(1)] }) }] })

  assert.equal(first.changed, true)
  assert.equal(again.changed, false)
  assert.deepEqual(again.file, first.file)
  assert.equal(first.file.races[7].snapshots.length, 1)
})

check('added', 'a colony chosen after a save was read adds to that save\'s snapshot without marking it revised', 'unit', ({ m }) => {
  const first = m.history.mergeColonies({}, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies: [obs(1)] }) }] })
  const added = m.history.mergeColonies(first.file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies: [obs(1), obs(2)] }) }] })
  const [snapshot] = added.file.races[7].snapshots

  assert.equal(added.changed, true)
  assert.equal(added.file.races[7].snapshots.length, 1)
  assert.deepEqual(snapshot.colonies.map((entry) => entry[0]), [1, 2])
  assert.equal(snapshot.revised, undefined)
  assert.equal(snapshot.d, m.colony.colonyDigest(snapshot.colonies))
})

check('revised', 'a different observation at the same game time and ledger replaces the colony and marks the snapshot revised, and the mark stays', 'unit', ({ m }) => {
  const put = (file, colonies) => m.history.mergeColonies(file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies }) }] })
  const first = put({}, [obs(1, 1), obs(2, 1)])
  const second = put(first.file, [obs(1, 5)])
  const [snapshot] = second.file.races[7].snapshots

  assert.equal(second.changed, true)
  assert.equal(snapshot.revised, true)
  assert.deepEqual(snapshot.colonies, [obs(1, 5), obs(2, 1)])
  assert.equal(put(second.file, [obs(1, 5)]).changed, false)
  assert.equal(put(second.file, [obs(2, 1)]).file.races[7].snapshots[0].revised, true)
})

check('failedread', 'a failed read at a game time never replaces an observation, and fills in a colony that was not read without calling the snapshot revised', 'unit', ({ m }) => {
  const put = (file, colonies) => m.history.mergeColonies(file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies }) }] })
  const observed = put({}, [obs(1, 3), obs(2, 3)])
  const failed = put(observed.file, [[1, 4], [2, 4]])

  assert.equal(failed.changed, false)
  assert.deepEqual(failed.file.races[7].snapshots[0].colonies, [obs(1, 3), obs(2, 3)])

  const notRead = put({}, [[1, 4]])
  const filled = put(notRead.file, [obs(1, 8)])

  assert.deepEqual(notRead.file.races[7].snapshots[0].colonies, [[1, 4]])
  assert.deepEqual(filled.file.races[7].snapshots[0].colonies, [obs(1, 8)])
  assert.equal(filled.file.races[7].snapshots[0].revised, undefined)
})

check('timeline', 'a save at a recorded game time on another ledger is left out, never written over the stored snapshot', 'unit', ({ m }) => {
  const first = m.history.mergeColonies({}, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 4, colonies: [obs(1, 1)] }) }] })
  const other = m.history.mergeColonies(first.file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t: 10, n: 9, colonies: [obs(1, 7)] }) }] })

  assert.equal(other.changed, false)
  assert.deepEqual(other.file.races[7].snapshots, first.file.races[7].snapshots)
})

check('older', 'a save older than the latest is inserted in time order and the later snapshots stay as they were; a race missing from a save keeps its past', 'unit', ({ m }) => {
  const put = (file, t, RaceID = 7) => m.history.mergeColonies(file, { races: [{ RaceID, snapshot: m.colony.colonySnapshot({ t, n: t, colonies: [obs(1, t)] }) }] }).file
  let file = put({}, 10)

  file = put(file, 20)
  file = put(file, 15)
  file = put(file, 5, 8)

  assert.deepEqual(TIMES(file.races[7]), [10, 15, 20])
  assert.deepEqual(file.races[7].snapshots[2].colonies, [obs(1, 20)])
  assert.deepEqual(TIMES(file.races[8]), [5])
  assert.deepEqual(file.columns, m.colony.COLONY_COLUMNS)
})

check('cap', 'a series is thinned to the cap as the empire series are, the first and the latest snapshot stay, and the record says it was thinned', 'unit', ({ m }) => {
  let file = {}
  const times = Array.from({ length: 12 }, (_, index) => index + 1)

  times.forEach((t) => {
    file = m.history.mergeColonies(file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t, n: t, colonies: [obs(1, t)] }) }] }, { limit: 5 }).file
  })

  const series = file.races[7]

  assert.ok(series.snapshots.length <= 5)
  assert.equal(series.snapshots[0].t, 1)
  assert.equal(series.snapshots[series.snapshots.length - 1].t, 12)
  assert.equal(m.history.thinningStatus(series).status, 'thinned')
  assert.ok(m.history.thinningStatus(series).passes > 0)
})

check('seed', 'a branch is seeded with its parent\'s snapshots up to the fork and no later one, the thinning record comes along only where it still holds, and nothing is seeded before the first', 'unit', ({ m }) => {
  let file = {}

  for (let t = 1; t <= 4; t++) {
    file = m.history.mergeColonies(file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t, n: t, colonies: [obs(1, t)] }) }] }, { limit: 3 }).file
  }

  const all = TIMES(file.races[7])
  const cut = m.colony.colonyUpTo(file, 3)

  assert.deepEqual(TIMES(cut.races[7]), all.filter((t) => t <= 3))
  assert.equal(cut.races[7].thinning, undefined)
  assert.ok(m.colony.colonyUpTo(file, 10).races[7].thinning)
  assert.deepEqual(m.colony.colonyUpTo(file, 0), {})
  assert.deepEqual(m.colony.colonyUpTo(file, null), {})
  assert.deepEqual(m.colony.colonyUpTo({}, 5), {})
})

check('lineage', 'a branch with no file starts from its parent up to the fork, through a parent that has none, and a branch forked before any increment was common starts empty', 'unit', ({ m }) => {
  let file = {}

  ;[10, 20, 40, 60].forEach((t) => {
    file = m.history.mergeColonies(file, { races: [{ RaceID: 7, snapshot: m.colony.colonySnapshot({ t, n: t, colonies: [obs(1, t)] }) }] }).file
  })

  const files = { 'campaign-c-b1-colonies': file }
  const io = { file: (name) => ({ store: files[name] || {} }) }
  const campaign = { id: 'c', branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { t: 30 } }, b3: { id: 'b3', parent: 'b2', fork: { t: 50 } }, b4: { id: 'b4', parent: 'b1', fork: { t: null } } } }

  assert.deepEqual(TIMES(m.colony.colonyBase(io, campaign, 'b2').races[7]), [10, 20])
  assert.deepEqual(TIMES(m.colony.colonyBase(io, campaign, 'b3').races[7]), [10, 20])
  assert.deepEqual(m.colony.colonyBase(io, campaign, 'b4'), {})
  assert.equal(m.colony.colonyBase(io, campaign, 'b1'), file)

  const marked = { ...campaign, branches: { ...campaign.branches, b5: { id: 'b5', parent: 'b1', fork: { t: 30 }, coloniesSeeded: true }, b6: { id: 'b6', parent: 'b5', fork: { t: 30 } } } }

  assert.deepEqual(m.colony.colonyBase(io, marked, 'b5'), {}, 'a branch seeded empty stays empty')
  assert.deepEqual(m.colony.colonySeed(io, marked, 'b5', 30), {})
  assert.deepEqual(m.colony.colonyBase(io, marked, 'b6'), {}, 'nothing passes through a branch seeded empty')
  assert.equal(m.colony.colonyForkFile(io, marked, 'b5'), null)
  assert.deepEqual(TIMES(m.colony.colonyForkFile(io, marked, 'b2').races[7]), [10, 20], 'a branch that predates the mark is seeded')
})

check('clear', 'clearing a race\'s history on a branch clears its colony series there and no other race\'s or branch\'s', 'unit', async ({ m }) => {
  const campaignId = `clear-${Date.now()}`
  const series = (RaceID) => ({ snapshots: [m.colony.colonySnapshot({ t: 1, n: 1, colonies: [obs(1)] })], RaceID })

  m.history.colonyStore(campaignId, 'b1').store = { columns: m.colony.COLONY_COLUMNS, races: { 7: series(7), 8: series(8) } }
  m.history.colonyStore(campaignId, 'b2').store = { columns: m.colony.COLONY_COLUMNS, races: { 7: series(7) } }

  assert.equal(await m.history.clearRaceHistory({ campaignId, branchId: 'b1', RaceID: 7 }), true)
  assert.deepEqual(Object.keys(m.history.colonyStore(campaignId, 'b1').store.races), ['8'])
  assert.deepEqual(Object.keys(m.history.colonyStore(campaignId, 'b2').store.races), ['7'])
  assert.equal(await m.history.clearRaceHistory({ campaignId, branchId: 'b1', RaceID: 7 }), false)
})

check('cleared', 'a branch whose colony file was cleared of every race stays empty: it is not seeded from its parent again, a fork of it is not given the parent\'s samples through it, and a cleared file is never replaced by a fork seed', 'unit', async ({ m }) => {
  const campaignId = `cleared-${Date.now()}`
  const named = (branchId) => m.colony.colonyFileName(campaignId, branchId)
  const series = (RaceID) => ({ snapshots: [m.colony.colonySnapshot({ t: 1, n: 1, colonies: [obs(1)] }), m.colony.colonySnapshot({ t: 2, n: 2, colonies: [obs(1)] })], RaceID })

  m.history.colonyStore(campaignId, 'b1').store = { columns: m.colony.COLONY_COLUMNS, races: { 7: series(7) } }
  m.history.colonyStore(campaignId, 'b2').store = { columns: m.colony.COLONY_COLUMNS, races: { 7: series(7) } }
  assert.equal(await m.history.clearRaceHistory({ campaignId, branchId: 'b2', RaceID: 7 }), true)

  const stores = { [named('b1')]: m.history.colonyStore(campaignId, 'b1').store, [named('b2')]: m.history.colonyStore(campaignId, 'b2').store }
  const io = { file: (name) => ({ store: stores[name] || {} }) }
  const campaign = { id: campaignId, branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { t: 2 } }, b3: { id: 'b3', parent: 'b2', fork: { t: 2 } } } }

  assert.deepEqual(stores[named('b2')].races, {})
  assert.deepEqual(m.colony.colonyBase(io, campaign, 'b2'), stores[named('b2')])
  assert.deepEqual(m.colony.colonySeed(io, campaign, 'b2', 2), {})
  assert.deepEqual(m.colony.colonyBase(io, campaign, 'b3'), {})
  assert.equal(m.colony.colonyForkFile(io, campaign, 'b2'), null)
  assert.equal(m.colony.colonyForkFile(io, campaign, 'b3'), null)
  assert.deepEqual(TIMES(m.colony.colonyForkFile(io, { ...campaign, branches: { ...campaign.branches, b4: { id: 'b4', parent: 'b1', fork: { t: 1 } } } }, 'b4').races[7]), [1])
})

const previewOf = (p, data) => instantiate(p, { $store: { getters: { config: { get: (_key, fallback) => fallback }, historyRecorded: true, 'history/campaign': { campaignId: 'c1', branchId: 'b1', generation: 1 } }, state: { history: { revision: 0, captures: 0 } } }, GameID: 1, RaceID: 7, data: { retentionPick: 'compact', gameHistory: { races: { 7: { snapshots: [{ t: 1 }] } } }, ...data } }).retentionChange.text

check('previewcolonies', 'the retention change the page shows counts the colony series of the shown branch beside the empire series, in words that are true of both, and says when they could not be read instead of leaving them out', 'page', ({ p }) => {
  const series = (length) => ({ columns: [], races: { 7: { snapshots: Array.from({ length }, (_, index) => ({ t: index + 1 })) } } })
  const none = previewOf(p, { colonyRecord: { file: null, error: '' } })
  const over = previewOf(p, { colonyRecord: { file: series(666), error: '' } })
  const under = previewOf(p, { colonyRecord: { file: series(10), error: '' } })
  const both = previewOf(p, { colonyRecord: { file: series(666), error: '' }, gameHistory: series(700) })
  const unread = previewOf(p, { colonyRecord: { file: null, error: 'the file is damaged' } })

  assert.ok(none.includes('No series in this branch holds as many as 500 samples, so the next save thins nothing.') && !none.includes('colony series'), none)
  assert.ok(!over.includes('thins nothing') && over.includes('No series of the empire history in this branch holds as many as 500 samples, so the next save thins none of them.') && over.includes('The next save thins 1 of the 1 colony series of this branch to at most 500 samples and discards up to'), over)
  assert.ok(under.includes('so the next save thins nothing.') && under.includes('No colony series of this branch holds as many as 500 samples, so none of them is thinned.'), under)
  assert.ok(both.includes('The next save thins 1 of the 1 series in this branch') && both.includes('The next save thins 1 of the 1 colony series of this branch'), both)
  assert.ok(unread.includes('The colony series of this branch could not be read (the file is damaged), so whether they are thinned is not shown.') && unread.includes('thins nothing'), unread)
})

check('nochoice', 'with nothing chosen a pass issues no colony statement and writes no colony file, and the empire file is the one a pass with colonies chosen writes', 'single', ({ r }) => {
  assert.equal(statementsOfColonies(r.plain.log).length, 0)
  assert.equal(r.plain.colonyWrites, 0)
  assert.deepEqual(r.plain.names, [])
  assert.equal(JSON.stringify(r.first.branch), JSON.stringify(r.plain.branch))
})

check('statement', 'a choice adds exactly one statement to the pass, in the one read transaction, and the pass reports no failure', 'single', ({ r }) => {
  assert.equal(r.first.statements, 1)
  assert.equal(r.first.run.failed.length, 0)
  assert.equal(r.first.run.superseded, false)
})

check('figures', 'the observed colonies hold the figures SQL written apart from the utility reads, rounded as the empire snapshot rounds, and stamped with the game time and increments of the save', 'single', ({ r }) => {
  const [snapshot] = r.first.series.races[784].snapshots
  const chain = r.first.branch.races[784].snapshots[0].chain

  assert.equal(r.first.series.races[784].snapshots.length, 1)
  assert.equal(snapshot.t, r.t)
  assert.equal(snapshot.n, chain.n)
  assert.deepEqual(stateOf(snapshot, r.biggest.PopulationID), expectedRow(r.biggest))
  assert.deepEqual(stateOf(snapshot, r.empty.PopulationID), expectedRow(r.empty))
  assert.ok(stateOf(snapshot, r.empty.PopulationID).slice(2).every((value) => value === 0), 'a colony that holds nothing is observed as 0')
  assert.equal(snapshot.d, r.first.series.races[784].snapshots[0].d)
})

check('fates', 'in one pass a colony another race holds, one on another body, and one the save does not have are not read as colonies with stocks: no value is a 0', 'single', ({ r }) => {
  const [snapshot] = r.first.series.races[784].snapshots

  assert.deepEqual(stateOf(snapshot, r.another.PopulationID), [r.another.PopulationID, 2, r.another.RaceID])
  assert.equal(stateOf(snapshot, r.entries[3].id)[1], 3)
  assert.equal(stateOf(snapshot, r.entries[3].id).length, 2)
  assert.deepEqual(stateOf(snapshot, r.unseen), [r.unseen, 1])
})

check('firstpoint', 'the first snapshot of a colony is the save open when it was chosen, at the game time that was stamped, and no snapshot is older than it', 'single', ({ r }) => {
  const [snapshot] = r.first.series.races[784].snapshots

  assert.equal(snapshot.t, r.entries[0].since)
  assert.ok(r.first.series.races[784].snapshots.every((entry) => entry.t >= Math.min(...r.entries.map((e) => e.since))))
})

check('order', 'the empire file is written first and the colony file after it, each whole', 'single', ({ r }) => {
  const names = r.first.order.filter((name) => name.startsWith(`file:campaign-${r.campaignId}-b1`))

  assert.deepEqual(names, [`file:campaign-${r.campaignId}-b1`, `file:campaign-${r.campaignId}-b1-colonies`])
})

check('repeat', 'reading the same save again, in the same run or after a restart, adds no snapshot and writes nothing', 'single', ({ r }) => {
  assert.equal(r.afterFirst, 1)
  assert.equal(r.afterRepeat.writes, 1)
  assert.equal(r.afterRestart.writes, 1)
  assert.equal(r.afterRepeat.series.races[784].snapshots.length, 1)
  assert.deepEqual(r.afterRestart.series, r.first.series)
})

check('failed', 'a failed colony read leaves every chosen colony not read, with no value, fails nothing, and leaves the empire file as a good read writes it', 'single', ({ r }) => {
  const [snapshot] = r.failed.series.races[784].snapshots

  assert.equal(r.failed.run.failed.length, 0)
  assert.ok(r.failed.run.recorded > 0)
  assert.deepEqual(snapshot.colonies, r.entries.map((entry) => [entry.id, 4]).sort((a, b) => a[0] - b[0]))
  assert.equal(JSON.stringify(r.failed.branch), JSON.stringify(r.plain.branch))
})

check('notzero', 'a colony not read is filled in by a good read of the same save, and a failed read of the same save over observations erases none', 'single', ({ r }) => {
  const [filled] = r.filled.races[784].snapshots

  assert.deepEqual(filled.colonies, r.first.series.races[784].snapshots[0].colonies)
  assert.equal(filled.revised, undefined)
  assert.deepEqual(r.erased.after, r.erased.kept)
})

check('idle', 'a colony dropped before the save, chosen after it, or chosen under no campaign is not read and nothing is written', 'single', ({ r }) => {
  assert.equal(r.idle.statements, 0)
  assert.equal(r.idle.writes, 0)
})

check('superseded', 'a pass replaced at any of its checks writes nothing after that, keeps the newer snapshot already stored, and never half writes the colony file', 'single', ({ r }) => {
  assert.ok(r.guards >= 3, `${r.guards} checks`)
  assert.equal(r.guards, r.unchangedGuards + 1, 'the colony write is asked about once more than a pass that writes none')

  r.superseded.forEach((run) => {
    assert.equal(run.afterCut, 0, `a write after the pass was replaced (allowed ${run.allowed})`)
    assert.ok(run.series && run.series.some((snapshot) => snapshot.t === r.later.t && snapshot.d === r.later.d), `the newer snapshot is kept (allowed ${run.allowed})`)
    assert.ok(run.series.every((snapshot, index) => index === 0 || snapshot.t > run.series[index - 1].t), 'in time order')
    assert.ok(run.series.length === 1 || run.series.some((snapshot) => snapshot.t === r.t), 'either whole or untouched')
  })

  assert.ok(r.superseded.some((run) => run.superseded && run.wrote === 0), 'a pass was cut before the colony file')
  assert.ok(r.superseded.some((run) => run.wrote === 1 && run.series.length === 2), 'a pass that was not cut wrote its snapshot')
})

check('profile', 'the retention profile in force caps the colony series: a series at the cap gains one snapshot and is thinned with its first and latest kept', 'single', ({ r }) => {
  assert.equal(r.capped.held.length, 500)
  assert.ok(r.capped.snapshots.length <= 500)
  assert.ok(r.capped.snapshots.length < 501)
  assert.equal(r.capped.snapshots[0].t, 1000)
  assert.equal(r.capped.snapshots[r.capped.snapshots.length - 1].t, r.t)
  assert.ok(r.capped.thinning.passes >= 1)
})

const CHAIN_SERIES = (file) => file.races[CHAIN[0].RaceID].snapshots

check('forkpoint', 'the save that parts from the first branch at B is a fork of it: cut at the last whole 64 increments the two ledgers share, before B\'s own save, the second branch told from the first, and the saves before it continue the first', 'chain', ({ k }) => {
  const parting = partingOf(k.ledgers.C1, k.ledgers.C2)
  const { branches } = k.fork.registry

  assert.deepEqual(k.relations, { A: 'new', B: 'continues', C1: 'continues', C2: 'fork' })
  assert.equal(k.fork.forked, true)
  assert.equal(k.fork.branchId, 'b2')
  assert.deepEqual(Object.keys(branches), ['b1', 'b2'])
  assert.equal(branches.b2.parent, 'b1')
  assert.ok(parting.common > k.ledgers.B.length && parting.n % STEP === 0 && parting.n < k.ledgers.B.length && parting.common - parting.n < STEP, `${parting.common} increments in common, ${k.ledgers.B.length} in B, cut at ${parting.n}`)
  assert.deepEqual([branches.b2.fork.n, branches.b2.fork.t], [parting.n, parting.t])
  assert.ok(branches.b2.fork.t < k.times.B, 'the cut falls before the save of B')
  assert.deepEqual(k.added, { B: [k.ids.rantz], C2: [k.ids.virginis] })
})

check('forkseed', 'the fork\'s colony series is the first branch\'s snapshots up to the cut and none later, then its own save\'s: the saves B and C1 are not in it, and the first branch is as it was before the fork', 'chain', ({ k }) => {
  const parent = CHAIN_SERIES(k.parent.series)
  const cut = k.fork.registry.branches.b2.fork.t
  const seeded = parent.filter((snapshot) => snapshot.t <= cut)
  const child = CHAIN_SERIES(k.fork.b2)

  assert.deepEqual(parent.map((snapshot) => snapshot.t), [k.times.A, k.times.B, k.times.C1])
  assert.ok(seeded.length > 0 && seeded.length < parent.length, `${seeded.length} of ${parent.length} stay at or before ${cut}`)
  assert.deepEqual(child.slice(0, seeded.length), seeded)
  assert.deepEqual(child.slice(seeded.length).map((snapshot) => snapshot.t), [k.times.C2])
  assert.ok(!child.some((snapshot) => snapshot.t === k.times.B || snapshot.t === k.times.C1), 'neither B nor C1 is the fork\'s')
  assert.deepEqual(k.fork.b1, k.parent.series)
})

check('forkfigures', 'each branch holds the figures of its own saves, as SQL written here reads them: the colony both followed reads alike up to the cut and differently at the two ends, a colony chosen on the second branch is in it alone', 'chain', ({ k }) => {
  const earthOf = (letter) => expectedRow(k.rows[letter].find((row) => row.PopulationID === k.ids.earth))
  const first = CHAIN_SERIES(k.chosen.b1)
  const second = CHAIN_SERIES(k.chosen.b2)
  const at = (snapshots, letter) => snapshots.find((snapshot) => snapshot.t === k.times[letter])

  ;['A', 'B', 'C1'].forEach((letter) => assert.deepEqual(stateOf(at(first, letter), k.ids.earth), earthOf(letter), `the first branch at ${letter}`))
  ;['A', 'C2'].forEach((letter) => assert.deepEqual(stateOf(at(second, letter), k.ids.earth), earthOf(letter), `the second branch at ${letter}`))
  assert.notDeepEqual(earthOf('C1'), earthOf('C2'), 'the two branches hold two readings of the colony')
  assert.equal(stateOf(at(first, 'A'), k.ids.rantz), undefined, 'a colony has no point before it was chosen')
  assert.deepEqual(stateOf(at(first, 'C1'), k.ids.rantz), expectedRow(k.rows.C1.find((row) => row.PopulationID === k.ids.rantz)))
  assert.deepEqual(stateOf(at(second, 'C2'), k.ids.virginis), expectedRow(k.rows.C2.find((row) => row.PopulationID === k.ids.virginis)))
  assert.ok(!first.some((snapshot) => stateOf(snapshot, k.ids.virginis)), 'the first branch never holds the colony of the second')
})

check('forkreopen', 'the save of the first branch opened again after the fork settles to the first branch, captures nothing, and reads the colony chosen on the other branch as chosen later than itself: no series changes', 'chain', ({ k }) => {
  assert.equal(k.reopened.relation, 'same')
  assert.equal(k.reopened.branchId, 'b1')
  assert.equal(k.reopened.writes, 0)
  assert.deepEqual(k.reopened.b1, k.chosen.b1)
  assert.deepEqual(k.reopened.b2, k.chosen.b2)
})

check('frozen', 'a fork is given its colony series in the pass that creates it, up to the cut and none later, even when no colony is followed any more, and a later clear of the first branch\'s series changes nothing in it', 'chain', ({ k }) => {
  const { branches } = k.stopped.registry
  const parent = CHAIN_SERIES(k.parent.series)
  const seeded = parent.filter((snapshot) => snapshot.t <= branches.b2.fork.t)
  const after = CHAIN_SERIES(k.cleared.b2)

  assert.equal(branches.b2.parent, 'b1')
  assert.equal(branches.b2.coloniesSeeded, true, 'the branch is marked once its seed is written')
  assert.equal(k.stopped.writes, 1, 'the one colony file the pass that makes the fork writes is the fork\'s seed')
  assert.ok(seeded.length > 0 && seeded.length < parent.length)
  assert.deepEqual(CHAIN_SERIES(k.stopped.b2), seeded)
  assert.deepEqual(k.stopped.b1, k.parent.series)
  assert.deepEqual(k.cleared.b1, k.emptyFile)
  assert.deepEqual(after.slice(0, seeded.length), seeded)
  assert.deepEqual(after.slice(seeded.length).map((snapshot) => snapshot.t), [k.times.C2])
  assert.deepEqual(after[after.length - 1].colonies.map((entry) => entry[0]), [k.ids.virginis])
})

// ---------- the mutations ----------

// A planted fault in a copy of a utility, and the checks (by key) it must break.
const MUTATIONS = [
  { name: 'a 51st colony is accepted', file: 'colony-series.js', find: 'export const MAX_COLONIES = 50', replace: 'export const MAX_COLONIES = 51', fails: ['limit'] },
  { name: 'a settings entry with no colony in it counts as a colony chosen', file: 'colony-series.js', find: 'entriesOf(values.historyColonies).length > 0))', replace: 'true))', fails: ['wish'] },
  { name: 'a colony the save does not show is read as a colony with nothing', file: 'colony-series.js', find: 'return [entry.id, COLONY_STATES.GONE]', replace: 'return [entry.id, COLONY_STATES.OBSERVED, ...FIGURES.map(() => 0)]', fails: ['states', 'fates'] },
  { name: 'a failed read is not told from a gone colony', file: 'colony-series.js', find: 'if (read.failed) {', replace: 'if (false) {', fails: ['states', 'failed'] },
  { name: 'a colony another race holds is not told', file: 'colony-series.js', find: 'Number(row.RaceID) !== Number(entry.raceId)) {', replace: 'false) {', fails: ['states', 'fates'] },
  { name: 'a colony on another body is not told', file: 'colony-series.js', find: 'Number(row.SystemBodyID) !== Number(entry.bodyId)) {', replace: 'false) {', fails: ['states', 'fates'] },
  { name: 'a missing value is kept as 0', file: 'colony-series.js', find: 'Math.round(Number(value) * scale) / scale : null)', replace: 'Math.round(Number(value) * scale) / scale : 0)', fails: ['rows'] },
  { name: 'population is rounded to a whole million', file: 'colony-series.js', find: "['population', 'Population', 1000]", replace: "['population', 'Population', 1]", fails: ['rows', 'figures'] },
  { name: 'a colony applies before it was chosen', file: 'colony-series.js', find: 'entry.since <= t && (entry.until', replace: 'true && (entry.until', fails: ['wish', 'idle'] },
  { name: 'a colony applies after it was dropped', file: 'colony-series.js', find: 't <= entry.until))', replace: 'true))', fails: ['wish', 'idle'] },
  { name: 'every campaign is read whether or not it holds the game', file: 'colony-series.js', find: 'campaign.gameIds.includes(GameID))', replace: 'true)', fails: ['wish'] },
  { name: 'the colonies of another campaign are taken as the settled one\'s', file: 'colony-series.js', find: 'wish[campaignId] ? activeAt(wish[campaignId].races[RaceID] || [], t) : []', replace: 'Object.values(wish).flatMap((campaign) => activeAt(campaign.races[RaceID] || [], t))', fails: ['wish'] },
  { name: 'a colony failed read is thrown, so it fails the pass', file: 'colony-series.js', find: 'return { ids, failed: error }', replace: 'throw error', fails: ['failed'] },
  { name: 'the settings are replaced, not changed', file: 'colony-series.js', find: '    putEntries(stored, campaignId, RaceID, written)\n\n    return stored', replace: '    putEntries(stored, campaignId, RaceID, written)\n\n    return { campaign: stored.campaign }', fails: ['settings'] },
  { name: 'the size estimate is 64 bytes a colony', file: 'colony-series.js', find: 'export const COLONY_BYTES = 55', replace: 'export const COLONY_BYTES = 64', fails: ['estimate'] },
  { name: 'a failed read replaces an observation', file: 'colony-series.js', find: '} else if (!(entry[1] === COLONY_STATES.UNAVAILABLE && old[1] !== COLONY_STATES.UNAVAILABLE) && JSON.stringify(old)', replace: '} else if (JSON.stringify(old)', fails: ['failedread', 'notzero'] },
  { name: 'a seed takes the parent\'s later snapshots too', file: 'colony-series.js', find: '(record.snapshots || []).filter((snapshot) => snapshot.t <= t)', replace: '(record.snapshots || []).filter(() => true)', fails: ['seed', 'lineage', 'forkseed', 'frozen'] },
  { name: 'a branch with no file is not seeded', file: 'colony-series.js', find: 'isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, branch.fork.t) : {}', replace: 'isKnownNumber(branch.fork.t) ? {} : {}', fails: ['lineage'] },
  { name: 'a seed does not pass through a parent that has no file', file: 'colony-series.js', find: 'colonySeed(io, campaign, branch.parent, Math.min(t, branch.fork.t))', replace: '{}', fails: ['lineage'] },
  { name: 'an unchanged snapshot is written again', file: 'history.js', find: 'if (next.d === same.d) {', replace: 'if (false) {', fails: ['same', 'repeat', 'forkreopen'] },
  { name: 'a revision is not marked', file: 'history.js', find: 'revised: Boolean(same.revised) || joined.revised', replace: 'revised: false', fails: ['revised'] },
  { name: 'a save on another ledger at the same time is written over', file: 'history.js', find: 'if (same.n !== snapshot.n) {', replace: 'if (false) {', fails: ['timeline'] },
  { name: 'an older save is added at the end', file: 'history.js', find: '[...stored.filter((existing) => existing.t !== snapshot.t), next].sort((a, b) => a.t - b.t), limit)', replace: '[...stored.filter((existing) => existing.t !== snapshot.t), next], limit)', fails: ['older'] },
  { name: 'a colony series is not thinned', file: 'history.js', find: '[...stored.filter((existing) => existing.t !== snapshot.t), next].sort((a, b) => a.t - b.t), limit)', replace: '[...stored.filter((existing) => existing.t !== snapshot.t), next].sort((a, b) => a.t - b.t), 1e9)', fails: ['cap'] },
  { name: 'the recorder does not give the colony series the profile\'s cap', file: 'history.js', find: '{ races: captured }, { limit, now })', replace: '{ races: captured }, { now })', fails: ['profile'] },
  { name: 'the colony file is written without asking whether the pass is current', file: 'history.js', find: '            if (changed) {\n              guard()\n              series.store = file', replace: '            if (changed) {\n              series.store = file', fails: ['superseded'] },
  { name: 'the colony file is written before the empire file', file: 'history.js', find: '          store.store = mergeGame(store.store, { gameName: observation.gameName, races: taken, intel }, { limit: retentionOfSettings(storage.settings).cap, now })', replace: '          colonyFirst(storage, resolution, wish, taken, observation, retentionOfSettings(storage.settings).cap, now)\n          store.store = mergeGame(store.store, { gameName: observation.gameName, races: taken, intel }, { limit: retentionOfSettings(storage.settings).cap, now })', fails: ['order'], prelude: 'const colonyFirst = (storage, resolution, wish, taken, observation, limit, now) => { const captured = taken.filter(({ colonyRead }) => colonyRead).flatMap(({ RaceID, snapshot, colonyRead }) => { const entries = entriesAt(wish, resolution.campaignId, RaceID, snapshot.t); return entries.length ? [{ RaceID, snapshot: colonySnapshot({ t: snapshot.t, n: observation.count, colonies: colonyRows(entries, colonyRead) }) }] : [] }); if (captured.length) { storage.file(colonyFileName(resolution.campaignId, resolution.branchId)).store = mergeColonies({}, { races: captured }, { limit, now }).file } }\n\nconst randomId = () => globalThis.crypto.randomUUID()' },
  { name: 'colonies are read whether or not any is chosen', file: 'history.js', find: 'return ids.length ? readColonies(database, { GameID, ids }, options) : null', replace: 'return readColonies(database, { GameID, ids: ids.length ? ids : [0] }, options)', fails: ['nochoice', 'idle'] },
  { name: 'clearing a history leaves its colony series', file: 'history.js', find: 'planned(colonyStore(campaignId, branchId), seriesFrom),', replace: 'null,', fails: ['clear'] },
  { name: 'a cleared colony file is seeded from its parent again', file: 'colony-series.js', find: 'if (written(stored)) {\n    return stored', replace: 'if (hasRaces(stored)) {\n    return stored', fails: ['cleared'] },
  { name: 'a seed through a cleared branch reaches the parent\'s samples', file: 'colony-series.js', find: 'if (written(file)) {\n    return colonyUpTo(file, t)', replace: 'if (hasRaces(file)) {\n    return colonyUpTo(file, t)', fails: ['cleared'] },
  { name: 'a fork is given a colony file even when its parent holds no series', file: 'colony-series.js', find: 'return hasRaces(seed) ? seed : null', replace: 'return seed', fails: ['cleared'] },
  { name: 'a branch seeded empty is seeded from its parent at its first colony write', file: 'colony-series.js', find: 'return branch && !seeded(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, branch.fork.t) : {}', replace: 'return branch && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, branch.fork.t) : {}', fails: ['lineage'] },
  { name: 'a branch seeded empty is seeded from its parent through a chain', file: 'colony-series.js', find: 'return branch && !seeded(branch) && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', replace: 'return branch && branch.parent && branch.fork && isKnownNumber(branch.fork.t) ? colonySeed(io, campaign, branch.parent, Math.min(t, branch.fork.t)) : {}', fails: ['lineage'] },
  { name: 'a fork is not given its colony series when it is created', file: 'history.js', find: 'if (resolution.forked) {', replace: 'if (false) {', fails: ['frozen'] },
  { name: 'a fork is not marked once it was given its colony seed', file: 'history.js', find: 'campaign.branches[resolution.branchId].coloniesSeeded = true', replace: 'void campaign', fails: ['frozen'] },
  { name: 'a fork is cut at the game time of the save that made it', file: 'campaign.js', find: 'const forkTime = found.common ? opened.times[found.common / STEP - 1] : null', replace: 'const forkTime = found.common ? opened.t : null', fails: ['forkpoint', 'forkseed'] },
  { name: 'the retention change of the page leaves the colony file out', page: replacing('const colonyHeld = this.colonyRecord.file ? seriesOverCap(this.colonyRecord.file, picked.cap) : null', 'const colonyHeld = null'), fails: ['previewcolonies'] },
  { name: 'the retention change of the page measures the colony series against another cap', page: replacing('seriesOverCap(this.colonyRecord.file, picked.cap)', 'seriesOverCap(this.colonyRecord.file, 1)'), fails: ['previewcolonies'] },
  { name: 'the retention change of the page says the empire series thin nothing when only the colony series thin', page: replacing('const none = colonyHeld && colonyHeld.next.thins ?', 'const none = false ?'), fails: ['previewcolonies'] },
  { name: 'the retention change of the page does not say when the colony series could not be read', page: replacing('const colonies = this.colonyRecord.error ?', 'const colonies = false ?'), fails: ['previewcolonies'] },
]

// ---------- running ----------

let failures = 0
let total = 0
let number = 0

const show = (label, result, detail = '') => {
  const ok = result === true

  total++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const memo = (work) => {
  let held = null

  return () => {
    held = held || work()

    return held
  }
}

// The context a check runs in for one set of modules; a scenario is run once, on its first use.
const contextOf = (m, { mutate = null } = {}) => {
  const scenarios = { single: memo(() => single(m)), chain: memo(() => chain(m)), page: memo(() => loadPage('pages/history', { stubs: STUBS, mutate })) }

  return {
    run: async ({ needs, run }) => {
      const r = needs === 'single' ? await scenarios.single() : null
      const k = needs === 'chain' ? await scenarios.chain() : null
      const p = needs === 'page' ? await scenarios.page() : null

      return run({ m, r, k, p })
    },
  }
}

const outcomeOf = async (context, entry) => {
  try {
    await context.run(entry)

    return true
  } catch (error) {
    return String((error && error.stack) || error).split('\n').slice(0, 8).join('\n         ')
  }
}

// The text of the module a mutation changes, by the name the loader knows it by, with the change made (and the prelude put in place of the random id): the others are read from the folder, so no copy of it is made.
const planted = (mutation) => {
  const text = patched(mutation.file, fs.readFileSync(path.join(utilitiesDirectory, mutation.file), 'utf8'), mutation.find, mutation.replace)
  const from = 'const randomId = () => globalThis.crypto.randomUUID()'

  if (mutation.prelude && text.split(from).length !== 2) {
    throw new Error(`The prelude of ${mutation.name} does not apply exactly once`)
  }

  return { [mutation.file.replace(/\.js$/, '')]: mutation.prelude ? text.replace(from, () => mutation.prelude) : text }
}

// Whether a check reads a save that is not here: its group is skipped and says so.
const unread = (entry) => (entry.needs === 'single' && !fs.existsSync(MODDED.file)) || (entry.needs === 'chain' && !CHAIN_THERE)

// What the baseline and each mutation print, as entries a child hands to the parent: a line of text, or the arguments of `show`.
const baselineEntries = async () => {
  const real = await loadModules()
  const context = contextOf(real)
  const entries = []

  if (!fs.existsSync(MODDED.file)) {
    entries.push({ log: `  skip   ${MODDED.file} is not here, so the single group is not run` })
  }

  if (!CHAIN_THERE) {
    entries.push({ log: '  skip   a save of the played campaign is not here, so the chain group is not run' })
  }

  entries.push({ log: 'The colony series' })

  for (const entry of checks) {
    number++

    if (unread(entry)) {
      continue
    }

    const began = Date.now()
    const outcome = await outcomeOf(context, entry)

    entries.push({ show: [`${number}. ${entry.key}: ${entry.name}`, outcome, entry.needs === 'unit' ? '' : `${((Date.now() - began) / 1000).toFixed(1)} s`] })
  }

  return entries
}

const mutationEntries = async (mutation) => {
  const began = Date.now()

  try {
    const mutant = contextOf(await loadModules(mutation.page ? {} : planted(mutation)), { mutate: mutation.page || null })
    const named = checks.filter((entry) => mutation.fails.includes(entry.key))
    const absent = mutation.fails.filter((key) => !named.some((entry) => entry.key === key))
    const missed = []
    const skipped = []

    for (const entry of named) {
      if (unread(entry)) {
        skipped.push(entry.key)
        continue
      }

      const outcome = await outcomeOf(mutant, entry)

      if (outcome === true) {
        missed.push(entry.key)
      }
    }

    const ran = named.length - skipped.length

    return [{ show: [`mutation caught: ${mutation.name}`, absent.length ? `no check is keyed ${absent.join(', ')}` : !ran ? `none of the named checks could run (${skipped.join(', ')}), so nothing is shown` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${mutation.fails.join(', ')}; ${((Date.now() - began) / 1000).toFixed(1)} s`] }]
  } catch (error) {
    return [{ show: [`mutation caught: ${mutation.name}`, `does not load: ${error.message}`] }]
  }
}

const RESULT = 'RESULT '

// A child runs the baseline (`--baseline`) or some mutations in turn (`--mutants=<i>,<i>`) in a process of its own, so no chunk shares the module state, the stores or the scenarios of another, and prints its entries as JSON on its last line: those of the baseline, or the list of the entries of each mutation.
const childMain = async () => {
  const given = process.argv.find((argument) => argument.startsWith('--mutants='))
  let entries = null

  if (given) {
    entries = []

    for (const index of given.slice('--mutants='.length).split(',')) {
      entries.push(await mutationEntries(MUTATIONS[Number(index)]))
    }
  } else {
    entries = await baselineEntries()
  }

  process.stdout.write(`${RESULT}${JSON.stringify(entries)}\n`, () => process.exit(0))
}

const main = async () => {
  if (process.argv.includes('--baseline') || process.argv.some((argument) => argument.startsWith('--mutants='))) {
    return childMain()
  }

  const mutations = process.argv.includes('--no-mutations') ? [] : MUTATIONS
  const chunks = chunksOf(mutations.length)
  const items = [['--baseline'], ...chunks.map((list) => [`--mutants=${list.join(',')}`])]
  const outcomes = await inParallel(items, async (args) => lastJson(await runChild(__filename, args), RESULT))
  const replay = (entries) => entries.forEach((entry) => (entry.log !== undefined ? console.log(entry.log) : show(...entry.show)))

  if (outcomes[0] instanceof Error) {
    throw outcomes[0]
  }

  replay(outcomes[0])

  if (mutations.length) {
    console.log('\nMutations: each must break the checks it names')
  }

  spread(chunks, outcomes.slice(1)).forEach((outcome, index) => (outcome instanceof Error ? show(`mutation caught: ${mutations[index].name}`, `does not run: ${outcome.message}`) : replay(outcome)))

  console.log(`\n${total - failures} of ${total} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
