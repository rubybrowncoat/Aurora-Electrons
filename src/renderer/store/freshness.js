// How current the app's picture of the save is, from what actually happened rather than what was announced. The fields are kept apart on purpose: `file` is the last notification from the file watcher (it proves nothing was read), `refresh` is the latest attempt to read the new copy of the save and how it ended, `read` is the last probe that succeeded, with the game clocks it returned, and `inputs` is the same for each input of the open page. Wall-clock times (ms) are when the app did something, never the file's modification time and never the game's time.

import { failureWords } from '../utilities/provenance'

// The scoped probe: the game clocks, one small read of the table every page's game row comes from. It fails when the save can't be read (the game is writing it, the file is gone or malformed), so a success shows the new copy answers.
export const PROBE_SQL = 'select GameID, StartYear, GameTime from FCT_Game'

// What the watcher's recovery says about the connection to the save file: 'ok' (nothing is wrong or waiting), 'reconnecting' (a change was heard and the save is about to be opened again, or is being), 'missing' (the file is gone and the app waits for it to come back), 'unreadable' (the latest open or read failed). `attempt` of `limit` counts the automatic retries of a failed reload; `nextAt` is when the next one runs, null when none is scheduled (they ran out, so only a manual retry goes on); `message` is why.
export const recovered = () => ({ state: 'ok', attempt: 0, limit: 0, nextAt: null, message: null })

// The recovery in words, or null while nothing is wrong or waiting: what the watcher found, and what happens next (`now` is the wall clock in ms).
export const describeRecovery = (recovery, now) => {
  const because = recovery.message ? ` (${recovery.message})` : ''

  switch (recovery.state) {
    case 'reconnecting':
      return recovery.attempt ? `Reopening the save, retry ${recovery.attempt} of ${recovery.limit}` : 'The save changed on disk and is being opened again'
    case 'missing':
      return 'The save file is missing; the app waits for it to come back'
    case 'unreadable': {
      if (recovery.nextAt === null) {
        return `The save could not be read after ${recovery.attempt} ${recovery.attempt === 1 ? 'retry' : 'retries'}${because}; Retry opens it again`
      }

      const seconds = Math.max(0, Math.ceil((recovery.nextAt - now) / 1000))

      return `The save could not be read${because}; retry ${recovery.attempt} of ${recovery.limit} in ${seconds} s`
    }
    default:
      return null
  }
}

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
    // See `recovered`.
    recovery: recovered(),
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
  // The window shows another save: what was read, heard from the watcher and read for the pages belongs to the one it left. The generation is not reset, so a read of the old save can never match the new one.
  switched (state) {
    state.file = null
    state.refresh = null
    state.read = null
    state.inputs = {}
    state.recovery = recovered()
  },
  // The watcher's recovery moved on; only the fields it names change.
  recovery (state, patch) {
    state.recovery = { ...state.recovery, ...patch }
  },
  // The user asked to open the save again now (the watcher plugin answers it).
  retryRequested () {},
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
        commit('refreshFailed', { at: Date.now(), message: failureWords(error) })
      }
    }
  },
}
