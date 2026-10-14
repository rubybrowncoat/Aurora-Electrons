/*
  Checks what the Production page and the Mineral Outlook assume about the game's industrial production cycle, against a reference model of the cycle and the ledger a save holds, read-only.

  node scripts/check-production-cycle.js [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784) and the stock 2.7.1 save one folder up (AuroraDB_271_skoormit_saved.db, game 138, race 785).

  The reference model is the game's rule for one colony's construction cycle, written out here from the rule and not from the app: each project that is out of the queue and not paused, in some order, is allocated its share of the colony's capacity times the years since the last cycle, builds that many units (the allocation over the build points a unit takes, at most the units it has left), cuts the build to what the colony's stock of each mineral covers (the stock the projects ahead of it left, in tonnes and fractions of a unit, the build rounded to 4 decimals), takes the minerals of what it built out of that stock, and adds the build to its partial completion, whole units delivered at once. A project that finishes lets the queued ones start in the next cycle.

  Worked cases on synthetic rows (labelled so) pin the arithmetic where the saves hold no case: a stock that two jobs share is debited in sequence, the order sets who gets what and not how much is used, a stock that covers each job alone does not cover both, and a promoted project builds a cycle after its predecessor finished. The saves hold no colony whose stock limited a project in its last cycle, so a shortage inside the cycle is checked on the synthetic case only and the saves report it as UNSUPPORTED.

  What the saves do show, for the last production cycle of the race (the ledger's last production time; the cycle before it gives the years it covered):
  - the stock a colony held before the cycle is the one its `Last<Mineral>` columns keep: the stock now less the ledger's flows of that cycle gives it back exactly, except where a mass driver export colony's mining is not logged (reported UNSUPPORTED, never counted as agreement);
  - the ledger's use of a mineral by a project that is alone in its use type at the colony is its per-unit need times one build, the same build for every mineral it needs;
  - that build is the colony's capacity times the project's share times the years of the cycle: the app's `production.populationCapacity` (the post-cycle saved state) against it, a build under 0.02 unit too coarse to resolve (the game rounds to 4 decimals) and left out, and two projects of one colony both measure the same capacity (shared capacity, the share is what divides it);
  - units left plus partial completion is a whole number, the partial completion being what the next unit has already had;
  - no colony's stock fell short of what the projects took in the cycle.
  Whether a project's units arrive in the cycle they are built is not in the saves; neither is the order the game visits the projects in (the project table's key is its row id, so the stored order is the project ID's, whatever the order in the game was).

  Every check that rests on what a save holds runs only when the save holds a case for it (a nonempty set of colonies or projects); otherwise it prints UNSUPPORTED and is in neither the passes nor the failures. Two cases beyond the one cycle: the saved colonies whose running projects share a mineral are run forward from today's stock, with no income, in every order of their projects (finish cycles in each order, and the tonnes the finished jobs need against the stock), and a queue of three 100% jobs shows how the app's continuous dates drift from the reference model's cycle dates as the queue deepens.

  The mutants are copies of the model or of the replay with one thing changed; each must fail the check named with it.

  The page's forecast runs on the cycle engine (utilities/industry-cycle.js), loaded here as it ships, on exact decimal arithmetic (utilities/decimal.js) in the game's order of operations, with no tolerance: a build is cut by any strict shortfall of stock and a project completes only when its build is exactly what it had left. It is checked on five sides. Its cases on synthetic colonies are set against the reference model above where the model has the case (a shared stock debited in sequence, arrivals, the queue and its fit, the 4-decimal rounding), against a ledger oracle that shares nothing with the engine (exact fractions of BigInts from decimal texts: the stock a project leaves after a subtraction of large numbers, a remainder either side of the last unit, a build cut to a stock short by a part of a large request, two builds each just under a midpoint, exact and near midpoints of the rounding, steady stretches taken in one step against one cycle at a time), the decimal type against the same oracle (rounding of ties, a read to 15 digits, division and multiplication to 28 digits and 96 bits) and against exact figures where there is no model (a paused share, a conversion's source installations, the fuel limit, the arrival cycle, partial units reconciling). The page's wrapper (production.industryForecast) is called on synthetic rows for what it hands the page and what it declines to forecast. On each save the engine runs the colonies the forward run above covers and must give the reference model's finish cycles and its verdict on whether the order of the projects matters, its one cycle from the stock before the last cycle is set against the ledger's builds, and the page's own read of the projects feeds the wrapper for every colony (a colony it cannot forecast is reported UNSUPPORTED and keeps the per-project check). The legacy lines marked DIVERGES concern that fallback path, the continuous schedule and the per-project stock check, which the page keeps only for such colonies.

  The engine mutants load a temp copy of industry-cycle.js, decimal.js and search-run.js with one line changed in one of the first two (a change that does not match exactly once is an error) and run the engine's cases again; each must fail the case named with it.

  The decimal type's read of a number from the save is the platform's own double-to-decimal conversion (15 significant digits, rounded half to even on the exact value of the double, with the scale the exponent gives), checked against scripts/lib/native-decimal-reads.json: the platform's reads of 4063 doubles, boundary values and powers of two among them. The years of a cycle go through a double with the platform's own decimal-to-double conversion (`toDouble`, which differs in the last digit from the correctly rounded `toNumber` for some values), checked against scripts/lib/native-years.json: the platform's years for 10000 cycle lengths, 609 others and 2402 decimals, with a cycle of 73 s followed through to a finish date. A stretch of cycles taken in one step is taken only while every addition of the game is exact, which `additions` counts and a brute-force oracle checks, and only until the first cycle at which the unrounded mineral check would cut the build; the stretch is compared with the same colony run cycle by cycle (the cap, fuel and source-installation cases, and a project that resupply finishes exactly is not flagged as a fine remainder). The share the running and paused projects of a kind hold is kept as a running total only where the type adds the kind's shares exactly in any order, and otherwise added up again in the game's order (a four-project case with the platform's own sum pins it). The engine yields wherever the pace says the time of a slice is up (at the start of every cycle or stretch, between one project's turn and the next, in the working out and the applying of a stretch and in the contention scan, and between the minerals of a stretch), and its cases check where: by the yields of a pace always up, and, for colonies of 1000 projects (finishing together, or taking a stretch of eleven minerals each) and of 100 in contention, by the operations of the decimal type between two yields and in all (the engine's decimal module is loaded as a copy that counts them), never by time. Each order's run is folded into the figures as it ends and let go: the fold is checked against the least, most, any and every over the whole list of runs, and the runs whose states are still held at the end are counted. The page runs the forecast of its colonies as a sliced run of its own (kind production-forecast); its cases cover the Forecasting status (a known paused project keeps its Paused status while the run is pending), a run replaced while it ran, a run that fails and a quantity the decimal type cannot hold.
*/
const path = require('path')
const fs = require('fs')
const os = require('os')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const DEFAULT_SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: '../AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const SECONDS_PER_YEAR = 365 * 86400
const CLOSURE_TOLERANCE = 1e-6
const CLOSURE_SHARE = 0.95
const WHOLE_SHARE = 0.95
const BUILD_FLOOR = 0.02
const CAPACITY_TOLERANCE = 0.005
const MUTATED_CHECK = 'the colony\'s capacity times the project\'s share times the years since the last cycle is the build the ledger shows (within 0.5%) for most resolvable projects'
const MAX_ORDER_JOBS = 5
const ORDER_HORIZON = 3000
// The two-job single-mineral colony of the later copy of the stock campaign (AE-043-01 section 5.1): a construction project and a ship-component project that both need Corundium.
const ORDER_CASE = { populationId: 49076, ids: [4048, 4838] }
const SHARED_TOLERANCE = 0.01
const WHOLE_TOLERANCE = 2e-4
// The ledger's use types of the industrial projects: ordnance, fighters, construction, ship components, space station parts.
const PROJECT_USES = [2, 3, 4, 40, 45]
const MINING_USES = [1, 11]
const PRODUCTION_USES = [1, 2, 3, 4, 5, 6]
const KINDS = { 0: 'construction', 1: 'ordnance', 2: 'fighter', 3: 'construction', 4: 'construction' }

let failures = 0
let checks = 0
let unsupported = 0
let diverging = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// Not a pass and not a failure: the save holds no case.
const unsupportedNote = (name, detail = '') => {
  unsupported++
  console.log(`UNSUPPORTED  ${name}${detail ? `  [${detail}]` : ''}`)
}

// The app and the game's rule differ here: reported, never counted as agreement.
const diverges = (name, detail = '') => {
  diverging++
  console.log(`DIVERGES  ${name}${detail ? `  [${detail}]` : ''}`)
}

const parseArguments = (argv) => {
  const saves = []

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  return saves.length ? saves : DEFAULT_SAVES
}

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
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
      query: (sql) => new Promise((resolve, reject) => raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))),
      close: () => raw.close(),
    })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

// The game's decimal rounding to 4 places of a decimal text, done on the digits so that it shares nothing with the engine's: an exact midpoint goes to the even digit and the text is never rounded first.
const decimalRound4 = (text) => {
  const [whole, fraction = ''] = text.split('.')
  const digits = fraction.padEnd(5, '0')
  const kept = BigInt(`${whole}${digits.slice(0, 4)}`)
  const rest = digits.slice(4)
  const half = `5${'0'.repeat(rest.length - 1)}`
  const rounded = kept + (rest > half || (rest === half && kept % 2n === 1n) ? 1n : 0n)
  const digitsText = rounded.toString().padStart(5, '0')

  return Number(`${digitsText.slice(0, -4)}.${digitsText.slice(-4)}`)
}

// The same rounding of a double's own value, exact: the double is a whole number times a power of 2, and its 4-decimal rounding is done on those integers (half to the even digit), so nothing rounds the value before the decision.
const exactRound4 = (value) => {
  const view = new DataView(new ArrayBuffer(8))

  view.setFloat64(0, value)

  const bits = view.getBigUint64(0)
  const exponent = Number((bits >> 52n) & 0x7ffn)
  const mantissa = exponent === 0 ? bits & ((1n << 52n) - 1n) : (bits & ((1n << 52n) - 1n)) | (1n << 52n)
  const shift = (exponent === 0 ? 1 : exponent) - 1075
  const numerator = mantissa * 10000n

  if (shift >= 0) {
    return Number(numerator << BigInt(shift)) / 10000
  }

  const divisor = 1n << BigInt(-shift)
  const quotient = numerator / divisor
  const twice = (numerator % divisor) * 2n
  const rounded = quotient + (twice > divisor || (twice === divisor && quotient % 2n === 1n) ? 1n : 0n)

  return Number(rounded) / 10000
}

const round4 = (value) => (value < 0 ? -exactRound4(-value) : exactRound4(value))

// The game's cycle for one colony. `jobs`: [{ id, share (%), perUnit (build points a unit takes), amount, partial, needs: { Mineral: tonnes a unit } }] in the order the game visits them; `stock`: { Mineral: tonnes }; `capacity`: build points a year at 100%; `years`: the years since the last cycle. `wholeStock` and `unrounded` are mutants: every job sees the stock as it was before the cycle and none debits it, or the build is not rounded to 4 decimals.
const cycle = ({ jobs, stock, capacity, years, wholeStock = false, unrounded = false }) => {
  const left = { ...stock }
  const builds = {}
  const states = {}

  jobs.forEach((job) => {
    const allocated = (((job.capacity === undefined ? capacity : job.capacity) * years) * job.share) / 100
    let built = Math.min(allocated / job.perUnit, job.amount)

    Object.entries(job.needs).forEach(([mineral, need]) => {
      if (need > 0) {
        built = Math.min(built, (wholeStock ? stock[mineral] : left[mineral]) / need)
      }
    })

    built = unrounded ? built : round4(built)

    Object.entries(job.needs).forEach(([mineral, need]) => {
      left[mineral] -= need * built
    })

    const partial = job.partial + built
    const delivered = Math.floor(partial + 1e-9)

    builds[job.id] = built
    states[job.id] = { built, amount: round4(job.amount - built), partial: partial - delivered, delivered, finished: built >= job.amount }
  })

  return { builds, states, left }
}

// The same colony cycle after cycle, a stock income each cycle and `arrivals` ({ cycle: { Mineral: tonnes } }, added to the stock at the start of that cycle): when each job finishes (the cycle number), null when it does not within `limit` cycles. A project promoted from the queue builds from the cycle after the one its predecessor finished in.
const campaign = ({ jobs, queued = [], stock, income = {}, arrivals = {}, capacity, years, limit = 60 }) => {
  let running = jobs.map((job) => ({ ...job }))
  let waiting = queued.map((job) => ({ ...job }))
  let held = { ...stock }
  const finished = {}

  const lastArrival = Math.max(0, ...Object.keys(arrivals).map(Number))

  for (let step = 1; step <= limit && (running.length || waiting.length); step++) {
    Object.entries(arrivals[step] || {}).forEach(([mineral, amount]) => {
      held[mineral] = (held[mineral] || 0) + amount
    })

    const result = cycle({ jobs: running, stock: held, capacity, years })
    const done = []

    held = { ...result.left }
    Object.entries(income).forEach(([mineral, amount]) => {
      held[mineral] += amount
    })
    running = running.map((job) => {
      const state = result.states[job.id]

      if (state.finished) {
        finished[job.id] = step
        done.push(job)

        return null
      }

      return { ...job, amount: state.amount, partial: state.partial }
    }).filter(Boolean)

    if (!done.length && step >= lastArrival && !Object.values(income).some((amount) => amount > 0) && Object.values(result.builds).every((built) => built === 0)) {
      break
    }

    if (done.length) {
      const used = running.reduce((sum, job) => sum + job.share, 0)
      let free = 100 - used

      waiting = waiting.filter((job) => {
        if (job.share <= free + 1e-9) {
          running.push({ ...job })
          free -= job.share

          return false
        }

        return true
      })
    }
  }

  return finished
}

const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((item, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])))

const near = (actual, expected, tolerance = 1e-9) => Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

// SYNTHETIC two jobs on one mineral. Capacity 3650 build points a year over one day is 10 points; job A has 60% (6 points, 2 points a unit, 3 units), job B 40% (4 points, 2 units); each unit takes 10 t of Duranium; the colony holds 40 t, which covers 4 units, not the 5 the two builds ask for.
const SYNTHETIC = {
  capacity: 3650,
  years: 1 / 365,
  stock: { Duranium: 40 },
  jobs: [
    { id: 'A', share: 60, perUnit: 2, amount: 4, partial: 0, needs: { Duranium: 10 } },
    { id: 'B', share: 40, perUnit: 2, amount: 4, partial: 0.5, needs: { Duranium: 10 } },
  ],
}

// The model's worked cases, each a [statement, held] pair. `model` is the cycle function under test (a mutant passes another).
const workedCases = (model, apps) => {
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const { jobs, stock, capacity, years } = SYNTHETIC
  const [first, second] = jobs
  const ab = model({ jobs: [first, second], stock, capacity, years })
  const ba = model({ jobs: [second, first], stock, capacity, years })
  const debit = (result) => stock.Duranium - result.left.Duranium

  holds('SYNTHETIC conservation: the jobs of a cycle take no more of a mineral than the colony held, in either order', debit(ab) <= stock.Duranium + 1e-9 && debit(ba) <= stock.Duranium + 1e-9 && ab.left.Duranium >= -1e-9 && ba.left.Duranium >= -1e-9)
  holds('SYNTHETIC A first: A builds its 3 units (30 t) and B is cut to the 10 t left, 1 unit', near(ab.builds.A, 3) && near(ab.builds.B, 1) && near(ab.left.Duranium, 0))
  holds('SYNTHETIC B first: B builds its 2 units (20 t) and A is cut to the 20 t left, 2 units', near(ba.builds.B, 2) && near(ba.builds.A, 2) && near(ba.left.Duranium, 0))
  holds('SYNTHETIC the order moves units between the jobs, not the tonnes used (40 t either way)', near(debit(ab), debit(ba)) && !near(ab.builds.A, ba.builds.A))
  holds('SYNTHETIC partial completion: B had 0.5 of a unit; it builds 1 unit after A (delivers 1, keeps 0.5) or 2 before A (delivers 2, keeps 0.5)', near(ab.states.B.partial, 0.5) && ab.states.B.delivered === 1 && near(ba.states.B.partial, 0.5) && ba.states.B.delivered === 2)

  const rounded = model({ jobs: [{ id: 'C', share: 100, perUnit: 1, amount: 5, partial: 0, needs: { Duranium: 3 } }], stock: { Duranium: 10 }, capacity: 3650, years: 1 / 365 })

  holds('SYNTHETIC the build is rounded to 4 decimals: 10 t over 3 t a unit is 3.3333 units, not 3.3333333', near(rounded.builds.C, 3.3333) && !near(rounded.builds.C, 10 / 3, 1e-12))

  const covered = model({ jobs: [{ id: 'D', share: 100, perUnit: 2, amount: 2, partial: 0, needs: { Duranium: 10 } }], stock: { Duranium: 100 }, capacity: 3650, years: 1 / 365 })

  holds('SYNTHETIC a build the stock covers is the allocation over the points a unit takes, and a project that builds all its units has finished', near(covered.builds.D, 2) && covered.states.D.finished && near(covered.left.Duranium, 80))

  const lagged = campaign({ jobs: [{ id: 'A', share: 60, perUnit: 2, amount: 2, partial: 0, needs: { Duranium: 0 } }], queued: [{ id: 'Q', share: 50, perUnit: 2, amount: 2, partial: 0, needs: { Duranium: 0 } }], stock: { Duranium: 0 }, capacity: 3650, years: 1 / 365 })

  holds('SYNTHETIC a queued project that fits builds from the cycle after its predecessor finished: A (2 units, 6 points a day) finishes in cycle 1, Q (2 units at 2 points, 5 points a day) does not build in cycle 1 and finishes in cycle 2', lagged.A === 1 && lagged.Q === 2)

  if (apps) {
    const { minerals, production } = apps
    const colony = (job, jobStock) => ({ Amount: job.amount, Duranium: job.needs.Duranium, FuelRequired: 0, StockDuranium: jobStock.Duranium, StockFuel: 0, ...Object.fromEntries(minerals.MINERALS.filter((mineral) => mineral.name !== 'Duranium').flatMap((mineral) => [[mineral.name, 0], [`Stock${mineral.name}`, 0]])) })
    const appShort = jobs.map((job) => production.shortageOf(colony(job, stock)).shortage)

    if (appShort.every((short) => short === null) && stock.Duranium < jobs.reduce((sum, job) => sum + job.amount * job.needs.Duranium, 0)) {
      diverges('SYNTHETIC the per-project check (fallback path: shortageOf) tests each job against the whole stock: 40 t covers the 4 units each job has left, so neither shows short, while the two need 80 t between them', `app shortage ${JSON.stringify(appShort)}`)
    }

    const lateStart = production.industrySchedule([{ ID: 'A', Percentage: 60, Amount: 2, ProdPerUnit: 2, Queue: 0, Paused: 0 }, { ID: 'Q', Percentage: 50, Amount: 2, ProdPerUnit: 2, Queue: 1, Paused: 0 }], capacity).Q

    diverges('SYNTHETIC the continuous schedule (fallback path; the page\'s engine does not) starts a promoted project the moment its predecessor finishes and dates it by continuous work, where the game builds it from the next cycle on and finishes it at a cycle\'s end', `app: starts day ${lateStart.start.toFixed(3)}, finishes day ${lateStart.finish.toFixed(3)}; game: builds in cycle 2, finishes at the end of day 2`)

    const joint = campaign({ jobs: [first, second].map((job) => ({ ...job, partial: 0 })), stock, income: { Duranium: 0 }, capacity, years })

    if (!joint.A && !joint.B) {
      diverges('SYNTHETIC with no income the two jobs never both finish (the stock covers 4 of the 8 units), where the continuous schedule (fallback path; the page\'s engine has no finish for them) dates them at 1.3 and 2 days', `finish cycles A ${joint.A || 'never'}, B ${joint.B || 'never'}`)
    }

    const chain = [{ ID: 1, Percentage: 100, Amount: 1, ProdPerUnit: 1, Queue: 0, Paused: 0 }, { ID: 2, Percentage: 100, Amount: 1, ProdPerUnit: 1, Queue: 1, Paused: 0 }, { ID: 3, Percentage: 100, Amount: 1, ProdPerUnit: 1, Queue: 2, Paused: 0 }]
    const appChain = production.industrySchedule(chain, capacity)
    const modelChain = campaign({ jobs: [{ id: 1, share: 100, perUnit: 1, amount: 1, partial: 0, needs: {} }], queued: [2, 3].map((id) => ({ id, share: 100, perUnit: 1, amount: 1, partial: 0, needs: {} })), stock: {}, capacity, years })
    const cycleDays = years * 365

    holds('SYNTHETIC reference model: three sequential 100% jobs of 1 build point at 10 points a day finish in cycles 1, 2 and 3 (days 1, 2, 3 of 1-day cycles), each queued job building from the cycle after its predecessor finished', modelChain[1] === 1 && modelChain[2] === 2 && modelChain[3] === 3)
    holds('SYNTHETIC the app dates the same three jobs by continuous work at 0.1, 0.2 and 0.3 days', near(appChain[1].finish, 0.1) && near(appChain[2].finish, 0.2) && near(appChain[3].finish, 0.3))
    diverges('SYNTHETIC the continuous schedule\'s date error grows with queue depth: each promotion can add up to one cycle (fallback path; the page\'s engine counts the cycles)', `app finishes ${[1, 2, 3].map((id) => appChain[id].finish.toFixed(3)).join(' / ')} days; model ${[1, 2, 3].map((id) => (modelChain[id] * cycleDays).toFixed(3)).join(' / ')} days; error ${[1, 2, 3].map((id) => (modelChain[id] * cycleDays - appChain[id].finish).toFixed(3)).join(' / ')} days`)

    const slow = [54.385, 55.115].map((slowCapacity) => {
      const job = { id: 1, share: 100, perUnit: 1000, amount: 1, partial: 0, needs: {} }
      const appDays = production.industrySchedule([{ ID: 1, Percentage: 100, Amount: 1, ProdPerUnit: 1000, Queue: 0, Paused: 0 }], slowCapacity)[1].finish
      const modelCycles = campaign({ jobs: [job], stock: {}, capacity: slowCapacity, years, limit: 20000 })[1]

      return { appDays, modelDays: modelCycles * cycleDays }
    })

    holds('SYNTHETIC the app dates one 1000-point unit at 100% share by continuous work: 54.385 build points a year take 6711.4 days and 55.115 take 6622.5 days', near(slow[0].appDays, 6711.4, 1e-5) && near(slow[1].appDays, 6622.5, 1e-5))
    holds('SYNTHETIC the reference model rounds each cycle\'s build to 4 decimals: the same unit takes 10000 one-day cycles at 54.385 build points a year (0.000149 a cycle rounds down to 0.0001) and 5000 at 55.115 (0.000151 rounds up to 0.0002)', slow[0].modelDays === 10000 && slow[1].modelDays === 5000)
    diverges('SYNTHETIC rounding, not queue depth (fallback path: the continuous schedule): when a cycle\'s build is under about 0.0005 unit the 4-decimal rounding changes the effective rate, so the continuous date is neither a lower nor an upper bound; the page\'s engine flags such a build as too small to date', `54.385 BP/yr: app ${slow[0].appDays.toFixed(1)} days, model ${slow[0].modelDays.toFixed(1)} (${(slow[0].modelDays - slow[0].appDays).toFixed(1)}); 55.115 BP/yr: app ${slow[1].appDays.toFixed(1)} days, model ${slow[1].modelDays.toFixed(1)} (${(slow[1].modelDays - slow[1].appDays).toFixed(1)})`)
  }

  return results
}

// The colonies of a save whose running projects (2 to MAX_ORDER_JOBS, all capacity kinds, queued ones not modelled) share a mineral, each run forward cycle after cycle from today's stock with no income, in every order of the projects: { colonies: [{ populationId, orders, conserved, dependent, finishes }] }. `finishes` is { ProjectID: finish cycle } of the first order ('never' within the horizon). `dependent` is whether any order differs from the first in any project's finish cycle. A colony whose capacity figure is missing for a project is left out.
const orderOutcomes = (cycleData, page, years) => {
  const colonies = []
  const running = cycleData.projects.filter((project) => !project.Queue && !project.Pause && project.ProdPerUnit > 0 && project.Percentage > 0)
  const populationIds = [...new Set(running.map((project) => project.PopulationID))]

  populationIds.forEach((populationId) => {
    const list = running.filter((project) => project.PopulationID === populationId)
    const population = cycleData.populations.find((candidate) => candidate.PopulationID === populationId)
    const shares = MINERAL_NAMES.some((name) => list.filter((project) => project[name] > 0).length >= 2)
    const capacities = list.map((project) => page.populationCapacityResult(project.PopulationID, KINDS[project.ProductionType] || 'construction'))

    if (!population || !shares || list.length < 2 || list.length > MAX_ORDER_JOBS || capacities.some((capacity) => capacity.status === 'unavailable' || !(capacity.value > 0))) {
      return
    }

    const stock = Object.fromEntries(MINERAL_NAMES.map((name) => [name, population[name]]))
    const jobs = list.map((project, index) => ({ id: project.ProjectID, share: project.Percentage, perUnit: project.ProdPerUnit, amount: project.Amount, partial: project.PartialCompletion, needs: Object.fromEntries(MINERAL_NAMES.filter((name) => project[name] > 0).map((name) => [name, project[name]])), capacity: capacities[index].value }))
    const outcomes = permutations(jobs).map((order) => campaign({ jobs: order, stock, income: {}, capacity: 0, years, limit: ORDER_HORIZON }))
    const cycleOf = (outcome, job) => (outcome[job.id] === undefined ? 'never' : outcome[job.id])
    const finishes = Object.fromEntries(jobs.map((job) => [job.id, cycleOf(outcomes[0], job)]))
    const conserved = outcomes.every((outcome) => MINERAL_NAMES.every((name) => jobs.filter((job) => outcome[job.id] !== undefined).reduce((sum, job) => sum + ((job.needs[name] || 0) * job.amount), 0) <= stock[name] + 1e-6))
    const dependent = outcomes.some((outcome) => jobs.some((job) => cycleOf(outcome, job) !== finishes[job.id]))

    colonies.push({ populationId, orders: outcomes.length, conserved, dependent, finishes, list, stock, capacities: capacities.map((capacity) => capacity.value) })
  })

  return { colonies }
}

const orderBounds = () => {
  const { jobs, capacity, years } = SYNTHETIC
  const income = { Duranium: 20 }

  return { outcomes: permutations(jobs.map((job) => ({ ...job, partial: 0 }))).map((order) => campaign({ jobs: order, stock: SYNTHETIC.stock, income, capacity, years })) }
}

const scheduleCases = (production) => {
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const project = (ID, Percentage, extra = {}) => ({ ID, Percentage, Amount: 10, ProdPerUnit: 1, Queue: 0, Paused: 0, ...extra })
  const schedule = production.industrySchedule
  const days = (project, capacity) => (project.Amount * project.ProdPerUnit / (capacity * project.Percentage / 100)) * 365
  const capacity = 3650

  const kept = schedule([project(1, 60), project(2, 30, { Queue: 1 })], capacity)

  holds('SYNTHETIC the app keeps the paused share: a paused 60% project leaves 40%, so a 50% project queued behind it never starts', JSON.stringify(schedule([project(1, 60, { Paused: 1 }), project(2, 50, { Queue: 1 })], capacity)[2]) === JSON.stringify({ start: null, finish: null }))
  const skipping = schedule([project(1, 60), project(2, 30, { Amount: 2 }), project(3, 50, { Queue: 1 }), project(4, 40, { Queue: 2 })], capacity)

  holds('SYNTHETIC the app skips a queued project that does not fit and starts the next one that does: when the 30% project finishes the free 40% does not take the 50% queued first, it takes the 40% queued second, and the 50% starts when the 60% one finishes', near(skipping[4].start, skipping[2].finish) && near(skipping[3].start, skipping[1].finish) && skipping[3].start > skipping[4].start)
  holds('SYNTHETIC the app starts a queued project at the instant its predecessor finishes', near(kept[2].start, kept[1].finish) && near(kept[1].finish, days(project(1, 60), capacity)))

  return results
}

// ---- the cycle engine (utilities/industry-cycle.js) and the forecast built on it ----

const ENGINE_FILE = 'industry-cycle.js'
const DECIMAL_FILE = 'decimal.js'
const SEARCH_FILE = 'search-run.js'

// The decimals the platform's own double-to-decimal conversion made of doubles (scripts/lib/native-decimal-reads.json): [[16 hex digits of the bits, the decimal's text]].
const NATIVE_READS = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'native-decimal-reads.json'), 'utf8'))
// The length in years the platform's own arithmetic makes of a cycle, and the doubles it makes of decimals (scripts/lib/native-years.json): { seconds: [text of the years of a cycle of n seconds], others: [[bits of the days, text]], doubles: [[decimal text, bits of the double]] }.
const NATIVE_YEARS = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'native-years.json'), 'utf8'))
const DOUBLE_VIEW = new DataView(new ArrayBuffer(8))

const bitsOfDouble = (value) => {
  DOUBLE_VIEW.setFloat64(0, value)

  return DOUBLE_VIEW.getBigUint64(0).toString(16).padStart(16, '0')
}

const doubleOfBits = (hex) => {
  DOUBLE_VIEW.setBigUint64(0, BigInt(`0x${hex}`))

  return DOUBLE_VIEW.getFloat64(0)
}

const SOURCE_KEY = 'installation-7'
const STEP_TOLERANCE = 1e-6

// The engine loaded from a temp copy in which `from`, which must occur once in the file (the engine, or with `file` the decimal module it imports), is replaced by `to` (a mutant that must fail the case named with it; no mutation when `from` is null), with the decimal module counting the results it makes in `operations.count` so a case can measure work in operations of the type and not in time.
const mutatedEngine = async (from, to, file = ENGINE_FILE) => {
  const source = path.join(root, 'src', 'renderer', 'utilities')
  const texts = Object.fromEntries([ENGINE_FILE, DECIMAL_FILE, SEARCH_FILE].map((name) => [name, fs.readFileSync(path.join(source, name), 'utf8')]))

  const replacedOnce = (name, text, before, after) => {
    const parts = text.split(before)

    if (parts.length !== 2) {
      throw new Error(`the mutation "${before}" matches ${parts.length - 1} times in ${name}, not once`)
    }

    return parts.join(after)
  }

  if (from !== null) {
    texts[file] = replacedOnce(file, texts[file], from, to)
  }

  texts[DECIMAL_FILE] = replacedOnce(DECIMAL_FILE, texts[DECIMAL_FILE], 'const make = (mantissa, scale) => {', 'export const operations = { count: 0 }\n\nconst make = (mantissa, scale) => {\n  operations.count += 1\n')

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-industry-mutant-'))

  try {
    Object.entries(texts).forEach(([name, text]) => fs.writeFileSync(path.join(directory, name), text))

    return await loadUtilities(['industry-cycle', 'decimal'], { directory })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// The utilities loaded from a temp copy of the folder in which `from`, which must occur once in `file`, is replaced by `to`: a mutant that must fail the case named with it.
const mutatedUtilities = async (file, from, to) => {
  const source = path.join(root, 'src', 'renderer', 'utilities')
  const parts = fs.readFileSync(path.join(source, file), 'utf8').split(from)

  if (parts.length !== 2) {
    throw new Error(`the mutation "${from}" matches ${parts.length - 1} times in ${file}, not once`)
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-industry-mutant-'))

  try {
    fs.cpSync(source, directory, { recursive: true })
    fs.writeFileSync(path.join(directory, file), parts.join(to))

    return await loadUtilities(['production', 'minerals', 'industry-cycle', 'provenance'], { stubs: STUBS, directory })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// A page mutation (`loadPage`'s `mutate`) that fails unless `from` occurs once.
const onceReplacing = (from, to) => (text) => {
  const parts = text.split(from)

  if (parts.length !== 2) {
    throw new Error(`the mutation of the page "${from}" matches ${parts.length - 1} times, not once`)
  }

  return parts.join(to)
}

// The page loaded from a temp copy of the renderer's utilities and mixins in which `from`, which must occur once in the forecast driver (`mixins/queue-forecast.js`), is replaced by `to`: a mutant of the driver the Production page and Colony Outlook share, which must fail the page case named with it.
const pageWithMutatedMixin = async (from, to) => {
  const source = path.join(root, 'src', 'renderer')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-driver-mutant-'))

  try {
    for (const folder of ['utilities', 'mixins']) {
      fs.cpSync(path.join(source, folder), path.join(directory, folder), { recursive: true })
    }

    fs.mkdirSync(path.join(directory, 'pages'))
    fs.copyFileSync(path.join(source, 'pages', 'production.vue'), path.join(directory, 'pages', 'production.vue'))
    fs.writeFileSync(path.join(directory, 'mixins', 'queue-forecast.js'), onceReplacing(from, to)(fs.readFileSync(path.join(source, 'mixins', 'queue-forecast.js'), 'utf8')))

    return await loadPage('pages/production', { stubs: STUBS, directory })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const enginePoint = (ID, Percentage, Amount, ProdPerUnit, needs = {}, extra = {}) => ({ ID, Percentage, Amount, PartialCompletion: 0, ProdPerUnit, Queue: 0, Paused: 0, category: 'construction', needs, source: null, ...extra })

// ---- the ledger oracle: the game's cycle on exact fractions of BigInts from decimal texts, sharing nothing with the engine's decimal type ----

const DAY_YEARS = '0.00273972602739726'
const WHOLE_LIMIT = 2n ** 96n
const gcd = (a, b) => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b))

const fraction = (n, d = 1n) => {
  const divisor = gcd(n, d) || 1n
  const sign = d < 0n ? -1n : 1n

  return { n: (sign * n) / divisor, d: (sign * d) / divisor }
}

const fractionOf = (text) => {
  const [whole, digits = ''] = String(text).split('.')

  return fraction(BigInt(`${whole}${digits}`), 10n ** BigInt(digits.length))
}

const ZERO_FRACTION = fraction(0n)
const HUNDRED_FRACTION = fraction(100n)
const plus = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d)
const minus = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d)
const times = (a, b) => fraction(a.n * b.n, a.d * b.d)
const over = (a, b) => fraction(a.n * b.d, a.d * b.n)
const below = (a, b) => a.n * b.d < b.n * a.d
const same = (a, b) => a.n === b.n && a.d === b.d

// The integer nearest a fraction times 10^places, a tie to the even one.
const roundScaled = (value, places) => {
  const sign = value.n < 0n ? -1n : 1n
  const scaled = sign * value.n * 10n ** BigInt(places)
  const quotient = scaled / value.d
  const twice = (scaled % value.d) * 2n

  return sign * (quotient + (twice > value.d || (twice === value.d && quotient % 2n === 1n) ? 1n : 0n))
}

const roundTo4 = (value) => fraction(roundScaled(value, 4), 10000n)

const textOfScaled = (scaled, places) => {
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(places + 1, '0')

  return `${scaled < 0n ? '-' : ''}${digits.slice(0, digits.length - places)}${places ? `.${digits.slice(digits.length - places)}` : ''}`
}

// The text of a fraction as the game's decimal type holds it: the most digits after the point, up to 28, that keep the mantissa under 2^96; null when even the whole part does not fit.
const fittedText = (value) => {
  for (let places = 28; places >= 0; places--) {
    const scaled = roundScaled(value, places)

    if ((scaled < 0n ? -scaled : scaled) < WHOLE_LIMIT) {
      return textOfScaled(scaled, places)
    }
  }

  return null
}

const numberOf = (value) => Number((value.n * 10n ** 40n) / value.d) / 1e40

// Equal to within what a division of doubles leaves, and no more.
const close = (actual, expected) => actual === expected || Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected)) + 1e-25

// A colony cycle after cycle in the order given. `years`: the years of a cycle as text; `capacity`: build points a year at 100%; `stock`: { name: text }; `projects`: [{ id, share, amount, perUnit, needs: { name: text }, queue }] (the need named 'fuel' is the one cut to unrounded); `arrivals`: [{ resource, cycle, quantity }] added at the start of that cycle. A build is the capacity times the years times the share over what a unit takes, no more than the amount left, cut to each mineral's stock in turn, rounded to 4 decimals, cut to the fuel unrounded, taken off every stock; a project completes when its build is exactly what it had left, and then the queued ones that fit start from the next cycle. Returns { states: [{ id, built, amount, finish }], held: { name: fraction } }.
const ledger = ({ years, capacity, stock, projects, arrivals = [], cycles }) => {
  const held = Object.fromEntries(Object.entries(stock).map(([name, text]) => [name, fractionOf(text)]))
  const allocation = times(fractionOf(capacity), fractionOf(years))

  const states = projects.map((project) => ({
    id: project.id,
    share: fractionOf(project.share),
    perUnit: fractionOf(project.perUnit),
    amount: fractionOf(project.amount),
    needs: Object.entries(project.needs).map(([name, text]) => [name, fractionOf(text)]),
    queue: project.queue,
    running: !project.queue,
    built: ZERO_FRACTION,
    finish: null,
  }))

  const have = (name) => held[name] || ZERO_FRACTION
  const queue = states.filter((state) => !state.running).sort((a, b) => a.queue - b.queue)

  for (let cycle = 1; cycle <= cycles; cycle++) {
    arrivals.filter((arrival) => arrival.cycle === cycle).forEach((arrival) => (held[arrival.resource] = plus(have(arrival.resource), fractionOf(arrival.quantity))))

    let finished = false

    states.filter((state) => state.running && state.finish === null).forEach((state) => {
      const units = over(times(allocation, over(state.share, HUNDRED_FRACTION)), state.perUnit)
      let requested = below(state.amount, units) ? state.amount : units

      state.needs.filter(([name]) => name !== 'fuel').forEach(([name, need]) => {
        if (below(have(name), times(need, requested))) {
          requested = over(have(name), need)
        }
      })

      requested = roundTo4(requested)

      const fuel = state.needs.find(([name]) => name === 'fuel')

      if (fuel && below(ZERO_FRACTION, requested) && below(have('fuel'), times(fuel[1], requested))) {
        requested = over(have('fuel'), fuel[1])
      }

      if (!below(ZERO_FRACTION, requested)) {
        requested = ZERO_FRACTION
      }

      state.needs.forEach(([name, need]) => (held[name] = minus(have(name), times(need, requested))))
      state.built = plus(state.built, requested)

      if (same(requested, state.amount)) {
        state.finish = cycle
        finished = true
      }

      state.amount = minus(state.amount, requested)
    })

    if (finished) {
      let free = minus(HUNDRED_FRACTION, states.filter((state) => state.running && state.finish === null).reduce((sum, state) => plus(sum, state.share), ZERO_FRACTION))

      queue.filter((state) => !state.running).forEach((state) => {
        if (!below(free, state.share) && below(ZERO_FRACTION, free)) {
          state.running = true
          free = minus(free, state.share)
        }
      })
    }
  }

  return { states, held }
}

// The engine's cases on synthetic colonies, each a { key, statement, held }. `engine` is the module under test (a mutant passes another). A cycle is a day and 3650 build points a year are 10 points a cycle, so a finish in days is a cycle count.
const engineCases = (engine, decimal) => {
  const results = []
  const holds = (key, statement, condition) => results.push({ key, statement, held: Boolean(condition) })
  const run = (projects, options = {}) => engine.forecastColony({ capacities: { construction: SYNTHETIC.capacity }, stock: {}, cycleDays: 1, projects, ...options })
  const jobs = SYNTHETIC.jobs
  const pair = [enginePoint(1, 60, 4, 2, { Duranium: 10 }), enginePoint(2, 40, 4, 2, { Duranium: 10 }, { PartialCompletion: 0.5 })]
  const reference = (extra = {}) => permutations(jobs.map((job) => ({ ...job, partial: 0 }))).map((order) => campaign({ jobs: order, stock: SYNTHETIC.stock, capacity: SYNTHETIC.capacity, years: SYNTHETIC.years, ...extra }))
  const ids = { A: 1, B: 2 }

  // Shared stock and the order.
  const one = run(pair, { stock: SYNTHETIC.stock })
  const single = permutations(jobs).map((order) => cycle({ jobs: order, stock: SYNTHETIC.stock, capacity: SYNTHETIC.capacity, years: SYNTHETIC.years }))
  const buildRange = (name) => [Math.min(...single.map((result) => result.builds[name])), Math.max(...single.map((result) => result.builds[name]))]
  const sameRange = (figure, range) => near(figure.builtRange[0], range[0]) && near(figure.builtRange[1], range[1])

  holds('conserved', 'ENGINE shared stock (SYNTHETIC two jobs, 40 t of Duranium, 5 units asked): the jobs build 4 units between them, spend 40 t and no more, and each one\'s build over the two orders is the reference model\'s range', near(one.projects[1].built + one.projects[2].built, 4) && near(one.left.Duranium, 0) && one.left.Duranium >= -1e-9 && sameRange(one.projects[1], buildRange('A')) && sameRange(one.projects[2], buildRange('B')))
  holds('order', 'ENGINE order: both jobs stall on Duranium in every order (no finish differs), and the engine reports that the units each one built depend on the order, with both jobs in contention and both orders tried', !one.orders.dependent && one.orders.buildDepends && JSON.stringify(one.orders.contested) === '[1,2]' && one.orders.exhaustive && one.orders.tried === 2 && [1, 2].every((id) => one.projects[id].outcome === 'stalls' && one.projects[id].finish === null && (one.projects[id].stall || {}).reason === 'stock' && (one.projects[id].stall || {}).resource === 'Duranium' && one.projects[id].stallOrders === 'all' && one.projects[id].buildDepends))

  const arrivals = [{ resource: 'Duranium', day: 3, quantity: 20 }, { resource: 'Duranium', day: 6, quantity: 20 }]
  const fed = run(pair, { stock: SYNTHETIC.stock, arrivals })
  const fedReference = reference({ arrivals: { 3: { Duranium: 20 }, 6: { Duranium: 20 } } })

  const rangeOf = (name) => {
    const finishes = fedReference.map((outcome) => outcome[name])

    return { earliest: Math.min(...finishes.filter(Boolean)), latest: finishes.every(Boolean) ? Math.max(...finishes) : null }
  }

  holds('arrivals', 'ENGINE arrivals (SYNTHETIC, 20 t on day 3 and on day 6): each job\'s earliest and latest finish over the two orders is the reference model\'s, and the order moves who finishes first', ['A', 'B'].every((name) => fed.projects[ids[name]].earliest === rangeOf(name).earliest && fed.projects[ids[name]].latest === rangeOf(name).latest) && fed.projects[1].dependent && fed.projects[1].earliest !== fed.projects[1].latest)

  // An arrival moves the dates of what it feeds and nothing else.
  const split = [enginePoint(1, 50, 3, 5, { Duranium: 1 }), enginePoint(2, 50, 3, 5, { Corbomite: 1 })]
  const dry = { Duranium: 0, Corbomite: 0 }
  const corbomite = { resource: 'Corbomite', day: 2, quantity: 3 }
  const feed = (day) => run(split, { stock: dry, arrivals: [corbomite, { resource: 'Duranium', day, quantity: 3 }] })
  const [early, late] = [feed(5), feed(9)]
  const baseline = run(split, { stock: dry, arrivals: [corbomite] })

  holds('arrivalShift', 'ENGINE an arrival moves only what it feeds: delaying the Duranium from day 5 to day 9 moves the Duranium job\'s finish from cycle 7 to 11 and leaves the Corbomite job\'s (cycle 4) alone', early.projects[1].finish === 7 && late.projects[1].finish === 11 && early.projects[2].finish === 4 && late.projects[2].finish === 4 && early.orders.tried === 1)
  holds('baseline', 'ENGINE with the arrival taken out the colony is as before: the Duranium job has no finish and an empty list of arrivals is the same as none', baseline.projects[1].finish === null && baseline.projects[1].outcome === 'stalls' && JSON.stringify(run(split, { stock: dry, arrivals: [corbomite, { resource: 'Duranium', day: 5, quantity: 3 }].filter((arrival) => arrival.resource !== 'Duranium') })) === JSON.stringify(baseline) && JSON.stringify(run(split, { stock: dry, arrivals: [] })) === JSON.stringify(run(split, { stock: dry })))

  const arrivalFinish = (day) => run([enginePoint(1, 50, 3, 5, { Duranium: 1 })], { stock: { Duranium: 0 }, arrivals: [{ resource: 'Duranium', day, quantity: 3 }] }).projects[1].finish

  holds('arrivalCycle', 'ENGINE an arrival is in the stock of the first cycle that ends on or after its day: day 2.5 and day 3 feed cycle 3 (finish 5), day 3.001 feeds cycle 4 (finish 6), day 0 feeds cycle 1 (finish 3)', arrivalFinish(2.5) === 5 && arrivalFinish(3) === 5 && arrivalFinish(3.001) === 6 && arrivalFinish(0) === 3)

  // The queue.
  const chain = [enginePoint(1, 100, 1, 1), enginePoint(2, 100, 1, 1, {}, { Queue: 1 }), enginePoint(3, 100, 1, 1, {}, { Queue: 2 })]
  const chained = run(chain)
  const modelChain = campaign({ jobs: [{ id: 1, share: 100, perUnit: 1, amount: 1, partial: 0, needs: {} }], queued: [2, 3].map((id) => ({ id, share: 100, perUnit: 1, amount: 1, partial: 0, needs: {} })), stock: {}, capacity: SYNTHETIC.capacity, years: SYNTHETIC.years })

  holds('queue', 'ENGINE queue: three sequential 100% jobs finish in cycles 1, 2 and 3 as the reference model has them, each queued job entering the running set when its predecessor finishes and building from the cycle after', [1, 2, 3].every((id) => chained.projects[id].finish === modelChain[id] && chained.projects[id].start === id - 1) && modelChain[3] === 3)

  const fitting = [enginePoint(1, 60, 10, 1), enginePoint(2, 30, 2, 1), enginePoint(3, 50, 10, 1, {}, { Queue: 1 }), enginePoint(4, 40, 10, 1, {}, { Queue: 2 })]
  const fitted = run(fitting)
  const modelFit = campaign({ jobs: [{ id: 1, share: 60, perUnit: 1, amount: 10, partial: 0, needs: {} }, { id: 2, share: 30, perUnit: 1, amount: 2, partial: 0, needs: {} }], queued: [{ id: 3, share: 50, perUnit: 1, amount: 10, partial: 0, needs: {} }, { id: 4, share: 40, perUnit: 1, amount: 10, partial: 0, needs: {} }], stock: {}, capacity: SYNTHETIC.capacity, years: SYNTHETIC.years })

  holds('queueFit', 'ENGINE queue fit: when the 30% job finishes the free 40% does not take the 50% job queued first but the 40% job queued second, and the 50% job starts when the 60% one finishes; every finish cycle is the reference model\'s', [1, 2, 3, 4].every((id) => fitted.projects[id].finish === modelFit[id]) && fitted.projects[4].start === fitted.projects[2].finish && fitted.projects[3].start === fitted.projects[1].finish && fitted.projects[3].start > fitted.projects[4].start)

  const reserved = run([enginePoint(1, 60, 10, 1, {}, { Paused: 1 }), enginePoint(2, 50, 10, 1, {}, { Queue: 1 }), enginePoint(3, 40, 2, 1)])
  const released = run([enginePoint(1, 30, 10, 1, {}, { Paused: 1 }), enginePoint(2, 50, 10, 1, {}, { Queue: 1 }), enginePoint(3, 40, 2, 1)])

  holds('paused', 'ENGINE a paused job keeps its share: a paused 60% job leaves 40%, so a 50% job queued behind it never starts (it is queued, the paused one is paused), while behind a paused 30% job it starts when the 40% job finishes', reserved.projects[2].outcome === 'queued' && reserved.projects[2].start === null && reserved.projects[1].outcome === 'paused' && released.projects[2].start === released.projects[3].finish && released.projects[2].finish !== null)

  // Whole units, the 4-decimal rounding and the other limits.
  const rounded = run([enginePoint(1, 100, 5, 1, { Duranium: 3 })], { stock: { Duranium: 10 } })

  holds('rounded', 'ENGINE the build is rounded to 4 decimals: 10 t over 3 t a unit is 3.3333 units, not 3.3333333, as the reference model has it', near(rounded.projects[1].firstBuild, 3.3333) && !near(rounded.projects[1].firstBuild, 10 / 3, 1e-12) && near(rounded.projects[1].firstBuild, cycle({ jobs: [{ id: 'C', share: 100, perUnit: 1, amount: 5, partial: 0, needs: { Duranium: 3 } }], stock: { Duranium: 10 }, capacity: SYNTHETIC.capacity, years: SYNTHETIC.years }).builds.C))

  const slow = [54.385, 55.115].map((capacity) => ({ engine: run([enginePoint(1, 100, 1, 1000)], { capacities: { construction: capacity } }).projects[1], model: campaign({ jobs: [{ id: 1, share: 100, perUnit: 1000, amount: 1, partial: 0, needs: {} }], stock: {}, capacity, years: SYNTHETIC.years, limit: 20000 })[1] }))

  holds('slow', 'ENGINE a unit that takes 1000 points at 100% share takes 10000 one-day cycles at 54.385 build points a year and 5000 at 55.115 (the reference model\'s count, 0.000149 rounding down and 0.000151 up), and the engine flags both builds as too small to date', slow.every((entry) => entry.engine.finish === entry.model && entry.engine.sensitive) && slow[0].engine.finish === 10000 && slow[1].engine.finish === 5000 && !one.projects[1].sensitive)

  const sourced = (extra) => enginePoint(extra.ID, extra.share, 10, 1, {}, { source: SOURCE_KEY })
  const solo = run([sourced({ ID: 1, share: 100 })], { stock: { [SOURCE_KEY]: 3 } })
  const shared = run([sourced({ ID: 1, share: 60 }), sourced({ ID: 2, share: 40 })], { stock: { [SOURCE_KEY]: 7 } })

  holds('source', 'ENGINE conversion: a project that asks for 10 units from 3 installations builds the 3 whole units and then stalls for source installations; two projects asking 6 and 4 of 7 installations take 7 between them, and the order moves 3 of them', solo.projects[1].built === 3 && solo.projects[1].delivered === 3 && near(solo.projects[1].amountLeft, 7) && (solo.projects[1].stall || {}).reason === 'source' && near(solo.left[SOURCE_KEY], 0) && near(shared.projects[1].built + shared.projects[2].built, 7) && sameRange(shared.projects[1], [3, 6]) && sameRange(shared.projects[2], [1, 4]) && JSON.stringify(shared.orders.contested) === '[1,2]')

  const fueled = run([enginePoint(1, 100, 10, 1, { Duranium: 1, fuel: 2 })], { stock: { Duranium: 100, fuel: 5.00003 } })

  holds('fuel', 'ENGINE fuel: 5.00003 units of fuel at 2 a unit cover 2.500015 units, which the build takes unrounded (the mineral limit rounds, the fuel limit does not), and the project then stalls for fuel', near(fueled.projects[1].firstBuild, 2.500015, 1e-9) && (fueled.projects[1].stall || {}).reason === 'stock' && (fueled.projects[1].stall || {}).resource === 'fuel' && fueled.projects[1].outcome === 'stalls')

  const wide = Array.from({ length: 6 }, (_, index) => enginePoint(index + 1, 16, 100, 1, { Duranium: 1 }))
  const many = run(wide, { stock: { Duranium: 8 } })

  holds('many', 'ENGINE with 6 projects in contention for 8 t of Duranium the orders cannot all be tried, the engine says so, tries more than one, and still spends 8 t and no more', !many.orders.exhaustive && many.orders.tried > 1 && many.orders.tried <= 1000 && many.orders.contested.length === 6 && near(Object.values(many.projects).reduce((sum, figure) => sum + figure.built, 0), 8) && Object.values(many.projects).every((figure) => figure.builtRange[0] <= figure.built + 1e-9 && figure.built <= figure.builtRange[1] + 1e-9))

  // The partial unit and the units left reconcile, whatever happened to the project.
  const longCase = { projects: [enginePoint(1, 30, 500.5, 3, { Duranium: 2, fuel: 1 }, { PartialCompletion: 0.25 }), enginePoint(2, 50, 300, 7, { Duranium: 1 }), enginePoint(3, 20, 200, 2, {}, { Queue: 1 })], capacities: { construction: 900 }, stock: { Duranium: 2000, fuel: 10000 }, cycleDays: 1.1, arrivals: [{ resource: 'Duranium', day: 400, quantity: 500 }] }
  const reconciles = (figures, projects) => projects.every((project) => {
    const figure = figures.projects[project.ID]

    return Math.abs(figure.delivered + figure.partial - (project.PartialCompletion + figure.built)) <= STEP_TOLERANCE && Math.abs(figure.built + figure.amountLeft - project.Amount) <= STEP_TOLERANCE + (figure.fineRemainder ? 5e-5 : 0)
  })
  const long = engine.forecastColony(longCase)

  holds('partial', 'ENGINE the units delivered and the part of a unit kept add up to the part the project had plus what it built, and the units built and the units left add up to the units it had, for a stalled colony, a fed one, a queue and a long run with fuel', reconciles(one, pair) && reconciles(fed, pair) && reconciles(chained, chain) && reconciles(fitted, fitting) && reconciles(long, longCase.projects) && one.projects[2].delivered === 1 && near(one.projects[2].partial, 0.5))

  // Taking steady cycles in one step changes nothing.
  const stepped = engine.forecastColony({ ...longCase, stepwise: true })
  const sameFigure = (figure, other) => figure.finish === other.finish && figure.start === other.start && figure.outcome === other.outcome && (figure.stall && figure.stall.reason) === (other.stall && other.stall.reason) && figure.delivered === other.delivered && Math.abs(figure.built - other.built) <= STEP_TOLERANCE && Math.abs(figure.partial - other.partial) <= STEP_TOLERANCE && Math.abs(figure.amountLeft - other.amountLeft) <= STEP_TOLERANCE
  const slowCases = [54.385, 55.115].map((capacity) => ({ projects: [enginePoint(1, 100, 1, 1000)], capacities: { construction: capacity }, stock: {}, cycleDays: 1 }))

  holds('stepwise', 'ENGINE taking the cycles one by one gives the same finishes, starts, builds and stalls as taking steady stretches in one step (a long run with fuel, an arrival and a queue, and the 10000- and 5000-cycle builds)', Object.keys(long.projects).every((id) => sameFigure(long.projects[id], stepped.projects[id])) && slowCases.every((slowCase) => sameFigure(engine.forecastColony(slowCase).projects[1], engine.forecastColony({ ...slowCase, stepwise: true }).projects[1])) && long.projects[1].finish !== null)

  // The decimal type against an oracle of exact fractions that shares nothing with it: the rounding of a decimal text on its digits, and every other result as the exact fraction fitted to 28 digits after the point and a mantissa under 2^96 (a result that does not fit at all must throw).
  const ROUNDING_TEXTS = ['0.00025', '0.00035', '0.00125', '1.23445', '0.00015', '0.00005', '0.00025000000001', '0.00034999999999', '1.2344500001', '1.2344499999', '0.33336', '0.33334', '2.5', '0.0002500000000000000000000001', '0.0002499999999999999999999999']
  const OPERATIONS = [['divide', '1', '3'], ['divide', '2', '3'], ['divide', '1', '7'], ['divide', '5', '6'], ['divide', '1', '8'], ['divide', '0.5', '0.07'], ['divide', '0.9999999999999999', '0.3333333333333333'], ['divide', '1000000', '3'], ['multiply', '0.0000000000000000000000000015', '0.5'], ['multiply', '0.0000000000000000000000000005', '0.5'], ['multiply', '0.5000000000000000000000000001', '0.5000000000000000000000000001'], ['multiply', '7.9228162514264337593543950335', '1.0000000000000000000000000001'], ['multiply', '123456789012.3456789012345678', '1000000.0000000000000001'], ['add', '79228162514264337593543950335', '0.4'], ['add', '79228162514264337593543950334', '0.5'], ['add', '79228162514264337593543950335', '0.5'], ['add', '79228162514264337593543950335', '1']]
  const exactly = ([name, a, b]) => {
    const expected = fittedText(({ add: plus, multiply: times, divide: over })[name](fractionOf(a), fractionOf(b)))
    let made = null

    try {
      made = decimal[name](decimal.fromString(a), decimal.fromString(b))
    } catch {
      made = null
    }

    return expected === null ? made === null : made !== null && decimal.equal(made, decimal.fromString(expected))
  }

  holds('decimalRound', 'DECIMAL rounding to 4 places goes to the even digit on an exact midpoint (0.00025, 0.00035, 1.23445, 0.00015, 0.00005, a 28-digit hair either side of one) and to the nearer digit anywhere else, as an oracle that works on the digits of the text has it', ROUNDING_TEXTS.every((text) => decimal.toNumber(decimal.round(decimal.fromString(text), 4)) === decimalRound4(text)))
  const readOff = NATIVE_READS.pairs.filter(([hex, text]) => !decimal.equal(decimal.fromDouble(doubleOfBits(hex)), decimal.fromString(text)))
  const printedOff = NATIVE_READS.pairs.filter(([hex, text]) => !decimal.equal(decimal.fromString(doubleOfBits(hex).toPrecision(15)), decimal.fromString(text)))
  const readsAs = (value, text) => decimal.equal(decimal.fromDouble(value), decimal.fromString(text))

  const refusesToRead = (value) => {
    try {
      decimal.fromDouble(value)

      return false
    } catch (error) {
      return error instanceof RangeError
    }
  }

  holds('decimalRead', 'DECIMAL a number the save holds is read as the platform\'s own conversion reads a double (the reference run: boundary doubles, every power of two, random magnitudes and values of the saves, none different, while the number printed to 15 digits would differ in many): 6.072675875386635 is 6.07267587538664 and the 600.6984797958705 of a stock is 600.69847979587, 0.1 + 0.2 is 0.3, a third is 0.333333333333333, a 20-digit number keeps its first 15, and a number of 2^96 or more is refused', readOff.length === 0 && NATIVE_READS.pairs.length === NATIVE_READS.count && NATIVE_READS.count > 4000 && printedOff.length > 100 && readsAs(6.072675875386635, '6.07267587538664') && readsAs(600.6984797958705, '600.69847979587') && readsAs(0.1 + 0.2, '0.3') && readsAs(1 / 3, '0.333333333333333') && readsAs(1000000.00035, '1000000.00035') && readsAs(Number('12345678901234567890'), '12345678901234600000') && refusesToRead(2 ** 96) && refusesToRead(1e29) && !decimal.fitsDouble(1e29) && decimal.fitsDouble(7e28))
  holds('decimalDivide', 'DECIMAL division and multiplication carry as many digits as the type holds and round a tie to the even digit, and a sum that does not fit throws, against the oracle (a third to 28 digits, 5e-28 times a half to 2e-28, 15e-28 times a half to 8e-28, a quotient or product that drops digits to keep its mantissa under 2^96)', OPERATIONS.every(exactly))

  // The length of a cycle in years the game makes (decimal quotient, taken to a double by the platform, read back), against the platform's own run: every cycle of 1 to 10000 seconds, other lengths, and the platform's double of 2400 decimals, 1800 of them with a 64-bit part from 2^63 up that the platform rounds twice.
  const yearsOff = NATIVE_YEARS.seconds.map((text, index) => [index + 1, text]).filter(([count, text]) => !decimal.equal(engine.yearsOf(count / 86400), decimal.fromString(text)))
  const yearsOffOthers = NATIVE_YEARS.others.filter(([hex, text]) => !decimal.equal(engine.yearsOf(doubleOfBits(hex)), decimal.fromString(text)))
  const doublesOff = NATIVE_YEARS.doubles.filter(([text, hex]) => bitsOfDouble(decimal.toDouble(decimal.fromString(text))) !== hex)
  const nearestYears = (count) => decimal.fromDouble(decimal.toNumber(decimal.divide(decimal.fromDouble(count / 86400 * 86400), decimal.fromDouble(31536000))))
  const nearestOff = NATIVE_YEARS.seconds.map((_text, index) => index + 1).filter((count) => !decimal.equal(nearestYears(count), decimal.fromString(NATIVE_YEARS.seconds[count - 1])))
  const built108 = engine.forecastColony({ projects: [enginePoint(1, 100, 1, 1)], capacities: { construction: 108 }, stock: {}, cycleDays: 73 / 86400 })

  holds('nativeYears', 'ENGINE the length of a cycle in years is the one the game makes of it: for each cycle of 1 to 10000 seconds, for other lengths and for the platform\'s conversion of a decimal to a double (2402 decimals) it is what the platform\'s own run gives, none different, while the nearest double would differ for some of the 10000 cycles (73 seconds is 0.00000231481481481482 years and not 0.00000231481481481481): a one-unit project of 1 build point at 108 build points a year builds 0.0003 of a unit in a cycle of 73 seconds and finishes in cycle 3334, not 0.0002 in cycle 5000', yearsOff.length === 0 && yearsOffOthers.length === 0 && doublesOff.length === 0 && nearestOff.length > 100 && nearestOff.includes(73) && built108.projects[1].firstBuild === 0.0003 && Math.abs(built108.projects[1].finish - 3334 * 73 / 86400) < 1e-9)

  // The ledger oracle's cycle against the engine's, from decimal texts: every build, the units left, the units delivered, the finish and the stock left is the oracle's, and the four ways a float engine went wrong are cases.
  const numbers = (texts) => Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, Number(text)]))
  const point = (id, share, amount, perUnit, needs = {}, queue = 0) => ({ id, share, amount, perUnit, needs, queue })

  const against = ({ projects: specs, stock = {}, arrivals = [], capacity, years = DAY_YEARS, cycleDays = 1, cycles, stepwise = false }) => ({
    figures: engine.forecastColony({ capacities: { construction: Number(capacity) }, cycleDays, horizonDays: cycles * cycleDays, stepwise, stock: numbers(stock), arrivals: arrivals.map((arrival) => ({ resource: arrival.resource, day: arrival.cycle * cycleDays, quantity: Number(arrival.quantity) })), projects: specs.map((spec) => enginePoint(spec.id, Number(spec.share), Number(spec.amount), Number(spec.perUnit), numbers(spec.needs), { Queue: spec.queue })) }),
    model: ledger({ years, capacity, stock, arrivals, cycles, projects: specs }),
    cycleDays,
  })

  const agree = ({ figures, model, cycleDays }) => model.states.every((state) => {
    const figure = figures.projects[state.id]

    return close(figure.built, numberOf(state.built)) && close(figure.amountLeft, numberOf(state.amount)) && figure.delivered === Number(state.built.n / state.built.d) && (state.finish === null ? figure.finish === null : figure.finish === state.finish * cycleDays)
  }) && Object.entries(model.held).every(([name, quantity]) => close(figures.left[name], numberOf(quantity)))

  const inherited = against({ projects: [point(1, '100', '1', '1', { Duranium: '1000000' }), point(2, '100', '1', '1', { Duranium: '1' }, 1)], stock: { Duranium: '1000000.00035' }, capacity: '365', cycles: 6 })

  holds('ledgerInherited', 'ENGINE the stock a project leaves is exact, with no error from the subtraction before it: 1000000.00035 t, 1000000 t taken by the project ahead, leaves 0.00035 t, which is a midpoint of the rounding, so the queued project builds 0.0004 (the even digit) and the stock goes to -0.00005 t, as the ledger oracle has it', agree(inherited) && close(inherited.figures.projects[2].firstBuild, 0.0004) && close(numberOf(inherited.model.states[1].built), 0.0004) && close(inherited.figures.left.Duranium, -0.00005))

  const remainders = ['1.00003', '1.00014'].map((fuel) => against({ projects: [point(1, '100', '3', '1', { fuel: '2' }), point(2, '100', '1', '1', {}, 1)], stock: { fuel }, arrivals: [{ resource: 'fuel', cycle: 2, quantity: '100' }], capacity: '365', cycles: 40 }))

  holds('ledgerRemainder', 'ENGINE the part of a unit a fuel limit leaves is the oracle\'s in both directions, with the stock and the units delivered: 1.00003 of fuel (2 a unit, 3 units, 100 more on day 2) ends 0.000015 past the last unit and 1.00014 ends 0.00003 short of it, and in neither does the project finish or the one queued behind it build', remainders.every((entry) => agree(entry) && entry.figures.projects[1].finish === null && entry.model.states[0].finish === null && entry.model.states[1].built.n === 0n) && close(remainders[0].figures.projects[1].amountLeft, -0.000015) && close(remainders[1].figures.projects[1].amountLeft, 0.00003))

  const cutRun = against({ projects: [point(1, '100', '1000', '1', { fuel: '1000000000' }), point(2, '100', '1', '1', {}, 1)], stock: { fuel: '999999999999.5' }, capacity: '365000', cycles: 10 })

  holds('ledgerCut', 'ENGINE a project is complete only when the build is exactly what it had left, whatever limited it: 1000 units at 1e9 of fuel a unit against 999999999999.5 builds 999.9999999995, delivers 999, names fuel as the cut, has no finish, and the project queued behind it is not started (outcome unresolved), as the oracle has it', agree(cutRun) && cutRun.figures.projects[1].delivered === 999 && cutRun.figures.projects[1].finish === null && (cutRun.figures.projects[1].cut || {}).resource === 'fuel' && close(cutRun.figures.projects[1].built, 999.9999999995) && cutRun.figures.projects[2].outcome === 'unresolved' && cutRun.figures.projects[2].start === null)

  const mixed = against({ projects: [point(1, '25', '1', '4000', { Duranium: '1' }), point(2, '35', '10', '4000', { Duranium: '1' })], stock: { Duranium: '2.6' }, capacity: '1460', cycles: 6000 })

  holds('ledgerMixed', 'ENGINE two projects whose builds each sit just under a midpoint (1460 build points a year, 25% and 35% of a 4000-point unit: 0.00025 less a hair and 0.00035 less a hair) have one result, not a bracket: the first finishes in cycle 5000 with no range, the second builds what the stock leaves, both the oracle\'s, and the order is not tried', agree(mixed) && mixed.figures.projects[1].finish === 5000 && mixed.figures.projects[1].earliest === 5000 && mixed.figures.projects[1].latest === 5000 && !mixed.figures.projects[1].dependent && mixed.figures.orders.tried === 1 && !mixed.figures.orders.buildDepends)

  // A build on an exact midpoint and one a hair either side of it, with a cycle of exactly a tenth of a year (36.5 days) so that the years are exact: 4000 points a unit at 10 a year is 0.00025 a cycle (the even digit, 0.0002) and at 14 a year 0.00035 (0.0004).
  const TIES = [['10', 5000], ['14', 2500], ['10.0000000001', 3334], ['9.9999999999', 5000], ['14.0000000001', 2500], ['13.9999999999', 3334]]
  const tieRuns = TIES.map(([capacity]) => against({ projects: [point(1, '100', '1', '4000')], capacity, years: '0.1', cycleDays: 36.5, cycles: 6000 }))

  holds('tie', 'ENGINE a build on an exact midpoint of the 4-decimal rounding goes to the even digit and one a hair off it to the nearer, each with one finish and no range: 0.00025 a cycle finishes in 5000 cycles and 0.00035 in 2500, 0.000250000000025 in 3334 and 0.00024999999999 in 5000, 0.000350000000025 in 2500 and 0.000349999999975 in 3334, as the oracle has them', tieRuns.every((entry, index) => agree(entry) && entry.figures.projects[1].finish === TIES[index][1] * 36.5 && !entry.figures.projects[1].dependent && entry.figures.projects[1].earliest === entry.figures.projects[1].latest))

  // A large request with a stock short by a part of it too small to see in a double: the build is cut to the stock, whatever the size of the request, and the unit it leaves is not delivered, with the project behind it not started; a stock that exactly covers it completes.
  const DEFICITS = [['1', '999999999.995'], ['1', '999999999.5'], ['10', '9999999999.95'], ['10', '9999999995'], ['1000', '999999999999.5'], ['1000', '999999999995'], ['1000', '999999999999.999']]
  const deficitRun = (amount, fuel) => against({ projects: [point(1, '100', amount, '1', { fuel: '1000000000' }), point(2, '100', '1', '1', {}, 1)], stock: { fuel }, capacity: String(365 * Number(amount)), cycles: 10 })
  const deficitRuns = DEFICITS.map(([amount, fuel]) => deficitRun(amount, fuel))
  const covered = deficitRun('1000', '1000000000000')

  holds('deficit', 'ENGINE a build is cut to the stock whatever the size of the request: 1, 10 and 1000 units at 1e9 of fuel a unit with the stock short by 5e-12, 5e-10, 5e-13 and 1e-15 of the request each build a hair under the request, deliver one unit fewer, name fuel as the cut, have no finish and do not start the project behind them, as the oracle has them; a stock that exactly covers 1000 units finishes them in the first cycle and starts the next', deficitRuns.every((entry, index) => agree(entry) && entry.figures.projects[1].delivered === Number(DEFICITS[index][0]) - 1 && entry.figures.projects[1].finish === null && (entry.figures.projects[1].cut || {}).resource === 'fuel' && entry.figures.projects[2].outcome === 'unresolved' && entry.figures.projects[2].start === null) && agree(covered) && covered.figures.projects[1].finish === 1 && covered.figures.projects[2].start === 1)

  // Taking steady stretches in one step changes nothing: the figures of the runs above, jumped and one cycle at a time, are the same to the last digit.
  const sameProjects = (entry, stepped) => JSON.stringify(entry.figures.projects) === JSON.stringify(stepped.figures.projects) && JSON.stringify(entry.figures.left) === JSON.stringify(stepped.figures.left)
  const jumped = [...tieRuns.map((entry, index) => [entry, against({ projects: [point(1, '100', '1', '4000')], capacity: TIES[index][0], years: '0.1', cycleDays: 36.5, cycles: 6000, stepwise: true })]), [mixed, against({ projects: [point(1, '25', '1', '4000', { Duranium: '1' }), point(2, '35', '10', '4000', { Duranium: '1' })], stock: { Duranium: '2.6' }, capacity: '1460', cycles: 6000, stepwise: true })]]

  holds('jumps', 'ENGINE taking steady stretches of cycles in one step gives, to the last digit, the figures and the stock of taking them one by one: the six tie runs (2500 to 5000 cycles) and the two projects of 1460 build points a year sharing 2.6 t', jumped.every(([entry, stepped]) => sameProjects(entry, stepped) && agree(stepped)))

  // A rounding that raises the build can take the stock the game's strict check let by, and the engine's contention is on the rounded builds.
  const edgeJob = (id) => enginePoint(id, 50, 0.5001, 120, { Duranium: 120 }, { PartialCompletion: 0.4999 })
  const edge = run([edgeJob(1), edgeJob(2)], { capacities: { construction: 43804.4676 }, stock: { Duranium: 120.0123 } })
  const edgeModel = permutations([1, 2].map((id) => ({ id, share: 50, perUnit: 120, amount: 0.5001, partial: 0.4999, needs: { Duranium: 120 } }))).map((order) => cycle({ jobs: order, stock: { Duranium: 120.0123 }, capacity: 43804.4676, years: SYNTHETIC.years }))

  holds('contendRounded', 'ENGINE contention is on the rounded builds: two 50% jobs whose unrounded builds (60.00615 t each) fit the 120.0123 t held but whose rounded builds (0.5001, 60.012 t each) do not are in contention, both orders are tried, each job builds what the reference model has in the two orders and finishes in the first cycle in one order and never in the other', JSON.stringify(edge.orders.contested) === '[1,2]' && edge.orders.tried === 2 && edge.orders.exhaustive && edge.orders.dependent && [1, 2].every((id) => edge.projects[id].earliest === 1 && edge.projects[id].latest === null && edge.projects[id].dependent && near(edge.projects[id].builtRange[0], Math.min(...edgeModel.map((outcome) => outcome.builds[id]))) && near(edge.projects[id].builtRange[1], Math.max(...edgeModel.map((outcome) => outcome.builds[id])))))

  // What a fuel or installation limit leaves of a unit is kept to its last digit: a project left a part of a unit under 0.0001, or past its last unit, can never build exactly what it has left. The game's behaviour for it is not in any save, so it is flagged, never matched silently, and neither it nor the project queued behind it is given a completion, whichever way the remainder lies.
  const fineProject = enginePoint(1, 100, 3, 1, { fuel: 2 })
  const successor = enginePoint(2, 100, 1, 1, {}, { Queue: 1 })
  const fineRun = (fuel) => run([fineProject, successor], { capacities: { construction: 365 }, stock: { fuel }, arrivals: [{ resource: 'fuel', day: 2, quantity: 100 }] })
  const [overshoot, stranded] = [fineRun(1.00003), fineRun(1.00014)]

  const unresolved = (figures) => figures.projects[1].finish === null && figures.projects[1].outcome === 'stalls' && (figures.projects[1].stall || {}).reason === 'remainder' && figures.projects[1].fineRemainder && figures.projects[2].start === null && figures.projects[2].startEarliest === null && figures.projects[2].finish === null && figures.projects[2].outcome === 'unresolved' && (figures.projects[2].stall || {}).reason === 'unresolved' && !figures.events.some((event) => event.type === 'finish' || (event.type === 'start' && event.id === 2))

  holds('successor', 'ENGINE a project that ends on a part of a unit it cannot build exactly has no finish, frees no share and starts no queued project, whichever way the remainder lies: 1.00003 of fuel ends 0.000015 past its last unit and 1.00014 leaves 0.00003 short of it; each has no finish, stalls on the remainder, and the project behind it has no start or finish (outcome unresolved, not queued) and no finish or start event is given', unresolved(overshoot) && unresolved(stranded) && close(overshoot.projects[1].firstBuild, 0.500015) && close(stranded.projects[1].firstBuild, 0.50007) && close(overshoot.projects[1].amountLeft, -0.000015) && close(stranded.projects[1].amountLeft, 0.00003))

  // A stock that exactly covers a build is not a cut.
  const exact = run([enginePoint(1, 100, 3, 1, { fuel: 0.1 })], { stock: { fuel: 0.3 } }).projects[1]

  holds('exactCover', 'ENGINE a stock that exactly covers a build is not a cut: 3 units at 0.1 of fuel against a stock of 0.3 finish in the first cycle with no cut reported', exact.finish === 1 && exact.cut === null && near(exact.built, 3))

  // The doubles of the save read the way the platform reads them, and what a read that differs in the last digit does to a forecast.
  const nativeRead = engine.forecastColony({ projects: [enginePoint(1, 100, 0.1, 6.072675875386635, {}, { PartialCompletion: 0.9 })], capacities: { construction: 0.0151816896884666 }, stock: {}, cycleDays: 36.5 }).projects[1]
  holds('nativeForecast', 'ENGINE a cost that prints as 6.072675875386635 and is read as 6.07267587538664 (the platform\'s own read, not the number printed to 15 digits) gives a first build of 0.0002 and a finish in 18250 days, where the printed read, 6.07267587538663, gives 0.0003 and 12191 days', nativeRead.firstBuild === 0.0002 && nativeRead.finish === 18250)

  // Taking steady stretches in one step is exact: the stock the game's own additions would round on the way is not jumped, and a stalled project does not hold the others back.
  const abcProjects = [enginePoint(1, 100, 1, 10000, { Duranium: 0.000099999999999 }), enginePoint(2, 100, 1, 1, { Duranium: 9999999999.9999 }, { Queue: 1 }), enginePoint(3, 100, 0.0001, 1, { Duranium: 1e-11 }, { Queue: 2, PartialCompletion: 0.9999 })]
  const abcRun = (stepwise) => engine.forecastColony({ projects: abcProjects, capacities: { construction: 365 }, stock: { Duranium: 1e10 }, cycleDays: 1, stepwise })
  const [abcJumped, abcStepped] = [abcRun(false), abcRun(true)]
  const crowd = (perUnit) => ({ projects: Array.from({ length: 20 }, (_, index) => enginePoint(index + 1, 5, 1, perUnit, { [index < 10 ? 'Duranium' : (index < 15 ? 'Corbomite' : 'Neutronium')]: 1 })), capacities: { construction: 730 }, stock: { Duranium: 0.1, Corbomite: 100, Neutronium: 100 }, cycleDays: 1 })
  const sameRun = (a, b) => JSON.stringify(a.projects) === JSON.stringify(b.projects) && JSON.stringify(a.events) === JSON.stringify(b.events) && JSON.stringify(a.left) === JSON.stringify(b.left) && JSON.stringify(a.orders) === JSON.stringify(b.orders)
  const crowdStepped = engine.forecastColony({ ...crowd(200), stepwise: true })

  holds('jumpExact', 'ENGINE a stretch of steady cycles is taken in one step only where each of the game\'s own additions would be exact: three projects sharing 1e10 t of Duranium (one that takes 0.000099999999999 t a unit for 10000 cycles, then 9999999999.9999 t, then 1e-11 t a unit of 0.0001 left) give, jumped and cycle by cycle, the same finishes (10000, 10001 and never: the stock the rounding on the way leaves is exactly 0), events and stock; and twenty projects, ten of them stalled on a stock that runs out, give the same figures, events, orders and stock in either way', sameRun(abcJumped, abcStepped) && abcJumped.projects[1].finish === 10000 && abcJumped.projects[2].finish === 10001 && abcJumped.projects[3].finish === null && abcJumped.left.Duranium === 0 && abcStepped.projects[3].finish === null && sameRun(engine.forecastColony(crowd(200)), crowdStepped) && Object.values(crowdStepped.projects).filter((figure) => figure.finish === 2000).length === 10)

  // The additions the jump relies on, against a count of the game's additions one at a time: how many repeats of a sum of terms on a start the type adds without rounding, and the sum of that many.
  const atScale = (value, scale) => value.m * 10n ** BigInt(scale - value.s)
  const REPEAT_CAP = 70

  const exactRepeats = (start, deltas) => {
    let value = start

    for (let count = 0; count < REPEAT_CAP; count++) {
      for (const delta of deltas) {
        const scale = Math.max(value.s, delta.s)
        let got = null

        try {
          got = decimal.add(value, delta)
        } catch (error) {
          return count
        }

        const wide = Math.max(scale, got.s)

        if (atScale(got, wide) !== (atScale(value, scale) + atScale(delta, scale)) * 10n ** BigInt(wide - scale)) {
          return count
        }

        value = got
      }
    }

    return REPEAT_CAP
  }

  const REPEATS = [
    ['79228162514264337593543000000', ['100000']],
    ['79228162514264337593543450336', ['100000']],
    ['10000000000000000000000000000', ['-0.5']],
    ['5000000000000000000000000000', ['-0.3']],
    ['3000000000000000000000000000', ['-0.1', '-0.25']],
    ['0.0000000000000000000000000001', ['1']],
    ['7922816251426433759354', ['0.1', '0.25']],
    ['7922816251426433759', ['-0.0000000001', '-0.0000000002']],
    ['0.5', ['-0.000000000000000000000001', '-0.0000000000000000000000002']],
    ['-79228162514264337593543000000', ['-100000']],
  ].map(([start, deltas]) => ({ start: decimal.fromString(start), deltas: deltas.map((text) => decimal.fromString(text)) }))

  const repeated = REPEATS.map(({ start, deltas }) => ({ expected: exactRepeats(start, deltas), got: Math.min(decimal.additions(start, deltas), REPEAT_CAP), sum: (count) => Array.from({ length: count }).reduce((value) => deltas.reduce((total, delta) => decimal.add(total, delta), value), start), start, deltas }))
  const sumsMatch = (entry) => {
    try {
      return decimal.equal(decimal.addMultiple(entry.start, entry.deltas, entry.got), entry.sum(entry.got))
    } catch (error) {
      return false
    }
  }

  const sumsAgree = repeated.every(sumsMatch)

  holds('additions', 'DECIMAL the number of times the sum of some terms can be added to a start with every addition exact is the count of the additions made one at a time, and the sum of that many is the one made one at a time: a start that does not fit on the finest scale of its terms gives 0, a sum that reaches 2^96 exactly is not exact, positive and negative terms, mixed scales, and sums that never reach the limit', repeated.every((entry) => entry.expected === entry.got) && sumsAgree && repeated.some((entry) => entry.got === 0) && repeated.some((entry) => entry.got > 0 && entry.got < REPEAT_CAP) && repeated.some((entry) => entry.got === REPEAT_CAP))

  // A forecast taken a slice at a time: the engine looks at the pace at the start of every cycle or stretch of cycles, so no more than one of them is done between two yields, and what it returns is what the forecast run to its end returns.
  const sliceSteps = (input, pace) => {
    const steps = engine.forecastColonySteps(input, pace)
    let yields = 0
    let step = steps.next()

    while (!step.done) {
      yields += 1
      step = steps.next()
    }

    return { yields, value: step.value }
  }

  const looks = { count: 0 }
  const always = { expired: () => { looks.count += 1; return true } }
  const never = { expired: () => false }
  const crowdSliced = sliceSteps(crowd(1000), always)
  const crowdLooks = looks.count
  const steppedSliced = sliceSteps({ ...crowd(200), stepwise: true }, always)

  holds('slices', 'ENGINE a forecast taken a slice at a time yields wherever the pace says the time is up, at the start of every cycle or stretch of cycles and between projects: twenty projects (ten stalled on a stock that runs out) with a pace always up yield once for every look at it, between 5 and 2000 times (a stalled project does not keep the steady stretches of the others from being taken in one step), and taken cycle by cycle (2000 cycles in each of the two runs) at least 4000 times, with the figures of the forecast run to its end in both, and a pace never up yields nothing', crowdSliced.yields === crowdLooks && crowdSliced.yields >= 5 && crowdSliced.yields < 2000 && JSON.stringify(crowdSliced.value) === JSON.stringify(engine.forecastColony(crowd(1000))) && steppedSliced.yields >= 4000 && steppedSliced.yields === looks.count - crowdLooks && JSON.stringify(steppedSliced.value) === JSON.stringify(crowdStepped) && sliceSteps(crowd(1000), never).yields === 0)

  // The look at the pace at the start of a cycle is the only one a colony of a single project has (there is no turn of another project to look between).
  const loneStepped = sliceSteps({ projects: [enginePoint(1, 100, 100, 1)], capacities: { construction: 365 }, stock: {}, cycleDays: 1, stepwise: true }, { expired: () => true })

  holds('loneSlices', 'ENGINE a colony of one project taken cycle by cycle with a pace always up (100 cycles in each of its two runs) yields at least 200 times, once at the start of every cycle, and gives the same figures as the run to its end (finish on day 100)', loneStepped.yields >= 200 && loneStepped.value.projects[1].finish === 100 && JSON.stringify(loneStepped.value) === JSON.stringify(engine.forecastColony({ projects: [enginePoint(1, 100, 100, 1)], capacities: { construction: 365 }, stock: {}, cycleDays: 1, stepwise: true })))

  // A project whose last build is cut by the fuel to exactly the part of a unit it has left finishes exactly: no fine remainder, and its successor starts.
  const exactFine = engine.forecastColony({ projects: [enginePoint(1, 100, 3, 1, { fuel: 2 }), enginePoint(2, 100, 1, 1, {}, { Queue: 1 })], capacities: { construction: 365 }, stock: { fuel: 1.00003 }, cycleDays: 1, arrivals: [{ resource: 'fuel', day: 2, quantity: 4.99997 }] })

  const twice = engine.forecastColony({ projects: [enginePoint(1, 100, 3, 1, { fuel: 2 }), enginePoint(2, 100, 1, 1, {}, { Queue: 1 })], capacities: { construction: 365 }, stock: { fuel: 1.00003 }, cycleDays: 1, arrivals: [{ resource: 'fuel', day: 2, quantity: 4.5 }, { resource: 'fuel', day: 6, quantity: 0.49997 }] })

  holds('exactRemainder', 'ENGINE a project whose last build is cut by the fuel to exactly the part of a unit it has left (3 units at 2 of fuel a unit, 1.00003 held and 4.99997 more on day 2) finishes in cycle 4 with no fine remainder flagged, and the project queued behind it starts in cycle 4 and finishes in cycle 5; so does one an earlier attempt left a part of a unit finer than a build (4.5 more on day 2 and 0.49997 on day 6: finishes in cycle 6, successor in cycle 7); a limit that leaves a part the build misses (1.00014 held and 100 more on day 2) is still flagged', exactFine.projects[1].finish === 4 && exactFine.projects[1].outcome === 'finishes' && !exactFine.projects[1].fineRemainder && exactFine.projects[2].start === 4 && exactFine.projects[2].finish === 5 && twice.projects[1].finish === 6 && twice.projects[1].delivered === 3 && !twice.projects[1].fineRemainder && twice.projects[2].start === 6 && twice.projects[2].finish === 7 && stranded.projects[1].fineRemainder && overshoot.projects[1].fineRemainder)

  // A stretch of cycles must not run past the first cycle in which the game's check of the stock against the build before rounding cuts it, though the rounded build still fits (the cut is a result: its day and its event).
  const capProject = (extra = {}) => enginePoint(1, extra.Percentage || 100, 0.001, 1000, { Duranium: 1 }, { PartialCompletion: 0.999, ...extra })
  const capRun = (stock, stepwise, arrivals = [{ resource: 'Duranium', day: 5, quantity: 1 }], second = false) => engine.forecastColony({ projects: second ? [capProject({ Percentage: 50 }), enginePoint(2, 50, 0.0009, 1000, { Duranium: 1 })] : [capProject()], capacities: { construction: second ? 102.2 : 51.1 }, stock: { Duranium: stock }, cycleDays: 1, arrivals, stepwise })
  const capJumped = capRun(0.00032, false)
  const capStepped = capRun(0.00032, true)
  const capGrid = [0.00014, 0.0002, 0.00022, 0.00032, 0.00041, 0.0005, 0.00069, 0.0008, 0.00105].flatMap((stock) => [false, true].map((second) => [stock, second]))
  const capSame = capGrid.filter(([stock, second]) => sameRun(capRun(stock, false, [{ resource: 'Duranium', day: 9, quantity: 1 }], second), capRun(stock, true, [{ resource: 'Duranium', day: 9, quantity: 1 }], second)))

  holds('capJump', 'ENGINE a stretch of steady cycles stops before the first cycle the stock check cuts: a project of 0.001 with 0.999 done (0.00014 of a unit a cycle, built as 0.0001) on 0.00032 t of a mineral it needs 1 t of a unit of, and 1 t arriving on day 5, is cut by the stock from cycle 3 (0.00012 t is under the 0.00014 it would build before rounding) and builds 0.0001 all the same, the same in a stretch and cycle by cycle (the same cut day, event, finish and figures), as are eighteen more cases of one or two projects on stocks from 0.00014 to 0.00105 t', capJumped.projects[1].cut !== null && capJumped.projects[1].cut.day === 3 && capJumped.events.some((event) => event.type === 'cut' && event.cycle === 3) && capStepped.projects[1].cut.day === 3 && sameRun(capJumped, capStepped) && capSame.length === capGrid.length)

  // The fuel is checked against the rounded build, so a stretch must stop where the fuel runs short of one: 5.5 of fuel at 1 a unit builds 1 unit in each of 5 cycles and 0.5 in the sixth, as cycle by cycle.
  const fuelRun = (stock, stepwise) => engine.forecastColony({ projects: [enginePoint(1, 100, 100, 1, { fuel: 1 })], capacities: { construction: 365 }, stock: { fuel: stock }, cycleDays: 1, arrivals: [{ resource: 'fuel', day: 30, quantity: 1 }], stepwise })
  const [fuelJumped, fuelStepped] = [fuelRun(5.5, false), fuelRun(5.5, true)]

  holds('fuelJump', 'ENGINE a stretch of steady cycles stops where the fuel runs short of a build: a project of 100 units at 1 of fuel a unit and 1 unit a cycle on 5.5 of fuel builds 5.5 units before 1 more arrives on day 30, cut by the fuel from cycle 6, and the stretch and cycle by cycle give the same cut day, events, stock and figures', sameRun(fuelJumped, fuelStepped) && fuelJumped.projects[1].cut !== null && fuelJumped.projects[1].cut.resource === 'fuel' && fuelJumped.projects[1].cut.day === 6 && Math.abs(fuelJumped.projects[1].built - 6.5) < 1e-9)

  // A wide cohort finishing in one cycle (1000 projects of 0.1% each, one unit at one point a unit, nothing queued, and again 500 running with 500 queued behind them), taken a project at a time with a pace always up. The work is counted in results the decimal type makes (the copy of the module the case runs on counts them): between two yields no more than a few for each project in the colony (one project's turn, or the setup of a cycle or a stretch), and in all a few dozen for each, where adding up the share the others hold at every finish makes half a million.
  const paced = (input) => {
    const steps = engine.forecastColonySteps(input, { expired: () => true })
    const begin = decimal.operations.count
    let from = begin
    let widest = 0
    let yields = 0
    let step = steps.next()

    while (!step.done) {
      widest = Math.max(widest, decimal.operations.count - from)
      yields += 1
      from = decimal.operations.count
      step = steps.next()
    }

    widest = Math.max(widest, decimal.operations.count - from)

    return { yields, widest, operations: decimal.operations.count - begin, value: step.value, input }
  }

  const wideRun = (count, queued = 0) => {
    const projects = [...Array.from({ length: count }, (_, index) => enginePoint(index + 1, 0.1, 1, 1)), ...Array.from({ length: queued }, (_, index) => enginePoint(count + index + 1, 0.1, 1, 1, {}, { Queue: index + 1 }))]

    return paced({ projects, capacities: { construction: 365000 }, stock: {}, cycleDays: 1 })
  }

  const cohort = wideRun(1000)
  const [cohortSmall, cohortBehindSmall] = [wideRun(100), wideRun(50, 50)]
  const cohortBehind = wideRun(500, 500)
  const cohortFigures = Object.values(cohort.value.projects)
  const cohortQueued = cohortBehind.value.projects

  holds('wideCohort', 'ENGINE a colony of 1000 projects of 0.1% each that all finish on day 1 (one unit each), forecast a project at a time with a pace always up, does between two yields no more than 40 operations of the decimal type (one project\'s turn, or the setup of a cycle), in all no more than 40 for each project (the share the others hold is kept, not added up again at every finish), yields at least 6 more times for each project the colony has than a colony of 100 does (set-up, the contention scan and the turns of the run, the same two in the run with all the stock, the figures), and gives the figures of the run to its end; with 500 queued behind 500 running, the queued start and finish on days 1 and 2, with the same yields for each project, no more than 3 operations for each queued project between two yields (the queued start together when the first running one finishes) and no more than 40 for each in all', cohortFigures.length === 1000 && cohortFigures.every((figure) => figure.finish === 1 && figure.built === 1 && figure.delivered === 1) && cohort.yields - cohortSmall.yields >= 6 * 900 && cohort.widest <= 40 && cohort.operations <= 40 * 1000 && JSON.stringify(cohort.value) === JSON.stringify(engine.forecastColony(cohort.input)) && [...Array(500).keys()].every((index) => cohortQueued[index + 1].finish === 1 && cohortQueued[index + 501].start === 1 && cohortQueued[index + 501].finish === 2) && cohortBehind.yields - cohortBehindSmall.yields >= 6 * 900 && cohortBehind.widest <= 3 * 500 && cohortBehind.operations <= 40 * 1000)

  // The source installations a conversion draws on: one is kept back for each converting project in a stretch of steady cycles, because a whole unit delivered in the cycle takes one. A conversion of 20 units with half a unit done, at 0.4 of a unit a cycle with one installation, builds 0.4 and 0.4, delivers its unit in the second cycle (0.3 left over) and is cut by the source in the third: taken in one step or cycle by cycle.
  const reserveRun = (stepwise) => engine.forecastColony({ projects: [enginePoint(1, 100, 20, 1, {}, { PartialCompletion: 0.5, source: SOURCE_KEY })], capacities: { construction: 146 }, stock: { [SOURCE_KEY]: 1 }, cycleDays: 1, horizonDays: 50, stepwise })
  const [reserveJumped, reserveStepped] = [reserveRun(false), reserveRun(true)]

  holds('sourceReserve', 'ENGINE a stretch of steady cycles keeps one source installation back for each converting project: a conversion of 20 units with 0.5 done, 146 points a year (0.4 of a unit a cycle) and 1 installation builds 0.8 units, delivers 1 and keeps 0.3 of a unit, cut by the source from cycle 3, the same in a stretch and cycle by cycle', sameRun(reserveJumped, reserveStepped) && near(reserveJumped.projects[1].built, 0.8) && reserveJumped.projects[1].delivered === 1 && near(reserveJumped.projects[1].partial, 0.3) && reserveJumped.projects[1].cut !== null && reserveJumped.projects[1].cut.resource === SOURCE_KEY && reserveJumped.projects[1].cut.day === 3)

  // The share the running and paused projects of a kind hold is kept as a running total only where the type adds the kind's shares exactly in any order; otherwise it is added up again, in the order of the projects as the game adds it, when a finish has a queued project to admit, because a total that has been rounded and then had a finished share taken off is not that sum. A 99% project finishing with two paused projects of 1.00000000000004e-13% held and 99.9999999999998% queued behind them: the platform's own arithmetic leaves 99.99999999999979999999999999 of the 100% after the two (the literal below is its result), less than the queued share, and a running total taken to the nearest digit leaves 99.9999999999998, which would admit it.
  const tinyShare = 1.00000000000004e-13
  const tinyDecimal = decimal.fromDouble(tinyShare)
  const heldRun = engine.forecastColony({ projects: [enginePoint(1, 99, 1, 1), enginePoint(2, tinyShare, 1, 1, {}, { Paused: 1 }), enginePoint(3, tinyShare, 1, 1, {}, { Paused: 1 }), enginePoint(4, 99.9999999999998, 1, 1, {}, { Queue: 1 })], capacities: { construction: 36500 }, stock: {}, cycleDays: 1, horizonDays: 5 })
  const heldOrdered = decimal.subtract(decimal.fromDouble(100), decimal.add(tinyDecimal, tinyDecimal))
  const heldRunning = decimal.subtract(decimal.fromDouble(100), decimal.subtract(decimal.add(decimal.add(decimal.fromDouble(99), tinyDecimal), tinyDecimal), decimal.fromDouble(99)))
  const heldQueued = decimal.fromDouble(99.9999999999998)
  const heldExact = engine.forecastColony({ projects: [enginePoint(1, 60, 1, 1), enginePoint(2, 20, 1, 1, {}, { Paused: 1 }), enginePoint(3, 80, 1, 1, {}, { Queue: 1 })], capacities: { construction: 36500 }, stock: {}, cycleDays: 1, horizonDays: 5 })

  holds('heldSum', 'ENGINE the share the running and paused projects hold is the game\'s ordered sum, not a total rounded once and then reduced: with a 99% project finishing, two paused projects of 1.00000000000004e-13% held and 99.9999999999998% queued, the type\'s sum leaves 99.99999999999979999999999999 (the platform\'s own figure), under the queued share, so the queued project has no start and no finish and no start event, while a running total leaves 99.9999999999998, which would admit it (the type says the four shares cannot be added exactly in any order); where the shares do add exactly (60% running, 20% paused, 80% queued) the queued project starts on day 1 and finishes on day 2', decimal.equal(heldOrdered, decimal.fromString('99.99999999999979999999999999')) && decimal.less(heldOrdered, heldQueued) && decimal.equal(heldRunning, decimal.fromString('99.9999999999998')) && !decimal.less(heldRunning, heldQueued) && !decimal.sumsExactly([99, tinyShare, tinyShare, 99.9999999999998].map(decimal.fromDouble)) && decimal.sumsExactly([60, 20, 80].map(decimal.fromDouble)) && heldRun.projects[4].start === null && heldRun.projects[4].finish === null && heldRun.projects[4].outcome === 'queued' && heldRun.projects[4].built === 0 && !heldRun.events.some((event) => event.type === 'start' && event.id === 4) && heldExact.projects[3].start === 1 && heldExact.projects[3].finish === 2)

  // Where the shares cannot be added exactly the sum is made again at each finish that has a queued project to admit, a member at a time with a look at the pace between them: 200 projects of 0.5% finishing on day 1 with a paused project of 1.00000000000004e-13% and a project of 99.5% queued behind them, which starts when the last of the 200 finishes and not before.
  const heldPaced = paced({ projects: [...Array.from({ length: 200 }, (_, index) => enginePoint(index + 1, 0.5, 1, 0.5)), enginePoint(201, tinyShare, 1, 1, {}, { Paused: 1 }), enginePoint(202, 99.5, 1, 99.5, {}, { Queue: 1 })], capacities: { construction: 36500 }, stock: {}, cycleDays: 1 })

  holds('heldPaced', 'ENGINE where a kind\'s shares cannot be added exactly the sum of the share held is made again at a finish that has a queued project to admit, a project at a time with a look at the pace between them: 200 projects of 0.5% finishing on day 1 with a paused project of 1.00000000000004e-13% and a project of 99.5% queued behind them start the queued project on day 1 (when the last finishes, not before) and finish it on day 2, with no more than 40 operations of the decimal type between two yields', heldPaced.value.projects[202].start === 1 && heldPaced.value.projects[202].finish === 2 && Object.values(heldPaced.value.projects).filter((figure) => figure.finish === 1).length === 200 && heldPaced.widest <= 40)

  // A negative share (the page's validity check lets one through) is not exactly addable in any order even where the sum of all the shares fits: the kind's shares 40 (running), 40 and 3e-27 (paused), 60 (queued first) and -100 (queued second) sum to 40.000000000000000000000000003, which fits, but the three held at the start sum to 80.000000000000000000000000003, which does not, so the game's ordered sum rounds it to 80 and a total reduced by the first project's 40 leaves 40, where the ordered sum of the two still held leaves 40.000000000000000000000000003 and the queued 60% does not fit in what is left of the 100% (the -100% one behind it does, and starts). No clamp, no dropped project: the kind keeps the ordered arithmetic, and shares that are all 0 are still added exactly.
  const negativeRun = engine.forecastColony({ projects: [enginePoint(1, 40, 1, 1), enginePoint(2, 40, 1, 1, {}, { Paused: 1 }), enginePoint(3, 3e-27, 1, 1, {}, { Paused: 1 }), enginePoint(4, 60, 1, 1, {}, { Queue: 1 }), enginePoint(5, -100, 1, 1, {}, { Queue: 2 })], capacities: { construction: 36500 }, stock: {}, cycleDays: 1, horizonDays: 5 })
  const negativeShares = [40, 40, 3e-27, 60, -100].map(decimal.fromDouble)
  const negativeHeld = decimal.add(decimal.fromDouble(40), decimal.fromDouble(3e-27))
  const negativeLeft = decimal.subtract(decimal.fromDouble(100), negativeHeld)

  holds('heldNegative', 'ENGINE a kind whose shares include a negative one is not added exactly in any order even where their sum fits (40 running, 40 and 3e-27 paused, 60 queued first and -100 queued second): the sum of all five fits but the type rounds the three held at the start, so the running total is not kept, the share the two still held leave is the ordered 59.999999999999999999999999997, under the queued 60, so the queued 60% has no start, no finish and no start event, while the -100% project behind it, which fits in what is left, starts on day 1 as the ordered arithmetic has it (no clamp, no dropped project: all five are in the figures); shares that are all 0 are added exactly, and a negative one is not', !decimal.sumsExactly(negativeShares) && decimal.sumsExactly([0, 0].map(decimal.fromDouble)) && decimal.sumsExactly([40, 60].map(decimal.fromDouble)) && !decimal.sumsExactly([40, -100].map(decimal.fromDouble)) && decimal.less(negativeLeft, decimal.fromDouble(60)) && decimal.equal(negativeLeft, decimal.fromString('59.999999999999999999999999997')) && negativeRun.projects[4].start === null && negativeRun.projects[4].finish === null && negativeRun.projects[4].outcome === 'queued' && !negativeRun.events.some((event) => event.type === 'start' && event.id === 4) && negativeRun.projects[5].start === 1 && negativeRun.events.some((event) => event.type === 'start' && event.id === 5 && event.cycle === 1) && negativeRun.projects[1].finish === 1 && Object.keys(negativeRun.projects).length === 5)

  // A wide cohort that holds minerals takes a steady stretch of cycles (1000 projects of 0.1%, 100 units each at 11 points a unit, one tonne of each of the eleven minerals a unit, 1000000 t of each, one cycle a day: every project finishes on day 100 with 900000 t of each mineral left): the working out of the stretch and the applying of it look at the pace between one project and the next, and the work between two looks is one project's, in operations of the decimal type.
  const mineralNeeds = Object.fromEntries(MINERAL_NAMES.map((name) => [name, 1]))
  const mineralStock = Object.fromEntries(MINERAL_NAMES.map((name) => [name, 1000000]))
  const mineralRun = paced({ projects: Array.from({ length: 1000 }, (_, index) => enginePoint(index + 1, 0.1, 100, 11, mineralNeeds)), capacities: { construction: 4015000 }, stock: mineralStock, cycleDays: 1 })
  const mineralFigures = Object.values(mineralRun.value.projects)

  holds('wideMinerals', 'ENGINE a steady stretch of a colony of 1000 projects that each take one tonne of eleven minerals a unit (100 units each at 1 unit a cycle, 1000000 t of each mineral) is worked out and applied a project at a time with a pace always up, with no more than 150 operations of the decimal type between two yields and no more than 600 for each project in all: every project finishes on day 100 having built and delivered 100 units, each mineral has 900000 t left, and the result is the same as the run unpaced', mineralFigures.length === 1000 && mineralFigures.every((figure) => figure.finish === 100 && figure.built === 100 && figure.delivered === 100) && MINERAL_NAMES.every((name) => mineralRun.value.left[name] === 900000) && mineralRun.widest <= 150 && mineralRun.operations <= 600 * 1000 && JSON.stringify(mineralRun.value) === JSON.stringify(engine.forecastColony(mineralRun.input)))

  // A wide colony in contention (100 projects of 1% that each need one tonne of one mineral, 50 t held: 50 of them finish on day 1 in the base order, and in other orders other 50 do): the cycle's contention scan looks at the pace between projects and between the entries of one mineral, and each order's run is folded into the figures as it ends and let go (`kept`, the runs whose states are still held at the end, is the first run only, whatever the number of orders tried).
  const contestedRun = paced({ projects: Array.from({ length: 100 }, (_, index) => enginePoint(index + 1, 1, 1, 1, { Duranium: 1 })), capacities: { construction: 36500 }, stock: { Duranium: 50 }, cycleDays: 1 })
  const contestedFigures = contestedRun.value.projects

  holds('wideContested', 'ENGINE a colony of 100 projects of 1% that each need one tonne of one mineral of which 50 t are held, forecast with a pace always up, scans the contention of a cycle a project at a time (no more than 40 operations of the decimal type between two yields), tries more than 100 orders without trying them all, holds the states of one run only when the figures are made (`kept` is 1 though many orders were tried), and gives project 1 a day-1 finish in the base order (earliest day 1, no latest: in some orders it stalls) and project 100 a stall in the base order and a day-1 finish in some orders', contestedRun.widest <= 40 && contestedRun.value.orders.tried > 100 && !contestedRun.value.orders.exhaustive && contestedRun.value.orders.kept === 1 && contestedRun.value.orders.contested.length === 100 && contestedFigures[1].finish === 1 && contestedFigures[1].earliest === 1 && contestedFigures[1].latest === null && contestedFigures[100].finish === null && contestedFigures[100].outcome === 'stalls' && contestedFigures[100].earliest === 1 && contestedFigures[100].latest === null && contestedFigures[100].stallOrders === 'some')

  // The resources of a stretch each add up one entry per project, so the working out and the applying look at the pace between resources too: a project that takes eleven minerals yields 30 more times than one that takes one (ten more in each of the three passes that apply a stretch or work one out: the working out and the applying of the run, and the applying of the run with all the stock).
  const loneNeeds = (count) => paced({ projects: [enginePoint(1, 100, 100, 1, Object.fromEntries(MINERAL_NAMES.slice(0, count).map((name) => [name, 1])))], capacities: { construction: 365 }, stock: mineralStock, cycleDays: 1 })
  const [loneOne, loneMany] = [loneNeeds(1), loneNeeds(11)]

  holds('resourceLooks', 'ENGINE a stretch of steady cycles of one project that takes eleven minerals a unit yields 30 more times with a pace always up than the same project taking one (ten more at each of three places: the working out of the stretch, its applying in the run, and its applying in the run with all the stock), and both finish on day 100', loneOne.value.projects[1].finish === 100 && loneMany.value.projects[1].finish === 100 && loneMany.yields - loneOne.yields >= 30)

  // What the figures keep of a project over the orders is folded in as each run ends (`foldState`) and must be what the least, most, any and every over the whole list of runs give.
  const entryOf = (finishCycle, startCycle, cut, built, fineRemainder) => ({ finishCycle, startCycle, firstCut: cut === null ? null : { cycle: cut, resource: 'Duranium' }, built: decimal.fromString(built), fineRemainder })

  const tallyLists = [
    [entryOf(3, 0, null, '1', false), entryOf(5, 0, 2, '1', false), entryOf(null, 1, 4, '0.5', true)],
    [entryOf(null, null, null, '0', false), entryOf(null, null, null, '0', false)],
    [entryOf(7, 2, 3, '2.5', false), entryOf(4, 2, 3, '2.5', false), entryOf(9, 1, 6, '2.5001', false), entryOf(4, 4, null, '0.0001', false)],
    [entryOf(2, 0, null, '1', false)],
    [entryOf(null, 3, 5, '1', false), entryOf(6, 3, 8, '1', false)],
    [entryOf(6, 3, 8, '1', false), entryOf(null, 3, 5, '1', false), entryOf(6, null, null, '1.5', false)],
  ]

  const tallied = (list) => {
    const tally = engine.tallyOf(list[0])

    list.forEach((entry) => engine.foldState(tally, entry, list[0]))

    return { ...tally, buildLow: decimal.toNumber(tally.buildLow), buildHigh: decimal.toNumber(tally.buildHigh) }
  }

  const tallyExpected = (list) => {
    const finishes = list.map((entry) => entry.finishCycle)
    const finished = finishes.filter((cycle) => cycle !== null)
    const starts = list.map((entry) => entry.startCycle)
    const started = starts.filter((cycle) => cycle !== null)
    const cuts = list.filter((entry) => entry.firstCut).map((entry) => entry.firstCut.cycle)
    const builds = list.map((entry) => decimal.toNumber(entry.built))

    return {
      runs: list.length,
      finished: finished.length,
      finishLow: Math.min(...finished),
      finishHigh: Math.max(...finished),
      finishDiffers: finishes.some((cycle) => cycle !== finishes[0]),
      started: started.length,
      startLow: Math.min(...started),
      startHigh: Math.max(...started),
      startDiffers: starts.some((cycle) => cycle !== starts[0]),
      unfinished: list.length - finished.length,
      cut: cuts.length,
      cutLow: Math.min(...cuts),
      cutHigh: Math.max(...cuts),
      fineRemainder: list.some((entry) => entry.fineRemainder),
      buildLow: Math.min(...builds),
      buildHigh: Math.max(...builds),
      buildDiffers: list.some((entry) => !decimal.equal(entry.built, list[0].built)),
    }
  }

  holds('tally', 'ENGINE what the figures keep of a project over the orders, folded in one run at a time, is the least, most, any and every over the whole list: the runs that finished, started and were cut, the first and last cycle of each, whether any differs from the first, the least and most built, and whether a fine remainder was left (six lists, from a single run to runs that never start)', tallyLists.every((list) => JSON.stringify(tallied(list)) === JSON.stringify(tallyExpected(list))))

  return results
}

// The page's forecast of a colony (production.industryForecast) on synthetic rows: the figures it hands the page and what it declines to forecast.
const wrapperCases = ({ production, provenance, 'industry-cycle': engine }) => {
  const results = []
  const holds = (statement, condition, key = null) => results.push([statement, Boolean(condition), key])
  const row = (extra = {}) => ({ ID: 1, ProductionType: 0, PopulationID: 7, Percentage: 100, Amount: 4, PartialCompletion: 0, ProdPerUnit: 2, Queue: 0, Paused: 0, FuelRequired: 0, StockFuel: 0, ConversionFrom: null, ConversionSource: null, ...Object.fromEntries(MINERAL_NAMES.flatMap((name) => [[name, 0], [`Stock${name}`, 0]])), ...extra })
  const capacities = Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, provenance.ofRule({ rule: 'production.industryRate', value: SYNTHETIC.capacity, inputs: { present: ['the colony\'s capacity'] } })]))
  const modifiers = { MinConstructionPeriod: 86400 }
  const forecast = (projects, extra = {}) => production.industryForecast({ projects, capacities, modifiers, ...extra })
  const needy = row({ Duranium: 10 })
  const dry = forecast([needy])

  holds('WRAPPER a project the stock cannot finish has no date and says why: idle, short of Duranium, the units the stock covers (none), and the date it would have with the Duranium (day 1)', dry.figures[0].finish.idle && dry.figures[0].shortage.name === 'Duranium' && dry.figures[0].covers !== null && dry.figures[0].supplied === 1 && dry.figures[0].forecast.outcome === 'stalls' && dry.figures[0].start === 0)

  const fedForecast = forecast([needy], { arrivals: [{ resource: 'Duranium', day: 3, quantity: 40 }, { resource: 'Unobtainium', day: 1, quantity: 5 }, { resource: 'Duranium', day: 2, quantity: -5 }] })
  const fedFinish = fedForecast.figures[0].finish

  holds('WRAPPER an arrival entered gives the finish (day 3), as an estimate that names the arrival and not as observed stock; an unknown resource and a negative quantity are not counted; with none entered the date says no minerals arrive', !fedFinish.idle && fedFinish.result.value === 3 && fedFinish.result.status !== 'confirmed' && fedFinish.result.assumptions.some((text) => /arrival/.test(text)) && !fedFinish.result.assumptions.some((text) => /No minerals arrive/.test(text)) && forecast([row()]).figures[0].finish.result.assumptions.some((text) => /No minerals arrive/.test(text)))

  const contested = forecast([row({ ID: 1, Percentage: 60, Amount: 4, StockDuranium: 40, Duranium: 10 }), row({ ID: 2, Percentage: 40, Amount: 4, StockDuranium: 40, Duranium: 10 })], { arrivals: [{ resource: 'Duranium', day: 3, quantity: 20 }, { resource: 'Duranium', day: 6, quantity: 20 }] })

  holds('WRAPPER two jobs whose order decides who finishes first get a range (earliest and latest), and the date is the earliest', contested.figures.every((figure) => figure.range !== null && figure.range.earliest < figure.range.latest && figure.finish.result.value === figure.range.earliest) && contested.orders.dependent)

  const crowdRows = [[1, 4, 2, 2, 0], [2, 5, 2, 1, 0], [3, 4, 2, 1, 2], [4, 2, 3, 2, 1], [5, 4, 3, 1, 1], [6, 4, 2, 1, 1]].map(([ID, Amount, ProdPerUnit, Duranium, Corbomite]) => row({ ID, Percentage: 16, Amount, ProdPerUnit, Duranium, Corbomite, StockDuranium: 10, StockCorbomite: 5 }))
  const crowdJob = (id) => ({ id, share: 16, perUnit: crowdRows[id - 1].ProdPerUnit, amount: crowdRows[id - 1].Amount, partial: 0, needs: { Duranium: crowdRows[id - 1].Duranium, Corbomite: crowdRows[id - 1].Corbomite } })
  const crowd = forecast(crowdRows, { arrivals: [{ resource: 'Duranium', day: 3, quantity: 16 }, { resource: 'Corbomite', day: 4, quantity: 11 }] })
  const crowdOrder = campaign({ jobs: [2, 4, 5, 6, 1, 3].map(crowdJob), stock: { Duranium: 10, Corbomite: 5 }, arrivals: { 3: { Duranium: 16 }, 4: { Corbomite: 11 } }, capacity: SYNTHETIC.capacity, years: SYNTHETIC.years })
  const crowded = crowd.figures[0]

  holds('WRAPPER six jobs in contention cannot be tried in every order: the reference model finishes job 1 on day 6 in an order the sample misses, so the engine says the orders were sampled and gives job 1 a sampled range (its latest of the orders tried is day 5) and not a plain date', crowdOrder[1] === 6 && !crowd.orders.exhaustive && crowded.sampled === crowd.orders.tried && crowded.range.sampled === true && crowded.range.latest < crowdOrder[1] && crowded.finish.result.assumptions.some((text) => /sampled/.test(text)), 'sampled')

  const starts = forecast([row({ ID: 1, Percentage: 40, Amount: 1, ProdPerUnit: 1, Duranium: 1, StockDuranium: 1 }), row({ ID: 2, Percentage: 60, Amount: 1, ProdPerUnit: 1, Duranium: 1, StockDuranium: 1 }), row({ ID: 3, Percentage: 60, Amount: 1, ProdPerUnit: 1, Queue: 1, StockDuranium: 1 })], { arrivals: [{ resource: 'Duranium', day: 10, quantity: 1 }] })
  const waiting = starts.figures[2]

  holds('WRAPPER a queued job that starts on day 1 or on day 10 by the order of the two jobs ahead gets the earliest start (day 1, before its earliest finish, day 2) and a start range up to day 10, and not the start of the base order', waiting.start === 1 && waiting.startRange !== null && waiting.startRange.earliest === 1 && waiting.startRange.latest === 10 && waiting.finish.result.value === 2 && waiting.start <= waiting.finish.result.value && waiting.range.earliest === 2, 'startRange')

  const remnant = (fuel) => forecast([row({ Amount: 3, ProdPerUnit: 10, FuelRequired: 2, StockFuel: fuel })], { arrivals: [{ resource: 'fuel', day: 2, quantity: 100 }] }).figures[0]
  const [overshot, stranded] = [remnant(1.00003), remnant(1.00014)]

  holds('WRAPPER a fuel limit that leaves a part of a unit under 0.0001 is flagged: one case ends on a rounded overshoot and has no finish date, the other has no date and says a remainder is left, and neither is called a stock that is short', overshot.fineRemainder === true && overshot.finish.idle && overshot.forecast.finish === null && overshot.forecast.stall.reason === 'remainder' && overshot.shortage === null && stranded.fineRemainder === true && stranded.finish.idle && stranded.forecast.stall.reason === 'remainder' && stranded.shortage === null && [overshot, stranded].every((figure) => figure.finish.result.inputs.missing.some((text) => /whole build/.test(text) && /so no build can finish it exactly/.test(text))), 'remainder')

  const behindOf = (fuel) => forecast([row({ ID: 1, Amount: 3, ProdPerUnit: 10, FuelRequired: 2, StockFuel: fuel }), row({ ID: 2, Amount: 1, ProdPerUnit: 10, Queue: 1 })], { arrivals: [{ resource: 'fuel', day: 2, quantity: 100 }] }).figures[1]
  const behindFigures = [behindOf(1.00003), behindOf(1.00014)]

  holds('WRAPPER a project queued behind one that cannot finish exactly, whether the remainder is an overshoot or a part of a unit left, has no start and no finish date, and its idle result says that whether the project ahead frees its share is not known', behindFigures.every((behind) => behind.start === null && behind.startRange === null && behind.finish.idle && behind.forecast.outcome === 'unresolved' && behind.forecast.finish === null && behind.finish.result.inputs.missing.some((text) => /the project ahead of it cannot finish exactly/.test(text) && /not known/.test(text))), 'unresolvedWrapper')

  const declined = [
    ['a project whose partial completion is not in the save', forecast([row({ PartialCompletion: null })])],
    ['a project with no production type', forecast([row({ ProductionType: null })])],
    ['a spied empire\'s colony', forecast([row()], { npr: true })],
    ['a colony with no production modifiers', production.industryForecast({ projects: [row()], capacities, modifiers: undefined })],
    ['a project with a mineral need not in the save', forecast([row({ Duranium: null })])],
    ['a project that needs a stock the colony\'s row does not hold', forecast([row({ Duranium: 5, StockDuranium: null })])],
    ['a conversion with no count of the installations it draws on', forecast([row({ ConversionFrom: 7, ConversionSource: null })])],
  ]

  declined.forEach(([name, result]) => holds(`WRAPPER ${name} is not forecast (the gap is named, no figure is made up, and the page keeps its per-project check)`, result.gaps && result.gaps.length > 0 && result.figures === undefined))

  // A quantity the decimal type cannot hold is that colony's gap and nothing else's: no throw, no figure, and the colonies run after it are forecast.
  const big = [{ resource: 'Duranium', day: 1, quantity: 1e29 }]
  const attempt = (action) => {
    try {
      return action()
    } catch (error) {
      return { thrown: error.message }
    }
  }
  const overflowed = attempt(() => forecast([needy], { arrivals: big }))
  const prepare = (arrivals) => production.prepareForecast({ projects: [needy], capacities, modifiers, arrivals, npr: false })
  const run = attempt(() => {
    const pass = production.industryForecastRun([{ populationId: 1, prepared: prepare(big) }, { populationId: 2, prepared: prepare([]) }], { expired: () => false })
    let step = pass.next()

    while (!step.done) {
      step = pass.next()
    }

    return step.value
  })

  holds('WRAPPER an arrival of 1e29 t is the gap of that colony (named as the decimal type of the game, no figure made up, nothing thrown), and the colony after it in the same run is forecast', !overflowed.thrown && overflowed.gaps && overflowed.gaps.some((text) => /decimal type/.test(text)) && overflowed.figures === undefined && !run.thrown && run.forecasts[1].gaps && run.forecasts[1].gaps.some((text) => /decimal type/.test(text)) && run.forecasts[2].figures && run.forecasts[2].figures.length === 1, 'overflowWrapper')

  // A wide colony forecast a project at a time: with a pace always up, the wrapper makes the figures of its projects with a look at the pace between one and the next, so it yields once more for each project after the engine's own yields.
  const wideRows = Array.from({ length: 1000 }, (_, index) => row({ ID: index + 1, Percentage: 0.1, Amount: 1, ProdPerUnit: 1 }))
  const wideCapacities = Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, provenance.ofRule({ rule: 'production.industryRate', value: 365000, inputs: { present: ['the colony\'s capacity'] } })]))
  const widePrepared = production.prepareForecast({ projects: wideRows, capacities: wideCapacities, modifiers })
  const up = { expired: () => true }

  const yieldsOf = (steps) => {
    let yields = 0
    let step = steps.next()

    while (!step.done) {
      yields += 1
      step = steps.next()
    }

    return { yields, value: step.value }
  }

  const wideEngine = yieldsOf(engine.forecastColonySteps(widePrepared.input, up))
  const wideWrapped = yieldsOf(production.industryForecastSteps(widePrepared, up))

  holds('WRAPPER a colony of 1000 projects of 0.1% each, all finishing on day 1, forecast a project at a time with a pace always up yields once more for each project after the engine\'s own yields (999 more), and the figures it hands the page are all there (1000, each a day-1 finish of 1 unit)', wideWrapped.yields === wideEngine.yields + 999 && wideWrapped.value.figures.length === 1000 && wideWrapped.value.figures.every((figure) => figure.forecast.finish === 1 && figure.forecast.built === 1), 'wideWrapper')

  return results
}

// The page's rows (`industryJobs`) on synthetic colonies, as [statement, held, key]: what it shows for a colony the forecast cannot run, how it words a date with all the stock supplied, an order sample and a start that depends on the order, and how it runs the forecast of the colonies in a run of its own: forecasting until the run ends, a run replaced never kept, a run that fails stated, a quantity the decimal type cannot hold kept out of the form and out of the other colonies' forecasts.
const pageCases = async (pageOptions) => {
  const results = []
  const holds = (key, statement, condition) => results.push([statement, Boolean(condition), key])
  const modifiers = { PopName: 'Test colony', ConstructionProduction: SYNTHETIC.capacity, OverallProductionModifier: 1, ConstructionPower: 1, EngineerProductionModifier: 0, GroundConstructionPower: 0, OrdnanceProduction: 0, OrdnanceProductionPower: 0, FighterProduction: 0, FighterProductionPower: 0, MinConstructionPeriod: 86400 }
  const zeros = Object.fromEntries(MINERAL_NAMES.flatMap((name) => [[name, 0], [`Stock${name}`, 0]]))
  const row = (extra = {}) => ({ ID: 1, Name: `Project ${extra.ID || 1}`, ProductionType: 0, PopulationID: 7, Percentage: 100, Amount: 4, PartialCompletion: 0, ProdPerUnit: 2, Queue: 0, Paused: 0, FuelRequired: 0, StockFuel: 0, ConversionFrom: null, ConversionSource: null, ...zeros, ...extra })
  const arrival = (resource, day, quantity, populationId = 7) => ({ id: 1, PopulationID: populationId, resource, day, quantity, source: '' })
  const page = (rows, arrivals = [], extra = {}) => instantiate(pageOptions, { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }, data: { industry: rows, arrivals, populationProductionModifiers: { 7: modifiers, 8: modifiers }, colony: () => ({ colonyName: 'Test colony', place: '', body: null }), ...extra } })

  const forecasted = async (rows, arrivals = [], extra = {}) => {
    const vm = page(rows, arrivals, extra)

    await vm.startForecast()

    return vm
  }

  const jobOf = async (rows, key, arrivals = []) => (await forecasted(rows, arrivals)).industryJobs.find((job) => job.key === key)

  const gapped = await jobOf([row({ PartialCompletion: null, Duranium: 10 })], 'industry-1', [arrival('Duranium', 1, 100)])

  holds('fallbackShort', 'PAGE a Short job of a colony the forecast cannot run (a project whose partial completion is not in the save) has no finish date, only a note that names the date it would have with all the stock it needs, and a caution that names the gap and says the arrivals entered are not counted', gapped.status.id === 'short' && gapped.days === null && gapped.finishIdle && /with all the stock it needs it would finish in/.test(gapped.status.note) && gapped.cautions.some((text) => /older per-project check because .*part of a unit/.test(text) && /arrivals entered by hand are not counted/.test(text)))

  const supplied = await jobOf([row({ Duranium: 10 })], 'industry-1')

  holds('suppliedNote', 'PAGE the date a Short project would have is the one with all the stock it needs, and is not worded as the date with the one resource it is short of', supplied.status.id === 'short' && supplied.days === null && /with all the stock it needs it would finish in/.test(supplied.status.note) && !/with Duranium it would/.test(supplied.status.note))

  const crowdRows = [[1, 4, 2, 2, 0], [2, 5, 2, 1, 0], [3, 4, 2, 1, 2], [4, 2, 3, 2, 1], [5, 4, 3, 1, 1], [6, 4, 2, 1, 1]].map(([ID, Amount, ProdPerUnit, Duranium, Corbomite]) => row({ ID, Percentage: 16, Amount, ProdPerUnit, Duranium, Corbomite, StockDuranium: 10, StockCorbomite: 5 }))
  const crowded = await forecasted(crowdRows, [arrival('Duranium', 3, 16), arrival('Corbomite', 4, 11)])
  const sampled = crowded.industryJobs.find((job) => job.key === 'industry-1')

  holds('sampledPage', 'PAGE six jobs in contention for the stock (too many orders to try them all) show a date as a sample: marked approximate, a range worded as the latest of the orders tried with other orders possibly differing, and a caution that the date is not a bound', sampled.days !== null && sampled.approx && sampled.range.sampled === true && /orders tried/.test(crowded.rangeText(sampled.range)) && /other orders may differ/.test(crowded.rangeText(sampled.range)) && sampled.cautions.some((text) => /Too many projects compete/.test(text)))

  const queuedRows = [row({ ID: 1, Percentage: 40, Amount: 1, ProdPerUnit: 1, Duranium: 1, StockDuranium: 1 }), row({ ID: 2, Percentage: 60, Amount: 1, ProdPerUnit: 1, Duranium: 1, StockDuranium: 1 }), row({ ID: 3, Percentage: 60, Amount: 1, ProdPerUnit: 1, Queue: 1, StockDuranium: 1 })]
  const queued = await jobOf(queuedRows, 'industry-3', [arrival('Duranium', 10, 1)])

  holds('startPage', 'PAGE a queued job whose start the order moves says so: "Starts in" the earliest, up to the latest in another order', queued.status.id === 'queued' && /^Starts in .+, up to .+ in another order$/.test(queued.status.note))

  const overshootRows = (fuel) => [row({ ID: 1, Amount: 3, ProdPerUnit: 10, FuelRequired: 2, StockFuel: fuel }), row({ ID: 2, Amount: 1, ProdPerUnit: 10, Queue: 1 })]
  const behindOf = (fuel) => jobOf(overshootRows(fuel), 'industry-2', [{ id: 1, PopulationID: 7, resource: 'fuel', day: 2, quantity: 100, source: '' }])
  const [behind, behindStranded] = [await behindOf(1.00003), await behindOf(1.00014)]
  const aheadStranded = await jobOf(overshootRows(1.00014), 'industry-1', [{ id: 1, PopulationID: 7, resource: 'fuel', day: 2, quantity: 100, source: '' }])

  holds('unresolvedPage', 'PAGE a project queued behind one that cannot finish exactly, a rounded overshoot or a remainder under 0.0001 left, has no start date and says its start is not known, never that it never starts, and the project ahead is no completion', [behind, behindStranded].every((job) => job.days === null && job.status.id === 'queued' && /^Start not known: the project ahead of it cannot finish exactly/.test(job.status.note) && !/Never starts/.test(job.status.note)) && aheadStranded.days === null)

  // A last build the fuel cuts to exactly what is left is a completion, so no caution that the project cannot finish exactly; a remainder the build misses keeps it.
  const exactJobs = (await forecasted(overshootRows(1.00003), [arrival('fuel', 2, 4.99997)])).industryJobs
  const strandedJobs = (await forecasted(overshootRows(1.00014), [arrival('fuel', 2, 100)])).industryJobs
  const twiceJobs = (await forecasted(overshootRows(1.00003), [arrival('fuel', 2, 4.5), arrival('fuel', 6, 0.49997)])).industryJobs
  const remainderCaution = /part of a unit finer than a build/

  holds('remainderCautionPage', 'PAGE a project whose last build the fuel cuts to exactly the part of a unit it has left (3 units at 2 of fuel a unit, 1.00003 held and 4.99997 more on day 2, or 4.5 on day 2 and 0.49997 on day 6) finishes with no caution that no build can finish it, and the project queued behind it has a start; a project left a part of a unit under a build (1.00014 held and 100 more on day 2) keeps the caution', exactJobs[0].days === 4 && exactJobs[0].status.id === 'running' && !exactJobs[0].cautions.some((text) => remainderCaution.test(text)) && /^Starts in /.test(exactJobs[1].status.note) && strandedJobs[0].cautions.some((text) => remainderCaution.test(text)) && twiceJobs[0].days === 6 && !twiceJobs[0].cautions.some((text) => remainderCaution.test(text)) && /^Starts in /.test(twiceJobs[1].status.note))

  // The forecast of the colonies is a run the page keeps: until it ends the jobs of a colony it will forecast say so (not a blank or a 0), and an input that changes meanwhile hides what the run before it kept.
  const dryRows = [row({ Duranium: 10 })]
  const waiting = page(dryRows)
  const waitingJob = waiting.industryJobs[0]
  const gappedWaiting = page([row({ PartialCompletion: null, Duranium: 10 })]).industryJobs[0]
  const ready = await forecasted(dryRows)
  const readyJob = ready.industryJobs[0]
  const forecastKeyBefore = ready.forecastKey

  ready.arrivals = [arrival('Duranium', 1, 100)]

  const changedJob = ready.industryJobs[0]

  holds('forecastingPage', 'PAGE a colony the forecast can run shows its jobs as Forecasting until the run has ended (no date, a finish that is missing the forecast and not an idle one, no shortage, no caution) and its forecast after, and a colony the forecast cannot run does not wait for the run; an input that changes after the run ended hides what it kept until the run of the new input has ended', waitingJob.status.id === 'forecasting' && waitingJob.days === null && !waitingJob.finishIdle && waitingJob.shortage === null && waitingJob.cautions.length === 0 && waitingJob.finishResult.inputs.missing.some((text) => /forecast/.test(text)) && gappedWaiting.status.id === 'short' && readyJob.status.id === 'short' && ready.forecastKey !== forecastKeyBefore && changedJob.status.id === 'forecasting')

  const driver = pageOptions.mixins.find((mixin) => mixin.methods && mixin.methods.forecastSearch)

  // A run slow enough to be replaced while it runs: it spins past the slice before its first step, then does the work of the forecast driver's own search.
  const slowSearch = function* (colonies, pace) {
    const start = performance.now()

    while (performance.now() - start < 2 * 12) {
      // the time the slice takes
    }

    const counts = { total: colonies.length, evaluated: 0, pruned: 0, unexplored: colonies.length, feasible: 0, retained: 0, prunedBy: {} }

    yield { progress: 0, counts, snapshot: () => ({ counts, forecasts: {} }) }

    return yield * driver.methods.forecastSearch.call(this, colonies, pace)
  }

  const slow = page(dryRows, [], { forecastSearch: slowSearch })
  const firstKey = slow.forecastKey
  const first = slow.startForecast()

  slow.arrivals = [arrival('Duranium', 1, 100)]

  const secondKey = slow.forecastKey
  const second = slow.startForecast()

  await first

  const keptAfterFirst = slow.forecastState.key

  await second

  const replaced = slow.industryJobs[0]
  const alone = (await jobOf(dryRows, 'industry-1', [arrival('Duranium', 1, 100)]))

  holds('staleRun', 'PAGE a forecast run whose input changed while it ran is ended and its outcome never kept: after the run it was replaced by, the page holds the forecast of the new input (the date of a project whose stock the arrival entered completes) and the replaced run kept nothing', firstKey !== secondKey && keptAfterFirst !== firstKey && slow.forecastState.key === secondKey && replaced.days === alone.days && replaced.status.id === alone.status.id)

  // A run that fails is stated, and the colonies keep the older per-project check.
  const broken = await forecasted(dryRows, [], { * forecastSearch () { throw new Error('the search broke') } })
  const brokenJob = broken.industryJobs[0]

  holds('failedRun', 'PAGE a forecast run that fails is stated on the project of every colony it was for, with the reason, and the project keeps the older per-project check (a Short job, no date), never a blank or a forecast', brokenJob.status.id === 'short' && brokenJob.days === null && brokenJob.cautions.some((text) => /the forecast of the colony failed \(the search broke\)/.test(text) && /older per-project check/.test(text)))

  // A quantity the decimal type cannot hold is not accepted in the form, and one that gets in is that colony's gap only.
  const typed = (quantity) => page([], [], { arrivalForm: { populationId: 7, resource: 'Duranium', day: '1', quantity, source: '' } })
  const [big, fits, empty] = [typed('1e29'), typed('5e28'), typed('')]
  const colonyRows = [row({ ID: 1, PopulationID: 7, Duranium: 10 }), row({ ID: 2, PopulationID: 8, Duranium: 10 })]
  const overflow = await forecasted(colonyRows, [arrival('Duranium', 1, 1e29)])
  const [overflowing, healthy] = ['industry-1', 'industry-2'].map((key) => overflow.industryJobs.find((job) => job.key === key))

  holds('arrivalRange', 'PAGE an arrival of 1e29 t is refused by the form with a message that says why (the game\'s decimal type holds about 7.9e28), 5e28 t and no quantity give no message, and an arrival of 1e29 t that is in the page anyway makes that colony\'s forecast a gap that names the decimal type, with its jobs on the older per-project check, while another colony of the page is forecast', !big.arrivalValid && /decimal type/.test(big.arrivalHint) && fits.arrivalValid && fits.arrivalHint === '' && !empty.arrivalValid && empty.arrivalHint === '' && overflowing.status.id === 'short' && overflowing.cautions.some((text) => /decimal type/.test(text)) && healthy.status.id === 'short' && healthy.cautions.every((text) => !/decimal type/.test(text)) && /with all the stock it needs it would finish in|covers/.test(healthy.status.note) && overflow.forecastState.error === null)

  // A project known to be paused stays paused while the forecast runs: the Paused jobs option hides it and the Jobs tile counts it, whether or not the run has ended.
  const pausedRows = [row({ ID: 1, Percentage: 50, Duranium: 10 }), row({ ID: 2, Percentage: 50, Paused: 1, Duranium: 10 })]
  const [pausedPending, pausedDone] = [page(pausedRows, [], { showPaused: false }), await forecasted(pausedRows, [], { showPaused: false })]
  const pausedNote = (vm) => (vm.tiles.find((tile) => tile.label === 'Jobs') || { note: '' }).note

  holds('pausedPage', 'PAGE a project known to be paused is Paused while the forecast is still running as after it: with the Paused jobs option off it is not listed (only the running project is, as Forecasting while the run is pending), and the Jobs tile counts it as paused and the other as being forecast, never the paused one as being forecast', [pausedPending, pausedDone].every((vm) => vm.industryJobs.find((job) => job.key === 'industry-2').status.id === 'paused' && vm.visibleJobs.length === 1 && vm.visibleJobs[0].key === 'industry-1' && /1 paused/.test(pausedNote(vm))) && pausedPending.industryJobs[0].status.id === 'forecasting' && /1 being forecast/.test(pausedNote(pausedPending)) && pausedDone.industryJobs[0].status.id === 'short')

  return results
}

// ---- the replay of a save's last production cycle ----

const mineralColumns = (alias) => MINERAL_NAMES.map((name) => `${alias}${name}`).join(', ')

const readCycle = async (database, game, race) => {
  const production = PRODUCTION_USES.join(',')
  const [last] = await rowsOf(database, `select max(Time) as Time from FCT_RaceMineralData where GameID = ${game} and RaceID = ${race} and MineralDataType in (${production})`)

  if (!last || last.Time === null) {
    return null
  }

  const [before] = await rowsOf(database, `select max(Time) as Time from FCT_RaceMineralData where GameID = ${game} and RaceID = ${race} and MineralDataType in (${production}) and Time < ${last.Time}`)
  const types = await rowsOf(database, 'select MineralDataType, Income from DIM_MineralDataType')
  const income = Object.fromEntries(types.map((type) => [type.MineralDataType, type.Income]))
  const populations = await rowsOf(database, `select PopulationID, PopName, ${mineralColumns('')}, ${mineralColumns('Last')} from FCT_Population where GameID = ${game} and RaceID = ${race}`)
  const ledger = await rowsOf(database, `select PopulationID, MineralID, MineralDataType, Amount from FCT_RaceMineralData where GameID = ${game} and RaceID = ${race} and Time >= ${last.Time}`)
  const projects = await rowsOf(database, `select ProjectID, PopulationID, Description, Percentage, ProductionType, WealthUse, Amount, PartialCompletion, ProdPerUnit, Pause, Queue, ${mineralColumns('')} from FCT_IndustrialProjects where GameID = ${game} and RaceID = ${race}`)
  const flows = new Map()

  ledger.forEach((row) => {
    const key = `${row.PopulationID}:${row.MineralID}`
    const entry = flows.get(key) || { signed: 0, uses: {} }

    entry.signed += (income[row.MineralDataType] ? 1 : -1) * row.Amount
    entry.uses[row.MineralDataType] = (entry.uses[row.MineralDataType] || 0) + row.Amount
    flows.set(key, entry)
  })

  return { time: last.Time, years: before && before.Time !== null ? (last.Time - before.Time) / SECONDS_PER_YEAR : null, populations, flows, projects }
}

const usesOf = (flows, population, mineralId, types) => types.reduce((sum, type) => sum + ((flows.get(`${population}:${mineralId}`) || { uses: {} }).uses[type] || 0), 0)

// The builds of the projects that are alone in their use type at their colony, from the ledger: { project, built } over every mineral the project needs, null where the ledger does not show it.
const soloBuilds = (cycleData) => {
  const { projects, flows } = cycleData
  const running = projects.filter((project) => !project.Queue && !project.Pause)
  const cohort = (project) => running.filter((other) => other.PopulationID === project.PopulationID && other.WealthUse === project.WealthUse)

  return running.filter((project) => cohort(project).length === 1 && project.ProdPerUnit > 0 && project.Percentage > 0).map((project) => {
    const builds = MINERAL_NAMES.map((name, index) => (project[name] > 0 ? usesOf(flows, project.PopulationID, index + 1, [project.WealthUse]) / project[name] : null)).filter((built) => built !== null)

    return builds.length ? { project, builds } : null
  }).filter(Boolean)
}

const sameBuild = (builds) => builds.every((built) => Math.abs(built - builds[0]) <= 1e-3 * Math.max(1e-6, builds[0]) + 1e-4)

const INCREMENT_CHECK = 'the engine\'s one cycle, from the stock before it (the Last columns and what the colony mined), the saved shares and the capacity the app gives, builds what the ledger shows (within 0.5%) for most resolvable projects alone in their use type'

const engineProjects = (list, extra = {}) => list.map((project) => ({ ID: project.ProjectID, Percentage: project.Percentage, Amount: project.Amount + (extra.spare || 0), PartialCompletion: 0, ProdPerUnit: project.ProdPerUnit, Queue: 0, Paused: 0, category: KINDS[project.ProductionType] || 'construction', needs: Object.fromEntries(MINERAL_NAMES.filter((name) => project[name] > 0).map((name) => [name, project[name]])), source: null }))

// The engine's first cycle of each colony with a project alone in its use type, against the build the ledger shows for that project: { compared: [{ project, ledger, engine }], agree, differ }. `years` is what the cycle covers.
const incrementComparison = (cycleData, page, engine, years) => {
  const running = cycleData.projects.filter((project) => !project.Queue && !project.Pause && project.ProdPerUnit > 0 && project.Percentage > 0)
  const solos = soloBuilds(cycleData).filter((entry) => entry.builds[0] >= BUILD_FLOOR)
  const cycleDays = years * 365
  const compared = []

  ;[...new Set(solos.map((entry) => entry.project.PopulationID))].forEach((populationId) => {
    const population = cycleData.populations.find((candidate) => candidate.PopulationID === populationId)
    const list = running.filter((project) => project.PopulationID === populationId)
    const capacities = {}

    list.forEach((project) => {
      const kind = KINDS[project.ProductionType] || 'construction'
      const capacity = page.populationCapacityResult(populationId, kind)

      capacities[kind] = capacity.status === 'unavailable' ? 0 : capacity.value
    })

    if (!population || Object.values(capacities).some((capacity) => !(capacity > 0))) {
      return
    }

    const stock = Object.fromEntries(MINERAL_NAMES.map((name, index) => [name, population[`Last${name}`] + usesOf(cycleData.flows, populationId, index + 1, MINING_USES)]))
    const result = engine.forecastColony({ projects: engineProjects(list, { spare: 1000 }), capacities, stock, cycleDays, horizonDays: cycleDays / 2 })

    solos.filter((entry) => entry.project.PopulationID === populationId).forEach((entry) => compared.push({ project: entry.project, ledger: entry.builds[0], engine: result.projects[entry.project.ProjectID].firstBuild || 0 }))
  })

  const agree = compared.filter((entry) => Math.abs(entry.engine - entry.ledger) <= CAPACITY_TOLERANCE * entry.ledger + 1e-4)

  return { compared, agree, differ: compared.filter((entry) => !agree.includes(entry)) }
}

// The engine on a colony `orderOutcomes` ran in the reference model, as { same, dependent }: every project's finish cycle the same as the reference's in the order of the project IDs ('never' within the horizon, as the reference has it), and the engine's flag of an order-dependent colony the reference's.
const engineAgainstReference = (engine, entry, years) => {
  const cycleDays = years * 365
  const capacities = {}

  entry.list.forEach((project, index) => (capacities[KINDS[project.ProductionType] || 'construction'] = entry.capacities[index]))

  const result = engine.forecastColony({ projects: engineProjects(entry.list), capacities, stock: entry.stock, cycleDays, horizonDays: (ORDER_HORIZON - 0.5) * cycleDays })
  const cycles = Object.fromEntries(entry.list.map((project) => [project.ProjectID, result.projects[project.ProjectID].finish === null ? 'never' : Math.round(result.projects[project.ProjectID].finish / cycleDays)]))

  return { same: entry.list.every((project) => cycles[project.ProjectID] === entry.finishes[project.ProjectID]), dependent: result.orders.dependent === entry.dependent, cycles }
}

// The page's own read of the industrial projects and the forecast it makes of each colony, on a save.
const pageChecks = async (page, production, label) => {
  await page.runAsync('industry')

  const rows = page.industry

  if (!rows.length) {
    unsupportedNote(`${label}: no industrial projects, so the page's forecast has nothing to run on`)

    return
  }

  check(`${label}: the page's read of the projects carries the partial completion and the conversion columns of every project`, rows.every((row) => 'PartialCompletion' in row && 'ConversionFrom' in row && 'ConversionSource' in row), `${rows.length} projects`)

  const colonies = new Map()

  rows.forEach((row) => colonies.set(row.PopulationID, [...(colonies.get(row.PopulationID) || []), row]))

  const forecasts = [...colonies.entries()].map(([populationId, projects]) => production.industryForecast({ projects, capacities: Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, page.populationCapacityResult(populationId, kind)])), modifiers: page.populationProductionModifiers[populationId], npr: page.RaceNPR }))
  const fallback = forecasts.filter((forecast) => forecast.gaps)

  if (fallback.length) {
    unsupportedNote(`${label}: colonies the cycle forecast cannot run on, which keep the per-project check`, `${fallback.length} of ${forecasts.length}: ${[...new Set(fallback.flatMap((forecast) => forecast.gaps))].join('; ')}`)
  } else {
    check(`${label}: every colony's projects run through the cycle forecast, none falls back to the per-project check`, true, `${forecasts.length} colonies, ${rows.length} projects`)
  }

  const figures = forecasts.filter((forecast) => !forecast.gaps).flatMap((forecast) => forecast.figures)
  const jobs = page.industryJobs

  check(`${label}: no job the page shows as Short of minerals has a finish date, and every job with a stall is without one`, jobs.every((job) => job.status.id !== 'short' || job.days === null) && figures.filter((figure) => figure.shortage).every((figure) => figure.finish.idle), `${jobs.filter((job) => job.status.id === 'short').length} short of ${jobs.length} jobs`)
  console.log(`        forecast: ${figures.filter((figure) => figure.range).length} projects with a range of dates, ${figures.filter((figure) => figure.sensitive).length} too small to date, ${figures.filter((figure) => figure.maybeShort).length} short in some orders only, ${forecasts.filter((forecast) => forecast.orders && forecast.orders.dependent).length} colonies order-dependent`)
}

const replay = async (database, game, race, label, options) => {
  const { page, years: yearsOverride = null } = options
  const cycleData = await readCycle(database, game, race)

  console.log(`\n== ${label}: game ${game}, race ${race} ==`)

  if (!cycleData) {
    unsupportedNote(`${label}: no production in the ledger, so no cycle to replay`)

    return { results: [] }
  }

  const years = yearsOverride === null ? cycleData.years : yearsOverride
  const results = []
  const holds = (statement, condition, detail = '') => results.push([statement, Boolean(condition), detail])

  // The stock before the cycle.
  let exact = 0
  const residual = []

  cycleData.populations.forEach((population) => {
    MINERAL_NAMES.forEach((name, index) => {
      const entry = cycleData.flows.get(`${population.PopulationID}:${index + 1}`) || { signed: 0 }
      const gap = population[name] - population[`Last${name}`] - entry.signed

      if (Math.abs(gap) <= CLOSURE_TOLERANCE * Math.max(1, Math.abs(population[name]))) {
        exact++
      } else {
        residual.push({ population, name, gap, mined: MINING_USES.some((type) => usesOf(cycleData.flows, population.PopulationID, index + 1, [type]) > 0) })
      }
    })
  })

  if (exact + residual.length) {
    holds('the stock now less the cycle\'s ledger flows is the stock the colony held before it (its Last columns) for at least 95% of the colony-minerals', exact >= CLOSURE_SHARE * (exact + residual.length), `${exact} of ${exact + residual.length} colony-minerals exact`)
  } else {
    unsupportedNote(`${label}: no colony in the save to close the stock of`)
  }

  const unlogged = residual.filter((entry) => !entry.mined && entry.gap > 0)

  if (unlogged.length) {
    unsupportedNote(`${label}: colony-minerals with stock above what the ledger explains and no mining logged for them (mass driver export colonies)`, `${unlogged.length} in ${new Set(unlogged.map((entry) => entry.population.PopulationID)).size} colonies`)
  }

  if (residual.length > unlogged.length) {
    unsupportedNote(`${label}: colony-minerals the ledger does not close and the unlogged mining does not explain`, residual.filter((entry) => !unlogged.includes(entry)).map((entry) => `${entry.population.PopName} ${entry.name} ${entry.gap.toFixed(3)}`).join('; '))
  }

  // Conservation and the stock-limited cases.
  const byColony = new Map()

  cycleData.projects.filter((project) => !project.Queue && !project.Pause).forEach((project) => {
    byColony.set(project.PopulationID, [...(byColony.get(project.PopulationID) || []), project])
  })

  let sharing = 0
  let overdrawn = 0
  let binding = 0

  byColony.forEach((list, populationId) => {
    const population = cycleData.populations.find((candidate) => candidate.PopulationID === populationId)

    if (!population) {
      return
    }

    MINERAL_NAMES.forEach((name, index) => {
      if (list.filter((project) => project[name] > 0).length < 2) {
        return
      }

      sharing++

      const pool = population[`Last${name}`] + usesOf(cycleData.flows, populationId, index + 1, MINING_USES)
      const used = usesOf(cycleData.flows, populationId, index + 1, PROJECT_USES)

      if (used > pool + 1e-6) {
        overdrawn++
      }

      if (used >= pool - 1e-3) {
        binding++
      }
    })
  })

  if (sharing === 0) {
    unsupportedNote(`${label}: no colony has two running projects that need the same mineral`)
  } else {
    holds('the projects of a colony took no more of a mineral than the colony held (stock before the cycle plus what it mined)', overdrawn === 0, `${sharing} colony-minerals needed by 2 or more running projects`)

    if (binding === 0) {
      unsupportedNote(`${label}: no colony-mineral was stock-limited in the last cycle (the projects took less than the colony held), so the sequential debit under a shortage is not observed in this save`, `${sharing} colony-minerals needed by 2 or more running projects`)
    }
  }

  // The saved colonies whose running projects share a mineral, run forward from today's stock in every order (no income, queued projects not modelled).
  const orders = years === null ? null : orderOutcomes(cycleData, page, years)

  if (orders === null) {
    unsupportedNote(`${label}: no earlier production time in the ledger, so the cycle length of a forward run is not known`)
  } else if (!orders.colonies.length) {
    unsupportedNote(`${label}: no colony has 2 to ${MAX_ORDER_JOBS} running projects sharing a mineral with a capacity figure, so no forward run in every order`)
  } else {
    holds('run forward from today\'s stock with no income, in every order the reference model finishes only what the stock covers (the tonnes the finished jobs need do not exceed the stock of any mineral)', orders.colonies.every((entry) => entry.conserved), `${orders.colonies.length} colonies, ${orders.colonies.reduce((sum, entry) => sum + entry.orders, 0)} orders`)

    const dependent = orders.colonies.filter((entry) => entry.dependent)

    console.log(`        order: ${orders.colonies.length - dependent.length} of ${orders.colonies.length} colonies finish every job in the same cycle (or never) in every order; ${dependent.length} do not${dependent.length ? ` (${dependent.map((entry) => `colony ${entry.populationId}`).join(', ')})` : ''}`)
  }

  const named = orders && orders.colonies.find((entry) => entry.populationId === ORDER_CASE.populationId && ORDER_CASE.ids.every((id) => entry.finishes[id] !== undefined))

  if (named) {
    holds(`colony ${ORDER_CASE.populationId} (projects ${ORDER_CASE.ids.join(' and ')}): each project's finish cycle is the same in either order, with the saved capacities and shares, a ${(years * 365).toFixed(3)} day cycle and no income`, named.orders > 1 && !named.dependent, `finish cycles ${JSON.stringify(named.finishes)}`)
  } else if (orders) {
    unsupportedNote(`${label}: colony ${ORDER_CASE.populationId} with projects ${ORDER_CASE.ids.join(' and ')} is not in this save`)
  }

  // The engine's finish cycles against the reference model's, on the colonies run forward above.
  if (orders && orders.colonies.length) {
    const against = orders.colonies.map((entry) => engineAgainstReference(options.engine, entry, years))

    holds('run forward from today\'s stock with no income, the engine finishes every job in the same cycle (or never) as the reference model does in the order of the project IDs', against.every((entry) => entry.same), `${against.filter((entry) => entry.same).length} of ${against.length} colonies agree on every job's finish cycle`)
    holds('the engine reports a colony order-dependent exactly when some order of the reference model finishes a job in another cycle', against.every((entry) => entry.dependent), `${against.filter((entry) => entry.dependent).length} of ${against.length} colonies agree`)

    const entry = orders.colonies.find((candidate) => candidate === named)

    if (entry) {
      const engineCycles = engineAgainstReference(options.engine, entry, years).cycles

      holds(`colony ${ORDER_CASE.populationId}: the engine finishes project ${ORDER_CASE.ids[1]} in cycle ${entry.finishes[ORDER_CASE.ids[1]]} (${(entry.finishes[ORDER_CASE.ids[1]] * years * 365).toFixed(1)} days) and project ${ORDER_CASE.ids[0]} never, with the order of the two settling nothing`, ORDER_CASE.ids.every((id) => engineCycles[id] === entry.finishes[id]) && !entry.dependent && engineCycles[ORDER_CASE.ids[0]] === 'never' && typeof engineCycles[ORDER_CASE.ids[1]] === 'number', `engine cycles ${JSON.stringify(engineCycles)}`)
    }
  }

  // Whole units.
  const fractional = cycleData.projects.map((project) => {
    const total = project.Amount + project.PartialCompletion

    return Math.abs(total - Math.round(total))
  })

  const broken = cycleData.projects.filter((_project, index) => fractional[index] > WHOLE_TOLERANCE)

  if (cycleData.projects.length) {
    holds('units left plus partial completion is a whole number (the partial completion is what the next unit has had) for at least 95% of the projects', cycleData.projects.length - broken.length >= WHOLE_SHARE * cycleData.projects.length, `${cycleData.projects.length - broken.length} of ${cycleData.projects.length} projects`)
  } else {
    unsupportedNote(`${label}: no industrial projects`)
  }

  broken.forEach((project) => unsupportedNote(`${label}: project #${project.ProjectID} (${project.Description}) has ${project.Amount} units left and ${project.PartialCompletion} done of the next, not a whole number`))

  // The builds the ledger shows.
  const solos = soloBuilds(cycleData)
  const same = solos.filter((entry) => entry.builds.length >= 2)

  if (same.length) {
    holds('a project alone in its use type at its colony took, of every mineral it needs, the per-unit need times one build', same.every((entry) => sameBuild(entry.builds)), `${same.length} projects with 2 or more minerals of ${solos.length} alone in their use type`)
  } else {
    unsupportedNote(`${label}: no project alone in its use type needs two minerals, so one build per mineral is not compared`)
  }

  const resolved = solos.filter((entry) => entry.builds[0] >= BUILD_FLOOR)
  const tooSmall = solos.length - resolved.length

  if (tooSmall) {
    unsupportedNote(`${label}: builds under ${BUILD_FLOOR} unit (the game's 4 decimals are too coarse to compare)`, `${tooSmall} projects`)
  }

  if (years === null) {
    unsupportedNote(`${label}: no earlier production time in the ledger, so the years the last cycle covered are not known`)

    return { results }
  }

  const ratios = resolved.map((entry) => {
    const { project, builds } = entry
    const capacity = page.populationCapacityResult(project.PopulationID, KINDS[project.ProductionType] || 'construction')
    const implied = (builds[0] * project.ProdPerUnit) / (project.Percentage / 100) / years

    return { project, implied, app: capacity.status === 'unavailable' ? null : capacity.value }
  })
  const compared = ratios.filter((entry) => entry.app !== null && entry.app > 0)
  const agreeing = compared.filter((entry) => Math.abs(entry.implied / entry.app - 1) <= CAPACITY_TOLERANCE)
  const disagreeing = compared.filter((entry) => Math.abs(entry.implied / entry.app - 1) > CAPACITY_TOLERANCE)

  ratios.filter((entry) => entry.app === null || !(entry.app > 0)).forEach((entry) => unsupportedNote(`${label}: project #${entry.project.ProjectID} has no capacity figure to compare (colony ${entry.project.PopulationID})`))
  if (compared.length) {
    holds(`the colony's capacity times the project's share times the years since the last cycle is the build the ledger shows (within ${CAPACITY_TOLERANCE * 100}%) for most resolvable projects`, agreeing.length > disagreeing.length, `${agreeing.length} agree, ${disagreeing.length} differ of ${compared.length} (the app's capacity is the saved state after the cycle)`)
  } else {
    unsupportedNote(`${label}: no resolvable project has a capacity figure to compare with the ledger's build`)
  }

  disagreeing.forEach((entry) => console.log(`        differs: project #${entry.project.ProjectID} at colony ${entry.project.PopulationID}, implied ${entry.implied.toFixed(2)} BP/yr against the app's ${entry.app.toFixed(2)} (${(((entry.implied / entry.app) - 1) * 100).toFixed(2)}%)`))

  // The engine's one cycle from the stock before it.
  const increments = incrementComparison(cycleData, page, options.engine, years)

  if (increments.compared.length) {
    holds(INCREMENT_CHECK, increments.agree.length > increments.differ.length, `${increments.agree.length} agree, ${increments.differ.length} differ of ${increments.compared.length} (the app's capacity is the saved state after the cycle)`)
  } else {
    unsupportedNote(`${label}: no resolvable project alone in its use type at a colony with a capacity figure, so the engine's one cycle is not compared with the ledger`)
  }

  increments.differ.forEach((entry) => console.log(`        differs: project #${entry.project.ProjectID} at colony ${entry.project.PopulationID}, the engine builds ${entry.engine.toFixed(4)} and the ledger shows ${entry.ledger.toFixed(4)}`))

  // Capacity shared among the colony's projects.
  const pairs = []
  const byPopulation = new Map()

  compared.forEach((entry) => byPopulation.set(entry.project.PopulationID, [...(byPopulation.get(entry.project.PopulationID) || []), entry]))
  byPopulation.forEach((list) => {
    for (let one = 0; one < list.length; one++) {
      for (let other = one + 1; other < list.length; other++) {
        if (KINDS[list[one].project.ProductionType] === KINDS[list[other].project.ProductionType]) {
          pairs.push([list[one].implied / list[one].app, list[other].implied / list[other].app])
        }
      }
    }
  })

  if (pairs.length) {
    holds('two projects of one colony and capacity kind measure one capacity (their builds divide it by their shares)', pairs.every(([alpha, beta]) => Math.abs(alpha - beta) <= SHARED_TOLERANCE), `${pairs.length} pairs`)
  } else {
    unsupportedNote(`${label}: no colony has two resolvable projects of one capacity kind`)
  }

  return { results, agreeing: agreeing.length, compared: compared.length, solos: solos.length, resolved: resolved.length, increments, cycleData }
}

const structureChecks = async (database) => {
  const columns = await rowsOf(database, 'pragma table_info(FCT_IndustrialProjects)')
  const key = columns.filter((column) => column.pk > 0)

  check('the project table is keyed by its own integer ProjectID (a row id), so no save keeps the order the game visits projects in', key.length === 1 && key[0].name === 'ProjectID' && /^INTEGER$/i.test(key[0].type), `key ${key.map((column) => `${column.name} ${column.type}`).join(', ') || 'none'}`)
}

const instantiatePage = (options, database, game, race) => instantiate(options, { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }, database, GameID: game, RaceID: race })

const main = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const apps = await loadUtilities(['production', 'minerals', 'industry-cycle', 'decimal', 'provenance'], { stubs: STUBS })
  const pageOptions = await loadPage('pages/production', { stubs: STUBS })

  console.log('== the cycle: worked cases ==')
  workedCases(cycle, apps).forEach(([statement, held]) => check(statement, held))
  scheduleCases(apps.production).forEach(([statement, held]) => check(statement, held))

  const bounds = orderBounds()

  check('SYNTHETIC with 20 t of Duranium arriving each cycle, every order finishes both jobs, and the finish cycle depends on the order', bounds.outcomes.every((outcome) => outcome.A && outcome.B) && new Set(bounds.outcomes.map((outcome) => `${outcome.A}-${outcome.B}`)).size > 1, JSON.stringify(bounds.outcomes))

  const mutants = [
    { name: 'a model whose jobs each see the whole stock (no shared debit)', fails: 'SYNTHETIC conservation: the jobs of a cycle take no more of a mineral than the colony held, in either order', run: () => workedCases((input) => cycle({ ...input, wholeStock: true })) },
    { name: 'a model that does not round the build to 4 decimals', fails: 'SYNTHETIC the build is rounded to 4 decimals: 10 t over 3 t a unit is 3.3333 units, not 3.3333333', run: () => workedCases((input) => cycle({ ...input, unrounded: true })) },
  ]

  mutants.forEach((mutant) => {
    const failed = mutant.run().filter(([, held]) => !held).map(([statement]) => statement)

    check(`${mutant.name} fails the check "${mutant.fails}"`, failed.includes(mutant.fails), `${failed.length} checks fail`)
  })

  const counted = await mutatedEngine(null, null)
  const engineResults = engineCases(counted['industry-cycle'], counted.decimal)

  console.log('\n== the cycle engine and the page\'s forecast ==')
  engineResults.forEach(({ statement, held }) => check(statement, held))
  const wrapperResults = wrapperCases(apps)

  wrapperResults.forEach(([statement, held]) => check(statement, held))

  const ENGINE_MUTANTS = [
    { name: 'an engine whose projects do not debit the stock they build from', from: 'left[resource] = subtract(left[resource] || ZERO, multiply(need, requested))', to: 'left[resource] = left[resource] || ZERO', fails: 'conserved' },
    { name: 'an engine that does not round a build to 4 decimals', from: 'requested = round(requested, BUILD_DECIMALS)', to: 'requested = requested', fails: 'rounded' },
    { name: 'an engine whose steady stretch runs one cycle past the finish', from: 'span = Math.min(span, ceilRatio(subtract(state.amount, reach), state.step), additions(', to: 'span = Math.min(span, ceilRatio(subtract(state.amount, reach), state.step) + 1, additions(', fails: 'stepwise' },
    { name: 'an engine whose steady stretch runs one cycle past the stock', from: 'positive(available) ? floorRatio(available, amount) : 0', to: 'positive(available) ? floorRatio(available, amount) + 1 : 0', fails: 'fuelJump' },
    { name: 'an engine that starts a promoted project a cycle late', from: 'const building = states.filter((state) => state.held && !state.finished && !state.unresolved && !state.paused)', to: 'const building = states.filter((state) => state.held && !state.finished && !state.unresolved && !state.paused && (state.startCycle === 0 || state.startCycle < next - 1))', fails: 'queue' },
    { name: 'an engine that releases the share of a paused project', from: 'list.filter((state) => state.held).map((state) => state.share), 1)', to: 'list.filter((state) => state.held && !state.paused).map((state) => state.share), 1)', fails: 'paused' },
    { name: 'an engine that puts an arrival in the cycle before its day', from: 'Math.max(1, Math.ceil(arrival.day / cycleDays - EPSILON))', to: 'Math.max(1, Math.floor(arrival.day / cycleDays))', fails: 'arrivalCycle' },
    { name: 'an engine that ignores the stock an arrival adds', from: 'left[arrival.resource] = add(left[arrival.resource] || ZERO, arrival.quantity)', to: 'left[arrival.resource] = left[arrival.resource] || ZERO', fails: 'arrivalShift' },
    { name: 'an engine that leaves the source installations of a conversion in place after it converts them', from: '      if (state.source) {\n        left[state.source] = subtract(left[state.source] || ZERO, delivered)\n      }\n\n      // The game finishes a project', to: '      // The game finishes a project', fails: 'source' },
    { name: 'an engine that takes the order of the projects as given and tries no other', from: 'if (contested.size >= 2) {', to: 'if (contested.size >= Infinity) {', fails: 'order' },
    { name: 'an engine whose contention counts the unrounded builds', from: 'const want = round(minimum(state.units, state.amount), BUILD_DECIMALS)', to: 'const want = minimum(state.units, state.amount)', fails: 'contendRounded' },
    { name: 'an engine that flags only a rounded overshoot, not a remainder short of the last unit, as a project that cannot finish', from: 'if (stall.reason === \'remainder\') {', to: 'if (stall.reason === \'remainder\' && !positive(state.amount)) {', fails: 'successor' },
    { name: 'an engine that does not hold back the project queued behind one that cannot finish exactly', from: 'state.unresolved = true', to: 'state.unresolved = false', fails: 'successor' },
    { name: 'an engine that rounds the part of a unit left to 4 decimals again', from: '      } else {\n        state.amount = subtract(state.amount, built)\n      }', to: '      } else {\n        state.amount = round(subtract(state.amount, built), BUILD_DECIMALS)\n      }', fails: 'ledgerRemainder' },
    { name: 'an engine that completes a project whose build is within a millionth of a unit of what it had left', from: 'if (equal(built, state.amount)) {', to: 'if (!less(built, subtract(state.amount, fromString(\'0.000001\')))) {', fails: 'ledgerCut' },
    { name: 'an engine that rounds the build the fuel allows to 4 decimals', from: 'requested = divide(stock, state.fuel)', to: 'requested = round(divide(stock, state.fuel), BUILD_DECIMALS)', fails: 'deficit' },
    { name: 'an engine that lets the fuel go by a billionth of the request', from: 'if (less(stock, multiply(state.fuel, requested))) {', to: 'if (less(stock, multiply(multiply(state.fuel, requested), fromString(\'0.999999999\')))) {', fails: 'deficit' },
    { name: 'an engine that reports a stock that exactly covers a build as a cut', from: 'if (less(stock, multiply(state.fuel, requested))) {', to: 'if (!greater(stock, multiply(state.fuel, requested))) {', fails: 'exactCover' },
    { name: 'a decimal type that reads a number from the save as the number printed to 15 digits', file: DECIMAL_FILE, from: 'return places < 0 ? fit(signed * power(-places), 0) : make(signed, places)', to: 'return fromString(value.toPrecision(15))', fails: 'decimalRead' },
    { name: 'a decimal type that reads a number from the save to 20 digits, with the error of the double in them', file: DECIMAL_FILE, from: 'return places < 0 ? fit(signed * power(-places), 0) : make(signed, places)', to: 'return fromString(value.toPrecision(20))', fails: 'ledgerInherited' },
    { name: 'a decimal type that reads a number from the save to 14 digits', file: DECIMAL_FILE, from: 'let places = 14 - ((exponent * 19728) >> 16)', to: 'let places = 13 - ((exponent * 19728) >> 16)', fails: 'decimalRead' },
    { name: 'a decimal type that reads a midpoint of the 15-digit integer up', file: DECIMAL_FILE, from: '(left === 0.5 && mantissa % 2 === 1)', to: 'left === 0.5', fails: 'decimalRead' },
    { name: 'a decimal type that does not scale a number of 14 digits up to 15', file: DECIMAL_FILE, from: 'if (scaled < 1e14 && places < MAX_SCALE) {', to: 'if (false) {', fails: 'decimalRead' },
    { name: 'a decimal type that reads a number below 2^-91 as 0', file: DECIMAL_FILE, from: 'if (exponent < -94) {', to: 'if (exponent < -90) {', fails: 'decimalRead' },
    { name: 'an engine that takes a stretch of cycles in one step without asking whether the game\'s additions are exact', from: 'span = Math.min(span, additions(left[resource] || ZERO, list))', to: 'span = Math.min(span, limit)', fails: 'jumpExact' },
    { name: 'an engine whose steady stretch is held back by a project cut to nothing', from: 'if (state.lastBuild === null) {', to: 'if (state.lastBuild === null || state.lastCut) {', fails: 'slices' },
    { name: 'an engine that does not look at the pace at the start of a cycle', from: 'if (pace.expired()) {', to: 'if (false) {', fails: 'loneSlices' },
    { name: 'a decimal type whose repeated additions count one too many at the limit', file: DECIMAL_FILE, from: '(step > 0n ? LIMIT - 1n - from : from + LIMIT - 1n)', to: '(step > 0n ? LIMIT - from : from + LIMIT)', fails: 'additions' },
    { name: 'a decimal type whose repeated additions ignore a start that does not fit on the scale of the terms', file: DECIMAL_FILE, from: 'if (magnitude(from) >= LIMIT) {', to: 'if (false) {', fails: 'additions' },
    { name: 'a decimal type that rounds a midpoint up', file: DECIMAL_FILE, from: '(twice === divisor && (quotient & 1n) === 1n)', to: 'twice === divisor', fails: 'tie' },
    { name: 'a decimal type that cuts a rounding to 4 places off instead of rounding it', file: DECIMAL_FILE, from: 'make(roundedQuotient(value.m, power(value.s - places)), places)', to: 'make(value.m / power(value.s - places), places)', fails: 'decimalRound' },
    { name: 'a decimal type that divides to 15 digits', file: DECIMAL_FILE, from: 'let digits = Math.max(0, MAX_SCALE - scale)', to: 'let digits = Math.max(0, 15 - scale)', fails: 'decimalDivide' },
    { name: 'a decimal type with a mantissa of 100 bits', file: DECIMAL_FILE, from: 'const LIMIT = 1n << 96n', to: 'const LIMIT = 1n << 100n', fails: 'decimalDivide' },
    { name: 'an engine that takes the length of a cycle in years through the nearest double and not the platform\'s own conversion', from: 'fromDouble(toDouble(divide(', to: 'fromDouble(toNumber(divide(', fails: 'nativeYears' },
    { name: 'a decimal type that makes a double of a 64-bit part from 2^63 up without the platform\'s second rounding', file: DECIMAL_FILE, from: 'const lowNumber = low < TWO_POWER_63 ? Number(low) : Number(low - TWO_POWER_64) + 18446744073709551616', to: 'const lowNumber = Number(low)', fails: 'nativeYears' },
    { name: 'a decimal type that makes a double of a decimal without its high 32 bits', file: DECIMAL_FILE, from: '(lowNumber + Number(high) * 18446744073709551616) / DOUBLE_POWERS[value.s]', to: 'lowNumber / DOUBLE_POWERS[value.s]', fails: 'nativeYears' },
    { name: 'an engine whose stretch of steady cycles runs past the first cycle the stock check cuts', from: 'span = Math.min(span, negative(slack) ? 0 : 1 + floorRatio(slack, draw[resource]))', to: 'span = Math.min(span, limit)', fails: 'capJump' },
    { name: 'an engine that keeps the fine remainder flag of an earlier attempt on a project that then finishes exactly', from: '        state.finished = true\n        state.fineRemainder = false\n', to: '        state.finished = true\n', fails: 'exactRemainder' },
    { name: 'an engine that takes a whole cycle of a wide cohort between two looks at the pace', from: '      if (index > 0 && pace.expired()) {\n        yield\n      }\n\n      const { built, cut, stall, finishing } = buildCycle(state, left, unlimited)', to: '      const { built, cut, stall, finishing } = buildCycle(state, left, unlimited)', fails: 'wideCohort' },
    { name: 'an engine that adds up the share the colony holds again at every finish', from: 'heldShare[state.category] = subtract(heldShare[state.category], state.share)', to: 'heldShare[state.category] = states.filter((other) => other.held && !other.finished && other.category === state.category).reduce((sum, other) => add(sum, other.share), ZERO)', fails: 'wideCohort' },
    { name: 'an engine that makes the figures of every project of a wide colony without a look at the pace', from: 'for (const [index, state] of first.states.entries()) {\n    if (index > 0 && pace.expired()) {\n      yield\n    }\n\n', to: 'for (const [index, state] of first.states.entries()) {\n', fails: 'wideCohort' },
    { name: 'an engine that sets up every project of a wide colony without a look at the pace', from: '  for (const [index, project] of projects.entries()) {\n    if (index > 0 && pace.expired()) {\n      yield\n    }\n\n    prepared.push', to: '  for (const [index, project] of projects.entries()) {\n    prepared.push', fails: 'wideCohort' },
    { name: 'an engine whose steady stretch keeps no source installation back for each converting project', from: 'subtract(left[resource] || ZERO, fromDouble(counts[resource] || 0))', to: 'subtract(left[resource] || ZERO, ZERO)', fails: 'sourceReserve' },
    { name: 'an engine that keeps a running total of the share held for every kind, added up in order at the start and then reduced by each finish, even where the type cannot add the shares exactly', from: '.filter(([, list]) => sumsExactly(list.map((state) => state.share))).forEach(([category, list]) => (heldShare[category] = addMultiple(ZERO, list.filter((state) => state.held).map((state) => state.share), 1)))', to: '.forEach(([category, list]) => (heldShare[category] = list.filter((state) => state.held).reduce((sum, state) => add(sum, state.share), ZERO)))', fails: 'heldSum' },
    { name: 'a decimal type that reads shares of any sign as exactly addable when their sum fits', file: DECIMAL_FILE, from: 'values.every((value) => !negative(value)) && repeatedAt(ZERO, values).step < LIMIT', to: 'repeatedAt(ZERO, values).step < LIMIT', fails: 'heldNegative' },
    { name: 'an engine that adds up the share held again at a finish without a look at the pace between the projects', from: '      if (index > 0 && pace.expired()) {\n        yield\n      }\n\n      if (member.held && !member.finished) {', to: '      if (member.held && !member.finished) {', fails: 'heldPaced' },
    { name: 'an engine that works out a steady stretch of a wide cohort without a look at the pace between projects', from: '  for (const [index, state] of building.entries()) {\n    if (index > 0 && pace.expired()) {\n      yield\n    }\n\n    if (state.lastBuild === null) {', to: '  for (const state of building) {\n    if (state.lastBuild === null) {', fails: 'wideMinerals' },
    { name: 'an engine that makes the debits of a wide cohort without a look at the pace between projects', from: '  for (const [index, state] of running.entries()) {\n    if (index > 0 && pace.expired()) {\n      yield\n    }\n\n    state.needs.forEach(([resource, need]) => (debits[resource]', to: '  for (const state of running) {\n    state.needs.forEach(([resource, need]) => (debits[resource]', fails: 'wideMinerals' },
    { name: 'an engine that checks the stock the projects ahead leave for a wide cohort without a look at the pace between projects', from: '    for (const [index, state] of running.entries()) {\n      if (index > 0 && pace.expired()) {\n        yield\n      }\n\n      state.minerals.forEach(([resource, need]) => {', to: '    for (const state of running) {\n      state.minerals.forEach(([resource, need]) => {', fails: 'wideMinerals' },
    { name: 'an engine that applies a stretch to a wide cohort without a look at the pace between projects', from: '      for (const [index, state] of running.entries()) {\n        if (index > 0 && pace.expired()) {\n          yield\n        }\n\n        const total = addMultiple(state.partial, [state.step], span)', to: '      for (const state of running) {\n        const total = addMultiple(state.partial, [state.step], span)', fails: 'wideMinerals' },
    { name: 'an engine that scans the contention of a wide cohort without a look at the pace between projects', from: '  for (const [index, state] of building.entries()) {\n    if (index > 0 && pace.expired()) {\n      yield\n    }\n\n    const want = round(', to: '  for (const state of building) {\n    const want = round(', fails: 'wideContested' },
    { name: 'an engine that adds up what a wide cohort wants of a mineral without a look at the pace between the entries', from: '    for (const [index, entry] of list.entries()) {\n      if (index > 0 && pace.expired()) {\n        yield\n      }\n\n      asked = add(asked, entry.quantity)', to: '    for (const entry of list) {\n      asked = add(asked, entry.quantity)', fails: 'wideContested' },
    { name: 'an engine that keeps every run it makes until the figures are made', from: '        foldRun(tallies, result, first)\n', to: '        foldRun(tallies, result, first)\n        kept.push(result)\n', fails: 'wideContested' },
    { name: 'an engine that works out a stretch\'s limit by each mineral without a look at the pace between the minerals', from: '    for (const [index, [resource, list]] of owed.entries()) {\n      if (index > 0 && pace.expired()) {\n        yield\n      }\n\n      span = Math.min(span, additions(left[resource] || ZERO, list))', to: '    for (const [, [resource, list]] of owed.entries()) {\n      span = Math.min(span, additions(left[resource] || ZERO, list))', fails: 'resourceLooks' },
    { name: 'an engine that applies a stretch to the stock of each mineral without a look at the pace between the minerals', from: '      for (const [index, [resource, list]] of owed.entries()) {\n        if (index > 0 && pace.expired()) {\n          yield\n        }\n\n        left[resource] = addMultiple(left[resource] || ZERO, list, span)', to: '      for (const [, [resource, list]] of owed.entries()) {\n        left[resource] = addMultiple(left[resource] || ZERO, list, span)', fails: 'resourceLooks' },
    { name: 'an engine whose tally of the last cycle a project finished in over the orders takes the least', from: 'tally.finishHigh = Math.max(tally.finishHigh, entry.finishCycle)', to: 'tally.finishHigh = Math.min(tally.finishHigh, entry.finishCycle)', fails: 'tally' },
    { name: 'an engine whose tally of the most a project built over the orders takes the least', from: '  if (greater(entry.built, tally.buildHigh)) {', to: '  if (less(entry.built, tally.buildHigh)) {', fails: 'tally' },
    { name: 'an engine whose tally counts at most one run that cut a project', from: '    tally.cut += 1\n', to: '    tally.cut = 1\n', fails: 'tally' },
  ]

  for (const mutant of ENGINE_MUTANTS) {
    const loaded = await mutatedEngine(mutant.from, mutant.to, mutant.file)
    const mutated = engineCases(loaded['industry-cycle'], loaded.decimal)
    const named = engineResults.find(({ key }) => key === mutant.fails)
    const broken = mutated.filter(({ held }) => !held).map(({ key }) => key)

    check(`${mutant.name} fails the check "${named.statement.slice(0, 90)}..."`, named.held && broken.includes(mutant.fails), `${broken.length} cases fail: ${broken.join(', ')}`)
  }

  const WRAPPER_MUTANTS = [
    { name: 'a wrapper that gives the date of a crowded colony as plain when the orders were only sampled', file: 'production.js', from: 'const sampled = !engine.orders.exhaustive', to: 'const sampled = false', fails: 'sampled' },
    { name: 'a wrapper that dates the start of a queued project by the base order alone', file: 'production.js', from: 'start: queued ? figure.startEarliest : 0, startRange', to: 'start: queued ? figure.start : 0, startRange', fails: 'startRange' },
    { name: 'a wrapper that reads a stranded remainder as a stock the colony lacks', file: 'production.js', from: 'figure.outcome === \'stalls\' && figure.stall.resource !== null', to: 'figure.outcome === \'stalls\'', fails: 'remainder' },
    { name: 'a wrapper that gives no reason when the project ahead of a queued one cannot finish exactly', file: 'production.js', from: '  unresolved: \'a start (', to: '  unresolvedGone: \'a start (', fails: 'unresolvedWrapper' },
    { name: 'a wrapper that lets an overflow of one colony out of the forecast', file: 'production.js', from: 'return { gaps: [overflowGap(error)] }', to: 'throw error', fails: 'overflowWrapper' },
    { name: 'a wrapper that makes the figures of every project of a wide colony without a look at the pace', file: 'production.js', from: '    if (index > 0 && pace.expired()) {\n      yield\n    }\n\n    const figure = engine.projects[project.ID]', to: '    const figure = engine.projects[project.ID]', fails: 'wideWrapper' },
  ]

  for (const mutant of WRAPPER_MUTANTS) {
    const mutated = wrapperCases(await mutatedUtilities(mutant.file, mutant.from, mutant.to))
    const named = wrapperResults.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${broken.join(', ')}`)
  }

  const PAGE_MUTANTS = [
    { name: 'a page that gives a Short job of a colony the forecast cannot run a finish date', from: 'if (!planned) {', to: 'if (planned) {', fails: 'fallbackShort' },
    { name: 'a page that drops the gaps of a colony the forecast cannot run', from: 'gaps[populationId] = outcome && outcome.gaps ? outcome.gaps : null', to: 'gaps[populationId] = null', fails: 'fallbackShort' },
    { name: 'a page that gives no caution under a project of a colony the forecast cannot run', from: 'this.fallbackCautions(PopulationID, gaps[PopulationID])', to: '[]', fails: 'fallbackShort' },
    { name: 'a page that says a Short project would finish with the one resource it is short of', from: ['', '{this.coverText(shortage)} of ', '{this.units(project.Amount)}', '{supplied !== null ? `, and with all the stock it needs'].join('$'), to: ['', '{this.coverText(shortage)} of ', '{this.units(project.Amount)}', '{supplied !== null ? `, and with ', '{shortage.name}'].join('$'), fails: 'suppliedNote' },
    { name: 'a page that gives no caution when the orders were only sampled', from: 'if (sampled) {', to: 'if (false) {', fails: 'sampledPage' },
    { name: 'a page that words a sampled range as a bound', from: 'rangeText(range) {\n      if (range.sampled) {', to: 'rangeText(range) {\n      if (false) {', fails: 'sampledPage' },
    { name: 'a page that leaves the start range out of the note of a queued project', from: 'planned && planned.startRange ? this.startRangeText(planned.startRange) : \'\'', to: '\'\'', fails: 'startPage' },
    { name: 'a page that gives a queued project behind an unresolved one a start date', from: 'planned && planned.forecast.outcome === \'unresolved\' ?', to: 'false ?', fails: 'unresolvedPage' },
    { name: 'a page that gives a colony still being forecast no Forecasting status', from: 'const forecasting = pending.has(PopulationID)', to: 'const forecasting = false', fails: 'forecastingPage' },
    { name: 'a forecast driver that shows the forecast of an input the run did not have', from: 'return this.forecastState.key === this.forecastKey ? this.forecastState : null', to: 'return this.forecastState', fails: 'forecastingPage', mixin: true },
    { name: 'a forecast driver that keeps the outcome of a run that was replaced', from: '          if (!slot.isCurrent(run)) {\n            return\n          }\n        }\n\n        const outcome = slot.publish(run)', to: '        }\n\n        const outcome = run.outcome()', fails: 'staleRun', mixin: true },
    { name: 'a forecast driver that does not state why a run failed', from: 'error: outcome.error || (outcome.status', to: 'error: (outcome.status', fails: 'failedRun', mixin: true },
    { name: 'a page that accepts a quantity the decimal type cannot hold', from: '&& Number(quantity) > 0 && fitsDouble(Number(quantity))', to: '&& Number(quantity) > 0', fails: 'arrivalRange' },
    { name: 'a page that gives no message for a quantity the decimal type cannot hold', from: '!fitsDouble(Number(quantity)) ? \'That quantity', to: 'false ? \'That quantity', fails: 'arrivalRange' },
    { name: 'a page that cautions about a remainder for every project', from: 'if (fineRemainder) {', to: 'if (true) {', fails: 'remainderCautionPage' },
    { name: 'a page that gives a paused project the Forecasting status while the run is pending', from: 'if (forecasting && (queued || paused !== true)) {', to: 'if (forecasting) {', fails: 'pausedPage' },
  ]

  const pageResults = await pageCases(pageOptions)

  console.log('\n== the page\'s rows on synthetic colonies ==')
  pageResults.forEach(([statement, held]) => check(statement, held))

  for (const mutant of PAGE_MUTANTS) {
    const mutated = await pageCases(mutant.mixin ? await pageWithMutatedMixin(mutant.from, mutant.to) : await loadPage('pages/production', { stubs: STUBS, mutate: onceReplacing(mutant.from, mutant.to) }))
    const named = pageResults.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${broken.join(', ')}`)
  }

  let agreeNormal = null

  for (const save of saves) {
    const database = await openSave(save.file)

    if (!database) {
      console.log(`SKIP  ${save.file}: not there (not run)`)
      continue
    }

    try {
      const page = instantiatePage(pageOptions, database, save.game, save.race)

      await page.runAsync('populationProductionModifiers')
      await structureChecks(database)

      const normal = await replay(database, save.game, save.race, database.file, { page, engine: apps['industry-cycle'] })

      normal.results.forEach(([statement, held, detail]) => check(`${database.file}: ${statement}`, held, detail))

      if (agreeNormal === null && normal.results.some(([statement]) => statement === MUTATED_CHECK)) {
        agreeNormal = { database, save, page, normal }
      }

      await pageChecks(page, apps.production, database.file)
    } finally {
      if (agreeNormal === null || agreeNormal.database !== database) {
        database.close()
      }
    }
  }

  if (agreeNormal) {
    const { database, save, page, normal } = agreeNormal
    const speaking = console.log
    const heldUnsupported = unsupported

    console.log = () => {}

    const day = await replay(database, save.game, save.race, `${database.file} (mutant: one day for every cycle)`, { page, engine: apps['industry-cycle'], years: 1 / 365 })

    console.log = speaking
    unsupported = heldUnsupported
    const failed = day.results.filter(([, held]) => !held).map(([statement]) => statement)
    const named = MUTATED_CHECK

    check(`a replay that takes a day for the years of every cycle fails the check "${named}" that the real years pass`, normal.results.filter(([statement]) => statement === named).every(([, held]) => held) && failed.includes(named), `${normal.agreeing} of ${normal.compared} agree with the cycle's years, ${day.agreeing} of ${day.compared} with a day`)
    check(`a replay that takes a day for the years of every cycle fails the check "${INCREMENT_CHECK}" that the real years pass`, normal.results.some(([statement]) => statement === INCREMENT_CHECK) && normal.results.filter(([statement]) => statement === INCREMENT_CHECK).every(([, held]) => held) && failed.includes(INCREMENT_CHECK), `${normal.increments.agree.length} of ${normal.increments.compared.length} agree with the cycle's years, ${day.increments.agree.length} of ${day.increments.compared.length} with a day`)
    database.close()
  }

  console.log(`\n${checks - failures}/${checks} checks passed; ${diverging} divergences of the fallback path (the continuous schedule and the per-project stock check the page keeps for a colony the engine cannot forecast) from the game's rule reported (not counted as agreement), ${unsupported} cases UNSUPPORTED (no case in the save, not counted as agreement)`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
