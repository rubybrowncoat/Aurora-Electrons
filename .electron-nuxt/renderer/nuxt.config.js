/* eslint no-param-reassign: 0 */
process.env.BABEL_ENV = 'renderer'

// @nuxt/telemetry loads node-fetch 2, whose whatwg-url 5 requires Node's core `punycode`, and Node 21+ warns (DEP0040) about it.
// No release of either avoids it, so drop that one warning in whichever process loads this config
// (`yarn dev`'s forked Nuxt process, `yarn web`, `yarn electron:smoke`); every other warning still prints.
const { emitWarning } = process
process.emitWarning = function (warning, ...args) {
  const [type, code] = args
  if ((typeof type === 'object' && type !== null ? type.code : code) === 'DEP0040') return
  return emitWarning.call(this, warning, ...args)
}
const isProduction = process.env.NODE_ENV === 'production'
const isDev = process.env.NODE_ENV === 'development'
const path = require('path')
const webpack = require('webpack')
const deepmerge = require('deepmerge')
const nodeExternals = require('webpack-node-externals')
const resourcesPath = require('../resources-path-provider')
const { RENDERER_PROCESS_DIR, DIST_DIR, DISABLE_BABEL_LOADER } = require('../config')
const userNuxtConfig = require('../../src/renderer/nuxt.config')

const baseConfig = {
  srcDir: RENDERER_PROCESS_DIR,
  rootDir: RENDERER_PROCESS_DIR,
  router: {
    mode: 'hash'
  },
  dev: isDev,
  generate: {
    dir: path.join(DIST_DIR, 'renderer')
  }
};

const baseExtend = (config, { isClient }) => {
  config.externals = [nodeExternals({
    modulesFromFile: {
      include: ['dependencies']
    }
  })]

  config.target = 'electron-renderer'
  
  config.node = {
    __dirname: !isProduction,
    __filename: !isProduction
  }

  config.plugins.push(
    new webpack.DefinePlugin({
      'process.resourcesPath': isClient ? resourcesPath.nuxtClient() : resourcesPath.nuxtServer()
    })
  )

  config.module = config.module || {}
  config.module.rules = config.module.rules || []

  if (DISABLE_BABEL_LOADER) {
    // https://github.com/nuxt/typescript/blob/master/packages/typescript-build/src/index.ts#L55
    const jsLoader = config.module.rules.find(el => el.test.test('sample.js') === true)
    if (jsLoader) jsLoader.use = [path.join(__dirname, 'do-nothing-loader.js')]
  }

}

const mergeConfig = customConfig => {
  const hasExtendFunction = (customConfig.build !== undefined && customConfig.build.extend !== undefined);
  if(hasExtendFunction){
    const userExtend = customConfig.build.extend;
    customConfig.build.extend = function() {
      baseExtend(...arguments) // eslint-disable-line prefer-rest-params
      userExtend(...arguments) // eslint-disable-line prefer-rest-params
    }
  } else {
    if(baseConfig.build === undefined) baseConfig.build = {};
    baseConfig.build.extend = baseExtend;
  }

  if (customConfig.build !== undefined && customConfig.build.plugins !== undefined) {
    // webpack config plugins should not use deep merge
    let { plugins, ...rest } = customConfig.build;
    customConfig.build = rest;
    let result = deepmerge(baseConfig, customConfig);
    result.build.plugins = plugins;
    return result;
  } else {
    return deepmerge(baseConfig, customConfig);
  }
}


module.exports = mergeConfig(userNuxtConfig);
module.exports.mergeConfig = mergeConfig;
module.exports.baseConfig = baseConfig;
