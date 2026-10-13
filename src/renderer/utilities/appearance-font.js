import Vue from 'vue'

// The typeface and text size of the app: one bounded choice that every renderer reads. A choice is `{ family, scale }`: `family` is the id of one of FONT_FAMILIES (never a CSS family typed by a person) and `scale` one of FONT_SCALES. Nothing else reaches a style, a canvas font or an SVG attribute.
//
// `fontRoles()` resolves the choice into the roles a renderer draws with: `body` (the DOM), `numeric` (the monospace of keys and figures), `chart` (Chart.js and the canvas of a chart), `map` (the canvas, Pixi and Cytoscape maps) and `svg` (text inside an SVG that is drawn as an image, which cannot use the fonts the page loaded), each a CSS family list, and `size(px)`, which scales a size in pixels. A family that is not available on this computer (a system face that is not installed, a bundled face that did not load) is replaced by FALLBACK, and `effective` says so in a sentence.
//
// The text size reaches the DOM through the root font size, so everything Vuetify sizes in rem follows it, and through `--ae-font-scale` for a size in pixels (`calc(12px * var(--ae-font-scale))`); canvas, Pixi, Cytoscape and SVG text take it from `size()`.
//
// What is kept is the record `{ family, scale }` under FONT_KEY (a value that names no choice is not loaded, stays in the settings as it is and is reported by `fontProblem()`). Like a colour preset, a choice is previewed first (`previewFont`) and kept by `applyFont`, which writes the record in one write, or by `resetFont`, which removes it.

export const FONT_KEY = 'appearanceFont'
export const FALLBACK = 'roboto'
export const DEFAULT_FONT = Object.freeze({ family: FALLBACK, scale: 1 })

const SANS_TAIL = '"Helvetica Neue", Arial, sans-serif'
const MONO = '"Roboto Mono", ui-monospace, Consolas, monospace'

// The offered families, in the order they are listed. `source` is `bundled` (shipped with the app, loaded by the page) or `system` (named only: installed with the operating system, or not). `face` is the name a bundled face is declared under, or the name a system face is looked up by; a family without one (the system's own interface and monospace faces) is always there. `stack` is the CSS family list drawn when the family is available and `numeric` the list for figures. `licence` and `origin` record what is shipped or named.
export const FONT_FAMILIES = Object.freeze([
  { id: 'roboto', name: 'Roboto', source: 'bundled', face: 'Roboto', stack: `Roboto, ${SANS_TAIL}`, numeric: MONO, licence: 'Apache License 2.0', origin: 'The roboto-fontface package (the Roboto family by Google), bundled with the app.', sample: 'The app\'s own typeface, bundled; every other choice falls back to it.' },
  { id: 'roboto-condensed', name: 'Roboto Condensed', source: 'bundled', face: 'Roboto-Condensed', stack: `"Roboto-Condensed", "Arial Narrow", Roboto, ${SANS_TAIL}`, numeric: MONO, licence: 'Apache License 2.0', origin: 'The roboto-fontface package (the Roboto Condensed family by Google), bundled with the app.', sample: 'A narrower face of the same family, for long labels and wide tables.' },
  { id: 'system', name: 'System UI', source: 'system', face: null, stack: `system-ui, "Segoe UI", ${SANS_TAIL}`, numeric: MONO, licence: 'Not bundled', origin: 'The interface font of the operating system, named by the CSS system-ui keyword.', sample: 'The face the operating system draws its own windows in.' },
  { id: 'verdana', name: 'Verdana', source: 'system', face: 'Verdana', stack: `Verdana, Geneva, ${SANS_TAIL}`, numeric: MONO, licence: 'Not bundled', origin: 'Installed with Windows and macOS; the app names it and ships none of it.', sample: 'A wide face with open letter shapes, when it is installed.' },
  { id: 'monospace', name: 'Monospace', source: 'system', face: null, stack: 'ui-monospace, Consolas, "Courier New", monospace', numeric: 'ui-monospace, Consolas, "Courier New", monospace', licence: 'Not bundled', origin: 'The monospace font of the operating system, named by the CSS ui-monospace and monospace keywords.', sample: 'Every character the same width, so columns of figures line up.' },
])

// The text sizes, as multiples of the base size (16 px on the root, 12 px of chart and map labels, and so on). The least is 90 % and the greatest 125 %: the page families still fit the minimum window there (docs/plans/backlog/evidence/AE-016-01.md).
export const FONT_SCALES = Object.freeze([0.9, 1, 1.1, 1.25])

// The weights the app draws bundled faces in; a face is loaded in each before text is measured.
const WEIGHTS = [400, 500, 700]

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

export const familyOf = (id) => FONT_FAMILIES.find((family) => family.id === id) || null

export const scaleLabel = (scale) => `${Math.round(scale * 100)} %`

// The family a name stands for, an id or a display name in any case, or null. It is how an appearance file's `font.family` resolves through the same choices.
export const familyByName = (name) => {
  const wanted = String(name).trim().toLowerCase()

  return FONT_FAMILIES.find((family) => family.id === wanted || family.name.toLowerCase() === wanted) || null
}

// Whether `value` is a record this version can use: `{ ok: true, font }` with a complete choice, or `{ ok: false, problem }` saying what is wrong.
export const readFont = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problem: 'The saved typeface is not a record of a family and a text size.' }
  }

  const problems = []

  if (!familyOf(value.family)) {
    problems.push(`the typeface "${String(value.family).slice(0, 40)}" is not one this version offers`)
  }

  if (!FONT_SCALES.includes(value.scale)) {
    problems.push(`the text size ${String(value.scale).slice(0, 20)} is not one this version offers`)
  }

  return problems.length ? { ok: false, problem: `The saved typeface cannot be used: ${problems.join(' and ')}.` } : { ok: true, font: { family: value.family, scale: value.scale } }
}

// What the choice resolves to when each family is or is not available: `isAvailable(id)` gives true, false or null (not known yet; taken as available, because a bundled face is declared and a system face is probed at once). Pure: it reads nothing.
const explain = (requested, effective, fellBack) => {
  if (fellBack) {
    return `${requested.name} is not ${requested.source === 'bundled' ? 'loaded' : 'installed on this computer'}, so ${effective.name}, the bundled typeface, is used instead.`
  }

  if (effective.source === 'bundled') {
    return `${effective.name} is bundled with the app.`
  }

  return effective.face ? `${effective.name} is installed on this computer.` : `${effective.name} is the face the operating system provides.`
}

export const resolveFont = ({ family, scale }, isAvailable = () => true) => {
  const requested = familyOf(family) || familyOf(FALLBACK)
  const fellBack = requested.id !== FALLBACK && isAvailable(requested.id) === false
  const effective = fellBack ? familyOf(FALLBACK) : requested
  const scaled = (px) => Math.round(px * scale * 100) / 100

  return { requested: requested.id, family: effective.id, fellBack, scale, explanation: explain(requested, effective, fellBack), body: effective.stack, numeric: effective.numeric, chart: effective.stack, map: effective.stack, svg: effective.stack, size: scaled }
}

// `id` and `scale` are the choice in force (what every renderer draws with), `applied` the last one kept. They differ while a preview is open. `available` holds what was found of each family (true or false), `revision` rises when a bundled face has loaded, so a renderer that read the roles draws again with the real metrics.
const state = Vue.observable({ family: DEFAULT_FONT.family, scale: DEFAULT_FONT.scale, appliedFamily: DEFAULT_FONT.family, appliedScale: DEFAULT_FONT.scale, available: {}, revision: 0, problem: null })

const canProbe = () => typeof document !== 'undefined' && typeof document.createElement === 'function'

// Whether a system face is installed: its name in front of each of three generic families draws the same text at a different width than that generic family alone only when the face exists.
const probeSystem = (face) => {
  const context = document.createElement('canvas').getContext('2d')
  const sample = 'mmmmmmmmmmlli.,WQ 0123456789'
  const width = (list) => {
    context.font = `72px ${list}`

    return context.measureText(sample).width
  }

  return ['monospace', 'serif', 'sans-serif'].some((generic) => width(`"${face}", ${generic}`) !== width(generic))
}

// Looks up every system face that has a name once, so that resolving the roles inside a render writes nothing. A face installed while the app runs is found at the next start.
const probeSystemFaces = () => {
  if (canProbe()) {
    FONT_FAMILIES.filter((family) => family.source === 'system' && family.face && !hasOwn(state.available, family.id)).forEach((family) => Vue.set(state.available, family.id, probeSystem(family.face)))
  }
}

// True or false for a family that was looked up or loaded, null for one that was not (taken as available: a bundled face is declared, and a system face is looked up at once).
const isAvailable = (id) => (hasOwn(state.available, id) ? state.available[id] : null)

const choice = () => ({ family: state.family, scale: state.scale })

// A number that rises each time a face has loaded or a system face was looked up. A renderer that measures text keeps what it measured with the number it read, and measures again when it changes; reading it inside a computed property or a render makes that one depend on the load.
export const fontRevision = () => state.revision

// The roots read in a render: the choice in force, resolved. Read inside a computed property, a render or a watcher, it makes that one depend on the choice, on what was found of the families and on the load of the bundled faces.
export const fontRoles = (value = choice()) => {
  fontRevision()

  return resolveFont(value, isAvailable)
}

// What was found of a family, for Settings to show beside it: `available` (false only for a family that is not installed or did not load) and a short `text`. Reactive.
export const familyStatus = (id) => {
  fontRevision()

  const family = familyOf(id)
  const found = isAvailable(id)

  if (found === false) {
    return { available: false, text: `${family.source === 'bundled' ? 'Did not load' : 'Not installed on this computer'}; ${familyOf(FALLBACK).name} is used instead` }
  }

  return { available: true, text: family.source === 'bundled' ? 'Bundled with the app' : family.face ? 'Installed on this computer' : 'Provided by the operating system' }
}

// The choice in force (reactive), the applied one, and whether a preview is open.
export const fontInForce = () => choice()

export const appliedFont = () => ({ family: state.appliedFamily, scale: state.appliedScale })

export const isFontPreviewing = () => state.family !== state.appliedFamily || state.scale !== state.appliedScale

// What kept the saved choice from loading (a sentence), or null.
export const fontProblem = () => state.problem

// The font roles as the CSS custom properties and the root size the stylesheet reads: `--ae-font`, `--ae-mono`, `--ae-font-scale` on the root element and `font-size` there, so Vuetify's sizes in rem follow the text size.
export const fontStyle = (roles = fontRoles()) => ({ '--ae-font': roles.body, '--ae-mono': roles.numeric, '--ae-font-scale': String(roles.scale), 'font-size': `${16 * roles.scale}px` })

const syncRoot = () => {
  if (typeof document === 'undefined' || !document.documentElement) {
    return
  }

  const root = document.documentElement.style

  Object.entries(fontStyle()).forEach(([name, value]) => root.setProperty(name, value))
}

const faceLoads = new Map()

// Loads a bundled face in every weight the app draws it in, once, and records whether it loaded: a failed face is unavailable, so the roles fall back to Roboto.
const loadFace = (family) => {
  if (!faceLoads.has(family.id)) {
    faceLoads.set(family.id, Promise.all(WEIGHTS.map((weight) => document.fonts.load(`${weight} 16px "${family.face}"`, 'Aa 0123')))
      .then((faces) => faces.every((list) => list.length > 0 && list.every((face) => face.status === 'loaded')))
      .catch(() => false)
      .then((ok) => {
        Vue.set(state.available, family.id, ok)
        state.revision++
        syncRoot()
      }))
  }

  return faceLoads.get(family.id)
}

// Resolves once the bundled faces the choice in force can draw in (it and Roboto, the fallback) are loaded and the document's own font loading is done. A canvas, Pixi or an SVG that measures text before that measures the fallback, so every renderer waits for this before it measures or exports text; one that read the roles draws again when a face has loaded (`revision`). Without a document (a script) it resolves at once.
export const whenFontsReady = () => {
  if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.load !== 'function') {
    return Promise.resolve()
  }

  return Promise.all([...new Set([FALLBACK, state.family])].map(familyOf).filter((family) => family.source === 'bundled').map(loadFace)).then(() => document.fonts.ready).then(() => undefined)
}

// Puts a choice in force without keeping it, so every page shows it. `patch` is `{ family }`, `{ scale }` or both; a value that is not one of the choices changes nothing. Writes nothing.
export const previewFont = (patch) => {
  if (hasOwn(patch, 'family') && familyOf(patch.family)) {
    state.family = patch.family
  }

  if (hasOwn(patch, 'scale') && FONT_SCALES.includes(patch.scale)) {
    state.scale = patch.scale
  }

  syncRoot()
  whenFontsReady().catch(() => undefined)
}

// Drops the preview: the applied choice is in force again.
export const cancelFontPreview = () => {
  state.family = state.appliedFamily
  state.scale = state.appliedScale
  syncRoot()
}

// Keeps the choice in force: writes it to the settings (`config` is the settings store) and makes it the applied one. The settings are written first, so a failed write leaves the choice as it was. The default is kept by removing the record.
const keep = (config, { family, scale }) => {
  if (family === DEFAULT_FONT.family && scale === DEFAULT_FONT.scale) {
    config.delete(FONT_KEY)
  } else {
    config.set(FONT_KEY, { family, scale })
  }

  state.family = family
  state.scale = scale
  state.appliedFamily = family
  state.appliedScale = scale
  state.problem = null
  syncRoot()
}

export const applyFont = (config) => keep(config, choice())

// Puts the bundled default (Roboto at 100 %) in force and keeps it, removing the record. The record is removed first, so a failed write leaves the choice in force and the kept one as they were.
export const resetFont = (config) => keep(config, DEFAULT_FONT)

// Reads the settings at start: a saved choice is applied, one that names no choice leaves the default in force and is not overwritten (only `applyFont` and `resetFont` write the key), and `fontProblem` says what was wrong. `config` is the settings store.
export const loadFont = (config) => {
  const stored = config.get(FONT_KEY)
  const read = stored === undefined ? { ok: true, font: DEFAULT_FONT } : readFont(stored)
  const font = read.ok ? read.font : DEFAULT_FONT

  state.family = font.family
  state.scale = font.scale
  state.appliedFamily = font.family
  state.appliedScale = font.scale
  state.problem = read.ok ? null : read.problem
  probeSystemFaces()
  syncRoot()
  whenFontsReady().catch(() => undefined)
}

// The root properties from the first render: the defaults, before a setting is read.
probeSystemFaces()
syncRoot()
