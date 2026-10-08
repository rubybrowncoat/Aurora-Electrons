import Vue from 'vue'
import Vuex, { Store } from 'vuex'

import router from './router'

Vue.use(Vuex)

// store/index.js is the root module, and every other file in store/ a namespaced module named after it. Each exports
// `state` (a function), and whichever of `getters`, `mutations` and `actions` it has.
const root = {}
const modules = {}

Object.entries(import.meta.glob('../store/*.js', { eager: true })).forEach(([file, { state, getters, mutations, actions }]) => {
  const name = file.match(/([^/]+)\.js$/)[1]
  const definition = { state, getters, mutations, actions }

  if (name === 'index') {
    Object.assign(root, definition)
  } else {
    modules[name] = { namespaced: true, ...definition }
  }
})

const store = new Store({
  ...root,
  modules,
  // Mutating state outside a mutation throws during development.
  strict: import.meta.env.DEV,
})

// Actions navigate through `this.$router` (store/navigation.js).
store.$router = router

export default store
