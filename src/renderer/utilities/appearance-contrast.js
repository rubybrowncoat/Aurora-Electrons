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
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)

  return (light + 0.05) / (dark + 0.05)
}

export const hex = ({ r, g, b }) => `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`

export const at = (object, path) => path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), object)

// What is measured against which surfaces: [label, token path of the foreground, surfaces]. A surface is a token path; the tooltip's is composited over the card. Surfaces that resolve to the same colour in a preset are measured once.
export const SURFACES = ['surfaces.background', 'surfaces.card', 'surfaces.chrome']

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

// What a section colour drawn as text sits on, each as { state, surfacePath, background } composited into one opaque colour: the page, the card and the chrome (the tab strip and the breadcrumb, the flyout, the palette, the planner), each plain, under the hover wash (the palette's selected row), under Vuetify's overlay of an active tab in the text colour itself at the opacity of a hovered tab and of a focused one (`VUETIFY_TAB_STATES` of the appearance's mode), and the card under each wash of a table row (the planner's figures sit in tables). Backgrounds that come out the same are listed once.
export const sectionBackdrops = (appearance, color) => {
  const states = VUETIFY_TAB_STATES[appearance.mode]
  const text = parseColor(color)
  const seen = new Set()
  const card = solid(appearance, 'surfaces.card')
  const rows = ROW_STATES.map(([state, washes]) => ({ state, surfacePath: 'surfaces.card', background: washes.reduce((below, path) => over(parseColor(at(appearance, path)), below), card) }))
  const surfaces = SURFACES.flatMap((surfacePath) => {
    const surface = solid(appearance, surfacePath)

    return [['plain', surface], ['hovered', over(parseColor(appearance.focus.hover), surface)], ['active tab hovered', over({ ...text, a: states.activated }, surface)], ['active tab focused', over({ ...text, a: states.pressed }, surface)]].map(([state, background]) => ({ state, surfacePath, background }))
  })

  return [...surfaces, ...rows].filter(({ surfacePath, background }) => {
    const key = `${surfacePath === 'surfaces.card' ? '' : surfacePath}:${hex(background)}`

    return seen.has(key) ? false : Boolean(seen.add(key))
  })
}

// The mixes tried, from the colour toward the body ink, in this many equal steps.
const MIX_STEPS = 256

// The colour a section is drawn in when it colours text (a title, a label, an active tab), as a hex colour: the colour itself when it reads at 4.5:1 on every backdrop, else the first mix of it with the body ink, in 1/256 steps from the colour, that reads on every backdrop, so that the hue holds as far as the contrast allows (the ink itself when no mix reads). Whether a mix reads is not monotone in the share of ink, because a backdrop is drawn in the text colour itself, so every step is tried and none is skipped. A mix of two colours that each read need not read itself, so the text colour is worked out from the colour in force (the accent, its restrained mix or the neutral accent) and never from its ends. Graphics (an icon, a bar, a wash) keep the colour of `sectionColor` at 3:1.
export const readableSectionText = (appearance, color) => {
  const base = parseColor(color)
  const ink = over(parseColor(appearance.inks.body), solid(appearance, 'surfaces.card'))
  const reads = (candidate) => sectionBackdrops(appearance, hex(candidate)).every(({ background }) => ratio(candidate, background) >= TEXT)

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

// Measures a resolved appearance: `{ text, graphics, rows, disabled, fills, categorical, sections, sectionText, named }`, each a list of `{ label, foreground, surface, ratio, minimum, pass }`. `extraRowStates` are more row states ([label, washes]) the caller found (the gate adds the ones its stylesheet leaves unsettled). `baseline` is the resolved baseline preset of the appearance's mode, for `named`. A colour a measurement cannot read is a row that fails with ratio 0, so a damaged value is a finding and not an exception.
export const measureAppearance = (appearance, { extraRowStates = [], baseline = null } = {}) => {
  const card = parseColor(appearance.surfaces.card)
  const resolve = (path) => {
    const color = parseColor(at(appearance, path))

    return color.a < 1 ? over(color, card) : color
  }
  const distinct = (surfaces) => surfaces.filter((surface, index) => surfaces.findIndex((other) => hex(resolve(other)) === hex(resolve(surface))) === index)
  const measured = { text: [], graphics: [], rows: [], disabled: [], fills: [], categorical: [], sections: [], sectionText: [], named: [] }
  const guard = (list, row, compute) => {
    try {
      const value = compute()

      list.push({ ...row, ratio: value, pass: value >= row.minimum })
    } catch (error) {
      list.push({ ...row, ratio: 0, pass: false })
    }
  }

  const contrastOf = (path, surface) => {
    const background = resolve(surface)

    return ratio(over(parseColor(at(appearance, path)), background), background)
  }

  TEXT_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
    guard(measured.text, { label, foreground: at(appearance, path), surface: at(appearance, surface), surfacePath: surface, minimum: TEXT }, () => contrastOf(path, surface))
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
    })
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

      return { label: `${what} on the ${name} fill`, use, foreground: String(resolved), surface: hex(fill), ratio: value, minimum, pass: value >= minimum }
    })
  })
}

// The token each use is drawn in, from which a baseline keeps Vuetify's own ink.
const USE_INKS = { title: 'onColor', textButton: 'onColor', icon: 'onColor', buttonIcon: 'onColor', message: 'onSnackbar', snackbarButton: 'onColor' }

// Whether an ink is the baseline's own on the baseline's own fills, so that Vuetify's white on the fills is the documented exception of the baselines (on Dark's primary and severities it is 2.4:1 to 3.2:1, and Dark is kept as it was) and not a finding. Only the same ink on the same fills is exempt: another fill or another ink is measured, each ink on its own.
const keepsBaselineInk = (appearance, baseline, token) => Boolean(baseline) && appearance.inks[token] === baseline.inks[token] && COLOUR_FILLS.every(([, path]) => String(at(appearance, path)).toLowerCase() === String(at(baseline, path)).toLowerCase())

// What `measureAppearance` also measures for an appearance from its tokens alone: text and icons on the toolbar and snackbar fills (`named`), except for an ink the appearance keeps from the baseline (`baseline`, the resolved baseline preset of its mode) on the baseline's own fills.
export const measureNamed = (appearance, baseline) => measureNamedFills(appearance, () => tokenInks(appearance)).filter((row) => !keepsBaselineInk(appearance, baseline, USE_INKS[row.use]))
