/*
  Web mode: serves the renderer as a plain browser app for testing without
  Electron. Electron/Node-only modules are swapped for the shims in ./web/shims,
  and database calls go to ./web/database-middleware.js, which runs the real
  Sequelize models against ./AuroraDB.db (override with AURORA_DB).
  The middleware executes raw SQL, so the server listens on localhost only and
  the middleware answers only the page (see web/database-middleware.js).
  Run through run-vite.js (`yarn web`).
*/
const path = require('path')

const PORT = Number(process.env.PORT) || 9080
const SHIMS_DIR = path.join(__dirname, 'web', 'shims')

// `yarn install --ignore-scripts`, and any later install that relinks sqlite3,
// leaves it without its native binary; every database call would then fail.
try {
  require('sqlite3')
} catch (error) {
  console.error(`[web] sqlite3 can't load (${error.message.split('\n')[0]}). Fetch its prebuilt binary with:\n  (cd node_modules/sqlite3 && ../.bin/node-pre-gyp install --fallback-to-build=false)`)
  process.exit(1)
}

const main = async () => {
  const shim = (name) => path.join(SHIMS_DIR, `${name}.js`)

  const { createServer } = await import('vite')
  const { RENDERER_DIR, rendererConfig } = await import('./renderer-config.mjs')
  const { TOKEN, guardHost, databaseHandler } = require('./web/database-middleware')

  const webMode = {
    name: 'aurora:web-mode',
    configureServer (server) {
      // Ahead of Vite's own middleware, so guardHost covers every route.
      server.middlewares.use(guardHost)
      server.middlewares.use('/__aurora-db', databaseHandler(() => server.ssrLoadModule('/utilities/database.js')))
    },
    // The shims send this token back with every database call. Only the page (behind guardHost) carries it.
    transformIndexHtml: (html) => html.replace('</head>', `<meta name="aurora-web-token" content="${TOKEN}"></head>`),
  }

  const config = rendererConfig({
    modules: {
      bare: {
        electron: shim('electron'),
        'electron-store': shim('electron-store'),
        chokidar: shim('chokidar'),
        sequelize: shim('sequelize'),
      },
      files: {
        [path.join(RENDERER_DIR, 'utilities', 'database.js')]: shim('database'),
      },
    },
    configFile: false,
    mode: 'development',
    // Its own cache, so `yarn web` and `yarn dev` can run side by side.
    cacheDir: path.join(__dirname, '..', 'node_modules', '.vite-web'),
    server: { port: PORT, host: 'localhost' },
  })

  const server = await createServer({ ...config, plugins: [...config.plugins, webMode] })

  await server.listen()

  // Vite moves to the next free port when PORT is taken.
  const url = server.resolvedUrls.local[0].replace(/\/$/, '')

  console.log(`[web] Renderer ready at ${url}`)

  if (new URL(url).port !== String(PORT)) {
    console.warn(`[web] Port ${PORT} is in use (another \`yarn web\` or \`yarn dev\`?). Point the smoke test here with BASE_URL=${url}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
