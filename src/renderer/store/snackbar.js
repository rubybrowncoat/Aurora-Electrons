export const state = () => {
  return {
    active: false,

    text: 'Action Successful',
    color: 'success',
  }
}

export const mutations = {
  setActive (state, status) {
    state.active = status
  },

  setText (state, text) {
    state.text = text
  },

  setColor (state, color) {
    state.color = color
  },
}

export const actions = {
  activateSnackbar ({ commit }, snackbar = {}) {
    if (Object.prototype.hasOwnProperty.call(snackbar, 'text')) {
      commit('setText', snackbar.text)
    }

    if (Object.prototype.hasOwnProperty.call(snackbar, 'color')) {
      commit('setColor', snackbar.color)
    }

    commit('setActive', true)
  },
}
