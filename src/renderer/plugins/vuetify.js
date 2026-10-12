import Vue from 'vue'
import Vuetify from 'vuetify'
import 'vuetify/dist/vuetify.min.css'
import 'roboto-fontface/css/roboto/roboto-fontface.css'
import '../styles/appearance.scss'

import { activeAppearance, baselinePresetId, resolveAppearance, vuetifyColors } from '../utilities/appearance'

Vue.use(Vuetify)

const vuetify = new Vuetify({
  theme: {
    dark: false,
    themes: {
      light: vuetifyColors(resolveAppearance(baselinePresetId('light'))),
      dark: vuetifyColors(resolveAppearance(baselinePresetId('dark'))),
    },
  },
})

// Vuetify's theme follows the appearance in force: the colours of its mode, then that mode.
new Vue().$watch(activeAppearance, (appearance) => {
  const { theme } = vuetify.framework

  theme.setTheme(appearance.mode, vuetifyColors(appearance))
  theme.dark = appearance.mode === 'dark'
}, { immediate: true })

export default vuetify
