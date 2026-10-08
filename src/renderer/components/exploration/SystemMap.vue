<template>
  <svg class="system-map" :style="{ height }" :viewBox="frame.viewBox" preserveAspectRatio="xMidYMid meet" role="img" :aria-label="ariaLabel">
    <g :stroke="theme.border" :stroke-width="frame.unit * 0.9">
      <line v-for="link in drawnLinks" :key="link.key" :x1="link.x1" :y1="link.y1" :x2="link.x2" :y2="link.y2" />
    </g>
    <polyline v-if="routePoints" :points="routePoints" fill="none" :stroke="routeColor || theme.primary" :stroke-width="frame.unit * 4" stroke-linecap="round" stroke-linejoin="round" />
    <g v-for="node in placed" :key="node.SystemID" class="system-map__node" @click="$emit('select', node.SystemID)">
      <title>{{ node.title }}</title>
      <circle :cx="node.Xcor" :cy="node.Ycor" :r="frame.unit * node.size" :fill="node.color" :stroke="node.SystemID === selected ? theme.primary : theme.surface" :stroke-width="frame.unit * (node.SystemID === selected ? 3 : 1)" />
      <circle v-if="node.ring" :cx="node.Xcor" :cy="node.Ycor" :r="frame.unit * (node.size + 4)" fill="none" :stroke="node.ring" :stroke-width="frame.unit * 1.5" />
      <text v-if="node.label" :x="node.Xcor" :y="node.Ycor - frame.unit * (node.size + 5)" :font-size="frame.unit * 11" text-anchor="middle" :fill="theme.ink">{{ node.Name }}</text>
    </g>
  </svg>
</template>

<script>
import { chartTheme } from '../charts/theme'

// The known systems at their places on the game's galactic map (FCT_RaceSysSurvey.Xcor/Ycor), joined by
// their jump links. Sizes and strokes are in screen pixels: the map works out how many map units one pixel
// is, so nodes and labels keep their size whatever the galaxy's extent. Nodes draw in the order given, so
// put the ones that matter last.
export default {
  name: 'SystemMap',
  props: {
    // [{ SystemID, Name, Xcor, Ycor, size (radius, px), color, ring (a colour, or null), label (show the name), title (hover text) }]
    systems: { type: Array, required: true },
    // [{ SystemID, DestinationID }], one per jump point; each pair of known systems is drawn once.
    links: { type: Array, default: () => [] },
    // SystemIDs in travel order, drawn as a line under the nodes.
    route: { type: Array, default: () => [] },
    routeColor: { type: String, default: null },
    selected: { type: Number, default: null },
    ariaLabel: { type: String, default: 'Known systems' },
    // 480 px at 1280 x 720, 780 at 1080p, and it keeps growing to 1000 so a 1440p window isn't left with a small map in the middle.
    height: { type: String, default: 'clamp(480px, calc(100vh - 300px), 1000px)' },
  },
  computed: {
    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    placed() {
      return this.systems.filter((system) => system.Xcor !== null && system.Ycor !== null)
    },

    byId() {
      return Object.fromEntries(this.placed.map((system) => [system.SystemID, system]))
    },

    frame() {
      if (!this.placed.length) {
        return { viewBox: '0 0 100 100', unit: 1 }
      }

      const xs = this.placed.map((system) => system.Xcor)
      const ys = this.placed.map((system) => system.Ycor)
      const width = Math.max(...xs) - Math.min(...xs) || 100
      const height = Math.max(...ys) - Math.min(...ys) || 100
      // About one screen pixel in map units (the map is drawn up to ~1100 x 600 px).
      const unit = Math.max(width / 1100, height / 560)
      const pad = unit * 30

      return { viewBox: `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${width + 2 * pad} ${height + 2 * pad}`, unit }
    },

    drawnLinks() {
      const seen = new Set()
      const drawn = []

      this.links.forEach((link) => {
        const key = [link.SystemID, link.DestinationID].sort((a, b) => a - b).join('-')
        const from = this.byId[link.SystemID]
        const to = this.byId[link.DestinationID]

        if (from && to && !seen.has(key)) {
          seen.add(key)
          drawn.push({ key, x1: from.Xcor, y1: from.Ycor, x2: to.Xcor, y2: to.Ycor })
        }
      })

      return drawn
    },

    routePoints() {
      const points = this.route.map((id) => this.byId[id]).filter(Boolean)

      return points.length > 1 ? points.map((system) => `${system.Xcor},${system.Ycor}`).join(' ') : null
    },
  },
}
</script>

<style lang="scss">
.system-map {
  display: block;
  width: 100%;
}

.system-map__node {
  cursor: pointer;
}

.system-map__node text {
  pointer-events: none;
  font-family: Roboto, 'Helvetica Neue', Arial, sans-serif;
}
</style>
