import Config from 'electron-store'

import { resetDatabase, retireDatabase } from '../utilities/database'
import { recordsHistory } from '../utilities/history'

const configConfiguration = {}

export const state = () => {
  return {
    config: new Config(configConfiguration),
    database: null,
    // Where the save is expected, and why it couldn't be opened (null while it can).
    savePath: null,
    databaseError: null,

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
  savePath (state) {
    return state.savePath
  },
  databaseError (state) {
    return state.databaseError
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
  setSavePath (state, { savePath }) {
    state.savePath = savePath
  },
  setDatabaseError (state, { message }) {
    state.databaseError = message
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

  // The save changed on disk: open it again. The copy it replaces stops answering, so the work still queued or
  // running on it can't hold the app up.
  renew ({ commit, state }, { storagePath }) {
    const previous = state.database
    let database = null
    let message = null

    // Opening loads the sqlite3 binary, which a broken install or build can lack. Left to throw, the app would go on
    // as if the save held no games.
    try {
      database = resetDatabase(storagePath)
    } catch (error) {
      console.error(`Couldn't open ${storagePath}`, error)
      message = error.message.split(/\r?\n/)[0]
    }

    commit('replaceDatabase', { database })
    commit('setDatabaseError', { message })

    return retireDatabase(previous)
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
