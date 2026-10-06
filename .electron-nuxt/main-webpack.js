const path = require('path')
const webpack = require('webpack')
const { Webpack } = require('@xpda-dev/webpack-step')
const resourcesPath = require('./resources-path-provider')
const { MAIN_PROCESS_DIR, SERVER_HOST, SERVER_PORT } = require('./config')

// The main process bundle, written to `outputPath`/index.js. In development it loads the renderer
// from the Nuxt server on SERVER_PORT.
module.exports = (outputPath) => Webpack.getBaseConfig({
  entry: process.env.NODE_ENV === 'development'
    ? path.join(MAIN_PROCESS_DIR, 'boot/index.dev.js')
    : path.join(MAIN_PROCESS_DIR, 'boot/index.prod.js'),
  output: {
    filename: 'index.js',
    path: outputPath
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.resourcesPath': resourcesPath.mainProcess(),
      'process.env.DEV_SERVER_URL': `'${SERVER_HOST}:${SERVER_PORT}'`
    })
  ]
})
