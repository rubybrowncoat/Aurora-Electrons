import { thousandsSeparator } from '../utilities/math'
import { peeks } from '../utilities/peeks'

// The lines under each page in the section flyout (utilities/peeks.js), `lines[route]` being a string, or null when the peek has nothing to say or failed. They last for one database instance, game, race, history revision and separator setting: a save change (the app replaces the database), a race switch or a recorded snapshot starts over.
export const state = () => {
  return {
    key: null,
    lines: {},
  }
}

export const mutations = {
  reset (state, key) {
    state.key = key
    state.lines = {}
  },
  set (state, { route, line }) {
    state.lines = { ...state.lines, [route]: line }
  },
}

export const getters = {
  // The lines the flyout shows: none while the copy now open is refused (store/capabilities.js), whenever the refusal came: a retry of the check can refuse the copy after lines were published for it. The lines stay in the state, and show again for a copy that is not refused.
  visible (state, _getters, _rootState, rootGetters) {
    return rootGetters['capabilities/refused'] ? {} : state.lines
  },
}

const databaseIds = new WeakMap()
const loading = new Set()
let databaseCount = 0

const databaseId = (database) => {
  if (!databaseIds.has(database)) {
    databaseIds.set(database, ++databaseCount)
  }

  return databaseIds.get(database)
}

export const actions = {
  // Run the peeks of `routes` that aren't cached or already running. Never rejects: a failing peek logs and leaves its line empty.
  async load ({ state, commit, dispatch, rootState, rootGetters }, routes) {
    // The capability check of the copy answers first (it never rejects, and a copy already checked answers at once): whether the save is refused is not known before. The module is namespaced, so the root action is reached with `{ root: true }`.
    await dispatch('capabilities/preflight', null, { root: true })

    const { database, GameID, RaceID } = rootState

    // A refused save (store/capabilities.js) shows no line, and none of an earlier copy stays.
    if (rootGetters['capabilities/refused']) {
      if (state.key !== null) {
        commit('reset', null)
      }

      return
    }

    if (!database || !RaceID) {
      return
    }

    const separator = thousandsSeparator(rootGetters.config.get('selectedSeparator', 'Tick'))
    const key = `${databaseId(database)}:${GameID}:${RaceID}:${rootState.history.revision}:${separator}`

    if (key !== state.key) {
      commit('reset', key)
    }

    const context = {
      database,
      GameID,
      RaceID,
      separator,
      StartYear: rootState.StartYear,
      historyRecorded: rootGetters.historyRecorded,
      snapshotSummary: rootGetters['history/snapshotSummary'],
    }

    await Promise.all(routes.filter((route) => peeks[route] && !(route in state.lines) && !loading.has(`${key}|${route}`)).map(async (route) => {
      const id = `${key}|${route}`

      loading.add(id)

      try {
        const line = await peeks[route](context)

        if (state.key === key && !rootGetters['capabilities/refused']) {
          commit('set', { route, line })
        }
      } catch (error) {
        console.warn(`Menu line for ${route} failed`, error)

        if (state.key === key && !rootGetters['capabilities/refused']) {
          commit('set', { route, line: null })
        }
      } finally {
        loading.delete(id)
      }
    }))
  },
}
