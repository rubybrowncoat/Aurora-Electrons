// The visual hierarchy of the Galaxy Map, the system view and the charts: how strongly the secondary marks are drawn. Secondary marks are the map's links and the dots of its grid, the names of systems with nothing to report, the system view's orbit lines and body names, and the gridlines of a chart. A level scales only those. The marks that carry meaning are never scaled: hazards (a danger rating, an aether rift), the current selection, the contact relationships and the warnings keep the strength they have, at both levels, and so do the names of the systems that any overlay of Show marks, with a glyph or a line under the name.
//
// There are two levels. `emphasised` draws every secondary mark at the strength the app has always given it, so it changes nothing. `restrained` lets them recede. What is drawn at each is the table STRENGTHS, and scripts/check-map-hierarchy.js holds every figure to the contrast the resolved tokens of each preset allow (the floors in FLOORS), so a level can never take a mark below what stays visible.
//
// The choice is one view preference, `mapHierarchy`, declared by the pages and components that draw (`hierarchyView`) and so kept, exported and imported with the other remembered views.

import { hex, over, parseColor } from './appearance-contrast'

export const HIERARCHY_KEY = 'mapHierarchy'
export const DEFAULT_HIERARCHY = 'emphasised'

export const HIERARCHY_LEVELS = [
  { value: 'restrained', text: 'Restrained', hint: 'Secondary marks recede: links, grid dots, orbit lines, gridlines of charts, and the names of systems with nothing to report.' },
  { value: 'emphasised', text: 'Emphasised', hint: 'Secondary marks at full strength, as drawn before this option existed.' },
]

export const isHierarchy = (value) => HIERARCHY_LEVELS.some((level) => level.value === value)

// The field of the persisted view, as `persistedView` takes it (mixins/persisted-view.js). A saved level this version does not offer falls back to the default.
export const hierarchyView = { key: HIERARCHY_KEY, default: DEFAULT_HIERARCHY, valid: isHierarchy }

// What each level draws, by secondary mark:
// - `link` and `linkWidth`: a link's colour as the share of the muted ink over the surface, and its width in map units;
// - `gridDot`: the share of the border colour a dot of the map's grid keeps over the page background;
// - `secondaryInk`: the ink of the name of a system with nothing to report, `ink` or the quieter `muted`;
// - `labelMinPx`: the on-screen size under which the name of such a system is left out;
// - `orbit`, `orbitWidth`: the opacity of an orbit line over the sky and the share of its width;
// - `skyLabel`: the share of the sky's label colour a body's name keeps over the sky;
// - `chartGrid`: the opacity of a chart's gridlines.
export const STRENGTHS = {
  emphasised: { link: 0.6, linkWidth: 3, gridDot: 1, secondaryInk: 'ink', labelMinPx: 9, orbit: 1, orbitWidth: 1, skyLabel: 1, chartGrid: 0.6 },
  restrained: { link: 0.35, linkWidth: 2, gridDot: 0.5, secondaryInk: 'muted', labelMinPx: 11, orbit: 0.75, orbitWidth: 0.75, skyLabel: 0.7, chartGrid: 0.35 },
}

// What a secondary mark may not fall below at any level, as WCAG ratios against the surface it is drawn on. Orbit lines are held to the 3:1 of the sky's orbit line (GRAPHIC of appearance-contrast.js) and names to its 4.5:1 (TEXT); links, the grid dots and chart gridlines are decorative, so they only have to stay apart from their surface, and the figures are what every shipped preset can keep.
export const FLOORS = { orbit: 3, skyLabel: 4.5, label: 4.5, link: 1.5, gridDot: 1.1, chartGrid: 1.08 }

// How much of what a level draws has to differ between the levels for the change to be seen: the share of the contrast over the surface (the ratio less 1) that `restrained` leaves of `emphasised`, at most, for the marks drawn in one colour.
export const VISIBLE_CHANGE = 0.7

const strengthOf = (level) => STRENGTHS[isHierarchy(level) ? level : DEFAULT_HIERARCHY]

// `top` laid over `bottom` at `alpha`, as `#rrggbb`.
export const blendHex = (top, bottom, alpha) => hex(over({ ...parseColor(top), a: alpha }, parseColor(bottom)))

// The map's links: `{ color, width }`. `surface` is the colour the map blends its muted colours into (the chart surface).
export const linkStyle = (level, { inkMuted, surface }) => {
  const { link, linkWidth } = strengthOf(level)

  return { color: blendHex(inkMuted, surface, link), width: linkWidth }
}

// The colour of a dot of the map's grid. Emphasised gives the border colour as it is.
export const gridDotColor = (level, { border, background }) => {
  const { gridDot } = strengthOf(level)

  return gridDot === 1 ? border : blendHex(border, background, gridDot)
}

// The ink of a system's name: the level's for a system with nothing to report, and the preset's ink for a system Show marks (a selected system is drawn in the ink by the style's own rule).
export const labelInk = (level, { ink, inkMuted }, marked) => (marked || strengthOf(level).secondaryInk === 'ink' ? ink : inkMuted)

// The on-screen size under which a system's name is left out. A system Show marks keeps the size the names have always had.
export const labelMinPx = (level, marked) => strengthOf(marked ? DEFAULT_HIERARCHY : level).labelMinPx

// The system view's secondary marks: the orbit lines' opacity and widths (a star's orbit is 1 wide, a body's 2) and the colour a body's name is drawn in. `space` is the appearance's sky.
export const skyStyle = (level, space) => {
  const { orbit, orbitWidth, skyLabel } = strengthOf(level)

  return { orbit: { alpha: orbit, starWidth: orbitWidth, bodyWidth: 2 * orbitWidth }, bodyLabel: skyLabel === 1 ? space.label : blendHex(space.label, space.background, skyLabel) }
}

// A chart's gridlines: the axis colour at the level's opacity, as `#rrggbbaa`.
export const chartGridColor = (level, axis) => `${axis}${Math.round(strengthOf(level).chartGrid * 255).toString(16).padStart(2, '0')}`
