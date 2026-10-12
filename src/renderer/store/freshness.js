// How current the app's picture of the save is, from what actually happened rather than what was announced. The fields are kept apart on purpose: `file` is the last notification from the file watcher (it proves nothing was read), `refresh` is the latest attempt to read the new copy of the save and how it ended, `read` is the last probe that succeeded, with the game clocks it returned, and `inputs` is the same for each input of the open page. Wall-clock times (ms) are when the app did something, never the file's modification time and never the game's time.

// The scoped probe: the game clocks, one small read of the table every page's game row comes from. It fails when the save can't be read (the game is writing it, the file is gone or malformed), so a success shows the new copy answers.
export const PROBE_SQL = 'select GameID, StartYear, GameTime from FCT_Game'

export const state = () => {
  return {
    // Counts the copies of the save the app has opened (the root store's `renew`). A read belongs to the generation it ran on.
    generation: 0,
    // { kind: 'add' | 'change' | 'unlink' | 'error', at, message } from the watcher; null until it has said anything.
    file: null,
    // { generation, at, outcome: 'reading' | 'ok' | 'failed', message } for the latest attempt; null until the first one. `at` is when it started, then when it ended.
    refresh: null,
    // { at, generation, games: { [GameID]: { StartYear, GameTime } } } for the last successful probe; null until there is one. A failed refresh leaves it as it was.
    read: null,
    // { [page route]: { [input key]: { label, readAt, generation, failedAt, message } } } for the pages that track their inputs (mixins/load-state.js). `readAt` and `generation` move only when the input's read succeeds; `failedAt` is set while its latest read has failed and cleared by the next success.
    inputs: {},
  }
}

export const getters = {
  // 'waiting' before the first refresh, then the latest refresh's outcome: 'reading' (the shown read is the previous generation's), 'ok' or 'failed'.
  status (state) {
    return state.refresh ? state.refresh.outcome : 'waiting'
  },
  // The selected game's clocks from the last successful probe, { StartYear, GameTime }, or null when no game is picked or the probe didn't return it.
  gameClock (state, _getters, rootState) {
    return (state.read && state.read.games[rootState.GameID]) || null
  },
}

export const mutations = {
  // A new copy of the save was opened. Nothing has been read from it yet.
  opened (state, { at }) {
    state.generation += 1
    state.refresh = { generation: state.generation, at, outcome: 'reading', message: null }
  },
  // The watcher spoke. This records the event only; the read time moves when a probe succeeds.
  watched (state, { kind, at, message = null }) {
    state.file = { kind, at, message }
  },
  // The probe of `generation` succeeded. Taken only while that generation's refresh is still reading: a copy that has since been replaced, or a refresh a file event already failed, doesn't count.
  read (state, { generation, at, games }) {
    const { refresh } = state

    if (generation !== state.generation || !refresh || refresh.generation !== generation || refresh.outcome !== 'reading') {
      return
    }

    state.read = { at, generation, games }
    state.refresh = { generation, at, outcome: 'ok', message: null }
  },
  // The current generation's refresh failed (its probe, the open, or a file event that makes the copy untrustworthy). The last read stays.
  refreshFailed (state, { at, message }) {
    state.refresh = { generation: state.generation, at, outcome: 'failed', message }
  },

  inputRead (state, { page, key, label, at, generation }) {
    state.inputs = { ...state.inputs, [page]: { ...state.inputs[page], [key]: { label, readAt: at, generation, failedAt: null, message: null } } }
  },
  inputFailed (state, { page, key, label, at, message }) {
    const previous = (state.inputs[page] && state.inputs[page][key]) || { readAt: null, generation: null }

    state.inputs = { ...state.inputs, [page]: { ...state.inputs[page], [key]: { ...previous, label, failedAt: at, message } } }
  },
  pageClosed (state, { page }) {
    const rest = { ...state.inputs }

    delete rest[page]
    state.inputs = rest
  },
}

export const actions = {
  // Read the clocks of every game from the copy of the save now open, and take the result only if that copy is still the current one. Never rejects. The read skips the query cache (the `raw` option makes it uncacheable), so a success is the save answering now.
  async probe ({ commit, state, rootState }) {
    const { generation } = state
    const { database } = rootState

    if (!database) {
      commit('refreshFailed', { at: Date.now(), message: rootState.databaseError || 'No save is open' })

      return
    }

    try {
      const [rows] = await database.query(PROBE_SQL, { raw: true })
      const games = {}

      rows.forEach(({ GameID, StartYear, GameTime }) => {
        games[GameID] = { StartYear, GameTime }
      })

      commit('read', { generation, at: Date.now(), games })
    } catch (error) {
      if (generation === state.generation) {
        commit('refreshFailed', { at: Date.now(), message: String((error && error.message) || error).split(/\r?\n/)[0] })
      }
    }
  },
}
