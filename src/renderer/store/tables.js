export const state = () => {
  return {
    habitabilityItemsPerPage: 10,
    habitabilitySortBy: [],
    habitabilitySortDescending: [false],
    mineralsItemsPerPage: 10,
    mineralsSortBy: [],
    mineralsSortDescending: [false],
  }
}

export const mutations = {
  setHabitabilityItemsPerPage (state, value) {
    state.habitabilityItemsPerPage = value
  },
  setHabitabilitySortBy (state, value) {
    state.habitabilitySortBy = Array.isArray(value) ? [...value] : value
  },
  setHabitabilitySortDescending (state, value) {
    state.habitabilitySortDescending = Array.isArray(value) ? [...value] : value
  },
  setMineralsItemsPerPage (state, value) {
    state.mineralsItemsPerPage = value
  },
  setMineralsSortBy (state, value) {
    state.mineralsSortBy = Array.isArray(value) ? [...value] : value
  },
  setMineralsSortDescending (state, value) {
    state.mineralsSortDescending = Array.isArray(value) ? [...value] : value
  },
}

export const actions = {
  resetHabitabilityTableSettings ({ commit }) {
    commit('setHabitabilityItemsPerPage', 10)
    commit('setHabitabilitySortBy', [])
    commit('setHabitabilitySortDescending', [false])
  },
  resetMineralsTableSettings ({ commit }) {
    commit('setMineralsItemsPerPage', 10)
    commit('setMineralsSortBy', [])
    commit('setMineralsSortDescending', [false])
  },
}
