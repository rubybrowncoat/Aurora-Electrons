import { recordHistory } from '../utilities/history'

// Empire History: every time the save is (re)loaded, snapshot each player race into the history file.
export default ({ store }) => {
  store.watch((state) => state.database, (database) => {
    if (!database) {
      return
    }

    // Open views refresh after each game's file is written, so a game that fails later in the pass
    // doesn't leave them stale.
    recordHistory(database, { onSaved: () => store.commit('history/recorded') }).then(({ failed }) => {
      failed.forEach(({ GameID, error }) => {
        console.error(`Empire history: couldn't save game ${GameID}'s snapshots`, error)
      })

      store.commit('history/unsaved', failed.map(({ GameID }) => GameID))
    }).catch((error) => {
      console.error('Empire history: snapshot failed', error)
    })
  })
}
