// The propulsion search: for a hull without its engines and fuel, a speed and a range or an endurance, every engine the race's tech can design (a size, a thrust modifier) at every count that fits, with the fuel tanks that give the range, ranked by how little of the ship the propulsion takes. Sizes are in hull spaces (HS), power in engine power (EP), fuel in litres, speed in km/s, range in km, endurance in hours, cost in BP, as in design-rules.js.
//
// `searchPropulsion` is a generator: it yields { progress, evaluated, matched } about every `slice` candidates so the page can run it in slices between frames, and returns the result.

import { classSpeed, engineDesign, fullPowerRangeKm, MAX_SPEED, packTanks, thermalSignature, TONS_PER_HS } from './design-rules'

export const THRUST_STEP = 0.05
export const MIN_ENGINE_SIZE_HS = 1
export const KEPT_SETS = 50
export const SLICE_CANDIDATES = 2000

// The most times a set's tanks are sized again, each time for the speed the ship has with the tanks of the time before. The tanks only grow, so a few passes settle; one that doesn't is dropped.
const MAX_TANK_PASSES = 24
// What a candidate that packs tanks counts for against a slice, next to one that doesn't.
const TANK_WORK = 6
const EPSILON = 1e-9
const NO_TANKS = Object.freeze({ picks: [], sizeHS: 0, litres: 0, cost: 0 })

// The engine sizes the search tries, from 1 HS up to the largest the race may design: every 0.1 HS to 10, every 0.25 HS to 20, then every whole HS.
export const engineSizes = (maxSizeHS) => {
  const sizes = []

  for (let tenths = MIN_ENGINE_SIZE_HS * 10; tenths <= 100; tenths++) {
    sizes.push(tenths / 10)
  }

  for (let quarters = 41; quarters <= 80; quarters++) {
    sizes.push(quarters / 4)
  }

  for (let size = 21; size <= maxSizeHS; size++) {
    sizes.push(size)
  }

  return sizes.filter((size) => size <= maxSizeHS + EPSILON)
}

// The thrust modifiers the search tries: every 0.05 from the least to the most the race has researched.
export const engineThrusts = (minThrust, maxThrust) => {
  const thrusts = []

  for (let step = Math.ceil(minThrust / THRUST_STEP - EPSILON); step <= Math.floor(maxThrust / THRUST_STEP + EPSILON); step++) {
    thrusts.push(Math.round(step * THRUST_STEP * 100) / 100)
  }

  return thrusts
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
// - `kind`: 'military', 'commercial' or 'either'; `minCount` and `maxCount` the engines a set may have; `share` the most of the finished ship the engines and tanks may take.
// - `tech`: `{ engineTech, fuelTech, thermalTech, thermalCost, minThrust, maxThrust, maxSize }`, the levels the race designs with; `tanks`: the stock tanks as `packTanks` takes them.
// - `engine`: one of the race's own engines (as design-data.js `loadRaceEngines` has them) to search only its count, or null to design engines.
// A set has `engine`, `count`, `power`, `engineHS`, `tankHS`, `propulsionHS`, `tons`, `totalHS`, `share`, `speed`, `litres`, `tanks`, `burnFull`, `burnCruise`, `rangeKm`, `enduranceHours`, `cost`, `crew`, `commercial` and `thermal`. Returns { sets (the best `keep`, ranked), lightest, fastest, cheapest, pareto: { speed, range } (the sets that no other beats on share of the ship and on speed, or on range), evaluated, matched }.
export function* searchPropulsion({ hullHS, speed, fraction = 1, goal = null, kind = 'either', minCount = 1, maxCount = 100, share = 1, tech, tanks = [], engine = null, keep = KEPT_SETS, slice = SLICE_CANDIDATES }) {
  const sets = []
  const frontiers = { speed: [], rangeKm: [] }
  const best = { fastest: null, cheapest: null }
  const floorKm = Math.max(0, Math.ceil(speed - EPSILON))
  const floorFraction = floorKm / 1000
  const sizes = engine ? [] : engineSizes(tech.maxSize)
  const thrusts = engine ? [] : engineThrusts(tech.minThrust, tech.maxThrust)
  const total = engine ? 1 : sizes.length * thrusts.length
  const designs = engine ? [engine] : gridDesigns({ sizes, thrusts, tech, kind })
  let evaluated = 0
  let matched = 0
  let work = 0
  let done = 0

  const finish = () => ({ sets, lightest: sets[0] || null, fastest: best.fastest, cheapest: best.cheapest, pareto: { speed: frontiers.speed, range: frontiers.rangeKm }, evaluated, matched })

  if (floorKm > MAX_SPEED || !(hullHS >= 0) || maxCount < Math.max(1, minCount)) {
    return finish()
  }

  for (const design of designs) {
    done++

    if (design === null) {
      work++
    } else {
      // The engines this design needs to reach the speed on the bare hull, and the most that fit the share: the counts in between are tried.
      const room = design.power - floorFraction * design.sizeHS
      let first = Math.max(1, minCount)
      let last = maxCount

      if (floorKm > 0) {
        first = room > 0 ? Math.max(first, Math.floor(floorFraction * hullHS / room)) : last + 1
      }

      if (share < 1) {
        last = Math.min(last, Math.floor(share * hullHS / (design.sizeHS * (1 - share))) + 1)
      }

      for (let count = first; count <= last; count++) {
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
          pack = packTanks({ litres: goal.value * burnCruise, tanks })
          finalSpeed = classSpeed({ enginePower: power, sizeHS: bareHS + pack.sizeHS })

          if (finalSpeed < floorKm || pack.litres < goal.value * burnCruise * (1 - EPSILON)) {
            continue
          }
        } else if (goal && goal.value > 0 && goal.mode === 'range') {
          let litres = bareSpeed > 0 ? goal.value * burnFull / (bareSpeed * 3600) : Infinity
          let settled = false

          for (let pass = 0; pass < MAX_TANK_PASSES && Number.isFinite(litres); pass++) {
            work += TANK_WORK
            pack = packTanks({ litres, tanks })
            finalSpeed = classSpeed({ enginePower: power, sizeHS: bareHS + pack.sizeHS })

            if (!(finalSpeed >= floorKm && finalSpeed > 0)) {
              break
            }

            const needed = goal.value * burnFull / (finalSpeed * 3600)

            if (pack.litres >= needed * (1 - EPSILON)) {
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
            burnFull,
            burnCruise,
            rangeKm,
            enduranceHours: burnCruise > 0 ? pack.litres / burnCruise : 0,
            cost,
            crew: count * design.crew + pack.picks.reduce((crew, pick) => crew + (pick.crew || 0) * pick.count, 0),
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

        if (work >= slice) {
          work = 0

          yield { progress: done / total, evaluated, matched }
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
