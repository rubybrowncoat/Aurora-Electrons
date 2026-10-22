// The contrast measurements of an appearance that need no stylesheet and no browser: WCAG 2.x ratios of the resolved tokens (utilities/appearance.js) against the surfaces they are drawn on. scripts/check-contrast.js measures every preset with them (and adds what needs the compiled stylesheet and the colour-vision simulation), and the import of an appearance file measures the draft with the same tables before it can be applied, so a file and a preset are held to one standard.

export const TEXT = 4.5
export const GRAPHIC = 3
export const DISABLED_TEXT = 2.5

export const parseColor = (value) => {
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
export const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })

export const linear = (channel) => {
  const value = channel / 255

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

export const ratio = (foreground, background) => {
  const first = luminance(foreground)
  const second = luminance(background)
  const light = first >= second ? first : second
  const dark = first >= second ? second : first

  return (light + 0.05) / (dark + 0.05)
}

const CHANNEL_HEX = Array.from({ length: 256 }, (_unused, value) => value.toString(16).padStart(2, '0'))

const channelHex = (channel) => CHANNEL_HEX[Math.round(Math.max(0, Math.min(255, channel)))] ?? 'NaN'

export const hex = ({ r, g, b }) => `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`

export const at = (object, path) => path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), object)

// What is measured against which surfaces: [label, token path of the foreground, surfaces]. A surface is a token path; the tooltip's is composited over the card. Surfaces that resolve to the same colour in a preset are measured once.
export const SURFACES = ['surfaces.background', 'surfaces.card', 'surfaces.chrome']

// The opacity of the overlay Vuetify 2.7.2 draws over a list entry in the colour of its text (`.v-list-item::before` in `currentColor`), by theme and state: `hover` under the pointer, `focus` while it holds focus, `activated` while it is the active entry, `pressed` while the active entry holds focus and for the entry a menu's keyboard highlights. They are the `states` of the theme (src/styles/settings/_light.scss and _dark.scss) that `+states` in components/VList/VListItem.sass applies, and the stylesheet of the app holds every state but the hovered one to `LIST_VEIL` (styles/appearance.scss). scripts/check-contrast.js and scripts/check-section-accents.js read those two files and fail when these numbers differ from them.
export const VUETIFY_LIST_STATES = { light: { hover: 0.04, focus: 0.12, activated: 0.12, pressed: 0.16 }, dark: { hover: 0.08, focus: 0.24, activated: 0.24, pressed: 0.32 } }

// What every list (a menu's, a dropdown's, the history menu's) holds that overlay to in every state: the opacity of a hovered entry. A focused, active or highlighted entry is told by the colour of its text (an active entry's is the focus colour) and, for the keyboard's highlight, by a ring in the focus colour, and not by a heavier wash, because the heavier one takes a section colour (the history menu's icons) under 3:1 and the focus colour (an active entry's text) under 4.5:1 on the dark card (Vuetify's strongest over it is a mid grey). scripts/check-contrast.js reads the compiled stylesheet and fails when it declares another opacity, or none.
export const LIST_VEIL = { light: VUETIFY_LIST_STATES.light.hover, dark: VUETIFY_LIST_STATES.dark.hover }

// The layer of `SECTION_WASHES` that is that overlay: `inks.text` at `LIST_VEIL` of the appearance's mode (or the opacity a caller reads from the stylesheet).
export const LIST_VEIL_LAYER = 'veil.list'

// The washes a section accent is drawn over, each `[state, layers, surfaces]`: the layers bottom to top over each surface, a `washes.` path being the accent at that alpha, `veil.list` the overlay of a list entry (`LIST_VEIL`) and any other path a colour of the appearance, and the accent drawn as an icon, a bar or a dot on the result. The active wash is the rail's active pill, the current step of the trail, the flyout's active entry and a picked research row; the hover wash is the rail's hovered pill and the icon plate of a plain row of the flyout or the palette. The icon plate of a row that has a wash of its own is drawn over it: over the active entry of the flyout, which takes the active wash, and over a hovered row of the flyout or a selected row of the palette, which take the hover colour, on the chrome the flyout is drawn on and the card the palette is. A hovered table row is the hover colour over the card (the planner's score meters are drawn in it), and a list entry is the card under the overlay Vuetify draws over it (the history menu's icons).
export const SECTION_WASHES = [
  ['active wash', ['washes.sectionSoft'], SURFACES],
  ['hover wash', ['washes.sectionTint'], SURFACES],
  ['plate over the active entry', ['washes.sectionSoft', 'washes.sectionTint'], ['surfaces.chrome']],
  ['plate over a hovered row', ['focus.hover', 'washes.sectionTint'], ['surfaces.chrome', 'surfaces.card']],
  ['hovered table row', ['focus.hover'], ['surfaces.card']],
  ['list entry under its overlay', [LIST_VEIL_LAYER], ['surfaces.card']],
]

// The text colour drawn for the count of the research fields whose technologies can be started (`.rail-now` in components/research/FieldsView.vue), which is not a token but the colour of the available status (a chart slot, `AVAILABLE_STATUS_SLOT`; `statusColors` in components/research/status-style.js) made readable on the washes it sits under (`readableWashText`; the style carries it as `--st-available-text`).
export const AVAILABLE_STATUS_SLOT = 2
export const STATUS_TEXT = 'status.availableText'

// The text the same washes sit under, each `[state, layers, surfaces, inks]` with the path of every ink drawn on it, at 4.5:1: a token of the appearance (the rows of `ROW_TEXT` name them), a token at an opacity (`inks.body@0.8`: the flyout's live line is the body ink at 80 %), or `STATUS_TEXT`. The flyout's active entry, whose description is secondary text on the active wash over the chrome and whose live line is the body ink at 80 %; the active race of the Empires list; a picked research field, its abbreviation drawn in a wash of its own over the picked row's wash (and over the hover wash of a row under the pointer) and its count of what can be started drawn on the picked row's wash and on the hover wash of one under the pointer; the count in a panel's header; the chip of a chosen body class; a chosen legend row. Ink that is not an accent, over a wash that is one, so a wash too strong for its text is a finding too.
export const SECTION_WASH_TEXTS = [
  ['active wash', ['washes.sectionSoft'], SURFACES, ['inks.body', 'inks.muted', 'inks.text', 'inks.textMuted']],
  ['hover wash', ['washes.sectionTint'], SURFACES, ['inks.body', 'inks.muted', 'inks.text', 'inks.textMuted']],
  ['active wash over the active wash', ['washes.sectionSoft', 'washes.sectionSoft'], ['surfaces.card'], ['inks.body', 'inks.text']],
  ['active wash over the hover wash', ['washes.sectionTint', 'washes.sectionSoft'], ['surfaces.card'], ['inks.body', 'inks.text']],
  ['active wash', ['washes.sectionSoft'], ['surfaces.chrome'], ['inks.body@0.8']],
  ['active wash', ['washes.sectionSoft'], ['surfaces.card'], [STATUS_TEXT]],
  ['hover wash', ['washes.sectionTint'], ['surfaces.card'], [STATUS_TEXT]],
]

// The text of a list entry under the overlay Vuetify draws over it in the colour of the entry's own text (`.v-list-item::before` in `currentColor`): each `[state, overlay colour, state of the overlay, inks]`, the overlay at `hover` (the opacity of a hovered entry, which the stylesheet leaves as it is) or `held` (what the stylesheet holds every other state to, `LIST_VEIL`, or the strongest of Vuetify's own when it declares none), on the card the list is drawn on (styles/appearance.scss). A plain entry is drawn in `inks.text`, with `inks.textMuted` for a subtitle; an entry that is active (the chosen one of a dropdown) is drawn in the focus colour, under an overlay in that colour, and takes the held overlay hovered, focused and highlighted alike, with a subtitle in `inks.textMuted`.
export const LIST_TEXTS = [
  ['entry under the pointer', 'inks.text', 'hover', ['inks.text', 'inks.textMuted']],
  ['entry focused or highlighted', 'inks.text', 'held', ['inks.text', 'inks.textMuted']],
  ['active entry', 'focus.primary', 'held', ['focus.primary', 'inks.textMuted']],
]

// The bar on the leading edge of a chosen list entry (`.v-list-item--active` in styles/appearance.scss), in the focus colour at 3:1 against the entry: the overlay of the entry (held at `LIST_VEIL`) lies over the bar and over the card behind it alike, in the colour of the entry's text, which is the text ink for a plain or hand-written entry and the focus colour for one a dropdown draws as its chosen option.
export const LIST_BAR_OVERLAYS = [['text ink', 'inks.text'], ['focus colour', 'focus.primary']]

// The planner's tones: each is drawn as text (an outlined chip, a label) and as the fill of a chip, so each is measured on both. `selected` is a button colour only, measured as a graphic.
export const PLAN_TONES = ['mining', 'terraformFree', 'terraformPartial', 'terraformCheaper', 'cheap', 'moderate', 'costly', 'severe', 'insufficient', 'rich', 'cmc', 'unsurveyed']

// Colours that fill a chip or a control with text on it, which `inks.onFill` draws (styles/appearance.scss).
export const FILL_TONES = ['focus.primary', 'severity.action', 'severity.attention', 'severity.info', 'severity.success', 'status.inactive', ...PLAN_TONES.map((tone) => `plan.${tone}`)]

export const TEXT_CHECKS = [
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
  ['Count of the research fields that can be started (the available status colour made readable)', STATUS_TEXT, ['surfaces.card']],
  ...PLAN_TONES.map((tone) => [`Planner tone ${tone} as text`, `plan.${tone}`, ['surfaces.background', 'surfaces.card']]),
]

export const GRAPHIC_CHECKS = [
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
export const ROW_STATES = [
  ['hovered row', ['focus.hover']],
  ['selected row', ['rows.selected']],
  ['compared row that differs', ['rows.differs']],
  ['focused row, dark band of the hatching', ['rows.stripe']],
  ['focused row, light band of the hatching', ['rows.stripeSoft']],
]

export const ROW_TEXT = [
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

// The text of a row of the flyout or of the Empires list, which are drawn on the chrome and take the hover colour under the pointer (the inks and the focus colour of a chip or a link).
export const HOVERED_ENTRY_TEXT = ['inks.body', 'inks.muted', 'inks.text', 'inks.textMuted', 'focus.primary']

// What an ink path of the tables above is called in a finding: the role of the token (`ROW_TEXT`), with its opacity when it has one, or the count of the available technologies.
export const washInkLabel = (path) => {
  const [token, opacity] = path.split('@')
  const role = token === STATUS_TEXT ? 'count of available technologies' : ROW_TEXT.find(([, tokenPath]) => tokenPath === token)[0]

  return opacity === undefined ? role : `${role} at ${Math.round(opacity * 100)} %`
}

// Vuetify's fill of a pressed button of a toggle group, which the selected-row wash is drawn over (the bar is drawn on top).
export const PRESSED_BUTTON = { light: '#f5f5f5', dark: '#272727' }

// Vuetify's own ink of disabled text (a disabled field's value and label, a disabled list item), drawn over the surface by its theme; the preset does not set it. WCAG exempts inactive components, so this is not a conformance floor but the Electrons one: the text stays readable (2.5:1 or more) on every surface of every preset, Light's own 2.7 being the lowest of the baseline presets.
export const DISABLED_INK = { light: 'rgba(0, 0, 0, 0.38)', dark: 'rgba(255, 255, 255, 0.5)' }

// How the nine section accents are drawn: `on` each section in its own accent (`sections.accents`), `restrained` each accent mixed halfway toward the neutral one, `off` every section in the neutral accent, so that a section is told by its label, icon and place alone.
export const ACCENT_MODES = ['on', 'restrained', 'off']
export const DEFAULT_ACCENT_MODE = 'on'

// The share of the neutral accent in a restrained one.
const RESTRAINT = 0.5

const restrained = new WeakMap()

// The colour of each of the nine sections (the order of `sections.accents`, which `accent` of the registry in utilities/navigation.js indexes) in an accent mode: the colours the navigation is drawn in, and the ones scripts/check-contrast.js measures. They come from `sections` alone, never from the chart categories.
export const sectionAccents = (appearance, mode = DEFAULT_ACCENT_MODE) => {
  const { accents, neutral } = appearance.sections

  if (mode === 'off') {
    return accents.map(() => neutral)
  }

  if (mode === 'restrained') {
    if (!restrained.has(appearance)) {
      restrained.set(appearance, accents.map((color) => hex(over({ ...parseColor(color), a: 1 - RESTRAINT }, parseColor(neutral)))))
    }

    return restrained.get(appearance)
  }

  return accents
}

// The colour of a section in an accent mode, or the neutral accent for a place without a section (Settings, About, Empires). `section` is a row of the registry in utilities/navigation.js.
export const sectionColor = (appearance, section, mode = DEFAULT_ACCENT_MODE) => (section ? sectionAccents(appearance, mode)[section.accent] : appearance.sections.neutral)

const solid = (appearance, path) => {
  const color = parseColor(at(appearance, path))

  return color.a < 1 ? over(color, parseColor(appearance.surfaces.card)) : color
}

// The opacity of the overlay Vuetify 2.7.2 draws over a tab in the colour of its text (`.v-tab::before` in `currentColor`), by theme: `activated` while an active tab is hovered, `pressed` while it holds focus. They are the `states` of the theme (src/styles/settings/_light.scss and _dark.scss) that `+states` in components/VTabs/VTabs.sass applies to a tab; the stylesheet of the app does not change them, and they do not depend on the appearance's washes. scripts/check-contrast.js and scripts/check-section-accents.js read those two files and fail when these numbers differ from them.
export const VUETIFY_TAB_STATES = { light: { activated: 0.12, pressed: 0.16 }, dark: { activated: 0.24, pressed: 0.32 } }

// The backdrops of a section's text that do not depend on the text colour: the card under each wash of a table row, and each surface plain and under the hover wash, with the opacities of the tab overlays (`states`, VUETIFY_TAB_STATES of the mode) read at each surface as the full list of backdrops always read them, so a malformed appearance fails at the same place. Worked out once for the many text colours `readableSectionText` tries.
const backdropBase = (appearance, states) => {
  const card = solid(appearance, 'surfaces.card')
  const rows = ROW_STATES.map(([state, washes]) => ({ state, surfacePath: 'surfaces.card', background: washes.reduce((below, path) => over(parseColor(at(appearance, path)), below), card) }))
  const surfaces = SURFACES.map((surfacePath) => {
    const surface = solid(appearance, surfacePath)
    const hovered = over(parseColor(appearance.focus.hover), surface)

    return { surfacePath, surface, hovered, activated: states.activated, pressed: states.pressed }
  })

  const hexes = new Map([...rows.map(({ background }) => background), ...surfaces.flatMap(({ surface, hovered }) => [surface, hovered])].map((background) => [background, hex(background)]))

  return { rows, surfaces, hexes }
}

// The text colour `color` parsed, and the backdrops that do not depend on it (`base` when one was worked out before for the same appearance), read in this order: the overlays of the mode, the text colour, then the appearance's colours.
const backdropsOf = (appearance, color, base) => {
  const states = VUETIFY_TAB_STATES[appearance.mode]
  const text = parseColor(color)

  return { text, base: base || backdropBase(appearance, states) }
}

// Calls `visit` with each backdrop of the text colour `text` ({ state, surfacePath, background }, the ones that come out the same listed once, the first of them) in order, and stops at the first for which it returns false; true when it ran through them all. The backdrops that depend on the text colour are worked out only as far as the walk goes.
const eachBackdrop = ({ rows, surfaces, hexes }, text, visit) => {
  const seen = new Set()
  const take = (state, surfacePath, background) => {
    const key = `${surfacePath === 'surfaces.card' ? '' : surfacePath}:${hexes.get(background) ?? hex(background)}`

    return seen.has(key) || (seen.add(key), visit({ state, surfacePath, background }))
  }

  return surfaces.every(({ surfacePath, surface, hovered, activated, pressed }) => take('plain', surfacePath, surface) && take('hovered', surfacePath, hovered) && take('active tab hovered', surfacePath, over({ ...text, a: activated }, surface)) && take('active tab focused', surfacePath, over({ ...text, a: pressed }, surface))) && rows.every(({ state, surfacePath, background }) => take(state, surfacePath, background))
}

// What a section colour drawn as text sits on, each as { state, surfacePath, background } composited into one opaque colour: the page, the card and the chrome (the tab strip and the breadcrumb, the flyout, the palette, the planner), each plain, under the hover wash (the palette's selected row), under Vuetify's overlay of an active tab in the text colour itself at the opacity of a hovered tab and of a focused one (`VUETIFY_TAB_STATES` of the appearance's mode), and the card under each wash of a table row (the planner's figures sit in tables). Backgrounds that come out the same are listed once.
export const sectionBackdrops = (appearance, color) => {
  const { text, base } = backdropsOf(appearance, color)
  const listed = []

  eachBackdrop(base, text, (backdrop) => {
    listed.push(backdrop)

    return true
  })

  return listed
}

// The mixes tried, from the colour toward the body ink, in this many equal steps.
const MIX_STEPS = 256

// The first colour, from `color` itself and then its mixes toward the body ink in 1/256 steps, that `reads` (a function of a parsed colour), as a hex colour; the ink itself when none does. Whether a mix reads is not monotone in the share of ink when a backdrop depends on the text colour, so every step is tried and none is skipped.
const readableMix = (appearance, color, reads) => {
  const base = parseColor(color)
  const ink = over(parseColor(appearance.inks.body), solid(appearance, 'surfaces.card'))

  if (reads(base)) {
    return color
  }

  for (let step = 1; step <= MIX_STEPS; step++) {
    const candidate = parseColor(hex(over({ ...ink, a: step / MIX_STEPS }, base)))

    if (reads(candidate)) {
      return hex(candidate)
    }
  }

  return hex(ink)
}

// The colour a section is drawn in when it colours text (a title, a label, an active tab), as a hex colour: the colour itself when it reads at 4.5:1 on every backdrop, else the first mix of it with the body ink, in 1/256 steps from the colour, that reads on every backdrop, so that the hue holds as far as the contrast allows (the ink itself when no mix reads). Whether a mix reads is not monotone in the share of ink, because a backdrop is drawn in the text colour itself, so every step is tried and none is skipped. A mix of two colours that each read need not read itself, so the text colour is worked out from the colour in force (the accent, its restrained mix or the neutral accent) and never from its ends. Graphics (an icon, a bar, a wash) keep the colour of `sectionColor` at 3:1.
export const readableSectionText = (appearance, color) => {
  let base

  return readableMix(appearance, color, (candidate) => {
    const found = backdropsOf(appearance, hex(candidate), base)

    base = found.base

    return eachBackdrop(base, found.text, ({ background }) => ratio(candidate, background) >= TEXT)
  })
}

// What the count of a research field sits on: the card plain, and under the active and the hover wash of every accent of every accent mode (the wash is the accent at `washes.sectionSoft` or `washes.sectionTint` over the card), so the count reads whichever mode and section the page is drawn in.
const washBackdrops = (appearance) => {
  const card = solid(appearance, 'surfaces.card')
  const accents = new Set(ACCENT_MODES.flatMap((mode) => sectionAccents(appearance, mode)))

  return [card, ...[...accents].flatMap((accent) => [appearance.washes.sectionSoft, appearance.washes.sectionTint].map((alpha) => over({ ...parseColor(accent), a: alpha }, card)))]
}

const washTextKept = new WeakMap()

// The colour a status colour (or any colour) is drawn in when it colours text on the washes of a section (the count of a research field): the colour itself when it reads at 4.5:1 on every backdrop of `washBackdrops`, else the first mix of it with the body ink that reads on all of them, as for `readableSectionText`; the backdrops do not depend on the mix.
export const readableWashText = (appearance, color) => {
  if (!washTextKept.has(appearance)) {
    washTextKept.set(appearance, new Map())
  }

  const kept = washTextKept.get(appearance)

  if (!kept.has(color)) {
    const backdrops = washBackdrops(appearance)

    kept.set(color, readableMix(appearance, color, (candidate) => backdrops.every((background) => ratio(candidate, background) >= TEXT)))
  }

  return kept.get(color)
}

const sectionTextKept = new WeakMap()

// The text colour of each of the nine sections in an accent mode (the order of `sections.accents`): `readableSectionText` of the colour `sectionAccents` gives.
export const sectionTexts = (appearance, mode = DEFAULT_ACCENT_MODE) => {
  if (!sectionTextKept.has(appearance)) {
    sectionTextKept.set(appearance, {})
  }

  const kept = sectionTextKept.get(appearance)

  if (!kept[mode]) {
    const read = new Map()

    kept[mode] = sectionAccents(appearance, mode).map((color) => {
      if (!read.has(color)) {
        read.set(color, readableSectionText(appearance, color))
      }

      return read.get(color)
    })
  }

  return kept[mode]
}

// The text colour of a section in an accent mode, or of the neutral accent for a place without a section: what `--sc-text` carries (components/navigation/section-style.js).
export const sectionText = (appearance, section, mode = DEFAULT_ACCENT_MODE) => (section ? sectionTexts(appearance, mode)[section.accent] : sectionTexts(appearance, 'off')[0])

// Measures a resolved appearance: `{ text, graphics, rows, disabled, fills, categorical, sections, sectionWashes, washText, listText, sectionText, named }`, each a list of `{ label, foreground, surface, ratio, minimum, pass }`. `extraRowStates` are more row states ([label, washes]) the caller found (the gate adds the ones its stylesheet leaves unsettled). `baseline` is the resolved baseline preset of the appearance's mode, for `named`. `listVeil` is the opacity the stylesheet holds a list entry's overlay to (`LIST_VEIL` of the mode when absent: the gate reads the stylesheet and gives the strongest of Vuetify's own when it finds none). A colour a measurement cannot read is a row that fails with ratio 0, so a damaged value is a finding and not an exception.
export const measureAppearance = (appearance, { extraRowStates = [], baseline = null, listVeil = null } = {}) => {
  const card = parseColor(appearance.surfaces.card)
  const resolve = (path) => {
    const color = parseColor(at(appearance, path))

    return color.a < 1 ? over(color, card) : color
  }
  const distinct = (surfaces) => surfaces.filter((surface, index) => surfaces.findIndex((other) => hex(resolve(other)) === hex(resolve(surface))) === index)
  const measured = { text: [], graphics: [], rows: [], disabled: [], fills: [], categorical: [], sections: [], sectionWashes: [], washText: [], listText: [], sectionText: [], named: [] }
  const veil = listVeil === null ? LIST_VEIL[appearance.mode] : listVeil
  const layerOf = (path, accent) => {
    if (path.startsWith('washes.')) {
      return { ...parseColor(accent), a: at(appearance, path) }
    }

    if (path === LIST_VEIL_LAYER) {
      const ink = parseColor(appearance.inks.text)

      return { ...ink, a: ink.a * veil }
    }

    return parseColor(at(appearance, path))
  }
  const guard = (list, row, compute) => {
    try {
      const value = compute()

      list.push({ ...row, ratio: value, pass: value >= row.minimum })
    } catch (error) {
      list.push({ ...row, ratio: 0, pass: false })
    }
  }

  const inkOf = (path) => {
    try {
      if (path === STATUS_TEXT) {
        return readableWashText(appearance, at(appearance, `charts.categorical.${AVAILABLE_STATUS_SLOT}`))
      }

      const [token, opacity] = path.split('@')
      const ink = at(appearance, token)

      if (opacity === undefined) {
        return ink
      }

      const { r, g, b, a } = parseColor(ink)

      return `rgba(${r}, ${g}, ${b}, ${a * opacity})`
    } catch (error) {
      return 'unreadable'
    }
  }

  const contrastOf = (path, surface) => {
    const background = resolve(surface)

    return ratio(over(parseColor(inkOf(path)), background), background)
  }

  TEXT_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
    guard(measured.text, { label, foreground: inkOf(path), surface: at(appearance, surface), surfacePath: surface, minimum: TEXT }, () => contrastOf(path, surface))
  }))

  GRAPHIC_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
    guard(measured.graphics, { label, foreground: at(appearance, path), surface: at(appearance, surface), surfacePath: surface, minimum: GRAPHIC }, () => contrastOf(path, surface))
  }))

  distinct(SURFACES).forEach((surface) => {
    const ink = DISABLED_INK[appearance.mode]

    guard(measured.disabled, { label: 'Disabled text', foreground: ink, surface: at(appearance, surface), surfacePath: surface, minimum: DISABLED_TEXT }, () => {
      const background = resolve(surface)

      return ratio(over(parseColor(ink), background), background)
    })
  })

  ROW_STATES.concat(extraRowStates).forEach(([state, washes]) => {
    let background = null

    try {
      background = washes.reduce((below, path) => over(parseColor(at(appearance, path)), below), card)
    } catch (error) {
      background = null
    }

    ROW_TEXT.forEach(([label, path]) => {
      guard(measured.rows, { label: `${label} on a ${state}`, foreground: at(appearance, path), surface: background ? hex(background) : 'unreadable', minimum: TEXT }, () => ratio(over(parseColor(at(appearance, path)), background), background))
    })
  })

  distinct(['surfaces.chrome']).forEach((surface) => {
    const background = over(parseColor(appearance.focus.hover), resolve(surface))

    HOVERED_ENTRY_TEXT.forEach((path) => {
      guard(measured.rows, { label: `${washInkLabel(path)} on a hovered entry over the chrome`, foreground: inkOf(path), surface: hex(background), minimum: TEXT }, () => ratio(over(parseColor(inkOf(path)), background), background))
    })
  })

  const pressed = over(parseColor(appearance.rows.selected), parseColor(PRESSED_BUTTON[appearance.mode]))

  guard(measured.graphics, { label: 'Pressed toggle button bar, focused, hovered or not (the selected-row wash over the button)', foreground: appearance.focus.primary, surface: hex(pressed), surfacePath: 'buttons.pressed', minimum: GRAPHIC }, () => ratio(parseColor(appearance.focus.primary), pressed))

  FILL_TONES.forEach((path) => {
    guard(measured.fills, { label: path, foreground: appearance.inks.onFill, surface: at(appearance, path), minimum: TEXT }, () => ratio(parseColor(appearance.inks.onFill), resolve(path)))
  })

  appearance.charts.categorical.forEach((color, slot) => {
    distinct(SURFACES).forEach((surface) => {
      guard(measured.categorical, { slot, color, surface: at(appearance, surface), surfacePath: surface, minimum: GRAPHIC }, () => ratio(parseColor(color), resolve(surface)))
    })
  })

  ACCENT_MODES.forEach((mode) => {
    const colors = sectionAccents(appearance, mode)

    ;(mode === 'off' ? [colors[0]] : colors).forEach((color, index) => {
      distinct(SURFACES).forEach((surface) => {
        guard(measured.sections, { mode, section: mode === 'off' ? null : index, color, surface: at(appearance, surface), surfacePath: surface, minimum: GRAPHIC }, () => ratio(parseColor(color), resolve(surface)))
      })

      const washed = (layers, surface) => {
        try {
          return layers.reduce((below, path) => over(layerOf(path, color), below), resolve(surface))
        } catch (error) {
          return null
        }
      }

      SECTION_WASHES.forEach(([state, layers, surfaces]) => distinct(surfaces).forEach((surface) => {
        const under = washed(layers, surface)

        guard(measured.sectionWashes, { mode, section: mode === 'off' ? null : index, color, state, surface: under ? hex(under) : 'unreadable', surfacePath: surface, minimum: GRAPHIC }, () => ratio(parseColor(color), under))
      }))

      SECTION_WASH_TEXTS.forEach(([state, layers, surfaces, inks]) => distinct(surfaces).forEach((surface) => {
        const under = washed(layers, surface)

        inks.forEach((path) => {
          guard(measured.washText, { mode, section: mode === 'off' ? null : index, color, state, ink: washInkLabel(path), foreground: inkOf(path), surface: under ? hex(under) : 'unreadable', surfacePath: surface, minimum: TEXT }, () => ratio(over(parseColor(inkOf(path)), under), under))
        })
      }))
    })
  })

  LIST_TEXTS.forEach(([state, overlayPath, overlay, inks]) => {
    const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : veil
    let under = null

    try {
      const color = parseColor(at(appearance, overlayPath))

      under = over({ ...color, a: color.a * opacity }, resolve('surfaces.card'))
    } catch (error) {
      under = null
    }

    inks.forEach((path) => {
      guard(measured.listText, { state, ink: washInkLabel(path), foreground: inkOf(path), overlay: at(appearance, overlayPath), opacity, surface: under ? hex(under) : 'unreadable', surfacePath: 'surfaces.card', minimum: TEXT }, () => ratio(over(parseColor(inkOf(path)), under), under))
    })
  })

  LIST_BAR_OVERLAYS.forEach(([name, overlayPath]) => {
    let bar = null
    let under = null

    try {
      const color = parseColor(at(appearance, overlayPath))
      const layer = { ...color, a: color.a * veil }

      under = over(layer, resolve('surfaces.card'))
      bar = over(layer, over(parseColor(appearance.focus.primary), resolve('surfaces.card')))
    } catch (error) {
      bar = null
      under = null
    }

    guard(measured.graphics, { label: `Chosen list entry bar under the overlay in the ${name}`, foreground: bar ? hex(bar) : 'unreadable', surface: under ? hex(under) : 'unreadable', surfacePath: 'surfaces.card', minimum: GRAPHIC }, () => ratio(bar, under))
  })

  ACCENT_MODES.forEach((mode) => {
    const colors = sectionTexts(appearance, mode)

    ;(mode === 'off' ? [colors[0]] : colors).forEach((color, index) => {
      sectionBackdrops(appearance, color).forEach(({ state, surfacePath, background }) => {
        guard(measured.sectionText, { mode, section: mode === 'off' ? null : index, color, state, surface: hex(background), surfacePath, minimum: TEXT }, () => ratio(parseColor(color), background))
      })
    })
  })

  measured.named = measureNamed(appearance, baseline)

  return measured
}

// Vuetify's own ink on a dark-theme surface filled with a named colour (the baselines keep it): white for a title, an icon and a button, 87 % white for a snackbar's message.
export const VUETIFY_ON_COLOR = { onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' }

// The named colours a toolbar or a snackbar is filled with in the app, and the token of the colour Vuetify's theme gives each (`vuetifyColors` in appearance.js).
export const COLOUR_FILLS = [['primary', 'focus.primary'], ['success', 'severity.success'], ['error', 'severity.action'], ['warning', 'severity.attention'], ['info', 'severity.info']]

// What is drawn on such a fill and its minimum: the toolbar's title and text button (4.5:1) and icons (3:1), the snackbar's message and text button (4.5:1).
export const NAMED_USES = [['toolbar title', 'title', TEXT], ['toolbar text button', 'textButton', TEXT], ['toolbar icon', 'icon', GRAPHIC], ['toolbar icon button', 'buttonIcon', GRAPHIC], ['snackbar message', 'message', TEXT], ['snackbar text button', 'snackbarButton', TEXT]]

// The words that name each fill after the use drawn on it in the label of a measurement ('toolbar title on the primary fill').
export const FILL_LABELS = Object.freeze(Object.fromEntries(COLOUR_FILLS.map(([name]) => [name, `on the ${name} fill`])))

// The words of the confirmation Apply asks for when a file has contrast findings: the words before the number of findings, and the noun after it for one finding and for more.
export const ACKNOWLEDGEMENT_WORDS = Object.freeze({ before: 'Apply despite', one: 'contrast finding', many: 'contrast findings' })

// The ink of each use on a fill from the tokens alone, as the stylesheet draws it: `inks.onColor` for the toolbar's title, buttons and icons and for the snackbar's text button, `inks.onSnackbar` for the snackbar's message alone.
export const tokenInks = (appearance) => ({ title: appearance.inks.onColor, textButton: appearance.inks.onColor, icon: appearance.inks.onColor, buttonIcon: appearance.inks.onColor, message: appearance.inks.onSnackbar, snackbarButton: appearance.inks.onColor })

// Text and icons on the surfaces of Vuetify's named colours, each as `{ label, foreground, surface, ratio, minimum, pass }`. `inksOf(name)` gives the ink drawn for each use on the fill of that name (`tokenInks`, or what a stylesheet finally declares for it, as scripts/check-contrast.js reads it) and `resolveInk` turns a drawn value into a colour (a `var()` the stylesheet leaves). A colour that cannot be read is a row that fails with ratio 0.
export const measureNamedFills = (appearance, inksOf, resolveInk = (value) => value) => {
  const card = parseColor(appearance.surfaces.card)

  return COLOUR_FILLS.flatMap(([name, path]) => {
    const color = parseColor(at(appearance, path))
    const fill = color.a < 1 ? over(color, card) : color
    const drawn = inksOf(name)

    return NAMED_USES.map(([what, use, minimum]) => {
      let value = 0
      let resolved = String(drawn[use])

      try {
        resolved = resolveInk(drawn[use])
        value = ratio(over(parseColor(resolved), fill), fill)
      } catch (error) {
        value = 0
      }

      return { label: `${what} ${FILL_LABELS[name]}`, use, foreground: String(resolved), surface: hex(fill), ratio: value, minimum, pass: value >= minimum }
    })
  })
}

// The token each use is drawn in, from which a baseline keeps Vuetify's own ink.
const USE_INKS = { title: 'onColor', textButton: 'onColor', icon: 'onColor', buttonIcon: 'onColor', message: 'onSnackbar', snackbarButton: 'onColor' }

// Whether an ink is the baseline's own on the baseline's own fills, so that Vuetify's white on the fills is the documented exception of the baselines (on Dark's primary and severities it is 2.4:1 to 3.2:1, and Dark is kept as it was) and not a finding. Only the same ink on the same fills is exempt: another fill or another ink is measured, each ink on its own.
const keepsBaselineInk = (appearance, baseline, token) => Boolean(baseline) && appearance.inks[token] === baseline.inks[token] && COLOUR_FILLS.every(([, path]) => String(at(appearance, path)).toLowerCase() === String(at(baseline, path)).toLowerCase())

// What `measureAppearance` also measures for an appearance from its tokens alone: text and icons on the toolbar and snackbar fills (`named`), except for an ink the appearance keeps from the baseline (`baseline`, the resolved baseline preset of its mode) on the baseline's own fills.
export const measureNamed = (appearance, baseline) => measureNamedFills(appearance, () => tokenInks(appearance)).filter((row) => !keepsBaselineInk(appearance, baseline, USE_INKS[row.use]))
