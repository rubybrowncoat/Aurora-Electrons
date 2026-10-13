import path from 'path'

import { app } from 'electron'

import BrowserWinHandler from './BrowserWinHandler'
import { routeLaunch } from './launch'

// The save a launch means: the AuroraDB.db beside the executable (the portable build's folder, the app bundle's folder on macOS), or AURORA_DB in development. Absolute, so a second launch from another folder names it unambiguously to the running process.
const storagePath = () => {
  if (!app.isPackaged && process.env.AURORA_DB) {
    return path.resolve(process.env.AURORA_DB)
  }

  const exePath = path.dirname(app.getPath('exe'))
  const isMac = exePath.includes('MacOS')

  return path.resolve(app.isPackaged ? isMac ? path.join(exePath, '../../../', 'AuroraDB.db') : process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AuroraDB.db') : path.join(exePath, 'AuroraDB.db') : 'AuroraDB.db')
}

export const launchDatabase = storagePath

// The open windows: webContents id -> { database, window }. Each window is bound to the database it was opened for; the handlers that read the save's folder answer for the asking window's database.
const windows = new Map()

export const databaseOf = (webContentsId) => (windows.has(webContentsId) ? windows.get(webContentsId).database : launchDatabase())

export const openWindow = (database = launchDatabase()) => {
  const handler = new BrowserWinHandler({
    height: 800,
    width: 1280,
  }, false)

  handler.onCreated((browserWindow) => {
    const id = browserWindow.webContents.id

    windows.set(id, { database, window: browserWindow })
    browserWindow.on('closed', () => windows.delete(id))
    handler.loadPage('/')
  })

  return handler
}

// A second launch reached the running process, asking for `database`: that database's window comes forward, or a window is opened for it.
export const handleLaunch = (database) => {
  const open = [...windows].map(([id, entry]) => ({ id, database: entry.database }))
  const route = routeLaunch(database, open)

  if (route.action === 'open') {
    openWindow(database)

    return
  }

  const { window } = windows.get(route.id)

  if (window.isMinimized()) {
    window.restore()
  }

  window.focus()
}
