<template>
  <div class="history-buttons">
    <v-tooltip v-for="direction in directions" :key="direction.key" bottom open-delay="300" :disabled="menu.open">
      <template #activator="{ on, attrs }">
        <v-btn icon :disabled="!direction.entries.length || direction.entries[0].disabled" v-bind="attrs" v-on="on" @click="jump(direction.entries[0].index)" @contextmenu.prevent="openMenu($event, direction.key)">
          <v-icon>{{ direction.icon }}</v-icon>
        </v-btn>
      </template>
      <span>{{ direction.label }}{{ direction.entries.length ? ` to ${direction.entries[0].title}` : '' }} · {{ direction.shortcut }}</span>
    </v-tooltip>

    <v-menu v-model="menu.open" :position-x="menu.x" :position-y="menu.y" absolute offset-y>
      <v-list dense min-width="240">
        <v-subheader>{{ menu.direction === 'back' ? 'Back to' : 'Forward to' }}</v-subheader>
        <v-list-item v-for="entry in menuEntries" :key="entry.index" :disabled="entry.disabled" @click="jump(entry.index)">
          <v-list-item-icon class="mr-3">
            <v-icon small :style="entry.style" class="history-buttons__icon">{{ entry.icon }}</v-icon>
          </v-list-item-icon>
          <v-list-item-title>{{ entry.title }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<script>
import { mapActions, mapGetters } from 'vuex'

import { pageByRoute, sectionById } from '../../utilities/navigation'
import { sectionStyle } from './section-style'

export default {
  data () {
    return {
      menu: { open: false, x: 0, y: 0, direction: 'back' },
    }
  },
  computed: {
    ...mapGetters('navigation', [
      'backEntries',
      'forwardEntries',
    ]),

    directions () {
      return [
        { key: 'back', label: 'Back', icon: 'mdi-arrow-left', shortcut: 'Alt ←', entries: this.describe(this.backEntries) },
        { key: 'forward', label: 'Forward', icon: 'mdi-arrow-right', shortcut: 'Alt →', entries: this.describe(this.forwardEntries) },
      ]
    },
    menuEntries () {
      return this.directions.find(({ key }) => key === this.menu.direction).entries
    },
  },
  methods: {
    ...mapActions('navigation', [
      'jump',
    ]),

    describe (entries) {
      return entries.map(({ index, path, disabled }) => {
        const page = pageByRoute[path.split('?')[0]]

        return { index, disabled, title: page.title, icon: page.icon, style: sectionStyle(this.$vuetify.theme.dark, sectionById[page.section]) }
      })
    },

    openMenu (event, direction) {
      const [nearest] = this.directions.find(({ key }) => key === direction).entries

      if (!nearest || nearest.disabled) {
        return
      }

      this.menu = { open: false, x: event.clientX, y: event.clientY, direction }
      this.$nextTick(() => {
        this.menu.open = true
      })
    },
  },
}
</script>

<style lang="scss" scoped>
.history-buttons {
  display: flex;
  align-items: center;
  gap: 2px;
}

.history-buttons__icon {
  color: var(--sc) !important;
}
</style>
