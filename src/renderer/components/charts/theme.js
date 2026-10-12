import { activeAppearance } from '../../utilities/appearance'

// Chart colours, taken from the resolved appearance (utilities/appearance.js): its card surface, inks, axis colour, tooltip and nine categorical slots. The palette's validation notes are there.

const themes = new WeakMap()

// The chart tokens of an appearance: `surface`, `ink`, `inkMuted`, `border` (axes), `primary`, `tooltip`, `tooltipInk` and `categorical`. Without an argument, the appearance in force. Read inside a computed property, it follows a preset switch.
export const chartTheme = (appearance = activeAppearance()) => {
  const { surfaces, inks, focus, charts } = appearance

  if (!themes.has(charts)) {
    themes.set(charts, { surface: surfaces.card, ink: inks.body, inkMuted: inks.muted, border: charts.axis, primary: focus.primary, tooltip: charts.tooltip, tooltipInk: inks.onTooltip, categorical: charts.categorical })
  }

  return themes.get(charts)
}

// The flow groups' fixed slots: the order the validator passed, so neighbouring stack segments (salvage | mining | construction | shipbuilding | …) stay distinct.
const FLOW_SLOTS = { mining: 0, construction: 1, shipbuilding: 2, ordnance: 3, ground: 4, fuel: 5, maintenance: 6, salvage: 7 }

export const flowColor = (appearance, key) => chartTheme(appearance).categorical[FLOW_SLOTS[key]]

// Hex colour with an alpha, for area washes (~10%) and recessive fills.
export const withAlpha = (hex, alpha) => {
  const value = Math.round(alpha * 255).toString(16).padStart(2, '0')

  return `${hex}${value}`
}
