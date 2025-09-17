export const state = () => {
  return {
    showResearches: true,
    showProductions: true,
    showShipyards: true,
    showShips: true,
    showTrainings: true,
    showTerraformings: true,

    showQueues: true,
  }
}

export const mutations = {
  setShowResearches (state, value) {
    state.showResearches = value
  },
  setShowProductions (state, value) {
    state.showProductions = value
  },
  setShowShipyards (state, value) {
    state.showShipyards = value
  },
  setShowShips (state, value) {
    state.showShips = value
  },
  setShowTrainings (state, value) {
    state.showTrainings = value
  },
  setShowTerraformings (state, value) {
    state.showTerraformings = value
  },

  setShowQueues (state, value) {
    state.showQueues = value
  },
}

export const actions = {
  resetProductionFilters ({ commit }) {
    commit('setShowResearches', true)
    commit('setShowProductions', true)
    commit('setShowShipyards', true)
    commit('setShowShips', true)
    commit('setShowTrainings', true)
    commit('setShowTerraformings', true)

    // commit('setShowQueues', true)
  },
}
