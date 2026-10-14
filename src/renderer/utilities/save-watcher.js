// How the app follows the save file, and recovers when the file misbehaves. The bounds of the recovery: a burst of notifications is heard out for SETTLE_MS (and never longer than MAX_WAIT_MS from its first one) and opens the save once; a reload that fails is tried again after each of RETRY_MS in turn and then left to the manual retry, so nothing ever loops.
export const RECOVERY_TIMING = {
  settleMs: 300,
  maxWaitMs: 2500,
  retryMs: [1000, 2000, 4000, 8000],
}

// Watches the file of the save the window shows, one watcher at a time. A watcher belongs to one path: `start` ends the one before it (so a notification that is already on its way is dropped, never acted on, and its timers are cleared) and watches the new path; `stop` ends it with none after it. A notification counts only while its watcher is the live one and the store still shows the path it watches.
//
// Every notification is recorded as what it is (freshness store `file`), and none of them counts as a read: a notification asks for the save to be opened again (store `renew`), and only the probe that follows marks it read. The asks are coalesced: notifications heard while one is waiting restart its wait, and notifications heard while a reload is still reading ask for exactly one more after it, so a burst opens one copy, not one for each notification. When a reload fails (the file is locked, half written, not a save, or gone) the freshness store's `recovery` says so, and the reload is tried again on a growing delay, a bounded number of times; a file that is missing is not retried, it is waited for (its `add` is the retry). `retry` is the manual retry: it starts over at once, with the attempts counted afresh.
export const createSaveWatcher = ({ chokidar, store, log = console, timing = {} }) => {
  const { settleMs, maxWaitMs, retryMs } = { ...RECOVERY_TIMING, ...timing }
  let current = null

  const messageOf = (error) => String((error && error.message) || error).split(/\r?\n/)[0]

  const retire = () => {
    const watcher = current

    current = null

    if (!watcher) {
      return Promise.resolve()
    }

    watcher.live = false
    clearTimeout(watcher.timer)
    watcher.unwatch()

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
    // `timer` is the one wait there is (the settling of a burst, or the delay before a retry), `burstAt` when the burst being heard began, `running` the generation whose read is awaited (any copy the store opens while this watcher is live, the one a switch opens included, is taken up as it opens), `again` that a notification came while it was read, and `attempt` the automatic retries made since the last notification.
    const mine = { handle, path, live: true, removed: false, timer: null, burstAt: null, running: null, again: false, attempt: 0, unwatch: () => {} }

    current = mine

    const alive = () => mine.live && current === mine && store.state.savePath === path

    const recovery = (patch) => store.commit('freshness/recovery', patch)

    const wait = (delay, run) => {
      clearTimeout(mine.timer)
      mine.timer = setTimeout(() => {
        mine.timer = null

        if (alive()) {
          run()
        }
      }, delay)
    }

    // The save is opened again: a new copy, read at once by the probe, whose outcome `settled` takes up (a copy that cannot be opened at all fails inside `renew` itself, which `settled` takes up as well).
    const reload = () => {
      mine.burstAt = null
      mine.again = false
      mine.running = null
      recovery({ state: 'reconnecting', attempt: mine.attempt, limit: retryMs.length, nextAt: null, message: null })
      store.dispatch('renew', { storagePath: path })
    }

    // A notification asks for a reload: heard out for the settling time, restarting it while more arrive, but never past the longest wait from the first of the burst. One still reading asks for one more behind it.
    const ask = () => {
      mine.attempt = 0

      if (mine.running !== null) {
        mine.again = true
        recovery({ state: 'reconnecting', attempt: 0, limit: retryMs.length, nextAt: null, message: null })

        return
      }

      const now = Date.now()

      if (mine.burstAt === null) {
        mine.burstAt = now
      }

      const delay = Math.min(settleMs, Math.max(0, mine.burstAt + maxWaitMs - now))

      recovery({ state: 'reconnecting', attempt: 0, limit: retryMs.length, nextAt: now + delay, message: null })
      wait(delay, reload)
    }

    // A reload ended without the file being readable.
    const failed = (message) => {
      if (mine.removed) {
        recovery({ state: 'missing', attempt: 0, limit: retryMs.length, nextAt: null, message })

        return
      }

      if (mine.attempt < retryMs.length) {
        const delay = retryMs[mine.attempt]

        mine.attempt += 1
        recovery({ state: 'unreadable', attempt: mine.attempt, limit: retryMs.length, nextAt: Date.now() + delay, message })
        wait(delay, reload)

        return
      }

      recovery({ state: 'unreadable', attempt: mine.attempt, limit: retryMs.length, nextAt: null, message })
    }

    // The one place a copy's outcome is taken up (freshness store `refresh`), whoever opened the copy: the copy that starts reading (the first one of a save, the one a switch opens, one a reload opens) is the one awaited from then on, an older one that is still being read being given up; its read ends in `ok`, or in `failed`, which is one failure to retry. Whatever else moves `refresh` (a removal, a watcher error) is for the handler that moved it.
    function settled (refresh) {
      if (!alive() || !refresh) {
        return
      }

      if (refresh.outcome === 'reading') {
        mine.running = refresh.generation

        return
      }

      if (mine.running === null || refresh.generation !== mine.running) {
        return
      }

      mine.running = null

      if (mine.again) {
        mine.again = false
        mine.burstAt = null
        ask()

        return
      }

      if (refresh.outcome === 'ok') {
        mine.attempt = 0
        recovery({ state: 'ok', attempt: 0, limit: retryMs.length, nextAt: null, message: null })
      } else {
        failed(refresh.message)
      }
    }

    mine.unwatch = store.watch((state) => state.freshness.refresh, settled, { sync: true })

    // The manual retry: whatever waits or reads is dropped and the save is opened again now.
    mine.retry = () => {
      clearTimeout(mine.timer)
      mine.timer = null
      mine.attempt = 0
      reload()
    }

    handle.on('change', (file, stats) => {
      if (!alive()) {
        return
      }

      log.log(`File ${file} change.`, stats)

      store.commit('freshness/watched', { kind: 'change', at: Date.now() })
      ask()
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
        ask()
      }
    })

    // The open copy may still answer, but nothing says the file it came from is the save any more, so the refresh counts as failed until the file is back and a probe has read it. Nothing is read or retried while it is gone; its `add` asks for the reload.
    handle.on('unlink', (file) => {
      if (!alive()) {
        return
      }

      log.warn(`File ${file} removed.`)

      clearTimeout(mine.timer)
      mine.timer = null
      mine.burstAt = null
      mine.running = null
      mine.again = false
      mine.attempt = 0
      mine.removed = true
      store.commit('freshness/watched', { kind: 'unlink', at: Date.now() })
      store.commit('freshness/refreshFailed', { at: Date.now(), message: 'The save file is missing' })
      recovery({ state: 'missing', attempt: 0, limit: retryMs.length, nextAt: null, message: 'The save file is missing' })
    })

    // The watcher cannot say what the file is (a lock or a permission refusal while it looked): the save is read to find out, on the same bounded retries.
    handle.on('error', (error) => {
      if (!alive()) {
        return
      }

      log.error('The save watcher failed', error)

      const message = messageOf(error)

      // A copy being read is failed by the refresh below, which `settled` counts once; with none being read the failure is counted here.
      const reading = mine.running !== null

      store.commit('freshness/watched', { kind: 'error', at: Date.now(), message })
      store.commit('freshness/refreshFailed', { at: Date.now(), message: `The save watcher failed: ${message}` })

      if (!reading) {
        failed(`The save watcher failed: ${message}`)
      }
    })

    return closing
  }

  return {
    start,
    stop: retire,
    // Open the save again now, with the automatic retries counted afresh; false when no save is watched.
    retry: () => {
      if (!current) {
        return false
      }

      current.retry()

      return true
    },
    // How many watchers are open: 0 or 1.
    live: () => (current ? 1 : 0),
  }
}
