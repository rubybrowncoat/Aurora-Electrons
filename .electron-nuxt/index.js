
require('./kill-tree')

const path = require('path')
const electron = require('electron')

const { Pipeline, Logger } = require('@xpda-dev/core')
const { ElectronLauncher } = require('@xpda-dev/electron-launcher')
const { ElectronBuilder } = require('@xpda-dev/electron-builder')
const { Webpack } = require('@xpda-dev/webpack-step')
const { BUILD_DIR, DIST_DIR, PROJECT_ROOT } = require('./config')
const { checkInstalled, checkPackaged } = require('./check-native')
const mainWebpackConfig = require('./main-webpack')
const NuxtApp = require('./renderer/NuxtApp')

const isDev = process.env.NODE_ENV === 'development'

const electronLogger = new Logger('Electron', 'teal')
electronLogger.ignore(text => text.includes('nhdogjmejiglipccpnnnanhbledajbpd')) // Clear vue devtools errors

const launcher = new ElectronLauncher({
  logger: electronLogger,
  electronPath: electron,
  entryFile: path.join(DIST_DIR, 'main/index.js')
})

function hasConfigArgument (array) {
  for (const el of array) if (el === '--config' || el === '-c') return true
  return false
}
const argumentsArray = process.argv.slice(2)
if (!hasConfigArgument(argumentsArray)) argumentsArray.push('--config', 'builder.config.js')

const builder = new ElectronBuilder({
  processArgv: argumentsArray
})

if (!isDev) {
  checkInstalled(PROJECT_ROOT)

  const packageApp = builder.build.bind(builder)

  builder.build = async () => {
    await packageApp()

    checkPackaged(BUILD_DIR).forEach((folder) => console.log(`sqlite3 binary present in ${folder}`))
  }
}

const webpackConfig = mainWebpackConfig(path.join(DIST_DIR, 'main'))

const webpackMain = new Webpack({
  logger: new Logger('Main', 'olive'),
  webpackConfig,
  launcher // need to restart launcher after compilation
})

const nuxt = new NuxtApp(new Logger('Nuxt', 'green'))

const pipe = new Pipeline({
  title: 'Electron-nuxt',
  isDevelopment: isDev,
  steps: [webpackMain, nuxt],
  launcher,
  builder
})

pipe.run()
