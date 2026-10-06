// Empire History: `revision` is bumped each time snapshots are written, so pages re-read the history
// file; `failures` lists the games whose latest snapshots the recorder couldn't read or write,
// [{ GameID, stage: 'read' | 'write' }], GameID null when the whole save couldn't be read.
export const state = () => {
  return {
    revision: 0,
    failures: [],
  }
}

export const mutations = {
  recorded (state) {
    state.revision++
  },
  failures (state, failures) {
    state.failures = failures
  },
}
