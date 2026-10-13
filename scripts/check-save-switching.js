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
    emit: (event, ...args) => (handlers[event] || []).forEach((handler) => handler(file, ...args)),
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
  for (const { store, watchers } of LIVE.splice(0)) {
    await Promise.all(watchers.filter((watcher) => !watcher.closed).map((watcher) => watcher.close()))
    await m['renderer/utilities/database'].retireDatabase(store.state.database).catch(() => {})
  }

  m['renderer/utilities/recording-owner'].releaseRecording()
}

const buildWorld = async (m, { start, saves, windows = null, chokidar = 'fake', recording = false, recent = [], dialog = null, hold = {}, onDatabase = null }) => {
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
  m['renderer/plugins/database'].default({ store })

  if (recording) {
    m['renderer/plugins/history'].default({ store, ownerGrace: 50 })
  }

  const world = { store, ipc, registry, service, recent: recentList, memory, picker, watchers, saves, start }

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

    try {
      await work(root)
    } finally {
      await closeWorlds(m)
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
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
  const devServer = async () => {
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
    const tokens = []
    const reset = async (file) => {
      const { body } = await call('reset', { storagePath: file })

      tokens.push(body.token)

      return body.token
    }

    return {
      call,
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
  { name: 'an empire list that takes any answer', file: 'renderer/store/empires.js', find: 'if (read === latest && rootState.database === database) {\n        commit(\'read\', games)', replace: "if (true) {\n        commit('read', games)", fails: ['a late empire list'] },
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
  { name: 'a plugin that ignores the loss of the copy', file: 'renderer/plugins/database.js', find: "store.dispatch('renew', { storagePath: store.state.savePath })\n    }\n  })", replace: '}\n  })', fails: ['a copy the dev server lost'] },
  { name: 'a dev server that pushes out the oldest copy whatever its use', file: 'scripts/web/database-middleware.js', find: '.sort((one, two) => one[1].used - two[1].used)', replace: '', fails: ['the dev server pushes out the least recently used'] },
  { name: 'a dev server that takes a lost copy for a released one', file: 'scripts/web/database-middleware.js', find: "no longer open on the server.', { expired: true })", replace: "no longer open on the server.', { superseded: true })", fails: ['the dev server pushes out the least recently used'] },
  { name: 'a dev server that leaves what a released copy had queued unclassified', file: 'scripts/web/database-middleware.js', find: 'if (released.has(token) || (error && error.retired)) {', replace: 'if (false) {', fails: ['the dev server answers the requests still queued'] },
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
    const parts = original.split(mutation.find)

    if (parts.length !== 2) {
      results.push({ name: `mutation: ${mutation.name}`, error: new Error(`The text to break is not in ${mutation.file} exactly once (${parts.length - 1} found)`) })
      continue
    }

    fs.writeFileSync(target, parts.join(mutation.replace))

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
