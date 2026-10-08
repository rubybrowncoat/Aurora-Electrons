import { loadEmpires } from '../utilities/empires'

// Every game in the save with its races (`loadEmpires`), for the rail's Empires entry and flyout and the Empires page.
// `error` says why the last read failed, null when it didn't; a failed read keeps the games read before it. `loaded`
// is set by a read that finished, so an empty list can tell "no games in the save" from "not read yet".
export const state = () => {
  return {
    games: [],
    error: null,
    loaded: false,
  }
}

export const mutations = {
  read (state, games) {
    state.games = games
    state.error = null
    state.loaded = true
  },
  failed (state, message) {
    state.error = message
    state.loaded = false
  },
}

// Reads are numbered, so one overtaken by a newer read (the save replaced mid-read, the NPR setting flipped) is dropped.
let latest = 0

export const actions = {
  // Read the list again from the current save, with NPRs as the `spyNPR` setting says. Never rejects.
  async load ({ commit, rootState, rootGetters }) {
    const read = ++latest
    const { database } = rootState

    try {
      const games = database ? await loadEmpires(database, rootGetters.config.get('spyNPR', false)) : []

      if (read === latest) {
        commit('read', games)
      }
    } catch (error) {
      if (read === latest) {
        console.error("Couldn't read the empire list", error)
        commit('failed', error.message)
      }
    }
  },
}
