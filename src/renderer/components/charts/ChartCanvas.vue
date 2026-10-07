<template>
  <div class="chart-canvas" :style="{ height: `${height}px` }">
    <canvas ref="canvas" role="img" :aria-label="label" />
  </div>
</template>

<script>
import { BarController, BarElement, CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js'

import { chartTheme } from './theme'

Chart.register(BarController, BarElement, CategoryScale, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip)

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Plain-object deep merge: Chart.js must not receive Vue's reactive objects.
const merge = (base, extra) => {
  const result = { ...base }

  Object.entries(extra || {}).forEach(([key, value]) => {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? merge(result[key], value) : isPlainObject(value) ? merge({}, value) : value
  })

  return result
}

// A vertical hairline under the pointer (line charts), labelled vertical
// markers at fixed x values (`options.plugins.guides.markers`: [{ x, label }])
// and labelled dashed horizontal levels at fixed y values
// (`options.plugins.guides.levels`: [{ y, label, axis = 'y' }]).
const guides = {
  id: 'guides',
  afterDatasetsDraw (chart, _args, pluginOptions) {
    const { ctx, chartArea, scales } = chart
    const { color, textColor, crosshair, markers = [], levels = [] } = pluginOptions

    ctx.save()
    ctx.lineWidth = 1
    ctx.font = '12px Roboto, "Helvetica Neue", Arial, sans-serif'

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
        ctx.fillText(level.label, chartArea.left + 6, y - 4 < chartArea.top + 12 ? y + 14 : y - 4)
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
        ctx.fillText(marker.label, alignRight ? x - 6 : x + 6, chartArea.top + 12)
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

export default {
  name: 'ChartCanvas',
  props: {
    type: { type: String, required: true },
    data: { type: Object, required: true },
    options: { type: Object, default: () => ({}) },
    height: { type: Number, default: 280 },
    label: { type: String, default: '' },
  },
  computed: {
    dark () {
      return this.$vuetify.theme.dark
    },
    theme () {
      return chartTheme(this.dark)
    },
  },
  watch: {
    data () {
      this.update()
    },
    options () {
      this.update()
    },
    dark () {
      this.update()
    },
  },
  mounted () {
    this.chart = new Chart(this.$refs.canvas, {
      type: this.type,
      data: this.plainData(),
      options: this.resolvedOptions(),
      plugins: [guides],
    })
  },
  beforeDestroy () {
    if (this.chart) {
      this.chart.destroy()
      this.chart = null
    }
  },
  methods: {
    plainData () {
      return {
        labels: [...(this.data.labels || [])],
        datasets: (this.data.datasets || []).map((dataset) => ({ ...dataset, data: dataset.data.map((point) => (isPlainObject(point) ? { ...point } : point)) })),
      }
    },
    resolvedOptions () {
      const { ink, inkMuted, border, tooltip } = this.theme
      const line = this.type === 'line'
      const axis = {
        grid: { color: `${border}99`, drawTicks: false },
        border: { color: border },
        ticks: { color: inkMuted, padding: 6 },
        title: { color: inkMuted },
      }

      return merge({
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        color: ink,
        font: { family: 'Roboto, "Helvetica Neue", Arial, sans-serif', size: 12 },
        interaction: line ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
        scales: { x: axis, y: axis },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltip,
            titleColor: '#ffffff',
            bodyColor: '#ffffff',
            padding: 8,
            cornerRadius: 4,
            boxWidth: 12,
            boxHeight: 2,
            usePointStyle: false,
          },
          guides: { color: inkMuted, textColor: inkMuted, crosshair: line, markers: [], levels: [] },
        },
      }, this.options)
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
