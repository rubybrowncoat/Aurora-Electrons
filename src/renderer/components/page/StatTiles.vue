<template>
  <v-row :dense="dense || compact" :class="{ 'stat-tiles--compact': compact }">
    <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
      <v-card class="stat-tile" elevation="1">
        <div class="caption text--secondary">{{ tile.label }}</div>
        <div class="stat-value" :title="tile.title || tile.value"><v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon><span class="stat-value__text">{{ tile.value }}</span></div>
        <div class="stat-note caption text--secondary" :title="compact ? tile.note : null">{{ tile.note }}</div>
      </v-card>
    </v-col>
  </v-row>
</template>

<script>
// The row of stat tiles that opens a page, four to a row from 1264 px. Each tile is { label, value, note }, with an optional icon (and iconColor) before the value and a title, the value's tooltip, which is the value itself unless given. The styles are in styles/page-chrome.scss.
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
}
</script>
