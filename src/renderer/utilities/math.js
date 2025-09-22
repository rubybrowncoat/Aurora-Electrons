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

export const separatedNumber = (number, separator = '\'') => {
  return number.toString().replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, separator)
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
