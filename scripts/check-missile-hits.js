/*
  Checks the missile hit chance rules (src/renderer/utilities/missile-hit.js) that the Designed Tech page shows for missiles.

  node scripts/check-missile-hits.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>]

  The synthetic checks need no save. They prove: a 50,000 km/s missile with terminal guidance 1.4 and a tactical modifier of 1 against a 10,000 km/s target has 70% without jamming; a target jammer of 4 against an ECCM of 3 multiplies it by 0.75 to the whole jammer strength of 4 (not to the surplus of 1), an ECCM of 4 or more leaves it at 70, and a jammer of 0 needs no ECCM; a stationary target is hit at a capped 100 whatever the other factors; moving cases above 100 stay raw above 100 and cap at 100; the raw, capped and whole-number roll chances are separate figures; a zero, missing or invalid missile speed, a missing or negative target speed and a missing or non-positive modifier leave no value (never 0); terminal guidance under 1 counts as 1; the expected hits of a missile are its warheads times the chance of one warhead, with no survival probability, and are unavailable for a warhead count that is not a whole number of 1 or more; the curves, the scenario table and the target speed for a chance agree with the rule; every result names its registered rule, is never confirmed, and carries its assumptions. A table of random inputs is compared with a plain re-statement of the formula. Then every mutation of the module (a changed exponent, threshold, cap, factor, clamp, rounding or survival term) must fail at least one check.

  With a save (by default the repository's modded save, AuroraDB.db game 140 race 784, and the stock 2.7.1 save in saves/, game 138 race 785; one that is not there is reported as not run) it also reads the race's missile designs as the Designed Tech page does and compares the scenario table of each, at a grid of target speeds, jammers and modifiers, with the plain formula; a design with no speed, a ship decoy or a second stage must have no chance (the synthetic checks cover a staged design, which neither save has). Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

// What the page's utilities import from packages, as the capability check stubs them.
const PAGE_STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const close = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected))

// A repeatable pseudo-random sequence (a linear congruential generator), so a failure can be run again.
const generator = (seed) => {
  let state = seed

  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296

    return state / 4294967296
  }
}

// The formula as the notes state it, written out plainly and kept apart from the module: the raw chance in percent, or null when the inputs are not valid.
const reference = ({ speed, target, atg, modifier = 1, jammer = 0, eccm = 0 }) => {
  if (!(speed > 0) || !(target >= 0) || !(modifier > 0) || !(atg >= 0) || !(jammer >= 0) || !(eccm >= 0)) {
    return null
  }

  if (target === 0) {
    return 100
  }

  const multiplier = jammer > 0 && jammer - eccm > 0 ? 0.75 ** jammer : 1

  return (speed / target) * 10 * modifier * (atg < 1 ? 1 : atg) * multiplier
}

const referenceCap = (raw) => (raw === null ? null : Math.min(raw, 100))

const referenceRoll = (raw) => (raw === null ? null : Math.floor(Math.min(raw, 100) + 1e-9))

// The checks that need no save, over the modules `m` ({ hit, provenance }): [[name, () => true or a message]]. Run on the real module and again on each mutated copy, where one at least must fail.
const synthetic = ({ hit, provenance }) => {
  const all = []
  const add = (name, run) => all.push([name, run])
  const { rawHitChance, cappedHitChance, jammerMultiplier, expectedWarheadHits, hitScenario, targetSpeedForChance, speedCurve, jammerCurve, scenarioRows, savedMissile, proposedMissile, versionLimit, HIT_RULES } = hit
  const { valueOrNull, isAvailable, getRule } = provenance

  const arrow = { speed: 50000, atg: 1.4, eccm: 3, warheads: 1, secondStageId: 0 }
  const raw = (extra) => rawHitChance({ missileSpeed: 50000, targetSpeed: 10000, atg: 1.4, modifier: 1, jammer: 0, eccm: 3, ...extra })
  const scenario = (extra, missile = arrow) => hitScenario({ missile, targetSpeed: 10000, jammer: 0, modifier: 1, ...extra })
  const noValue = (result) => !isAvailable(result) && result.value === null

  add('50,000 km/s, guidance 1.4, modifier 1 against a 10,000 km/s target without jamming: raw 70', () => close(valueOrNull(raw()), 70) || `${valueOrNull(raw())}`)
  add('the same case, capped: 70, and on the whole-number roll: 70', () => {
    const scene = scenario()

    return close(valueOrNull(scene.capped), 70) && valueOrNull(scene.roll) === 70 ? true : `${valueOrNull(scene.capped)} ${valueOrNull(scene.roll)}`
  })
  add('the tactical modifier defaults to 1 and equals an explicit 1', () => close(valueOrNull(rawHitChance({ missileSpeed: 50000, targetSpeed: 10000, atg: 1.4 })), 70) && close(valueOrNull(raw({ modifier: 1 })), 70))
  add('a tactical modifier of 0.5 halves the chance: 35', () => close(valueOrNull(raw({ modifier: 0.5 })), 35))
  add('a tactical modifier of 0, negative or blank has no chance', () => [0, -1, null, '', 'abc'].every((modifier) => noValue(raw({ modifier }))))
  add('jammer 4 against ECCM 3: 70 x 0.75^4 on the whole jammer strength', () => close(valueOrNull(raw({ jammer: 4, eccm: 3 })), 70 * 0.75 ** 4) || `${valueOrNull(raw({ jammer: 4, eccm: 3 }))}`)
  add('jammer 4 against ECCM 3 is not 70 x 0.75 (the surplus over the ECCM)', () => !close(valueOrNull(raw({ jammer: 4, eccm: 3 })), 70 * 0.75))
  add('jammer 4 against ECCM 4: 70, the ECCM equal to the jammer removes the penalty', () => close(valueOrNull(raw({ jammer: 4, eccm: 4 })), 70))
  add('jammer 4 against ECCM 5 and 15: 70', () => close(valueOrNull(raw({ jammer: 4, eccm: 5 })), 70) && close(valueOrNull(raw({ jammer: 4, eccm: 15 })), 70))
  add('jammer 1 against ECCM 0: 70 x 0.75; one point of ECCM short costs the full penalty', () => close(valueOrNull(raw({ jammer: 1, eccm: 0 })), 70 * 0.75) && close(valueOrNull(raw({ jammer: 10, eccm: 9 })), 70 * 0.75 ** 10))
  add('the jammer effect alone: 1 at or under the ECCM, 0.75^jammer above it', () => close(valueOrNull(jammerMultiplier({ jammer: 3, eccm: 3 })), 1) && close(valueOrNull(jammerMultiplier({ jammer: 4, eccm: 3 })), 0.75 ** 4) && close(valueOrNull(jammerMultiplier({ jammer: 15, eccm: 0 })), 0.75 ** 15))
  add('jammer 0 needs no ECCM: the chance is 70 with the ECCM unknown', () => close(valueOrNull(raw({ jammer: 0, eccm: null })), 70) && close(valueOrNull(jammerMultiplier({ jammer: 0 })), 1))
  add('a jammer above 0 with the ECCM unknown has no chance, naming the ECCM', () => {
    const result = raw({ jammer: 2, eccm: null })

    return noValue(result) && result.inputs.missing.some((name) => name.includes('ECCM')) ? true : JSON.stringify(result.inputs)
  })
  add('a missing, negative or invalid jammer strength has no chance', () => [null, '', 'x', -1].every((jammer) => noValue(raw({ jammer })) && noValue(jammerMultiplier({ jammer, eccm: 3 }))))
  add('a stationary target is hit at a capped 100: raw 100, capped 100, roll 100', () => {
    const scene = scenario({ targetSpeed: 0 })

    return valueOrNull(scene.raw) === 100 && valueOrNull(scene.capped) === 100 && valueOrNull(scene.roll) === 100 && scene.stationary ? true : `${valueOrNull(scene.raw)} ${valueOrNull(scene.capped)} ${valueOrNull(scene.roll)}`
  })
  add('a stationary target is hit at 100 whatever the jammer, the modifier and the guidance', () => {
    const scene = hitScenario({ missile: { speed: 1000, atg: null, eccm: null, warheads: 1, secondStageId: 0 }, targetSpeed: 0, jammer: 15, modifier: 0.1 })

    return valueOrNull(scene.raw) === 100 && valueOrNull(scene.capped) === 100
  })
  add('a stationary target of text 0 is stationary, a missing target speed is not', () => valueOrNull(raw({ targetSpeed: '0' })) === 100 && [null, undefined, '', 'abc', NaN, Infinity, -1].every((targetSpeed) => noValue(raw({ targetSpeed }))))
  add('a moving target the missile outruns: raw above 100, capped 100, roll 100', () => {
    const scene = scenario({ targetSpeed: 5000 })

    return close(valueOrNull(scene.raw), 140) && valueOrNull(scene.capped) === 100 && valueOrNull(scene.roll) === 100 ? true : `${valueOrNull(scene.raw)} ${valueOrNull(scene.capped)}`
  })
  add('a raw chance of exactly 100 caps to 100; just above caps to 100; just below stays', () => {
    const at = (target) => hitScenario({ missile: { speed: 1000, atg: 1, eccm: 0, warheads: 1, secondStageId: 0 }, targetSpeed: target })

    return close(valueOrNull(at(100).raw), 100) && valueOrNull(at(100).capped) === 100 && valueOrNull(at(99).capped) === 100 && close(valueOrNull(at(101).capped), (1000 / 101) * 10) && valueOrNull(at(99).raw) > 100
  })
  add('the raw, capped and roll chances are three figures of three rules', () => {
    const scene = scenario({ targetSpeed: 5000 })
    const ids = [scene.raw, scene.capped, scene.roll].map((result) => result.rule.id)

    return new Set(ids).size === 3 && ids[0] === HIT_RULES.raw && ids[1] === HIT_RULES.capped && ids[2] === HIT_RULES.roll && valueOrNull(scene.raw) !== valueOrNull(scene.capped)
  })
  add('the whole-number roll rounds down, never up: 5.555 reads 5, 22.148 reads 22', () => {
    const slow = hitScenario({ missile: { speed: 5555, atg: 1, eccm: 0, warheads: 1, secondStageId: 0 }, targetSpeed: 10000 })
    const jammed = scenario({ jammer: 4, eccm: 3 })

    return valueOrNull(slow.roll) === 5 && valueOrNull(jammed.roll) === 22 ? true : `${valueOrNull(slow.roll)} ${valueOrNull(jammed.roll)}`
  })
  add('the whole-number roll survives the last binary digit: 4,500 km/s, guidance 1.4, 1,000 km/s target is 63 (62.99999999999999 raw)', () => {
    const scene = hitScenario({ missile: { speed: 4500, atg: 1.4, eccm: 0, warheads: 1, secondStageId: 0 }, targetSpeed: 1000 })

    return valueOrNull(scene.roll) === 63 ? true : `${valueOrNull(scene.raw)} -> ${valueOrNull(scene.roll)}`
  })
  add('a chance under 1 is a real 0 on the roll, not a missing figure', () => {
    const scene = hitScenario({ missile: { speed: 1000, atg: 1, eccm: 0, warheads: 1, secondStageId: 0 }, targetSpeed: 100000 })

    return isAvailable(scene.roll) && scene.roll.value === 0 && close(valueOrNull(scene.raw), 0.1)
  })
  add('terminal guidance under 1 counts as 1; 1.4 is 40% more than 1', () => close(valueOrNull(raw({ atg: 0.5 })), 50) && close(valueOrNull(raw({ atg: 0 })), 50) && close(valueOrNull(raw({ atg: 1 })), 50) && close(valueOrNull(raw({ atg: 1.9 })), 95))
  add('missing or negative terminal guidance has no chance', () => [null, '', 'x', -0.5].every((atg) => noValue(raw({ atg }))))
  add('a missile speed of 0, missing, negative or invalid has no chance, never 0', () => [0, '0', null, undefined, '', 'abc', NaN, Infinity, -5].every((missileSpeed) => noValue(raw({ missileSpeed }))))
  add('a missile with no speed has no chance even against a stationary target', () => noValue(raw({ missileSpeed: 0, targetSpeed: 0 })) && noValue(raw({ missileSpeed: null, targetSpeed: 0 })))
  add('the missing inputs are named', () => {
    const result = raw({ missileSpeed: 0, targetSpeed: null })

    return result.inputs.missing.length === 2 && result.inputs.missing.some((name) => name.includes('missile speed')) && result.inputs.missing.some((name) => name.includes('target speed')) ? true : JSON.stringify(result.inputs)
  })
  add('an unavailable raw chance leaves the capped, roll and hit figures unavailable, not 0', () => {
    const scene = scenario({ targetSpeed: null })

    return [scene.raw, scene.capped, scene.roll, scene.hitsCapped, scene.hitsRoll].every(noValue)
  })
  add('a ship decoy has no hit chance', () => {
    const scene = hitScenario({ missile: { ...arrow, shipDecoy: true }, targetSpeed: 10000 })

    return noValue(scene.raw) && noValue(scene.capped) && noValue(scene.hitsCapped)
  })
  add('a saved missile with no speed has no chance in the table, the others have', () => {
    const rows = scenarioRows({ missiles: [savedMissile({ MissileID: 1, Name: 'Buoy', Speed: 0, ATG: 1, ECCM: 0, MultipleWarheads: 1, ShipDecoy: 0, SecondStageID: 0, NumSS: 0 }), savedMissile({ MissileID: 2, Name: 'Arrow', Speed: 50000, ATG: 1.4, ECCM: 3, MultipleWarheads: 1, ShipDecoy: 0, SecondStageID: 0, NumSS: 0 })], targetSpeed: 10000 })

    return rows[0].rawValue === null && rows[0].cappedValue === null && rows[0].hitsValue === null && close(rows[1].rawValue, 70) && rows[1].cappedValue === 70 ? true : JSON.stringify(rows.map((row) => [row.rawValue, row.cappedValue]))
  })
  add('a missile with a second stage has no hit chance, naming the stage, in every figure of it', () => {
    const staged = savedMissile({ MissileID: 5, Name: 'Carrier', Speed: 50000, ATG: 1.4, ECCM: 3, MultipleWarheads: 1, ShipDecoy: 0, SecondStageID: 7, NumSS: 3 })
    const [row] = scenarioRows({ missiles: [staged], targetSpeed: 10000 })
    const scene = hitScenario({ missile: staged, targetSpeed: 10000 })
    const stationary = hitScenario({ missile: staged, targetSpeed: 0 })
    const named = scene.raw.inputs.missing.some((text) => /second stage/.test(text)) && /does not follow/.test(scene.raw.inputs.missing.join(' '))

    return staged.secondStageId === 7 && staged.secondStages === 3 && named && noValue(scene.raw) && noValue(scene.capped) && noValue(scene.roll) && noValue(scene.hitsCapped) && noValue(scene.hitsRoll) && noValue(stationary.raw) && row.rawValue === null && row.cappedValue === null && row.hitsValue === null && row.secondStageId === 7 && row.secondStages === 3 && noValue(targetSpeedForChance({ missile: staged, chance: 50 })) && speedCurve({ missile: staged, targetSpeed: 10000 }).every((step) => noValue(step.raw)) && jammerCurve({ missile: staged, targetSpeed: 10000, jammer: 2 }).every((step) => noValue(step.raw)) ? true : JSON.stringify(row)
  })
  add('a missile whose stage is not stored is not known to be single-stage; a stored 0 is', () => {
    const unknown = savedMissile({ MissileID: 6, Name: 'Unlisted', Speed: 50000, ATG: 1.4, ECCM: 3, MultipleWarheads: 1, ShipDecoy: 0 })
    const none = savedMissile({ MissileID: 7, Name: 'Plain', Speed: 50000, ATG: 1.4, ECCM: 3, MultipleWarheads: 1, ShipDecoy: 0, SecondStageID: 0, NumSS: 0 })
    const scene = hitScenario({ missile: unknown, targetSpeed: 10000 })

    return unknown.secondStageId === null && noValue(scene.raw) && scene.raw.inputs.missing.some((text) => /whether the missile has a second stage/.test(text)) && noValue(hitScenario({ missile: { ...unknown, secondStageId: undefined }, targetSpeed: 10000 }).raw) && close(valueOrNull(hitScenario({ missile: none, targetSpeed: 10000 }).raw), 70) && none.secondStageId === 0
  })
  add('a proposed missile has a single stage, and its chance is available', () => proposedMissile({ speed: '50000', atg: '1.4', eccm: '3', warheads: '1' }).secondStageId === 0 && close(valueOrNull(hitScenario({ missile: proposedMissile({ speed: '50000', atg: '1.4', eccm: '3', warheads: '1' }), targetSpeed: 10000 }).raw), 70))
  add('the version limit is stated for a save not shown to be 2.7 and not for a 2.7.1 save, in the words every result carries', () => {
    const limit = versionLimit(null)
    const carried = scenario({ version: null }).capped.assumptions.includes(limit)

    return /not shown to be a 2.7 save/.test(limit) && carried && versionLimit('2.7.1') === '' && versionLimit('2.7') === '' && versionLimit('2.6') !== ''
  })
  add('multi-warhead: 4 warheads at 70% expect 2.8 hits, each warhead rolling alone', () => {
    const scene = scenario({}, { ...arrow, warheads: 4 })

    return close(valueOrNull(scene.hitsCapped), 2.8) && close(valueOrNull(scene.hitsRoll), 2.8) ? true : `${valueOrNull(scene.hitsCapped)} ${valueOrNull(scene.hitsRoll)}`
  })
  add('multi-warhead with jamming: 4 warheads at 22.148% on the capped chance, 22% on the roll', () => {
    const scene = scenario({ jammer: 4 }, { ...arrow, warheads: 4 })

    return close(valueOrNull(scene.hitsCapped), (4 * 70 * 0.75 ** 4) / 100) && close(valueOrNull(scene.hitsRoll), 0.88) ? true : `${valueOrNull(scene.hitsCapped)} ${valueOrNull(scene.hitsRoll)}`
  })
  add('one warhead at the cap hits once; four at the cap hit four times', () => {
    const one = scenario({ targetSpeed: 0 })
    const four = scenario({ targetSpeed: 0 }, { ...arrow, warheads: 4 })

    return valueOrNull(one.hitsCapped) === 1 && valueOrNull(four.hitsCapped) === 4
  })
  add('the expected hits state the independent warhead assumption and no survival', () => {
    const scene = scenario({}, { ...arrow, warheads: 4 })
    const text = scene.hitsCapped.assumptions.join(' | ')

    return /independently/.test(text) && /shot down/.test(text) && scene.hitsCapped.rule.id === HIT_RULES.hits && getRule(HIT_RULES.hits).assumptions.length >= 2 ? true : text
  })
  add('the expected hits take no survival probability: an extra argument changes nothing', () => {
    const chance = cappedHitChance(raw())

    return close(valueOrNull(expectedWarheadHits({ chance, warheads: 4, survival: 0.5, survivalChance: 0.5 })), 2.8)
  })
  add('a warhead count that is 0, fractional, negative or missing leaves the hits unavailable but the chance available', () => [0, 1.5, -1, null, '', 'x'].every((warheads) => {
    const scene = scenario({}, { ...arrow, warheads })

    return noValue(scene.hitsCapped) && noValue(scene.hitsRoll) && isAvailable(scene.capped)
  }))
  add('a warhead count as text is read', () => close(valueOrNull(scenario({}, { ...arrow, warheads: '2' }).hitsCapped), 1.4))
  add('the hits on the whole-number roll are worked from the roll chance, the other from the capped chance', () => {
    const scene = hitScenario({ missile: { speed: 5555, atg: 1, eccm: 0, warheads: 3, secondStageId: 0 }, targetSpeed: 10000 })

    return close(valueOrNull(scene.hitsCapped), (3 * 5.555) / 100) && close(valueOrNull(scene.hitsRoll), 0.15) ? true : `${valueOrNull(scene.hitsCapped)} ${valueOrNull(scene.hitsRoll)}`
  })
  add('the target speed for 50% is speed x 10 x guidance / 50: 14,000 for a 50,000 km/s missile with guidance 1.4; for 100% 7,000', () => close(valueOrNull(targetSpeedForChance({ missile: arrow, chance: 50 })), 14000) && close(valueOrNull(targetSpeedForChance({ missile: arrow, chance: 100 })), 7000))
  add('the raw chance at the target speed for a chance is that chance, under a jammer and a modifier too', () => [[50, 0, 1], [100, 4, 0.9], [25, 2, 1.2], [70, 3, 1]].every(([chance, jammer, modifier]) => {
    const speed = valueOrNull(targetSpeedForChance({ missile: { ...arrow, eccm: 1 }, chance, jammer, modifier }))

    return speed !== null && close(valueOrNull(rawHitChance({ missileSpeed: 50000, targetSpeed: speed, atg: 1.4, modifier, jammer, eccm: 1 })), chance)
  }))
  add('the target speed for a chance has no value for a chance of 0 or less, a missing speed or guidance', () => [0, -5, null].every((chance) => noValue(targetSpeedForChance({ missile: arrow, chance }))) && noValue(targetSpeedForChance({ missile: { ...arrow, speed: 0 }, chance: 50 })) && noValue(targetSpeedForChance({ missile: { ...arrow, atg: null }, chance: 50 })))
  add('the target speed for a chance has the tactical modifier and the jammer in it', () => close(valueOrNull(targetSpeedForChance({ missile: arrow, chance: 50, modifier: 0.5 })), 7000) && close(valueOrNull(targetSpeedForChance({ missile: arrow, chance: 50, jammer: 4 })), 14000 * 0.75 ** 4))
  add('the target speed for a chance counts terminal guidance under 1 as 1', () => close(valueOrNull(targetSpeedForChance({ missile: { ...arrow, atg: 0.5 }, chance: 50 })), 10000) && close(valueOrNull(targetSpeedForChance({ missile: { ...arrow, atg: 1 }, chance: 50 })), 10000))
  add('the speed curve is in order with the entered speed among the steps once, marked, and the cap holds', () => {
    const rows = speedCurve({ missile: arrow, targetSpeed: 25000 })
    const speeds = rows.map((row) => row.speed)

    return speeds.every((speed, index) => index === 0 || speed > speeds[index - 1]) && rows.filter((row) => row.current).length === 1 && rows.find((row) => row.current).speed === 25000 && rows.every((row) => valueOrNull(row.capped) <= 100) && valueOrNull(rows[0].capped) === 100 ? true : speeds.join()
  })
  add('the speed curve does not add an entered speed that is already a step, nor an invalid one', () => speedCurve({ missile: arrow, targetSpeed: 10000 }).length === speedCurve({ missile: arrow, targetSpeed: 'x' }).length && speedCurve({ missile: arrow, targetSpeed: 'x' }).every((row) => !row.current))
  add('the capped chance never rises with the target speed', () => {
    const rows = speedCurve({ missile: arrow, targetSpeed: 10000, jammer: 2 })

    return rows.every((row, index) => index === 0 || valueOrNull(row.capped) <= valueOrNull(rows[index - 1].capped))
  })
  add('the jammer curve: no penalty up to the ECCM, 0.75^jammer above it, the entered jammer marked once', () => {
    const rows = jammerCurve({ missile: arrow, targetSpeed: 10000, jammer: 6 })

    return rows.every((row) => (row.jammer <= 3 ? close(valueOrNull(row.raw), 70) : close(valueOrNull(row.raw), 70 * 0.75 ** row.jammer))) && rows.filter((row) => row.current).length === 1 && rows.find((row) => row.current).jammer === 6 ? true : rows.map((row) => `${row.jammer}:${valueOrNull(row.raw)}`).join(' ')
  })
  add('the jammer curve steps are in order with the entered jammer among them', () => {
    const rows = jammerCurve({ missile: arrow, targetSpeed: 10000, jammer: 12 })
    const strengths = rows.map((row) => row.jammer)

    return strengths.every((strength, index) => index === 0 || strength > strengths[index - 1]) && strengths.includes(12)
  })
  add('a proposed missile is none until its speed is entered, then it is a missile that is not a ship decoy', () => proposedMissile({ speed: '', atg: '1', eccm: '0', warheads: '1' }) === null && proposedMissile({ speed: '  ', atg: '1' }) === null && proposedMissile({ speed: '50000', atg: '1.4', eccm: '3', warheads: '1' }).shipDecoy === false && close(valueOrNull(hitScenario({ missile: proposedMissile({ speed: '50000', atg: '1.4', eccm: '3', warheads: '1' }), targetSpeed: '10000', jammer: '0', modifier: '1' }).raw), 70))
  add('a proposed missile with text that is not a number is kept, with no chance', () => {
    const missile = proposedMissile({ speed: 'abc', atg: '1', eccm: '0', warheads: '1' })

    return missile !== null && noValue(hitScenario({ missile, targetSpeed: 10000 }).raw)
  })
  add('the scenario table row carries the numbers a table sorts on, a missing figure null', () => {
    const [row] = scenarioRows({ missiles: [savedMissile({ MissileID: 9, Name: 'Test', Speed: 50000, ATG: 1.4, ECCM: 3, MultipleWarheads: 4, ShipDecoy: 0, Obsolete: 1, SecondStageID: 0, NumSS: 0 })], targetSpeed: 10000, jammer: 4, modifier: 1 })

    return row.key === 'missile-9' && row.kind === 'saved' && row.obsolete === true && row.speed === 50000 && row.atg === 1.4 && row.eccm === 3 && row.warheads === 4 && close(row.effectValue, 0.75 ** 4) && close(row.rawValue, 70 * 0.75 ** 4) && close(row.cappedValue, row.rawValue) && row.rollValue === 22 && close(row.hitsValue, (4 * row.cappedValue) / 100) && close(row.hitsRollValue, 0.88) ? true : JSON.stringify(row)
  })
  add('every result names its registered rule, is never confirmed, and carries the tactical modifier among its assumptions', () => {
    const scene = scenario({ jammer: 4 }, { ...arrow, warheads: 2 })
    const results = [scene.effect, scene.raw, scene.capped, scene.roll, scene.hitsCapped, scene.hitsRoll]

    return results.every((result) => Boolean(getRule(result.rule.id)) && result.status !== 'confirmed' && result.status !== 'unavailable') && scene.raw.assumptions.some((text) => text.includes('tactical modifier of 1')) && scene.capped.assumptions.some((text) => text.includes('tactical modifier of 1')) ? true : results.map((result) => result.status).join()
  })
  add('the raw rule states the tactical modifier default among its standing assumptions', () => getRule(HIT_RULES.raw).assumptions.some((text) => /modifier/.test(text) && /1/.test(text)))
  add('the roll rule states the whole-number die assumption and that the game\'s rounding is not settled', () => getRule(HIT_RULES.roll).assumptions.some((text) => /whole number from 1 to 100/.test(text)) && /not settled/.test(getRule(HIT_RULES.roll).note))
  add('the expected hits rule is a planner assumption, not a game rule, and says it is not penetration or survival', () => getRule(HIT_RULES.hits).verification === 'assumed' && /not a count of penetrating damage/.test(getRule(HIT_RULES.hits).note) && /point defence/.test(getRule(HIT_RULES.hits).note))
  add('the rules hold for 2.7; a save of no known version adds the unverified assumption, a 2.7.1 save does not', () => {
    const unknown = raw({ version: null })
    const stock = raw({ version: '2.7.1' })
    const other = raw({ version: '2.6.0' })
    const text = (result) => result.assumptions.join(' | ')

    return /not shown to be a 2.7 save/.test(text(unknown)) && !/not shown to be a 2.7 save/.test(text(stock)) && /not shown to be a 2.7 save/.test(text(other)) && close(unknown.value, stock.value) ? true : `${text(unknown)} / ${text(stock)}`
  })
  add('the version note reaches the capped and expected hit results', () => {
    const scene = scenario({ version: null }, { ...arrow, warheads: 2 })
    const stock = scenario({ version: '2.7.1' }, { ...arrow, warheads: 2 })

    return [scene.capped, scene.roll, scene.hitsCapped].every((result) => result.assumptions.some((text) => /not shown to be a 2.7 save/.test(text))) && [stock.capped, stock.roll, stock.hitsCapped].every((result) => !result.assumptions.some((text) => /not shown to be a 2.7 save/.test(text)))
  })
  add('2000 random cases: the raw, capped and whole-number roll chances equal the plain formula', () => {
    const next = generator(20260622)
    const pick = (list) => list[Math.floor(next() * list.length)]
    let wrong = ''

    for (let index = 0; index < 2000 && !wrong; index++) {
      const input = { speed: pick([1000, 2400, 5400, 24500, 50000, 75000, 240000]) * (0.5 + next()), target: pick([0, 500, 1000, 2500, 4500, 10000, 30000]) * (0.5 + next()), atg: pick([0.5, 1, 1.15, 1.2, 1.32, 1.4, 1.9]), modifier: pick([0.5, 0.8, 1, 1.1, 1.5]), jammer: pick([0, 0, 1, 2, 4, 6, 10, 15]), eccm: pick([0, 1, 3, 4, 6, 15]) }

      if (next() < 0.1) {
        input.target = 0
      }

      const scene = hitScenario({ missile: { speed: input.speed, atg: input.atg, eccm: input.eccm, warheads: 1, secondStageId: 0 }, targetSpeed: input.target, jammer: input.jammer, modifier: input.modifier })
      const expected = reference(input)

      if (!close(valueOrNull(scene.raw), expected) || !close(valueOrNull(scene.capped), referenceCap(expected)) || valueOrNull(scene.roll) !== referenceRoll(expected)) {
        wrong = JSON.stringify({ input, raw: valueOrNull(scene.raw), expected })
      }
    }

    return wrong || true
  })
  add('2000 random cases: the expected hits are the warheads times the chance, no other factor', () => {
    const next = generator(7)
    let wrong = ''

    for (let index = 0; index < 2000 && !wrong; index++) {
      const warheads = 1 + Math.floor(next() * 8)
      const missile = { speed: 1000 + next() * 90000, atg: 1 + next(), eccm: Math.floor(next() * 6), warheads, secondStageId: 0 }
      const scene = hitScenario({ missile, targetSpeed: 500 + next() * 40000, jammer: Math.floor(next() * 8), modifier: 0.5 + next() })

      if (!close(valueOrNull(scene.hitsCapped), (warheads * valueOrNull(scene.capped)) / 100) || !close(valueOrNull(scene.hitsRoll), (warheads * valueOrNull(scene.roll)) / 100)) {
        wrong = JSON.stringify({ missile, capped: valueOrNull(scene.capped), hits: valueOrNull(scene.hitsCapped) })
      }
    }

    return wrong || true
  })

  return all
}

// A copy of the utilities folder in the temp folder in which `file` has the `nth` occurrence (from 0) of `from` replaced by `to`.
const mutatedCopy = (file, from, to, nth = 0) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-missile-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')
  let at = -1

  for (let index = 0; index <= nth; index++) {
    at = source.indexOf(from, at + 1)

    if (at < 0) {
      throw new Error(`The mutation of ${file} does not apply (occurrence ${nth}): ${from}`)
    }
  }

  fs.writeFileSync(target, source.slice(0, at) + to + source.slice(at + from.length))

  return directory
}

const FILE = 'missile-hit.js'

const MUTATIONS = [
  ['the jammer exponent is the surplus over the ECCM instead of the whole strength', 'Math.pow(JAMMER_FACTOR, strength)', 'Math.pow(JAMMER_FACTOR, strength - resistance)'],
  ['a jammer equal to the ECCM still counts', 'strength > resistance ? Math.pow', 'strength >= resistance ? Math.pow'],
  ['a jammer under the ECCM counts', 'strength > resistance ? Math.pow', 'true ? Math.pow'],
  ['the jammer factor changed from 0.75', 'JAMMER_FACTOR = 0.75', 'JAMMER_FACTOR = 0.8'],
  ['the cap removed', 'Math.min(percent, HIT_CAP)', 'percent'],
  ['the cap changed from 100', 'HIT_CAP = 100', 'HIT_CAP = 99'],
  ['the stationary chance changed from 100', 'STATIONARY_CHANCE = 100', 'STATIONARY_CHANCE = 90'],
  ['the stationary shortcut removed', 'if (target === 0) {', 'if (false) {'],
  ['the speed factor of 10 changed', 'SPEED_SCALE = 10', 'SPEED_SCALE = 1'],
  ['terminal guidance under 1 not clamped to 1 in the chance', 'tactical * Math.max(guidance, 1) * multiplier', 'tactical * guidance * multiplier'],
  ['the tactical modifier left out of the chance', '* SPEED_SCALE * tactical * Math.max(guidance, 1) * multiplier,', '* SPEED_SCALE * Math.max(guidance, 1) * multiplier,'],
  ['a zero missile speed accepted', 'speed === null || speed <= 0', 'speed === null || speed < 0'],
  ['a negative target speed accepted', 'target === null || target < 0', 'target === null'],
  ['a missing target speed read as stationary', 'target === null || target < 0', 'target < 0'],
  ['an unknown ECCM read as no ECCM when a jammer is present', 'resistance === null || resistance < 0', 'resistance < 0'],
  ['a jammer of 0 asks for the ECCM', 'if (strength === 0) {', 'if (false) {'],
  ['a negative jammer accepted', 'strength === null || strength < 0', 'strength === null'],
  ['a zero tactical modifier accepted', 'tactical === null || tactical <= 0', 'tactical === null'],
  ['the whole-number roll rounds to nearest', 'Math.floor(percent + ROLL_TOLERANCE)', 'Math.round(percent)'],
  ['the whole-number roll loses the tolerance for the last binary digit', 'Math.floor(percent + ROLL_TOLERANCE)', 'Math.floor(percent)'],
  ['a survival probability multiplied into the expected hits', '(count * percent) / 100', '(count * percent) / 100 * 0.9'],
  ['the warheads left out of the expected hits', '(count * percent) / 100', 'percent / 100'],
  ['a fractional warhead count accepted', '!Number.isInteger(count) || ', ''],
  ['a warhead count of 0 accepted', 'count < 1', 'count < 0'],
  ['the roll expected hits worked from the capped chance', 'hitsRoll: expectedWarheadHits({ chance: roll,', 'hitsRoll: expectedWarheadHits({ chance: capped,'],
  ['a ship decoy given a chance', 'if (missile.shipDecoy) {', 'if (false) {'],
  ['the version note never added', 'ruleSupports(rule, version) === true ? [] : [UNVERIFIED]', '[]'],
  ['the curve steps not kept in order', '.sort((a, b) => a - b)', '.sort()'],
  ['the entered curve value added twice', '!steps.includes(number) ? [...steps, number]', 'true ? [...steps, number]'],
  ['a missing figure of the table row read as 0', 'rawValue: valueOrNull(scenario.raw),', 'rawValue: valueOrNull(scenario.raw) || 0,'],
  ['a proposed missile with no speed still a missile', 'isBlank(speed) ? null', 'false ? null'],
  ['the target speed for a chance leaves out the tactical modifier', 'tactical * Math.max(guidance, 1) * multiplier) / percent', 'Math.max(guidance, 1) * multiplier) / percent'],
  ['the target speed for a chance without the clamp on guidance', 'tactical * Math.max(guidance, 1) * multiplier) / percent', 'tactical * guidance * multiplier) / percent'],
  ['the target speed for a chance accepts a chance of 0', 'percent === null || percent <= 0', 'percent === null'],
  ['the capped chance is read from a different rule', 'rule: HIT_RULES.capped, parts', 'rule: HIT_RULES.raw, parts'],
  ['the expected hits rule verified as confirmed', "verification: 'assumed',\n  structure: ['FCT_MissileType.MultipleWarheads'", "verification: 'confirmed',\n  structure: ['FCT_MissileType.MultipleWarheads'"],
  ['a staged missile treated as a terminal missile', 'else if (missile.secondStageId > 0) {', 'else if (false) {'],
  ['an unknown stage read as single-stage', 'if (missile.secondStageId === null || missile.secondStageId === undefined) {', 'if (false) {'],
  ['the stage fields dropped from a saved missile', 'secondStageId: entered(row.SecondStageID), secondStages: entered(row.NumSS) })', 'secondStageId: 0, secondStages: 0 })'],
  ['the version limit never stated', "versionNotes(HIT_RULES.raw, version)[0] || ''", "''"],
]

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], part: null }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--part') {
      options.part = argv[++index]
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const allRows = (raw, sql, replacements) => new Promise((resolve, reject) => {
  raw.all(sql, replacements, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({
      query: (sql, replacements = []) => allRows(raw, sql, replacements),
      close: () => raw.close(),
    })
  })
})

// The race's missile designs as the Designed Tech page reads them.
const MISSILE_SQL = 'select FCT_MissileType.MissileID, FCT_MissileType.Name, FCT_RaceTech.Obsolete, FCT_MissileType.Speed, FCT_MissileType.WarheadStrength, FCT_MissileType.MultipleWarheads, FCT_MissileType.ShipDecoy, FCT_MissileType.ECCM, FCT_MissileType.ATG, FCT_MissileType.SecondStageID, FCT_MissileType.NumSS from FCT_RaceTech inner join FCT_MissileType on FCT_MissileType.MissileID = FCT_RaceTech.TechID and FCT_MissileType.GameID = FCT_RaceTech.GameID inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID and FCT_TechSystem.RaceID = FCT_RaceTech.RaceID where FCT_RaceTech.GameID = ? and FCT_RaceTech.RaceID = ?'

const GRID = { targets: [0, 500, 1000, 2500, 5000, 10000, 25000, 60000], jammers: [0, 1, 3, 4, 10, 15], modifiers: [0.5, 1, 1.25] }

// A design of the race the comparison gives no chance: a speed that is not above 0, a ship decoy, or a second stage (a stored 0 is the only single-stage design).
const hasNoChance = (row) => !(row.Speed > 0) || row.ShipDecoy === 1 || row.SecondStageID !== 0

const compareSave = async (label, [file, GameID, RaceID], { hit, provenance }) => {
  console.log(`\n${label} save: ${file} (game ${GameID}, race ${RaceID})`)

  const database = await openSave(file)

  if (!database) {
    console.log(`SKIP  ${file} is not there`)

    return
  }

  const rows = await database.query(MISSILE_SQL, [GameID, RaceID])
  const { valueOrNull } = provenance
  const noChance = rows.filter(hasNoChance)
  let compared = 0
  let wrong = ''

  check(`${label}: the race has missile designs to read`, rows.length > 0, `${rows.length} designs`)

  for (const row of rows) {
    for (const target of GRID.targets) {
      for (const jammer of GRID.jammers) {
        for (const modifier of GRID.modifiers) {
          const [entry] = hit.scenarioRows({ missiles: [hit.savedMissile(row)], targetSpeed: target, jammer, modifier })
          const none = hasNoChance(row)
          const expected = none ? null : reference({ speed: row.Speed, target, atg: row.ATG, modifier, jammer, eccm: row.ECCM })

          compared++

          const sameChance = expected === null ? entry.rawValue === null && entry.cappedValue === null && entry.rollValue === null && entry.hitsValue === null : close(entry.rawValue, expected) && close(entry.cappedValue, referenceCap(expected)) && entry.rollValue === referenceRoll(expected)
          const sameHits = expected === null || (row.MultipleWarheads >= 1 ? close(entry.hitsValue, (row.MultipleWarheads * referenceCap(expected)) / 100) && close(entry.hitsRollValue, (row.MultipleWarheads * referenceRoll(expected)) / 100) : entry.hitsValue === null)

          if (!wrong && !(sameChance && sameHits)) {
            wrong = `${row.Name} target ${target} jammer ${jammer} modifier ${modifier}: ${entry.rawValue} vs ${expected}`
          }
        }
      }
    }
  }

  check(`${label}: every design's scenario equals the plain formula over ${GRID.targets.length} target speeds, ${GRID.jammers.length} jammers and ${GRID.modifiers.length} modifiers`, wrong || true, `${rows.length} designs, ${compared} scenarios`)
  check(`${label}: a design with no speed, a ship decoy or a second stage has no chance (${noChance.length} such of ${rows.length}, ${rows.filter((row) => row.SecondStageID !== 0).length} staged)`, rows.every((row) => {
    const [entry] = hit.scenarioRows({ missiles: [hit.savedMissile(row)], targetSpeed: 10000 })

    return !noChance.includes(row) || (entry.rawValue === null && entry.cappedValue === null && valueOrNull(entry.raw) === null)
  }))
  check(`${label}: a single-stage design with a speed has a capped chance against a stationary target of 100`, rows.filter((row) => !hasNoChance(row)).every((row) => hit.scenarioRows({ missiles: [hit.savedMissile(row)], targetSpeed: 0, jammer: 15, modifier: 0.5 })[0].cappedValue === 100))

  for (const row of rows.filter((candidate) => !hasNoChance(candidate)).slice(0, 3)) {
    const [entry] = hit.scenarioRows({ missiles: [hit.savedMissile(row)], targetSpeed: 10000 })

    console.log(`  ${row.Name}: speed ${row.Speed}, guidance ${row.ATG}, ECCM ${row.ECCM}, ${row.MultipleWarheads} warhead(s); against 10,000 km/s: raw ${entry.rawValue}, capped ${entry.cappedValue}, whole-number roll ${entry.rollValue}, expected hits ${entry.hitsValue}`)
  }

  database.close()
}

// The page's script run on a pseudo instance over a race with no missile design, with only one, and with no design at all: the Missile category stays offered with nothing saved, because its hit chance panel takes a missile typed in.
const pageStatements = async (mutate) => {
  const options = await loadPage('pages/designed-tech', { stubs: PAGE_STUBS, mutate })
  const categories = [{ CategoryID: 2, Name: 'Beam' }, { CategoryID: 4, Name: 'Missile' }, { CategoryID: 47, Name: 'Species' }]
  const beam = { SDComponentID: 1, Name: 'Laser', CategoryID: 2, Obsolete: false }
  const arrow = { SDComponentID: 'missile-1', MissileID: 1, Name: 'Arrow', CategoryID: 4, Obsolete: false }
  const page = (data) => instantiate(options, { $store: { getters: {}, state: {} }, database: {}, GameID: 1, RaceID: 2, data: { categories, components: [], missiles: [], species: [], classUsage: [], ...data } })
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const ids = (vm) => vm.categoryOptions.map((option) => `${option.CategoryID}:${option.count}`).join()

  const nothing = page({})

  holds('a race with no design at all is offered the Missile category, with no saved design, and it is the active one', ids(nothing) === '4:0' && nothing.activeCategoryId === 4 && nothing.isMissileCategory === true)
  holds('the empty Missile category lists no row and keeps its name, so the hit chance panel and the proposed missile are reachable', nothing.rows.length === 0 && nothing.categoryRows.length === 0 && nothing.categoryName === 'Missile')

  const beamsOnly = page({ components: [beam], selectedCategoryId: 4 })

  holds('a race with a beam design and no missile design is offered both categories, the Missile one with a count of 0', ids(beamsOnly) === '2:1,4:0')
  holds('such a race can pick the Missile category, which then shows the missile panel and no row', beamsOnly.isMissileCategory === true && beamsOnly.rows.length === 0 && Array.isArray(beamsOnly.tiles))

  const beamPicked = page({ components: [beam], selectedCategoryId: 2 })

  holds('the beam category keeps its own view and does not show the missile panel', beamPicked.isMissileCategory === false && beamPicked.rows.length === 1)

  const saved = page({ missiles: [arrow], selectedCategoryId: 4 })

  holds('a race with a missile design counts it, and the species category is left out when it has none', ids(saved) === '4:1' && saved.isMissileCategory === true && saved.rows.length === 1)

  return results
}

const PAGE_MUTATIONS = [
  ['the Missile category is dropped when the race has no saved missile', ' || category.CategoryID === MISSILE_CATEGORY_ID', ''],
  ['the empty Missile category has no count', 'count: counts.get(category.CategoryID) || 0', 'count: counts.get(category.CategoryID)'],
  ['the Missile panel is shown for any category', 'return this.activeCategoryId === MISSILE_CATEGORY_ID', 'return true'],
]

// ---------- the parts: the checks of the real sources, each mutant, the page and each save run in a process of their own ----------

const checkSynthetic = (mods) => {
  console.log('Synthetic checks')

  for (const [name, test] of synthetic(mods)) {
    let result

    try {
      result = test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    check(name, result)
  }
}

const checkMutation = async ([label, from, to, nth]) => {
  const directory = mutatedCopy(FILE, from, to, nth)

  try {
    let failed = []

    try {
      const mutant = await loadUtilities(['missile-hit', 'provenance'], { directory })

      failed = synthetic({ hit: mutant['missile-hit'], provenance: mutant.provenance }).filter(([, test]) => {
        try {
          return test() !== true
        } catch (error) {
          return true
        }
      })
    } catch (error) {
      failed = [[`does not load: ${error.message}`]]
    }

    check(`mutation caught: ${label}`, failed.length > 0 ? true : 'every check still passes', `${failed.length} checks fail`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const checkPage = async () => {
  for (const [statement, held] of await pageStatements(null)) {
    check(`page: ${statement}`, held)
  }
}

const checkPageMutation = async ([label, from, to]) => {
  let failed = []

  try {
    failed = (await pageStatements(replacing(from, to))).filter(([, held]) => !held)
  } catch (error) {
    failed = [[`does not load: ${error.message}`]]
  }

  check(`page mutation caught: ${label}`, failed.length > 0 ? true : 'every page check still passes', `${failed.length} checks fail`)
}

const SAVE_LABELS = ['modded', 'stock']

// One part, in this process: `synthetic`, a mutation by its index (`mutation:3`), `page`, a page mutation by its index (`pagemutation:1`) or a save by its label.
const runPart = async (part, options) => {
  const [kind, index] = part.split(':')

  if (kind === 'mutation') {
    await checkMutation(MUTATIONS[Number(index)])
  } else if (kind === 'pagemutation') {
    await checkPageMutation(PAGE_MUTATIONS[Number(index)])
  } else if (part === 'page') {
    await checkPage()
  } else if (part === 'synthetic' || SAVE_LABELS.includes(part)) {
    const utilities = await loadUtilities(['missile-hit', 'provenance'])
    const mods = { hit: utilities['missile-hit'], provenance: utilities.provenance }

    if (part === 'synthetic') {
      checkSynthetic(mods)
    } else {
      await compareSave(part, options[part], mods)
    }
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

const forwardedSaves = (options) => ['--modded', ...options.modded.map(String), '--stock', ...options.stock.map(String)]

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    await runPart(options.part, options)
    endSection(checks, failures)
  }

  // In the order they print; the longest start first.
  const parts = [
    { part: 'synthetic', weight: 5 },
    ...MUTATIONS.map((_mutation, index) => ({ part: `mutation:${index}`, weight: 3 })),
    { part: 'page', weight: 5 },
    ...PAGE_MUTATIONS.map((_mutation, index) => ({ part: `pagemutation:${index}`, weight: 5 })),
    ...SAVE_LABELS.map((label) => ({ part: label, weight: 10 })),
  ]

  const sections = await runSections(__filename, parts.map(({ part, weight }) => ({ args: ['--part', part, ...forwardedSaves(options)], weight })))
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()
  console.log('\nMutations: each must fail at least one check')
  MUTATIONS.forEach(printed)
  console.log('\nThe Designed Tech page (its script on a pseudo instance, scripts/lib/page-loader.js)')
  printed()
  PAGE_MUTATIONS.forEach(printed)
  SAVE_LABELS.forEach(printed)

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
