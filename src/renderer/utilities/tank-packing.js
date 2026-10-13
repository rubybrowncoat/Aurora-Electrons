// The fuel tank packages of the propulsion planner: the tanks from a catalogue that hold a number of litres in the fewest HS, then the fewest BP (`lightest`), or in the fewest BP, then the fewest HS (`cheapest`), each with the fewest tanks as the last tie-break. The game has no packing rule; the objective is the planner's own, and the package is the exact optimum of it, not a heuristic one. docs/DATABASE.md § Design rules states the rule, docs/plans/backlog/evidence/AE-130-03.md the measurements it rests on.
//
// A package is a count per tank row and meets a request of `litres` when its litres reach it within `REQUEST_TOLERANCE`. The catalogue's litres, HS and BP are made whole numbers by the least power of ten at which every figure divides back to exactly the float it came from, so scaling never rounds a figure and every comparison below is on exact integers; a catalogue with a figure that no such scale holds (more digits than the largest scale keeps) is not solved exactly. The table solver then works in units of the greatest common divisor of the litres: f[c] is the best package whose litres reach c units, f[c] = the best over the rows of f[c - units(row)] plus that row, the objective's keys being additive and compared in order, so the recurrence is exact (an optimal package without one of its tanks is optimal for what is left). Past a table's size a request is answered by repeating the row of the least HS per litre (periodic extension): when the table, once built far enough, repeats with that row's period over a window as wide as the largest row, it repeats for ever (induction on the window, written out at `windowHolds`), and the answer is optimal. The check is run on the actual table, never assumed from the catalogue's shape.
//
// Every result carries a status that says what is proved: 'optimal' (the best package under the objective, or the empty one for no demand), 'infeasible' (no package exists: nothing to pack from, or a request no tanks can hold) and 'bound-exhausted' (a bound ran out first: a package may be given and it meets the request, but it is not proved best, and no package here does not mean none exists). A package that is not proved is never reported as optimal.

export const REQUEST_TOLERANCE = 1e-9
export const MAX_TABLE_UNITS = 1 << 20
export const PACKAGE_STATUS = Object.freeze({ OPTIMAL: 'optimal', BOUND_EXHAUSTED: 'bound-exhausted', INFEASIBLE: 'infeasible' })

// The keys each objective compares, in order, over a package's HS, BP and tank count.
export const OBJECTIVES = Object.freeze({
  lightest: Object.freeze(['hs', 'cost', 'count']),
  cheapest: Object.freeze(['cost', 'hs', 'count']),
})

const SCALES = [1, 10, 100, 1e3, 1e4, 1e5, 1e6]
const LITRE_SCALES = [1, 10, 100, 1e3]
const SAFE_TOTAL = 2 ** 52
const MAX_TANKS = 2 ** 50
const WARM_WORK = 120000
const MAX_FRONTIER_ENTRIES = 200000

// Whether a package of `delivered` litres meets a request of `requested` litres: the one tolerance the packages and the searches that use them share.
export const meetsRequest = (delivered, requested) => delivered >= requested * (1 - REQUEST_TOLERANCE)

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

// Whether `value` is a whole number of 1 / `scale` exactly: scaled and rounded it divides back to the very same float. A figure with more digits than the scale keeps (0.9999999 at a scale of 1,000) rounds to another number and does not pass, so a scaled figure is never a rounded stand-in for the stored one; a stored decimal such as 0.002 does, as the float of its digits is the nearest to the quotient. Positive figures stay positive: a value that rounds to 0 does not divide back to itself.
const isWhole = (value, scale) => {
  const scaled = Math.round(value * scale)

  return Number.isSafeInteger(scaled) && scaled / scale === value
}

const scaleOf = (values, scales) => scales.find((scale) => values.every((value) => isWhole(value, scale))) || null

// The tanks a package can use, largest litres first (the lighter and cheaper of two equal ones first), as whole-number rows. `exact` is false when a figure cannot be made whole or the sums could pass what a float holds exactly; the rows then carry no whole numbers and only a feasible, unproved package is given. `excluded` names the tanks left out for a litres, size or cost figure the save lacks.
const catalogueOf = (tanks) => {
  const excluded = []
  const usable = []

  tanks.forEach((tank) => {
    const missing = !(Number.isFinite(tank.litres) && tank.litres > 0) ? 'litres' : !(Number.isFinite(tank.sizeHS) && tank.sizeHS > 0) ? 'size' : !(Number.isFinite(tank.cost) && tank.cost >= 0) ? 'cost' : null

    if (missing) {
      excluded.push({ id: tank.id, name: tank.name, missing })
    } else {
      usable.push(tank)
    }
  })

  usable.sort((a, b) => b.litres - a.litres || a.sizeHS - b.sizeHS || a.cost - b.cost)

  const hsScale = scaleOf(usable.map((tank) => tank.sizeHS), SCALES)
  const costScale = scaleOf(usable.map((tank) => tank.cost), SCALES)
  const litresScale = scaleOf(usable.map((tank) => tank.litres), LITRE_SCALES)
  const rows = usable.map((tank) => ({ tank }))
  const catalogue = { rows, excluded, exact: false, hsScale, costScale, litresScale, unit: 0, perUnit: 0 }

  if (!rows.length || !hsScale || !costScale || !litresScale) {
    return catalogue
  }

  rows.forEach((row) => {
    row.litres = Math.round(row.tank.litres * litresScale)
    row.hs = Math.round(row.tank.sizeHS * hsScale)
    row.cost = Math.round(row.tank.cost * costScale)
  })

  catalogue.unit = rows.reduce((unit, row) => gcd(unit, row.litres), 0)
  catalogue.perUnit = Math.max(...rows.map((row) => Math.max(row.hs, row.cost) / (row.litres / catalogue.unit)))
  catalogue.exact = (rows[0].litres / catalogue.unit + MAX_TABLE_UNITS) * catalogue.perUnit * 2 < SAFE_TOTAL

  return catalogue
}

// The table solver over whole-number rows ({ units, hs, cost }) for one objective, built as far as the requests need it. `maxUnits` is the most cells it holds. `solve(need)` gives the counts per row of the best package that reaches `need` units and whether that is proved.
const createTable = (entries, keys, maxUnits) => {
  const values = entries.map((entry) => keys.map((key) => (key === 'count' ? 1 : entry[key])))
  const widest = entries.reduce((most, entry) => Math.max(most, entry.units), 0)
  let capacity = 0
  let built = 0
  let first = new Float64Array(0)
  let second = new Float64Array(0)
  let third = new Float64Array(0)
  let pick = new Int32Array(0)
  let proofCap = null

  // The row repeated for a request past the table: the least of the first key per unit, then the second, the larger row on a tie.
  const periodic = entries.reduce((best, entry, index) => {
    if (best < 0) {
      return index
    }

    const a = values[index]
    const b = values[best]
    const order = a[0] * entries[best].units - b[0] * entry.units || a[1] * entries[best].units - b[1] * entry.units

    return order < 0 || (order === 0 && entry.units > entries[best].units) ? index : best
  }, -1)

  const firstCap = Math.max(2 * widest + entries[periodic].units, 1024)

  const grow = (needed) => {
    const next = Math.min(maxUnits + 1, Math.max(needed + 1, capacity * 2, 1024))
    const copy = (Type, old) => {
      const made = new Type(next)

      made.set(old.subarray(0, Math.min(old.length, next)))

      return made
    }

    first = copy(Float64Array, first)
    second = copy(Float64Array, second)
    third = copy(Float64Array, third)
    pick = copy(Int32Array, pick)
    capacity = next
  }

  const ensure = (units) => {
    if (units <= built) {
      return
    }

    if (units + 1 > capacity) {
      grow(units)
    }

    for (let cell = built + 1; cell <= units; cell++) {
      let bestFirst = Infinity
      let bestSecond = Infinity
      let bestThird = Infinity
      let bestPick = -1

      for (let candidate = 0; candidate < entries.length; candidate++) {
        const previous = cell > entries[candidate].units ? cell - entries[candidate].units : 0
        const a = first[previous] + values[candidate][0]
        const b = second[previous] + values[candidate][1]
        const c = third[previous] + values[candidate][2]

        if (a < bestFirst || (a === bestFirst && (b < bestSecond || (b === bestSecond && c < bestThird)))) {
          bestFirst = a
          bestSecond = b
          bestThird = c
          bestPick = candidate
        }
      }

      first[cell] = bestFirst
      second[cell] = bestSecond
      third[cell] = bestThird
      pick[cell] = bestPick
    }

    built = units
  }

  const trace = (units, counts) => {
    let cell = units

    while (cell > 0) {
      const chosen = pick[cell]

      counts[chosen]++
      cell = cell > entries[chosen].units ? cell - entries[chosen].units : 0
    }
  }

  // The periodic extension. Let s be the units of the repeated row, U those of the largest row and `cap` a table size with cap - U + 1 >= s + U. If f[c] = f[c - s] + value(row) for the U cells cap - U + 1 .. cap, it holds for every cell above: the recurrence for such a cell c reads f at c - units(row) for each row, all in cap - U + 1 .. c - 1 (and never the clamp at 0, because c - units(row) stays above U), where the equality already holds, so each read is the value s lower plus value(row), and the best of those is the recurrence for c - s plus value(row), that is f[c - s] + value(row). A request of `need` units past `cap` is then k = ceil((need - cap) / s) copies of the row and the table's answer for need - k * s.
  const windowHolds = (cap) => {
    const step = entries[periodic].units
    const [a, b, c] = values[periodic]

    if (cap - widest + 1 < step + widest) {
      return false
    }

    for (let cell = cap - widest + 1; cell <= cap; cell++) {
      if (first[cell] - first[cell - step] !== a || second[cell] - second[cell - step] !== b || third[cell] - third[cell - step] !== c) {
        return false
      }
    }

    return true
  }

  // Builds the table, `chunk` cells at a time, until a size at which the periodic window holds is found (doubling from the least size the check can run at, up to `maxUnits`), yielding after each chunk. Returns that size, or 0 when none is found. Decided once; abandoned half way it starts again where it stopped.
  function* proving(chunk) {
    if (proofCap !== null) {
      return proofCap
    }

    let proved = 0

    for (let cap = firstCap; cap <= maxUnits && !proved; cap *= 2) {
      for (;;) {
        ensure(Math.min(cap, built + chunk))

        if (built >= cap) {
          break
        }

        yield
      }

      if (windowHolds(cap)) {
        proved = cap
      } else {
        yield
      }
    }

    proofCap = proved

    return proofCap
  }

  // What a search needs built before its first request, `chunk` cells at a time: the proof, and when none is found the whole bounded table, which then answers every request directly, so no request has a table to build in one step.
  function* warming(chunk) {
    if ((yield * proving(chunk)) > 0) {
      return
    }

    if (capacity < maxUnits + 1) {
      grow(maxUnits)
    }

    for (;;) {
      ensure(Math.min(maxUnits, built + chunk))

      if (built >= maxUnits) {
        break
      }

      yield
    }
  }

  const prove = () => {
    if (proofCap !== null) {
      return proofCap
    }

    const run = proving(Infinity)
    let step

    do {
      step = run.next()
    } while (!step.done)

    return step.value
  }

  // The best package for `need` units: { counts, proved, reason }. Past the table without a periodic proof the answer is the repeated row plus the table's answer for the rest, feasible and not proved.
  const solve = (need) => {
    const counts = new Float64Array(entries.length)

    if (need > firstCap && prove() > 0 && need > proofCap) {
      const step = entries[periodic].units
      const repeats = Math.ceil((need - proofCap) / step)

      ensure(need - repeats * step)
      trace(need - repeats * step, counts)
      counts[periodic] += repeats

      return { counts, proved: true, reason: null }
    }

    if (need <= maxUnits) {
      ensure(need)
      trace(need, counts)

      return { counts, proved: true, reason: null }
    }

    const step = entries[periodic].units
    const repeats = Math.ceil((need - maxUnits) / step)
    const rest = Math.max(0, need - repeats * step)

    ensure(rest)
    trace(rest, counts)
    counts[periodic] += repeats

    return { counts, proved: false, reason: 'table-cap' }
  }

  return { solve, proving, warming, prove, bytes: () => first.byteLength + second.byteLength + third.byteLength + pick.byteLength, built: () => built }
}

// A feasible package from raw figures for a catalogue that cannot be made whole: the densest tank (the least HS per litre) as many times as fits, and the one tank that covers the rest in the fewest HS, then BP. Never proved. Null when the count of tanks passes what a float counts exactly.
const coverRoughly = (rows, target) => {
  const counts = new Float64Array(rows.length)
  const densest = rows.reduce((best, row, index) => (row.tank.sizeHS / row.tank.litres < rows[best].tank.sizeHS / rows[best].tank.litres ? index : best), 0)

  if (!(target / rows[densest].tank.litres < MAX_TANKS)) {
    return null
  }

  const whole = Math.floor(target / rows[densest].tank.litres)
  const rest = target - whole * rows[densest].tank.litres
  let closing = densest

  counts[densest] = whole

  if (rest > 0) {
    rows.forEach((row, index) => {
      const lighter = row.tank.sizeHS < rows[closing].tank.sizeHS || (row.tank.sizeHS === rows[closing].tank.sizeHS && row.tank.cost < rows[closing].tank.cost)

      if (row.tank.litres >= rest && lighter) {
        closing = index
      }
    })

    counts[closing] += 1
  }

  while (counts.reduce((litres, each, index) => litres + each * rows[index].tank.litres, 0) < target) {
    counts[densest] += 1
  }

  return counts
}

const packageOf = (catalogue, counts, requested, objective, status, reason) => {
  const { rows, exact, hsScale, costScale } = catalogue
  const picks = []
  let litres = 0
  let hs = 0
  let cost = 0
  let crew = 0
  let count = 0
  let crewKnown = true

  for (let index = 0; index < rows.length; index++) {
    const each = counts[index]

    if (each > 0) {
      const row = rows[index]

      picks.push({ ...row.tank, count: each })
      litres += each * row.tank.litres
      hs += each * (exact ? row.hs : row.tank.sizeHS)
      cost += each * (exact ? row.cost : row.tank.cost)
      count += each

      if (Number.isFinite(row.tank.crew)) {
        crew += each * row.tank.crew
      } else {
        crewKnown = false
      }
    }
  }

  return {
    status,
    reason,
    complete: status !== PACKAGE_STATUS.BOUND_EXHAUSTED,
    feasible: true,
    objective,
    requestedLitres: requested,
    litres,
    excessLitres: Math.max(0, litres - requested),
    count,
    sizeHS: exact ? hs / hsScale : hs,
    cost: exact ? cost / costScale : cost,
    crew: crewKnown ? crew : null,
    picks,
  }
}

// A result with no package: infeasible when none exists, bound-exhausted when none was found.
const noPackage = (status, reason, objective, requested) => ({ status, reason, complete: status !== PACKAGE_STATUS.BOUND_EXHAUSTED, feasible: false, objective, requestedLitres: requested, litres: 0, excessLitres: 0, count: 0, sizeHS: 0, cost: 0, crew: 0, picks: [] })

// The packer of one tank catalogue (`tanks`: { id, name, sizeHS, litres, cost, crew }). `pack(litres, objective)` gives the package for a request; tables are built as requests need them and kept, so one packer serves a whole search. `maxUnits` is the most cells of a table (`MAX_TABLE_UNITS` by default; a request that needs more is answered by the periodic extension when it is proved, and otherwise with a feasible package that is bound-exhausted).
export const createTankPacker = (tanks, { maxUnits = MAX_TABLE_UNITS } = {}) => {
  const catalogue = catalogueOf(tanks)
  const { rows, exact } = catalogue
  const tables = {}

  const tableOf = (objective) => {
    if (!tables[objective]) {
      const entries = rows.map((row) => ({ units: row.litres / catalogue.unit, hs: row.hs, cost: row.cost }))

      tables[objective] = createTable(entries, OBJECTIVES[objective], maxUnits)
    }

    return tables[objective]
  }

  const objectiveKeys = (objective) => {
    if (!OBJECTIVES[objective]) {
      throw new Error(`Unknown tank objective ${objective}; use ${Object.keys(OBJECTIVES).join(' or ')}`)
    }
  }

  // The result that needs no table: no demand, a request that cannot be sized, nothing to pack from. Null when a package has to be worked out.
  const settled = (litres, objective) => {
    if (typeof litres !== 'number' || !(litres >= 0)) {
      return noPackage(PACKAGE_STATUS.INFEASIBLE, 'invalid-request', objective, litres)
    }

    if (litres === 0) {
      return { ...noPackage(PACKAGE_STATUS.OPTIMAL, null, objective, 0), feasible: true }
    }

    if (!rows.length) {
      return noPackage(PACKAGE_STATUS.INFEASIBLE, 'no-usable-tank', objective, litres)
    }

    return litres === Infinity ? noPackage(PACKAGE_STATUS.INFEASIBLE, 'request-not-finite', objective, litres) : null
  }

  // The units of the table a request reaches: the least whole number whose litres meet the request within the tolerance.
  const unitsFor = (litres) => {
    const target = litres * (1 - REQUEST_TOLERANCE) * catalogue.litresScale
    let need = Math.ceil(target / catalogue.unit)

    while (need < SAFE_TOTAL && need * catalogue.unit < target) {
      need++
    }

    return need
  }

  const pack = (litres, objective = 'lightest') => {
    objectiveKeys(objective)

    const early = settled(litres, objective)

    if (early) {
      return early
    }

    if (!exact) {
      const rough = coverRoughly(rows, litres * (1 - REQUEST_TOLERANCE))

      return rough ? packageOf(catalogue, rough, litres, objective, PACKAGE_STATUS.BOUND_EXHAUSTED, 'catalogue-not-whole') : noPackage(PACKAGE_STATUS.BOUND_EXHAUSTED, 'request-too-large', objective, litres)
    }

    const need = unitsFor(litres)

    if ((need + rows[0].litres / catalogue.unit) * catalogue.perUnit * 2 >= SAFE_TOTAL) {
      return noPackage(PACKAGE_STATUS.BOUND_EXHAUSTED, 'request-too-large', objective, litres)
    }

    const answer = tableOf(objective).solve(need)

    return packageOf(catalogue, answer.counts, litres, objective, answer.proved ? PACKAGE_STATUS.OPTIMAL : PACKAGE_STATUS.BOUND_EXHAUSTED, answer.reason)
  }

  // Builds the table of an objective as far as its periodic proof needs (and the whole bounded table when there is no proof), `catalogue.warmCells` cells at a time, yielding between chunks, so a caller that must stay responsive pays for it in small steps before the first request.
  function* warm(objective = 'lightest') {
    objectiveKeys(objective)

    if (exact) {
      yield * tableOf(objective).warming(Math.ceil(WARM_WORK / rows.length))
    }
  }

  // The packages no other package beats on HS, BP and the litres held over the request, all three, each the one with the fewest tanks of its kind, least HS first: the trade-off between a light package and a cheap one. A package that holds as much over the request as its smallest tank drops that tank and is beaten, so the totals worth keeping lie below the request plus the smallest tank of the package; for each tank size m the totals up to the request plus m are worked out from the rows of m litres and more, keeping at each total only the trade-offs between HS and BP, and all are compared at the end. It is bounded: `status` is 'optimal' with the whole set, and 'bound-exhausted' with none when the totals pass `maxUnits` or the trade-offs held pass `maxEntries`.
  const nondominated = (litres, { maxEntries = MAX_FRONTIER_ENTRIES } = {}) => {
    const early = settled(litres, 'lightest')

    if (early) {
      return { status: early.status, reason: early.reason, complete: early.complete, requestedLitres: litres, packages: early.feasible ? [early] : [] }
    }

    const none = (reason) => ({ status: PACKAGE_STATUS.BOUND_EXHAUSTED, reason, complete: false, requestedLitres: litres, packages: [] })

    if (!exact) {
      return none('catalogue-not-whole')
    }

    const need = unitsFor(litres)
    const unitsOf = rows.map((row) => row.litres / catalogue.unit)
    const candidates = []

    for (let smallest = 0; smallest < rows.length; smallest++) {
      if (smallest > 0 && unitsOf[smallest] === unitsOf[smallest - 1]) {
        continue
      }

      const allowed = [...unitsOf.keys()].filter((index) => unitsOf[index] >= unitsOf[smallest])
      const limit = need + unitsOf[smallest] - 1

      if (limit > maxUnits) {
        return none('table-cap')
      }

      const totals = new Array(limit + 1)
      let held = 1

      totals[0] = [{ hs: 0, cost: 0, count: 0, row: -1, previous: null }]

      for (let total = 1; total <= limit; total++) {
        const reached = []

        for (const index of allowed) {
          const from = total - unitsOf[index]

          if (from >= 0) {
            for (const entry of totals[from]) {
              reached.push({ hs: entry.hs + rows[index].hs, cost: entry.cost + rows[index].cost, count: entry.count + 1, row: index, previous: entry })
            }
          }
        }

        reached.sort((a, b) => a.hs - b.hs || a.cost - b.cost || a.count - b.count)

        const kept = []
        let cheapest = Infinity

        for (const entry of reached) {
          if (entry.cost < cheapest) {
            kept.push(entry)
            cheapest = entry.cost
          }
        }

        totals[total] = kept
        held += kept.length

        if (held > maxEntries) {
          return none('frontier-bound')
        }
      }

      for (let total = need; total <= limit; total++) {
        totals[total].forEach((entry) => candidates.push({ total, entry }))
      }
    }

    candidates.sort((a, b) => a.total - b.total || a.entry.hs - b.entry.hs || a.entry.cost - b.entry.cost || a.entry.count - b.entry.count)

    const beaten = []
    const packages = []

    for (const { entry } of candidates) {
      if (!beaten.some((other) => other.hs <= entry.hs && other.cost <= entry.cost)) {
        const counts = new Float64Array(rows.length)

        beaten.push(entry)

        for (let walk = entry; walk.previous; walk = walk.previous) {
          counts[walk.row]++
        }

        packages.push(packageOf(catalogue, counts, litres, 'nondominated', PACKAGE_STATUS.OPTIMAL, null))
      }
    }

    packages.sort((a, b) => a.sizeHS - b.sizeHS || a.cost - b.cost || a.excessLitres - b.excessLitres)

    return { status: PACKAGE_STATUS.OPTIMAL, reason: null, complete: true, requestedLitres: litres, packages }
  }

  return {
    pack,
    warm,
    nondominated,
    catalogue: Object.freeze({ rows: rows.length, excluded: Object.freeze(catalogue.excluded), exact, unitLitres: exact ? catalogue.unit / catalogue.litresScale : null, maxUnits, warmCells: rows.length ? Math.ceil(WARM_WORK / rows.length) : 0 }),
    built: (objective = 'lightest') => (tables[objective] ? tables[objective].built() : 0),
    bytes: () => Object.values(tables).reduce((total, table) => total + table.bytes(), 0),
  }
}

const packers = new WeakMap()

// The packer of a tank list, kept while the list lives so the tables built for one search serve the next. A list whose tanks are not the same objects as when it was kept (it was changed in place) gets a new packer.
export const packerFor = (tanks) => {
  const held = packers.get(tanks)

  if (held && held.tanks.length === tanks.length && held.tanks.every((tank, index) => tank === tanks[index])) {
    return held.packer
  }

  const packer = createTankPacker(tanks)

  packers.set(tanks, { tanks: [...tanks], packer })

  return packer
}
