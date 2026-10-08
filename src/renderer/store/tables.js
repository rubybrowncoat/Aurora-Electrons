export const state = () => {
  return {
    habitabilityItemsPerPage: 10,
    habitabilitySortBy: [],
    habitabilitySortDescending: [false],
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
}

export const actions = {
  resetHabitabilityTableSettings ({ commit }) {
    commit('setHabitabilityItemsPerPage', 10)
    commit('setHabitabilitySortBy', [])
    commit('setHabitabilitySortDescending', [false])
  },
}
