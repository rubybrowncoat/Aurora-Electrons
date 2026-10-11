import { needsRace, pageByRoute } from '../utilities/navigation'

const HISTORY_MENU_LENGTH = 12
// How many entries the app bar's trail shows before and after the current page.
const TRAIL_BEHIND = 7
const TRAIL_AHEAD = 3

// The pages visited this session, as the browser's back/forward list would keep them, plus the last page used in each section and `lastRacePage`, the last one that showed a race's data, which the Empires page opens after a pick. `entries` holds full paths. `pending` is the entry index a back, forward or jump is navigating to, so `settle` can tell it from a fresh visit. `replacing` marks a router replace, which a page makes when its focus changes (mixins/deep-link.js) and which updates the current entry instead of adding one. `labels` names what each full path shows, such as the system a map entry is on.
export const state = () => {
  return {
    entries: [],
    index: -1,
    pending: null,
    replacing: false,
    labels: {},
    lastInSection: {},
    lastRacePage: null,
  }
}

const walk = (state, step, reachable) => {
  const list = []

  for (let index = state.index + step; index >= 0 && index < state.entries.length && list.length < HISTORY_MENU_LENGTH; index += step) {
    const path = state.entries[index]

    list.push({ index, path, label: state.labels[path] || null, disabled: !reachable(path) })
  }

  return list
}

const basePath = (path) => path.split('?')[0]

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
  // The entries around the current one, as the trail shows them: [{ index, path, label, disabled }].
  trail (state, getters) {
    const from = Math.max(0, state.index - TRAIL_BEHIND)

    return state.entries.slice(from, state.index + TRAIL_AHEAD + 1).map((path, offset) => ({ index: from + offset, path, label: state.labels[path] || null, disabled: !getters.reachable(path) }))
  },
  // Distinct pages visited before the current one, most recent first, as routes without their queries.
  recents (state) {
    const current = state.index < 0 ? null : basePath(state.entries[state.index])

    return [...new Set(state.entries.slice(0, state.index).reverse().map(basePath))].filter((path) => path !== current)
  },
}

const remember = (state, path) => {
  const page = pageByRoute[basePath(path)]

  if (page && page.section) {
    state.lastInSection = { ...state.lastInSection, [page.section]: path }
  }

  if (page && !page.noRace) {
    state.lastRacePage = path
  }
}

const visit = (state, path) => {
  if (state.entries[state.index] === path) {
    return
  }

  state.entries = [...state.entries.slice(0, state.index + 1), path]
  state.index = state.entries.length - 1
}

// The current entry now shows `path`. When that makes it the same as the entry before or after it, the two become one.
const replace = (state, path) => {
  if (state.index < 0) {
    visit(state, path)

    return
  }

  const entries = [...state.entries]

  entries[state.index] = path

  if (entries[state.index - 1] === path) {
    entries.splice(state.index, 1)
    state.index -= 1
  } else if (entries[state.index + 1] === path) {
    entries.splice(state.index, 1)
  }

  state.entries = entries
}

export const mutations = {
  // Called from the router's afterEach: a replace updates the current entry, a navigation the store asked for lands on its entry, any other is a new visit.
  settle (state, path) {
    if (state.replacing) {
      state.replacing = false
      replace(state, path)
    } else if (state.pending === null) {
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
  expectReplace (state, replacing) {
    state.replacing = replacing
  },
  label (state, { path, label }) {
    if ((state.labels[path] || null) !== (label || null)) {
      state.labels = { ...state.labels, [path]: label || null }
    }
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
    // The app's router returns no promise (app/router.js), so a push that aborts reports through the callback.
    this.$router.push(state.entries[target], () => {}, () => commit('expect', null))
  },
  back ({ state, dispatch }) {
    dispatch('jump', state.index - 1)
  },
  forward ({ state, dispatch }) {
    dispatch('jump', state.index + 1)
  },
}
