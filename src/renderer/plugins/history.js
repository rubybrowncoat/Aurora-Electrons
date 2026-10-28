import { campaignStorage, recordHistory } from '../utilities/history'
import { claimRecording } from '../utilities/recording-owner'

// Empire History: every time the save is (re)loaded, settle which campaign each game of it belongs to and snapshot each player race into that campaign's history. One window or tab records a database at a time (utilities/recording-owner.js; windows of other databases record at the same time): another one of the same database reports it and records once the owner has closed. `ownerGrace` is how long a pass waits for the recording lock (the recorder's default when absent).
export default ({ store, ownerGrace }) => {
  // The latest pass started: { generation, status } with status 'running' (reading, or waiting for the recording lock), 'refused' (ended because another tab records) or 'done'.
  let latest = null
  // The requests for a pass that the store counted (`history.captures`, one for each `history/capture`) and the last one a pass has taken: a pass takes the requests made since the one before it (`from` to `to`, a range of several when requests of one tick are answered by one pass, empty when the pass was started by an opened save) and says so in `history/ended`, so a view that asked for a pass tells its end from the end of any other pass.
  let taken = 0

  // Records the open save once this window owns the recording of its database.
  const own = () => {
    if (latest && latest.status === 'refused' && latest.generation === store.state.freshness.generation && store.state.database) {
      record(store.state.database)
    }
  }

  const record = (database, to = taken) => {
    // A pass belongs to the copy of the save it was started for. The store's freshness generation counts the copies opened: once a newer one replaces this, the pass writes nothing more (its migration, registry and history writes all ask), because two saves in quick succession start two passes that can finish in either order.
    const generation = store.state.freshness.generation
    const isOpen = () => store.state.freshness.generation === generation && store.state.database === database
    // Refusal is live state: a check that failed first can be retried into a refusal of the same copy while the pass reads, so every write the pass asks about (`recordHistory`'s guard) and its report ask again, and a pass whose copy was refused since ends as held, never as passed.
    const isCurrent = () => isOpen() && !store.getters['capabilities/refused']
    const pass = { generation, status: 'running' }
    const from = taken + 1
    // The games whose snapshot this pass wrote.
    const saved = new Set()

    taken = Math.max(taken, to)
    latest = pass

    // The capability check of the copy (store/capabilities.js, started when the copy was opened) answers first: a save that is not of the Aurora line the app reads is refused, and nothing of it is recorded: no campaign is settled for it, no snapshot written and no recording lock taken. A check that has not answered or has failed refuses nothing.
    store.dispatch('capabilities/preflight').then(() => {
      // A pass the save was replaced under while the check was pending ends here: it neither claims the lock of the replacement's path nor opens any history storage.
      if (!isOpen()) {
        pass.status = 'done'
        store.commit('history/ended', { from, to, generation, outcome: 'superseded' })

        return
      }

      if (isOpen() && store.getters['capabilities/refused']) {
        pass.status = 'done'
        store.commit('history/ended', { from, to, generation, outcome: 'held' })

        return
      }

      // Once per database: the lock is asked for when the save is first recorded, when its path is known.
      claimRecording({ database: store.state.savePath || '', onOwner: own })

      // Open views refresh after each game's file is written, so a game that fails later in the pass doesn't leave them stale.
      recordHistory(database, { storage: campaignStorage(store.getters.config), path: store.state.savePath, isCurrent, ownerGrace, onResolved: (GameID, resolution) => isCurrent() && store.commit('history/resolved', { GameID, resolution, generation }), onSaved: (GameID) => { saved.add(GameID); store.commit('history/recorded') } }).then(({ failed, superseded }) => {
        // A pass that a newer copy replaced reports nothing: what it failed on belonged to the copy the app has left.
        if (superseded || !isCurrent()) {
          pass.status = 'done'
          store.commit('history/ended', { from, to, generation, outcome: isOpen() ? 'held' : 'superseded' })

          return
        }

        failed.forEach(({ GameID, stage, error }) => {
          console.error(stage === 'registry' ? 'Empire history: the campaign registry could not be used' : stage === 'readonly' ? 'Empire history: another tab records, so this tab writes nothing' : `Empire history: couldn't ${stage} game ${GameID}'s snapshots`, error)
        })

        pass.status = failed.some(({ stage }) => stage === 'readonly') ? 'refused' : 'done'

        store.commit('history/failures', failed.map(({ GameID, stage }) => ({ GameID, stage })))
        // Only the end of a pass confirms what it wrote, and a failure reported with it is read first (utilities/economy-digest.js `recordingStateOf`).
        store.commit('history/passed', { GameIDs: [...saved], generation })
        store.commit('history/ended', { from, to, generation, outcome: failed.some(({ stage }) => stage === 'readonly') ? 'refused' : failed.length ? 'failed' : 'passed' })
      }).catch((error) => {
        pass.status = 'done'

        // A newer save replaced this one and stopped its reads, or the copy was refused meanwhile.
        if (!isCurrent()) {
          store.commit('history/ended', { from, to, generation, outcome: isOpen() ? 'held' : 'superseded' })

          return
        }

        console.error('Empire history: snapshot failed', error)

        // The save couldn't be read at all (the game may have been writing it): no game was recorded.
        store.commit('history/failures', [{ GameID: null, stage: 'read' }])
        store.commit('history/ended', { from, to, generation, outcome: 'failed' })
      })
    })
  }

  store.watch((state) => state.database, (database) => {
    if (database) {
      record(database)
    }
  })

  // A colony was chosen on the History page: the open save is read once more, so the colony's first point is the save the player was looking at.
  store.watch((state) => state.history.captures, (captures) => {
    if (store.state.database) {
      record(store.state.database, captures)
    }
  })
}
