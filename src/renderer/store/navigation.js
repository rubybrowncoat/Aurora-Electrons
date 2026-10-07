import { needsRace, pageByRoute } from '../utilities/navigation'

const HISTORY_MENU_LENGTH = 12
// How many entries the app bar's trail shows before and after the current page.
const TRAIL_BEHIND = 7
const TRAIL_AHEAD = 3

// The pages visited this session, as the browser's back/forward list would keep them, plus the last
// page used in each section. `entries` holds full paths. `pending` is the entry index a back,
// forward or jump is navigating to, so `settle` can tell it from a fresh visit.
export const state = () => {
  return {
    entries: [],
    index: -1,
    pending: null,
    lastInSection: {},
  }
}

const walk = (state, step, reachable) => {
  const list = []

  for (let index = state.index + step; index >= 0 && index < state.entries.length && list.length < HISTORY_MENU_LENGTH; index += step) {
    list.push({ index, path: state.entries[index], disabled: !reachable(state.entries[index]) })
  }

  return list
}

export const getters = {
  // Whether a path can be opened: the pages that show a race's data wait until a race is picked.
  reachable (_state, _getters, _rootState, rootGetters) {
    return (path) => Boolean(rootGetters.RaceID) || !needsRace(path)
  },
  canBack (state) {
    return state.index > 0
  },
  canForward (state) {
    return state.index < state.entries.length - 1
  },
  // Nearest first. `disabled` entries are pages that can't be opened yet.
  backEntries (state, getters) {
    return walk(state, -1, getters.reachable)
  },
  forwardEntries (state, getters) {
    return walk(state, 1, getters.reachable)
  },
  // The entries around the current one, as the trail shows them: [{ index, path, disabled }].
  trail (state, getters) {
    const from = Math.max(0, state.index - TRAIL_BEHIND)

    return state.entries.slice(from, state.index + TRAIL_AHEAD + 1).map((path, offset) => ({ index: from + offset, path, disabled: !getters.reachable(path) }))
  },
  // Distinct pages visited before the current one, most recent first.
  recents (state) {
    const current = state.entries[state.index]

    return [...new Set(state.entries.slice(0, state.index).reverse())].filter((path) => path !== current)
  },
}

const remember = (state, path) => {
  const page = pageByRoute[path.split('?')[0]]

  if (page && page.section) {
    state.lastInSection = { ...state.lastInSection, [page.section]: path }
  }
}

const visit = (state, path) => {
  if (state.entries[state.index] === path) {
    return
  }

  state.entries = [...state.entries.slice(0, state.index + 1), path]
  state.index = state.entries.length - 1
}

export const mutations = {
  // Called from the router's afterEach: a navigation the store asked for lands on its entry, any other is a new visit.
  settle (state, path) {
    if (state.pending === null) {
      visit(state, path)
    } else {
      state.index = state.pending
      state.pending = null
    }

    remember(state, path)
  },
  moveTo (state, target) {
    state.index = target
  },
  expect (state, target) {
    state.pending = target
  },
}

export const actions = {
  jump ({ state, getters, commit }, target) {
    if (target === state.index || !state.entries[target] || !getters.reachable(state.entries[target])) {
      return
    }

    // The router drops a push to the page it is already on, so no afterEach would settle it.
    if (state.entries[target] === state.entries[state.index]) {
      commit('moveTo', target)

      return
    }

    commit('expect', target)
    // Nuxt's router returns no promise, so a push that aborts reports through the callback.
    this.$router.push(state.entries[target], () => {}, () => commit('expect', null))
  },
  back ({ state, dispatch }) {
    dispatch('jump', state.index - 1)
  },
  forward ({ state, dispatch }) {
    dispatch('jump', state.index + 1)
  },
}
