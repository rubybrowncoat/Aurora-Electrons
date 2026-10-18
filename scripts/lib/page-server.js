// An in-process copy of web mode (scripts/web.js) for a check that drives the real renderer in a browser: Vite serving the renderer with the shims of scripts/web/shims, the database middleware over a copy of a save, and, optionally, the text of one renderer file replaced, so a check can plant a fault in a page and see what a browser draws.
//
// const { startPageServer } = require('./lib/page-server')
// const server = await startPageServer({ save: 'saves/some.db' })
// server.url                                  where the page is served
// server.replace(file, text)                  serves `text` for the renderer file `file` from now on (null restores the file); a browser that loads the page afterwards gets it
// await server.stop()                         closes the copies of the save the pages opened, stops Vite and removes the copy of the save and the cache
//
// One server for each process: the database middleware keeps the save it was loaded for. It runs from the project root, or from the hash-free junction to it when the path holds a '#' (scripts/lib/safe-root.js, as scripts/run-vite.js does), because the renderer config reads the working directory and Vite cuts module ids at a '#'. `root` names another project root (a check of the helper itself uses one with spaces and a '#').
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

let started = false

// A port nothing listens on (Vite takes 0 for its default, 5173, and a server of another checkout may be on it).
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()

  probe.on('error', reject)
  probe.listen(0, 'localhost', () => {
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
  const tokens = new Set()
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
    fs.copyFileSync(path.resolve(projectRoot, save), copy)
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
          return id.includes('?') ? null : replaced.get(path.normalize(id)) ?? null
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
        server: { host: 'localhost', port: await freePort(), strictPort: true, hmr: false, watch: null },
      })

      guard = { header: TOKEN_HEADER, token: TOKEN }
      server = await createServer({ ...config, plugins: [swapFile, ...config.plugins, webMode] })
      await server.listen()
    } finally {
      process.chdir(previous)
    }

    const url = `http://localhost:${server.httpServer.address().port}`

    return {
      url,
      folder,
      cacheDir: server.config.cacheDir,
      replace (file, text) {
        const resolved = path.normalize(path.join(base, path.relative(projectRoot, path.resolve(projectRoot, file))))

        if (text === null) {
          replaced.delete(resolved)
        } else {
          replaced.set(resolved, text)
        }

        server.moduleGraph.getModulesByFile(resolved.replace(/\\/g, '/'))?.forEach((node) => server.moduleGraph.invalidateModule(node))
      },
      stop () {
        stopping = stopping || (async () => {
          try {
            for (const token of tokens) {
              await fetch(`${url}/__aurora-db/release`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', [guard.header]: guard.token }, body: JSON.stringify({ token }) }).catch(() => {})
            }
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
