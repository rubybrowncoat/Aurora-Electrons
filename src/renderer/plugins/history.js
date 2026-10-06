import { recordHistory } from '../utilities/history'

// Empire History: every time the save is (re)loaded, snapshot each player race into the history file.
export default ({ store }) => {
  store.watch((state) => state.database, (database) => {
    if (!database) {
      return
    }

    recordHistory(database).then(({ recorded, failed }) => {
      failed.forEach(({ GameID, error }) => {
        console.error(`Empire history: couldn't save game ${GameID}'s snapshots`, error)
      })

      store.commit('history/unsaved', failed.map(({ GameID }) => GameID))

      if (recorded) {
        store.commit('history/recorded')
      }
    }).catch((error) => {
      console.error('Empire history: snapshot failed', error)
    })
  })
}
