// The overview in the Galaxy Map's corner: the whole map drawn small, with a frame round the part in
// view. Pressing or dragging in it moves the view there, and the wheel zooms. It draws only when the
// map changes, straight from the graph, where cytoscape-navigator rendered the graph to a PNG image as
// often as ten times a second while the view moved, at 50–100 ms each.

// Space left round the map inside the overview, as a share of its size.
const MARGIN = 0.06

// `paint(context, scale)` draws the map on `context`, already transformed to map units, at `scale`
// overview pixels to a map unit. Call `refresh` when something the graph doesn't report changes, such
// as colours or the overview's size.
export const createMinimap = (graph, container, paint) => {
  const canvas = document.createElement('canvas')
  const frame = document.createElement('div')

  frame.className = 'map-minimap__frame'
  container.append(canvas, frame)

  // Map units to overview pixels: (x - left) * scale.
  let left = 0
  let top = 0
  let scale = 0
  let queued = false
  let dragging = false
  let destroyed = false

  const placeFrame = () => {
    frame.hidden = !scale

    if (scale) {
      const { x1, y1, w, h } = graph.extent()

      frame.style.left = `${(x1 - left) * scale}px`
      frame.style.top = `${(y1 - top) * scale}px`
      frame.style.width = `${w * scale}px`
      frame.style.height = `${h * scale}px`
    }
  }

  const draw = () => {
    queued = false

    if (destroyed) {
      return
    }

    const width = container.clientWidth
    const height = container.clientHeight
    const ratio = window.devicePixelRatio || 1
    const box = graph.elements().boundingBox({ includeLabels: false })

    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    scale = width && height && box.w > 0 && box.h > 0 ? (1 - 2 * MARGIN) * Math.min(width / box.w, height / box.h) : 0

    if (scale) {
      left = box.x1 - (width / scale - box.w) / 2
      top = box.y1 - (height / scale - box.h) / 2

      const context = canvas.getContext('2d')

      context.setTransform(ratio * scale, 0, 0, ratio * scale, -left * ratio * scale, -top * ratio * scale)
      paint(context, scale)
    }

    placeFrame()
  }

  const refresh = () => {
    if (!queued) {
      queued = true
      requestAnimationFrame(draw)
    }
  }

  const moveTo = (event) => {
    const bounds = container.getBoundingClientRect()
    const x = left + (event.clientX - bounds.left) / scale
    const y = top + (event.clientY - bounds.top) / scale
    const zoom = graph.zoom()

    graph.pan({ x: graph.width() / 2 - x * zoom, y: graph.height() / 2 - y * zoom })
  }

  const onPointerDown = (event) => {
    if (scale && event.button === 0) {
      dragging = true
      container.setPointerCapture(event.pointerId)
      moveTo(event)
    }
  }

  const onPointerMove = (event) => {
    if (dragging) {
      moveTo(event)
    }
  }

  const onPointerUp = () => {
    dragging = false
  }

  // Zooms round the middle of the view, which the frame's middle shows.
  const onWheel = (event) => {
    event.preventDefault()
    graph.zoom({ level: graph.zoom() * Math.exp(-event.deltaY / 500), renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } })
  }

  graph.on('add remove position data', refresh)
  graph.on('viewport', placeFrame)
  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointermove', onPointerMove)
  container.addEventListener('pointerup', onPointerUp)
  container.addEventListener('pointercancel', onPointerUp)
  container.addEventListener('wheel', onWheel, { passive: false })
  refresh()

  return {
    refresh,
    destroy() {
      destroyed = true
      graph.off('add remove position data', refresh)
      graph.off('viewport', placeFrame)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', onPointerUp)
      container.removeEventListener('wheel', onWheel)
      canvas.remove()
      frame.remove()
    },
  }
}
