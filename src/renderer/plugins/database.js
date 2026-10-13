import { ipcRenderer } from 'electron'

import chokidar from 'chokidar'

import { setFlagScope } from '../utilities/flags'
import { createSaveWatcher } from '../utilities/save-watcher'

export default ({ store }) => {
  const watcher = createSaveWatcher({ chokidar, store })

  // The watcher follows the save the window shows, and nothing else moves it: a switch (store `openSave`) changes `savePath`, which retires the watcher of the save left and starts the one of the save entered.
  store.watch((state) => state.savePath, (path) => {
    if (path) {
      watcher.start(path)
    } else {
      watcher.stop()
    }
  }, { sync: true })

  // Only the web build's database shim sends this: the dev server no longer has the copy the page opened (it was pushed out, or the server restarted). The save is opened again, as a file change opens it, so reads go to a live copy and the status line says why; a copy that is no longer the open one is ignored.
  window.addEventListener('aurora:database-lost', (event) => {
    if (store.state.database && event.detail.database === store.state.database && store.state.savePath) {
      console.warn('The dev server lost the copy of the save; opening it again')
      store.commit('freshness/watched', { kind: 'error', at: Date.now(), message: 'The connection to the save was lost; it was opened again' })
      store.dispatch('renew', { storagePath: store.state.savePath })
    }
  })

  // The main process names the save the window starts on (the launch database); a switch that happened before this answer came back is the newer word.
  ipcRenderer.invoke('request-storage-path').then((storagePath) => {
    console.log('Returned storage path:', storagePath)

    if (store.state.savePath === null) {
      setFlagScope(storagePath)
      store.commit('setSavePath', { savePath: storagePath })
    }
  })
}
