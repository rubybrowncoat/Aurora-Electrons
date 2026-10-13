import path from 'path'
import fs, { promises as fsPromises } from 'fs'

import { app, dialog, ipcMain } from 'electron'
import Store from 'electron-store'
import envPaths from 'env-paths'

// Before the window and its handlers, so their errors are reported too.
import './sentry'
import './boot'
import { databaseOf, handleLaunch, launchDatabase, openWindow } from './mainWindow'
import { createStoreHost } from './store-host'

// One process per user-data folder, one window per database. The campaign registry and the history files are read, changed and written whole by the renderers, and windows of one process share the browser locks that serialise them (utilities/recording-owner.js), which a second process could not. A second launch therefore hands over to the running process with the database it was started for (the AuroraDB.db beside its executable): a database that has a window gets that window forward, another database gets a window of its own.
if (!app.requestSingleInstanceLock({ database: launchDatabase() })) {
  app.quit()
} else {
  app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => handleLaunch(additionalData && additionalData.database))
  openWindow()
}

// The settings store's folder is the user-data folder (electron-store's default). Without it, settings fell back to conf's own default (electron-store-nodejs) and the history files couldn't be written at all. A packaged build carries the settings it kept there over once. Other apps with the same omission share that file, so it's only taken when it holds one of this app's keys, and a failed copy only costs the old settings, never the launch.
const settingsPath = path.join(app.getPath('userData'), 'config.json')
const legacySettingsPath = path.join(envPaths('electron-store', { suffix: 'nodejs' }).config, 'config.json')
const isOwnSettings = (settings) => Object.keys(settings).some((key) => ['appearance', 'darkMode', 'spyNPR', 'selectedSeparator'].includes(key) || key.startsWith('game.'))

if (app.isPackaged && !fs.existsSync(settingsPath) && fs.existsSync(legacySettingsPath)) {
  try {
    if (isOwnSettings(JSON.parse(fs.readFileSync(legacySettingsPath, 'utf8')))) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.copyFileSync(legacySettingsPath, settingsPath)
    }
  } catch (error) {
    console.error(`Couldn't carry the settings over from ${legacySettingsPath}`, error)
  }
}

// Every window's settings and history files are read and written here, one request at a time (store-host.js; the window's electron-store is src/preload/store-client.js): two windows writing config.json from their own processes would drop each other's keys.
const storeHost = createStoreHost((options) => new Store(options))

ipcMain.on('aurora-store', (event, request) => {
  event.returnValue = storeHost.handle(request)
})

// The database of the window that asks.
ipcMain.handle('request-storage-path', async (event) => databaseOf(event.sender.id))

const FLAG_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' }

// A race's flag from Aurora's `Flags` folder, beside the asking window's save, as a data URL; null when it is missing or unreadable. The name comes from the save, so only its base name is used and it never leaves that folder. On a case-sensitive file system, a name that differs only in case still matches.
ipcMain.handle('read-flag', async (event, name) => {
  const file = typeof name === 'string' ? path.basename(name) : ''
  const type = FLAG_TYPES[path.extname(file).toLowerCase()]

  if (!type) {
    return null
  }

  try {
    const folder = path.join(path.dirname(databaseOf(event.sender.id)), 'Flags')
    let data = await fsPromises.readFile(path.join(folder, file)).catch(() => null)

    if (!data) {
      const match = (await fsPromises.readdir(folder)).find((entry) => entry.toLowerCase() === file.toLowerCase())

      data = match ? await fsPromises.readFile(path.join(folder, match)) : null
    }

    return data ? `data:${type};base64,${data.toString('base64')}` : null
  } catch (error) {
    return null
  }
})

ipcMain.handle('save-png', (_event, imageData, filePath) => {
  return dialog.showSaveDialog({
    title: 'Save Map as PNG',
    defaultPath: filePath,
    filters: [
      { name: 'PNG Image', extensions: ['png'] },
    ],
  }).then((result) => {
    if (!result.canceled && result.filePath) {
      console.log('Saving PNG to', result.filePath, imageData.length)

      return fsPromises.writeFile(result.filePath, imageData, 'base64')
    }

    return result
  })
})

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  // On macOS it is common for applications and their menu bar to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') app.quit()
})
