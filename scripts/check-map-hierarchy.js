/*
  Checks the visual hierarchy of the Galaxy Map, the system view and the charts (AE-022-01): src/renderer/utilities/map-hierarchy.js, map-export.js, the map page (pages/map.vue), the system view (components/SystemView.vue) and the chart canvas (components/charts/ChartCanvas.vue).

  node scripts/check-map-hierarchy.js [--no-mutations]

  What is held, for each of the seven presets and both levels (restrained, emphasised):
  - a dense scene (64 systems, 100 or more links) really changes between the levels: the links, the grid dots, the orbit lines of the system view and the gridlines of a chart keep at most 70 % of the contrast of the emphasised level over their surface, the names of the systems with nothing to report change ink and size, and emphasised is the look the app had before the option;
  - what carries meaning stays visible at both levels: the hazard, selection, contact and warning colours are the tokens AE-007 gates (utilities/appearance-contrast.js GRAPHIC_CHECKS, 3:1) and are drawn unscaled; a system that Show marks (by a glyph, or by a line under its name: a contact, a rift, a danger line, a ship, a flag, the date found and the rest) keeps its name in the full ink and at its old size, the sizes between the two thresholds included; the selected node and edge and the stabilised links keep their full width; the zero line of the flow charts that draw their own grid keeps its ink; and what recedes stays above the floor of its mark (3:1 for an orbit line, 4.5:1 for a name, and the FLOORS of the utility for the decorative marks);
  - the PNG is composed from the screen's state: `exportPng` runs for real against a recording canvas, and the dots of the grid, the background, the legend (every label, the jump-link example at the colour and thickness of the links on screen, the square, triangle or diamond of a merged border legend, labels wider than the picture wrapped within it) and the names of the borders come from the composition the page computes from the level in force;
  - the choice is one view preference, `mapHierarchy`, declared with `persistedView` by the map, the chart canvas and the two pages that draw their own gridlines: written on change, restored from a reopened store, a value no longer offered falls back to the default, Settings exports and imports it among the app-wide views, and the map's watcher of the level runs against observable stores and writes to none;
  - the label collision of the system view, the overlay controls and selection, the pan and zoom of the map, and the borders and the overview are as at the commit before the change (6b4e17a): the same source, and the level changes only the label ink and size of a system's data.

  Each mutation of the utilities, of the page, of the system view or of the chart canvas must fail the checks it names (UNSUPPORTED and a thrown check do not count as agreement), and a mutation that does not parse or whose text is not there exactly once is refused. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const vmModule = require('vm')
const { execFileSync } = require('child_process')
const Vue = require('vue')
const acorn = require('acorn')
const merge = require('lodash/merge')
const { parse: parseComponent } = require('vue/compiler-sfc')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const BASE = '6b4e17a'

const FILES = {
  map: 'src/renderer/pages/map.vue',
  system: 'src/renderer/components/SystemView.vue',
  chart: 'src/renderer/components/charts/ChartCanvas.vue',
  hierarchy: 'src/renderer/utilities/map-hierarchy.js',
  exporter: 'src/renderer/utilities/map-export.js',
  finances: 'src/renderer/pages/finances.vue',
  outlook: 'src/renderer/pages/mineral-outlook.vue',
}

const PRESET_IDS = ['light', 'dark', 'classic', 'solaris', 't2d', 'cristo', 'deepblue']
const LEVELS = ['restrained', 'emphasised']

Vue.config.productionTip = false
Vue.config.devtools = false

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const real = (specifier) => `import { createRequire } from 'node:module'\nexport default ${requireOf(specifier)}`
const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 240 ? `${text.slice(0, 240)}…` : text
}

const UTILITY_STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
}

const PAGE_STUBS = {
  vue: 'export default { observable: (value) => value }',
  cytoscape: 'const cytoscape = () => ({}); cytoscape.use = () => {}; export default cytoscape',
  'cytoscape-cxtmenu': 'export default {}',
  'cytoscape-fcose': 'export default {}',
  'cytoscape-cola': 'export default {}',
  'lodash/groupBy': real('lodash/groupBy'),
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
  electron: 'export const ipcRenderer = { invoke: (...args) => globalThis.__ipc(...args) }',
}

const FONT_ROLES = "({ family: 'Test, sans-serif', svg: 'Test', map: 'Test, sans-serif', chart: 'Test, sans-serif', scale: 1, size: (px) => px })"

const PAGE_MODULES = {
  'utilities/appearance': 'export const activeAppearance = () => globalThis.__appearance\nexport const MAP_MENU = { fillAlpha: 0.88, activeSlot: 2, activeAlpha: 0.9 }',
  'utilities/appearance-font': `export const fontRoles = () => ${FONT_ROLES}\nexport const whenFontsReady = () => Promise.resolve()`,
  'components/charts/theme': `
    export const chartTheme = (a) => ({ surface: a.surfaces.card, ink: a.inks.body, inkMuted: a.inks.muted, border: a.charts.axis, primary: a.focus.primary, categorical: a.charts.categorical })
    export const mapFont = (roles) => ({ family: roles.map, size: roles.size, font: (px, weight = 400) => weight + ' ' + roles.size(px) + 'px ' + roles.map })
    export const markerPoints = () => null
    export const seriesIdentity = () => null
  `,
}

const PERSISTED_VIEW = fs.readFileSync(path.join(renderer, 'mixins', 'persisted-view.js'), 'utf8')

// Modules are cached by their text, and the registry of declared views lives in the module: each context gets a copy of its own, so a mutant sees only what its own page declares.
let loads = 0
const unique = (text) => `${text}\n// context ${++loads}\n`

// ---------- sources ----------

const readTexts = () => Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), 'utf8')]))

const scriptOf = (text) => {
  const parsed = parseComponent({ source: text })
  const descriptor = parsed.descriptor || parsed

  return (descriptor.script && descriptor.script.content) || ''
}

const walk = (node, visit) => {
  if (!node || typeof node.type !== 'string') {
    return
  }

  visit(node)

  for (const key of Object.keys(node)) {
    const value = node[key]

    if (Array.isArray(value)) {
      value.forEach((child) => child && typeof child === 'object' && walk(child, visit))
    } else if (value && typeof value === 'object') {
      walk(value, visit)
    }
  }
}

// The source of the method (or of any function-valued property) of that name in a component's script, or null.
const methodSource = (text, name, isComponent = true) => {
  const script = isComponent ? scriptOf(text) : text
  let found = null

  walk(acorn.parse(script, { ecmaVersion: 'latest', sourceType: 'module', ranges: true }), (node) => {
    if (!found && node.type === 'Property' && !node.computed && (node.key.name || node.key.value) === name && node.value.type === 'FunctionExpression') {
      found = script.slice(node.start, node.end)
    }
  })

  return found
}

const atBase = (file) => execFileSync('git', ['show', `${BASE}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// ---------- the world: the changed sources over a copy of the renderer's utilities ----------

const worldOf = (texts) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-hierarchy-'))

  fs.cpSync(path.join(renderer, 'utilities'), path.join(directory, 'utilities'), { recursive: true })
  fs.cpSync(path.join(renderer, 'mixins'), path.join(directory, 'mixins'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'pages'))
  fs.writeFileSync(path.join(directory, 'utilities', 'map-hierarchy.js'), texts.hierarchy)
  fs.writeFileSync(path.join(directory, 'utilities', 'map-export.js'), texts.exporter)
  fs.writeFileSync(path.join(directory, 'pages', 'map.vue'), texts.map)

  return directory
}

const contextOf = async (texts) => {
  const directory = worldOf(texts)

  try {
    const m = await loadUtilities(['appearance', 'appearance-contrast', 'map-hierarchy', 'map-export', 'preferences'], { directory: path.join(directory, 'utilities'), stubs: UTILITY_STUBS })
    const options = await loadPage('pages/map', { directory, stubs: PAGE_STUBS, modules: PAGE_MODULES })
    const persisted = await loadPage('pages/map', { directory, stubs: PAGE_STUBS, modules: { ...PAGE_MODULES, 'mixins/persisted-view': `${unique(PERSISTED_VIEW)}\nglobalThis.__declaredViews = declaredViews\n` } })
    const declared = globalThis.__declaredViews()
    const view = await import(dataUrl(unique(PERSISTED_VIEW)))
    const appearances = Object.fromEntries(PRESET_IDS.map((id) => [id, m.appearance.resolveAppearance(id)]))

    return { m, options, persisted, declared, view, appearances, texts, cache: new Map() }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// ---------- the dense scene ----------

const SCENE_SIZE = 96
const COLUMNS = 8
// The systems Show marks in the scene by a contact, a rift, a danger line, a ship or a flag: the others have nothing to report.
const MARKED = new Set()
const SYSTEMS = Array.from({ length: SCENE_SIZE }, (_value, index) => {
  const id = index + 1
  const danger = index % 7 === 3 ? 40 : 0

  if ([index % 6 === 2, index % 10 === 4, danger > 0, index % 8 === 1, index % 9 === 5].some(Boolean)) {
    MARKED.add(String(id))
  }

  return { SystemID: id, Name: `System ${id}`, Xcor: (index % COLUMNS) * 60, Ycor: Math.floor(index / COLUMNS) * 60, Bodies: 4, SurveyedBodies: index % 5, Planets: 3, Comets: 0, GroundSurveys: index % 3, Colonies: index % 5 === 0 ? 1 : 0, Population: index % 5 === 0 ? 12 : 0, PopulationReported: 1, Capital: index === 0 ? 1 : 0, DangerRating: danger, NoAutoRoute: index % 9 === 5 ? 1 : 0, Stars: 1, SpectralClass: 'G', SizeText: 'V', DiscoveredTime: 1000 * id, X: index, Y: index * 2, Z: 0 }
})

const JUMP_POINTS = []

SYSTEMS.forEach((system, index) => {
  [[index % COLUMNS < COLUMNS - 1, index + 1], [index + COLUMNS < SCENE_SIZE, index + COLUMNS]].forEach(([exists, other]) => {
    if (exists) {
      const a = system.SystemID
      const b = other + 1
      const strength = index % 9 === 0 ? 5 : 0
      const strengthBack = index % 9 === 0 || index % 11 === 0 ? 5 : 0

      JUMP_POINTS.push({ WarpPointID: a * 1000 + b, SystemID: a, WPLink: b * 1000 + a, Explored: 1, JumpGateStrength: strength, Xcor: 0, Ycor: 0 })
      JUMP_POINTS.push({ WarpPointID: b * 1000 + a, SystemID: b, WPLink: a * 1000 + b, Explored: 1, JumpGateStrength: strengthBack, Xcor: 0, Ycor: 0 })
    }
  })
})

const NONE = { ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, military: 0, ships: 0, shipyards: 0, waypoints: 0, contacts: [] }
const FEATURES = Object.fromEntries(SYSTEMS.map((system, index) => [String(system.SystemID), { ...NONE, contacts: index % 6 === 2 ? [{ status: 'hostile' }] : [], rifts: index % 10 === 4 ? 1 : 0, ships: index % 8 === 1 ? 2 : 0, military: index % 8 === 1 ? 1 : 0 }]))

const sceneData = (level, extra = {}) => ({ systems: SYSTEMS, jumpPoints: JUMP_POINTS, sectors: [], aliens: [], features: FEATURES, habitability: null, formulaVersion: null, marks: ['contacts', 'rifts', 'danger', 'ships', 'flags'], hierarchy: level, layer: 'geological', borders: 'none', activateSnackbar: () => {}, ...extra })

const storeOf = () => ({ getters: { StartYear: 2050, GameTime: 12345, racePrefix: null, config: { get: (_key, fallback) => fallback } } })

// What each overlay of Show marks in the scene: every third system, by a glyph from the features or a change to the systems.
const OVERLAYS = [
  { mark: 'ships', features: { ships: 2, military: 1 } },
  { mark: 'wrecks', features: { wrecks: 1 } },
  { mark: 'shipyards', features: { shipyards: 1 } },
  { mark: 'waypoints', features: { waypoints: 1 } },
  { mark: 'contacts', features: { contacts: [{ status: 'hostile', count: 1 }] } },
  { mark: 'rifts', features: { rifts: 1 } },
  { mark: 'flags', systems: (index) => ({ NoAutoRoute: index % 3 === 0 ? 1 : 0 }) },
  { mark: 'discovered', systems: (index, system) => ({ DiscoveredTime: index % 3 === 0 ? system.DiscoveredTime : 0 }) },
  { mark: 'danger', systems: (index) => ({ DangerRating: index % 3 === 0 ? 40 : 0 }) },
]

// The scene with one overlay selected: the page's markers of every system and its theme.
const overlayScene = (ctx, id, level, overlay) => {
  const systems = SYSTEMS.map((system, index) => ({ ...system, ...(overlay.systems ? overlay.systems(index, system) : {}) }))
  const features = Object.fromEntries(SYSTEMS.map((system, index) => [String(system.SystemID), { ...NONE, ...(overlay.features && index % 3 === 0 ? overlay.features : {}) }]))

  globalThis.__appearance = ctx.appearances[id]

  const vm = instantiate(ctx.options, { $store: storeOf(), GameID: 1, RaceID: 7, data: sceneData(level, { marks: [overlay.mark], systems, features }) })

  return { theme: vm.theme, entries: vm.systemRows.map((row) => ({ index: Number(row.id) - 1, node: vm.markerData(row) })) }
}

// What the page computes for one preset at one level, kept for the checks.
const evaluate = (ctx, id, level) => {
  const key = `${id}:${level}`

  if (!ctx.cache.has(key)) {
    const appearance = ctx.appearances[id]

    globalThis.__appearance = appearance

    const vm = instantiate(ctx.options, { $store: storeOf(), GameID: 1, RaceID: 7, data: sceneData(level) })
    const rows = vm.systemRows
    const sheet = vm.stylesheet()
    const nodes = Object.fromEntries(rows.map((row) => [row.id, vm.markerData(row)]))
    const glyphs = Object.fromEntries(rows.map((row) => [row.id, vm.glyphsOf(row).map((glyph) => glyph.name)]))

    ctx.cache.set(key, { appearance, vm, rows, sheet, nodes, glyphs, colors: vm.colors, theme: vm.theme, link: vm.linkLook, stage: vm.stageStyle, composition: vm.composition, legend: vm.legend, links: vm.links.list })
  }

  globalThis.__appearance = ctx.appearances[id]

  return ctx.cache.get(key)
}

const rule = (sheet, selector) => {
  const found = sheet.find((entry) => entry.selector === selector)

  if (!found) {
    throw new Error(`no style rule for ${selector}`)
  }

  return found.style
}

// ---------- measures ----------

class Unsupported extends Error {}

const contrast = (ctx, foreground, background) => {
  const { parseColor, over, ratio } = ctx.m['appearance-contrast']
  let value

  try {
    const below = parseColor(background)

    value = ratio(over(parseColor(foreground), below), below)
  } catch (error) {
    throw new Unsupported(`UNSUPPORTED: ${foreground} over ${background} cannot be measured (${error.message})`)
  }

  if (!Number.isFinite(value)) {
    throw new Unsupported(`UNSUPPORTED: ${foreground} over ${background} has no ratio`)
  }

  return value
}

// The opaque colour of `color` at `alpha` over `background`.
const laid = (ctx, color, alpha, background) => {
  const { parseColor, over, hex } = ctx.m['appearance-contrast']

  return hex(over({ ...parseColor(color), a: alpha }, parseColor(background)))
}

const excess = (value) => value - 1

// Every preset at every level, the problems of `look` (a string or a list of them) gathered.
const everywhere = (ctx, look) => {
  const problems = []

  PRESET_IDS.forEach((id) => LEVELS.forEach((level) => {
    const found = look(id, level, evaluate(ctx, id, level))

    ;(Array.isArray(found) ? found : found ? [found] : []).forEach((problem) => problems.push(`${id}/${level}: ${problem}`))
  }))

  return problems.length ? `${problems.length} problems: ${problems.slice(0, 3).join('; ')}` : true
}

// Per preset, what a mark's contrast over its surface is at each level, and whether the restrained one keeps at most `VISIBLE_CHANGE` of the emphasised contrast.
const visibleChange = (ctx, measure, detail = '') => {
  const { VISIBLE_CHANGE } = ctx.m['map-hierarchy']
  const problems = []

  PRESET_IDS.forEach((id) => {
    const [restrained, emphasised] = LEVELS.map((level) => measure(id, level, evaluate(ctx, id, level)))

    if (!(excess(restrained) <= VISIBLE_CHANGE * excess(emphasised))) {
      problems.push(`${id}: restrained ${restrained.toFixed(2)}:1 against emphasised ${emphasised.toFixed(2)}:1`)
    }
  })

  return problems.length ? `${detail}${problems.join('; ')}` : true
}

const orbitContrast = (ctx, appearance, level) => {
  const { skyStyle } = ctx.m['map-hierarchy']
  const { space } = appearance
  const style = skyStyle(level, space)

  return contrast(ctx, laid(ctx, space.bodyOrbit, style.orbit.alpha, space.background), space.background)
}

const skyLabelContrast = (ctx, appearance, level) => contrast(ctx, ctx.m['map-hierarchy'].skyStyle(level, appearance.space).bodyLabel, appearance.space.background)

const chartTheme = (appearance) => ({ surface: appearance.surfaces.card, ink: appearance.inks.body, inkMuted: appearance.inks.muted, border: appearance.charts.axis, primary: appearance.focus.primary, tooltip: appearance.charts.tooltip, tooltipInk: appearance.inks.onTooltip, categorical: appearance.charts.categorical })

// The options the real `resolvedOptions` of the chart canvas gives a chart of `type`, with the level the chart reads and the caller's `options` merged over its defaults.
const resolvedChart = (ctx, appearance, level, { options = {}, type = 'line' } = {}) => {
  const source = methodSource(ctx.texts.chart, 'resolvedOptions')

  if (!source) {
    throw new Unsupported('UNSUPPORTED: resolvedOptions is not in the chart canvas')
  }

  const canvas = vmModule.runInNewContext(`(function (merge, chartGridColor, labelColor) { return ({ ${source} }) })`)(merge, ctx.m['map-hierarchy'].chartGridColor, () => null)
  const typeface = { family: 'Test', size: (px) => px, font: (px) => `${px}px Test` }

  return canvas.resolvedOptions.call({ theme: chartTheme(appearance), typeface, type, options, hierarchy: level })
}

// The scales' grid colour the chart canvas gives by default, with the level the chart reads.
const chartGridOf = (ctx, appearance, level) => resolvedChart(ctx, appearance, level).scales.x.grid.color

const chartGridContrast = (ctx, appearance, level) => contrast(ctx, chartGridOf(ctx, appearance, level), appearance.surfaces.card)

// The pages that bring their own grid colour over the canvas's (their flow charts), and the axis it is on.
const CALLERS = [
  { name: 'Finances', key: 'finances', axis: 'y' },
  { name: 'Mineral Outlook', key: 'outlook', axis: 'x' },
]

// The colour of the gridline at `tick` in a page's flow chart: the `flowsOptions` of the page as its own source gives them, merged over the defaults by the real chart canvas.
const callerGridAt = (ctx, caller, appearance, level, tick) => {
  const source = methodSource(ctx.texts[caller.key], 'flowsOptions')

  if (!source) {
    throw new Unsupported(`UNSUPPORTED: flowsOptions is not in the ${caller.name} page`)
  }

  const page = vmModule.runInNewContext(`(function (chartGridColor, compact, statusText) { return ({ ${source} }) })`)(ctx.m['map-hierarchy'].chartGridColor, String, () => '')
  const options = page.flowsOptions.call({ theme: chartTheme(appearance), hierarchy: level })
  const { color } = resolvedChart(ctx, appearance, level, { options, type: 'bar' }).scales[caller.axis].grid

  return typeof color === 'function' ? color({ tick: { value: tick } }) : color
}

const linkContrast = (ctx, appearance, colors) => contrast(ctx, colors.link, appearance.surfaces.background)

const gridContrast = (ctx, appearance, stage) => contrast(ctx, stage['--map-grid'], appearance.surfaces.background)

// ---------- the PNG, run for real against a recording canvas ----------

const recordingContext = (log, perChar = 6) => {
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px Test', globalCompositeOperation: 'source-over', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt' }

  return new Proxy({}, {
    get: (_target, name) => {
      if (name in state) {
        return state[name]
      }

      if (name === 'measureText') {
        return (text) => ({ width: String(text).length * perChar })
      }

      return (...args) => log.push({ op: name, args, fillStyle: state.fillStyle, composite: state.globalCompositeOperation })
    },
    set: (_target, name, value) => {
      state[name] = value
      log.push({ op: 'set', name, value })

      return true
    },
  })
}

const runExport = async (ctx, id, level, { data = {}, perChar = 6 } = {}) => {
  const canvases = []
  const sent = []
  const snackbars = []
  const saved = { window: globalThis.window, document: globalThis.document, Image: globalThis.Image, Path2D: globalThis.Path2D, ipc: globalThis.__ipc }

  globalThis.window = { devicePixelRatio: 1 }
  const createElement = () => {
    const log = []
    const canvas = { log, width: 0, height: 0, getContext: () => recordingContext(log, perChar), toDataURL: () => 'data:image/png;base64,AAAA' }

    canvases.push(canvas)

    return canvas
  }

  globalThis.document = { createElement }
  globalThis.Image = class { async decode() {} }
  globalThis.Path2D = class { constructor(d) { this.d = d } }
  globalThis.__ipc = async (...args) => {
    sent.push(args)

    return { canceled: false }
  }
  globalThis.__appearance = ctx.appearances[id]

  try {
    const graph = { elements: () => ({ boundingBox: () => ({ x1: 0, y1: 0, x2: 480, y2: 420, w: 480, h: 420 }) }), png: () => 'data:image/png;base64,', zoom: () => 1 }
    const vm = instantiate(ctx.options, { $store: storeOf(), GameID: 1, RaceID: 7, data: sceneData(level, { graph, setZoomStyle: () => {}, markersReady: async () => {}, borderLabels: () => [], borderGeometry: () => ({ positionOf: () => null, sizeOf: () => 10 }), activateSnackbar: (message) => snackbars.push(message), ...data }) })

    await vm.exportPng()

    const target = canvases.find((canvas) => canvas.log.some((entry) => entry.op === 'fillRect'))

    if (!target) {
      throw new Unsupported(`UNSUPPORTED: no canvas was drawn on (${short(snackbars)})`)
    }

    return { vm, canvases, target, sent, snackbars, composition: vm.composition, colors: vm.colors, link: vm.linkLook, stage: vm.stageStyle, rows: vm.legendRows }
  } finally {
    Object.entries({ window: saved.window, document: saved.document, Image: saved.Image, Path2D: saved.Path2D, __ipc: saved.ipc }).forEach(([name, value]) => {
      if (value === undefined) {
        delete globalThis[name]
      } else {
        globalThis[name] = value
      }
    })
  }
}

const MAP_HEIGHT = 460

// ---------- the persisted view over real Vue ----------

class MemoryConfig {
  constructor(entries = []) {
    this.values = new Map(entries)
    this.writes = []
  }

  get(key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set(key, value) {
    this.values.set(key, JSON.stringify(value))
    this.writes.push([key, value])
  }

  has(key) {
    return this.values.has(key)
  }

  reopened() {
    return new MemoryConfig([...this.values])
  }
}

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const mountView = (mixin, config) => {
  const store = Vue.observable({ getters: { racePrefix: 'campaign.c1.race.7', config } })

  return new Vue({
    mixins: [mixin],
    beforeCreate() {
      this.$store = store
    },
    render: (h) => h('div'),
  })
}

const pageMixin = (ctx) => ctx.persisted.mixins.find((mixin) => mixin.watch && mixin.watch.hierarchy)

const chartMixin = (ctx) => {
  const expression = /mixins:\s*\[(persistedView\(\{[^\]]*\}\))\]/.exec(scriptOf(ctx.texts.chart))

  if (!expression) {
    throw new Unsupported('UNSUPPORTED: the chart canvas declares no persistedView mixin')
  }

  return vmModule.runInNewContext(`(function (persistedView, hierarchyView) { return ${expression[1]} })`)(ctx.view.default, ctx.m['map-hierarchy'].hierarchyView)
}

// The persisted view a page declares, rebuilt from its own source: its `persistedView({...})` call evaluated with the real persisted view and stand-ins for the constants the page defines.
const pageViewOf = (ctx, caller) => {
  const script = scriptOf(ctx.texts[caller.key])
  let call = null

  walk(acorn.parse(script, { ecmaVersion: 'latest', sourceType: 'module', ranges: true }), (node) => {
    if (!call && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'persistedView') {
      call = script.slice(node.start, node.end)
    }
  })

  if (!call) {
    throw new Unsupported(`UNSUPPORTED: the ${caller.name} page declares no persistedView mixin`)
  }

  const standIn = () => new Proxy(function () {}, { get: () => standIn(), apply: () => standIn() })
  const known = { persistedView: ctx.view.default, hierarchyView: ctx.m['map-hierarchy'].hierarchyView, oneOf: ctx.view.oneOf, tableView: ctx.view.tableView }
  const scope = new Proxy({}, { has: (_target, key) => typeof key === 'string', get: (_target, key) => (typeof key === 'symbol' ? undefined : key in known ? known[key] : standIn()) })

  return vmModule.runInNewContext(`(function (scope) { with (scope) { return ${call} } })`)(scope)
}

// Everything a consumer could keep outside the view mechanism while `restore` has not been called: the two browser stores (also through window), and the main process. Each write is recorded in `writes`.
const spied = (writes) => {
  const kept = ['localStorage', 'sessionStorage', 'window', '__ipc'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  const browserStore = (name) => ({ getItem: () => null, setItem: (key) => writes.push(`${name}.setItem(${key})`), removeItem: (key) => writes.push(`${name}.removeItem(${key})`), clear: () => writes.push(`${name}.clear()`) })
  const local = browserStore('localStorage')
  const session = browserStore('sessionStorage')
  const put = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

  put('localStorage', local)
  put('sessionStorage', session)
  put('window', { localStorage: local, sessionStorage: session, devicePixelRatio: 1 })
  put('__ipc', async (channel) => {
    writes.push(`ipc ${channel}`)

    return null
  })

  return () => kept.forEach(([name, descriptor]) => (descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]))
}

// ---------- the checks ----------

const ESSENTIAL_PATHS = ['focus.primary', 'severity.action', 'severity.attention', 'contacts.hostile', 'contacts.unknown', 'contacts.neutral', 'contacts.friendly', 'contacts.allied', 'contacts.civilian']

const CHECKS = []

const check = (id, name, run) => CHECKS.push({ id, name, run })

// --- a visible change between the levels, on a dense scene

check('V1', 'visible change: two levels are offered, emphasised is the default and a level the app does not offer is none', (ctx) => {
  const { HIERARCHY_LEVELS, DEFAULT_HIERARCHY, hierarchyView, isHierarchy } = ctx.m['map-hierarchy']

  return HIERARCHY_LEVELS.map((level) => level.value).join() === 'restrained,emphasised' && DEFAULT_HIERARCHY === 'emphasised' && hierarchyView.default === 'emphasised' && isHierarchy('restrained') && isHierarchy('emphasised') && !isHierarchy('loud') && !isHierarchy(undefined) ? true : short([HIERARCHY_LEVELS, DEFAULT_HIERARCHY, hierarchyView])
})

check('V2', 'visible change: the scene is dense and the levels differ on most of it', (ctx) => {
  const restrained = evaluate(ctx, 'light', 'restrained')
  const emphasised = evaluate(ctx, 'light', 'emphasised')
  const renamed = restrained.rows.filter((row) => restrained.nodes[row.id].labelInk !== emphasised.nodes[row.id].labelInk).length
  const thinner = restrained.links.filter((link) => link.gate === 'none').length

  return restrained.rows.length >= 60 && restrained.links.length >= 100 && renamed >= 40 && thinner >= 60 && rule(restrained.sheet, 'edge').width < rule(emphasised.sheet, 'edge').width ? true : `${restrained.rows.length} systems, ${restrained.links.length} links, ${renamed} names change ink, ${thinner} plain links`
})

check('V3', 'visible change: links keep at most 70 % of the contrast and are thinner at the restrained level', (ctx) => {
  const widths = everywhere(ctx, (_id, level, scene) => {
    const { STRENGTHS } = ctx.m['map-hierarchy']
    const width = rule(scene.sheet, 'edge').width

    return width === STRENGTHS[level].linkWidth && rule(scene.sheet, 'edge')['line-color'] === scene.colors.link ? null : `the edge style is ${width} ${rule(scene.sheet, 'edge')['line-color']}, the colour of the links ${scene.colors.link}`
  })
  const contrasts = visibleChange(ctx, (_id, _level, scene) => linkContrast(ctx, scene.appearance, scene.colors), 'links: ')

  return widths === true ? contrasts : widths
})

check('V4', 'visible change: grid dots of the stage keep at most 70 % of the contrast at the restrained level', (ctx) => visibleChange(ctx, (_id, _level, scene) => gridContrast(ctx, scene.appearance, scene.stage), 'grid: '))

check('V5', 'visible change: names of systems with nothing to report are muted at 11 px at the restrained level, and inked at 9 px at the emphasised', (ctx) => everywhere(ctx, (_id, level, scene) => {
  const quiet = scene.rows.filter((row) => !MARKED.has(row.id))
  const wanted = level === 'restrained' ? [scene.theme.inkMuted, 11] : [scene.theme.ink, 9]
  const wrong = quiet.filter((row) => scene.nodes[row.id].labelInk !== wanted[0] || scene.nodes[row.id].labelMinPx !== wanted[1])

  return wrong.length || !quiet.length ? `${wrong.length} of ${quiet.length} names are not ${wanted.join(' / ')} (first: ${short(wrong[0] && [scene.nodes[wrong[0].id].labelInk, scene.nodes[wrong[0].id].labelMinPx])})` : null
}))

check('V6', 'visible change: orbit lines and names of bodies in the system view keep at most 70 % of the contrast (orbit lines) and are dimmer (names) at the restrained level', (ctx) => {
  const orbits = visibleChange(ctx, (id, level) => orbitContrast(ctx, ctx.appearances[id], level), 'orbits: ')
  const names = PRESET_IDS.filter((id) => ctx.m['map-hierarchy'].skyStyle('restrained', ctx.appearances[id].space).bodyLabel === ctx.m['map-hierarchy'].skyStyle('emphasised', ctx.appearances[id].space).bodyLabel)

  return orbits === true ? (names.length ? `the names of bodies do not change in ${names.join(', ')}` : true) : orbits
})

check('V7', 'visible change: gridlines of a chart (the real resolvedOptions of the chart canvas) keep at most 70 % of the contrast at the restrained level', (ctx) => visibleChange(ctx, (id, level) => chartGridContrast(ctx, ctx.appearances[id], level), 'chart: '))

check('V8', 'visible change: emphasised draws what the app drew before the option', (ctx) => everywhere(ctx, (_id, level, scene) => {
  if (level !== 'emphasised') {
    return null
  }

  const { appearance, theme } = scene
  const problems = []
  const { blendHex, skyStyle } = ctx.m['map-hierarchy']
  const sky = skyStyle('emphasised', appearance.space)

  if (scene.colors.link !== blendHex(theme.inkMuted, theme.surface, 0.6) || rule(scene.sheet, 'edge').width !== 3) problems.push(`links ${scene.colors.link} ${rule(scene.sheet, 'edge').width}`)
  if (scene.stage['--map-grid'] !== appearance.surfaces.border) problems.push(`grid ${scene.stage['--map-grid']}`)
  if (Object.values(scene.nodes).some((node) => node.labelInk !== theme.ink || node.labelMinPx !== 9)) problems.push('names')
  if (chartGridOf(ctx, appearance, 'emphasised') !== `${appearance.charts.axis}99`) problems.push(`chart grid ${chartGridOf(ctx, appearance, 'emphasised')}`)
  if (sky.orbit.alpha !== 1 || sky.orbit.starWidth !== 1 || sky.orbit.bodyWidth !== 2 || sky.bodyLabel !== appearance.space.label) problems.push(`sky ${short(sky)}`)

  return problems
}))

check('V9', 'visible change: the gridlines of the flow charts of Finances and Mineral Outlook, which bring their own grid colour, keep at most 70 % of the contrast at the restrained level once resolved through the real chart canvas, and are drawn as before at the emphasised', (ctx) => {
  const problems = []

  CALLERS.forEach((caller) => {
    const seen = visibleChange(ctx, (id, level) => contrast(ctx, callerGridAt(ctx, caller, ctx.appearances[id], level, 5), ctx.appearances[id].surfaces.card), `${caller.name}: `)
    const changed = PRESET_IDS.filter((id) => callerGridAt(ctx, caller, ctx.appearances[id], 'emphasised', 5) !== `${ctx.appearances[id].charts.axis}99`)

    if (seen !== true) problems.push(seen)
    if (changed.length) problems.push(`${caller.name}: at the emphasised level the gridline is not the axis colour at 60 % in ${changed.join(', ')}`)
  })

  return problems.length ? problems.join('; ') : true
})

// --- what carries meaning stays visible

check('E1', 'essential: the hazard, selection, contact and warning colours are the tokens AE-007 gates, and clear 3:1 on every surface of every preset', (ctx) => {
  const { GRAPHIC, GRAPHIC_CHECKS, SURFACES, at } = ctx.m['appearance-contrast']
  const gated = new Set(GRAPHIC_CHECKS.map(([, path]) => path))
  const problems = ESSENTIAL_PATHS.filter((path) => !gated.has(path)).map((path) => `${path} is not in GRAPHIC_CHECKS`)

  PRESET_IDS.forEach((id) => {
    const appearance = ctx.appearances[id]
    const colors = [...ESSENTIAL_PATHS.map((path) => [path, at(appearance, path)]), ['danger (categorical 7)', appearance.charts.categorical[7]], ['rift (categorical 4)', appearance.charts.categorical[4]], ['stabilised link (categorical 6)', appearance.charts.categorical[6]]]

    colors.forEach(([label, color]) => SURFACES.forEach((surface) => {
      const value = contrast(ctx, color, at(appearance, surface))

      if (value < GRAPHIC) {
        problems.push(`${id}: ${label} ${color} on ${surface} is ${value.toFixed(2)}:1`)
      }
    }))
  })

  return problems.length ? `${problems.length}: ${problems.slice(0, 3).join('; ')}` : true
})

check('E2', 'essential: at both levels the map draws hazards, contacts, the selection and the stabilised links in the tokens, unscaled', (ctx) => everywhere(ctx, (_id, _level, scene) => {
  const { appearance, colors, sheet } = scene
  const problems = []
  const [, , , , , , violet, red] = appearance.charts.categorical

  if (colors.danger !== red || colors.rift !== appearance.charts.categorical[4] || colors.primary !== appearance.focus.primary || colors.gate !== violet || JSON.stringify(colors.contacts) !== JSON.stringify(appearance.contacts)) problems.push('a colour is not its token')

  const selected = rule(sheet, 'node:selected')

  if (selected['border-color'] !== appearance.focus.primary || selected['border-width'] !== 5 || selected.color !== scene.theme.ink || selected['min-zoomed-font-size'] !== 9) problems.push(`the selected node is ${short(selected)}`)

  if (Object.values(scene.glyphs).flat().filter((name) => name.startsWith('contacts-')).length < 5 || !Object.values(scene.glyphs).flat().includes('rifts')) problems.push('the scene shows no contacts or rifts')

  return problems
}))

check('E3', 'essential: names of systems Show marks (a contact, a rift, a danger line, a ship, a flag) keep the ink at 9 px, and every name stays readable (4.5:1)', (ctx) => everywhere(ctx, (_id, _level, scene) => {
  const { TEXT } = ctx.m['appearance-contrast']
  const problems = []
  const kept = scene.rows.filter((row) => MARKED.has(row.id))
  const loose = kept.filter((row) => scene.nodes[row.id].labelInk !== scene.theme.ink || scene.nodes[row.id].labelMinPx !== 9)

  if (loose.length || kept.length < 20) problems.push(`${loose.length} of ${kept.length} marked names are not at the full ink and 9 px`)

  new Set(Object.values(scene.nodes).map((node) => node.labelInk)).forEach((ink) => {
    const value = contrast(ctx, ink, scene.appearance.surfaces.card)

    if (value < TEXT) problems.push(`a name in ${ink} is ${value.toFixed(2)}:1`)
  })

  return problems
}))

check('E4', 'essential: the selected edge and the stabilised links keep their full width at both levels', (ctx) => everywhere(ctx, (_id, _level, scene) => {
  const problems = []
  const picked = rule(scene.sheet, 'edge.hover, edge:selected')
  const widthOf = (gate) => (typeof picked.width === 'function' ? picked.width({ data: () => gate }) : picked.width)

  if (widthOf('none') !== 3 || widthOf('both') !== 5 || picked['line-color'] !== scene.colors.primary) problems.push(`the picked edge is ${widthOf('none')}/${widthOf('both')} in ${picked['line-color']}`)
  if (rule(scene.sheet, 'edge[gate = "both"]').width !== 5 || rule(scene.sheet, 'edge[gate = "source"]').width !== 3 || rule(scene.sheet, 'edge[gate = "target"]').width !== 3) problems.push('a stabilised link is scaled')
  if (rule(scene.sheet, 'edge[gate = "source"]')['line-color'] !== scene.colors.gate) problems.push('a one-way link is not in the gate colour')

  return problems
}))

check('E5', 'essential: orbit lines stay at 3:1 over the sky at both levels (the AE-007 floor of the system view)', (ctx) => {
  const { GRAPHIC } = ctx.m['appearance-contrast']

  return ctx.m['map-hierarchy'].FLOORS.orbit === GRAPHIC ? everywhere(ctx, (id, level) => {
    const value = orbitContrast(ctx, ctx.appearances[id], level)

    return value >= GRAPHIC ? null : `an orbit line is ${value.toFixed(2)}:1`
  }) : `the floor of the orbit lines is ${ctx.m['map-hierarchy'].FLOORS.orbit}, not ${GRAPHIC}`
})

check('E6', 'essential: names of bodies stay at 4.5:1 over the sky at both levels (the AE-007 floor of the sky labels)', (ctx) => {
  const { TEXT } = ctx.m['appearance-contrast']

  return ctx.m['map-hierarchy'].FLOORS.skyLabel === TEXT ? everywhere(ctx, (id, level) => {
    const value = skyLabelContrast(ctx, ctx.appearances[id], level)

    return value >= TEXT ? null : `a name is ${value.toFixed(2)}:1`
  }) : `the floor of the sky labels is ${ctx.m['map-hierarchy'].FLOORS.skyLabel}, not ${TEXT}`
})

check('E7', 'essential: links stay apart from the stage at both levels', (ctx) => everywhere(ctx, (_id, _level, scene) => {
  const value = linkContrast(ctx, scene.appearance, scene.colors)

  return value >= ctx.m['map-hierarchy'].FLOORS.link ? null : `a link is ${value.toFixed(2)}:1, under ${ctx.m['map-hierarchy'].FLOORS.link}`
}))

check('E8', 'essential: grid dots stay apart from the stage at both levels', (ctx) => everywhere(ctx, (_id, _level, scene) => {
  const value = gridContrast(ctx, scene.appearance, scene.stage)

  return value >= ctx.m['map-hierarchy'].FLOORS.gridDot ? null : `a dot is ${value.toFixed(2)}:1, under ${ctx.m['map-hierarchy'].FLOORS.gridDot}`
}))

check('E9', 'essential: chart gridlines stay apart from the chart at both levels', (ctx) => everywhere(ctx, (id, level) => {
  const value = chartGridContrast(ctx, ctx.appearances[id], level)

  return value >= ctx.m['map-hierarchy'].FLOORS.chartGrid ? null : `a gridline is ${value.toFixed(2)}:1, under ${ctx.m['map-hierarchy'].FLOORS.chartGrid}`
}))

check('E10', 'essential: a system that any overlay of Show marks, by a glyph or a line under its name, keeps the full ink and the 9 px threshold at both levels and shows its name at 10 px, while a system with nothing to report recedes at the restrained level', (ctx) => {
  const problems = []
  const RENDERED = 10

  OVERLAYS.forEach((overlay) => LEVELS.forEach((level) => {
    const { theme, entries } = overlayScene(ctx, 'light', level, overlay)
    const marked = entries.filter(({ index }) => index % 3 === 0)
    const quiet = entries.filter(({ index }) => index % 3 !== 0)
    const shows = ({ node }) => RENDERED >= node.labelMinPx
    const strayed = entries.filter(({ index, node }) => node.marked !== (index % 3 === 0))
    const loose = marked.filter((entry) => entry.node.labelInk !== theme.ink || entry.node.labelMinPx !== 9 || !shows(entry))
    const wrong = quiet.filter(({ node }) => (level === 'restrained' ? node.labelInk !== theme.inkMuted || node.labelMinPx !== 11 : node.labelInk !== theme.ink || node.labelMinPx !== 9))
    const hidden = quiet.filter((entry) => !shows(entry)).length

    if (strayed.length || !marked.length || !quiet.length) problems.push(`${overlay.mark}/${level}: the scene marks ${strayed.length} systems other than the ones meant (${marked.length} marked, ${quiet.length} quiet)`)
    if (loose.length) problems.push(`${overlay.mark}/${level}: ${loose.length} of ${marked.length} marked names are not at the ink and 9 px, or are hidden at ${RENDERED} px`)
    if (wrong.length) problems.push(`${overlay.mark}/${level}: ${wrong.length} of ${quiet.length} quiet names are not what the level draws`)
    if (hidden !== (level === 'restrained' ? quiet.length : 0)) problems.push(`${overlay.mark}/${level}: ${hidden} of ${quiet.length} quiet names are hidden at ${RENDERED} px`)
  }))

  return problems.length ? `${problems.length}: ${problems.slice(0, 3).join('; ')}` : true
})

check('E11', 'essential: the system view dims the names of bodies only; stars and jump points keep the label colour', (ctx) => {
  const script = scriptOf(ctx.texts.system)
  const problems = []

  if (!/skyStyle\(this\.hierarchy, this\.appearance\.space\)/.test(script)) problems.push('the sky is not styled from the level')
  if (!/new PIXI\.Text\(String\(nameText\), this\._textStyles\.secondary\)/.test(script)) problems.push('the names of bodies do not use the secondary style')
  if (!/new PIXI\.Text\(labelText, this\._textStyles\.star\)/.test(script)) problems.push('the names of stars left the star style')
  if (!/new PIXI\.Text\(labelText, this\._textStyles\.body\)/.test(script)) problems.push('the names of jump points left the body style')
  if (!/orbitStyle: \{ alpha: sky\.orbit\.alpha, width: sky\.orbit\.starWidth \}/.test(script) || !/style: \{ color: this\._space\.bodyOrbit, alpha: sky\.orbit\.alpha, width: sky\.orbit\.bodyWidth \}/.test(script)) problems.push('the orbit lines do not take the level')
  if (!/hierarchy: \{\s*type: String,\s*default: DEFAULT_HIERARCHY,\s*\}/.test(script) || !/hierarchy: 'scheduleInitPixi'/.test(script)) problems.push('the view does not take or follow the level')

  return problems.length ? problems.join('; ') : true
})

check('E12', 'essential: the zero line of the flow charts of Finances and Mineral Outlook keeps the muted ink at both levels, and their other gridlines stay apart from the chart', (ctx) => everywhere(ctx, (id, level) => {
  const { FLOORS } = ctx.m['map-hierarchy']
  const appearance = ctx.appearances[id]
  const problems = []

  CALLERS.forEach((caller) => {
    const zero = callerGridAt(ctx, caller, appearance, level, 0)
    const other = contrast(ctx, callerGridAt(ctx, caller, appearance, level, 5), appearance.surfaces.card)

    if (zero !== appearance.inks.muted) problems.push(`${caller.name}: the zero line is ${zero}, not the muted ink ${appearance.inks.muted}`)
    if (other < FLOORS.chartGrid) problems.push(`${caller.name}: a gridline is ${other.toFixed(2)}:1, under ${FLOORS.chartGrid}`)
  })

  return problems
}))

// --- the PNG, composed from the screen's state

check('P1', 'png: the composition takes the hierarchy, links, grid, names and background from the state on screen', (ctx) => everywhere(ctx, (_id, level, scene) => {
  const { composition, vm, appearance, colors, link, stage } = scene
  const problems = []

  if (composition.hierarchy !== level || vm.hierarchy !== level) problems.push(`the level is ${composition.hierarchy}`)
  if (composition.links.color !== colors.link || composition.links.width !== link.width || composition.links.width !== rule(scene.sheet, 'edge').width) problems.push(`the links are ${short(composition.links)} against ${colors.link} ${link.width}`)
  if (composition.grid.color !== stage['--map-grid']) problems.push(`the grid is ${composition.grid.color} against ${stage['--map-grid']}`)
  if (composition.background !== appearance.surfaces.background) problems.push(`the background is ${composition.background}`)
  if (composition.names.ink !== ctx.m['map-hierarchy'].labelInk(level, scene.theme, false) || composition.names.halo !== scene.theme.surface) problems.push(`the names are ${short(composition.names)}`)
  if (composition.legend.surface !== appearance.surfaces.card) problems.push(`the legend is on ${composition.legend.surface}`)

  return problems
}))

check('P2', 'png: the grid of the PNG has the stage\'s dots (20 apart, 1 radius) in the level\'s colour, drawn behind the map over the page background', async (ctx) => {
  const problems = []
  const colours = []

  for (const level of LEVELS) {
    const shown = await runExport(ctx, 'dark', level)
    const log = shown.target.log
    const dots = log.findIndex((entry) => entry.op === 'arc' && entry.args[2] === 1)
    const fill = dots < 0 ? null : log.slice(dots).find((entry) => entry.op === 'fill')
    const background = log.findIndex((entry) => entry.op === 'fillRect' && entry.fillStyle === shown.composition.background && entry.args[2] === 640 && entry.args[3] === MAP_HEIGHT)
    const arcs = log.filter((entry) => entry.op === 'arc' && entry.args[2] === 1).length

    colours.push(shown.stage['--map-grid'])

    if (!fill || fill.fillStyle !== shown.stage['--map-grid'] || fill.composite !== 'destination-over') problems.push(`${level}: the dots are ${short(fill && [fill.fillStyle, fill.composite])}, the stage's ${shown.stage['--map-grid']}`)
    if (background < dots || dots < 0) problems.push(`${level}: the background is not drawn behind the dots (${background} against ${dots})`)
    if (arcs !== 32 * 23) problems.push(`${level}: ${arcs} dots, not ${32 * 23}`)
  }

  if (colours[0] === colours[1]) problems.push('the dots are the same at both levels')

  return problems.length ? problems.join('; ') : true
})

check('P3', 'png: the legend is under the map, as wide as it needs, and holds every label of the legend on screen', async (ctx) => {
  const problems = []

  for (const level of LEVELS) {
    const shown = await runExport(ctx, 'dark', level)
    const texts = shown.target.log.filter((entry) => entry.op === 'fillText').map((entry) => entry.args[0])
    const wanted = shown.rows.flat().filter((item) => item.label && item.kind !== 'slider').map((item) => item.label)
    const missing = wanted.filter((label) => !texts.includes(label))
    const rows = shown.composition.legend.rows.flat().filter((item) => item.label).length

    if (!wanted.includes('Jump link') || missing.length || rows < wanted.length) problems.push(`${level}: ${missing.length} of ${wanted.length} labels are missing (${missing.slice(0, 2).join(' | ')})`)
    const band = shown.target.log.find((entry) => entry.op === 'fillRect' && entry.fillStyle === shown.composition.legend.surface && entry.args[1] === MAP_HEIGHT)

    if (!band || band.args[2] < ctx.m['map-export'].LEGEND_MIN_WIDTH || !(shown.target.height > MAP_HEIGHT * 2)) problems.push(`${level}: the picture is ${shown.target.width} × ${shown.target.height} with the legend band ${short(band && band.args)}`)
  }

  return problems.length ? problems.join('; ') : true
})

check('P4', 'png: the legend\'s jump-link example has the colour and thickness of the links on screen, at both levels', async (ctx) => {
  const problems = []

  for (const level of LEVELS) {
    const shown = await runExport(ctx, 'solaris', level)
    const item = shown.rows.flat().find((entry) => entry.label === 'Jump link')
    const band = shown.target.log.findIndex((entry) => entry.op === 'fillRect' && entry.args[1] === MAP_HEIGHT)
    const swatch = band < 0 ? null : shown.target.log.slice(band).find((entry) => entry.op === 'fill' && entry.fillStyle === shown.colors.link)

    if (!item || item.color !== shown.colors.link || item.thickness !== shown.link.width) problems.push(`${level}: the example is ${short(item)}`)
    if (!swatch) problems.push(`${level}: no swatch in ${shown.colors.link} is drawn in the legend`)
  }

  return problems.length ? problems.join('; ') : true
})

check('P5', 'png: legendItems writes the discovery slider as the year it is set to', (ctx) => {
  const rows = [[{ kind: 'dot', color: '#fff', label: 'A' }, { kind: 'slider' }], [{ kind: 'note', label: 'N' }]]
  const items = ctx.m['map-export'].legendItems(rows, 'As of 2060')

  return items[0][1].kind === 'note' && items[0][1].label === 'As of 2060' && items[0][0].label === 'A' && items[1][0].label === 'N' && ctx.m['map-export'].legendItems(rows)[0][1].label === '' ? true : short(items)
})

check('P6', 'png: the names of the borders are drawn from the composition on screen and in the PNG, and the PNG keeps its save call and its limits', async (ctx) => {
  const script = scriptOf(ctx.texts.map)
  const problems = []

  if (!/ink: this\.composition\.names\.ink, halo: this\.composition\.names\.halo/.test(script)) problems.push('paintBorders does not use the composition names')
  if (!/ink: composition\.names\.ink, halo: composition\.names\.halo, places, type: this\.typeface/.test(script)) problems.push('exportPng does not use the composition names')

  const shown = await runExport(ctx, 'light', 'restrained')

  if (shown.sent.length !== 1 || shown.sent[0][0] !== 'save-png' || shown.sent[0][1] !== 'AAAA' || shown.sent[0][2] !== 'map-1-7-12345.png') problems.push(`the save call is ${short(shown.sent)}`)
  if (shown.target.width > 8192 || shown.target.height > 8192 || shown.target.width * shown.target.height > 32 * 1024 * 1024) problems.push(`the canvas is ${shown.target.width} × ${shown.target.height}`)

  return problems.length ? problems.join('; ') : true
})

check('P7', 'png: the stage\'s dots follow the level through --map-grid, in the template and the style', (ctx) => {
  const { map } = ctx.texts

  return /<div ref="stage" class="map-stage" :style="stageStyle"/.test(map) && /radial-gradient\(var\(--map-grid, var\(--ae-border\)\) 1px, transparent 0\)/.test(map) ? true : 'the stage does not read --map-grid'
})

const CLIP_TYPE = { size: (px) => px, font: (px, weight = 400) => `${weight} ${px}px Test`, family: 'Test' }
const CLIP_LEGEND = { surface: '#ffffff', ink: '#111111', muted: '#555555', border: '#cccccc', glyphSurface: '#ffffff', iconPaths: {} }

// The commands each item's swatch drew, from a legend drawn on a recording context: the ones between a `save` and its `restore` inside the band's own.
const swatchesOf = (log) => {
  const segments = []
  let depth = 0

  log.forEach((entry) => {
    if (entry.op === 'save') {
      depth++

      if (depth === 2) {
        segments.push([])
      }
    } else if (entry.op === 'restore') {
      depth--
    } else if (depth === 2 && entry.op !== 'set') {
      segments[segments.length - 1].push(entry)
    }
  })

  return segments
}

const SHAPES = [
  ['a square', 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)', '#aa0000'],
  ['a triangle', 'polygon(50% 0%, 100% 100%, 0% 100%)', '#00aa00'],
  ['a diamond', 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)', '#0000aa'],
  ['a circle', undefined, '#aaaa00'],
]

check('P8', 'png: a border legend merged with the categorical colours draws the inner marker as the screen does, the square, triangle or diamond of the colour, and a circle only where it has no shape', (ctx) => {
  const { legendLayout, drawLegend } = ctx.m['map-export']
  const items = SHAPES.map(([name, clip, color]) => ({ kind: 'area', dot: true, color, clip, tint: '#ffffff33', label: name }))
  const log = []
  const context = recordingContext(log)
  const layout = legendLayout(context, [items], { width: 640, type: CLIP_TYPE })
  const problems = []

  drawLegend(context, layout, CLIP_LEGEND, { top: 0, width: 640, type: CLIP_TYPE })

  const segments = swatchesOf(log)

  if (segments.length !== items.length) {
    return `${segments.length} swatches are drawn for ${items.length} items`
  }

  items.forEach((item, index) => {
    const place = layout.placed[index]
    const cy = place.y + layout.lineHeight / 2
    const tail = segments[index].slice(segments[index].map((entry) => entry.op).lastIndexOf('stroke') + 1)
    const fill = tail.find((entry) => entry.op === 'fill')
    const points = tail.filter((entry) => entry.op === 'moveTo' || entry.op === 'lineTo').map((entry) => entry.args)
    const arcs = tail.filter((entry) => entry.op === 'arc')

    if (!fill || fill.fillStyle !== item.color) problems.push(`${item.label}: the marker is filled with ${short(fill && fill.fillStyle)}, not ${item.color}`)

    if (item.clip) {
      const wanted = item.clip.match(/-?[\d.]+%\s+-?[\d.]+%/g).map((pair) => pair.split(/\s+/).map((value) => parseFloat(value) / 100)).map(([fx, fy]) => [place.x + 5 + fx * 8, cy - 4 + fy * 8])

      if (arcs.length || points.length !== wanted.length || points.some((point, at) => Math.abs(point[0] - wanted[at][0]) > 1e-6 || Math.abs(point[1] - wanted[at][1]) > 1e-6)) problems.push(`${item.label}: the marker is ${short(points)} and ${arcs.length} arcs, not ${short(wanted)}`)
    } else if (points.length || arcs.length !== 1 || arcs[0].args[2] !== 4 || arcs[0].args[0] !== place.x + 9 || arcs[0].args[1] !== cy) {
      problems.push(`${item.label}: the marker is ${short(arcs.map((entry) => entry.args))}, not a circle of radius 4 in the middle of the swatch`)
    }
  })

  return problems.length ? problems.join('; ') : true
})

const LONG_NOTE = 'The Aurelian Empire\'s colony costs now, before colonisation tech, as the game counts habitable worlds'
const LONG_WORD = 'Supercalifragilistic'.repeat(10)
const LONG_ROWS = [[{ kind: 'note', label: LONG_NOTE }], [{ kind: 'dot', color: '#00aa00', label: 'short' }, { kind: 'dot', color: '#aa0000', label: LONG_WORD }]]

check('P9', 'png: a legend label wider than the picture is wrapped by the font metrics, none is cut off, the lines are counted in the legend\'s height, and the picture is not widened for them', async (ctx) => {
  const { legendLayout, drawLegend, LEGEND_MIN_WIDTH } = ctx.m['map-export']
  const problems = []
  const cutOff = (log, perChar) => log.filter((entry) => entry.op === 'fillText' && entry.args[1] + String(entry.args[0]).length * perChar > LEGEND_MIN_WIDTH)
  const kept = (log) => log.filter((entry) => entry.op === 'fillText').map((entry) => entry.args[0]).join('').replace(/ /g, '')

  for (const perChar of [6, 7.5]) {
    const log = []
    const context = recordingContext(log, perChar)
    const layout = legendLayout(context, LONG_ROWS, { width: LEGEND_MIN_WIDTH, type: CLIP_TYPE })

    drawLegend(context, layout, CLIP_LEGEND, { top: 0, width: LEGEND_MIN_WIDTH, type: CLIP_TYPE })

    const lowest = Math.max(...log.filter((entry) => entry.op === 'fillText').map((entry) => entry.args[2] + layout.lineHeight / 2))

    if (cutOff(log, perChar).length) problems.push(`${perChar} px a letter: ${cutOff(log, perChar).length} lines end past ${LEGEND_MIN_WIDTH}`)
    if (!kept(log).includes(LONG_NOTE.replace(/ /g, '')) || !kept(log).includes(LONG_WORD)) problems.push(`${perChar} px a letter: a long label lost some of its text`)
    if (lowest > layout.height) problems.push(`${perChar} px a letter: the text reaches ${lowest} in a legend ${layout.height} high`)
  }

  const shown = await runExport(ctx, 'dark', 'restrained', { perChar: 7.5, data: { legendRows: LONG_ROWS } })
  const log = shown.target.log
  const band = log.find((entry) => entry.op === 'fillRect' && entry.fillStyle === shown.composition.legend.surface && entry.args[1] === MAP_HEIGHT)
  const texts = log.filter((entry) => entry.op === 'fillText')

  if (shown.target.width !== 2 * LEGEND_MIN_WIDTH) problems.push(`the picture is ${shown.target.width} wide, not ${2 * LEGEND_MIN_WIDTH}`)
  if (cutOff(log, 7.5).length) problems.push(`in the picture ${cutOff(log, 7.5).length} lines end past the edge`)
  if (!band || texts.some((entry) => entry.args[2] > band.args[1] + band.args[3])) problems.push(`the legend's band is ${short(band && band.args)} and its text reaches ${Math.max(...texts.map((entry) => entry.args[2]))}`)
  if (!kept(log).includes(LONG_WORD)) problems.push('in the picture the long word is not drawn whole')

  return problems.length ? problems.join('; ') : true
})

// --- the choice is one view preference

check('S1', 'persistence: the map declares one app-wide view mapHierarchy, emphasised by default, junk invalid', (ctx) => {
  const declarations = ctx.declared.filter((entry) => entry.key === 'mapHierarchy')
  const [entry] = declarations

  return declarations.length === 1 && entry.scope === 'app' && entry.default === 'emphasised' && typeof entry.valid === 'function' && entry.valid('restrained') && entry.valid('emphasised') && !entry.valid('loud') && !entry.valid(7) ? true : short(declarations.map(({ valid: _valid, normalise: _normalise, ...rest }) => rest))
})

check('S2', 'persistence: a level is written on change and a reopened store restores it', async (ctx) => {
  const mixin = pageMixin(ctx)

  if (!mixin) {
    return 'UNSUPPORTED: the page has no persisted hierarchy field'
  }

  const config = new MemoryConfig()
  const first = mountView(mixin, config)
  const problems = []

  if (first.hierarchy !== 'emphasised') problems.push(`the first level is ${first.hierarchy}`)

  first.hierarchy = 'restrained'
  await flush()

  if (!config.has('mapHierarchy') || config.get('mapHierarchy') !== 'restrained') problems.push(`the store holds ${short([...config.values])}`)

  const second = mountView(mixin, config.reopened())

  if (second.hierarchy !== 'restrained') problems.push(`the reopened level is ${second.hierarchy}`)

  second.hierarchy = 'emphasised'
  await flush()

  if (mountView(mixin, new MemoryConfig([['mapHierarchy', JSON.stringify('emphasised')]])).hierarchy !== 'emphasised') problems.push('emphasised is not restored')

  ;[first, second].forEach((vm) => vm.$destroy())

  return problems.length ? problems.join('; ') : true
})

check('S3', 'persistence: a stored level the map does not offer falls back to emphasised', (ctx) => {
  const mixin = pageMixin(ctx)

  if (!mixin) {
    return 'UNSUPPORTED: the page has no persisted hierarchy field'
  }

  const levels = ['loud', 3, null, ['restrained'], '']
  const stored = (value) => mountView(mixin, new MemoryConfig([['mapHierarchy', JSON.stringify(value)]])).hierarchy
  const wrong = levels.filter((value) => stored(value) !== 'emphasised')

  return wrong.length ? `restored: ${short(wrong)}` : stored('restrained') === 'restrained' ? true : 'a level stored under mapHierarchy is not read'
})

check('S4', 'persistence: the chart canvas reads the same stored view, so a chart follows the level the map keeps', async (ctx) => {
  const mixin = chartMixin(ctx)
  const declared = ctx.view.declaredViews().filter((entry) => entry.key === 'mapHierarchy')
  const restrained = mountView(mixin, new MemoryConfig([['mapHierarchy', JSON.stringify('restrained')]]))
  const junk = mountView(mixin, new MemoryConfig([['mapHierarchy', JSON.stringify('loud')]]))

  return declared.length === 1 && declared[0].scope === 'app' && declared[0].default === 'emphasised' && restrained.hierarchy === 'restrained' && junk.hierarchy === 'emphasised' ? true : short([declared.length, restrained.hierarchy, junk.hierarchy])
})

check('S5', 'persistence: Settings exports and imports it among the app-wide views, and refuses a level that is not offered', (ctx) => {
  const { buildSchema, buildExport, parseBundle, FORMAT, VERSION } = ctx.m.preferences
  const schema = buildSchema({ declarations: ctx.declared, appearance: { key: 'appearance', ids: ['light', 'dark'] }, policy: { key: 'appearancePolicy', values: ['light', 'dark', 'system'] }, font: { key: 'appearanceFont', read: () => ({ ok: false, reason: 'none' }) }, separators: [','] })
  const problems = []

  if (!schema.has('views:app:mapHierarchy')) problems.push('the schema has no views:app:mapHierarchy')

  const exported = buildExport(schema, { mapHierarchy: 'restrained' }, { gameId: 1, raceId: 7, campaignId: 'c1' }, ['views'])
  const wrote = ((exported.bundle.categories.views || {}).app || {}).mapHierarchy
  const parsed = parseBundle(JSON.stringify(exported.bundle), schema)
  const entry = (parsed.entries || []).find((item) => item.key === 'mapHierarchy')
  const junk = parseBundle(JSON.stringify({ format: FORMAT, version: VERSION, categories: { views: { app: { mapHierarchy: 'loud' } } } }), schema)

  if (wrote !== 'restrained') problems.push(`the export holds ${short(exported.bundle.categories)}`)
  if ((parsed.errors || []).length || !entry || entry.value !== 'restrained' || entry.scope !== 'app') problems.push(`the import is ${short([parsed.errors, entry])}`)
  if (!(junk.errors || []).length) problems.push('a level that is not offered is imported')

  return problems.length ? problems.join('; ') : true
})

check('S6', 'persistence: no second store: the map\'s watcher of the level writes nothing, and the persisted view writes the one key mapHierarchy and nothing else', async (ctx) => {
  const mixin = pageMixin(ctx)
  const watcher = ctx.options.watch && ctx.options.watch.hierarchy

  if (!mixin || !watcher) {
    return 'UNSUPPORTED: the page has no persisted hierarchy field or no watcher of it'
  }

  const problems = []
  const writes = []
  const calls = []
  const restore = spied(writes)

  try {
    const config = { get: (_key, fallback) => fallback, set: (key) => writes.push(`config.set(${key})`), update: () => writes.push('config.update()'), delete: (key) => writes.push(`config.delete(${key})`) }
    const store = { getters: { ...storeOf().getters, config }, dispatch: (type) => writes.push(`dispatch ${type}`) }

    globalThis.__appearance = ctx.appearances.light

    const vm = instantiate(ctx.options, { $store: store, GameID: 1, RaceID: 7, data: sceneData('emphasised', { graph: { style: (rules) => calls.push(Array.isArray(rules) ? 'style' : 'style?') }, minimap: { refresh: () => calls.push('refresh') }, restyle: () => calls.push('restyle'), paintBorders: () => calls.push('paint') }) })

    for (const level of LEVELS) {
      calls.length = 0
      vm.hierarchy = level
      watcher.call(vm)

      if (calls.join() !== 'style,restyle,paint,refresh') problems.push(`${level}: the watcher did ${calls.join() || 'nothing'}`)
    }

    const recorded = new MemoryConfig()
    const view = mountView(mixin, recorded)

    view.hierarchy = 'restrained'
    await flush()
    view.hierarchy = 'emphasised'
    await flush()
    view.$destroy()

    if (JSON.stringify(recorded.writes) !== JSON.stringify([['mapHierarchy', 'restrained'], ['mapHierarchy', 'emphasised']])) problems.push(`the persisted view wrote ${short(recorded.writes)}`)
  } finally {
    restore()
  }

  if (writes.length) problems.push(`written besides the persisted view: ${writes.join(', ')}`)

  const stray = [ctx.texts.hierarchy, ctx.texts.exporter].filter((text) => /localStorage|electron-store|sessionStorage|\$store\.getters\.config|config\.set\(/.test(text)).length
  const mapDeclares = /^\s*hierarchy: hierarchyView,$/m.test(scriptOf(ctx.texts.map))
  const chartDeclares = /persistedView\(\{ hierarchy: hierarchyView \}\)/.test(scriptOf(ctx.texts.chart))

  if (stray || !mapDeclares || !chartDeclares || /localStorage|sessionStorage/.test(ctx.texts.system) || /localStorage|sessionStorage/.test(ctx.texts.chart)) problems.push(`${stray} utilities write a store of their own, or a consumer does not declare the view through hierarchyView (map ${mapDeclares}, chart ${chartDeclares})`)

  return problems.length ? problems.join('; ') : true
})

check('S7', 'persistence: Finances and Mineral Outlook, which draw their own gridlines, rebuild their persisted view from their own source and read the same stored level', (ctx) => {
  const problems = []

  CALLERS.forEach((caller) => {
    const mixin = pageViewOf(ctx, caller)
    const stored = (value) => mountView(mixin, new MemoryConfig(value === undefined ? [] : [['mapHierarchy', JSON.stringify(value)]])).hierarchy
    const found = [stored('restrained'), stored('loud'), stored(undefined)]

    if (found.join() !== 'restrained,emphasised,emphasised') problems.push(`${caller.name} reads ${found.join()} for a stored restrained, a stored loud and nothing`)
  })

  return problems.length ? problems.join('; ') : true
})

// --- the control

check('C1', 'control: the Show menu offers both levels as radio items that set the level, and the system view receives it', (ctx) => {
  const { map } = ctx.texts
  const problems = []

  if (!/v-for="level in hierarchyLevels"[^>]*role="menuitemradio"[^>]*:aria-checked="String\(hierarchy === level\.value\)"[^>]*@click="hierarchy = level\.value"/.test(map)) problems.push('the menu items are not radio items that set the level')
  if (!/<v-subheader>Hierarchy<\/v-subheader>/.test(map)) problems.push('no Hierarchy heading')
  if (!/<system-view [^>]*:hierarchy="hierarchy"/.test(map)) problems.push('the system view is not given the level')
  if (!ctx.options.mixins || !pageMixin(ctx)) problems.push('the page has no persisted level')
  if (!/hierarchy\(\) \{\s*if \(this\.graph\) \{\s*this\.graph\.style\(this\.stylesheet\(\)\)\s*this\.restyle\(\)\s*this\.paintBorders\(\)/.test(scriptOf(map))) problems.push('a change of level does not restyle the graph and redraw the borders')

  return problems.length ? problems.join('; ') : true
})

// --- collision, overlay and pan/zoom stay as they were

check('U1', 'unchanged: the label collision of the system view is the source of the commit before', (ctx) => {
  const names = ['_annotationPriority', 'refreshVisibleAnnotations']
  const before = atBase(FILES.system)
  const different = names.filter((name) => methodSource(ctx.texts.system, name) !== methodSource(before, name) || !methodSource(before, name))

  return different.length ? `changed: ${different.join(', ')}` : true
})

check('U2', 'unchanged: the overlay controls, the dimming, the wheel and the right-click menu are the source of the commit before', (ctx) => {
  const names = ['toggleMark', 'toggleDim', 'fades', 'shiftWheel', 'createMenu', 'glyphsOf', 'markText']
  const before = atBase(FILES.map)
  const different = names.filter((name) => methodSource(ctx.texts.map, name) !== methodSource(before, name) || !methodSource(before, name))

  return different.length ? `changed: ${different.join(', ')}` : true
})

check('U3', 'unchanged: the borders\' label placement and the overview are byte-identical to the commit before', () => {
  const different = ['src/renderer/utilities/map-borders.js', 'src/renderer/utilities/map-minimap.js'].filter((file) => fs.readFileSync(path.join(root, file), 'utf8') !== atBase(file))

  return different.length ? `changed: ${different.join(', ')}` : true
})

check('U4', 'unchanged: a system\'s data differs between the levels only in the ink and size of its name; glyphs, dimming and selection do not', (ctx) => {
  const problems = []

  PRESET_IDS.forEach((id) => {
    const restrained = evaluate(ctx, id, 'restrained')
    const emphasised = evaluate(ctx, id, 'emphasised')

    restrained.rows.forEach((row) => {
      const [a, b] = [restrained, emphasised].map((scene) => ({ ...scene.nodes[row.id], labelInk: null, labelMinPx: null }))

      if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${id}/${row.id}: the data differs`)
      if (JSON.stringify(restrained.glyphs[row.id]) !== JSON.stringify(emphasised.glyphs[row.id])) problems.push(`${id}/${row.id}: the glyphs differ`)
    })

    const rules = (scene) => scene.sheet.filter((entry) => !/^(edge|node:selected)$/.test(entry.selector)).map((entry) => entry.selector)

    if (JSON.stringify(rules(restrained)) !== JSON.stringify(rules(emphasised))) problems.push(`${id}: the rules differ`)
  })

  return problems.length ? `${problems.length}: ${problems.slice(0, 3).join('; ')}` : true
})

check('U5', 'unchanged: the overlay and dim preferences are declared as before, and the dimming still fades a system the overlay marks nothing at', (ctx) => {
  const declared = Object.fromEntries(ctx.declared.map((entry) => [entry.key, entry]))
  const problems = []

  if (!declared.mapMarks || declared.mapMarks.scope !== 'race' || JSON.stringify(declared.mapMarks.default) !== '[]') problems.push('mapMarks changed')
  if (!declared.mapDim || declared.mapDim.scope !== 'race' || declared.mapDim.default !== false) problems.push('mapDim changed')

  globalThis.__appearance = ctx.appearances.light

  LEVELS.forEach((level) => {
    const vm = instantiate(ctx.options, { $store: storeOf(), GameID: 1, RaceID: 7, data: sceneData(level, { dimUnmarked: true }) })
    const rows = vm.systemRows
    const wrong = rows.filter((row) => vm.markerData(row).dim !== !vm.markerData(row).marked)
    const marked = rows.filter((row) => vm.markerData(row).marked).length

    if (wrong.length || marked === 0 || marked === rows.length) problems.push(`${level}: ${wrong.length} systems are dimmed other than where the overlay marks nothing (${marked} of ${rows.length} marked)`)
  })

  return problems.length ? problems.join('; ') : true
})

check('U6', 'harness: a mutation that does not parse, or whose text is not there exactly once, is refused', () => {
  const text = 'const a = 1\nconst b = 2\n'
  const refused = (find, replacement) => {
    try {
      patched('probe.js', text, find, replacement)

      return false
    } catch (error) {
      return true
    }
  }

  return refused('const a = 1', 'const a = (') && refused('const c = 3', 'x') && refused('const', 'let') && !refused('const a = 1', 'const a = 3') ? true : 'the harness takes a mutation it should refuse'
})

// ---------- the mutants ----------

const MUTANTS = [
  { name: 'restrained links as strong as the emphasised', patches: [['hierarchy', 'restrained: { link: 0.35, linkWidth: 2,', 'restrained: { link: 0.6, linkWidth: 3,']], fails: ['V2', 'V3'] },
  { name: 'restrained links too faint to see', patches: [['hierarchy', 'restrained: { link: 0.35,', 'restrained: { link: 0.05,']], fails: ['E7'] },
  { name: 'restrained grid dots as strong as the emphasised', patches: [['hierarchy', "gridDot: 0.5, secondaryInk: 'muted'", "gridDot: 1, secondaryInk: 'muted'"]], fails: ['V4'] },
  { name: 'restrained grid dots too faint to see', patches: [['hierarchy', "gridDot: 0.5, secondaryInk: 'muted'", "gridDot: 0.05, secondaryInk: 'muted'"]], fails: ['E8'] },
  { name: 'the level never changes the names', patches: [['hierarchy', "secondaryInk: 'muted'", "secondaryInk: 'ink'"]], fails: ['V2', 'V5'] },
  { name: 'a system Show marks is muted as well', patches: [['hierarchy', "(marked || strengthOf(level).secondaryInk === 'ink' ? ink : inkMuted)", "(strengthOf(level).secondaryInk === 'ink' ? ink : inkMuted)"]], fails: ['E3', 'E10'] },
  { name: 'a system Show marks is hidden at the smaller size as well', patches: [['hierarchy', 'strengthOf(marked ? DEFAULT_HIERARCHY : level).labelMinPx', 'strengthOf(level).labelMinPx']], fails: ['E3', 'E10'] },
  { name: 'orbit lines too faint at the restrained level', patches: [['hierarchy', 'orbit: 0.75, orbitWidth: 0.75,', 'orbit: 0.4, orbitWidth: 0.75,']], fails: ['E5'] },
  { name: 'orbit lines never change', patches: [['hierarchy', 'orbit: 0.75, orbitWidth: 0.75,', 'orbit: 1, orbitWidth: 1,']], fails: ['V6'] },
  { name: 'names of bodies too faint at the restrained level', patches: [['hierarchy', 'skyLabel: 0.7,', 'skyLabel: 0.3,']], fails: ['E6'] },
  { name: 'gridlines of a chart too faint at the restrained level', patches: [['hierarchy', 'chartGrid: 0.35 }', 'chartGrid: 0.05 }']], fails: ['E9'] },
  { name: 'the chart ignores the level', patches: [['chart', 'chartGridColor(this.hierarchy, border)', "chartGridColor('emphasised', border)"]], fails: ['V7'] },
  { name: 'the chart draws its grid as it did, not through the level', patches: [['chart', 'chartGridColor(this.hierarchy, border)', '`$' + '{border}99`']], fails: ['V7'] },
  { name: 'the chart does not keep the view', patches: [['chart', 'mixins: [persistedView({ hierarchy: hierarchyView })],', 'mixins: [persistedView({ unrelated: { key: \'chartUnrelated\', default: null } })],']], fails: ['S4'] },
  { name: 'the selected edge follows the level', patches: [['map', "width: (edge) => (edge.data('gate') === 'both' ? 5 : 3),", 'width: this.linkLook.width,']], fails: ['E4'] },
  { name: 'a one-way stabilised link follows the level', patches: [['map', "selector: 'edge[gate = \"source\"]',\n          style: {\n            width: 3,", "selector: 'edge[gate = \"source\"]',\n          style: {"]], fails: ['E4'] },
  { name: 'the selected node follows the level', patches: [['map', "'font-weight': 'bold',\n            color: theme.ink,\n            'min-zoomed-font-size': 9,", "'font-weight': 'bold',"]], fails: ['E2'] },
  { name: 'the hazard colour is blended into the surface', patches: [['map', 'danger: red,', 'danger: blend(red, surface, 0.5),']], fails: ['E2'] },
  { name: 'the stage grid ignores the level', patches: [['map', "'--map-grid': gridDotColor(this.hierarchy,", "'--map-grid': gridDotColor('emphasised',"]], fails: ['P1', 'P2'] },
  { name: 'the PNG draws no grid', patches: [['map', 'drawGrid(context, { width, height }, composition.grid)', 'void 0']], fails: ['P2'] },
  { name: 'the PNG grid is its own colour', patches: [['map', 'drawGrid(context, { width, height }, composition.grid)', "drawGrid(context, { width, height }, { ...composition.grid, color: '#808080' })"]], fails: ['P2'] },
  { name: 'the PNG draws no legend', patches: [['map', 'drawLegend(context, legend, composition.legend, { top: height, width, type: this.typeface })', 'void 0']], fails: ['P3', 'P4'] },
  { name: 'the PNG legend leaves the jump-link example out', patches: [['map', "items.push({ kind: 'line', color: colors.link, thickness: this.linkLook.width, label: 'Jump link' })", 'void 0']], fails: ['P3', 'P4'] },
  { name: 'the legend\'s jump-link example has a thickness of its own', patches: [['map', "thickness: this.linkLook.width, label: 'Jump link'", "thickness: 3, label: 'Jump link'"]], fails: ['P4'] },
  { name: 'the PNG names take the ink of the preset, not the level', patches: [['map', 'ink: composition.names.ink, halo: composition.names.halo, places, type: this.typeface', 'ink: this.theme.ink, halo: this.theme.surface, places, type: this.typeface']], fails: ['P6'] },
  { name: 'the PNG background is the card', patches: [['map', 'context.fillStyle = composition.background', 'context.fillStyle = this.appearance.surfaces.card']], fails: ['P2'] },
  { name: 'the PNG is as wide as the map even when the legend needs more', patches: [['map', 'const wide = Math.max(width, LEGEND_MIN_WIDTH)', 'const wide = width']], fails: ['P3'] },
  { name: 'the composition\'s links ignore the level', patches: [['exporter', 'links: linkStyle(hierarchy, theme),', "links: linkStyle('emphasised', theme),"]], fails: ['P1'] },
  { name: 'the legend\'s slider is dropped from the PNG', patches: [['exporter', "item.kind === 'slider' ? { kind: 'note', label: asOf || '' } : item", "item.kind === 'slider' ? { kind: 'note', label: '' } : item"]], fails: ['P5'] },
  { name: 'the view is kept under another key', patches: [['hierarchy', "HIERARCHY_KEY = 'mapHierarchy'", "HIERARCHY_KEY = 'mapHierarchies'"]], fails: ['S1', 'S2', 'S3', 'S4', 'S5'] },
  { name: 'a stored level is not validated', patches: [['hierarchy', 'default: DEFAULT_HIERARCHY, valid: isHierarchy }', 'default: DEFAULT_HIERARCHY }']], fails: ['S1', 'S3', 'S4', 'S5'] },
  { name: 'restrained is the default', patches: [['hierarchy', "DEFAULT_HIERARCHY = 'emphasised'", "DEFAULT_HIERARCHY = 'restrained'"]], fails: ['V1', 'S1', 'S2'] },
  { name: 'the map declares the view with a descriptor of its own, not hierarchyView', patches: [['map', 'hierarchy: hierarchyView,', "hierarchy: { key: 'mapHierarchy', default: 'emphasised' },"]], fails: ['S1', 'S3', 'S5', 'S6'] },
  { name: 'the menu does not set the level', patches: [['map', '@click="hierarchy = level.value"', '@click="toggleDim"']], fails: ['C1'] },
  { name: 'the system view is not given the level', patches: [['map', ':system-id="systemViewId" :hierarchy="hierarchy"', ':system-id="systemViewId"']], fails: ['C1'] },
  { name: 'a change of level leaves the graph as it was', patches: [['map', '    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()', '    hierarchy() {\n      if (this.graph) {\n        this.restyle()']], fails: ['C1'] },
  { name: 'the system view ignores the level', patches: [['system', 'skyStyle(this.hierarchy, this.appearance.space)', "skyStyle('emphasised', this.appearance.space)"]], fails: ['E11'] },
  { name: 'the system view dims the names of stars as well', patches: [['system', 'new PIXI.Text(labelText, this._textStyles.star)', 'new PIXI.Text(labelText, this._textStyles.secondary)']], fails: ['E11'] },
  { name: 'the label collision priority of the system view changes', patches: [['system', 'return 1000 // stars highest', 'return 100 // stars highest']], fails: ['U1'] },
  { name: 'the overlay toggle changes', patches: [['map', 'this.marks = this.marksSet.has(value) ? this.marks.filter((mark) => mark !== value) : [...this.marks, value]', 'this.marks = [value]']], fails: ['U2'] },
  { name: 'the dimming changes with the level', patches: [['map', 'return (this.dimUnmarked && this.marks.length > 0 && !marked)', "return (this.hierarchy === 'restrained' && this.dimUnmarked && this.marks.length > 0 && !marked)"]], fails: ['U2'] },
  { name: 'the level changes a system\'s dimming', patches: [['map', 'dim: this.fades(row, marked),', "dim: this.fades(row, marked) || (this.hierarchy === 'restrained' && marked),"]], fails: ['U4', 'U5'] },
  { name: 'the level changes a system\'s glyphs', patches: [['map', 'marked,\n        dim: this.fades(row, marked),', "marked: marked && this.hierarchy !== 'restrained',\n        dim: this.fades(row, marked),"]], fails: ['U4'] },
  { name: 'the quieter ink ignores what Show marks', patches: [['map', 'labelInk: labelInk(this.hierarchy, this.theme, marked),', 'labelInk: labelInk(this.hierarchy, this.theme, false),']], fails: ['E3', 'E10'] },
  { name: 'the smaller size ignores what Show marks', patches: [['map', 'labelMinPx: labelMinPx(this.hierarchy, marked),', 'labelMinPx: labelMinPx(this.hierarchy, false),']], fails: ['E3', 'E10'] },
  { name: 'only contacts and rifts keep their names, a ship or a flag is quiet like the rest', patches: [['map', 'labelInk: labelInk(this.hierarchy, this.theme, marked),', 'labelInk: labelInk(this.hierarchy, this.theme, glyphs.some((glyph) => /^(contacts|rifts)/.test(glyph.name)) || label !== row.Name),']], fails: ['E3', 'E10'] },
  { name: 'a system whose name carries a line but no glyph is quiet', patches: [['map', 'labelInk: labelInk(this.hierarchy, this.theme, marked),', 'labelInk: labelInk(this.hierarchy, this.theme, glyphs.length > 0),']], fails: ['E3', 'E10'] },
  { name: 'the Finances flow chart draws its grid as it did', patches: [['finances', 'chartGridColor(this.hierarchy, this.theme.border)', '`$' + '{this.theme.border}99`']], fails: ['V9'] },
  { name: 'the Finances flow chart loses its zero line', patches: [['finances', '(context.tick && context.tick.value === 0 ? this.theme.inkMuted : chartGridColor(this.hierarchy, this.theme.border))', 'chartGridColor(this.hierarchy, this.theme.border)']], fails: ['E12'] },
  { name: 'the Finances page does not read the level', patches: [['finances', '      hierarchy: hierarchyView,\n', '']], fails: ['S7'] },
  { name: 'the Mineral Outlook flow chart draws its grid as it did', patches: [['outlook', 'chartGridColor(this.hierarchy, this.theme.border)', '`$' + '{this.theme.border}99`']], fails: ['V9'] },
  { name: 'the Mineral Outlook flow chart loses its zero line', patches: [['outlook', '(context.tick && context.tick.value === 0 ? this.theme.inkMuted : chartGridColor(this.hierarchy, this.theme.border))', 'chartGridColor(this.hierarchy, this.theme.border)']], fails: ['E12'] },
  { name: 'the Mineral Outlook page does not read the level', patches: [['outlook', '      hierarchy: hierarchyView,\n', '']], fails: ['S7'] },
  { name: 'the merged border legend draws every marker as a circle', patches: [['exporter', 'polygon(context, corners, x + (SWATCH_WIDTH.area - AREA_DOT) / 2, cy - AREA_DOT / 2, AREA_DOT)', 'circle(x + SWATCH_WIDTH.area / 2, AREA_DOT / 2)']], fails: ['P8'] },
  { name: 'the merged border legend draws its marker off the swatch', patches: [['exporter', 'polygon(context, corners, x + (SWATCH_WIDTH.area - AREA_DOT) / 2, cy - AREA_DOT / 2, AREA_DOT)', 'polygon(context, corners, x, cy - AREA_DOT / 2, AREA_DOT)']], fails: ['P8'] },
  { name: 'a legend label wider than the row is not wrapped', patches: [['exporter', 'const lines = !item.label ? [] : swatch + whole > room ? wrapLabel(context, item.label, Math.max(room - swatch, 1)) : [item.label]', 'const lines = item.label ? [item.label] : []']], fails: ['P9'] },
  { name: 'a word wider than the row is not broken', patches: [['exporter', 'while (rest.length > 1 && context.measureText(rest).width > limit) {', 'while (false) {']], fails: ['P9'] },
  { name: 'the wrapped lines are left out of the legend\'s height', patches: [['exporter', '    y += tallest * lineHeight + ROW_GAP\n  })', '    y += lineHeight + ROW_GAP\n  })']], fails: ['P9'] },
  { name: 'the picture is widened without bound for a long label', patches: [['map', 'const wide = Math.max(width, LEGEND_MIN_WIDTH)', 'const wide = Math.max(width, LEGEND_MIN_WIDTH, composition.legend.rows.flat().reduce((sum, item) => sum + (item.label ? item.label.length * 8 : 0), 0))']], fails: ['P9'] },
  { name: 'the watcher of the level keeps it in the local storage', patches: [['map', '    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()', "    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()\n        localStorage.setItem('independent-hierarchy', this.hierarchy)"]], fails: ['S6'] },
  { name: 'the watcher of the level keeps it in the window\'s session storage', patches: [['map', '    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()', "    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()\n        window.sessionStorage.setItem('independent-hierarchy', this.hierarchy)"]], fails: ['S6'] },
  { name: 'the watcher of the level writes it to the settings store', patches: [['map', '    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()', "    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()\n        this.$store.getters.config.set('hierarchyCopy', this.hierarchy)"]], fails: ['S6'] },
  { name: 'the watcher of the level hands it to the Vuex store', patches: [['map', '    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()', "    hierarchy() {\n      if (this.graph) {\n        this.graph.style(this.stylesheet())\n        this.restyle()\n        this.paintBorders()\n        this.$store.dispatch('keepHierarchy', this.hierarchy)"]], fails: ['S6'] },
]

// ---------- running ----------

const run = async (item, ctx) => {
  try {
    const result = await item.run(ctx)

    return result === true ? true : typeof result === 'string' ? result : `false: ${short(result)}`
  } catch (error) {
    return error instanceof Unsupported ? error.message : `threw ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 3).join(' | ')}`
  }
}

let total = 0
let failures = 0

const show = (name, result) => {
  total++

  if (result !== true) {
    failures++
  }

  console.log(`${result === true ? 'PASS' : 'FAIL'}  ${name}${result === true ? '' : `  [${result}]`}`)
}

const agrees = (result) => result === true

// A mutated check counts only when it failed on a finding: a check that could not run, or threw, says nothing.
const disagrees = (result) => result !== true && !/^(UNSUPPORTED|threw)/.test(result)

// A mutant runs the checks it names over the mutated sources, in a process of its own (`--mutant <index>`): the page and its modules leave state on globalThis, and a process apart is also what lets the mutants run side by side (CHECK_JOBS). The child prints { results: [[id, result]] }, or { invalid } when the sources do not patch or load.
const judgeMutant = async (mutant) => {
  let ctx

  try {
    const texts = readTexts()

    mutant.patches.forEach(([key, find, replacement]) => {
      texts[key] = patched(FILES[key], texts[key], find, replacement)
    })
    ctx = await contextOf(texts)
  } catch (error) {
    return { invalid: error.message }
  }

  const results = []

  for (const id of mutant.fails) {
    results.push([id, await run(CHECKS.find((item) => item.id === id), ctx)])
  }

  return { results }
}

const judgeApart = async (index) => {
  try {
    return lastJson(await runChild(__filename, ['--mutant', String(index)]))
  } catch (error) {
    return { error: error.message }
  }
}

const namesUnknown = (mutant) => mutant.fails.some((id) => !CHECKS.some((item) => item.id === id))

const main = async () => {
  console.log('Visual hierarchy of the map, the system view and the charts: AE-022-01')

  const verdicts = process.argv.includes('--no-mutations') ? Promise.resolve([]) : inParallel([...MUTANTS.keys()], async (index) => (namesUnknown(MUTANTS[index]) ? null : judgeApart(index)))
  const base = await contextOf(readTexts())
  const control = new Map()

  for (const item of CHECKS) {
    const result = await run(item, base)

    control.set(item.id, result)
    show(`${item.id} ${item.name}`, result)
  }

  if (!process.argv.includes('--no-mutations')) {
    console.log('\nmutants')

    const judged = await verdicts

    for (const [index, mutant] of MUTANTS.entries()) {
      const unknown = mutant.fails.filter((id) => !CHECKS.some((item) => item.id === id))
      const unproven = mutant.fails.filter((id) => !agrees(control.get(id)))

      if (unknown.length || unproven.length) {
        show(`mutant caught: ${mutant.name}`, unknown.length ? `names checks that do not exist: ${unknown.join(', ')}` : `names checks that do not pass unchanged: ${unproven.join(', ')}`)

        continue
      }

      const { invalid, error, results } = judged[index]

      if (invalid !== undefined) {
        show(`mutant caught: ${mutant.name}`, `invalid mutant: ${invalid}`)

        continue
      }

      if (error !== undefined) {
        show(`mutant caught: ${mutant.name}`, `the judging process failed: ${error}`)

        continue
      }

      const survived = []
      const silent = []

      for (const [id, result] of results) {
        if (agrees(result)) {
          survived.push(id)
        } else if (!disagrees(result)) {
          silent.push(`${id} (${result.slice(0, 80)})`)
        }
      }

      show(`mutant caught: ${mutant.name} (fails ${mutant.fails.join(', ')})`, survived.length || silent.length ? `${survived.length ? `these checks still pass: ${survived.join(', ')}. ` : ''}${silent.length ? `these could not judge: ${silent.join('; ')}` : ''}` : true)
    }
  }

  console.log(`\n${total - failures} of ${total} checks passed`)
  process.exit(failures ? 1 : 0)
}

if (process.argv.includes('--mutant')) {
  judgeMutant(MUTANTS[Number(process.argv[process.argv.indexOf('--mutant') + 1])]).then((verdict) => process.stdout.write(`${JSON.stringify(verdict)}\n`, () => process.exit(0)))
} else {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}
