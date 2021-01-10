import { resetDatabase } from '../../utilities/database'

export const state = () => {
  return {
    database: null,

    GameID: null,
    RaceID: null,

    GameTime: 0,
  }
}

export const getters = {
  database(state) {
    return state.database
  },
  GameID(state) {
    return state.GameID
  },
  RaceID(state) {
    return state.RaceID
  },
  GameTime(state) {
    return state.GameTime
  },
}

export const mutations = {
  replaceDatabase(state, { database }) {
    state.database = database
  },

  setGame(state, { GameID }) {
    state.GameID = GameID
  },
  setRace(state, { RaceID }) {
    state.RaceID = RaceID

    console.log(state)
  },
  setGameTime(state, { GameTime }) {
    state.GameTime = GameTime
  },
}

export const actions = {
  renew({ commit }, { storagePath }) {
    commit('replaceDatabase', {
      database: resetDatabase(storagePath)
    })
  },

  changeGame({ commit }, { game, race = null }) {
    commit('setGame', game)
    commit('setGameTime', game)

    if (race) {
      console.log('race', race)

      commit('setRace', race)
    } else if (game.Races.length === 1) {
      const [firstRace] = game.Races

      console.log('firstRace', firstRace)

      commit('setRace', firstRace)
    }
  },
}
