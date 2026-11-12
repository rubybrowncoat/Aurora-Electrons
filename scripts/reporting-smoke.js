/*
  node scripts/run-vite.js scripts/reporting-smoke.js
  Real production-mode main/preload/renderer bundle and SDK, with exactly one source delta: the DSN literal targets a loopback collector.
  No application test switch or second transport. All databases, preferences, legacy queues, dumps and screenshots are synthetic and retained.
  REPORTING_OUT optionally selects a new, nonexistent directory below out/reporting-smoke. Never supply a real userData directory.
*/
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const assert = require('./lib/bounded-assert')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(ROOT, 'src/main/sentry.js')
const PRODUCTION_DSN = 'https://8e243eff808fce8ae2da2b27f6eb4ff5@o237971.ingest.us.sentry.io/4510024176893952'
const OUTPUT = path.resolve(process.env.REPORTING_OUT || path.join(ROOT, 'out', 'reporting-smoke', new Date().toISOString().replace(/[:.]/g, '-')))
const OUTPUT_ROOT = path.join(ROOT, 'out', 'reporting-smoke')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }
const until = async (predicate, label, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await wait(100)
  }
  throw new Error(`Timed out: ${label}`)
}
const files = (root) => {
  if (!fs.existsSync(root)) return []
  const result = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    assert.ok(!entry.isSymbolicLink(), `unexpected linked evidence path: ${file}`)
    if (entry.isDirectory()) result.push(...files(file))
    else result.push(file)
  }
  return result
}
const inventory = (root) => Object.fromEntries(files(root).map((file) => [path.relative(root, file).split(path.sep).join('/'), { size: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }]))

// Envelope JSON is newline delimited; binary attachments supply a byte length, so do not split their contents on newlines.
const parseEnvelope = (body) => {
  let cursor = body.indexOf(10) + 1
  assert.ok(cursor > 0, 'missing envelope header')
  const items = []
  while (cursor < body.length) {
    if (body[cursor] === 10) { cursor++; continue }
    const lineEnd = body.indexOf(10, cursor)
    assert.ok(lineEnd >= 0, 'missing item header terminator')
    const header = JSON.parse(body.subarray(cursor, lineEnd).toString('utf8'))
    cursor = lineEnd + 1
    const end = Number.isInteger(header.length) ? cursor + header.length : (!body.includes(10, cursor) ? body.length : body.indexOf(10, cursor))
    assert.ok(end <= body.length, 'truncated envelope item')
    const bytes = body.subarray(cursor, end)
    items.push({ header, bytes: bytes.length, sha256: sha256(bytes), ...(header.type === 'event' ? { event: JSON.parse(bytes.toString('utf8')) } : {}) })
    cursor = end
  }
  return items
}

const makeCollector = async () => {
  const records = []
  const sockets = new Set()
  const responses = new Set()
  let server = null
  let port = null
  let closing = null
  const start = async () => {
    server = http.createServer((request, response) => {
      const record = { number: records.length + 1, url: request.url, started: new Date().toISOString(), bytes: 0, ended: false, responseClosed: false, held: false }
      records.push(record)
      responses.add(response)
      const chunks = []
      request.on('data', (chunk) => { record.bytes += chunk.length; chunks.push(chunk) })
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks)
          record.sha256 = sha256(body)
          record.items = parseEnvelope(body)
          record.ended = true
          record.held = record.items.some((item) => item.event && JSON.stringify(item.event).includes('CONTROL_HELD'))
          if (!record.held) {
            response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
            response.end('{}')
          }
        } catch (error) {
          record.error = error.message
          response.writeHead(400, { Connection: 'close' })
          response.end()
        }
      })
      response.on('close', () => {
        record.responseClosed = true
        record.responseFinished = response.writableFinished
        responses.delete(response)
      })
    })
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port || 0, '127.0.0.1', resolve) })
    port = server.address().port
  }
  await start()
  return {
    records,
    port,
    offline: () => {
      closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeIdleConnections()
    },
    reconnect: async () => { await closing; await start() },
    close: async () => {
      for (const response of responses) response.destroy()
      for (const socket of sockets) socket.destroy()
      if (server && server.listening) await new Promise((resolve) => server.close(resolve))
      if (closing) await closing
    },
  }
}

const main = async () => {
  assert.ok(inside(OUTPUT_ROOT, OUTPUT) && OUTPUT !== OUTPUT_ROOT, 'REPORTING_OUT must be below out/reporting-smoke so runtime dependencies resolve inside this checkout')
  assert.ok(!fs.existsSync(OUTPUT), 'REPORTING_OUT must be a new directory, not existing user data or a previous run')
  fs.mkdirSync(OUTPUT, { recursive: true })
  const report = { started: new Date().toISOString(), command: 'node scripts/run-vite.js scripts/reporting-smoke.js', mode: 'production', root: ROOT, output: OUTPUT, node: process.version, platform: process.platform, phases: [], limitations: ['Requests that already transmitted bytes cannot be recalled. Native minidump memory is not field-redacted. This run uses synthetic user data and a local collector only.'] }
  let collector
  let app
  let dumpObserver
  try {
    report.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const inputs = ['src/main/sentry.js', 'src/main/index.js', 'src/preload/index.js', 'src/renderer/main.js', 'src/renderer/layouts/default.vue', 'src/renderer/pages/settings.vue', 'src/renderer/utilities/reporting.js', 'src/renderer/components/ReportingChoice.vue', 'scripts/web/shims/electron.js', 'scripts/reporting-smoke.js', 'electron.vite.config.mjs', 'package.json', 'bun.lock']
    report.inputs = Object.fromEntries(inputs.map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]))
    report.sdk = Object.fromEntries(['@sentry/electron', '@sentry/vue', 'electron-vite'].map((name) => {
      const file = path.join(ROOT, 'node_modules', name, 'package.json')
      const bytes = fs.readFileSync(file)
      return [name, { version: JSON.parse(bytes).version, packageSHA256: sha256(bytes) }]
    }))
    collector = await makeCollector()
    const dsn = `http://reportingcontrol@127.0.0.1:${collector.port}/1`
    const original = fs.readFileSync(SOURCE, 'utf8')
    assert.equal(original.split(PRODUCTION_DSN).length - 1, 1, 'production DSN must have exactly one literal definition')
    const transformed = original.replace(PRODUCTION_DSN, dsn)
    let replacements = 0
    const builds = path.join(OUTPUT, 'bundle')
    const { build } = await import('electron-vite')
    await build({
      mode: 'production',
      logLevel: 'warn',
      build: { outDir: builds },
      plugins: [{
        name: 'reporting-local-dsn-only',
        enforce: 'pre',
        transform (code, id) {
          if (path.resolve(id.split('?')[0]) !== SOURCE) return null
          assert.equal(code, original, 'the sole transformed production input changed unexpectedly')
          replacements++
          return { code: transformed, map: null }
        },
      }],
    })
    assert.equal(replacements, 1, 'exactly one production input must have the DSN-only transform')
    report.dsnDelta = { file: 'src/main/sentry.js', replacements, from: PRODUCTION_DSN, to: dsn, originalSHA256: sha256(original), transformedSHA256: sha256(transformed), onlyChange: 'DSN literal; production options, integrations, consent, cleanup and transport unchanged' }
    const mainFile = path.join(builds, 'main/index.js')
    const mainBundle = fs.readFileSync(mainFile, 'utf8')
    assert.ok(!mainBundle.includes(PRODUCTION_DSN) && mainBundle.includes(dsn), 'refusing a bundle that could use production ingest')
    report.bundle = inventory(builds)
    const { _electron } = require('playwright')
    const executablePath = require('electron')
    const work = path.join(OUTPUT, 'synthetic')
    const userData = path.join(work, 'user-data')
    const database = path.join(work, 'synthetic.db')
    fs.mkdirSync(userData, { recursive: true })
    const crashDumps = path.join(userData, 'Crashpad')
    const sessionData = path.join(userData, 'session')
    const logs = path.join(userData, 'logs')
    for (const directory of [crashDumps, sessionData, logs]) fs.mkdirSync(directory, { recursive: true })
    const defaultReportDirectory = path.join(crashDumps, process.platform === 'win32' ? 'reports' : 'completed')
    const unknownDump = path.join(defaultReportDirectory, 'unknown-legacy.dmp')
    const bait = Buffer.alloc(12 * 1024, 0x5a)
    bait.write('MDMP')
    write(unknownDump, bait)
    report.unknownDefaultDump = { path: unknownDump, bytes: bait.length, sha256: sha256(bait) }
    const assertDefaultDump = () => {
      assert.equal(fs.statSync(unknownDump).size, report.unknownDefaultDump.bytes)
      assert.equal(sha256(fs.readFileSync(unknownDump)), report.unknownDefaultDump.sha256, 'the unknown default-folder dump was modified')
      assert.ok(fs.readdirSync(defaultReportDirectory).includes(path.basename(unknownDump)), 'the unknown dump moved')
      assert.ok(!collector.records.some((record) => (record.items || []).some((item) => item.header.attachment_type === 'event.minidump' && item.sha256 === report.unknownDefaultDump.sha256)), 'the unknown default-folder dump was uploaded')
    }
    const namespace = () => {
      const record = JSON.parse(fs.readFileSync(path.join(userData, 'reporting.json'), 'utf8')).nativeDumps
      assert.ok(record && /^[a-f0-9]{32}$/.test(record.id) && inside(userData, record.path) && !inside(crashDumps, record.path))
      assert.equal(fs.readFileSync(path.join(record.path, 'owner'), 'utf8'), record.id)
      return record
    }
    const bootstrap = path.join(work, 'bootstrap.cjs')
    const bootstrapSource = `const { app } = require('electron')\napp.setPath('userData', ${JSON.stringify(userData)})\napp.setPath('sessionData', ${JSON.stringify(sessionData)})\napp.setPath('crashDumps', ${JSON.stringify(crashDumps)})\napp.setPath('logs', ${JSON.stringify(logs)})\nrequire(${JSON.stringify(mainFile)})\n`
    write(bootstrap, bootstrapSource)
    report.bootstrap = { file: path.relative(OUTPUT, bootstrap), sha256: sha256(bootstrapSource), purpose: 'Environment isolation before importing the production bundle; only app paths are set, no product control or SDK hook is replaced.' }
    const env = { ...process.env, AURORA_DB: database }
    delete env.ELECTRON_RENDERER_URL
    delete env.ELECTRON_RUN_AS_NODE
    const launch = async () => {
      app = await _electron.launch({ executablePath, cwd: work, args: [bootstrap, `--user-data-dir=${userData}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'], env, timeout: 60000 })
      const page = await app.firstWindow({ timeout: 60000 })
      await page.waitForFunction(() => window.$app && window.__aurora && window.__aurora.reporting, null, { timeout: 60000 })
      const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), crashDumps: app.getPath('crashDumps'), electron: process.versions.electron }))
      assert.equal(path.resolve(paths.userData), path.resolve(userData), 'Electron did not use synthetic userData')
      const choice = await page.evaluate(() => window.__aurora.reporting.state())
      const record = namespace()
      assert.equal(path.resolve(paths.crashDumps), path.resolve(choice.initialized ? record.path : crashDumps), 'Electron used the wrong native namespace')
      assert.ok(inside(work, paths.crashDumps), `Crashpad is outside the synthetic tree: ${paths.crashDumps}`)
      assertDefaultDump()
      report.runtime = { ...paths, nativeDumps: record }
      return page
    }
    const stop = async () => { if (app) { const stopped = app; app = null; await stopped.close() } }
    const state = (page) => page.evaluate(() => window.__aurora.reporting.state())
    const screenshot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `${name}.png`), fullPage: true })
    const settings = async (page) => {
      await page.evaluate(() => window.$app.$router.push('/settings'))
      await page.locator('[data-reporting-settings]').waitFor()
    }
    const recordPhase = (name, detail) => { assertDefaultDump(); report.phases.push({ name, ok: true, ...detail }); console.log(`reporting production: ${name}`) }
    const events = () => collector.records.flatMap((record) => (record.items || []).filter((item) => item.event).map((item) => item.event))
    const has = (marker) => events().some((event) => JSON.stringify(event).includes(marker))
    const mainError = (marker) => app.evaluate((_electron, message) => { setTimeout(() => { Promise.reject(new Error(message)) }, 10) }, marker)
    const rendererError = (page, marker) => page.evaluate((message) => { setTimeout(() => { throw new Error(message) }, 10) }, marker)
    const noNewTraffic = async (count, label, ms = 1500) => { await wait(ms); assert.equal(collector.records.length, count, label) }
    const dumps = () => files(namespace().path).filter((file) => file.endsWith('.dmp'))
    const metadata = (file) => ({ path: file, filename: path.basename(file), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) })
    const observedDumps = new Map()
    const observeDumps = () => {
      const snapshots = []
      for (const file of dumps()) {
        try {
          const item = metadata(file)
          observedDumps.set(`${item.path}:${item.sha256}`, item)
          snapshots.push(item)
        } catch (error) {
          if (!['ENOENT', 'EBUSY', 'EACCES'].includes(error.code)) throw error
        }
      }
      return snapshots
    }
    const attachments = () => collector.records.flatMap((record) => (record.items || []).filter((item) => item.header.attachment_type === 'event.minidump'))
    const origin = (attachment) => [...observedDumps.values()].find((item) => item.sha256 === attachment.sha256 && item.bytes === attachment.bytes && item.filename === attachment.header.filename && inside(namespace().path, item.path))
    const noQueue = () => assert.ok(!fs.existsSync(path.join(userData, 'sentry/queue/queue-v2.json')), 'a disk-backed diagnostic queue was created')
    // Playwright 1.63 disconnects a page on Inspector.targetCrashed and never reopens it; page.reload then rejects with "Page crashed" while waiting for navigation. Electron's webContents.reload() starts a new renderer in that same WebContents, which does not revive the Playwright Page. Capture the live production shell, open a new window with that preload and URL, then destroy the crashed window. Creating first keeps window-all-closed from quitting when the crashed window is the last one.
    const rememberProductionWindow = (id) => app.evaluate(({ webContents }, { id, preload }) => {
      const donor = webContents.fromId(id)
      if (!donor || donor.isDestroyed()) throw new Error('production window donor is gone')
      global.__auroraReportingSmokeWindow = { url: donor.getURL(), preferences: donor.getLastWebPreferences(), preload }
    }, { id, preload: path.join(builds, 'preload/index.js') })
    const rendererCrashed = (id) => app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      return Boolean(contents && !contents.isDestroyed() && contents.isCrashed())
    }, id)
    const replaceCrashedWindow = async (crashedId) => {
      const addedWindow = app.waitForEvent('window')
      const id = await app.evaluate(({ BrowserWindow, webContents }, crashedId) => {
        const shell = global.__auroraReportingSmokeWindow
        if (!shell || !shell.url || !shell.preferences || !shell.preload) throw new Error('production window shell was not captured')
        const created = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { ...shell.preferences, preload: shell.preload } })
        created.loadURL(shell.url)
        if (!BrowserWindow.getAllWindows().includes(created)) throw new Error('replacement window was not registered before closing the crashed window')
        const crashedContents = webContents.fromId(crashedId)
        const crashed = crashedContents && BrowserWindow.fromWebContents(crashedContents)
        if (crashed && !crashed.isDestroyed()) crashed.destroy()
        return created.webContents.id
      }, crashedId)
      const page = await addedWindow
      const handle = await app.browserWindow(page)
      const bound = await handle.evaluate((window) => window.webContents.id)
      await handle.dispose()
      assert.equal(bound, id, 'recovered Playwright page is not the new production window')
      assert.notEqual(id, crashedId, 'recovered window reused the crashed webContents')
      return { page, id }
    }

    let page = await launch()
    await page.locator('[data-reporting-prompt]').waitFor()
    assert.deepEqual({ enabled: (await state(page)).enabled, initialized: (await state(page)).initialized }, { enabled: false, initialized: false })
    assert.equal(await page.evaluate(() => Boolean(window.__SENTRY__RENDERER_INIT__ || window.__SENTRY_IPC__)), false)
    await noNewTraffic(0, 'traffic before first-launch choice')
    await screenshot(page, '01-prompt')
    report.promptScreenshot = path.join(OUTPUT, '01-prompt.png')
    await page.locator('[data-reporting-decline]').click()
    await page.locator('[data-reporting-prompt]').waitFor({ state: 'hidden' })
    assert.equal((await state(page)).savedChoice, false)
    await settings(page)
    const query = await page.evaluate(async (storage) => {
      const { Sequelize } = window.__aurora.sequelize
      const database = new Sequelize({ dialect: 'sqlite', storage, logging: false })
      try { return (await database.query('SELECT 6 * 7 AS answer'))[0][0].answer } finally { await database.close() }
    }, database)
    assert.equal(query, 42, 'decline broke native SQLite usability')
    await screenshot(page, '02-declined-settings')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'reporting.json'), 'utf8')), { enabled: false, nativeDumps: namespace() })
    await noNewTraffic(0, 'decline or Settings sent diagnostic traffic')
    await stop()
    page = await launch()
    await settings(page)
    assert.equal((await state(page)).savedChoice, false)
    assert.equal((await state(page)).initialized, false)
    assert.equal(await page.locator('[data-reporting-prompt]').count(), 0)
    await noNewTraffic(0, 'declined restart sent diagnostics')
    recordPhase('fresh prompt, decline, native SQLite usability and durable off restart', { query, promptScreenshot: report.promptScreenshot })
    await stop()

    // Simulate the 3.2.2 default-on upgrade: config exists, but no new named consent file yet.
    fs.unlinkSync(path.join(userData, 'reporting.json'))
    write(path.join(userData, 'config.json'), JSON.stringify({ darkMode: true, spyNPR: false, selectedSeparator: 'Tick', 'upgrade-sentinel': '3.2.2' }))
    const queue = path.join(userData, 'sentry/queue')
    const id = 'a'.repeat(32)
    const oldFiles = [path.join(queue, 'queue-v2.json'), path.join(queue, id), path.join(userData, 'sentry/scope_v3.json')]
    write(oldFiles[0], JSON.stringify([{ id, date: new Date().toISOString() }]))
    write(oldFiles[1], 'LEGACY_ENVELOPE_CANARY')
    write(oldFiles[2], JSON.stringify({ scope: { extra: { secret: 'LEGACY_SCOPE_CANARY' } } }))
    const sentinels = ['saves/user.db', 'history/user.json', 'notebooks/user.txt', 'sentry/user.txt', 'sentry/queue/unlisted-user.txt', `sentry/queue/${'b'.repeat(32)}`, 'Crashpad/reports/user.txt']
    const sentinelHashes = {}
    for (const name of sentinels) {
      const file = path.join(userData, name)
      write(file, `synthetic user sentinel ${name}`)
      sentinelHashes[name] = sha256(fs.readFileSync(file))
    }
    const assertSentinels = () => { for (const [name, hash] of Object.entries(sentinelHashes)) assert.equal(sha256(fs.readFileSync(path.join(userData, name))), hash, `user data changed: ${name}`) }
    report.userSentinels = sentinelHashes
    page = await launch()
    await page.locator('[data-reporting-prompt]').waitFor()
    assert.equal((await state(page)).enabled, false)
    assert.ok(oldFiles.every((file) => !fs.existsSync(file)), 'an identified upgrade diagnostic artifact survived')
    assertSentinels()
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'))['upgrade-sentinel'], '3.2.2')
    await noNewTraffic(0, 'upgrade backlog uploaded before choice')
    await screenshot(page, '03-upgrade-prompt')
    recordPhase('upgrade legacy queue and scope purge; default dumps abandoned with user data unchanged', { removed: oldFiles.map((file) => path.relative(work, file)), unknownDefaultDump: report.unknownDefaultDump })

    await page.locator('[data-reporting-prompt] [data-reporting-enable]').click()
    await page.locator('[data-reporting-prompt]').waitFor({ state: 'hidden' })
    assert.equal((await state(page)).enabled, true)
    await page.waitForFunction(() => Boolean(window.__SENTRY__RENDERER_INIT__))
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('crashDumps'))), path.resolve(namespace().path))
    await mainError('CONTROL_MAIN C:\\Users\\PATH_CANARY\\AuroraDB.db SELECT secret FROM SQL_CANARY')
    await rendererError(page, 'CONTROL_RENDERER /home/PATH_CANARY/AuroraDB.db SELECT secret FROM SQL_CANARY')
    await until(() => has('CONTROL_MAIN') && has('CONTROL_RENDERER'), 'real main and renderer production SDK controls')
    const controls = events().filter((event) => /CONTROL_MAIN|CONTROL_RENDERER/.test(JSON.stringify(event)))
    for (const event of controls) {
      assert.ok(!JSON.stringify(event).includes('CANARY'), 'sensitive path or SQL survived event minimization')
      assert.ok(!event.breadcrumbs && !event.user && !event.request && !event.extra)
      assert.ok(!event.contexts || !event.contexts.device)
    }
    write(path.join(OUTPUT, 'redacted-example.json'), `${JSON.stringify(controls, null, 2)}\n`)
    await settings(page)
    await screenshot(page, '04-enabled-settings')
    noQueue()
    recordPhase('explicit acceptance and real main/renderer error controls; minimized event example', { controls: controls.map((event) => event.event_id) })

    const recoveryNamespace = namespace()
    const defaultBeforeRecovery = inventory(crashDumps)
    const crashedProcess = app.process()
    const mainExited = app.waitForEvent('close', { timeout: 60000 })
    await app.evaluate(() => { setTimeout(() => process.crash(), 25) })
    await mainExited
    app = null
    assert.notEqual(crashedProcess.exitCode, 0, 'main-process native crash exited successfully')
    await until(() => dumps().some((file) => fs.statSync(file).size > 0), 'genuine previous-main-process crash dump', 60000)
    await wait(1500)
    observeDumps()
    const mainDumps = dumps().map(metadata)
    assert.ok(mainDumps.length > 0 && mainDumps.every((item) => item.bytes > 0))
    assertDefaultDump()
    page = await launch()
    assert.deepEqual(namespace(), recoveryNamespace, 'saved-on restart abandoned the recorded native namespace')
    assert.equal((await state(page)).enabled, true)
    await until(() => mainDumps.every((dump) => attachments().some((item) => item.sha256 === dump.sha256 && item.bytes === dump.bytes && item.header.filename === dump.filename)), 'opted-in next-launch main-process crash recovery', 60000)
    for (const dump of mainDumps) assert.equal(attachments().filter((item) => item.sha256 === dump.sha256).length, 1)
    await until(() => dumps().length === 0, 'SDK recovery removes the sent main-process dump')
    await stop()
    const recoveryCount = collector.records.length
    page = await launch()
    assert.deepEqual(namespace(), recoveryNamespace)
    await noNewTraffic(recoveryCount, 'a further opted-in launch duplicated the main-process crash', 3500)
    for (const dump of mainDumps) assert.equal(attachments().filter((item) => item.sha256 === dump.sha256).length, 1)
    assert.deepEqual(inventory(crashDumps), defaultBeforeRecovery, 'main-crash recovery changed the default report directory')
    report.mainCrashRecovery = { namespace: recoveryNamespace, exitCode: crashedProcess.exitCode, signalCode: crashedProcess.signalCode, dumps: mainDumps, duplicateRequests: collector.records.length - recoveryCount }

    const firstId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id)
    await rememberProductionWindow(firstId)
    // Effective Electron preferences omit preload; use the same built preload and renderer as the app.
    const addedWindow = app.waitForEvent('window')
    let secondId = await app.evaluate(({ BrowserWindow }, preload) => {
      const first = BrowserWindow.getAllWindows()[0]
      const second = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { ...first.webContents.getLastWebPreferences(), preload } })
      second.loadURL(first.webContents.getURL())
      return second.webContents.id
    }, path.join(builds, 'preload/index.js'))
    let second = await addedWindow
    await second.waitForFunction(() => window.$app && window.__aurora && window.__SENTRY__RENDERER_INIT__)
    assert.equal((await state(second)).enabled, true)
    await second.evaluate(() => { window.__reportingObserved = []; window.__aurora.reporting.subscribe((value) => window.__reportingObserved.push(value)) })
    const crashId = await second.evaluate(() => window.__aurora.electron.ipcRenderer.sendSync('aurora-store', { op: 'path', args: [] }).ok)
    assert.equal(crashId, true, 'ordinary preference IPC is still usable')
    let firstRendererCrashed = false
    page.once('crash', () => { firstRendererCrashed = true })
    const rendererStart = collector.records.length
    const defaultBeforeRenderer = inventory(crashDumps)
    dumpObserver = setInterval(observeDumps, 50)
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), secondId)
    await until(() => collector.records.slice(rendererStart).some((record) => (record.items || []).some((item) => item.header.type === 'attachment' && item.header.attachment_type === 'event.minidump' && item.bytes > 0)), 'native renderer crash minidump positive control', 60000)
    const native = collector.records.slice(rendererStart).find((record) => (record.items || []).some((item) => item.header.attachment_type === 'event.minidump'))
    assert.ok(native.items.some((item) => item.event && item.event.platform === 'native'))
    const rendererDump = native.items.find((item) => item.header.attachment_type === 'event.minidump')
    const rendererOrigin = origin(rendererDump)
    assert.ok(rendererOrigin, 'renderer attachment was not observed in the recorded namespace')
    clearInterval(dumpObserver)
    assert.deepEqual(inventory(crashDumps), defaultBeforeRenderer, 'renderer crash recovery changed the default report directory')
    for (const record of collector.records) {
      for (const item of record.items || []) {
        assert.ok(item.header.type === 'event' || (item.header.type === 'attachment' && item.header.attachment_type === 'event.minidump'), 'unexpected session, analytics, profile, replay or user attachment')
        if (item.header.type === 'attachment') assert.ok(/\.dmp$/i.test(item.header.filename || ''), 'a non-minidump attachment was sent')
      }
    }
    const recoveredSecond = await replaceCrashedWindow(secondId)
    second = recoveredSecond.page
    secondId = recoveredSecond.id
    if (firstRendererCrashed || await rendererCrashed(firstId)) {
      const recoveredFirst = await replaceCrashedWindow(firstId)
      page = recoveredFirst.page
      await page.waitForFunction(() => window.$app && window.__aurora && window.__aurora.reporting)
    }
    await second.waitForFunction(() => window.$app && window.__aurora && window.__SENTRY__RENDERER_INIT__)
    await second.evaluate(() => { window.__reportingObserved = []; window.__aurora.reporting.subscribe((value) => window.__reportingObserved.push(value)) })
    recordPhase('two windows and real forcefullyCrashRenderer native minidump from recorded namespace', { nativeRequest: native.number, minidump: rendererDump, origin: rendererOrigin, mainCrashRecovery: report.mainCrashRecovery })

    await mainError('CONTROL_HELD')
    await until(() => collector.records.some((record) => record.held && record.ended), 'held in-flight diagnostic request')
    const held = collector.records.find((record) => record.held)
    collector.offline()
    await mainError('CONTROL_OFFLINE_NEVER_REPLAY')
    await rendererError(second, 'CONTROL_OFFLINE_RENDERER_NEVER_REPLAY')
    await wait(1500)
    noQueue()
    await settings(page)
    await page.locator('[data-reporting-disable]').click()
    assert.equal((await state(page)).enabled, false)
    await until(async () => (await state(second)).restartRequired, 'shared revoked state in other window')
    await until(() => held.responseClosed, 'best-effort in-flight request abort')
    assert.equal(held.responseFinished, false, 'held response completed instead of being aborted')
    assert.ok(held.bytes > 0, 'in-flight distinction must exercise already transmitted bytes')
    const stale = await second.evaluate(() => window.__aurora.reporting.choose(true))
    assert.equal(stale.enabled, false)
    assert.equal(stale.savedChoice, false)
    assert.equal(stale.restartRequired, true)
    assert.match(stale.error, /Restart|restart/)
    assert.ok(await second.evaluate(() => window.__reportingObserved.some((value) => !value.enabled && value.restartRequired)))
    await screenshot(page, '05-disabled-restart-required')
    await collector.reconnect()
    const revokedCount = collector.records.length
    await mainError('CONTROL_REVOKED_MAIN_NEVER_SEND')
    await rendererError(second, 'CONTROL_REVOKED_RENDERER_NEVER_SEND')
    await noNewTraffic(revokedCount, 'a new request started after disable or old offline data replayed on reconnect')
    assert.ok(!has('CONTROL_OFFLINE_NEVER_REPLAY') && !has('CONTROL_OFFLINE_RENDERER_NEVER_REPLAY'))
    assertSentinels()
    noQueue()
    const disabledCrashNamespace = namespace()
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), secondId)
    await until(() => rendererCrashed(secondId), 'genuine renderer crash after disable')
    const disabledResiduals = observeDumps()
    await noNewTraffic(revokedCount, 'renderer crash after disable uploaded')
    recordPhase('held request aborted; offline disable/reconnect; stale-window enable refused; renderer crash while disabled', { heldRequest: held.number, transmittedBytesNotRecallable: held.bytes, savedChoice: stale.savedChoice, disabledCrashNamespace, disabledResiduals })
    await stop()

    page = await launch()
    await settings(page)
    const restarted = await state(page)
    assert.equal(restarted.enabled, false)
    assert.equal(restarted.initialized, false)
    assert.equal(restarted.savedChoice, false)
    assert.equal(restarted.restartRequired, false)
    assert.equal(await page.evaluate(() => Boolean(window.__SENTRY__RENDERER_INIT__ || window.__SENTRY_IPC__)), false)
    assert.deepEqual(namespace(), disabledCrashNamespace)
    assert.ok(disabledResiduals.every((item) => !fs.existsSync(item.path)), 'off restart retained disabled-crash residuals')
    assert.equal(dumps().length, 0)
    await noNewTraffic(revokedCount, 'disabled restart uploaded old diagnostics')
    await screenshot(page, '06-restarted-off-settings')
    const offId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id)
    await rememberProductionWindow(offId)
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), offId)
    await wait(3500)
    assert.equal(dumps().length, 0, 'disabled restart started native dump collection')
    await noNewTraffic(revokedCount, 'disabled native crash uploaded')
    page = (await replaceCrashedWindow(offId)).page
    await page.waitForFunction(() => window.$app && window.__aurora)
    await settings(page)
    recordPhase('off restart leaves owned namespace empty, initializes no SDK, and native crash off control produces no dump/upload', { state: restarted, purgedResiduals: disabledResiduals })

    await page.locator('[data-reporting-settings] [data-reporting-enable]').click()
    assert.equal((await state(page)).enabled, true)
    await page.waitForFunction(() => Boolean(window.__SENTRY__RENDERER_INIT__))
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('crashDumps'))), path.resolve(namespace().path))
    await mainError('CONTROL_NEW_ONLY_MAIN')
    await rendererError(page, 'CONTROL_NEW_ONLY_RENDERER')
    await until(() => has('CONTROL_NEW_ONLY_MAIN') && has('CONTROL_NEW_ONLY_RENDERER'), 'restart then explicit enable sends new controls')
    await wait(1500)
    const afterRestart = collector.records.slice(revokedCount)
    assert.ok(afterRestart.flatMap((record) => record.items || []).filter((item) => item.event).every((item) => !/OFFLINE_|REVOKED_|LEGACY_/.test(JSON.stringify(item.event))), 'pre-revocation diagnostics replayed after re-enable')
    assert.ok(afterRestart.flatMap((record) => record.items || []).every((item) => item.header.attachment_type !== 'event.minidump'), 'a disabled-era crash replayed after re-enable')
    assertSentinels()
    noQueue()
    await screenshot(page, '07-reenabled-settings')
    recordPhase('restart then explicit enable sends only newly captured controls; user sentinels unchanged', { requestsAfterRestart: afterRestart.map((record) => record.number) })
    report.dumpOrigins = [...observedDumps.values()]
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.failure = String(error.stack || error)
    throw error
  } finally {
    clearInterval(dumpObserver)
    if (app) await app.close().catch((error) => { report.shutdownError = String(error) })
    if (collector) {
      await collector.close()
      report.collector = collector.records
    }
    report.finished = new Date().toISOString()
    report.evidence = inventory(OUTPUT)
    write(path.join(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`reporting evidence: ${path.join(OUTPUT, 'report.json')}`)
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
