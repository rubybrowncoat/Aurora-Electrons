/*
  Web mode: serves the renderer as a plain browser app for testing without
  Electron. Electron/Node-only modules are swapped for the shims in ./web/shims,
  and database calls go to ./web/database-middleware.js, which runs the real
  Sequelize models against ./AuroraDB.db (override with AURORA_DB).
  The dev server listens on localhost only; the middleware accepts raw SQL.
 */
process.env.NODE_ENV = 'development'

const path = require('path')
const webpack = require('webpack')
const { Nuxt, Builder } = require('nuxt')
const { SERVER_PORT } = require('./config')
const nuxtConfig = require('./renderer/nuxt.config.js')

const SHIMS_DIR = path.join(__dirname, 'web', 'shims')
const PORT = Number(process.env.PORT) || SERVER_PORT
const HOST = process.env.HOST || 'localhost'

const electronExtend = nuxtConfig.build.extend

nuxtConfig.build.extend = function (config, ctx) {
  electronExtend.call(this, config, ctx)

  config.target = 'web'
  config.externals = []
  config.resolve.alias = {
    ...config.resolve.alias,
    electron$: path.join(SHIMS_DIR, 'electron.js'),
    'electron-store$': path.join(SHIMS_DIR, 'electron-store.js'),
    chokidar$: path.join(SHIMS_DIR, 'chokidar.js'),
    sequelize$: path.join(SHIMS_DIR, 'sequelize.js'),
  }
  config.plugins.push(new webpack.NormalModuleReplacementPlugin(/[\\/]utilities[\\/]database(\.js)?$/, path.join(SHIMS_DIR, 'database.js')))

  // Electron loads dependencies through Node; bundling them hits webpack 4's
  // strict `.mjs` handling (pixi's ESM builds import from CommonJS).
  config.module.rules.push({ test: /\.mjs$/, include: /node_modules/, type: 'javascript/auto' })
}

nuxtConfig.serverMiddleware = [
  { path: '/__aurora-db', handler: require('./web/database-middleware') },
]

// Keep test sessions out of the Sentry project.
nuxtConfig.sentry = { ...nuxtConfig.sentry, disabled: true }

const nuxt = new Nuxt(nuxtConfig)

nuxt.ready()
  .then(() => new Builder(nuxt).build())
  .then(() => nuxt.listen(PORT, HOST))
  .then(() => console.log(`[web] Renderer ready at http://${HOST}:${PORT}`))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
