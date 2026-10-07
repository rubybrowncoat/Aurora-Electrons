import { historyConfig } from '../utilities/history'

// Empire History: `revision` is bumped each time snapshots are written, so pages re-read the history
// file; `failures` lists the games whose latest snapshots the recorder couldn't read or write,
// [{ GameID, stage: 'read' | 'write' }], GameID null when the whole save couldn't be read.
export const state = () => {
  return {
    revision: 0,
    failures: [],
  }
}

export const getters = {
  // (GameID, RaceID) => { count, latest } for a race's snapshots, `latest` being the last one's game time in seconds,
  // or null while the history file can't be trusted. A getter's result lasts until `revision` or `failures` changes, so
  // each race's file is read once per revision, not once per look.
  snapshotSummary (state) {
    const { revision, failures } = state
    const summaries = {}

    return (GameID, RaceID) => {
      const key = `${revision}:${GameID}:${RaceID}`

      if (!(key in summaries)) {
        if (failures.some((failure) => failure.GameID === GameID && failure.stage === 'write')) {
          summaries[key] = null
        } else {
          const snapshots = historyConfig(GameID).get(`races.${RaceID}.snapshots`, [])

          summaries[key] = { count: snapshots.length, latest: snapshots.length ? snapshots[snapshots.length - 1].t : null }
        }
      }

      return summaries[key]
    }
  },
}

export const mutations = {
  recorded (state) {
    state.revision++
  },
  failures (state, failures) {
    state.failures = failures
  },
}
