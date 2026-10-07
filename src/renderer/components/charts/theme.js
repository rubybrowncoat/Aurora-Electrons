// Chart colours, from the Aurora Electrons design system (ink, surface, border,
// primary) plus a categorical palette validated with the dataviz checks against
// the app's surfaces (#ffffff light, #1e1e1e dark): adjacent CVD ΔE ≥ 8.4,
// normal-vision ΔE ≥ 19.3. In light mode three hues sit under 3:1 on white, so
// every chart that uses them also offers a table view.

const TOKENS = {
  light: {
    surface: '#ffffff',
    ink: '#212121',
    inkMuted: '#6a6a6a',
    border: '#cccccc',
    primary: '#1867c0',
    tooltip: 'rgba(97, 97, 97, 0.95)',
    categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  },
  dark: {
    surface: '#1e1e1e',
    ink: '#f5f5f5',
    inkMuted: '#b0b0b0',
    border: '#333333',
    primary: '#2196f3',
    tooltip: 'rgba(97, 97, 97, 0.95)',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  },
}

export const chartTheme = (dark) => TOKENS[dark ? 'dark' : 'light']

// The flow groups' fixed slots: the order the validator passed, so neighbouring
// stack segments (salvage | mining | construction | shipbuilding | …) stay distinct.
const FLOW_SLOTS = { mining: 0, construction: 1, shipbuilding: 2, ordnance: 3, ground: 4, fuel: 5, maintenance: 6, salvage: 7 }

export const flowColor = (dark, key) => chartTheme(dark).categorical[FLOW_SLOTS[key]]

// Hex colour with an alpha, for area washes (~10%) and recessive fills.
export const withAlpha = (hex, alpha) => {
  const value = Math.round(alpha * 255).toString(16).padStart(2, '0')

  return `${hex}${value}`
}
