/*
  Checks the typed sweep domains (src/renderer/utilities/sweep-domain.js) and their use by the Propulsion Planner's search (engineSweep, engineFields and searchPropulsion in design-search.js).

  node scripts/check-sweep-domains.js [--no-mutations] [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>]

  The synthetic checks need no save. They prove: steps of 0.1 and 0.05 and singleton domains give exactly the decimals of the grid, each once, with the preview's count equal to the iterator's; a bound between two steps is left out or tried once under the stated endpoint policy; negative or zero steps, NaN, infinity, text, reversed bounds, fractional counts, figures finer than the resolution and bounds outside the researched limits are refused with a message on the field that is wrong and no values; switching the display between HS and tons leaves the canonical domain as it was; and the engine grid equals the grid the search stepped before the domains existed (a copy of the old functions below is the reference), on a matrix of techs and on random limits, and equals a brute-force enumeration of the integer grid. Then every mutation of the modules (a tolerance removed, a check dropped, an endpoint left out, a unit factor changed) must fail at least one check.

  With a save (by default the repository's modded save, AuroraDB.db game 140 race 784, and the stock 2.7.1 save in saves/, game 138 race 785; one that is not there is reported as not run) it also builds the engine grid from the race's researched techs as the page does, compares it with the old grid, and runs the page's default search twice, once on the domain grid and once on the old grid, to prove the two searches give the same result; the digests of the default searches of the repository's saves were taken from the search before the domains existed. Exit code 1 when a check fails.
*/
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { endSection, runSections, printSection } = require('./lib/check-sections')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

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

const short = (value) => {
  const text = JSON.stringify(value)

  return text.length > 220 ? `${text.slice(0, 220)}…` : text
}

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected) || `${short(actual)} != ${short(expected)}`

// The sweep the search made before the domains existed: the engine sizes (every 0.1 HS to 10, 0.25 to 20, then whole HS) and the thrust modifiers (every 0.05), as the old engineSizes and engineThrusts built them.
const OLD_EPSILON = 1e-9
const OLD_THRUST_STEP = 0.05

const oldSizes = (maxSizeHS) => {
  const sizes = []

  for (let tenths = 10; tenths <= 100; tenths++) {
    sizes.push(tenths / 10)
  }

  for (let quarters = 41; quarters <= 80; quarters++) {
    sizes.push(quarters / 4)
  }

  for (let size = 21; size <= maxSizeHS; size++) {
    sizes.push(size)
  }

  return sizes.filter((size) => size <= maxSizeHS + OLD_EPSILON)
}

const oldThrusts = (minThrust, maxThrust) => {
  const thrusts = []

  for (let step = Math.ceil(minThrust / OLD_THRUST_STEP - OLD_EPSILON); step <= Math.floor(maxThrust / OLD_THRUST_STEP + OLD_EPSILON); step++) {
    thrusts.push(Math.round(step * OLD_THRUST_STEP * 100) / 100)
  }

  return thrusts
}

// A repeatable pseudo-random sequence (a linear congruential generator), so a failure can be run again.
const generator = (seed) => {
  let state = seed

  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296

    return state / 4294967296
  }
}

const TECH = { engineTech: 10, fuelTech: 1, thermalTech: 1, thermalCost: 1, minThrust: 0.5, maxThrust: 2, maxSize: 25 }

const drain = (iterator) => {
  let step

  do {
    step = iterator.next()
  } while (!step.done)

  return step.value
}

// The checks that need no save, over the modules `m` ({ domain, search, rules }): [[name, () => true or a message]]. Run on the real modules and again on each mutated copy, where one at least must fail.
const synthetic = ({ domain, search, rules }) => {
  const { sweepDomain, describeSweep, combinationCount, readValue, SWEEP_KINDS } = domain
  const hs = (extra) => sweepDomain({ kind: 'sizeHS', ...extra })
  const decimals = (from, to, divisor) => Array.from({ length: to - from + 1 }, (_unused, index) => (from + index) / divisor)
  const all = []
  const add = (name, run) => all.push([name, run])

  const isUnique = (values) => values.every((value, index) => index === 0 || value > values[index - 1])

  // The grids a sweep is checked on: [label, kind, min, max, step, expected values].
  const GRIDS = [
    ['step 0.1 from 0 to 1', 'sizeHS', 0, 1, 0.1, decimals(0, 10, 10)],
    ['step 0.1 from 0 to 0.3 (truncating (max - min) / step loses the endpoint)', 'sizeHS', 0, 0.3, 0.1, decimals(0, 3, 10)],
    ['step 0.05 from 0.4 to 3', 'thrust', 0.4, 3, 0.05, decimals(8, 60, 20)],
    ['step 0.05 from 0 to 1', 'thrust', 0, 1, 0.05, decimals(0, 20, 20)],
    ['step 0.1 from 1 to 2', 'sizeHS', 1, 2, 0.1, decimals(10, 20, 10)],
    ['step 1 from 1 to 100 (a count)', 'count', 1, 100, 1, decimals(1, 100, 1)],
    ['step 0.25 from 10.25 to 20', 'sizeHS', 10.25, 20, 0.25, decimals(41, 80, 4)],
    ['singleton: 5 to 5 by 1', 'count', 5, 5, 1, [5]],
    ['singleton: 0.3 to 0.3 by 0.1', 'sizeHS', 0.3, 0.3, 0.1, [0.3]],
  ]

  for (const [label, kind, min, max, step, expected] of GRIDS) {
    add(`${label}: exactly the decimals of the grid, each once; the preview, the iterator and the count agree`, () => {
      const made = sweepDomain({ kind, min, max, step })
      const values = [...made.values()]
      const preview = describeSweep(made)

      return made.ok && same(values, expected) === true && isUnique(values) && made.count === expected.length && preview.count === values.length && made.toArray().length === made.count && values.every((value, index) => made.at(index) === value && Number.isInteger(made.scaledAt(index))) && made.first === expected[0] && made.last === expected[expected.length - 1] && !made.offStep.min && !made.offStep.max ? true : `${made.ok} ${short(values)} vs ${short(expected)}`
    })
  }

  add('truncating (max - min) / step, as the public sweep input does, loses an endpoint of 0 to 0.3 by 0.1 and adding the step up drifts off 1, so the exact grid is not a no-op', () => {
    const truncated = Math.floor((0.3 - 0) / 0.1) + 1
    let accumulated = 0
    let steps = 0

    for (let value = 0; value <= 1; value += 0.1) {
      accumulated = value
      steps++
    }

    return truncated === 3 && accumulated !== 1 && steps === 11 ? true : `truncated ${truncated}, accumulated last ${accumulated}`
  })

  add('a step wider than the range keeps the minimum alone and says the maximum is not tried', () => {
    const made = sweepDomain({ kind: 'sizeHS', min: 0.3, max: 0.35, step: 0.5 })
    const preview = describeSweep(made)

    return same(made.toArray(), [0.3]) === true && made.count === 1 && made.offStep.max && !made.offStep.min && preview.notes.some((note) => /0\.35 HS is between steps and is not tried/.test(note)) ? true : short([made.toArray(), preview.notes])
  })

  add('a bound off the step is never invented: step 0.05 from 0.4 to 1.33 leaves 1.33 out and the last value is 1.3', () => {
    const made = sweepDomain({ kind: 'thrust', min: 0.4, max: 1.33, step: 0.05, anchor: 'zero' })
    const values = [...made.values()]
    const preview = describeSweep(made)

    return same(values, decimals(8, 26, 20)) === true && made.last === 1.3 && made.offStep.max && !values.includes(1.33) && preview.notes.some((note) => /1\.33 is between steps and is not tried; the last value is 1\.3/.test(note)) ? true : `${short(values)} ${short(preview.notes)}`
  })

  add('under the policy that includes limits 1.33 is tried once, after 1.3, and nothing else changes', () => {
    const grid = sweepDomain({ kind: 'thrust', min: 0.4, max: 1.33, step: 0.05, anchor: 'zero' })
    const included = sweepDomain({ kind: 'thrust', min: 0.4, max: 1.33, step: 0.05, anchor: 'zero', include: 'limits' })
    const values = [...included.values()]
    const preview = describeSweep(included)

    return same(values, [...grid.values(), 1.33]) === true && included.count === grid.count + 1 && values.filter((value) => value === 1.33).length === 1 && isUnique(values) && preview.notes.some((note) => /1\.33 is between steps and is tried as the last value/.test(note)) ? true : `${short(values)}`
  })

  add('a lower bound off the step: 0.42 starts at 0.45 on the grid from 0, and is tried first under the limits policy; the grid from the minimum always tries it', () => {
    const grid = sweepDomain({ kind: 'thrust', min: 0.42, max: 0.6, step: 0.05, anchor: 'zero' })
    const included = sweepDomain({ kind: 'thrust', min: 0.42, max: 0.6, step: 0.05, anchor: 'zero', include: 'limits' })
    const fromMin = sweepDomain({ kind: 'thrust', min: 0.42, max: 0.6, step: 0.05 })

    return same([...grid.values()], [0.45, 0.5, 0.55, 0.6]) === true && same([...included.values()], [0.42, 0.45, 0.5, 0.55, 0.6]) === true && fromMin.first === 0.42 && same(fromMin.toArray(), [0.42, 0.47, 0.52, 0.57]) === true && grid.offStep.min && !grid.offStep.max ? true : `${short(grid.toArray())} ${short(included.toArray())} ${short(fromMin.toArray())}`
  })

  add('a bound on the step is one value under either policy (no duplicate endpoint)', () => {
    const grid = sweepDomain({ kind: 'thrust', min: 0.4, max: 1.3, step: 0.05, anchor: 'zero' })
    const included = sweepDomain({ kind: 'thrust', min: 0.4, max: 1.3, step: 0.05, anchor: 'zero', include: 'limits' })

    return grid.count === 19 && same(grid.toArray(), included.toArray()) === true && !included.offStep.max ? true : `${grid.count} ${included.count}`
  })

  add('a range with no grid point is an error under the grid policy, and two values (its limits) under the limits policy', () => {
    const grid = sweepDomain({ kind: 'thrust', min: 1.32, max: 1.33, step: 0.05, anchor: 'zero' })
    const included = sweepDomain({ kind: 'thrust', min: 1.32, max: 1.33, step: 0.05, anchor: 'zero', include: 'limits' })
    const single = sweepDomain({ kind: 'thrust', min: 1.32, max: 1.32, step: 0.05, anchor: 'zero', include: 'limits' })

    return !grid.ok && grid.errors.domain && grid.count === 0 && same(included.toArray(), [1.32, 1.33]) === true && same(single.toArray(), [1.32]) === true ? true : `${short(grid.errors)} ${short(included.toArray())} ${short(single.toArray())}`
  })

  // A value that fails, with the field that must carry the message.
  const REFUSED = [
    ['a negative step', { min: 0, max: 1, step: -0.1 }, 'step', /above 0/],
    ['a zero step', { min: 0, max: 1, step: 0 }, 'step', /above 0/],
    ['a zero step as text', { min: 0, max: 1, step: '0' }, 'step', /above 0/],
    ['a NaN step', { min: 0, max: 1, step: NaN }, 'step', /finite/],
    ['an infinite step', { min: 0, max: 1, step: Infinity }, 'step', /finite/],
    ['a step of -Infinity as text', { min: 0, max: 1, step: '-Infinity' }, 'step', /finite/],
    ['an empty step', { min: 0, max: 1, step: '' }, 'step', /number/],
    ['a missing step', { min: 0, max: 1 }, 'step', /number/],
    ['a step that is text', { min: 0, max: 1, step: 'abc' }, 'step', /number/],
    ['a NaN minimum', { min: NaN, max: 1, step: 0.1 }, 'min', /finite/],
    ['a minimum of Infinity as text', { min: 'Infinity', max: 1, step: 0.1 }, 'min', /finite/],
    ['a NaN maximum', { min: 0, max: NaN, step: 0.1 }, 'max', /finite/],
    ['an infinite maximum', { min: 0, max: Infinity, step: 0.1 }, 'max', /finite/],
    ['a maximum of 1e999 as text', { min: 0, max: '1e999', step: 0.1 }, 'max', /finite/],
    ['a maximum that is null', { min: 0, max: null, step: 0.1 }, 'max', /number/],
    ['a negative minimum', { min: -1, max: 1, step: 0.1 }, 'min', /0 or more/],
    ['a maximum finer than the resolution', { min: 0, max: 0.0005, step: 0.1 }, 'max', /Finer than the resolution of 0\.001 HS/],
    ['a step finer than the resolution', { min: 0, max: 1, step: 0.0005 }, 'step', /Finer than the resolution/],
    ['a maximum too large to index', { min: 0, max: 1e300, step: 1 }, 'max', /Too large/],
  ]

  for (const [label, input, field, pattern] of REFUSED) {
    add(`${label} is refused on the ${field} field alone, with no values`, () => {
      const made = hs(input)

      return !made.ok && made.count === 0 && made.values === undefined && pattern.test(made.errors[field] || '') && Object.keys(made.errors).every((key) => key === field) ? true : `${made.ok} ${short(made.errors)}`
    })
  }

  add('reversed bounds are refused on the minimum and the maximum, not on the step', () => {
    const made = hs({ min: 5, max: 1, step: 0.5 })

    return !made.ok && /Above the upper bound of 1 HS/.test(made.errors.min) && /Below the lower bound of 5 HS/.test(made.errors.max) && !made.errors.step && made.values === undefined ? true : short(made.errors)
  })

  add('a count is whole exactly: a fractional count a hair off a whole number is refused, and a sub-resolution step is refused, not read as zero', () => {
    const near = search.engineFields({ min: '1.0000000001', max: 10, share: 50 })
    const hair = search.engineFields({ min: '1.000000000000001', max: 10, share: 50 })
    const exact = sweepDomain({ kind: 'count', min: 1, max: 3, step: 1 })
    const tiny = sweepDomain({ kind: 'sizeHS', min: 0, max: 1, step: 1e-13, include: 'limits' })
    const zeroScaled = sweepDomain({ kind: 'sizeHS', min: 0, max: 1, step: 1e-18, include: 'limits' })
    const fractional = sweepDomain({ kind: 'count', min: 2.5, max: 10, step: 1 })

    const refusedStep = zeroScaled.errors && /Finer than the resolution/.test(zeroScaled.errors.step)
    const guarded = domain.readField(1e-18, { kind: 'sizeHS', positive: true, snap: 'inward', direction: -1 })

    return !near.ok && /whole number/.test(near.errors.min) && !hair.ok && /whole number/.test(hair.errors.min) && exact.ok && !tiny.ok && /Finer than the resolution/.test(tiny.errors.step) && !zeroScaled.ok && refusedStep && !guarded.ok && /above 0/.test(guarded.error) && !fractional.ok ? true : short([near, hair, tiny.errors, zeroScaled.errors, guarded])
  })

  add('the decimal conversion tolerates only representation error: a bound a few ten-thousandths past a large figure is cut inward, never moved outward', () => {
    const made = sweepDomain({ kind: 'fuel', min: 1000000, max: 1000000.0006, step: 0.001, snap: 'inward' })
    const exact = sweepDomain({ kind: 'fuel', min: 1000000, max: 1000000.001, step: 0.001 })
    const sum = sweepDomain({ kind: 'thrust', min: 0.1 + 0.2, max: 0.7, step: 0.1 })

    return made.ok && made.last <= 1000000.0006 && made.max === 1000000 && made.cuts.some((cut) => cut.bound === 'max') && exact.ok && exact.last === 1000000.001 && sum.ok && sum.first === 0.3 ? true : short([made.last, made.max, made.cuts, exact.last, sum.first])
  })

  add('a figure is read exactly at any magnitude: a bound a hair under the next tick is cut down and never up, in the domain, the strict reading and the researched limit', () => {
    const inward = sweepDomain({ kind: 'fuel', min: 60000000, max: 60000000.0009999, step: 0.001, snap: 'inward' })
    const strict = sweepDomain({ kind: 'fuel', min: 60000000, max: 60000000.0009999, step: 0.001 })
    const limited = readValue(60000000.001, { kind: 'fuel', limits: { max: 60000000.0009999, source: 'researched' } })
    const limitedOn = readValue(60000000, { kind: 'fuel', limits: { max: 60000000.0009999, source: 'researched' } })
    const lowered = sweepDomain({ kind: 'fuel', min: 60000000.0000001, max: 60000000.002, step: 0.001, snap: 'inward' })
    const typed = sweepDomain({ kind: 'fuel', min: '200000000000', max: '200000000000.0006', step: '0.001', snap: 'inward' })
    const huge = sweepDomain({ kind: 'fuel', min: 0, max: '1000000000.000999', step: 1, snap: 'inward' })

    return inward.ok && inward.last === 60000000 && inward.max === 60000000 && inward.cuts.some((cut) => cut.bound === 'max') && !strict.ok && /Finer than the resolution/.test(strict.errors.max) && !limited.ok && /Above the researched maximum/.test(limited.error) && limitedOn.ok && lowered.ok && lowered.first === 60000000.001 && typed.ok && typed.last === 200000000000 && typed.count === 1 && huge.ok && huge.last === 1000000000 && huge.cuts.some((cut) => cut.bound === 'max') ? true : short([inward.last, inward.cuts, strict.errors, limited, limitedOn, lowered.first, typed.last, typed.errors, huge.last, huge.errors])
  })

  add('real magnitudes are accepted: a fuel capacity of a hundred million litres, as a single value and as a coarse sweep, and a figure no double holds exactly in scaled units is refused', () => {
    const single = sweepDomain({ kind: 'fuel', min: 156570600, max: 156570600, step: 1 })
    const coarse = sweepDomain({ kind: 'fuel', min: 50000000, max: 200000000, step: 50000000 })
    const huge = sweepDomain({ kind: 'fuel', min: 0, max: '1e13', step: 1 })
    const limit = sweepDomain({ kind: 'fuel', min: 0, max: 100, step: 1, limits: { max: 1e13, source: 'researched' } })

    return single.ok && single.count === 1 && single.first === 156570600 && coarse.ok && coarse.count === 4 && coarse.last === 200000000 && !huge.ok && /Too large/.test(huge.errors.max) && !limit.ok && /too large/.test(limit.errors.limits) ? true : short([single.errors, coarse.errors, coarse.count, huge.errors, limit.errors])
  })

  add('a step the largest figure cannot tell apart is refused, and a step it just can is accepted: neighbouring values are never one double', () => {
    const collapsed = sweepDomain({ kind: 'fuel', min: '8796093022208', max: '8796093022208.004', step: '0.001' })
    const held = sweepDomain({ kind: 'fuel', min: '3000000000000', max: '3000000000000.004', step: '0.001' })
    const coarse = sweepDomain({ kind: 'fuel', min: 50000000, max: 200000000, step: 50000000 })
    const singleton = sweepDomain({ kind: 'fuel', min: 156570600, max: 156570600, step: 1 })

    const farEnd = sweepDomain({ kind: 'fuel', min: '3000000000000', max: '3000000000000.007', step: '0.005', include: 'limits' })
    const endMax = sweepDomain({ kind: 'fuel', min: '8796093022208', max: '8796093022208.006', step: '0.005', include: 'limits' })
    const endMin = sweepDomain({ kind: 'fuel', min: '8796093022208.009', max: '8796093022208.020', step: '0.005', anchor: 'zero', include: 'limits' })
    const inactive = sweepDomain({ kind: 'fuel', min: '8796093022208', max: '8796093022212', bands: [{ step: '0.001', to: '1' }, { step: '1' }] })
    const active = sweepDomain({ kind: 'fuel', min: '8796093022208', max: '8796093022212', bands: [{ step: '0.001', to: '8796093022209' }, { step: '1' }] })

    return !collapsed.ok && /Finer than a figure of this size/.test(collapsed.errors.step) && held.ok && held.count === 5 && new Set(held.toArray()).size === 5 && coarse.ok && singleton.ok && farEnd.ok && farEnd.count === 3 && new Set(farEnd.toArray()).size === 3 && !endMax.ok && /Too close to the next value/.test(endMax.errors.max) && !endMax.errors.step && !endMin.ok && /Too close to the next value/.test(endMin.errors.min) && !endMin.errors.step && inactive.ok && inactive.count === 5 && !active.ok && /Finer than a figure of this size/.test(active.errors.step) ? true : short([collapsed.errors, held.errors, held.count, farEnd.errors, endMax.errors, endMin.errors, inactive.errors, active.errors])
  })

  add('a number given by code is read to within 2 ulps of a tick and typed text exactly: a numeric maximum a hair under 0.3 reads as 0.3, the same text floors to 0.299', () => {
    const numeric = sweepDomain({ kind: 'thrust', min: 0, max: 0.2999999999999999, step: 0.001, snap: 'inward' })
    const typed = sweepDomain({ kind: 'thrust', min: 0, max: '0.2999999999999999', step: 0.001, snap: 'inward' })

    return numeric.ok && numeric.last === 0.3 && typed.ok && typed.last === 0.299 ? true : short([numeric.last, typed.last])
  })

  add('a computed number gets the allowance of the arithmetic that made it and typed text does not: 0.1 + 0.2 is 0.3, two units in the last place off a tick is that tick, three is not', () => {
    const second = 2 ** -54
    const sumLimit = readValue(0.3, { kind: 'thrust', limits: { min: 0.1 + 0.2, source: 'researched' } })
    const twoOff = readValue(0.3 + 2 * second, { kind: 'thrust' })
    const threeOff = readValue(0.3 + 3 * second, { kind: 'thrust' })
    const cutUp = sweepDomain({ kind: 'thrust', min: 0.3 + 3 * second, max: 1, step: 0.001, snap: 'inward' })
    const typedSum = readValue('0.30000000000000004', { kind: 'thrust' })
    const computedCount = sweepDomain({ kind: 'count', min: 1 + Number.EPSILON, max: 3, step: 1 })
    const typedCount = search.engineFields({ min: '1.0000000000000002', max: 10, share: 50 })

    return sumLimit.ok && twoOff.ok && twoOff.value === 0.3 && !threeOff.ok && /Finer than the resolution/.test(threeOff.error) && cutUp.ok && cutUp.min === 0.301 && !typedSum.ok && computedCount.ok && computedCount.min === 1 && !typedCount.ok ? true : short([sumLimit, twoOff, threeOff, cutUp.min, typedSum, computedCount.errors, typedCount.errors])
  })

  add('stored engine options of an older version are kept: kind and counts survive, a share below 1% becomes the 1% the old search used, a missing policy is the grid policy', () => {
    const old = search.normaliseEngineOptions({ kind: 'commercial', min: 2, max: 8, share: 0.005 })
    const plain = search.normaliseEngineOptions({ kind: 'military', min: 1, max: 100, share: 0.5 })
    const current = search.normaliseEngineOptions({ kind: 'either', min: 3, max: 9, share: 1, exactLimits: true })

    return same(old, { kind: 'commercial', min: 2, max: 8, share: 0.01, exactLimits: false }) === true && same(plain, { kind: 'military', min: 1, max: 100, share: 0.5, exactLimits: false }) === true && same(current, { kind: 'either', min: 3, max: 9, share: 1, exactLimits: true }) === true && search.normaliseEngineOptions({ kind: 'warp', min: 1, max: 2, share: 0.5 }) === undefined && search.normaliseEngineOptions({ kind: 'either', min: 1.5, max: 2, share: 0.5 }) === undefined && search.normaliseEngineOptions({ kind: 'either', min: 3, max: 2, share: 0.5 }) === undefined && search.normaliseEngineOptions({ kind: 'either', min: 1, max: 2, share: 0 }) === undefined && search.normaliseEngineOptions({ kind: 'either', min: 1, max: 2, share: 1.5 }) === undefined && search.normaliseEngineOptions(null) === undefined && search.normaliseEngineOptions({ kind: 'either', min: 1, max: 2, share: 0.5, exactLimits: 'yes' }) === undefined ? true : short([old, plain, current])
  })

  add('a fractional count and a fractional count step are refused as not whole numbers', () => {
    const fewest = sweepDomain({ kind: 'count', min: 2.5, max: 10, step: 1 })
    const step = sweepDomain({ kind: 'count', min: 1, max: 10, step: 0.5 })
    const sensors = sweepDomain({ kind: 'sensorCount', min: 1, max: 4.5, step: 1 })

    return /whole number/.test(fewest.errors.min) && /whole number/.test(step.errors.step) && /whole number/.test(sensors.errors.max) && !fewest.errors.max ? true : short([fewest.errors, step.errors, sensors.errors])
  })

  add('an error is local to its field: one bad field leaves the others without a message', () => {
    const made = hs({ min: 'abc', max: 5, step: 0.5 })
    const other = hs({ min: 1, max: 5, step: -1 })

    return Object.keys(made.errors).join() === 'min' && Object.keys(other.errors).join() === 'step' ? true : short([made.errors, other.errors])
  })

  add('a bound outside the researched limits is refused on that bound, with the limit in the message', () => {
    const low = hs({ min: 0.2, max: 2, step: 0.1, limits: { min: 0.5, max: 3, source: 'researched' } })
    const high = hs({ min: 1, max: 4, step: 0.1, limits: { min: 0.5, max: 3, source: 'researched' } })
    const inside = hs({ min: 0.5, max: 3, step: 0.5, limits: { min: 0.5, max: 3, source: 'researched' } })
    const fractional = hs({ min: 1, max: 1.3, step: 0.1, limits: { min: 0.5, max: 1.25, source: 'researched' } })

    return /Below the researched minimum of 0\.5 HS/.test(low.errors.min) && Object.keys(low.errors).join() === 'min' && /Above the researched maximum of 3 HS/.test(high.errors.max) && Object.keys(high.errors).join() === 'max' && inside.ok && inside.count === 6 && /Above the researched maximum of 1\.25 HS/.test(fractional.errors.max) ? true : short([low.errors, high.errors, fractional.errors])
  })

  add('limits that are themselves wrong are refused as limits: reversed, and not a finite number', () => {
    const reversed = hs({ min: 1, max: 2, step: 0.5, limits: { min: 3, max: 1, source: 'researched' } })
    const nan = hs({ min: 1, max: 2, step: 0.5, limits: { min: 0, max: NaN, source: 'researched' } })

    return /minimum is above the maximum/.test(reversed.errors.limits) && /not a finite number/.test(nan.errors.limits) && !reversed.ok && !nan.ok ? true : short([reversed.errors, nan.errors])
  })

  add('a figure finer than the resolution is cut inward, and said so, when the domain is built from researched limits (snap inward)', () => {
    const made = sweepDomain({ kind: 'thrust', min: 0.4005, max: 1.3338, step: 0.05, anchor: 'zero', snap: 'inward' })
    const preview = describeSweep(made)

    return made.ok && made.min === 0.401 && made.max === 1.333 && made.cuts.length === 2 && preview.notes.some((note) => /upper limit is cut to 1\.333/.test(note)) ? true : short([made.min, made.max, made.cuts, preview.notes])
  })

  add('readValue reads one figure against its limits (the share field)', () => {
    const percent = (raw) => readValue(raw, { kind: 'percent', limits: { min: 1, max: 100 } })

    return percent('50').value === 50 && percent('33.33').value === 33.33 && /Below the allowed minimum of 1 %/.test(percent('0').error) && /Above the allowed maximum of 100 %/.test(percent(101).error) && /finite/.test(percent(NaN).error) && /number/.test(percent('').error) && /Finer than the resolution of 0\.01 %/.test(percent('33.333').error) ? true : short([percent('50'), percent('0'), percent(101), percent('33.333')])
  })

  add('switching the display between HS and tons leaves the canonical domain as it was', () => {
    const made = hs({ min: 1, max: 12.3, step: 0.1 })
    const before = made.signature
    const values = made.toArray()
    const inHs = describeSweep(made, { unit: 'canonical' })
    const inTons = describeSweep(made, { unit: 'tons' })
    const back = describeSweep(made)

    return made.signature === before && same(made.toArray(), values) === true && inHs.unit === 'HS' && inTons.unit === 'tons' && inTons.first === 50 && inTons.last === 615 && inTons.count === inHs.count && same(back, inHs) === true && /1 to 12\.3 HS/.test(inHs.text) && /50 to 615 tons/.test(inTons.text) && Object.isFrozen(made) ? true : `${inTons.first} ${inTons.last} ${inTons.text}`
  })

  add('a domain entered in tons is the same canonical domain as the one entered in HS (5 to 50 tons by 5 is 0.1 to 1 HS by 0.1)', () => {
    const tons = hs({ min: 5, max: 50, step: 5, unit: 'tons' })
    const inHs = hs({ min: 0.1, max: 1, step: 0.1 })
    const text = hs({ min: '5', max: '50', step: '5', unit: 'tons' })

    return tons.ok && tons.signature === inHs.signature && text.signature === inHs.signature && same(tons.toArray(), decimals(1, 10, 10)) === true ? true : short([tons.toArray(), tons.errors])
  })

  add('the tons-per-HS factor of the size kind is the one the design rules use', () => SWEEP_KINDS.sizeHS.units.tons === rules.TONS_PER_HS ? true : `${SWEEP_KINDS.sizeHS.units.tons} vs ${rules.TONS_PER_HS}`)

  add('an unknown kind, unit, anchor or policy is a programming error, not a field error', () => {
    const throws = (run) => {
      try {
        run()
      } catch (error) {
        return true
      }

      return false
    }

    return throws(() => sweepDomain({ kind: 'miles', min: 0, max: 1, step: 1 })) && throws(() => hs({ min: 1, max: 2, step: 1, unit: 'cubits' })) && throws(() => hs({ min: 1, max: 2, step: 1, anchor: 'middle' })) && throws(() => hs({ min: 1, max: 2, step: 1, include: 'both' })) ? true : 'one did not throw'
  })

  add('a domain is brute-force exact: 300 random ranges, steps, anchors and policies equal the integer enumeration', () => {
    const random = generator(137)
    const steps = [1, 10, 50, 100, 250, 500, 1000]

    for (let round = 0; round < 300; round++) {
      const low = Math.floor(random() * 3000)
      const high = Math.max(0, low + Math.floor(random() * 4000) - (random() < 0.1 ? 3000 : 0))
      const step = steps[Math.floor(random() * steps.length)]
      const anchor = random() < 0.5 ? 'min' : 'zero'
      const include = random() < 0.5 ? 'grid' : 'limits'
      const made = sweepDomain({ kind: 'thrust', min: low / 1000, max: high / 1000, step: step / 1000, anchor, include })
      const expected = []

      for (let scaled = Math.max(0, low); scaled <= high; scaled++) {
        if ((anchor === 'min' ? (scaled - low) % step : scaled % step) === 0) {
          expected.push(scaled)
        }
      }

      if (include === 'limits' && low <= high) {
        if (!expected.length || expected[0] > low) {
          expected.unshift(low)
        }

        if (expected[expected.length - 1] < high) {
          expected.push(high)
        }
      }

      const label = `${low}..${high} by ${step} ${anchor} ${include}`

      if (low > high) {
        if (made.ok || !made.errors.min || !made.errors.max) {
          return `reversed ${label} was accepted`
        }
      } else if (!expected.length) {
        if (made.ok || !made.errors.domain) {
          return `empty ${label} was accepted`
        }
      } else if (!made.ok || JSON.stringify(made.toArray()) !== JSON.stringify(expected.map((scaled) => scaled / 1000)) || made.count !== expected.length || describeSweep(made).count !== expected.length) {
        return `${label}: ${short(made.toArray())} vs ${short(expected)}`
      }
    }

    return true
  })

  const bruteSizes = (low, high) => {
    const expected = []

    for (let scaled = low; scaled <= high; scaled++) {
      const on = scaled <= 10000 ? scaled % 100 === 0 : scaled <= 20000 ? (scaled - 10000) % 250 === 0 : (scaled - 20000) % 1000 === 0

      if (on) {
        expected.push(scaled / 1000)
      }
    }

    return expected
  }

  add('the engine sizes equal the integer enumeration of the three bands, for 250 random largest sizes', () => {
    const random = generator(2718)

    for (let round = 0; round < 250; round++) {
      const high = 1000 + Math.floor(random() * 60000)
      const made = search.engineSweep({ tech: { ...TECH, maxSize: high / 1000, minThrust: 0.5, maxThrust: 1 } })

      if (!made.ok || JSON.stringify(made.sizes.toArray()) !== JSON.stringify(bruteSizes(1000, high))) {
        return `maxSize ${high / 1000}: ${short(made.sizes && made.sizes.toArray().slice(-4))} vs ${short(bruteSizes(1000, high).slice(-4))}`
      }
    }

    return true
  })

  const SIZE_LIMITS = [0.5, 1, 1.05, 3, 9.95, 10, 10.2, 12.3, 20, 20.5, 22.5, 25, 40, 400]
  const THRUST_LIMITS = [[0.4, 3], [0.5, 1], [0.5, 2.5], [0.45, 0.55], [1.33, 1.33], [0.42, 1.33], [1, 1], [0.7, 0.7], [0.1, 0.3], [0.5, 0.5], [2, 1], [0, 0.2]]

  add('the engine grid equals the grid the search stepped before the domains existed, on a matrix of researched limits (an empty old grid is a sweep that cannot run)', () => {
    for (const maxSize of SIZE_LIMITS) {
      for (const [minThrust, maxThrust] of THRUST_LIMITS) {
        const made = search.engineSweep({ tech: { ...TECH, maxSize, minThrust, maxThrust } })
        const sizes = oldSizes(maxSize)
        const thrusts = oldThrusts(minThrust, maxThrust)

        if (sizes.length === 0 || thrusts.length === 0) {
          if (made.ok) {
            return `an empty old grid was accepted: ${maxSize} ${minThrust}..${maxThrust}`
          }
        } else if (!made.ok || JSON.stringify(made.sizes.toArray()) !== JSON.stringify(sizes) || JSON.stringify(made.thrusts.toArray()) !== JSON.stringify(thrusts) || made.combinations !== sizes.length * thrusts.length * 100) {
          return `${maxSize} ${minThrust}..${maxThrust}: ${made.ok} ${short(made.problems)}`
        }
      }
    }

    return true
  })

  add('the thrust grid equals the old grid for 400 random limits, off-step ones included', () => {
    const random = generator(31415)

    for (let round = 0; round < 400; round++) {
      const minThrust = Math.floor(random() * 1500) / 1000
      const maxThrust = minThrust + Math.floor(random() * 3000) / 1000
      const made = search.engineSweep({ tech: { ...TECH, minThrust, maxThrust } })
      const thrusts = oldThrusts(minThrust, maxThrust)

      if (thrusts.length === 0 ? made.ok : JSON.stringify(made.thrusts.toArray()) !== JSON.stringify(thrusts)) {
        return `${minThrust}..${maxThrust}: ${short(made.thrusts && made.thrusts.toArray())} vs ${short(thrusts)}`
      }
    }

    return true
  })

  add('with the limits policy the engine grid is the old grid plus the researched limits that fall between steps, once each', () => {
    const made = search.engineSweep({ tech: { ...TECH, maxSize: 12.3, minThrust: 0.42, maxThrust: 1.33 }, include: 'limits' })
    const sizes = made.sizes.toArray()
    const thrusts = made.thrusts.toArray()

    return made.ok && same(sizes, [...oldSizes(12.3), 12.3]) === true && same(thrusts, [0.42, ...oldThrusts(0.42, 1.33), 1.33]) === true && isUnique(sizes) && isUnique(thrusts) && made.combinations === sizes.length * thrusts.length * 100 ? true : short([sizes.slice(-3), thrusts.slice(0, 3), thrusts.slice(-3)])
  })

  add('the default endpoint policy of the engine sweep and the search is the grid policy (no limit between steps is tried)', () => {
    const made = search.engineSweep({ tech: { ...TECH, maxSize: 12.3, maxThrust: 1.33 } })
    const input = { hullHS: 100, speed: 100, tech: { ...TECH, minThrust: 1.3, maxThrust: 1.33, maxSize: 1.2 }, maxCount: 3, share: 1, keep: 1000 }
    const grid = drain(search.searchPropulsion(input))
    const limits = drain(search.searchPropulsion({ ...input, include: 'limits' }))
    const thrustsOf = (result) => [...new Set(result.sets.map((set) => set.engine.thrust))].sort()

    return made.include === 'grid' && made.sizes.last === 12.25 && made.thrusts.last === 1.3 && same(thrustsOf(grid), [1.3]) === true && same(thrustsOf(limits), [1.3, 1.33]) === true && limits.counts.evaluated > grid.counts.evaluated ? true : short([made.sizes.last, made.thrusts.last, thrustsOf(grid), thrustsOf(limits), grid.counts.evaluated, limits.counts.evaluated])
  })

  add('the preview and the search read one sweep: a search given the sweep and one that builds it give the same result', () => {
    const input = { hullHS: 100, speed: 800, goal: { mode: 'range', value: 2e9 }, tech: { ...TECH, maxSize: 3 }, tanks: [{ id: 1, name: 'Tank', sizeHS: 1, litres: 50000, cost: 2, crew: 1 }], maxCount: 12, share: 0.5 }
    const made = search.engineSweep({ tech: input.tech, minCount: 1, maxCount: 12 })

    return same(drain(search.searchPropulsion({ ...input, sweep: made })), drain(search.searchPropulsion(input))) === true ? true : 'the results differ'
  })

  add('the combinations are the product of the sizes, the thrusts and the counts, or the counts alone for one of the race\'s own engines, or null past a safe integer', () => {
    const designed = search.engineSweep({ tech: TECH, minCount: 2, maxCount: 40 })
    const own = search.engineSweep({ tech: null, engine: { id: 1 }, minCount: 2, maxCount: 40 })
    const huge = sweepDomain({ kind: 'count', min: 1, max: 4e9, step: 1 })

    return designed.combinations === designed.sizes.count * designed.thrusts.count * 39 && own.ok && own.sizes === null && own.thrusts === null && own.combinations === 39 && combinationCount([huge, huge, huge]) === null && combinationCount([huge, { ok: false }]) === null ? true : short([designed.combinations, own.combinations])
  })

  add('an engine sweep that cannot run is not ok, names the field in words, and the search throws before it evaluates anything', () => {
    const cases = [
      ['no engine tech', { tech: null }, /no engine tech/],
      ['the largest size below 1 HS', { tech: { ...TECH, maxSize: 0.5 } }, /Largest researched engine size/],
      ['a thrust range with no step in it', { tech: { ...TECH, minThrust: 1.33, maxThrust: 1.33 } }, /Engine thrust: No point/],
      ['reversed researched thrusts', { tech: { ...TECH, minThrust: 2, maxThrust: 1 } }, /Greatest researched thrust: Below the lower bound/],
      ['a thrust that is not a number', { tech: { ...TECH, maxThrust: NaN } }, /Greatest researched thrust: .*finite/],
      ['the most engines below the fewest', { tech: TECH, minCount: 5, maxCount: 2 }, /Most engines: Below the lower bound of 5/],
      ['a fractional count', { tech: TECH, minCount: 1.5 }, /Fewest engines: Enter a whole number/],
      ['no engines at all', { tech: TECH, minCount: 0 }, /Fewest engines: Below the allowed minimum of 1/],
    ]

    for (const [label, input, pattern] of cases) {
      const made = search.engineSweep(input)
      let thrown = null

      try {
        search.searchPropulsion({ hullHS: 50, speed: 100, ...input }).next()
      } catch (error) {
        thrown = error
      }

      if (made.ok || made.combinations !== null || !made.problems.some((problem) => pattern.test(problem)) || !thrown || !/cannot run/.test(thrown.message)) {
        return `${label}: ${made.ok} ${short(made.problems)} ${thrown && thrown.message}`
      }
    }

    return true
  })

  add('the page\'s engine fields: valid values come back as the search takes them, each bad field carries its own message', () => {
    const valid = search.engineFields({ min: '1', max: '100', share: '50' })
    const decimal = search.engineFields({ min: 2, max: 40, share: '33.33' })
    const bad = (input, field, pattern) => {
      const fields = search.engineFields(input)

      return !fields.ok && fields.min === null && pattern.test(fields.errors[field] || '') && Object.keys(fields.errors).join() === field
    }

    return valid.ok && valid.min === 1 && valid.max === 100 && valid.share === 0.5 && decimal.share === 0.3333 && bad({ min: '0', max: 10, share: 50 }, 'min', /Below the allowed minimum of 1/) && bad({ min: 2.5, max: 10, share: 50 }, 'min', /whole number/) && bad({ min: 1, max: '', share: 50 }, 'max', /number/) && bad({ min: 1, max: 'abc', share: 50 }, 'max', /number/) && bad({ min: 1, max: NaN, share: 50 }, 'max', /finite/) && bad({ min: 1, max: 10, share: 0 }, 'share', /Below the allowed minimum of 1 %/) && bad({ min: 1, max: 10, share: 101 }, 'share', /Above the allowed maximum of 100 %/) && bad({ min: 1, max: 10, share: Infinity }, 'share', /finite/) && bad({ min: 1, max: 10, share: '' }, 'share', /number/) && !search.engineFields({ min: 8, max: 3, share: 50 }).ok && Object.keys(search.engineFields({ min: 8, max: 3, share: 50 }).errors).join() === 'min,max' ? true : short([valid, decimal, search.engineFields({ min: 8, max: 3, share: 50 })])
  })

  return all
}

// A copy of the utilities folder in the temp folder in which `file` has `from` replaced by `to`.
const mutatedCopy = (file, from, to) => {
  refusePlanting(`${file}: ${from}`)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-sweep-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    throw new Error(`The mutation of ${file} does not apply: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

const MUTATIONS = [
  ['the allowance for a computed number removed', 'sweep-domain.js', '<= ULPS * ulp(size)', '<= -1', ({ domain }) => !domain.readValue(0.1 + 0.2, { kind: 'thrust' }).ok],
  ['a negative step not refused as a step', 'sweep-domain.js', 'if (positive && !(canonical > 0)) {', 'if (false) {'],
  ['NaN and infinity accepted as numbers', 'sweep-domain.js', 'if (!Number.isFinite(value)) {', 'if (false) {'],
  ['reversed bounds not noticed', 'sweep-domain.js', 'if (bounds.min && bounds.max && bounds.min.scaled > bounds.max.scaled) {', 'if (bounds.min && bounds.max && false) {'],
  ['an upper bound between steps not tried under the limits policy', 'sweep-domain.js', "if (include === 'limits' && offStep.max && (high > low || !parts.length)) {", 'if (false) {'],
  ['a lower bound between steps not tried under the limits policy', 'sweep-domain.js', "if (include === 'limits' && offStep.min) {", 'if (false) {'],
  ['one value too few in a stretch of the grid', 'sweep-domain.js', 'count: (span - (span % piece.step)) / piece.step + 1', 'count: (span - (span % piece.step)) / piece.step'],
  ['off-step bounds not reported', 'sweep-domain.js', 'const offStep = { min: firstGrid !== low, max: lastGrid !== high }', 'const offStep = { min: false, max: false }'],
  ['the default endpoint policy changed to include limits', 'sweep-domain.js', "include = 'grid', snap = 'error' }) => {", "include = 'limits', snap = 'error' }) => {"],
  ['the researched maximum not enforced', 'sweep-domain.js', 'scaled > scaledBounds[bound])', 'scaled > scaledBounds[bound] + 1e9)'],
  ['the tons factor not applied', 'sweep-domain.js', 'let denominator = BigInt(factor)', 'let denominator = 1n'],
  ['the tons per HS of the size kind changed', 'sweep-domain.js', "sizeHS: kind('HS', 1000, { units: { tons: 50 } })", "sizeHS: kind('HS', 1000, { units: { tons: 40 } })"],
  ['fractional counts accepted (a count that resolves thousandths and is not whole-number only)', 'sweep-domain.js', "count: kind('', 1, { integer: true })", "count: kind('', 1000, { integer: false })", ({ domain }) => domain.sweepDomain({ kind: 'count', min: 2.5, max: 10, step: 1 }).ok],
  ['the allowance given to typed text as well as to computed numbers', 'sweep-domain.js', 'if (low !== high && parsed.computed) {', 'if (low !== high) {', ({ search }) => search.engineFields({ min: '1.0000000000000002', max: 10, share: 50 }).ok],
  ['the tolerance of the decimal conversion relative to the whole value (1e-9)', 'sweep-domain.js', '<= ULPS * ulp(size)', '<= 1e-9 * Math.max(1, size)', ({ domain }) => domain.sweepDomain({ kind: 'fuel', min: 60000000.0000001, max: 60000000.002, step: 0.001, snap: 'inward' }).first < 60000000.0000001],
  ['a maximum rounded up instead of down', 'sweep-domain.js', 'const inward = (figure, direction) => (direction > 0 ? figure.high : figure.low)', 'const inward = (figure, direction) => figure.high', ({ domain }) => domain.sweepDomain({ kind: 'fuel', min: 60000000, max: 60000000.0009999, step: 0.001, snap: 'inward' }).last > 60000000.0009999],
  ['the allowance of three units in the last place', 'sweep-domain.js', 'const ULPS = 2', 'const ULPS = 3', ({ domain }) => domain.readValue(0.3 + 3 * 2 ** -54, { kind: 'thrust' }).ok],
  ['a cap of 2 ** 36 scaled units introduced', 'sweep-domain.js', 'const MAX_SCALED = BigInt(Number.MAX_SAFE_INTEGER)', 'const MAX_SCALED = BigInt(2 ** 36)', ({ domain }) => !domain.sweepDomain({ kind: 'fuel', min: 156570600, max: 156570600, step: 1 }).ok],
  ['a step that scales to zero accepted', 'sweep-domain.js', 'if (positive && scaled < 1) {', 'if (false) {', ({ domain }) => domain.readField(1e-18, { kind: 'sizeHS', positive: true, snap: 'inward', direction: -1 }).ok],
  ['the gap to an included endpoint or between stretches not tested', 'sweep-domain.js', 'if (index > 0 && collapses(', 'if (false && collapses(', ({ domain }) => domain.sweepDomain({ kind: 'fuel', min: '8796093022208', max: '8796093022208.006', step: '0.005', include: 'limits' }).ok],
  ['the finest declared step tested instead of the step of each stretch that has values', 'sweep-domain.js', 'if (part.count > 1 && collapses(part.first, lastOf(part), part.step)) {', 'if (collapses(part.first, lastOf(part), Math.min(...pieces.map((piece) => piece.step)))) {', ({ domain }) => !domain.sweepDomain({ kind: 'fuel', min: '8796093022208', max: '8796093022212', bands: [{ step: '0.001', to: '1' }, { step: '1' }] }).ok],
  ['the middle band of the engine sizes ends early', 'design-search.js', '{ step: 0.25, to: 20 }', '{ step: 0.25, to: 19 }'],
  ['the engine thrust grid anchored at the minimum instead of 0', 'design-search.js', "step: THRUST_STEP, anchor: 'zero'", "step: THRUST_STEP, anchor: 'min'"],
  // eslint-disable-next-line no-template-curly-in-string
  ['the search not stopped by a sweep that cannot run', 'design-search.js', "throw new Error(`The sweep cannot run. ${plan.problems.join(' ')}`)", 'void 0'],
  ['the engine count minimum not enforced', 'design-search.js', "const counts = sweepDomain({ kind: 'count', min: minCount, max: maxCount, step: 1, limits: { min: 1 } })", "const counts = sweepDomain({ kind: 'count', min: minCount, max: maxCount, step: 1 })"],
]

// The page's default search: a 5,000 ton hull, 2,500 km/s, 5 bn km at half power, either kind, 1 to 100 engines, half the ship.
const DEFAULT_INPUT = { hullHS: 100, speed: 2500, fraction: 0.5, goal: { mode: 'range', value: 5e9 }, kind: 'either', minCount: 1, maxCount: 100, share: 0.5 }

// The digest of the default search on the repository's saves, taken from the search before the domains existed.
const ANCHORS = {
  'AuroraDB.db:140:784': { evaluated: 168284, matched: 141201, digest: 'db517f092dd4a48c' },
  'AuroraDB_271_skoormit_saved.db:138:785': { evaluated: 64779, matched: 49905, digest: '20a9ab5a6d9e3308' },
}

const DEFAULT_TECH = { minThrust: 0.5, maxThrust: 1, maxSize: 25, thermalTech: 1, thermalCost: 1 }

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], part: null }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--no-mutations') {
      continue
    } else if (argv[index] === '--part') {
      options.part = argv[++index]
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

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
      query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
        const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
        const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

        raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
      }),
      close: () => raw.close(),
    })
  })
})

// The digests recorded before the search kept counts hash this projection: the sets and best sets, then the evaluated and matched figures that `counts.evaluated` and `counts.feasible` now hold, in the order the search returned them then.
const digest = ({ sets, lightest, fastest, cheapest, pareto, packages, counts }) => crypto.createHash('sha256').update(JSON.stringify({ sets, lightest, fastest, cheapest, pareto, packages, evaluated: counts.evaluated, matched: counts.feasible })).digest('hex').slice(0, 16)

// ---------- the parts: the checks of the real sources, each mutant and each save run in a process of their own ----------

const checkSynthetic = (mods) => {
  console.log('Synthetic domains')

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

const checkMutation = async ([label, file, from, to, probe]) => {
  const directory = mutatedCopy(file, from, to)

  try {
    let failed = []

    try {
      const mutant = await loadUtilities(['sweep-domain', 'design-search', 'design-rules'], { directory })

      failed = synthetic({ domain: mutant['sweep-domain'], search: mutant['design-search'], rules: mutant['design-rules'] }).filter(([, test]) => {
        try {
          return test() !== true
        } catch (error) {
          return true
        }
      })
    } catch (error) {
      failed = [[`does not load: ${error.message}`]]
    }

    let probed = true

    if (probe) {
      try {
        const mutant = await loadUtilities(['sweep-domain', 'design-search'], { directory })

        probed = probe({ domain: mutant['sweep-domain'], search: mutant['design-search'] })
      } catch (error) {
        probed = false
      }
    }

    check(`mutation caught: ${label}`, !probed ? 'the mutant does not show the fault it names' : failed.length > 0 ? true : 'every check still passes', `${failed.length} checks fail`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const checkSave = async (label, [file, GameID, RaceID], utilities, mods) => {
  console.log(`\n${label} save: ${file} (game ${GameID}, race ${RaceID})`)

  const database = await openSave(file)

  if (!database) {
    console.log(`SKIP  ${file} is not there`)

    return
  }

  const context = { GameID, RaceID }
  const tech = await utilities['race-tech'].loadRaceTech(database, context)
  const tanks = await utilities['design-data'].loadStockTanks(database, context)
  const level = (type, key, fallback) => (tech.lines[type].pick ? tech.lines[type].pick[key] : fallback)
  const { ENGINE_TECH_TYPE, FUEL_TECH_TYPE, THERMAL_TECH_TYPE, MAX_THRUST_TECH_TYPE, MIN_THRUST_TECH_TYPE, MAX_ENGINE_SIZE_TECH_TYPE } = utilities['race-tech']

  const designTech = {
    engineTech: level(ENGINE_TECH_TYPE, 'info'),
    fuelTech: level(FUEL_TECH_TYPE, 'info'),
    thermalTech: level(THERMAL_TECH_TYPE, 'info', DEFAULT_TECH.thermalTech),
    thermalCost: level(THERMAL_TECH_TYPE, 'info2', DEFAULT_TECH.thermalCost),
    minThrust: level(MIN_THRUST_TECH_TYPE, 'info', DEFAULT_TECH.minThrust),
    maxThrust: level(MAX_THRUST_TECH_TYPE, 'info', DEFAULT_TECH.maxThrust),
    maxSize: level(MAX_ENGINE_SIZE_TECH_TYPE, 'info', DEFAULT_TECH.maxSize),
  }

  const sweep = mods.search.engineSweep({ tech: designTech, minCount: 1, maxCount: 100 })
  const oldGrid = { sizes: oldSizes(designTech.maxSize), thrusts: oldThrusts(designTech.minThrust, designTech.maxThrust) }

  check(`${label}: the engine grid of the researched techs (${designTech.maxSize} HS, thrust ${designTech.minThrust} to ${designTech.maxThrust}) is the grid of the search before the domains`, sweep.ok && same(sweep.sizes.toArray(), oldGrid.sizes) === true && same(sweep.thrusts.toArray(), oldGrid.thrusts) === true ? true : short(sweep.problems), `${sweep.sizes.count} sizes x ${sweep.thrusts.count} thrusts x ${sweep.counts.count} counts = ${sweep.combinations} combinations`)

  const preview = mods.domain.describeSweep(sweep.sizes)
  const previewTons = mods.domain.describeSweep(sweep.sizes, { unit: 'tons' })

  check(`${label}: the preview counts the sizes and the iterator yields as many, in HS and in tons, from one canonical domain`, preview.count === sweep.sizes.count && previewTons.count === preview.count && previewTons.last === preview.last * 50 && [...sweep.sizes.values()].length === preview.count ? true : short([preview, previewTons]), `${preview.text}; ${previewTons.text}`)

  const input = { ...DEFAULT_INPUT, tech: designTech, tanks }
  const current = drain(mods.search.searchPropulsion({ ...input, sweep }))

  // The search on the old grid: the same sweep with the old lists in place of the domain grids.
  const oldSweep = { ok: true, problems: [], sizes: { toArray: () => oldGrid.sizes }, thrusts: { toArray: () => oldGrid.thrusts }, counts: sweep.counts }
  const old = drain(mods.search.searchPropulsion({ ...input, sweep: oldSweep }))
  const anchor = ANCHORS[`${path.basename(file)}:${GameID}:${RaceID}`]

  check(`${label}: the default search on the domain grid gives the result of the search on the old grid (${current.counts.evaluated} candidates, ${current.counts.feasible} matched, ${current.sets.length} kept)`, digest(current) === digest(old) && current.counts.evaluated === old.counts.evaluated ? true : `${digest(current)} vs ${digest(old)}`, digest(current))

  if (anchor) {
    check(`${label}: the default search still gives the result taken before the domains existed`, current.counts.evaluated === anchor.evaluated && current.counts.feasible === anchor.matched && digest(current) === anchor.digest ? true : `${current.counts.evaluated}/${current.counts.feasible}/${digest(current)} vs ${anchor.evaluated}/${anchor.matched}/${anchor.digest}`, `${anchor.evaluated} evaluated, ${anchor.matched} matched, digest ${anchor.digest}`)
  } else {
    console.log('SKIP  no digest of the unchanged search is recorded for this save')
  }

  database.close()
}

const SAVE_LABELS = ['modded', 'stock']

// One part, in this process: `synthetic`, a mutation by its index (`mutation:3`) or a save by its label.
const runPart = async (part, options) => {
  if (part.startsWith('mutation:')) {
    await checkMutation(MUTATIONS[Number(part.slice('mutation:'.length))])

    return
  }

  const utilities = await loadUtilities(['sweep-domain', 'design-search', 'design-rules', 'design-data', 'race-tech'])
  const mods = { domain: utilities['sweep-domain'], search: utilities['design-search'], rules: utilities['design-rules'] }

  if (part === 'synthetic') {
    checkSynthetic(mods)
  } else if (SAVE_LABELS.includes(part)) {
    await checkSave(part, options[part], utilities, mods)
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
  const planting = mutating()

  const parts = [
    { part: 'synthetic', weight: 10 },
    ...(planting ? MUTATIONS : []).map((_mutation, index) => ({ part: `mutation:${index}`, weight: 5 })),
    ...SAVE_LABELS.map((label) => ({ part: label, weight: 30 })),
  ]

  const sections = await runSections(__filename, parts.map(({ part, weight }) => ({ args: ['--part', part, ...forwardedSaves(options)], weight })))
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (planting) {
    console.log('\nMutations: each must fail at least one check')
    MUTATIONS.forEach(printed)
  }

  SAVE_LABELS.forEach(printed)

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
