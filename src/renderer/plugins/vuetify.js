import Vue from 'vue'
import Vuetify from 'vuetify'
import 'vuetify/dist/vuetify.min.css'
import 'roboto-fontface/css/roboto/roboto-fontface.css'
import 'roboto-fontface/css/roboto-condensed/roboto-condensed-fontface.css'
import '../styles/appearance.scss'

import { keyboardControls } from '../components/page/keyboard-controls'
import { activeAppearance, baselinePresetId, resolveAppearance, vuetifyColors } from '../utilities/appearance'

Vue.use(Vuetify)

// A single autocomplete empties its value when its search text is emptied by typing or Backspace, `clearable` or not (Vuetify 2's `onInput` and `onKeyDown` call `deleteCurrentItem`): the field then reads blank while the page still holds the choice, and a handler of a picker with no null choice is handed null. Only a `clearable` one has a null choice, so the others keep the choice. On leaving the field Vuetify puts the words of the choice back only for a choice with a truthy value (`updateSelf`), so a choice whose value is null or 0 stayed blank: a single one restores the words of whatever it holds. A multiple one is unchanged. `resetPick` is for a picker that acts on a pick (adds a missile, copies a speed) and then starts over empty, with the focus kept in the same input and no change event: it empties the value and the search once Vuetify's own `setSearch` after the pick has run, which is two ticks on.
const VAutocomplete = Vue.options.components.VAutocomplete

Vue.component('VAutocomplete', VAutocomplete.extend({
  methods: {
    deleteCurrentItem() {
      if (this.multiple || this.clearable) {
        VAutocomplete.options.methods.deleteCurrentItem.call(this)
      }
    },
    updateSelf() {
      if (this.multiple || !this.selectedItems.length) {
        VAutocomplete.options.methods.updateSelf.call(this)
      } else {
        this.setSearch()
      }
    },
    resetPick() {
      this.$nextTick(() => this.$nextTick(() => {
        this.lazyValue = null
        this.internalSearch = null
      }))
    },
  },
}))

Vue.mixin(keyboardControls)

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
