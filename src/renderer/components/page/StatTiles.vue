<template>
  <v-row :dense="dense || compact" :class="{ 'stat-tiles--compact': compact }">
    <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
      <v-card class="stat-tile" :class="{ 'stat-tile--selectable': tile.selectable, 'stat-tile--active': tile.selectable && tile.active }" :style="tile.selectable ? { '--stat-tile-accent': accentOf(tile) } : null" :ripple="false" elevation="1" v-bind="tile.selectable ? { role: 'button', tabindex: 0, 'aria-pressed': String(Boolean(tile.active)), title: tile.selectTitle } : {}" v-on="tile.selectable ? selectListeners(tile) : {}">
        <div class="caption text--secondary">{{ tile.label }}</div>
        <div class="stat-value" :title="tile.title || tile.value"><v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon><span class="stat-value__text">{{ tile.value }}</span></div>
        <div class="stat-note caption text--secondary" :title="compact ? tile.note : null">{{ tile.note }}</div>
      </v-card>
    </v-col>
  </v-row>
</template>

<script>
// The row of stat tiles that opens a page, four to a row from 1264 px. Each tile is { label, value, note }, with an optional icon (and iconColor, a theme colour name or a CSS colour) before the value and a title, the value's tooltip, which is the value itself unless given. A tile with `selectable` is a toggle button in its icon's colour: a click, Enter or Space emits `select` with the tile, `active` shows it pressed, and `selectTitle` is its tooltip. The styles are in styles/page-chrome.scss.
export default {
  name: 'StatTiles',
  props: {
    tiles: {
      type: Array,
      required: true,
    },
    dense: {
      type: Boolean,
      default: false,
    },
    // Shorter tiles with the note cut at two lines; implies dense.
    compact: {
      type: Boolean,
      default: false,
    },
  },
  methods: {
    // The colour a selectable tile is drawn in: its icon's, a theme colour resolved for the current theme, or the primary colour without one.
    accentOf(tile) {
      const color = tile.iconColor

      return (color && this.$vuetify.theme.currentTheme[color]) || color || 'var(--ae-primary)'
    },
    selectListeners(tile) {
      return {
        click: () => this.$emit('select', tile),
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            this.$emit('select', tile)
          }
        },
      }
    },
  },
}
</script>
