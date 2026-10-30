/*
  Checks scripts/lib/page-server.js, the Vite server over a copy of a save that a check starts to drive the real renderer in a browser.

  Run: bun scripts/check-page-server.js [--no-mutations]

  Each scenario starts the helper in a process of its own (scripts/lib/check-pool.js, runChild) and looks at what it served and what it left behind:
  - from the project root, and from a root whose path holds spaces and a '#' (a copy of the layout in a folder named "ae path #…", as a checkout under "Aurora C#" is: its module paths used to reach Vite and the dynamic import of the renderer config as a URL with a fragment), the index, a page and a utility module are served with a body each;
  - while Vite's default port (5173) is held, as it is when the server of another checkout runs, the pages come from a port of the helper's own (a browser's `localhost` may reach the other server, and a page of another save was drawn instead);
  - the pages are opened at the one address the server listens on, an IP address: `localhost` names both loopback families, the server listens on one of them, and a browser under load opens some of its connections over the other (the app's main module was refused there, and the app never started);
  - `stop` removes the folder of the run (the copy of the save and Vite's cache) before it resolves, and a process that ends without calling it leaves nothing either;
  - Vite's cache is inside the folder of the run and under no node_modules folder, which every checkout and worktree shares;
  - the next server removes the folder of a process that is gone and keeps that of one that is running;
  - a warm server serves one variant after another without letting one reach the next: a file replaced is served as given and, once restored, as it is on disk with nothing of its replacement; `reset` restores a file a variant left replaced and names it, and copies the save the server started with back over a save `useSave` switched to and over a copy a page wrote to.
  Each planted fault rewrites one line of a copy of scripts/lib/page-server.js, run from a copy of the project's layout (the sources and node_modules are junctions to the real ones, and nothing is written there), and must make a named check fail.

  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { runChild, lastJson } = require('./lib/check-pool')
const { patched } = require('./lib/mutant-source')
const { safeRoot } = require('./lib/safe-root')

const ROOT = path.resolve(__dirname, '..')
// A save of the 2.7 line (its FCT_Game carries both 2.7 columns) whose file name is that of an earlier version.
const SAVE = 'saves/AuroraDB_26OafsalotError.db'
// Another save, for `useSave`; the module a variant replaces, by its path and its route.
const OTHER_SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const MODULE = { file: 'src/renderer/utilities/specialist-deployments.js', route: '/utilities/specialist-deployments.js' }
const MARKER = 'plantedByTheCheck'
const RESULT = 'RESULT '
const PREFIX = 'ae-page-server-'
const GONE_PID = 2147483646
const PAGES = { '/': 100, '/pages/survey-progress.vue': 1000, '/utilities/specialist-deployments.js': 1000 }
const DEFAULT_PORT = 5173

const emit = (observed) => fs.writeSync(1, `${RESULT}${JSON.stringify(observed)}\n`)

// --serve <root> <mode>: starts the helper for the project at <root> and prints what it served; `stop` stops it, `exit` ends the process without stopping it.
const serve = async (root, mode) => {
  const { startPageServer } = require('./lib/page-server')
  const server = await startPageServer({ save: SAVE, root })
  const observed = { url: server.url, folder: server.folder, cacheDir: server.cacheDir, savedCopy: fs.existsSync(path.join(server.folder, 'AuroraDB.db')) }

  if (mode === 'exit') {
    emit(observed)
    process.exit(3)
  }

  if (mode === 'reset') {
    const fetched = async () => (await fetch(`${server.url}${MODULE.route}`, { headers: { connection: 'close' } })).text()
    const pristine = await fetched()
    const marked = `${fs.readFileSync(path.join(root, MODULE.file), 'utf8')}\nexport const ${MARKER} = 1\n`
    const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const copy = path.join(server.folder, 'AuroraDB.db')
    const started = hashOf(copy)
    const clean = (text) => !text.includes(MARKER) && text === pristine

    server.replace(MODULE.file, marked)
    observed.replacedServed = (await fetched()).includes(MARKER)
    observed.restoreError = null

    try {
      server.replace(MODULE.file, null)
    } catch (error) {
      observed.restoreError = String(error.message).split('\n')[0]
    }

    observed.restoredClean = clean(await fetched())
    // A variant that leaves its file replaced: the reset after it names the file and serves it as it is again.
    server.replace(MODULE.file, marked)
    await fetched()
    observed.leftNamed = await server.reset().then(() => null, (error) => String(error.message).split('\n')[0])
    observed.resetClean = clean(await fetched())
    // A save switched by `useSave`, and a copy written to: the reset copies the save the server started with back.
    await server.useSave(OTHER_SAVE)
    observed.switched = hashOf(copy) !== started
    await server.reset()
    observed.switchUndone = hashOf(copy) === started
    fs.appendFileSync(copy, 'written')
    await server.reset()
    observed.writeUndone = hashOf(copy) === started
    await server.stop()
    emit(observed)

    return
  }

  observed.pages = {}

  for (const route of Object.keys(PAGES)) {
    const response = await fetch(`${server.url}${route}`, { headers: { connection: 'close' } })

    observed.pages[route] = { status: response.status, length: (await response.text()).length }
  }

  // Vite optimizes the dependencies the pages import in the background and its close waits for that to finish, which takes minutes on a cold cache; a browser run is in the pages that long, so the helper is stopped here only once the cache holds them.
  const metadata = path.join(server.cacheDir, 'deps', '_metadata.json')
  const deadline = Date.now() + 240000

  while (!fs.existsSync(metadata) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  observed.cacheWritten = fs.existsSync(metadata)

  await server.stop()
  observed.goneAfterStop = !fs.existsSync(server.folder)
  emit(observed)
}

// A copy of the project's layout: the scripts the helper needs (the page server as given, a planted fault in it or not) and junctions to the sources, node_modules and saves of the real project. With `hash` it stands in a folder whose path holds spaces and a '#', as a checkout under "Aurora C#" does.
const layoutOf = (pageServer, hash = false) => {
  const parent = hash ? fs.mkdtempSync(path.join(os.tmpdir(), 'ae path #')) : os.tmpdir()
  const layout = hash ? path.join(parent, 'aurora electrons') : fs.mkdtempSync(path.join(parent, 'ae-page-server-layout-'))
  const scripts = path.join(layout, 'scripts')

  fs.mkdirSync(scripts, { recursive: true })
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(scripts, 'lib'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'scripts', 'web'), path.join(scripts, 'web'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts', 'renderer-config.mjs'), path.join(scripts, 'renderer-config.mjs'))
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check-page-server.js'), path.join(scripts, 'check-page-server.js'))
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(layout, 'package.json'))
  fs.writeFileSync(path.join(scripts, 'lib', 'page-server.js'), pageServer)

  for (const name of ['src', 'node_modules', 'saves']) {
    fs.symlinkSync(fs.realpathSync(path.join(ROOT, name)), path.join(layout, name), 'junction')
  }

  return layout
}

// Junctions are unlinked first, so that removing the folder never reaches what they point to; so is the hash-free junction the helper makes for a root with a '#'.
const removeLayout = (layout) => {
  if (layout.includes('#')) {
    fs.unlinkSync(safeRoot(layout))
  }

  for (const name of ['src', 'node_modules', 'saves']) {
    fs.unlinkSync(path.join(layout, name))
  }

  fs.rmSync(layout, { recursive: true, force: true })

  if (layout.includes('#')) {
    fs.rmdirSync(path.dirname(layout))
  }
}

// `work` with a layout of the page server `source`, which is removed afterwards.
const inLayout = async (source, hash, work) => {
  const layout = layoutOf(source, hash)

  try {
    return await work(layout)
  } finally {
    removeLayout(layout)
  }
}

const attempt = async (work) => {
  try {
    return await work()
  } catch (error) {
    return { error: String(error.message).split('\n')[0] }
  }
}

const run = async (layout, root, mode) => {
  const result = await runChild(path.join(layout, 'scripts', 'check-page-server.js'), ['--serve', root, mode])
  const observed = { code: result.code, ...lastJson(result, RESULT) }

  observed.folderAfter = fs.existsSync(observed.folder)

  return observed
}

// Listens on `port` on both loopback families (a server of Vite's may hold one and another process the other); a family it cannot bind is held by someone else already.
const occupy = async (port) => (await Promise.all(['127.0.0.1', '::1'].map((host) => new Promise((resolve) => {
  const holder = net.createServer()

  holder.on('error', () => resolve(null))
  holder.listen(port, host, () => resolve(holder))
})))).filter(Boolean)

// The scenarios `needs` names, each in a layout of its own with the page server `source`.
const observe = async (source, needs) => {
  const seen = {}

  if (needs.includes('plain')) {
    // The folder of a process that is gone and that of one that is running, for the next server to find.
    const gone = path.join(os.tmpdir(), `${PREFIX}${GONE_PID}-fake`)
    const live = path.join(os.tmpdir(), `${PREFIX}${process.pid}-fake`)

    for (const folder of [gone, live]) {
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, 'AuroraDB.db'), 'x')
    }

    // Vite's default port is held, as it is when a server of another checkout runs: the helper must serve from a port of its own.
    const holders = await occupy(DEFAULT_PORT)

    try {
      seen.plain = await attempt(() => inLayout(source, false, async (layout) => ({ ...await run(layout, layout, 'stop'), goneSwept: !fs.existsSync(gone), liveKept: fs.existsSync(live) })))
    } finally {
      await Promise.all(holders.map((holder) => new Promise((resolve) => holder.close(resolve))))
      fs.rmSync(gone, { recursive: true, force: true })
      fs.rmSync(live, { recursive: true, force: true })
    }
  }

  if (needs.includes('hash')) {
    seen.hash = await attempt(() => inLayout(source, true, (layout) => run(layout, layout, 'stop')))
  }

  if (needs.includes('exit')) {
    seen.exit = await attempt(() => inLayout(source, false, (layout) => run(layout, layout, 'exit')))
  }

  if (needs.includes('reset')) {
    seen.reset = await attempt(() => inLayout(source, false, (layout) => run(layout, layout, 'reset')))
  }

  return seen
}

const served = (scenario) => {
  assert.ok(scenario && !scenario.error, scenario && scenario.error)
  assert.equal(scenario.code, 0)
  assert.ok(Number(new URL(scenario.url).port) > 0, 'the server has a port of its own')

  for (const [route, least] of Object.entries(PAGES)) {
    assert.equal(scenario.pages[route].status, 200, `${route} is answered`)
    assert.ok(scenario.pages[route].length >= least, `${route} came out with ${scenario.pages[route].length} characters`)
  }
}

const answered = (scenario) => assert.ok(scenario && !scenario.error, scenario && scenario.error)

// [id, scenarios it needs, what it holds, the assertions over what they saw]
const CHECKS = [
  ['plain-serves', ['plain'], 'from the project root the index, a page and a utility module are served, each with a body', (seen) => served(seen.plain)],
  ['one-address', ['plain'], 'the pages are opened at the one address the server listens on, an IP address, never at a name such as localhost that a browser resolves to both loopback families', (seen) => {
    served(seen.plain)

    const host = new URL(seen.plain.url).hostname.replace(/^\[(.*)\]$/, '$1')

    assert.ok(net.isIP(host) > 0, `the pages are opened at ${seen.plain.url}`)
  }],
  ['hash-root-serves', ['hash'], 'from a root whose path holds spaces and a hash the index, a page and a utility module are served, each with a body', (seen) => served(seen.hash)],
  ['clean-on-stop', ['plain'], 'stop removes the folder with the copy of the save before it resolves', (seen) => {
    answered(seen.plain)
    assert.equal(seen.plain.savedCopy, true, 'the copy of the save was made')
    assert.equal(seen.plain.goneAfterStop, true)
    assert.equal(seen.plain.folderAfter, false)
  }],
  ['clean-on-exit', ['exit'], 'a process that ends without stopping the server leaves no folder', (seen) => {
    answered(seen.exit)
    assert.equal(seen.exit.code, 3)
    assert.equal(seen.exit.savedCopy, true, 'the copy of the save was made')
    assert.equal(seen.exit.folderAfter, false)
  }],
  ['private-cache', ['plain'], 'Vite\'s cache is inside the folder of the run and under no node_modules folder', (seen) => {
    answered(seen.plain)

    const inside = path.relative(seen.plain.folder, seen.plain.cacheDir)

    assert.ok(inside && !inside.startsWith('..') && !path.isAbsolute(inside), `the cache is at ${seen.plain.cacheDir}`)
    assert.ok(!seen.plain.cacheDir.split(/[\\/]/).includes('node_modules'), `the cache is at ${seen.plain.cacheDir}`)
    assert.equal(seen.plain.cacheWritten, true, 'Vite wrote its dependency cache there')
  }],
  ['sweeps-gone', ['plain'], 'the next server removes the folder of a process that is gone', (seen) => {
    answered(seen.plain)
    assert.equal(seen.plain.goneSwept, true)
  }],
  ['keeps-live', ['plain'], 'the next server keeps the folder of a process that is running', (seen) => {
    answered(seen.plain)
    assert.equal(seen.plain.liveKept, true)
  }],
  ['replaced-served', ['reset'], 'a file replaced is served as given', (seen) => {
    answered(seen.reset)
    assert.equal(seen.reset.replacedServed, true)
  }],
  ['restore-clean', ['reset'], 'a file restored is served as it is on disk again, with nothing of its replacement', (seen) => {
    answered(seen.reset)
    assert.equal(seen.reset.restoreError, null)
    assert.equal(seen.reset.restoredClean, true)
  }],
  ['reset-restores', ['reset'], 'reset serves a file a variant left replaced as it is on disk again', (seen) => {
    answered(seen.reset)
    assert.equal(seen.reset.resetClean, true)
  }],
  ['reset-names', ['reset'], 'reset names the file a variant left replaced', (seen) => {
    answered(seen.reset)
    assert.ok(String(seen.reset.leftNamed).includes(path.basename(MODULE.file)), `reset said ${seen.reset.leftNamed}`)
  }],
  ['reset-save', ['reset'], 'reset copies the save the server started with back over the save useSave switched to', (seen) => {
    answered(seen.reset)
    assert.equal(seen.reset.switched, true, 'useSave changed the copy')
    assert.equal(seen.reset.switchUndone, true)
  }],
  ['reset-write', ['reset'], 'reset copies the save the server started with back over a copy that was written to', (seen) => {
    answered(seen.reset)
    assert.equal(seen.reset.writeUndone, true)
  }],
]

/* eslint-disable no-template-curly-in-string */
// [name, from, to, scenarios to run, the check ids one of which must fail]
const MUTANTS = [
  ['a root with a hash is used as it is and the config is imported by a raw file URL', 'const base = safeRoot(projectRoot)', 'const base = projectRoot', ['hash'], ['hash-root-serves'], ['pathToFileURL(path.join(base, \'scripts\', \'renderer-config.mjs\')).href', '`file:///${path.join(base, \'scripts\', \'renderer-config.mjs\').replace(/\\\\/g, \'/\')}`']],
  ['the default port of Vite is used', 'port: await freePort(), strictPort: true,', 'port: 5173, strictPort: true,', ['plain'], ['plain-serves']],
  ['the pages are opened at localhost, which names both loopback families', 'const url = `http://${HOST}:', 'const url = `http://localhost:', ['plain'], ['one-address']],
  ['the server listens on localhost while the pages are opened at its address', 'server: { host: HOST,', "server: { host: 'localhost',", ['plain'], ['plain-serves', 'one-address']],
  ['the cache is kept under a node_modules folder', "cacheDir: path.join(folder, 'vite-cache')", "cacheDir: path.join(folder, 'node_modules', '.vite')", ['plain'], ['private-cache']],
  ['a process that exits leaves its folder', "  process.on('exit', onExit)\n", '', ['exit'], ['clean-on-exit']],
  ['stop leaves the folder', '      await removeSoon(folder)\n', '', ['plain'], ['clean-on-stop']],
  ['a folder of a gone process is never swept', '  sweepStale()\n', '', ['plain'], ['sweeps-gone']],
  ['a folder of a running process is swept too', 'if (match && !alive(Number(match[1]))) {', 'if (match) {', ['plain'], ['keeps-live']],
  ['a file restored keeps the module compiled from its replacement', 'nodes.forEach((node) => server.moduleGraph.invalidateModule(node))', 'nodes.forEach((node) => text !== null && server.moduleGraph.invalidateModule(node))', ['reset'], ['restore-clean']],
  ['a file restored keeps the module compiled from its replacement, and nothing says so', 'nodes.forEach((node) => server.moduleGraph.invalidateModule(node))', 'nodes.forEach((node) => text !== null && server.moduleGraph.invalidateModule(node))', ['reset'], ['restore-clean'], ['if (text === null && servedReplaced.delete(resolved) && (', 'if (false && servedReplaced.delete(resolved) && (']],
  ['reset leaves a file replaced', 'for (const resolved of left) {', 'for (const resolved of []) {', ['reset'], ['reset-restores']],
  ['reset names no file left replaced', 'if (left.length || problems.length) {', 'if (problems.length) {', ['reset'], ['reset-names']],
  ['reset keeps the save useSave switched to', 'if (current !== startSave || stampOf(copy) !== stamp) {', 'if (stampOf(copy) !== stamp) {', ['reset'], ['reset-save']],
  ['reset keeps a copy that was written to', 'if (current !== startSave || stampOf(copy) !== stamp) {', 'if (current !== startSave) {', ['reset'], ['reset-write']],
]
/* eslint-enable no-template-curly-in-string */

const judge = (seen, needs) => CHECKS.filter(([, wanted]) => wanted.every((need) => needs.includes(need))).map(([id, , name, run]) => {
  try {
    run(seen)

    return { id, name, ok: true, detail: '' }
  } catch (error) {
    return { id, name, ok: false, detail: String(error.message).split('\n')[0] }
  }
})

const main = async () => {
  const options = { mutations: !process.argv.includes('--no-mutations') }
  let checks = 0
  let failures = 0
  const check = (name, ok, detail = '') => {
    checks++

    if (!ok) {
      failures++
    }

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}`)
  }
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'page-server.js'), 'utf8')
  const everyNeed = ['plain', 'hash', 'exit', 'reset']

  for (const result of judge(await observe(source, everyNeed), everyNeed)) {
    check(result.name, result.ok, result.detail)
  }

  if (options.mutations) {
    console.log('\nPlanted faults')

    for (const [name, from, to, needs, caught, also] of MUTANTS) {
      const planted = also ? patched('scripts/lib/page-server.js', patched('scripts/lib/page-server.js', source, from, to), also[0], also[1]) : patched('scripts/lib/page-server.js', source, from, to)
      const failed = judge(await observe(planted, needs), needs).filter((result) => !result.ok).map((result) => result.id)

      check(`planted: ${name}: caught by ${failed.join(', ') || 'nothing'}`, caught.some((id) => failed.includes(id)), `expected one of ${caught.join(', ')}`)
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exitCode = failures ? 1 : 0
}

if (process.argv[2] === '--serve') {
  serve(process.argv[3], process.argv[4]).catch((error) => {
    console.error(error)
    process.exit(2)
  })
} else {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}
