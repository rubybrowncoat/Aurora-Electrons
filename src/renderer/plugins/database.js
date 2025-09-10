import electron, { remote } from 'electron'
import path from 'path'

import chokidar from 'chokidar'


export default ({ store }) => {
  const app = electron.app || remote.app
  const exePath = path.dirname(app.getPath('exe'))
  const isMac = exePath.indexOf('MacOS') !== -1

  const headGame = process.env.NODE_ENV === 'development'

  const storagePath = app.isPackaged
    ? isMac
      ? path.join(exePath, '../../../', 'AuroraDB.db')
      : process.env.PORTABLE_EXECUTABLE_DIR
        ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AuroraDB.db')
        : path.join(exePath, 'AuroraDB.db')
    : headGame
      ? path.join('../', 'AuroraDB.db')
      : 'AuroraDB.db' 
  
  const watcher = chokidar.watch(storagePath, {
    persistent: true,
    awaitWriteFinish: true,
  })

  watcher.once('add', (path, stats) => {
    console.log(`File ${path} added.`, stats)

    store.dispatch('renew', { 
      storagePath,
    })
  })

  watcher.on('change', (path, stats) => {
    console.log(`File ${path} changed.`, stats)

    store.dispatch('renew', { 
      storagePath,
    })
  })
}
