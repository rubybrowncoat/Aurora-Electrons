export const safeModulo360 = (angle) => {
  return ((angle % 360) + 360) % 360
}

export const approximatelyEquals = (a, b, epsilon = 1e-6) => {
  return Math.abs(a - b) <= epsilon
}

export const roundToDecimal = (number, decimals = 0) => {
  return Math.round(number * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

export const floorToDecimal = (number, decimals = 0) => {
  return Math.floor(number * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

export const ceilToDecimal = (number, decimals = 0) => {
  return Math.ceil(number * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

// What a figure that is not known reads as: a dash, never 0.
export const UNKNOWN_TEXT = '—'

// Whether a value is a number the save gave: not null, not undefined, not NaN, not infinite. A numeric string counts, as a stored column may hold one.
export const isKnownNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))

// The number with the thousands separator, or a dash when it is not known (null, undefined, NaN or infinite), never 0.
export const separatedNumber = (number, separator = '\'') => {
  return isKnownNumber(number) ? number.toString().replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, separator) : UNKNOWN_TEXT
}

// A count or amount rounded to `decimals` and written with the separator; a dash when it is not known, so a missing figure never reads as 0. A real 0 reads '0'.
export const countText = (value, decimals = 0, separator = '\'') => {
  return isKnownNumber(value) ? separatedNumber(roundToDecimal(Number(value), decimals), separator) : UNKNOWN_TEXT
}

// A figure of a measured range as `rangeText` reads it: the number it shows, the magnitude suffix it carries (K, M, B, bn and the like, empty when the number is written whole), the unit that follows it (its spacing included), whether it reads negative, and whether it is a duration of two parts (`3 min 20 s`), whose own text a range keeps rather than splitting the unit off.
export const rangeFigure = (number, { magnitude = '', unit = '', negative = false, compound = false } = {}) => ({ number: `${number}`, magnitude, unit, negative, compound })

// A figure's text as it stands on its own: the number, its magnitude suffix and its unit.
export const figureText = (figure, unit = figure.unit) => `${figure.number}${figure.magnitude ? ` ${figure.magnitude}` : ''}${unit}`

// A plain figure written whole and grouped, with a minus sign when it is negative: the default `rangeText` formatter.
const wholeFigure = (value) => {
  const rounded = roundToDecimal(value, 0)
  const negative = rounded < 0

  return rangeFigure(`${negative ? '−' : ''}${separatedNumber(Math.abs(rounded))}`, { negative })
}

// A range of measured values with the unit once, after the second figure: "5–9 L", "5.3 M to 9.2 M L", "−20 to 15 °C". The joiner is an en dash between plain figures and " to " when the first figure carries a magnitude suffix (K, M, B, bn and the like) or either figure reads negative, so a dash never sits beside a suffix or a minus sign; figures in different units are joined with " to " and keep their units. A duration range writes its unit once when both ends carry the same single unit ("5–9 s", "36–48 h"), and keeps each end's own text joined with " to " when an end carries two parts or the ends carry different units ("3 min 20 s to 4 min 10 s", "5 h to 6 d"). Equal ends as displayed show one figure; an end that is not known shows the caller's unknown wording. `format(value)` returns a `rangeFigure`.
export const rangeText = (low, high, { format = wholeFigure, unknown = UNKNOWN_TEXT } = {}) => {
  if (!isKnownNumber(low) || !isKnownNumber(high)) {
    return unknown
  }

  const first = format(low)
  const last = format(high)

  if (figureText(first) === figureText(last)) {
    return figureText(last)
  }

  if (first.compound || last.compound) {
    return `${figureText(first)} to ${figureText(last)}`
  }

  if (first.unit !== last.unit) {
    return `${figureText(first)} to ${figureText(last)}`
  }

  return `${figureText(first, '')}${first.magnitude || first.negative || last.negative ? ' to ' : '–'}${figureText(last)}`
}

// The character behind the "Thousands Separator" setting's name (`selectedSeparator`, default 'Tick').
export const thousandsSeparator = (name = 'Tick') => {
  return name === 'Tick' ? '\'' : name === 'Comma' ? ',' : name === 'Dash' ? '-' : name === 'Space' ? ' ' : ''
}

// Scaler
// Anchors (x -> y)
const X = [0.25, 0.50, 0.75, 1.00, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00, 3.50, 4.00, 4.50, 5.00, 6.00, 7.00, 8.00]
const Y = [35, 50, 65, 80, 93, 105, 119, 133, 155, 177, 197, 217, 235, 253, 287, 319, 349]

// Precompute segment slopes
const S = Array.from({ length: X.length - 1 }, (_, i) => (Y[i + 1] - Y[i]) / (X[i + 1] - X[i]))

/**
 * Piecewise-linear scaler:
 * - x < 0.25  -> 35 (flat)
 * - Between anchors -> linear interpolation
 * - x > 5.0   -> extends linearly using the last segment's slope
 */
export function scaleValue(x) {
  if (x <= X[0]) return Y[0]

  const last = X.length - 1
  if (x >= X[last]) {
    const dx = x - X[last]
    return Y[last] + S[last - 1] * dx // extend tail
  }

  // Binary search for interval i such that X[i] <= x <= X[i+1]
  let lo = 0; let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (x < X[mid]) hi = mid; else lo = mid
  }

  const i = lo
  const t = (x - X[i]) / (X[i + 1] - X[i])
  return Y[i] + t * (Y[i + 1] - Y[i])
}
