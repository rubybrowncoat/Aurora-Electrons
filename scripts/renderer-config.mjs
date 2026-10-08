// The renderer's Vite config, shared by the Electron app (electron.vite.config.mjs) and web mode (scripts/web.js).
// They differ in what the Node-side modules the renderer imports turn into: src/renderer/bridge/ in Electron,
// scripts/web/shims/ in a browser.
import path from 'path'

import vue from '@vitejs/plugin-vue2'

// Vite runs from the project root or, when its path contains '#', from a junction to it (scripts/run-vite.js).
// This file's own location can't tell which: electron-vite resolves the junction when it loads its config.
export const PROJECT_ROOT = process.cwd()
export const RENDERER_DIR = path.join(PROJECT_ROOT, 'src', 'renderer')

// Swaps modules in the browser bundle: `bare` maps import names (`electron`), `files` maps the absolute paths of
// renderer files to their stand-ins. Server-side loads (web mode's database middleware) keep the originals.
const swapModules = ({ bare = {}, files = {} }) => ({
  name: 'aurora:swap-modules',
  enforce: 'pre',
  async resolveId (source, importer, options) {
    if (options.ssr) {
      return null
    }

    if (Object.hasOwn(bare, source)) {
      return bare[source]
    }

    if (!Object.keys(files).length || !importer) {
      return null
    }

    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    const file = resolved && path.normalize(resolved.id)

    return file && Object.hasOwn(files, file) ? files[file] : null
  },
})

export const rendererConfig = ({ modules, ...config }) => ({
  root: RENDERER_DIR,
  plugins: [swapModules(modules), vue()],
  resolve: {
    // Keeps module ids on the junction's path (scripts/run-vite.js) instead of resolving them back to one with '#'.
    preserveSymlinks: true,
    alias: [
      // Vuetify's build requires Vue; both must get the one copy the app imports.
      { find: /^vue$/, replacement: 'vue/dist/vue.runtime.esm.js' },
      { find: /^[~@]\//, replacement: `${RENDERER_DIR}/` },
    ],
  },
  ...config,
})
