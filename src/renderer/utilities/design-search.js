// The propulsion search: for a hull without its engines and fuel, a speed and a range or an endurance, every engine the race's tech can design (a size, a thrust modifier) at every count that fits, with the fuel tanks that give the range, ranked by how little of the ship the propulsion takes. Sizes are in hull spaces (HS), power in engine power (EP), fuel in litres, speed in km/s, range in km, endurance in hours, cost in BP, as in design-rules.js.
//
// `searchPropulsion` is a generator: it yields { progress, evaluated, matched } about every `slice` candidates so the page can run it in slices between frames, and returns the result.

import { classSpeed, engineDesign, fullPowerRangeKm, MAX_SPEED, thermalSignature, TONS_PER_HS } from './design-rules'
import { combinationCount, readValue, sweepDomain } from './sweep-domain'
import { meetsRequest, PACKAGE_STATUS, packerFor } from './tank-packing'

export const THRUST_STEP = 0.05
export const MIN_ENGINE_SIZE_HS = 1
export const KEPT_SETS = 50
export const SLICE_CANDIDATES = 2000

// The most times a set's tanks are sized again, each time for the speed the ship has with the tanks of the time before. The tanks only grow, so a few passes settle; one that doesn't is dropped.
const MAX_TANK_PASSES = 24
// What a candidate that packs tanks counts for against a slice, next to one that doesn't: a lookup in the packer's table costs a few candidates' work, and walking a package back from the table costs a little for each tank in it, which a catalogue of one small tank and large ones makes long.
const TANK_WORK = 6
const TANK_COUNT_WORK = 0.01
const EPSILON = 1e-9
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
// A set has `engine`, `count`, `power`, `engineHS`, `tankHS`, `propulsionHS`, `tons`, `totalHS`, `share`, `speed`, `litres`, `tanks`, `tankPackage` (`{ status, reason, requestedLitres, excessLitres }` of its fuel tanks: 'optimal' when they are proved the lightest package that holds the fuel, 'bound-exhausted' with the reason when a bound ran out and they only hold it, null for a set with no fuel), `burnFull`, `burnCruise`, `rangeKm`, `enduranceHours`, `cost`, `crew`, `commercial` and `thermal`. Returns { sets (the best `keep`, ranked), lightest, fastest, cheapest, pareto: { speed, range } (the sets that no other beats on share of the ship and on speed, or on range), packages: { optimal, boundExhausted, infeasible } (the fuel packages of the candidates that met the speed: proved lightest, not proved, and none that holds the fuel, which drops the candidate), evaluated, matched }.
export function* searchPropulsion({ hullHS, speed, fraction = 1, goal = null, kind = 'either', minCount = 1, maxCount = 100, share = 1, tech, tanks = [], engine = null, include = 'grid', sweep = null, keep = KEPT_SETS, slice = SLICE_CANDIDATES }) {
  const plan = sweep || engineSweep({ tech, engine, minCount, maxCount, include })

  if (!plan.ok) {
    throw new Error(`The sweep cannot run. ${plan.problems.join(' ')}`)
  }

  const sets = []
  const frontiers = { speed: [], rangeKm: [] }
  const best = { fastest: null, cheapest: null }
  const floorKm = Math.max(0, Math.ceil(speed - EPSILON))
  const floorFraction = floorKm / 1000
  const sizes = engine ? [] : plan.sizes.toArray()
  const thrusts = engine ? [] : plan.thrusts.toArray()
  const total = engine ? 1 : sizes.length * thrusts.length
  const designs = engine ? [engine] : gridDesigns({ sizes, thrusts, tech, kind })
  let evaluated = 0
  let matched = 0
  let work = 0
  let done = 0

  const packages = { optimal: 0, boundExhausted: 0, infeasible: 0 }

  const finish = () => ({ sets, lightest: sets[0] || null, fastest: best.fastest, cheapest: best.cheapest, pareto: { speed: frontiers.speed, range: frontiers.rangeKm }, packages, evaluated, matched })

  if (floorKm > MAX_SPEED || !(hullHS >= 0)) {
    return finish()
  }

  const packer = packerFor(tanks)

  // The tables a package needs are built before the search starts, a chunk at a time, so no step of it waits for a whole table.
  if (goal && goal.value > 0) {
    const warming = packer.warm()

    while (!warming.next().done) {
      yield { progress: 0, evaluated, matched }
    }
  }

  for (const design of designs) {
    done++

    if (design === null) {
      work++
    } else {
      // The engines this design needs to reach the speed on the bare hull, and the most that fit the share: the counts in between are tried.
      const room = design.power - floorFraction * design.sizeHS
      let first = plan.counts.first
      let last = plan.counts.last

      if (floorKm > 0) {
        first = room > 0 ? Math.max(first, Math.floor(floorFraction * hullHS / room)) : last + 1
      }

      if (share < 1) {
        last = Math.min(last, Math.floor(share * hullHS / (design.sizeHS * (1 - share))) + 1)
      }

      for (let count = first; count <= last; count++) {
        if (work >= slice) {
          work = 0

          yield { progress: done / total, evaluated, matched }
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
          pack = packer.pack(goal.value * burnCruise)
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
            if (work >= slice) {
              work = 0

              yield { progress: done / total, evaluated, matched }
            }

            work += TANK_WORK
            pack = packer.pack(litres)
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

        if (wantsRank || wantsFastest || wantsCheapest || wantsSpeedFrontier || wantsRangeFrontier) {
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
            crew: pack.crew === null ? null : count * design.crew + pack.crew,
            commercial: design.commercial,
            thermal: thermalSignature({ enginePower: power, stealthRating: design.thermalRating, fraction, sizeHS: totalHS }),
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
    }

    if (work >= slice) {
      work = 0

      yield { progress: done / total, evaluated, matched }
    }
  }

  return finish()
}
