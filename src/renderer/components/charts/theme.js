import { activeAppearance, SERIES_ENCODINGS } from '../../utilities/appearance'
import { fontRoles } from '../../utilities/appearance-font'

// Chart colours, taken from the resolved appearance (utilities/appearance.js): its card surface, inks, axis colour, tooltip and nine categorical slots. The palette's validation notes are there, and so is what tells a slot apart without its colour (`SERIES_ENCODINGS`: marker, dash, bar pattern). This file holds the shapes those names stand for.

const themes = new WeakMap()
const slotMaps = new WeakMap()

// The chart tokens of an appearance: `surface`, `ink`, `inkMuted`, `border` (axes), `primary`, `tooltip`, `tooltipInk` and `categorical`. Without an argument, the appearance in force. Read inside a computed property, it follows a preset switch.
export const chartTheme = (appearance = activeAppearance()) => {
  const { surfaces, inks, focus, charts } = appearance

  if (!themes.has(charts)) {
    themes.set(charts, { surface: surfaces.card, ink: inks.body, inkMuted: inks.muted, border: charts.axis, primary: focus.primary, tooltip: charts.tooltip, tooltipInk: inks.onTooltip, categorical: charts.categorical })
  }

  return themes.get(charts)
}

// The typeface of the text a chart or a map draws, from the choice in force (utilities/appearance-font.js): `family` (a CSS family list), `size(px)` (a size in pixels at the chosen text size) and `font(px, weight)` (a canvas font string). `chartFont` takes the chart role and `mapFont` the map role. Read inside a computed property, they follow a change of typeface or text size and the load of a bundled face.
const textFont = (family, roles) => ({ family, size: roles.size, font: (px, weight = 400) => `${weight} ${roles.size(px)}px ${family}` })

export const chartFont = (roles = fontRoles()) => textFont(roles.chart, roles)

export const mapFont = (roles = fontRoles()) => textFont(roles.map, roles)

// The flow groups' fixed slots: the order the validator passed, so neighbouring stack segments (salvage | mining | construction | shipbuilding | …) stay distinct.
const FLOW_SLOTS = { mining: 0, construction: 1, shipbuilding: 2, ordnance: 3, ground: 4, fuel: 5, maintenance: 6, salvage: 7 }

export const flowColor = (appearance, key) => chartTheme(appearance).categorical[FLOW_SLOTS[key]]

// Hex colour with an alpha, for area washes (~10%) and recessive fills.
export const withAlpha = (hex, alpha) => {
  const value = Math.round(alpha * 255).toString(16).padStart(2, '0')

  return `${hex}${value}`
}

// The marker shapes, as SVG paths centred on the origin and about 12 units across, so a canvas (Path2D) and a legend (SVG) draw the same shape.
export const MARKER_PATHS = {
  circle: 'M-4.6,0a4.6,4.6 0 1,0 9.2,0a4.6,4.6 0 1,0 -9.2,0Z',
  square: 'M-4,-4H4V4H-4Z',
  triangle: 'M0,-5.5L5.4,4L-5.4,4Z',
  diamond: 'M0,-6L6,0L0,6L-6,0Z',
  cross: 'M-1.8,-5.5H1.8V-1.8H5.5V1.8H1.8V5.5H-1.8V1.8H-5.5V-1.8H-1.8Z',
  ex: 'M-4.6,-2.2L-2.2,-4.6L0,-2.4L2.2,-4.6L4.6,-2.2L2.4,0L4.6,2.2L2.2,4.6L0,2.4L-2.2,4.6L-4.6,2.2L-2.4,0Z',
  down: 'M0,5.5L5.4,-4L-5.4,-4Z',
  star: 'M0,-6L1.53,-2.1L5.71,-1.85L2.47,0.8L3.53,4.85L0,2.6L-3.53,4.85L-2.47,0.8L-5.71,-1.85L-1.53,-2.1Z',
  hexagon: 'M5.5,0L2.75,4.76L-2.75,4.76L-5.5,0L-2.75,-4.76L2.75,-4.76Z',
}

// The bar patterns, as strokes (`line`, `poly`) and fills (`circle`, `rect`) in an 8 by 8 tile that repeats; drawn over the series' own colour in the surface colour, so the colour stays and the texture says which series.
export const PATTERN_SIZE = 8

export const PATTERNS = {
  solid: [],
  diagonal: [['line', 0, 8, 8, 0], ['line', -4, 4, 4, -4], ['line', 4, 12, 12, 4]],
  dots: [['circle', 2, 2, 1.3], ['circle', 6, 6, 1.3]],
  horizontal: [['line', 0, 4, 8, 4]],
  crosshatch: [['line', 0, 8, 8, 0], ['line', -4, 4, 4, -4], ['line', 4, 12, 12, 4], ['line', 0, 0, 8, 8], ['line', -4, 4, 4, 12], ['line', 4, -4, 12, 4]],
  vertical: [['line', 4, 0, 4, 8]],
  backdiagonal: [['line', 0, 0, 8, 8], ['line', -4, 4, 4, 12], ['line', 4, -4, 12, 4]],
  squares: [['rect', 2.5, 2.5, 3, 3]],
  zigzag: [['poly', 0, 6, 2, 2, 4, 6, 6, 2, 8, 6]],
}

export const PATTERN_STROKE = 1.4

// The slot of a categorical colour (any alpha on it is ignored), or -1 for a colour that is not one of the nine.
export const seriesSlot = (appearance, color) => {
  const { categorical } = appearance.charts

  if (!slotMaps.has(categorical)) {
    slotMaps.set(categorical, new Map(categorical.map((hex, slot) => [hex.toLowerCase(), slot])))
  }

  if (typeof color !== 'string') {
    return -1
  }

  const slot = slotMaps.get(categorical).get(color.slice(0, 7).toLowerCase())

  return slot === undefined ? -1 : slot
}

// What a categorical slot is drawn with besides its colour: `{ slot, color, marker, markerPath, dash, pattern, primitives }`; null for a colour that is not one of the nine.
export const seriesIdentity = (appearance, color) => {
  const slot = seriesSlot(appearance, color)

  if (slot < 0) {
    return null
  }

  const { marker, dash, pattern } = SERIES_ENCODINGS[slot]

  return { slot, color: appearance.charts.categorical[slot], marker, markerPath: MARKER_PATHS[marker], dash, pattern, primitives: PATTERNS[pattern] }
}

// A straight-edged marker's corners as the flat "x y x y …" string of a cytoscape polygon, scaled so the widest corner reaches 1 on its axis; null for the circle, which a node draws as an ellipse. Walks the path's M, L, H, V and Z commands.
export const markerPoints = (marker) => {
  const path = MARKER_PATHS[marker]

  if (!path || path.includes('a')) {
    return null
  }

  const corners = []
  let x = 0
  let y = 0

  for (const [, command, values] of path.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
    const numbers = values.split(/[ ,]+/).filter(Boolean).map(Number)

    if (command === 'H') {
      x = numbers[0]
    } else if (command === 'V') {
      y = numbers[0]
    } else if (command !== 'Z') {
      [x, y] = numbers
    }

    if (command !== 'Z') {
      corners.push([x, y])
    }
  }

  const reach = Math.max(...corners.flat().map(Math.abs))

  return corners.map(([cornerX, cornerY]) => `${+(cornerX / reach).toFixed(3)} ${+(cornerY / reach).toFixed(3)}`).join(' ')
}

// The slot's texture as a CSS `background-image` (an SVG tile, PATTERN_SIZE square, the texture alone over transparency), for swatches and previews that are not drawn on a canvas; null for the solid slot.
export const patternImage = (identity, surface) => {
  if (!identity.primitives.length) {
    return null
  }

  const shapes = identity.primitives.map(([shape, ...values]) => {
    if (shape === 'line') {
      return `<line x1="${values[0]}" y1="${values[1]}" x2="${values[2]}" y2="${values[3]}"/>`
    }

    if (shape === 'poly') {
      return `<polyline fill="none" points="${values.join(' ')}"/>`
    }

    return shape === 'circle' ? `<circle cx="${values[0]}" cy="${values[1]}" r="${values[2]}" stroke="none"/>` : `<rect x="${values[0]}" y="${values[1]}" width="${values[2]}" height="${values[3]}" stroke="none"/>`
  })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PATTERN_SIZE}" height="${PATTERN_SIZE}"><g stroke="${surface}" fill="${surface}" opacity="0.75" stroke-width="${PATTERN_STROKE}">${shapes.join('')}</g></svg>`

  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const tiles = new Map()

// A canvas pattern for a bar: `base` (the series' colour, with its alpha) under the slot's texture in `surface`. The tile is drawn at the device's pixel density and scaled back, so it stays sharp.
export const barPattern = (identity, base, surface) => {
  if (!identity.primitives.length) {
    return base
  }

  const key = `${identity.pattern}|${base}|${surface}`

  if (!tiles.has(key)) {
    const density = Math.max(1, Math.ceil(window.devicePixelRatio || 1))
    const canvas = document.createElement('canvas')

    canvas.width = PATTERN_SIZE * density
    canvas.height = PATTERN_SIZE * density
    const context = canvas.getContext('2d')

    context.scale(density, density)
    context.fillStyle = base
    context.fillRect(0, 0, PATTERN_SIZE, PATTERN_SIZE)
    context.strokeStyle = surface
    context.fillStyle = surface
    context.globalAlpha = 0.75
    context.lineWidth = PATTERN_STROKE

    identity.primitives.forEach(([shape, ...values]) => {
      context.beginPath()

      if (shape === 'line') {
        context.moveTo(values[0], values[1])
        context.lineTo(values[2], values[3])
        context.stroke()
      } else if (shape === 'poly') {
        for (let index = 0; index < values.length; index += 2) {
          context[index ? 'lineTo' : 'moveTo'](values[index], values[index + 1])
        }

        context.stroke()
      } else if (shape === 'circle') {
        context.arc(values[0], values[1], values[2], 0, 2 * Math.PI)
        context.fill()
      } else {
        context.fillRect(...values)
      }
    })

    const pattern = context.createPattern(canvas, 'repeat')

    if (pattern.setTransform) {
      pattern.setTransform(new DOMMatrix().scale(1 / density))
    }

    tiles.set(key, pattern)
  }

  return tiles.get(key)
}
