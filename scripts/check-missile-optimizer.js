/*
  Checks the bounded role-based missile optimisation (utilities/missile-optimizer.js), the coverage of the launching ship's sensors (utilities/launcher-coverage.js) and their panel on the missile designer page (pages/missile-designer.vue).

  node scripts/check-missile-optimizer.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>] [--no-mutations]

  Groups:
  - domain: the swept figures and options of a request are read as the sweep domain reads them, a field that is wrong is reported with its own message and no search runs, the count of the domain is the product of its axes and its signature is the same for the same domain;
  - goals: on a small domain that an enumeration can walk (every candidate through the missile rules, the limits applied and each goal's ranking worked out apart from the search), each of the five goals selects the optimum of the enumeration under its limits and its stated ties, lists the same top candidates in the same order, finds the same number of candidates within the limits and keeps the same efficient front for each choice of axes; the pruning of the search (more fuel only makes size, cost, speed and hit chance worse) rules out nothing the enumeration keeps;
  - cheapest: a candidate with no warhead has no BP per warhead, is rejected as undefined and is never listed, and a domain of such candidates finds none;
  - unreachable: a hit chance the combat model never reaches is infeasible with its reason, a hit chance the domain does not reach is infeasible with the best it does reach;
  - keep: the number of results kept changes only the listed top candidates, never what was explored, the counts, the status or the front;
  - incomplete: a run that was cancelled, stopped at a budget or replaced keeps its incomplete status in its table, its CSV (on every row), its copied text and its sentence, and says none was found so far where none was; an exhausted run says it is complete;
  - unknown: a tech level the save lacks leaves the candidates unknown, never ranked and never 0, with the reason;
  - coverage: the launching ship's fire control and search sensor reach a target by the sensor model, apart from the missile's own sensor, an unknown figure is unknown and never 0, and the module depends on the rules alone, not on the designer or the search;
  - nominate: the best candidates are nominated as alternatives of the designer beside the baseline, at most three, the baseline stays the saved design with its figures, and the designer's own figures for a nominated candidate are those the search listed;
  - the page: the form, the run, its status, its exports and its nominations on a pseudo instance (scripts/lib/page-loader.js).

  Mutants: each deliberate fault in a copy of the utilities (or of the page's script) is run, in a process of its own (--run-mutant), with the checks it names, and must fail them. Prints `N of N checks passed`; exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')
const { jobs, inParallel, runChild } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

let failures = 0
let checks = 0
let skips = 0

const isSkip = (result) => result !== null && typeof result === 'object' && typeof result.skipped === 'string'

const skipped = (reason) => ({ skipped: reason })

const check = (name, result, detail = '') => {
  if (isSkip(result)) {
    skips++
    console.log(`SKIP  ${name}  [${result.skipped}]`)

    return
  }

  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 360 ? `${text.slice(0, 360)}…` : text
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value)

const equal = (actual, expected) => JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const close = (a, b, tolerance = 1e-9) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))

const settle = async (test) => {
  try {
    return await test()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const LOADED = ['missile-optimizer', 'launcher-coverage', 'missile-designer', 'design-rules', 'design-data', 'missile-hit', 'provenance', 'search-run', 'pareto', 'sweep-domain', 'tech-scenarios']

const loadAll = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(LOADED, { stubs: STUBS, directory })

  return { directory, opt: loaded['missile-optimizer'], lc: loaded['launcher-coverage'], md: loaded['missile-designer'], dr: loaded['design-rules'], dd: loaded['design-data'], hit: loaded['missile-hit'], pv: loaded.provenance, sr: loaded['search-run'], pa: loaded.pareto, sd: loaded['sweep-domain'], ts: loaded['tech-scenarios'] }
}

// ---------- the runs ----------

const UNBOUNDED = { candidates: null, ms: null }

// A clock that moves by `step` milliseconds each time it is read.
const clock = (step = 1) => {
  let time = 0

  return () => (time += step)
}

const finish = (m, input, options = {}) => {
  const run = m.opt.missileRun(input, { budget: UNBOUNDED, now: clock(1), ...options })

  run.advance(Infinity)

  return run.outcome()
}

// ---------- the request ----------

const TECH = { engine: 10, fuel: 1, maxThrust: 3, warhead: 4, laserEfficiency: 1, reactor: 1, active: 1, thermal: 1, em: 1, geo: 1, eccm: 3, terminal: 1.5, retarget: null }

const FIELDS = (over = {}) => ({ goal: 'warhead', keep: '10', engineMsp: { min: '1', max: '2', step: '1' }, thrust: { min: '1', max: '2', step: '1' }, engines: { min: '1', max: '2', step: '1' }, fuelMsp: { min: '1', max: '6', step: '1' }, warheadMsp: { min: '0', max: '3', step: '1' }, warheads: { min: '1', max: '2', step: '1' }, eccm: 'either', terminal: 'off', laser: 'off', maxMsp: '14', maxBp: '', minRangeKm: '', minSpeed: '', hitChance: '40', axes: null, ...over })

const SCENARIO = { targetSpeed: '2000', jammer: '0', modifier: '1', pd: '0', targetSignature: '' }

const requestOf = (m, over = {}, extra = {}) => m.opt.readRequest({ fields: FIELDS(over), scenario: SCENARIO, tech: TECH, ...extra })

const inputOf = (m, over = {}, extra = {}) => {
  const request = requestOf(m, over, extra)

  if (!request.ok) {
    throw new Error(`the request is not ok: ${short(request.errors)}`)
  }

  return request.input
}

// ---------- the oracle: every candidate of the domain through the missile rules, ranked apart from the search ----------

const stepsOf = ({ min, max, step }) => {
  const values = []
  const from = Number(min)
  const to = Number(max)
  const by = String(step).trim() === '' ? 1 : Number(step)

  for (let at = 0; from + at * by <= to + 1e-9; at++) {
    values.push(from + at * by)
  }

  return values
}

const optionsOf = (mode, absent, level) => (mode === 'off' ? [absent] : mode === 'on' ? [level] : [absent, level])

const candidateOf = (tech, v) => ({
  engine: { sizeMsp: v.engineMsp, thrust: v.thrust, engineTech: tech.engine, fuelTech: tech.fuel, maxThrust: tech.maxThrust },
  engines: v.engines,
  fuelMsp: v.fuelMsp,
  warheadMsp: v.warheadMsp,
  warheads: v.warheadMsp > 0 ? v.warheads : 1,
  shipDecoy: false,
  decoys: 0,
  activeMsp: 0,
  thermalMsp: 0,
  emMsp: 0,
  geoMsp: 0,
  sizeLimit: 0,
  stage: null,
  stages: 0,
  options: { eccm: v.eccm, terminal: v.terminal, retarget: 0, laser: v.laser },
  tech: { warhead: tech.warhead, laserEfficiency: tech.laserEfficiency, reactor: tech.reactor, active: tech.active, thermal: tech.thermal, em: tech.em, geo: tech.geo },
  sensor: { resolution: null, emSensitivity: tech.em },
  groundPod: false,
  enhancedRadiation: false,
})

const idOf = (v) => `m:${Math.round(v.engineMsp * 1000)}:${Math.round(v.thrust * 1000)}:${v.engines}:${Math.round(v.warheadMsp * 1000)}:${v.warheadMsp > 0 ? v.warheads : 0}:${v.eccm}:${Math.round(v.terminal * 1000)}:${v.laser ? 1 : 0}:${Math.round(v.fuelMsp * 1000)}`

const valueOf = (m, result) => m.pv.valueOrNull(result)

// The tie-breaks of each goal as the page states them, worked out here from the figures of a candidate alone.
const KEYS = {
  warhead: (f) => [-f.damage, -f.hitChance, f.cost, f.size],
  fastest: (f) => [-f.speed, -f.maxRange, f.cost, f.size],
  range: (f) => [-f.maxRange, -f.speed, f.cost, f.size],
  cheapest: (f) => [f.costPerWarhead, -f.damage, f.size, f.cost],
  reference: (f, reference) => {
    const parts = ['speed', 'maxRange', 'damage'].filter((name) => reference[name] > 0).map((name) => Math.abs(f[name] - reference[name]) / reference[name])

    return [Math.max(...parts), parts.reduce((sum, part) => sum + part, 0), f.cost, f.size]
  },
}

const compareLists = (a, b) => {
  for (let at = 0; at < a.length; at++) {
    if (a[at] !== b[at]) {
      return a[at] < b[at] ? -1 : 1
    }
  }

  return 0
}

// Every candidate of the fields' domain with its figures, and which of them meet the limits, in the order the goal ranks them.
const enumerate = (m, fields, scenario, tech, _reference = null, extra = {}) => {
  const levelOf = { eccm: Math.trunc(tech.eccm), terminal: tech.terminal, laser: true }
  const absent = { eccm: 0, terminal: 1, laser: false }
  const limits = { maxMsp: Number(fields.maxMsp), maxBp: fields.maxBp === '' ? null : Number(fields.maxBp), minRangeKm: fields.minRangeKm === '' ? null : Number(fields.minRangeKm), minSpeed: fields.minSpeed === '' ? null : Number(fields.minSpeed), hitChance: fields.hitChance === '' ? null : Number(fields.hitChance) }
  const all = []

  for (const engineMsp of stepsOf(fields.engineMsp)) {
    for (const thrust of stepsOf(fields.thrust)) {
      for (const engines of stepsOf(fields.engines)) {
        for (const warheadMsp of stepsOf(fields.warheadMsp)) {
          for (const warheads of stepsOf(fields.warheads)) {
            if (warheadMsp === 0 && warheads !== stepsOf(fields.warheads)[0]) {
              continue
            }

            for (const eccm of optionsOf(fields.eccm, absent.eccm, levelOf.eccm)) {
              for (const terminal of optionsOf(fields.terminal, absent.terminal, levelOf.terminal)) {
                for (const laser of optionsOf(fields.laser, absent.laser, levelOf.laser)) {
                  for (const fuelMsp of stepsOf(fields.fuelMsp)) {
                    const values = { engineMsp, thrust, engines, fuelMsp, warheadMsp, warheads, eccm, terminal, laser }
                    const evaluation = m.dr.evaluateMissile({ ...candidateOf(tech, values), ...extra }, { budget: { maxMsp: limits.maxMsp, maxBp: limits.maxBp } })

                    all.push({ id: idOf(values), values, evaluation })
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const carriedOf = (v) => (v.warheadMsp > 0 ? v.warheads : 0)

  for (const item of all) {
    const { values, evaluation } = item
    const figures = evaluation.figures
    const totals = evaluation.totals
    const damage = valueOf(m, values.laser ? figures.laserWarhead : figures.warheadStrength)

    item.unknown = evaluation.verdict === 'unknown'
    item.admitted = evaluation.verdict === 'feasible'
    item.carried = carriedOf(values)

    if (item.unknown) {
      continue
    }

    item.figures = { size: valueOf(m, totals.size), cost: valueOf(m, totals.cost), speed: valueOf(m, figures.speed), maxRange: valueOf(m, figures.maxRange), damage, costPerWarhead: item.carried > 0 ? valueOf(m, totals.cost) / item.carried : null }

    if (item.admitted) {
      item.figures.hitChance = m.hit.hitScenario({ missile: { key: 'x', name: 'x', kind: 'candidate', speed: item.figures.speed, atg: values.terminal, eccm: values.eccm, warheads: Math.max(1, item.carried), shipDecoy: false, obsolete: false, secondStageId: 0, secondStages: 0 }, targetSpeed: scenario.targetSpeed, jammer: scenario.jammer, modifier: scenario.modifier, version: null }).capped.value
    }
  }

  return { all, limits }
}

const withinLimits = (item, limits, goal, withHit = true) => item.admitted && (limits.minSpeed === null || item.figures.speed >= limits.minSpeed) && (limits.minRangeKm === null || item.figures.maxRange >= limits.minRangeKm) && !(goal === 'cheapest' && item.carried === 0) && (!withHit || limits.hitChance === null || item.figures.hitChance + 1e-9 >= limits.hitChance)

const rankedOf = (list, goal, reference) => list.slice().sort((a, b) => compareLists([...KEYS[goal](a.figures, reference)], [...KEYS[goal](b.figures, reference)]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const cache = new WeakMap()

// The oracle of a request over the module set `m`: `{ feasible (ranked), within (every candidate within the limits but the hit chance), all, ties }`.
const oracle = (m, over = {}, reference = null, scenario = SCENARIO, tech = TECH, extra = {}) => {
  const fields = FIELDS(over)
  const key = JSON.stringify([fields, reference, scenario, tech, extra])

  if (!cache.has(m)) {
    cache.set(m, new Map())
  }

  if (!cache.get(m).has(key)) {
    const { all, limits } = enumerate(m, fields, scenario, tech, reference, extra)
    const within = all.filter((item) => withinLimits(item, limits, fields.goal, false))
    const feasible = rankedOf(all.filter((item) => withinLimits(item, limits, fields.goal)), fields.goal, reference)
    const ties = []

    for (let at = 1; at < feasible.length; at++) {
      if (compareLists(KEYS[fields.goal](feasible[at - 1].figures, reference), KEYS[fields.goal](feasible[at].figures, reference)) === 0) {
        ties.push([feasible[at - 1].id, feasible[at].id])
      }
    }

    cache.get(m).set(key, { all, within, feasible, ties, limits })
  }

  return cache.get(m).get(key)
}

// The front of the candidates on `axes` ([{ key, goal }]) from the figures alone: every pair compared on the grid of 2^30 cells to a power of two that the front calls alike.
const cellOf = (value) => {
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

const AXIS_FIGURE = { damage: (f) => f.damage, speed: (f) => f.speed, range: (f) => f.maxRange, hitChance: (f) => f.hitChance, cost: (f) => f.cost, size: (f) => f.size, costPerWarhead: (f) => f.costPerWarhead }

const frontOracle = (feasible, axes) => {
  const known = feasible.filter((item) => axes.every(({ key }) => AXIS_FIGURE[key](item.figures) !== null && AXIS_FIGURE[key](item.figures) !== undefined))
  const sign = { min: -1, max: 1 }
  const beats = (a, b) => {
    let better = false

    for (const { key, goal } of axes) {
      const first = cellOf(AXIS_FIGURE[key](a.figures) * sign[goal])
      const second = cellOf(AXIS_FIGURE[key](b.figures) * sign[goal])

      if (first < second) {
        return false
      }

      better = better || first > second
    }

    return better
  }

  return known.filter((item) => !known.some((other) => other !== item && beats(other, item))).map((item) => item.id).sort()
}

const heldIds = (front) => front.members.flatMap((member) => [member.name, ...member.identities]).sort()

const unnamed = (front) => front.members.reduce((total, member) => total + member.alternativeCount - member.identities.length, 0)

// ---------- the checks of the domain ----------

const domainChecks = (m) => [
  ['domain: the swept figures and options are read into a sweep whose count is the product of its axes', () => {
    const plan = m.opt.missileSweep({ fields: FIELDS(), tech: TECH })
    const counts = m.opt.AXIS_ORDER.map((name) => stepsOf(FIELDS()[name]).length)
    const optionCount = 2

    return plan.ok && plan.total === counts.reduce((product, count) => product * count, 1) * optionCount ? true : short([plan.ok, plan.total, counts, plan.errors])
  }],
  ['domain: the same fields give the same signature and another domain another', () => {
    const a = m.opt.missileSweep({ fields: FIELDS(), tech: TECH })
    const b = m.opt.missileSweep({ fields: FIELDS(), tech: TECH })
    const c = m.opt.missileSweep({ fields: FIELDS({ fuelMsp: { min: '1', max: '7', step: '1' } }), tech: TECH })
    const d = m.opt.missileSweep({ fields: FIELDS({ terminal: 'on' }), tech: TECH })

    return a.signature === b.signature && a.signature !== c.signature && a.signature !== d.signature ? true : short([a.signature, c.signature, d.signature])
  }],
  ['domain: a field that is wrong is reported by its own message and no search is run', () => {
    const wrong = requestOf(m, { engineMsp: { min: 'x', max: '2', step: '1' }, keep: '0', maxMsp: '', hitChance: '', goal: 'warhead' })

    return !wrong.ok && wrong.input === null && wrong.errors['engineMsp.min'] && wrong.errors.keep && wrong.errors.maxMsp && wrong.errors.hitChance && !wrong.errors.goal ? true : short(wrong.errors)
  }],
  ['domain: a blank step is a single value only where the minimum and the maximum are the same, an option asked for without its tech level is refused', () => {
    const single = m.opt.missileSweep({ fields: FIELDS({ warheads: { min: '2', max: '2', step: '' } }), tech: TECH })
    const open = m.opt.missileSweep({ fields: FIELDS({ warheads: { min: '1', max: '2', step: '' } }), tech: TECH })
    const noTech = m.opt.missileSweep({ fields: FIELDS({ terminal: 'on' }), tech: { ...TECH, terminal: null } })
    const noEngine = m.opt.missileSweep({ fields: FIELDS(), tech: { ...TECH, engine: null } })

    return single.ok && !open.ok && open.errors['warheads.step'] && !noTech.ok && noTech.errors.terminal && !noEngine.ok && noEngine.errors.tech ? true : short([single.ok, open.errors, noTech.errors, noEngine.errors])
  }],
  ['domain: a candidate has one name whatever else is searched, and the names of a domain are unique', () => {
    const small = finish(m, inputOf(m, { goal: 'fastest', hitChance: '', keep: '1000' }))
    const large = finish(m, inputOf(m, { goal: 'fastest', hitChance: '', keep: '1000', fuelMsp: { min: '1', max: '7', step: '1' } }))
    const names = small.result.entries.map((entry) => entry.id)
    const inLarge = new Set(large.result.entries.map((entry) => entry.id))
    const expected = oracle(m, { goal: 'fastest', hitChance: '', keep: '1000' }).feasible.map((item) => item.id)

    return new Set(names).size === names.length && names.every((name) => inLarge.has(name)) && equal(names.slice().sort(), expected.slice().sort()) ? true : short([names.length, expected.length])
  }],
]

// ---------- the goals ----------

const REFERENCE = { id: null, name: 'Reference', speed: 6000, maxRange: 900000000, damage: 5, size: 12, cost: 4 }

// What each goal is asked for: the fields it changes from the defaults and the reference it matches.
const CASES = [
  ['the greatest warhead at a hit chance', { goal: 'warhead', hitChance: '40', keep: '25' }],
  ['the greatest warhead at a hit chance under a BP limit and a least speed', { goal: 'warhead', hitChance: '40', maxBp: '3', minSpeed: '3000', keep: '25' }],
  ['the fastest under a least range', { goal: 'fastest', hitChance: '', minRangeKm: '600000000', keep: '25' }],
  ['the longest range under a least speed and a BP limit', { goal: 'range', hitChance: '', minSpeed: '3000', maxBp: '4', keep: '25' }],
  ['the longest range under a size limit of 8 MSP', { goal: 'range', hitChance: '', maxMsp: '8', keep: '25' }],
  ['the cheapest per warhead', { goal: 'cheapest', hitChance: '', keep: '25' }],
  ['the cheapest per warhead at a hit chance under a size limit', { goal: 'cheapest', hitChance: '20', maxMsp: '10', keep: '25' }],
  ['the match of a reference missile', { goal: 'reference', hitChance: '', maxMsp: '12', keep: '25' }, REFERENCE],
]

const goalRun = (m, over, reference) => {
  const outcome = finish(m, inputOf(m, over, reference ? { reference } : {}))

  return outcome
}

const listOf = (list, count) => list.slice(0, count).map((item) => item.id)

const goalChecks = (m) => [
  ...CASES.map(([label, over, reference]) => [`goals: ${label} selects the optimum and lists the top candidates of the enumeration`, () => {
    const expected = oracle(m, over, reference)
    const outcome = goalRun(m, over, reference)
    const result = outcome.result
    const keep = Number(over.keep)
    const top = listOf(expected.feasible, keep)
    const figures = result.entries.every((entry, at) => ['size', 'cost', 'speed', 'maxRange', 'damage', 'hitChance'].every((name) => close(entry.figures[name], expected.feasible[at].figures[name])))

    return outcome.status === 'complete' && expected.feasible.length > 0 && equal(result.entries.map((entry) => entry.id), top) && result.counts.feasible === expected.feasible.length && result.outcomes.feasible === expected.feasible.length && (result.best ? result.best.id : null) === expected.feasible[0].id && figures ? true : short([outcome.status, result.entries.map((entry) => entry.id).slice(0, 4), top.slice(0, 4), result.counts.feasible, expected.feasible.length])
  }, 'matches the enumeration']),
  ['goals: a tie on every figure of a goal is ordered by the names of the candidates, and the domain has such ties', () => {
    const tied = CASES.flatMap(([, over, reference]) => oracle(m, over, reference).ties)

    return tied.length > 0 && tied.every(([first, second]) => first < second) ? true : short(tied.length)
  }],
  ['goals: the front of every choice of axes equals the front of the enumeration', () => {
    const choices = [[['damage', 'max'], ['cost', 'min']], [['speed', 'max'], ['range', 'max']], [['size', 'min'], ['hitChance', 'max'], ['cost', 'min']], [['costPerWarhead', 'min'], ['damage', 'max']], [['range', 'max'], ['cost', 'min'], ['speed', 'max'], ['hitChance', 'min']]]
    const problems = []

    for (const pairs of choices) {
      const axes = pairs.map(([key, goal]) => ({ key, goal }))

      for (const [label, over, reference] of CASES.filter((_case, at) => [0, 3, 5].includes(at))) {
        const outcome = goalRun(m, { ...over, axes }, reference)
        const front = outcome.result.front
        const expected = frontOracle(oracle(m, over, reference).feasible, axes)

        if (!equal(heldIds(front), expected) || unnamed(front) !== 0 || front.status !== 'complete') {
          problems.push([label, pairs.map((pair) => pair.join(' ')).join(', '), heldIds(front).length, expected.length, front.status])
        }
      }
    }

    return problems.length === 0 ? true : short(problems)
  }],
  ['goals: the front of a goal without chosen axes is the front of its own axes', () => {
    const problems = []

    for (const [label, over, reference] of CASES) {
      const outcome = goalRun(m, over, reference)
      const own = m.opt.GOALS[over.goal].axes.filter(({ key }) => key !== 'deviation')
      const expected = own.length === m.opt.GOALS[over.goal].axes.length ? frontOracle(oracle(m, over, reference).feasible, own) : null

      if (expected && !equal(heldIds(outcome.result.front), expected)) {
        problems.push(label)
      }
    }

    return problems.length === 0 ? true : short(problems)
  }],
  ['goals: the pruning of the search keeps every candidate within the limits that the enumeration keeps', () => {
    const over = { goal: 'range', hitChance: '', minRangeKm: '500000000', minSpeed: '2500', maxBp: '4', maxMsp: '11', keep: '1000' }
    const expected = oracle(m, over)
    const outcome = goalRun(m, over)
    const result = outcome.result

    return expected.feasible.length > 0 && equal(result.entries.map((entry) => entry.id).sort(), expected.feasible.map((item) => item.id).sort()) && result.counts.pruned > 0 && result.counts.evaluated + result.counts.pruned === result.counts.total ? true : short([result.counts, expected.feasible.length])
  }],
  ['goals: a candidate listed is one the rules admit within the budget', () => {
    const over = { goal: 'warhead', hitChance: '40', maxBp: '3', keep: '1000' }
    const input = inputOf(m, over)
    const outcome = finish(m, input)
    const { admitted } = m.opt.admitEntries(input, outcome.result.entries)

    return outcome.result.entries.length > 0 && admitted.length === outcome.result.entries.length ? true : short([admitted.length, outcome.result.entries.length])
  }],
  ['goals: candidates that tie on every figure are ordered by their names, whatever order they were found in', () => {
    const over = { goal: 'warhead', hitChance: '1', maxMsp: '40', keep: '1000', engineMsp: { min: '5', max: '10', step: '5' }, thrust: { min: '1', max: '1', step: '' }, engines: { min: '1', max: '2', step: '1' }, fuelMsp: { min: '2', max: '4', step: '2' }, warheadMsp: { min: '1', max: '1', step: '' }, warheads: { min: '1', max: '1', step: '' }, eccm: 'off' }
    const expected = oracle(m, over)
    const outcome = goalRun(m, over)
    const crossed = expected.ties.filter(([first, second]) => first.startsWith('m:10000:') && second.startsWith('m:5000:'))

    return crossed.length > 0 && equal(outcome.result.entries.map((entry) => entry.id), expected.feasible.map((item) => item.id)) ? true : short([crossed.length, outcome.result.entries.slice(0, 3).map((entry) => entry.id), expected.feasible.slice(0, 3).map((item) => item.id)])
  }],
  ['goals: the front is offered every candidate within the limits, not those listed', () => {
    const over = { goal: 'fastest', hitChance: '', keep: '1' }
    const outcome = goalRun(m, over)
    const expected = frontOracle(oracle(m, over).feasible, m.opt.GOALS.fastest.axes)

    return heldIds(outcome.result.front).length === expected.length && expected.length > 1 && outcome.result.entries.length === 1 ? true : short([heldIds(outcome.result.front).length, expected.length])
  }],
]

// ---------- the cheapest per warhead, the unreachable hit chance, the number kept ----------

const cheapestChecks = (m) => [
  ['cheapest: a candidate with no warhead has no BP per warhead, is rejected as undefined and is never listed', () => {
    const over = { goal: 'cheapest', hitChance: '', keep: '1000' }
    const expected = oracle(m, over)
    const outcome = goalRun(m, over)
    const result = outcome.result
    const zero = expected.all.filter((item) => item.admitted && item.carried === 0 && withinLimits({ ...item, carried: 1 }, expected.limits, 'range', false)).length

    return zero > 0 && result.outcomes.undefined === zero && result.entries.length > 0 && result.entries.every((entry) => entry.figures.warheadsCarried > 0 && entry.figures.costPerWarhead !== null && entry.figures.costPerWarhead > 0) && result.counts.feasible === expected.feasible.length ? true : short([zero, result.outcomes.undefined, result.counts.feasible, expected.feasible.length])
  }],
  ['cheapest: the same domain for another goal lists the candidates with no warhead', () => {
    const outcome = goalRun(m, { goal: 'fastest', hitChance: '', keep: '1000' })

    return outcome.result.entries.some((entry) => entry.figures.warheadsCarried === 0) && outcome.result.outcomes.undefined === 0 ? true : short(outcome.result.outcomes)
  }],
  ['cheapest: a domain of candidates with no warhead finds none and says why', () => {
    const outcome = goalRun(m, { goal: 'cheapest', hitChance: '', warheadMsp: { min: '0', max: '0', step: '' }, warheads: { min: '1', max: '3', step: '1' } })
    const result = outcome.result

    return result.counts.feasible === 0 && result.entries.length === 0 && result.best === null && result.outcomes.undefined > 0 && result.infeasible && result.infeasible.kind === 'limits' && outcome.status === 'complete' && /no warhead/i.test(result.infeasible.reasonText || m.opt.describeInfeasible(result)) ? true : short([result.counts, result.outcomes, result.infeasible, m.opt.describeInfeasible(result)])
  }],
  ['cheapest: the cheapest per warhead is the least of BP over warheads carried', () => {
    const outcome = goalRun(m, { goal: 'cheapest', hitChance: '', keep: '1' })
    const best = outcome.result.best
    const all = oracle(m, { goal: 'cheapest', hitChance: '' }).feasible.map((item) => item.figures.cost / item.carried)

    return best && close(best.figures.costPerWarhead, Math.min(...all)) ? true : short([best && best.figures.costPerWarhead, Math.min(...all)])
  }],
]

const unreachableChecks = (m) => [
  ['unreachable: a hit chance above the cap of the combat model is infeasible and nothing is evaluated', () => {
    const outcome = goalRun(m, { goal: 'warhead', hitChance: '100.5', keep: '5' })
    const result = outcome.result

    return outcome.status === 'complete' && result.infeasible && result.infeasible.kind === 'hit-cap' && result.counts.evaluated === 0 && result.counts.pruned === result.counts.total && result.counts.unexplored === 0 && result.entries.length === 0 && /Infeasible/.test(m.opt.describeStatus(outcome)) ? true : short([outcome.status, result.infeasible, result.counts])
  }],
  ['unreachable: the cap itself is a hit chance a candidate can reach only as the model gives it', () => {
    const outcome = goalRun(m, { goal: 'warhead', hitChance: '100', keep: '5' })
    const expected = oracle(m, { goal: 'warhead', hitChance: '100', keep: '5' })

    return outcome.result.counts.feasible === expected.feasible.length ? true : short([outcome.result.counts.feasible, expected.feasible.length])
  }],
  ['unreachable: a hit chance the domain does not reach is infeasible with the best it does reach', () => {
    const base = oracle(m, { goal: 'warhead', hitChance: '', keep: '5' })
    const best = Math.max(...base.within.map((item) => item.figures.hitChance))
    const request = String(Math.floor(best) + 1)
    const outcome = goalRun(m, { goal: 'warhead', hitChance: request, keep: '5' })
    const result = outcome.result

    return best < 99 && result.infeasible && result.infeasible.kind === 'hit-unreachable' && close(result.infeasible.bestHit, best) && result.counts.feasible === 0 && result.entries.length === 0 && oracle(m, { goal: 'warhead', hitChance: request }).feasible.length === 0 && outcome.status === 'complete' ? true : short([best, request, result.infeasible, result.counts.feasible])
  }],
  ['unreachable: the best hit chance the domain reaches is itself feasible', () => {
    const base = oracle(m, { goal: 'warhead', hitChance: '', keep: '5' })
    const best = Math.max(...base.within.map((item) => item.figures.hitChance))
    const outcome = goalRun(m, { goal: 'warhead', hitChance: String(best), keep: '1000' })
    const expected = oracle(m, { goal: 'warhead', hitChance: String(best), keep: '1000' })

    return outcome.result.counts.feasible === expected.feasible.length && expected.feasible.length > 0 && outcome.result.infeasible === null ? true : short([outcome.result.counts.feasible, expected.feasible.length])
  }],
  ['unreachable: a hit chance that is not known for the scenario is infeasible and never read as 0', () => {
    const input = inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' })
    const staged = { ...input, base: { ...input.base, stages: 1 }, stage: { missing: true } }
    const outcome = finish(m, staged)

    return outcome.result.infeasible && ['hit-unknown', 'unsupported'].includes(outcome.result.infeasible.kind) && outcome.result.counts.feasible === 0 ? true : short(outcome.result.infeasible)
  }],
]

const keepChecks = (m) => [
  ['keep: the number of results kept changes only the listed candidates, never what was explored', () => {
    const base = { goal: 'warhead', hitChance: '40' }
    const outcomes = [1, 3, 7, 50, 1000].map((keep) => finish(m, inputOf(m, { ...base, keep: String(keep) })))
    const strip = (result) => ({ counts: { ...result.counts, retained: null }, outcomes: result.outcomes, reach: result.reach, infeasible: result.infeasible, termination: result.termination, front: result.front })
    const full = outcomes[outcomes.length - 1].result.entries.map((entry) => entry.id)
    const problems = []

    outcomes.forEach((outcome, at) => {
      const keep = [1, 3, 7, 50, 1000][at]

      if (!equal(strip(outcome.result), strip(outcomes[0].result)) || outcome.status !== outcomes[0].status || m.opt.searchLine(outcome) !== m.opt.searchLine(outcomes[0]) || !equal(outcome.result.entries.map((entry) => entry.id), full.slice(0, keep)) || outcome.result.output.limit !== keep || outcome.result.output.omitted !== Math.max(0, outcome.result.counts.feasible - keep)) {
        problems.push(keep)
      }
    })

    return problems.length === 0 && full.length > 50 ? true : short([problems, full.length])
  }],
  ['keep: a cancelled run keeps the counts and the status whatever number is kept', () => {
    const part = (keep) => cancelledRun(m, { goal: 'fastest', hitChance: '', keep: String(keep) })
    const a = part(1)
    const b = part(20)
    const strip = (outcome) => ({ counts: { ...outcome.result.counts, retained: null }, status: outcome.status, termination: outcome.termination, line: m.opt.searchLine(outcome), front: outcome.result.front })

    return equal(strip(a), strip(b)) && a.result.entries.length === 1 && b.result.entries.length > 1 ? true : short([strip(a).counts, strip(b).counts])
  }],
  ['keep: more than the greatest number is refused with its message', () => {
    const wrong = requestOf(m, { keep: '1001' })
    const right = requestOf(m, { keep: '1000' })

    return !wrong.ok && wrong.errors.keep && right.ok ? true : short([wrong.errors, right.ok])
  }],
]

// ---------- a run that is not whole ----------

const cancelledRun = (m, over, options = {}) => {
  const run = m.opt.missileRun(inputOf(m, over), { budget: UNBOUNDED, now: clock(1), slice: 5, ...options })

  run.advance(0)
  run.cancel()

  return run.outcome()
}

// A CSV read apart from the code that wrote it: quoted cells, doubled quotes, rows ending at a new line.
const parseCsv = (text) => {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let at = 0; at < text.length; at++) {
    const letter = text[at]

    if (quoted) {
      if (letter === '"' && text[at + 1] === '"') {
        cell += '"'
        at++
      } else if (letter === '"') {
        quoted = false
      } else {
        cell += letter
      }
    } else if (letter === '"') {
      quoted = true
    } else if (letter === ',') {
      row.push(cell)
      cell = ''
    } else if (letter === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += letter
    }
  }

  row.push(cell)
  rows.push(row)

  return rows
}

const incompleteChecks = (m) => [
  ['incomplete: a cancelled run is incomplete and says so in its table, its CSV on every row, its copied text and its sentence', () => {
    const outcome = cancelledRun(m, { goal: 'fastest', hitChance: '', keep: '5' })
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)
    const header = rows[0]
    const searchAt = header.indexOf('Search')
    const table = m.opt.tableOf(outcome)
    const data = rows.slice(1)

    return outcome.status === 'cancelled' && outcome.incomplete && outcome.termination === 'cancelled' && outcome.counts.evaluated > 0 && outcome.counts.unexplored > 0 && searchAt === header.length - 1 && data.length === outcome.result.entries.length && data.every((row) => row.length === header.length && row[searchAt].startsWith('incomplete (cancelled): ')) && exported.status.startsWith('incomplete (cancelled): ') && exported.text.includes(exported.status) && /Incomplete \(cancelled\)/.test(m.opt.describeStatus(outcome)) && table.incomplete === true && table.status === exported.status ? true : short([outcome.status, outcome.counts, header.length, data.length, data[0] && data[0][searchAt], table.incomplete, table.status])
  }],
  ['incomplete: a cancelled run that found nothing says none was found so far, in every export', () => {
    const outcome = cancelledRun(m, { goal: 'cheapest', hitChance: '', keep: '5' })
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)
    const searchAt = rows[0].indexOf('Search')
    const status = m.opt.describeStatus(outcome)

    return outcome.result.counts.feasible === 0 && outcome.result.counts.evaluated > 0 && rows.length === 2 && rows[1][searchAt].startsWith('incomplete (cancelled)') && rows[1].includes('none found so far') && /none found so far/.test(exported.text) && /None found so far\./.test(exported.text) && /none found so far/.test(status) && !/none meets the limits/i.test(exported.text) && !/Infeasible/.test(status) ? true : short([outcome.result.counts, rows.length, status])
  }],
  ['incomplete: a run stopped at its candidate budget is truncated with the evaluated count equal to the budget', () => {
    const outcome = finish(m, inputOf(m, { goal: 'fastest', hitChance: '', keep: '5' }), { budget: { candidates: 40, ms: null } })
    const exported = m.opt.exportOutcome(outcome)

    return outcome.status === 'truncated' && outcome.termination === 'candidate-budget' && outcome.incomplete && outcome.result.counts.evaluated === 40 && outcome.result.counts.unexplored > 0 && exported.status.startsWith('incomplete (candidate-budget): ') && parseCsv(exported.csv).slice(1).every((row) => row[row.length - 1] === exported.status) ? true : short([outcome.status, outcome.termination, outcome.result.counts])
  }],
  ['incomplete: a run stopped at its time budget is truncated and says so', () => {
    const outcome = finish(m, inputOf(m, { goal: 'fastest', hitChance: '', keep: '5' }), { budget: { candidates: null, ms: 3 }, slice: 5 })
    const exported = m.opt.exportOutcome(outcome)

    return outcome.status === 'truncated' && outcome.termination === 'time-budget' && outcome.result.counts.evaluated > 0 && outcome.result.counts.unexplored > 0 && exported.status.startsWith('incomplete (time-budget): ') && exported.text.includes('incomplete (time-budget)') ? true : short([outcome.status, outcome.termination, outcome.result && outcome.result.counts])
  }],
  ['incomplete: a run replaced while it ran is stale and incomplete', () => {
    const run = m.opt.missileRun(inputOf(m, { goal: 'fastest', hitChance: '', keep: '5' }), { budget: UNBOUNDED, now: clock(1), slice: 5 })

    run.advance(0)
    run.invalidate()

    const outcome = run.outcome()

    return outcome.stale && outcome.incomplete && m.opt.exportOutcome(outcome).status.startsWith('incomplete (input-changed)') ? true : short([outcome.status, m.opt.exportOutcome(outcome).status])
  }],
  ['incomplete: a run that explored its whole domain says it is complete, in every export', () => {
    const outcome = goalRun(m, { goal: 'fastest', hitChance: '', keep: '5' })
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)

    return outcome.status === 'complete' && !outcome.incomplete && exported.status.startsWith('complete: ') && rows.slice(1).every((row) => row[row.length - 1] === exported.status) && !/incomplete/i.test(exported.csv) && !/incomplete/i.test(exported.text) && m.opt.tableOf(outcome).incomplete === false && m.opt.tableOf(outcome).status === exported.status ? true : short([outcome.status, exported.status])
  }],
  ['incomplete: a complete run with no candidate within the limits says none meets them', () => {
    const outcome = goalRun(m, { goal: 'fastest', hitChance: '', maxMsp: '1', keep: '5' })
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)

    return outcome.status === 'complete' && outcome.result.counts.feasible === 0 && rows.length === 2 && rows[1].includes('none meets the limits') && /None meets the limits\./.test(exported.text) && /Infeasible/.test(exported.text) ? true : short([outcome.status, rows.length, exported.text.slice(-300)])
  }],
  ['incomplete: the exports carry the limits and the assumptions of the scenario', () => {
    const outcome = goalRun(m, { goal: 'warhead', hitChance: '40', keep: '3' })
    const text = m.opt.exportOutcome(outcome).text

    return /target speed 2000 km\/s/.test(text) && /tactical modifier 1/.test(text) && /missile jammer 0/.test(text) && /point-defence figure 0/.test(text) && /hit chance at least 40%/.test(text) && /planner figure and no game statistic/.test(text) ? true : short(text.slice(0, 700))
  }],
]

// ---------- an unknown tech, an unsupported base ----------

const unknownChecks = (m) => [
  ['unknown: a warhead tech level the save lacks leaves those candidates unknown, never ranked and never 0', () => {
    const tech = { ...TECH, warhead: null }
    const over = { goal: 'fastest', hitChance: '', keep: '1000' }
    const expected = oracle(m, over, null, SCENARIO, tech)
    const outcome = finish(m, inputOf(m, over, { tech }))
    const result = outcome.result
    const unknown = expected.all.filter((item) => item.unknown).length

    return unknown > 0 && result.outcomes.unknown === unknown && result.unknownReasons.length > 0 && result.entries.length === expected.feasible.length && result.entries.every((entry) => ['size', 'cost', 'speed', 'maxRange', 'damage'].every((name) => typeof entry.figures[name] === 'number')) && equal(result.entries.map((entry) => entry.id).sort(), expected.feasible.map((item) => item.id).sort()) && result.entries.every((entry) => entry.values.warheadMsp === 0) ? true : short([unknown, result.outcomes, result.entries.length, expected.feasible.length])
  }],
  ['unknown: an active sensor whose tech level the save lacks leaves the cost unknown and no candidate is listed with it', () => {
    const tech = { ...TECH, active: null }
    const draft = m.md.emptyDraft('')

    draft.activeMsp = '1'
    draft.resolution = '10'

    const over = { goal: 'fastest', hitChance: '', keep: '1000' }
    const expected = oracle(m, over, null, SCENARIO, tech, { activeMsp: 1, sensor: { resolution: 10, emSensitivity: tech.em } })
    const outcome = finish(m, inputOf(m, over, { tech, baseDraft: draft }))
    const result = outcome.result
    const unknown = expected.all.filter((item) => item.unknown).length

    return unknown > 0 && result.outcomes.unknown === unknown && result.entries.length === expected.feasible.length && result.entries.every((entry) => typeof entry.figures.cost === 'number') && result.unknownReasons.length > 0 ? true : short([unknown, result.outcomes, result.entries.length, expected.feasible.length])
  }],
  ['unknown: a table cell the rules cannot give is empty in the CSV and unknown in the text, never 0', () => {
    const input = inputOf(m, { goal: 'fastest', hitChance: '', keep: '3' })
    const outcome = finish(m, input)
    const entry = outcome.result.entries[0]
    const hidden = { ...outcome, result: { ...outcome.result, entries: [{ ...entry, figures: { ...entry.figures, damage: null, costPerWarhead: null, hitChance: null } }] } }
    const exported = m.opt.exportOutcome(hidden)
    const rows = parseCsv(exported.csv)
    const at = (label) => rows[0].indexOf(label)

    return rows[1][at('Damage per warhead')] === '' && rows[1][at('Hit chance (%)')] === '' && rows[1][at('BP per warhead')] === '' && rows[1][at('Planner figure')] === '' && /Damage per warhead unknown/.test(exported.text) && /Hit chance \(%\) unknown/.test(exported.text) && !/Damage per warhead 0,/.test(exported.text) ? true : short([rows[1], exported.text.slice(-300)])
  }],
  ['unknown: a base with an option outside the rules evaluates nothing and says so', () => {
    const draft = m.md.emptyDraft('')

    draft.carried = { ...draft.carried, groundPod: true }

    const outcome = finish(m, inputOf(m, { goal: 'fastest', hitChance: '', keep: '5' }, { baseDraft: draft }))
    const result = outcome.result

    return result.counts.evaluated === 0 && result.counts.pruned === result.counts.total && result.infeasible && result.infeasible.kind === 'unsupported' && result.counts.prunedBy.unsupported === result.counts.total && result.entries.length === 0 && outcome.status === 'complete' ? true : short([result.counts, result.infeasible])
  }],
  ['unknown: a missile with no sensor of its own has its reach unknown with the reason', () => {
    const outcome = goalRun(m, { goal: 'fastest', hitChance: '', keep: '1' })
    const sensor = outcome.result.sensor

    return sensor.rangeKm === null && sensor.reachKm === null && /no active sensor/.test(sensor.reason) ? true : short(sensor)
  }],
]

// ---------- the coverage of the launching ship ----------

// The detection rule as the reference states it, from its figures alone: the range cut by the square of the signature over the resolution when the target is under it, and by 0.75 to the jammer over the ECCM when the jammer is the stronger.
const detection = ({ range, signature, resolution, jammer = 0, eccm = 0 }) => {
  let reach = range

  if (signature < resolution) {
    reach *= (signature / resolution) ** 2
  }

  if (jammer > eccm) {
    reach *= 0.75 ** (jammer - eccm)
  }

  return reach
}

const SENSOR_CASES = [
  { rangeKm: 1e8, resolution: 10, eccm: 0, signature: 5, jammer: 0 },
  { rangeKm: 2.4e8, resolution: 20, eccm: 2, signature: 40, jammer: 4 },
  { rangeKm: 5e7, resolution: 1, eccm: 3, signature: 0.3, jammer: 1 },
  { rangeKm: 1.2e8, resolution: 5, eccm: 1, signature: 5, jammer: 0 },
]

const coverageChecks = (m) => [
  ['coverage: a typed fire control reaches a target by the sensor model', () => {
    const problems = []

    for (const spec of SENSOR_CASES) {
      const sensor = m.lc.launchSensorTyped({ rangeKm: String(spec.rangeKm), resolution: String(spec.resolution), eccm: String(spec.eccm) }, 'missileFireControl')
      const coverage = m.lc.sensorCoverage({ sensor, target: { signature: spec.signature, jammer: spec.jammer } })
      const km = m.pv.valueOrNull(coverage)
      const expected = detection({ range: spec.rangeKm, signature: spec.signature, resolution: spec.resolution, jammer: spec.jammer, eccm: spec.eccm })

      if (!close(km, expected, 1e-9)) {
        problems.push([spec, km, expected])
      }
    }

    return problems.length === 0 ? true : short(problems)
  }],
  ['coverage: a figure the sensor lacks is unknown with its reason, never 0', () => {
    const target = { signature: 5, jammer: 3 }
    const cases = [['no range', { rangeKm: '', resolution: '10', eccm: '1' }, /range/i], ['no resolution', { rangeKm: '1e8', resolution: '', eccm: '1' }, /resolution/i], ['no ECCM against a jammer', { rangeKm: '1e8', resolution: '10', eccm: '' }, /ECCM/i]]
    const problems = []

    for (const [label, typed, words] of cases) {
      const sensor = m.lc.launchSensorTyped(typed, 'missileFireControl')
      const covered = m.lc.launcherCoverage({ mfc: sensor, target, missile: { ownReachKm: 5e7, flightRangeKm: 6e7 } })

      if (covered.mfc.km !== null || !words.test(covered.mfc.reason) || covered.links.mfcOverFlight.verdict !== 'unknown' || covered.links.mfcOverOwnReach.verdict !== 'unknown' || !words.test(covered.links.mfcOverFlight.reason)) {
        problems.push([label, covered.mfc.km, covered.mfc.reason, covered.links.mfcOverFlight])
      }
    }

    const none = m.lc.launcherCoverage({ target, missile: { ownReachKm: null, flightRangeKm: null } })

    if (none.mfc.km !== null || none.search.km !== null || none.mfc.reason === '' || none.links.mfcOverFlight.verdict !== 'unknown') {
      problems.push(['no sensor chosen', none.mfc.km, none.mfc.reason])
    }

    return problems.length === 0 ? true : short(problems)
  }],
  ['coverage: the ECCM a sensor lacks does not matter against a target with no jammer', () => {
    const sensor = m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '' }, 'search')
    const covered = m.lc.launcherCoverage({ search: sensor, target: { signature: 20, jammer: 0 } })

    return covered.search.km === 1e8 ? true : short(covered.search)
  }],
  ['coverage: a figure typed that is not a number is refused and is no figure', () => {
    const sensor = m.lc.launchSensorTyped({ rangeKm: 'far', resolution: '-1', eccm: '1' }, 'search')

    return sensor.rangeKm === null && sensor.resolution === null && sensor.eccm === 1 && sensor.problems.rangeKm && sensor.problems.resolution && !sensor.problems.eccm ? true : short(sensor)
  }],
  ['coverage: the fire control, the search sensor and the missile\'s own sensor are shown apart and never added', () => {
    const mfc = m.lc.launchSensorTyped({ rangeKm: '2e8', resolution: '20', eccm: '0' }, 'missileFireControl')
    const search = m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, 'search')
    const covered = m.lc.launcherCoverage({ mfc, search, target: { signature: 40, jammer: 0 }, missile: { ownReachKm: 1.5e7, flightRangeKm: 3e8 } })

    return covered.mfc.km === 2e8 && covered.search.km === 1e8 && covered.missile.ownReachKm === 1.5e7 && covered.missile.flightRangeKm === 3e8 && covered.links.mfcOverFlight.verdict === 'short' && covered.links.mfcOverOwnReach.verdict === 'covers' && covered.mfc.sensor.role === 'missileFireControl' && covered.search.sensor.role === 'search' ? true : short(covered)
  }],
  ['coverage: a distance reached to the last digit is covered and one beyond it is short', () => {
    const sensor = m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, 'search')
    const covered = (distance) => m.lc.launcherCoverage({ mfc: sensor, target: { signature: 20, jammer: 0 }, missile: { ownReachKm: null, flightRangeKm: distance } }).links.mfcOverFlight.verdict

    return covered(1e8) === 'covers' && covered(1e8 * (1 - 1e-12)) === 'covers' && covered(1e8 * (1 + 1e-6)) === 'short' ? true : short([covered(1e8), covered(1e8 * (1 + 1e-6))])
  }],
  ['coverage: a null jammer is read as none, as the sensor model reads it, and a null signature leaves the range unknown', () => {
    const sensor = m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, 'search')
    const noJammer = m.lc.launcherCoverage({ search: sensor, target: { signature: 20, jammer: null } })
    const noSignature = m.lc.launcherCoverage({ search: sensor, target: { signature: null, jammer: 0 } })

    return noJammer.search.km === 1e8 && noSignature.search.km === null && noSignature.search.reason.length > 0 ? true : short([noJammer.search.km, noSignature.search])
  }],
  ['coverage: a saved sensor that is not in the save is unknown with its reason and never the figures typed beside it', () => {
    const roles = m.lc.LAUNCH_ROLES
    const typed = { id: 4242, rangeKm: '1e8', resolution: '10', eccm: '0' }
    const components = [{ id: 5, row: { Name: 'Search 5', MaxSensorRange: 9e7, Resolution: 10, ECCM: 1 } }]
    const gone = m.lc.sensorOfSelection(typed, components, roles.missileFireControl)
    const present = m.lc.sensorOfSelection({ ...typed, id: 5 }, components, roles.missileFireControl)
    const cleared = m.lc.sensorOfSelection({ ...typed, id: null }, components, roles.missileFireControl)
    const covered = m.lc.launcherCoverage({ mfc: gone, target: { signature: 20, jammer: 0 }, missile: { ownReachKm: 1e6, flightRangeKm: 5e7 } })
    const view = m.lc.launcherView({ mfc: gone, target: { signature: 20, jammer: 0 } })
    const row = view.sensors.find((sensor) => sensor.role === roles.missileFireControl)

    return gone.source === 'missing' && gone.rangeKm === null && gone.resolution === null && covered.mfc.km === null && /4242 is not in this save/.test(covered.mfc.reason) && covered.links.mfcOverFlight.verdict === 'unknown' && /^Coverage of the target unknown: /.test(row.text) && row.source === 'saved sensor not in this save' && present.source === 'component' && present.rangeKm === 9e7 && cleared.source === 'typed' && cleared.rangeKm === 1e8 ? true : short([gone, covered.mfc.reason, row.text, present.source, cleared.source])
  }],
  ['coverage: a target figure that is not usable leaves the coverage unknown with its reason, whatever the sensor', () => {
    const sensor = m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, 'search')
    const usable = m.lc.launcherCoverage({ search: sensor, target: { signature: 20, jammer: 0, missing: [] } })
    const bad = m.lc.launcherCoverage({ search: sensor, target: { signature: 20, jammer: 0, missing: ['the target\'s sensor jammer is not a number'] } })

    return usable.search.km === 1e8 && bad.search.km === null && /sensor jammer is not a number/.test(bad.search.reason) ? true : short([usable.search.km, bad.search])
  }],
  ['coverage: the module depends on the rules and the provenance alone, not on the designer or the search', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-launcher-coverage-'))

    try {
      fs.cpSync(m.directory, directory, { recursive: true })
      fs.rmSync(path.join(directory, 'missile-designer.js'))
      fs.rmSync(path.join(directory, 'missile-optimizer.js'))

      const loaded = await loadUtilities(['launcher-coverage'], { stubs: STUBS, directory })
      const sensor = loaded['launcher-coverage'].launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, 'search')

      return loaded['launcher-coverage'].sensorCoverage({ sensor, target: { signature: 20, jammer: 0 } }).value === 1e8 ? true : 'the coverage is not as the sensor model gives it'
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }],
  ['coverage: a fire control of the race as the save stores it reaches a target by the sensor model', async () => {
    const save = SAVES.stock || SAVES.modded

    if (!save) {
      return skipped('no save is there')
    }

    const fixture = await m.dd.loadSensorFixture(save.database, save.ids.GameID, save.ids.RaceID)
    const controls = fixture.components.filter((component) => component.row.ComponentTypeID === m.dd.SENSOR_COMPONENT_TYPES.missileFireControl && component.row.MaxSensorRange > 0)

    if (!controls.length) {
      return skipped('the race has no missile fire control')
    }

    const problems = []

    for (const component of controls.slice(0, 12)) {
      const sensor = m.lc.launchSensorOfComponent(component, 'missileFireControl')
      const target = { signature: component.row.Resolution * 0.5, jammer: 2 }
      const covered = m.lc.launcherCoverage({ mfc: sensor, target })
      const expected = detection({ range: component.row.MaxSensorRange, signature: target.signature, resolution: component.row.Resolution, jammer: target.jammer, eccm: component.row.ECCM })

      if (!close(covered.mfc.km, expected, 1e-9)) {
        problems.push([component.id, covered.mfc.km, expected])
      }
    }

    return problems.length === 0 ? true : short(problems)
  }],
]

// ---------- the nominations ----------

const FIXTURES = require('./lib/missile-fixtures.json').fixtures

const STOCK = { label: 'stock-271-g138', race: 785 }
const ORDINARY = 154630

const fixtureOf = ({ label, race }) => {
  const fixture = FIXTURES.find((entry) => entry.label === label)

  return { ...fixture, designs: fixture.designs.filter((design) => design.race === race) }
}

// The tech lines as the page resolves them: the held level of the greatest development cost of each line.
const resolutionOf = (m, fixture, race) => {
  const held = m.dd.heldMissileLevels(fixture, race)
  const lines = {}

  for (const type of m.md.DESIGN_LINE_TYPES) {
    const levels = [...(held[type] || [])].sort((a, b) => b.cost - a.cost || b.id - a.id)
    const level = levels[0] ? { id: levels[0].id, name: `level ${levels[0].id}`, info: levels[0].info, cost: levels[0].cost } : null

    lines[type] = { typeId: type, level, kind: level ? 'default' : 'none', hypothetical: false, candidate: null }
  }

  return lines
}

const designs = () => ({ fixture: fixtureOf(STOCK), obsolete: {}, excluded: 0 })

// The baseline of the stock fixture, its draft and the search request around it.
const reoptimise = (m, over = {}) => {
  const { fixture } = designs()
  const context = m.md.designerContext({ fixture, resolution: resolutionOf(m, fixture, STOCK.race), version: null, obsolete: {} })
  const spec = { baselineId: ORDINARY, alternatives: [], scenario: SCENARIO }
  const baseline = m.md.compareDesigns(context, spec).columns[0]
  const seeded = m.md.seedAlternative(context, ORDINARY)
  const tech = m.md.techFigures(context.levels)
  const fields = FIELDS({ goal: 'reference', hitChance: '', maxMsp: '', eccm: 'off', engineMsp: { min: '2', max: '6', step: '2' }, thrust: { min: '1', max: '2', step: '0.5' }, engines: { min: '1', max: '2', step: '1' }, fuelMsp: { min: '1', max: '10', step: '3' }, warheadMsp: { min: '1', max: '4', step: '1' }, warheads: { min: '1', max: '1', step: '' }, keep: '6', ...over })
  const request = m.opt.readRequest({ fields, scenario: SCENARIO, tech, reference: m.opt.referenceOfColumn(baseline), baseDraft: seeded.draft, stage: m.opt.stageOfDraft(fixture, seeded.draft) })

  return { context, spec, baseline, seeded, tech, request, fields }
}

const nominateChecks = (m) => [
  ['nominate: the best candidates of a run become at most three alternatives that the designer reproduces', () => {
    const { context, spec, request, seeded } = reoptimise(m)

    if (!request.ok) {
      return short(request.errors)
    }

    const outcome = finish(m, request.input)
    const drafts = m.opt.nominations(outcome, { baseDraft: seeded.draft })
    let alternatives = []

    for (const draft of drafts) {
      const added = m.md.addAlternative(alternatives, draft)

      if (added.ok) {
        alternatives = added.list
      }
    }

    const compared = m.md.compareDesigns(context, { ...spec, alternatives })
    const problems = []

    compared.columns.slice(1).forEach((column, at) => {
      const entry = outcome.result.entries[at]
      const read = (id) => column.figures[id].value

      for (const [id, name] of [['size', 'size'], ['speed', 'speed'], ['maxRange', 'maxRange'], ['damage', 'damage'], ['cost', 'cost']]) {
        if (!close(read(id), entry.figures[name], 1e-9)) {
          problems.push([at, id, read(id), entry.figures[name]])
        }
      }

      if (entry.figures.hitChance !== null && !close(read('hitChance'), entry.figures.hitChance, 1e-9)) {
        problems.push([at, 'hitChance', read('hitChance'), entry.figures.hitChance])
      }
    })

    return outcome.result.entries.length > 3 && drafts.length === 3 && alternatives.length === 3 && compared.columns.length === 4 && problems.length === 0 ? true : short([outcome.result.entries.length, drafts.length, alternatives.length, compared.columns.length, problems])
  }],
  ['nominate: the baseline stays the saved design with its figures beside the alternatives', () => {
    const { context, spec, request, seeded, baseline } = reoptimise(m)
    const outcome = finish(m, request.input)
    const drafts = m.opt.nominations(outcome, { baseDraft: seeded.draft })
    const alternatives = drafts.reduce((list, draft) => m.md.addAlternative(list, draft).list, [])
    const compared = m.md.compareDesigns(context, { ...spec, alternatives })
    const first = compared.columns[0]

    return first.role === 'baseline' && first.savedId === ORDINARY && equal(first.figures, baseline.figures) && compared.columns.slice(1).every((column) => column.kind === 'designed') ? true : short([first.role, first.savedId])
  }],
  ['nominate: no more than three are nominated whatever number is asked for or kept', () => {
    const { request, seeded } = reoptimise(m, { keep: '40' })
    const outcome = finish(m, request.input)

    return outcome.result.entries.length > 3 && m.opt.nominations(outcome, { baseDraft: seeded.draft, limit: 40 }).length === 3 && m.opt.nominations(outcome, { baseDraft: seeded.draft, limit: 2 }).length === 2 && m.opt.nominations(outcome, { baseDraft: seeded.draft, limit: 0 }).length === 0 ? true : short(outcome.result.entries.length)
  }],
  ['nominate: the match of a reference defaults the size limit to the size of the reference and ranks by the greatest relative deviation', () => {
    const { request, baseline } = reoptimise(m)
    const reference = m.opt.referenceOfColumn(baseline)
    const outcome = finish(m, request.input)
    const deviations = outcome.result.entries.map((entry) => entry.figures.deviation.greatest)

    return request.input.constraints.maxMsp === reference.size && reference.size > 0 && deviations.every((value, at) => at === 0 || deviations[at - 1] <= value) ? true : short([request.input.constraints.maxMsp, reference.size, deviations])
  }],
  ['nominate: an entry is nominated with the options and the sensors of the base and the tech lines of the page', () => {
    const { request, seeded } = reoptimise(m, { eccm: 'either' })
    const outcome = finish(m, request.input)
    const draft = m.opt.nominations(outcome, { baseDraft: seeded.draft })[0]
    const entry = outcome.result.entries[0]

    return draft.techMode === 'page' && draft.kind === 'designed' && draft.options.eccm === (entry.values.eccm > 0) && draft.carried.stages === seeded.draft.carried.stages && draft.activeMsp === seeded.draft.activeMsp && Number(draft.engineMsp) === entry.values.engineMsp && Number(draft.fuelMsp) === entry.values.fuelMsp ? true : short([draft.techMode, draft.options, draft.engineMsp, entry.values])
  }],
]

// The saves the coverage checks read, opened by `run`: { modded: { database, ids }, stock: { database, ids } }. A save that is not there leaves its checks skipped, and the mutants that name only skipped checks are skipped with them.
const SAVES = {}

const helperChecks = (m) => [
  ['helpers: a domain around a saved missile spans half to one and a half times its figures and leaves out a figure that is not a number', () => {
    const draft = { engineMsp: '4', thrust: '2', fuelMsp: '10', warheadMsp: '3', engines: '2', warheads: '1' }
    const around = m.opt.domainAround(draft)
    const span = (name, value) => close(Number(around[name].min), value / 2) && close(Number(around[name].max), value * 1.5) && close(Number(around[name].step), value / 4)
    const broken = m.opt.domainAround({ ...draft, fuelMsp: 'abc', warheads: '' })

    return around.goal === 'reference' && span('engineMsp', 4) && span('thrust', 2) && span('fuelMsp', 10) && span('warheadMsp', 3) && around.engines.min === '1' && around.engines.max === '3' && around.warheads.min === '1' && around.warheads.max === '2' && !('fuelMsp' in broken) && !('warheads' in broken) && 'engineMsp' in broken ? true : short([around, broken])
  }],
  ['helpers: the domain around the baseline is one the request reads and its search finds the baseline\'s own figures', () => {
    const { baseline, seeded, tech, request } = reoptimise(m)
    const fixture = designs().fixture
    const fields = { ...FIELDS(), ...m.opt.domainAround(seeded.draft), goal: 'reference', maxMsp: '', hitChance: '', keep: '5', eccm: 'off' }
    const read = m.opt.readRequest({ fields, scenario: SCENARIO, tech, reference: m.opt.referenceOfColumn(baseline), baseDraft: seeded.draft, stage: m.opt.stageOfDraft(fixture, seeded.draft) })

    if (!read.ok || !request.ok) {
      return short([read.errors, request.errors])
    }

    const outcome = finish(m, read.input)
    const grid = (name) => stepsOf(fields[name]).some((value) => close(value, Number(seeded.draft[name])))

    return outcome.status === 'complete' && outcome.result.entries.length > 0 && outcome.counts.total > 1 && ['engineMsp', 'thrust', 'fuelMsp', 'warheadMsp'].every(grid) ? true : short([outcome.status, outcome.result.entries.length, outcome.counts.total, fields])
  }],
  ['helpers: a stored form is read back with the defaults for what is not text, a goal that is not one and an option that is not a mode', () => {
    const defaults = m.opt.normaliseFields(null)
    const read = m.opt.normaliseFields({ goal: 'nope', keep: 5, engineMsp: { min: '3', max: 7 }, eccm: 'either', laser: 'zzz', axes: 'x' })

    return defaults.goal === 'warhead' && defaults.keep === '10' && defaults.axes === null && read.goal === 'warhead' && read.keep === '10' && read.engineMsp.min === '3' && read.engineMsp.max === defaults.engineMsp.max && read.engineMsp.step === defaults.engineMsp.step && read.eccm === 'either' && read.laser === 'off' && read.axes === null && equal(m.opt.normaliseFields(read), read) ? true : short([defaults, read])
  }],
  ['helpers: the second stage of a seeded draft is none for a draft with none and missing without a fixture', () => {
    const carried = { stages: 1, stageId: 77 }

    return m.opt.stageOfDraft(null, null) === null && m.opt.stageOfDraft(designs().fixture, { carried: { stages: 0 } }) === null && equal(m.opt.stageOfDraft(null, { carried }), { missing: true }) ? true : short([m.opt.stageOfDraft(null, { carried })])
  }],
  ['helpers: the table of the efficient front has a row for each member with a figure and a heading for each axis', () => {
    const outcome = goalRun(m, { goal: 'warhead', hitChance: '40', keep: '5' })
    const front = outcome.result.front
    const table = m.opt.frontTable(front, outcome.descriptor.input)

    return front.members.length > 0 && table.rows.length === front.members.length && table.axes.length === front.axes.length && table.axes.every((axis) => typeof axis.label === 'string' && axis.label.length > 0) && table.rows.every((row) => row.cells.length === table.axes.length && row.alike >= 0 && typeof row.id === 'string') ? true : short([table.axes, table.rows.length, front.members.length])
  }],
  ['helpers: a launch sensor selection is read back as text, a saved sensor that is gone leaves no figure and a blank form is none', () => {
    const roles = m.lc.LAUNCH_ROLES
    const empty = m.lc.emptySelection()
    const read = m.lc.normaliseSelection({ [roles.search]: { id: 5, rangeKm: '1e8', resolution: 7, eccm: '2' }, [roles.missileFireControl]: { id: 'x' } })
    const components = [{ id: 5, row: { Name: 'Search 5', MaxSensorRange: 9e7, Resolution: 10, ECCM: 1 } }]
    const none = m.lc.sensorOfSelection(empty[roles.search], components, roles.search)
    const gone = m.lc.sensorOfSelection({ id: 99, rangeKm: '', resolution: '', eccm: '' }, components, roles.search)
    const saved = m.lc.sensorOfSelection(read[roles.search], components, roles.search)
    const typed = m.lc.sensorOfSelection({ id: null, rangeKm: '1e8', resolution: '', eccm: '' }, components, roles.search)

    return Object.keys(empty).length === 2 && equal(m.lc.normaliseSelection('x'), empty) && read[roles.search].id === 5 && read[roles.search].rangeKm === '1e8' && read[roles.search].resolution === '' && read[roles.missileFireControl].id === null && none.source === 'none' && none.rangeKm === null && gone.source === 'missing' && gone.rangeKm === null && saved.source === 'component' && saved.rangeKm === 9e7 && saved.name === 'Search 5' && typed.source === 'typed' && typed.rangeKm === 1e8 && typed.resolution === null ? true : short([read, none, gone, saved, typed])
  }],
  ['helpers: the panel says in words what is unknown and why, and what a fire control reaches', () => {
    const roles = m.lc.LAUNCH_ROLES
    const mfc = m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, roles.missileFireControl)
    const unknown = m.lc.launcherView({ mfc, target: { signature: null, jammer: 0 }, missiles: [{ label: 'Missile', ownReachKm: null, ownReachReason: 'no own sensor', flightRangeKm: null, flightRangeReason: 'no engine' }] })
    const known = m.lc.launcherView({ mfc, target: { signature: 20, jammer: 0 }, missiles: [{ label: 'Missile', ownReachKm: 1e6, ownReachReason: '', flightRangeKm: 5e7, flightRangeReason: '' }] })
    const fire = (view) => view.sensors.find((sensor) => sensor.role === roles.missileFireControl)
    const row = known.missiles[0]

    return /^Coverage of the target unknown: /.test(fire(unknown).text) && fire(unknown).km === null && unknown.missiles[0].ownReachText === 'unknown: no own sensor' && unknown.missiles[0].flightRangeText === 'unknown: no engine' && unknown.missiles[0].ownReachKm === null && unknown.missiles[0].flightRangeKm === null && /^Reaches the target at /.test(fire(known).text) && row.ownReachText.includes('km') && row.flightRangeText.includes('km') && row.overFlight.verdict === 'covers' && row.overOwnReach.verdict === 'covers' ? true : short([fire(unknown), unknown.missiles[0], fire(known).text, row.overFlight])
  }],
]

// The redundant tail: a candidate with no warhead is searched once whatever the warheads axis, the rest of the axis counted without being walked.
const LONG_AXIS = 2e6

const redundantChecks = (m) => [
  ['redundant: the warheads tail of a candidate with no warhead is counted by arithmetic, never walked', () => {
    const input = inputOf(m, { goal: 'fastest', warheadMsp: { min: '0', max: '0', step: '1' }, warheads: { min: '1', max: '1', step: '1' }, eccm: 'off', hitChance: '' })
    const plan = m.opt.missileSweep({ fields: input.domain, tech: input.tech })
    let reads = 0
    const warheads = { get count () { reads++; return LONG_AXIS }, at: (index) => 1 + index }
    const long = { ...plan, axes: { ...plan.axes, warheads }, total: plan.total * LONG_AXIS }
    const generator = m.opt.searchMissiles({ ...input, plan: long, maxCandidates: null })
    let step = generator.next()

    while (!step.done) {
      step = generator.next()
    }

    const counts = step.value.counts

    return reads < 100 && counts.unexplored === 0 && counts.prunedBy.redundant === plan.total * (LONG_AXIS - 1) && counts.evaluated === plan.total ? true : short({ reads, counts })
  }],
  ['redundant: a domain whose warheads axis is short is counted as before', () => {
    const over = { goal: 'fastest', warheadMsp: { min: '0', max: '2', step: '1' }, warheads: { min: '1', max: '3', step: '1' }, eccm: 'off', hitChance: '' }
    const input = inputOf(m, over)
    const outcome = finish(m, input)
    const counts = outcome.result.counts
    const plan = m.opt.missileSweep({ fields: input.domain, tech: input.tech })
    const perWarhead = plan.total / (3 * 3)

    return counts.unexplored === 0 && counts.prunedBy.redundant === perWarhead * 2 && counts.total === plan.total ? true : short({ counts, perWarhead })
  }],
]

const EXTRAPOLATED = { goal: 'warhead', keep: '3', maxMsp: '60', hitChance: '1', engineMsp: { min: '2', max: '2', step: '1' }, thrust: { min: '1', max: '1', step: '1' }, engines: { min: '1', max: '1', step: '1' }, fuelMsp: { min: '3', max: '3', step: '1' }, warheadMsp: { min: '30', max: '30', step: '1' }, warheads: { min: '1', max: '1', step: '1' }, eccm: 'off' }

const NOTE = 'Hypothetical tech: Warhead strength is Level 9, a level the race has not researched'

const plannerChecks = (m) => [
  ['planner: the figure of a listed candidate is warhead x hit chance x (1 - PD / speed), with no point defence and with some', () => {
    for (const pd of ['0', '100']) {
      const input = inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' }, { scenario: { ...SCENARIO, pd } })
      const entries = finish(m, input).result.entries
      const cells = entries.map((entry) => ({ got: m.opt.cellOf(input, entry, 'planner'), speed: entry.figures.speed, expected: entry.figures.speed < Number(pd) ? null : entry.figures.damage * (entry.figures.hitChance / 100) * (1 - Number(pd) / entry.figures.speed) }))

      if (!entries.length || !cells.some((cell) => cell.expected !== null) || !cells.every((cell) => (cell.expected === null ? cell.got === null : close(cell.got, cell.expected)))) {
        return short({ pd, cells })
      }
    }

    return true
  }],
  ['planner: the figure is unknown, never 0, with a point-defence figure that is not a number, a hit chance that is not known or a speed above it', () => {
    const blank = inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' }, { scenario: { ...SCENARIO, pd: '' } })
    const cut = inputOf(m, { goal: 'fastest', hitChance: '', keep: '5' }, { scenario: { ...SCENARIO, targetSpeed: '' } })
    const high = inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' }, { scenario: { ...SCENARIO, pd: '1e12' } })
    const first = (input) => finish(m, input).result.entries[0]
    const noPd = m.opt.resultsOf(blank, first(blank)).planner
    const noHit = m.opt.resultsOf(cut, first(cut))
    const aboveSpeed = m.opt.resultsOf(high, first(high)).planner

    return m.opt.cellOf(blank, first(blank), 'planner') === null && noPd.status === 'unavailable' && /point-defence/.test(noPd.inputs.missing.join(' ')) && m.opt.cellOf(cut, first(cut), 'planner') === null && noHit.hitChance.status === 'unavailable' && noHit.planner.status === 'unavailable' && m.opt.cellOf(high, first(high), 'planner') === null && aboveSpeed.status === 'unavailable' ? true : short([noPd, noHit.hitChance.inputs, noHit.planner.inputs, aboveSpeed.inputs])
  }],
]

const provenanceChecks = (m) => [
  ['provenance: a cost the rules extrapolate is estimated by the extended rule in the table, the CSV and the copied text', () => {
    const outcome = finish(m, inputOf(m, EXTRAPOLATED))
    const table = m.opt.tableOf(outcome)
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)
    const basisAt = rows[0].indexOf('Basis')
    const cost = (row) => row.results.cost

    return table.rows.length > 0 && table.rows.every((row) => cost(row).status === 'estimated' && cost(row).rule.id === m.dr.MISSILE_RULES.extended) && basisAt > 0 && rows.slice(1).every((row) => row[basisAt].includes(`Cost (BP): estimated (${m.dr.MISSILE_RULES.extended})`)) && exported.text.includes(`Basis: estimated by ${m.dr.MISSILE_RULES.extended}: `) && /Cost \(BP\) [0-9.]+ \(estimated\)/.test(exported.text) ? true : short({ basis: rows.slice(1).map((row) => row[basisAt]), text: exported.text.split('\n').slice(-6) })
  }],
  ['provenance: a cost inside what the rules are checked for is confirmed and is not named in the Basis column or marked in the text', () => {
    const outcome = finish(m, inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' }))
    const table = m.opt.tableOf(outcome)
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)
    const basisAt = rows[0].indexOf('Basis')

    return table.rows.length > 0 && table.rows.every((row) => row.results.cost.status === 'confirmed' && row.results.size.status === 'confirmed') && rows.slice(1).every((row) => !row[basisAt].includes('Cost (BP)') && !row[basisAt].includes('Size (MSP)')) && !/Cost \(BP\) [0-9.]+ \(/.test(exported.text) && rows.slice(1).every((row) => /Hit chance \(%\): estimated \(missileHit\.capped\)/.test(row[basisAt])) ? true : short({ basis: rows.slice(1).map((row) => row[basisAt]) })
  }],
  ['provenance: the CSV keeps its Search column last and every row as wide as its header', () => {
    const rows = parseCsv(m.opt.exportOutcome(finish(m, inputOf(m, EXTRAPOLATED))).csv)

    return rows[0].at(-1) === 'Search' && rows[0].slice(-4).join() === 'Basis,Assumptions,Goal,Search' && rows.every((row) => row.length === rows[0].length) ? true : short(rows[0])
  }],
  ['provenance: the tech levels a request assumes are a part of it and are named in the table, the CSV and the copied text, every figure at most assumed', () => {
    const plain = inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' })
    const noted = inputOf(m, { goal: 'warhead', hitChance: '40', keep: '5' }, { techNotes: [NOTE] })
    const outcome = finish(m, noted)
    const table = m.opt.tableOf(outcome)
    const exported = m.opt.exportOutcome(outcome)
    const rows = parseCsv(exported.csv)
    const assumptionsAt = rows[0].indexOf('Assumptions')
    const unmarked = (row) => ['size', 'speed', 'maxRange', 'damage', 'cost', 'hitChance', 'costPerWarhead', 'planner'].filter((name) => !((['hitChance', 'planner'].includes(name) ? row.results[name].status !== 'confirmed' : row.results[name].status === 'assumed') && row.results[name].assumptions.includes(NOTE)))
    const problems = { same: JSON.stringify(plain) === JSON.stringify(noted), rows: table.rows.length, unmarked: table.rows.map(unmarked), column: assumptionsAt, inCsv: rows.slice(1).map((row) => row[assumptionsAt].includes(NOTE)), line: exported.text.includes(`Tech assumptions: ${NOTE}.`), cost: /Cost \(BP\) [0-9.]+ \(assumed\)/.test(exported.text) }

    return !problems.same && problems.rows > 0 && problems.unmarked.every((names) => names.length === 0) && assumptionsAt > 0 && problems.inCsv.every(Boolean) && problems.line && problems.cost ? true : short(problems)
  }],
  ['provenance: a member of the efficient front outside the listed candidates carries the results of its figures, an extrapolated cost estimated and a confirmed one not', () => {
    const outcome = finish(m, inputOf(m, { ...EXTRAPOLATED, goal: 'cheapest', keep: '1', hitChance: '', maxMsp: '60', warheadMsp: { min: '1', max: '30', step: '29' }, axes: [{ key: 'damage', goal: 'max' }, { key: 'cost', goal: 'min' }] }))
    const table = m.opt.frontTable(outcome.result.front, outcome.descriptor.input)
    const listed = new Set(outcome.result.entries.map((entry) => entry.id))
    const outside = table.rows.filter((row) => !listed.has(row.id))
    const costAt = table.axes.findIndex((axis) => axis.key === 'cost')
    const estimated = outside.filter((row) => row.results[costAt] && row.results[costAt].status === 'estimated' && row.results[costAt].rule.id === m.dr.MISSILE_RULES.extended)
    const confirmed = table.rows.filter((row) => row.results[costAt] && row.results[costAt].status === 'confirmed')
    const agrees = table.rows.every((row) => row.results.length === table.axes.length && row.results.every((result, at) => result !== null && close(result.value, row.cells[at])))

    return table.rows.length >= 2 && outside.length >= 1 && estimated.length >= 1 && confirmed.length >= 1 && agrees ? true : short({ rows: table.rows.map((row) => [row.id, row.cells, row.results.map((result) => result && result.status)]), listed: [...listed] })
  }],
  ['provenance: the lines a search reads decide which hypothetical levels it assumes', () => {
    const lines = (fields, baseDraft = null) => m.opt.usedTechLines({ fields: FIELDS({ eccm: 'off', ...fields }), baseDraft }).sort()
    const draft = { carried: {}, options: {}, activeMsp: '0.5', thermalMsp: '0', emMsp: '0', geoMsp: '0' }
    const noWarhead = lines({ warheadMsp: { min: '0', max: '0', step: '1' } })
    const warhead = lines({})
    const options = lines({ eccm: 'either', terminal: 'on', laser: 'on' })
    const sensed = lines({}, draft)
    const decoy = lines({}, { ...draft, carried: { shipDecoy: true } })
    const found = (resolved) => m.opt.techNotesOf({ [m.md.DESIGN_LINES.warhead]: resolved }, { fields: FIELDS({}) })
    const hypothetical = { typeId: m.md.DESIGN_LINES.warhead, level: { name: 'Level 9' }, hypothetical: true, candidate: { status: 'other', statusLabel: 'Queued' } }
    const used = found(hypothetical)
    const unused = m.opt.techNotesOf({ [m.md.DESIGN_LINES.laserEfficiency]: { ...hypothetical, typeId: m.md.DESIGN_LINES.laserEfficiency } }, { fields: FIELDS({}) })

    return equal(noWarhead, ['engine', 'fuel', 'maxThrust']) && equal(warhead, ['engine', 'fuel', 'maxThrust', 'warhead']) && equal(options, ['eccm', 'engine', 'fuel', 'laserEfficiency', 'maxThrust', 'terminal', 'warhead']) && equal(sensed, ['active', 'em', 'engine', 'fuel', 'maxThrust', 'reactor', 'warhead']) && !decoy.includes('warhead') && used.length === 1 && used[0].startsWith('Hypothetical tech: ') && unused.length === 0 && m.opt.techNotesOf(null, { fields: FIELDS({}) }).length === 0 ? true : short({ noWarhead, warhead, options, sensed, decoy, used, unused })
  }],
]

const GROUPS = (m) => [...domainChecks(m), ...goalChecks(m), ...cheapestChecks(m), ...unreachableChecks(m), ...keepChecks(m), ...incompleteChecks(m), ...unknownChecks(m), ...coverageChecks(m), ...nominateChecks(m), ...helperChecks(m), ...redundantChecks(m), ...plannerChecks(m), ...provenanceChecks(m)]

// ---------- the page ----------

const PAGE = 'pages/missile-designer'

const FIELDS_STUB = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => { globalThis.__missileOptimiserFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'

// A domain too large for the slice of one step to cross, so that a cancel arrives while the run goes.
const LARGE = { engineMsp: { min: '1', max: '60', step: '1' }, thrust: { min: '1', max: '30', step: '1' }, engines: { min: '1', max: '4', step: '1' }, fuelMsp: { min: '1', max: '60', step: '1' }, warheadMsp: { min: '1', max: '30', step: '1' }, warheads: { min: '1', max: '3', step: '1' }, maxMsp: '2000' }

const pageStatements = async (mutate, m) => {
  const options = await loadPage(PAGE, { stubs: STUBS, mutate, modules: { 'mixins/persisted-view': FIELDS_STUB } })
  const stored = globalThis.__missileOptimiserFields
  const { fixture } = designs()
  const page = (data = {}) => instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }, database: {}, GameID: 138, RaceID: STOCK.race, data: { designs: designs(), techResolution: resolutionOf(m, fixture, STOCK.race), formulaVersion: null, baselineId: ORDINARY, alternatives: [], hitTargetSpeed: '2000', hitJammer: '0', hitModifier: '1', pd: '0', ...data } })
  const around = reoptimise(m)
  const ready = (data = {}) => page({ optimiserFields: around.fields, ...data })
  const clipboard = async (test) => {
    const written = []
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { written.push(text) } } }, configurable: true, writable: true })

    try {
      return await test(written)
    } finally {
      if (before) {
        Object.defineProperty(globalThis, 'navigator', before)
      } else {
        delete globalThis.navigator
      }
    }
  }

  return [
    ['page: the optimiser fields are kept for the browser and the launch sensors for the race', () => {
      const field = stored.optimiserFields
      const sensors = stored.launcherSensors
      const jammer = stored.launcherJammer

      return field.key === 'missileOptimiserFields' && field.scope === undefined && field.valid({}) && !field.valid(null) && !field.valid([]) && sensors.key === 'missileLauncherSensors' && sensors.scope === 'race' && sensors.valid({}) && !sensors.valid('x') && equal(sensors.default, m.lc.emptySelection()) && equal(field.default, m.opt.normaliseFields(null)) && jammer.key === 'missileLauncherJammer' && jammer.scope === undefined && jammer.default === '0' && jammer.valid('2') && !jammer.valid(2) ? true : short([field.key, field.scope, sensors.key, sensors.scope, jammer])
    }],
    ['page: the request is read from the fields, the scenario and the baseline of the page', () => {
      const vm = ready()
      const request = vm.optimiserRequest

      return request.ok && equal(request.input, around.request.input) && vm.optimiserProblems === '' ? true : short([request.ok, request.errors, request.input && request.input.scenario, around.request.input.scenario])
    }],
    ['page: a field that is wrong is shown with its own message and no run starts', async () => {
      const vm = ready({ optimiserFields: { ...around.fields, keep: '1001' } })

      await vm.runOptimiser()

      return !vm.optimiserRequest.ok && vm.optimiserErrors.keep && vm.optimiserProblems.length > 0 && vm.optimiserOutcome === null && !vm.optimiserRunning ? true : short([vm.optimiserErrors, vm.optimiserOutcome && vm.optimiserOutcome.status, vm.optimiserRunning])
    }],
    ['page: a run that explores the whole domain is published complete with the candidates of the direct run', async () => {
      const vm = ready()
      const direct = finish(m, around.request.input)

      await vm.runOptimiser()

      const outcome = vm.optimiserOutcome

      return outcome && outcome.status === 'complete' && !outcome.incomplete && !vm.optimiserIncomplete && !vm.optimiserStale && !vm.optimiserRunning && equal(outcome.result.entries.map((entry) => entry.id), direct.result.entries.map((entry) => entry.id)) && equal(outcome.counts, direct.counts) && vm.optimiserRows.length === direct.result.entries.length && vm.optimiserExport.status === m.opt.exportOutcome(direct).status ? true : short([outcome && outcome.status, vm.optimiserRows.length, direct.result.entries.length, vm.optimiserExport.status, vm.optimiserError])
    }],
    ['page: the cells of the efficient front carry the results of their figures, as the listed candidates do', async () => {
      const vm = ready({ optimiserFields: { ...around.fields, goal: 'fastest', maxMsp: '40', hitChance: '', keep: '1', axes: [{ key: 'hitChance', goal: 'max' }, { key: 'cost', goal: 'min' }, { key: 'speed', goal: 'max' }] }, baselineId: null })

      await vm.runOptimiser()

      const front = vm.optimiserFront
      const cells = front.rows.flatMap((row) => row.cells.map((cell, at) => ({ header: front.headers[at], cell })))
      const known = cells.filter(({ cell }) => !cell.unknown)
      const listed = vm.optimiserRows.flatMap((row) => row.cells).filter((cell) => cell.result)

      return front.rows.length > 0 && known.length > 0 && known.every(({ cell }) => cell.result !== null && typeof cell.result.status === 'string') && listed.length > 0 && known.some(({ cell }) => cell.result.status !== 'confirmed') ? true : short({ rows: front.rows.length, bare: known.filter(({ cell }) => cell.result === null).map(({ header }) => header), listed: listed.length, status: vm.optimiserStatus, error: vm.optimiserError, errors: vm.optimiserErrors })
    }],
    ['page: a cancelled run keeps its incomplete status in the sentence, the table, the CSV on every row and the copied text', async () => {
      const vm = ready({ optimiserFields: { ...around.fields, ...LARGE, goal: 'fastest', hitChance: '', keep: '5' }, baselineId: null })
      const running = vm.runOptimiser()

      if (!vm.optimiserRunning) {
        await running

        return 'the run ended in its first step; the domain is too small to cancel'
      }

      vm.cancelOptimiser()
      await running

      const outcome = vm.optimiserOutcome
      const exported = vm.optimiserExport
      const rows = exported ? parseCsv(exported.csv) : [[]]
      const searchAt = rows[0].indexOf('Search')
      const data = rows.slice(1)

      return outcome && outcome.status === 'cancelled' && vm.optimiserIncomplete && !vm.optimiserRunning && /Incomplete \(cancelled\)/.test(vm.optimiserStatus) && vm.optimiserTable.incomplete && data.length > 0 && data.every((row) => row[searchAt].startsWith('incomplete (cancelled)')) && exported.text.includes(exported.status) && vm.optimiserEmptyText === 'None found so far.' ? true : short([outcome && outcome.status, vm.optimiserIncomplete, vm.optimiserStatus, data.length, data[0] && data[0][searchAt], vm.optimiserError])
    }],
    ['page: an input changed after a run marks the kept result out of date and stops nominating from it', async () => {
      const vm = ready()

      await vm.runOptimiser()

      const before = [vm.optimiserStale, vm.canNominate]

      vm.setOptimiserAxis('engineMsp', 'max', '8')

      const after = [vm.optimiserStale, vm.canNominate, vm.optimiserOutcome !== null]

      return equal(before, [false, true]) && equal(after, [true, false, true]) ? true : short([before, after])
    }],
    ['page: the best candidates are set beside the baseline as at most three alternatives and the baseline stays as saved', async () => {
      const vm = ready()
      const saved = copy(vm.comparison.columns[0].figures)

      await vm.runOptimiser()

      const listed = vm.optimiserOutcome.result.entries.length

      vm.nominateOptimised()

      const columns = vm.comparison.columns

      return listed > 3 && vm.alternatives.length === 3 && columns.length === 4 && columns[0].role === 'baseline' && columns[0].savedId === ORDINARY && equal(columns[0].figures, saved) && !vm.canNominate && /The best 3 candidates are set/.test(vm.optimiserMessage) ? true : short([listed, vm.alternatives.length, columns.length, columns[0].role, vm.optimiserMessage])
    }],
    ['page: a nomination the designer refuses is counted with its reason', async () => {
      const vm = ready()

      vm.addBlank()
      vm.addBlank()
      await vm.runOptimiser()
      vm.nominateOptimised()

      return vm.alternatives.length === 3 && /1 of the 3 best could be set/.test(vm.optimiserMessage) && vm.alternativeMessage.length > 0 && vm.optimiserMessage.includes(vm.alternativeMessage) ? true : short([vm.alternatives.length, vm.optimiserMessage, vm.alternativeMessage])
    }],
    ['page: matching the baseline sets the goal and a domain around it and leaves the limits to the baseline', () => {
      const vm = ready({ optimiserFields: { ...around.fields, goal: 'warhead', maxMsp: '14', hitChance: '40' } })
      const draft = vm.optimiserBaseDraft

      vm.searchAroundBaseline()

      const read = vm.optimiserFieldsRead
      const wanted = m.opt.domainAround(draft)
      const none = ready({ baselineId: null })
      const before = copy(none.optimiserFieldsRead)

      none.searchAroundBaseline()

      return draft && read.goal === 'reference' && read.maxMsp === '' && read.hitChance === '' && equal(read.engineMsp, wanted.engineMsp) && equal(read.fuelMsp, wanted.fuelMsp) && equal(read.warheadMsp, wanted.warheadMsp) && equal(none.optimiserFieldsRead, before) ? true : short([read.goal, read.maxMsp, read.hitChance, read.engineMsp, wanted.engineMsp])
    }],
    ['page: the launching ship\'s sensors are unknown, never 0, until a sensor is chosen and its target signature is entered', () => {
      const none = ready()
      const typed = ready({ launcherSensors: { ...m.lc.emptySelection(), missileFireControl: { id: null, rangeKm: '1e8', resolution: '10', eccm: '0' } } })
      const signed = ready({ targetSignature: '20', launcherJammer: '3', launcherSensors: { ...m.lc.emptySelection(), missileFireControl: { id: null, rangeKm: '1e8', resolution: '10', eccm: '0' } } })
      const mfc = (vm) => vm.launcherView.sensors.find((sensor) => sensor.role === 'missileFireControl')
      const wanted = m.pv.valueOrNull(m.lc.sensorCoverage({ sensor: m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '0' }, 'missileFireControl'), target: { signature: 20, jammer: 3 } }))
      const unknown = (vm) => mfc(vm).km === null && mfc(vm).reason.length > 0 && vm.launcherView.missiles.every((row) => row.overFlight.verdict === 'unknown' && row.overFlight.reason.length > 0)

      return unknown(none) && unknown(typed) && typeof mfc(signed).km === 'number' && mfc(signed).km > 0 && close(mfc(signed).km, wanted) && signed.launcherView.missiles.length === 1 && ['covers', 'short'].includes(signed.launcherView.missiles[0].overFlight.verdict) ? true : short([mfc(none), mfc(typed), mfc(signed), signed.launcherView.missiles.map((row) => row.overFlight)])
    }],
    ['page: the launcher coverage reads the sensor jammer of its own field, never the missile jammer of the hit chance, and a jammer that is no number leaves it unknown', () => {
      const fire = { ...m.lc.emptySelection(), missileFireControl: { id: null, rangeKm: '1e8', resolution: '10', eccm: '1' } }
      const km = (data) => ready({ targetSignature: '20', launcherSensors: fire, ...data }).launcherView.sensors.find((sensor) => sensor.role === 'missileFireControl')
      const expected = (jammer) => m.pv.valueOrNull(m.lc.sensorCoverage({ sensor: m.lc.launchSensorTyped({ rangeKm: '1e8', resolution: '10', eccm: '1' }, 'missileFireControl'), target: { signature: 20, jammer } }))
      const plain = km({})
      const missileJammer = km({ hitJammer: '9' })
      const sensorJammer = km({ launcherJammer: '4' })
      const blank = km({ launcherJammer: '  ' })
      const word = km({ launcherJammer: 'strong' })
      const negative = km({ launcherJammer: '-1' })
      const vm = ready({ launcherJammer: 'strong' })

      return close(plain.km, expected(0)) && close(missileJammer.km, plain.km) && close(sensorJammer.km, expected(4)) && sensorJammer.km < plain.km && close(blank.km, plain.km) && word.km === null && /sensor jammer/.test(word.reason) && negative.km === null && vm.launcherJammerProblem.length > 0 && ready({}).launcherJammerProblem === '' ? true : short([plain.km, missileJammer.km, sensorJammer.km, blank.km, word, negative.km])
    }],
    ['page: a saved sensor that is not in the save leaves the coverage unknown, with the figures typed beside it unused, and is still offered so that it can be cleared', () => {
      const gone = { id: 987654, rangeKm: '1e8', resolution: '10', eccm: '0' }
      const vm = ready({ targetSignature: '20', launcherSensors: { ...m.lc.emptySelection(), missileFireControl: gone } })
      const row = vm.launcherView.sensors.find((sensor) => sensor.role === 'missileFireControl')
      const offered = vm.launcherItems.missileFireControl.find((item) => item.value === gone.id)

      return row.km === null && row.source === 'saved sensor not in this save' && /987654 is not in this save/.test(row.reason) && vm.launcherView.missiles.every((entry) => entry.overFlight.verdict === 'unknown') && offered && /not in this save/.test(offered.text) ? true : short([row, offered])
    }],
    ['page: the launcher panel sets the baseline beside the best of a current optimisation, never of one that is out of date', async () => {
      const vm = ready()
      const before = vm.launcherMissileRows.length

      await vm.runOptimiser()

      const fresh = vm.launcherMissileRows.length

      vm.setOptimiserAxis('engineMsp', 'max', '8')

      const stale = vm.launcherMissileRows.length

      return before === 1 && fresh === 2 && stale === 1 && /^Baseline: /.test(vm.launcherMissileRows[0].label) ? true : short([before, fresh, stale])
    }],
    ['page: a launch sensor typed on the panel is kept as text with the others of its role untouched', () => {
      const vm = ready()

      vm.setLauncherSensor('search', 'rangeKm', '5e7')
      vm.setLauncherSensor('missileFireControl', 'id', 12)
      vm.setLauncherSensor('missileFireControl', 'id', undefined)

      const selection = vm.launcherSelection

      return selection.search.rangeKm === '5e7' && selection.search.id === null && selection.missileFireControl.id === null && selection.missileFireControl.rangeKm === '' ? true : short(selection)
    }],
    ['page: the result is copied as the exported text with its status', async () => {
      const vm = ready()

      await vm.runOptimiser()

      return await clipboard(async (written) => {
        await vm.copyOptimised()

        return written.length === 1 && written[0] === m.opt.exportOutcome(vm.optimiserOutcome, vm.figureText).text && written[0].includes(vm.optimiserExport.status) && /copied/.test(vm.optimiserCopyMessage) ? true : short([written.length, vm.optimiserCopyMessage])
      })
    }],
    ['page: a result copied when the clipboard is not there says so', async () => {
      const vm = ready()

      await vm.runOptimiser()

      const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })

      try {
        await vm.copyOptimised()
      } finally {
        if (before) {
          Object.defineProperty(globalThis, 'navigator', before)
        } else {
          delete globalThis.navigator
        }
      }

      return /could not be copied/.test(vm.optimiserCopyMessage) ? true : short(vm.optimiserCopyMessage)
    }],
  ]
}

const PAGE_MUTATIONS = [
  { name: 'a changed input is not marked out of date', find: 'JSON.stringify(this.optimiserOutcome.descriptor.input) !== this.optimiserRequestKey', replace: 'false', fails: ['page: an input changed after a run marks the kept result out of date', 'page: the launcher panel sets the baseline beside the best of a current optimisation'] },
  { name: 'more than three alternatives are held after a nomination', find: 'drafts.forEach((draft) => this.pushAlternative(draft))', replace: 'drafts.forEach((draft) => { this.alternatives = [...this.alternatives, draft] })', fails: ['page: a nomination the designer refuses is counted with its reason'] },
  { name: 'a cancelled run is not flagged incomplete', find: 'this.optimiserOutcome.incomplete && !this.optimiserRunning', replace: 'false', fails: ['page: a cancelled run keeps its incomplete status'] },
  { name: 'the CSV is built from another outcome than the one shown', find: 'return this.optimiserOutcome ? exportOutcome(this.optimiserOutcome, this.figureText) : null', replace: 'return this.optimiserOutcome ? exportOutcome({ ...this.optimiserOutcome, incomplete: false, status: \'complete\' }, this.figureText) : null', fails: ['page: a cancelled run keeps its incomplete status'] },
  { name: 'the target sensor jammer of the launcher panel is dropped', find: 'target: { signature, jammer, missing }', replace: 'target: { signature, jammer: 0, missing }', fails: ['page: the launching ship\'s sensors are unknown', 'page: the launcher coverage reads the sensor jammer of its own field'] },
  { name: 'the missile jammer of the hit chance cuts the reach of the launcher sensors', find: 'const jammer = String(this.launcherJammer).trim() === \'\' ? 0 : entered(this.launcherJammer)', replace: 'const jammer = entered(this.hitJammer)', fails: ['page: the launching ship\'s sensors are unknown', 'page: the launcher coverage reads the sensor jammer of its own field'] },
  { name: 'a sensor jammer that is no number is read as none', find: 'target: { signature, jammer, missing }', replace: 'target: { signature, jammer, missing: [] }', fails: ['page: the launcher coverage reads the sensor jammer of its own field'] },
  { name: 'a saved sensor that is not in the save is not offered to be cleared', find: 'if (id !== null && !list.some((item) => item.value === id)) {', replace: 'if (false) {', fails: ['page: a saved sensor that is not in the save leaves the coverage unknown'] },
  { name: 'a signature that is blank is read as 0 for the launcher panel', find: 'const signature = String(this.targetSignature).trim() === \'\' ? null : entered(this.targetSignature)', replace: 'const signature = String(this.targetSignature).trim() === \'\' ? 0 : entered(this.targetSignature)', fails: ['page: the launching ship\'s sensors are unknown'] },
  { name: 'the baseline is left out of the launcher panel', find: 'rows.push({ label: `Baseline: ', replace: 'void ({ label: `Baseline: ', fails: ['page: the launcher panel sets the baseline beside the best'] },
  { name: 'a result out of date is still nominated', find: '!this.optimiserStale && !this.optimiserRunning && this.alternatives.length', replace: '!this.optimiserRunning && this.alternatives.length', fails: ['page: an input changed after a run marks the kept result out of date'] },
  { name: 'matching the baseline keeps the goal and the limits', find: "this.optimiserFields = { ...this.optimiserFieldsRead, ...domainAround(this.optimiserBaseDraft), maxMsp: '', hitChance: '' }", replace: 'this.optimiserFields = { ...this.optimiserFieldsRead, ...domainAround(this.optimiserBaseDraft) }', fails: ['page: matching the baseline sets the goal'] },
  { name: 'the request ignores the saved baseline', find: 'reference: this.optimiserBaseline ? referenceOfColumn(this.optimiserBaseline) : null,', replace: 'reference: null,', fails: ['page: the request is read from the fields, the scenario and the baseline of the page'] },
  { name: 'the cells of the efficient front are drawn without the results of their figures', find: 'this.cellOf(table.axes[at].key, value, row.results[at])', replace: 'this.cellOf(table.axes[at].key, value)', fails: ['page: the cells of the efficient front carry the results of their figures'] },
]

// ---------- the planted faults ----------

const MUTATIONS = [
  { name: 'the tie-breaks of the greatest warhead are dropped', file: 'missile-optimizer.js', find: 'key: (figures) => [-figures.damage, -figures.hitChance, figures.cost, figures.size],', replace: 'key: (figures) => [-figures.damage],', fails: ['goals: the greatest warhead at a hit chance selects', 'goals: the greatest warhead at a hit chance under a BP limit'] },
  { name: 'candidates of the same figures are not ordered by name', file: 'missile-optimizer.js', find: 'return order === 0 ? a.id < b.id : order < 0', replace: 'return order <= 0', fails: ['goals: candidates that tie on every figure are ordered by their names'] },
  { name: 'the cheapest per warhead is ranked by BP alone', file: 'missile-optimizer.js', find: 'key: (figures) => [figures.costPerWarhead, -figures.damage, figures.size, figures.cost],', replace: 'key: (figures) => [figures.cost, -figures.damage, figures.size, figures.cost],', fails: ['goals: the cheapest per warhead selects', 'cheapest: the cheapest per warhead is the least of BP over warheads carried'] },
  { name: 'a candidate with no warhead is not rejected as undefined for the cheapest per warhead', file: 'missile-optimizer.js', find: 'if (reason === null && goal.id === \'cheapest\' && carried === 0) {', replace: 'if (false) {', fails: ['cheapest: a candidate with no warhead has no BP per warhead', 'cheapest: a domain of candidates with no warhead finds none'] },
  { name: 'a hit chance a little above the cap is searched', file: 'missile-optimizer.js', find: 'if (requested !== null && requested > HIT_CAP) {', replace: 'if (requested !== null && requested > HIT_CAP + 1) {', fails: ['unreachable: a hit chance above the cap'] },
  { name: 'the best hit chance of the domain is the worst', file: 'missile-optimizer.js', find: 'if (hit !== null && (bestHit === null || hit > bestHit)) {', replace: 'if (hit !== null && (bestHit === null || hit < bestHit)) {', fails: ['unreachable: a hit chance the domain does not reach'] },
  { name: 'the front is offered only what the table lists', file: 'missile-optimizer.js', find: '                      front.offer(entry)\n', replace: '                      if (ranked.includes(entry)) front.offer(entry)\n', fails: ['keep: the number of results kept changes only the listed candidates', 'goals: the front is offered every candidate within the limits'] },
  { name: 'the status line says complete for a run that is not', file: 'missile-optimizer.js', find: 'outcome.incomplete ? `incomplete (', replace: 'false ? `incomplete (', fails: ['incomplete: a cancelled run is incomplete', 'incomplete: a run stopped at its candidate budget', 'incomplete: a run stopped at its time budget', 'incomplete: a run replaced while it ran'] },
  { name: 'a table does not carry the status of its run', file: 'missile-optimizer.js', find: 'incomplete: Boolean(outcome.incomplete), status: searchLine(outcome) }', replace: 'incomplete: false, status: \'complete\' }', fails: ['incomplete: a cancelled run is incomplete', 'incomplete: a run that explored its whole domain'] },
  { name: 'a run that found nothing so far says none meets the limits', file: 'missile-optimizer.js', find: 'outcome.incomplete ? \'none found so far\' : \'none meets the limits\'', replace: '\'none meets the limits\'', fails: ['incomplete: a cancelled run that found nothing says none was found so far'] },
  { name: 'the budget of candidates is exceeded by one', file: 'missile-optimizer.js', find: 'if (maxCandidates !== null && evaluated >= maxCandidates) {', replace: 'if (maxCandidates !== null && evaluated > maxCandidates) {', fails: ['incomplete: a run stopped at its candidate budget'] },
  { name: 'a candidate that fails its least range stops the fuel it could pass with', file: 'missile-optimizer.js', find: 'reason = \'range\'', replace: 'reason = \'size\'', fails: ['goals: the pruning of the search keeps every candidate', 'goals: the fastest under a least range'] },
  { name: 'the deviation from a reference is an absolute figure', file: 'missile-optimizer.js', find: 'const part = Math.abs(figures[of] - reference[name]) / reference[name]', replace: 'const part = Math.abs(figures[of] - reference[name])', fails: ['goals: the match of a reference missile'] },
  { name: 'the size limit of a reference is twice its size', file: 'missile-optimizer.js', find: 'limits.maxMsp = { value: reference.size, error: \'\' }', replace: 'limits.maxMsp = { value: reference.size * 2, error: \'\' }', fails: ['nominate: the match of a reference defaults the size limit'] },
  { name: 'more than three are nominated', file: 'missile-optimizer.js', find: 'Math.min(limit, MAX_ALTERNATIVES)', replace: 'limit', fails: ['nominate: no more than three are nominated'] },
  { name: 'a candidate has a name that is not its figures', file: 'missile-optimizer.js', find: 'Math.round(thrust * 1000)}', replace: 'Math.round(thrust * 100)}', fails: ['domain: a candidate has one name'] },
  { name: 'the greatest number of results to keep is cut to 20', file: 'missile-optimizer.js', find: 'export const KEEP_MAX = 1000', replace: 'export const KEEP_MAX = 20', fails: ['keep: more than the greatest number is refused'] },
  { name: 'an ECCM the sensor lacks is read as 0', file: 'launcher-coverage.js', find: 'eccm: counter.value, problems', replace: 'eccm: counter.value || 0, problems', fails: ['coverage: a figure the sensor lacks is unknown'] },
  { name: 'a distance reached exactly is short', file: 'launcher-coverage.js', find: 'range >= distance * (1 - REACH_TOLERANCE)', replace: 'range > distance', fails: ['coverage: a distance reached to the last digit'] },
  { name: 'the coverage depends on the designer', file: 'launcher-coverage.js', find: 'import { isAvailable, unavailable, valueOrNull } from \'./provenance\'', replace: 'import { isAvailable, unavailable, valueOrNull } from \'./provenance\'\nimport { MAX_ALTERNATIVES } from \'./missile-designer\'\nexport const COUPLED = MAX_ALTERNATIVES', fails: ['coverage: the module depends on the rules'] },
  { name: 'the fire control and the missile sensor are merged into one coverage', file: 'launcher-coverage.js', find: 'missile: Object.freeze({ ownReachKm: known(missile.ownReachKm), flightRangeKm: known(missile.flightRangeKm) }),', replace: 'missile: Object.freeze({ ownReachKm: known(missile.ownReachKm) + (fire.km || 0), flightRangeKm: known(missile.flightRangeKm) }),', fails: ['coverage: the fire control, the search sensor and the missile\'s own sensor are shown apart'] },
  { name: 'the redundant warheads tail is walked one by one', file: 'missile-optimizer.js', find: 'pruned.redundant += perTail * (axes.warheads.count - k)\n              break', replace: 'pruned.redundant += perTail\n              continue', fails: ['redundant: the warheads tail of a candidate with no warhead is counted by arithmetic, never walked'] },
  { name: 'a saved sensor that is not in the save falls back to the figures typed beside it', file: 'launcher-coverage.js', find: 'return component ? launchSensorOfComponent(component, role) : launchSensorMissing(role, choice.id)', replace: 'return component ? launchSensorOfComponent(component, role) : launchSensorTyped(choice, role)', fails: ['coverage: a saved sensor that is not in the save is unknown', 'helpers: a launch sensor selection is read back as text'] },
  { name: 'a target figure that is not usable is ignored by the coverage', file: 'launcher-coverage.js', find: 'if (target.missing && target.missing.length) {', replace: 'if (false) {', fails: ['coverage: a target figure that is not usable leaves the coverage unknown'] },
  { name: 'the planner figure is built from plain numbers, not the results of the figures', file: 'missile-optimizer.js', find: 'const planner = plannerFigure({ warhead: damage, hitChance, speed, pd:', replace: 'const planner = plannerFigure({ warhead: entry.figures.damage, hitChance: entry.figures.hitChance, speed: entry.figures.speed, pd:', fails: ['planner: the figure of a listed candidate is warhead x hit chance'] },
  { name: 'the hypothetical tech levels of a request are not carried by its figures', file: 'missile-optimizer.js', find: 'const mark = (result) => markHypothetical(result, input.techNotes)', replace: 'const mark = (result) => result', fails: ['provenance: the tech levels a request assumes are a part of it'] },
  { name: 'the hypothetical tech levels of a request are not part of it', file: 'missile-optimizer.js', find: 'techNotes: Object.freeze(techNotes.filter(isText)),', replace: 'techNotes: Object.freeze([]),', fails: ['provenance: the tech levels a request assumes are a part of it'] },
  { name: 'the Basis column of an export is left empty', file: 'missile-optimizer.js', find: 'basisCell(row), assumptionCell(row), goal.label, status]', replace: '\'\', \'\', goal.label, status]', fails: ['provenance: a cost the rules extrapolate is estimated', 'provenance: the tech levels a request assumes are a part of it'] },
  { name: 'a figure the save confirms is named in the Basis column as well', file: 'missile-optimizer.js', find: 'row.results[column.id] && row.results[column.id].status !== STATUS.CONFIRMED).map(', replace: 'row.results[column.id]).map(', fails: ['provenance: a cost inside what the rules are checked for is confirmed'] },
  { name: 'the copied text does not mark a figure the save does not confirm', file: 'missile-optimizer.js', find: 'shown(row).some((item) => item.column === column) ?', replace: 'false ?', fails: ['provenance: a cost the rules extrapolate is estimated', 'provenance: the tech levels a request assumes are a part of it'] },
  { name: 'a warhead tech level is read by a search that sweeps no warhead', file: 'missile-optimizer.js', find: 'if (reads(fields.warheadMsp.max) && !carried.shipDecoy) {', replace: 'if (true) {', fails: ['provenance: the lines a search reads decide which hypothetical levels it assumes'] },
  { name: 'the rows of the efficient front carry no results of their figures', file: 'missile-optimizer.js', find: '(FRONT_RESULT[key] ? resultsOf(input, member.set)[FRONT_RESULT[key]] : null)', replace: 'null', fails: ['provenance: a member of the efficient front outside the listed candidates carries the results of its figures'] },
]

const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-missile-optimizer-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation does not apply to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

// ---------- the saves ----------

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], mutations: true, mutant: null, probe: null }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--run-mutant') {
      options.mutant = String(argv[++index])
    } else if (argv[index] === '--run-probe') {
      options.probe = String(argv[++index])
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

const openSaves = async (options) => {
  const [moddedFile, moddedGame, moddedRace] = options.modded
  const [stockFile, stockGame, stockRace] = options.stock
  const modded = await openSave(moddedFile)
  const stock = await openSave(stockFile)

  if (modded) {
    SAVES.modded = { database: modded, ids: { GameID: moddedGame, RaceID: moddedRace } }
  }

  if (stock) {
    SAVES.stock = { database: stock, ids: { GameID: stockGame, RaceID: stockRace } }
  }

  return { moddedFile, stockFile, modded, stock }
}

const closeSaves = () => Object.values(SAVES).forEach((save) => save.database.close())

// ---------- the mutants, each in a process of its own ----------

const MUTANTS = [...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })), ...PAGE_MUTATIONS.map((mutation, index) => ({ kind: 'page', id: `page:${index}`, ...mutation }))]

const outcomeOf = (result) => (result === true ? { state: 'pass' } : isSkip(result) ? { state: 'skip', reason: result.skipped } : { state: 'fail', message: typeof result === 'string' ? result : 'false' })

// One planted fault, in this process: the checks it names (or the page statements it names) run against the mutated copy and each outcome is returned as 'pass', 'fail' or 'skip'; `absent` lists the names no check begins with. A fault that does not apply or does not load is `{ error }`.
const runMutant = async (id, real) => {
  const began = Date.now()
  const mutant = MUTANTS.find((entry) => entry.id === id)

  if (!mutant) {
    return { error: `no planted fault ${id}` }
  }

  const { kind, file, find, replace, fails } = mutant
  let directory = null

  try {
    let all

    if (kind === 'page') {
      all = await pageStatements(replacing(find, replace), real)
    } else {
      directory = mutatedCopy(file, find, replace)
      all = GROUPS(await loadAll(directory))
    }

    const named = all.filter(([checkName]) => fails.some((start) => checkName.startsWith(start)))
    const absent = fails.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))
    const outcomes = []

    for (const [checkName, test] of named) {
      outcomes.push([checkName, outcomeOf(await settle(test))])
    }

    return { absent, outcomes, seconds: (Date.now() - began) / 1000 }
  } catch (error) {
    return { error: error.message }
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const PROBE_RULE = 'probe.planted'

// What an isolation probe sees: the rules registered in the copy of the utilities it loads as a mutant does and in the real ones. The `plant` probe registers a rule in the copy first.
const runProbe = async (mode) => {
  const real = await loadAll()
  const directory = mutatedCopy('missile-optimizer.js', 'export const KEEP_MAX = 1000', 'export const KEEP_MAX = 1000')

  try {
    const copied = await loadAll(directory)

    if (mode === 'plant') {
      copied.pv.registerRule({ id: PROBE_RULE, versions: ['1'], note: 'A rule planted by the isolation probe', verification: 'assumed' })
    }

    return { copyRules: copied.pv.listRules().map((rule) => rule.id), realRules: real.pv.listRules().map((rule) => rule.id) }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// A child of this script, its last line of output read as JSON. A child that dies with no result did not run.
const inChild = async (argv) => {
  const { code, stdout, stderr } = await runChild(__filename, argv)

  try {
    return JSON.parse(stdout.trim().split('\n').pop())
  } catch {
    return { error: `the process exited with ${code} and no result: ${(stderr || stdout).trim().slice(0, 400)}` }
  }
}

const forwardedSaves = (options) => ['--modded', ...options.modded.map(String), '--stock', ...options.stock.map(String)]

// Every planted fault in a process of its own, as many at a time as the pool allows, results printed in the order of the list.
const runMutants = async (options) => {
  const results = await inParallel(MUTANTS, (mutant) => inChild(['--run-mutant', mutant.id, ...forwardedSaves(options)]), jobs())

  results.forEach((result, index) => {
    if (result instanceof Error) {
      results[index] = { error: result.message }
    }
  })

  MUTANTS.forEach(({ kind, name, fails }, index) => {
    const { error, absent, outcomes, seconds } = results[index]
    const label = kind === 'page' ? `page mutation caught: ${name}` : `mutation caught: ${name}`
    const noun = kind === 'page' ? 'statements' : 'checks'

    if (error) {
      check(label, `does not load: ${error}`)

      return
    }

    const own = (start) => outcomes.filter(([checkName]) => checkName.startsWith(start))
    const status = (start) => (own(start).every(([, outcome]) => outcome.state === 'skip') ? 'skipped' : own(start).some(([, outcome]) => outcome.state === 'fail') ? 'failed' : 'missed')
    const failed = outcomes.filter(([, outcome]) => outcome.state === 'fail').map(([checkName]) => checkName)
    const missed = fails.filter((start) => !absent.includes(start) && status(start) === 'missed')
    const detail = `${failed.length} of the ${noun} it names fail, ${seconds.toFixed(1)} s`

    if (!absent.length && fails.every((start) => status(start) === 'skipped')) {
      check(label, skipped('the checks it names read a save that is not there'), detail)
    } else {
      check(label, absent.length ? `no ${kind === 'page' ? 'statement' : 'check'} begins ${absent.join('; ')}` : missed.length ? `these ${noun} did not fail: ${missed.join('; ')}` : true, detail)
    }
  })
}

// A rule planted by one process is in no other: the first probe registers a rule in its copy of the utilities, the second (a process of its own, as each mutant is) loads the same and must not have it, and neither the real utilities of either probe nor those of this process have it.
const checkIsolation = async (real, options) => {
  const [planted, later] = await Promise.all([inChild(['--run-probe', 'plant', ...forwardedSaves(options)]), inChild(['--run-probe', 'read', ...forwardedSaves(options)])])

  if (planted.error || later.error) {
    return `a probe did not run: ${planted.error || later.error}`
  }

  const mine = real.pv.listRules().map((rule) => rule.id)

  return planted.copyRules.includes(PROBE_RULE) && !later.copyRules.includes(PROBE_RULE) && !later.realRules.includes(PROBE_RULE) && !mine.includes(PROBE_RULE) && planted.pid !== process.pid && later.pid !== process.pid && planted.pid !== later.pid ? true : short({ planted, later, mine: mine.includes(PROBE_RULE), pid: process.pid })
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.mutant !== null || options.probe !== null) {
    await openSaves(options)

    const result = options.probe !== null ? await runProbe(options.probe) : await runMutant(options.mutant, options.mutant.startsWith('page:') ? await loadAll() : null)

    closeSaves()
    console.log(JSON.stringify({ pid: process.pid, ...result }))
    process.exit(0)
  }

  const real = await loadAll()
  const { moddedFile, stockFile, modded, stock } = await openSaves(options)

  console.log(`Saves read by the coverage checks: modded ${modded ? moddedFile : `${moddedFile} (not there)`}, stock ${stock ? stockFile : `${stockFile} (not there)`}`)
  console.log('The missile optimiser: domain, goals, cheapest per warhead, unreachable hit chances, results kept, incomplete runs, unknown figures, launcher coverage and nominations')

  for (const [name, test, detail] of GROUPS(real)) {
    check(name, await settle(test), detail)
  }

  console.log('\nThe page (its script on a pseudo instance, scripts/lib/page-loader.js)')

  for (const [statement, held] of await pageStatements(null, real)) {
    check(statement, await settle(held))
  }

  if (options.mutations) {
    console.log('\nMutations: each must fail the checks it names, each in a process of its own')

    check('isolation: a rule planted by one mutant process is not in the checks, the real utilities or the next mutant', await checkIsolation(real, options))
    await runMutants(options)
  }

  closeSaves()

  console.log(`\n${checks - failures} of ${checks} checks passed${skips ? `, ${skips} skipped (the save they read is not there)` : ''}`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
