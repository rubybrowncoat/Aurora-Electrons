// What a ship class shows to a passive or an active sensor and how far an enemy sensor reaches it: the thermal signature at the shares of top speed the player chooses, the cross-section with the cloak working and without it, the EM signature of the shields and of each active sensor, the range curves of a passive sensor, and the engine of the class at each thermal reduction level the race has researched. Pure functions over the records of design-data.js `loadSignatureClasses` and `loadThermalReduction`, built on the rules of design-rules.js; every figure a planner shows is a provenance result (utilities/provenance.js), unavailable and never 0 when an input is unknown. Enemy figures are typed by the player and never inferred from alien data in the save.
//
// Return shapes:
// - `readSpeedShares(text)`: `{ fractions, error }`, `fractions` the shares of top speed (each above 0 and at most 1, with 0 and 1 always present, sorted, without duplicates) and `error` text ('' when the text is read). Blank text gives DEFAULT_FRACTIONS; text that is not read gives DEFAULT_FRACTIONS and the error.
// - `classSignatures(cls, { fractions })`: `{ thermal: { aggregate, stored, agrees, byFraction: [{ fraction, result }] }, crossSection: { effective, uncloaked, stored, agrees, cloaked, reduction: { rebuilt, stored, agrees } }, em: { shields, activeSensors: [{ sensor, result }], strongestActive } }`. `aggregate`, `stored`, `effective`, `uncloaked`, `shields`, `strongestActive`, `rebuilt`, each `result`, are provenance results; `agrees` is true or false, null when the stored or the rebuilt figure is unknown; `cloaked` is true when a fitted cloak reduces the cross-section; `sensor` is the active sensor record of the class.
// - `passiveReach({ sensitivity, signature })`, `activeReach({ rangeKm, resolution, crossSection })`: provenance results in km; each figure may be a number, null (unknown) or a provenance result, which then lends its provenance.
// - `rangeCurve({ sensitivities, signatures })`: `{ series: [{ key, name, sensitivity, points: [{ x (signature), y (km) }] }], rows: [{ signature, ranges: [{ key, name, result }] }] }`, a point only where the range is known (so a curve has no 0 for an unknown sensor), a row for every signature and sensor.
// - `speedCurve(cls, { sensitivity, steps })`: `{ points: [{ fraction, thermal, reach }], rows: [{ fraction, thermal, reach }] }`, the points plain numbers (null where unknown) and the rows provenance results, for the shares 0 to 1 in `steps` equal steps.
// - `thermalReductionOptions(cls, { levels, techs, fractions })`: one entry per researched level, `{ level: { id, name, current }, multiplier, costFactor, engineCost (BP of one engine, a result), classEngineCost (BP of every engine of the class, a result), aggregate (thermal at full power, a result), engines: [{ engine, count, cost }], byFraction: [{ fraction, result }] }`; an empty list for a class with no engine.

import { agrees, activeSensorEmission, classCrossSection, classThermal, cloakReduction, engineDesign, passiveRange, sensorEffectiveRange, SENSOR_RULES, shieldEmission, thermalSignature } from './design-rules'
import { STATUS, combine, envelope, isAvailable, ofRule, unavailable, weakestStatus } from './provenance'

export const DEFAULT_FRACTIONS = Object.freeze([0, 0.5, 1])

const RULES = Object.freeze({ signature: 'design.thermalSignature', thermal: 'design.classThermal', cross: 'design.classCrossSection', em: 'design.emEmission', engine: 'design.engineDesign', detection: SENSOR_RULES.detection })

const MAX_STEPS = 200
const DEFAULT_STEPS = 20

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const isResult = (value) => value !== null && typeof value === 'object' && typeof value.status === 'string'

const percentOf = (fraction) => `${Number((fraction * 100).toFixed(2))} %`

// ---------- the speed shares the player types ----------

const SHARE_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)%?$/

// The shares of top speed a text of percentages names, such as '25, 75%': each above 0 and at most 100 %, as fractions. Idle (0) and full speed (1) are always present, the list is sorted and has no duplicate. Blank text gives the defaults; text that cannot be read gives the defaults and the reason.
export const readSpeedShares = (text) => {
  const tokens = String(text === null || text === undefined ? '' : text).split(/[\s,;]+/).filter(Boolean)

  if (!tokens.length) {
    return { fractions: DEFAULT_FRACTIONS, error: '' }
  }

  const fractions = new Set([0, 1])

  for (const token of tokens) {
    const match = SHARE_PATTERN.exec(token)

    if (!match) {
      return { fractions: DEFAULT_FRACTIONS, error: `"${token}" is not a percentage of top speed` }
    }

    const percent = Number(match[1])

    if (!(percent > 0 && percent <= 100)) {
      return { fractions: DEFAULT_FRACTIONS, error: `"${token}" is not above 0 % and at most 100 %` }
    }

    fractions.add(Number((percent / 100).toPrecision(12)))
  }

  return { fractions: Object.freeze([...fractions].sort((a, b) => a - b)), error: '' }
}

// ---------- thermal ----------

const MIXED_REASON = (designs) => `the class mounts ${designs} engine designs, which the game's class designer refuses: the sum is power-weighted and not stored by the game`

// A thermal sum as a result: estimated when it is made of several engine designs, as a class of the game is not.
const markMixed = (result, designs) => {
  if (designs <= 1 || !isAvailable(result)) {
    return result
  }

  return envelope({ value: result.value, status: weakestStatus([result.status, STATUS.ESTIMATED]), rule: result.rule.id, inputs: result.inputs, units: result.units, assumptions: [...result.assumptions, MIXED_REASON(designs)] })
}

const designsOf = (engines) => new Set(engines.map((engine) => engine.id)).size

// The thermal signature at full power of a class from its engines, as a result of design.classThermal: unavailable naming the engine figure missing, confirmed for one engine design and estimated for several.
const aggregateOf = (engines) => {
  const rule = RULES.thermal
  const missing = engines.flatMap((engine) => [['engine power', engine.power], ['thermal rating', engine.thermalRating], ['count', engine.count]].filter(([, value]) => !isNumber(value)).map(([name]) => `the ${name} of ${engine.name}`))

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  return markMixed(ofRule({ rule, value: classThermal({ engines }), inputs: { present: ['engine power', 'thermal rating', 'engine count'] } }), designsOf(engines))
}

// A class's thermal signature at a share of top speed (`fraction`, 0 for idle) from its thermal sum at full power (`aggregate`, a result, or null for a class with no engine). Idle shows the floor of a twentieth of the size; a class with no engine and move orders shows 0; a share too low to rise above the floor is clamped to it.
const thermalAt = ({ sizeHS, aggregate, fraction }) => {
  const rule = RULES.signature

  if (!isNumber(sizeHS) || !(sizeHS > 0)) {
    return unavailable({ rule, missing: ['the class size'] })
  }

  if (fraction === 0) {
    return ofRule({ rule, value: thermalSignature({ enginePower: 0, stealthRating: 1, fraction: 0, sizeHS }), inputs: { present: ['class size'] }, assumptions: ['no move orders: the signature is a twentieth of the size'] })
  }

  if (aggregate === null) {
    return ofRule({ rule, value: 0, inputs: { present: ['class size'] }, assumptions: ['the class has no engine, so with move orders it gives no thermal signature'] })
  }

  return combine({ rule, parts: { 'thermal signature at full power': aggregate }, compute: (values) => thermalSignature({ enginePower: values['thermal signature at full power'], stealthRating: 1, fraction, sizeHS }), inputs: { present: ['class size'] }, assumptions: [`moving at ${percentOf(fraction)} of top speed`] })
}

const storedResult = (rule, value, name) => (isNumber(value) ? ofRule({ rule, value, inputs: { present: [name] } }) : unavailable({ rule, missing: [name] }))

const agreement = (stored, computed) => (isAvailable(stored) && isAvailable(computed) ? agrees(stored.value, computed.value) : null)

// ---------- cross-section ----------

// The effective cross-section is the one the save stores (the game uses it while the cloak works), the uncloaked one is the class size (what an active sensor sees once the cloak is damaged, never under the floor). The cross-section the rules rebuild from the size and the cloaks (`rebuilt`) only stands in for a save that stores none, and is otherwise what the stored one is compared with (`agrees`).
const crossSectionOf = (cls) => {
  const rule = RULES.cross
  const stored = storedResult(rule, cls.stored.crossSection, 'the stored cross-section')
  const storedReduction = storedResult(rule, cls.stored.sensorReduction, 'the stored sensor reduction')
  const sizeKnown = isNumber(cls.sizeHS) && cls.sizeHS > 0
  const missing = []

  if (!sizeKnown) {
    missing.push('the class size')
  }

  cls.cloaks.forEach((cloak) => {
    if (!isNumber(cloak.maxShipHS) || !isNumber(cloak.rating)) {
      missing.push(`the largest ship and the rating of ${cloak.name}`)
    }
  })

  const inputs = { present: ['class size', 'cloaks'] }
  const reduction = missing.length ? null : cloakReduction({ sizeHS: cls.sizeHS, cloaks: cls.cloaks })
  const rebuilt = reduction === null ? unavailable({ rule, missing }) : ofRule({ rule, value: classCrossSection({ sizeHS: cls.sizeHS, sensorReduction: reduction }), inputs })
  const rebuiltReduction = reduction === null ? unavailable({ rule, missing }) : ofRule({ rule, value: reduction, inputs })
  const standIn = isAvailable(rebuilt) ? ofRule({ rule, value: rebuilt.value, inputs, assumptions: ['the save stores no cross-section, so it is rebuilt from the size and the cloaks'] }) : rebuilt
  const effective = isAvailable(stored) ? stored : standIn
  const uncloaked = sizeKnown ? ofRule({ rule, value: classCrossSection({ sizeHS: cls.sizeHS, sensorReduction: 1 }), inputs: { present: ['class size'] }, assumptions: ['the cloak is damaged, so an active sensor sees the size'] }) : unavailable({ rule, missing: ['the class size'] })
  const cloaked = isAvailable(storedReduction) ? storedReduction.value < 1 : reduction !== null && reduction < 1

  return { effective, uncloaked, stored, rebuilt, agrees: agreement(stored, rebuilt), cloaked, reduction: { rebuilt: rebuiltReduction, stored: storedReduction, agrees: agreement(storedReduction, rebuiltReduction) } }
}

// ---------- EM ----------

const emOf = (cls) => {
  const rule = RULES.em
  const shields = isNumber(cls.stored.shieldStrength) ? ofRule({ rule, value: shieldEmission({ shieldStrength: cls.stored.shieldStrength }), inputs: { present: ['shield strength'] }, assumptions: ['shields up at full strength'] }) : unavailable({ rule, missing: ['the class shield strength'] })
  const sensors = [...new Map(cls.activeSensors.map((sensor) => [sensor.id, sensor])).values()]
  const activeSensors = sensors.map((sensor) => {
    const missing = [['strength', sensor.strength], ['resolution', sensor.resolution]].filter(([, value]) => !isNumber(value)).map(([name]) => `the ${name} of ${sensor.name}`)

    return { sensor, result: missing.length ? unavailable({ rule, missing }) : ofRule({ rule, value: activeSensorEmission({ strength: sensor.strength, resolution: sensor.resolution }), inputs: { present: ['strength', 'resolution'] }, assumptions: ['the sensor is switched on'] }) }
  })
  const strongestActive = activeSensors.length ? combine({ rule, parts: Object.fromEntries(activeSensors.map(({ sensor, result }) => [`${sensor.name} (${sensor.id})`, result])), compute: (values) => Math.max(...Object.values(values)) }) : ofRule({ rule, value: 0, inputs: { present: ['active sensors'] }, assumptions: ['the class has no active sensor'] })

  return { shields, activeSensors, strongestActive }
}

// What a class shows to a sensor: its thermal signature at each of `fractions` (the shares of top speed, DEFAULT_FRACTIONS unless given) beside the sum its engines make and the one the save stores, its cross-section with the cloak working and damaged, and its EM signature from the shields and from each active sensor on its own. The thermal and cross-section figures are those of design.classThermal and design.classCrossSection, which reproduce the stored figures; the EM figures are estimates, as the saves store no emission.
export const classSignatures = (cls, { fractions = DEFAULT_FRACTIONS } = {}) => {
  const aggregate = aggregateOf(cls.engines)
  const stored = storedResult(RULES.thermal, cls.stored.thermal, 'the stored thermal signature')
  const hasEngines = cls.engines.length > 0

  return {
    thermal: { aggregate, stored, agrees: agreement(stored, aggregate), byFraction: fractions.map((fraction) => ({ fraction, result: thermalAt({ sizeHS: cls.sizeHS, aggregate: hasEngines ? aggregate : null, fraction }) })) },
    crossSection: crossSectionOf(cls),
    em: emOf(cls),
  }
}

// ---------- reach ----------

// A reach of `rule` from named figures, each a number, null or a provenance result: the figures' values go to `compute`, and a result among them lends its provenance to the reach, so a reach on a figure that is estimated is estimated and one on an unavailable figure is unavailable.
const reachOf = (rule, figures, compute) => {
  const lent = Object.fromEntries(Object.entries(figures).filter(([, figure]) => isResult(figure)))
  const values = Object.fromEntries(Object.entries(figures).map(([name, figure]) => [name, isResult(figure) ? (isAvailable(figure) ? figure.value : null) : figure]))
  const reach = compute(values)

  return Object.keys(lent).length ? combine({ rule, parts: { ...lent, reach }, compute: (parts) => parts.reach, units: reach.units }) : reach
}

// How far a passive sensor of `sensitivity` detects a target of `signature`, in km: unavailable when either is blank or unknown (never 0, never taken from alien data in the save), 0 for a signature of 0.
export const passiveReach = ({ sensitivity, signature }) => reachOf(RULES.detection, { sensitivity, signature }, (values) => passiveRange(values))

// How far an active sensor of `rangeKm` and `resolution` detects a target of `crossSection` (HS): its range cut by the square of the cross-section over the resolution when the target is under it. Unavailable when any is blank or unknown.
export const activeReach = ({ rangeKm, resolution, crossSection }) => reachOf(RULES.detection, { rangeKm, resolution, crossSection }, (values) => sensorEffectiveRange({ rangeKm: values.rangeKm, signature: values.crossSection, resolution: values.resolution }))

// ---------- curves ----------

const sortedSignatures = (signatures) => [...new Set(signatures.filter((signature) => isNumber(signature) && signature >= 0))].sort((a, b) => a - b)

// The range of each sensor (`sensitivities` of { key, name, sensitivity }) against each target signature, from smallest to largest, with duplicates and signatures that are not numbers of 0 or more left out.
export const rangeCurve = ({ sensitivities, signatures }) => {
  const targets = sortedSignatures(signatures)
  const rows = targets.map((signature) => ({ signature, ranges: sensitivities.map(({ key, name, sensitivity }) => ({ key, name, result: passiveReach({ sensitivity, signature }) })) }))
  const series = sensitivities.map(({ key, name, sensitivity }, index) => ({ key, name, sensitivity, points: rows.filter((row) => isAvailable(row.ranges[index].result)).map((row) => ({ x: row.signature, y: row.ranges[index].result.value })) }))

  return { series, rows }
}

// A class's thermal signature and the reach of a thermal sensor of `sensitivity` against it at the shares 0 to 1 of top speed, in `steps` equal steps.
export const speedCurve = (cls, { sensitivity = null, steps = DEFAULT_STEPS } = {}) => {
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
    throw new Error(`The speed curve takes 1 to ${MAX_STEPS} steps`)
  }

  const aggregate = cls.engines.length ? aggregateOf(cls.engines) : null
  const rows = Array.from({ length: steps + 1 }, (_, index) => {
    const fraction = index / steps
    const thermal = thermalAt({ sizeHS: cls.sizeHS, aggregate, fraction })

    return { fraction, thermal, reach: passiveReach({ sensitivity, signature: thermal }) }
  })
  const plain = (result) => (isAvailable(result) ? result.value : null)

  return { points: rows.map((row) => ({ fraction: row.fraction, thermal: plain(row.thermal), reach: plain(row.reach) })), rows }
}

// ---------- thermal reduction ----------

const techFigure = (techs, id) => (id !== null && id !== undefined && techs[id] && isNumber(techs[id].info) ? techs[id].info : null)

// One engine of a class designed again at a thermal reduction level, from the engine's own engine and fuel tech rows and the level's multiplier and cost factor: the engine design, or what is missing.
const engineAtLevel = (engine, level, techs) => {
  const engineTech = techFigure(techs, engine.techIds.engine)
  const fuelTech = techFigure(techs, engine.techIds.fuel)
  const missing = [
    [engineTech, `the engine tech row of ${engine.name}`],
    [fuelTech, `the fuel tech row of ${engine.name}`],
    [isNumber(level.multiplier) && level.multiplier > 0 ? level.multiplier : null, `the thermal reduction multiplier of ${level.name}`],
    [isNumber(level.costFactor) && level.costFactor > 0 ? level.costFactor : null, `the engine cost factor of ${level.name}`],
    [isNumber(engine.sizeHS) ? engine.sizeHS : null, `the size of ${engine.name}`],
    [isNumber(engine.thrust) ? engine.thrust : null, `the thrust of ${engine.name}`],
    [isNumber(engine.count) ? engine.count : null, `the count of ${engine.name}`],
  ].filter(([figure]) => figure === null).map(([, reason]) => reason)

  if (missing.length) {
    return { missing }
  }

  return { design: engineDesign({ sizeHS: engine.sizeHS, thrust: engine.thrust, engineTech, fuelTech, thermalTech: level.multiplier, thermalCost: level.costFactor }) }
}

// The engines of a class at each of the race's researched thermal reduction levels (`levels` and `techs` of design-data.js `loadThermalReduction`): the multiplier and cost factor of the level (the cost factor read from the level's tech row, applied by the engine rule only when the multiplier is under 1), the cost of an engine and of all the engines of the class, the thermal signature at full power and at each of `fractions`. A level for which an engine's tech row is missing is unavailable. The level the engines of the class are on now is marked `current`.
export const thermalReductionOptions = (cls, { levels, techs, fractions = DEFAULT_FRACTIONS }) => {
  if (!cls.engines.length) {
    return []
  }

  const designs = designsOf(cls.engines)

  return levels.map((level) => {
    const current = cls.engines.every((engine) => engine.techIds.thermal === level.id)
    const built = cls.engines.map((engine) => ({ engine, ...engineAtLevel(engine, level, techs) }))
    const missing = built.flatMap((entry) => entry.missing || [])
    const costs = built.map((entry) => (entry.design ? ofRule({ rule: RULES.engine, value: entry.design.cost, units: 'BP', inputs: { present: ['engine tech', 'fuel tech', 'thermal reduction level'] } }) : unavailable({ rule: RULES.engine, units: 'BP', missing: entry.missing })))
    const thermals = built.map((entry) => (entry.design ? ofRule({ rule: RULES.thermal, value: entry.design.thermal * entry.engine.count, inputs: { present: ['engine tech', 'thermal reduction level', 'engine count'] } }) : unavailable({ rule: RULES.thermal, missing: entry.missing })))
    const sum = (rule, results, units) => (missing.length ? unavailable({ rule, units, missing }) : combine({ rule, parts: Object.fromEntries(results.map((result, index) => [`${built[index].engine.name} (${index + 1})`, result])), compute: (values) => Object.values(values).reduce((total, value) => total + value, 0), units }))
    const aggregate = markMixed(sum(RULES.thermal, thermals), designs)
    const classEngineCost = sum(RULES.engine, built.map((entry, index) => (isAvailable(costs[index]) ? ofRule({ rule: RULES.engine, value: costs[index].value * entry.engine.count, units: 'BP', inputs: { present: ['engine tech', 'fuel tech', 'thermal reduction level', 'engine count'] } }) : costs[index])), 'BP')
    const engineCost = designs === 1 ? costs[0] : unavailable({ rule: RULES.engine, units: 'BP', missing: [`one engine design (the class mounts ${designs})`] })

    return {
      level: { id: level.id, name: level.name, current },
      multiplier: level.multiplier,
      costFactor: level.costFactor,
      engineCost,
      classEngineCost,
      aggregate,
      engines: built.map((entry, index) => ({ engine: entry.engine, count: entry.engine.count, cost: costs[index] })),
      byFraction: fractions.map((fraction) => ({ fraction, result: thermalAt({ sizeHS: cls.sizeHS, aggregate, fraction }) })),
    }
  })
}
