import Vue from 'vue'
import * as Sentry from '@sentry/electron/renderer'
import { init as vueInit } from '@sentry/vue'

import './plugins/async-computed'
import './plugins/icons'
import vuetify from './plugins/vuetify'
import database from './plugins/database'
import history from './plugins/history'
import navigation from './plugins/navigation'
import router from './app/router'
import store from './app/store'
import Layout from './layouts/default.vue'
import './styles/page-chrome.scss'

// Only production builds report errors: development, web mode and the smoke tests build in other modes. They go through the main process (src/main/sentry.js), which adds the release and the app's context.
if (import.meta.env.MODE === 'production') {
  Sentry.init({ Vue }, vueInit)
}

// Before the app mounts, so the race guard in plugins/navigation.js sees the first navigation too.
;[database, history, navigation].forEach((plugin) => plugin({ router, store }))

// The root instance, which the smoke tests drive (`window.$app.$router`, `.$store`, `.$vuetify`).
window.$app = new Vue({
  router,
  store,
  vuetify,
  render: (h) => h(Layout),
}).$mount('#app')
