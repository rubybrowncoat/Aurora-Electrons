import { loadEmpires, loadSelection } from '../utilities/empires'
import { failureWords } from '../utilities/provenance'

// Every game in the save with its races (`loadEmpires`), for the rail's Empires entry and flyout and the Empires page. `error` says why the last read failed, null when it didn't; a failed read keeps the games read before it. `loaded` is set by a read that finished, so an empty list can tell "no games in the save" from "not read yet". `dropped` says what the latest read of a reloaded save removed from the selection ({ kind: 'game' | 'race', GameID, RaceID, name, at }), null when it removed nothing or the person has picked since.
export const state = () => {
  return {
    games: [],
    error: null,
    loaded: false,
    dropped: null,
  }
}

export const mutations = {
  // The window shows another save: the list of the one it left is dropped and a read still running for it is not taken.
  reset (state) {
    latest++
    state.games = []
    state.error = null
    state.loaded = false
    state.dropped = null
    readFor = null
  },
  dropped (state, dropped) {
    state.dropped = dropped
  },
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

// Reads are numbered, so one overtaken by a newer read (the save replaced mid-read, the NPR setting flipped) is dropped, and so is one whose database is no longer the open one.
let latest = 0
// The database the list was last read from: a read of another database is a reload of the save (or a new save), and the selection is reconciled with it; one of the same database (the NPR setting flipped) is not.
let readFor = null

export const actions = {
  // Read the list again from the current save, with NPRs as the `spyNPR` setting says. Never rejects.
  async load ({ commit, dispatch, state, rootState, rootGetters }) {
    const read = ++latest
    const { database } = rootState

    try {
      const games = database ? await loadEmpires(database, rootGetters.config.get('spyNPR', false)) : []

      if (read === latest && rootState.database === database) {
        const before = state.games

        commit('read', games)

        if (database && readFor !== database) {
          readFor = database

          if (!(await dispatch('reconcile', { before, database }))) {
            // The save was not asked, so the selection was not checked: the next read of this copy checks it.
            readFor = null
          }
        }
      }
    } catch (error) {
      if (read === latest && rootState.database === database) {
        console.error("Couldn't read the empire list", error)
        commit('failed', failureWords(error))
      }
    }
  },

  // The save was read again (`database` is the copy it was read from) and the game and race picked are checked against what the save holds of them (`loadSelection`, not the list, which leaves out a game with no race to show): a game that is gone clears the selection, a race that is gone clears the race and keeps the game, and neither is ever swapped for another game or race (a game with a single race left still waits for a pick). What was derived from the selection goes with it: the page shown, what the flyout previewed and the page trail. A selection still there takes the game's clocks and the race's kind as the save now gives them. A read that failed, or that came back after the copy or the selection had moved on, changes nothing, since a save that could not be asked says nothing about what it holds. Resolves true once the selection has been checked (or there was none), false when it could not be.
  async reconcile ({ commit, rootState }, { before, database }) {
    const { GameID, RaceID } = rootState

    if (GameID === null) {
      return true
    }

    let found = null

    try {
      found = await loadSelection(database, GameID, RaceID)
    } catch (error) {
      if (rootState.database === database) {
        console.error("Couldn't check the game and race picked against the save", error)
      }

      return false
    }

    if (rootState.database !== database || rootState.GameID !== GameID || rootState.RaceID !== RaceID) {
      return true
    }

    const { game, race } = found

    if (game && (RaceID === null || race)) {
      if (game.StartYear !== rootState.StartYear || game.GameTime !== rootState.GameTime) {
        commit('setGameTime', game, { root: true })
      }

      if (game.CivilianShippingLinesActive !== rootState.CivilianShippingLinesActive) {
        commit('setCivilianShippingLinesActive', game, { root: true })
      }

      if (race && (race.NPR !== rootState.RaceNPR || race.SpecialNPRID !== rootState.RaceSpecialNPRID)) {
        commit('setRace', race, { root: true })
      }

      return true
    }

    const was = before.find((one) => one.GameID === GameID)
    const wasRace = was && was.Races.find((one) => one.RaceID === RaceID)

    if (game) {
      commit('clearRace', null, { root: true })
    } else {
      commit('clearSelection', null, { root: true })
    }

    commit('dropped', { kind: game ? 'race' : 'game', GameID, RaceID: game ? RaceID : null, name: game ? (wasRace ? wasRace.RaceTitle : null) : (was ? was.GameName : null), at: Date.now() })
    commit('peeks/reset', null, { root: true })
    commit('navigation/reset', undefined, { root: true })

    if (this.$router && this.$router.currentRoute.path !== '/') {
      this.$router.push('/', () => {}, () => {})
    }

    return true
  },
}
