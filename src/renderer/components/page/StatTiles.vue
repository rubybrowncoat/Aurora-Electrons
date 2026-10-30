<template>
  <v-row :dense="dense || compact" :class="{ 'stat-tiles--compact': compact, 'stat-tiles--fit': fit }">
    <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
      <v-card class="stat-tile" :class="{ 'stat-tile--selectable': tile.selectable, 'stat-tile--active': tile.selectable && tile.active }" :style="tile.selectable ? { '--stat-tile-accent': accentOf(tile) } : null" :ripple="false" elevation="1" v-bind="tile.selectable ? { role: 'button', tabindex: 0, 'aria-pressed': String(Boolean(tile.active)), title: tile.selectTitle } : {}" v-on="tile.selectable ? selectListeners(tile) : {}">
        <v-icon v-if="tile.selectable && tile.active" small class="stat-tile__pressed" aria-hidden="true">mdi-check-circle</v-icon>
        <div class="caption text--secondary">{{ tile.label }}</div>
        <div class="stat-value" :title="tile.title || tile.value"><v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon><span class="stat-value__text" :data-tile="tile.hook">{{ tile.value }}</span><provenance-mark v-if="tile.result || tile.rule" :result="tile.result || null" :rule="tile.rule || ''" /></div>
        <div class="stat-note caption text--secondary" :title="compact ? noteText(tile.note) : null" :data-tile-note="tile.hook"><template v-if="Array.isArray(tile.note)"><span v-for="(piece, index) in tile.note" :key="index" :data-part="piece.part">{{ piece.text }}</span></template><template v-else>{{ tile.note }}</template></div>
      </v-card>
    </v-col>
  </v-row>
</template>

<script>
import { activeAppearance, vuetifyColors } from '../../utilities/appearance'
import ProvenanceMark from './ProvenanceMark.vue'

// The row of stat tiles that opens a page, four to a row from 1264 px, or with `fit` every tile on one line while each keeps a minimum width. Each tile is { label, value, note }, with an optional icon (and iconColor, a theme colour name or a CSS colour) before the value and a title, the value's tooltip, which is the value itself unless given. A note is text, or a list of pieces ({ text, part }) drawn in a row, a piece with `part` in an element with that `data-part`, the role a page check finds a figure of the note by. A tile with `hook` gives its value that `data-tile` and its note that `data-tile-note`, the role a page check finds them by. A tile with `result` (a provenance envelope) or `rule` (a registered rule id) shows that mark after its value. A tile with `selectable` is a toggle button in its icon's colour: a click, Enter or Space emits `select` with the tile, `active` shows it pressed (a border, a wash and a check), and `selectTitle` is its tooltip. The styles are in styles/page-chrome.scss.
export default {
  name: 'StatTiles',
  components: { ProvenanceMark },
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
    // Every tile on one line while each keeps a minimum width, in even columns when they wrap, in place of four to a row from 1264 px.
    fit: {
      type: Boolean,
      default: false,
    },
  },
  methods: {
    // The colour a selectable tile is drawn in: its icon's, a theme colour name resolved from the appearance in force, or the primary colour without one.
    accentOf(tile) {
      const color = tile.iconColor

      return (color && vuetifyColors(activeAppearance())[color]) || color || 'var(--ae-primary)'
    },
    // A note as one line of text: the text of its pieces in order.
    noteText(note) {
      return Array.isArray(note) ? note.map((piece) => piece.text).join('') : note
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
