// The propulsion search: for a hull without its engines and fuel, a speed and a range or an endurance, every engine the race's tech can design (a size, a thrust modifier) at every count that fits, with the fuel tanks that give the range, ranked by how little of the ship the propulsion takes. Sizes are in hull spaces (HS), power in engine power (EP), fuel in litres, speed in km/s, range in km, endurance in hours, cost in BP, as in design-rules.js.
//
// `searchPropulsion` is a generator that follows the protocol of search-run.js: it yields { progress, counts, snapshot } about every `slice` units of work so the page can run it in slices between frames, and returns the result with its counts, what its output left out and how it ended. `propulsionRun` is the search as a run (a descriptor, a budget, cancellation and invalidation), which is how the page runs it.

import { classSpeed, engineDesign, fullPowerRangeKm, MAX_SPEED, thermalSignature, TONS_PER_HS } from './design-rules'
import { createFront, FRONT_LIMIT } from './pareto'
import { createRun, TERMINATION, UNPACED } from './search-run'
import { combinationCount, describeSweep, readValue, SWEEP_KINDS, sweepDomain } from './sweep-domain'
import { meetsRequest, PACKAGE_STATUS, packerFor } from './tank-packing'

export const THRUST_STEP = 0.05
export const MIN_ENGINE_SIZE_HS = 1
export const KEPT_SETS = 50
export const SLICE_CANDIDATES = 2000

// What a run of the search may spend: the most candidates it evaluates (the search stops itself there) and the most milliseconds it runs for (the run stops it). Past either the run ends truncated, and says how much of its domain was explored. The default engine search is a small part of the first: it evaluates about 170,000 candidates on the repository's modded save, in under a second.
export const SEARCH_BUDGET = Object.freeze({ candidates: 5000000, ms: 30000 })

// The most times a set's tanks are sized again, each time for the speed the ship has with the tanks of the time before. The tanks only grow, so a few passes settle; one that doesn't is dropped.
const MAX_TANK_PASSES = 24
// What a candidate that packs tanks counts for against a slice, next to one that doesn't: a lookup in the packer's table costs a few candidates' work, and walking a package back from the table costs a little for each tank in it, which a catalogue of one small tank and large ones makes long.
const TANK_WORK = 6
const TANK_COUNT_WORK = 0.01
// What an engine design built, or skipped for its kind, counts for against a slice: the work of the candidates it holds is counted as they are evaluated, so a design that holds none (the speed or the share rules every count out) still moves a slice along.
const DESIGN_WORK = 1
// What each member of the efficient front that a set is compared with counts for against a slice: a front of its limit costs a candidate about as much as a package does.
const FRONT_WORK = 0.01
// How many looks at whether the step has run long enough pass between two reads of the clock: a candidate that is rejected at once costs far less than the read, and sixteen that pack tanks stay within a millisecond or two.
export const CLOCK_EVERY = 16
const EPSILON = 1e-9
// What a set of an engine stored without a cost carries, so the other sets keep the shape they had.
const UNKNOWN_COST = Object.freeze({ costKnown: false })
const NO_TANKS = Object.freeze({ status: null, reason: null, complete: true, feasible: true, requestedLitres: 0, litres: 0, excessLitres: 0, count: 0, sizeHS: 0, cost: 0, crew: 0, picks: Object.freeze([]) })

// The engine sizes the search tries: from 1 HS up to the largest the race may design, every 0.1 HS to 10, every 0.25 HS above that to 20, then every whole HS. Each stretch steps from the end of the one before, and the steps are multiples of the step from 0 HS.
export const ENGINE_SIZE_BANDS = Object.freeze([{ step: 0.1, to: 10 }, { step: 0.25, to: 20 }, { step: 1 }])

// What a bound of the grid that falls between two steps does: 'grid' leaves it out (the last size is the largest step not above the largest researched, the last thrust likewise), 'limits' tries it too, once, as the last (or first) value.
export const ENDPOINT_POLICIES = Object.freeze(['grid', 'limits'])

const BOUND_LABELS = {
  sizes: { min: 'Smallest engine size', max: 'Largest researched engine size', domain: 'Engine size' },
  thrusts: { min: 'Least researched thrust', max: 'Greatest researched thrust', domain: 'Engine thrust' },
  counts: { min: 'Fewest engines', max: 'Most engines', domain: 'Engine count' },
}

const problemsOf = (name, domain) => Object.entries(domain.errors).map(([field, message]) => `${BOUND_LABELS[name][field] || BOUND_LABELS[name].domain}: ${message}`)

// The values the search sweeps, as typed domains (sweep-domain.js): the engine sizes and thrust modifiers of the grid (none when `engine` is one of the race's own, whose size and thrust are fixed), and the engine counts, with `combinations`, the most candidates the grid and the counts make before the search drops those that cannot reach the speed or fit the share. The thrust grid is every 0.05 from the least to the most the race has researched. `include` is the endpoint policy for a researched limit that falls between two steps. `ok` is false, with the `problems` in words, for a sweep that cannot run.
export const engineSweep = ({ tech = null, engine = null, minCount = 1, maxCount = 100, include = 'grid' }) => {
  const counts = sweepDomain({ kind: 'count', min: minCount, max: maxCount, step: 1, limits: { min: 1 } })
  const problems = problemsOf('counts', counts)
  let sizes = null
  let thrusts = null

  if (!engine) {
    if (!tech) {
      problems.push('The race has no engine tech to design engines with.')
    } else {
      sizes = sweepDomain({ kind: 'sizeHS', min: MIN_ENGINE_SIZE_HS, max: tech.maxSize, bands: ENGINE_SIZE_BANDS, anchor: 'zero', include, snap: 'inward' })
      thrusts = sweepDomain({ kind: 'thrust', min: tech.minThrust, max: tech.maxThrust, step: THRUST_STEP, anchor: 'zero', include, snap: 'inward' })
      problems.push(...problemsOf('sizes', sizes), ...problemsOf('thrusts', thrusts))
    }
  }

  const combinations = problems.length ? null : combinationCount(engine ? [counts] : [sizes, thrusts, counts])

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems), include, sizes, thrusts, counts, combinations })
}

// The engine count and share fields of the page, as typed (numbers or the text of a field; the share in percent): { ok, errors: { min, max, share } (a message for each field that is wrong, none for one that is right), min, max, share } with the values as the search takes them (the share as a fraction) when ok.
export const engineFields = ({ min, max, share }) => {
  const counts = sweepDomain({ kind: 'count', min, max, step: 1, limits: { min: 1 } })
  const percent = readValue(share, { kind: 'percent', limits: { min: 1, max: 100 } })
  const errors = {}

  for (const field of ['min', 'max']) {
    if (counts.errors[field]) {
      errors[field] = counts.errors[field]
    }
  }

  if (!percent.ok) {
    errors.share = percent.error
  }

  const ok = Object.keys(errors).length === 0

  return Object.freeze({ ok, errors: Object.freeze(errors), min: ok ? counts.min : null, max: ok ? counts.max : null, share: ok ? percent.value / 100 : null })
}

// A stored `{ kind, min, max, share, exactLimits }` of the page's engine options in the shape the page keeps now, or undefined for one that is not one. Options stored before the endpoint policy existed have no `exactLimits` (the grid policy), and a share the old fields accepted below 1% is the 1% the old search clamped it to, so what was kept stays as the search read it.
export const normaliseEngineOptions = (stored) => {
  if (stored === null || typeof stored !== 'object' || !['either', 'military', 'commercial'].includes(stored.kind) || !Number.isInteger(stored.min) || !Number.isInteger(stored.max) || stored.min < 1 || stored.max < stored.min || !(stored.share > 0 && stored.share <= 1) || (stored.exactLimits !== undefined && typeof stored.exactLimits !== 'boolean')) {
    return undefined
  }

  return { kind: stored.kind, min: stored.min, max: stored.max, share: Math.max(0.01, stored.share), exactLimits: stored.exactLimits === true }
}

// The deterministic name of a candidate, from the engine and the count alone: 'grid:<size in thousandths of HS>:<thrust in thousandths>:<count>' for a designed engine, 'engine:<id>:<count>' for one of the race's own. A set (or a candidate before it is a set) has one name in every run, whatever else was searched.
export const candidateId = ({ engine, count }) => (engine.id === undefined ? `grid:${Math.round(engine.sizeHS * SWEEP_KINDS.sizeHS.scale)}:${Math.round(engine.thrust * SWEEP_KINDS.thrust.scale)}:${count}` : `engine:${engine.id}:${count}`)

// What a run of the engine search explores, from the sweep it was given: `total` the candidates of the grid and the counts (before the search drops those that cannot reach the speed or fit the share; null past a safe integer), `order` how they are visited, `axes` each swept value as the preview states it, and `signature`, which is the same for the same domain (the sweep, the kind of engine wanted, the policy at its limits and the race's own engine, if one).
export const engineDomain = (plan, { kind = 'either', engine = null } = {}) => {
  const axis = (domain, unit) => (domain ? { unit, count: domain.count, first: domain.first, last: domain.last, ranges: describeSweep(domain).ranges } : null)

  if (!plan.ok) {
    return Object.freeze({ kind: 'engine-grid', total: null, order: [], axes: {}, signature: `invalid:${plan.problems.join('|')}`, idFormat: null })
  }

  const signature = [engine ? `engine:${engine.id}` : `grid:${kind}`, plan.include, plan.sizes ? plan.sizes.signature : '-', plan.thrusts ? plan.thrusts.signature : '-', plan.counts.signature].join('|')

  return Object.freeze({
    kind: engine ? 'engine-counts' : 'engine-grid',
    total: plan.combinations,
    order: engine ? ['count'] : ['size', 'thrust', 'count'],
    axes: Object.freeze({ sizes: axis(plan.sizes, 'HS'), thrusts: axis(plan.thrusts, ''), counts: axis(plan.counts, '') }),
    signature,
    idFormat: engine ? 'engine:<id>:<count>' : 'grid:<thousandths of HS>:<thousandths of thrust>:<count>',
  })
}

// Whether set `a` ranks ahead of `b`: the less HS the propulsion takes, then the less it costs, then the faster it is.
const ranksAhead = (a, b) => {
  if (Math.abs(a.propulsionHS - b.propulsionHS) > EPSILON) {
    return a.propulsionHS < b.propulsionHS
  }

  if (Math.abs(a.cost - b.cost) > EPSILON) {
    return a.cost < b.cost
  }

  return a.speed > b.speed
}

// The same ranking on a candidate's figures, before a set is built from it.
const ranksAheadOf = (propulsionHS, cost, speed, set) => {
  if (Math.abs(propulsionHS - set.propulsionHS) > EPSILON) {
    return propulsionHS < set.propulsionHS
  }

  if (Math.abs(cost - set.cost) > EPSILON) {
    return cost < set.cost
  }

  return speed > set.speed
}

// The sets no other set beats on both axes: the least share of the ship (`share`) and the most of `key`. Kept as a list by share, least first, whose `key` rises along it.
const frontierSlot = (frontier, share) => {
  let low = 0
  let high = frontier.length

  while (low < high) {
    const middle = (low + high) >> 1

    if (frontier[middle].share <= share) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return low
}

const frontierWants = (frontier, key, share, value) => {
  const slot = frontierSlot(frontier, share)

  return slot === 0 || frontier[slot - 1][key] < value
}

const frontierAdd = (frontier, key, set) => {
  const slot = frontierSlot(frontier, set.share)
  let end = slot

  while (end < frontier.length && frontier[end][key] <= set[key]) {
    end++
  }

  frontier.splice(slot, end - slot, set)
}

const insertRanked = (sets, set, keep) => {
  let low = 0
  let high = sets.length

  while (low < high) {
    const middle = (low + high) >> 1

    if (ranksAhead(sets[middle], set)) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  sets.splice(low, 0, set)

  if (sets.length > keep) {
    sets.pop()
  }
}

// The engine designs of the grid: every size at every thrust, as `engineDesign` makes them, each with the thermal rating of the race's thermal reduction tech, filtered by kind ('military', 'commercial' or 'either').
function* gridDesigns({ sizes, thrusts, tech, kind }) {
  for (const sizeHS of sizes) {
    for (const thrust of thrusts) {
      const design = engineDesign({ sizeHS, thrust, engineTech: tech.engineTech, fuelTech: tech.fuelTech, thermalTech: tech.thermalTech, thermalCost: tech.thermalCost })

      if (kind === 'either' || design.commercial === (kind === 'commercial')) {
        design.thrust = thrust
        design.thermalRating = tech.thermalTech
        yield design
      } else {
        yield null
      }
    }
  }
}

// Ranks propulsion sets. Input:
// - `hullHS`: the hull without engines or fuel tanks, `speed` the least speed in km/s, `fraction` the share of the engines' power the ship cruises at.
// - `goal`: `{ mode: 'range', value }` (km at full power) or `{ mode: 'endurance', value }` (hours at `fraction` of the power), or null for none, which fits no tanks.
// - `kind`: 'military', 'commercial' or 'either'; `minCount` and `maxCount` the engines a set may have (whole numbers, 1 or more, the fewest not above the most); `share` the most of the finished ship the engines and tanks may take.
// - `tech`: `{ engineTech, fuelTech, thermalTech, thermalCost, minThrust, maxThrust, maxSize }`, the levels the race designs with; `tanks`: the stock tanks as `packTanks` takes them (`packerFor(tanks)` keeps the tables built for them, so a later search of the same list starts with them).
// - `engine`: one of the race's own engines (as design-data.js `loadRaceEngines` has them) to search only its count, or null to design engines.
// - `include`: the endpoint policy of the grid ('grid' or 'limits', see `engineSweep`), `sweep` an `engineSweep` the caller already made (the page's preview), which must be for the same `tech`, counts and policy; a sweep that is not `ok` throws before anything runs.
// - `keep`: how many ranked sets the result lists, `slice` the units of work between two yields, `maxCandidates` the most candidates it evaluates (null for no limit): at that many, with candidates left in its domain, it returns what it has with `termination: 'candidate-budget'`.
// - `axes`: `[{ key, goal }]` (pareto.js) to keep the front of the sets that no set meeting the targets beats on those axes (none, the default, keeps none); the front is built from every set that meets the targets, whatever `keep` lists, and holds at most `frontLimit` sets.
// - `pace`: `{ expired() }`, which says when the step's time is up (the run gives its own; the default never expires). The search yields there as well as at `slice`, between candidates and passes and inside the tank tables and package walks, and goes on where it stopped: the results are the same wherever it yields.
// A set has `engine`, `count`, `power`, `engineHS`, `tankHS`, `propulsionHS`, `tons`, `totalHS`, `share`, `speed`, `litres`, `tanks`, `tankPackage` (`{ status, reason, requestedLitres, excessLitres }` of its fuel tanks: 'optimal' when they are proved the lightest package that holds the fuel, 'bound-exhausted' with the reason when a bound ran out and they only hold it, null for a set with no fuel), `burnFull`, `burnCruise`, `rangeKm`, `enduranceHours`, `cost`, `costKnown: false` (only on a set of an engine the save stores without a cost, which `cost` then prices at nothing), `crew`, `commercial` and `thermal`; `candidateId(set)` names it.
// The work of a step is counted in units: `DESIGN_WORK` for each engine design built (or skipped for its kind), 1 for each candidate evaluated, and `TANK_WORK` and `TANK_COUNT_WORK` for each tank package, so a step is bounded by `slice` plus the work of one candidate or one design whether the candidates are rejected at once or pack large packages, and the first yield comes before any candidate when tables are warmed. The pace bounds a step in time as well: the clock is read every `CLOCK_EVERY` looks, so units that cost more than they are counted for (a slow machine, a long table build or walk, which yield by themselves) still end the step at the pace's deadline.
// Returns { sets (the best `keep`, ranked), lightest, fastest, cheapest, pareto: { speed, range } (the sets that no other beats on share of the ship and on speed, or on range), efficient (the front of `axes` from pareto.js, with its status: provisional unless the whole domain was explored, null without `axes`), packages: { optimal, boundExhausted, infeasible } (the fuel packages of the candidates that met the speed: proved lightest, not proved, and none that holds the fuel, which drops the candidate), counts (as search-run.js has them: `pruned` the candidates of the domain left out because the speed or the share rules out every count beyond a bound, `prunedBy` the reasons: 'kind' of engine not wanted, 'speed', 'share', 'input'; `total`, `pruned`, `unexplored` and `prunedBy` are null when the domain passes a safe integer, where they cannot be exact), output: { limit, listed, omitted } (the ranked list's cut: `omitted` is the feasible candidates it does not list, which says nothing of how much was explored), termination }. A snapshot has the same shape with `termination` null, and does not count the candidate whose tank passes the step ended in.
export function* searchPropulsion({ hullHS, speed, fraction = 1, goal = null, kind = 'either', minCount = 1, maxCount = 100, share = 1, tech, tanks = [], engine = null, include = 'grid', sweep = null, keep = KEPT_SETS, slice = SLICE_CANDIDATES, maxCandidates = null, axes = [], frontLimit = FRONT_LIMIT, pace = UNPACED }) {
  const plan = sweep || engineSweep({ tech, engine, minCount, maxCount, include })

  if (!plan.ok) {
    throw new Error(`The sweep cannot run. ${plan.problems.join(' ')}`)
  }

  const sets = []
  const frontiers = { speed: [], rangeKm: [] }
  const front = axes.length ? createFront(axes, { limit: frontLimit, name: candidateId }) : null
  const best = { fastest: null, cheapest: null }
  const floorKm = Math.max(0, Math.ceil(speed - EPSILON))
  const floorFraction = floorKm / 1000
  const sizes = engine ? [] : plan.sizes.toArray()
  const thrusts = engine ? [] : plan.thrusts.toArray()
  const designTotal = engine ? 1 : sizes.length * thrusts.length
  const perDesign = plan.counts.count
  const total = designTotal * perDesign
  const exact = Number.isSafeInteger(total)
  const designs = engine ? [engine] : gridDesigns({ sizes, thrusts, tech, kind })
  const pruned = { kind: 0, speed: 0, share: 0, input: 0 }
  let evaluated = 0
  let matched = 0
  let work = 0
  let done = 0

  const packages = { optimal: 0, boundExhausted: 0, infeasible: 0 }

  // The results the search holds: the ranked list, both frontiers, the efficient front and the fastest and cheapest sets, each once.
  const retained = () => new Set([...sets, ...frontiers.speed, ...frontiers.rangeKm, ...(front ? front.sets() : []), best.fastest, best.cheapest].filter(Boolean)).size

  // `pending` is 1 for a step that ends inside the tank passes of a candidate: that candidate is not yet evaluated, and a snapshot of the step leaves it out.
  const countsNow = (pending) => {
    const dropped = pruned.kind + pruned.speed + pruned.share + pruned.input

    if (!exact) {
      return { total: null, evaluated: evaluated - pending, pruned: null, unexplored: null, feasible: matched, retained: retained(), prunedBy: null }
    }

    return { total, evaluated: evaluated - pending, pruned: dropped, unexplored: total - (evaluated - pending) - dropped, feasible: matched, retained: retained(), prunedBy: { ...pruned } }
  }

  const resultOf = (termination, pending) => ({ sets: sets.slice(), lightest: sets[0] || null, fastest: best.fastest, cheapest: best.cheapest, pareto: { speed: frontiers.speed.slice(), range: frontiers.rangeKm.slice() }, efficient: front ? front.result({ explored: termination === TERMINATION.EXHAUSTED, feasible: matched }) : null, packages: { ...packages }, counts: countsNow(pending), output: { limit: keep, listed: sets.length, omitted: matched - sets.length }, termination })

  const stepOf = (pending = 0) => ({ progress: done / designTotal, counts: countsNow(pending), snapshot: () => resultOf(null, pending) })

  // Whether the step has run long enough: its work reaches the slice, or the pace says its time is up (looked at every CLOCK_EVERY times).
  let looks = 0

  const due = () => {
    if (work >= slice) {
      return true
    }

    if (++looks < CLOCK_EVERY) {
      return false
    }

    looks = 0

    return pace.expired()
  }

  // The package for a request. The table it needs and the walk back from it yield while the pace is up, and the step then ends with the candidate it is for not yet evaluated.
  const packNow = function* (litres) {
    const packing = packer.packing(litres, 'lightest', pace)
    let step = packing.next()

    while (!step.done) {
      work = 0

      yield stepOf(1)

      step = packing.next()
    }

    return step.value
  }

  if (floorKm > MAX_SPEED || !(hullHS >= 0)) {
    pruned[floorKm > MAX_SPEED ? 'speed' : 'input'] = total

    return resultOf(TERMINATION.EXHAUSTED, 0)
  }

  const packer = packerFor(tanks)

  // The tables a package needs are built before the search starts, a chunk at a time, so no step of it waits for a whole table.
  if (goal && goal.value > 0) {
    const warming = packer.warm()

    while (!warming.next().done) {
      yield stepOf()
    }
  }

  for (const design of designs) {
    done++
    work += DESIGN_WORK

    if (design === null) {
      pruned.kind += perDesign
    } else {
      // An engine the save stores without a cost is priced at nothing by `cost` below (the ranking has always read it so); the set says it is not known, which the efficient front takes as no figure.
      const costKnown = Number.isFinite(design.cost)

      // The engines this design needs to reach the speed on the bare hull, and the most that fit the share: the counts in between are tried.
      const room = design.power - floorFraction * design.sizeHS
      let first = plan.counts.first
      let last = plan.counts.last

      if (floorKm > 0) {
        first = room > 0 ? Math.max(first, Math.floor(floorFraction * hullHS / room)) : last + 1
      }

      // The counts below the first can't reach the speed; those the loop does not reach above the last are ruled out by the share.
      const below = Math.min(perDesign, Math.max(0, first - plan.counts.first))
      const entered = evaluated

      pruned.speed += below

      if (share < 1) {
        last = Math.min(last, Math.floor(share * hullHS / (design.sizeHS * (1 - share))) + 1)
      }

      for (let count = first; count <= last; count++) {
        if (maxCandidates !== null && evaluated >= maxCandidates) {
          return resultOf(TERMINATION.CANDIDATE_BUDGET, 0)
        }

        if (due()) {
          work = 0

          yield stepOf()
        }

        work++
        evaluated++

        const power = count * design.power
        const engineHS = count * design.sizeHS
        const bareHS = hullHS + engineHS

        if (engineHS > share * bareHS + EPSILON) {
          break
        }

        const bareSpeed = classSpeed({ enginePower: power, sizeHS: bareHS })

        if (bareSpeed < floorKm) {
          continue
        }

        const burnFull = power * design.fuelPerEph
        const burnCruise = burnFull * fraction
        let pack = NO_TANKS
        let finalSpeed = bareSpeed

        if (goal && goal.value > 0 && goal.mode === 'endurance') {
          work += TANK_WORK
          pack = yield * packNow(goal.value * burnCruise)
          work += pack.count * TANK_COUNT_WORK

          if (!pack.feasible) {
            packages.infeasible++

            continue
          }

          finalSpeed = classSpeed({ enginePower: power, sizeHS: bareHS + pack.sizeHS })

          if (finalSpeed < floorKm || !meetsRequest(pack.litres, goal.value * burnCruise)) {
            continue
          }
        } else if (goal && goal.value > 0 && goal.mode === 'range') {
          let litres = bareSpeed > 0 ? goal.value * burnFull / (bareSpeed * 3600) : Infinity
          let settled = false

          for (let pass = 0; pass < MAX_TANK_PASSES && Number.isFinite(litres); pass++) {
            if (due()) {
              work = 0

              yield stepOf(1)
            }

            work += TANK_WORK
            pack = yield * packNow(litres)
            work += pack.count * TANK_COUNT_WORK

            if (!pack.feasible) {
              packages.infeasible++

              break
            }

            finalSpeed = classSpeed({ enginePower: power, sizeHS: bareHS + pack.sizeHS })

            if (!(finalSpeed >= floorKm && finalSpeed > 0)) {
              break
            }

            const needed = goal.value * burnFull / (finalSpeed * 3600)

            if (meetsRequest(pack.litres, needed)) {
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
          break
        }

        matched++

        if (pack.status === PACKAGE_STATUS.OPTIMAL) {
          packages.optimal++
        } else if (pack.status === PACKAGE_STATUS.BOUND_EXHAUSTED) {
          packages.boundExhausted++
        }

        const cost = count * design.cost + pack.cost
        const rangeKm = burnFull > 0 ? fullPowerRangeKm({ fuel: pack.litres, enginePower: power, fuelPerEph: design.fuelPerEph, speed: finalSpeed }) : 0
        const wantsRank = sets.length < keep || ranksAheadOf(propulsionHS, cost, finalSpeed, sets[sets.length - 1])
        const wantsFastest = !best.fastest || finalSpeed > best.fastest.speed || (finalSpeed === best.fastest.speed && ranksAheadOf(propulsionHS, cost, finalSpeed, best.fastest))
        const wantsCheapest = !best.cheapest || cost < best.cheapest.cost - EPSILON || (Math.abs(cost - best.cheapest.cost) <= EPSILON && ranksAheadOf(propulsionHS, cost, finalSpeed, best.cheapest))
        const wantsSpeedFrontier = frontierWants(frontiers.speed, 'speed', propulsionShare, finalSpeed)
        const wantsRangeFrontier = frontierWants(frontiers.rangeKm, 'rangeKm', propulsionShare, rangeKm)

        if (wantsRank || wantsFastest || wantsCheapest || wantsSpeedFrontier || wantsRangeFrontier || front) {
          const set = {
            engine: design,
            count,
            power,
            engineHS,
            tankHS: pack.sizeHS,
            propulsionHS,
            tons: propulsionHS * TONS_PER_HS,
            hullHS,
            totalHS,
            share: propulsionShare,
            speed: finalSpeed,
            litres: pack.litres,
            tanks: pack.picks,
            tankPackage: pack.status ? { status: pack.status, reason: pack.reason, requestedLitres: pack.requestedLitres, excessLitres: pack.excessLitres } : null,
            burnFull,
            burnCruise,
            rangeKm,
            enduranceHours: burnCruise > 0 ? pack.litres / burnCruise : 0,
            cost,
            ...(costKnown ? null : UNKNOWN_COST),
            crew: pack.crew === null ? null : count * design.crew + pack.crew,
            commercial: design.commercial,
            thermal: thermalSignature({ enginePower: power, stealthRating: design.thermalRating, fraction, sizeHS: totalHS }),
          }

          if (front) {
            front.offer(set)
            work += front.scanned * FRONT_WORK
          }

          if (wantsRank) {
            insertRanked(sets, set, keep)
          }

          if (wantsFastest) {
            best.fastest = set
          }

          if (wantsCheapest) {
            best.cheapest = set
          }

          if (wantsSpeedFrontier) {
            frontierAdd(frontiers.speed, 'speed', set)
          }

          if (wantsRangeFrontier) {
            frontierAdd(frontiers.rangeKm, 'rangeKm', set)
          }
        }
      }

      pruned.share += perDesign - below - (evaluated - entered)
    }

    if (due()) {
      work = 0

      yield stepOf()
    }
  }

  return resultOf(TERMINATION.EXHAUSTED, 0)
}

// The engine search as a run: its descriptor names the input and the domain, `budget` is { candidates, ms } (SEARCH_BUDGET by default; null for either is no limit), and `now` the clock. The sweep is made once and read by the descriptor and the search alike, and one that cannot run fails the run on its first step with the problems in words.
export const propulsionRun = (input, { budget = SEARCH_BUDGET, now } = {}) => {
  const plan = input.sweep || engineSweep({ tech: input.tech, engine: input.engine || null, minCount: input.minCount === undefined ? 1 : input.minCount, maxCount: input.maxCount === undefined ? 100 : input.maxCount, include: input.include || 'grid' })

  return createRun({ kind: 'engine-search', input, domain: engineDomain(plan, { kind: input.kind || 'either', engine: input.engine || null }), budget, now, search: (pace) => searchPropulsion({ ...input, sweep: plan, maxCandidates: budget.candidates, pace }) })
}
