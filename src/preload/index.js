// The Node-side modules the renderer uses. The window has no Node integration of its own, but it shares this script's
// JavaScript world (contextIsolation is off), so it gets the real objects: Sequelize models and instances, the
// watcher's callbacks and electron-store's stores work as if imported there. src/renderer/bridge/ re-exports them
// under their usual import names, and web mode swaps those names for scripts/web/shims/ instead.
import { ipcRenderer, shell } from 'electron'
import * as sequelize from 'sequelize'
import * as chokidar from 'chokidar'
import ElectronStore from 'electron-store'

window.__aurora = {
  electron: { ipcRenderer, shell },
  sequelize,
  chokidar,
  ElectronStore,
}
