// Empire History: bumped each time snapshots are written, so pages re-read the history file.
export const state = () => {
  return {
    revision: 0,
  }
}

export const mutations = {
  recorded (state) {
    state.revision++
  },
}
