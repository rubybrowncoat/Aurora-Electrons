// An in-process copy of web mode (scripts/web.js) for a check that drives the real renderer in a browser: Vite serving the renderer with the shims of scripts/web/shims, the database middleware over a copy of a save, and, optionally, the text of one renderer file replaced, so a check can plant a fault in a page and see what a browser draws.
//
// const { startPageServer } = require('./lib/page-server')
// const server = await startPageServer({ save: 'saves/some.db' })
// server.url                                  where the page is served
// await server.warm(browser, { routes })      opens the app once in `browser` (a Playwright browser) and loads the pages of `routes`, so that Vite has compiled what the observations load before the first of them is timed (see `warm` below)
// server.replace(file, text)                  serves `text` for the renderer file `file` from now on (null restores the file); a browser that loads the page afterwards gets it
// await server.useSave(file)                  the pages that open from now on read a copy of the save `file`; the copies the pages opened before are closed
// await server.reset()                        puts the server back as it started, between two variants (see `reset` below)
// await server.stop()                         closes the copies of the save the pages opened, stops Vite and removes the copy of the save and the cache
//
// A warm server serves one variant after another, so nothing a variant changed may reach the next. `replace(file, null)` drops the replacement and the compiled module, and throws when a module that was served from the replacement is still compiled from it; `reset` restores any file still replaced (and throws, naming it), closes every copy of the save the pages opened and, when a page wrote to the copy or `useSave` changed it, copies the save the server started with over it again. A browser holds nothing of one variant for the next when each observation opens a context of its own (scripts/lib/browser-observe.js `observe`).
//
// One server for each process: the database middleware keeps the copy of the save it was loaded for (`useSave` changes what the copy holds). It runs from the project root, or from the hash-free junction to it when the path holds a '#' (scripts/lib/safe-root.js, as scripts/run-vite.js does), because the renderer config reads the working directory and Vite cuts module ids at a '#'. `root` names another project root (a check of the helper itself uses one with spaces and a '#').
//
// Everything it makes is in one folder of its own under the temp folder, `ae-page-server-<pid>-…`: the copy of the save (so nothing the page writes reaches the original) and Vite's cache, never one inside node_modules, which every checkout and worktree of the project shares. The folder is removed when the server stops, when the process exits (also after a failed start, an uncaught error or a signal), and by the next server a process starts when the process that made it is gone. Only a process that is killed outright (no handler runs) leaves its folder until then.
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { pathToFileURL } = require('url')
const { safeRoot } = require('./safe-root')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const FOLDER_PREFIX = 'ae-page-server-'
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
// The longest the warm-up takes: the first start of the app on a server that has just started compiles the app and bundles its dependencies, which takes seconds on a quiet machine and was seen to take many minutes on a busy one.
const WARM_LIMIT = 600000
const WARM_ATTEMPTS = 3
// The one address the server listens on and the pages are opened at. `localhost` names both loopback families, and Vite listens on the first one it resolves to (::1 under Bun and Node on Windows); a browser under load opens some of its connections over the other family, where nothing of the server listens (the app's main module was refused, and the app never started) or another process does.
const HOST = '127.0.0.1'

let started = false

// A port nothing listens on at HOST (Vite takes 0 for its default, 5173, and a server of another checkout may be on it).
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()

  probe.on('error', reject)
  probe.listen(0, HOST, () => {
    const { port } = probe.address()

    probe.close(() => resolve(port))
  })
})

// Closes Vite, or throws if it has not closed in 30 s. A timer holds the process open meanwhile: Bun ends the process without a word when only idle connections are left, and a close that waits for a connection it cannot see (a keep-alive one of this process's own fetch) never finishes. The callers' requests ask the server to close theirs (`connection: close`).
const closeServer = async (server) => {
  let giveUp = null
  const hold = new Promise((_resolve, reject) => {
    giveUp = setTimeout(() => reject(new Error('Vite did not close within 30 s')), 30000)
  })

  try {
    server.httpServer.closeAllConnections?.()
    await Promise.race([server.close(), hold])
  } finally {
    clearTimeout(giveUp)
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// The folders of servers whose process is gone (killed, or ended before it could remove them).
const sweepStale = () => {
  for (const name of fs.readdirSync(os.tmpdir())) {
    const match = name.startsWith(FOLDER_PREFIX) ? /^ae-page-server-(\d+)-/.exec(name) : null

    if (match && !alive(Number(match[1]))) {
      try {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true })
      } catch (error) {
        // Still held; a later server tries again.
      }
    }
  }
}

const removeNow = (folder) => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

// A copy of the save that is still open holds the file on Windows for a moment after the connection is retired.
const removeSoon = async (folder) => {
  for (let attempt = 1; ; attempt++) {
    try {
      removeNow(folder)

      return
    } catch (error) {
      if (attempt === 20) {
        throw new Error(`${folder} could not be removed: ${error.message}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

const stampOf = (file) => {
  const stat = fs.statSync(file)

  return `${stat.size}:${stat.mtimeMs}`
}

// Copies a save over the copy the server serves, which a connection the server has just retired holds for a moment on Windows.
const copySoon = async (from, to) => {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.copyFileSync(from, to)

      return
    } catch (error) {
      if (attempt === 20) {
        throw new Error(`${from} could not be copied to ${to}: ${error.message}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

const startPageServer = async ({ save, root = PROJECT_ROOT }) => {
  if (started) {
    throw new Error('A process starts one page server: the database middleware keeps the save it was loaded for.')
  }

  started = true

  if (os.tmpdir().includes('#')) {
    throw new Error(`The temp folder (${os.tmpdir()}) contains '#', which Vite cannot handle.`)
  }

  sweepStale()

  const projectRoot = path.resolve(root)
  const base = safeRoot(projectRoot)
  const shim = (name) => path.join(base, 'scripts', 'web', 'shims', `${name}.js`)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `${FOLDER_PREFIX}${process.pid}-`))
  const copy = path.join(folder, 'AuroraDB.db')
  const replaced = new Map()
  // The files whose replacement a request was served (the main module of each), until they are restored.
  const servedReplaced = new Set()
  const tokens = new Set()
  const startSave = path.resolve(projectRoot, save)
  let stamp = null
  let current = startSave
  const onExit = () => {
    try {
      removeNow(folder)
    } catch (error) {
      // Held by a copy of the save that is still open: the process ending lets go, and the next server sweeps the folder.
    }
  }
  const onSignal = () => process.exit(1)
  let server = null
  let guard = null
  let stopping = null

  process.on('exit', onExit)
  SIGNALS.forEach((signal) => process.on(signal, onSignal))

  const forget = () => {
    process.off('exit', onExit)
    SIGNALS.forEach((signal) => process.off(signal, onSignal))
  }

  try {
    fs.copyFileSync(startSave, copy)
    stamp = stampOf(copy)
    // The database middleware reads the save to open when it loads.
    process.env.AURORA_DB = copy

    const previous = process.cwd()

    process.chdir(base)

    try {
      const { createServer } = await import('vite')
      const { RENDERER_DIR, rendererConfig } = await import(pathToFileURL(path.join(base, 'scripts', 'renderer-config.mjs')).href)
      const { TOKEN, TOKEN_HEADER, guardHost, databaseHandler } = require('../web/database-middleware')

      const webMode = {
        name: 'aurora:page-server',
        configureServer (instance) {
          instance.middlewares.use(guardHost)
          // The copies the pages open, noted from the answers, so that `stop` can release them: an open copy holds the file.
          instance.middlewares.use('/__aurora-db/reset', (_req, res, next) => {
            const end = res.end.bind(res)

            res.end = (chunk, ...rest) => {
              try {
                tokens.add(JSON.parse(String(chunk)).token)
              } catch (error) {
                // Not an answer with a token.
              }

              return end(chunk, ...rest)
            }
            next()
          })
          instance.middlewares.use('/__aurora-db', databaseHandler(() => instance.ssrLoadModule('/utilities/database.js')))
        },
        transformIndexHtml: (html) => html.replace('</head>', `<meta name="aurora-web-token" content="${TOKEN}"></head>`),
      }
      const swapFile = {
        name: 'aurora:replace-file',
        enforce: 'pre',
        load (id) {
          // Only the module itself: the blocks of a single-file component (`?vue&type=…`) come from what its main module made of the text.
          const file = id.includes('?') ? null : path.normalize(id)

          if (!file || !replaced.has(file)) {
            return null
          }

          servedReplaced.add(file)

          return replaced.get(file)
        },
      }
      const config = rendererConfig({
        modules: {
          bare: { electron: shim('electron'), 'electron-store': shim('electron-store'), chokidar: shim('chokidar'), sequelize: shim('sequelize') },
          files: { [path.join(RENDERER_DIR, 'utilities', 'database.js')]: shim('database') },
        },
        configFile: false,
        mode: 'development',
        cacheDir: path.join(folder, 'vite-cache'),
        logLevel: 'error',
        server: { host: HOST, port: await freePort(), strictPort: true, hmr: false, watch: null },
      })

      guard = { header: TOKEN_HEADER, token: TOKEN }
      server = await createServer({ ...config, plugins: [swapFile, ...config.plugins, webMode] })
      await server.listen()
    } finally {
      process.chdir(previous)
    }

    const url = `http://${HOST}:${server.httpServer.address().port}`
    const releaseAll = async () => {
      for (const token of tokens) {
        await fetch(`${url}/__aurora-db/release`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', [guard.header]: guard.token }, body: JSON.stringify({ token }) }).catch(() => {})
      }

      tokens.clear()
    }
    // Serves `text` for the file at `resolved` (null: the file itself) and drops what Vite compiled of it. A module that a request was served from the replacement must be found and dropped when the file is restored, or the next page would still get it.
    const swap = (resolved, text) => {
      const nodes = [...(server.moduleGraph.getModulesByFile(resolved.replace(/\\/g, '/')) || [])]

      if (text === null) {
        replaced.delete(resolved)
      } else {
        replaced.set(resolved, text)
      }

      nodes.forEach((node) => server.moduleGraph.invalidateModule(node))

      if (text === null && servedReplaced.delete(resolved) && (!nodes.length || nodes.some((node) => node.transformResult))) {
        throw new Error(`${path.relative(base, resolved)} was served from its replacement and ${nodes.length ? 'its module is still compiled from it' : 'no module of it was found to drop'} after it was restored`)
      }
    }

    return {
      url,
      folder,
      cacheDir: server.config.cacheDir,
      warmed: null,
      // Opens the app in a context of `browser` until its game list is drawn, and loads the page modules of `routes`, so that what the observations load is compiled and the dependencies are bundled before the first of them runs against its own deadlines. An attempt that has not got through in its share of `limit` ms (a request that never ends while Vite bundles was seen) or that fails is followed by a fresh one, which finds compiled what the first got to; at most WARM_ATTEMPTS, and none that gets through throws. Records { seconds, attempts } as `warmed`.
      async warm (browser, { routes = [], limit = WARM_LIMIT } = {}) {
        const began = Date.now()
        const problems = []

        for (let attempt = 1; attempt <= WARM_ATTEMPTS && Date.now() - began < limit; attempt++) {
          const timeout = Math.min(limit - (Date.now() - began), limit / WARM_ATTEMPTS)
          let context = null

          try {
            context = await browser.newContext()

            const page = await context.newPage()

            await page.goto(url, { timeout, waitUntil: 'commit' })
            await page.waitForFunction(() => Boolean(window.$app && window.$app.$store && document.querySelector('.empire-list__game')), null, { timeout })
            await page.evaluate(async (paths) => {
              for (const target of paths) {
                await Promise.all(window.$app.$router.resolve(target).route.matched.map((record) => (typeof record.components.default === 'function' ? record.components.default() : null)))
              }
            }, routes)
            this.warmed = { seconds: (Date.now() - began) / 1000, attempts: attempt }

            return this.warmed
          } catch (error) {
            problems.push(String(error.message).split('\n')[0].slice(0, 300))
          } finally {
            if (context) {
              await context.close().catch(() => {})
            }
          }
        }

        throw new Error(`the page server did not warm in ${((Date.now() - began) / 1000).toFixed(0)} s: ${problems.join(' | ')}`)
      },
      replace (file, text) {
        swap(path.normalize(path.join(base, path.relative(projectRoot, path.resolve(projectRoot, file)))), text)
      },
      async useSave (file) {
        current = path.resolve(projectRoot, file)
        await releaseAll()
        await copySoon(current, copy)
        stamp = stampOf(copy)
      },
      // Between two variants: restores every file still replaced, closes every copy of the save the pages opened and, when the copy is no longer the save the server started with as it was copied, copies that save over it again. Throws, once all that is done, naming the files a variant left replaced.
      async reset () {
        const left = [...replaced.keys()]
        const problems = []

        for (const resolved of left) {
          try {
            swap(resolved, null)
          } catch (error) {
            problems.push(error.message)
          }
        }

        await releaseAll()

        if (current !== startSave || stampOf(copy) !== stamp) {
          current = startSave
          await copySoon(startSave, copy)
          stamp = stampOf(copy)
        }

        if (left.length || problems.length) {
          throw new Error(`a variant left ${left.map((resolved) => path.relative(base, resolved)).join(', ')} served in place of the real file${problems.length ? `; ${problems.join('; ')}` : ''}`)
        }
      },
      stop () {
        stopping = stopping || (async () => {
          try {
            await releaseAll()
          } finally {
            try {
              await closeServer(server)
            } finally {
              await removeSoon(folder)
              forget()
            }
          }
        })()

        return stopping
      },
    }
  } catch (error) {
    if (server) {
      await closeServer(server).catch(() => {})
    }

    try {
      removeNow(folder)
      forget()
    } catch (cleanupError) {
      // The exit handler tries again; the start's own error is the one to report.
    }

    throw error
  }
}

module.exports = { startPageServer }
