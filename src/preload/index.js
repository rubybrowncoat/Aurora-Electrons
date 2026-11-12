// The Node-side modules the renderer uses. The window has no Node integration of its own, but it shares this script's JavaScript world (contextIsolation is off), so it gets the real objects: Sequelize models and instances and the watcher's callbacks work as if imported there, and electron-store is the client of the main process's store host (store-client.js). src/renderer/bridge/ re-exports them under their usual import names, and web mode swaps those names for scripts/web/shims/ instead.
import { ipcRenderer, shell } from 'electron'
import { hookupIpc } from '@sentry/electron/preload-namespaced'
import * as sequelize from 'sequelize'
import * as chokidar from 'chokidar'

import { createStoreClient } from './store-client'

const reportingListeners = new Set()
let reportingPrepared = false
let reportingRevision = -1
const prepareReporting = (state) => {
  if (state.revision < reportingRevision) return state
  reportingRevision = state.revision
  if (state.enabled && !reportingPrepared) {
    hookupIpc()
    reportingPrepared = true
  }
  return state
}
const reporting = {
  state: () => ipcRenderer.invoke('reporting', { op: 'state' }).then(prepareReporting),
  choose: (enabled) => ipcRenderer.invoke('reporting', { op: 'choose', enabled }).then(prepareReporting),
  subscribe: (listener) => {
    reportingListeners.add(listener)
    return () => reportingListeners.delete(listener)
  },
}

ipcRenderer.on('reporting:changed', (_event, state) => {
  prepareReporting(state)
  reportingListeners.forEach((listener) => listener(state))
})

window.__aurora = {
  electron: { ipcRenderer, shell },
  reporting,
  sequelize,
  chokidar,
  // The app's settings and history files are read and written by the main process (src/main/store-host.js), one request at a time for every window.
  ElectronStore: createStoreClient((request) => ipcRenderer.sendSync('aurora-store', request)),
}
