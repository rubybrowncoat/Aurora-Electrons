import Vue from 'vue'
import * as Sentry from '@sentry/electron/renderer'
import { init as vueInit, vueIntegration } from '@sentry/vue'

import './plugins/async-computed'
import './plugins/icons'
import './plugins/truncated-text'
import vuetify from './plugins/vuetify'
import database from './plugins/database'
import history from './plugins/history'
import navigation from './plugins/navigation'
import router from './app/router'
import store from './app/store'
import Layout from './layouts/default.vue'
import './styles/page-chrome.scss'
import { connectReporting } from './utilities/reporting'

// Main grants consent and owns egress for every process. A revoked renderer is never re-enabled before restart.
connectReporting((state) => {
  if (state.enabled && !Sentry.getClient()) {
    Sentry.init({
      Vue,
      defaultIntegrations: false,
      integrations: [Sentry.globalHandlersIntegration(), vueIntegration()],
      autoSessionTracking: false,
      enableLogs: false,
      enableMetrics: false,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracePropagationTargets: [],
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
      beforeBreadcrumb: () => null,
      beforeSend: (event) => state.enabled ? event : null,
    }, vueInit)
  } else if (!state.enabled && Sentry.getClient()) {
    Sentry.getClient().getOptions().enabled = false
  }
})

// Before the app mounts, so the race guard in plugins/navigation.js sees the first navigation too.
;[database, history, navigation].forEach((plugin) => plugin({ router, store }))

// The root instance, which the smoke tests drive (`window.$app.$router`, `.$store`, `.$vuetify`).
window.$app = new Vue({
  router,
  store,
  vuetify,
  render: (h) => h(Layout),
}).$mount('#app')
