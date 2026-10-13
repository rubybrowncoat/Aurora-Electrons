/*
  The contrast and colour-vision gate for the shipped presets (src/renderer/utilities/appearance.js).

  node scripts/check-contrast.js [--preset <id>] [--verbose]

  For every preset it measures WCAG 2.x contrast ratios of the resolved tokens against the surfaces they are drawn on:
  - text (4.5:1): the inks on the page, card and chrome surfaces, the tooltip ink on the tooltip, axis ticks, links and the sky's labels;
  - essential graphics and state cues (3:1): the focus colour, the severities, the contact relationships, the status colours, the selection mark and each categorical slot, against the card and page surfaces; the system view's orbit and jump point lines against its sky;
  - text on a table row's washes (4.5:1): the inks and severity tones on the card under the hover wash, the selected row's wash and the wash of a compared row that differs, and under the two layered whenever styles/appearance.scss leaves a washed row's hover unsettled, so a row state never takes the text or a severity figure below its own contrast;
  - the pressed-button bar of a toggle group (3:1) on the button as drawn: the selected-row wash over Vuetify's pressed fill, which the wash keeps the same focused, hovered or not;
  - selection against warnings (CIEDE2000 of 20 or more): for a preset that adapts a reference (`reference` in appearance.js), the focus colour against each of the three warning severities, so a selected row, a link or a focus ring is never taken for a warning.
  - Vuetify's text inks (4.5:1): `inks.text` and `inks.textMuted`, which styles/appearance.scss draws every Vuetify component's text in, on the surfaces and under the row washes; the script compiles that stylesheet, reads the colour each rule declares and fails when a selector is missing or declares another colour (a disabled state, which Vuetify draws fainter, is left out by the selector itself), when the baselines' text inks differ from Vuetify's own (Light and Dark must not change) or when a theme's `--ae-text-*` variable is not the colour the rule is meant to draw;
  - text on a filled primary button and avatar (4.5:1), from the colour the stylesheet declares for them (Vuetify's white when it declares none);
  - for a preset that adapts a reference, text and icons on the surfaces Vuetify's named colours fill (the System view's toolbar, the snackbar), against each of the primary and the four severity colours: the toolbar's title (4.5:1), its icon, text button and icon button (icons 3:1), the snackbar's message and its text button (4.5:1), each from the colour the compiled stylesheet finally declares for it (the ordinary text ink where a rule is missing); the baselines keep Vuetify's own white and are not measured here;
  - hue independence: in every preset one colour per categorical slot (a series is told which slot it is by its colour, so two slots of one colour would share a marker, dash and pattern); in a preset that adapts a reference and whose card or rail has the page's colour, the outline of that surface against the page (3:1), its only edge (Light's card is white on white with a decorative hairline and is not measured); in a preset whose focus colour is under 20 CIEDE2000 from its text ink, a link cue that is not a colour: `--ae-link-line` is `underline` and the stylesheet's link rule draws it;
  - the icons of the Galaxy Map's right-click menu (3:1) on its wedge and on the wedge under the pointer, in every preset: the gate cuts `createMenu` out of pages/map.vue, runs it with a stub for `graph.cxtmenu` and a stand-in `this` carrying the preset, and measures the options it hands the library (`itemColor`, `fillColor`, `activeFillColor`; the library's white where `itemColor` is absent) over the page background, so a commented-out or stale option cannot pass; `MAP_MENU` in appearance.js sets the alphas and the slot;
  A categorical slot under 3:1 passes only when the slot's encoding (marker, dash and bar pattern, `SERIES_ENCODINGS` in appearance.js) tells it from every other slot without colour. Exceptions (decorative hairlines, track fills, gridlines, washes as colours, disabled controls) are listed with their reason, so the evidence names what the gate does not measure.

  A failed measurement, or a preset whose encodings do not tell its nine slots apart, sets exit code 1.
*/
const fs = require('fs')
const { join } = require('path')
const vm = require('vm')
const sass = require('sass')
const { loadUtilities } = require('./lib/utilities')

const TEXT = 4.5
const GRAPHIC = 3
const CVD_NEIGHBOUR_DELTA = 8
const SELECTION_DELTA = 20
const WARNING_LEVELS = ['action', 'attention', 'info']
const CVD_ANY_DELTA = 5

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB.
const MACHADO = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}

const parseColor = (value) => {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)

  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].replace(/./g, '$&$&') : hex[1]

    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1 }
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)

  if (rgb) {
    const [r, g, b, a = 1] = rgb[1].split(',').map(Number)

    return { r, g, b, a }
  }

  throw new Error(`Unreadable colour ${value}`)
}

// A colour drawn over an opaque one.
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })

const linear = (channel) => {
  const value = channel / 255

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

const ratio = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)

  return (light + 0.05) / (dark + 0.05)
}

const hex = ({ r, g, b }) => `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`

const toLinear = (color) => [linear(color.r), linear(color.g), linear(color.b)]

const fromLinear = (channels) => {
  const encode = (value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055)
  const [r, g, b] = channels.map((value) => encode(Math.max(0, Math.min(1, value))))

  return { r, g, b, a: 1 }
}

const simulate = (color, matrix) => {
  const channels = toLinear(color)

  return fromLinear(matrix.map((row) => row[0] * channels[0] + row[1] * channels[1] + row[2] * channels[2]))
}

const lab = (color) => {
  const [r, g, b] = toLinear(color)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)

  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

// CIEDE2000.
const deltaE = (first, second) => {
  const [L1, a1, b1] = lab(first)
  const [L2, a2, b2] = lab(second)
  const rad = (degrees) => degrees * Math.PI / 180
  const deg = (radians) => radians * 180 / Math.PI
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const meanC = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h = (b, a) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360)
  const h1p = h(b1, a1p)
  const h2p = h(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0

  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    dhp = dhp > 180 ? dhp - 360 : dhp < -180 ? dhp + 360 : dhp
  }

  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2))
  const meanL = (L1 + L2) / 2
  const meanCp = (C1p + C2p) / 2
  let meanhp = h1p + h2p

  if (C1p * C2p === 0) {
    meanhp = h1p + h2p
  } else if (Math.abs(h1p - h2p) <= 180) {
    meanhp = (h1p + h2p) / 2
  } else {
    meanhp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2
  }

  const T = 1 - 0.17 * Math.cos(rad(meanhp - 30)) + 0.24 * Math.cos(rad(2 * meanhp)) + 0.32 * Math.cos(rad(3 * meanhp + 6)) - 0.2 * Math.cos(rad(4 * meanhp - 63))
  const dTheta = 30 * Math.exp(-(((meanhp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2)
  const Sc = 1 + 0.045 * meanCp
  const Sh = 1 + 0.015 * meanCp * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc

  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

const at = (object, path) => path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), object)

// What the gate measures against which surfaces: [label, token path of the foreground, surfaces]. A surface is a token path; the tooltip's is composited over the card. Surfaces that resolve to the same colour in a preset are measured once.
const SURFACES = ['surfaces.background', 'surfaces.card', 'surfaces.chrome']

// The planner's tones: each is drawn as text (an outlined chip, a label) and as the fill of a chip, so each is measured on both. `selected` is a button colour only, measured as a graphic.
const PLAN_TONES = ['mining', 'terraformFree', 'terraformPartial', 'terraformCheaper', 'cheap', 'moderate', 'costly', 'severe', 'insufficient', 'rich', 'cmc', 'unsurveyed']

// Colours that fill a chip or a control with text on it, which `inks.onFill` draws (styles/appearance.scss).
const FILL_TONES = ['focus.primary', 'severity.action', 'severity.attention', 'severity.info', 'severity.success', 'status.inactive', ...PLAN_TONES.map((tone) => `plan.${tone}`)]
const TEXT_CHECKS = [
  ['Body text', 'inks.body', SURFACES],
  ['Vuetify text (fields, lists, cards, tables, buttons)', 'inks.text', SURFACES],
  ['Vuetify secondary text (.text--secondary, labels, table heads)', 'inks.textMuted', SURFACES],
  ['Secondary text, rail icons, axis ticks', 'inks.muted', SURFACES],
  ['Links and selected text', 'focus.primary', SURFACES],
  ['Tooltip text', 'inks.onTooltip', ['charts.tooltip']],
  ['Sky labels', 'space.label', ['space.background']],
  ['Needs-action tone as text (outlined chips)', 'severity.action', ['surfaces.background', 'surfaces.card']],
  ['Attention tone as text', 'severity.attention', ['surfaces.background', 'surfaces.card']],
  ['Info tone as text', 'severity.info', ['surfaces.background', 'surfaces.card']],
  ['Success tone as text', 'severity.success', ['surfaces.background', 'surfaces.card']],
  ['Inactive tone as text', 'status.inactive', ['surfaces.background', 'surfaces.card']],
  ...PLAN_TONES.map((tone) => [`Planner tone ${tone} as text`, `plan.${tone}`, ['surfaces.background', 'surfaces.card']]),
]

const GRAPHIC_CHECKS = [
  ['Keyboard focus ring and selection mark', 'focus.primary', SURFACES],
  ['Compared-row mark', 'rows.differsMark', SURFACES],
  ['Needs-action severity', 'severity.action', SURFACES],
  ['Attention severity', 'severity.attention', SURFACES],
  ['Info severity', 'severity.info', SURFACES],
  ['Success', 'severity.success', SURFACES],
  ['Hostile contact', 'contacts.hostile', SURFACES],
  ['Unidentified contact', 'contacts.unknown', SURFACES],
  ['Neutral contact', 'contacts.neutral', SURFACES],
  ['Friendly contact', 'contacts.friendly', SURFACES],
  ['Allied contact', 'contacts.allied', SURFACES],
  ['Civilian contact', 'contacts.civilian', SURFACES],
  ['Inactive standing', 'status.inactive', SURFACES],
  ['Shortfall standing', 'status.shortfall', SURFACES],
  ['Orbit line in the system view', 'space.bodyOrbit', ['space.background']],
  ['Unexplored jump point in the system view', 'space.jumpUnexplored', ['space.background']],
  ['Explored jump point in the system view', 'space.jumpExplored', ['space.background']],
  ...[...PLAN_TONES, 'selected'].map((tone) => [`Planner tone ${tone}`, `plan.${tone}`, SURFACES]),
]

// The washes a table row takes over the card (styles/appearance.scss: the hover wash; a row that carries a wash of its own keeps it, or none, under the pointer; the picked and compared rows' washes are the pages'), and the text drawn in a row: the inks, the links and the tones a figure is coloured with.
const ROW_STATES = [
  ['hovered row', ['focus.hover']],
  ['selected row', ['rows.selected']],
  ['compared row that differs', ['rows.differs']],
  ['focused row, dark band of the hatching', ['rows.stripe']],
  ['focused row, light band of the hatching', ['rows.stripeSoft']],
]

// The rows that carry a wash of their own (the classes their pages or Vuetify give them) and the wash. appearance.scss settles each one's hover with a `.<class>:hover` rule; for a class it does not settle, the hover wash layers over the row's own, and that composition is measured too.
const WASHED_ROWS = [
  ['picked row', ['v-data-table__selected', 'is-selected-row', 'selected-row'], 'rows.selected'],
  ['compared row that differs', ['compare-differs'], 'rows.differs'],
  ['focused row, dark band of the hatching', ['is-focus-row'], 'rows.stripe'],
  ['focused row, light band of the hatching', ['is-focus-row'], 'rows.stripeSoft'],
]
const STYLESHEET = join(__dirname, '..', 'src', 'renderer', 'styles', 'appearance.scss')
const readSource = () => fs.readFileSync(STYLESHEET, 'utf8')

// The Galaxy Map page, whose `createMenu` the gate runs for the options it hands the menu library (icon ink, wedge colours): the method's source is cut out of the page and executed with a stub for `graph.cxtmenu` and a stand-in `this` that carries the preset, so a comment, a string or an explicit white cannot pass for the live option. The library draws icons white where `itemColor` is not given.
const MAP_PAGE = join(__dirname, '..', 'src', 'renderer', 'pages', 'map.vue')
const readMapSource = () => fs.readFileSync(MAP_PAGE, 'utf8')
const MENU_LIBRARY_INK = '#ffffff'
const MENU_INK_NAMES = { white: '#ffffff', black: '#000000' }
const MENU_APPEARANCE_IMPORT = /^import \{[^}]*\bMAP_MENU\b[^}]*\} from '\.\.\/utilities\/appearance'$/m

const menuOptions = (mapSource, appearance, MAP_MENU) => {
  if (!MENU_APPEARANCE_IMPORT.test(mapSource)) {
    throw new Error('pages/map.vue does not import MAP_MENU from utilities/appearance')
  }

  const lines = mapSource.split('\n')
  const start = lines.findIndex((line) => /^ {4}createMenu\(\) \{$/.test(line))
  const end = lines.findIndex((line, index) => index > start && line === '    },')
  const rgba = lines.find((line) => /^const rgba = /.test(line))

  if (start < 0 || end < 0 || !rgba) {
    throw new Error('pages/map.vue has no createMenu method or no rgba helper the gate can read')
  }

  let options = null
  const page = {
    menu: null,
    graph: { cxtmenu: (given) => { options = given; return { destroy: () => {} } } },
    theme: { primary: appearance.focus.primary, categorical: appearance.charts.categorical },
    appearance,
  }

  const { createMenu } = vm.compileFunction(`${rgba}\nreturn ({\n${lines.slice(start, end + 1).join('\n')}\n})`, ['MAP_MENU'])(MAP_MENU)

  createMenu.call(page)

  if (!options) {
    throw new Error('createMenu in pages/map.vue did not hand options to graph.cxtmenu')
  }

  return options
}

const compileStylesheet = (source) => sass.compileString(source).css

// The rules of a compiled stylesheet that set `color`: the selectors of each (whitespace normalised), the last colour it declares and whether that one is `!important`.
const parseRules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
  const color = body.split(';').map((declaration) => declaration.split(/:(.*)/s)).filter(([property]) => property.trim() === 'color').pop()

  return color ? [{ selectors: selectors.split(',').map((selector) => selector.replace(/\s+/g, ' ').trim()), value: color[1].replace(/!important\s*$/, '').trim(), important: /!important\s*$/.test(color[1]) }] : []
})

// The last rule that lists the selector exactly as written, or null: the colour the stylesheet finally draws for it.
const declaredColor = (rules, selector) => rules.filter((rule) => rule.selectors.includes(selector)).pop() || null

// The selector of the stylesheet's link rule as the compiled stylesheet writes it, and the `text-decoration-line` the stylesheet finally declares for a selector, or null.
const LINK_SELECTOR = '.v-application[style*="--ae-link-line"] a:not([class^=v-]):not([class*=" v-"])'
const declaredLine = (css, selector) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors, body]) => selectors.split(',').some((candidate) => candidate.replace(/\s+/g, ' ').trim() === selector) && /text-decoration-line\s*:/.test(body)).map(([, , body]) => /text-decoration-line\s*:\s*([^;]+)/.exec(body)[1].trim()).pop() || null

// A `var(--name)` colour as the root element sets it for the appearance (`appearanceStyle`); any other value as it stands.
const resolveVariable = (value, style) => {
  const variable = /^var\((--[\w-]+)\)$/.exec(value)

  return variable ? style[variable[1]] : value
}

const replaceOnce = (source, pattern, replacement) => {
  if (!pattern.test(source)) {
    throw new Error(`The self-test mutation does not apply: ${pattern} is not in the source it mutates`)
  }

  return source.replace(pattern, replacement)
}

// The selectors of appearance.scss that draw a filled primary button's and avatar's text, and Vuetify's own ink of them where the stylesheet declares none; `inks.onFill` has to be 4.5:1 on `focus.primary`.
const FILL_RULES = [
  ['filled primary button', '.v-application .v-btn:not(.v-btn--outlined):not(.v-btn--text):not(.v-btn--disabled).primary'],
  ['primary avatar', '.v-application .v-avatar.primary'],
]
const VUETIFY_FILL_INK = '#ffffff'

// Vuetify's own text colours of each theme (a baseline preset keeps them; the other theme of an adaptation does too).
const VUETIFY_TEXT = { light: { text: 'rgba(0, 0, 0, 0.87)', textMuted: 'rgba(0, 0, 0, 0.6)' }, dark: { text: '#ffffff', textMuted: 'rgba(255, 255, 255, 0.7)' } }

// Vuetify's own ink on a dark-theme surface filled with a named colour (the baselines keep it): white for a title, an icon and a button, 87 % white for a snackbar's message.
const VUETIFY_ON_COLOR = { onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' }
const ON_COLOR_VARIABLES = { onColor: '--ae-on-color', onSnackbar: '--ae-on-snackbar' }

// The named colours a toolbar or a snackbar is filled with in the app, and the token of the colour Vuetify's theme gives each (`vuetifyColors` in appearance.js).
const COLOUR_FILLS = [['primary', 'focus.primary'], ['success', 'severity.success'], ['error', 'severity.action'], ['warning', 'severity.attention'], ['info', 'severity.info']]

// The selectors of appearance.scss that draw the ink on such a surface (`{name}` is the colour), and the ordinary text ink rules that apply to the same elements where those are missing.
const COLOUR_SHEET = '.v-application .v-sheet.theme--dark.{name}:not(.v-snack__wrapper)'
const COLOUR_SNACKBAR = '.v-application .v-snack__wrapper.v-sheet.theme--dark.{name}'
const COLOUR_BUTTON = ' .v-btn:not(.v-btn--disabled):not(.v-btn--has-bg)'
const ORDINARY_SHEET = '.v-sheet:not(.v-snack__wrapper).theme--dark'
const ORDINARY_BUTTON = '.v-btn:not(.v-btn--has-bg):not(.v-btn--icon).theme--dark'

// The selectors of appearance.scss that draw Vuetify's text in `inks.text` (`text`) or `inks.textMuted` (`muted`) for a theme, as the stylesheet lists them, and whether the rule is `!important`. Each states the disabled state it leaves to Vuetify; dropping one of those, or a selector, is a failure.
const INK_RULES = [
  ['.v-application.theme--{theme}', 'text'],
  ['.v-sheet:not(.v-snack__wrapper).theme--{theme}', 'text'],
  ['.v-card.theme--{theme}', 'text'],
  ['.v-list.theme--{theme}', 'text'],
  ['.v-list-item:not(.v-list-item--active):not(.v-list-item--disabled).theme--{theme}', 'text'],
  ['.v-input:not(.v-input--is-disabled).theme--{theme}', 'text'],
  ['.v-input:not(.v-input--is-disabled).theme--{theme} input', 'text'],
  ['.v-input:not(.v-input--is-disabled).theme--{theme} textarea', 'text'],
  ['.v-select:not(.v-input--is-disabled).theme--{theme} .v-select__selections', 'text'],
  ['.v-chip.theme--{theme}', 'text'],
  ['.v-data-table.theme--{theme}', 'text'],
  ['.v-data-table.theme--{theme} .v-data-table-header th.sortable:hover', 'text'],
  ['.v-data-table.theme--{theme} .v-data-table-header th.sortable.active', 'text'],
  ['.v-expansion-panels.theme--{theme} .v-expansion-panel:not(.v-expansion-panel--disabled)', 'text'],
  ['.v-footer.theme--{theme}', 'text'],
  ['.v-pagination.theme--{theme} .v-pagination__item:not(.v-pagination__item--active)', 'text'],
  ['.v-btn:not(.v-btn--has-bg):not(.v-btn--icon).theme--{theme}', 'text'],
  ['.v-application.theme--{theme} .text--primary', 'text', true],
  ['.v-subheader.theme--{theme}', 'muted'],
  ['.v-list-item:not(.v-list-item--disabled).theme--{theme} .v-list-item__subtitle', 'muted'],
  ['.v-list-item:not(.v-list-item--disabled).theme--{theme} .v-list-item__action-text', 'muted'],
  ['.v-label:not(.v-label--is-disabled).theme--{theme}', 'muted'],
  ['.v-messages.theme--{theme}', 'muted'],
  ['.v-counter.theme--{theme}', 'muted'],
  ['.v-card.theme--{theme} > .v-card__text', 'muted'],
  ['.v-card.theme--{theme} > .v-card__subtitle', 'muted'],
  ['.v-data-table.theme--{theme} > .v-data-table__wrapper > table > thead > tr > th', 'muted'],
  ['.v-file-input.theme--{theme} .v-file-input__text--placeholder', 'muted'],
  ['.v-application.theme--{theme} .text--secondary', 'muted', true],
]

// Vuetify's fill of a pressed button of a toggle group, which the selected-row wash is drawn over (the bar is drawn on top).
const PRESSED_BUTTON = { light: '#f5f5f5', dark: '#272727' }

// Vuetify's own ink of disabled text (a disabled field's value and label, a disabled list item), drawn over the surface by its theme; the preset does not set it. WCAG exempts inactive components, so this is not a conformance floor but the Electrons one: the text stays readable (2.5:1 or more) on every surface of every preset, Light's own 2.7 being the lowest of the baseline presets.
const DISABLED_INK = { light: 'rgba(0, 0, 0, 0.38)', dark: 'rgba(255, 255, 255, 0.5)' }
const DISABLED_TEXT = 2.5

const ROW_TEXT = [
  ['body text', 'inks.body'],
  ['secondary text', 'inks.muted'],
  ['Vuetify text', 'inks.text'],
  ['Vuetify secondary text (.text--secondary)', 'inks.textMuted'],
  ['link', 'focus.primary'],
  ['needs-action figure', 'severity.action'],
  ['attention figure', 'severity.attention'],
  ['info figure', 'severity.info'],
  ['success figure', 'severity.success'],
  ['inactive standing', 'status.inactive'],
]

// Measured nowhere, and why.
const EXCEPTIONS = [
  ['surfaces.border', 'Hairlines between regions repeat a boundary the layout already gives; decorative.'],
  ['surfaces.rule', 'The hairline under a table head; decorative.'],
  ['surfaces.track and surfaces.trackSoft', 'The empty part of a meter and a chip fill: the filled part and the figure beside it carry the value; decorative.'],
  ['charts.axis (axis line, gridlines at 60%)', 'Tick labels (measured at 4.5:1) and the tooltip carry every value; gridlines and the axis line are decorative guides.'],
  ['rows.selected, rows.differs, rows.stripe, rows.stripeSoft, focus.hover as colours', 'Washes under content, so their own contrast is not the point; what is measured is the text on them ("Text on table row washes"). The compared row also carries a mark (3:1, measured) and a dot, the selected row a bar on its left edge, a rule along its cells and a bar on its last cell in the focus colour (3:1, measured).'],
  ['washes.*', 'Alphas of a section colour behind an active item; the item also carries the section icon, label and weight.'],
  ['Disabled controls (Vuetify disabled opacity)', 'Exempt under WCAG 1.4.3 and 1.4.11: inactive components. Disabled text is held at 2.5:1 or more as a legibility floor ("Disabled text"); a disabled button, which Vuetify draws fainter, is only exempt.'],
  ['Stars, planet terrain, orbit lines in the stars\' colour', 'Physical colours that depict the world, not a meaning; named in the legend by their label.'],
  ['Dark and Light, text and icons on the surfaces Vuetify\'s named colours fill (toolbar, snackbar)', 'The baselines keep Vuetify\'s own white, as before presets: on the primary and severity colours of Dark it is 2.4:1 to 3.2:1 (Light 5.0:1 to 6.6:1). Not measured and not changed, so that Light and Dark render as they did; only a preset with a `reference` is measured.'],
  ['A snackbar with no colour (Vuetify draws it at 87% white on a dark grey; the app always sets one), icons, tabs, placeholders, the text of a filled button in another colour than the primary (Vuetify colours)', 'appearance.scss leaves them on Vuetify\'s own colours: an icon is white on the dark theme and 54% black on the light one, an inactive tab 60% of the base ink, a placeholder 38 to 50%; the preset\'s text inks are not drawn in them, so the text rows above do not measure them.'],
  ['Hue independence of series, warning levels and selection', 'Measured: each categorical slot has its own colour, marker, dash and pattern, a preset with an edgeless card has an outline of 3:1, and a preset whose links are not told from its text by colour underlines them. Not measured, because the gate renders no page: that the renderers draw the markers, dashes and patterns (components/charts), that a warning level carries an icon and a label (utilities/warnings), a selected row a 3px bar and a rule, a pressed button a 3px bar, and that the system view\'s jump points differ in lightness and a gate gets a square outline.'],
]

const analyse = ({ resolveAppearance, listAppearances, SERIES_ENCODINGS, appearanceStyle, MAP_MENU }, options = {}) => {
  const results = []
  const appearances = options.preset ? [resolveAppearance(options.preset)] : listAppearances()
  const stylesheet = options.stylesheet === undefined ? compileStylesheet(readSource()) : options.stylesheet
  const rules = parseRules(stylesheet)
  const mapSource = options.mapSource === undefined ? readMapSource() : options.mapSource

  appearances.forEach((appearance) => {
    const card = parseColor(appearance.surfaces.card)
    const resolve = (path) => {
      const color = parseColor(at(appearance, path))

      return color.a < 1 ? over(color, card) : color
    }

    const report = { id: appearance.id, name: appearance.name, key: appearance.key, slotCount: appearance.charts.categorical.length, text: [], graphics: [], rows: [], categorical: [], cvd: [], selection: [], disabled: [], inkRules: [], inkTokens: [], colourSurfaces: [], menu: [], encodings: null }
    const distinct = (surfaces) => surfaces.filter((surface, index) => surfaces.findIndex((other) => hex(resolve(other)) === hex(resolve(surface))) === index)

    TEXT_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
      const background = resolve(surface)
      const foreground = over(parseColor(at(appearance, path)), background)
      const value = ratio(foreground, background)

      report.text.push({ label, foreground: at(appearance, path), surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: TEXT, pass: value >= TEXT })
    }))

    GRAPHIC_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
      const background = resolve(surface)
      const foreground = over(parseColor(at(appearance, path)), background)
      const value = ratio(foreground, background)

      report.graphics.push({ label, foreground: at(appearance, path), surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: GRAPHIC, pass: value >= GRAPHIC })
    }))

    distinct(SURFACES).forEach((surface) => {
      const background = resolve(surface)
      const value = ratio(over(parseColor(DISABLED_INK[appearance.mode]), background), background)

      report.disabled.push({ label: 'Disabled text', foreground: DISABLED_INK[appearance.mode], surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: DISABLED_TEXT, pass: value >= DISABLED_TEXT })
    })

    if (appearance.reference) {
      WARNING_LEVELS.forEach((level) => {
        const value = deltaE(parseColor(appearance.focus.primary), parseColor(appearance.severity[level]))

        report.selection.push({ label: `Selection colour against the ${level} severity`, foreground: appearance.focus.primary, surface: appearance.severity[level], ratio: value, minimum: SELECTION_DELTA, pass: value >= SELECTION_DELTA })
      })
    }

    const layered = WASHED_ROWS.flatMap(([state, classes, wash]) => {
      const unsettled = classes.filter((name) => !stylesheet.includes(`.${name}:hover`))

      return unsettled.length ? [[`hovered ${state}, washes layered (${unsettled.join(', ')})`, ['focus.hover', wash]]] : []
    })

    ROW_STATES.concat(layered).forEach(([state, washes]) => {
      const background = washes.reduce((below, path) => over(parseColor(at(appearance, path)), below), card)

      ROW_TEXT.forEach(([label, path]) => {
        const ink = at(appearance, path)
        const value = ratio(over(parseColor(ink), background), background)

        report.rows.push({ label: `${label} on a ${state}`, foreground: ink, surface: hex(background), ratio: value, minimum: TEXT, pass: value >= TEXT })
      })
    })

    const pressed = over(parseColor(appearance.rows.selected), parseColor(PRESSED_BUTTON[appearance.mode]))
    const bar = parseColor(appearance.focus.primary)
    const barRatio = ratio(bar, pressed)

    report.graphics.push({ label: 'Pressed toggle button bar, focused, hovered or not (the selected-row wash over the button)', foreground: appearance.focus.primary, surface: hex(pressed), surfacePath: 'buttons.pressed', ratio: barRatio, minimum: GRAPHIC, pass: barRatio >= GRAPHIC })

    const menuLabel = 'Map right-click menu icon'
    const menuFailure = (error) => report.menu.push({ label: 'Map right-click menu options', message: error.message, ratio: 0, minimum: GRAPHIC, pass: false })
    let menu = null

    try {
      menu = menuOptions(mapSource, appearance, MAP_MENU)
    } catch (error) {
      menuFailure(error)
    }

    if (menu) {
      const ink = menu.itemColor === undefined ? MENU_LIBRARY_INK : menu.itemColor

      try {
        const wedge = over(parseColor(menu.fillColor), parseColor(appearance.surfaces.background))
        const activeWedge = over(parseColor(menu.activeFillColor), wedge)

        ;[[`${menuLabel} on its wedge (the primary colour over the page)`, wedge], [`${menuLabel} on the wedge under the pointer (a categorical slot over the wedge)`, activeWedge]].forEach(([label, surface]) => {
          const value = ratio(over(parseColor(MENU_INK_NAMES[ink] || ink), surface), surface)

          report.menu.push({ label, foreground: String(ink), surface: hex(surface), ratio: value, minimum: GRAPHIC, pass: value >= GRAPHIC })
        })
      } catch (error) {
        menuFailure(error)
      }
    }

    const edgeless = appearance.reference ? ['surfaces.card', 'surfaces.chrome'].filter((path) => hex(resolve(path)) === hex(resolve('surfaces.background'))) : []

    if (edgeless.length) {
      const outline = ratio(resolve('surfaces.border'), resolve('surfaces.background'))

      report.graphics.push({ label: `Outline of a card or rail with the page's colour, its only edge (${edgeless.map((path) => path.split('.')[1]).join(', ')})`, foreground: appearance.surfaces.border, surface: appearance.surfaces.background, surfacePath: 'surfaces.background', ratio: outline, minimum: GRAPHIC, pass: outline >= GRAPHIC })
    }

    const encodings = SERIES_ENCODINGS
    const unique = (key) => new Set(encodings.map((encoding) => JSON.stringify(encoding[key]))).size === encodings.length
    report.fills = FILL_TONES.map((path) => {
      const fill = resolve(path)
      const value = ratio(parseColor(appearance.inks.onFill), fill)

      return { label: path, foreground: appearance.inks.onFill, surface: at(appearance, path), ratio: value, minimum: TEXT, pass: value >= TEXT }
    })

    FILL_RULES.forEach(([label, selector]) => {
      const rule = declaredColor(rules, selector)
      const ink = rule ? resolveVariable(rule.value, appearanceStyle(appearance)) : VUETIFY_FILL_INK
      const background = resolve('focus.primary')
      let value = 0

      try {
        value = ratio(over(parseColor(ink), background), background)
      } catch (error) {
        value = 0
      }

      report.fills.push({ label: `${label} (appearance.scss draws ${rule ? rule.value : 'nothing, so Vuetify draws white'})`, foreground: String(ink), surface: appearance.focus.primary, ratio: value, minimum: TEXT, pass: value >= TEXT })
    })

    const style = appearanceStyle(appearance)
    const THEMES = ['light', 'dark']

    const linkDelta = Math.min(deltaE(resolve('focus.primary'), resolve('inks.body')), deltaE(resolve('focus.primary'), resolve('inks.text')))
    const linkLine = declaredLine(stylesheet, LINK_SELECTOR)

    report.links = { delta: linkDelta, variable: style['--ae-link-line'] || null, rule: linkLine, pass: linkDelta >= SELECTION_DELTA || (style['--ae-link-line'] === 'underline' && linkLine === 'var(--ae-link-line)') }

    report.inkRules = INK_RULES.flatMap(([template, kind, important]) => THEMES.map((theme) => {
      const selector = template.replace('{theme}', theme)
      const expected = `var(--ae-text-${kind === 'muted' ? 'muted-' : ''}${theme})`
      const rule = declaredColor(rules, selector)

      return { selector, expected, declared: rule && rule.value, pass: Boolean(rule) && rule.value === expected && rule.important === Boolean(important) }
    }))

    THEMES.forEach((theme) => [['text', 'text'], ['muted', 'textMuted']].forEach(([kind, token]) => {
      const variable = `--ae-text-${kind === 'muted' ? 'muted-' : ''}${theme}`
      const expected = theme === appearance.mode ? appearance.inks[token] : VUETIFY_TEXT[theme][token]

      report.inkTokens.push({ message: `${variable} is ${style[variable]}, not ${expected} (${theme === appearance.mode ? `the preset's inks.${token}` : `Vuetify's own on the ${theme} theme`})`, pass: style[variable] === expected })

      if (!appearance.reference && theme === appearance.mode) {
        report.inkTokens.push({ message: `inks.${token} ${appearance.inks[token]} is not Vuetify's ${VUETIFY_TEXT[theme][token]}, which the ${appearance.mode} baseline keeps`, pass: appearance.inks[token] === VUETIFY_TEXT[theme][token] })
      }
    }))

    Object.entries(ON_COLOR_VARIABLES).forEach(([token, variable]) => {
      report.inkTokens.push({ message: `${variable} is ${style[variable]}, not inks.${token} ${appearance.inks[token]}`, pass: style[variable] === appearance.inks[token] })

      if (!appearance.reference) {
        report.inkTokens.push({ message: `inks.${token} ${appearance.inks[token]} is not Vuetify's ${VUETIFY_ON_COLOR[token]}, which the ${appearance.mode} baseline keeps`, pass: appearance.inks[token] === VUETIFY_ON_COLOR[token] })
      }
    })

    if (appearance.reference) {
      const declared = (selector, name) => {
        const rule = declaredColor(rules, selector.split('{name}').join(name))

        return rule && rule.value
      }
      const ordinary = (selector) => declared(selector, '') || VUETIFY_ON_COLOR.onColor

      COLOUR_FILLS.forEach(([name, path]) => {
        const fill = resolve(path)
        const own = (selector, fallback, parent) => {
          const found = declared(selector, name)
          const drawn = found === null ? fallback : found

          return drawn === 'inherit' ? parent : drawn
        }
        const title = own(COLOUR_SHEET, ordinary(ORDINARY_SHEET), null)
        const textButton = own(COLOUR_SHEET + COLOUR_BUTTON, VUETIFY_ON_COLOR.onColor, title)
        const icon = own(COLOUR_SHEET + ' .v-icon', VUETIFY_ON_COLOR.onColor, title)
        const buttonIcon = own(COLOUR_SHEET + ' .v-icon', VUETIFY_ON_COLOR.onColor, textButton)
        const message = own(COLOUR_SNACKBAR, VUETIFY_ON_COLOR.onSnackbar, null)
        const snackbarButton = own(COLOUR_SNACKBAR + COLOUR_BUTTON, ordinary(ORDINARY_BUTTON), message)

        ;[['toolbar title', title, TEXT], ['toolbar text button', textButton, TEXT], ['toolbar icon', icon, GRAPHIC], ['toolbar icon button', buttonIcon, GRAPHIC], ['snackbar message', message, TEXT], ['snackbar text button', snackbarButton, TEXT]].forEach(([what, drawn, minimum]) => {
          let value = 0
          let resolved = String(drawn)

          try {
            resolved = resolveVariable(drawn, style)
            value = ratio(over(parseColor(resolved), fill), fill)
          } catch (error) {
            value = 0
          }

          report.colourSurfaces.push({ label: `${what} on the ${name} fill`, foreground: String(resolved), surface: hex(fill), ratio: value, minimum, pass: value >= minimum })
        })
      })
    }

    report.encodings = { slots: encodings.length, markers: unique('marker'), dashes: unique('dash'), patterns: unique('pattern'), colours: new Set(appearance.charts.categorical.map((color) => color.toLowerCase())).size === appearance.charts.categorical.length }
    appearance.charts.categorical.forEach((color, slot) => {
      distinct(SURFACES).forEach((surface) => {
        const background = resolve(surface)
        const value = ratio(parseColor(color), background)

        report.categorical.push({ slot, color, surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: GRAPHIC, pass: value >= GRAPHIC })
      })
    })

    Object.entries(MACHADO).concat([['normal vision', null]]).forEach(([vision, matrix]) => {
      const seen = appearance.charts.categorical.map((color) => (matrix ? simulate(parseColor(color), matrix) : parseColor(color)))
      let any = { delta: Infinity, pair: null }
      let neighbour = { delta: Infinity, pair: null }

      for (let first = 0; first < seen.length; first++) {
        for (let second = first + 1; second < seen.length; second++) {
          const delta = deltaE(seen[first], seen[second])

          if (delta < any.delta) {
            any = { delta, pair: [first, second] }
          }

          if (second === first + 1 && delta < neighbour.delta) {
            neighbour = { delta, pair: [first, second] }
          }
        }
      }

      report.cvd.push({ vision, any, neighbour, simulated: seen.map(hex) })
    })

    results.push(report)
  })

  return results
}

const failures = (reports) => reports.flatMap((report) => [
  ...report.text.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.graphics.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.rows.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.categorical.filter((row) => !row.pass).map((row) => `${report.id}: slot ${row.slot} ${row.color} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1 (a marker or pattern does not stand in for the colour)`),
  ...report.selection.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} against ${row.surface} differs by only ${row.ratio.toFixed(1)}, under ${row.minimum}`),
  ...report.disabled.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.fills.filter((row) => !row.pass).map((row) => `${report.id}: text ${row.foreground} on the ${row.label} fill ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.inkRules.filter((row) => !row.pass).map((row) => `${report.id}: ${row.selector} draws ${row.declared || 'Vuetify\'s own colour'}, not ${row.expected}`),
  ...report.colourSurfaces.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.menu.filter((row) => !row.pass).map((row) => `${report.id}: ${row.message || `${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`}`),
  ...report.inkTokens.filter((row) => !row.pass).map((row) => `${report.id}: ${row.message}`),
  ...(report.encodings.markers && report.encodings.dashes && report.encodings.patterns && report.encodings.slots === report.slotCount ? [] : [`${report.id}: the series encodings do not give each of the ${report.slotCount} slots its own marker, dash and pattern`]),
  ...report.encodings.colours ? [] : [`${report.id}: two categorical slots are the same colour, so a series cannot be told which slot it is, and they would share a marker, a dash and a pattern`],
  ...report.links.pass ? [] : [`${report.id}: links are ${report.links.delta.toFixed(1)} CIEDE2000 from the text ink, under ${SELECTION_DELTA}, and have no other cue: --ae-link-line is ${report.links.variable || 'not set'} and the stylesheet's link rule draws ${report.links.rule || 'nothing'}`],
  ...report.cvd.filter((row) => row.vision !== 'normal vision' && row.neighbour.delta < CVD_NEIGHBOUR_DELTA).map((row) => `${report.id}: ${row.vision}: neighbouring slots ${row.neighbour.pair.join(' and ')} differ by only ${row.neighbour.delta.toFixed(1)}`),
])

const format = (reports, verbose) => {
  const lines = []
  const mark = (pass) => (pass ? 'ok  ' : 'FAIL')

  reports.forEach((report) => {
    lines.push(`\n== ${report.name} (${report.key}) ==`)
    lines.push('Text, minimum 4.5:1')
    report.text.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surfacePath.split('.')[1]} ${row.surface}`))
    lines.push('Essential graphics and state cues, minimum 3:1')
    report.graphics.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surfacePath.split('.')[1]} ${row.surface}`))
    lines.push('Text on table row washes (the card under the wash), minimum 4.5:1')
    report.rows.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surface}`))
    lines.push('Categorical slots against the card and the page, minimum 3:1 (the encodings come on top of the colour, they do not replace it)')
    report.categorical.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  slot ${row.slot}: ${row.color} on ${row.surfacePath.split('.')[1]} ${row.surface}`))
    lines.push(`Text on filled chips and controls, ink ${report.fills[0].foreground}, minimum 4.5:1`)
    report.fills.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surface}`))
    if (report.colourSurfaces.length) {
      lines.push('Text and icons on the surfaces Vuetify\'s named colours fill (toolbar, snackbar), title, message and buttons 4.5:1, icons 3:1')
      report.colourSurfaces.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surface}`))
    }

    lines.push('Icons of the Galaxy Map\'s right-click menu on its wedges, minimum 3:1')
    report.menu.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.message || `${row.foreground} on ${row.surface}`}`))

    lines.push(`Vuetify's text inks in appearance.scss (compiled): ${report.inkRules.filter((row) => row.pass).length} of ${report.inkRules.length} selectors draw the preset's text inks, ${report.inkTokens.filter((row) => row.pass).length} of ${report.inkTokens.length} variables and baselines hold`)

    if (report.selection.length) {
      lines.push(`Selection colour against the warning severities, CIEDE2000 minimum ${SELECTION_DELTA}`)
      report.selection.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(1).padStart(5)}  ${row.label}: ${row.foreground} against ${row.surface}`))
    }

    lines.push(`Links: the focus colour is ${report.links.delta.toFixed(1)} CIEDE2000 from the text ink (minimum ${SELECTION_DELTA} to tell a link by colour); --ae-link-line ${report.links.variable || 'not set'}, the stylesheet's link rule draws ${report.links.rule || 'nothing'}: ${report.links.pass ? 'ok' : 'FAIL'}`)

    lines.push(`Disabled text (Vuetify's own ink), legibility floor ${DISABLED_TEXT}:1`)
    report.disabled.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surfacePath.split('.')[1]} ${row.surface}`))

    lines.push(`Encodings: ${report.encodings.slots} slots, markers unique ${report.encodings.markers}, dashes unique ${report.encodings.dashes}, patterns unique ${report.encodings.patterns}`)
    lines.push('Colour-vision simulation, smallest CIEDE2000 between two slots (any pair, neighbours)')

    report.cvd.forEach((row) => {
      lines.push(`  ${row.vision.padEnd(13)} any ${row.any.delta.toFixed(1).padStart(5)} (${row.any.pair.join('/')})  neighbours ${row.neighbour.delta.toFixed(1).padStart(5)} (${row.neighbour.pair.join('/')})${row.any.delta < CVD_ANY_DELTA && row.vision !== 'normal vision' ? '  close pair: the encodings carry it' : ''}`)

      if (verbose) {
        lines.push(`      ${row.simulated.join(' ')}`)
      }
    })
  })

  lines.push('\nExceptions, not measured:')
  EXCEPTIONS.forEach(([token, reason]) => lines.push(`  ${token}: ${reason}`))

  return lines.join('\n')
}

// Mutations the gate must catch, so that it can't pass by measuring nothing: a slot the colour of the card (its markers and patterns don't make it visible), a chip whose text is the colour of its fill, a row wash as dark as Vuetify's own dark-theme hover, a compared row whose hover the stylesheet leaves unsettled (so the two washes layer), a pressed-button wash that takes the bar under 3:1, a selection colour that is a warning's, an orbit line the colour of the sky, surfaces that take Vuetify's disabled text under its floor, an edgeless card with a faint outline, two slots of one colour, a pastel too dark for black text, a link that is the colour of its text with no underline and, on the stylesheet, a fill rule or a text rule that keeps its selector and draws another colour, one that loses its selector or its disabled exclusion, a link rule that loses its selector or draws no line, and baselines whose text inks differ from Vuetify's. The fifth item, when there is one, mutates the source of appearance.scss (it is compiled afterwards; a pattern that does not apply is an error).
const MUTATIONS = [
  ['a categorical slot the colour of the card', 'light', (appearance) => ({ ...appearance, charts: { ...appearance.charts, categorical: appearance.charts.categorical.map((color, slot) => (slot === 5 ? appearance.surfaces.card : color)) } }), /slot 5 .* under 3:1/],
  ['a chip whose text is its fill', 'dark', (appearance) => ({ ...appearance, plan: { ...appearance.plan, rich: appearance.inks.onFill } }), /plan\.rich fill .* under 4\.5:1/],
  ['a chip with white text on a light fill', 'light', (appearance) => ({ ...appearance, plan: { ...appearance.plan, costly: '#ffb74d' } }), /plan\.costly fill .* under 4\.5:1/],
  ['a hover wash as dark as Vuetify\'s own on the dark theme', 'dark', (appearance) => ({ ...appearance, focus: { ...appearance.focus, hover: '#616161' } }), /needs-action figure .* hovered row .* under 4\.5:1/],
  ['a compared row whose hover the stylesheet leaves unsettled', 'dark', (appearance) => appearance, /needs-action figure on a hovered compared row that differs, washes layered .* under 4\.5:1/, (source) => replaceOnce(source, /\.compare-differs:hover/g, '.compare-differs-off:hover')],
  ['a pressed-button wash as bright as the bar', 'dark', (appearance) => ({ ...appearance, rows: { ...appearance.rows, selected: 'rgba(255, 255, 255, .5)' } }), /Pressed toggle button bar.* under 3:1/],
  ['a selection colour that is the info severity', 'solaris', (appearance) => ({ ...appearance, focus: { ...appearance.focus, primary: appearance.severity.info } }), /Selection colour against the info severity .* differs by only/],
  ['an orbit line the colour of the sky', 'classic', (appearance) => ({ ...appearance, space: { ...appearance.space, bodyOrbit: appearance.space.background } }), /Orbit line in the system view .* under 3:1/],
  ['surfaces mid-grey under Vuetify\'s disabled text', 'classic', (appearance) => ({ ...appearance, surfaces: { ...appearance.surfaces, background: '#8a8a8a', card: '#8a8a8a', chrome: '#8a8a8a' } }), /Disabled text .* under 2\.5:1/],
  ['a stylesheet without the primary button text selector', 'solaris', (appearance) => appearance, /filled primary button \(appearance\.scss draws nothing.* under 4\.5:1/, (source) => replaceOnce(source, /\.v-btn:not\(\.v-btn--outlined\):not\(\.v-btn--text\):not\(\.v-btn--disabled\)\.primary,/, '.v-btn-off,')],
  ['a stylesheet without the primary avatar text selector', 'solaris', (appearance) => appearance, /primary avatar \(appearance\.scss draws nothing.* under 4\.5:1/, (source) => replaceOnce(source, /\.v-avatar\.primary \{/, '.v-avatar.primary-off {')],
  ['a primary fill rule that keeps its selectors and draws white', 'solaris', (appearance) => appearance, /filled primary button \(appearance\.scss draws #ffffff\) .* under 4\.5:1/, (source) => replaceOnce(source, /(\.v-avatar\.primary \{\s*color:) var\(--ae-on-fill\)/, '$1 #ffffff')],
  ['a text rule that keeps its selector and draws white', 'classic', (appearance) => appearance, /\.v-application\.theme--dark \.text--secondary draws #ffffff, not var\(--ae-text-muted-dark\)/, (source) => replaceOnce(source, /(\.text--secondary \{\s*color:) var\(--ae-text-muted-#\{\$theme\}\)/, '$1 #ffffff')],
  ['a text rule that loses its disabled exclusion', 'solaris', (appearance) => appearance, /\.v-label:not\(\.v-label--is-disabled\)\.theme--light draws Vuetify's own colour/, (source) => replaceOnce(source, /\.v-label:not\(\.v-label--is-disabled\)\.theme--#\{\$theme\},/, '.v-label.theme--#{$theme},')],
  ['a dark baseline whose text ink is not Vuetify\'s', 'dark', (appearance) => ({ ...appearance, inks: { ...appearance.inks, text: '#f5f5f5' } }), /inks\.text #f5f5f5 is not Vuetify's #ffffff/],
  ['a toolbar whose text rule is reverted to the ordinary ink', 'classic', (appearance) => appearance, /toolbar title on the primary fill .* under 4\.5:1/, (source) => replaceOnce(source, /(\.v-sheet\.theme--dark\.#\{\$name\}:not\(\.v-snack__wrapper\) \{\s*color:) var\(--ae-on-color\)/, '$1 var(--ae-text-dark)')],
  ['a snackbar text button reverted to the ordinary ink', 'solaris', (appearance) => appearance, /snackbar text button on the success fill .* under 4\.5:1/, (source) => replaceOnce(source, /(\.v-btn:not\(\.v-btn--disabled\):not\(\.v-btn--has-bg\) \{\s*color:) var\(--ae-on-color\)/, '$1 var(--ae-text-dark)')],
  ['a snackbar message rule that loses its selector', 'solaris', (appearance) => appearance, /snackbar message on the error fill .* under 4\.5:1/, (source) => replaceOnce(source, /\.v-snack__wrapper\.v-sheet\.theme--dark\.#\{\$name\} \{/, '.v-snack__wrapper-off.v-sheet.theme--dark.#{$name} {')],
  ['a toolbar icon that keeps Vuetify\'s white', 'classic', (appearance) => appearance, /toolbar icon on the primary fill #ffffff .* under 3:1/, (source) => replaceOnce(source, /(\.v-sheet\.theme--dark\.#\{\$name\}:not\(\.v-snack__wrapper\) \{\s*color: var\(--ae-on-color\);\s*)\.v-icon,\s*/, '$1')],
  ['an on-colour ink that is white on a dark preset', 'solaris', (appearance) => ({ ...appearance, inks: { ...appearance.inks, onColor: '#ffffff' } }), /toolbar title on the primary fill #ffffff .* under 4\.5:1/],
  ['a dark baseline whose snackbar message is not Vuetify\'s', 'dark', (appearance) => ({ ...appearance, inks: { ...appearance.inks, onSnackbar: '#ffffff' } }), /inks\.onSnackbar #ffffff is not Vuetify's rgba\(255, 255, 255, 0\.87\)/],
  ['a text ink the colour of the card', 'classic', (appearance) => ({ ...appearance, inks: { ...appearance.inks, text: appearance.surfaces.card } }), /Vuetify text \(.*\) .* under 4\.5:1/],
  ['a card with the page\'s colour and a faint outline', 't2d', (appearance) => ({ ...appearance, surfaces: { ...appearance.surfaces, border: '#1a1a1a' } }), /Outline of a card or rail with the page's colour, .* under 3:1/],
  ['two categorical slots of one grey', 't2d', (appearance) => ({ ...appearance, charts: { ...appearance.charts, categorical: appearance.charts.categorical.map((color, slot) => (slot === 3 ? appearance.charts.categorical[1] : color)) } }), /two categorical slots are the same colour/],
  ['a severity pastel too dark for black text', 't2d', (appearance) => ({ ...appearance, severity: { ...appearance.severity, action: '#c62828' } }), /severity\.action fill .* under 4\.5:1/],
  ['a white focus colour with no link underline', 't2d', (appearance) => ({ ...appearance, focus: { ...appearance.focus, linkLine: undefined } }), /links are .* CIEDE2000 from the text ink, under 20, and have no other cue: --ae-link-line is not set/],
  ['a link colour that is the text ink with no underline', 'solaris', (appearance) => ({ ...appearance, focus: { ...appearance.focus, primary: appearance.inks.body } }), /links are 0\.0 CIEDE2000 from the text ink/],
  ['a link rule that loses its selector', 't2d', (appearance) => appearance, /the stylesheet's link rule draws nothing/, (source) => replaceOnce(source, /\.v-application\[style\*='--ae-link-line'\] a:not/, ".v-application[style*='--ae-link-line-off'] a:not")],
  ['a link rule that draws no line', 't2d', (appearance) => appearance, /the stylesheet's link rule draws none/, (source) => replaceOnce(source, /text-decoration-line: var\(--ae-link-line\)/, 'text-decoration-line: none')],
  ['a menu icon ink that is white on a light primary', 'solaris', (appearance) => ({ ...appearance, inks: { ...appearance.inks, onColor: '#ffffff' } }), /Map right-click menu icon on its wedge .* #ffffff on .* under 3:1/],
  ['a menu whose icons keep the library\'s white', 't2d', (appearance) => appearance, /Map right-click menu icon on its wedge .* #ffffff on .* under 3:1/, null, (source) => replaceOnce(source, /\s*itemColor: this\.appearance\.inks\.onColor,/, '')],
  ['a menu whose pointer wedge is the icon colour', 't2d', (appearance) => ({ ...appearance, charts: { ...appearance.charts, categorical: appearance.charts.categorical.map((color, slot) => (slot === 2 ? appearance.inks.onColor : color)) } }), /Map right-click menu icon on the wedge under the pointer .* under 3:1/],
  ['a menu icon ink that is only a line comment', 't2d', (appearance) => appearance, /Map right-click menu icon on its wedge .* #ffffff on .* under 3:1/, null, (source) => replaceOnce(source, /^( +)(itemColor: this\.appearance\.inks\.onColor,)$/m, '$1// $2')],
  ['a menu icon ink that is only a block comment', 't2d', (appearance) => appearance, /Map right-click menu icon on its wedge .* #ffffff on .* under 3:1/, null, (source) => replaceOnce(source, /^( +)(itemColor: this\.appearance\.inks\.onColor,)$/m, '$1/* $2 */')],
  ['a menu icon ink that is an explicit white beside a stale comment', 't2d', (appearance) => appearance, /Map right-click menu icon on its wedge .* #ffffff on .* under 3:1/, null, (source) => replaceOnce(source, /^( +)(itemColor: this\.appearance\.inks\.onColor,)$/m, "$1itemColor: '#ffffff', // $2")],
  ['a map page that stops importing the menu constants', 't2d', (appearance) => appearance, /pages\/map\.vue does not import MAP_MENU/, null, (source) => replaceOnce(source, /import \{ activeAppearance, MAP_MENU \} from/, 'import { activeAppearance } from')],
]

const selfTest = (utilities) => MUTATIONS.map(([label, id, mutate, expected, mutateSource, mutateMap]) => {
  const mutated = mutate(utilities.resolveAppearance(id))
  const stylesheet = compileStylesheet(mutateSource ? mutateSource(readSource()) : readSource())
  const mapSource = mutateMap ? mutateMap(readMapSource()) : readMapSource()
  const found = failures(analyse({ ...utilities, resolveAppearance: () => mutated, listAppearances: () => [mutated] }, { stylesheet, mapSource }))

  return { label, caught: found.some((problem) => expected.test(problem)) }
})

const main = async () => {
  const argv = process.argv.slice(2)
  const options = { preset: null, verbose: false }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--preset') {
      options.preset = argv[++index]
    } else if (argv[index] === '--verbose') {
      options.verbose = true
    } else {
      console.error(`Unknown argument ${argv[index]}`)
      process.exit(2)
    }
  }

  const { appearance } = await loadUtilities(['appearance'], { stubs: { vue: 'export default { observable: (value) => value }' } })
  const reports = analyse(appearance, options)
  const problems = failures(reports)

  console.log(format(reports, options.verbose))

  const missed = selfTest(appearance).filter((mutation) => !mutation.caught)

  console.log(`\nSelf-test: ${MUTATIONS.length - missed.length} of ${MUTATIONS.length} mutations are caught`)
  missed.forEach((mutation) => problems.push(`self-test: the gate does not catch ${mutation.label}`))

  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`)
    problems.forEach((problem) => console.log(`  ${problem}`))
    process.exit(1)
  }

  console.log('\nEvery measurement passes.')
}

if (require.main === module) {
  main()
}

module.exports = { analyse, deltaE, parseColor, ratio, simulate }
