// Web mode stand-in for `electron` in the renderer: answers the IPC calls src/main/index.js would handle.

import { databaseRequest } from './database-request'

// The save this page shows, as the main process knows it per window in the app: the page itself, so another tab's switch changes nothing here. Null until the page starts on the server's launch save.
let active = null

// The dev server checks the saves the page may use (scripts/web/database-middleware.js, route `saves`); it keeps no state of the page.
const saves = async (op, path) => {
  const response = await databaseRequest('/saves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, path, active }),
  })
  const body = await response.json()

  if (!response.ok) {
    throw new Error(`[web] saves: ${body && body.error}`)
  }

  return body
}

// The page's own save, once known.
const ready = () => (active ? Promise.resolve(active) : saves('launch').then((launch) => {
  active = active || launch

  return active
}))

const downloadPng = (base64, fileName) => {
  const link = document.createElement('a')
  link.href = `data:image/png;base64,${base64}`
  link.download = fileName
  link.click()
}

export const ipcRenderer = {
  invoke (channel, ...args) {
    switch (channel) {
      case 'request-storage-path': {
        return ready()
      }
      case 'theme:source': {
        // Web mode has no native dialogs: the page reads the colour scheme query itself.
        return Promise.resolve(null)
      }
      case 'saves:state': {
        return ready().then(() => saves('state'))
      }
      case 'saves:select': {
        return ready().then(() => saves('select', args[0])).then((result) => {
          if (result.action === 'switched') {
            active = result.path
          }

          return result
        })
      }
      case 'saves:forget': {
        return saves('forget', args[0])
      }
      case 'saves:choose': {
        // Only the desktop app has the open dialog.
        return ready().then(() => ({ ok: false, action: 'unavailable', path: null, active, reason: 'the open dialog needs the desktop app' }))
      }
      case 'read-flag': {
        // Web mode has no Aurora folder beside the save, so every race shows its initials.
        return Promise.resolve(null)
      }
      case 'save-png': {
        const [imageData, filePath] = args

        downloadPng(imageData, filePath)

        return Promise.resolve({ canceled: false, filePath })
      }
      default: {
        return Promise.reject(new Error(`[web] Unhandled IPC channel: ${channel}`))
      }
    }
  },
}

export const shell = {
  openExternal: (url) => window.open(url, '_blank', 'noopener'),
}

export const remote = {}

export default { ipcRenderer, remote, shell }
