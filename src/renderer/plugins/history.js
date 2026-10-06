import { recordHistory } from '../utilities/history'

// Empire History: every time the save is (re)loaded, snapshot each player race into the history file.
export default ({ store }) => {
  // Counts database replacements. A pass is abandoned before it writes once a newer database has
  // replaced its own: two saves in quick succession start two passes that can finish in either order.
  let generation = 0

  store.watch((state) => state.database, (database) => {
    const mine = ++generation

    if (!database) {
      return
    }

    // Open views refresh after each game's file is written, so a game that fails later in the pass
    // doesn't leave them stale.
    recordHistory(database, { onSaved: () => store.commit('history/recorded'), isCurrent: () => mine === generation }).then(({ failed, superseded }) => {
      failed.forEach(({ GameID, stage, error }) => {
        console.error(`Empire history: couldn't ${stage} game ${GameID}'s snapshots`, error)
      })

      if (!superseded) {
        store.commit('history/failures', failed.map(({ GameID, stage }) => ({ GameID, stage })))
      }
    }).catch((error) => {
      console.error('Empire history: snapshot failed', error)

      // The save couldn't be read at all (the game may have been writing it): no game was recorded.
      if (mine === generation) {
        store.commit('history/failures', [{ GameID: null, stage: 'read' }])
      }
    })
  })
}
