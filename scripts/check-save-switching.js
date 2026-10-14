/*
  Checks that the app moves between saves as one step: the real store, the real database module over real SQLite saves, the real recorder plugin, the real watcher and the real save service of the main process, with only the Electron pieces stood in for (the IPC calls are answered by the real service over a window registry, the file dialog and the file-watching library are fakes, or the real chokidar for the watcher checks).

  Each case builds a fresh app over two saves that share a game and race number (GameID 140, race 784) but are different campaigns: a copy of AuroraDB.db, and a copy whose systems and names were changed. Cases that need a file system or a database of their own work on copies in the temp folder; the saves are never changed.

  Each mutation breaks one rule in a copy of the sources; the named cases must fail, or the case that is meant to guard the rule does not. Run: node scripts/check-save-switching.js [--no-mutations] [--only=<start of a case name>]. Needs ./AuroraDB.db.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')
const assert = require('assert').strict

const { loadUtilities } = require('./lib/utilities')

const repo = path.resolve(__dirname, '..')
const src = path.join(repo, 'src')
const requireHere = createRequire(`${repo}/`)

const GAME = 140
const RACE = 784
const FLAG = 'probe-flag.png'
const SAVE = path.join(repo, 'AuroraDB.db')

// The packages the sources import. The real sequelize and sqlite3 open the real files; the others are as small as the cases allow.
const STUBS = {
  'electron-store': `
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const walk = (object, key) => String(key).split('.').reduce((found, part) => (found === undefined || found === null ? undefined : found[part]), object)
export default class Config {
  constructor (options = {}) { this.key = \`\${options.cwd || ''}|\${options.name || 'config'}\` }
  get path () { return this.key }
  get store () { return clone(globalThis.__stores.get(this.key)) || {} }
  set store (value) { globalThis.__stores.set(this.key, clone(value)) }
  get (key, fallback) { const found = walk(this.store, key); return found === undefined ? fallback : found }
  set (key, value) { const whole = this.store; const parts = String(key).split('.'); const last = parts.pop(); let at = whole; parts.forEach((part) => { at = at[part] = at[part] || {} }); at[last] = value; this.store = whole }
  update (change) { this.store = change(this.store); return this.store }
}`,
  dayjs: `import { createRequire } from 'module'; export default createRequire(${JSON.stringify(`${repo}/`)})('dayjs')`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'module'; export default createRequire(${JSON.stringify(`${repo}/`)})('dayjs/plugin/utc')`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  electron: 'export const ipcRenderer = globalThis.__ipc',
  vue: `import { createRequire } from 'module'; const vue = createRequire(${JSON.stringify(`${repo}/`)})('vue'); export const markRaw = vue.markRaw; export default vue`,
  chokidar: 'export default { watch: (...args) => globalThis.__chokidar(...args) }',
  sequelize: `import { createRequire } from 'module'; const sequelize = createRequire(${JSON.stringify(`${repo}/`)})('sequelize'); export const Model = sequelize.Model; export const Sequelize = sequelize.Sequelize; export default sequelize`,
}

const MODULES = [
  'main/saves',
  'main/launch',
  'renderer/store/index',
  'renderer/store/saves',
  'renderer/store/empires',
  'renderer/store/freshness',
  'renderer/store/history',
  'renderer/store/navigation',
  'renderer/store/peeks',
  'renderer/store/capabilities',
  'renderer/utilities/flags',
  'renderer/utilities/database',
  'renderer/utilities/retired',
  'renderer/utilities/map-positions',
  'renderer/utilities/recording-owner',
  'renderer/utilities/history',
  'renderer/plugins/database',
  'renderer/plugins/history',
]

const CASE_TIMEOUT_MS = 180000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (test, label, timeout = 30000) => {
  const start = Date.now()

  while (!test()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for ${label}`)
    }

    await sleep(20)
  }
}

// ---- The saves ---------------------------------------------------------------------------------------------------------

const sqliteRun = (file, sql) => {
  const sqlite3 = requireHere('sqlite3')

  return new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(file, (error) => {
      if (error) {
        return reject(error)
      }

      handle.exec(sql, (failure) => {
        handle.close(() => (failure ? reject(failure) : resolve()))
      })
    })
  })
}

const FLAG_BYTES = { a: 'flag of save A', b: 'flag of save B' }

// A folder per save, the way Aurora keeps one: AuroraDB.db and the Flags folder beside it. The second save is the first one replayed under other names and with other systems, so it is a different campaign that shares GameID and RaceID.
const makeSaves = async (root) => {
  const folder = (name) => {
    const directory = path.join(root, name)

    fs.mkdirSync(path.join(directory, 'Flags'), { recursive: true })

    return directory
  }
  const make = async (name, extra = '') => {
    const directory = folder(name)
    const file = path.join(directory, 'AuroraDB.db')

    fs.copyFileSync(SAVE, file)
    await sqliteRun(file, `update FCT_Race set FlagPic = '${FLAG}' where GameID = ${GAME} and RaceID = ${RACE};${extra}`)
    fs.writeFileSync(path.join(directory, 'Flags', FLAG), FLAG_BYTES[name[0]] || name)

    return file
  }
  const a = await make('a')
  const b = await make('b', `update FCT_System set AbundanceModifier = AbundanceModifier + 1 where GameID = ${GAME}; update FCT_Game set GameName = GameName || ' (B)' where GameID = ${GAME}; update FCT_Race set RaceTitle = 'B ' || RaceTitle where GameID = ${GAME};`)

  return { a, b, make, folder }
}

const flagData = (name) => `data:image/png;base64,${Buffer.from(FLAG_BYTES[name]).toString('base64')}`

// ---- The app -----------------------------------------------------------------------------------------------------------

// Two windows' worth of main process: which database each window shows, and what focusing one does.
const windowsOf = (initial) => {
  const map = new Map(initial)
  const focused = []

  return {
    map,
    focused,
    list: () => [...map].map(([id, database]) => ({ id, database })),
    databaseOf: (id) => map.get(id),
    has: (id) => map.has(id),
    switchTo: (id, database) => map.set(id, database),
    focus: (id) => focused.push(id),
    parent: () => null,
  }
}

// chokidar as the plugin sees it. 'fake' hands out watchers that report the file as present at once and never again, or the real library; either way every watcher is counted.
const chokidarOf = (mode, watchers) => (file, options) => {
  const handlers = {}
  let real = null
  const watcher = {
    file,
    closed: false,
    on (event, handler) {
      if (real) {
        real.on(event, handler)
      } else {
        (handlers[event] = handlers[event] || []).push(handler)
      }

      return watcher
    },
    // The library hands an error alone, every other event the path first.
    emit: (event, ...args) => (handlers[event] || []).forEach((handler) => (event === 'error' ? handler(...args) : handler(file, ...args))),
    async close () {
      watcher.closed = true

      return real ? real.close() : undefined
    },
  }

  if (mode === 'real') {
    real = requireHere('chokidar').watch(file, options)
  } else {
    setTimeout(() => watcher.emit('add', {}), 0)
  }

  watchers.push(watcher)

  return watcher
}

// A fake of the Web Locks API: exclusive locks by name, queued in order. `held` is the names held now.
const installLocks = () => {
  const queues = new Map()
  const held = new Set()
  const locks = {
    request (name, callback) {
      const run = (queues.get(name) || Promise.resolve()).then(async () => {
        held.add(name)

        try {
          return await callback()
        } finally {
          held.delete(name)
        }
      })

      queues.set(name, run.catch(() => {}))

      return run
    },
  }

  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true })

  return held
}

// The worlds of the case running: their connections and watchers are closed after it, so no file stays open.
const LIVE = []

const closeWorlds = async (m) => {
  for (const { store, watchers, recoverer } of LIVE.splice(0)) {
    // The recovery controller first: its timers and its subscription to the refresh end, so nothing opens the save again while the rest is closed.
    await recoverer.stop()
    await Promise.all(watchers.filter((watcher) => !watcher.closed).map((watcher) => watcher.close()))
    await m['renderer/utilities/database'].retireDatabase(store.state.database).catch(() => {})
  }

  m['renderer/utilities/recording-owner'].releaseRecording()
}

const buildWorld = async (m, { start, saves, windows = null, chokidar = 'fake', recording = false, recent = [], dialog = null, hold = {}, onDatabase = null, recovery = undefined }) => {
  const Vue = requireHere('vue')
  const Vuex = requireHere('vuex')

  Vue.use(Vuex)
  globalThis.__stores = new Map()
  m['renderer/utilities/recording-owner'].releaseRecording()

  const registry = windows || windowsOf([[1, start]])
  const memory = { value: { version: 1, saves: recent.map((file) => ({ path: file, openedAt: 1 })) } }
  const recentList = m['main/saves'].createRecent({ store: { read: () => memory.value, write: (value) => { memory.value = JSON.parse(JSON.stringify(value)) } } })
  const picker = { next: dialog }
  const service = m['main/saves'].createSaveService({ windows: registry, recent: recentList, dialog: { showOpenDialog: async () => picker.next || { canceled: true, filePaths: [] } }, fs: fs.promises, log: { error () {} } })
  const calls = []
  const flagRequests = []
  const ipc = {
    calls,
    flagRequests,
    hold,
    async invoke (channel, ...args) {
      calls.push([channel, ...args])

      switch (channel) {
        case 'request-storage-path':
          service.opened(registry.databaseOf(1))

          return registry.databaseOf(1)
        case 'saves:state':
          return service.state(1)
        case 'saves:choose':
          return service.choose(1)
        case 'saves:select':
          return service.select(1, args[0])
        case 'saves:forget':
          return service.forget(1, args[0])
        case 'read-flag': {
          // As src/main/index.js answers it: the Flags folder beside the save the window has open, and nothing for a save it has left.
          const [name, database] = args

          flagRequests.push(database)

          if (!service.flagsBelongTo(1, database)) {
            return null
          }

          let answer = null

          try {
            answer = `data:image/png;base64,${fs.readFileSync(path.join(path.dirname(registry.databaseOf(1)), 'Flags', path.basename(name))).toString('base64')}`
          } catch (error) {
            answer = null
          }

          // The answer reaches the window later than the file was read.
          if (hold.flag) {
            await hold.flag
          }

          return answer
        }
        default:
          throw new Error(`Unhandled IPC channel ${channel}`)
      }
    },
  }
  const watchers = []

  globalThis.__ipc.target = ipc
  globalThis.__chokidar = chokidarOf(chokidar, watchers)

  const module = (name) => m[`renderer/store/${name}`]
  const root = module('index')
  const store = new Vuex.Store({
    state: root.state,
    getters: root.getters,
    mutations: root.mutations,
    actions: root.actions,
    modules: ['saves', 'empires', 'freshness', 'history', 'navigation', 'peeks', 'capabilities'].reduce((all, name) => ({ ...all, [name]: { namespaced: true, state: module(name).state, getters: module(name).getters, mutations: module(name).mutations, actions: module(name).actions } }), {}),
  })

  store.$router = { currentRoute: { path: '/production' }, push (to) { this.currentRoute.path = to } }

  // Before anything reacts to a new database, a case may instrument it.
  if (onDatabase) {
    store.watch((state) => state.database, (database) => database && onDatabase(database), { sync: true })
  }

  // As layouts/default.vue does: the empire list is read from every database the store opens.
  store.watch((state) => state.database, (database) => database && store.dispatch('empires/load'))
  // The page's own window for each world, so the listeners of a world that was closed hear nothing; Vue and Vuex are loaded above, before a window exists.
  globalThis.window = new EventTarget()
  const watcher = m['renderer/plugins/database'].default({ store, recovery })

  if (recording) {
    m['renderer/plugins/history'].default({ store, ownerGrace: 50 })
  }

  const world = { store, ipc, registry, service, recent: recentList, memory, picker, watchers, saves, start, recoverer: watcher }

  world.settled = (file) => until(() => store.state.savePath === file && store.state.databasePath === file && store.state.database && store.state.empires.loaded && store.state.empires.games.length > 0, `the app to show ${file}`)
  world.names = () => store.state.empires.games.map((game) => game.GameName)
  world.live = () => watchers.filter((watcher) => !watcher.closed)

  LIVE.push(world)

  await world.settled(start)

  return world
}

// ---- The cases ---------------------------------------------------------------------------------------------------------

const defineSuite = (m, fixtures, base) => {
  const cases = []
  const test = (name, run) => cases.push({ name, run })
  const { a, b } = fixtures
  const flags = () => m['renderer/utilities/flags']
  const world = (options) => buildWorld(m, { start: a, saves: fixtures, ...options })
  // A folder of the case's own, removed after the worlds that opened files in it are closed.
  const scratch = async (prefix, work) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

    let failure = null

    try {
      await work(root)
    } catch (error) {
      failure = error
    }

    await Promise.all(HELD.splice(0).map((release) => release()))
    await closeWorlds(m)

    // What the case found wrong is the answer; a folder that cannot be removed after it says nothing more.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (error) {
      failure = failure || error
    }

    if (failure) {
      throw failure
    }
  }

  test('an A to B to A switch shows the games and the flags of the save open each time', async () => {
    const w = await world({})
    const [gameA] = w.store.state.empires.games

    assert.equal(w.store.state.savePath, a)
    assert.equal(await flags().flagUrl(FLAG), flagData('a'))

    assert.equal((await w.store.dispatch('saves/select', b)).action, 'switched')
    await w.settled(b)

    assert.notEqual(w.names()[0], gameA.GameName)
    assert.match(w.names()[0], / \(B\)$/)
    assert.equal(w.store.state.empires.games[0].GameID, GAME, 'the two saves share the game number')
    assert.equal(await flags().flagUrl(FLAG), flagData('b'))
    assert.equal(await w.ipc.invoke('request-storage-path'), b, 'the main process names the active save')

    assert.equal((await w.store.dispatch('saves/select', a)).action, 'switched')
    await w.settled(a)

    assert.equal(w.names()[0], gameA.GameName)
    assert.equal(await flags().flagUrl(FLAG), flagData('a'), 'the flag of the first visit to A was kept for B')
  })

  test('a switch drops the game, the race, the empire list and what was read of the save left before the new one is shown', async () => {
    const w = await world({})
    const [game] = w.store.state.empires.games

    await w.store.dispatch('changeGame', { game, race: game.Races.find((race) => race.RaceID === RACE) })
    w.store.commit('navigation/reset', '/production')
    w.store.commit('history/failures', [{ GameID: GAME, stage: 'write' }])
    w.store.commit('history/resolved', { GameID: GAME, resolution: { campaignId: 'left', branchId: 'b1' }, generation: w.store.state.freshness.generation })
    assert.equal(w.store.state.RaceID, RACE)
    assert.equal(w.store.getters.campaignId, 'left')

    const before = w.store.state.database

    await w.store.dispatch('saves/select', b)

    assert.equal(w.store.state.GameID, null, 'the game of the old save is still picked')
    assert.equal(w.store.state.RaceID, null, 'the race of the old save is still picked')
    assert.equal(w.store.state.empires.games.length, 0, 'the old save’s games are still listed')
    assert.equal(w.store.state.freshness.read, null, 'a read of the old save still counts')
    assert.deepEqual(w.store.state.history.campaigns, {}, 'the old save’s settled campaigns are still kept')
    assert.deepEqual(w.store.state.history.failures, [], 'what failed for the old save is still reported')
    assert.equal(w.store.getters.racePrefix, null)
    assert.equal(w.store.state.savePath, b)
    assert.notEqual(w.store.state.database, before, 'the old database is still the open one')
    assert.equal(w.store.$router.currentRoute.path, '/', 'the page of the old save is still shown')
    await w.settled(b)
  })

  test('a late flag for the save left is dropped, never shown under the save entered', async () => {
    let release = null
    const hold = { flag: new Promise((resolve) => { release = resolve }) }
    const w = await world({ hold })
    const late = flags().flagUrl(FLAG)

    await until(() => w.ipc.flagRequests.length === 1, 'the flag request')
    assert.equal((await w.store.dispatch('saves/select', b)).action, 'switched')
    await w.settled(b)

    release()

    assert.equal(await late, null, 'the answer for A reached B')
    assert.equal(w.service.flagsBelongTo(1, a), false, 'the main process still answers for the save left')

    w.ipc.hold.flag = null

    assert.equal(await flags().flagUrl(FLAG), flagData('b'))
  })

  test('a late empire list for the save left does not fill the save entered', async () => {
    const w = await world({})
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const old = w.store.state.database
    const query = old.query

    old.query = async (...args) => {
      const rows = await query(...args)

      await gate

      return rows
    }

    w.store.dispatch('empires/load')
    await sleep(50)
    assert.equal((await w.store.dispatch('saves/select', b)).action, 'switched')
    await w.settled(b)

    release()
    await sleep(300)

    assert.match(w.names()[0], / \(B\)$/, 'the late list of A replaced the games of B')
  })

  test('closing the dialog changes nothing', async () => {
    const w = await world({})
    const before = { database: w.store.state.database, savePath: w.store.state.savePath, generation: w.store.state.freshness.generation, windows: w.registry.list(), recent: JSON.stringify(w.memory.value), watchers: w.watchers.length }

    w.picker.next = { canceled: true, filePaths: [] }

    const result = await w.store.dispatch('saves/choose')

    await sleep(100)

    assert.equal(result.action, 'canceled')
    assert.equal(w.store.state.database, before.database)
    assert.equal(w.store.state.savePath, before.savePath)
    assert.equal(w.store.state.freshness.generation, before.generation)
    assert.deepEqual(w.registry.list(), before.windows)
    assert.equal(JSON.stringify(w.memory.value), before.recent)
    assert.equal(w.watchers.length, before.watchers)
    assert.equal(w.store.state.saves.notice, null)
    assert.equal(w.store.state.saves.busy, false)
  })

  test('a file chosen in the dialog is opened and kept as the most recent save', async () => {
    const w = await world({})

    w.picker.next = { canceled: false, filePaths: [b] }

    assert.equal((await w.store.dispatch('saves/choose')).action, 'switched')
    await w.settled(b)
    assert.equal(w.store.state.saves.notice.tone, 'success')
    assert.equal(w.recent.list()[0].path, b)
  })

  test('a recent save that is missing, is not a save or cannot be reached stays listed with its reason and a retry, and the active save is untouched', async () => {
    await scratch('aurora-recent-', async (root) => {
      const missing = path.join(root, 'gone', 'AuroraDB.db')
      const folder = path.join(root, 'folder.db')
      const text = path.join(root, 'text.db')

      fs.mkdirSync(folder)
      fs.writeFileSync(text, 'not a database, only text')

      const w = await world({ recent: [missing, folder, text, a] })
      const state = await w.ipc.invoke('saves:state')

      assert.equal(state.active.path, a)
      assert.equal(state.active.state, 'available')

      ;[missing, folder, text].forEach((file) => {
        const entry = state.recent.find((candidate) => candidate.path === file)

        assert.ok(entry, `${file} was dropped from the list`)
        assert.equal(entry.state, 'unavailable')
        assert.ok(entry.reason && entry.reason.length > 5, `${file} gives no reason`)
      })

      const database = w.store.state.database
      const result = await w.store.dispatch('saves/select', missing)

      assert.equal(result.action, 'unavailable')
      assert.equal(w.store.state.saves.notice.retry, missing, 'the notice offers no retry')
      assert.ok(w.store.state.saves.notice.text.includes(a), 'the notice does not say which save stays active')
      assert.equal(w.store.state.savePath, a)
      assert.equal(w.store.state.database, database)
      assert.equal(w.registry.databaseOf(1), a)
      assert.ok(w.recent.list().some((entry) => entry.path === missing), 'the unreachable save left the list')

      // The save turns up: the same entry opens.
      fs.mkdirSync(path.dirname(missing))
      fs.copyFileSync(b, missing)

      assert.equal((await w.store.dispatch('saves/select', missing)).action, 'switched')
      await w.settled(missing)
    })
  })

  test('a save that cannot be reached is the active one: it is reported with its reason and a retry', async () => {
    await scratch('aurora-active-', async (root) => {
      const file = path.join(root, 'moved', 'AuroraDB.db')
      const w = await world({ recent: [file] })

      // The save the window shows goes away (the main process keeps naming it).
      w.registry.switchTo(1, file)

      const state = await w.ipc.invoke('saves:state')

      assert.equal(state.active.path, file)
      assert.equal(state.active.state, 'unavailable')
      assert.ok(state.active.reason)
      assert.equal(state.recent.find((entry) => entry.path === file).active, true, 'the active save is not marked in the list')

      fs.mkdirSync(path.dirname(file))
      fs.copyFileSync(a, file)
      assert.equal((await w.ipc.invoke('saves:state')).active.state, 'available', 'a retry still finds it unavailable')
    })
  })

  test('the recent list keeps the ten latest saves, once each, newest first', async () => {
    const memory = { value: undefined }
    const recent = m['main/saves'].createRecent({ store: { read: () => memory.value, write: (value) => { memory.value = JSON.parse(JSON.stringify(value)) } } })

    for (let index = 1; index <= 13; index++) {
      recent.note(path.join(os.tmpdir(), `save-${index}.db`))
    }

    recent.note(path.join(os.tmpdir(), 'save-9.db'))

    const list = recent.list().map((entry) => path.basename(entry.path))

    assert.equal(list.length, m['main/saves'].RECENT_LIMIT)
    assert.equal(list.length, 10)
    assert.deepEqual(list.slice(0, 3), ['save-9.db', 'save-13.db', 'save-12.db'])
    assert.equal(new Set(list).size, 10)
    assert.ok(!list.includes('save-1.db') && !list.includes('save-3.db'))

    memory.value = { saves: 'damaged' }
    assert.throws(() => recent.list(), /damaged/)
  })

  test('a save open in another window is brought forward, and this window stays on its own save', async () => {
    const windows = windowsOf([[1, a], [2, b]])
    const w = await world({ windows })
    const database = w.store.state.database
    const result = await w.store.dispatch('saves/select', b)

    await sleep(100)

    assert.equal(result.action, 'focused')
    assert.deepEqual(windows.focused, [2])
    assert.equal(windows.databaseOf(1), a)
    assert.equal(windows.databaseOf(2), b)
    assert.equal(w.store.state.savePath, a)
    assert.equal(w.store.state.database, database)
    assert.ok(w.store.state.saves.notice.text.includes('another window'))
    assert.equal((await w.ipc.invoke('saves:state')).recent.find((entry) => entry.path === b).openElsewhere, true)
  })

  test('a switch gives up the recording lock of the save left, and the save entered is recorded under its own', async () => {
    const held = installLocks()
    const w = await world({})
    const names = () => [...held].filter((name) => name.includes('recording-owner'))

    m['renderer/utilities/recording-owner'].claimRecording({ database: a })
    await until(() => names().length === 1, 'the lock of A')
    assert.ok(names()[0].endsWith(a))

    await w.store.dispatch('saves/select', b)
    await w.settled(b)
    await sleep(100)

    assert.deepEqual(names(), [], 'the lock of the save left is still held after the switch')

    m['renderer/utilities/recording-owner'].claimRecording({ database: b })
    await until(() => names().length === 1 && names()[0].endsWith(b), 'the lock of B and no other')
  })

  test('the save left is closed once the switch resolves, so its file can be removed', async () => {
    await scratch('aurora-retire-', async (root) => {
      const file = path.join(root, 'AuroraDB.db')

      fs.copyFileSync(a, file)

      const w = await world({ start: file })
      const old = w.store.state.database

      w.registry.switchTo(1, b)
      await w.store.dispatch('openSave', { path: b })
      await assert.rejects(Promise.resolve().then(() => old.query('select 1')), 'the old connection still answers')
      fs.rmSync(file)
      await w.settled(b)
    })
  })

  test('a second request while one is out is refused, and only one switch happens', async () => {
    const w = await world({})
    const generation = w.store.state.freshness.generation
    const first = w.store.dispatch('saves/select', b)
    const second = await w.store.dispatch('saves/select', b)

    assert.equal(second.action, 'busy')
    assert.equal((await first).action, 'switched')
    await w.settled(b)
    assert.equal(w.store.state.freshness.generation, generation + 1)
  })

  test('two saves with the same game and race numbers keep their own campaign, history and race settings', async () => {
    const held = installLocks()
    const w = await world({ recording: true })
    const stores = () => globalThis.__stores
    const campaignOf = async (file) => {
      await w.settled(file)

      const [game] = w.store.state.empires.games

      await w.store.dispatch('changeGame', { game, race: game.Races.find((race) => race.RaceID === RACE) })
      await until(() => w.store.getters.campaignId, `the campaign of ${file}`, 120000)
      await until(() => !stores().has('never') && held.size > 0, 'the recording lock')

      return w.store.getters.campaignId
    }
    const branch = (id) => [...stores().keys()].filter((key) => key.includes(`campaign-${id}-`))
    const snapshots = (id) => branch(id).reduce((total, key) => total + Object.values((stores().get(key).races || {})).reduce((sum, race) => sum + race.snapshots.length, 0), 0)

    const first = await campaignOf(a)
    const prefixA = w.store.getters.racePrefix

    await until(() => snapshots(first) > 0, 'the history of A', 120000)

    await w.store.dispatch('saves/select', b)
    assert.equal(w.store.getters.campaignId, null, 'the campaign of the save left still answers for the new one')
    assert.equal(w.store.getters.racePrefix, null, 'the race settings of the save left are still the ones in use')

    const second = await campaignOf(b)
    const prefixB = w.store.getters.racePrefix

    await until(() => snapshots(second) > 0, 'the history of B', 120000)

    assert.notEqual(second, first, 'two different saves were taken for one campaign')
    assert.equal(prefixA, `campaign.${first}.race.${RACE}`)
    assert.equal(prefixB, `campaign.${second}.race.${RACE}`)
    assert.notEqual(prefixA, prefixB)
    assert.equal(branch(first).filter((key) => !branch(second).includes(key)).length, branch(first).length, 'the two campaigns share a history file')
    assert.ok([...held].some((name) => name.endsWith(b)) && ![...held].some((name) => name.endsWith(a)), 'the recording lock was not moved to the save entered')

    await w.store.dispatch('saves/select', a)
    assert.equal(await campaignOf(a), first, 'a return to the first save did not find its campaign')

    const registry = stores().get('registry') || stores().get('|campaigns') || [...stores()].find(([key]) => key.endsWith('campaigns'))
    const campaigns = Object.values(((Array.isArray(registry) ? registry[1] : registry) || {}).campaigns || {}).filter((entry) => !entry.mergedInto)

    assert.equal(campaigns.length, 2, 'a return made a third campaign')
  })

  test('a late notification from the watcher of the save left is ignored', async () => {
    const w = await world({})
    const [first] = w.watchers

    await w.store.dispatch('saves/select', b)
    await w.settled(b)

    const { generation } = w.store.state.freshness
    const { file } = w.store.state.freshness

    first.emit('change', {})
    first.emit('add', {})
    first.emit('unlink')
    await sleep(300)

    assert.equal(w.store.state.freshness.generation, generation, 'a notification of the save left opened a copy')
    assert.deepEqual(w.store.state.freshness.file, file, 'a notification of the save left was recorded')
    assert.notEqual(w.store.state.freshness.refresh && w.store.state.freshness.refresh.outcome, 'failed', 'the save shown was reported missing')
  })

  test('one watcher follows the save shown: the one of the save left is closed and its files no longer open anything', async () => {
    await scratch('aurora-watch-', async (root) => {
      const one = path.join(root, 'one.db')
      const two = path.join(root, 'two.db')

      fs.copyFileSync(a, one)
      fs.copyFileSync(b, two)

      const w = await world({ start: one, chokidar: 'real' })

      await sleep(3500)
      assert.equal(w.store.state.freshness.generation, 1, 'the first notification opened the save twice')
      assert.equal(w.live().length, 1)

      await w.store.dispatch('saves/select', two)
      await w.settled(two)
      await sleep(3500)

      assert.equal(w.watchers.length, 2, 'more watchers than saves were opened')
      assert.equal(w.live().length, 1, 'the watcher of the save left is still open')
      assert.equal(w.live()[0].file, two)
      assert.equal(w.store.state.freshness.generation, 2, 'the new watcher’s first notification opened the save a second time')

      const open = w.store.state.database
      const stamp = new Date(Date.now() + 5000)

      fs.utimesSync(one, stamp, stamp)
      await sleep(4500)
      assert.equal(w.store.state.database, open, 'a change to the save left opened a copy')

      fs.utimesSync(two, stamp, stamp)
      await until(() => w.store.state.database !== open, 'the change to the save shown to be read', 15000)
      assert.equal(w.store.state.freshness.generation, 3)
      assert.equal(w.live().length, 1)
    })
  })

  // What `method` of the console was called with while `work` ran.
  const captured = async (method, work) => {
    const lines = []
    const original = console[method]

    console[method] = (...args) => lines.push(args.map(String).join(' '))

    try {
      await work()
    } finally {
      console[method] = original
    }

    return lines
  }

  // A real database on a copy of a save, with a managed transaction held open between its statements.
  const heldTransaction = async (root, { finish, afterRetire = false, write = false }) => {
    const { resetDatabase, retireDatabase } = m['renderer/utilities/database']
    const file = path.join(root, 'AuroraDB.db')

    fs.copyFileSync(a, file)

    const database = resetDatabase(file)
    let enter = null
    let resume = null
    const entered = new Promise((resolve) => { enter = resolve })
    const gate = new Promise((resolve) => { resume = resolve })
    const work = database.transaction(async (transaction) => {
      await database.query(write ? `update FCT_Game set GameName = 'written' where GameID = ${GAME}` : 'select 1', { transaction })
      enter()
      await gate

      return finish(database, transaction)
    })
    const outcome = work.then((value) => ({ value }), (error) => ({ error }))

    await entered

    const retiring = retireDatabase(database)

    if (afterRetire) {
      await retiring
    }

    resume()

    const result = await outcome

    await retiring

    return { database, file, result }
  }

  test('a transaction open when its database is retired is refused its next statement as retired, and nothing is sent to a closed handle', async () => {
    await scratch('aurora-txn-', async (root) => {
      const { isRetired } = m['renderer/utilities/retired']
      const { database, file, result } = await heldTransaction(root, { finish: (db, transaction) => db.query('select 2', { transaction }) })

      assert.ok(result.error, 'the statement after the retirement was answered')
      assert.ok(isRetired(result.error), `the statement was refused as ${result.error.name}: ${result.error.message}`)
      assert.ok(!/SQLITE/.test(String(result.error.code || result.error.message)), 'the statement reached a closed handle')

      const begun = await database.transaction(async () => 1).then(() => null, (error) => error)
      const plain = await database.query('select 1').then(() => null, (error) => error)

      assert.ok(isRetired(begun), 'a transaction began on the retired database')
      assert.ok(isRetired(plain), 'a read ran on the retired database')
      fs.rmSync(file)
    })
  })

  // A statement of a copy of the save that runs for a long time, so it is still running when the copy is retired.
  const SLOW = 'with recursive c(x) as (select 1 union all select x+1 from c where x < 400000000) select count(*) from c'

  // Runs `work(database, root)` on a copy of A opened for it; the copy is retired afterwards.
  const onCopy = async (prefix, work) => {
    await scratch(prefix, async (root) => {
      const { resetDatabase, retireDatabase } = m['renderer/utilities/database']
      const file = path.join(root, 'AuroraDB.db')

      fs.copyFileSync(a, file)

      const database = resetDatabase(file)

      try {
        await work(database)
      } finally {
        await retireDatabase(database)
      }
    })
  }

  test('a read that is running when its database is retired is rejected as retired, with the interruption kept as its cause', async () => {
    await onCopy('aurora-running-', async (database) => {
      const { retireDatabase } = m['renderer/utilities/database']
      const { isRetired } = m['renderer/utilities/retired']
      const running = database.query(SLOW).then(() => null, (error) => error)

      await sleep(400)
      await retireDatabase(database)

      const error = await running

      assert.ok(error && isRetired(error), `the running read was answered as ${error ? error.name + ': ' + error.message : 'a success'}`)
      assert.match(String(error.cause && error.cause.message), /interrupt/i, 'the interruption was not kept as the cause')
    })
  })

  test('a statement of a transaction that is running when its database is retired is rejected as retired', async () => {
    await onCopy('aurora-running-txn-', async (database) => {
      const { retireDatabase } = m['renderer/utilities/database']
      const { isRetired } = m['renderer/utilities/retired']
      const running = database.transaction((transaction) => database.query(SLOW, { transaction })).then(() => null, (error) => error)

      await sleep(400)
      await retireDatabase(database)

      const error = await running

      assert.ok(error && isRetired(error), `the running statement was answered as ${error ? error.name + ': ' + error.message : 'a success'}`)
    })
  })

  test('a statement that fails for its own reason before its database is retired is not reported as retired, in a queue or in a transaction', async () => {
    await onCopy('aurora-genuine-', async (database) => {
      const { isRetired } = m['renderer/utilities/retired']
      const asked = await database.query('select GameID from NoSuchTable').then(() => null, (error) => error)
      const inTransaction = await database.transaction((transaction) => database.query('select GameID from NoSuchTable', { transaction })).then(() => null, (error) => error)

      for (const error of [asked, inTransaction]) {
        assert.ok(error, 'a statement on a missing table did not fail')
        assert.ok(!isRetired(error), `a genuine failure was reported as retired: ${error.message}`)
        assert.match(error.message, /no such table/i)
      }
    })
  })

  // A genuine failure that SQLite already produced and that is held (at Sequelize's afterQuery) while the retiring begins is still the save's own error: the retiring is not what ended the statement.
  for (const how of ['read', 'transaction']) {
    test(`a genuine error of a ${how} that is delivered after the database was retired stays a genuine error`, async () => {
      await onCopy('aurora-held-', async (database) => {
        const { retireDatabase } = m['renderer/utilities/database']
        const { isRetired } = m['renderer/utilities/retired']
        let armed = false
        let reached = null
        let release = null
        const entered = new Promise((resolve) => { reached = resolve })
        const gate = new Promise((resolve) => { release = resolve })

        database.addHook('afterQuery', async () => {
          if (armed) {
            armed = false
            reached()
            await gate
          }
        })
        // The statement that is held is the failing one, not the BEGIN of a transaction before it.
        const missing = (options) => {
          armed = true

          return database.query('select GameID from NoSuchTable', options)
        }
        const failing = how === 'read' ? missing() : database.transaction((transaction) => missing({ transaction }))
        const outcome = failing.then(() => null, (error) => error)

        await entered

        const retiring = retireDatabase(database)

        release()

        const error = await outcome

        await retiring
        assert.ok(error, 'a statement on a missing table did not fail')
        assert.ok(!isRetired(error), `a genuine failure was reported as retired: ${error.message}`)
        assert.match(error.message, /no such table/i)
      })
    })
  }

  test('a failure to open the file that is raced with the retiring stays a genuine error', async () => {
    await scratch('aurora-missing-', async (root) => {
      const { resetDatabase, retireDatabase } = m['renderer/utilities/database']
      const { isRetired } = m['renderer/utilities/retired']
      const database = resetDatabase(path.join(root, 'NotThere.db'))
      const outcome = database.query('select 1').then(() => null, (error) => error)
      const retiring = retireDatabase(database)
      const error = await outcome

      await retiring
      assert.ok(error, 'a read of a file that is not there did not fail')
      assert.ok(!isRetired(error), `a genuine failure was reported as retired: ${error.message}`)
    })
  })

  // ---- Recovery of a save that goes missing, is replaced or is locked ---------------------------------------------------------

  // The timing of the watcher's recovery, short enough for a case to wait out: a burst is heard for 60 ms and never past 400 ms, a failed reload is tried again after 60 ms, up to twice.
  const FAST = { settleMs: 60, maxWaitMs: 400, retryMs: [60, 60] }

  // A save of the case's own: a copy of A with `extra` run on it. A second game and a second race are made by copying the first one's rows.
  const savedIn = async (root, extra = '') => {
    const file = path.join(root, 'AuroraDB.db')

    fs.copyFileSync(a, file)

    if (extra) {
      await sqliteRun(file, extra)
    }

    return file
  }
  const SECOND_GAME = `create temp table g as select * from FCT_Game where GameID = ${GAME}; update g set GameID = 141, GameName = 'Second Game'; insert into FCT_Game select * from g; create temp table r as select * from FCT_Race where GameID = ${GAME} and RaceID = ${RACE}; update r set GameID = 141, RaceID = 9001, RaceTitle = 'Second Game Empire'; insert into FCT_Race select * from r;`
  const SECOND_RACE = `create temp table r as select * from FCT_Race where GameID = ${GAME} and RaceID = ${RACE}; update r set RaceID = 9002, RaceTitle = 'Second Empire'; insert into FCT_Race select * from r;`
  const REMOVE_GAME = `delete from FCT_Race where GameID = ${GAME}; delete from FCT_Game where GameID = ${GAME};`
  const REMOVE_RACE = `delete from FCT_Race where GameID = ${GAME} and RaceID = ${RACE};`

  // The game and race picked, as the Empires page picks them.
  const pick = async (w, gameId = GAME, raceId = RACE) => {
    const game = w.store.state.empires.games.find((one) => one.GameID === gameId)

    await w.store.dispatch('changeGame', { game, race: game.Races.find((one) => one.RaceID === raceId) })
  }

  // The locks of the case running, let go when it ends, however it ends.
  const HELD = []

  // A lock on the file as another program's write holds it: readers are refused until it is released.
  const lockOf = async (file) => {
    const sqlite3 = requireHere('sqlite3')
    const handle = await new Promise((resolve, reject) => {
      const opened = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(opened)))
    })
    const run = (sql) => new Promise((resolve, reject) => handle.exec(sql, (error) => (error ? reject(error) : resolve())))

    await run('begin exclusive')

    let released = false
    const release = async () => {
      if (!released) {
        released = true
        await run('rollback').catch(() => {})
        await new Promise((resolve) => handle.close(resolve))
      }
    }

    HELD.push(release)

    return { release }
  }

  const recoveryOf = (w) => w.store.state.freshness.recovery
  const generationOf = (w) => w.store.state.freshness.generation

  // The save's own bytes, to see that none of the above changed them.
  const checksumOf = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')

  test('a save that is deleted and recreated is reported missing while it is gone, neither read nor retried, and is read again once it is back with the selection kept', async () => {
    await scratch('aurora-recreate-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: FAST })

      await pick(w)

      const [watcher] = w.live()
      const generation = generationOf(w)

      await m['renderer/utilities/database'].retireDatabase(w.store.state.database)
      fs.rmSync(file)
      watcher.emit('unlink')

      assert.equal(recoveryOf(w).state, 'missing')
      assert.equal(w.store.state.freshness.refresh.outcome, 'failed')
      assert.match(w.store.state.freshness.refresh.message, /missing/)

      await sleep(500)
      assert.equal(generationOf(w), generation, 'a save that is gone was opened again')
      assert.equal(recoveryOf(w).state, 'missing')

      // A manual retry looks once and goes on waiting: the file is still not there.
      w.store.commit('freshness/retryRequested')
      await until(() => generationOf(w) === generation + 1 && recoveryOf(w).state === 'missing' && recoveryOf(w).message, 'the retry to find the file still missing')
      await sleep(500)
      assert.equal(generationOf(w), generation + 1, 'a save that is gone was retried on its own')

      fs.copyFileSync(a, file)
      watcher.emit('add', {})
      await until(() => recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok' && generationOf(w) === generation + 2, 'the recreated save to be read', 20000)
      await until(() => w.store.state.empires.loaded && w.store.state.empires.games.length > 0, 'the empire list of the recreated save')

      assert.equal(w.store.state.GameID, GAME)
      assert.equal(w.store.state.RaceID, RACE)
      assert.equal(w.store.state.empires.dropped, null)
      assert.equal(w.store.state.freshness.read.generation, generation + 2, 'the read shown is not the one of the recreated save')
    })
  })

  test('a save replaced by renaming another file over it is opened once for the removal and the return together, and shows the new file', async () => {
    await scratch('aurora-replace-', async (root) => {
      const file = await savedIn(root)
      const replacement = path.join(root, 'Replacement.db')

      fs.copyFileSync(b, replacement)

      const w = await world({ start: file, recovery: FAST })

      await pick(w)

      const [watcher] = w.live()
      const generation = generationOf(w)

      assert.ok(!w.names()[0].endsWith(' (B)'))
      await m['renderer/utilities/database'].retireDatabase(w.store.state.database)
      fs.renameSync(replacement, file)
      watcher.emit('unlink')
      watcher.emit('add', {})
      await until(() => recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok' && generationOf(w) === generation + 1, 'the replacing save to be read', 20000)
      await until(() => w.names()[0] && w.names()[0].endsWith(' (B)'), 'the empire list of the replacing save')
      await sleep(400)

      assert.equal(generationOf(w), generation + 1, 'the removal and the return opened the save more than once')
      assert.equal(w.store.state.GameID, GAME)
      assert.equal(w.store.state.RaceID, RACE)
    })
  })

  test('a save that is locked for a while is reported unreadable with the selection and the list kept, and is read again once the lock is gone, on its own', async () => {
    await scratch('aurora-locked-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: { ...FAST, retryMs: [60, 60, 60, 60] } })

      await pick(w)

      const [watcher] = w.live()
      const generation = generationOf(w)
      const listed = w.store.state.empires.games
      const lock = await lockOf(file)

      watcher.emit('change', {})
      await until(() => recoveryOf(w).state === 'unreadable' && recoveryOf(w).attempt >= 1, 'the locked save to be reported unreadable', 30000)

      assert.ok(recoveryOf(w).message, 'no reason was given')
      assert.equal(w.store.state.freshness.refresh.outcome === 'ok', false, 'a read that failed was reported as fresh')
      assert.equal(w.store.state.GameID, GAME, 'a read that failed cleared the selection')
      assert.equal(w.store.state.RaceID, RACE)
      assert.equal(w.store.state.empires.games, listed, 'a read that failed replaced the empire list')

      await lock.release()
      await until(() => recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok', 'the save to be read once the lock was gone', 30000)
      await until(() => w.store.state.empires.error === null && w.store.state.empires.loaded, 'the empire list to be read again')

      assert.ok(generationOf(w) > generation + 1, 'the save was not opened again after the failure')
      assert.equal(recoveryOf(w).attempt, 0)
      assert.equal(w.store.state.GameID, GAME)
      assert.equal(w.store.state.RaceID, RACE)
    })
  })

  test('a file that stays unreadable is retried a bounded number of times, then waits for a manual retry, which starts the count again and recovers once the save is whole', async () => {
    await scratch('aurora-bounded-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: FAST })

      await pick(w)

      const [watcher] = w.live()
      const generation = generationOf(w)
      const listed = w.store.state.empires.games
      const { retireDatabase } = m['renderer/utilities/database']

      // The file is replaced by one that is not a save (a copy that is not finished).
      await retireDatabase(w.store.state.database)
      fs.writeFileSync(file, Buffer.alloc(8192, 'not a save '))
      watcher.emit('change', {})
      await until(() => recoveryOf(w).state === 'unreadable' && recoveryOf(w).nextAt === null, 'the retries to run out', 20000)

      const spent = generationOf(w)

      assert.equal(recoveryOf(w).attempt, FAST.retryMs.length)
      assert.ok(recoveryOf(w).message, 'no reason was given')
      assert.equal(spent, generation + 1 + FAST.retryMs.length, 'the save was opened more or fewer times than the bound allows')

      // The list of the last copy could not be read either; that says nothing about what the save holds, so the selection and the list stay as they were.
      await until(() => w.store.state.empires.error, 'the empire list of the unreadable copy to fail', 20000)
      assert.equal(w.store.state.GameID, GAME, 'a read that failed cleared the game')
      assert.equal(w.store.state.RaceID, RACE, 'a read that failed cleared the race')
      assert.equal(w.store.state.empires.dropped, null)
      assert.equal(w.store.state.empires.games, listed, 'a read that failed replaced the empire list')
      await sleep(600)
      assert.equal(generationOf(w), spent, 'the retries went on past their bound')
      assert.equal(recoveryOf(w).nextAt, null)

      // Still unreadable: the manual retry opens the save at once and the bound starts over.
      w.store.commit('freshness/retryRequested')
      assert.equal(generationOf(w), spent + 1, 'the manual retry did not open the save at once')
      assert.equal(recoveryOf(w).state, 'reconnecting')
      assert.equal(recoveryOf(w).attempt, 0)
      await until(() => recoveryOf(w).state === 'unreadable' && recoveryOf(w).nextAt === null, 'the retries after the manual one to run out', 20000)
      assert.equal(generationOf(w), spent + 1 + FAST.retryMs.length, 'the manual retry did not get a bound of its own')

      await retireDatabase(w.store.state.database)
      fs.copyFileSync(a, file)
      w.store.commit('freshness/retryRequested')
      await until(() => recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok', 'the save to be read after the manual retry', 20000)
      await until(() => w.store.state.empires.error === null && w.store.state.empires.loaded, 'the empire list to be read again')
      assert.equal(recoveryOf(w).attempt, 0)
      assert.equal(w.store.state.GameID, GAME)
      assert.equal(w.store.state.RaceID, RACE)
    })
  })

  test('a burst of notifications opens the save once, one that arrives while it is being read opens it once more, and one that never lets up is still heard within the longest wait', async () => {
    await scratch('aurora-burst-', async (root) => {
      const file = await savedIn(root)
      const gate = { hold: null }
      const { PROBE_SQL } = m['renderer/store/freshness']
      const w = await world({
        start: file,
        recovery: FAST,
        onDatabase: (database) => {
          const query = database.query

          database.query = async (sql, options) => {
            if (gate.hold && sql === PROBE_SQL) {
              await gate.hold
            }

            return query.call(database, sql, options)
          }
        },
      })
      const [watcher] = w.live()
      const generation = generationOf(w)

      for (let count = 0; count < 25; count++) {
        watcher.emit(count % 5 === 4 ? 'add' : 'change', {})
        await sleep(8)
      }

      await until(() => generationOf(w) === generation + 1 && recoveryOf(w).state === 'ok', 'the burst to be read', 20000)
      await sleep(400)
      assert.equal(generationOf(w), generation + 1, 'a burst of notifications opened more than one copy')

      // Notifications while a copy is being read are one more read after it, not one each, and not while it is read.
      let release = null

      gate.hold = new Promise((resolve) => { release = resolve })
      watcher.emit('change', {})
      await until(() => generationOf(w) === generation + 2 && w.store.state.freshness.refresh.outcome === 'reading', 'the read to be under way')

      for (let count = 0; count < 6; count++) {
        watcher.emit('change', {})
        await sleep(30)
      }

      await sleep(300)
      assert.equal(generationOf(w), generation + 2, 'a notification opened a copy while another was still being read')
      gate.hold = null
      release()
      await until(() => generationOf(w) === generation + 3 && recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok', 'the one more read', 20000)
      await sleep(400)
      assert.equal(generationOf(w), generation + 3, 'the notifications that came while reading opened more than one more copy')

      // A burst that does not stop (a game saving over and over) is read within the longest wait, more than once.
      const before = generationOf(w)

      for (let count = 0; count < 50; count++) {
        watcher.emit('change', {})
        await sleep(30)
      }

      const during = generationOf(w) - before

      await until(() => recoveryOf(w).state === 'ok', 'the endless burst to settle', 20000)
      assert.ok(during >= 2, `a burst that kept on was not read until it ended (${during} reads in 1.5 s)`)
      assert.ok(during <= 6, `a burst that kept on opened a copy for nearly every notification (${during})`)
    })
  })

  test('a game removed on reload clears its selection, the page and what was derived from it, and no other game takes its place', async () => {
    await scratch('aurora-removed-game-', async (root) => {
      const file = await savedIn(root, SECOND_GAME)
      const w = await world({ start: file, recovery: FAST })

      assert.equal(w.store.state.empires.games.length, 2)
      await pick(w)
      w.store.commit('peeks/set', { route: '/production', line: 'a line of the game removed' })
      w.store.commit('navigation/settle', '/production')

      const [watcher] = w.live()

      await sqliteRun(file, REMOVE_GAME)
      watcher.emit('change', {})
      await until(() => w.store.state.empires.dropped, 'the removed game to be dropped', 20000)

      assert.equal(w.store.state.empires.dropped.kind, 'game')
      assert.equal(w.store.state.empires.dropped.name, 'Aurelian Empire')
      assert.equal(w.store.state.GameID, null, 'the selection of a removed game was kept or given to another game')
      assert.equal(w.store.state.RaceID, null)
      assert.deepEqual(w.store.state.empires.games.map((game) => game.GameID), [141])
      assert.deepEqual(w.store.state.peeks.lines, {}, 'what was derived from the removed game was kept')
      assert.deepEqual(w.store.state.navigation.entries.map((entry) => entry.path), ['/'], 'the pages visited for the removed game were kept')
      assert.equal(w.store.$router.currentRoute.path, '/', 'the page of the removed game stayed open')

      // Picking again is the person's choice, and takes the notice away.
      await pick(w, 141, 9001)
      assert.equal(w.store.state.empires.dropped, null)
      assert.equal(w.store.state.GameID, 141)
    })
  })

  test('a race removed on reload clears its selection and what was derived from it, keeps the game, and no other race takes its place', async () => {
    await scratch('aurora-removed-race-', async (root) => {
      const file = await savedIn(root, SECOND_RACE)
      const w = await world({ start: file, recovery: FAST })

      assert.equal(w.store.state.empires.games[0].Races.length, 2)
      await pick(w)
      w.store.commit('peeks/set', { route: '/production', line: 'a line of the race removed' })
      w.store.commit('navigation/settle', '/production')

      const [watcher] = w.live()

      await sqliteRun(file, REMOVE_RACE)
      watcher.emit('change', {})
      await until(() => w.store.state.empires.dropped, 'the removed race to be dropped', 20000)

      assert.equal(w.store.state.empires.dropped.kind, 'race')
      assert.equal(w.store.state.GameID, GAME, 'the game of a removed race was cleared')
      assert.equal(w.store.state.RaceID, null, 'the race removed stayed picked, or another race took its place')
      assert.deepEqual(w.store.state.empires.games[0].Races.map((race) => race.RaceID), [9002], 'the fixture did not leave one race')
      assert.deepEqual(w.store.state.peeks.lines, {})
      assert.equal(w.store.$router.currentRoute.path, '/')
    })
  })

  test('a game and race that are still in the save keep their selection and take the clock and the kind of the new read', async () => {
    await scratch('aurora-kept-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: FAST })

      await pick(w)
      w.store.commit('peeks/set', { route: '/production', line: 'a line that stays' })

      const [watcher] = w.live()
      const { GameTime } = w.store.state

      await sqliteRun(file, `update FCT_Game set GameTime = GameTime + 3600 where GameID = ${GAME};`)
      watcher.emit('change', {})
      await until(() => w.store.state.GameTime === GameTime + 3600, 'the new clock to be taken', 20000)

      assert.equal(w.store.state.GameID, GAME)
      assert.equal(w.store.state.RaceID, RACE)
      assert.equal(w.store.state.empires.dropped, null)
      assert.equal(w.store.$router.currentRoute.path, '/production', 'a selection that is still there lost its page')
    })
  })

  test('an error of the watcher is reported with its reason and the save is read to find out, on the same bounded retries', async () => {
    await scratch('aurora-watch-error-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: FAST })
      const [watcher] = w.live()
      const generation = generationOf(w)
      const seen = []

      w.store.subscribe((mutation) => mutation.type === 'freshness/recovery' && seen.push({ ...w.store.state.freshness.recovery }))
      watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, lstat'), { code: 'EPERM' }))

      assert.equal(w.store.state.freshness.file.kind, 'error')
      assert.equal(recoveryOf(w).state, 'unreadable')
      assert.match(recoveryOf(w).message, /EPERM/)
      await until(() => recoveryOf(w).state === 'ok' && generationOf(w) === generation + 1 && w.store.state.freshness.refresh.outcome === 'ok', 'the save to be read after the error', 20000)
      assert.ok(seen.some((entry) => entry.state === 'unreadable' && entry.nextAt !== null), 'no retry was announced')
    })
  })

  test('the retry waiting for a save that was switched away from opens nothing, and the save shown starts clean', async () => {
    await scratch('aurora-switched-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: { ...FAST, retryMs: [500, 500] } })
      const [watcher] = w.live()

      watcher.emit('error', new Error('EBUSY: resource busy or locked'))
      assert.equal(recoveryOf(w).state, 'unreadable')
      assert.notEqual(recoveryOf(w).nextAt, null, 'no retry was waiting')
      assert.equal((await w.store.dispatch('saves/select', b)).action, 'switched')
      await w.settled(b)

      const generation = generationOf(w)

      assert.equal(recoveryOf(w).state, 'ok', 'the save shown inherited the trouble of the save left')
      await sleep(1200)
      assert.equal(generationOf(w), generation, 'a retry of the save left opened a copy')
      assert.equal(w.store.state.databasePath, b)
      assert.equal(recoveryOf(w).state, 'ok')
    })
  })

  test('the last race the list shows of a game removed on reload clears the race and keeps the game, though the list no longer shows the game', async () => {
    await scratch('aurora-last-race-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: FAST })

      await pick(w)
      w.store.commit('peeks/set', { route: '/production', line: 'a line of the race removed' })
      w.store.commit('navigation/settle', '/production')

      const [watcher] = w.live()

      await sqliteRun(file, REMOVE_RACE)
      watcher.emit('change', {})
      await until(() => w.store.state.empires.dropped, 'the removed race to be dropped', 20000)

      assert.deepEqual(w.store.state.empires.games, [], 'the fixture still lists the game')
      assert.equal(w.store.state.empires.dropped.kind, 'race', 'a game the save still holds was reported gone')
      assert.equal(w.store.state.empires.dropped.RaceID, RACE)
      assert.equal(w.store.state.GameID, GAME, 'the game the save still holds was cleared')
      assert.equal(w.store.state.RaceID, null)
      assert.deepEqual(w.store.state.peeks.lines, {})
      assert.equal(w.store.$router.currentRoute.path, '/')
    })
  })

  test('a check of the selection that fails changes nothing, and is made again by the next read of the copy', async () => {
    await scratch('aurora-check-fails-', async (root) => {
      const file = await savedIn(root, SECOND_GAME)
      const fail = { on: true }
      const w = await world({
        start: file,
        recovery: FAST,
        onDatabase: (database) => {
          const query = database.query

          database.query = async (sql, options) => {
            if (fail.on && /where GameID = :GameID/.test(sql) && /FCT_Game/.test(sql)) {
              throw new Error('the check could not ask the save')
            }

            return query.call(database, sql, options)
          }
        },
      })

      fail.on = false
      await pick(w)
      fail.on = true

      const [watcher] = w.live()
      const generation = generationOf(w)

      await sqliteRun(file, REMOVE_GAME)
      watcher.emit('change', {})
      await until(() => generationOf(w) === generation + 1 && w.store.state.empires.loaded && w.store.state.empires.games.length === 1, 'the list of the copy to be read', 20000)
      await sleep(300)
      assert.equal(w.store.state.GameID, GAME, 'a check that failed cleared the game')
      assert.equal(w.store.state.RaceID, RACE, 'a check that failed cleared the race')
      assert.equal(w.store.state.empires.dropped, null)

      fail.on = false
      await w.store.dispatch('empires/load')
      assert.equal(w.store.state.GameID, null, 'the next read of the copy did not check the selection again')
      assert.equal(w.store.state.empires.dropped.kind, 'game')
    })
  })

  test('a save switched to while it is locked is read again once the lock is gone, on the same bounded retries, without a second open for its first add', async () => {
    await scratch('aurora-switch-locked-', async (root) => {
      const file = await savedIn(root)
      const other = path.join(root, 'Other.db')

      fs.copyFileSync(b, other)

      const w = await world({ start: file, recovery: { ...FAST, retryMs: [60, 60, 60, 60] } })
      const generation = generationOf(w)
      const lock = await lockOf(other)
      const seen = []

      w.store.subscribe((mutation) => mutation.type === 'freshness/recovery' && seen.push({ ...w.store.state.freshness.recovery, generation: w.store.state.freshness.generation }))
      assert.equal((await w.store.dispatch('saves/select', other)).action, 'switched')
      await until(() => w.store.state.savePath === other && w.store.state.databasePath === other, 'the locked save to be opened')
      await until(() => seen.some((entry) => entry.state === 'unreadable'), 'the save that was locked at the switch to be reported unreadable', 30000)

      const first = seen.find((entry) => entry.state === 'unreadable')

      assert.equal(first.attempt, 1)
      assert.equal(first.generation, generation + 1, 'the first add of the watcher opened the save a second time')
      assert.ok(first.nextAt !== null, 'no retry was waiting')
      assert.notEqual(w.store.state.freshness.refresh.outcome, 'ok')

      await lock.release()
      await until(() => recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok', 'the save to be read once the lock was gone', 30000)
      await until(() => w.store.state.empires.error === null && w.store.state.empires.loaded && w.names()[0], 'the empire list of the save switched to')

      assert.match(w.names()[0], / \(B\)$/)
      assert.equal(recoveryOf(w).attempt, 0)
      assert.equal(w.store.state.databasePath, other)
    })
  })

  test('an error of the watcher while a copy is being read is one failure: one retry counted, and the first delay is the one used', async () => {
    await scratch('aurora-error-probing-', async (root) => {
      const file = await savedIn(root)
      const gate = { hold: null }
      const { PROBE_SQL } = m['renderer/store/freshness']
      const w = await world({
        start: file,
        recovery: { settleMs: 60, maxWaitMs: 400, retryMs: [300, 5000] },
        onDatabase: (database) => {
          const query = database.query

          database.query = async (sql, options) => {
            if (gate.hold && sql === PROBE_SQL) {
              await gate.hold
            }

            return query.call(database, sql, options)
          }
        },
      })
      const [watcher] = w.live()
      const generation = generationOf(w)
      const seen = []
      let release = null

      w.store.subscribe((mutation) => mutation.type === 'freshness/recovery' && seen.push({ ...w.store.state.freshness.recovery }))
      gate.hold = new Promise((resolve) => { release = resolve })
      watcher.emit('change', {})
      await until(() => generationOf(w) === generation + 1 && w.store.state.freshness.refresh.outcome === 'reading', 'the read to be under way')

      const before = seen.length
      const heard = Date.now()

      watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, lstat'), { code: 'EPERM' }))

      const failures = seen.slice(before).filter((entry) => entry.state === 'unreadable')

      assert.deepEqual(failures.map((entry) => entry.attempt), [1], 'one error was counted as more than one failure')
      assert.ok(failures[0].nextAt - heard < 1500, 'the first retry waited longer than its own delay')
      gate.hold = null
      release()
      await until(() => generationOf(w) === generation + 2 && recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok', 'the first retry to read the save', 20000)
      assert.equal(seen.filter((entry) => entry.state === 'unreadable' && entry.attempt === 2).length, 0, 'the retry that ran was not the first')
    })
  })

  test('a world that is closed stops its recovery: a retry that was waiting opens nothing, and its file can be removed afterwards', async () => {
    await scratch('aurora-closed-', async (root) => {
      const file = await savedIn(root)
      const w = await world({ start: file, recovery: { settleMs: 60, maxWaitMs: 400, retryMs: [300, 300] } })
      const [watcher] = w.live()
      const generation = generationOf(w)

      watcher.emit('error', new Error('EBUSY: resource busy or locked'))
      assert.equal(recoveryOf(w).state, 'unreadable')
      assert.notEqual(recoveryOf(w).nextAt, null, 'no retry was waiting')
      watcher.emit('change', {})
      await closeWorlds(m)

      const { database } = w.store.state

      await sleep(900)
      assert.equal(generationOf(w), generation, 'a closed world opened the save again')
      assert.equal(w.store.state.database, database)
      assert.equal(w.recoverer.live(), 0, 'the recovery watcher was still live')

      // A connection opened after the world was closed would hold the file (Windows refuses to remove it).
      fs.rmSync(file)
    })
  })

  test('the recovery is worded for each state, with the retry or the wait it stands for', () => {
    const { describeRecovery } = m['renderer/store/freshness']
    const now = 1000000
    const words = (patch) => describeRecovery({ state: 'ok', attempt: 0, limit: 4, nextAt: null, message: null, ...patch }, now)

    assert.equal(words({}), null)
    assert.match(words({ state: 'reconnecting' }), /opened again/)
    assert.match(words({ state: 'reconnecting', attempt: 2 }), /retry 2 of 4/)
    assert.match(words({ state: 'missing', message: 'The save file is missing' }), /missing.*waits for it to come back/)
    assert.match(words({ state: 'unreadable', attempt: 1, nextAt: now + 2500, message: 'SQLITE_BUSY: database is locked' }), /locked.*retry 1 of 4 in 3 s/)

    const spent = words({ state: 'unreadable', attempt: 4, nextAt: null, message: 'SQLITE_BUSY: database is locked' })

    assert.match(spent, /after 4 retries/)
    assert.match(spent, /Retry opens it again/)
    assert.doesNotMatch(spent, / in \d+ s/)
  })

  test('the save is byte for byte the same after bursts, retries and manual retries, with nothing added beside it', async () => {
    await scratch('aurora-checksum-', async (root) => {
      const file = await savedIn(root)
      const before = checksumOf(file)
      const listing = fs.readdirSync(root).sort()
      const w = await world({ start: file, recovery: FAST, recording: true })

      await until(() => w.store.getters.campaignId !== null || Object.keys(w.store.state.history.campaigns).length > 0, 'the recording of the save', 120000)
      await pick(w)

      const [watcher] = w.live()

      for (let count = 0; count < 10; count++) {
        watcher.emit('change', {})
        await sleep(10)
      }

      await until(() => recoveryOf(w).state === 'ok' && generationOf(w) === 2 && w.store.state.freshness.refresh.outcome === 'ok', 'the burst to be read', 30000)
      w.store.commit('freshness/retryRequested')
      await until(() => generationOf(w) === 3 && recoveryOf(w).state === 'ok' && w.store.state.freshness.refresh.outcome === 'ok', 'the manual retry to be read', 30000)
      await m['renderer/utilities/database'].retireDatabase(w.store.state.database)

      assert.equal(checksumOf(file), before, 'reading the save changed its bytes')
      assert.deepEqual(fs.readdirSync(root).sort(), listing, 'something was added beside the save')
      assert.ok(globalThis.__stores.size > 0, 'the history was not kept in the app’s own store')
    })
  })

  // The dev server's middleware as it is in `base` now: a mutant is written over the same path, and its state (the copies it holds) is its own for each case.
  const freshMiddleware = () => {
    const file = path.join(base, 'scripts', 'web', 'database-middleware.js')

    delete requireHere.cache[file]

    return requireHere(file)
  }

  // The name of the game in the file, read on a connection of its own.
  const gameNameIn = async (file) => {
    const { resetDatabase, retireDatabase } = m['renderer/utilities/database']
    const reader = resetDatabase(file)

    try {
      const [rows] = await reader.query(`select GameName from FCT_Game where GameID = ${GAME}`)

      return rows[0].GameName
    } finally {
      await retireDatabase(reader)
    }
  }

  for (const how of ['commit', 'rollback']) {
    test(`a transaction still suspended past the retiring's wait is ended by it, and its later ${how} is answered as retired without touching the closed connection`, async () => {
      await scratch('aurora-txn-', async (root) => {
        const { isRetired } = m['renderer/utilities/retired']
        const outcome = { result: null }
        const warnings = await captured('warn', async () => {
          outcome.held = await heldTransaction(root, { write: true, afterRetire: true, finish: async () => { if (how === 'rollback') { throw new Error('the callback failed') } return 'done' } })
        })
        const { result, file } = outcome.held

        if (how === 'commit') {
          assert.ok(result.error && isRetired(result.error), `the commit was answered as ${result.error ? result.error.name + ': ' + result.error.message : 'a success'}`)
        } else {
          assert.equal(result.error && result.error.message, 'the callback failed', 'the failure of the callback was replaced')
        }

        assert.deepEqual(warnings.filter((line) => /transaction|SQLITE|closed/i.test(line)), [], 'the transaction was finished on a closed connection')
        assert.notEqual(await gameNameIn(file), 'written', 'a write of a transaction the retiring ended was kept')
        fs.rmSync(file)
      })
    })
  }

  test('a transaction that ends while its database is retiring commits on an open connection, and the retiring waits for it', async () => {
    await scratch('aurora-txn-', async (root) => {
      const { result, file } = await heldTransaction(root, { finish: async () => 'done' })

      assert.equal(result.error, undefined, result.error && result.error.message)
      assert.equal(result.value, 'done')
      fs.rmSync(file)
    })
  })

  test('the database kept in the store is not made reactive, so closing it sees only real connections', async () => {
    const w = await world({})
    const database = w.store.state.database

    await database.query('select 1')

    assert.ok(Object.getOwnPropertyNames(database.connectionManager.connections).length > 0)
    assert.ok(!Object.getOwnPropertyNames(database.connectionManager.connections).includes('__ob__'), 'Vue added its bookkeeping to the connections')

    const warnings = await captured('warn', async () => {
      await w.store.dispatch('saves/select', b)
      await w.settled(b)
      await sleep(200)
    })

    assert.deepEqual(warnings.filter((line) => line.includes('Closing the replaced database failed')), [])
  })

  test('a capability check cut off by a switch is not reported as a failure, and nothing is shown for it', async () => {
    const { DatabaseRetired } = m['renderer/utilities/retired']
    const w = await world({})
    let release = null
    const gate = new Promise((resolve) => { release = resolve })

    w.store.state.database.query = async () => {
      await gate
      throw new DatabaseRetired()
    }

    const lines = await captured('error', async () => {
      const check = w.store.dispatch('capabilities/retry')

      await w.store.dispatch('saves/select', b)
      await w.settled(b)
      release()
      await check
      await sleep(100)
    })

    assert.deepEqual(lines.filter((line) => line.includes('capability preflight failed')), [], 'the cut-off check was reported')
    assert.notEqual(w.store.getters['capabilities/status'], 'failed')
  })

  test('a capability check of the copy now open that fails is still reported', async () => {
    const w = await world({})

    w.store.state.database.query = async () => {
      throw new Error('the save could not be read')
    }

    const lines = await captured('error', () => w.store.dispatch('capabilities/retry'))

    assert.equal(lines.filter((line) => line.includes('capability preflight failed')).length, 1)
    assert.equal(w.store.getters['capabilities/status'], 'failed')
  })

  test('a recording pass cut off by a switch reports nothing and records no failure', async () => {
    let enter = null
    let release = null
    const entered = new Promise((resolve) => { enter = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const instrument = (database) => {
      const query = database.query
      let inside = 0

      // The fourth statement of the pass's read transaction (after BEGIN, the races and the games: the first read of a game) waits: the switch comes while the pass is between statements.
      database.query = async (sql, options) => {
        if (options && options.transaction && ++inside === 4) {
          enter()
          await gate
        }

        return query(sql, options)
      }
    }
    let instrumented = false
    const w = await world({
      recording: true,
      onDatabase: (database) => {
        if (!instrumented) {
          instrumented = true
          instrument(database)
        }
      },
    })
    const lines = await captured('error', async () => {
      await entered
      await w.store.dispatch('saves/select', b)
      release()
      await w.settled(b)
      await until(() => w.store.getters.campaignId !== null || Object.keys(w.store.state.history.campaigns).length > 0, 'the pass of the save entered', 120000)
      await sleep(300)
    })

    assert.deepEqual(lines.filter((line) => line.includes('Empire history')), [], lines.join('\n'))
    assert.deepEqual(w.store.state.history.failures, [])
  })

  test('two tabs on one dev server keep their own copies of a save: a switch in one changes nothing the other reads, and a closed copy is refused as superseded', async () => {
    const http = require('http')

    process.env.AURORA_DB = a
    process.env.AURORA_DB_SAVES = b

    const middleware = freshMiddleware()
    const handler = middleware.databaseHandler(async () => m['renderer/utilities/database'])
    const server = http.createServer((req, res) => handler(req, res))

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

    const call = async (route, body) => {
      const response = await fetch(`http://localhost:${server.address().port}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [middleware.TOKEN_HEADER]: middleware.TOKEN }, body: JSON.stringify(body) })

      return { status: response.status, body: await response.json() }
    }
    const nameOf = async (token) => {
      const answer = await call('query', { token, sql: 'select GameName from FCT_Game where GameID = ' + GAME })

      return answer.status === 200 ? answer.body[0][0].GameName : answer
    }
    const tokens = []

    try {
      const tabOne = (await call('reset', { storagePath: a })).body.token
      const tabTwo = (await call('reset', { storagePath: b })).body.token

      tokens.push(tabOne, tabTwo)

      const first = await nameOf(tabOne)

      assert.equal(typeof first, 'string')
      assert.ok(!first.endsWith(' (B)'), 'a tab that opened the first save reads the other save after another tab switched')
      assert.ok((await nameOf(tabTwo)).endsWith(' (B)'))
      assert.equal((await call('reset', { storagePath: path.join(os.tmpdir(), 'not-allowed.db') })).status, 400, 'a save outside the list was opened')

      const again = (await call('reset', { storagePath: a })).body.token

      tokens.push(again)
      assert.equal(await nameOf(tabOne), first, 'a tab that opened its copy again replaced the copy of another')

      assert.equal((await call('release', { token: tabOne })).status, 200)

      const refused = await nameOf(tabOne)

      assert.equal(refused.status, 409, 'a closed copy still answers')
      assert.equal(refused.body.superseded, true)
      assert.ok((await nameOf(tabTwo)).endsWith(' (B)'))
    } finally {
      for (const token of tokens) {
        await call('release', { token })
      }

      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('the positions of the Galaxy Map are written through the database they began on: one retired mid-way stops the write, and nothing of it is kept', async () => {
    await scratch('aurora-positions-', async (root) => {
      const { resetDatabase, retireDatabase } = m['renderer/utilities/database']
      const { isRetired } = m['renderer/utilities/retired']
      const file = path.join(root, 'AuroraDB.db')

      fs.copyFileSync(a, file)

      const database = resetDatabase(file)
      const replacement = resetDatabase(file)
      const [rows] = await database.query(`select SystemID, Xcor, Ycor from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} order by SystemID limit 2`)
      const ids = rows.map((row) => row.SystemID)
      const positions = Object.fromEntries(ids.map((id) => [id, { x: 123456.4, y: 654321.6 }]))
      const query = database.query
      let reached = null
      let release = null
      const second = new Promise((resolve) => { reached = resolve })
      const gate = new Promise((resolve) => { release = resolve })
      let updates = 0

      // The page's own database is replaced while the map is open: what the page would read as `this.database` becomes the replacement.
      globalThis.__positionsDatabase = replacement
      database.query = async (sql, options) => {
        if (/^update/i.test(sql) && ++updates === 2) {
          reached()
          await gate
        }

        return query(sql, options)
      }

      const saving = m['renderer/utilities/map-positions'].savePositions(database, { GameID: GAME, RaceID: RACE, ids, positions }).then(() => null, (error) => error)

      await second

      const retiring = retireDatabase(database)

      release()

      const error = await saving

      await retiring
      assert.ok(error && isRetired(error), `the save was answered as ${error ? error.name + ': ' + error.message : 'a success'}`)

      const [after] = await replacement.query(`select SystemID, Xcor, Ycor from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} order by SystemID limit 2`)

      assert.deepEqual(after, rows, 'a position of a save that was reported as failed was kept')
      await retireDatabase(replacement)
      delete globalThis.__positionsDatabase
      fs.rmSync(file)
    })
  })

  test('a copy the dev server lost is opened again once, and the loss of a copy that is no longer the open one is ignored', async () => {
    const w = await world({})
    const lost = (database) => globalThis.window.dispatchEvent(new CustomEvent('aurora:database-lost', { detail: { database } }))
    const old = w.store.state.database
    const { generation } = w.store.state.freshness

    lost(old)
    await until(() => w.store.state.freshness.generation === generation + 1 && w.store.state.database !== old, 'the save to be opened again')
    assert.equal(w.store.state.freshness.file.kind, 'error', 'the loss is not said')
    await sleep(200)
    lost(old)
    await sleep(300)
    assert.equal(w.store.state.freshness.generation, generation + 1, 'the loss of a copy already replaced opened the save again')
  })

  // The dev server's middleware over HTTP, with the saves A and B allowed.
  const devServer = async (more = []) => {
    const http = require('http')

    process.env.AURORA_DB = a
    process.env.AURORA_DB_SAVES = [b, ...more].join(path.delimiter)

    const middleware = freshMiddleware()
    const handler = middleware.databaseHandler(async () => m['renderer/utilities/database'])
    const server = http.createServer((req, res) => handler(req, res))

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

    const call = async (route, body) => {
      const response = await fetch(`http://localhost:${server.address().port}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [middleware.TOKEN_HEADER]: middleware.TOKEN }, body: JSON.stringify(body) })

      return { status: response.status, body: await response.json() }
    }
    const raw = (route) => fetch(`http://localhost:${server.address().port}/${route}`, { headers: { [middleware.TOKEN_HEADER]: middleware.TOKEN } })
    const tokens = []
    const reset = async (file) => {
      const { body } = await call('reset', { storagePath: file })

      tokens.push(body.token)

      return body.token
    }

    return {
      call,
      raw,
      get: async (route) => {
        const response = await raw(route)

        return { status: response.status, body: await response.json() }
      },
      reset,
      read: (token) => call('query', { token, sql: 'select 1 as one' }),
      async close () {
        for (const token of tokens) {
          await call('release', { token })
        }

        await new Promise((resolve) => server.close(resolve))
      },
    }
  }

  test('the dev server pushes out the least recently used idle copy, and a copy it lost is answered as expired, not superseded', async () => {
    const server = await devServer()

    try {
      const first = await server.reset(a)
      const others = []

      for (let count = 1; count < 16; count++) {
        others.push(await server.reset(b))
      }

      assert.equal((await server.read(first)).status, 200)
      assert.equal((await server.read(others[0])).status, 200, 'a copy was pushed out below the bound')

      const newest = await server.reset(a)

      assert.equal((await server.read(first)).status, 200, 'a copy used lately was pushed out')

      const lost = await server.read(others[1])

      assert.equal(lost.status, 409)
      assert.equal(lost.body.expired, true, 'a copy pushed out was not said to be lost')
      assert.notEqual(lost.body.superseded, true, 'a copy pushed out was taken for one the page released')
      assert.equal((await server.read(newest)).status, 200)

      assert.equal((await server.call('release', { token: first })).status, 200)

      const released = await server.read(first)

      assert.equal(released.body.superseded, true, 'a released copy was not answered as superseded')
      assert.notEqual(released.body.expired, true)
    } finally {
      await server.close()
    }
  })

  test('the dev server answers the requests still queued on a copy that is released as superseded, not as a server error', async () => {
    const server = await devServer()

    try {
      const token = await server.reset(a)
      const slow = 'with recursive c(x) as (select 1 union all select x+1 from c where x < 400000000) select count(*) from c'
      const running = server.call('query', { token, sql: slow })

      await sleep(400)

      const queued = server.call('query', { token, sql: slow })

      await sleep(300)

      const released = server.call('release', { token })
      const answers = await Promise.all([running, queued, released])

      assert.deepEqual(answers.map((answer) => answer.status), [409, 409, 200], JSON.stringify(answers.map((answer) => answer.body)))
      assert.equal(answers[0].body.superseded, true)
      assert.equal(answers[1].body.superseded, true)
    } finally {
      await server.close()
    }
  })

  test('the web watcher reports a save that is deleted, recreated and changed the way the library does, from what the dev server says of the file', async () => {
    await scratch('aurora-webwatch-', async (root) => {
      const file = await savedIn(root)
      const server = await devServer([file])

      try {
        const present = await server.get(`stat?path=${encodeURIComponent(file)}`)

        assert.equal(present.status, 200)
        assert.equal(typeof present.body.mtimeMs, 'number')

        // The shim as the web build loads it, its request function standing in for the page's fetch of the dev server.
        const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
        const request = dataUrl('export const databaseRequest = (route, options) => globalThis.__webRequest(route, options)')
        const source = fs.readFileSync(path.join(base, 'scripts', 'web', 'shims', 'chokidar.js'), 'utf8').replace("from './database-request'", `from '${request}'`)
        const shim = await import(dataUrl(source))
        const events = []

        globalThis.__webRequest = (route) => server.raw(route.replace(/^\//, ''))

        const watcher = shim.watch(file)

        ;['add', 'change', 'unlink', 'error'].forEach((event) => watcher.on(event, () => events.push(event)))

        try {
          await until(() => events.includes('add'), 'the first add', 10000)
          assert.deepEqual(events, ['add'])

          fs.rmSync(file)
          await until(() => events.includes('unlink'), 'the unlink of the deleted save', 10000)
          assert.deepEqual(events, ['add', 'unlink'], 'a deleted save was not reported once as removed')

          const gone = await server.get(`stat?path=${encodeURIComponent(file)}`)

          assert.deepEqual(gone.body, { missing: true })
          assert.equal(gone.status, 200)

          fs.copyFileSync(a, file)
          await until(() => events.length === 3, 'the add of the recreated save', 10000)
          assert.deepEqual(events, ['add', 'unlink', 'add'], 'a recreated save was not reported as added')

          const stamp = new Date(Date.now() + 60000)

          fs.utimesSync(file, stamp, stamp)
          await until(() => events.length === 4, 'the change of the touched save', 10000)
          assert.equal(events[3], 'change')
        } finally {
          await watcher.close()
          delete globalThis.__webRequest
        }
      } finally {
        await server.close()
      }
    })
  })

  return cases
}

// ---- Running -----------------------------------------------------------------------------------------------------------

// The cases of `only` (the starts of their names) or all of them.
const runSuite = async (modules, fixtures, only = null, base = repo) => {
  const results = []

  for (const { name, run } of defineSuite(modules, fixtures, base)) {
    if (only && !only.some((start) => name.startsWith(start))) {
      continue
    }

    try {
      let timer
      const late = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`The case took more than ${CASE_TIMEOUT_MS / 1000} s`)), CASE_TIMEOUT_MS)
      })

      await Promise.race([run(), late]).finally(() => clearTimeout(timer))
      results.push({ name, error: null })
    } catch (error) {
      results.push({ name, error })
    }

    await closeWorlds(modules)
  }

  return results
}

const loadModules = (base) => loadUtilities(MODULES, { stubs: STUBS, directory: base })

const copySources = (copy) => {
  fs.cpSync(path.join(src, 'main'), path.join(copy, 'main'), { recursive: true })
  fs.cpSync(path.join(src, 'renderer', 'utilities'), path.join(copy, 'renderer', 'utilities'), { recursive: true })
  fs.cpSync(path.join(src, 'renderer', 'store'), path.join(copy, 'renderer', 'store'), { recursive: true })
  fs.cpSync(path.join(src, 'renderer', 'plugins'), path.join(copy, 'renderer', 'plugins'), { recursive: true })
  fs.mkdirSync(path.join(copy, 'scripts', 'web'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'scripts', 'web', 'database-middleware.js'), path.join(copy, 'scripts', 'web', 'database-middleware.js'))
  fs.mkdirSync(path.join(copy, 'scripts', 'web', 'shims'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'scripts', 'web', 'shims', 'chokidar.js'), path.join(copy, 'scripts', 'web', 'shims', 'chokidar.js'))
}

const MUTATIONS = [
  { name: 'a switch that does not check the file first', file: 'main/saves.js', find: 'if (!found.ok) {\n      if (chosen) {', replace: 'if (false) {\n      if (chosen) {', fails: ['a recent save that is missing'] },
  { name: 'a recent list that has no bound', file: 'main/saves.js', find: 'saves.slice(0, limit)', replace: 'saves', fails: ['the recent list keeps the ten latest'] },
  { name: 'a router that never sends a window to the one that has the save', file: 'main/launch.js', find: "return found ? { action: 'focus', id: found.id } : { action: 'switch' }", replace: "return { action: 'switch' }", fails: ['a save open in another window'] },
  { name: 'a service that answers the flags of a save the window left', file: 'main/saves.js', find: "typeof database === 'string' && windows.has(id) && same(database, windows.databaseOf(id))", replace: 'true', fails: ['a late flag for the save left'] },
  { name: 'a flag cache that takes an answer for another save', file: 'renderer/utilities/flags.js', find: '(scope === mine ? url : null)', replace: 'url', fails: ['a late flag for the save left'] },
  { name: 'a flag cache kept across saves', file: 'renderer/utilities/flags.js', find: '  scope = database\n  flags = new Map()', replace: '  scope = database', fails: ['an A to B to A switch'] },
  { name: 'a switch that keeps the game and race picked', file: 'renderer/store/index.js', find: "    commit('clearSelection')\n", replace: '', fails: ['a switch drops the game'] },
  { name: 'a switch that keeps the empire list', file: 'renderer/store/index.js', find: "    commit('empires/reset')\n", replace: '', fails: ['a switch drops the game'] },
  { name: 'a switch that keeps what was read of the save left', file: 'renderer/store/index.js', find: "    commit('freshness/switched')\n", replace: '', fails: ['a switch drops the game'] },
  { name: 'a switch that keeps the campaigns settled for the save left', file: 'renderer/store/index.js', find: "    commit('history/reset')\n", replace: '', fails: ['a switch drops the game'] },
  { name: 'a switch that keeps the page of the save left', file: 'renderer/store/index.js', find: "    if (this.$router && this.$router.currentRoute.path !== '/') {", replace: '    if (false) {', fails: ['a switch drops the game'] },
  { name: 'an empire list that takes any answer', file: 'renderer/store/empires.js', find: 'if (read === latest && rootState.database === database) {\n        const before = state.games', replace: 'if (true) {\n        const before = state.games', fails: ['a late empire list'] },
  { name: 'a switch that keeps the recording lock of the save left', file: 'renderer/store/index.js', find: '    releaseRecording()\n', replace: '', fails: ['a switch gives up the recording lock'] },
  { name: 'a switch that leaves the connection of the save left open', file: 'renderer/store/index.js', find: 'return retireDatabase(previous)', replace: 'return Promise.resolve()', fails: ['the save left is closed'] },
  { name: 'a watcher that is not closed when the save changes', file: 'renderer/utilities/save-watcher.js', find: '    const closing = retire()\n', replace: '    const closing = Promise.resolve()\n', fails: ['one watcher follows the save shown'] },
  { name: 'a watcher that opens the save a second time on its first notification', file: 'renderer/utilities/save-watcher.js', find: 'if (!opened) {', replace: 'if (true) {', fails: ['one watcher follows the save shown'] },
  { name: 'a watcher that acts after it was closed', file: 'renderer/utilities/save-watcher.js', find: 'const alive = () => mine.live && current === mine && store.state.savePath === path', replace: 'const alive = () => true', fails: ['a late notification from the watcher'] },
  { name: 'a database that sends the statements of a retired transaction on', file: 'renderer/utilities/database.js', find: '(retired && !ENDS_TRANSACTION.test(String(sql))) || ', replace: '', fails: ['a transaction open when its database is retired'] },
  { name: 'a database that passes the error of an interrupted read on as it is', file: 'renderer/utilities/database.js', find: 'active.then(resolve, (error) => reject(asRetired(error))).then(finish)', replace: 'active.then(resolve, reject).then(finish)', fails: ['a read that is running when its database is retired'] },
  { name: 'a database that passes the error of an interrupted transaction statement on as it is', file: 'renderer/utilities/database.js', find: 'query(sql, options).catch((error) => { throw asRetired(error) })', replace: 'query(sql, options)', fails: ['a statement of a transaction that is running when'] },
  { name: 'a database that reports every failure as retired', file: 'renderer/utilities/database.js', find: '(retired && !isRetired(error) && interrupted(error) ? new DatabaseRetired(error) : error)', replace: '(isRetired(error) ? error : new DatabaseRetired(error))', fails: ['a statement that fails for its own reason', 'a genuine error of a', 'a failure to open the file'] },
  { name: 'a database that reports any error that arrives after the retiring as retired', file: 'renderer/utilities/database.js', find: 'retired && !isRetired(error) && interrupted(error) ?', replace: 'retired && !isRetired(error) ?', fails: ['a genuine error of a', 'a failure to open the file'] },
  { name: 'a database that does not wait for its open transactions', file: 'renderer/utilities/database.js', find: '      transactions.add(ended)\n', replace: '', fails: ['a transaction that ends while its database is retiring'] },
  { name: 'a database that refuses the statement that ends a transaction', file: 'renderer/utilities/database.js', find: '/^\\s*(commit|rollback)\\b/i', replace: '/^never$/', fails: ['a transaction that ends while its database is retiring'] },
  { name: 'a store that makes the database reactive', file: 'renderer/store/index.js', find: 'markRaw(cacheQueries(resetDatabase(storagePath)))', replace: 'cacheQueries(resetDatabase(storagePath))', fails: ['the database kept in the store'] },
  { name: 'a capability check that reports what a switch cut off', file: 'renderer/store/capabilities.js', find: 'if (!isRetired(error) && checks.get(database) === check && generation === rootState.freshness.generation && database === rootState.database) {', replace: 'if (true) {', fails: ['a capability check cut off by a switch'] },
  { name: 'a capability check that reports nothing', file: 'renderer/store/capabilities.js', find: 'if (!isRetired(error) && checks.get(database) === check && generation === rootState.freshness.generation && database === rootState.database) {', replace: 'if (false) {', fails: ['a capability check of the copy now open'] },
  { name: 'a recording pass that reports after it was replaced', file: 'renderer/plugins/history.js', find: 'if (superseded || !isCurrent()) {', replace: 'if (false) {', fails: ['a recording pass cut off by a switch'] },
  { name: 'a dev server that answers every copy from the newest', file: 'scripts/web/database-middleware.js', find: "const connection = typeof token === 'string' ? connections.get(token) : null", replace: 'const connection = [...connections.values()].pop()', fails: ['two tabs on one dev server'] },
  { name: 'a dev server that does not remember the copies a page released', file: 'scripts/web/database-middleware.js', find: '  released.add(token)\n', replace: '', fails: ['two tabs on one dev server', 'the dev server pushes out the least recently used'] },
  { name: 'a database that lets a suspended transaction commit after the retiring ended it', file: 'renderer/utilities/database.js', find: 'started.commit = () => (cancelled.has(started) ? Promise.reject(new DatabaseRetired()) : commit())', replace: 'started.commit = () => commit()', fails: ['a transaction still suspended past the retiring'] },
  { name: 'a database that does not end a suspended transaction before it closes', file: 'renderer/utilities/database.js', find: '    stranded.forEach((started) => cancelled.add(started))\n', replace: '    stranded.length = 0\n', fails: ['a transaction still suspended past the retiring'] },
  { name: 'a map save that sends its statements through whatever database the page has now', file: 'renderer/utilities/map-positions.js', find: '    await database.query(', replace: '    await (globalThis.__positionsDatabase || database).query(', fails: ['the positions of the Galaxy Map'] },
  { name: 'a plugin that reopens the save for the loss of any copy', file: 'renderer/plugins/database.js', find: 'event.detail.database === store.state.database && ', replace: '', fails: ['a copy the dev server lost'] },
  { name: 'a plugin that ignores the loss of the copy', file: 'renderer/plugins/database.js', find: '      watcher.retry()\n    }\n  })\n\n  // The main process names', replace: '    }\n  })\n\n  // The main process names', fails: ['a copy the dev server lost'] },
  { name: 'a dev server that pushes out the oldest copy whatever its use', file: 'scripts/web/database-middleware.js', find: '.sort((one, two) => one[1].used - two[1].used)', replace: '', fails: ['the dev server pushes out the least recently used'] },
  { name: 'a dev server that takes a lost copy for a released one', file: 'scripts/web/database-middleware.js', find: "no longer open on the server.', { expired: true })", replace: "no longer open on the server.', { superseded: true })", fails: ['the dev server pushes out the least recently used'] },
  { name: 'a dev server that leaves what a released copy had queued unclassified', file: 'scripts/web/database-middleware.js', find: 'if (released.has(token) || (error && error.retired)) {', replace: 'if (false) {', fails: ['the dev server answers the requests still queued'] },
  { name: 'a watcher that opens the save for every notification', file: 'renderer/utilities/save-watcher.js', find: "      recovery({ state: 'reconnecting', attempt: 0, limit: retryMs.length, nextAt: now + delay, message: null })\n      wait(delay, reload)", replace: '      reload()', fails: ['a burst of notifications'] },
  { name: 'a watcher that waits out a burst that never ends', file: 'renderer/utilities/save-watcher.js', find: 'const delay = Math.min(settleMs, Math.max(0, mine.burstAt + maxWaitMs - now))', replace: 'const delay = settleMs', fails: ['a burst of notifications'] },
  { name: 'a watcher that opens a copy while another is still being read', file: 'renderer/utilities/save-watcher.js', find: '      if (mine.running !== null) {\n        mine.again = true', replace: '      if (false) {\n        mine.again = true', fails: ['a burst of notifications'] },
  { name: 'a watcher that retries without end', file: 'renderer/utilities/save-watcher.js', find: 'if (mine.attempt < retryMs.length) {\n        const delay = retryMs[mine.attempt]', replace: 'if (true) {\n        const delay = retryMs[Math.min(mine.attempt, retryMs.length - 1)]', fails: ['a file that stays unreadable'] },
  { name: 'a watcher that never retries', file: 'renderer/utilities/save-watcher.js', find: 'if (mine.attempt < retryMs.length) {', replace: 'if (false) {', fails: ['a save that is locked for a while', 'a file that stays unreadable', 'an error of the watcher'] },
  { name: 'a watcher that retries a save that is missing', file: 'renderer/utilities/save-watcher.js', find: "      if (mine.removed) {\n        recovery({ state: 'missing'", replace: "      if (false) {\n        recovery({ state: 'missing'", fails: ['a save that is deleted and recreated'] },
  { name: 'a watcher that does not say the save is missing', file: 'renderer/utilities/save-watcher.js', find: "      recovery({ state: 'missing', attempt: 0, limit: retryMs.length, nextAt: null, message: 'The save file is missing' })\n", replace: '', fails: ['a save that is deleted and recreated'] },
  { name: 'a manual retry that is not heard', file: 'renderer/plugins/database.js', find: "    if (mutation.type === 'freshness/retryRequested') {\n      watcher.retry()\n    }", replace: '', fails: ['a save that is deleted and recreated', 'a file that stays unreadable', 'the save is byte'] },
  { name: 'a manual retry that keeps the count of the retries made', file: 'renderer/utilities/save-watcher.js', find: '      mine.timer = null\n      mine.attempt = 0\n      reload()', replace: '      mine.timer = null\n      reload()', fails: ['a file that stays unreadable'] },
  { name: 'a watcher whose retry of the save left still runs', file: 'renderer/utilities/save-watcher.js', find: ['        if (alive()) {\n          run()\n        }', '    clearTimeout(watcher.timer)\n    watcher.unwatch()'], replace: ['        run()', '    watcher.unwatch()'], fails: ['the retry waiting'] },
  { name: 'a reload that keeps the selection of a removed game', file: 'renderer/store/empires.js', find: "    } else {\n      commit('clearSelection', null, { root: true })\n    }", replace: "    } else {\n      commit('peeks/reset', null, { root: true })\n    }", fails: ['a game removed on reload'] },
  { name: 'a reload that picks another game for the one removed', file: 'renderer/store/empires.js', find: "commit('clearSelection', null, { root: true })", replace: "commit('setGame', rootState.empires.games.find((one) => one.GameID !== GameID), { root: true })", fails: ['a game removed on reload'] },
  { name: 'a reload that picks another race for the one removed', file: 'renderer/store/empires.js', find: "commit('clearRace', null, { root: true })", replace: "commit('setRace', rootState.empires.games.find((one) => one.GameID === GameID).Races.find((one) => one.RaceID !== RaceID), { root: true })", fails: ['a race removed on reload'] },
  { name: 'a reload that keeps the race removed', file: 'renderer/store/empires.js', find: "commit('clearRace', null, { root: true })", replace: "commit('peeks/reset', null, { root: true })", fails: ['a race removed on reload'] },
  { name: 'a reload that keeps what was derived from a removed selection', file: 'renderer/store/empires.js', find: "    commit('peeks/reset', null, { root: true })\n    commit('navigation/reset', undefined, { root: true })\n", replace: '', fails: ['a game removed on reload', 'a race removed on reload'] },
  { name: 'a reload that leaves the page of a removed selection open', file: 'renderer/store/empires.js', find: "    if (this.$router && this.$router.currentRoute.path !== '/') {", replace: '    if (false) {', fails: ['a game removed on reload', 'a race removed on reload'] },
  { name: 'a reload that keeps the clock of the selection it read before', file: 'renderer/store/empires.js', find: "        commit('setGameTime', game, { root: true })", replace: '        void game', fails: ['a game and race that are still'] },
  { name: 'a reload that writes to the save', file: 'renderer/store/freshness.js', find: '      const [rows] = await database.query(PROBE_SQL, { raw: true })', replace: "      await database.query('update FCT_Game set GameTime = GameTime + 1', { raw: true })\n      const [rows] = await database.query(PROBE_SQL, { raw: true })", fails: ['the save is byte'] },
  { name: 'a recovery that words a spent retry as a waiting one', file: 'renderer/store/freshness.js', find: '      if (recovery.nextAt === null) {', replace: '      if (false) {', fails: ['the recovery is worded'] },
  { name: 'a web watcher that does not report a deleted save', file: 'scripts/web/shims/chokidar.js', find: "        emit('unlink', path)", replace: '        void path', fails: ['the web watcher'] },
  { name: 'a dev server that answers the stat of a missing save with an error', file: 'scripts/web/database-middleware.js', find: '        return { missing: true }', replace: '        throw error', fails: ['the web watcher'] },
  { name: 'a reload that takes a game the list does not show for gone', file: 'renderer/store/empires.js', find: '    const { game, race } = found\n', replace: '    const { race } = found\n    const game = rootState.empires.games.find((one) => one.GameID === GameID) ? found.game : null\n', fails: ['the last race the list shows'] },
  { name: 'a check of the selection that fails taken for a save without the game', file: 'renderer/store/empires.js', find: '      return false\n    }\n\n    if (rootState.database !== database', replace: '      found = { game: null, race: null }\n    }\n\n    if (rootState.database !== database', fails: ['a check of the selection that fails'] },
  { name: 'a check of the selection that is not made again after it failed', file: 'renderer/store/empires.js', find: '            readFor = null\n', replace: '            void readFor\n', fails: ['a check of the selection that fails'] },
  { name: 'a watcher that takes up only the copies its own reload opened', file: 'renderer/utilities/save-watcher.js', find: ["      if (refresh.outcome === 'reading') {\n        mine.running = refresh.generation\n\n        return\n      }", "      store.dispatch('renew', { storagePath: path })\n    }"], replace: ["      if (refresh.outcome === 'reading') {\n        return\n      }", "      store.dispatch('renew', { storagePath: path })\n      mine.running = store.state.freshness.generation\n    }"], fails: ['a save switched to while it is locked'] },
  { name: 'a watcher that counts an error during a read twice', file: 'renderer/utilities/save-watcher.js', find: '      if (!reading) {\n        failed(', replace: '      if (true) {\n        failed(', fails: ['an error of the watcher while a copy is being read'] },
  { name: 'a watcher that goes on after it was stopped', file: 'renderer/utilities/save-watcher.js', find: ['const alive = () => mine.live && current === mine && store.state.savePath === path', '    clearTimeout(watcher.timer)\n    watcher.unwatch()\n'], replace: ['const alive = () => store.state.savePath === path', ''], fails: ['a world that is closed stops its recovery'] },
  { name: 'a store that does not refuse a second request', file: 'renderer/store/saves.js', find: '  if (state.busy) {\n    return { ok: true, action: \'busy\' }\n  }\n', replace: '', fails: ['a second request while one is out'] },
]

// `--mutant=<start of a name>` (repeatable) runs only those mutants, and not the suite itself.
const MUTANTS = process.argv.filter((argument) => argument.startsWith('--mutant=')).map((argument) => argument.slice(9))

const applyMutations = async (copy, fixtures) => {
  const results = []

  for (const mutation of MUTATIONS) {
    if (MUTANTS.length && !MUTANTS.some((start) => mutation.name.startsWith(start))) {
      continue
    }

    const target = path.join(copy, mutation.file)
    const original = fs.readFileSync(target, 'utf8')
    // `find` and `replace` are each one text, or lists of texts of the same length that are applied in turn.
    const finds = [].concat(mutation.find)
    const replaces = [].concat(mutation.replace)
    let broken = original
    let missing = null

    finds.forEach((text, index) => {
      const parts = broken.split(text)

      if (parts.length !== 2) {
        missing = missing || `The text to break is not in ${mutation.file} exactly once (${parts.length - 1} found)`
      }

      broken = parts.join(replaces[index])
    })

    if (missing) {
      results.push({ name: `mutation: ${mutation.name}`, error: new Error(missing) })
      continue
    }

    fs.writeFileSync(target, broken)

    try {
      const modules = await loadModules(copy)
      const outcome = await runSuite(modules, fixtures, mutation.fails, copy)
      const failed = outcome.filter((entry) => entry.error)
      const missed = mutation.fails.filter((start) => !failed.some((entry) => entry.name.startsWith(start)))

      results.push({ name: `mutation: ${mutation.name} is caught by ${mutation.fails.join(', ')}`, error: missed.length ? new Error(`Not caught by: ${missed.join(', ')}`) : null })
    } catch (error) {
      results.push({ name: `mutation: ${mutation.name}`, error })
    } finally {
      fs.writeFileSync(target, original)
    }
  }

  return results
}

const main = async () => {
  if (!fs.existsSync(SAVE)) {
    console.log(`AuroraDB.db is not here (${SAVE}); the check needs it.`)
    process.exit(1)
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-switching-'))
  const log = console.log
  const warn = console.warn
  const error = console.error
  const quiet = () => {
    console.log = () => {}
    console.warn = () => {}
    console.error = () => {}
  }
  const loud = () => {
    console.log = log
    console.warn = warn
    console.error = error
  }

  process.env.NODE_PATH = path.join(repo, 'node_modules')
  requireHere('module')._initPaths()

  globalThis.__stores = new Map()
  globalThis.__ipc = { target: null, invoke: (...args) => globalThis.__ipc.target.invoke(...args) }
  installLocks()

  let results = []

  try {
    const fixtures = await makeSaves(root)

    quiet()

    const modules = await loadModules(src)

    const only = process.argv.filter((argument) => argument.startsWith('--only=')).map((argument) => argument.slice(7))

    results = MUTANTS.length ? [] : await runSuite(modules, fixtures, only.length ? only : null)

    if (!process.argv.includes('--no-mutations') && !process.argv.some((argument) => argument.startsWith('--only='))) {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-switching-src-'))

      try {
        copySources(copy)
        results.push(...await applyMutations(copy, fixtures))
      } finally {
        fs.rmSync(copy, { recursive: true, force: true })
      }
    }
  } finally {
    loud()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  const failed = results.filter((entry) => entry.error)

  results.forEach(({ name, error }) => console.log(`${error ? '  FAIL ' : '  ok   '} ${name}${error ? `\n         ${String(error.stack || error).split('\n').slice(0, 4).join('\n         ')}` : ''}`))
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
