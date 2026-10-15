// What the Sensor Planner shows of the results of utilities/sensor-planner.js: the sizing table by resolution, the beam fire control axes and multiplier table, and the tiles, each figure a provenance result of its own so that every cell can carry its mark. A part of a result keeps the status, rule, inputs and assumptions of the whole, and a part the result does not have (a size where no legal size reaches the range) is unavailable, never 0. `format(value, decimals)` writes a number.
import { SENSOR_COMPONENT_TYPES } from './design-data'
import { SENSOR_RULES } from './design-rules'
import { combine, envelope, isAvailable, unavailable } from './provenance'

// The mode of the Sensor Planner that shows a component design of `typeId` (the component type of the save): active for an active sensor or a missile fire control, passive for a thermal or EM sensor, beam for a beam fire control, null for any other component.
export const sensorModeOf = (typeId) => {
  if (typeId === SENSOR_COMPONENT_TYPES.active || typeId === SENSOR_COMPONENT_TYPES.missileFireControl) {
    return 'active'
  }

  if (typeId === SENSOR_COMPONENT_TYPES.thermal || typeId === SENSOR_COMPONENT_TYPES.em) {
    return 'passive'
  }

  return typeId === SENSOR_COMPONENT_TYPES.beamFireControl ? 'beam' : null
}

const UNKNOWN = 'Unknown'

// The part `select` takes of a result's value as a result of its own: unavailable when the result is, or when the part is not a number.
export const part = (result, select, { units, missing = 'the figure' } = {}) => {
  if (!result || !isAvailable(result)) {
    return result || unavailable({ rule: SENSOR_RULES.sizing, missing: [missing], units })
  }

  const value = select(result.value)

  if (!Number.isFinite(value)) {
    return unavailable({ rule: result.rule.id, present: result.inputs.present, missing: [missing], units, assumptions: result.assumptions })
  }

  return envelope({ value, status: result.status, rule: result.rule.id, inputs: result.inputs, units, assumptions: result.assumptions })
}

// The sum of the search sensor's and the fire control's part as a result: unavailable when either is.
const total = (search, fireControl, units) => combine({ rule: SENSOR_RULES.active, parts: { search, fireControl }, compute: (values) => values.search + values.fireControl, units })

// What a row of the sizing table says about itself: the verdict in words, never a figure.
export const rowVerdict = (row) => {
  if (!isAvailable(row.search.sizing) && !isAvailable(row.fireControl.sizing)) {
    return UNKNOWN
  }

  if (row.feasible) {
    return 'Meets the range'
  }

  const failing = row.failing || []

  if (failing.length === 2) {
    return 'No legal search sensor or fire control size reaches the range'
  }

  return failing[0] === 'fireControl' ? 'No legal fire control size reaches the range' : 'No legal search sensor size reaches the range'
}

// One member of a pair, the search sensor or the fire control, as results of its own.
const memberOf = (member) => ({
  size: member.size,
  reach: member.reach,
  cost: member.cost,
  uridium: part(member.design, (value) => value.uridium, { units: 'Uridium', missing: 'a design at a legal size' }),
  corbomite: part(member.design, (value) => value.corbomite, { units: 'Corbomite', missing: 'a design at a legal size' }),
  crew: part(member.design, (value) => value.crew, { units: 'crew', missing: 'a design at a legal size' }),
})

// What the sizing still needs typed, as one line in place of a table of Unknown rows (`request` of `activeSizing`; none for a sizing that is only rows): empty once the target's signature and the wanted range are both known.
export const sizingEmpty = (request) => {
  if (!request) {
    return ''
  }

  const missing = [isAvailable(request.signature) ? null : 'the target size', request.wantedRangeKm === null ? 'the wanted range' : null].filter(Boolean)

  return missing.length ? `Type ${missing.join(' and ')} to size a pair.` : ''
}

// The rows of the sizing table, one for each legal resolution: the pair that reaches the wanted range at it.
export const sizingRows = (sizing) => sizing.rows.map((row) => {
  const search = memberOf(row.search)
  const fireControl = memberOf(row.fireControl)

  return {
    key: String(row.resolution),
    resolution: row.resolution,
    resolutionResult: part(row.search.sizing, () => row.resolution, { units: 'HS', missing: 'the target and the range' }),
    search,
    fireControl,
    totalHS: row.totalHS,
    totalCost: row.totalCost,
    uridium: total(search.uridium, fireControl.uridium, 'Uridium'),
    corbomite: total(search.corbomite, fireControl.corbomite, 'Corbomite'),
    crew: total(search.crew, fireControl.crew, 'crew'),
    reach: row.reach,
    feasible: row.feasible === true,
    best: row.best === true,
    selected: row.selected === true,
    limiting: row.limiting,
    failing: row.failing || [],
    verdict: rowVerdict(row),
  }
})

const million = (result, format, decimals) => (isAvailable(result) ? `${format(result.value / 1e6, decimals)} million km` : UNKNOWN)

// The tiles of the active mode: the range reached, the size needed, the best resolution and the cost, each with its mark. An input the planner could not use is named in the note of the first tile.
export const sizingTiles = (sizing, format) => {
  const { rangeReached, sizeNeeded, bestResolution, cost } = sizing.tiles
  const blank = sizing.problems.length ? sizing.problems.join(' ') : ''
  const text = (result, decimals, unit) => (isAvailable(result) ? `${format(result.value, decimals)} ${unit}` : UNKNOWN)

  return [
    { label: 'Range reached', value: million(rangeReached, format, 2), note: blank || 'The shorter of the search and fire control ranges against the target at the chosen resolution', result: rangeReached },
    { label: 'Size needed', value: text(sizeNeeded, 2, 'HS'), note: 'The search sensor and the fire control together', result: sizeNeeded },
    { label: 'Best resolution', value: text(bestResolution, 0, 'HS'), note: sizing.bestBasis === 'size' ? 'The smallest pair, as none of them reaches' : 'The pair with the lowest cost', result: bestResolution },
    { label: 'Cost', value: text(cost, 1, 'BP'), note: 'The pair at the chosen resolution, with the hardening and ECCM levels in use', result: cost },
  ]
}

// A beam fire control axis in words: whether a multiplier reaches what is wanted, and the cap. `format(value, decimals)` writes a number.
export const axisVerdict = (axis, noun, format) => {
  if (axis.status === 'unavailable') {
    return `Unknown: the ${noun} wanted is not typed`
  }

  if (axis.beyondCap) {
    return `Beyond the cap: a range above ${format(axis.capKm, 0)} km cannot be reached`
  }

  if (axis.status === 'beyond-largest') {
    return `No legal ${noun} multiplier reaches it`
  }

  return axis.status === 'minimum-bound' ? `Even the smallest ${noun} multiplier reaches it` : `Reached with a ${noun} multiplier of ${axis.multiplier}`
}

// One requirement of a beam fire control as a table row: what is wanted, the multiplier that reaches it and what that multiplier reaches, each a result, and the verdict in words.
const axisRow = ({ key, label, unit, noun, axis, format }) => ({
  key,
  label,
  unit,
  axis,
  wanted: part(axis.result, () => axis.wanted, { units: unit, missing: `the ${noun} wanted` }),
  multiplier: part(axis.result, () => axis.multiplier, { missing: `a ${noun} multiplier that reaches it` }),
  reach: part(axis.result, () => axis.reachKm, { units: unit, missing: `a ${noun} multiplier that reaches it` }),
  verdict: axisVerdict(axis, noun, format),
})

// The two requirements of a beam fire control as table rows: the range and the tracking speed.
export const axisRows = (beam, format) => [
  axisRow({ key: 'range', label: 'Range', unit: 'km', noun: 'range', axis: beam.range, format }),
  axisRow({ key: 'tracking', label: 'Tracking speed', unit: 'km/s', noun: 'tracking', axis: beam.tracking, format }),
]

// The multiplier table of a beam fire control, one row for each pair of multipliers, each figure a part of the design.
export const multiplierRows = (beam) => beam.table.rows.map((row, index) => ({
  key: `${row.rangeMultiplier}-${row.trackingMultiplier}-${index}`,
  rangeMultiplier: row.rangeMultiplier,
  trackingMultiplier: row.trackingMultiplier,
  proposed: row.proposed === true,
  capped: row.rangeCapped === true,
  wasted: row.wastedMultiplier === true,
  range: part(row.design, (value) => value.rangeKm, { units: 'km', missing: 'a design at these multipliers' }),
  tracking: part(row.design, (value) => value.trackingKmS, { units: 'km/s', missing: 'a design at these multipliers' }),
  size: part(row.design, (value) => value.sizeHS, { units: 'HS', missing: 'a design at these multipliers' }),
  cost: part(row.design, (value) => value.cost, { units: 'BP', missing: 'a design at these multipliers' }),
  crew: part(row.design, (value) => value.crew, { units: 'crew', missing: 'a design at these multipliers' }),
  uridium: part(row.design, (value) => value.uridium, { units: 'Uridium', missing: 'a design at these multipliers' }),
  corbomite: part(row.design, (value) => value.corbomite, { units: 'Corbomite', missing: 'a design at these multipliers' }),
}))

// The tiles of the beam mode: the range, the tracking speed, the size and the cost of the fire control that meets the request.
export const beamTiles = (beam, format) => {
  const { range, tracking, size, cost } = beam.tiles
  const text = (result, decimals, unit) => (isAvailable(result) ? `${format(result.value, decimals)} ${unit}` : UNKNOWN)

  return [
    { label: 'Range', value: text(range, 0, 'km'), note: 'Never above the cap of 1,400,000 km', result: range },
    { label: 'Tracking speed', value: text(tracking, 0, 'km/s'), note: 'The tracking multiplier times the speed rating', result: tracking },
    { label: 'Size', value: text(size, 2, 'HS'), note: beam.restriction.label, result: size },
    { label: 'Cost', value: text(cost, 1, 'BP'), note: 'With the hardening and ECCM levels in use', result: cost },
  ]
}
