import Vue from 'vue'

// The appearance contract: one resolved object says what every colour in the app means, and every renderer (Vuetify's theme, the CSS custom properties on the root, Chart.js, Cytoscape, canvas, Pixi) reads its colours from it. A preset is the data for one such object; Light and Dark are the two baseline presets and reproduce the colours the app had before presets existed.
//
// A preset holds:
// - `id`, `name`, `version` (raise it when a preset's colours change), `mode` ('light' or 'dark': what Vuetify's own components and the scrollbars take as the base).
// - `surfaces`: `background` (the page and app bar), `chrome` (rail, footer), `card` (cards, tables, chart canvases), `border` (dividers and outlines), `track` and `trackSoft` (the empty part of a meter, the fill of a chip) and `rule` (a hairline under a table head).
// - `inks`: `body` (text), `muted` (secondary text, rail icons, axis ticks) and `onTooltip` (text on the chart tooltip).
// - `focus`: `primary` (focus, selection, links, the Galaxy Map's selection), `hover` (the wash under the pointer) and Vuetify's other two named colours, `secondary` and `accent`.
// - `rows`: table rows that mark something: `selected` (the picked row), `differs` (a compared row that differs), `differsMark` and `differsDot` (the stripe and the dot that go with it), `stripe` and `stripeSoft` (the two bands of the focused row's hatching).
// - `severity`: Warnings' three levels, `action` (needs action), `attention` and `info`, plus `success`; Vuetify's `error`, `warning`, `info` and `success`.
// - `contacts`, `survey`, `habitability`, `accessibility`, `status` (each optional): the meaning of a colour, not its place in the palette. `contacts`: how the race regards an alien contact (hostile, unknown, neutral, friendly, allied, civilian). `survey`: surveyed, remaining, ground (a ground survey location), unexplored (an unexplored jump point), and the geological, gravitational and both kinds of survey. `habitability`: `band`, the hue the colony-cost bands shade from. `accessibility`: a mineral deposit's good, fair and poor band. `status`: `shortfall` and `inactive` (a standing that is neither good nor bad). Each defaults to its slot in ROLE_SLOTS of the categorical list; a colour here replaces it.
// - `plan`: the Colonization Planner's hues that are not a severity (mining, terraformFree, terraformPartial, terraformCheaper, cheap, moderate, costly, severe, insufficient, rich, cmc, unsurveyed, selected), each given in full. `toneColor` turns a tone, a severity name or a key of `plan` or `status`, into its colour.
// - `charts`: `axis` (axis lines, gridlines at 60%), `tooltip` (its background) and `categorical`, the nine slots every chart series, section accent and status colour is taken from.
// - `sections`: `neutral` (the accent without a section: Settings, About, Empires).
// - `space`: the system view's sky and what is drawn on it: `background`, `label` (names), `labelShadow`, `bodyOrbit`, `jumpUnexplored`, `jumpExplored`. The sky is dark in every preset, so the ink on it does not follow the mode.
// - `washes`: alphas of a section's colour for an active item (`sectionSoft`), a hovered one (`sectionTint`), and of the available-status colour in the research tree (`statusSoft`).
//
// Physical colours (stars and the star orbit lines drawn in their colour, planet terrain) depict the world, not a meaning, and stay out of presets.
//
// The categorical palette was validated with the dataviz checks against the app's surfaces (#ffffff light, #1e1e1e dark): adjacent CVD ΔE ≥ 8.4, normal-vision ΔE ≥ 19.3. In the light preset three hues sit under 3:1 on white, so every chart that uses them also offers a table view. The ninth hue (cyan, for the Design section) was added after that validation and was checked only for normal-vision ΔE (≥ 40 against the other eight in both presets). A preset that changes the categorical list or the surfaces has to be checked again.

const LIGHT = {
  id: 'light',
  name: 'Light',
  version: 1,
  mode: 'light',
  surfaces: { background: '#ffffff', chrome: '#f6f7f9', card: '#ffffff', border: '#e0e3e8', track: 'rgba(0, 0, 0, .08)', trackSoft: 'rgba(0, 0, 0, .06)', rule: 'rgba(0, 0, 0, .12)' },
  inks: { body: '#212121', muted: '#6a6a6a', onTooltip: '#ffffff' },
  focus: { primary: '#1867c0', hover: 'rgba(24, 103, 192, .07)', secondary: '#b0bec5', accent: '#8c9eff' },
  rows: { selected: 'rgba(33, 150, 243, .08)', differs: 'rgba(33, 150, 243, .1)', differsMark: '#1e88e5', differsDot: 'rgba(33, 150, 243, .45)', stripe: 'rgba(33, 150, 243, .12)', stripeSoft: 'rgba(33, 150, 243, .04)' },
  severity: { action: '#b71c1c', attention: '#FB8C00', info: '#2196F3', success: '#4CAF50' },
  status: { inactive: '#9e9e9e' },
  plan: { mining: '#ff8f00', terraformFree: '#9c27b0', terraformPartial: '#3f51b5', terraformCheaper: '#607d8b', cheap: '#009688', moderate: '#039be5', costly: '#f57c00', severe: '#d84315', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#00897b', unsurveyed: '#ff9800', selected: '#f44336' },
  charts: {
    axis: '#cccccc',
    tooltip: 'rgba(97, 97, 97, 0.95)',
    categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#00a0b0'],
  },
  sections: { neutral: '#546e7a' },
  space: { background: '#000040', label: '#ffffff', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#32cd32', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.14, sectionTint: 0.08, statusSoft: 0.18 },
}

const DARK = {
  id: 'dark',
  name: 'Dark',
  version: 1,
  mode: 'dark',
  surfaces: { background: '#121212', chrome: '#1e1e1e', card: '#1e1e1e', border: '#333333', track: 'rgba(255, 255, 255, .12)', trackSoft: 'rgba(255, 255, 255, .1)', rule: 'rgba(255, 255, 255, .12)' },
  inks: { body: '#f5f5f5', muted: '#b0b0b0', onTooltip: '#ffffff' },
  focus: { primary: '#2196f3', hover: 'rgba(33, 150, 243, .10)', secondary: '#424242', accent: '#FF4081' },
  rows: { selected: 'rgba(33, 150, 243, .16)', differs: 'rgba(33, 150, 243, .2)', differsMark: '#1e88e5', differsDot: 'rgba(33, 150, 243, .45)', stripe: 'rgba(33, 150, 243, .22)', stripeSoft: 'rgba(33, 150, 243, .1)' },
  severity: { action: '#FF5252', attention: '#FB8C00', info: '#2196F3', success: '#4CAF50' },
  status: { inactive: '#9e9e9e' },
  plan: { mining: '#ff8f00', terraformFree: '#9c27b0', terraformPartial: '#3f51b5', terraformCheaper: '#607d8b', cheap: '#009688', moderate: '#039be5', costly: '#f57c00', severe: '#d84315', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#00897b', unsurveyed: '#ff9800', selected: '#f44336' },
  charts: {
    axis: '#333333',
    tooltip: 'rgba(97, 97, 97, 0.95)',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#2ec4d6'],
  },
  sections: { neutral: '#90a4ae' },
  space: { background: '#000040', label: '#ffffff', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#32cd32', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

// Every preset by id. A preset joins the app by being listed here.
export const PRESETS = { [LIGHT.id]: LIGHT, [DARK.id]: DARK }

export const DEFAULT_PRESET_ID = LIGHT.id

// The preset each mode falls back to: the lamp in the app bar and the Dark theme switch move between modes, and land on these.
const BASELINE_BY_MODE = { light: LIGHT.id, dark: DARK.id }

// The settings key the chosen preset's id is kept under: app-wide, written only by `applyPreset`. Settings from before presets hold a boolean `darkMode` instead; `loadAppearance` turns it into this key once and nothing writes `darkMode` any more.
export const APPEARANCE_KEY = 'appearance'

// Categorical slots of the colours that carry a meaning, by role; `muted` is the preset's muted ink.
export const CONTACT_SLOTS = { hostile: 7, unknown: 7, neutral: 3, friendly: 2, allied: 0, civilian: 'muted' }

const ROLE_SLOTS = {
  contacts: CONTACT_SLOTS,
  survey: { done: 2, left: 1, ground: 4, unexplored: 3, geological: 0, gravitational: 1, both: 6 },
  habitability: { band: 0 },
  accessibility: { good: 2, fair: 3, poor: 1 },
  status: { shortfall: 7 },
}

const resolved = new WeakMap()

// The resolved appearance of a preset: the object every renderer reads. The same preset gives the same object (its `key`, `id@version`, names it), so a component can watch it.
export const resolveAppearance = (id) => {
  const preset = PRESETS[id] || PRESETS[DEFAULT_PRESET_ID]

  if (!resolved.has(preset)) {
    const { categorical } = preset.charts
    const roles = Object.fromEntries(Object.entries(ROLE_SLOTS).map(([group, slots]) => [group, { ...Object.fromEntries(Object.entries(slots).map(([role, slot]) => [role, slot === 'muted' ? preset.inks.muted : categorical[slot]])), ...preset[group] }]))

    resolved.set(preset, {
      id: preset.id,
      name: preset.name,
      version: preset.version,
      key: `${preset.id}@${preset.version}`,
      mode: preset.mode,
      surfaces: { ...preset.surfaces },
      inks: { ...preset.inks },
      focus: { ...preset.focus },
      rows: { ...preset.rows },
      severity: { ...preset.severity },
      ...roles,
      plan: { ...preset.plan },
      charts: { ...preset.charts, categorical: [...categorical] },
      sections: { ...preset.sections },
      space: { ...preset.space },
      washes: { ...preset.washes },
    })
  }

  return resolved.get(preset)
}

// `id` is the preset in force (what every renderer draws with), `applied` the last one chosen and kept. They differ while a preview is open.
const state = Vue.observable({ id: DEFAULT_PRESET_ID, applied: DEFAULT_PRESET_ID })

// The appearance in force. Read inside a computed property, a render or a watcher, it makes that one depend on the chosen preset, so a switch (light to dark, or dark to another dark) redraws what read it.
export const activeAppearance = () => resolveAppearance(state.id)

// The id of the last preset applied (reactive). It is what a cancelled preview, and leaving Settings with a preview open, go back to.
export const appliedPresetId = () => state.applied

// Whether a preview is open: the preset in force is not the applied one (reactive).
export const isPreviewing = () => state.id !== state.applied

// Every preset, resolved, in the order they are listed.
export const listAppearances = () => Object.keys(PRESETS).map((id) => resolveAppearance(id))

// Puts a preset in force without keeping it, so every page shows it (Vuetify's theme follows through the watcher in plugins/vuetify.js). An unknown id changes nothing. Writes nothing.
export const previewPreset = (id) => {
  if (PRESETS[id]) {
    state.id = id
  }
}

// Drops the preview: the applied preset is in force again.
export const cancelPreview = () => {
  state.id = state.applied
}

// Keeps a preset: puts it in force, makes it the applied one and writes its id to the settings (`config` is the settings store). An unknown id changes nothing and returns false. The settings are written first, so a failed write leaves the selection as it was.
export const applyPreset = (config, id) => {
  if (!PRESETS[id]) {
    return false
  }

  config.set(APPEARANCE_KEY, id)
  state.id = id
  state.applied = id

  return true
}

// The one path the app bar's lamp and the Settings switch share: applies the baseline preset of a mode ('light' or 'dark').
export const applyMode = (config, mode) => applyPreset(config, baselinePresetId(mode))

// The saved id when it names no preset this version has (a preset from a newer version, or a damaged value), else null.
export const unsupportedPresetId = (config) => {
  const id = config.get(APPEARANCE_KEY)

  return id === undefined || PRESETS[id] ? null : id
}

// Reads the settings at start. A saved preset is applied. A file with only the older `darkMode` gets the baseline preset of that mode written to `appearance` once, then it is applied. A saved id this version doesn't have leaves the last valid applied preset in force (the default when none was applied yet) and is not overwritten: only `applyPreset` writes the key. `config` is the settings store.
export const loadAppearance = (config) => {
  const stored = config.get(APPEARANCE_KEY)
  const legacy = config.get('darkMode')

  if (stored === undefined && typeof legacy === 'boolean') {
    applyMode(config, legacy ? 'dark' : 'light')
  } else if (PRESETS[stored]) {
    state.id = stored
    state.applied = stored
  } else {
    cancelPreview()
  }
}

// The baseline preset of a mode.
export const baselinePresetId = (mode) => BASELINE_BY_MODE[mode]

// The CSS custom properties the app's styles read, for the root element (`:style` on `v-app`).
export const appearanceStyle = ({ surfaces, inks, focus, rows, space, status }) => ({
  '--ae-bg': surfaces.background,
  '--ae-chrome': surfaces.chrome,
  '--ae-card': surfaces.card,
  '--ae-border': surfaces.border,
  '--ae-track': surfaces.track,
  '--ae-track-soft': surfaces.trackSoft,
  '--ae-rule': surfaces.rule,
  '--ae-ink': inks.body,
  '--ae-muted': inks.muted,
  '--ae-primary': focus.primary,
  '--ae-hover': focus.hover,
  '--ae-row-selected': rows.selected,
  '--ae-row-differs': rows.differs,
  '--ae-row-differs-mark': rows.differsMark,
  '--ae-row-differs-dot': rows.differsDot,
  '--ae-row-stripe': rows.stripe,
  '--ae-row-stripe-soft': rows.stripeSoft,
  '--ae-space-ink': space.label,
  '--ae-space-shadow': space.labelShadow,
  '--ae-shortfall': status.shortfall,
})

// The colours Vuetify's theme takes for the appearance's mode: its named colours, `error`, `warning`, `info` and `success` being the severities.
export const vuetifyColors = ({ focus, severity }) => ({
  primary: focus.primary,
  secondary: focus.secondary,
  accent: focus.accent,
  error: severity.action,
  warning: severity.attention,
  info: severity.info,
  success: severity.success,
})

// The colour of a tone: a name Vuetify's theme has (`success`, `info`, `warning`, `error`, `primary`), else a key of the appearance's `plan` or `status` roles. A name that is none of those comes back as it is, so a CSS colour passes through.
export const toneColor = (appearance, tone) => vuetifyColors(appearance)[tone] || appearance.plan[tone] || appearance.status[tone] || tone
