<template>
  <svg class="map-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="8" cy="8" r="7.25" :fill="hollow ? 'none' : color" :stroke="color" stroke-width="1.5" />
    <path :d="path" :fill="hollow ? color : surface" :transform="transform" />
  </svg>
</template>

<script>
// A mark's glyph as the map draws it round a marker: a disc in the mark's colour with the icon in the surface
// colour, or for the lesser state a ring with the icon in the colour. It is drawn rather than set in the icon
// font, which snaps an icon this small to the text's pixel grid, off the middle of its disc.
//
// `path` is an MDI icon, 24 units square. `offset` moves an icon MDI draws off the middle of its square back
// onto it, in the same units.

// The icon's width of the disc's 16, as the map draws 12 of its 16.
const ICON = 11

export default {
  name: 'MapGlyph',
  props: {
    path: { type: String, required: true },
    color: { type: String, required: true },
    surface: { type: String, required: true },
    hollow: { type: Boolean, default: false },
    offset: { type: Array, default: () => [0, 0] },
  },
  computed: {
    transform() {
      const scale = ICON / 24
      const [x, y] = this.offset

      return `translate(${8 - ICON / 2 + x * scale} ${8 - ICON / 2 + y * scale}) scale(${scale})`
    },
  },
}
</script>

<style lang="scss" scoped>
.map-glyph {
  flex: none;
  vertical-align: middle;
}
</style>
