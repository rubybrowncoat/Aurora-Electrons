/*
  Checks the campaign identity of the app's own records (utilities/campaign.js, campaign-attach.js and the recorder in utilities/history.js): which campaign and branch an opened save belongs to, and what happens to the history and the race-owned settings under it.

  node scripts/check-campaigns.js [--no-mutations]

  Everything runs on in-memory installations (a history store, a registry, a migration record and a settings store, each a plain JSON value) and on small synthetic saves that answer the recorder's reads: a game, the lowest-numbered systems, and an increment ledger that is one chain a later save extends, an older save is a prefix of, and a replayed save forks from. No Electron and no network are needed; the two real saves (AuroraDB.db, saves/AuroraDB_271_skoormit_saved.db) are opened read-only for the last group when they are present, and are skipped with a note when they are not.

  Groups:
  - matrix: the fixture cases of the identity evidence (AE-033-01): independent campaigns that share a GameID and a name stay apart with their histories, warning state and map groups; a rename, a move, a copy and a rewind keep one campaign; a save replayed from an earlier point is a branch seeded up to the fork; a short or thin record is never merged on a guess, and the player's answer (keep apart, attach to the same branch, attach as a new branch) is kept;
  - migration: a legacy history (`game-<GameID>`) and its settings (`game.<GameID>`) become a campaign only when nothing contradicts it and are otherwise left unattached in place; the originals are never changed; a migration interrupted at every write, and a recovery interrupted at every write, ends with one campaign and the same history as an uninterrupted one; a requested rollback restores the pre-migration state and refuses a damaged original;
  - guards: a pass that has been replaced by a newer save writes nothing after the replacement, at every point it could be replaced;
  - review: the regressions of the review of this task: a path never joins a save whose ledger contradicts the campaign, an answered path outranks the ranking, an attach carries the evidence and is idempotent, a damaged registry is reported and left alone, a resolution of one copy of a save settles nothing on the next (the store module), the recording owner of a database (windows over one fake storage and Web Locks: a window of another database records at the same time, a second window of one database writes nothing and takes over when the owner closes or moves to another database), the registry lock around every settle step, a save read again against the tips another window stored, the routing of a second launch to the window of its database (src/main/launch.js), and compare-before-write;
  - mutations: each of a list of deliberate breakages of the sources (trimming the past on a rewind, keying history by GameID, dropping the generation guard, skipping the hash check of an original, accepting any ledger, ignoring conflicting systems, committing a migration first, changing the legacy file, identifying by name, seeding a branch with the whole parent, overwriting settings on an attach, ignoring a contradicting ledger, a damaged registry read as empty, a resolution kept across copies, a tab that is not the owner writing, one lock for every database, a recorder outside the registry lock, a launch that ignores the database, and more) is applied to a copy of the sources and must make the checks named for it fail.

  Any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')

const repo = path.resolve(__dirname, '..')
const src = path.join(repo, 'src')

// The packages the utilities import. The stores are given to the recorder by the checks, so electron-store only has to exist.
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

// The modules the checks load, from `base` (the source, or a copy of the parts of it a mutation breaks): the identity utilities and the store module that keeps the settled campaigns.
let tabCount = 0

const loadModules = async (base) => {
  const names = ['campaign', 'campaign-attach', 'history'].map((name) => `renderer/utilities/${name}`)
  const loaded = await loadUtilities([...names, 'renderer/store/history', 'renderer/mixins/persisted-view', 'renderer/utilities/remembered-views', 'renderer/utilities/preferences'], { stubs: STUBS, directory: base })
  // A tab of the web build: its own copy of the modules (so its own recording ownership), with the web build's stand-in for electron-store over the global `localStorage`. Modules load from a data URL of their source, so two tabs would share one instance unless the source differs: each tab's copy of the ownership module ends in its own comment.
  const tab = async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-tab-'))

    fs.cpSync(path.join(base, 'renderer', 'utilities'), path.join(copy, 'renderer', 'utilities'), { recursive: true })
    fs.mkdirSync(path.join(copy, 'renderer', 'plugins'), { recursive: true })
    fs.copyFileSync(path.join(base, 'renderer', 'plugins', 'history.js'), path.join(copy, 'renderer', 'plugins', 'history.js'))
    fs.appendFileSync(path.join(copy, 'renderer', 'utilities', 'recording-owner.js'), `\n// tab ${++tabCount}\n`)

    const shimSource = fs.readFileSync(path.join(repo, 'scripts', 'web', 'shims', 'electron-store.js'), 'utf8')
    const own = await loadUtilities([...['campaign', 'campaign-attach', 'history', 'recording-owner'].map((name) => `renderer/utilities/${name}`), 'renderer/plugins/history'], { stubs: { ...STUBS, 'electron-store': shimSource }, directory: copy })

    fs.rmSync(copy, { recursive: true, force: true })

    return { campaign: own['renderer/utilities/campaign'], attach: own['renderer/utilities/campaign-attach'], history: own['renderer/utilities/history'], owner: own['renderer/utilities/recording-owner'], plugin: own['renderer/plugins/history'] }
  }
  // The web build's stand-in for electron-store, over the global `localStorage` the check gives it: two tabs are two stores over one storage.
  const shim = await loadUtilities(['../scripts/web/shims/electron-store'], { directory: src })
  // The launch routing of the main process, which imports nothing of the app.
  const launch = await loadUtilities(['main/launch', 'main/store-host', 'preload/store-client'], { directory: base })

  return { campaign: loaded[names[0]], 'campaign-attach': loaded[names[1]], history: loaded[names[2]], storeHistory: loaded['renderer/store/history'], persistedView: loaded['renderer/mixins/persisted-view'], rememberedViews: loaded['renderer/utilities/remembered-views'], webStore: shim['../scripts/web/shims/electron-store'], launch: launch['main/launch'], storeHost: launch['main/store-host'], storeClient: launch['preload/store-client'], preferences: loaded['renderer/utilities/preferences'], tab }
}

// The parts of the source a mutation may break, copied to the same layout under `copy`.
const copySources = (copy) => {
  fs.cpSync(path.join(src, 'renderer', 'utilities'), path.join(copy, 'renderer', 'utilities'), { recursive: true })
  fs.mkdirSync(path.join(copy, 'renderer', 'plugins'), { recursive: true })
  fs.copyFileSync(path.join(src, 'renderer', 'plugins', 'history.js'), path.join(copy, 'renderer', 'plugins', 'history.js'))
  fs.mkdirSync(path.join(copy, 'renderer', 'store'), { recursive: true })

  fs.copyFileSync(path.join(src, 'renderer', 'store', 'history.js'), path.join(copy, 'renderer', 'store', 'history.js'))

  fs.mkdirSync(path.join(copy, 'main'), { recursive: true })
  fs.copyFileSync(path.join(src, 'main', 'launch.js'), path.join(copy, 'main', 'launch.js'))
  fs.copyFileSync(path.join(src, 'main', 'store-host.js'), path.join(copy, 'main', 'store-host.js'))
  fs.mkdirSync(path.join(copy, 'preload'), { recursive: true })
  fs.copyFileSync(path.join(src, 'preload', 'store-client.js'), path.join(copy, 'preload', 'store-client.js'))

  fs.mkdirSync(path.join(copy, 'renderer', 'mixins'), { recursive: true })
  fs.copyFileSync(path.join(src, 'renderer', 'mixins', 'persisted-view.js'), path.join(copy, 'renderer', 'mixins', 'persisted-view.js'))
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const STEP = 64

// ---- Installations and synthetic saves --------------------------------------------------------------------------------

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is. `hooks.beforeWrite(name, index)` can throw to stand for a full disk; `writes` is every write in order.
const installation = () => {
  const files = new Map()
  const writes = []
  const hooks = { beforeWrite: null }
  const store = (name) => ({
    get store() {
      return clone(files.get(name)) || {}
    },
    set store(value) {
      if (hooks.beforeWrite) {
        hooks.beforeWrite(name, writes.length)
      }

      files.set(name, clone(value))
      writes.push(name)
    },
    // A read-change-write that is made again over what is stored when another write came between, as the window's store does (src/preload/store-client.js).
    update(change) {
      for (;;) {
        const base = JSON.stringify(this.store)
        const next = change(JSON.parse(base))

        if (JSON.stringify(this.store) === base) {
          this.store = next

          return next
        }
      }
    },
  })
  let counter = 0
  let clock = 1000000
  const inst = { files, writes, hooks, newId: () => `c${++counter}`, now: () => ++clock, io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), file: (name) => store(`file:${name}`) } }

  return inst
}

const registryOf = (inst) => ({ campaigns: {}, pool: {}, ...(clone(inst.files.get('registry')) || {}) })

const activeCampaigns = (inst) => Object.values(registryOf(inst).campaigns).filter((campaign) => !campaign.mergedInto)

const fileOf = (inst, campaignId, branchId = 'b1') => clone(inst.files.get(`file:campaign-${campaignId}-${branchId}`)) || {}

const timesOf = (inst, campaignId, branchId = 'b1', RaceID = 7) => {
  const file = fileOf(inst, campaignId, branchId)

  return file.races && file.races[RaceID] ? file.races[RaceID].snapshots.map((snapshot) => snapshot.t) : []
}

const settingsOf = (inst) => clone(inst.files.get('settings')) || {}

const unitsOf = (inst) => (clone(inst.files.get('migration')) || {}).units || {}

const everything = (inst) => JSON.stringify([...inst.files].sort(([a], [b]) => (a < b ? -1 : 1)))

// A save of one game. The ledger's row `i` has IncrementID `i` and a game time of `i * 5` shifted by the `template` of the campaign (two campaigns never share a ledger) and, after the point `fork.at`, by `fork.salt` (a save replayed from there). The anchor is `anchorCount` systems whose ages depend on `anchorKey` (the campaign's template, unless given).
const saveOf = ({ GameID = 1, name = 'Campaign', template = 1, anchorKey = template, n, fork = null, anchorCount = 10, races = [7], held = null }) => {
  const ledger = Array.from({ length: n }, (_, index) => {
    const id = index + 1

    return { IncrementID: id, GameTime: id * 5 + template * 1000003 + (fork && id > fork.at ? fork.salt : 0) }
  })
  const t = n ? ledger[n - 1].GameTime : template * 1000003
  const anchor = Array.from({ length: anchorCount }, (_, index) => ({ SystemID: 100 + index, SystemNumber: index + 1, Age: Number((1 + anchorKey / 100 + index / 1000).toFixed(4)), AbundanceModifier: 1, Stars: 1, DustDensity: 1, SystemTypeID: 1 }))
  const state = { inTransaction: false }

  return {
    GameID,
    t,
    state,
    transaction: async (work) => {
      state.inTransaction = true

      try {
        const result = await work({ id: 'transaction' })

        if (held) {
          await held
        }

        return result
      } finally {
        state.inTransaction = false
      }
    },
    query: async (sql) => {
      if (sql.startsWith('select FCT_Race.GameID')) {
        return [races.map((RaceID) => ({ GameID, RaceID, NPR: 0, SpecialNPRID: 0 }))]
      }

      if (sql.startsWith('select FCT_Game.GameID')) {
        return [[{ GameID, GameName: name, GameTime: t }]]
      }

      if (sql.startsWith('select FCT_System.SystemID')) {
        return [anchor]
      }

      if (sql.startsWith('select FCT_Increments.IncrementID')) {
        return [ledger]
      }

      if (sql.startsWith('select FCT_Game.GameTime')) {
        return [[{ GameTime: t, GameName: name, RaceTitle: 'Race', WealthPoints: 0, AnnualWealth: 0 }]]
      }

      if (sql.startsWith('select (select case when count(FCT_TechSystem')) {
        return [[{ Research: 0, Systems: 0, Commanders: 0 }]]
      }

      return [[]]
    },
  }
}

// What a legacy history file of game 1 holds, and a legacy settings subtree.
const legacyFile = (times, { gameName = 'Campaign', systems = null } = {}) => ({ gameName, races: { 7: { raceName: 'Race', npr: false, snapshots: times.map((t, index) => ({ t, population: t, ...(systems ? { systems: systems[index] } : {}) })) } }, intel: {} })

const legacySettings = () => ({ race: { 7: { warningsMuted: { items: { idleFleets: [1, 2] } }, mapPinned: [10, 11], mapGroups: { 1: 'north' } } } })

const seedLegacy = (inst, { file = legacyFile([100, 200]), settings = legacySettings() } = {}) => {
  if (file) {
    inst.files.set('file:game-1', clone(file))
  }

  if (settings) {
    inst.files.set('settings', { game: { 1: clone(settings) }, other: { kept: true } })
  }
}

// ---- The suite --------------------------------------------------------------------------------------------------------

// Every check is `{ name, run(m) }` over the loaded modules. A failed assertion is the check failing.
const defineSuite = (m) => {
  const cases = []
  const assert = require('./lib/bounded-assert')
  const test = (group, name, run) => cases.push({ group, name, run })
  const { campaign, history } = m
  const attachModule = m['campaign-attach']
  const { raceKeyPrefix } = campaign

  // One pass of the recorder on `inst` over `save`; resolves to { result, resolution } where `resolution` is what the recorder settled the save's game to.
  const pass = async (inst, save, { path = 'C:/saves/a.db', isCurrent = () => true } = {}) => {
    const resolutions = {}
    const result = await history.recordHistory(save, { storage: inst.io, path, now: inst.now, newId: inst.newId, isCurrent, onResolved: (GameID, resolution) => { resolutions[GameID] = resolution } })

    return { result, resolution: resolutions[save.GameID] || null }
  }

  const keep = (inst, campaignId, RaceID, key, value) => {
    const settings = settingsOf(inst)

    settings.campaign = settings.campaign || {}
    settings.campaign[campaignId] = settings.campaign[campaignId] || {}
    settings.campaign[campaignId].race = settings.campaign[campaignId].race || {}
    settings.campaign[campaignId].race[RaceID] = { ...settings.campaign[campaignId].race[RaceID], [key]: value }
    inst.files.set('settings', settings)
  }

  const kept = (inst, campaignId, RaceID, key) => {
    const settings = settingsOf(inst)

    return settings.campaign && settings.campaign[campaignId] && settings.campaign[campaignId].race && settings.campaign[campaignId].race[RaceID] ? settings.campaign[campaignId].race[RaceID][key] : undefined
  }

  // ---- matrix ----
  test('matrix', 'the first save of a game is a new campaign with a first branch that holds its snapshot, and the next save of it continues the same one', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 100 }))

    assert.equal(first.resolution.created, true)
    assert.equal(first.resolution.relation, 'new')
    assert.equal(first.resolution.branchId, 'b1')
    assert.deepEqual(first.resolution.pending, [])

    const second = await pass(inst, saveOf({ n: 150 }))

    assert.equal(second.resolution.campaignId, first.resolution.campaignId)
    assert.equal(second.resolution.relation, 'continues')
    assert.equal(second.resolution.created, false)
    assert.equal(activeCampaigns(inst).length, 1)
    assert.deepEqual(timesOf(inst, first.resolution.campaignId), [saveOf({ n: 100 }).t, saveOf({ n: 150 }).t])
  })

  test('matrix', 'four independent campaigns of one GameID and one name keep separate histories', async () => {
    const inst = installation()
    const ids = {}

    for (const template of [1, 2, 3, 4]) {
      ids[template] = (await pass(inst, saveOf({ template, n: 100 }))).resolution.campaignId
    }

    for (const template of [1, 2, 3, 4]) {
      const again = await pass(inst, saveOf({ template, n: 140 }))

      assert.equal(again.resolution.campaignId, ids[template], `campaign ${template} was not recognised again`)
      assert.equal(again.resolution.relation, 'continues')
    }

    assert.equal(new Set(Object.values(ids)).size, 4)
    assert.equal(activeCampaigns(inst).length, 4)

    for (const template of [1, 2, 3, 4]) {
      assert.deepEqual(timesOf(inst, ids[template]), [saveOf({ template, n: 100 }).t, saveOf({ template, n: 140 }).t], `history of campaign ${template} holds another campaign's snapshots`)
    }
  })

  test('matrix', 'the warning state and the map groups of campaigns that share a GameID and a name are kept apart', async () => {
    const inst = installation()
    const one = (await pass(inst, saveOf({ template: 1, n: 100 }))).resolution.campaignId
    const two = (await pass(inst, saveOf({ template: 2, n: 100 }))).resolution.campaignId

    assert.notEqual(raceKeyPrefix(one, 7), raceKeyPrefix(two, 7))
    assert.ok(raceKeyPrefix(one, 7).startsWith('campaign.') && raceKeyPrefix(one, 7).endsWith('.race.7'))

    keep(inst, one, 7, 'warningsMuted', { items: { idleFleets: [1] } })
    keep(inst, one, 7, 'mapGroups', { 1: 'north' })
    keep(inst, two, 7, 'warningsMuted', { items: { idleFleets: [9] } })

    assert.deepEqual(kept(inst, one, 7, 'warningsMuted'), { items: { idleFleets: [1] } })
    assert.deepEqual(kept(inst, two, 7, 'warningsMuted'), { items: { idleFleets: [9] } })
    assert.equal(kept(inst, two, 7, 'mapGroups'), undefined)

    await pass(inst, saveOf({ template: 1, n: 120 }))
    await pass(inst, saveOf({ template: 2, n: 120 }))

    assert.deepEqual(kept(inst, one, 7, 'warningsMuted'), { items: { idleFleets: [1] } })
    assert.equal(kept(inst, two, 7, 'mapGroups'), undefined)
  })

  test('matrix', 'a game renamed in the game is the same campaign under its new name', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ name: 'Alpha', n: 100 }))
    const second = await pass(inst, saveOf({ name: 'Beta', n: 130 }))
    const entry = registryOf(inst).campaigns[first.resolution.campaignId]

    assert.equal(second.resolution.campaignId, first.resolution.campaignId)
    assert.equal(activeCampaigns(inst).length, 1)
    assert.deepEqual(entry.names.map((item) => item.name), ['Alpha', 'Beta'])
    assert.equal(timesOf(inst, first.resolution.campaignId).length, 2)
  })

  test('matrix', 'an older save of a campaign (a rewind) lands in the past and the later snapshots stay', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 300 }))
    const rewound = await pass(inst, saveOf({ n: 150 }))
    const id = first.resolution.campaignId

    assert.equal(rewound.resolution.campaignId, id)
    assert.equal(rewound.resolution.relation, 'rewound')
    assert.deepEqual(timesOf(inst, id), [saveOf({ n: 150 }).t, saveOf({ n: 300 }).t])

    const again = await pass(inst, saveOf({ n: 300 }))

    assert.equal(again.resolution.relation, 'same')
    assert.equal(activeCampaigns(inst).length, 1)
  })

  test('matrix', 'a copy, a rename and a move of the save file is the same campaign and the paths are attached to it', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 200 }), { path: 'C:/saves/a.db' })
    const copied = await pass(inst, saveOf({ n: 200 }), { path: 'D:/backup/a-copy.db' })
    const moved = await pass(inst, saveOf({ n: 250 }), { path: 'D:/backup/a-copy.db' })
    const id = first.resolution.campaignId

    assert.equal(copied.resolution.campaignId, id)
    assert.equal(copied.resolution.relation, 'same')
    assert.equal(moved.resolution.campaignId, id)
    assert.equal(moved.resolution.relation, 'continues')
    assert.equal(activeCampaigns(inst).length, 1)
    assert.equal(Object.keys(registryOf(inst).campaigns[id].branches).length, 1)
    assert.deepEqual(registryOf(inst).campaigns[id].attachments.map((attachment) => attachment.path).sort(), ['C:/saves/a.db', 'D:/backup/a-copy.db'])
  })

  test('matrix', 'a save replayed from an earlier point is a branch of its own, seeded with the past it shares and no later', async () => {
    const inst = installation()
    const fork = { at: 100, salt: 77 }
    const early = await pass(inst, saveOf({ n: 64 }))
    const id = early.resolution.campaignId

    await pass(inst, saveOf({ n: 300 }))

    const replay = await pass(inst, saveOf({ n: 250, fork }))
    const entry = registryOf(inst).campaigns[id]

    assert.equal(replay.resolution.relation, 'fork')
    assert.equal(replay.resolution.forked, true)
    assert.equal(replay.resolution.campaignId, id)
    assert.equal(replay.resolution.branchId, 'b2')
    assert.equal(entry.branches.b2.parent, 'b1')
    assert.equal(entry.branches.b2.fork.n, STEP)
    assert.equal(entry.branches.b2.fork.t, saveOf({ n: 64 }).t)
    assert.deepEqual(timesOf(inst, id, 'b2'), [saveOf({ n: 64 }).t, saveOf({ n: 250, fork }).t])
    assert.deepEqual(timesOf(inst, id, 'b1'), [saveOf({ n: 64 }).t, saveOf({ n: 300 }).t])

    const onwards = await pass(inst, saveOf({ n: 280, fork }))

    assert.equal(onwards.resolution.branchId, 'b2')
    assert.equal(onwards.resolution.relation, 'continues')

    const original = await pass(inst, saveOf({ n: 300 }))

    assert.equal(original.resolution.branchId, 'b1')
    assert.equal(original.resolution.relation, 'same')
    assert.equal(Object.keys(registryOf(inst).campaigns[id].branches).length, 2)
  })

  test('matrix', 'a branch seeded at a fork carries the parent\'s thinning record only where it holds for the cut: a thinning after the fork is not the fork\'s, one before it is, a series never thinned stays so, and a record that was not intact is dropped', async () => {
    const replayed = async (thinning) => {
      const inst = installation()
      const early = await pass(inst, saveOf({ n: 64 }))
      const id = early.resolution.campaignId

      await pass(inst, saveOf({ n: 300 }))

      const file = fileOf(inst, id)
      const series = file.races[7]
      const [first, last] = series.snapshots.map((snapshot) => snapshot.t)
      const witness = campaign.witnessOf(series.snapshots)

      if (thinning) {
        series.thinning = thinning({ first, last, witness })
        inst.files.set(`file:campaign-${id}-b1`, clone(file))
      }

      const replay = await pass(inst, saveOf({ n: 250, fork: { at: 100, salt: 77 } }))

      assert.equal(replay.resolution.branchId, 'b2')

      return { parent: fileOf(inst, id, 'b1').races[7], branch: fileOf(inst, id, 'b2').races[7], forkAt: first }
    }
    const record = (last, extra = {}) => ({ complete: true, passes: 2, dropped: 5, last: { at: 1, t: last, passes: 1, dropped: 3, cap: 500 }, ...extra })

    const after = await replayed(({ last, witness }) => record(last, { witness }))

    assert.equal(history.thinningStatus(after.parent).status, 'thinned')
    assert.equal(history.thinningStatus(after.branch).status, 'unknown', 'the thinning that came after the fork is not the fork\'s')
    assert.equal('thinning' in after.branch, false)

    const before = await replayed(({ first, witness }) => record(first, { witness }))

    assert.deepEqual([before.branch.snapshots.length, history.thinningStatus(before.branch).status, history.thinningStatus(before.branch).passes, history.thinningStatus(before.branch).dropped], [2, 'thinned', 2, 5], 'a thinning that happened by the fork point is kept')
    assert.equal(history.thinningStatus(before.parent).status, 'thinned')

    const never = await replayed(null)

    assert.equal(history.thinningStatus(never.parent).status, 'untouched')
    assert.equal(history.thinningStatus(never.branch).status, 'untouched')

    const stale = await replayed(({ first }) => record(first, { witness: 'not the digest of these times' }))

    assert.equal(history.thinningStatus(stale.branch).status, 'unknown', 'a record the parent itself no longer matched says nothing of the fork')
  })

  test('matrix', 'a longer save that left the recorded tip at an exact point is a branch, found at the stored position', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 300 }))
    const replay = await pass(inst, saveOf({ n: 310, fork: { at: 200, salt: 33 } }))
    const entry = registryOf(inst).campaigns[first.resolution.campaignId]

    assert.equal(replay.resolution.relation, 'fork')
    assert.equal(entry.branches.b2.fork.n, 192)
    assert.equal(entry.branches.b2.fork.t, saveOf({ n: 192 }).t)
  })

  test('matrix', 'a short record of the same game id under another path is kept apart and asks, and nothing is merged on a guess', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/b.db' })

    assert.notEqual(other.resolution.campaignId, first.resolution.campaignId)
    assert.equal(other.resolution.created, true)
    assert.deepEqual(other.resolution.pending, [{ campaignId: first.resolution.campaignId, branchId: 'b1' }])
    assert.equal(activeCampaigns(inst).length, 2)

    const again = await pass(inst, saveOf({ n: 50 }), { path: 'C:/saves/b.db' })

    assert.equal(again.resolution.campaignId, other.resolution.campaignId, 'a path the player has not answered for moved to another campaign')
    assert.equal(again.resolution.relation, 'attached')
  })

  test('matrix', 'a thin anchor accepts the same point of the same name (a copy) and asks about a longer save', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 100, anchorCount: 5 }), { path: 'C:/saves/a.db' })
    const copy = await pass(inst, saveOf({ n: 100, anchorCount: 5 }), { path: 'C:/saves/b.db' })
    const longer = await pass(inst, saveOf({ n: 150, anchorCount: 5 }), { path: 'C:/saves/c.db' })

    assert.equal(copy.resolution.campaignId, first.resolution.campaignId)
    assert.equal(copy.resolution.relation, 'same')
    assert.notEqual(longer.resolution.campaignId, first.resolution.campaignId)
    assert.deepEqual(longer.resolution.pending, [{ campaignId: first.resolution.campaignId, branchId: 'b1' }])
  })

  test('matrix', 'two campaigns that share a thin template but not the ledger are told apart without asking', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ template: 1, anchorKey: 1, n: 100, anchorCount: 5 }))
    const twin = await pass(inst, saveOf({ template: 2, anchorKey: 1, n: 100, anchorCount: 5 }))

    assert.notEqual(twin.resolution.campaignId, first.resolution.campaignId)
    assert.deepEqual(twin.resolution.pending, [])
  })

  test('matrix', 'the answer "separate campaign" closes the question and nothing is written to the candidate', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/b.db' })
    const candidate = JSON.stringify([fileOf(inst, first.resolution.campaignId), registryOf(inst).campaigns[first.resolution.campaignId]])

    attachModule.keepSeparate(inst.io, other.resolution.campaignId)

    const entry = registryOf(inst).campaigns[other.resolution.campaignId]

    assert.ok(entry.attachments.every((attachment) => attachment.pending.length === 0 && attachment.answer === 'separate'))
    assert.equal(JSON.stringify([fileOf(inst, first.resolution.campaignId), registryOf(inst).campaigns[first.resolution.campaignId]]), candidate)
  })

  test('matrix', 'attaching a campaign to another merges its history in time order, copies only the settings the target lacks, and the save follows the target afterwards', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 41 }), { path: 'C:/saves/b.db' })
    const [target, source] = [first.resolution.campaignId, other.resolution.campaignId]

    keep(inst, target, 7, 'warningsMuted', { items: { target: [1] } })
    keep(inst, source, 7, 'warningsMuted', { items: { source: [2] } })
    keep(inst, source, 7, 'mapPinned', [5])

    const preview = attachModule.previewAttach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same' })

    assert.equal(preview.added, 1)
    assert.equal(preview.settingsCopied, 1)
    assert.equal(preview.settingsKept, 1)

    const before = everything(inst)

    attachModule.previewAttach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same' })
    assert.equal(everything(inst), before, 'a preview wrote something')

    const done = attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same' })

    assert.deepEqual(done, { campaignId: target, branchId: 'b1' })
    assert.deepEqual(timesOf(inst, target), [saveOf({ n: 40 }).t, saveOf({ n: 41 }).t])
    assert.deepEqual(kept(inst, target, 7, 'warningsMuted'), { items: { target: [1] } }, 'a setting the target had was overwritten')
    assert.deepEqual(kept(inst, target, 7, 'mapPinned'), [5])
    assert.deepEqual(registryOf(inst).campaigns[source].mergedInto.campaignId, target)
    assert.deepEqual(timesOf(inst, source), [saveOf({ n: 41 }).t], 'the attached campaign was changed')

    attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same' })
    assert.deepEqual(timesOf(inst, target), [saveOf({ n: 40 }).t, saveOf({ n: 41 }).t], 'attaching twice changed the history')

    const next = await pass(inst, saveOf({ n: 42 }), { path: 'C:/saves/b.db' })

    assert.equal(next.resolution.campaignId, target)
    assert.equal(activeCampaigns(inst).length, 1)
  })

  test('matrix', 'attaching a campaign as a new branch never copies the pins of its races, which name their branch by id, while the other settings still come across', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 41 }), { path: 'C:/saves/b.db' })
    const [target, source] = [first.resolution.campaignId, other.resolution.campaignId]
    const pins = { version: 1, seeded: {}, pins: [{ id: 'p1', branch: 'b1' }] }

    keep(inst, source, 7, 'logPins', pins)
    keep(inst, source, 7, 'mapPinned', [5])

    const preview = attachModule.previewAttach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'new-branch' })

    assert.equal(preview.settingsCopied, 1, 'the preview counts a pin as copied')

    const done = attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'new-branch' })

    assert.notEqual(done.branchId, 'b1')
    assert.equal(kept(inst, target, 7, 'logPins'), undefined, 'a pin of the source reached the target campaign')
    assert.deepEqual(kept(inst, target, 7, 'mapPinned'), [5])
    assert.deepEqual(kept(inst, source, 7, 'logPins'), pins, 'the attached campaign was changed')
  })

  test('matrix', 'attaching as a new branch keeps the target branch as it was and gives the history a branch of its own', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 41 }), { path: 'C:/saves/b.db' })
    const [target, source] = [first.resolution.campaignId, other.resolution.campaignId]
    const before = JSON.stringify(timesOf(inst, target))
    const done = attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'new-branch' })

    assert.equal(done.branchId, 'b2')
    assert.equal(JSON.stringify(timesOf(inst, target)), before)
    assert.deepEqual(timesOf(inst, target, 'b2'), [saveOf({ n: 41 }).t])
  })

  test('matrix', 'merging a history never trims it, whatever the names or times', () => {
    const file = legacyFile([100, 200], { gameName: 'First' })
    const merged = history.mergeGame(file, { gameName: 'Other name', races: [{ RaceID: 7, raceName: 'Race', npr: false, snapshot: { t: 50 } }, { RaceID: 7, raceName: 'Race', npr: false, snapshot: { t: 150 } }] })

    assert.deepEqual(merged.races[7].snapshots.map((snapshot) => snapshot.t), [50, 100, 150, 200])
  })

  // ---- migration ----
  const migrated = async ({ file, settings, save = saveOf({ n: 100 }), path = 'C:/saves/a.db' } = {}) => {
    const inst = installation()

    seedLegacy(inst, { file, settings })

    const original = { file: JSON.stringify(inst.files.get('file:game-1')), settings: JSON.stringify(inst.files.get('settings').game) }
    const first = await pass(inst, save, { path })

    return { inst, first, original }
  }

  test('migration', 'a legacy history and its settings that nothing contradicts become the opened campaign, flagged as assumed', async () => {
    const { inst, first } = await migrated()
    const id = first.resolution.campaignId
    const entry = registryOf(inst).campaigns[id]

    assert.equal(first.resolution.legacy.verdict, 'single')
    assert.equal(entry.provenance, 'legacy-assumed')
    assert.equal(entry.legacy.verdict, 'single')
    assert.deepEqual(timesOf(inst, id), [100, 200, saveOf({ n: 100 }).t].sort((a, b) => a - b))
    assert.deepEqual(settingsOf(inst).campaign[id], legacySettings())
    assert.equal(unitsOf(inst)[1].state, 'committed')

    const next = await pass(inst, saveOf({ n: 120 }))

    assert.equal(next.resolution.campaignId, id)
    assert.equal(next.resolution.legacy, null, 'the migration ran twice')
    assert.equal(activeCampaigns(inst).length, 1)
  })

  test('migration', 'the legacy file and the legacy settings are byte for byte what they were, and the unit keeps full copies with hashes', async () => {
    const { inst, original } = await migrated()

    assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
    assert.equal(JSON.stringify(inst.files.get('settings').game), original.settings)
    assert.deepEqual(inst.files.get('settings').other, { kept: true })
    assert.equal(JSON.stringify(unitsOf(inst)[1].originals.history), original.file)
    assert.equal(JSON.stringify(unitsOf(inst)[1].originals.settings), JSON.stringify(legacySettings()))
    assert.ok(unitsOf(inst)[1].originals.historyHash && unitsOf(inst)[1].originals.settingsHash)
  })

  const AMBIGUOUS = [
    ['a legacy file that recorded another game name', { file: legacyFile([100, 200], { gameName: 'Another campaign' }) }],
    ['a legacy series that falls where it could only grow', { file: legacyFile([100, 200, 300], { systems: [5, 9, 3] }) }],
  ]

  AMBIGUOUS.forEach(([title, options]) => {
    test('migration', `${title} is not claimed by the opened campaign: it waits, unchanged, to be attached`, async () => {
      const { inst, first, original } = await migrated(options)
      const id = first.resolution.campaignId
      const pool = Object.values(registryOf(inst).pool)

      assert.equal(first.resolution.legacy.verdict, 'ambiguous')
      assert.equal(registryOf(inst).campaigns[id].provenance, 'observed')
      assert.deepEqual(timesOf(inst, id), [saveOf({ n: 100 }).t], 'the legacy history joined a campaign on a guess')
      assert.equal(pool.length, 1)
      assert.equal(pool[0].attachedTo, null)
      assert.equal(pool[0].file, 'game-1')
      assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
      assert.equal(JSON.stringify(inst.files.get('settings').game), original.settings)
      assert.equal(kept(inst, id, 7, 'warningsMuted'), undefined)

      const from = { poolId: pool[0].id }
      const to = { campaignId: id, branchId: 'b1' }
      const preview = attachModule.previewAttach(inst.io, { from, to, mode: 'same' })

      assert.equal(preview.added, options.file.races[7].snapshots.length)

      attachModule.attach(inst.io, { from, to, mode: 'same' })
      assert.equal(timesOf(inst, id).length, options.file.races[7].snapshots.length + 1)
      assert.deepEqual(kept(inst, id, 7, 'mapPinned'), [10, 11])
      assert.notEqual(registryOf(inst).pool[pool[0].id].attachedTo, null)
      assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file, 'attaching changed the legacy file')
    })
  })

  // The writes of a clean migration pass, to know where an interruption can fall.
  const cleanWrites = async () => {
    const { inst } = await migrated()

    return inst.writes.length
  }

  const finished = async (inst, original, { save = saveOf({ n: 100 }), path = 'C:/saves/a.db' } = {}) => {
    const settled = await pass(inst, save, { path })
    const campaigns = activeCampaigns(inst)

    assert.equal(settled.result.failed.length, 0, 'the final pass failed')
    assert.equal(campaigns.length, 1, 'an interrupted migration left more than one campaign')
    assert.equal(campaigns[0].provenance, 'legacy-assumed')
    assert.deepEqual(timesOf(inst, campaigns[0].id), [100, 200, save.t].sort((a, b) => a - b))
    assert.deepEqual(settingsOf(inst).campaign[campaigns[0].id], legacySettings())
    assert.equal(unitsOf(inst)[1].state, 'committed')
    assert.equal(Object.keys(settingsOf(inst).campaign).length, 1, 'a settings subtree of the interrupted attempt was left behind')
    assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
    assert.equal(JSON.stringify(inst.files.get('settings').game), original.settings)
    assert.equal(Object.keys(registryOf(inst).pool).length, 0)
  }

  test('migration', 'a migration interrupted at any write leaves the originals untouched and the next pass ends with one campaign', async () => {
    const total = await cleanWrites()

    assert.ok(total >= 5, 'a migration pass wrote too little to be interrupted anywhere')

    for (let failAt = 0; failAt < total; failAt++) {
      const inst = installation()

      seedLegacy(inst)

      const original = { file: JSON.stringify(inst.files.get('file:game-1')), settings: JSON.stringify(inst.files.get('settings').game) }

      inst.hooks.beforeWrite = (_name, index) => {
        if (index === failAt) {
          throw new Error('disk full')
        }
      }

      const broken = await pass(inst, saveOf({ n: 100 }))

      assert.ok(broken.result.failed.length === 1 && broken.result.failed[0].stage === 'write', `an interruption at write ${failAt} was not reported`)
      assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file, `write ${failAt}: the legacy file changed`)
      assert.equal(JSON.stringify(inst.files.get('settings').game), original.settings, `write ${failAt}: the legacy settings changed`)

      inst.hooks.beforeWrite = null
      await finished(inst, original)
    }
  })

  test('migration', 'a recovery that is itself interrupted at any write is finished by the next pass, with one campaign and the same history', async () => {
    const total = await cleanWrites()

    for (const first of [2, 3, 4]) {
      for (let second = 0; second < total + 2; second++) {
        const inst = installation()

        seedLegacy(inst)

        const original = { file: JSON.stringify(inst.files.get('file:game-1')), settings: JSON.stringify(inst.files.get('settings').game) }

        inst.hooks.beforeWrite = (_name, index) => {
          if (index === first) {
            throw new Error('disk full')
          }
        }
        await pass(inst, saveOf({ n: 100 }))

        const mark = inst.writes.length

        inst.hooks.beforeWrite = (_name, index) => {
          if (index === mark + second) {
            throw new Error('disk full again')
          }
        }
        await pass(inst, saveOf({ n: 100 }))
        inst.hooks.beforeWrite = null
        assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
        await finished(inst, original)
      }
    }
  })

  test('migration', 'a requested rollback removes what the migration made, restores the originals and is not run again by the next pass', async () => {
    const { inst, first, original } = await migrated()
    const id = first.resolution.campaignId

    await pass(inst, saveOf({ n: 120 }))
    assert.equal(campaign.rollbackUnit(inst.io, 1, { keep: true }), true)
    assert.equal(registryOf(inst).campaigns[id], undefined)
    assert.deepEqual(fileOf(inst, id), {})
    assert.equal(settingsOf(inst).campaign, undefined)
    assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
    assert.equal(JSON.stringify(inst.files.get('settings').game), original.settings)
    assert.equal(unitsOf(inst)[1].state, 'rolled-back')
    assert.deepEqual(settingsOf(inst).other, { kept: true })

    const next = await pass(inst, saveOf({ n: 130 }))

    assert.equal(next.resolution.legacy, null, 'a rolled-back migration ran again')
    assert.equal(registryOf(inst).campaigns[next.resolution.campaignId].provenance, 'observed')
    assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
  })

  test('migration', 'a rollback restores a legacy file that was changed after the migration', async () => {
    const { inst, original } = await migrated()

    inst.files.set('file:game-1', { gameName: 'Changed', races: {}, intel: {} })
    assert.equal(campaign.rollbackUnit(inst.io, 1, { keep: true }), true)
    assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
  })

  test('migration', 'a rollback whose preserved original does not match its hash stops and changes nothing', async () => {
    const { inst } = await migrated()
    const migration = clone(inst.files.get('migration'))

    migration.units[1].originals.history.gameName = 'Damaged'
    inst.files.set('migration', migration)

    const before = everything(inst)

    assert.throws(() => campaign.rollbackUnit(inst.io, 1, { keep: true }), /hash/)
    assert.equal(everything(inst), before)
  })

  test('migration', 'a migration run again from the same originals reaches the same verdict', async () => {
    const one = await migrated()
    const two = await migrated()

    assert.equal(one.first.resolution.legacy.verdict, two.first.resolution.legacy.verdict)
    assert.equal(one.first.resolution.legacy.reason, two.first.resolution.legacy.reason)
  })

  // ---- guards ----
  test('guards', 'a pass replaced at any point writes nothing after the replacement, and the next pass finishes the record', async () => {
    let replacedAt = 0
    let sawFinished = false

    while (!sawFinished) {
      const inst = installation()

      seedLegacy(inst)

      const original = { file: JSON.stringify(inst.files.get('file:game-1')), settings: JSON.stringify(inst.files.get('settings').game) }
      let checks = 0
      let writesAtReplacement = null
      const isCurrent = () => {
        checks += 1

        if (checks > replacedAt && writesAtReplacement === null) {
          writesAtReplacement = inst.writes.length
        }

        return checks <= replacedAt
      }
      const run = await pass(inst, saveOf({ n: 100 }), { isCurrent })

      if (run.result.superseded) {
        assert.equal(inst.writes.length, writesAtReplacement, `replaced at check ${replacedAt}: a write followed the replacement`)
        assert.equal(JSON.stringify(inst.files.get('file:game-1')), original.file)
        await finished(inst, original)
        replacedAt += 1
      } else {
        sawFinished = true
      }

      assert.ok(replacedAt < 60, 'the pass never finished')
    }

    assert.ok(replacedAt >= 4, 'the pass was replaced at too few points to prove anything')
  })

  test('guards', 'a pass replaced before it settles records no campaign at all', async () => {
    const inst = installation()
    const run = await pass(inst, saveOf({ n: 100 }), { isCurrent: () => false })

    assert.equal(run.result.superseded, true)
    assert.equal(run.result.recorded, 0)
    assert.equal(inst.writes.length, 0)
  })

  test('guards', 'an older pass that ends after a newer save has been recorded cannot change the newer record', async () => {
    const inst = installation()

    await pass(inst, saveOf({ n: 100 }))

    let generation = 0
    let release
    const held = new Promise((resolve) => (release = resolve))
    const older = ++generation
    const olderPass = pass(inst, saveOf({ n: 120, held }), { isCurrent: () => older === generation })
    const newer = ++generation

    await pass(inst, saveOf({ n: 200 }), { isCurrent: () => newer === generation })

    const before = everything(inst)

    release()

    const finishedOlder = await olderPass

    assert.equal(finishedOlder.result.superseded, true)
    assert.equal(everything(inst), before)
  })

  // ---- review ----
  const ledgerOf = (n, template = 1) => Array.from({ length: n }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 5 + template * 1000003 }))

  test('review', 'the early digests of a ledger are the chained digest after each of the first counts it reaches', () => {
    const rows = ledgerOf(40)
    const scanned = campaign.scanLedger(rows)

    assert.deepEqual(Object.keys(scanned.early).map(Number), campaign.EARLY_COUNTS)
    campaign.EARLY_COUNTS.forEach((count) => assert.equal(scanned.early[count], campaign.scanLedger(rows.slice(0, count), [count]).exact[count]))
    assert.deepEqual(Object.keys(campaign.scanLedger(rows.slice(0, 10)).early).map(Number), [8])
  })

  test('review', 'a path alone never joins a save to a campaign: another ledger at the same path and game name is a new campaign without a question', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ template: 1, n: 40, anchorCount: 0 }), { path: 'C:/saves/a.db' })
    const second = await pass(inst, saveOf({ template: 2, n: 40, anchorCount: 0 }), { path: 'C:/saves/a.db' })

    assert.notEqual(second.resolution.campaignId, first.resolution.campaignId)
    assert.equal(second.resolution.created, true)
    assert.deepEqual(second.resolution.pending, [])
    assert.equal(activeCampaigns(inst).length, 2)
  })

  test('review', 'a short save of another campaign at the path of a longer recorded one is a new campaign without a question', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ template: 1, n: 300, anchorCount: 0 }), { path: 'C:/saves/a.db' })
    const second = await pass(inst, saveOf({ template: 2, n: 10, anchorCount: 0 }), { path: 'C:/saves/a.db' })

    assert.notEqual(second.resolution.campaignId, first.resolution.campaignId)
    assert.deepEqual(second.resolution.pending, [])
    assert.equal(activeCampaigns(inst).length, 2)
  })

  test('review', 'a thin-anchor continuation at its own path is the same campaign, and a rewind there is asked about, not attached', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 100, anchorCount: 5 }), { path: 'C:/saves/a.db' })
    const onwards = await pass(inst, saveOf({ n: 150, anchorCount: 5 }), { path: 'C:/saves/a.db' })

    assert.equal(onwards.resolution.campaignId, first.resolution.campaignId)
    assert.equal(onwards.resolution.relation, 'attached')

    const rewound = await pass(inst, saveOf({ n: 90, anchorCount: 5 }), { path: 'C:/saves/a.db' })

    assert.notEqual(rewound.resolution.campaignId, first.resolution.campaignId)
    assert.deepEqual(rewound.resolution.pending, [{ campaignId: first.resolution.campaignId, branchId: 'b1' }])
  })

  test('review', 'a save the player attached or kept apart at a path is taken there before any ranking, even where another campaign matches better', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/b.db' })

    attachModule.keepSeparate(inst.io, other.resolution.campaignId)
    await pass(inst, saveOf({ n: 100 }), { path: 'C:/saves/a.db' })

    const reopened = await pass(inst, saveOf({ n: 100 }), { path: 'C:/saves/b.db' })

    assert.equal(reopened.resolution.campaignId, other.resolution.campaignId)
    assert.notEqual(reopened.resolution.campaignId, first.resolution.campaignId)
    assert.equal(activeCampaigns(inst).length, 2)
  })

  test('review', 'an attach carries the evidence: the attached save is still recognised at a new path, and a second attach changes nothing', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 100, anchorCount: 5 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 150, anchorCount: 5 }), { path: 'C:/saves/b.db' })
    const [target, source] = [first.resolution.campaignId, other.resolution.campaignId]

    assert.deepEqual(other.resolution.pending, [{ campaignId: target, branchId: 'b1' }])
    attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same', now: 7000000 })

    const done = everything(inst)

    // A later clock, so an attach that is applied again writes a later time and cannot pass for one that changed nothing in the same millisecond.
    attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same', now: 8000000 })
    assert.equal(everything(inst), done, 'a second attach changed the records')

    const moved = await pass(inst, saveOf({ n: 150, anchorCount: 5 }), { path: 'C:/saves/c.db' })

    assert.equal(moved.resolution.campaignId, target)
    assert.equal(moved.resolution.relation, 'same')
    assert.equal(activeCampaigns(inst).length, 1)
  })

  test('review', 'an attach holds a path of one game once, answered by the player', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
    const other = await pass(inst, saveOf({ n: 41 }), { path: 'C:/saves/b.db' })
    const [target, source] = [first.resolution.campaignId, other.resolution.campaignId]
    const registry = registryOf(inst)

    registry.campaigns[source].attachments.push({ ...clone(registry.campaigns[target].attachments[0]), branchId: 'b1' })
    inst.files.set('registry', registry)
    attachModule.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same' })

    const held = registryOf(inst).campaigns[target].attachments.filter((attachment) => attachment.path === 'C:/saves/a.db')

    assert.equal(held.length, 1)
    assert.equal(held[0].answer, 'attached-by-player')
  })

  const DAMAGES = [
    ['an array', (inst) => inst.files.set('registry', [])],
    ['a campaign without its branches', (inst, id) => { const registry = registryOf(inst); delete registry.campaigns[id].branches; inst.files.set('registry', registry) }],
    ['a version newer than this one reads', (inst) => { const registry = registryOf(inst); registry.version = 99; inst.files.set('registry', registry) }],
  ]

  DAMAGES.forEach(([title, damage]) => {
    test('review', `a damaged campaign registry (${title}) is reported as such and is neither read as empty nor written over`, async () => {
      const inst = installation()
      const first = await pass(inst, saveOf({ n: 100 }))

      damage(inst, first.resolution.campaignId)

      const before = everything(inst)
      const run = await pass(inst, saveOf({ n: 120 }))

      assert.equal(run.result.recorded, 0)
      assert.equal(run.result.failed.length, 1)
      assert.equal(run.result.failed[0].stage, 'registry')
      assert.equal(run.resolution, null)
      assert.equal(everything(inst), before, 'a damaged registry was written over')
    })
  })

  const storeHistory = m.storeHistory
  const rootOf = (GameID, generation) => ({ GameID, freshness: { generation } })

  test('review', 'a game settled on one copy of a save is settled to nothing on the next copy, whatever the GameID, until that copy settles it', () => {
    const state = storeHistory.state()

    storeHistory.mutations.resolved(state, { GameID: 1, resolution: { campaignId: 'c1', branchId: 'b1' }, generation: 4 })

    assert.equal(storeHistory.getters.campaign(state, {}, rootOf(1, 4)).campaignId, 'c1')
    assert.equal(storeHistory.getters.campaign(state, {}, rootOf(1, 5)), null)
    assert.equal(storeHistory.getters.campaign(state, {}, rootOf(2, 4)), null)

    storeHistory.mutations.resolved(state, { GameID: 1, resolution: { campaignId: 'c2', branchId: 'b1' }, generation: 5 })
    assert.equal(storeHistory.getters.campaign(state, {}, rootOf(1, 5)).campaignId, 'c2')
  })

  test('review', 'the snapshot summary of a game is null on a copy of the save its campaign was not settled on', () => {
    const state = storeHistory.state()

    storeHistory.mutations.resolved(state, { GameID: 1, resolution: { campaignId: 'c1', branchId: 'b1' }, generation: 4 })
    assert.equal(storeHistory.getters.snapshotSummary(state, {}, rootOf(1, 5))(1, 7), null)
  })

  test('review', 'an empty recorded ledger under a thin anchor identifies nothing: a replacement of the same game id at the same path is a new campaign, and one that agrees by its systems continues', async () => {
    const inst = installation()
    const first = await pass(inst, saveOf({ n: 0, template: 1, anchorCount: 0 }), { path: 'C:/saves/a.db' })
    const second = await pass(inst, saveOf({ n: 100, template: 2, anchorCount: 0 }), { path: 'C:/saves/a.db' })

    assert.notEqual(second.resolution.campaignId, first.resolution.campaignId)
    assert.equal(second.resolution.relation, 'new')
    assert.equal(activeCampaigns(inst).length, 2)

    const rich = installation()
    const start = await pass(rich, saveOf({ n: 0, template: 1 }), { path: 'C:/saves/a.db' })
    const later = await pass(rich, saveOf({ n: 100, template: 1 }), { path: 'C:/saves/a.db' })

    assert.equal(later.resolution.campaignId, start.resolution.campaignId)
    assert.equal(activeCampaigns(rich).length, 1)
  })

  test('review', 'two tabs sharing one browser storage cannot overwrite each other\'s first recording: the registry that changed under a pass is read and decided again', async () => {
    const memory = new Map()
    const registryKey = 'aurora-electrons:history/campaigns'
    let reads = 0
    let interleave = null

    globalThis.localStorage = {
      getItem: (key) => {
        const value = memory.has(key) ? memory.get(key) : null

        if (key === registryKey && ++reads === 3 && interleave) {
          interleave()
        }

        return value
      },
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
    }

    try {
      const { default: Store } = m.webStore
      const tab = () => ({ registry: new Store({ cwd: 'history', name: 'campaigns' }), migration: new Store({ cwd: 'migrations', name: 'campaigns-v1' }), settings: new Store({}), file: (name) => new Store({ cwd: 'history', name }) })
      const other = saveOf({ template: 2, n: 100 })
      const opened = await campaign.observeGame(other, { GameID: 1, GameName: 'Campaign', GameTime: other.t })

      // The other tab settles its own game between this tab's read of the registry in the settle step (the third read: the tips before and inside the registry lock come first) and its write.
      interleave = () => campaign.settle(tab(), { opened, path: 'C:/saves/b.db', now: 5, newId: () => 'tab-b' })

      const run = await history.recordHistory(saveOf({ template: 1, n: 100 }), { storage: tab(), path: 'C:/saves/a.db', now: () => 10, newId: () => 'tab-a' })

      assert.equal(run.failed.length, 0)
      assert.deepEqual(Object.keys(JSON.parse(memory.get(registryKey)).campaigns).sort(), ['tab-a', 'tab-b'])
      assert.ok(memory.has('aurora-electrons:history/campaign-tab-a-b1'))
    } finally {
      delete globalThis.localStorage
    }
  })

  // Two windows or tabs: each its own copy of the modules (so its own ownership), over one fake localStorage and one fake lock manager that queues requests per lock name as the browser does. A lock is held until the callback's promise settles; the recording lock's callback never settles, so only `close()` (a window closing) frees it. `held()` lists the names held now.
  const fakeLocks = () => {
    const names = new Map()
    const entry = (name) => {
      if (!names.has(name)) {
        names.set(name, { queue: [], holder: null })
      }

      return names.get(name)
    }
    const grant = (name) => {
      const lock = entry(name)

      if (lock.holder || !lock.queue.length) {
        return
      }

      const { callback, resolve, reject } = lock.queue.shift()
      const holder = { done: false }
      const free = () => {
        if (!holder.done) {
          holder.done = true
          lock.holder = null
          grant(name)
        }
      }

      lock.holder = holder
      lock.free = free
      Promise.resolve().then(callback).then(resolve, reject).finally(free)
    }

    return {
      request: (name, callback) => new Promise((resolve, reject) => {
        entry(name).queue.push({ callback, resolve, reject })
        grant(name)
      }),
      // Frees the locks held whose name starts with `prefix` (the window that holds them is gone).
      close: (prefix = 'aurora-electrons:recording-owner') => {
        for (const [name, lock] of names) {
          if (name.startsWith(prefix) && lock.holder) {
            lock.free()
          }
        }
      },
      held: () => [...names].filter(([, lock]) => lock.holder).map(([name]) => name),
    }
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  const withBrowser = async (work) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const memory = new Map()
    const locks = fakeLocks()
    const report = console.error

    // The recorder reports a refused pass on the console, as it should; the checks read it from the result instead.
    console.error = () => {}

    globalThis.localStorage = { getItem: (key) => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => memory.set(key, String(value)), removeItem: (key) => memory.delete(key) }
    Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true })

    try {
      await work({ memory, locks, stored: () => JSON.stringify([...memory].sort()) })
    } finally {
      console.error = report
      delete globalThis.localStorage

      if (descriptor) {
        Object.defineProperty(globalThis, 'navigator', descriptor)
      } else {
        delete globalThis.navigator
      }
    }
  }

  const readOnly = (error) => error.readOnly === true

  test('review', 'a tab that does not own recording writes nothing, whatever it is asked, reports why, and takes the recording over when the owner closes', async () => {
    await withBrowser(async ({ memory, locks, stored }) => {
      const a = await m.tab()
      const b = await m.tab()
      let took = 0

      a.owner.claimRecording({ database: 'C:/saves/a.db' })
      b.owner.claimRecording({ database: 'C:/saves/a.db', onOwner: () => took++ })
      await tick()

      const campaignsStored = () => Object.keys(JSON.parse(memory.get('aurora-electrons:history/campaigns')).campaigns)
      const runA = await a.history.recordHistory(saveOf({ template: 1, n: 100 }), { storage: a.history.campaignStorage(), path: 'C:/saves/a.db', now: () => 10, newId: () => 'c-a' })

      assert.equal(runA.failed.length, 0)
      assert.deepEqual(campaignsStored(), ['c-a'])

      const before = stored()

      // The save of the same game that left the recorded timeline after 80 increments: another tab would settle it as a branch, or on a coarse checkpoint as the same point. This tab cannot write.
      const runB = await b.history.recordHistory(saveOf({ template: 1, n: 100, fork: { at: 80, salt: 77 } }), { storage: b.history.campaignStorage(), path: 'C:/saves/a.db', now: () => 20, newId: () => 'c-b', ownerGrace: 20 })

      assert.equal(runB.recorded, 0)
      assert.equal(runB.failed.length, 1)
      assert.equal(runB.failed[0].stage, 'readonly')
      assert.equal(runB.failed[0].GameID, null)
      assert.equal(runB.superseded, false)
      assert.equal(stored(), before)

      assert.throws(() => { b.history.registryStore().store = {} }, readOnly)
      assert.throws(() => b.history.branchStore('c-a', 'b1').set('gameName', 'Other'), readOnly)
      assert.throws(() => b.history.branchStore('c-a', 'b1').delete('gameName'), readOnly)
      assert.equal(stored(), before)
      assert.equal(b.history.branchStore('c-a', 'b1').get('gameName'), 'Campaign', 'a tab that is not the owner still reads')

      // The player's answers on storage that is not the browser's here, so only the ownership check can stop them.
      const inst = installation()
      const first = await pass(inst, saveOf({ n: 40 }), { path: 'C:/saves/a.db' })
      const other = await pass(inst, saveOf({ n: 41 }), { path: 'C:/saves/b.db' })
      const [target, source] = [first.resolution.campaignId, other.resolution.campaignId]
      const untouched = everything(inst)

      assert.throws(() => b.attach.keepSeparate(inst.io, source), readOnly)
      assert.throws(() => b.attach.attach(inst.io, { from: { campaignId: source }, to: { campaignId: target, branchId: 'b1' }, mode: 'same' }), readOnly)
      assert.equal(everything(inst), untouched)

      // The owner goes on recording; the other tab takes over when the owner's tab is gone.
      const more = await a.history.recordHistory(saveOf({ template: 1, n: 130 }), { storage: a.history.campaignStorage(), path: 'C:/saves/a.db', now: () => 30, newId: () => 'c-a2' })

      assert.equal(more.failed.length, 0)
      assert.deepEqual(campaignsStored(), ['c-a'])
      assert.equal(took, 0)

      locks.close()
      await tick()
      assert.equal(took, 1)

      const runB2 = await b.history.recordHistory(saveOf({ template: 2, n: 100 }), { storage: b.history.campaignStorage(), path: 'C:/saves/b.db', now: () => 40, newId: () => 'c-b' })

      assert.equal(runB2.failed.length, 0)
      assert.deepEqual(campaignsStored().sort(), ['c-a', 'c-b'])
    })
  })

  test('review', 'a reloaded tab waits for the lock the page it replaces is releasing, and then records', async () => {
    await withBrowser(async ({ memory, locks }) => {
      const old = await m.tab()
      const reloaded = await m.tab()

      old.owner.claimRecording({ database: 'C:/saves/a.db' })
      reloaded.owner.claimRecording({ database: 'C:/saves/a.db' })
      await tick()

      const pending = reloaded.history.recordHistory(saveOf({ n: 100 }), { storage: reloaded.history.campaignStorage(), path: 'C:/saves/a.db', now: () => 10, newId: () => 'c-r', ownerGrace: 300 })

      await tick()
      locks.close()

      const run = await pending

      assert.equal(run.failed.length, 0)
      assert.deepEqual(Object.keys(JSON.parse(memory.get('aurora-electrons:history/campaigns')).campaigns), ['c-r'])
    })
  })

  test('review', 'a refused tab that already has a newer pass waiting for the recording does not start a second pass when the owner closes', async () => {
    await withBrowser(async ({ locks }) => {
      const owner = await m.tab()
      const refused = await m.tab()
      const commits = []
      const state = { freshness: { generation: 1 }, database: null, savePath: 'C:/saves/a.db' }
      let watcher = null
      const store = { state, getters: { config: { store: {}, get: () => undefined, set: () => {} } }, watch: (_select, callback) => { watcher = callback }, commit: (type, payload) => commits.push([type, payload]) }
      const open = (generation) => {
        state.freshness.generation = generation
        state.database = saveOf({ n: 100 })
        watcher(state.database)
      }
      const resolved = () => commits.filter(([type]) => type === 'history/resolved')

      owner.owner.claimRecording({ database: 'C:/saves/a.db' })
      refused.plugin.default({ store, ownerGrace: 80 })
      await tick()

      // The first pass is refused after its grace; a reload starts the next, which waits for the lock; the owner closes before that grace is over.
      open(1)
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(resolved().length, 0)
      assert.ok(commits.some(([type, failures]) => type === 'history/failures' && failures.some((failure) => failure.stage === 'readonly')))

      open(2)
      await tick()
      locks.close()
      await new Promise((resolve) => setTimeout(resolve, 300))

      assert.equal(resolved().length, 1, 'the save was recorded more than once')
      assert.equal(resolved()[0][1].generation, 2)
    })
  })

  test('review', 'a refused tab with no pass waiting records the open save once when the owner closes', async () => {
    await withBrowser(async ({ locks }) => {
      const owner = await m.tab()
      const refused = await m.tab()
      const commits = []
      const state = { freshness: { generation: 1 }, database: saveOf({ n: 100 }), savePath: 'C:/saves/a.db' }
      let watcher = null
      const store = { state, getters: { config: { store: {}, get: () => undefined, set: () => {} } }, watch: (_select, callback) => { watcher = callback }, commit: (type, payload) => commits.push([type, payload]) }

      owner.owner.claimRecording({ database: 'C:/saves/a.db' })
      refused.plugin.default({ store, ownerGrace: 80 })
      await tick()
      watcher(state.database)
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(commits.filter(([type]) => type === 'history/resolved').length, 0)

      locks.close()
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(commits.filter(([type]) => type === 'history/resolved').length, 1)
    })
  })

  test('review', 'a launch brings forward the window of the database it names, however the path is written, and opens a window for any other', () => {
    const { routeLaunch, databaseKey } = m.launch
    const windows = [{ id: 4, database: 'C:\\Saves\\Aurora\\AuroraDB.db' }, { id: 9, database: 'D:\\Other\\AuroraDB.db' }]

    assert.deepEqual(routeLaunch('c:/saves/aurora/auroradb.db', windows, 'win32'), { action: 'focus', id: 4 })
    assert.deepEqual(routeLaunch('C:\\Saves\\Aurora\\..\\Aurora\\AuroraDB.db', windows, 'win32'), { action: 'focus', id: 4 })
    assert.deepEqual(routeLaunch('D:\\Other\\AuroraDB.db', windows, 'win32'), { action: 'focus', id: 9 })
    assert.deepEqual(routeLaunch('C:\\Saves\\Aurora2\\AuroraDB.db', windows, 'win32'), { action: 'open' })
    assert.deepEqual(routeLaunch('E:\\Saves\\Aurora\\AuroraDB.db', windows, 'win32'), { action: 'open' })
    assert.equal(databaseKey('C:\\Saves\\Aurora\\', 'win32'), databaseKey('c:/saves/aurora', 'win32'))

    // A file system that tells letter case apart.
    const posix = [{ id: 1, database: '/home/a/Saves/AuroraDB.db' }]

    assert.deepEqual(routeLaunch('/home/a//Saves/./AuroraDB.db', posix, 'linux'), { action: 'focus', id: 1 })
    assert.deepEqual(routeLaunch('/home/A/Saves/AuroraDB.db', posix, 'linux'), { action: 'open' })
    assert.deepEqual(routeLaunch('/home/a/saves/auroradb.db', posix, 'linux'), { action: 'open' })

    // A launch that names no database brings forward a window that is open, and opens one when there is none.
    assert.deepEqual(routeLaunch(undefined, windows, 'win32'), { action: 'focus', id: 4 })
    assert.deepEqual(routeLaunch('', [], 'win32'), { action: 'open' })
  })

  test('review', 'windows of different databases record at the same time and both campaigns are kept, while a second window of one database does not record, and a window that moves to another database frees the first', async () => {
    await withBrowser(async ({ memory, locks }) => {
      const a = await m.tab()
      const b = await m.tab()
      const c = await m.tab()
      let took = 0

      a.owner.claimRecording({ database: 'D:/a/AuroraDB.db' })
      b.owner.claimRecording({ database: 'E:/b/AuroraDB.db' })
      c.owner.claimRecording({ database: 'D:/a/AuroraDB.db', onOwner: () => took++ })
      await tick()

      assert.ok(a.owner.ownsRecording() && b.owner.ownsRecording(), 'each database has an owner')
      assert.ok(!c.owner.ownsRecording(), 'a second window of a database waits')

      const [runA, runB] = await Promise.all([
        a.history.recordHistory(saveOf({ template: 1, n: 100 }), { storage: a.history.campaignStorage(), path: 'D:/a/AuroraDB.db', now: () => 10, newId: () => 'c-a' }),
        b.history.recordHistory(saveOf({ template: 2, n: 100 }), { storage: b.history.campaignStorage(), path: 'E:/b/AuroraDB.db', now: () => 11, newId: () => 'c-b' }),
      ])

      assert.equal(runA.failed.length, 0)
      assert.equal(runB.failed.length, 0)
      assert.deepEqual(Object.keys(JSON.parse(memory.get('aurora-electrons:history/campaigns')).campaigns).sort(), ['c-a', 'c-b'])

      const runC = await c.history.recordHistory(saveOf({ template: 3, n: 100 }), { storage: c.history.campaignStorage(), path: 'D:/a/AuroraDB.db', now: () => 12, newId: () => 'c-c', ownerGrace: 20 })

      assert.equal(runC.failed[0].stage, 'readonly')
      assert.equal(Object.keys(JSON.parse(memory.get('aurora-electrons:history/campaigns')).campaigns).length, 2)

      // The owner of the first database opens another one: its lock on the first is released and the window next in line takes it.
      assert.equal(took, 0)
      a.owner.claimRecording({ database: 'F:/f/AuroraDB.db' })
      await tick()
      await tick()
      assert.equal(took, 1)
      assert.ok(c.owner.ownsRecording())
      assert.ok(a.owner.ownsRecording(), 'the window owns the database it moved to')
      assert.deepEqual(locks.held().filter((name) => name.includes('recording-owner')).sort(), ['aurora-electrons:recording-owner:D:/a/AuroraDB.db', 'aurora-electrons:recording-owner:E:/b/AuroraDB.db', 'aurora-electrons:recording-owner:F:/f/AuroraDB.db'])
    })
  })

  test('review', 'every change of the registry or of a campaign file by the recorder is made under the registry lock', async () => {
    await withBrowser(async ({ memory, locks }) => {
      const a = await m.tab()
      const b = await m.tab()
      const unlocked = []
      const write = globalThis.localStorage.setItem

      globalThis.localStorage.setItem = (key, value) => {
        if (!locks.held().includes('aurora-electrons:registry')) {
          unlocked.push(key)
        }

        return write(key, value)
      }

      a.owner.claimRecording({ database: 'D:/a/AuroraDB.db' })
      b.owner.claimRecording({ database: 'E:/b/AuroraDB.db' })
      await tick()

      await Promise.all([
        a.history.recordHistory(saveOf({ template: 1, n: 100 }), { storage: a.history.campaignStorage(), path: 'D:/a/AuroraDB.db', now: () => 10, newId: () => 'c-a' }),
        b.history.recordHistory(saveOf({ template: 2, n: 100 }), { storage: b.history.campaignStorage(), path: 'E:/b/AuroraDB.db', now: () => 11, newId: () => 'c-b' }),
      ])

      assert.ok(memory.has('aurora-electrons:history/campaign-c-a-b1') && memory.has('aurora-electrons:history/campaign-c-b-b1'))
      assert.deepEqual(unlocked, [])
    })
  })

  test('review', 'a save read against the tips stored before another window recorded is read again against the tips now stored: the same game recorded from another database is a branch, not the same point', async () => {
    await withBrowser(async ({ memory }) => {
      const a = await m.tab()
      const b = await m.tab()
      const resolutions = []
      let release
      const gate = new Promise((resolve) => (release = resolve))

      a.owner.claimRecording({ database: 'D:/a/AuroraDB.db' })
      b.owner.claimRecording({ database: 'E:/b/AuroraDB.db' })
      await tick()

      // The first window reads its save (held open) before the second has recorded anything.
      const first = a.history.recordHistory(saveOf({ template: 1, n: 100, held: gate }), { storage: a.history.campaignStorage(), path: 'D:/a/AuroraDB.db', now: () => 10, newId: () => 'c-a', onResolved: (_GameID, resolution) => resolutions.push(resolution) })

      await tick()

      const second = await b.history.recordHistory(saveOf({ template: 1, n: 100, fork: { at: 80, salt: 77 } }), { storage: b.history.campaignStorage(), path: 'E:/b/AuroraDB.db', now: () => 11, newId: () => 'c-b' })

      assert.equal(second.failed.length, 0)
      release()

      const run = await first

      assert.equal(run.failed.length, 0)

      const registry = JSON.parse(memory.get('aurora-electrons:history/campaigns'))
      const campaigns = Object.values(registry.campaigns)

      assert.equal(campaigns.length, 1)
      assert.deepEqual(Object.keys(campaigns[0].branches).sort(), ['b1', 'b2'])
      assert.equal(resolutions.length, 1)
      assert.equal(resolutions[0].relation, 'fork')
      assert.equal(resolutions[0].branchId, 'b2')
    })
  })

  test('review', 'a clear that waits for the registry lock removes the race and branch that were confirmed, not the ones selected when the lock is granted', async () => {
    await withBrowser(async ({ locks }) => {
      const a = await m.tab()

      a.owner.claimRecording({ database: 'D:/a/AuroraDB.db' })
      await tick()

      const races = { 7: { snapshots: [{ t: 1 }] }, 9: { snapshots: [{ t: 2 }] } }

      a.history.branchStore('c', 'b1').store = { races: JSON.parse(JSON.stringify(races)) }
      a.history.branchStore('c', 'b2').store = { races: JSON.parse(JSON.stringify(races)) }

      let release
      const gate = new Promise((resolve) => (release = resolve))
      const held = locks.request('aurora-electrons:registry', () => gate)
      const selection = { campaignId: 'c', branchId: 'b1', RaceID: 7 }

      await tick()

      const pending = a.history.clearRaceHistory(selection)

      // The player moves to another race and branch while the other window holds the lock.
      selection.RaceID = 9
      selection.branchId = 'b2'
      await tick()
      assert.deepEqual(Object.keys(a.history.branchStore('c', 'b1').store.races), ['7', '9'], 'nothing is cleared before the lock is granted')

      release()
      await held

      assert.equal(await pending, true)
      assert.deepEqual(Object.keys(a.history.branchStore('c', 'b1').store.races), ['9'])
      assert.deepEqual(Object.keys(a.history.branchStore('c', 'b2').store.races), ['7', '9'])
      assert.equal(await a.history.clearRaceHistory({ campaignId: 'c', branchId: 'b1', RaceID: 7 }), false)
    })
  })

  ;['same', 'new-branch'].forEach((mode) => {
    test('review', `a history from before campaigns attached (${mode}) to the branch picked on the page goes there, not to the branch the open save settled to`, async () => {
      const { inst, first } = await migrated({ file: legacyFile([100, 200], { gameName: 'Another campaign' }) })
      const id = first.resolution.campaignId
      const fork = await pass(inst, saveOf({ n: 100, fork: { at: 80, salt: 77 } }), { path: 'C:/saves/a.db' })

      assert.equal(first.resolution.branchId, 'b1')
      assert.equal(fork.resolution.branchId, 'b2')

      const settled = 'b1'
      const picked = 'b2'
      const branchIds = Object.keys(registryOf(inst).campaigns[id].branches)
      const pool = Object.values(registryOf(inst).pool)
      const to = { campaignId: id, branchId: history.shownBranch(branchIds, picked, settled) }
      const before = { b1: timesOf(inst, id, 'b1'), b2: timesOf(inst, id, 'b2') }

      assert.equal(history.shownBranch(branchIds, null, settled), settled)
      assert.equal(history.shownBranch(branchIds, 'b9', settled), settled, 'a branch the campaign does not have is not picked')
      assert.equal(to.branchId, 'b2')
      assert.equal(pool.length, 1)
      assert.ok(attachModule.previewAttach(inst.io, { from: { poolId: pool[0].id }, to, mode }).added > 0)

      const done = attachModule.attach(inst.io, { from: { poolId: pool[0].id }, to, mode })
      const after = registryOf(inst).campaigns[id]

      assert.deepEqual(timesOf(inst, id, 'b1'), before.b1, 'the branch of the open save changed')

      if (mode === 'same') {
        assert.equal(done.branchId, 'b2')
        assert.equal(timesOf(inst, id, 'b2').length, before.b2.length + 2)
      } else {
        assert.equal(done.branchId, 'b3')
        assert.equal(after.branches.b3.parent, 'b2')
        assert.deepEqual(timesOf(inst, id, 'b2'), before.b2)
      }
    })
  })

  test('review', 'Reset all after a migration clears the remembered views and keeps every campaign\'s mutes, pins and clusters, and the pre-campaign record; one empire\'s reset touches that campaign\'s race alone', async () => {
    const { appViews, withoutViews } = m.rememberedViews
    const { inst, first } = await migrated()
    const id = first.resolution.campaignId
    const display = ['appearance', 'appearanceCustom', 'appearanceFont', 'darkMode', 'spyNPR', 'selectedSeparator']
    const store = clone(inst.files.get('settings'))

    store.appearance = 'dark'
    store.sortOrder = 'by-name'
    store.campaign[id].race[7].mapLayer = 'geological'
    store.campaign[id].race[8] = { mapLayer: 'minerals', warningsMuted: { items: {} } }
    store.campaign.other = { race: { 7: { mapLayer: 'political', mapPinned: [1] } } }

    const legacy = JSON.stringify(store.game)

    assert.ok(legacy && legacy !== '{}', 'the migration left no pre-campaign record to protect')
    assert.deepEqual(appViews(store, display).sort(), ['other', 'sortOrder'])

    const all = withoutViews(store, display, null)

    assert.equal(all.sortOrder, undefined)
    assert.equal(all.other, undefined)
    assert.equal(all.appearance, 'dark')
    assert.equal(JSON.stringify(all.game), legacy, 'the pre-campaign record changed')
    assert.deepEqual(all.campaign[id].race[7], { warningsMuted: store.campaign[id].race[7].warningsMuted, mapPinned: [10, 11], mapGroups: store.campaign[id].race[7].mapGroups })
    assert.deepEqual(all.campaign[id].race[8], { warningsMuted: { items: {} } })
    assert.deepEqual(all.campaign.other, { race: { 7: { mapPinned: [1] } } })

    const one = withoutViews(store, display, { campaignId: id, RaceID: 7 })

    assert.equal(one.sortOrder, 'by-name')
    assert.equal(one.campaign[id].race[7].mapLayer, undefined)
    assert.equal(one.campaign[id].race[8].mapLayer, 'minerals')
    assert.equal(one.campaign.other.race[7].mapLayer, 'political')
    assert.equal(JSON.stringify(one.game), legacy)
    assert.equal(JSON.stringify(withoutViews(store, display, { campaignId: null, RaceID: 7 })), JSON.stringify(store), 'a reset of an empire with no campaign settled cleared something')
    assert.equal(JSON.stringify(store.campaign[id]).includes('mapLayer'), true, 'the settings given were changed')
  })

  // The window's settings store over the main process's store host, on real files in a temporary folder: `window()` is a store class of one window (its own requests, copied as an IPC does), all of them answered by the one host.
  const hostedStores = async () => {
    const { default: Conf } = await import('conf')
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-store-'))
    const host = m.storeHost.createStoreHost((options) => new Conf({ cwd: options.cwd ? path.join(folder, options.cwd) : folder, configName: options.name || 'config' }))
    const sent = []
    const window = () => m.storeClient.createStoreClient((request) => {
      sent.push(request)

      return structuredClone(host.handle(structuredClone(request)))
    })

    return { folder, host, sent, window, finish: () => fs.rmSync(folder, { recursive: true, force: true }) }
  }

  test('review', 'two windows share one settings store: every write of either is kept in the file and each reads the other\'s', async () => {
    const { folder, sent, window, finish } = await hostedStores()

    try {
      const A = window()
      const B = window()
      const a = new A()
      const b = new B()

      for (let index = 0; index < 20; index++) {
        a.set(`campaign.cA.race.7.k${index}`, index)
        b.set(`campaign.cB.race.7.k${index}`, index)
      }

      const stored = JSON.parse(fs.readFileSync(path.join(folder, 'config.json'), 'utf8'))

      assert.ok(!Array.isArray(stored.campaign.cA.race))
      assert.equal(Object.keys(stored.campaign.cA.race[7]).length, 20)
      assert.equal(Object.keys(stored.campaign.cB.race[7]).length, 20)
      assert.equal(a.get('campaign.cB.race.7.k19'), 19)
      assert.equal(b.get('campaign.cA.race.7.k19'), 19)
      assert.ok(a.has('campaign.cB') && !a.has('campaign.cC'))
      assert.equal(a.get('missing', 'fallback'), 'fallback')
      assert.ok(sent.length >= 40 && sent.every((request) => typeof request.op === 'string'), 'a read or a write did not go through the host')

      a.delete('campaign.cA')
      assert.equal(b.get('campaign.cA'), undefined)
      b.clear()
      assert.deepEqual(a.store, {})

      // Another file is another store: its own path and its own contents.
      const history = new (window())({ cwd: 'history', name: 'campaign-x-b1' })

      history.store = { races: { 7: { snapshots: [] } } }
      assert.ok(history.path.endsWith(path.join('history', 'campaign-x-b1.json')))
      assert.deepEqual(a.store, {})
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'history', 'campaign-x-b1.json'), 'utf8')), { races: { 7: { snapshots: [] } } })
    } finally {
      finish()
    }
  })

  test('review', 'a whole-store change that another window wrote under is made again over what is stored, so neither window\'s write is lost', async () => {
    const { window, finish } = await hostedStores()

    try {
      const a = new (window())()
      const b = new (window())()

      a.set('keep', 1)
      a.set('campaign.cA.race.7.mapLayer', 'geological')

      let calls = 0
      const result = a.update((store) => {
        calls += 1

        if (calls === 1) {
          b.set('campaign.cA.race.7.mapPinned', [1, 2])
        }

        store.campaign.cA.race[7].mapLayer = 'minerals'

        return store
      })

      assert.equal(calls, 2, 'the change was not made again over what the other window wrote')
      assert.deepEqual(result.campaign.cA.race[7], { mapLayer: 'minerals', mapPinned: [1, 2] })
      assert.deepEqual(b.store, result)

      // The Settings reset of the views, with another window writing a Display setting (which a reset keeps) during it.
      let raced = 0
      const reset = a.update((store) => {
        if (++raced === 1) {
          b.set('spyNPR', true)
        }

        return m.rememberedViews.withoutViews(store, ['spyNPR'], null)
      })

      assert.equal(raced, 2)
      assert.equal(reset.spyNPR, true, 'the reset dropped a value written under it')
      assert.equal(reset.keep, undefined)
      assert.deepEqual(reset.campaign.cA.race[7], { mapPinned: [1, 2] })

      // A change that throws writes nothing; one that never finds the store still ends and says so.
      assert.throws(() => a.update(() => { throw new Error('refused') }), /refused/)
      assert.deepEqual(b.store, reset)
      assert.throws(() => a.update((store) => {
        b.set('noise', Math.random())

        return store
      }), /kept changing/)
    } finally {
      finish()
    }
  })

  test('review', 'a write the store refuses is thrown in the window that asked and a change listener hears only this window\'s changes of its key', async () => {
    const { window, finish } = await hostedStores()

    try {
      const a = new (window())()
      const heard = []

      a.set('x', { inner: 1 })
      assert.throws(() => a.set('y', undefined), /delete/)
      assert.equal(a.has('y'), false)

      const stop = a.onDidChange('x', (value, previous) => heard.push([value, previous]))

      a.set('other', 1)
      a.set('x', { inner: 1 })
      a.set('x', { inner: 2 })
      stop()
      a.set('x', { inner: 3 })
      assert.deepEqual(heard, [[{ inner: 2 }, { inner: 1 }]])
    } finally {
      finish()
    }
  })

  test('review', 'attaching a history from before campaigns keeps a setting another window wrote to the campaign meanwhile', async () => {
    const { inst, first } = await migrated({ file: legacyFile([100, 200], { gameName: 'Another campaign' }) })
    const id = first.resolution.campaignId
    const pool = Object.values(registryOf(inst).pool)
    let raced = 0
    const settings = {
      get store() {
        return inst.io.settings.store
      },
      set store(value) {
        inst.io.settings.store = value
      },
      update: (change) => inst.io.settings.update((store) => {
        if (++raced === 1) {
          // Another window writes a page's setting of the campaign between this read and this write.
          const other = settingsOf(inst)

          other.campaign = { ...(other.campaign || {}), [id]: { race: { 7: { mapLayer: 'minerals' } } } }
          inst.files.set('settings', other)
        }

        return change(store)
      }),
    }

    attachModule.attach({ ...inst.io, settings }, { from: { poolId: pool[0].id }, to: { campaignId: id, branchId: 'b1' }, mode: 'same' })

    assert.ok(raced >= 1, 'the attach wrote no settings')
    assert.equal(kept(inst, id, 7, 'mapLayer'), 'minerals', 'the attach wrote over a setting another window wrote')
    assert.deepEqual(kept(inst, id, 7, 'mapPinned'), [10, 11])
  })

  test('review', 'an import into a campaign with a production-shaped id is undone: the backup passes its check and every key is put back', () => {
    const { planImport, commitImport, undoImport, validBackup, differingKeys } = m.preferences
    const campaignId = 'bc8233e0-0d63-49ca-8453-0575ca830219'
    const target = { gameId: 140, raceId: 784, campaignId, gameName: 'Game', raceName: 'Race' }
    const source = { gameId: 3, raceId: 5, gameName: 'Game', raceName: 'Race' }
    const store = { sortOrder: 'by-name', campaign: { [campaignId]: { race: { 784: { mapPinned: [20] } } } } }
    const entries = [{ category: 'mapGroups', scope: 'race', key: 'mapPinned', value: [10] }, { category: 'views', scope: 'race', key: 'mapLayer', value: 'minerals' }, { category: 'views', scope: 'app', key: 'sortOrder', value: 'by-size' }]
    const plan = planImport({ store, entries, source, target, categories: ['views', 'mapGroups'] })
    const { store: next, backup } = commitImport(store, plan, { target, source })

    assert.equal(plan.changes.length, 3)
    assert.equal(next.campaign[campaignId].race[784].mapLayer, 'minerals')
    assert.ok(validBackup(backup), 'a backup of a campaign with a UUID id is damaged')

    const { store: undone, restored } = undoImport(next, JSON.parse(JSON.stringify(backup)))

    assert.equal(restored, 3)
    assert.deepEqual(differingKeys(store, undone), [])
    assert.ok(!validBackup({ ...backup, entries: [{ key: `campaign.${campaignId}.__proto__.x`, had: false }] }), 'an unsafe segment was accepted')
    assert.ok(!validBackup({ ...backup, entries: [{ key: 'campaign.a.b-c.x', had: false }] }), 'a hyphen outside the campaign id was accepted')
  })

  // An import made before campaigns were recorded: what the app wrote then, keys under `game.<GameID>.race.<RaceID>`.
  const oldBackup = () => ({ format: 'aurora-electrons-preferences-backup', version: 1, at: '2026-01-01T00:00:00.000Z', target: { gameId: 1, raceId: 7, gameName: 'Campaign', raceName: 'Race' }, source: null, entries: [{ key: 'game.1.race.7.mapPinned', had: true, old: [10, 11] }, { key: 'game.1.race.7.mapLayer', had: false }], created: [] })

  test('review', 'a backup kept from before campaigns is moved to the campaign that holds the game\'s settings, and never replayed into the preserved legacy settings', async () => {
    const { adoptBackup, undoImport } = m.preferences
    const { inst, first } = await migrated({ settings: { race: { 7: { mapPinned: [20], mapLayer: 'minerals' } } } })
    const id = first.resolution.campaignId
    const campaignOf = (GameID) => campaign.legacyCampaignOf(inst.io, Number(GameID))
    const adopted = adoptBackup(oldBackup(), campaignOf)

    assert.equal(first.resolution.legacy.verdict, 'single')
    assert.equal(adopted.reason, null)
    assert.deepEqual(adopted.backup.entries.map(({ key }) => key), [`campaign.${id}.race.7.mapPinned`, `campaign.${id}.race.7.mapLayer`])

    const before = settingsOf(inst)
    const { store } = undoImport(before, adopted.backup)

    assert.equal(JSON.stringify(store.game), JSON.stringify(before.game), 'the preserved legacy settings were changed')
    assert.deepEqual(store.campaign[id].race[7].mapPinned, [10, 11])
    assert.equal(store.campaign[id].race[7].mapLayer, undefined)
    assert.equal(JSON.stringify(adoptBackup(adopted.backup, campaignOf).backup), JSON.stringify(adopted.backup), 'a backup of this version was changed')
    assert.equal(adoptBackup({ not: 'a backup' }, campaignOf).backup, null)
  })

  test('review', 'a backup kept from before campaigns for a game no campaign holds yet is not offered, says why, and is offered once the player attaches it', async () => {
    const { adoptBackup } = m.preferences
    const { inst, first } = await migrated({ file: legacyFile([100, 200], { gameName: 'Another campaign' }) })
    const id = first.resolution.campaignId
    const campaignOf = (GameID) => campaign.legacyCampaignOf(inst.io, Number(GameID))
    const waiting = adoptBackup(oldBackup(), campaignOf)

    assert.equal(waiting.backup, null)
    assert.match(waiting.reason, /game 1/)

    const pool = Object.values(registryOf(inst).pool)

    attachModule.attach(inst.io, { from: { poolId: pool[0].id }, to: { campaignId: id, branchId: 'b1' }, mode: 'same' })

    const offered = adoptBackup(oldBackup(), campaignOf)

    assert.equal(offered.reason, null)
    assert.deepEqual(offered.backup.entries.map(({ key }) => key), [`campaign.${id}.race.7.mapPinned`, `campaign.${id}.race.7.mapLayer`])
  })

  // An import as the Settings page makes it: the changes are planned again over the settings as they are when the write is made, and the undo goes with the write.
  const importInto = (config, undoStore, { entries, plan, target, source, categories }) => {
    const { planImport, commitImport, sameValue } = m.preferences
    let committed = null

    try {
      config.update((store) => {
        const current = planImport({ store, entries, source, target, categories })

        if (!sameValue(current.changes, plan.changes)) {
          throw Object.assign(new Error('The settings changed since the preview'), { changed: true })
        }

        committed = commitImport(store, current, { target, source })

        return committed.store
      }, () => ({ store: undoStore, key: 'backup', value: committed.backup }))
    } catch (error) {
      if (error.changed) {
        return null
      }

      throw error
    }

    return committed
  }

  test('review', 'an import that lost to another window\'s import is refused with its undo, and the undo kept is the one of the import that was kept', async () => {
    const { planImport, undoImport, validBackup, differingKeys } = m.preferences
    const { host, finish } = await hostedStores()

    try {
      const window = () => m.storeClient.createStoreClient((request) => structuredClone(host.handle(structuredClone(request))))
      const target = { gameId: 140, raceId: 784, campaignId: 'c1', gameName: 'Game', raceName: 'Race' }
      const source = { gameId: 3, raceId: 5, gameName: 'Game', raceName: 'Race' }
      const initial = { sortOrder: 'by-name', groupBy: 'colony' }
      const Config = window()
      const config = new Config()
      const undoStore = new Config({ name: 'preference-import-undo' })

      config.store = initial

      const proposal = (entries) => {
        const given = { entries, target, source, categories: ['views'] }

        return { ...given, plan: planImport({ store: initial, ...given }) }
      }

      const first = proposal([{ category: 'views', scope: 'app', key: 'sortOrder', value: 'by-size' }, { category: 'views', scope: 'app', key: 'groupBy', value: 'system' }])
      const second = proposal([{ category: 'views', scope: 'app', key: 'sortOrder', value: 'by-class' }])
      let ran = false
      const lateConfig = new (m.storeClient.createStoreClient((request) => {
        if (request.op === 'swap' && !ran) {
          ran = true
          assert.ok(importInto(new Config(), new Config({ name: 'preference-import-undo' }), first), 'the first import was refused')
        }

        return structuredClone(host.handle(structuredClone(request)))
      }))()
      const lost = importInto(lateConfig, new (window())({ name: 'preference-import-undo' }), second)
      const stored = new Config({ name: 'preference-import-undo' }).get('backup')

      assert.equal(ran, true)
      assert.equal(lost, null, 'an import over settings that had changed was made')
      assert.ok(validBackup(stored))
      assert.deepEqual(stored.entries.map(({ key }) => key).sort(), ['groupBy', 'sortOrder'], 'the undo kept is not the one of the import that was kept')
      assert.deepEqual(config.store, { sortOrder: 'by-size', groupBy: 'system' })
      assert.deepEqual(differingKeys(initial, undoImport(config.store, stored).store), [], 'the undo does not put every value back')

      // A companion value the store cannot write puts the file back as it was and throws.
      const before = JSON.stringify(config.store)

      assert.throws(() => config.update((store) => ({ ...store, sortOrder: 'by-name' }), () => ({ store: undoStore, key: 'backup', value: undefined })), /delete/)
      assert.equal(JSON.stringify(config.store), before, 'a write whose undo could not be written was kept')
    } finally {
      finish()
    }
  })

  test('review', 'a store that does not answer or cannot be read is thrown with a message that says which', async () => {
    const { host, folder, finish } = await hostedStores()

    try {
      const silent = new (m.storeClient.createStoreClient(() => ({ ok: false, message: '' })))()
      const none = new (m.storeClient.createStoreClient(() => undefined))()

      assert.throws(() => silent.get('a'), /did not answer/)
      assert.throws(() => none.get('a'), /did not answer/)

      fs.writeFileSync(path.join(folder, 'config.json'), 'not JSON')
      fs.mkdirSync(path.join(folder, 'history'))
      fs.writeFileSync(path.join(folder, 'history', 'campaign-x-b1.json'), '{"races":')

      const Config = m.storeClient.createStoreClient((request) => structuredClone(host.handle(structuredClone(request))))

      assert.throws(() => new Config().get('a'), /config\.json is damaged/)
      assert.throws(() => new Config({ cwd: 'history', name: 'campaign-x-b1' }).store, /history\/campaign-x-b1\.json is damaged/)

      // A companion file that cannot be read: the primary file, which is sound and put back as it was, is not the one named.
      fs.writeFileSync(path.join(folder, 'config.json'), '{"a":1}')

      const sound = new Config()

      assert.throws(() => sound.update((store) => ({ ...store, a: 2 }), () => ({ store: new Config({ cwd: 'history', name: 'campaign-x-b1' }), key: 'backup', value: 1 })), (error) => /history\/campaign-x-b1\.json is damaged/.test(error.message) && !/config\.json/.test(error.message))
      assert.deepEqual(sound.store, { a: 1 }, 'the file whose companion could not be written was kept')
    } finally {
      finish()
    }
  })

  // The settings of a version that kept `game` and each game's `race` as lists (the id is the position, an empty slot is null), the shape its settings library wrote for a numeric key.
  const listed = (map) => Array.from({ length: Math.max(...Object.keys(map).map(Number)) + 1 }, (_, id) => (map[id] === undefined ? null : map[id]))

  test('review', 'settings kept with the game and race maps as lists are migrated into the campaign as objects, with the pins kept as lists and the stored original untouched, and reset, import and rollback work on them', async () => {
    const { withoutViews } = m.rememberedViews
    const { planImport } = m.preferences
    const shapes = { 'a list of games of lists of races': { game: listed({ 1: { race: listed(legacySettings().race) } }), other: { kept: true } }, 'an object of games of lists of races': { game: { 1: { race: listed(legacySettings().race) } }, other: { kept: true } } }

    for (const [shape, stored] of Object.entries(shapes)) {
      for (const withFile of [false, true]) {
        const label = `${shape}${withFile ? ' with a legacy history' : ''}`
        const inst = installation()

        inst.files.set('settings', clone(stored))

        if (withFile) {
          inst.files.set('file:game-1', clone(legacyFile([100, 200])))
        }

        const original = JSON.stringify(stored.game)
        const first = await pass(inst, saveOf({ n: 100 }))
        const id = first.resolution.campaignId
        const settings = settingsOf(inst)

        assert.equal(first.resolution.legacy.verdict, 'single', label)
        assert.deepEqual(settings.campaign[id], legacySettings(), `${label}: the campaign did not get the settings`)
        assert.ok(!Array.isArray(settings.campaign[id].race), `${label}: the race map was copied as a list`)
        assert.ok(Array.isArray(settings.campaign[id].race[7].mapPinned), `${label}: a list of pins was changed`)
        assert.equal(JSON.stringify(settings.game), original, `${label}: the stored original was changed`)

        const viewed = clone(settings)

        viewed.campaign[id].race[7].mapLayer = 'minerals'

        const reset = withoutViews(viewed, [], { campaignId: id, RaceID: 7 })

        assert.equal(reset.campaign[id].race[7].mapLayer, undefined, `${label}: the reset skipped the views`)
        assert.deepEqual(reset.campaign[id].race[7].mapPinned, [10, 11])

        const target = { gameId: 1, raceId: 7, campaignId: id, gameName: 'Campaign', raceName: 'Race' }
        const plan = planImport({ store: settings, entries: [{ category: 'mapGroups', scope: 'race', key: 'mapPinned', value: [30] }], source: { gameId: 3, raceId: 5, gameName: 'Campaign', raceName: 'Race' }, target, categories: ['mapGroups'] })

        assert.deepEqual(plan.problems, [], `${label}: the import was refused`)
        assert.equal(plan.changes.length, 1)

        inst.files.set('settings', { ...clone(inst.files.get('settings')), game: Array.isArray(stored.game) ? [null, { changed: true }] : { 1: { changed: true } } })
        assert.equal(campaign.rollbackUnit(inst.io, 1, { keep: true }), true)
        assert.equal(JSON.stringify(inst.files.get('settings').game), original, `${label}: the rollback did not put the original back in its shape`)
        assert.equal(inst.files.get('settings').campaign, undefined)
      }
    }
  })

  test('review', 'a legacy history kept unattached whose settings were stored as lists is attached with its settings as objects', async () => {
    const stored = { game: listed({ 1: { race: listed(legacySettings().race) } }), other: { kept: true } }
    const inst = installation()

    inst.files.set('settings', clone(stored))
    inst.files.set('file:game-1', clone(legacyFile([100, 200], { gameName: 'Another campaign' })))

    const first = await pass(inst, saveOf({ n: 100 }))
    const id = first.resolution.campaignId
    const pool = Object.values(registryOf(inst).pool)

    assert.equal(first.resolution.legacy.verdict, 'ambiguous')
    assert.equal(pool.length, 1)
    attachModule.attach(inst.io, { from: { poolId: pool[0].id }, to: { campaignId: id, branchId: 'b1' }, mode: 'same' })
    assert.deepEqual(settingsOf(inst).campaign[id], legacySettings(), 'the attached settings are not objects, or are missing')
    assert.equal(JSON.stringify(settingsOf(inst).game), JSON.stringify(stored.game))
  })

  const viewOf = (prefix) => {
    const stored = new Map()
    const writes = []
    const config = { get: (key) => stored.get(key), set: (key, value) => { stored.set(key, value); writes.push([key, value]) } }
    const mixin = m.persistedView.default({ mapLocked: { key: 'mapLocked', scope: 'race', default: false } })
    const vm = { $store: { getters: { config, racePrefix: prefix } }, persistedViewPrefix: prefix, ...mixin.methods }

    mixin.beforeCreate.call(vm)
    Object.assign(vm, mixin.data.call(vm))

    return {
      vm,
      writes,
      change: (value) => {
        vm.mapLocked = value
        mixin.watch.mapLocked.handler.call(vm, value)
      },
      move: (next) => {
        const previous = vm.persistedViewPrefix

        vm.persistedViewPrefix = next
        vm.$store.getters.racePrefix = next
        mixin.watch.persistedViewPrefix.call(vm, next, previous)
      },
    }
  }

  test('review', 'a persisted field toggled away and back while no campaign is settled writes nothing when the same campaign settles, and a change that stays is written once', () => {
    const back = viewOf('campaign.a.race.7')

    back.move(null)
    back.change(true)
    back.change(false)
    back.move('campaign.a.race.7')
    assert.deepEqual(back.writes, [])
    assert.equal(back.vm.mapLocked, false)

    const kept = viewOf('campaign.a.race.7')

    kept.move(null)
    kept.change(true)
    kept.move('campaign.a.race.7')
    assert.deepEqual(kept.writes, [['campaign.a.race.7.mapLocked', true]])
    assert.equal(kept.vm.mapLocked, true)

    const other = viewOf('campaign.a.race.7')

    other.move(null)
    other.change(true)
    other.move('campaign.b.race.7')
    assert.deepEqual(other.writes, [])
    assert.equal(other.vm.mapLocked, false)
  })

  return cases
}

// ---- Real saves -------------------------------------------------------------------------------------------------------

const REAL = [
  { label: 'modded 2.7 save', file: path.join(repo, 'AuroraDB.db'), GameID: 140, RaceID: 784 },
  { label: 'stock 2.7.1 save', file: path.join(repo, 'saves', 'AuroraDB_271_skoormit_saved.db'), GameID: 138, RaceID: 785 },
]

const openReadOnly = (file) => new Promise((resolve, reject) => {
  const handle = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(handle)))
})

// A database of the shape the recorder reads: raw reads resolve to [rows], and the transaction is the one read connection.
const realDatabase = (handle) => ({
  transaction: (work) => work({ id: 'transaction' }),
  query: (sql) => new Promise((resolve, reject) => handle.all(sql, (error, rows) => (error ? reject(error) : resolve([rows])))),
})

const realChecks = async (m) => {
  const results = []
  const assert = require('./lib/bounded-assert')
  const { campaign, history } = m
  const real = []

  for (const save of REAL) {
    if (!fs.existsSync(save.file)) {
      console.log(`  skip   ${save.label}: ${path.relative(repo, save.file)} is not here`)
      continue
    }

    real.push({ ...save, handle: await openReadOnly(save.file) })
  }

  const run = async (name, work) => {
    try {
      await work()
      results.push({ group: 'real saves', name, error: null })
    } catch (error) {
      results.push({ group: 'real saves', name, error })
    }
  }

  for (const save of real) {
    const database = realDatabase(save.handle)
    const [games] = await database.query(campaign.GAMES_SQL)
    const game = games.find((row) => Number(row.GameID) === save.GameID)

    await run(`${save.label}: the identity reads work on the real tables, and the anchor and the ledger are rich enough to tell the campaign`, async () => {
      assert.ok(game, `game ${save.GameID} is not in the save`)

      const observed = await campaign.observeGame(database, game)

      assert.ok(observed.anchor.length >= campaign.MIN_ANCHOR, `the anchor has ${observed.anchor.length} systems`)
      assert.ok(observed.count > 0 && observed.digest, 'the ledger is empty')
    })

    await run(`${save.label}: the same save under another path, read twice, is the same point of the same campaign`, async () => {
      const first = await campaign.observeGame(database, game)
      const second = await campaign.observeGame(database, game, { marks: [first.count] })

      assert.deepEqual(campaign.relate({ anchor: first.anchor, tip: { n: first.count, digest: first.digest, checkpoints: first.checkpoints }, names: [{ name: first.gameName }] }, second), { relation: 'same', common: first.count, consistent: true })
    })

    await run(`${save.label}: a save recorded twice, at two paths, is one campaign with both paths attached, and a legacy file of the game is claimed once`, async () => {
      const inst = installation()
      const legacy = { gameName: game.GameName, races: { [save.RaceID]: { raceName: 'Race', npr: false, snapshots: [{ t: 1, population: 1 }] } }, intel: {} }

      inst.files.set(`file:game-${save.GameID}`, clone(legacy))

      const record = (at) => history.recordHistory(database, { storage: inst.io, path: at, now: inst.now, newId: inst.newId })
      const first = await record('C:/saves/original.db')
      const second = await record('D:/elsewhere/copy.db')
      const campaigns = activeCampaigns(inst)

      assert.equal(first.failed.length, 0, first.failed.map((failure) => failure.error && failure.error.message).join('; '))
      assert.equal(second.failed.length, 0)
      assert.equal(campaigns.filter((entry) => entry.gameIds.includes(save.GameID)).length, 1, 'the second path forked the campaign')
      assert.equal(campaigns.find((entry) => entry.gameIds.includes(save.GameID)).attachments.length, 2)
      assert.equal(JSON.stringify(inst.files.get(`file:game-${save.GameID}`)), JSON.stringify(legacy))
    })
  }

  if (real.length === 2) {
    await run('the modded and the stock save are different campaigns by their systems', async () => {
      const [one, two] = await Promise.all(real.map(async (save) => {
        const database = realDatabase(save.handle)
        const [games] = await database.query(campaign.GAMES_SQL)

        return campaign.observeGame(database, games.find((row) => Number(row.GameID) === save.GameID))
      }))

      assert.equal(campaign.relate({ anchor: one.anchor, tip: { n: one.count, digest: one.digest, checkpoints: one.checkpoints }, names: [{ name: one.gameName }] }, two).relation, 'different')
    })
  }

  real.forEach((save) => save.handle.close())

  return results
}

// ---- Running ----------------------------------------------------------------------------------------------------------

// `only`: the starts of the names of the checks to run (a mutation runs just the checks that must fail for it), or all of them.
const runSuite = async (modules, only = null) => {
  const results = []

  for (const { group, name, run } of defineSuite(modules)) {
    if (only && !only.some((start) => name.startsWith(start))) {
      continue
    }

    try {
      await run()
      results.push({ group, name, error: null })
    } catch (error) {
      results.push({ group, name, error })
    }
  }

  return results
}

// Each mutation breaks one rule of a copy of the utilities; the named checks (by the start of their text) must fail, or the check that is meant to guard the rule does not.
const MUTATIONS = [
  { name: 'a host that writes the companion before it compares', file: 'main/store-host.js', find: 'if (JSON.stringify(store.store) !== base) {\n        return false\n      }\n\n      store.store = next\n', replace: 'if (also) {\n        put(storeOf(also), also.key, also.value)\n      }\n\n      if (JSON.stringify(store.store) !== base) {\n        return false\n      }\n\n      store.store = next\n', fails: ['an import that lost to another window'] },
  { name: 'a client that does not send the companion', file: 'preload/store-client.js', find: 'also ? { ...also.store.target, key: also.key, value: also.value } : undefined', replace: 'undefined', fails: ['an import that lost to another window'] },
  { name: 'a host that keeps the write whose companion failed', file: 'main/store-host.js', find: '          store.store = JSON.parse(base)\n\n', replace: '', fails: ['an import that lost to another window'] },
  { name: 'a refusal with no message is thrown with none', file: 'preload/store-client.js', find: "(answer && answer.message) || 'The settings store did not answer'", replace: "answer ? answer.message : 'The settings store did not answer'", fails: ['a store that does not answer'] },
  { name: 'a damaged companion file is reported against the primary file', file: 'main/store-host.js', find: 'new Error(messageOf(error, also))', replace: 'error', fails: ['a store that does not answer'] },
  { name: 'a damaged store file is not named', file: 'main/store-host.js', find: 'error instanceof SyntaxError ?', replace: 'false ?', fails: ['a store that does not answer'] },
  { name: 'game settings kept as a list are not read', file: 'campaign.js', find: 'const found = Array.isArray(store.game) || isObject(store.game) ? store.game[GameID] : undefined', replace: 'const found = isObject(store.game) ? store.game[GameID] : undefined', fails: ['settings kept with the game and race maps as lists'] },
  { name: 'a race map kept as a list is copied as it is', file: 'campaign.js', find: 'if (isObject(copy) && Array.isArray(copy.race)) {', replace: 'if (false) {', fails: ['settings kept with the game and race maps as lists', 'a legacy history kept unattached whose settings'] },
  { name: 'a rollback puts a list of games back as an object', file: 'campaign.js', find: 'if (Array.isArray(settings.game)) {', replace: 'if (false) {', fails: ['settings kept with the game and race maps as lists'] },
  { name: 'an attach copies the unattached settings as they are stored', file: 'campaign-attach.js', find: 'settings: campaignSettingsOf(settings), tip: null }', replace: 'settings: clone(settings), tip: null }', fails: ['a legacy history kept unattached whose settings'] },
  { name: 'the host writes a whole store without comparing it to what the caller read', file: 'main/store-host.js', find: 'if (JSON.stringify(store.store) !== base) {', replace: 'if (false) {', fails: ['a whole-store change that another window wrote under'] },
  { name: 'a whole-store change is written without the host\'s check', file: 'preload/store-client.js', find: "if (this.call('swap', base, next, also ? { ...also.store.target, key: also.key, value: also.value } : undefined)) {", replace: "if (!this.call('write', next)) {", fails: ['a whole-store change that another window wrote under'] },
  { name: 'a whole-store change is made only once', file: 'preload/store-client.js', find: 'const ATTEMPTS = 50', replace: 'const ATTEMPTS = 1', fails: ['a whole-store change that another window wrote under'] },
  { name: 'a change listener is not told of a write', file: 'preload/store-client.js', find: "this.call('set', key, value)\n    this.changed()", replace: "this.call('set', key, value)", fails: ['a write the store refuses'] },
  { name: 'a path is set with the store\'s own set, which makes lists of numeric segments', file: 'main/store-host.js', find: '  const next = store.store\n\n  setPath(next, key, value)\n  store.store = next', replace: '  store.set(key, value)', fails: ['two windows share one settings store'] },
  { name: 'an error of the host is not thrown in the window', file: 'preload/store-client.js', find: 'if (!answer || !answer.ok) {', replace: 'if (false) {', fails: ['a write the store refuses'] },
  { name: 'an attach merges over the settings it read before', file: 'campaign-attach.js', find: 'mergeSettings(isObject(all.campaign) ? all.campaign[campaign.id] : undefined, source.settings).settings', replace: 'mergeSettings(undefined, source.settings).settings', fails: ['attaching a history from before campaigns keeps a setting'] },
  { name: 'an attach copies the pins of a race, whose branch ids are the source campaign\'s', file: 'campaign-attach.js', find: '.filter(([key]) => !BRANCH_BOUND_KEYS.includes(key))', replace: '', fails: ['attaching a campaign as a new branch never copies the pins'] },
  { name: 'a campaign id with hyphens is refused by the undo', file: 'preferences.js', find: 'const CAMPAIGN_SEGMENT = /^[A-Za-z0-9_-]+$/', replace: 'const CAMPAIGN_SEGMENT = /^[A-Za-z0-9_]+$/', fails: ['an import into a campaign with a production-shaped id'] },
  { name: 'an unsafe segment is accepted in a backup', file: 'preferences.js', find: 'const safePath = (path) => typeof path === \'string\' && path.split(\'.\').every((part, index, parts) => !UNSAFE_SEGMENTS.includes(part) &&', replace: 'const safePath = (path) => typeof path === \'string\' && path.split(\'.\').every((part, index, parts) => true &&', fails: ['an import into a campaign with a production-shaped id'] },
  { name: 'a backup from before campaigns is replayed into the legacy settings', file: 'preferences.js', find: ['return match ? `campaign.', '{campaigns.get(match[1])}', '{match[2] || \'\'}` : path'].join('$'), replace: 'return path', fails: ['a backup kept from before campaigns is moved'] },
  { name: 'a backup from before campaigns is offered for a game no campaign holds', file: 'preferences.js', find: 'if (missing !== undefined) {', replace: 'if (false) {', fails: ['a backup kept from before campaigns for a game'] },
  { name: 'a game attached to no campaign has one', file: 'campaign.js', find: ': pooled ? pooled.attachedTo.campaignId : null', replace: ': null', fails: ['a backup kept from before campaigns for a game'] },
  { name: 'Reset all clears the campaigns\' remembered values', file: 'remembered-views.js', find: "const EMPIRE_ROOTS = ['campaign', 'game']", replace: "const EMPIRE_ROOTS = ['game']", fails: ['Reset all after a migration'] },
  { name: 'a reset of an empire without a campaign clears every campaign\'s', file: 'remembered-views.js', find: '!only || (campaignId === only.campaignId && RaceID === String(only.RaceID))', replace: '!only || RaceID === String(only.RaceID)', fails: ['Reset all after a migration'] },
  { name: 'an attach goes to the branch the open save settled to, not the one picked', file: 'history.js', find: 'export const shownBranch = (branchIds, picked, settled) => (picked && branchIds.includes(picked) ? picked : settled)', replace: 'export const shownBranch = (branchIds, picked, settled) => settled', fails: ['a history from before campaigns attached'] },
  { name: 'a clear reads its race and branch when the registry lock is granted', file: 'history.js', find: 'export const clearRaceHistory = ({ campaignId, branchId, RaceID }) => withRegistry(() => {', replace: 'export const clearRaceHistory = (target) => withRegistry(() => {\n  const { campaignId, branchId, RaceID } = target\n', fails: ['a clear that waits for the registry lock'] },
  { name: 'a launch tells databases apart by letter case on Windows', file: 'main/launch.js', find: "return platform === 'win32' ? trimmed.toLowerCase() : trimmed", replace: 'return trimmed', fails: ['a launch brings forward'] },
  { name: 'a launch always opens another window', file: 'main/launch.js', find: "return found ? { action: 'focus', id: found.id } : { action: 'open' }", replace: "return { action: 'open' }", fails: ['a launch brings forward'] },
  { name: 'a launch always brings a window forward', file: 'main/launch.js', find: "return found ? { action: 'focus', id: found.id } : { action: 'open' }", replace: "return { action: 'focus', id: (found || open[0]).id }", fails: ['a launch brings forward'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the recording lock is one for every database', file: 'recording-owner.js', find: 'navigator.locks.request(`${OWNER_PREFIX}${database}`', replace: 'navigator.locks.request(OWNER_PREFIX', fails: ['windows of different databases record at the same time'] },
  { name: 'a window that moves to another database keeps the lock of the first', file: 'recording-owner.js', find: '  if (claim) {\n    claim.release()\n  }\n', replace: '', fails: ['windows of different databases record at the same time'] },
  { name: 'the recorder changes the registry without the registry lock', file: 'history.js', find: 'return withRegistry(async () => {', replace: 'return (async (work) => work())(async () => {', fails: ['every change of the registry'] },
  { name: 'the recorder settles a save read against stale tips', file: 'history.js', find: 'if (JSON.stringify(current.marks) !== JSON.stringify(first.marks)) {', replace: 'if (false) {', fails: ['a save read against the tips stored before'] },
  { name: 'a rewind trims the snapshots after the incoming time', file: 'history.js', find: '[...snapshots.filter((existing) => existing.t !== snapshot.t), snapshot]', replace: '[...snapshots.filter((existing) => existing.t < snapshot.t), snapshot]', fails: ['an older save of a campaign (a rewind)', 'merging a history never trims it'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the history file is keyed by GameID again', file: 'history.js', find: 'storage.file(branchFileName(resolution.campaignId, resolution.branchId))', replace: 'storage.file(`game-${GameID}`)', fails: ['four independent campaigns of one GameID'] },
  { name: 'the generation guard never throws', file: 'history.js', find: '    if (!isCurrent()) {\n      throw new Superseded()', replace: '    if (false) {\n      throw new Superseded()', fails: ['a pass replaced at any point writes nothing'] },
  { name: 'a rollback does not check the preserved original', file: 'campaign.js', find: 'if (hashValue(originals.history) !== originals.historyHash || hashValue(originals.settings) !== originals.settingsHash) {', replace: 'if (false) {', fails: ['a rollback whose preserved original'] },
  { name: 'a longer save is taken to agree at the stored position', file: 'campaign.js', find: 'agrees = n === 0 || opened.exact[n] === digest', replace: 'agrees = true', fails: ['a longer save that left the recorded tip'] },
  { name: 'systems that differ no longer separate campaigns', file: 'campaign.js', find: "    return 'conflict'\n  }\n\n  const [short, long]", replace: "    return 'agree'\n  }\n\n  const [short, long]", fails: ['four independent campaigns of one GameID'] },
  { name: 'a migration is committed before it is done', file: 'campaign.js', find: "    state: 'staged',\n    verdict: verdict.verdict,", replace: "    state: 'committed',\n    verdict: verdict.verdict,", fails: ['a migration interrupted at any write'] },
  { name: 'a migration clears the legacy file', file: 'campaign.js', find: "units[opened.GameID] = { ...unit, state: 'committed', committedAt: now }", replace: "units[opened.GameID] = { ...unit, state: 'committed', committedAt: now }\n  io.file(legacyFileName(opened.GameID)).store = {}", fails: ['the legacy file and the legacy settings are byte for byte'] },
  { name: 'a campaign is identified by its name', file: 'campaign.js', find: 'const judged = campaignsOfGame(registry, opened.GameID).map(', replace: 'const judged = campaignsOfGame(registry, opened.GameID).filter((candidate) => candidate.names[candidate.names.length - 1].name === opened.gameName).map(', fails: ['a game renamed in the game'] },
  { name: 'a branch is seeded with the whole parent', file: 'campaign.js', find: 'store = upTo(io.file(branchFileName(campaign.id, parent.id)).store, forkTime)', replace: 'store = upTo(io.file(branchFileName(campaign.id, parent.id)).store, Infinity)', fails: ['a save replayed from an earlier point'] },
  { name: 'a branch inherits the parent\'s thinning record unchanged', file: 'campaign.js', find: 'return thinning ? { ...fields, thinning } : fields', replace: 'return { ...fields, thinning: record.thinning }', fails: ['a branch seeded at a fork carries the parent'] },
  { name: 'a thinning after the fork is carried over to the branch', file: 'campaign.js', find: ' || (thinning.passes && thinning.last.t > t)) {', replace: ') {', fails: ['a branch seeded at a fork carries the parent'] },
  { name: 'a record the parent no longer matched is believed by the branch', file: 'campaign.js', find: '!thinning.complete || thinning.witness !== witnessOf(record.snapshots) || (thinning.passes', replace: '!thinning.complete || (thinning.passes', fails: ['a branch seeded at a fork carries the parent'] },
  { name: 'a branch keeps the parent\'s digest of game times', file: 'campaign.js', find: 'return { ...thinning, witness: witnessOf(kept) }', replace: 'return thinning', fails: ['a branch seeded at a fork carries the parent'] },
  { name: 'an attach overwrites the settings the target has', file: 'campaign-attach.js', find: 'if (merged.race[RaceID][key] === undefined) {', replace: 'if (true) {', fails: ['attaching a campaign to another merges'] },
  { name: 'a contradicting ledger no longer separates campaigns', file: 'campaign.js', find: 'if (contradicts(stored.tip, opened, known, agrees)) {', replace: 'if (false) {', fails: ['a path alone never joins a save', 'a short save of another campaign'] },
  { name: 'a path attaches a save whose ledger does not hold the recorded tip', file: 'campaign.js', find: 'thin.some((row) => row.consistent && row.branch.id === attachment.branchId)', replace: 'thin.some((row) => row.branch.id === attachment.branchId)', fails: ['a thin-anchor continuation at its own path'] },
  { name: 'the early digests are all equal', file: 'campaign.js', find: '    if (EARLY_COUNTS.includes(count)) {\n      early[count] = digest', replace: "    if (EARLY_COUNTS.includes(count)) {\n      early[count] = ''", fails: ['the early digests of a ledger'] },
  { name: 'an answered path is ranked with the rest', file: 'campaign.js', find: 'Number(b.explicit) - Number(a.explicit) || ', replace: '', fails: ['a save the player attached or kept apart'] },
  { name: 'an attach leaves the tip behind', file: 'campaign-attach.js', find: '} else if (source.tip && source.tip.n >= campaign.branches[branchId].tip.n) {', replace: '} else if (false) {', fails: ['an attach carries the evidence'] },
  { name: 'an attach is applied again', file: 'campaign-attach.js', find: 'if (done && done.campaignId === to.campaignId) {', replace: 'if (false) {', fails: ['an attach carries the evidence'] },
  { name: 'an attach repeats a path it already holds', file: 'campaign-attach.js', find: 'const known = campaign.attachments.find((other) => other.path === attachment.path && other.GameID === attachment.GameID)', replace: 'const known = null', fails: ['an attach holds a path of one game once'] },
  { name: 'a damaged registry is read as it is', file: 'campaign.js', find: 'const validRegistry = (stored) => {\n', replace: 'const validRegistry = (stored) => {\n  if (true) {\n    return\n  }\n\n', fails: ['a damaged campaign registry'] },
  { name: 'a resolution outlives the copy of the save it was settled on', file: 'renderer/store/history.js', find: 'return settled && settled.generation === rootState.freshness.generation ? settled : null', replace: 'return settled || null', fails: ['a game settled on one copy of a save'] },
  { name: 'a snapshot summary outlives the copy of the save its campaign was settled on', file: 'renderer/store/history.js', find: 'if (!campaign || campaign.generation !== generation) {', replace: 'if (!campaign) {', fails: ['the snapshot summary of a game'] },
  { name: 'an empty recorded ledger is taken as evidence under a thin anchor', file: 'campaign.js', find: '!!known && !!agrees && (n > 0 || anchor === \'agree\')', replace: '!!known && !!agrees', fails: ['an empty recorded ledger'] },
  { name: 'a registry write ignores a change made since its read', file: 'campaign.js', find: 'if (read !== undefined && JSON.stringify(io.registry.store) !== read) {', replace: 'if (false) {', fails: ['two tabs sharing one browser storage'] },
  { name: 'a changed registry is not decided again', file: 'history.js', find: 'const SETTLE_ATTEMPTS = 3', replace: 'const SETTLE_ATTEMPTS = 1', fails: ['two tabs sharing one browser storage'] },
  { name: 'a tab that is not the owner may write', file: 'recording-owner.js', find: 'if (state !== \'owner\') {\n    throw new ReadOnly()', replace: 'if (false) {\n    throw new ReadOnly()', fails: ['a tab that does not own recording'] },
  { name: 'a tab that is not the owner starts a pass', file: 'recording-owner.js', find: 'if (state === \'owner\') {\n    return true\n  }\n\n  let timer', replace: 'if (true) {\n    return true\n  }\n\n  let timer', fails: ['a tab that does not own recording'] },
  { name: 'a waiting tab is never told it owns the recording', file: 'recording-owner.js', find: 'onOwner()\n', replace: '', fails: ['a tab that does not own recording'] },
  { name: 'a tab does not wait for the lock a reloaded page is releasing', file: 'recording-owner.js', find: 'return await Promise.race([granted, late])', replace: 'return await late', fails: ['a reloaded tab'] },
  { name: 'a player\'s answer ignores the ownership', file: 'campaign-attach.js', find: 'export const keepSeparate = (io, campaignId) => {\n  requireRecording()', replace: 'export const keepSeparate = (io, campaignId) => {', fails: ['a tab that does not own recording'] },
  { name: 'an attach ignores the ownership', file: 'campaign-attach.js', find: 'guard = () => {} }) => {\n  requireRecording()', replace: 'guard = () => {} }) => {', fails: ['a tab that does not own recording'] },
  { name: 'a history store writes whole for a tab that is not the owner', file: 'history.js', find: 'set store (value) {\n        requireRecording()\n', replace: 'set store (value) {\n', fails: ['a tab that does not own recording'] },
  { name: 'a history store sets a path for a tab that is not the owner', file: 'history.js', find: 'set: (path, value) => {\n        requireRecording()\n', replace: 'set: (path, value) => {\n', fails: ['a tab that does not own recording'] },
  { name: 'a refused tab starts a second pass beside the one that is waiting', file: 'renderer/plugins/history.js', find: "latest.status === 'refused'", replace: "latest.status !== 'done'", fails: ['a refused tab that already has a newer pass'] },
  { name: 'a refused tab does not record when the owner closes', file: 'renderer/plugins/history.js', find: "latest.status === 'refused'", replace: 'false', fails: ['a refused tab with no pass waiting'] },
  { name: 'a change back to the restored value stays queued', file: 'renderer/mixins/persisted-view.js', find: 'delete this.$_persistedViewWaiting[name]', replace: 'void 0', fails: ['a persisted field toggled away and back'] },
]

// One mutation broken in `copy` (and put back after), with the cases it names run against it.
const applyMutation = async (copy, mutation) => {
  const target = path.join(copy, mutation.file.includes('/') ? mutation.file : `renderer/utilities/${mutation.file}`)
  const original = fs.readFileSync(target, 'utf8')
  const parts = original.split(mutation.find)

  if (parts.length !== 2) {
    return { group: 'mutations', name: mutation.name, error: new Error(`the text to break occurs ${parts.length - 1} times in ${mutation.file}, not once: the mutation no longer applies`) }
  }

  fs.writeFileSync(target, parts.join(mutation.replace))

  try {
    const modules = await loadModules(copy)
    const outcome = await runSuite(modules, mutation.fails)
    const failed = outcome.filter((entry) => entry.error)
    const missed = mutation.fails.filter((start) => !failed.some((entry) => entry.name.startsWith(start)))

    return { group: 'mutations', name: `${mutation.name} (fails: ${mutation.fails.join('; ')})`, error: missed.length ? new Error(`the checks that guard this did not fail: ${missed.join('; ')}`) : null }
  } catch (error) {
    return { group: 'mutations', name: mutation.name, error }
  } finally {
    fs.writeFileSync(target, original)
  }
}

// The mutations run in child processes, several side by side (CHECK_JOBS): each child copies the sources once and judges its share one after another, the way the whole run once did in one process, so no two mutations share a copy, a module or a global. `--mutants=<i>,<i>` is the child's mode; its last line is the list of its results.
const MUTANTS_PREFIX = 'MUTANTS_RESULT '
const CHILD_MUTANTS = process.argv.filter((argument) => argument.startsWith('--mutants=')).map((argument) => argument.slice(10).split(',').map(Number))[0]

const childMain = async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-campaigns-'))
  const results = []

  try {
    copySources(copy)

    for (const index of CHILD_MUTANTS) {
      const { group, name, error } = await applyMutation(copy, MUTATIONS[index])

      results.push({ group, name, error: error ? String(error.stack || error.message) : null })
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  process.stdout.write(`${MUTANTS_PREFIX}${JSON.stringify(results)}\n`, () => process.exit(0))
}

const applyMutations = async () => {
  const chunks = chunksOf(MUTATIONS.length)
  const outcomes = spread(chunks, await inParallel(chunks, async (chunk) => lastJson(await runChild(__filename, [`--mutants=${chunk.join(',')}`]), MUTANTS_PREFIX)))

  return outcomes.map((outcome, index) => (outcome instanceof Error ? { group: 'mutations', name: MUTATIONS[index].name, error: outcome } : { ...outcome, error: outcome.error === null ? null : Object.assign(new Error(outcome.error.split('\n')[0]), { stack: outcome.error }) }))
}

const main = async () => {
  const modules = await loadModules(src)
  const results = [...await runSuite(modules), ...await realChecks(modules)]

  if (!process.argv.includes('--no-mutations')) {
    results.push(...await applyMutations())
  }

  let group = null

  results.forEach(({ group: next, name, error }) => {
    if (next !== group) {
      group = next
      console.log(`\n${group}`)
    }

    console.log(error ? `  FAIL   ${name}\n         ${String(error.stack || error.message).split('\n').slice(0, 6).join('\n         ')}` : `  ok     ${name}`)
  })

  const failed = results.filter((entry) => entry.error).length

  console.log(`\n${results.length} checks: ${results.length - failed} ok, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

;(CHILD_MUTANTS ? childMain() : main()).catch((error) => {
  console.error(error)
  process.exit(2)
})
