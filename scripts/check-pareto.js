/*
  Checks the Pareto comparison of designs (src/renderer/utilities/pareto.js), the front the propulsion search keeps while it explores (`axes` of searchPropulsion in design-search.js) and the page's use of it (pages/propulsion.vue).

  node scripts/check-pareto.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>]

  The checks need no save except the last two groups. Small examples of two to five axes, worked by hand and against an independent oracle (every pair of sets compared, on the same grid of cells that count as alike), show that a set strictly worse on every axis is dropped and so is one that is no better on any axis and worse on one, that incomparable sets stay, that sets alike on every axis stay together by name (their count exact past the names kept), that reversing an axis reverses what is efficient, that the order sets arrive in changes nothing, and that a figure that is not computed (the range and endurance of a set with no fuel) never enters a comparison: it is not read as 0, the set takes no part and is counted and named. A front is provisional when the search stopped early (a candidate budget, a cancelled run, a step's snapshot), or when the front hit its limit, and only a whole domain that the limit did not cut is complete; the text it is shown with says which.

  On small domains an enumeration can walk, the front the search keeps equals the front of every set that meets the targets, for several axis choices and both directions, whatever number of sets the table lists (`keep`); the share and speed frontiers of the earlier search stay as they were and are the front of those two axes once the sets the same-share rule leaves beside a better one are set aside; asking for a front changes no other result; and the front's work counts against a step. With a save, the same on the race's own tanks, engines and tech, and the page's default search with a front gives the digest taken before fronts existed.

  The page is run on a pseudo instance (scripts/lib/page-loader.js). Each mutation of a utility or of the page's script must fail the checks it names. Exit code 1 when a check fails.
*/
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')
const { strictRecords } = require('./lib/csv-records')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const NAMES = ['pareto', 'search-run', 'design-search', 'design-rules', 'tank-packing', 'sweep-domain']

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

  return text === undefined ? 'undefined' : text.length > 260 ? `${text.slice(0, 260)}…` : text
}

const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

const same = (actual, expected) => equal(actual, expected) || `${short(actual)} != ${short(expected)}`

const drain = (iterator) => {
  let step

  do {
    step = iterator.next()
  } while (!step.done)

  return step.value
}

const finish = (run) => {
  run.advance(Infinity)

  return run.outcome()
}

const UNBOUNDED = { candidates: null, ms: null }

const runOf = (m, input, options = {}) => m.search.propulsionRun(input, { budget: UNBOUNDED, ...options })

// A clock that moves by `step` milliseconds each time it is read.
const clock = (step = 1) => {
  let time = 0

  return () => (time += step)
}

const generator = (seed) => {
  let state = seed

  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296

    return state / 4294967296
  }
}

const TECH = { engineTech: 10, fuelTech: 1, thermalTech: 1, thermalCost: 1, minThrust: 0.5, maxThrust: 1, maxSize: 3 }
const STOCK_TANKS = [[100, 5000000, 25], [20, 1000000, 10], [5, 250000, 5], [1, 50000, 2], [0.2, 10000, 0.5], [0.1, 5000, 0.3], [0.02, 1000, 0.08]].map(([sizeHS, litres, cost], index) => ({ id: index + 1, name: `Stock ${index + 1}`, sizeHS, litres, cost, crew: 0 }))
const ODD_TANKS = [[4.1, 230000, 6], [1, 50000, 2], [0.3, 14000, 0.7]].map(([sizeHS, litres, cost], index) => ({ id: 100 + index, name: `Odd ${index + 1}`, sizeHS, litres, cost, crew: 1 }))

// ---------- the oracle: every pair of sets compared, from the figures of a set alone ----------

// The figure of a set on an axis, or null where it is not computed: a set with no fuel has no range or endurance.
const FIGURES = {
  cost: (set) => (set.costKnown === false ? null : set.cost),
  tons: (set) => set.tons,
  speed: (set) => set.speed,
  range: (set) => (set.litres > 0 ? set.rangeKm : null),
  endurance: (set) => (set.litres > 0 ? set.enduranceHours : null),
  payload: (set) => set.hullHS,
}

const SIGN = { min: -1, max: 1 }

// Figures count as alike when they round to the same cell of a grid of 2^30 cells to the power of two they lie in (a figure and its cell are exact, as the grid is of powers of two).
const cell = (value) => {
  if (value === 0) {
    return 0
  }

  const size = Math.abs(value)
  let exponent = Math.floor(Math.log2(size))

  while (2 ** exponent > size) {
    exponent--
  }

  while (2 ** (exponent + 1) <= size) {
    exponent++
  }

  return Math.sign(value) * Math.round(size * 2 ** (30 - exponent)) * 2 ** (exponent - 30)
}

// The cells of a set's figures on `axes` ([{ key, goal }]), each in the direction of its goal, made once for the set and not at every comparison.
const cellsOf = (set, axes) => axes.map(({ key, goal }) => cell(FIGURES[key](set) * SIGN[goal]))

// Whether the set of the cells `a` beats the set of the cells `b`: as good on every axis and better on one.
const beats = (a, b) => {
  let better = false

  for (let at = 0; at < a.length; at++) {
    if (a[at] < b[at]) {
      return false
    }

    better = better || a[at] > b[at]
  }

  return better
}

// The sets no other set beats on `axes`, among the sets with a figure on every axis, and how many had none.
const oracle = (sets, axes) => {
  const known = sets.filter((set) => axes.every(({ key }) => FIGURES[key](set) !== null))
  const cells = known.map((set) => cellsOf(set, axes))

  return { front: known.filter((_set, at) => !cells.some((other, to) => to !== at && beats(other, cells[at]))), unknown: sets.length - known.length }
}

const axesOf = (pairs) => pairs.map(([key, goal]) => ({ key, goal }))

// ---------- small examples ----------

// A set with the figures an example gives and the fields the readers need, named by `id`.
const example = (id, figures = {}) => ({ id, cost: 10, tons: 100, speed: 1000, rangeKm: 5e9, enduranceHours: 100, hullHS: 50, power: 1, totalHS: 10, burnFull: 1, burnCruise: 1, litres: 1, ...figures })

const byId = (set) => set.id

const frontOf = (m, pairs, sets, options = {}) => {
  const front = m.pareto.createFront(axesOf(pairs), { name: byId, ...options })

  for (const set of sets) {
    front.offer(set)
  }

  return front
}

// Every name the front holds: its members and the sets alike them.
const heldOf = (result) => result.members.flatMap((member) => [member.name, ...member.identities]).sort()

// The sets alike a member that the front counts without naming.
const unnamedOf = (result) => result.members.reduce((total, member) => total + member.alternativeCount - member.identities.length, 0)

const namesOf = (sets) => sets.map((set) => set.id).sort()

const SPEED_COST = [['cost', 'min'], ['speed', 'max']]

const shuffled = (list, random) => {
  const copy = list.slice()

  for (let at = copy.length - 1; at > 0; at--) {
    const other = Math.floor(random() * (at + 1))

    ;[copy[at], copy[other]] = [copy[other], copy[at]]
  }

  return copy
}

// Whole numbers on a coarse grid, so some sets tie on an axis and some on every axis.
const grid = (random, count) => Array.from({ length: count }, (_value, index) => example(`s${index}`, { cost: 1 + Math.floor(random() * 6), tons: 10 * (1 + Math.floor(random() * 6)), speed: 100 * (1 + Math.floor(random() * 6)), rangeKm: 1e9 * (1 + Math.floor(random() * 5)), enduranceHours: 10 * (1 + Math.floor(random() * 5)) }))

const GOAL_COMBINATIONS = [['min', 'min', 'min'], ['min', 'min', 'max'], ['min', 'max', 'min'], ['min', 'max', 'max'], ['max', 'min', 'min'], ['max', 'min', 'max'], ['max', 'max', 'min'], ['max', 'max', 'max']]

const pure = (m) => [
  ['a set strictly worse on every axis is dropped and the better set stays', () => {
    const result = frontOf(m, SPEED_COST, [example('good', { cost: 10, speed: 1000 }), example('worse', { cost: 20, speed: 500 })]).result({ explored: true, feasible: 2 })

    return same(result.members.map((member) => member.name), ['good'])
  }],
  ['the better set is kept whichever of the two arrives first', () => {
    const result = frontOf(m, SPEED_COST, [example('worse', { cost: 20, speed: 500 }), example('good', { cost: 10, speed: 1000 })]).result({ explored: true, feasible: 2 })

    return same(result.members.map((member) => member.name), ['good'])
  }],
  ['a set that is no better on any axis and worse on one is dropped', () => same(frontOf(m, SPEED_COST, [example('a', { cost: 10, speed: 1000 }), example('b', { cost: 10, speed: 500 }), example('c', { cost: 20, speed: 1000 })]).result({ explored: true, feasible: 3 }).members.map((member) => member.name), ['a'])],
  ['two sets that each win on one axis both stay', () => same(heldOf(frontOf(m, SPEED_COST, [example('cheap', { cost: 5, speed: 500 }), example('fast', { cost: 20, speed: 1000 })]).result({ explored: true, feasible: 2 })), ['cheap', 'fast'])],
  ['a set that beats several members takes them all out and stays', () => same(frontOf(m, SPEED_COST, [example('a', { cost: 5, speed: 100 }), example('b', { cost: 10, speed: 200 }), example('c', { cost: 20, speed: 300 }), example('top', { cost: 4, speed: 400 })]).result({ explored: true, feasible: 4 }).members.map((member) => member.name), ['top'])],
  ['a trade across three axes keeps the sets none beats and drops the one both others beat', () => {
    const sets = [example('a', { cost: 10, tons: 100, speed: 1000 }), example('b', { cost: 5, tons: 200, speed: 1000 }), example('c', { cost: 10, tons: 200, speed: 900 })]

    return same(heldOf(frontOf(m, [['cost', 'min'], ['tons', 'min'], ['speed', 'max']], sets).result({ explored: true, feasible: 3 })), ['a', 'b'])
  }],
  ['sets alike on every axis picked stay together, under the first, named', () => {
    const result = frontOf(m, SPEED_COST, [example('first', { cost: 10, speed: 1000 }), example('twin', { cost: 10, speed: 1000, tons: 500 }), example('other', { cost: 20, speed: 2000 })]).result({ explored: true, feasible: 3 })
    const member = result.members.find((entry) => entry.name === 'first')

    return equal(result.members.map((entry) => entry.name).sort(), ['first', 'other']) && equal(member.alternatives.map((alternative) => alternative.name), ['twin']) && equal(member.identities, ['twin']) && member.alternatives[0].set.tons === 500 && member.alternativeCount === 1
  }],
  ['sets that differ on an axis that is not picked are alike, and on one that is picked are not', () => {
    const sets = [example('first', { cost: 10, speed: 1000, tons: 100 }), example('twin', { cost: 10, speed: 1000, tons: 200 })]

    return equal(heldOf(frontOf(m, SPEED_COST, sets).result({ explored: true, feasible: 2 })), ['first', 'twin']) && same(heldOf(frontOf(m, [...SPEED_COST, ['tons', 'min']], sets).result({ explored: true, feasible: 2 })), ['first'])
  }],
  ['the names kept of sets alike stop at the number kept and the count goes on', () => {
    const sets = Array.from({ length: m.pareto.ALTERNATIVES_KEPT + 10 }, (_value, index) => example(`t${index}`))
    const member = frontOf(m, SPEED_COST, sets).result({ explored: true, feasible: sets.length }).members[0]

    return member.alternatives.length === m.pareto.ALTERNATIVES_KEPT && member.alternativeCount === sets.length - 1 ? true : short([member.alternatives.length, member.alternativeCount])
  }],
  ['a sum that differs from another in its last digits is alike', () => equal(heldOf(frontOf(m, SPEED_COST, [example('a', { cost: 0.1 + 0.2 }), example('b', { cost: 0.3 })]).result({ explored: true, feasible: 2 })), ['a', 'b']) && same(frontOf(m, SPEED_COST, [example('a', { cost: 1e9 }), example('b', { cost: 1e9 + 0.001 })]).result({ explored: true, feasible: 2 }).members.length, 1)],
  ['sets within a billionth of one another come out the same in every order they are met in', () => {
    const sets = [example('a', { cost: 1, speed: 1 }), example('b', { cost: 1 + 3e-9, speed: 1 + 3e-9 }), example('c', { cost: 1 + 0.5e-9, speed: 1 + 1.5e-9 })]
    const pairs = [['cost', 'min'], ['speed', 'min']]
    const expected = namesOf(oracle(sets, axesOf(pairs)).front)
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]

    for (const order of orders) {
      const held = heldOf(frontOf(m, pairs, order.map((at) => sets[at])).result({ explored: true, feasible: 3 }))

      if (JSON.stringify(held) !== JSON.stringify(expected)) {
        return `${short(order)}: ${short(held)} != ${short(expected)}`
      }
    }

    return true
  }],
  ['a set within a billionth of one member that beats another is not hidden behind the member', () => {
    const sets = [example('a', { cost: 1, tons: 1 }), example('b', { cost: 1 + 3e-9, tons: 1 - 3e-9 }), example('c', { cost: 1 + 0.5e-9, tons: 1 - 1.5e-9 })]
    const pairs = [['cost', 'min'], ['tons', 'min']]
    const expected = namesOf(oracle(sets, axesOf(pairs)).front)

    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const held = heldOf(frontOf(m, pairs, order.map((at) => sets[at])).result({ explored: true, feasible: 3 }))

      if (JSON.stringify(held) !== JSON.stringify(expected)) {
        return `${short(order)}: ${short(held)} != ${short(expected)}`
      }
    }

    return true
  }],
  ['sets that differ in their last digits are held as the oracle holds them, whatever the order, over 60 orders of 40 sets on four axes in every direction', () => {
    const random = generator(23)
    const bases = [1, 2, 3, 4, 5]
    const jitter = (base) => base * (1 + (Math.floor(random() * 9) - 4) * 0.4e-9)
    const sets = Array.from({ length: 40 }, (_value, index) => example(`j${index}`, { cost: jitter(bases[Math.floor(random() * 5)]), tons: 100 * jitter(bases[Math.floor(random() * 5)]), speed: 1000 * jitter(bases[Math.floor(random() * 5)]), rangeKm: 1e9 * jitter(bases[Math.floor(random() * 5)]) }))

    for (const goals of GOAL_COMBINATIONS) {
      const pairs = [['cost', goals[0]], ['tons', goals[1]], ['speed', goals[2]], ['range', goals[0] === 'min' ? 'max' : 'min']]
      const expected = namesOf(oracle(sets, axesOf(pairs)).front)

      for (let round = 0; round < 8; round++) {
        const held = heldOf(frontOf(m, pairs, shuffled(sets, random)).result({ explored: true, feasible: sets.length }))

        if (JSON.stringify(held) !== JSON.stringify(expected)) {
          return `${short(pairs)}: ${held.length} held, ${expected.length} expected`
        }
      }
    }

    return true
  }],
  ['every set alike on the axes picked is named beyond the number described, and the status stays complete', () => {
    const sets = Array.from({ length: 31 }, (_value, index) => example(`t${index}`))
    const result = frontOf(m, SPEED_COST, sets).result({ explored: true, feasible: sets.length })
    const member = result.members[0]

    return member.identities.length === 30 && equal(heldOf(result), namesOf(sets)) && member.alternatives.length === m.pareto.ALTERNATIVES_KEPT && member.alternativeCount === 30 && result.status === 'complete' && result.ties.unnamed === 0 ? true : short([member.identities.length, member.alternatives.length, result.status])
  }],
  ['a member that is beaten takes its sets alike with it: their names free room for the next group, and their omitted count leaves the front', () => {
    const pairs = [['cost', 'min'], ['tons', 'min']]
    const old = Array.from({ length: 4 }, (_value, index) => example(`old${index}`, { cost: 10, tons: 10 }))
    const front = frontOf(m, pairs, old, { identityLimit: 2 })
    const before = front.result({ explored: true, feasible: old.length })

    for (const set of [example('new', { cost: 1, tons: 1 }), example('new-1', { cost: 1, tons: 1 }), example('new-2', { cost: 1, tons: 1 })]) {
      front.offer(set)
    }

    const after = front.result({ explored: true, feasible: 7 })
    const member = after.members[0]

    return before.ties.unnamed === 1 && before.status === 'provisional' && after.members.length === 1 && member.name === 'new' && equal(member.identities, ['new-1', 'new-2']) && member.alternativeCount === 2 && after.ties.unnamed === 0 && after.status === 'complete' && equal(after.reasons, []) && /^Efficient among every set/.test(m.pareto.describeFront(after)) && !/same figures/.test(m.pareto.describeFront(after)) ? true : short([before.ties, after.ties, after.status, member.identities, member.alternativeCount])
  }],
  ['the identity limit of a front of tied sets past it is freed when they are beaten', () => {
    const front = frontOf(m, [['cost', 'min'], ['tons', 'min']], Array.from({ length: m.pareto.IDENTITIES_KEPT + 3 }, (_value, index) => example(`t${index}`, { cost: 10, tons: 10 })))
    const before = front.result({ explored: true, feasible: m.pareto.IDENTITIES_KEPT + 3 }).ties.unnamed

    front.offer(example('winner', { cost: 1, tons: 1 }))
    front.offer(example('winner-tie', { cost: 1, tons: 1 }))

    const result = front.result({ explored: true, feasible: m.pareto.IDENTITIES_KEPT + 5 })

    return before === 2 && result.members.length === 1 && equal(result.members[0].identities, ['winner-tie']) && result.ties.unnamed === 0 && result.status === 'complete' ? true : short([result.members.length, result.members[0].identities, result.ties, result.status])
  }],
  ['sets alike beyond the identity limit are counted, not named, and the front is provisional for them', () => {
    const sets = Array.from({ length: 31 }, (_value, index) => example(`t${index}`))
    const result = frontOf(m, SPEED_COST, sets, { identityLimit: 12 }).result({ explored: true, feasible: sets.length })
    const member = result.members[0]
    const words = m.pareto.describeFront(result)

    return member.identities.length === 12 && member.alternativeCount === 30 && result.ties.unnamed === 18 && result.status === 'provisional' && equal(result.reasons, ['ties']) && /^Efficient among every set/.test(words) && /18 sets with the same figures/.test(words) ? true : short([member.identities.length, member.alternativeCount, result.ties, result.reasons, words])
  }],
  ['reversing the direction of an axis reverses what is efficient', () => {
    const sets = [example('cheap', { cost: 5, speed: 500 }), example('mid', { cost: 10, speed: 500 }), example('fast', { cost: 20, speed: 1000 })]
    const held = (pairs) => heldOf(frontOf(m, pairs, sets).result({ explored: true, feasible: 3 }))

    return equal(held([['cost', 'min'], ['speed', 'max']]), ['cheap', 'fast']) && equal(held([['cost', 'max'], ['speed', 'max']]), ['fast']) && equal(held([['cost', 'min'], ['speed', 'min']]), ['cheap']) && same(held([['cost', 'max'], ['speed', 'min']]), ['fast', 'mid'])
  }],
  ['one axis keeps the best and what ties with it', () => same(heldOf(frontOf(m, [['speed', 'max']], [example('a', { speed: 900 }), example('b', { speed: 1000 }), example('c', { speed: 1000 })]).result({ explored: true, feasible: 3 })), ['b', 'c'])],
  ['the order the sets arrive in changes no set held, over 40 orders of 30 sets on three axes in every direction', () => {
    const random = generator(7)
    const sets = grid(random, 30)

    for (const goals of GOAL_COMBINATIONS) {
      const pairs = [['cost', goals[0]], ['tons', goals[1]], ['speed', goals[2]]]
      const expected = namesOf(oracle(sets, axesOf(pairs)).front)

      for (let round = 0; round < 5; round++) {
        const held = heldOf(frontOf(m, pairs, shuffled(sets, random)).result({ explored: true, feasible: sets.length }))

        if (JSON.stringify(held) !== JSON.stringify(expected)) {
          return `${short(pairs)}: ${short(held)} != ${short(expected)}`
        }
      }
    }

    return true
  }],
  ['the front equals the oracle on 300 sets of five axes in each of ten choices of direction', () => {
    const random = generator(11)
    const sets = grid(random, 300)
    const choices = [[['cost', 'min'], ['tons', 'min'], ['speed', 'max'], ['range', 'max'], ['endurance', 'max']], [['cost', 'max'], ['tons', 'min'], ['speed', 'max'], ['range', 'min'], ['endurance', 'max']], [['payload', 'max'], ['cost', 'min']], [['range', 'max'], ['endurance', 'max']], [['speed', 'min'], ['tons', 'max']]]

    for (const pairs of choices) {
      const result = frontOf(m, pairs, sets).result({ explored: true, feasible: sets.length })
      const expected = namesOf(oracle(sets, axesOf(pairs)).front)
      const held = heldOf(result)
      const unnamed = unnamedOf(result)

      if (!held.every((name) => expected.includes(name)) || held.length + unnamed !== expected.length) {
        return `${short(pairs)}: ${held.length} held and ${unnamed} unnamed, ${expected.length} expected`
      }
    }

    return true
  }],
  ['the members come best first on the first axis whichever its direction', () => {
    const sets = [example('b', { cost: 10, speed: 1000 }), example('a', { cost: 10, speed: 1000 }), example('z', { cost: 5, speed: 100 }), example('y', { cost: 7, speed: 500 })]
    const result = frontOf(m, SPEED_COST, sets).result({ explored: true, feasible: 4 })
    const flipped = frontOf(m, [['cost', 'max'], ['speed', 'min']], sets).result({ explored: true, feasible: 4 })

    return equal(result.members.map((member) => member.name), ['z', 'y', 'b']) && same(flipped.members.map((member) => member.name), ['b', 'y', 'z'])
  }],
  ['a set with no fuel has no range or endurance, and takes no part in a comparison on them', () => {
    const front = frontOf(m, [['cost', 'min'], ['endurance', 'max']], [example('fuelled', { cost: 50 }), example('bare', { cost: 1, litres: 0, enduranceHours: 0 }), example('rich', { cost: 60, enduranceHours: 500 })])
    const result = front.result({ explored: true, feasible: 3 })

    return equal(heldOf(result), ['fuelled', 'rich']) && result.unknown.count === 1 && equal(result.unknown.names, ['bare']) && result.unknown.byAxis.endurance === 1 && result.unknown.byAxis.cost === 0 && result.source.compared === 2 ? true : short([heldOf(result), result.unknown, result.source])
  }],
  ['a figure that is not computed is not read as 0 whichever the direction', () => {
    const sets = [example('bare', { litres: 0, rangeKm: 0, enduranceHours: 0 }), example('real', { rangeKm: 5e9, enduranceHours: 100 })]

    return [['min', 'min'], ['max', 'max'], ['min', 'max']].every(([range, endurance]) => equal(heldOf(frontOf(m, [['range', range], ['endurance', endurance]], sets).result({ explored: true, feasible: 2 })), ['real']) === true)
  }],
  ['a set with engines that burn nothing has no endurance and no speed without engines or size', () => {
    const result = frontOf(m, [['endurance', 'max'], ['speed', 'max']], [example('idle', { burnCruise: 0 }), example('unpowered', { power: 0 }), example('sizeless', { totalHS: 0 }), example('whole')]).result({ explored: true, feasible: 4 })

    return equal(heldOf(result), ['whole']) && result.unknown.count === 3 && result.unknown.byAxis.endurance === 2 && result.unknown.byAxis.speed === 2 ? true : short([heldOf(result), result.unknown])
  }],
  ['a figure that is not a finite number is not computed', () => {
    const result = frontOf(m, SPEED_COST, [example('nan', { cost: NaN }), example('inf', { speed: Infinity }), example('fine')]).result({ explored: true, feasible: 3 })

    return equal(heldOf(result), ['fine']) && result.unknown.count === 2
  }],
  ['a set unknown on two axes is counted once and named once, on each axis', () => {
    const result = frontOf(m, [['range', 'max'], ['endurance', 'max']], [example('bare', { litres: 0 }), example('real')]).result({ explored: true, feasible: 2 })

    return result.unknown.count === 1 && result.unknown.byAxis.range === 1 && result.unknown.byAxis.endurance === 1 && same(result.unknown.names, ['bare'])
  }],
  ['the names kept of the sets left out for an unknown figure stop at the number kept and the count goes on', () => {
    const sets = Array.from({ length: m.pareto.DISCARDS_KEPT + 5 }, (_value, index) => example(`u${index}`, { litres: 0 }))
    const result = frontOf(m, [['range', 'max'], ['cost', 'min']], sets).result({ explored: true, feasible: sets.length })

    return result.unknown.count === sets.length && result.unknown.names.length === m.pareto.DISCARDS_KEPT
  }],
  ['the payload of one hull is alike for every set and tells none apart', () => same(heldOf(frontOf(m, [['payload', 'max'], ['cost', 'min']], [example('a', { cost: 5 }), example('b', { cost: 9 })]).result({ explored: true, feasible: 2 })), ['a'])],
  ['a front at its limit leaves out the next set nothing beats, names it and is provisional', () => {
    const sets = [example('a', { cost: 1, speed: 100 }), example('b', { cost: 2, speed: 200 }), example('c', { cost: 3, speed: 300 }), example('d', { cost: 4, speed: 400 }), example('e', { cost: 5, speed: 500 })]
    const result = frontOf(m, SPEED_COST, sets, { limit: 3 }).result({ explored: true, feasible: 5 })

    return equal(result.members.map((member) => member.name), ['a', 'b', 'c']) && result.overflow.count === 2 && equal(result.overflow.names, ['d', 'e']) && result.status === 'provisional' && equal(result.reasons, ['limit']) && result.limit === 3 ? true : short(result)
  }],
  ['a full front still drops a set a member beats, and takes in one that beats members', () => {
    const front = frontOf(m, SPEED_COST, [example('a', { cost: 1, speed: 100 }), example('b', { cost: 2, speed: 200 }), example('c', { cost: 3, speed: 300 })], { limit: 3 })

    front.offer(example('worse', { cost: 9, speed: 50 }))

    const beaten = front.result({ explored: true, feasible: 4 })

    front.offer(example('better', { cost: 0.5, speed: 250 }))

    const taken = front.result({ explored: true, feasible: 5 })

    return beaten.overflow.count === 0 && beaten.status === 'complete' && equal(taken.members.map((member) => member.name), ['better', 'c']) && taken.overflow.count === 0 ? true : short([beaten, taken.members.map((member) => member.name)])
  }],
  ['a front is complete only for a whole domain that its limit did not cut', () => {
    const front = frontOf(m, SPEED_COST, [example('a', { cost: 1, speed: 100 }), example('b', { cost: 2, speed: 200 })])
    const whole = front.result({ explored: true, feasible: 2 })
    const partial = front.result({ explored: false, feasible: 2 })

    return whole.status === 'complete' && equal(whole.reasons, []) && partial.status === 'provisional' && equal(partial.reasons, ['stopped']) && whole.source.kind === 'evaluated' ? true : short([whole.status, partial.status, partial.reasons])
  }],
  ['the words of a complete front say it is efficient among every set that meets the targets, and a provisional one does not', () => {
    const front = frontOf(m, SPEED_COST, [example('a', { cost: 1, speed: 100 }), example('b', { cost: 2, speed: 200 })], { limit: 1 })
    const complete = m.pareto.describeFront(frontOf(m, SPEED_COST, [example('a', { cost: 1, speed: 100 }), example('b', { cost: 2, speed: 200 })]).result({ explored: true, feasible: 2 }))
    const stopped = m.pareto.describeFront(front.result({ explored: false, feasible: 2 }))

    return /^Efficient among every set that meets the targets/.test(complete) && !/Provisional/.test(complete) && /^Provisional/.test(stopped) && !/Efficient among every set/.test(stopped) && /stopped before it explored the whole domain/.test(stopped) && /at most 1 sets/.test(stopped) && /1 more/.test(stopped) ? true : short([complete, stopped])
  }],
  ['the words say how many sets were compared and which figure was missing', () => {
    const result = frontOf(m, [['cost', 'min'], ['endurance', 'max']], [example('a'), example('b', { litres: 0 }), example('c', { litres: 0 })]).result({ explored: true, feasible: 3 })
    const text = m.pareto.describeFront(result, (value) => `<${value}>`)

    return /<1> of the <3> sets that meet the targets were compared/.test(text) && /<2> had no endurance to compare and took no part/.test(text) ? true : text
  }],
  ['the words name the axes with their directions', () => same(m.pareto.describeAxes(axesOf([['tons', 'min'], ['speed', 'max'], ['cost', 'min']])), 'least propulsion tonnage, most speed and least BP')],
  ['a result is a copy: later sets change no earlier result', () => {
    const front = frontOf(m, SPEED_COST, [example('a', { cost: 5, speed: 500 })])
    const early = front.result({ explored: false, feasible: 1 })

    front.offer(example('b', { cost: 1, speed: 900 }))

    return equal(early.members.map((member) => member.name), ['a']) && Object.isFrozen(early) && Object.isFrozen(early.members) && same(front.result({ explored: false, feasible: 2 }).members.map((member) => member.name), ['b'])
  }],
  ['a set that is offered is counted as compared with the members it was set against', () => {
    const front = m.pareto.createFront(axesOf(SPEED_COST), { name: byId })
    const scans = []

    for (const set of [example('a', { cost: 1, speed: 100 }), example('b', { cost: 2, speed: 200 }), example('c', { cost: 3, speed: 300 }), example('d', { cost: 4, speed: 50 })]) {
      front.offer(set)
      scans.push(front.scanned)
    }

    return equal(scans, [0, 1, 2, 1]) ? true : short(scans)
  }],
  ['the sets a front holds include the sets alike them', () => {
    const front = frontOf(m, SPEED_COST, [example('a'), example('b'), example('c', { cost: 20, speed: 2000 })])

    return same(front.sets().map((set) => set.id).sort(), ['a', 'b', 'c'])
  }],
  ['the axes are checked in words: none, an axis that is not offered, one chosen twice, a direction that is neither', () => {
    const attempt = (axes) => {
      try {
        m.pareto.normaliseAxes(axes)

        return null
      } catch (error) {
        return error.message
      }
    }

    return attempt([]) !== null && /not an axis/.test(attempt([{ key: 'hull', goal: 'min' }])) && /twice/.test(attempt([{ key: 'cost', goal: 'min' }, { key: 'cost', goal: 'max' }])) && /'min' or 'max'/.test(attempt([{ key: 'cost', goal: 'up' }])) && /not an axis/.test(attempt([{ key: 'toString', goal: 'min' }])) && attempt([{ key: 'cost', goal: 'min' }]) === null && attempt(null) !== null ? true : short([attempt([]), attempt([{ key: 'hull', goal: 'min' }])])
  }],
  ['a page choice becomes axes in the order they are offered, and a stored choice drops what is not one', () => {
    const axes = m.pareto.axesOf({ speed: 'max', cost: 'min', range: 'off', payload: 'sideways' })
    const kept = m.pareto.normaliseChoice({ speed: 'max', cost: 'down', hull: 'min', tons: 'min' })

    return equal(axes, [{ key: 'cost', goal: 'min' }, { key: 'speed', goal: 'max' }]) && equal(kept, { tons: 'min', speed: 'max' }) && m.pareto.normaliseChoice(null) === undefined && m.pareto.normaliseChoice([1]) === undefined && same(m.pareto.normaliseChoice({}), {})
  }],
]

// ---------- the search ----------

const CASES = [
  ['a range target', { hullHS: 40, speed: 2000, fraction: 0.5, goal: { mode: 'range', value: 3e9 }, share: 0.5, maxCount: 30, tech: TECH, tanks: STOCK_TANKS }],
  ['an endurance target on odd tanks', { hullHS: 60, speed: 1500, fraction: 0.5, goal: { mode: 'endurance', value: 100 }, share: 0.4, minCount: 4, maxCount: 20, tech: TECH, tanks: ODD_TANKS }],
  ['no target', { hullHS: 40, speed: 3000, share: 0.5, maxCount: 25, tech: TECH }],
]

const COMBINATIONS = [
  [['cost', 'min'], ['speed', 'max']],
  [['tons', 'min'], ['speed', 'max']],
  [['tons', 'min'], ['range', 'max']],
  [['cost', 'min'], ['tons', 'min'], ['speed', 'max']],
  [['cost', 'max'], ['speed', 'min']],
  [['cost', 'min'], ['endurance', 'max'], ['range', 'max']],
  [['cost', 'min'], ['tons', 'min'], ['speed', 'max'], ['range', 'max'], ['endurance', 'max']],
]

// A figure made when first asked for, so a check that is not run costs nothing.
const lazy = (make) => {
  let made = false
  let value

  return () => {
    if (!made) {
      value = make()
      made = true
    }

    return value
  }
}

// Every set that meets the targets of `input`, as a search that lists them all returns them.
const everySet = (m, input) => drain(m.search.searchPropulsion({ ...input, keep: 1e9 })).sets

const withFront = (m, input, pairs, extra = {}) => drain(m.search.searchPropulsion({ ...input, axes: axesOf(pairs), ...extra }))

// The names of the sets a front holds, from a search's result.
const heldNames = (_m, efficient) => heldOf(efficient)

// Whether a search's front holds exactly the sets of the oracle's front: each name it holds is the oracle's, and the sets it holds and the sets alike them that it counts without naming are all of them.
const sameFront = (m, efficient, front) => {
  const wanted = new Set(idsOf(m, front))
  const held = heldNames(m, efficient)
  const unnamed = unnamedOf(efficient)

  return held.every((name) => wanted.has(name)) && held.length + unnamed === wanted.size ? true : `${held.length} held and ${unnamed} unnamed, ${wanted.size} expected`
}

// The verdict on a search's front against the oracle's for the same sets: true, or everything that differs (the sets held, the status, the counts of the sets that met the targets, were compared and had no figure).
const frontVerdict = (m, efficient, expected, feasible) => {
  const problems = []
  const sets = sameFront(m, efficient, expected.front)

  if (sets !== true) {
    problems.push(sets)
  }

  if (efficient.status !== 'complete') {
    problems.push(`the front is ${efficient.status}`)
  }

  if (efficient.source.feasible !== feasible || efficient.source.compared !== feasible - expected.unknown) {
    problems.push(`${efficient.source.compared} of ${efficient.source.feasible} compared, ${feasible - expected.unknown} of ${feasible} expected`)
  }

  if (efficient.unknown.count !== expected.unknown) {
    problems.push(`${efficient.unknown.count} unknown, ${expected.unknown} expected`)
  }

  return problems.length ? problems.join('; ') : true
}

const idsOf = (m, sets) => sets.map((set) => m.search.candidateId(set)).sort()

// The biggest number of candidates the search evaluates between two of its steps.
const widestStep = (m, input) => {
  const iterator = m.search.searchPropulsion(input)
  let evaluated = 0
  let widest = 0
  let step = iterator.next()

  while (!step.done) {
    widest = Math.max(widest, step.value.counts.evaluated - evaluated)
    evaluated = step.value.counts.evaluated
    step = iterator.next()
  }

  return widest
}

// The search with the sets of two axes, to compare with the earlier two-axis frontiers.
const dominatesOnShare = (a, b, key) => (a.share < b.share + 1e-9 && a[key] > b[key] - 1e-9) && (a.share < b.share - 1e-9 || a[key] > b[key] + 1e-9)

const searched = (m) => {
  const checks = []

  for (const [label, input] of CASES) {
    const every = lazy(() => everySet(m, input))

    for (const pairs of COMBINATIONS) {
      checks.push([`the front of ${pairs.map(([key, goal]) => `${goal} ${key}`).join(', ')} equals the oracle over every set that meets the targets: ${label}`, () => frontVerdict(m, withFront(m, input, pairs).efficient, oracle(every(), axesOf(pairs)), every().length)])
    }
  }

  const [, range] = CASES[0]
  const rangeOf = lazy(() => everySet(m, range))

  checks.push(['the fronts of the examples are not trivial: one holds sets and drops sets', () => {
    const rangeSets = rangeOf()
    const sizes = COMBINATIONS.map((pairs) => oracle(rangeSets, axesOf(pairs)).front.length)

    return sizes.some((size) => size > 3 && size < rangeSets.length) && sizes.every((size) => size > 0) ? true : short([sizes, rangeSets.length])
  }])

  checks.push(['the front is the same whether the table lists 3 sets or all of them', () => {
    const pairs = [['cost', 'min'], ['tons', 'min'], ['speed', 'max']]
    const rangeSets = rangeOf()
    const few = withFront(m, range, pairs, { keep: 3 })
    const all = withFront(m, range, pairs, { keep: 1e9 })

    return few.sets.length === 3 && all.sets.length === rangeSets.length && JSON.stringify(heldNames(m, few.efficient)) === JSON.stringify(heldNames(m, all.efficient)) && JSON.stringify(few.efficient.members.map((member) => member.name)) === JSON.stringify(all.efficient.members.map((member) => member.name)) && few.efficient.members.some((member) => !few.sets.includes(member.set)) ? true : short([few.sets.length, few.efficient.members.length])
  }])

  checks.push(['the sets the table lists do not limit the front: a table of one set still has the whole front', () => {
    const pairs = [['cost', 'min'], ['speed', 'max']]

    return withFront(m, range, pairs, { keep: 1 }).efficient.members.length === oracle(rangeOf(), axesOf(pairs)).front.length
  }])

  for (const [key, label] of [['speed', 'speed'], ['range', 'range']]) {
    checks.push([`the earlier frontier of share of the ship and ${label} is the front of propulsion tonnage and ${label} once the sets that a same-share set beats are set aside`, () => {
      const result = withFront(m, range, [['tons', 'min'], [key, 'max']])
      const legacy = result.pareto[key]
      const field = key === 'speed' ? 'speed' : 'rangeKm'
      const kept = legacy.filter((set) => !legacy.some((other) => other !== set && dominatesOnShare(other, set, field)))

      return JSON.stringify(idsOf(m, kept)) === JSON.stringify(result.efficient.members.map((member) => member.name).sort()) && legacy.length > 2 ? true : short([idsOf(m, kept).length, result.efficient.members.length, legacy.length])
    }])
  }

  checks.push(['asking for a front changes no other result', () => {
    const plain = drain(m.search.searchPropulsion(range))
    const asked = withFront(m, range, [['cost', 'min'], ['tons', 'min'], ['speed', 'max'], ['range', 'max']])
    const project = (result) => JSON.stringify({ sets: result.sets, lightest: result.lightest, fastest: result.fastest, cheapest: result.cheapest, pareto: result.pareto, packages: result.packages, output: result.output, evaluated: result.counts.evaluated, feasible: result.counts.feasible, termination: result.termination })

    return project(plain) === project(asked) && plain.efficient === null && asked.efficient !== null ? true : 'a result changed'
  }])

  checks.push(['no axes keeps no front', () => drain(m.search.searchPropulsion({ ...range, axes: [] })).efficient === null])

  checks.push(['the sets the front holds count as retained results', () => {
    const plain = drain(m.search.searchPropulsion({ ...range, keep: 1 }))
    const asked = withFront(m, range, [['cost', 'min'], ['speed', 'max']], { keep: 1 })

    return asked.counts.retained > plain.counts.retained ? true : short([plain.counts.retained, asked.counts.retained])
  }])

  checks.push(['a search that stopped at its candidate budget has a provisional front, and says so', () => {
    const result = withFront(m, range, SPEED_COST, { maxCandidates: 40 })
    const text = m.pareto.describeFront(result.efficient)

    return result.termination === 'candidate-budget' && result.efficient.status === 'provisional' && equal(result.efficient.reasons, ['stopped']) && /^Provisional/.test(text) && !/Efficient among every set/.test(text) ? true : short([result.termination, result.efficient.status])
  }])

  checks.push(['the front of a step is provisional, and the front of the finished search is complete', () => {
    const iterator = m.search.searchPropulsion({ ...range, axes: axesOf(SPEED_COST), slice: 40 })
    let step = iterator.next()
    let seen = 0

    while (!step.done) {
      const early = step.value.snapshot().efficient

      if (early.status !== 'provisional' || !early.reasons.includes('stopped')) {
        return `a step's front is ${early.status}`
      }

      seen++
      step = iterator.next()
    }

    return seen > 3 && step.value.efficient.status === 'complete' ? true : short([seen, step.value.efficient.status])
  }])

  checks.push(['a run cancelled part way holds a provisional front, one that finished a complete front', () => {
    const made = runOf(m, { ...range, axes: axesOf(SPEED_COST), slice: 40 })

    made.advance(0)
    made.advance(0)
    made.cancel()

    const cut = made.outcome()
    const done = finish(runOf(m, { ...range, axes: axesOf(SPEED_COST) }))

    return cut.status === 'cancelled' && cut.result.efficient.status === 'provisional' && done.status === 'complete' && done.result.efficient.status === 'complete' ? true : short([cut.status, cut.result && cut.result.efficient.status, done.status])
  }])

  checks.push(['a run stopped at its time budget holds a provisional front', () => {
    const outcome = finish(runOf(m, { ...range, axes: axesOf(SPEED_COST), slice: 40 }, { budget: { candidates: null, ms: 30 }, now: clock(1) }))

    return outcome.status === 'truncated' && outcome.result.efficient.status === 'provisional' && outcome.result.efficient.reasons.includes('stopped') ? true : short([outcome.status, outcome.result && outcome.result.efficient.status])
  }])

  checks.push(['a front cut at its limit is provisional for that reason and holds no more than the limit', () => {
    const cut = withFront(m, range, SPEED_COST, { frontLimit: 2 })
    const complete = withFront(m, range, SPEED_COST)

    return complete.efficient.members.length > 2 && cut.efficient.members.length <= 2 && cut.efficient.status === 'provisional' && equal(cut.efficient.reasons, ['limit']) && cut.efficient.overflow.count > 0 && cut.efficient.overflow.names.length > 0 && cut.termination === 'exhausted' ? true : short([complete.efficient.members.length, cut.efficient.members.length, cut.efficient.reasons])
  }])

  checks.push(['a search with no fuel to size has no range or endurance to compare: no set takes part, and each is counted', () => {
    const [, none] = CASES[2]
    const result = withFront(m, none, [['cost', 'min'], ['endurance', 'max']])
    const { efficient } = result

    return efficient.members.length === 0 && efficient.unknown.count === result.counts.feasible && efficient.unknown.byAxis.endurance === result.counts.feasible && efficient.unknown.byAxis.cost === 0 && efficient.source.compared === 0 && efficient.status === 'complete' && result.counts.feasible > 0 && /had no endurance to compare/.test(m.pareto.describeFront(efficient)) ? true : short([efficient.members.length, efficient.unknown, result.counts.feasible])
  }])

  checks.push(['an engine stored without a cost is no engine of no cost: its sets are unknown on BP, and a cost of 0 is a cost', () => {
    const base = { hullHS: 100, speed: 100, share: 0.5, maxCount: 5, tech: TECH }
    const engine = (cost) => ({ id: 99, name: 'Stored', sizeHS: 1, power: 100, fuelPerEph: 1, cost, crew: 1, thermalRating: 1, thrust: 1, commercial: false })
    const pairs = [['cost', 'min'], ['speed', 'max']]
    const unknown = withFront(m, { ...base, engine: engine(null) }, pairs).efficient
    const free = withFront(m, { ...base, engine: engine(0) }, pairs).efficient
    const priced = withFront(m, { ...base, engine: engine(7) }, pairs).efficient

    return unknown.source.feasible === 5 && unknown.unknown.count === 5 && unknown.unknown.byAxis.cost === 5 && unknown.source.compared === 0 && unknown.members.length === 0 && free.unknown.count === 0 && free.members.length === 1 && free.members[0].set.cost === 0 && free.members[0].set.costKnown === undefined && priced.unknown.count === 0 && priced.members.length >= 1 ? true : short([unknown.unknown, unknown.members.length, free.unknown.count, free.members.length, priced.unknown.count])
  }])

  checks.push(['an engine stored without a cost leaves the other axes to compare its sets', () => {
    const engine = { id: 99, name: 'Stored', sizeHS: 1, power: 100, fuelPerEph: 1, cost: null, crew: 1, thermalRating: 1, thrust: 1, commercial: false }
    const { efficient } = withFront(m, { hullHS: 100, speed: 100, share: 0.5, maxCount: 5, tech: TECH, engine }, [['tons', 'min'], ['speed', 'max']])

    return efficient.unknown.count === 0 && efficient.source.compared === 5 && efficient.members.length >= 1
  }])

  checks.push(['the words of an empty front say why: nothing met the targets, the search stopped, or no set met them with the figures picked', () => {
    const none = CASES[2][1]
    const noFuel = withFront(m, none, [['cost', 'min'], ['endurance', 'max']]).efficient
    const unreachable = withFront(m, { ...none, speed: 1e9 }, SPEED_COST).efficient
    const early = withFront(m, none, SPEED_COST, { maxCandidates: 0 }).efficient
    const words = [m.pareto.describeEmpty(noFuel), m.pareto.describeEmpty(unreachable), m.pareto.describeEmpty(early)]

    return noFuel.members.length === 0 && words[0] === `None of the ${noFuel.source.feasible} sets that meet the targets has endurance to compare.` && words[0] !== words[1] && words[1] === 'No set meets the targets.' && unreachable.status === 'complete' && /^The search stopped before it found a set that meets the targets\.$/.test(words[2]) && early.status === 'provisional' ? true : short(words)
  }])

  checks.push(['the verdict on a front rejects a front that is right in its sets and wrong in what it says about them', () => {
    const [, range] = CASES[0]
    const every = everySet(m, range)
    const expected = oracle(every, axesOf(SPEED_COST))
    const { efficient } = withFront(m, range, SPEED_COST)
    const altered = (changes) => ({ ...efficient, ...changes })
    const right = frontVerdict(m, efficient, expected, every.length)
    const rejected = [altered({ status: 'provisional' }), altered({ unknown: { ...efficient.unknown, count: 1 } }), altered({ source: { ...efficient.source, compared: efficient.source.compared - 1 } }), altered({ source: { ...efficient.source, feasible: every.length + 1 } })].map((front) => frontVerdict(m, front, expected, every.length))

    return right === true && rejected.every((verdict) => verdict !== true && typeof verdict === 'string') ? true : short([right, rejected])
  }])

  checks.push(['the front of a step counts against the step: a big front ends a step in fewer candidates', () => {
    const [, none] = CASES[2]
    const without = widestStep(m, { ...none, slice: 40 })
    const big = widestStep(m, { ...none, slice: 40, axes: axesOf([['cost', 'min'], ['tons', 'min'], ['speed', 'max']]) })

    return big < without ? true : short([without, big])
  }])

  checks.push(['the axes are part of what a run is: a change of axis or of direction is another run', () => {
    const key = (axes) => m.search.propulsionRun({ ...range, axes: axesOf(axes) }).descriptor.inputKey
    const plain = m.search.propulsionRun(range).descriptor.inputKey

    const again = key(SPEED_COST)

    return new Set([plain, key(SPEED_COST), key([['cost', 'max'], ['speed', 'max']]), key([['speed', 'max'], ['cost', 'min']])]).size === 4 && key(SPEED_COST) === again
  }])

  checks.push(['axes that cannot be compared fail the search in words', () => {
    try {
      drain(m.search.searchPropulsion({ ...range, axes: [{ key: 'speed', goal: 'up' }] }))

      return 'the search ran'
    } catch (error) {
      const failed = finish(runOf(m, { ...range, axes: [{ key: 'hull', goal: 'min' }] }))

      return /min' or 'max/.test(error.message) && failed.status === 'failed' && /not an axis/.test(failed.error) ? true : short([error.message, failed.status, failed.error])
    }
  }])

  return checks
}

const synthetic = (m) => [...pure(m).map(([name, test]) => [name, test]), ...searched(m).map(([name, test]) => [name, test])]

// ---------- the page ----------

const PAGE_STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

// What the search needs of the page, as a pseudo instance has it (a field of the instance stands in for what the page would compute).
const READY = { ready: true, hullReady: true, speedReady: true, existingEngine: null, designTech: TECH, sweepHasErrors: false, hullHS: 40, speed: 2000, fraction: 0.5, goal: { mode: 'range', value: 3e9 }, engineLimits: { kind: 'either', min: 1, max: 30, share: 0.5, include: 'grid' }, sweep: null, tanks: STOCK_TANKS, techLevels: {} }

// A statement of the page, to be settled when asked: one that throws is a statement that does not hold, not a script that stops.
const attempt = (statement) => () => {
  try {
    return statement()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const pageStatements = async (mutate, mods, sources = {}) => {
  const options = await loadPage('pages/propulsion', { stubs: PAGE_STUBS, mutate, sources })
  const page = (data = {}) => instantiate(options, { $store: { getters: {}, state: {} }, database: {}, GameID: 1, RaceID: 2, data })
  const [, input] = CASES[0]
  const pairs = [['tons', 'min'], ['speed', 'max']]
  const shown = (axes, extra = {}) => {
    const result = drain(mods.search.searchPropulsion({ ...input, axes: axesOf(axes), ...extra }))

    return Object.freeze({ ...result, input: { engineTechName: 'Tech' }, run: { incomplete: false } })
  }

  const whole = lazy(() => shown(pairs))
  const early = lazy(() => shown(pairs, { maxCandidates: 40 }))

  return [
    ['no axis picked compares nothing, and one axis compares nothing either', attempt(() => page().efficientAxes.length === 0 && page({ paretoAxes: { speed: 'max' } }).efficientAxes.length === 0)],
    ['two axes or more are the axes of the search, in the order the axes are offered and with the direction picked', attempt(() => same(page({ paretoAxes: { speed: 'max', cost: 'min', range: 'min' } }).efficientAxes, [{ key: 'cost', goal: 'min' }, { key: 'speed', goal: 'max' }, { key: 'range', goal: 'min' }]))],
    ['each axis offered shows whether it is off, least or most', attempt(() => same(page({ paretoAxes: { cost: 'min', speed: 'max' } }).paretoChoices.map(({ key, pick }) => `${key}:${pick}`), ['cost:min', 'tons:off', 'speed:max', 'range:off', 'endurance:off', 'payload:off']))],
    ['an axis turned on, turned the other way and turned off', attempt(() => {
      const vm = page()

      vm.setParetoAxis('cost', 'min')
      vm.setParetoAxis('speed', 'max')

      const on = { ...vm.paretoAxes }

      vm.setParetoAxis('cost', 'max')

      const flipped = { ...vm.paretoAxes }

      vm.setParetoAxis('speed', 'off')

      return JSON.stringify([on, flipped, vm.paretoAxes]) === JSON.stringify([{ cost: 'min', speed: 'max' }, { cost: 'max', speed: 'max' }, { cost: 'max' }]) ? true : short([on, flipped, vm.paretoAxes])
    })],
    ['the search the page starts has the axes picked', attempt(() => {
      const vm = page({ ...READY, paretoAxes: { cost: 'min', speed: 'max' } })

      return same(vm.searchInput.axes, [{ key: 'cost', goal: 'min' }, { key: 'speed', goal: 'max' }])
    })],
    ['the search the page starts with one axis picked keeps no front', attempt(() => {
      const made = runOf(mods, page({ ...READY, paretoAxes: { speed: 'max' } }).searchInput)

      return finish(made).result.efficient === null
    })],
    ['the search the page starts with two axes picked ends with the front of those axes', attempt(() => {
      const outcome = finish(runOf(mods, page({ ...READY, paretoAxes: { cost: 'min', speed: 'max' } }).searchInput))
      const expected = oracle(everySet(mods, input), axesOf(SPEED_COST)).front.length

      return outcome.status === 'complete' && equal(outcome.result.efficient.axes, [{ key: 'cost', goal: 'min' }, { key: 'speed', goal: 'max' }]) && outcome.result.efficient.members.length + outcome.result.efficient.members.reduce((total, member) => total + member.alternativeCount, 0) === expected ? true : short([outcome.status, outcome.result.efficient.members.length, expected])
    })],
    ['the columns of the table are the axes of the result shown, not the axes picked since', attempt(() => {
      const texts = page({ result: whole(), paretoAxes: { cost: 'min', range: 'max' } }).efficientHeaders.map((header) => header.text)

      return texts.includes('Propulsion tons') && texts.includes('Speed (km/s)') && !texts.includes('BP') && !texts.includes('Range (bn km)') ? true : short(texts)
    })],
    ['a front of a whole domain is not provisional, and one of a search that stopped early is', attempt(() => page({ result: whole() }).efficientProvisional === false && page({ result: early() }).efficientProvisional === true && page({ result: null }).efficientProvisional === false)],
    ['the words of a front are those of its status', attempt(() => /^Efficient among every set/.test(page({ result: whole() }).efficientNote) && /^Provisional/.test(page({ result: early() }).efficientNote) && page({ result: null }).efficientNote === '')],
    ['a set has a row for each member, named by its candidate id, with the sets alike it', attempt(() => {
      const [first, ...others] = whole().efficient.members
      const ids = Array.from({ length: 21 }, (_value, index) => `x${index}`)
      const alike = Object.freeze({ ...first, alternatives: [Object.freeze({ name: ids[0], set: first.set })], identities: ids, alternativeCount: 21 })
      const held = [alike, ...others]
      const vm = page({ result: Object.freeze({ ...whole(), efficient: Object.freeze({ ...whole().efficient, members: held }) }), fraction: 0.5 })
      const rows = vm.efficientRows

      return rows.length === held.length && rows.every((row, at) => row.key === held[at].name && row.alternativeCount === held[at].alternativeCount && row.alternatives.length === held[at].alternatives.length && row.alternativesMore === held[at].alternativeCount - held[at].alternatives.length && row.payload === 40) && rows.length > 2 && rows[0].alternativeCount === 21 && rows[0].alternativesMore === 20 && equal(rows[0].alternativeIds, ids.slice(1)) ? true : short([rows.length, held.length, rows[0] && rows[0].alternativeCount])
    })],
    ['the table says why it is empty: nothing met the targets, the search stopped, or every set lacked a figure picked', attempt(() => {
      const empty = (axes, sets, explored) => {
        const front = mods.pareto.createFront(axesOf(axes), { name: byId })

        sets.forEach((set) => front.offer(set))

        return page({ result: Object.freeze({ ...whole(), efficient: front.result({ explored, feasible: sets.length }) }) }).efficientEmpty
      }
      const bare = [example('a', { litres: 0 }), example('b', { litres: 0 }), example('c', { litres: 0 })]
      const words = [empty(SPEED_COST, [], true), empty(SPEED_COST, [], false), empty([['cost', 'min'], ['endurance', 'max']], bare, true), page({ result: null }).efficientEmpty]

      return words[0] === 'No set meets the targets.' && /stopped before it found a set/.test(words[1]) && words[2] === 'None of the 3 sets that meet the targets has endurance to compare.' && words[3] === '' ? true : short(words)
    })],
    ['no result has no rows', attempt(() => page({ result: null }).efficientRows.length === 0)],
    ['the CSV of the sets writes a name with a carriage return and an assumption that starts like a formula as the shared writer does', attempt(() => {
      const figure = (assumptions) => ({ status: 'confirmed', value: 1, rule: { id: 'rule', versions: ['1'] }, assumptions, inputs: { missing: [] } })
      const provenance = { speed: figure(['=HYPERLINK("x")']), burn: figure([]), rangeBn: figure([]), enduranceDays: figure([]), cost: figure([]), tanks: null }
      const row = { pinned: false, rank: 1, name: 'a\rb', count: 2, thrust: 1, power: 10, fuelPerEph: 1, propulsionHS: 5, share: 0.5, provenance, crew: 3, type: 'Commercial', tankPackage: null }
      const vm = page({ rows: [row] })
      const saved = { document: globalThis.document, Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
      let text = null

      globalThis.document = { createElement: () => ({ click() {} }) }
      globalThis.Blob = class { constructor (parts) { text = parts.join('') } }
      URL.createObjectURL = () => 'blob:test'
      URL.revokeObjectURL = () => {}

      try {
        vm.downloadCsv()
      } finally {
        globalThis.document = saved.document
        globalThis.Blob = saved.Blob
        URL.createObjectURL = saved.create
        URL.revokeObjectURL = saved.revoke
      }

      const records = strictRecords(text)
      const [header, cells] = records

      return records.length === 2 && header.length === cells.length && cells[1] === 'a\rb' && cells[header.indexOf('Assumptions')] === '\'=HYPERLINK("x")' ? true : short(records)
    })],
  ]
}

// A cut of the page's script and the statements that must fail for it, as the mutations of the utilities above.
const PAGE_MUTATIONS = [
  { name: 'the search not given the axes picked', find: 'axes: this.efficientAxes,', replace: 'axes: EMPTY_LIST,', fails: ['the search the page starts has the axes picked', 'the search the page starts with two axes picked ends with the front'] },
  { name: 'one axis compared as if it were two', find: 'return axes.length >= 2 ? axes : EMPTY_LIST', replace: 'return axes.length >= 1 ? axes : EMPTY_LIST', fails: ['no axis picked compares nothing, and one axis compares nothing either', 'the search the page starts with one axis picked keeps no front'] },
  { name: 'the columns of the axes picked since instead of the axes of the result', find: 'const axes = this.efficient ? this.efficient.axes : EMPTY_LIST', replace: 'const axes = this.efficientAxes', fails: ['the columns of the table are the axes of the result shown'] },
  { name: 'a provisional front not told from a complete one', find: 'return this.efficient !== null && this.efficient.status === \'provisional\'', replace: 'return false', fails: ['a front of a whole domain is not provisional'] },
  { name: 'an axis that is turned off kept', find: 'if (pick === \'off\') {\n        delete next[key]', replace: 'if (false) {\n        delete next[key]', fails: ['an axis turned on, turned the other way and turned off'] },
  { name: 'the sets alike a member not counted in its row', find: 'alternativeCount: member.alternativeCount, alternatives: named', replace: 'alternativeCount: 0, alternatives: named', fails: ['a set has a row for each member'] },
  { name: 'the table not saying why it is empty', find: "return this.efficient ? describeEmpty(this.efficient, (value) => this.count(value)) : ''", replace: "return this.efficient ? 'No set meets the targets.' : ''", fails: ['the table says why it is empty'] },
  { name: 'the candidate ids of the sets alike a set left off its row', find: 'alternativeIds: member.identities.slice(named.length, named.length + ALTERNATIVE_IDS_SHOWN)', replace: 'alternativeIds: EMPTY_LIST', fails: ['a set has a row for each member'] },
  { name: 'the CSV of the sets not written by the shared writer', find: 'line.map((value) => csvCell(value)).join(\',\')', replace: 'line.join(\',\')', fails: ['the CSV of the sets writes a name with a carriage return'] },
  { name: 'the CSV of the sets does not quote a carriage return', file: 'csv-cell.js', find: '/[",\\r\\n]/.test(text)', replace: '/[",\\n]/.test(text)', fails: ['the CSV of the sets writes a name with a carriage return'] },
  { name: 'the CSV of the sets does not guard a text that starts like a formula', file: 'csv-cell.js', find: 'guard && typeof value === \'string\' && FORMULA_START.test(value)', replace: 'false', fails: ['the CSV of the sets writes a name with a carriage return'] },
  { name: 'the axes offered not in the order of the registry', find: 'return Object.entries(PARETO_AXES).map(([key, axis]) => ({ key, label: axis.label, pick: this.paretoAxes[key] || \'off\' }))', replace: 'return Object.entries(PARETO_AXES).reverse().map(([key, axis]) => ({ key, label: axis.label, pick: this.paretoAxes[key] || \'off\' }))', fails: ['each axis offered shows whether it is off, least or most'] },
]

// ---------- mutations of the utilities ----------

const modulesOf = (utilities) => ({ pareto: utilities.pareto, search: utilities['design-search'], run: utilities['search-run'], rules: utilities['design-rules'] })

// A cut of a utility and the checks that must fail for it: each name is the start of the name of a check, and the cut is caught only when a check of every name fails.
const MUTATIONS = [
  { name: 'a direction read the wrong way round', file: 'pareto.js', find: 'sign: goal === \'max\' ? 1 : -1', replace: 'sign: goal === \'max\' ? -1 : 1', fails: ['reversing the direction of an axis reverses', 'the members come best first'] },
  { name: 'an axis compared without the other axes once one beats', file: 'pareto.js', find: 'axis < width && (ahead === 0 || behind === 0)', replace: 'axis < width && ahead === 0', fails: ['the front equals the oracle on 300 sets'] },
  { name: 'a set that is no better and worse on one kept beside the better set', file: 'pareto.js', find: '        if (behind === 0) {\n          if (ahead === 0) {', replace: '        if (behind === 0 && ahead === 0) {\n          if (ahead === 0) {', fails: ['a set that is no better on any axis and worse on one is dropped'] },
  { name: 'the sets alike a member not counted', file: 'pareto.js', find: 'member.alternativeCount++', replace: 'member.alternativeCount += 0', fails: ['the names kept of sets alike stop at the number kept and the count goes on', 'every set alike on the axes picked is named'] },
  { name: 'the sets alike a member not named', file: 'pareto.js', find: 'member.identities.push(label)', replace: 'void 0', fails: ['sets alike on every axis picked stay together', 'every set alike on the axes picked is named'] },
  { name: 'the sets described of the sets alike not bounded', file: 'pareto.js', find: 'if (member.alternatives.length < ALTERNATIVES_KEPT) {', replace: 'if (true) {', fails: ['the names kept of sets alike stop at the number kept and the count goes on'] },
  { name: 'the identity limit not enforced', file: 'pareto.js', find: 'if (named >= identityLimit) {', replace: 'if (false) {', fails: ['sets alike beyond the identity limit are counted'] },
  { name: 'the sets left unnamed not a reason to call the front provisional', file: 'pareto.js', find: '...(unnamed ? [\'ties\'] : [])', replace: '...[]', fails: ['sets alike beyond the identity limit are counted'] },
  { name: 'the names of a beaten member not given back to the identity limit', file: 'pareto.js', find: '            named -= members[at].identities.length\n', replace: '', fails: ['a member that is beaten takes its sets alike with it', 'the identity limit of a front of tied sets past it is freed'] },
  { name: 'the sets a beaten member left unnamed still counted', file: 'pareto.js', find: '            unnamed -= members[at].alternativeCount - members[at].identities.length\n', replace: '', fails: ['a member that is beaten takes its sets alike with it', 'the identity limit of a front of tied sets past it is freed'] },
  { name: 'the sets left unnamed not counted', file: 'pareto.js', find: '              unnamed++\n', replace: '              unnamed += 0\n', fails: ['sets alike beyond the identity limit are counted'] },
  { name: 'a figure that is not computed read as 0', file: 'pareto.js', find: 'unknown.byAxis[specs[axis].key]++\n          missing++', replace: 'unknown.byAxis[specs[axis].key]++\n          probe[axis] = 0', fails: ['a set with no fuel has no range or endurance', 'a figure that is not computed is not read as 0'] },
  { name: 'a set without fuel given an endurance', file: 'pareto.js', find: 'const burns = (set) => set.power > 0 && set.burnFull > 0 && set.litres > 0', replace: 'const burns = (set) => set.power > 0 && set.burnFull > 0', fails: ['a set with no fuel has no range or endurance'] },
  { name: 'a figure that is not finite taken as known', file: 'pareto.js', find: 'const known = (value) => (Number.isFinite(value) ? value : null)', replace: 'const known = (value) => (value === undefined ? null : value)', fails: ['a figure that is not a finite number is not computed'] },
  { name: 'a set that is not computed not counted', file: 'pareto.js', find: '        unknown.count++\n', replace: '        unknown.count += 0\n', fails: ['a set with no fuel has no range or endurance', 'a set unknown on two axes'] },
  { name: 'the sets compared counted with those left out', file: 'pareto.js', find: 'compared: feasible - unknown.count', replace: 'compared: feasible', fails: ['a set with no fuel has no range or endurance', 'the words say how many sets were compared'] },
  { name: 'the members a new set beats left in the front', file: 'pareto.js', find: '      if (doomed.length) {', replace: '      if (false) {', fails: ['a set that beats several members'] },
  { name: 'figures not put on the grid', file: 'pareto.js', find: 'Math.sign(value) * Math.round(size / step) * step', replace: 'value', fails: ['a sum that differs from another in its last digits is alike', 'sets that differ in their last digits are held as the oracle holds them'] },
  { name: 'a cost not known taken as a cost', file: 'pareto.js', find: '(set.costKnown === false ? null : known(set.cost))', replace: 'known(set.cost)', fails: ['an engine stored without a cost is no engine of no cost'] },
  { name: 'the cost of an engine stored without one not told from a cost', file: 'design-search.js', find: '            ...(costKnown ? null : UNKNOWN_COST),\n', replace: '', fails: ['an engine stored without a cost is no engine of no cost'] },
  { name: 'an empty front that says nothing met the targets whatever it lacks', file: 'pareto.js', find: 'if (source.feasible === 0) {', replace: 'if (true) {', fails: ['the words of an empty front say why'] },
  { name: 'the limit of the front not enforced', file: 'pareto.js', find: 'if (members.length >= limit) {', replace: 'if (members.length > limit) {', fails: ['a front at its limit leaves out the next set'] },
  { name: 'a front cut at its limit not provisional', file: 'pareto.js', find: '...(overflow.count ? [\'limit\'] : [])', replace: '...[]', fails: ['a front at its limit leaves out the next set', 'a front cut at its limit is provisional for that reason'] },
  { name: 'a front of a search that stopped not provisional', file: 'pareto.js', find: '...(explored ? [] : [\'stopped\'])', replace: '...[]', fails: ['a front is complete only for a whole domain', 'a search that stopped at its candidate budget'] },
  { name: 'the members not counted as compared with', file: 'pareto.js', find: '        scanned++\n', replace: '        scanned += 0\n', fails: ['a set that is offered is counted as compared'] },
  { name: 'the same axis chosen twice accepted', file: 'pareto.js', find: 'if (chosen.has(axis.key)) {', replace: 'if (false) {', fails: ['the axes are checked in words'] },
  { name: 'an axis the registry does not have accepted', file: 'pareto.js', find: '!Object.prototype.hasOwnProperty.call(catalogue, axis.key)', replace: '!catalogue[axis.key]', fails: ['the axes are checked in words'] },
  { name: 'the words of a provisional front saying it is efficient', file: 'pareto.js', find: 'if (!front.reasons.includes(\'stopped\') && !front.reasons.includes(\'limit\')) {', replace: 'if (true) {', fails: ['the words of a complete front say it is efficient'] },
  { name: 'the front built from the sets the table lists alone', file: 'design-search.js', find: '          if (front) {\n            front.offer(set)', replace: '          if (front && wantsRank) {\n            front.offer(set)', fails: ['the front is the same whether the table lists 3 sets', 'the sets the table lists do not limit the front'] },
  { name: 'a set that is not wanted by the ranking or the frontiers not offered to the front', file: 'design-search.js', find: 'wantsRangeFrontier || front) {', replace: 'wantsRangeFrontier) {', fails: ['the front of min cost, max speed equals the oracle'] },
  { name: 'a front of a search that stopped taken for a whole domain', file: 'design-search.js', find: 'explored: termination === TERMINATION.EXHAUSTED', replace: 'explored: true', fails: ['a search that stopped at its candidate budget', 'the front of a step is provisional'] },
  { name: 'the work of the front not counted against a step', file: 'design-search.js', find: 'const FRONT_WORK = 0.01', replace: 'const FRONT_WORK = 0', fails: ['the front of a step counts against the step'] },
  { name: 'the sets of the front not retained', file: 'design-search.js', find: '      for (const set of front.sets()) {\n        held.add(set)\n      }\n', replace: '', fails: ['the sets the front holds count as retained results'] },
  { name: 'the front limit not given to the front', file: 'design-search.js', find: 'createFront(axes, { limit: frontLimit, name: candidateId })', replace: 'createFront(axes, { name: candidateId })', fails: ['a front cut at its limit is provisional for that reason'] },
  { name: 'the front named by something else than the candidate', file: 'design-search.js', find: 'name: candidateId })', replace: 'name: () => \'x\' })', fails: ['the front of min cost, max speed equals the oracle'] },
]

// The source of the utility `file` (a name with its .js) with `from` replaced by `to`, for loadUtilities' `sources`: the others load from the folder as they are.
const mutatedSources = (file, from, to) => {
  const source = fs.readFileSync(path.join(utilitiesDirectory, file), 'utf8')

  if (!source.includes(from)) {
    throw new Error(`The mutation does not apply to ${file}: ${from}`)
  }

  return { [file.replace(/\.js$/, '')]: source.replace(from, () => to) }
}

// ---------- the saves ----------

const DEFAULT_INPUT = { hullHS: 100, speed: 2500, fraction: 0.5, goal: { mode: 'range', value: 5e9 }, kind: 'either', minCount: 1, maxCount: 100, share: 0.5 }

const ANCHORS = {
  'AuroraDB.db:140:784': { evaluated: 168284, matched: 141201, digest: 'db517f092dd4a48c' },
  'AuroraDB_271_skoormit_saved.db:138:785': { evaluated: 64779, matched: 49905, digest: '20a9ab5a6d9e3308' },
}

const digest = ({ sets, lightest, fastest, cheapest, pareto, packages, counts }) => crypto.createHash('sha256').update(JSON.stringify({ sets, lightest, fastest, cheapest, pareto, packages, evaluated: counts.evaluated, matched: counts.feasible })).digest('hex').slice(0, 16)

const DEFAULT_TECH = { minThrust: 0.5, maxThrust: 1, maxSize: 25, thermalTech: 1, thermalCost: 1 }

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

// ---------- the parts: each mutant, the checks of the real sources and each save run in a process of their own ----------

const MUTANTS = [...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })), ...PAGE_MUTATIONS.map((mutation, index) => ({ kind: 'page', id: `page:${index}`, ...mutation }))]

const checkHead = async (mods) => {
  console.log('The comparison and the search')

  for (const [name, test] of synthetic(mods)) {
    let result

    try {
      result = test()
    } catch (error) {
      result = `threw ${error.stack}`
    }

    check(name, result)
  }

  console.log('\nThe propulsion page (its script on a pseudo instance, scripts/lib/page-loader.js)')

  for (const [statement, held] of await pageStatements(null, mods)) {
    check(`page: ${statement}`, held())
  }
}

const checkUtilityMutation = async ({ name, file, find, replace, fails }) => {
  const sources = mutatedSources(file, find, replace)
  const began = Date.now()
  let failed = null
  let absent = []

  try {
    const mutant = modulesOf(await loadUtilities(NAMES, { sources }))

    // Only the checks the mutation names are run: the others cannot change what it must break.
    const named = synthetic(mutant).filter(([checkName]) => fails.some((start) => checkName.startsWith(start)))

    absent = fails.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))

    failed = named.filter(([, test]) => {
      try {
        return test() !== true
      } catch (error) {
        return true
      }
    }).map(([checkName]) => checkName)
  } catch (error) {
    check(`mutation caught: ${name}`, `does not load: ${error.message}`)

    return
  }

  const missed = fails.filter((start) => !failed.some((checkName) => checkName.startsWith(start)))

  check(`mutation caught: ${name}`, absent.length ? `no check begins ${absent.join('; ')}` : missed.length ? `these checks did not fail: ${missed.join('; ')}` : true, `${failed.length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const checkPageMutation = async ({ name, file = null, find, replace, fails }, mods) => {
  const began = Date.now()
  let failed = null
  let absent = []

  try {
    const faulted = file ? await pageStatements(null, mods, { 'utilities/csv-cell': Object.values(mutatedSources(file, find, replace))[0] }) : await pageStatements(replacing(find, replace), mods)
    const named = faulted.filter(([statement]) => fails.some((start) => statement.startsWith(start)))

    absent = fails.filter((start) => !named.some(([statement]) => statement.startsWith(start)))
    failed = named.filter(([, held]) => held() !== true).map(([statement]) => statement)
  } catch (error) {
    check(`page mutation caught: ${name}`, `does not load: ${error.message}`)

    return
  }

  const missed = fails.filter((start) => !failed.some((statement) => statement.startsWith(start)))

  check(`page mutation caught: ${name}`, absent.length ? `no statement begins ${absent.join('; ')}` : missed.length ? `these statements did not fail: ${missed.join('; ')}` : true, `${failed.length} statements fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
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

  // A small part of the race's grid, so the enumeration can walk it.
  const small = { ...designTech, maxSize: Math.min(3, designTech.maxSize), maxThrust: Math.min(designTech.maxThrust, Math.max(designTech.minThrust, 0.7)) }

  const domains = [
    ['a range target on the race\'s tanks', { hullHS: 40, speed: 2000, fraction: 0.5, goal: { mode: 'range', value: 3e9 }, share: 0.5, maxCount: 30, tech: small, tanks }],
    ['an endurance target', { hullHS: 60, speed: 1500, fraction: 0.5, goal: { mode: 'endurance', value: 100 }, share: 0.4, minCount: 4, maxCount: 20, tech: small, tanks }],
  ]

  for (const [name, input] of domains) {
    const every = everySet(mods, input)

    for (const pairs of [COMBINATIONS[1], COMBINATIONS[3], COMBINATIONS[6]]) {
      const expected = oracle(every, axesOf(pairs))
      const { efficient } = withFront(mods, input, pairs)
      check(`${label}: the front of ${pairs.map(([key, goal]) => `${goal} ${key}`).join(', ')} equals the oracle over every set that meets the targets: ${name} (${expected.front.length} of ${every.length})`, frontVerdict(mods, efficient, expected, every.length))
    }
  }

  const input = { ...DEFAULT_INPUT, tech: designTech, tanks }
  const anchor = ANCHORS[`${path.basename(file)}:${GameID}:${RaceID}`]
  const asked = finish(runOf(mods, { ...input, axes: axesOf(COMBINATIONS[1]) }))
  const { efficient } = asked.result
  const legacy = asked.result.pareto.speed
  const kept = legacy.filter((set) => !legacy.some((other) => other !== set && dominatesOnShare(other, set, 'speed')))

  check(`${label}: the default search with a front of tonnage and speed is complete (${efficient.members.length} efficient sets of ${efficient.source.compared} compared)`, asked.status === 'complete' && efficient.status === 'complete' && efficient.source.feasible === asked.counts.feasible ? true : short([asked.status, efficient.status]))
  check(`${label}: its front is the earlier frontier of share and speed, less the sets a same-share set beats`, JSON.stringify(idsOf(mods, kept)) === JSON.stringify(efficient.members.map((member) => member.name).sort()) ? true : `${kept.length} against ${efficient.members.length}`)

  if (anchor) {
    const result = asked.result

    check(`${label}: the default search with a front gives the result taken before fronts existed`, result.counts.evaluated === anchor.evaluated && result.counts.feasible === anchor.matched && digest(result) === anchor.digest ? true : `${result.counts.evaluated}/${result.counts.feasible}/${digest(result)} vs ${anchor.evaluated}/${anchor.matched}/${anchor.digest}`, `${anchor.evaluated} evaluated, ${anchor.matched} matched, digest ${anchor.digest}`)
  } else {
    console.log('SKIP  no digest of the unchanged search is recorded for this save')
  }

  const cut = runOf(mods, { ...input, axes: axesOf(COMBINATIONS[3]) })

  cut.advance(0)
  cut.cancel()

  check(`${label}: a default search stopped at its first step has a provisional front`, cut.outcome().result.efficient.status === 'provisional' ? true : short(cut.outcome().result.efficient.status))

  database.close()
}

const SAVE_LABELS = ['modded', 'stock']

// One part, in this process: `head`, a mutant by its id or a save by its label.
const runPart = async (part, options) => {
  const mutant = MUTANTS.find(({ id }) => id === part)

  if (mutant && mutant.kind === 'utility') {
    await checkUtilityMutation(mutant)

    return
  }

  const utilities = await loadUtilities([...NAMES, 'design-data', 'race-tech'])
  const mods = modulesOf(utilities)

  if (part === 'head') {
    await checkHead(mods)
  } else if (mutant) {
    await checkPageMutation(mutant, mods)
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

  // The longest parts first: the saves, then the checks of the real sources, then the mutants.
  const parts = [{ part: 'head', weight: 30 }, ...MUTANTS.map(({ id }) => ({ part: id, weight: 3 })), ...SAVE_LABELS.map((label) => ({ part: label, weight: 60 }))]
  const sections = await runSections(__filename, parts.map(({ part, weight }) => ({ args: ['--part', part, ...forwardedSaves(options)], weight })))
  const printed = (index) => {
    const counts = printSection(sections[index])

    checks += counts.checks
    failures += counts.failures
  }

  printed(0)
  console.log('\nMutations: each must fail the checks it names')

  for (let index = 1; index <= MUTANTS.length; index++) {
    printed(index)
  }

  for (let index = MUTANTS.length + 1; index < sections.length; index++) {
    printed(index)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
