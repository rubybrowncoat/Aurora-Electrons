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
*/
const path = require('path')
const fs = require('fs')
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

const round4 = (value) => Math.round(value * 10000) / 10000

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

// The same colony cycle after cycle, a stock income each cycle: when each job finishes (the cycle number), null when it does not within `limit` cycles. A project promoted from the queue builds from the cycle after the one its predecessor finished in.
const campaign = ({ jobs, queued = [], stock, income = {}, capacity, years, limit = 60 }) => {
  let running = jobs.map((job) => ({ ...job }))
  let waiting = queued.map((job) => ({ ...job }))
  let held = { ...stock }
  const finished = {}

  for (let step = 1; step <= limit && (running.length || waiting.length); step++) {
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

    if (!done.length && !Object.values(income).some((amount) => amount > 0) && Object.values(result.builds).every((built) => built === 0)) {
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
      diverges('SYNTHETIC the app checks each job against the whole stock: 40 t covers the 4 units each job has left, so neither shows short, while the two need 80 t between them', `app shortage ${JSON.stringify(appShort)}`)
    }

    const lateStart = production.industrySchedule([{ ID: 'A', Percentage: 60, Amount: 2, ProdPerUnit: 2, Queue: 0, Paused: 0 }, { ID: 'Q', Percentage: 50, Amount: 2, ProdPerUnit: 2, Queue: 1, Paused: 0 }], capacity).Q

    diverges('SYNTHETIC the app starts a promoted project the moment its predecessor finishes and dates it by continuous work, where the game builds it from the next cycle on and finishes it at a cycle\'s end', `app: starts day ${lateStart.start.toFixed(3)}, finishes day ${lateStart.finish.toFixed(3)}; game: builds in cycle 2, finishes at the end of day 2`)

    const joint = campaign({ jobs: [first, second].map((job) => ({ ...job, partial: 0 })), stock, income: { Duranium: 0 }, capacity, years })

    if (!joint.A && !joint.B) {
      diverges('SYNTHETIC with no income the two jobs never both finish (the stock covers 4 of the 8 units), where the app dates them at 1.3 and 2 days', `finish cycles A ${joint.A || 'never'}, B ${joint.B || 'never'}`)
    }

    const chain = [{ ID: 1, Percentage: 100, Amount: 1, ProdPerUnit: 1, Queue: 0, Paused: 0 }, { ID: 2, Percentage: 100, Amount: 1, ProdPerUnit: 1, Queue: 1, Paused: 0 }, { ID: 3, Percentage: 100, Amount: 1, ProdPerUnit: 1, Queue: 2, Paused: 0 }]
    const appChain = production.industrySchedule(chain, capacity)
    const modelChain = campaign({ jobs: [{ id: 1, share: 100, perUnit: 1, amount: 1, partial: 0, needs: {} }], queued: [2, 3].map((id) => ({ id, share: 100, perUnit: 1, amount: 1, partial: 0, needs: {} })), stock: {}, capacity, years })
    const cycleDays = years * 365

    holds('SYNTHETIC reference model: three sequential 100% jobs of 1 build point at 10 points a day finish in cycles 1, 2 and 3 (days 1, 2, 3 of 1-day cycles), each queued job building from the cycle after its predecessor finished', modelChain[1] === 1 && modelChain[2] === 2 && modelChain[3] === 3)
    holds('SYNTHETIC the app dates the same three jobs by continuous work at 0.1, 0.2 and 0.3 days', near(appChain[1].finish, 0.1) && near(appChain[2].finish, 0.2) && near(appChain[3].finish, 0.3))
    diverges('SYNTHETIC the app\'s date error grows with queue depth: each promotion can add up to one cycle', `app finishes ${[1, 2, 3].map((id) => appChain[id].finish.toFixed(3)).join(' / ')} days; model ${[1, 2, 3].map((id) => (modelChain[id] * cycleDays).toFixed(3)).join(' / ')} days; error ${[1, 2, 3].map((id) => (modelChain[id] * cycleDays - appChain[id].finish).toFixed(3)).join(' / ')} days`)

    const slow = [54.385, 55.115].map((slowCapacity) => {
      const job = { id: 1, share: 100, perUnit: 1000, amount: 1, partial: 0, needs: {} }
      const appDays = production.industrySchedule([{ ID: 1, Percentage: 100, Amount: 1, ProdPerUnit: 1000, Queue: 0, Paused: 0 }], slowCapacity)[1].finish
      const modelCycles = campaign({ jobs: [job], stock: {}, capacity: slowCapacity, years, limit: 20000 })[1]

      return { appDays, modelDays: modelCycles * cycleDays }
    })

    holds('SYNTHETIC the app dates one 1000-point unit at 100% share by continuous work: 54.385 build points a year take 6711.4 days and 55.115 take 6622.5 days', near(slow[0].appDays, 6711.4, 1e-5) && near(slow[1].appDays, 6622.5, 1e-5))
    holds('SYNTHETIC the reference model rounds each cycle\'s build to 4 decimals: the same unit takes 10000 one-day cycles at 54.385 build points a year (0.000149 a cycle rounds down to 0.0001) and 5000 at 55.115 (0.000151 rounds up to 0.0002)', slow[0].modelDays === 10000 && slow[1].modelDays === 5000)
    diverges('SYNTHETIC rounding, not queue depth: when a cycle\'s build is under about 0.0005 unit the 4-decimal rounding changes the effective rate, so the app\'s date is neither a lower nor an upper bound', `54.385 BP/yr: app ${slow[0].appDays.toFixed(1)} days, model ${slow[0].modelDays.toFixed(1)} (${(slow[0].modelDays - slow[0].appDays).toFixed(1)}); 55.115 BP/yr: app ${slow[1].appDays.toFixed(1)} days, model ${slow[1].modelDays.toFixed(1)} (${(slow[1].modelDays - slow[1].appDays).toFixed(1)})`)
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

    colonies.push({ populationId, orders: outcomes.length, conserved, dependent, finishes })
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

  return { results, agreeing: agreeing.length, compared: compared.length, solos: solos.length, resolved: resolved.length }
}

const structureChecks = async (database) => {
  const columns = await rowsOf(database, 'pragma table_info(FCT_IndustrialProjects)')
  const key = columns.filter((column) => column.pk > 0)

  check('the project table is keyed by its own integer ProjectID (a row id), so no save keeps the order the game visits projects in', key.length === 1 && key[0].name === 'ProjectID' && /^INTEGER$/i.test(key[0].type), `key ${key.map((column) => `${column.name} ${column.type}`).join(', ') || 'none'}`)
}

const instantiatePage = (options, database, game, race) => instantiate(options, { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }, database, GameID: game, RaceID: race })

const main = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const apps = await loadUtilities(['production', 'minerals'], { stubs: STUBS })
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

      const normal = await replay(database, save.game, save.race, database.file, { page })

      normal.results.forEach(([statement, held, detail]) => check(`${database.file}: ${statement}`, held, detail))

      if (agreeNormal === null && normal.results.some(([statement]) => statement === MUTATED_CHECK)) {
        agreeNormal = { database, save, page, normal }
      }
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

    const day = await replay(database, save.game, save.race, `${database.file} (mutant: one day for every cycle)`, { page, years: 1 / 365 })

    console.log = speaking
    unsupported = heldUnsupported
    const failed = day.results.filter(([, held]) => !held).map(([statement]) => statement)
    const named = MUTATED_CHECK

    check(`a replay that takes a day for the years of every cycle fails the check "${named}" that the real years pass`, normal.results.filter(([statement]) => statement === named).every(([, held]) => held) && failed.includes(named), `${normal.agreeing} of ${normal.compared} agree with the cycle's years, ${day.agreeing} of ${day.compared} with a day`)
    database.close()
  }

  console.log(`\n${checks - failures}/${checks} checks passed; ${diverging} divergences of the app from the game's rule reported (not counted as agreement), ${unsupported} cases UNSUPPORTED (no case in the save, not counted as agreement)`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
