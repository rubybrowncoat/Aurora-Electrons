// The Galaxy Map's PNG, composed from the same state the screen draws: the visual hierarchy, the page background with the dots of its grid, and the legend above the map. The page asks `exportComposition` for the state once and draws the screen's grid, the borders' names and the legend's examples from it too, so the picture and the screen can only differ where a mark is drawn by cytoscape, which takes its links and names from the page's own style.
//
// Everything here is plain data or draws on a 2D context it is given, so scripts/check-map-hierarchy.js runs it with a recording context.

import { gridDotColor, labelInk, linkStyle } from './map-hierarchy'

// The map stage's grid: one dot a spacing apart, centred in its cell, with this radius, both in map units at zoom 1 (screen pixels).
export const GRID = { spacing: 20, radius: 1 }

// The picture is at least this wide, so the legend's rows have room whatever the map's size.
export const LEGEND_MIN_WIDTH = 640

const PAD = 12
const ROW_GAP = 4
const ITEM_GAP = 16
const SWATCH_GAP = 6
const TEXT_PX = 12
const DOT = 10
const GLYPH_ICON = 11
const SWATCH_WIDTH = { ring: DOT, dot: DOT, spot: 6, line: 18, icon: 12, glyph: 16, area: 18 }
const AREA_DOT = 8

// The legend's items for the picture: as the screen lists them, but the discovery slider is a control, so it is written as the year it is set to.
export const legendItems = (rows, asOf = null) => rows.map((row) => row.map((item) => (item.kind === 'slider' ? { kind: 'note', label: asOf || '' } : item)))

// Everything the picture holds besides the raster cytoscape draws of the systems and their links (which carries the hierarchy through the page's stylesheet):
// - `hierarchy`: the level the screen shows;
// - `background` and `grid`: the page's background and the dots on it;
// - `links`: the colour and width the links are drawn in, which the stylesheet takes from the same call;
// - `names`: the ink and halo of the borders' names;
// - `legend`: the colours of the legend's band and its rows of items; `iconPaths` is the SVG path of each icon the legend names.
export const exportComposition = ({ hierarchy, appearance, theme, legendRows, asOf = null, iconPaths = {} }) => ({
  hierarchy,
  background: appearance.surfaces.background,
  grid: { color: gridDotColor(hierarchy, { border: appearance.surfaces.border, background: appearance.surfaces.background }), spacing: GRID.spacing, radius: GRID.radius },
  links: linkStyle(hierarchy, theme),
  names: { ink: labelInk(hierarchy, theme, false), halo: theme.surface },
  legend: { surface: appearance.surfaces.card, ink: appearance.inks.text, muted: appearance.inks.textMuted, border: appearance.surfaces.border, glyphSurface: theme.surface, iconPaths, rows: legendItems(legendRows, asOf) },
})

// The grid's dots over a `width` by `height` area at the origin, in the grid's own units.
export const drawGrid = (context, { width, height }, { color, spacing, radius }) => {
  context.fillStyle = color
  context.beginPath()

  for (let y = spacing / 2; y < height; y += spacing) {
    for (let x = spacing / 2; x < width; x += spacing) {
      context.moveTo(x + radius, y)
      context.arc(x, y, radius, 0, 2 * Math.PI)
    }
  }

  context.fill()
}

// A legend dot's corners (a categorical colour's marker) from the CSS `clip-path` the screen gives it, as shares of the dot's box; null for a circle.
const clipCorners = (clip) => {
  const pairs = typeof clip === 'string' ? clip.match(/-?[\d.]+%\s+-?[\d.]+%/g) : null

  return pairs ? pairs.map((pair) => pair.split(/\s+/).map((value) => parseFloat(value) / 100)) : null
}

// The width an item's swatch takes with its gap to the text.
const swatchWidth = (context, item) => {
  if (item.kind === 'sample') {
    return context.measureText(item.sample).width + 10 + SWATCH_GAP
  }

  return SWATCH_WIDTH[item.kind] === undefined ? 0 : SWATCH_WIDTH[item.kind] + SWATCH_GAP
}

// The lines a label takes within `limit`: whole words where they fit, and a word wider than `limit` by its characters, so nothing is wider than `limit`.
const wrapLabel = (context, label, limit) => {
  const lines = []
  let line = ''

  label.split(' ').forEach((word) => {
    const joined = line ? `${line} ${word}` : word

    if (context.measureText(joined).width <= limit) {
      line = joined

      return
    }

    if (line) {
      lines.push(line)
      line = ''
    }

    let rest = word

    while (rest.length > 1 && context.measureText(rest).width > limit) {
      let cut = rest.length - 1

      while (cut > 1 && context.measureText(rest.slice(0, cut)).width > limit) {
        cut--
      }

      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }

    line = rest
  })

  return line ? [...lines, line] : lines
}

// Where each item of the legend goes: `{ height, lineHeight, placed: [{ item, x, y, swatch, width, lines }] }`, rows in the order given, an item after the previous one with the screen's gaps, wrapping within `width`. A label wider than a whole row is broken into `lines` by the real font metrics, each a line below the last, and the band is as tall as they need; the picture is never made wider for it. `type` is the typeface of the map (`mapFont()`); the legend's text is 12 px at the chosen text size, as the screen's.
export const legendLayout = (context, rows, { width, type }) => {
  const lineHeight = Math.max(16, Math.ceil(type.size(TEXT_PX) * 1.4))
  const room = width - 2 * PAD
  const placed = []
  let y = PAD

  rows.forEach((row) => {
    let x = PAD
    // The most lines an item takes in the line being laid out.
    let tallest = 1

    row.forEach((item) => {
      context.font = type.font(TEXT_PX, item.kind === 'heading' ? 500 : 400)

      const swatch = swatchWidth(context, item)
      const whole = item.label ? context.measureText(item.label).width : 0
      const lines = !item.label ? [] : swatch + whole > room ? wrapLabel(context, item.label, Math.max(room - swatch, 1)) : [item.label]
      const itemWidth = swatch + (lines.length > 1 ? Math.max(...lines.map((line) => context.measureText(line).width)) : whole)

      if (x > PAD && x + itemWidth > width - PAD) {
        x = PAD
        y += tallest * lineHeight + ROW_GAP
        tallest = 1
      }

      placed.push({ item, x, y, swatch, width: itemWidth, lines })
      tallest = Math.max(tallest, lines.length)
      x += itemWidth + ITEM_GAP
    })

    y += tallest * lineHeight + ROW_GAP
  })

  return { height: rows.length ? y - ROW_GAP + PAD : 0, lineHeight, placed }
}

const rounded = (context, x, y, width, height, radius) => {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

const polygon = (context, corners, x, y, size) => {
  context.beginPath()
  corners.forEach(([fx, fy], i) => context[i ? 'lineTo' : 'moveTo'](x + fx * size, y + fy * size))
  context.closePath()
}

// One item's swatch, in a box `lineHeight` high from `x`, `y`.
const drawSwatch = (context, { item, x, y }, { lineHeight }, legend, type) => {
  const cy = y + lineHeight / 2
  const circle = (cx, radius) => {
    context.beginPath()
    context.arc(cx, cy, radius, 0, 2 * Math.PI)
  }

  context.save()

  if (item.kind === 'dot') {
    const corners = clipCorners(item.clip)

    context.fillStyle = item.color

    if (corners) {
      polygon(context, corners, x, cy - DOT / 2, DOT)
    } else {
      circle(x + DOT / 2, DOT / 2)
    }

    context.fill()
  } else if (item.kind === 'ring') {
    const width = item.width || 2

    context.strokeStyle = item.color
    context.lineWidth = item.style === 'double' ? width / 3 : width
    context.setLineDash({ dashed: [2.5, 2], dotted: [0.1, 2.2] }[item.style] || [])
    context.lineCap = item.style === 'dotted' ? 'round' : 'butt'
    circle(x + DOT / 2, DOT / 2 - context.lineWidth / 2)
    context.stroke()

    if (item.style === 'double') {
      circle(x + DOT / 2, DOT / 2 - width + context.lineWidth / 2)
      context.stroke()
    }
  } else if (item.kind === 'spot') {
    context.fillStyle = item.color
    circle(x + 3, 3)
    context.fill()
  } else if (item.kind === 'line') {
    context.fillStyle = item.color
    context.strokeStyle = item.color

    if (item.dashed) {
      context.lineWidth = 3
      context.setLineDash([4, 3])
      context.beginPath()
      context.moveTo(x, cy)
      context.lineTo(x + SWATCH_WIDTH.line, cy)
      context.stroke()
    } else {
      const thickness = item.thickness || 4

      rounded(context, x, cy - thickness / 2, SWATCH_WIDTH.line, thickness, Math.min(2, thickness / 2))
      context.fill()
    }
  } else if (item.kind === 'icon' && legend.iconPaths[item.icon]) {
    context.fillStyle = legend.ink
    context.translate(x, cy - 6)
    context.scale(SWATCH_WIDTH.icon / 24, SWATCH_WIDTH.icon / 24)
    context.fill(new Path2D(legend.iconPaths[item.icon]))
  } else if (item.kind === 'glyph') {
    const hollow = Boolean(item.hollow)

    context.translate(x, cy - 8)
    context.fillStyle = hollow ? 'transparent' : item.color
    context.strokeStyle = item.color
    context.lineWidth = 1.5
    context.beginPath()
    context.arc(8, 8, 7.25, 0, 2 * Math.PI)
    context.fill()
    context.stroke()
    context.fillStyle = hollow ? item.color : legend.glyphSurface

    if (item.text) {
      context.font = `700 ${[10, 8, 6][Math.min(item.text.length, 3) - 1]}px ${type.family}`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(item.text, 8, 8)
    } else if (item.path) {
      const scale = GLYPH_ICON / 24
      const [dx, dy] = item.offset || [0, 0]

      context.translate(8 - GLYPH_ICON / 2 + dx * scale, 8 - GLYPH_ICON / 2 + dy * scale)
      context.scale(scale, scale)
      context.fill(new Path2D(item.path))
    }
  } else if (item.kind === 'area') {
    rounded(context, x + 1, cy - 6, SWATCH_WIDTH.area - 2, 12, 5)
    context.fillStyle = item.tint || 'transparent'
    context.fill()
    context.strokeStyle = item.color
    context.lineWidth = 2
    context.stroke()

    if (item.dot) {
      const corners = clipCorners(item.clip)

      context.fillStyle = item.color

      if (corners) {
        polygon(context, corners, x + (SWATCH_WIDTH.area - AREA_DOT) / 2, cy - AREA_DOT / 2, AREA_DOT)
      } else {
        circle(x + SWATCH_WIDTH.area / 2, AREA_DOT / 2)
      }

      context.fill()
    }
  } else if (item.kind === 'sample') {
    const width = context.measureText(item.sample).width + 10

    rounded(context, x + 0.5, cy - lineHeight / 2 + 1.5, width - 1, lineHeight - 3, 3)
    context.strokeStyle = legend.border
    context.lineWidth = 1
    context.stroke()
    context.fillStyle = legend.ink
    context.textAlign = 'left'
    context.textBaseline = 'middle'
    context.fillText(item.sample, x + 5, cy)
  }

  context.restore()
}

// The legend: a band of `width` from `top`, its top edge ruled, then each item's swatch and text. `layout` is `legendLayout`'s, `legend` the composition's.
export const drawLegend = (context, layout, legend, { top, width, type }) => {
  context.save()
  context.fillStyle = legend.surface
  context.fillRect(0, top, width, layout.height)
  context.fillStyle = legend.border
  context.fillRect(0, top, width, 1)

  layout.placed.forEach((place) => {
    const { item, swatch } = place
    const at = { ...place, y: top + place.y }

    context.font = type.font(TEXT_PX)
    drawSwatch(context, at, layout, legend, type)

    if (item.label) {
      context.font = type.font(TEXT_PX, item.kind === 'heading' ? 500 : 400)
      context.fillStyle = item.kind === 'note' ? legend.muted : legend.ink
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      place.lines.forEach((line, index) => context.fillText(line, at.x + swatch, at.y + layout.lineHeight / 2 + index * layout.lineHeight))
    }
  })

  context.restore()
}
