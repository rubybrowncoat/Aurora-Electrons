import { combine, ofRule, registerRule, ruleSupports, unavailable, valueOrNull } from './provenance'

// The hit chance of a missile against a target, as scenarios: the raw continuous chance the speeds, guidance, tactical modifier and jammer give, the chance capped at 100, and the whole-number chance one warhead has on its roll, each its own figure with its own rule so none is read for another. Every function is pure and returns provenance results (utilities/provenance.js): a missing, zero or invalid input leaves a result with no value, never 0.

const VERSIONS = ['2.7.x']

export const HIT_CAP = 100
export const JAMMER_FACTOR = 0.75
const STATIONARY_CHANCE = 100
const SPEED_SCALE = 10
const ROLL_TOLERANCE = 1e-9

export const HIT_RULES = Object.freeze({
  jammer: 'missileHit.jammerEffect',
  raw: 'missileHit.raw',
  capped: 'missileHit.capped',
  roll: 'missileHit.roll',
  hits: 'missileHit.expectedHits',
  targetSpeed: 'missileHit.targetSpeed',
})

registerRule({
  id: HIT_RULES.jammer,
  versions: VERSIONS,
  units: 'multiplier',
  verification: 'estimated',
  structure: ['FCT_MissileType.ECCM', 'the target\'s missile jammer strength (entered)'],
  note: 'A target\'s missile jammer lowers a missile\'s hit chance only when its strength is above the missile\'s ECCM. The chance is then multiplied by 0.75 to the power of the whole jammer strength, not of the surplus over the ECCM, so one point of ECCM short of the jammer costs the full penalty and an ECCM at or above the jammer costs none. Read from the game\'s rules; the save stores no hit chance to compare with.',
})

registerRule({
  id: HIT_RULES.raw,
  versions: VERSIONS,
  units: '%',
  verification: 'estimated',
  structure: ['FCT_MissileType.Speed, ATG, ECCM', 'the target speed, the target\'s missile jammer strength and the tactical modifier (entered)'],
  assumptions: ['The tactical modifier is entered, 1 unless stated: the launching ship\'s crew, morale and commander bonuses are not read from the save'],
  note: 'The missile\'s speed over the target\'s speed, times 10, times the tactical modifier, times the terminal guidance (a value under 1 counts as 1), times the jammer effect, as a percentage; a stationary target is hit at 100 before any other factor. The figure is not limited to 100: it is the continuous chance the factors give. Read from the game\'s rules; the save stores no hit chance to compare with.',
})

registerRule({
  id: HIT_RULES.capped,
  versions: VERSIONS,
  units: '%',
  verification: 'estimated',
  structure: ['the raw hit chance'],
  note: 'The raw hit chance limited to 100, the limit the game applies before a warhead rolls. A raw chance above 100 is no surer than 100.',
})

registerRule({
  id: HIT_RULES.roll,
  versions: VERSIONS,
  units: '%',
  verification: 'estimated',
  structure: ['the capped hit chance'],
  assumptions: ['The roll is a fair whole number from 1 to 100 and a warhead hits when the roll is not above its chance'],
  note: 'The chance one warhead has on a whole-number roll: the capped chance rounded down to a whole percent. Whether the game keeps a fraction of a percent, rounds or truncates the chance it rolls against is not settled, so this figure is an estimate beside the capped chance, which stays the continuous figure.',
})

registerRule({
  id: HIT_RULES.hits,
  versions: VERSIONS,
  units: 'warhead hits per missile',
  verification: 'assumed',
  structure: ['FCT_MissileType.MultipleWarheads', 'the capped or whole-number hit chance'],
  assumptions: ['Each warhead rolls independently at the same chance', 'The missile reaches its target with every warhead: no chance of being shot down or of falling short is applied'],
  note: 'The warheads of one missile times the chance of one warhead hitting, on the independent-roll assumption. A planner figure: it is not a count of penetrating damage, of missiles that survive point defence, or of ships destroyed.',
})

registerRule({
  id: HIT_RULES.targetSpeed,
  versions: VERSIONS,
  units: 'km/s',
  verification: 'estimated',
  structure: ['FCT_MissileType.Speed, ATG, ECCM', 'the target\'s missile jammer strength and the tactical modifier (entered)'],
  note: 'The target speed at which the raw hit chance equals a given percentage: the missile\'s speed times 10, the tactical modifier, the terminal guidance and the jammer effect, over the percentage. At 100 it is the fastest target the missile hits at the cap.',
})

const UNVERIFIED = 'The save is not shown to be a 2.7 save, so the rule is not verified for its game version'

const MISSILE_SPEED = 'a missile speed above 0'
const TARGET_SPEED = 'a target speed of 0 or more'
const GUIDANCE = 'the missile\'s terminal guidance'
const MODIFIER = 'a tactical modifier above 0'
const JAMMER = 'a target missile jammer strength of 0 or more'
const ECCM = 'the missile\'s ECCM'
const WARHEADS = 'a whole number of warheads, 1 or more'
const NOT_DECOY = 'a missile that is not a ship decoy (a ship decoy is not fired at a target)'
const NOT_STAGED = 'a missile with no second stage (the hit chance of a staged missile rests on its second stage, which this comparison does not follow)'
const STAGE_KNOWN = 'whether the missile has a second stage'

// A figure as a number: a finite number, or a numeric text as an input field gives it; anything else, blank or not a number is null.
export const entered = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  } else if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)

    return Number.isFinite(number) ? number : null
  }

  return null
}

const versionNotes = (rule, version) => (ruleSupports(rule, version) === true ? [] : [UNVERIFIED])

// The sentence a panel states when the save's game version is not shown to be one the rules were read for, or an empty text when it is; the same note every result of the rules carries among its assumptions.
export const versionLimit = (version) => versionNotes(HIT_RULES.raw, version)[0] || ''

// The multiplier a target's missile jammer puts on the hit chance: 1 for no jammer or one not above the ECCM, else 0.75 to the full jammer strength. Without a jammer the ECCM is not needed; with one it is, since it decides whether the jammer counts.
export const jammerMultiplier = ({ jammer, eccm, version = null }) => {
  const rule = HIT_RULES.jammer
  const strength = entered(jammer)

  if (strength === null || strength < 0) {
    return unavailable({ rule, missing: [JAMMER] })
  }

  const assumptions = [`a target missile jammer of ${strength}`, ...versionNotes(rule, version)]

  if (strength === 0) {
    return ofRule({ rule, value: 1, inputs: { present: [JAMMER] }, assumptions })
  }

  const resistance = entered(eccm)

  if (resistance === null || resistance < 0) {
    return unavailable({ rule, present: [JAMMER], missing: [ECCM], assumptions })
  }

  return ofRule({ rule, value: strength > resistance ? Math.pow(JAMMER_FACTOR, strength) : 1, inputs: { present: [JAMMER, ECCM] }, assumptions })
}

// The continuous hit chance in percent, not limited to 100. A missile speed that is not above 0 or a target speed that is not 0 or more has no chance; a stationary target (speed 0) is hit at 100 whatever the guidance, modifier and jammer, and those are then not needed.
export const rawHitChance = ({ missileSpeed, targetSpeed, atg, modifier = 1, jammer = 0, eccm = null, version = null }) => {
  const rule = HIT_RULES.raw
  const speed = entered(missileSpeed)
  const target = entered(targetSpeed)
  const missing = []

  if (speed === null || speed <= 0) {
    missing.push(MISSILE_SPEED)
  }

  if (target === null || target < 0) {
    missing.push(TARGET_SPEED)
  }

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  const assumptions = [`a target moving at ${target} km/s`, ...versionNotes(rule, version)]

  if (target === 0) {
    return ofRule({ rule, value: STATIONARY_CHANCE, inputs: { present: [MISSILE_SPEED, TARGET_SPEED] }, assumptions: [...assumptions, 'a stationary target, which the game always hits'] })
  }

  const guidance = entered(atg)
  const tactical = entered(modifier)
  const effect = jammerMultiplier({ jammer, eccm, version })

  if (guidance === null || guidance < 0) {
    missing.push(GUIDANCE)
  }

  if (tactical === null || tactical <= 0) {
    missing.push(MODIFIER)
  }

  if (missing.length) {
    return unavailable({ rule, present: [MISSILE_SPEED, TARGET_SPEED], missing: [...missing, ...effect.inputs.missing], assumptions })
  }

  return combine({
    rule,
    parts: { effect },
    compute: ({ effect: multiplier }) => (speed / target) * SPEED_SCALE * tactical * Math.max(guidance, 1) * multiplier,
    inputs: { present: [MISSILE_SPEED, TARGET_SPEED, GUIDANCE, MODIFIER] },
    assumptions: [...assumptions, `a tactical modifier of ${tactical}`],
  })
}

// The raw chance limited to 100, as a result of a raw chance result.
export const cappedHitChance = (raw) => combine({ rule: HIT_RULES.capped, parts: { raw }, compute: ({ raw: percent }) => Math.min(percent, HIT_CAP) })

// The chance one warhead has on a whole-number roll, in percent, from a capped chance result: rounded down, with a tolerance for the last binary digit of a product such as 50 x 1.4.
export const rollHitChance = (capped) => combine({ rule: HIT_RULES.roll, parts: { capped }, compute: ({ capped: percent }) => Math.floor(percent + ROLL_TOLERANCE) })

// The expected warhead hits of one missile from a chance result in percent (capped or whole-number): the warheads times the chance, each warhead rolling alone. Nothing for the missile being shot down is applied.
export const expectedWarheadHits = ({ chance, warheads }) => {
  const rule = HIT_RULES.hits
  const count = entered(warheads)

  if (count === null || !Number.isInteger(count) || count < 1) {
    return unavailable({ rule, present: chance.inputs.present, missing: [...chance.inputs.missing, WARHEADS], assumptions: chance.assumptions })
  }

  return combine({ rule, parts: { chance }, compute: ({ chance: percent }) => (count * percent) / 100, inputs: { present: [WARHEADS] } })
}

// A saved missile's figures as the scenario functions read them: `row` is a missile of the Designed Tech page (Speed, ATG, ECCM, MultipleWarheads, ShipDecoy, SecondStageID, NumSS). The stage fields are kept as stored: only a stored 0 for SecondStageID is a single-stage missile, and a missing one is not known.
export const savedMissile = (row) => ({ key: `missile-${row.MissileID}`, name: row.Name, kind: 'saved', speed: row.Speed, atg: row.ATG, eccm: row.ECCM, warheads: row.MultipleWarheads, shipDecoy: Boolean(row.ShipDecoy), obsolete: Boolean(row.Obsolete), secondStageId: entered(row.SecondStageID), secondStages: entered(row.NumSS) })

const isBlank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

// A proposed missile from the entered texts, or null while its speed is not entered: no figure of it is assumed.
export const proposedMissile = ({ speed, atg, eccm, warheads }) => (isBlank(speed) ? null : { key: 'proposed', name: 'Proposed missile', kind: 'proposed', speed, atg, eccm, warheads, shipDecoy: false, obsolete: false, secondStageId: 0, secondStages: 0 })

// What keeps a missile from being a terminal missile this comparison can judge: a ship decoy, a second stage (the chance of a staged missile rests on the stage that reaches the target, whose own speed, guidance, ECCM and warhead count the comparison does not follow) or a stage count that is not known. A single-stage missile has none.
const notComparable = (missile) => {
  const missing = []

  if (missile.shipDecoy) {
    missing.push(NOT_DECOY)
  }

  if (missile.secondStageId === null || missile.secondStageId === undefined) {
    missing.push(STAGE_KNOWN)
  } else if (missile.secondStageId > 0) {
    missing.push(NOT_STAGED)
  }

  return missing
}

// The results of one missile in one scenario: `effect` (the jammer multiplier), `raw`, `capped` and `roll` hit chances and the expected warhead hits on the capped chance (`hitsCapped`) and on the roll chance (`hitsRoll`). `stationary` is true when the target does not move, which no jammer or guidance affects. A ship decoy has no chance.
export const hitScenario = ({ missile, targetSpeed, jammer = 0, modifier = 1, version = null }) => {
  const effect = jammerMultiplier({ jammer, eccm: missile.eccm, version })
  const blocked = notComparable(missile)
  const raw = blocked.length ? unavailable({ rule: HIT_RULES.raw, missing: blocked }) : rawHitChance({ missileSpeed: missile.speed, targetSpeed, atg: missile.atg, modifier, jammer, eccm: missile.eccm, version })
  const capped = cappedHitChance(raw)
  const roll = rollHitChance(capped)

  return { stationary: entered(targetSpeed) === 0, effect, raw, capped, roll, hitsCapped: expectedWarheadHits({ chance: capped, warheads: missile.warheads }), hitsRoll: expectedWarheadHits({ chance: roll, warheads: missile.warheads }) }
}

// The target speed in km/s at which the raw chance is `chance` percent for the missile under a jammer and modifier; unavailable when the chance is not above 0 or any factor is missing.
export const targetSpeedForChance = ({ missile, chance, jammer = 0, modifier = 1, version = null }) => {
  const rule = HIT_RULES.targetSpeed
  const speed = entered(missile.speed)
  const guidance = entered(missile.atg)
  const tactical = entered(modifier)
  const percent = entered(chance)
  const effect = jammerMultiplier({ jammer, eccm: missile.eccm, version })
  const missing = notComparable(missile)

  if (speed === null || speed <= 0) {
    missing.push(MISSILE_SPEED)
  }

  if (guidance === null || guidance < 0) {
    missing.push(GUIDANCE)
  }

  if (tactical === null || tactical <= 0) {
    missing.push(MODIFIER)
  }

  if (percent === null || percent <= 0) {
    missing.push('a hit chance above 0')
  }

  if (missing.length) {
    return unavailable({ rule, missing: [...missing, ...effect.inputs.missing] })
  }

  return combine({ rule, parts: { effect }, compute: ({ effect: multiplier }) => (speed * SPEED_SCALE * tactical * Math.max(guidance, 1) * multiplier) / percent, inputs: { present: [MISSILE_SPEED, GUIDANCE, MODIFIER] }, assumptions: [`a tactical modifier of ${tactical}`, `a hit chance of ${percent}%`] })
}

export const TARGET_SPEEDS = Object.freeze([0, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000])

export const JAMMER_STRENGTHS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15])

// The steps of a curve with the entered value among them, in order, each once; a value that is not a number it leaves out.
const withEntered = (steps, value, minimum) => {
  const number = entered(value)

  return number !== null && number >= minimum && !steps.includes(number) ? [...steps, number].sort((a, b) => a - b) : [...steps]
}

// One missile across target speeds, each row `{ speed, current, ...hitScenario }`; `targetSpeed` is the scenario's own speed, added to the steps and marked current.
export const speedCurve = ({ missile, targetSpeed, jammer = 0, modifier = 1, version = null }) => withEntered(TARGET_SPEEDS, targetSpeed, 0).map((speed) => ({ speed, current: speed === entered(targetSpeed), ...hitScenario({ missile, targetSpeed: speed, jammer, modifier, version }) }))

// One missile across jammer strengths against one target speed, each row `{ jammer, current, ...hitScenario }`; the scenario's own jammer is added to the steps and marked current.
export const jammerCurve = ({ missile, targetSpeed, jammer = 0, modifier = 1, version = null }) => withEntered(JAMMER_STRENGTHS, jammer, 0).map((strength) => ({ jammer: strength, current: strength === entered(jammer), ...hitScenario({ missile, targetSpeed, jammer: strength, modifier, version }) }))

// The table of missiles under one scenario: one row per missile of `missiles` (savedMissile or proposedMissile), each `{ key, name, kind, obsolete, speed, atg, eccm, warheads (numbers, null when not known), ...hitScenario, rawValue, cappedValue, rollValue, hitsValue, hitsRollValue, effectValue }` so a table sorts on them, a missing figure null.
export const scenarioRows = ({ missiles, targetSpeed, jammer = 0, modifier = 1, version = null }) => missiles.map((missile) => {
  const scenario = hitScenario({ missile, targetSpeed, jammer, modifier, version })

  return {
    key: missile.key,
    name: missile.name,
    kind: missile.kind,
    obsolete: missile.obsolete,
    shipDecoy: missile.shipDecoy,
    secondStageId: missile.secondStageId,
    secondStages: missile.secondStages,
    speed: entered(missile.speed),
    atg: entered(missile.atg),
    eccm: entered(missile.eccm),
    warheads: entered(missile.warheads),
    ...scenario,
    effectValue: valueOrNull(scenario.effect),
    rawValue: valueOrNull(scenario.raw),
    cappedValue: valueOrNull(scenario.capped),
    rollValue: valueOrNull(scenario.roll),
    hitsValue: valueOrNull(scenario.hitsCapped),
    hitsRollValue: valueOrNull(scenario.hitsRoll),
  }
})
