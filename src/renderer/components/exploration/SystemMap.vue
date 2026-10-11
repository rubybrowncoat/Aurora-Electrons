<template>
  <div class="system-map" :style="{ height }">
    <canvas
      ref="canvas"
      class="system-map__canvas"
      :class="{ 'system-map__canvas--dragging': dragging, 'system-map__canvas--over': hoverId !== null }"
      role="img"
      :aria-label="ariaLabel"
      :title="hoverTitle"
      @wheel.prevent="wheel"
      @pointerdown="press"
      @pointermove="move"
      @pointerup="release"
      @pointercancel="cancel"
      @pointerleave="leave"
    />
    <div class="system-map__controls">
      <v-btn icon small aria-label="Zoom in" title="Zoom in" @click="zoomBy(zoomStep)"><v-icon small>mdi-plus</v-icon></v-btn>
      <v-btn icon small aria-label="Zoom out" title="Zoom out" @click="zoomBy(1 / zoomStep)"><v-icon small>mdi-minus</v-icon></v-btn>
      <v-btn icon small aria-label="Fit the map" title="Fit the map" @click="fit"><v-icon small>mdi-fit-to-screen</v-icon></v-btn>
    </div>
  </div>
</template>

<script>
import { chartTheme } from '../charts/theme'
import { wheelZoom } from '../../utilities/map-minimap'
import { placeUnplaced } from '../../utilities/map-placement'

// Screen pixels kept round the systems when the map fits them.
const FIT_PADDING = 30
// The closest the map zooms: this many screen pixels to a map unit, so systems the game placed 140
// units apart end up some 200 pixels apart, whatever the galaxy's extent.
const MAX_PIXELS_PER_UNIT = 1.5
const BUTTON_ZOOM = 1.5
// A press that moves further than this, in screen pixels, pans the map instead of clicking.
const DRAG_PIXELS = 4
// Pixels round a marker that still count as pointing at it, so the smallest stay easy to click.
const HIT_SLACK = 3
const LABEL_FONT = "11px Roboto, 'Helvetica Neue', Arial, sans-serif"
const LABEL_CELL = 64

// The known systems at their places on the game's galactic map (FCT_RaceSysSurvey.Xcor/Ycor), joined by
// their jump links; systems the game left at its centre get a place beside a linked system. The wheel
// zooms round the pointer (faster with Shift), dragging pans, and the buttons zoom or fit the map again.
// Sizes and strokes are in screen pixels whatever the zoom. The map draws on a canvas: as SVG, a few
// thousand systems made every zoom step restyle and lay out the whole drawing for a second or more.
// Nodes draw in the order given, so put the ones that matter last: the last one under the pointer is
// the one clicked, its `title` shows on hover, and its name wins where names would cover each other.
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
  data() {
    return {
      dragging: false,
      hoverId: null,
      zoomStep: BUTTON_ZOOM,
    }
  },
  computed: {
    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    placed() {
      return this.systems.filter((system) => system.Xcor !== null && system.Ycor !== null)
    },

    // Where each placed system is drawn: as saved, with the ones at the game's centre moved beside a
    // linked system (map-placement.js `placeUnplaced`).
    positions() {
      const { placed } = this
      const ids = new Set(placed.map((system) => system.SystemID))
      const neighbours = {}
      const add = (from, to) => {
        neighbours[from] = neighbours[from] || []
        neighbours[from].push(to)
      }

      this.links.forEach(({ SystemID, DestinationID }) => {
        if (ids.has(SystemID) && ids.has(DestinationID)) {
          add(SystemID, DestinationID)
          add(DestinationID, SystemID)
        }
      })

      const rows = placed.map((system) => ({ id: system.SystemID, Xcor: system.Xcor, Ycor: system.Ycor }))
      const saved = Object.fromEntries(placed.map((system) => [system.SystemID, { x: system.Xcor, y: system.Ycor }]))

      return placeUnplaced(rows, saved, neighbours).positions
    },

    nodes() {
      const { positions } = this

      return this.placed.map((system) => ({ ...system, ...positions[system.SystemID] }))
    },

    // The systems' extent, as a string so the view fits again only when it really changes.
    extent() {
      const { nodes } = this

      if (!nodes.length) {
        return '0 0 0 0'
      }

      const xs = nodes.map((node) => node.x)
      const ys = nodes.map((node) => node.y)

      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].join(' ')
    },

    drawnLinks() {
      const { positions } = this
      const seen = new Set()
      const drawn = []

      this.links.forEach((link) => {
        const key = [link.SystemID, link.DestinationID].sort((a, b) => a - b).join('-')
        const from = positions[link.SystemID]
        const to = positions[link.DestinationID]

        if (from && to && !seen.has(key)) {
          seen.add(key)
          drawn.push([from, to])
        }
      })

      return drawn
    },

    routeLine() {
      const { positions } = this
      const points = this.route.map((id) => positions[id]).filter(Boolean)

      return points.length > 1 ? points : null
    },

    hoverTitle() {
      const node = this.hoverId === null ? null : this.nodes.find((candidate) => candidate.SystemID === this.hoverId)

      return node ? node.title : null
    },
  },
  watch: {
    extent() {
      this.fit()
    },
  },
  created() {
    // The view: the map point at the centre, and the zoom, as a multiple of the scale that fits the
    // systems (`fitScale`, screen pixels to a map unit). It changes with every wheel step and drag,
    // so it stays out of Vue's reactivity; `draw` reads it.
    this.view = { x: 0, y: 0, zoom: 1 }
    this.fitScale = 1
    this.size = { width: 0, height: 0 }
    this.pressed = null
    this.frameQueued = false
    this.wheelFactor = 1
    this.wheelAt = null
    // Label widths by name, measured once in LABEL_FONT.
    this.labelWidths = new Map()
  },
  mounted() {
    this.unwatchDrawing = this.$watch(() => [this.nodes, this.drawnLinks, this.routeLine, this.routeColor, this.selected, this.theme], () => this.queueFrame())
    // The first observation comes once the page is laid out, with the canvas's size.
    this.resizeObserver = new ResizeObserver(([entry]) => this.resize(entry.contentRect))
    this.resizeObserver.observe(this.$refs.canvas)
  },
  beforeDestroy() {
    this.resizeObserver.disconnect()
    this.unwatchDrawing()
  },
  methods: {
    resize({ width, height }) {
      if (width && height && (width !== this.size.width || height !== this.size.height)) {
        const first = !this.size.width

        this.size = { width, height }

        if (first) {
          this.fit()
        } else {
          this.fitScale = this.scaleToFit()
          this.draw()
        }
      }
    },

    scaleToFit() {
      const [x1, y1, x2, y2] = this.extent.split(' ').map(Number)
      const { width, height } = this.size

      return Math.max(1e-9, Math.min((width - 2 * FIT_PADDING) / (x2 - x1 || 100), (height - 2 * FIT_PADDING) / (y2 - y1 || 100)))
    },

    maxZoom() {
      return Math.max(1, MAX_PIXELS_PER_UNIT / this.fitScale)
    },

    fit() {
      const [x1, y1, x2, y2] = this.extent.split(' ').map(Number)

      this.fitScale = this.scaleToFit()
      this.view = { x: (x1 + x2) / 2, y: (y1 + y2) / 2, zoom: 1 }
      this.draw()
    },

    // Screen pixels from the canvas's corner for a map point, and back.
    toScreen({ x, y }) {
      const scale = this.fitScale * this.view.zoom

      return { x: (x - this.view.x) * scale + this.size.width / 2, y: (y - this.view.y) * scale + this.size.height / 2 }
    },

    draw() {
      const { canvas } = this.$refs
      const { width, height } = this.size

      if (!canvas || !width || !height) {
        return
      }

      const ratio = window.devicePixelRatio || 1
      const pixelWidth = Math.round(width * ratio)
      const pixelHeight = Math.round(height * ratio)

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }

      const context = canvas.getContext('2d')
      const { theme, selected } = this

      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      context.lineCap = 'round'
      context.lineJoin = 'round'

      context.beginPath()
      this.drawnLinks.forEach(([from, to]) => {
        const a = this.toScreen(from)
        const b = this.toScreen(to)

        context.moveTo(a.x, a.y)
        context.lineTo(b.x, b.y)
      })
      context.strokeStyle = theme.border
      context.lineWidth = 0.9
      context.stroke()

      if (this.routeLine) {
        context.beginPath()
        this.routeLine.forEach((point, index) => {
          const { x, y } = this.toScreen(point)

          if (index) {
            context.lineTo(x, y)
          } else {
            context.moveTo(x, y)
          }
        })
        context.strokeStyle = this.routeColor || theme.primary
        context.lineWidth = 4
        context.stroke()
      }

      const labels = []

      this.nodes.forEach((node) => {
        const { x, y } = this.toScreen(node)
        const reach = node.size + 40

        if (x < -reach || y < -reach || x > width + reach || y > height + reach) {
          return
        }

        const chosen = node.SystemID === selected

        context.beginPath()
        context.arc(x, y, node.size, 0, 2 * Math.PI)
        context.fillStyle = node.color
        context.fill()
        context.strokeStyle = chosen ? theme.primary : theme.surface
        context.lineWidth = chosen ? 3 : 1
        context.stroke()

        if (node.ring) {
          context.beginPath()
          context.arc(x, y, node.size + 4, 0, 2 * Math.PI)
          context.strokeStyle = node.ring
          context.lineWidth = 1.5
          context.stroke()
        }

        if (node.label) {
          labels.push({ name: node.Name, x, y: y - (node.size + 5) })
        }
      })

      context.font = LABEL_FONT
      context.textAlign = 'center'
      context.lineWidth = 3
      context.strokeStyle = theme.surface
      context.fillStyle = theme.ink
      this.placeLabels(context, labels).forEach(({ name, x, y }) => {
        context.strokeText(name, x, y)
        context.fillText(name, x, y)
      })
    },

    // The names go over the systems, the ones of systems drawn last first, each only where it covers no
    // name already placed: zoomed out on a crowded map, only some show, and zooming in brings in the rest.
    // Names already placed are kept in cells of LABEL_CELL pixels, to check only the ones nearby.
    placeLabels(context, labels) {
      const cells = new Map()
      const placed = []
      const cellsOf = ({ x1, y1, x2, y2 }) => {
        const keys = []

        for (let column = Math.floor(x1 / LABEL_CELL); column <= Math.floor(x2 / LABEL_CELL); column += 1) {
          for (let row = Math.floor(y1 / LABEL_CELL); row <= Math.floor(y2 / LABEL_CELL); row += 1) {
            keys.push(`${column} ${row}`)
          }
        }

        return keys
      }

      for (let index = labels.length - 1; index >= 0; index -= 1) {
        const label = labels[index]

        if (!this.labelWidths.has(label.name)) {
          this.labelWidths.set(label.name, context.measureText(label.name).width)
        }

        const half = this.labelWidths.get(label.name) / 2 + 2
        const box = { x1: label.x - half, y1: label.y - 11, x2: label.x + half, y2: label.y + 3 }
        const keys = cellsOf(box)
        const covers = keys.some((key) => (cells.get(key) || []).some((other) => box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2))

        if (!covers) {
          keys.forEach((key) => {
            if (!cells.has(key)) {
              cells.set(key, [])
            }

            cells.get(key).push(box)
          })
          placed.push(label)
        }
      }

      return placed
    },

    queueFrame() {
      if (this.frameQueued) {
        return
      }

      this.frameQueued = true
      requestAnimationFrame(() => {
        this.frameQueued = false

        if (this.wheelAt) {
          this.zoomAt(this.wheelAt, this.wheelFactor)
          this.wheelAt = null
          this.wheelFactor = 1
        }

        this.draw()
      })
    },

    // Zooms by `factor`, keeping the map point under `at` (screen pixels from the canvas's corner) where it is.
    zoomAt(at, factor) {
      const { width, height } = this.size
      const before = this.fitScale * this.view.zoom
      const zoom = Math.min(this.maxZoom(), Math.max(1, this.view.zoom * factor))
      const after = this.fitScale * zoom
      const x = this.view.x + (at.x - width / 2) / before
      const y = this.view.y + (at.y - height / 2) / before

      this.view = { x: x - (at.x - width / 2) / after, y: y - (at.y - height / 2) / after, zoom }
    },

    // The buttons zoom round the middle of the map.
    zoomBy(factor) {
      this.zoomAt({ x: this.size.width / 2, y: this.size.height / 2 }, factor)
      this.draw()
    },

    pointer(event) {
      const box = this.$refs.canvas.getBoundingClientRect()

      return { x: event.clientX - box.left, y: event.clientY - box.top }
    },

    // The system drawn last under `at`, if any.
    nodeAt(at) {
      const { nodes, selected } = this

      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]
        const { x, y } = this.toScreen(node)
        const reach = node.size + (node.SystemID === selected ? 1.5 : 0.5) + HIT_SLACK

        if ((x - at.x) ** 2 + (y - at.y) ** 2 <= reach ** 2) {
          return node
        }
      }

      return null
    },

    // Wheel events come faster than frames: their zoom adds up and applies once a frame.
    wheel(event) {
      this.wheelFactor *= wheelZoom(event)
      this.wheelAt = this.pointer(event)
      this.queueFrame()
    },

    press(event) {
      if (event.button !== 0) {
        return
      }

      this.pressed = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...this.view } }
    },

    move(event) {
      const { pressed } = this

      if (!pressed || event.pointerId !== pressed.id) {
        const node = this.nodeAt(this.pointer(event))

        this.hoverId = node ? node.SystemID : null

        return
      }

      const dx = event.clientX - pressed.x
      const dy = event.clientY - pressed.y

      if (!this.dragging) {
        if (Math.hypot(dx, dy) < DRAG_PIXELS) {
          return
        }

        this.dragging = true
        this.hoverId = null
        this.$refs.canvas.setPointerCapture(event.pointerId)
      }

      const scale = this.fitScale * pressed.view.zoom

      this.view = { ...pressed.view, x: pressed.view.x - dx / scale, y: pressed.view.y - dy / scale }
      this.queueFrame()
    },

    // A press that didn't become a drag is a click: on a system, it selects it.
    release(event) {
      if (!this.pressed || event.pointerId !== this.pressed.id) {
        return
      }

      const clicked = !this.dragging && this.nodeAt(this.pointer(event))

      this.dragging = false
      this.pressed = null

      if (clicked) {
        this.$emit('select', clicked.SystemID)
      }
    },

    cancel() {
      this.dragging = false
      this.pressed = null
    },

    leave() {
      if (!this.dragging) {
        this.hoverId = null
      }
    },
  },
}
</script>

<style lang="scss">
.system-map {
  position: relative;
  width: 100%;
}

.system-map__canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.system-map__canvas--over {
  cursor: pointer;
}

.system-map__canvas--dragging {
  cursor: grabbing;
}

.system-map__controls {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  padding: 2px;
  border: 1px solid var(--ae-border);
  border-radius: 4px;
  background: var(--ae-bg);
}
</style>
