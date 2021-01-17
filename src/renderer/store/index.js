import { resetDatabase } from '../../utilities/database'

import Config from 'electron-store'

const configConfiguration = {}

export const state = () => {
  return {
    config: new Config(configConfiguration),
    database: null,

    GameID: null,
    RaceID: null,

    GameTime: 0,

    CivilianShippingLinesActive: true,
  }
}

export const getters = {
  config(state) {
    return state.config
  },
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
  CivilianShippingLinesActive(state) {
    return state.CivilianShippingLinesActive
  },
}

export const mutations = {
  replaceConfig(state, { config }) {
    state.config = config
  },
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
  setCivilianShippingLinesActive(state, { CivilianShippingLinesActive }) {
    state.CivilianShippingLinesActive = CivilianShippingLinesActive
  }
}

export const actions = {
  reinstantiateConfig({ commit }) {
    commit('replaceConfig', {
      config: new Config(configConfiguration),
    })
  },

  renew({ commit }, { storagePath }) {
    commit('replaceDatabase', {
      database: resetDatabase(storagePath)
    })
  },

  changeGame({ commit }, { game, race = null }) {
    commit('setGame', game)
    commit('setGameTime', game)
    commit('setCivilianShippingLinesActive', game)

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
