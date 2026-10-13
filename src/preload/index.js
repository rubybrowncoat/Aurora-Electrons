// The Node-side modules the renderer uses. The window has no Node integration of its own, but it shares this script's JavaScript world (contextIsolation is off), so it gets the real objects: Sequelize models and instances and the watcher's callbacks work as if imported there, and electron-store is the client of the main process's store host (store-client.js). src/renderer/bridge/ re-exports them under their usual import names, and web mode swaps those names for scripts/web/shims/ instead.
import { ipcRenderer, shell } from 'electron'
// The renderer's Sentry reports reach the main process (src/main/sentry.js) over this IPC. Main can't inject it itself: bundling moves the script it would inject.
import '@sentry/electron/preload'
import * as sequelize from 'sequelize'
import * as chokidar from 'chokidar'

import { createStoreClient } from './store-client'

window.__aurora = {
  electron: { ipcRenderer, shell },
  sequelize,
  chokidar,
  // The app's settings and history files are read and written by the main process (src/main/store-host.js), one request at a time for every window.
  ElectronStore: createStoreClient((request) => ipcRenderer.sendSync('aurora-store', request)),
}
