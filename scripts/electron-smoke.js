/*
  Smoke test for the Electron app (`bun run electron:smoke`, through run-vite.js). Builds the app with electron-vite into out/smoke in the `smoke` mode (a production build with Sentry off), so it runs alongside `bun run dev`, `bun run web` or a packaged build without touching theirs, and loads the renderer over app:// as the package does. Then launches Electron through Playwright on a copy of the save and a fresh user-data folder, so your save, settings and history are never touched. Besides visiting every page like web:smoke, it checks what only Electron has: the storage-path IPC, the race-flag IPC, the electron-store files in user data (settings and Empire History), and the save watcher reloading the database. Database calls run in the renderer, so they're counted by wrapping the Sequelize instance.

  Env: AURORA_DB (the save to copy, default ./AuroraDB.db), AURORA_GAME and AURORA_RACE (sample defaults), SMOKE_OUT (screenshot dir, default <tmp>/aurora-electron-smoke), SMOKE_PAGES (comma-separated routes, default the list in smoke-pages.js). SMOKE_MAP_EXPORT=1 checks complete PNG export, high-DPI borders and layout restoration on /map.
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pageLoading = require('./page-loading')

const PROJECT_ROOT = path.resolve(__dirname, '..')

const GAME = process.env.AURORA_GAME || 'Aurelian Empire'
const RACE = process.env.AURORA_RACE || 'Aurelian Empire'
const OUT = process.env.SMOKE_OUT || path.join(os.tmpdir(), 'aurora-electron-smoke')
const PAGES = process.env.SMOKE_PAGES ? process.env.SMOKE_PAGES.split(',') : require('./smoke-pages')

const SETTLE_MS = 1500
const PAGE_TIMEOUT_MS = 90000

// Main-process output that isn't a problem: the inspector and remote-debugging banners Playwright's launch causes.
const MAIN_NOISE = [/Debugger (listening|attached|ending)/, /For help, see/, /DevTools listening/, /trace-warnings/]

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

// Counts the renderer's database calls and keeps their failures, re-wrapping each database the store swaps in when the save changes. A read the app refused because its database was replaced (utilities/retired.js, marked `retired`) is counted apart: it is the intended end of work on the copy left, not a failure.
const instrument = () => {
  const smoke = (window.__smoke = window.__smoke || { pending: new Map(), next: 0, last: Date.now(), errors: [], retired: 0, counts: {}, done: [], blockedMs: 0, databases: 0 })

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
        if (error && error.retired === true) {
          smoke.retired++
        } else {
          smoke.errors.push(`${error.message} :: ${String(sql).slice(0, 160)}`)
        }

        throw error
      }).finally(() => {
        smoke.done.push({ ...smoke.pending.get(id), ms: Date.now() - smoke.pending.get(id).started })
        smoke.pending.delete(id)
        smoke.last = Date.now()
      })
    }
  }

  window.$app.$store.watch((state) => state.database, wrap, { immediate: true })
}

const run = async () => {
  const { _electron } = require('playwright')
  const electronPath = require('electron')
  const { build } = await import('electron-vite')
  const SAVE = path.resolve(process.env.AURORA_DB || path.join(PROJECT_ROOT, 'AuroraDB.db'))

  // Under the project, so the preload's requires (sequelize) find node_modules. The run folder (the save copy and user data) is kept until the next run for inspection.
  const builds = path.join(PROJECT_ROOT, 'out', 'smoke')
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

  console.log('Building the app...')

  await build({ mode: 'smoke', logLevel: 'warn', build: { outDir: builds } })

  // Without the dev server's address, the app loads the built renderer.
  const env = { ...process.env }

  // The app's development override must point at the smoke copy as well.
  env.AURORA_DB = save

  delete env.ELECTRON_RENDERER_URL

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [path.join(builds, 'main', 'index.js'), `--user-data-dir=${userData}`],
    cwd: work,
    env,
  })

  launched = app

  let problems = []
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })

  app.process().stderr.on('data', (data) => String(data).split(/\r?\n/).filter((line) => line.trim() && !MAIN_NOISE.some((noise) => noise.test(line))).forEach((line) => problems.push(`main: ${line.trim()}`)))

  const appWindow = async () => {
    const started = Date.now()

    while (Date.now() - started < PAGE_TIMEOUT_MS) {
      const found = app.windows().find((candidate) => candidate.url().startsWith('app://'))

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

      if (state.inFlight <= 0 && state.now - state.last >= SETTLE_MS && !(await page.evaluate(pageLoading))) {
        return
      }

      if (Date.now() - started > PAGE_TIMEOUT_MS) {
        problems.push(state.inFlight > 0 ? `timeout: ${state.inFlight} database calls still pending` : 'timeout: the page is still loading')
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
    await page.waitForFunction(() => window.$app && window.$app.$store && window.$app.$store.state.database, null, { timeout: PAGE_TIMEOUT_MS })
    await page.evaluate(instrument)
    // The Empires page shows dated game headings and each race's title. A game with one visible race selects that race from its heading.
    const picker = page.locator('.empire-list').first()

    await picker.locator('.empire-list__game').filter({ hasText: `${GAME} ·` }).first().click({ timeout: PAGE_TIMEOUT_MS })

    if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
      await picker.getByText(RACE, { exact: true }).last().click()
    }

    // The pages need the race, and each push to one is sent back to the Empires page until it is set.
    await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID), null, { timeout: PAGE_TIMEOUT_MS })

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

  if (process.env.SMOKE_MAP_EXPORT === '1') {
    // Capture the export in the smoke process without opening a native save dialog. Decode and write the real PNG produced by the renderer.
    await app.evaluate(({ ipcMain, nativeImage }, output) => {
      globalThis.__mapExports = []
      ipcMain.removeHandler('save-png')
      ipcMain.handle('save-png', (_event, data) => {
        const buffer = Buffer.from(data, 'base64')
        const image = nativeImage.createFromBuffer(buffer)
        const filePath = `${output}/map-export-${globalThis.__mapExports.length + 1}.png`

        globalThis.__mapExports.push({ ...image.getSize(), bytes: buffer.length, empty: image.isEmpty(), filePath, data })

        return { canceled: false, filePath }
      })
    }, OUT)
  }

  for (const route of PAGES) {
    problems = []

    // The router's push returns no promise and a page loads on its first visit, so the route on screen stays the previous page's, already settled, until the new one commits. Wait for the new one, then for its reads.
    await page.evaluate((target) => {
      Object.assign(window.__smoke, { counts: {}, done: [], blockedMs: 0 })
      window.$app.$router.push(target)
    }, route)

    const arrived = await page.waitForFunction(pageLoading.arrived, route, { timeout: PAGE_TIMEOUT_MS }).then(() => true, () => false)

    if (arrived) {
      await page.evaluate(() => { window.__smoke.last = Date.now() })
      await wait(250)
      await settle()
    }

    // A page that hasn't arrived when the wait gives up fails, even if it turns up a moment later: it was never settled. One that arrived and then left fails too.
    if (!arrived) {
      problems.push(`navigation: ${route} was asked for, but it hadn't arrived after ${PAGE_TIMEOUT_MS / 1000} s (the page on screen is ${await page.evaluate(() => window.$app.$route.path)})`)
    } else if (!(await page.evaluate(pageLoading.arrived, route))) {
      problems.push(`navigation: ${route} arrived, then the page on screen became ${await page.evaluate(() => window.$app.$route.path)}`)
    }

    if (route === '/map' && process.env.SMOKE_MAP_EXPORT === '1') {
      // Each export has to leave the positions, zoom and marker sizes as it found them. The second runs at DPR 2 with sector borders. Their legend narrows the stage, which refits a map nobody has moved, so each snapshot is taken right around its own export.
      const exportOnce = () => page.evaluate(async () => {
        const map = window.__smoke.map
        const state = () => JSON.stringify([map.graphPositions(), map.graph.zoom(), map.markerMinimum])
        const before = state()
        const bounds = map.graph.elements().boundingBox()

        await map.exportPng()

        return { systems: map.graph.nodes().length, bounds, restored: before === state() }
      })

      await page.evaluate(() => {
        const findMap = (component) => (component.$options.name === 'MapPage' ? component : component.$children.map(findMap).find(Boolean))

        window.__smoke.map = findMap(window.$app)
      })

      const first = await exportOnce()
      let second

      try {
        await page.evaluate(() => {
          const map = window.__smoke.map

          window.__smoke.exportRestore = { borders: map.borders, dpi: Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') }
          Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
          map.borders = 'sectors'
        })
        await wait(250)
        await settle()
        second = await exportOnce()
      } finally {
        await page.evaluate(() => {
          const { borders, dpi } = window.__smoke.exportRestore

          window.__smoke.map.borders = borders
          if (dpi) {
            Object.defineProperty(window, 'devicePixelRatio', dpi)
          } else {
            delete window.devicePixelRatio
          }
        })
      }

      const exported = await app.evaluate(() => globalThis.__mapExports)

      exported.forEach((image) => fs.writeFileSync(image.filePath, Buffer.from(image.data, 'base64')))
      check('PNG exports decode', exported.length === 2 && exported.every((image) => !image.empty && image.bytes > 0), JSON.stringify(exported, (key, value) => key === 'data' ? undefined : value))
      check('PNG export bounded', exported.length === 2 && exported.every((image) => image.width <= 8192 && image.height <= 8192 && image.width * image.height <= 32 * 1024 * 1024), `${first.systems} systems; source bounds ${Math.round(first.bounds.w)} × ${Math.round(first.bounds.h)}`)
      check('PNG preserves layout', first.restored && second.restored, 'positions, zoom and marker sizes restored after each export')
    }

    const name = route === '/' ? 'empires' : route.slice(1)
    const screenshot = path.join(OUT, `${name}.png`)

    await page.screenshot({ path: screenshot })

    const stats = await page.evaluate(() => ({
      rows: document.querySelectorAll('.v-data-table tbody tr').length,
      text: document.querySelector('.v-main, .v-content') ? document.querySelector('.v-main, .v-content').innerText.length : 0,
    }))

    results.push({ route, ...stats, problems, screenshot })
  }

  problems = []

  await page.waitForFunction(() => Boolean(window.$app.$store.getters['history/campaign']), null, { timeout: 30000 }).catch(() => {})

  const { GameID, RaceID, settingsPath, revision, campaign } = await page.evaluate(() => {
    const { state, getters } = window.$app.$store

    return { GameID: state.GameID, RaceID: state.RaceID, settingsPath: state.config.path, revision: state.history.revision, campaign: getters['history/campaign'] }
  })

  check('storage path IPC', GameID !== null, GameID !== null ? `loaded ${save}` : 'no game loaded')
  check('settings in user data', path.dirname(settingsPath) === userData, settingsPath)

  const [found, missing, escaped, escapedBackslash, notAName] = await page.evaluate(() => Promise.all(['smoke-flag.png', 'missing-flag.png', '../secret.png', '..\\secret.png', null].map((name) => window.__aurora.electron.ipcRenderer.invoke('read-flag', name))))

  check('flag IPC', found === `data:image/png;base64,${FLAG_PNG.toString('base64')}` && missing === null && escaped === null && escapedBackslash === null && notAName === null, `found ${String(found).slice(0, 24)}..., missing ${missing}, dotdot ${escaped}, backslash ${escapedBackslash}, null ${notAName}`)

  const historyPath = campaign ? path.join(userData, 'history', `campaign-${campaign.campaignId}-${campaign.branchId}.json`) : path.join(userData, 'history', 'campaign-unsettled.json')
  const readHistory = () => (fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : null)
  const snapshotCount = (history) => (history && history.races && history.races[RaceID] ? history.races[RaceID].snapshots.length : 0)
  const before = readHistory()

  check('history file written', snapshotCount(before) > 0, before ? `${historyPath}: ${snapshotCount(before)} snapshots for race ${RaceID}` : `${historyPath} missing`)

  // Touch the unchanged save: the watcher reloads it and the recorder runs again. Copying over an open SQLite file truncates it first, so a concurrent reader can see an incomplete database even though the completed copy is identical.
  const databases = await page.evaluate(() => window.__smoke.databases)

  const reloadTime = new Date()

  fs.utimesSync(save, reloadTime, reloadTime)

  try {
    await page.waitForFunction((count) => window.__smoke.databases > count, databases, { timeout: 30000 })
    await settle()
    await page.waitForFunction((count) => window.$app.$store.state.history.revision > count, revision, { timeout: 30000 })

    const after = readHistory()

    check('save watcher reloads', true, `database reopened, history revision ${revision} -> ${await page.evaluate(() => window.$app.$store.state.history.revision)}`)
    check('same save, same history', snapshotCount(after) === snapshotCount(before), `${snapshotCount(before)} -> ${snapshotCount(after)} snapshots`)

    const reopened = await page.evaluate(() => window.$app.$store.getters['history/campaign'])

    check('same save, same campaign', Boolean(campaign) && Boolean(reopened) && reopened.campaignId === campaign.campaignId && reopened.branchId === campaign.branchId, `${campaign && campaign.campaignId} -> ${reopened && reopened.campaignId}`)
  } catch (error) {
    check('save watcher reloads', false, error.message.split('\n')[0])
  }

  await page.screenshot({ path: path.join(OUT, 'after-reload.png') })

  // Switching the window to another save (store/saves.js, src/main/saves.js): a copy of the save with its own Flags folder, reached by the store's own action, then back; the open dialog is answered from the main process.
  try {
    const other = path.join(work, 'other', 'AuroraDB.db')
    const otherFlag = Buffer.concat([FLAG_PNG, Buffer.from('other')])

    fs.mkdirSync(path.join(path.dirname(other), 'Flags'), { recursive: true })
    fs.copyFileSync(save, other)
    fs.writeFileSync(path.join(path.dirname(other), 'Flags', 'smoke-flag.png'), otherFlag)

    const select = (file) => page.evaluate((target) => window.$app.$store.dispatch('saves/select', target), file)
    const shown = (file) => page.waitForFunction((target) => {
      const { state } = window.$app.$store

      return state.savePath === target && state.databasePath === target && state.empires.loaded && state.empires.games.length > 0
    }, file, { timeout: 60000 })
    const flagOf = (name, database) => page.evaluate(([flag, owner]) => window.__aurora.electron.ipcRenderer.invoke('read-flag', flag, owner), [name, database])
    const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`

    // Closing the dialog changes nothing; the dialog is answered from the main process, which decides what it returns.
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })

    const opened = await page.evaluate(() => window.$app.$store.state.database !== null && window.__smoke.databases)
    const canceled = await page.evaluate(() => window.$app.$store.dispatch('saves/choose'))

    check('save switch: closing the dialog', canceled.action === 'canceled' && (await page.evaluate(() => window.__smoke.databases)) === opened && (await page.evaluate((target) => window.$app.$store.state.savePath === target, save)), JSON.stringify(canceled))

    const result = await select(other)

    check('save switch: A to B answers switched', result.action === 'switched' && result.path === other, JSON.stringify(result))

    const cleared = await page.evaluate(() => {
      const { state } = window.$app.$store

      return { GameID: state.GameID, games: state.empires.games.length, route: window.$app.$route.path }
    })

    check('save switch: nothing of the old save stays shown', cleared.GameID === null && cleared.games === 0 && cleared.route === '/', JSON.stringify(cleared))

    await shown(other)

    const [activePath, flagB, flagStale, flagActive] = await Promise.all([
      page.evaluate(() => window.__aurora.electron.ipcRenderer.invoke('request-storage-path')),
      flagOf('smoke-flag.png', other),
      flagOf('smoke-flag.png', save),
      flagOf('smoke-flag.png'),
    ])

    check('save switch: the main process names the new save', activePath === other, activePath)
    check('save switch: flags are those of the new save', flagB === dataUrl(otherFlag) && flagActive === dataUrl(otherFlag) && flagStale === null, `B ${String(flagB).slice(0, 24)}, stale ${flagStale}`)

    const missing = await select(path.join(work, 'no-such-folder', 'AuroraDB.db'))
    const listed = await page.evaluate(() => window.$app.$store.state.saves.notice)

    check('save switch: a missing save is reported and nothing changes', missing.action === 'unavailable' && Boolean(listed && listed.retry) && (await page.evaluate((target) => window.$app.$store.state.savePath === target, other)), JSON.stringify(listed))

    // Touching the save left changes nothing, touching the save shown opens it again; one watcher is live.
    const before = await page.evaluate(() => window.__smoke.databases)
    const stamp = new Date(Date.now() + 5000)

    fs.utimesSync(save, stamp, stamp)
    await wait(5000)
    check('save switch: the save left is no longer watched', (await page.evaluate(() => window.__smoke.databases)) === before, `databases ${before}`)

    fs.utimesSync(other, stamp, stamp)
    await page.waitForFunction((count) => window.__smoke.databases > count, before, { timeout: 30000 }).then(() => check('save switch: the save shown is watched', true, 'database reopened'), (error) => check('save switch: the save shown is watched', false, error.message.split('\n')[0]))

    // Back through the dialog.
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }) }, save)

    const back = await page.evaluate(() => window.$app.$store.dispatch('saves/choose'))

    await shown(save)

    const [flagA, flagGone] = await Promise.all([flagOf('smoke-flag.png', save), flagOf('smoke-flag.png', other)])

    check('save switch: back to A through the dialog', back.action === 'switched' && flagA === dataUrl(FLAG_PNG) && flagGone === null, `${back.action}, A ${String(flagA).slice(0, 24)}`)

    // Back on A, the watcher of B no longer acts and the one of A does: one watcher at a time (scripts/check-save-switching.js counts the watchers themselves, which the preload's frozen chokidar module does not let this run wrap).
    await settle()

    const shownBack = await page.evaluate(() => window.__smoke.databases)
    const later = new Date(Date.now() + 10000)

    fs.utimesSync(other, later, later)
    await wait(5000)

    const leftAlone = (await page.evaluate(() => window.__smoke.databases)) === shownBack

    fs.utimesSync(save, later, later)

    const reopened = await page.waitForFunction((count) => window.__smoke.databases > count, shownBack, { timeout: 30000 }).then(() => true, () => false)

    check('save switch: back on A, only A is watched', leftAlone && reopened, `B left alone ${leftAlone}, A reopened ${reopened}`)
    await settle()
  } catch (error) {
    check('save switch', false, error.message.split('\n')[0])
  }

  const reloadProblems = problems

  await stopTree(app)

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

run().then(() => process.exit(process.exitCode), async (error) => {
  console.error(error)

  if (launched) {
    await stopTree(launched).catch(() => {})
  }

  process.exit(1)
})
