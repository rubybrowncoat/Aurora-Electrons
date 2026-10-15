/*
  Checks the bounded search runner (src/renderer/utilities/search-run.js) and the engine search as a run (searchPropulsion and propulsionRun in design-search.js).

  node scripts/check-search-runner.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>]

  The synthetic checks need no save. They prove, on small domains that an unpruned enumeration can walk (an independent reference below: every engine of the sweep at every count, no bound, no early exit): the search's feasible candidates, by their deterministic names, are exactly the enumeration's, with its lightest, fastest and cheapest set, its ranked list, and frontiers that no feasible candidate beats or escapes, for custom count limits, the endpoint policy at the limits, each kind of engine, one of the race's own engines, range and endurance targets, no target, a speed no engine reaches and a share nothing fits in; the counts add up (`evaluated + pruned = total`, nothing left unexplored when the domain is exhausted); a search of more than the 50 sets it lists is complete for its domain, and says how many it left out of the list; a candidate budget stops after exactly that many candidates with the run truncated, one the domain just fits is complete, and a time budget (a clock the check supplies, never the wall clock) does the same; a run cancelled or invalidated at any step holds exactly the best of the candidates before the step, labelled incomplete, under the input it was given; a run that was superseded, whose save changed or that was never the current one is not published; and every step of the search is bounded by the work of its slice (the candidates, the tank packages and the engine designs it covers) whether it rejects at once or packs, so the caller regains control within the declared responsiveness budget (milliseconds are never asserted: scripts/bench-tank-packing.js measures them).

  With a save (by default the repository's modded save, AuroraDB.db game 140 race 784, and the stock 2.7.1 save one folder up, game 138 race 785; one that is not there is reported as not run) it repeats the exhaustive comparison with the race's tanks, engines and tech, runs the page's default search as a run, and compares its digest with the one taken before runs existed. Each mutation of the utilities must fail at least one synthetic check. Exit code 1 when a check fails.
*/
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const NAMES = ['search-run', 'design-search', 'design-rules', 'tank-packing', 'sweep-domain']

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

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected) || `${short(actual)} != ${short(expected)}`

const EPSILON = 1e-9
const near = (a, b) => Math.abs(a - b) <= EPSILON
const UNBOUNDED = { candidates: null, ms: null }

// The work a tank package costs a step at the least (a pack call), which the bound on packages per step is worked from.
const PACK_WORK = 6

const TECH = { engineTech: 10, fuelTech: 1, thermalTech: 1, thermalCost: 1, minThrust: 0.5, maxThrust: 1, maxSize: 3 }

// The stock catalogue's tanks, and a catalogue of awkward sizes and densities.
const STOCK_TANKS = [[100, 5000000, 25], [20, 1000000, 10], [5, 250000, 5], [1, 50000, 2], [0.2, 10000, 0.5], [0.1, 5000, 0.3], [0.02, 1000, 0.08]].map(([sizeHS, litres, cost], index) => ({ id: index + 1, name: `Stock ${index + 1}`, sizeHS, litres, cost, crew: 0 }))
const ODD_TANKS = [[4.1, 230000, 6], [1, 50000, 2], [0.3, 14000, 0.7]].map(([sizeHS, litres, cost], index) => ({ id: 100 + index, name: `Odd ${index + 1}`, sizeHS, litres, cost, crew: 1 }))

// A repeatable pseudo-random sequence, so a failure can be run again.
const generator = (seed) => {
  let state = seed

  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296

    return state / 4294967296
  }
}

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

const runOf = (m, input, options = {}) => m.search.propulsionRun(input, { budget: UNBOUNDED, ...options })

// A clock that moves by `step` milliseconds each time it is read.
const clock = (step = 1) => {
  let time = 0

  return () => (time += step)
}

// ---------- the reference: every candidate of the domain, none skipped ----------

// Whether set `a` ranks ahead of `b`: the less HS, then the less BP, then the faster, to the tolerance the search ranks with.
const ahead = (a, b) => {
  if (!near(a.propulsionHS, b.propulsionHS)) {
    return a.propulsionHS < b.propulsionHS
  }

  if (!near(a.cost, b.cost)) {
    return a.cost < b.cost
  }

  return a.speed > b.speed
}

const byRank = (a, b) => (ahead(a, b) ? -1 : ahead(b, a) ? 1 : 0)

const sameFigures = (a, b) => (a === null || b === null ? a === b : near(a.propulsionHS, b.propulsionHS) && near(a.cost, b.cost) && near(a.speed, b.speed))

// The feasible candidates of the domain of `input` (as `searchPropulsion` takes it) and how many designs the kind of engine leaves out, by walking every engine at every count between the limits and testing each with the figures of the rules, not the bounds the search stops at.
const reference = (m, input) => {
  const { classSpeed, engineDesign, fullPowerRangeKm } = m.rules
  const { kind = 'either', minCount = 1, maxCount = 100, share = 1, fraction = 1, goal = null, tech, tanks = [], engine = null, include = 'grid', speed, hullHS } = input
  const plan = m.search.engineSweep({ tech, engine, minCount, maxCount, include })
  const packer = m.packing.packerFor([...tanks])
  const floorKm = Math.max(0, Math.ceil(speed - EPSILON))
  const feasible = []
  let designs = 0
  let filtered = 0

  const designsOf = engine ? [engine] : plan.sizes.toArray().flatMap((sizeHS) => plan.thrusts.toArray().map((thrust) => ({ sizeHS, thrust })))

  for (const entry of designsOf) {
    const design = engine || { ...engineDesign({ sizeHS: entry.sizeHS, thrust: entry.thrust, engineTech: tech.engineTech, fuelTech: tech.fuelTech, thermalTech: tech.thermalTech, thermalCost: tech.thermalCost }), thrust: entry.thrust }

    designs++

    if (!engine && kind !== 'either' && design.commercial !== (kind === 'commercial')) {
      filtered++
      continue
    }

    for (let count = minCount; count <= maxCount; count++) {
      const power = count * design.power
      const engineHS = count * design.sizeHS
      const bareHS = hullHS + engineHS

      if (engineHS > share * bareHS + EPSILON) {
        continue
      }

      const bareSpeed = classSpeed({ enginePower: power, sizeHS: bareHS })

      if (bareSpeed < floorKm) {
        continue
      }

      const burnFull = power * design.fuelPerEph
      const burnCruise = burnFull * fraction
      let pack = { sizeHS: 0, litres: 0, cost: 0 }
      let finalSpeed = bareSpeed

      if (goal && goal.value > 0 && goal.mode === 'endurance') {
        pack = packer.pack(goal.value * burnCruise)

        if (!pack.feasible) {
          continue
        }

        finalSpeed = classSpeed({ enginePower: power, sizeHS: bareHS + pack.sizeHS })

        if (finalSpeed < floorKm || !m.packing.meetsRequest(pack.litres, goal.value * burnCruise)) {
          continue
        }
      } else if (goal && goal.value > 0 && goal.mode === 'range') {
        let litres = bareSpeed > 0 ? goal.value * burnFull / (bareSpeed * 3600) : Infinity
        let settled = false

        for (let pass = 0; pass < 24 && Number.isFinite(litres); pass++) {
          pack = packer.pack(litres)

          if (!pack.feasible) {
            break
          }

          finalSpeed = classSpeed({ enginePower: power, sizeHS: bareHS + pack.sizeHS })

          if (!(finalSpeed >= floorKm && finalSpeed > 0)) {
            break
          }

          const needed = goal.value * burnFull / (finalSpeed * 3600)

          if (m.packing.meetsRequest(pack.litres, needed)) {
            settled = true
            break
          }

          litres = needed
        }

        if (!settled) {
          continue
        }
      }

      const propulsionHS = engineHS + pack.sizeHS
      const totalHS = hullHS + propulsionHS
      const propulsionShare = totalHS > 0 ? propulsionHS / totalHS : 1

      if (propulsionShare > share + EPSILON) {
        continue
      }

      feasible.push({
        id: engine ? `engine:${engine.id}:${count}` : `grid:${Math.round(entry.sizeHS * 1000)}:${Math.round(entry.thrust * 1000)}:${count}`,
        propulsionHS,
        cost: count * design.cost + pack.cost,
        speed: finalSpeed,
        share: propulsionShare,
        rangeKm: burnFull > 0 ? fullPowerRangeKm({ fuel: pack.litres, enginePower: power, fuelPerEph: design.fuelPerEph, speed: finalSpeed }) : 0,
      })
    }
  }

  const ranked = feasible.slice().sort(byRank)
  const fastest = feasible.reduce((best, set) => (!best || set.speed > best.speed || (set.speed === best.speed && ahead(set, best)) ? set : best), null)
  const cheapest = feasible.reduce((best, set) => (!best || set.cost < best.cost - EPSILON || (near(set.cost, best.cost) && ahead(set, best)) ? set : best), null)

  return { feasible, ranked, fastest, cheapest, designs, filtered, perDesign: maxCount - minCount + 1 }
}

// What is wrong with a frontier of the search against the feasible candidates, or null: its members are feasible and carry their figures, no feasible candidate with less of the ship's share has as much of the key as a member (one of the same share and more of the key may stand beside it: the frontier keeps the members it met in order), and every feasible candidate is matched by a member with no more share and no less of the key.
const frontierProblem = (m, frontier, feasible, key) => {
  const byId = new Map(feasible.map((set) => [set.id, set]))

  for (const member of frontier) {
    const known = byId.get(m.search.candidateId(member))

    if (!known || known.share !== member.share || known[key] !== member[key]) {
      return `a ${key} frontier member that is not a feasible candidate: ${m.search.candidateId(member)}`
    }

    const beaten = feasible.find((other) => other.share < member.share && other[key] >= member[key])

    if (beaten) {
      return `a ${key} frontier member ${m.search.candidateId(member)} beaten by ${beaten.id}`
    }
  }

  const escaped = feasible.find((other) => !frontier.some((member) => member.share <= other.share && member[key] >= other[key]))

  return escaped ? `${escaped.id} escapes the ${key} frontier` : null
}

// Runs `input` as a run to its end and compares it with the reference: a message, or true.
const agrees = (m, input) => {
  const ref = reference(m, input)
  const outcome = finish(runOf(m, { ...input, keep: 1e9 }))
  const { result, counts } = outcome
  const ids = result.sets.map((set) => m.search.candidateId(set))
  const wanted = ref.feasible.map((set) => set.id)

  if (outcome.status !== 'complete' || outcome.incomplete || outcome.termination !== 'exhausted') {
    return `not complete: ${outcome.status} ${outcome.termination}`
  }

  if (new Set(wanted).size !== wanted.length || new Set(ids).size !== ids.length) {
    return 'a candidate name is not unique'
  }

  if (same([...ids].sort(), [...wanted].sort()) !== true) {
    return `feasible candidates differ: ${ids.length} found, ${wanted.length} in the enumeration, first difference ${short(ids.filter((id) => !wanted.includes(id)).slice(0, 3))} / ${short(wanted.filter((id) => !ids.includes(id)).slice(0, 3))}`
  }

  if (counts.feasible !== wanted.length || counts.retained < (wanted.length ? 1 : 0) || counts.retained > wanted.length || result.output.omitted !== 0 || result.output.listed !== wanted.length) {
    return `counts: ${short(counts)} output ${short(result.output)} for ${wanted.length} feasible`
  }

  if (!result.sets.every((set, index) => index === 0 || !ahead(set, result.sets[index - 1]))) {
    return 'the list is not ranked'
  }

  if (!result.sets.every((set, index) => sameFigures(set, ref.ranked[index]))) {
    return 'the ranked figures differ from the enumeration'
  }

  if (!sameFigures(result.lightest, ref.ranked[0] || null) || !sameFigures(result.fastest, ref.fastest) || !sameFigures(result.cheapest, ref.cheapest)) {
    return `best sets differ: ${short([result.lightest && result.lightest.propulsionHS, ref.ranked[0] && ref.ranked[0].propulsionHS, result.fastest && result.fastest.speed, ref.fastest && ref.fastest.speed, result.cheapest && result.cheapest.cost, ref.cheapest && ref.cheapest.cost])}`
  }

  const problem = frontierProblem(m, result.pareto.speed, ref.feasible, 'speed') || frontierProblem(m, result.pareto.range, ref.feasible, 'rangeKm')

  if (problem) {
    return problem
  }

  if (counts.evaluated + counts.pruned !== counts.total || counts.unexplored !== 0 || counts.evaluated < counts.feasible) {
    return `counts do not add up: ${short(counts)}`
  }

  if (counts.prunedBy.kind !== ref.filtered * ref.perDesign) {
    return `${counts.prunedBy.kind} dropped for their kind, ${ref.filtered * ref.perDesign} in the enumeration`
  }

  const total = ref.designs * ref.perDesign

  if (counts.total !== total || outcome.descriptor.domain.total !== total) {
    return `total ${counts.total} of ${total}`
  }

  const listed = finish(runOf(m, { ...input, keep: 5 }))

  if (!listed.result.sets.every((set, index) => sameFigures(set, ref.ranked[index])) || listed.result.sets.length !== Math.min(5, wanted.length) || listed.result.output.omitted !== Math.max(0, wanted.length - 5) || listed.counts.feasible !== wanted.length) {
    return `the best five differ: ${listed.result.sets.length} listed, ${listed.result.output.omitted} omitted`
  }

  return true
}

// ---------- the cases ----------

const OWN_ENGINE = (m) => ({ ...m.rules.engineDesign({ sizeHS: 0.8, thrust: 0.9, engineTech: 10, fuelTech: 1, thermalTech: 1, thermalCost: 1 }), id: 9001, name: 'Own', thrust: 0.9, thermalRating: 1 })

// [label, (m) => input] on the synthetic tech and catalogues; the real saves repeat them with their own.
const CASES = [
  ['a range target, the default count limits and a share of half', () => ({ hullHS: 40, speed: 2500, fraction: 0.5, goal: { mode: 'range', value: 5e9 }, share: 0.5, maxCount: 40, tech: TECH, tanks: STOCK_TANKS })],
  ['custom count limits (3 to 17) and a tighter share', () => ({ hullHS: 40, speed: 2000, fraction: 0.5, goal: { mode: 'range', value: 2e9 }, share: 0.3, minCount: 3, maxCount: 17, tech: TECH, tanks: STOCK_TANKS })],
  ['one count only', () => ({ hullHS: 40, speed: 1500, goal: { mode: 'range', value: 1e9 }, share: 0.6, minCount: 6, maxCount: 6, tech: TECH, tanks: ODD_TANKS })],
  ['an endurance target of awkward tanks', () => ({ hullHS: 25, speed: 2000, fraction: 0.5, goal: { mode: 'endurance', value: 60 }, share: 0.6, maxCount: 30, tech: TECH, tanks: ODD_TANKS })],
  ['no target (no fuel is fitted)', () => ({ hullHS: 40, speed: 3000, share: 0.5, maxCount: 30, tech: TECH, tanks: STOCK_TANKS })],
  ['no target and no speed', () => ({ hullHS: 40, speed: 0, share: 0.4, maxCount: 25, tech: TECH })],
  ['military engines only', () => ({ hullHS: 40, speed: 2500, goal: { mode: 'range', value: 3e9 }, kind: 'military', share: 0.5, maxCount: 30, tech: { ...TECH, maxSize: 30, minThrust: 0.5, maxThrust: 0.6 }, tanks: STOCK_TANKS })],
  ['commercial engines only (25 HS and up)', () => ({ hullHS: 400, speed: 1500, goal: { mode: 'range', value: 3e9 }, kind: 'commercial', share: 0.6, maxCount: 12, tech: { ...TECH, maxSize: 30, minThrust: 0.5, maxThrust: 0.5 }, tanks: STOCK_TANKS })],
  ['the limits policy at a size and thrust between steps', () => ({ hullHS: 40, speed: 2000, goal: { mode: 'range', value: 2e9 }, share: 0.5, maxCount: 20, include: 'limits', tech: { ...TECH, maxSize: 2.55, minThrust: 0.52, maxThrust: 0.98 }, tanks: STOCK_TANKS })],
  ['one of the race\'s own engines', (m) => ({ hullHS: 40, speed: 1800, goal: { mode: 'range', value: 2e9 }, share: 0.5, maxCount: 60, engine: OWN_ENGINE(m), tech: TECH, tanks: STOCK_TANKS })],
  ['a speed no engine reaches (every design rules out every count)', () => ({ hullHS: 40, speed: 269999, goal: { mode: 'range', value: 2e9 }, share: 0.5, maxCount: 30, tech: TECH, tanks: STOCK_TANKS })],
  ['a share nothing fits in', () => ({ hullHS: 5, speed: 2500, goal: { mode: 'range', value: 2e9 }, share: 0.02, maxCount: 30, tech: TECH, tanks: STOCK_TANKS })],
  ['a target no tank can hold', () => ({ hullHS: 40, speed: 2500, goal: { mode: 'range', value: 1e15 }, share: 0.5, maxCount: 20, tech: TECH, tanks: STOCK_TANKS })],
  ['a range target and no tanks', () => ({ hullHS: 40, speed: 2500, goal: { mode: 'range', value: 2e9 }, share: 0.5, maxCount: 20, tech: TECH, tanks: [] })],
  ['a hull of no HS', () => ({ hullHS: 0, speed: 2500, share: 0.5, maxCount: 10, tech: TECH })],
  ['a speed above the fastest a ship can go', () => ({ hullHS: 40, speed: 270001, share: 0.5, maxCount: 10, tech: TECH })],
]

// The inputs the bounds on a step are measured on: designs that rule out every count, candidates rejected at once, candidates that pack tanks in several passes.
const RULED_OUT = { hullHS: 40, speed: 269999, goal: { mode: 'range', value: 2e9 }, share: 0.5, maxCount: 30, tech: { ...TECH, maxSize: 40 }, tanks: STOCK_TANKS, slice: 50 }
const REJECTING = { hullHS: 40, speed: 2500, share: 0.3, minCount: 1, maxCount: 100, tech: { ...TECH, maxSize: 10 }, slice: 100 }
const PACKING = { hullHS: 40, speed: 2500, fraction: 0.5, goal: { mode: 'range', value: 5e9 }, share: 0.5, maxCount: 40, tech: TECH, tanks: STOCK_TANKS, slice: 12 }

// The work each step of `searchPropulsion` covers, from the steps it yields: the candidates evaluated, the tank packages made (every call of the packer's packing, counted by wrapping it for the run) and the engine designs passed, and how far it says it is.
const stepsOf = (m, input) => {
  const packer = m.packing.packerFor(input.tanks || [])
  const original = packer.packing
  let packs = 0

  packer.packing = function (...args) {
    packs++

    return original.apply(this, args)
  }

  try {
    const iterator = m.search.searchPropulsion(input)
    const plan = m.search.engineSweep({ tech: input.tech, engine: input.engine || null, minCount: input.minCount || 1, maxCount: input.maxCount || 100, include: input.include || 'grid' })
    const designTotal = input.engine ? 1 : plan.sizes.count * plan.thrusts.count
    const steps = []
    let previous = { evaluated: 0, designs: 0, packs: 0 }
    let step = iterator.next()

    while (!step.done) {
      const now = { evaluated: step.value.counts.evaluated, designs: Math.round(step.value.progress * designTotal), packs }

      steps.push({ candidates: now.evaluated - previous.evaluated, designs: now.designs - previous.designs, packs: now.packs - previous.packs, progress: step.value.progress })
      previous = now
      step = iterator.next()
    }

    steps.push({ candidates: step.value.counts.evaluated - previous.evaluated, designs: designTotal - previous.designs, packs: packs - previous.packs, progress: 1 })

    return { steps, designTotal }
  } finally {
    packer.packing = original
  }
}

const worstStep = (m, input) => {
  const { steps } = stepsOf(m, input)

  return { candidates: Math.max(...steps.map((step) => step.candidates)), designs: Math.max(...steps.map((step) => step.designs)), packs: Math.max(...steps.map((step) => step.packs)), steps: steps.length }
}

// A catalogue of one 1 L tank and two of about 600,000 L: no repeating pattern is proved below the table cap, so a request of 900,000 L builds a table of that many cells and walks 300,000 of the small tank back from it.
const SPARSE_TANKS = [[1, 1, 1], [600001, 500000, 500000], [600003, 500001, 500001]].map(([litres, hs, cost], index) => ({ id: 200 + index, name: `Sparse ${index + 1}`, sizeHS: hs / 1000, litres, cost: cost / 100, crew: 1 }))
const SPARSE_REQUEST = 900000

// A catalogue whose repeating pattern is proved at 500,000 cells, after a check of a window of 200,000 cells.
const PROVED_TANKS = [[1, 0.001, 0.01], [100000, 50, 5], [200000, 101, 10]].map(([litres, sizeHS, cost], index) => ({ id: 300 + index, name: `Proved ${index + 1}`, sizeHS, litres, cost, crew: 0 }))

// A pace whose time is always up, and one whose time never is.
const PAST = Object.freeze({ expired: () => true })
const CALM = Object.freeze({ expired: () => false })

// How many times a generator yields, and what it returns.
const yieldsOf = (generator) => {
  let yields = 0
  let step = generator.next()

  while (!step.done) {
    yields++
    step = generator.next()
  }

  return { yields, value: step.value }
}

// The yields of a request of SPARSE_REQUEST litres on a packer that has built nothing (its table is built in chunks), on one that has built its table (the walk of 300,000 tanks back from it), under a pace that is up; and the yields of the same request under a pace that is not.
const buildYields = (m) => yieldsOf(m.packing.createTankPacker(SPARSE_TANKS).packing(SPARSE_REQUEST, 'lightest', PAST))

const walkYields = (m, pace = PAST) => {
  const packer = m.packing.createTankPacker(SPARSE_TANKS)

  packer.pack(SPARSE_REQUEST)

  return yieldsOf(packer.packing(SPARSE_REQUEST, 'lightest', pace))
}

// The yields of the warm-up of PROVED_TANKS that built no cell since the one before: the check of the window of the repeating pattern, every 65,536 cells of it.
const windowYields = (m) => {
  const packer = m.packing.createTankPacker(PROVED_TANKS)
  const warming = packer.warm()
  const built = []

  for (let step = warming.next(); !step.done; step = warming.next()) {
    built.push(packer.built())
  }

  return built.filter((cells, index) => index > 0 && cells === built[index - 1]).length
}

// A search with a step of work too long to end by itself (slice 1e9) on a clock that moves a millisecond for each read, advanced for 3 ms: it runs on while the clock is not read, and stops where the pace says the 3 ms are up.
const clockedStep = (m) => {
  const made = runOf(m, { ...REJECTING, slice: 1e9 }, { now: clock(1) })

  made.advance(3)

  return { status: made.status, evaluated: made.outcome().counts.evaluated }
}

// The same search with a time budget of 5 ms: the pace is up at the budget, so the run stops there and says so.
const clockedBudget = (m) => {
  const outcome = finish(runOf(m, { ...REJECTING, slice: 1e9 }, { budget: { candidates: null, ms: 5 }, now: clock(1) }))

  return { status: outcome.status, termination: outcome.termination }
}

// Every call of the packer's `packing` during a search of PACKING, with the pace the search was given: they must all be that one.
const pacesPassed = (m) => {
  const marker = { expired: () => false }
  const packer = m.packing.packerFor(PACKING.tanks)
  const original = packer.packing
  const seen = []

  packer.packing = function (...args) {
    seen.push(args[2])

    return original.apply(this, args)
  }

  try {
    drain(m.search.searchPropulsion({ ...PACKING, pace: marker }))
  } finally {
    packer.packing = original
  }

  return seen.length > 0 && seen.every((pace) => pace === marker)
}

// A search whose domain passes a safe integer (the most engines 1e15): the figures that cannot be exact.
const OVERSIZED = { hullHS: 100, speed: 2500, share: 0.5, minCount: 1, maxCount: 1e15, tech: TECH, slice: 5 }

const oversizedCounts = (m, input = OVERSIZED) => {
  const made = runOf(m, input)

  made.advance(0)

  const running = made.outcome()
  const outcome = finish(made)

  return { descriptorTotal: made.descriptor.domain.total, running: running.counts, status: outcome.status, counts: outcome.counts, text: m.run.describeOutcome(outcome, String), list: m.run.countText(outcome.counts, String) }
}

// The checks that need no save, over the modules `m` ({ run, search, rules, packing }): [[name, () => true or a message]]. Run on the real modules and again on each mutated copy, where one at least must fail.
const synthetic = (m) => {
  const all = []
  const add = (name, test) => all.push([name, test])
  const { run, search } = m

  for (const [label, make] of CASES) {
    add(`the search and an unpruned enumeration agree on the feasible candidates, the best sets, the ranked list and the frontiers: ${label}`, () => agrees(m, make(m)))
  }

  add('a search of the default shape finds sets in the cases that have a feasible candidate (the comparison is not empty)', () => {
    const found = CASES.map(([, make]) => finish(runOf(m, make(m))).counts.feasible)

    return found.filter((count) => count > 0).length >= 8 && found.some((count) => count > 50) ? true : short(found)
  })

  add('the candidate names are stable: a grid design by thousandths of HS and of thrust and the count, one of the race\'s own by its id and the count', () => {
    const set = { engine: { sizeHS: 1.25, thrust: 0.85 }, count: 7 }

    return search.candidateId(set) === 'grid:1250:850:7' && search.candidateId({ engine: { id: 42, sizeHS: 3, thrust: 1 }, count: 9 }) === 'engine:42:9' && search.candidateId({ ...set, engine: { ...set.engine, name: 'x' }, speed: 1 }) === 'grid:1250:850:7' ? true : search.candidateId(set)
  })

  add('the descriptor names the input as given (the same object), the domain and the budget; the same input gives the same name, another does not', () => {
    const input = CASES[0][1](m)
    const first = runOf(m, input)
    const again = runOf(m, CASES[0][1](m))
    const other = runOf(m, { ...CASES[0][1](m), speed: 2600 })
    const wider = runOf(m, { ...CASES[0][1](m), maxCount: 41 })
    const limited = runOf(m, CASES[0][1](m), { budget: { candidates: 10, ms: null } })
    const { descriptor } = first

    return descriptor.input === input && Object.isFrozen(descriptor) && descriptor.kind === 'engine-search' && descriptor.budget.candidates === null && descriptor.domain.total === 21 * 11 * 40 && descriptor.responsiveness.sliceMs > 0 && descriptor.responsiveness.budgetMs > descriptor.responsiveness.sliceMs && descriptor.id === again.descriptor.id && descriptor.inputKey === again.descriptor.inputKey && descriptor.id !== other.descriptor.id && descriptor.inputKey !== other.descriptor.inputKey && descriptor.id !== wider.descriptor.id && descriptor.id !== limited.descriptor.id && descriptor.inputKey === limited.descriptor.inputKey ? true : short([descriptor.id, again.descriptor.id, other.descriptor.id, wider.descriptor.id, limited.descriptor.id, descriptor.domain.total])
  })

  add('the domain names how it is explored: the signature differs with the kind of engine, the policy at the limits, the counts and an engine of the race\'s own', () => {
    const base = CASES[0][1](m)
    const sign = (input) => finish(runOf(m, input)).descriptor.domain
    const domains = [base, { ...base, kind: 'military' }, { ...base, include: 'limits' }, { ...base, maxCount: 39 }, { ...base, minCount: 2 }, { ...base, engine: OWN_ENGINE(m) }].map(sign)
    const signatures = domains.map((domain) => domain.signature)

    return new Set(signatures).size === signatures.length && sign(base).signature === signatures[0] && domains[0].kind === 'engine-grid' && domains[5].kind === 'engine-counts' && domains[5].total === 40 && domains[0].order.join() === 'size,thrust,count' && domains[0].axes.counts.count === 40 ? true : short(signatures)
  })

  add('the counts add up for every case and shape of domain, and an exhausted search leaves nothing unexplored', () => {
    for (const [label, make] of CASES) {
      const { counts, status } = finish(runOf(m, make(m)))
      const by = counts.prunedBy

      if (status !== 'complete' || counts.evaluated + counts.pruned !== counts.total || counts.unexplored !== 0 || counts.pruned !== by.kind + by.speed + by.share + by.input || Object.values(counts).some((value) => typeof value === 'number' && value < 0)) {
        return `${label}: ${short(counts)}`
      }
    }

    return true
  })

  add('a speed above the fastest a ship can go drops the whole domain for its speed, and a hull of less than 0 HS for its input, without evaluating a candidate', () => {
    const fast = finish(runOf(m, { hullHS: 40, speed: 270001, tech: TECH, maxCount: 10 })).counts
    const bad = finish(runOf(m, { hullHS: -1, speed: 100, tech: TECH, maxCount: 10 })).counts

    return fast.evaluated === 0 && fast.pruned === fast.total && fast.prunedBy.speed === fast.total && bad.evaluated === 0 && bad.pruned === bad.total && bad.prunedBy.input === bad.total && fast.total === 21 * 11 * 10 ? true : short([fast, bad])
  })

  add('the results do not depend on the size of a slice: slices of 1, 7 and 2000 units give one result', () => {
    for (const index of [0, 3, 9]) {
      const input = CASES[index][1](m)
      const results = [1, 7, 2000].map((slice) => finish(runOf(m, { ...input, slice })).result)

      if (same(results[0], results[1]) !== true || same(results[0], results[2]) !== true) {
        return `slices change the result of case ${index}`
      }
    }

    return true
  })

  add('a search of more than the 50 sets it lists is complete for its domain: 50 rows listed, the rest counted as left out of the list and never as unexplored', () => {
    const input = CASES[0][1](m)
    const outcome = finish(runOf(m, input))
    const { result, counts } = outcome

    return outcome.status === 'complete' && !outcome.incomplete && !outcome.stale && outcome.termination === 'exhausted' && result.termination === 'exhausted' && result.sets.length === 50 && result.output.limit === 50 && result.output.listed === 50 && result.output.omitted === counts.feasible - 50 && result.output.omitted > 0 && counts.retained >= 50 && counts.unexplored === 0 && outcome.progress === 1 ? true : short([outcome.status, outcome.termination, result.sets.length, result.output, counts])
  })

  add('the words of a complete run and of a truncated one differ in what they say was explored, and the cut of the list is not a truncation', () => {
    const complete = finish(runOf(m, CASES[0][1](m)))
    const truncated = finish(runOf(m, CASES[0][1](m), { budget: { candidates: 500, ms: null } }))
    const cancelled = (() => {
      const made = runOf(m, CASES[0][1](m))

      made.advance(0)

      return made.cancel() && made.outcome()
    })()
    const text = (outcome) => run.describeOutcome(outcome, (value) => String(value))
    const completeText = text(complete)
    const truncatedText = text(truncated)

    return /^Explored the whole domain/.test(completeText) && !/not explored|Stopped/.test(completeText) && /^Stopped at its budget of 500 candidates/.test(truncatedText) && /not explored/.test(truncatedText) && /best of the part explored/.test(truncatedText) && /^Stopped before it finished/.test(text(cancelled)) && complete.result.output.omitted > 0 && complete.status === 'complete' && truncated.status === 'truncated' ? true : short([completeText, truncatedText])
  })

  add('a candidate budget stops after exactly that many candidates, truncated, whatever the slice', () => {
    for (const [index, budget] of [[0, 1], [0, 500], [0, 2001], [3, 10], [9, 25]]) {
      const input = CASES[index][1](m)
      const results = [1, 7, 2000].map((slice) => finish(runOf(m, { ...input, slice }, { budget: { candidates: budget, ms: null } })))
      const [outcome] = results

      if (results.some((other) => other.status !== 'truncated' || other.termination !== 'candidate-budget' || other.result.termination !== 'candidate-budget' || !other.incomplete || other.counts.evaluated !== budget || other.counts.unexplored <= 0 || other.counts.evaluated + other.counts.pruned + other.counts.unexplored !== other.counts.total || other.descriptor.budget.candidates !== budget || same(other.result, outcome.result) !== true)) {
        return `budget ${budget} of case ${index}: ${short(results.map((other) => [other.status, other.termination, other.counts.evaluated, other.counts.unexplored]))}`
      }
    }

    return true
  })

  add('a candidate budget of exactly the candidates the search evaluates leaves it complete, one less truncates it, and none truncates it with nothing evaluated', () => {
    for (const index of [0, 1, 3, 9, 10]) {
      const input = CASES[index][1](m)
      const full = finish(runOf(m, input))
      const exact = finish(runOf(m, input, { budget: { candidates: full.counts.evaluated, ms: null } }))
      const short1 = finish(runOf(m, input, { budget: { candidates: full.counts.evaluated - 1, ms: null } }))
      const none = finish(runOf(m, input, { budget: { candidates: 0, ms: null } }))

      if (full.counts.evaluated > 0 && (exact.status !== 'complete' || same(exact.result, full.result) !== true || short1.status !== 'truncated' || none.status !== 'truncated' || none.counts.evaluated !== 0 || none.result.sets.length !== 0 || none.result.lightest !== null)) {
        return `case ${index}: ${exact.status} ${short1.status} ${none.status} ${none.counts.evaluated}`
      }

      if (full.counts.evaluated === 0 && (exact.status !== 'complete' || none.status !== 'complete')) {
        return `case ${index} (nothing to evaluate): ${exact.status} ${none.status}`
      }
    }

    return true
  })

  add('a time budget stops the run at the first step past it (a fake clock), truncated, with the best of what was explored and the budget on its descriptor; one the run finishes within leaves it complete', () => {
    const input = { ...CASES[0][1](m), slice: 40 }
    const ticking = clock(1)
    const limited = runOf(m, input, { budget: { candidates: null, ms: 30 }, now: ticking })
    const outcome = finish(limited)
    const roomy = finish(runOf(m, input, { budget: { candidates: null, ms: 1e9 }, now: clock(1) }))
    const text = m.run.describeOutcome(outcome, String)

    return outcome.status === 'truncated' && outcome.termination === 'time-budget' && outcome.incomplete && !outcome.stale && outcome.descriptor.budget.ms === 30 && outcome.counts.unexplored > 0 && outcome.counts.evaluated > 0 && outcome.elapsedMs >= 30 && outcome.elapsedMs < 60 && outcome.result !== null && outcome.result.termination === null && /^Stopped at its budget of 0\.03 seconds/.test(text) && roomy.status === 'complete' && roomy.counts.unexplored === 0 ? true : short([outcome.status, outcome.termination, outcome.elapsedMs, outcome.counts, text, roomy.status])
  })

  add('a time budget cuts the run at the same candidates as a candidate budget of the candidates it explored', () => {
    const input = { ...CASES[0][1](m), slice: 40 }
    const timed = finish(runOf(m, input, { budget: { candidates: null, ms: 25 }, now: clock(1) }))
    const counted = finish(runOf(m, input, { budget: { candidates: timed.counts.evaluated, ms: null } }))

    return timed.status === 'truncated' && timed.counts.evaluated > 0 && same(timed.result.sets, counted.result.sets) === true && same(timed.result.fastest, counted.result.fastest) === true && timed.counts.feasible === counted.counts.feasible ? true : short([timed.counts, counted.counts])
  })

  // The result of a run cancelled after `steps` steps must be the result of a search that stopped before the candidate it had reached: a candidate budget of the candidates it counts.
  const prefix = (input, stepsOf) => {
    const probe = runOf(m, input)
    const countedRuns = new Map()

    const countedAt = (evaluated) => {
      if (!countedRuns.has(evaluated)) {
        countedRuns.set(evaluated, finish(runOf(m, input, { budget: { candidates: evaluated, ms: null } })))
      }

      return countedRuns.get(evaluated)
    }

    let steps = 0

    while (probe.running) {
      probe.advance(0)
      steps++
    }

    for (const at of stepsOf(steps)) {
      const stopped = runOf(m, input)

      for (let step = 0; step < at && stopped.running; step++) {
        stopped.advance(0)
      }

      stopped.cancel()

      const outcome = stopped.outcome()
      const counted = countedAt(outcome.counts.evaluated)
      const figures = (result) => ({ sets: result.sets.map((set) => m.search.candidateId(set)), lightest: result.lightest && m.search.candidateId(result.lightest), fastest: result.fastest && m.search.candidateId(result.fastest), cheapest: result.cheapest && m.search.candidateId(result.cheapest), speed: result.pareto.speed.map((set) => m.search.candidateId(set)), range: result.pareto.range.map((set) => m.search.candidateId(set)), packages: result.packages })

      if (outcome.status !== 'cancelled' || (outcome.result === null && outcome.counts.evaluated !== 0)) {
        return `step ${at}: ${outcome.status}`
      }

      if (outcome.result && (same(figures(outcome.result), figures(counted.result)) !== true || outcome.counts.feasible !== counted.counts.feasible || outcome.counts.evaluated !== counted.counts.evaluated)) {
        return `step ${at} of ${steps}: ${outcome.counts.evaluated} evaluated, ${short(figures(outcome.result).sets.slice(0, 2))} vs ${short(figures(counted.result).sets.slice(0, 2))}`
      }
    }

    return steps
  }

  const evenly = (count) => (steps) => Array.from({ length: count }, (_unused, index) => 1 + Math.floor(index * (steps - 1) / count))

  add('a run cancelled at any step holds exactly the best of the candidates before that step: a range target (a step can end inside the tank passes of a candidate), an endurance target and no target', () => {
    for (const [index, slice] of [[0, 12], [3, 9], [4, 15], [9, 12]]) {
      const input = { ...CASES[index][1](m), slice, keep: 8 }
      const outcome = prefix(input, evenly(25))

      if (typeof outcome === 'string') {
        return `case ${index}: ${outcome}`
      }

      if (outcome < 25) {
        return `case ${index} is too short to cut at 25 steps: ${outcome}`
      }
    }

    return true
  })

  add('a run cancelled at every step of a short domain holds the best of the candidates before it', () => {
    const input = { hullHS: 20, speed: 1500, goal: { mode: 'range', value: 1e9 }, share: 0.6, minCount: 1, maxCount: 8, tech: { ...TECH, maxSize: 1.6 }, tanks: STOCK_TANKS, slice: 6, keep: 4 }
    const outcome = prefix(input, (steps) => Array.from({ length: steps - 1 }, (_unused, index) => index + 1))

    return typeof outcome === 'string' ? outcome : outcome > 20 ? true : `only ${outcome} steps`
  })

  add('a cancelled run is incomplete under the exact input it was given: the same object, the same name, not mutated; it stops there and a later advance, cancel or invalidation changes nothing', () => {
    const input = CASES[0][1](m)
    const before = JSON.stringify(input)
    const made = runOf(m, input, { budget: { candidates: 1e9, ms: 1e9 } })
    const key = made.descriptor.inputKey
    const id = made.descriptor.id

    made.advance(0)
    made.advance(0)
    made.advance(0)

    const live = made.outcome()
    const status = made.cancel()
    const outcome = made.outcome()

    made.advance(Infinity)
    made.invalidate('input-changed')
    made.cancel()

    const later = made.outcome()

    return live.status === 'running' && status === 'cancelled' && outcome.status === 'cancelled' && outcome.incomplete && !outcome.stale && outcome.termination === 'cancelled' && outcome.descriptor.input === input && outcome.descriptor.inputKey === key && outcome.descriptor.id === id && JSON.stringify(input) === before && outcome.counts.unexplored > 0 && outcome.result !== null && outcome.result.termination === null && same(outcome.counts, later.counts) === true && same(outcome.result, later.result) === true && later.status === 'cancelled' && later.termination === 'cancelled' && !made.running ? true : short([live.status, status, outcome.status, outcome.counts, later.status])
  })

  add('a run cancelled before it began holds nothing, says so with the whole domain unexplored, and keeps the input', () => {
    const input = CASES[0][1](m)
    const made = runOf(m, input)

    made.cancel()

    const outcome = made.outcome()

    return outcome.status === 'cancelled' && outcome.incomplete && outcome.result === null && outcome.counts.evaluated === 0 && outcome.counts.feasible === 0 && outcome.counts.unexplored === outcome.counts.total && outcome.counts.total === 21 * 11 * 40 && outcome.descriptor.input === input && outcome.progress === 0 ? true : short(outcome.counts)
  })

  add('a run whose input or save changed is stale: it ends invalidated with the reason, keeps what it had, labelled incomplete, and an unknown reason is refused', () => {
    for (const reason of ['input-changed', 'save-changed', 'closed']) {
      const made = runOf(m, CASES[0][1](m))

      made.advance(0)
      made.advance(0)

      const status = made.invalidate(reason)
      const outcome = made.outcome()

      if (status !== 'invalidated' || outcome.status !== 'invalidated' || !outcome.stale || !outcome.incomplete || outcome.termination !== reason || outcome.counts.unexplored <= 0) {
        return `${reason}: ${short([status, outcome.status, outcome.stale, outcome.termination])}`
      }
    }

    const made = runOf(m, CASES[0][1](m))
    let refused = false

    try {
      made.invalidate('cancelled')
    } catch (error) {
      refused = error instanceof TypeError
    }

    let slotRefused = false
    const slot = run.createRunSlot()

    slot.start(runOf(m, CASES[0][1](m)))

    try {
      slot.invalidate('whatever')
    } catch (error) {
      slotRefused = error instanceof TypeError
    }

    return refused && slotRefused && made.running ? true : short([refused, slotRefused, made.status])
  })

  add('a superseded run cannot overwrite the current results: it is invalidated, never published, and what was published stays', () => {
    const slot = run.createRunSlot()
    const inputA = CASES[0][1](m)
    const inputB = CASES[1][1](m)
    const runA = slot.start(runOf(m, inputA))

    runA.advance(0)
    runA.advance(0)

    const runB = slot.start(runOf(m, inputB))
    const a = runA.outcome()

    runA.advance(Infinity)

    const stillA = runA.outcome()
    const lost = slot.publish(runA)

    if (a.status !== 'invalidated' || !a.stale || a.termination !== 'input-changed' || stillA.counts.evaluated !== a.counts.evaluated || stillA.status !== 'invalidated' || lost !== null || slot.published !== null || !slot.isCurrent(runB) || slot.isCurrent(runA)) {
      return `superseded: ${short([a.status, a.stale, a.termination, stillA.counts.evaluated, a.counts.evaluated, lost, slot.published])}`
    }

    runB.advance(Infinity)

    const published = slot.publish(runB)

    if (!published || published.status !== 'complete' || slot.published !== published || published.descriptor.input !== inputB || slot.current !== null) {
      return 'the current run was not published'
    }

    return slot.publish(runA) === null && slot.publish(runB) === null && slot.published === published ? true : 'a run published twice or a stale run replaced the published outcome'
  })

  add('a run that finished but was replaced before it was published cannot publish, and one whose save changed is not published', () => {
    const slot = run.createRunSlot()
    const finished = slot.start(runOf(m, CASES[1][1](m)))

    finished.advance(Infinity)

    const next = slot.start(runOf(m, CASES[0][1](m)))

    if (finished.status !== 'complete' || slot.publish(finished) !== null || slot.published !== null) {
      return `a completed run of a replaced input published: ${finished.status}`
    }

    next.advance(0)
    slot.invalidate('save-changed')

    const outcome = next.outcome()

    return outcome.status === 'invalidated' && outcome.termination === 'save-changed' && outcome.stale && slot.current === null && slot.publish(next) === null && slot.published === null ? true : short([outcome.status, outcome.termination, slot.published])
  })

  add('a run asked to stop is published as incomplete with its best so far; a failed run is published with its error and nothing else', () => {
    const slot = run.createRunSlot()
    const input = CASES[0][1](m)
    const stopped = slot.start(runOf(m, input))

    for (let step = 0; step < 5; step++) {
      stopped.advance(0)
    }

    slot.cancel()

    const published = slot.publish(stopped)
    const failing = slot.start(runOf(m, { hullHS: 50, speed: 100, tech: TECH, minCount: 5, maxCount: 2 }))

    failing.advance(Infinity)

    const failed = slot.publish(failing)

    return published && published.status === 'cancelled' && published.incomplete && published.descriptor.input === input && published.result !== null && published.counts.evaluated > 0 && failed && failed.status === 'failed' && failed.termination === 'error' && failed.incomplete && failed.result === null && /cannot run/.test(failed.error) && /Most engines/.test(failed.error) && failing.descriptor.domain.total === null && slot.published === failed ? true : short([published && published.status, failed && failed.status, failed && failed.error])
  })

  add('a run invalidated while it is still the slot\'s current one is not published either, and what was published before stays', () => {
    const slot = run.createRunSlot()
    const first = slot.start(runOf(m, CASES[1][1](m)))

    first.advance(Infinity)

    const kept = slot.publish(first)
    const second = slot.start(runOf(m, CASES[0][1](m)))

    second.advance(0)
    second.invalidate('save-changed')

    return second.status === 'invalidated' && slot.isCurrent(second) && slot.publish(second) === null && slot.published === kept && kept.status === 'complete' ? true : short([second.status, slot.published && slot.published.status])
  })

  add('what a running run holds at a step does not change as the search goes on: the snapshot is a copy', () => {
    const made = runOf(m, { ...CASES[0][1](m), slice: 30 })

    for (let step = 0; step < 5; step++) {
      made.advance(0)
    }

    const early = made.outcome()
    const text = JSON.stringify([early.result.sets, early.result.pareto, early.result.packages, early.counts])

    made.advance(Infinity)

    return JSON.stringify([early.result.sets, early.result.pareto, early.result.packages, early.counts]) === text && made.outcome().result.sets.length > early.result.sets.length ? true : 'the snapshot changed with the search'
  })

  add('a slot forgets what it published when cleared', () => {
    const slot = run.createRunSlot()
    const made = slot.start(runOf(m, CASES[1][1](m)))

    made.advance(Infinity)
    slot.publish(made)

    const kept = slot.published !== null

    slot.clear()

    return kept && slot.published === null ? true : 'the published outcome stayed'
  })

  const bounded = (label, input, expectedSteps) => add(`every step of the search is bounded by the work of its slice (${label})`, () => {
    const { steps, designTotal } = stepsOf(m, input)
    const slice = input.slice
    const worst = { candidates: Math.max(...steps.map((step) => step.candidates)), designs: Math.max(...steps.map((step) => step.designs)), packs: Math.max(...steps.map((step) => step.packs)) }
    const packBound = Math.floor((slice - 1) / PACK_WORK) + 1
    const monotonic = steps.every((step, index) => step.progress <= 1 && (index === 0 || step.progress >= steps[index - 1].progress))

    return worst.candidates <= slice && worst.designs <= slice + 1 && worst.packs <= packBound && monotonic && steps.length >= expectedSteps(designTotal, steps) ? true : `${steps.length} steps, at most ${worst.candidates} candidates, ${worst.designs} designs, ${worst.packs} packages in a step of a slice of ${slice} (bounds ${slice}, ${slice + 1}, ${packBound})`
  })

  bounded('designs that rule out every count: no candidate to count, the designs alone move the slice along', RULED_OUT, (designs) => Math.floor(designs / 51))
  bounded('candidates rejected at once by the speed or the share', REJECTING, () => 20)
  bounded('candidates that need a tank package they cannot have', { hullHS: 40, speed: 2500, goal: { mode: 'range', value: 1e15 }, share: 0.5, maxCount: 30, tech: TECH, tanks: STOCK_TANKS, slice: 30 }, () => 100)
  bounded('candidates that pack tanks in several passes, a package costing a slice of its own', PACKING, () => 500)
  bounded('candidates that pack once for an endurance target, of a catalogue of awkward tanks', { hullHS: 25, speed: 2000, fraction: 0.5, goal: { mode: 'endurance', value: 60 }, share: 0.6, maxCount: 30, tech: TECH, tanks: ODD_TANKS, slice: 8 }, () => 200)
  bounded('candidates of a kind that is left out (the designs of the other kind move the slice)', { hullHS: 400, speed: 1500, goal: { mode: 'range', value: 3e9 }, kind: 'commercial', share: 0.6, maxCount: 12, tech: { ...TECH, maxSize: 60, minThrust: 0.5, maxThrust: 0.5 }, tanks: STOCK_TANKS, slice: 20 }, (designs) => Math.floor(designs / 21))

  add('a search that rules out every candidate still yields, and a run of it ends at once with the whole domain dropped', () => {
    const input = { hullHS: 40, speed: 269999, goal: { mode: 'range', value: 2e9 }, share: 0.5, maxCount: 30, tech: { ...TECH, maxSize: 40 }, tanks: STOCK_TANKS, slice: 50 }
    const made = runOf(m, input)
    let slices = 0

    while (made.running) {
      made.advance(0)
      slices++
    }

    const outcome = made.outcome()

    return outcome.status === 'complete' && outcome.counts.evaluated === 0 && outcome.counts.pruned === outcome.counts.total && slices > 20 ? true : short([outcome.status, outcome.counts, slices])
  })

  add('a sweep that cannot run fails the run with its problems in words, and the failure is reported, not hidden', () => {
    const made = runOf(m, { hullHS: 50, speed: 100, tech: TECH, minCount: 5, maxCount: 2 })
    const first = made.advance(0)
    const outcome = made.outcome()

    return first === 'failed' && outcome.status === 'failed' && outcome.incomplete && outcome.termination === 'error' && outcome.result === null && /cannot run/.test(outcome.error) && /Most engines/.test(outcome.error) && made.descriptor.domain.signature.startsWith('invalid:') && made.descriptor.domain.total === null && /^Failed:/.test(m.run.describeOutcome(outcome, String)) ? true : short([first, outcome.status, outcome.error])
  })

  add('a run keeps the default budget unless given one, and no budget at all when given nulls', () => {
    const defaults = m.search.propulsionRun(CASES[0][1](m))
    const none = runOf(m, CASES[0][1](m))

    return defaults.descriptor.budget.candidates === m.search.SEARCH_BUDGET.candidates && defaults.descriptor.budget.ms === m.search.SEARCH_BUDGET.ms && m.search.SEARCH_BUDGET.candidates > 2708300 && none.descriptor.budget.candidates === null && none.descriptor.budget.ms === null ? true : short([defaults.descriptor.budget, none.descriptor.budget])
  })

  add('a package request yields where the pace is up while its table is built, and the package it returns is the one the packer gives without a pace', () => {
    const built = buildYields(m)
    const expected = m.packing.createTankPacker(SPARSE_TANKS).pack(SPARSE_REQUEST)
    const sameness = same(built.value, expected)

    return built.yields >= 10 && sameness === true && built.value.count === 299998 ? true : short([built.yields, sameness === true ? built.value.count : sameness])
  })

  add('a package request yields where the pace is up while its package is walked back from the table (300,000 tanks), and does not where the pace is not', () => {
    const expected = m.packing.createTankPacker(SPARSE_TANKS).pack(SPARSE_REQUEST)
    const walked = walkYields(m)
    const calm = walkYields(m, CALM)

    return walked.yields >= 3 && calm.yields === 0 && same(walked.value, expected) === true && same(calm.value, expected) === true ? true : short([walked.yields, calm.yields, same(walked.value, expected) === true, same(calm.value, expected) === true])
  })

  add('the check of the window of a proved repeating pattern (200,000 cells) yields along the way, between cells already built', () => {
    const idle = windowYields(m)

    return idle >= 2 ? true : `${idle} yields with no cell built`
  })

  add('a search whose pace is always up yields at least every CLOCK_EVERY candidates and packages whatever its work counts say, and finds what a search without a pace finds', () => {
    const input = { ...PACKING, slice: 1e9 }
    const worst = worstStep(m, { ...input, pace: PAST })
    const sameness = same(drain(m.search.searchPropulsion({ ...input, pace: PAST })), drain(m.search.searchPropulsion(input)))

    return worst.candidates <= m.search.CLOCK_EVERY && worst.packs <= m.search.CLOCK_EVERY && sameness === true ? true : short([worst, sameness === true ? 'same' : sameness.slice(0, 120)])
  })

  add('the search hands its own pace to the packer for every package it asks for', () => (pacesPassed(m) ? true : 'a package was asked for without the pace of the search'))

  add('a run steps a search for the time of the slice on the clock it was given, though no work counted by the search would end the step', () => {
    const held = clockedStep(m)

    return held.status === 'running' && held.evaluated > 0 && held.evaluated <= 3 * m.search.CLOCK_EVERY ? true : short(held)
  })

  add('a run whose time budget is up ends truncated at it, the pace being up there too, though no work counted by the search would end the step', () => {
    const held = clockedBudget(m)

    return held.status === 'truncated' && held.termination === 'time-budget' ? true : short(held)
  })

  add('a domain too large to count exactly reports its total, its dropped and its unexplored candidates as unknown, never a rounded or negative figure, and the text says so', () => {
    const held = oversizedCounts(m)
    const early = oversizedCounts(m, { ...OVERSIZED, speed: 300000 })
    const unknown = (counts) => counts.total === null && counts.pruned === null && counts.unexplored === null && counts.prunedBy === null
    const before = runOf(m, OVERSIZED).outcome().counts
    const texts = [held, early].every((entry) => /too large to count exactly/.test(entry.text) && !/, \d+ not explored/.test(entry.text) && /of unknown candidates evaluated, unknown dropped without evaluation, unknown not explored/.test(entry.list))

    return held.descriptorTotal === null && held.status === 'complete' && unknown(held.counts) && unknown(held.running) && unknown(before) && unknown(early.counts) && early.status === 'complete' && Number.isSafeInteger(held.counts.evaluated) && held.counts.evaluated > 0 && held.running.evaluated < held.counts.evaluated && held.counts.feasible > 0 && texts ? true : short([held.descriptorTotal, held.status, held.counts, held.running, before, early.counts])
  })

  return all
}

// The source of the utility `file` (a name with its .js) with `from` replaced by `to`, for loadUtilities' `sources`: the others load from the folder as they are.
const mutatedSources = (file, from, to) => {
  const source = fs.readFileSync(path.join(utilitiesDirectory, file), 'utf8')

  if (!source.includes(from)) {
    throw new Error(`The mutation of ${file} does not apply: ${from}`)
  }

  return { [file.replace(/\.js$/, '')]: source.replace(from, () => to) }
}

const modulesOf = (utilities) => ({ run: utilities['search-run'], search: utilities['design-search'], rules: utilities['design-rules'], packing: utilities['tank-packing'] })

// [label, file, from, to, probe(m) true when the mutant shows the fault it names].
const MUTATIONS = [
  ['the candidate budget not enforced', 'design-search.js', 'if (maxCandidates !== null && evaluated >= maxCandidates) {', 'if (false) {', (m) => finish(runOf(m, { ...CASES[0][1](m) }, { budget: { candidates: 10, ms: null } })).counts.evaluated > 10],
  ['the candidate budget enforced one candidate late', 'design-search.js', 'evaluated >= maxCandidates', 'evaluated > maxCandidates', (m) => finish(runOf(m, CASES[0][1](m), { budget: { candidates: 10, ms: null } })).counts.evaluated === 11],
  ['the work of an engine design not counted against a slice', 'design-search.js', 'const DESIGN_WORK = 1', 'const DESIGN_WORK = 0', (m) => worstStep(m, RULED_OUT).designs > RULED_OUT.slice + 1],
  ['the work of a candidate not counted against a slice', 'design-search.js', 'work++', 'work += 0', (m) => worstStep(m, REJECTING).candidates > REJECTING.slice],
  ['the work of a tank package not counted against a slice', 'design-search.js', 'const TANK_WORK = 6', 'const TANK_WORK = 0', (m) => worstStep(m, PACKING).packs > Math.floor((PACKING.slice - 1) / PACK_WORK) + 1],
  ['a step that ends inside the tank passes of a candidate counting it as evaluated', 'design-search.js', 'work = 0\n\n              yield stepOf(1)', 'work = 0\n\n              yield stepOf(0)', (m) => snapshotDisagrees(m, SHORT)],
  ['the candidates dropped for the share not counted', 'design-search.js', 'pruned.share += perDesign - below - (evaluated - entered)', 'pruned.share += perDesign - below', (m) => finish(runOf(m, CASES[0][1](m))).counts.unexplored !== 0],
  ['the candidates below the speed not counted as dropped', 'design-search.js', 'pruned.speed += below', 'pruned.speed += 0', (m) => finish(runOf(m, CASES[0][1](m))).counts.unexplored !== 0],
  ['a domain above the fastest speed not counted as dropped', 'design-search.js', "pruned[floorKm > MAX_SPEED ? 'speed' : 'input'] = total", "pruned[floorKm > MAX_SPEED ? 'speed' : 'input'] = 0", (m) => finish(runOf(m, { hullHS: 40, speed: 270001, tech: TECH, maxCount: 10 })).counts.unexplored !== 0],
  ['the designs of the other kind not counted as dropped', 'design-search.js', 'pruned.kind += perDesign', 'pruned.kind += 0', (m) => finish(runOf(m, CASES[6][1](m))).counts.unexplored !== 0],
  // eslint-disable-next-line no-template-curly-in-string
  ['the candidate name from the engine size alone', 'design-search.js', ':${Math.round(engine.thrust * SWEEP_KINDS.thrust.scale)}:${count}`', ':0:${count}`', (m) => m.search.candidateId({ engine: { sizeHS: 1, thrust: 0.5 }, count: 2 }) === 'grid:1000:0:2'],
  ['the list cut counted as an exploration cut', 'design-search.js', 'omitted: matched - sets.length', 'omitted: 0', (m) => finish(runOf(m, CASES[0][1](m))).result.output.omitted === 0],
  ['a run that reached a candidate budget labelled complete', 'search-run.js', '[TERMINATION.CANDIDATE_BUDGET]: RUN_STATUS.TRUNCATED', '[TERMINATION.CANDIDATE_BUDGET]: RUN_STATUS.COMPLETE', (m) => finish(runOf(m, CASES[0][1](m), { budget: { candidates: 10, ms: null } })).status === 'complete'],
  ['a run that reached a time budget labelled complete', 'search-run.js', '[TERMINATION.TIME_BUDGET]: RUN_STATUS.TRUNCATED', '[TERMINATION.TIME_BUDGET]: RUN_STATUS.COMPLETE', (m) => finish(runOf(m, { ...CASES[0][1](m), slice: 40 }, { budget: { candidates: null, ms: 30 }, now: clock(1) })).status === 'complete'],
  ['the time budget not enforced', 'search-run.js', 'if (limits.ms !== null && time - started >= limits.ms) {', 'if (false) {', (m) => finish(runOf(m, { ...CASES[0][1](m), slice: 40 }, { budget: { candidates: null, ms: 30 }, now: clock(1) })).status === 'complete'],
  ['a cancel that does not stop the run', 'search-run.js', 'return status === RUN_STATUS.RUNNING ? settle(TERMINATION.CANCELLED) : status', 'return status', (m) => { const made = runOf(m, CASES[0][1](m)); made.advance(0); made.cancel(); return made.running }],
  ['a cancelled run that loses what it had', 'search-run.js', 'result = last.snapshot()', 'result = null', (m) => { const made = runOf(m, { ...CASES[0][1](m), slice: 20 }); for (let step = 0; step < 30; step++) made.advance(0); made.cancel(); return made.outcome().result === null }],
  ['a finished run settled twice', 'search-run.js', 'if (status !== RUN_STATUS.RUNNING) {\n        return status', 'if (false) {\n        return status', (m) => { const made = runOf(m, CASES[0][1](m)); made.cancel(); made.advance(0); return made.outcome().counts.evaluated > 0 || made.status !== 'cancelled' }],
  ['the input named by a copy', 'search-run.js', ', input, inputKey, domain,', ', input: JSON.parse(JSON.stringify(input)), inputKey, domain,', (m) => { const input = CASES[0][1](m); return runOf(m, input).descriptor.input !== input }],
  ['the input name taken from nothing', 'search-run.js', 'const inputKey = hash(JSON.stringify(input))', "const inputKey = hash('')", (m) => runOf(m, CASES[0][1](m)).descriptor.inputKey === runOf(m, { ...CASES[0][1](m), speed: 2600 }).descriptor.inputKey],
  ['a replaced run left running', 'search-run.js', 'current.invalidate(why)', 'void why', (m) => { const slot = m.run.createRunSlot(); const first = slot.start(runOf(m, CASES[0][1](m))); slot.start(runOf(m, CASES[1][1](m))); return first.running }],
  ['a run that is not the current one published', 'search-run.js', 'if (current !== run || !PUBLISHED.has(run.status)) {', 'if (!PUBLISHED.has(run.status)) {', (m) => { const slot = m.run.createRunSlot(); const first = slot.start(runOf(m, CASES[1][1](m))); first.advance(Infinity); slot.start(runOf(m, CASES[0][1](m))); return slot.publish(first) !== null }],
  ['an invalidated run published', 'search-run.js', 'const PUBLISHED = new Set([RUN_STATUS.COMPLETE, RUN_STATUS.TRUNCATED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED])', 'const PUBLISHED = new Set([RUN_STATUS.COMPLETE, RUN_STATUS.TRUNCATED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED, RUN_STATUS.INVALIDATED])', (m) => { const slot = m.run.createRunSlot(); const made = slot.start(runOf(m, CASES[0][1](m))); made.advance(0); made.invalidate('save-changed'); return slot.publish(made) !== null }],
  ['a replaced run published after the new one has been started', 'search-run.js', 'if (current) {\n        current.invalidate(why)\n        current = null', 'if (current) {\n        current.invalidate(why)', (m) => { const slot = m.run.createRunSlot(); const made = slot.start(runOf(m, CASES[0][1](m))); slot.invalidate('save-changed'); return slot.current === made }],
  ['an unknown reason accepted for an invalidation', 'search-run.js', 'if (!INVALIDATIONS.includes(why)) {', 'if (false) {', (m) => { try { runOf(m, CASES[0][1](m)).invalidate('bogus') } catch (error) { return false } return true }],
  ['a failed run reported as complete', 'search-run.js', '[TERMINATION.ERROR]: RUN_STATUS.FAILED', '[TERMINATION.ERROR]: RUN_STATUS.COMPLETE', (m) => { const made = runOf(m, { hullHS: 50, speed: 100, tech: TECH, minCount: 5, maxCount: 2 }); made.advance(0); return made.status === 'complete' }],
  ['the snapshot of a running run not a copy of what is held (the sets it lists alias the live list)', 'design-search.js', 'sets: sets.slice(), lightest', 'sets, lightest', (m) => { const made = runOf(m, { ...CASES[0][1](m), slice: 30 }); for (let step = 0; step < 5; step++) made.advance(0); const early = made.outcome().result.sets; const held = early.length; made.advance(Infinity); return early.length !== held }],
  ['a package request that does not yield while its table is built', 'tank-packing.js', 'if (built < units && pace.expired()) {', 'if (false) {', (m) => buildYields(m).yields < 10],
  ['a package request that does not yield while its package is walked back', 'tank-packing.js', 'if (cell > 0 && pace.expired()) {', 'if (false) {', (m) => walkYields(m).yields === 0],
  ['the check of the window of a repeating pattern that does not yield', 'tank-packing.js', 'if (++scanned % SCAN_CELLS === 0) {', 'if (false) {', (m) => windowYields(m) === 0],
  ['the search that does not look at the pace between candidates', 'design-search.js', 'return pace.expired()', 'return false', (m) => clockedStep(m).status !== 'running'],
  ['the search that does not hand its pace to the packer', 'design-search.js', "packer.packing(litres, 'lightest', pace)", "packer.packing(litres, 'lightest')", (m) => !pacesPassed(m)],
  ['a pace that is never up', 'search-run.js', 'const pace = { expired: () => now() >= deadline }', 'const pace = { expired: () => false }', (m) => clockedStep(m).status !== 'running'],
  ['a pace that is not up at the time budget', 'search-run.js', 'deadline = limits.ms === null ? end : Math.min(end, started + limits.ms)', 'deadline = end', (m) => clockedBudget(m).status !== 'truncated'],
  ['a domain past a safe integer counted as exact', 'design-search.js', 'const exact = Number.isSafeInteger(total)', 'const exact = true', (m) => oversizedCounts(m).counts.unexplored !== null],
  ['the dropped candidates of a run not started counted as 0 in a domain that cannot be counted', 'search-run.js', 'pruned: total === null ? null : 0', 'pruned: 0', (m) => runOf(m, OVERSIZED).outcome().counts.pruned !== null],
  // eslint-disable-next-line no-template-curly-in-string
  ['an unknown total not said in the text', 'search-run.js', 'const explored = counts.total === null ? `${format(counts.evaluated)} candidates evaluated, an unknown number dropped without evaluation or not explored (the domain is too large to count exactly)` :', 'const explored = counts.total === null ? `${format(counts.evaluated)} candidates evaluated` :', (m) => !/too large to count exactly/.test(oversizedCounts(m).text)],
]

// What the page's utilities import from packages.
const PAGE_STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

// What the page's script says when a search found no set, by how the search ended, on a pseudo instance (scripts/lib/page-loader.js): only a search that explored its whole domain can say that nothing reaches the targets.
const pageStatements = async (mutate) => {
  const options = await loadPage('pages/propulsion', { stubs: PAGE_STUBS, mutate })
  const page = (data) => instantiate(options, { $store: { getters: {}, state: {} }, database: {}, GameID: 1, RaceID: 2, data })
  const empty = (run, infeasible = 0) => ({ sets: [], packages: { optimal: 0, boundExhausted: 0, infeasible }, counts: { feasible: 0 }, run })
  const finished = { incomplete: false, termination: 'exhausted' }
  const stopped = { incomplete: true, termination: 'cancelled' }
  const cut = { incomplete: true, termination: 'time-budget' }

  return [
    ['a search that explored its whole domain and found no set says that no engine set reaches the targets', page({ searching: false, result: empty(finished) }).emptyNotice === 'unreachable'],
    ['a search that explored its whole domain, where a package request failed, says that no tank package holds the fuel', page({ searching: false, result: empty(finished, 3) }).emptyNotice === 'no-package'],
    ['a search the user stopped that found no set says only that none was found so far, though package requests failed', page({ searching: false, result: empty(stopped, 3) }).emptyNotice === 'so-far'],
    ['a search cut at its budget that found no set says only that none was found so far', page({ searching: false, result: empty(cut) }).emptyNotice === 'so-far'],
    ['a search that is still running says nothing of its result', page({ searching: true, result: empty(finished) }).emptyNotice === null],
    ['a result with a set, even an incomplete one, has no empty notice', page({ searching: false, result: { ...empty(stopped), sets: [{}] } }).emptyNotice === null],
    ['no result has no empty notice', page({ searching: false, result: null }).emptyNotice === null],
    ['the tiles of a search that explored its whole domain say that no set meets the targets', page({ searching: false, result: empty(finished) }).noSetNote === 'No set meets the targets'],
    ['the tiles of a search that stopped early say that no set was found so far', page({ searching: false, result: empty(stopped) }).noSetNote === 'No set found so far' && page({ searching: false, result: empty(cut) }).noSetNote === 'No set found so far'],
    ['the tiles of a search that is running say so', page({ searching: true, result: empty(stopped) }).noSetNote === 'Searching…'],
  ]
}

// [label, from, to]: a cut of the page's script that one of its statements must catch.
const PAGE_MUTATIONS = [
  ['a search that stopped early saying that nothing reaches the targets', 'if (result.run.incomplete) {\n        return \'so-far\'', 'if (false) {\n        return \'so-far\''],
  ['a package request that failed in a search that explored everything not told apart', 'return result.packages && result.packages.infeasible ? \'no-package\' : \'unreachable\'', 'return \'unreachable\''],
  ['the tiles of a search that stopped early saying that no set meets the targets', 'this.result && this.result.run.incomplete ? \'No set found so far\' : \'No set meets the targets\'', '\'No set meets the targets\''],
  ['a notice of a search that is still running', 'if (!result || result.sets.length || this.searching) {', 'if (!result || result.sets.length) {'],
]

// A short domain, small slices: a step ends inside the tank passes of a candidate.
const SHORT = { hullHS: 20, speed: 1500, goal: { mode: 'range', value: 1e9 }, share: 0.6, minCount: 1, maxCount: 8, tech: { ...TECH, maxSize: 1.6 }, tanks: STOCK_TANKS, slice: 6, keep: 4 }

// Whether at some step of the search of `input` the best sets it holds are not those of a search that stops at the candidates the step counts as evaluated.
const snapshotDisagrees = (m, input) => {
  const iterator = m.search.searchPropulsion(input)
  let step = iterator.next()

  while (!step.done) {
    const snapshot = step.value.snapshot()
    const stopped = drain(m.search.searchPropulsion({ ...input, maxCandidates: snapshot.counts.evaluated }))

    if (snapshot.counts.feasible !== stopped.counts.feasible || snapshot.sets.length !== stopped.sets.length) {
      return true
    }

    step = iterator.next()
  }

  return false
}

// The page's default search: a 5,000 ton hull, 2,500 km/s, 5 bn km at half power, either kind, 1 to 100 engines, half the ship.
const DEFAULT_INPUT = { hullHS: 100, speed: 2500, fraction: 0.5, goal: { mode: 'range', value: 5e9 }, kind: 'either', minCount: 1, maxCount: 100, share: 0.5 }

// The digest of the default search on the repository's saves, taken from the search before it kept counts or ran as a run: the sets, the best sets, the frontiers and the packages, then the evaluated and matched figures that `counts.evaluated` and `counts.feasible` now hold.
const ANCHORS = {
  'AuroraDB.db:140:784': { evaluated: 168284, matched: 141201, digest: 'db517f092dd4a48c', total: 2708300 },
  'AuroraDB_271_skoormit_saved.db:138:785': { evaluated: 64779, matched: 49905, digest: '20a9ab5a6d9e3308', total: 619100 },
}

const digest = ({ sets, lightest, fastest, cheapest, pareto, packages, counts }) => crypto.createHash('sha256').update(JSON.stringify({ sets, lightest, fastest, cheapest, pareto, packages, evaluated: counts.evaluated, matched: counts.feasible })).digest('hex').slice(0, 16)

const DEFAULT_TECH = { minThrust: 0.5, maxThrust: 1, maxSize: 25, thermalTech: 1, thermalCost: 1 }

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['../AuroraDB_271_skoormit_saved.db', 138, 785], part: null }

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

// ---------- the parts: each mutant, the checks of the real sources, the page and each save run in a process of their own ----------

const checkSynthetic = (mods) => {
  console.log('Synthetic domains')

  for (const [name, test] of synthetic(mods)) {
    let result

    try {
      result = test()
    } catch (error) {
      result = `threw ${error.stack}`
    }

    check(name, result)
  }
}

const checkMutation = async ([label, file, from, to, probe]) => {
  const sources = mutatedSources(file, from, to)
  let failed = []
  let mutant = null

  try {
    mutant = modulesOf(await loadUtilities(NAMES, { sources }))

    failed = synthetic(mutant).filter(([, test]) => {
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

  if (probe && mutant) {
    try {
      probed = probe(mutant)
    } catch (error) {
      probed = false
    }
  }

  check(`mutation caught: ${label}`, !probed ? 'the mutant does not show the fault it names' : failed.length > 0 ? true : 'every check still passes', `${failed.length} checks fail`)
}

const checkPage = async () => {
  for (const [statement, held] of await pageStatements(null)) {
    check(`page: ${statement}`, held)
  }
}

const checkPageMutation = async ([label, from, to]) => {
  let failed = []

  try {
    failed = (await pageStatements(replacing(from, to))).filter(([, held]) => held !== true)
  } catch (error) {
    failed = [[`does not load: ${error.message}`]]
  }

  check(`page mutation caught: ${label}`, failed.length > 0 ? true : 'every page check still passes', `${failed.length} checks fail`)
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
  const engines = await utilities['design-data'].loadRaceEngines(database, context)
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

  // A small part of the race's grid, so the enumeration can walk it: the engines of up to 3 HS between the least thrust and the lowest of the greatest and 0.7.
  const small = { ...designTech, maxSize: Math.min(3, designTech.maxSize), maxThrust: Math.min(designTech.maxThrust, Math.max(designTech.minThrust, 0.7)) }
  const own = engines.find((engine) => !engine.obsolete)
  const random = generator(GameID * 1000 + RaceID)

  const domains = [
    ['a range target on the race\'s tanks', { hullHS: 40, speed: 2000, fraction: 0.5, goal: { mode: 'range', value: 3e9 }, share: 0.5, maxCount: 30, tech: small, tanks }],
    ['custom count limits and an endurance target', { hullHS: 60, speed: 1500, fraction: 0.5, goal: { mode: 'endurance', value: 100 }, share: 0.4, minCount: 4, maxCount: 20, tech: small, tanks }],
    ['the limits policy and military engines', { hullHS: 40, speed: 2000, goal: { mode: 'range', value: 2e9 }, kind: 'military', share: 0.5, maxCount: 20, include: 'limits', tech: small, tanks }],
    ['no target', { hullHS: 40, speed: 3000, share: 0.5, maxCount: 25, tech: small, tanks }],
    ...(own ? [['one of the race\'s own engines', { hullHS: 100 + Math.round(random() * 100), speed: 1500, goal: { mode: 'range', value: 2e9 }, share: 0.6, maxCount: 80, engine: own, tech: small, tanks }]] : []),
  ]

  for (const [name, input] of domains) {
    check(`${label}: the search and an unpruned enumeration agree: ${name}`, agrees(mods, input))
  }

  const input = { ...DEFAULT_INPUT, tech: designTech, tanks }
  const sweep = mods.search.engineSweep({ tech: designTech, minCount: 1, maxCount: 100 })
  const made = mods.search.propulsionRun(input)
  const outcome = finish(made)
  const anchor = ANCHORS[`${path.basename(file)}:${GameID}:${RaceID}`]

  check(`${label}: the default search is a complete run of its whole domain within the default budget (${outcome.counts.evaluated} evaluated, ${outcome.counts.pruned} dropped of ${outcome.counts.total}, ${outcome.counts.feasible} meet the targets, ${outcome.counts.retained} kept)`, outcome.status === 'complete' && outcome.counts.total === sweep.combinations && outcome.counts.unexplored === 0 && outcome.counts.evaluated + outcome.counts.pruned === outcome.counts.total && outcome.result.sets.length === 50 && outcome.result.output.omitted === outcome.counts.feasible - 50 && outcome.descriptor.input === input ? true : short([outcome.status, outcome.counts]))

  if (anchor) {
    const result = outcome.result

    check(`${label}: the default search through the run still gives the result taken before runs existed`, result.counts.evaluated === anchor.evaluated && result.counts.feasible === anchor.matched && result.counts.total === anchor.total && digest(result) === anchor.digest ? true : `${result.counts.evaluated}/${result.counts.feasible}/${digest(result)} vs ${anchor.evaluated}/${anchor.matched}/${anchor.digest}`, `${anchor.evaluated} evaluated, ${anchor.matched} matched, digest ${anchor.digest}`)
  } else {
    console.log('SKIP  no digest of the unchanged search is recorded for this save')
  }

  const stopped = mods.search.propulsionRun(input)
  const key = stopped.descriptor.inputKey
  let slices = 0

  while (stopped.running && slices < 10) {
    stopped.advance(mods.run.RESPONSIVENESS.sliceMs)
    slices++
  }

  const cut = stopped.cancel() && stopped.outcome()

  check(`${label}: the default search cancelled after ${slices} slices is incomplete, names the input it was given, and holds the best of what it explored (${cut.counts.evaluated} of ${cut.counts.total} candidates)`, cut.status === 'cancelled' && cut.incomplete && cut.descriptor.input === input && cut.descriptor.inputKey === key && cut.counts.unexplored > 0 && cut.result && cut.result.sets.length > 0 && cut.counts.evaluated > 0 ? true : short([cut.status, cut.counts]))

  database.close()
}

const SAVE_LABELS = ['modded', 'stock']

// One part, in this process: `synthetic`, a mutation by its id (`utility:3`, `page:1`), `page` or a save by its label.
const runPart = async (part, options) => {
  const [kind, index] = part.split(':')

  if (kind === 'utility') {
    await checkMutation(MUTATIONS[Number(index)])
  } else if (kind === 'page' && index !== undefined) {
    await checkPageMutation(PAGE_MUTATIONS[Number(index)])
  } else if (part === 'page') {
    await checkPage()
  } else if (part === 'synthetic' || SAVE_LABELS.includes(part)) {
    const utilities = await loadUtilities([...NAMES, 'design-data', 'race-tech'])

    if (part === 'synthetic') {
      checkSynthetic(modulesOf(utilities))
    } else {
      await checkSave(part, options[part], utilities, modulesOf(utilities))
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
    { part: 'synthetic', weight: 20 },
    ...MUTATIONS.map((_mutation, index) => ({ part: `utility:${index}`, weight: 10 })),
    { part: 'page', weight: 2 },
    ...PAGE_MUTATIONS.map((_mutation, index) => ({ part: `page:${index}`, weight: 2 })),
    ...SAVE_LABELS.map((label) => ({ part: label, weight: 60 })),
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
  console.log('\nThe propulsion page (its script on a pseudo instance, scripts/lib/page-loader.js)')
  printed()
  PAGE_MUTATIONS.forEach(printed)
  SAVE_LABELS.forEach(printed)

  console.log('\nstep times are not asserted here; scripts/bench-tank-packing.js reports them against the responsiveness budget')
  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
