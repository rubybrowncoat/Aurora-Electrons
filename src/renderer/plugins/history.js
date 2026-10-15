import { campaignStorage, recordHistory } from '../utilities/history'
import { claimRecording } from '../utilities/recording-owner'

// Empire History: every time the save is (re)loaded, settle which campaign each game of it belongs to and snapshot each player race into that campaign's history. One window or tab records a database at a time (utilities/recording-owner.js; windows of other databases record at the same time): another one of the same database reports it and records once the owner has closed. `ownerGrace` is how long a pass waits for the recording lock (the recorder's default when absent).
export default ({ store, ownerGrace }) => {
  // The latest pass started: { generation, status } with status 'running' (reading, or waiting for the recording lock), 'refused' (ended because another tab records) or 'done'.
  let latest = null

  // Records the open save once this window owns the recording of its database.
  const own = () => {
    if (latest && latest.status === 'refused' && latest.generation === store.state.freshness.generation && store.state.database) {
      record(store.state.database)
    }
  }

  const record = (database) => {
    // A pass belongs to the copy of the save it was started for. The store's freshness generation counts the copies opened: once a newer one replaces this, the pass writes nothing more (its migration, registry and history writes all ask), because two saves in quick succession start two passes that can finish in either order.
    const generation = store.state.freshness.generation
    const isCurrent = () => store.state.freshness.generation === generation && store.state.database === database
    const pass = { generation, status: 'running' }

    // Once per database: the lock is asked for when the save is first recorded, when its path is known.
    claimRecording({ database: store.state.savePath || '', onOwner: own })

    latest = pass

    // Open views refresh after each game's file is written, so a game that fails later in the pass doesn't leave them stale.
    recordHistory(database, { storage: campaignStorage(store.getters.config), path: store.state.savePath, isCurrent, ownerGrace, onResolved: (GameID, resolution) => isCurrent() && store.commit('history/resolved', { GameID, resolution, generation }), onSaved: () => store.commit('history/recorded') }).then(({ failed, superseded }) => {
      // A pass that a newer copy replaced reports nothing: what it failed on belonged to the copy the app has left.
      if (superseded || !isCurrent()) {
        pass.status = 'done'

        return
      }

      failed.forEach(({ GameID, stage, error }) => {
        console.error(stage === 'registry' ? 'Empire history: the campaign registry could not be used' : stage === 'readonly' ? 'Empire history: another tab records, so this tab writes nothing' : `Empire history: couldn't ${stage} game ${GameID}'s snapshots`, error)
      })

      pass.status = failed.some(({ stage }) => stage === 'readonly') ? 'refused' : 'done'

      store.commit('history/failures', failed.map(({ GameID, stage }) => ({ GameID, stage })))
    }).catch((error) => {
      pass.status = 'done'

      // A newer save replaced this one and stopped its reads.
      if (!isCurrent()) {
        return
      }

      console.error('Empire history: snapshot failed', error)

      // The save couldn't be read at all (the game may have been writing it): no game was recorded.
      store.commit('history/failures', [{ GameID: null, stage: 'read' }])
    })
  }

  store.watch((state) => state.database, (database) => {
    if (database) {
      record(database)
    }
  })

  // A colony was chosen on the History page: the open save is read once more, so the colony's first point is the save the player was looking at.
  store.watch((state) => state.history.captures, () => {
    if (store.state.database) {
      record(store.state.database)
    }
  })
}
