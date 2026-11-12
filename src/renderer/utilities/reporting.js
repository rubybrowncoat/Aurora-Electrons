import Vue from 'vue'
import { ipcRenderer } from 'electron'

export const reporting = Vue.observable({ loaded: false, available: false, savedChoice: null, enabled: false, initialized: false, restartRequired: false, persistenceError: null, cleanupError: null, error: null, revision: -1 })
const listeners = new Set()
const api = () => window.__aurora ? window.__aurora.reporting : {
  state: () => ipcRenderer.invoke('reporting', { op: 'state' }),
  choose: (enabled) => ipcRenderer.invoke('reporting', { op: 'choose', enabled }),
  subscribe: () => () => undefined,
}

const adopt = (state) => {
  if (state.revision < reporting.revision) return
  Object.assign(reporting, state, { loaded: true })
  listeners.forEach((listener) => listener(reporting))
}

let connected = false
export const connectReporting = (listener) => {
  if (listener) listeners.add(listener)
  if (connected) return
  connected = true
  api().subscribe(adopt)
  api().state().then(adopt).catch(() => {
    Object.assign(reporting, { loaded: true, error: 'The reporting state could not be read. No reporting has been enabled by this window.' })
  })
}

export const chooseReporting = async (enabled) => {
  try {
    adopt(await api().choose(enabled))
  } catch (error) {
    reporting.error = 'The reporting request could not be completed. Its saved state could not be confirmed; try again.'
  }
}
