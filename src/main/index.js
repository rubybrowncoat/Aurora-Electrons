import path from 'path'
import { promises as fsPromises } from 'fs'

import { app, dialog, ipcMain } from 'electron'

ipcMain.handle('request-storage-path', async () => {
  const exePath = path.dirname(app.getPath('exe'))
  const isMac = exePath.includes('MacOS')

  const headGame = process.env.NODE_ENV === 'development' && false

  const storagePath = app.isPackaged
    ? isMac
      ? path.join(exePath, '../../../', 'AuroraDB.db')
      : process.env.PORTABLE_EXECUTABLE_DIR
        ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AuroraDB.db')
        : path.join(exePath, 'AuroraDB.db')
    : headGame
      ? path.join('../', 'AuroraDB.db')
      : 'AuroraDB_260_Reisen.db'

  return storagePath
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
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') app.quit()
})

// Load here all startup windows
require('./mainWindow')
