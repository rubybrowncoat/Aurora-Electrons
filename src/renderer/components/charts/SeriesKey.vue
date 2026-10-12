<template>
  <svg class="series-key" :width="width" height="12" :viewBox="`0 0 ${width} 12`" aria-hidden="true" focusable="false">
    <template v-if="kind === 'bar'">
      <defs v-if="textured">
        <pattern :id="patternId" :width="size" :height="size" patternUnits="userSpaceOnUse">
          <rect :width="size" :height="size" :fill="color" />
          <g :stroke="surface" :fill="surface" opacity="0.75" :stroke-width="stroke">
            <template v-for="(shape, index) in identity.primitives">
              <line v-if="shape[0] === 'line'" :key="index" :x1="shape[1]" :y1="shape[2]" :x2="shape[3]" :y2="shape[4]" fill="none" />
              <polyline v-else-if="shape[0] === 'poly'" :key="index" :points="shape.slice(1).join(' ')" fill="none" />
              <circle v-else-if="shape[0] === 'circle'" :key="index" :cx="shape[1]" :cy="shape[2]" :r="shape[3]" stroke="none" />
              <rect v-else :key="index" :x="shape[1]" :y="shape[2]" :width="shape[3]" :height="shape[4]" stroke="none" />
            </template>
          </g>
        </pattern>
      </defs>
      <rect x="0" y="1" :width="width" height="10" rx="1.5" :fill="textured ? `url(#${patternId})` : color" />
    </template>
    <template v-else>
      <line v-if="kind === 'line'" x1="0" y1="6" :x2="width" y2="6" :stroke="color" stroke-width="2" :stroke-dasharray="dashArray" />
      <path v-if="identity" :d="identity.markerPath" :transform="`translate(${width / 2} 6) scale(${kind === 'line' ? 0.75 : 0.9})`" :fill="identity.color" :stroke="surface" stroke-width="1.6" />
      <circle v-else-if="kind === 'point'" cx="6" cy="6" r="4.6" :fill="color" />
    </template>
  </svg>
</template>

<script>
import { activeAppearance } from '../../utilities/appearance'
import { PATTERN_SIZE, PATTERN_STROKE, seriesIdentity } from './theme'

// The key of a categorical series in a legend: what the chart draws it with, so a reader who cannot tell the colours apart can still match the legend to the chart. `kind` is `bar` (a bar or a stack segment: the series' texture over its colour), `line` (a stretch of the line in its dash, with its marker) or `point` (the marker alone, for a scatter). `dash` is the series' own dash when it brings one. A colour that is none of the nine slots is drawn plain. The name of the series goes beside it as text, so the key is hidden from assistive technology.
export default {
  name: 'SeriesKey',
  props: {
    color: { type: String, required: true },
    kind: { type: String, default: 'bar', validator: (value) => ['bar', 'line', 'point'].includes(value) },
    dash: { type: Array, default: null },
  },
  computed: {
    appearance () {
      return activeAppearance()
    },
    identity () {
      return seriesIdentity(this.appearance, this.color)
    },
    textured () {
      return !!this.identity && this.identity.primitives.length > 0
    },
    surface () {
      return this.appearance.surfaces.card
    },
    width () {
      return { bar: 14, line: 26, point: 12 }[this.kind]
    },
    size: () => PATTERN_SIZE,
    stroke: () => PATTERN_STROKE,
    patternId () {
      return `series-key-${this._uid}`
    },
    dashArray () {
      const dash = this.dash && this.dash.length ? this.dash : this.identity && this.identity.dash

      return dash && dash.length ? dash.join(' ') : null
    },
  },
}
</script>

<style scoped>
.series-key {
  flex: none;
  margin-right: 6px;
}
</style>
