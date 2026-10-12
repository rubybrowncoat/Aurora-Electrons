
import { ipcRenderer } from 'electron'

import chokidar from 'chokidar'

export default ({ store }) => {
  // console.log('app', app, remote, electron, BrowserWindow )

  // // const app = electron.app //|| remote.app
  // const exePath = path.dirname(app.getPath('exe'))
  // const isMac = exePath.includes('MacOS')

  // const headGame = process.env.NODE_ENV === 'development'

  // const storagePath = app.isPackaged
  //   ? isMac
  //     ? path.join(exePath, '../../../', 'AuroraDB.db')
  //     : process.env.PORTABLE_EXECUTABLE_DIR
  //       ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AuroraDB.db')
  //       : path.join(exePath, 'AuroraDB.db')
  //   : headGame
  //     ? path.join('../', 'AuroraDB.db')
  //     : 'AuroraDB.db'

  ipcRenderer.invoke('request-storage-path').then((storagePath) => {
    console.log('Returned storage path:', storagePath)

    store.commit('setSavePath', { savePath: storagePath })

    const watcher = chokidar.watch(storagePath, {
      persistent: true,
      awaitWriteFinish: true,
    })

    // Every notification is recorded as what it is (freshness store `file`), and none of them counts as a read: a notification reopens the save, and only the probe that follows (store `renew`) marks it read. `add` stays handled each time, since the file comes back as a new `add` after it was removed.
    const reopen = (kind) => (path, stats) => {
      console.log(`File ${path} ${kind}.`, stats)

      store.commit('freshness/watched', { kind, at: Date.now() })
      store.dispatch('renew', {
        storagePath,
      })
    }

    watcher.on('add', reopen('add'))
    watcher.on('change', reopen('change'))

    // The open copy may still answer, but nothing says the file it came from is the save any more, so the refresh counts as failed until the file is back and a probe has read it.
    watcher.on('unlink', (path) => {
      console.warn(`File ${path} removed.`)

      store.commit('freshness/watched', { kind: 'unlink', at: Date.now() })
      store.commit('freshness/refreshFailed', { at: Date.now(), message: 'The save file is missing' })
    })

    watcher.on('error', (error) => {
      console.error('The save watcher failed', error)

      const message = String((error && error.message) || error).split(/\r?\n/)[0]

      store.commit('freshness/watched', { kind: 'error', at: Date.now(), message })
      store.commit('freshness/refreshFailed', { at: Date.now(), message: `The save watcher failed: ${message}` })
    })
  })
}
