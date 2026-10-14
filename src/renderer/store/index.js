import Config from 'electron-store'
import { markRaw } from 'vue'

import { raceKeyPrefix } from '../utilities/campaign'
import { resetDatabase, retireDatabase } from '../utilities/database'
import { setFlagScope } from '../utilities/flags'
import { recordsHistory } from '../utilities/history'
import { cacheQueries, dropQueryCache } from '../utilities/query-cache'
import { releaseRecording } from '../utilities/recording-owner'

const configConfiguration = {}

// No game or race picked: what the app starts with, and what a new save starts with.
const selection = () => ({
  GameID: null,
  RaceID: null,
  // The selected race's kind, for what the app records about it (Empire History).
  RaceNPR: false,
  RaceSpecialNPRID: 0,

  StartYear: 0,
  GameTime: 0,

  CivilianShippingLinesActive: true,
})

export const state = () => {
  return {
    config: new Config(configConfiguration),
    database: null,
    // The save this window shows, as the main process says (it alone decides it, and it changes only by `openSave`), and why it couldn't be opened (null while it can).
    savePath: null,
    // The path `database` was last opened from: a watcher that finds the file it already opened from does not open it again.
    databasePath: null,
    databaseError: null,

    ...selection(),
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
  setDatabasePath (state, { databasePath }) {
    state.databasePath = databasePath
  },
  // The window shows another save: no game or race of the one it left stays picked.
  clearSelection (state) {
    Object.assign(state, selection())
  },
  // The race picked is gone from the save: the game stays picked, and no other race takes its place.
  clearRace (state) {
    state.RaceID = null
    state.RaceNPR = false
    state.RaceSpecialNPRID = 0
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
      // Kept out of Vue's reactivity: the reactive wrapper would add its bookkeeping to the connections the instance closes with.
      database = markRaw(cacheQueries(resetDatabase(storagePath)))
    } catch (error) {
      console.error(`Couldn't open ${storagePath}`, error)
      message = error.message.split(/\r?\n/)[0]
    }

    commit('replaceDatabase', { database })
    commit('setDatabasePath', { databasePath: storagePath })
    commit('setDatabaseError', { message })
    commit('freshness/opened', { at: Date.now() })
    dropQueryCache(previous)
    dispatch('freshness/probe')
    dispatch('capabilities/preflight')

    return retireDatabase(previous)
  },

  // The window shows `path` (the main process has already checked it and made it this window's save): everything of the save it leaves is retired first, in the one step, so nothing of the old save is read under the new one's name. Its queries and connection are closed (`renew` retires the previous copy), the game and race picked, the empire list, the history it settled, what the pages read and how current it was, the history of pages visited, the flags of its folder and the recording lock all go; the file watcher follows `savePath` (utilities/save-watcher.js), and the page shown moves to the Empires page. The new save is then opened as a new copy, as a file change opens one. Resolves once the old connection is closed.
  openSave ({ commit, dispatch }, { path }) {
    commit('clearSelection')
    commit('empires/reset')
    commit('history/reset')
    commit('peeks/reset', null)
    commit('navigation/reset')
    commit('freshness/switched')
    setFlagScope(path)
    commit('setSavePath', { savePath: path })

    const retired = dispatch('renew', { storagePath: path })

    releaseRecording()

    if (this.$router && this.$router.currentRoute.path !== '/') {
      this.$router.push('/', () => {}, () => {})
    }

    return retired
  },

  changeGame ({ commit }, { game, race = null }) {
    commit('empires/dropped', null)
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
