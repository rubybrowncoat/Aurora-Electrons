// Empire History: `revision` is bumped each time snapshots are written, so pages re-read the history
// file; `unsaved` lists the games whose latest snapshots the recorder couldn't write.
export const state = () => {
  return {
    revision: 0,
    unsaved: [],
  }
}

export const mutations = {
  recorded (state) {
    state.revision++
  },
  unsaved (state, GameIDs) {
    state.unsaved = GameIDs
  },
}
