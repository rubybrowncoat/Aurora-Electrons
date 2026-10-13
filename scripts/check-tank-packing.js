/*
  Checks the fuel tank packing (src/renderer/utilities/tank-packing.js, through packTanks in design-rules.js and the propulsion search in design-search.js) against an exhaustive enumeration of every package, on the saves' tanks and on synthetic catalogues.

  Run from the repo root with Node 22.12 or newer: `node scripts/check-tank-packing.js [--quick] [--stock FILE GAME RACE] [--modded FILE GAME RACE]`. It only reads the saves (sqlite3 OPEN_READONLY); a save that is not there is skipped and the synthetic catalogues always run. Exit code 2 when a check fails.

  It proves, against the enumeration (the oracle below, written apart from the solver, on whole numbers: HS times 1,000, BP times 100): the lightest package (HS, then BP, then tanks) and the cheapest (BP, then HS, then tanks) are the enumeration's best on the stock tanks, the modded save's tanks and synthetic catalogues of one and of two densities, with and without a divisibility chain; the recorded counterexample (10 L/10 HS against two 6 L/3 HS tanks for 10 L) picks the two 6 L tanks; the nondominated set of HS, BP and litres held over the request equals the enumeration's; requests past the oracle's reach agree with the closed form of the stock catalogue (a mixed-radix count), with a table of another size, and with the package's own litres; every package holds its request within the named tolerance from the catalogue's own rows; an empty catalogue is infeasible for a positive request, a zero request is the empty package, and a package a bound cut short is feasible, not claimed optimal and not reported infeasible; and the propulsion search reports the status of each set's tanks, drops a candidate no tank can hold fuel for, and keeps its steps short.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const HS_SCALE = 1000
const COST_SCALE = 100
const ORACLE_LIMIT = 1.2e6

let failures = 0
let checks = 0

const options = (() => {
  const parsed = { quick: false, stock: { file: '../AuroraDB_271_skoormit_saved.db', game: 138, race: 785 }, modded: { file: 'AuroraDB.db', game: 140, race: 784 } }
  const argv = process.argv.slice(2)

  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]

    if (name === '--quick') {
      parsed.quick = true
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

const mulberry32 = (seed) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0

    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

// A read-only stand-in for the app's database object: `query(sql, { replacements })` resolves to [rows], as Sequelize's raw query does.
const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

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

// ---------- the oracle ----------

const rowsOf = (tanks) => tanks.map((tank) => ({ id: tank.id, litres: tank.litres, hs: Math.round(tank.sizeHS * HS_SCALE), cost: Math.round(tank.cost * COST_SCALE) }))

const KEYS = { lightest: ['hs', 'cost', 'count'], cheapest: ['cost', 'hs', 'count'] }

const beats = (a, b, keys) => {
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return a[key] < b[key]
    }
  }

  return false
}

// Calls `visit(totals)` for every package that holds `request` litres, over every count vector with at most ceil(request / litres) of each row (a package with more of one row holds the request in that row alone, and dropping a tank keeps it feasible at fewer HS). Null when the domain is past `limit`.
const enumerate = (rows, request, visit, limit = ORACLE_LIMIT) => {
  const caps = rows.map((row) => Math.ceil(request / row.litres))

  if (caps.reduce((domain, cap) => domain * (cap + 1), 1) > limit) {
    return null
  }

  const totals = { litres: 0, hs: 0, cost: 0, count: 0 }

  const walk = (index, litres, hs, cost, count) => {
    if (index === rows.length) {
      if (litres >= request) {
        totals.litres = litres
        totals.hs = hs
        totals.cost = cost
        totals.count = count
        visit(totals)
      }

      return
    }

    for (let each = 0; each <= caps[index]; each++) {
      walk(index + 1, litres + each * rows[index].litres, hs + each * rows[index].hs, cost + each * rows[index].cost, count + each)
    }
  }

  walk(0, 0, 0, 0, 0)

  return true
}

const oracleBest = (rows, request, objective) => {
  let best = null
  const complete = enumerate(rows, request, (totals) => {
    if (!best || beats(totals, best, KEYS[objective])) {
      best = { ...totals }
    }
  })

  return complete ? best : null
}

// The (HS, BP, litres over the request) vectors no package beats on all three, one each, as sorted text.
const oracleNondominated = (rows, request) => {
  const seen = new Map()
  const complete = enumerate(rows, request, (totals) => {
    const key = `${totals.hs}/${totals.cost}/${totals.litres - request}`

    if (!seen.has(key)) {
      seen.set(key, { hs: totals.hs, cost: totals.cost, excess: totals.litres - request })
    }
  })

  if (!complete) {
    return null
  }

  const all = [...seen.values()]

  return all.filter((a) => !all.some((b) => b !== a && b.hs <= a.hs && b.cost <= a.cost && b.excess <= a.excess)).map((vector) => `${vector.hs}/${vector.cost}/${vector.excess}`).sort()
}

// A package's figures on the same whole numbers as the oracle's, from its picks alone.
const totalsOf = (rows, pack) => {
  const byId = new Map(rows.map((row, index) => [row.id === undefined ? index : row.id, row]))

  return pack.picks.reduce((totals, pick) => {
    const row = byId.get(pick.id)

    return { litres: totals.litres + pick.count * row.litres, hs: totals.hs + pick.count * row.hs, cost: totals.cost + pick.count * row.cost, count: totals.count + pick.count }
  }, { litres: 0, hs: 0, cost: 0, count: 0 })
}

const sameKeys = (a, b, keys) => keys.every((key) => a[key] === b[key])

// ---------- catalogues ----------

// A catalogue from [litres, HS, BP] triples (HS and BP whole), as float tanks with ids: HS in thousandths and BP in hundredths, as the saves hold them.
const tanksOf = (triples) => triples.map(([litres, hs, cost], index) => ({ id: index + 1, name: `${litres} L`, sizeHS: hs / HS_SCALE, litres, cost: cost / COST_SCALE, crew: 1 }))

const pick = (rand, low, high) => low + Math.floor(rand() * (high - low + 1))

const FAMILIES = {
  free: (rand) => Array.from({ length: pick(rand, 2, 4) }, () => [pick(rand, 1, 30), pick(rand, 1, 30), pick(rand, 0, 30)]),
  twoDensities: (rand) => {
    const unit = pick(rand, 1, 5)

    return Array.from({ length: pick(rand, 3, 5) }, () => {
      const litres = unit * pick(rand, 1, 12)

      return rand() < 0.5 ? [litres, litres, pick(rand, 1, 20) + litres] : [litres * 2, litres, pick(rand, 1, 20) + litres * 2]
    })
  },
  canonical: (rand) => {
    const sizes = [1]

    for (let step = pick(rand, 1, 3); step > 0; step--) {
      sizes.push(sizes[sizes.length - 1] * pick(rand, 2, 5))
    }

    return sizes.map((hs, index) => [hs * 10, hs, Math.max(1, Math.round(hs * 4 / (1 + index)))])
  },
  chainBroken: (rand) => {
    const base = pick(rand, 2, 6)

    return [[base * 7, base * 7, 5 * base], [base * 3, base * 3, 3 * base], [base * 2, base * 2, 2 * base]].slice(0, pick(rand, 2, 3))
  },
}

const requestList = (rand, count, high) => Array.from({ length: count }, () => pick(rand, 1, high))

// ---------- checks ----------

const checkCounterexample = (packTanks) => {
  heading('The recorded counterexample and the tie-breaks')

  let right = 0
  let total = 0

  for (const costs of [[1, 1, 1], [4, 2, 1], [1, 9, 1], [10, 3, 1], [2, 2, 2], [4, 3, 2]]) {
    const tanks = tanksOf([[10, 10, costs[0]], [6, 3, costs[1]], [1, 1, costs[2]]])
    const pack = packTanks({ litres: 10, tanks })
    const counts = Object.fromEntries(pack.picks.map((tank) => [tank.litres, tank.count]))

    total++

    if (pack.status === 'optimal' && pack.complete && pack.feasible && counts[6] === 2 && pack.picks.length === 1 && Math.abs(pack.sizeHS - 0.006) < 1e-12 && pack.litres === 12 && pack.excessLitres === 2) {
      right++
    }
  }

  check('10 L over 10 L/10 HS, 6 L/3 HS and 1 L/1 HS: two 6 L tanks (6 HS), not the 10 L tank, for every BP tried', right === total, `${right}/${total}`)

  const tie = (triples, request, objective, counts) => {
    const pack = packTanks({ litres: request, tanks: tanksOf(triples), objective })

    return triples.every((_triple, index) => ((pack.picks.find((tank) => tank.id === index + 1) || {}).count || 0) === counts[index])
  }

  check('an HS tie goes to the lower BP', tie([[4, 2, 7], [2, 1, 3]], 4, 'lightest', [0, 2]))
  check('an HS and BP tie goes to the fewer tanks', tie([[4, 2, 6], [2, 1, 3]], 4, 'lightest', [1, 0]))
  check('the cheapest package takes the fewer BP over the fewer HS', tie([[10, 10, 1], [6, 3, 9], [1, 1, 1]], 10, 'cheapest', [1, 0, 0]))
  check('the cheapest package breaks a BP tie on HS', tie([[5, 2, 5], [5, 3, 5]], 5, 'cheapest', [1, 0]))
}

const sweep = (label, tanks, requests, packTanks, { high }) => {
  const rows = rowsOf(tanks)
  let compared = 0
  let skipped = 0
  let wrong = 0
  let sample = ''
  let notOptimal = 0
  let notHeld = 0
  let foreign = 0
  const ids = new Set(tanks.map((tank) => tank.id))

  for (const objective of ['lightest', 'cheapest']) {
    for (const request of requests) {
      const best = oracleBest(rows, request, objective)

      if (!best) {
        skipped++

        continue
      }

      const pack = packTanks({ litres: request, tanks, objective })
      const got = totalsOf(rows, pack)

      compared++

      if (pack.status !== 'optimal' || !pack.complete) {
        notOptimal++
      }

      if (!pack.feasible || pack.litres < request * (1 - 1e-9) || got.litres !== pack.litres) {
        notHeld++
      }

      if (!pack.picks.every((tank) => ids.has(tank.id) && tank.count > 0)) {
        foreign++
      }

      if (!sameKeys(got, best, KEYS[objective]) || pack.sizeHS * HS_SCALE !== got.hs || Math.abs(pack.cost * COST_SCALE - got.cost) > 1e-6 || pack.count !== got.count) {
        wrong++
        sample = sample || `${objective} ${request} L: got HS ${got.hs} BP ${got.cost} x${got.count}, enumeration HS ${best.hs} BP ${best.cost} x${best.count}`
      }
    }
  }

  check(`${label}: lightest and cheapest packages equal the enumeration on every request`, compared > 0 && wrong === 0 && notOptimal === 0 && notHeld === 0 && foreign === 0, `${compared} compared up to ${high} L, ${skipped} past the enumeration${sample ? `, first difference ${sample}` : ''}`)
}

const syntheticSweeps = (packTanks) => {
  heading('Synthetic catalogues against the enumeration')

  const catalogues = options.quick ? 25 : 80

  for (const [family, make] of Object.entries(FAMILIES)) {
    const rand = mulberry32(5000 + family.length)
    let compared = 0
    let wrong = 0
    let notOptimal = 0
    let notHeld = 0
    let sample = ''

    for (let index = 0; index < catalogues; index++) {
      const triples = make(rand)
      const tanks = tanksOf(triples)
      const rows = rowsOf(tanks)

      for (const objective of ['lightest', 'cheapest']) {
        for (const request of [...requestList(rand, 14, 60), 1, 2, 7]) {
          const best = oracleBest(rows, request, objective)
          const pack = packTanks({ litres: request, tanks, objective })
          const got = totalsOf(rows, pack)

          compared++

          if (pack.status !== 'optimal' || !pack.complete) {
            notOptimal++
          }

          if (!pack.feasible || pack.litres < request * (1 - 1e-9)) {
            notHeld++
          }

          if (!sameKeys(got, best, KEYS[objective])) {
            wrong++
            sample = sample || `${JSON.stringify(triples)} ${objective} ${request} L`
          }
        }
      }
    }

    check(`family ${family}: ${catalogues} catalogues, packages equal the enumeration`, wrong === 0 && notOptimal === 0 && notHeld === 0, `${compared} cases${sample ? `, first difference ${sample}` : ''}`)
  }
}

const nondominatedChecks = (packerFor) => {
  heading('Nondominated packages: HS, BP and litres held over the request')

  const counter = tanksOf([[10, 10, 100], [6, 3, 900], [1, 1, 100]])
  const rows = rowsOf(counter)
  const vectors = (result) => result.packages.map((pack) => `${Math.round(pack.sizeHS * HS_SCALE)}/${Math.round(pack.cost * COST_SCALE)}/${pack.excessLitres}`).sort()
  const result = packerFor(counter).nondominated(10)

  check('the recorded counterexample at BP 1/9/1: 6 HS (2 L over), 7 HS and 10 HS are the trade-offs, all proved', result.status === 'optimal' && result.complete && sameKeys({ v: vectors(result).join() }, { v: oracleNondominated(rows, 10).join() }, ['v']) && vectors(result).length === 3, vectors(result).join(' | '))

  const rand = mulberry32(99)
  let compared = 0
  let wrong = 0
  let sample = ''

  for (const make of Object.values(FAMILIES)) {
    for (let index = 0; index < (options.quick ? 10 : 25); index++) {
      const tanks = tanksOf(make(rand))

      for (const request of requestList(rand, 6, 50)) {
        const expected = oracleNondominated(rowsOf(tanks), request)
        const got = packerFor(tanks).nondominated(request)

        compared++

        if (got.status !== 'optimal' || got.packages.some((pack) => !pack.feasible || pack.litres < request) || vectors(got).join() !== expected.join()) {
          wrong++
          sample = sample || `${JSON.stringify(tanks.map((tank) => [tank.litres, tank.sizeHS * HS_SCALE, tank.cost * COST_SCALE]))} ${request} L`
        }
      }
    }
  }

  check('the nondominated set equals the enumeration on synthetic catalogues', wrong === 0, `${compared} cases${sample ? `, first difference ${sample}` : ''}`)

  const bounded = packerFor(tanksOf([[1, 1, 1], [3, 2, 1]])).nondominated(1000, { maxEntries: 5 })

  check('a set whose trade-offs pass the bound is bound-exhausted with no package, not an empty optimal set', bounded.status === 'bound-exhausted' && !bounded.complete && bounded.packages.length === 0 && bounded.reason === 'frontier-bound', `${bounded.status} ${bounded.reason}`)
}

const largeRequests = (label, tanks, createTankPacker, { stockClosedForm = false }) => {
  const rows = rowsOf(tanks)
  const packer = createTankPacker(tanks)
  const small = createTankPacker(tanks, { maxUnits: 6000 })
  const rand = mulberry32(4242)
  const count = options.quick ? 600 : 3000
  let wrong = 0
  let notProved = 0
  let compared = 0
  let smallProved = 0
  let different = 0

  for (let index = 0; index < count; index++) {
    const request = Math.ceil(Math.exp(Math.log(1e3) + rand() * (Math.log(stockClosedForm ? 1e11 : 1e9) - Math.log(1e3))))
    const pack = packer.pack(request)
    const got = totalsOf(rows, pack)
    const other = small.pack(request)

    if (pack.status !== 'optimal' || pack.litres < request * (1 - 1e-9)) {
      notProved++

      continue
    }

    compared++

    if (other.status === 'optimal') {
      smallProved++

      if (!sameKeys(totalsOf(rows, other), got, KEYS.lightest)) {
        different++
      }
    }

    if (stockClosedForm) {
      const unitsOfHundred = Math.ceil(request * (1 - 1e-9) / 100)
      let rest = unitsOfHundred * 100
      const expected = new Map()

      for (const row of [...rows].sort((a, b) => b.litres - a.litres)) {
        expected.set(row.id, Math.floor(rest / row.litres))
        rest %= row.litres
      }

      if (!pack.picks.every((tank) => expected.get(tank.id) === tank.count) || pack.picks.length !== [...expected.values()].filter(Boolean).length || got.hs !== unitsOfHundred * 2) {
        wrong++
      }
    }
  }

  check(`${label}: ${count} requests of 1e3 to ${stockClosedForm ? '1e11' : '1e9'} L are proved and hold their litres`, notProved === 0, `${notProved} not proved`)
  check(`${label}: a table of 6000 units agrees with the default one wherever it proves its answer`, different === 0 && smallProved > 0, `${smallProved} proved by the small table, ${different} different`)

  if (stockClosedForm) {
    check(`${label}: packages equal the closed form (0.002 HS per started 100 L, the mixed-radix count of tanks)`, wrong === 0, `${compared} requests, ${wrong} different`)
  }
}

const statusChecks = (packTanks, createTankPacker) => {
  heading('Status, zero demand, empty catalogue and bounds')

  const tanks = tanksOf([[10, 10, 10], [6, 3, 6], [1, 1, 1]])
  const empty = packTanks({ litres: 10, tanks: [] })
  const none = packTanks({ litres: 0, tanks: [] })
  const zero = packTanks({ litres: 0, tanks })
  const invalid = [-1, NaN, undefined, null, '5', {}].map((litres) => packTanks({ litres, tanks }))
  const endless = packTanks({ litres: Infinity, tanks })

  check('an empty catalogue is infeasible for a positive request, with no tanks and a stated reason', empty.status === 'infeasible' && empty.complete && !empty.feasible && empty.picks.length === 0 && empty.reason === 'no-usable-tank', `${empty.status} ${empty.reason}`)
  check('a zero request is the empty package, feasible and optimal, even from an empty catalogue', zero.status === 'optimal' && zero.feasible && zero.picks.length === 0 && zero.litres === 0 && none.status === 'optimal' && none.feasible)
  check('a negative, missing or not-a-number request is infeasible, not a package', invalid.every((pack) => pack.status === 'infeasible' && !pack.feasible && pack.reason === 'invalid-request'))
  check('an endless request is infeasible', endless.status === 'infeasible' && !endless.feasible)

  const thin = packTanks({ litres: 1, tanks: [{ id: 1, name: 'Thin', sizeHS: 1, litres: 0.9999999, cost: 1 }] })
  const heavier = packTanks({ litres: 10, tanks: [{ id: 1, name: 'Heavier', sizeHS: 1.0000005, litres: 10, cost: 1 }, { id: 2, name: 'Lighter', sizeHS: 1, litres: 10, cost: 1 }] })
  const dearer = packTanks({ litres: 10, tanks: [{ id: 1, name: 'Dearer', sizeHS: 1, litres: 10, cost: 1.0000005 }, { id: 2, name: 'Cheaper', sizeHS: 1, litres: 10, cost: 1 }] })
  const stored = packTanks({ litres: 10, tanks: [{ id: 1, name: 'Stored', sizeHS: 0.002, litres: 100, cost: 0.08 }, { id: 2, name: 'Odd', sizeHS: 0.001, litres: 10, cost: 0.03 }] })

  check('a tank figure the whole-number scale would round (0.9999999 L) is not claimed optimal: its package is bound-exhausted and holds the request from the unrounded litres', thin.status === 'bound-exhausted' && thin.reason === 'catalogue-not-whole' && thin.feasible && thin.litres >= 1 * (1 - 1e-9) && thin.count === 2 && thin.litres === 2 * 0.9999999, `${thin.status} ${thin.reason} ${thin.litres} L in ${thin.count}`)
  check('HS figures 1.0000005 and 1 are not rounded together: the lighter tank is picked and the package says 1 HS, not optimal', heavier.status === 'bound-exhausted' && heavier.picks.length === 1 && heavier.picks[0].id === 2 && heavier.sizeHS === 1, `${heavier.status} picks ${heavier.picks.map((tank) => tank.id)} ${heavier.sizeHS} HS`)
  check('BP figures 1.0000005 and 1 are not rounded together: the cheaper tank is picked and the package says 1 BP, not optimal', dearer.status === 'bound-exhausted' && dearer.picks.length === 1 && dearer.picks[0].id === 2 && dearer.cost === 1, `${dearer.status} picks ${dearer.picks.map((tank) => tank.id)} ${dearer.cost} BP`)
  check('figures stored as decimals (0.002 HS, 0.08 BP) are whole at their scale and stay exact', stored.status === 'optimal' && stored.sizeHS === 0.001 && stored.cost === 0.03, `${stored.status} ${stored.sizeHS} HS ${stored.cost} BP`)

  const odd = [{ id: 1, name: 'Third', sizeHS: 1 / 3, litres: 11, cost: 1 }]
  const huge = packTanks({ litres: 1000000000000001000, tanks: odd })
  const hugeWhole = packTanks({ litres: 1e300, tanks })

  check('a request that needs more tanks than a float counts exactly ends at once: bound-exhausted, request-too-large, no package, for a catalogue that is not whole and for one that is', huge.status === 'bound-exhausted' && huge.reason === 'request-too-large' && !huge.feasible && hugeWhole.reason === 'request-too-large' && !hugeWhole.feasible, `${huge.reason} / ${hugeWhole.reason}`)

  const unknown = packTanks({ litres: 10, tanks: [{ id: 1, name: 'No cost', sizeHS: 1, litres: 10, cost: null }, { id: 2, name: 'No litres', sizeHS: 1, litres: null, cost: 1 }, { id: 3, name: 'No size', sizeHS: null, litres: 5, cost: 1 }] })
  const packer = createTankPacker([{ id: 1, name: 'No cost', sizeHS: 1, litres: 10, cost: null }, ...tanks])

  check('tanks lacking litres, size or cost are left out, not counted as zero, and named', unknown.status === 'infeasible' && unknown.reason === 'no-usable-tank' && packer.catalogue.excluded.length === 1 && packer.catalogue.excluded[0].missing === 'cost' && packer.pack(10).picks.every((tank) => tank.id !== 1))

  const capped = createTankPacker(tanksOf([[10, 10, 10], [7, 3, 5]]), { maxUnits: 100 })
  const far = capped.pack(1e6)

  check('a request past a table that proves no repeating pattern is feasible, bound-exhausted and never optimal', far.feasible && far.status === 'bound-exhausted' && !far.complete && far.litres >= 1e6 * (1 - 1e-9) && far.reason === 'table-cap' && far.picks.length > 0, `${far.status} ${far.reason}`)

  const fine = packTanks({ litres: 10, tanks: [{ id: 1, name: 'A', sizeHS: 1 / 3, litres: 10, cost: 1 }, { id: 2, name: 'B', sizeHS: 0.5, litres: 7, cost: 1 }] })

  check('a catalogue whose figures are not whole numbers gives a feasible package that is bound-exhausted, not optimal', fine.feasible && fine.status === 'bound-exhausted' && fine.reason === 'catalogue-not-whole' && fine.litres >= 10 && !fine.complete, `${fine.status} ${fine.reason}`)

  let thrown = false

  try {
    packTanks({ litres: 10, tanks, objective: 'smallest' })
  } catch (error) {
    thrown = true
  }

  check('an unknown objective is refused', thrown)

  const exact = packTanks({ litres: 100, tanks: tanksOf([[100, 1, 1]]) })
  const above = packTanks({ litres: 100 + 1e-5, tanks: tanksOf([[100, 1, 1]]) })
  const within = packTanks({ litres: 100 + 5e-11, tanks: tanksOf([[100, 1, 1]]) })

  check('the request tolerance is the one the search uses: a request within 1e-9 of 100 L is held by one 100 L tank, one a little above takes two', exact.count === 1 && within.count === 1 && above.count === 2)

  const crewless = packTanks({ litres: 10, tanks: [{ id: 1, name: 'A', sizeHS: 1, litres: 10, cost: 1, crew: null }] })
  const crewed = packTanks({ litres: 25, tanks: [{ id: 1, name: 'A', sizeHS: 1, litres: 10, cost: 1, crew: 2 }] })

  check('crew is the tanks\' crew summed, and null when a tank\'s crew is unknown', crewless.crew === null && crewed.crew === 6 && crewed.count === 3)
}

const searchChecks = async (utilities, saves) => {
  heading('The propulsion search with the packages')

  const { packerFor } = utilities['tank-packing']
  const { searchPropulsion } = utilities['design-search']
  const { packTanks, meetsRequest, createTankPacker, tankPackageResult } = utilities['design-rules']
  const { STATUS } = utilities.provenance

  const search = (input) => {
    const iterator = searchPropulsion(input)
    const packer = packerFor(input.tanks)
    let yields = 0
    let maxStepCandidates = 0
    let evaluated = 0
    let firstEvaluated = null
    let firstBuilt = null
    let step = iterator.next()

    while (!step.done) {
      if (firstEvaluated === null) {
        firstEvaluated = step.value.evaluated
        firstBuilt = packer.built()
      }

      maxStepCandidates = Math.max(maxStepCandidates, step.value.evaluated - evaluated)
      evaluated = step.value.evaluated
      yields++
      step = iterator.next()
    }

    return { result: step.value, yields, maxStepCandidates, firstEvaluated: firstEvaluated === null ? 0 : firstEvaluated, firstBuilt: firstBuilt === null ? 0 : firstBuilt }
  }

  const SEARCH_SLICE = 2000

  const tech = { engineTech: 10, fuelTech: 0.7, thermalTech: 1, thermalCost: 1, minThrust: 0.5, maxThrust: 1.5, maxSize: 12 }

  for (const save of saves) {
    const input = { hullHS: 60, speed: 2500, goal: { mode: 'range', value: 2e9 }, tech, tanks: save.tanks, maxCount: 40, share: 0.6, slice: SEARCH_SLICE }
    const timed = search({ ...input, tanks: [...save.tanks] })
    const { result } = timed
    const stale = search({ ...input, tanks: [...save.tanks], goal: { mode: 'endurance', value: 120 }, fraction: 0.5 })

    check(`${save.label}: the search ranks sets, every set's tanks hold its fuel, and each says whether they are proved`, result.sets.length > 0 && result.sets.every((set) => set.tankPackage && set.tankPackage.status === 'optimal' && set.litres >= set.tankPackage.requestedLitres * (1 - 1e-9) && set.tanks.length > 0 && set.tanks.every((tank) => save.tanks.some((row) => row.id === tank.id))) && result.packages.boundExhausted === 0, `${result.sets.length} sets of ${result.matched} matched, packages ${JSON.stringify(result.packages)}`)

    const lightestTanks = result.sets.every((set) => {
      const again = packTanks({ litres: set.tankPackage.requestedLitres, tanks: save.tanks })

      return again.sizeHS === set.tankHS && again.cost <= set.tanks.reduce((cost, tank) => cost + tank.cost * tank.count, 0) + 1e-9
    })

    check(`${save.label}: each set's tanks are the lightest package for the litres it asked for`, lightestTanks)
    check(`${save.label}: an endurance search packs the same way`, stale.result.sets.length > 0 && stale.result.sets.every((set) => set.tankPackage.status === 'optimal' && meetsRequest(set.litres, set.tankPackage.requestedLitres)) && stale.result.packages.infeasible === 0)
    check(`${save.label}: no step of the search evaluates more candidates than its slice, and the first one only warms the tables`, [timed, stale].every((run) => run.firstEvaluated === 0 && run.maxStepCandidates <= SEARCH_SLICE), `at most ${timed.maxStepCandidates} and ${stale.maxStepCandidates} candidates in a step over ${timed.yields} and ${stale.yields} yields`)

    const lightest = result.sets[0]
    const provenance = tankPackageResult(packTanks({ litres: lightest.tankPackage.requestedLitres, tanks: save.tanks }))

    check(`${save.label}: a proved package is a result of design.packTanks at the planner's-policy status`, provenance.status === STATUS.ASSUMED && provenance.rule.id === 'design.packTanks' && provenance.value === lightest.tankHS)
  }

  const none = search({ hullHS: 60, speed: 2500, goal: { mode: 'range', value: 2e9 }, tech, tanks: [], maxCount: 40, share: 0.6 })

  check('a fuel target with no tanks to pack is infeasible for every candidate: no sets, no repeated packing passes', none.result.sets.length === 0 && none.result.packages.infeasible > 0 && none.result.matched === 0, `${JSON.stringify(none.result.packages)}, ${none.result.evaluated} candidates`)

  const noFuel = search({ hullHS: 60, speed: 2500, tech, tanks: saves[0].tanks, maxCount: 40, share: 0.6 })

  check('a search with no fuel target packs nothing: sets carry no tanks and no package status', noFuel.result.sets.length > 0 && noFuel.result.sets.every((set) => set.tanks.length === 0 && set.tankPackage === null))

  const stuck = createTankPacker(tanksOf([[10, 10, 10], [7, 3, 5]]), { maxUnits: 100 }).pack(1e6)

  check('the package result of a bound-exhausted package is estimated, not the planner\'s-policy status', tankPackageResult(stuck).status === STATUS.ESTIMATED && tankPackageResult(packTanks({ litres: 10, tanks: [] })).status === STATUS.UNAVAILABLE)

  const sparseTanks = () => tanksOf([[1, 1, 1], ...Array.from({ length: 15 }, (_unused, index) => [600001 + 2 * index, 500000 + index, 500000 + index])])
  const sparsePacker = createTankPacker(sparseTanks())
  const coldPacker = createTankPacker(sparseTanks())
  const { warmCells, maxUnits } = sparsePacker.catalogue
  const warming = sparsePacker.warm()
  const untouched = sparsePacker.built() === 0
  const warmBuilt = []

  for (let step = warming.next(); !step.done; step = warming.next()) {
    warmBuilt.push(sparsePacker.built())
  }

  const warmDeltas = warmBuilt.map((built, index) => built - (index ? warmBuilt[index - 1] : 0))
  const bytesWarm = sparsePacker.bytes()
  const builtWarm = sparsePacker.built()
  const first = sparsePacker.pack(900000)
  const requests = [1, 10, 5e4, 3e5, 7e5, 9e5, 1.5e6, 5e6, 2e7]
  const countsOf = (pack) => pack.picks.map((tank) => `${tank.id}x${tank.count}`).join()
  const sameAsCold = requests.every((request) => countsOf(sparsePacker.pack(request)) === countsOf(coldPacker.pack(request)) && sparsePacker.pack(request).status === coldPacker.pack(request).status)

  check('a sparse catalogue (one 1 L tank and tanks of about 600,000 L, so no repeating pattern is proved below the cap) is warmed in bounded steps: nothing is built before the first step, no step builds more than catalogue.warmCells cells, and the whole bounded table is built at the end', untouched && warmCells > 0 && warmBuilt.length > 1 && Math.max(...warmDeltas) <= warmCells && builtWarm === maxUnits, `${warmBuilt.length} steps, at most ${Math.max(...warmDeltas)} of ${warmCells} cells a step, ${builtWarm} of ${maxUnits} cells built`)
  check('after warming, the first request neither builds a cell nor grows or reallocates the table: the cells built and the table bytes are the same after pack(900000)', first.feasible && first.status === 'optimal' && sparsePacker.built() === builtWarm && sparsePacker.bytes() === bytesWarm, `${first.status}, ${sparsePacker.bytes()} bytes, ${sparsePacker.built()} cells`)
  check('a warmed packer answers exactly as a packer that builds its table on demand, over requests below and above the table', sameAsCold, `${requests.length} requests`)

  const stockLike = tanksOf([[5000000, 100000, 2500], [1000000, 20000, 1000], [100, 2, 1]])
  const interrupted = createTankPacker(stockLike)
  const reference = createTankPacker(stockLike)
  const partial = interrupted.warm()

  partial.next()
  partial.next()

  const midway = interrupted.built()
  const resumed = interrupted.warm()

  while (!resumed.next().done) {
    // the second generator carries on where the abandoned one stopped
  }

  const abandoned = createTankPacker(sparseTanks())
  const dropped = abandoned.warm()

  for (let step = 0; step < 3; step++) {
    dropped.next()
  }

  check('abandoning a warm half way costs nothing: the packer still answers exactly as one never warmed, and a second warm completes the same table', midway > 0 && midway < interrupted.built() && [1e3, 123456, 9e7, 3e11].every((request) => countsOf(interrupted.pack(request)) === countsOf(reference.pack(request))) && countsOf(abandoned.pack(900000)) === countsOf(coldPacker.pack(900000)) && abandoned.pack(900000).status === 'optimal', `${midway} cells after two steps of the abandoned warm`)

  const sparseInput = (tanks) => ({ hullHS: 60, speed: 2500, goal: { mode: 'range', value: 2e9 }, tech, tanks, maxCount: 40, share: 0.6, slice: SEARCH_SLICE })
  const sparseSearchTanks = sparseTanks()
  const sparseRun = search(sparseInput(sparseSearchTanks))
  const summary = (run) => JSON.stringify({ evaluated: run.result.evaluated, matched: run.result.matched, packages: run.result.packages, sets: run.result.sets.map((set) => [set.engine.sizeHS, set.engine.thrust, set.count, set.tankHS, set.litres, set.cost, set.tanks.map((tank) => `${tank.id}x${tank.count}`)]) })
  const sparseBuiltAtEnd = packerFor(sparseSearchTanks).built()

  check('the search of a sparse catalogue yields before it evaluates anything (the first step warms, building at most catalogue.warmCells cells), and no step evaluates more candidates than its slice', sparseRun.firstEvaluated === 0 && sparseRun.firstBuilt <= warmCells && sparseRun.maxStepCandidates <= SEARCH_SLICE && sparseBuiltAtEnd === maxUnits, `first step: ${sparseRun.firstBuilt} cells built, ${sparseRun.firstEvaluated} candidates; at most ${sparseRun.maxStepCandidates} of ${SEARCH_SLICE} candidates in a step over ${sparseRun.yields} yields`)
  check('the search of a sparse catalogue finds sets whose packages are all proved and hold their litres', sparseRun.result.sets.length > 0 && sparseRun.result.packages.boundExhausted === 0 && sparseRun.result.sets.every((set) => set.tankPackage.status === 'optimal' && meetsRequest(set.litres, set.tankPackage.requestedLitres)), `${sparseRun.result.sets.length} sets, packages ${JSON.stringify(sparseRun.result.packages)}`)

  const cancelTanks = sparseTanks()
  const cancelled = searchPropulsion(sparseInput(cancelTanks))

  for (let step = 0; step < 5; step++) {
    cancelled.next()
  }

  check('a search abandoned after five steps leaves the next search of the same tanks unchanged: it returns what a search from a fresh array returns', summary(search(sparseInput(cancelTanks))) === summary(sparseRun))

  console.log('  step times are not asserted here; scripts/bench-tank-packing.js reports them over a fixed number of cold runs')
}

// ---------- main ----------

const run = async () => {
  const utilities = await loadUtilities(['design-data', 'design-rules', 'design-search', 'tank-packing', 'provenance'])
  const { packTanks } = utilities['design-rules']
  const { createTankPacker, packerFor } = utilities['tank-packing']
  const data = utilities['design-data']
  const saves = []

  checkCounterexample(packTanks)
  syntheticSweeps(packTanks)
  nondominatedChecks(packerFor)
  statusChecks(packTanks, createTankPacker)

  for (const [label, { file, game, race }] of [['stock', options.stock], ['modded', options.modded]]) {
    const database = await openSave(file)

    if (!database) {
      console.log(`\nSKIP  ${label}: ${file} is not there`)

      continue
    }

    heading(`${label} save: ${database.file}, game ${game}, race ${race}`)

    const tanks = await data.loadStockTanks(database, { GameID: game, RaceID: race })
    const rand = mulberry32(game)
    const dense = []

    for (let request = 1; request <= (options.quick ? 700 : 1200); request += options.quick ? 17 : 7) {
      dense.push(request)
    }

    console.log(`  ${tanks.length} tanks: ${tanks.map((tank) => `${tank.litres} L/${tank.sizeHS} HS/${tank.cost} BP`).join(', ')}`)
    check(`${label}: every tank has whole litres, HS in thousandths and BP in hundredths`, tanks.every((tank) => Number.isInteger(tank.litres) && Math.abs(tank.sizeHS * HS_SCALE - Math.round(tank.sizeHS * HS_SCALE)) < 1e-6 && Math.abs(tank.cost * COST_SCALE - Math.round(tank.cost * COST_SCALE)) < 1e-6))

    sweep(label, tanks, [...dense, ...requestList(rand, options.quick ? 40 : 150, 40000)], packTanks, { high: 40000 })
    largeRequests(label, tanks, createTankPacker, { stockClosedForm: label === 'stock' })
    saves.push({ label, tanks })
    database.close()
  }

  if (saves.length) {
    await searchChecks(utilities, saves)
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 2 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
