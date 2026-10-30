<template>
  <div class="chart-canvas" :style="{ height: `${height}px` }">
    <canvas ref="canvas" role="img" :aria-label="label" />
  </div>
</template>

<script>
import { BarController, BarElement, CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, LogarithmicScale, PointElement, Tooltip } from 'chart.js'

import { activeAppearance } from '../../utilities/appearance'
import { whenFontsReady } from '../../utilities/appearance-font'
import { chartGridColor, hierarchyView } from '../../utilities/map-hierarchy'
import persistedView from '../../mixins/persisted-view'
import { barPattern, chartFont, chartTheme, seriesIdentity } from './theme'

Chart.register(BarController, BarElement, CategoryScale, Filler, LinearScale, LineController, LineElement, LogarithmicScale, PointElement, Tooltip)

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Plain-object deep merge: Chart.js must not receive Vue's reactive objects.
const merge = (base, extra) => {
  const result = { ...base }

  Object.entries(extra || {}).forEach(([key, value]) => {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? merge(result[key], value) : isPlainObject(value) ? merge({}, value) : value
  })

  return result
}

// A vertical hairline under the pointer (line charts), labelled vertical markers at fixed x values (`options.plugins.guides.markers`: [{ x, label }]) and labelled dashed horizontal levels at fixed y values (`options.plugins.guides.levels`: [{ y, label, axis = 'y' }]).
const guides = {
  id: 'guides',
  afterDatasetsDraw (chart, _args, pluginOptions) {
    const { ctx, chartArea, scales } = chart
    const { color, textColor, crosshair, markers = [], levels = [], font, size } = pluginOptions

    ctx.save()
    ctx.lineWidth = 1
    ctx.font = font

    levels.forEach((level) => {
      const scale = scales[level.axis || 'y']
      const y = scale && scale.getPixelForValue(level.y)

      if (!(y >= chartArea.top && y <= chartArea.bottom)) {
        return
      }

      ctx.strokeStyle = color
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(chartArea.left, y)
      ctx.lineTo(chartArea.right, y)
      ctx.stroke()
      ctx.setLineDash([])

      if (level.label) {
        ctx.fillStyle = textColor
        ctx.textAlign = 'left'
        ctx.fillText(level.label, chartArea.left + 6, y - 4 < chartArea.top + size ? y + size + 2 : y - 4)
      }
    })

    markers.forEach((marker) => {
      const x = scales.x.getPixelForValue(marker.x)

      if (!(x >= chartArea.left && x <= chartArea.right)) {
        return
      }

      ctx.strokeStyle = color
      ctx.beginPath()
      ctx.moveTo(x, chartArea.top)
      ctx.lineTo(x, chartArea.bottom)
      ctx.stroke()

      if (marker.label) {
        const width = ctx.measureText(marker.label).width
        const alignRight = x + 6 + width > chartArea.right

        ctx.fillStyle = textColor
        ctx.textAlign = alignRight ? 'right' : 'left'
        ctx.fillText(marker.label, alignRight ? x - 6 : x + 6, chartArea.top + size)
      }
    })

    const active = chart.tooltip && chart.tooltip.getActiveElements()

    if (crosshair && active && active.length) {
      const x = active[0].element.x

      ctx.strokeStyle = color
      ctx.beginPath()
      ctx.moveTo(x, chartArea.top)
      ctx.lineTo(x, chartArea.bottom)
      ctx.stroke()
    }

    ctx.restore()
  },
}

const MARKERS_PER_LINE = 7
const MARKER_BLEED = 12
const markerPaths = new Map()

// The markers of the lines and scatter series that carry a categorical slot (`aeSeries`, set by `encoded`): the slot's shape in its colour with a halo in the surface colour, at every point of a series that asked for points and at about seven of any other, staggered by slot so that the markers of two lines don't sit on one another, and at the point under the pointer. A series with markers on every point gives Chart.js its marker's radius for it to hit-test with, so what the pointer can pick is what is drawn; Chart.js's own point is transparent, and the active point's radius (`pointHoverRadius`) sizes the marker under the pointer.
const series = {
  id: 'series',
  afterDatasetsDraw (chart, _args, pluginOptions) {
    const { ctx, chartArea } = chart

    chart.data.datasets.forEach((dataset, index) => {
      const info = dataset.aeSeries

      if (!info || !chart.isDatasetVisible(index)) {
        return
      }

      const { identity, radius, every } = info
      const { data } = chart.getDatasetMeta(index)
      const stride = every ? 1 : Math.max(1, Math.ceil(data.length / MARKERS_PER_LINE))

      if (!markerPaths.has(identity.markerPath)) {
        markerPaths.set(identity.markerPath, new Path2D(identity.markerPath))
      }

      const path = markerPaths.get(identity.markerPath)

      ctx.save()
      ctx.beginPath()
      ctx.rect(chartArea.left - MARKER_BLEED, chartArea.top - MARKER_BLEED, chartArea.width + 2 * MARKER_BLEED, chartArea.height + 2 * MARKER_BLEED)
      ctx.clip()
      ctx.fillStyle = identity.color
      ctx.strokeStyle = pluginOptions.surface

      data.forEach((point, position) => {
        if (!(point.active || position % stride === identity.slot % stride) || point.skip || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          return
        }

        const scale = Math.max(radius, point.active ? point.options.radius || 0 : 0) / 6

        ctx.save()
        ctx.translate(point.x, point.y)
        ctx.scale(scale, scale)
        ctx.lineWidth = 3 / scale
        ctx.stroke(path)
        ctx.fill(path)
        ctx.restore()
      })

      ctx.restore()
    })
  },
}

// The colour key beside a value in the tooltip: the slot's colour for a series with markers, whose own Chart.js point is transparent.
const labelColor = (context) => {
  const info = context.dataset.aeSeries

  return info ? { borderColor: info.identity.color, backgroundColor: info.identity.color, borderWidth: 0, borderRadius: 0 } : Tooltip.defaults.callbacks.labelColor(context)
}

export default {
  name: 'ChartCanvas',
  // The gridlines follow the level of the visual hierarchy the Galaxy Map keeps (utilities/map-hierarchy.js).
  mixins: [persistedView({ hierarchy: hierarchyView })],
  props: {
    type: { type: String, required: true },
    data: { type: Object, required: true },
    options: { type: Object, default: () => ({}) },
    height: { type: Number, default: 280 },
    label: { type: String, default: '' },
    encode: { type: Boolean, default: true },
  },
  computed: {
    appearance () {
      return activeAppearance()
    },
    theme () {
      return chartTheme(this.appearance)
    },
    // The typeface and text size of the chart text: Chart.js's own (ticks, axis titles, tooltip) and the guides drawn on the canvas. Chart.js reads a font from the option of each element, so every one of them names it.
    typeface () {
      return chartFont()
    },
  },
  watch: {
    data () {
      this.update()
    },
    options () {
      this.update()
    },
    appearance () {
      this.update()
    },
    hierarchy () {
      this.update()
    },
    typeface () {
      this.build()
    },
  },
  created () {
    this.chart = null
    this.builds = 0
  },
  mounted () {
    this.build()
  },
  beforeDestroy () {
    this.builds++

    if (this.chart) {
      this.chart.destroy()
      this.chart = null
    }
  },
  methods: {
    // A series drawn in one of the nine categorical colours also carries what tells its slot apart without the colour (SERIES_ENCODINGS in utilities/appearance.js): a line gets its slot's dash (unless it brings its own) and markers drawn by the series plugin, a bar its slot's texture over its colour. A dataset whose colour is none of the nine, or with `encode: false`, is left as it is. A series with `pointRadius` above 0 keeps a marker on each point, any other line one on about seven. Chart.js's own point is made transparent, so its shape (`pointStyle`) and colours show neither at rest nor under the pointer; a series with a marker on every point keeps its radius as the point's, which is also the area the pointer picks it by.
    encoded (dataset) {
      const identity = this.encode && dataset.encode !== false && seriesIdentity(this.appearance, (dataset.type || this.type) === 'line' ? dataset.borderColor || dataset.backgroundColor : dataset.backgroundColor || dataset.borderColor)

      if (!identity) {
        return dataset
      }

      if ((dataset.type || this.type) === 'line') {
        const every = dataset.showLine === false || dataset.pointRadius > 0
        const radius = every ? Math.max(dataset.pointRadius || 0, 4) : 4.5

        return { ...dataset, borderDash: dataset.borderDash && dataset.borderDash.length ? dataset.borderDash : identity.dash, pointRadius: every ? radius : 0, pointBackgroundColor: 'transparent', pointBorderColor: 'transparent', pointBorderWidth: 0, pointHoverBackgroundColor: 'transparent', pointHoverBorderColor: 'transparent', pointHoverBorderWidth: 0, aeSeries: { identity, every, radius } }
      }

      return typeof dataset.backgroundColor === 'string' ? { ...dataset, backgroundColor: barPattern(identity, dataset.backgroundColor, this.theme.surface) } : dataset
    },
    plainData () {
      return {
        labels: [...(this.data.labels || [])],
        datasets: (this.data.datasets || []).map((dataset) => this.encoded({ ...dataset, data: dataset.data.map((point) => (isPlainObject(point) ? { ...point } : point)) })),
      }
    },
    resolvedOptions () {
      const { ink, inkMuted, border, surface, tooltip, tooltipInk } = this.theme
      const line = this.type === 'line'
      const { family, size, font } = this.typeface
      const text = { family, size: size(12) }
      const axis = {
        grid: { color: chartGridColor(this.hierarchy, border), drawTicks: false },
        border: { color: border },
        ticks: { color: inkMuted, padding: 6, font: text },
        title: { color: inkMuted, font: text },
      }

      return merge({
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        color: ink,
        font: text,
        interaction: line ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
        scales: { x: axis, y: axis },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltip,
            titleColor: tooltipInk,
            bodyColor: tooltipInk,
            titleFont: text,
            bodyFont: text,
            footerFont: text,
            padding: 8,
            cornerRadius: 4,
            boxWidth: 12,
            boxHeight: 2,
            usePointStyle: false,
            callbacks: { labelColor },
          },
          guides: { color: inkMuted, textColor: inkMuted, crosshair: line, markers: [], levels: [], font: font(12), size: size(12) },
          series: { surface },
        },
      }, this.options)
    },
    // Chart.js keeps the widths it measured under the font string of each label, and a face that loads afterwards leaves the string as it was. So the chart is built once the faces are ready, and built again when the typeface or a face changes; the one on screen stays until its replacement is ready.
    async build () {
      const build = ++this.builds

      await whenFontsReady()

      if (build !== this.builds) {
        return
      }

      if (this.chart) {
        this.chart.destroy()
      }

      this.chart = new Chart(this.$refs.canvas, {
        type: this.type,
        data: this.plainData(),
        options: this.resolvedOptions(),
        plugins: [guides, series],
      })
    },
    update () {
      if (!this.chart) {
        return
      }

      this.chart.data = this.plainData()
      this.chart.options = this.resolvedOptions()
      this.chart.update('none')
    },
  },
}
</script>

<style scoped>
.chart-canvas {
  position: relative;
  width: 100%;
}
</style>
