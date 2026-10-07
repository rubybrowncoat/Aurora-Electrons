import { thousandsSeparator } from '../utilities/math'
import { peeks } from '../utilities/peeks'

// The lines under each page in the section flyout (utilities/peeks.js), `lines[route]` being a string, or null when
// the peek has nothing to say or failed. They last for one database instance, game, race, history revision and
// separator setting: a save change (the app replaces the database), a race switch or a recorded snapshot starts over.
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
  async load ({ state, commit, rootState, rootGetters }, routes) {
    const { database, GameID, RaceID } = rootState

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

        if (state.key === key) {
          commit('set', { route, line })
        }
      } catch (error) {
        console.warn(`Menu line for ${route} failed`, error)

        if (state.key === key) {
          commit('set', { route, line: null })
        }
      } finally {
        loading.delete(id)
      }
    }))
  },
}
