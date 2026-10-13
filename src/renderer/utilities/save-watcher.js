// Watches the file of the save the window shows, one watcher at a time. A watcher belongs to one path: `start` ends the one before it (so a notification that is already on its way is dropped, never acted on) and watches the new path; `stop` ends it with none after it. A notification counts only while its watcher is the live one and the store still shows the path it watches.
export const createSaveWatcher = ({ chokidar, store, log = console }) => {
  let current = null

  const messageOf = (error) => String((error && error.message) || error).split(/\r?\n/)[0]

  const retire = () => {
    const watcher = current

    current = null

    if (!watcher) {
      return Promise.resolve()
    }

    watcher.live = false

    return Promise.resolve(watcher.handle.close()).catch((error) => {
      log.error("Couldn't close the save watcher", error)
    })
  }

  const start = (path) => {
    const closing = retire()
    const handle = chokidar.watch(path, {
      persistent: true,
      awaitWriteFinish: true,
    })
    const mine = { handle, path, live: true, removed: false }

    current = mine

    const alive = () => mine.live && current === mine && store.state.savePath === path

    // Every notification is recorded as what it is (freshness store `file`), and none of them counts as a read: a notification reopens the save, and only the probe that follows (store `renew`) marks it read.
    handle.on('change', (file, stats) => {
      if (!alive()) {
        return
      }

      log.log(`File ${file} change.`, stats)

      store.commit('freshness/watched', { kind: 'change', at: Date.now() })
      store.dispatch('renew', { storagePath: path })
    })

    // `add` stays handled each time, since the file comes back as a new `add` after it was removed. The first `add` of a watcher reports the file as it already is: when the store opened that very file, it is recorded and the save is not opened a second time.
    handle.on('add', (file, stats) => {
      if (!alive()) {
        return
      }

      log.log(`File ${file} add.`, stats)

      const opened = !mine.removed && store.state.database && store.state.databasePath === path

      mine.removed = false
      store.commit('freshness/watched', { kind: 'add', at: Date.now() })

      if (!opened) {
        store.dispatch('renew', { storagePath: path })
      }
    })

    // The open copy may still answer, but nothing says the file it came from is the save any more, so the refresh counts as failed until the file is back and a probe has read it.
    handle.on('unlink', (file) => {
      if (!alive()) {
        return
      }

      log.warn(`File ${file} removed.`)

      mine.removed = true
      store.commit('freshness/watched', { kind: 'unlink', at: Date.now() })
      store.commit('freshness/refreshFailed', { at: Date.now(), message: 'The save file is missing' })
    })

    handle.on('error', (error) => {
      if (!alive()) {
        return
      }

      log.error('The save watcher failed', error)

      const message = messageOf(error)

      store.commit('freshness/watched', { kind: 'error', at: Date.now(), message })
      store.commit('freshness/refreshFailed', { at: Date.now(), message: `The save watcher failed: ${message}` })
    })

    return closing
  }

  return {
    start,
    stop: retire,
    // How many watchers are open: 0 or 1.
    live: () => (current ? 1 : 0),
  }
}
