import { needsRace, pageByRoute } from '../utilities/navigation'

const HISTORY_MENU_LENGTH = 12
// How many pages the footer's trail shows before and after the current one.
const TRAIL_BEHIND = 7
const TRAIL_AHEAD = 3

// The pages visited this session and the focus each was on, as the browser's back/forward list would keep them, plus the last page used in each section and `lastRacePage`, the last one that showed a race's data, which the Empires page opens after a pick. Each of `entries` is `{ path, seen }`: a full path, so a focus the user moves inside a page is an entry of its own (mixins/deep-link.js), and `seen`, the `clock` tick at which it was last the current entry. `pending` is the entry index a back, forward or jump is navigating to, so `settle` can tell it from a fresh visit. `replacing` marks a router replace, which a page makes while it settles on its focus and which updates the current entry instead of adding one. `labels` names what each full path shows, such as the system a map entry is on.
export const state = () => {
  return {
    entries: [],
    index: -1,
    clock: 0,
    pending: null,
    replacing: false,
    labels: {},
    lastInSection: {},
    lastRacePage: null,
  }
}

const basePath = (path) => path.split('?')[0]

const step = (state, index, getters) => {
  const { path } = state.entries[index]

  return { index, path, label: state.labels[path] || null, disabled: !getters.reachable(path) }
}

const walk = (state, direction, getters) => {
  const list = []

  for (let index = state.index + direction; index >= 0 && index < state.entries.length && list.length < HISTORY_MENU_LENGTH; index += direction) {
    list.push(step(state, index, getters))
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
    return walk(state, -1, getters)
  },
  forwardEntries (state, getters) {
    return walk(state, 1, getters)
  },
  // The pages around the current one, as the trail shows them. A run of entries on one page is one stop, which opens the entry last shown in it: the page as it was when it was left, or as it is now for the current one. [{ key, index, path, label, disabled, now, ahead }]
  trail (state, getters) {
    const runs = []

    state.entries.forEach(({ path, seen }, index) => {
      const run = runs[runs.length - 1]

      if (run && basePath(state.entries[run.last].path) === basePath(path)) {
        run.last = index
        run.shown = seen > state.entries[run.shown].seen ? index : run.shown
      } else {
        runs.push({ first: index, last: index, shown: index })
      }
    })

    const at = runs.findIndex(({ last }) => last >= state.index)

    return runs.slice(Math.max(0, at - TRAIL_BEHIND), at + TRAIL_AHEAD + 1).map(({ first, last, shown }) => {
      const now = first <= state.index && state.index <= last

      return { ...step(state, now ? state.index : shown, getters), key: first, now, ahead: first > state.index }
    })
  },
  // Distinct pages visited before the current one, most recent first, as routes without their queries.
  recents (state) {
    const current = state.index < 0 ? null : basePath(state.entries[state.index].path)

    return [...new Set(state.entries.slice(0, state.index).reverse().map(({ path }) => basePath(path)))].filter((path) => path !== current)
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

const see = (state) => {
  state.clock += 1
  state.entries[state.index].seen = state.clock
}

const visit = (state, path) => {
  if (state.index >= 0 && state.entries[state.index].path === path) {
    return
  }

  state.entries = [...state.entries.slice(0, state.index + 1), { path, seen: 0 }]
  state.index = state.entries.length - 1
}

// The current entry now shows `path`. When that makes it the same as the entry before or after it, the two become one.
const replace = (state, path) => {
  if (state.index < 0) {
    visit(state, path)

    return
  }

  const entries = [...state.entries]
  const same = (index) => entries[index] && entries[index].path === path

  entries[state.index] = { ...entries[state.index], path }

  if (same(state.index - 1)) {
    entries.splice(state.index, 1)
    state.index -= 1
  } else if (same(state.index + 1)) {
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

    see(state)
    remember(state, path)
  },
  moveTo (state, target) {
    state.index = target
    see(state)
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
    const entry = state.entries[target]

    if (target === state.index || !entry || !getters.reachable(entry.path)) {
      return
    }

    // The router drops a push to the page it is already on, so no afterEach would settle it.
    if (entry.path === state.entries[state.index].path) {
      commit('moveTo', target)

      return
    }

    commit('expect', target)
    // The app's router returns no promise (app/router.js), so a push that aborts reports through the callback.
    this.$router.push(entry.path, () => {}, () => commit('expect', null))
  },
  back ({ state, dispatch }) {
    dispatch('jump', state.index - 1)
  },
  forward ({ state, dispatch }) {
    dispatch('jump', state.index + 1)
  },
}
