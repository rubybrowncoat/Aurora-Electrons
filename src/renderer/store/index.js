import Config from 'electron-store'

import { raceKeyPrefix } from '../utilities/campaign'
import { resetDatabase, retireDatabase } from '../utilities/database'
import { recordsHistory } from '../utilities/history'
import { cacheQueries, dropQueryCache } from '../utilities/query-cache'

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
  // The campaign the selected game's save belongs to (utilities/campaign.js), once the recorder has settled it on the copy of the save now open, else null (also while the next copy is being read, and when its pass failed). GameID is a counter that repeats between saves, so settings and history that belong to a campaign are kept under this, and nothing is read or written under a stale one.
  campaignId (_state, getters) {
    const settled = getters['history/campaign']

    return settled ? settled.campaignId : null
  },
  // The settings key prefix of the selected race's own values, `campaign.<campaignId>.race.<RaceID>`, or null until a campaign and a race are picked.
  racePrefix (state, getters) {
    return getters.campaignId && state.RaceID ? raceKeyPrefix(getters.campaignId, state.RaceID) : null
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

  // The save changed on disk: open it again. The copy it replaces stops answering, so the work still queued or running on it can't hold the app up, and what was read from it is let go. The new copy counts as read only once the freshness probe has read it, and as supported only once the capability preflight has checked it.
  renew ({ commit, dispatch, state }, { storagePath }) {
    const previous = state.database
    let database = null
    let message = null

    // Opening loads the sqlite3 binary, which a broken install or build can lack. Left to throw, the app would go on as if the save held no games.
    try {
      database = cacheQueries(resetDatabase(storagePath))
    } catch (error) {
      console.error(`Couldn't open ${storagePath}`, error)
      message = error.message.split(/\r?\n/)[0]
    }

    commit('replaceDatabase', { database })
    commit('setDatabaseError', { message })
    commit('freshness/opened', { at: Date.now() })
    dropQueryCache(previous)
    dispatch('freshness/probe')
    dispatch('capabilities/preflight')

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
