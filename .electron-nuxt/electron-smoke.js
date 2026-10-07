/*
  Smoke test for the Electron app. Builds the development main process and serves the renderer
  itself (under dist/smoke, on a free port, Sentry off), so it runs alongside `yarn dev` or
  `yarn web` without touching theirs. Then launches Electron through Playwright on a copy of the
  save and a fresh user-data folder, so your save, settings and history are never touched.
  Besides visiting every page like web:smoke, it checks what only Electron has: the storage-path
  IPC, the race-flag IPC, the electron-store files in user data (settings and Empire History), and the save watcher
  reloading the database. Database calls run in the renderer, so they're counted by wrapping the
  Sequelize instance.

  Env: AURORA_DB (the save to copy, default ./AuroraDB.db), AURORA_GAME and AURORA_RACE (sample
  defaults), SMOKE_OUT (screenshot dir, default <tmp>/aurora-electron-smoke), SMOKE_PAGES
  (comma-separated routes, default the list in smoke-pages.js), PORT (renderer server, default a
  free one).
 */
process.env.NODE_ENV = 'development'

const os = require('os')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { execFileSync } = require('child_process')

const GAME = process.env.AURORA_GAME || 'Aurelian Empire'
const RACE = process.env.AURORA_RACE || 'Aurelian Empire'
const OUT = process.env.SMOKE_OUT || path.join(os.tmpdir(), 'aurora-electron-smoke')
const PAGES = process.env.SMOKE_PAGES ? process.env.SMOKE_PAGES.split(',') : require('./smoke-pages')

const SETTLE_MS = 1500
const PAGE_TIMEOUT_MS = 90000

// Main-process output that isn't a problem: the inspector banner, and the DevTools window and Vue
// devtools extension the dev boot opens and installs, which log from devtools:// pages and
// Electron's sandbox (the app's own window isn't sandboxed).
const MAIN_NOISE = [/Debugger (listening|attached|ending)/, /For help, see/, /DevTools listening/, /ExtensionLoadWarning/, /Permission 'scripting'/, /trace-warnings/, /source: devtools:\/\//, /source: node:electron\/js2c\/sandbox_bundle/]

// A 1x1 PNG.
const FLAG_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The running app, stopped on the way out even when a step throws.
let launched = null

const stopTree = (app) => {
  const { pid } = app.process()

  // Electron's helper processes outlive a plain kill on Windows.
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch (error) {
      // Already gone.
    }

    return Promise.resolve()
  }

  return app.close()
}

// Counts the renderer's database calls and keeps their failures, re-wrapping each database the
// store swaps in when the save changes.
const instrument = () => {
  const smoke = (window.__smoke = window.__smoke || { pending: new Map(), next: 0, last: Date.now(), errors: [], counts: {}, done: [], blockedMs: 0, databases: 0 })

  // Time the renderer's main thread spends in tasks over 50 ms, which delays everything queued behind them.
  new PerformanceObserver((list) => list.getEntries().forEach((entry) => (smoke.blockedMs += entry.duration))).observe({ entryTypes: ['longtask'] })

  const wrap = (database) => {
    if (!database || database.__smokeWrapped) {
      return
    }

    const query = database.query.bind(database)

    database.__smokeWrapped = true
    smoke.databases++
    database.query = (sql, ...rest) => {
      const id = smoke.next++

      smoke.pending.set(id, { sql: String(sql).slice(0, 160), started: Date.now() })
      smoke.counts[String(sql).slice(0, 160)] = (smoke.counts[String(sql).slice(0, 160)] || 0) + 1
      smoke.last = Date.now()

      return query(sql, ...rest).catch((error) => {
        smoke.errors.push(`${error.message} :: ${String(sql).slice(0, 160)}`)

        throw error
      }).finally(() => {
        smoke.done.push({ ...smoke.pending.get(id), ms: Date.now() - smoke.pending.get(id).started })
        smoke.pending.delete(id)
        smoke.last = Date.now()
      })
    }
  }

  window.$nuxt.$store.watch((state) => state.database, wrap, { immediate: true })
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()

  server.once('error', reject)
  server.listen(0, 'localhost', () => {
    const { port } = server.address()

    server.close(() => resolve(port))
  })
})

const buildMain = (outputPath) => {
  const webpack = require('webpack')
  const config = require('./main-webpack')(outputPath)

  config.mode = 'development'
  config.node = { __filename: true, __dirname: true }

  return new Promise((resolve, reject) => webpack(config).run((error, stats) => {
    if (error || stats.hasErrors()) {
      reject(error || new Error(stats.toString('errors-only')))
    } else {
      resolve(path.join(outputPath, 'index.js'))
    }
  }))
}

const serveRenderer = async (buildDir, port) => {
  const { Nuxt, Builder } = require('nuxt')
  const nuxtConfig = require('./renderer/nuxt.config.js')

  // Its own build folder: `yarn dev` and `yarn web` share src/renderer/.nuxt.
  nuxtConfig.buildDir = buildDir
  nuxtConfig.build = { ...nuxtConfig.build, quiet: true }
  // Keep test sessions out of the Sentry project.
  nuxtConfig.sentry = { ...nuxtConfig.sentry, disabled: true }

  const nuxt = new Nuxt(nuxtConfig)

  await nuxt.ready()
  await new Builder(nuxt).build()
  await nuxt.listen(port, 'localhost')

  if (new URL(nuxt.server.listeners[0].url).port !== String(port)) {
    await nuxt.close()
    throw new Error(`Port ${port} is in use.`)
  }

  return nuxt
}

const run = async () => {
  const port = Number(process.env.PORT) || await freePort()

  // The main bundle loads the renderer from SERVER_PORT, which config reads from PORT.
  process.env.PORT = String(port)

  const { PROJECT_ROOT, DIST_DIR } = require('./config')
  const { _electron } = require('playwright')
  const electronPath = require('electron')
  const SAVE = path.resolve(process.env.AURORA_DB || path.join(PROJECT_ROOT, 'AuroraDB.db'))

  // Under the project, so the renderer's Node requires find node_modules from the main script.
  // The run folder (the save copy and user data) is kept until the next run for inspection.
  const builds = path.join(DIST_DIR, 'smoke')
  const work = path.join(builds, 'run')
  const userData = path.join(work, 'user-data')
  const save = path.join(work, 'AuroraDB.db')

  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  fs.mkdirSync(work, { recursive: true })
  fs.copyFileSync(SAVE, save)
  fs.mkdirSync(OUT, { recursive: true })

  // A race flag beside the save, and a look-alike one level up that a flag name must never reach.
  fs.mkdirSync(path.join(work, 'Flags'))
  fs.writeFileSync(path.join(work, 'Flags', 'smoke-flag.png'), FLAG_PNG)
  fs.writeFileSync(path.join(work, 'secret.png'), FLAG_PNG)

  console.log(`Building the main process and the renderer (port ${port})...`)

  const [entry, nuxt] = await Promise.all([buildMain(path.join(builds, 'main')), serveRenderer(path.join(builds, 'nuxt'), port)])

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [entry, `--user-data-dir=${userData}`],
    cwd: work,
    env: { ...process.env, NODE_ENV: 'development' },
  })

  launched = app

  let problems = []
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })

  app.process().stderr.on('data', (data) => String(data).split(/\r?\n/).filter((line) => line.trim() && !MAIN_NOISE.some((noise) => noise.test(line))).forEach((line) => problems.push(`main: ${line.trim()}`)))

  const appWindow = async () => {
    const started = Date.now()

    while (Date.now() - started < PAGE_TIMEOUT_MS) {
      const found = app.windows().find((candidate) => candidate.url().startsWith('http'))

      if (found) {
        return found
      }

      await wait(250)
    }

    throw new Error('The app window never opened.')
  }

  const page = await appWindow()

  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  const smokeState = () => page.evaluate(() => ({
    inFlight: window.__smoke.pending.size,
    oldest: [...window.__smoke.pending.values()].slice(0, 3).map(({ sql, started }) => `${Math.round((Date.now() - started) / 1000)} s: ${sql}`),
    last: window.__smoke.last,
    now: Date.now(),
    errors: window.__smoke.errors.splice(0),
  }))

  const settle = async () => {
    const started = Date.now()

    while (true) {
      const state = await smokeState()

      state.errors.forEach((error) => problems.push(`db: ${error}`))

      if (state.inFlight <= 0 && state.now - state.last >= SETTLE_MS) {
        return
      }

      if (Date.now() - started > PAGE_TIMEOUT_MS) {
        problems.push(`timeout: ${state.inFlight} database calls still pending`)
        state.oldest.forEach((call) => problems.push(`pending ${call}`))
        // What kept the page busy: queries it repeats, its slowest ones, and a blocked main thread.
        const busy = await page.evaluate(() => ({
          repeated: Object.entries(window.__smoke.counts).sort((a, b) => b[1] - a[1]).slice(0, 2),
          slowest: window.__smoke.done.sort((a, b) => b.ms - a.ms).slice(0, 2),
          blockedMs: Math.round(window.__smoke.blockedMs),
        }))

        busy.repeated.forEach(([sql, count]) => problems.push(`ran ${count}x: ${sql}`))
        busy.slowest.forEach(({ sql, ms }) => problems.push(`took ${(ms / 1000).toFixed(1)} s: ${sql}`))
        problems.push(`main thread blocked ${(busy.blockedMs / 1000).toFixed(1)} s in long tasks`)

        return
      }

      await wait(250)
    }
  }

  try {
    // The dev server can reload the page while it finishes loading, so wait for a loaded save.
    await page.waitForFunction(() => window.$nuxt && window.$nuxt.$store && window.$nuxt.$store.state.database, null, { timeout: PAGE_TIMEOUT_MS })
    await page.evaluate(instrument)
    // The picker shows until a race is chosen. A game with one race selects on click; otherwise the race is next.
    const picker = page.locator('.game-picker')

    await picker.getByText(GAME, { exact: true }).first().click({ timeout: PAGE_TIMEOUT_MS })

    const raceItem = picker.getByText(RACE, { exact: true })

    if (await raceItem.count()) {
      await raceItem.last().click()
    }

    await settle()
  } catch (error) {
    const screenshot = path.join(OUT, 'setup.png')

    await page.screenshot({ path: screenshot }).catch(() => {})
    console.log(`setup failed (${screenshot}):`)
    problems.forEach((problem) => console.log(`  ${problem.slice(0, 300)}`))

    throw error
  }

  const setupProblems = problems
  const results = []

  for (const route of PAGES) {
    problems = []

    await page.evaluate((target) => {
      Object.assign(window.__smoke, { counts: {}, done: [], blockedMs: 0 })
      window.$nuxt.$router.push(target)
    }, route)
    await wait(250)
    await settle()

    const name = route === '/' ? 'production' : route.slice(1)
    const screenshot = path.join(OUT, `${name}.png`)

    await page.screenshot({ path: screenshot })

    const stats = await page.evaluate(() => ({
      rows: document.querySelectorAll('.v-data-table tbody tr').length,
      text: document.querySelector('.v-main, .v-content') ? document.querySelector('.v-main, .v-content').innerText.length : 0,
    }))

    results.push({ route, ...stats, problems, screenshot })
  }

  problems = []

  const { GameID, RaceID, settingsPath, revision } = await page.evaluate(() => {
    const { state } = window.$nuxt.$store

    return { GameID: state.GameID, RaceID: state.RaceID, settingsPath: state.config.path, revision: state.history.revision }
  })

  check('storage path IPC', GameID !== null, GameID !== null ? `loaded ${save}` : 'no game loaded')
  check('settings in user data', path.dirname(settingsPath) === userData, settingsPath)

  const [found, missing, escaped, escapedBackslash, notAName] = await page.evaluate(() => Promise.all(['smoke-flag.png', 'missing-flag.png', '../secret.png', '..\\secret.png', null].map((name) => window.require('electron').ipcRenderer.invoke('read-flag', name))))

  check('flag IPC', found === `data:image/png;base64,${FLAG_PNG.toString('base64')}` && missing === null && escaped === null && escapedBackslash === null && notAName === null, `found ${String(found).slice(0, 24)}..., missing ${missing}, dotdot ${escaped}, backslash ${escapedBackslash}, null ${notAName}`)

  const historyPath = path.join(userData, 'history', `game-${GameID}.json`)
  const readHistory = () => (fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : null)
  const snapshotCount = (history) => (history && history.races && history.races[RaceID] ? history.races[RaceID].snapshots.length : 0)
  const before = readHistory()

  check('history file written', snapshotCount(before) > 0, before ? `${historyPath}: ${snapshotCount(before)} snapshots for race ${RaceID}` : `${historyPath} missing`)

  // Rewrite the save with the same content: the watcher reloads the database and the recorder runs again.
  const databases = await page.evaluate(() => window.__smoke.databases)

  fs.copyFileSync(SAVE, save)

  try {
    await page.waitForFunction((count) => window.__smoke.databases > count, databases, { timeout: 30000 })
    await settle()
    await page.waitForFunction((count) => window.$nuxt.$store.state.history.revision > count, revision, { timeout: 30000 })

    const after = readHistory()

    check('save watcher reloads', true, `database reopened, history revision ${revision} -> ${await page.evaluate(() => window.$nuxt.$store.state.history.revision)}`)
    check('same save, same history', snapshotCount(after) === snapshotCount(before), `${snapshotCount(before)} -> ${snapshotCount(after)} snapshots`)
  } catch (error) {
    check('save watcher reloads', false, error.message.split('\n')[0])
  }

  await page.screenshot({ path: path.join(OUT, 'after-reload.png') })

  const reloadProblems = problems

  await stopTree(app)
  await nuxt.close()

  if (setupProblems.length) {
    console.log('setup:')
    setupProblems.forEach((problem) => console.log(`  ${problem.slice(0, 300)}`))
  }

  results.forEach(({ route, rows, text, problems: pageProblems, screenshot }) => {
    console.log(`${pageProblems.length ? 'FAIL' : 'ok  '} ${route.padEnd(15)} rows=${String(rows).padEnd(5)} text=${String(text).padEnd(7)} ${screenshot}`)
    pageProblems.slice(0, 10).forEach((problem) => console.log(`       ${problem.slice(0, 300)}`))
  })

  checks.forEach(({ name, ok, detail }) => console.log(`${ok ? 'ok  ' : 'FAIL'} electron: ${name.padEnd(24)} ${detail}`))
  reloadProblems.slice(0, 5).forEach((problem) => console.log(`       after reload: ${problem.slice(0, 300)}`))

  console.log(`run folder: ${work}`)

  process.exitCode = setupProblems.length || reloadProblems.length || results.some((result) => result.problems.length) || checks.some((result) => !result.ok) ? 1 : 0
}

// Nuxt's dev watchers would keep the process alive.
run().then(() => process.exit(process.exitCode), async (error) => {
  console.error(error)

  if (launched) {
    await stopTree(launched).catch(() => {})
  }

  process.exit(1)
})
