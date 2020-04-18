import { resetDatabase } from '../../utilities/database'

export const state = () => {
  return {
    database: null,
    game: null,
  }
}

export const getters = {
  database(state) {
    return state.database
  },
  game(state) {
    return state.game
  },
}

export const mutations = {
  replaceDatabase(state, { database }) {
    this.state.database = database
  },

  setGame(state, { gameId }) {
    this.state.game = gameId
  },
}

export const actions = {
  renew({ commit }, { storagePath }) {
    commit('replaceDatabase', {
      database: resetDatabase(storagePath)
    })
  },

  changeGame({ commit }, { gameId }) {
    commit('setGame', { gameId })
  },
}
