import Config from 'electron-store'

import { resetDatabase } from '../utilities/database'
import { recordsHistory } from '../utilities/history'

const configConfiguration = {}

export const state = () => {
  return {
    config: new Config(configConfiguration),
    database: null,

    GameID: null,
    RaceID: null,
    // The selected race's kind, for what the app records about it (Empire History).
    RaceNPR: false,
    RaceSpecialNPRID: 0,

    StartYear: 0,
    GameTime: 0,

    CivilianShippingLinesActive: true,
  }
}

export const getters = {
  config (state) {
    return state.config
  },
  database (state) {
    return state.database
  },

  GameID (state) {
    return state.GameID
  },
  RaceID (state) {
    return state.RaceID
  },
  // Whether the app keeps Empire History for the selected race (true until a race is picked).
  historyRecorded (state) {
    return !state.RaceID || recordsHistory({ NPR: state.RaceNPR, SpecialNPRID: state.RaceSpecialNPRID })
  },
  StartYear (state) {
    return state.StartYear
  },
  GameTime (state) {
    return state.GameTime
  },
  CivilianShippingLinesActive (state) {
    return state.CivilianShippingLinesActive
  },
}

export const mutations = {
  configDidChange (state, { key, callback, returnant }) {
    returnant.unsubscribe = state.config.onDidChange(key, callback)
  },

  replaceConfig (state, { config }) {
    state.config = config
  },
  replaceDatabase (state, { database }) {
    state.database = database
  },

  setGame (state, { GameID }) {
    state.GameID = GameID
  },
  setRace (state, { RaceID, NPR, SpecialNPRID }) {
    state.RaceID = RaceID
    state.RaceNPR = NPR || false
    state.RaceSpecialNPRID = SpecialNPRID || 0

    console.log(state)
  },
  setGameTime (state, { StartYear, GameTime }) {
    state.StartYear = StartYear
    state.GameTime = GameTime
  },
  setCivilianShippingLinesActive (state, { CivilianShippingLinesActive }) {
    state.CivilianShippingLinesActive = CivilianShippingLinesActive
  },
}

export const actions = {
  reinstantiateConfig ({ commit }) {
    commit('replaceConfig', {
      config: new Config(configConfiguration),
    })
  },

  renew ({ commit }, { storagePath }) {
    commit('replaceDatabase', {
      database: resetDatabase(storagePath),
    })
  },

  changeGame ({ commit }, { game, race = null }) {
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
