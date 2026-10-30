/*
  Checks the Production page's component calculator (utilities/component-calc.js): the share of a colony's construction capacity that builds the manufactured components of a ship class by a deadline.

  node scripts/check-component-calc.js [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784) and the stock 2.7.1 save in saves/ (AuroraDB_271_skoormit_saved.db, game 138, race 785), read-only.

  Worked cases on synthetic rows (labelled so) run the real functions: the stock of a component is taken once and never per hull, whole units are built, the components built with the hull stay out of the share, a project out of the queue holds its share whether running or paused, a batch is split by build points, an infeasible deadline reports the shortfall and the share needed against the share free and never allocates more than is free, a shortage of minerals is reported apart from a shortage of components, the batch's own forecast is the engine's (the share found is the least that finishes by the deadline, checked against the engine's own run of the same rows), and a change of hulls, deadline or stock gives a new answer from the same input with nothing read.

  The saves are read through the page's own read (`componentSources`) and checked against a count of the rows in the save; the calculation then runs on the colonies with the most construction capacity. A check that needs a case the save does not hold prints UNSUPPORTED and is in neither the passes nor the failures.

  The mutants load a temp copy of the utilities folder with one thing changed in component-calc.js; each must fail the check named with it.
*/
const path = require('path')
const fs = require('fs')
const os = require('os')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')
const { jobs } = require('./lib/check-pool')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const DEFAULT_SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const UTILITIES = ['component-calc', 'production', 'minerals', 'industry-cycle', 'decimal', 'provenance', 'search-run']
const TOLERANCE = 1e-9

let failures = 0
let checks = 0
let unsupported = 0

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

const parseArguments = (argv) => {
  const saves = []
  let part = null

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else if (argv[index] === '--part') {
      part = argv[++index]
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  return { saves: saves.length ? saves : DEFAULT_SAVES, part }
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

// The utilities loaded from a temp copy of the folder in which each `from` (one string or a list), which must occur once in component-calc.js, is replaced by the `to` at its place: a mutant that must fail the check named with it.
const mutatedUtilities = async (from, to) => {
  const source = path.join(root, 'src', 'renderer', 'utilities')
  const edits = [].concat(from).map((text, index) => [text, [].concat(to)[index]])
  let code = fs.readFileSync(path.join(source, 'component-calc.js'), 'utf8')

  for (const [text, replacement] of edits) {
    const parts = code.split(text)

    if (parts.length !== 2) {
      throw new Error(`the mutation "${text}" matches ${parts.length - 1} times in component-calc.js, not once`)
    }

    code = parts.join(replacement)
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-component-mutant-'))

  try {
    fs.cpSync(source, directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'component-calc.js'), code)

    return await loadUtilities(UTILITIES, { stubs: STUBS, directory })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// The calculator's component as a page loads: its script from a temp copy of the renderer's utilities and mixins, with its imports one folder up (the loader reads a relative import a folder deep), `mutate` rewriting the script text.
const loadCalculator = async (mutate = null) => {
  const source = path.join(root, 'src', 'renderer')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-calculator-'))

  try {
    for (const folder of ['utilities', 'mixins']) {
      fs.cpSync(path.join(source, folder), path.join(directory, folder), { recursive: true })
    }

    fs.mkdirSync(path.join(directory, 'pages'))
    fs.writeFileSync(path.join(directory, 'pages', 'ComponentCalculator.vue'), fs.readFileSync(path.join(source, 'components', 'production', 'ComponentCalculator.vue'), 'utf8').split('from \'../../').join('from \'../'))

    return await loadPage('pages/ComponentCalculator', { directory, stubs: STUBS, mutate })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// The calculator component on a plan: the component's own computed (`verdict`, `tiles`), given the plan, the needs of the batch and a deadline in days (a date reads as its day number, which the check does not look at).
const verdictOf = (options) => (plan, needs, deadlineDays) => instantiate(options, { $store: { getters: { StartYear: 2000, GameTime: 0 }, state: {}, dispatch: async () => {} }, data: { plan, needs, deadlineDays, computing: false, dateIn: (days) => `day ${days}` } })

const MODIFIERS = { PopName: 'Test colony', ConstructionProduction: 36500, OverallProductionModifier: 1, ConstructionPower: 1, EngineerProductionModifier: 0, GroundConstructionPower: 0, OrdnanceProduction: 0, OrdnanceProductionPower: 0, FighterProduction: 0, FighterProductionPower: 0, MinConstructionPeriod: 86400 }
const HULLS = 4
const DEADLINE = 30

const part = (componentId, name, typeId, count, cost, minerals, extra = {}) => ({ componentId, name, typeId, count, cost, minerals: { ...Object.fromEntries(MINERAL_NAMES.map((mineral) => [mineral, 0])), ...minerals }, prototype: 0, shippingLine: 0, researched: 1, obsolete: 0, ...extra })

// A class mounting what a hull of a ship has: three components a project builds, one of them in halves, and each kind the shipyard builds with the hull.
const ENGINE = part(101, 'Engine', 1, 2, 50, { Duranium: 25, Corbomite: 25 })
const SENSOR = part(102, 'Sensor', 2, 1, 100, { Duranium: 100 })
const HALF = part(108, 'Half-size gear', 3, 0.5, 40, { Duranium: 40 })
const ARMOUR = part(103, 'Armour', 11, 4, 10, { Duranium: 10 })
const BUILT = [ENGINE, SENSOR, HALF]
const CLASS_PARTS = [ENGINE, SENSOR, HALF, ARMOUR]

// The colony's stock is in every row of its projects, as the page reads them: a row of 1,000,000 t of each mineral unless the case says otherwise.
const projectRow = (extra = {}) => ({ ID: 1, Name: `Project ${extra.ID || 1}`, ProductionType: 0, PopulationID: 7, Percentage: 100, Amount: 4, PartialCompletion: 0, ProdPerUnit: 2, Queue: 0, Paused: 0, FuelRequired: 0, StockFuel: 0, ConversionFrom: null, ConversionSource: null, ...Object.fromEntries(MINERAL_NAMES.flatMap((name) => [[name, 0], [`Stock${name}`, 1e6]])), ...extra })

const stockOfMinerals = (amount) => Object.fromEntries(MINERAL_NAMES.map((name) => [name, amount]))

// The calculator's cases on synthetic rows, as [statement, held, key]. `apps` are the utilities under test (a mutant passes its own), `capacities` the colony's capacity results from the page, `narrow` the utilities with the range scanned a share at a time cut to one hundredth and `verdict` the calculator component's verdict on a plan.
const syntheticCases = (apps, capacities, narrow, verdict) => {
  const results = []
  const holds = (key, statement, condition) => results.push([statement, Boolean(condition), key])
  const calc = apps['component-calc']
  const capacity = capacities.construction.value
  const colony = (extra = {}) => ({ populationId: 7, projects: [], capacities, modifiers: MODIFIERS, arrivals: [], npr: false, minerals: stockOfMinerals(1e6), ...extra })
  const input = (extra = {}) => ({ parts: CLASS_PARTS, hulls: HULLS, stock: {}, deadline: DEADLINE, colony: colony(), ...extra })
  const closed = (bp, days = DEADLINE) => bp / (capacity * days / 365) * 100

  // The engine's own run of a batch at the shares of an allocation, on the colony's own rows: when the last project of the batch finishes in the worst order.
  const engineLatest = (_plan, parts, hulls, hundredths, own = [], duranium = 1e6, cap = capacities, modifiers = MODIFIERS) => {
    const needs = calc.requirements({ parts, hulls, stock: {} })
    const rows = needs.rows.filter((row) => row.units > 0)
    const batch = rows.map((row, index) => projectRow({ ID: calc.BATCH_ID_BASE + index, Name: row.name, ProductionType: 3, Percentage: hundredths[index] / 100, Amount: row.units, ProdPerUnit: row.cost, ...Object.fromEntries(MINERAL_NAMES.flatMap((name) => [[name, row.minerals[name]], [`Stock${name}`, 1e6]])), StockDuranium: duranium }))
    const forecast = apps.production.industryForecast({ projects: [...own, ...batch], capacities: cap, modifiers, arrivals: [], npr: false })
    const figures = forecast.figures.filter((figure) => figure.forecast.ID >= calc.BATCH_ID_BASE).map((figure) => figure.forecast)

    return figures.some((figure) => figure.latest === null) ? null : Math.max(...figures.map((figure) => figure.latest))
  }

  // What the stock covers: each component against its own count, once.
  const stocked = calc.requirements({ parts: CLASS_PARTS, hulls: 3, stock: { 101: 4, 102: 10, 103: 1, 108: 100 } })
  const byId = Object.fromEntries(stocked.rows.map((row) => [row.componentId, row]))

  holds('stockOnce', 'SYNTHETIC the stock of a component is taken once against all the hulls together: 4 engines in stock for 3 hulls of 2 need 6, use 4 and leave 2 to build, never 4 a hull', byId[101].needed === 6 && byId[101].used === 4 && byId[101].remaining === 2 && byId[101].units === 2)
  holds('stockCapped', 'SYNTHETIC a stock larger than the need is used only up to the need: 10 sensors for 3 needed use 3 and leave none to build, and the build points are those of the units to build only', byId[102].used === 3 && byId[102].units === 0 && byId[102].bp === 0 && byId[108].used === 1.5 && stocked.bp === 2 * 50 && stocked.stockBP === 4 * 50 + 3 * 100 + 1.5 * 40 + 1 * 10)
  holds('wholeUnits', 'SYNTHETIC a project builds whole components: 0.5 a hull for 3 hulls needs 1.5, with 1 in stock leaves 0.5, which is 1 to build with 0.5 spare', (() => {
    const half = calc.requirements({ parts: [HALF], hulls: 3, stock: { 108: 1 } }).rows[0]

    return half.needed === 1.5 && half.remaining === 0.5 && half.units === 1 && Math.abs(half.surplus - 0.5) < TOLERANCE
  })())
  holds('wholeUnits', 'SYNTHETIC 0.5 a hull for 3 hulls with none in stock is 2 to build (rounded up), at 40 BP each', (() => {
    const half = calc.requirements({ parts: [HALF], hulls: 3, stock: {} }).rows[0]

    return half.units === 2 && half.bp === 80
  })())
  holds('unknownStock', 'SYNTHETIC a component with no stock row is none held, and a stock cell typed over the save\'s figure is used; a negative or empty cell is refused and the save\'s figure stays', (() => {
    const edited = calc.stockWith({ 101: 4 }, { 101: '2', 102: '5', 108: '-1', 103: '' })

    return edited.stock[101] === 2 && edited.stock[102] === 5 && edited.stock[108] === undefined && edited.invalid.length === 2 && edited.invalid.includes(108) && edited.invalid.includes(103) && calc.requirements({ parts: [SENSOR], hulls: 1, stock: {} }).rows[0].held === 0
  })())

  const kinds = Object.fromEntries([
    ['armour', part(1, 'Armour', 11, 1, 5, {})],
    ['missile engine', part(2, 'Missile engine', 56, 1, 5, {})],
    ['prototype', part(3, 'Prototype', 1, 1, 5, {}, { prototype: 1 })],
    ['civilian line', part(4, 'Line gear', 1, 1, 5, {}, { shippingLine: 1 })],
    ['unresearched', part(5, 'Unresearched', 1, 1, 5, {}, { researched: 0 })],
    ['obsolete', part(6, 'Obsolete', 1, 1, 5, {}, { obsolete: 1 })],
    ['ordinary', part(7, 'Ordinary', 1, 1, 5, {})],
    ['spied empire', part(8, 'Spied', 1, 1, 5, {}, { researched: null })],
  ].map(([name, entry]) => [name, calc.buildableOf(entry)]))

  holds('buildable', 'SYNTHETIC armour, a missile engine, a prototype, a civilian line\'s component, a component not researched and one set obsolete are not built by a component project; an ordinary one is; a spied empire\'s research is not known', kinds.armour.buildable === false && kinds['missile engine'].buildable === false && kinds.prototype.buildable === false && kinds['civilian line'].buildable === false && kinds.unresearched.buildable === false && kinds.obsolete.buildable === false && kinds.ordinary.buildable === true && kinds['spied empire'].buildable === null && kinds['spied empire'].missing.length === 1)
  holds('armourKept', 'SYNTHETIC the armour of the class is not in the units to build or the share, and is reported as built with the hull (its build points kept apart)', (() => {
    const needs = calc.requirements({ parts: CLASS_PARTS, hulls: 2, stock: {} })
    const armour = needs.rows.find((row) => row.componentId === 103)

    return armour.units === 0 && armour.buildable === false && /hull/.test(armour.why) && needs.yardBP === 8 * 10 && needs.bp === 2 * 2 * 50 + 2 * 100 + Math.ceil(1) * 40
  })())

  const held = calc.heldShare([
    projectRow({ ID: 1, ProductionType: 0, Percentage: 20, Paused: 1 }),
    projectRow({ ID: 2, ProductionType: 3, Percentage: 10 }),
    projectRow({ ID: 3, ProductionType: 4, Percentage: 5 }),
    projectRow({ ID: 4, ProductionType: 0, Percentage: 50, Queue: 1 }),
    projectRow({ ID: 5, ProductionType: 1, Percentage: 30 }),
  ])

  holds('heldPaused', 'SYNTHETIC a paused project out of the queue holds its share: 20% paused construction, 10% component and 5% station projects hold 35%', Math.abs(held.held - 35) < TOLERANCE && held.missing.length === 0)
  holds('heldCategory', 'SYNTHETIC a component project and a station project draw on the construction capacity (held with construction), a queued project and an ordnance project do not: the 50% queued and the 30% ordnance share are not held', Math.abs(held.held - 35) < TOLERANCE)
  holds('heldQueue', 'SYNTHETIC a queued project (Queue above 0) holds no share: only the 50% queued project alone holds 0%', calc.heldShare([projectRow({ ID: 1, Percentage: 50, Queue: 2 })]).held === 0)
  holds('heldUnknown', 'SYNTHETIC a project whose share is not in the save leaves the held share unknown, never 0', (() => {
    const unknown = calc.heldShare([projectRow({ ID: 1, Percentage: null })])

    return unknown.missing.length === 1
  })())

  const split = calc.allocateShare(100, [3, 1])
  const tiny = calc.allocateShare(100, [1, 1, 1000])
  const awkward = calc.allocateShare(1000, [1, 1, 1])

  holds('allocate', 'SYNTHETIC hundredths of a percent split by build points add up to the total exactly and give every project at least one hundredth: 100 over 3:1 is 75 and 25, 100 over 1:1:1000 sums to 100 with each at least 1, 1000 over thirds sums to 1000, and fewer hundredths than projects gives none', split[0] === 75 && split[1] === 25 && tiny.reduce((a, b) => a + b, 0) === 100 && tiny.every((value) => value >= 1) && awkward.reduce((a, b) => a + b, 0) === 1000 && calc.allocateShare(2, [1, 1, 1]) === null)

  const plan = calc.planComponents(input())
  const bp = 4 * 2 * 50 + 4 * 100 + 2 * 40
  const hundredths = plan.allocation.map((entry) => Math.round(entry.share * 100))
  const allocated = plan.allocation.reduce((all, entry) => all + entry.share, 0)

  holds('feasible', 'SYNTHETIC 4 hulls needing 880 BP of components in 30 days at the capacity of 36,500 BP a year is feasible, needing no less than the floor (about 29.3%) and no more than the share free', plan.status === 'feasible' && plan.requirements.bp === bp && plan.required >= plan.floorShare - TOLERANCE && plan.required <= plan.available && plan.requiredExact === true && plan.shortfall === null && plan.unreachable === false)
  holds('floorShare', 'SYNTHETIC the floor is the share no schedule can go under, from the capacity of the colony in question: 880 BP over 30 days of 36,500 BP a year is 29.33% by plain division, and the floor is within a hundredth of a percent a project under it (the rounding of a build to 4 decimals and the grid of hundredths)', plan.floorShare <= closed(bp) + 3 * 0.01 + 1e-9 && plan.floorShare >= closed(bp) * 0.99)
  holds('allocationSums', 'SYNTHETIC the projects of the batch hold shares that add up to the share needed, each a whole hundredth of a percent of at least 0.01, one for each component to build, split by build points (the 400 BP engines hold more than the 80 BP gear)', plan.allocation.length === 3 && Math.abs(allocated - plan.required) < 1e-6 && plan.allocation.every((entry) => entry.share >= 0.01 && Math.abs(entry.share * 100 - Math.round(entry.share * 100)) < 1e-6) && plan.allocation.find((entry) => entry.componentId === 101).share > plan.allocation.find((entry) => entry.componentId === 108).share)

  const latest = engineLatest(plan, CLASS_PARTS, HULLS, hundredths)
  const lessTotal = hundredths.reduce((a, b) => a + b, 0) - 1
  const lessParts = calc.allocateShare(lessTotal, plan.allocation.map((entry) => entry.bp))
  const lessLatest = lessParts ? engineLatest(plan, CLASS_PARTS, HULLS, lessParts) : null

  holds('engineMeets', 'SYNTHETIC the engine\'s own run of the batch at the shares found finishes every project by the deadline', latest !== null && latest <= DEADLINE + TOLERANCE)
  holds('minimal', 'SYNTHETIC the share found is the least: one hundredth of a percent less, split the same way, does not finish every project by the deadline in the engine\'s own run', lessLatest === null || lessLatest > DEADLINE + TOLERANCE)

  const ownDuranium = (stock) => projectRow({ ID: 1, Name: 'Own', ProductionType: 0, Percentage: 50, Amount: 10, ProdPerUnit: 1000, Duranium: 100, StockDuranium: stock })
  const contended = calc.planComponents(input({ colony: colony({ projects: [ownDuranium(800)], minerals: { ...stockOfMinerals(1e6), Duranium: 800 } }) }))
  const contendedHundredths = contended.allocation.map((entry) => Math.round(entry.share * 100))
  const contendedLatest = engineLatest(contended, CLASS_PARTS, HULLS, contendedHundredths, [ownDuranium(800)], 800)
  const contendedLess = calc.allocateShare(contendedHundredths.reduce((a, b) => a + b, 0) - 1, contended.allocation.map((entry) => entry.bp))
  const contendedLessLatest = contendedLess ? engineLatest(contended, CLASS_PARTS, HULLS, contendedLess, [ownDuranium(800)], 800) : null

  holds('contended', 'SYNTHETIC a batch that shares 800 t of Duranium with a colony project that takes it too needs more share than the plain division and than the same batch alone (the project may be visited first, so the batch must be done before the stock runs short): feasible, the share is marked as found by search (the minerals are contested, so a smaller share may do it and the share is not called exact), and the engine\'s own run at that share finishes every project by the deadline in the worst order', contended.status === 'feasible' && contended.required > plan.required + 1 && contended.contested === true && contended.requiredKind === 'found' && contended.requiredExact === false && contendedLatest !== null && contendedLatest <= DEADLINE + TOLERANCE)
  holds('contendedLeast', 'SYNTHETIC with the stock contended the share found is still the least: one hundredth less misses the deadline in the engine\'s own run of the colony\'s projects with the batch', contendedLess === null || contendedLessLatest === null || contendedLessLatest > DEADLINE + TOLERANCE)

  const hullsMore = calc.planComponents(input({ hulls: 8 }))
  const deadlineMore = calc.planComponents(input({ deadline: 60 }))
  const stockSome = calc.planComponents(input({ stock: { 101: 8 } }))
  const stockAll = calc.planComponents(input({ stock: { 101: 8, 102: 4, 108: 2 } }))

  holds('localHulls', 'SYNTHETIC editing the hull count recalculates from the same input: 8 hulls need twice the build points and a larger share than 4', hullsMore.requirements.bp === 2 * bp && hullsMore.required > plan.required)
  holds('localDeadline', 'SYNTHETIC editing the deadline recalculates from the same input: 60 days needs less than the share of 30, and the floor of 60 days is half that of 30 to a hundredth', deadlineMore.required < plan.required && Math.abs(deadlineMore.floorShare * 2 - plan.floorShare) < 0.05)
  holds('localStock', 'SYNTHETIC editing the stock recalculates from the same input: 8 engines in stock take 400 BP out of the batch once and lower the share; stock for everything leaves nothing to build, status covered, share 0 and no project', stockSome.requirements.bp === bp - 400 && stockSome.required < plan.required && stockAll.status === 'covered' && stockAll.required === 0 && stockAll.allocation.length === 0)

  const infeasible = calc.planComponents(input({ hulls: 4000 }))
  const infeasibleBP = 4000 * (2 * 50 + 100 + 0.5 * 40)
  const infeasibleSum = infeasible.allocation.reduce((all, entry) => all + entry.share, 0)

  holds('infeasible', 'SYNTHETIC a deadline the capacity cannot meet is infeasible and reports the share needed (at least the floor, which is the plain division to a hundredth when the builds are large, not exact, kind floor) against the share free (100%) and the shortfall in percentage points and in build points a year, and never allocates more than the share free', infeasible.status === 'infeasible' && infeasible.requiredExact === false && infeasible.requiredKind === 'floor' && Math.abs(infeasible.required - closed(infeasibleBP)) < 0.05 && infeasible.available === 100 && Math.abs(infeasible.shortfall.share - (infeasible.required - 100)) < 1e-6 && Math.abs(infeasible.shortfall.bpPerYear - (infeasible.required - 100) / 100 * capacity) < 1e-3 && infeasibleSum <= infeasible.available + 1e-9)

  const busy = [
    projectRow({ ID: 1, Name: 'Own paused', ProductionType: 0, Percentage: 20, Paused: 1, Amount: 100, ProdPerUnit: 10 }),
    projectRow({ ID: 2, Name: 'Own station', ProductionType: 4, Percentage: 15, Amount: 100, ProdPerUnit: 10 }),
    projectRow({ ID: 3, Name: 'Own queued', ProductionType: 0, Percentage: 60, Queue: 1, Amount: 100, ProdPerUnit: 10 }),
  ]
  const crowded = calc.planComponents(input({ colony: colony({ projects: busy }) }))
  const crowdedSum = crowded.allocation.reduce((all, entry) => all + entry.share, 0)
  const tooMuch = calc.planComponents(input({ hulls: 4000, colony: colony({ projects: busy }) }))

  holds('commitments', 'SYNTHETIC the colony\'s own projects out of the queue hold 35% (a paused 20% and a station 15%, the queued 60% none), so 65% is free and the batch is allocated within it', crowded.held === 35 && crowded.available === 65 && crowdedSum <= 65 + 1e-6)
  holds('commitmentsInfeasible', 'SYNTHETIC an infeasible batch at a colony whose own projects hold 35% reports the free share as 65% and allocates no more than 65%', tooMuch.status === 'infeasible' && tooMuch.available === 65 && tooMuch.allocation.reduce((all, entry) => all + entry.share, 0) <= 65 + 1e-6 && Math.abs(tooMuch.shortfall.share - (tooMuch.required - 65)) < 1e-6)

  const plenty = calc.planComponents(input({ colony: colony({ projects: [projectRow({ ID: 1, Name: 'Own', ProductionType: 0, Percentage: 50, Amount: 10, ProdPerUnit: 1000, Duranium: 100, StockDuranium: 1500 })], minerals: { ...stockOfMinerals(1e6), Duranium: 1500 } }) }))

  holds('displaced', 'SYNTHETIC a batch that takes stock of Duranium the colony\'s own project needs moves that project\'s finish, and the move is named with the day before and after', plenty.displaced.length === 1 && plenty.displaced[0].name === 'Own' && plenty.displaced[0].after !== plenty.displaced[0].before)
  holds('displacedNone', 'SYNTHETIC a batch that leaves the colony\'s own projects where they were moves none', calc.planComponents(input({ colony: colony({ projects: [projectRow({ ID: 1, Name: 'Own', ProductionType: 0, Percentage: 10, Amount: 1, ProdPerUnit: 10, Duranium: 1, StockDuranium: 1e6 })] }) })).displaced.length === 0)

  const noCorbomite = calc.planComponents(input({ colony: colony({ minerals: { ...stockOfMinerals(1e6), Corbomite: 0 } }) }))
  const noCorbomiteStock = calc.planComponents(input({ colony: colony({ minerals: { ...stockOfMinerals(1e6), Corbomite: 0 } }), stock: { 101: 8 } }))

  holds('stallDistinct', 'SYNTHETIC a colony with no Corbomite (the engines\' mineral) cannot finish the batch at any share: it is infeasible, names Corbomite and the engine as the holdup, needs no share (null, not a shortfall of 0) and the components to build are the same as with the mineral in stock', noCorbomite.status === 'infeasible' && noCorbomite.stalled && noCorbomite.stalled.name === 'Corbomite' && /Engine/.test(noCorbomite.stalled.componentName) && noCorbomite.shortfall === null && noCorbomite.requirements.units === plan.requirements.units && noCorbomite.requirements.bp === plan.requirements.bp)
  holds('stallClear', 'SYNTHETIC with the engines covered by stock the batch needs no Corbomite and is feasible at a colony with none, and a feasible plan names no stalled mineral', noCorbomiteStock.status === 'feasible' && noCorbomiteStock.stalled === null && plan.stalled === null)

  holds('capacityUnknown', 'SYNTHETIC a colony whose construction capacity is not known gives status unknown naming what is missing, never a share', (() => {
    const unavailable = { status: 'unavailable', value: null, inputs: { present: [], missing: ['the colony\'s construction rate'] } }
    const unknown = calc.planComponents(input({ colony: colony({ capacities: { ...capacities, construction: unavailable } }) }))

    return unknown.status === 'unknown' && unknown.required === null && unknown.gaps.includes('the colony\'s construction rate')
  })())
  holds('partUnknown', 'SYNTHETIC a component whose cost is not in the save gives status unknown naming it, never a share', (() => {
    const unknown = calc.planComponents(input({ parts: [part(101, 'Engine', 1, 2, null, {})] }))

    return unknown.status === 'unknown' && unknown.required === null && unknown.gaps.some((gap) => /cost of Engine/.test(gap))
  })())
  holds('hullsInvalid', 'SYNTHETIC no hulls (0 or not a number) is not a calculation: unknown, naming the hulls', calc.planComponents(input({ hulls: 0 })).status === 'unknown' && calc.planComponents(input({ hulls: NaN })).status === 'unknown')

  // The review's counterexamples (AE048-01 R1 to R5), each on a colony of its own.
  const capacityOf = (value) => ({ ...capacities.construction, value })
  const paused = (percentage) => projectRow({ ID: 1, Name: 'Own paused', ProductionType: 0, Percentage: percentage, Paused: 1, Amount: 100, ProdPerUnit: 10 })
  const withCapacity = (value, projects, extra = {}) => colony({ capacities: { ...capacities, construction: capacityOf(value) }, projects, ...extra })

  const slowPart = part(1, 'Slow component', 1, 1, 1000, { Duranium: 1000 })
  const slowHeld = calc.planComponents({ parts: [slowPart], hulls: 1, stock: {}, deadline: 5000, colony: withCapacity(365, [paused(84)]) })
  const slowFree = calc.planComponents({ parts: [slowPart], hulls: 1, stock: {}, deadline: 5000, colony: withCapacity(365, []) })
  const slowLatest = (hundredths) => engineLatest(null, [slowPart], 1, [hundredths], [], 1e6, { ...capacities, construction: capacityOf(365) })
  const slowHundredths = Math.round(slowFree.required * 100)

  holds('roundingFloor', 'SYNTHETIC a 1,000 BP component at 365 BP a year with 1-day cycles and a 5,000-day deadline needs about 15%, not the 20% of the plain division, because the game rounds each cycle\'s build up to 4 decimals: with 84% held by a paused project it is feasible within the 16% free, with nothing held it reports the same least share, the engine meets the deadline at that share and not at one hundredth less, and the floor is under the share', slowHeld.status === 'feasible' && slowHeld.required >= 14.9 && slowHeld.required < 15.1 && slowFree.status === 'feasible' && slowFree.requiredExact === true && Math.abs(slowFree.required - slowHeld.required) < 1e-9 && slowFree.floorShare <= slowFree.required + TOLERANCE && slowFree.floorShare < 20 - 1 && slowLatest(slowHundredths) <= 5000 + TOLERANCE && (slowLatest(slowHundredths - 1) === null || slowLatest(slowHundredths - 1) > 5000 + TOLERANCE))

  const tinyParts = [1, 2, 3, 4].map((id) => part(id, `Tiny ${id}`, 1, 1, 10, { Duranium: 10 }))
  const gridPlan = calc.planComponents({ parts: tinyParts, hulls: 1, stock: {}, deadline: 365, colony: withCapacity(365000, [paused(99.98)]) })

  holds('gridMinimum', 'SYNTHETIC four 10 BP components at 365,000 BP a year in 365 days with 99.98% held: the 0.02% free is under the 0.04% that four projects of at least 0.01% hold, so the batch is infeasible with the grid minimum 0.04% as the share needed, against 0.02% free, a positive shortfall of 0.02 points (73 BP a year) and no allocation within the free share', gridPlan.status === 'infeasible' && gridPlan.requiredExact === true && Math.abs(gridPlan.required - 0.04) < 1e-9 && Math.abs(gridPlan.available - 0.02) < 1e-6 && gridPlan.shortfall !== null && gridPlan.shortfall.share > 0 && Math.abs(gridPlan.shortfall.share - (gridPlan.required - gridPlan.available)) < 1e-9 && Math.abs(gridPlan.shortfall.bpPerYear - gridPlan.shortfall.share / 100 * 365000) < 1e-6 && gridPlan.allocation.length === 0)

  const fiftyPart = part(1, 'Fifty BP component', 1, 1, 50, { Duranium: 50 })
  const cycleInput = (projects) => ({ parts: [fiftyPart], hulls: 1, stock: {}, deadline: 1.5, colony: colony({ projects }) })
  const cycleShort = calc.planComponents(cycleInput([paused(60)]))
  const cycleFreed = calc.planComponents(cycleInput([paused(50)]))

  holds('cycleRequired', 'SYNTHETIC a 50 BP component at 36,500 BP a year with 1-day cycles and a 1.5-day deadline needs 50% (a build of 49.99% takes a second cycle): with 60% held and 40% free it is infeasible with 50% as the share needed (exact), 10 points short (3,650 BP a year) and, at the 40% free, a finish on day 2; with 50% held it is feasible at 50% of 50% free', cycleShort.status === 'infeasible' && cycleShort.required === 50 && cycleShort.requiredExact === true && cycleShort.unreachable === false && cycleShort.available === 40 && cycleShort.shortfall !== null && Math.abs(cycleShort.shortfall.share - 10) < 1e-9 && Math.abs(cycleShort.shortfall.bpPerYear - 3650) < 1e-6 && cycleShort.finish.latest === 2 && cycleFreed.status === 'feasible' && cycleFreed.required === 50 && cycleFreed.available === 50)

  const beforeCycle = calc.planComponents({ ...cycleInput([]), deadline: 0.5 })

  holds('unreachable', 'SYNTHETIC a share the colony could never give is not a shortfall of 0: a deadline before the first production cycle ends and a colony with no Corbomite are infeasible and unreachable with no share needed and no shortfall (null), not a numeric zero', beforeCycle.status === 'infeasible' && beforeCycle.unreachable === true && beforeCycle.required === null && beforeCycle.shortfall === null && noCorbomite.unreachable === true && noCorbomite.required === null && noCorbomite.shortfall === null && cycleShort.unreachable === false)

  const contested = [101, 102, 103, 104, 105, 106].map((id) => part(id, `Contested ${id}`, 2, 1, 10, { Duranium: 10 }))
  const orderPlan = calc.planComponents({ parts: contested, hulls: 1, stock: {}, deadline: 2, colony: colony({ arrivals: [{ resource: 'Duranium', day: 2, quantity: 50, source: 'arrival' }], minerals: { ...stockOfMinerals(1e6), Duranium: 10 } }) })

  holds('orderBound', 'SYNTHETIC six 10 BP components that need 10 t of Duranium each with 10 t held and 50 t arriving on day 2 finish the batch on day 2 in every order, though each could finish on day 1 first in line: the plan is feasible, its latest is day 2, its earliest (day 1) is only a bound and is not flagged exact, and the orders are flagged as a sample; a batch no order changes has an exact earliest that is its latest', orderPlan.status === 'feasible' && orderPlan.finish.latest === 2 && orderPlan.finish.earliestExact === false && orderPlan.finish.earliest <= orderPlan.finish.latest && orderPlan.finish.sampled === true && plan.finish.earliestExact === true && plan.finish.earliest === plan.finish.latest && plan.finish.sampled === false)

  const nullStock = calc.sourcesOf({ classes: [], parts: [], stock: [{ PopulationID: 7, ComponentID: 101, Amount: null }, { PopulationID: 7, ComponentID: 102, Amount: 5 }], populations: [] })
  const nullPlan = calc.planComponents(input({ stock: nullStock.stock[7] }))
  const supplied = calc.stockWith(nullStock.stock[7], { 101: '0' })
  const suppliedPlan = calc.planComponents(input({ stock: supplied.stock }))

  holds('stockNull', 'SYNTHETIC a stock row whose amount is not in the save is not a stock of 0: it stays unknown through the read, the plan is unknown naming the stock of the engine, with no share, a cell typed over it supplies the figure and gives a plan, and a component with no row is none held', nullStock.stock[7][101] === null && nullStock.stock[7][102] === 5 && nullPlan.status === 'unknown' && nullPlan.required === null && nullPlan.gaps.some((gap) => /stock of Engine/.test(gap)) && calc.requirements({ parts: CLASS_PARTS, hulls: 1, stock: {} }).unknown === null && supplied.invalid.length === 0 && suppliedPlan.status === 'feasible')

  const stopped = { expired: () => true }
  const steps = calc.planSteps(input(), stopped)
  let yields = 0
  let step = steps.next()

  while (!step.done) {
    yields++
    step = steps.next()
  }

  holds('sliced', 'SYNTHETIC the calculation yields to a pace that has expired (so the page can run it in slices) and ends at the same plan as the run to the end', yields > 0 && JSON.stringify(step.value) === JSON.stringify(plan))

  const unitsFloor = calc.requirements({ parts: BUILT, hulls: HULLS, stock: {} })

  holds('classTotals', 'SYNTHETIC the units and build points of the class add up: 8 engines, 4 sensors and 2 gear are 14 units and 880 BP', unitsFloor.units === 14 && unitsFloor.bp === bp && unitsFloor.unknown === null)

  // The second review's counterexamples (AE048-01 R6 to R8).
  const lumpyParts = [part(101, 'Part 0', 2, 1, 19, { Corbomite: 19 }), part(102, 'Part 1', 2, 1, 6, { Duranium: 1, Corbomite: 5 }), part(103, 'Part 2', 2, 1, 81, { Corbomite: 81 }), part(104, 'Part 3', 2, 1, 64, { Corbomite: 64 })]
  const lumpyModifiers = { ...MODIFIERS, ConstructionProduction: 7300000, OrdnanceProduction: 365, OrdnanceProductionPower: 1 }
  const lumpyCapacities = { ...capacities, construction: capacityOf(7300000), ordnance: { ...capacities.ordnance, value: 365 } }
  const lumpyOwn = (freeHundredths) => [projectRow({ ID: 1, Name: 'Paused construction', Percentage: (10000 - freeHundredths) / 100, Paused: 1, Amount: 4, ProdPerUnit: 2, StockDuranium: 3 }), projectRow({ ID: 2, Name: 'Ordnance consuming Duranium', ProductionType: 1, Percentage: 100, Amount: 1000, ProdPerUnit: 1, Duranium: 1, StockDuranium: 3 })]
  const lumpyPlan = (freeHundredths) => calc.planComponents({ parts: lumpyParts, hulls: 1, stock: {}, deadline: 10, colony: colony({ capacities: lumpyCapacities, modifiers: lumpyModifiers, projects: lumpyOwn(freeHundredths), minerals: { ...stockOfMinerals(1e6), Duranium: 3 } }) })
  const lumpyWeights = calc.requirements({ parts: lumpyParts, hulls: 1, stock: {} }).rows.map((row) => row.bp)
  const lumpyMeets = (freeHundredths, hundredths) => {
    const latest = engineLatest(null, lumpyParts, 1, calc.allocateShare(hundredths, lumpyWeights), lumpyOwn(freeHundredths), 3, lumpyCapacities, lumpyModifiers)

    return latest !== null && latest <= 10 + TOLERANCE
  }
  const lumpyProblems = []

  for (let freeHundredths = 15; freeHundredths <= 21; freeHundredths++) {
    const lumpy = lumpyPlan(freeHundredths)
    const meeting = Array.from({ length: freeHundredths - 3 }, (_, index) => index + 4).filter((hundredths) => lumpyMeets(freeHundredths, hundredths))
    const anyMeets = meeting.length > 0

    if (lumpy.contested !== true || (lumpy.requiredKind === 'exact') !== lumpy.requiredExact || (lumpy.status === 'feasible') !== anyMeets || (lumpy.status === 'feasible' && (!lumpyMeets(freeHundredths, Math.round(lumpy.required * 100)) || (lumpy.requiredExact && Math.round(lumpy.required * 100) !== meeting[0])))) {
      lumpyProblems.push(`${freeHundredths / 100}% free: ${lumpy.status} ${lumpy.requiredKind} contested ${lumpy.contested}, some share meets ${anyMeets}`)
    }
  }

  holds('nonMonotone', 'SYNTHETIC with a paused project and an ordnance project that takes the colony\'s 3 t of Duranium, a batch whose engine run meets the deadline at some shares and misses it at larger ones (the reviewer\'s four components, 0.15% to 0.21% free) is called contested, is not called infeasible where a share the colony can give meets the deadline, and where it is feasible the share found meets it in the engine\'s own run and, if it is called exact, is the least share that does', lumpyProblems.length === 0 && lumpyPlan(16).contested === true)

  const roll = ((seed) => () => {
    seed = (seed * 16807) % 2147483647

    return seed / 2147483647
  })(7)
  const apportioned = (() => {
    for (let trial = 0; trial < 200; trial++) {
      const count = 1 + Math.floor(roll() * 6)
      const weights = Array.from({ length: count }, () => (roll() < 0.1 ? 0 : Math.round(roll() * 1000) / 7))
      let previous = null

      for (let total = count; total <= count + 60; total++) {
        const split = calc.allocateShare(total, weights)

        if (!split || split.reduce((a, b) => a + b, 0) !== total || split.some((value) => value < 1) || (previous && split.some((value, index) => value < previous[index]))) {
          return false
        }

        previous = split
      }

      if (calc.allocateShare(count - 1, weights) !== null) {
        return false
      }
    }

    return true
  })()

  holds('apportion', 'SYNTHETIC on 200 random sets of 1 to 6 weights (some of them 0), the split of every total from one hundredth a project to 60 more adds up to the total, gives every project at least one hundredth and never gives a project fewer hundredths than the split of the total one less did (the split of a total is inside that of every larger one)', apportioned)

  const overOwn = projectRow({ ID: 1, Name: 'Existing construction', Percentage: 100, Amount: 1, ProdPerUnit: 100, Duranium: 100, StockDuranium: 100 })
  const overPart = part(101, 'Component', 1, 1, 50, { Duranium: 50 })
  const overPlan = calc.planComponents({ parts: [overPart], hulls: 1, stock: {}, deadline: 1, colony: colony({ projects: [overOwn], minerals: { ...stockOfMinerals(1e6), Duranium: 100 } }) })
  const overLatest = overPlan.release.length ? engineLatest(null, [overPart], 1, [Math.round(overPlan.required * 100)], [{ ...overOwn, Percentage: overPlan.release[0].to }], 100) : null

  holds('releaseLegal', 'SYNTHETIC a 50 BP component due in a day at a colony whose one project holds the whole capacity and 100 t of Duranium: the share needed is the 50% the project would release (the release is named: that project, from 100% to 50%), found by the search and not out of reach, the shortfall is those 50 points, and the engine\'s own run with the share released finishes the batch within the day', overPlan.status === 'infeasible' && overPlan.available === 0 && overPlan.unreachable === false && overPlan.required === 50 && overPlan.requiredKind === 'found' && overPlan.requiredExact === false && overPlan.release.length === 1 && overPlan.release[0].id === 1 && overPlan.release[0].from === 100 && overPlan.release[0].to === 50 && overPlan.shortfall !== null && Math.abs(overPlan.shortfall.share - 50) < 1e-9 && overLatest !== null && overLatest <= 1 + TOLERANCE)

  const queueOwn = [
    projectRow({ ID: 1, Name: 'Paused commitment', Percentage: 90, Paused: 1, Amount: 4, ProdPerUnit: 2, StockDuranium: 40 }),
    projectRow({ ID: 2, Name: 'Small active project', Percentage: 10, Amount: 1, ProdPerUnit: 10, StockDuranium: 40 }),
    projectRow({ ID: 3, Name: 'Queued Duranium consumer', Percentage: 10, Amount: 100, ProdPerUnit: 10, Queue: 1, Duranium: 10, StockDuranium: 40 }),
  ]
  const queuePart = part(101, 'Component', 1, 1, 40, { Duranium: 40 })
  const queuePlan = calc.planComponents({ parts: [queuePart], hulls: 1, stock: {}, deadline: 2, colony: colony({ projects: queueOwn, minerals: { ...stockOfMinerals(1e6), Duranium: 40 } }) })
  const queueReleased = Object.fromEntries(queuePlan.release.map((entry) => [entry.id, entry.to]))
  const queueLatest = queuePlan.required === null ? null : engineLatest(null, [queuePart], 1, [Math.round(queuePlan.required * 100)], queueOwn.map((project) => (project.ID in queueReleased ? { ...project, Percentage: queueReleased[project.ID] } : project)), 40)

  holds('releaseQueue', 'SYNTHETIC with 90% held by a paused project, 10% by an active one and a queued project that would take Duranium, a 40 BP component due in 2 days needs 20%: the release is taken from the paused project first (90% to 70%), nothing is taken from the queued project, the shares released add up to the share needed, and the engine\'s own run with that release finishes the batch within the 2 days', queuePlan.status === 'infeasible' && queuePlan.required !== null && queuePlan.release.length > 0 && queuePlan.release[0].id === 1 && queuePlan.release[0].paused === true && !queuePlan.release.some((entry) => entry.id === 3) && Math.abs(queuePlan.release.reduce((all, entry) => all + entry.from - entry.to, 0) - (queuePlan.required - queuePlan.available)) < 1e-6 && queueLatest !== null && queueLatest <= 2 + TOLERANCE)

  const unknownNeeds = calc.requirements({ parts: CLASS_PARTS, hulls: 1, stock: { 101: null, 102: 4 } })
  const unknownRows = Object.fromEntries(unknownNeeds.rows.map((row) => [row.componentId, row]))

  holds('unknownUnits', 'SYNTHETIC a component whose stock row has no amount has no known units, surplus or build points to build (null, not 0), a component whose known stock covers the need keeps 0, the armour built with the hull keeps 0, and the totals count the known rows only', unknownRows[101].units === null && unknownRows[101].surplus === null && unknownRows[101].bp === null && unknownRows[102].units === 0 && unknownRows[102].surplus === 0 && unknownRows[102].bp === 0 && unknownRows[103].units === 0 && unknownNeeds.units === 1 && unknownNeeds.bp === 40 && unknownNeeds.unknown !== null)

  const shares = [
    projectRow({ ID: 4, Name: 'Paused A', Percentage: 30, Paused: 1 }),
    projectRow({ ID: 7, Name: 'Active B', Percentage: 40 }),
    projectRow({ ID: 9, Name: 'Active C', Percentage: 20 }),
    projectRow({ ID: 10, Name: 'Queued', Percentage: 50, Queue: 1 }),
    projectRow({ ID: 11, Name: 'Ordnance', ProductionType: 1, Percentage: 80 }),
    projectRow({ ID: 2, Name: 'Paused D', Percentage: 10, Paused: 1 }),
  ]
  const released = calc.redistribution(shares, 4500)
  const untouched = calc.redistribution(shares, 0)

  holds('redistribute', 'SYNTHETIC releasing 45% of the capacity from projects holding 30% (paused, ID 4), 40% (ID 7), 20% (ID 9) and 10% (paused, ID 2), with a queued project and an ordnance project besides, takes the paused projects first, the newest of them first (ID 4, then ID 2, each to 0%), then the others newest first (ID 9, 20% to 15%), never touches the queued or ordnance project, leaves 55% held and a release of nothing changes nothing', released.released.map((entry) => entry.id).join() === '4,2,9' && released.released.map((entry) => entry.to).join() === '0,0,15' && released.released.map((entry) => entry.paused).join() === 'true,true,false' && Math.abs(calc.heldShare(released.projects).held - 55) < 1e-9 && released.projects.find((project) => project.ID === 10).Percentage === 50 && released.projects.find((project) => project.ID === 11).Percentage === 80 && untouched.released.length === 0 && untouched.projects === shares)

  // The third review's counterexamples (AE048-01 R9 and R10).
  const roundCapacities = { ...capacities, construction: capacityOf(2190000) }
  const roundModifiers = { ...MODIFIERS, ConstructionProduction: 2190000 }
  const roundParts = [part(101, 'Part 0', 1, 1, 1, { Corbomite: 1 }), part(102, 'Part 1', 1, 1, 2, { Duranium: 1, Corbomite: 1 })]
  const roundOwn = [projectRow({ ID: 1, Name: 'Paused construction', Percentage: 99.96, Paused: 1, Amount: 4, ProdPerUnit: 2, StockDuranium: 1.015 }), projectRow({ ID: 2, Name: 'Fine remaining queued project', ProductionType: 0, Percentage: 0.01, Amount: 0.00015, ProdPerUnit: 100, Queue: 1, Duranium: 100, StockDuranium: 1.015 })]
  const roundPlan = calc.planComponents({ parts: roundParts, hulls: 1, stock: {}, deadline: 2, colony: colony({ capacities: roundCapacities, modifiers: roundModifiers, projects: roundOwn, minerals: { ...stockOfMinerals(1e6), Duranium: 1.015 } }) })
  const roundWeights = calc.requirements({ parts: roundParts, hulls: 1, stock: {} }).rows.map((row) => row.bp)
  const roundMeets = (hundredths) => {
    const latest = engineLatest(null, roundParts, 1, calc.allocateShare(hundredths, roundWeights), roundOwn, 1.015, roundCapacities, roundModifiers)

    return latest !== null && latest <= 2 + TOLERANCE
  }
  const roundLeast = [2, 3, 4].find(roundMeets)

  holds('roundedDemand', 'SYNTHETIC a queued project with 0.00015 of a unit left at 100 t of Duranium a unit takes 0.02 t in the engine (its build rounds up to 0.0002), not the 0.015 t of the plain product, so with 1.015 t in stock the minerals are contested: the batch is called contested, the plan is feasible at a share the engine\'s own run meets the deadline with (0.04% free, 0.06% is not the least), and a share called exact is the least one', roundLeast !== undefined && roundPlan.contested === true && roundPlan.status === 'feasible' && roundMeets(Math.round(roundPlan.required * 100)) && roundPlan.required <= roundLeast / 100 + TOLERANCE && (roundPlan.requiredKind !== 'exact' || Math.round(roundPlan.required * 100) === roundLeast))

  const islandCapacities = { ...capacities, construction: capacityOf(1468390.8045977012) }
  const islandModifiers = { ...MODIFIERS, ConstructionProduction: 1468390.8045977012 }
  const islandParts = [part(101, 'Part 0', 1, 1, 80, { Corbomite: 80 }), part(102, 'Part 1', 1, 1, 3, { Corbomite: 3 }), part(103, 'Part 2', 1, 1, 94, { Duranium: 1, Corbomite: 93 }), part(104, 'Part 3', 1, 1, 33, { Corbomite: 33 })]
  const islandOwn = [projectRow({ ID: 1, Name: 'Paused commitment', Percentage: 97.67, Paused: 1, Amount: 4, ProdPerUnit: 2, StockDuranium: 1 }), projectRow({ ID: 2, Name: 'Queued Duranium consumer', ProductionType: 3, Percentage: 0.01, Amount: 1000, ProdPerUnit: 1, Queue: 1, Duranium: 1, StockDuranium: 1 })]
  const islandInput = { parts: islandParts, hulls: 1, stock: {}, deadline: 9, colony: colony({ capacities: islandCapacities, modifiers: islandModifiers, projects: islandOwn, minerals: { ...stockOfMinerals(1e6), Duranium: 1 } }) }
  const islandWeights = calc.requirements({ parts: islandParts, hulls: 1, stock: {} }).rows.map((row) => row.bp)
  const islandMeets = (hundredths) => {
    const latest = engineLatest(null, islandParts, 1, calc.allocateShare(hundredths, islandWeights), islandOwn, 1, islandCapacities, islandModifiers)

    return latest !== null && latest <= 9 + TOLERANCE
  }
  const islandPlan = calc.planComponents(islandInput)
  const islandFree = Math.floor(islandPlan.available * 100 + 1e-6)
  const islandLeast = Array.from({ length: islandFree - 3 }, (_, index) => index + 4).find(islandMeets)
  const narrowPlan = narrow['component-calc'].planComponents(islandInput)
  const narrowStall = narrow['component-calc'].planComponents(input({ colony: colony({ minerals: { ...stockOfMinerals(1e6), Corbomite: 0 } }) }))

  holds('islandScan', 'SYNTHETIC with a paused project holding 97.67% and a queued project that would take the colony\'s only tonne of Duranium, a four-component batch due in 9 days meets the deadline at 1.75% in the engine\'s own run and at no smaller share, and misses it at the sparse probes of a search (2.33% is free): the plan is feasible, contested, and the share found is exactly the least (a range this narrow is scanned a hundredth at a time), with nothing released and no shortfall', islandLeast !== undefined && islandPlan.contested === true && islandPlan.status === 'feasible' && islandPlan.requiredKind === 'exact' && islandPlan.requiredExact === true && Math.round(islandPlan.required * 100) === islandLeast && islandPlan.release.length === 0 && islandPlan.shortfall === null)
  holds('searchLimited', 'SYNTHETIC with the range of shares too wide to scan (a scan limit of one hundredth) the same batch, which a share within the 2.33% free finishes in time, is never called infeasible and never given a shortfall or a claim that the colony cannot do it: its status is search-limited, a found share above the free one is kept as a candidate that is not exact, and the colony\'s tonne of Duranium is still contested', islandLeast !== undefined && narrowPlan.status === 'searchLimited' && narrowPlan.shortfall === null && narrowPlan.requiredExact === false && narrowPlan.requiredKind !== 'exact' && narrowPlan.contested === true && narrowPlan.allocation.length > 0 && narrowPlan.why.length === 1)
  holds('searchProof', 'SYNTHETIC a batch that needs more of a mineral than the colony holds, with none arriving (a colony with no Corbomite for the engines), is infeasible whatever the range of shares and the scan limit, because it is proved and not searched: with a scan limit of one hundredth it is still infeasible, unreachable, names Corbomite as the holdup and has no shortfall', narrowStall.status === 'infeasible' && narrowStall.unreachable === true && narrowStall.required === null && narrowStall.shortfall === null && narrowStall.stalled !== null && narrowStall.stalled.name === 'Corbomite')

  const said = (plan, parts, hulls, deadline) => verdict(plan, calc.requirements({ parts, hulls, stock: {} }), deadline).verdict.map((line) => line.text).join(' ')
  const limitedSaid = said(narrowPlan, islandParts, 1, 9)
  const provenSaid = said(cycleShort, [fiftyPart], 1, 1.5)

  holds('searchLimitedVerdict', 'SYNTHETIC the calculator\'s verdict on a search-limited plan says that the matter is not settled and names the 2.33% free, says no share was tried that finished the batch, never says the colony cannot do it and gives no shortfall in percentage points, while the verdict on a plan whose infeasibility is established (a 50 BP component due in 1.5 days with 60% held) still says the colony cannot do it and gives the shortfall', narrowPlan.status === 'searchLimited' && /Not settled/.test(limitedSaid) && /2\.33%/.test(limitedSaid) && /no share tried/.test(limitedSaid) && !/cannot/.test(limitedSaid) && !/short by/.test(limitedSaid) && /cannot do it/.test(provenSaid) && /short by 10 percentage points/.test(provenSaid))

  const nprOwn = [projectRow({ ID: 1, Name: 'Paused construction', Percentage: 100, Paused: 1, Amount: 100, ProdPerUnit: 10, StockDuranium: 0 })]
  const nprPart = part(101, 'Component', 1, 1, 10, { Duranium: 10 })
  const nprInput = (npr) => ({ parts: [nprPart], hulls: 1, stock: {}, deadline: 30, colony: colony({ npr, projects: nprOwn, minerals: { ...stockOfMinerals(1e6), Duranium: 0 } }) })
  const nprPlan = calc.planComponents(nprInput(true))
  const ownPlan = calc.planComponents(nprInput(false))

  holds('nprProof', 'SYNTHETIC a spied empire\'s colony (the forecast reads the capital\'s stock, which the save does not give) with a 10 BP component that needs 10 t of Duranium, none in the colony\'s stock, none arriving and all its capacity held by a paused project is unknown, naming the capital\'s stock, never unreachable or infeasible: the shortage of the colony\'s own stock is not a proof where the forecast does not run on it; the same colony as the race\'s own is proved infeasible and unreachable', nprPlan.status === 'unknown' && nprPlan.gaps.some((gap) => /capital/.test(gap)) && nprPlan.unreachable === false && nprPlan.required === null && ownPlan.status === 'infeasible' && ownPlan.unreachable === true && ownPlan.settled === true && ownPlan.gaps.length === 0)

  const viewOf = (plan, parts, hulls, deadline) => verdict(plan, calc.requirements({ parts, hulls, stock: {} }), deadline)
  const exactPlan = islandPlan
  const foundPlan = calc.planComponents({ ...islandInput, colony: { ...islandInput.colony, projects: [{ ...islandOwn[0], Percentage: 93.99 }, islandOwn[1]] } })
  const bareLimited = { ...narrowPlan, required: null, requiredKind: null, release: [], unreachable: true }
  const copyOf = (plan, parts, hulls, deadline) => {
    const view = viewOf(plan, parts, hulls, deadline)

    return { text: view.verdict.map((line) => line.text).join(' '), value: view.tiles[1].value, note: view.tiles[1].note }
  }
  const exactCopy = copyOf(exactPlan, islandParts, 1, 9)
  const foundCopy = copyOf(foundPlan, islandParts, 1, 9)
  const bareCopy = copyOf(bareLimited, islandParts, 1, 9)
  const provenCopy = copyOf(narrowStall, CLASS_PARTS, HULLS, DEADLINE)

  holds('confidenceCopy', 'SYNTHETIC the calculator\'s words follow how sure the share is: an exact contested share (the island, 1.75%, every share tried) has no "at most" mark and no "a smaller share may do it", a found one (the same batch with 6% free, a sample of the shares) has the mark and says a smaller one may exist, a search-limited plan with no candidate is "not settled" in both the verdict and the tile and never says that no share does it or that the colony cannot, and a batch proved impossible says the colony cannot do it at any share and that it is not reachable', exactPlan.requiredKind === 'exact' && exactPlan.contested === true && !/may do it/.test(exactCopy.text) && !/^≤/.test(exactCopy.value) && foundPlan.status === 'feasible' && foundPlan.requiredKind === 'found' && /a smaller share than this may do it/.test(foundCopy.text) && /^≤/.test(foundCopy.value) && /Found by search/.test(foundCopy.note) && /Not settled/.test(bareCopy.text) && !/cannot/.test(bareCopy.text) && bareCopy.value === '—' && /Not settled/.test(bareCopy.note) && narrowStall.settled === true && /cannot do it at any share/.test(provenCopy.text) && /Not reachable at any share/.test(provenCopy.note) && !/Not settled/.test(provenCopy.text + provenCopy.note))

  const unreached = { ...cycleShort, required: null, requiredKind: null, shortfall: null, stalled: null, unreachable: true, why: ['no share finishes the batch by the deadline'] }
  const triedCopy = copyOf({ ...unreached, settled: false }, [fiftyPart], 1, 1.5)
  const provedCopy = copyOf({ ...unreached, settled: true }, [fiftyPart], 1, 1.5)

  holds('unsettledCopy', 'SYNTHETIC an infeasible plan with no share that does it and no mineral short, whose search was not complete, says that no share tried does it and that a share between those tried may, never that the colony cannot do it at any share, and the same plan settled says that it cannot', /No share tried does it/.test(triedCopy.text) && /a share between those tried may/.test(triedCopy.text) && !/cannot do it at any share/.test(triedCopy.text) && /The colony cannot do it at any share/.test(provedCopy.text) && !/No share tried does it/.test(provedCopy.text))

  const reviewPart = part(101, 'Component', 1, 1, 10, { Duranium: 10 })
  const heldRow = (extra) => projectRow({ ID: 1, Name: 'Project 1', Percentage: 100, Amount: 4, ProdPerUnit: 2, Paused: 1, ...extra })
  const gapPlan = (duranium, extra) => calc.planComponents({ parts: [reviewPart], hulls: 1, stock: {}, deadline: 2, colony: colony({ projects: [heldRow({ StockDuranium: duranium })], minerals: { ...stockOfMinerals(1e6), Duranium: duranium }, ...extra }) })
  const gapCases = [
    ['a spied empire\'s colony with all its capacity held by a paused project and a day-1 Duranium arrival', gapPlan(0, { npr: true, arrivals: [{ resource: 'Duranium', day: 1, quantity: 10, source: 'check' }] }), /capital/],
    ['a spied empire\'s colony with all its capacity held and ample Duranium', gapPlan(100, { npr: true }), /capital/],
    ['a colony of the race with all its capacity held, ample Duranium and no construction period in its modifiers', gapPlan(100, { modifiers: { ...MODIFIERS, MinConstructionPeriod: null } }), /construction period/],
  ]
  const gapSaid = gapCases.map(([, plan]) => said(plan, [reviewPart], 1, 2))

  holds('gapsUnknown', 'SYNTHETIC a gap the search above the free share meets (a spied empire\'s colony with all its capacity held, with a Duranium arrival, or with ample Duranium, which the proof does not apply to; a colony of the race with no construction period in its modifiers) makes the plan unknown and not settled, with no share, no finish and no allocation, never infeasible or unreachable, and the calculator\'s verdict names the gap and does not say the colony cannot do it', gapCases.every(([, plan, gap]) => plan.status === 'unknown' && plan.settled === false && plan.unreachable === false && plan.required === null && plan.finish === null && plan.allocation.length === 0 && plan.gaps.some((text) => gap.test(text))) && gapSaid.every((text, index) => /^Not known: missing/.test(text) && gapCases[index][2].test(text) && !/cannot/.test(text)))

  const beyondPart = part(101, 'Component', 1, 1, 100, { Duranium: 1 })
  const rival = (duranium) => projectRow({ ID: 2, Name: 'Mineral competitor', Percentage: 1, Amount: 4, ProdPerUnit: 1, Duranium: 1, StockDuranium: duranium })
  const sweepPlan = (held, duranium) => calc.planComponents({ parts: [beyondPart], hulls: 1, stock: {}, deadline: 2, colony: colony({ projects: [heldRow({ Percentage: held, StockDuranium: duranium }), rival(duranium)], arrivals: [{ resource: 'Duranium', day: 3, quantity: 100, source: 'check' }], minerals: { ...stockOfMinerals(1e6), Duranium: duranium } }) })
  const sweptLimited = sweepPlan(44, 1)
  const sweptBeyond = sweepPlan(99, 0)
  const sweptFound = sweepPlan(45.01, 1)
  const meaning = [
    ['feasible at the least share, bisected or scanned', exactPlan, true],
    ['feasible at a share found by a sample', foundPlan, false],
    ['search-limited within the free share', narrowPlan, false],
    ['search-limited on a wide range with an arrival', sweptLimited, false],
    ['infeasible with nothing above the free share found by a sample', sweptBeyond, false],
    ['infeasible with a share above the free one found by a sample', sweptFound, false],
    ['infeasible and proved by a shortage of a mineral', narrowStall, true],
    ['infeasible for the race\'s own colony, proved by the same shortage', ownPlan, true],
    ['unknown for a spied empire\'s colony', nprPlan, false],
    ...gapCases.map(([name, plan]) => [`unknown for ${name}`, plan, false]),
  ]

  holds('settledMeaning', 'SYNTHETIC `settled` is true only where the share search up to the whole capacity was complete or the batch is proved impossible, and false for a share found by a sample, a search-limited plan, an infeasible plan whose search above the share free was a sample (found or not) and every unknown plan', meaning.every(([, plan, settled]) => plan.settled === settled) && meaning.every(([, plan]) => (plan.requiredKind === 'found' || plan.status === 'searchLimited' || plan.status === 'unknown' ? plan.settled === false : true)) && sweptLimited.status === 'searchLimited' && sweptBeyond.status === 'infeasible' && sweptFound.status === 'infeasible' && sweptFound.requiredKind === 'found')

  return results
}

const COLONY_COUNT = 3
const CLASS_COUNT = 2

// What the saves hold, through the page's own read and against counts of the rows.
const saveCases = async (database, save, vm, apps) => {
  const calc = apps['component-calc']
  const name = database.file

  await vm.runAsync('populationProductionModifiers')
  await vm.runAsync('industry')

  const sources = await vm.runAsync('componentSources')
  const [{ rows: partRows }] = await rowsOf(database, `select count(*) as rows from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID where FCT_ClassComponent.GameID = ${save.game} and FCT_ShipClass.GameID = ${save.game} and FCT_ShipClass.RaceID = ${save.race}`)
  const [{ rows: stockRows, total: stockTotal }] = await rowsOf(database, `select count(*) as rows, coalesce(sum(FCT_PopComponent.Amount), 0) as total from FCT_PopComponent inner join FCT_Population on FCT_Population.PopulationID = FCT_PopComponent.PopulationID where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race}`)
  const [{ rows: unresearchedRows }] = await rowsOf(database, `select count(*) as rows from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID where FCT_ClassComponent.GameID = ${save.game} and FCT_ShipClass.GameID = ${save.game} and FCT_ShipClass.RaceID = ${save.race} and not exists (select 1 from FCT_RaceTech where FCT_RaceTech.TechID = FCT_ClassComponent.ComponentID and FCT_RaceTech.RaceID = ${save.race} and FCT_RaceTech.GameID = ${save.game})`)
  const all = Object.values(sources.parts).flat()
  const held = Object.values(sources.stock).flatMap((colony) => Object.values(colony))

  check(`${name}: the page's read of the components gives a row for each component of each class of the race (${partRows} in the save)`, partRows > 0 && all.length === partRows && Object.keys(sources.parts).every((id) => sources.classes.some((entry) => String(entry.id) === id)))
  check(`${name}: the component stock read is every row of the colonies' stock (${stockRows} rows, ${stockTotal} units)`, held.length === stockRows && Math.abs(held.reduce((a, b) => a + b, 0) - stockTotal) < 1e-6)
  check(`${name}: the components with no research row of the race are the ones read as not researched (${unresearchedRows} of ${partRows})`, all.filter((entry) => entry.researched === 0).length === unresearchedRows)
  check(`${name}: every component read has a cost and a mineral figure for each of the 11 minerals`, all.every((entry) => typeof entry.cost === 'number' && MINERAL_NAMES.every((mineral) => typeof entry.minerals[mineral] === 'number')))
  check(`${name}: a colony's mineral stock is read for every colony of the race`, Object.keys(sources.minerals).length > 0 && Object.values(sources.minerals).every((minerals) => MINERAL_NAMES.every((mineral) => typeof minerals[mineral] === 'number')))

  const modifiers = vm.populationProductionModifiers
  const capacitiesOf = (id) => Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, vm.populationCapacityResult(id, kind)]))
  const colonies = Object.keys(modifiers).map(Number).map((id) => ({ id, capacities: capacitiesOf(id) })).filter((entry) => entry.capacities.construction.status !== 'unavailable' && entry.capacities.construction.value > 0).sort((a, b) => b.capacities.construction.value - a.capacities.construction.value).slice(0, COLONY_COUNT)
  const classes = sources.classes.filter((entry) => (sources.parts[entry.id] || []).some((entry) => calc.buildableOf(entry).buildable === true)).slice(0, CLASS_COUNT)

  if (!colonies.length || !classes.length) {
    unsupportedNote(`${name}: the calculation on the colonies with construction capacity`, 'no colony with a known construction capacity or no class with a component to build')
    return
  }

  const seen = { feasible: 0, infeasible: 0, searchLimited: 0, covered: 0, unknown: 0, free: 0, none: 0 }
  const problems = []

  seen.checked = 0
  seen.released = 0
  seen.found = 0
  seen.calculations = 0
  seen.ms = 0
  seen.slowest = 0

  for (const colony of colonies) {
    const projects = vm.industry.filter((project) => project.PopulationID === colony.id)

    for (const shipClass of classes) {
      for (const [hulls, deadline] of [[1, 365], [20, 365]]) {
        const input = { parts: sources.parts[shipClass.id], hulls, stock: sources.stock[colony.id] || {}, deadline, colony: { populationId: colony.id, projects, capacities: colony.capacities, modifiers: modifiers[colony.id], arrivals: [], npr: false, minerals: sources.minerals[colony.id] } }
        const started = performance.now()
        const plan = calc.planComponents(input)
        const took = performance.now() - started

        seen.calculations++
        seen.ms += took
        seen.slowest = Math.max(seen.slowest, took)
        const label = `colony ${colony.id}, ${shipClass.name}, ${hulls} hull${hulls === 1 ? '' : 's'}, ${deadline} days`
        const total = plan.allocation.reduce((sum, entry) => sum + entry.share, 0)

        seen[plan.status]++

        if (plan.available === 0) {
          seen.none++
        } else if (plan.available > 0) {
          seen.free++
        }

        if (plan.status === 'unknown') {
          problems.push(`${label}: unknown (${plan.gaps.join('; ')})`)
        } else if (plan.allocation.length && total > plan.available + 1e-6) {
          problems.push(`${label}: allocates ${total}% of ${plan.available}% free`)
        } else if (plan.status === 'feasible' && (plan.required < plan.floorShare - TOLERANCE || Math.abs(total - plan.required) > 1e-6)) {
          problems.push(`${label}: share ${plan.required}% against the floor ${plan.floorShare}% and the projects' ${total}%`)
        } else if (plan.status === 'infeasible' && plan.required !== null && (plan.shortfall === null || Math.abs(plan.shortfall.share - (plan.required - plan.available)) > 1e-6)) {
          problems.push(`${label}: shortfall ${plan.shortfall && plan.shortfall.share} points against ${plan.required}% needed and ${plan.available}% free`)
        } else if (plan.status === 'infeasible' && plan.required === null && (plan.shortfall !== null || !plan.unreachable)) {
          problems.push(`${label}: no share needed but a shortfall of ${JSON.stringify(plan.shortfall)}`)
        } else if (plan.status === 'feasible' || (plan.status === 'infeasible' && plan.required !== null && plan.requiredKind !== 'floor' && plan.release.length)) {
          const rows = plan.requirements.rows.filter((row) => row.units > 0)
          const released = Object.fromEntries(plan.release.map((entry) => [entry.id, entry.to]))
          const own = projects.map((project) => (project.ID in released ? { ...project, Percentage: released[project.ID] } : project))
          const batch = plan.status === 'feasible' ? plan.allocation.map((entry) => Math.round(entry.share * 100)) : calc.allocateShare(Math.round(plan.required * 100), rows.map((row) => row.bp))
          const forecast = (hundredths) => {
            const parts = rows.map((row, index) => ({ ID: calc.BATCH_ID_BASE + index, Name: row.name, ProductionType: 3, PopulationID: colony.id, Percentage: hundredths[index] / 100, Amount: row.units, PartialCompletion: 0, ProdPerUnit: row.cost, Queue: 0, Paused: 0, FuelRequired: 0, StockFuel: 0, ConversionFrom: null, ConversionSource: null, ...Object.fromEntries(MINERAL_NAMES.flatMap((mineral) => [[mineral, row.minerals[mineral]], [`Stock${mineral}`, sources.minerals[colony.id][mineral]]])) }))
            const run = apps.production.industryForecast({ projects: [...own, ...parts], capacities: colony.capacities, modifiers: modifiers[colony.id], arrivals: [], npr: false })
            const figures = run.figures.filter((figure) => figure.forecast.ID >= calc.BATCH_ID_BASE).map((figure) => figure.forecast.latest)

            return figures.includes(null) ? null : Math.max(...figures)
          }
          const finishes = forecast(batch)
          const lessTotal = batch.reduce((a, b) => a + b, 0) - 1
          const lessParts = calc.allocateShare(lessTotal, rows.map((row) => row.bp))
          const less = lessParts ? forecast(lessParts) : null

          seen.checked++

          if (plan.status === 'infeasible') {
            seen.released++
          }

          if (plan.requiredKind === 'found') {
            seen.found++
          }

          if (finishes === null || finishes > deadline + TOLERANCE) {
            problems.push(`${label}: the engine's run at ${plan.required}% finishes ${finishes}, after ${deadline} days`)
          } else if (calc.heldShare(own).held + batch.reduce((a, b) => a + b, 0) / 100 > 100 + 1e-6) {
            problems.push(`${label}: the release leaves ${calc.heldShare(own).held}% held and the batch takes ${plan.required}%, over the whole capacity`)
          } else if (plan.status === 'feasible' && plan.requiredExact && less !== null && less <= deadline + TOLERANCE) {
            problems.push(`${label}: ${plan.required}% is not the least, one hundredth less finishes by ${less} days`)
          }
        }
      }
    }
  }

  check(`${name}: on the ${colonies.length} colonies of most construction capacity and ${classes.length} classes, no calculation is left unknown, none allocates more than the share free, each feasible one holds a share that is the floor or more, adds up over its projects, finishes in the engine's own run and, where the colony's minerals are not contested, is the least the engine accepts; each infeasible one's shortfall is the share needed less the share free (none where the batch is unreachable); and where the share needed is above the share free by a release, the engine's own run with that release made finishes by the deadline within the whole capacity`, problems.length === 0, problems.length ? problems.slice(0, 3).join(' | ') : `${seen.feasible} feasible, ${seen.infeasible} infeasible, ${seen.covered} covered; ${seen.checked} run in the engine, ${seen.released} with a release, ${seen.found} found by search; ${seen.calculations} calculations took ${Math.round(seen.ms / seen.calculations)} ms on average and ${Math.round(seen.slowest)} ms at most`)

  if (seen.free === 0) {
    unsupportedNote(`${name}: a feasible or free-share case`, 'every colony of most capacity is fully held by its projects')
  }

  if (seen.none === 0) {
    unsupportedNote(`${name}: a colony with no share free`, 'every colony of most capacity has a share free')
  } else {
    check(`${name}: a colony whose projects hold the whole capacity has no share free: the batch is infeasible, nothing is allocated, and the share needed is the whole of the shortfall or, where the batch cannot be done at any share, there is none and no shortfall`, (() => {
      const full = colonies.map((colony) => ({ colony, held: calc.heldShare(vm.industry.filter((project) => project.PopulationID === colony.id)).held })).find((entry) => entry.held >= 100)
      const colony = full.colony
      const shipClass = classes[0]
      const plan = calc.planComponents({ parts: sources.parts[shipClass.id], hulls: 1, stock: {}, deadline: 365, colony: { populationId: colony.id, projects: vm.industry.filter((project) => project.PopulationID === colony.id), capacities: colony.capacities, modifiers: modifiers[colony.id], arrivals: [], npr: false, minerals: sources.minerals[colony.id] } })

      return plan.status === 'infeasible' && plan.available === 0 && plan.allocation.length === 0 && ((plan.required !== null && plan.shortfall !== null && plan.shortfall.share > 0 && Math.abs(plan.shortfall.share - plan.required) < 1e-6) || (plan.unreachable && plan.shortfall === null))
    })())
  }
}

const NARROW_SCAN = ['const SCAN_LIMIT = 400', 'const SCAN_LIMIT = 1']

const MUTANTS = [
  { name: 'a calculation that takes the stock of a component against every hull (the stock times the hulls)', from: 'const held = stockOf(stock, part.componentId)', to: 'const held = stockOf(stock, part.componentId) * hulls', fails: 'stockOnce' },
  { name: 'a calculation that uses the whole stock, past what the hulls need', from: 'const used = needed === null || held === null ? null : Math.min(held, needed)', to: 'const used = needed === null || held === null ? null : held', fails: 'stockCapped' },
  { name: 'a calculation that rounds the units to build down', from: 'Math.ceil(remaining - EPSILON)', to: 'Math.floor(remaining - EPSILON)', fails: 'wholeUnits' },
  { name: 'a calculation that builds armour with a project', from: 'const BUILT_WITH_THE_HULL = new Set([COMPONENT_ARMOUR, COMPONENT_MISSILE_ENGINE])', to: 'const BUILT_WITH_THE_HULL = new Set([COMPONENT_MISSILE_ENGINE])', fails: 'buildable' },
  { name: 'a calculation that builds a component the race has not researched', from: 'if (part.researched === 0) {', to: 'if (false) {', fails: 'buildable' },
  { name: 'a held share that leaves out the paused projects', from: '} else if (project.Queue === 0) {', to: '} else if (project.Queue === 0 && !project.Paused) {', fails: 'heldPaused' },
  { name: 'a held share that counts a queued project', from: '} else if (project.Queue === 0) {', to: '} else {', fails: 'heldQueue' },
  { name: 'a held share that counts only the construction projects of type 0 (component and station projects held nothing)', from: '} else if (category === \'construction\') {', to: '} else if (category === \'construction\' && project.ProductionType === 0) {', fails: 'heldCategory' },
  { name: 'a held share that counts the ordnance projects with construction', from: '} else if (category === \'construction\') {', to: '} else if (category !== \'unknown\') {', fails: 'heldCategory' },
  { name: 'a split of the share that gives each project the same part', from: 'const weights = rows.map((row) => row.bp)', to: 'const weights = rows.map(() => 1)', fails: 'minimal' },
  { name: 'a split of the share that gives a project no minimum', from: 'const parts = weights.map(() => 1)', to: 'const parts = weights.map(() => 0)', fails: 'allocate' },
  { name: 'a floor on half the capacity', from: 'rows.reduce((all, row) => all + floorOf(row, capacity.value, cycles, cycleDays), 0)', to: 'rows.reduce((all, row) => all + floorOf(row, capacity.value / 2, cycles, cycleDays), 0)', fails: 'floorShare' },
  { name: 'a calculation that lets the ceiling of the search pass the share free', from: 'const ceiling = Math.floor(result.available * SHARE_STEP + EPSILON)', to: 'const ceiling = Math.floor(Math.max(result.available, 100) * SHARE_STEP + EPSILON)', fails: 'commitmentsInfeasible' },
  { name: 'a calculation that reports an infeasible deadline beyond the whole capacity as exact', from: 'result.requiredKind = \'floor\'', to: 'result.requiredKind = \'floor\'\n    result.requiredExact = true', fails: 'infeasible' },
  { name: 'a calculation that gives the shortfall without the share free taken off', from: 'const lacking = result.required - result.available', to: 'const lacking = result.required', fails: 'infeasible' },
  { name: 'a search that overshoots the least share', from: 'low = middle + 1', to: 'low = middle + 2', fails: 'contendedLeast' },
  { name: 'a calculation that counts a batch as in time on the best order of the colony\'s projects', from: 'meets: everyLatest && last(\'latest\') <= deadline + EPSILON', to: 'meets: everyEarliest && last(\'earliest\') <= deadline + EPSILON', fails: 'contended' },
  { name: 'a calculation that does not say which colony project the batch moves', from: 'result.displaced = base.gaps ? [] : displacedBy(colony, base, chosen.run)', to: 'result.displaced = []', fails: 'displaced' },
  { name: 'a calculation that loses the mineral a batch is held up by', from: 'result.stalled = stalled || null', to: 'result.stalled = null', fails: 'stallDistinct' },
  { name: 'a calculation that gives a share where the construction capacity is not known', from: 'if (!isAvailable(capacity) || !isNumber(capacity.value)) {', to: 'if (false) {', fails: 'capacityUnknown' },
  { name: 'a floor that leaves out the rounding of a build to 4 decimals (the plain division as a bound)', from: 'const perCycle = row.units / cycles - BUILD_ROUNDING', to: 'const perCycle = row.units / cycles', fails: 'roundingFloor' },
  { name: 'a split that gives fewer hundredths than there are projects instead of refusing', from: 'if (total < weights.length) {', to: 'if (total < 1) {', fails: 'allocate' },
  { name: 'a share needed that is not looked for above the share free', from: 'const beyond = yield * first(Math.max(lower, ceiling + 1), WHOLE_CAPACITY)', to: 'const beyond = { found: null, gaps: null }', fails: 'cycleRequired' },
  { name: 'a shortfall of a share the colony could never give', from: 'if (result.required !== null) {', to: 'if (true) {', fails: 'unreachable' },
  { name: 'an earliest finish given as exact where the projects differ', from: 'earliestExact: everyEarliest && figures.every((figure) => figure.earliest === figure.latest),', to: 'earliestExact: everyEarliest,', fails: 'orderBound' },
  { name: 'a stock row with no amount read as none held (in the plan)', from: 'return isNumber(stock[componentId]) ? Math.max(0, stock[componentId]) : null', to: 'return isNumber(stock[componentId]) ? Math.max(0, stock[componentId]) : 0', fails: 'stockNull' },
  { name: 'a stock row with no amount read as none held (in the read)', from: '= isNumber(row.Amount) ? row.Amount : null', to: '= isNumber(row.Amount) ? row.Amount : 0', fails: 'stockNull' },
  { name: 'a calculation that treats the minerals shared with the colony\'s other projects as never short', from: 'result.contested = !uncontested(colony, rows)', to: 'result.contested = false', fails: 'nonMonotone' },
  { name: 'a split of the shares whose order of seats depends on the total (a split that is not inside the split of a larger total)', from: 'if (shares[index] * (2 * parts[best] - 1) > shares[best] * (2 * parts[index] - 1)) {', to: 'if (shares[index] * (2 * parts[best] - 1) > shares[best] * (2 * parts[index] - 1) * (1 + (total % 5) / 10)) {', fails: 'apportion' },
  { name: 'a calculation that runs the batch against the colony as it is when a share above the free one is wanted (nothing released)', from: 'const state = legal.released.length ? { ...colony, projects: legal.projects } : colony', to: 'const state = colony', fails: 'releaseLegal' },
  { name: 'a release that takes the newest project of the others before the paused ones', from: 'Number(b.Paused === 1) - Number(a.Paused === 1) || b.ID - a.ID', to: 'b.ID - a.ID', fails: 'redistribute' },
  { name: 'a release that takes the oldest project first', from: 'Number(b.Paused === 1) - Number(a.Paused === 1) || b.ID - a.ID', to: 'Number(b.Paused === 1) - Number(a.Paused === 1) || a.ID - b.ID', fails: 'redistribute' },
  { name: 'a release that takes more of a project than it holds', from: 'const taken = Math.min(left, held)', to: 'const taken = left', fails: 'redistribute' },
  { name: 'a component whose stock is not known read as none to build (units 0)', from: 'const units = buildability.buildable === true ? (remaining === null ? null :', to: 'const units = buildability.buildable === true ? (remaining === null ? 0 :', fails: 'unknownUnits' },
  { name: 'a demand bound that leaves out the rounding of a build to 4 decimals (the nominal units times the need)', from: 'all + (units + BUILD_ROUNDING) * each, 0) <= stockOfRow(name)', to: 'all + units * each, 0) <= stockOfRow(name)', fails: 'roundedDemand' },
  { name: 'a search of the shares that does not scan a narrow range a hundredth at a time (the sparse sweep as the search)', from: 'const scanned = result.contested && to - from < SCAN_LIMIT', to: 'const scanned = false', fails: 'islandScan' },
  { name: 'a search that calls a share not found infeasible where the search was not complete', from: 'result.status = within.complete ? \'infeasible\' : \'searchLimited\'', to: 'result.status = \'infeasible\'', fails: 'searchLimited', narrow: true },
  { name: 'a sweep of the shares taken for a complete search', from: 'const complete = !result.contested || scanned', to: 'const complete = true', fails: 'searchLimited', narrow: true },
  { name: 'a batch that needs more of a mineral than the colony holds searched instead of proved impossible', from: '&& batchShort(colony, rows)', to: '&& false', fails: 'searchProof', narrow: true },
  { name: 'a verdict that gives a search-limited plan the words of one the colony cannot do', from: 'if (plan.status === \'searchLimited\') {', to: 'if (false) {', fails: 'searchLimitedVerdict', page: true },
  { name: 'an NPR colony (or any colony the forecast leaves gaps for) proved impossible from the colony\'s own stock, its gaps dropped', from: 'if (probed && probed.gaps) {', to: 'if (false) {', fails: 'nprProof' },
  { name: 'a calculator that says a smaller share may do it of an exact contested share too', from: 'if (plan.contested && plan.requiredKind === \'found\') {', to: 'if (plan.contested) {', fails: 'confidenceCopy', page: true },
  { name: 'a share tile that says not reachable at any share of a plan that is only not settled', from: '(plan.settled ? \'Not reachable', to: '(true ? \'Not reachable', fails: 'confidenceCopy', page: true },
  { name: 'a verdict that says the colony cannot do it at any share of a plan that is only not settled', from: 'text: plan.settled ? `The colony cannot do it', to: 'text: true ? `The colony cannot do it', fails: 'unsettledCopy', page: true },
  { name: 'a gap the search above the free share meets returned as an infeasible, settled plan', from: 'return { ...result, status: \'unknown\', settled: false, finish: null, allocation: [], gaps: beyond.gaps }', to: 'return { ...result, gaps: beyond.gaps }', fails: 'gapsUnknown' },
  { name: 'a plan whose search above the free share was a sample called settled', from: 'result.settled = result.settled && beyond.complete', to: 'result.settled = result.settled', fails: 'settledMeaning' },
  { name: 'a share found by a sample called settled', from: 'result.settled = result.requiredKind === \'exact\'', to: 'result.settled = true', fails: 'settledMeaning' },
  { name: 'a plan settled until a search says it is not (an unknown plan settled)', from: 'contested: false, settled: false, release', to: 'contested: false, settled: true, release', fails: 'settledMeaning' },
]

// ---------- the parts: the checks of the real sources, a share of the mutants and each save run in a process of their own ----------

// What every part works on: the utilities, the page's options and store, and the page's capacity results for the synthetic colony.
const sharedOf = async () => {
  const apps = await loadUtilities(UTILITIES, { stubs: STUBS })
  const pageOptions = await loadPage('pages/production', { stubs: STUBS })
  const store = { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} } }
  const synthetic = instantiate(pageOptions, { ...store, data: { populationProductionModifiers: { 7: MODIFIERS } } })
  const capacities = Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, synthetic.populationCapacityResult(7, kind)]))

  return { apps, pageOptions, store, capacities }
}

const checkHead = async ({ apps, capacities }) => {
  check('the synthetic colony\'s construction capacity is the 36,500 BP a year its rates give', capacities.construction.status !== 'unavailable' && Math.abs(capacities.construction.value - 36500) < 1e-6, String(capacities.construction.value))

  console.log('\n== the calculator: worked cases ==')

  const narrowApps = await mutatedUtilities(NARROW_SCAN[0], NARROW_SCAN[1])
  const verdict = verdictOf(await loadCalculator())

  syntheticCases(apps, capacities, narrowApps, verdict).forEach(([statement, held]) => check(statement, held))
}

const checkMutants = async ({ apps, capacities }, mutants) => {
  const narrowApps = await mutatedUtilities(NARROW_SCAN[0], NARROW_SCAN[1])
  const verdict = verdictOf(await loadCalculator())
  const results = syntheticCases(apps, capacities, narrowApps, verdict)

  for (const mutant of mutants) {
    const mutated = mutant.page ? syntheticCases(apps, capacities, narrowApps, verdictOf(await loadCalculator(replacing(mutant.from, mutant.to)))) : syntheticCases(await mutatedUtilities(mutant.from, mutant.to), capacities, mutant.narrow ? await mutatedUtilities([mutant.from, NARROW_SCAN[0]], [mutant.to, NARROW_SCAN[1]]) : narrowApps, verdict)
    const named = results.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${[...new Set(broken)].join(', ')}`)
  }
}

const checkSave = async ({ apps, pageOptions, store }, save) => {
  const database = await openSave(save.file)

  if (!database) {
    console.log(`SKIP  ${save.file}: not there (not run)`)

    return
  }

  try {
    console.log(`\n== ${database.file} ==`)
    await saveCases(database, save, instantiate(pageOptions, { ...store, database, GameID: save.game, RaceID: save.race }), apps)
  } finally {
    database.close()
  }
}

// The mutants in `count` contiguous shares of the list, so that the shares print in the order of the list.
const shareOf = (index, count) => MUTANTS.slice(Math.floor(index * MUTANTS.length / count), Math.floor((index + 1) * MUTANTS.length / count))

// One part, in this process: `head`, `mutants:<share>:<shares>` or `save:<index>`.
const runPart = async (part, saves) => {
  const [kind, first, second] = part.split(':')
  const shared = await sharedOf()

  if (part === 'head') {
    await checkHead(shared)
  } else if (kind === 'mutants') {
    await checkMutants(shared, shareOf(Number(first), Number(second)))
  } else if (kind === 'save') {
    await checkSave(shared, saves[Number(first)])
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

const main = async () => {
  const { saves, part } = parseArguments(process.argv.slice(2))

  if (part !== null) {
    await runPart(part, saves)
    endSection(checks, failures, { unsupported })
  }

  const shares = Math.min(MUTANTS.length, jobs() * 2)

  // In the order they print; the longest start first.
  const parts = [
    { part: 'head', weight: 10 },
    ...Array.from({ length: shares }, (_unused, index) => ({ part: `mutants:${index}:${shares}`, weight: 20 })),
    ...saves.map((_save, index) => ({ part: `save:${index}`, weight: 30 })),
  ]

  const forwarded = saves.flatMap((save) => ['--save', save.file, String(save.game), String(save.race)])
  const sections = await runSections(__filename, parts.map(({ part: name, weight }) => ({ args: ['--part', name, ...forwarded], weight })))

  for (const section of sections) {
    const counts = printSection(section)

    checks += counts.checks
    failures += counts.failures
    unsupported += counts.extra.unsupported
  }

  console.log(`\n${checks - failures}/${checks} checks passed; ${unsupported} unsupported (the save holds no case)`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
