/*
  Benchmark and oracle for the fuel tank package algorithms (AE-130-03; evidence in docs/plans/backlog/evidence/AE-130-03.md).

  Run from the repo root with Node 22.12 or newer: `node scripts/bench-tank-packing.js [--quick] [--skip-search] [--budget-ms N] [--stock FILE GAME RACE] [--modded FILE GAME RACE]`. It only reads the saves (sqlite3 OPEN_READONLY) and writes nothing. A save that is not there is skipped; the synthetic catalogues always run. Exit code 2 when a self-check fails (the oracle, an exact solver or the stock shortcut disagrees with the enumeration); a heuristic that loses to the oracle is a finding, not a failure.

  The request is a number of litres `R`; a package is a count per tank row; it is feasible when its litres are at least `R`. All sizes are compared as integers: HS and BP are scaled to whole numbers (`quantize`), litres are whole in every save read, so no float tolerance enters an optimality claim.

  Objectives, as lexicographic keys over (HS, BP, tank count), smallest first:
  - `lightest`: HS, then BP, then count. This is the order packTanks and the propulsion ranking use. A fourth key, the litres in excess of `R`, would make the choice deterministic; `tied` counts how often the three keys leave several packages.
  - `cheapest`: BP, then HS, then count.

  Statuses every algorithm returns: `optimal` (proved best under its objective over the whole domain), `heuristic` (a feasible package with no proof), `bound-exhausted` (a bound ran out first: the incumbent, if any, is feasible and unproven, and no package found is not infeasible), `infeasible` (the whole domain was searched or the catalogue is empty: no package exists), `inapplicable` (a fast path whose proof conditions the catalogue does not meet; it never returns a package).

  The search part drives the real `searchPropulsion` source with two changes: its design-rules and tank-packing imports are replaced (the harness refuses to run if the tank-packing import is not found), the packer being the one under test; a run with the production packer must reproduce the unmodified search exactly. The removed greedy `packTanks` (embedded as `legacyPackTanks`) is the baseline named `current`; the production solver (tank-packing.js) is `production`. After it, `runSparseResponsiveness` times the unmodified `searchPropulsion` and the production warm generator over a sparse catalogue, a fixed number of cold runs reporting every maximum and the percentiles. No wall-clock time is asserted anywhere in this file (scripts/check-tank-packing.js asserts the bounded work per step instead).
*/
const fs = require('fs')
const path = require('path')
const v8 = require('v8')
const vm = require('vm')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const SLICE_MS = 12
const ORACLE_LIMIT = 2e6
const MAX_UNITS = 1 << 20
const EXACT = 1e-9

const OPTIMAL = 'optimal'
const HEURISTIC = 'heuristic'
const EXHAUSTED = 'bound-exhausted'
const INFEASIBLE = 'infeasible'
const INAPPLICABLE = 'inapplicable'

const LIGHTEST = ['hs', 'cost', 'count']
const CHEAPEST = ['cost', 'hs', 'count']

// The packTanks the planner had before AE-130-01, kept only as the baseline the research compares against: from the largest tank down, each size takes as many as fit and hands the rest to the smaller sizes, or takes one more and holds the lot; the lighter of the two wins. It is wrong when a smaller tank is denser in a way the sizes in between hide (two 6 L/3 HS tanks beat one 10 L/10 HS tank for 10 L).
const legacyPackTanks = ({ litres, tanks }) => {
  const totals = (picks) => ({ picks, sizeHS: picks.reduce((sum, pick) => sum + pick.sizeHS * pick.count, 0), litres: picks.reduce((sum, pick) => sum + pick.litres * pick.count, 0), cost: picks.reduce((sum, pick) => sum + pick.cost * pick.count, 0) })
  const largestFirst = tanks.filter((tank) => tank.litres > 0 && tank.sizeHS > 0).sort((a, b) => b.litres - a.litres)

  const pack = (index, remaining) => {
    if (remaining <= 1e-9 || index >= largestFirst.length) {
      return totals([])
    }

    const tank = largestFirst[index]
    const whole = Math.floor(remaining / tank.litres + 1e-9)
    const left = remaining - whole * tank.litres

    if (left <= 1e-9) {
      return totals([{ ...tank, count: whole }])
    }

    const covered = totals([{ ...tank, count: whole + 1 }])

    if (index === largestFirst.length - 1) {
      return covered
    }

    const rest = pack(index + 1, left)
    const split = totals(whole > 0 ? [{ ...tank, count: whole }, ...rest.picks] : rest.picks)
    const lighter = split.sizeHS < covered.sizeHS - 1e-9 || (Math.abs(split.sizeHS - covered.sizeHS) <= 1e-9 && split.cost <= covered.cost)

    return lighter ? split : covered
  }

  return pack(0, litres)
}

// The solver under test: the utilities of tank-packing.js with design-rules.js's packTanks, loaded by `main`.
let production = null

let failures = 0
let checks = 0

const options = (() => {
  const parsed = { quick: false, skipSearch: false, budgetMs: 20000, stock: { file: '../AuroraDB_271_skoormit_saved.db', game: 138, race: 785 }, modded: { file: 'AuroraDB.db', game: 140, race: 784 } }
  const argv = process.argv.slice(2)

  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]

    if (name === '--quick') {
      parsed.quick = true
    } else if (name === '--skip-search') {
      parsed.skipSearch = true
    } else if (name === '--budget-ms') {
      parsed.budgetMs = Number(argv[++index])
    } else if (name === '--stock' || name === '--modded') {
      parsed[name.slice(2)] = { file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) }
    } else {
      console.error(`Unknown option ${name}`)
      process.exit(2)
    }
  }

  return parsed
})()

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const heading = (text) => console.log(`\n== ${text} ==`)

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0

  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const percentile = (sorted, share) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] : NaN)

// ---------- catalogues ----------

const SCALES = [1, 10, 100, 1000, 10000, 100000]

const integral = (value, scale) => Math.abs(value * scale - Math.round(value * scale)) < 1e-6

// The usable rows of a tank list ({ id, name, sizeHS, litres, cost }) as whole numbers: litres as stored, HS and BP times the least power of ten that makes every row whole. A row with no positive litres or size, or no finite cost, is left out as packTanks leaves it out. Null rows when a figure cannot be made whole.
const quantize = (tanks) => {
  const usable = tanks.filter((tank) => Number.isFinite(tank.litres) && tank.litres > 0 && Number.isFinite(tank.sizeHS) && tank.sizeHS > 0 && Number.isFinite(tank.cost) && tank.cost >= 0)
  const hsScale = SCALES.find((scale) => usable.every((tank) => integral(tank.sizeHS, scale)))
  const costScale = SCALES.find((scale) => usable.every((tank) => integral(tank.cost, scale)))

  if (!usable.every((tank) => integral(tank.litres, 1)) || !hsScale || !costScale) {
    return { rows: null, hsScale, costScale, tanks: usable }
  }

  const rows = usable.map((tank, index) => ({ index, id: tank.id, name: tank.name, litres: Math.round(tank.litres), hs: Math.round(tank.sizeHS * hsScale), cost: Math.round(tank.cost * costScale) }))

  return { rows, hsScale, costScale, tanks: usable }
}

// A synthetic catalogue from [litres, HS, BP] triples, already whole.
const synthetic = (triples) => {
  const tanks = triples.map(([litres, sizeHS, cost], index) => ({ id: index + 1, name: `${litres}L/${sizeHS}HS/${cost}BP`, litres, sizeHS, cost }))

  return { ...quantize(tanks) }
}

const evaluate = (rows, counts, request = 0) => {
  let litres = 0
  let hs = 0
  let cost = 0
  let count = 0

  for (let index = 0; index < rows.length; index++) {
    litres += counts[index] * rows[index].litres
    hs += counts[index] * rows[index].hs
    cost += counts[index] * rows[index].cost
    count += counts[index]
  }

  return { litres, hs, cost, count, excess: litres - request }
}

const better = (a, b, keys) => {
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return a[key] < b[key]
    }
  }

  return false
}

const sameKeys = (a, b, keys) => keys.every((key) => a[key] === b[key])

// ---------- oracle ----------

// Calls `visit(counts, totals)` for every package whose litres reach `request`, over every count vector with at most ceil(request / litres) of each row. That bound loses no optimum: a package with more of one row than that already holds the request in that row alone, and dropping one tank keeps it feasible and strictly lowers HS (every size is positive), so no objective that ranks HS, BP and count can prefer it. Returns { domain, complete } and visits nothing when the domain is larger than `limit`.
const enumeratePackages = (rows, request, visit, limit = ORACLE_LIMIT) => {
  const caps = rows.map((row) => Math.ceil(request / row.litres))
  const domain = caps.reduce((product, cap) => product * (cap + 1), 1)

  if (domain > limit) {
    return { domain, complete: false }
  }

  const counts = new Array(rows.length).fill(0)
  const totals = { litres: 0, hs: 0, cost: 0, count: 0 }

  const walk = (index, litres, hs, cost, count) => {
    if (index === rows.length) {
      if (litres >= request) {
        totals.litres = litres
        totals.hs = hs
        totals.cost = cost
        totals.count = count
        totals.excess = litres - request
        visit(counts, totals)
      }

      return
    }

    const row = rows[index]

    for (let each = 0; each <= caps[index]; each++) {
      counts[index] = each
      walk(index + 1, litres + each * row.litres, hs + each * row.hs, cost + each * row.cost, count + each)
    }

    counts[index] = 0
  }

  walk(0, 0, 0, 0, 0)

  return { domain, complete: true }
}

// The exhaustive optimum under `objective`: { status, best: { counts, litres, hs, cost, count, excess }, tied, tiedExcess, domain }. `tied` is the number of count vectors equal to the best on the three objective keys, `tiedExcess` on those and the litres in excess. Status `domain-too-large` when the enumeration would pass `limit`; `infeasible` for no rows.
const oracle = (rows, request, { objective = LIGHTEST, limit = ORACLE_LIMIT } = {}) => {
  if (!(request > 0)) {
    return { status: OPTIMAL, best: { counts: rows.map(() => 0), litres: 0, hs: 0, cost: 0, count: 0, excess: 0 }, tied: 1, tiedExcess: 1, domain: 1 }
  }

  if (!rows.length || !Number.isFinite(request)) {
    return { status: INFEASIBLE, best: null, tied: 0, tiedExcess: 0, domain: 0 }
  }

  const keys = [...objective, 'excess']
  let best = null
  let tied = 0
  let tiedExcess = 0

  const { domain, complete } = enumeratePackages(rows, request, (counts, totals) => {
    if (!best || better(totals, best, keys.slice(0, 3)) || (sameKeys(totals, best, objective) && totals.excess < best.excess)) {
      best = { counts: counts.slice(), litres: totals.litres, hs: totals.hs, cost: totals.cost, count: totals.count, excess: totals.excess }
      tied = 1
      tiedExcess = 1
    } else if (sameKeys(totals, best, objective)) {
      tied++

      if (totals.excess === best.excess) {
        tiedExcess++
      }
    }
  }, limit)

  if (!complete) {
    return { status: 'domain-too-large', best: null, tied: 0, tiedExcess: 0, domain }
  }

  return { status: OPTIMAL, best, tied, tiedExcess, domain }
}

// The packages no other package beats on HS, BP and excess litres at once (each key smaller or equal, one smaller), one per distinct triple.
const nondominated = (rows, request, limit = ORACLE_LIMIT) => {
  const seen = new Map()
  const { complete } = enumeratePackages(rows, request, (counts, totals) => {
    const key = `${totals.hs}/${totals.cost}/${totals.excess}`

    if (!seen.has(key)) {
      seen.set(key, { hs: totals.hs, cost: totals.cost, excess: totals.excess, counts: counts.slice() })
    }
  }, limit)

  if (!complete) {
    return null
  }

  const all = [...seen.values()]

  return all.filter((a) => !all.some((b) => b !== a && b.hs <= a.hs && b.cost <= a.cost && b.excess <= a.excess))
}

// ---------- algorithms ----------

const degenerate = (rows, request) => {
  if (!(request > 0)) {
    return { status: OPTIMAL, counts: rows.map(() => 0), nodes: 0 }
  }

  if (!rows.length || !Number.isFinite(request)) {
    return { status: INFEASIBLE, counts: null, nodes: 0, reason: rows.length ? 'request-not-finite' : 'no-usable-tank' }
  }

  return null
}

// Largest litres first, or densest (least HS per litre, then least BP per litre) first.
const byLitres = (rows) => rows.map((_row, index) => index).sort((a, b) => rows[b].litres - rows[a].litres || a - b)

const byDensity = (rows) => rows.map((_row, index) => index).sort((a, b) => rows[a].hs * rows[b].litres - rows[b].hs * rows[a].litres || rows[a].cost * rows[b].litres - rows[b].cost * rows[a].litres || rows[b].litres - rows[a].litres || a - b)

// One row, as many times as covers `remaining`, that the objective ranks first.
const homogeneousCover = (rows, remaining, objective) => {
  let pick = -1
  let pickTotals = null

  rows.forEach((row, index) => {
    const count = Math.ceil(remaining / row.litres)
    const totals = { hs: row.hs * count, cost: row.cost * count, count }

    if (!pickTotals || better(totals, pickTotals, objective)) {
      pick = index
      pickTotals = totals
    }
  })

  return { pick, count: pickTotals.count }
}

// Floors in the given order, then the best single row to cover what is left. Never claims optimality.
const greedy = (rows, request, order, objective = LIGHTEST) => {
  const early = degenerate(rows, request)

  if (early) {
    return early
  }

  const counts = new Array(rows.length).fill(0)
  let remaining = request

  for (const index of order(rows)) {
    counts[index] = Math.floor(remaining / rows[index].litres)
    remaining -= counts[index] * rows[index].litres
  }

  if (remaining > 0) {
    const { pick, count } = homogeneousCover(rows, remaining, objective)

    counts[pick] += count
  }

  return { status: HEURISTIC, counts, nodes: rows.length }
}

const greedyLargest = (rows, request, objective) => greedy(rows, request, byLitres, objective)
const greedyDensity = (rows, request, objective) => greedy(rows, request, byDensity, objective)

// A packTanks called on float tanks; `tanks` are the quantized catalogue's usable tanks, in the order of its rows. The removed greedy has no status and counts as heuristic; the production packer's own status is kept.
const currentSolver = (packTanks, quantized) => (request) => {
  const { rows, tanks } = quantized
  const early = degenerate(rows, request)

  if (early) {
    return early
  }

  const packed = packTanks({ litres: request, tanks })
  const counts = new Array(rows.length).fill(0)

  for (const pick of packed.picks) {
    counts[tanks.findIndex((tank) => tank.id === pick.id)] += pick.count
  }

  return { status: packed.status === 'optimal' ? OPTIMAL : packed.status ? EXHAUSTED : HEURISTIC, counts, nodes: 0 }
}

// Dynamic programming over capacity in units of `quantum` litres. State: f[c] = the best package (objective vector, additive) whose litres reach c units, for c = 0..need; f[c] = best over rows of f[max(0, c - units(row))] + row. The objective keys are additive and compared lexicographically, so the recursion is exact (the optimal package minus one tank is optimal for what remains). `quantum` defaults to the gcd of the litres, where every row is a whole number of units and the table is exact. A coarser quantum floors each row's units (and rounds the request up) so a package still reaches the request, but optimality is lost: heuristic. The table is one per catalogue and objective and grows as requests need it, so a search shares it across candidates.
// Requests beyond the table are answered by periodic extension, proved once per table. Let b be the row of the least first key per unit (then second key), U the units of the largest row, and `cap` a table size with cap - U + 1 >= units(b) + U. If f[c] = f[c - units(b)] + value(b) for every c in cap - U + 1 .. cap, it holds for every c above, by induction: the recurrence for c reads f at c - units(row) for every row, all in cap - U + 1 .. c - 1 where the equality already holds, so each is its value at units(b) lower plus value(b), and the minimum of those is the recurrence for c - units(b) plus value(b). A request above the proved cap is then k copies of b plus the table's answer for the remainder, optimal. Where no cap up to `maxUnits` proves it the request is bound-exhausted: the same construction, but unproven.
const createDp = (rows, { objective = LIGHTEST, quantum = null, maxUnits = MAX_UNITS, periodic = true } = {}) => {
  const base = rows.reduce((acc, row) => gcd(acc, row.litres), 0)
  const q = quantum || base
  const exact = rows.every((row) => row.litres % q === 0)
  const usable = rows.map((row, index) => ({ row, index, units: Math.floor(row.litres / q) })).filter((entry) => entry.units > 0)
  const value = (entry) => objective.map((key) => (key === 'count' ? 1 : entry.row[key]))
  const values = usable.map(value)
  let capacity = 0
  let built = 0
  let first = new Float64Array(0)
  let second = new Float64Array(0)
  let third = new Float64Array(0)
  let pick = new Int16Array(0)

  // The row repeated for an oversize request: the least of the first key per unit, then the second.
  const densest = usable.reduce((best, entry, index) => {
    if (best < 0) {
      return index
    }

    const a = values[index]
    const b = values[best]
    const c = a[0] * usable[best].units - b[0] * entry.units || a[1] * usable[best].units - b[1] * entry.units

    return c < 0 || (c === 0 && entry.units > usable[best].units) ? index : best
  }, -1)

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
    pick = copy(Int16Array, pick)
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

      for (let candidate = 0; candidate < usable.length; candidate++) {
        const previous = cell > usable[candidate].units ? cell - usable[candidate].units : 0
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
      const chosen = usable[pick[cell]]

      counts[chosen.index]++
      cell = cell > chosen.units ? cell - chosen.units : 0
    }
  }

  const widest = usable.reduce((most, entry) => Math.max(most, entry.units), 0)
  const firstCap = Math.max(2 * widest + (densest >= 0 ? usable[densest].units : 0), 1024)
  let proofCap = null

  // The least doubling of `firstCap` (up to maxUnits) at which the window check above passes, 0 when none does; checked once. Builds the table to that cap.
  const prove = () => {
    if (proofCap !== null) {
      return proofCap
    }

    proofCap = 0

    if (!periodic || !exact || densest < 0) {
      return proofCap
    }

    const step = usable[densest].units
    const [a, b, c] = values[densest]

    for (let cap = firstCap; cap <= maxUnits; cap *= 2) {
      ensure(cap)

      let holds = cap - widest + 1 >= step + widest

      for (let cell = cap - widest + 1; holds && cell <= cap; cell++) {
        holds = first[cell] - first[cell - step] === a && second[cell] - second[cell - step] === b && third[cell] - third[cell - step] === c
      }

      if (holds) {
        proofCap = cap

        break
      }
    }

    return proofCap
  }

  const solve = (request) => {
    const early = degenerate(rows, request)

    if (early) {
      return early
    }

    if (!usable.length) {
      return { status: EXHAUSTED, counts: null, nodes: 0, reason: 'quantum-too-coarse' }
    }

    const need = Math.ceil(request / q)
    const counts = new Array(rows.length).fill(0)

    if (periodic && need > firstCap && prove() > 0 && need > proofCap) {
      const step = usable[densest].units
      const repeats = Math.ceil((need - proofCap) / step)

      ensure(need - repeats * step)
      trace(need - repeats * step, counts)
      counts[usable[densest].index] += repeats

      return { status: OPTIMAL, counts, nodes: 0, reason: 'periodic-extension' }
    }

    if (need <= maxUnits) {
      ensure(need)
      trace(need, counts)

      return { status: exact ? OPTIMAL : HEURISTIC, counts, nodes: need * usable.length }
    }

    const repeats = Math.ceil((need - maxUnits) / usable[densest].units)
    const rest = Math.max(0, need - repeats * usable[densest].units)

    ensure(rest)
    trace(rest, counts)
    counts[usable[densest].index] += repeats

    return { status: EXHAUSTED, counts, nodes: rest * usable.length, reason: 'table-cap' }
  }

  return { solve, prove, quantum: q, exact, units: () => built, bytes: () => first.byteLength + second.byteLength + third.byteLength + pick.byteLength, rowsDropped: rows.length - usable.length }
}

// Depth-first branch and bound, densest row first, counts from most to none, with `nodeBound` visited nodes (every call of the recursion) and optionally `maxTanks` tanks in all. Lower bound of a completion: the remaining litres at the best HS per litre, BP per litre and the fewest tanks of the largest remaining row, rounded up (the true totals are whole), compared lexicographically with the incumbent: a node whose bound cannot beat it is cut. Seeded with the density greedy package when that fits `maxTanks`. Optimal when the search ends inside the bound with an incumbent; infeasible when it ends inside the bound with none (only possible under `maxTanks`); bound-exhausted otherwise, with the incumbent, if any.
const solveBnb = (rows, request, { objective = LIGHTEST, nodeBound = 1e5, maxTanks = Infinity } = {}) => {
  const early = degenerate(rows, request)

  if (early) {
    return early
  }

  const order = byDensity(rows)
  const ordered = order.map((index) => rows[index])
  const size = ordered.length
  const hsPer = new Array(size + 1).fill(Infinity)
  const costPer = new Array(size + 1).fill(Infinity)
  const maxLitres = new Array(size + 1).fill(0)

  for (let index = size - 1; index >= 0; index--) {
    hsPer[index] = Math.min(hsPer[index + 1], ordered[index].hs / ordered[index].litres)
    costPer[index] = Math.min(costPer[index + 1], ordered[index].cost / ordered[index].litres)
    maxLitres[index] = Math.max(maxLitres[index + 1], ordered[index].litres)
  }

  const counts = new Array(size).fill(0)
  let incumbent = null
  let incumbentCounts = null
  let nodes = 0
  let exhausted = false

  const seed = greedyDensity(rows, request, objective)

  if (seed.counts) {
    const totals = evaluate(rows, seed.counts, request)

    if (totals.count <= maxTanks) {
      incumbent = totals
      incumbentCounts = seed.counts.slice()
    }
  }

  const bound = (index, remaining, hs, cost, count) => {
    const vector = { hs: hs + Math.ceil(remaining * hsPer[index] - EXACT), cost: cost + Math.ceil(remaining * costPer[index] - EXACT), count: count + Math.ceil(remaining / maxLitres[index]) }

    return vector
  }

  const walk = (index, remaining, hs, cost, count) => {
    if (exhausted) {
      return
    }

    if (++nodes > nodeBound) {
      exhausted = true

      return
    }

    if (remaining <= 0) {
      if (count > maxTanks) {
        return
      }

      const totals = { hs, cost, count, litres: 0 }

      if (!incumbent || better(totals, incumbent, objective)) {
        incumbent = totals
        incumbentCounts = new Array(rows.length).fill(0)
        order.forEach((original, position) => {
          incumbentCounts[original] = counts[position]
        })
      }

      return
    }

    if (index === size) {
      return
    }

    const lower = bound(index, remaining, hs, cost, count)

    if (lower.count > maxTanks || (incumbent && !better(lower, incumbent, objective))) {
      return
    }

    const row = ordered[index]
    const top = Math.ceil(remaining / row.litres)

    for (let each = top; each >= (index === size - 1 ? top : 0); each--) {
      counts[index] = each
      walk(index + 1, remaining - each * row.litres, hs + each * row.hs, cost + each * row.cost, count + each)

      if (exhausted) {
        break
      }
    }

    counts[index] = 0
  }

  walk(0, request, 0, 0, 0)

  if (exhausted) {
    return { status: EXHAUSTED, counts: incumbentCounts, nodes, reason: 'node-bound' }
  }

  return incumbent ? { status: OPTIMAL, counts: incumbentCounts, nodes } : { status: INFEASIBLE, counts: null, nodes, reason: 'max-tanks' }
}

// ---------- the stock shortcut ----------

// Whether the catalogue meets the proof conditions of the mixed-radix shortcut for the `lightest` objective (HS, BP, count). With rows of equal litres reduced to the cheapest and sorted by litres, L(1) < L(2) < ... < L(k):
//  1. uniform density: HS(i) * L(j) = HS(j) * L(i) for every pair, so a package's HS is its litres over one constant and the lightest package is the one with the fewest litres that reach the request;
//  2. chain: L(i) divides L(i+1), so the smallest row's litres u divide every row and every multiple of u is a reachable total, whence the fewest litres reaching R is u * ceil(R / u);
//  3. economy: BP(i+1) * L(i) <= BP(i) * L(i+1), so merging r = L(i+1) / L(i) tanks of row i into one of row i+1 keeps litres (and so HS), does not raise BP and lowers the count by r - 1.
// Proof: by 1 and 2 the lightest packages are those of exactly C = ceil(R / u) units; by 3 any of them with r or more tanks of row i (i < k) is beaten by the merged package, so the best has fewer than r of each smaller row, which is the unique mixed-radix representation of C with row k unbounded. A catalogue of the conditions failing returns the reasons, and the shortcut returns `inapplicable`. Valid for `lightest` only; `cheapest` and the nondominated set need the table.
const classify = (rows) => {
  if (!rows.length) {
    return { applicable: false, reasons: ['no-usable-tank'], chain: [] }
  }

  const sorted = [...rows].sort((a, b) => a.litres - b.litres || a.cost - b.cost || a.index - b.index)
  const smallest = sorted[0]
  const reasons = []

  if (!sorted.every((row) => row.hs * smallest.litres === smallest.hs * row.litres)) {
    reasons.push('density-varies')
  }

  const chain = sorted.filter((row, index) => index === 0 || row.litres !== sorted[index - 1].litres)

  if (!chain.every((row, index) => index === 0 || row.litres % chain[index - 1].litres === 0)) {
    reasons.push('litres-not-a-chain')
  }

  if (!chain.every((row, index) => index === 0 || row.cost * chain[index - 1].litres <= chain[index - 1].cost * row.litres)) {
    reasons.push('cost-per-litre-rises-with-size')
  }

  return { applicable: reasons.length === 0, reasons, chain }
}

const stockShortcut = (rows) => {
  const verdict = classify(rows)

  return (request) => {
    const early = degenerate(rows, request)

    if (early) {
      return early
    }

    if (!verdict.applicable) {
      return { status: INAPPLICABLE, counts: null, nodes: 0, reason: verdict.reasons.join('+') }
    }

    const { chain } = verdict
    const unit = chain[0].litres
    const counts = new Array(rows.length).fill(0)
    let units = Math.ceil(request / unit)

    for (let index = chain.length - 1; index >= 0; index--) {
      const size = chain[index].litres / unit
      const each = Math.floor(units / size)

      counts[chain[index].index] = each
      units -= each * size
    }

    return { status: OPTIMAL, counts, nodes: chain.length }
  }
}

// ---------- verification of a result ----------

// The result's package against the request: every count a whole number of an existing row and the litres at least the request. Returns its totals, or null for no package, or false for an invalid one.
const totalsOf = (rows, request, result) => {
  if (!result.counts) {
    return null
  }

  const valid = result.counts.length === rows.length && result.counts.every((count) => Number.isInteger(count) && count >= 0)
  const totals = valid ? evaluate(rows, result.counts, request) : null

  return totals && totals.litres >= request ? totals : false
}

// ---------- saves and catalogues ----------

// A read-only stand-in for the app's database object: `query(sql, { replacements })` resolves to [rows], as Sequelize's raw query does.
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
      file: path.basename(resolved),
      query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
        const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
        const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

        raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
      }),
      close: () => raw.close(),
    })
  })
})

const pickLevel = (tech, type) => (tech.lines[type] ? tech.lines[type].pick : null)

// What the propulsion page designs with: the game's pick on every line (the page's own default).
const designTechOf = (tech, raceTech) => {
  const engine = pickLevel(tech, raceTech.ENGINE_TECH_TYPE)
  const fuel = pickLevel(tech, raceTech.FUEL_TECH_TYPE)
  const level = (type, key, fallback) => (pickLevel(tech, type) ? pickLevel(tech, type)[key] : fallback)

  return {
    engineTech: engine.info,
    fuelTech: fuel.info,
    thermalTech: level(raceTech.THERMAL_TECH_TYPE, 'info', 1),
    thermalCost: level(raceTech.THERMAL_TECH_TYPE, 'info2', 1),
    minThrust: level(raceTech.MIN_THRUST_TECH_TYPE, 'info', 0.5),
    maxThrust: level(raceTech.MAX_THRUST_TECH_TYPE, 'info', 1),
    maxSize: level(raceTech.MAX_ENGINE_SIZE_TECH_TYPE, 'info', 25),
  }
}

// The two real catalogues: every tank the race has researched (`scope: 'any'`, as loadFuelTanks reads it) and the tech it designs with.
const loadRealCatalogues = async (utilities) => {
  const found = []

  for (const [name, save] of [['stock', options.stock], ['modded', options.modded]]) {
    const database = await openSave(save.file)

    if (!database) {
      console.log(`SKIP  ${name}: ${save.file} is not there`)
      continue
    }

    const context = { GameID: save.game, RaceID: save.race }
    const tanks = await utilities['design-data'].loadFuelTanks(database, context, { scope: 'any' })
    const raceTech = await utilities['race-tech'].loadRaceTech(database, context)
    const quantized = quantize(tanks.map((tank) => ({ id: tank.id, name: tank.name, sizeHS: tank.sizeHS, litres: tank.litres, cost: tank.cost, crew: tank.crew })))

    const pageTanks = await utilities['design-data'].loadStockTanks(database, context)

    found.push({ name, file: database.file, game: save.game, race: save.race, quantized, pageTanks: pageTanks.length, tech: designTechOf(raceTech, utilities['race-tech']) })
    database.close()
  }

  return found
}

const describeCatalogue = (catalogue) => {
  const { name, quantized } = catalogue
  const { rows, hsScale, costScale } = quantized

  if (!rows) {
    console.log(`${name}: figures cannot be made whole (HS scale ${hsScale}, BP scale ${costScale})`)

    return
  }

  const verdict = classify(rows)
  const densities = [...new Set(rows.map((row) => row.litres / (row.hs / hsScale)))]
  const base = rows.reduce((acc, row) => gcd(acc, row.litres), 0)

  console.log(`${name}: ${rows.length} rows (loadStockTanks, which the propulsion page packs from today, returns ${catalogue.pageTanks}), litres gcd ${base}, HS x${hsScale}, BP x${costScale} as whole numbers, densities (L per HS) ${densities.join(', ')}, shortcut ${verdict.applicable ? 'applicable' : `inapplicable (${verdict.reasons.join(', ')})`}`)
  console.log('  id       HS        litres     BP       L/HS     BP per 1000 L')

  for (const row of [...rows].sort((a, b) => b.litres - a.litres || b.hs - a.hs)) {
    console.log(`  ${String(row.id).padEnd(8)} ${String(row.hs / hsScale).padEnd(9)} ${String(row.litres).padEnd(10)} ${String(row.cost / costScale).padEnd(8)} ${String(Math.round(row.litres / (row.hs / hsScale))).padEnd(8)} ${(row.cost / costScale / row.litres * 1000).toPrecision(4)}`)
  }
}

// ---------- comparison against the oracle ----------

const newTally = () => ({ n: 0, match: 0, worse: 0, invalid: 0, noPackage: 0, inapplicable: 0, wrongOptimal: 0, falseInfeasible: 0, worstHs: 0, worstCost: 0, statuses: {} })

// Scores one result against the reference best vector `best`.
const score = (tally, rows, request, result, best, objective) => {
  tally.n++
  tally.statuses[result.status] = (tally.statuses[result.status] || 0) + 1

  if (result.status === INAPPLICABLE) {
    tally.inapplicable++

    return
  }

  const totals = totalsOf(rows, request, result)

  if (totals === false) {
    tally.invalid++

    return
  }

  if (totals === null) {
    tally.noPackage++

    if (result.status === INFEASIBLE && best) {
      tally.falseInfeasible++
    }

    return
  }

  if (sameKeys(totals, best, objective)) {
    tally.match++
  } else {
    tally.worse++
    tally.worstHs = Math.max(tally.worstHs, best.hs ? (totals.hs / best.hs - 1) * 100 : 0)
    tally.worstCost = Math.max(tally.worstCost, best.cost ? (totals.cost / best.cost - 1) * 100 : 0)

    if (result.status === OPTIMAL) {
      tally.wrongOptimal++
    }
  }
}

const solversFor = (quantized, objective, packTanks, { nodeBound = 5e6 } = {}) => {
  const { rows } = quantized
  const dp = createDp(rows, { objective })
  const solvers = {
    'greedy-largest': (request) => greedyLargest(rows, request, objective),
    'greedy-density': (request) => greedyDensity(rows, request, objective),
    dp: dp.solve,
    bnb: (request) => solveBnb(rows, request, { objective, nodeBound }),
  }

  if (objective === LIGHTEST) {
    solvers.current = currentSolver(packTanks, quantized)
    solvers.production = currentSolver(production.packTanks, quantized)
    solvers.shortcut = stockShortcut(rows)
  }

  return { solvers, dp }
}

const printTallies = (tallies) => {
  console.log('  solver           n      match  worse  invalid  nopkg  inappl  wrongOpt  falseInf  worstHS%   worstBP%  statuses')

  for (const [name, tally] of Object.entries(tallies)) {
    console.log(`  ${name.padEnd(16)} ${String(tally.n).padEnd(6)} ${String(tally.match).padEnd(6)} ${String(tally.worse).padEnd(6)} ${String(tally.invalid).padEnd(8)} ${String(tally.noPackage).padEnd(6)} ${String(tally.inapplicable).padEnd(7)} ${String(tally.wrongOptimal).padEnd(9)} ${String(tally.falseInfeasible).padEnd(9)} ${tally.worstHs.toFixed(1).padEnd(10)} ${tally.worstCost.toFixed(1).padEnd(10)} ${Object.entries(tally.statuses).map(([status, count]) => `${status}:${count}`).join(' ')}`)
  }
}

// Every request through the oracle and every solver. Returns the tallies, how many requests the oracle could not enumerate, and how often the three objective keys left several optimal packages.
const sweepAgainstOracle = (quantized, requests, objective, packTanks) => {
  const { solvers } = solversFor(quantized, objective, packTanks)
  const tallies = Object.fromEntries(Object.keys(solvers).map((name) => [name, newTally()]))
  let skipped = 0
  let tied = 0
  let tiedExcess = 0
  let compared = 0

  for (const request of requests) {
    const truth = oracle(quantized.rows, request, { objective })

    if (truth.status !== OPTIMAL) {
      skipped++
      continue
    }

    compared++
    tied += truth.tied > 1 ? 1 : 0
    tiedExcess += truth.tiedExcess > 1 ? 1 : 0

    for (const [name, solve] of Object.entries(solvers)) {
      score(tallies[name], quantized.rows, request, solve(request), truth.best, objective)
    }
  }

  return { tallies, skipped, compared, tied, tiedExcess }
}

const exactSolversAgree = (tallies, names) => names.every((name) => tallies[name].worse === 0 && tallies[name].invalid === 0 && tallies[name].wrongOptimal === 0 && tallies[name].falseInfeasible === 0 && tallies[name].noPackage === 0 && tallies[name].inapplicable === 0)

// ---------- synthetic catalogues ----------

const between = (rand, low, high) => low + Math.floor(rand() * (high - low + 1))

// Whole-number catalogues of five families, each [litres, HS, BP] triples:
//  free: every figure independent; uniform: HS proportional to litres, BP free; chain: uniform, litres a divisibility chain, BP free; canonical: uniform, a chain and BP economy (the shortcut's proof conditions); economy-broken, density-broken and chain-broken: a canonical catalogue with one row's BP raised past the economy bound, one row's HS off the common density, or one row's litres off the chain.
const FAMILIES = {
  free: (rand) => Array.from({ length: between(rand, 2, 5) }, () => [between(rand, 2, 24), between(rand, 1, 24), between(rand, 1, 24)]),
  uniform: (rand) => {
    const k = between(rand, 1, 2)

    return Array.from({ length: between(rand, 2, 5) }, () => {
      const litres = between(rand, 2, 24)

      return [litres, litres * k, between(rand, 1, 24)]
    })
  },
  chain: (rand) => {
    const k = between(rand, 1, 2)
    const rows = []
    let litres = between(rand, 1, 3)

    for (let index = 0; index < between(rand, 2, 4); index++) {
      rows.push([litres, litres * k, between(rand, 1, 24)])
      litres *= between(rand, 2, 5)
    }

    return rows
  },
  canonical: (rand) => canonicalRows(rand),
  'economy-broken': (rand) => canonicalRows(rand, { economy: true }),
  'density-broken': (rand) => canonicalRows(rand, { density: true }),
  'chain-broken': (rand) => canonicalRows(rand, { chain: true }),
}

const canonicalRows = (rand, { economy = false, density = false, chain = false } = {}) => {
  const k = between(rand, 1, 2)
  const size = between(rand, 3, 4)
  const broken = between(rand, 1, size - 1)
  const rows = []
  let litres = between(rand, 1, 3)
  let cost = between(rand, 1, 6)

  for (let index = 0; index < size; index++) {
    if (index > 0) {
      const ratio = between(rand, 2, 5)

      litres *= ratio
      cost = Math.max(1, Math.floor(ratio * cost * (0.4 + 0.6 * rand())))

      if (economy && index === broken) {
        cost = ratio * rows[index - 1][2] + between(rand, 1, 3)
      }
    }

    const rowLitres = chain && index === broken ? litres + 1 : litres

    rows.push([rowLitres, rowLitres * k + (density && index === broken ? 1 : 0), cost])
  }

  return rows
}

const syntheticRequests = (rows) => {
  const top = Math.max(...rows.map((row) => row.litres))
  const requests = []

  for (let request = 1; request <= Math.min(40, 2 * top); request++) {
    requests.push(request)
  }

  return requests
}

// ---------- the sections ----------

const runOracleChecks = (packTanks) => {
  heading('Oracle: the recorded counterexample and the stated tie-breaks')

  // R-DESIGN-02: 10 L/10 HS, 6 L/3 HS, 1 L/1 HS asking 10 L. The finding records no BP, so every combination of 1..4 BP per row is tried, and HS as BP.
  const costs = []

  for (let a = 1; a <= 4; a++) {
    for (let b = 1; b <= 4; b++) {
      for (let c = 1; c <= 4; c++) {
        costs.push([a, b, c])
      }
    }
  }

  costs.push([10, 3, 1])

  const outcomes = costs.map(([a, b, c]) => {
    const quantized = synthetic([[10, 10, a], [6, 3, b], [1, 1, c]])
    const truth = oracle(quantized.rows, 10)
    const current = currentSolver(packTanks, quantized)(10)
    const picked = evaluate(quantized.rows, current.counts, 10)

    return { truth, current: picked, domain: truth.domain }
  })

  check('oracle: 10 L request over 10 L/10 HS, 6 L/3 HS, 1 L/1 HS is 6 HS from two 6 L tanks for every BP of 1..4 per row', outcomes.every((o) => o.truth.best.hs === 6 && o.truth.best.counts.join() === '0,2,0'), `${outcomes.length} BP combinations, domain ${outcomes[0].domain} count vectors`)

  const losing = outcomes.filter((o) => o.current.hs === 10).length

  check('the removed greedy packTanks returns 10 HS for that request in every BP combination (the recorded counterexample)', losing === outcomes.length, `${losing}/${outcomes.length} return 10 HS`)

  const ties = [
    { name: 'HS tie goes to the lower BP', triples: [[4, 2, 5], [2, 1, 3]], request: 4, objective: LIGHTEST, counts: [1, 0] },
    { name: 'HS and BP tie go to the fewer tanks', triples: [[4, 2, 6], [2, 1, 3]], request: 4, objective: LIGHTEST, counts: [1, 0] },
    { name: 'lightest takes the lighter package', triples: [[10, 10, 1], [6, 3, 9]], request: 10, objective: LIGHTEST, counts: [0, 2] },
    { name: 'cheapest takes the cheaper package', triples: [[10, 10, 1], [6, 3, 9]], request: 10, objective: CHEAPEST, counts: [1, 0] },
    { name: 'cheapest breaks a BP tie on HS', triples: [[4, 4, 5], [4, 2, 5]], request: 4, objective: CHEAPEST, counts: [0, 1] },
  ]

  for (const item of ties) {
    const quantized = synthetic(item.triples)
    const truth = oracle(quantized.rows, item.request, { objective: item.objective })

    check(`oracle tie-break: ${item.name}`, truth.best.counts.join() === item.counts.join(), `${truth.best.counts.join()} hs ${truth.best.hs} bp ${truth.best.cost} count ${truth.best.count}`)
  }

  const front = nondominated(synthetic([[10, 10, 1], [6, 3, 9], [1, 1, 1]]).rows, 10)

  console.log(`  nondominated (HS, BP, excess L) packages for the 10 L request at BP 1/9/1: ${front.map((p) => `[${p.hs} HS, ${p.cost} BP, +${p.excess} L]`).join(' ')}`)
}

const requestsOf = (count, high, rand) => Array.from({ length: count }, () => Math.max(1, Math.round(Math.exp(rand() * Math.log(high)))))

const runCatalogueSweeps = (catalogues, packTanks) => {
  const rand = mulberry32(20261013)

  for (const catalogue of catalogues) {
    const { rows } = catalogue.quantized

    if (!rows) {
      continue
    }

    const step = options.quick ? 7 : 2
    const dense = []
    const domainAt = (request) => rows.reduce((product, row) => product * (Math.ceil(request / row.litres) + 1), 1)
    let denseMax = 100

    while (denseMax < 3000 && domainAt(denseMax + 100) <= ORACLE_LIMIT) {
      denseMax += 100
    }

    for (let request = 1; request <= denseMax; request += step) {
      dense.push(request)
    }

    const sparse = requestsOf(options.quick ? 200 : 1500, 40000, rand)

    for (const [label, objective] of [['lightest', LIGHTEST], ['cheapest', CHEAPEST]]) {
      heading(`${catalogue.name} (${rows.length} rows) against the exhaustive oracle, ${label}: R = 1..${denseMax} step ${step} and ${sparse.length} log-uniform requests up to 40000 L`)

      const result = sweepAgainstOracle(catalogue.quantized, [...dense, ...sparse], objective, packTanks)

      console.log(`  compared ${result.compared}, oracle domain too large for ${result.skipped}; the three keys leave several optimal packages in ${result.tied} requests, still several after the least-excess key in ${result.tiedExcess}`)
      printTallies(result.tallies)

      const exactNames = objective === LIGHTEST ? ['dp', 'bnb'] : ['dp', 'bnb']

      check(`${catalogue.name} ${label}: dp and bnb equal the oracle on every compared request`, exactSolversAgree(result.tallies, exactNames), `${result.compared} requests`)

      if (objective === LIGHTEST) {
        const shortcut = result.tallies.shortcut

        check(`${catalogue.name} lightest: the shortcut is ${classify(rows).applicable ? 'applicable and equals' : 'inapplicable and returns no package against'} the oracle`, classify(rows).applicable ? shortcut.worse === 0 && shortcut.invalid === 0 && shortcut.match === shortcut.n : shortcut.inapplicable === shortcut.n)
      }

      if (catalogue.name === 'stock' && objective === LIGHTEST) {
        let closedForm = true

        for (const request of dense) {
          closedForm = closedForm && oracle(rows, request).best.hs === Math.ceil(request / 100) * 2
        }

        check('oracle on the stock catalogue equals the closed form 0.002 HS per started 100 L', closedForm)
      }
    }
  }
}

const runSyntheticSweeps = (packTanks) => {
  const count = options.quick ? 60 : 400

  for (const [family, make] of Object.entries(FAMILIES)) {
    const rand = mulberry32(7000 + family.length)
    const merged = {}
    let applicable = 0
    const reasons = {}
    let catalogues = 0
    let skipped = 0
    let compared = 0

    for (let index = 0; index < count; index++) {
      const quantized = synthetic(make(rand))

      catalogues++

      const verdict = classify(quantized.rows)

      if (verdict.applicable) {
        applicable++
      }

      for (const reason of verdict.reasons) {
        reasons[reason] = (reasons[reason] || 0) + 1
      }

      const objectives = family === 'free' || family === 'canonical' ? [LIGHTEST, CHEAPEST] : [LIGHTEST]

      for (const objective of objectives) {
        const result = sweepAgainstOracle(quantized, syntheticRequests(quantized.rows), objective, packTanks)
        const tag = objective === LIGHTEST ? 'lightest' : 'cheapest'

        skipped += result.skipped
        compared += result.compared

        for (const [name, tally] of Object.entries(result.tallies)) {
          const into = merged[`${tag}/${name}`] || (merged[`${tag}/${name}`] = newTally())

          for (const key of ['n', 'match', 'worse', 'invalid', 'noPackage', 'inapplicable', 'wrongOptimal', 'falseInfeasible']) {
            into[key] += tally[key]
          }

          into.worstHs = Math.max(into.worstHs, tally.worstHs)
          into.worstCost = Math.max(into.worstCost, tally.worstCost)

          for (const [status, amount] of Object.entries(tally.statuses)) {
            into.statuses[status] = (into.statuses[status] || 0) + amount
          }
        }
      }
    }

    heading(`synthetic family "${family}": ${catalogues} catalogues, ${compared} (catalogue, request, objective) cases, ${skipped} too large for the oracle; shortcut applicable to ${applicable}${Object.keys(reasons).length ? `, reasons ${Object.entries(reasons).map(([reason, amount]) => `${reason}:${amount}`).join(' ')}` : ''}`)
    printTallies(merged)

    const exact = Object.fromEntries(Object.entries(merged).filter(([name]) => /\/(dp|bnb)$/.test(name)))

    check(`synthetic ${family}: dp and bnb equal the oracle in every case`, exactSolversAgree(exact, Object.keys(exact)), `${compared} cases`)

    const shortcut = merged['lightest/shortcut']

    check(`synthetic ${family}: the shortcut never loses to the oracle where it answers, and answers exactly when the conditions hold`, shortcut.worse === 0 && shortcut.invalid === 0 && shortcut.wrongOptimal === 0 && ((shortcut.n - shortcut.inapplicable) > 0) === (applicable > 0), `${shortcut.match} matches, ${shortcut.inapplicable} inapplicable`)
  }
}

// Large requests, past what the oracle can enumerate: the exact table (equal to the oracle on every small request above) is the reference. Times are isolated per call and only indicative; the search measurements below are the ones that count.
const runLargeRequests = (catalogues, packTanks) => {
  for (const catalogue of catalogues) {
    const { rows } = catalogue.quantized

    if (!rows) {
      continue
    }

    for (const [label, objective] of [['lightest', LIGHTEST], ['cheapest', CHEAPEST]]) {
      const reference = createDp(rows, { objective })
      const high = Math.min(5e7, reference.quantum * MAX_UNITS)
      const requests = requestsOf(options.quick ? 2000 : 6000, high, mulberry32(99))
      const solvers = {
        'greedy-largest': (request) => greedyLargest(rows, request, objective),
        'greedy-density': (request) => greedyDensity(rows, request, objective),
        'bnb-100': (request) => solveBnb(rows, request, { objective, nodeBound: 100 }),
        'bnb-1000': (request) => solveBnb(rows, request, { objective, nodeBound: 1000 }),
        'bnb-10000': (request) => solveBnb(rows, request, { objective, nodeBound: 10000 }),
        'bnb-100000': (request) => solveBnb(rows, request, { objective, nodeBound: 100000 }),
      }

      if (objective === LIGHTEST) {
        solvers.current = currentSolver(packTanks, catalogue.quantized)
        solvers.production = currentSolver(production.packTanks, catalogue.quantized)
        solvers.shortcut = stockShortcut(rows)
      }

      const tallies = Object.fromEntries(Object.keys(solvers).map((name) => [name, newTally()]))
      const spent = Object.fromEntries(Object.keys(solvers).map((name) => [name, 0]))
      const nodes = Object.fromEntries(Object.keys(solvers).map((name) => [name, 0]))
      let compared = 0

      const dpStart = process.hrtime.bigint()

      const truths = requests.map((request) => reference.solve(request))

      const dpMicros = Number(process.hrtime.bigint() - dpStart) / 1000 / requests.length

      requests.forEach((request, position) => {
        const truth = truths[position]

        if (truth.status !== OPTIMAL) {
          return
        }

        compared++

        const best = evaluate(rows, truth.counts, request)

        for (const [name, solve] of Object.entries(solvers)) {
          const start = process.hrtime.bigint()
          const result = solve(request)

          spent[name] += Number(process.hrtime.bigint() - start)
          nodes[name] += result.nodes || 0
          score(tallies[name], rows, request, result, best, objective)
        }
      })

      heading(`${catalogue.name} ${label}: ${compared} log-uniform requests of 1 to ${Math.round(high)} L against the exact table (quantum ${reference.quantum} L, ${reference.units()} units, ${(reference.bytes() / 1048576).toFixed(2)} MiB; first build and ${requests.length} lookups ${dpMicros.toFixed(1)} us per call)`)
      printTallies(tallies)
      console.log(`  isolated us per call: ${Object.keys(solvers).map((name) => `${name} ${(spent[name] / 1000 / Math.max(1, compared)).toFixed(1)} (${(nodes[name] / Math.max(1, compared)).toFixed(0)} nodes)`).join(', ')}`)
    }
  }
}

// The status of a result when a bound runs out or nothing fits: bound-exhausted is never infeasible.
const runStatusDemos = (packTanks, catalogues) => {
  heading('Status discipline: bound-exhausted is not infeasible')

  const rows = synthetic([[10, 10, 10]]).rows
  const empty = []
  const limited = synthetic([[10, 10, 10], [9, 5, 5]]).rows
  const stock = catalogues.find((catalogue) => catalogue.name === 'stock')

  const demos = [
    ['empty catalogue, 10 L', () => solveBnb(empty, 10), INFEASIBLE, true],
    ['empty catalogue, 10 L (table)', () => createDp(empty).solve(10), INFEASIBLE, true],
    ['empty catalogue, 10 L (removed greedy packTanks)', () => (packTanks({ litres: 10, tanks: [] }).picks.length === 0 ? { status: INFEASIBLE, counts: null } : { status: HEURISTIC, counts: [] }), INFEASIBLE, true],
    ['zero request, any catalogue', () => solveBnb(rows, 0), OPTIMAL, false],
    ['one 10 L tank, 100 L, at most 5 tanks, search finished', () => solveBnb(rows, 100, { maxTanks: 5, nodeBound: 1e6 }), INFEASIBLE, true],
    ['one 10 L tank, 100 L, at most 5 tanks, 2 nodes allowed (the count bound proves it at the root)', () => solveBnb(rows, 100, { maxTanks: 5, nodeBound: 2 }), INFEASIBLE, true],
    ['10 L and 9 L/5 HS rows, 100 L, at most 10 tanks, 3 nodes allowed (no incumbent fits the tank limit yet)', () => solveBnb(limited, 100, { maxTanks: 10, nodeBound: 3 }), EXHAUSTED, true],
    ['10 L and 9 L/5 HS rows, 100 L, at most 10 tanks, search finished', () => solveBnb(limited, 100, { maxTanks: 10, nodeBound: 1e6 }), OPTIMAL, false],
    ['one 10 L tank, 100 L, at most 10 tanks', () => solveBnb(rows, 100, { maxTanks: 10, nodeBound: 1e6 }), OPTIMAL, false],
    ['table with a quantum above every row (50 L)', () => createDp(rows, { quantum: 50 }).solve(100), EXHAUSTED, true],
    ['table with a quantum that rounds rows down (4 L over 6 L rows)', () => createDp(synthetic([[6, 3, 3], [10, 6, 5]]).rows, { quantum: 4 }).solve(20), HEURISTIC, false],
    ['table capped at 1000 units, 10 L rows, 100000 L', () => createDp(rows, { maxUnits: 1000 }).solve(100000), EXHAUSTED, false],
    ['shortcut on the counterexample catalogue', () => stockShortcut(synthetic([[10, 10, 10], [6, 3, 6], [1, 1, 1]]).rows)(10), INAPPLICABLE, true],
  ]

  if (stock && stock.quantized.rows) {
    demos.push(['stock, 123456789 L, 5 nodes allowed', () => solveBnb(stock.quantized.rows, 123456789, { nodeBound: 5 }), EXHAUSTED, false])
  }

  for (const [name, run, status, withoutPackage] of demos) {
    const result = run()

    check(`${name}: ${status}${withoutPackage ? ', no package' : ', a package'}`, result.status === status && (result.counts === null || result.counts === undefined) === withoutPackage, `${result.status}${result.reason ? ` (${result.reason})` : ''}${result.counts ? ` counts ${result.counts.join(',')}` : ''}`)
  }

  const capped = createDp(rows, { maxUnits: 1000 }).solve(100000)

  check('the capped table still returns a package that reaches the request', capped.counts && evaluate(rows, capped.counts, 100000).litres >= 100000)

  const coarse = createDp(synthetic([[6, 3, 3], [10, 6, 5]]).rows, { quantum: 4 }).solve(20)

  check('a coarse quantum gives a package that reaches the request but is not claimed optimal', coarse.counts && evaluate(synthetic([[6, 3, 3], [10, 6, 5]]).rows, coarse.counts, 20).litres >= 20 && coarse.status === HEURISTIC)
}

// ---------- where the current packer loses, and what a table costs ----------

const describePackage = (rows, counts, scale) => counts.map((count, index) => (count ? `${count} x ${rows[index].litres} L/${rows[index].hs / scale.hsScale} HS` : null)).filter(Boolean).join(' + ')

// Every whole request from 1 L up against the exact table: where packTanks first loses on the real catalogues, how often by size of request, and whether the shortcut ever differs from the table.
const runFailureAnatomy = (catalogues, packTanks) => {
  for (const catalogue of catalogues) {
    const { rows, hsScale } = catalogue.quantized

    if (!rows) {
      continue
    }

    const top = options.quick ? 30000 : 300000
    const reference = createDp(rows)
    const current = currentSolver(packTanks, catalogue.quantized)
    const shortcut = stockShortcut(rows)
    const applicable = classify(rows).applicable
    const decades = {}
    const first = []
    let worse = 0
    let hsWorse = 0
    let shortcutDiffers = 0

    for (let request = 1; request <= top; request++) {
      const best = evaluate(rows, reference.solve(request).counts, request)
      const got = evaluate(rows, current(request).counts, request)
      const decade = Math.floor(Math.log10(request))
      const bucket = decades[decade] || (decades[decade] = { n: 0, worse: 0 })

      bucket.n++

      if (!sameKeys(got, best, LIGHTEST)) {
        worse++
        hsWorse += got.hs > best.hs ? 1 : 0
        bucket.worse++

        if (first.length < 4) {
          first.push({ request, got, best, gotCounts: current(request).counts, bestCounts: reference.solve(request).counts })
        }
      }

      if (applicable && !sameKeys(evaluate(rows, shortcut(request).counts, request), best, LIGHTEST)) {
        shortcutDiffers++
      }
    }

    heading(`${catalogue.name}: every whole request 1..${top} L, the removed greedy packTanks against the exact table (lightest)`)
    console.log(`  the removed greedy packTanks differs from the optimum on ${worse} requests (${hsWorse} of them on HS, the rest on BP or count); by decade of request: ${Object.entries(decades).map(([decade, bucket]) => `10^${decade}: ${bucket.worse}/${bucket.n}`).join(', ')}`)

    for (const item of first) {
      console.log(`  R = ${item.request} L: packTanks ${item.got.hs / hsScale} HS ${item.got.cost} cost units (${describePackage(rows, item.gotCounts, catalogue.quantized)}) against optimum ${item.best.hs / hsScale} HS ${item.best.cost} cost units (${describePackage(rows, item.bestCounts, catalogue.quantized)})`)
    }

    if (applicable) {
      check(`${catalogue.name}: the shortcut equals the exact table on every whole request 1..${top} L`, shortcutDiffers === 0, `${shortcutDiffers} differences`)
      check(`${catalogue.name}: the removed greedy packTanks equals the optimum on every whole request 1..${top} L (its behaviour on a canonical catalogue)`, worse === 0, `${worse} differences`)
    }
  }
}

// What building the exact table costs up front, per catalogue, for the quantum and the request sizes a search meets.
const runTableBuild = (catalogues) => {
  heading('Exact table: build time and memory by capacity (lightest objective, quantum = gcd of litres)')

  for (const catalogue of catalogues) {
    const { rows } = catalogue.quantized

    if (!rows) {
      continue
    }

    for (const units of [1e4, 1e5, 5e5, MAX_UNITS]) {
      const dp = createDp(rows)
      const start = process.hrtime.bigint()

      dp.solve(units * dp.quantum)

      console.log(`  ${catalogue.name}: ${units} units (${units * dp.quantum} L): ${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(1)} ms, ${(dp.bytes() / 1048576).toFixed(2)} MiB`)
    }
  }
}

// The periodic extension beyond the table's cap, against references that do not use it: a table built far past the cap (real catalogues), the shortcut on the stock catalogue up to 1e11 L, and a tiny table against a large one on synthetic catalogues.
const runPeriodic = (catalogues) => {
  heading('Periodic extension: proof cap per catalogue and objective, and equality with tables built past the cap without it')

  const bigUnits = 1 << 22

  for (const catalogue of catalogues) {
    const { rows } = catalogue.quantized

    if (!rows) {
      continue
    }

    for (const [label, objective] of [['lightest', LIGHTEST], ['cheapest', CHEAPEST]]) {
      const dp = createDp(rows, { objective })
      const start = process.hrtime.bigint()
      const proved = dp.prove()
      const proofMs = Number(process.hrtime.bigint() - start) / 1e6

      console.log(`  ${catalogue.name} ${label}: proof ${proved ? `holds at ${proved} units (${proved * dp.quantum} L) after ${proofMs.toFixed(1)} ms, table ${(dp.bytes() / 1048576).toFixed(2)} MiB` : `not found up to ${MAX_UNITS} units`}`)

      check(`${catalogue.name} ${label}: the periodic proof is found below the table cap`, proved > 0)

      if (!proved) {
        continue
      }

      const reference = createDp(rows, { objective, maxUnits: bigUnits, periodic: false })
      const rand = mulberry32(31337)
      const total = options.quick ? 400 : 3000
      const span = Math.log(bigUnits / proved)
      let equal = 0
      let extended = 0
      let notOptimal = 0

      for (let index = 0; index < total; index++) {
        const units = Math.min(bigUnits, proved + 1 + Math.floor(proved * (Math.exp(rand() * span) - 1)))
        const request = units * dp.quantum - Math.floor(rand() * dp.quantum)
        const got = dp.solve(request)
        const best = reference.solve(request)

        if (got.status !== OPTIMAL) {
          notOptimal++
        }

        if (got.reason === 'periodic-extension') {
          extended++
        }

        if (got.counts && best.counts && best.status === OPTIMAL && evaluate(rows, got.counts, request).litres >= request && sameKeys(evaluate(rows, got.counts, request), evaluate(rows, best.counts, request), objective)) {
          equal++
        }
      }

      console.log(`    ${total} requests of ${proved + 1}..${bigUnits} units: ${equal} equal to the table built to ${bigUnits} units without the extension, ${extended} answered by the extension, ${notOptimal} not optimal`)
      check(`${catalogue.name} ${label}: the extension equals a table built past the cap`, equal === total && notOptimal === 0, `${equal}/${total}`)

      if (catalogue.name === 'stock' && objective === LIGHTEST && classify(rows).applicable) {
        const shortcut = stockShortcut(rows)
        const big = []
        let same = 0

        for (let index = 0; index < total; index++) {
          big.push(Math.ceil(Math.exp(Math.log(1e6) + rand() * (Math.log(1e11) - Math.log(1e6)))))
        }

        for (const request of big) {
          const got = dp.solve(request)
          const best = shortcut(request)

          if (got.status === OPTIMAL && best.counts && evaluate(rows, got.counts, request).litres >= request && sameKeys(evaluate(rows, got.counts, request), evaluate(rows, best.counts, request), objective)) {
            same++
          }
        }

        console.log(`    ${total} requests of 1e6..1e11 L: ${same} equal to the shortcut's mixed-radix package`)
        check('stock lightest: the extension equals the shortcut on requests up to 1e11 L', same === total, `${same}/${total}`)
      }
    }
  }

  for (const [family, make] of Object.entries(FAMILIES)) {
    const rand = mulberry32(555 + family.length)
    const count = options.quick ? 60 : 200
    let proven = 0
    let unproven = 0
    let equal = 0
    let compared = 0
    let extended = 0

    for (let index = 0; index < count; index++) {
      const { rows } = synthetic(make(rand))
      const objective = index % 2 ? CHEAPEST : LIGHTEST
      const small = createDp(rows, { objective, maxUnits: 4096 })
      const reference = createDp(rows, { objective, maxUnits: 1 << 18, periodic: false })
      const proved = small.prove()

      if (proved) {
        proven++
      } else {
        unproven++
      }

      for (let attempt = 0; attempt < 40; attempt++) {
        const request = Math.floor(1 + rand() * reference.quantum * (1 << 17))
        const got = small.solve(request)
        const best = reference.solve(request)

        if (got.status !== OPTIMAL || best.status !== OPTIMAL) {
          continue
        }

        compared++

        if (got.reason === 'periodic-extension') {
          extended++
        }

        if (evaluate(rows, got.counts, request).litres >= request && sameKeys(evaluate(rows, got.counts, request), evaluate(rows, best.counts, request), objective)) {
          equal++
        }
      }
    }

    console.log(`  ${family}: proof found for ${proven} of ${count} catalogues (${unproven} not provable inside 4096 units); ${compared} optimal answers compared with a 2^18-unit table, ${extended} by the extension, ${equal} equal`)
    check(`${family}: every answer the small table calls optimal equals the big table`, equal === compared, `${equal}/${compared}`)
  }
}

// On a catalogue of several densities: whether the rows of the greatest litres per HS alone fix the lightest HS, and whether they fix the whole lightest package (HS, BP, count).
const runDominance = (catalogues) => {
  for (const catalogue of catalogues) {
    const { rows } = catalogue.quantized

    if (!rows) {
      continue
    }

    const densest = rows.reduce((best, row) => (row.litres * best.hs > best.litres * row.hs ? row : best), rows[0])
    const subset = rows.filter((row) => row.litres * densest.hs === densest.litres * row.hs).map((row, index) => ({ ...row, index }))

    if (subset.length === rows.length) {
      console.log(`  ${catalogue.name}: one density, no dominance question`)
      continue
    }

    const top = options.quick ? 30000 : 300000
    const full = createDp(rows)
    const part = createDp(subset)
    const subsetVerdict = classify(subset)
    let sameHs = 0
    let sameAll = 0

    for (let request = 1; request <= top; request++) {
      const a = evaluate(rows, full.solve(request).counts, request)
      const b = evaluate(subset, part.solve(request).counts, request)

      sameHs += a.hs === b.hs ? 1 : 0
      sameAll += sameKeys(a, b, LIGHTEST) ? 1 : 0
    }

    heading(`${catalogue.name}: the ${subset.length} densest rows (${densest.litres / (densest.hs / catalogue.quantized.hsScale)} L per HS) of ${rows.length}, requests 1..${top} L`)
    console.log(`  same lightest HS as the whole catalogue on ${sameHs} requests, same HS, BP and count on ${sameAll}; the densest rows alone ${subsetVerdict.applicable ? 'meet' : `fail (${subsetVerdict.reasons.join(', ')})`} the shortcut's conditions`)
  }
}

// ---------- inside a propulsion search ----------

const gc = (() => {
  v8.setFlagsFromString('--expose-gc')

  return vm.runInNewContext('gc')
})()

const usedBytes = () => {
  const usage = process.memoryUsage()

  return usage.heapUsed + usage.arrayBuffers
}

// A new task as soon as the event loop has had its turn, as the page does it.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => {
    channel.port1.close()
    resolve()
  }
  channel.port2.postMessage(null)
})

// searchPropulsion's own source with its design-rules import taken from `globalThis.__benchRules`, its sweep-domain import taken from the real module (`globalThis.__benchSweep`), its tank-packing import replaced by `globalThis.__benchTankPacking` (meetsRequest, PACKAGE_STATUS) and a `packerFor` whose packer is `globalThis.__benchPacker`, which warms nothing. Nothing else changes.
const loadPatchedSearch = async (rules) => {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', 'design-search.js'), 'utf8')
  const rulesPattern = /import \{([^}]*)\} from '\.\/design-rules'/
  const sweepPattern = /import \{([^}]*)\} from '\.\/sweep-domain'/
  const packingPattern = /import \{([^}]*)\} from '\.\/tank-packing'/
  const rulesMatch = rulesPattern.exec(source)
  const sweepMatch = sweepPattern.exec(source)
  const packingMatch = packingPattern.exec(source)

  if (!rulesMatch || !sweepMatch || !packingMatch || !/\bpackerFor\b/.test(packingMatch[1])) {
    throw new Error('design-search.js no longer imports packerFor from ./tank-packing in the shape the harness replaces')
  }

  const patched = source.replace(rulesPattern, `const { ${rulesMatch[1].trim()} } = globalThis.__benchRules`).replace(sweepPattern, `const { ${sweepMatch[1].trim()} } = globalThis.__benchSweep`).replace(packingPattern, 'const { meetsRequest, PACKAGE_STATUS } = globalThis.__benchTankPacking\nconst packerFor = (tanks) => ({ pack: (litres) => globalThis.__benchPacker({ litres, tanks }), warm: function* () {} })')

  if (/from '\.\//.test(patched)) {
    throw new Error('design-search.js imports another utility the harness does not load')
  }

  globalThis.__benchRules = rules
  globalThis.__benchSweep = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', 'sweep-domain.js'), 'utf8')).toString('base64')}`)
  globalThis.__benchTankPacking = production

  return import(`data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`)
}

// A package in the shape the search reads (status, feasibility, excess, count, crew) from a packer that only returns picks, sizeHS, litres and cost: the removed greedy and the research packers. Such a package holds the litres or is nothing, and is never proved.
const adaptPack = (pack, request) => {
  if (pack.feasible !== undefined) {
    return pack
  }

  const feasible = pack.picks.length > 0 || !(request.litres > 0)
  const crew = pack.picks.every((pick) => Number.isFinite(pick.crew)) ? pack.picks.reduce((sum, pick) => sum + pick.crew * pick.count, 0) : null

  return { ...pack, feasible, status: feasible ? EXHAUSTED : INFEASIBLE, reason: null, objective: 'lightest', complete: false, requestedLitres: request.litres, excessLitres: Math.max(0, pack.litres - request.litres), count: pack.picks.reduce((sum, pick) => sum + pick.count, 0), crew }
}

const SEARCH_EPSILON = 1e-9

// A packer for the search: `solve(request)` takes whole litres and returns { status, counts }, adapted to packTanks' result ({ picks, sizeHS, litres, cost }). `audit`, when given, compares every result with the exact table on the same request.
const makePacker = (quantized, solve, audit = null) => {
  const { rows, tanks, hsScale, costScale } = quantized
  const stats = { calls: 0, ms: 0, nodes: 0, noPackage: 0, statuses: {} }
  const nothing = Object.freeze({ picks: [], sizeHS: 0, litres: 0, cost: 0 })

  const packer = ({ litres }) => {
    const need = litres > 0 ? Math.ceil(litres * (1 - SEARCH_EPSILON)) : 0
    const start = performance.now()
    const result = solve(need)

    stats.calls++
    stats.statuses[result.status] = (stats.statuses[result.status] || 0) + 1
    stats.nodes += result.nodes || 0

    let pack = nothing

    if (!result.counts) {
      stats.noPackage++
    } else {
      const picks = []
      let hs = 0
      let cost = 0
      let held = 0

      for (let index = 0; index < rows.length; index++) {
        const count = result.counts[index]

        if (count > 0) {
          hs += count * rows[index].hs
          cost += count * rows[index].cost
          held += count * rows[index].litres
          picks.push({ ...tanks[index], count })
        }
      }

      pack = { picks, sizeHS: hs / hsScale, litres: held, cost: cost / costScale }
    }

    stats.ms += performance.now() - start

    if (audit) {
      audit.record(need, result, litres)
    }

    return pack
  }

  return { packer, stats }
}

const makeAudit = (quantized) => {
  const { rows } = quantized
  const reference = createDp(rows)
  const requests = new Float64Array(3e6)
  const tally = { calls: 0, noPackage: 0, worseHs: 0, worseCost: 0, toleranceOnly: 0, sumHs: 0, maxHs: 0, distinct: 0, recorded: 0 }

  return {
    tally,
    requests,
    reference,
    record: (need, result, litres = need) => {
      tally.calls++

      if (tally.recorded < requests.length) {
        requests[tally.recorded++] = need
      }

      if (!result.counts) {
        tally.noPackage++

        return
      }

      const got = evaluate(rows, result.counts, need)
      const best = evaluate(rows, reference.solve(need).counts, need)

      const strict = Math.ceil(litres - 1e-9)

      if (got.hs > best.hs && strict > need && got.hs <= evaluate(rows, reference.solve(strict).counts, strict).hs) {
        tally.toleranceOnly++
      } else if (got.hs > best.hs) {
        tally.worseHs++
        tally.sumHs += got.hs / best.hs - 1
        tally.maxHs = Math.max(tally.maxHs, got.hs / best.hs - 1)
      } else if (got.hs === best.hs && got.cost > best.cost) {
        tally.worseCost++
      }
    },
  }
}

const setKey = (set) => `${set.engine.sizeHS}/${set.engine.thrust}/${set.count}`

// One search run the way the page runs it: slices of SLICE_MS between event-loop turns, memory sampled each slice, a 1 ms timer probing how long the loop was blocked, and optionally a cancel request due `cancelAtMs` after the start, honoured as the page honours it (checked after the turn that follows a slice).
const runPaged = async ({ search, input, packer, budgetMs, cancelAtMs = null }) => {
  globalThis.__benchPacker = (request) => adaptPack(packer(request), request)

  gc()

  const base = usedBytes()
  const baseBuffers = process.memoryUsage().arrayBuffers
  const iterator = search.searchPropulsion(input)
  const slices = []
  let longestStep = 0
  let peak = 0
  let peakBuffers = 0
  let cancelled = false
  let progress = 0
  let evaluated = 0
  let step
  let outcome = 'finished'
  let probeLast = performance.now()
  let probeGap = 0
  let probing = true

  const tick = () => {
    const now = performance.now()

    probeGap = Math.max(probeGap, now - probeLast)
    probeLast = now

    if (probing) {
      setTimeout(tick, 1)
    }
  }

  const start = performance.now()

  setTimeout(tick, 1)

  if (cancelAtMs !== null) {
    setTimeout(() => {
      cancelled = true
    }, cancelAtMs)
  }

  do {
    const sliceStart = performance.now()
    const end = sliceStart + SLICE_MS

    do {
      const stepStart = performance.now()

      step = iterator.next()
      longestStep = Math.max(longestStep, performance.now() - stepStart)
    } while (!step.done && performance.now() < end)

    slices.push(performance.now() - sliceStart)
    peak = Math.max(peak, usedBytes() - base)
    peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers - baseBuffers)

    if (!step.done) {
      progress = step.value.progress
      evaluated = step.value.evaluated
      await nextTask()
    }

    if (cancelled && !step.done) {
      outcome = 'cancelled'
      break
    }

    if (!step.done && performance.now() - start > budgetMs) {
      outcome = 'budget'
      break
    }
  } while (!step.done)

  const wall = performance.now() - start
  const latency = outcome === 'cancelled' ? performance.now() - (start + cancelAtMs) : null

  probing = false

  const result = step.done ? step.value : null

  slices.sort((a, b) => a - b)

  return { outcome, wall, result, evaluated: result ? result.evaluated : evaluated, progress: result ? 1 : progress, slices, longestStep, probeGap, peak, peakBuffers, latency, base }
}

const packersOf = (catalogue, packTanks) => {
  const { quantized } = catalogue
  const { rows, tanks } = quantized
  const base = rows.reduce((acc, row) => gcd(acc, row.litres), 0)
  const shortcut = stockShortcut(rows)

  return [
    {
      name: 'current',
      make: (audit) => {
        const stats = { calls: 0, ms: 0, nodes: 0, noPackage: 0, statuses: {} }

        return {
          stats,
          packer: (request) => {
            const start = performance.now()
            const pack = packTanks({ litres: request.litres, tanks })

            stats.calls++
            stats.ms += performance.now() - start
            stats.statuses[pack.picks.length ? HEURISTIC : INFEASIBLE] = (stats.statuses[pack.picks.length ? HEURISTIC : INFEASIBLE] || 0) + 1

            if (audit) {
              audit.record(Math.ceil(request.litres * (1 - SEARCH_EPSILON)), { counts: rows.map((row) => pack.picks.filter((pick) => pick.id === row.id).reduce((sum, pick) => sum + pick.count, 0)) }, request.litres)
            }

            return pack
          },
        }
      },
    },
    { name: 'greedy-largest', make: (audit) => makePacker(quantized, (request) => greedyLargest(rows, request, LIGHTEST), audit) },
    { name: 'greedy-density', make: (audit) => makePacker(quantized, (request) => greedyDensity(rows, request, LIGHTEST), audit) },
    {
      name: 'table',
      make: (audit) => {
        const dp = createDp(rows)

        return { ...makePacker(quantized, dp.solve, audit), extra: () => `${dp.units()} units, ${(dp.bytes() / 1048576).toFixed(2)} MiB` }
      },
    },
    {
      name: 'table-q10',
      make: (audit) => {
        const dp = createDp(rows, { quantum: base * 10 })

        return { ...makePacker(quantized, dp.solve, audit), extra: () => `quantum ${dp.quantum} L, ${dp.units()} units, ${dp.rowsDropped} rows dropped` }
      },
    },
    { name: 'bnb-1e3', make: (audit) => makePacker(quantized, (request) => solveBnb(rows, request, { nodeBound: 1e3 }), audit), skipAudit: true },
    { name: 'bnb-1e4', make: (audit) => makePacker(quantized, (request) => solveBnb(rows, request, { nodeBound: 1e4 }), audit), skipAudit: true },
    {
      name: 'shortcut+bnb-1e4',
      make: (audit) => makePacker(quantized, (request) => {
        const answer = shortcut(request)

        return answer.status === INAPPLICABLE ? solveBnb(rows, request, { nodeBound: 1e4 }) : answer
      }, audit),
    },
  ]
}

const SCENARIOS = {
  stock: [
    { label: 'range, 100 HS hull, 2000 km/s, 5e9 km', input: { hullHS: 100, speed: 2000, goal: { mode: 'range', value: 5e9 } } },
    { label: 'endurance, 40 HS hull, 4000 km/s, 240 h at half power', input: { hullHS: 40, speed: 4000, fraction: 0.5, goal: { mode: 'endurance', value: 240 } } },
    { label: 'range, 1000 HS hull, 1500 km/s, 5e10 km', input: { hullHS: 1000, speed: 1500, goal: { mode: 'range', value: 5e10 } } },
  ],
  modded: [
    { label: 'range, 100 HS hull, 20000 km/s, 1e11 km (engine size capped at 60 HS)', techCap: { maxSize: 60 }, input: { hullHS: 100, speed: 20000, goal: { mode: 'range', value: 1e11 } } },
    { label: 'range, 400 HS hull, 40000 km/s, 1e13 km (engine size capped at 60 HS)', techCap: { maxSize: 60 }, input: { hullHS: 400, speed: 40000, goal: { mode: 'range', value: 1e13 } } },
  ],
}

const fmt = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a')

const MIB = 1048576

const runSearchBench = async (utilities, catalogues) => {
  const rules = utilities['design-rules']
  const packTanks = legacyPackTanks
  const search = await loadPatchedSearch(rules)
  const real = utilities['design-search']

  heading('Search harness')

  // The patched search with the production packer reproduces the unmodified search on a reduced grid.
  const first = catalogues.find((catalogue) => catalogue.quantized.rows)

  if (first) {
    const input = { hullHS: 60, speed: 1500, goal: { mode: 'range', value: 2e9 }, kind: 'either', minCount: 1, maxCount: 100, share: 1, tech: { ...first.tech, maxSize: 12, maxThrust: Math.min(first.tech.maxThrust, 1.5) }, tanks: first.quantized.tanks }
    const drain = (iterator) => {
      let step

      do {
        step = iterator.next()
      } while (!step.done)

      return step.value
    }
    const summary = (result) => JSON.stringify({ evaluated: result.evaluated, matched: result.matched, sets: result.sets.map((set) => [setKey(set), set.propulsionHS, set.cost, set.litres, set.tanks.map((pick) => `${pick.id}x${pick.count}`)]), lightest: result.lightest && setKey(result.lightest), fastest: result.fastest && setKey(result.fastest), cheapest: result.cheapest && setKey(result.cheapest) })

    globalThis.__benchPacker = (request) => production.packerFor(request.tanks).pack(request.litres)

    const unmodified = drain(real.searchPropulsion(input))
    const patched = drain(search.searchPropulsion(input))

    check('the patched search with the production packer gives the unmodified search\'s result (reduced grid)', summary(unmodified) === summary(patched), `${unmodified.evaluated} evaluated, ${unmodified.matched} matched, ${unmodified.sets.length} sets kept`)
  }

  for (const catalogue of catalogues) {
    if (!catalogue.quantized.rows) {
      continue
    }

    const scenarios = options.quick ? SCENARIOS[catalogue.name].slice(0, 1) : SCENARIOS[catalogue.name]

    for (const scenario of scenarios) {
      const techCap = options.quick ? { maxSize: 12, maxThrust: Math.min(catalogue.tech.maxThrust, 1.5) } : scenario.techCap || {}
      const input = { kind: 'either', minCount: 1, maxCount: 100, share: 1, ...scenario.input, tech: { ...catalogue.tech, ...techCap }, tanks: catalogue.quantized.tanks }

      heading(`search ${catalogue.name}: ${scenario.label}${options.quick ? ' (quick grid)' : ''}; the real search loop, ${SLICE_MS} ms slices, engine grid ${input.tech.maxSize} HS x thrust ${input.tech.minThrust}..${input.tech.maxThrust}, 1..100 engines`)

      // the reference: the exact table, which the audits compare against too
      const reference = packersOf(catalogue, packTanks).find((packer) => packer.name === 'table')
      const referenceAudit = makeAudit(catalogue.quantized)
      const referenceRun = reference.make(referenceAudit)
      const referenceResult = await runPaged({ search, input, packer: referenceRun.packer, budgetMs: 1e9 })
      const referenceKeys = referenceResult.result.sets.map(setKey)
      const referenceBest = referenceResult.result.sets[0]
      const requests = referenceAudit.requests.subarray(0, referenceAudit.tally.recorded)
      const sorted = Float64Array.from(requests).sort()
      const distinct = sorted.reduce((count, value, index) => count + (index === 0 || value !== sorted[index - 1] ? 1 : 0), 0)

      console.log(`  requests: ${referenceAudit.tally.calls} pack calls over ${referenceResult.result.evaluated} evaluated candidates (${(referenceAudit.tally.calls / referenceResult.result.evaluated).toFixed(2)} per candidate), ${distinct} distinct whole-litre requests (${fmt(100 * distinct / Math.max(1, sorted.length))}% distinct); litres min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, p99 ${sorted[Math.floor(sorted.length * 0.99)]}, max ${sorted[sorted.length - 1]}; matched ${referenceResult.result.matched}`)

      for (const spec of packersOf(catalogue, packTanks)) {
        if (spec.name === 'shortcut+bnb-1e4' && !classify(catalogue.quantized.rows).applicable) {
          continue
        }

        // timed run, no audit
        const holder = { instance: spec.make(null) }
        const timed = await runPaged({ search, input, packer: holder.instance.packer, budgetMs: options.budgetMs })
        const stats = holder.instance.stats
        const extra = holder.instance.extra ? holder.instance.extra() : ''

        globalThis.__benchPacker = null
        gc()

        const withInstance = usedBytes()

        holder.instance = null
        gc()

        const retained = withInstance - usedBytes()

        // cancel after 0.3 s and 1.5 s
        const latencies = []

        for (const at of [300, 1500]) {
          const cancelInstance = spec.make(null)
          const cancelRun = await runPaged({ search, input, packer: cancelInstance.packer, budgetMs: 1e9, cancelAtMs: at })

          if (cancelRun.latency !== null) {
            latencies.push(cancelRun.latency)
          }
        }

        // quality against the table
        let quality = ''

        if (!spec.skipAudit && timed.outcome === 'finished') {
          const audit = makeAudit(catalogue.quantized)
          const auditInstance = spec.make(audit)
          const audited = await runPaged({ search, input, packer: auditInstance.packer, budgetMs: options.budgetMs })

          if (audited.result) {
            const keys = audited.result.sets.map(setKey)
            const overlap = keys.filter((key) => referenceKeys.includes(key)).length
            const best = audited.result.sets[0]

            quality = `; against the table: ${audit.tally.worseHs} calls heavier in HS (${fmt(100 * audit.tally.worseHs / Math.max(1, audit.tally.calls), 2)}%, mean +${fmt(100 * audit.tally.sumHs / Math.max(1, audit.tally.worseHs))}%, max +${fmt(100 * audit.tally.maxHs)}%), ${audit.tally.worseCost} equal HS but dearer, ${audit.tally.noPackage} with no package; top-${keys.length} sets: ${overlap} shared with the table's, best set ${setKey(best) === setKey(referenceBest) ? 'identical' : 'differs'} (${fmt(best.propulsionHS, 3)} vs ${fmt(referenceBest.propulsionHS, 3)} HS of propulsion)`
            quality += `; ${audit.tally.toleranceOnly} more calls are heavier than the table only through the acceptance tolerance (equal to the table for the strict request)`
          }
        }

        const slices = timed.slices

        console.log(`  ${spec.name.padEnd(17)} ${timed.outcome === 'finished' ? '' : `[${timed.outcome} at ${fmt(100 * timed.progress)}% of the grid, ${timed.evaluated} candidates] `}${fmt(timed.wall / 1000, 2)} s wall, pack ${fmt(stats.ms / 1000, 2)} s (${fmt(100 * stats.ms / timed.wall, 0)}%), ${stats.calls} calls, ${fmt(1000 * stats.ms / Math.max(1, stats.calls), 1)} us/call, ${fmt(stats.nodes / Math.max(1, stats.calls), 0)} work units/call`)
        console.log(`    responsiveness: slice p50 ${fmt(percentile(slices, 0.5))} p99 ${fmt(percentile(slices, 0.99))} max ${fmt(slices[slices.length - 1])} ms, longest generator step ${fmt(timed.longestStep)} ms, longest event-loop block ${fmt(timed.probeGap)} ms, cancel requested at 0.3 s and 1.5 s honoured after ${latencies.map((value) => fmt(value)).join(' / ') || 'n/a'} ms`)
        console.log(`    memory: peak heap+buffers +${fmt(timed.peak / MIB)} MiB (includes the search's own garbage), peak typed arrays +${fmt(timed.peakBuffers / MIB, 2)} MiB, retained by the packer after the run ${fmt(retained / MIB, 2)} MiB${extra ? ` (${extra})` : ''}`)
        console.log(`    results: statuses ${Object.entries(stats.statuses).map(([status, count]) => `${status}:${count}`).join(' ')}, no package ${stats.noPackage}${quality}`)
      }
    }
  }
}

// The step times of the production packer's warm generator and of the real searchPropulsion over a sparse catalogue (one 1 L tank and fifteen of about 600,000 L, so no repeating pattern is proved below the table cap and the table is built whole). A fixed number of cold runs, each on a new tanks array so no packer is shared; every step of every run is kept, nothing is retried and nothing is asserted: the figures are a diagnostic of this machine at this moment. The deterministic properties (a bounded number of cells and of candidates per step) are asserted by scripts/check-tank-packing.js.
const SPARSE_RUNS = 5

const sparseTanks = () => [[1, 1, 1], ...Array.from({ length: 15 }, (_unused, index) => [600001 + 2 * index, 500000 + index, 500000 + index])].map(([litres, hs, cost], index) => ({ id: index + 1, name: `${litres} L`, sizeHS: hs / 1000, litres, cost: cost / 100, crew: 1 }))

const stepTimes = (generator) => {
  const times = []
  let done = false
  let last = null

  while (!done) {
    const start = performance.now()
    const step = generator.next()

    times.push(performance.now() - start)
    done = step.done
    last = step.value
  }

  return { times, last }
}

const spread = (times) => {
  const sorted = [...times].sort((a, b) => a - b)

  return { n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1] }
}

const printSpread = (label, runs) => {
  const line = (stats) => `${stats.n} steps, p50 ${fmt(stats.p50, 2)} p95 ${fmt(stats.p95, 2)} p99 ${fmt(stats.p99, 2)} max ${fmt(stats.max, 2)} ms`

  console.log(`  ${label}`)
  runs.forEach((times, index) => console.log(`    run ${index + 1}: ${line(spread(times))}`))
  console.log(`    all ${runs.length} runs: ${line(spread(runs.flat()))}; maxima per run ${runs.map((times) => fmt(Math.max(...times), 1)).join(' / ')} ms`)
}

const runSparseResponsiveness = (utilities) => {
  heading(`Sparse catalogue: step times over ${SPARSE_RUNS} cold runs (diagnostic, nothing asserted; the machine's other work shows in the maxima)`)

  const { packerFor } = utilities['tank-packing']
  const { searchPropulsion } = utilities['design-search']
  const tech = { engineTech: 10, fuelTech: 0.7, thermalTech: 1, thermalCost: 1, minThrust: 0.5, maxThrust: 1.5, maxSize: 12 }
  const warmRuns = []
  const searchRuns = []
  const sets = []

  for (let run = 0; run < SPARSE_RUNS; run++) {
    const tanks = sparseTanks()
    const warm = stepTimes(packerFor(tanks).warm())
    const searchTanks = sparseTanks()
    const search = stepTimes(searchPropulsion({ hullHS: 60, speed: 2500, goal: { mode: 'range', value: 2e9 }, tech, tanks: searchTanks, maxCount: 40, share: 0.6 }))

    warmRuns.push(warm.times)
    searchRuns.push(search.times)
    sets.push(search.last.sets.length)
  }

  printSpread('the warm generator (one packer per run, built before any request)', warmRuns)
  printSpread('the search steps (a cold packer per run; its first step warms the table)', searchRuns)
  check('every cold run of the sparse search finds sets, and the same number each time', sets.every((count) => count > 0 && count === sets[0]), `${sets.join(' / ')} sets`)
}

const main = async () => {
  const utilities = await loadUtilities(['design-data', 'design-rules', 'design-search', 'race-tech', 'tank-packing'])
  const packTanks = legacyPackTanks

  production = { ...utilities['tank-packing'], packTanks: utilities['design-rules'].packTanks }

  heading('Catalogues (every tank the race has researched, as loadFuelTanks reads it)')

  const catalogues = await loadRealCatalogues(utilities)

  catalogues.forEach(describeCatalogue)
  runOracleChecks(packTanks)
  runCatalogueSweeps(catalogues, packTanks)
  runSyntheticSweeps(packTanks)
  runLargeRequests(catalogues, packTanks)
  runFailureAnatomy(catalogues, packTanks)
  runTableBuild(catalogues)
  runPeriodic(catalogues)
  runDominance(catalogues)
  runStatusDemos(packTanks, catalogues)

  if (!options.skipSearch) {
    await runSearchBench(utilities, catalogues)
    runSparseResponsiveness(utilities)
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 2 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
