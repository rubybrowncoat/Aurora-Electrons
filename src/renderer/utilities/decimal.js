// Exact decimal arithmetic with the range and the rounding of the game's own decimal type, for the production cycle engine: the game keeps every stock, amount and partial build as a decimal of up to 28 digits after the point whose 96-bit whole mantissa a result must fit, divides to the last digit that fits and rounds a tie to the even digit, so a build, a stock and a part of a unit left are the same numbers here and not floats near them.
//
// A decimal is { m, s }: the BigInt mantissa and the number of digits after the point, never more than 28, with no trailing zero in the fraction, so equal values are the same pair. Every operation returns a new one. A result that needs more digits than the type holds (more than 28 after the point, or a mantissa of 96 bits or more) is rounded to the nearest the type holds, a tie to the even digit; one whose whole part does not fit throws.
//
// The save keeps these quantities as floating point and the game reads each back as the platform's own conversion makes a decimal of a double (`fromDouble`: a 15-digit integer worked out in floating point, which is not always the number printed to 15 digits), so a stock the game held as 1000000.00035 comes back as exactly that. Additions that a long stretch of identical cycles repeats are checked for exactness (`additions`) so a stretch can be taken in one step only where the game's own additions would not round.

const MAX_SCALE = 28
const LIMIT = 1n << 96n
const POWERS = Array.from({ length: 80 }, (_, exponent) => 10n ** BigInt(exponent))

export const ZERO = { m: 0n, s: 0 }

const power = (exponent) => POWERS[exponent] || 10n ** BigInt(exponent)

const magnitude = (value) => (value < 0n ? -value : value)

// The integer nearest m / divisor, a tie to the even one.
const roundedQuotient = (m, divisor) => {
  const negative = m < 0n
  const size = negative ? -m : m
  let quotient = size / divisor
  const twice = (size - quotient * divisor) * 2n

  if (twice > divisor || (twice === divisor && (quotient & 1n) === 1n)) {
    quotient += 1n
  }

  return negative ? -quotient : quotient
}

// The decimal of a mantissa and scale that already fit, with the trailing zeros of its fraction dropped.
const make = (mantissa, scale) => {
  if (mantissa === 0n) {
    return ZERO
  }

  let m = mantissa
  let s = scale

  while (s > 0 && m % 10n === 0n) {
    m /= 10n
    s -= 1
  }

  return { m, s }
}

// The decimal nearest an exact result of any size: no more than 28 digits after the point and a mantissa under 2^96.
const fit = (mantissa, scale) => {
  if (scale <= MAX_SCALE && magnitude(mantissa) < LIMIT) {
    return make(mantissa, scale)
  }

  let drop = Math.max(0, scale - MAX_SCALE)
  let m = roundedQuotient(mantissa, power(drop))

  while (magnitude(m) >= LIMIT) {
    drop += 1
    m = roundedQuotient(mantissa, power(drop))
  }

  if (scale - drop < 0) {
    throw new RangeError('A value beyond the range of the game\'s decimal type')
  }

  return make(m, scale - drop)
}

// The decimal a text names exactly (up to 28 digits after the point), as '1000000.00035', '-0.5' or '1e-7'.
export const fromString = (text) => {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(text).trim())

  if (!match) {
    throw new TypeError(`Not a decimal: ${text}`)
  }

  const [, sign, whole, fraction = '', exponent = '0'] = match
  const mantissa = BigInt(`${whole}${fraction}`)
  const scale = fraction.length - Number(exponent)

  if (scale < 0) {
    return fit(sign ? -(mantissa * power(-scale)) : mantissa * power(-scale), 0)
  }

  return fit(sign ? -mantissa : mantissa, scale)
}

// The decimal the game makes of a floating point number it reads, by the platform's own conversion: the number is scaled by a power of ten chosen from its binary exponent to a 15-digit integer in floating point, that integer is rounded (a tie to the even one) and the zeros the scale added are dropped again. It is not the number printed to 15 digits: the scaling rounds in floating point on the way, so a number printed as ...635 can read as ...64.
const DOUBLE_POWERS = Array.from({ length: 81 }, (_, exponent) => Number(`1e${exponent}`))
const DOUBLE_VIEW = new DataView(new ArrayBuffer(8))

export const fromDouble = (value) => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Not a finite number: ${value}`)
  }

  DOUBLE_VIEW.setFloat64(0, value)

  const exponent = ((DOUBLE_VIEW.getUint32(0) >>> 20) & 0x7ff) - 1022

  if (exponent < -94) {
    return ZERO
  }

  if (exponent > 96) {
    throw new RangeError('A value beyond the range of the game\'s decimal type')
  }

  const negative = value < 0
  let scaled = Math.abs(value)
  let places = 14 - ((exponent * 19728) >> 16)

  if (places >= 0) {
    places = Math.min(places, MAX_SCALE)
    scaled *= DOUBLE_POWERS[places]
  } else if (places !== -1 || scaled >= 1e15) {
    scaled /= DOUBLE_POWERS[-places]
  } else {
    places = 0
  }

  if (scaled < 1e14 && places < MAX_SCALE) {
    scaled *= 10
    places += 1
  }

  let mantissa = Math.trunc(scaled)
  const left = scaled - mantissa

  if (left > 0.5 || (left === 0.5 && mantissa % 2 === 1)) {
    mantissa += 1
  }

  if (mantissa === 0) {
    return ZERO
  }

  const whole = BigInt(mantissa)
  const signed = negative ? -whole : whole

  return places < 0 ? fit(signed * power(-places), 0) : make(signed, places)
}

// Whether the type can hold a number read from the save (or typed): false for one at or above 2^96, about 7.9e28, which `fromDouble` throws on.
export const fitsDouble = (value) => {
  try {
    fromDouble(value)

    return true
  } catch (error) {
    if (error instanceof RangeError) {
      return false
    }

    throw error
  }
}

// The number nearest a decimal, correctly rounded: for the quantities the page shows. The game's own conversion is `toDouble`, which is not always this number.
export const toNumber = (value) => Number(`${value.m}e-${value.s}`)

const TWO_POWER_63 = 1n << 63n
const TWO_POWER_64 = 1n << 64n

// The double the platform's own conversion makes of a decimal: the low 64 bits of the mantissa and the high 32 as doubles, put together in floating point and divided by the power of ten of the scale, the sign put back. The platform makes a double of a 64-bit integer from 2^63 up through the signed number below it, plus 2^64 in floating point, which rounds twice, so such a double can differ from the nearest one by an ulp or two. Used where the game takes a decimal through a double and reads it back (the length of a cycle in years); `toNumber` is the nearest number, which can differ in the last bit and then in the 15th digit read back. The scale is the fewest digits (the platform keeps the scale a division gave, which has none of the zeros ours drops).
export const toDouble = (value) => {
  const low = magnitude(value.m) % TWO_POWER_64
  const high = magnitude(value.m) / TWO_POWER_64
  const lowNumber = low < TWO_POWER_63 ? Number(low) : Number(low - TWO_POWER_64) + 18446744073709551616
  const result = (lowNumber + Number(high) * 18446744073709551616) / DOUBLE_POWERS[value.s]

  return value.m < 0n ? -result : result
}

// A whole number (no digits after the point) as a number.
export const toInteger = (value) => Number(value.m)

export const compare = (a, b) => {
  if (a.s === b.s) {
    return a.m < b.m ? -1 : (a.m > b.m ? 1 : 0)
  }

  const x = a.s > b.s ? a.m : a.m * power(b.s - a.s)
  const y = a.s > b.s ? b.m * power(a.s - b.s) : b.m

  return x < y ? -1 : (x > y ? 1 : 0)
}

export const equal = (a, b) => a.s === b.s && a.m === b.m
export const less = (a, b) => compare(a, b) < 0
export const greater = (a, b) => compare(a, b) > 0
export const positive = (value) => value.m > 0n
export const negative = (value) => value.m < 0n

export const add = (a, b) => (a.s === b.s ? fit(a.m + b.m, a.s) : (a.s > b.s ? fit(a.m + b.m * power(a.s - b.s), a.s) : fit(a.m * power(b.s - a.s) + b.m, b.s)))
export const subtract = (a, b) => (a.s === b.s ? fit(a.m - b.m, a.s) : (a.s > b.s ? fit(a.m - b.m * power(a.s - b.s), a.s) : fit(a.m * power(b.s - a.s) - b.m, b.s)))
export const multiply = (a, b) => fit(a.m * b.m, a.s + b.s)
export const negate = (value) => (value.m === 0n ? value : { m: -value.m, s: value.s })

// The terms of a repeated addition on the finest scale any of them has: { scale, from (the start as a mantissa), step (the sum of the deltas as a mantissa) }.
const repeatedAt = (start, deltas) => {
  const scale = deltas.reduce((most, delta) => Math.max(most, delta.s), start.s)
  const at = (value) => value.m * power(scale - value.s)

  return { scale, from: at(start), step: deltas.reduce((sum, delta) => sum + at(delta), 0n) }
}

// How many times the sum of `deltas` (all of one sign, each added in turn) can be added to `start` with every addition exact: the game's type rounds an addition whose result, written to the finest scale of its terms, needs 96 bits, so the additions are exact while the end of the run of them, which is as far from 0 as any step on the way, still fits. 0 when the start does not fit at that scale, Infinity when the sum is 0.
export const additions = (start, deltas) => {
  const { from, step } = repeatedAt(start, deltas)

  if (magnitude(from) >= LIMIT) {
    return 0
  }

  if (step === 0n) {
    return Infinity
  }

  const room = (step > 0n ? LIMIT - 1n - from : from + LIMIT - 1n) / magnitude(step)

  return room > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(room)
}

// `start` with the sum of `deltas` added `count` times, each addition exact (`count` no more than `additions` gives).
export const addMultiple = (start, deltas, count) => {
  const { scale, from, step } = repeatedAt(start, deltas)

  return fit(from + step * BigInt(count), scale)
}

// Whether `values` can be added and taken away in any order with every sum exact: none is negative (a negative term lets a partial sum pass what the whole sum reaches) and the sum of all of them, written to the finest scale any has, needs under 96 bits, so every partial sum of any of them fits and a total kept by adding and taking away values is the same as the values added up again.
export const sumsExactly = (values) => values.every((value) => !negative(value)) && repeatedAt(ZERO, values).step < LIMIT

// a / b to the last digit the type holds (up to 28 after the point, a mantissa under 2^96), a tie to the even digit.
export const divide = (a, b) => {
  if (b.m === 0n) {
    throw new RangeError('Division by zero')
  }

  if (a.m === 0n) {
    return ZERO
  }

  const minus = (a.m < 0n) !== (b.m < 0n)
  const denominator = magnitude(b.m)
  let numerator = magnitude(a.m)
  let scale = a.s - b.s

  if (scale < 0) {
    numerator *= power(-scale)
    scale = 0
  }

  let digits = Math.max(0, MAX_SCALE - scale)
  let scaled = numerator * power(digits)
  let quotient = scaled / denominator

  while (quotient >= LIMIT && digits > 0) {
    digits -= 1
    scaled = numerator * power(digits)
    quotient = scaled / denominator
  }

  const twice = (scaled - quotient * denominator) * 2n

  if (twice > denominator || (twice === denominator && (quotient & 1n) === 1n)) {
    quotient += 1n
  }

  return fit(minus ? -quotient : quotient, scale + digits)
}

export const minimum = (a, b) => (compare(a, b) <= 0 ? a : b)

// The whole number at or below a value, as a decimal.
export const floor = (value) => {
  if (value.s === 0) {
    return value
  }

  const divisor = power(value.s)
  let quotient = value.m / divisor

  if (value.m < 0n && quotient * divisor !== value.m) {
    quotient -= 1n
  }

  return make(quotient, 0)
}

// The value to `places` digits after the point, a tie to the even digit.
export const round = (value, places) => (value.s <= places ? value : make(roundedQuotient(value.m, power(value.s - places)), places))

// The whole number of times b goes into a (a and b above 0), rounded up and rounded down, as numbers.
export const ceilRatio = (a, b) => {
  const digits = Math.max(a.s, b.s)
  const x = a.m * power(digits - a.s)
  const y = b.m * power(digits - b.s)

  return Number((x + y - 1n) / y)
}

export const floorRatio = (a, b) => {
  const digits = Math.max(a.s, b.s)

  return Number((a.m * power(digits - a.s)) / (b.m * power(digits - b.s)))
}
