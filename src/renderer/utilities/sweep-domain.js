// Typed numeric sweep domains: the values a parameter sweep tries, as one validated object that a preview, a search and its checks all read.
//
// A domain is built from a kind (what the number is, which fixes its unit and resolution), a range and a step, and its values are whole numbers of 1 / `scale` of the kind's canonical unit (`scaled` below), so a step of 0.1 or 0.05 never drifts and every value is reached exactly: the index of a value is its place in the domain, and its figure is `scaled / scale`, the nearest double to the decimal. The unit a domain is entered or shown in (tons for a size in HS) only converts at the edge; the domain itself stays in the canonical unit, so switching the display never changes what is tried.
//
// Endpoints. The values are the grid points inside [min, max]. With `anchor: 'min'` (the default) the grid starts at `min`, so `min` is always tried; with `anchor: 'zero'` the grid is every multiple of the step from 0 (a band's own start, for a banded size), which is how the engine search steps, and a bound between two steps is then not a grid point. A bound that is not a grid point is never invented as an endpoint: with `include: 'grid'` (the default) it is left out, and the last value is the largest grid point not above `max` (the first, the least not below `min`); with `include: 'limits'` it is tried too, once, as the last (or first) value. A grid with no point inside the range is an error, not an empty sweep.
//
// Validation is field-local: `errors` holds a message for each of `min`, `max`, `step` and `limits` that is wrong, and `domain` for a problem of the whole range; a domain with any error has no values and must not run. A value must be a finite number, a count a whole number, a figure no finer than the kind's resolution (unless `snap: 'inward'` cuts it, which the domain reports as a `cut`), a step above 0, `min` not above `max`, and each bound inside the `limits` (the researched or fixed `{ min, max, source }` of the figure) when given.

// A figure is read exactly. Text typed in a field is its decimal digits, and a number given by code is the shortest decimal that gives the number back, so a figure is converted to scaled units as a ratio of whole numbers (BigInt) and is on a tick of the kind's resolution only when the ratio is whole: no tolerance relative to the magnitude is ever applied, and typed text that is not on a tick is cut inward (a minimum up, a maximum down) or refused, exactly. A number given by code is read to within ULPS units in the last place of a tick (the error of the arithmetic that made it, as 0.1 + 0.2 is 0.3), so such a bound can sit up to ULPS ulps outside the figure it was given (a numeric maximum of 0.2999999999999999 reads as 0.3 where the text '0.2999999999999999' floors to 0.299). The values a domain generates are checked once built: a stretch of the grid with more than one value, and the gap between neighbouring stretches or to an endpoint tried between steps, must each be at least twice the unit in the last place of the figures involved, in the canonical and the entered unit, or its neighbouring values would be one double (an error on the step, or on the bound whose inclusion collides); a stretch that holds no value is not tested. The only range limit is that a scaled figure is a whole number a double holds exactly.
const MAX_SCALED = BigInt(Number.MAX_SAFE_INTEGER)
const ULPS = 2
const MAX_EXPONENT = 1000

const DECIMAL_TEXT = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const NOT_FINITE_TEXT = /^[+-]?(inf|infinity|nan)$/i

const ENTER_NUMBER = 'Enter a number.'
const ENTER_FINITE = 'Enter a finite number.'
const TOO_LARGE = 'Too large for the resolution.'

const kind = (unit, scale, { integer = false, units = {} } = {}) => Object.freeze({ unit, scale, integer, units: Object.freeze({ ...units }) })

// What a sweep can run over. `scale` is the integer units per canonical unit, which is the finest step a domain of the kind can take. `units` lists the other units a figure can be entered or shown in, each as how many of it make 1 canonical unit (50 tons make 1 HS, as TONS_PER_HS in design-rules.js; the check script compares them).
export const SWEEP_KINDS = Object.freeze({
  count: kind('', 1, { integer: true }),
  sizeHS: kind('HS', 1000, { units: { tons: 50 } }),
  sizeMSP: kind('MSP', 1000),
  thrust: kind('', 1000),
  fuel: kind('L', 1000),
  sensorCount: kind('', 1, { integer: true }),
  percent: kind('%', 100),
})

const kindOf = (name) => {
  if (!SWEEP_KINDS[name]) {
    throw new TypeError(`Unknown sweep kind: ${name}`)
  }

  return SWEEP_KINDS[name]
}

const decimalsOf = (scale) => Math.round(Math.log10(scale))

// A figure as plain digits with no more decimals than `decimals`, and no trailing zeros.
export const plain = (value, decimals = 6) => String(Number(value.toFixed(decimals)))

const unitFactor = (spec, unit) => {
  if (unit === undefined || unit === null || unit === 'canonical') {
    return 1
  }

  if (!spec.units[unit]) {
    throw new TypeError(`Unknown unit: ${unit}`)
  }

  return spec.units[unit]
}

// The sign, the digits as one whole number and the power of ten of a decimal text: the figure is `digits * 10 ** exponent`.
const decimalOf = (text) => {
  const [, sign, whole, fraction, exponent] = DECIMAL_TEXT.exec(text)

  return { negative: sign === '-', digits: BigInt(`${whole}${fraction}`), exponent: Number(exponent || 0) - fraction.length }
}

// A number from what a field holds: a number (computed), or the text of one (typed). { value, decimal, computed } or { error }. `decimal` is the exact decimal reading: the text as typed, or the shortest decimal that gives the number back.
export const parseNumber = (raw) => {
  let value
  let text
  let computed

  if (typeof raw === 'number') {
    value = raw
    text = String(raw)
    computed = true
  } else if (typeof raw === 'string') {
    text = raw.trim()
    computed = false

    if (NOT_FINITE_TEXT.test(text)) {
      return { error: ENTER_FINITE }
    }

    if (!NUMBER_TEXT.test(text)) {
      return { error: ENTER_NUMBER }
    }

    value = Number(text)
  } else {
    return { error: ENTER_NUMBER }
  }

  if (!Number.isFinite(value)) {
    return { error: ENTER_FINITE }
  }

  const decimal = decimalOf(text)

  return Math.abs(decimal.exponent) > MAX_EXPONENT ? { error: ENTER_NUMBER } : { value, decimal, computed }
}

// The size of one unit in the last place of a double.
const ulp = (value) => {
  const magnitude = Math.abs(value)
  let exponent = Math.floor(Math.log2(magnitude))

  if (2 ** exponent > magnitude) {
    exponent--
  } else if (2 ** (exponent + 1) <= magnitude) {
    exponent++
  }

  return 2 ** (exponent - 52)
}

// The whole numbers of scaled units either side of a figure read by `parseNumber`, in a unit that makes `factor` of them (an integer) to the canonical unit: { low, high } as BigInt, equal when the figure is on a tick.
const resolveScaled = (parsed, spec, factor) => {
  const { negative, digits, exponent } = parsed.decimal
  let numerator = digits * BigInt(spec.scale)
  let denominator = BigInt(factor)

  if (exponent >= 0) {
    numerator *= 10n ** BigInt(exponent)
  } else {
    denominator *= 10n ** BigInt(-exponent)
  }

  let low = numerator / denominator
  let high = numerator % denominator === 0n ? low : low + 1n

  if (low !== high && parsed.computed) {
    const size = Math.abs(parsed.value)
    const tickValue = (tick) => Number(`${tick * BigInt(factor)}e-${decimalsOf(spec.scale)}`)
    const nearest = [low, high].find((tick) => Math.abs(size - tickValue(tick)) <= ULPS * ulp(size))

    if (nearest !== undefined) {
      low = nearest
      high = nearest
    }
  }

  return negative ? { low: -high, high: -low } : { low, high }
}

// The tick a figure between two is cut to: up for a minimum (`direction` 1), down for a maximum (-1).
const inward = (figure, direction) => (direction > 0 ? figure.high : figure.low)

// The limits of a figure in scaled units: { min, max, source } with a bound missing when it is not given, cut inward to the resolution (a minimum up, a maximum down). { error } for a bound that is not a finite number or that no scaled whole number holds.
const scaledLimits = (limits, spec) => {
  const source = (limits && limits.source) || 'allowed'
  const result = { min: null, max: null, source }

  for (const [bound, direction] of [['min', 1], ['max', -1]]) {
    const given = limits ? limits[bound] : undefined

    if (given === undefined || given === null) {
      continue
    }

    const name = `The ${source} ${bound === 'min' ? 'minimum' : 'maximum'}`
    const parsed = typeof given === 'number' ? parseNumber(given) : { error: true }

    if (parsed.error) {
      return { error: `${name} is not a finite number.` }
    }

    const cut = inward(resolveScaled(parsed, spec, 1), direction)

    if (cut > MAX_SCALED || cut < -MAX_SCALED) {
      return { error: `${name} is too large for the resolution.` }
    }

    result[bound] = Number(cut)
  }

  return result
}

const limitMessage = (bound, scaled, spec, source) => `${bound === 'min' ? 'Below' : 'Above'} the ${source} ${bound === 'min' ? 'minimum' : 'maximum'} of ${plain(scaled / spec.scale, decimalsOf(spec.scale))}${spec.unit ? ` ${spec.unit}` : ''}.`

// One field read against a kind: { ok: true, value (canonical), scaled, cut } or { ok: false, error }. `positive` asks for a value above 0 (a step), `snap: 'inward'` cuts a figure finer than the resolution (`direction` 1 up, -1 down) instead of refusing it, and `limits` is checked here only when `scaledBounds` (from `scaledLimits`) is passed.
export const readField = (raw, { kind: kindName, unit, positive = false, snap = 'error', direction = 1, scaledBounds = null }) => {
  const spec = kindOf(kindName)
  const parsed = parseNumber(raw)

  if (parsed.error) {
    return { ok: false, error: parsed.error }
  }

  const factor = unitFactor(spec, unit)
  const canonical = parsed.value / factor

  if (positive && !(canonical > 0)) {
    return { ok: false, error: 'The step must be above 0.' }
  }

  if (parsed.decimal.negative && parsed.decimal.digits > 0n) {
    return { ok: false, error: 'Enter 0 or more.' }
  }

  const figure = resolveScaled(parsed, spec, factor)
  const onTick = figure.low === figure.high

  if (!onTick && !(snap === 'inward' && !spec.integer)) {
    return { ok: false, error: spec.integer ? 'Enter a whole number.' : `Finer than the resolution of ${plain(1 / spec.scale, decimalsOf(spec.scale))}${spec.unit ? ` ${spec.unit}` : ''}.` }
  }

  const cut = inward(figure, direction)

  if (cut > MAX_SCALED) {
    return { ok: false, error: TOO_LARGE }
  }

  const scaled = Number(cut)

  if (positive && scaled < 1) {
    return { ok: false, error: 'The step must be above 0.' }
  }

  if (scaledBounds) {
    for (const bound of ['min', 'max']) {
      if (scaledBounds[bound] !== null && (bound === 'min' ? scaled < scaledBounds[bound] : scaled > scaledBounds[bound])) {
        return { ok: false, error: limitMessage(bound, scaledBounds[bound], spec, scaledBounds.source) }
      }
    }
  }

  return { ok: true, value: scaled / spec.scale, scaled, cut: !onTick }
}

// A single figure read against a kind and its limits, as a page's one-value field takes it: { ok, value, error }.
export const readValue = (raw, { kind: kindName, unit, limits = null }) => {
  const spec = kindOf(kindName)
  const scaledBounds = limits ? scaledLimits(limits, spec) : null

  if (scaledBounds && scaledBounds.error) {
    return { ok: false, value: null, error: scaledBounds.error }
  }

  const field = readField(raw, { kind: kindName, unit, scaledBounds })

  return field.ok ? { ok: true, value: field.value, error: null } : { ok: false, value: null, error: field.error }
}

// The points of the grid inside [low, high] (scaled whole numbers) as parts `{ first, step, count }`, one for each band that has a point. `pieces` is [{ step, to }] with the scaled step of each band and the scaled value it runs up to (null for the last: up to `high`). The first band's grid starts at `low` ('min') or at every multiple of its step from 0 ('zero'); each later band's grid starts at the end of the one before and holds the points above it.
const gridParts = ({ low, high, pieces, anchor }) => {
  const parts = []
  let previous = null

  pieces.forEach((piece, index) => {
    const ceiling = piece.to === null ? high : Math.min(piece.to, high)
    const base = index === 0 ? (anchor === 'min' ? low : 0) : previous
    const from = index === 0 ? low : Math.max(low, previous + 1)

    if (from <= ceiling) {
      const remainder = (from - base) % piece.step
      const first = remainder === 0 ? from : from + piece.step - remainder

      if (first <= ceiling) {
        const span = ceiling - first

        parts.push({ first, step: piece.step, count: (span - (span % piece.step)) / piece.step + 1 })
      }
    }

    previous = piece.to === null ? high : piece.to
  })

  return parts
}

const lastOf = (part) => part.first + (part.count - 1) * part.step

const empty = (errors, extra = {}) => Object.freeze({ ok: false, errors: Object.freeze(errors), problems: Object.freeze(Object.values(errors)), count: 0, ...extra })

// A sweep domain: `{ kind, min, max, step, unit, limits, anchor, include, snap, bands }`.
// - `min`, `max`, `step`: numbers or the text of a field, in `unit` (a unit `SWEEP_KINDS[kind].units` names; canonical by default). `bands` ([{ step, to }], steps and bounds in `unit`, `to` omitted on the last) replaces `step` with a step for each stretch of the range.
// - `limits`: `{ min, max, source }` the bounds must stay inside; `source` ('researched') names them in the message.
// Returns { ok, errors, problems, kind, unit, scale, anchor, include, min, max, count, first, last, offStep, cuts, parts, scaledAt, at, values, toArray, signature }: `min` and `max` the bounds as the domain reads them (canonical, cut when `snap` is 'inward'), `first` and `last` the first and last value, `offStep` whether each bound is not a grid point, `cuts` the bounds a cut moved, `scaledAt(index)` the whole number of the value at an index and `at(index)` its figure. A domain that is not ok has `errors` and no values.
export const sweepDomain = ({ kind: kindName, min, max, step, bands = null, unit, limits = null, anchor = 'min', include = 'grid', snap = 'error' }) => {
  const spec = kindOf(kindName)

  if (!['min', 'zero'].includes(anchor)) {
    throw new TypeError(`Unknown anchor: ${anchor}`)
  }

  if (!['grid', 'limits'].includes(include)) {
    throw new TypeError(`Unknown endpoint policy: ${include}`)
  }

  const errors = {}
  const scaledBounds = limits ? scaledLimits(limits, spec) : null
  const cuts = []

  if (scaledBounds && scaledBounds.error) {
    errors.limits = scaledBounds.error
  } else if (scaledBounds && scaledBounds.min !== null && scaledBounds.max !== null && scaledBounds.min > scaledBounds.max) {
    errors.limits = `The ${scaledBounds.source} minimum is above the maximum.`
  }

  const bounds = {}

  for (const [name, raw, direction] of [['min', min, 1], ['max', max, -1]]) {
    const field = readField(raw, { kind: kindName, unit, snap, direction, scaledBounds: scaledBounds && !scaledBounds.error ? scaledBounds : null })

    if (field.ok) {
      bounds[name] = field

      if (field.cut) {
        cuts.push({ bound: name, to: field.value })
      }
    } else {
      errors[name] = field.error
    }
  }

  let pieces = null

  if (bands) {
    if (!Array.isArray(bands) || !bands.length) {
      throw new TypeError('bands must be a list of { step, to }')
    }

    pieces = bands.map((band, index) => {
      const stepField = readField(band.step, { kind: kindName, unit, positive: true })
      const toField = band.to === undefined || band.to === null ? { ok: true, scaled: null } : readField(band.to, { kind: kindName, unit })

      if (!stepField.ok || !toField.ok || (band.to === undefined && index < bands.length - 1)) {
        throw new TypeError(`Band ${index} of the sweep is not a legal band`)
      }

      return { step: stepField.scaled, to: toField.scaled }
    })

    if (pieces.some((piece, index) => index > 0 && piece.to !== null && pieces[index - 1].to !== null && piece.to <= pieces[index - 1].to)) {
      throw new TypeError('The bands of a sweep must rise')
    }
  } else {
    const stepField = readField(step, { kind: kindName, unit, positive: true })

    if (stepField.ok) {
      pieces = [{ step: stepField.scaled, to: null }]
    } else {
      errors.step = stepField.error
    }
  }

  if (bounds.min && bounds.max && bounds.min.scaled > bounds.max.scaled) {
    errors.min = `Above the upper bound of ${plain(bounds.max.value, decimalsOf(spec.scale))}${spec.unit ? ` ${spec.unit}` : ''}.`
    errors.max = `Below the lower bound of ${plain(bounds.min.value, decimalsOf(spec.scale))}${spec.unit ? ` ${spec.unit}` : ''}.`
  }

  const known = { kind: kindName, unit: spec.unit, scale: spec.scale, anchor, include }

  if (Object.keys(errors).length) {
    return empty(errors, known)
  }

  const low = bounds.min.scaled
  const high = bounds.max.scaled
  const grid = gridParts({ low, high, pieces, anchor })
  const firstGrid = grid.length ? grid[0].first : null
  const lastGrid = grid.length ? lastOf(grid[grid.length - 1]) : null
  const offStep = { min: firstGrid !== low, max: lastGrid !== high }

  if (!grid.length && include === 'grid') {
    const stepText = bands ? 'the steps' : `a step of ${plain(pieces[0].step / spec.scale, decimalsOf(spec.scale))}${spec.unit ? ` ${spec.unit}` : ''}`

    return empty({ domain: `No point of ${stepText} lies between ${plain(low / spec.scale, decimalsOf(spec.scale))} and ${plain(high / spec.scale, decimalsOf(spec.scale))}.` }, { ...known, min: low / spec.scale, max: high / spec.scale })
  }

  const parts = []

  if (include === 'limits' && offStep.min) {
    parts.push({ first: low, step: 0, count: 1 })
  }

  parts.push(...grid)

  if (include === 'limits' && offStep.max && (high > low || !parts.length)) {
    parts.push({ first: high, step: 0, count: 1 })
  }

  const factors = [1, unitFactor(spec, unit)]
  const collapses = (from, to, gap) => factors.some((factor) => 2 * ulp((Math.max(Math.abs(from), Math.abs(to)) / spec.scale) * factor) > (gap / spec.scale) * factor)
  const lowEndpoint = include === 'limits' && offStep.min
  const highEndpoint = parts.length > (lowEndpoint ? 1 : 0) + grid.length

  parts.forEach((part, index) => {
    if (part.count > 1 && collapses(part.first, lastOf(part), part.step)) {
      errors.step = 'Finer than a figure of this size can hold.'
    }

    if (index > 0 && collapses(lastOf(parts[index - 1]), part.first, part.first - lastOf(parts[index - 1]))) {
      const bound = index === 1 && lowEndpoint ? 'min' : index === parts.length - 1 && highEndpoint ? 'max' : null

      errors[bound || 'step'] = bound ? 'Too close to the next value for a figure of this size.' : 'Finer than a figure of this size can hold.'
    }
  })

  if (Object.keys(errors).length) {
    return empty(errors, { ...known, min: low / spec.scale, max: high / spec.scale })
  }

  const starts = []
  let count = 0

  parts.forEach((part) => {
    starts.push(count)
    count += part.count
  })

  const scaledAt = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`Index ${index} is outside the ${count} values of the sweep`)
    }

    let at = parts.length - 1

    while (starts[at] > index) {
      at--
    }

    return parts[at].first + (index - starts[at]) * parts[at].step
  }

  const at = (index) => scaledAt(index) / spec.scale

  function* values() {
    for (const part of parts) {
      for (let place = 0; place < part.count; place++) {
        yield (part.first + place * part.step) / spec.scale
      }
    }
  }

  return Object.freeze({
    ...known,
    ok: true,
    errors: Object.freeze({}),
    problems: Object.freeze([]),
    min: low / spec.scale,
    max: high / spec.scale,
    count,
    first: scaledAt(0) / spec.scale,
    last: scaledAt(count - 1) / spec.scale,
    offStep: Object.freeze(offStep),
    cuts: Object.freeze(cuts),
    parts: Object.freeze(parts.map((part) => Object.freeze({ ...part }))),
    scaledAt,
    at,
    values,
    toArray: () => [...values()],
    signature: JSON.stringify({ kind: kindName, scale: spec.scale, parts }),
  })
}

// A figure of a domain in the unit given, from its scaled whole number.
const shown = (scaled, spec, factor) => (scaled * factor) / spec.scale

// What a domain tries, in words and figures for a preview, in the unit given (canonical by default): { ok, problems, count, first, last, unit, ranges: [{ from, to, step, count }], notes, text }. `format(value)` writes a figure (the page's number format). `ranges` has one entry for each stretch of the grid; a bound tried between steps is in `notes`, not in `ranges`.
export const describeSweep = (domain, { unit, format = (value) => plain(value, 6) } = {}) => {
  if (!domain.ok) {
    return { ok: false, problems: domain.problems, count: 0, unit: SWEEP_KINDS[domain.kind].unit, ranges: [], notes: [], text: '' }
  }

  const spec = kindOf(domain.kind)
  const factor = unitFactor(spec, unit)
  const unitText = factor === 1 ? spec.unit : unit
  const suffix = unitText ? ` ${unitText}` : ''
  const figure = (scaled) => format(shown(scaled, spec, factor))
  const grid = domain.parts.filter((part) => part.step > 0)
  const ranges = domain.parts.filter((part) => part.step > 0).map((part) => ({ from: shown(part.first, spec, factor), to: shown(lastOf(part), spec, factor), step: shown(part.step, spec, factor), count: part.count }))
  const first = shown(domain.parts[0].first, spec, factor)
  const last = shown(lastOf(domain.parts[domain.parts.length - 1]), spec, factor)
  const notes = []

  const describeBound = (bound, name, position) => {
    if (!domain.offStep[bound]) {
      return
    }

    const scaled = Math.round((bound === 'min' ? domain.min : domain.max) * spec.scale)
    const tried = domain.include === 'limits'
    const edge = tried ? (bound === 'min' ? first : last) : (bound === 'min' ? shown(grid[0].first, spec, factor) : shown(lastOf(grid[grid.length - 1]), spec, factor))

    notes.push(`The ${name} bound ${figure(scaled)}${suffix} is between steps and ${tried ? `is tried as the ${position} value` : `is not tried; the ${position} value is ${format(edge)}${suffix}`}.`)
  }

  describeBound('min', 'lower', 'first')
  describeBound('max', 'upper', 'last')

  domain.cuts.forEach((cut) => notes.push(`The ${cut.bound === 'min' ? 'lower' : 'upper'} limit is cut to ${figure(Math.round(cut.to * spec.scale))}${suffix}, the finest the sweep resolves.`))

  const steps = ranges.length > 1 ? `steps of ${ranges.map((range) => `${format(range.step)}${suffix}`).join(', ')}` : ranges.length === 1 ? `steps of ${format(ranges[0].step)}${suffix}` : ''
  const total = `${domain.count} ${domain.count === 1 ? 'value' : 'values'}`

  const text = domain.count === 1 ? `${format(first)}${suffix}, 1 value` : `${format(first)} to ${format(last)}${suffix}${steps ? ` in ${steps}` : ''}, ${total}`

  return { ok: true, problems: [], count: domain.count, first, last, unit: unitText, ranges, notes, text }
}

// How many combinations the domains make together, or null when one is not ok or the product is not a safe whole number.
export const combinationCount = (domains) => {
  let product = 1

  for (const domain of domains) {
    if (!domain || !domain.ok) {
      return null
    }

    product *= domain.count

    if (!Number.isSafeInteger(product)) {
      return null
    }
  }

  return product
}
