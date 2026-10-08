// Builds the main process (src/main), the preload script (src/preload) and the renderer (src/renderer) into out/.
// `yarn dev` serves the renderer from Vite's dev server instead, on PORT (default 9080). Both run through
// scripts/run-vite.js, which picks the directory Vite works from.
import path from 'path'

import { defineConfig } from 'electron-vite'

import { RENDERER_DIR, rendererConfig } from './scripts/renderer-config.mjs'

const bridge = (name) => path.join(RENDERER_DIR, 'bridge', `${name}.js`)

// Keeps module ids on the junction's path (scripts/run-vite.js) instead of resolving them back to one with '#'.
const resolve = { preserveSymlinks: true }

export default defineConfig({
  main: {
    resolve,
    build: {
      // Only `yarn dev` loads it (src/main/boot.js), from node_modules; packages leave it out.
      externalizeDeps: { include: ['electron-devtools-installer'] },
    },
  },
  preload: {
    resolve,
  },
  renderer: rendererConfig({
    modules: {
      bare: {
        electron: bridge('electron'),
        'electron-store': bridge('electron-store'),
        chokidar: bridge('chokidar'),
        sequelize: bridge('sequelize'),
      },
    },
    server: {
      port: Number(process.env.PORT) || 9080,
      strictPort: true,
    },
  }),
})
