import Vue from 'vue'
import * as Sentry from '@sentry/vue'

import './plugins/async-computed'
import './plugins/icons'
import vuetify from './plugins/vuetify'
import database from './plugins/database'
import history from './plugins/history'
import navigation from './plugins/navigation'
import router from './app/router'
import store from './app/store'
import Layout from './layouts/default.vue'

// Only packaged builds report errors: development, web mode and the smoke tests build in other modes.
if (import.meta.env.MODE === 'production') {
  Sentry.init({
    Vue,
    dsn: 'https://8e243eff808fce8ae2da2b27f6eb4ff5@o237971.ingest.us.sentry.io/4510024176893952',
  })
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
